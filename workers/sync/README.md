# Blackwood Sync Worker (`workers/sync`)

Durable, web-native TypeScript port of the ICTC sync engine, wrapped in **DBOS**
(durable execution — every workflow step checkpointed to Postgres, crash → resume).
This is a **standalone package**, NOT part of the Next.js build. It runs on a small
cloud host (Fly.io, scale-to-zero) and is woken by an HTTP kick from the app.

> Status: **M0–M3 complete + M4-worker complete (2026-07-04, Wave 4A).** The real
> `runSyncWorkflow` now drives all six Wave-3 report ports end to end, durably, in the
> panel order. Proven with a local end-to-end dry-run AND a crash-resume on the real
> workflow. M5 runbook shipped (`RUNBOOK.md`). Migration plan: `../../SYNC_TS_MIGRATION_PLAN.md`.

## Architecture

```
[Run Sync click]  →  server action: INSERT sync_runs(queued) → POST worker /kick {runId, dryRun?}
[worker + DBOS]
  runSyncWorkflow  (run:<id>)          (top-level durable workflow)
    ├─ mailClerkWorkflow (mailclerk:<id>)   ONE Gmail IMAP session → all report files
    │      → Supabase Storage: sync-inbox/<runId>/<report>/<file>
    ├─ report:<id>:gsheet               gsheet FIRST + alone (source of truth; self-downloads)
    ├─ report:<id>:{deliveries,rc_out,production,flecon}   the 4 writers IN PARALLEL
    │      (DBOS.startWorkflow fan-out + Promise.allSettled)
    └─ report:<id>:rc_movement_audit    read-only auditor LAST (never writes)
  status   → sync_runs: queued→running→succeeded|partial|failed  (result jsonb, error text)
  progress → sync_run_events rows      (Supabase Realtime → the modal)
```

Each report is its own child workflow (independently checkpointed). A report that throws
is isolated — it returns an `ok:false` envelope and the run finishes `partial`; the others
continue. **`dryRun`** (kick body) is classify-only: a write-blocking db proxy no-ops every
mutation, so a run proves out end to end without writing data.

Only **Supabase down** stops a run. Refresh / tab close / laptop off are irrelevant —
the click just writes "sync requested"; the worker does the rest durably.

## Layout

