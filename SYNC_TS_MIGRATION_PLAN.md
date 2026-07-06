# Sync Engine → TypeScript + DBOS Migration Plan

_2026-07-04. Execution-ready plan, same format as CODE_AUDIT_PLAN.md. Decision locked by Renzo: **"One language, fully web-native, and I'm willing to re-earn the Python's hardening in TS."** Worthwhile risk accepted explicitly — the app is still in development._

## What we're building, in one paragraph

Today the sync engine is ~12,750 lines of Python that runs **on Renzo's Mac**, tied to his browser tab. After this migration it is a **TypeScript worker** wrapped in **DBOS** (durable execution — every step checkpointed into **our own Supabase Postgres**, crash → resume, no new state vendor), running on a small web-native cloud host. The click's only job becomes *writing "sync requested" into Supabase*; the worker does everything else and reports progress into Supabase tables the dashboard watches live. **Refresh, tab close, Wi-Fi drop, laptop off — irrelevant. Only Supabase down stops it** (the accepted failure line). Research basis: `handoffs/2026-07-04-durable-sync-job-research.md`.

## Locked decisions

| Decision | Choice | Why |
|---|---|---|
| Language | **TypeScript** (full port, no Python remains in the serving path) | One language, web-native, Renzo's explicit call |
| Durability | **DBOS-TS** (`@dbos-inc/dbos-sdk`), system DB = **our Supabase Postgres** | Autosave-per-step, state stays in our DB, Supabase-blessed pattern |
| Trigger model | **On-demand click** (no cron); enqueue row + HTTP kick; DBOS auto-recovers incomplete runs on worker start | Renzo wants chair-initiated syncs, not schedules |
| Mail fetching | **The Mail Clerk (PINNED)**: ONE IMAP session downloads all reports sequentially → **Supabase Storage** bucket; per-report workflows consume from Storage | Kills the Gmail burst-EOF problem at the source; artifacts survive crashes |
| Progress | `sync_runs` + `sync_run_events` tables + **Supabase Realtime** → the existing modal | Replaces stderr-NDJSON + SSE; same digestible-language contract |
| Safety strategy | **Golden-master parity harness**: the proven Python is the oracle; every TS port must match its classify output on a fixture corpus before cutover | This is how we "re-earn the hardening" deliberately, not hopefully |
| Python's fate | Kept in-repo as **oracle + manual fallback** (the Claude Code sync employees still work) until M6; never deleted this year | Insurance while TS earns trust |

## Migration surface (inventoried 2026-07-04)

~12,750 lines / ~30 files. Dependencies are minimal — the port is translation, not re-architecture:

| Layer | Python today | Lines | TS replacement |
|---|---|---|---|
| Gmail IMAP | `fetch_gmail.py` (stdlib imaplib, App Password, X-GM-RAW search, X-GM-LABELS) | 573 | `imapflow` + `mailparser` (both support Gmail extensions) |
| xlsx extraction | 9 `extract_*.py` (openpyxl) — **the crown jewels**: date carry-forward, header signatures, batch-code derivation, month tabs | ~4,450 | `exceljs` (streaming, style-aware) |
| Classification | 8 `classify_*.py` — pure diff/norm logic, natural keys | ~2,420 | Pure TS functions (most unit-testable layer) |
| Enrichment/deductions | `enrich_prices.py`, `lib/deductions.py` | ~640 | Pure TS |
| Reconciliation | `reconcile_*.py` ×2 (drift gates) | ~540 | Pure TS |
| DB writes | `lib/db.py` (requests → PostgREST + the 2 SECURITY DEFINER RPCs) | 345 | `@supabase/supabase-js` service client — **RPCs already exist, unchanged** |
| Orchestrators | 6 `sync_*.py` + `orchestrator_common.py` | ~2,560 | **DBOS workflows** (fetch → extract → classify → gates → apply → label → watermark as checkpointed steps) |

Rules that must survive the port (**the real deliverable**): L-001, L-004, L-006, L-007, L-008, L-013, L-018..L-021, L-024..L-028, **L-033a/b**, rounding/null↔0→NOOP, never-auto-create-batch/bag-type, never-delete, sheet-wins-material, replace-by-date, day-set-multiset, parent-shift-first FK order, generated-cols-never-written, header-signature column map, unmapped→FLAGGED, the two rc_out HARD gates, sub-watermark guard, label-only-on-full-success. Each becomes a **named test** in the parity suite — the port of a rule is DONE only when its test passes against the Python oracle's output.

