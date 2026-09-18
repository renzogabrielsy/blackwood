// ═════════════════════════════════════════════════════════════════════════════════
// styles.ts — the workbook's look, and the one `put()` that writes a cell.
//
// THIS IS A PORT OF A MEASURED FORMAT, NOT A DESIGN. Renzo hand-edited the mock-up
// twice (`.agents/plans/ops-ledger-excel-plan.md` §9–10); the Python generator
// `.agents/plans/ops-ledger-excel-mockup/build.py` reproduces his second file with
// **0 differing cells on all six tabs**, and every font, fill, border, number
// format and width below is lifted from it verbatim. Changing one is changing HIS
// format — do it because he asked, and re-run the diff.
//
// The two rules his edits amount to:
//   1. ALL TEXT IS BLACK on the month tabs and the RC Movement day rows. No
//      blue-input / green-link / grey-muted colour coding. Fills and borders stay.
//      The exceptions he kept: RC Movement's grey block-location sub-labels and
//      its GREEN linked footer rows, and the Checks tab.
//   2. NO EXPLANATORY PROSE. Subtitles and the "how to read this file" block are
//      gone; the one note beside BLOCKS USED and the cell comments stay.
//
// DATES ARE EXCEL'S BUILT-IN SHORT DATE (numFmtId 14), written as the pattern
// `mm-dd-yy` because that is the string both openpyxl and ExcelJS map ONTO the
// built-in id. It is not a literal format: Excel renders it in the reader's own
// locale, which is what makes his file read `6/30/2026` on a Mac. Never replace it
// with a spelled-out pattern — that would freeze the date into one locale.
// ═════════════════════════════════════════════════════════════════════════════════

import type ExcelJS from 'exceljs';

export const FONT_NAME = 'Arial';

/** `FF` + RRGGBB — ExcelJS wants a full ARGB, openpyxl took RRGGBB. */
const argb = (rgb: string) => `FF${rgb}`;

export const FONTS = {
  /** Body text, and every input value. */
  base: { name: FONT_NAME, size: 10 },
  /** A link to another tab. BLACK on the month tabs — Renzo's round-1 edit. */
  link: { name: FONT_NAME, size: 10 },
  /** The one place a link stays GREEN: RC Movement's three footer rows. */
  linkRc: { name: FONT_NAME, size: 10, color: { argb: argb('008000') } },
  bold: { name: FONT_NAME, size: 10, bold: true },
  title: { name: FONT_NAME, size: 14, bold: true },
  /** The one-line note beside BLOCKS USED, and the Checks tab's second line. */
  sub: { name: FONT_NAME, size: 9 },
  /** RC Movement's grey block-location sub-labels — kept grey on purpose. */
  subRc: { name: FONT_NAME, size: 9, color: { argb: argb('666666') } },
  header: { name: FONT_NAME, size: 9, bold: true },
  muted: { name: FONT_NAME, size: 9 },
} satisfies Record<string, Partial<ExcelJS.Font>>;

/** The page's semantic palette, as light header fills. */
const FILL_RGB = {
  day: 'EDEDED',
  price: 'E4DFEC',
  fed: 'DDEBF7',
  prod: 'E2EFDA',
  waste: 'FCE4E4',
  loss: 'FFF2CC',
  shift: 'EDEDED',
  total: 'F2F2F2',
  rest: 'F7F7F7',
  ok: 'E2EFDA',
  bad: 'F8CBAD',
} as const;

export type FillName = keyof typeof FILL_RGB;

export const FILLS: Record<FillName, ExcelJS.FillPattern> = Object.fromEntries(
  Object.entries(FILL_RGB).map(([k, v]) => [
    k,
    { type: 'pattern', pattern: 'solid', fgColor: { argb: argb(v) } } as ExcelJS.FillPattern,
  ]),
) as Record<FillName, ExcelJS.FillPattern>;

const thin: ExcelJS.Border = { style: 'thin', color: { argb: argb('BFBFBF') } };
const medium: ExcelJS.Border = { style: 'medium', color: { argb: argb('7F7F7F') } };

/** Every data cell. */
export const BORDER_BOX: Partial<ExcelJS.Borders> = {
  left: thin,
  right: thin,
  top: thin,
  bottom: thin,
};
/** A totals row — a heavier rule above it. */
export const BORDER_TOP: Partial<ExcelJS.Borders> = {
  left: thin,
  right: thin,
  top: medium,
  bottom: thin,
};

/**
 * NUMBER FORMATS. The `;;@` third/fourth sections are load-bearing: they print a
 * ZERO AS BLANK and pass text through, which is how a `""` returned by an `IF`
 * stays visually empty. NULL IS NEVER 0 is a data rule; this is its typography.
 */
