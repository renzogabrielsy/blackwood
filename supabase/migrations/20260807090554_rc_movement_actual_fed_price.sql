-- ============================================================================
-- RC MOVEMENT — ACTUAL FED ₱/kg  (the cost of a kilogram that actually reached
-- the plant, as opposed to the price paid on arrival)
--
-- Renzo, 2026-08-07:
--   "This would be the total php amount of the block divided by the total fed
--    kg of the block IF its closed (NOT the weights it arrived in). Inherently,
--    prices would be higher since we would lose weight while maintaining the
--    value."
--
-- A block receives charcoal at a delivered ₱/kg. Over the following weeks it
-- dries out and loses weight, but the money already spent does not shrink. So
-- every kilogram that actually reached the plant cost MORE than the arrival
-- price. That uplift was invisible in the system until now.
--
--   actual_fed_php_kg = SUM(deliveries.cost_basis * deliveries.weight_kg)
--                       / SUM(rc_out.weight_kg)
--
-- and it exists ONLY when the block is CLOSED, because only then is the fed
-- total final.
--
-- ── STRICTLY ADDITIVE ───────────────────────────────────────────────────────
-- Nothing existing is altered. In particular `view_rc_out_closed_blocks` is
-- UNTOUCHED and is NOT the same statistic: its `total_value` is
-- (fed kg × delivered price), so its `avg_price` collapses back to the
-- DELIVERED ₱/kg (₱48.1612 for JAN-26-BLK22). This migration divides the
-- DELIVERED VALUE (₱2,708,294.30) by the FED kg (53,512) → ₱50.6110.
-- `view_rc_movement_campaign_price` is likewise untouched and remains the
-- delivered-price reference line the UI draws against.
--
-- ── NULL IS NOT ZERO (L-008 / L-039 discipline) ─────────────────────────────
-- `deliveries.cost_basis = 0` is the UNPRICED PLACEHOLDER, not a ₱0 delivery.
-- A block with any unpriced delivery has a numerator that is missing money
-- while its denominator is complete, so the computed price is understated —
-- pointing in the exact opposite direction from the insight this statistic
-- exists to show. Measured on this database (2026-08-07): FEB-26-BLK5 was
-- delivered at ₱49.00/kg and lost weight, so its actual price MUST exceed
-- ₱49.00; computed over its partial money it reads ₱38.4957. That is the
-- ₱11.01-vs-₱39.99 `avg_cost` bug in a new costume.
--
-- Therefore BOTH `actual_fed_php_kg` and `delivered_php_kg` are NULL unless
-- the block is FULLY priced (every delivery has cost_basis > 0), never 0.
-- `has_unpriced_delivery` / `unpriced_delivery_count` / `unpriced_delivered_kg`
-- let the UI explain the blank, and `priced_delivered_php_kg` gives it an
-- honest partial figure to show instead — the same narrowing
-- `fn_recompute_batch_state` applied to `batches.avg_cost` on 2026-08-07.
-- Cost: 4 of 462 closed blocks are affected (1 fully unpriced, 3 partial).
--
-- ── PRICE GATING ────────────────────────────────────────────────────────────
-- Every view here carries ₱ (`delivered_value_php`, `delivered_php_kg`,
-- `actual_fed_php_kg`, `uplift_php_kg`, `priced_delivered_php_kg`). They are
-- subject to `canViewPrices()` AT THE SERVER-ACTION LAYER, exactly as the
-- existing `Fed ₱/kg` column already is — `fetchRcMovementMatrix` nulls ₱
-- BEFORE the payload leaves the server and `rc-movement-matrix.tsx` drops the
-- column entirely for Production. Never rely on hiding these client-side.
-- ============================================================================

