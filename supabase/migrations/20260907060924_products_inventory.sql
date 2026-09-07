-- ============================================================================
-- products_inventory — finished-product (flecon) inventory for ICTC
-- ============================================================================
-- Renzo maintains a Google Sheet with ONE TAB PER PRODUCT GRADE (8X50, 6X50,
-- 2X6, Kuraray 3x50, 4X8 today; more as time goes on). Each tab carries a
-- header block of current per-stage flec counts and a running ledger of signed
-- movements between stages (PROD -> AYAG -> MAGNET -> FINAL, plus BLENDED /
-- SUNDRY / RECLASS and, on Kuraray, OLD PROD).
--
-- THIS FEATURE CARRIES NO PESO ANYWHERE. There is no cost column, no price and
-- none derivable, on any table, view or function below. Every read is therefore
-- safe for every role including Production and needs NO canViewPrices() gate.
--
-- THE SHAPING FACTS, all MEASURED on the live sheet 2026-09-07:
--  1. A GRADE IS A TAB, and the tab name is typed by a person. So identity is
--     the CANONICAL code (upper, whitespace-collapsed) and a rename must be
--     recognised from CONTENT (`content_fingerprint`), never from name
--     similarity. See fn_upsert_product_grade / fn_rename_product_grade.
--  2. THE LEDGER'S DATE IS CARRIED FORWARD. Only the first row of a day carries
--     a DATE; 126 / 87 / 93 / 78 rows on 6X50 / 2X6 / Kuraray / 4X8 inherit it.
--     The extractor resolves that, so `transaction_date` here is always real.
--  3. STAGES ARE NOT A FIXED LIST. Kuraray has OLD PROD and its running-balance
--     columns are shifted one to the right. `stage` is therefore TEXT, read from
--     the sheet's own header row — never a column position and never an enum.
--     `view_product_onhand` still publishes the eight known stages as columns
--     AND an `other_flecs` catch-all, so a ninth stage can never vanish.
--  4. KG PER FLEC IS PER GRADE **AND MOVES**: 8X50 550, 6X50 550 -> 570,
--     2X6 550 -> 570, Kuraray 590, 4X8 575. So the kg is stored PER MOVEMENT
--     (it is in the row) and the grade's rate is derived as the latest non-zero
--     |kg|/|flec| ratio. Never hardcode 550.
--  5. KG IS NULLABLE AND IS NOT COALESCED TO 0. One real row (6X50, 2025-10-03,
--     AYAG, 2 flec) carries no kg at all. 0 would claim "zero kilos moved" where
--     the truth is "not recorded" — the project's NULL != 0 rule.
--
-- PROVEN before a line of this was written: for all five grades,
-- `opening_flecs + SUM(flec_delta)` reproduces the sheet's OWN header-block
-- counts exactly, stage for stage (8X50 FINAL 59; 6X50 PROD 157 / AYAG 3 /
-- MAGNET 25 / FINAL 187; 2X6 FINAL 65 / BLENDED 20; Kuraray OLD PROD 110 /
-- FINAL 36; 4X8 FINAL 35).
-- ============================================================================

-- ---------------------------------------------------------------------------
-- product_grades — one row per product (one tab in the sheet)
-- ---------------------------------------------------------------------------
create table if not exists public.product_grades (
  id                  uuid primary key default gen_random_uuid(),
  code                text not null unique,
  sheet_name          text not null,
  display_name        text not null,
  active              boolean not null default true,
  sort_order          integer not null default 0,
  thresholds          jsonb  not null default '{}'::jsonb,
  opening_as_of       date,
  content_fingerprint text,
  aliases             text[] not null default '{}'::text[],
  first_seen_at       timestamptz not null default now(),
  last_seen_at        timestamptz not null default now(),
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  constraint product_grades_code_canonical
    check (code = upper(btrim(regexp_replace(code, '\s+', ' ', 'g')))),
  constraint product_grades_code_nonblank check (btrim(code) <> ''),
  constraint product_grades_sheet_name_nonblank check (btrim(sheet_name) <> '')
);

