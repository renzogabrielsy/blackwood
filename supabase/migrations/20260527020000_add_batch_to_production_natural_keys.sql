-- Add production_batch to natural keys for production_runs / downtime / waste.
--
-- Rationale: MASTER's PROD sheet records same-day batch crossover events
-- (e.g., end-of-month JANUARY production overlapping with start-of-month
-- FEBRUARY on 2026-02-02, or KURARAY-customer 3X50 ending and CEBU-customer
-- 3X50 starting on 2026-04-16). The v1 natural keys
-- (transaction_date, grade, shift) and (transaction_date, shift) could not
-- represent these collisions, blocking the MASTER backfill on 2026-05-27.
--
-- Real constraint names verified via pg_constraint before drop.

-- production_runs: was UNIQUE(transaction_date, grade, shift)
ALTER TABLE production_runs DROP CONSTRAINT IF EXISTS production_runs_natural_key;
ALTER TABLE production_runs ADD CONSTRAINT production_runs_natural_key
  UNIQUE (transaction_date, production_batch, grade, shift);

-- production_downtime: was UNIQUE(transaction_date, shift)
ALTER TABLE production_downtime DROP CONSTRAINT IF EXISTS production_downtime_natural_key;
ALTER TABLE production_downtime ADD CONSTRAINT production_downtime_natural_key
  UNIQUE (transaction_date, production_batch, shift);

-- production_waste: was UNIQUE(transaction_date, shift)
ALTER TABLE production_waste DROP CONSTRAINT IF EXISTS production_waste_natural_key;
ALTER TABLE production_waste ADD CONSTRAINT production_waste_natural_key
  UNIQUE (transaction_date, production_batch, shift);
