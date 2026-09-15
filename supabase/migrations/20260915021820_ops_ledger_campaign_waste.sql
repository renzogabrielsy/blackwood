-- =============================================================================
-- OPS LEDGER — CAMPAIGN WASTE (the EOQ "Waste Loss" column + the LOSSES footer)
-- =============================================================================
-- Renzo's EOQ rollup gets a WASTE LOSS (kg + %) column and the LOSSES lens
-- footer gets the per-stream campaign totals. Until now
-- `view_ops_ledger_campaign_kpis` and `fn_ops_ledger_group_kpis` carried NO
-- waste column at all, so the UI printed a sentence where a number belongs.
--
-- NOTHING WITH A HOME IS RE-DERIVED, and the chain is one link per grain:
--   view_production_daily  ->  view_ops_ledger_shift  ->  (this campaign fold)
--   view_ops_ledger_campaign_kpis  ->  fn_ops_ledger_group_kpis
-- The campaign fold sums `view_ops_ledger_shift` (which owns the eight streams
-- and their NULL-never-0 rule); the GROUP sums the CAMPAIGN view's own columns
-- rather than going back to the shift view, so the two grains are structurally
-- incapable of disagreeing.
--
-- THE EIGHT STREAMS DO NOT SUM TO PROCESS LOSS, and the COMMENTs say so: most
-- of what the retort loses leaves as moisture and volatiles that nobody weighs.
-- `waste_loss_pct` is what was SWEPT UP and WEIGHED, as a fraction of FED kg —
-- it is a recovery/housekeeping figure, never `process_loss_pct`.
--
-- NULL IS NEVER 0. A campaign whose shifts filed no waste row reads NULL on all
-- nine kg columns (a 0 would claim "nothing was swept up" where the truth is
-- "nothing was recorded"), and `waste_loss_pct` is NULL whenever either side is
-- NULL or the fed denominator is 0.
--
-- MEASURED BEFORE APPLYING (JULY 2026, under `set local statement_timeout='5s'`):
-- the campaign fold alone ran in 3.570 ms on 30 shared buffers; the whole new
-- view body as a plain query ran in 67.291 ms on 2,130 shared buffers against
-- the existing view's 54.647 ms / 2,100 — +12.6 ms and +30 buffers for the
-- waste fold. It returned TRML1 2,391.0 · TRML2 11.5 · RS1A 38,135.0 ·
-- RS1B 36,475.0 · RS2/3 7,869.0 · RS5 4,191.0 · BF 4,557.0 · GRITS 1,022.0 ·
-- total 94,651.5 kg over 23 of 28 shifts, against 781,234.00 fed kg = 0.121155
-- (12.1155%). The same total is what `Σ view_ops_ledger_day.total_waste_kg`
-- already publishes (94,651.5), which is the fold the new probe key asserts.
-- The GROUP shape on Q3 2026 ran in 24.390 ms / 444 buffers: 218,401.0 kg over
-- 1,903,790.00 fed kg = 0.114719 (11.4719%), 3 of 3 campaigns reporting waste.
--
-- NO ₱ COLUMN IS ADDED and none is derivable from these — the whole waste band
-- is safe for every role including Production.
-- =============================================================================


-- -----------------------------------------------------------------------------
-- 1. view_ops_ledger_campaign_kpis — the SAME body, nine waste columns APPENDED
-- -----------------------------------------------------------------------------
-- CREATE OR REPLACE (never DROP + CREATE): it keeps the grants, and L-044's
-- lesson is that a lost grant on a reporting view fails silently. Columns may
-- therefore only be APPENDED, which is what this does — nothing above
-- `ld.rest_days` moved.
create or replace view public.view_ops_ledger_campaign_kpis as
select
  sp.campaign_key,
  sp.campaign_label,
  sp.production_batch,
  sp.campaign_year,
  sp.first_date,
  sp.last_date,
  sp.span_days,
  sp.first_fed_date,
  sp.last_fed_date,
  sp.feed_days,

  -- RC FED / PRODUCED / YIELD  (verbatim)
  bc.fed_kg,
  pbb.produced_kg,                                   -- NULL, never 0, when unreported
  coalesce(pbb.production_reported, false) as production_reported,
  bc.yield_pct,                                      -- FRACTION
  bc.process_loss_kg,
  case when bc.yield_pct is null then null else (1 - bc.yield_pct) end as process_loss_pct,

  -- BLOCK RESIKO LOSS (the yard's shrinkage, not the retort's)
  bc.weight_lost_kg as block_resiko_kg,
  bc.loss_pct       as block_resiko_loss_pct,        -- FRACTION

  -- MONEY  (₱)
  bc.delivered_php_kg_fed                  as fed_php_kg,
  bc.fed_value_php,
  bc.actual_fed_php_kg,
  bc.campaign_weighted_actual_fed_php_kg,
  bc.uplift_php_kg,
  bc.php_per_produced_kg_delivered,                  -- PC COST
  bc.php_per_produced_kg_true,                       -- TRUE PC COST

  -- COVERAGE — so the UI prints "17 of 20 blocks closed" instead of counting
  bc.fed_price_coverage_pct,
  bc.fed_kg_price_traceable,
  bc.fed_kg_price_untraceable,
  bc.blocks_fed,
  bc.blocks_closed,
  bc.blocks_open,
  bc.blocks_in_price,
  bc.blocks_closed_unpriced,
  bc.blocks_with_sundry,
  bc.campaign_fed_kg_included,
  bc.campaign_fed_kg_excluded,
  bc.campaign_fed_kg_included_pct,                   -- FRACTION
  bc.is_fully_covered,
  bc.sundry_kg,
  bc.out_kg,

  -- PRODUCTION
  pbb.reported_days,
  pbb.shift_count,
  pbb.run_count,
  pbb.downtime_hrs as downtime_hours,
  pbb.downtime_shift_count,
  pbb.downtime_shifts_with_duration,
  pbb.downtime_shifts_reason_only,
  pbb.sacks,
  pbb.runs_with_sacks,
  pbb.sacks_coverage_pct,
  pbb.kwh,
  pbb.kwh_days,
  pbb.kwh_suspect_reading_count,
  pbb.kwh_per_produced_kg,
  pbb.kwh_per_produced_kg_excl_suspect,

  -- WORKING vs REST DAYS, folded from the ledger's own spine so the EOQ row and
  -- the rows underneath it can never disagree about how long the campaign was.
  ld.ledger_days,
  ld.active_days,
  ld.rest_days,

  -- APPENDED 2026-09-15 — THE EIGHT RECORDED WASTE STREAMS.
  -- Folded from view_ops_ledger_shift, which the day spine folds too, so the
  -- EOQ number and the LOSSES lens footer are the same arithmetic at two grains.
  -- NULL, never 0, when not one shift of the campaign filed a waste row.
  w.trml1_kg,
  w.trml2_kg,
  w.rs1a_kg,
  w.rs1b_kg,
  w.rs23_kg,
  w.rs5_kg,
  w.bf_kg,
  w.grit_kg,
  w.waste_kg,
  coalesce(w.waste_shift_count, 0)::int as waste_shift_count,
  -- A FRACTION of FED kg (0.121155 = 12.1155%), the ledger's yield_pct/loss_pct
  -- convention. NULL when either side is missing or the denominator is 0.
  case when w.waste_kg is null or bc.fed_kg is null or bc.fed_kg = 0 then null
       else w.waste_kg / bc.fed_kg end as waste_loss_pct
