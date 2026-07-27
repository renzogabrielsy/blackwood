-- fn_update_blackwood_state — DELETE branch was one row stale (BUG-016 follow-up, found 2026-07-27)
--
-- THE DEFECT
-- ----------
-- `tr_blackwood_delivery` is a BEFORE INSERT OR UPDATE OR DELETE trigger on `deliveries`.
-- In its DELETE branch the two `deliveries` sub-selects recomputed the batch's stored state
-- as:
--
--     SELECT SUM(weight_kg)              FROM deliveries WHERE batch_code = OLD.batch_code
--     SELECT SUM(cost_basis * weight_kg) FROM deliveries WHERE batch_code = OLD.batch_code
--             / NULLIF(SUM(weight_kg), 0)
--
-- Because the trigger fires BEFORE the row is removed, the row being deleted is STILL
-- VISIBLE to those sub-selects. So every delivery delete wrote a `current_weight` that was
-- too high by exactly the deleted row's `weight_kg`, and an `avg_cost` still weighted by
-- the deleted row. The stored value landed one row stale on every single delete.
--
-- Proven on 2026-07-27: deleting the 24,024 kg BUG-016 duplicate from `JULY-26-BLK7` left
-- `batches.current_weight = 84,753` instead of the correct 60,729 (it had to be repaired by
-- hand). A read-only sweep then found 4 batches carrying `current_weight` drift totalling
-- 83,308 kg, backfilled from SQL truth alongside this migration.
--
-- The SAME function's location-clearing branch, a few lines below, already gets this right —
-- it filters `AND id != OLD.id` and carries a comment explaining precisely this hazard. The
-- weight/avg_cost recompute simply never got the same treatment. This migration applies that
-- established idiom to the two sub-selects that were missing it.
--
-- Blast radius of the original defect was limited because `view_blocking_grid` computes
-- balance live from SUM(deliveries) - SUM(rc_out) and does NOT read `current_weight` (the
-- 2026-05-31 phantom-inventory fix), so no user-facing number was wrong.
--
-- SCOPE
-- -----
-- ONLY the two `deliveries` sub-selects in the DELETE branch change. The rc_out sub-select in
-- that same branch is deliberately untouched: deleting a DELIVERY does not change any rc_out
-- row, so nothing there needs excluding. The INSERT branch, the UPDATE branch and the
-- location-clearing branch are reproduced byte-for-byte, as are the signature, the
-- LANGUAGE/VOLATILITY, SECURITY INVOKER (prosecdef = false) and the pinned
-- `SET search_path = public`.
--
-- KNOWN, NOT FIXED HERE (needs its own authorization — see docs/BUG_LEDGER.md BUG-017):
-- the UPDATE branch's batch_code-change path has the same BEFORE-trigger staleness in BOTH
-- directions (the OLD batch's recompute still sees the departing row; the NEW batch's
-- recompute cannot see it yet). It is NOT fixable with this one-line idiom — the new-batch
-- side needs the not-yet-visible NEW row folded in — so it is deliberately left alone rather
-- than rewritten inside a targeted fix to a different branch.

CREATE OR REPLACE FUNCTION public.fn_update_blackwood_state()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE
    target_batch RECORD;
    new_total_weight DECIMAL;
    added_weight DECIMAL;
    recalc_avg_cost DECIMAL;
