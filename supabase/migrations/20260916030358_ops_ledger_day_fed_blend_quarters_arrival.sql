-- =============================================================================
-- OPS LEDGER — THE DAY'S FED BLEND, THE QUARTER BY DATE, AND THE ARRIVAL TOTAL
-- 2026-09-16 (round 5)
-- =============================================================================
-- Three asks from Renzo on 2026-09-16, each of them a COLUMN that does not
-- exist rather than a new number anybody has to trust:
--
--   1. CLICKING A DAY'S FED CELL MUST OPEN THE BLOCKS FED THAT DAY *WITH THE
--      PROJECTED LAB PROFILE OF WHAT WAS FED* — "the projected MC, BD, Ash etc.
--      of the final product, since these are heavily based on what was fed. Not
--      to be taken as truth but a good figure to have." So every block row gains
--      its own seven-stat panel, and a new day-grain view publishes the
--      FED-KG-WEIGHTED mean of each stat over the blocks fed that day.
--
--   2. THE QUARTER PRESETS MUST BE DECIDED BY DATE, NEVER BY THE BATCH NAME. A
--      campaign belongs to the quarter containing the MIDPOINT of its span, so
--      JULY 2026 (2026-06-30 -> 2026-08-01) is Q3 2026, SEPTEMBER 2026 (opens
--      2026-08-29) is Q3 2026, and a campaign called TEST BATCH fed only at the
--      end of September would be Q3 2026 as well. An incomplete quarter is still
--      a quarter.
--
--   3. THE ACTUAL FED PRICE MODAL'S FOOTER NEEDS THE CAMPAIGN'S TOTAL ARRIVAL
--      WEIGHT over the blocks it drew from, which nothing publishes today.
--
-- NOTHING WITH A HOME IS RE-DERIVED, and the one place this migration had to
-- make a choice is written out below because the obvious source is wrong.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- WHY THE LAB PROFILE IS NOT `batches.quality_stats`, MEASURED
-- ─────────────────────────────────────────────────────────────────────────────
-- The ask named `quality_stats` and named "the same numbers the Blocking page
-- shows", and those two are not the same thing. Measured on the live database:
--
--   * `batches.quality_stats` carries exactly THREE keys — mc, ash, bd — across
--     all 725 batches, and `bd` is **0.0 on 724 of the 725**. It cannot answer a
--     seven-stat question at all, and five of the seven stats do not exist in it.
--   * The Blocking page's lab columns come from `view_blocking_grid`, whose
--     avg_mc / avg_ash / avg_bd_astm / avg_bd_jis / avg_grit / avg_vm / avg_fc
--     are DELIVERY-WEIGHTED means over `deliveries.lab_results`. That is the
--     arithmetic reproduced here, expression for expression.
--   * `view_blocking_grid` ITSELF cannot be the source: it shows only OPEN
--     blocks with a location_ref, and **522 of the 525 blocks a campaign has
--     ever fed have no row in it** (they are closed). Reading the grid would
--     leave 605 of 608 campaign-block rows blank.
--
-- PROVEN: the expression below, COALESCEd to 0 the way the grid does, is
-- byte-identical to `view_blocking_grid` on ALL 168 of its rows and on all seven
-- stats — 0 mismatches, `IS DISTINCT FROM` — so this is the Blocking page's own
-- number, not a second definition of it.
--
-- THE ONE DELIBERATE DIVERGENCE: NULL, NEVER 0. The grid COALESCEs a missing
-- stat to 0 because a block on the yard grid always has deliveries. Here, **53
-- of the 525 fed blocks carry no lab reading at all** (the pre-system /
-- no-delivery population `view_analytics_cost_monthly.fed_price_coverage_pct`
-- already names), and publishing 0.0 % moisture for them would be the L-008
-- placeholder mistake in a new costume — a projection is exactly the surface on
-- which a fabricated zero does damage. On the grid's own population the
-- divergence costs nothing: not one of its 168 rows has a NULL stat, so the
-- COALESCE is a measured no-op there.
--
-- Also measured: the seven stats have IDENTICAL coverage (472 of 525 blocks) —
-- a delivery carries the whole lab panel or none of it.
--
-- ₱: NOT ONE COLUMN ADDED BY THIS MIGRATION CARRIES MONEY, on any of the four
-- views. The lab profile, the blend and the three arrival/resiko totals are all
-- peso-free and none is derivable back into a price, so the new day sidebar is
-- safe for Production with no gate. The ₱ posture of the views themselves is
-- unchanged.
--
-- CREATE OR REPLACE VIEW KEEPS THE GRANTS AND RESETS `reloptions`. Three views
-- are replaced here, so all three get `security_invoker` re-asserted IN THIS
-- FILE (§5) — the trap that was hit twice on view_ops_ledger_campaign_kpis.
-- =============================================================================


