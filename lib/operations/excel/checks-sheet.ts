// ═════════════════════════════════════════════════════════════════════════════════
// checks-sheet.ts — the workbook audits itself.
//
// For every derived KPI: the FORMULA's value (a live link to the real cell), the
// DATABASE's own published figure (a typed number), the difference, and an OK /
// CHECK flag against a per-figure tolerance. This is the spreadsheet version of
// `scripts/verify-ops-ledger.ts`: if an Excel formula and the SQL view ever
// disagree, the file SAYS SO instead of quietly showing a different number from
// the app.
//
// ⚠ IT IS AUTHORITATIVE ONLY AFTER RECALCULATION. Every formula in this workbook
// is written with a cached result taken from the payload — the database's own
// figure — so that a viewer which does not recalculate still shows real numbers.
// The consequence is that the WORKBOOK column and the DATABASE column are equal in
// the cached view by construction. The workbook sets `fullCalcOnLoad`, so Excel
// recomputes on open and the comparison becomes real; a quick-look preview shows
// the DB figures twice, which is honest but not yet a check.
//
// TWO KNOWN, LEGITIMATE DISAGREEMENTS (plan §3), to be read rather than repaired:
//   · Fed price under partial traceability — SEPTEMBER 2026 has 2,000 untraceable
//     kg, so the sheet's weighted formula and the strict SQL figure differ.
//   · A changeover date appears on two month tabs. Correct: the EOQ row sums
//     CAMPAIGNS, not calendar days, so nothing is double counted.
//
// A PRICE-DENIED BUILD SIMPLY HAS FEWER ROWS — the five ₱ figures are not written.
// ═════════════════════════════════════════════════════════════════════════════════

import type ExcelJS from 'exceljs';

import { a1, passBlank, sheetRef } from './a1';
import { ALIGN, FILLS, FMT, FONTS, freeze, put, putFormula } from './styles';
import type { MonthSheetLayout } from './month-sheet';
import type { OpsExcelInput } from './workbook';

export const CHECKS_SHEET_NAME = 'Checks';

/** The status column — `COUNTIF(F:F,"OK*")` on the EOQ tab counts both OK spellings. */
const STATUS_OK = 'OK';
const STATUS_OK_BLANK = 'OK (blank on purpose)';
const STATUS_CHECK = 'CHECK';

interface CheckSpec {
  label: string;
  /** Which sheet region carries the workbook's own answer. */
  where: 'eom' | 'totals';
  /** The logical column id inside that region. */
  id: string;
  fmt: string;
  tolerance: number;
  php?: boolean;
  /** The database's published figure for this campaign. */
  value: (r: OpsExcelInput['campaigns'][number]['rollup']) => number | null;
}

const SPECS: readonly CheckSpec[] = [
  { label: 'RC fed kg', where: 'totals', id: 'ttlFed', fmt: FMT.kg, tolerance: 0.5, value: (r) => r.fedKg },
  { label: 'Produced kg', where: 'totals', id: 'ttlProd', fmt: FMT.kg, tolerance: 0.5, value: (r) => r.producedKg },
  { label: 'Yield', where: 'eom', id: 'yield', fmt: FMT.pct4, tolerance: 0.00005, value: (r) => r.yieldPct },
  { label: 'Loss', where: 'eom', id: 'loss', fmt: FMT.pct4, tolerance: 0.00005, value: (r) => r.processLossPct },
  { label: 'Waste kg', where: 'eom', id: 'wasteKg', fmt: FMT.kg1, tolerance: 0.05, value: (r) => r.wasteKg },
  { label: 'Waste %', where: 'eom', id: 'wastePct', fmt: FMT.pct4, tolerance: 0.00005, value: (r) => r.wasteLossPct },
  { label: 'Fed price', where: 'eom', id: 'fedPrice', fmt: FMT.php4, tolerance: 0.005, php: true, value: (r) => r.fedPhpKg },
  { label: 'Actual fed price', where: 'eom', id: 'actualFedPrice', fmt: FMT.php4, tolerance: 0.005, php: true, value: (r) => r.campaignWeightedActualFedPhpKg },
  { label: 'Resiko cost', where: 'eom', id: 'resikoCost', fmt: FMT.php4, tolerance: 0.005, php: true, value: (r) => r.upliftPhpKg },
  { label: 'Resiko loss', where: 'eom', id: 'resikoLoss', fmt: FMT.pct4, tolerance: 0.00005, value: (r) => r.blocksClosedResikoLossPct },
  { label: 'PC cost', where: 'eom', id: 'pcCost', fmt: FMT.php4, tolerance: 0.005, php: true, value: (r) => r.phpPerProducedKgDelivered },
  { label: 'True PC cost', where: 'eom', id: 'truePcCost', fmt: FMT.php4, tolerance: 0.005, php: true, value: (r) => r.phpPerProducedKgTrue },
  { label: 'Fed kg in price set', where: 'eom', id: 'inclKg', fmt: FMT.kg, tolerance: 0.5, value: (r) => r.campaignFedKgIncluded },
];

