// ─────────────────────────────────────────────────────────────────────────────
// THE YARD MAP — every block location of the grid, as a paintable set of cells.
//
// The owner, on the lens print's first page: *"within this page or maybe the next page,
// I'd like to see the actual block arrangement in our app to be printed in SOLID colors.
// This is purely for location reference, so make the block loc (C-19A, etc.) right in
// the middle and in BIG font so it can be fully seen in the print. Make sure it shows
// ALL blocks in one landscape page."*
//
// So this is NOT a second lens, a second band table or a second statistic. It answers
// exactly one question — WHERE is each band in the yard — and it carries **no kilogram,
// no price, no age, no supplier and no lab reading**. The loc is the only large text on
// it, which is what the owner asked for and also what makes it fit.
//
// ── THE GEOMETRY IS READ FROM `constants.ts`, NEVER RESTATED ─────────────────
// `WAREHOUSES` is the one declaration of the yard's shape (A = 20 cols × rows A–C,
// B/C = 20 × 2, D = 20 × 4, PCA/PCB = 3 × 3 from column 15) and `blocking-grid.tsx`
// builds a slot's key as `<whse>-<col><row>`. Both are used verbatim here, so adding a
// warehouse or a row to the grid adds it to this map with no edit. A literal `220` or
// `240` anywhere in this file would be a second, driftable statement of the same fact —
// `scripts/verify-blocking-lens-ui.ts` asserts neither appears.
//
// ── PCA / PCB ARE OPT-IN, EXACTLY AS THEY ARE ON SCREEN ─────────────────────
// On the grid they are filter chips and do not count against the 220-slot baseline. On
// paper there is no filter to read, so the map includes them **iff the grid payload
// actually holds a block in one of them** — the sheet describes the yard it was handed.
// They also share ONE lane (side by side) rather than taking a lane each: three columns
// wide, a lane each spends two full rows' worth of the height budget on 18 slots and
// shrinks every other cell on the page from 51.5 px to 28 px (measured).
//
// ── THE FOUR CELL KINDS, AND WHY "GREY" IS TWO OF THEM ──────────────────────
//   `banded`  occupied, in a band the sheet is SHOWING → that band's SOLID hue.
//   `muted`   occupied, in a band the reader ISOLATED OUT → light neutral grey. The
//             table pages already say "Showing 2 of 4 bands"; a map that painted the
//             hidden bands anyway would be describing a different filter.
//   `nodata`  occupied, in NO band at all — unpriced / undated / unattributed. Also
//             grey, and the ONLY kind that draws a dash, because "we don't know" is a
//             different answer from "not selected" and must be readable as one. Painting
//             it as the cheapest/newest band is the L-008 mistake in yet another costume.
//   `empty`   no block here. White with a hairline, loc in small muted text — location
//             reference matters for the empty slots too, which is where the next pile goes.
//
// ── PURE ────────────────────────────────────────────────────────────────────
// No React, no fetch, no server action, and no arithmetic on a kilogram, a price, an age
// or a lab reading — it counts SLOTS and nothing else. `scripts/verify-blocking-lens-ui.ts`
// calls it directly over a synthetic grid.
// ─────────────────────────────────────────────────────────────────────────────

import {
  a4LandscapeBox,
  fitCellGrid,
  fitMonoLabelPt,
  PX_PER_PT,
  type PrintCellGridFit,
} from '@/components/shared/print/print-fit';

import { WAREHOUSES } from '../constants';
import type { BlockData } from '../types';
import { printFillRgbAtStop, type LensRampId } from './lens-ramp';

// ── The paper palette ───────────────────────────────────────────────────────
//
// Explicit hex, not a theme token, for the same reason the whole lens sheet is: it lays
// out in the LIVE DOM, so a token would print whatever theme the reader happens to be in.

