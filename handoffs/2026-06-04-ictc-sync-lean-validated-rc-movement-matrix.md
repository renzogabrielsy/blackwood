# Handoff — 2026-06-04 — Lean ICTC Sync Validated (2nd live run) + RC Movement Matrix Tab + Frozen-Pane Fix + Geist Font

> **For the next session.** If the user says **"view latest handoff file"**, "where did we leave off", or "what's the current state", read this first.
>
> **Lineage:** continues `2026-06-02-cenapro-tenant-built-editable-ledger.md`. That handoff's "next action" — **test the ICTC Gmail/email sync** — was **DONE this session** (twice: a June-1 run earlier in the session, then a June-2 run on the new lean path). This session also built the RC Movement matrix, fixed the recurring frozen-pane bug, and switched the app font to Geist.

---

## TL;DR

The ICTC sync is now **proven in production** — two real EXECUTE runs landed June-1 and June-2 operator data into Supabase end-to-end (RC IN + RC OUT + 6 production tables), with the **gsheet-first → email-agents-audit → approve → EXECUTE** sequence and the **new lean `gsheet-sync` orchestrator** (reads ~6 KB of context instead of ~525 KB — the ~99% reduction, confirmed in practice). The pipeline even self-corrected an operator's mislabeled batch. Separately, the **RC Movement matrix** (day × block feeding cross-tab) was built as the `/inventory` **Movement tab** (the old flat list retired), the **recurring frozen-pane bleed-through bug** was root-caused + codified canonically, and the **app font switched to Geist** (medium-weight default, `font-mono` → Geist + tabular figures).

**Next concrete action:** fix the `audit_logs` write-permission gap (logged as **L-009**, task chip filed) so the lean `sync_gsheet.py --phase apply` is fully self-sufficient; and get the user's call on the **block-loss sign** in the matrix footer (currently `(out − in)/in`, reads negative).

---

## What shipped (commits `dbe4204..a3e8c09`, all on `dev`, pushed)

### A. Lean ICTC sync — built + VALIDATED with a live run
- `refactor(sync-ictc): lean two-phase orchestrator for gsheet-sync` (`dbe4204`):
  - `.claude/skills/sync-ictc/scripts/lib/db.py` — shared PostgREST client (service-role key from `.env.local`): `read_rows(table, since, cols)` paged, insert/update, + audit helpers.
  - `.claude/skills/sync-ictc/scripts/sync_gsheet.py` — `--phase classify` (fetches Sheet + DB itself, reuses `extract_gsheet.py`/`classify_gsheet.py`, writes a COMPACT `decisions_*.json` + prints summary only) and `--phase apply` (deterministic write-back, provenance=gsheet, cost_basis=0 per L-008).
  - `.claude/agents/gsheet-sync.md` — rewritten to drive the lean orchestrator + hard "never cat the full dump/classified JSON" rule.
  - `.claude/skills/sync-ictc/LEAN_SYNC_REFACTOR.md` — conceptual design to apply the same pattern to deliveries-manager / rc-out-manager / production-manager / rc-movement-auditor (NOT yet built — only gsheet-sync is lean).
- **Two live EXECUTE runs this session** (DB writes, not code) — see "Current state."

### B. RC Movement matrix → the Movement tab
- `feat(rc-movement): replace flat movement list with batch-by-block matrix tab` (`add0e28`):
  - `app/(app)/inventory/rc-movement/rc-movement-matrix.tsx` — frozen-pane day × block cross-tab. Rows = each calendar day of a cycle-month (incl. zero-feed days); columns = each opened block (source batch), spawned in chronological first-fed order; cells = kg fed. Frozen LEFT cols: Row#, Date, Day, **Batch** (= production batch that day), Total fed. Frozen header row + frozen footer. Reads `view_rc_movement` (already had `fed_today`, etc.).
  - `app/(app)/inventory/rc-movement/actions.ts` — `fetchRcMovementMatrix(month)` (pivot data + per-column summary `totalOut/totalIn/status/mc/ash/blockLoss` + `grandTotalFed`).
  - `app/(app)/inventory/components/rc-movement-matrix-lazy-tab.tsx` — lazy tab host (month state, re-fetch on change). `inventory-view.tsx` Movement tab now renders it. Deleted: standalone `/inventory/rc-movement` route `page.tsx` + the retired flat-list files (`rc-movement-lazy-tab.tsx`, `rc-movement-table.tsx`, wrapper) + `fetchRcMovementData`. Navbar breadcrumb for the old route removed.
  - **Block-detail reuse:** clicking a block COLUMN HEADER opens the Blocking `BlockingDetailPanel` for that column's specific batch. Added `fetchBlockDataForBatch(batchId)` in `app/(app)/inventory/blocking/actions.ts`; `blocking-detail-panel.tsx` now accepts an optional `blockData` prop (grid still works via `data[locKey]` fallback).
