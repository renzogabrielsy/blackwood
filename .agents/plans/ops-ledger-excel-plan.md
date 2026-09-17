# Operations Excel Report — formulation (NOT built yet)

> Status: **PLAN ONLY** (2026-09-17). Renzo: *"The idea is like printing but more Excel-report
> based for easy emails… the Excel should utilize formulas… EOQ Summary should be using
> formulas to grab data from the other month tabs… an RC Movement tab that features 3 separate
> RC Movement tables inside ONE tab. If it is a complicated process, then just formulate first."*
> It is a moderately complicated process, so this document is the formulation. Nothing here is
> implemented. Read `app/(app)/operations/CONTEXT.md` first; this plan reuses its payload.

## 1. What the file is

`Blackwood Operations — <Quarter label or campaign list>.xlsx`, generated on demand from the
same selection the `/operations` page shows (`?campaigns=`). One click, one download, ready to
attach to an email. Tabs, in order:

| # | Tab | Content |
|---|---|---|
| 1 | `EOQ Summary` | One row per campaign + a GROUP row. **Every cell is a formula** pointing at the month tabs. |
| 2..N | `JULY 2026`, `AUGUST 2026`, … | One tab per campaign: an EOM rollup block on top, the day ledger below, the BLOCKS USED table beneath it. |
| N+1 | `RC Movement` | One tab, the campaigns' day × block matrices **stacked vertically**, each with its own header, totals row and block footer. |
| N+2 | `Checks` | Every formula-derived KPI beside the database's own published figure, with a difference and an OK flag. |

## 2. The governing rule: values in, formulas out

The platform rule "never compute in TypeScript" stays intact. The builder writes two kinds of
cell and nothing else:

- **INPUT cells = plain values**, taken verbatim from the payload (which is SQL's output):
  per day — date, fed ₱/kg, grade kg, the eight waste streams, shifts, downtime hours; per
  block — campaign fed kg, arrival kg, resiko kg, block price, actual price, state; per
  RC Movement cell — kg fed.
- **DERIVED cells = Excel formulas**, so the workbook recalculates if Renzo edits an input:

| Where | Cell | Formula shape |
|---|---|---|
| month tab, day row | TTL FED | `=SUM(<that day's row in the RC Movement table>)` — a cross-tab link, so the ledger and the matrix cannot disagree |
| | TTL PROD | `=SUM(<grade columns>)` |
| | WASTE kg | `=SUM(<eight stream columns>)` |
| | WASTE % | `=IF(prod>0, waste/prod, "")` |
| month tab, totals row | every kg column | `=SUM(column)` |
| month tab, EOM rollup | RC Fed / Produced / Waste | `=SUM(...)` of the ledger columns |
| | Yield | `=Produced/RC Fed` · Loss `=1-Yield` · Waste % `=Waste/Produced` |
| | Fed Price | `=SUMPRODUCT(price, fed)/SUMIF(price,">0",fed)` |
| | Actual Fed Price | `=SUMPRODUCT(actual, campaignFed × inSet)/SUMPRODUCT(campaignFed × inSet)` over the BLOCKS USED table |
| | Resiko Cost | `=Actual − (delivered over the same block set)` |
| | Resiko Loss | `=SUM(resiko kg, closed)/SUM(arrival kg, closed)` |
| | PC Cost | `=Fed Price/Yield` |
| | True PC Cost | `=IF(COUNTIF(inSet,FALSE)=0, Actual/Yield, "")` — blank on purpose until every block is closed and priced |
| EOQ Summary, campaign rows | all eleven KPIs | `='JULY 2026'!C5` style references — no value is typed twice |
| EOQ Summary, GROUP row | kg | `=SUM(campaign rows)` |
| | Yield / Waste % / Fed Price | weighted: `=SUM(prod)/SUM(fed)`, `=SUM(waste)/SUM(prod)`, `=SUMPRODUCT(price,fed)/SUM(fed)` |
| | Actual / Resiko Cost / Resiko Loss | weighted by each campaign's *fed kg inside its price set* (an input cell on each month tab) |
| | Resiko **kg** | **left blank, with a cell note** — a block fed by two campaigns would be counted twice (78 of 523 blocks are shared) |
| RC Movement, per table | row total, column FED | `=SUM(...)` |

Every formula cell is written as `{ formula, result }` with `result` = **the database's
published figure**, so the numbers show even in viewers that do not recalculate (email
previews, phone quick-look, a Google Sheets import). Excel itself recalculates on open
(`fullCalcOnLoad`).

## 3. The `Checks` tab — the workbook audits itself

For every derived KPI: `formula value · database value · difference · OK`. The database value
is written as a plain number; the formula value is a reference to the real cell. `OK` is
`=ABS(diff)<tolerance`. One summary cell on `EOQ Summary` reads *"All 44 checks OK"* or names
the count that failed. This is the spreadsheet version of `verify-ops-ledger.ts`: if a formula
and the SQL view ever disagree (a partially-traceable fed price, a changeover day, an edited
input), the file says so instead of quietly showing a different number from the app.

Known places the two will legitimately differ, to be labelled rather than hidden:
- **Fed price under partial traceability** (SEPTEMBER 2026 today: 2,000 untraceable kg) — the
  sheet formula and the strict SQL figure differ; the check row carries a note.
- **Changeover dates** (08-01, 08-29) appear on two month tabs — correct, and the GROUP row
  sums campaigns, not calendar days, so nothing double counts.

## 4. `RC Movement` tab — three tables in one sheet

Stacked vertically, three blank rows apart, because each campaign has a different block column
set (max ~25 columns) and a sheet can freeze panes only once (columns A–E frozen: #, date, day,
fed ₱/kg, total fed). Each table: a title row (`JULY 2026 · 2026-06-30 → 2026-08-01`), the block
header (batch code over block loc), one row per calendar day (rest days blank), a TOTALS row of
`=SUM` per block column, then the three-line footer Renzo specified on 2026-09-17 —
`FED` (formula) · `₱/KG` (block price, value) · `LOSS %` (value) — plus an optional `ACTUAL`
line. Each table gets a defined name (`RCM_JULY_2026`) so the month tab's TTL FED link is
readable in the formula bar.

## 5. Price gating

The builder takes `canViewPrices` from the same `canViewPrices()` gate. For a price-denied
caller the ₱ columns are **structurally absent** (columns not written, formulas that need them
not written) — never blanked cells, never hidden columns (hidden columns are one click from
visible). The Production workbook is therefore a smaller file, not a censored one.

## 6. How it would be built

- **Library:** `exceljs` (already used by the sync worker's report generator:
  `workers/sync/src/reports/excel/workbook.ts`). The app root only has the plain `xlsx`
  package, which writes formulas but not styling — so `exceljs` is added to the ROOT
  dependencies, imported only from a server route so it never reaches a client bundle.
- **Delivery:** a route handler `app/(app)/operations/export/route.ts`
  (`GET ?campaigns=…`) that calls the existing `fetchOpsLedger()` and, per campaign,
  `fetchRcMovementMatrix()`, builds the workbook in memory and streams it as an attachment.
  No Storage bucket, no stored artifact — the file is a view of the live data, like the page.
  (An "email it from the app" button is a later step, not part of this.)
- **Files:** `lib/operations/excel/{workbook.ts, month-sheet.ts, eoq-sheet.ts,
  rc-movement-sheet.ts, checks-sheet.ts, styles.ts, a1.ts}` — `a1.ts` owns cell addressing so
  no formula string is hand-concatenated in more than one place. An `Export` button on the page
  toolbar next to `Print`.
- **Formatting:** the page's semantic palette as light header fills (sky FED · emerald
  PRODUCED · amber LOSS · rose WASTE · violet ₱), thin borders, `#,##0` kg, `0.00%`,
  `₱#,##0.00`, column widths from the same measured table the page uses, header row frozen,
  landscape print setup with fit-to-width so the sheet also prints cleanly.
