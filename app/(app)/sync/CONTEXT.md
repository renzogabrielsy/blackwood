# Sync Module — CONTEXT.md

## Purpose

The in-app **"Run Sync"** feature — a compact **modal** that runs the daily
ICTC ingestion (the six "employee" pipelines) from inside Blackwood, instead of
driving each sync employee by hand in Claude Code. One click enqueues a **durable
run** on a cloud worker; the worker classifies every report, auto-applies the clean
rows, and surfaces anything that needs judgment (held/flagged rows, hard-gate
failures). The modal watches it **live over Supabase Realtime**.

**Entry point:** a compact zinc **"Run Sync" launcher button** in the dashboard's
digest header band (right-aligned, `app/(app)/page.tsx`) opens the sync as a centered
**Dialog** at `sm`+ and as a bottom **Sheet** on phones (viewport-switched from ONE
lifted `useSyncRun` — see `SyncLauncher.tsx` below). It is **Owner / Admin / Dev only**
— enforced server-side in `enqueueSyncRun` and hidden client-side for other roles.

## AI layer — DORMANT, deterministic-only (Renzo 2026-07-11)

**Sync Review presents flags BLUNTLY, with deterministic template text only — ZERO
Claude API calls fire automatically anywhere in the sync path.** The investigator /
triage / case-chat / narration machinery described throughout this doc (the "Smart
Held-Row Adjudicator" P1–P5 waves) is **NOT deleted** — every server action, DB
column, and pure helper stays exactly as documented below — it is put to sleep
behind ONE flag so it can be re-enabled with a one-line change:

- **`lib/sync/config.ts::SYNC_AI_REVIEW_ENABLED`** (currently `false`) — the single
  off-switch. Client-safe (zero imports) so both server actions and client
  components can read it without dragging server-heavy deps into the browser
  bundle (see CLAUDE.md's "Client/server module boundary trap").
- **What's gated when `false`:**
  - `useSyncRun.ts`'s `finalizeRun` — the fire-and-forget `autoInvestigateRun(runId)`
    trigger on run finish never fires (was the ONE automatic Claude call in the
    whole sync path).
  - `useSyncRun.ts`'s narration step — never calls the `narrateSyncRun` server
    action; always folds to **`lib/sync/local-summary.ts::localSyncSummary`**, a
    pure/deterministic template (same "Nothing new today…" string for a clean run,
    a blunt counts-based line otherwise — "Wrote 40 new rows. 3 items need your
    review — see the findings below."). **The review-count N is the RENDERED
    findings count** (`flattenRunFindings(result).length`, computed in
    `finalizeRun` and passed as `localSyncSummary`'s second arg,
    `findingsCount`) — NOT the raw per-report classify-level `held + flagged`
    totals. Those totals can be nonzero with zero renderable findings (e.g. a
    classify-level `flagged` with no held row and no reconciliation finding —
    confirmed on run b142814b: gsheet + rc_movement_audit each flagged=1, apply
    held=0, 0 block/diff findings → 0 rendered findings), which used to make the
    footer promise a review the findings list below couldn't show (fixed
    2026-07-14). The line only appears when `findingsCount > 0`.
  - `cases.ts`'s `autoInvestigateRun` itself early-returns a no-op `skipped` result
    (belt-and-suspenders — nothing fans a run into cases + investigates while the
    flag is off, even if called directly).
  - `adjudicateHeldRows` (`actions.ts`) and `triageRun` (`cases.ts`) are **already
    dead code** independent of the flag — no client component wires either one up
    (confirmed 2026-07-11) — left on disk with a comment, no extra gating needed.
- **What's hidden in the UI when `false`** (code stays mounted, just doesn't
  render — grep `SYNC_AI_REVIEW_ENABLED` in each file for the exact gate):
  - `CaseDetail.tsx` — the Investigate / Re-investigate / Escalate buttons, the
    case-chat input (`CaseChatInput`), the AI `VerdictCard`, and the "not yet
    investigated" empty state (which pointed at the now-hidden Investigate button).
  - `RunGroupedList.tsx` — the "Investigated" filter chip is dropped from the
    filter bar, and the plain (no-known-ruling) verdict badge renders nothing — a
    case is just **open or resolved**. The "Known issue" ruling badge/tooltip
    (a genuine human-ruled signal from `resolve.ts`, orthogonal to the
    investigator) stays visible regardless of the flag.
- **The replacement workflow — copy-paste-into-Claude-Code:** every AI action now
  has a network-free, deterministic serializer + a "Copy for Claude" button instead:
  - **Per-run:** `HeldRows.tsx`'s "Copy all for Claude" (panel) and
    `CasesClient.tsx`'s "Copy all for Claude" (review page) — pre-existing.
  - **Per-case (NEW, 2026-07-11):** `CaseDetail.tsx` renders a compact **"Copy for
    Claude"** button next to the status chip (same visual language as the
    run-level buttons) → **`lib/sync/findings.ts::serializeCaseForClaude`** — a
    self-contained markdown brief for ONE case (instruction header + kind/label +
    natural key + reason/detail + prior verdict if any + all row data, cost keys
    stripped). Pure, deterministic, never throws — proven network-free by
    `scripts/verify-findings.ts` (mirrors `serializeCasesForClaude`'s discipline).
- **Flag flip = full restore.** Set `SYNC_AI_REVIEW_ENABLED = true` and every
  automatic trigger, every hidden button, and the verdict card come back — nothing
  else in this doc changes.

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
    Folds FIVE case sources through ONE idempotent upsert-by-fingerprint spine (`upsertCase`):
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
    only (`result.reconciliation.rc_out.pending`). **(e) RB `block_diff`** —
    `collectBlockDiffs(result)` (the worker's `result.reconciliation.blocking.blockDiffs` — the
    Sheet Blocking tab vs the computed `view_blocking_grid`) → `blockDiffFingerprint` →
    `kind='block_diff'`, `report_type='blocking'`, `natural_key`=`blockDiffNaturalKey`
    (`A-9C · balance`, `D-11B · batch`, `B-3A · multi-batch`, `GRAND TOTAL · blocking`), `row`=the
    full `BlockDiff`; a read-only cross-check with no bespoke resolver (dismiss/investigate;
    `query_table` allows `view_blocking_grid`). **IDEMPOTENT** (safe to call repeatedly; the
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
  - **CREATE-BATCH resolution of an `unmapped_batch_code` / `unresolved_batch` case** (the ONE
    human-confirmed exception to "never auto-create a batch" — a genuinely-new batch like
    `JULY-26-FEED1` recurs every run because nothing creates it; `CreateBatchResult = {ok, error?,
    proposal_message_id?, ruling_id?, created_batch?, batch_id?, rows_written?, warnings?, plan?}`):
    - **`proposeCreateBatch(caseId)`** → validates the case is an unresolved unmapped/unresolved-batch
      flag; builds the PURE plan (`create-batch-plan.ts::buildCreateBatchPlan` — derived batch fields,
      writer lane, the skipped row); read-only checks whether the batch already exists (honest
      narration); **persists it as an assistant message carrying one `propose_create_batch` tool_use**
      (mirrors pick-source so `findOpenCreateBatchPlan`-detection + sanitize replay work). Writes
      NOTHING. Returns the plan + proposal message id.
    - **`executeCreateBatch(caseId, proposalRef)`** → requirePrivileged; RE-READS the plan FROM THE
      PERSISTED PROPOSAL; double-execution guard via `findOpenCreateBatchPlan`; then (1) INSERT the
      batch if its code doesn't exist (else skip-create — idempotent, race-safe on the `batch_code`
      UNIQUE; audited via `write_ingestion_audit` — batches has NO audit trigger), (2) re-attempt the
      skipped row through the deterministic `apply-writers.ts` path (deliveries for RC IN, rc_out for
      RC OUT) — a row-write failure is **NON-FATAL** (the batch is the primary win; the row lands next
      sync; captured in `warnings`), (3) record a **`sync_case_rulings` row `action='create_batch'`**
      (summary via `createBatchRulingSummary`), flip the case `resolved` + `known_ruling_id`, append a
      system trail, revalidate `/sync/cases`. Provenance: `batch "<code>" created + row written via
      Sync Review by <email>`. `ambiguous` plan (no clean writable row) → create the batch only.
      A batch's `location_ref` is the `block_loc` when it matches the DB CHECK
      `chk_location_ref_format` (`^(PCA|PCB|[A-DF])-\d{1,2}[A-D]$`), else `''` (empty = feed/no block —
      covers a genuinely-missing block AND free text like "FOR FEEDING"). NEVER the literal `'FEED'`
      sentinel — that 23514s the CHECK (BUG B, 2026-07-11). `FEED_LOCATION_REF` is a DISPLAY-only label
      (`isFeed` badge), never a stored value.
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

- `reports.ts` — the **DOWNLOAD side of the Excel sync report** (2026-08-07). Read-only; it
  generates nothing (the worker does that at the end of every run). All three actions call
  `requirePrivileged()` first, then use `createAdminClient()`:
  - **`getSyncRunReportUrl(runId)`** → `{ url, filename, bytes, expiresInSeconds }`. Looks up
    the run's artifacts newest-first and picks the newest **SUCCESSFUL** one (a failed
    regeneration must not take away a file that is still sitting in Storage and still valid),
    then mints a **60-second signed URL** with `?download=<filename>` so the browser saves it
    under a human name. Refuses, with a message written to be shown verbatim, when: no
    artifact exists (every run before 2026-08-07), generation had failed, or
    `contains_prices !== false` and `canViewPrices()` is false. **THE PESO GATE** — see below.
  - **`getRunsWithReports(runIds[])`** → the subset that has a downloadable report. One
    `IN (...)` query, called once by `cases/page.tsx` so a run header only shows a download
    button when there is a file behind it.
  - **`listSyncRunReports(limit)`** → the last N artifacts from `view_sync_run_reports`
    (`is_latest` only), newest first. The history list; nothing renders it yet.

  **THE PESO GATE, stated once.** A stored file cannot be nulled at read time the way a
  server-action payload can, so the gate is enforced against a MEASURED fact:
  `sync_run_reports.contains_prices`, which **DEFAULTS TRUE (fail-closed)** and which the
  generator sets to `false` only after `auditPriceFree()` re-read every string it wrote and
  found neither a ₱ glyph nor a cost-ish `key=value` token. Today every report is price-free
  by construction — the finding vocabulary carries no ₱ anywhere on purpose, and the one raw
  input that can (`sync_held_cases.row`, which for a delivery holds `cost_basis`) is emitted
  only through `formatFindingData`, which strips it. So **the answer to "peso-free
  regenerated file, or no download at all?" is: no download at all, and that branch is
  unreachable today** — nobody is gated out of a file with no ₱ in it, and there is no second
  generating code path to keep in sync. Measured on the real served file: `cost_basis` 0
  occurrences, `₱` 0 occurrences (the only hits for "cost"/"peso" are the Summary legend
  saying the report has none). Also note `requirePrivileged()` (Owner/Admin/Dev) refuses
  Production before the ₱ question is asked, so the ₱ branch is defence-in-depth for the day
  `PRIVILEGED_ROLES` widens.

