-- ============================================================================
-- FED means MAIN. A column named "fed" may never sum a SUNDRY pull. (2026-09-02)
-- ============================================================================
-- `rc_out.destination` has exactly TWO values, measured over all 2,186 rows
-- (0 NULL, 0 other):
--   MAIN   — 2,108 rows / 22,589,264 kg / 2024-01-01 … 2026-08-28 — charcoal fed
--            into the plant tank. THIS is "fed".
--   SUNDRY —    78 rows /    552,629 kg / 2026-01-17 … 2026-04-23 — charcoal
--            pulled OUT of a block to be sun-dried. It never reaches the plant
--            on this trip; it comes back later as a sundry re-entry DELIVERY
--            (fn_delivery_class → 'sundry_reentry').
--
-- Every "fed" view summed BOTH. JANUARY 2026 therefore published 1,048,908 kg
-- of "Charcoal fed" against a true plant feed of 836,328 kg, and every ratio
-- with fed kg in the denominator (yield, ₱/kg fed, actual fed ₱/kg, ₱ per
-- produced kg) was skewed by the same 212,580 kg.
--
-- THREE CLOCKS, and each view now names the one it reads in its COMMENT:
--   FED   = destination 'MAIN' only          → what the plant consumed
--   OUT   = every rc_out row                 → what physically left the block
--   BALANCE = deliveries − OUT               → what is still in the block
-- A sundry pull DID leave the pile, so it belongs in OUT and in BALANCE; it is
-- NOT evaporation, so it must never land in a LOSS figure either — which is why
-- weight_lost_kg / loss_pct keep the OUT clock and are numerically UNCHANGED.
--
-- Nothing here touches `batches.current_weight`, `fn_recompute_batch_state`,
-- `view_blocking_grid`, `view_digest_daily_flow`, `view_digest_mtd`,
-- `view_analytics_flow_monthly`, `view_analytics_inventory_eom` or
-- `view_analytics_aging_*` — all of those are BALANCE/yard-flow surfaces and are
-- correct as they stand.
--
-- CREATE OR REPLACE throughout (never DROP + CREATE): these views carry grants
-- (`authenticated`, and `service_role` on three of them) and a DROP would lose
-- them — L-044. Every replacement restates WITH (security_invoker = true) and
-- appends new columns at the END so no existing column moves.
-- ============================================================================

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. view_rc_movement — the per-batch-day movement ledger.
--    MIXED, and now says so: fed_today/cum_fed/php_total ride the FED clock,
--    start_balance/balance_after/pct_loss ride the BALANCE clock (unchanged
--    values, because the ladder now walks cum_out instead of a "fed" total that
--    was really an out total).
-- ─────────────────────────────────────────────────────────────────────────────
create or replace view public.view_rc_movement
with (security_invoker = true) as
with batch_meta as (
  select b.id as batch_id,
    (select d.supplier from deliveries d where d.batch_code = b.batch_code
      order by d.transaction_date desc limit 1) as supplier,
    (select coalesce(sum(d.weight_kg), 0::numeric) from deliveries d
      where d.batch_code = b.batch_code) as deliveries_total
  from batches b
  where exists (select 1 from rc_out rc where rc.batch_id = b.id)
), day_agg as (
  select rc.transaction_date as date,
    rc.batch_id,
    max(b.batch_code) as batch_code,
    max(coalesce(nullif(rc.block_loc, ''::text), b.location_ref)) as block_loc,
    max(b.avg_cost) as php_per_kg,
    -- FED clock: MAIN only.
    coalesce(sum(rc.weight_kg) filter (where rc.destination = 'MAIN'), 0::numeric) as fed_today,
    coalesce(sum(rc.weight_kg) filter (where rc.destination = 'SUNDRY'), 0::numeric) as sundry_today,
    -- OUT clock: everything that left the block.
    sum(rc.weight_kg) as out_today,
    bool_or(rc.remarks ilike '%CLOSED%') as closed_today,
    bm.supplier,
    bm.deliveries_total
  from rc_out rc
    join batches b on b.id = rc.batch_id
    join batch_meta bm on bm.batch_id = rc.batch_id
  group by rc.transaction_date, rc.batch_id, bm.supplier, bm.deliveries_total
), with_windows as (
  select day_agg.date, day_agg.batch_id, day_agg.batch_code, day_agg.block_loc,
    day_agg.supplier, day_agg.deliveries_total,
    day_agg.fed_today, day_agg.sundry_today, day_agg.out_today,
    day_agg.closed_today, day_agg.php_per_kg,
    day_agg.fed_today * day_agg.php_per_kg as php_total,
    sum(day_agg.fed_today) over (partition by day_agg.batch_id order by day_agg.date
      rows between unbounded preceding and current row) as cum_fed,
    sum(day_agg.out_today) over (partition by day_agg.batch_id order by day_agg.date
      rows between unbounded preceding and current row) as cum_out,
    day_agg.deliveries_total - coalesce(sum(day_agg.out_today) over (partition by day_agg.batch_id
      order by day_agg.date rows between unbounded preceding and 1 preceding), 0::numeric) as start_balance,
    day_agg.deliveries_total - sum(day_agg.out_today) over (partition by day_agg.batch_id
      order by day_agg.date rows between unbounded preceding and current row) as balance_after,
    dense_rank() over (partition by day_agg.batch_id order by day_agg.date) as feed_day_n
  from day_agg
)
select date, batch_id, batch_code, block_loc, supplier, deliveries_total,
  fed_today, cum_fed, start_balance, balance_after,
  case when deliveries_total > 0::numeric then balance_after / deliveries_total else null::numeric end as pct_loss,
  feed_day_n, php_per_kg, php_total, closed_today,
  case when closed_today = true or balance_after <= 0::numeric then 'closed'::text else 'active'::text end as status,
  -- ── appended 2026-09-02 ──
  sundry_today, out_today, cum_out
