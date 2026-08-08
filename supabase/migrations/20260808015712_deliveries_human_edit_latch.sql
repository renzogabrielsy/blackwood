-- DELIVERIES — the HUMAN-EDIT LATCH (2026-08-08)
--
-- A PORT of 20260803080000_production_human_edit_guard.sql onto `public.deliveries`.
-- Read that migration first; everything below either reuses it verbatim or documents
-- exactly why `deliveries` needs something the six production tables did not.
--
-- ===========================================================================
-- WHY — and a correction to the story usually told about it
-- ===========================================================================
-- The motivating incident is the 2026-02-04 Ornales truckload (delivery
-- a5169fad-767c-44f8-894b-8f9237f6c672). The Google Sheet had the FEB-26-BLK4 /
-- FEB-26-BLK5 truck assignment SWAPPED; Renzo corrected it in Blackwood and never
-- corrected the Sheet. On 2026-06-25 someone recorded that fact as an `audit_logs`
-- COMMENT reading, verbatim:
--
--     "DO NOT auto-revert to the Sheet value: any Sheet-vs-DB conflict on this row
--      must be FLAGGED for human review, never applied Sheet-wins."
--
-- A comment is not a control. It is prose in a table nothing reads at write time, and
-- the sync went on importing the Sheet's stale version on 2026-07-03 and again on
-- 2026-08-07 07:34.
--
-- BUT — the audit trail is explicit about the MECHANISM, and it is not the one this
-- migration guards. Row a5169fad has exactly ONE audit_logs row in its entire history:
-- the 2026-06-25 annotation itself. It was NEVER UPDATEd by the sync. What actually
-- happened is that gsheet-sync INSERTED a SECOND copy of the truckload under the stale
-- Sheet values (rows 679/680 of the RC IN tab) — twice, and both times the copies were
-- archived and deleted rather than the original being clobbered.
--
-- So the latch would NOT have prevented the Feb-4 incident. `lib/deliveryIdentity.ts`
-- (the two-tier identity, shipped 2026-08-08) is what prevents it, and it says so in its
-- own header: "A human-edit latch would NOT have stopped either: nothing was
-- overwritten, the sync INSERTED." The two changes are complementary and neither
-- substitutes for the other: identity stops a correction being DUPLICATED, the latch
-- stops a correction being OVERWRITTEN.
--
-- The latch's own case is made by a different, measured exposure. `deliveries` has TWO
-- unguarded sync UPDATE paths:
--
--     workers/sync/src/reports/deliveries/apply.ts:272   db.update("deliveries", …)
--     workers/sync/src/reports/gsheet/apply.ts:636       db.update("deliveries", …)  <- Sheet-wins
--
-- and unlike production's equivalent — which was DORMANT (its patch shape never
-- matched, so no production UPDATE has ever run) — this one is LIVE and has fired:
-- 40 `audit_logs` UPDATE rows on `deliveries` carry `provenance=gsheet`. FOUR of them
-- landed on a row Renzo had already edited by hand:
--
--     4c09f0e0  human 2026-02-12  ->  gsheet overwrote `remarks`    2026-05-30
--     5c7ffada  human 2026-02-18  ->  gsheet overwrote `block_loc`  2026-05-30
--     81e1d1a9  human 2026-02-18  ->  gsheet overwrote `block_loc`  2026-05-30
--     c6c197d4  human 2026-02-18  ->  gsheet overwrote `block_loc`  2026-05-30
--
-- Three of those four carry a comment saying Renzo adjudicated the change that day, so
-- no SILENT loss is provable in the trail. The exposure is therefore structural rather
-- than a proven theft: the path is live, unguarded, and there is nothing in the database
-- that would refuse it the next time nobody is watching.
--
-- ===========================================================================
-- THE FIVE RULES, PORTED
-- ===========================================================================
-- 1. A row a human edited in the app is never updated by the sync. Stamped by a BEFORE
--    INSERT OR UPDATE trigger whenever auth.uid() is non-null.
-- 2. The guard is `human_edited_at IS NULL` inside the UPDATE's own WHERE. No
--    read-then-write anywhere.
-- 3. The disagreement is SURFACED as a run finding naming the row and BOTH values, so it
--    re-fires every run until a human resolves it.
-- 4. `fn_release_delivery_rows` is the explicit way back; a row is never auto-released
--    because the Sheet later agrees.
-- 5. Inserts are unconstrained — the latch governs UPDATES only.
--
-- ===========================================================================
-- WHAT `deliveries` NEEDS THAT PRODUCTION DID NOT
-- ===========================================================================
-- The production tables carry NO audit trigger (deliberately — the sync writes its own
-- audit rows). `deliveries` carries FOUR triggers, and one of them reads every column:
--
--   deliveries_audit_trigger     AFTER INSERT/UPDATE/DELETE -> log_delivery_changes
--   tr_blackwood_delivery        AFTER INSERT/UPDATE/DELETE -> fn_update_blackwood_state
--   trg_notify_delivery_created  AFTER INSERT               -> fn_notify_delivery_created
--   trg_notify_remarks_added     AFTER UPDATE               -> fn_notify_remarks_added
--
-- Every one of them is AFTER, so a new BEFORE trigger fires ahead of all four and
-- perturbs no firing order (Postgres orders BEFORE ahead of AFTER unconditionally).
-- `fn_update_blackwood_state` recomputes from the BASE TABLES via
-- `fn_recompute_batch_state`, not from NEW, so a stamp cannot move `current_weight` or
-- `avg_cost` — BUG-017 was the opposite failure (a BEFORE trigger reading a table that
-- did not yet agree with the write) and nothing here reintroduces it.
--
-- `fn_notify_remarks_added` is guarded on `OLD.remarks IS DISTINCT FROM NEW.remarks`, so
-- a stamp cannot fire a spurious notification.
--
-- `log_delivery_changes` is the one real interaction, and it MUST be patched in this same
-- migration. It builds its diff by iterating EVERY key of `to_jsonb(NEW)` and writes an
-- `audit_logs` row only when the diff is non-empty. Because the stamp changes on every
-- authenticated write, an app UPDATE that changed nothing else would suddenly produce an
-- audit row reading `human_edited_at: {old, new}` — a fabricated "delivery edited" event
-- in the activity feed and `view_digest_audit_enriched`. Section 3 excludes the two stamp
-- columns from the DIFF (never from the SNAPSHOT), which restores the previous behaviour
-- exactly: an UPDATE that moved nothing else writes nothing at all. This is the same
-- decision already made for `cenapro.rc_delivery_audit`, whose `changed` excludes
-- `updated_at` and `row_version` for precisely this reason.
--
-- ===========================================================================
-- ONE PATH THAT DELIBERATELY DOES NOT LATCH
-- ===========================================================================
-- Every app write site on `deliveries` was checked. All of them run as `authenticated`
-- and all of them are genuine human corrections:
--   app/(app)/inventory/rc-in/actions.ts  submitBulkDeliveries (INSERT),
--                                         updateDelivery (UPDATE), the two deletes,
--                                         bulkUpdateDeliveries -> fn_bulk_update_deliveries
-- `fn_bulk_update_deliveries` is SECURITY INVOKER and names its columns explicitly, so it
-- neither touches nor can forge the stamp — the trigger stamps through it.
--
-- The two INGESTION paths that run inside the app use the SERVICE-ROLE client and
-- therefore never stamp, which is correct:
--   app/(app)/review-queue/actions.ts  insertDelivery / updateDelivery (createAdminClient)
--   lib/sync/apply-writers.ts          the Sync Review apply (AdminClient)
-- A Sync Review pick IS a human arbitration, but it is recorded in the case ledger and
-- writes the source's value on purpose; latching it would freeze the row against the very
-- source the operator just chose to follow. Left as-is, named here so the choice is not
-- mistaken for an oversight.

