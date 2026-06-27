-- Supplier-level analytics rollup of the deliveries table for the
-- "Summaries -> By Supplier" feature. Mirrors view_delivery_monthly_analytics
-- (migration 20260615000000) but adds a SUPPLIER dimension. All aggregation
-- lives HERE per the project rule: never compute weighted averages or balances
-- in TypeScript.
--
-- Grain (monthly view):  one row per (year, month, supplier) that has >=1 delivery.
-- Grain (yearly view):   one row per (year, supplier) -- a TRUE weighted yearly
--                        rollup so the action's per-supplier totals are computed
--                        in SQL, NOT by re-averaging the monthly averages in TS.
--
-- SECURITY INVOKER (default for views) -> inherits RLS from deliveries.
--
-- Supplier normalization: TRIM the supplier text; NULL or '' -> 'UNKNOWN' so
-- those rows still aggregate into a bucket rather than vanishing from totals.
--
-- Pricing rule (ledger L-008): cost_basis = 0 (or NULL) is the gsheet UNPRICED
-- placeholder, NOT a genuine ₱0. So price aggregates are computed ONLY over rows
-- where cost_basis > 0 -- unpriced rows must not drag the weighted average down.
-- VOLUME, by contrast, counts EVERY row (unpriced material still arrived).
--
-- Lab metrics: each metric is a volume-weighted average over rows where THAT key
-- is present and numeric, so a missing lab value is excluded (not treated as 0).

CREATE OR REPLACE VIEW public.view_delivery_supplier_monthly_analytics AS
WITH base AS (
  SELECT
    EXTRACT(YEAR  FROM transaction_date)::int  AS year,
    EXTRACT(MONTH FROM transaction_date)::int  AS month,
    COALESCE(NULLIF(TRIM(supplier), ''), 'UNKNOWN') AS supplier,
    weight_kg,
    sacks,
    cost_basis,
    -- priced flag: only genuine, positive cost basis counts toward ₱ aggregates
    (cost_basis IS NOT NULL AND cost_basis > 0) AS is_priced,
    -- numeric lab values (NULL when absent or non-numeric, so FILTER drops them)
    CASE WHEN lab_results->>'mc'      ~ '^-?\d+(\.\d+)?$' THEN (lab_results->>'mc')::numeric      END AS mc,
    CASE WHEN lab_results->>'ash'     ~ '^-?\d+(\.\d+)?$' THEN (lab_results->>'ash')::numeric     END AS ash,
    CASE WHEN lab_results->>'bd_astm' ~ '^-?\d+(\.\d+)?$' THEN (lab_results->>'bd_astm')::numeric END AS bd_astm,
    CASE WHEN lab_results->>'bd_jis'  ~ '^-?\d+(\.\d+)?$' THEN (lab_results->>'bd_jis')::numeric  END AS bd_jis,
    CASE WHEN lab_results->>'grit'    ~ '^-?\d+(\.\d+)?$' THEN (lab_results->>'grit')::numeric    END AS grit,
    CASE WHEN lab_results->>'vm'      ~ '^-?\d+(\.\d+)?$' THEN (lab_results->>'vm')::numeric      END AS vm,
    CASE WHEN lab_results->>'fc'      ~ '^-?\d+(\.\d+)?$' THEN (lab_results->>'fc')::numeric      END AS fc
  FROM public.deliveries
  WHERE transaction_date IS NOT NULL
)
SELECT
  year,
  month,
  supplier,
  COUNT(*)                              AS deliveries,
  COALESCE(SUM(sacks), 0)::bigint       AS sacks,
  COALESCE(SUM(weight_kg), 0)::numeric  AS volume_kg,

  -- volume-weighted ₱/kg over PRICED rows only; NULL when no priced rows
  (SUM(cost_basis * weight_kg) FILTER (WHERE is_priced))
    / NULLIF(SUM(weight_kg) FILTER (WHERE is_priced), 0)   AS avg_price,

  -- actual spend = sum(cost_basis * weight_kg) over priced rows
  COALESCE(SUM(cost_basis * weight_kg) FILTER (WHERE is_priced), 0)::numeric AS php_total,

  -- volume-weighted lab metrics, each excluding rows missing that key
  SUM(mc      * weight_kg) FILTER (WHERE mc      IS NOT NULL) / NULLIF(SUM(weight_kg) FILTER (WHERE mc      IS NOT NULL), 0) AS mc,
  SUM(ash     * weight_kg) FILTER (WHERE ash     IS NOT NULL) / NULLIF(SUM(weight_kg) FILTER (WHERE ash     IS NOT NULL), 0) AS ash,
  SUM(bd_astm * weight_kg) FILTER (WHERE bd_astm IS NOT NULL) / NULLIF(SUM(weight_kg) FILTER (WHERE bd_astm IS NOT NULL), 0) AS bd_astm,
  SUM(bd_jis  * weight_kg) FILTER (WHERE bd_jis  IS NOT NULL) / NULLIF(SUM(weight_kg) FILTER (WHERE bd_jis  IS NOT NULL), 0) AS bd_jis,
  SUM(grit    * weight_kg) FILTER (WHERE grit    IS NOT NULL) / NULLIF(SUM(weight_kg) FILTER (WHERE grit    IS NOT NULL), 0) AS grit,
  SUM(vm      * weight_kg) FILTER (WHERE vm      IS NOT NULL) / NULLIF(SUM(weight_kg) FILTER (WHERE vm      IS NOT NULL), 0) AS vm,
  SUM(fc      * weight_kg) FILTER (WHERE fc      IS NOT NULL) / NULLIF(SUM(weight_kg) FILTER (WHERE fc      IS NOT NULL), 0) AS fc
