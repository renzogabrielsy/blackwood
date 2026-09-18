// ═════════════════════════════════════════════════════════════════════════════════
// eoq-sheet.ts — the first tab: one row per campaign, then the GROUP row.
//
// NOT ONE VALUE IS TYPED INTO A CAMPAIGN ROW. Every cell is `='JULY 2026'!C4` — a
// link to that month tab's EOM rollup, which is itself a formula over that tab's
// ledger. So the quarter is the months read a third way, and no figure in this
// workbook is written down twice.
//
// THAT IS WHY THE EOQ AND EOM COLUMN SETS ARE ONE LIST (`EOM_METRICS` in
// `month-sheet.ts`), both starting at column B: a campaign row can then be a plain
// same-letter reference. A price-denied build drops the same five ₱ metrics from
// both, so the letters still agree.
//
// THE GROUP ROW IS WEIGHTED, NEVER AVERAGED. kg and waste SUM; yield is
// `Σproduced/Σfed`; fed price is weighted by fed kg; the actual price, the resiko
// cost and the resiko loss are weighted by each campaign's FED KG INSIDE ITS PRICE
// SET (column N), because that is the population those three describe.
//
// AND THE GROUP PUBLISHES NO RESIKO KG. A block fed by two campaigns (78 of 523)
// would have its whole-life shrinkage counted once per campaign, so only the RATIO
// is shown — the same refusal `fn_ops_ledger_group_kpis` makes in SQL. The cell
// carries a comment saying so; it is not an oversight to be "fixed".
//
// Layout (round 2, plan §10 — the subtitle and the notes block were removed):
//   row 1 title · row 3 header · row 4… campaigns · GROUP · blank · CHECKS status
// ═════════════════════════════════════════════════════════════════════════════════

import type ExcelJS from 'exceljs';

import {
  a1,
  divBlank,
  iferrorBlank,
  passBlank,
  rowRange,
  sheetColRef,
  sheetRef,
  sum,
} from './a1';
import {
  ALIGN,
  BORDER_TOP,
  FILLS,
  FONTS,
  freeze,
  landscapeFitWidth,
  put,
  putFormula,
} from './styles';
import {
  EOM_FORMATS,
  EOM_MUTED_ID,
  eomLayout,
  type MonthSheetLayout,
} from './month-sheet';
import { CHECKS_SHEET_NAME, type ChecksSummary } from './checks-sheet';
import type { OpsExcelInput } from './workbook';

export const EOQ_SHEET_NAME = 'EOQ Summary';

/** Positional widths, as Renzo's file carries them. */
const WIDTHS = [22, 12, 13, 10, 10, 13, 10, 13, 15, 14, 12, 13, 14, 13];

