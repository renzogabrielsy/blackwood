-- =============================================================================
-- OPS LEDGER — DAY-LEVEL RATIOS, and WASTE LOSS OVER PRODUCTION OUTPUT
-- 2026-09-15
-- =============================================================================
-- RENZO'S RULING (2026-09-15): "Waste loss %" is waste ÷ PRODUCTION OUTPUT, not
-- waste ÷ fed. And the day rows get their own ratios.
--
-- WHY THE DENOMINATOR MOVED. What the plant sweeps up off the screens and the
-- trommels — TRML 1/2, RS1A, RS1B, RS2/3, RS5, BF, GRITS — is charcoal that came
-- OUT of the retort and was then rejected. It is a property of the OUTPUT, so
-- dividing it by what went IN answers a question nobody asked: it mixes the
-- waste stream with the moisture and volatiles the retort drove off, which are
-- already the whole content of process_loss_pct. JULY 2026: 94,651.5 kg of waste
-- against 621,201 kg produced is 15.2369%, and against 781,234 kg fed it read
-- 12.1156%. The kilograms did not move; only the question did.
--
-- WHAT THIS MIGRATION DOES, AND WHAT IT DELIBERATELY DOES NOT.
--   1. view_ops_ledger_day APPENDS waste_pct, yield_pct and loss_pct. Nothing
--      above them moves — CREATE OR REPLACE may only append.
--   2. view_ops_ledger_campaign_kpis changes ONE EXPRESSION, waste_loss_pct.
--      Same name, same position, same type, so it is still a legal REPLACE.
--   3. fn_ops_ledger_group_kpis is DROP + CREATE (its RETURNS TABLE changes:
--      fed_kg_waste_reported becomes produced_kg_waste_reported in the same
--      position) — WHICH LOSES ITS GRANTS. Section 5 puts them back in this
--      same file, and scripts/verify-ops-ledger.ts proves the three
--      has_function_privilege answers live on every run (L-044).
--   4. The two verification probes gain day_ratio_mismatch,
--      kpi_waste_pct_mismatch and gap_waste_pct. Their signatures do not change,
--      so CREATE OR REPLACE keeps their service_role-only grants; the grants are
--      re-asserted here anyway, because a privilege you did not restate is a
--      privilege you are assuming.
--   5. Section 5 RE-ALTERS security_invoker on BOTH replaced views. THIS IS NOT
--      OPTIONAL AND IT IS NOT DEFENSIVE: `CREATE OR REPLACE VIEW` keeps the
--      GRANTS but RESETS reloptions, so a view declared security_invoker in an
--      earlier migration silently starts running as its OWNER. That has now
--      happened TWICE on view_ops_ledger_campaign_kpis (repaired by
--      20260914065558 and again by 20260915021924). A grant check cannot see it;
--      only pg_options_to_table can.
--
--   NOT DONE, on purpose: the day ratios are NOT summed, averaged or rolled up
--   anywhere. A day yield is INDICATIVE ONLY — the feed tank is continuous flow,
--   so a day's fed kilos and its produced kilos are not the same charcoal, and
--   2026-07-02 divides to 0.9955 while a JULY day produced 22,862 kg on no feed
--   at all. THE CAMPAIGN ROW IS THE REAL YIELD. This is exactly the statement
--   day_drift_kg already makes in kilograms, now also said as a ratio.
--
--   NO ₱ COLUMN IS ADDED. The day view still carries exactly one (fed_php_kg)
--   and the campaign view its existing seven; waste and every ratio here are
--   money-free, so nothing new needs canViewPrices().
-- =============================================================================


-- -----------------------------------------------------------------------------
-- 1. view_ops_ledger_day — the SAME body, three RATIOS appended
-- -----------------------------------------------------------------------------

