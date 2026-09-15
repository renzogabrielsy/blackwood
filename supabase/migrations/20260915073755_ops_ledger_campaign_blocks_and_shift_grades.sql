-- =============================================================================
-- OPS LEDGER — THE BLOCKS-USED TABLE PER CAMPAIGN, AND THE PER-SHIFT GRADE SPLIT
-- 2026-09-15 (round 3)
-- =============================================================================
-- Two shapes Renzo asked for on 2026-09-15, both of them a GRAIN that does not
-- exist yet rather than a new number:
--
--   1. THE DAY EXPAND BECOMES CHILD ROWS, ONE PER SHIFT, in the parent row's own
--      columns. A child row therefore needs the two figures the parent prints
--      that the shift view did not publish: its own WASTE % and its own GRADE
--      SPLIT. Both are appended to `view_ops_ledger_shift` — folding either in
--      TSX would put arithmetic back on a render path (CLAUDE.md: never
--      aggregate in TypeScript) and would let a child row disagree with the day
--      row above it.
--
--   2. THE FED PRICE / ACTUAL FED PRICE KPI MODALS BECOME A BLOCKS-USED TABLE
--      PER CAMPAIGN — his workbook's own columns: BATCH · BLOCK LOC · DATE OPEN
--      · DATE CLOSE · STATE · FED WT KG · BLOCK PRICE, and for the actual-price
--      modal also ARRV WT KG · RESIKO KG · RESIKO LOSS · ACTUAL PRICE · RESIKO
--      PRICE. `view_ops_ledger_day_blocks_used` is keyed on the DAY, so the only
--      "fed weight" it carries per campaign is the block's ALL-TIME total; what
--      the modal must say is how much of that block THIS CAMPAIGN drew. That is
--      a (campaign x block) grain, which is exactly the `campaign_block` CTE
--      `view_rc_movement_campaign_actual_price` already aggregates internally
--      and then throws away. `view_ops_ledger_campaign_block` publishes it.
--
-- NOTHING WITH A HOME IS RE-DERIVED. Every block-life figure is SELECTed
-- verbatim from `view_rc_movement_block_actual_price` (the owner of DATE OPEN /
-- DATE CLOSE / arrival weight / all-time fed / shrinkage / the three block ₱/kg
-- figures); every campaign-attributed figure aggregates
-- `view_rc_movement_campaign_cells` — THE relation the day spine's `fed_kg`
-- already folds, so a modal total and the ledger footer cannot disagree; and
-- `in_price_set` is the price-set predicate `view_rc_movement_campaign_actual_price`
-- itself uses (`is_closed AND is_fully_priced`), lifted rather than restated.
--
-- MEASURED BEFORE CREATING, each under `set local statement_timeout = '5s'`:
--   view_ops_ledger_campaign_block, JULY 2026 ............ 19 rows, 12.8 ms, 1,381 buffers
--   fn_ops_ledger_group_blocks(Q3 2026) .................. 46 rows, 13.0 ms, 1,810 buffers
--   view_ops_ledger_shift, JULY 2026 (before this change) . 28 rows,  5.0 ms,   181 buffers
-- JULY 2026 sums to 781,234.00 kg over its 19 blocks — the campaign KPI row's
-- own `fed_kg` and `blocks_fed`, to the kilogram; Q3 2026's 46 distinct blocks
-- are the group RPC's own `blocks_fed_distinct`. Both are now PROVEN every run
-- by four new probe keys rather than quoted here and left to rot.
--
-- ROW BUDGETS (PostgREST caps a read at 1,000 rows): the campaign view is <= ~30
-- rows per campaign (19 for JULY 2026, 523 blocks over ALL history), the group
-- RPC one row per DISTINCT block in the group (46 for Q3 2026). Read the view
-- PER CAMPAIGN, exactly as the other lenses are read.
--
-- CREATE OR REPLACE VIEW KEEPS GRANTS AND RESETS `reloptions`. The shift view is
-- replaced here, so `security_invoker` is re-asserted for it in THIS file, in
-- section 5 — the trap that bit `view_ops_ledger_campaign_kpis` twice.
-- =============================================================================