| Path | What |
|---|---|
| `src/lib/norm.ts` | EXACT ports of Python `norm_num`/`norm_int`/`norm_str`/`norm_block_loc`/`coerce_date`/`coerce_float`. **Banker's rounding** (round-half-to-even) — no `Math.round` anywhere. |
| `src/lib/db.ts` | Supabase service client + typed wrappers (readRows/insert/insertIfAbsent/update, `write_ingestion_audit`/`stamp_ingestion_audit` RPCs, sync_runs lifecycle). Mirrors `lib/db.py`. |
| `src/lib/gmail.ts` | imapflow + mailparser: X-GM-RAW search, download, X-GM-LABELS label, latest-xlsx pick. Single-session reuse (60s `connectionTimeout` so a connect stall errors fast). `searchLatestAttachment` = the FAST path: metadata-first (envelope + bodyStructure, no source) then downloads ONLY the newest xlsx **part** (`findAttachmentPart` → `download(uid, part)`), not the full rfc822 source. |
| `src/lib/xlsx.ts` | exceljs helpers matching openpyxl `data_only` semantics (formula → cached result, date cells, merges, sheet iteration). |
| `src/lib/progress.ts` | `emitEvent` → `sync_run_events`; monotonic pct per (run,report); digestible-language rules carried verbatim; never throws. |
| `src/dbos.ts` | DBOS config + launch/shutdown. |
| `src/workflows/demo.ts` | The M0 crash-resume proof workflow (toy 3-step). |
| `src/workflows/mailClerk.ts` | The PINNED Mail Clerk (one session → Storage manifest). Emits **live progress DURING the fetch** (pct 4→25): "Connecting to Gmail…" → per report "Looking for RC DELIVERIES…" / "Found RC DELIVERIES (85 KB)" / "Downloaded 3 of 7 reports…", real filenames+sizes, ≤2 beats/report. Fetches attachment-part-only via `searchLatestAttachment`, with a per-report fallback to the full-source path (correctness beats speed). `runMailClerk(params, onProgress?)` is the DBOS-free variant for tests. |
| `src/workflows/runSync.ts` | **The real top-level Run Sync workflow** — status lifecycle + Mail Clerk + all 6 reports in panel order + result aggregation + failure isolation. Also **Stage 2b′** (the post-writers creation-race re-resolve pass — `resolveCreationRaceHolds` + the read-only `creationRaceRecordExists` probe) and the two shadow reconcile steps. |
| `src/workflows/creationRaceHolds.ts` | **Post-writers creation-race re-resolve pass (Fix 1).** gsheet classifies BEFORE the parallel writers run, so a BRAND-NEW batch created by the deliveries/rc_out writer ~1s later leaves gsheet holding the row `unmapped_batch_code` — a pure timing artifact. After the writers finish, this pass reloads a FRESH `batch_code→batch_id` lookup and re-resolves each such hold: RESOLVES + sibling wrote the record → **AUTO-CLEAR** (drop the hold; the app never opens a case for it); RESOLVES but no record → **KEEP + reclassify** reason/detail (never auto-write — a policy call); STILL unresolved → keep as `unmapped_batch_code` (the real human case). PURE except the injected read-only `recordExists` probe; NEVER writes an operational table, NEVER mutates its input (returns a rebuilt held array + telemetry `{autoCleared, reclassified, keptUnmapped}`); runSync guards it (any failure → holds kept as-is). `kind` of a reclassified row STAYS `unmapped_batch_code` on purpose (the frontend `KIND_LABEL` is an exhaustive `Record<HeldKind,…>` in components/). Proof: `test/workflows/creationRaceHolds.test.ts`. |
| `src/workflows/reportWorkflow.ts` | The per-report CHILD workflow — dispatches to each report's `runReport`, normalizes into the frontend `SyncRunReportResult` envelope (via `normalizeReport.ts`), isolates failures. Also `panelCardKey()` — maps worker `rc_movement_audit` → panel card `rc_movement` for both events + result. |
| `src/workflows/normalizeReport.ts` | **Assembly-boundary normalizer** (worker-side mirror of `app/(app)/sync/types.ts`). Maps each report's flat `runReport()` apply into the nested contract: `apply.applied={inserts,updates,replaced_dates}` ALWAYS present, `apply.held` = full `HeldRow[]` ROWS (with the enrichment fields `kind`/`row`/`source_index` passed through verbatim), read-only/dryRun → `apply:null`. So `sync_runs.result.reports[<type>]` is byte-for-byte what the app reads. Proof: `test/workflows/normalizeReport.test.ts` + app-side `scripts/verify-sync-reducer.ts`. |
| `src/reports/held.ts` | **Shared held-row enrichment vocabulary (2026-07-06).** The `HeldKind` enum + the human-label builders (`rcOutKey`/`deliveriesKey`/`fleconKey`/`label`/`fmtKg`) every report's `apply.ts` uses to build a DECISION-GRADE held row: `kind` (normalized category), `natural_key` (a HUMAN label, never an index), `row` (KEY fields for the app's DB lookup — **NEVER a ₱/cost field**), `source_index` (the former index, kept for apply-input mapping). Only changes how held rows are DESCRIBED — never WHICH rows are held (classify/apply decisions untouched → parity unchanged). |
| `src/workflows/reportDeps.ts` | Workflow-layer ADAPTERS: Storage-download-to-tmp, Gmail labeler, progress emitter, and the **write-blocking dry-run db proxy**. Wires each report's own deps type (reports are NOT reshaped). |
| `src/server/kick.ts` | `POST /kick` + **`POST /cancel`** (both Bearer auth) + `GET /health`. |
| `src/server/selfHeal.ts` | **Startup recovery** of orphaned `queued` runs (`recoverOrphanedRuns`) + the periodic **stale-run watchdog** (`startStaleRunWatchdog` / `sweepStaleRuns`, `STALE_RUN_MINUTES=15`). |
| `src/workflows/ids.ts` | The ONE source of truth for the workflow-ID scheme (`run:` / `mailclerk:` / `report:<id>:<type>`) — used by /cancel, recovery, and runSync. |
| `src/index.ts` | Entrypoint: register workflows → launch DBOS → **recover orphaned runs** → start kick server → **start the watchdog**. |

## Setup

```bash
cd workers/sync
npm install
cp .env.example .env      # fill in the secrets (see below)
```

### Required env (see `.env.example`)

- `GMAIL_USER`, `GMAIL_APP_PASSWORD` — Gmail App Password (never OAuth).
- `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` — service role (bypasses RLS).
- `DBOS_DATABASE_URL` — **direct** Postgres for DBOS checkpoints. **Not** the
  transaction-mode pooler. Use the Supabase **session-mode** pooler (port 5432) or
  the direct DB host, with the **database password** (Supabase dashboard →
  Settings → Database — not in this repo).
