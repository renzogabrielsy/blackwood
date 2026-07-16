-- Rework electricity_readings to reflect the TRUE source-email semantics.
--
-- Context (verified 2026-05-29 against the live MC Daily Production Report email,
-- PRODUCTION_DESIGN.md §15.2 Section D + §15.5):
--   The `120` was backfilled as `rate_php_per_kwh` under the WRONG assumption that
--   it was a peso-per-kWh price. The source email actually labels it a
--   "METER MULTIPLIER" and computes:  CONSUMPTION (KWH) = (PRESENT - PREVIOUS) * 120.
--   There is NO peso cost anywhere in the source data.
--
-- This migration:
--   1. Renames rate_php_per_kwh -> meter_multiplier (keeps NOT NULL DEFAULT 120 + values).
--   2. Renames the dependent CHECK constraint to match.
--   3. Drops view_electricity_monthly (it referenced rate_php_per_kwh and computed a
--      bogus month_ttl_php peso total; the monthly-summary UI was removed May 2026 and
--      nothing in the app queries this view — confirmed via repo grep +
--      electricity/CONTEXT.md note).
--   4. Adds a generated stored column consumption_kwh = (end_kwh - start_kwh) * meter_multiplier.
--      NOTE: it is defined against the BASE columns, NOT against diff_kwh — Postgres does
--      not allow a generated column to reference another generated column.
--
-- DB stores RAW meter readings + the 120 factor, so consumption_kwh recomputes for every
-- existing row automatically; no row rewrite / backfill needed.

-- 1. Rename the misnamed column. This auto-preserves NOT NULL, DEFAULT 120, and all
--    existing values, and auto-rewrites the dependent CHECK expression to reference
--    the new column name.
ALTER TABLE public.electricity_readings
  RENAME COLUMN rate_php_per_kwh TO meter_multiplier;

-- 2. Rename the CHECK constraint so its name matches the new column (the expression was
--    already auto-rewritten by the column rename above; this is cosmetic but keeps the
--    catalog consistent and avoids a stale "rate_php_per_kwh" name lingering).
ALTER TABLE public.electricity_readings
  RENAME CONSTRAINT electricity_readings_rate_php_per_kwh_check
  TO electricity_readings_meter_multiplier_check;

-- 3. Drop the dead monthly view. It references the old column name and computes a
--    meaningless peso total. The monthly-summary UI was removed; no code queries it.
DROP VIEW IF EXISTS public.view_electricity_monthly;

-- 4. Add the real consumption column as a generated stored column, defined against the
--    BASE columns (NOT diff_kwh, which is itself generated — Postgres forbids referencing
--    a generated column from another generated column).
ALTER TABLE public.electricity_readings
  ADD COLUMN consumption_kwh numeric
  GENERATED ALWAYS AS ((end_kwh - start_kwh) * meter_multiplier) STORED;
