-- Two data-quality fixes for the Summaries delivery analytics views.
--
-- (1) EXCLUDE REFEED + RECOOK (reprocessing, not incoming) -- on ALL FOUR views.
--     Like sundried OUTPUT, refeed/recook material is the plant re-processing
--     charcoal already counted as incoming (re-feeding the RC tank / re-cooking),
--     so counting it again double-counts. Added to the existing sundried-OUTPUT
--     exclusion (which itself keeps "FOR SUNDRYING" inputs + all suppliers).
--     Final exclusion predicate on every view:
--       WHERE NOT (
--         (batch_code ILIKE '%SUNDR%' AND COALESCE(remarks,'') NOT ILIKE '%FOR SUNDR%')
--         OR batch_code ILIKE '%REFEED%'
--         OR batch_code ILIKE '%RECOOK%'
--         OR supplier ILIKE '%refeed%' OR supplier ILIKE '%re-feed%' OR supplier ILIKE '%re feed%'
--         OR supplier ILIKE '%recook%' OR supplier ILIKE '%re-cook%' OR supplier ILIKE '%re cook%'
--       )
--     Verified live: removes 4 rows / 46,629 kg (NOV-24-BLK4 "Re-cook" 13,270;
--     OCT-25-FEED1 "Re-cook/Lapayag bernie" 2,005; FEB-26-RECOOKED1 1,650;
--     MARCH-26-REFEED1 "RE-FEED" 29,704). Grand-total kept 28,973,259.10 ->
--     28,926,630.10 kg.
--
-- (2) BAGUIO / TIPALAN supplier aliasing (typos) -- on the TWO SUPPLIER views only.
--     Replaces the plain UPPER(TRIM(supplier)) normalization with a CASE that
--     folds the misspelled slash-variants. ORDER MATTERS: the tipalan check runs
--     FIRST so any row mentioning tipalan (combined OR standalone) maps to the
--     joint "BAGUIO/TIPALAN"; a baguio/bagiuo row WITHOUT tipalan stays a SEPARATE
--     standalone "BAGUIO".
--       CASE
--         WHEN supplier ILIKE '%tipal%' OR supplier ILIKE '%tipla%' THEN 'BAGUIO/TIPALAN'
--         WHEN supplier ILIKE '%bagui%' OR supplier ILIKE '%bagi%'  THEN 'BAGUIO'
--         ELSE UPPER(TRIM(supplier))
--       END
--     Merges "Baguio/Tipalan","Baguio / Tipalan","Bagiuo/ Tipalan","Bagiu/Tipalan",
--     standalone "Tipalan" -> BAGUIO/TIPALAN (11 rows / 62,174 kg); "Baguio"+"Bagiuo"
--     -> separate BAGUIO (3 rows / 16,241.60 kg). Verified no other supplier matches
--     'bagi'/'tipal'. Used as BOTH the GROUP BY key and the projected supplier label.
--
-- Weighting rules unchanged (L-008 cost_basis>0 price gate, FILTER-null lab
-- weighting). Column shapes unchanged -> types/supabase.ts unaffected.
-- The PERIOD views have no supplier dimension -- only the exclusion (1) applies there.

-- ===========================================================================
-- BY PERIOD -- monthly grain  (exclusion only)
-- ===========================================================================
CREATE OR REPLACE VIEW public.view_delivery_monthly_analytics AS
WITH base AS (
  SELECT
    EXTRACT(YEAR  FROM transaction_date)::int  AS year,
    EXTRACT(MONTH FROM transaction_date)::int  AS month,
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
GROUP BY year, month
ORDER BY year, month;

GRANT SELECT ON public.view_delivery_monthly_analytics TO authenticated, anon;

-- ===========================================================================
-- BY PERIOD -- yearly footer rollup  (exclusion only)
-- ===========================================================================
CREATE OR REPLACE VIEW public.view_delivery_yearly_analytics AS
WITH base AS (
  SELECT
    EXTRACT(YEAR FROM transaction_date)::int AS year,
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
GROUP BY year
ORDER BY year;

GRANT SELECT ON public.view_delivery_yearly_analytics TO authenticated, anon;

-- ===========================================================================
-- BY SUPPLIER -- monthly grain  (exclusion + Baguio/Tipalan alias)
-- ===========================================================================
CREATE OR REPLACE VIEW public.view_delivery_supplier_monthly_analytics AS
WITH base AS (
  SELECT
    EXTRACT(YEAR  FROM transaction_date)::int  AS year,
    EXTRACT(MONTH FROM transaction_date)::int  AS month,
    -- Baguio/Tipalan alias (tipalan check FIRST), else case+whitespace normalize
    CASE
      WHEN supplier ILIKE '%tipal%' OR supplier ILIKE '%tipla%' THEN 'BAGUIO/TIPALAN'
      WHEN supplier ILIKE '%bagui%' OR supplier ILIKE '%bagi%'  THEN 'BAGUIO'
      ELSE COALESCE(NULLIF(UPPER(TRIM(supplier)), ''), 'UNKNOWN')
    END AS supplier,
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
-- BY SUPPLIER -- yearly rollup  (exclusion + Baguio/Tipalan alias)
-- ===========================================================================
CREATE OR REPLACE VIEW public.view_delivery_supplier_yearly_analytics AS
WITH base AS (
  SELECT
    EXTRACT(YEAR FROM transaction_date)::int AS year,
    CASE
      WHEN supplier ILIKE '%tipal%' OR supplier ILIKE '%tipla%' THEN 'BAGUIO/TIPALAN'
      WHEN supplier ILIKE '%bagui%' OR supplier ILIKE '%bagi%'  THEN 'BAGUIO'
      ELSE COALESCE(NULLIF(UPPER(TRIM(supplier)), ''), 'UNKNOWN')
    END AS supplier,
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
