-- smart_adjudicator_cases — the case-persistence SPINE for the Smart Held-Row
-- Adjudicator (P1). A "held row" is a row the daily sync set aside for a human
-- eye. Until now those held rows lived ONLY inside sync_runs.result JSONB and
-- vanished from view once a newer run overwrote the modal. This migration gives
-- each DISTINCT discrepancy a durable identity (a "case") so it can be
-- investigated, discussed in a chat thread, and — once ruled on — remembered as a
-- known issue that pre-annotates future recurrences.
--
-- Three tables:
--   sync_held_cases   — one row per distinct discrepancy (deduped by fingerprint)
--   sync_case_messages — the chat thread + investigation transcript per case
--   sync_case_rulings  — append-only "known issues" ledger of past human rulings
--
-- RLS discipline is COPIED from 20260704000000_sync_runs_and_events.sql: RLS on,
-- authenticated may only SELECT (an always-true SELECT policy), and there is NO
-- write policy for authenticated/anon — the service role (which bypasses RLS)
-- is the sole writer, exactly like sync_runs. The app's server actions write with
-- the admin (service-role) client.
--
-- Idempotent throughout (create … if not exists / DO-blocks for policies +
-- publication) so a re-apply is safe.
--
-- FK ordering note: sync_held_cases.known_ruling_id → sync_case_rulings.id and
-- sync_case_rulings.case_id → sync_held_cases.id form a CIRCULAR reference. We
-- resolve it by creating sync_held_cases WITHOUT known_ruling_id first, then
-- sync_case_rulings, then ADD the known_ruling_id column + FK via ALTER.

-- ---------------------------------------------------------------------------
-- sync_held_cases — one row per DISTINCT discrepancy (deduped by fingerprint).
-- Created first, WITHOUT known_ruling_id (see FK ordering note above).
-- ---------------------------------------------------------------------------
create table if not exists public.sync_held_cases (
  id               uuid primary key default gen_random_uuid(),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),

  -- Stable content hash of the discrepancy (lib/sync/fingerprint.ts). UNIQUE so
  -- the fan-out action can upsert-by-fingerprint. For gate failures the numeric
  -- drift is folded in (a changed discrepancy → new fingerprint → re-alarm); for
  -- row-identity holds only (report_type, kind, natural_key) participate.
  fingerprint      text not null unique,

  report_type      text not null,
  kind             text not null,
  natural_key      text not null,   -- HUMAN label carried from the held row
  reason           text,
  detail           text,

  -- The structured held-row payload (HeldRow.row), incl. drift_dates for gate
  -- failures. NEVER contains a ₱/cost field (price gating).
  row              jsonb,

  -- Provenance: which run first raised this, and the most recent run it recurred in.
  first_run_id     uuid not null references public.sync_runs (id),
  last_run_id      uuid not null references public.sync_runs (id),

  occurrence_count int  not null default 1,
  last_seen_at     timestamptz not null default now(),

  -- Lifecycle. 'open' = untriaged; 'investigating'/'investigated' set by the P2
  -- investigator; 'resolved' once a ruling closes it.
  status           text not null default 'open'
    check (status in ('open', 'investigating', 'investigated', 'resolved')),

  -- Pre-annotation: set when a ledger ruling with the same fingerprint already
  -- exists at creation time (a known issue). The case still opens as 'open' —
  -- pre-annotated, not silenced. FK added via ALTER below (circular ref).

  -- The P3 adjudicator verdict. This migration only CREATES the column; P3 writes it.
  verdict          jsonb
);

comment on table public.sync_held_cases is
  'One durable case per distinct held-row discrepancy (deduped by fingerprint). Written by the sync fan-out server action (service role); read-only for app users.';
comment on column public.sync_held_cases.fingerprint is
  'Stable content hash (lib/sync/fingerprint.ts). Gate failures fold in numeric drift (re-alarm on change); row holds hash (report_type, kind, natural_key) only.';
comment on column public.sync_held_cases.row is
  'Structured held-row payload (HeldRow.row), incl. drift_dates for gate failures. NEVER a ₱/cost field (price gating).';
comment on column public.sync_held_cases.occurrence_count is
  'How many DISTINCT runs have surfaced this same discrepancy. Bumped only when a new run (last_run_id changes) re-raises it.';
comment on column public.sync_held_cases.status is
  'open → investigating → investigated → resolved. A resolved case that recurs stays resolved (quiet-but-visible) — it is not auto-reopened.';
comment on column public.sync_held_cases.verdict is
  'P3 adjudicator verdict. Shape: {verdict: "apply"|"skip"|"needs-human", confidence, summary, citations}. Created here; written by P3.';

create index if not exists idx_sync_held_cases_status   on public.sync_held_cases (status);
create index if not exists idx_sync_held_cases_last_run on public.sync_held_cases (last_run_id);

