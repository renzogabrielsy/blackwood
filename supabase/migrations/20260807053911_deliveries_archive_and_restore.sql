-- ============================================================================
-- deliveries_archive + one-call restore
-- ============================================================================
-- WHY THIS EXISTS
-- ---------------
-- `public.deliveries` has an AFTER INSERT/UPDATE/DELETE audit trigger
-- (`deliveries_audit_trigger` -> `log_delivery_changes`) that writes a full
-- `to_jsonb(OLD)` snapshot into `audit_logs` on DELETE, so a deleted delivery is
-- not *unrecoverable* today. But recovering it means a human hand-reconstructing
-- an INSERT from a JSONB blob buried in an audit table that is also read by the
-- audit UI, joined by `audit_comments` / `notification_subscriptions`, and paged
-- through by date. "Easy reverting" has to be ONE command, not an archaeology
-- exercise -- especially for a bulk duplicate cleanup, where the unit of revert
-- is "the whole operation", not "one row".
--
-- So: a purpose-built archive relation whose ROW IS THE RESTORE PAYLOAD, plus a
-- restore function that re-inserts the row exactly as it was -- including its
-- ORIGINAL `id` and `created_at`, so every downstream reference (audit_logs
-- rows, notification metadata, anything holding a delivery id) still resolves
-- after the revert.
--
-- Duplicate cleanup will recur (the sync's natural key is
-- (transaction_date, batch_code, block_loc, weight_kg) and `batch_code` is IN
-- that key, so two source spellings of one batch produce two rows). This is
-- built as a reusable primitive, not a one-off script.
--
-- DESIGN NOTES
-- ------------
-- * `row_snapshot` is `to_jsonb(deliveries.*)` and is THE authoritative restore
--   payload. Restoring via `jsonb_populate_record` means the archive keeps
--   working when `deliveries` gains a column, instead of silently dropping it.
-- * The denormalised context columns (`transaction_date`, `supplier`, ...) exist
--   only so a human can read/query the archive. They are written by
--   `fn_archive_delivery` from the live row and no client role can write them,
--   so they cannot drift from `row_snapshot`.
-- * `context` captures the state that the DELETE trigger does NOT recompute --
--   notably `batches.quality_stats`, which is maintained by an INSERT-only
--   incremental blend and is therefore NOT invertible by a delete or by a
--   restore. `current_weight` and `avg_cost` ARE recomputed from the base tables
--   by `fn_recompute_batch_state`, so those come back exactly on restore;
--   `quality_stats` does not, and `context` is the only record of what it was.
-- * `archive_batch_id` groups one logical operation, so a whole cleanup reverts
--   with a single call to `fn_restore_archive_batch`.
-- * There is deliberately NO foreign key from `deliveries_archive.delivery_id`
--   to `deliveries.id`: the whole point is that the referenced row is gone.
-- * Nothing is ever deleted from this table. It is an archive.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. The archive relation
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.deliveries_archive (
    archive_id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),

    -- groups every row archived by one logical operation
    archive_batch_id  uuid        NOT NULL,

    -- the ORIGINAL public.deliveries.id (intentionally NOT a foreign key)
    delivery_id       uuid        NOT NULL,

    -- to_jsonb(deliveries.*) -- the complete row, and the restore payload
    row_snapshot      jsonb       NOT NULL,

    -- surrounding state that a delete/restore cannot reconstruct
    context           jsonb,

    archive_reason    text        NOT NULL,
    archived_at       timestamptz NOT NULL DEFAULT now(),
    archived_by       uuid        REFERENCES public.profiles(id) ON DELETE SET NULL,

    restored_at       timestamptz,
    restored_by       uuid        REFERENCES public.profiles(id) ON DELETE SET NULL,

    -- readable copies of the row, for querying the archive by hand
    transaction_date  date        NOT NULL,
    supplier          text        NOT NULL,
    batch_code        text,
    block_loc         text,
    truck_plate       text,
    sacks             integer,
    weight_kg         numeric     NOT NULL,
    cost_basis        numeric,

    CONSTRAINT deliveries_archive_reason_not_blank
        CHECK (btrim(archive_reason) <> ''),
    CONSTRAINT deliveries_archive_snapshot_matches_id
        CHECK (row_snapshot ? 'id' AND (row_snapshot ->> 'id')::uuid = delivery_id)
);