- **Verification:** `scripts/verify-ops-excel.ts` builds the Q3 workbook from a fixture payload,
  re-opens it, and asserts (a) every formula parses and targets an existing cell/sheet, (b)
  every cached `result` equals the payload figure, (c) sheet names ≤ 31 characters and quoted
  correctly in references, (d) the price-denied build contains no `₱` and no price column, (e)
  the GROUP resiko-kg cell is blank. A formula evaluator (`hyperformula`, dev-dependency only)
  can additionally recompute the sheet and compare against the cached results.

## 7. Phases and effort

| Phase | Scope | Size |
|---|---|---|
| X1 | builder skeleton, `a1.ts`, one month tab with ledger + EOM rollup formulas, route + Export button | one agent pass |
| X2 | BLOCKS USED section + the four price/resiko formulas; `EOQ Summary` with cross-tab references and the weighted GROUP row | one agent pass |
| X3 | `RC Movement` tab (stacked tables, defined names) and the TTL FED cross-tab link | one agent pass |
| X4 | `Checks` tab, `verify-ops-excel.ts`, price-denied build, print setup polish | one agent pass |

No database change is needed: every input is already in the payload (`fetchOpsLedger`,
`OpsCampaign.blocks`, `fetchRcMovementMatrix`).

## 8. Decisions needed from Renzo before building

1. **Per-day Yield % / Loss %** — leave them out of the month tabs, as in print (the campaign
   figure is the real one)? *Recommended: out.*
2. **Waste streams and grades on the month tab** — include all eight streams and every grade
   column (the tab is wide but it is a spreadsheet)? *Recommended: in.*
3. **Shift rows** — one row per day only, or also the per-shift child rows (grouped/outlined so
   they collapse)? *Recommended: day rows only in v1.*
