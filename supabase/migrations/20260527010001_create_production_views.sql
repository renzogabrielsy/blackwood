-- Migration: create_production_views
-- Creates 3 views for the Production module and grants access.
-- Depends on: 20260527010000_create_production_tables

-- ============================================================
-- 1. view_production_daily
--    Reconciliation view joining all 3 production tables on
--    (transaction_date, shift). Uses FULL OUTER JOIN so a row
--    appears even if only one of the three sub-tables has data
--    for that (date, shift) pair.
--
--    Computed columns:
--      - kg_3x50 / kg_6x50 / kg_8x50 / kg_2x6  (FILTER pivots)
--      - total_output_kg
--      - dt_total_hrs    = dt_hrs + dt_mins / 60
--      - productive_hrs  = shift_hrs - dt_total_hrs
--      - total_waste_kg  = sum of all 8 streams
--      - prod_loss_pct   = total_waste_kg / (total_output_kg + total_waste_kg)
-- ============================================================
CREATE OR REPLACE VIEW view_production_daily AS
WITH
-- Aggregate production_runs per (date, shift) — multiple grade rows collapse here
runs_agg AS (
  SELECT
    transaction_date,
    shift,
    MAX(production_batch)                                          AS production_batch,
    SUM(ttl_kg) FILTER (WHERE grade = '3X50')                     AS kg_3x50,
    SUM(ttl_kg) FILTER (WHERE grade = '6X50')                     AS kg_6x50,
    SUM(ttl_kg) FILTER (WHERE grade = '8X50')                     AS kg_8x50,
    SUM(ttl_kg) FILTER (WHERE grade = '2X6')                      AS kg_2x6,
    SUM(ttl_kg)                                                    AS total_output_kg
  FROM production_runs
  GROUP BY transaction_date, shift
),
-- Waste totals pre-computed to avoid repeating the long expression
waste_totals AS (
  SELECT
    transaction_date,
    shift,
    production_batch,
    rs1a_kg,   rs1a_sacks,
    rs1b_kg,   rs1b_sacks,
    bf_kg,     bf_sacks,
    rs23_kg,   rs23_sacks,
    rs5_kg,    rs5_sacks,
    trml1_kg,  trml1_sacks,
    trml2_kg,  trml2_sacks,
    grit_kg,
    remarks                                                        AS waste_remarks,
    COALESCE(rs1a_kg,0) + COALESCE(rs1b_kg,0) + COALESCE(bf_kg,0)
      + COALESCE(rs23_kg,0) + COALESCE(rs5_kg,0)
      + COALESCE(trml1_kg,0) + COALESCE(trml2_kg,0)
      + COALESCE(grit_kg,0)                                        AS total_waste_kg
  FROM production_waste
)
SELECT
  COALESCE(r.transaction_date, d.transaction_date, w.transaction_date) AS transaction_date,
  COALESCE(r.shift,            d.shift,            w.shift)            AS shift,
  COALESCE(r.production_batch, d.production_batch, w.production_batch) AS production_batch,

  -- Output by grade
  r.kg_3x50,
  r.kg_6x50,
  r.kg_8x50,
  r.kg_2x6,
  COALESCE(r.total_output_kg, 0)                                       AS total_output_kg,

  -- Downtime
  d.shift_hrs,
  d.dt_hrs,
  d.dt_mins,
  d.dt_reason,
  (COALESCE(d.dt_hrs, 0) + COALESCE(d.dt_mins, 0) / 60.0)            AS dt_total_hrs,
  CASE
    WHEN d.shift_hrs IS NOT NULL
    THEN d.shift_hrs - (COALESCE(d.dt_hrs, 0) + COALESCE(d.dt_mins, 0) / 60.0)
    ELSE NULL
  END                                                                  AS productive_hrs,

  -- Waste per stream
  w.rs1a_kg,  w.rs1a_sacks,
  w.rs1b_kg,  w.rs1b_sacks,
  w.bf_kg,    w.bf_sacks,
  w.rs23_kg,  w.rs23_sacks,
  w.rs5_kg,   w.rs5_sacks,
  w.trml1_kg, w.trml1_sacks,
  w.trml2_kg, w.trml2_sacks,
  w.grit_kg,
  COALESCE(w.total_waste_kg, 0)                                        AS total_waste_kg,
  w.waste_remarks,

  -- Production loss %
  CASE
    WHEN (COALESCE(r.total_output_kg, 0) + COALESCE(w.total_waste_kg, 0)) > 0
    THEN COALESCE(w.total_waste_kg, 0)
         / (COALESCE(r.total_output_kg, 0) + COALESCE(w.total_waste_kg, 0))
    ELSE NULL
  END                                                                  AS prod_loss_pct