## Target architecture

```
[Run Sync click]
   └─ server action: INSERT sync_runs(status=queued) → POST worker /kick (authed)
        │                                    (if kick fails: DBOS recovers queued runs on next wake)
[TS worker + DBOS  ·  small cloud host]
   1. MAIL CLERK workflow-step: one IMAP session → all attachments → Supabase Storage
   2. per-report child workflows (parallel, reading Storage):
        extract → classify → HARD gates → apply(--only-clean semantics) → held rows
        each step checkpointed in Supabase Postgres (crash = resume, not restart)
   3. progress → sync_run_events rows      4. results/held → sync_runs.result
[Dashboard modal]  ← Supabase Realtime subscription (no SSE, no child_process, no laptop)
```

**Worker home (the one open sub-decision, pick at M0):** ① **Fly.io machine with auto-stop/auto-start** — scales to zero, wakes on the HTTP kick, ~$0–3/mo (recommended); ② **DBOS Cloud** — zero-ops, free tier, but a second vendor; ③ Railway/Render worker — simplest mental model, ~$5/mo always-on. All three run the identical code; swapping later is cheap.

## Phases

### M0 — Foundations · S–M  ✅ **DONE (2026-07-04)**
Worker package (`workers/sync/` in-repo, own `package.json`, strict TS); DBOS wired to Supabase Postgres (its checkpoint tables live in a `dbos` schema); migrations: `sync_runs`, `sync_run_events` (+ RLS: authenticated SELECT own-org, service write), Storage bucket `sync-inbox`; secrets moved to worker env (GMAIL_USER/APP_PASSWORD, SERVICE_ROLE_KEY, kick shared-secret); host picked + deployed hello-world workflow. **DoD:** a dummy 3-step workflow survives a mid-run worker kill and resumes (proven, not assumed).

