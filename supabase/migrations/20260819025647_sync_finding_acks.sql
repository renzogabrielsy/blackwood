-- ─────────────────────────────────────────────────────────────────────────────────
-- public.sync_finding_acks — THE ACKNOWLEDGEMENT LEDGER for sync findings.
--
-- WHY THIS EXISTS. A real run (312b3213) raised 11 findings. Only SIX of them had any
-- durable record at all (`sync_held_cases`: five `block_diff` + one
-- `cross_batch_reassignment`). The other five — both `delivery_human_edited`, both
-- `price_fuzzy_match` and the blocking grand total — are recomputed from scratch every
-- run and stored NOWHERE. They have no identity, so there is nothing to mark resolved,
-- so the only way to silence one is to change the source data. That is why every one of
-- those notes ends in "please confirm" with no button beside it: the sentence is written
-- for a human and the action lives somewhere else, or nowhere.
--
-- This table is the "somewhere". It gives a human's answer a place to live for the
-- findings that have no case, and it gives the ones that DO have a case the thing cases
-- lack — "quiet until it CHANGES".
--
-- ═══ THE DESIGN DECISION THIS TABLE IS BUILT AROUND ══════════════════════════════
--     THE SYNC NEVER READS THIS LEDGER TO DECIDE WHAT TO REPORT.
-- A finding is still raised, still lands in `sync_runs.result`, and still lands in the
-- Excel workbook, exactly as before. This ledger decides ONLY what the SCREEN shows.
-- Filtering happens at the glass, and that placement is load-bearing twice over:
--   * an old acknowledgement can never suppress a NEW problem — the worker has never
--     heard of it, so there is no path by which an ack silences an alarm at the source;
--   * the workbook and the panel can never disagree about what a run found, because
--     only one of them is filtered and the other is the record.
-- The 2026-08-18 lesson (L-044) is the counter-example this avoids: a read that failed
-- silently made an alarm report "nothing to report" for weeks. Nothing here can do that,
-- because nothing here is on the reporting path.
--
-- ═══ APPEND-ONLY: "CHANGE YOUR MIND" MEANS APPEND A ROW ══════════════════════════
-- The `cenapro.rc_supplier_opening_balance` idiom (20260805130000), itself cloned from
-- `cenapro.warehouse_opening_balance`. Nothing is ever UPDATEd or DELETEd; the CURRENT
-- ack for a fingerprint is the LATEST row, resolved once in
-- `view_sync_finding_acks_current` and never re-derived by a caller. Enforced with TWO
-- INDEPENDENT LOCKS, so a future blanket `GRANT ... ON ALL TABLES IN SCHEMA public`
-- cannot rewrite history on its own:
--   1. no UPDATE/DELETE privilege for any client role, and
--   2. RLS on with SELECT + INSERT policies and NO update or delete policy at all.
-- (A SELECT-only policy — the posture of the audit tables — would be wrong here: those
-- are written by SECURITY DEFINER triggers, whereas this is written by a server action
-- running as `authenticated`. Keeping the PROPERTY rather than the letter.)
--
-- ═══ FINGERPRINT vs CONTENT_HASH — the two strings, and why there are two ════════
--   fingerprint  — WHICH discrepancy this is. Identity only, stable while the numbers
--                  move, so an acknowledgement can still be found next run.
--   content_hash — WHAT it currently says. This is what makes "acknowledged UNTIL IT
--                  CHANGES" work: the same delta stays quiet, a NEW delta re-surfaces.
-- Both are produced by ONE pure function, `lib/sync/findings.ts::findingIdentity`, and
-- for every finding that already has a durable case the fingerprint is that case's OWN
-- fingerprint, byte-identical — not a parallel identity. Neither string ever carries a
-- ₱ value: they are hex digests, and their INPUT is cost-stripped as well.
--
-- ═══ WHAT IS DELIBERATELY NOT HERE ═══════════════════════════════════════════════
-- No `resolved` flag, no status, no link to `sync_held_cases`, no expiry job. An ack is
-- a statement a person made at a moment ("I have seen this, in this state"), not a
-- workflow state — and a fingerprint shared with the case table is a better join than a
-- foreign key that would have to be maintained for the five kinds that have no case.
-- ─────────────────────────────────────────────────────────────────────────────────

-- ═════════════════════════════════════════════════════════════════════════════════
-- 1. THE TABLE (append-only)
-- ═════════════════════════════════════════════════════════════════════════════════
create table if not exists public.sync_finding_acks (
  id            uuid primary key default gen_random_uuid(),

  -- WHICH discrepancy. Shares a namespace with `sync_held_cases.fingerprint` for every
  -- kind that has a case, so the two can be joined without a FK.
  fingerprint   text not null check (btrim(fingerprint) <> ''),

  -- The RunFinding kind, carried for readability and for "show me every price
  -- acknowledgement" — never for identity (that is the fingerprint's whole job).
  kind          text not null check (btrim(kind) <> ''),

  -- WHAT the situation was when the human answered. A finding whose content_hash no
  -- longer matches its latest ack is UNACKNOWLEDGED again; that is the entire mechanism.
  content_hash  text not null check (btrim(content_hash) <> ''),

  -- The three answers a person can give. Deliberately a CHECK and not an enum: adding a
  -- fourth answer must be a reviewed migration, not an `ALTER TYPE ... ADD VALUE` that
  -- cannot run inside a transaction.
  --   acknowledge — "I have seen this and there is nothing to do in the app."
  --   keep_mine   — "my edit is right; the source is the one that is wrong."
  --   same_truck  — "yes, those two differently-spelled rows are the same truckload."
  action        text not null check (action in ('acknowledge', 'keep_mine', 'same_truck')),

  -- Optional free text. Never required: forcing a reason on a one-click button is how a
  -- one-click button stops being clicked.
  note          text,

  -- No ON DELETE clause on purpose: the default NO ACTION refuses deleting a profile
  -- that has acknowledged something, so the trail cannot be orphaned. Profiles are
  -- retired with status = 'disabled', never removed.
  acked_by      uuid not null references public.profiles(id),
  acked_at      timestamptz not null default now()
);

