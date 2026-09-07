-- ============================================================================
-- products_sheet_disagreement_columns
-- ============================================================================
-- Two MEASURED facts about the live PRODUCTS INVENTORY sheet, found the moment the first
-- real ingestion was cross-checked, given columns instead of being left to surprise
-- someone later. Both are additive: no existing column moved, so CREATE OR REPLACE keeps
-- every grant (L-044).
--
-- ─────────────────────────────────────────────────────────────────────────────
-- FACT 1 — THE SHEET'S OWN RUNNING-BALANCE CELLS DISAGREE WITH THE SHEET'S OWN DELTAS
-- ─────────────────────────────────────────────────────────────────────────────
-- `view_product_ledger.agrees_with_sheet` came back false on 448 of 808 rows. That is not
-- the view being wrong — it is the view doing its job. Measured, IN SHEET ORDER (so the
-- date-ordering question is removed entirely), the sheet's printed running column against
-- a cumulative sum of the sheet's OWN delta column:
--
--     8X50           0 of  33 rows disagree   (exact — the sheet is right here)
--     6X50          14 of 331 (PROD)
--     2X6          153 of 216 (PROD), 34 (FINAL)
--     4X8           94 of 101 (PROD), 66 (FINAL)
--     KURARAY 3X50 117 of 127 (PROD), 68 (OLD PROD)
--
-- WHICH SIDE IS RIGHT IS NOT A MATTER OF OPINION: the tab's HEADER BLOCK totals — computed
-- by Renzo's own SUM formulas over the delta column, in cells this extractor never reads —
-- agree with `opening + SUM(flec_delta)` on ALL TWELVE non-zero (grade, stage) pairs,
-- exactly. The delta column and the header totals agree with each other and with us; it is
-- the mid-ledger running cells that drift, and they are cosmetic — nothing is computed from
-- them. NOTHING IS REPAIRED HERE. `sheet_running` is still stored verbatim and is still
-- never an input; the disagreement is now COUNTABLE so a UI can say "the sheet's own
-- running column drifts on N rows" once, rather than painting half the ledger red.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- FACT 2 — FOUR 2X6 ROWS ARE DATED 2025-07-29 AND SIT AT SHEET ROWS 229-232
-- ─────────────────────────────────────────────────────────────────────────────
-- Nearly a year later in the ledger than their date, and BEFORE 2X6's own first row
-- (2025-09-18). This is the shape of the flecon `2025-01-31` / `2026-01-31` operator year
-- typo already on record — very likely 2026-07-29 mistyped. IT IS NOT CORRECTED: guessing
-- a date is how a loud wrong becomes a quiet one, and the balances are unaffected either
-- way (a sum does not care about order). It is FLAGGED, so a person can decide.
--
-- No peso anywhere, here or upstream.

