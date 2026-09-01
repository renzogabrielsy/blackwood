-- =====================================================================
-- ICTC Owner Analytics — PHASE 3 data layer: THE SUPPLIER ROOM
-- Plan: .agents/plans/ictc-analytics-dashboard-plan.md  (P3 — "supplier
-- room": per-supplier monthly matrix — kg, share, premium/discount,
-- active-months; the price x volume x participation explorer).
--
-- ONE view. No new tables, no new arithmetic for anything that already
-- has a home:
--   * WHO a supplier IS is `public.canonical_supplier(text)` — the ONE
--     identity (migration 20260616062408). Not re-implemented, not
--     approximated, not ported to TypeScript.
--   * WHAT KIND of arrival a row is, is `public.fn_delivery_class(...)` —
--     the P1 classifier, called with the SAME three arguments
--     view_analytics_rcin_monthly passes.
--   * WHAT THE MONTH DID is read by JOINING view_analytics_rcin_monthly,
--     never by re-summing the month here. That is what makes it
--     STRUCTURALLY impossible for the supplier room and the P1 matrix to
--     disagree about a month's kilos, pesos or price — the denominator of
--     `share_of_month_pct` and the baseline of `premium_php_kg` are the
--     P1 view's own published columns.
--
-- POSTURE (identical to P1/P2, template 20260901115129):
--   security_invoker · SELECT to `authenticated` only · anon REVOKEd ·
--   NOT granted to service_role (the sync worker reads none of these;
--   L-044's arrow direction — a consumer is not a dependency).
--   `scripts/verify-worker-view-grants.ts` must still read 4 views / 0
--   findings after this migration.
--
-- WINDOWING: none, same reasoning as P1/P2. Measured row counts:
--   275 rows for ALL of history (2020-07 .. 2026-08), 113 for the
--   busiest single year (2025), 58 for 2026 YTD. PostgREST's 1000-row
--   ascending cap is ~4x away even on a whole-history read, so a full
--   unfiltered SELECT is safe today — but the cap is real (the RC IN
--   drill-down lesson), so the page should still filter by year and
--   treat a 1000-row result as truncated.
--
-- P COLUMNS — the complete list the server action must NULL when
-- `canViewPrices()` is false, BEFORE the payload leaves the server:
--     avg_price_php_kg, php_total, premium_php_kg, month_avg_price_php_kg
-- Everything else (kg, share, ranks, counts, sundry origin) is peso-free
-- and none of it is derivable back into a price, so the volume and
-- participation half of the supplier room stays fully visible to
-- Production — the same split that made view_analytics_aging_eom useful
-- to a restricted role in P2.
-- =====================================================================


-- ---------------------------------------------------------------------
-- view_analytics_supplier_monthly
-- ---------------------------------------------------------------------
-- Grain: one row per (calendar month x canonical supplier). MARKET
-- deliveries only — sundry re-entries and re-cooks are NEVER supplier
-- volume, per the plan's classification rule: we already bought those
-- kilos once, so counting them again as a purchase double-counts the
-- tonnage AND drags the supplier's average price toward the recovery
-- price. This is the same population as view_analytics_rcin_monthly's
-- market columns, split by seller.
--
-- SHARE: this supplier's market kilos over the MONTH's market kilos,
-- read from view_analytics_rcin_monthly.market_kg. It answers the
-- concentration question (plan 2.4 — "Ornales is ~40% YTD, how exposed
-- are we"), and `kg_rank_in_month` + `cumulative_share_pct` are here so
-- "top-1 / top-3 share" is a lookup rather than a second computation in
-- the page. Ranks and cumulative share are NULL on a row with no market
-- kilos, so a sundry-only row can never claim a place in the ranking.
--
-- PREMIUM: supplier's weighted P/kg MINUS the month's market weighted
-- P/kg. POSITIVE means this supplier was paid ABOVE the month's market
-- average. It is NULL — never 0 — when either side has no priced kilos,
-- because "we do not know" and "exactly at market" are different
-- answers. Weighted by priced kilos the premiums sum to zero by
-- construction (the month price IS the priced-kg-weighted mean of the
-- supplier prices) — which is precisely why the column must never be
-- averaged unweighted.
--
-- PRICED-ONLY, per Database Rules (L-008 / L-039): cost_basis = 0 is the
-- "not priced yet" placeholder, not a free truckload, so it contributes
-- to neither side of any average. `priced_kg` and `price_coverage_pct`
-- say how much of the supplier's month the price actually speaks for.
--
-- SUNDRY ORIGIN — traceability, never volume. `sundry_origin_kg` is the
-- kilos of OUR OWN charcoal that came back from sun-drying that month
-- carrying this supplier's name. It is deliberately a SEPARATE column
-- from `kg` and is excluded from share, rank, premium and every price:
-- it is not a purchase and must never be added to one.
--   Two measured facts make it cheap and honest rather than a second
--   supplier identity:
--   (1) 17 of the 26 sundry supplier spellings carry a batch suffix
--       ("Layupan - JAN-26-BLK9"), which canonical_supplier() does not
--       strip, so keying them raw would invent 17 phantom suppliers that
--       can never join to a real seller. Stripping at the first ' - ' and
--       THEN folding through canonical_supplier() resolves all 91 sundry
--       deliveries to 11 origins, and every one of the 11 is a supplier
--       that genuinely sold to us on the market. Zero orphans.
--   (2) The strip is a PROVEN NO-OP on the market population: across
--       every market delivery in the table there is not one row where
--       canonical_supplier(supplier) differs from
--       canonical_supplier(split_part(supplier,' - ',1)). So it cannot
--       move a purchase number even in principle — it only ever renames a
--       sundry row. canonical_supplier() remains the ONE identity; this
--       is a suffix normalization feeding INTO it, not a rival to it.
-- A supplier with sundry origin but no market purchase that month still
-- gets a row (measured: 7 such pairs), reading kg = 0 with NULL share,
-- rank, price and premium — an exclusion can be forgotten by a UI, a row
-- cannot.
-- ---------------------------------------------------------------------
CREATE OR REPLACE VIEW public.view_analytics_supplier_monthly
WITH (security_invoker = true) AS
WITH classed AS (
  SELECT
    date_trunc('month', d.transaction_date)::date                  AS month_start,
    public.fn_delivery_class(d.batch_code, d.supplier, d.remarks)  AS delivery_class,
    -- MARKET identity: the raw supplier folded by the ONE function.
    public.canonical_supplier(d.supplier)                          AS supplier_market,
    -- SUNDRY-ORIGIN identity: same function, after dropping the batch
    -- suffix the sundry entries carry. Proven a no-op on market rows.
    public.canonical_supplier(split_part(d.supplier, ' - ', 1))    AS supplier_origin,
    d.weight_kg,
    d.cost_basis,
    d.cost_basis > 0                                               AS is_priced
  FROM public.deliveries d
  WHERE d.transaction_date IS NOT NULL
),
market AS (
  SELECT
    month_start,
    supplier_market                                                        AS supplier_canonical,
    sum(weight_kg)::numeric                                                AS kg,
    count(*)::int                                                          AS delivery_count,
    COALESCE(sum(weight_kg) FILTER (WHERE is_priced), 0)::numeric          AS priced_kg,
    COALESCE(sum(cost_basis * weight_kg) FILTER (WHERE is_priced), 0)::numeric
                                                                           AS php_total
  FROM classed
  WHERE delivery_class = 'market'
  GROUP BY 1, 2
),
sundry AS (
  SELECT
    month_start,
    supplier_origin                                                        AS supplier_canonical,
    sum(weight_kg)::numeric                                                AS sundry_origin_kg,
    count(*)::int                                                          AS sundry_origin_delivery_count
  FROM classed
  WHERE delivery_class = 'sundry_reentry'
  GROUP BY 1, 2
),
pairs AS (
  SELECT month_start, supplier_canonical FROM market
  UNION
  SELECT month_start, supplier_canonical FROM sundry
),
joined AS (
  SELECT
    p.month_start,
    p.supplier_canonical,
    COALESCE(m.kg, 0)::numeric                    AS kg,
    COALESCE(m.delivery_count, 0)                 AS delivery_count,
    COALESCE(m.priced_kg, 0)::numeric             AS priced_kg,
    COALESCE(m.php_total, 0)::numeric             AS php_total,
    COALESCE(s.sundry_origin_kg, 0)::numeric      AS sundry_origin_kg,
    COALESCE(s.sundry_origin_delivery_count, 0)   AS sundry_origin_delivery_count,
    -- the MONTH's own published figures — joined, never re-summed
    r.market_kg                                   AS month_market_kg,
    r.market_avg_price                            AS month_avg_price_php_kg
  FROM pairs p
  LEFT JOIN market m
         ON m.month_start = p.month_start AND m.supplier_canonical = p.supplier_canonical
  LEFT JOIN sundry s
         ON s.month_start = p.month_start AND s.supplier_canonical = p.supplier_canonical
  LEFT JOIN public.view_analytics_rcin_monthly r
         ON r.month_start = p.month_start
)
SELECT
  month_start,
  EXTRACT(year  FROM month_start)::int                              AS year,
  EXTRACT(month FROM month_start)::int                              AS month,
  supplier_canonical,

  -- VOLUME (market only)
  kg,
  delivery_count,
  priced_kg,
  (100.0 * priced_kg / NULLIF(kg, 0))::numeric                      AS price_coverage_pct,

  -- MONEY (weighted over priced kilos only)
  (php_total / NULLIF(priced_kg, 0))::numeric                       AS avg_price_php_kg,
  php_total,

  -- SHARE + CONCENTRATION (NULL, never 0, on a row with no market kilos)
  CASE WHEN kg > 0
       THEN (100.0 * kg / NULLIF(month_market_kg, 0))::numeric
  END                                                               AS share_of_month_pct,
  CASE WHEN kg > 0
       THEN rank() OVER (PARTITION BY month_start ORDER BY kg DESC)
  END                                                               AS kg_rank_in_month,
  CASE WHEN kg > 0
       THEN (100.0 * sum(kg) FILTER (WHERE kg > 0) OVER (
               PARTITION BY month_start
               ORDER BY kg DESC, supplier_canonical
               ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW)
             / NULLIF(month_market_kg, 0))::numeric
  END                                                               AS cumulative_share_pct,

  -- PREMIUM: paid above (+) or below (-) the month's market average
  ((php_total / NULLIF(priced_kg, 0)) - month_avg_price_php_kg)::numeric
                                                                    AS premium_php_kg,

  -- RECOVERY (traceability only — never volume, never priced)
  sundry_origin_kg,
  sundry_origin_delivery_count,

  -- the month's own published reference figures, carried so a single row
  -- is self-auditable without a second query
  month_market_kg,
  month_avg_price_php_kg
FROM joined;

COMMENT ON VIEW public.view_analytics_supplier_monthly IS
  'WHO WE BOUGHT FROM, MONTH BY MONTH. One row for every supplier who sold to us in a given month. '
  'Only real PURCHASES are counted here: our own charcoal coming back after sun-drying, and anything '
  're-cooked or re-fed, is left out of the kilos, the price and the share, because we already paid '
  'for it once and counting it again would both inflate the tonnage and drag the average price down. '
  'A supplier is identified by the canonical name, so the different spellings of one seller — and the '
  'joint-vendor entries — appear as ONE supplier, not several. kg is what they delivered. '
  'avg_price_php_kg is the weighted peso-per-kilo we paid THEM that month (their total pesos over '
  'their total kilos, never an average of daily prices), counting only truckloads that already have a '
  'price on them; price_coverage_pct says what share of their month that price speaks for. '
  'SHARE is their kilos as a percentage of everything the plant bought that month — read it with '
  'kg_rank_in_month and cumulative_share_pct to answer "how much of our supply comes from the top one '
  'or top three sellers", which is the dependency-risk question. PREMIUM is the plain answer to "did '
  'we pay this supplier more or less than the going rate": their weighted price minus the month''s '
  'overall market price, in pesos per kilo — POSITIVE means we paid them ABOVE market, negative means '
  'below. It is left BLANK rather than shown as zero whenever either side has no priced kilos, '
  'because "we do not know yet" is not the same answer as "exactly at market". Averaging the premium '
  'across suppliers only makes sense weighted by kilos — weighted that way it comes to zero every '
  'month by construction, since the market price IS the kilo-weighted average of the supplier prices. '
  'sundry_origin_kg is a TRACEABILITY figure and is deliberately kept out of every other number on '
  'the row: it is how many kilos of returning sun-dried charcoal carried this supplier''s name that '
  'month. A supplier can therefore appear with zero purchased kilos in a month where only their '
  'returning material moved. The month totals this row is measured against (month_market_kg, '
  'month_avg_price_php_kg) are read straight from the monthly RC IN analytics view rather than '
  'recalculated, so the supplier breakdown can never disagree with the monthly matrix. CONTAINS PESO '
  'COLUMNS (avg_price_php_kg, php_total, premium_php_kg, month_avg_price_php_kg) — the server action '
  'must null them for anyone who cannot see prices; the volume, share and participation columns carry '
  'no peso and are safe for every role.';

GRANT SELECT ON public.view_analytics_supplier_monthly TO authenticated;
REVOKE ALL ON public.view_analytics_supplier_monthly FROM anon;
