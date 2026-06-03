# Lean Sync Refactor — token-lean redesign of the ICTC sync employees

> **Status (2026-06-02):** `gsheet-sync` is DONE and PROVEN (read-only). The other four
> employees are designed here; each follows the same pattern and reuses the same shared
> `scripts/lib/db.py` helper. No code written for the others yet — this doc is the blueprint.

## The problem (all five employees share it)

Each sync "employee" agent historically:
1. Pulled the **full DB dump** for the comparison window into the *LLM's* context (via
   `mcp__supabase__execute_sql` with `json_agg`) — thousands of rows.
2. Pulled the **full classified JSON** (every row, mostly NOOP) into context too.
3. Re-read that growing pile on every reasoning step.
4. Wrote rows back **one-by-one** via MCP `execute_sql`.

Result: 90k–160k tokens and 5–10 min per run, almost all of it spent shuttling rows the
LLM never needed to look at. The deterministic diff is already a Python script; the LLM is
only needed for (a) genuine judgment on a handful of ambiguous rows and (b) talking to Renzo.

## The pattern (proven by `gsheet-sync`)

A lean **two-phase orchestrator** per employee, built on the shared `scripts/lib/db.py`:

- **`--phase classify`**: Python pulls the source (email XLSX / Sheet / master file), fetches
  the in-scope DB rows ITSELF via `lib/db.py` (PostgREST + service-role key — rows never enter
  the agent context), runs the EXISTING extract + classify scripts, and emits:
  - the **full classified JSON** to disk (audit only — agent never reads it), and
  - a **compact `decisions_*.json`**: ONLY actionable items (NEW, material VALUE_CHANGED with
    `{field, db, sheet}`, FLAGGED, MALFORMED, UNMAPPED) + a `summary` counts block.
  - STDOUT = summary counts + path to the compact file. Never the row set.
- **`--phase apply`**: takes the approved compact file (with any per-row `skip`/`decision`
  the agent set) and does the writes + audit logs **deterministically** via `lib/db.py`,
  replicating each table's trigger contract exactly.

The agent's loop becomes: run classify → read the few-KB compact file → apply Learning-Ledger
judgment to the handful of flagged/unmapped rows → (after Renzo approval) run apply → read the
compact result. The DB dump and the full classified JSON never touch its context.

**Measured savings (gsheet-sync, 2026-06-02 idempotency re-run):** agent-context payload
**~349k tokens → ~1k tokens (>99%)**. The DB dump alone was ~218k tokens; the classified JSON
~131k; the two compact decisions files together are ~4.3 KB / ~186 lines.

## Shared helper — `scripts/lib/db.py` (reusable across ALL five)

- `read_rows(table, since_date=, columns=)` — paged PostgREST GET; returns rows to *Python*, never the agent.
- `insert(table, rows)` / `update(table, filters, patch)` — batch writes.
- `update_trigger_audit_provenance(table, record_id, comment, snapshot)` — for tables whose
  INSERT fires an audit trigger (`deliveries`): UPDATE the trigger-written row (L-001), never INSERT a 2nd.
- `insert_manual_audit(...)` — for tables with NO audit trigger (`rc_out`, production tables): INSERT the audit row.
- Reads `NEXT_PUBLIC_SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` from `.env.local`. Pure `requests`.

---

## 1. `gsheet-sync` — DONE (RC IN → `deliveries`, RC OUT → `rc_out`)

**Reference implementation.** `scripts/sync_gsheet.py` + `scripts/lib/db.py`. Classify phase
proven read-only on 2026-06-02: RC IN 813 NOOP / 6 changed (truck_plate `MAR 2499→Mar-99`
normalizations) / 0 NEW; RC OUT 1626 NOOP / 2 changed / 1 malformed / 0 NEW — confirming
idempotency (the June-1 live-run inserts now NOOP, and the FEB-25-BLK8 reassignment, once
resolved by the live run, dropped from `flagged` to a plain `changed` diff). Apply phase
replicates L-008 (cost_basis=0 placeholder), L-001 (UPDATE trigger audit row), L-005/L-006
(never touch `current_weight`), and writes rc_out's audit row manually. **Savings: >99%.**