comment on table public.sync_finding_acks is
  'Append-only ledger of a human acknowledging one sync finding. THE SYNC NEVER READS IT: a finding is still raised, still lands in sync_runs.result and still lands in the Excel workbook — this ledger decides only what the SCREEN shows. Filtering at the glass is what makes it impossible for an old acknowledgement to suppress a new problem, and impossible for the workbook to disagree with the panel. "Change your mind" means APPEND a row; the current ack for a fingerprint is the latest one (see view_sync_finding_acks_current).';
comment on column public.sync_finding_acks.fingerprint is
  'WHICH discrepancy — identity only, stable while the numbers move. Produced by lib/sync/findings.ts::findingIdentity, and byte-identical to sync_held_cases.fingerprint for every kind that has a durable case (gate_failure excepted by design — see that function''s header). Never carries a ₱ value.';
comment on column public.sync_finding_acks.content_hash is
  'WHAT the finding said when it was acknowledged. A finding whose current content_hash differs from its latest ack is unacknowledged again — this is what makes "quiet until it changes" work. Never carries a ₱ value.';
comment on column public.sync_finding_acks.action is
  'acknowledge = seen, nothing to do. keep_mine = my edit stands, the source is wrong. same_truck = those two differently-spelled rows are the same truckload.';

-- The read pattern is "latest row per fingerprint", which is exactly this index's
-- leading edge; `id` breaks a same-instant tie so the answer is total, never arbitrary.
create index if not exists idx_sync_finding_acks_current
  on public.sync_finding_acks (fingerprint, acked_at desc, id desc);
create index if not exists idx_sync_finding_acks_acked_at
  on public.sync_finding_acks (acked_at desc);

-- ═════════════════════════════════════════════════════════════════════════════════
-- 2. GRANTS + RLS — the append-only lock, in two independent layers
-- ═════════════════════════════════════════════════════════════════════════════════
-- Supabase's default privileges in `public` grant ALL on a new table to anon,
-- authenticated and service_role. Left alone, that hands `authenticated` UPDATE and
-- DELETE and hands `anon` everything — so REVOKE FIRST, then grant back exactly the
-- verbs each role needs. This is the same trap the cenapro schema documents.
revoke all on public.sync_finding_acks from anon;
revoke all on public.sync_finding_acks from authenticated;
revoke all on public.sync_finding_acks from service_role;

-- authenticated: read + append. NO update, NO delete — that is lock #1.
grant select, insert on public.sync_finding_acks to authenticated;
-- service_role: READ ONLY. The worker does not write acknowledgements and must never
-- be able to; the grant exists so a future worker read of the view below resolves its
-- whole dependency chain (L-044 — the unit of correctness is the CLOSURE, not the view
-- you happen to name).
grant select on public.sync_finding_acks to service_role;

alter table public.sync_finding_acks enable row level security;

-- Everyone signed in can read every acknowledgement: this is a single-org install and
-- "who already looked at this" is exactly the thing a second reviewer needs to see.
drop policy if exists sync_finding_acks_select on public.sync_finding_acks;
create policy sync_finding_acks_select
  on public.sync_finding_acks for select to authenticated
  using (true);

-- An ack may only be filed in your OWN name. `acked_by` is therefore not a hint the
-- client supplies, it is a claim the database checks.
drop policy if exists sync_finding_acks_insert on public.sync_finding_acks;
create policy sync_finding_acks_insert
  on public.sync_finding_acks for insert to authenticated
  with check (acked_by = auth.uid());

-- NO update policy and NO delete policy — that is lock #2. Do not add one.

-- ═════════════════════════════════════════════════════════════════════════════════
-- 3. view_sync_finding_acks_current — the CURRENT ack per fingerprint, resolved once
-- ═════════════════════════════════════════════════════════════════════════════════
-- Every consumer asks the same question ("what is the standing answer for this
-- fingerprint, and what did it look like at the time"), so the "latest row wins" rule
-- lives here and nowhere else. security_invoker, so it runs under the caller's own
-- privileges and RLS — the base table has a permissive authenticated SELECT policy, and
-- service_role bypasses RLS but still needs the table grant above.
create or replace view public.view_sync_finding_acks_current
with (security_invoker = true) as
select distinct on (a.fingerprint)
  a.id,
  a.fingerprint,
  a.kind,
  a.content_hash,
  a.action,
  a.note,
  a.acked_by,
  a.acked_at
from public.sync_finding_acks a
order by a.fingerprint, a.acked_at desc, a.id desc;

comment on view public.view_sync_finding_acks_current is
  'One row per fingerprint: the LATEST acknowledgement (greatest acked_at, ties broken by id). THE definition of "the standing answer" — do not re-derive it in a caller. Compare content_hash against the finding''s current one: equal = still acknowledged, different = the situation changed and it is unacknowledged again.';

revoke all on public.view_sync_finding_acks_current from anon;
grant select on public.view_sync_finding_acks_current to authenticated, service_role;
