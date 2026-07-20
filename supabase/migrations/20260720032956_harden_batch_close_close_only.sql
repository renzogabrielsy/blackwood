-- ============================================================================
-- Harden the batch-close mechanism (2026-07-20). Applied to the linked project via the
-- Supabase MCP apply_migration (version 20260720032956); this file mirrors it for VCS.
--   1. fn_is_close_remark  — EXACT-phrase match (was a loose \mCLOSED\M word match,
--      so "NOT CLOSED YET" false-positived). Canonical set kept in lockstep with the
--      TS shared helper workers/sync/src/lib/closingRemarks.ts.
--   2. fn_process_blackwood_usage — CLOSE-ONLY / MONOTONIC: once a batch is CLOSED,
--      this trigger path never auto-reopens it (a cleared/edited/non-closing remark on
--      UPDATE, or a deleted close-row on DELETE, can no longer flip CLOSED->IN-USE).
--      The old location-replacement guard is SUBSUMED (kept as a subset). INSERT of a
--      genuinely new MAIN/SUNDRY feeding is intentionally left able to set state (a real
--      new feeding, not a remark artifact).
--   3. fn_close_batch(uuid) — the ONE place a batches.status->CLOSED write lives, called
--      by the gsheet close-scan (service-role). SECURITY DEFINER, idempotent, monotonic.
-- ============================================================================

-- 1. Exact-phrase close-remark test (trim + upper in the canonical set). ----------------
CREATE OR REPLACE FUNCTION public.fn_is_close_remark(p_remarks text)
 RETURNS boolean
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'public'
AS $function$
  SELECT p_remarks IS NOT NULL
     AND upper(trim(p_remarks)) = ANY (ARRAY['CLOSED', 'DONE', 'DONE FEEDING', 'FEEDING DONE']);
$function$;

-- 2. Close-only / monotonic rc_out state trigger. --------------------------------------
CREATE OR REPLACE FUNCTION public.fn_process_blackwood_usage()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE
    batch_rec RECORD;
    new_status batch_status;
    has_closed BOOLEAN;
    has_sundrying BOOLEAN;
    has_main BOOLEAN;
    old_batch_rec RECORD;