-- -----------------------------------------------------------------------------
-- 1. view_ops_ledger_shift — APPEND waste_pct + grade_kg
-- -----------------------------------------------------------------------------
-- Two columns appended at the END (CREATE OR REPLACE VIEW may only append), so
-- every existing consumer is byte-identical.
--
--   waste_pct = total_waste_kg / produced_kg — THE SAME DENOMINATOR as the day
--     row and the EOQ cell (Renzo, 2026-09-15: what the plant sweeps up off the
--     screens and trommels came OUT of the retort, so it is a property of the
--     OUTPUT). A FRACTION, x100 at render, and NULL — never 0 — when the shift
--     filed no waste row, filed no run, or produced 0.
--
--   grade_kg = {"<grade>": kg} over the shift's OWN runs, built in the lateral
--     that already reads them. NULL, never {}, when the shift filed no run: an
--     empty object would claim "ran, produced nothing of any grade". A grade
--     with a blank name is excluded rather than keyed on an empty string.
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

  rr.runs,

  -- APPENDED 2026-09-15 (round 3) — the two figures a per-SHIFT child row needs
  -- so the day expand prints the parent's own columns without folding anything
  -- in TSX. Both repeat the CASE expressions above verbatim rather than aliasing
  -- them, because a select-list alias is not referenceable in its own list.
  (case when coalesce(vpd.trml1_kg, vpd.trml2_kg, vpd.rs1a_kg, vpd.rs1b_kg,
                      vpd.rs23_kg, vpd.rs5_kg, vpd.bf_kg, vpd.grit_kg) is null
        then null else vpd.total_waste_kg end)
    / nullif(case when rr.run_count > 0 then vpd.total_output_kg end, 0) as waste_pct,
  rr.grade_kg
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
         ) order by r.grade, r.created_at) as runs,
         -- THE SHIFT'S GRADE SPLIT, built in the lateral that already reads the
         -- runs. Several runs may carry one grade, so they are summed HERE, in
         -- SQL, once — not per render. NULL over zero runs.
         (select jsonb_object_agg(gg.grade, gg.kg)
            from (select r2.grade, sum(r2.ttl_kg) as kg
                    from public.production_runs r2
                   where r2.shift_id = ps.id
                     and coalesce(btrim(r2.grade), '') <> ''
                   group by r2.grade) gg)                     as grade_kg
    from public.production_runs r
   where r.shift_id = ps.id
) rr on true
where coalesce(btrim(ps.production_batch), '') <> '';

comment on view public.view_ops_ledger_shift is
'Ops ledger EXPAND: one row per production shift on the campaign clock, with hours, downtime (incl. the L-051 dt_ranges / L-051b dt_incident_ranges / shift_hrs_source), the eight waste streams and the shift''s runs as a jsonb array so nothing has to be folded in TypeScript. Every figure is SELECTed from view_production_daily, which owns the dt_hrs + dt_mins/60 fold; only the three text columns that view does not carry are read from production_downtime. produced_kg and total_waste_kg are NULL, never 0, when the shift filed no run / no waste row. APPENDED 2026-09-15: waste_pct = total_waste_kg / produced_kg, a FRACTION over PRODUCTION OUTPUT - the SAME denominator as view_ops_ledger_day.waste_pct and the EOQ cell, so a per-shift child row, its day row and the campaign cell are one definition at three grains; and grade_kg, a jsonb {grade: kg} map of the shift''s OWN runs summed in SQL (NULL, never {}, when the shift filed no run - an empty object would claim it ran and produced nothing of any grade). NO ₱ COLUMN and none derivable.';


