// ═════════════════════════════════════════════════════════════════════════════════
// rc-movement-sheet.ts — ONE tab, the campaigns' day × block matrices stacked.
//
// Renzo asked for "an RC Movement tab that features 3 separate RC Movement tables
// inside ONE tab". Stacked vertically, six rows apart, because each campaign has a
// different block column set and a sheet can freeze panes only ONCE — so the five
// spine columns (#, DATE, DAY, FED ₱/kg, TOTAL FED kg) are frozen for all three.
//
// THIS TAB IS THE WORKBOOK'S SPINE, not a copy of the month tabs. Each month tab's
// `TTL FED kg` column is a LINK to this tab's row total, and each BLOCKS USED row's
// `FED WT kg` is a LINK to this tab's column total — so the ledger and the matrix
// are structurally incapable of disagreeing. That is why this sheet is written
// FIRST and hands its coordinates back.
//
// THE ROWS ARE THE LEDGER'S DAYS, NOT THE FED DAYS. Every calendar day of the
// campaign's span is a row, rest days included and blank, because the month tab
// links to `E<row of that date>` for EVERY one of its days. (It is also why this
// sheet is built from the ops-ledger payload rather than from
// `fetchRcMovementMatrix`, whose rows are the FED-ONLY span — see `workbook.ts`.)
//
// The three footer rows under each table (₱/KG · LOSS % · ACTUAL ₱/kg) are written
// LATER, by `writeRcMovementFooters`, because they link INTO the month tabs'
// BLOCKS USED tables, which do not exist yet when the body is laid out.
// ═════════════════════════════════════════════════════════════════════════════════

import type ExcelJS from 'exceljs';

import {
  Layout,
  a1,
  colLetter,
  colRange,
  divBlank,
  passBlank,
  sheetRef,
  sum,
  type LayoutColumn,
} from './a1';
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
} from './styles';
import type { OpsExcelCampaign, OpsExcelInput } from './workbook';
import type { MonthSheetLayout } from './month-sheet';

export const RC_SHEET_NAME = 'RC Movement';

interface RcColumn extends LayoutColumn {
  width: number;
  fill: keyof typeof FILLS;
  /** Set on a block column: the block it addresses. */
  batchId?: string;
}

/** Where one campaign's table sits, so the month tab can point at it. */
export interface RcTableLayout {
  campaignKey: string;
  layout: Layout<RcColumn>;
  /** `yyyy-MM-dd` → the row that day occupies. */
  rowOfDate: Map<string, number>;
  /** batchId → that block's column letter. */
  colOfBlock: Map<string, string>;
  firstDayRow: number;
  lastDayRow: number;
  totalRow: number;
  /** The blocks, in the order their columns appear — the BLOCKS USED order too. */
  blockOrder: string[];
  hasBlocks: boolean;
}

const SPINE: readonly RcColumn[] = [
  { id: 'idx', label: '#', width: 4, fill: 'day' },
  { id: 'date', label: 'DATE', width: 22, fill: 'day' },
  { id: 'day', label: 'DAY', width: 6, fill: 'day' },
  { id: 'fedPrice', label: 'FED ₱/kg', width: 11, fill: 'price' },
  { id: 'totalFed', label: 'TOTAL FED kg', width: 13, fill: 'fed' },
];

function buildLayout(campaign: OpsExcelCampaign, canViewPrices: boolean): Layout<RcColumn> {
  const spine = SPINE.filter((c) => canViewPrices || c.id !== 'fedPrice');
  const blocks: RcColumn[] = campaign.blocks.map((b) => ({
    id: `block:${b.batchId}`,
    label: b.batchCode,
    width: 15,
    fill: 'fed' as const,
    batchId: b.batchId,
  }));
  return new Layout<RcColumn>([...spine, ...blocks], 1);
}

