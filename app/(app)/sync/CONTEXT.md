# Sync Module — CONTEXT.md

## Purpose

The in-app **"Run Sync"** feature — a compact **modal** that runs the daily
ICTC ingestion (the six "employee" pipelines) from inside Blackwood, instead of
driving each sync employee by hand in Claude Code. One click classifies every
report in parallel, auto-applies the clean rows, and surfaces anything that needs
judgment (held/flagged rows, hard-gate failures).

**Entry point (as of 2026-07):** a compact zinc **"Run Sync" launcher button** in
the dashboard's digest header band (right-aligned) opens the sync as a Dialog. This
**replaced the retired floating button** (bottom-right FAB) — which also retired the
shared `JarvisProvider`. It is **Owner / Admin / Dev only** — enforced server-side in
every action + the SSE route, and hidden client-side for other roles.

**Running-state survival:** `useSyncRun()` is lifted into `SyncLauncher` (ABOVE the
Dialog), so closing the modal mid-run never kills the stream — the hook + its
in-flight `EventSource`s persist, and reopening shows the run still live.

This is the app front-end for the Python orchestrators the sync-ictc backend agent
builds at `.claude/skills/sync-ictc/scripts/sync_*.py`. The panel talks to them
over a **fixed CLI contract** (see `types.ts`).

## Files

### Server (this folder)
- `actions.ts` — server actions:
  - `runSyncClassify(reportType)` → spawns `sync_<type>.py --phase classify --json`
  - `runSyncApply(reportType, classifiedPath)` → `--phase apply --input <path> --only-clean --json`
  - `adjudicateHeldRows(reportType, heldRows[])` → single Anthropic completion → per-row `apply|skip|needs-human` recommendations (advisory only)
  - `narrateSyncRun(results[])` → optional 3-sentence plain-language summary; **skips the API call** (zero tokens) when every report is clean
- `types.ts` — the FIXED CLI contract types (`ClassifyResult`, `ApplyResult`, `HeldRow`, …) + the report catalog (`SYNC_REPORTS`, `PARALLEL_WRITERS`). Import-safe from both server and client.
- `mock.ts` — canned contract JSON for the `SYNC_MOCK=1` path. Exercises every UI state: clean run (gsheet), inserts+updates (deliveries), hard gate failure (rc_out), held rows (production), read-only auditor (rc_movement).

### SSE route (`app/api/sync/stream/`)
- `route.ts` — **live progress stream** for one pipeline phase. `GET /api/sync/stream?report=<type>&phase=classify|apply&input=<path>&onlyClean=1&noLabel=1`. Spawns `python3 <script> --phase <phase> --json […]` (via `spawn`, not `execFile`), line-buffers stderr, and streams three SSE event kinds: `progress` (decoded `##SYNC_PROGRESS` events), `log` (all other stderr lines — the technical log), and a terminal `result` (`{exitCode, json, stderrTail}`). Kills the child on client disconnect (`request.signal` abort); pings every ~15s to keep the connection alive. Respects `SYNC_MOCK=1` (canned progress + canned result from `mock.ts`, no Python).
  - **Self-auth (critical):** `/api` is EXEMPT from the auth middleware, so the route re-runs the same server-side privileged gate as `actions.ts` (`createClient → getUser → getUserRole → PRIVILEGED_ROLES`) and returns 401/403 JSON otherwise. Verified: unauthenticated GET → 401 before any spawn.
  - **Path safety:** `apply` requires an `input` that starts with `/tmp/` — arbitrary paths are rejected 400. `readOnly` reports (rc_movement) reject `apply`.

### Client (`components/sync/`)
- `SyncLauncher.tsx` — **the live entry point.** A compact zinc "Run Sync" button mounted in the digest header band (`app/(app)/page.tsx`), privileged-only. Owns `useSyncRun()` (lifted above the Dialog for running-state survival) + the modal `open` state. Opens a `Dialog` (`sm:max-w-3xl`, `max-h-[85vh] overflow-y-auto`, sticky glass header) wrapping `SyncPanelBody`. The button label/icon reflects run state (Zap → spinning "Syncing…").
- `SyncPanelBody.tsx` — **the reusable panel content, written ONCE.** Run Sync button + employee cards + Held section + narration footer. Chrome-agnostic (no header/close of its own — the wrapping Dialog/Sheet owns that). Takes `state`/`run`/`adjudicate` as props so state can be lifted. Shared by `SyncLauncher` (modal, live) and `SyncPanel` (Sheet, dormant).
- `SyncPanel.tsx` — **DORMANT.** The original slide-out Sheet shell (reuses the Jarvis Sheet + glass patterns) — now wraps `SyncPanelBody`. No longer mounted (the floating button + `JarvisProvider` it depended on are retired). Kept in the repo as a reference, same policy as the dormant Jarvis chat. Do NOT re-mount without restoring `JarvisProvider`.
- `SyncEmployeeCard.tsx` — one card per report: **live progress bar** (thin track, fill animated via `transform: scaleX(pct/100)` — NEVER `width`, compositor rule) + **plain-English status line** (event label + muted detail; `level:'warn'` tints amber without flipping to error state), then counts → applied summary / gate-failed destructive state with inline error + Copy. A **collapsible "Technical log"** (default closed) holds the raw stderr lines — terminal noise never appears in the status line.
- `HeldRows.tsx` — held-row groups with a per-group "Ask Claude" adjudication and per-row Copy.
- `useSyncRun.ts` — the orchestration hook (run order, per-card state machine, held aggregation, narration). Each phase now **consumes the SSE stream** (`EventSource`, cookie-auth) instead of awaiting the server action; `progress`/`log` events patch the card live, the terminal `result` replaces the old action return value (downstream logic unchanged). **Fallback:** if the stream errors *before any event arrives*, it falls back to the server-action path once so a broken stream never breaks a sync. A *mid-stream* drop resolves with an error result (no double-run).

