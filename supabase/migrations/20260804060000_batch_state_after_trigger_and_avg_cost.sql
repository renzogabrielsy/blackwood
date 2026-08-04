-- ============================================================================
-- BUG-017 + BUG-018 — one function, two defects, one fix.
--
-- Renzo authorised both on 2026-08-04.
--
-- BUG-017 — the trigger fired BEFORE the row it was measuring.
--   `tr_blackwood_delivery` was a BEFORE trigger whose branches recompute the batch
--   from `deliveries`. In a BEFORE trigger the row is NOT yet in its final state, so
--   every recompute read a table that disagreed with the write about to happen:
--     * UPDATE, batch_code changed — the OLD batch still saw the departing row (left
--       too HIGH by its weight); the NEW batch could not see it yet (left too LOW).
--       Proven in production: delivery a10720f4-… moved JULY-26-BLK6 → JULY-26-BLK7 on
--       2026-07-22 and left BLK6 +24,024 kg high (backfilled under BUG-016a).
--     * UPDATE, cost_basis/weight_kg changed — the sub-select re-read the row's OLD
--       values, so an edited weight recomputed to the SAME number it started with. This
--       instance was never named in the ledger; it has the identical cause.
--     * DELETE — patched in 2026-08-03 with `AND id <> OLD.id`, a workaround for the
--       same root cause rather than a fix of it.
--   The ledger's own fix spec calls the AFTER trigger "the cleaner fix". That is what
--   this does: AFTER, every row is final, and all four cases become the SAME recompute.
--   The `id <> OLD.id` workarounds are removed — under AFTER DELETE the row is already
--   gone, so they would be lies that happen to be harmless.
--
-- BUG-018 — `avg_cost` had two competing definitions (216 of 693 batches disagreed).
--   INSERT maintained a PERPETUAL moving average blended against `current_weight`
--   (which is net of rc_out), while DELETE/UPDATE RECOMPUTED a plain delivery-weighted
--   average. A batch's cost therefore depended on which branch last touched it.
--   Renzo's decision (2026-08-04): **delivery-weighted everywhere** —
--   `SUM(cost_basis * weight_kg) / SUM(weight_kg)` over the batch's deliveries.
--   This is the definition every other price surface already uses (the rc_movement fed
--   price, the campaign views and view_rc_out_closed_blocks all recompute from
--   `deliveries.cost_basis` and say in their headers that avg_cost is stale), so this
--   makes the column agree with them instead of quietly contradicting them.
--
-- SCOPE — what this deliberately does NOT change:
--   `quality_stats` keeps its existing INSERT-only incremental formula, byte for byte.
--   It has the same shape of problem (weighted by a consumption-net `current_weight`,
--   never recomputed on UPDATE/DELETE) and is a candidate for the same treatment, but
--   it is a separate visible number and was not part of the authorisation. Reading
--   `target_batch` BEFORE the recompute is what keeps it identical: under AFTER the
--   `batches` row is still untouched at that point, so `target_batch.current_weight` is
--   the same pre-insert value the BEFORE trigger saw.
-- ============================================================================

-- ── The ONE definition of a batch's derived state ───────────────────────────
-- Idempotent by construction: it reads only base tables and writes only derived
-- columns, so running it twice is running it once. That is what makes the backfill
-- at the bottom of this migration safe to re-run.
CREATE OR REPLACE FUNCTION public.fn_recompute_batch_state(p_batch_code text)
RETURNS void
LANGUAGE sql
SET search_path TO 'public'
AS $$
    UPDATE batches SET
        current_weight = COALESCE((
            SELECT SUM(weight_kg) FROM deliveries WHERE batch_code = p_batch_code
        ), 0) - COALESCE((
            SELECT SUM(r.weight_kg) FROM rc_out r
            JOIN batches b2 ON r.batch_id = b2.id
            WHERE b2.batch_code = p_batch_code
        ), 0),
        -- BUG-018: delivery-weighted, the ONE definition. Consumption deliberately
        -- ignored — this answers "what did this batch's charcoal cost per kg".
        avg_cost = COALESCE((
            SELECT SUM(cost_basis * weight_kg) / NULLIF(SUM(weight_kg), 0)
            FROM deliveries WHERE batch_code = p_batch_code
        ), 0),
        updated_at = now()
    WHERE batch_code = p_batch_code;
$$;

COMMENT ON FUNCTION public.fn_recompute_batch_state(text) IS
  'Recompute batches.current_weight + batches.avg_cost for one batch_code from the base '
  'tables. The ONE definition of both columns (BUG-018, 2026-08-04): avg_cost is '
  'delivery-weighted, SUM(cost_basis*weight_kg)/SUM(weight_kg), matching every other price '
  'surface. Idempotent. Called by tr_blackwood_delivery (AFTER) and by the backfill.';