### Client (`components/sync/`)
- `SyncLauncher.tsx` — the live entry point. Compact zinc "Run Sync" button in the
  digest header band, privileged-only (the trigger is `h-11` ≥44px on phones,
  `sm:h-8` compact on desktop). Owns `useSyncRun()` (lifted above the modal boundary
  so closing the modal never detaches the run) + the modal `open` state.
  **Responsive surface split (Audit 01, `feat/mobile-pwa`):** it renders TWO surfaces
  from the SAME lifted state — a centered **Dialog** at `sm`+ (desktop, byte-for-byte
  unchanged) and a bottom-anchored **Sheet** (`side="bottom"`, `max-h-[90dvh]
  rounded-t-2xl … pb-[max(1rem,env(safe-area-inset-bottom))]`, sticky glass header)
  below `sm` for the first-class "kick a sync + watch it live from a phone" flow.
  `useMediaQuery('(min-width: 640px)')` (`@/hooks/use-media-query`, SSR-safe via
  `useSyncExternalStore`) mounts EXACTLY ONE surface per viewport — a CSS
  `hidden sm:block` split can't work here because both Dialog and Sheet **portal** their
  content to `document.body`, so mounting both would double the overlay + focus trap.
  Both surfaces are fed the same `state`/`run`/`stop` (one `useSyncRun` instance) and the
  same `open`/`setOpen`, so a run opened on one surface stays live if the viewport flips
  (rotation/resize) mid-run. The phone Sheet is a NEW inline wrapper — the dormant
  `SyncPanel.tsx` was NOT revived (it depends on the retired `JarvisProvider` and used a
  second `useSyncRun`).
