-- =============================================================================
-- OPS LEDGER VERIFICATION — PER CAMPAIGN, NEVER WHOLE HISTORY
-- =============================================================================
-- WHY THIS EXISTS IN THIS SHAPE (2026-09-14 incident).
-- The original probe, `fn_ops_ledger_verify()`, was ONE SECURITY DEFINER call
-- that count(*)'d every `view_ops_ledger_*` view over the WHOLE of history and
-- cross-checked every fold across all 32 campaigns at once. Running it hung the
-- Supabase instance (OOM) and took the live site down until a dashboard restart.
-- It has been DROPPED (`20260914064415_drop_fn_ops_ledger_verify.sql`); its
-- sibling `fn_ops_ledger_verify_groups()` — which called the group RPC once per
-- campaign — was never applied at all.
--
-- THE RULE THE REPLACEMENT ENFORCES STRUCTURALLY: a verification read is scoped
-- to ONE campaign, and a group read to at most TWELVE keys. It is not a matter
-- of how the caller uses these functions — `fn_ops_ledger_verify_campaign` takes
-- a single campaign key and `fn_ops_ledger_verify_group` RAISES above 12 keys,
-- so it is impossible to point either of them at all history. Measured, JULY
-- 2026, each under a 5 s guard: campaign_span 18 ms, shift 43 ms (28 rows),
-- day_block 36 ms (94), day 47 ms (33 rows, 5 rest), day_grade 7 ms (48),
-- day_blocks_used 23 ms (94), campaign_grades 26 ms (3), campaign_kpis 85 ms (1),
-- fn_ops_ledger_group_kpis(Q3) 147 ms.
--
-- EVERY PREDICATE IS ON `production_batch` + `campaign_year`, NOT ON
-- `campaign_key`. campaign_key is a concatenation computed inside the views, so
-- a filter on it cannot be pushed down into the CTEs underneath; a filter on the
-- two base columns can, and that pushdown is the whole reason the reads above
-- are measured in tens of milliseconds.
--
-- ALL THREE FUNCTIONS RETURN NO ₱ VALUE. Every money-derived check is published
-- as a GAP that must be exactly 0, a COUNT, or a BOOLEAN about nullness; a zero
-- difference says nothing about the numbers underneath it. SECURITY DEFINER
-- (the views are authenticated-only, so no key a script can hold may read them),
-- STABLE, `set search_path = public`, EXECUTE revoked from PUBLIC/anon/
-- authenticated and granted to `service_role` only.
--
-- `plan_cache_mode = force_custom_plan` is pinned on each one deliberately: the
-- campaign key arrives as a plpgsql parameter, and a generic plan would plan the
-- folds without knowing how narrow the filter is.
-- =============================================================================


-- -----------------------------------------------------------------------------
-- 1. fn_ops_ledger_verify_campaign(p_campaign_key) — ONE campaign, all folds
-- -----------------------------------------------------------------------------
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
        where k.ledger_days is distinct from k.span_days)::int     as ledger_days_vs_span_mismatch
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
           or g.last_date is distinct from k.last_date)::int        as single_campaign_group_mismatch
  )
  select jsonb_build_object('campaign_key', btrim(p_campaign_key))
         || to_jsonb(counts) || to_jsonb(folds) || to_jsonb(reuse)
    into v_out
    from counts, folds, reuse;

  return v_out;
end;
$fn$;

comment on function public.fn_ops_ledger_verify_campaign(text) is
'READ-ONLY verification probe for ONE ops-ledger campaign — the instrument behind scripts/verify-ops-ledger.ts, which calls it once per campaign, strictly sequentially. It replaces fn_ops_ledger_verify(), a single whole-history probe that hung the instance (OOM) on 2026-09-14 and took the live site down. EVERY subquery is filtered on production_batch + campaign_year (never on the computed campaign_key, which cannot be pushed down), which is what keeps a full run in the tens of milliseconds. It proves the four day-level FOLDS (grades, blocks fed, shift produced, shift downtime) against the day spine, the day totals against the campaign KPI row, the grade fold against the campaign grade set, ledger_days against span_days, both REUSE comparisons (view_analytics_batch_cost and view_analytics_production_by_batch, column for column) and the ONE-campaign GROUP identity against fn_ops_ledger_group_kpis. SECURITY DEFINER (the views are authenticated-only, so no key a script can hold may read them), STABLE, service_role EXECUTE only. IT RETURNS NO ₱ VALUE: every money-derived key is a GAP that must be 0, a count, or a boolean. Zero on every *_mismatch key is the passing state. RAISES on a key that is not <BATCH>-<YYYY> or that does not resolve to exactly one campaign span row.';


