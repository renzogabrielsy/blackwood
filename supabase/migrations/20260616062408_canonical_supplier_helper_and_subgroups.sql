-- Canonical supplier grouping helper + subgroup breakdown view for Summaries -> By Supplier.
--
-- PART 1: canonical_supplier(text) -- the single source of truth for folding
-- supplier spellings/typos/"/" combos into a MAIN group. IMMUTABLE so it can be
-- used in view GROUP BY and is inlinable by the planner. Order matters:
--   1. tipalan (combined or standalone)      -> BAGUIO/TIPALAN  (joint vendor)
--   2. baguio/bagiuo WITHOUT tipalan          -> BAGUIO          (separate standalone)
--   3. misdeclare "/" COMBOS -> ORNALES       (Mercado/Ornales, Mercado/Paquibot,
--      Arbelera/Mercado, Nazarte/Arbelera -- in either order)
--   4. "/" COMBOS -> PAQUIBOT                  (Compra/Paquibot, Suarez/Paquibot,
--      Baraquel/Paquibot -- in either order)
--   5. ELSE case+whitespace normalize, blank/NULL -> 'UNKNOWN'
-- IMPORTANT: clauses 3-4 only catch the "/" COMBOS (two names present). Standalone
-- Mercado / Compra / Suarez / Baraquel / Arbelera / Nazarte (no second name) fall
-- to ELSE and remain their OWN supplier -- the ILIKE patterns each require BOTH
-- names, so there are no false positives.

CREATE OR REPLACE FUNCTION public.canonical_supplier(p_supplier text)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE
    WHEN p_supplier ILIKE '%tipal%' OR p_supplier ILIKE '%tipla%' THEN 'BAGUIO/TIPALAN'
    WHEN p_supplier ILIKE '%bagui%' OR p_supplier ILIKE '%bagi%'  THEN 'BAGUIO'
    -- misdeclares -> ORNALES
    WHEN p_supplier ILIKE '%mercado%ornales%' OR p_supplier ILIKE '%ornales%mercado%'
      OR p_supplier ILIKE '%mercado%paquibot%' OR p_supplier ILIKE '%paquibot%mercado%'
      OR p_supplier ILIKE '%arbelera%mercado%' OR p_supplier ILIKE '%mercado%arbelera%'
      OR p_supplier ILIKE '%nazarte%arbelera%'  OR p_supplier ILIKE '%arbelera%nazarte%'  THEN 'ORNALES'
    -- combos -> PAQUIBOT
    WHEN p_supplier ILIKE '%compra%paquibot%'  OR p_supplier ILIKE '%paquibot%compra%'
      OR p_supplier ILIKE '%suarez%paquibot%'  OR p_supplier ILIKE '%paquibot%suarez%'
      OR p_supplier ILIKE '%baraquel%paquibot%'OR p_supplier ILIKE '%paquibot%baraquel%' THEN 'PAQUIBOT'
    ELSE COALESCE(NULLIF(UPPER(TRIM(p_supplier)), ''), 'UNKNOWN')
  END;
$$;

-- ===========================================================================
-- BY SUPPLIER -- monthly grain (year x month x canonical supplier)
-- Same sundried+refeed+recook exclusion + weighting; only the supplier GROUP BY
-- key/label changes (inline CASE -> canonical_supplier()).
-- ===========================================================================
CREATE OR REPLACE VIEW public.view_delivery_supplier_monthly_analytics AS
WITH base AS (
  SELECT
    EXTRACT(YEAR  FROM transaction_date)::int  AS year,
    EXTRACT(MONTH FROM transaction_date)::int  AS month,
    public.canonical_supplier(supplier) AS supplier,
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
    AND NOT (
      (batch_code ILIKE '%SUNDR%' AND COALESCE(remarks, '') NOT ILIKE '%FOR SUNDR%')
      OR batch_code ILIKE '%REFEED%'
      OR batch_code ILIKE '%RECOOK%'
      OR supplier ILIKE '%refeed%' OR supplier ILIKE '%re-feed%' OR supplier ILIKE '%re feed%'
      OR supplier ILIKE '%recook%' OR supplier ILIKE '%re-cook%' OR supplier ILIKE '%re cook%'
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
-- BY SUPPLIER -- yearly rollup (year x canonical supplier)
-- ===========================================================================
CREATE OR REPLACE VIEW public.view_delivery_supplier_yearly_analytics AS
WITH base AS (
  SELECT
    EXTRACT(YEAR FROM transaction_date)::int AS year,
    public.canonical_supplier(supplier) AS supplier,
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
    AND NOT (
      (batch_code ILIKE '%SUNDR%' AND COALESCE(remarks, '') NOT ILIKE '%FOR SUNDR%')
      OR batch_code ILIKE '%REFEED%'
      OR batch_code ILIKE '%RECOOK%'
      OR supplier ILIKE '%refeed%' OR supplier ILIKE '%re-feed%' OR supplier ILIKE '%re feed%'
      OR supplier ILIKE '%recook%' OR supplier ILIKE '%re-cook%' OR supplier ILIKE '%re cook%'
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

-- ===========================================================================
-- PART 2: SUBGROUP breakdown -- the constituents under each MAIN group.
-- Grain: (year, main_supplier = canonical_supplier(supplier),
--         subgroup = case+whitespace-normalized raw supplier).
-- Casing variants collapse into one subgroup; each distinct "/" combo is its
-- own subgroup. Same exclusion + price weighting (no lab metrics needed here).
-- ===========================================================================
CREATE OR REPLACE VIEW public.view_delivery_supplier_subgroup_yearly_analytics AS
WITH base AS (
  SELECT
    EXTRACT(YEAR FROM transaction_date)::int AS year,
    public.canonical_supplier(supplier) AS main_supplier,
    COALESCE(NULLIF(UPPER(TRIM(supplier)), ''), 'UNKNOWN') AS subgroup,
    weight_kg,
    sacks,
    cost_basis,
    (cost_basis IS NOT NULL AND cost_basis > 0) AS is_priced
  FROM public.deliveries
  WHERE transaction_date IS NOT NULL
    AND NOT (
      (batch_code ILIKE '%SUNDR%' AND COALESCE(remarks, '') NOT ILIKE '%FOR SUNDR%')
      OR batch_code ILIKE '%REFEED%'
      OR batch_code ILIKE '%RECOOK%'
      OR supplier ILIKE '%refeed%' OR supplier ILIKE '%re-feed%' OR supplier ILIKE '%re feed%'
      OR supplier ILIKE '%recook%' OR supplier ILIKE '%re-cook%' OR supplier ILIKE '%re cook%'
    )
)
SELECT
  year,
  main_supplier,
  subgroup,
  COUNT(*)                              AS deliveries,
  COALESCE(SUM(sacks), 0)::bigint       AS sacks,
  COALESCE(SUM(weight_kg), 0)::numeric  AS volume_kg,
  (SUM(cost_basis * weight_kg) FILTER (WHERE is_priced))
    / NULLIF(SUM(weight_kg) FILTER (WHERE is_priced), 0)   AS avg_price,
  COALESCE(SUM(cost_basis * weight_kg) FILTER (WHERE is_priced), 0)::numeric AS php_total
FROM base
GROUP BY year, main_supplier, subgroup
ORDER BY year, main_supplier, volume_kg DESC;

GRANT SELECT ON public.view_delivery_supplier_subgroup_yearly_analytics TO authenticated, anon;
