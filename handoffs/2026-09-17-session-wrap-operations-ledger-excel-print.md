# 2026-09-17 — SESSION WRAP: `/operations` from incident to shipped, L-052, the Excel mock-up, print in colour

> **Read this one first.** It wraps a single long session that ran 2026-09-14 → 2026-09-17 and
> already produced ten per-round handoffs (listed in §7). Those hold the detail; this file is the
> map, the current state, and the open decisions. Continues
> `2026-09-14-downtime-fix-ops-ledger-drafts-DB-INCIDENT.md`.

## 1. TL;DR
- The session opened on a **hung production database** (a whole-history SQL probe). It was
  recovered, the probe dropped, and the ops-ledger data layer re-proven **per campaign**.
- The **Plant Operations Ledger** now lives at **`/operations`** on real data, refined through
  seven rounds of Renzo's feedback, all on `main` and deployed.
- A real **sync bug** was found and fixed (**L-052**): Ivy's waste report inherited MC's
  watermark, silently dropping five waste days. Worker on **Fly v31**; backfill **applied**.
- The **Excel report** is *formulated and mocked up*, not built. Renzo hand-edited the mock-up
  twice; his format is captured and the generator reproduces his file with 0 differing cells.
- **Next concrete action:** get Renzo's answers to §5, then build the Excel export
  (plan `.agents/plans/ops-ledger-excel-plan.md` §6–7, four passes). In parallel, someone should
  pick up the **untraced AUGUST feed drop** (§4.2) — it has a task chip but no owner yet.

## 2. What shipped (all on `main`, tip `bb175a3`; Vercel auto-deployed; Fly v31)

### 2.1 Data layer — `view_ops_ledger_*` (10 views, 2 RPCs, 3 probes)
Migrations, in order: `20260914033037_ops_ledger` · `20260914064415_drop_fn_ops_ledger_verify` ·
`20260914065453_ops_ledger_verify_per_campaign` · `20260914065558_…_security_invoker` ·
`20260915021820_ops_ledger_campaign_waste` · `20260915021924_…_security_invoker_restore` ·
`20260915032016_ops_ledger_day_ratios_waste_over_produced` ·
`20260915073755_ops_ledger_campaign_blocks_and_shift_grades` · `20260915074246_…_comment…` ·
`20260916030358_ops_ledger_day_fed_blend_quarters_arrival` · `20260916031811_…_verify_split…`.
Adapter `lib/operations/queries.ts`, port `lib/operations/types.ts`, proofs
`scripts/verify-ops-ledger.ts` (**87 assertions**, sequential per campaign, zero mismatches).
Full detail: `CLAUDE.md` → "Plant Operations Ledger" and `app/(app)/operations/CONTEXT.md` → Data.

### 2.2 The page — `app/(app)/operations/`
`page.tsx` · `operations-view.tsx` · `ops-ledger-table.tsx` (ONE table, frozen spine, lenses
Production / Grades / Losses / Blocks fed, shift child rows, `?ratios=off`) · `ops-kpi-strip.tsx`
(11-column EOQ strip, units pinned left, every cell opens a modal) · `ops-kpi-modal.tsx` ·
`ops-blocks-table.tsx` (BLOCKS USED, 7 and 12 columns, aligned `<tfoot>`) ·
`ops-production-table.tsx` · `ops-rc-movement-modal.tsx` (embeds the real `RcMovementMatrix`,
lazy-loaded) · `ops-fed-day-sheet.tsx` (FED cell → day sidebar with the PROJECTED lab profile) ·
`ops-group-picker.tsx` (quarters by date, latest quarter default) · `ops-print-sheet.tsx` (price
summaries) · `ops-page-print.tsx` (whole page, colour, one A4 landscape page per campaign) ·
`ops-lens.ts` · `ops-color.ts` · `ops-format.ts` · `ops-modal-size.ts`.
Platform lifts: `components/shared/unit-value.tsx`, `components/shared/print/{print-card.ts,group-print.tsx}`
(analytics re-exports both).