-- ===========================================================================
-- 1. Columns
-- ===========================================================================

ALTER TABLE public.deliveries
  ADD COLUMN IF NOT EXISTS human_edited_at timestamptz,
  ADD COLUMN IF NOT EXISTS human_edited_by uuid;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.deliveries'::regclass
       AND conname  = 'deliveries_human_edited_by_fkey'
  ) THEN
    ALTER TABLE public.deliveries
      ADD CONSTRAINT deliveries_human_edited_by_fkey
      FOREIGN KEY (human_edited_by) REFERENCES public.profiles(id) ON DELETE SET NULL;
  END IF;
END
$$;

COMMENT ON COLUMN public.deliveries.human_edited_at IS
  'When a human last edited this delivery in the app. NULL = sync-owned (the sync may update it). NOT NULL = the sync WILL NOT update it; a differing Sheet/email value is surfaced as a run finding instead. Set by the fn_stamp_human_edit trigger from auth.uid(); cleared ONLY by fn_release_delivery_rows.';
COMMENT ON COLUMN public.deliveries.human_edited_by IS
  'Who last edited this delivery in the app (profiles.id, from auth.uid()). Display only - the sync guard reads human_edited_at, never this. NULL means "a human owns this row but the trail does not say who", which is an honest unknown, not an absence of ownership.';