- `SyncPanelBody.tsx` — the reusable panel content (written ONCE, shared with the
  dormant `SyncPanel.tsx`). Run button + a **"Dry run"** secondary button
  (classify-only; the first live full run should be a deliberate click) that becomes a
  **"Stop"** button while running (M5.1 — `variant=outline`, destructive-tinted;
  "Stopping…" while `cancelling`) + the **attached-run banner** ("A sync is already
  running (started HH:MM)") + a **non-fatal notice** line (e.g. "worker asleep —
  queued") + the overall `_run` progress line + employee cards + the **findings view** +
  narration footer. Chrome-agnostic. Takes a `stop` prop alongside `run`/`adjudicate`.
  **HONEST FINDINGS (2026-07-10):** it now computes `flattenRunFindings(state.result)`
  (memoized) and passes the flat `RunFinding[]` to `HeldRows` — NOT `state.heldGroups`.
  This is the keyhole fix: the panel shows EVERYTHING a run flagged (held rows + every
  reconciliation channel), not just `apply.held`.
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
  - **Copy all for Claude (2026-07-11):** a page header bar (above the list/detail split, hidden when
    there are zero non-triage cases) carries an open-case count + a **"Copy all for Claude"** button.
    It maps the visible cases (minus `run_triage`) into `SerializableCase[]` — extracting each case's
    investigator verdict word + one-line read via `asVerdict` (from `./labels`) — and clipboards
    `serializeCasesForClaude(cases, {runId})` → "Copied N cases" toast (failure → `errorToast`). The
    header run id is the deep-linked `?run=` id, else the single run all cases share, else null.
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
  - **FULL-DETAIL RENDERERS for EVERY case kind (2026-07-10, extended 2026-07-11)** — `CaseDetail`
    renders **`cases/FindingDetailCards.tsx`** (`<CaseFindingDetail kind row reason detail naturalKey />`)
    ABOVE the (now-dormant) AI verdict card. Every kind gets the SAME dense 3-part shape — a one-line
    plain summary, a compact fact table, a plain "what this means / what to do" line: **`block_diff`** —
    block_loc, a Sheet-vs-App-vs-Δ balance table (grand_total shows the two inventory totals), plus
    batch-identity fields for batch_mismatch/multi_batch + the `detail`; **`single_source_overdue`** —
    the lone source, the value, the date+batch+block, days overdue, and plainly "only <source> has this;
    the second report never arrived to confirm it"; **`attribution_diff`** — a proposed-vs-sheet
    comparison table (batch/block/weight per side) + "very likely the SAME physical feeding"; **`unmapped_batch_code`
    / `unresolved_batch`** — the batch code, the row (date/supplier/weight/block/reported-by),
    possible-match count, and plainly "this batch doesn't exist yet" (or "matches N batches — ambiguous");
    **`gate_failure`** (2026-07-11) — date/batch/block/weight/production-batch + flagged-date count, "the
    totals for X didn't reconcile… nothing saved", "check the flagged date(s) against the movement sheet
    and the proposed/daily report"; **`cross_batch_reassignment`** (2026-07-11) — batch/block/date/truck
    plate/sacks/weight + `db_conflict_batches` (tolerant of both the gsheet and deliveries `row` shapes),
    "same load, different batch… may have genuinely moved, or the source report has the wrong code";
    **`batch_auto_created`** (2026-07-11) — batch code, location (or "(feed / no block)"), date, block,
    source row, "created automatically — nothing needed, informational only". Every OTHER `HeldKind`
    (`location_occupied`, `malformed`, `low_confidence`, `already_exists`, `unmapped_or_missing_columns`,
    `below_since_floor`, `unresolved_shift`, `unresolved_batch_id`, `sub_watermark_suspected_dup`,
    `unmapped_bag_type_code`, `flagged`, `other`, and any future kind) falls through to
    **`GenericHeldDetail`** (2026-07-11) — dumps whatever primitive fields the row carries into the same
    fact-table shape + the case's own reason/detail as the summary, so no kind ever renders blank now that
    the AI verdict card is dormant. `source_diff` and `run_triage` deliberately return `null` here — they
    have their OWN dedicated cards (`SourceDiffCard`, `TriageSummaryCard`/`GroupResolutionCard`) rendered
    elsewhere; never duplicated. Presentation-only, imports ONLY contract types + `./labels`'s `kindLabel`.
  - **CREATE-BATCH resolution UI (2026-07-10)** — for an `unmapped_batch_code` / `unresolved_batch`
    case, `CaseDetail` renders **`cases/CreateBatchCard.tsx`** (below the finding detail). It shows the
    derived batch (code + `location_ref` — "FEED" badge for a feed batch — + status + starting weight +
    "unpriced") and the row it will write (`plan.unblock` — writer lane + identity fields; ambiguous →
    "creates the batch; the row(s) write on the next sync"). The plan is a CLIENT-SIDE **preview** from
    the PURE `buildCreateBatchPlan({kind, reportType, row})` until a proposal is open, then it renders
    the persisted proposal's plan. **"Create this batch"** → `onCreateBatch` → `proposeCreateBatch(caseId)`
    (writes nothing; persists a `propose_create_batch` assistant message); on an open proposal the same
    readout becomes a confirm card — **Confirm** → `executeCreateBatch(caseId, proposal_message_id)` (on
    success a toast of `created_batch`/`rows_written`/`warnings`; Realtime resolves the case) — **Decline**
    → `cancelProposal`. `CasesClient` restores a pending proposal on reload via the PURE
    **`findOpenCreateBatchPlan`** over the transcript (mirrors the pick-source restore). Chat + Quick
    Dismiss stay available. All errors → `errorToast()`. Client/server boundary: CreateBatchCard imports
    ONLY `CreateBatchPlan` + `FEED_LOCATION_REF` from `create-batch-plan.ts` — never a server module.
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
- `HeldRows.tsx` — **the panel's HONEST "needs review" list (rewritten 2026-07-10).** Was
  "held-row groups" reading only `apply.held` — a run that flagged TEN things showed ONE (the other
  nine lived in `result.reconciliation`). It now takes **`findings: RunFinding[]`** (the flattened
  `flattenRunFindings(state.result)`, computed in `SyncPanelBody`) + `runId`, and renders:
  (1) an **honest count header** — "N things need review" (`findings.length`, the true total);
  (2) a **by-kind breakdown chip row** ("3 overdue · 4 block · 1 unknown batch") via a compact
  `SHORT_KIND` map over `summarizeFindings().byKind`;
  (3) findings **grouped by `source`** (which file — the fastest way to pinpoint; groups ordered by
  their loudest finding), each a dense Excel-standard card: a severity dot + the `title`, the
  `kindLabel` badge + `location` (font-mono), font-mono **data chips** (batch/date/block/weight, or
  the two sides of a diff, or sheet-vs-app-vs-Δ for a block diff), and the plain `reason`; a per-card
  Copy button (everything copyable). Each source group keeps the **"Ask Claude → Sync Review"**
  doorway Link (`/sync/cases?run=<runId>`). The header row now also carries a **"Copy all for Claude"**
  button (2026-07-11) — `serializeFindingsForClaude(findings, {runId, runDate, status})` → clipboard →
  a "Copied N flags" success toast (failure → `errorToast`); `runDate`/`status` are threaded from
  `SyncPanelBody` (`state.startedAt.slice(0,10)` + `state.runStatus`). Zero findings → renders null
  (the existing clean state), so the button is naturally hidden when there is nothing to copy.
  The old per-kind `KIND_LABEL` map + the recommendation-glance layer are retired here (the plain
  labels now live on each `RunFinding.kindLabel`, built in `lib/sync/findings.ts`).
  **The card renderer is kind-AGNOSTIC** — it groups by `source`, ranks by `severity` and falls back
  `SHORT_KIND[kind] ?? kindLabel ?? kind` — so a new finding kind needs no component change, only a
  builder in `findings.ts` and (optionally) a `SHORT_KIND` chip word.

  **`stale_stream` — the freshness watch (2026-08-04).** The one finding that is about what did NOT
  arrive. Every other kind describes something the run saw; a run where a report simply never came in
  is otherwise indistinguishable from a quiet day, which is how RC OUT sat 5 days stale in July 2026.
  Worker side: `workers/sync/src/lib/streamStaleness.ts` reads `view_digest_stream_status` as Stage 3e
  (`runSync.ts::checkStreamFreshness`, non-fatal by contract — a watchdog that can fail the thing it
  watches is worse than no watchdog) and lands in `result.reconciliation.stale_streams`. App side:
  `StaleStream` in `app/(app)/sync/types.ts` (MIRROR), `collectStaleStreams` in `lib/sync/cases-fold.ts`,
  `fromStaleStream` in `lib/sync/findings.ts`. **The lateness arithmetic is NOT reimplemented** —
  `missed_working_days` already excludes rest days and not-yet-due next-day reports, so the threshold is
  a bare `> 0`; `>= 3` escalates to `high`. An unreadable/absent count is treated as NOT stale on
  purpose: an alert that cries wolf is an alert that gets ignored.
- `useSyncRun.ts` — the orchestration hook. `run(opts?)` calls `enqueueSyncRun`;
  **`stop()`** (M5.1) calls `cancelSyncRun(currentRunId)` (guarded against
  double-clicks via `cancelling`); subscribes (browser client) to `sync_run_events`
  INSERT (filtered by `run_id`) → per-card live progress, and `sync_runs` UPDATE
  (filtered by `id`) → terminal fold-in (per-report results → cards → held aggregation
  → narration; a **`cancelled`** run settles still-busy cards to `stopped` + a calm
  local summary, no error toast). **HONEST FINDINGS (2026-07-10):** `SyncRunState` gained
  **`result: SyncRunResult | null`** (the raw terminal payload, stored on fold-in, reset on a fresh
  run / attach) so `SyncPanelBody` can flatten the FULL findings list. The **`autoInvestigateRun`
  trigger now fires on `flattenRunFindings(result).length > 0`** (was `heldGroups.length > 0`) — so a
  run with reconciliation/block issues but ZERO held rows still fans out cases + investigates.
  **P3 (2026-07-06):** `finalizeRun` fires **`autoInvestigateRun(runId)` fire-and-forget** (`void …
  .catch(()=>{})`, never awaited so the modal never blocks) — the background investigator so cited
  verdicts are waiting on the review page (P4). Mount-time attach (with the staleness guard) + poll
  fallback as above. Returns `{ state, run, stop, adjudicate }`.

### Excel report download button (`components/sync/SyncReportButton.tsx`)
One client component, two mounts, zero duplicated logic:
- **`variant="panel"`** — a full-width outline button in `SyncPanelBody`'s footer, shown only
  when the finished run's own result carries a successful artifact pointer
  (`collectReportArtifact(state.result)`). **No extra query** — that pointer is exactly why
  the worker attaches it on success as well as failure.
- **`variant="inline"`** — a small "Excel" chip in each run header of
  `components/sync/cases/RunGroupedList.tsx`, rendered only for runs in `runsWithReports`
  (resolved once by `cases/page.tsx` via `getRunsWithReports`, threaded through
  `CasesClient`). The `NO_RUN_BUCKET` header never gets one — it is not a run.

On click it calls `getSyncRunReportUrl`, then clicks a synthetic `<a href download>`; because
the signed URL sets `Content-Disposition: attachment`, the file saves without navigating away
(no popup for a blocker to swallow). **Failures go through `errorToast()`** — persistent, with
a Copy button — never sonner's `toast.error`.

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
  **RB:** **`blockDiffFingerprint(d)`** → sha256 of `{kind:'block_diff', table:'blocking', subkind,
  block_loc, rounded sheet/computed kg (+ competing batches for `batch_mismatch` / count for
  `multi_batch`)}` (a changed balance/batch re-alarms; sub-kg jitter does not; a grand_total diff
  has no block_loc → one case per run); **`blockDiffNaturalKey(d)`** → the human label. The
  fingerprint picks its keys EXPLICITLY, so the grand-total residual fields added 2026-08-12
  (below) do **not** change any case identity.
- `lib/sync/cases-fold.ts` — **`collectHeldRows(result)`** → flattens
  `result.reports[type].apply.held` across all reports into `{reportType, held}[]`, guarding
  absent `reports` / `apply:null` / missing `held`. **R2:** **`collectSourceDiffs(result)`** →
  `result.reconciliation.rc_out.diffs ?? []` (guards the absent channel on pre-R2 runs). **R4a:**
  **`collectUnresolvedBatches(result)`** / **`collectSingleSourceOverdue(result)`** →
  `result.reconciliation.rc_out.unresolvedBatches ?? []` / `.heldOverdue ?? []` (optional additive
  fields — absent on pre-R4a runs). **RB:** **`collectBlockDiffs(result)`** →
  `result.reconciliation.blocking.blockDiffs ?? []` (optional channel — absent on pre-RB runs / no
  Blocking tab). **2026-08-03:** **`collectProductionBatchStarts(result)`** →
  `result.reports[type].apply.production_batch_starts ?? []` (only `production` ever fills it —
  optional additive field, absent on pre-feature runs). Pure, no supabase import.
- `lib/sync/findings.ts` (**PURE, CLIENT-SAFE — imports ONLY `types` + `cases-fold`; NO server
  imports, NO `node:crypto`**) — the honest READ model for the panel. **`flattenRunFindings(result)`**
  → `RunFinding[]`: merges INTO ONE array every `reports[*].apply.held[]` PLUS the whole
  `reconciliation` channel (`rc_out.diffs` → source_diff, `.heldOverdue` → single_source_overdue,
  `.unresolvedBatches` → unresolved_batch, `blocking.blockDiffs` → block_diff incl. the grand_total)
  PLUS the per-report announcement channels (`apply.auto_created_batches` → `batch_auto_created`,
  `apply.production_batch_starts` → **`production_batch_started`**, 2026-08-03).
  Each `RunFinding = {key, kind, kindLabel (plain phrase), source (plain "Google Sheet — RC IN" /
  "Blocking cross-check" / …), title, location, data (the ACTUAL values — weights/batch/date, NO ₱),
  reason, severity: 'info'|'attention'|'high'}`. **`summarizeFindings(findings)`** → `{total, byKind}`.
  Fixes the panel keyhole: a run that flagged 10 things but showed 1 (the other 9 lived in
  `reconciliation`). Pure/exhaustive/never-throws → `scripts/verify-findings.ts`.
  **AWAITING A PILE ASSIGNMENT — the quietest finding on the list (2026-08-13, L-042).**
  `collectAwaitingBatchAssignments(result)` → `result.reports[type].apply.awaiting_batch_assignment
  ?? []` (only `deliveries` fills it; optional additive field, absent on pre-feature runs) →
  **`fromAwaitingBatchAssignment`**, `kind: 'awaiting_batch_assignment'`, `section: 'deliveries'`.
  MC books overnight weights in early with only the truck plate, the weight and the moisture and
  assigns the pile later in the day; the deliveries classifier used to send those rows to MALFORMED,
  whose label reads **"Row could not be read"** — two on 2026-08-12, both self-fixed by morning.
  It is deliberately **NOT a held row**, so `ensureCasesForRun` never persists it and nothing has to
  be closed by hand, and it never touches `apply.errors` (no blocked watermark, no withheld Gmail
  label). But it is not silent either: **severity escalates with `days_pending`** — `info` at 0–1
  days (the ordinary same-day case) → `attention` at 2–3 (it did not self-clear overnight) → `high`
  at 4+ (the `fromUnpricedOverdue` threshold), measured against the run's **Asia/Manila** date. The
  escalation matters more here than for `unpriced_overdue`, because the row is **not in the
  database**: no unpriced check, no stale-stream check and no balance check can ever see it. Nothing
  in the Excel generator changed — `section: 'deliveries'` files it on the Deliveries sheet. Proof:
  `scripts/verify-awaiting-batch-assignment-fold.ts`. MALFORMED still reports separately and louder
  (an **orphan wet-recovery sub-row** stays there on purpose — see
  `workers/sync/specs/deliveries.md` §11.3).
  **THE BLOCKING GRAND TOTAL IS SEVERITY-SPLIT ON ITS RESIDUAL (2026-08-12, Renzo's ask).**
  `fromBlockDiff` used to hard-code `severity: 'high'` for every `grand_total` diff — and measured
  across **all 11 stored runs** that ever produced a block diff, the per-block gaps summed to the
  grand-total delta **exactly every time** (run `dc944b54`: 6,240 + 23,264 + 3,669 + 2,975 =
  36,148), so it fired as an emergency on essentially every run while re-stating what the block
  rows already said. The worker engine now supplies `residual_kg` = `delta − accounted_block_kg`
  (see `workers/sync/src/reconcile/CONTEXT.md` § B2's RESIDUAL for the arithmetic and the
  `delta`-vs-`(sheet − computed)` sign trap): **residual zero → `attention`** (the gap IS the
  flagged blocks summed; the reason line says so and calls it **consistent with** the Sheet
  lagging recent feeding, never asserting the cause) and **residual non-zero → stays `high`**,
  naming the unexplained kilograms — including the `accounted_block_count === 0` extreme where
  nothing above accounts for any of it. `fully_accounted` is read strictly as `=== true`, so a
  grand_total stored before 2026-08-12 (no such field) is UNKNOWN and stays `high` — fail-closed.
  All four numbers ride in `data` (`accounted_block_kg` / `accounted_block_count` / `residual_kg` /
  `fully_accounted`) so the Excel report's Details cell and the panel can filter and total them
  rather than parse a sentence; none matches `isCostKey`, so none is stripped. Per-block findings,
  tolerances, and what gets flagged are **unchanged**.
  **AND THE REASSURANCE IS A BADGE, NOT THE LAST SENTENCE OF A PARAGRAPH (2026-08-12, same day,
  Renzo: *"it shouldnt be in the description. It should be flagged or badged as 'POSSIBLE MISMATCH
  DUE TO LAG' or something like that"*).** The severity split above was correct and still invisible:
  the signal was the closing clause of a 3-line paragraph, which is exactly where nobody reads it.
  `RunFinding` therefore gained **`badges?: FindingBadge[]`** — `{label (SHORT, UPPER-CASE), tone:
  'caution' | 'neutral', hint}` — and a fully-accounted grand total carries exactly one,
  **`GRAND_TOTAL_LAG_BADGE`** = Renzo's wording verbatim. Three rules: **(1) the tone vocabulary is
  deliberately NOT the severity vocabulary** — there is no `danger` (severity already carries alarm;
  a red chip beside a red dot says nothing new) and no `success`, because a badge qualifies a
  finding that is still OPEN and nothing here is ever *verified* fine ("LIKELY, not definitely").
  **(2) The badge REPLACES the clause rather than duplicating it:** `blockDiffPresentation` trims the
  engine's `detail` down to the disagreement plus `Check the N blocks flagged above.` — cut at the
  first `).`, which ends the first sentence in BOTH shapes the engine emits, falling back to the full
  string when neither is found. The trim happens **app-side on purpose**: the prose is built in
  `workers/sync/src/reconcile/blockBalance.ts`, and a wording change must not cost a **Fly** deploy.
  The nuance the chip cannot hold (that the cause is only *consistent with* lag) moved into `hint`,
  rendered as a `title` tooltip — it was not thrown away. **(3) An UNEXPLAINED residual gets NO
  badge and keeps every word the engine wrote**, because that sentence names the kilograms nothing
  accounts for and is the whole point of the alarm. **`blockDiffPresentation(d)` is the ONE
  definition** of a block diff's label / title / badges / prose, exported for both renderers.
  **The Excel report needs no change and got the signal for free** — `workbook.ts` already writes
  `severity`, `What` = `kindLabel` and `Details` = `formatFindingData(data)`, so a fully-accounted
  total now reads `Attention` / *"Total inventory mismatch — fully accounted for"* /
  `fully_accounted=true; residual_kg=0`, and the `badges` array itself needs no column.
- **`components/sync/HeldRows.tsx` (the panel card) styles from SEVERITY; `FindingDetailCards.tsx`
  used to style from KIND — that was a real bug (fixed 2026-08-12).** `BlockDiffDetail` derived both
  its badge text and its **red** tint from `d.kind === 'grand_total'` alone, so a grand total whose
  gap the flagged blocks fully account for rendered exactly as alarmingly as one with kilograms
  nothing explains — no matter what severity the finding carried, and it would have gone on doing so
  right beside the new badge. It now reads `blockDiffPresentation`, red is reserved for
  `!fullyAccounted`, and the residual decomposition shows as three `FieldGrid` rows (**Blocks
  flagged / They account for / Unexplained**) where `0 kg` is a real value that must render. The
  panel card additionally chips **`UNEXPLAINED <n> kg`** from `data.residual_kg`. Badge classes per
  tone live once, in `components/sync/cases/labels.ts::FINDING_BADGE_CLASS` (outlined amber, both
  light and dark legs stated) — never red, never green, and **no animation**: a chip must be legible
  the instant the panel paints.
  **COPY-FOR-CLAUDE (2026-07-11):** two pure serializers turn a run's flags into ONE dense,
  self-contained diagnosis block to paste into a Claude Code session — a self-describing lead line,
  the **LOAD-BEARING run id** (`Run: <runId> · <date> · <status>` — lets the assistant query
  `sync_runs` / `sync_held_cases` for anything not in the dump), a `Total: N — <by-kind breakdown>`
  line, then every entry grouped by kind carrying source / location / the ACTUAL `data` values /
  plain reason. **`serializeFindingsForClaude(findings, {runId, runDate?, status?})`** (panel side) and
  **`serializeCasesForClaude(cases: SerializableCase[], meta)`** (review-page side — also folds each
  case's investigator `verdict` + one-line read). Both deterministic, never throw, emit NO ₱/cost
  (`formatData` strips any `cost|price|php|peso` key as belt-and-braces on raw case rows). Non-ASCII
  delimiters are `\uXXXX` escapes in source. Tested in `scripts/verify-findings.ts` (10 checks).
- `lib/sync/create-batch-plan.ts` (**PURE, CLIENT-SAFE — imports ONLY `types`**) — the create-batch
  core (mirrors `diff-plan.ts`'s pick-source split). `buildCreateBatchPlan({kind, reportType, row})`
  → `CreateBatchPlan {batch_code, fields (location_ref: block if valid `chk_location_ref_format` code
  else '' — empty = feed/no block, NEVER the 'FEED' sentinel [BUG B]; status STORED; current_weight
  0; avg_cost null), isFeed (= location_ref===''), writerLane: 'deliveries'|'rc_out'|null, unblock (the skipped row, no ₱),
  ambiguous, note?}`. `deriveBatchFields`, `readBatchCaseInput` (handles both the UnresolvedBatch row
  and the held `row`; a minimal `{mode,index}` row → null), `pickWriterLane` (unresolved_batch→rc_out;
  deliveries→deliveries; rc_out→rc_out; gsheet→row.mode). Plus the PURE proposal helpers the action +
  a UI share: `CREATE_BATCH_TOOL`, `parseCreateBatchInput`, `findOpenCreateBatchPlan(rows, status)`,
  `createBatchProvenance`, `createBatchRulingSummary`. Exercised by `scripts/verify-create-batch.ts`.
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
- `scripts/verify-findings.ts` — `npx tsx scripts/verify-findings.ts` runs 10 framework-free
  assertions over `lib/sync/findings.ts`: the real-run fixture (1 unmapped held + 3 overdue + 3 block
  balance + 1 grand_total + 1 unresolved = **9** findings) flattens with the right per-kind breakdown
  (proving the panel keyhole fix — was showing 1), each channel's kind/source/plain data, a source_diff
  also flattens (all 5 channels), and empty/manifest-only → `[]`. Plus **`serializeFindingsForClaude`**
  (run id + total + one line per finding + the actual numbers 8200/12500/3000 survive; empty → clean
  block) and **`serializeCasesForClaude`** (run id + verdict read + natural key present; a `cost_basis`
  key on the raw row is stripped). No DB.
- `scripts/verify-create-batch.ts` — `npx tsx scripts/verify-create-batch.ts` runs 9 framework-free
  assertions over `lib/sync/create-batch-plan.ts`: FEED (null/blank/invalid-code block) →
  `location_ref=''` + `isFeed`, a free-text/invalid block_loc falls back to '' not the 'FEED' sentinel
  (BUG B 23514 guard) + valid codes pass through verbatim, field defaults (STORED/0/null),
  writer-lane resolution (unresolved_batch→rc_out,
  deliveries→deliveries, gsheet mode→lane, writer-less→ambiguous), a minimal `{mode,index}` row → no
  plan, the ruling-summary shapes (created×rows), provenance, and the `parseCreateBatchInput` /
  `findOpenCreateBatchPlan` round-trip (decline closes). No DB.
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

## Excel sync report

Renzo's ask, verbatim: *"After a sync happens we should have the ability to have it generate a
report for us in excel form. All the loud things you said (warnings but proceeding to enrich
etc) should be reported in the excel sheet for an easier way for me to digest and track."*
Storage: *"automatic and stored. Just let me click a button to download when i choose to."*

**Where the code lives (all in the worker — `exceljs` is a worker dependency, not a root one):**

| File | Role |
|---|---|
| `workers/sync/src/reports/excel/findingsBridge.ts` | THE ONE worker→app import. Re-exports `flattenRunFindings` / `formatFindingData` / `isCostKey` from `lib/sync/findings.ts`. |
| `workers/sync/src/reports/excel/workbook.ts` | PURE builder: `(input) → { buffer, sheetCounts, findingCount, warnCount, errorCount, containsPrices }`. No DB, no network, no fs. |
| `workers/sync/src/reports/excel/generate.ts` | IMPURE: 3 scoped reads → build → Storage upload → `sync_run_reports` insert. **Never throws.** |
| `workers/sync/src/reports/excel/artifact.ts` | The `ReportArtifact` pointer type, alone so `reconcile/rcOutStage.ts` can reference it without pulling exceljs in. |
| `workers/sync/scripts/gen-run-report.ts` | Generate for any historical run: `--list`, `--out <path>`, `--persist`, `--fail`. |
| `workers/sync/test/reports/excel/workbook.test.ts` | 12 tests: clean-run completeness, the ₱ strip, section filing, both-values columns. |

**Why the worker imports app code.** The finding list has ONE definition and the project rule
forbids a second (`reuse the existing finding vocabulary; do not introduce a parallel
taxonomy`). A worker-local re-implementation would agree on the day it was written and drift
the first time a channel was added to only one of them. `lib/sync/findings.ts`,
`lib/sync/cases-fold.ts` and `app/(app)/sync/types.ts` are provably portable — no React, no
`@/` alias, no `next/*`, no `node:crypto`, and `types.ts` has **zero imports**. The forbidden
direction is app→worker (which is why `types.ts` hand-mirrors the worker's shapes); this is the
other way and it goes through one file, so reversing it is one import to move.
`workers/sync/tsconfig.json` therefore drops `rootDir` (unused — `npm run build` is esbuild and
`npm run typecheck` is `tsc --noEmit`). Verified: the app modules bundle into `dist/index.js`.

**`RunFinding.section`** (new field, `lib/sync/findings.ts`): the existing `report_type`
vocabulary plus `blocking` and `run`. Set by each builder — which already knows its lane — so
no consumer parses `key` or matches on the prose in `source` (the stale-stream `source` is a
dynamic stream label and prose matching would silently mis-file it). `staleStreamSection()`
maps `electricity`/`trucks` onto `production`, because that is the report that files them.

**The 11 sheets, always all present:**

1. **`Summary`** — the whole run on one screen: identity + timing + duration + outcome + mode;
   a **Verdict** line ("YES — 3 thing(s) are loud" / "clean run. Nothing was flagged
   anywhere."); HIGH / ATTENTION / info counts; warn + error beat counts; cases awaiting a
   decision; a **By section** table (Inserted / Updated / Dates replaced / Held-refused /
   Warnings / Errors / Flagged / Status); **Headline problems** (every HIGH + ATTENTION, capped
   at 25 with a "+ N more" line); a **How to read this** legend; and the generator version.
2–9. **One per section** — `Deliveries`, `RC OUT`, `Google Sheet`, `Blocking`, `RC Movement`,
   `Production`, `FLECON`, `Run`. Uniform 13 columns: `Severity` · `What` · `Source` · `Date` ·
   `Where` · `Batch` · `Weight (kg)` · `Days` · **`Side A`** · **`Side B`** · `Headline` ·
   `Why` · `Details`.
10. **`Awaiting Review`** — the `sync_held_cases` this run raised or re-raised
   (`last_run_id = runId`), with status, occurrence count, first/last seen, whether a known
   ruling exists, and the cost-stripped row data. Read from the TABLE, not the result, because
   a case's whole point is that it outlives the run that raised it.
11. **`Run Log`** — **every** progress beat, `Level` filterable. This is where a warning that
   never became a finding lives, and it is exactly where the August price outage hid: one
   `warn` beat reading "Price file unavailable — proceeding without prices" that died with the
   run while the file was in fact sitting there with an unrecognized tab name.

**`Side A` / `Side B` — both values, side by side.** The column pair Renzo asked for
("every fuzzy match, with BOTH values side by side"), generalized to every two-sided finding.
Each cell is `"<who>: <what>"`, so nobody has to remember which column is which:

| Finding | Side A | Side B |
|---|---|---|
| `price_fuzzy_match` | `ours: truck_plate T138003; supplier PAQUIBOT/COMPRA` | `Czarina: truck_plate 138003; supplier PAQUIBOT` |
| `price_tab_unresolved` | `looked for: August 2026` | `file has: Aug. 2026, Jul. 2026, March25` |
| `source_diff` | `proposed: weight_kg 6,497` | `gsheet: weight_kg 6,000` |
| `block_diff` | `sheet: 10,372,909 kg` | `app: 10,305,642 kg` |
| `attribution_diff` | `proposed: JULY-26-BLK6 @ F1` | `sheet: JULY-26-BLK5 @ F2` |
| `production_human_edited` | `yours: ttl_kg 13,685` | `report: ttl_kg 13,680` |
| `delivery_human_edited` | `yours: block_loc A-7C; sacks 540` | `source: block_loc C-10B; sacks 334` |
| `schedule_conflict` | `yours: shifts 2` | `Joseph: shifts 0` |

**`delivery_human_edited` has one rule the others do not: a `redacted` field prints its NAME
and nothing else** — both cells read `cost_basis (not shown)`. `cost_basis` is one of the nine
fields the 2026-08-08 deliveries human-edit latch can refuse, and the workbook is a **FILE**:
`sync_run_reports.contains_prices` gates its download on a MEASURED fact, so a single ₱ printed
here would flip that flag and lock the report away from the very people who need it. Both sides
arrive already null from the worker (`reports/deliveryHumanEdit.ts`, re-stripped in
`normalizeReport.ts`), so this branch cannot print a value it was not given — the explicit
branch exists to keep the cell readable rather than blank. Two writers raise this kind, the
emailed RC DELIVERIES report (`section: deliveries`) and the Google Sheet (`section: gsheet`),
so `collectDeliveryHumanEdits` loops every report rather than looking one up.

**Excel conventions.** Header row frozen on every sheet, autofilter over the full used range of
every table sheet, explicit column widths, wrap on the prose columns. **Severity is a TEXT
column** (`HIGH` / `ATTENTION` / `info`) with fill as a bonus — never colour alone. Plain
calendar dates are real date cells at **UTC noon** with `numFmt yyyy-mm-dd` (noon so no
viewer's offset can shift the day); full timestamps are TEXT rendered in **Asia/Manila** and
labelled `When (Manila)`, because an instant genuinely has a timezone and ISO-ordered text
still sorts chronologically. Numbers right-aligned, `#,##0`. **There is no accounting-format
currency column because there is no currency column** — see the ₱ gate under `reports.ts`.

**Generation, and why it can never hurt a run.**
- Wired as **Stage 4** of `runSync.ts`, after the result is assembled and **before**
  `finishRun`: the workbook renders `baseResult` (the exact object about to be persisted),
  then the artifact pointer is folded into the result `finishRun` writes. That ordering exists
  because a generation FAILURE has to reach the operator and `sync_runs.result` is the only
  durable channel to the panel. The workbook itself never contains its own pointer — a report
  cannot hold the record of its own failure.
- `generateRunReport` **never throws**; even the failure-row insert is best-effort. On
  `ok:false` `flattenRunFindings` raises a **`report_generation_failed`** finding
  (`section:'run'`, severity `attention` — nothing operational is wrong, the data is all in
  the DB and every finding is still on the list; only the downloadable copy is missing). On
  success the pointer is attached too, as provenance and so the panel needs no second query.
- **`failRun` / `cancelRun` generate one too**, with a NULL result, via
  `generateReportQuietly` (an extra try/catch because those paths are inside a `catch` that is
  about to re-throw the original error). A crashed run is precisely when the Run Log is worth
  reading.
- **Deterministic path** `<Asia/Manila date of started_at>/<run_id>.xlsx`, `upsert:true`. The
  date comes from the RUN, never `now()`, so regenerating an old report still lands in that
  run's folder; determinism also makes the upload idempotent under DBOS replay.
- **A clean run still produces a full workbook** (measured: 22,829 bytes, every sheet present,
  every section saying "Nothing flagged", 43 log beats). An empty report is a meaningful
  answer; a missing one is indistinguishable from a generator that quietly broke.

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
  (single-witness split + batch-resolution failures). **RB:** the channel now ALSO carries an
  optional `blocking: { blockDiffs: BlockDiff[], totals }` (the Sheet Blocking tab vs the computed
  `view_blocking_grid`; `worker: runSync.ts::reconcileBlockBalanceShadow`, read-only). Both
  `reconciliation.rc_out` and `.blocking` are OPTIONAL. App-side mirror types (`SourceDiff` /
  `SourceOpinion` / `ReconciliationChannel` / `UnresolvedBatch` / `SingleSourceOverdue` /
  `BlockDiff` / `BlockReconciliation`) live in `app/(app)/sync/types.ts`.
- **`sync_run_events`** — the live progress feed. `id`, `run_id`, `report_type`
  (the card key; `'_run'` = the top-level track), `stage`, `pct`, `label`, `detail`,
  `level`, `at`.

### Excel sync-report artifacts (migration `20260807060558_sync_run_reports.sql`)

- **`sync_run_reports`** — one row per generated (or attempted) workbook. `id`, `run_id`
  (→`sync_runs`, ON DELETE CASCADE), `storage_bucket` (default `sync-reports`),
  `storage_path` (**NULL exactly when `ok=false`**), `filename`, `bytes`,
  `finding_count`/`warn_count`/`error_count`, `sheet_counts` (jsonb: sheet name -> data row
  count), `contains_prices` (**NOT NULL DEFAULT TRUE — fail-closed**), `generator_version`,
  `ok`, `error`, `generated_at`. Indexes on `(run_id, generated_at desc)` and
  `(generated_at desc)`. RLS on; authenticated = **SELECT only** (base grant + `using(true)`
  select policy), no write policy or grant, `anon` revoked — same posture as `sync_runs`.
- **`view_sync_run_reports`** — `security_invoker` join of the artifact to its run: adds
  `run_status`, `started_at`, `finished_at`, `duration_seconds`, `dry_run` (read out of
  `result->'dryRun'`), `requested_by`, and `is_latest` (newest artifact per run). This is THE
  query behind "list the last N reports with a download link" — do not re-write the join.
- **Storage: the PRIVATE `sync-reports` bucket**, created in the same migration with the exact
  `sync-inbox` pattern (`public=false`, idempotent insert, **zero storage policies**). A
  separate bucket on purpose: `sync-inbox` holds raw source workbooks (Czarina's price file,
  MC's report) that no browser may ever fetch, while this holds a derived artifact the app
  deliberately hands to a privileged user. Verified on remote — the `/object/public/` route
  returns 400 "Bucket not found", a direct object read with the anon key returns 400, and an
  anon bucket list returns `[]`.

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
  `case_id`, `action` (`dismiss|apply|edit_apply|override_gate|pick_source|create_batch` — the
  `create_batch` value added by `20260710120000_sync_case_ruling_create_batch.sql`), `verdict_summary`,
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
- **Every run leaves an Excel report behind.** Generated + stored automatically at the end
  of every run — clean, partial, failed or stopped — and downloaded on demand through a
  60-second server-minted signed URL. Generation is the one stage that **cannot** fail a
  run: it never throws, and its own failure becomes a finding. See "Excel sync report".

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