BEGIN
    -- ========== INSERT LOGIC ==========
    -- Unchanged: a new feeding row sets state. A close remark closes; a MAIN/SUNDRY
    -- feeding on a previously-closed batch is a REAL resumed feeding (not a remark
    -- artifact), so INSERT is intentionally NOT made monotonic-close here.
    IF TG_OP = 'INSERT' THEN
        SELECT * INTO batch_rec FROM batches WHERE id = NEW.batch_id;

        NEW.block_loc := COALESCE(NEW.block_loc, batch_rec.location_ref);

        new_status := CASE
            WHEN fn_is_close_remark(NEW.remarks) THEN 'CLOSED'::batch_status
            WHEN NEW.destination = 'SUNDRY' THEN 'SUNDRYING'::batch_status
            WHEN NEW.destination = 'MAIN' THEN 'IN-USE'::batch_status
            ELSE batch_rec.status
        END;

        UPDATE batches SET
            current_weight = current_weight - NEW.weight_kg,
            updated_at = now(),
            status = new_status
        WHERE id = NEW.batch_id;

        RETURN NEW;
    END IF;

    -- ========== DELETE LOGIC ==========
    IF TG_OP = 'DELETE' THEN
        SELECT * INTO batch_rec FROM batches WHERE id = OLD.batch_id;

        UPDATE batches SET
            current_weight = current_weight + OLD.weight_kg,
            updated_at = now()
        WHERE id = OLD.batch_id;

        SELECT
            EXISTS (SELECT 1 FROM rc_out WHERE batch_id = OLD.batch_id AND id != OLD.id AND fn_is_close_remark(remarks)) INTO has_closed;
        SELECT
            EXISTS (SELECT 1 FROM rc_out WHERE batch_id = OLD.batch_id AND id != OLD.id AND destination = 'SUNDRY') INTO has_sundrying;
        SELECT
            EXISTS (SELECT 1 FROM rc_out WHERE batch_id = OLD.batch_id AND id != OLD.id AND destination = 'MAIN') INTO has_main;

        new_status := CASE
            WHEN has_closed THEN 'CLOSED'::batch_status
            WHEN has_sundrying THEN 'SUNDRYING'::batch_status
            WHEN has_main THEN 'IN-USE'::batch_status
            WHEN batch_rec.batch_code ILIKE '%SUNDRY%' THEN 'SUNDRIED'::batch_status
            ELSE 'STORED'::batch_status
        END;

        -- MONOTONIC CLOSE: deleting the close-row (or any row) must never re-open a
        -- CLOSED batch via this trigger path.
        IF batch_rec.status = 'CLOSED' AND new_status != 'CLOSED' THEN
            new_status := 'CLOSED'::batch_status;
        END IF;

        UPDATE batches SET
            status = new_status,
            updated_at = now()
        WHERE id = OLD.batch_id;

        RETURN OLD;
    END IF;

    -- ========== UPDATE LOGIC ==========
    IF TG_OP = 'UPDATE' THEN
        SELECT * INTO batch_rec FROM batches WHERE id = NEW.batch_id;

        NEW.block_loc := COALESCE(NEW.block_loc, batch_rec.location_ref);

        UPDATE batches SET
            current_weight = current_weight + OLD.weight_kg - NEW.weight_kg,
            updated_at = now()
        WHERE id = NEW.batch_id;

        SELECT
            EXISTS (
                SELECT 1 FROM rc_out
                WHERE batch_id = NEW.batch_id AND id != NEW.id AND fn_is_close_remark(remarks)
                UNION ALL
                SELECT 1 WHERE fn_is_close_remark(NEW.remarks)
            ) INTO has_closed;
        SELECT
            EXISTS (
                SELECT 1 FROM rc_out
                WHERE batch_id = NEW.batch_id AND id != NEW.id AND destination = 'SUNDRY'
                UNION ALL
                SELECT 1 WHERE NEW.destination = 'SUNDRY'
            ) INTO has_sundrying;
        SELECT
            EXISTS (
                SELECT 1 FROM rc_out
                WHERE batch_id = NEW.batch_id AND id != NEW.id AND destination = 'MAIN'
                UNION ALL
                SELECT 1 WHERE NEW.destination = 'MAIN'
            ) INTO has_main;

        new_status := CASE
            WHEN has_closed THEN 'CLOSED'::batch_status
            WHEN has_sundrying THEN 'SUNDRYING'::batch_status
            WHEN has_main THEN 'IN-USE'::batch_status
            WHEN batch_rec.batch_code ILIKE '%SUNDRY%' THEN 'SUNDRIED'::batch_status
            ELSE 'STORED'::batch_status
        END;

        -- MONOTONIC CLOSE (supersedes the old location-replacement-only guard): once a
        -- batch is CLOSED, clearing/editing an rc_out remark can never recompute it back
        -- to IN-USE/SUNDRYING/etc. The replacement scenario (a new batch already occupies
        -- the same location) is covered as a subset of this stronger rule.
        IF batch_rec.status = 'CLOSED' AND new_status != 'CLOSED' THEN
            new_status := 'CLOSED'::batch_status;
        END IF;

        UPDATE batches SET
            status = new_status,
            updated_at = now()
        WHERE id = NEW.batch_id;

        IF OLD.batch_id != NEW.batch_id THEN
            SELECT * INTO old_batch_rec FROM batches WHERE id = OLD.batch_id;

            UPDATE batches SET
                current_weight = current_weight + OLD.weight_kg,
                updated_at = now()
            WHERE id = OLD.batch_id;

            SELECT
                EXISTS (SELECT 1 FROM rc_out WHERE batch_id = OLD.batch_id AND id != OLD.id AND fn_is_close_remark(remarks)) INTO has_closed;
            SELECT
                EXISTS (SELECT 1 FROM rc_out WHERE batch_id = OLD.batch_id AND id != OLD.id AND destination = 'SUNDRY') INTO has_sundrying;
            SELECT
                EXISTS (SELECT 1 FROM rc_out WHERE batch_id = OLD.batch_id AND id != OLD.id AND destination = 'MAIN') INTO has_main;

            new_status := CASE
                WHEN has_closed THEN 'CLOSED'::batch_status
                WHEN has_sundrying THEN 'SUNDRYING'::batch_status
                WHEN has_main THEN 'IN-USE'::batch_status
                WHEN old_batch_rec.batch_code ILIKE '%SUNDRY%' THEN 'SUNDRIED'::batch_status
                ELSE 'STORED'::batch_status
            END;

            -- MONOTONIC CLOSE for the OLD batch when batch_id changes.
            IF old_batch_rec.status = 'CLOSED' AND new_status != 'CLOSED' THEN
                new_status := 'CLOSED'::batch_status;
            END IF;

            UPDATE batches SET
                status = new_status,
                updated_at = now()
            WHERE id = OLD.batch_id;
        END IF;

        RETURN NEW;
    END IF;

    RETURN NULL;
END;
$function$;

-- 3. The single close-write entry point (service-role, monotonic, idempotent). ----------
CREATE OR REPLACE FUNCTION public.fn_close_batch(p_batch_id uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
    v_updated int;
BEGIN
    UPDATE batches
       SET status = 'CLOSED'::batch_status,
           updated_at = now()
     WHERE id = p_batch_id
       AND status IS DISTINCT FROM 'CLOSED'::batch_status;
    GET DIAGNOSTICS v_updated = ROW_COUNT;
    RETURN v_updated > 0;
END;
$function$;

REVOKE ALL ON FUNCTION public.fn_close_batch(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.fn_close_batch(uuid) TO service_role;
