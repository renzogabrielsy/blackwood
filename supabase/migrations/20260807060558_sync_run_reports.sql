-- ============================================================================
-- sync_run_reports — the Excel sync-report artifact ledger (2026-08-07)
--
-- WHY THIS EXISTS. Everything a sync run flags already lands in
-- `sync_runs.result` (the findings channel) and in `sync_run_events` (the
-- progress feed, ~5,600 rows). Both are read by the app panel and both vanish
-- from view the moment the modal closes. Renzo asked for the run's loud things
-- as a WORKBOOK he can open, digest and keep: "After a sync happens we should
-- have the ability to have it generate a report for us in excel form … stored.
-- Just let me click a button to download when i choose to."
--
-- So the worker writes ONE .xlsx per run into private Storage and records it
-- here. This table is the pointer; the workbook is the payload.
--
-- WHY A SIBLING TABLE AND NOT COLUMNS ON `sync_runs`:
--   1. A generation FAILURE is itself a record. `ok=false` + `error` with a NULL
--      `storage_path` is a first-class row here. On `sync_runs` that would mean
--      either six nullable columns describing a thing that isn't the run, or
--      wedging it into `result` — a jsonb the worker writes as ONE atomic blob
--      and that `normalizeReport`/the reducer read under a strict contract.
--   2. Regeneration is append-friendly: a report rebuilt after a code fix adds a
--      row (same deterministic Storage path, so the object is replaced) without
--      rewriting a terminal `sync_runs` row.
--   3. "List the last N reports with a download link" is still ONE cheap query —
--      `view_sync_run_reports` below joins the run metadata in, so callers never
--      write the join themselves.
--
-- WHY A SEPARATE BUCKET FROM `sync-inbox`: same PATTERN (private, service-role
-- only, idempotent insert), different BLAST RADIUS. `sync-inbox` holds the raw
-- source workbooks — Czarina's price file, MC's production report — that no
-- browser may ever fetch. `sync-reports` holds a DERIVED artifact the app
-- deliberately hands to a privileged user through a short-lived signed URL. If
-- those shared one bucket, any future policy opening the report prefix would sit
-- one path segment away from the source files.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Storage bucket — PRIVATE, zero policies.
--
-- Downloads are served by SERVICE-ROLE-MINTED SIGNED URLS only (the app action
-- `getSyncRunReportUrl`). A signed URL is validated by the Storage API's own
-- token check and does NOT consult storage RLS, so no authenticated policy is
-- needed — and creating none means nothing but a signed URL can ever read the
-- object. `public=false` also means the /object/public/ route 400s.
-- ---------------------------------------------------------------------------
insert into storage.buckets (id, name, public)
values ('sync-reports', 'sync-reports', false)
on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- sync_run_reports — one row per generated (or attempted) workbook.
-- ---------------------------------------------------------------------------
create table if not exists public.sync_run_reports (
  id               uuid primary key default gen_random_uuid(),
  run_id           uuid not null references public.sync_runs (id) on delete cascade,

  -- Where the workbook lives. `storage_path` is NULL exactly when ok = false.
  storage_bucket   text not null default 'sync-reports',
  storage_path     text,
  -- The friendly name the download is served as (Content-Disposition), kept
  -- separate from the terse deterministic `storage_path`.
  filename         text,
  bytes            integer,

  -- Headline numbers, so a list screen needs neither the file nor the run jsonb.
  finding_count    integer not null default 0,
  warn_count       integer not null default 0,
  error_count      integer not null default 0,
  -- sheet name -> data row count. Lets a caller say "12 rows on RC OUT" without
  -- opening the workbook.
  sheet_counts     jsonb not null default '{}'::jsonb,

  -- ₱ GATE, ENFORCED IN DATA RATHER THAN IN A COMMENT.
  --
  -- Today's workbook is price-free BY CONSTRUCTION: the finding vocabulary it is
  -- built from carries no ₱ (see app/(app)/sync/types.ts::PriceNote, and
  -- lib/sync/findings.ts::COST_KEY_RE), and the generator additionally strips any
  -- cost-ish key on the way into a cell. The generator therefore writes FALSE
  -- here after that strip ran.
  --
  -- The DEFAULT is TRUE — fail-closed. An artifact written by anything that does
  -- not explicitly assert price-freedom is treated as ₱-bearing, and
  -- `getSyncRunReportUrl` refuses to hand it to a caller for whom
  -- `canViewPrices()` is false. The day someone adds a ₱ column to the workbook,
  -- they stop writing `false`, and the gate engages by itself.
  contains_prices  boolean not null default true,

  -- Provenance + outcome.
  generator_version text,
  ok               boolean not null default true,
  error            text,
  generated_at     timestamptz not null default now()
);

