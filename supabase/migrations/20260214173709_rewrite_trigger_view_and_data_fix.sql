-- Migration: Rewrite STATE Column — Derive from RC OUT Data
-- Phase 1b: Rewrite trigger, update view, fix existing data

-- 1b. Rewrite fn_process_blackwood_usage to handle INSERT, UPDATE, DELETE
CREATE OR REPLACE FUNCTION fn_process_blackwood_usage()
RETURNS trigger
LANGUAGE plpgsql
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

        -- Copy block_loc from batch if not provided
        NEW.block_loc := COALESCE(NEW.block_loc, batch_rec.location_ref);

        -- Determine status (optimized — just check new row)
        new_status := CASE
            WHEN batch_rec.batch_code ILIKE '%FEED%' THEN 'FEED'::batch_status
            WHEN NEW.destination = 'MAIN' AND NEW.remarks ILIKE '%CLOSED%' THEN 'CLOSED'::batch_status
            WHEN NEW.destination = 'SUNDRY' THEN 'SUNDRYING'::batch_status
            WHEN NEW.destination = 'MAIN' THEN 'IN-USE'::batch_status
            ELSE batch_rec.status  -- Preserve existing status if no clear state
        END;

        -- Deplete weight and update status
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

        -- Add weight back
        UPDATE batches SET
            current_weight = current_weight + OLD.weight_kg,
            updated_at = now()
        WHERE id = OLD.batch_id;

        -- Recalculate status from remaining rc_out records
        SELECT
            EXISTS (SELECT 1 FROM rc_out WHERE batch_id = OLD.batch_id AND id != OLD.id AND remarks ILIKE '%CLOSED%') INTO has_closed;
        SELECT
            EXISTS (SELECT 1 FROM rc_out WHERE batch_id = OLD.batch_id AND id != OLD.id AND destination = 'SUNDRY') INTO has_sundrying;
        SELECT
            EXISTS (SELECT 1 FROM rc_out WHERE batch_id = OLD.batch_id AND id != OLD.id AND destination = 'MAIN') INTO has_main;

        -- Priority: FEED > CLOSED > SUNDRYING > IN-USE > STORED
        new_status := CASE
            WHEN batch_rec.batch_code ILIKE '%FEED%' THEN 'FEED'::batch_status
            WHEN has_closed THEN 'CLOSED'::batch_status
            WHEN has_sundrying THEN 'SUNDRYING'::batch_status
            WHEN has_main THEN 'IN-USE'::batch_status
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

        -- Copy block_loc for NEW
        NEW.block_loc := COALESCE(NEW.block_loc, batch_rec.location_ref);

        -- Adjust weight delta
        UPDATE batches SET
            current_weight = current_weight + OLD.weight_kg - NEW.weight_kg,
            updated_at = now()
        WHERE id = NEW.batch_id;

        -- Recalculate status from all rc_out records (exclude old version, include new)
        SELECT
            EXISTS (
                SELECT 1 FROM rc_out
                WHERE batch_id = NEW.batch_id AND id != NEW.id AND remarks ILIKE '%CLOSED%'
                UNION ALL
                SELECT 1 WHERE NEW.remarks ILIKE '%CLOSED%'
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

        -- Priority: FEED > CLOSED > SUNDRYING > IN-USE > STORED
        new_status := CASE
            WHEN batch_rec.batch_code ILIKE '%FEED%' THEN 'FEED'::batch_status
            WHEN has_closed THEN 'CLOSED'::batch_status
            WHEN has_sundrying THEN 'SUNDRYING'::batch_status
            WHEN has_main THEN 'IN-USE'::batch_status
            ELSE 'STORED'::batch_status
        END;

        UPDATE batches SET
            status = new_status,
            updated_at = now()
        WHERE id = NEW.batch_id;

        -- If batch_id changed, recalculate OLD batch too
        IF OLD.batch_id != NEW.batch_id THEN
            SELECT * INTO old_batch_rec FROM batches WHERE id = OLD.batch_id;

            -- Add weight back to old batch
            UPDATE batches SET
                current_weight = current_weight + OLD.weight_kg,
                updated_at = now()
            WHERE id = OLD.batch_id;

            -- Recalculate old batch status
            SELECT
                EXISTS (SELECT 1 FROM rc_out WHERE batch_id = OLD.batch_id AND id != OLD.id AND remarks ILIKE '%CLOSED%') INTO has_closed;
            SELECT
                EXISTS (SELECT 1 FROM rc_out WHERE batch_id = OLD.batch_id AND id != OLD.id AND destination = 'SUNDRY') INTO has_sundrying;
            SELECT
                EXISTS (SELECT 1 FROM rc_out WHERE batch_id = OLD.batch_id AND id != OLD.id AND destination = 'MAIN') INTO has_main;

            new_status := CASE
                WHEN old_batch_rec.batch_code ILIKE '%FEED%' THEN 'FEED'::batch_status
                WHEN has_closed THEN 'CLOSED'::batch_status
                WHEN has_sundrying THEN 'SUNDRYING'::batch_status
                WHEN has_main THEN 'IN-USE'::batch_status
                ELSE 'STORED'::batch_status
            END;

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

-- Update trigger to handle all operations (DROP and CREATE to avoid IF EXISTS issues)
DROP TRIGGER IF EXISTS tr_blackwood_usage ON rc_out;
CREATE TRIGGER tr_blackwood_usage
    BEFORE INSERT OR UPDATE OR DELETE ON rc_out
    FOR EACH ROW EXECUTE FUNCTION fn_process_blackwood_usage();

-- 1c. Update view_rc_in_master to include batch status
CREATE OR REPLACE VIEW view_rc_in_master AS
SELECT
    d.id,
    d.transaction_date,
    d.supplier,
    d.truck_plate,
    d.weight_kg,
    d.cost_basis,
    d.lab_results,
    d.created_at,
    d.batch_code,
    d.remarks,
    d.sacks,
    b.location_ref AS block_loc,
    b.status AS state
FROM deliveries d
LEFT JOIN batches b ON d.batch_code = b.batch_code;

-- 1d. One-time data migration — fix existing batch statuses
-- This recalculates status for all batches based on current rc_out data
UPDATE batches b SET status = CASE
    WHEN b.batch_code ILIKE '%FEED%' THEN 'FEED'::batch_status
    WHEN EXISTS (
        SELECT 1 FROM rc_out r
        WHERE r.batch_id = b.id
        AND r.destination = 'MAIN'
        AND r.remarks ILIKE '%CLOSED%'
    ) THEN 'CLOSED'::batch_status
    WHEN EXISTS (
        SELECT 1 FROM rc_out r
        WHERE r.batch_id = b.id
        AND r.destination = 'SUNDRY'
    ) THEN 'SUNDRYING'::batch_status
    WHEN EXISTS (
        SELECT 1 FROM rc_out r
        WHERE r.batch_id = b.id
        AND r.destination = 'MAIN'
    ) THEN 'IN-USE'::batch_status
    ELSE 'STORED'::batch_status
END;