create or replace view public.view_product_ledger
with (security_invoker = true) as
with open_pivot as (
  select grade_id,
         coalesce(sum(flecs) filter (where stage = 'PROD'), 0)::bigint     as o_prod,
         coalesce(sum(flecs) filter (where stage = 'OLD PROD'), 0)::bigint as o_old_prod,
         coalesce(sum(flecs) filter (where stage = 'AYAG'), 0)::bigint     as o_ayag,
         coalesce(sum(flecs) filter (where stage = 'MAGNET'), 0)::bigint   as o_magnet,
         coalesce(sum(flecs) filter (where stage = 'FINAL'), 0)::bigint    as o_final,
         coalesce(sum(flecs) filter (where stage = 'BLENDED'), 0)::bigint  as o_blended,
         coalesce(sum(flecs) filter (where stage = 'SUNDRY'), 0)::bigint   as o_sundry,
         coalesce(sum(flecs) filter (where stage = 'RECLASS'), 0)::bigint  as o_reclass,
         coalesce(sum(flecs), 0)::bigint                                   as o_total
    from public.product_grade_openings
   group by 1
),
w as (
  select m.id            as movement_id,
         m.grade_id,
         g.code          as grade_code,
         g.display_name,
         g.active,
         m.transaction_date,
         m.stage,
         m.flec_delta,
         m.kg_delta,
         m.remarks,
         m.source_row,
         m.sheet_running,
         coalesce(op.o_prod, 0)     + sum(case when m.stage = 'PROD'     then m.flec_delta else 0 end) over win as prod_flecs,
         coalesce(op.o_old_prod, 0) + sum(case when m.stage = 'OLD PROD' then m.flec_delta else 0 end) over win as old_prod_flecs,
         coalesce(op.o_ayag, 0)     + sum(case when m.stage = 'AYAG'     then m.flec_delta else 0 end) over win as ayag_flecs,
         coalesce(op.o_magnet, 0)   + sum(case when m.stage = 'MAGNET'   then m.flec_delta else 0 end) over win as magnet_flecs,
         coalesce(op.o_final, 0)    + sum(case when m.stage = 'FINAL'    then m.flec_delta else 0 end) over win as final_flecs,
         coalesce(op.o_blended, 0)  + sum(case when m.stage = 'BLENDED'  then m.flec_delta else 0 end) over win as blended_flecs,
         coalesce(op.o_sundry, 0)   + sum(case when m.stage = 'SUNDRY'   then m.flec_delta else 0 end) over win as sundry_flecs,
         coalesce(op.o_reclass, 0)  + sum(case when m.stage = 'RECLASS'  then m.flec_delta else 0 end) over win as reclass_flecs,
         coalesce(op.o_total, 0)    + sum(m.flec_delta) over win                                              as total_flecs,
         sum(m.kg_delta) over win                                                                             as running_kg,
         -- A row whose date is EARLIER than the row above it in the sheet. Flagged, never
         -- corrected: four 2X6 rows (sheet rows 229-232) are dated 2025-07-29.
         (m.transaction_date
            < lag(m.transaction_date) over (partition by m.grade_id order by m.source_row)) as date_out_of_sheet_order
    from public.product_movements m
    join public.product_grades g on g.id = m.grade_id
    left join open_pivot op on op.grade_id = m.grade_id
  window win as (partition by m.grade_id
                 order by m.transaction_date, m.source_row
                 rows between unbounded preceding and current row)
),
c as (
  select w.*,
         jsonb_build_object(
           'PROD', prod_flecs, 'OLD PROD', old_prod_flecs, 'AYAG', ayag_flecs,
           'MAGNET', magnet_flecs, 'FINAL', final_flecs, 'BLENDED', blended_flecs,
           'SUNDRY', sundry_flecs, 'RECLASS', reclass_flecs
         ) as computed_running
    from w
)
select c.movement_id, c.grade_id, c.grade_code, c.display_name, c.active,
       c.transaction_date, c.stage, c.flec_delta, c.kg_delta, c.remarks, c.source_row,
       c.prod_flecs, c.old_prod_flecs, c.ayag_flecs, c.magnet_flecs, c.final_flecs,
       c.blended_flecs, c.sundry_flecs, c.reclass_flecs, c.total_flecs, c.running_kg,
       c.sheet_running,
       c.computed_running,
       case
         when c.sheet_running is null then null
         else coalesce((
           select bool_and((kv.value)::numeric = (c.computed_running ->> kv.key)::numeric)
             from jsonb_each_text(c.sheet_running) kv
            where c.computed_running ? kv.key
         ), true)
       end as agrees_with_sheet,
       coalesce(c.date_out_of_sheet_order, false) as date_out_of_sheet_order
  from c;