-- -----------------------------------------------------------------------------
-- 1. view_ops_ledger_campaign_span — THE QUARTER, DECIDED BY DATE
-- -----------------------------------------------------------------------------
-- APPEND ONLY: every existing column keeps its name, position and type.
--
-- THE RULE: a campaign belongs to the quarter containing the MIDPOINT of its
-- span, `first_date + (last_date - first_date)/2`. Not its name, not its
-- first_date, not its last_date.
--
--   * Not the NAME, because a name is typed by a person — the L-039 / L-042 /
--     L-048 lesson, one level up. `TEST BATCH` is a legal production_batch and
--     has no month in it; a name-driven preset cannot place it at all, and a
--     name-driven preset is exactly what this replaces.
--   * Not first_date or last_date, because a campaign straddles the boundary at
--     BOTH ends: JULY 2026 opens 2026-06-30 (Q2 by first_date) and closes
--     2026-08-01 (Q3 by last_date), and SEPTEMBER 2026 opens 2026-08-29. The
--     midpoint is the only one of the three that answers both the same way.
--
-- MEASURED on all 32 campaigns today: every midpoint quarter agrees with the
-- quarter the campaign's own month-name implies — including the three that
-- straddle (JULY 2026 midpoint 2026-07-16, AUGUST 2026 2026-08-15, SEPTEMBER
-- 2026 2026-09-06, all 2026-Q3) and OCTOBER 2024, which opens 2024-09-30 and
-- still reads 2024-Q4. So the change is invisible on today's data and correct on
-- data that does not exist yet, which is the point.
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
),
base as (
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
        and sh.campaign_year    = c.campaign_year
)
select
  b.production_batch,
  b.campaign_year,
  b.campaign_key,
  b.campaign_label,
  b.first_fed_date,
  b.last_fed_date,
  b.first_shift_date,
  b.last_shift_date,
  b.first_date,
  b.last_date,
  b.span_days,
  b.feed_days,
  b.shift_count,

  -- APPENDED 2026-09-16 — THE QUARTER, BY DATE.
  -- Integer date arithmetic: (last - first) is a whole number of days, so the
  -- midpoint of a span of even length rounds DOWN to the earlier of the two
  -- middle days. On a one-day campaign it is that day.
  (b.first_date + ((b.last_date - b.first_date) / 2))                             as midpoint_date,
  extract(year    from (b.first_date + ((b.last_date - b.first_date) / 2)))::int  as quarter_year,
  extract(quarter from (b.first_date + ((b.last_date - b.first_date) / 2)))::int  as quarter_no,
  (extract(year from (b.first_date + ((b.last_date - b.first_date) / 2)))::int::text
     || '-Q'
     || extract(quarter from (b.first_date + ((b.last_date - b.first_date) / 2)))::int::text)
                                                                                  as quarter_key,
  ('Q' || extract(quarter from (b.first_date + ((b.last_date - b.first_date) / 2)))::int::text
     || ' '
     || extract(year from (b.first_date + ((b.last_date - b.first_date) / 2)))::int::text)
                                                                                  as quarter_label
from base b;

comment on view public.view_ops_ledger_campaign_span is
'Ops ledger: one row per production campaign with the FULL calendar span the ledger must draw — first_date = the earlier of its first MAIN feed and its first production shift, last_date = the later of its last. Measured reason: JULY 2026 fed to 2026-07-29 but produced through 2026-08-01, and SEPTEMBER 2026 opened a shift on 2026-08-29 before its first feed on 2026-09-01, so a feeding-only span loses real operating days at both ends. campaign_key is the URL-safe "JULY-2026" key /inventory/rc-movement already uses; campaign_label is "JULY 2026", the analytics spelling. THE QUARTER IS DECIDED BY DATE, NEVER BY THE BATCH NAME (2026-09-16): a campaign belongs to the quarter containing the MIDPOINT of its span, midpoint_date = first_date + (last_date - first_date)/2, published as quarter_year / quarter_no (1-4) / quarter_key ("2026-Q3") / quarter_label ("Q3 2026"). Not the name, because a name is typed by a person and TEST BATCH is a legal production_batch with no month in it; not first_date or last_date, because a campaign straddles the boundary at BOTH ends — JULY 2026 opens 2026-06-30 (Q2 by its first day) and closes 2026-08-01 (Q3 by its last), and SEPTEMBER 2026 opens 2026-08-29. MEASURED on all 32 campaigns: every midpoint quarter agrees with the quarter the campaign name implies, JULY 2026 (midpoint 2026-07-16), AUGUST 2026 (2026-08-15) and SEPTEMBER 2026 (2026-09-06) all reading 2026-Q3 and OCTOBER 2024 — which opens 2024-09-30 — reading 2024-Q4, so the rule is invisible on today''s data and correct on data that does not exist yet. AN INCOMPLETE QUARTER IS STILL A QUARTER: a preset built on quarter_key offers Q1 2026 whether it holds three campaigns or one. NO ₱ COLUMN. Inherited property: campaign_year is EXTRACT(year FROM the row date), so a campaign straddling New Year would split into two keys — measured 0 occurrences today.';