COMMENT ON TABLE public.deliveries_archive IS
'Archive of rows removed from public.deliveries, so any removal is revertible with one call. row_snapshot is to_jsonb(deliveries.*) and IS the restore payload (original id + created_at included). Written only by fn_archive_delivery / fn_archive_and_delete_delivery; restored only by fn_restore_archived_delivery / fn_restore_archive_batch. Never deleted from. NOTE: cost_basis / row_snapshot->>''cost_basis'' carry PESO data -- any server action exposing this table is subject to canViewPrices().';

COMMENT ON COLUMN public.deliveries_archive.archive_batch_id IS
'Groups every row archived by one logical operation, so the whole operation reverts with fn_restore_archive_batch(archive_batch_id).';
COMMENT ON COLUMN public.deliveries_archive.row_snapshot IS
'to_jsonb(deliveries.*) at archive time. THE restore payload -- jsonb_populate_record rebuilds the row from it, so the archive survives new columns on deliveries.';
COMMENT ON COLUMN public.deliveries_archive.context IS
'State a delete/restore cannot reconstruct: the owning batches row (including quality_stats, which is maintained by an INSERT-only incremental blend and is NOT restored by re-inserting the delivery), the batch''s delivery/rc_out totals before the removal, and the id of the row''s latest audit_logs entry.';
COMMENT ON COLUMN public.deliveries_archive.restored_at IS
'Set when the row has been put back into public.deliveries. The archive row is kept either way -- an archive is not a queue.';

CREATE INDEX IF NOT EXISTS idx_deliveries_archive_delivery_id
    ON public.deliveries_archive (delivery_id);
CREATE INDEX IF NOT EXISTS idx_deliveries_archive_batch_id
    ON public.deliveries_archive (archive_batch_id);
CREATE INDEX IF NOT EXISTS idx_deliveries_archive_transaction_date
    ON public.deliveries_archive (transaction_date);
CREATE INDEX IF NOT EXISTS idx_deliveries_archive_batch_code
    ON public.deliveries_archive (batch_code);

-- RLS + grants (CLAUDE.md posture: anon has no data access; authenticated =
-- org member = read; writes are service-role / the functions below).
ALTER TABLE public.deliveries_archive ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS deliveries_archive_select_authenticated ON public.deliveries_archive;
CREATE POLICY deliveries_archive_select_authenticated
    ON public.deliveries_archive
    FOR SELECT
    TO authenticated
    USING (true);
-- No INSERT / UPDATE / DELETE policy: client roles cannot forge or erase an
-- archive row. The writer/restore functions are SECURITY DEFINER (owner
-- postgres) and bypass RLS.

REVOKE ALL ON TABLE public.deliveries_archive FROM anon;
GRANT SELECT ON TABLE public.deliveries_archive TO authenticated;
GRANT SELECT, INSERT, UPDATE ON TABLE public.deliveries_archive TO service_role;