FROM            runs_agg          r
FULL OUTER JOIN production_downtime d
  ON  d.transaction_date = r.transaction_date
  AND d.shift             = r.shift
FULL OUTER JOIN waste_totals      w
  ON  w.transaction_date = COALESCE(r.transaction_date, d.transaction_date)
  AND w.shift             = COALESCE(r.shift,            d.shift);

COMMENT ON VIEW view_production_daily IS
  'Reconciliation view joining production_runs (aggregated by shift), production_downtime, and production_waste. Full outer join — a row appears even if only one sub-table has data for that (transaction_date, shift) pair.';

-- ============================================================
-- 2. view_electricity_monthly
--    Monthly aggregate per meter.
--    month_diff = MAX(end_kwh) - MIN(start_kwh) to handle
--    the case where daily readings accumulate across the month.
-- ============================================================
CREATE OR REPLACE VIEW view_electricity_monthly AS
SELECT
  DATE_TRUNC('month', reading_date)::date   AS month,
  meter,
  MIN(start_kwh)                            AS month_start_kwh,
  MAX(end_kwh)                              AS month_end_kwh,
  (MAX(end_kwh) - MIN(start_kwh))           AS month_diff_kwh,
  AVG(rate_php_per_kwh)                     AS avg_rate_php,
  (MAX(end_kwh) - MIN(start_kwh))
    * AVG(rate_php_per_kwh)                 AS month_ttl_php,
  COUNT(*)::int                             AS reading_count
FROM electricity_readings
GROUP BY DATE_TRUNC('month', reading_date)::date, meter;

COMMENT ON VIEW view_electricity_monthly IS
  'Monthly electricity aggregates per meter. month_diff_kwh = MAX(end_kwh) - MIN(start_kwh) across all daily readings in the month.';

-- ============================================================
-- 3. view_trucks_monthly
--    Monthly aggregate per plate_no.
--    month_km = SUM(ttl_km) to capture all daily legs.
-- ============================================================
CREATE OR REPLACE VIEW view_trucks_monthly AS
SELECT
  DATE_TRUNC('month', reading_date)::date   AS month,
  plate_no,
  MIN(start_km)                             AS month_start_km,
  MAX(end_km)                               AS month_end_km,
  SUM(ttl_km)                               AS month_km,
  SUM(fuel_liters)                          AS month_fuel_liters,
  COUNT(*)::int                             AS reading_count
FROM truck_readings
GROUP BY DATE_TRUNC('month', reading_date)::date, plate_no;

COMMENT ON VIEW view_trucks_monthly IS
  'Monthly truck km + fuel aggregates per plate. month_km = SUM of all daily ttl_km readings.';

-- ============================================================
-- Grants
-- Authenticated role: SELECT on all 5 tables + 3 views.
--                     INSERT/UPDATE/DELETE on all 5 tables.
-- Service role already has superuser access — no explicit grant needed.
-- ============================================================
GRANT SELECT ON TABLE production_runs      TO authenticated;
GRANT SELECT ON TABLE production_downtime  TO authenticated;
GRANT SELECT ON TABLE production_waste     TO authenticated;
GRANT SELECT ON TABLE electricity_readings TO authenticated;
GRANT SELECT ON TABLE truck_readings       TO authenticated;

GRANT INSERT, UPDATE, DELETE ON TABLE production_runs      TO authenticated;
GRANT INSERT, UPDATE, DELETE ON TABLE production_downtime  TO authenticated;
GRANT INSERT, UPDATE, DELETE ON TABLE production_waste     TO authenticated;
GRANT INSERT, UPDATE, DELETE ON TABLE electricity_readings TO authenticated;
GRANT INSERT, UPDATE, DELETE ON TABLE truck_readings       TO authenticated;

GRANT SELECT ON view_production_daily      TO authenticated;
GRANT SELECT ON view_electricity_monthly   TO authenticated;
GRANT SELECT ON view_trucks_monthly        TO authenticated;