comment on table public.product_grades is
  'One product grade = one tab in Renzo''s PRODUCTS INVENTORY Google Sheet. `code` is the '
  'canonical identity (upper, whitespace-collapsed sheet name) and is UNIQUE; `sheet_name` is '
  'the tab name as currently typed. A tab that is RENAMED keeps this row and its id — the '
  'rename is recognised from `content_fingerprint` (or from an overwhelming overlap of '
  'movement row_hashes), NEVER from name similarity — and the former name is appended to '
  '`aliases`. No hard delete: a grade whose tab disappears keeps its row and is only ever '
  'flagged by the sync (finding `product_sheet_missing`); deactivation is a human act.';
comment on column public.product_grades.code is
  'Canonical key: upper(btrim(sheet_name)) with runs of whitespace collapsed to one space. '
  'CHECKed, so a non-canonical code cannot be stored by any path.';
comment on column public.product_grades.content_fingerprint is
  'sha256 hex over the grade''s opening balances + the first 10 ledger rows (date, stage, '
  'flec, kg) — the part of a tab that never changes once written. THE rename evidence. '
  'Computed by the worker (lib/productFingerprint.ts); public.fn_product_grade_fingerprint() '
  'is the SQL check function that must agree with it.';
comment on column public.product_grades.aliases is
  'Former sheet names this grade has been known by, appended on rename. Never removed.';
comment on column public.product_grades.thresholds is
  'Lab thresholds parsed tolerantly from the tab''s header text: {ash_max, me50_under, '
  'vm_max}. Any key may be absent — 8X50 states none at all. Nullable by omission, never 0.';

create index if not exists product_grades_active_idx
  on public.product_grades (active, sort_order, code);
create index if not exists product_grades_fingerprint_idx
  on public.product_grades (content_fingerprint) where content_fingerprint is not null;

-- ---------------------------------------------------------------------------
-- product_grade_openings — the FLECON STARTING BALANCE row
-- ---------------------------------------------------------------------------
create table if not exists public.product_grade_openings (
  grade_id uuid not null references public.product_grades (id) on delete cascade,
  stage    text not null,
  flecs    integer not null,
  as_of    date,
  primary key (grade_id, stage),
  constraint product_grade_openings_stage_canonical
    check (stage = upper(btrim(regexp_replace(stage, '\s+', ' ', 'g')))),
  constraint product_grade_openings_stage_nonblank check (btrim(stage) <> '')
);

comment on table public.product_grade_openings is
  'The tab''s FLECON STARTING BALANCE row: the opening flec count per stage, and the date it '
  'stands as of (`AS OF AUGUST 30, 2025`; NULL where the tab states none — Kuraray and 4X8). '
  'Every balance in this module is `opening + SUM(flec_delta)`; a stage absent here opens at 0.';

-- ---------------------------------------------------------------------------
-- product_movements — the ledger
-- ---------------------------------------------------------------------------
create table if not exists public.product_movements (
  id               uuid primary key default gen_random_uuid(),
  grade_id         uuid not null references public.product_grades (id) on delete cascade,
  transaction_date date not null,
  stage            text not null,
  flec_delta       integer not null,
  kg_delta         numeric,
  remarks          text,
  source_row       integer not null,
  row_hash         text not null,
  sheet_running    jsonb,
  created_at       timestamptz not null default now(),
  unique (grade_id, row_hash),
  constraint product_movements_stage_canonical
    check (stage = upper(btrim(regexp_replace(stage, '\s+', ' ', 'g')))),
  constraint product_movements_stage_nonblank check (btrim(stage) <> ''),
  constraint product_movements_source_row_positive check (source_row > 0)
);

comment on table public.product_movements is
  'One signed movement from the tab''s ledger. Written ONLY by the sync worker''s `products` '
  'report through fn_replace_product_grade (replace-by-grade, keyed on row_hash).';
