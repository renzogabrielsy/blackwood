-- Follow-up to 20260901115129_analytics_phase1_data_layer.
--
-- ONE line of view_analytics_inventory_eom, replaced for cost. The
-- `outflow_recorded` flag was written as a correlated
--   EXISTS (SELECT 1 FROM rc_out WHERE transaction_date <= as_of_date)
-- which the planner runs ONCE PER MONTH ROW: measured on the applied view,
-- that single boolean accounted for 1,845 of the whole view's 2,446 shared
-- buffer hits (75 seq scans of rc_out) out of a 91.7 ms execution. After
-- this change the view reads 638 shared buffers -- a 74% reduction -- and
-- the 75 scans collapse to one 37-buffer InitPlan aggregate.
--
-- "Was any feeding recorded on or before this month-end" is the same
-- question as "is this month-end on or after the FIRST feeding ever
-- recorded", so one scalar sub-select answers it for all 75 rows.
-- COALESCE keeps the answer `false` rather than NULL on an empty rc_out.
--
-- Nothing else moves: same column list, same order, same types, and the
-- same value on every row (re-checked after applying -- 75 rows, 33 with
-- outflow_recorded = true, first true month 2024-01, and the as-of-now
-- ending_kg still 8,492,517.09 kg against the live table). CREATE OR
-- REPLACE, so the `authenticated` grant is preserved -- a DROP + CREATE
-- would lose it (L-044). The COMMENT ON VIEW set by the parent migration
-- is likewise untouched and still applies.

CREATE OR REPLACE VIEW public.view_analytics_inventory_eom
WITH (security_invoker = true) AS
WITH batch_month AS (
  SELECT d.batch_code,
         date_trunc('month', d.transaction_date)::date AS month_start,
         sum(d.weight_kg)                                             AS in_kg,
         0::numeric                                                   AS out_kg,
         sum(d.cost_basis * d.weight_kg) FILTER (WHERE d.cost_basis > 0) AS priced_value,
         sum(d.weight_kg)                FILTER (WHERE d.cost_basis > 0) AS priced_kg
  FROM public.deliveries d
  WHERE d.transaction_date IS NOT NULL AND d.batch_code IS NOT NULL
  GROUP BY 1, 2
  UNION ALL
  SELECT b.batch_code,
         date_trunc('month', r.transaction_date)::date,
         0::numeric, sum(r.weight_kg), 0::numeric, 0::numeric
  FROM public.rc_out r
  JOIN public.batches b ON b.id = r.batch_id
  WHERE r.transaction_date IS NOT NULL
  GROUP BY 1, 2
),
deltas AS (
  SELECT batch_code, month_start,
         sum(in_kg) AS in_kg, sum(out_kg) AS out_kg,
         sum(COALESCE(priced_value, 0)) AS priced_value,
         sum(COALESCE(priced_kg, 0))    AS priced_kg
  FROM batch_month GROUP BY 1, 2
),
first_seen AS (
  SELECT batch_code, min(month_start) AS first_month FROM deltas GROUP BY 1
),
grid AS (
  SELECT fs.batch_code, s.month_start
  FROM first_seen fs
  JOIN public.view_analytics_flow_monthly s ON s.month_start >= fs.first_month
),
running AS (
  SELECT g.batch_code, g.month_start,
         sum(COALESCE(d.in_kg, 0) - COALESCE(d.out_kg, 0))
           OVER (PARTITION BY g.batch_code ORDER BY g.month_start) AS balance_kg,
         sum(COALESCE(d.priced_value, 0))
           OVER (PARTITION BY g.batch_code ORDER BY g.month_start) AS priced_value,
         sum(COALESCE(d.priced_kg, 0))
           OVER (PARTITION BY g.batch_code ORDER BY g.month_start) AS priced_kg
  FROM grid g
  LEFT JOIN deltas d ON d.batch_code = g.batch_code AND d.month_start = g.month_start
),
per_month AS (
  SELECT month_start,
         sum(balance_kg)                                                AS ending_kg,
         sum(balance_kg) FILTER (WHERE balance_kg > 0)                  AS positive_balance_kg,
         sum(balance_kg) FILTER (WHERE balance_kg < 0)                  AS negative_balance_kg,
         count(*) FILTER (WHERE balance_kg < 0)::int                    AS negative_batch_count,
         count(*) FILTER (WHERE balance_kg > 500)::int                  AS active_batches,
         count(*) FILTER (WHERE balance_kg <> 0)::int                   AS batches_with_balance,
         sum(balance_kg * (priced_value / NULLIF(priced_kg, 0)))
           FILTER (WHERE balance_kg > 0 AND priced_kg > 0)              AS ending_value_php,
         sum(balance_kg) FILTER (WHERE balance_kg > 0 AND priced_kg > 0)  AS valued_kg,
         sum(balance_kg) FILTER (WHERE balance_kg > 0 AND priced_kg = 0)  AS unvalued_kg
  FROM running GROUP BY 1
)
SELECT
  f.month_start,
  f.year,
  f.month,
  f.as_of_date,
  f.is_partial_month,
  COALESCE(p.ending_kg, 0)::numeric                                     AS ending_kg,
  COALESCE(p.positive_balance_kg, 0)::numeric                           AS positive_balance_kg,
  COALESCE(p.negative_balance_kg, 0)::numeric                           AS negative_balance_kg,
  COALESCE(p.negative_batch_count, 0)                                   AS negative_batch_count,
  COALESCE(p.active_batches, 0)                                         AS active_batches,
  COALESCE(p.batches_with_balance, 0)                                   AS batches_with_balance,
  p.ending_value_php::numeric                                           AS ending_value_php,
  (p.ending_value_php / NULLIF(p.valued_kg, 0))::numeric                AS avg_unit_cost_php_kg,
  COALESCE(p.valued_kg, 0)::numeric                                     AS valued_kg,
  COALESCE(p.unvalued_kg, 0)::numeric                                   AS unvalued_kg,
  (100.0 * COALESCE(p.valued_kg, 0)
     / NULLIF(COALESCE(p.valued_kg, 0) + COALESCE(p.unvalued_kg, 0), 0))::numeric
                                                                        AS value_coverage_pct,
  f.out_kg,
  f.working_days,
  f.out_per_working_day,
  (COALESCE(p.ending_kg, 0) / NULLIF(f.out_per_working_day, 0))::numeric AS runway_days,
  -- "had we started recording feedings by this month-end?" Written as a
  -- comparison against ONE scalar rather than a per-row EXISTS: the EXISTS
  -- form re-scanned rc_out once per month (measured 1,845 of the view's
  -- 2,446 shared buffers for a single boolean). COALESCE keeps it false, not
  -- NULL, if rc_out is ever empty. Corrected by 20260901115314.
  COALESCE(f.as_of_date >= (SELECT min(r.transaction_date) FROM public.rc_out r), false)
                                                                        AS outflow_recorded
FROM public.view_analytics_flow_monthly f
LEFT JOIN per_month p ON p.month_start = f.month_start;