create or replace view public.view_ops_ledger_day as
with days as (
  select sp.campaign_key, sp.campaign_label, sp.production_batch, sp.campaign_year,
         d::date as calendar_date
    from public.view_ops_ledger_campaign_span sp
    cross join lateral generate_series(sp.first_date, sp.last_date, interval '1 day') d
   where sp.first_date is not null and sp.last_date is not null
),
fed as (
  select c.production_batch, c.campaign_year, c.date,
         sum(c.fed_kg)                as fed_kg,
         sum(c.sundry_kg)             as sundry_kg,
         count(distinct c.batch_id)::int as blocks_fed_count
    from public.view_rc_movement_campaign_cells c
   group by 1, 2, 3
),
sa as (
  select sh.production_batch, sh.campaign_year, sh.calendar_date,
         count(*)::int                                          as shift_count,
         sum(sh.shift_hrs)                                      as shift_hrs_total,
         sum(sh.downtime_hours)                                 as downtime_hours,
         count(*) filter (where sh.has_incident)::int           as downtime_incident_count,
         count(*) filter (where sh.downtime_row_present)::int   as downtime_shift_count,
         count(*) filter (where coalesce(sh.dt_hrs,0) + coalesce(sh.dt_mins,0) > 0)::int
                                                                as downtime_shifts_with_duration,
         count(*) filter (where coalesce(btrim(sh.dt_reason),'') <> ''
                            and coalesce(sh.dt_hrs,0) + coalesce(sh.dt_mins,0) = 0)::int
                                                                as downtime_shifts_reason_only,
         sum(sh.run_count)::int                                 as run_count,
         sum(sh.sacks)::bigint                                  as sacks,
         sum(sh.runs_with_sacks)::int                           as runs_with_sacks,
         sum(sh.trml1_kg) as trml1_kg, sum(sh.trml2_kg) as trml2_kg,
         sum(sh.rs1a_kg)  as rs1a_kg,  sum(sh.rs1b_kg)  as rs1b_kg,
         sum(sh.rs23_kg)  as rs23_kg,  sum(sh.rs5_kg)   as rs5_kg,
         sum(sh.bf_kg)    as bf_kg,    sum(sh.grit_kg)  as grit_kg,
         sum(sh.total_waste_kg) as total_waste_kg
    from public.view_ops_ledger_shift sh
   group by 1, 2, 3
)
select
  d.campaign_key,
  d.campaign_label,
  d.production_batch,
  d.campaign_year,
  d.calendar_date,
  to_char(d.calendar_date, 'Dy')                        as weekday,
  (extract(isodow from d.calendar_date))::int           as iso_weekday,
  ((extract(isodow from d.calendar_date))::int >= 6)    as is_weekend,

  -- A REST DAY IS A ROW. Nothing fed, nothing produced, nobody on shift.
  (f.fed_kg is null and t.produced_kg is null and sa.shift_count is null) as is_rest_day,

  -- FED = rc_out.destination = 'MAIN'. Summed from view_rc_movement_campaign_cells,
  -- which owns the MAIN filter and the changeover-day split by campaign tag.
  f.fed_kg,
  f.sundry_kg,
  coalesce(f.blocks_fed_count, 0)::int                  as blocks_fed_count,
  dp.wtd_fed_price                                      as fed_php_kg,   -- ₱

  t.produced_kg,

  -- DAY-LEVEL DRIFT, not loss. The feed tank is continuous flow, so a day's
  -- fed and produced do not describe the same charcoal; JULY 2026 produced
  -- 22,862 kg on a day it fed nothing. The campaign figure is the real loss.
  case when f.fed_kg is null and t.produced_kg is null then null
       else coalesce(f.fed_kg, 0) - coalesce(t.produced_kg, 0) end as day_drift_kg,

  coalesce(sa.shift_count, 0)::int                      as shift_count,
  sa.shift_hrs_total,
  sa.downtime_hours,
  coalesce(sa.downtime_incident_count, 0)::int          as downtime_incident_count,
  coalesce(sa.downtime_shift_count, 0)::int             as downtime_shift_count,
  coalesce(sa.downtime_shifts_with_duration, 0)::int    as downtime_shifts_with_duration,
  coalesce(sa.downtime_shifts_reason_only, 0)::int      as downtime_shifts_reason_only,
  coalesce(sa.run_count, 0)::int                        as run_count,
  sa.sacks,
  coalesce(sa.runs_with_sacks, 0)::int                  as runs_with_sacks,

  sa.trml1_kg, sa.trml2_kg, sa.rs1a_kg, sa.rs1b_kg,
  sa.rs23_kg,  sa.rs5_kg,   sa.bf_kg,   sa.grit_kg,
  sa.total_waste_kg,

  -- The digest's own rule, carried across: a production day is a day with a
  -- production_runs child.
  (coalesce(sa.run_count, 0) > 0)                       as production_reported,

  -- DAY-LEVEL RATIOS (2026-09-15, Renzo's ruling). All three are FRACTIONS, the
  -- ledger's own convention, and all three are NULL - never 0 - the instant an
  -- input is missing or a denominator is 0.
  --
  -- waste_pct is WASTE OVER PRODUCTION OUTPUT, not over fed: what the plant
  -- sweeps up is a property of what came OUT of the retort, so the fed total is
  -- the wrong denominator (Renzo, 2026-09-15). The campaign row uses the same
  -- denominator, so the day column and the EOQ cell are one definition.
  case when sa.total_waste_kg is null or t.produced_kg is null or t.produced_kg = 0
       then null else sa.total_waste_kg / t.produced_kg end          as waste_pct,

  -- yield_pct / loss_pct are INDICATIVE AT DAY GRAIN and nothing may present
  -- them otherwise: the feed tank is CONTINUOUS FLOW, so a day's fed kilos and
  -- its produced kilos are not the same charcoal (2026-07-02 divides to 0.9955,
  -- and JULY 2026 has a day that produced 22,862 kg on no feed at all). The
  -- REAL yield is the campaign figure in view_ops_ledger_campaign_kpis - this is
  -- the same statement day_drift_kg makes in kilograms, said as a ratio.
  case when t.produced_kg is null or f.fed_kg is null or f.fed_kg = 0
       then null else t.produced_kg / f.fed_kg end                   as yield_pct,
  case when t.produced_kg is null or f.fed_kg is null or f.fed_kg = 0
       then null else 1 - (t.produced_kg / f.fed_kg) end             as loss_pct
from days d
left join fed f
       on f.production_batch = d.production_batch
      and f.campaign_year    = d.campaign_year
      and f.date             = d.calendar_date
left join public.view_rc_movement_campaign_day_price dp
       on dp.production_batch = d.production_batch
      and dp.campaign_year    = d.campaign_year
      and dp.date             = d.calendar_date
left join public.view_rc_movement_campaign_production_daily_total t
       on t.production_batch = d.production_batch
      and t.campaign_year    = d.campaign_year
      and t.date             = d.calendar_date
left join sa
       on sa.production_batch = d.production_batch
      and sa.campaign_year    = d.campaign_year
      and sa.calendar_date    = d.calendar_date;

comment on view public.view_ops_ledger_day is
'THE OPS LEDGER ROW SPINE: one row per CALENDAR DAY of a production campaign, from the campaign''s first fed-or-reported day to its last, REST DAYS INCLUDED as rows with NULL facts (dropping a blank Sunday would make a month read as if it had 26 days). NULL IS NEVER 0 — a day that fed nothing reads NULL fed_kg, a day that produced nothing reads NULL produced_kg, a day with no waste row reads NULL waste. Nothing is re-derived: fed_kg sums view_rc_movement_campaign_cells (which owns FED = destination MAIN and the changeover split), fed_php_kg is view_rc_movement_campaign_day_price.wtd_fed_price verbatim, produced_kg is view_rc_movement_campaign_production_daily_total verbatim (the same figure the RC Movement matrix prints), and every hour and waste figure folds view_ops_ledger_shift, which folds view_production_daily. day_drift_kg = fed - produced is DAY-LEVEL DRIFT, NOT LOSS: the feed tank is continuous flow and the two numbers do not describe the same charcoal (JULY 2026 produced 22,862 kg on a day it fed nothing) - read loss from view_ops_ledger_campaign_kpis. THE ONE ₱ COLUMN IS fed_php_kg; it must be nulled server-side when !canViewPrices(). ROW BUDGET: ~31 rows per campaign (longest span measured 33, JULY 2026), ~1,000 rows over all 32 campaigns - fetch PER CAMPAIGN and fold in the adapter. DAY-LEVEL RATIOS (2026-09-15): waste_pct = total_waste_kg / produced_kg - WASTE OVER PRODUCTION OUTPUT, never over fed kg, because what the plant sweeps up is a property of what came OUT of the retort (Renzo, 2026-09-15); the campaign row''s waste_loss_pct uses the same denominator, so the column and the EOQ cell are ONE definition at two grains. yield_pct = produced_kg / fed_kg and loss_pct = 1 - yield_pct are INDICATIVE ONLY AT DAY GRAIN and must never be presented as the plant''s yield: the feed tank is CONTINUOUS FLOW, so a day''s fed kilos and its produced kilos are not the same charcoal (2026-07-02 divides to 0.9955 and a JULY 2026 day produced 22,862 kg on no feed at all) - THE CAMPAIGN FIGURE IN view_ops_ledger_campaign_kpis IS THE REAL ONE. This is the same statement day_drift_kg already makes in kilograms, said as a ratio. All three are FRACTIONS (x100 at render) and all three are NULL, never 0, when an input is missing or a denominator is 0.';


-- -----------------------------------------------------------------------------
-- 2. view_ops_ledger_campaign_kpis — ONE expression changed: waste_loss_pct
-- -----------------------------------------------------------------------------
-- The column keeps its NAME, its POSITION and its TYPE. That is what makes this
-- a legal CREATE OR REPLACE, and it is why no consumer has to change shape to
-- read a different number.
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
  -- CHANGED 2026-09-15 (Renzo's ruling): a FRACTION of PRODUCED kg, not of FED
  -- kg. What the plant sweeps up is a property of what came OUT of the retort,
  -- so production output is the denominator - JULY 2026 reads 94,651.5 / 621,201
  -- = 0.152369, where the old fed denominator read 0.121156. Only the EXPRESSION
  -- moved: the column keeps its name, its position and its type, which is what
  -- lets this stay a CREATE OR REPLACE. NULL when either side is missing or
  -- produced_kg is 0 (measured: 0 of the 10 waste-reporting campaigns lose their
  -- ratio to the new denominator - every one of them reported production).
  case when w.waste_kg is null or pbb.produced_kg is null or pbb.produced_kg = 0 then null
       else w.waste_kg / pbb.produced_kg end as waste_loss_pct
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
'Ops ledger EOQ ROW: one row per production campaign - RC FED, PRODUCED, YIELD, LOSS, BLOCK RESIKO LOSS, WASTE LOSS, FED PRICE, ACTUAL FED PRICE, PC COST and TRUE PC COST, with every coverage count beside them. NOT ONE FIGURE IS COMPUTED HERE: every price, yield and coverage column is SELECTed verbatim from view_analytics_batch_cost (which itself lifts them from view_rc_movement_campaign_price / _campaign_actual_price / _campaign_yield) and every production column from view_analytics_production_by_batch - PROVEN identical on all 32 campaigns, zero mismatches. WASTE (added 2026-09-15): trml1_kg, trml2_kg, rs1a_kg, rs1b_kg, rs23_kg, rs5_kg, bf_kg, grit_kg and their total waste_kg are the EIGHT RECORDED STREAMS, folded from view_ops_ledger_shift - the same relation the day spine folds, so the EOQ figure and the LOSSES lens footer are one arithmetic at two grains. THEY DO NOT SUM TO PROCESS LOSS: most of what the retort loses leaves as moisture and volatiles nobody weighs, so waste_loss_pct is what was swept up and WEIGHED, never process_loss_pct. WASTE LOSS IS A FRACTION OF PRODUCED kg (Renzo, 2026-09-15): waste_loss_pct = waste_kg / produced_kg, because what the plant sweeps up is a property of what came OUT of the retort, not of what went in - JULY 2026 reads 0.152369 (94,651.5 kg of waste against 621,201 kg produced) where the earlier fed denominator read 0.121156. It is NULL, never 0, when produced_kg is NULL or 0; measured, 0 of the 10 waste-reporting campaigns lose their ratio to the change, since every one of them reported production. view_ops_ledger_day.waste_pct uses the SAME denominator, so the day column and this cell are one definition at two grains. NULL IS NEVER 0 on any of the nine kg columns - a campaign none of whose shifts filed a waste row reads NULL, and waste_shift_count (shifts that filed one) says how much of the campaign the figure covers. yield_pct, process_loss_pct, block_resiko_loss_pct, waste_loss_pct and campaign_fed_kg_included_pct are FRACTIONS; fed_price_coverage_pct and sacks_coverage_pct are PERCENTS (0-100) - their sources'' conventions, kept rather than harmonised so a reader can compare the two screens digit for digit. php_per_produced_kg_true is NULL, never 0, unless every block the campaign fed is CLOSED and fully priced (is_fully_covered) - measured, 2 of the 9 2026 campaigns are not. ₱ COLUMNS: fed_php_kg, fed_value_php, actual_fed_php_kg, campaign_weighted_actual_fed_php_kg, uplift_php_kg, php_per_produced_kg_delivered, php_per_produced_kg_true - all must be nulled server-side when !canViewPrices(); NO waste column carries money. ROW BUDGET: 32 rows, all history.';


-- -----------------------------------------------------------------------------
-- 3. fn_ops_ledger_group_kpis — DROP + CREATE (the RETURNS TABLE changes)
-- -----------------------------------------------------------------------------
-- fed_kg_waste_reported becomes produced_kg_waste_reported, in the SAME
-- position: the column exists to publish the denominator waste_loss_pct
-- actually used, so when the denominator moves the column must move with it,
-- or it becomes a number that describes nothing. A RETURNS TABLE cannot be
-- CREATE OR REPLACEd, so this DROPs — and LOSES THE GRANTS. Section 5.
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
  -- RENAMED 2026-09-15: the denominator waste_loss_pct actually used is now
  -- PRODUCED kg, so the column that publishes it says so. Same position.
  produced_kg_waste_reported        numeric
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
    sum(k.produced_kg) filter (where k.waste_kg is not null)  as produced_kg_waste_reported
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
  -- WASTE LOSS: Sum(waste) / Sum(PRODUCED) over the campaigns that ACTUALLY
  -- FILED waste (Renzo, 2026-09-15 - waste is a property of what came OUT of the
  -- retort, so production output is the denominator). The FILTER is unchanged in
  -- spirit and unchanged in reason: production reporting starts 2025-11-27, so
  -- 22 of the 32 campaigns fed the plant and never filed a shift at all, and
  -- letting their kilos into the denominator would understate any group that
  -- straddles that boundary - the same mistake `yield_pct` avoids with
  -- fed_kg_production_reported. The denominator rides beside it as
  -- produced_kg_waste_reported, and campaigns_waste_reported / campaign_count
  -- lets the UI say "3 of 3". (Measured on Q3 2026: 218,401.0 kg of waste over
  -- 1,494,121.0 kg produced = 0.146174, where the old fed denominator of
  -- 1,903,790.00 kg read 0.114719.)
  (a.waste_kg / nullif(a.produced_kg_waste_reported, 0)),
  a.campaigns_waste_reported,
  a.produced_kg_waste_reported
from agg a
cross join miss m
cross join dsp
cross join blk;
$$;

comment on function public.fn_ops_ledger_group_kpis(text[]) is
'THE GROUP KPI ROW - a chosen set of campaigns read as one period (Q3 2026 = JULY-2026 + AUGUST-2026 + SEPTEMBER-2026). Kilograms, hours, shifts and runs SUM; every ₱/kg and every ratio is WEIGHTED, never averaged: fed_php_kg = SUM(fed_value_php)/SUM(fed_kg), yield_pct = SUM(produced)/SUM(fed over the campaigns that reported production), and actual_fed_php_kg / uplift_php_kg / block_resiko_loss_pct are weighted by campaign_fed_kg_included, which PARTITIONS by campaign so no kilogram is double counted. WASTE (added 2026-09-15): the eight streams and waste_kg are a plain SUM of view_ops_ledger_campaign_kpis'' OWN waste columns - never a second fold of the shift view - because waste is filed per SHIFT and a shift belongs to exactly one campaign, so unlike a block it partitions cleanly and the kilograms simply add. waste_loss_pct is a FRACTION of PRODUCED kg (Renzo, 2026-09-15 - what the plant sweeps up is a property of what came OUT of the retort): Sum(waste_kg) / produced_kg_waste_reported, the produced kilos of the campaigns that actually filed waste rather than the group''s whole produced total, because production reporting begins 2025-11-27 and 22 of 32 campaigns fed the plant and filed no shift at all - the same reasoning yield_pct applies with fed_kg_production_reported. Measured on Q3 2026: 218,401.0 / 1,494,121.0 = 0.146174, where the earlier fed denominator read 0.114719. Read campaigns_waste_reported / campaign_count and waste_shift_count for the coverage. THE EIGHT STREAMS DO NOT SUM TO PROCESS LOSS - most of the retort''s loss leaves as moisture and volatiles nobody weighs - so waste_loss_pct is what was swept up and WEIGHED, never process_loss_pct. TWO DELIBERATE OMISSIONS, both because a block can be fed by more than one campaign (measured: 78 of 523 blocks, up to 5 campaigns each; 5 of Q3-2026''s 45 blocks): the group publishes NO block-resiko KG - only the weighted ratio, since SUM(weight_lost_kg) would charge a shared block''s whole-life shrinkage once per campaign - and it publishes NO whole-block actual_fed_php_kg, only the campaign-attributed form. Block COUNTS are given de-duplicated (blocks_fed_distinct) beside the naive sum, both labelled. php_per_produced_kg_true is strict NULL unless every campaign is fully covered AND reported production, with php_per_produced_kg_true_covered as the always-computed partial and campaigns_fully_covered / campaign_count so the UI can say "2 of 3 campaigns fully covered". A key that resolves to no campaign is returned in campaigns_missing rather than silently dropped. ₱ COLUMNS: fed_php_kg, fed_value_php, actual_fed_php_kg, uplift_php_kg, php_per_produced_kg_delivered, php_per_produced_kg_true, php_per_produced_kg_true_covered; NO waste column carries money.';


-- -----------------------------------------------------------------------------
-- 4. THE PROBES — day_ratio_mismatch, kpi_waste_pct_mismatch, gap_waste_pct
-- -----------------------------------------------------------------------------
-- Signatures unchanged, so CREATE OR REPLACE keeps the service_role-only grant.
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
            from k cross join dw), 0))::int                        as waste_stream_fold_mismatch,
      -- DAY-LEVEL RATIOS, added 2026-09-15. A SELF-CONSISTENCY check on the
      -- published row, computed once in SQL: each ratio must equal the division
      -- of the row's OWN inputs, which makes it 0 both when a ratio is present
      -- that should have been NULL and when a NULL is published over two real
      -- numbers. loss_pct is compared against 1 - the PUBLISHED yield_pct, so a
      -- row can never print a yield and a loss that do not add to 1.
      (select count(*) from d
        where d.waste_pct is distinct from (d.total_waste_kg / nullif(d.produced_kg, 0))
           or d.yield_pct is distinct from (d.produced_kg / nullif(d.fed_kg, 0))
           or d.loss_pct  is distinct from
                (case when d.yield_pct is null then null else 1 - d.yield_pct end))::int
                                                                   as day_ratio_mismatch,
      -- ...and the EOQ cell against its own two inputs: waste over PRODUCED kg.
      -- 0/1. This is what would catch the denominator silently reverting to fed.
      (select count(*) from k
        where k.waste_loss_pct is distinct from (k.waste_kg / nullif(k.produced_kg, 0)))::int
                                                                   as kpi_waste_pct_mismatch
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
'READ-ONLY verification probe for ONE ops-ledger campaign — the instrument behind scripts/verify-ops-ledger.ts, which calls it once per campaign, strictly sequentially. It replaces fn_ops_ledger_verify(), a single whole-history probe that hung the instance (OOM) on 2026-09-14 and took the live site down. EVERY subquery is filtered on production_batch + campaign_year (never on the computed campaign_key, which cannot be pushed down), which is what keeps a full run in the tens of milliseconds. It proves the four day-level FOLDS (grades, blocks fed, shift produced, shift downtime) against the day spine, the WASTE fold in both forms (waste_fold_mismatch = the campaign total vs the day spine''s, 0/1; waste_stream_fold_mismatch = how many of the EIGHT streams differ, 0..8 — because a total can agree while two streams are swapped), the day totals against the campaign KPI row, the grade fold against the campaign grade set, ledger_days against span_days, both REUSE comparisons (view_analytics_batch_cost and view_analytics_production_by_batch, column for column) and the ONE-campaign GROUP identity against fn_ops_ledger_group_kpis, waste columns included. SECURITY DEFINER (the views are authenticated-only, so no key a script can hold may read them), STABLE, service_role EXECUTE only. IT RETURNS NO ₱ VALUE: every money-derived key is a GAP that must be 0, a count, or a boolean. It also proves the DAY-LEVEL RATIOS added 2026-09-15 (day_ratio_mismatch: each of waste_pct, yield_pct and loss_pct must equal the division of the row''s OWN published inputs, which fails both on a ratio present where an input is missing and on a NULL published over two real numbers, and pins loss_pct to 1 - the published yield_pct) and the campaign cell''s new denominator (kpi_waste_pct_mismatch, 0/1: waste_loss_pct must equal waste_kg / produced_kg - this is what catches the denominator silently reverting to fed kg). Zero on every *_mismatch key is the passing state. RAISES on a key that is not <BATCH>-<YYYY> or that does not resolve to exactly one campaign span row.';

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
           sum(waste_kg) w,
           -- the WASTE-LOSS denominator, 2026-09-15: PRODUCED kg over the
           -- campaigns that actually filed waste.
           sum(produced_kg) filter (where waste_kg is not null) pw
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
      -- ...and the RATIO, added 2026-09-15: the group's waste_loss_pct must be
      -- Sum(waste) / Sum(PRODUCED) over the members that filed waste, computed
      -- here from the member rows themselves. Must be exactly 0.
      coalesce(g.waste_loss_pct - (dsum.w / nullif(dsum.pw, 0)), 0)      as gap_waste_pct,
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
'READ-ONLY: proves fn_ops_ledger_group_kpis over a CHOSEN set of campaigns (Q3 2026 = JULY-2026 + AUGUST-2026 + SEPTEMBER-2026) against a direct sum of those campaigns'' own view_ops_ledger_campaign_kpis rows — gap_yield / gap_fed_rate / gap_pc_rate / gap_fed_kg / gap_produced_kg / gap_waste_kg / gap_waste_pct must all be exactly 0 (gap_waste_pct, added 2026-09-15, recomputes the group''s waste_loss_pct as Sum(waste_kg) / Sum(produced_kg) over the members that filed waste) — and reports the de-duplicated vs naive block counts, the coverage counts (blocks, campaigns fully covered, campaigns_waste_reported, waste_shift_count), the ledger/active/rest day split and the changeover surplus. gap_waste_kg is exact BY CONSTRUCTION and that is the point: waste is filed per shift and a shift belongs to one campaign, so unlike block resiko it partitions cleanly and a non-zero gap would mean the group stopped summing the campaign view. IT RAISES ABOVE 12 KEYS, deliberately: after the 2026-09-14 incident a verification read must be structurally incapable of walking all 32 campaigns in one statement. An unknown key is REPORTED in campaigns_missing_count, never silently dropped. SECURITY DEFINER, STABLE, service_role EXECUTE only; returns NO ₱ VALUE — only zero-gaps, counts and booleans.';