- [x] Standalone `workers/sync/` package — own `package.json` (`type:module`, Node ≥20), strict `tsconfig`, esbuild bundler (`dist/index.js`, 30KB, runtime deps external), tsx runner. NOT in the Next build.
- [x] DBOS `@dbos-inc/dbos-sdk@4.23.6` wired via `DBOS.setConfig({name, systemDatabaseUrl})` + `DBOS.launch()` (functional API — `registerWorkflow`/`runStep`/`startWorkflow`/`sleep`). System DB parameterized by `DBOS_DATABASE_URL`; DBOS auto-creates its `dbos` schema.
- [x] Migrations applied to remote (via MCP): `sync_runs`, `sync_run_events`. RLS enabled; `authenticated` gets **SELECT-only GRANT** + select policy; **no write policy/grant** (service_role writes, bypasses RLS — Phase-4 discipline). **Verified:** authenticated SELECT ok, INSERT denied (both tables). Both published to `supabase_realtime`.
- [x] Storage bucket `sync-inbox` (private) created via MCP; verified present.
- [x] Deploy artifacts: multi-stage `Dockerfile` (node:20-slim, non-root, healthcheck), `fly.toml` (auto_stop/auto_start, `min_machines_running=0`, internal port 8080), `.env.example` (all 6 secrets). **NOT deployed** — Renzo owns `flyctl`.
- [x] Kick endpoint: `src/server/kick.ts` — `POST /kick {runId}` (Bearer `SYNC_KICK_SECRET`) → `DBOS.startWorkflow(runSyncWorkflow, {workflowID:"run:<id>"})`; `GET /health`. Smoke-tested on the built bundle: health 200, unauth kick 401, authed kick 202.
- [x] **CRASH-RESUME PROOF (DoD): PASSED.** `scripts/run-crash-proof.sh` starts the 3-step demo (step2 durable-sleeps 10s), `kill -9`s the worker mid-step2, restarts → DBOS recovers. Evidence: step1 ran ONCE (checkpointed, not re-run), step2/3 completed in the resume pid; DBOS `workflow_status`=SUCCESS w/ `recovery_attempts=2`, `operation_outputs` has all 3 steps. **Ran against LOCAL Postgres** (Homebrew pg16 on :55432) because no Supabase DB password is available in the environment — the Supabase `DBOS_DATABASE_URL` is left documented in `.env.example` for prod (session-mode pooler / direct host + DB password; NOT the transaction pooler). **Honest note on semantics:** DBOS resumes from the last *completed step* — a step killed mid-execution (step2's sleep) re-runs on resume; a fully-completed step never re-runs. This matches the plan's intent (no re-download of a completed Gmail fetch).

### M1 — Shared libraries + the Mail Clerk · M  ✅ **DONE (2026-07-04)**
`gmail.ts` (imapflow: search/X-GM-RAW, download, label X-GM-LABELS), `xlsx.ts` (exceljs helpers matching openpyxl semantics — **see Risk #1**), `db.ts` (supabase-js + `write_ingestion_audit`/`stamp_ingestion_audit` RPCs), `norm.ts` (ports of `norm_num`, `norm_block_loc`, truck-plate normalization — with **exact-value** unit tests against Python outputs), `progress.ts` (event rows, digestibility rules from SYNC_CLI_CONTRACT.md carried over verbatim). Mail Clerk workflow: sequential single-session downloads → Storage. **DoD:** clerk fetches all 4 email reports' latest files to Storage in one session against real Gmail; norm functions pass value-parity tests.

- [x] `norm.ts` — exact ports of `norm_num`/`norm_int` (BOTH variants: deliveries `int(float)` trunc + gsheet `int(round)`), `norm_str`, `norm_block_loc`, `coerce_date`, `coerce_float`, `excelSerialToISO`. **Banker's rounding** implemented as a decimal-string round-half-to-even (CPython parity — a naive scale-and-round fails `2.675→2.67`, `0.135→0.14`, `0.145→0.14`). No `Math.round` in the sync path. Truck plate normalization = `norm_str` (verified: classifiers use `norm_str` on `truck_plate`).
- [x] **Value-parity fixtures GENERATED BY RUNNING THE PYTHON** (`scripts/gen-norm-fixtures.ts` → `python3 -c` oracle → `test/fixtures/norm-parity.json`). **127 cases** incl. .5 boundaries, `21789.0000001`, null/0 distinctions, both int variants. **All green.**
- [x] `db.ts` — supabase-js service client; `readRows` (paginated), `insert`, `insertIfAbsent` (L-020 re-check-before-insert, same natural-key semantics + `is.null` fallback), `update`, `writeIngestionAudit`/`stampIngestionAudit` RPCs, `upsertIngestionWatermark`, `dataWatermark`, sync_runs lifecycle. Error-string style mirrors `lib/db.py`.
- [x] `xlsx.ts` — exceljs helpers matching openpyxl `data_only` (formula → **cached result**), date cells → Date, merges (`getMergedValue`), 1-based `cell(row,col)`, sheet iteration. Fixture test against a real synthesized `sample.xlsx` (no ICTC xlsx present in repo/tmp).
- [x] `progress.ts` — `makeEmitter` → INSERT `sync_run_events`; clamp + **monotonic pct per (runId,reportType)** (parallel report tracks); never throws; SYNC_CLI_CONTRACT digestible-language rules carried verbatim as a comment block. Unit-tested.
- [x] **Mail Clerk** (`src/workflows/mailClerk.ts`) — ONE Gmail session; the 7 queries (4 report primaries + Czarina price + RC MOVEMENT reconcile) copied VERBATIM from the Python orchestrators; latest-xlsx pick per query → upload to `sync-inbox/<runId>/<report>/<file>` → manifest. Each upload is its own DBOS step (crash-safe). `runMailClerk` is a DBOS-free twin for tests.
- [x] **LIVE Mail Clerk test (DoD): PASSED** — `npm run mailclerk:live` (read-only, no label) fetched the latest xlsx for **all 7 queries in ONE session** against the real mailbox (~55s): RC DELIVERIES / PROPOSED DAILY REPORT / Daily Production Report / WASTE PRODUCTION REPORT / FLECON BAG MOVEMENT + Czarina price + RC MOVEMENT.
- [x] `tsc --noEmit` strict clean; `vitest` **149 tests green**.
- Follow-up (M3): live Mail Clerk downloads full message sources (55s for 7 large workbooks) — switch to `bodyStructure`-first + attachment-part-only download to cut fetch time.

### M2 — Golden-master parity harness · M — **the cornerstone** ✅ **DONE (2026-07-04)**
- **Fixture corpus:** real xlsx files pulled once (recent months of each report — the Python can do the pulling) + synthetic edge-case files per L-rule (the FLECON synthetic workbook pattern from July 2 already proves this approach) + **the A-19C L-033 incident replay** (test already exists in Python form).
- **Parity runner:** for each fixture, run Python `--phase classify --json` (oracle) and the TS classify; canonical-JSON diff. A report type may not cut over until parity = 100% on its corpus (or every diff is explained + accepted in writing).
- **DoD:** harness runs in CI (`npm run parity`), red/green per report type.

- [x] **Frozen port contract** — `workers/sync/src/reports/types.ts` exports `ClassifyCase = (workbookPaths, dbWindow, opts) => Promise<envelope>`. Wave-3 ports are built against these exact words; the runner discovers ported types by the existence of `src/reports/<type>/index.ts`, reports **MISSING** (not FAIL) for unported types.
- [x] **Fixture corpus — 12 cases / 6 report types** (`workers/sync/fixtures/**` + `manifest.json` per type with a `covers` rule list). **Real (7):** flecon, deliveries, rc_out, gsheet, production (MC+Ivy), rc_movement_audit — real workbooks reused from the recent `/tmp/sync-*/` runs (+ the gsheet link-shared export pulled once), each with a `db_window/<case>.json` DB snapshot. **Synthetic (5):** `flecon_edge` (signature-map reshuffle, F/G row-5 ambiguity disambiguated by row-3, unmapped column, multi-column blend row, both ZAMBOANGA spellings, balance snapshot, DATE_CHANGED) + `flecon_noop_reorder` (multiset order-independent NOOP); `deliveries_l033` (**the named A-19C L-033 replay** — phantom month-boundary batch → dup_noop, PILED-IN remark remap, date-carry-forward gap); `gsheet_edge` (materiality gate, sacks null↔0 immaterial, material remarks CHANGED, 2024 out-of-scope, MAN→MAIN typo); `rc_out_edge` (UNMAPPED batch + L-019 sub-watermark FLAGGED); `production_downtime_ge60` (**PD-5** — 125-min downtime the DB CHECK rejects, + L-026 combine candidates + L-027 dropped grade + L-025 blank-shift default).
- [x] **DB-window snapshots** (`fixtures/<type>/db_window/*.json`) captured via `scripts/snapshot_db.py` (uses the live `lib/db.py` for byte-identical shape) for real cases; hand-curated for synthetic cases. The harness feeds the SNAPSHOT to both engines — never the live DB — so parity is reproducible OFFLINE forever.
- [x] **Oracle builder** (`scripts/build_oracle.py`, `npm run build:oracle`) runs the PYTHON extract→classify path per case (offline, Supabase env scrubbed) and stores the canonicalized output as `fixtures/<type>/oracle/<case>.json`. Faithfully includes the orchestrator-level guard layers that are part of classify (deliveries L-033a/b + L-004 + low-confidence, ported verbatim in `scripts/parity_guards.py`). **Oracle stability PROVEN:** building the whole corpus twice yields byte-identical files (shasum-verified).
- [x] **Canonicalizer** (`test/parity/canonical.ts` + its exact Python mirror `scripts/parity_canonical.py`): sort keys, sort row arrays by natural key, textual float rule (integer-valued→int text; else round 9dp), strip volatile fields (paths/timestamps/uuids/`source_row`) via an explicit allowlist. Idempotent (unit-proven — the runner double-canonicalizes the on-disk oracle).
- [x] **Runner** (`npm run parity [-- --type <t>] [--verbose]`): canonicalize both sides, deep-diff to JSON-pointer paths, partition diffs into expected-deviation matches vs FAILs, colored diff on FAIL, summary table (type / cases / pass / dev / fail / missing / error), **exit non-zero on any FAIL**. STALE-deviation warning for ported types.
- [x] **expected-deviations.json** implements PORTING_DECISIONS #2–#5 (gsheet >50-NEW/confidence gate return-type fix, L-018 `decision` honored, gsheet true_weight/deduction written, production dt_mins≥60 split) as keyed expected diffs (rule + type + case + glob path). A diff matching an entry = PASS-with-note; anything else = FAIL.
- [x] **Unit tests** (`test/parity/*.test.ts`, vitest — 25 tests, **174 total green**): canonicalizer (key sort, row-array sort, float rule, volatile strip, idempotence), differ (paths, missing-side, type mismatch, index-aligned row diff), deviation matcher (glob, kind/value pins, staleness) + validates the shipped deviations file.
- [x] **Runner behavior proven end-to-end** (temp port, since removed): a port reproducing the oracle **PASSes**; a corrupted field **FAILs** with the exact JSON-pointer path + oracle/ts values; a matching deviation entry converts that FAIL to **PASS-with-note**. Un-ported types report **MISSING** cleanly, exit 0.
- [x] `tsc --noEmit` strict clean; `npm run parity` exit 0 (all 12 cases MISSING, awaiting Wave-3 ports); README "Golden-master parity harness" section added (layout, contract, how to add a case, how to record a deviation).
- **Flagged for Wave-3 (bugs found while building the oracle, do NOT port forward silently):** (1) `sync_production.py` writes each section as `{"rows":[…]}` but every `classify_production_*.py` reads `.get("<section>")` — so the lean orchestrator's runs/downtime/etc. are ALWAYS 0-classified; the oracle feeds a bare list so it exercises real classify LOGIC (the plumbing bug is an M3 apply-wiring concern). (2) The deliveries guard layer lives in `sync_deliveries.py` (not the classifier CLI) and is part of the classify envelope — Wave-3's `classifyCase` for deliveries MUST reproduce it (`scripts/parity_guards.py` is the executable spec).

### M3 — Port per report type, easiest → hardest · L (the bulk)
Order: **flecon** (simplest: replace-by-date, header signatures) → **rc_out** (+ the two HARD gates + reconcile) → **deliveries** (enrichment, deductions, L-004, L-033a/b) → **gsheet** (dual-mode, sheet-wins policy) → **production** (hardest: 3 extractors, 5 classifiers, 6 tables, parent-shift-first) → **rc_movement audit** (read-only). Per type: extractor + classifier + DBOS workflow → parity green → **live cutover for that type** (the worker serves it; Python stays as oracle). Apply semantics carried exactly: `--only-clean`, held rows, gate halts, label-on-full-success, watermark upsert.

### M4-worker — The real Run Sync workflow (end-to-end orchestration) · M  ✅ **DONE (2026-07-04, Wave 4A)**
The worker-side counterpart to M4's frontend cutover: the Mail-Clerk-only M0/M1 `runSyncWorkflow` becomes the REAL orchestrator that drives all six Wave-3 report ports end to end, durably, in the exact panel order. This is what makes a click actually *run* a sync.

- [x] **Real `runSync` workflow** (`src/workflows/runSync.ts`), workflowID `run:<runId>`. `sync_runs` lifecycle: queued→running (`started_at`) → **succeeded | partial | failed** (`finished_at`, `result` jsonb aggregating every report's envelope, `error` text on a whole-run failure), all via the service-role db as checkpointed DBOS steps.
- [x] **Stage 1 — Mail Clerk** as a child workflow (`mailclerk:<runId>`) → Storage manifest. gsheet's Sheet download is storage-ized inside its own report (`download.ts`), so every report reads from a stable source.
- [x] **Stage 2 — reports in EXACT panel order** (`app/(app)/sync/types.ts`): **gsheet first + alone** (source of truth) → **deliveries / rc_out / production / flecon in PARALLEL** (`DBOS.startWorkflow` fan-out + `Promise.allSettled` — DBOS-idiomatic child-workflow concurrency, verified against the SDK docs) → **rc_movement_audit last** (read-only). Each report is its OWN child workflow (`report:<runId>:<type>`), independently checkpointed.
- [x] **Deps wiring per report via thin workflow-layer adapters** (`src/workflows/reportDeps.ts` + `reportWorkflow.ts`) — Storage-download-to-tmp helper, Gmail labeler, `lib/progress` emitter bound to `(runId, reportType)`, and `lib/db` — adapted into each report's OWN deps type. **The Wave-3 reports were NOT reshaped.** The one additive change needed for deps unification: `DbClient.deleteByDate` (flecon REPLACE-BY-DATE apply reached into `db._session.delete` raw; now an explicit method — purely additive, no report logic touched).
- [x] **`dryRun` flag** (kick body `{runId, dryRun}`) — classify-only: a **write-blocking db proxy** (`makeDryRunDb`) passes reads through and no-ops every mutation (insert/update/insertIfAbsent/audit RPCs/watermark/deleteByDate), and the labeler no-ops. Events + the full result still flow. Proven to write **zero data rows** end to end.
- [x] **Failure isolation:** a report that throws returns an `ok:false` envelope carrying the error (`reportWorkflow` catches it, emits a warn beat); the other reports continue; run status = **partial**. HARD gates inside a report (rc_out drift/dup, rc_movement serious drift) do their own halting.
- [x] **LOCAL END-TO-END DRY-RUN PROOF (DoD): PASSED** (`scripts/dryrun-proof.ts`, local pg16 for DBOS). Inserted a `sync_runs` row (service role), kicked with `dryRun`, and PROVED: 60 events streamed into `sync_run_events`; all **6 reports produced classify envelopes against REAL live Gmail/Sheet + DB**; status transitioned `queued→running→partial`; full `result` jsonb with all 6 envelopes; `finished_at` set. **Independently verified ZERO data rows** written to audit_logs/deliveries/rc_out/flecon_bag_movements/production_shifts during the run window.
- [x] **CRASH-RESUME PROOF on the REAL workflow (DoD): PASSED** (`scripts/dryrun-crash-resume.ts`). Kicked a dry run, `kill -9`'d the worker mid-run (status stuck `running`), booted a FRESH worker → DBOS logged `Recovering 2 workflows…` and drove `run:<id>` to `partial` (6/6 reports, 60 events) with **no re-kick**. DBOS `workflow_status` shows all 8 workflows (run + mailclerk + 6 reports) SUCCESS for both runs; the 4 writers' staggered create/update timestamps confirm real parallelism.
- [x] `tsc --noEmit` strict clean; parity **12/12 unchanged**; `vitest` green (+ `test/workflows/reportDeps.test.ts` for the write-blocking proxy).
- [x] **Frontend contract confirmed** for Wave 4B: kick is `POST /kick` Bearer `SYNC_KICK_SECRET`, body `{runId, dryRun}` → 202; env vars the server action needs are **`SYNC_WORKER_URL`** + **`SYNC_KICK_SECRET`**.

### M4 — Frontend cutover · S–M  ✅ **DONE (2026-07-04, Wave 4B)**
Server action `enqueueSyncRun()` replaces spawn; `useSyncRun` swaps EventSource → **Supabase Realtime** on `sync_run_events` (card state shape unchanged — the digestible labels/pct contract is identical); modal gains "a run is already in progress — watching it" (multi-viewer for free); Held-row adjudication unchanged (already an app-side Anthropic call). **Retire:** `/api/sync/stream`, child_process, SYNC_MOCK (replaced by inserting fake event rows). **DoD:** click → close laptop lid → reopen later → run completed, full event history visible.

- [x] **`enqueueSyncRun(dryRun?)`** (`app/(app)/sync/actions.ts`) — `requirePrivileged` (unchanged gate, now returns the user id) → service-role INSERT `sync_runs(status=queued, requested_by)` via `createAdminClient()` → `POST ${SYNC_WORKER_URL}/kick` (Bearer `SYNC_KICK_SECRET`, body `{runId, dryRun}`, 5s AbortController timeout) → returns `{runId, kicked, message?}`. **Kick-failure UX:** a failed/timed-out/unconfigured kick is NON-fatal — the queued row survives (DBOS recovers it) and the action returns `{kicked:false}` with a human message ("Worker asleep — the run is queued and will start when the worker wakes"). Contract read from `workers/sync/README.md` + `kick.ts`.
- [x] **`useSyncRun` → Supabase Realtime.** Subscribes (browser client, authenticated SELECT) to `sync_run_events` INSERT (filter `run_id=eq.<id>`) → per-card state machine (report_type keys the card; `stage/pct/label/detail/level` map 1:1 to the digestible contract → the card components need ZERO changes) + a top-level `_run` overall track; and `sync_runs` UPDATE (filter `id=eq.<id>`) → terminal fold-in reads `result.reports` (per-report `ClassifyResult`/`ApplyResult`) → SAME held aggregation + narration + gate-failed card states (SyncPanelBody/SyncEmployeeCard/HeldRows untouched).
- [x] **Attach-to-in-flight (headline feature).** On mount the hook queries the latest `sync_runs` row; a non-terminal run is attached (reopened modal / second viewer / post-refresh session) with the "A sync is already running (started HH:MM) — watching it live" banner. A mount-time + on-subscribe catch-up query fills any gap between the row insert and the channel going live.
- [x] **Realtime-hiccup fallback.** On `CHANNEL_ERROR`/`TIMED_OUT` the hook polls the two tables every ~3s while the run is non-terminal (mirrors `notification-bell.tsx`'s degrade pattern).
- [x] **Modal polish.** Secondary **"Dry run"** button (classify-only; forwarded as `dryRun:true`) so the first live full run is a deliberate click; attached-run banner + non-fatal notice line in the body.
- [x] **Retired the old transport.** Deleted `app/api/sync/stream/route.ts` + `app/(app)/sync/mock.ts`; removed `runSyncClassify`/`runSyncApply` (child_process spawn) + all SYNC_MOCK plumbing from `actions.ts` (kept `adjudicateHeldRows`+`narrateSyncRun` — app-side Anthropic, unchanged). Dev testing WITHOUT the worker = insert fake rows (`scripts/dev-fake-run.ts` + `.md`).
- [x] **Types + env.** `types/supabase.ts` regenerated (adds `sync_runs`/`sync_run_events`; migration was applied to remote in M0); durable Realtime shapes + `SyncRunResult` contract added to `app/(app)/sync/types.ts`; root `.env.example` created documenting `SYNC_WORKER_URL` + `SYNC_KICK_SECRET` (+ existing keys).
- [x] **Pure reducer + verification.** Card-state transforms factored to `lib/sync/reducer.ts`; `tsc --noEmit` **0**, `npm run build` **0**; `npx tsx scripts/verify-sync-reducer.ts` drives the reducer with recorded Realtime payload shapes — **15/15 checks green**. RLS proven on remote: authenticated SELECT succeeds (the subscription's read path), authenticated INSERT denied; both tables in `supabase_realtime`.
- [ ] **DoD (needs Renzo's logged-in click + a deployed/local worker):** click → close laptop lid → reopen later → run completed, full event history visible. The wiring is proven offline (reducer harness + `scripts/dev-fake-run.ts` against a logged-in browser); the end-to-end lid-close proof needs the worker actually serving M3.

### M5 — Hardening & ops · S  🟡 **IN PROGRESS (2026-07-04, Wave 4A)**
Runbook (worker down? Gmail auth expired? DBOS resume semantics); Supabase Log drains/alerting on failed runs; `sync_runs` retention policy; kick-endpoint rate-limit; the Claude Code employees' docs updated to note they are now the manual fallback path, not the daily driver.

- [x] **Ops RUNBOOK** (`workers/sync/RUNBOOK.md`) — plain-language playbook: run stuck `queued` (worker asleep/dead → how to re-kick), Gmail auth expired (App Password rotation), Supabase down mid-run (DBOS resume semantics), re-running safely (idempotency — the report-level guards), reading `sync_run_events` for debugging, secret rotation, the exact **Fly deploy commands for Renzo** (`flyctl launch/deploy/secrets`), and how the Python oracle/employees remain the manual fallback.
- [ ] Supabase Log drains / alerting on `status='failed'` runs (deferred — needs a Supabase project-level integration).
- [ ] `sync_runs` retention policy (deferred — pick a window after a few weeks of real runs).
- [ ] Kick-endpoint rate-limit (deferred — the Bearer secret + idempotent workflowID make abuse low-risk; revisit if the endpoint goes public).
- [ ] Sync-employee docs note "manual fallback, not daily driver" (deferred to the M6 decommission decision — the employees are still the ONLY path until cutover is trusted).

### M5.1 — Sync-run lifecycle controls · S  ✅ **DONE (2026-07-06)**
Stop button + graceful cancel + self-healing (startup recovery + stale-run watchdog).

- [x] **Status model:** added `'cancelled'` to the `sync_run_status` enum (migration `20260706000000_sync_run_status_cancelled.sql`, applied to remote via MCP — `ALTER TYPE … ADD VALUE`, verified). `SyncRunStatus`/`TERMINAL_RUN_STATUSES`/`isTerminalRunStatus` updated; `SyncCardStatus` gains neutral `'stopped'`. `cancelled`/`stopped` render as a calm "Stopped", never error-red.
- [x] **Worker `/cancel`** (`src/server/kick.ts`, Bearer): cancels `run:<id>` (`cancelChildren:true`) + every child (`mailclerk:<id>`, `report:<id>:<type>`) explicitly; idempotent + `200` when no workflow exists. runSync/reportWorkflow catch `DBOSWorkflowCancelledError`/`DBOSAwaitedWorkflowCancelledError` → settle `cancelled` (not `failed`); **rows already written are kept** (no rollback).
- [x] **Startup recovery** (`recoverOrphanedRuns`) — re-starts every `queued` run from the last 24h on boot via deterministic workflowID (DBOS dedups). The root fix for a lost-kick `queued` run DBOS's own recovery can't reach.
- [x] **Stale-run watchdog** (`sweepStaleRuns`, every 3 min, `STALE_RUN_MINUTES=15`) — auto-expires (→ `failed`) non-terminal runs with no progress for >15 min that aren't a live DBOS workflow (`getWorkflowStatus` cross-check). Never expires a run that emitted an event in the last 15 min.
- [x] **App `cancelSyncRun(runId)`** — requirePrivileged → service-role UPDATE → `cancelled` (unsticks the UI even if the worker is unreachable) → best-effort `POST /cancel`. **Stop button** in `SyncPanelBody` (double-click-guarded via `cancelling`); `useSyncRun.stop()`; attach-to-in-flight **staleness guard** (ignore runs >20 min old / >15 min since last event).
- [x] **Verification:** migration applied + `cancelled` accepted (MCP); `tsc --noEmit` clean (root + worker); root `npm run build` + worker build clean; **lifecycle-proof.ts** (local PG) 20/20 (cancel/recovery/watchdog/SQL); parity 12/12; worker vitest 273; reducer harness 16/16.

### M6 — Decommission decision (deliberate, later)
Only after N clean weeks: archive the Python to `_archived/sync-python-v1/` (never delete — it is the oracle and the institutional memory). The LEARNING_LEDGER lives on — it documents *rules*, not a language.

## Risk register (the sharp edges, named now)

1. **Numeric/date parity between openpyxl and exceljs — the #1 silent-corruption risk.** Excel stores dates as serial numbers and floats with binary noise; Python `round()` uses banker's rounding, JS `Math.round()` doesn't. Mitigation: ALL rounding/normalization goes through `norm.ts` ports tested for **exact value parity** against Python on real data (M1), and the parity harness (M2) catches whole-file drift. No ad-hoc `Math.round` allowed in the codebase (lint rule).
2. **Gmail IMAP quirks** (X-GM-RAW search syntax, label mutation, UID vs sequence). `imapflow` supports the Gmail extensions, but the clerk gets its own integration test against the real mailbox on a `Blackwood-Test` label before touching real flows.
3. **The extraction layer is where the 33 lessons live.** Port it file-by-file *reading the Python as spec*, never from memory; every L-rule keyed test must be green. Budget says extraction is ~35% of lines but ~60% of the effort — plan accordingly.
4. **DBOS worker recovery semantics**: resume-on-start requires the worker process to actually start (Fly auto-start on kick covers it; a dead host + no kick = queued run waits — acceptable, visible in the modal as "queued").
5. **Secrets handoff** off the Mac (Gmail app password rotation moment — good hygiene anyway).
6. **Scope discipline:** this migration ports behavior 1:1. No feature additions, no "while we're here" — new ideas go to the ledger for after M6.

## Effort & cost honestly

- **Effort:** M0–M2 ≈ 2–3 working sessions; M3 ≈ 5–8 sessions (production alone ≈ 2–3); M4–M5 ≈ 2 sessions. **Total ≈ 9–13 sessions** of the kind we've been running. Parallelizable per report type after M2.
- **Running cost:** Fly auto-stop ≈ $0–3/mo; DBOS = $0 (library; state in existing Supabase); Storage negligible. Anthropic usage unchanged (adjudication/narration only).

## What does NOT change

The DB write contracts (both RPCs, audit shapes, natural keys, watermarks), the HARD gates' thresholds, the held-row philosophy (uncertain → human, never auto-write), the digestible-progress language rules, price gating, the modal UI (only its data feed changes), and the Claude Code employees as manual fallback.
