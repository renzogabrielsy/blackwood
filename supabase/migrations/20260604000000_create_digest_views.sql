-- =====================================================================
-- Daily Sync Digest — backend data layer (SQL VIEWS)
-- =====================================================================
-- ALL aggregation lives here (HARD RULE: never aggregate in TypeScript).
-- The query layer (lib/digest/queries.ts) only shapes these rows into
-- the contract types in lib/digest/types.ts.
--
-- "operationalDate" = latest business day with ANY operational data
-- across deliveries / rc_out / production_shifts / electricity_readings.
-- It is NOT today's calendar date — ingestion lags by a few days.
--
-- All views are SECURITY INVOKER (Postgres default for views) so they
-- inherit RLS from the underlying tables. SELECT granted to authenticated.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 0. The single source of truth for "operational date" + its prior day.
--    Returns one row: { operational_date, prev_operational_date }.
--    prev = the most recent day BEFORE operational_date that itself has
--    operational data (NOT operational_date - 1).
-- ---------------------------------------------------------------------
CREATE OR REPLACE VIEW view_digest_operational_days
WITH (security_invoker = true) AS
WITH days AS (
  SELECT transaction_date AS d FROM deliveries
  UNION
  SELECT transaction_date FROM rc_out
  UNION
  SELECT transaction_date FROM production_shifts
  UNION
  SELECT reading_date FROM electricity_readings
),
ranked AS (
  SELECT d, ROW_NUMBER() OVER (ORDER BY d DESC) AS rn
  FROM days
  WHERE d IS NOT NULL
)
SELECT
  (SELECT d FROM ranked WHERE rn = 1) AS operational_date,
  (SELECT d FROM ranked WHERE rn = 2) AS prev_operational_date;

GRANT SELECT ON view_digest_operational_days TO authenticated;


-- ---------------------------------------------------------------------
-- 1. Per-stream "current through" — latest business date per stream.
--    Consumed by DigestMeta.streams (StreamFreshness[]).
-- ---------------------------------------------------------------------
CREATE OR REPLACE VIEW view_digest_stream_freshness
WITH (security_invoker = true) AS
SELECT 'deliveries'::text  AS stream, 'RC In (deliveries)'::text AS label,
       max(transaction_date) AS through_date FROM deliveries
UNION ALL
SELECT 'rc_out', 'RC Out (usage)', max(transaction_date) FROM rc_out
UNION ALL
SELECT 'production', 'Production', max(transaction_date) FROM production_shifts
UNION ALL
SELECT 'electricity', 'Electricity', max(reading_date) FROM electricity_readings
UNION ALL
SELECT 'trucks', 'Trucks', max(reading_date) FROM truck_readings;

GRANT SELECT ON view_digest_stream_freshness TO authenticated;


-- ---------------------------------------------------------------------
-- 2. Daily RC In vs RC Out (kg) — full calendar series with zero days,
--    so the frontend gets a continuous trailing window. The query layer
--    slices the trailing N days; we generate from the earliest activity
--    to the operational date so no day is missing.
--    Consumed by FlowPoint[] AND by the rc_in/rc_out/net_flow sparks.
-- ---------------------------------------------------------------------
CREATE OR REPLACE VIEW view_digest_daily_flow
WITH (security_invoker = true) AS
WITH bounds AS (
  SELECT
    LEAST(
      (SELECT min(transaction_date) FROM deliveries),
      (SELECT min(transaction_date) FROM rc_out)
    ) AS start_d,
    (SELECT operational_date FROM view_digest_operational_days) AS end_d
),
cal AS (
  SELECT gd::date AS d
  FROM bounds,
       generate_series(bounds.start_d, bounds.end_d, INTERVAL '1 day') AS gd
),
ins AS (
  SELECT transaction_date AS d, sum(weight_kg) AS kg
  FROM deliveries GROUP BY transaction_date
),
outs AS (
  SELECT transaction_date AS d, sum(weight_kg) AS kg
  FROM rc_out GROUP BY transaction_date
)
SELECT
  cal.d                              AS date,
  COALESCE(ins.kg, 0)::numeric       AS in_kg,
  COALESCE(outs.kg, 0)::numeric      AS out_kg
FROM cal
LEFT JOIN ins  ON ins.d  = cal.d
LEFT JOIN outs ON outs.d = cal.d
ORDER BY cal.d;

GRANT SELECT ON view_digest_daily_flow TO authenticated;


-- ---------------------------------------------------------------------
-- 3. Daily weighted-avg RC IN purchase price (₱/kg).
--    EXCLUDES cost_basis = 0 rows (L-008 gsheet placeholders not yet
--    priced — they would drag the weighted average toward 0).
--    Only emits days that have at least one priced delivery.
--    Consumed by PricePoint[].
-- ---------------------------------------------------------------------
CREATE OR REPLACE VIEW view_digest_daily_price
WITH (security_invoker = true) AS
SELECT
  transaction_date AS date,
  (sum(weight_kg * cost_basis) / NULLIF(sum(weight_kg), 0))::numeric AS php_per_kg
