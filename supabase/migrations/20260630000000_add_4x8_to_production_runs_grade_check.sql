-- Add '4X8' to the production_runs.grade CHECK constraint allowlist.
--
-- Context (2026-06-30): 4X8 is a real finished grade that MC writes verbatim as
-- "4X8" (e.g. "CEBU 4X8") in the Daily Production Report. It was silently dropped
-- from production_runs on every sync because it was absent from BOTH gates a grade
-- value must pass: (1) the extractor's VALID_GRADES allowlist in
-- extract_daily_production.py, and (2) this DB CHECK constraint. The extractor side
-- was fixed separately; this migration fixes the DB side.
--
-- The constraint goes from a 4-element to a 5-element array:
--   ['3X50','6X50','8X50','2X6']  ->  ['3X50','6X50','8X50','2X6','4X8']
--
-- `grade` stays text; no type change, no data rewrite. Drop-and-re-add (idempotent
-- via IF EXISTS) because Postgres has no ALTER ... ALTER CONSTRAINT for CHECK defs.
-- See LEARNING_LEDGER.md L-027 and PRODUCTION_DESIGN.md.

ALTER TABLE production_runs
  DROP CONSTRAINT IF EXISTS production_runs_grade_check;

ALTER TABLE production_runs
  ADD CONSTRAINT production_runs_grade_check
  CHECK (grade = ANY (ARRAY['3X50', '6X50', '8X50', '2X6', '4X8']));