from public.view_ops_ledger_campaign_span sp
left join public.view_analytics_batch_cost bc
       on bc.production_batch = sp.production_batch
      and bc.campaign_year    = sp.campaign_year
left join public.view_analytics_production_by_batch pbb
       on pbb.production_batch = sp.production_batch
      and pbb.campaign_year    = sp.campaign_year
left join lateral (
  select count(*)::int                                  as ledger_days,
         count(*) filter (where d.is_rest_day)::int     as rest_days,
         count(*) filter (where not d.is_rest_day)::int as active_days
    from public.view_ops_ledger_day d
   where d.campaign_key = sp.campaign_key
) ld on true
-- Filtered on production_batch + campaign_year, NEVER on the computed
-- campaign_key: that pushdown is the whole reason the fold costs 3.6 ms.
left join lateral (
  select sum(sh.trml1_kg) as trml1_kg,
         sum(sh.trml2_kg) as trml2_kg,
         sum(sh.rs1a_kg)  as rs1a_kg,
         sum(sh.rs1b_kg)  as rs1b_kg,
         sum(sh.rs23_kg)  as rs23_kg,
         sum(sh.rs5_kg)   as rs5_kg,
         sum(sh.bf_kg)    as bf_kg,
         sum(sh.grit_kg)  as grit_kg,
         sum(sh.total_waste_kg) as waste_kg,
         count(*) filter (where sh.total_waste_kg is not null)::int as waste_shift_count
    from public.view_ops_ledger_shift sh
   where sh.production_batch = sp.production_batch
     and sh.campaign_year    = sp.campaign_year
) w on true;

comment on view public.view_ops_ledger_campaign_kpis is
'Ops ledger EOQ ROW: one row per production campaign - RC FED, PRODUCED, YIELD, LOSS, BLOCK RESIKO LOSS, WASTE LOSS, FED PRICE, ACTUAL FED PRICE, PC COST and TRUE PC COST, with every coverage count beside them. NOT ONE FIGURE IS COMPUTED HERE: every price, yield and coverage column is SELECTed verbatim from view_analytics_batch_cost (which itself lifts them from view_rc_movement_campaign_price / _campaign_actual_price / _campaign_yield) and every production column from view_analytics_production_by_batch - PROVEN identical on all 32 campaigns, zero mismatches. WASTE (added 2026-09-15): trml1_kg, trml2_kg, rs1a_kg, rs1b_kg, rs23_kg, rs5_kg, bf_kg, grit_kg and their total waste_kg are the EIGHT RECORDED STREAMS, folded from view_ops_ledger_shift - the same relation the day spine folds, so the EOQ figure and the LOSSES lens footer are one arithmetic at two grains. THEY DO NOT SUM TO PROCESS LOSS: most of what the retort loses leaves as moisture and volatiles nobody weighs, so waste_loss_pct (= waste_kg / fed_kg, a FRACTION of FED kg, e.g. 0.121155 for JULY 2026) is what was swept up and WEIGHED, never process_loss_pct. NULL IS NEVER 0 on any of the nine kg columns - a campaign none of whose shifts filed a waste row reads NULL, and waste_shift_count (shifts that filed one) says how much of the campaign the figure covers. yield_pct, process_loss_pct, block_resiko_loss_pct, waste_loss_pct and campaign_fed_kg_included_pct are FRACTIONS; fed_price_coverage_pct and sacks_coverage_pct are PERCENTS (0-100) - their sources'' conventions, kept rather than harmonised so a reader can compare the two screens digit for digit. php_per_produced_kg_true is NULL, never 0, unless every block the campaign fed is CLOSED and fully priced (is_fully_covered) - measured, 2 of the 9 2026 campaigns are not. ₱ COLUMNS: fed_php_kg, fed_value_php, actual_fed_php_kg, campaign_weighted_actual_fed_php_kg, uplift_php_kg, php_per_produced_kg_delivered, php_per_produced_kg_true - all must be nulled server-side when !canViewPrices(); NO waste column carries money. ROW BUDGET: 32 rows, all history.';


