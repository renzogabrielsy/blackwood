// ═════════════════════════════════════════════════════════════════════════════════
// **PLATFORM MODULE (2026-09-17).** PAPER GEOMETRY — the arithmetic behind a
// "this fits on one sheet" promise.
//
// It carries ZERO tenant knowledge: no charcoal, no campaign, no column names, no
// React. It knows a page is a rectangle, a monospace glyph has an advance width, and
// a table has to fit inside both. Everything domain-shaped (WHICH columns, HOW many
// characters each one needs, what the labels say) is decided by the caller and
// handed in as numbers.
//
// ── WHY IT EXISTS ───────────────────────────────────────────────────────────────
// `/operations`' printed ledger learned the hard way that a row height written as a
// CONSTANT is a page-fitting promise that holds for exactly one data shape: JULY
// 2026's 33 days ran onto a third sheet while AUGUST's 29 ran one row onto a fifth
// (see `app/(app)/operations/ops-page-print.tsx`, round 9). The fix there was to make
// the row height a FUNCTION of the row count against a measured budget. RC Movement
// needs the same function AND its horizontal twin — it is a MATRIX, so the number of
// COLUMNS is data too — so the arithmetic moved here rather than being copied.
//
// `/operations` could re-point at this module; it deliberately was NOT edited in the
// change that introduced this file (a second agent was working in that directory),
// so its own constants still live beside it. Nothing here changes its behaviour.
//
// ── THE ONE MEASURED INPUT ──────────────────────────────────────────────────────
// `advanceEm` — the advance width of one glyph of the caller's monospace face, as a
// fraction of the font size. Node has no font engine, so this cannot be derived here;
// it is MEASURED in a real browser by the caller and passed in. For the app's mono
// stack it is 0.6 (see `RCM_MONO_ADVANCE_EM` in the RC Movement print sheet, which
// records how it was measured).
// ═════════════════════════════════════════════════════════════════════════════════

/** CSS px per millimetre at the 96dpi a print box is laid out in. */
export const PX_PER_MM = 96 / 25.4;
/** CSS px per typographic point. */
export const PX_PER_PT = 96 / 72;

/** A4, in millimetres. Landscape swaps them. */
export const A4_SHORT_MM = 210;
export const A4_LONG_MM = 297;

export interface PrintPageBox {
  /** Printable width in CSS px (the page minus both side margins). */
  widthPx: number;
  /** Printable height in CSS px (the page minus both top/bottom margins). */
  heightPx: number;
  /** The margin these were computed from — it MUST match the `@page` rule. */
  marginMm: number;
}

/**
 * The printable box of one A4 LANDSCAPE sheet at a given uniform margin.
 *
 * The margin here and the margin in the injected `@page` block are the same number
 * stated twice; they must move together or neither may. Callers should derive the
 * `@page` rule from the same constant.
 */
export function a4LandscapeBox(marginMm: number): PrintPageBox {
  return {
    widthPx: (A4_LONG_MM - 2 * marginMm) * PX_PER_MM,
    heightPx: (A4_SHORT_MM - 2 * marginMm) * PX_PER_MM,
    marginMm,
  };
}

/** Advance width of ONE monospace character, in px, at `fontPt`. */
export function monoCharPx(fontPt: number, advanceEm: number): number {
  return fontPt * PX_PER_PT * advanceEm;
}

/**
 * One column's demand, expressed in CHARACTERS rather than pixels.
 *
 * Characters, because the whole point is that the width follows the font, and the
 * font is the thing being solved for. `chars` should be MEASURED OFF THE DATA (the
 * longest string that column will actually render, header included) rather than
 * guessed — a width guessed from a typical value is how a sheet silently clips.
 */
export interface PrintColumnDemand {
  key: string;
  /** Longest rendered string, in characters. Ignored when `fixedPx` is set. */
  chars: number;
  /** A floor, for a column whose content is not the thing that sizes it. */
  minPx?: number;
  /** An exact width, for a column that does not scale with the body font. */
  fixedPx?: number;
}

export interface PrintWidthFit {
  /** The font step that fits, or the ladder's floor when nothing does. */
  fontPt: number;
  /** FALSE when even the floor overflows — the caller must paginate by columns. */
  fits: boolean;
  /** Per-key width in px, in the order the demands were given. */
  widths: Record<string, number>;
  /** Σ widths. At `fits` it is ≤ `availablePx`. */
  totalPx: number;
}