---

## 2. `deliveries-manager` — RC IN email + Czarina price enrichment → `deliveries`

**Current bloat:** pulls full `deliveries` window + full `classify_deliveries.py` output into
context; also pulls Czarina price rows for enrichment; writes deliveries one-by-one via MCP,
then issues the L-001 provenance UPDATE per row by hand. Two big dumps (deliveries + prices).

**Lean redesign:** a `sync_deliveries.py` two-phase orchestrator reusing `extract_rc_deliveries.py`,
`classify_deliveries.py`, and `enrich_prices.py`. Classify phase: Python fetches the deliveries
window + the price lookup via `lib/db.py`, runs extract+classify+enrich, emits a compact
`decisions_deliveries.json` whose `changed` items include the **price enrichment** as just
another `{field: cost_basis, db, sheet}` diff (this is the ONE place cost_basis IS written —
overwriting a `cost_basis=0` gsheet placeholder per L-008). Apply phase: insert NEW deliveries,
UPDATE the trigger audit row for provenance (L-001), and — critically — NEVER `current_weight +=`
(L-006); the helper's write path forbids it by construction.

**Stays LLM judgment:** unmatched suppliers/batch_codes (UNMAPPED), the L-004 block_loc-correction
vs new-row call, ambiguous Czarina↔delivery price matches, and any ledger-flagged row.

**Est. savings:** ~150k → ~2–5k agent tokens; the second dump (prices) is eliminated from context too.

**Risk/rollback:** the cost_basis write is the highest-stakes path (real money). Keep the existing
`enrich_prices.py` logic verbatim; only move where the rows are fetched/emitted. Rollback = keep
calling `classify_deliveries.py --db-rows-json` manually. Verify post-apply that no batch's
`current_weight` drifted from `SUM(in) − SUM(out)` (the L-005/L-006 standing check).

---

## 3. `rc-out-manager` — PROPOSED DAILY REPORT email → `rc_out`

**Current bloat:** full `rc_out` window + full `classify_rc_out.py` output in context; plus it
runs the **RC MOVEMENT daily-drift reconciliation** (HARD gate >500 kg) by pulling both the
PROPOSED rows and the RC MOVEMENT rows into context to compare.

**Lean redesign:** `sync_rc_out.py` two-phase, reusing `extract_proposed_daily.py` +
`classify_rc_out.py` + `reconcile_rc_movement.py`. Classify phase: Python fetches the `rc_out`
window via `lib/db.py`, classifies, AND runs the reconciliation deterministically — emitting the
drift as a **compact report** (`{date, proposed_total, movement_total, drift_kg, gate_tripped}`)
not a row dump. Compact `decisions_rc_out.json` carries NEW/changed/flagged + the per-day drift
summary. Apply phase: insert rc_out + manual audit row (no audit trigger), honoring the
HARD >500 kg gate as a refuse-to-write guard in Python.

