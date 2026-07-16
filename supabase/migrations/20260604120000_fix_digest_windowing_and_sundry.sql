-- =====================================================================
-- Daily Sync Digest — bug fixes (windowing + sundry exclusion)
-- =====================================================================
-- BUG 1 (CRITICAL): the daily series views were UNWINDOWED. view_digest_daily_flow
--   generated a calendar from the global min date (2020-07-01) → operational_date,
--   producing 2163 rows. PostgREST caps responses at 1000 rows (ascending), so the
--   client only ever saw 2020 → ~2023. The operational date (2026-06-02) fell off
--   the end, every KPI point-in-time read returned 0, and the charts flatlined.
--   Fix: window EVERY daily series view to a trailing range anchored to
--   operational_date (the max DATA date, since ingestion lags the calendar).
--   start_d = operational_date - 120 days. 120d guarantees < 1000 rows, always
--   includes operational_date AND prev_operational_date, and covers every
--   frontend window (flow 30d, price 30d, grades 14d, spark 14d).
--
-- BUG 2: RC In price must EXCLUDE sundried (own re-processing, theoretical
--   cost_basis) so it reflects the real market buying price. Introduces a
--   canonical, reusable view `view_supplier_deliveries` and rebuilds
--   view_digest_daily_price on top of it.
-- =====================================================================


