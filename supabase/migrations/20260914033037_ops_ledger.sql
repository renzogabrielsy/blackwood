-- =============================================================================
-- PLANT OPERATIONS LEDGER — the data layer  (/operations)
-- =============================================================================
-- Renzo's `Q3 2026` + `EOQ3 2026` workbook tabs, as SQL.
--
-- ONE ROW PER CALENDAR DAY on the PRODUCTION-BATCH (campaign) clock — the same
-- clock `/inventory/rc-movement` already runs on — with rest days present as
-- blank rows, three day-grain LENSES hanging off that spine (grades, blocks fed,
-- blocks used), a per-SHIFT expand, a per-campaign KPI row (his EOQ tab) and a
-- GROUP KPI function (Q3 = JULY + AUGUST + SEPTEMBER).
--
-- THE GOVERNING RULE, inherited from the analytics phases: NOTHING THAT ALREADY
-- HAS A HOME IS RE-DERIVED. Fed kg, fed ₱/kg, produced kg, the downtime fold,
-- yield, the shrinkage-adjusted price, block loss and every coverage count are
-- SELECTed verbatim from the views that own them. What is new here is the SPINE
-- (a calendar day inside a campaign, rest days included) and the FOLD.
--
-- Posture, identical to analytics P1-P4: every view `security_invoker`,
-- `authenticated` SELECT only, `anon` REVOKEd, and **no `service_role`** — the
-- sync worker reads none of them, so `verify-worker-view-grants` stays at 4
-- views / 0 findings (L-044's arrow direction: a consumer is not a dependency).
--
-- ₱ COLUMNS ARE NAMED IN EVERY COMMENT. Only `view_ops_ledger_day.fed_php_kg`,
-- `view_ops_ledger_campaign_kpis` and `fn_ops_ledger_group_kpis` carry money;
-- the shift expand, the grade lens, the block lens and the blocks-used expand
-- carry none and none is derivable, so they are safe for Production.
-- =============================================================================


-- -----------------------------------------------------------------------------
-- 1. view_ops_ledger_campaign_span — THE SPINE'S SPINE
-- -----------------------------------------------------------------------------
-- One row per campaign, with the campaign's FULL calendar span.
--
-- THE SPAN IS THE UNION OF FEEDING AND PRODUCTION, never feeding alone, and that
-- is measured, not defensive: JULY 2026 last FED on 2026-07-29 and went on
-- PRODUCING through 2026-08-01 (22,862 + 4,620 + 2,466 kg), and SEPTEMBER 2026
-- opened its first shift on 2026-08-29, three days before its first feed. A
-- fed-only span would have silently dropped three producing days off the end of
-- July and the opening day of September.
create or replace view public.view_ops_ledger_campaign_span as
with campaign as (
  select o.production_batch, o.campaign_year
    from public.view_rc_movement_campaign_options o
  union
  select s.production_batch, (extract(year from s.transaction_date))::int
    from public.production_shifts s
   where coalesce(btrim(s.production_batch), '') <> ''
),
sh as (
  select s.production_batch,
         (extract(year from s.transaction_date))::int as campaign_year,
         min(s.transaction_date) as first_shift_date,
         max(s.transaction_date) as last_shift_date,
         count(*)::int           as shift_count
    from public.production_shifts s
   where coalesce(btrim(s.production_batch), '') <> ''
   group by 1, 2
)
select
  c.production_batch,
  c.campaign_year,
  (c.production_batch || '-' || c.campaign_year::text) as campaign_key,
  (c.production_batch || ' ' || c.campaign_year::text) as campaign_label,
  o.min_date          as first_fed_date,
  o.max_date          as last_fed_date,
  sh.first_shift_date,
  sh.last_shift_date,
  -- LEAST / GREATEST ignore NULLs in Postgres, which is exactly the behaviour a
  -- fed-only or production-only campaign needs.
  least(o.min_date, sh.first_shift_date)    as first_date,
  greatest(o.max_date, sh.last_shift_date)  as last_date,
  (greatest(o.max_date, sh.last_shift_date) - least(o.min_date, sh.first_shift_date) + 1)::int as span_days,
  coalesce(o.feed_days, 0)::int             as feed_days,
  coalesce(sh.shift_count, 0)::int          as shift_count
from campaign c
left join public.view_rc_movement_campaign_options o
       on o.production_batch = c.production_batch
      and o.campaign_year    = c.campaign_year
left join sh
       on sh.production_batch = c.production_batch
      and sh.campaign_year    = c.campaign_year;

comment on view public.view_ops_ledger_campaign_span is
'Ops ledger: one row per production campaign with the FULL calendar span the ledger must draw — first_date = the earlier of its first MAIN feed and its first production shift, last_date = the later of its last. Measured reason: JULY 2026 fed to 2026-07-29 but produced through 2026-08-01, and SEPTEMBER 2026 opened a shift on 2026-08-29 before its first feed on 2026-09-01, so a feeding-only span loses real operating days at both ends. campaign_key is the URL-safe "JULY-2026" key /inventory/rc-movement already uses; campaign_label is "JULY 2026", the analytics spelling. NO ₱ COLUMN. Inherited property: campaign_year is EXTRACT(year FROM the row date), so a campaign straddling New Year would split into two keys — measured 0 occurrences today.';


-- -----------------------------------------------------------------------------
-- 2. view_ops_ledger_shift — THE PER-SHIFT EXPAND
-- -----------------------------------------------------------------------------
-- One row per production shift, on the campaign clock. This is BUILT FIRST and
-- the day view FOLDS it, so the day totals and the expand can never disagree.
--
-- Every number comes from `view_production_daily`, which already owns the
-- downtime fold (`dt_hrs + dt_mins/60`) and the eight waste columns; the three
-- columns L-051/L-051b added (`dt_ranges`, `dt_incident_ranges`,
-- `shift_hrs_source`) live only on the base table, so those three — and nothing
-- else — are read from `production_downtime`.
create or replace view public.view_ops_ledger_shift as
select
  (ps.production_batch || '-' || (extract(year from ps.transaction_date))::int::text) as campaign_key,
  ps.production_batch,
  (extract(year from ps.transaction_date))::int as campaign_year,
  ps.transaction_date as calendar_date,
  ps.id               as shift_id,
  ps.shift,

  -- hours
  vpd.shift_hrs,
  pd.shift_hrs_source,
  vpd.dt_hrs,
  vpd.dt_mins,
  vpd.dt_total_hrs    as downtime_hours,
  vpd.productive_hrs,
  vpd.dt_reason,
  pd.dt_ranges,
  pd.dt_incident_ranges,
  (coalesce(btrim(pd.dt_incident_ranges), '') <> '') as has_incident,
  (pd.id is not null)                                as downtime_row_present,

  -- output. NULL, never 0, when the shift filed no run: view_production_daily
  -- COALESCEs its total to 0, which would claim "produced nothing" where the
  -- truth is "nothing recorded".
  case when rr.run_count > 0 then vpd.total_output_kg end as produced_kg,
  coalesce(rr.run_count, 0)::int                          as run_count,
  rr.sacks,
  coalesce(rr.runs_with_sacks, 0)::int                    as runs_with_sacks,

  -- the eight recorded waste streams, in Renzo's own left-to-right order.
  -- NULL when the shift filed no waste row; they do NOT sum to the day's drift
  -- (most of it leaves as moisture and volatiles, which nobody weighs).
  vpd.trml1_kg,
  vpd.trml2_kg,
  vpd.rs1a_kg,
  vpd.rs1b_kg,
  vpd.rs23_kg,
  vpd.rs5_kg,
  vpd.bf_kg,
  vpd.grit_kg,
  case when coalesce(vpd.trml1_kg, vpd.trml2_kg, vpd.rs1a_kg, vpd.rs1b_kg,
                     vpd.rs23_kg, vpd.rs5_kg, vpd.bf_kg, vpd.grit_kg) is null
       then null else vpd.total_waste_kg end as total_waste_kg,
  vpd.waste_remarks,

  rr.runs
from public.production_shifts ps
join public.view_production_daily vpd on vpd.shift_id = ps.id
left join public.production_downtime pd on pd.shift_id = ps.id
left join lateral (
  select count(*)::int                                       as run_count,
         sum(r.sacks_bags)::bigint                            as sacks,
         count(*) filter (where r.sacks_bags is not null)::int as runs_with_sacks,
         jsonb_agg(jsonb_build_object(
           'grade',      r.grade,
           'customer',   r.customer,
           'ttl_kg',     r.ttl_kg,
           'sacks_bags', r.sacks_bags,
           'remarks',    r.remarks
         ) order by r.grade, r.created_at) as runs
    from public.production_runs r
   where r.shift_id = ps.id
) rr on true
where coalesce(btrim(ps.production_batch), '') <> '';

comment on view public.view_ops_ledger_shift is
'Ops ledger EXPAND: one row per production shift on the campaign clock, with hours, downtime (incl. the L-051 dt_ranges / L-051b dt_incident_ranges / shift_hrs_source), the eight waste streams and the shift''s runs as a jsonb array so nothing has to be folded in TypeScript. Every figure is SELECTed from view_production_daily, which owns the dt_hrs + dt_mins/60 fold; only the three text columns that view does not carry are read from production_downtime. produced_kg and total_waste_kg are NULL, never 0, when the shift filed no run / no waste row. NO ₱ COLUMN and none derivable.';


-- -----------------------------------------------------------------------------
-- 3. view_ops_ledger_day — THE ROW SPINE
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
  (coalesce(sa.run_count, 0) > 0)                       as production_reported
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
'THE OPS LEDGER ROW SPINE: one row per CALENDAR DAY of a production campaign, from the campaign''s first fed-or-reported day to its last, REST DAYS INCLUDED as rows with NULL facts (dropping a blank Sunday would make a month read as if it had 26 days). NULL IS NEVER 0 — a day that fed nothing reads NULL fed_kg, a day that produced nothing reads NULL produced_kg, a day with no waste row reads NULL waste. Nothing is re-derived: fed_kg sums view_rc_movement_campaign_cells (which owns FED = destination MAIN and the changeover split), fed_php_kg is view_rc_movement_campaign_day_price.wtd_fed_price verbatim, produced_kg is view_rc_movement_campaign_production_daily_total verbatim (the same figure the RC Movement matrix prints), and every hour and waste figure folds view_ops_ledger_shift, which folds view_production_daily. day_drift_kg = fed - produced is DAY-LEVEL DRIFT, NOT LOSS: the feed tank is continuous flow and the two numbers do not describe the same charcoal (JULY 2026 produced 22,862 kg on a day it fed nothing) - read loss from view_ops_ledger_campaign_kpis. THE ONE ₱ COLUMN IS fed_php_kg; it must be nulled server-side when !canViewPrices(). ROW BUDGET: ~31 rows per campaign (longest span measured 33, JULY 2026), ~1,000 rows over all 32 campaigns - fetch PER CAMPAIGN and fold in the adapter.';


-- -----------------------------------------------------------------------------
-- 4. view_ops_ledger_day_grade — the GRADES lens
-- -----------------------------------------------------------------------------
create or replace view public.view_ops_ledger_day_grade as
select
  (pd.production_batch || '-' || pd.campaign_year::text) as campaign_key,
  pd.production_batch,
  pd.campaign_year,
  pd.date          as calendar_date,
  pd.grade,
  pd.produced_kg   as kg,
  s.sacks,
  coalesce(s.run_count, 0)::int as run_count
from public.view_rc_movement_campaign_production_daily pd
left join lateral (
  select sum(r.sacks_bags)::bigint as sacks,
         count(*)::int             as run_count
    from public.production_runs r
    join public.production_shifts ps on ps.id = r.shift_id
   where ps.production_batch = pd.production_batch
     and (extract(year from ps.transaction_date))::int = pd.campaign_year
     and ps.transaction_date = pd.date
     and r.grade = pd.grade
) s on true;

comment on view public.view_ops_ledger_day_grade is
'Ops ledger GRADES lens: one row per (campaign, calendar day, grade). kg is SELECTed verbatim from view_rc_movement_campaign_production_daily, the same relation the day spine''s produced_kg is summed from, so a grade split can never disagree with the day headline - PROVEN, SUM(kg) per day = view_ops_ledger_day.produced_kg with zero mismatches. Grade columns are therefore DYNAMIC: read the campaign''s grade set from view_ops_ledger_campaign_grades, never hardcode 3X50/2X6/4X8. sacks is NULLABLE and not COALESCEd to 0 (bags were not counted before May 2026). NO ₱ COLUMN. ROW BUDGET: <= 48 rows per campaign (measured max).';


-- -----------------------------------------------------------------------------
-- 5. view_ops_ledger_day_block — the BLOCKS FED lens (the RC Movement lens)
-- -----------------------------------------------------------------------------
create or replace view public.view_ops_ledger_day_block as
select
  (c.production_batch || '-' || c.campaign_year::text) as campaign_key,
  c.production_batch,
  c.campaign_year,
  c.date       as calendar_date,
  c.batch_id,
  c.batch_code,
  c.block_loc,
  c.fed_kg,
  c.sundry_kg
from public.view_rc_movement_campaign_cells c;

comment on view public.view_ops_ledger_day_block is
'Ops ledger BLOCKS FED lens - THE UNIFICATION WITH /inventory/rc-movement: this is view_rc_movement_campaign_cells re-keyed on campaign_key, i.e. literally the cells of the RC Movement matrix (day x block, kg fed). One column per block in the UI. SUM(fed_kg) per day equals view_ops_ledger_day.fed_kg by construction and is PROVEN so. NO ₱ COLUMN. ROW BUDGET: <= 114 rows per campaign (measured max, MARCH 2026), 2,148 over all history - fetch PER CAMPAIGN, a whole-history read would hit PostgREST''s 1000-row cap.';


-- -----------------------------------------------------------------------------
-- 6. view_ops_ledger_day_blocks_used — the BLOCKS USED expand
-- -----------------------------------------------------------------------------
create or replace view public.view_ops_ledger_day_blocks_used as
select
  (c.production_batch || '-' || c.campaign_year::text) as campaign_key,
  c.production_batch,
  c.campaign_year,
  c.date        as calendar_date,
  c.batch_id,
  p.batch_code,
  p.block_loc,
  p.first_fed_date,          -- DATE OPEN
  p.close_date,              -- DATE CLOSE (NULL while open)
  p.is_closed,
  p.status,
  c.fed_kg      as day_fed_kg,
  p.total_fed_kg,            -- all-time MAIN kg out of this block
  p.total_out_kg,            -- all-time kg out incl. sundry pulls
  p.delivered_kg,            -- ARRIVAL WEIGHT
  p.weight_lost_kg,          -- delivered - out. Only LOSS once closed.
  p.loss_pct,
  -- RESIKO vs BALANCE: the same subtraction means two different things.
  case when p.is_closed then p.weight_lost_kg end     as resiko_kg,
  case when p.is_closed then p.loss_pct       end     as resiko_pct,
  case when not p.is_closed then p.weight_lost_kg end as balance_kg,
  p.has_sundry_outflow,
  p.sundry_kg,
  p.has_unpriced_delivery,
  p.unpriced_delivery_count,
  p.feed_count,
  p.delivery_count
from public.view_rc_movement_campaign_cells c
join public.view_rc_movement_block_actual_price p on p.batch_id = c.batch_id;

comment on view public.view_ops_ledger_day_blocks_used is
'Ops ledger BLOCKS USED expand: for every block a campaign drew from on a given day, that block''s whole life - date opened (first_fed_date), date closed, state, arrival weight, all-time fed weight and the weight it lost in the yard - joined to how much came out of it THAT DAY (day_fed_kg). Every life-cycle figure is SELECTed from view_rc_movement_block_actual_price (campaign-independent, all-time) and nothing is restated. RESIKO IS ONLY LOSS ONCE THE BLOCK IS CLOSED: weight_lost_kg is published raw, and the same subtraction is split into resiko_kg (closed - evaporation and resiko, a real loss) and balance_kg (open - charcoal still sitting in the pile, not loss yet), so a UI cannot print one as the other. NO ₱ COLUMN - the price half of view_rc_movement_block_actual_price is deliberately not carried here, so this expand is safe for Production. ROW BUDGET: same as the blocks-fed lens, <= 114 rows per campaign.';


-- -----------------------------------------------------------------------------
-- 7. view_ops_ledger_campaign_grades — which grade COLUMNS a campaign has
-- -----------------------------------------------------------------------------
create or replace view public.view_ops_ledger_campaign_grades as
select
  (g.production_batch || '-' || g.campaign_year::text) as campaign_key,
  g.production_batch,
  g.campaign_year,
  g.campaign_label,
  g.grade,
  g.kg,
  g.share_of_campaign_pct as share_pct,
  g.campaign_produced_kg,
  g.run_count,
  g.sacks,
  g.runs_with_sacks
from public.view_analytics_production_grade_by_batch g;

comment on view public.view_ops_ledger_campaign_grades is
'Ops ledger: which GRADE COLUMNS a campaign (or a group, by union) has, and how much of the campaign each one is. A thin re-key of view_analytics_production_grade_by_batch, whose share_of_campaign_pct JOINs its denominator from the parent monthly view rather than re-summing it - so a grade share is structurally incapable of disagreeing with the campaign headline. THE GRADE SET IS DATA, NEVER A HARDCODED LIST: read the columns from here. share_pct is a PERCENT (0-100), matching its source. NO ₱ COLUMN.';


-- -----------------------------------------------------------------------------
-- 8. view_ops_ledger_campaign_kpis — the EOQ tab, one row per campaign
-- -----------------------------------------------------------------------------
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
  ld.rest_days
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
) ld on true;