**Stays LLM judgment:** L-002 (PCA/PCB pathway = SUNDRY overflow → flag, don't auto-derive a BLK),
L-003 (bare-number continuation rows — exclude from feed total), destination typos beyond the known
map, and any drift the gate trips (the agent explains it to Renzo; never auto-overrides the gate).

**Est. savings:** ~160k → ~3–6k agent tokens (drift comparison was a second big dump — now a report).

**Risk/rollback:** the >500 kg drift gate is load-bearing (it caught the L-003 false halt). Keep it
in Python and keep it HARD. Rollback = the existing standalone classify+reconcile invocation.

---

## 4. `production-manager` — MC + Ivy reports → 6 tables

Tables: `production_shifts`, `production_runs`, `production_downtime`, `production_waste`,
`electricity_readings`, `truck_readings`.

**Current bloat:** SIX tables' worth of DB rows + six classifier outputs in context; the
reconciliation (informational, never gates) also pulls rows; one-by-one writes across six tables
with the parent/child `shift_id` FK threaded by hand.

**Lean redesign:** `sync_production.py` two-phase reusing `extract_daily_production.py`,
`extract_waste_production.py`, `extract_master_*.py`, the five `classify_production_*.py` +
`classify_electricity.py`/`classify_trucks.py`, and `reconcile_production.py`. Classify phase:
Python fetches all six windows via `lib/db.py`, classifies each, and emits ONE compact
`decisions_production.json` keyed by table, each holding only actionable items; the RC-IN-vs-output
reconciliation goes in as an **informational compact block** (never a gate, per the daily-drift
memo). Apply phase: write `production_shifts` parents FIRST, capture their ids, then write the FK
children (runs/downtime/waste) referencing them — all deterministic in Python. Encode the L-007
hard rules in the apply/classify layer: STARTING/ENDING = batch-boundary runs (two shift parents
same date, different `production_batch`); downtime `dt_mins ≥ 60` split into `dt_hrs`+`dt_mins`;
waste `UNIQUE(shift_id)` collision → HOLD the second row + flag (never silently sum).

**Stays LLM judgment:** L-007 STARTING/ENDING batch + shift inference when column C is blank;
the waste-collision sum-vs-separate-shift question; any malformed/indeterminate shift; the
deferred Bagging/QC/Sundry sections (PRODUCTION_DESIGN.md §10).

**Est. savings:** ~150k → ~5–8k agent tokens (six dumps collapse to one compact file; the parent/child
id threading becomes deterministic Python).

**Risk/rollback:** highest write complexity (6 tables, FK order, multiple CHECK constraints). Build
+ dry-run table-by-table; keep the reconciliation INFORMATIONAL (never let it gate). Rollback = the
existing per-table standalone classify path. Verify post-apply: shift parents exist before children;
no orphaned `shift_id`; downtime CHECK (`0 ≤ dt_mins < 60`) passes; one waste row per shift.

---

## 5. `rc-movement-auditor` — RC MOVEMENT read-only cross-check (NO writes)

**Current bloat:** pulls the RC MOVEMENT extract AND the `rc_out` / `deliveries` window into
context to cross-check, then narrates discrepancies — a pure read path that still burns a big dump.

**Lean redesign:** `audit_rc_movement.py` **classify-only** (no apply phase ever). Python fetches
the DB rows via `lib/db.py`, runs `extract_rc_movement.py` + `reconcile_rc_movement.py`, and emits
a **compact discrepancy report** (`{date, batch, movement_kg, db_kg, delta, kind}` for ONLY the
rows that disagree) + a summary. The agent reads the compact report and writes its findings; it
never sees the matching majority.

**Stays LLM judgment:** interpreting cross-sheet date duplicates / anomalies (the auditor's
agent-memory already tracks an `anomaly_cross_sheet_date_duplicate` pattern), and deciding what's a
real discrepancy vs an expected continuous-flow drift (kg-in/kg-out balances at month-end, not daily).

**Est. savings:** ~90k → ~2–4k agent tokens. No write risk (read-only). Rollback = trivial (revert
to the standalone extract+reconcile invocation).

---

## Rollout notes

- **Additive.** Every existing `extract_*` / `classify_*` / `reconcile_*` script stays working and
  standalone-runnable with `--db-rows-json`. The orchestrators only change WHERE rows are fetched and
  WHAT the agent reads. Nothing in the proven pipeline is removed.
- **One helper, five orchestrators.** `scripts/lib/db.py` is shared. Each orchestrator is ~200–400
  lines of glue + a compact-builder + a deterministic apply path that replicates that table's trigger
  contract (audit trigger vs manual; current_weight ownership; FK order).
- **Trigger contract is sacred.** deliveries: BEFORE-INSERT maintains current_weight + audit trigger
  writes the row → never `+= current_weight`, UPDATE the audit row (L-001/L-005/L-006). rc_out +
  production tables: no audit trigger → insert audit row manually. Bake these into each apply path.
- **Build order suggestion:** rc-movement-auditor (read-only, lowest risk) → rc-out-manager →
  deliveries-manager (money) → production-manager (most tables). Dry-run each read-only first, exactly
  as gsheet-sync was proven here.
