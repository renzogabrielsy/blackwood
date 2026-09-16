-- =============================================================================
-- OPS LEDGER — THE ONE-CAMPAIGN-GROUP IDENTITY SPLITS OUT PC COST (DELIVERED)
-- 2026-09-16
-- =============================================================================
-- PROBE ONLY. No view changes, no published number changes, no grant changes.
--
-- WHAT HAPPENED. `single_campaign_group_mismatch` proves that a group of ONE
-- campaign equals that campaign's own KPI row, column for column. On 2026-09-16
-- it began returning 1 for SEPTEMBER 2026, and the cause is not a regression in
-- anything: it is a REAL, PRE-EXISTING ASYMMETRY between two NULL rules that no
-- campaign had ever exercised.
--
--   * `view_analytics_batch_cost.php_per_produced_kg_delivered` is STRICT NULL
--     unless the campaign's fed price is 100% TRACEABLE. The ops-ledger KPI row
--     lifts it verbatim, so it is NULL too (kpi_vs_batch_cost_mismatch = 0).
--   * `fn_ops_ledger_group_kpis.php_per_produced_kg_delivered` is
--     SUM(fed_value_php) / SUM(produced_kg) with NO coverage guard.
--
-- MEASURED: SEPTEMBER 2026 fed 452,970 kg of which **2,000 kg came from a block
-- with no delivery rows**, so its coverage is **99.5585%** — the campaign
-- publishes NULL and the group publishes **60.904**. Every other column of the
-- identity agrees exactly, and so does `php_per_produced_kg_true`, because BOTH
-- sides already go strict-NULL there.
--
-- WHY THE PROBE MOVES AND NOT THE NUMBER. Bringing the group's rule into line
-- with the campaign's would BLANK the PC COST cell on Renzo's EOQ strip for any
-- group containing a partially-traceable campaign — a change to a figure he
-- reads, which is his decision and not a side effect of a verification fix. And
-- the reverse — dropping the campaign's strict rule — is the L-008 mistake in a
-- new costume: a PC cost computed over money that is missing the untraceable
-- kilos is UNDERSTATED, which points the opposite way from what the figure is
-- for.
--
-- SO THE DIVERGENCE IS ISOLATED AND COUNTED, NEVER EXCUSED. The identity key
-- stops testing this one column; two new keys take its place:
--   group_pc_cost_delivered_mismatch             must be 0 ALWAYS — whenever the
--                                                campaign publishes a NUMBER the
--                                                two must agree exactly
--   group_pc_cost_delivered_coverage_divergence  0 or 1 — the campaign is NULL
--                                                for coverage while the group
--                                                publishes a figure. The verify
--                                                script PRINTS the campaigns it
--                                                fires on, so it stays a visible
--                                                open item rather than becoming
--                                                a silenced alarm.
--
-- CREATE OR REPLACE FUNCTION with an unchanged signature and return type keeps
-- its grants; they are restated below anyway.
-- =============================================================================


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
  -- THE CAMPAIGN x BLOCK grain, added 2026-09-15 (round 3). Filtered on the two
  -- base columns like every other CTE here, so it pushes down into rc_out.
  cbv as materialized (
    select v.* from public.view_ops_ledger_campaign_block v
     where v.production_batch = v_batch and v.campaign_year = v_year
  ),
  -- THE DAY'S PROJECTED FED BLEND, added 2026-09-16. Same filter shape as every
  -- other CTE here, so it pushes down into rc_out.
  fb as materialized (
    select f.* from public.view_ops_ledger_day_fed_blend f
     where f.production_batch = v_batch and f.campaign_year = v_year
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
                                                                   as kpi_waste_pct_mismatch,
      -- THE CAMPAIGN BLOCKS TABLE, added 2026-09-15 (round 3). Its whole reason
      -- for existing is campaign_fed_kg -- what THIS campaign drew from a block,
      -- as opposed to the block's all-time total -- so the fold that matters is
      -- that those kilos add up to the campaign's own fed_kg. It aggregates
      -- view_rc_movement_campaign_cells, the same relation the day spine folds,
      -- so 0 is the only answer unless someone re-derives one of the two.
      (select count(*) from k cross join (select sum(v.campaign_fed_kg) as s from cbv v) t
        where k.fed_kg is distinct from t.s)::int                   as campaign_block_fold_mismatch,
      -- ...and the ROW COUNT against blocks_fed, which reaches the KPI row from
      -- view_rc_movement_campaign_actual_price's own copy of this aggregation.
      -- A row too many or too few here is a modal listing a different set of
      -- blocks than the coverage badge above it counts.
      (select count(*) from k cross join (select count(*)::int as c from cbv) t
        where coalesce(k.blocks_fed, 0) is distinct from t.c)::int  as campaign_block_count_mismatch,
      -- THE DAY'S PROJECTED FED BLEND, added 2026-09-16. It is a GROUP BY over
      -- view_ops_ledger_day_block, the very relation the day spine's fed_kg
      -- folds, so its kilos must be the campaign's own fed_kg to the digit --
      -- anything else means the sidebar's blended head was weighted over a
      -- different population than the block rows printed beneath it.
      (select count(*) from k cross join (select sum(f.fed_kg) as s from fb f) t
        where k.fed_kg is distinct from t.s)::int                   as fed_blend_fold_mismatch,
      -- ...and it must have exactly one row per ledger day that fed anything.
      -- A day short here is a FED cell the sidebar cannot open; a day extra is a
      -- blend over a day the ledger says fed nothing.
      (select count(*)
         from (select count(*)::int as c from fb) t
         cross join (select count(*)::int as c from d where d.fed_kg > 0) u
        where t.c is distinct from u.c)::int                        as fed_blend_day_count_mismatch,
      -- THE BLOCKS FOOTER, added 2026-09-16. blocks_resiko_kg and
      -- blocks_closed_resiko_loss_pct are the modal footer's own Sigma over
      -- view_ops_ledger_campaign_block, and block_resiko_kg /
      -- block_resiko_loss_pct are view_analytics_batch_cost's. They are two
      -- arithmetics over the same CLOSED blocks and they must agree exactly;
      -- this is what keeps the published agreement a re-derived fact rather than
      -- a sentence in a COMMENT.
      (select count(*) from k
        where k.blocks_resiko_kg is distinct from k.block_resiko_kg
           or k.blocks_closed_resiko_loss_pct is distinct from k.block_resiko_loss_pct)::int
                                                                    as kpi_blocks_resiko_mismatch
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
           or g.waste_loss_pct is distinct from k.waste_loss_pct)::int as single_campaign_group_mismatch,
      -- PC COST (DELIVERED) IS ISOLATED, 2026-09-16 — see the COMMENT. The two
      -- sides apply DIFFERENT NULL RULES on purpose, so folding this column into
      -- the identity above tested a policy, not the group machinery. When the
      -- campaign publishes a number the two must agree exactly:
      (select count(*) from k cross join g1 g
        where k.php_per_produced_kg_delivered is not null
          and g.php_per_produced_kg_delivered is distinct from k.php_per_produced_kg_delivered)::int
                                                                as group_pc_cost_delivered_mismatch,
      -- ...and when the campaign publishes NULL because its fed price is not
      -- fully TRACEABLE while the group publishes a figure anyway, that is the
      -- KNOWN divergence, COUNTED so it can never become invisible. 0 or 1.
      (select count(*) from k cross join g1 g
        where k.php_per_produced_kg_delivered is null
          and g.php_per_produced_kg_delivered is not null)::int  as group_pc_cost_delivered_coverage_divergence
  )
  select jsonb_build_object('campaign_key', btrim(p_campaign_key))
         || to_jsonb(counts) || to_jsonb(folds) || to_jsonb(reuse)
    into v_out
    from counts, folds, reuse;

  return v_out;