-- -----------------------------------------------------------------------------
-- 2. view_ops_ledger_campaign_block — THE BLOCKS-USED TABLE, PER CAMPAIGN (NEW)
-- -----------------------------------------------------------------------------
-- One row per (campaign, block) — the table behind the FED PRICE and ACTUAL FED
-- PRICE modals, in Renzo's own workbook order.
--
-- WHY THIS GRAIN EXISTS AND view_ops_ledger_day_blocks_used DOES NOT ANSWER IT:
-- that view is keyed on the DAY, so its only fed figure per campaign is
-- `total_fed_kg`, the block's ALL-TIME MAIN outflow. A block is routinely fed
-- by more than one campaign (measured: 78 of 523 blocks, up to 5 each), so
-- printing its all-time total in a campaign's modal would credit this campaign
-- with kilos another one ate. `campaign_fed_kg` is what THIS campaign drew, and
-- the two ride side by side, both labelled.
--
-- TWO HALVES, NEITHER RE-DERIVED.
--   * The CAMPAIGN half aggregates view_rc_movement_campaign_cells — the same
--     relation view_ops_ledger_day_block publishes cell by cell and the day
--     spine's fed_kg folds, so SUM(campaign_fed_kg) over a campaign IS that
--     campaign's fed_kg by construction (PROVEN: campaign_block_fold_mismatch).
--   * The BLOCK-LIFE half is SELECTed verbatim from
--     view_rc_movement_block_actual_price, which owns DATE OPEN (first_fed_date),
--     DATE CLOSE, state, ARRIVAL WEIGHT, the shrinkage, and the three block ₱/kg
--     figures with all their NULL rules already applied.
--
-- in_price_set IS LIFTED, NOT INVENTED: `is_closed AND is_fully_priced` is
-- precisely the predicate view_rc_movement_campaign_actual_price filters its
-- price set on, so the modal can mark the rows that actually count toward the
-- campaign's ACTUAL FED PRICE and its count will equal that view's
-- blocks_in_price without a second rule existing anywhere.
--
-- RESIKO vs BALANCE, exactly as view_ops_ledger_day_blocks_used splits it: the
-- same subtraction means two different things, so it is published twice under
-- two names and a UI cannot print one as the other.
create or replace view public.view_ops_ledger_campaign_block as
with cb as (
  select (c.production_batch || '-' || c.campaign_year::text) as campaign_key,
         c.production_batch,
         c.campaign_year,
         c.batch_id,
         sum(c.fed_kg)               as campaign_fed_kg,
         sum(c.sundry_kg)            as campaign_sundry_kg,
         count(distinct c.date)::int as campaign_feed_days,
         min(c.date)                 as first_campaign_feed_date,
         max(c.date)                 as last_campaign_feed_date
    from public.view_rc_movement_campaign_cells c
   group by c.production_batch, c.campaign_year, c.batch_id
)
select
  cb.campaign_key,
  cb.production_batch,
  cb.campaign_year,
  cb.batch_id,
  p.batch_code,                        -- BATCH
  p.block_loc,                         -- BLOCK LOC

  -- what THIS campaign drew from this block
  cb.campaign_fed_kg,                  -- FED WT KG
  cb.campaign_sundry_kg,
  cb.campaign_feed_days,
  cb.first_campaign_feed_date,
  cb.last_campaign_feed_date,

  -- the block's own LIFE, campaign-independent, verbatim
  p.first_fed_date,                    -- DATE OPEN
  p.close_date,                        -- DATE CLOSE (NULL while open)
  p.is_closed,
  p.status,                            -- STATE
  p.total_fed_kg,                      -- all-time MAIN kg out of this block
  p.total_out_kg,                      -- all-time kg out incl. sundry pulls
  p.delivered_kg,                      -- ARRV WT KG
  p.weight_lost_kg,                    -- delivered - out. Only LOSS once closed.
  p.loss_pct,
  case when p.is_closed then p.weight_lost_kg end     as resiko_kg,    -- RESIKO KG
  case when p.is_closed then p.loss_pct       end     as resiko_pct,   -- RESIKO LOSS
  case when not p.is_closed then p.weight_lost_kg end as balance_kg,
  p.has_sundry_outflow,
  p.sundry_kg,
  p.has_unpriced_delivery,
  p.unpriced_delivery_count,
  p.is_fully_priced,
  (p.is_closed and p.is_fully_priced)                 as in_price_set,
  p.feed_count,
  p.delivery_count,

  -- ₱ — four columns, every NULL rule already applied by the source view.
  p.delivered_php_kg,                  -- BLOCK PRICE (the DELIVERED rate)
  p.priced_delivered_php_kg,           -- the honest partial when a delivery is unpriced
  p.actual_fed_php_kg,                 -- ACTUAL PRICE (closed + fully priced + no sundry)
  p.uplift_php_kg                      -- RESIKO PRICE (actual - delivered)
