-- flecon_bag_date_settlements — the DATE-SETTLEMENT LEDGER for the FLECON bag sync
-- (2026-07-29). Direct sibling of `rc_out_date_settlements` (migration
-- 20260712010000): once a `transaction_date` is SETTLED, every future flecon sync run
-- SKIPS it entirely — no extract-compare, no classify, no REPLACE-BY-DATE, and
-- critically NO DELETE.
--
-- WHY flecon needs its own ledger (BUG-015 follow-up):
--   Ivy's "JANUARY 2026" tab carries an operator year-typo in cell A75 — it reads
--   2025-01-31 (rows 76-79 inherit it by date carry-forward). Five real movements
--   (ECOPACK_BEIGE +100, ZAMBOANGA_BAG +128/-1, KOREA_WHITE_SUNDRY +18/-14) therefore
--   fall outside the extractor's window and are correctly refused every run. They were
--   HAND-BACKFILLED on 2026-07-27 into transaction_date = 2026-01-31 (source_row 75-79)
--   under audit log a6293bf8-26b2-4207-98a4-6134f0f08fb7, and Renzo decided NOT to have
--   the source cell corrected — the present-day totals are already accurate.
--
--   That backfill survives today only because the sync's `since` window never reaches
--   January. A watermark reset would re-run from 2026-01-01, the extractor would again
--   refuse the mis-dated rows, and REPLACE-BY-DATE would DELETE the backfill. This
--   ledger closes that hole: the human arbitration becomes a DB fact, not an accident of
--   window arithmetic.
--
-- DIFFERENCE FROM rc_out's ledger (deliberate): rc_out settles on TWO automated
-- witnesses agreeing (DB sum vs the RC MOVEMENT sheet). flecon is SINGLE-SOURCE — there
-- is no independent second witness per date — so a flecon settlement is always an
-- ARBITRATION, recorded as such. The corroboration columns therefore capture what the DB
-- itself holds at settlement time (row count + net qty) plus a pointer to the arbitration
-- record in `audit_logs`. The sync worker settles automatically ONLY in the one narrowly
-- verifiable case: the sheet's out-of-year rows already exist in the DB, movement for
-- movement, under the tab's own year (see workers/sync/src/reports/flecon/settlement.ts
-- ::computeFleconSettlements) — i.e. the arbitration provably already happened.
--
-- Written EXCLUSIVELY by the sync worker (service role) — see
-- workers/sync/src/reports/flecon/index.ts::runReport → DbClient.insertFleconSettlements.
-- Never written by classify.ts (parity-frozen).
--
-- RLS discipline copied verbatim from 20260712010000_rc_out_date_settlements.sql: RLS on,
-- authenticated may only SELECT, no write policy for authenticated/anon — the service
-- role (which bypasses RLS) is the sole writer. anon is explicitly revoked.
--
-- Idempotent throughout (create table/index if not exists, DO-block for the policy,
-- ON CONFLICT DO NOTHING seed) so a re-apply is safe.