end;
$fn$;

comment on function public.fn_ops_ledger_verify_campaign(text) is
'READ-ONLY verification probe for ONE ops-ledger campaign — the instrument behind scripts/verify-ops-ledger.ts, which calls it once per campaign, strictly sequentially. It replaces fn_ops_ledger_verify(), a single whole-history probe that hung the instance (OOM) on 2026-09-14 and took the live site down. EVERY subquery is filtered on production_batch + campaign_year (never on the computed campaign_key, which cannot be pushed down), which is what keeps a full run in the tens of milliseconds. It proves the four day-level FOLDS (grades, blocks fed, shift produced, shift downtime) against the day spine, the WASTE fold in both forms (waste_fold_mismatch = the campaign total vs the day spine''s, 0/1; waste_stream_fold_mismatch = how many of the EIGHT streams differ, 0..8 — because a total can agree while two streams are swapped), the day totals against the campaign KPI row, the grade fold against the campaign grade set, ledger_days against span_days, both REUSE comparisons (view_analytics_batch_cost and view_analytics_production_by_batch, column for column) and the ONE-campaign GROUP identity against fn_ops_ledger_group_kpis, waste columns included. SECURITY DEFINER (the views are authenticated-only, so no key a script can hold may read them), STABLE, service_role EXECUTE only. IT RETURNS NO ₱ VALUE: every money-derived key is a GAP that must be 0, a count, or a boolean. It also proves the DAY-LEVEL RATIOS added 2026-09-15 (day_ratio_mismatch: each of waste_pct, yield_pct and loss_pct must equal the division of the row''s OWN published inputs, which fails both on a ratio present where an input is missing and on a NULL published over two real numbers, and pins loss_pct to 1 - the published yield_pct) and the campaign cell''s new denominator (kpi_waste_pct_mismatch, 0/1: waste_loss_pct must equal waste_kg / produced_kg - this is what catches the denominator silently reverting to fed kg). It also proves the CAMPAIGN x BLOCK table added 2026-09-15 (campaign_block_fold_mismatch: SUM(view_ops_ledger_campaign_block.campaign_fed_kg) must equal the campaign KPI row''s fed_kg, which is what keeps the FED PRICE / ACTUAL FED PRICE modal from crediting a campaign with kilos another campaign ate out of a shared block; campaign_block_count_mismatch: its row count must equal blocks_fed). It also proves THE DAY''S PROJECTED FED BLEND added 2026-09-16 (fed_blend_fold_mismatch: SUM(view_ops_ledger_day_fed_blend.fed_kg) must equal the campaign KPI row''s fed_kg, since the blend is a GROUP BY over view_ops_ledger_day_block -- the very relation the day spine folds -- so anything but 0 means the sidebar''s blended head was weighted over a different population than the block rows printed beneath it; fed_blend_day_count_mismatch: exactly one blend row per ledger day with fed_kg > 0, so a FED cell can never be un-openable and a blend can never describe a day the ledger says fed nothing) and THE BLOCKS FOOTER (kpi_blocks_resiko_mismatch: the footer''s own Sigma resiko over view_ops_ledger_campaign_block must equal block_resiko_kg from view_analytics_batch_cost, and likewise the ratio -- two arithmetics over the same CLOSED blocks, so the published agreement is re-derived every run instead of living only in a COMMENT). PC COST (DELIVERED) IS DELIBERATELY NOT PART OF THAT IDENTITY (2026-09-16), and the reason is a REAL, PRE-EXISTING ASYMMETRY the data exposed rather than a bug in either view: view_analytics_batch_cost publishes php_per_produced_kg_delivered as STRICT NULL unless the campaign''s fed price is 100% traceable, while fn_ops_ledger_group_kpis computes Sum(fed_value)/Sum(produced) with no coverage guard. Both rules are as written; they only ever differed once a campaign fell below 100%, which SEPTEMBER 2026 did when 2,000 of its 452,970 fed kg came from a block with no delivery rows (coverage 99.5585%) - the campaign then reads NULL and the group reads 60.904. Folding that into a single identity key was testing a POLICY, not the group machinery, so it is split into two keys instead: group_pc_cost_delivered_mismatch (0: whenever the campaign publishes a NUMBER the two must agree exactly) and group_pc_cost_delivered_coverage_divergence (0 or 1: the campaign is NULL for coverage while the group publishes a figure - COUNTED, never excused, so it stays visible until the group''s NULL rule is brought into line with the campaign''s, which is a separate decision because it blanks a figure on Renzo''s own EOQ strip). php_per_produced_kg_true is NOT split, because BOTH sides already go strict-NULL there. Zero on every *_mismatch key is the passing state. RAISES on a key that is not <BATCH>-<YYYY> or that does not resolve to exactly one campaign span row.';


-- Restated, not required: a same-signature CREATE OR REPLACE keeps grants. The
-- probe is SECURITY DEFINER over ten authenticated-only views, so a stray grant
-- to `authenticated` would hand a client role a read of all of them.
revoke execute on function public.fn_ops_ledger_verify_campaign(text)   from public, anon, authenticated;
grant execute on function public.fn_ops_ledger_verify_campaign(text)   to service_role;