-- ---------------------------------------------------------------------
-- CANONICAL: "deliveries that represent a market purchase from a supplier".
--   A real supplier delivery is one that:
--     - has a real (non-placeholder) price:  cost_basis > 0  (excludes L-008
--       gsheet placeholders that aren't priced yet), AND
--     - is NOT our own sundried re-processing material. Sundried rows carry a
--       THEORETICAL cost and must never pollute market-price averages.
--   Canonical sundried marker (verified):
--     batch_code ILIKE '%SUNDRY%' OR supplier ILIKE '%SUNDRY%'
--   (covers 'APRIL-26-SUNDRY3'-style batch codes AND the 'SUNDRY BACKLOG' supplier).
--
--   Reuse this view (or replicate its exact WHERE) anywhere you need a
--   "deliveries / market average" — do NOT replicate the predicate ad hoc.
--   This is SELECT * so it inherits every deliveries column (incl. lab_results).
-- ---------------------------------------------------------------------
CREATE OR REPLACE VIEW view_supplier_deliveries
WITH (security_invoker = true) AS
SELECT d.*
FROM deliveries d
WHERE d.cost_basis > 0
  AND d.batch_code NOT ILIKE '%SUNDRY%'
  AND COALESCE(d.supplier, '') NOT ILIKE '%SUNDRY%';

COMMENT ON VIEW view_supplier_deliveries IS
  'Canonical set of REAL market purchases from suppliers: deliveries with cost_basis > 0, '
  'EXCLUDING our own sundried re-processing (batch_code/supplier ILIKE ''%SUNDRY%''), which '
  'carries a theoretical cost_basis and must never pollute market-price averages. Build any '
  '"deliveries/market average price" on top of this view so the sundry exclusion is inherited.';

GRANT SELECT ON view_supplier_deliveries TO authenticated;


-- ---------------------------------------------------------------------
-- 2. Daily RC In vs RC Out (kg) — WINDOWED to trailing 120 days.
--    Keeps the zero-fill calendar so every day in the window is present
--    (continuous trailing series for FlowPoint[] + the flow sparks).
--    NOTE: PostgREST caps responses at 1000 rows. The 120-day window keeps
--    this view at ~121 rows — well under the cap. Any future daily series
--    view MUST stay windowed (or explicitly LIMIT) for the same reason.
-- ---------------------------------------------------------------------
CREATE OR REPLACE VIEW view_digest_daily_flow
WITH (security_invoker = true) AS
WITH bounds AS (
  SELECT
    ((SELECT operational_date FROM view_digest_operational_days) - INTERVAL '120 days')::date AS start_d,
    (SELECT operational_date FROM view_digest_operational_days) AS end_d
),
cal AS (
  SELECT gd::date AS d
  FROM bounds,
       generate_series(bounds.start_d, bounds.end_d, INTERVAL '1 day') AS gd
),
ins AS (
  SELECT transaction_date AS d, sum(weight_kg) AS kg
  FROM deliveries
  WHERE transaction_date >= (SELECT start_d FROM bounds)
  GROUP BY transaction_date
),
outs AS (
  SELECT transaction_date AS d, sum(weight_kg) AS kg
  FROM rc_out
  WHERE transaction_date >= (SELECT start_d FROM bounds)
  GROUP BY transaction_date
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
-- 3. Daily weighted-avg RC IN purchase price (₱/kg) — WINDOWED to trailing
--    120 days and sourced from view_supplier_deliveries, so it inherits the
--    cost_basis > 0 AND sundry-exclusion. Only emits days with at least one
--    real supplier delivery. Consumed by PricePoint[].
-- ---------------------------------------------------------------------
CREATE OR REPLACE VIEW view_digest_daily_price
WITH (security_invoker = true) AS
WITH bounds AS (
  SELECT ((SELECT operational_date FROM view_digest_operational_days) - INTERVAL '120 days')::date AS start_d
)
SELECT
  sd.transaction_date AS date,
  (sum(sd.weight_kg * sd.cost_basis) / NULLIF(sum(sd.weight_kg), 0))::numeric AS php_per_kg
FROM view_supplier_deliveries sd, bounds
WHERE sd.transaction_date >= bounds.start_d
GROUP BY sd.transaction_date
ORDER BY sd.transaction_date;

GRANT SELECT ON view_digest_daily_price TO authenticated;


-- ---------------------------------------------------------------------
-- 4. Daily total production output (kg) — WINDOWED to trailing 120 days.
-- ---------------------------------------------------------------------
CREATE OR REPLACE VIEW view_digest_daily_production
WITH (security_invoker = true) AS
WITH bounds AS (
  SELECT ((SELECT operational_date FROM view_digest_operational_days) - INTERVAL '120 days')::date AS start_d
)
SELECT
  ps.transaction_date AS date,
  sum(pr.ttl_kg)::numeric AS kg
FROM production_runs pr
JOIN production_shifts ps ON ps.id = pr.shift_id, bounds
WHERE ps.transaction_date >= bounds.start_d
GROUP BY ps.transaction_date
ORDER BY ps.transaction_date;

GRANT SELECT ON view_digest_daily_production TO authenticated;


-- ---------------------------------------------------------------------
-- 5. Daily total power consumption (kWh) — WINDOWED to trailing 120 days.
-- ---------------------------------------------------------------------
CREATE OR REPLACE VIEW view_digest_daily_power
WITH (security_invoker = true) AS
WITH bounds AS (
  SELECT ((SELECT operational_date FROM view_digest_operational_days) - INTERVAL '120 days')::date AS start_d
)
SELECT
  reading_date AS date,
  sum(consumption_kwh)::numeric AS kwh
FROM electricity_readings, bounds
WHERE reading_date >= bounds.start_d
GROUP BY reading_date
ORDER BY reading_date;

GRANT SELECT ON view_digest_daily_power TO authenticated;


-- ---------------------------------------------------------------------
-- 6. Daily production output by grade — WINDOWED to trailing 120 days.
-- ---------------------------------------------------------------------
CREATE OR REPLACE VIEW view_digest_grades
WITH (security_invoker = true) AS
WITH bounds AS (
  SELECT ((SELECT operational_date FROM view_digest_operational_days) - INTERVAL '120 days')::date AS start_d
)
SELECT
  ps.transaction_date AS date,
  pr.grade            AS grade,
  sum(pr.ttl_kg)::numeric AS kg
FROM production_runs pr
JOIN production_shifts ps ON ps.id = pr.shift_id, bounds
WHERE ps.transaction_date >= bounds.start_d
GROUP BY ps.transaction_date, pr.grade
ORDER BY ps.transaction_date, pr.grade;

GRANT SELECT ON view_digest_grades TO authenticated;
