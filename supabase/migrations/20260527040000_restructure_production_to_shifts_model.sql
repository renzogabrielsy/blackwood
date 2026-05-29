-- Migration: restructure_production_to_shifts_model
--
-- Introduces production_shifts as the parent table that normalizes the
-- (transaction_date, production_batch, shift) triplet shared by all 3 child
-- tables.  Every child row gets a shift_id FK; the 3 redundant columns are
-- then dropped.  Also drops the 7 SKS columns from production_waste (sacks
-- data was originally included for raw-capture but the design decision as of
-- 2026-05-28 is to drop them — they are text blobs with mixed types and are
-- not used in any view or aggregation).
--
-- All 1,411 existing backfilled rows (207 runs + 158 downtime + 158 waste +
-- 888 electricity + tracked by separate tables) are preserved in-place.
-- The child row counts after migration must equal the pre-migration counts.
--
-- Row counts verified pre-migration:
--   production_runs     : 207
--   production_downtime : 158
--   production_waste    : 158
--   Expected shifts     : 158  (distinct union of all 3 child (date,batch,shift))
--
-- Dependencies: migrations 010000, 010001, 020000, 030000 must already be applied.
-- Followed by   : 20260527040001_rewrite_view_production_daily.sql (rewrites the view)

BEGIN;

-- ============================================================
-- STEP 1 — Create parent table production_shifts
-- ============================================================
CREATE TABLE production_shifts (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  transaction_date date        NOT NULL,
  production_batch text        NOT NULL,
  shift            text        NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT production_shifts_natural_key
    UNIQUE (transaction_date, production_batch, shift),
  CONSTRAINT production_shifts_shift_check
    CHECK (shift IN ('M', 'E', 'N'))
);

CREATE INDEX idx_production_shifts_date
  ON production_shifts (transaction_date DESC);

COMMENT ON TABLE production_shifts IS
  'Parent table: one row per (transaction_date, production_batch, shift) triplet. '
  'production_runs, production_downtime, and production_waste all FK to this table '
  'via shift_id. Created 2026-05-28 during parent-child restructure.';

-- ============================================================
-- STEP 2 — Populate production_shifts from existing child data
--
-- UNION across all 3 tables so that even shifts that exist in only
-- one child table get a parent row.  UNION (not UNION ALL) deduplicates.
-- ============================================================
INSERT INTO production_shifts (transaction_date, production_batch, shift)
SELECT transaction_date, production_batch, shift FROM production_runs
UNION
SELECT transaction_date, production_batch, shift FROM production_downtime
UNION
SELECT transaction_date, production_batch, shift FROM production_waste;

-- Verify the insert landed the expected count (fails the transaction if wrong)
DO $$
DECLARE
  expected integer;
  actual   integer;
BEGIN
  SELECT COUNT(*) INTO expected FROM (
    SELECT transaction_date, production_batch, shift FROM production_runs
    UNION
    SELECT transaction_date, production_batch, shift FROM production_downtime
    UNION
    SELECT transaction_date, production_batch, shift FROM production_waste
  ) u;

  SELECT COUNT(*) INTO actual FROM production_shifts;

  IF actual <> expected THEN
    RAISE EXCEPTION
      'production_shifts row count mismatch: expected %, got %', expected, actual;
  END IF;
END $$;

-- ============================================================
-- STEP 3 — Add shift_id to production_runs (nullable first)
-- ============================================================
ALTER TABLE production_runs
  ADD COLUMN shift_id uuid REFERENCES production_shifts(id);

-- Populate shift_id for every existing row
UPDATE production_runs pr
SET    shift_id = ps.id
FROM   production_shifts ps
WHERE  ps.transaction_date  = pr.transaction_date
  AND  ps.production_batch  = pr.production_batch
  AND  ps.shift             = pr.shift;

-- Verify no runs rows are left without a shift_id
DO $$
DECLARE orphans integer;
BEGIN
  SELECT COUNT(*) INTO orphans FROM production_runs WHERE shift_id IS NULL;
  IF orphans > 0 THEN
    RAISE EXCEPTION
      'production_runs has % rows with NULL shift_id after update', orphans;
  END IF;
END $$;

-- Now enforce NOT NULL
ALTER TABLE production_runs
  ALTER COLUMN shift_id SET NOT NULL;

-- ============================================================
-- STEP 4 — Add shift_id to production_downtime
-- ============================================================
ALTER TABLE production_downtime
  ADD COLUMN shift_id uuid REFERENCES production_shifts(id);

UPDATE production_downtime pd
SET    shift_id = ps.id
FROM   production_shifts ps
WHERE  ps.transaction_date  = pd.transaction_date
  AND  ps.production_batch  = pd.production_batch
  AND  ps.shift             = pd.shift;

DO $$
DECLARE orphans integer;
BEGIN
  SELECT COUNT(*) INTO orphans FROM production_downtime WHERE shift_id IS NULL;
  IF orphans > 0 THEN
    RAISE EXCEPTION
      'production_downtime has % rows with NULL shift_id after update', orphans;
  END IF;
END $$;

ALTER TABLE production_downtime
  ALTER COLUMN shift_id SET NOT NULL;

-- ============================================================
-- STEP 5 — Add shift_id to production_waste
-- ============================================================
ALTER TABLE production_waste
  ADD COLUMN shift_id uuid REFERENCES production_shifts(id);

