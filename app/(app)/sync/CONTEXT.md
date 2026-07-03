# Sync Module — CONTEXT.md

## Purpose

The in-app **"Run Sync"** feature — a compact slide-out panel that runs the daily
ICTC ingestion (the six "employee" pipelines) from inside Blackwood, instead of
driving each sync employee by hand in Claude Code. One click classifies every
report in parallel, auto-applies the clean rows, and surfaces anything that needs
judgment (held/flagged rows, hard-gate failures).

The floating button (bottom-right, shared with the dormant Jarvis chat) opens this
panel. It is **Owner / Admin / Dev only** — enforced server-side in every action
and hidden client-side for other roles.

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

### Client (`components/sync/`)
- `SyncPanel.tsx` — the slide-out shell (reuses the Jarvis Sheet + glass patterns). Header, Run Sync button, employee cards, Held section, summary footer. Role-gated.
- `SyncEmployeeCard.tsx` — one card per report: spinner → counts → applied summary / gate-failed destructive state with inline error + Copy.
- `HeldRows.tsx` — held-row groups with a per-group "Ask Claude" adjudication and per-row Copy.
- `useSyncRun.ts` — the orchestration hook (run order, per-card state machine, held aggregation, narration).

## Data

No new DB tables. The panel is a thin client over:
- The Python orchestrators (via `child_process.execFile` in `actions.ts`).
- The Anthropic API (`lib/anthropic/client.ts` — reused `anthropic` + `JARVIS_MODEL`).

### CLI contract (locked — must match `sync_*.py`)
- **classify** stdout → `ClassifyResult`: `{ report_type, ok, gate_failures[], counts{noop,insert,update,flagged}, rows_preview[], classified_path, source, watermark }`
- **apply** stdout → `ApplyResult`: `{ report_type, ok, applied{inserts,updates,replaced_dates}, held[], labeled, watermark_updated, errors[] }`

### Run order (`useSyncRun.run`)
1. `gsheet` first and alone (source of truth).
2. `deliveries`, `rc_out`, `production`, `flecon` classify+apply in **parallel**.
3. `rc_movement` audit **last** — classify only, never applied (`readOnly`).

## Key Behaviors

- **One-click max-auto.** Run → all pipelines classify (per-card spinners → counts) → clean rows auto-apply (`--only-clean`) → held rows land in the Held section → gate failures render the card destructive with the gate detail.
- **Clean days cost ~0 model tokens.** `narrateSyncRun` returns a local string when nothing changed; the Anthropic call only happens when there's something to narrate.
- **Held rows are advisory in v1.** The apply contract has no single-row path yet, so "Ask Claude" returns recommendations + a Copy-row action; **applying a held row stays a Claude-Code / sync-employee job.** The UI says so explicitly. Do not fake a single-row apply.
- **Every failure is copyable.** Gate failures and errors render an inline block with the full stderr detail + a Copy button, AND fire `errorToast()` (HARD RULE — never `toast.error()` directly).
- **Role gate (SEC pattern).** Every action calls `requirePrivileged()` (derives effective role via `getUserRole()`, respects impersonation, fails closed). The FAB + panel body are also hidden client-side for non-privileged roles.

## Stubbed / pending

- The real `sync_deliveries.py`, `sync_rc_out.py`, `sync_production.py`, `sync_flecon.py`, `audit_rc_movement.py` are being built by the sync-ictc backend agent. Until they exist, run with `SYNC_MOCK=1` in the dev server env to exercise the panel end-to-end against `mock.ts`.
- `sync_gsheet.py` exists; the other five do not yet. The `child_process` layer is isolated behind `runPhase()` in `actions.ts` so the wiring is testable ahead of the scripts.
- Applying held rows (single-row write) is intentionally not implemented — pending a backend contract addition.

## Dependencies

- `lib/anthropic/client.ts` — `anthropic`, `JARVIS_MODEL`
- `lib/auth.ts` — `getUserRole()` (role gate)
- `types/auth.ts` — `PRIVILEGED_ROLES`
- `lib/toast.ts` — `errorToast()`
- `lib/supabase/server.ts` — `createClient()` (auth check in `requirePrivileged`)
- `components/ui/sheet.tsx`, `button.tsx`
- `components/jarvis/JarvisProvider.tsx` — shared `open` state (the FAB toggles this panel)

## See Also

- `.claude/skills/sync-ictc/SYNC_EFFICIENCY_AUDIT.md` — the audit that motivated the button (§5B-5D: what to reuse)
- `app/(app)/jarvis/CONTEXT.md` — Jarvis (chat dormant; FAB now opens this panel)
- `app/(app)/review-queue/CONTEXT.md` — the precedent extract→classify→approve→write pipeline