const HEADERS = ['CAMPAIGN', 'FIGURE', 'WORKBOOK', 'DATABASE', 'DIFFERENCE', 'STATUS', 'TOLERANCE'];
const WIDTHS = [18, 22, 16, 16, 14, 24, 11];

/** What the EOQ tab's one-line status cell needs to know. */
export interface ChecksSummary {
  total: number;
  ok: number;
  differing: number;
}

export function writeChecksSheet(
  ws: ExcelJS.Worksheet,
  input: OpsExcelInput,
  months: ReadonlyMap<string, MonthSheetLayout>,
  /** The day this payload was read — the DATABASE column's as-of date. */
  asOf: string,
): ChecksSummary {
  put(ws, 'A1', "CHECKS — the workbook's formulas against the database's own figures", {
    font: FONTS.title,
    border: null,
  });
  put(
    ws,
    'A2',
    `WORKBOOK is a live link to the formula cell. DATABASE is the figure the Blackwood views published on ${asOf}. A row reads CHECK when they differ by more than the tolerance.`,
    { font: FONTS.sub, border: null },
  );
  HEADERS.forEach((label, i) => {
    put(ws, a1(i + 1, 4), label, {
      font: FONTS.header,
      fill: FILLS.day,
      align: ALIGN.center,
    });
  });

  let rr = 5;
  let ok = 0;
  // A CONSTANT, and deliberately still carried. The cached WORKBOOK value IS the
  // database figure (see the header note), so nothing can read CHECK until Excel
  // recalculates — this is what lets the EOQ tab's one-line sentence have the same
  // shape in the cached view as it will after a recalculation.
  const differing = 0;

  for (const campaign of input.campaigns) {
    const month = months.get(campaign.key);
    if (!month) continue;
    for (const spec of SPECS) {
      if (spec.php && !input.canViewPrices) continue;
      const region = spec.where === 'eom' ? month.eom : month.ledger;
      // A campaign with no blocks never had its block-derived rollup cells written;
      // a check pointing at an empty cell would report a phantom disagreement.
      if (!region.has(spec.id)) continue;
      if (spec.where === 'eom' && !month.eomWritten.includes(spec.id)) continue;

      const addr =
        spec.where === 'eom'
          ? region.cell(spec.id, month.eomRow)
          : region.cell(spec.id, month.totalsRow);
      const src = sheetRef(campaign.sheetName, addr);
      const dbValue = spec.value(campaign.rollup);

      put(ws, a1(1, rr), campaign.sheetName, { align: ALIGN.left });
      put(ws, a1(2, rr), spec.label, { align: ALIGN.left });
      putFormula(ws, a1(3, rr), passBlank(src), dbValue, {
        font: FONTS.link,
        fmt: spec.fmt,
        align: ALIGN.right,
      });
      put(ws, a1(4, rr), dbValue, { fmt: spec.fmt, align: ALIGN.right });
      putFormula(
        ws,
        a1(5, rr),
        `IF(OR(${a1(3, rr)}="",${a1(4, rr)}=""),"",${a1(3, rr)}-${a1(4, rr)})`,
        dbValue === null ? null : 0,
        // replaceAll, not replace: `FMT.php` carries TWO ₱ sections (positive and
        // negative), and a difference column is a delta, never an amount.
        { fmt: spec.fmt.replaceAll('"₱"', ''), align: ALIGN.right },
      );
      // The CACHED status. It can only ever read OK, because the cached WORKBOOK
      // value IS the database figure (see the header note) — the comparison becomes
      // real the moment Excel recalculates. `differing` is carried so the EOQ tab's
      // one-line summary has the same shape either way, not because it varies here.
      const status = dbValue === null ? STATUS_OK_BLANK : STATUS_OK;
      ok += 1;
      putFormula(
        ws,
        a1(6, rr),
        `IF(AND(${a1(3, rr)}="",${a1(4, rr)}=""),"${STATUS_OK_BLANK}",IF(OR(${a1(3, rr)}="",${a1(4, rr)}=""),"${STATUS_CHECK}",IF(ABS(${a1(5, rr)})<=${a1(7, rr)},"${STATUS_OK}","${STATUS_CHECK}")))`,
        status,
        { font: FONTS.bold, align: ALIGN.center },
      );
      put(ws, a1(7, rr), spec.tolerance, {
        font: FONTS.muted,
        fmt: FMT.tol,
        align: ALIGN.right,
      });
      rr += 1;
    }
  }

  WIDTHS.forEach((w, i) => {
    ws.getColumn(i + 1).width = w;
  });
  // NO landscape/fit-to-page here, deliberately: the Checks tab is a reference list
  // read on screen, and Renzo's file leaves its page setup at the default.
  freeze(ws, 'A5');

  return { total: ok + differing, ok, differing };
}