from with_windows
order by date desc, batch_id;

comment on view public.view_rc_movement is
  'Per (date, batch) movement ledger. FED clock (destination = MAIN): fed_today, cum_fed, php_total. OUT clock (every rc_out row): sundry_today, out_today, cum_out. BALANCE clock (deliveries - OUT): start_balance, balance_after, pct_loss. Before 2026-09-02 fed_today summed BOTH destinations, so a sundry pull was reported as plant feed.';

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. view_rc_movement_campaign_cells — the RC Movement matrix grid.
--    FED clock. A (date, block) that only sundry-pulled is NOT a matrix cell.
-- ─────────────────────────────────────────────────────────────────────────────
create or replace view public.view_rc_movement_campaign_cells
with (security_invoker = true) as
select rc.production_batch,
  extract(year from rc.transaction_date)::integer as campaign_year,
  rc.transaction_date as date,
  rc.batch_id,
  b.batch_code,
  min(rc.block_loc) as block_loc,
  coalesce(sum(rc.weight_kg) filter (where rc.destination = 'MAIN'), 0::numeric) as fed_kg,
  -- ── appended 2026-09-02: the same cell's sundry pull, for context only ──
  coalesce(sum(rc.weight_kg) filter (where rc.destination = 'SUNDRY'), 0::numeric) as sundry_kg
from rc_out rc
  join batches b on b.id = rc.batch_id
where rc.production_batch is not null and rc.production_batch <> ''::text
group by rc.production_batch, (extract(year from rc.transaction_date)), rc.transaction_date, rc.batch_id, b.batch_code
having coalesce(sum(rc.weight_kg) filter (where rc.destination = 'MAIN'), 0::numeric) > 0::numeric;

comment on view public.view_rc_movement_campaign_cells is
  'FED clock (destination = MAIN). One cell per (campaign, date, block) that actually fed the plant; sundry_kg rides along as context. A block a campaign only sun-dried from has no cell here on purpose - it fed nothing.';

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. view_rc_movement_campaign_options — the campaign picker + its fed span.
--    FED clock, with the OUT figures appended so a screen can say
--    "+212,580 kg pulled to sun-drying" instead of hiding it.
-- ─────────────────────────────────────────────────────────────────────────────
create or replace view public.view_rc_movement_campaign_options
with (security_invoker = true) as
select production_batch,
  extract(year from transaction_date)::integer as campaign_year,
  count(distinct transaction_date) filter (where destination = 'MAIN') as feed_days,
  coalesce(sum(weight_kg) filter (where destination = 'MAIN'), 0::numeric) as total_fed,
  -- Fallback to the movement dates only so a hypothetical feed-nothing campaign
  -- can never vanish from the picker (measured: no such campaign exists today).
  coalesce(min(transaction_date) filter (where destination = 'MAIN'), min(transaction_date)) as min_date,
  coalesce(max(transaction_date) filter (where destination = 'MAIN'), max(transaction_date)) as max_date,
  -- ── appended 2026-09-02 ──
  coalesce(sum(weight_kg) filter (where destination = 'SUNDRY'), 0::numeric) as sundry_kg,
  sum(weight_kg) as out_kg,
  count(distinct transaction_date) as out_days
from rc_out rc
where production_batch is not null and production_batch <> ''::text
group by production_batch, (extract(year from transaction_date));

comment on view public.view_rc_movement_campaign_options is
  'FED clock (destination = MAIN): total_fed, feed_days, min_date, max_date. OUT clock: sundry_kg, out_kg, out_days. Before 2026-09-02 total_fed summed both destinations - JANUARY 2026 read 1,048,908 kg against a true plant feed of 836,328 kg. min_date/max_date fall back to the movement dates only so a feed-nothing campaign could never vanish from the picker (no such campaign exists today).';

-- ─────────────────────────────────────────────────────────────────────────────
-- 4-7. The four weighted fed-price views. FED clock.
-- ─────────────────────────────────────────────────────────────────────────────
create or replace view public.view_rc_movement_day_price
with (security_invoker = true) as
with batch_cost as (
  select d.batch_code, sum(d.cost_basis * d.weight_kg) / nullif(sum(d.weight_kg), 0::numeric) as batch_price
  from deliveries d group by d.batch_code
), fed as (
  select rc.transaction_date as date, rc.batch_id, sum(rc.weight_kg) as fed_kg, bc.batch_price
  from rc_out rc
    join batches b on b.id = rc.batch_id
    left join batch_cost bc on bc.batch_code = b.batch_code
  where rc.destination = 'MAIN'
  group by rc.transaction_date, rc.batch_id, bc.batch_price
)
select date,
  sum(fed_kg * batch_price) / nullif(sum(fed_kg), 0::numeric) as wtd_fed_price,
  sum(fed_kg) as total_fed
from fed group by date;

comment on view public.view_rc_movement_day_price is
  'FED clock (destination = MAIN). Weighted delivered price of the charcoal fed to the plant on a date.';

create or replace view public.view_rc_movement_month_price
with (security_invoker = true) as
with batch_cost as (
  select d.batch_code, sum(d.cost_basis * d.weight_kg) / nullif(sum(d.weight_kg), 0::numeric) as batch_price
  from deliveries d group by d.batch_code
), fed as (
  select date_trunc('month'::text, rc.transaction_date::timestamp with time zone)::date as month_start,
    rc.batch_id, sum(rc.weight_kg) as fed_kg, bc.batch_price
  from rc_out rc
    join batches b on b.id = rc.batch_id
    left join batch_cost bc on bc.batch_code = b.batch_code
  where rc.destination = 'MAIN'
  group by (date_trunc('month'::text, rc.transaction_date::timestamp with time zone)), rc.batch_id, bc.batch_price
)
select month_start,
  sum(fed_kg * batch_price) / nullif(sum(fed_kg), 0::numeric) as wtd_fed_price,
  sum(fed_kg) as total_fed
