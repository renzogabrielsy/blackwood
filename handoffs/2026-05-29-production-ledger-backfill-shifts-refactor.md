# Handoff — 2026-05-29 — Production Module: Backfill, Shifts Refactor, Excel Ledger UI

> **For the next session.** If the user says **"view latest handoff file"**, "where did we leave off", or "what's the current state", read this first.
>
> **Naming convention:** `handoffs/YYYY-MM-DD-<short-slug>.md`. Latest: `ls handoffs/ | sort -r | head -1`.

---

## TL;DR

Massive production-module session. Started by **end-to-end testing the two email-ingestion employees** (Deliveries Manager, RC Out Manager) natively post-restart — both passed, both got new decision rules encoded to agent memory. Then **built the entire Production module from the ground up**: 5 tables → Excel-style inline-editable ledger → backfilled 1,411 historical rows from MASTER → discovered the schema needed restructuring → migrated to a **parent-child shifts model** → iterated heavily on the Daily ledger UI (frozen columns, footer totals, fonts, universal period picker) → **pivoted the Trucks table by plate**. Also **switched all 8 project subagents to Opus 4.8** and **swapped the app font to Atkinson Hyperlegible**.

**Current state:** Production module is functional with real backfilled data. Daily/Electricity/Trucks tabs all work and share a universal period picker. Everything committed + pushed to `dev` (this session's work committed at the end).

**Next concrete action:** Build the **Production Manager agent** (the original goal — the backfill + schema + UI were all prerequisites). The DB is now ready to receive its writes. Alternatively: address the 3 deferred follow-ups (RLS on production tables, audit `performed_by`, drop unused monthly views).

---

## What shipped this session

### 1. Employee agents — first native invocations, both tested + rules encoded

- **Deliveries Manager** (`sync deliveries`): PROPOSE found 7 unprocessed emails, 56 rows, 3 NEW + 6 VALUE_CHANGED. EXECUTE inserted 3 NEW, applied `db_wins` to all 6 VALUE_CHANGED, labeled 2 Gmail threads, wrote 3 audit_logs. DB latest advanced 5/20→5/25.
  - **New rule encoded** (`.claude/agent-memory/deliveries-manager/feedback_feeding_status_remarks.md`): "DONE FEEDING" / feeding-status remarks belong to the RC OUT domain → always `db_wins` on delivery rows. Also added to the agent definition's "Recommendation rules for VALUE_CHANGED rows" section.
- **RC Out Manager** (`sync rc out`): HARD reconciliation gate fired on historical 5/15 drift (937 kg from an UNMAPPED "601" row). Resolved via the watermark-scope rule. EXECUTE inserted 13 NEW rc_out rows (5/23, 5/25, 5/26), labeled 8 PROPOSED threads (not the RC MOVEMENT thread).
  - **New rule encoded** (`.claude/agent-memory/rc-out-manager/feedback_reconciliation_scope.md`): the HARD gate only applies to dates > watermark; pre-watermark drift is known historical state.
- **Memory cleanup:** removed a misplaced `agent-memory-local/deliveries-manager/` file (agents auto-write to the canonical `.claude/agent-memory/`).

### 2. Production module — full build

**Backend (6 migrations total):**
- `20260527010000_create_production_tables.sql` — 5 tables: `production_runs`, `production_downtime`, `production_waste`, `electricity_readings`, `truck_readings`
- `20260527010001_create_production_views.sql` — `view_production_daily`, `view_electricity_monthly`, `view_trucks_monthly` + grants
- `20260527020000_add_batch_to_production_natural_keys.sql` — added `production_batch` to natural keys (same-day batch crossover events in MASTER)
- `20260527030000_add_customer_to_production_runs.sql` — added `customer text NOT NULL DEFAULT 'CEBU'` + into natural key (KURARAY appeared in backfill — the "CEBU is implicit" design assumption was wrong)
- `20260527040000_restructure_production_to_shifts_model.sql` — **the big one.** Introduced `production_shifts` parent table; made runs/downtime/waste FK-children via `shift_id`; dropped redundant date/batch/shift columns from children; dropped 7 SKS columns from waste. In-place migration, no data lost (1,411 rows preserved across ~158 shifts).
- `20260527040001_rewrite_view_production_daily.sql` — rewrote the view to drive from `production_shifts`

**Final production schema:**
- `production_shifts` (parent): `id`, `transaction_date`, `production_batch`, `shift` (M/E/N). Natural key `(transaction_date, production_batch, shift)`.
- `production_runs` (child): `shift_id` FK, `customer`, `grade` (3X50/6X50/8X50/2X6), `ttl_kg`, `sacks_bags`, `remarks`. Natural key `(shift_id, customer, grade)`. N:1 with shift.
- `production_downtime` (child): `shift_id` FK (1:1), `shift_hrs`, `dt_hrs`, `dt_mins`, `dt_reason`, `remarks`.
- `production_waste` (child): `shift_id` FK (1:1), 8 `*_kg` stream columns (rs1a/rs1b/bf/rs23/rs5/trml1/trml2/grit), `remarks`. SKS columns dropped.
- `electricity_readings`: `reading_date`, `meter` (MAIN/BUNKHOUSE/PUMP), `start_kwh`, `end_kwh`, `diff_kwh` (GENERATED), `rate_php_per_kwh`, `remarks`.
- `truck_readings`: `reading_date`, `plate_no` (AAV 6111/KCA 378/FORKLIFT), `start_km`, `end_km`, `ttl_km` (GENERATED), `fuel_liters`, `remarks`.

**MASTER backfill (1,411 rows + 1,411 audit_logs):**
- production_runs 207 (incl. 2 KURARAY), production_downtime 158, production_waste 158, electricity_readings 741, truck_readings 147.
- 3 Python extractors built: `extract_master_prod.py`, `extract_master_electricity.py`, `extract_master_trucks.py` at `.claude/skills/sync-ictc/scripts/`.
- Data-quality decisions: 5 downtime rows with dt_mins ≥ 60 auto-normalized; AAV 6111 Feb monthly row kept as-is (real odometer reset); electricity 2026-04-01 MAIN monthly duplicate dropped in favor of daily.
- One bug-cleanup: 11 duplicate CEBU 6X50 rows (created by an edit-vs-insert bug) deleted with audit snapshots.

**Frontend — Daily tab `daily-ledger-grid.tsx` (~1,500 lines, the centerpiece):**
- Single unified Excel-style ledger replacing the original 3-side-by-side-grids scaffold (user rejected the dialog-form approach).
- Sections: Identity (date/batch/shift) + Production (customer/grade/ttl_kg/remarks) FROZEN on the left; Downtime + Waste scroll horizontally.
- Frozen columns via `position: sticky` + explicit `<colgroup>` widths + `border-separate` (the freeze-pane separator is a continuous right-edge shadow through header→footer).
- Inline-editable cells (no dialogs): click-to-edit, paste auto-expand, Ctrl+C/V/Delete, arrow/Tab/Enter nav, dirty tracking, Save/Discard.
- Cell selection + aggregation → FloatingStatusBar (SUM/AVG/COUNT/MIN/MAX); computed cells (DT TTL, PROD HRS, PROD LOSS, TTL WASTE) are selectable.
- Multi-grade shifts: secondary rows show `↑` in identity cells; downtime/waste are per-shift (rendered on primary row only).
- Right-click context menu (Insert Above/Below, Duplicate, Add Grade Row, Delete/Restore) — replaced inline +/× icons.
- Footer totals row (sticky bottom) with per-column SUM/AVG toggle pills for TTL KG / DT TTL / PROD HRS / TTL WASTE, plus a GRADE filter pill that gates the TTL KG total.
- DATE column: custom `DatePickerCell` + click-to-sort ASC/DESC (preserves shift grouping).
- REMARKS shown inline (truncate + tooltip), not a popup. BAGS column + waste REM column removed.

**Trucks tab — pivoted by plate:** one row per date; each truck (AAV 6111/KCA 378/FORKLIFT) is a 4-subcolumn group (START/END/TTL/FUEL). DATE frozen. Monthly summary removed.

**Electricity tab:** monthly summary removed; daily-readings grid intact.

**Universal period picker (final architecture):**
- `ProductionPeriodProvider` context at the layout level holds `{ year, batch, availablePeriods, periodsLoading, setPeriod }`. URL-synced `?y=&b=`.
- `PeriodPicker` (Year + Batch selects) mounted in the layout header bar — always visible, never disabled, persists across tab switches.
- All 3 tabs read the shared period. Daily filters by `production_batch`; Electricity/Trucks map batch→month via `batchToMonth()` (`app/(app)/production/lib/batch-month.ts`) and filter readings by year+month.
- Each tab tracks `fetchedPeriodRef` and refetches when active + stale.

### 3. App-wide font swap

`Geist` → (IBM Plex → Atkinson+JetBrains → Atkinson+DM Mono) → **Atkinson Hyperlegible for everything** (both `--font-sans` and `--font-mono` point to it). User found mono number fonts straining. `app/layout.tsx` + `globals.css`.

### 4. All subagents → Opus 4.8

All 8 `.claude/agents/*.md` set to `model: opus` (was sonnet for 5 of them). CLAUDE.md "Agent Model" directive updated to instruct `model: 'opus'` for Task-tool spawns. (Loads on Claude Code restart.)

---

## Critical learnings to internalize

1. **Production schema is parent-child now.** `production_shifts` is the parent; runs/downtime/waste FK to it via `shift_id`. Downtime + waste are 1:1 with shift (one per shift). Runs are N:1 (multiple grades/customers per shift). Don't reintroduce date/batch/shift columns on the children.

2. **`customer` is a real column on production_runs** (default CEBU). The original "CEBU implicit, no column" design was wrong — KURARAY proved it. Future production output for other customers just sets `customer`.

3. **Frozen-column freeze pane needs:** explicit `<colgroup>` widths + `border-separate` (NOT `border-collapse`) + opaque backgrounds + a single scroll container (don't nest `overflow-x-auto` inside `overflow-auto` — that caused the "shift left" bug). The freeze separator is a right-edge shadow continuous through all header rows + body + footer.

4. **Grid remount key must use FETCHED data's period, not the picker selection.** Keying on selection caused a one-click-behind bug (grid remounted with stale data before the fetch returned). Key = `${dataYear}-${dataBatch}`.

5. **StatusBar aggregation effect:** don't wipe count/aggregates to 0 in the effect cleanup (it runs on every dep change → never settles). Clear only on unmount (separate effect).

6. **batch ↔ month mapping** is inconsistent in this DB (JAN vs JANUARY etc.) — `batchToMonth()` handles both forms. Electricity/Trucks use it since they have no batch column.

7. **Backfill data-quality patterns:** dt_mins can exceed 60 (operator shorthand — normalize); odometer resets produce legit start_km=0; MASTER has both monthly + daily sections for electricity/trucks (dedupe on conflict).

8. **The edit-vs-insert bug:** when a user edits a natural-key field (e.g., customer CEBU→FG), the save must UPDATE by row id, NOT upsert by natural key (which inserts a duplicate). Key off `_ids.run_id` presence, not `_state`.

---

## Current state

### ✅ Working
- Production module: all 3 tabs, real backfilled data, universal period picker, frozen columns, footer totals, cell aggregation, right-click menu, date sort, trucks pivot.
- Deliveries Manager + RC Out Manager: tested end-to-end natively.
- Build: zero TS errors throughout.

### ⚠️ Deferred follow-ups (flagged, not done)
1. **RLS disabled** on all 5 production tables + `ingestion_watermarks` (advisor warning). Needs a policy migration.
2. **Audit `performed_by = NULL`** for skill/backfill writes (comment carries provenance) — confirm if that's the desired convention or should be the user's id.
3. **Unused monthly views**: `view_trucks_monthly` + `view_electricity_monthly` no longer queried (summaries removed). Droppable via migration.
4. **Trucks partial-row validation**: entering START without END triggers "End KM ≥ Start KM" on save. Flag if partial saves should be allowed.
5. **`fetchAvailablePeriods`** does a full-column select — fine now, DB-side DISTINCT better if the table grows large.

### 🚧 Not built
- **Production Manager agent** — the original goal. Design doc complete at `.claude/skills/sync-ictc/PRODUCTION_DESIGN.md`. DB + UI now ready to receive its writes. This is the next major build.

---

## Next concrete action

**Build the Production Manager agent** (`.claude/agents/production-manager.md` + Python tools). It ingests MC's Daily Production Report email + Ivy's Waste Production Report into the 5 production tables. The backfill, schema, and UI are all done as prerequisites. Follow the employee pattern (PROPOSE/EXECUTE, fetch_gmail.py, extract/classify scripts) used by deliveries-manager + rc-out-manager. See `PRODUCTION_DESIGN.md` §5 for the planned script set.

---

## Git state at handoff
- Branch: `dev`. This session's work committed + pushed at session end (production module rewrite, 6 migrations, font swap, agent-model change, picker refactor, trucks pivot).
- Prior session commits: `62c1658` (employees), `bb25415` (production+jarvis), `cc16dfa` (toasts).

---

*End of handoff — 2026-05-29 — Production Module: Backfill, Shifts Refactor, Excel Ledger UI*