-- ────────────────────────────────────────────────────────────────────────────
-- 1. PER-BLOCK — one row per block/batch that has ever been fed
-- ────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE VIEW public.view_rc_movement_block_actual_price
WITH (security_invoker = true) AS
WITH del AS (
    SELECT d.batch_code,
           count(*)::integer                                          AS delivery_count,
           count(*) FILTER (WHERE d.cost_basis > 0)::integer           AS priced_delivery_count,
           sum(d.weight_kg)                                            AS delivered_kg,
           sum(d.weight_kg) FILTER (WHERE d.cost_basis > 0)            AS priced_delivered_kg,
           sum(d.cost_basis * d.weight_kg)                             AS delivered_value_php
      FROM public.deliveries d
     GROUP BY d.batch_code
), fed AS (
    SELECT r.batch_id,
           sum(r.weight_kg)                                            AS total_fed_kg,
           count(*)::integer                                           AS feed_count,
           min(r.transaction_date)                                     AS first_fed_date,
           max(r.transaction_date)                                     AS last_fed_date,
           -- Same close-date idiom as view_rc_out_closed_blocks: the feed whose
           -- remarks say CLOSED, else the last feed of all.
           COALESCE(
             max(r.transaction_date) FILTER (WHERE r.remarks ILIKE '%CLOSED%'),
             max(r.transaction_date)
           )                                                           AS closed_remark_date
      FROM public.rc_out r
     GROUP BY r.batch_id
), loc AS (
    -- Latest non-blank rc_out block_loc per batch (same fallback as
    -- view_rc_out_closed_blocks, expressed as DISTINCT ON instead of a
    -- correlated subquery).
    SELECT DISTINCT ON (r.batch_id) r.batch_id, r.block_loc
      FROM public.rc_out r
     WHERE NULLIF(btrim(r.block_loc), '') IS NOT NULL
     ORDER BY r.batch_id, r.transaction_date DESC, r.created_at DESC
), base AS (
    SELECT b.id                                                        AS batch_id,
           b.batch_code,
           COALESCE(NULLIF(btrim(b.location_ref), ''), l.block_loc)     AS block_loc,
           b.status,
           (b.status = 'CLOSED'::batch_status)                          AS is_closed,
           CASE WHEN b.status = 'CLOSED'::batch_status
                THEN f.closed_remark_date END                           AS close_date,
           f.first_fed_date,
           f.last_fed_date,
           f.feed_count,
           f.total_fed_kg,
           COALESCE(d.delivery_count, 0)                                AS delivery_count,
           COALESCE(d.priced_delivery_count, 0)                         AS priced_delivery_count,
           COALESCE(d.delivery_count, 0) - COALESCE(d.priced_delivery_count, 0)
                                                                        AS unpriced_delivery_count,
           d.delivered_kg,
           COALESCE(d.priced_delivered_kg, 0)                           AS priced_delivered_kg,
           COALESCE(d.delivered_kg, 0) - COALESCE(d.priced_delivered_kg, 0)
                                                                        AS unpriced_delivered_kg,
           d.delivered_value_php,
           -- Fully priced = at least one delivery AND every delivery priced.
           (COALESCE(d.delivery_count, 0) > 0
            AND COALESCE(d.priced_delivery_count, 0) = d.delivery_count) AS is_fully_priced
      FROM fed f
      JOIN public.batches b ON b.id = f.batch_id
      LEFT JOIN del d ON d.batch_code = b.batch_code
      LEFT JOIN loc l ON l.batch_id = b.id
)
SELECT base.batch_id,
       base.batch_code,
       base.block_loc,
       base.status,
       base.is_closed,
       base.close_date,
       base.first_fed_date,
       base.last_fed_date,
       base.feed_count,
       base.delivered_kg,
       base.delivered_value_php,
       base.total_fed_kg,
       -- Delivered ₱/kg — the reference line. NULL unless fully priced, for the
       -- same reason actual_fed_php_kg is.
       CASE WHEN base.is_fully_priced
            THEN base.delivered_value_php / NULLIF(base.delivered_kg, 0) END
                                                                        AS delivered_php_kg,
       -- THE STATISTIC. Closed AND fully priced, else NULL — never 0.
       CASE WHEN base.is_closed AND base.is_fully_priced
            THEN base.delivered_value_php / NULLIF(base.total_fed_kg, 0) END
                                                                        AS actual_fed_php_kg,
       -- What the actual price adds over the delivered price (₱/kg and share).
       CASE WHEN base.is_closed AND base.is_fully_priced
            THEN base.delivered_value_php / NULLIF(base.total_fed_kg, 0)
               - base.delivered_value_php / NULLIF(base.delivered_kg, 0) END
                                                                        AS uplift_php_kg,
       CASE WHEN base.is_closed AND base.is_fully_priced
                 AND base.delivered_value_php > 0
            THEN (base.delivered_value_php / NULLIF(base.total_fed_kg, 0))
                 / (base.delivered_value_php / NULLIF(base.delivered_kg, 0)) - 1 END
                                                                        AS uplift_pct,
       -- delivered − fed. Once is_closed this IS the weight lost; before that it
       -- also contains charcoal still sitting in the block.
       base.delivered_kg - base.total_fed_kg                            AS weight_lost_kg,
       (base.delivered_kg - base.total_fed_kg) / NULLIF(base.delivered_kg, 0)
                                                                        AS loss_pct,
       -- Pricing completeness, so the UI can explain a blank price.
       base.delivery_count,
       base.priced_delivery_count,
       base.unpriced_delivery_count,
       (base.unpriced_delivery_count > 0)                               AS has_unpriced_delivery,
       base.is_fully_priced,
       base.priced_delivered_kg,
       base.unpriced_delivered_kg,
       -- Honest partial figure: the delivered price over PRICED weight only —
       -- the same narrowing fn_recompute_batch_state uses for batches.avg_cost.
       base.delivered_value_php / NULLIF(base.priced_delivered_kg, 0)    AS priced_delivered_php_kg
  FROM base;