-- ===========================================================================
-- 2. The stamp trigger — REUSED, not cloned
-- ===========================================================================
-- `fn_stamp_human_edit` is already table-agnostic: it touches only
-- NEW.human_edited_at/by and the transaction-local GUC. Cloning it would create a second
-- definition of "how a row gets claimed" that could drift from the first. It is attached
-- here unchanged; only its COMMENT is refreshed to say seven tables instead of six.

DROP TRIGGER IF EXISTS tr_stamp_human_edit ON public.deliveries;
CREATE TRIGGER tr_stamp_human_edit
  BEFORE INSERT OR UPDATE ON public.deliveries
  FOR EACH ROW EXECUTE FUNCTION public.fn_stamp_human_edit();

COMMENT ON FUNCTION public.fn_stamp_human_edit() IS
  'BEFORE INSERT OR UPDATE on the six production fact tables AND public.deliveries: stamps human_edited_at/by whenever auth.uid() is non-null (an app session), so an in-app edit can never forget to claim its row. Service-role (sync) writes have no auth.uid() and never stamp. Skipped only while fn_release_production_rows / fn_release_delivery_rows hold the transaction-local GUC blackwood.release_human_edit.';

-- ===========================================================================
-- 3. log_delivery_changes — keep the stamp OUT of the diff
-- ===========================================================================
-- Byte-for-byte the existing function with ONE change: the UPDATE branch's key loop skips
-- `human_edited_at` and `human_edited_by`. The SNAPSHOT still carries them (a snapshot
-- should describe the row completely). Everything else — the INSERT branch, the DELETE
-- branch, the `diff_json != '{}'` guard, `performed_by = auth.uid()` — is unchanged, so
-- an UPDATE that moves a real column produces the same audit row it always did, and an
-- UPDATE that moves nothing but the stamp produces none at all.

CREATE OR REPLACE FUNCTION public.log_delivery_changes()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
  DECLARE
    old_json JSONB;
    new_json JSONB;
    diff_json JSONB := '{}'::JSONB;
    key TEXT;
  BEGIN
    IF TG_OP = 'INSERT' THEN
      INSERT INTO public.audit_logs (record_id, operation, snapshot, performed_by)
      VALUES (NEW.id, 'INSERT', to_jsonb(NEW), auth.uid());
      RETURN NEW;

    ELSIF TG_OP = 'UPDATE' THEN
      old_json := to_jsonb(OLD);
      new_json := to_jsonb(NEW);
      FOR key IN SELECT jsonb_object_keys(new_json)
      LOOP
        -- The human-edit latch stamp is bookkeeping, not a data change. Including it
        -- would make every no-op app save look like an edit in the activity feed.
        CONTINUE WHEN key IN ('human_edited_at', 'human_edited_by');
        IF old_json->key IS DISTINCT FROM new_json->key THEN
          diff_json := diff_json || jsonb_build_object(
            key, jsonb_build_object('old', old_json->key, 'new', new_json->key)
          );
        END IF;
      END LOOP;
      IF diff_json != '{}'::JSONB THEN
        INSERT INTO public.audit_logs (record_id, operation, diff, snapshot, performed_by)
        VALUES (NEW.id, 'UPDATE', diff_json, new_json, auth.uid());
      END IF;
      RETURN NEW;

    ELSIF TG_OP = 'DELETE' THEN
      INSERT INTO public.audit_logs (record_id, operation, snapshot, performed_by)
      VALUES (OLD.id, 'DELETE', to_jsonb(OLD), auth.uid());
      RETURN OLD;
    END IF;
    RETURN NULL;
  END;
$fn$;

COMMENT ON FUNCTION public.log_delivery_changes() IS
  'The deliveries audit trigger (deliveries_audit_trigger, AFTER INSERT/UPDATE/DELETE). Writes one audit_logs row per real change. The human-edit latch columns (human_edited_at/by) are excluded from the DIFF - not from the snapshot - so an app save that moved nothing else still writes no audit row, exactly as before the latch existed.';