comment on column public.product_movements.transaction_date is
  'The row''s date, RESOLVED. Only the first row of a day carries a DATE cell in the sheet; '
  'the rest inherit it (measured: 126 of 331 rows on 6X50 do). Never NULL here.';
comment on column public.product_movements.kg_delta is
  'Signed kilograms. NULLABLE AND NEVER COALESCED TO 0 — one real row (6X50, 2025-10-03, '
  'AYAG, 2 flec) records no kg, and 0 would claim zero kilos moved where the truth is '
  '"not recorded". Read `movements_missing_kg` for the coverage.';
comment on column public.product_movements.row_hash is
  'sha256 hex of grade code|date|stage|flec|kg|remarks|source_row — THE replace-by-grade '
  'idempotency key. A row whose hash is already present is left untouched (no UPDATE, so a '
  're-run of an unchanged tab writes literally nothing).';
-- SUPERSEDED the same day by 20260907062522_products_row_hash_excludes_grade_code.sql:
-- the grade code was REMOVED from the hash. Left here verbatim so the migration replays
-- exactly as it was applied; read the amendment for why.
comment on column public.product_movements.sheet_running is
  'The SHEET''S OWN running balances on this row, kept verbatim for cross-check ONLY. The '
  'app''s balances are computed in SQL (view_product_ledger) and this column is never an '
  'input to them — it exists so a disagreement can be SHOWN, not so it can be trusted.';

create index if not exists product_movements_grade_date_idx
  on public.product_movements (grade_id, transaction_date, source_row);
create index if not exists product_movements_grade_stage_idx
  on public.product_movements (grade_id, stage);

-- ---------------------------------------------------------------------------
-- updated_at touch trigger (product_grades only)
-- ---------------------------------------------------------------------------
create or replace function public.fn_touch_product_grade()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists tr_touch_product_grade on public.product_grades;
create trigger tr_touch_product_grade
  before update on public.product_grades
  for each row execute function public.fn_touch_product_grade();

revoke execute on function public.fn_touch_product_grade() from public;
revoke execute on function public.fn_touch_product_grade() from anon;
-- L-043: a role that can WRITE the table fires this trigger and is therefore a CALLING role
-- of the trigger function. Only service_role writes today; `authenticated` is granted too so
-- an in-app write path added later cannot reproduce the fn_recompute_batch_state outage.
grant execute on function public.fn_touch_product_grade() to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- fn_product_grade_fingerprint — the SQL CHECK COPY of the rename evidence
-- ---------------------------------------------------------------------------
-- THE ONE DEFINITION LIVES IN THE WORKER (workers/sync/src/lib/productFingerprint.ts),
-- because that is where the sheet is read and the payload is built. This function
-- rebuilds the identical canonical string from the identical jsonb payload and hashes it
-- the same way, so the two can be PROVEN equal rather than assumed equal — the same
-- discipline as lib/sync/portable-hash.ts vs node:crypto.
--
-- Canonical string (LF-joined):
--   v1
--   O|<STAGE>=<flecs>            one per opening, sorted by stage in C collation
--   R|<date>|<STAGE>|<flec>|<kg> one per ledger row, IN PAYLOAD ORDER (sheet order)
-- A null kg contributes an EMPTY field, never "0" — the NULL != 0 rule reaches even here.
-- Numbers are rendered by jsonb's own numeric text output, which matches JSON.stringify()
-- for every value the worker can emit (a JS number never serialises a trailing zero).
create or replace function public.fn_product_grade_fingerprint(p_payload jsonb)
returns text
language sql
immutable
security invoker
set search_path = public
as $$
  with parts as (
    select 'v' || coalesce(p_payload->>'v', '1') as line, 0 as grp, 0 as ord
    union all
    select 'O|' || (e->>'stage') || '=' || coalesce(e->>'flecs', ''), 1,
           row_number() over (order by (e->>'stage') collate "C")::int
      from jsonb_array_elements(coalesce(p_payload->'openings', '[]'::jsonb)) e
    union all
    select 'R|' || coalesce(e->>'d','') || '|' || coalesce(e->>'s','') || '|'
                || coalesce(e->>'f','') || '|' || coalesce(e->>'kg',''), 2, ord::int
      from jsonb_array_elements(coalesce(p_payload->'rows', '[]'::jsonb))
           with ordinality as t(e, ord)
  )
  select encode(sha256(convert_to(string_agg(line, E'\n' order by grp, ord), 'UTF8')), 'hex')
    from parts;