-- -----------------------------------------------------------------------------
-- 2. view_ops_ledger_day_block — THE BLOCK'S LAB PROFILE
-- -----------------------------------------------------------------------------
-- APPEND ONLY: campaign_key … sundry_kg keep their names, positions and types;
-- the seven stats are added after them.
--
-- THE `lab` CTE IS view_blocking_grid's OWN ARITHMETIC, expression for
-- expression: a DELIVERY-WEIGHTED mean per stat, weighted by weight_kg over only
-- the deliveries that actually carry that stat. Two differences from the grid,
-- both stated in the file header and both measured:
--   * it is keyed on batch_code over `deliveries` alone rather than on a batch
--     row, so it covers the 522 of 525 fed blocks that are CLOSED and therefore
--     absent from the grid entirely;
--   * a stat no delivery carries is NULL, not 0.
-- PROVEN byte-identical to the grid (COALESCEd) on all 168 grid rows, all seven
-- stats, 0 mismatches.
--
-- THE CAST IS SAFE ON JUNK: `lab_results ->> 'mc'` is text, and a value that is
-- not a number would raise on ::numeric. The guard is a regex, not a hope — a
-- key present but non-numeric contributes nothing to the numerator AND nothing
-- to the weight, exactly as an absent key does. Measured over all 1,756
-- deliveries today: 0 non-numeric lab values, so the guard costs nothing and
-- exists so a bad sync write cannot take the whole view down.
--
-- COST: 16.2 ms / 407 shared buffers for JULY 2026 (94 rows) under a 5 s guard,
-- against 36 ms for the view it replaces. The lab CTE is ONE sequential scan of
-- `deliveries` (76 buffers, 1,756 rows -> 656 batch codes); there is no index on
-- deliveries.batch_code, which is why it is a grouped CTE and not a lateral.
--
-- NO SUPPLIER SUMMARY. `view_blocking_block_suppliers` is derived from
-- view_blocking_grid, so it has the identical 522-of-525 hole; a supplier column
-- fed from it would be blank on every closed block, which is worse than absent.
create or replace view public.view_ops_ledger_day_block as
with lab as (
  select
    d.batch_code,
    sum(nullif(d.lab_results ->> 'mc', '')::numeric * d.weight_kg)
      filter (where d.lab_results ->> 'mc' ~ '^-?[0-9]+(\.[0-9]+)?$')
      / nullif(sum(d.weight_kg) filter (where d.lab_results ->> 'mc' ~ '^-?[0-9]+(\.[0-9]+)?$'), 0)      as mc,
    sum(nullif(d.lab_results ->> 'ash', '')::numeric * d.weight_kg)
      filter (where d.lab_results ->> 'ash' ~ '^-?[0-9]+(\.[0-9]+)?$')
      / nullif(sum(d.weight_kg) filter (where d.lab_results ->> 'ash' ~ '^-?[0-9]+(\.[0-9]+)?$'), 0)     as ash,
    sum(nullif(d.lab_results ->> 'bd_astm', '')::numeric * d.weight_kg)
      filter (where d.lab_results ->> 'bd_astm' ~ '^-?[0-9]+(\.[0-9]+)?$')
      / nullif(sum(d.weight_kg) filter (where d.lab_results ->> 'bd_astm' ~ '^-?[0-9]+(\.[0-9]+)?$'), 0) as bd_astm,
    sum(nullif(d.lab_results ->> 'bd_jis', '')::numeric * d.weight_kg)
      filter (where d.lab_results ->> 'bd_jis' ~ '^-?[0-9]+(\.[0-9]+)?$')
      / nullif(sum(d.weight_kg) filter (where d.lab_results ->> 'bd_jis' ~ '^-?[0-9]+(\.[0-9]+)?$'), 0)  as bd_jis,
    sum(nullif(d.lab_results ->> 'grit', '')::numeric * d.weight_kg)
      filter (where d.lab_results ->> 'grit' ~ '^-?[0-9]+(\.[0-9]+)?$')
      / nullif(sum(d.weight_kg) filter (where d.lab_results ->> 'grit' ~ '^-?[0-9]+(\.[0-9]+)?$'), 0)    as grit,
    sum(nullif(d.lab_results ->> 'vm', '')::numeric * d.weight_kg)
      filter (where d.lab_results ->> 'vm' ~ '^-?[0-9]+(\.[0-9]+)?$')
      / nullif(sum(d.weight_kg) filter (where d.lab_results ->> 'vm' ~ '^-?[0-9]+(\.[0-9]+)?$'), 0)      as vm,
    sum(nullif(d.lab_results ->> 'fc', '')::numeric * d.weight_kg)
      filter (where d.lab_results ->> 'fc' ~ '^-?[0-9]+(\.[0-9]+)?$')
      / nullif(sum(d.weight_kg) filter (where d.lab_results ->> 'fc' ~ '^-?[0-9]+(\.[0-9]+)?$'), 0)      as fc
  from public.deliveries d
  group by d.batch_code
)
select
  (c.production_batch || '-' || c.campaign_year::text) as campaign_key,
  c.production_batch,
  c.campaign_year,
  c.date       as calendar_date,
  c.batch_id,
  c.batch_code,
  c.block_loc,
  c.fed_kg,
  c.sundry_kg,

  -- APPENDED 2026-09-16 — THE BLOCK'S LAB PROFILE, the Blocking page's numbers.
  -- NULL, never 0, when no delivery into the block carries that stat.
  l.mc,
  l.ash,
  l.bd_astm,
  l.bd_jis,
  l.grit,
  l.vm,
  l.fc
from public.view_rc_movement_campaign_cells c
left join lab l on l.batch_code = c.batch_code;

comment on view public.view_ops_ledger_day_block is
'Ops ledger BLOCKS FED lens - THE UNIFICATION WITH /inventory/rc-movement: this is view_rc_movement_campaign_cells re-keyed on campaign_key, i.e. literally the cells of the RC Movement matrix (day x block, kg fed). One column per block in the UI. SUM(fed_kg) per day equals view_ops_ledger_day.fed_kg by construction and is PROVEN so. THE BLOCK''S LAB PROFILE (appended 2026-09-16): mc, ash, bd_astm, bd_jis, grit, vm, fc are the block''s DELIVERY-WEIGHTED lab averages - the same seven numbers the Blocking page shows, view_blocking_grid''s own expressions reproduced term for term and PROVEN byte-identical to it on all 168 of its rows, 0 mismatches on all seven stats. They are NOT batches.quality_stats: measured, that column carries only three keys (mc, ash, bd) across all 725 batches and bd is 0.0 on 724 of them, so it cannot answer a seven-stat question. They are not read FROM view_blocking_grid either, because the grid shows only OPEN blocks with a location_ref and 522 of the 525 blocks a campaign has ever fed are CLOSED and absent from it. NULL IS NEVER 0 - the grid COALESCEs a missing stat to 0 (a measured no-op on its own population, where every batch has deliveries), and here 53 of the 525 fed blocks carry no lab reading at all, for which a published 0.0 would be the L-008 placeholder mistake in a new costume. All seven have identical coverage: a delivery carries the whole panel or none of it. NO ₱ COLUMN. ROW BUDGET: <= 114 rows per campaign (measured max, MARCH 2026), 2,148 over all history - fetch PER CAMPAIGN, a whole-history read would hit PostgREST''s 1000-row cap.';