COMMENT ON VIEW public.view_rc_movement_block_actual_price IS
'RC Movement — ACTUAL FED PHP/kg per block. One row per batch that has ever been fed (EXISTS rc_out, same scope as view_rc_movement_batch_price). actual_fed_php_kg = SUM(deliveries.cost_basis*weight_kg) / SUM(rc_out.weight_kg) and is NON-NULL ONLY when the block is CLOSED (the fed total is final) AND fully priced (every delivery has cost_basis>0). NULL is NEVER 0 here: cost_basis=0 is the L-008 unpriced placeholder, and computing over partial money UNDERSTATES the price, i.e. points opposite to the insight (measured: FEB-26-BLK5 delivered at 49.00 computes to 38.4957). Read has_unpriced_delivery / unpriced_delivery_count to explain a blank, and priced_delivered_php_kg for an honest partial. Does NOT replace view_rc_out_closed_blocks, whose avg_price is the DELIVERED price. CARRIES PHP — gate at the server action with canViewPrices().';

COMMENT ON COLUMN public.view_rc_movement_block_actual_price.actual_fed_php_kg IS
'PHP per kilogram that actually reached the plant = delivered value / total kg ever fed. Higher than delivered_php_kg because weight is lost while the money spent is not. NULL (never 0) when the block is open or has any unpriced delivery. PHP — canViewPrices() gated.';
COMMENT ON COLUMN public.view_rc_movement_block_actual_price.delivered_php_kg IS
'The reference line: delivered value / delivered kg (what view_rc_out_closed_blocks.avg_price also reports). NULL unless fully priced. PHP — canViewPrices() gated.';
COMMENT ON COLUMN public.view_rc_movement_block_actual_price.loss_pct IS
'FRACTION, not percent (same convention as view_rc_movement_campaign_yield.yield_pct). (delivered_kg - total_fed_kg)/delivered_kg. Only means "lost" once is_closed.';
COMMENT ON COLUMN public.view_rc_movement_block_actual_price.priced_delivered_php_kg IS
'Delivered value over PRICED weight only — honest while a price is pending. Same narrowing fn_recompute_batch_state applies to batches.avg_cost (2026-08-07, L-039). PHP — canViewPrices() gated.';