-- ===========================================================================
-- 4. fn_apply_delivery_upstream — the ATOMIC conditional writer
-- ===========================================================================
-- The sync's ONLY update path into `deliveries`. Every write re-checks
-- `human_edited_at IS NULL` IN THE SAME STATEMENT AS THE WRITE (a predicate in the
-- UPDATE's own WHERE), so a save that lands between the worker's classify and this call
-- wins: our write simply does not match and the op comes back labelled `human_edited`.
-- There is no read-then-write anywhere in this function.
--
-- CONTRACT
--   p_ops jsonb -- ARRAY of { id, patch: {col: value, ...} }   (single table: no `table` key)
--   returns  jsonb -- ARRAY of { id, outcome }, outcome one of
--     'applied'           -- written
--     'human_edited'      -- REFUSED: a human owns this row (the whole point)
--     'missing'           -- no such row (deleted between classify and apply)
--     'empty_patch'       -- nothing to write
--     'unsupported_field' -- a patch key outside the allowlist; NOTHING written. Loud on
--                            purpose: a new classifier field must be added here
--                            deliberately, never smuggled into the delivery table.
--
-- THE ALLOWLIST is exactly the nine fields the two classifiers can diff
-- (reports/deliveries/classify.ts, reports/gsheet/classify.ts). Absent on purpose:
--   * `transaction_date` — it is in BOTH identity tiers, so a VALUE_CHANGED diff can
--     never legitimately contain it (same reasoning as production's natural keys).
--   * `true_weight_kg` / `deduction_note` — additive and write-only, never diffed (L-021).
--   * `id` / `created_at` — identity and provenance, never a correction.
--
-- NOT NULL columns (supplier, weight_kg, cost_basis, lab_results) treat a null-ish patch
-- value as "keep what's there"; nullable columns honour an explicit null.

CREATE OR REPLACE FUNCTION public.fn_apply_delivery_upstream(p_ops jsonb DEFAULT '[]'::jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $fn$
DECLARE
  v_result jsonb;
BEGIN
  IF p_ops IS NULL OR jsonb_typeof(p_ops) <> 'array' THEN
    RAISE EXCEPTION 'fn_apply_delivery_upstream: p_ops must be a JSON array (got %)',
      COALESCE(jsonb_typeof(p_ops), 'null');
  END IF;
  IF jsonb_array_length(p_ops) = 0 THEN
    RETURN '[]'::jsonb;
  END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(p_ops) o
              WHERE NULLIF(o ->> 'id', '') IS NULL) THEN
    RAISE EXCEPTION 'fn_apply_delivery_upstream: every op needs an id';
  END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(p_ops) o
              WHERE o ? 'patch' AND jsonb_typeof(o -> 'patch') <> 'object') THEN
    RAISE EXCEPTION 'fn_apply_delivery_upstream: patch must be a JSON object';
  END IF;

  WITH ops AS (
    SELECT
      (o ->> 'id')::uuid                    AS id,
      COALESCE(o -> 'patch', '{}'::jsonb)   AS patch
    FROM jsonb_array_elements(p_ops) o
  ),
  allowed(col) AS (VALUES
    ('supplier'), ('batch_code'), ('block_loc'), ('truck_plate'),
    ('sacks'), ('weight_kg'), ('cost_basis'), ('remarks'), ('lab_results')
  ),
  bad AS (
    SELECT DISTINCT o.id
      FROM ops o
      CROSS JOIN LATERAL jsonb_object_keys(o.patch) AS k(col)
     WHERE NOT EXISTS (SELECT 1 FROM allowed a WHERE a.col = k.col)
  ),
  w AS (
    SELECT o.* FROM ops o
     WHERE o.patch <> '{}'::jsonb
       AND NOT EXISTS (SELECT 1 FROM bad b WHERE b.id = o.id)
  ),
  -- PRE-write snapshot of every targeted row, for classifying whatever did NOT write.
  -- Read in the same statement, so it sees the state the guard saw.
  snap AS (
    SELECT t.id, t.human_edited_at
      FROM public.deliveries t
     WHERE t.id IN (SELECT id FROM ops)
  ),
  upd AS (
    UPDATE public.deliveries t
       SET supplier    = CASE WHEN o.patch ? 'supplier'
                              THEN COALESCE(NULLIF(o.patch ->> 'supplier', ''), t.supplier)
                              ELSE t.supplier END,
           batch_code  = CASE WHEN o.patch ? 'batch_code'
                              THEN NULLIF(o.patch ->> 'batch_code', '')
                              ELSE t.batch_code END,
           block_loc   = CASE WHEN o.patch ? 'block_loc'
                              THEN NULLIF(o.patch ->> 'block_loc', '')
                              ELSE t.block_loc END,
           truck_plate = CASE WHEN o.patch ? 'truck_plate'
                              THEN NULLIF(o.patch ->> 'truck_plate', '')
                              ELSE t.truck_plate END,
           sacks       = CASE WHEN o.patch ? 'sacks'
                              THEN NULLIF(o.patch ->> 'sacks', '')::integer
                              ELSE t.sacks END,
           weight_kg   = CASE WHEN o.patch ? 'weight_kg'
                              THEN COALESCE(NULLIF(o.patch ->> 'weight_kg', '')::numeric, t.weight_kg)
                              ELSE t.weight_kg END,
           cost_basis  = CASE WHEN o.patch ? 'cost_basis'
                              THEN COALESCE(NULLIF(o.patch ->> 'cost_basis', '')::numeric, t.cost_basis)
                              ELSE t.cost_basis END,
           remarks     = CASE WHEN o.patch ? 'remarks'
                              THEN NULLIF(o.patch ->> 'remarks', '')
                              ELSE t.remarks END,
           lab_results = CASE WHEN o.patch ? 'lab_results'
                              THEN COALESCE(NULLIF(o.patch -> 'lab_results', 'null'::jsonb), t.lab_results)
                              ELSE t.lab_results END
      FROM w o
     WHERE t.id = o.id
       AND t.human_edited_at IS NULL
    RETURNING t.id
  )
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'id',      o.id,
           'outcome', CASE
             WHEN d.id IS NOT NULL THEN 'applied'
             WHEN EXISTS (SELECT 1 FROM bad b WHERE b.id = o.id) THEN 'unsupported_field'
             WHEN o.patch = '{}'::jsonb THEN 'empty_patch'
             WHEN s.id IS NULL THEN 'missing'
             WHEN s.human_edited_at IS NOT NULL THEN 'human_edited'
             ELSE 'not_applied'
           END
         ) ORDER BY o.id), '[]'::jsonb)
    INTO v_result
    FROM ops o
    LEFT JOIN upd  d ON d.id = o.id
    LEFT JOIN snap s ON s.id = o.id;

  RETURN v_result;