$$;

comment on function public.fn_product_grade_fingerprint(jsonb) is
  'SQL check copy of the product-grade content fingerprint. The authoritative implementation '
  'is the worker''s productFingerprint.ts; this exists so the two can be proven identical. '
  'Never write a fingerprint from here without the worker having produced the same string.';

revoke execute on function public.fn_product_grade_fingerprint(jsonb) from public;
revoke execute on function public.fn_product_grade_fingerprint(jsonb) from anon;
grant execute on function public.fn_product_grade_fingerprint(jsonb) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- fn_upsert_product_grade — create or refresh one grade's header
-- ---------------------------------------------------------------------------
create or replace function public.fn_upsert_product_grade(
  p_sheet_name    text,
  p_thresholds    jsonb default '{}'::jsonb,
  p_opening_as_of date  default null,
  p_fingerprint   text  default null
)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_code    text;
  v_id      uuid;
  v_created boolean := false;
begin
  if p_sheet_name is null or btrim(p_sheet_name) = '' then
    return jsonb_build_object('ok', false, 'reason', 'blank_sheet_name',
      'message', 'A product grade needs a sheet name.');
  end if;

  v_code := upper(btrim(regexp_replace(p_sheet_name, '\s+', ' ', 'g')));

  select id into v_id from public.product_grades where code = v_code;

  if v_id is null then
    insert into public.product_grades
      (code, sheet_name, display_name, thresholds, opening_as_of, content_fingerprint, sort_order)
    values
      (v_code, btrim(p_sheet_name), btrim(p_sheet_name),
       coalesce(p_thresholds, '{}'::jsonb), p_opening_as_of, p_fingerprint,
       coalesce((select max(sort_order) from public.product_grades), 0) + 10)
    returning id into v_id;
    v_created := true;
  else
    -- `display_name` is deliberately NOT overwritten: it is the one field a human may
    -- one day set, and a sync must never quietly undo a person's edit.
    update public.product_grades
       set sheet_name          = btrim(p_sheet_name),
           thresholds          = coalesce(p_thresholds, thresholds),
           opening_as_of       = coalesce(p_opening_as_of, opening_as_of),
           content_fingerprint = coalesce(p_fingerprint, content_fingerprint),
           last_seen_at        = now()
     where id = v_id;
  end if;

  return jsonb_build_object('ok', true, 'grade_id', v_id, 'code', v_code, 'created', v_created);
end;
$$;

comment on function public.fn_upsert_product_grade(text, jsonb, date, text) is
  'Create or refresh one product grade from its sheet tab. Keyed on the CANONICAL code. '
  'Never touches display_name after creation, and never deactivates anything.';

-- ---------------------------------------------------------------------------
-- fn_rename_product_grade — a tab was renamed; keep the id, move the name
-- ---------------------------------------------------------------------------
create or replace function public.fn_rename_product_grade(
  p_grade_id       uuid,
  p_new_sheet_name text
)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_old_sheet text;
  v_old_code  text;
  v_new_code  text;
  v_clash     text;
