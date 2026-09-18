// ═════════════════════════════════════════════════════════════════════════════════
// month-sheet.ts — one tab per campaign: EOM rollup, day ledger, BLOCKS USED.
//
// LAYOUT (Renzo's round-2 edit, plan §10 — every explanatory prose line removed):
//   row 1  title
//   row 3  EOM ROLLUP labels        row 4  EOM ROLLUP formulas
//   row 7  the band strip (DAY · PRICE · FED · PRODUCED · WASTE · SHIFT · GRADES · WASTE STREAMS)
//   row 8  column headers           row 9  the first day
//   …      one row per CALENDAR day, rest days included and blank
//   +1     the totals row
//   +3     BLOCKS USED (title + a one-line note), its header, its rows, its footer
//
// VALUES IN, FORMULAS OUT. The only numbers typed into this sheet are the ones SQL
// published per day and per block: the day's fed ₱/kg, its grade kg, its eight
// waste streams, its shifts and downtime; the block's arrival kg, resiko kg and
// two prices. EVERYTHING ELSE IS A FORMULA — so a reader who corrects one waste
// cell watches the day total, the campaign total, the EOM rollup, the EOQ row and
// the Checks tab all move together, which is the whole reason the report is a
// spreadsheet and not a PDF.
//
// TWO COLUMNS ARE LINKS OUT OF THIS SHEET, and both are deliberate:
//   · `TTL FED kg` → the RC Movement row total for that day.
//   · `FED WT kg`  → the RC Movement column total for that block.
// The ledger therefore cannot disagree with the matrix about a kilogram.
//
// A PRICE-DENIED BUILD SIMPLY HAS FEWER COLUMNS. `FED PRICE ₱/kg`, the four ₱ cells
// of the rollup and the three ₱ columns of BLOCKS USED are NOT WRITTEN — not
// blanked, not hidden (a hidden column is one click from visible). Every address
// is resolved through a `Layout`, so the letters move and no formula notices.
// ═════════════════════════════════════════════════════════════════════════════════

import type ExcelJS from 'exceljs';

import {
  Layout,
  a1,
  colLetter,
  divBlank,
  iferrorBlank,
  sheetRef,
  sum,
  type LayoutColumn,
} from './a1';
import { WASTE_STREAMS } from '../types';
import {
  ALIGN,
  BORDER_BOX,
  BORDER_TOP,
  FILLS,
  FMT,
  FONTS,
  excelDate,
  freeze,
  landscapeFitWidth,
  put,
  putFormula,
  type FillName,
} from './styles';
import type { OpsExcelCampaign, OpsExcelInput } from './workbook';
import { RC_SHEET_NAME, type RcTableLayout } from './rc-movement-sheet';

interface MonthColumn extends LayoutColumn {
  fill: FillName;
  /** ₱-bearing: omitted entirely from a price-denied build. */
  php?: boolean;
  /** Set on a grade / stream / block column. */
  dataKey?: string;
}

/** Everything the EOQ and Checks tabs need in order to point at this sheet. */
export interface MonthSheetLayout {
  campaignKey: string;
  sheetName: string;
  /** Row 3/4 — the EOM rollup, starting at column B. */
  eom: Layout<MonthColumn>;
  eomRow: number;
  /**
   * The rollup ids that actually got a FORMULA on row 4. A campaign with no block
   * rows has no block-derived cells, so a consumer (the EOQ row, a Checks row) must
   * not point at one — an empty cell reads as a disagreement that is not there.
   */
  eomWritten: string[];
  /** Row 8 — the day ledger, starting at column A. */
  ledger: Layout<MonthColumn>;
  firstDayRow: number;
  lastDayRow: number;
  totalsRow: number;
  /** The BLOCKS USED table, starting at column A. */
  blocks: Layout<MonthColumn>;
  blocksFirstRow: number;
  blocksLastRow: number;
  blocksTotalRow: number;
}