-- -----------------------------------------------------------------------------
-- 2. fn_ops_ledger_group_kpis — DROP + CREATE (the RETURNS TABLE changes)
-- -----------------------------------------------------------------------------
-- A function whose RETURNS TABLE gains a column cannot be CREATE OR REPLACEd, so
-- this DROPs and re-CREATEs it - which LOSES ITS GRANTS. Section 3 below puts
-- them back in the same migration, and scripts/verify-ops-ledger.ts proves the
-- three has_function_privilege answers (authenticated true / anon false /
-- service_role false) on every run. That is the L-044 shape: a privilege is
-- proven by asking the catalog, not by assuming the DDL kept it.
drop function if exists public.fn_ops_ledger_group_kpis(text[]);

create function public.fn_ops_ledger_group_kpis(p_campaign_keys text[])
returns table (
  campaign_count                    int,
  campaign_keys                     text[],
  campaigns_missing                 text[],
  first_date                        date,
  last_date                         date,
  ledger_days                       int,
  active_days                       int,
  rest_days                         int,
  fed_kg                            numeric,
  produced_kg                       numeric,
  fed_kg_production_reported        numeric,
  campaigns_production_reported     int,
  yield_pct                         numeric,
  process_loss_kg                   numeric,
  process_loss_pct                  numeric,
  block_resiko_loss_pct             numeric,
  fed_php_kg                        numeric,
  fed_value_php                     numeric,
  actual_fed_php_kg                 numeric,
  uplift_php_kg                     numeric,
  php_per_produced_kg_delivered     numeric,
  php_per_produced_kg_true          numeric,
  php_per_produced_kg_true_covered  numeric,
  campaigns_fully_covered           int,
  is_fully_covered                  boolean,
  covered_fed_kg_share              numeric,
  campaign_fed_kg_included          numeric,
  fed_price_coverage_pct            numeric,
  blocks_fed_distinct               int,
  blocks_closed_distinct            int,
  blocks_open_distinct              int,
  blocks_fed_campaign_sum           int,
  reported_campaign_days            int,
  reported_calendar_days            int,
  shift_count                       int,
  run_count                         int,
  downtime_hours                    numeric,
  sacks                             bigint,
  sundry_kg                         numeric,
  -- APPENDED 2026-09-15 — WASTE, folded from the CAMPAIGN view's own columns
  trml1_kg                          numeric,
  trml2_kg                          numeric,
  rs1a_kg                           numeric,
  rs1b_kg                           numeric,
  rs23_kg                           numeric,
  rs5_kg                            numeric,
  bf_kg                             numeric,
  grit_kg                           numeric,
  waste_kg                          numeric,
  waste_shift_count                 int,
  waste_loss_pct                    numeric,
  campaigns_waste_reported          int,
  fed_kg_waste_reported             numeric
)
language sql
stable
security invoker
set search_path = public
as $$
with wanted as (
  select distinct k as campaign_key
    from unnest(coalesce(p_campaign_keys, '{}'::text[])) as k
   where coalesce(btrim(k), '') <> ''
),
k as (
  -- c.* already carries campaign_key; selecting w.campaign_key as well would make
  -- the name ambiguous inside this CTE (and the join guarantees they are equal).
  select c.*
    from wanted w
    join public.view_ops_ledger_campaign_kpis c on c.campaign_key = w.campaign_key
),
miss as (
  select array_agg(w.campaign_key order by w.campaign_key) as missing
    from wanted w
   where not exists (select 1 from k where k.campaign_key = w.campaign_key)
),
-- day spine facts for the group (rest days, active days)
dsp as (
  select count(*)::int                                        as ledger_days,
         count(*) filter (where not d.is_rest_day)::int        as active_days,
         count(*) filter (where d.is_rest_day)::int            as rest_days,
         count(distinct d.calendar_date) filter (where d.production_reported)::int as reported_calendar_days
    from public.view_ops_ledger_day d
   where d.campaign_key in (select campaign_key from k)
),
-- the group's DISTINCT block set (a block fed by two campaigns is ONE block)
blk as (
  select count(*)::int                                        as blocks_fed_distinct,
         count(*) filter (where p.is_closed)::int              as blocks_closed_distinct,
         count(*) filter (where not p.is_closed)::int          as blocks_open_distinct
    from (select distinct b.batch_id
            from public.view_ops_ledger_day_block b
           where b.campaign_key in (select campaign_key from k)) s
    join public.view_rc_movement_block_actual_price p on p.batch_id = s.batch_id
),
agg as (
  select
    count(*)::int                                             as campaign_count,
    array_agg(k.campaign_key order by k.first_date, k.campaign_key) as campaign_keys,
    min(k.first_date)                                         as first_date,
    max(k.last_date)                                          as last_date,
    sum(k.fed_kg)                                             as fed_kg,
    sum(k.produced_kg)                                        as produced_kg,
    sum(k.fed_kg) filter (where k.production_reported)        as fed_kg_reported,
    sum(k.fed_value_php) filter (where k.production_reported) as fed_value_php_reported,
    count(*) filter (where k.production_reported)::int        as campaigns_production_reported,
    sum(k.fed_value_php)                                      as fed_value_php,
    sum(k.fed_kg_price_traceable)                             as fed_kg_traceable,
    -- ACTUAL FED ₱/kg and UPLIFT are aggregated CAMPAIGN-ATTRIBUTED, weighted by
    -- the fed kilos each campaign's price actually covers. campaign_fed_kg_included
    -- PARTITIONS by campaign, so no kilogram is counted twice even when a block
    -- was fed by two campaigns in the group.
    sum(k.campaign_weighted_actual_fed_php_kg * k.campaign_fed_kg_included)
      filter (where k.campaign_weighted_actual_fed_php_kg is not null) as actual_num,
    sum(k.uplift_php_kg * k.campaign_fed_kg_included)
      filter (where k.uplift_php_kg is not null)              as uplift_num,
    sum(k.block_resiko_loss_pct * k.campaign_fed_kg_included)
      filter (where k.block_resiko_loss_pct is not null)      as resiko_num,
    sum(k.campaign_fed_kg_included)
      filter (where k.campaign_weighted_actual_fed_php_kg is not null) as actual_den,
    sum(k.campaign_fed_kg_included)                           as campaign_fed_kg_included,
    count(*) filter (where k.is_fully_covered)::int           as campaigns_fully_covered,
    sum(k.blocks_fed)::int                                    as blocks_fed_campaign_sum,
    sum(k.reported_days)::int                                 as reported_campaign_days,
    sum(k.shift_count)::int                                   as shift_count,
    sum(k.run_count)::int                                     as run_count,
    sum(k.downtime_hours)                                     as downtime_hours,
    sum(k.sacks)::bigint                                      as sacks,
    sum(k.sundry_kg)                                          as sundry_kg,
    -- WASTE: a plain SUM of the CAMPAIGN view's own columns. Waste is filed per
    -- SHIFT and a shift belongs to exactly one campaign, so unlike a block this
    -- partitions cleanly and the kilograms simply add.
    sum(k.trml1_kg)                                           as trml1_kg,
    sum(k.trml2_kg)                                           as trml2_kg,
    sum(k.rs1a_kg)                                            as rs1a_kg,
    sum(k.rs1b_kg)                                            as rs1b_kg,
    sum(k.rs23_kg)                                            as rs23_kg,
    sum(k.rs5_kg)                                             as rs5_kg,
    sum(k.bf_kg)                                              as bf_kg,
    sum(k.grit_kg)                                            as grit_kg,
    sum(k.waste_kg)                                           as waste_kg,
    sum(k.waste_shift_count)::int                             as waste_shift_count,
    count(*) filter (where k.waste_kg is not null)::int        as campaigns_waste_reported,
    sum(k.fed_kg) filter (where k.waste_kg is not null)       as fed_kg_waste_reported
  from k
)
select
  a.campaign_count,
  coalesce(a.campaign_keys, '{}'::text[]),
  coalesce(m.missing, '{}'::text[]),
  a.first_date,
  a.last_date,
  coalesce(dsp.ledger_days, 0),
  coalesce(dsp.active_days, 0),
  coalesce(dsp.rest_days, 0),
  a.fed_kg,
  a.produced_kg,
  a.fed_kg_reported,
  a.campaigns_production_reported,
  -- YIELD is Sum(produced) / Sum(fed) over the campaigns that REPORTED production.
  -- Mixing a produced total with a fed total from a campaign that reported nothing
  -- would understate the yield of the whole group.
  (a.produced_kg / nullif(a.fed_kg_reported, 0)),
  (a.fed_kg_reported - a.produced_kg),
  case when a.fed_kg_reported is null or a.fed_kg_reported = 0 then null
       else 1 - (a.produced_kg / a.fed_kg_reported) end,
  (a.resiko_num / nullif(a.actual_den, 0)),
  (a.fed_value_php / nullif(a.fed_kg, 0)),
  a.fed_value_php,
  (a.actual_num / nullif(a.actual_den, 0)),
  (a.uplift_num / nullif(a.actual_den, 0)),
  (a.fed_value_php_reported / nullif(a.produced_kg, 0)),
  -- TRUE PC COST: strict NULL unless EVERY campaign in the group is fully covered.
  case when a.campaign_count > 0
        and a.campaigns_fully_covered = a.campaign_count
        and a.campaigns_production_reported = a.campaign_count
       then (a.actual_num / nullif(a.actual_den, 0))
            / nullif(a.produced_kg / nullif(a.fed_kg_reported, 0), 0)
       else null end,
  -- ...and the honest partial beside it, always computed.
  (a.actual_num / nullif(a.actual_den, 0))
    / nullif(a.produced_kg / nullif(a.fed_kg_reported, 0), 0),
  a.campaigns_fully_covered,
  (a.campaign_count > 0 and a.campaigns_fully_covered = a.campaign_count),
  (a.campaign_fed_kg_included / nullif(a.fed_kg, 0)),
  a.campaign_fed_kg_included,
  (100.0 * a.fed_kg_traceable / nullif(a.fed_kg, 0)),
  coalesce(blk.blocks_fed_distinct, 0),
  coalesce(blk.blocks_closed_distinct, 0),
  coalesce(blk.blocks_open_distinct, 0),
  a.blocks_fed_campaign_sum,
  a.reported_campaign_days,
  coalesce(dsp.reported_calendar_days, 0),
  a.shift_count,
  a.run_count,
  a.downtime_hours,
  a.sacks,
  a.sundry_kg,
  a.trml1_kg,
  a.trml2_kg,
  a.rs1a_kg,
  a.rs1b_kg,
  a.rs23_kg,
  a.rs5_kg,
  a.bf_kg,
  a.grit_kg,
  a.waste_kg,
  a.waste_shift_count,
  -- WASTE LOSS: weighted by the fed kilos of the campaigns that ACTUALLY FILED
  -- waste, not by the group's whole fed total. Measured reason: production
  -- reporting starts 2025-11-27, so 22 of the 32 campaigns fed the plant and
  -- never filed a shift at all; dividing a real waste total by their fed kilos
  -- too would understate any group that straddles that boundary, which is the
  -- same mistake `yield_pct` avoids with fed_kg_production_reported. The
  -- denominator rides beside it as fed_kg_waste_reported, and
  -- campaigns_waste_reported / campaign_count lets the UI say "3 of 3".
  -- (Measured: on Q3 2026 all three campaigns filed waste, so the two possible
  -- denominators are identical there - 1,903,790.00 kg either way.)
  (a.waste_kg / nullif(a.fed_kg_waste_reported, 0)),
  a.campaigns_waste_reported,
  a.fed_kg_waste_reported