UPDATE production_waste pw
SET    shift_id = ps.id
FROM   production_shifts ps
WHERE  ps.transaction_date  = pw.transaction_date
  AND  ps.production_batch  = pw.production_batch
  AND  ps.shift             = pw.shift;

DO $$
DECLARE orphans integer;
BEGIN
  SELECT COUNT(*) INTO orphans FROM production_waste WHERE shift_id IS NULL;
  IF orphans > 0 THEN
    RAISE EXCEPTION
      'production_waste has % rows with NULL shift_id after update', orphans;
  END IF;
END $$;

ALTER TABLE production_waste
  ALTER COLUMN shift_id SET NOT NULL;

-- ============================================================
-- STEP 6 — Drop old natural-key constraints on child tables
--           and add new constraints keyed on shift_id.
-- ============================================================

-- production_runs: was UNIQUE(transaction_date, production_batch, customer, grade, shift)
-- new key: UNIQUE(shift_id, customer, grade)
ALTER TABLE production_runs
  DROP CONSTRAINT production_runs_natural_key;
ALTER TABLE production_runs
  ADD CONSTRAINT production_runs_natural_key
    UNIQUE (shift_id, customer, grade);

-- production_downtime: was UNIQUE(transaction_date, production_batch, shift)
-- new key: UNIQUE(shift_id) — exactly 1 downtime row per shift
ALTER TABLE production_downtime
  DROP CONSTRAINT production_downtime_natural_key;
ALTER TABLE production_downtime
  ADD CONSTRAINT production_downtime_natural_key
    UNIQUE (shift_id);

-- production_waste: was UNIQUE(transaction_date, production_batch, shift)
-- new key: UNIQUE(shift_id) — exactly 1 waste row per shift
ALTER TABLE production_waste
  DROP CONSTRAINT production_waste_natural_key;
ALTER TABLE production_waste
  ADD CONSTRAINT production_waste_natural_key
    UNIQUE (shift_id);

-- ============================================================
-- STEP 6b — Drop the view that depends on child table columns
--            being removed in step 7.  It is recreated with the
--            correct shift_id join in migration 040001.
-- ============================================================
DROP VIEW IF EXISTS view_production_daily;

-- ============================================================
-- STEP 7 — Drop redundant columns from child tables
--           (transaction_date, production_batch, shift)
-- ============================================================

-- production_runs
ALTER TABLE production_runs
  DROP COLUMN transaction_date,
  DROP COLUMN production_batch,
  DROP COLUMN shift;

-- production_downtime
ALTER TABLE production_downtime
  DROP COLUMN transaction_date,
  DROP COLUMN production_batch,
  DROP COLUMN shift;

-- production_waste
ALTER TABLE production_waste
  DROP COLUMN transaction_date,
  DROP COLUMN production_batch,
  DROP COLUMN shift;

-- ============================================================
-- STEP 8 — Drop SKS columns from production_waste (7 columns)
--           Design decision 2026-05-28: sacks counts are mixed-type
--           text blobs not used in any aggregation or view.
--           Raw values were captured during MASTER backfill;
--           they are intentionally discarded in this restructure.
-- ============================================================
ALTER TABLE production_waste
  DROP COLUMN rs1a_sacks,
  DROP COLUMN rs1b_sacks,
  DROP COLUMN bf_sacks,
  DROP COLUMN rs23_sacks,
  DROP COLUMN rs5_sacks,
  DROP COLUMN trml1_sacks,
  DROP COLUMN trml2_sacks;

-- ============================================================
-- STEP 9 — Add FK index on shift_id for query performance
-- ============================================================
CREATE INDEX idx_production_runs_shift_id
  ON production_runs (shift_id);

CREATE INDEX idx_production_downtime_shift_id
  ON production_downtime (shift_id);

CREATE INDEX idx_production_waste_shift_id
  ON production_waste (shift_id);

-- ============================================================
-- STEP 10 — Drop the old date-based indexes (no longer needed;
--            queries now drive through production_shifts which
--            has its own idx_production_shifts_date index)
-- ============================================================
DROP INDEX IF EXISTS idx_production_runs_date;
DROP INDEX IF EXISTS idx_production_downtime_date;
DROP INDEX IF EXISTS idx_production_waste_date;

-- ============================================================
-- STEP 11 — Grant SELECT on new parent table to authenticated role
-- ============================================================
GRANT SELECT ON TABLE production_shifts TO authenticated;
GRANT INSERT, UPDATE, DELETE ON TABLE production_shifts TO authenticated;

-- ============================================================
-- STEP 12 — Final row count verification
-- ============================================================
DO $$
DECLARE
  v_runs     integer;
  v_downtime integer;
  v_waste    integer;
BEGIN
  SELECT COUNT(*) INTO v_runs     FROM production_runs;
  SELECT COUNT(*) INTO v_downtime FROM production_downtime;
  SELECT COUNT(*) INTO v_waste    FROM production_waste;

  -- Guard: must match pre-migration counts
  IF v_runs <> 207 THEN
    RAISE EXCEPTION
      'production_runs final count mismatch: expected 207, got %', v_runs;
  END IF;
  IF v_downtime <> 158 THEN
    RAISE EXCEPTION
      'production_downtime final count mismatch: expected 158, got %', v_downtime;
  END IF;
  IF v_waste <> 158 THEN
    RAISE EXCEPTION
      'production_waste final count mismatch: expected 158, got %', v_waste;
  END IF;

  RAISE NOTICE 'Row count verification passed: runs=%, downtime=%, waste=%',
    v_runs, v_downtime, v_waste;
END $$;

COMMIT;