create or replace view public.view_product_onhand
with (security_invoker = true) as
with rate as (
  -- kg per flec is PER GRADE and MOVES (8X50 550, 6X50 550->570, 2X6 550->570,
  -- Kuraray 590, 4X8 575), so it is READ BACK from the latest row that states both
  -- numbers — never hardcoded. `kg_per_flec_distinct_count` says how many rates the
  -- grade has ever used, so a UI can show that the figure is a current rate, not a
  -- constant. One measured outlier exists (2X6 source row 266, ratio 2736) and it is
  -- deliberately not filtered out by a tolerance: it is simply not the latest row.
  select distinct on (grade_id)
         grade_id,
         (abs(kg_delta) / abs(flec_delta))::numeric as kg_per_flec,
         transaction_date                           as kg_per_flec_as_of,
         source_row                                 as kg_per_flec_source_row
    from public.product_movements
   where flec_delta <> 0 and kg_delta is not null and kg_delta <> 0
   order by grade_id, transaction_date desc, source_row desc
),
rate_variants as (
  select grade_id,
         count(distinct round(abs(kg_delta) / abs(flec_delta), 4))::int as kg_per_flec_distinct_count
    from public.product_movements
   where flec_delta <> 0 and kg_delta is not null and kg_delta <> 0
   group by 1
),
crosscheck as (
  select grade_id,
         count(*) filter (where agrees_with_sheet is false)::bigint as sheet_running_disagreement_count,
         count(*) filter (where date_out_of_sheet_order)::bigint     as date_out_of_order_count
    from public.view_product_ledger
   group by 1
),
bal as (
  select grade_id,
         coalesce(sum(balance_flecs), 0)::bigint                                   as total_flecs,
         coalesce(sum(balance_flecs) filter (where stage = 'PROD'), 0)::bigint     as prod_flecs,
         coalesce(sum(balance_flecs) filter (where stage = 'OLD PROD'), 0)::bigint as old_prod_flecs,
         coalesce(sum(balance_flecs) filter (where stage = 'AYAG'), 0)::bigint     as ayag_flecs,
         coalesce(sum(balance_flecs) filter (where stage = 'MAGNET'), 0)::bigint   as magnet_flecs,
         coalesce(sum(balance_flecs) filter (where stage = 'FINAL'), 0)::bigint    as final_flecs,
         coalesce(sum(balance_flecs) filter (where stage = 'BLENDED'), 0)::bigint  as blended_flecs,
         coalesce(sum(balance_flecs) filter (where stage = 'SUNDRY'), 0)::bigint   as sundry_flecs,
         coalesce(sum(balance_flecs) filter (where stage = 'RECLASS'), 0)::bigint  as reclass_flecs,
         -- THE CATCH-ALL. A ninth stage invented in a future tab lands here rather than
         -- disappearing out of `total_flecs`'s components.
         coalesce(sum(balance_flecs) filter (
           where stage not in ('PROD','OLD PROD','AYAG','MAGNET','FINAL','BLENDED','SUNDRY','RECLASS')
         ), 0)::bigint                                                             as other_flecs,
         coalesce(sum(opening_flecs), 0)::bigint                                   as opening_flecs,
         sum(movement_kg)                                                          as ledger_kg_net,
         coalesce(sum(movement_count), 0)::bigint                                  as movement_count,
         coalesce(sum(movements_missing_kg), 0)::bigint                            as movements_missing_kg,
         max(last_movement_date)                                                   as last_movement_date,
         min(first_movement_date)                                                  as first_movement_date,
         count(*)::int                                                             as stage_count
    from public.view_product_stage_balance
   group by 1
)
select g.id                                       as grade_id,
       g.code                                     as grade_code,
       g.sheet_name,
       g.display_name,
       g.active,
       g.sort_order,
       coalesce(b.prod_flecs, 0)                  as prod_flecs,
       coalesce(b.old_prod_flecs, 0)              as old_prod_flecs,
       coalesce(b.ayag_flecs, 0)                  as ayag_flecs,
       coalesce(b.magnet_flecs, 0)                as magnet_flecs,
       coalesce(b.final_flecs, 0)                 as final_flecs,
       coalesce(b.blended_flecs, 0)               as blended_flecs,
       coalesce(b.sundry_flecs, 0)                as sundry_flecs,
       coalesce(b.reclass_flecs, 0)               as reclass_flecs,
       coalesce(b.other_flecs, 0)                 as other_flecs,
       coalesce(b.total_flecs, 0)                 as total_flecs,
       coalesce(b.final_flecs, 0)                 as shippable_flecs,
       round(coalesce(b.final_flecs, 0)::numeric / 44.0, 4) as vans_ready,
       r.kg_per_flec,
       r.kg_per_flec_as_of,
       coalesce(rv.kg_per_flec_distinct_count, 0) as kg_per_flec_distinct_count,
       (coalesce(b.total_flecs, 0) * r.kg_per_flec)                    as total_kg,
       round(coalesce(b.total_flecs, 0) * r.kg_per_flec / 1000.0, 3)   as total_tons,
       (coalesce(b.final_flecs, 0) * r.kg_per_flec)                    as final_kg,
       round(coalesce(b.final_flecs, 0) * r.kg_per_flec / 1000.0, 3)   as final_tons,
       coalesce(b.opening_flecs, 0)               as opening_flecs,
       b.ledger_kg_net,
       coalesce(b.movement_count, 0)              as movement_count,
       coalesce(b.movements_missing_kg, 0)        as movements_missing_kg,
       b.first_movement_date,
       b.last_movement_date,
       coalesce(b.stage_count, 0)                 as stage_count,
       g.opening_as_of,
       g.thresholds,
       (g.thresholds ->> 'ash_max')::numeric      as ash_max,
       (g.thresholds ->> 'me50_under')::numeric   as me50_under,
       (g.thresholds ->> 'vm_max')::numeric       as vm_max,
       g.aliases,
       g.content_fingerprint,
       g.first_seen_at,
       g.last_seen_at,
       g.updated_at,
       coalesce(cc.sheet_running_disagreement_count, 0) as sheet_running_disagreement_count,
       coalesce(cc.date_out_of_order_count, 0)          as date_out_of_order_count
  from public.product_grades g
  left join bal b  on b.grade_id  = g.id
  left join rate r on r.grade_id  = g.id
  left join rate_variants rv on rv.grade_id = g.id
  left join crosscheck cc on cc.grade_id = g.id;