from fed group by month_start;

comment on view public.view_rc_movement_month_price is
  'FED clock (destination = MAIN). THE definition of a calendar month fed kg and weighted delivered fed price; view_analytics_cost_monthly reads it verbatim.';

create or replace view public.view_rc_movement_campaign_price
with (security_invoker = true) as
with batch_cost as (
  select d.batch_code, sum(d.cost_basis * d.weight_kg) / nullif(sum(d.weight_kg), 0::numeric) as batch_price
  from deliveries d group by d.batch_code
), fed as (
  select rc.production_batch,
    extract(year from rc.transaction_date)::integer as campaign_year,
    rc.batch_id, sum(rc.weight_kg) as fed_kg, bc.batch_price
  from rc_out rc
    join batches b on b.id = rc.batch_id
    left join batch_cost bc on bc.batch_code = b.batch_code
  where rc.production_batch is not null and rc.production_batch <> ''::text
    and rc.destination = 'MAIN'
  group by rc.production_batch, (extract(year from rc.transaction_date)), rc.batch_id, bc.batch_price
)
select production_batch, campaign_year,
  sum(fed_kg * batch_price) / nullif(sum(fed_kg), 0::numeric) as wtd_fed_price,
  sum(fed_kg) as total_fed
from fed group by production_batch, campaign_year;

comment on view public.view_rc_movement_campaign_price is
  'FED clock (destination = MAIN). The campaign delivered-basis reference price line.';

create or replace view public.view_rc_movement_campaign_day_price
with (security_invoker = true) as
with batch_cost as (
  select d.batch_code, sum(d.cost_basis * d.weight_kg) / nullif(sum(d.weight_kg), 0::numeric) as batch_price
  from deliveries d group by d.batch_code
), fed as (
  select rc.production_batch,
    extract(year from rc.transaction_date)::integer as campaign_year,
    rc.transaction_date as date, rc.batch_id, sum(rc.weight_kg) as fed_kg, bc.batch_price
  from rc_out rc
    join batches b on b.id = rc.batch_id
    left join batch_cost bc on bc.batch_code = b.batch_code
  where rc.production_batch is not null and rc.production_batch <> ''::text
    and rc.destination = 'MAIN'
  group by rc.production_batch, (extract(year from rc.transaction_date)), rc.transaction_date, rc.batch_id, bc.batch_price
)
select production_batch, campaign_year, date,
  sum(fed_kg * batch_price) / nullif(sum(fed_kg), 0::numeric) as wtd_fed_price,
  sum(fed_kg) as total_fed
from fed group by production_batch, campaign_year, date;

comment on view public.view_rc_movement_campaign_day_price is
  'FED clock (destination = MAIN). Per-day weighted delivered fed price inside one campaign.';

-- ─────────────────────────────────────────────────────────────────────────────
-- 8-9. Yield. FED clock on BOTH sides of the ratio: produced kg came out of the
--      plant, so the denominator must be what went INTO the plant.
-- ─────────────────────────────────────────────────────────────────────────────
create or replace view public.view_rc_movement_campaign_yield
with (security_invoker = true) as
with fed as (
  select rc.production_batch,
    extract(year from rc.transaction_date)::integer as campaign_year,
    sum(rc.weight_kg) as total_fed
  from rc_out rc
  where rc.production_batch is not null and rc.production_batch <> ''::text
    and rc.destination = 'MAIN'
  group by rc.production_batch, (extract(year from rc.transaction_date))
), produced as (
  select ps.production_batch,
    extract(year from ps.transaction_date)::integer as campaign_year,
    sum(pr.ttl_kg) as total_produced
  from production_runs pr join production_shifts ps on ps.id = pr.shift_id
  where ps.production_batch is not null and ps.production_batch <> ''::text
  group by ps.production_batch, (extract(year from ps.transaction_date))
)
select coalesce(f.production_batch, p.production_batch) as production_batch,
  coalesce(f.campaign_year, p.campaign_year) as campaign_year,
  coalesce(f.total_fed, 0::numeric) as total_fed,
  coalesce(p.total_produced, 0::numeric) as total_produced,
  coalesce(p.total_produced, 0::numeric) / nullif(f.total_fed, 0::numeric) as yield_pct,
  coalesce(f.total_fed, 0::numeric) - coalesce(p.total_produced, 0::numeric) as loss_kg
from fed f
  full join produced p on p.production_batch = f.production_batch and p.campaign_year = f.campaign_year;

comment on view public.view_rc_movement_campaign_yield is
  'FED clock (destination = MAIN) over total_fed. yield_pct = produced / fed is a plant ratio, so a sundry pull - which never entered the plant - may not sit in its denominator. loss_kg is PROCESS loss inside the plant, not block shrinkage.';

create or replace view public.view_rc_movement_yield_monthly
with (security_invoker = true) as
with fed as (
  select date_trunc('month'::text, rc.transaction_date::timestamp with time zone)::date as month_start,
    sum(rc.weight_kg) as total_fed
  from rc_out rc
  where rc.destination = 'MAIN'
  group by (date_trunc('month'::text, rc.transaction_date::timestamp with time zone)::date)
), produced as (
  select date_trunc('month'::text, ps.transaction_date::timestamp with time zone)::date as month_start,
    sum(pr.ttl_kg) as total_produced
  from production_runs pr join production_shifts ps on ps.id = pr.shift_id
  group by (date_trunc('month'::text, ps.transaction_date::timestamp with time zone)::date)
)
select coalesce(f.month_start, p.month_start) as month_start,
  coalesce(f.total_fed, 0::numeric) as total_fed,
  coalesce(p.total_produced, 0::numeric) as total_produced,
  coalesce(p.total_produced, 0::numeric) / nullif(f.total_fed, 0::numeric) as yield_pct,
  coalesce(f.total_fed, 0::numeric) - coalesce(p.total_produced, 0::numeric) as loss_kg
