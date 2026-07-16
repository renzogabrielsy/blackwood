-- view_digest_daily_hours — worked hours + downtime hours per production day.
-- Feeds TWO Home Digest features:
--   (1) a daily hours table beside the Production-by-grade chart, and
--   (2) actualHrs on the schedule-preview / week-plan slices (join by date).
--
-- Aggregation stays in SQL (HARD RULE), never a TypeScript reduction:
--   work_hrs     = SUM(production_downtime.shift_hrs)   across the date's shifts
--   downtime_hrs = SUM(dt_hrs + dt_mins/60.0)           across the date's shifts
-- One downtime row per shift, so summing across shifts gives the daily total.
--
-- WINDOWED to a trailing ~120 days (anchored to the operational date) exactly
-- like the sibling view_digest_daily_* views, so the row count stays far under
-- PostgREST's 1000-row response cap. Rest / no-production days simply have no
-- row.  Idempotent.
CREATE OR REPLACE VIEW public.view_digest_daily_hours
WITH (security_invoker = true) AS
  WITH bounds AS (
    SELECT ((( SELECT operational_date
                 FROM view_digest_operational_days )) - '120 days'::interval)::date AS start_d
  )
  SELECT s.transaction_date AS date,
         sum(d.shift_hrs) AS work_hrs,
         sum(d.dt_hrs + d.dt_mins / 60.0) AS downtime_hrs
    FROM production_downtime d
    JOIN production_shifts s ON s.id = d.shift_id,
         bounds
   WHERE s.transaction_date >= bounds.start_d
   GROUP BY s.transaction_date
   ORDER BY s.transaction_date;

-- Reporting view: authenticated reads; anon has no data access (RLS posture).
GRANT SELECT ON public.view_digest_daily_hours TO authenticated;
REVOKE ALL ON public.view_digest_daily_hours FROM anon;