from agg a
cross join miss m
cross join dsp
cross join blk;
$$;

comment on function public.fn_ops_ledger_group_kpis(text[]) is
'THE GROUP KPI ROW - a chosen set of campaigns read as one period (Q3 2026 = JULY-2026 + AUGUST-2026 + SEPTEMBER-2026). Kilograms, hours, shifts and runs SUM; every ₱/kg and every ratio is WEIGHTED, never averaged: fed_php_kg = SUM(fed_value_php)/SUM(fed_kg), yield_pct = SUM(produced)/SUM(fed over the campaigns that reported production), and actual_fed_php_kg / uplift_php_kg / block_resiko_loss_pct are weighted by campaign_fed_kg_included, which PARTITIONS by campaign so no kilogram is double counted. WASTE (added 2026-09-15): the eight streams and waste_kg are a plain SUM of view_ops_ledger_campaign_kpis'' OWN waste columns - never a second fold of the shift view - because waste is filed per SHIFT and a shift belongs to exactly one campaign, so unlike a block it partitions cleanly and the kilograms simply add. waste_loss_pct is a FRACTION of FED kg, weighted by fed_kg_waste_reported (the fed kilos of the campaigns that actually filed waste) rather than by the whole fed total: production reporting begins 2025-11-27, so 22 of 32 campaigns fed the plant and filed no shift at all, and including their kilos would understate any group straddling that boundary - the same reasoning yield_pct applies with fed_kg_production_reported. Read campaigns_waste_reported / campaign_count and waste_shift_count for the coverage. THE EIGHT STREAMS DO NOT SUM TO PROCESS LOSS - most of the retort''s loss leaves as moisture and volatiles nobody weighs - so waste_loss_pct is what was swept up and WEIGHED, never process_loss_pct. TWO DELIBERATE OMISSIONS, both because a block can be fed by more than one campaign (measured: 78 of 523 blocks, up to 5 campaigns each; 5 of Q3-2026''s 45 blocks): the group publishes NO block-resiko KG - only the weighted ratio, since SUM(weight_lost_kg) would charge a shared block''s whole-life shrinkage once per campaign - and it publishes NO whole-block actual_fed_php_kg, only the campaign-attributed form. Block COUNTS are given de-duplicated (blocks_fed_distinct) beside the naive sum, both labelled. php_per_produced_kg_true is strict NULL unless every campaign is fully covered AND reported production, with php_per_produced_kg_true_covered as the always-computed partial and campaigns_fully_covered / campaign_count so the UI can say "2 of 3 campaigns fully covered". A key that resolves to no campaign is returned in campaigns_missing rather than silently dropped. ₱ COLUMNS: fed_php_kg, fed_value_php, actual_fed_php_kg, uplift_php_kg, php_per_produced_kg_delivered, php_per_produced_kg_true, php_per_produced_kg_true_covered; NO waste column carries money.';


