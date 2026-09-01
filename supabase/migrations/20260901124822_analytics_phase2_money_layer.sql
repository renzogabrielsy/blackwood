-- =====================================================================
-- ICTC Owner Analytics — PHASE 2 data layer: THE MONEY LAYER
-- Plan: .agents/plans/ictc-analytics-dashboard-plan.md  (P2 — "the money
-- layer": inventory value, true fed P/kg, loss % of closed blocks, aging
-- profile + watchlist, P-per-produced-kg).
--
-- Four views. No new tables, no snapshot jobs, and — the point of this
-- migration — NO NEW ARITHMETIC FOR ANY NUMBER THAT ALREADY HAS A HOME.
-- Delivered price, actual (shrinkage-adjusted) fed price, yield and
-- per-block loss are all OWNED by the existing rc_movement family
-- (view_rc_movement_month_price, _campaign_price, _campaign_actual_price,
-- _campaign_yield, _yield_monthly, _block_actual_price). These views
-- SELECT FROM those; they never re-implement them. Where a number here is
-- genuinely new it is built out of the existing views' own published
-- columns (see "THE ONE PIECE OF NEW MEASUREMENT" below).
--
-- POSTURE (identical to P1, template 20260901115129):
--   security_invoker · SELECT to `authenticated` only · anon REVOKEd ·
--   NOT granted to service_role (the sync worker reads none of them;
--   L-044's arrow direction — a consumer is not a dependency).
--   `scripts/verify-worker-view-grants.ts` must still read 4 views / 0
--   findings after this migration.
--
-- WINDOWING: none. Monthly and campaign grains are naturally tiny
-- (measured 75 / 32 / 75 / 170 rows), two orders of magnitude under
-- PostgREST's 1000-row cap, and a month-on-month money matrix that could
-- not reach 2024 would not be the thing Renzo asked for.
--
-- P COLUMNS — the complete list the server action must NULL when
-- `canViewPrices()` is false, before the payload leaves the server:
--   view_analytics_cost_monthly:
--     delivered_php_kg_fed, delivered_php_kg_fed_covered, fed_value_php,
--     php_per_produced_kg, php_per_produced_kg_covered,
--     closed_blocks_true_php_kg, closed_blocks_delivered_php_kg,
--     closed_blocks_uplift_php_kg
--   view_analytics_batch_cost:
--     delivered_php_kg_fed, fed_value_php, delivered_php_kg,
--     actual_fed_php_kg, campaign_weighted_actual_fed_php_kg,
--     uplift_php_kg, php_per_produced_kg_delivered,
--     php_per_produced_kg_true
--   view_analytics_aging_watchlist:
--     delivered_php_kg, value_php
--   view_analytics_aging_eom: NONE — it carries no peso column and none
--     is derivable, so it is safe for every role including Production.
--
-- TWO CONVENTIONS INHERITED, NOT INVENTED:
--   * loss_pct / yield_pct are FRACTIONS, not percents (0.0454 = 4.54%),
--     matching view_rc_movement_campaign_yield.yield_pct and
--     view_rc_movement_block_actual_price.loss_pct.
--   * NULL is never 0. An unpriced input makes a peso figure NULL and a
--     companion count explains the blank — the discipline of the
--     2026-08-07 ACTUAL FED P/kg views, verbatim.
-- =====================================================================


-- ---------------------------------------------------------------------
-- 1. view_analytics_cost_monthly — the CALENDAR-month money read
-- ---------------------------------------------------------------------
-- Grain: one row per month of `view_analytics_flow_monthly`, the P1 month
-- spine (measured 75 rows, 2020-07 .. 2026-09). Months before feeding was
-- recorded read NULL across the money columns rather than 0; the spine is
-- kept so the matrix has a column for every month either way.
--
-- WHAT EACH NUMBER IS, and WHOSE definition it is:
--
--   fed_kg / delivered_php_kg_fed        = view_rc_movement_month_price
--                                          .total_fed / .wtd_fed_price,
--                                          reproduced VERBATIM. That view
--                                          is THE definition of "the
--                                          delivered price of what we fed
--                                          this month" and nothing here
--                                          recomputes it.
--   produced_kg / yield_pct              = view_rc_movement_yield_monthly
--                                          .total_produced / .yield_pct,
--                                          verbatim. (Its total_fed is
--                                          byte-identical to the price
--                                          view's on all 31 fed months,
--                                          max gap 0.00 kg — checked, so
--                                          only one fed_kg is exposed.)
--   closed_blocks_*                      = aggregated straight out of
--                                          view_rc_movement_block_actual_price,
--                                          using ITS OWN close_date,
--                                          is_closed, is_fully_priced,
--                                          weight_lost_kg and
--                                          delivered_value_php columns.
--
-- THE ONE PIECE OF NEW MEASUREMENT, and why it had to exist.
-- view_rc_movement_month_price prices a month's fed kilos by joining each
-- fed batch to that batch's deliveries. A batch with NO delivery rows at
-- all (pre-system stock, or the L-042 phantom codes) contributes its
-- KILOS to the denominator and NOTHING to the numerator, so the published
-- price is UNDERSTATED by exactly the share of untraceable kilos. That is
-- not hypothetical: measured 2026-09-01, seven months are affected —
-- 2024-03 is 98.4% untraceable (its price is ~1/63rd of the truth),
-- 2024-04 75.2%, 2024-05 52.0%, 2024-06 59.4%, 2024-09 and 2024-10 ~0.2%,
-- and 2026-08 2.675% (that last one is 'FEEDING # 2' holding 18,650 kg of
-- phantom weight — CLAUDE.md's own KNOWN-NOT-FIXED item). 2024-01 and
-- 2024-02 are 100% untraceable and the published price is already NULL.
--
-- So this view adds fed_kg_price_traceable / fed_price_coverage_pct — and
-- it does NOT re-derive the price to get them. The split is taken from
-- view_rc_movement_block_actual_price.delivery_count (0 = that batch has
-- no delivery rows), which is the SAME condition that makes the price
-- view's batch_price NULL. Proven equivalent: the coverage percentages
-- computed this way reproduce the direct measurement on all seven
-- affected months exactly, and no batch_code has deliveries summing to
-- 0 kg (the only other way batch_price could be NULL). Nothing about the
-- published price changes; it is exposed verbatim and its weakness is now
-- VISIBLE instead of silent.
--
-- delivered_php_kg_fed_covered is the same money over only the traceable
-- kilos — the honest partial, the `priced_delivered_php_kg` idiom. It
-- equals delivered_php_kg_fed exactly whenever coverage is 100%, and it
-- is computed purely from the published view's two columns
-- (wtd_fed_price * total_fed is, algebraically, the money the numerator
-- actually contained).
--
-- PHP PER PRODUCED KG — the exact formula, both halves stated.
--   php_per_produced_kg          = (wtd_fed_price * total_fed) / total_produced
--                                = the month's fed VALUE divided by the
--                                  month's PRODUCED kilos.
--   Equivalently delivered_php_kg_fed / yield_pct — the same number.
--   It is NULL unless fed_price_coverage_pct = 100, because a numerator
--   missing money against a complete denominator understates and points
--   the exact opposite way from the insight the statistic exists to show
--   (the ACTUAL FED P/kg rule, third instance).
--   php_per_produced_kg_covered  = delivered_php_kg_fed_covered / yield_pct
--                                = what a produced kilo cost IF the
--                                  untraceable kilos cost what the
--                                  traceable ones did. Always available.
--                                  Measured 2026-08: the strict figure is
--                                  NULL, the covered figure is P53.07
--                                  against a naive P51.65.
--   BOTH USE THE DELIVERED PRICE, i.e. what the charcoal cost on arrival.
--   The TRUE (shrinkage-adjusted) cost of a produced kilo is final only
--   per CLOSED block and therefore lives on the BATCH basis, in
--   view_analytics_batch_cost.php_per_produced_kg_true. Mixing the two
--   here would create a third definition of what a kilo cost.
--
-- THE CLOSED-BLOCK COLUMNS, and the approximation they carry.
-- Batch CLOSE dates are not evented (plan limit #2), so "closed during
-- month M" is approximated by view_rc_movement_block_actual_price
-- .close_date, which is the batch's last feeding date — or, better when
-- one exists, the last feeding whose remarks say CLOSED. This is the
-- existing view's own approximation, reused rather than re-invented, so
-- the analytics layer and the RC Movement screen can never disagree about
-- which month a block closed in.
--   closed_blocks_loss_pct   = SUM(weight_lost_kg) / SUM(delivered_kg)
--                              over ALL blocks closed that month — the
--                              kg-weighted mean loss, never the mean of
--                              the per-block loss_pct. Loss is physical
--                              and needs no price, so it uses the widest
--                              population. IT CAN BE NEGATIVE and is not
--                              clamped: 2026-02 reads -0.001022, meaning
--                              those blocks fed out slightly more than was
--                              booked into them (the misattribution shape,
--                              not evaporation).
--   closed_blocks_true_php_kg = SUM(delivered_value_php) / SUM(total_fed_kg)
--                              over that month's closed blocks that are
--                              FULLY PRICED. A partially-priced block is
--                              EXCLUDED (never valued at its partial
--                              money), exactly as
--                              view_rc_movement_campaign_actual_price
--                              excludes one; NULL — never 0 — when the
--                              month has no fully-priced closed block.
--                              closed_blocks_in_price / _unpriced /
--                              _no_delivery let the UI print "16 of 17
--                              blocks priced" rather than a bare gap.
--   closed_blocks_delivered_php_kg is the SAME block set valued at the
--   ARRIVAL price, so closed_blocks_uplift_php_kg (true - delivered) is
--   literally the shrinkage cost: charcoal that lost weight while it sat
--   spread the money already spent over fewer kilos. Measured 2026-07:
--   P47.5603 true vs P45.3329 delivered = P2.2274/kg of shrinkage, on
--   4.68% weight loss.
-- ---------------------------------------------------------------------
CREATE OR REPLACE VIEW public.view_analytics_cost_monthly
WITH (security_invoker = true) AS
WITH untraceable AS (
  -- Batches whose fed kilos can carry NO delivered price, because the
  -- batch has no delivery rows at all. Taken from the existing block
  -- view's published delivery_count — not re-derived.
  SELECT batch_id
  FROM public.view_rc_movement_block_actual_price
  WHERE delivery_count = 0
),
coverage AS (
  SELECT date_trunc('month', r.transaction_date)::date              AS month_start,
         sum(r.weight_kg)                                           AS fed_kg_all,
         COALESCE(sum(r.weight_kg) FILTER (WHERE u.batch_id IS NULL), 0) AS fed_kg_traceable
  FROM public.rc_out r
  LEFT JOIN untraceable u ON u.batch_id = r.batch_id
  WHERE r.transaction_date IS NOT NULL
  GROUP BY 1
),
closed AS (
  SELECT date_trunc('month', b.close_date)::date                    AS month_start,
         count(*)::int                                              AS blocks_closed,
         count(*) FILTER (WHERE b.is_fully_priced)::int             AS blocks_in_price,
         count(*) FILTER (WHERE NOT b.is_fully_priced
                            AND b.delivery_count > 0)::int          AS blocks_unpriced,
         count(*) FILTER (WHERE b.delivery_count = 0)::int          AS blocks_no_delivery,
         sum(b.delivered_kg)                                        AS delivered_kg,
         sum(b.total_fed_kg)                                        AS fed_kg,
         sum(b.weight_lost_kg)                                      AS lost_kg,
         sum(b.delivered_value_php) FILTER (WHERE b.is_fully_priced) AS priced_value_php,
         sum(b.total_fed_kg)        FILTER (WHERE b.is_fully_priced) AS priced_fed_kg,
         sum(b.delivered_kg)        FILTER (WHERE b.is_fully_priced) AS priced_delivered_kg
  FROM public.view_rc_movement_block_actual_price b
  WHERE b.is_closed AND b.close_date IS NOT NULL
  GROUP BY 1
)
SELECT
  f.month_start,
  f.year,
  f.month,
  f.as_of_date,
  f.is_partial_month,

  -- ---- what we fed, and what it cost on ARRIVAL -------------------
  mp.total_fed                                                      AS fed_kg,
  mp.wtd_fed_price                                                  AS delivered_php_kg_fed,
  (mp.wtd_fed_price * mp.total_fed)                                 AS fed_value_php,
  COALESCE(c.fed_kg_traceable, 0)::numeric                          AS fed_kg_price_traceable,
  (COALESCE(c.fed_kg_all, 0) - COALESCE(c.fed_kg_traceable, 0))::numeric
                                                                    AS fed_kg_price_untraceable,
  (100.0 * c.fed_kg_traceable / NULLIF(c.fed_kg_all, 0))::numeric   AS fed_price_coverage_pct,
  (mp.wtd_fed_price * mp.total_fed / NULLIF(c.fed_kg_traceable, 0)) AS delivered_php_kg_fed_covered,

  -- ---- what came out the other end --------------------------------
  ym.total_produced                                                 AS produced_kg,
  ym.yield_pct                                                      AS yield_pct,
  ym.loss_kg                                                        AS process_loss_kg,

  -- ---- the unit-economics number ----------------------------------
  CASE WHEN c.fed_kg_all IS NOT NULL AND c.fed_kg_traceable = c.fed_kg_all
       THEN (mp.wtd_fed_price * mp.total_fed) / NULLIF(ym.total_produced, 0)
  END                                                               AS php_per_produced_kg,
  ((mp.wtd_fed_price * mp.total_fed / NULLIF(c.fed_kg_traceable, 0))
     / NULLIF(ym.yield_pct, 0))                                     AS php_per_produced_kg_covered,

  -- ---- blocks that finished this month ----------------------------
  COALESCE(cl.blocks_closed, 0)                                     AS closed_blocks_count,
  COALESCE(cl.blocks_in_price, 0)                                   AS closed_blocks_in_price,
  COALESCE(cl.blocks_unpriced, 0)                                   AS closed_blocks_unpriced,
  COALESCE(cl.blocks_no_delivery, 0)                                AS closed_blocks_no_delivery,
  cl.delivered_kg                                                   AS closed_blocks_delivered_kg,
  cl.fed_kg                                                         AS closed_blocks_fed_kg,
  cl.lost_kg                                                        AS closed_blocks_lost_kg,
  (cl.lost_kg / NULLIF(cl.delivered_kg, 0))                         AS closed_blocks_loss_pct,
  (cl.priced_value_php / NULLIF(cl.priced_fed_kg, 0))               AS closed_blocks_true_php_kg,
  (cl.priced_value_php / NULLIF(cl.priced_delivered_kg, 0))         AS closed_blocks_delivered_php_kg,
  (cl.priced_value_php / NULLIF(cl.priced_fed_kg, 0)
     - cl.priced_value_php / NULLIF(cl.priced_delivered_kg, 0))     AS closed_blocks_uplift_php_kg,
  cl.priced_fed_kg                                                  AS closed_blocks_priced_fed_kg
FROM public.view_analytics_flow_monthly f
LEFT JOIN public.view_rc_movement_month_price    mp ON mp.month_start = f.month_start
LEFT JOIN public.view_rc_movement_yield_monthly  ym ON ym.month_start = f.month_start
LEFT JOIN coverage                                c ON c.month_start  = f.month_start
LEFT JOIN closed                                 cl ON cl.month_start = f.month_start;

COMMENT ON VIEW public.view_analytics_cost_monthly IS
  'WHAT THE CHARCOAL WE FED COST US, CALENDAR MONTH BY CALENDAR MONTH. This is the CALENDAR basis — '
  'January means the days in January. The other half of the money layer, view_analytics_batch_cost, '
  'answers the same questions per PRODUCTION BATCH (what did AUGUST-the-campaign cost), which is a '
  'different and also-true answer because a campaign routinely runs across a month boundary. '
  'fed_kg and delivered_php_kg_fed are the RC Movement screen''s own monthly figures, taken '
  'unchanged, so the two screens can never disagree: the price is the weighted average arrival cost '
  'of the kilos fed that month. WATCH THE COVERAGE COLUMN. Some kilos were fed out of piles that '
  'have no delivery record at all — old pre-system stock, and the misfiled "FEEDING # 2" pile — and '
  'those kilos carry no price, which drags the published price DOWN. fed_price_coverage_pct says '
  'what share of the month''s kilos the price actually speaks for (100 on every month except seven: '
  'most of early 2024, and August 2026 at 97.3%), and delivered_php_kg_fed_covered is the same money '
  'measured over only the kilos it covers — the honest figure when coverage is short. '
  'PHP_PER_PRODUCED_KG is the owner number: the month''s charcoal bill divided by the kilos of '
  'product that came out, i.e. what a kilo of finished product cost in raw charcoal. It is left '
  'BLANK rather than shown wrong whenever coverage is under 100%, and php_per_produced_kg_covered '
  'gives the honest estimate in its place. Both use the ARRIVAL price. The TRUE cost — which adds '
  'the money lost because charcoal shrinks while it sits — is only final once a block is closed, so '
  'it lives on the batch view. THE CLOSED-BLOCK ROWS are the shrinkage story in this view: '
  'closed_blocks_loss_pct is the weight those blocks lost as a share of what was delivered into '
  'them (a fraction, so 0.0468 means 4.68%), and it can go slightly NEGATIVE when a block fed out '
  'more than was booked in — that is misfiled paperwork, not a measurement error, and it is left '
  'visible. closed_blocks_true_php_kg is what those kilos really cost after the shrinkage, '
  'closed_blocks_delivered_php_kg is what they cost on arrival, and the difference between them '
  'IS the cost of letting charcoal sit. Only fully-priced blocks are counted in those peso figures — '
  'a block with one truckload still awaiting its price is left out entirely rather than valued at '
  'part of its money, and the count columns say how many that was. The month a block closed in is '
  'approximated by its last feeding day (or the feeding remarked CLOSED), because status changes are '
  'not dated anywhere. CONTAINS PESO COLUMNS — delivered_php_kg_fed, delivered_php_kg_fed_covered, '
  'fed_value_php, php_per_produced_kg, php_per_produced_kg_covered, closed_blocks_true_php_kg, '
  'closed_blocks_delivered_php_kg, closed_blocks_uplift_php_kg — which the server action must null '
  'for anyone who cannot see prices.';

GRANT SELECT ON public.view_analytics_cost_monthly TO authenticated;
REVOKE ALL ON public.view_analytics_cost_monthly FROM anon;


-- ---------------------------------------------------------------------
-- 2. view_analytics_batch_cost — the PRODUCTION-BATCH basis
-- ---------------------------------------------------------------------
-- Renzo's decision 2 of 2026-09-01: BOTH month bases, side by side and
-- labelled. Calendar months are the market read; a production campaign is
-- the COST read, because a campaign is the unit the plant actually runs
-- and it routinely straddles a month boundary (AUGUST closed and
-- SEPTEMBER opened on the same day, 2026-08-29).
--
-- This view is deliberately MOSTLY A JOIN. Every column below the spine
-- is lifted from a campaign view that already owns it:
--   view_rc_movement_campaign_options        -> the spine + fed span
--   view_rc_movement_campaign_price          -> delivered P/kg fed
--   view_rc_movement_campaign_actual_price   -> true (shrinkage-adjusted)
--                                               P/kg + ALL the coverage
--                                               columns, verbatim
--   view_rc_movement_campaign_yield          -> produced kg + yield
-- The only genuinely new columns are the campaign label, the fed-price
-- coverage pair (identical construction and identical justification to
-- the monthly view above) and the two unit-economics ratios.
--
-- THE SPINE IS A UNION, not campaign_options alone. campaign_options is
-- built from rc_out, so a campaign that has PRODUCED but not yet been fed
-- is missing from it — measured 2026-09-01, SEPTEMBER 2026 is exactly
-- that (7,506 kg produced, 0 kg fed, the campaign having opened on
-- 2026-08-29 under the L-046 tab rule). Driving off options alone would
-- make the current campaign vanish from the panel on the day it starts.
--
-- PHP PER PRODUCED KG, both bases, exact formulas:
--   php_per_produced_kg_delivered = (cp.wtd_fed_price * cp.total_fed)
--                                     / cy.total_produced
--     — the campaign's fed VALUE at ARRIVAL prices over its produced
--       kilos. Directly comparable to the calendar view's
--       php_per_produced_kg. NULL unless fed_price_coverage_pct = 100,
--       same rule, same reason.
--   php_per_produced_kg_true      = ap.campaign_weighted_actual_fed_php_kg
--                                     / cy.yield_pct
--     — THE number this whole phase exists for: what a kilo of finished
--       product cost in charcoal AFTER paying for the weight that
--       evaporated in the yard. campaign_weighted_actual_fed_php_kg is
--       used (not actual_fed_php_kg) because it is the one attributed to
--       THIS campaign's own fed kilos and is shaped to be directly
--       comparable to campaign_price — the same shape the delivered
--       figure has, so the two sit side by side honestly.
--       It is NULL unless is_fully_covered, i.e. unless EVERY block the
--       campaign fed is closed AND fully priced (blocks_in_price =
--       blocks_fed). An open block has no final fed total, so its true
--       cost does not exist yet; a partially-priced one has a numerator
--       missing money. Measured 2026-09-01, 2 of the 8 2026 campaigns are
--       not fully covered — FEBRUARY (24 of 25 blocks closed) and AUGUST
--       (17 closed, 16 priced, of 20) — and the coverage columns are
--       carried through so the UI prints "17 of 20 blocks closed" instead
--       of an unexplained blank.
--
-- The DELIVERED-vs-TRUE gap on this basis is the campaign's shrinkage
-- cost. Measured JULY 2026: delivered P46.0864, true P48.2579 whole-block
-- / P47.5780 campaign-weighted, on 4.50% weight loss.
-- ---------------------------------------------------------------------
CREATE OR REPLACE VIEW public.view_analytics_batch_cost
WITH (security_invoker = true) AS
WITH spine AS (
  SELECT production_batch, campaign_year FROM public.view_rc_movement_campaign_options
  UNION
  SELECT production_batch, campaign_year FROM public.view_rc_movement_campaign_yield
),
untraceable AS (
  SELECT batch_id FROM public.view_rc_movement_block_actual_price WHERE delivery_count = 0
),
coverage AS (
  SELECT r.production_batch,
         EXTRACT(year FROM r.transaction_date)::int                 AS campaign_year,
         sum(r.weight_kg)                                           AS fed_kg_all,
         COALESCE(sum(r.weight_kg) FILTER (WHERE u.batch_id IS NULL), 0) AS fed_kg_traceable
  FROM public.rc_out r
  LEFT JOIN untraceable u ON u.batch_id = r.batch_id
  WHERE r.transaction_date IS NOT NULL
    AND r.production_batch IS NOT NULL AND r.production_batch <> ''
  GROUP BY 1, 2
)
SELECT
  s.production_batch,
  s.campaign_year,
  (s.production_batch || ' ' || s.campaign_year::text)              AS campaign_label,
  o.min_date                                                        AS first_fed_date,
  o.max_date                                                        AS last_fed_date,
  o.feed_days::int                                                  AS feed_days,

  -- ---- fed volume + ARRIVAL price (view_rc_movement_campaign_price)
  COALESCE(o.total_fed, 0)::numeric                                 AS fed_kg,
  cp.wtd_fed_price                                                  AS delivered_php_kg_fed,
  (cp.wtd_fed_price * cp.total_fed)                                 AS fed_value_php,
  COALESCE(cv.fed_kg_traceable, 0)::numeric                         AS fed_kg_price_traceable,
  (COALESCE(cv.fed_kg_all, 0) - COALESCE(cv.fed_kg_traceable, 0))::numeric
                                                                    AS fed_kg_price_untraceable,
  (100.0 * cv.fed_kg_traceable / NULLIF(cv.fed_kg_all, 0))::numeric AS fed_price_coverage_pct,

  -- ---- TRUE fed price + coverage (view_rc_movement_campaign_actual_price, verbatim)
  ap.actual_fed_php_kg                                              AS actual_fed_php_kg,
  ap.campaign_weighted_actual_fed_php_kg                            AS campaign_weighted_actual_fed_php_kg,
  ap.delivered_php_kg                                               AS delivered_php_kg,
  ap.uplift_php_kg                                                  AS uplift_php_kg,
  ap.weight_lost_kg                                                 AS weight_lost_kg,
  ap.loss_pct                                                       AS loss_pct,
  ap.blocks_fed                                                     AS blocks_fed,
  ap.blocks_closed                                                  AS blocks_closed,
  ap.blocks_open                                                    AS blocks_open,
  ap.blocks_in_price                                                AS blocks_in_price,
  ap.blocks_closed_unpriced                                         AS blocks_closed_unpriced,
  ap.campaign_fed_kg_included                                       AS campaign_fed_kg_included,
  ap.campaign_fed_kg_excluded                                       AS campaign_fed_kg_excluded,
  ap.campaign_fed_kg_included_pct                                   AS campaign_fed_kg_included_pct,
  COALESCE(ap.is_fully_covered, false)                              AS is_fully_covered,

  -- ---- production + yield (view_rc_movement_campaign_yield, verbatim)
  cy.total_produced                                                 AS produced_kg,
  cy.yield_pct                                                      AS yield_pct,
  cy.loss_kg                                                        AS process_loss_kg,

  -- ---- the two unit-economics numbers -----------------------------
  CASE WHEN cv.fed_kg_all IS NOT NULL AND cv.fed_kg_traceable = cv.fed_kg_all
       THEN (cp.wtd_fed_price * cp.total_fed) / NULLIF(cy.total_produced, 0)
  END                                                               AS php_per_produced_kg_delivered,
  CASE WHEN ap.is_fully_covered
       THEN ap.campaign_weighted_actual_fed_php_kg / NULLIF(cy.yield_pct, 0)
  END                                                               AS php_per_produced_kg_true
FROM spine s
LEFT JOIN public.view_rc_movement_campaign_options      o  ON o.production_batch  = s.production_batch
                                                          AND o.campaign_year     = s.campaign_year
LEFT JOIN public.view_rc_movement_campaign_price        cp ON cp.production_batch = s.production_batch
                                                          AND cp.campaign_year    = s.campaign_year
LEFT JOIN public.view_rc_movement_campaign_actual_price ap ON ap.production_batch = s.production_batch
                                                          AND ap.campaign_year    = s.campaign_year
LEFT JOIN public.view_rc_movement_campaign_yield        cy ON cy.production_batch = s.production_batch
                                                          AND cy.campaign_year    = s.campaign_year
LEFT JOIN coverage                                      cv ON cv.production_batch = s.production_batch
                                                          AND cv.campaign_year    = s.campaign_year;

COMMENT ON VIEW public.view_analytics_batch_cost IS
  'WHAT EACH PRODUCTION CAMPAIGN COST — one row per production batch per year (AUGUST 2026, JULY '
  '2026, and so on). This is the BATCH basis, the companion to the calendar-month view. It exists '
  'because a campaign is what the plant actually runs, and campaigns cross month boundaries — '
  'AUGUST closed and SEPTEMBER opened on the same day — so "what did August the MONTH cost" and '
  '"what did AUGUST the CAMPAIGN cost" are two different, both correct, answers. Almost every '
  'figure here is lifted unchanged from the RC Movement campaign views, so this screen and that one '
  'can never disagree. THE TWO PRICES ARE THE POINT. delivered_php_kg_fed is what the charcoal cost '
  'when it arrived at the gate. actual_fed_php_kg is what it really cost by the time it was fed: '
  'charcoal dries out and loses weight while it sits, but the money already spent does not shrink, '
  'so every kilo that actually reached the plant cost more than the arrival price. The gap between '
  'the two IS the cost of storage time, and loss_pct (a fraction — 0.045 means 4.5%) is the weight '
  'behind it. Use campaign_weighted_actual_fed_php_kg when comparing against the delivered price: '
  'it is the version weighted by this campaign''s own kilos, so the two are like for like. The true '
  'price only exists once EVERY block the campaign fed has been closed and priced — an open block '
  'has no final total and a block with a truckload still awaiting its price has money missing — so '
  'it reads BLANK rather than wrong until then, and blocks_fed / blocks_closed / blocks_in_price '
  'let the screen say "17 of 20 blocks closed" instead of showing an unexplained gap. '
  'PHP_PER_PRODUCED_KG_TRUE is the number this whole layer was built for: what one kilo of finished '
  'product cost in charcoal, after paying for the weight that evaporated in the yard. Its arrival-'
  'price twin, php_per_produced_kg_delivered, sits beside it so the difference is readable. A '
  'campaign that has produced but not yet been fed still gets a row (September 2026 opened that '
  'way) rather than vanishing on the day it starts. CONTAINS PESO COLUMNS — delivered_php_kg_fed, '
  'fed_value_php, delivered_php_kg, actual_fed_php_kg, campaign_weighted_actual_fed_php_kg, '
  'uplift_php_kg, php_per_produced_kg_delivered, php_per_produced_kg_true — which the server action '
  'must null for anyone who cannot see prices.';

GRANT SELECT ON public.view_analytics_batch_cost TO authenticated;
REVOKE ALL ON public.view_analytics_batch_cost FROM anon;


-- ---------------------------------------------------------------------
-- 3. view_analytics_aging_eom — how OLD the stock was at each month-end
-- ---------------------------------------------------------------------
-- Grain: one row per month of the P1 spine (measured 75 rows). Same
-- event-sourced reconstruction as view_analytics_inventory_eom, extended
-- with one extra running sum so the pile has an AGE as well as a weight.
--
-- HOW THE AGE IS COMPUTED, and the approximation stated plainly.
-- There is no FIFO layer table and no attempt to invent one. Each batch
-- carries the KG-WEIGHTED MEAN DELIVERY DATE of everything delivered into
-- it up to that month-end:
--     mean_date(batch, eom) = SUM(weight_kg * delivery_date)
--                             / SUM(weight_kg)      [deliveries <= eom]
--     age_days              = eom - mean_date(batch, eom)
-- and the whole remaining balance carries that one age. So a pile filled
-- over three weeks ages as if every kilo arrived on the weighted middle
-- day, and drawing kilos out does not preferentially remove the old ones.
-- That is a DELIBERATE approximation, not an oversight: rc_out records
-- kilos leaving a BATCH, never which delivery within the batch they came
-- from, so a FIFO answer would be fiction dressed as precision. Deliveries
-- into one batch cluster within days of each other, so the error is small
-- against ages measured in hundreds of days.
-- Validated against the live table: SEPT-25-BLK4 reads 344.81 days, which
-- is the "345 days old" figure the plan quotes for that pile.
--
-- OPEN vs CLOSED, and why the split is load-bearing. A CLOSED block keeps
-- a small logged residual forever — the resiko/evaporation the plant
-- expects, which is LOSS, not stock nobody went to look at. Counted as
-- stock it poisons the whole profile: measured 2026-09-01 the all-balances
-- age is 415.7 days with the oldest at 2,253 days, versus 386.5 days and
-- 1,158 days once closed residue is set aside. So the headline columns
-- cover blocks NOT YET CLOSED at that month-end, and the residue rides
-- alongside as closed_residue_kg / closed_residue_batches.
-- "Not yet closed at that month-end" reuses view_rc_movement_block_actual_price
-- .close_date — the same last-feeding approximation the cost view above
-- uses, so both views draw the open/closed line in exactly the same place.
-- Checkable identity, and it is exact:
--     open_kg + closed_residue_kg = view_analytics_inventory_eom.positive_balance_kg
-- Cross-validated at the live end: 10,493,304.00 kg over 170 open batches
-- here equals the sum of current_weight over every non-CLOSED batch
-- holding more than a tonne, to the kilo.
--
-- pct_over_60d / pct_over_120d are PERCENTS (0-100), not fractions —
-- deliberately unlike loss_pct/yield_pct, because they are shares of a
-- population rather than a rate, and they sit beside price_coverage_pct
-- and value_coverage_pct in P1, which are percents too.
--
-- NEGATIVE balances are excluded from every figure here (a pile that owes
-- kilos has no age); their weight and count are already reported by
-- view_analytics_inventory_eom.
-- ---------------------------------------------------------------------
CREATE OR REPLACE VIEW public.view_analytics_aging_eom
WITH (security_invoker = true) AS
WITH del AS (
  SELECT d.batch_code,
         date_trunc('month', d.transaction_date)::date               AS month_start,
         sum(d.weight_kg)                                            AS in_kg,
         -- kg-days measured from a fixed epoch, so the running sums stay
         -- plain numerics and the mean date falls out as a division.
         sum(d.weight_kg * (d.transaction_date - DATE '2000-01-01')::numeric) AS in_kg_daynum
  FROM public.deliveries d
  WHERE d.transaction_date IS NOT NULL AND d.batch_code IS NOT NULL
  GROUP BY 1, 2
),
outk AS (
  SELECT b.batch_code,
         date_trunc('month', r.transaction_date)::date               AS month_start,
         sum(r.weight_kg)                                            AS out_kg
  FROM public.rc_out r
  JOIN public.batches b ON b.id = r.batch_id
  WHERE r.transaction_date IS NOT NULL
  GROUP BY 1, 2
),
deltas AS (
  SELECT COALESCE(d.batch_code, o.batch_code)   AS batch_code,
         COALESCE(d.month_start, o.month_start) AS month_start,
         COALESCE(d.in_kg, 0)                   AS in_kg,
         COALESCE(d.in_kg_daynum, 0)            AS in_kg_daynum,
         COALESCE(o.out_kg, 0)                  AS out_kg
  FROM del d
  FULL JOIN outk o ON o.batch_code = d.batch_code AND o.month_start = d.month_start
),
closed AS (
  SELECT batch_code, min(close_date) AS close_date
  FROM public.view_rc_movement_block_actual_price
  WHERE close_date IS NOT NULL
  GROUP BY 1
),
first_seen AS (
  SELECT batch_code, min(month_start) AS first_month FROM deltas GROUP BY 1
),
grid AS (
  SELECT fs.batch_code, s.month_start, s.as_of_date
  FROM first_seen fs
  JOIN public.view_analytics_flow_monthly s ON s.month_start >= fs.first_month
),
running AS (
  SELECT g.batch_code, g.month_start, g.as_of_date,
         sum(COALESCE(d.in_kg, 0) - COALESCE(d.out_kg, 0)) OVER w AS balance_kg,
         sum(COALESCE(d.in_kg, 0))                         OVER w AS cum_in_kg,
         sum(COALESCE(d.in_kg_daynum, 0))                  OVER w AS cum_in_daynum
  FROM grid g
  LEFT JOIN deltas d ON d.batch_code = g.batch_code AND d.month_start = g.month_start
  WINDOW w AS (PARTITION BY g.batch_code ORDER BY g.month_start)
),
aged AS (
  SELECT r.month_start,
         r.balance_kg,
         (c.close_date IS NULL OR c.close_date > r.as_of_date)       AS still_open,
         ((r.as_of_date - DATE '2000-01-01')::numeric
            - r.cum_in_daynum / NULLIF(r.cum_in_kg, 0))              AS age_days
  FROM running r
  LEFT JOIN closed c ON c.batch_code = r.batch_code
  WHERE r.balance_kg > 0
),
per_month AS (
  SELECT month_start,
         sum(balance_kg) FILTER (WHERE still_open)                   AS open_kg,
         count(*) FILTER (WHERE still_open)::int                     AS open_batches,
         sum(balance_kg * age_days) FILTER (WHERE still_open)        AS kg_days,
         sum(balance_kg) FILTER (WHERE still_open AND age_days >  60) AS kg_over_60d,
         sum(balance_kg) FILTER (WHERE still_open AND age_days > 120) AS kg_over_120d,
         count(*) FILTER (WHERE still_open AND age_days > 120)::int  AS batches_over_120d,
         max(age_days) FILTER (WHERE still_open)                     AS oldest_age_days,
         sum(balance_kg) FILTER (WHERE NOT still_open)               AS closed_residue_kg,
         count(*) FILTER (WHERE NOT still_open)::int                 AS closed_residue_batches
  FROM aged
  GROUP BY 1
)
SELECT
  f.month_start,
  f.year,
  f.month,
  f.as_of_date,
  f.is_partial_month,
  COALESCE(p.open_kg, 0)::numeric                                    AS open_kg,
  COALESCE(p.open_batches, 0)                                        AS open_batches,
  (p.kg_days / NULLIF(p.open_kg, 0))::numeric                        AS wtd_age_days,
  COALESCE(p.kg_over_60d,  0)::numeric                               AS kg_over_60d,
  COALESCE(p.kg_over_120d, 0)::numeric                               AS kg_over_120d,
  COALESCE(p.batches_over_120d, 0)                                   AS batches_over_120d,
  (100.0 * COALESCE(p.kg_over_60d,  0) / NULLIF(p.open_kg, 0))::numeric AS pct_over_60d,
  (100.0 * COALESCE(p.kg_over_120d, 0) / NULLIF(p.open_kg, 0))::numeric AS pct_over_120d,
  p.oldest_age_days::numeric                                         AS oldest_age_days,
  COALESCE(p.closed_residue_kg, 0)::numeric                          AS closed_residue_kg,
  COALESCE(p.closed_residue_batches, 0)                              AS closed_residue_batches
FROM public.view_analytics_flow_monthly f
LEFT JOIN per_month p ON p.month_start = f.month_start;

COMMENT ON VIEW public.view_analytics_aging_eom IS
  'HOW OLD THE CHARCOAL ON HAND WAS AT THE END OF EACH MONTH. Nothing is snapshotted — every figure '
  'is rebuilt from the delivery and feeding records, so correcting an old record correctly restates '
  'history. wtd_age_days is the average age of a kilo in the yard, weighted by weight: a big fresh '
  'pile pulls it down, a small old one barely moves it. pct_over_60d and pct_over_120d are the share '
  'of the yard (as percentages, 0-100) sitting in piles older than that, which is the number that '
  'matters, because charcoal loses weight the longer it sits and the money already spent does not '
  'shrink with it. HOW THE AGE IS WORKED OUT, honestly: a pile takes the average delivery date of '
  'everything tipped into it, weighted by weight, and the whole remaining balance carries that one '
  'age. There is no first-in-first-out accounting and none is possible — the feeding records say '
  'which pile kilos left, never which truckload within that pile — so the alternative would be a '
  'precise-looking guess. Deliveries into one pile land within days of each other, so the error is '
  'small against ages measured in hundreds of days. CLOSED BLOCKS ARE KEPT OUT of the headline. A '
  'closed block keeps a small logged remainder forever, which is the weight that evaporated, not '
  'stock anyone can go and use; counting it made the yard look 415 days old with a 6-year-old pile '
  'in it, against 387 days and a 3-year-old pile once it is set aside. That remainder is reported '
  'separately as closed_residue_kg, and open_kg plus closed_residue_kg always equals the positive '
  'stock total in the month-end inventory view exactly. A block counts as still open until its last '
  'feeding day, because status changes are not dated anywhere. Piles carrying a NEGATIVE balance '
  '(kilos fed out under one spelling of a batch name while the arrival was booked under another) '
  'have no meaningful age and are left out; the inventory view reports their weight and count. '
  'Carries NO peso column and none can be derived, so it is safe for every role including '
  'Production.';

GRANT SELECT ON public.view_analytics_aging_eom TO authenticated;
REVOKE ALL ON public.view_analytics_aging_eom FROM anon;


-- ---------------------------------------------------------------------
-- 4. view_analytics_aging_watchlist — the LIVE "go and look at these"
-- ---------------------------------------------------------------------
-- Deliberately NOT a column on the eom view. Aging-as-a-series is a
-- month-end history question; the watchlist is a today question about
-- named piles, at a completely different grain (one row per batch). One
-- row per OPEN batch holding more than a tonne, oldest first.
-- Measured 2026-09-01: 170 rows / 10,493,304 kg.
--
-- "OPEN" IS status <> 'CLOSED', NOT status = 'IN-USE', and that is a
-- measured correction worth reading. IN-USE holds only 91,825 kg across 3
-- piles over a tonne; STORED holds 10,401,479 kg across 167. An IN-USE-only
-- watchlist would show three names and miss ten and a half million kilos
-- of stock that is doing nothing but age — which is precisely what the
-- list exists to find. CLOSED is excluded for the opposite reason: its
-- 1.17M kg of residue is evaporation loss, expected, and never something
-- to go and look at (Renzo's standing rule — never flag resiko as a bug).
-- `status` rides as a column so the UI can still split the two.
--
-- balance_kg is `batches.current_weight`, the live column maintained by
-- fn_recompute_batch_state from the base tables — not a second
-- reconstruction. P1 proved the two agree to 0.00 kg across all 714
-- batches, so re-deriving it here would only create a way for them to
-- disagree.
--
-- delivered_php_kg is `batches.avg_cost`, which is THE definition of a
-- batch''s delivery-weighted arrival cost over PRICED deliveries only
-- (the L-039 narrowing). Checked against the RC Movement block view''s
-- priced_delivered_php_kg on all 479 batches where both exist: zero
-- disagreement beyond avg_cost''s own 2-decimal rounding (max 0.004966).
-- The block view is NOT used here even though it publishes the same
-- number, because it is driven off rc_out and 167 of the 170 watchlist
-- piles have never been fed at all, so it has no row for them.
-- avg_cost is COALESCEd to 0 for a batch with no priced delivery, so it
-- is NULLIF''d back out — a pile of unknown value must read blank, never
-- free. (Measured today: all 170 rows are priced, so nothing is blank
-- yet; the guard is structural.)
--
-- age_days uses the identical kg-weighted mean delivery date as
-- view_analytics_aging_eom — same formula, same approximation, so a pile
-- on this list and the same pile inside this month''s eom row agree.
-- ---------------------------------------------------------------------
CREATE OR REPLACE VIEW public.view_analytics_aging_watchlist
WITH (security_invoker = true) AS
WITH del AS (
  SELECT d.batch_code,
         count(*)::int                                               AS delivery_count,
         count(*) FILTER (WHERE d.cost_basis > 0)::int               AS priced_delivery_count,
         sum(d.weight_kg)                                            AS delivered_kg,
         min(d.transaction_date)                                     AS first_delivery_date,
         max(d.transaction_date)                                     AS last_delivery_date,
         sum(d.weight_kg * (d.transaction_date - DATE '2000-01-01')::numeric)
           / NULLIF(sum(d.weight_kg), 0)                             AS mean_daynum
  FROM public.deliveries d
  WHERE d.transaction_date IS NOT NULL AND d.batch_code IS NOT NULL
  GROUP BY 1
),
fed AS (
  SELECT r.batch_id,
         max(r.transaction_date)                                     AS last_fed_date,
         sum(r.weight_kg)                                            AS fed_kg
  FROM public.rc_out r
  WHERE r.transaction_date IS NOT NULL
  GROUP BY 1
)
SELECT
  b.id                                                               AS batch_id,
  b.batch_code,
  b.status,
  NULLIF(btrim(b.location_ref), '')                                  AS block_loc,
  b.current_weight                                                   AS balance_kg,
  ((now() AT TIME ZONE 'Asia/Manila')::date - DATE '2000-01-01')::numeric
    - d.mean_daynum                                                  AS age_days,
  ((now() AT TIME ZONE 'Asia/Manila')::date - d.last_delivery_date)  AS days_since_last_delivery,
  d.first_delivery_date,
  d.last_delivery_date,
  d.delivered_kg,
  d.delivery_count,
  (d.delivery_count - d.priced_delivery_count)                       AS unpriced_delivery_count,
  (d.delivery_count > d.priced_delivery_count)                       AS has_unpriced_delivery,
  NULLIF(b.avg_cost, 0)                                              AS delivered_php_kg,
  (b.current_weight * NULLIF(b.avg_cost, 0))                         AS value_php,
  COALESCE(f.fed_kg, 0)::numeric                                     AS fed_kg_to_date,
  f.last_fed_date,
  (f.batch_id IS NOT NULL)                                           AS has_been_fed,
  (now() AT TIME ZONE 'Asia/Manila')::date                           AS as_of_date
FROM public.batches b
LEFT JOIN del d ON d.batch_code = b.batch_code
LEFT JOIN fed f ON f.batch_id   = b.id
WHERE b.status <> 'CLOSED'
  AND b.current_weight > 1000
ORDER BY age_days DESC NULLS LAST;

COMMENT ON VIEW public.view_analytics_aging_watchlist IS
  'THE PILES TO GO AND LOOK AT — every open pile holding more than a tonne right now, oldest first. '
  'Unlike the month-end aging view this is a live list of named piles, not a history. age_days is '
  'the weight-weighted average age of what was tipped into that pile, the same way the month-end '
  'view measures it. OPEN means anything not CLOSED, which is deliberately wider than "in use": '
  'only three piles over a tonne are actively being fed, holding 92 tonnes, while 167 STORED piles '
  'hold 10,401 tonnes that are doing nothing but get older — those are the ones worth finding. '
  'Closed blocks are excluded because their small leftover weight is the charcoal that evaporated, '
  'which is expected and is never something to act on. delivered_php_kg is what that pile cost per '
  'kilo on arrival, averaged over its priced truckloads only; a pile with nothing priced reads '
  'BLANK rather than free, and has_unpriced_delivery says when part of it is still awaiting a '
  'price. value_php is simply what is left multiplied by that price — what the pile cost us, not '
  'what it would fetch, and it does not include the extra cost of the weight it has already lost. '
  'balance_kg is the live inventory figure the database maintains, not a second calculation. '
  'CONTAINS PESO COLUMNS (delivered_php_kg, value_php) — the server action must null them for '
  'anyone who cannot see prices.';

GRANT SELECT ON public.view_analytics_aging_watchlist TO authenticated;
REVOKE ALL ON public.view_analytics_aging_watchlist FROM anon;