REVOKE EXECUTE ON FUNCTION public.fn_recompute_batch_state(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.fn_recompute_batch_state(text) TO service_role;

-- ── The trigger function, now AFTER ─────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.fn_update_blackwood_state()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $function$
DECLARE
    target_batch     RECORD;
    new_total_weight DECIMAL;
    added_weight     DECIMAL;
BEGIN
    -- ── DELETE ──────────────────────────────────────────────────────────────
    -- AFTER: the row is GONE. No `id <> OLD.id` needed — a plain aggregate is now
    -- simply true, which is the whole point of moving the timing.
    IF (TG_OP = 'DELETE') THEN
        PERFORM fn_recompute_batch_state(OLD.batch_code);

        -- Last delivery gone → the batch no longer occupies a location.
        IF NOT EXISTS (SELECT 1 FROM deliveries WHERE batch_code = OLD.batch_code) THEN
            UPDATE batches SET
                location_ref = '',
                status = 'STORED'::batch_status,
                updated_at = now()
            WHERE batch_code = OLD.batch_code;
        END IF;

        RETURN NULL;  -- AFTER triggers ignore the return value.
    END IF;

    -- ── UPDATE ──────────────────────────────────────────────────────────────
    IF (TG_OP = 'UPDATE') THEN
        IF (OLD.batch_code IS DISTINCT FROM NEW.batch_code) THEN
            -- BUG-017: the row has ALREADY moved, so both sides are true. The OLD
            -- batch no longer sees it; the NEW batch already does.
            PERFORM fn_recompute_batch_state(OLD.batch_code);
            PERFORM fn_recompute_batch_state(NEW.batch_code);

            -- The old batch may have just lost its last delivery.
            IF NOT EXISTS (SELECT 1 FROM deliveries WHERE batch_code = OLD.batch_code) THEN
                UPDATE batches SET
                    location_ref = '',
                    status = 'STORED'::batch_status,
                    updated_at = now()
                WHERE batch_code = OLD.batch_code;
            END IF;

            RETURN NULL;
        END IF;

        -- Same batch, changed numbers. Under AFTER the sub-select reads the NEW
        -- values; under BEFORE it read the OLD ones and recomputed to no change.
        IF (OLD.cost_basis IS DISTINCT FROM NEW.cost_basis)
           OR (OLD.weight_kg IS DISTINCT FROM NEW.weight_kg) THEN
            PERFORM fn_recompute_batch_state(NEW.batch_code);
        END IF;

        RETURN NULL;
    END IF;

    -- ── INSERT ──────────────────────────────────────────────────────────────
    added_weight := NEW.weight_kg;

    SELECT * INTO target_batch FROM batches WHERE batch_code = NEW.batch_code;

    IF NOT FOUND THEN
        -- Unreachable in practice: deliveries.batch_code carries FK fk_batch_code.
        -- Kept so the contract does not depend on the constraint staying put.
        RAISE EXCEPTION 'Batch Code % does not exist in the System Map.', NEW.batch_code;
    END IF;

    -- `quality_stats` — UNCHANGED (see the SCOPE note at the top). `target_batch` was
    -- read before the recompute below, so `current_weight` here is still the pre-insert
    -- value the BEFORE trigger used to see.
    new_total_weight := target_batch.current_weight + added_weight;
    IF new_total_weight > 0 THEN
        UPDATE batches SET
            quality_stats = jsonb_build_object(
                'bd',  ((COALESCE((target_batch.quality_stats->>'bd')::decimal, 0) * target_batch.current_weight)
                        + (COALESCE((NEW.lab_results->>'bd')::decimal, 0) * added_weight)) / new_total_weight,
                'ash', ((COALESCE((target_batch.quality_stats->>'ash')::decimal, 0) * target_batch.current_weight)
                        + (COALESCE((NEW.lab_results->>'ash')::decimal, 0) * added_weight)) / new_total_weight,
                'mc',  ((COALESCE((target_batch.quality_stats->>'mc')::decimal, 0) * target_batch.current_weight)
                        + (COALESCE((NEW.lab_results->>'mc')::decimal, 0) * added_weight)) / new_total_weight
            ),
            updated_at = now()
        WHERE batch_code = NEW.batch_code;
    END IF;

    -- BUG-018: recompute rather than blend. Runs unconditionally — the old code
    -- skipped the whole update when new_total_weight <= 0, which left avg_cost and
    -- current_weight untouched on a fully-consumed batch.
    PERFORM fn_recompute_batch_state(NEW.batch_code);

    -- SUNDRY batches upgrade STORED → SUNDRIED on their first delivery.
    IF NEW.batch_code ILIKE '%SUNDRY%' AND target_batch.status = 'STORED'::batch_status THEN
        UPDATE batches SET status = 'SUNDRIED'::batch_status, updated_at = now()
        WHERE batch_code = NEW.batch_code;
    END IF;

    RETURN NULL;
END;
$function$;

-- ── Re-point the trigger: BEFORE → AFTER ────────────────────────────────────
DROP TRIGGER IF EXISTS tr_blackwood_delivery ON public.deliveries;
CREATE TRIGGER tr_blackwood_delivery
    AFTER INSERT OR UPDATE OR DELETE ON public.deliveries
    FOR EACH ROW EXECUTE FUNCTION public.fn_update_blackwood_state();

-- ── Backfill ────────────────────────────────────────────────────────────────
-- Every batch, not just the drifted ones: the recompute is idempotent, so a batch
-- already correct is written with the values it already had. This repairs BOTH the
-- avg_cost definition change (216 of 693 batches disagreed) and any current_weight
-- left drifted by the BEFORE-trigger staleness above.
DO $$
DECLARE
    v_code text;
    v_count int := 0;
BEGIN
    FOR v_code IN SELECT batch_code FROM batches ORDER BY batch_code LOOP
        PERFORM fn_recompute_batch_state(v_code);
        v_count := v_count + 1;
    END LOOP;
    RAISE NOTICE 'fn_recompute_batch_state: recomputed % batches', v_count;
END $$;