from fed f full join produced p on p.month_start = f.month_start;

comment on view public.view_rc_movement_yield_monthly is
  'FED clock (destination = MAIN) over total_fed. Calendar-month twin of view_rc_movement_campaign_yield.';

-- ─────────────────────────────────────────────────────────────────────────────
-- 10. view_rc_movement_block_actual_price — the per-block money view.
--     THREE clocks in one row, each now named:
--       total_fed_kg  FED     (MAIN)   - denominator of actual_fed_php_kg
--       total_out_kg  OUT     (all)    - denominator of out_php_kg
--       weight_lost_kg / loss_pct      - delivered − OUT. UNCHANGED VALUES.
--
--     WHY actual_fed_php_kg IS NULL WHEN A BLOCK HAS ANY SUNDRY OUTFLOW.
--     The block's whole delivered_value_php is a complete numerator. Dividing it
--     by MAIN-only kilos charges the sun-dried kilos' money to the fed kilos and
--     OVERSTATES (JAN-26-BLK8: ₱ over 7,000 kg instead of 30,006 kg, ~4.3x).
--     Dividing it by ALL outflow - what this view did until today - labels a
--     sundry pull as plant feed and UNDERSTATES the very uplift the statistic
--     exists to show. Neither is the answer, because the money physically leaves
--     with the charcoal and comes back inside a different batch (the sundry
--     re-entry delivery), which this block cannot see. So the honest answer is
--     NULL - the same NULL-not-0 discipline as has_unpriced_delivery - with
--     has_sundry_outflow / sundry_kg explaining the blank and out_php_kg giving
--     the computable partial (the priced_delivered_php_kg idiom).
--     COST OF THE RULE, MEASURED: 17 of 462 closed blocks carry sundry outflow,
--     and 16 of them fed the plant NOTHING at all (their old "actual fed price"
--     was a price per kilo sun-dried, never a fed price). Only JAN-26-BLK8 moves
--     from a number to a NULL because of the explicit guard.
-- ─────────────────────────────────────────────────────────────────────────────
create or replace view public.view_rc_movement_block_actual_price
with (security_invoker = true) as
with del as (
  select d.batch_code,
    count(*)::integer as delivery_count,
    count(*) filter (where d.cost_basis > 0::numeric)::integer as priced_delivery_count,
    sum(d.weight_kg) as delivered_kg,
    sum(d.weight_kg) filter (where d.cost_basis > 0::numeric) as priced_delivered_kg,
    sum(d.cost_basis * d.weight_kg) as delivered_value_php
  from deliveries d group by d.batch_code
), fed as (
  select r.batch_id,
    sum(r.weight_kg) as total_out_kg,
    coalesce(sum(r.weight_kg) filter (where r.destination = 'MAIN'), 0::numeric) as main_fed_kg,
    coalesce(sum(r.weight_kg) filter (where r.destination = 'SUNDRY'), 0::numeric) as sundry_kg,
    count(*)::integer as feed_count,
    count(*) filter (where r.destination = 'MAIN')::integer as main_feed_count,
    min(r.transaction_date) as first_fed_date,
    max(r.transaction_date) as last_fed_date,
    min(r.transaction_date) filter (where r.destination = 'MAIN') as first_main_fed_date,
    max(r.transaction_date) filter (where r.destination = 'MAIN') as last_main_fed_date,
    coalesce(max(r.transaction_date) filter (where r.remarks ilike '%CLOSED%'), max(r.transaction_date)) as closed_remark_date
  from rc_out r group by r.batch_id
), loc as (
  select distinct on (r.batch_id) r.batch_id, r.block_loc
  from rc_out r
  where nullif(btrim(r.block_loc), ''::text) is not null
  order by r.batch_id, r.transaction_date desc, r.created_at desc
), base as (
  select b.id as batch_id, b.batch_code,
    coalesce(nullif(btrim(b.location_ref), ''::text), l.block_loc) as block_loc,
    b.status,
    b.status = 'CLOSED'::batch_status as is_closed,
    case when b.status = 'CLOSED'::batch_status then f.closed_remark_date else null::date end as close_date,
    f.first_fed_date, f.last_fed_date, f.feed_count,
    f.main_feed_count, f.first_main_fed_date, f.last_main_fed_date,
    f.total_out_kg,
    f.main_fed_kg as total_fed_kg,
    f.sundry_kg,
    f.sundry_kg > 0::numeric as has_sundry_outflow,
    coalesce(d.delivery_count, 0) as delivery_count,
    coalesce(d.priced_delivery_count, 0) as priced_delivery_count,
    coalesce(d.delivery_count, 0) - coalesce(d.priced_delivery_count, 0) as unpriced_delivery_count,
    d.delivered_kg,
    coalesce(d.priced_delivered_kg, 0::numeric) as priced_delivered_kg,
    coalesce(d.delivered_kg, 0::numeric) - coalesce(d.priced_delivered_kg, 0::numeric) as unpriced_delivered_kg,
    d.delivered_value_php,
    coalesce(d.delivery_count, 0) > 0 and coalesce(d.priced_delivery_count, 0) = d.delivery_count as is_fully_priced
  from fed f
    join batches b on b.id = f.batch_id
    left join del d on d.batch_code = b.batch_code
    left join loc l on l.batch_id = b.id
)
select batch_id, batch_code, block_loc, status, is_closed, close_date,
  first_fed_date, last_fed_date, feed_count,
  delivered_kg, delivered_value_php,
  total_fed_kg,
  case when is_fully_priced then delivered_value_php / nullif(delivered_kg, 0::numeric) else null::numeric end as delivered_php_kg,
  case when is_closed and is_fully_priced and not has_sundry_outflow
       then delivered_value_php / nullif(total_fed_kg, 0::numeric) else null::numeric end as actual_fed_php_kg,
  case when is_closed and is_fully_priced and not has_sundry_outflow
       then delivered_value_php / nullif(total_fed_kg, 0::numeric)
          - delivered_value_php / nullif(delivered_kg, 0::numeric) else null::numeric end as uplift_php_kg,
  case when is_closed and is_fully_priced and not has_sundry_outflow and delivered_value_php > 0::numeric
       then delivered_value_php / nullif(total_fed_kg, 0::numeric)
          / (delivered_value_php / nullif(delivered_kg, 0::numeric)) - 1::numeric else null::numeric end as uplift_pct,
  -- OUT clock. A sundry pull is not evaporation, so it is NOT loss - it is
  -- already out of the block and must be subtracted before loss is named.
  delivered_kg - total_out_kg as weight_lost_kg,
  (delivered_kg - total_out_kg) / nullif(delivered_kg, 0::numeric) as loss_pct,
  delivery_count, priced_delivery_count, unpriced_delivery_count,
  unpriced_delivery_count > 0 as has_unpriced_delivery,
  is_fully_priced, priced_delivered_kg, unpriced_delivered_kg,
  delivered_value_php / nullif(priced_delivered_kg, 0::numeric) as priced_delivered_php_kg,
  -- ── appended 2026-09-02 ──
  total_out_kg,
  sundry_kg,
  has_sundry_outflow,
  case when is_closed and is_fully_priced
       then delivered_value_php / nullif(total_out_kg, 0::numeric) else null::numeric end as out_php_kg,
  main_feed_count, first_main_fed_date, last_main_fed_date