comment on view public.view_ops_ledger_campaign_kpis is
'Ops ledger EOQ ROW: one row per production campaign - RC FED, PRODUCED, YIELD, LOSS, BLOCK RESIKO LOSS, FED PRICE, ACTUAL FED PRICE, PC COST and TRUE PC COST, with every coverage count beside them. NOT ONE FIGURE IS COMPUTED HERE: every price, yield and coverage column is SELECTed verbatim from view_analytics_batch_cost (which itself lifts them from view_rc_movement_campaign_price / _campaign_actual_price / _campaign_yield) and every production column from view_analytics_production_by_batch - PROVEN identical on all 32 campaigns, zero mismatches. yield_pct, process_loss_pct, block_resiko_loss_pct and campaign_fed_kg_included_pct are FRACTIONS; fed_price_coverage_pct and sacks_coverage_pct are PERCENTS (0-100) - their sources'' conventions, kept rather than harmonised so a reader can compare the two screens digit for digit. php_per_produced_kg_true is NULL, never 0, unless every block the campaign fed is CLOSED and fully priced (is_fully_covered) - measured, 2 of the 9 2026 campaigns are not. ₱ COLUMNS: fed_php_kg, fed_value_php, actual_fed_php_kg, campaign_weighted_actual_fed_php_kg, uplift_php_kg, php_per_produced_kg_delivered, php_per_produced_kg_true - all must be nulled server-side when !canViewPrices(). ROW BUDGET: 32 rows, all history.';