- `SYNC_KICK_SECRET` — shared secret for `POST /kick` (`openssl rand -hex 32`).

### Optional env — feature flags

- `SYNC_RCOUT_RECONCILE_CUTOVER` — **R4b rc_out cutover. DEFAULT ON** (unset = ON;
  reader in `src/lib/env.ts`). **ON:** gsheet-sync does **not** write `rc_out` (neither
  Sheet-wins UPDATEs nor NEW inserts — the gate is at the `applyGsheet` boundary in
  `src/reports/gsheet/apply.ts`, and the rc_out **mode is skipped whole**). The **PROPOSED
  report** (`rc-out-manager`) is the **sole rc_out writer**; multi-source reconciliation
  (`src/reconcile/`) is the flagging authority — a gsheet↔proposed disagreement **in the
  proposed-span window** becomes a `source_diff` / `single_source_overdue` case in Sync
  Review instead of a silent overwrite. This makes the **L-037 clobber structurally
  impossible.** **OFF** (`off`/`false`/`0`/`no`) = exact prior "Sheet-wins rc_out" behavior —
  a one-line production revert. **`rc_in`/deliveries writes are unchanged in both states.**
  Fail-safe: with the cutover ON, if the `batch_code→batch_id` lookup is empty/unbuildable,
  the reconcile step **skips rc_out flagging for that run and emits one diagnostic** rather
  than flooding `unresolved_batch` cases (proposed's own writes are unaffected).

## Run

```bash
npm run typecheck        # tsc --noEmit (strict)
npm run test             # vitest — norm parity + gmail/xlsx/progress helpers
npm run build            # esbuild → dist/index.js
npm start                # node dist/index.js  (launches DBOS + kick server)
npm run dev              # tsx watch src/index.ts
```

### Kick a run

```bash
curl -X POST http://localhost:8080/kick \
  -H "Authorization: Bearer $SYNC_KICK_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"runId":"<uuid from sync_runs>"}'
```

`GET /health` → `{ ok: true }`.

### Stop a run (graceful cancel — M5.1)

```bash
curl -X POST http://localhost:8080/cancel \
  -H "Authorization: Bearer $SYNC_KICK_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"runId":"<uuid from sync_runs>"}'
```

`POST /cancel` cancels the parent workflow `run:<runId>` (`cancelChildren:true`) **and**
every child (`mailclerk:<runId>`, `report:<runId>:<type>`) explicitly. It is idempotent
and **safe when no workflow exists** for that runId (the never-started / queued-and-lost
case) — it always returns `200 {ok:true}`. The workflows catch the cancellation and
settle the run to **`cancelled`**; **rows already written are KEPT** (never rolled back).
The app's Stop button also flips `sync_runs.status='cancelled'` directly (service role)
so the UI unsticks even if the worker is unreachable.

### Self-healing (M5.1)

- **Startup recovery** — on boot, after `DBOS.launch()`, the worker re-starts every
  `sync_runs` row still `queued` in the last 24h using its deterministic workflowID
  (`run:<id>`). DBOS dedups, so an already-started/recovered run is never double-run.
  This is the fix for a run stuck on `queued` because its kick was lost while the worker
  slept — DBOS's own recovery can't help there (the workflow was never created).
- **Stale-run watchdog** — every 3 min the worker sweeps non-terminal runs (queued|
  running). A run whose newest `sync_run_events.at` is >`STALE_RUN_MINUTES` (15) old —
  or which has no events and was created >15 min ago — **and** is not a live DBOS
  workflow (cross-checked via `getWorkflowStatus`) is auto-expired to `failed` with a
  clear message. A run that emitted an event in the last 15 min is NEVER expired.

## Tests & proofs

- **Norm parity (the #1 risk):** `npm run gen:fixtures` runs the ACTUAL Python
  `norm_*`/`coerce_*` and writes `test/fixtures/norm-parity.json`; `npm test`
  asserts the TS ports reproduce every value (incl. `.5` boundaries and binary-noise
  floats like `2.675 → 2.67`, `0.135 → 0.14`). 127 value cases.
- **xlsx fixture:** `npm run gen:fixtures` also has a sibling
  `scripts/gen-xlsx-fixture.ts` (synthesizes `test/fixtures/sample.xlsx`) exercised
  by `xlsx.test.ts` — proves `data_only` formula results, date cells, empty cells.
- **Crash-resume proof (M0 DoD):**
  ```bash
  DBOS_DATABASE_URL=postgresql://postgres@127.0.0.1:5432/dbos_sync \
    bash scripts/run-crash-proof.sh
  ```
  Starts the demo workflow, `kill -9`s the worker mid-step-2, restarts, and asserts
  DBOS resumed from the last completed step (step 1 not re-run). Verified against a
  local Postgres (see "DBOS system database" below).
- **Live Mail Clerk (M1 DoD, READ-ONLY):**
  ```bash
  SINCE=2026/06/28 npm run mailclerk:live
  ```
  Fetches the latest xlsx for all report queries over ONE Gmail session and prints
  the manifest. Never uploads / never labels (`dryRun`). Also prints the **live
  per-report progress lines** (a console `onProgress` logger with elapsed-time +
  pct), so you can watch the fetch move report-by-report. With attachment-part-only
  downloads a full 7-report fetch runs in ~65–110s (was ~2m40s pulling full message
  sources); bytes/filenames are byte-identical to the old path.
- **End-to-end DRY-RUN proof (M4-worker DoD):**
  ```bash
  # needs a filled .env (Gmail + Supabase service role + DBOS_DATABASE_URL + SYNC_KICK_SECRET)
  npm run build
  npx tsx scripts/dryrun-proof.ts
  ```
  Inserts a `sync_runs` row, boots the worker, kicks with `dryRun`, and asserts all 6
  reports produce classify envelopes against LIVE Gmail/Sheet + DB, events stream into
  `sync_run_events`, and the run finishes with a full `result` jsonb — **writing zero
  data rows**. (Verified: `queued→running→partial`, 60 events, 6/6 reports.)
- **CRASH-RESUME on the REAL workflow (M4-worker DoD):**
  ```bash
  npx tsx scripts/dryrun-crash-resume.ts
  ```
  Kicks a dry run, `kill -9`s the worker mid-run, boots a FRESH worker → DBOS recovers
  `run:<id>` and drives it to completion with no re-kick. (Verified: `Recovering 2
  workflows…`, second pid finished the run, all 8 workflows SUCCESS.)

- **Lifecycle-controls proof (M5.1 DoD):**
  ```bash
  # against a LOCAL Postgres (the sandbox can't reach Supabase on 5432):
  DBOS_DATABASE_URL=postgresql://postgres@127.0.0.1:55432/dbos_sys \
  PROOF_PG_URL=postgresql://postgres@127.0.0.1:55432/postgres \
  LC_ALL=C npx tsx scripts/lifecycle-proof.ts
  ```
  20 checks across four parts: **(A) graceful cancel** — a running workflow is
  cancelled mid-sleep, the body CATCHES `DBOSWorkflowCancelledError` (→ 'cancelled',
  not 'failed'), post-cancel work never runs, pre-cancel "applied" evidence is kept
  (nothing rolled back), DBOS status → CANCELLED; **(B) recovery dedup** — the same
  deterministic workflowID runs exactly once across two `startWorkflow` calls;
  **(C) watchdog cross-check** — `getWorkflowStatus` reports PENDING while live,
  CANCELLED after; **(D) sync_runs SQL semantics** (local PG) — stale runs expire,
  FRESH runs don't, and the status-guard never clobbers a terminal run. ALL PASSED.

## Golden-master parity harness (M2 — `npm run parity`)

The **hard gate** every Wave-3 report port must pass before cutover. The proven
Python classify path is the **oracle**; each TS port must reproduce its output
(canonicalized) on a fixture corpus. Any un-explained byte difference fails.

```bash
npm run parity                 # all report types
npm run parity -- --type flecon        # one type
npm run parity -- --verbose            # show matched deviations + all cases
```

Exit non-zero on any FAIL. A type with no TS port yet reports **MISSING** (not a
failure) — the gate goes green as ports land.

### Layout

| Path | What |
|---|---|
| `fixtures/<type>/workbooks/*.xlsx` | real (pulled once) + synthetic edge-case workbooks |
| `fixtures/<type>/db_window/<case>.json` | snapshot of the DB rows the classify step consumes — the harness feeds THIS to both engines, never the live DB, so parity is reproducible offline forever |
| `fixtures/<type>/oracle/<case>.json` | canonicalized Python classify output (the golden master) |
| `fixtures/<type>/manifest.json` | case registry: workbooks, db_window, opts, and the `covers` rule list |
| `src/reports/types.ts` | the **frozen `classifyCase` contract** Wave-3 ports implement |
| `test/parity/canonical.ts` | the ONE canonicalizer (mirrored in `scripts/parity_canonical.py`) |
| `test/parity/differ.ts` / `deviations.ts` / `runner.ts` | diff + expected-deviation matcher + runner |
| `test/parity/expected-deviations.json` | PORTING_DECISIONS #2–#5 as keyed expected diffs |
| `scripts/build_oracle.py` | runs the Python classify path per case → oracle |
| `scripts/build_fixtures.py` | synthesizes the edge-case workbooks (openpyxl) |
| `scripts/snapshot_db.py` | captures a real case's DB window via `lib/db.py` (run once) |

### The frozen port contract

Each Wave-3 port exports, from `src/reports/<type>/index.ts`:

```ts
export const classifyCase: ClassifyCase = async (workbookPaths, dbWindow, opts) => { … }
```

It runs its own extract→classify internally, reads workbooks only from
`workbookPaths` (role→abs path) and the DB only from `dbWindow` (never a live
connection), and returns the **classify envelope**. The runner discovers ported
types by the existence of that file. See `src/reports/types.ts` for the full
contract and per-type `dbWindow` role keys.

### Canonicalization (identical on both sides)

`canonical.ts` (TS) and `parity_canonical.py` (oracle builder) apply the SAME
four rules so semantically-equal outputs are byte-identical: (1) sort object keys
recursively, (2) sort row arrays by a natural-key projection, (3) normalize
floats to a tagged textual form (integer-valued → integer text; else round 9dp,
strip trailing zeros — erases Python-repr vs V8 last-bit noise), (4) strip
volatile keys (paths, timestamps, uuids, `source_row`) at any depth. **Change one,
change the other in lockstep.**

### Adding a parity case

1. Put the workbook in `fixtures/<type>/workbooks/` (real, or add a builder in
   `scripts/build_fixtures.py` and run `npm run fixtures:build`).
2. Snapshot its DB window: `npm run fixtures:snapshot -- --type <t> --case <id> --since <YYYY-MM-DD>`
   (real cases), or hand-author a tiny curated `db_window/<id>.json` (synthetic).
3. Register the case in `fixtures/<type>/manifest.json` with `covers` + `opts`.
4. `npm run build:oracle -- --type <t>` to generate the golden output.
5. `npm run parity -- --type <t>` (reports MISSING until the port exists, then PASS/FAIL).

### Recording an expected deviation

When PORTING_DECISIONS rules the TS port must intentionally differ from the
oracle, add an entry to `test/parity/expected-deviations.json` keyed by
`rule` + `type` + `case` + `path` (a glob; `*`=one segment, `**`=any suffix),
optionally pinning `kind`/`oracle`/`ts`. A diff matching an entry is
**PASS-with-note**; anything else is a FAIL. An entry that never fires on a
ported type is reported as **STALE** (prune it once the port no longer needs it).

### Oracle stability

Oracles are built from a static workbook + static DB-window snapshot with all
volatile fields stripped — building twice yields byte-identical files
(`build:oracle` then `shasum` both runs). Proven for the whole corpus.

## DBOS system database (checkpoints)

DBOS needs a **direct** Postgres connection for its `dbos` schema. The Supabase
**transaction-mode pooler must NOT be used** (it breaks session state DBOS relies on).
Options, in order of preference:

1. Supabase **session-mode pooler**, port 5432 (with DB password).
2. Supabase **direct DB host** `db.<ref>.supabase.co:5432` (if enabled).
3. A dedicated small Postgres.

If no Supabase DB password is available, the crash-resume proof runs against a local
Postgres (that is what was used to verify this milestone). See `.env.example`.

## Deploy (Fly.io — Renzo owns the `flyctl` step)

```bash
flyctl launch --no-deploy          # or edit fly.toml's `app`/region
flyctl secrets set \
  GMAIL_USER=… GMAIL_APP_PASSWORD=… \
  SUPABASE_URL=… SUPABASE_SERVICE_ROLE_KEY=… \
  DBOS_DATABASE_URL=… SYNC_KICK_SECRET=…
flyctl deploy
```

`fly.toml` is configured for **scale-to-zero** (`auto_stop_machines`, `min_machines_running=0`)
with **auto-start on the /kick request**. A lost kick is not fatal — DBOS recovery
picks up any incomplete run when the worker next wakes.