-- ────────────────────────────────────────────────────────────────────────────
-- 2. CAMPAIGN ROLLUP — per (production_batch, campaign_year)
--
-- The price set is the campaign's blocks that are CLOSED **and** fully priced.
-- Weighted by fed kg, NEVER the mean of the per-block prices (measured on
-- JULY 2026: correct 47.2747 vs naive mean 45.8374).
--
-- TWO honest aggregations, because they answer different questions and a block
-- can be fed across more than one campaign:
--   actual_fed_php_kg                  = SUM(block delivered value)
--                                        / SUM(block ALL-TIME fed kg)
--       "the blocks this campaign drew from actually cost this per kg" —
--       whole-block numerator over whole-block denominator, Renzo's formula.
--   campaign_weighted_actual_fed_php_kg = SUM(campaign fed kg × block price)
--                                        / SUM(campaign fed kg)
--       "the charcoal fed IN THIS CAMPAIGN actually cost this per kg" —
--       shaped like view_rc_movement_campaign_price, so it is directly
--       comparable to that delivered-price reference line.
-- JULY 2026: 47.2747 vs 46.2492. The UI picks one; both are exposed rather
-- than guessing.
-- ────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE VIEW public.view_rc_movement_campaign_actual_price
WITH (security_invoker = true) AS
WITH campaign_block AS (
    SELECT c.production_batch,
           c.campaign_year,
           c.batch_id,
           sum(c.fed_kg) AS campaign_fed_kg
      FROM public.view_rc_movement_campaign_cells c
     GROUP BY c.production_batch, c.campaign_year, c.batch_id
), joined AS (
    SELECT cb.production_batch,
           cb.campaign_year,
           cb.campaign_fed_kg,
           p.is_closed,
           p.is_fully_priced,
           (p.is_closed AND p.is_fully_priced) AS in_price_set,
           p.delivered_kg,
           p.delivered_value_php,
           p.total_fed_kg,
           p.actual_fed_php_kg
      FROM campaign_block cb
      JOIN public.view_rc_movement_block_actual_price p ON p.batch_id = cb.batch_id
)
SELECT production_batch,
       campaign_year,
       -- Coverage, so the UI prints "18 of 19 blocks closed" instead of counting.
       count(*)::integer                                                    AS blocks_fed,
       count(*) FILTER (WHERE is_closed)::integer                           AS blocks_closed,
       count(*) FILTER (WHERE NOT is_closed)::integer                       AS blocks_open,
       count(*) FILTER (WHERE in_price_set)::integer                        AS blocks_in_price,
       count(*) FILTER (WHERE is_closed AND NOT is_fully_priced)::integer   AS blocks_closed_unpriced,
       -- The campaign's own fed kg, split by what the statistic could use.
       sum(campaign_fed_kg)                                                 AS campaign_fed_kg,
       sum(campaign_fed_kg) FILTER (WHERE is_closed)                        AS campaign_fed_kg_closed,
       sum(campaign_fed_kg) FILTER (WHERE NOT is_closed)                    AS campaign_fed_kg_open,
       COALESCE(sum(campaign_fed_kg) FILTER (WHERE in_price_set), 0)        AS campaign_fed_kg_included,
       COALESCE(sum(campaign_fed_kg) FILTER (WHERE NOT in_price_set), 0)    AS campaign_fed_kg_excluded,
       CASE WHEN sum(campaign_fed_kg) > 0
            THEN COALESCE(sum(campaign_fed_kg) FILTER (WHERE in_price_set), 0)
                 / sum(campaign_fed_kg) END                                 AS campaign_fed_kg_included_pct,
       -- The price set's own whole-block totals (the A-form terms).
       sum(delivered_value_php) FILTER (WHERE in_price_set)                 AS delivered_value_php,
       sum(delivered_kg)        FILTER (WHERE in_price_set)                 AS delivered_kg,
       sum(total_fed_kg)        FILTER (WHERE in_price_set)                 AS block_fed_kg,
       -- A-form: whole-block value over whole-block fed kg.
       sum(delivered_value_php) FILTER (WHERE in_price_set)
         / NULLIF(sum(total_fed_kg) FILTER (WHERE in_price_set), 0)         AS actual_fed_php_kg,
       -- B-form: attributed to this campaign's own fed kg.
       sum(campaign_fed_kg * actual_fed_php_kg) FILTER (WHERE in_price_set)
         / NULLIF(sum(campaign_fed_kg) FILTER (WHERE in_price_set), 0)      AS campaign_weighted_actual_fed_php_kg,
       -- Delivered reference line over the same price set.
       sum(delivered_value_php) FILTER (WHERE in_price_set)
         / NULLIF(sum(delivered_kg) FILTER (WHERE in_price_set), 0)         AS delivered_php_kg,
       (sum(delivered_value_php) FILTER (WHERE in_price_set)
          / NULLIF(sum(total_fed_kg) FILTER (WHERE in_price_set), 0))
       - (sum(delivered_value_php) FILTER (WHERE in_price_set)
          / NULLIF(sum(delivered_kg) FILTER (WHERE in_price_set), 0))       AS uplift_php_kg,
       -- Weight lost across the price set (final, since every member is closed).
       sum(delivered_kg) FILTER (WHERE in_price_set)
         - sum(total_fed_kg) FILTER (WHERE in_price_set)                    AS weight_lost_kg,
       (sum(delivered_kg) FILTER (WHERE in_price_set)
          - sum(total_fed_kg) FILTER (WHERE in_price_set))
         / NULLIF(sum(delivered_kg) FILTER (WHERE in_price_set), 0)         AS loss_pct,
       -- TRUE when every block the campaign fed is closed and priced, i.e. the
       -- statistic covers the whole campaign with nothing excluded.
       (count(*) FILTER (WHERE NOT in_price_set) = 0)                       AS is_fully_covered
  FROM joined
 GROUP BY production_batch, campaign_year;