from cb
join public.view_rc_movement_block_actual_price p on p.batch_id = cb.batch_id;

comment on view public.view_ops_ledger_campaign_block is
'Ops ledger BLOCKS USED, PER CAMPAIGN - one row per (campaign, block), the table behind the FED PRICE and ACTUAL FED PRICE KPI modals in Renzo''s own workbook order: BATCH (batch_code) / BLOCK LOC / DATE OPEN (first_fed_date) / DATE CLOSE (close_date) / STATE (status) / FED WT KG (campaign_fed_kg) / BLOCK PRICE (delivered_php_kg), plus ARRV WT KG (delivered_kg) / RESIKO KG / RESIKO LOSS (resiko_pct) / ACTUAL PRICE (actual_fed_php_kg) / RESIKO PRICE (uplift_php_kg) for the actual-price modal. campaign_fed_kg IS THE POINT: view_ops_ledger_day_blocks_used is keyed on the DAY and can only offer the block''s ALL-TIME total_fed_kg, and 78 of 523 blocks were fed by more than one campaign (up to 5 each), so an all-time figure in a campaign''s modal credits this campaign with kilos another one ate; both ride side by side, labelled. NOTHING IS RE-DERIVED: the campaign half aggregates view_rc_movement_campaign_cells, the same relation the day spine''s fed_kg folds, so SUM(campaign_fed_kg) equals the campaign KPI row''s fed_kg by construction (JULY 2026: 781,234.00 kg over 19 blocks, proven every run by campaign_block_fold_mismatch / campaign_block_count_mismatch); the block-life half is SELECTed verbatim from view_rc_movement_block_actual_price with every NULL rule it already applies (actual_fed_php_kg is NULL, never 0, unless the block is CLOSED, fully priced and has no sundry outflow; delivered_php_kg is NULL unless fully priced, with priced_delivered_php_kg as the honest partial). in_price_set is that view''s OWN price-set predicate (is_closed AND is_fully_priced) lifted rather than restated, so the rows it marks are exactly the ones view_rc_movement_campaign_actual_price counts in blocks_in_price. RESIKO vs BALANCE: the same subtraction published twice under two names - resiko_kg/resiko_pct (closed: evaporation and resiko, a real loss) and balance_kg (open: charcoal still in the pile) - so a UI cannot print one as the other. loss_pct / resiko_pct are FRACTIONS. ₱ COLUMNS: delivered_php_kg, priced_delivered_php_kg, actual_fed_php_kg, uplift_php_kg - GATE THEM AT THE SERVER ACTION with canViewPrices() and null them before the payload leaves the server; every other column is peso-free and not derivable back into a price. ROW BUDGET: <= ~30 rows per campaign (19 for JULY 2026), 523 over all history - read PER CAMPAIGN, a whole-history read would approach PostgREST''s 1000-row cap.';


