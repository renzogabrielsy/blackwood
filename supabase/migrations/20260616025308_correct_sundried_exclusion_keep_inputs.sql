-- CORRECTION to migration 20260616023550 (exclude_sundried_from_delivery_analytics),
-- which over-excluded by dropping whole suppliers (incl. "Layupan"/"SUNDRY BACKLOG")
-- and any sundry-tagged row. Renzo clarified the real rule:
--
-- KEEP (these are INCOMING / inputs, not post-sundrying output):
--   * ALL suppliers -- including "Layupan" and "SUNDRY BACKLOG". These are real
--     incoming deliveries (parties we sundry FOR / backlog). Do NOT exclude by supplier.
--   * Rows tagged "FOR SUNDRYING" / "FOR SUNDRIED" -- the input destined for the
--     drying process, even when it sits on a SUNDRY batch.
--
-- DROP (post-sundrying OUTPUT only):
--   * SUNDRY-batch rows that are the dried RESULT -- e.g. remarks "SUNDRIED",
--     "FINAL SUNDRY WT", or untagged sundry-batch output. This output is the same
--     charcoal already counted as incoming; re-counting it double-counts tonnage.
--
-- The predicate: exclude a SUNDRY-batch row UNLESS it is explicitly a "FOR SUNDR..."
-- input. It no longer touches supplier text or non-sundry-batch rows.
--   WHERE NOT (
--     batch_code ILIKE '%SUNDR%'
--     AND COALESCE(remarks, '') NOT ILIKE '%FOR SUNDR%'   -- keep FOR-SUNDRYING inputs
--   )
--
-- Verified against live data: excludes 91 sundry-batch OUTPUT rows / 581,172.99 kg
-- (the 92 sundry-batch rows MINUS the 1 "FOR SUNDRYING" input on NOV-25-SUNDRY4 /
-- 2,710 kg), leaving 1,512 incoming rows / 28,973,259.10 kg.
--
-- All weighting rules unchanged (L-008 cost_basis>0 price gate, FILTER-null lab
-- weighting). Column shapes unchanged -> types/supabase.ts unaffected.

-- ===========================================================================
-- BY PERIOD -- monthly grain
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
    -- exclude post-sundrying OUTPUT only; keep all suppliers + FOR-SUNDRYING inputs
    AND NOT (
      batch_code ILIKE '%SUNDR%'
      AND COALESCE(remarks, '') NOT ILIKE '%FOR SUNDR%'
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
-- BY PERIOD -- yearly footer rollup
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
    -- exclude post-sundrying OUTPUT only; keep all suppliers + FOR-SUNDRYING inputs
    AND NOT (
      batch_code ILIKE '%SUNDR%'
      AND COALESCE(remarks, '') NOT ILIKE '%FOR SUNDR%'
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
-- BY SUPPLIER -- monthly grain (year x month x supplier)
-- ===========================================================================
CREATE OR REPLACE VIEW public.view_delivery_supplier_monthly_analytics AS
WITH base AS (
  SELECT
    EXTRACT(YEAR  FROM transaction_date)::int  AS year,
    EXTRACT(MONTH FROM transaction_date)::int  AS month,
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
    -- exclude post-sundrying OUTPUT only; KEEP all suppliers (incl. Layupan /
    -- SUNDRY BACKLOG) and FOR-SUNDRYING inputs
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
-- BY SUPPLIER -- yearly rollup (year x supplier)
-- ===========================================================================
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
    -- exclude post-sundrying OUTPUT only; KEEP all suppliers (incl. Layupan /
    -- SUNDRY BACKLOG) and FOR-SUNDRYING inputs
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