COMMENT ON VIEW public.view_rc_movement_campaign_actual_price IS
'RC Movement — ACTUAL FED PHP/kg rolled up per campaign (production_batch, campaign_year), over the campaign''s blocks that are CLOSED **and** fully priced. Weighted by fed kg, never the mean of the per-block prices (JULY 2026: correct 47.2747 vs naive mean 45.8374). TWO aggregations: actual_fed_php_kg is whole-block value over whole-block fed kg (Renzo''s formula, "the blocks this campaign drew from cost this"); campaign_weighted_actual_fed_php_kg attributes each block to this campaign''s own fed kg (shaped like view_rc_movement_campaign_price, so it is directly comparable to that delivered-price line). blocks_fed/blocks_closed/blocks_open + campaign_fed_kg_included/_excluded are supplied so the UI never counts. Does NOT alter view_rc_movement_campaign_price. CARRIES PHP — gate at the server action with canViewPrices().';

COMMENT ON COLUMN public.view_rc_movement_campaign_actual_price.actual_fed_php_kg IS
'SUM(delivered value of the price-set blocks) / SUM(their ALL-TIME fed kg). NULL when no block qualifies. PHP — canViewPrices() gated.';
COMMENT ON COLUMN public.view_rc_movement_campaign_actual_price.campaign_weighted_actual_fed_php_kg IS
'SUM(campaign fed kg x block actual price) / SUM(campaign fed kg) over the price set — the campaign-attributed twin, comparable to view_rc_movement_campaign_price.wtd_fed_price. PHP — canViewPrices() gated.';
COMMENT ON COLUMN public.view_rc_movement_campaign_actual_price.loss_pct IS
'FRACTION, not percent (same convention as view_rc_movement_campaign_yield.yield_pct).';