-- -----------------------------------------------------------------------------
-- 3. fn_ops_ledger_group_blocks — the same table for a GROUP of campaigns (NEW)
-- -----------------------------------------------------------------------------
-- ONE ROW PER DISTINCT BLOCK. A block fed by two of the group's campaigns is
-- ONE row carrying campaign_count = 2 and both keys — the same de-duplication
-- fn_ops_ledger_group_kpis.blocks_fed_distinct counts, so the modal's row count
-- IS that number (PROVEN: gap_group_blocks_distinct).
--
-- WHY A FUNCTION AND NOT A VIEW: the group is a CHOSEN set of campaign keys, not
-- a stored dimension — the same reason fn_ops_ledger_group_kpis is a function.
--
-- group_feed_days COUNTS DISTINCT DATES, it does not sum campaign_feed_days: a
-- changeover date belongs to TWO campaigns, so summing would count that day
-- twice for a block fed on it by both.
--
-- NOTE WHAT IS *NOT* PUBLISHED HERE, and it is the same refusal
-- fn_ops_ledger_group_kpis makes: there is no group-level ACTUAL PRICE or RESIKO
-- weighting on a row. Each row still carries the BLOCK's own all-time ₱/kg
-- figures, which are campaign-independent facts about that pile and are
-- therefore correct at any grain; what a group may not do is add a shared
-- block's whole-life shrinkage once per campaign that touched it.
create or replace function public.fn_ops_ledger_group_blocks(p_campaign_keys text[])
returns table (
  batch_id                 uuid,
  batch_code               text,
  block_loc                text,
  campaign_count           int,
  campaign_keys            text[],
  group_fed_kg             numeric,
  group_sundry_kg          numeric,
  group_feed_days          int,
  first_group_feed_date    date,
  last_group_feed_date     date,
  first_fed_date           date,
  close_date               date,
  is_closed                boolean,
  status                   batch_status,
  total_fed_kg             numeric,
  total_out_kg             numeric,
  delivered_kg             numeric,
  weight_lost_kg           numeric,
  loss_pct                 numeric,
  resiko_kg                numeric,
  resiko_pct               numeric,
  balance_kg               numeric,
  has_sundry_outflow       boolean,
  sundry_kg                numeric,
  has_unpriced_delivery    boolean,
  unpriced_delivery_count  int,
  is_fully_priced          boolean,
  in_price_set             boolean,
  feed_count               int,
  delivery_count           int,
  delivered_php_kg         numeric,
  priced_delivered_php_kg  numeric,
  actual_fed_php_kg        numeric,
  uplift_php_kg            numeric
)
language sql
stable
security invoker
set search_path = public
as $$
with wanted as (
  select distinct btrim(k) as campaign_key
    from unnest(coalesce(p_campaign_keys, '{}'::text[])) as k
   where coalesce(btrim(k), '') <> ''
),
cells as (
  -- Filtered on the COMPUTED key, which the planner does push down into rc_out
  -- (measured: Q3 2026 reads 238 of 2,236 rc_out rows, 13.0 ms / 1,810 buffers).
  select (c.production_batch || '-' || c.campaign_year::text) as campaign_key,
         c.batch_id, c.date, c.fed_kg, c.sundry_kg
    from public.view_rc_movement_campaign_cells c
   where (c.production_batch || '-' || c.campaign_year::text)
         in (select campaign_key from wanted)
),
gb as (
  select x.batch_id,
         count(distinct x.campaign_key)::int                      as campaign_count,
         array_agg(distinct x.campaign_key)                       as campaign_keys,
         sum(x.fed_kg)                                            as group_fed_kg,
         sum(x.sundry_kg)                                         as group_sundry_kg,
         count(distinct x.date)::int                              as group_feed_days,
         min(x.date)                                              as first_group_feed_date,
         max(x.date)                                              as last_group_feed_date
    from cells x
   group by x.batch_id
)
select
  gb.batch_id,
  p.batch_code,
  p.block_loc,
  gb.campaign_count,
  gb.campaign_keys,
  gb.group_fed_kg,
  gb.group_sundry_kg,
  gb.group_feed_days,
  gb.first_group_feed_date,
  gb.last_group_feed_date,
  p.first_fed_date,
  p.close_date,
  p.is_closed,
  p.status,
  p.total_fed_kg,
  p.total_out_kg,
  p.delivered_kg,
  p.weight_lost_kg,
  p.loss_pct,
  case when p.is_closed then p.weight_lost_kg end     as resiko_kg,
  case when p.is_closed then p.loss_pct       end     as resiko_pct,
  case when not p.is_closed then p.weight_lost_kg end as balance_kg,
  p.has_sundry_outflow,
  p.sundry_kg,
  p.has_unpriced_delivery,
  p.unpriced_delivery_count,
  p.is_fully_priced,
  (p.is_closed and p.is_fully_priced)                 as in_price_set,
  p.feed_count,
  p.delivery_count,
  p.delivered_php_kg,
  p.priced_delivered_php_kg,
  p.actual_fed_php_kg,
  p.uplift_php_kg
from gb
join public.view_rc_movement_block_actual_price p on p.batch_id = gb.batch_id
order by gb.first_group_feed_date, p.batch_code;
$$;