-- -----------------------------------------------------------------------------
-- 5. POSTURE — re-ALTER security_invoker, re-GRANT what DROP + CREATE lost
-- -----------------------------------------------------------------------------
-- CREATE OR REPLACE VIEW keeps GRANTS and RESETS reloptions. Both replaced
-- views therefore get security_invoker put back HERE, in the same migration
-- that replaced them — never in a follow-up, which is how it was missed twice.
alter view public.view_ops_ledger_day           set (security_invoker = true);
alter view public.view_ops_ledger_campaign_kpis set (security_invoker = true);

-- The grants a REPLACE kept, restated so the file says what the posture is.
revoke all on public.view_ops_ledger_day             from public, anon;
revoke all on public.view_ops_ledger_campaign_kpis   from public, anon;
grant select on public.view_ops_ledger_day           to authenticated;
grant select on public.view_ops_ledger_campaign_kpis to authenticated;

-- The grants the DROP destroyed. Without these two lines the /operations page
-- 403s for every signed-in user and nothing else in the system notices.
revoke execute on function public.fn_ops_ledger_group_kpis(text[]) from public, anon;
grant  execute on function public.fn_ops_ledger_group_kpis(text[]) to authenticated;

-- Restated, not assumed: the probes are SECURITY DEFINER over authenticated-only
-- views, so they may never be reachable by authenticated or anon.
revoke execute on function public.fn_ops_ledger_verify_campaign(text)   from public, anon, authenticated;
grant execute on function public.fn_ops_ledger_verify_campaign(text)   to service_role;
revoke execute on function public.fn_ops_ledger_verify_group(text[])   from public, anon, authenticated;
grant execute on function public.fn_ops_ledger_verify_group(text[])   to service_role;