export function writeRcMovementSheet(
  ws: ExcelJS.Worksheet,
  input: OpsExcelInput,
): RcTableLayout[] {
  const { canViewPrices } = input;

  put(ws, 'A1', `RC MOVEMENT — ${input.groupLabel}`, { font: FONTS.title, border: null });

  const tables: RcTableLayout[] = [];
  let r = 3;

  for (const campaign of input.campaigns) {
    const layout = buildLayout(campaign, canViewPrices);
    const days = campaign.days;
    const blocks = campaign.blocks;
    const hasBlocks = blocks.length > 0;

    put(
      ws,
      a1(1, r),
      `${campaign.sheetName} · ${days[0]?.date ?? '—'} → ${days[days.length - 1]?.date ?? '—'} · ${days.length} days · ${blocks.length} blocks`,
      { font: FONTS.bold, border: null },
    );

    const h1 = r + 1;
    const h2 = r + 2;

    // The spine headers span both header rows; the block headers are batch over block loc.
    for (const col of layout.columns) {
      if (col.batchId) continue;
      const idx = layout.indexOf(col.id);
      ws.mergeCells(h1, idx, h2, idx);
      put(ws, a1(idx, h1), col.label, {
        font: FONTS.header,
        fill: FILLS[col.fill],
        align: ALIGN.center,
      });
      ws.getCell(a1(idx, h2)).border = { ...BORDER_BOX };
    }
    for (const b of blocks) {
      const col = layout.letter(`block:${b.batchId}`);
      put(ws, `${col}${h1}`, b.batchCode, {
        font: FONTS.header,
        fill: FILLS.fed,
        align: ALIGN.center,
      });
      // The one grey label Renzo kept — a sub-label, not a value.
      put(ws, `${col}${h2}`, b.blockLoc || '—', {
        font: FONTS.subRc,
        fill: FILLS.fed,
        align: ALIGN.center,
      });
    }

    const firstDayRow = h2 + 1;
    const lastDayRow = h2 + days.length;
    const totalRow = lastDayRow + 1;
    const rowOfDate = new Map<string, number>();
    const firstBlockCol = hasBlocks ? colLetter(layout.indexOf(`block:${blocks[0].batchId}`)) : null;
    const lastCol = layout.lastLetter;

    days.forEach((day, n) => {
      const rr = firstDayRow + n;
      rowOfDate.set(day.date, rr);
      const fill = day.isRestDay ? FILLS.rest : null;

      put(ws, layout.cell('idx', rr), n + 1, {
        font: FONTS.muted,
        fill,
        align: ALIGN.right,
      });
      put(ws, layout.cell('date', rr), excelDate(day.date), {
        fmt: FMT.date,
        fill,
        align: ALIGN.left,
      });
      put(ws, layout.cell('day', rr), day.weekday, { fill, align: ALIGN.left });
      if (canViewPrices) {
        put(ws, layout.cell('fedPrice', rr), day.fedPhpKg, {
          fmt: FMT.php,
          fill,
          align: ALIGN.right,
        });
      }
      // THE ROW TOTAL IS A FORMULA over the block cells beside it — so a reader who
      // edits one cell sees the day, the month tab and the EOQ row all move.
      if (firstBlockCol) {
        putFormula(
          ws,
          layout.cell('totalFed', rr),
          sum(`${firstBlockCol}${rr}:${lastCol}${rr}`),
          day.fedKg,
          { font: FONTS.bold, fmt: FMT.kg, fill, align: ALIGN.right },
        );
      } else {
        // A campaign that produced but never fed has no block columns at all, so
        // there is no range to sum. Write the payload's own figure (normally blank).
        put(ws, layout.cell('totalFed', rr), day.fedKg, {
          font: FONTS.bold,
          fmt: FMT.kg,
          fill,
          align: ALIGN.right,
        });
      }
      for (const b of blocks) {
        put(ws, layout.cell(`block:${b.batchId}`, rr), campaign.cells.get(cellKey(day.date, b.batchId)) ?? null, {
          fmt: FMT.kg,
          fill,
          align: ALIGN.right,
        });
      }
    });

    // ── totals row ────────────────────────────────────────────────────────────
    for (const col of layout.columns) {
      if (col.batchId || col.id === 'totalFed' || col.id === 'fedPrice') continue;
      if (col.id === 'date') continue;
      put(ws, layout.cell(col.id, totalRow), null, { fill: FILLS.total, border: BORDER_TOP });
    }
    put(ws, layout.cell('date', totalRow), 'FED kg (this campaign)', {
      font: FONTS.bold,
      fill: FILLS.total,
      border: BORDER_TOP,
    });
    if (canViewPrices) {
      const priceCol = layout.letter('fedPrice');
      const fedCol = layout.letter('totalFed');
      const priceSpan = colRange(priceCol, firstDayRow, lastDayRow);
      const fedSpan = colRange(fedCol, firstDayRow, lastDayRow);
      // Weighted by the kg fed on each day, over the days that HAVE a price — the
      // shape `view_rc_movement_campaign_price` publishes, said in Excel.
      putFormula(
        ws,
        layout.cell('fedPrice', totalRow),
        divBlank(`SUMPRODUCT(${priceSpan},${fedSpan})`, `SUMIF(${priceSpan},">0",${fedSpan})`),
        campaign.rollup.fedPhpKg,
        { font: FONTS.bold, fmt: FMT.php, fill: FILLS.total, align: ALIGN.right, border: BORDER_TOP },
      );
    }
    putFormula(
      ws,
      layout.cell('totalFed', totalRow),
      sum(colRange(layout.letter('totalFed'), firstDayRow, lastDayRow)),
      campaign.rollup.fedKg,
      { font: FONTS.bold, fmt: FMT.kg, fill: FILLS.total, align: ALIGN.right, border: BORDER_TOP },
    );
    for (const b of blocks) {
      const col = layout.letter(`block:${b.batchId}`);
      putFormula(
        ws,
        `${col}${totalRow}`,
        sum(colRange(col, firstDayRow, lastDayRow)),
        b.campaignFedKg,
        { font: FONTS.bold, fmt: FMT.kg, fill: FILLS.total, align: ALIGN.right, border: BORDER_TOP },
      );
    }

    tables.push({
      campaignKey: campaign.key,
      layout,
      rowOfDate,
      colOfBlock: new Map(blocks.map((b) => [b.batchId, layout.letter(`block:${b.batchId}`)])),
      firstDayRow,
      lastDayRow,
      totalRow,
      blockOrder: blocks.map((b) => b.batchId),
      hasBlocks,
    });

    // Three footer rows (written later) plus two blank rows before the next table.
    r = totalRow + 6;
  }

  // Frozen at the first BLOCK column, below both header rows — so the spine and the
  // campaign header stay put while the blocks scroll.
  const first = tables[0];
  const freezeCol = first
    ? colLetter(first.layout.indexOf(first.hasBlocks ? `block:${first.blockOrder[0]}` : 'totalFed'))
    : 'F';
  freeze(ws, `${freezeCol}3`);

  // Widths come from the FIRST table's layout; every table shares the spine, and a
  // block column is a block column whichever table it is in.
  const widest = tables.reduce<Layout<RcColumn> | null>(
    (acc, t) => (acc && acc.columns.length >= t.layout.columns.length ? acc : t.layout),
    null,
  );
  if (widest) {
    widest.columns.forEach((c, i) => {
      ws.getColumn(i + 1).width = c.width;
    });
  }
  landscapeFitWidth(ws);

  return tables;
}