comment on function public.fn_ops_ledger_group_blocks(text[]) is
'THE BLOCKS-USED TABLE FOR A GROUP of campaigns (Q3 2026 = JULY-2026 + AUGUST-2026 + SEPTEMBER-2026) - the same columns view_ops_ledger_campaign_block publishes, with the campaign identity replaced by campaign_count / campaign_keys and the fed figures summed across the group. ONE ROW PER DISTINCT BLOCK: a block fed by two of the group''s campaigns is ONE row carrying campaign_count = 2 and both keys, the same de-duplication fn_ops_ledger_group_kpis.blocks_fed_distinct counts, so the table''s row count IS that number (Q3 2026: 46 rows, proven every run by gap_group_blocks_distinct) and SUM(group_fed_kg) IS the group''s fed_kg (gap_group_blocks_fed_kg). group_feed_days COUNTS DISTINCT DATES rather than summing the per-campaign day counts, because a changeover date belongs to two campaigns and would otherwise be counted twice for a block fed on it by both. It is a FUNCTION and not a view for the same reason fn_ops_ledger_group_kpis is: a group is a chosen set of keys, not a stored dimension. WHAT IT DELIBERATELY DOES NOT DO is weight or sum anything across a shared block - each row carries that BLOCK''s own campaign-independent all-time ₱/kg and shrinkage, which are correct at any grain, while adding a shared block''s whole-life resiko once per campaign that touched it is exactly the mistake the group KPI row refuses. SECURITY INVOKER, search_path pinned, EXECUTE revoked from PUBLIC + anon, granted to authenticated. ₱ COLUMNS: delivered_php_kg, priced_delivered_php_kg, actual_fed_php_kg, uplift_php_kg - GATE THEM AT THE SERVER ACTION with canViewPrices().';


-- -----------------------------------------------------------------------------
-- 4. THE PROBES — campaign_block_fold_mismatch / campaign_block_count_mismatch,
--    gap_group_blocks_fed_kg / gap_group_blocks_distinct, and the ₱ surface of
--    the new view named rather than counted.
-- -----------------------------------------------------------------------------
-- Signatures unchanged, so CREATE OR REPLACE keeps the service_role-only grants
-- (re-stated in section 5 all the same). Every new key is a COUNT or a GAP that
-- must be 0 — no probe ever returns a ₱ VALUE.
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
        where coalesce(k.blocks_fed, 0) is distinct from t.c)::int  as campaign_block_count_mismatch
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
'READ-ONLY verification probe for ONE ops-ledger campaign — the instrument behind scripts/verify-ops-ledger.ts, which calls it once per campaign, strictly sequentially. It replaces fn_ops_ledger_verify(), a single whole-history probe that hung the instance (OOM) on 2026-09-14 and took the live site down. EVERY subquery is filtered on production_batch + campaign_year (never on the computed campaign_key, which cannot be pushed down), which is what keeps a full run in the tens of milliseconds. It proves the four day-level FOLDS (grades, blocks fed, shift produced, shift downtime) against the day spine, the WASTE fold in both forms (waste_fold_mismatch = the campaign total vs the day spine''s, 0/1; waste_stream_fold_mismatch = how many of the EIGHT streams differ, 0..8 — because a total can agree while two streams are swapped), the day totals against the campaign KPI row, the grade fold against the campaign grade set, ledger_days against span_days, both REUSE comparisons (view_analytics_batch_cost and view_analytics_production_by_batch, column for column) and the ONE-campaign GROUP identity against fn_ops_ledger_group_kpis, waste columns included. SECURITY DEFINER (the views are authenticated-only, so no key a script can hold may read them), STABLE, service_role EXECUTE only. IT RETURNS NO ₱ VALUE: every money-derived key is a GAP that must be 0, a count, or a boolean. It also proves the DAY-LEVEL RATIOS added 2026-09-15 (day_ratio_mismatch: each of waste_pct, yield_pct and loss_pct must equal the division of the row''s OWN published inputs, which fails both on a ratio present where an input is missing and on a NULL published over two real numbers, and pins loss_pct to 1 - the published yield_pct) and the campaign cell''s new denominator (kpi_waste_pct_mismatch, 0/1: waste_loss_pct must equal waste_kg / produced_kg - this is what catches the denominator silently reverting to fed kg). It also proves the CAMPAIGN x BLOCK table added 2026-09-15 (campaign_block_fold_mismatch: SUM(view_ops_ledger_campaign_block.campaign_fed_kg) must equal the campaign KPI row''s fed_kg, which is what keeps the FED PRICE / ACTUAL FED PRICE modal from crediting a campaign with kilos another campaign ate out of a shared block; campaign_block_count_mismatch: its row count must equal blocks_fed). Zero on every *_mismatch key is the passing state. RAISES on a key that is not <BATCH>-<YYYY> or that does not resolve to exactly one campaign span row.';

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
  -- THE GROUP BLOCKS TABLE, added 2026-09-15 (round 3): one row per DISTINCT
  -- block, the same de-duplication blocks_fed_distinct counts.
  gblk as materialized (
    select count(*)::int as block_rows, sum(b.group_fed_kg) as fed_kg
      from public.fn_ops_ledger_group_blocks(v_keys) b
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
      -- THE GROUP BLOCKS TABLE, added 2026-09-15 (round 3). Both must be
      -- exactly 0: the table's kilos are the group's fed kilos re-aggregated
      -- from the same cells, and its ROW COUNT is blocks_fed_distinct, so a
      -- non-zero either way means the modal lists a different set of blocks
      -- than the KPI strip above it counts.
      coalesce(gblk.fed_kg - g.fed_kg, 0)                               as gap_group_blocks_fed_kg,
      (gblk.block_rows - g.blocks_fed_distinct)                         as gap_group_blocks_distinct,
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
    from g, dsum, gblk
  )
  select to_jsonb(o) into v_out from o;

  return v_out;