export const FMT = {
  kg: '#,##0;-#,##0;;@',
  kg1: '#,##0.0;-#,##0.0;;@',
  tons1: '#,##0.0',
  pct: '0.00%;-0.00%;;@',
  php: '"₱"#,##0.00;-"₱"#,##0.00;;@',
  hrs: '0.00;-0.00;;@',
  /** Excel BUILT-IN Short Date (numFmtId 14). See the header note. */
  date: 'mm-dd-yy',
  // Checks tab — four decimals, because a check is about the last digit.
  pct4: '0.0000%',
  php4: '"₱"0.0000',
  tol: '0.#####',
} as const;

export const ALIGN = {
  right: { horizontal: 'right', vertical: 'middle' },
  center: { horizontal: 'center', vertical: 'middle', wrapText: true },
  left: { horizontal: 'left', vertical: 'middle' },
} satisfies Record<string, Partial<ExcelJS.Alignment>>;

/** A cached formula value: what the cell shows before Excel recalculates. */
export type CellResult = number | string | null;

export interface PutOptions {
  font?: Partial<ExcelJS.Font>;
  fmt?: string;
  fill?: ExcelJS.FillPattern | null;
  align?: Partial<ExcelJS.Alignment>;
  /** Pass `null` for a title/note cell that carries no border. */
  border?: Partial<ExcelJS.Borders> | null;
  note?: string;
}

/** A plain value cell. `null`/`undefined` writes an EMPTY cell, never a 0. */
export function put(
  ws: ExcelJS.Worksheet,
  addr: string,
  value: number | string | Date | null | undefined,
  opts: PutOptions = {},
): ExcelJS.Cell {
  const cell = ws.getCell(addr);
  if (value !== null && value !== undefined) cell.value = value as ExcelJS.CellValue;
  return style(cell, opts);
}

/**
 * A FORMULA cell, with a cached `result`.
 *
 * THE CACHE IS WHY THE FILE READS CORRECTLY IN A VIEWER THAT DOES NOT RECALCULATE
 * — an email preview, a phone quick-look, a Google Sheets import. Excel itself
 * recalculates on open (`fullCalcOnLoad`), so the cache can only ever be what the
 * reader sees FIRST, never what the workbook means.
 *
 * `formula` is written WITHOUT its leading `=` (ExcelJS adds the `<f>` element
 * itself); a caller may pass either and this strips it.
 */
export function putFormula(
  ws: ExcelJS.Worksheet,
  addr: string,
  formula: string,
  result: CellResult,
  opts: PutOptions = {},
): ExcelJS.Cell {
  const cell = ws.getCell(addr);
  cell.value = {
    formula: formula.startsWith('=') ? formula.slice(1) : formula,
    // A null result means "this formula evaluates to an empty string" — store the
    // empty string rather than nothing, so the cached view is blank rather than 0.
    result: result === null ? '' : result,
  } as ExcelJS.CellValue;
  return style(cell, opts);
}

function style(cell: ExcelJS.Cell, opts: PutOptions): ExcelJS.Cell {
  cell.font = { ...(opts.font ?? FONTS.base) };
  if (opts.fmt) cell.numFmt = opts.fmt;
  if (opts.fill) cell.fill = opts.fill;
  if (opts.align) cell.alignment = { ...opts.align };
  if (opts.border !== null) cell.border = { ...(opts.border ?? BORDER_BOX) };
  if (opts.note) cell.note = { texts: [{ text: opts.note }] };
  return cell;
}

/** `landscape, fit to width, as many pages tall as it needs`. Every sheet. */
export function landscapeFitWidth(ws: ExcelJS.Worksheet): void {
  ws.pageSetup = {
    ...ws.pageSetup,
    orientation: 'landscape',
    fitToWidth: 1,
    fitToHeight: 0,
    fitToPage: true,
  };
}

/** `freeze('F3')` → panes frozen above row 3 and left of column F. */
export function freeze(ws: ExcelJS.Worksheet, ref: string): void {
  const m = /^([A-Z]+)(\d+)$/.exec(ref.toUpperCase());
  if (!m) throw new Error(`freeze: not an A1 reference: ${ref}`);
  let x = 0;
  for (const ch of m[1]) x = x * 26 + (ch.charCodeAt(0) - 64);
  ws.views = [{ state: 'frozen', xSplit: x - 1, ySplit: Number(m[2]) - 1 }];
}

/**
 * A `yyyy-MM-dd` string as an Excel date.
 *
 * UTC MIDNIGHT ON PURPOSE. ExcelJS converts a JS Date to a serial from its epoch
 * milliseconds, so a local-midnight Date west of Greenwich lands on the previous
 * day's serial. These are plant CALENDAR dates with no time in them at all.
 */
export function excelDate(iso: string | null | undefined): Date | null {
  if (!iso) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return null;
  return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
}