comment on table public.sync_run_reports is
  'Pointer to the .xlsx sync report generated at the end of each run (payload lives in the private sync-reports Storage bucket). Service-role write, authenticated read.';
comment on column public.sync_run_reports.contains_prices is
  'TRUE = the workbook carries ₱ data and may only be downloaded by a role canViewPrices() allows. Defaults TRUE (fail-closed); the generator writes FALSE only after its cost-key strip ran.';
comment on column public.sync_run_reports.storage_path is
  'Deterministic: <Asia/Manila date>/<run_id>.xlsx. NULL exactly when ok = false.';

create index if not exists idx_sync_run_reports_run_id
  on public.sync_run_reports (run_id, generated_at desc);
create index if not exists idx_sync_run_reports_generated_at
  on public.sync_run_reports (generated_at desc);

-- ---------------------------------------------------------------------------
-- RLS + grants — mirrors sync_runs / sync_run_events exactly (Phase-4 posture).
-- authenticated: SELECT only at the PRIVILEGE layer, so even a future
-- always-true write policy could not let a browser client write. anon: nothing.
-- service_role: full DML (and bypasses RLS anyway).
-- ---------------------------------------------------------------------------
alter table public.sync_run_reports enable row level security;

grant select on public.sync_run_reports to authenticated;
grant all on public.sync_run_reports to service_role;
revoke all on public.sync_run_reports from anon;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'sync_run_reports'
      and policyname = 'sync_run_reports_select_authenticated'
  ) then
    create policy sync_run_reports_select_authenticated
      on public.sync_run_reports for select to authenticated using (true);
  end if;
end$$;

-- ---------------------------------------------------------------------------
-- view_sync_run_reports — "the last N reports with a download link", one query.
--
-- security_invoker, so it runs under the caller's RLS (both base tables have a
-- permissive authenticated SELECT policy). `is_latest` marks the newest artifact
-- per run, so a regenerated report is easy to prefer without a window in every
-- caller.
-- ---------------------------------------------------------------------------
create or replace view public.view_sync_run_reports
with (security_invoker = true) as
select
  rep.id                       as report_id,
  rep.run_id,
  r.status                     as run_status,
  r.started_at,
  r.finished_at,
  round(
    extract(epoch from (r.finished_at - r.started_at))::numeric, 1
  )                            as duration_seconds,
  coalesce((r.result -> 'dryRun')::boolean, false) as dry_run,
  r.requested_by,
  rep.storage_bucket,
  rep.storage_path,
  rep.filename,
  rep.bytes,
  rep.finding_count,
  rep.warn_count,
  rep.error_count,
  rep.sheet_counts,
  rep.contains_prices,
  rep.generator_version,
  rep.ok,
  rep.error,
  rep.generated_at,
  (
    rep.generated_at = (
      select max(r2.generated_at)
      from public.sync_run_reports r2
      where r2.run_id = rep.run_id
    )
  )                            as is_latest
from public.sync_run_reports rep
join public.sync_runs r on r.id = rep.run_id;

comment on view public.view_sync_run_reports is
  'One row per generated sync-report workbook, joined to its run (status, timing, dry-run flag). The single query behind "list the last N reports with a download link".';

grant select on public.view_sync_run_reports to authenticated;
revoke all on public.view_sync_run_reports from anon;