-- -----------------------------------------------------------------------------
-- 9. fn_ops_ledger_group_kpis — the GROUP row (Q3 = JULY + AUGUST + SEPTEMBER)
-- -----------------------------------------------------------------------------
create or replace function public.fn_ops_ledger_group_kpis(p_campaign_keys text[])
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
  sundry_kg                         numeric
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
    sum(k.sundry_kg)                                          as sundry_kg
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
  a.sundry_kg
from agg a
cross join miss m
cross join dsp
cross join blk;
$$;

comment on function public.fn_ops_ledger_group_kpis(text[]) is
'THE GROUP KPI ROW - a chosen set of campaigns read as one period (Q3 2026 = JULY-2026 + AUGUST-2026 + SEPTEMBER-2026). Kilograms, hours, shifts and runs SUM; every ₱/kg and every ratio is WEIGHTED, never averaged: fed_php_kg = SUM(fed_value_php)/SUM(fed_kg), yield_pct = SUM(produced)/SUM(fed over the campaigns that reported production), and actual_fed_php_kg / uplift_php_kg / block_resiko_loss_pct are weighted by campaign_fed_kg_included, which PARTITIONS by campaign so no kilogram is double counted. TWO DELIBERATE OMISSIONS, both because a block can be fed by more than one campaign (measured: 78 of 523 blocks, up to 5 campaigns each; 5 of Q3-2026''s 45 blocks): the group publishes NO block-resiko KG - only the weighted ratio, since SUM(weight_lost_kg) would charge a shared block''s whole-life shrinkage once per campaign - and it publishes NO whole-block actual_fed_php_kg, only the campaign-attributed form. Block COUNTS are given de-duplicated (blocks_fed_distinct) beside the naive sum, both labelled. php_per_produced_kg_true is strict NULL unless every campaign is fully covered AND reported production, with php_per_produced_kg_true_covered as the always-computed partial and campaigns_fully_covered / campaign_count so the UI can say "2 of 3 campaigns fully covered". A key that resolves to no campaign is returned in campaigns_missing rather than silently dropped. ₱ COLUMNS: fed_php_kg, fed_value_php, actual_fed_php_kg, uplift_php_kg, php_per_produced_kg_delivered, php_per_produced_kg_true, php_per_produced_kg_true_covered.';