end;
$fn$;

comment on function public.fn_ops_ledger_verify_group(text[]) is
'READ-ONLY: proves fn_ops_ledger_group_kpis over a CHOSEN set of campaigns (Q3 2026 = JULY-2026 + AUGUST-2026 + SEPTEMBER-2026) against a direct sum of those campaigns'' own view_ops_ledger_campaign_kpis rows — gap_yield / gap_fed_rate / gap_pc_rate / gap_fed_kg / gap_produced_kg / gap_waste_kg / gap_waste_pct must all be exactly 0 (gap_waste_pct, added 2026-09-15, recomputes the group''s waste_loss_pct as Sum(waste_kg) / Sum(produced_kg) over the members that filed waste) — proves the GROUP BLOCKS TABLE added 2026-09-15 (gap_group_blocks_fed_kg: SUM(fn_ops_ledger_group_blocks.group_fed_kg) must equal the group''s fed_kg; gap_group_blocks_distinct: its row count must equal blocks_fed_distinct, because a block fed by two of the group''s campaigns is ONE row), and reports the de-duplicated vs naive block counts, the coverage counts (blocks, campaigns fully covered, campaigns_waste_reported, waste_shift_count), the ledger/active/rest day split and the changeover surplus. gap_waste_kg is exact BY CONSTRUCTION and that is the point: waste is filed per shift and a shift belongs to one campaign, so unlike block resiko it partitions cleanly and a non-zero gap would mean the group stopped summing the campaign view. IT RAISES ABOVE 12 KEYS, deliberately: after the 2026-09-14 incident a verification read must be structurally incapable of walking all 32 campaigns in one statement. An unknown key is REPORTED in campaigns_missing_count, never silently dropped. SECURITY DEFINER, STABLE, service_role EXECUTE only; returns NO ₱ VALUE — only zero-gaps, counts and booleans.';

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
         and column_name ~* 'php|peso|cost|price|value|amount')::int as money_named_in_day_view,
     -- THE CAMPAIGN x BLOCK view (2026-09-15) CARRIES MONEY on purpose, so the
     -- honest assertion is not a count of zero but the EXACT SET of columns the
     -- money-ish regex matches. Four of the five really are pesos and are named
     -- in the view's COMMENT (delivered_php_kg, priced_delivered_php_kg,
     -- actual_fed_php_kg, uplift_php_kg); in_price_set is a boolean coverage
     -- FLAG the regex catches on the word "price". Publishing the names rather
     -- than a number is what makes a FIFTH peso column appearing a failure
     -- instead of an off-by-one nobody reads.
     (select coalesce(array_agg(column_name order by column_name), '{}'::text[])
        from information_schema.columns
       where table_schema='public' and table_name='view_ops_ledger_campaign_block'
         and column_name ~* 'php|peso|cost|price|value|amount') as campaign_block_money_named_columns
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
'READ-ONLY posture probe for the ops-ledger data layer: CATALOG ONLY (pg_class / pg_description / has_table_privilege / has_function_privilege / information_schema.columns) plus ONE read of view_ops_ledger_campaign_span (32 rows, 9 ms) whose sole purpose is to hand the verification script the campaign_keys it must then check ONE AT A TIME. It asserts the NINE views (view_ops_ledger_campaign_block joined them on 2026-09-15) are security_invoker, commented, authenticated-SELECT, anon-denied and service_role-denied; that fn_ops_ledger_group_kpis is authenticated-only; that all THREE verify functions are service_role-only (verify_fns_service_role_only); that the whole-history probes fn_ops_ledger_verify / fn_ops_ledger_verify_groups no longer exist (legacy_verify_fn_count = 0, after the 2026-09-14 OOM incident); and that the five peso-free views carry no money-named column while view_ops_ledger_day carries exactly one. Since 2026-09-15 it also publishes campaign_block_money_named_columns, the EXACT SET of money-ish column names on view_ops_ledger_campaign_block - that view carries ₱ on purpose, so a count of zero is not the assertion; four of the five are real pesos named in its own COMMENT and in_price_set is a boolean coverage flag the regex catches on the word price, and listing the names is what makes a FIFTH peso column appearing a failure rather than an off-by-one nobody reads. SECURITY DEFINER, STABLE, service_role EXECUTE only. NO ₱ VALUE.';