function widthOf(
  d: PrintColumnDemand,
  fontPt: number,
  padPx: number,
  advanceEm: number,
): number {
  if (d.fixedPx !== undefined) return d.fixedPx;
  const w = Math.ceil(d.chars * monoCharPx(fontPt, advanceEm)) + padPx;
  return Math.max(w, d.minPx ?? 0);
}

/**
 * THE HORIZONTAL SOLVE — the largest font step at which every column fits.
 *
 * `ladder` is DESCENDING (e.g. `[9, 8.5, 8, 7.5, 7, 6.5, 6, 5.5]`) and is
 * deliberately COARSE: two sheets of similar shape should print at the same size so a
 * multi-page report reads as one document.
 *
 * When nothing fits, the floor is returned with `fits: false` and the widths it would
 * need — so the caller can say how far over it is, and split by columns instead of
 * shrinking below what a person can read.
 */
export function fitColumnWidths(opts: {
  columns: readonly PrintColumnDemand[];
  availablePx: number;
  ladder: readonly number[];
  padPx: number;
  advanceEm: number;
}): PrintWidthFit {
  const { columns, availablePx, ladder, padPx, advanceEm } = opts;
  let last: PrintWidthFit | null = null;
  for (const fontPt of ladder) {
    const widths: Record<string, number> = {};
    let totalPx = 0;
    for (const d of columns) {
      const w = widthOf(d, fontPt, padPx, advanceEm);
      widths[d.key] = w;
      totalPx += w;
    }
    last = { fontPt, fits: totalPx <= availablePx, widths, totalPx };
    if (last.fits) return last;
  }
  // `ladder` is never empty in practice; the fallback keeps the type honest.
  return last ?? { fontPt: 0, fits: false, widths: {}, totalPx: 0 };
}

/**
 * How many REPEATING columns (matrix columns, one per block/series) fit beside a
 * fixed spine at a given font.
 *
 * Returns at least 1 — a page carrying the spine and one data column is degenerate
 * but printable, and returning 0 would make the caller loop forever.
 */
export function maxRepeatingColumns(opts: {
  fixed: readonly PrintColumnDemand[];
  unit: PrintColumnDemand;
  availablePx: number;
  fontPt: number;
  padPx: number;
  advanceEm: number;
}): number {
  const { fixed, unit, availablePx, fontPt, padPx, advanceEm } = opts;
  const spine = fixed.reduce((a, d) => a + widthOf(d, fontPt, padPx, advanceEm), 0);
  const unitPx = widthOf(unit, fontPt, padPx, advanceEm);
  if (unitPx <= 0) return 1;
  return Math.max(1, Math.floor((availablePx - spine) / unitPx));
}

/** A row-height → font-size step. Descending by `minRowH`. */
export interface PrintFontStep {
  minRowH: number;
  fontPt: number;
}

export interface PrintRowFit {
  /** The exact height every row will occupy, in px. */
  rowH: number;
  /**
   * The line box inside the row — `rowH` minus padding and the collapsed border.
   * Stated explicitly because a `<tr>` height is only a FLOOR in the table model, so
   * the only way to pin a row is to pin its content.
   */
  lineH: number;
  /** The font the ladder gives for this row height. */
  fontPt: number;
  /** FALSE when even `minRowH` overflows — the page is allowed to flow. */
  fits: boolean;
}

/**
 * THE VERTICAL SOLVE — row height as a function of the ROW COUNT.
 *
 * The budget is fixed and the row count is data, so the height is the quotient,
 * clamped at both ends. **Every row that will be drawn at the body font belongs in
 * `rowCount`** — a totals row, a footer line, anything. Pinning one of them at a
 * constant instead is the circularity that made `/operations`' first attempt miss by
 * a single row.
 */
export function fitRowHeight(opts: {
  budgetPx: number;
  rowCount: number;
  minRowH: number;
  maxRowH: number;
  chromePx: number;
  ladder: readonly PrintFontStep[];
}): PrintRowFit {
  const { budgetPx, rowCount, minRowH, maxRowH, chromePx, ladder } = opts;
  const rows = Math.max(1, rowCount);
  const raw = Math.floor(budgetPx / rows);
  const rowH = Math.max(minRowH, Math.min(maxRowH, raw));
  const step = ladder.find((s) => rowH >= s.minRowH) ?? ladder[ladder.length - 1];
  return {
    rowH,
    lineH: Math.max(1, rowH - chromePx),
    fontPt: step.fontPt,
    fits: rowH * rows <= budgetPx,
  };
}

