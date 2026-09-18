# 2026-09-18 — Excel export for `/operations` + colour print for RC Movement (both shipped)

> Continues `2026-09-17-session-wrap-operations-ledger-excel-print.md`. Short session: two
> features, two agents in isolated worktrees, both merged to `main` and auto-deployed.

## 1. TL;DR
- Renzo: *"create the excel generator script now for the operations sheets (put it beside print
  button). At the same time, have an agent create a similar colored print functionality for rc
  movement page. Make sure an entire month can fit inside of landscape a4."*
- **`/operations` → Export** (beside Print) downloads one workbook per selected group in Renzo's
  round-2 format. **`/inventory/rc-movement` → Print** puts the on-screen month or campaign in
  colour on ONE A4 landscape page.
- Both on `main` (`0d16043`, `569dbac`), Vercel auto-deployed. No sync-worker change, no DB change.
- **Next concrete action:** Renzo clicks Export once on the live app (the only check not done
  from here), then answers §5.

## 2. What shipped

### 2.1 Excel export — branch `feat/ops-excel-export` (`65ce83c`)
- `lib/operations/excel/{a1,styles,workbook,month-sheet,rc-movement-sheet,eoq-sheet,checks-sheet}.ts`
  — the port of `.agents/plans/ops-ledger-excel-mockup/build.py`. `a1.ts` is the ONE owner of
  cell addressing / sheet quoting and of the two guards `divBlank()` / `iferrorBlank()`.
- `app/(app)/operations/export/route.ts` — `GET ?campaigns=…`; `supabase.auth.getUser()`;
  `canViewPrices()` ANDed with the adapter's flag; `fetchOpsLedger()` + per-campaign
  `fetchRcMovementMatrix()`; built in memory; RFC 5987 `filename*`. No Storage artifact.
- `app/(app)/operations/ops-export.tsx` — the button (class string byte-identical to Print's),
  `errorToast()` on a non-200.
- `scripts/verify-ops-excel.ts` — **27 assertions**; reads `xl/worksheets/*.xml` directly because
  exceljs's reader drops a falsy cached `<v>`. `OPS_EXCEL_DUMP_DIR` env hook dumps the
  price-denied and degenerate builds for a recalculation pass.
- `exceljs ^4.4.0` in ROOT deps; in 0 of 123 client chunks.
- Sample: `.agents/plans/ops-ledger-excel-mockup/generated-ts-v1.xlsx`. Plan §11 added.

### 2.2 RC Movement print — branch `feat/rc-movement-print` (`60a1a3e`)
- `app/(app)/inventory/rc-movement/rc-movement-print.tsx` — `RcMovementPrintControl` + a plain
  non-virtualised print table portalled to `<body>`; screen colours (`print-color-adjust: exact`);
  totals and the block footer lines (FED · ₱/KG · LOSS % · optional ACTUAL) in a `<tbody>`.
- `components/shared/print/print-fit.ts` + `print-page-rules.ts` + `CONTEXT.md` — PLATFORM kit
  (zero tenant knowledge, swept by an assertion): row height from the day count with the footer
  rows in the divisor, column width from the block count, type ladder down to a floor, then
  pagination by COLUMNS with the spine repeated and the type re-solved per page.
- `app/dev/table-playground/rcmprint/` — gated fixture (the two-lock convention), kept because
  the fit is arithmetic over a font Node cannot measure.
- `scripts/verify-rc-movement-grid.ts` 14 → **23** assertions (ceiling re-derived through the
  solver, no `<tfoot>`, price gate, both button wirings, tenant sweep).
- Registered `components/shared/print/CONTEXT.md` in CLAUDE.md's context-file list.

## 3. Decisions taken by default (Renzo said "build it now")
Round-2 format is final · RC Movement linked footer rows stay GREEN · per-day yield/loss OUT of
the month tabs · all eight waste streams + every grade column IN · day rows only · Production
export ALLOWED with ₱ structurally absent · file `Blackwood Operations — <group>.xlsx`, tabs
`JULY 2026` …  **Reversible; say the word.**

## 4. Critical learnings
1. **A ported spreadsheet must be tested on a selection the mock-up never saw.** `build.py` had bare
   divisions and was fine on Q3; the export runs on ANY campaign, and one with no production /
   no closed block / no price set published **27 `#DIV/0!` cells including the EOQ headline
   yield.** 42 divisions now go through `IFERROR` — not `IF(den>0,…)`, because in Excel text
   compares greater than any number, so `""&gt;0` is TRUE and waves a blank into the division.
   Cost: 42 of the 43 differing cells vs Renzo's file (the 43rd is `'Checks'!F:F` quoted).
2. **`soffice --convert-to` on a cache-bearing xlsx proves nothing** — LibreOffice's default for
   xlsx is never-recalculate, so it echoes cached results back. Strip caches with openpyxl first;
   the tell was recalculated values being the payload's *rounded* KPI figures.
3. **exceljs's reader drops a falsy cached result**, so `0` and a deliberate blank both read as
   `undefined`; the file's XML is the authority. Also `walk()` must skip merged-range slaves.
4. **Solve the print type for the widest PAGE, not for all columns** — splitting after solving
   left paginated sheets at the 5 pt floor in gutters wide enough for 8 pt.
5. **Stopped agents cannot be resumed** — their worktrees survive, so a fresh agent pointed at the
   existing worktree path (absolute `cd` in every command) picks the work up without loss.

## 5. Open decisions (Renzo)
1. Any of §3 to reverse?
2. `Checks` tab: a campaign with NO activity reads `workbook 0 · database blank · CHECK` on its
   three `SUM`-backed kg rows (Excel's `SUM` of nothing is 0, the DB publishes NULL). Change the
   check semantics, or leave it as an honest reading?
3. Everything in the 09-17 wrap §5 still stands (EOQ strip bases, group PC-cost coverage rule,
   rest-day dash). And §4.2's **untraced AUGUST 12,314 kg drop** still has no owner.

## 6. Known issues / not done
- No live authenticated Export download was exercised from here (route compiles, is registered
  as dynamic, and both gates are verified statically).
- `app/(app)/operations/ops-page-print.tsx` still carries its own fit maths
  (`ledgerMetrics`, `OPS_PRINT_MAX_ROWS_PER_PAGE`) — could be re-pointed at the shared kit.
- `GroupPrintStage` registers `afterprint` after `printCard()` returns, so it unmounts via the
  2 s fallback (benign, shared with `/analytics`).
- Lint baseline unchanged at 16 pre-existing errors, none in touched files.

## 7. Git state
`main` @ `569dbac` = `origin/main`. Branches kept: `feat/ops-excel-export`, `feat/rc-movement-print`.
Two worktrees under `.claude/worktrees/` (`agent-a6a3f820ae48ba5ac`, `agent-a083ae1e6af658bb1`)
now hold committed, merged branches and can be removed. Fly worker unchanged (**v31**).
This file + the TIMELINE row + the CLAUDE.md line are committed right after writing.