FROM base
GROUP BY year, month, supplier
ORDER BY year, month, supplier;

GRANT SELECT ON public.view_delivery_supplier_monthly_analytics TO authenticated, anon;

-- ---------------------------------------------------------------------------
-- Per-supplier YEARLY rollup companion. Same weighting rules at the
-- (year, supplier) grain so each supplier's yearly totals come from a true
-- weighted rollup (NOT the monthly averages re-averaged in TS).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW public.view_delivery_supplier_yearly_analytics AS
WITH base AS (
  SELECT
    EXTRACT(YEAR FROM transaction_date)::int AS year,
    COALESCE(NULLIF(TRIM(supplier), ''), 'UNKNOWN') AS supplier,
    weight_kg,
    sacks,
    cost_basis,
    (cost_basis IS NOT NULL AND cost_basis > 0) AS is_priced,
    CASE WHEN lab_results->>'mc'      ~ '^-?\d+(\.\d+)?$' THEN (lab_results->>'mc')::numeric      END AS mc,
    CASE WHEN lab_results->>'ash'     ~ '^-?\d+(\.\d+)?$' THEN (lab_results->>'ash')::numeric     END AS ash,
    CASE WHEN lab_results->>'bd_astm' ~ '^-?\d+(\.\d+)?$' THEN (lab_results->>'bd_astm')::numeric END AS bd_astm,
    CASE WHEN lab_results->>'bd_jis'  ~ '^-?\d+(\.\d+)?$' THEN (lab_results->>'bd_jis')::numeric  END AS bd_jis,
    CASE WHEN lab_results->>'grit'    ~ '^-?\d+(\.\d+)?$' THEN (lab_results->>'grit')::numeric    END AS grit,
    CASE WHEN lab_results->>'vm'      ~ '^-?\d+(\.\d+)?$' THEN (lab_results->>'vm')::numeric      END AS vm,
    CASE WHEN lab_results->>'fc'      ~ '^-?\d+(\.\d+)?$' THEN (lab_results->>'fc')::numeric      END AS fc
  FROM public.deliveries
  WHERE transaction_date IS NOT NULL
)
SELECT
  year,
  supplier,
  COUNT(*)                              AS deliveries,
  COALESCE(SUM(sacks), 0)::bigint       AS sacks,
  COALESCE(SUM(weight_kg), 0)::numeric  AS volume_kg,
  (SUM(cost_basis * weight_kg) FILTER (WHERE is_priced))
    / NULLIF(SUM(weight_kg) FILTER (WHERE is_priced), 0)   AS avg_price,
  COALESCE(SUM(cost_basis * weight_kg) FILTER (WHERE is_priced), 0)::numeric AS php_total,
  SUM(mc      * weight_kg) FILTER (WHERE mc      IS NOT NULL) / NULLIF(SUM(weight_kg) FILTER (WHERE mc      IS NOT NULL), 0) AS mc,
  SUM(ash     * weight_kg) FILTER (WHERE ash     IS NOT NULL) / NULLIF(SUM(weight_kg) FILTER (WHERE ash     IS NOT NULL), 0) AS ash,
  SUM(bd_astm * weight_kg) FILTER (WHERE bd_astm IS NOT NULL) / NULLIF(SUM(weight_kg) FILTER (WHERE bd_astm IS NOT NULL), 0) AS bd_astm,
  SUM(bd_jis  * weight_kg) FILTER (WHERE bd_jis  IS NOT NULL) / NULLIF(SUM(weight_kg) FILTER (WHERE bd_jis  IS NOT NULL), 0) AS bd_jis,
  SUM(grit    * weight_kg) FILTER (WHERE grit    IS NOT NULL) / NULLIF(SUM(weight_kg) FILTER (WHERE grit    IS NOT NULL), 0) AS grit,
  SUM(vm      * weight_kg) FILTER (WHERE vm      IS NOT NULL) / NULLIF(SUM(weight_kg) FILTER (WHERE vm      IS NOT NULL), 0) AS vm,
  SUM(fc      * weight_kg) FILTER (WHERE fc      IS NOT NULL) / NULLIF(SUM(weight_kg) FILTER (WHERE fc      IS NOT NULL), 0) AS fc
FROM base
GROUP BY year, supplier
ORDER BY year, supplier;

GRANT SELECT ON public.view_delivery_supplier_yearly_analytics TO authenticated, anon;