// ─────────────────────────────────────────────────────────────────────────────────
// A GRID OF EQUAL, SQUARE CELLS THAT MUST LAND ON ONE SHEET (2026-09-22)
//
// The third shape of the same question. `fitColumnWidths` solves a table whose columns
// have DIFFERENT demands; `fitRowHeight` solves a table whose row count is data. This
// solves a **map**: a set of equal square cells, laid out in sections, each carrying one
// short label, where the whole thing has to fit inside one printable box without
// clipping and without a second page.
//
// ── WHY THE CELL EDGE IS A QUOTIENT AND NOT A CONSTANT ─────────────────────────
// Exactly the `/operations` lesson from the header, one dimension further: the number of
// SECTIONS and the number of cell ROWS are both data (a map may or may not include its
// optional sections), so a hardcoded cell size is a page-fitting promise that holds for
// one shape. Both budgets are solved and the SMALLER wins, so the cells stay square and
// the page never overflows in either direction.
//
// ── LANES ARE WHAT MAKE A NARROW SECTION CHEAP ─────────────────────────────────
// Sections sharing a `lane` are laid SIDE BY SIDE and pay ONE lane's chrome and one
// lane's height. Without that, two three-column sections stacked below twenty-column
// ones spend two full rows' worth of the height budget on a handful of cells and shrink
// every other cell on the page — measured, on A4 landscape at a 10 mm margin, from
// 51.5 px to 28 px. A caller that wants a section on its own line simply gives it its
// own lane.
//
// ZERO tenant knowledge: sections are `{key, cols, rows, lane}` and a label is a
// character count. What the cells MEAN is entirely the caller's.
// ─────────────────────────────────────────────────────────────────────────────────

/**
 * The largest ladder step at which `chars` monospace glyphs fit inside `widthPx`.
 *
 * EXPORTED separately from `fitCellGrid` because a caller may legitimately ask the
 * question twice for ONE layout — the yard map re-asks it with a shorter label once it
 * decides to wrap — and two spellings of "which font step fits" is exactly the kind of
 * duplicate that lets a page lay out at one size and claim another.
 *
 * `maxPt` is the caller's own second constraint (a height budget, a house maximum); the
 * answer is the largest step satisfying both, or the ladder's floor.
 */
export function fitMonoLabelPt(opts: {
  widthPx: number;
  chars: number;
  advanceEm: number;
  ladder: readonly number[];
  maxPt?: number;
}): number {
  const { widthPx, chars, advanceEm, ladder, maxPt } = opts;
  for (const pt of ladder) {
    if (maxPt !== undefined && pt > maxPt) continue;
    if (chars * monoCharPx(pt, advanceEm) <= widthPx) return pt;
  }
  return ladder[ladder.length - 1] ?? 0;
}

export interface PrintCellGridSection {
  key: string;
  /** Cell COLUMNS this section occupies. */
  cols: number;
  /** Cell ROWS this section occupies. */
  rows: number;
  /**
   * Sections sharing a lane sit SIDE BY SIDE and pay one lane's chrome and height.
   * Lanes are laid out in ascending order; the values need not be contiguous.
   */
  lane: number;
}

export interface PrintCellGridFit {
  /** The edge of every cell, in px. Square, and the same for every section. */
  cellPx: number;
  /** The largest ladder step at which `labelChars` fits inside one cell. */
  fontPt: number;
  /** FALSE when even `minCellPx` overflows a budget — the caller must say so. */
  fits: boolean;
  laneCount: number;
  /** Σ over lanes of the tallest section in that lane. */
  cellRowCount: number;
  /** The widest lane's cell columns — what the width budget was divided by. */
  widestLaneCols: number;
  /** Σ lane heights + per-lane chrome + lane gaps + the reserved band, in px. */
  totalHeightPx: number;
  /** The widest lane's width, gutters and inter-section gaps included, in px. */
  totalWidthPx: number;
  /** The width a label actually has: the cell minus its own border/padding. */
  labelBoxPx: number;
  /** Which budget decided the edge — useful in a report that states its own fit. */
  boundBy: 'width' | 'height';
}

/**
 * THE SQUARE-CELL SOLVE — one page, every cell, no clipping.
 *
 * `fontLadderPt` is DESCENDING and deliberately coarse, for the same reason
 * `fitColumnWidths`' is: two maps of similar shape should print at the same size.
 */
