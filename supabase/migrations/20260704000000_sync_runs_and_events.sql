-- sync_runs + sync_run_events — the durable "Run Sync" job ledger and live progress
-- feed for the TypeScript/DBOS sync worker (SYNC_TS_MIGRATION_PLAN M0).
--
-- These tables are what the dashboard modal watches over Supabase Realtime, replacing
-- the old stderr-NDJSON + SSE stream. The WORKER writes them with the service role;
-- authenticated app users may only READ. Write policies are service-role-only — NO
-- always-true write policy (Phase-4 RLS discipline: the network response and the
-- write path are both locked down; a browser client can never INSERT/UPDATE a run).
--
-- Idempotent where sensible (IF NOT EXISTS / DO blocks) so a re-apply is safe.

-- ---------------------------------------------------------------------------
-- status enum
-- ---------------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_type where typname = 'sync_run_status') then
    create type public.sync_run_status as enum
      ('queued', 'running', 'succeeded', 'failed', 'partial');
  end if;
end$$;

-- ---------------------------------------------------------------------------
-- sync_runs — one row per "Run Sync" click
-- ---------------------------------------------------------------------------
create table if not exists public.sync_runs (
  id            uuid primary key default gen_random_uuid(),
  requested_by  uuid references auth.users (id) on delete set null,
  status        public.sync_run_status not null default 'queued',
  started_at    timestamptz,
  finished_at   timestamptz,
  result        jsonb,
  error         text,
  created_at    timestamptz not null default now()
);

comment on table public.sync_runs is
  'Durable ledger of Run Sync jobs. Written by the DBOS sync worker (service role); read-only for app users.';

create index if not exists idx_sync_runs_created_at on public.sync_runs (created_at desc);
create index if not exists idx_sync_runs_status on public.sync_runs (status);

-- ---------------------------------------------------------------------------
-- sync_run_events — the live progress feed (digestible-language events)
-- ---------------------------------------------------------------------------
create table if not exists public.sync_run_events (
  id           bigint generated always as identity primary key,
  run_id       uuid not null references public.sync_runs (id) on delete cascade,
  report_type  text,
  stage        text,          -- fetch | extract | classify | apply | reconcile | finalize
  pct          int,           -- 0-100, monotonic per (run_id, report_type)
  label        text,          -- plain-English activity (SYNC_CLI_CONTRACT digestibility rules)
  detail       text,
  level        text,          -- info | warn
  at           timestamptz not null default now()
);

comment on table public.sync_run_events is
  'Live progress events for a sync run (Supabase Realtime source for the modal). Service-role write, authenticated read.';

create index if not exists idx_sync_run_events_run_id on public.sync_run_events (run_id, at);

-- ---------------------------------------------------------------------------
-- RLS — authenticated SELECT; INSERT/UPDATE only service_role.
-- The service role BYPASSES RLS entirely, so we deliberately create NO write
-- policy for authenticated/anon: with RLS enabled and no permissive write policy,
-- every non-service-role write is denied. That is the Phase-4 discipline — no
-- always-true policy that a compromised anon/authenticated client could ride.
-- ---------------------------------------------------------------------------
alter table public.sync_runs enable row level security;
alter table public.sync_run_events enable row level security;

-- Base-table GRANTS (defense in depth, stronger than the app's other tables):
-- authenticated gets SELECT ONLY at the privilege layer — so even setting an
-- always-true write policy later could not let a browser client write. service_role
-- gets full DML (and bypasses RLS anyway). anon gets nothing.
grant select on public.sync_runs to authenticated;
grant select on public.sync_run_events to authenticated;
grant all on public.sync_runs to service_role;
grant all on public.sync_run_events to service_role;
grant usage, select on all sequences in schema public to service_role;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname='public' and tablename='sync_runs' and policyname='sync_runs_select_authenticated'
  ) then
    create policy sync_runs_select_authenticated
      on public.sync_runs for select to authenticated using (true);
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname='public' and tablename='sync_run_events' and policyname='sync_run_events_select_authenticated'
  ) then
    create policy sync_run_events_select_authenticated
      on public.sync_run_events for select to authenticated using (true);
  end if;
end$$;

-- ---------------------------------------------------------------------------
-- Realtime — publish both tables so the dashboard modal can subscribe.
-- (supabase_realtime is the default publication; adding a table is idempotent-guarded.)
-- ---------------------------------------------------------------------------
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname='supabase_realtime' and schemaname='public' and tablename='sync_run_events'
  ) then
    alter publication supabase_realtime add table public.sync_run_events;
  end if;

  if not exists (
    select 1 from pg_publication_tables
    where pubname='supabase_realtime' and schemaname='public' and tablename='sync_runs'
  ) then
    alter publication supabase_realtime add table public.sync_runs;
  end if;
end$$;
