# Sync Module — CONTEXT.md

## Purpose

The in-app **"Run Sync"** feature — a compact **modal** that runs the daily
ICTC ingestion (the six "employee" pipelines) from inside Blackwood, instead of
driving each sync employee by hand in Claude Code. One click enqueues a **durable
run** on a cloud worker; the worker classifies every report, auto-applies the clean
rows, and surfaces anything that needs judgment (held/flagged rows, hard-gate
failures). The modal watches it **live over Supabase Realtime**.

**Entry point:** a compact zinc **"Run Sync" launcher button** in the dashboard's
digest header band (right-aligned, `app/(app)/page.tsx`) opens the sync as a Dialog.
It is **Owner / Admin / Dev only** — enforced server-side in `enqueueSyncRun` and
hidden client-side for other roles.

## The durable flow (Wave 4B — laptop-proof)

The old model spawned Python **on Renzo's laptop**, tied to his browser tab (SSE +
`child_process`). That is **RETIRED**. The new model:

```
[Run Sync click]
  └─ enqueueSyncRun(dryRun?)  (server action)
       requirePrivileged → service-role INSERT sync_runs(status=queued, requested_by)
       → POST ${SYNC_WORKER_URL}/kick  (Bearer SYNC_KICK_SECRET, body {runId, dryRun})
       → returns { runId, kicked }
[TS worker + DBOS  ·  workers/sync, a small cloud host]
       extract → classify → gates → apply, all checkpointed (crash = resume)
       progress → sync_run_events rows      terminal → sync_runs.result
[Dashboard modal]  ← Supabase Realtime subscription on both tables (no SSE, no laptop)
```