begin
  if p_new_sheet_name is null or btrim(p_new_sheet_name) = '' then
    return jsonb_build_object('ok', false, 'reason', 'blank_sheet_name',
      'message', 'A renamed product grade still needs a sheet name.');
  end if;

  select sheet_name, code into v_old_sheet, v_old_code
    from public.product_grades where id = p_grade_id;
  if v_old_sheet is null then
    return jsonb_build_object('ok', false, 'reason', 'unknown_grade',
      'message', 'No product grade with that id.');
  end if;

  v_new_code := upper(btrim(regexp_replace(p_new_sheet_name, '\s+', ' ', 'g')));

  if v_new_code = v_old_code then
    -- Not a rename in the sense that matters (the canonical identity did not move);
    -- just record the new spelling.
    update public.product_grades
       set sheet_name = btrim(p_new_sheet_name), last_seen_at = now()
     where id = p_grade_id;
    return jsonb_build_object('ok', true, 'grade_id', p_grade_id, 'code', v_new_code,
                              'renamed', false, 'reason', 'same_canonical_code');
  end if;

  select code into v_clash from public.product_grades
   where code = v_new_code and id <> p_grade_id;
  if v_clash is not null then
    return jsonb_build_object('ok', false, 'reason', 'code_taken', 'code', v_clash,
      'message', format('Another product grade is already called %s.', v_clash));
  end if;

  update public.product_grades
     set code         = v_new_code,
         sheet_name   = btrim(p_new_sheet_name),
         aliases      = case when v_old_sheet = any(aliases) then aliases
                             else aliases || v_old_sheet end,
         last_seen_at = now()
   where id = p_grade_id;

  return jsonb_build_object('ok', true, 'grade_id', p_grade_id, 'code', v_new_code,
                            'renamed', true, 'previous_code', v_old_code,
                            'previous_sheet_name', v_old_sheet);
end;
$$;

comment on function public.fn_rename_product_grade(uuid, text) is
  'A tab was renamed: keep the grade''s id (and therefore every movement already filed '
  'against it) and move its name, appending the former sheet name to `aliases`. Refuses a '
  'name already taken by another grade rather than merging two products silently.';

-- ---------------------------------------------------------------------------
-- fn_replace_product_grade — REPLACE-BY-GRADE, in ONE transaction
-- ---------------------------------------------------------------------------
-- The sheet is CUMULATIVE (every movement since the tab was opened is always present),
-- so the honest write model is "make the DB say exactly what the tab says". Keyed on
-- `row_hash`: a row already present is LEFT UNTOUCHED (not re-written), a row no longer
-- in the tab is deleted, a row not yet present is inserted. An unchanged tab therefore
-- writes literally nothing and returns {inserted:0, deleted:0} — which is what makes a
-- second run of the same sheet provably a no-op.
create or replace function public.fn_replace_product_grade(
  p_grade_id  uuid,
  p_openings  jsonb default '[]'::jsonb,
  p_movements jsonb default '[]'::jsonb
)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_inserted  integer := 0;
  v_deleted   integer := 0;
  v_unchanged integer := 0;
  v_open_del  integer := 0;
  v_open_ins  integer := 0;