BEGIN
    -- Handle DELETE operations
    -- BEFORE trigger: the deleted row is STILL VISIBLE to these sub-selects, so every
    -- `deliveries` aggregate here MUST exclude it with `id <> OLD.id` (same idiom as the
    -- location-clearing block below). Without it the recompute lands one row stale.
    IF (TG_OP = 'DELETE') THEN
        UPDATE batches SET
            current_weight = COALESCE((
                SELECT SUM(weight_kg) FROM deliveries
                WHERE batch_code = OLD.batch_code AND id <> OLD.id
            ), 0) - COALESCE((
                SELECT SUM(r.weight_kg) FROM rc_out r
                JOIN batches b2 ON r.batch_id = b2.id
                WHERE b2.batch_code = OLD.batch_code
            ), 0),
            avg_cost = COALESCE((
                SELECT SUM(cost_basis * weight_kg) / NULLIF(SUM(weight_kg), 0)
                FROM deliveries WHERE batch_code = OLD.batch_code AND id <> OLD.id
            ), 0),
            updated_at = now()
        WHERE batch_code = OLD.batch_code;

        -- If no deliveries remain, clear location_ref and reset status to STORED.
        -- Use id != OLD.id because this is a BEFORE trigger: the deleted row still exists.
        IF NOT EXISTS (
            SELECT 1 FROM deliveries
            WHERE batch_code = OLD.batch_code
              AND id != OLD.id
        ) THEN
            UPDATE batches SET
                location_ref = '',
                status = 'STORED'::batch_status,
                updated_at = now()
            WHERE batch_code = OLD.batch_code;
        END IF;

        RETURN OLD;
    END IF;

    -- Handle UPDATE operations (UNCHANGED)
    IF (TG_OP = 'UPDATE') THEN
        IF (OLD.batch_code IS DISTINCT FROM NEW.batch_code) THEN
            -- Recalc old batch
            UPDATE batches SET
                current_weight = COALESCE((SELECT SUM(weight_kg) FROM deliveries WHERE batch_code = OLD.batch_code), 0)
                    - COALESCE((SELECT SUM(r.weight_kg) FROM rc_out r JOIN batches b2 ON r.batch_id = b2.id WHERE b2.batch_code = OLD.batch_code), 0),
                avg_cost = COALESCE((SELECT SUM(cost_basis * weight_kg) / NULLIF(SUM(weight_kg), 0) FROM deliveries WHERE batch_code = OLD.batch_code), 0),
                updated_at = now()
            WHERE batch_code = OLD.batch_code;
            -- Recalc new batch
            UPDATE batches SET
                current_weight = COALESCE((SELECT SUM(weight_kg) FROM deliveries WHERE batch_code = NEW.batch_code), 0)
                    - COALESCE((SELECT SUM(r.weight_kg) FROM rc_out r JOIN batches b2 ON r.batch_id = b2.id WHERE b2.batch_code = NEW.batch_code), 0),
                avg_cost = COALESCE((SELECT SUM(cost_basis * weight_kg) / NULLIF(SUM(weight_kg), 0) FROM deliveries WHERE batch_code = NEW.batch_code), 0),
                updated_at = now()
            WHERE batch_code = NEW.batch_code;
            RETURN NEW;
        END IF;

        IF (OLD.cost_basis IS DISTINCT FROM NEW.cost_basis) OR (OLD.weight_kg IS DISTINCT FROM NEW.weight_kg) THEN
            UPDATE batches SET
                current_weight = COALESCE((SELECT SUM(weight_kg) FROM deliveries WHERE batch_code = NEW.batch_code), 0)
                    - COALESCE((SELECT SUM(r.weight_kg) FROM rc_out r JOIN batches b2 ON r.batch_id = b2.id WHERE b2.batch_code = NEW.batch_code), 0),
                avg_cost = COALESCE((SELECT SUM(cost_basis * weight_kg) / NULLIF(SUM(weight_kg), 0) FROM deliveries WHERE batch_code = NEW.batch_code), 0),
                updated_at = now()
            WHERE batch_code = NEW.batch_code;
        END IF;
        RETURN NEW;
    END IF;

    -- Handle INSERT operations (UNCHANGED)
    added_weight := NEW.weight_kg;

    SELECT * INTO target_batch FROM batches WHERE batch_code = NEW.batch_code;

    IF FOUND THEN
        new_total_weight := target_batch.current_weight + added_weight;

        IF new_total_weight > 0 THEN
            UPDATE batches SET
                avg_cost = ((target_batch.current_weight * target_batch.avg_cost) + (added_weight * NEW.cost_basis)) / new_total_weight,
                quality_stats = jsonb_build_object(
                    'bd',  ((COALESCE((target_batch.quality_stats->>'bd')::decimal, 0) * target_batch.current_weight) + (COALESCE((NEW.lab_results->>'bd')::decimal, 0) * added_weight)) / new_total_weight,
                    'ash', ((COALESCE((target_batch.quality_stats->>'ash')::decimal, 0) * target_batch.current_weight) + (COALESCE((NEW.lab_results->>'ash')::decimal, 0) * added_weight)) / new_total_weight,
                    'mc',  ((COALESCE((target_batch.quality_stats->>'mc')::decimal, 0) * target_batch.current_weight) + (COALESCE((NEW.lab_results->>'mc')::decimal, 0) * added_weight)) / new_total_weight
                ),
                current_weight = new_total_weight,
                updated_at = now()
            WHERE batch_code = NEW.batch_code;
        END IF;

        -- Set SUNDRIED status for SUNDRY batches (only upgrade from STORED)
        IF NEW.batch_code ILIKE '%SUNDRY%' AND target_batch.status = 'STORED'::batch_status THEN
            UPDATE batches SET status = 'SUNDRIED'::batch_status, updated_at = now()
            WHERE batch_code = NEW.batch_code;
        END IF;
    ELSE
        RAISE EXCEPTION 'Batch Code % does not exist in the System Map.', NEW.batch_code;
    END IF;

    RETURN NEW;
END;
$function$;