export function fitCellGrid(opts: {
  sections: readonly PrintCellGridSection[];
  /** The printable box — usually `a4LandscapeBox(marginMm)`. */
  box: PrintPageBox;
  /** Height this page spends on things that are NOT the grid (heading, legend). */
  reservedHeightPx: number;
  /** The row-label gutter each section carries, in px. */
  gutterPx: number;
  /** Per LANE: its heading row plus its column-number row, in px. */
  laneChromePx: number;
  /** Between two lanes, in px. */
  laneGapPx: number;
  /** Between two sections sharing a lane, in px. */
  sectionGapPx: number;
  /** Border and padding a cell spends before its label, in px. */
  cellChromePx: number;
  minCellPx: number;
  maxCellPx: number;
  /** The longest label LINE any cell will draw, in characters. */
  labelChars: number;
  advanceEm: number;
  fontLadderPt: readonly number[];
}): PrintCellGridFit {
  const {
    sections, box, reservedHeightPx, gutterPx, laneChromePx, laneGapPx, sectionGapPx,
    cellChromePx, minCellPx, maxCellPx, labelChars, advanceEm, fontLadderPt,
  } = opts;

  const lanes = [...new Set(sections.map((s) => s.lane))].sort((a, b) => a - b);
  const laneOf = (lane: number) => sections.filter((s) => s.lane === lane);

  // ── The HEIGHT budget: one row of cells per cell row, plus each lane's chrome ──
  let cellRowCount = 0;
  for (const lane of lanes) {
    let tallest = 0;
    for (const s of laneOf(lane)) tallest = Math.max(tallest, s.rows);
    cellRowCount = cellRowCount + tallest;
  }
  const chromePx =
    reservedHeightPx + lanes.length * laneChromePx + Math.max(0, lanes.length - 1) * laneGapPx;
  const heightBudget = box.heightPx - chromePx;
  const byHeight = heightBudget / Math.max(1, cellRowCount);

  // ── The WIDTH budget: the TIGHTEST lane decides, not the widest column count ──
  // A lane's fixed cost is its sections' gutters plus the gaps between them, so a lane
  // of many narrow sections can bind before a lane of one wide one.
  let byWidth = Number.POSITIVE_INFINITY;
  let widestLaneCols = 0;
  for (const lane of lanes) {
    const inLane = laneOf(lane);
    let cols = 0;
    for (const s of inLane) cols = cols + s.cols;
    widestLaneCols = Math.max(widestLaneCols, cols);
    const fixed = inLane.length * gutterPx + Math.max(0, inLane.length - 1) * sectionGapPx;
    byWidth = Math.min(byWidth, (box.widthPx - fixed) / Math.max(1, cols));
  }

  const raw = Math.min(byWidth, byHeight);
  // Two decimals: enough for a sub-pixel-accurate layout, coarse enough that the number
  // a report PRINTS about itself is the number it laid out with.
  const clamped = Math.max(minCellPx, Math.min(maxCellPx, raw));
  const cellPx = Math.floor(clamped * 100) / 100;

  const labelBoxPx = Math.max(0, cellPx - cellChromePx);
  const fontPt = fitMonoLabelPt({
    widthPx: labelBoxPx,
    chars: labelChars,
    advanceEm,
    ladder: fontLadderPt,
  });

  // The widest lane's rendered width, for the container the caller centres or pins.
  let totalWidthPx = 0;
  for (const lane of lanes) {
    const inLane = laneOf(lane);
    let cols = 0;
    for (const s of inLane) cols = cols + s.cols;
    const w =
      inLane.length * gutterPx +
      Math.max(0, inLane.length - 1) * sectionGapPx +
      cols * cellPx;
    totalWidthPx = Math.max(totalWidthPx, w);
  }

  return {
    cellPx,
    fontPt,
    fits: cellRowCount * cellPx <= heightBudget && totalWidthPx <= box.widthPx,
    laneCount: lanes.length,
    cellRowCount,
    widestLaneCols,
    totalHeightPx: chromePx + cellRowCount * cellPx,
    totalWidthPx,
    labelBoxPx,
    boundBy: byWidth <= byHeight ? 'width' : 'height',
  };
}

/**
 * Split a list into balanced chunks of at most `maxPerChunk`.
 *
 * BALANCED, not greedy: 25 columns at 20 per page is `13 + 12`, never `20 + 5`. A
 * near-empty continuation sheet reads as a mistake, and two pages of similar density
 * are two pages a reader can compare.
 */
export function splitEvenly<T>(items: readonly T[], maxPerChunk: number): T[][] {
  if (items.length === 0) return [[]];
  const per = Math.max(1, maxPerChunk);
  if (items.length <= per) return [items.slice()];
  const pages = Math.ceil(items.length / per);
  const size = Math.ceil(items.length / pages);
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}