begin
  if not exists (select 1 from public.product_grades where id = p_grade_id) then
    return jsonb_build_object('ok', false, 'reason', 'unknown_grade',
      'message', 'No product grade with that id.');
  end if;

  -- ── openings: tiny and wholly restated by the tab, so replace outright ──
  with incoming as (
    select upper(btrim(regexp_replace(e->>'stage', '\s+', ' ', 'g'))) as stage,
           (e->>'flecs')::integer as flecs,
           nullif(e->>'as_of','')::date as as_of
      from jsonb_array_elements(coalesce(p_openings, '[]'::jsonb)) e
     where btrim(coalesce(e->>'stage','')) <> ''
  ), del as (
    delete from public.product_grade_openings o
     where o.grade_id = p_grade_id
       and not exists (select 1 from incoming i where i.stage = o.stage)
    returning 1
  )
  select count(*) into v_open_del from del;

  with incoming as (
    select upper(btrim(regexp_replace(e->>'stage', '\s+', ' ', 'g'))) as stage,
           (e->>'flecs')::integer as flecs,
           nullif(e->>'as_of','')::date as as_of
      from jsonb_array_elements(coalesce(p_openings, '[]'::jsonb)) e
     where btrim(coalesce(e->>'stage','')) <> ''
  ), ins as (
    insert into public.product_grade_openings (grade_id, stage, flecs, as_of)
    select p_grade_id, i.stage, i.flecs, i.as_of from incoming i
    on conflict (grade_id, stage) do update
       set flecs = excluded.flecs, as_of = excluded.as_of
    returning 1
  )
  select count(*) into v_open_ins from ins;

  -- ── movements: delete what the tab no longer says ──
  with incoming as (
    select distinct e->>'row_hash' as row_hash
      from jsonb_array_elements(coalesce(p_movements, '[]'::jsonb)) e
  ), del as (
    delete from public.product_movements m
     where m.grade_id = p_grade_id
       and not exists (select 1 from incoming i where i.row_hash = m.row_hash)
    returning 1
  )
  select count(*) into v_deleted from del;

  -- ── movements: insert what is not yet there; touch nothing that is ──
  with incoming as (
    select e->>'row_hash'                        as row_hash,
           (e->>'transaction_date')::date        as transaction_date,
           upper(btrim(regexp_replace(e->>'stage', '\s+', ' ', 'g'))) as stage,
           (e->>'flec_delta')::integer           as flec_delta,
           nullif(e->>'kg_delta','')::numeric    as kg_delta,
           nullif(e->>'remarks','')              as remarks,
           (e->>'source_row')::integer           as source_row,
           e->'sheet_running'                    as sheet_running
      from jsonb_array_elements(coalesce(p_movements, '[]'::jsonb)) e
  ), ins as (
    insert into public.product_movements
      (grade_id, transaction_date, stage, flec_delta, kg_delta, remarks,
       source_row, row_hash, sheet_running)
    select p_grade_id, i.transaction_date, i.stage, i.flec_delta, i.kg_delta, i.remarks,
           i.source_row, i.row_hash, i.sheet_running
      from incoming i
    on conflict (grade_id, row_hash) do nothing
    returning 1
  )
  select count(*) into v_inserted from ins;

  v_unchanged := jsonb_array_length(coalesce(p_movements, '[]'::jsonb)) - v_inserted;

  return jsonb_build_object(
    'ok', true, 'grade_id', p_grade_id,
    'inserted', v_inserted, 'deleted', v_deleted, 'unchanged', v_unchanged,
    'openings_written', v_open_ins, 'openings_removed', v_open_del
  );
end;
$$;

comment on function public.fn_replace_product_grade(uuid, jsonb, jsonb) is
  'REPLACE-BY-GRADE in one transaction, keyed on row_hash: rows the tab no longer carries '
  'are deleted, rows not yet present are inserted, rows already present are left untouched. '
  'A re-run of an unchanged tab returns {inserted:0, deleted:0} and writes nothing.';

revoke execute on function public.fn_upsert_product_grade(text, jsonb, date, text) from public;
revoke execute on function public.fn_upsert_product_grade(text, jsonb, date, text) from anon;
grant execute on function public.fn_upsert_product_grade(text, jsonb, date, text) to service_role;

revoke execute on function public.fn_rename_product_grade(uuid, text) from public;
revoke execute on function public.fn_rename_product_grade(uuid, text) from anon;
grant execute on function public.fn_rename_product_grade(uuid, text) to service_role;

revoke execute on function public.fn_replace_product_grade(uuid, jsonb, jsonb) from public;
revoke execute on function public.fn_replace_product_grade(uuid, jsonb, jsonb) from anon;
grant execute on function public.fn_replace_product_grade(uuid, jsonb, jsonb) to service_role;