## Data

No new DB tables. The panel is a thin client over:
- The Python orchestrators — **live path:** the SSE route (`app/api/sync/stream/route.ts`) via `spawn`, streaming progress. **Fallback path:** `child_process.execFile` in `actions.ts` (`runSyncClassify` / `runSyncApply`) is still used when a stream fails before any event.
- The Anthropic API (`lib/anthropic/client.ts` — reused `anthropic` + `JARVIS_MODEL`).

### CLI contract (locked — must match `sync_*.py`)
- **classify** stdout → `ClassifyResult`: `{ report_type, ok, gate_failures[], counts{noop,insert,update,flagged}, rows_preview[], classified_path, source, watermark }`
- **apply** stdout → `ApplyResult`: `{ report_type, ok, applied{inserts,updates,replaced_dates}, held[], labeled, watermark_updated, errors[] }`
- **stdout stays the single machine-JSON result object** (contract unchanged).

### Progress event contract (FROZEN — see `SYNC_CLI_CONTRACT.md`, owned by the backend agent)
Each Python script flushes ONE line per event on **stderr**, prefixed by the sentinel:
```
##SYNC_PROGRESS {"stage":"fetch|extract|classify|apply|reconcile|finalize","pct":<0-100 int>,"label":"<plain-English activity>","detail":"<optional specifics>","level":"info|warn"}
```
- Types live in `types.ts`: `SYNC_PROGRESS_SENTINEL`, `SyncProgressStage`, `SyncProgressEvent`, `SyncStreamResult`.
- **Any other stderr line** = raw technical log → SSE `log` event → the card's collapsible "Technical log".
- **Digestibility guard** (belt-and-suspenders, in `route.ts` `parseProgressLine`): a `label` that looks like a traceback (`startsWith('Traceback')`, contains `File "`, or `length > 140`) is NOT shown as a status line — it drops to the technical log instead. `pct` is clamped to 0–100 and rounded; unknown `stage` / malformed JSON → treated as a log line.

### Run order (`useSyncRun.run`)
1. `gsheet` first and alone (source of truth).
2. `deliveries`, `rc_out`, `production`, `flecon` classify+apply in **parallel**.
3. `rc_movement` audit **last** — classify only, never applied (`readOnly`).

## Key Behaviors

- **One-click max-auto.** Run → all pipelines classify (per-card **live progress bar + plain-English status line** → counts) → clean rows auto-apply (`--only-clean`) → held rows land in the Held section → gate failures render the card destructive with the gate detail.
- **Live, digestible progress.** Each phase streams `##SYNC_PROGRESS` events over SSE; the card shows a scaleX-animated bar + a normal-user status line (e.g. "Comparing against the database… · 195 already recorded"), with all raw terminal output hidden behind a collapsible "Technical log". `level:'warn'` events tint the line amber but do NOT flip the card to error state.
- **Clean days cost ~0 model tokens.** `narrateSyncRun` returns a local string when nothing changed; the Anthropic call only happens when there's something to narrate.
- **Held rows are advisory in v1.** The apply contract has no single-row path yet, so "Ask Claude" returns recommendations + a Copy-row action; **applying a held row stays a Claude-Code / sync-employee job.** The UI says so explicitly. Do not fake a single-row apply.
- **Every failure is copyable.** Gate failures and errors render an inline block with the full stderr detail + a Copy button, AND fire `errorToast()` (HARD RULE — never `toast.error()` directly).
- **Role gate (SEC pattern).** Every action calls `requirePrivileged()` (derives effective role via `getUserRole()`, respects impersonation, fails closed). The FAB + panel body are also hidden client-side for non-privileged roles.

## Stubbed / pending

- The real `sync_deliveries.py`, `sync_rc_out.py`, `sync_production.py`, `sync_flecon.py`, `audit_rc_movement.py` are being built by the sync-ictc backend agent. Until they emit `##SYNC_PROGRESS` events, the stream still works — it just shows fewer progress steps (all non-sentinel stderr flows to the technical log). Run with `SYNC_MOCK=1` in the dev server env to exercise the panel (incl. the live progress bar) end-to-end against `mock.ts`.
- `sync_gsheet.py` exists; the other five do not yet. Both transports are isolated: the live SSE route (`app/api/sync/stream/route.ts`) and the fallback `runPhase()` in `actions.ts`, so the wiring is testable ahead of the scripts.
- Applying held rows (single-row write) is intentionally not implemented — pending a backend contract addition.

## Dependencies

- `lib/anthropic/client.ts` — `anthropic`, `JARVIS_MODEL`
- `lib/auth.ts` — `getUserRole()` (role gate)
- `types/auth.ts` — `PRIVILEGED_ROLES`
- `lib/toast.ts` — `errorToast()`
- `lib/supabase/server.ts` — `createClient()` (auth check in `requirePrivileged` AND the SSE route's self-auth gate)
- `components/ui/sheet.tsx`, `button.tsx`
- `components/jarvis/JarvisProvider.tsx` — shared `open` state (the FAB toggles this panel)
- `app/api/sync/stream/route.ts` — the live SSE progress route (Node runtime, `spawn`); consumed by `useSyncRun` via `EventSource`

## See Also

- `.claude/skills/sync-ictc/SYNC_EFFICIENCY_AUDIT.md` — the audit that motivated the button (§5B-5D: what to reuse)
- `app/(app)/jarvis/CONTEXT.md` — Jarvis (chat dormant; FAB now opens this panel)
- `app/(app)/review-queue/CONTEXT.md` — the precedent extract→classify→approve→write pipeline