-- -----------------------------------------------------------------------------
-- 10. GRANTS — security_invoker, authenticated only, anon revoked, NO service_role
-- -----------------------------------------------------------------------------
alter view public.view_ops_ledger_campaign_span    set (security_invoker = true);
alter view public.view_ops_ledger_shift            set (security_invoker = true);
alter view public.view_ops_ledger_day              set (security_invoker = true);
alter view public.view_ops_ledger_day_grade        set (security_invoker = true);
alter view public.view_ops_ledger_day_block        set (security_invoker = true);
alter view public.view_ops_ledger_day_blocks_used  set (security_invoker = true);
alter view public.view_ops_ledger_campaign_grades  set (security_invoker = true);
alter view public.view_ops_ledger_campaign_kpis    set (security_invoker = true);

revoke all on public.view_ops_ledger_campaign_span   from public, anon;
revoke all on public.view_ops_ledger_shift           from public, anon;
revoke all on public.view_ops_ledger_day             from public, anon;
revoke all on public.view_ops_ledger_day_grade       from public, anon;
revoke all on public.view_ops_ledger_day_block       from public, anon;
revoke all on public.view_ops_ledger_day_blocks_used from public, anon;
revoke all on public.view_ops_ledger_campaign_grades from public, anon;
revoke all on public.view_ops_ledger_campaign_kpis   from public, anon;