-- ---------------------------------------------------------------------------
-- view_product_stage_balance — THE balance definition: opening + SUM(flec_delta)
-- ---------------------------------------------------------------------------
create or replace view public.view_product_stage_balance
with (security_invoker = true) as
with stage_universe as (
  select grade_id, stage from public.product_grade_openings
  union
  select grade_id, stage from public.product_movements
),
mv as (
  select grade_id,
         stage,
         sum(flec_delta)::bigint                            as movement_flecs,
         sum(kg_delta)                                      as movement_kg,
         count(*)::bigint                                   as movement_count,
         count(*) filter (where kg_delta is null)::bigint   as movements_missing_kg,
         min(transaction_date)                              as first_movement_date,
         max(transaction_date)                              as last_movement_date
    from public.product_movements
   group by 1, 2
)
select g.id                                      as grade_id,
       g.code                                    as grade_code,
       g.sheet_name,
       g.display_name,
       g.active,
       g.sort_order,
       u.stage,
       coalesce(o.flecs, 0)::bigint              as opening_flecs,
       o.as_of                                   as opening_as_of,
       coalesce(mv.movement_flecs, 0)::bigint    as movement_flecs,
       (coalesce(o.flecs, 0) + coalesce(mv.movement_flecs, 0))::bigint as balance_flecs,
       mv.movement_kg,
       coalesce(mv.movement_count, 0)::bigint    as movement_count,
       coalesce(mv.movements_missing_kg, 0)::bigint as movements_missing_kg,
       mv.first_movement_date,
       mv.last_movement_date
  from stage_universe u
  join public.product_grades g on g.id = u.grade_id
  left join public.product_grade_openings o
         on o.grade_id = u.grade_id and o.stage = u.stage
  left join mv on mv.grade_id = u.grade_id and mv.stage = u.stage;

comment on view public.view_product_stage_balance is
  'One row per (product grade x stage). THE definition of a product balance: '
  '`opening_flecs + SUM(flec_delta)`. PROVEN on all five grades to reproduce the sheet''s '
  'own header-block counts exactly (8X50 FINAL 59; 6X50 PROD 157 / AYAG 3 / MAGNET 25 / '
  'FINAL 187; 2X6 FINAL 65 / BLENDED 20; Kuraray OLD PROD 110 / FINAL 36; 4X8 FINAL 35). '
  'The stage universe is openings UNION movements, so a stage that only ever opened, or '
  'only ever moved, still appears. NO PESO COLUMN AND NONE DERIVABLE.';

-- ---------------------------------------------------------------------------
-- view_product_onhand — one row per grade: what we have, in flecs, kg and tons
-- ---------------------------------------------------------------------------
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
       g.updated_at
  from public.product_grades g
  left join bal b  on b.grade_id  = g.id
  left join rate r on r.grade_id  = g.id
  left join rate_variants rv on rv.grade_id = g.id;

comment on view public.view_product_onhand is
  'One row per product grade — the summary Renzo asked for: grade, flecs per stage, kg per '
  'flec, and total volume on hand in tons. `vans_ready` = FINAL / 44 (the sheet''s own VANS '
  'READY SHIP OUT formula, reproduced exactly on all five grades). `total_kg` is '
  'total_flecs x kg_per_flec and is NULL — never 0 — for a grade whose ledger states no '
  'usable ratio, because "we do not know the fill" and "it weighs nothing" are different '
  'answers. Includes INACTIVE grades; filter on `active` at the call site. '
  'NO PESO COLUMN AND NONE DERIVABLE — safe for every role including Production.';

-- ---------------------------------------------------------------------------
-- view_product_ledger — the running tally, computed IN SQL
-- ---------------------------------------------------------------------------
-- The app must never recompute a running balance in TypeScript. The fold is a set of
-- conditional window sums over the grade's rows ordered by (transaction_date, source_row)
-- — one pass, every stage's balance as of every row, exactly the way the sheet's own
-- columns read. `sheet_running` rides alongside so a disagreement can be SHOWN
-- (`agrees_with_sheet`), and is never an input.
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
         sum(m.kg_delta) over win                                                                             as running_kg
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
       end as agrees_with_sheet
  from c;