-- -----------------------------------------------------------------------------
-- 3. view_ops_ledger_day_fed_blend — THE DAY'S PROJECTED BLEND  (NEW)
-- -----------------------------------------------------------------------------
-- ONE ROW PER (campaign, calendar day) THAT FED ANYTHING: the fed-kg-weighted
-- mean of each of the seven lab stats over the blocks the campaign drew from
-- that day. This is what the FED-cell sidebar prints above the block list.
--
-- IT IS A PROJECTION, AND THE COMMENT SAYS SO. These are the lab averages of the
-- RAW CHARCOAL that went IN, carried forward as an indication of what should
-- come OUT. No lab ever measured the product this describes. Renzo, 2026-09-16:
-- "Not to be taken as truth but a good figure to have." It is the same posture
-- as view_ops_ledger_day.yield_pct — an indicative day figure standing beside
-- the real campaign one — and it must be labelled that way wherever it is shown.
--
-- IT SELECTS FROM view_ops_ledger_day_block, THE VIEW IT MUST AGREE WITH. That
-- is the P3 trick (view_analytics_supplier_monthly joining its own denominator):
-- the block rows the sidebar lists and the blended head above them come from the
-- SAME relation, so a block can never appear in one and not the other and the
-- weights can never be taken from a different population than the stats.
--
-- THE WEIGHT IS FED KG, NOT BALANCE. `fn_blend_proposal` weights by
-- view_blocking_grid.balance, because it answers "what would this PILE blend to
-- if we fed it"; this answers "what did we ACTUALLY feed today", so the weight
-- is the kilos that actually left each block on that date. The two are different
-- questions on different populations (fn_blend_proposal cannot even see a closed
-- block), so it is deliberately NOT called here — but the SHAPE is the same
-- SUM(stat * weight) / SUM(weight), and the columns carry its w_ prefix so a
-- reader recognises the statistic.
--
-- EACH STAT IS WEIGHTED OVER ONLY THE BLOCKS THAT CARRY IT, and the fed kg that
-- did carry it rides beside it as <stat>_kg. A day that fed 47,000 kg of which
-- 41,200 kg came from blocks with an MC reading publishes w_mc over 41,200 and
-- mc_kg = 41,200, so the UI can say "projected from 41,200 of 47,000 kg" instead
-- of implying the whole day was measured. NULL, never 0, when no fed block that
-- day carries the stat.
--
-- ⚠ NAME COLLISION, STATED: `grit_kg` HERE IS COVERAGE — the fed kilos carrying
-- a grit READING — and has nothing to do with `view_ops_ledger_day.grit_kg` /
-- `view_ops_ledger_campaign_kpis.grit_kg`, which are the GRITS WASTE STREAM in
-- kilograms. The two views are never joined, and the seven coverage columns are
-- named for their stat by design so `w_mc` / `mc_kg` read as a pair.
--
-- `fed_kg > 0` is carried explicitly although it is a MEASURED NO-OP:
-- view_rc_movement_campaign_cells already HAVINGs on it, so every row of
-- view_ops_ledger_day_block has fed something. Keeping the predicate means this
-- view's own grain does not depend on a HAVING three views down.
--
-- COST: 16.0 ms / 407 shared buffers for JULY 2026 (24 rows) under a 5 s guard —
-- the same single scan of `deliveries` the block lens pays, plus a group-by.
create or replace view public.view_ops_ledger_day_fed_blend as
select
  b.campaign_key,
  b.production_batch,
  b.campaign_year,
  b.calendar_date,

  sum(b.fed_kg)                                    as fed_kg,
  count(*)::int                                    as blocks_fed_count,

  sum(b.mc      * b.fed_kg) filter (where b.mc      is not null)
    / nullif(sum(b.fed_kg)  filter (where b.mc      is not null), 0) as w_mc,
  sum(b.fed_kg)             filter (where b.mc      is not null)     as mc_kg,

  sum(b.ash     * b.fed_kg) filter (where b.ash     is not null)
    / nullif(sum(b.fed_kg)  filter (where b.ash     is not null), 0) as w_ash,
  sum(b.fed_kg)             filter (where b.ash     is not null)     as ash_kg,

  sum(b.bd_astm * b.fed_kg) filter (where b.bd_astm is not null)
    / nullif(sum(b.fed_kg)  filter (where b.bd_astm is not null), 0) as w_bd_astm,
  sum(b.fed_kg)             filter (where b.bd_astm is not null)     as bd_astm_kg,

  sum(b.bd_jis  * b.fed_kg) filter (where b.bd_jis  is not null)
    / nullif(sum(b.fed_kg)  filter (where b.bd_jis  is not null), 0) as w_bd_jis,
  sum(b.fed_kg)             filter (where b.bd_jis  is not null)     as bd_jis_kg,

  sum(b.grit    * b.fed_kg) filter (where b.grit    is not null)
    / nullif(sum(b.fed_kg)  filter (where b.grit    is not null), 0) as w_grit,
  sum(b.fed_kg)             filter (where b.grit    is not null)     as grit_kg,

  sum(b.vm      * b.fed_kg) filter (where b.vm      is not null)
    / nullif(sum(b.fed_kg)  filter (where b.vm      is not null), 0) as w_vm,
  sum(b.fed_kg)             filter (where b.vm      is not null)     as vm_kg,

  sum(b.fc      * b.fed_kg) filter (where b.fc      is not null)
    / nullif(sum(b.fed_kg)  filter (where b.fc      is not null), 0) as w_fc,
  sum(b.fed_kg)             filter (where b.fc      is not null)     as fc_kg