// ── the EOM rollup / EOQ metric set ───────────────────────────────────────────
// ONE list, used by BOTH this sheet's row 4 and the EOQ Summary's columns, so a
// campaign row on the EOQ tab always lands on the metric it names. It starts at
// column B on both sheets (A is the label), which is what lets the EOQ row be a
// plain `='JULY 2026'!<same letter>4`.
export const EOM_METRICS: readonly MonthColumn[] = [
  { id: 'rcFedT', label: 'RC FED (t)', fill: 'fed' },
  { id: 'producedT', label: 'PRODUCED (t)', fill: 'prod' },
  { id: 'yield', label: 'YIELD', fill: 'prod' },
  { id: 'loss', label: 'LOSS', fill: 'loss' },
  { id: 'wasteKg', label: 'WASTE (kg)', fill: 'waste' },
  { id: 'wastePct', label: 'WASTE %', fill: 'waste' },
  { id: 'fedPrice', label: 'FED PRICE (₱/kg)', fill: 'price', php: true },
  { id: 'actualFedPrice', label: 'ACTUAL FED PRICE (₱/kg)', fill: 'price', php: true },
  { id: 'resikoCost', label: 'RESIKO COST (₱/kg)', fill: 'price', php: true },
  { id: 'resikoLoss', label: 'RESIKO LOSS', fill: 'loss' },
  { id: 'pcCost', label: 'PC COST (₱/kg)', fill: 'price', php: true },
  { id: 'truePcCost', label: 'TRUE PC COST (₱/kg)', fill: 'price', php: true },
  { id: 'inclKg', label: 'fed kg in price set', fill: 'day' },
];

export const EOM_FORMATS: Record<string, string> = {
  rcFedT: FMT.tons1,
  producedT: FMT.tons1,
  yield: FMT.pct,
  loss: FMT.pct,
  wasteKg: FMT.kg1,
  wastePct: FMT.pct,
  fedPrice: FMT.php,
  actualFedPrice: FMT.php,
  resikoCost: FMT.php,
  resikoLoss: FMT.pct,
  pcCost: FMT.php,
  truePcCost: FMT.php,
  inclKg: FMT.kg,
};

/** `fed kg in price set` is context, not a headline — it is the one muted column. */
export const EOM_MUTED_ID = 'inclKg';

export function eomLayout(canViewPrices: boolean): Layout<MonthColumn> {
  return new Layout<MonthColumn>(
    EOM_METRICS.filter((m) => canViewPrices || !m.php),
    2, // column B — column A carries the campaign label on both sheets
  );
}

// ── the BLOCKS USED columns ───────────────────────────────────────────────────
const BLOCK_COLUMNS: readonly MonthColumn[] = [
  { id: 'batch', label: 'BATCH', fill: 'day' },
  { id: 'loc', label: 'BLOCK LOC', fill: 'day' },
  { id: 'dateOpen', label: 'DATE OPEN', fill: 'day' },
  { id: 'dateClose', label: 'DATE CLOSE', fill: 'day' },
  { id: 'state', label: 'STATE', fill: 'day' },
  { id: 'fedWt', label: 'FED WT kg', fill: 'fed' },
  { id: 'arrvWt', label: 'ARRV WT kg', fill: 'fed' },
  { id: 'resikoKg', label: 'RESIKO kg', fill: 'loss' },
  { id: 'resikoPct', label: 'RESIKO LOSS %', fill: 'loss' },
  { id: 'blockPrice', label: 'BLOCK PRICE ₱/kg', fill: 'price', php: true },
  { id: 'actualPrice', label: 'ACTUAL PRICE ₱/kg', fill: 'price', php: true },
  { id: 'resikoPrice', label: 'RESIKO PRICE ₱/kg', fill: 'price', php: true },
  { id: 'inPriceSet', label: 'IN PRICE SET', fill: 'day' },
];

// ── the day ledger columns ────────────────────────────────────────────────────
const LEDGER_FIXED: readonly MonthColumn[] = [
  { id: 'date', label: 'DATE', fill: 'day' },
  { id: 'day', label: 'DAY', fill: 'day' },
  { id: 'fedPrice', label: 'FED PRICE ₱/kg', fill: 'price', php: true },
  { id: 'ttlFed', label: 'TTL FED kg', fill: 'fed' },
  { id: 'ttlProd', label: 'TTL PROD kg', fill: 'prod' },
  { id: 'wasteKg', label: 'WASTE kg', fill: 'waste' },
  { id: 'wastePct', label: 'WASTE %', fill: 'waste' },
  { id: 'shifts', label: 'SHIFTS', fill: 'shift' },
  { id: 'dtHrs', label: 'DT HRS', fill: 'shift' },
];

/**
 * COLUMN WIDTHS BY POSITION, exactly as Renzo's file carries them (plan §9 rule 3
 * put column A at 18.16). They are positional rather than semantic because that is
 * what the measured file says; anything past the list gets the trailing 10.
 */
const LEDGER_WIDTHS = [18.16, 14, 12, 12, 12, 12, 10, 12, 12, 12, 14, 14, 13, 10, 10, 10, 10, 10, 10, 10, 10, 10];
const LEDGER_WIDTH_TAIL = 10;