comment on view public.view_product_ledger is
  'Every product movement with the running balance of EVERY stage as of that row, computed '
  'in SQL (conditional window sums ordered by transaction_date, source_row). This is the '
  '"running tally as seen in the google sheet" — the app must never recompute it. '
  '`sheet_running` is the sheet''s own figure kept for cross-check and `agrees_with_sheet` '
  'is the comparison; neither is ever an input to the computed balance. '
  'NO PESO COLUMN AND NONE DERIVABLE.';

-- ---------------------------------------------------------------------------
-- view_product_portfolio — one row: the whole finished-goods position
-- ---------------------------------------------------------------------------
create or replace view public.view_product_portfolio
with (security_invoker = true) as
select count(*)::int                                            as grade_count,
       count(*) filter (where active)::int                      as active_grade_count,
       coalesce(sum(total_flecs) filter (where active), 0)::bigint  as total_flecs,
       coalesce(sum(final_flecs) filter (where active), 0)::bigint  as final_flecs,
       sum(total_kg)  filter (where active)                      as total_kg,
       round(sum(total_kg) filter (where active) / 1000.0, 3)     as total_tons,
       sum(final_kg)  filter (where active)                      as final_kg,
       round(sum(final_kg) filter (where active) / 1000.0, 3)     as final_tons,
       round(coalesce(sum(final_flecs) filter (where active), 0)::numeric / 44.0, 4) as vans_ready,
       count(*) filter (where active and kg_per_flec is null)::int as grades_without_rate,
       coalesce(sum(movement_count) filter (where active), 0)::bigint as movement_count,
       max(last_movement_date) filter (where active)             as last_movement_date
  from public.view_product_onhand;

comment on view public.view_product_portfolio is
  'ONE row: the whole finished-product position across ACTIVE grades — total tons, total '
  'flecs, FINAL flecs and vans ready. `grades_without_rate` says how many active grades '
  'could not be valued in kilos, so a tonnage is never quietly short. '
  'NO PESO COLUMN AND NONE DERIVABLE.';

-- ---------------------------------------------------------------------------
-- RLS + grants
-- ---------------------------------------------------------------------------
alter table public.product_grades          enable row level security;
alter table public.product_grade_openings  enable row level security;
alter table public.product_movements       enable row level security;

drop policy if exists product_grades_select on public.product_grades;
create policy product_grades_select on public.product_grades
  for select to authenticated using (true);

drop policy if exists product_grade_openings_select on public.product_grade_openings;
create policy product_grade_openings_select on public.product_grade_openings
  for select to authenticated using (true);

drop policy if exists product_movements_select on public.product_movements;
create policy product_movements_select on public.product_movements
  for select to authenticated using (true);

-- `authenticated` reads only. Every write goes through the three service_role RPCs, so
-- there is deliberately no INSERT/UPDATE/DELETE policy and no such grant for a client role.
revoke all on public.product_grades         from anon;
revoke all on public.product_grade_openings from anon;
revoke all on public.product_movements      from anon;

grant select on public.product_grades         to authenticated;
grant select on public.product_grade_openings to authenticated;
grant select on public.product_movements      to authenticated;

-- The sync worker is the sole writer (service_role bypasses RLS but still needs the
-- table-level privilege). It also READS product_grades + product_movements to classify.
grant select, insert, update, delete on public.product_grades         to service_role;
grant select, insert, update, delete on public.product_grade_openings to service_role;
grant select, insert, update, delete on public.product_movements      to service_role;

revoke all on public.view_product_stage_balance from anon;
revoke all on public.view_product_onhand        from anon;
revoke all on public.view_product_ledger        from anon;
revoke all on public.view_product_portfolio     from anon;

grant select on public.view_product_stage_balance to authenticated;
grant select on public.view_product_onhand        to authenticated;
grant select on public.view_product_ledger        to authenticated;
grant select on public.view_product_portfolio     to authenticated;
-- Deliberately NOT granted to service_role: the worker reads the base TABLES, never these
-- views (L-044's arrow direction — a consumer is not a dependency). If a worker read is
-- ever added, grant the whole security_invoker closure, not just the view named.
