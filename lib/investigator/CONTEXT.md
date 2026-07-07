# CONTEXT — `lib/investigator/` (Smart Held-Row Adjudicator · P2 toolset + P3 loop)

## Purpose

The **investigative agent** for the Smart Held-Row Adjudicator (see
`SMART_ADJUDICATOR_PLAN.md`, "Functional spec — LOCKED v2", section A): a read-only tool-use
loop that, given ONE held-row case, figures out **who is wrong and what to do** — the same
way a chat session studies the data, cross-references sources, and pinpoints the outlier —
then records a cited verdict.

**Two phases live here: P2 (the 5 read-only tools) + P3 (the loop + playbook).** Every tool
is SELECT / READ-ONLY; the loop NEVER writes to an operational table, never applies / skips /
deletes. It investigates and records a verdict; the actual operational write stays
human-directed (P5). Adapted from the Jarvis loop (`app/(app)/jarvis/actions.ts`) + tools
(`lib/jarvis/tool-handlers.ts`) but scoped, allow-listed, and price-free by construction.

## Files

| File | Purpose |
|---|---|
| `tools.ts` | **P2 entry point.** `createInvestigatorTools({ runId, canViewPrices })` → `{ definitions: Anthropic.Tool[], execute(name, args): Promise<string> }`. Holds the 5 tool DEFINITIONS (descriptions written FOR the model) + the dispatcher + the query/dup/find-batches executors. Every executor returns a JSON string; never throws. |
| `allowlist.ts` | The static fence: `TABLE_ALLOWLIST` (per-table selectable columns, price cols already removed), `PRICE_COL_RE` / `isPriceColumn`, `resolveColumns` / `isAllowedColumn` (reject unknown/price columns), `scrubPriceKeys` (strip ₱ keys from every returned row). |
| `query.ts` | PURE query-plan builders — `buildQueryPlan` (query_table), `buildDuplicatePlan` + `groupDuplicates` (check_duplicates), `clampLimit`. Validate model args → structured plan WITHOUT touching the DB (so the plan is unit-testable). |
| `source.ts` | `read_run_source` — reads this run's fetched workbooks from the `sync-inbox` Storage bucket. `buildGridPayload` is the PURE, testable grid serializer (slice, stringify, trim, cap ~40KB). `SOURCE_KEYS` = the 7 storage keys. |
| `rules.ts` | `read_rule` — file-backed reader for the L-rule ledger (`RULES_DIGEST.md` line / `LEARNING_LEDGER.md` full entry). Pure slicers `extractDigestLine` / `extractLedgerEntry` + small fs cache. |
| `loop.ts` | **P3 entry point.** `runInvestigation(caseId, {escalate?, force?})` → `InvestigationOutcome`. Loads the case (service role), single-flight compare-and-swaps `status open→investigating` (the concurrency guard), builds the tools (`canViewPrices:false` HARD) + the terminal `submit_verdict` tool, drives the Anthropic tool-use loop (Sonnet default / Opus 4.8 on escalate; `MAX_ITERATIONS=8` + one grace iteration, `MAX_TOOL_CALLS=16`), PERSISTS the transcript to `sync_case_messages` as it goes (the "streaming" the UI watches over Realtime), then writes the `PersistedVerdict` onto the case (`status=investigated`). On ANY error: status back to `open` (never stuck) + a `system` error row. Exports the PURE, network-free pieces for the verify script: `parseVerdict`, `synthesizeUnconvergedVerdict`, `nextPosition`, `buildSystemRow`/`buildUserRow`/`buildAssistantRow`/`buildToolRow`, `SUBMIT_VERDICT_TOOL`. |
| `playbook.ts` | **P3 prompt layer (PURE).** `buildInvestigatorSystem()` = the diagnostic playbook (identity + read-only boundary + per-kind recipes + method rules + the jargon ban copied from `adjudication.ts`'s `ADJUDICATOR_SYSTEM` + the `submit_verdict` contract). `buildCaseBriefing(caseRow)` = the first user turn (report/kind/key/reason, the structured row incl. `drift_dates`, `occurrence_count`, known-ruling note). `buildChatAddendum()` (P4) now also carries a **RESOLVING** section teaching when to call `propose_resolution` (P5) — dismiss / apply / edit_apply, always "waiting for the reviewer to confirm," never "done." `BANNED_JARGON` exported for the register check. The SUSPECTED-DUPLICATE recipe carries the **L-034 month-boundary heuristic**: on the last/first day of a month, a row differing from a saved copy ONLY by the month name (e.g. "JUNE" vs "JULY", same day/weight/block/batch) is almost certainly already saved — no action needed (a kiln run crossing the boundary gets a next-month day-sheet header). |
| `resolution.ts` | **P5 propose_resolution (chat-mode ONLY, client-safe).** `PROPOSE_RESOLUTION_TOOL` + `executePropose(input, caseCtx)` — a WRITE-FREE tool that validates the proposal against the case (`parseProposal` + `checkEligibility`) and echoes it back; the persisted `tool_calls` jsonb IS the proposal (no schema change). Eligibility (enforced here AND in `resolve.ts`): dismiss on any unresolved case; apply/edit_apply ONLY per-row holds with a registered writer, NOT `gate_failure`; edit_apply needs `edited_row`. Also the PURE `findOpenProposal(rows, status)` open-proposal detector (latest un-actioned `propose_resolution` with no later ruling/decline) — shared by the UI + `resolve.ts`. Wired into the chat loop in `app/(app)/sync/case-chat.ts` (NOT `runInvestigation`). The actual write is `app/(app)/sync/resolve.ts`. |
| `CONTEXT.md` | This file. |

Verify scripts: `scripts/verify-investigator-tools.ts` (31 checks, P2) + `scripts/verify-investigator-loop.ts` (34 checks, P3 — playbook recipes, jargon absence, briefing rendering, `parseVerdict` accept/reject, synthesized verdict, position math + row builders). Both `npx tsx`, no network. The LIVE trust harness is `scripts/eval-investigator.ts` (P6) — see below.

## P6 — the eval + trust harness (`scripts/eval-investigator.ts`, 2026-07-07)

The **permanent** trust gate. Re-run it whenever `playbook.ts`, `tools.ts`, `loop.ts`, or the model changes. `npx tsx scripts/eval-investigator.ts [--case <name>] [--keep]`. Structure per case: seed → investigate → assert → cleanup (cleanup ALWAYS runs in a `finally`, deleting every seeded row, UNLESS `--keep`, which leaves them and prints their ids). Prints per-case PASS/FAIL with the quoted verdict summary, a budget table (secs + tool calls), and a final `N/5 eval cases passed` (exit 1 on any failure). **Isolation = synthetic rows only:** fake `sync_runs` (`result.summary='[eval-investigator synthetic run]'`) + a synthetic `2020-01-02` rc_out date + `production_batch='EVAL-DUP'` — it NEVER touches real 2025/2026 operational rows beyond SELECTs, so it is safe to run on the production DB repeatedly. It drives the REAL `runInvestigation()` (service-role admin client internally, no request context needed) + the REAL `caseFingerprint()`.

**The 5 cases:**
1. `june10-o-gt-m` — O>M gate (drift `db_sum 71,144 / movement 57,401 / excess 13,743`) → asserts `skip`/high-medium, names June 10 + 71,144, identifies the movement sheet as missing entries, ≥1 tool-sourced citation, ≤16 tool calls.
2. `may-proposed-overstated` — daily-report-vs-movement drift on 2026-05-15 (29,024 vs 28,087) + 2026-05-28 (59,142 vs 56,393) → asserts `skip`, both dates + the DB-matches-movement numbers, names the proposed report as the over-stater.
3. `seeded-true-dup` — TWO identical rc_out rows on `2020-01-02` (real batch_id resolved at runtime, 5,000 kg each) → asserts NOT `skip` (proves it does NOT rubber-stamp "DB is right"), identifies the duplicate, `check_duplicates` in the transcript.
4. `ledger-rematch` — NO model call. Reproduces `ensureCasesForRun`'s fingerprint-upsert logic directly (that server action needs a request cookie for `requirePrivileged`, unavailable in a tsx script): identical re-raise → occurrence bump + no dup case; delete-then-re-ensure → fresh case pre-annotated with `known_ruling_id`; CHANGED numbers → different fingerprint, new case, `known_ruling_id` NULL (re-alarm).
5. `write-safety` — snapshots COUNT(*) of rc_out/deliveries/batches/production_shifts/flecon_bag_movements before+after the model runs (rc_out count EXCLUDES the harness's own `EVAL-DUP` rows) → asserts unchanged; asserts the investigation tool set has NO write-like tool (`/insert|update|delete|write|apply|execute/`) and does NOT include `propose_resolution` (chat-only).

**Cost:** ~3 investigations on Sonnet ≈ cents. Budget observed (2026-07-07): june10 ~13 calls/~75s, may ~10/~49s, true-dup ~2/~20s — all well under the 16-call / 240s hard caps. **No separate `verify-eval-harness.ts`** was factored — the harness's pure helpers are trivial and fully exercised by the live run; a no-network verify would add surface for near-zero gain.

**Playbook fix this landed (2026-07-07):** the O>M recipe explained the duplicate branch but gave NO verdict for it, and the `submit_verdict` guidance nudged "skip is the common answer for feeding-total mismatches" — so `seeded-true-dup` returned `skip` (correct *reasoning*, wrong *label*) on two runs. Fixed minimally in `playbook.ts`: the duplicate branch now states the verdict is **`needs-human` (a person must DELETE a row), never `skip`**, and the skip guidance is scoped to "ONLY when the database has no duplicates." The two no-duplicate cases (1, 2) still return `skip` unchanged; `verify-investigator-loop` still 28/28.

## P3 — the loop + auto-trigger (2026-07-06)

- **Verdict** = `{verdict: apply|skip|needs-human, confidence: high|medium|low, summary, explanation, citations[]}` (each citation = `{claim, source}`). Persisted onto `sync_held_cases.verdict` as `PersistedVerdict` (+ `model`, `investigated_at`, `tool_call_count`).
- **Termination:** the loop ends when the model calls `submit_verdict`. If it burns the whole budget (incl. the grace iteration) without submitting → `synthesizeUnconvergedVerdict()` (`needs-human`/`low`). Malformed `submit_verdict` input → same synthesized fallback. **On the terminal `submit_verdict` turn the loop persists the assistant row AND a following `tool` row** carrying a synthetic `tool_result` for the verdict call (`{ok:true, note:'verdict recorded'}`) + a neutral placeholder for any sibling tool_use bundled with it. This closes the tool_use/tool_result pairing so the stored transcript is API-valid when `case-chat.ts` replays it — WITHOUT this, the assistant tool_use had no tool_result after it and the first chat message on every investigated case 400'd (`tool_use` ids without `tool_result`). Landed 2026-07-07.
- **Auto-trigger** lives in `app/(app)/sync/cases.ts`: `autoInvestigateRun(runId)` (concurrency-2 pool over fresh open, not-known-ruled cases) + `investigateCase(caseId, opts)` (single-case, escalate/force). Fired fire-and-forget from `components/sync/useSyncRun.ts::finalizeRun` when a run finishes WITH held rows.
- **Live-proof (2026-07-06):** a throwaway smoke reproducing the real June-10 O>M case (5 feedings = 71,144 kg, movement sheet 57,401 kg) reached verdict **`skip` / high confidence** — "the movement sheet is missing entries; the database is correct" — in **9 tool calls / ~60s**, citing real numbers from its own `query_table` + `check_duplicates` (and independently noticing all 5 rows share one `created_at`, ruling out re-insert). `read_run_source` found no files for the fake run (empty storage) and it concluded from DB queries alone — the intended graceful degradation.

## The 5 tools

1. **`query_table`** — scoped SELECT on an allow-listed table/view. Args: `table` (enum), `columns?` (allow-listed), `filters?` ({column, op ∈ eq|neq|gte|lte|like|in, value}), `order_by?`, `limit` (default 50, hard max 200).
2. **`check_duplicates`** — group-by-natural-key duplicate detector for a table + date/window. supabase-js can't do HAVING → bounded date-filtered fetch (≤500 rows) + in-memory grouping; returns groups with count>1.
3. **`read_run_source`** — generic grid dump of a stored source xlsx (`source_key` ∈ the 7 keys). Requires `ctx.runId` (else `{error:"no run attached to this case"}`). Returns `{file, sheets, sheet, total_rows, rows: string[][]}`, capped/paged.
4. **`find_batches`** — `ilike %q%` on `batches.batch_code` (min 3 chars), ≤20 candidates, NO `avg_cost`. Description warns of the month-prefix inconsistency (JAN vs MARCH vs SEPT…).
5. **`read_rule`** — L-0XX digest line (`full=false`) or full ledger entry (`full=true`); unknown id → error + nearby valid ids.

## Data

- **DB access:** `createAdminClient()` (`lib/supabase/admin.ts`, service-role, bypasses RLS) — instantiated per-call inside `execute`. query_table / check_duplicates run through an untyped PostgREST surface (`UntypedQueryClient`) because the table is runtime-chosen; the allow-list is the type-safety substitute.
- **Storage:** private bucket `sync-inbox`, path `<runId>/<key>/<filename>.xlsx`, keys = `deliveries, deliveries_czarina, rc_out, rc_out_movement, production_mc, production_waste, flecon` (written by the Mail Clerk, `workers/sync/src/workflows/mailClerk.ts`).
- **Rules files:** `.claude/skills/sync-ictc/RULES_DIGEST.md` (one line/rule under `## Digest`) + `.claude/skills/sync-ictc/LEARNING_LEDGER.md` (full entries under `### L-0XX · …`), path-anchored to `process.cwd()`.
- **xlsx:** SheetJS (`xlsx` ^0.18.5), already a project dep. No exceljs.

## Key behaviors

- **Price gating — 3 layers, and this surface NEVER returns ₱ regardless of `canViewPrices`:** (1) no price column is in any allow-list; (2) `buildQueryPlan`/`buildDuplicatePlan` reject any price-pattern column/filter/order/group_by; (3) `scrubPriceKeys` strips price-pattern keys from every returned row. `canViewPrices` is carried in ctx for app-parity but only ever *tightens*. This mirrors `app/(app)/sync/adjudication.ts` (held rows are a WRITE decision, not a cost view).
- **No raw SQL / no arbitrary columns.** Every table, column, op, source_key, rule_id is validated against literals. Bad input → a JSON `{error}` string the agent loop feeds back to the model.
- **Never throws.** Each executor try/catches to a JSON error string.
- **`read_run_source` runId guard runs BEFORE `createAdminClient()`** so a null run reports "no run attached" rather than an env error. Same for `find_batches` min-length.
- **Grid cap:** `buildGridPayload` halves rows once + flags `truncated` if the JSON exceeds ~40KB; clamps `max_rows` to 300, `MAX_COLS` 30, dates → ISO.

## Dependencies

- `@/lib/supabase/admin` (`createAdminClient`) — tools (per-call) + the loop (case + messages)
- `@/lib/anthropic/client` — `anthropic`, `INVESTIGATOR_MODEL`, `INVESTIGATOR_ESCALATION_MODEL`, `INVESTIGATOR_MAX_TOKENS` (loop.ts)
- `@anthropic-ai/sdk` (tools: type-only `Anthropic.Tool[]`; loop.ts: the real client via the wrapper)
- `xlsx` (SheetJS) — `read_run_source`
- `@/types/supabase` (`Json`; column lists were derived from it at authoring time)
- The two L-rule files under `.claude/skills/sync-ictc/`

## See also

- `SMART_ADJUDICATOR_PLAN.md` — the full P1–P6 roadmap; this covers **P2 (tools) + P3 (loop + auto-trigger)**, plus the **P5** `resolution.ts` propose tool (the confirm-gated write itself lives in `app/(app)/sync/resolve.ts`).
- `app/(app)/sync/cases.ts` — the case fan-out (P1) + the P3 server actions (`investigateCase`, `autoInvestigateRun`) that wrap `runInvestigation`.
- `app/(app)/sync/adjudication.ts` — the single-shot adjudicator (the "floor"); its price-safety + jargon ban are copied into `playbook.ts`. **Owned by a parallel agent — do not edit.**
- `app/(app)/jarvis/actions.ts` — the Jarvis tool-use loop this adapts (persisted transcript, per-iteration message rows).
- `workers/sync/src/workflows/mailClerk.ts` — writes the `sync-inbox` source files `read_run_source` reads.