FROM deliveries
WHERE cost_basis > 0
GROUP BY transaction_date
ORDER BY transaction_date;

GRANT SELECT ON view_digest_daily_price TO authenticated;


-- ---------------------------------------------------------------------
-- 4. Daily total production output (kg) — sum of production_runs.ttl_kg
--    joined to the parent shift's transaction_date.
--    Consumed by the production KPI value + spark.
-- ---------------------------------------------------------------------
CREATE OR REPLACE VIEW view_digest_daily_production
WITH (security_invoker = true) AS
SELECT
  ps.transaction_date AS date,
  sum(pr.ttl_kg)::numeric AS kg
FROM production_runs pr
JOIN production_shifts ps ON ps.id = pr.shift_id
GROUP BY ps.transaction_date
ORDER BY ps.transaction_date;

GRANT SELECT ON view_digest_daily_production TO authenticated;


-- ---------------------------------------------------------------------
-- 5. Daily total power consumption (kWh).
--    Consumed by the power KPI value + spark.
-- ---------------------------------------------------------------------
CREATE OR REPLACE VIEW view_digest_daily_power
WITH (security_invoker = true) AS
SELECT
  reading_date AS date,
  sum(consumption_kwh)::numeric AS kwh
FROM electricity_readings
GROUP BY reading_date
ORDER BY reading_date;

GRANT SELECT ON view_digest_daily_power TO authenticated;


-- ---------------------------------------------------------------------
-- 6. Daily production output by grade (stacked-bar source).
--    Consumed by GradePoint[].
-- ---------------------------------------------------------------------
CREATE OR REPLACE VIEW view_digest_grades
WITH (security_invoker = true) AS
SELECT
  ps.transaction_date AS date,
  pr.grade            AS grade,
  sum(pr.ttl_kg)::numeric AS kg
FROM production_runs pr
JOIN production_shifts ps ON ps.id = pr.shift_id
GROUP BY ps.transaction_date, pr.grade
ORDER BY ps.transaction_date, pr.grade;

GRANT SELECT ON view_digest_grades TO authenticated;


