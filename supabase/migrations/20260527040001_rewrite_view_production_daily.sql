-- Migration: rewrite_view_production_daily
--
-- Rewrites view_production_daily after the parent-child restructure
-- (20260527040000_restructure_production_to_shifts_model).
--
-- The previous view joined child tables on (transaction_date, shift).
-- Those columns no longer exist on the child tables — the new join path is:
--   production_shifts → production_runs / production_downtime / production_waste
--   all keyed via shift_id.
--
-- SKS columns (rs*_sacks) have been dropped from production_waste and are
-- no longer projected here.
--
-- The view now exposes shift_id as the primary row identifier so callers
-- can reference a specific shift unambiguously.

DROP VIEW IF EXISTS view_production_daily;

CREATE VIEW view_production_daily AS
SELECT
  ps.id                AS shift_id,
  ps.transaction_date,
  ps.production_batch,
  ps.shift,

  -- Per-grade output (pivoted across customer rows — sums all customers per grade)
  SUM(pr.ttl_kg) FILTER (WHERE pr.grade = '3X50') AS kg_3x50,
  SUM(pr.ttl_kg) FILTER (WHERE pr.grade = '6X50') AS kg_6x50,
  SUM(pr.ttl_kg) FILTER (WHERE pr.grade = '8X50') AS kg_8x50,
  SUM(pr.ttl_kg) FILTER (WHERE pr.grade = '2X6')  AS kg_2x6,
  COALESCE(SUM(pr.ttl_kg), 0)                      AS total_output_kg,

  -- Downtime (1:1 with shift)
  pd.shift_hrs,
  pd.dt_hrs,
  pd.dt_mins,
  pd.dt_reason,
  (COALESCE(pd.dt_hrs, 0) + COALESCE(pd.dt_mins, 0) / 60.0)      AS dt_total_hrs,
  CASE
    WHEN pd.shift_hrs IS NOT NULL
    THEN pd.shift_hrs - (COALESCE(pd.dt_hrs, 0) + COALESCE(pd.dt_mins, 0) / 60.0)
    ELSE NULL
  END                                                               AS productive_hrs,

  -- Waste by stream — SKS columns removed (dropped from production_waste 2026-05-28)
  pw.rs1a_kg,
  pw.rs1b_kg,
  pw.bf_kg,
  pw.rs23_kg,
  pw.rs5_kg,
  pw.trml1_kg,
  pw.trml2_kg,
  pw.grit_kg,
  COALESCE(
    pw.rs1a_kg + pw.rs1b_kg + pw.bf_kg + pw.rs23_kg
    + pw.rs5_kg + pw.trml1_kg + pw.trml2_kg + pw.grit_kg,
    0
  )                                                                 AS total_waste_kg,
  pw.remarks                                                        AS waste_remarks,

  -- Production loss % = total_waste / (total_output + total_waste)
  CASE
    WHEN (
      COALESCE(SUM(pr.ttl_kg), 0)
      + COALESCE(pw.rs1a_kg + pw.rs1b_kg + pw.bf_kg + pw.rs23_kg
                 + pw.rs5_kg + pw.trml1_kg + pw.trml2_kg + pw.grit_kg, 0)
    ) > 0
    THEN
      COALESCE(pw.rs1a_kg + pw.rs1b_kg + pw.bf_kg + pw.rs23_kg
               + pw.rs5_kg + pw.trml1_kg + pw.trml2_kg + pw.grit_kg, 0)
      / NULLIF(
          COALESCE(SUM(pr.ttl_kg), 0)
          + COALESCE(pw.rs1a_kg + pw.rs1b_kg + pw.bf_kg + pw.rs23_kg
                     + pw.rs5_kg + pw.trml1_kg + pw.trml2_kg + pw.grit_kg, 0),
          0
        )
    ELSE NULL
  END                                                               AS prod_loss_pct

FROM production_shifts ps
LEFT JOIN production_runs     pr ON pr.shift_id = ps.id
LEFT JOIN production_downtime pd ON pd.shift_id = ps.id
LEFT JOIN production_waste    pw ON pw.shift_id = ps.id
GROUP BY
  ps.id,
  ps.transaction_date,
  ps.production_batch,
  ps.shift,
  pd.shift_hrs,
  pd.dt_hrs,
  pd.dt_mins,
  pd.dt_reason,
  pw.rs1a_kg,
  pw.rs1b_kg,
  pw.bf_kg,
  pw.rs23_kg,
  pw.rs5_kg,
  pw.trml1_kg,
  pw.trml2_kg,
  pw.grit_kg,
  pw.remarks;

COMMENT ON VIEW view_production_daily IS
  'One row per production_shifts entry. Joins production_runs (LEFT, aggregated by '
  'grade across customers), production_downtime (LEFT, 1:1), production_waste (LEFT, '
  '1:1). SKS sack columns removed 2026-05-28. Primary key exposed as shift_id. '
  'Replaces the pre-restructure view that joined on (transaction_date, shift).';

GRANT SELECT ON view_production_daily TO authenticated;