from base;

comment on view public.view_rc_movement_block_actual_price is
  'Per-block money view on THREE clocks. FED (destination = MAIN): total_fed_kg, actual_fed_php_kg, uplift_*. OUT (every rc_out row): total_out_kg, sundry_kg, out_php_kg, and weight_lost_kg / loss_pct (delivered - OUT, so a sundry pull is never counted as evaporation). actual_fed_php_kg / uplift_* are NULL - never 0 - when has_sundry_outflow: dividing the block whole money by MAIN-only kilos overstates (JAN-26-BLK8 would read ~4.3x), dividing it by all outflow calls a sundry pull plant feed and understates the very uplift the statistic exists to show, and the truth is unknowable from this block because the money leaves with the charcoal and returns inside the sundry re-entry batch. Read out_php_kg for the computable partial. Measured cost: 17 of 462 closed blocks, 16 of which fed the plant nothing at all.';

-- ─────────────────────────────────────────────────────────────────────────────
-- 11. view_rc_movement_campaign_actual_price
-- ─────────────────────────────────────────────────────────────────────────────
create or replace view public.view_rc_movement_campaign_actual_price
with (security_invoker = true) as
with campaign_block as (
  select c.production_batch, c.campaign_year, c.batch_id, sum(c.fed_kg) as campaign_fed_kg
  from view_rc_movement_campaign_cells c
  group by c.production_batch, c.campaign_year, c.batch_id
), joined as (
  select cb.production_batch, cb.campaign_year, cb.campaign_fed_kg,
    p.is_closed, p.is_fully_priced, p.has_sundry_outflow, p.sundry_kg,
    p.is_closed and p.is_fully_priced and not p.has_sundry_outflow as in_price_set,
    p.delivered_kg, p.delivered_value_php, p.total_fed_kg, p.total_out_kg, p.actual_fed_php_kg
  from campaign_block cb
    join view_rc_movement_block_actual_price p on p.batch_id = cb.batch_id
)
select production_batch, campaign_year,
  count(*)::integer as blocks_fed,
  count(*) filter (where is_closed)::integer as blocks_closed,
  count(*) filter (where not is_closed)::integer as blocks_open,
  count(*) filter (where in_price_set)::integer as blocks_in_price,
  count(*) filter (where is_closed and not is_fully_priced)::integer as blocks_closed_unpriced,
  sum(campaign_fed_kg) as campaign_fed_kg,
  sum(campaign_fed_kg) filter (where is_closed) as campaign_fed_kg_closed,
  sum(campaign_fed_kg) filter (where not is_closed) as campaign_fed_kg_open,
  coalesce(sum(campaign_fed_kg) filter (where in_price_set), 0::numeric) as campaign_fed_kg_included,
  coalesce(sum(campaign_fed_kg) filter (where not in_price_set), 0::numeric) as campaign_fed_kg_excluded,
  case when sum(campaign_fed_kg) > 0::numeric
       then coalesce(sum(campaign_fed_kg) filter (where in_price_set), 0::numeric) / sum(campaign_fed_kg)
       else null::numeric end as campaign_fed_kg_included_pct,
  sum(delivered_value_php) filter (where in_price_set) as delivered_value_php,
  sum(delivered_kg) filter (where in_price_set) as delivered_kg,
  sum(total_fed_kg) filter (where in_price_set) as block_fed_kg,
  sum(delivered_value_php) filter (where in_price_set) / nullif(sum(total_fed_kg) filter (where in_price_set), 0::numeric) as actual_fed_php_kg,
  sum(campaign_fed_kg * actual_fed_php_kg) filter (where in_price_set) / nullif(sum(campaign_fed_kg) filter (where in_price_set), 0::numeric) as campaign_weighted_actual_fed_php_kg,
  sum(delivered_value_php) filter (where in_price_set) / nullif(sum(delivered_kg) filter (where in_price_set), 0::numeric) as delivered_php_kg,
  sum(delivered_value_php) filter (where in_price_set) / nullif(sum(total_fed_kg) filter (where in_price_set), 0::numeric)
    - sum(delivered_value_php) filter (where in_price_set) / nullif(sum(delivered_kg) filter (where in_price_set), 0::numeric) as uplift_php_kg,
  -- OUT clock: loss is delivered minus everything that left, never minus fed alone.
  sum(delivered_kg) filter (where in_price_set) - sum(total_out_kg) filter (where in_price_set) as weight_lost_kg,
  (sum(delivered_kg) filter (where in_price_set) - sum(total_out_kg) filter (where in_price_set))
    / nullif(sum(delivered_kg) filter (where in_price_set), 0::numeric) as loss_pct,
  count(*) filter (where not in_price_set) = 0 as is_fully_covered,
  -- ── appended 2026-09-02 ──
  count(*) filter (where has_sundry_outflow)::integer as blocks_with_sundry,
  coalesce(sum(sundry_kg) filter (where has_sundry_outflow), 0::numeric) as blocks_sundry_kg
