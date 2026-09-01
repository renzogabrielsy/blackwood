-- =====================================================================
-- ICTC Owner Analytics — PHASE 1 data layer
-- Plan: .agents/plans/ictc-analytics-dashboard-plan.md  (P1 — "the matrix")
--
-- One classifier function + three monthly views. No new tables, no
-- snapshot jobs: the RC side is fully event-sourced (every kilo in is a
-- dated `deliveries` row, every kilo out a dated `rc_out` row), so
-- "inventory as of any past month-end" is a VIEW, not a pipeline.
--
-- POSTURE (all three views, template `20260828032427_digest_rcin_supplier_daily`):
--   security_invoker · SELECT to `authenticated` only · anon REVOKEd ·
--   NOT granted to service_role (the sync worker reads none of them;
--   L-044's arrow direction — a consumer is not a dependency).
--   `scripts/verify-worker-view-grants.ts` must still read 4 views / 0
--   findings after this migration.
--
-- WINDOWING. CLAUDE.md's 400-trailing-day idiom governs DAILY views,
-- where PostgREST's 1000-row ASCENDING truncation silently eats the most
-- recent days. These are MONTHLY grains and are therefore unwindowed and
-- span ALL history on purpose: measured row counts are 49 / 75 / 75 —
-- two orders of magnitude under the cap, and a month-on-month matrix that
-- could not reach 2024 would not be the thing Renzo asked for.
--
-- ₱ COLUMNS live in `view_analytics_rcin_monthly` (market_avg_price,
-- market_php_total) and `view_analytics_inventory_eom` (ending_value_php,
-- avg_unit_cost_php_kg). They are NOT split into sibling views: the whole
-- point of the matrix is that one row of a month reads across, and a
-- split would force the page's server action to stitch two reads back
-- together on every request just to re-create the row it started with.
-- The gate stays where `canViewPrices()` already is — the server action
-- NULLs those four fields BEFORE the payload leaves the server, exactly
-- as `rc-movement-matrix.tsx` already drops its Fed ₱/kg column.
-- `view_analytics_flow_monthly` carries no ₱ and none is derivable.
-- =====================================================================


-- ---------------------------------------------------------------------
-- 1. fn_delivery_class — THE definition of what KIND of delivery a row is
-- ---------------------------------------------------------------------
-- Renzo, 2026-09-01: the `<Supplier> - <BLOCK>` entries are not a spelling
-- problem, they are SUNDRY RE-ENTRIES — material we already bought coming
-- back in after sun-drying. Counting them as purchases double-counts the
-- kilos and drags the market price toward the recovery price. Same for
-- re-cooked / re-fed material. So market-price and purchase-volume KPIs
-- read the `market` class only, and the other two classes become their
-- own recovery KPI rows.
--
-- WHY THREE ARGUMENTS when the class is nominally "about the batch code".
-- Because the code alone is provably not enough, and each extra argument
-- was added for MEASURED rows, not for symmetry:
--   * p_supplier — 2 deliveries carry a re-cook signal ONLY in the
--     supplier field, on ordinary block/feed codes: 2024-11-15 "Re-cook"
--     on NOV-24-BLK4 (13,270 kg @ P1.50) and 2025-10-06
--     "Re-cook/Lapayag bernie" on OCT-25-FEED1 (2,005 kg @ P1.75). Those
--     prices are PROCESSING FEES, not market prices; letting them into a
--     weighted average is the L-008 unpriced-placeholder mistake wearing
--     a different hat.
--   * p_remarks — exactly 1 delivery (NOV-25-SUNDRY4, 2025-11-17,
--     2,710 kg) sits on a SUNDRY batch while its remark says "FOR
--     SUNDRYING": it is fresh charcoal on its way OUT to dry, not dried
--     charcoal coming back. Renzo's own correction of 2026-06-16.
-- Call it with one argument for a code-only opinion; the views pass all
-- three. This is a DEFAULTed single function, never an overload.
--
-- WHY THIS EXACT PREDICATE. It is, arm for arm, the population rule
-- already carried by the four Summaries analytics views (canonical
-- migration 20260616031158) — deliberately, so the platform never grows
-- a second definition of "monthly average purchase price". PROVEN, not
-- assumed: across all 49 months of delivery history the market class
-- reproduces `view_delivery_monthly_analytics` with ZERO mismatches on
-- delivery count, kg and weighted price. What this function adds is the
-- SPLIT — Summaries only ever needed to drop the non-market rows; the
-- analytics matrix has to report them as recovery volume.
--
-- PRECEDENCE: recook_refeed is tested FIRST. A code that somehow said
-- both (none does today) describes material re-entering the process, and
-- the re-feed is the later event. Both are excluded from market either
-- way, so precedence only decides which recovery row it lands on.
--
-- RAW / JUNK LABELS — what they get, and why:
--   * 'RECOOKED' (a real `batches` row, -15,776 kg) → recook_refeed, on
--     the plain word match. No special case needed.
--   * The FEEDING family — 'FEED' (13 deliveries, 234,638 kg, 2024),
--     'FEEDING # 1/2', 'FEEDING AREA # 1..4', 'FEED-PAQUIBOT' — is
--     **market**, and that is a decision from evidence, not a fallthrough
--     we tolerated: every one of those 13 `FEED` deliveries is a Paquibot
--     truckload priced P19.50-P25.00, i.e. a bought truck tipped straight
--     into the feeding area instead of into a block. The regular
--     `<MONTH>-<YY>-FEEDn` family agrees (115 rows, weighted P41.70,
--     7 suppliers). A delivery to the feeding area is a PURCHASE.
--     Note 'REFEED' contains 'FEED', which is only safe because the
--     recook/refeed arm is tested first and nothing keys off 'FEED'.
--   * 'BLENDING', 'JUL22-BLK3', 'B02'/'B04'/'B08', the QA/test codes →
--     market by the same fallthrough. None of them carries a delivery
--     today (they exist only as `batches` rows with fed-out balances), so
--     the choice moves no number; it is stated so the next reader knows
--     it was considered.
--   * 'DEC-25-SUN5' is a deliberate NEAR-MISS: '%SUNDR%' does not match
--     'SUN5', so it classes market. Its evidence agrees — plate RKK449,
--     an MC deduction in the remarks, P45.25/kg. It is a bought truck.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_delivery_class(
  p_batch_code text,
  p_supplier   text DEFAULT NULL,
  p_remarks    text DEFAULT NULL
) RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
  SELECT CASE
    WHEN p_batch_code ILIKE '%RECOOK%'
      OR p_batch_code ILIKE '%REFEED%'
      OR p_supplier   ILIKE '%refeed%'  OR p_supplier ILIKE '%re-feed%' OR p_supplier ILIKE '%re feed%'
      OR p_supplier   ILIKE '%recook%'  OR p_supplier ILIKE '%re-cook%' OR p_supplier ILIKE '%re cook%'
      THEN 'recook_refeed'
    WHEN p_batch_code ILIKE '%SUNDR%'
      AND COALESCE(p_remarks, '') NOT ILIKE '%FOR SUNDR%'
      THEN 'sundry_reentry'
    ELSE 'market'
  END;
$$;

COMMENT ON FUNCTION public.fn_delivery_class(text, text, text) IS
  'What KIND of arrival a delivery row is — the ONE definition, used by every analytics view. '
  'Returns market | sundry_reentry | recook_refeed. MARKET = charcoal we actually bought from a '
  'supplier this month; it is the only class that belongs in a purchase-price or purchase-volume '
  'number. SUNDRY_REENTRY = our own charcoal coming back in after sun-drying (we already paid for '
  'it once, so counting it again would double-count the kilos and pull the average price down) — '
  'it is a RECOVERY figure and gets its own KPI row. RECOOK_REFEED = material re-entering the '
  'process after re-cooking or being re-fed from the tank; the peso figure on those rows is a '
  'processing fee (P1.50-P1.75/kg), not a market price. A delivery tipped straight into the '
  'FEEDING AREA is a purchase and reads market. Pass just the batch code for a code-only opinion; '
  'the supplier and remarks arguments exist because 2 re-cooks announce themselves only in the '
  'supplier name and 1 sundry-batch row is flagged "FOR SUNDRYING" (an outbound, still market). '
  'The market population is byte-identical to view_delivery_monthly_analytics on all 49 months of '
  'history — one definition, deliberately, never two.';

REVOKE EXECUTE ON FUNCTION public.fn_delivery_class(text, text, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.fn_delivery_class(text, text, text) FROM anon;
GRANT  EXECUTE ON FUNCTION public.fn_delivery_class(text, text, text) TO authenticated;


-- ---------------------------------------------------------------------
-- 2. view_analytics_rcin_monthly — the market read, month by month
-- ---------------------------------------------------------------------
-- Grain: one row per calendar month that has at least one delivery
-- (measured: 49 rows, 2020-07 .. 2026-08). A month with NO delivery has
-- NO ROW — read that as "nothing arrived". The complete month spine lives
-- in view_analytics_flow_monthly; join to it if the UI needs empty
-- columns rendered.
--
-- Weighted, never an average of averages: market_php_total and
-- market_priced_kg are both exposed so a quarter or a year rolls up as
-- SUM(php)/SUM(kg) instead of AVG(price).
--
-- PRICED-ONLY, per Database Rules (L-008 / L-039): cost_basis = 0 is the
-- "not priced yet" placeholder, not a free truckload, so it contributes
-- to neither side of the average. price_coverage_pct is the honesty
-- column that says how much of the month the price actually speaks for.
-- Measured 2026-09-01: every one of the 1,727 deliveries in the table is
-- priced, so coverage reads 100.00 on every month today. That is a fact
-- about right now, not a guarantee — the column is what will show the gap
-- the next time Czarina's file lags.
-- ---------------------------------------------------------------------
CREATE OR REPLACE VIEW public.view_analytics_rcin_monthly
WITH (security_invoker = true) AS
WITH classed AS (
  SELECT
    date_trunc('month', d.transaction_date)::date            AS month_start,
    public.fn_delivery_class(d.batch_code, d.supplier, d.remarks) AS delivery_class,
    d.weight_kg,
    d.cost_basis,
    d.cost_basis > 0                                          AS is_priced,
    public.canonical_supplier(d.supplier)                     AS supplier_canonical
  FROM public.deliveries d
  WHERE d.transaction_date IS NOT NULL
)
SELECT
  month_start,
  EXTRACT(year  FROM month_start)::int                        AS year,
  EXTRACT(month FROM month_start)::int                        AS month,

  -- MARKET (the purchase read)
  COALESCE(sum(weight_kg) FILTER (WHERE delivery_class = 'market'), 0)::numeric
                                                              AS market_kg,
  COALESCE(sum(weight_kg) FILTER (WHERE delivery_class = 'market' AND is_priced), 0)::numeric
                                                              AS market_priced_kg,
  (sum(cost_basis * weight_kg) FILTER (WHERE delivery_class = 'market' AND is_priced)
     / NULLIF(sum(weight_kg)  FILTER (WHERE delivery_class = 'market' AND is_priced), 0))::numeric
                                                              AS market_avg_price,
  COALESCE(sum(cost_basis * weight_kg) FILTER (WHERE delivery_class = 'market' AND is_priced), 0)::numeric
                                                              AS market_php_total,
  count(*) FILTER (WHERE delivery_class = 'market')::int       AS market_delivery_count,
  count(DISTINCT supplier_canonical) FILTER (WHERE delivery_class = 'market')::int
                                                              AS active_suppliers,
  (100.0 * sum(weight_kg) FILTER (WHERE delivery_class = 'market' AND is_priced)
     / NULLIF(sum(weight_kg) FILTER (WHERE delivery_class = 'market'), 0))::numeric
                                                              AS price_coverage_pct,

  -- RECOVERY (not purchases — reported beside the market row, never inside it)
  COALESCE(sum(weight_kg) FILTER (WHERE delivery_class = 'sundry_reentry'), 0)::numeric
                                                              AS sundry_reentry_kg,
  count(*) FILTER (WHERE delivery_class = 'sundry_reentry')::int
                                                              AS sundry_reentry_delivery_count,
  COALESCE(sum(weight_kg) FILTER (WHERE delivery_class = 'recook_refeed'), 0)::numeric
                                                              AS recook_kg,
  count(*) FILTER (WHERE delivery_class = 'recook_refeed')::int
                                                              AS recook_delivery_count,

  -- EVERYTHING that physically arrived (market + sundry + recook, by construction)
  COALESCE(sum(weight_kg), 0)::numeric                         AS all_arrivals_kg,
  count(*)::int                                                AS delivery_count
FROM classed
GROUP BY month_start;

COMMENT ON VIEW public.view_analytics_rcin_monthly IS
  'WHAT WE BOUGHT, MONTH BY MONTH. One row per calendar month that had at least one delivery; a '
  'month with nothing arriving has no row at all. "Market" means charcoal actually bought from a '
  'supplier — our own charcoal coming back from sun-drying, and anything re-cooked or re-fed, is '
  'kept OUT of the price and volume figures and reported separately as recovery, because paying '
  'for it twice is not a purchase. market_avg_price is the weighted average peso-per-kilo across '
  'the month''s priced market kilos (total pesos divided by total kilos, never the average of the '
  'daily prices); a truckload still waiting on its price is left out of BOTH halves of that sum '
  'rather than counted as free, and price_coverage_pct tells you what share of the month the price '
  'speaks for. active_suppliers counts the distinct suppliers who actually sold to us that month, '
  'after folding the spelling variants together — it is the participation half of the '
  'price-brings-sellers-to-the-gate story. market_php_total and market_priced_kg are both here so a '
  'quarter or a year is rolled up as total-pesos-over-total-kilos, never as an average of monthly '
  'averages. CONTAINS PESO COLUMNS (market_avg_price, market_php_total) — the server action must '
  'null them for anyone who cannot see prices. Verified: this market population matches the '
  'Summaries monthly analytics exactly on all 49 months.';

GRANT SELECT ON public.view_analytics_rcin_monthly TO authenticated;
REVOKE ALL ON public.view_analytics_rcin_monthly FROM anon;


-- ---------------------------------------------------------------------
-- 3. view_analytics_flow_monthly — in / out / net, and the WORKING DAY
-- ---------------------------------------------------------------------
-- Grain: EVERY month from the first recorded event to the current
-- Asia/Manila month, zero-filled (measured: 75 rows, 2020-07 .. 2026-09).
-- This is the complete month spine — the other two views hang off it.
--
-- in_kg is ALL deliveries, including sundry re-entry and re-cooks,
-- deliberately: the flow view answers "did the yard grow or shrink", and
-- a re-entering truckload physically arrived and physically takes up
-- space. The purchase question is the other view's job. So
-- flow.in_kg = rcin_monthly.all_arrivals_kg, never market_kg.
--
-- WORKING DAY — ONE definition, and every per-working-day figure on the
-- page must come from here: a day on which ANY of the three streams
-- recorded something (a delivery, a feeding, or a production shift). It
-- is OBSERVED activity, not a calendar rule and not a shift plan — the
-- shift plan was deleted on 2026-08-28 and nothing in the database
-- records intent any more (see CLAUDE.md, "the new rule''s one blind
-- spot"). Measured 2025-2026 it lands at 22-27 days a month against
-- 28-31 calendar days, i.e. a six-day week with rest days, which is the
-- plant. Its one honest weakness: a total plant-wide outage day cannot be
-- told from a holiday.
-- ---------------------------------------------------------------------
CREATE OR REPLACE VIEW public.view_analytics_flow_monthly
WITH (security_invoker = true) AS
WITH events AS (
  SELECT transaction_date AS event_date, weight_kg AS in_kg, 0::numeric AS out_kg, 1 AS in_n, 0 AS out_n
  FROM public.deliveries WHERE transaction_date IS NOT NULL
  UNION ALL
  SELECT transaction_date, 0::numeric, weight_kg, 0, 1
  FROM public.rc_out     WHERE transaction_date IS NOT NULL
),
active_days AS (
  SELECT transaction_date AS d FROM public.deliveries        WHERE transaction_date IS NOT NULL
  UNION
  SELECT transaction_date FROM public.rc_out                 WHERE transaction_date IS NOT NULL
  UNION
  SELECT transaction_date FROM public.production_shifts      WHERE transaction_date IS NOT NULL
),
spine AS (
  SELECT generate_series(
           (SELECT date_trunc('month', min(x.d)) FROM (
              SELECT min(event_date) AS d FROM events
              UNION ALL SELECT min(d) FROM active_days) x),
           date_trunc('month', (now() AT TIME ZONE 'Asia/Manila')::date),
           INTERVAL '1 month')::date AS month_start
),
flow AS (
  SELECT date_trunc('month', event_date)::date AS month_start,
         sum(in_kg) AS in_kg, sum(out_kg) AS out_kg,
         sum(in_n)::int AS delivery_count, sum(out_n)::int AS feeding_count
  FROM events GROUP BY 1
),
wd AS (
  SELECT date_trunc('month', d)::date AS month_start, count(*)::int AS working_days
  FROM active_days GROUP BY 1
)
SELECT
  s.month_start,
  EXTRACT(year  FROM s.month_start)::int                       AS year,
  EXTRACT(month FROM s.month_start)::int                       AS month,
  LEAST((s.month_start + INTERVAL '1 month' - INTERVAL '1 day')::date,
        (now() AT TIME ZONE 'Asia/Manila')::date)              AS as_of_date,
  (s.month_start + INTERVAL '1 month' - INTERVAL '1 day')::date
      > (now() AT TIME ZONE 'Asia/Manila')::date               AS is_partial_month,
  COALESCE(f.in_kg,  0)::numeric                               AS in_kg,
  COALESCE(f.out_kg, 0)::numeric                               AS out_kg,
  (COALESCE(f.in_kg, 0) - COALESCE(f.out_kg, 0))::numeric      AS net_kg,
  COALESCE(w.working_days, 0)::int                             AS working_days,
  (COALESCE(f.out_kg, 0) / NULLIF(w.working_days, 0))::numeric AS out_per_working_day,
  (COALESCE(f.in_kg,  0) / NULLIF(w.working_days, 0))::numeric AS in_per_working_day,
  COALESCE(f.delivery_count, 0)::int                           AS delivery_count,
  COALESCE(f.feeding_count,  0)::int                           AS feeding_count
FROM spine s
LEFT JOIN flow f ON f.month_start = s.month_start
LEFT JOIN wd   w ON w.month_start = s.month_start;

COMMENT ON VIEW public.view_analytics_flow_monthly IS
  'DID WE BUILD STOCK OR DRAW IT DOWN, MONTH BY MONTH. One row for every month from the first '
  'record to the current one, including months where nothing happened (those read zero rather than '
  'vanishing) — this is the complete month spine the other analytics views hang off. in_kg is '
  'everything that physically rolled through the gate, including our own charcoal coming back from '
  'sun-drying, because the yard does not care who owned it; use the RC IN monthly view when the '
  'question is what we BOUGHT. out_kg is everything fed to the plant. net_kg is the difference: '
  'positive means the pile grew that month, negative means we ate into it. WORKING DAYS is the one '
  'definition on the page — a day the site actually did something, meaning a delivery arrived, '
  'charcoal was fed, or a production shift was reported. It is measured from what happened, not '
  'from a calendar or a roster, and it typically lands at 22-27 days against a 28-31 day month. '
  'Divide by it whenever comparing a short month with a long one — February moving less tonnage '
  'than March is usually February being February. Its one blind spot: a day the whole site was '
  'down looks exactly like a rest day. Carries NO peso column and none can be derived, so it is '
  'safe for every role including Production.';

GRANT SELECT ON public.view_analytics_flow_monthly TO authenticated;
REVOKE ALL ON public.view_analytics_flow_monthly FROM anon;


-- ---------------------------------------------------------------------
-- 4. view_analytics_inventory_eom — the as-of month-end stock series
-- ---------------------------------------------------------------------
-- Grain: one row per month of the spine (measured: 75 rows). Every figure
-- is REBUILT FROM EVENTS, per batch, as of that month-end:
--     balance(batch, eom) = SUM(deliveries <= eom) - SUM(rc_out <= eom)
-- which is the same arithmetic `fn_recompute_batch_state` applies to
-- `batches.current_weight` — so the newest row of this series is the live
-- table. PROVEN, not assumed (2026-09-01): reconstructed 8,492,517.09 kg
-- vs SUM(batches.current_weight) 8,492,517.09 kg, gap 0.00 kg, and NOT ONE
-- of the 714 batches disagrees by more than 0.005 kg.
--
-- THE NUMBER HAS A HOLE IN IT AND THE VIEW SAYS SO. Today 52 of the 55
-- IN-USE batches carry a NEGATIVE reconstructed balance totalling
-- -3.0M kg, against +11.5M kg of positive balances. That is not
-- evaporation, it is MISATTRIBUTION: charcoal fed out under one batch
-- code whose arrival was booked under another spelling (the L-042
-- shorthand bug is exactly this — 'FEEDING # 2' holds 18,650 kg of
-- phantom weight while AUG-26-FEED2 reads -3,000 kg). The NET is still
-- the right headline, because the two sides are the same physical yard
-- and they cancel; but netting -3.0M kg into an 8.5M kg total silently
-- would be the Cenapro receipts_php mistake again — a right number with
-- an invisible gap. So positive_balance_kg / negative_balance_kg /
-- negative_batch_count ride alongside and the UI can print the caveat.
--
-- ACTIVE BATCH = reconstructed balance > 500 kg. Measured at now: 516
-- batches hold a positive balance, but 81 of them sit in the (0, 500] kg
-- band holding 13,590 kg BETWEEN THEM — 0.16% of positive stock, i.e.
-- rounding dust and closed-out residue, not a pile anyone would go and
-- look at. 435 batches clear the threshold.
--
-- ENDING VALUE uses the AVG-COST BASIS, per the plan: each batch's
-- remaining kilos are valued at that batch's own weighted average
-- purchase cost as of that month-end, over PRICED deliveries only
-- (cost_basis > 0 — the L-008 rule, the same narrowing
-- fn_recompute_batch_state applies to batches.avg_cost). It is what the
-- charcoal on hand COST, not what it would fetch, and it deliberately
-- does NOT include the shrinkage uplift that view_rc_movement_*_actual_price
-- measures on closed blocks — that is Phase 2's "true cost" layer and
-- mixing the two would produce a third definition of what a kilo cost.
-- ONLY POSITIVE balances are valued (a negative balance times a price is
-- not money), so ending_value_php pairs with positive_balance_kg, and
-- valued_kg / unvalued_kg / value_coverage_pct say exactly how much of
-- the stock the peso figure actually covers.
--
-- RUNWAY reads working_days and out_kg from view_analytics_flow_monthly
-- rather than recomputing them — one definition of a working day, and
-- the dependency is deliberate.
--
-- HISTORICAL LIMIT, stated because it is structural (plan limit #1):
-- blocks-occupied is NOT reconstructable. `batches.location_ref`
-- describes where a batch is NOW and is cleared and reused, so there is
-- no as-of block map; utilization of the 220 slots is a LIVE number the
-- page must read from view_blocking_grid, and no column here pretends
-- otherwise. Limit #2 also applies: batch status flips are not dated, so
-- there is no as-of STORED/IN-USE/CLOSED mix here either.
-- outflow_recorded exists because deliveries begin 2020-07-01 while
-- rc_out begins 2024-01-01: month-ends before consumption was being
-- recorded show a stock curve that only ever rises, and the column says
-- so rather than leaving the reader to notice.
-- ---------------------------------------------------------------------
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

COMMENT ON VIEW public.view_analytics_inventory_eom IS
  'HOW MUCH CHARCOAL WE WERE HOLDING AT THE END OF EACH MONTH, and what it had cost us. Nothing is '
  'snapshotted — every figure is rebuilt from the delivery and feeding records themselves, so the '
  'newest row equals the live inventory total exactly (checked: 8,492,517.09 kg both ways, zero '
  'difference), and correcting an old record correctly restates history. ending_kg is everything '
  'in minus everything out. Read it with the two companion figures beside it: some batches carry a '
  'NEGATIVE balance because charcoal was fed out under one batch name while its arrival was booked '
  'under a different spelling of that name — the kilos are real and in the yard, they are just '
  'filed against the wrong pile, so the two sides cancel in the total but the split is worth '
  'seeing. active_batches counts piles holding more than 500 kg; below that is rounding dust from '
  'closed-out batches, not stock. RUNWAY is the plain survival number: at the rate we fed the plant '
  'that month, how many working days would the pile last. ENDING VALUE prices each pile''s '
  'remaining kilos at what that pile itself cost us on average — what we paid, not what it would '
  'sell for, and it does not yet include the extra cost of charcoal that shrank while it sat '
  '(that is a later layer). Only piles with a positive balance are valued, and value_coverage_pct '
  'says how much of the stock the peso figure covers. TWO THINGS THIS CANNOT ANSWER, on purpose: '
  'how many of the 220 warehouse blocks were occupied in a past month (a batch only records where '
  'it is NOW, so read block occupancy live), and what the STORED/IN-USE/CLOSED mix was back then '
  '(status changes are not dated). outflow_recorded is false for early months where deliveries '
  'were being recorded but feedings were not, which makes the stock line rise forever; ignore '
  'those months. CONTAINS PESO COLUMNS (ending_value_php, avg_unit_cost_php_kg) — the server '
  'action must null them for anyone who cannot see prices.';

GRANT SELECT ON public.view_analytics_inventory_eom TO authenticated;
REVOKE ALL ON public.view_analytics_inventory_eom FROM anon;