-- ---------------------------------------------------------------------------
-- 2. fn_archive_delivery -- archive a live delivery row (no delete)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_archive_delivery(
    p_delivery_id      uuid,
    p_reason           text,
    p_archive_batch_id uuid DEFAULT gen_random_uuid()
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
    v_row        public.deliveries;
    v_ctx        jsonb;
    v_archive_id uuid;
BEGIN
    IF p_reason IS NULL OR btrim(p_reason) = '' THEN
        RAISE EXCEPTION 'fn_archive_delivery: a reason is required (an archive row with no reason cannot be judged later)';
    END IF;

    SELECT * INTO v_row FROM public.deliveries WHERE id = p_delivery_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'fn_archive_delivery: delivery % not found', p_delivery_id;
    END IF;

    v_ctx := jsonb_build_object(
        'batch', (SELECT to_jsonb(b.*) FROM public.batches b WHERE b.batch_code = v_row.batch_code),
        'batch_delivery_count_before',
            (SELECT count(*) FROM public.deliveries d WHERE d.batch_code = v_row.batch_code),
        'batch_delivery_kg_before',
            (SELECT COALESCE(sum(d.weight_kg), 0) FROM public.deliveries d WHERE d.batch_code = v_row.batch_code),
        'batch_rc_out_kg_before',
            (SELECT COALESCE(sum(r.weight_kg), 0)
               FROM public.rc_out r
               JOIN public.batches b ON b.id = r.batch_id
              WHERE b.batch_code = v_row.batch_code),
        'latest_audit_log_id',
            (SELECT a.id FROM public.audit_logs a
              WHERE a.table_name = 'deliveries' AND a.record_id = v_row.id
              ORDER BY a.performed_at DESC LIMIT 1)
    );

    INSERT INTO public.deliveries_archive (
        archive_batch_id, delivery_id, row_snapshot, context, archive_reason, archived_by,
        transaction_date, supplier, batch_code, block_loc, truck_plate, sacks, weight_kg, cost_basis
    ) VALUES (
        p_archive_batch_id, v_row.id, to_jsonb(v_row), v_ctx, btrim(p_reason), auth.uid(),
        v_row.transaction_date, v_row.supplier, v_row.batch_code, v_row.block_loc,
        v_row.truck_plate, v_row.sacks, v_row.weight_kg, v_row.cost_basis
    )
    RETURNING archive_id INTO v_archive_id;

    RETURN v_archive_id;
END;
$function$;

COMMENT ON FUNCTION public.fn_archive_delivery(uuid, text, uuid) IS
'Archives one live public.deliveries row into deliveries_archive (does NOT delete it). Returns the archive_id. Pass the same p_archive_batch_id for every row of one operation so the operation reverts as a unit.';

-- ---------------------------------------------------------------------------
-- 3. fn_archive_and_delete_delivery -- the safe removal primitive
-- ---------------------------------------------------------------------------
-- Use this instead of a bare DELETE, so it is structurally impossible to remove
-- a delivery without leaving a restorable copy behind.
CREATE OR REPLACE FUNCTION public.fn_archive_and_delete_delivery(
    p_delivery_id      uuid,
    p_reason           text,
    p_archive_batch_id uuid DEFAULT gen_random_uuid()
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
    v_archive_id uuid;
    v_deleted    int;
BEGIN
    v_archive_id := public.fn_archive_delivery(p_delivery_id, p_reason, p_archive_batch_id);

    DELETE FROM public.deliveries WHERE id = p_delivery_id;
    GET DIAGNOSTICS v_deleted = ROW_COUNT;

    IF v_deleted <> 1 THEN
        RAISE EXCEPTION 'fn_archive_and_delete_delivery: expected to delete 1 row for %, deleted %', p_delivery_id, v_deleted;
    END IF;

    RETURN v_archive_id;
END;
$function$;

COMMENT ON FUNCTION public.fn_archive_and_delete_delivery(uuid, text, uuid) IS
'Archives then deletes one delivery, in one call, in the caller transaction. Preferred over a bare DELETE on public.deliveries -- it cannot remove a row without leaving a restorable archive copy.';

-- ---------------------------------------------------------------------------
-- 4. fn_restore_archived_delivery -- put ONE row back, exactly as it was
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_restore_archived_delivery(p_archive_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
    a            public.deliveries_archive;
    v_restored   int;
BEGIN
    SELECT * INTO a FROM public.deliveries_archive WHERE archive_id = p_archive_id;
    IF NOT FOUND THEN
        RETURN jsonb_build_object('ok', false, 'outcome', 'archive_row_not_found', 'archive_id', p_archive_id);
    END IF;

    -- Already live (restored earlier, or the id was never actually deleted):
    -- report it and stamp the archive row, but never insert a second copy.
    IF EXISTS (SELECT 1 FROM public.deliveries d WHERE d.id = a.delivery_id) THEN
        UPDATE public.deliveries_archive
           SET restored_at = COALESCE(restored_at, now()),
               restored_by = COALESCE(restored_by, auth.uid())
         WHERE archive_id = p_archive_id;
        RETURN jsonb_build_object(
            'ok', true, 'outcome', 'already_present',
            'archive_id', p_archive_id, 'delivery_id', a.delivery_id,
            'batch_code', a.batch_code
        );
    END IF;

    -- The row comes back whole: original id, original created_at, original
    -- lab_results JSONB, every column. The AFTER triggers on deliveries then
    -- recompute batches.current_weight / avg_cost from the base tables.
    INSERT INTO public.deliveries
    SELECT * FROM jsonb_populate_record(NULL::public.deliveries, a.row_snapshot);
    GET DIAGNOSTICS v_restored = ROW_COUNT;

    IF v_restored <> 1 THEN
        RAISE EXCEPTION 'fn_restore_archived_delivery: expected to insert 1 row for archive %, inserted %', p_archive_id, v_restored;
    END IF;

    UPDATE public.deliveries_archive
       SET restored_at = now(),
           restored_by = auth.uid()
     WHERE archive_id = p_archive_id;

    RETURN jsonb_build_object(
        'ok', true, 'outcome', 'restored',
        'archive_id', p_archive_id, 'delivery_id', a.delivery_id,
        'batch_code', a.batch_code, 'transaction_date', a.transaction_date,
        'weight_kg', a.weight_kg
    );
END;
$function$;

COMMENT ON FUNCTION public.fn_restore_archived_delivery(uuid) IS
'Re-inserts one archived delivery exactly as it was, including its original id and created_at, so downstream references still resolve. Idempotent: a delivery id that is already live returns outcome=already_present and is never inserted twice. Note batches.quality_stats is NOT restored (INSERT-only incremental blend) -- its pre-removal value is in deliveries_archive.context->''batch''.';

-- ---------------------------------------------------------------------------
-- 5. fn_restore_archive_batch -- THE one-command revert for a whole operation
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_restore_archive_batch(p_archive_batch_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
    r          record;
    v_results  jsonb := '[]'::jsonb;
    v_one      jsonb;
    v_restored int := 0;
    v_present  int := 0;
BEGIN
    IF NOT EXISTS (SELECT 1 FROM public.deliveries_archive WHERE archive_batch_id = p_archive_batch_id) THEN
        RETURN jsonb_build_object('ok', false, 'outcome', 'archive_batch_not_found',
                                  'archive_batch_id', p_archive_batch_id);
    END IF;

    FOR r IN
        SELECT archive_id FROM public.deliveries_archive
         WHERE archive_batch_id = p_archive_batch_id
         ORDER BY archived_at, archive_id
    LOOP
        v_one := public.fn_restore_archived_delivery(r.archive_id);
        v_results := v_results || jsonb_build_array(v_one);
        IF v_one ->> 'outcome' = 'restored' THEN
            v_restored := v_restored + 1;
        ELSIF v_one ->> 'outcome' = 'already_present' THEN
            v_present := v_present + 1;
        END IF;
    END LOOP;

    RETURN jsonb_build_object(
        'ok', true,
        'archive_batch_id', p_archive_batch_id,
        'restored', v_restored,
        'already_present', v_present,
        'rows', v_results
    );
END;
$function$;

COMMENT ON FUNCTION public.fn_restore_archive_batch(uuid) IS
'Reverts a whole archived operation in one call: restores every deliveries_archive row sharing archive_batch_id. Idempotent -- rows already live come back as already_present. This is the command to run when a cleanup fails its after-the-fact check.';

-- ---------------------------------------------------------------------------
-- 6. Grants -- least privilege
-- ---------------------------------------------------------------------------
-- These functions bypass RLS (SECURITY DEFINER, owner postgres) and can
-- resurrect or remove operational rows, so they are NOT handed to `authenticated`.
-- There is no UI for them; they are run by the sync worker (service_role) or by
-- hand through SQL. If an in-app revert is ever built, wrap it in a role-gated
-- server action and grant EXECUTE then -- do not widen these grants blindly.
REVOKE EXECUTE ON FUNCTION public.fn_archive_delivery(uuid, text, uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.fn_archive_and_delete_delivery(uuid, text, uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.fn_restore_archived_delivery(uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.fn_restore_archive_batch(uuid) FROM PUBLIC;

REVOKE EXECUTE ON FUNCTION public.fn_archive_delivery(uuid, text, uuid) FROM anon;
REVOKE EXECUTE ON FUNCTION public.fn_archive_and_delete_delivery(uuid, text, uuid) FROM anon;
REVOKE EXECUTE ON FUNCTION public.fn_restore_archived_delivery(uuid) FROM anon;
REVOKE EXECUTE ON FUNCTION public.fn_restore_archive_batch(uuid) FROM anon;

GRANT EXECUTE ON FUNCTION public.fn_archive_delivery(uuid, text, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.fn_archive_and_delete_delivery(uuid, text, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.fn_restore_archived_delivery(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.fn_restore_archive_batch(uuid) TO service_role;