-- -----------------------------------------------------------------------------
-- 5. POSTURE — re-ALTER what a REPLACE reset, and the full posture for what is new
-- -----------------------------------------------------------------------------
-- CREATE OR REPLACE VIEW KEEPS THE GRANTS AND RESETS `reloptions`. The shift
-- view is replaced above, so security_invoker goes back on it HERE, in the same
-- file — never in a follow-up, which is how it was missed twice on
-- view_ops_ledger_campaign_kpis. The new view gets the same posture from birth.
alter view public.view_ops_ledger_shift          set (security_invoker = true);
alter view public.view_ops_ledger_campaign_block set (security_invoker = true);

-- The grants a REPLACE kept, restated so the file says what the posture is.
revoke all on public.view_ops_ledger_shift            from public, anon;
grant select on public.view_ops_ledger_shift          to authenticated;

-- NO service_role ON EITHER: the sync worker reads none of these, and
-- verify-worker-view-grants must stay at 4 views / 0 findings (L-044 — a
-- consumer is not a dependency).
revoke all on public.view_ops_ledger_campaign_block   from public, anon;
grant select on public.view_ops_ledger_campaign_block to authenticated;

revoke execute on function public.fn_ops_ledger_group_blocks(text[]) from public, anon;
grant  execute on function public.fn_ops_ledger_group_blocks(text[]) to authenticated;

-- Restated, not assumed: the probes are SECURITY DEFINER over authenticated-only
-- views, so they may never be reachable by authenticated or anon. All three are
-- CREATE OR REPLACEd above, which keeps grants — these lines make the file say so.
revoke execute on function public.fn_ops_ledger_verify_campaign(text)   from public, anon, authenticated;
grant execute on function public.fn_ops_ledger_verify_campaign(text)   to service_role;
revoke execute on function public.fn_ops_ledger_verify_group(text[])   from public, anon, authenticated;
grant execute on function public.fn_ops_ledger_verify_group(text[])   to service_role;
revoke execute on function public.fn_ops_ledger_verify_posture()       from public, anon, authenticated;
grant execute on function public.fn_ops_ledger_verify_posture()        to service_role;