- **Kick is best-effort.** If the POST fails/times out (~5s) the action does NOT
  fail — it returns `{ kicked: false }` with a human message ("worker asleep — the
  run is queued and will start when the worker wakes"). The `sync_runs` row is
  durable and DBOS recovery starts it on the next worker wake. The click is never
  lost.
- **Attach-to-in-flight (the headline feature).** On mount, `useSyncRun` queries the
  latest run; if it is non-terminal it **attaches** — a reopened modal, a second
  viewer, or a post-refresh session picks up the SAME running job and shows "A sync
  is already running (started HH:MM) — watching it live." Closing the laptop lid
  can't kill the run.
- **Realtime-hiccup fallback.** If the Realtime channel errors/times out, the hook
  degrades to a ~3s poll of the two tables (mirrors `notification-bell.tsx`).
- **Stop button (M5.1 — graceful cancel).** While a run is in flight a **Stop** button
  sits next to "Running sync…". Click → `cancelSyncRun(runId)`: a service-role UPDATE
  flips `sync_runs.status='cancelled'` (so the UI unsticks even if the worker is
  unreachable), then a best-effort `POST worker /cancel` so DBOS actually preempts the
  workflow. The Realtime UPDATE folds in → cards settle to a neutral **"Stopped"**, the
  button resets. **Rows already written are KEPT** (never rolled back). Double-clicks
  are guarded (`cancelling` disables the button). `cancelled` is a neutral terminal —
  no error toast, a calm local summary.
- **Attach-to-in-flight STALENESS GUARD.** On mount the hook only attaches to a
  GENUINELY-live run: a run older than ~20 min whose newest event is >15 min stale is
  presumed orphaned and NOT attached (belt-and-suspenders with the worker's watchdog),
  so a dead run can never re-strand the modal in a spinner.

## Files

### Server (this folder)
- `actions.ts` — server actions:
  - **`enqueueSyncRun(dryRun?)`** → `{ runId, kicked, message? }`. requirePrivileged →
    service-role INSERT into `sync_runs` → POST worker `/kick`. Best-effort kick
    (queued row survives a failed kick). The ONLY write path the click owns.
  - **`cancelSyncRun(runId)`** → `{ ok, workerNotified }` (M5.1). requirePrivileged →
    service-role UPDATE `sync_runs → cancelled` WHERE status IN (queued,running) →
    best-effort `POST worker /cancel` (Bearer, 5s timeout, never throws on failure).
    The UPDATE is the authoritative UI signal; the /cancel makes DBOS actually stop.
  - `adjudicateHeldRows(reportType, heldRows[])` → per-row `apply|skip|needs-human`
    recommendations (advisory only — applying still goes through the sync employee).
    **CONTEXT-RICH (2026-07-06):** on "Ask Claude" it (1) runs a targeted, read-only DB
    lookup per row keyed by `HeldRow.kind` via `createAdminClient()` — the missing
    evidence (rc_out dup check; deliveries/gsheet collision fetch; near-code batch
    candidates; occupying batch + status; flecon bag-type candidates), then (2) builds a
    prompt with the human key + structured `row` + rule meaning + DB finding + a rewritten
    ADVISORY `ADJUDICATOR_SYSTEM`, and (3) returns a richer `HeldRowRecommendation` with an
    optional **`evidence`** string (the DB finding, surfaced in the UI). The pure core
    (lookups + prompt + system prompt + KIND_MEANING) lives in **`adjudication.ts`**
    (no `'use server'`, no server-only imports) so it is unit-testable with a mocked admin
    client — see `scripts/verify-adjudication.ts`. **Price gating:** no lookup EVER selects
    a ₱/cost column.
    **PLAIN + SPECIFIC (2026-07-06):** `ADJUDICATOR_SYSTEM` was rewritten for plant-floor
    language — it **bans** the engineer words `gate / gate failure / upstream / DB SUM /
    settled date / HALT / watermark / envelope / natural key / idempotent`, and requires
    every recommendation to NAME the exact dates + both numbers and end with a concrete next
    step. To feed those specifics, a **gate-failure held row now carries `row.drift_dates`**
    (threaded by the worker from the reconciler — see the rc_out/rc_movement_audit index.ts
    ports): each entry is `{date, proposed_kg, movement_kg, diff_kg}` (daily-report-vs-sheet
    drift) or `{date, db_sum_kg, movement_kg, excess_kg}` (DB-vs-sheet duplication, the O>M
    gate), plus an optional `note:"no movement entry"`. **No ₱/cost fields.** For the
    **P-vs-M drift** flavor `lookupEvidence` renders a day-by-day plain-English line **with no
    DB call** (the numbers are already on the row), e.g. "…June 10 — the daily report shows
    71,144 kg fed but the movement sheet shows 57,401 kg (13,743 kg more than the sheet);
    June 12 — … no entry at all."
    **O>M SELF-DIAGNOSIS (2026-07-06):** the `db_vs_movement_duplication` gate's message
    assumes duplication, but that is often wrong (the movement sheet may just be *missing*
    feedings). So for a gate-failure row whose drift dates carry `db_sum_kg`/`excess_kg`,
    `lookupEvidence` now issues **one read-only `rc_out` query per flagged date** (filtered on
    `transaction_date`, `.limit(50)`, joins `batches(batch_code)` for a human label, **NO ₱/cost
    column**) and DIAGNOSES: exact-duplicate rows present (same date+batch+dest+weight ≥2×) →
    "the database has duplicate feedings … appears N times … remove the extra rows" (DB-issue
    lean); no duplicates → "M distinct feedings totaling … no duplicate rows exist, so the
    movement sheet is most likely MISSING feedings … the database looks correct — check the
    movement sheet, not the database" (movement-sheet-gap lean). `ADJUDICATOR_SYSTEM` teaches
    the O>M verdict is usually **skip** but the reason must reflect the diagnosis — never a
    blanket "suspected duplication". Reproduced from the real June-10 case (5 distinct
    feedings, movement short 13,743 kg → sheet gap, DB correct).
  - `narrateSyncRun(results[])` → optional 3-sentence plain-language summary; **skips the
    API call** (zero tokens) when every report is clean. **Unchanged** (app-side).
  - **`requirePrivileged()` now lives in `lib/sync/privileged.ts`** (extracted 2026-07-06,
    Smart-Adjudicator P1) and is IMPORTED here — the local copy was deleted so `actions.ts`
    and `cases.ts` share ONE Owner/Admin/Dev enforcement point (no drift). Same body:
    getUser → getUserRole (respects the impersonation cookie) → PRIVILEGED_ROLES gate,
    returns the user id, fails closed.
  - RETIRED: `runSyncClassify` / `runSyncApply` (child_process spawn) + the SYNC_MOCK
    plumbing. Classify/apply now run in the worker.
- `cases.ts` (`'use server'`) — the **case-persistence fan-out** (Smart-Adjudicator P1). Turns
  a terminal run's held rows into durable `sync_held_cases` rows so they survive past the modal:
  - **`ensureCasesForRun(runId)`** → `{created, refreshed, knownMatched, caseIds}`.
    requirePrivileged → service-role load of the run → no-op unless status is terminal
    (`succeeded|failed|partial`) AND (`result.reports` OR `result.reconciliation` exists).
    Folds FOUR case sources through ONE idempotent upsert-by-fingerprint spine (`upsertCase`):
    **(a) held rows** — `collectHeldRows` → `caseFingerprint` per row; **(b) R2 SHADOW
    source_diffs** — `collectSourceDiffs(result)` (the worker's `result.reconciliation.rc_out.diffs`)
    → `sourceDiffFingerprint` per diff → `sync_held_cases` rows `kind='source_diff'`,
    `report_type='rc_out'`, `natural_key`=`sourceDiffNaturalKey(diff)` (e.g.
    `MAR-26-BLK5 @ D-11B · 2026-06-10 · weight`), `row`=the full `SourceDiff` (sources[] +
    competing values + advisory `recommended`); **(c) R4a `unresolved_batch`** —
    `collectUnresolvedBatches(result)` → `unresolvedBatchFingerprint` → `kind='unresolved_batch'`,
    `natural_key`=`code · date` (the batch could not resolve to one batch_id — 0 or 2+ candidates);
    **(d) R4a `single_source_overdue`** — `collectSingleSourceOverdue(result)` (the worker's
    `heldOverdue[]`) → `singleSourceOverdueFingerprint` → `kind='single_source_overdue'` (a lone
    witness whose 2nd source is overdue; the value-independent fingerprint self-clears when the 2nd
    witness arrives). **`pending` facts are NOT folded** — they are a self-clearing telemetry count
    only (`result.reconciliation.rc_out.pending`). **IDEMPOTENT** (safe to call repeatedly; the
    modal AND the review page both call it). Existing case → refresh `last_run_id`/
    `last_seen_at`, bump `occurrence_count` ONLY when the runId differs from the case's
    `last_run_id` (no double-count on repeat calls for the SAME run); a `resolved` case that
    recurs in a NEWER run stays resolved (quiet-but-visible, never auto-reopened). New case →
    check `sync_case_rulings` for the latest matching fingerprint and pre-annotate
    `known_ruling_id` (status stays `open` — pre-annotated, not silenced). All reads/writes use
    `createAdminClient()` (service role) — these tables are service-role-write only.
    `source_diff` cases ride the EXISTING run-triage + investigator + Sync Review rails (generic
    case detail) AND, as of **R3a**, carry a dedicated pick-source resolution path
    (`proposePickSource` / `executeDiffResolution` in `resolve.ts` + the pure planner
    `diff-plan.ts`) — see the resolve.ts section below.
  - **`listOpenCases()`** → every `status != 'resolved'` case, newest-seen first, with the
    pre-annotating ruling's `verdict_summary` joined via the `known_ruling_id` FK. **P4:** now also
    selects `verdict` (the persisted investigation verdict jsonb) so the review page can render the
    verdict badge without a second fetch. **v1.1:** already selects `last_run_id` + `created_at`
    (used by the review page's per-run grouping) — no query change needed for T2.
  - **Deep link:** `cases/page.tsx` (`force-dynamic`) reads `searchParams.run` and threads it to
    `CasesClient` as `initialRunId`; the client fans that run out (`ensureCasesForRun`, idempotent)
    then preselects the run's triage/first case and scrolls its section into view.
  - **`getCaseWithMessages(caseId)`** → `{case, messages}` (messages ordered by `position`).
  - **`investigateCase(caseId, {escalate?, force?})`** → `InvestigationOutcome`
    (`{status:'done'|'skipped'|'error', verdict?, error?}`) — the **Smart-Adjudicator P3**
    privileged wrapper around `runInvestigation` (`lib/investigator/loop.ts`). `escalate` →
    run on Opus 4.8 (the "re-investigate / escalate" button); `force` → re-run even if already
    investigated / known-ruled. The loop is single-flight (a concurrent call / already-done /
    known-ruling case returns `skipped` with no token spend).
  - **`autoInvestigateRun(runId)`** → `{cases, investigated, skipped, errors, triage}` — the **P3
    auto-trigger**. Calls `ensureCasesForRun`, then auto-investigates each returned case that is
    `status='open'` AND `known_ruling_id IS NULL` via a **concurrency-2 promise pool**.
    Idempotent by construction (the loop's single-flight guard). Fired fire-and-forget from
    `useSyncRun.finalizeRun` when a run finishes with held rows — verdicts persist to the case,
    so they're waiting even if the modal was closed. **v1.1 (Run Triage):** after the investigation
    pool settles it now `await runTriage(runId)` (`lib/investigator/triage.ts`) and returns the
    outcome under the NEW `triage` field (`{status:'done'|'skipped'|'error', caseId?}` — `skipped`
    for a clean run). Triage never throws (a failure is reported, not raised — the investigations
    already landed).
  - **`triageRun(runId)`** (v1.1) → `RunTriageOutcome`. requirePrivileged; the standalone
    "re-triage" server action — forces a fresh synthesis over the run's current cases, replacing the
    triage case's verdict/row (idempotent by fingerprint upsert).
- `case-chat.ts` (`'use server'`) — the **human-in-the-loop CHAT continuation** (Smart-Adjudicator
  **P4**). After the opening auto-investigation writes a cited verdict, the case becomes a
  conversation Renzo steers:
  - **`chatOnCase(caseId, message)`** → `{ok, error?}`. requirePrivileged; validates the message
    (non-empty, <4000 chars); **rejects (ok:false) while the case is `investigating`** (a run is in
    flight). Inserts the user message row, replays the FULL `sync_case_messages` transcript into
    Anthropic `MessageParam[]` via **`case-history.ts`** (`foldHistory` mirrors
    `jarvis/actions.ts::buildAnthropicMessages` — system rows skipped, assistant rows carry text +
    `tool_use` blocks, tool rows fold into a user turn as `tool_result` blocks; then
    **`sanitizeAnthropicHistory`** repairs the tool_use/tool_result pairing — see below), then drives
    the **same `runToolLoop`** as the investigation but in
    CHAT MODE: system = `buildInvestigatorSystem()` + `buildChatAddendum()`, tools = the 5 read-only
    investigator tools + `submit_verdict`. If the model re-submits a verdict (only when its
    conclusion changed) → update `case.verdict` + `status='investigated'`; otherwise just persist the
    reply + touch `updated_at`. READ-ONLY like the investigation (no operational write — the resolve
    write is P5). If the case has no transcript yet, it leads with `buildCaseBriefing`. Service-role
    writes; every turn persists to `sync_case_messages` (the review page watches over Realtime).
    **v1.1 (Run Triage) — `run_triage` branch:** when the case's `kind` is `run_triage`, the chat is
    about the WHOLE run. It seeds `buildTriageBriefing` (run label + summary + one line per sibling
    flag) instead of the case briefing, uses `buildInvestigatorSystem() + buildTriageChatAddendum()`,
    and injects `PROPOSE_GROUP_RESOLUTION_TOOL` (dismiss-only) instead of `PROPOSE_RESOLUTION_TOOL` —
    the group tool's `executeProposeGroup` is bound to a `GroupResolutionContext` built from the run
    family (the triage case's `row.case_ids` minus already-resolved). Other kinds keep the single-case
    chat path unchanged.
- `case-history.ts` (**PURE, no `'use server'`**) — the transcript→Anthropic-messages layer split
  out of `case-chat.ts` (which, being `'use server'`, may only export async server actions), the same
  split discipline `adjudication.ts` uses against `actions.ts`. Two exported functions:
  **`foldHistory(rows)`** (folds stored rows into `MessageParam[]`) and
  **`sanitizeAnthropicHistory(messages)`** — repairs the tool_use/tool_result pairing invariant the
  Anthropic API enforces: for every assistant `tool_use` with no answering `tool_result` in the next
  turn, it injects/extends a user turn with a synthetic `{tool_result, content:'[result not
  recorded]'}`; it also drops orphan `tool_result` blocks whose id was never opened. This is the
  **migration-free heal for the case-chat 400 bug** — existing DB transcripts contain a dangling
  terminal `submit_verdict` assistant turn (persisted before the 2026-07-07 write-time fix in
  `loop.ts`), and error-truncated runs can produce the same shape; the sanitizer makes replay valid
  regardless. PURE + does not mutate its input → tested network-free by
  `scripts/verify-investigator-loop.ts` (6 sanitizer checks). Live-proven by the throwaway
  `scripts/smoke-case-chat-400.ts` (deleted after use): both a fresh-investigation chat and a
  manually-seeded pre-fix-shaped transcript chat succeed with the fix.
- `resolve.ts` (`'use server'`) — **HUMAN-DIRECTED RESOLUTION (P5)**. The only write path
  for a case. The investigator NEVER writes; a resolution fires only when the reviewer clicks
  Confirm on an agent-prepared proposal (or Quick Dismiss):
  - **`executeResolution(caseId, proposalMessageId)`** → `{ok, error?, ruling_id?}`.
    requirePrivileged → load the case (must not be `resolved`/`investigating`) → load the named
    message row (must belong to the case + carry a `propose_resolution` tool_use) → **re-read the
    proposal FROM THE DB ROW** (never a client payload) → double-execution guard (the proposal must
    still be the OPEN one via `findOpenProposal`, else refuse) → `executeResolutionInternal`.
  - **`executeResolutionInternal(admin, caseRow, proposal, ruledBy, ruledByEmail)`** — the
    client-injectable core (the live-smoke drives it bypassing requirePrivileged). Re-checks
    eligibility (defense in depth), dispatches the write (dismiss = NO operational write;
    apply/edit_apply → the `lib/sync/apply-writers.ts` registry), inserts a `sync_case_rulings`
    row, flips the case to `resolved` + `known_ruling_id`, and appends a system message trail
    ("Resolved (<action>) by <email>: <summary>" + for applies "Wrote 1 row to <table>, id <id>").
    Provenance stamped everywhere: "Resolved (<action>) via case chat by <email>".
  - **`cancelProposal(caseId, proposalMessageId)`** → inserts a "Proposal declined by <email>"
    system row (no other effect) so the UI clears the card server-side (an open proposal is the
    LATEST `propose_resolution` with no later ruling AND no later decline row).
  - **`quickDismiss(caseId, reason)`** → the actions-bar one-click dismiss (required "why"),
    synthesizes a dismiss ruling directly (same ruling+message+status writes, provenance
    "Resolved (dismiss) via case chat by <email>"). Human-directed by definition.
  - **ONE shared dismissal path (v1.1 refactor):** the internal `dismissOneCase(admin, caseRow,
    summary, reasoning, ruledBy, email, systemMessage)` is the SINGLE per-case dismissal write
    (ruling under THAT case's fingerprint → resolved + known_ruling_id → system message, NO
    operational write). `quickDismiss`, the dismiss branch of `executeResolutionInternal`, group
    dismiss, and bulk dismiss all route through it (external behavior of the existing actions
    unchanged).
  - **`executeGroupResolution(triageCaseId, proposalMessageId)`** (v1.1) → `{ok, resolved, errors[],
    triageResolved?}`. requirePrivileged; re-reads the `propose_group_resolution` proposal FROM THE
    DB message row; guards double-execution via `findOpenGroupProposal`; re-checks
    `checkGroupEligibility` against the run family (the triage case's `row.case_ids` minus already
    resolved). Dismisses each listed case INDIVIDUALLY (one ledger ruling per case under its own
    fingerprint) — sequential, collects per-case errors, does NOT roll back successes (each dismissal
    is status-guarded + idempotent). Writes a system note on EACH case + one on the triage case
    listing the count. If every non-triage case of the run is then resolved, resolves the triage case
    too ("all flags in this run resolved").
  - **`bulkDismissCases(caseIds, reason)`** (v1.1) → same `{ok, resolved, errors[]}` — the review
    page's multi-select path; per-case `dismissOneCase` writes, provenance "bulk-dismissed by
    <email>"; refuses a `run_triage` case (dismiss its flags, not the summary).
  - **R3a — PICK-SOURCE resolution of a `source_diff` case** (the Reconciliation Model's Stage-3
    human arbitration; `PickSourceResult = {ok, error?, proposal_message_id?, ruling_id?, plan?}`):
    - **`proposePickSource(caseId, source)`** → validates the case is an UNRESOLVED `source_diff`
      and `source` ∈ the diff's competing sources; reads the LIVE `rc_out` legs at the natural key
      (`transaction_date` + `block_loc` + `destination`); computes the pure per-leg write plan
      (`diff-plan.ts::computeDiffWritePlan` over the DB legs + the chosen `SourceOpinion.rows`);
      **persists it as an assistant message carrying one `propose_pick_source` tool_use** (mirrors
      `propose_resolution` so `findOpenPickSourcePlan`-detection + `sanitizeAnthropicHistory` replay
      both work). Writes NOTHING to `rc_out`. Returns the plan + proposal message id.
    - **`executeDiffResolution(caseId, proposalRef)`** → requirePrivileged; RE-READS the plan FROM
      THE PERSISTED PROPOSAL (never client input); double-execution guard via `findOpenPickSourcePlan`;
      if `plan.ambiguous` → NO write, returns an error routing the UI to the **P5 edit-then-apply**
      fallback; else applies each step (EDIT/`remove` = direct `rc_out` UPDATE + `write_ingestion_audit`
      — the `remove` op only soft-zeroes a weight, never deletes; INSERT via the deterministic
      `apply-writers.ts` rc_out writer) each stamped with provenance `source_diff resolved via Sync
      Review by <email>: picked <source> — <field> for <label>`. Records a **`sync_case_rulings` row
      `action='pick_source'`** (summary names the picked source + the authoritative value), flips the
      case `resolved` + `known_ruling_id`, appends a system trail, revalidates `/sync/cases`.
    - **R4 tie-in:** the `pick_source` ruling is a durable HUMAN CORRECTION — until R4 retires
      "Sheet-wins", a later gsheet run may re-overwrite the row; R4 consults this ruling to STOP that
      clobbering (see the `20260708120000_sync_case_ruling_pick_source.sql` comment + L-037).
  - Never deletes. Price gating: apply payloads carry NO ₱ (rc_out has no cost column;
    `deliveries.cost_basis` forced 0 by the writer per L-008). All revalidate `/sync/cases`.
- `diff-plan.ts` (PURE, no `'use server'`, imports only `./types` → client-import-safe for R3b) —
  the R3a write-plan + persisted-proposal core. `computeDiffWritePlan({source, dbRows, sourceRows})`
  → `DiffWritePlan {source, ambiguous, suggestion?, steps: DiffPlanStep[], currentSumKg, chosenSumKg,
  resultingSumKg, hasChanges}`. EDIT-preferred: greedy equal-weight `noop` matching, then the clean
  L-037 1-1 remainder → one `edit`; source-only extra legs → `insert`; DB-only extra legs →
  soft-`remove` (weight→0, kept); anything else (unequal counts, no clean map) → `ambiguous:true`,
  no steps, a `suggestion` routing to P5 edit-then-apply. Also the PURE proposal helpers the UI +
  action share: `PICK_SOURCE_TOOL`, `PickSourceProposalInput`, `parsePickSourceInput`,
  `findOpenPickSourcePlan(rows, caseStatus)`, `diffResolutionProvenance(...)`,
  `pickSourceRulingSummary(...)`. Exercised end-to-end by `scripts/verify-resolve-diff.ts`.
- `case-chat.ts` — **now also exposes `propose_resolution`** (chat mode ONLY, NOT the investigation
  loop). The chat's tool surface = the 5 read-only investigator tools + `submit_verdict` +
  `PROPOSE_RESOLUTION_TOOL`; the extra dispatch routes `propose_resolution` to `executePropose`
  (WRITE-FREE — validates eligibility against the case + echoes the proposal back). The write itself
  is `resolve.ts`, fired by a human Confirm click. `buildChatAddendum()` gained the RESOLVING
  section teaching when to call it.
- `adjudication.ts` — the PURE, server-import-free adjudication core: `ADJUDICATOR_SYSTEM`
  (plain, jargon-banning — see above), `KIND_MEANING` (a short plain-English meaning per
  `HeldKind`, de-jargoned 2026-07-06), `lookupEvidence(admin, reportType, held)` (the
  per-kind read-only DB lookup; `AdminLike` is a minimal structural client type so a spy can
  stand in; `kind:'gate_failure'` renders `row.drift_dates` — P-vs-M drift with NO DB call,
  O>M `db_vs_movement_duplication` with one read-only per-date `rc_out` query to self-diagnose
  DB-double-entry vs movement-sheet gap), the exported `GateDriftDate` type, and
  `buildAdjudicationPrompt(...)`. Imported by `actions.ts`.
- `types.ts` — the shared contract types. Import-safe from both server and client:
  - Report catalog (`SYNC_REPORTS`, `PARALLEL_WRITERS`, `metaFor`).
  - Legacy CLI-contract shapes still used as the RESULT payload the worker writes:
    `ClassifyResult`, `ApplyResult`, `HeldRow`, `GateFailure`, …
  - **Durable Realtime shapes:** `SyncRunStatus` (now includes **`cancelled`**) +
    `TERMINAL_RUN_STATUSES` (includes `cancelled`) + `isTerminalRunStatus`;
    `SyncCardStatus` gains **`stopped`** (neutral terminal card, not error-red);
    `SyncRunRow` (a `sync_runs` row); `SyncRunEventRow` (a
    `sync_run_events` row); `SyncProgressEvent`/`SyncProgressStage` (projected from an
    event row — same digestible shape as before); `RUN_TRACK_REPORT_TYPE` (`'_run'`);
    **`SyncRunResult`** (the terminal `sync_runs.result` contract: `{ reports?:
    Partial<Record<SyncReportType, SyncRunReportResult>>, summary? }`, where each
    `SyncRunReportResult` carries the SAME `ClassifyResult`/`ApplyResult` the old CLI
    produced — so downstream aggregation + `HeldRows` are untouched).
    - **Worker ↔ frontend shape reconciliation (2026-07-06 fix):** the DBOS worker now
      emits this EXACT shape per report. `workers/sync/src/workflows/normalizeReport.ts`
      is the assembly-boundary normalizer that maps each report's flat `runReport()` apply
      return into the nested contract: `apply.applied = {inserts, updates, replaced_dates}`
      is ALWAYS present (default zeros, even on a gate-failure/error apply), and
      `apply.held` is the FULL `HeldRow[]` ROWS (was collapsed to a count — the bug).
      Read-only auditor + dryRun → `apply: null`. The worker also RE-KEYS the auditor's
      result + progress events from its internal `rc_movement_audit` type to the panel card
      key `rc_movement` (`panelCardKey()` in `reportWorkflow.ts`), or the reducer's
      `VALID_REPORT_TYPES` would drop them. Round-trip proof: worker side
      `workers/sync/test/workflows/normalizeReport.test.ts`; app side
      `scripts/verify-sync-reducer.ts` (drives `lib/sync/reducer.ts` with the emitted shape).

### Client (`components/sync/`)
- `SyncLauncher.tsx` — the live entry point. Compact zinc "Run Sync" button in the
  digest header band, privileged-only. Owns `useSyncRun()` (lifted above the Dialog
  so closing the modal never detaches the run) + the modal `open` state.
- `SyncPanelBody.tsx` — the reusable panel content (written ONCE, shared with the
  dormant `SyncPanel.tsx`). Run button + a **"Dry run"** secondary button
  (classify-only; the first live full run should be a deliberate click) that becomes a
  **"Stop"** button while running (M5.1 — `variant=outline`, destructive-tinted;
  "Stopping…" while `cancelling`) + the **attached-run banner** ("A sync is already
  running (started HH:MM)") + a **non-fatal notice** line (e.g. "worker asleep —
  queued") + the overall `_run` progress line + employee cards + Held section +
  narration footer. Chrome-agnostic. Takes a `stop` prop alongside `run`/`adjudicate`.
- `SyncPanel.tsx` — DORMANT slide-out Sheet (still wraps `SyncPanelBody`; depends on
  the retired `JarvisProvider`). Do NOT re-mount without restoring it.
- `SyncEmployeeCard.tsx` — one card per report: live progress bar (`transform:
  scaleX(pct/100)`, never `width` — compositor rule) + plain-English status line
  (`level:'warn'` tints amber without an error state), counts → applied summary /
  gate-failed destructive state with inline error + Copy. M5.1 adds a neutral
  **`stopped`** state (StopCircle icon + "Stopped. Anything already written was kept.")
  — calm, not error-red. Card state is fed from Realtime; the shape is otherwise stable.
- `cases/ResolutionCard.tsx` (**P5**) — the confirm-gated resolution card rendered in the
  thread when a case has an OPEN proposal: action badge (Dismiss / Apply row / Apply edited row),
  plain summary, for edit_apply a font-mono field:value table of the EXACT row to write with
  old→new highlighting for changed fields, a destructive-styled Confirm (for applies) + Decline.
  Confirm → `executeResolution`; Decline → `cancelProposal`; both disabled while in flight;
  errors go through `errorToast()` (persist + Copy).
- `cases/QuickDismissDialog.tsx` (**P5**) — the actions-bar Quick Dismiss dialog (canonical glass
  `DialogContent`) with a required "why" textarea → `quickDismiss(caseId, reason)`.
- `cases/CaseDetail.tsx` / `cases/CasesClient.tsx` — the P5 slot is filled: `CasesClient` computes
  the open proposal from the live transcript (`findOpenProposal`) + resolves its message id, owns
  the confirm/decline/quick-dismiss handlers (Realtime repaints the thread on resolve), and mounts
  the dialog; `CaseDetail` renders the `ResolutionCard`, the Quick Dismiss button, and a
  "Resolved — <summary>" header line for resolved cases.
  - **v1.1 (Run Triage) — the review page is now GROUPED BY RUN.** `CasesClient` takes a new
    `initialRunId` (the `?run=<runId>` deep-link target) and passes the case list to the new
    **`cases/RunGroupedList.tsx`** (LEFT panel, replaces the retired flat `cases/CaseList.tsx`).
    RunGroupedList sections cases per run (newest first, via the pure `grouping.ts`), renders each
    run's **`cases/TriageSummaryCard.tsx`** on top (plain summary + cluster chips tinted by
    suggested_action — dismiss=emerald, needs-attention=amber; "Discuss this run" selects the
    triage case → run chat; a chip toggles a per-run cluster filter over the section's table), and
    the run's non-triage cases as the dense table beneath (triage cases NEVER render as a row).
    Each selectable row carries a compact bulk-select checkbox; a **selection bar** (animate-fade-up,
    glass) offers "Dismiss N selected…" → the multi-mode `QuickDismissDialog` → `bulkDismissCases`.
    Status filters (All/Open/Investigated/Known + show-resolved) apply across all sections.
    `CaseDetail` now also renders **`cases/GroupResolutionCard.tsx`** when the selected case is a
    triage case with an OPEN `propose_group_resolution` (detected client-side via
    `findOpenGroupProposal`): "Dismiss N flags" badge + the listed member cases → Confirm
    (`executeGroupResolution`) / Decline (`cancelProposal`). The Quick Dismiss button is hidden on a
    triage case (dismiss its flags, not the summary). All errors → `errorToast()`.
  - **R3b (the source_diff pick UI) — the arbitration half of the Reconciliation Model, in the app.**
    When the selected case is `kind='source_diff'`, `CaseDetail` renders the new
    **`cases/SourceDiffCard.tsx`** ABOVE the generic verdict card (the generic `ResolutionCard` /
    `findOpenProposal` slot stays null for these — pick-source is a separate rail). The card shows:
    (1) a dense Excel-standard **comparison table** — one row per `SourceOpinion` (source label,
    value in kg font-mono right-aligned, self-consistent OK/Fails chip, a "corroborated by …" chip
    when `corroboratedBy` is non-empty, and provenance truncated `max-w-[200px]` + Tooltip). The
    `recommended.source` row carries an **emerald ring + "Recommended" badge**, with `recommended.why`
    as a one-line advisory note ("Recommended — you decide"). (2) A per-source **"Use this" button**
    → `onProposePickSource(source)` → `proposePickSource` (writes nothing; persists the plan as an
    assistant `propose_pick_source` message). (3) On a pick, the returned **`DiffWritePlan`** renders
    inline as a **confirm card** (`PickPlanConfirm`, ResolutionCard's visual language): a steps table
    (op badge · feeding · before→after kg font-mono) + `currentSumKg → resultingSumKg`; when
    `plan.hasChanges===false` it reads "picking this records the decision; no feeding changes."
    Confirm → `executeDiffResolution(caseId, proposal_message_id)`; Decline → `cancelProposal`. If
    `plan.ambiguous`, NO Confirm is shown — the card routes the reviewer to edit-then-apply in the
    chat below (P5). **Open-plan restore:** `CasesClient` computes `openPickPlan` + its message id via
    the PURE **`findOpenPickSourcePlan`** (from `diff-plan.ts`, client-safe) over the live transcript,
    so a pending un-confirmed pick re-renders after a reload; a persisted proposal + a `loadMessages`
    refresh after each action (Realtime also repaints) drive the confirm card — no local plan state to
    lose. The chat + Quick Dismiss stay available (a source_diff can also just be dismissed). All
    errors → `errorToast()` (persist + Copy). Client/server boundary: SourceDiffCard imports ONLY pure
    types from `diff-plan.ts` — NEVER `lib/investigator/resolution.ts` (`npm run build` is the gate).
- `cases/grouping.ts` (**PURE, client-safe + node-safe, no React / no server imports**) — the
  load-bearing review-page transformations, factored out so they unit-drive under
  `scripts/verify-case-grouping.ts`: `groupCasesByRun` (per-run sections, newest run first, no-run
  bucket last, triage case pulled OUT of table rows + surfaced as `section.triage`),
  `filterRowsByCluster` (cluster-chip toggle), `preselectForRun` (the `?run=` fallback chain:
  run absent/not-found → null · has triage → triage case id · else first row · empty → null),
  `isBulkSelectable` (not triage + not resolved), `toTriageView`/`isTriageCase`, and a LOCAL
  `TRIAGE_KIND = 'run_triage'` copy (redeclared, NOT imported from `lib/investigator/triage.ts`,
  so this client-bundled module never pulls the Anthropic SDK / admin client into the browser
  bundle — the verify script asserts the two constants agree).
- `HeldRows.tsx` — held-row groups (in the sync MODAL). Each row's tag renders a human `KIND_LABEL`
  phrase (`gate_failure` → "Totals don't match — nothing saved", …); the raw kind stays on the
  badge's `title` (tooltip) for debugging. **v1.1 (Run Triage) — the per-group button is now a
  DOORWAY:** the old in-modal single-shot "Ask Claude" adjudication button + the separate "Open in
  Sync Review →" link are BOTH replaced by ONE **"Ask Claude → Sync Review"** Link deep-linking to
  `/sync/cases?run=<runId>` (the run id threads in via a new `runId` prop, sourced from
  `state.runId` through `SyncPanelBody`). The auto quick-recommendation glance rendering (verdict
  chip + Claude/DB lines per row) is UNCHANGED — it stays as the in-modal glance layer. The old
  `onAdjudicate` prop was dropped from `HeldRows`/`SyncPanelBody`/`SyncLauncher`/`SyncPanel`
  (`useSyncRun` still exposes `adjudicate`, now unused by the modal chrome).
- `useSyncRun.ts` — the orchestration hook. `run(opts?)` calls `enqueueSyncRun`;
  **`stop()`** (M5.1) calls `cancelSyncRun(currentRunId)` (guarded against
  double-clicks via `cancelling`); subscribes (browser client) to `sync_run_events`
  INSERT (filtered by `run_id`) → per-card live progress, and `sync_runs` UPDATE
  (filtered by `id`) → terminal fold-in (per-report results → cards → held aggregation
  → narration; a **`cancelled`** run settles still-busy cards to `stopped` + a calm
  local summary, no error toast). **P3 (2026-07-06):** after the held-row fold, when a
  non-cancelled run produced held rows, `finalizeRun` fires **`autoInvestigateRun(runId)`
  fire-and-forget** (`void … .catch(()=>{})`, never awaited so the modal never blocks) —
  the background investigator so cited verdicts are waiting on the review page (P4). Mount-time attach (with the staleness guard) + poll
  fallback as above. Returns `{ state, run, stop, adjudicate }`.

### Pure reducer (`lib/sync/reducer.ts`)
The load-bearing, framework-free transformations that turn raw Realtime rows into
card state — factored OUT of the hook so they can be unit-driven without a browser:
`projectEvent` (row → `SyncProgressEvent`, with the traceback digestibility guard),
`isRunTrack`/`eventReportType` (routing), `applyEventToCard` (the per-card state
machine: idle→classifying, `apply` stage→applying, monotonic pct, terminal cards
frozen), `deriveCardStatus`/`gateErrorFrom` (terminal result → card status + copyable
gate string).

### Pure case-persistence helpers (Smart-Adjudicator P1, `lib/sync/`)
Framework-free, DB-free, so they unit-drive under `scripts/verify-case-fingerprint.ts` +
`scripts/verify-source-diff-fold.ts`:
- `lib/sync/fingerprint.ts` — **`caseFingerprint(reportType, held)`** → sha256 hex of a
  CANONICAL JSON (keys sorted recursively, so insertion order never changes the hash). For
  `kind:'gate_failure'` the payload INCLUDES the per-date drift numbers (rounded to integers,
  dates sorted) → a changed discrepancy re-alarms as a NEW fingerprint; sub-kg jitter rounds
  to the same hash. For every other kind the payload is `(reportType, kind, natural_key)` only
  → stable row identity even if incidental `row` fields change. **R2:**
  **`sourceDiffFingerprint(diff)`** → sha256 of `{kind:'source_diff', table, natural_key, field,
  SORTED competing (source,value) pairs}` (weights rounded to integer kg — jitter doesn't
  re-alarm, a changed competing value does); **`sourceDiffNaturalKey(diff)`** → the human label.
  **R4a:** **`unresolvedBatchFingerprint(u)`** → sha256 of `{kind:'unresolved_batch', table,
  transaction_date, batch_code, SORTED candidates}` (identity + candidate set; value-free);
  **`singleSourceOverdueFingerprint(o)`** → sha256 of `{kind:'single_source_overdue', table,
  natural_key, field, source}` (value-INDEPENDENT — the missing-witness identity, self-clears when
  the 2nd source arrives). Plus `unresolvedBatchNaturalKey` / `singleSourceOverdueNaturalKey` labels.
- `lib/sync/cases-fold.ts` — **`collectHeldRows(result)`** → flattens
  `result.reports[type].apply.held` across all reports into `{reportType, held}[]`, guarding
  absent `reports` / `apply:null` / missing `held`. **R2:** **`collectSourceDiffs(result)`** →
  `result.reconciliation.rc_out.diffs ?? []` (guards the absent channel on pre-R2 runs). **R4a:**
  **`collectUnresolvedBatches(result)`** / **`collectSingleSourceOverdue(result)`** →
  `result.reconciliation.rc_out.unresolvedBatches ?? []` / `.heldOverdue ?? []` (optional additive
  fields — absent on pre-R4a runs). Pure, no supabase import.
- `lib/sync/privileged.ts` — **`requirePrivileged()`**, the shared Owner/Admin/Dev guard
  extracted from `actions.ts` (imported by both `actions.ts` and `cases.ts`).
- `lib/sync/apply-writers.ts` (Smart-Adjudicator **P5**) — the **writer registry** for apply /
  edit-then-apply. `APPLY_WRITERS: Record<reportType, writer>` (v1 = **rc_out** + **deliveries**);
  `hasApplyWriter(type)`. Each writer validates the row (the PURE, client-free `validateRcOutRow` /
  `validateDeliveriesRow` are exported so `verify-resolution.ts` drives them without a client),
  resolves the batch to a UNIQUE existing batch (exact→ilike; 0 or 2+ candidates → plain error
  listing them — **NEVER auto-creates a batch**), inserts, and audits: **rc_out** via
  `write_ingestion_audit` (no audit trigger), **deliveries** via `set_audit_comment` + its own audit
  trigger (the review-queue pattern). `deliveries.cost_basis` forced 0 (L-008). Every other report
  type → refused. No ₱ ever enters a payload.
- `lib/investigator/resolution.ts` (**P5**, client-safe) — `PROPOSE_RESOLUTION_TOOL` +
  `executePropose` (chat-mode tool, WRITE-FREE), `parseProposal`, `checkEligibility` (dismiss = any
  unresolved case; apply/edit_apply = per-row holds with a writer, NOT `gate_failure`; edit_apply
  needs `edited_row`; resolved case → refused — enforced in BOTH the tool executor and
  `executeResolution`), and the PURE `findOpenProposal(rows, status)` (the open-proposal detector
  the UI + `executeResolution` share).

### Dev testing WITHOUT the worker
- `scripts/dev-fake-run.ts` (+ `scripts/dev-fake-run.md`) — inserts a fake
  `sync_runs` row + a sequence of `sync_run_events` + a terminal `result.reports`
  via the service client. The logged-in browser animates the modal exactly as a real
  run would. This REPLACES the retired `SYNC_MOCK=1` path.
- `scripts/verify-sync-reducer.ts` — `npx tsx scripts/verify-sync-reducer.ts` runs 22
  framework-free assertions driving `lib/sync/reducer.ts` with recorded Realtime
  payload shapes (event projection, routing, the card state machine, terminal-result
  → card status). Proves the wiring without a browser or the worker.
- `scripts/verify-resolution.ts` — `npx tsx scripts/verify-resolution.ts` runs 28
  framework-free assertions over the P5 resolve pieces: `parseProposal` accept/reject,
  `checkEligibility` (dismiss any unresolved · apply/edit_apply on gate_failure or a
  writer-less report or a resolved case → refused · edit_apply needs edited_row · rc_out/
  deliveries allowed), `validateRcOutRow`/`validateDeliveriesRow` (missing weight/date/
  destination/batch → plain error; good row → ok, no cost surfaced), `findOpenProposal`
  (open / declined-closed / resolved-closed / latest-wins), and provenance composition.
  No DB. **Live-smoke (2026-07-07, throwaway, cleaned to 0 orphans):** seeded a synthetic
  run + rc_out apply case + a dismiss case + a `propose_resolution` message, drove
  `executeResolutionInternal` → the rc_out row inserted, `write_ingestion_audit` wrote the
  provenance-stamped audit row (confirmed via MCP — the local service-role key can't SELECT
  `audit_logs`), the ruling + resolved case + system trail all landed, and dismiss wrote 0
  operational rows (ruling + status only). Everything deleted after.
- `scripts/verify-triage.ts` (v1.1 Run Triage) — `npx tsx scripts/verify-triage.ts` runs 25
  framework-free assertions over the triage layer's PURE pieces: `parseTriage` validation + REPAIR
  (unknown id dropped, missing id → singleton needs-attention cluster, duplicate deduped, empty
  cluster dropped, malformed input still partitions), `triageFingerprint` stability + distinctness,
  `parseGroupProposal`/`checkGroupEligibility` (dismiss-only; non-triage/resolved/out-of-family/
  already-resolved/triage-id-in-group all refused; clean group ok), `findOpenGroupProposal`
  (lone/declined/resolved/latest-wins/ignores single propose_resolution), and `buildTriageBriefing`
  rendering. No DB. **Live-smoke (throwaway `scripts/smoke-triage.ts`, deleted after use, 2026-07-07):**
  seeded a fake run + 3 tiny cases (2 shared root cause, 1 distinct) → `runTriage` produced a clean
  2+1 partition + jargon-free summary; a simulated `propose_group_resolution` + the group dismissal
  path resolved both clustered cases with individual ledger rulings + system messages, left the
  distinct case untouched, cleaned to 0 orphans.
- `scripts/verify-case-grouping.ts` (v1.1 Run Triage, T2) — `npx tsx scripts/verify-case-grouping.ts`
  runs 17 framework-free assertions over the PURE review-page spine (`components/sync/cases/
  grouping.ts`): the local `TRIAGE_KIND` agrees with the server source of truth, run-grouping order
  (newest run first, no-run bucket last), triage case excluded from table rows + surfaced as the
  card, a fresh triage keeping its run on top, cluster-chip filtering, the `?run=` preselect
  fallback chain (absent/not-found → null · triage → triage id · else first row), bulk-selection
  eligibility (triage/resolved not selectable), and `toTriageView` robustness. No DB, no browser.
  **Data-path proof (throwaway, deleted after use, 2026-07-07):** a seed script inserted a fake run
  + 3 held cases + a run_triage case (2 clusters) via service role, drove the EXACT page
  transformation (grouping, cluster filter, `?run=` preselect, bulk eligibility) over the real rows,
  asserted the shape, and cleaned to 0 orphans (auth/login wall blocks a live screenshot on
  `/sync/cases`, same as P4).
- `scripts/verify-case-fingerprint.ts` — `npx tsx scripts/verify-case-fingerprint.ts`
  runs 5 framework-free assertions over the case-persistence spine's PURE pieces
  (`lib/sync/fingerprint.ts` + `lib/sync/cases-fold.ts`): fingerprint stability, key-order
  independence (canonicalization), gate-failure numbers re-alarm while sub-kg jitter does
  not, non-gate row-payload changes preserve identity, and `collectHeldRows` folds a
  realistic `SyncRunResult` (guarding `apply:null` + no-held reports). No DB.
- `scripts/verify-source-diff-fold.ts` — `npx tsx scripts/verify-source-diff-fold.ts` runs 5
  framework-free assertions over the R2 SHADOW fan-out's PURE pieces (`sourceDiffFingerprint` +
  `sourceDiffNaturalKey` in `lib/sync/fingerprint.ts`, `collectSourceDiffs` in
  `lib/sync/cases-fold.ts`): fingerprint stability, source-order independence, a changed
  competing value re-alarms while sub-kg jitter does not, the human label, and the fold guarding
  an absent/empty reconciliation channel. No DB.
- `scripts/verify-resolve-diff.ts` (**R3a**) — `npx tsx scripts/verify-resolve-diff.ts` runs 8
  framework-free assertions over the PICK-SOURCE core (`app/(app)/sync/diff-plan.ts`): the L-037
  clean case (one edit 31,745→20,932, result 31,745, not ambiguous), an equal-count value-diff, an
  ambiguous unequal-count with no clean weight match (no steps), insert-missing-leg, DB-already-equal
  (all noops), soft-remove of an over-stated leg (weight→0, kept), the exact provenance + `pick_source`
  ruling-summary strings, and the `parsePickSourceInput` / `findOpenPickSourcePlan` round-trip (a
  later decline closes it). No DB.
- `scripts/eval-investigator.ts` (**Smart-Adjudicator P6** — the LIVE trust harness, NOT
  throwaway) — `npx tsx scripts/eval-investigator.ts [--case <name>] [--keep]`. Seeds
  SYNTHETIC fake `sync_runs` + cases and drives the REAL `runInvestigation()` against the
  known cases we solved by hand, asserting the RIGHT verdict, then ALWAYS cleans up (a
  `finally`, so a failed assertion still cleans; `--keep` leaves rows + prints their ids).
  5 cases: `june10-o-gt-m` (O>M, movement sheet missing → skip), `may-proposed-overstated`
  (proposed report over-states on 2 dates → skip), `seeded-true-dup` (two identical 2020-01-02
  rc_out rows → NOT skip / needs-human — proves it does NOT rubber-stamp "DB is right"),
  `ledger-rematch` (no model call — occurrence-bump + pre-annotation + changed-numbers
  re-alarm, reproducing `ensureCasesForRun`'s fingerprint upsert), `write-safety` (before/after
  operational COUNT(*) unchanged + the investigation tool set has no write-like tool and no
  `propose_resolution`). Isolation = synthetic `2020-01-02` date + `production_batch='EVAL-DUP'`
  + fake-run marker `result.summary='[eval-investigator synthetic run]'` — safe to re-run on
  the production DB (never touches real 2025/2026 rows beyond SELECTs; leaves 0 orphans).
  Costs ~3 Sonnet investigations (cents). Landed a minimal `playbook.ts` fix — the O>M
  duplicate branch now rules `needs-human` (delete a row), never `skip`; skip stays for the
  no-duplicate case. Full detail in `lib/investigator/CONTEXT.md` → "P6".

## Data

### Durable run ledger (migration `20260704000000_sync_runs_and_events.sql`)
Two DB tables applied to remote; both in the `supabase_realtime` publication; `types/supabase.ts`
regenerated so `sync_runs`/`sync_run_events` are typed:

- **`sync_runs`** — one row per click. `id`, `requested_by`, `status`
  (`sync_run_status`: queued/running/succeeded/failed/partial/cancelled), `started_at`,
  `finished_at`, `result` (jsonb = `SyncRunResult`), `error`, `created_at`. **R2:** the worker
  additively attaches `result.reconciliation = { rc_out: { diffs: SourceDiff[], agreements } }`
  (the SHADOW multi-source reconciliation channel — sits alongside `reports`, observational only;
  `worker: runSync.ts::reconcileRcOutShadow`). **R4a:** the `rc_out` channel now also carries
  `{ pending: number, heldOverdue: SingleSourceOverdue[], unresolvedBatches: UnresolvedBatch[] }`
  (single-witness split + batch-resolution failures). App-side mirror types (`SourceDiff` /
  `SourceOpinion` / `ReconciliationChannel` / `UnresolvedBatch` / `SingleSourceOverdue`) live in
  `app/(app)/sync/types.ts`.
- **`sync_run_events`** — the live progress feed. `id`, `run_id`, `report_type`
  (the card key; `'_run'` = the top-level track), `stage`, `pct`, `label`, `detail`,
  `level`, `at`.

### Smart-Adjudicator case files (migration `20260706120000_smart_adjudicator_cases.sql`)
Three DB tables applied to remote (2026-07-06); `sync_held_cases` + `sync_case_messages` in the
`supabase_realtime` publication; `types/supabase.ts` regenerated. Fanned out by `cases.ts`:

- **`sync_held_cases`** — one durable case per DISTINCT held-row discrepancy, deduped by a
  UNIQUE `fingerprint`. `id`, `fingerprint`, `report_type`, `kind`, `natural_key`, `reason`,
  `detail`, `row` (jsonb, no ₱/cost), `first_run_id`/`last_run_id` (→`sync_runs`),
  `occurrence_count`, `last_seen_at`, `status`
  (`open|investigating|investigated|resolved`), `known_ruling_id` (→`sync_case_rulings`,
  pre-annotation), `verdict` (jsonb, P3 writes it), `created_at`/`updated_at`.
  **v1.1 (Run Triage) reuses this table — NO migration.** A run's triage is a SYNTHETIC case row:
  `kind='run_triage'` (the column is unconstrained TEXT), `report_type='run'`,
  `fingerprint=triageFingerprint(runId)`, `row={clusters, case_ids}`,
  `verdict={verdict:'needs-human', confidence:'high', summary, …}`, `status='investigated'`
  (CHECK-allowed). Its chat thread + Realtime + review-page rendering are the SAME case machinery;
  `lib/investigator/triage.ts::runTriage` upserts it (idempotent by the `fingerprint` UNIQUE).
- **`sync_case_messages`** — the per-case chat + investigation transcript (mirrors
  `jarvis_messages`): `case_id` (→cases, ON DELETE CASCADE), `role`
  (`user|assistant|tool|system`), `content`, `tool_calls`/`tool_results` (jsonb), `position`,
  UNIQUE `(case_id, position)`.
- **`sync_case_rulings`** — the append-only known-issues ledger keyed by `fingerprint`:
  `case_id`, `action` (`dismiss|apply|edit_apply|override_gate`), `verdict_summary`,
  `reasoning`, `ruled_by` (→`profiles`), `ruled_by_email`, `created_at`. (The
  `known_ruling_id`↔`case_id` circular FK is resolved by an ALTER after both tables exist.)

**RLS / grants (verified on remote):** for ALL FIVE tables, authenticated = **SELECT only**
(base GRANT + a `using(true)` select policy per table); **no INSERT/UPDATE policy or grant** —
the worker/`enqueueSyncRun`/`ensureCasesForRun` write with the service role via
`createAdminClient()` (bypasses RLS). Proven: authenticated SELECT succeeds (the subscription's
read path); authenticated INSERT is denied.

Also consumes the Anthropic API (`lib/anthropic/client.ts`) for adjudication +
narration (unchanged).

## Env

- `SYNC_WORKER_URL` — the worker's base URL (Fly.io app in prod, `http://localhost:8080`
  local). Unset → enqueue still works, run stays queued.
- `SYNC_KICK_SECRET` — shared Bearer secret; MUST match the worker's `SYNC_KICK_SECRET`.
- `SUPABASE_SERVICE_ROLE_KEY` — already present; used by `enqueueSyncRun` to INSERT the
  run row.

Documented in the root `.env.example`. The worker's own env is in `workers/sync/.env.example`.

## Key Behaviors

- **One click, then hands-off.** Enqueue → the worker does everything durably; the
  modal is a pure viewer. Refresh / close / laptop off — the run continues.
- **Live, digestible progress.** `sync_run_events` INSERTs drive a scaleX-animated bar
  + a plain-English status line per card, plus a top-level `_run` line above them.
- **Dry run.** A deliberate secondary button runs classify-only (writes nothing),
  forwarded to the worker in the kick body as `dryRun: true`.
- **Multi-viewer / reopen.** Any session attaches to the latest in-flight run.
- **Clean days cost ~0 model tokens.** `narrateSyncRun` returns a local string when
  nothing changed.
- **Held rows are advisory in v1.** "Ask Claude" returns recommendations; applying a
  held row stays a Claude-Code / sync-employee job. Each held row now carries a HUMAN
  `natural_key` (never an index), a normalized `kind`, and a structured `row` — and
  "Ask Claude" backs each verdict with a read-only DB lookup surfaced as `evidence`.
- **Every failure is copyable.** Gate failures + run-level failures render an inline
  block with the full detail + Copy AND fire `errorToast()` (HARD RULE).
- **Role gate.** `enqueueSyncRun` calls `requirePrivileged()` (effective role via
  `getUserRole()`, respects impersonation, fails closed). The launcher + body are also
  hidden client-side for non-privileged roles.

## Stubbed / pending

- The worker's **per-report extract→classify→apply workflows are M3** (see
  `SYNC_TS_MIGRATION_PLAN.md`). Until they land, the worker (M0/M1) writes a Mail-Clerk
  manifest as `result` (no `reports` key) and emits `_run` + the 4-writer progress
  tracks. The reducer handles this: a terminal result with no `reports` simply settles
  any still-spinning cards to done/error by the run status. `gsheet` and `rc_movement`
  are not in the worker's Mail Clerk yet — their cards stay idle until M3.
- Applying held rows (single-row write) is intentionally not implemented.

## Dependencies

- `lib/supabase/client.ts` — browser client (Realtime subscription)
- `lib/supabase/admin.ts` — `createAdminClient()` (service-role INSERT of the run row)
- `lib/supabase/server.ts` — `createClient()` (the `requirePrivileged` auth check)
- `lib/auth.ts` — `getUserRole()`; `types/auth.ts` — `PRIVILEGED_ROLES`
- `lib/sync/reducer.ts` — the pure card-state reducer
- `lib/anthropic/client.ts` — `anthropic`, `JARVIS_MODEL`
- `lib/toast.ts` — `errorToast()`
- `workers/sync/` — the durable worker (READ its README for the kick contract; do NOT
  edit it from the app side)

## See Also

- `SYNC_TS_MIGRATION_PLAN.md` — the TS/DBOS migration (M4 = this frontend cutover)
- `workers/sync/README.md` — the worker's kick contract + event/result shapes
- `app/(app)/review-queue/CONTEXT.md` — the precedent extract→classify→approve→write pipeline