function ledgerLayout(input: OpsExcelInput): Layout<MonthColumn> {
  const fixed = LEDGER_FIXED.filter((c) => input.canViewPrices || !c.php);
  const grades: MonthColumn[] = input.grades.map((g) => ({
    id: `grade:${g}`,
    label: `${g} kg`,
    fill: 'prod' as const,
    dataKey: g,
  }));
  const streams: MonthColumn[] = WASTE_STREAMS.map((s) => ({
    id: `stream:${s.key}`,
    label: `${s.label} kg`,
    fill: 'waste' as const,
    dataKey: s.key,
  }));
  return new Layout<MonthColumn>([...fixed, ...grades, ...streams], 1);
}

export function writeMonthSheet(
  ws: ExcelJS.Worksheet,
  input: OpsExcelInput,
  campaign: OpsExcelCampaign,
  rc: RcTableLayout,
): MonthSheetLayout {
  const { canViewPrices } = input;
  const eom = eomLayout(canViewPrices);
  const ledger = ledgerLayout(input);
  const blocks = new Layout<MonthColumn>(
    BLOCK_COLUMNS.filter((c) => canViewPrices || !c.php),
    1,
  );
  const days = campaign.days;
  const rollup = campaign.rollup;
  const EOM_ROW = 4;

  put(ws, 'A1', `${campaign.sheetName} — PLANT OPERATIONS`, {
    font: FONTS.title,
    border: null,
  });

  // ── EOM rollup header (row 3) and its label cell (row 4) ────────────────────
  put(ws, 'A3', 'EOM ROLLUP', { font: FONTS.header, fill: FILLS.day, align: ALIGN.left });
  put(ws, a1(1, EOM_ROW), campaign.sheetName, { font: FONTS.bold, align: ALIGN.left });
  for (const m of eom.columns) {
    put(ws, eom.cell(m.id, 3), m.label, {
      font: m.id === EOM_MUTED_ID ? FONTS.muted : FONTS.header,
      fill: FILLS[m.fill],
      align: ALIGN.center,
    });
  }

  // ── the ledger's two header rows ────────────────────────────────────────────
  const bandRow = 7;
  const headerRow = 8;
  const bands: Array<{ label: string; from: string; to: string; fill: FillName }> = [
    { label: 'DAY', from: 'date', to: 'day', fill: 'day' },
    ...(canViewPrices
      ? [{ label: 'PRICE', from: 'fedPrice', to: 'fedPrice', fill: 'price' as FillName }]
      : []),
    { label: 'FED', from: 'ttlFed', to: 'ttlFed', fill: 'fed' },
    { label: 'PRODUCED', from: 'ttlProd', to: 'ttlProd', fill: 'prod' },
    { label: 'WASTE', from: 'wasteKg', to: 'wastePct', fill: 'waste' },
    { label: 'SHIFT', from: 'shifts', to: 'dtHrs', fill: 'shift' },
  ];
  if (input.grades.length > 0) {
    bands.push({
      label: 'GRADES',
      from: `grade:${input.grades[0]}`,
      to: `grade:${input.grades[input.grades.length - 1]}`,
      fill: 'prod',
    });
  }
  bands.push({
    label: 'WASTE STREAMS',
    from: `stream:${WASTE_STREAMS[0].key}`,
    to: `stream:${WASTE_STREAMS[WASTE_STREAMS.length - 1].key}`,
    fill: 'waste',
  });

  for (const band of bands) {
    const from = ledger.indexOf(band.from);
    const to = ledger.indexOf(band.to);
    // A one-column band is NOT merged: Excel drops a single-cell merge on save, so
    // writing one would be a difference against Renzo's file, not a fidelity.
    if (to > from) ws.mergeCells(bandRow, from, bandRow, to);
    put(ws, a1(from, bandRow), band.label, {
      font: FONTS.header,
      fill: FILLS[band.fill],
      align: ALIGN.center, // round-1 edit: the band strip is CENTRED
    });
    for (let k = from; k <= to; k += 1) {
      const cell = ws.getCell(a1(k, bandRow));
      cell.border = { ...BORDER_BOX };
      cell.fill = FILLS[band.fill];
    }
  }
  for (const c of ledger.columns) {
    put(ws, ledger.cell(c.id, headerRow), c.label, {
      font: FONTS.header,
      fill: FILLS[c.fill],
      align: ALIGN.center,
    });
  }

  // ── the day rows ────────────────────────────────────────────────────────────
  const firstDayRow = headerRow + 1;
  const gradeIds = input.grades.map((g) => `grade:${g}`);
  const streamIds = WASTE_STREAMS.map((s) => `stream:${s.key}`);
  const gradeSpan = (row: number) =>
    gradeIds.length > 0 ? ledger.rowSpan(gradeIds[0], gradeIds[gradeIds.length - 1], row) : null;
  const streamSpan = (row: number) =>
    ledger.rowSpan(streamIds[0], streamIds[streamIds.length - 1], row);

  days.forEach((day, n) => {
    const rr = firstDayRow + n;
    const fill = day.isRestDay ? FILLS.rest : null;

    put(ws, ledger.cell('date', rr), excelDate(day.date), {
      fmt: FMT.date,
      fill,
      align: ALIGN.left,
    });
    put(ws, ledger.cell('day', rr), day.weekday, { fill, align: ALIGN.left });
    if (canViewPrices) {
      put(ws, ledger.cell('fedPrice', rr), day.fedPhpKg, {
        fmt: FMT.php,
        fill,
        align: ALIGN.right,
      });
    }
    // TTL FED — a LINK to the RC Movement tab's row total for this very date.
    const rcRow = rc.rowOfDate.get(day.date);
    if (rcRow !== undefined) {
      putFormula(
        ws,
        ledger.cell('ttlFed', rr),
        sheetRef(RC_SHEET_NAME, a1(rc.layout.indexOf('totalFed'), rcRow)),
        day.fedKg,
        { font: FONTS.link, fmt: FMT.kg, fill, align: ALIGN.right },
      );
    } else {
      put(ws, ledger.cell('ttlFed', rr), day.fedKg, { fmt: FMT.kg, fill, align: ALIGN.right });
    }
    const gs = gradeSpan(rr);
    if (gs) {
      putFormula(ws, ledger.cell('ttlProd', rr), sum(gs), day.producedKg, {
        fmt: FMT.kg,
        fill,
        align: ALIGN.right,
      });
    } else {
      put(ws, ledger.cell('ttlProd', rr), day.producedKg, { fmt: FMT.kg, fill, align: ALIGN.right });
    }
    putFormula(ws, ledger.cell('wasteKg', rr), sum(streamSpan(rr)), day.totalWasteKg, {
      fmt: FMT.kg1,
      fill,
      align: ALIGN.right,
    });
    putFormula(
      ws,
      ledger.cell('wastePct', rr),
      `IF(${ledger.cell('ttlProd', rr)}>0,${ledger.cell('wasteKg', rr)}/${ledger.cell('ttlProd', rr)},"")`,
      day.wastePct,
      { fmt: FMT.pct, fill, align: ALIGN.right },
    );
    // `|| null` on shiftCount: a 0 here means "nobody on shift", which the format
    // prints as a blank rather than a zero — the NULL-is-never-0 rule, in reverse.
    put(ws, ledger.cell('shifts', rr), day.shiftCount || null, {
      fmt: FMT.kg,
      fill,
      align: ALIGN.right,
    });
    put(ws, ledger.cell('dtHrs', rr), day.downtimeHours, {
      fmt: FMT.hrs,
      fill,
      align: ALIGN.right,
    });
    for (const g of input.grades) {
      put(ws, ledger.cell(`grade:${g}`, rr), day.producedByGrade[g] ?? null, {
        fmt: FMT.kg,
        fill,
        align: ALIGN.right,
      });
    }
    for (const s of WASTE_STREAMS) {
      put(ws, ledger.cell(`stream:${s.key}`, rr), day.waste[s.key], {
        fmt: FMT.kg1,
        fill,
        align: ALIGN.right,
      });
    }
  });

  const lastDayRow = firstDayRow + days.length - 1;
  const totalsRow = lastDayRow + 1;

  // ── the totals row ──────────────────────────────────────────────────────────
  put(ws, ledger.cell('date', totalsRow), campaign.sheetName, {
    font: FONTS.bold,
    fill: FILLS.total,
    align: ALIGN.left,
    border: BORDER_TOP,
  });
  put(ws, ledger.cell('day', totalsRow), `${days.length} d`, {
    font: FONTS.muted,
    fill: FILLS.total,
    border: BORDER_TOP,
  });
  if (canViewPrices) {
    const priceSpan = ledger.span('fedPrice', firstDayRow, lastDayRow);
    const fedSpan = ledger.span('ttlFed', firstDayRow, lastDayRow);
    putFormula(
      ws,
      ledger.cell('fedPrice', totalsRow),
      divBlank(`SUMPRODUCT(${priceSpan},${fedSpan})`, `SUMIF(${priceSpan},">0",${fedSpan})`),
      rollup.fedPhpKg,
      {
        font: FONTS.bold,
        fmt: FMT.php,
        fill: FILLS.total,
        align: ALIGN.right,
        border: BORDER_TOP,
      },
    );
  }
  const totalSpec: Array<{ id: string; fmt: string; cached: number | null }> = [
    { id: 'ttlFed', fmt: FMT.kg, cached: rollup.fedKg },
    { id: 'ttlProd', fmt: FMT.kg, cached: rollup.producedKg },
    { id: 'wasteKg', fmt: FMT.kg1, cached: rollup.wasteKg },
    { id: 'shifts', fmt: FMT.kg, cached: rollup.shiftCount },
    { id: 'dtHrs', fmt: FMT.hrs, cached: rollup.downtimeHours },
    ...input.grades.map((g) => ({
      id: `grade:${g}`,
      fmt: FMT.kg,
      cached: campaign.gradeTotals[g] ?? null,
    })),
    ...WASTE_STREAMS.map((s) => ({
      id: `stream:${s.key}`,
      fmt: FMT.kg1,
      cached: rollup.waste[s.key],
    })),
  ];
  for (const t of totalSpec) {
    putFormula(
      ws,
      ledger.cell(t.id, totalsRow),
      sum(ledger.span(t.id, firstDayRow, lastDayRow)),
      t.cached,
      {
        font: FONTS.bold,
        fmt: t.fmt,
        fill: FILLS.total,
        align: ALIGN.right,
        border: BORDER_TOP,
      },
    );
  }
  putFormula(
    ws,
    ledger.cell('wastePct', totalsRow),
    `IF(${ledger.cell('ttlProd', totalsRow)}>0,${ledger.cell('wasteKg', totalsRow)}/${ledger.cell('ttlProd', totalsRow)},"")`,
    rollup.wasteLossPct,
    {
      font: FONTS.bold,
      fmt: FMT.pct,
      fill: FILLS.total,
      align: ALIGN.right,
      border: BORDER_TOP,
    },
  );

  // ── BLOCKS USED ─────────────────────────────────────────────────────────────
  const blockTitleRow = totalsRow + 3;
  const blockHeaderRow = blockTitleRow + 1;
  const blocksFirstRow = blockHeaderRow + 1;

  put(ws, a1(1, blockTitleRow), 'BLOCKS USED', { font: FONTS.bold, border: null });
  // The ONE note Renzo kept (round 2 removed every other line of prose) — it is
  // here because both of these are genuinely counter-intuitive.
  put(
    ws,
    a1(4, blockTitleRow),
    "FED WT is this campaign's kg (linked to the RC Movement tab), not the block's lifetime. RESIKO is only a loss once the block is CLOSED.",
    { font: FONTS.sub, border: null },
  );
  for (const c of blocks.columns) {
    put(ws, blocks.cell(c.id, blockHeaderRow), c.label, {
      font: FONTS.header,
      fill: FILLS[c.fill],
      align: ALIGN.center,
    });
  }

  campaign.blocks.forEach((b, n) => {
    const rr = blocksFirstRow + n;
    // A block OUTSIDE the price set is greyed — it is the reason a price is blank.
    const fill = b.inPriceSet ? null : FILLS.rest;
    put(ws, blocks.cell('batch', rr), b.batchCode, { fill, align: ALIGN.left });
    put(ws, blocks.cell('loc', rr), b.blockLoc || '—', { fill, align: ALIGN.left });
    put(ws, blocks.cell('dateOpen', rr), excelDate(b.firstFedDate), {
      fmt: FMT.date,
      fill,
      align: ALIGN.left,
    });
    put(ws, blocks.cell('dateClose', rr), excelDate(b.closeDate), {
      fmt: FMT.date,
      fill,
      align: ALIGN.left,
    });
    put(ws, blocks.cell('state', rr), b.isClosed ? 'CLOSED' : 'OPEN', { fill, align: ALIGN.left });
    // FED WT — a LINK to this block's column total on the RC Movement tab.
    const rcCol = rc.colOfBlock.get(b.batchId);
    if (rcCol) {
      putFormula(
        ws,
        blocks.cell('fedWt', rr),
        sheetRef(RC_SHEET_NAME, `${rcCol}${rc.totalRow}`),
        b.campaignFedKg,
        { font: FONTS.link, fmt: FMT.kg, fill, align: ALIGN.right },
      );
    } else {
      put(ws, blocks.cell('fedWt', rr), b.campaignFedKg, { fmt: FMT.kg, fill, align: ALIGN.right });
    }
    put(ws, blocks.cell('arrvWt', rr), b.deliveredKg, { fmt: FMT.kg, fill, align: ALIGN.right });
    // RESIKO IS ONLY A LOSS ONCE THE BLOCK IS CLOSED. An open block's remaining kg
    // is charcoal still in the pile — it gets the comment below instead of a figure.
    put(ws, blocks.cell('resikoKg', rr), b.isClosed ? b.resikoKg : null, {
      fmt: FMT.kg,
      fill,
      align: ALIGN.right,
      note: b.isClosed
        ? undefined
        : `Still open — ${fmtKg(b.balanceKg)} kg remains in the pile. Not a loss yet.`,
    });
    putFormula(
      ws,
      blocks.cell('resikoPct', rr),
      `IF(AND(${blocks.cell('state', rr)}="CLOSED",${blocks.cell('arrvWt', rr)}>0),${blocks.cell('resikoKg', rr)}/${blocks.cell('arrvWt', rr)},"")`,
      b.isClosed ? b.resikoPct : null,
      { fmt: FMT.pct, fill, align: ALIGN.right },
    );
    if (canViewPrices) {
      put(ws, blocks.cell('blockPrice', rr), b.deliveredPhpKg, {
        fmt: FMT.php,
        fill,
        align: ALIGN.right,
      });
      put(ws, blocks.cell('actualPrice', rr), b.actualFedPhpKg, {
        fmt: FMT.php,
        fill,
        align: ALIGN.right,
      });
      putFormula(
        ws,
        blocks.cell('resikoPrice', rr),
        `IF(${blocks.cell('actualPrice', rr)}="","",${blocks.cell('actualPrice', rr)}-${blocks.cell('blockPrice', rr)})`,
        b.actualFedPhpKg === null ? null : b.upliftPhpKg,
        { fmt: FMT.php, fill, align: ALIGN.right },
      );
    }
    put(ws, blocks.cell('inPriceSet', rr), b.inPriceSet ? 'Y' : 'N', {
      fill,
      align: ALIGN.center,
    });
  });

  const blocksLastRow = blocksFirstRow + campaign.blocks.length - 1;
  const blocksTotalRow = blocksLastRow + 1;
  const hasBlocks = campaign.blocks.length > 0;
  const stateSpan = blocks.span('state', blocksFirstRow, blocksLastRow);
  const fedSpan = blocks.span('fedWt', blocksFirstRow, blocksLastRow);
  const arrvSpan = blocks.span('arrvWt', blocksFirstRow, blocksLastRow);
  const resikoSpan = blocks.span('resikoKg', blocksFirstRow, blocksLastRow);
  const setSpan = blocks.span('inPriceSet', blocksFirstRow, blocksLastRow);
  /** `(IN PRICE SET = "Y")` — the 0/1 mask every weighted block figure multiplies by. */
  const inSet = `(${setSpan}="Y")`;

  put(ws, blocks.cell('batch', blocksTotalRow), `${campaign.blocks.length} blocks`, {
    font: FONTS.bold,
    fill: FILLS.total,
    align: ALIGN.left,
    border: BORDER_TOP,
  });
  if (hasBlocks) {
    putFormula(
      ws,
      blocks.cell('loc', blocksTotalRow),
      `COUNTIF(${stateSpan},"CLOSED")&" closed · "&COUNTIF(${stateSpan},"OPEN")&" open · "&COUNTIF(${setSpan},"Y")&" in price set"`,
      `${countBy(campaign, (b) => b.isClosed)} closed · ${countBy(campaign, (b) => !b.isClosed)} open · ${countBy(campaign, (b) => b.inPriceSet)} in price set`,
      { font: FONTS.muted, fill: FILLS.total, align: ALIGN.left, border: BORDER_TOP },
    );
    ws.mergeCells(
      blocksTotalRow,
      blocks.indexOf('loc'),
      blocksTotalRow,
      blocks.indexOf('state'),
    );
    for (const id of ['dateOpen', 'dateClose', 'state']) {
      const cell = ws.getCell(blocks.cell(id, blocksTotalRow));
      cell.border = { ...BORDER_TOP };
      cell.fill = FILLS.total;
    }

    const totalOpts = {
      font: FONTS.bold,
      fill: FILLS.total,
      align: ALIGN.right,
      border: BORDER_TOP,
    };
    putFormula(ws, blocks.cell('fedWt', blocksTotalRow), sum(fedSpan), rollup.fedKg, {
      ...totalOpts,
      fmt: FMT.kg,
    });
    putFormula(ws, blocks.cell('arrvWt', blocksTotalRow), sum(arrvSpan), rollup.blocksDeliveredKg, {
      ...totalOpts,
      fmt: FMT.kg,
    });
    putFormula(ws, blocks.cell('resikoKg', blocksTotalRow), sum(resikoSpan), rollup.blocksResikoKg, {
      ...totalOpts,
      fmt: FMT.kg,
    });
    putFormula(
      ws,
      blocks.cell('resikoPct', blocksTotalRow),
      // No CLOSED block yet → nothing to divide by. Blank, never #DIV/0!.
      divBlank(
        `SUMIF(${stateSpan},"CLOSED",${resikoSpan})`,
        `SUMIF(${stateSpan},"CLOSED",${arrvSpan})`,
      ),
      rollup.blocksClosedResikoLossPct,
      { ...totalOpts, fmt: FMT.pct },
    );
    if (canViewPrices) {
      const priceSpan = blocks.span('blockPrice', blocksFirstRow, blocksLastRow);
      const actualSpan = blocks.span('actualPrice', blocksFirstRow, blocksLastRow);
      putFormula(
        ws,
        blocks.cell('blockPrice', blocksTotalRow),
        divBlank(
          `SUMPRODUCT(${inSet}*${fedSpan}*${priceSpan})`,
          `SUMPRODUCT(${inSet}*${fedSpan})`,
        ),
        weightedOverPriceSet(campaign, (b) => b.deliveredPhpKg),
        {
          ...totalOpts,
          fmt: FMT.php,
          note: "Block price weighted by this campaign's fed kg, over the blocks inside the price set (closed and fully priced).",
        },
      );
      putFormula(
        ws,
        blocks.cell('actualPrice', blocksTotalRow),
        divBlank(
          `SUMPRODUCT(${inSet}*${fedSpan}*${actualSpan})`,
          `SUMPRODUCT(${inSet}*${fedSpan})`,
        ),
        rollup.campaignWeightedActualFedPhpKg,
        { ...totalOpts, fmt: FMT.php },
      );
      const val = `SUMPRODUCT(${inSet}*${priceSpan}*${arrvSpan})`;
      putFormula(
        ws,
        blocks.cell('resikoPrice', blocksTotalRow),
        iferrorBlank(
          `${val}/SUMPRODUCT(${inSet}*(${arrvSpan}-${resikoSpan}))-${val}/SUMPRODUCT(${inSet}*${arrvSpan})`,
        ),
        rollup.upliftPhpKg,
        {
          ...totalOpts,
          fmt: FMT.php,
          note: 'RESIKO COST on the WHOLE-BLOCK basis, as the app publishes it: pesos paid / lifetime fed kg, minus pesos paid / arrival kg, over the price set. Note the ACTUAL price beside it is campaign-attributed, so FED PRICE + RESIKO COST is close to, but not exactly, ACTUAL.',
        },
      );
    }
    put(ws, blocks.cell('inPriceSet', blocksTotalRow), null, {
      fill: FILLS.total,
      border: BORDER_TOP,
    });
  }

  // ── the EOM rollup formulas (row 4) ─────────────────────────────────────────
  // Every one points at a cell in this sheet, so the rollup is the ledger read a
  // second way rather than a second set of numbers.
  const L = (id: string, row: number) => ledger.cell(id, row);
  const B = (id: string, row: number) => blocks.cell(id, row);
  const E = (id: string) => eom.cell(id, EOM_ROW);
  const rollupSpec: Array<{ id: string; formula: string; cached: number | null }> = [
    { id: 'rcFedT', formula: `${L('ttlFed', totalsRow)}/1000`, cached: div(rollup.fedKg, 1000) },
    {
      id: 'producedT',
      formula: `${L('ttlProd', totalsRow)}/1000`,
      cached: div(rollup.producedKg, 1000),
    },
    {
      id: 'yield',
      formula: divBlank(L('ttlProd', totalsRow), L('ttlFed', totalsRow)),
      cached: rollup.yieldPct,
    },
    { id: 'loss', formula: iferrorBlank(`1-${E('yield')}`), cached: rollup.processLossPct },
    { id: 'wasteKg', formula: `${L('wasteKg', totalsRow)}`, cached: rollup.wasteKg },
    {
      id: 'wastePct',
      formula: divBlank(L('wasteKg', totalsRow), L('ttlProd', totalsRow)),
      cached: rollup.wasteLossPct,
    },
    ...(canViewPrices
      ? [{ id: 'fedPrice', formula: `${L('fedPrice', totalsRow)}`, cached: rollup.fedPhpKg }]
      : []),
    ...(canViewPrices && hasBlocks
      ? [
          {
            id: 'actualFedPrice',
            formula: `${B('actualPrice', blocksTotalRow)}`,
            cached: rollup.campaignWeightedActualFedPhpKg,
          },
          {
            id: 'resikoCost',
            formula: `${B('resikoPrice', blocksTotalRow)}`,
            cached: rollup.upliftPhpKg,
          },
        ]
      : []),
    ...(hasBlocks
      ? [
          {
            id: 'resikoLoss',
            formula: `${B('resikoPct', blocksTotalRow)}`,
            cached: rollup.blocksClosedResikoLossPct,
          },
        ]
      : []),
    ...(canViewPrices
      ? [
          {
            id: 'pcCost',
            formula: divBlank(E('fedPrice'), E('yield')),
            cached: rollup.phpPerProducedKgDelivered,
          },
        ]
      : []),
  ];
  if (canViewPrices && hasBlocks) {
    // TRUE PC COST is BLANK ON PURPOSE until every block this campaign fed is
    // CLOSED and fully priced — the same strict-NULL rule the database applies.
    rollupSpec.push({
      id: 'truePcCost',
      formula: `IF(COUNTIF(${setSpan},"N")=0,${divBlank(E('actualFedPrice'), E('yield'))},"")`,
      cached: rollup.phpPerProducedKgTrue,
    });
  }
  if (hasBlocks) {
    rollupSpec.push({
      id: 'inclKg',
      formula: `SUMPRODUCT(${inSet}*${fedSpan})`,
      cached: rollup.campaignFedKgIncluded,
    });
  }
  for (const spec of rollupSpec) {
    putFormula(ws, E(spec.id), spec.formula, spec.cached, {
      font: spec.id === EOM_MUTED_ID ? FONTS.muted : FONTS.bold,
      fmt: EOM_FORMATS[spec.id],
      align: ALIGN.right,
      note:
        spec.id === 'truePcCost'
          ? 'Blank on purpose until every block this campaign fed is CLOSED and fully priced.'
          : undefined,
    });
  }

  // ── sheet chrome ────────────────────────────────────────────────────────────
  // DATE and DAY stay put while the rest scrolls — frozen at the column AFTER DAY,
  // which is FED PRICE for an Owner and TTL FED for Production.
  freeze(ws, `${colLetter(ledger.indexOf('day') + 1)}${firstDayRow}`);
  ledger.columns.forEach((_, i) => {
    ws.getColumn(i + 1).width = LEDGER_WIDTHS[i] ?? LEDGER_WIDTH_TAIL;
  });
  ws.getRow(3).height = 30;
  ws.getRow(headerRow).height = 28;
  ws.getRow(blockHeaderRow).height = 28;
  landscapeFitWidth(ws);

  return {
    campaignKey: campaign.key,
    sheetName: campaign.sheetName,
    eom,
    eomRow: EOM_ROW,
    eomWritten: rollupSpec.map((s) => s.id),
    ledger,
    firstDayRow,
    lastDayRow,
    totalsRow,
    blocks,
    blocksFirstRow,
    blocksLastRow,
    blocksTotalRow,
  };
}