from joined
group by production_batch, campaign_year;

comment on view public.view_rc_movement_campaign_actual_price is
  'FED clock. Blocks come from view_rc_movement_campaign_cells, which is MAIN-only, so a block a campaign merely sun-dried from is not counted as fed. in_price_set additionally excludes any block with sundry outflow (its actual fed price is NULL by construction) - read blocks_with_sundry / blocks_sundry_kg to explain the exclusion. weight_lost_kg / loss_pct use the OUT clock.';

-- ─────────────────────────────────────────────────────────────────────────────
-- 12. view_rc_movement_campaign_open_blocks
-- ─────────────────────────────────────────────────────────────────────────────
create or replace view public.view_rc_movement_campaign_open_blocks
with (security_invoker = true) as
with campaign_block as (
  select c.production_batch, c.campaign_year, c.batch_id,
    sum(c.fed_kg) as campaign_fed_kg,
    min(c.date) as campaign_first_fed_date,
    max(c.date) as campaign_last_fed_date,
    count(distinct c.date)::integer as campaign_feed_days
  from view_rc_movement_campaign_cells c
  group by c.production_batch, c.campaign_year, c.batch_id
), campaign_total as (
  select campaign_block.production_batch, campaign_block.campaign_year,
    sum(campaign_block.campaign_fed_kg) as campaign_fed_kg_total
  from campaign_block group by campaign_block.production_batch, campaign_block.campaign_year
)
select cb.production_batch, cb.campaign_year, cb.batch_id, p.batch_code, p.block_loc, p.status,
  cb.campaign_fed_kg, cb.campaign_first_fed_date, cb.campaign_last_fed_date, cb.campaign_feed_days,
  ct.campaign_fed_kg_total,
  cb.campaign_fed_kg / nullif(ct.campaign_fed_kg_total, 0::numeric) as campaign_fed_share,
  p.delivered_kg, p.delivered_value_php, p.delivered_php_kg, p.priced_delivered_php_kg,
  p.has_unpriced_delivery, p.unpriced_delivery_count,
  p.total_fed_kg as fed_kg_to_date,
  -- BALANCE clock: what is still in the block is delivered minus EVERYTHING that left.
  coalesce(p.delivered_kg, 0::numeric) - coalesce(p.total_out_kg, 0::numeric) as balance_kg,
  p.total_fed_kg / nullif(p.delivered_kg, 0::numeric) as fed_share_of_delivered,
  p.first_fed_date, p.last_fed_date, p.feed_count,
  -- ── appended 2026-09-02 ──
  p.total_out_kg as out_kg_to_date,
  p.sundry_kg,
  p.has_sundry_outflow
from campaign_block cb
  join view_rc_movement_block_actual_price p on p.batch_id = cb.batch_id
  join campaign_total ct on ct.production_batch = cb.production_batch and ct.campaign_year = cb.campaign_year
where not p.is_closed;

comment on view public.view_rc_movement_campaign_open_blocks is
  'Still-open blocks a campaign FED (MAIN). fed_kg_to_date / fed_share_of_delivered ride the FED clock; balance_kg rides the BALANCE clock (delivered - every rc_out row), so a sundry pull is subtracted from the pile as it should be.';

-- ─────────────────────────────────────────────────────────────────────────────
-- 13. view_rc_out_closed_blocks
--     total_value / avg_price keep the OUT clock and are numerically UNCHANGED
--     (avg_price still collapses to the block's delivered unit cost - documented
--     since 2026-08-07). Only total_fed_kg narrows to MAIN.
-- ─────────────────────────────────────────────────────────────────────────────
create or replace view public.view_rc_out_closed_blocks
with (security_invoker = true) as
with batch_cost as (
  select d.batch_code, sum(d.cost_basis * d.weight_kg) / nullif(sum(d.weight_kg), 0::numeric) as batch_unit_cost
  from deliveries d group by d.batch_code
), agg as (
  select b.id as batch_id, b.batch_code, b.location_ref,
    coalesce(max(r.transaction_date) filter (where r.remarks ilike '%CLOSED%'), max(r.transaction_date)) as close_date,
    coalesce(sum(r.weight_kg) filter (where r.destination = 'MAIN'), 0::numeric) as total_fed_kg,
    sum(r.weight_kg) as total_out_kg,
    coalesce(sum(r.weight_kg) filter (where r.destination = 'SUNDRY'), 0::numeric) as sundry_kg,
    count(*)::integer as feed_count,
    min(r.transaction_date) as first_fed_date,
    (select r2.block_loc from rc_out r2
      where r2.batch_id = b.id and nullif(trim(both from r2.block_loc), ''::text) is not null
      order by r2.transaction_date desc, r2.created_at desc limit 1) as rc_out_block_loc
  from rc_out r join batches b on b.id = r.batch_id
  where b.status = 'CLOSED'::batch_status
  group by b.id, b.batch_code, b.location_ref
)
select a.batch_id, a.batch_code,
  coalesce(nullif(trim(both from a.location_ref), ''::text), a.rc_out_block_loc) as block_loc,
  a.close_date,
  a.total_fed_kg,
  a.feed_count,
  a.first_fed_date,
  a.total_out_kg * bc.batch_unit_cost as total_value,
  a.total_out_kg * bc.batch_unit_cost / nullif(a.total_out_kg, 0::numeric) as avg_price,
  -- ── appended 2026-09-02 ──
  a.total_out_kg,
  a.sundry_kg
