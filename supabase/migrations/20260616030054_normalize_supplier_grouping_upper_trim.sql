-- Normalize supplier grouping in the two SUPPLIER analytics views so case/whitespace
-- variants of the same vendor collapse into one row.
--
-- PROBLEM: the supplier views grouped by RAW `supplier` text, so "paquibot",
-- "Paquibot", and "PAQUIBOT" showed as three separate suppliers (same for Ornales,
-- Tag-at, Llanto). Confirmed via data: among KEPT (incoming) rows there are 48
-- distinct raw spellings but only 43 case-normalized, and ZERO rows carry a
-- " - BLOCK" provenance suffix (those were all sundry OUTPUT, already excluded by
-- the sundried filter) -- so a plain case+whitespace normalization is safe and
-- will NOT over-merge distinct vendors.
--
-- FIX: group AND label suppliers by UPPER(TRIM(supplier)). Uppercase display is
-- consistent with the app's batch-code casing. This is a pure REGROUPING -- the
-- sundried-exclusion WHERE and ALL weighting rules (L-008 cost_basis>0 price gate,
-- FILTER-null volume-weighted lab metrics) are unchanged, so grand-total volume is
-- identical and per-supplier ₱/kg becomes a proper volume-weighted blend of the
-- former variants. Column shapes unchanged -> types/supabase.ts unaffected.
--
-- The PERIOD views (view_delivery_monthly/yearly_analytics) have no supplier
-- dimension and are intentionally left untouched.

-- ===========================================================================
-- BY SUPPLIER -- monthly grain (year x month x NORMALIZED supplier)
-- ===========================================================================
CREATE OR REPLACE VIEW public.view_delivery_supplier_monthly_analytics AS
WITH base AS (
  SELECT
    EXTRACT(YEAR  FROM transaction_date)::int  AS year,
    EXTRACT(MONTH FROM transaction_date)::int  AS month,
    -- normalize: case + whitespace; blank/NULL -> 'UNKNOWN' (already uppercase)
    COALESCE(NULLIF(UPPER(TRIM(supplier)), ''), 'UNKNOWN') AS supplier,
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
    -- exclude post-sundrying OUTPUT only; keep all suppliers + FOR-SUNDRYING inputs
    AND NOT (
      batch_code ILIKE '%SUNDR%'
      AND COALESCE(remarks, '') NOT ILIKE '%FOR SUNDR%'
    )
)
SELECT
  year,
  month,
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
GROUP BY year, month, supplier
ORDER BY year, month, supplier;

GRANT SELECT ON public.view_delivery_supplier_monthly_analytics TO authenticated, anon;

-- ===========================================================================
-- BY SUPPLIER -- yearly rollup (year x NORMALIZED supplier)
-- ===========================================================================
CREATE OR REPLACE VIEW public.view_delivery_supplier_yearly_analytics AS
WITH base AS (
  SELECT
    EXTRACT(YEAR FROM transaction_date)::int AS year,
    COALESCE(NULLIF(UPPER(TRIM(supplier)), ''), 'UNKNOWN') AS supplier,
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
    -- exclude post-sundrying OUTPUT only; keep all suppliers + FOR-SUNDRYING inputs
    AND NOT (
      batch_code ILIKE '%SUNDR%'
      AND COALESCE(remarks, '') NOT ILIKE '%FOR SUNDR%'
    )
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