/**
 * The three linked footer rows under each table — written after the month tabs
 * exist, because every cell points INTO a BLOCKS USED row.
 *
 * THESE STAY GREEN. Renzo's round-1 edit turned every other coloured font black;
 * he left these, and round 2 did not revisit them (plan §9–10). The open question
 * "should they go black too?" is his to answer — until he does, this is the format.
 *
 * A price-denied build writes only `LOSS %`: the other two rows are ₱ and are not
 * written at all, so the table simply has one footer row.
 */
export function writeRcMovementFooters(
  ws: ExcelJS.Worksheet,
  input: OpsExcelInput,
  tables: readonly RcTableLayout[],
  months: ReadonlyMap<string, MonthSheetLayout>,
): void {
  type FooterSpec = { label: string; blockCol: string; fmt: string; php: boolean };
  const SPECS: readonly FooterSpec[] = [
    { label: '₱/KG (block price)', blockCol: 'blockPrice', fmt: FMT.php, php: true },
    { label: 'LOSS % (resiko)', blockCol: 'resikoPct', fmt: FMT.pct, php: false },
    { label: 'ACTUAL ₱/kg', blockCol: 'actualPrice', fmt: FMT.php, php: true },
  ];
  const specs = SPECS.filter((s) => input.canViewPrices || !s.php);

  for (const table of tables) {
    const campaign = input.campaigns.find((c) => c.key === table.campaignKey);
    const month = months.get(table.campaignKey);
    if (!campaign || !month) continue;

    specs.forEach((spec, k) => {
      const rr = table.totalRow + 1 + k;
      for (const col of table.layout.columns) {
        if (col.batchId) continue;
        put(ws, table.layout.cell(col.id, rr), null, { fill: FILLS.total });
      }
      put(ws, table.layout.cell('date', rr), spec.label, {
        font: FONTS.header,
        fill: FILLS.total,
      });
      campaign.blocks.forEach((b, n) => {
        const src = sheetRef(
          campaign.sheetName,
          month.blocks.cell(spec.blockCol, month.blocksFirstRow + n),
        );
        // THE CACHE MUST BE WHAT THE LINKED CELL ITSELF SHOWS. The month tab
        // writes RESIKO LOSS % as a BLANK on an OPEN block (resiko is only a loss
        // once the block closes), so caching the block's own ratio here would make
        // the footer disagree with the very cell it points at.
        const cached =
          spec.blockCol === 'blockPrice'
            ? b.deliveredPhpKg
            : spec.blockCol === 'actualPrice'
              ? b.actualFedPhpKg
              : b.isClosed
                ? b.resikoPct
                : null;
        putFormula(ws, `${table.colOfBlock.get(b.batchId)}${rr}`, passBlank(src), cached, {
          font: FONTS.linkRc,
          fmt: spec.fmt,
          fill: FILLS.total,
          align: ALIGN.right,
        });
      });
    });
  }
}

/** The key under which a (day, block) feed is filed. */
export function cellKey(date: string, batchId: string): string {
  return `${date}|${batchId}`;
}