from agg a left join batch_cost bc on bc.batch_code = a.batch_code;

comment on view public.view_rc_out_closed_blocks is
  'One row per CLOSED block. total_fed_kg rides the FED clock (destination = MAIN) as of 2026-09-02; total_out_kg / sundry_kg ride the OUT clock. total_value and avg_price are unchanged and remain OUT-based - avg_price still collapses to the block DELIVERED unit cost (see view_rc_movement_block_actual_price for the shrinkage-adjusted figure).';

-- ─────────────────────────────────────────────────────────────────────────────
-- 14. view_analytics_cost_monthly
-- ─────────────────────────────────────────────────────────────────────────────
create or replace view public.view_analytics_cost_monthly
with (security_invoker = true) as
with untraceable as (
  select view_rc_movement_block_actual_price.batch_id
  from view_rc_movement_block_actual_price
  where view_rc_movement_block_actual_price.delivery_count = 0
), coverage as (
  -- Must ride the SAME clock as view_rc_movement_month_price or the coverage
  -- percentage would be measured against a different population than the price.
  select date_trunc('month'::text, r.transaction_date::timestamp with time zone)::date as month_start,
    sum(r.weight_kg) as fed_kg_all,
    coalesce(sum(r.weight_kg) filter (where u.batch_id is null), 0::numeric) as fed_kg_traceable
  from rc_out r left join untraceable u on u.batch_id = r.batch_id
  where r.transaction_date is not null and r.destination = 'MAIN'
  group by (date_trunc('month'::text, r.transaction_date::timestamp with time zone)::date)
), closed as (
  select date_trunc('month'::text, b.close_date::timestamp with time zone)::date as month_start,
    count(*)::integer as blocks_closed,
    count(*) filter (where b.is_fully_priced and not b.has_sundry_outflow)::integer as blocks_in_price,
    count(*) filter (where not b.is_fully_priced and b.delivery_count > 0)::integer as blocks_unpriced,
    count(*) filter (where b.delivery_count = 0)::integer as blocks_no_delivery,
    count(*) filter (where b.has_sundry_outflow)::integer as blocks_with_sundry,
    sum(b.delivered_kg) as delivered_kg,
    sum(b.total_fed_kg) as fed_kg,
    sum(b.total_out_kg) as out_kg,
    sum(b.sundry_kg) as sundry_kg,
    sum(b.weight_lost_kg) as lost_kg,
    -- The true-price set excludes any block with sundry outflow: its money is
    -- complete but its fed kilos are not the whole story (see the block view).
    sum(b.delivered_value_php) filter (where b.is_fully_priced and not b.has_sundry_outflow) as priced_value_php,
    sum(b.total_fed_kg) filter (where b.is_fully_priced and not b.has_sundry_outflow) as priced_fed_kg,
    sum(b.delivered_kg) filter (where b.is_fully_priced and not b.has_sundry_outflow) as priced_delivered_kg
  from view_rc_movement_block_actual_price b
  where b.is_closed and b.close_date is not null
  group by (date_trunc('month'::text, b.close_date::timestamp with time zone)::date)
)
select f.month_start, f.year, f.month, f.as_of_date, f.is_partial_month,
  mp.total_fed as fed_kg,
  mp.wtd_fed_price as delivered_php_kg_fed,
  mp.wtd_fed_price * mp.total_fed as fed_value_php,
  coalesce(c.fed_kg_traceable, 0::numeric) as fed_kg_price_traceable,
  coalesce(c.fed_kg_all, 0::numeric) - coalesce(c.fed_kg_traceable, 0::numeric) as fed_kg_price_untraceable,
  100.0 * c.fed_kg_traceable / nullif(c.fed_kg_all, 0::numeric) as fed_price_coverage_pct,
  mp.wtd_fed_price * mp.total_fed / nullif(c.fed_kg_traceable, 0::numeric) as delivered_php_kg_fed_covered,
  ym.total_produced as produced_kg,
  ym.yield_pct,
  ym.loss_kg as process_loss_kg,
  case when c.fed_kg_all is not null and c.fed_kg_traceable = c.fed_kg_all
       then mp.wtd_fed_price * mp.total_fed / nullif(ym.total_produced, 0::numeric)
       else null::numeric end as php_per_produced_kg,
  mp.wtd_fed_price * mp.total_fed / nullif(c.fed_kg_traceable, 0::numeric) / nullif(ym.yield_pct, 0::numeric) as php_per_produced_kg_covered,
  coalesce(cl.blocks_closed, 0) as closed_blocks_count,
  coalesce(cl.blocks_in_price, 0) as closed_blocks_in_price,
  coalesce(cl.blocks_unpriced, 0) as closed_blocks_unpriced,
  coalesce(cl.blocks_no_delivery, 0) as closed_blocks_no_delivery,
  cl.delivered_kg as closed_blocks_delivered_kg,
  cl.fed_kg as closed_blocks_fed_kg,
  cl.lost_kg as closed_blocks_lost_kg,
  cl.lost_kg / nullif(cl.delivered_kg, 0::numeric) as closed_blocks_loss_pct,
  cl.priced_value_php / nullif(cl.priced_fed_kg, 0::numeric) as closed_blocks_true_php_kg,
  cl.priced_value_php / nullif(cl.priced_delivered_kg, 0::numeric) as closed_blocks_delivered_php_kg,
  cl.priced_value_php / nullif(cl.priced_fed_kg, 0::numeric) - cl.priced_value_php / nullif(cl.priced_delivered_kg, 0::numeric) as closed_blocks_uplift_php_kg,
  cl.priced_fed_kg as closed_blocks_priced_fed_kg,
  -- ── appended 2026-09-02 ──
  cl.out_kg as closed_blocks_out_kg,
  cl.sundry_kg as closed_blocks_sundry_kg,
  coalesce(cl.blocks_with_sundry, 0) as closed_blocks_with_sundry