-- ---------------------------------------------------------------------
-- 7. Month-to-date roll-up for the OPERATIONAL month (the calendar month
--    of operational_date — NOT today's month, since data lags).
--    One row. Consumed by MonthToDate.
-- ---------------------------------------------------------------------
CREATE OR REPLACE VIEW view_digest_mtd
WITH (security_invoker = true) AS
WITH od AS (
  SELECT operational_date AS d FROM view_digest_operational_days
),
bounds AS (
  SELECT date_trunc('month', d)::date AS month_start, d AS month_end FROM od
)
SELECT
  to_char((SELECT month_start FROM bounds), 'FMMonth YYYY') AS label,
  (SELECT month_start FROM bounds) AS month_start,
  (SELECT month_end   FROM bounds) AS month_end,
  COALESCE((
    SELECT sum(weight_kg) FROM deliveries, bounds
    WHERE transaction_date BETWEEN bounds.month_start AND bounds.month_end
  ), 0)::numeric AS rc_in_kg,
  COALESCE((
    SELECT sum(weight_kg) FROM rc_out, bounds
    WHERE transaction_date BETWEEN bounds.month_start AND bounds.month_end
  ), 0)::numeric AS rc_out_kg,
  COALESCE((
    SELECT sum(pr.ttl_kg)
    FROM production_runs pr
    JOIN production_shifts ps ON ps.id = pr.shift_id, bounds
    WHERE ps.transaction_date BETWEEN bounds.month_start AND bounds.month_end
  ), 0)::numeric AS production_kg;

GRANT SELECT ON view_digest_mtd TO authenticated;


-- ---------------------------------------------------------------------
-- 8. Audit log enriched with parsed employee + provenance.
--    Parsing rules (priority order):
--      employee:
--        - "Deliveries Manager" in comment            -> deliveries-manager
--        - "Production Manager" / table is production* -> production-manager
--        - "rc-out-manager" / "RC Out Manager"         -> rc-out-manager
--        - "gsheet-sync" in comment                    -> gsheet-sync
--        - provenance=gsheet (and none of the above)   -> gsheet-sync
--        - else                                        -> other
--      provenance:
--        - regexp_match on 'provenance=(\w+)'          -> e.g. "gsheet"
--        - else null
--    Note: named-employee match is checked BEFORE the bare provenance
--    fallback so a "Price enrichment by Deliveries Manager ... gsheet"
--    comment is attributed to deliveries-manager, not gsheet-sync.
--    Consumed by SyncRun.byEmployee, latestSync, and ActivityItem.
-- ---------------------------------------------------------------------
CREATE OR REPLACE VIEW view_digest_audit_enriched
WITH (security_invoker = true) AS
SELECT
  a.id,
  a.table_name,
  a.operation,
  a.diff,
  a.comment,
  a.performed_at,
  (a.performed_at AT TIME ZONE 'UTC')::date AS performed_day,
  CASE
    WHEN a.comment ILIKE '%Deliveries Manager%' THEN 'deliveries-manager'
    WHEN a.comment ILIKE '%Production Manager%'
      OR a.table_name LIKE 'production%'
      OR a.table_name IN ('electricity_readings', 'truck_readings')
      THEN 'production-manager'
    WHEN a.comment ILIKE '%rc-out-manager%' OR a.comment ILIKE '%RC Out Manager%'
      THEN 'rc-out-manager'
    WHEN a.comment ILIKE '%gsheet-sync%' THEN 'gsheet-sync'
    WHEN a.comment ILIKE 'provenance=gsheet%' OR a.comment ILIKE '%provenance=gsheet%'
      THEN 'gsheet-sync'
    ELSE 'other'
  END AS employee,
  (regexp_match(a.comment, 'provenance=([A-Za-z0-9_-]+)'))[1] AS provenance
FROM audit_logs a;

GRANT SELECT ON view_digest_audit_enriched TO authenticated;


-- ---------------------------------------------------------------------
-- 9. Latest sync run summary — for the most recent performed-at day,
--    insert/update/delete counts. byEmployee is shaped in the query
--    layer from view_digest_audit_enriched (cheap GROUP BY in TS-light
--    is avoided; we expose the per-employee counts here directly).
--    One row per (latest day) — totals.
-- ---------------------------------------------------------------------
CREATE OR REPLACE VIEW view_digest_latest_sync
WITH (security_invoker = true) AS
WITH latest AS (
  SELECT max(performed_day) AS d FROM view_digest_audit_enriched
)
SELECT
  e.performed_day AS date,
  count(*) FILTER (WHERE e.operation = 'INSERT')::int AS insert_count,
  count(*) FILTER (WHERE e.operation = 'UPDATE')::int AS update_count,
  count(*) FILTER (WHERE e.operation = 'DELETE')::int AS delete_count
FROM view_digest_audit_enriched e, latest
WHERE e.performed_day = latest.d
GROUP BY e.performed_day;

GRANT SELECT ON view_digest_latest_sync TO authenticated;


-- ---------------------------------------------------------------------
-- 10. Latest sync run per-employee breakdown — SyncEmployeeStat[] source.
-- ---------------------------------------------------------------------
CREATE OR REPLACE VIEW view_digest_latest_sync_by_employee
WITH (security_invoker = true) AS
WITH latest AS (
  SELECT max(performed_day) AS d FROM view_digest_audit_enriched
)
SELECT
  e.performed_day AS date,
  e.employee      AS employee,
  count(*)::int   AS count
FROM view_digest_audit_enriched e, latest
WHERE e.performed_day = latest.d
GROUP BY e.performed_day, e.employee
ORDER BY count(*) DESC;

GRANT SELECT ON view_digest_latest_sync_by_employee TO authenticated;


-- ---------------------------------------------------------------------
-- 11. RC IN per-day supplier + sack counts (for the rc_in KPI sub-line).
--     Consumed by DigestKpi.sub for rc_in.
-- ---------------------------------------------------------------------
CREATE OR REPLACE VIEW view_digest_rcin_daystats
WITH (security_invoker = true) AS
SELECT
  transaction_date AS date,
  count(DISTINCT supplier)::int AS suppliers,
  COALESCE(sum(sacks), 0)::int  AS sacks
FROM deliveries
GROUP BY transaction_date;

GRANT SELECT ON view_digest_rcin_daystats TO authenticated;


-- ---------------------------------------------------------------------
-- 12. Count of unpriced deliveries (cost_basis = 0) within the trailing
--     30 days of the OPERATIONAL date (L-008 gsheet placeholders not yet
--     priced). One row: { cnt }. Consumed by the missing_price flag.
-- ---------------------------------------------------------------------
CREATE OR REPLACE VIEW view_digest_unpriced_recent
WITH (security_invoker = true) AS
WITH od AS (
  SELECT operational_date AS d FROM view_digest_operational_days
)
SELECT count(*)::int AS cnt
FROM deliveries, od
WHERE cost_basis = 0
  AND transaction_date >= (od.d - INTERVAL '30 days')
  AND transaction_date <= od.d;

GRANT SELECT ON view_digest_unpriced_recent TO authenticated;