-- ---------------------------------------------------------------------------
-- sync_case_messages — chat thread + investigation transcript (mirrors the
-- jarvis_messages shape: role / content / tool_calls / tool_results / position).
-- ---------------------------------------------------------------------------
create table if not exists public.sync_case_messages (
  id           uuid primary key default gen_random_uuid(),
  case_id      uuid not null references public.sync_held_cases (id) on delete cascade,
  role         text not null check (role in ('user', 'assistant', 'tool', 'system')),
  content      text not null default '',
  tool_calls   jsonb,
  tool_results jsonb,
  position     int  not null,
  created_at   timestamptz not null default now(),
  unique (case_id, position)
);

comment on table public.sync_case_messages is
  'Ordered chat + investigation transcript per held-row case (mirrors jarvis_messages). Service-role write, authenticated read.';
comment on column public.sync_case_messages.position is
  'Monotonic 0-based order within a case; UNIQUE (case_id, position) enforces a single message per slot.';

create index if not exists idx_sync_case_messages_case on public.sync_case_messages (case_id, position);

-- ---------------------------------------------------------------------------
-- sync_case_rulings — append-only "known issues" ledger. Each row is a past
-- human ruling keyed by fingerprint; a NEW case whose fingerprint matches the
-- latest ruling is pre-annotated (known_ruling_id) at creation.
-- ---------------------------------------------------------------------------
create table if not exists public.sync_case_rulings (
  id              uuid primary key default gen_random_uuid(),
  fingerprint     text not null,
  case_id         uuid references public.sync_held_cases (id),
  action          text not null
    check (action in ('dismiss', 'apply', 'edit_apply', 'override_gate')),
  verdict_summary text not null,   -- plain-language ruling shown to Renzo
  reasoning       text,
  ruled_by        uuid references public.profiles (id),
  ruled_by_email  text,
  created_at      timestamptz not null default now()
);

comment on table public.sync_case_rulings is
  'Append-only ledger of past human rulings, keyed by fingerprint. A new case matching a ruling is pre-annotated (still opens as open, not silenced). Service-role write, authenticated read.';
comment on column public.sync_case_rulings.action is
  'What the human decided: dismiss | apply | edit_apply | override_gate.';

create index if not exists idx_sync_case_rulings_fingerprint on public.sync_case_rulings (fingerprint);

-- ---------------------------------------------------------------------------
-- Resolve the circular FK: add sync_held_cases.known_ruling_id → sync_case_rulings.id
-- now that BOTH tables exist. Guarded so a re-apply is a no-op.
-- ---------------------------------------------------------------------------
do $$
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name = 'sync_held_cases'
      and column_name = 'known_ruling_id'
  ) then
    alter table public.sync_held_cases
      add column known_ruling_id uuid references public.sync_case_rulings (id);
    comment on column public.sync_held_cases.known_ruling_id is
      'Set when a ledger ruling with the same fingerprint existed at creation — the case is pre-annotated (still opens as open, not silenced).';
  end if;
end$$;

-- ---------------------------------------------------------------------------
-- RLS — authenticated SELECT only; INSERT/UPDATE only service_role.
-- Copied verbatim from the 20260704 pattern: RLS on, grant SELECT to
-- authenticated + full DML to service_role (which also bypasses RLS), sequence
-- usage for service_role, and an always-true SELECT policy per table guarded by
-- an if-not-exists on pg_policies. NO write policy for authenticated/anon.
-- ---------------------------------------------------------------------------
alter table public.sync_held_cases    enable row level security;
alter table public.sync_case_messages enable row level security;
alter table public.sync_case_rulings  enable row level security;

grant select on public.sync_held_cases    to authenticated;
grant select on public.sync_case_messages to authenticated;
grant select on public.sync_case_rulings  to authenticated;
grant all on public.sync_held_cases    to service_role;
grant all on public.sync_case_messages to service_role;
grant all on public.sync_case_rulings  to service_role;
grant usage, select on all sequences in schema public to service_role;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname='public' and tablename='sync_held_cases' and policyname='sync_held_cases_select_authenticated'
  ) then
    create policy sync_held_cases_select_authenticated
      on public.sync_held_cases for select to authenticated using (true);
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname='public' and tablename='sync_case_messages' and policyname='sync_case_messages_select_authenticated'
  ) then
    create policy sync_case_messages_select_authenticated
      on public.sync_case_messages for select to authenticated using (true);
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname='public' and tablename='sync_case_rulings' and policyname='sync_case_rulings_select_authenticated'
  ) then
    create policy sync_case_rulings_select_authenticated
      on public.sync_case_rulings for select to authenticated using (true);
  end if;
end$$;

-- ---------------------------------------------------------------------------
-- Realtime — publish cases + messages so the P2/P4 UI can subscribe live.
-- (Rulings are not high-churn UI state; left off the publication.)
-- ---------------------------------------------------------------------------
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname='supabase_realtime' and schemaname='public' and tablename='sync_held_cases'
  ) then
    alter publication supabase_realtime add table public.sync_held_cases;
  end if;

  if not exists (
    select 1 from pg_publication_tables
    where pubname='supabase_realtime' and schemaname='public' and tablename='sync_case_messages'
  ) then
    alter publication supabase_realtime add table public.sync_case_messages;
  end if;
end$$;