export function writeEoqSheet(
  ws: ExcelJS.Worksheet,
  input: OpsExcelInput,
  months: ReadonlyMap<string, MonthSheetLayout>,
  checks: ChecksSummary,
): void {
  const eom = eomLayout(input.canViewPrices);
  const HEADER_ROW = 3;
  const FIRST_ROW = 4;

  put(ws, 'A1', `EOQ SUMMARY — ${input.groupLabel}`, { font: FONTS.title, border: null });

  put(ws, a1(1, HEADER_ROW), 'CAMPAIGN', {
    font: FONTS.header,
    fill: FILLS.day,
    align: ALIGN.center,
  });
  for (const m of eom.columns) {
    put(ws, eom.cell(m.id, HEADER_ROW), m.label, {
      font: m.id === EOM_MUTED_ID ? FONTS.muted : FONTS.header,
      fill: FILLS[m.fill],
      align: ALIGN.center,
    });
  }

  // ── one row per campaign, every cell a link ────────────────────────────────
  input.campaigns.forEach((campaign, n) => {
    const rr = FIRST_ROW + n;
    const month = months.get(campaign.key);
    put(ws, a1(1, rr), campaign.sheetName, { font: FONTS.bold, align: ALIGN.left });
    if (!month) return;
    for (const m of eom.columns) {
      if (!month.eomWritten.includes(m.id)) continue;
      const src = sheetRef(campaign.sheetName, month.eom.cell(m.id, month.eomRow));
      // TRUE PC COST is the one metric that is BLANK ON PURPOSE, so the link must
      // carry the blank across rather than turning it into a 0.
      const formula = m.id === 'truePcCost' ? passBlank(src) : src;
      putFormula(ws, eom.cell(m.id, rr), formula, eomCached(campaign.rollup, m.id), {
        font: m.id === EOM_MUTED_ID ? FONTS.muted : FONTS.link,
        fmt: EOM_FORMATS[m.id],
        align: ALIGN.right,
      });
    }
  });

  const lastCampaignRow = FIRST_ROW + input.campaigns.length - 1;
  const groupRow = lastCampaignRow + 1;
  const group = input.group;

  // ── the GROUP row ─────────────────────────────────────────────────────────
  put(ws, a1(1, groupRow), `GROUP · ${input.groupLabel}`, {
    font: FONTS.bold,
    fill: FILLS.total,
    align: ALIGN.left,
    border: BORDER_TOP,
  });

  if (group && input.campaigns.length > 0) {
    const span = (id: string) => eom.span(id, FIRST_ROW, lastCampaignRow);
    const at = (id: string) => eom.cell(id, groupRow);
    const fedSpan = span('rcFedT');
    const inclSpan = eom.has('inclKg') ? span('inclKg') : null;
    /** Weighted by each campaign's fed kg INSIDE its price set — column N. */
    // A GROUP FIGURE BLANKS RATHER THAN AVERAGING A PARTIAL POPULATION. `SUMPRODUCT`
    // over a range holding one campaign's deliberate `""` is `#VALUE!`, and an empty
    // price set divides by 0 — both mean "this quarter cannot state this figure", so
    // both read blank. See `divBlank`'s note.
    const byPriceSet = (id: string) =>
      inclSpan ? divBlank(`SUMPRODUCT(${span(id)},${inclSpan})`, `SUM(${inclSpan})`) : sum(span(id));

    const spec: Array<{ id: string; formula: string; cached: number | null; note?: string }> = [
      { id: 'rcFedT', formula: sum(fedSpan), cached: div(group.fedKg, 1000) },
      { id: 'producedT', formula: sum(span('producedT')), cached: div(group.producedKg, 1000) },
      { id: 'yield', formula: divBlank(at('producedT'), at('rcFedT')), cached: group.yieldPct },
      { id: 'loss', formula: iferrorBlank(`1-${at('yield')}`), cached: group.processLossPct },
      { id: 'wasteKg', formula: sum(span('wasteKg')), cached: group.wasteKg },
      {
        id: 'wastePct',
        formula: divBlank(at('wasteKg'), `(${at('producedT')}*1000)`),
        cached: group.wasteLossPct,
      },
    ];
    if (input.canViewPrices) {
      spec.push(
        {
          id: 'fedPrice',
          formula: divBlank(`SUMPRODUCT(${span('fedPrice')},${fedSpan})`, `SUM(${fedSpan})`),
          cached: group.fedPhpKg,
        },
        { id: 'actualFedPrice', formula: byPriceSet('actualFedPrice'), cached: group.actualFedPhpKg },
        { id: 'resikoCost', formula: byPriceSet('resikoCost'), cached: group.upliftPhpKg },
      );
    }
    spec.push({
      id: 'resikoLoss',
      formula: byPriceSet('resikoLoss'),
      cached: group.blockResikoLossPct,
      note: 'The group shows the resiko RATIO only. A resiko kg total is deliberately not shown: a block fed by two campaigns would be counted twice.',
    });
    if (input.canViewPrices) {
      spec.push(
        {
          id: 'pcCost',
          formula: divBlank(at('fedPrice'), at('yield')),
          cached: group.phpPerProducedKgDelivered,
        },
        {
          id: 'truePcCost',
          formula: `IF(COUNTBLANK(${span('truePcCost')})=0,${divBlank(at('actualFedPrice'), at('yield'))},"")`,
          cached: group.phpPerProducedKgTrue,
          note: 'Blank until EVERY campaign in the group is fully covered (all blocks closed and priced).',
        },
      );
    }
    if (inclSpan) {
      spec.push({ id: 'inclKg', formula: sum(inclSpan), cached: group.campaignFedKgIncluded });
    }

    for (const s of spec) {
      putFormula(ws, at(s.id), s.formula, s.cached, {
        font: s.id === EOM_MUTED_ID ? FONTS.muted : FONTS.bold,
        fmt: EOM_FORMATS[s.id],
        fill: FILLS.total,
        align: ALIGN.right,
        border: BORDER_TOP,
        note: s.note,
      });
    }
    // Any metric the spec above did not fill still needs the totals-row chrome, so
    // the band reads as one row rather than stopping where the numbers do.
    const filled = new Set(spec.map((s) => s.id));
    for (const m of eom.columns) {
      if (filled.has(m.id)) continue;
      put(ws, at(m.id), null, { fill: FILLS.total, border: BORDER_TOP });
    }
  } else {
    for (const m of eom.columns) {
      put(ws, eom.cell(m.id, groupRow), null, { fill: FILLS.total, border: BORDER_TOP });
    }
  }

  // ── the one-line CHECKS status (round 2 keeps it VISIBLE) ──────────────────
  const statusRow = groupRow + 2;
  const statusCol = sheetColRef(CHECKS_SHEET_NAME, 'F');
  put(ws, a1(1, statusRow), 'CHECKS', {
    font: FONTS.header,
    fill: FILLS.day,
    align: ALIGN.left,
  });
  putFormula(
    ws,
    a1(2, statusRow),
    `IF(COUNTIF(${statusCol},"CHECK")=0,"All "&COUNTIF(${statusCol},"OK*")&" checks agree with the database",COUNTIF(${statusCol},"CHECK")&" of "&(COUNTIF(${statusCol},"OK*")+COUNTIF(${statusCol},"CHECK"))&" checks differ — see the Checks tab")`,
    checks.differing === 0
      ? `All ${checks.ok} checks agree with the database`
      : `${checks.differing} of ${checks.total} checks differ — see the Checks tab`,
    { font: FONTS.bold, align: ALIGN.left },
  );
  // Merge across the readable width of the sheet, never past its last column.
  const mergeTo = Math.min(8, eom.lastIndex);
  if (mergeTo > 2) ws.mergeCells(rowRange(2, mergeTo, statusRow));

  freeze(ws, `B${FIRST_ROW}`);
  ws.getRow(HEADER_ROW).height = 32;
  WIDTHS.forEach((w, i) => {
    if (i + 1 <= eom.lastIndex) ws.getColumn(i + 1).width = w;
  });
  landscapeFitWidth(ws);
}