from view_analytics_flow_monthly f
  left join view_rc_movement_month_price mp on mp.month_start = f.month_start
  left join view_rc_movement_yield_monthly ym on ym.month_start = f.month_start
  left join coverage c on c.month_start = f.month_start
  left join closed cl on cl.month_start = f.month_start;

comment on view public.view_analytics_cost_monthly is
  'Calendar-month money read. Every fed figure rides the FED clock (rc_out.destination = MAIN) as of 2026-09-02, including the coverage denominator, which must match view_rc_movement_month_price population exactly. closed_blocks_loss_pct rides the OUT clock and is unchanged. closed_blocks_in_price / _true_php_kg / _uplift_php_kg exclude blocks with sundry outflow - closed_blocks_with_sundry says how many. The flow columns it hangs off (view_analytics_flow_monthly) are YARD-FLOW and deliberately count every destination.';

-- ─────────────────────────────────────────────────────────────────────────────
-- 15. view_analytics_batch_cost
-- ─────────────────────────────────────────────────────────────────────────────
create or replace view public.view_analytics_batch_cost
with (security_invoker = true) as
with spine as (
  select view_rc_movement_campaign_options.production_batch, view_rc_movement_campaign_options.campaign_year
  from view_rc_movement_campaign_options
  union
  select view_rc_movement_campaign_yield.production_batch, view_rc_movement_campaign_yield.campaign_year
  from view_rc_movement_campaign_yield
), untraceable as (
  select view_rc_movement_block_actual_price.batch_id
  from view_rc_movement_block_actual_price
  where view_rc_movement_block_actual_price.delivery_count = 0
), coverage as (
  select r.production_batch,
    extract(year from r.transaction_date)::integer as campaign_year,
    sum(r.weight_kg) as fed_kg_all,
    coalesce(sum(r.weight_kg) filter (where u.batch_id is null), 0::numeric) as fed_kg_traceable
  from rc_out r left join untraceable u on u.batch_id = r.batch_id
  where r.transaction_date is not null and r.production_batch is not null and r.production_batch <> ''::text
    and r.destination = 'MAIN'
  group by r.production_batch, (extract(year from r.transaction_date)::integer)
)
select s.production_batch, s.campaign_year,
  (s.production_batch || ' '::text) || s.campaign_year::text as campaign_label,
  o.min_date as first_fed_date, o.max_date as last_fed_date, o.feed_days::integer as feed_days,
  coalesce(o.total_fed, 0::numeric) as fed_kg,
  cp.wtd_fed_price as delivered_php_kg_fed,
  cp.wtd_fed_price * cp.total_fed as fed_value_php,
  coalesce(cv.fed_kg_traceable, 0::numeric) as fed_kg_price_traceable,
  coalesce(cv.fed_kg_all, 0::numeric) - coalesce(cv.fed_kg_traceable, 0::numeric) as fed_kg_price_untraceable,
  100.0 * cv.fed_kg_traceable / nullif(cv.fed_kg_all, 0::numeric) as fed_price_coverage_pct,
  ap.actual_fed_php_kg, ap.campaign_weighted_actual_fed_php_kg, ap.delivered_php_kg,
  ap.uplift_php_kg, ap.weight_lost_kg, ap.loss_pct,
  ap.blocks_fed, ap.blocks_closed, ap.blocks_open, ap.blocks_in_price, ap.blocks_closed_unpriced,
  ap.campaign_fed_kg_included, ap.campaign_fed_kg_excluded, ap.campaign_fed_kg_included_pct,
  coalesce(ap.is_fully_covered, false) as is_fully_covered,
  cy.total_produced as produced_kg, cy.yield_pct, cy.loss_kg as process_loss_kg,
  case when cv.fed_kg_all is not null and cv.fed_kg_traceable = cv.fed_kg_all
       then cp.wtd_fed_price * cp.total_fed / nullif(cy.total_produced, 0::numeric)
       else null::numeric end as php_per_produced_kg_delivered,
  case when ap.is_fully_covered
       then ap.campaign_weighted_actual_fed_php_kg / nullif(cy.yield_pct, 0::numeric)
       else null::numeric end as php_per_produced_kg_true,
  -- ── appended 2026-09-02 ──
  coalesce(o.sundry_kg, 0::numeric) as sundry_kg,
  coalesce(o.out_kg, 0::numeric) as out_kg,
  coalesce(ap.blocks_with_sundry, 0) as blocks_with_sundry
from spine s
  left join view_rc_movement_campaign_options o on o.production_batch = s.production_batch and o.campaign_year = s.campaign_year
  left join view_rc_movement_campaign_price cp on cp.production_batch = s.production_batch and cp.campaign_year = s.campaign_year
  left join view_rc_movement_campaign_actual_price ap on ap.production_batch = s.production_batch and ap.campaign_year = s.campaign_year
  left join view_rc_movement_campaign_yield cy on cy.production_batch = s.production_batch and cy.campaign_year = s.campaign_year
  left join coverage cv on cv.production_batch = s.production_batch and cv.campaign_year = s.campaign_year;

comment on view public.view_analytics_batch_cost is
  'Production-campaign money read. Every fed figure rides the FED clock (rc_out.destination = MAIN) as of 2026-09-02, coverage denominator included. sundry_kg / out_kg / blocks_with_sundry are the OUT-clock context that explains the gap between what a campaign fed and what left the blocks it drew from.';