-- -----------------------------------------------------------------------------
-- 2. fn_ops_ledger_verify_group(p_campaign_keys) — the GROUP proof, capped at 12
-- -----------------------------------------------------------------------------
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
    select sum(fed_kg) f, sum(produced_kg) p, sum(fed_value_php) v
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
'READ-ONLY: proves fn_ops_ledger_group_kpis over a CHOSEN set of campaigns (Q3 2026 = JULY-2026 + AUGUST-2026 + SEPTEMBER-2026) against a direct sum of those campaigns'' own view_ops_ledger_campaign_kpis rows — gap_yield / gap_fed_rate / gap_pc_rate / gap_fed_kg / gap_produced_kg must all be exactly 0 — and reports the de-duplicated vs naive block counts, the coverage counts, the ledger/active/rest day split and the changeover surplus. IT RAISES ABOVE 12 KEYS, deliberately: after the 2026-09-14 incident a verification read must be structurally incapable of walking all 32 campaigns in one statement. An unknown key is REPORTED in campaigns_missing_count, never silently dropped. SECURITY DEFINER, STABLE, service_role EXECUTE only; returns NO ₱ VALUE — only zero-gaps, counts and booleans.';


-- -----------------------------------------------------------------------------
-- 3. fn_ops_ledger_verify_posture() — CATALOG ONLY
-- -----------------------------------------------------------------------------
-- The one read of a ledger view here is `view_ops_ledger_campaign_span` (32 rows,
-- 9 ms), and it exists only so the script can ENUMERATE the campaigns it must
-- then verify one at a time. Nothing else in this function touches a ledger view:
-- everything is pg_class / pg_description / has_*_privilege /
-- information_schema.columns.
create or replace function public.fn_ops_ledger_verify_posture()
returns jsonb
language sql
stable
security definer
set search_path = public
as $fn$
with
 posture as (
   select
     (select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace
       where n.nspname='public' and c.relname like 'view_ops_ledger%'
         and coalesce((select option_value from pg_options_to_table(c.reloptions) where option_name='security_invoker'),'false') <> 'true')::int as not_security_invoker,
     (select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace
       where n.nspname='public' and c.relname like 'view_ops_ledger%'
         and not has_table_privilege('authenticated', c.oid, 'SELECT'))::int as missing_authenticated_select,
     (select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace
       where n.nspname='public' and c.relname like 'view_ops_ledger%'
         and has_table_privilege('anon', c.oid, 'SELECT'))::int as anon_can_select,
     (select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace
       where n.nspname='public' and c.relname like 'view_ops_ledger%'
         and has_table_privilege('service_role', c.oid, 'SELECT'))::int as service_role_can_select,
     (select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace
       where n.nspname='public' and c.relname like 'view_ops_ledger%')::int as view_count,
     (select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace
       left join pg_description d on d.objoid=c.oid and d.objsubid=0
       where n.nspname='public' and c.relname like 'view_ops_ledger%' and d.description is null)::int as views_without_comment,
     has_function_privilege('authenticated','public.fn_ops_ledger_group_kpis(text[])','EXECUTE') as fn_authenticated_execute,
     has_function_privilege('anon','public.fn_ops_ledger_group_kpis(text[])','EXECUTE')          as fn_anon_execute,
     has_function_privilege('service_role','public.fn_ops_ledger_group_kpis(text[])','EXECUTE')  as fn_service_role_execute,
     has_function_privilege('authenticated','public.fn_ops_ledger_group_kpis(text[])','EXECUTE') as fn_group_authenticated_execute,
     has_function_privilege('anon','public.fn_ops_ledger_group_kpis(text[])','EXECUTE')          as fn_group_anon_execute,
     has_function_privilege('service_role','public.fn_ops_ledger_group_kpis(text[])','EXECUTE')  as fn_group_service_role_execute
 ),
 verify_fns as (
   select
     -- THE THREE VERIFY FUNCTIONS ARE service_role ONLY: not executable by
     -- authenticated, not by anon, and executable by service_role. They are
     -- SECURITY DEFINER, so a stray grant to authenticated would hand a client
     -- role a read of eight views that are deliberately closed to it.
     (bool_and(not has_function_privilege('authenticated', p.oid, 'EXECUTE'))
      and bool_and(not has_function_privilege('anon', p.oid, 'EXECUTE'))
      and bool_and(has_function_privilege('service_role', p.oid, 'EXECUTE'))
      and count(*) = 3) as verify_fns_service_role_only,
     count(*)::int      as verify_fn_count
   from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname in ('fn_ops_ledger_verify_campaign','fn_ops_ledger_verify_group','fn_ops_ledger_verify_posture')
 ),
 legacy as (
   -- The whole-history probes must be GONE, and must stay gone.
   select count(*)::int as legacy_verify_fn_count
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in ('fn_ops_ledger_verify','fn_ops_ledger_verify_groups')
 ),
 money as (
   select
     (select count(*) from information_schema.columns
       where table_schema='public'
         and table_name in ('view_ops_ledger_campaign_span','view_ops_ledger_shift','view_ops_ledger_day_grade',
                            'view_ops_ledger_day_block','view_ops_ledger_campaign_grades')
         and column_name ~* 'php|peso|cost|price|value|amount')::int as money_named_in_peso_free_views,
     (select count(*) from information_schema.columns
       where table_schema='public' and table_name='view_ops_ledger_day'
         and column_name ~* 'php|peso|cost|price|value|amount')::int as money_named_in_day_view
 ),
 keys as (
   select coalesce(array_agg(sp.campaign_key order by sp.first_date, sp.campaign_key), '{}'::text[]) as campaign_keys
     from public.view_ops_ledger_campaign_span sp
 )
