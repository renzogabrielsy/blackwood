-- rc_out_date_settlements — the DATE-SETTLEMENT LEDGER for the rc_out sync
-- (Renzo's directive, 2026-07-12). Once a transaction_date's DB feeding total agrees
-- with the RC MOVEMENT sheet's daily total (two independent witnesses within the
-- existing 50kg tolerance), that date is SETTLED and every future sync run SKIPS it
-- entirely — no extract-compare, no classify, no reconcile, no gate, no flags. This
-- kills the endless re-ingestion of already-balanced past months: the PROPOSED
-- workbook permanently carries every day-tab the operator has ever filled in, and
-- without this ledger every run re-walks that entire history through both HARD gates.
--
-- Written EXCLUSIVELY by the sync worker's orchestration layer (service role) — see
-- workers/sync/src/workflows/runSync.ts::persistSettlements. Never written by
-- classify.ts (parity-frozen) and never written by the read-only rc_movement_audit
-- report (which stays "never writes to the DB").
--
-- RLS discipline copied verbatim from 20260704000000_sync_runs_and_events.sql /
-- 20260706120000_smart_adjudicator_cases.sql: RLS on, authenticated may only SELECT
-- (an always-true SELECT policy), no write policy for authenticated/anon — the
-- service role (which bypasses RLS) is the sole writer. anon is explicitly revoked
-- for defense in depth.
--
-- Idempotent throughout (create table/index if not exists, DO-blocks for policies)
-- so a re-apply is safe.

create table if not exists public.rc_out_date_settlements (
  transaction_date   date primary key,

  -- The two witnesses that agreed at settlement time (kg). Kept for audit/debugging —
  -- NOT re-checked on every run; settlement is a one-way ratchet (see CONTEXT.md for
  -- the accepted edge case where a late-arriving correction would need a manual delete).
  db_sum_kg          numeric not null,
  movement_kg        numeric not null,

  settled_at         timestamptz not null default now(),

  -- Which run settled this date. ON DELETE SET NULL — a pruned/expired sync_runs row
  -- must never cascade-delete a settlement (the settlement's own facts stand alone).
  settled_by_run_id  uuid references public.sync_runs (id) on delete set null
);

comment on table public.rc_out_date_settlements is
  'Date-settlement ledger for rc_out (2026-07-12, Renzo''s directive). A transaction_date present here has its DB feeding total independently corroborated by the RC MOVEMENT sheet within tolerance (50kg) — the sync worker skips that date entirely on every future run (no extract-compare/classify/reconcile/gate/flags). Written only by workers/sync/src/workflows/runSync.ts::persistSettlements (service role).';
comment on column public.rc_out_date_settlements.db_sum_kg is
  'SUM(rc_out.weight_kg) for this date at the moment of settlement.';
comment on column public.rc_out_date_settlements.movement_kg is
  'RC MOVEMENT sheet''s date_to_fed_kls total for this date at the moment of settlement.';
comment on column public.rc_out_date_settlements.settled_by_run_id is
  'sync_runs.id of the run that settled this date. Nullable — ON DELETE SET NULL so a pruned run row never cascades into un-settling a date.';

create index if not exists idx_rc_out_date_settlements_settled_at
  on public.rc_out_date_settlements (settled_at desc);

-- ---------------------------------------------------------------------------
-- RLS — authenticated SELECT only; INSERT/UPDATE/DELETE only service_role.
-- ---------------------------------------------------------------------------
alter table public.rc_out_date_settlements enable row level security;

grant select on public.rc_out_date_settlements to authenticated;
grant all on public.rc_out_date_settlements to service_role;
revoke all on public.rc_out_date_settlements from anon;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'rc_out_date_settlements'
      and policyname = 'rc_out_date_settlements_select_authenticated'
  ) then
    create policy rc_out_date_settlements_select_authenticated
      on public.rc_out_date_settlements for select to authenticated using (true);
  end if;
end$$;