// ── small local helpers ───────────────────────────────────────────────────────
// None of these is a business definition; each is a CACHE of the formula written
// beside it, shown only until Excel recalculates.

function div(n: number | null, by: number): number | null {
  return n === null ? null : n / by;
}

function fmtKg(n: number | null): string {
  return n === null ? '—' : Math.round(n).toLocaleString('en-US');
}

function countBy(c: OpsExcelCampaign, pred: (b: OpsExcelCampaign['blocks'][number]) => boolean): number {
  return c.blocks.filter(pred).length;
}

/**
 * The cached mirror of `SUMPRODUCT(inSet*fed*price)/SUMPRODUCT(inSet*fed)`.
 *
 * This is the ONE footer cell with no published figure behind it (the database
 * publishes the campaign's ACTUAL price and its uplift, not its delivered price
 * restricted to the price set), so its cache evaluates the cell's own formula.
 * Nothing in the app reads it and no other cell is computed this way.
 */
function weightedOverPriceSet(
  campaign: OpsExcelCampaign,
  pick: (b: OpsExcelCampaign['blocks'][number]) => number | null,
): number | null {
  let num = 0;
  let den = 0;
  for (const b of campaign.blocks) {
    if (!b.inPriceSet) continue;
    const w = b.campaignFedKg;
    const v = pick(b);
    if (w === null || v === null) continue;
    num += w * v;
    den += w;
  }
  return den > 0 ? num / den : null;
}
