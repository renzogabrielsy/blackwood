-- BUG A fix (Renzo arbitration, 2026-07-11): the rc_out trigger fn_process_blackwood_usage
-- only auto-closes a batch when a feeding's remarks ILIKE '%CLOSED%'. The plant also writes
-- close-signal phrases the trigger never recognized — e.g. batch AUG-25-BLK2 (block C-12A)
-- got "DONE FEEDING" in the PROPOSED DAILY REPORT for 2026-07-08 but the trigger left it
-- IN-USE, so the app showed the block active while the Sheet had already dropped it.
--
-- Data-driven survey (2026-07-11) of the real remark corpus before writing this:
--   SELECT remarks, COUNT(*) FROM rc_out WHERE remarks IS NOT NULL AND trim(remarks) <> ''
--   GROUP BY remarks ORDER BY COUNT(*) DESC;
--     452  CLOSED
--      67  BACKLOG
--       2  8X50 / 6X50 & 9X50 FEED TO RS5
--       2  OPEN
--       1  layupan open 13 mc 4 ash
--       1  OPENED
--   Full audit_logs history (snapshot->>'remarks', every rc_out INSERT/UPDATE ever logged)
--   surfaces exactly two close-signal values that were ever written: CLOSED and DONE (one
--   row, 2026-07-01, later manually corrected to CLOSED — record_id 96579d0e-52a0-465c-
--   83a2-68f1a501dfd1). "DONE FEEDING" never appears anywhere in the DB or its audit trail
--   because the current extraction pipeline drops the remark before the row is written (see
--   the ingestion finding reported alongside this migration) — it is included below on
--   Renzo's explicit 2026-07-11 arbitration, not as a DB-evidenced phrase.
--
-- fn_is_close_remark() centralizes the phrase list in ONE place so the trigger's four
-- ILIKE '%CLOSED%' call sites (INSERT branch, DELETE has_closed check, UPDATE has_closed
-- check x2 for same-batch and cross-batch edits) can never drift from each other again.

CREATE OR REPLACE FUNCTION public.fn_is_close_remark(p_remarks text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path TO 'public'
AS $function$
  SELECT p_remarks IS NOT NULL AND (
    -- "CLOSED" as a whole word anywhere in the remark. \m/\M are Postgres's
    -- word-boundary anchors — this is the original ILIKE '%CLOSED%' behavior, just
    -- word-bounded so a hypothetical word merely containing "closed" can't match.
    -- Evidenced: 452 live rows, the overwhelming majority of the corpus.
    p_remarks ~* '\mCLOSED\M'
    -- Bare "DONE" as the ENTIRE remark (not a substring) — evidenced exactly once in
    -- audit_logs history and meant "this batch is finished". Whole-remark match (not
    -- word-boundary substring) deliberately avoids false-positiving on phrases like
    -- "NOT DONE YET" that merely contain the word "done".
    OR upper(trim(p_remarks)) = 'DONE'
    -- "DONE FEEDING" / "FEEDING DONE" — the confirmed real-world phrase from the
    -- PROPOSED DAILY REPORT (Renzo arbitration, 2026-07-11, AUG-25-BLK2 / 2026-07-08).
    -- Specific two-word compounds carry negligible false-positive risk in this
    -- operational remarks corpus (plant reports don't write negated closure remarks).
    OR p_remarks ~* '\mDONE\s+FEEDING\M'
    OR p_remarks ~* '\mFEEDING\s+DONE\M'
  );
$function$;

COMMENT ON FUNCTION public.fn_is_close_remark(text) IS
  'Returns true when an rc_out.remarks value signals the batch is finished (BUG A fix, '
  '2026-07-11). Phrase list is data-driven from a survey of rc_out remarks + audit_logs '
  'history; see the migration file header for the full survey and Renzo''s arbitration '
  'notes on "DONE FEEDING".';

REVOKE EXECUTE ON FUNCTION public.fn_is_close_remark(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.fn_is_close_remark(text) TO authenticated, service_role;

-- Rewrite fn_process_blackwood_usage to route every close-detection check through
-- fn_is_close_remark() instead of an inline ILIKE '%CLOSED%'. Logic is otherwise
-- byte-for-byte identical to the previous version.
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

        -- Preserve CLOSED status when editing historical records if a replacement batch
        -- already occupies the same location. Without this guard, clearing the CLOSED remark
        -- from an rc_out record would recompute status to SUNDRYING/IN-USE/etc., which
        -- violates the idx_unique_active_batch_per_location partial unique index.
        IF batch_rec.status = 'CLOSED'
            AND OLD.batch_id = NEW.batch_id
            AND new_status != 'CLOSED'
        THEN
            IF EXISTS (
                SELECT 1 FROM batches
                WHERE location_ref = batch_rec.location_ref
                  AND id != NEW.batch_id
                  AND status IN ('STORED', 'IN-USE', 'SUNDRYING', 'SUNDRIED')
                  AND location_ref IS NOT NULL
                  AND location_ref != ''
            ) THEN
                new_status := 'CLOSED'::batch_status;
            END IF;
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

            -- Preserve CLOSED status for the old batch when batch_id changes, using the
            -- same replacement-detection guard as above.
            IF old_batch_rec.status = 'CLOSED'
                AND new_status != 'CLOSED'
            THEN
                IF EXISTS (
                    SELECT 1 FROM batches
                    WHERE location_ref = old_batch_rec.location_ref
                      AND id != OLD.batch_id
                      AND status IN ('STORED', 'IN-USE', 'SUNDRYING', 'SUNDRIED')
                      AND location_ref IS NOT NULL
                      AND location_ref != ''
                ) THEN
                    new_status := 'CLOSED'::batch_status;
                END IF;
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