from public.view_ops_ledger_day_block b
where b.fed_kg > 0
group by b.campaign_key, b.production_batch, b.campaign_year, b.calendar_date;

comment on view public.view_ops_ledger_day_fed_blend is
'Ops ledger: THE DAY''S PROJECTED FED BLEND - one row per (campaign, calendar day) that fed anything, carrying the FED-KG-WEIGHTED mean of each of the seven lab stats over the blocks the campaign drew from that day (w_mc, w_ash, w_bd_astm, w_bd_jis, w_grit, w_vm, w_fc). THIS IS A PROJECTION, NEVER A LAB RESULT ON THE PRODUCT: these are the lab averages of the RAW CHARCOAL that went IN, carried forward as an indication of what should come OUT, because the finished product is heavily determined by what was fed. No lab measured what this describes (Renzo, 2026-09-16: "not to be taken as truth but a good figure to have"), and it must be labelled INDICATIVE wherever it is shown, exactly as view_ops_ledger_day.yield_pct is. IT SELECTS FROM view_ops_ledger_day_block, the very view whose rows the sidebar lists underneath it, so the blended head and the block list can never be computed over different populations; each block''s stats are that block''s delivery-weighted lab averages, the same numbers the Blocking page shows. THE WEIGHT IS FED KG, NOT PILE BALANCE: fn_blend_proposal weights by view_blocking_grid.balance because it answers what a pile WOULD blend to, and it cannot see a closed block at all - this answers what was ACTUALLY fed, so it is deliberately not called here, though the statistic has the same SUM(stat*weight)/SUM(weight) shape and keeps its w_ prefix. EACH STAT IS WEIGHTED OVER ONLY THE BLOCKS THAT CARRY IT, and the fed kilos that did carry it ride beside it as <stat>_kg, so the UI can print "projected from 41,200 of 47,000 kg" rather than implying the whole day was measured; a stat no fed block carries that day is NULL, never 0. ⚠ grit_kg HERE IS COVERAGE - the fed kilos carrying a grit READING - and is unrelated to grit_kg on view_ops_ledger_day / view_ops_ledger_campaign_kpis, which is the GRITS WASTE STREAM in kilograms; the two are never joined. SUM(fed_kg) over a campaign equals that campaign''s KPI fed_kg and the row count equals its ledger days with fed_kg > 0 - both PROVEN every verify run (fed_blend_fold_mismatch / fed_blend_day_count_mismatch). NO ₱ COLUMN and none derivable, so this view needs no canViewPrices() gate and is safe for every role including Production. ROW BUDGET: <= ~31 rows per campaign (24 for JULY 2026), ~700 over all history - read PER CAMPAIGN.';


-- -----------------------------------------------------------------------------
-- 4. view_ops_ledger_campaign_kpis — THE BLOCKS TABLE'S OWN FOOTER
-- -----------------------------------------------------------------------------
-- APPEND ONLY: every existing column keeps its name, position and type.
--
-- The ACTUAL FED PRICE modal renders view_ops_ledger_campaign_block as a table;
-- its footer has to total the columns that table prints, and the campaign's
-- total ARRIVAL weight over the blocks it drew from is published nowhere. These
-- four columns are that footer, computed in SQL so the modal folds nothing in
-- TSX — the same reason view_ops_ledger_shift grew waste_pct and grade_kg.
--
--   blocks_delivered_kg          Sigma delivered_kg over EVERY block the campaign fed
--   blocks_closed_delivered_kg   ...over the CLOSED ones only: the resiko denominator,
--                                carried so the ratio is auditable from its own row
--   blocks_total_fed_kg          Sigma the blocks' ALL-TIME fed kg (NOT the campaign's own
--                                fed_kg — a shared block was fed by other campaigns too)
--   blocks_resiko_kg             Sigma resiko_kg, which is non-null only once a block CLOSES
--   blocks_closed_resiko_loss_pct  blocks_resiko_kg / blocks_closed_delivered_kg, a FRACTION
--
-- THE TWO RESIKO FIGURES AGREE, MEASURED ON ALL 32 CAMPAIGNS, 0 DIFFERENCES.
-- `block_resiko_kg` / `block_resiko_loss_pct` already exist here, lifted from
-- view_analytics_batch_cost.weight_lost_kg / loss_pct — and that view already
-- restricts itself to CLOSED blocks, so the footer's own arithmetic reproduces
-- it exactly, including on the campaigns that still hold OPEN blocks (JANUARY
-- 2024 has 14 open and both read NULL; SEPTEMBER 2026 has 4 open and both read
-- 9,260.00 kg / 0.022058). Neither is touched and neither is "fixed": the pair
-- is published because a total a reader can check against the rows above it is
-- worth more than a total they must take on trust, and `kpi_blocks_resiko_mismatch`
-- re-derives the agreement every verify run rather than leaving this paragraph
-- as the only evidence. JULY 2026: 1,054,434.00 arrival / 1,006,987.00 all-time
-- fed / 47,447.00 resiko / 0.04499760060847810294, against a KPI block_resiko_kg
-- of 47,447.00 and a block_resiko_loss_pct of 0.04499760060847810294.
--
-- NULL IS NEVER 0: a campaign with no block rows reads NULL on all four, and the
-- ratio is NULL when no block of the campaign has closed.
--
-- THE GROUP RPC GETS NOTHING NEW, and that is the same refusal it already makes
-- about resiko: 78 of 523 blocks were fed by more than one campaign (5 of Q3
-- 2026's 46), so adding a shared pile's whole-life ARRIVAL weight once per
-- campaign that touched it would inflate a group arrival total exactly the way a
-- group resiko kg would. fn_ops_ledger_group_blocks already publishes the
-- de-duplicated rows; a group footer must total THOSE.
--
-- The lateral is filtered on production_batch + campaign_year, never on the
-- computed campaign_key, so it pushes down into rc_out like the two laterals
-- beside it.
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
       else w.waste_kg / pbb.produced_kg end as waste_loss_pct,

  -- APPENDED 2026-09-16 — THE BLOCKS TABLE'S OWN FOOTER. See the note above:
  -- blocks_resiko_kg and blocks_closed_resiko_loss_pct are PROVEN equal to
  -- block_resiko_kg / block_resiko_loss_pct on all 32 campaigns, and exist so
  -- the modal's footer totals the rows it is showing rather than a figure from
  -- a different view. NULL, never 0, when the campaign has no block rows.
  cbf.blocks_delivered_kg,
  cbf.blocks_closed_delivered_kg,
  cbf.blocks_total_fed_kg,
  cbf.blocks_resiko_kg,
  case when cbf.blocks_resiko_kg is null
         or coalesce(cbf.blocks_closed_delivered_kg, 0) = 0 then null
       else cbf.blocks_resiko_kg / cbf.blocks_closed_delivered_kg
  end as blocks_closed_resiko_loss_pct

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
) w on true
-- THE BLOCKS TABLE'S FOOTER (2026-09-16), over the very view the modal renders.
left join lateral (
  select sum(v.delivered_kg)                              as blocks_delivered_kg,
         sum(v.delivered_kg) filter (where v.is_closed)   as blocks_closed_delivered_kg,
         sum(v.total_fed_kg)                              as blocks_total_fed_kg,
         sum(v.resiko_kg)                                 as blocks_resiko_kg
    from public.view_ops_ledger_campaign_block v
   where v.production_batch = sp.production_batch
     and v.campaign_year    = sp.campaign_year
) cbf on true;