END
$fn$;

COMMENT ON FUNCTION public.fn_apply_delivery_upstream(jsonb) IS
  'The sync worker''s ONLY update path into public.deliveries. Applies {id,patch} ops, re-checking human_edited_at IS NULL IN THE SAME STATEMENT AS EACH WRITE, so a delivery a human corrected in the app is never overwritten by the Sheet or an email. Never inserts, never deletes. Returns [{id,outcome}] with outcome applied|human_edited|missing|empty_patch|unsupported_field.';

REVOKE EXECUTE ON FUNCTION public.fn_apply_delivery_upstream(jsonb) FROM public;
REVOKE EXECUTE ON FUNCTION public.fn_apply_delivery_upstream(jsonb) FROM anon;
GRANT  EXECUTE ON FUNCTION public.fn_apply_delivery_upstream(jsonb) TO service_role;

-- ===========================================================================
-- 5. fn_release_delivery_rows — the way BACK
-- ===========================================================================
-- Clears the latch so the row follows the Sheet / email again. Without it ownership only
-- ratchets one way and the delivery log slowly freezes.
--
-- The guard lives in the UPDATE's own WHERE (`human_edited_at IS NOT NULL`), so releasing
-- a row nobody claimed writes nothing and reports it as skipped. One table, so unlike
-- `fn_release_production_rows` there is no dynamic SQL at all — the statement is static
-- and the ids are bound.
--
-- Release is EXPLICIT only: a row is NOT auto-released just because the Sheet later
-- agrees, so rule 1 holds without exception.
--
--   returns { ok, table, released[], released_count, skipped[], skipped_count }

CREATE OR REPLACE FUNCTION public.fn_release_delivery_rows(p_ids uuid[])
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $fn$
DECLARE
  v_released uuid[];