/** Occupied but not painted — an isolated-out band, or a block in no band at all. */
export const LENS_YARD_MAP_MUTED_BG = '#e4e4e7';
/** Ink on that grey. */
export const LENS_YARD_MAP_MUTED_INK = '#3f3f46';
/** An empty slot. */
export const LENS_YARD_MAP_EMPTY_BG = '#ffffff';
/** Its loc — legible, but plainly not a pile. */
export const LENS_YARD_MAP_EMPTY_INK = '#a1a1aa';
/** Every cell's 1px border. The map reads as a grid because of it. */
export const LENS_YARD_MAP_HAIRLINE = '#d4d4d8';
/** The two inks a solid band fill may carry. See `lensYardMapInkOn`. */
export const LENS_YARD_MAP_DARK_INK = '#18181b';
export const LENS_YARD_MAP_LIGHT_INK = '#ffffff';
/** What a `nodata` cell prints under its loc. An em dash, never a zero. */
export const LENS_YARD_MAP_NODATA_MARK = '—';

/**
 * ⚠️ THE LUMINANCE RULE, WRITTEN ONCE AND NOWHERE ELSE — AND ON PAPER IT NOW ALWAYS
 * ANSWERS BLACK.
 *
 * ── WHY IT STILL EXISTS AFTER THE PRINT PALETTE (2026-09-22, second pass) ────
 * The owner, on the live map: *"verify these are easy to read when printed on lower-quality
 * printers. Use simple colours that contrast well from BLACK text — don't use dark colours
 * that clash with black."* The map used to paint the SCREEN ramp solid, which put six of
 * the fourteen ordinal hues and six of the thirteen categorical ones BELOW the crossover
 * below — so the loc flipped to WHITE, and white on deep fuchsia off a tired office laser
 * is exactly the case he was asking about. The map now paints `LENS_PRINT_FILL_RGB`
 * (`lens-ramp.ts`), whose WORST entry is **7.75:1 against black**, so this function
 * returns near-black for every fill the map can produce and its white branch is
 * structurally unreachable there.
 *
 * **It is kept rather than replaced by a hardcoded black**, for the reason every
 * one-definition rule on this page exists: the ink is a FUNCTION OF THE FILL, and a map
 * cell, a legend swatch border and a mixed block's dashed outline must all reach the same
 * answer. `scripts/verify-blocking-lens-ui.ts` asserts that every print fill resolves to
 * `LENS_YARD_MAP_DARK_INK`, so a future palette edit that reached for a dark fill fails
 * the check instead of quietly reintroducing white ink on paper.
 *
 * The threshold is not a taste value: `sqrt(1.05 × 0.05) − 0.05 ≈ 0.1791` is the exact
 * luminance at which white-on-fill and black-on-fill have the SAME contrast ratio, so
 * picking the side of it with more contrast is, by construction, the better of the two.
 * Measured on the PRINT table: every entry lands between 0.3377 (deep fuchsia tint) and
 * 0.8831 (sky tint), i.e. from 1.9× to 4.9× the crossover.
 */
export const LENS_YARD_MAP_INK_CROSSOVER = 0.1791;