select to_jsonb(posture) || to_jsonb(verify_fns) || to_jsonb(legacy)
       || to_jsonb(money) || to_jsonb(keys)
from posture, verify_fns, legacy, money, keys;
$fn$;

comment on function public.fn_ops_ledger_verify_posture() is
'READ-ONLY posture probe for the ops-ledger data layer: CATALOG ONLY (pg_class / pg_description / has_table_privilege / has_function_privilege / information_schema.columns) plus ONE read of view_ops_ledger_campaign_span (32 rows, 9 ms) whose sole purpose is to hand the verification script the campaign_keys it must then check ONE AT A TIME. It asserts the eight views are security_invoker, commented, authenticated-SELECT, anon-denied and service_role-denied; that fn_ops_ledger_group_kpis is authenticated-only; that all THREE verify functions are service_role-only (verify_fns_service_role_only); that the whole-history probes fn_ops_ledger_verify / fn_ops_ledger_verify_groups no longer exist (legacy_verify_fn_count = 0, after the 2026-09-14 OOM incident); and that the five peso-free views carry no money-named column while view_ops_ledger_day carries exactly one. SECURITY DEFINER, STABLE, service_role EXECUTE only. NO ₱ VALUE.';


-- -----------------------------------------------------------------------------
-- 4. GRANTS — service_role only, never authenticated, never anon
-- -----------------------------------------------------------------------------
revoke execute on function public.fn_ops_ledger_verify_campaign(text)   from public, anon, authenticated;
revoke execute on function public.fn_ops_ledger_verify_group(text[])    from public, anon, authenticated;
revoke execute on function public.fn_ops_ledger_verify_posture()        from public, anon, authenticated;

grant execute on function public.fn_ops_ledger_verify_campaign(text)    to service_role;
grant execute on function public.fn_ops_ledger_verify_group(text[])     to service_role;
grant execute on function public.fn_ops_ledger_verify_posture()         to service_role;