- `feat(rc-movement): add frozen summary footer` (`b3f5b68`): footer pinned to scroll-container bottom. Per block column: **fed** (total kg) + **loss %** with the whole cell tinted **blue=in-use / red=closed** (opaque); MC/Ash/full detail in an aesthetic hover card. Left frozen cells show grand total fed. Block-loss = `(out − in)/in` (SIGN PENDING — see open decisions).
- `style(rc-movement): add vertical column gridlines` (`a3e8c09`): `border-r` on header/body/footer cells for a full spreadsheet grid (Total-fed `frozen-edge` preserved, not doubled).

### C. Canonical frozen-pane fix (recurring bug)
- `fix(frozen-panes): make sticky table cells fully opaque to stop bleed-through` (`464d406`):
  - `app/globals.css` — `.frozen-col` (z10) / `.frozen-row` (z20) / `.frozen-corner` (z30) + bottom mirrors `.frozen-row-bottom` / `.frozen-corner-bottom` / `.frozen-edge-top` / `.frozen-edge` + a documented "Frozen Panes" comment.
  - `CLAUDE.md` — new "Frozen Panes (sticky rows/columns)" section (opaque-always rule, z-scale, border-separate requirement).
  - Applied the fix to BOTH `rc-movement-matrix.tsx` and the Cenapro `production-ledger-grid.tsx`.

### D. App-wide Geist font
- `refactor(typography): switch app-wide font to Geist` (`b708e55`): `app/layout.tsx` loads Geist (variable `--font-geist-sans`); `app/globals.css` maps `--font-sans` + `--font-mono` → Geist, sets base `body` weight to **500 (font-medium)**, and adds `.font-mono { font-variant-numeric: tabular-nums }` so all existing `font-mono` data cells render Geist with aligned numerals (no per-table edits). Temporary `/font-lab` comparison page created then deleted.

---

## Critical learnings (highest value)

1. **Dev-server staleness caused TWO false "it's broken / nothing changed" loops.** A `next/font` change in `layout.tsx`, a route deletion, and CSS-cascade-layer changes do NOT reliably hot-reload — they need a dev-server restart (+ `rm -rf .next`). Symptom: user sees the OLD output while the code on disk is correct. The browser auto-reconnects to whatever process owns `:3000`, so server churn is invisible to the user. **Rule for next time: after any build-time change (fonts, deleted routes, layout), restart the dev server and tell the user to hard-refresh BEFORE concluding the code is wrong.** A green "diagnostic badge" trick (temporary visible marker) definitively proved "is the browser even on my code."
2. **Frozen-pane bleed-through root cause = `border-collapse`.** Browsers don't reliably paint backgrounds on `position: sticky` table cells under `border-collapse: collapse` — so frozen columns stay transparent and scrolling content shows through, no matter the bg color. **Fix: `border-separate; border-spacing:0` + `position: relative` on the `<table>` + opaque (never `/opacity`/glass) bg on every sticky cell + SOLID hover (not `bg-x/40`, which re-opens the bleed on hover) + strict z-scale.** The Cenapro production ledger is the reference implementation; the rule is now in `CLAUDE.md`. Mirroring an already-working table (the ledger) is faster than re-deriving.
3. **`max-content` table width** — with `table-fixed`, `width:100%` stretches columns to fill empty space when there are few of them. Use `width: max-content` so columns keep their colgroup widths and leftover space stays empty on the right.
4. **`font-mono` no longer means monospace** — it now resolves to Geist + `tabular-nums` (proportional letters, fixed-width digits). Numbers still align in columns; the typewriter look is gone. If anything ever needs TRUE character-cell monospacing, this won't provide it.
5. **Lean sync mechanics** — Python (`sync_gsheet.py`) fetches the Sheet AND the DB rows itself and emits a compact decisions file; the agent reads ONLY that (~6 KB vs ~525 KB full dump = ~89×). This is the model for slimming the other employees (see `LEAN_SYNC_REFACTOR.md`).
6. **L-009 (NEW infra gotcha):** the lean `apply` path's PostgREST service-role key can write `deliveries`/`rc_out` but is **NOT granted INSERT/UPDATE on `audit_logs`** → the apply script 403'd mid-run and the audit rows were completed via the elevated Supabase MCP instead. Data landed correctly + exactly once. **Until the grant (or a SECURITY DEFINER RPC) is added, the lean apply phase is not fully self-contained.** Task chip filed.
7. **The pipeline catches operator errors.** On June-2, the operator's email hand-labeled the D-13D feed as "MARCH-26-BLK11" (a CLOSED batch in a different slot, D-19D); the Sheet said **MAY-26-BLK11**, and rc-out-manager confirmed the Sheet via physical `location_ref` (D-13D) + matching starting balance (49,870). Trust physical location + balance over the operator's hand-written block-date label.
8. **L-008 hand-off works end-to-end** — gsheet-sync inserts an RC IN row with `cost_basis=0`; deliveries-manager enriches the real Czarina price (₱38) on a later pass. First real-world completion this session.
9. **L-007 (from prior session) held up** — the June-2 run had a blank shift-cell run; production-manager inferred Morning (M) from the day's downtime/electricity shift per L-007 rule 2 (single-batch day, no STARTING/ENDING marker). Not malformed.