4. **Production-role export** — allowed, with the ₱ columns absent? *Recommended: yes.*
5. **File name and sheet names** — `Blackwood Operations — Q3 2026.xlsx`, tabs named
   `JULY 2026` etc.?

## 9. FORMAT RULES — taken from Renzo's edited mock-up (2026-09-17)

Renzo edited the first mock-up by hand (JULY tab, the first RC Movement table, the EOQ Summary)
and asked that the edits be DETECTED and remembered as the format for generation. They were
recovered by diffing his file against a fresh build, after discarding Excel's save noise
(`00`→`FF` colour alpha, escaped `\-` in number formats, grouped `<col min max>` widths,
single-cell merges dropped, auto row heights). The generator script reproduces his month tabs and
RC Movement tab with **0 differing cells**.

**Month tabs (all of them):**
1. **All text is black.** No blue "database value", green "link" or grey muted colour coding —
   title, subtitle, headers, inputs, links, totals, the blocks table. (Fills and borders stay.)
2. **Dates use Excel's built-in Short Date** (`numFmtId 14`; the libraries spell it `mm-dd-yy`,
   LibreOffice rewrites it as `m/d/yyyy`; on his Mac it reads `6/30/2026`) — the ledger DATE column
   and the blocks table's DATE OPEN / DATE CLOSE.
3. **Column A is 18.16 wide** (was 12).
4. **The group band row** (`DAY · PRICE · FED · PRODUCED · WASTE · SHIFT · GRADES · WASTE STREAMS`)
   **is centred**, not left-aligned.

**RC Movement tab (every table):**
1. **Day rows are all black** — index, date, day, fed ₱/kg, total, every block cell.
2. **Dates use Short Date**, as above.
3. Left as built: the grey subtitle and grey block-location sub-labels, the bold totals row, and
   the **green** linked footer rows (₱/KG · LOSS % · ACTUAL). *Open question: should those footer
   links go black too, for consistency with the month tabs?*

**EOQ Summary (his edits, not yet folded into the generator — confirm before building):**
the subtitle line under the title was deleted (header moves up to row 3, campaigns 4–6, GROUP 7);
title 14 → 11 pt bold; every header and value is **Arial 11 bold, black**; column headers
right-aligned over their numbers; the `CHECKS` status row is **hidden** (row 9); sheet zoom **130 %**.
The `Checks` tab was not touched.

**Practical note for the automated builder:** write Short Date as the built-in format id, never as
a literal pattern, so the date follows the reader's locale the way his hand-edited file does.

## 10. FORMAT RULES, ROUND 2 — Renzo's second edit (2026-09-17, supersedes §9 where they differ)

Renzo edited the regenerated workbook again (the generator's own output, `generated-v2.xlsx`).
This round the edits were STRUCTURAL, not stylistic, and they all say one thing:
**no explanatory prose in the report.**

| Tab | What he removed | Resulting layout |
|---|---|---|
| `EOQ Summary` | the subtitle line under the title, and the whole six-line "HOW TO READ THIS FILE" notes block | title r1 · header **r3** · campaigns **r4–r6** · GROUP **r7** · CHECKS status **r9** (visible) · sheet ends at r9 · freeze `B4` |
| every month tab | the subtitle line (`<span> · N days · R rest · colour legend`) | title r1 · EOM rollup **r3/r4** · band **r7** · column headers **r8** · first day **r9** |
| `RC Movement` | the subtitle/legend line | title r1 · first table title **r3** · headers r4–r5 · first day r6 · freeze `F3` |

**Kept as built (so they stay in the generator):** the one-line note beside `BLOCKS USED`, every
cell comment, the `Checks` tab including its two-line header, all fills / borders / widths, the
grey block-location sub-labels and the green linked footer rows on `RC Movement`.

**Round-1 EOQ styling was NOT repeated** (Arial 11 bold, 130 % zoom, hidden CHECKS row): on the
second pass he left the EOQ fonts as generated (Arial 9 bold headers, Arial 10 values, bold GROUP
row) and the CHECKS line visible. The second edit is the later and therefore the standing one.

**Proof the rules are captured:** the generator script rebuilt with these rules matches his file
with **0 differing cells on all six tabs** (value-or-formula, font colour, weight, size,
alignment and number format, after normalising Excel's save noise), recalculates with
**1,075 formulas / 0 errors**, and its `Checks` tab reads **39 of 39 OK**.

**Method note for next time** — a row deletion shifts every coordinate, so a cell-by-cell diff
reports hundreds of false changes. Detect the deleted row first (align on column A), diff with
the shift applied, and read a restructured tab row by row instead of by coordinate. And find the
file he actually edited before diffing anything: this round it was the generator's output sitting
beside the mock-up, identified by its `lastModifiedBy` and an Excel lock file, not by its name.