BEGIN
  IF p_ids IS NULL OR COALESCE(array_length(p_ids, 1), 0) = 0 THEN
    RETURN jsonb_build_object(
      'ok', true, 'table', 'deliveries',
      'released', '[]'::jsonb, 'released_count', 0,
      'skipped', '[]'::jsonb, 'skipped_count', 0);
  END IF;

  -- Transaction-local: tells fn_stamp_human_edit that THIS statement is the sanctioned
  -- release, and is gone by commit. An ordinary PATCH sending human_edited_at = null
  -- does NOT hold it and is therefore re-stamped, not honoured.
  PERFORM set_config('blackwood.release_human_edit', 'on', true);

  WITH r AS (
    UPDATE public.deliveries t
       SET human_edited_at = NULL, human_edited_by = NULL
     WHERE t.id = ANY(p_ids) AND t.human_edited_at IS NOT NULL
    RETURNING t.id
  )
  SELECT COALESCE(array_agg(id), ARRAY[]::uuid[]) INTO v_released FROM r;

  PERFORM set_config('blackwood.release_human_edit', 'off', true);

  RETURN jsonb_build_object(
    'ok', true,
    'table', 'deliveries',
    'released', to_jsonb(v_released),
    'released_count', COALESCE(array_length(v_released, 1), 0),
    'skipped', to_jsonb(ARRAY(
      SELECT x FROM unnest(p_ids) AS x WHERE NOT (x = ANY(v_released)))),
    'skipped_count', (
      SELECT count(*) FROM unnest(p_ids) AS x WHERE NOT (x = ANY(v_released))));
END
$fn$;

COMMENT ON FUNCTION public.fn_release_delivery_rows(uuid[]) IS
  'Hands human-edited deliveries back to the sync by clearing human_edited_at/by. The ONLY sanctioned way to clear the latch (it holds the transaction-local GUC blackwood.release_human_edit so fn_stamp_human_edit does not immediately re-stamp). Guard is in the UPDATE''s own WHERE; a row nobody claimed is reported as skipped, not written. Returns {ok, table, released[], released_count, skipped[], skipped_count}.';

REVOKE EXECUTE ON FUNCTION public.fn_release_delivery_rows(uuid[]) FROM public;
REVOKE EXECUTE ON FUNCTION public.fn_release_delivery_rows(uuid[]) FROM anon;
GRANT  EXECUTE ON FUNCTION public.fn_release_delivery_rows(uuid[]) TO authenticated;
GRANT  EXECUTE ON FUNCTION public.fn_release_delivery_rows(uuid[]) TO service_role;

-- ===========================================================================
-- 6. view_deliveries_human_edited — the read model
-- ===========================================================================
-- One row per delivery a human owns, with enough identity to name it in a UI
-- ("2026-02-04 · Ornales · FEB-26-BLK4 · A-7C · CBQ 5957") and the id the release RPC
-- needs. `security_invoker`, so it inherits the base table's RLS.
--
-- CARRIES NO ₱ COLUMN, deliberately. `cost_basis` is one of the nine fields the latch can
-- refuse, so it is tempting to show it here — but this view feeds the sync-visibility
-- surface, which is not price-gated. The refusal names the ROW; the number stays in RC IN
-- behind canViewPrices(). Same rule the price findings follow.

CREATE OR REPLACE VIEW public.view_deliveries_human_edited
WITH (security_invoker = true) AS
SELECT
  'deliveries'::text AS table_name,
  'rc_in'::text      AS section,
  d.id               AS record_id,
  d.transaction_date,
  d.supplier,
  d.batch_code,
  d.block_loc,
  d.truck_plate,
  d.sacks,
  d.weight_kg,
  d.human_edited_at,
  d.human_edited_by,
  p.display_name     AS human_edited_by_name
FROM public.deliveries d
LEFT JOIN public.profiles p ON p.id = d.human_edited_by
WHERE d.human_edited_at IS NOT NULL;

COMMENT ON VIEW public.view_deliveries_human_edited IS
  'Every delivery a human currently owns (human_edited_at IS NOT NULL), with its date/supplier/batch/block/plate identity and who claimed it. The sync will not update any row listed here; fn_release_delivery_rows(ids) hands one back. Carries no PHP column on purpose - this surface is not price-gated.';

GRANT SELECT ON public.view_deliveries_human_edited TO authenticated, service_role;
REVOKE ALL   ON public.view_deliveries_human_edited FROM anon;