---

## Current state

### ✅ Working / verified (DB live)
- **DB current through 2026-06-02** for RC IN, RC OUT, and all production tables — written this session across two runs (June-1 earlier, June-2 on the lean path), all cross-checked (reconciliation 0 kg drift), audit-logged, and source Gmail threads labeled `Blackwood-Processed`.
  - June-2 written: RC IN APRIL-26-BLK9 (10,865 kg, ₱38); RC OUT JAN-26-BLK10 12,153 / MARCH-26-BLK16 19,102 / MAY-26-BLK11 4,411 (= 35,666 kg); production shift+run 26,520 kg + downtime/waste/electricity. Plus June-1 cleanup: MAY-26-BLK13 cost_basis 0→38, sacks 468→648, remarks set.
- **RC Movement matrix** is the Movement tab — frozen panes solid (bleed fixed), vertical gridlines, summary footer, clickable headers → Blocking detail panel. `tsc` + `build` clean.
- **Geist font** live app-wide. `tsc` + `build` clean.
- 6 commits pushed to `origin/dev` (`dbe4204..a3e8c09`).

### ⚠️ Built but pending the user's eyeball / decision
- Block-loss footer sign (see Open decisions).
- Vertical gridlines + Geist medium weight applied to the matrix/app — user approved Geist + gridlines but may want the gridlines extended to the OTHER tables (RC IN / RC OUT / production) and may want to nudge the 500 weight.

### ⚠️ Deferred / known issues
- **L-009 audit_logs grant** — lean apply path not self-sufficient until fixed (task chip filed).
- **A dev server is running on `:3000`** from this checkout (started this session via `env -u ANTHROPIC_API_KEY npm run dev`, log at `/tmp/blackwood-dev.log`). Next session can reuse or restart it.
- Lean refactor of the OTHER employees (deliveries/rc-out/production/movement-auditor) is DESIGNED (`LEAN_SYNC_REFACTOR.md`) but NOT built — only gsheet-sync is lean.
- Truck readings watermark stuck at 2026-05-26 (MC's reports stopped carrying truck odometer/fuel data — operator-side, not a bug).
- Pre-existing data-quality items noted by auditors but NOT acted on: the 2025-04-30 FEB-25-BLK8 conflict (held every run), the 5/29 cross-sheet-tab double-count (21,810 = MAY-tab 11,210 + June-tab 10,600).

---

## Open decisions
- **Block-loss sign** in the matrix footer: currently `(out − in)/in` (reads negative since out < in). Flip to `(in − out)/in` to read as a positive loss? One-line change in the matrix component.
- **Extend vertical gridlines + Geist tuning** to the other inventory tables, or leave matrix-only? Confirm the medium (500) default weight feels right.
- **L-009 fix approach:** GRANT INSERT/UPDATE on `audit_logs` to the API role, OR route audit writes through a SECURITY DEFINER RPC. (Task chip filed.)
- **FEB-25-BLK8 (2025-04-30) conflict** — still held; needs a one-time manual reconciliation decision (Sheet 7,306 vs DB two×2,336).

---

## Next concrete action
1. **Fix L-009** so the lean `sync_gsheet.py --phase apply` writes its own audit rows — add the `audit_logs` grant to the PostgREST/service-role API path (or a SECURITY DEFINER RPC the script can call). Verify by re-running a small lean apply and confirming no 403. Then the lean gsheet path is fully self-contained.
2. **Confirm the block-loss sign** with the user and apply the one-liner.
3. (Optional, high-value) **Lean-refactor the other employees** per `LEAN_SYNC_REFACTOR.md`, starting with rc-out-manager (keeps the hard >500 kg drift gate).

---

## Git state
- **Branch `dev`** (pushed, in sync with `origin/dev`). This session's commits: `dbe4204` (lean sync) · `464d406` (frozen-pane fix) · `add0e28` (matrix tab) · `b3f5b68` (footer) · `b708e55` (Geist) · `a3e8c09` (gridlines).
- **Uncommitted** (from the live sync run): `.claude/skills/sync-ictc/LEARNING_LEDGER.md` (added **L-009**) and `.claude/agent-memory/production-manager/project_first_execute.md` (watermark → 2026-06-02). These + this handoff should be committed to start fresh clean.
- The daily sync mechanism = parallel `Agent` (Task) launches on **opus**, NO Workflow tool. gsheet-sync first (lean), email agents audit read-only, production in parallel, approve, then EXECUTE (continue the same agent via SendMessage so it keeps its classified context).

---

*End of handoff — 2026-06-04 — Lean ICTC sync validated with a 2nd live run (June-2 data live), RC Movement matrix shipped as the Movement tab, frozen-pane bug fixed canonically, Geist font app-wide. Next: fix L-009 audit_logs grant + confirm block-loss sign.*