/** One sRGB channel, linearised. The WCAG transfer function, nothing else. */
function channel(v255: number): number {
  const c = v255 / 255;
  return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

/** WCAG relative luminance of an `r g b` triple as `lens-ramp.ts` spells them. */
export function lensYardMapLuminance(rgb: string): number {
  const [r, g, b] = rgb.trim().split(/\s+/).map((n) => channel(Number(n)));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** Near-black or white on that fill — the one call every cell and swatch makes. */
export function lensYardMapInkOn(rgb: string): string {
  return lensYardMapLuminance(rgb) > LENS_YARD_MAP_INK_CROSSOVER
    ? LENS_YARD_MAP_DARK_INK
    : LENS_YARD_MAP_LIGHT_INK;
}

// ── The map ─────────────────────────────────────────────────────────────────

export type LensYardMapCellKind = 'banded' | 'muted' | 'nodata' | 'empty';

export interface LensYardMapCell {
  /** `C-19A` — the grid's own slot key, and the only large text on the page. */
  loc: string;
  /**
   * The loc, split at its hyphen: `['A-20C']` or `['PCA', '15A']`.
   *
   * ⚠️ WRAPPING IS A DECISION, NOT AN ACCIDENT, and it is made TWICE.
   *
   *   • ALWAYS for a multi-letter warehouse (`PCA-15A` is seven characters against
   *     `A-20C`'s five). Every cell on the page is the same square, so pricing the font
   *     for the longest loc would drag all 238 slots down to serve eighteen.
   *   • AND, at paint time, for EVERY cell when the one-line font would fall below
   *     `LENS_YARD_MAP_MIN_LOC_PT` — see `lensYardMapLineBudget`. Measured: with PCA/PCB
   *     in, one line solves to 8.5 pt while two lines solve to 10 pt, so the wrap makes
   *     the loc BIGGER, not smaller.
   *
   * Either way the WHOLE loc is on the paper. Truncating it was never an option: the
   * owner's requirement is that the block loc "can be fully seen in the print".
   */
  lines: readonly string[];
  occupied: boolean;
  /** The lens's band index, or NULL when the lens cannot place this block. */
  band: number | null;
  /** More than one supplier in the block. Only the supplier lens ever sets it. */
  mixed: boolean;
}

export interface LensYardMapSection {
  /** `A` … `D`, `PCA`, `PCB` — the warehouse key from `WAREHOUSES`. */
  key: string;
  /** `Warehouse A` / `PCA` — PCA and PCB are places, not letters. */
  label: string;
  /** Sections sharing a lane are drawn side by side. */
  lane: number;
  /** The column NUMBERS along the top, from the warehouse's own `colStart`. */
  cols: readonly number[];
  /** The row letters down the side. */
  rows: readonly string[];
  /** `[rowIndex][colIndex]`. */
  cells: readonly (readonly LensYardMapCell[])[];
}

export interface LensYardMap {
  sections: readonly LensYardMapSection[];
  /** Slots drawn. Counted from the geometry — never a literal. */
  slotCount: number;
  occupiedCount: number;
  /** Occupied and placed in SOME band (isolation is applied at paint time, not here). */
  bandedCount: number;
  /** Occupied and in NO band — the population the band tables list separately. */
  nodataCount: number;
  /** The longest label LINE any cell draws UNWRAPPED — the fit solver's first input. */
  labelChars: number;
  /** The same, once EVERY loc is wrapped at its hyphen — the fallback solve's input. */
  wrappedLabelChars: number;
  /**
   * Occupied blocks whose `block_loc` is not a slot on this geometry.
   *
   * They CANNOT be drawn, so they are NAMED instead of silently dropped — the same
   * discipline as the band tables' trailing `Other` warehouse group. A map that quietly
   * omitted a pile would be worse than one that says it could not place it.
   */
  offMapLocs: readonly string[];
}

export interface LensYardMapInput {
  /** The live grid map the lens was handed. Occupancy is `loc in data`. */
  data: Record<string, BlockData>;
  /** `block_loc` → band index, or `undefined` for a block the lens cannot PLACE. */
  bandOf: (blockLoc: string) => number | undefined;
  /** More than one supplier in the block. Omitted by the lenses that cannot know. */
  isMixed?: (blockLoc: string, block: BlockData) => boolean;
}

/**
 * The CORE's input — a list of locs and two lookups, and nothing that knows what a
 * block IS.
 *
 * Extracted 2026-09-23 so the BLEND PROPOSAL print can draw the same map without a
 * second copy of the geometry, the fit, the palette or the ink. `buildLensYardMap`
 * below is now a two-line wrapper over it, so the lens map's output is unchanged by
 * construction rather than by inspection.
 */
export interface YardMapCellsInput {
  /**
   * Every loc the map should treat as OCCUPIED — for a lens, `Object.keys(data)`.
   *
   * It is also the universe the PCA/PCB opt-in and `offMapLocs` are read from, so a loc
   * that is not a slot on this layout still gets NAMED rather than dropped.
   */
  locs: readonly string[];
  /** `loc` → band index, or `undefined` for one the caller cannot PLACE. */
  bandOf: (loc: string) => number | undefined;
  /** The dashed inset marker — mixedness on a lens, a vacated block on a blend. */
  marked?: (loc: string) => boolean;
}

/** A warehouse key of more than one letter is an opt-in prepared-charcoal area. */
function isOptional(key: string): boolean {
  return key.length > 1;
}

function sectionLabel(key: string): string {
  return isOptional(key) ? key : `Warehouse ${key}`;
}

/** `PCA-15A` → `['PCA', '15A']`; `A-20C` → `['A-20C']` unless `force`. */
export function lensYardMapLines(
  key: string,
  loc: string,
  force = false,
): readonly string[] {
  if (!force && !isOptional(key)) return [loc];
  const cut = loc.indexOf('-');
  return cut < 0 ? [loc] : [loc.slice(0, cut), loc.slice(cut + 1)];
}

/**
 * Below this the loc is wrapped instead of shrunk. See `LensYardMapCell.lines`.
 *
 * It is a LEGIBILITY floor, not the print kit's 7 pt hard floor: the owner asked for the
 * loc "in BIG font so it can be fully seen", and the map carries nothing else, so there
 * is no reason to accept a small one while a two-line layout is available.
 */
export const LENS_YARD_MAP_MIN_LOC_PT = 9;

/** The line box a loc line occupies, as a multiple of its font size. `leading-none`, padded. */
export const LENS_YARD_MAP_LINE_HEIGHT = 1.1;

/** The `nodata` dash's own font size, in points. It shares the cell's height budget. */
export const LENS_YARD_MAP_NODATA_PT = 5.5;

/**
 * Build the whole map: every slot of the geometry, with the band the lens puts it in.
 *
 * The optional warehouses are included only when the payload holds a block in one of
 * them, which is what makes the sheet describe the yard it was given rather than the
 * yard the constants allow for.
 */
export function buildLensYardMap(input: LensYardMapInput): LensYardMap {
  const { data, bandOf, isMixed } = input;
  return buildYardMapCells({
    locs: Object.keys(data),
    bandOf,
    marked:
      isMixed === undefined
        ? undefined
        : (loc) => {
            const block = data[loc];
            return block !== undefined && isMixed(loc, block);
          },
  });
}

/**
 * THE CORE — every slot of the geometry, with the band the caller puts it in.
 *
 * See `YardMapCellsInput`. The optional warehouses are included only when the caller's
 * own loc list holds one of them, which is what makes the sheet describe the yard it was
 * given rather than the yard the constants allow for.
 */
export function buildYardMapCells(input: YardMapCellsInput): LensYardMap {
  const { locs, bandOf, marked } = input;
  const occupiedSet = new Set(locs);

  const keys = Object.keys(WAREHOUSES);
  const hasBlockIn = (key: string): boolean => {
    const prefix = `${key}-`;
    for (const loc of occupiedSet) if (loc.startsWith(prefix)) return true;
    return false;
  };
  const shown = keys.filter((k) => !isOptional(k) || hasBlockIn(k));

  // Every standard warehouse takes its own lane, in the grid's declaration order; every
  // OPTIONAL one shares the last lane. See the header note on why.
  const standard = shown.filter((k) => !isOptional(k));
  const optional = shown.filter((k) => isOptional(k));

  const sections: LensYardMapSection[] = [];
  let slotCount = 0;
  let occupiedCount = 0;
  let bandedCount = 0;
  let nodataCount = 0;
  let labelChars = 0;
  let wrappedLabelChars = 0;
  const drawn = new Set<string>();

  const push = (key: string, lane: number) => {
    const whse = WAREHOUSES[key];
    const cols = Array.from({ length: whse.cols }, (_, i) => whse.colStart + i);
    const cells = whse.rows.map((row) =>
      cols.map((col) => {
        const loc = `${key}-${col}${row}`;
        const occupied = occupiedSet.has(loc);
        const band = occupied ? bandOf(loc) : undefined;
        const lines = lensYardMapLines(key, loc);
        slotCount = slotCount + 1;
        for (const line of lines) labelChars = Math.max(labelChars, line.length);
        for (const line of lensYardMapLines(key, loc, true)) {
          wrappedLabelChars = Math.max(wrappedLabelChars, line.length);
        }
        if (occupied) {
          drawn.add(loc);
          occupiedCount = occupiedCount + 1;
          if (band === undefined) nodataCount = nodataCount + 1;
          else bandedCount = bandedCount + 1;
        }
        return {
          loc,
          lines,
          occupied,
          band: band === undefined ? null : band,
          mixed: occupied && marked !== undefined ? marked(loc) : false,
        } satisfies LensYardMapCell;
      }),
    );
    sections.push({ key, label: sectionLabel(key), lane, cols, rows: whse.rows, cells });
  };

  standard.forEach((key, i) => push(key, i));
  for (const key of optional) push(key, standard.length);

  const offMapLocs = [...occupiedSet]
    .filter((loc) => !drawn.has(loc))
    .sort((a, b) => a.localeCompare(b));

  return {
    sections,
    slotCount,
    occupiedCount,
    bandedCount,
    nodataCount,
    labelChars,
    wrappedLabelChars,
    offMapLocs,
  };
}

// ── Painting one cell ───────────────────────────────────────────────────────

export interface LensYardMapPaint {
  kind: LensYardMapCellKind;
  /** A CSS colour. For `banded` it is the ramp's SOLID hue at full opacity. */
  bg: string;
  /** The loc's colour — chosen by `lensYardMapInkOn` for a banded fill. */
  ink: string;
  /** The dashed inset outline a MIXED block keeps on paper, or null. */
  outline: string | null;
}

/**
 * How one cell is painted, given the bands the sheet is SHOWING.
 *
 * `stopByVisibleBand` carries only the bands on the sheet, so a band the reader isolated
 * out is absent and the cell falls to `muted` — one map, one lookup, and the map cannot
 * disagree with the "Showing 2 of 4 bands" line above it.
 *
 * **The fill is the PRINT palette's tint at FULL opacity.** On screen a band is a 22%
 * wash over the cell's own surface, which is right for a screen carrying a batch code, a
 * balance and a price; here the cell carries a loc and nothing else and the owner asked
 * for SOLID colour. Solid at the SCREEN saturation is what put white ink on half the ramp,
 * so the map reads `printFillRgbAtStop` — a white TINT of the same hue, ≥ 7.75:1 against
 * black. The hue is the band table's swatch hue to within 0.79°, so the two are matchable
 * by eye while each is legible on its own surface.
 *
 * **A MIXED block keeps its dashed INSET outline, in the ink rather than the hue.** On
 * the grid `.lens-cat-mixed` dashes in `var(--lens-hue)` over a 22% wash of that same
 * hue; over a SOLID fill of it the dash would be invisible, so it takes the colour that
 * is already legible on this fill. Same shape, same meaning, same inset.
 */
export function lensYardMapPaint(
  cell: LensYardMapCell,
  ramp: LensRampId,
  stopByVisibleBand: ReadonlyMap<number, number>,
): LensYardMapPaint {
  if (!cell.occupied) {
    return {
      kind: 'empty',
      bg: LENS_YARD_MAP_EMPTY_BG,
      ink: LENS_YARD_MAP_EMPTY_INK,
      outline: null,
    };
  }
  const stop = cell.band === null ? undefined : stopByVisibleBand.get(cell.band);
  if (stop === undefined) {
    return {
      // NULL band = the lens could not place it; a band that is simply hidden is the
      // other case, and only the first draws a dash.
      kind: cell.band === null ? 'nodata' : 'muted',
      bg: LENS_YARD_MAP_MUTED_BG,
      ink: LENS_YARD_MAP_MUTED_INK,
      outline: cell.mixed ? LENS_YARD_MAP_MUTED_INK : null,
    };
  }
  const rgb = printFillRgbAtStop(ramp, stop);
  const ink = lensYardMapInkOn(rgb);
  return { kind: 'banded', bg: `rgb(${rgb})`, ink, outline: cell.mixed ? ink : null };
}

// ─────────────────────────────────────────────────────────────────────────────
// THE PAGE GEOMETRY AND THE TWO-STAGE FIT (moved here 2026-09-23)
//
// These constants and the solve below used to live in `lens-yard-map-print.tsx`, which
// was fine while the lens sheet was the only surface that drew a yard map. The BLEND
// PROPOSAL print now draws the same map — through a different rendering path (a
// self-contained HTML string in a hidden iframe, and a jsPDF page), so it cannot import
// a React component. Copying the numbers into it would have been a second statement of
// how big a cell is, and the first thing to drift would be the ONE-PAGE PROMISE.
//
// So the arithmetic lives beside the geometry it measures, both callers read it, and
// `scripts/verify-blocking-lens-ui.ts` still proves the shipped shapes land on the
// numbers CONTEXT.md quotes. Every value below was MEASURED with the lens sheet in a
// real headless-Chromium PDF; the lens page's output is unchanged by construction,
// because nothing about the inputs moved.
// ─────────────────────────────────────────────────────────────────────────────

/** Heading + legend + a little slack, in px. */
export const YARD_MAP_RESERVED_PX = 40;
/** The row-letter column each section carries. */
export const YARD_MAP_GUTTER_PX = 16;
/** A lane's warehouse label row. */
export const YARD_MAP_LABEL_H_PX = 13;
/** A lane's column-number row. */
export const YARD_MAP_COLHDR_H_PX = 9;
export const YARD_MAP_LANE_CHROME_PX = YARD_MAP_LABEL_H_PX + YARD_MAP_COLHDR_H_PX;
export const YARD_MAP_LANE_GAP_PX = 5;
/** Between PCA and PCB, which share a lane. */
export const YARD_MAP_SECTION_GAP_PX = 8;
/** A cell's two 1px borders. There is no padding — the loc is flex-centred. */
export const YARD_MAP_CELL_CHROME_PX = 2;
export const YARD_MAP_MIN_CELL_PX = 20;
/** A ceiling, so a hypothetically tiny yard does not get comic cells. */
export const YARD_MAP_MAX_CELL_PX = 64;
/**
 * DESCENDING, and coarse for the same reason the rest of the print kit's ladders are.
 * 7 pt is the floor the whole kit keeps.
 */
export const YARD_MAP_FONT_LADDER_PT = [13, 12, 11.5, 11, 10.5, 10, 9.5, 9, 8.5, 8, 7.5, 7] as const;
/**
 * The advance width of one glyph, as a fraction of the font size — the one MEASURED
 * input `print-fit.ts` cannot derive (Node has no font engine).
 *
 * ⚠️ **0.65, not RC Movement's 0.6, and the difference is a BUG THIS PAGE ALREADY HAD.**
 * A map cell's loc is bold, and the bold face is WIDER than the regular one: over a
 * 100-character run of `A-10A` in a real browser, regular measured **0.6039** and bold
 * **0.6298**. Budgeted at 0.6 the five-character locs overflowed their cell and the
 * browser silently wrapped them mid-code, which is visible in the very first PDF this
 * page produced. 0.65 is the measured bold figure rounded up.
 */
export const YARD_MAP_MONO_ADVANCE_EM = 0.65;

export interface YardMapFit {
  /** The platform solver's answer — cell edge, total box, label box, `fits`. */
  cells: PrintCellGridFit;
  /** The loc's font size in points, after the WRAP-RATHER-THAN-SHRINK stage. */
  fontPt: number;
  /** The page decided to wrap EVERY loc at its hyphen rather than shrink it. */
  wrapAll: boolean;
}

/**
 * THE SOLVE — one square cell edge against BOTH budgets, then the loc's font.
 *
 * ── STAGE TWO: WRAP RATHER THAN SHRINK ───────────────────────────────────────
 * The cell EDGE is fixed by the page, not by the label, so a label that does not fit has
 * exactly two outcomes: a smaller font, or two lines. Measured on A4 landscape at 10 mm
 * with PCA/PCB in (39.14 px cells): one line solves to **8.5 pt**, two lines to **10 pt**
 * — so wrapping makes the loc BIGGER. The height budget subtracts the `nodata` dash,
 * because that cell must hold three lines without clipping any of them, and sizing only
 * the common case is how the one cell that carries a warning loses it.
 *
 * `marginMm` MUST be the margin the sheet's own `@page` rule uses — the two are the same
 * number stated twice, so each caller passes it from one constant.
 *
 * ⚠️ `reservedHeightPx` DEFAULTS to the lens sheet's own budget and exists because the
 * BLEND print's map legitimately carries more chrome than the lens print's (2026-09-23):
 * a terse as-of caption and a footnote line the lens page has no equivalent of. Measured
 * with the default: the blend sheet came out **764.70 px against 718.11 px of printable
 * height — 46.59 px over**, which Chrome cannot honour `break-inside: avoid` for, so its
 * legend landed on a second sheet. A caller that draws different chrome states its own
 * budget rather than the solve guessing; the lens callers pass nothing and are unchanged.
 */
export function solveYardMapFit(
  map: LensYardMap,
  marginMm: number,
  reservedHeightPx: number = YARD_MAP_RESERVED_PX,
): YardMapFit {
  const cells = fitCellGrid({
    sections: map.sections.map((s) => ({
      key: s.key,
      cols: s.cols.length,
      rows: s.rows.length,
      lane: s.lane,
    })),
    box: a4LandscapeBox(marginMm),
    reservedHeightPx,
    gutterPx: YARD_MAP_GUTTER_PX,
    laneChromePx: YARD_MAP_LANE_CHROME_PX,
    laneGapPx: YARD_MAP_LANE_GAP_PX,
    sectionGapPx: YARD_MAP_SECTION_GAP_PX,
    cellChromePx: YARD_MAP_CELL_CHROME_PX,
    minCellPx: YARD_MAP_MIN_CELL_PX,
    maxCellPx: YARD_MAP_MAX_CELL_PX,
    labelChars: map.labelChars,
    advanceEm: YARD_MAP_MONO_ADVANCE_EM,
    fontLadderPt: YARD_MAP_FONT_LADDER_PT,
  });

  const dashPx = LENS_YARD_MAP_NODATA_PT * PX_PER_PT;
  const maxPtForLines = (n: number) =>
    (cells.labelBoxPx - dashPx) / n / (PX_PER_PT * LENS_YARD_MAP_LINE_HEIGHT);
  const onePt = fitMonoLabelPt({
    widthPx: cells.labelBoxPx,
    chars: map.labelChars,
    advanceEm: YARD_MAP_MONO_ADVANCE_EM,
    ladder: YARD_MAP_FONT_LADDER_PT,
    maxPt: maxPtForLines(1),
  });
  const wrapAll = onePt < LENS_YARD_MAP_MIN_LOC_PT;
  const fontPt = wrapAll
    ? fitMonoLabelPt({
        widthPx: cells.labelBoxPx,
        chars: map.wrappedLabelChars,
        advanceEm: YARD_MAP_MONO_ADVANCE_EM,
        ladder: YARD_MAP_FONT_LADDER_PT,
        maxPt: maxPtForLines(2),
      })
    : onePt;

  return { cells, fontPt, wrapAll };
}

/** Only what a map page needs of a band: which one, what it is called, what colour. */
export interface LensYardMapBand {
  index: number;
  label: string;
  /** Stated by a NOMINAL lens; omitted by an ordinal one. See `lens-ramp.ts`. */
  rampStop?: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// THE BLEND PROPOSAL'S CELLS — a THIN caller of the core above (2026-09-23)
//
// The owner: *"I'd also like to see a blocking view in the print of blend proposals,
// similar to the ones we made for the lens prints."*
//
// It answers the same one question the lens map answers — WHERE in the yard — about a
// different set of blocks, so it reuses the geometry, the fit, the palette, the ink and
// the four cell kinds verbatim and adds exactly two decisions:
//
//   1. **WHICH BAND a selected block is in.** With the PRICE GROUPS page on, the
//      proposal's own natural-breaks group (low / average / high); otherwise ONE accent
//      for every selected block. Nothing here computes a group — it is handed the
//      payload's own `price.natural.groups[].blocks[]`.
//   2. **A SELECTED BLOCK THE YARD NO LONGER HOLDS still gets drawn.** Its batch was fed
//      out since the version was saved, so the slot is empty today — but the proposal
//      SAID that block, and a map that dropped it would quietly describe a different
//      blend. It keeps the selection fill and takes the dashed inset marker, which is the
//      supplier lens's own technique for "this cell needs a second look".
//
// Everything ELSE occupied is `muted` — the lens map's "occupied, not in a band shown"
// grey, with NO dash, because a block that simply was not selected is not an unknown.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The band index an OCCUPIED-but-not-selected block carries.
 *
 * It is a real index that is deliberately absent from the sheet's colour lookup, so
 * `lensYardMapPaint` falls to `muted` (grey, no dash) rather than `nodata` (grey WITH a
 * dash). That distinction is the lens map's own and is worth keeping: "not selected" and
 * "we could not place it" are different answers.
 */
export const BLEND_YARD_MAP_OTHER_BAND = -1;

/** The band index every selected block carries when the map is NOT coloured by group. */
export const BLEND_YARD_MAP_SELECTED_BAND = 0;

/**
 * The accent a selected block wears when there is no price grouping to colour it by.
 *
 * **Stop 3 of the `cost` ramp — its exact MIDDLE (the amber tint `249 201 118`, L 0.6322,
 * 13.64:1 against black).** The middle on purpose: on a map with no price grouping the
 * fill must not imply cheap (stop 0's emerald) or dear (stop 6's rose), and this page's
 * legend says only `Selected block`. It is read through `printFillRgbAtStop` like every
 * other fill, so it is the same paper palette and the same black ink.
 */
export const BLEND_YARD_MAP_ACCENT_STOP = 3;

export interface BlendYardMapCellsInput {
  /** Every `block_loc` the yard holds a pile in RIGHT NOW — from the grid's own payload. */
  occupiedLocs: readonly string[];
  /** The proposal's blocks, by `block_loc`. */
  selectedLocs: readonly string[];
  /**
   * `block_loc` → natural-breaks group index, when the PRICE page is on and its payload
   * arrived. Absent → one accent for every selected block.
   */
  groupByLoc?: Readonly<Record<string, number>>;
}

export interface BlendYardMapCells {
  map: LensYardMap;
  /** Selected blocks the yard no longer holds — dashed, and named in the legend. */
  goneLocs: readonly string[];
}

/**
 * Build the blend's map. Pure, and it counts SLOTS — no kilogram, no price, no lab reading.
 */
export function buildBlendYardMapCells(input: BlendYardMapCellsInput): BlendYardMapCells {
  const { occupiedLocs, selectedLocs, groupByLoc } = input;
  const selected = new Set(selectedLocs);
  const occupied = new Set(occupiedLocs);
  const goneLocs = [...selected]
    .filter((loc) => !occupied.has(loc))
    .sort((a, b) => a.localeCompare(b));

  // A selected block is DRAWN whether or not the yard still holds it — see the header.
  const locs = [...new Set([...occupied, ...selected])];

  const map = buildYardMapCells({
    locs,
    bandOf: (loc) => {
      if (!selected.has(loc)) return BLEND_YARD_MAP_OTHER_BAND;
      const group = groupByLoc?.[loc];
      return group === undefined ? BLEND_YARD_MAP_SELECTED_BAND : group;
    },
    marked: (loc) => selected.has(loc) && !occupied.has(loc),
  });

  return { map, goneLocs };
}
