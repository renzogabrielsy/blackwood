# Operations Excel report — the local mock-up (2026-09-17)

Reference material for building the automated export described in
`../ops-ledger-excel-plan.md`. **Not app code.** Nothing here is imported by the site.

| File | What it is |
|---|---|
| `build.py` | The generator (Python + openpyxl). Reads the four JSON files beside it and writes `generated-v3.xlsx`. **This is the executable spec of Renzo's format** — it reproduces his hand-edited workbook with 0 differing cells on all six tabs. |
| `july.json` · `august.json` · `september.json` | Live Q3 2026 data as pulled on 2026-09-17: `days` (date, weekday, fed ₱/kg, fed kg, shifts, DT hrs, eight waste streams, grade kg map), `blocks` (batch, loc, open, close, status, closed?, campaign fed kg, arrival kg, resiko kg, balance kg, block ₱, actual ₱, in price set), `cells` (date, batch, kg). **Carries ₱.** |
| `kpis.json` | The database's own campaign KPI figures that day — the `Checks` tab's comparison values. |
| `generated-v3.xlsx` | The generator's output, recalculated (1,075 formulas, 0 errors, 39/39 checks OK). |
| `renzo-edited-round1.xlsx` | Renzo's FIRST hand edit (style: all-black text, Short Date, column A 18.16, centred band; EOQ Arial 11 bold / zoom 130 / hidden checks row — that EOQ styling was NOT repeated in round 2). |
| `renzo-edited-round2.xlsx` | Renzo's SECOND hand edit — the standing format (every explanatory prose line removed). |
| `diff.py` | The cell-by-cell diff used to detect his edits. Point its two `load_workbook` paths at a fresh build and at his file. |
| `generated-ts-v1.xlsx` | **The SHIPPED TypeScript builder's own output** (`lib/operations/excel/**`), rewritten by `npx tsx scripts/verify-ops-excel.ts` from these same JSON fixtures. Kept here so the port can be diffed against Renzo's file at any time: **43 differing cells, all accounted for** — 42 `IFERROR` division guards and one always-quoted sheet name (plan §11). Unlike the openpyxl outputs it carries cached results, so **strip them before recalculating** or LibreOffice will just echo them back. |

Run: `python3 build.py` (needs `openpyxl`), then recalculate with LibreOffice before reading
values (`openpyxl` writes formulas without cached results).

**This directory is reference material, and the app is now the implementation.** The automated
export shipped on 2026-09-18 — see `app/(app)/operations/CONTEXT.md` → "THE EXCEL EXPORT" for the
live behaviour and plan §11 for how to re-run the fidelity diff (including the LibreOffice
recalculation trap). `build.py` remains the executable statement of the FORMAT.

Lessons from detecting his edits are in the plan, §9–§10: filter Excel's save noise, detect
deleted rows before diffing by coordinate, and identify WHICH file he edited from
`lastModifiedBy` + the Excel lock file rather than from its name.