function div(n: number | null, by: number): number | null {
  return n === null ? null : n / by;
}

/**
 * The cached value of a campaign's EOQ cell — the SAME figure its month tab caches,
 * because both are the payload's published number for that metric. Reading it twice
 * from one place is what stops the two tabs disagreeing in the cached view.
 */
function eomCached(
  r: OpsExcelInput['campaigns'][number]['rollup'],
  id: string,
): number | null {
  switch (id) {
    case 'rcFedT':
      return div(r.fedKg, 1000);
    case 'producedT':
      return div(r.producedKg, 1000);
    case 'yield':
      return r.yieldPct;
    case 'loss':
      return r.processLossPct;
    case 'wasteKg':
      return r.wasteKg;
    case 'wastePct':
      return r.wasteLossPct;
    case 'fedPrice':
      return r.fedPhpKg;
    case 'actualFedPrice':
      return r.campaignWeightedActualFedPhpKg;
    case 'resikoCost':
      return r.upliftPhpKg;
    case 'resikoLoss':
      return r.blocksClosedResikoLossPct;
    case 'pcCost':
      return r.phpPerProducedKgDelivered;
    case 'truePcCost':
      return r.phpPerProducedKgTrue;
    case 'inclKg':
      return r.campaignFedKgIncluded;
    default:
      return null;
  }
}
