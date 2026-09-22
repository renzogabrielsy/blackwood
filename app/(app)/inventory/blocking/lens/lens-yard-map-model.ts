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

import { WAREHOUSES } from '../constants';
import type { BlockData } from '../types';
import { rampRgbAtStop, type LensRampId } from './lens-ramp';

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
 * ⚠️ THE LUMINANCE RULE, WRITTEN ONCE AND NOWHERE ELSE.
 *
 * A band's fill on paper is SOLID (this is a print, not the grid's 22% wash), and the
 * twelve categorical hues alone span emerald through deep fuchsia — so a hardcoded text
 * colour is illegible on roughly half of them. The ink is therefore CHOSEN from the
 * fill's own WCAG relative luminance.
 *
 * The threshold is not a taste value: `sqrt(1.05 × 0.05) − 0.05 ≈ 0.1791` is the exact
 * luminance at which white-on-fill and black-on-fill have the SAME contrast ratio, so
 * picking the side of it with more contrast is, by construction, the better of the two.
 * Above it near-black wins (measured: emerald 0.411, yellow 0.498, sky 0.492, teal 0.372,
 * zinc 0.360, orange 0.324, pink 0.248, red 0.229); below it white does (rose 0.173,
 * fuchsia 0.173, blue 0.153, violet 0.134, indigo 0.117, deep fuchsia 0.116).
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

  const keys = Object.keys(WAREHOUSES);
  const hasBlockIn = (key: string): boolean => {
    const prefix = `${key}-`;
    for (const loc of Object.keys(data)) if (loc.startsWith(prefix)) return true;
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
        const block = data[loc];
        const occupied = block !== undefined;
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
          mixed: block !== undefined && isMixed !== undefined ? isMixed(loc, block) : false,
        } satisfies LensYardMapCell;
      }),
    );
    sections.push({ key, label: sectionLabel(key), lane, cols, rows: whse.rows, cells });
  };

  standard.forEach((key, i) => push(key, i));
  for (const key of optional) push(key, standard.length);

  const offMapLocs = Object.keys(data)
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
 * **The fill is the ramp's own triple at FULL opacity.** On screen a band is a 22% wash
 * over the cell's own surface, which is right for a screen carrying a batch code, a
 * balance and a price; here the cell carries a loc and nothing else and the owner asked
 * for SOLID colour. `rampRgbAtStop` is still the only place a triple is read, so the
 * map, the band table's swatch and the grid are the same colour by construction.
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
  const rgb = rampRgbAtStop(ramp, stop);
  const ink = lensYardMapInkOn(rgb);
  return { kind: 'banded', bg: `rgb(${rgb})`, ink, outline: cell.mixed ? ink : null };
}