comment on view public.view_ops_ledger_campaign_kpis is
'Ops ledger EOQ ROW: one row per production campaign - RC FED, PRODUCED, YIELD, LOSS, BLOCK RESIKO LOSS, WASTE LOSS, FED PRICE, ACTUAL FED PRICE, PC COST and TRUE PC COST, with every coverage count beside them. NOT ONE FIGURE IS COMPUTED HERE: every price, yield and coverage column is SELECTed verbatim from view_analytics_batch_cost (which itself lifts them from view_rc_movement_campaign_price / _campaign_actual_price / _campaign_yield) and every production column from view_analytics_production_by_batch - PROVEN identical on all 32 campaigns, zero mismatches. WASTE (added 2026-09-15): trml1_kg, trml2_kg, rs1a_kg, rs1b_kg, rs23_kg, rs5_kg, bf_kg, grit_kg and their total waste_kg are the EIGHT RECORDED STREAMS, folded from view_ops_ledger_shift - the same relation the day spine folds, so the EOQ figure and the LOSSES lens footer are one arithmetic at two grains. THEY DO NOT SUM TO PROCESS LOSS: most of what the retort loses leaves as moisture and volatiles nobody weighs, so waste_loss_pct is what was swept up and WEIGHED, never process_loss_pct. WASTE LOSS IS A FRACTION OF PRODUCED kg (Renzo, 2026-09-15): waste_loss_pct = waste_kg / produced_kg, because what the plant sweeps up is a property of what came OUT of the retort, not of what went in - JULY 2026 reads 0.152369 (94,651.5 kg of waste against 621,201 kg produced) where the earlier fed denominator read 0.121156. It is NULL, never 0, when produced_kg is NULL or 0; measured, 0 of the 10 waste-reporting campaigns lose their ratio to the change, since every one of them reported production. view_ops_ledger_day.waste_pct uses the SAME denominator, so the day column and this cell are one definition at two grains. NULL IS NEVER 0 on any of the nine kg columns - a campaign none of whose shifts filed a waste row reads NULL, and waste_shift_count (shifts that filed one) says how much of the campaign the figure covers. yield_pct, process_loss_pct, block_resiko_loss_pct, waste_loss_pct and campaign_fed_kg_included_pct are FRACTIONS; fed_price_coverage_pct and sacks_coverage_pct are PERCENTS (0-100) - their sources'' conventions, kept rather than harmonised so a reader can compare the two screens digit for digit. php_per_produced_kg_true is NULL, never 0, unless every block the campaign fed is CLOSED and fully priced (is_fully_covered) - measured, 2 of the 9 2026 campaigns are not. ₱ COLUMNS: fed_php_kg, fed_value_php, actual_fed_php_kg, campaign_weighted_actual_fed_php_kg, uplift_php_kg, php_per_produced_kg_delivered, php_per_produced_kg_true - all must be nulled server-side when !canViewPrices(); NO waste column carries money. THE BLOCKS TABLE FOOTER (appended 2026-09-16): blocks_delivered_kg (total ARRIVAL weight over every block the campaign drew from), blocks_closed_delivered_kg (the same over the CLOSED ones, carried so the ratio below is auditable from its own row), blocks_total_fed_kg (the blocks'' ALL-TIME fed kilos, which is NOT this campaign''s fed_kg because a shared block was fed by other campaigns too), blocks_resiko_kg and blocks_closed_resiko_loss_pct (a FRACTION) are the FOOTER of the table view_ops_ledger_campaign_block renders in the ACTUAL FED PRICE modal, totalled in SQL so the modal folds nothing in TSX. THE TWO RESIKO FIGURES AGREE AND NEITHER IS THE OTHER''S REPLACEMENT: block_resiko_kg / block_resiko_loss_pct come from view_analytics_batch_cost.weight_lost_kg / loss_pct, which already restricts itself to CLOSED blocks, so the footer''s own arithmetic reproduces them EXACTLY - measured on all 32 campaigns, 0 differences, including the campaigns still holding open blocks (JANUARY 2024: 14 open, both NULL; SEPTEMBER 2026: 4 open, both 9,260.00 kg / 0.022058). JULY 2026 reads 1,054,434.00 kg arrival / 1,006,987.00 kg all-time fed / 47,447.00 kg resiko / 0.04499760060847810294. The pair is published because a total a reader can check against the rows above it is worth more than one they must take on trust, and kpi_blocks_resiko_mismatch re-derives that agreement every verify run. NULL, never 0, on all four when the campaign has no block rows, and the ratio is NULL until a block closes. NO waste and NO blocks-footer column carries money. ROW BUDGET: 32 rows, all history.';