create table if not exists public.flecon_bag_date_settlements (
  transaction_date        date primary key,

  -- What the DB itself held for this date at settlement time. Kept for audit/debugging —
  -- NOT re-checked on every run; settlement is a one-way ratchet (a later correction
  -- needs a manual DELETE from this table, same accepted edge case as rc_out's ledger).
  db_movement_count       integer not null,
  db_net_qty              integer not null,

  -- Why this date was settled. 'human_arbitrated_backfill' = the rows were placed by a
  -- person and must be protected from the sync's replace-by-date.
  reason                  text not null default 'human_arbitrated_backfill',

  settled_at              timestamptz not null default now(),

  -- Which run settled this date. ON DELETE SET NULL — a pruned/expired sync_runs row must
  -- never cascade-delete a settlement (the settlement's own facts stand alone). Same FK
  -- behavior as rc_out_date_settlements.settled_by_run_id.
  settled_by_run_id       uuid references public.sync_runs (id) on delete set null,

  -- The arbitration record: the audit_logs row documenting the human decision. Same
  -- ON DELETE SET NULL rationale — losing the audit row must not un-settle the date.
  settled_by_audit_log_id uuid references public.audit_logs (id) on delete set null,

  note                    text
);

comment on table public.flecon_bag_date_settlements is
  'Date-settlement ledger for the FLECON bag sync (2026-07-29), sibling of rc_out_date_settlements. A transaction_date present here has been arbitrated by a human (or provably already reconciled) — the sync worker skips that date entirely on every future run: no extract-compare, no classify, no REPLACE-BY-DATE, and NO DELETE. Written only by workers/sync/src/reports/flecon/index.ts::runReport (service role).';
comment on column public.flecon_bag_date_settlements.db_movement_count is
  'COUNT(flecon_bag_movements) for this date at the moment of settlement.';
comment on column public.flecon_bag_date_settlements.db_net_qty is
  'SUM(flecon_bag_movements.qty_delta) for this date at the moment of settlement.';
comment on column public.flecon_bag_date_settlements.reason is
  'Why the date was settled. ''human_arbitrated_backfill'' = rows placed by a person that the sync must never replace or delete.';
comment on column public.flecon_bag_date_settlements.settled_by_run_id is
  'sync_runs.id of the run that settled this date (NULL for a migration/manual seed). ON DELETE SET NULL so a pruned run row never cascades into un-settling a date.';
comment on column public.flecon_bag_date_settlements.settled_by_audit_log_id is
  'audit_logs.id of the arbitration record (e.g. the hand-backfill). ON DELETE SET NULL — losing the audit row must not un-settle the date.';

create index if not exists idx_flecon_bag_date_settlements_settled_at
  on public.flecon_bag_date_settlements (settled_at desc);

-- ---------------------------------------------------------------------------
-- RLS — authenticated SELECT only; INSERT/UPDATE/DELETE only service_role.
-- ---------------------------------------------------------------------------
alter table public.flecon_bag_date_settlements enable row level security;

grant select on public.flecon_bag_date_settlements to authenticated;
grant all on public.flecon_bag_date_settlements to service_role;
revoke all on public.flecon_bag_date_settlements from anon;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'flecon_bag_date_settlements'
      and policyname = 'flecon_bag_date_settlements_select_authenticated'
  ) then
    create policy flecon_bag_date_settlements_select_authenticated
      on public.flecon_bag_date_settlements for select to authenticated using (true);
  end if;
end$$;

-- ---------------------------------------------------------------------------
-- SEED — 2026-01-31, the hand-backfilled A75 year-typo rows (BUG-015 defect A).
-- Corroboration is read from the live table so the numbers are true at apply time.
-- The audit-log pointer is a scalar subselect so the seed still applies (as NULL) on a
-- database that does not carry that audit row.
-- ---------------------------------------------------------------------------
insert into public.flecon_bag_date_settlements (
  transaction_date, db_movement_count, db_net_qty, reason, settled_by_audit_log_id, note
)
select
  '2026-01-31'::date,
  count(*)::int,
  coalesce(sum(m.qty_delta), 0)::int,
  'human_arbitrated_backfill',
  (select a.id from public.audit_logs a where a.id = 'a6293bf8-26b2-4207-98a4-6134f0f08fb7'::uuid),
  'Sheet rows 75-79 of the FLECON BAG MOVEMENT "JANUARY 2026" tab carry the date typo 2025-01-31 (cell A75; 76-79 inherit it by carry-forward). Those five movements were hand-backfilled to 2026-01-31 on 2026-07-27. Renzo decided NOT to correct the source cell, so this date is settled: the sync must never re-extract, re-classify or replace it.'
from public.flecon_bag_movements m
where m.transaction_date = '2026-01-31'::date
having count(*) > 0
on conflict (transaction_date) do nothing;