-- -----------------------------------------------------------------------------
-- 3. GRANTS — re-applied, because DROP + CREATE lost them (L-044)
-- -----------------------------------------------------------------------------
revoke execute on function public.fn_ops_ledger_group_kpis(text[]) from public, anon;
grant  execute on function public.fn_ops_ledger_group_kpis(text[]) to authenticated;


-- -----------------------------------------------------------------------------
-- 4. fn_ops_ledger_verify_campaign — two WASTE FOLD keys
-- -----------------------------------------------------------------------------
-- CREATE OR REPLACE is safe here: the signature (text) -> jsonb does not change,
-- so the service_role-only grant survives. The posture probe asserts it anyway.
create or replace function public.fn_ops_ledger_verify_campaign(p_campaign_key text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
set plan_cache_mode = 'force_custom_plan'
as $fn$
declare
  v_batch  text;
  v_year   int;
  v_year_t text;
  v_hits   int;
  v_out    jsonb;
begin
  if coalesce(btrim(p_campaign_key), '') = '' then
    raise exception 'fn_ops_ledger_verify_campaign: a campaign key is required';
  end if;

  -- Split at the LAST '-': the batch name is everything before it, the campaign
  -- year everything after. Measured over all 32 campaigns today no production
  -- batch contains a '-', but splitting at the last one survives one that does.
  v_batch  := substring(btrim(p_campaign_key) from '^(.*)-[^-]*$');
  v_year_t := substring(btrim(p_campaign_key) from '-([^-]*)$');

  if v_batch is null or v_year_t is null or v_year_t !~ '^[0-9]{4}$' then
    raise exception 'fn_ops_ledger_verify_campaign: % is not a <BATCH>-<YYYY> campaign key', p_campaign_key;
  end if;
  v_year := v_year_t::int;

  select count(*) into v_hits
    from public.view_ops_ledger_campaign_span sp
   where sp.production_batch = v_batch
     and sp.campaign_year    = v_year;

  if v_hits <> 1 then
    raise exception 'fn_ops_ledger_verify_campaign: % resolves to % campaign span rows, expected exactly 1',
      p_campaign_key, v_hits;
  end if;

  with
  d as materialized (
    select dd.* from public.view_ops_ledger_day dd
     where dd.production_batch = v_batch and dd.campaign_year = v_year
  ),
  sh as materialized (
    select s.* from public.view_ops_ledger_shift s
     where s.production_batch = v_batch and s.campaign_year = v_year
  ),
  dg as materialized (
    select g.* from public.view_ops_ledger_day_grade g
     where g.production_batch = v_batch and g.campaign_year = v_year
  ),
  db as materialized (
    select b.* from public.view_ops_ledger_day_block b
     where b.production_batch = v_batch and b.campaign_year = v_year
  ),
  bu as materialized (
    select u.* from public.view_ops_ledger_day_blocks_used u
     where u.production_batch = v_batch and u.campaign_year = v_year
  ),
  cg as materialized (
    select g.* from public.view_ops_ledger_campaign_grades g
     where g.production_batch = v_batch and g.campaign_year = v_year
  ),
  sp as materialized (
    select s.* from public.view_ops_ledger_campaign_span s
     where s.production_batch = v_batch and s.campaign_year = v_year
  ),
  k as materialized (
    select kk.* from public.view_ops_ledger_campaign_kpis kk
     where kk.production_batch = v_batch and kk.campaign_year = v_year
  ),
  bc as materialized (
    select b.* from public.view_analytics_batch_cost b
     where b.production_batch = v_batch and b.campaign_year = v_year
  ),
  pbb as materialized (
    select p.* from public.view_analytics_production_by_batch p
     where p.production_batch = v_batch and p.campaign_year = v_year
  ),
  -- ONE call to the group RPC, on this campaign alone. The old section-12 probe
  -- made 32 of these in a single statement; this makes one per statement.
  g1 as materialized (
    select * from public.fn_ops_ledger_group_kpis(array[btrim(p_campaign_key)])
  ),
  -- THE DAY-SIDE WASTE FOLD, taken once so the nine comparisons below cost one
  -- pass over the already-materialized day CTE.
  dw as materialized (
    select sum(x.total_waste_kg) as waste_kg,
           sum(x.trml1_kg) as trml1_kg, sum(x.trml2_kg) as trml2_kg,
           sum(x.rs1a_kg)  as rs1a_kg,  sum(x.rs1b_kg)  as rs1b_kg,
           sum(x.rs23_kg)  as rs23_kg,  sum(x.rs5_kg)   as rs5_kg,
           sum(x.bf_kg)    as bf_kg,    sum(x.grit_kg)  as grit_kg
      from d x
  ),
  counts as (
    select (select count(*) from d)::int                      as day_rows,
           (select count(*) from d where d.is_rest_day)::int   as rest_days,
           (select max(sp.span_days) from sp)::int             as span_days,
           (select count(*) from sh)::int                      as shift_rows,
           (select count(*) from dg)::int                      as day_grade_rows,
           (select count(*) from db)::int                      as day_block_rows,
           (select count(*) from bu)::int                      as blocks_used_rows,
           (select count(*) from cg)::int                      as campaign_grade_rows
  ),
  folds as (
    select
      (select count(*) from d
         left join (select calendar_date, sum(kg) kg from dg group by 1) g
           on g.calendar_date = d.calendar_date
        where d.produced_kg is distinct from g.kg)::int            as grade_fold_mismatch,
      (select count(*) from d
         left join (select calendar_date, sum(fed_kg) kg from db group by 1) b
           on b.calendar_date = d.calendar_date
        where d.fed_kg is distinct from b.kg)::int                 as block_fold_mismatch,
      (select count(*) from d
         left join (select calendar_date, sum(produced_kg) p from sh group by 1) s
           on s.calendar_date = d.calendar_date
        where d.produced_kg is distinct from s.p)::int             as shift_produced_mismatch,
      (select count(*) from d
         left join (select calendar_date, sum(downtime_hours) dt from sh group by 1) s
           on s.calendar_date = d.calendar_date
        where d.downtime_hours is distinct from s.dt)::int         as shift_downtime_mismatch,
      (select count(*) from (select sum(fed_kg) f, sum(produced_kg) p from d) t
         join k on true
        where t.f is distinct from k.fed_kg
           or t.p is distinct from k.produced_kg)::int             as day_totals_vs_kpi_mismatch,
      (select count(*) from (select grade, sum(kg) kg from dg group by 1) t
         full join cg g on g.grade = t.grade
        where t.kg is distinct from g.kg)::int                     as campaign_grade_fold_mismatch,
      (select count(*) from k
        where k.ledger_days is distinct from k.span_days)::int     as ledger_days_vs_span_mismatch,
      -- WASTE, added 2026-09-15.
      -- The campaign KPI row folds view_ops_ledger_shift; the day spine folds
      -- the same view. If the EOQ "Waste Loss" cell and the LOSSES lens ever
      -- disagreed, this is where it would show, as a 1.
      (select count(*) from k cross join dw
        where k.waste_kg is distinct from dw.waste_kg)::int        as waste_fold_mismatch,
      -- ...and per STREAM, because a total can agree while two streams are
      -- swapped. Counted as the NUMBER OF STREAMS that differ, 0..8.
      (select coalesce(
         (select (case when k.trml1_kg is distinct from dw.trml1_kg then 1 else 0 end)
               + (case when k.trml2_kg is distinct from dw.trml2_kg then 1 else 0 end)
               + (case when k.rs1a_kg  is distinct from dw.rs1a_kg  then 1 else 0 end)
               + (case when k.rs1b_kg  is distinct from dw.rs1b_kg  then 1 else 0 end)
               + (case when k.rs23_kg  is distinct from dw.rs23_kg  then 1 else 0 end)
               + (case when k.rs5_kg   is distinct from dw.rs5_kg   then 1 else 0 end)
               + (case when k.bf_kg    is distinct from dw.bf_kg    then 1 else 0 end)
               + (case when k.grit_kg  is distinct from dw.grit_kg  then 1 else 0 end)
            from k cross join dw), 0))::int                        as waste_stream_fold_mismatch
  ),
  reuse as (
    select
      (select count(*) from k join bc on true
        where k.fed_kg is distinct from bc.fed_kg
           or k.yield_pct is distinct from bc.yield_pct
           or k.process_loss_kg is distinct from bc.process_loss_kg
           or k.block_resiko_kg is distinct from bc.weight_lost_kg
           or k.block_resiko_loss_pct is distinct from bc.loss_pct
           or k.fed_php_kg is distinct from bc.delivered_php_kg_fed
           or k.fed_value_php is distinct from bc.fed_value_php
           or k.actual_fed_php_kg is distinct from bc.actual_fed_php_kg
           or k.campaign_weighted_actual_fed_php_kg is distinct from bc.campaign_weighted_actual_fed_php_kg
           or k.uplift_php_kg is distinct from bc.uplift_php_kg
           or k.php_per_produced_kg_delivered is distinct from bc.php_per_produced_kg_delivered
           or k.php_per_produced_kg_true is distinct from bc.php_per_produced_kg_true
           or k.fed_price_coverage_pct is distinct from bc.fed_price_coverage_pct
           or k.blocks_fed is distinct from bc.blocks_fed
           or k.blocks_closed is distinct from bc.blocks_closed
           or k.blocks_open is distinct from bc.blocks_open
           or k.blocks_in_price is distinct from bc.blocks_in_price
           or k.campaign_fed_kg_included is distinct from bc.campaign_fed_kg_included
           or k.campaign_fed_kg_included_pct is distinct from bc.campaign_fed_kg_included_pct
           or k.is_fully_covered is distinct from bc.is_fully_covered
           or k.sundry_kg is distinct from bc.sundry_kg
           or k.out_kg is distinct from bc.out_kg)::int             as kpi_vs_batch_cost_mismatch,
      (select count(*) from k join pbb on true
        where k.produced_kg is distinct from pbb.produced_kg
           or k.production_reported is distinct from coalesce(pbb.production_reported, false)
           or k.reported_days is distinct from pbb.reported_days
           or k.shift_count is distinct from pbb.shift_count
           or k.run_count is distinct from pbb.run_count
           or k.downtime_hours is distinct from pbb.downtime_hrs
           or k.sacks is distinct from pbb.sacks
           or k.kwh is distinct from pbb.kwh
           or k.kwh_per_produced_kg is distinct from pbb.kwh_per_produced_kg)::int as kpi_vs_production_by_batch_mismatch,
      (select count(*) from k
        where not exists (select 1 from bc))::int                  as kpi_without_batch_cost_row,
      -- the old section-12 check, one campaign at a time: a ONE-campaign group
      -- equals that campaign's own KPI row, column for column.
      (select count(*) from k cross join g1 g
        where g.campaign_count <> 1
           or g.fed_kg is distinct from k.fed_kg
           or g.produced_kg is distinct from k.produced_kg
           or (k.production_reported and g.yield_pct is distinct from k.yield_pct)
           or g.fed_value_php is distinct from k.fed_value_php
           or g.fed_php_kg is distinct from k.fed_php_kg
           or g.actual_fed_php_kg is distinct from k.campaign_weighted_actual_fed_php_kg
           or g.uplift_php_kg is distinct from k.uplift_php_kg
           or g.block_resiko_loss_pct is distinct from k.block_resiko_loss_pct
           or (k.production_reported and g.php_per_produced_kg_delivered is distinct from k.php_per_produced_kg_delivered)
           or g.php_per_produced_kg_true is distinct from k.php_per_produced_kg_true
           or g.is_fully_covered is distinct from coalesce(k.is_fully_covered, false)
           or g.campaign_fed_kg_included is distinct from k.campaign_fed_kg_included
           or g.blocks_fed_distinct is distinct from coalesce(k.blocks_fed, 0)
           or g.blocks_closed_distinct is distinct from coalesce(k.blocks_closed, 0)
           or g.blocks_open_distinct is distinct from coalesce(k.blocks_open, 0)
           or g.shift_count is distinct from k.shift_count
           or g.reported_campaign_days is distinct from k.reported_days
           or g.downtime_hours is distinct from k.downtime_hours
           or g.ledger_days is distinct from k.ledger_days
           or g.rest_days is distinct from k.rest_days
           or g.first_date is distinct from k.first_date
           or g.last_date is distinct from k.last_date
           -- ...and the waste columns travel with it, so a one-campaign group
           -- can never report a different waste total than the campaign itself.
           or g.waste_kg is distinct from k.waste_kg
           or g.trml1_kg is distinct from k.trml1_kg
           or g.trml2_kg is distinct from k.trml2_kg
           or g.rs1a_kg is distinct from k.rs1a_kg
           or g.rs1b_kg is distinct from k.rs1b_kg
           or g.rs23_kg is distinct from k.rs23_kg
           or g.rs5_kg is distinct from k.rs5_kg
           or g.bf_kg is distinct from k.bf_kg
           or g.grit_kg is distinct from k.grit_kg
           or g.waste_shift_count is distinct from k.waste_shift_count
           or g.waste_loss_pct is distinct from k.waste_loss_pct)::int as single_campaign_group_mismatch
  )
  select jsonb_build_object('campaign_key', btrim(p_campaign_key))
         || to_jsonb(counts) || to_jsonb(folds) || to_jsonb(reuse)
    into v_out
    from counts, folds, reuse;

  return v_out;
end;
$fn$;

comment on function public.fn_ops_ledger_verify_campaign(text) is
'READ-ONLY verification probe for ONE ops-ledger campaign — the instrument behind scripts/verify-ops-ledger.ts, which calls it once per campaign, strictly sequentially. It replaces fn_ops_ledger_verify(), a single whole-history probe that hung the instance (OOM) on 2026-09-14 and took the live site down. EVERY subquery is filtered on production_batch + campaign_year (never on the computed campaign_key, which cannot be pushed down), which is what keeps a full run in the tens of milliseconds. It proves the four day-level FOLDS (grades, blocks fed, shift produced, shift downtime) against the day spine, the WASTE fold in both forms (waste_fold_mismatch = the campaign total vs the day spine''s, 0/1; waste_stream_fold_mismatch = how many of the EIGHT streams differ, 0..8 — because a total can agree while two streams are swapped), the day totals against the campaign KPI row, the grade fold against the campaign grade set, ledger_days against span_days, both REUSE comparisons (view_analytics_batch_cost and view_analytics_production_by_batch, column for column) and the ONE-campaign GROUP identity against fn_ops_ledger_group_kpis, waste columns included. SECURITY DEFINER (the views are authenticated-only, so no key a script can hold may read them), STABLE, service_role EXECUTE only. IT RETURNS NO ₱ VALUE: every money-derived key is a GAP that must be 0, a count, or a boolean. Zero on every *_mismatch key is the passing state. RAISES on a key that is not <BATCH>-<YYYY> or that does not resolve to exactly one campaign span row.';


-- -----------------------------------------------------------------------------
-- 5. fn_ops_ledger_verify_group — gap_waste_kg
-- -----------------------------------------------------------------------------
-- Signature (text[]) -> jsonb unchanged, so CREATE OR REPLACE keeps the grant.
create or replace function public.fn_ops_ledger_verify_group(p_campaign_keys text[])
returns jsonb
language plpgsql
stable
security definer
set search_path = public
set plan_cache_mode = 'force_custom_plan'
as $fn$
declare
  v_keys text[];
  v_out  jsonb;
begin
  select coalesce(array_agg(distinct btrim(k)), '{}'::text[])
    into v_keys
    from unnest(coalesce(p_campaign_keys, '{}'::text[])) as k
   where coalesce(btrim(k), '') <> '';

  if coalesce(array_length(v_keys, 1), 0) = 0 then
    raise exception 'fn_ops_ledger_verify_group: at least one campaign key is required';
  end if;

  -- THE CAP IS THE POINT. A group is a quarter or a season, never a history; a
  -- verification read must be structurally incapable of walking all 32 campaigns
  -- in one statement, which is exactly what took the site down on 2026-09-14.
  if array_length(v_keys, 1) > 12 then
    raise exception 'fn_ops_ledger_verify_group: % keys requested, at most 12 are allowed — verify per campaign instead',
      array_length(v_keys, 1);
  end if;

  with
  g as materialized (
    select * from public.fn_ops_ledger_group_kpis(v_keys)
  ),
  -- THE DIRECT-SUM SIDE reads only the campaign KPI rows named in the argument.
  dsum as materialized (
    select sum(fed_kg) f, sum(produced_kg) p, sum(fed_value_php) v,
           sum(waste_kg) w
      from public.view_ops_ledger_campaign_kpis
     where campaign_key = any(v_keys)
  ),
  o as (
    select
      g.campaign_count,
      coalesce(array_length(g.campaigns_missing, 1), 0)::int            as campaigns_missing_count,
      coalesce(g.yield_pct - (dsum.p / nullif(dsum.f, 0)), 0)           as gap_yield,
      coalesce(g.fed_php_kg - (dsum.v / nullif(dsum.f, 0)), 0)          as gap_fed_rate,
      coalesce(g.php_per_produced_kg_delivered - (dsum.v / nullif(dsum.p, 0)), 0) as gap_pc_rate,
      coalesce(g.fed_kg - dsum.f, 0)                                    as gap_fed_kg,
      coalesce(g.produced_kg - dsum.p, 0)                               as gap_produced_kg,
      -- WASTE, added 2026-09-15: the group's waste_kg is a SUM of the member
      -- campaigns' own waste_kg, so this gap must be exactly 0 — unlike block
      -- resiko, waste partitions cleanly because a shift has one campaign.
      coalesce(g.waste_kg - dsum.w, 0)                                  as gap_waste_kg,
      g.waste_shift_count,
      g.campaigns_waste_reported,
      (g.waste_loss_pct is not null)                                    as waste_loss_pct_present,
      g.blocks_fed_distinct                                             as blocks_distinct,
      g.blocks_fed_campaign_sum                                         as blocks_campaign_sum,
      g.campaigns_fully_covered,
      (g.php_per_produced_kg_true is null)                              as true_pc_cost_is_null,
      (g.php_per_produced_kg_true_covered is not null)                  as true_pc_cost_covered_present,
      g.ledger_days,
      g.active_days,
      g.rest_days,
      (g.reported_campaign_days - g.reported_calendar_days)             as changeover_surplus
    from g, dsum
  )
  select to_jsonb(o) into v_out from o;

  return v_out;
end;
$fn$;

comment on function public.fn_ops_ledger_verify_group(text[]) is
'READ-ONLY: proves fn_ops_ledger_group_kpis over a CHOSEN set of campaigns (Q3 2026 = JULY-2026 + AUGUST-2026 + SEPTEMBER-2026) against a direct sum of those campaigns'' own view_ops_ledger_campaign_kpis rows — gap_yield / gap_fed_rate / gap_pc_rate / gap_fed_kg / gap_produced_kg / gap_waste_kg must all be exactly 0 — and reports the de-duplicated vs naive block counts, the coverage counts (blocks, campaigns fully covered, campaigns_waste_reported, waste_shift_count), the ledger/active/rest day split and the changeover surplus. gap_waste_kg is exact BY CONSTRUCTION and that is the point: waste is filed per shift and a shift belongs to one campaign, so unlike block resiko it partitions cleanly and a non-zero gap would mean the group stopped summing the campaign view. IT RAISES ABOVE 12 KEYS, deliberately: after the 2026-09-14 incident a verification read must be structurally incapable of walking all 32 campaigns in one statement. An unknown key is REPORTED in campaigns_missing_count, never silently dropped. SECURITY DEFINER, STABLE, service_role EXECUTE only; returns NO ₱ VALUE — only zero-gaps, counts and booleans.';