-- -----------------------------------------------------------------------------
-- 5. POSTURE — re-ALTER what a REPLACE reset, and full posture for what is new
-- -----------------------------------------------------------------------------
-- CREATE OR REPLACE VIEW KEEPS THE GRANTS AND RESETS `reloptions`. THREE views
-- are replaced above, so security_invoker goes back on all three HERE, in the
-- same file — never in a follow-up, which is how it was missed twice on
-- view_ops_ledger_campaign_kpis (repaired by 20260914065558 and again by
-- 20260915021924). Proven afterwards by reading pg_options_to_table(reloptions)
-- for every view_ops_ledger_* view, and live every run by
-- fn_ops_ledger_verify_posture()'s not_security_invoker = 0.
alter view public.view_ops_ledger_campaign_span   set (security_invoker = true);
alter view public.view_ops_ledger_day_block       set (security_invoker = true);
alter view public.view_ops_ledger_campaign_kpis   set (security_invoker = true);

-- The grants are NOT lost by a REPLACE, but they are restated for the three so a
-- reader of this file alone can see the whole posture of everything it touches.
revoke all on public.view_ops_ledger_campaign_span   from public, anon;
grant select on public.view_ops_ledger_campaign_span   to authenticated;
revoke all on public.view_ops_ledger_day_block       from public, anon;
grant select on public.view_ops_ledger_day_block       to authenticated;
revoke all on public.view_ops_ledger_campaign_kpis   from public, anon;
grant select on public.view_ops_ledger_campaign_kpis   to authenticated;

-- THE NEW VIEW gets the whole posture from birth: security_invoker,
-- authenticated SELECT only, anon revoked, and NEVER service_role — the sync
-- worker reads none of these, so verify-worker-view-grants must stay at 4 views
-- / 0 findings (L-044's arrow direction: a consumer is not a dependency).
alter view public.view_ops_ledger_day_fed_blend  set (security_invoker = true);
revoke all on public.view_ops_ledger_day_fed_blend   from public, anon;
grant select on public.view_ops_ledger_day_fed_blend   to authenticated;


-- -----------------------------------------------------------------------------
-- 6. THE PROBES — three new keys on the campaign probe, one on the posture probe
-- -----------------------------------------------------------------------------
-- CREATE OR REPLACE FUNCTION with an unchanged signature and return type KEEPS
-- its grants; they are restated in §7 anyway, because the DROP+CREATE trap on
-- fn_ops_ledger_group_kpis taught that a grant a reader cannot see in the file
-- is a grant nobody checks.

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
'READ-ONLY verification probe for ONE ops-ledger campaign — the instrument behind scripts/verify-ops-ledger.ts, which calls it once per campaign, strictly sequentially. It replaces fn_ops_ledger_verify(), a single whole-history probe that hung the instance (OOM) on 2026-09-14 and took the live site down. EVERY subquery is filtered on production_batch + campaign_year (never on the computed campaign_key, which cannot be pushed down), which is what keeps a full run in the tens of milliseconds. It proves the four day-level FOLDS (grades, blocks fed, shift produced, shift downtime) against the day spine, the WASTE fold in both forms (waste_fold_mismatch = the campaign total vs the day spine''s, 0/1; waste_stream_fold_mismatch = how many of the EIGHT streams differ, 0..8 — because a total can agree while two streams are swapped), the day totals against the campaign KPI row, the grade fold against the campaign grade set, ledger_days against span_days, both REUSE comparisons (view_analytics_batch_cost and view_analytics_production_by_batch, column for column) and the ONE-campaign GROUP identity against fn_ops_ledger_group_kpis, waste columns included. SECURITY DEFINER (the views are authenticated-only, so no key a script can hold may read them), STABLE, service_role EXECUTE only. IT RETURNS NO ₱ VALUE: every money-derived key is a GAP that must be 0, a count, or a boolean. It also proves the DAY-LEVEL RATIOS added 2026-09-15 (day_ratio_mismatch: each of waste_pct, yield_pct and loss_pct must equal the division of the row''s OWN published inputs, which fails both on a ratio present where an input is missing and on a NULL published over two real numbers, and pins loss_pct to 1 - the published yield_pct) and the campaign cell''s new denominator (kpi_waste_pct_mismatch, 0/1: waste_loss_pct must equal waste_kg / produced_kg - this is what catches the denominator silently reverting to fed kg). It also proves the CAMPAIGN x BLOCK table added 2026-09-15 (campaign_block_fold_mismatch: SUM(view_ops_ledger_campaign_block.campaign_fed_kg) must equal the campaign KPI row''s fed_kg, which is what keeps the FED PRICE / ACTUAL FED PRICE modal from crediting a campaign with kilos another campaign ate out of a shared block; campaign_block_count_mismatch: its row count must equal blocks_fed). It also proves THE DAY''S PROJECTED FED BLEND added 2026-09-16 (fed_blend_fold_mismatch: SUM(view_ops_ledger_day_fed_blend.fed_kg) must equal the campaign KPI row''s fed_kg, since the blend is a GROUP BY over view_ops_ledger_day_block -- the very relation the day spine folds -- so anything but 0 means the sidebar''s blended head was weighted over a different population than the block rows printed beneath it; fed_blend_day_count_mismatch: exactly one blend row per ledger day with fed_kg > 0, so a FED cell can never be un-openable and a blend can never describe a day the ledger says fed nothing) and THE BLOCKS FOOTER (kpi_blocks_resiko_mismatch: the footer''s own Sigma resiko over view_ops_ledger_campaign_block must equal block_resiko_kg from view_analytics_batch_cost, and likewise the ratio -- two arithmetics over the same CLOSED blocks, so the published agreement is re-derived every run instead of living only in a COMMENT). Zero on every *_mismatch key is the passing state. RAISES on a key that is not <BATCH>-<YYYY> or that does not resolve to exactly one campaign span row.';



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
     -- role a read of ten views that are deliberately closed to it.
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
                            'view_ops_ledger_day_block','view_ops_ledger_campaign_grades',
                            'view_ops_ledger_day_fed_blend')
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
   -- ONE read of the span (32 rows, 9 ms). It hands the script the campaign keys
   -- it must then check ONE AT A TIME -- and since 2026-09-16 it also answers the
   -- QUARTER question from the same pass: every campaign must resolve to a
   -- quarter, because the picker's presets are built on quarter_key and a NULL
   -- there is a campaign no preset can ever offer. It cannot be null while
   -- first_date and last_date are non-null, so a non-zero count means the span
   -- itself lost an endpoint.
   select coalesce(array_agg(sp.campaign_key order by sp.first_date, sp.campaign_key), '{}'::text[]) as campaign_keys,
          count(*) filter (where sp.quarter_key is null)::int   as quarter_key_null_count,
          count(*) filter (where sp.quarter_label is null)::int as quarter_label_null_count,
          count(distinct sp.quarter_key)::int                   as quarter_count
     from public.view_ops_ledger_campaign_span sp
 )