-- ===========================================================================
-- 7. BACKFILL — 34 rows, every one of them evidenced
-- ===========================================================================
-- Production latched NOTHING retroactively, because its rows were "all sync-written or
-- hand-entered with no way to tell them apart". `deliveries` is different: it carries an
-- audit TRIGGER that has recorded `performed_by = auth.uid()` on every write since
-- 2026-02-11, so a human-performed UPDATE is a FACT in the trail, not an inference.
--
-- SET A — 33 live deliveries with at least one `audit_logs` UPDATE carrying a non-null
--   `performed_by`. Every one resolves to a profile, and all 33 resolve to the same
--   person (Renzo Sy). Edited on 2026-02-12 (5), 02-15 (5), 02-18 (19), 05-28 (1),
--   08-04 (3).
--
-- SET B — the ONE row carrying the 2026-06-25 "VERIFIED-CORRECT ANNOTATION" comment:
--   a5169fad, the Feb-4 Ornales truckload this whole migration is named after. Its only
--   audit row has `performed_by = NULL`, so SET A misses it — the row the story is about
--   would have been left unprotected by the obvious rule. It is latched on the strength
--   of the annotation itself, which states in words that the value is Renzo's deliberate
--   manual correction.
--
-- TWO RULES THE BACKFILL OBEYS:
--   * `human_edited_at` comes from THE AUDIT ROW'S OWN `performed_at`, never `now()`.
--     A latch that claims the edit happened during this migration is a lie about when a
--     human last looked at the row.
--   * `human_edited_by` is the audit row's `performed_by` ONLY when it resolves in
--     `profiles`, and NULL otherwise. Nothing is invented. For SET B that means a NULL
--     "by" — an honest "a human owns this, the trail does not say who". The guard reads
--     only `human_edited_at`, so a NULL attribution protects the row exactly as well.
--
-- NOT latched, deliberately: the 156 `audit_logs` UPDATE rows on `deliveries` that carry
-- neither a `performed_by` nor a sync provenance stamp. Those predate the 2026-07-03
-- L-009 provenance backfill and are overwhelmingly sync writes that simply could not
-- stamp themselves. Latching them would freeze ~156 rows against the sync forever on a
-- guess, which is the opposite of what a latch is for.
--
-- This block sets the GUC so `fn_stamp_human_edit` does not overwrite the historical
-- timestamps with now(), and is written to be idempotent: it never touches a row that is
-- already latched, so a re-run is a no-op rather than a re-dating.

DO $$
DECLARE
  v_a int := 0;
  v_b int := 0;
BEGIN
  PERFORM set_config('blackwood.release_human_edit', 'on', true);

  -- SET A
  WITH human_upd AS (
    SELECT al.record_id,
           (array_agg(al.performed_at ORDER BY al.performed_at DESC))[1] AS ts,
           (array_agg(al.performed_by ORDER BY al.performed_at DESC))[1] AS by_id
      FROM public.audit_logs al
     WHERE al.table_name = 'deliveries'
       AND al.operation  = 'UPDATE'
       AND al.performed_by IS NOT NULL
     GROUP BY al.record_id
  ), u AS (
    UPDATE public.deliveries d
       SET human_edited_at = h.ts,
           human_edited_by = p.id          -- NULL when the performer has no profile row
      FROM human_upd h
      LEFT JOIN public.profiles p ON p.id = h.by_id
     WHERE d.id = h.record_id
       AND d.human_edited_at IS NULL       -- idempotent: never re-date a latched row
    RETURNING d.id
  )
  SELECT count(*) INTO v_a FROM u;

  -- SET B
  WITH annotated AS (
    SELECT al.record_id,
           (array_agg(al.performed_at ORDER BY al.performed_at DESC))[1] AS ts
      FROM public.audit_logs al
     WHERE al.table_name = 'deliveries'
       AND al.operation  = 'UPDATE'
       AND al.comment ILIKE '%VERIFIED-CORRECT ANNOTATION%'
     GROUP BY al.record_id
  ), u AS (
    UPDATE public.deliveries d
       SET human_edited_at = a.ts,
           human_edited_by = NULL          -- unknown, and never fabricated
      FROM annotated a
     WHERE d.id = a.record_id
       AND d.human_edited_at IS NULL
    RETURNING d.id
  )
  SELECT count(*) INTO v_b FROM u;

  PERFORM set_config('blackwood.release_human_edit', 'off', true);

  RAISE NOTICE 'deliveries human-edit latch backfill: % from audit performed_by, % from VERIFIED-CORRECT annotation', v_a, v_b;
END
$$;
