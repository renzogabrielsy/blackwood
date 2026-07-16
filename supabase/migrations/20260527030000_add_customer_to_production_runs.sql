-- Add customer column to production_runs so KURARAY / CEBU / future customers
-- can coexist on the same (date, batch, grade, shift).
--
-- Context (2026-05-27): The original design assumed "CEBU is implicit" — all
-- finished production went to the Cebu sister plant. The MASTER backfill
-- surfaced a real-world KURARAY customer event on 2026-04-16 where KURARAY
-- 3X50 ended (21,240 kg) and CEBU 3X50 started (1,690 kg) in the same morning
-- shift. Same (date, production_batch, grade, shift) for both — only customer
-- differs. The implicit-CEBU assumption no longer holds.
--
-- Default 'CEBU' preserves the semantics of the 100 already-inserted rows.

ALTER TABLE production_runs ADD COLUMN customer text NOT NULL DEFAULT 'CEBU';

-- Drop the old natural-key constraint (verified name via pg_constraint)
ALTER TABLE production_runs DROP CONSTRAINT production_runs_natural_key;

-- Add new natural key including customer
ALTER TABLE production_runs ADD CONSTRAINT production_runs_natural_key
  UNIQUE (transaction_date, production_batch, customer, grade, shift);

-- Index for typical filtering
CREATE INDEX IF NOT EXISTS idx_production_runs_customer ON production_runs (customer);