select to_jsonb(posture) || to_jsonb(verify_fns) || to_jsonb(legacy)
       || to_jsonb(money) || to_jsonb(keys)
from posture, verify_fns, legacy, money, keys;
$fn$;

comment on function public.fn_ops_ledger_verify_posture() is
'READ-ONLY posture probe for the ops-ledger data layer: CATALOG ONLY (pg_class / pg_description / has_table_privilege / has_function_privilege / information_schema.columns) plus ONE read of view_ops_ledger_campaign_span (32 rows, 9 ms) whose sole purpose is to hand the verification script the campaign_keys it must then check ONE AT A TIME. It asserts the TEN views (view_ops_ledger_campaign_block joined them on 2026-09-15, view_ops_ledger_day_fed_blend on 2026-09-16) are security_invoker, commented, authenticated-SELECT, anon-denied and service_role-denied; that fn_ops_ledger_group_kpis is authenticated-only; that all THREE verify functions are service_role-only (verify_fns_service_role_only); that the whole-history probes fn_ops_ledger_verify / fn_ops_ledger_verify_groups no longer exist (legacy_verify_fn_count = 0, after the 2026-09-14 OOM incident); and that the SIX peso-free views (view_ops_ledger_day_fed_blend joined them on 2026-09-16) carry no money-named column while view_ops_ledger_day carries exactly one. Since 2026-09-15 it also publishes campaign_block_money_named_columns, the EXACT SET of money-ish column names on view_ops_ledger_campaign_block - that view carries ₱ on purpose, so a count of zero is not the assertion; four of the five are real pesos named in its own COMMENT and in_price_set is a boolean coverage flag the regex catches on the word price, and listing the names is what makes a FIFTH peso column appearing a failure rather than an off-by-one nobody reads. Since 2026-09-16 the same single span read also publishes quarter_key_null_count (MUST BE 0: the campaign picker''s quarter presets are built on quarter_key, so a campaign with no quarter is one no preset can ever offer -- and quarter_key cannot be null while first_date and last_date are non-null, so a non-zero count means the span itself lost an endpoint), quarter_label_null_count and quarter_count. SECURITY DEFINER, STABLE, service_role EXECUTE only. NO ₱ VALUE.';


-- -----------------------------------------------------------------------------
-- 7. PROBE GRANTS — service_role ONLY, restated
-- -----------------------------------------------------------------------------
-- Both probes are SECURITY DEFINER over views that are authenticated-only, so a
-- stray grant to `authenticated` would hand a client role a read of ten views
-- deliberately closed to it. A same-signature CREATE OR REPLACE keeps the
-- existing grants, but they are restated so this file alone shows the posture.
revoke execute on function public.fn_ops_ledger_verify_campaign(text)   from public, anon, authenticated;
grant execute on function public.fn_ops_ledger_verify_campaign(text)   to service_role;
revoke execute on function public.fn_ops_ledger_verify_posture()       from public, anon, authenticated;
grant execute on function public.fn_ops_ledger_verify_posture()        to service_role;