### 2.3 RC Movement (shared with the ops modal)
`rc-movement-matrix.tsx` + `rc-movement-grid-v2.tsx`: block footer is now three lines —
`FED` (THIS campaign's kg, from `view_ops_ledger_campaign_block`) · `₱/KG` (block price) · `LOSS %`
(positive) — with an optional `ACTUAL ₱` fourth line via `actual-price-toggle.tsx` (`?actual=on`).
`scripts/verify-rc-movement-grid.ts` → 14 assertions.

### 2.4 Sync — L-052 (`workers/sync/**`, Fly **v31**)
`db.productionWasteFrontier()`, `wasteGap.ts::auditWasteGap` (`waste_row_missing` /
`waste_row_disagrees`), `normalizeReport.ts` now carries `downtime_notes` (L-051's findings had
never reached a stored run), `scripts/backfill-waste-frontier-gap.ts` — **APPLIED**: 5 inserts + 1
replace; JULY waste 106,506.5 kg (17.15%), AUGUST 78,954.5 kg (14.27%). Tests 1,043; parity 12/12.

### 2.5 Excel report — formulated, mocked up, format captured (NOT built)
- Plan: `.agents/plans/ops-ledger-excel-plan.md` (§1–8 design, **§9–10 Renzo's format rules**).
- Reference kit (preserved from the session scratch folder this handoff):
  `.agents/plans/ops-ledger-excel-mockup/` — `build.py` (the generator = executable format spec),
  `july/august/september.json` + `kpis.json` (live Q3 data, carries ₱), `generated-v3.xlsx`,
  `renzo-edited-round1.xlsx`, `renzo-edited-round2.xlsx` (the standing format), `diff.py`, `README.md`.

## 3. Critical learnings (the ones a fresh context cannot reconstruct)
1. **Never run whole-history proofs on a view stack.** One SECURITY DEFINER "verify everything"
   call hung the instance. Per campaign, `set local statement_timeout='5s'`, sequential, a group
   probe that RAISES above 12 keys. Filter on `production_batch` + `campaign_year`, never the
   computed `campaign_key` (it cannot be pushed down).
2. **`CREATE OR REPLACE VIEW` keeps grants but RESETS `reloptions`** — it silently dropped
   `security_invoker` from the ₱-bearing KPI view twice. Re-ALTER in the same migration; verify
   from `pg_options_to_table(pg_class.reloptions)`. (Also in memory.)
3. **A cumulative source must not inherit another source's watermark** (L-052). A silent
   `continue` on a date filter is a data-loss primitive. And a finding is not "shipped" until a
   stored `sync_runs.result` carries its key.
4. **A footer under a one-campaign column must say which clock it is on.** 78 of 523 blocks span
   campaigns; the RC Movement footer printed LIFETIME fed and Renzo concluded yield was wrong. It
   was not (AUGUST divides by its own fed kg, tied three ways).
5. **A day belongs to a campaign** — changeover dates (08-01, 08-29) are two rows. Keys and
   expand state are `campaign:date`; the stray-row bug was React duplicate keys.
6. **`batches.quality_stats` is not a lab profile** (3 keys, `bd`≈0). The projected fed blend
   reproduces the Blocking grid's delivery-weighted means, because the grid has no rows for closed
   blocks.
7. **UI/print gotchas:** `border-collapse` makes sticky cells transparent (use `border-separate`);
   `backdrop-filter` makes a dialog the containing block for `position: fixed` children (the RC Fed
   dialog is opaque for that reason); Tailwind v4 centres dialogs with `translate`, which
   `transform:none` does not reset (print stage is portalled to `<body>`); a `<tfoot>` repeats on
   every printed page (totals are a `<tbody>` row); print row height is a function of day count
   with the totals row in the DIVISOR; `print-color-adjust: exact` or backgrounds vanish.
8. **Detecting a human's spreadsheet edits:** filter Excel's save noise (colour alpha, escaped `\-`,
   grouped `<col>` widths, auto row heights); detect DELETED ROWS before diffing by coordinate;
   compare structurally matching rows inside the edited file; and find WHICH file was edited from
   `lastModifiedBy` + the Excel lock file — round 2 was in the generator's output, not the mock-up.
9. **Two agents in one working tree cross branches** — sequence them (backend → guardian → frontend
   → guardian) or use worktrees. Verify every agent's output on disk before trusting its report.

## 4. Current state
### 4.1 Working and proven
Data layer (87 assertions), `verify-worker-view-grants` 4 views / 0 findings, `verify-trigger-grants`
2/2, `verify-rc-movement-grid` 14, `verify-findings` 96, worker tests 1,043, parity 12/12, tsc / lint /
`npm run build` clean at every merge. Print verified with REAL headless-Chrome PDFs (4 pages for
33/29/19 days; ceiling 47 day rows per sheet).

### 4.2 Known issues / unverified
- **UNTRACED: AUGUST 2026 fed total fell 709,627 → 697,313 kg on 2026-09-17 with NO audit row.**
  `view_rc_movement_campaign_cells` is a plain GROUP BY over `rc_out`, so 12,314 kg of
  AUGUST-tagged MAIN rows existed that morning and were gone hours later; `public.rc_out` has only
  `tr_blackwood_usage` — **no audit trigger**. A follow-up task chip was raised
  ("Investigate untraced 12,314 kg drop in AUGUST 2026 feed"); nobody has taken it.
- **Every UI check this session ran on synthetic fixtures**, because the dev server has no signed-in
  session. Renzo's own use of production is the only real-data verification. His screenshots so
  far have matched.
- **Basis mismatch on the EOQ strip:** RESIKO COST (`uplift_php_kg`) is whole-block; the ACTUAL FED
  PRICE shown is campaign-attributed; Fed Price + Resiko Cost ≠ Actual by ~₱0.07.
- **Pre-existing divergence:** group PC-cost (delivered) computes under partial fed-price coverage
  while the campaign figure blanks (`group_pc_cost_delivered_coverage_divergence`, printed by name
  every verify run).
- Escape inside the RC Fed modal closes both the block drawer and the dialog.
- A rest day prints a lone `—` under WASTE % (screen and print).
- The verify script's per-campaign wall-clock budget is round-trip dominated (now 10 s + a
  12×-median guard); server-side each probe is 0.3–1 s.

### 4.3 Housekeeping not done
Dead `OpsCampaignOption.totalFedKg`; unused `view_ops_ledger_day_blocks_used`; `/dev/ops-ledger`
drafts still in the repo; `OpsPrintRollupPage` / `OpsPrintCampaignPage` / `OPS_PAGE_PRINT_RULES`
exported only for the static PDF test; no static assertion pins the EOQ column count / spine width.

## 5. Open decisions (Renzo)
1. **Excel:** RC Movement footer rows black or green? · adopt round-2 as final (it is treated as
   standing)? · plan §8's five: per-day yield/loss out · all streams + grades in · day rows only ·
   Production export allowed without ₱ · file/tab naming.
2. **EOQ strip basis:** put RESIKO COST and ACTUAL FED PRICE on ONE basis (whole-block or
   campaign-attributed)?
3. **Group PC-cost coverage rule:** blank it under partial coverage (matches the campaign row) or
   keep computing?
4. **Rest days fully blank** (drop the WASTE % dash)?
5. **Waste % denominator** is produced kg (his ruling 2026-09-15) — settled; listed so nobody
   re-opens it by accident.

## 6. Next concrete action
Build the Excel export once §5.1 is answered: add `exceljs` to the ROOT dependencies (the worker
already uses it), a route handler `app/(app)/operations/export/route.ts` calling `fetchOpsLedger()` +
`fetchRcMovementMatrix()` per campaign, files under `lib/operations/excel/` with ONE `a1.ts` owning
cell addressing, an `Export` button beside `Print`, and `scripts/verify-ops-excel.ts`. Port
`.agents/plans/ops-ledger-excel-mockup/build.py` sheet by sheet — it is the format spec and already
matches Renzo's file cell for cell. Write Short Date as Excel's built-in format id 14, never a
literal pattern. ₱ columns ABSENT for a price-denied caller. Four passes (plan §7: X1–X4).

## 7. The per-round handoffs this wraps (newest first)
`2026-09-17-ops-ledger-round-6-print-and-excel-mockup.md` (+ addendum: print colour/fit, Excel round 2) ·
`2026-09-17-rc-movement-footer-and-waste-frontier-L052.md` ·
`2026-09-16-ops-ledger-refinements-round-5.md` · `2026-09-16-ops-ledger-refinements-round-4.md` ·
`2026-09-15-ops-ledger-refinements-round-3.md` · `…-round-2.md` · `2026-09-15-ops-ledger-refinements.md` ·
`2026-09-14-ops-ledger-incident-recovery-operations-page.md` ·
`2026-09-14-downtime-fix-ops-ledger-drafts-DB-INCIDENT.md`.

## 8. Git state
Branch `main` @ `bb175a3`, in sync with `origin/main`; every feature branch of this session is
merged and kept (`feat/ops-ledger`, `feat/ops-ledger-refine` … `-6`, `fix/rc-movement-block-footer`,
`fix/sync-waste-frontier`, `feat/ops-print-color-fit`, two `docs/*`). Uncommitted at handoff: this
file, the TIMELINE row and `.agents/plans/ops-ledger-excel-mockup/` (committed right after writing),
plus the standing machine-local diffs (`.claude/agent-memory-local/**`, `supabase/.temp/cli-latest`).
Fly worker **v31**, healthy.