grant select on public.view_ops_ledger_campaign_span   to authenticated;
grant select on public.view_ops_ledger_shift           to authenticated;
grant select on public.view_ops_ledger_day             to authenticated;
grant select on public.view_ops_ledger_day_grade       to authenticated;
grant select on public.view_ops_ledger_day_block       to authenticated;
grant select on public.view_ops_ledger_day_blocks_used to authenticated;
grant select on public.view_ops_ledger_campaign_grades to authenticated;
grant select on public.view_ops_ledger_campaign_kpis   to authenticated;

revoke execute on function public.fn_ops_ledger_group_kpis(text[]) from public, anon;
grant  execute on function public.fn_ops_ledger_group_kpis(text[]) to authenticated;

-- NOTE (2026-09-14, after the incident): this migration originally carried two
-- further sections — `fn_ops_ledger_verify()` and `fn_ops_ledger_verify_groups()`
-- — a pair of SECURITY DEFINER probes that count(*)'d and cross-checked EVERY
-- view above over the WHOLE of history in ONE call. Running the first of them
-- hung the Supabase instance (OOM) and took the live site down until a dashboard
-- restart. Both sections have been REMOVED from this file; the probe that was
-- already applied was dropped by `20260914064415_drop_fn_ops_ledger_verify.sql`,
-- and `fn_ops_ledger_verify_groups` was never applied at all.
-- The replacement is `20260914065453_ops_ledger_verify_per_campaign.sql`: three
-- probes that are PER CAMPAIGN by construction (the group one refuses more than
-- 12 keys), so no single call can ever walk the whole view stack again.
-- HARD RULE for this view stack: never a whole-history proof. Every check is
-- filtered on `production_batch` + `campaign_year`, one campaign per statement,
-- under `set local statement_timeout = '5s'`.