comment on view public.view_product_ledger is
  'Every product movement with the running balance of EVERY stage as of that row, computed '
  'in SQL (conditional window sums, ordered by transaction_date then source_row). This is '
  'the "running tally as seen in the google sheet" — the app must never recompute it. '
  'READ THIS BEFORE TRUSTING `agrees_with_sheet`: it is false on 448 of 808 rows today, and '
  'that is the SHEET, not this view. Measured in SHEET order (so ordering is not the '
  'question), the tab''s printed running cells disagree with a cumulative sum of the tab''s '
  'OWN delta column on 117 of 127 Kuraray PROD rows, 94 of 101 on 4X8, 153 of 216 on 2X6, '
  '14 of 331 on 6X50 and 0 of 33 on 8X50. Which side is right is settled independently: the '
  'tab''s header-block totals, computed by its own SUM formulas over cells this extractor '
  'never reads, agree with `opening + SUM(flec_delta)` on all twelve non-zero (grade, stage) '
  'pairs exactly. The running cells are cosmetic and nothing is computed from them. '
  'NO PESO COLUMN AND NONE DERIVABLE.';

comment on column public.view_product_ledger.date_out_of_sheet_order is
  'This row is dated EARLIER than the row above it in the sheet. Flagged, never corrected — '
  'four 2X6 rows (sheet rows 229-232) are dated 2025-07-29, before that tab''s own first '
  'row, which is the shape of the flecon operator year-typo already on record. Balances are '
  'unaffected (a sum does not care about order); guessing the intended date is not this '
  'view''s business.';

comment on column public.view_product_onhand.sheet_running_disagreement_count is
  'Rows on which the SHEET''S OWN printed running-balance cell disagrees with the balance '
  'computed from the sheet''s own deltas. This says something about the SHEET, not about '
  'this grade''s balance: the tab''s header totals agree with our arithmetic exactly on '
  'every stage. Surface it ONCE per grade — never as a red mark on every row.';

comment on column public.view_product_onhand.date_out_of_order_count is
  'Rows dated earlier than the row above them in the sheet — a likely operator year typo, '
  'flagged and never corrected. Does not affect any balance.';