-- ────────────────────────────────────────────────────────────────────────────
-- 3. OPEN-BLOCK LIST — per campaign, one row per block still open
--
-- Renzo: "it would be nice to see the blocks still open and clicking that badge
-- should pop up a modal or a sidepanel to show the blocks and some details."
-- Enough detail to answer "why is this still open and does it matter".
-- ────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE VIEW public.view_rc_movement_campaign_open_blocks
WITH (security_invoker = true) AS
WITH campaign_block AS (
    SELECT c.production_batch,
           c.campaign_year,
           c.batch_id,
           sum(c.fed_kg)          AS campaign_fed_kg,
           min(c.date)            AS campaign_first_fed_date,
           max(c.date)            AS campaign_last_fed_date,
           count(DISTINCT c.date)::integer AS campaign_feed_days
      FROM public.view_rc_movement_campaign_cells c
     GROUP BY c.production_batch, c.campaign_year, c.batch_id
), campaign_total AS (
    SELECT production_batch, campaign_year, sum(campaign_fed_kg) AS campaign_fed_kg_total
      FROM campaign_block
     GROUP BY production_batch, campaign_year
)
SELECT cb.production_batch,
       cb.campaign_year,
       cb.batch_id,
       p.batch_code,
       p.block_loc,
       p.status,
       -- This campaign's use of the block.
       cb.campaign_fed_kg,
       cb.campaign_first_fed_date,
       cb.campaign_last_fed_date,
       cb.campaign_feed_days,
       ct.campaign_fed_kg_total,
       cb.campaign_fed_kg / NULLIF(ct.campaign_fed_kg_total, 0) AS campaign_fed_share,
       -- The block itself.
       p.delivered_kg,
       p.delivered_value_php,
       p.delivered_php_kg,
       p.priced_delivered_php_kg,
       p.has_unpriced_delivery,
       p.unpriced_delivery_count,
       p.total_fed_kg                                            AS fed_kg_to_date,
       -- Same definition fn_recompute_batch_state gives batches.current_weight
       -- (deliveries - rc_out), computed here so the view can never be stale.
       COALESCE(p.delivered_kg, 0) - COALESCE(p.total_fed_kg, 0)  AS balance_kg,
       p.total_fed_kg / NULLIF(p.delivered_kg, 0)                 AS fed_share_of_delivered,
       p.first_fed_date,
       p.last_fed_date,
       p.feed_count
  FROM campaign_block cb
  JOIN public.view_rc_movement_block_actual_price p ON p.batch_id = cb.batch_id
  JOIN campaign_total ct
    ON ct.production_batch = cb.production_batch
   AND ct.campaign_year    = cb.campaign_year
 WHERE NOT p.is_closed;

COMMENT ON VIEW public.view_rc_movement_campaign_open_blocks IS
'RC Movement — the blocks a campaign fed that are STILL OPEN, i.e. exactly the blocks excluded from view_rc_movement_campaign_actual_price because their fed total is not final. One row per (production_batch, campaign_year, batch). Backs the "18 of 19 blocks closed" badge''s modal/side-panel: what the campaign took from the block, what is still sitting in it (balance_kg), and whether its money is even known yet. actual_fed_php_kg is deliberately absent — an open block has no actual price. CARRIES PHP — gate at the server action with canViewPrices().';

COMMENT ON COLUMN public.view_rc_movement_campaign_open_blocks.campaign_fed_share IS
'FRACTION of this campaign''s total fed kg that came from this open block — how much the exclusion actually matters.';
COMMENT ON COLUMN public.view_rc_movement_campaign_open_blocks.balance_kg IS
'delivered_kg - fed_kg_to_date: charcoal still in the block. Same definition fn_recompute_batch_state gives batches.current_weight.';

-- ────────────────────────────────────────────────────────────────────────────
-- Grants — security_invoker views: authenticated + service_role only, anon none.
-- (Every underlying relation already carries a permissive SELECT policy for
-- authenticated, so the invoker check passes — the flecon-L trap.)
-- ────────────────────────────────────────────────────────────────────────────
GRANT SELECT ON public.view_rc_movement_block_actual_price     TO authenticated, service_role;
GRANT SELECT ON public.view_rc_movement_campaign_actual_price  TO authenticated, service_role;
GRANT SELECT ON public.view_rc_movement_campaign_open_blocks   TO authenticated, service_role;

REVOKE ALL ON public.view_rc_movement_block_actual_price     FROM anon;
REVOKE ALL ON public.view_rc_movement_campaign_actual_price  FROM anon;
REVOKE ALL ON public.view_rc_movement_campaign_open_blocks   FROM anon;
