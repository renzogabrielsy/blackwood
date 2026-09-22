'use client';

// ─────────────────────────────────────────────────────────────────────────────
// THE YARD MAP PAGE — the block arrangement, in solid colour, on ONE landscape sheet.
//
// The owner, on the lens print: *"I'd like to see the actual block arrangement in our app
// to be printed in SOLID colors. This is purely for location reference, so make the block
// loc (C-19A, etc.) right in the middle and in BIG font so it can be fully seen in the
// print. Make sure it shows ALL blocks in one landscape page."*
//
// ── IT GETS ITS OWN PAGE, AND THAT WAS MEASURED, NOT PREFERRED ──────────────
// He offered page one *or* the next page. Page one already carries the title, the
// settings line, the band table and the ratio bar — and the band table's height is
// DATA: two bands on the price lens, up to seven, up to thirteen on the supplier lens.
// Measured on A4 landscape at a 10 mm margin (718.11 px of printable height): page one
// leaves roughly 518 px once a four-band table and the bar are in, which solves to a
// 35.8 px cell and an 8.2 pt loc with the standard warehouses alone, and a 26.4 px cell
// at 5.8 pt once PCA/PCB are in — under the print kit's 7 pt floor, and shrinking further
// every time the reader adds a cut line. On its OWN page the same solve gives **51.5 px
// / 11.5 pt** and **39.1 px / 9 pt**. A map whose legibility depends on how many bands
// the reader configured is the circularity `print-fit.ts`'s header warns about, so the
// map takes page two and the fit is a promise rather than a hope.
//
// ── ALL of it, or it says so ────────────────────────────────────────────────
// `fitCellGrid` (platform, `components/shared/print/print-fit.ts`) solves ONE square cell
// edge against BOTH budgets and the smaller wins, so nothing clips and nothing spills to
// a second sheet. The page is `break-inside: avoid`; if the solve ever fails (it cannot
// with today's geometry — the height floor is 20 px against a 39 px solution) the sheet
// SAYS so in its own caption rather than silently cropping the yard.
//
// ── THE FILLS ARE A **PRINT** PALETTE, NOT THE SCREEN RAMP (2026-09-22, 2nd pass) ──
// The owner, on the first live map: *"verify these are easy to read when printed on
// lower-quality printers. Use simple colours that contrast well from BLACK text — don't use
// dark colours that clash with black."* Painting the screen ramp SOLID put six of the
// fourteen ordinal hues and six of the thirteen categorical ones below the white/black
// contrast crossover, so the loc flipped to WHITE on about half the map — and white on deep
// fuchsia off a tired office laser is precisely the case he was asking about.
//
// So every cell and every legend swatch on this page reads `printFillRgbAtStop`
// (`lens-ramp.ts`): a white TINT of the same hue, worst case **7.75:1 against black**, so
// the ink is black on every fill the map can produce. The BAND TABLE on page one keeps the
// saturated `.lens-cat-N` class — a pale tint in an 8px table swatch reads as nothing — and
// the two are matchable because the tint preserves the hue angle to within 0.79°. The
// sequential ramps stay strictly monotonic in luminance (min adjacent gap 0.0751), so a
// GREYSCALE print still reads "dearer / older = darker"; the twelve categorical hues are
// deliberately flat at ≈ 0.70 and are told apart by the legend, the loc and the dashed
// mixed outline, because a supplier is not "more" than another supplier.
//
// ── WHAT IT DELIBERATELY DOES NOT CARRY ────────────────────────────────────
// No batch code, no balance, no ₱, no age, no supplier name, no lab reading. "Purely for
// location reference" is the whole specification: the loc is the only large text, which
// is both what he asked for and what leaves the cells big enough to read. Every figure
// about a band still lives on page one and in the per-band tables.
// ─────────────────────────────────────────────────────────────────────────────

import * as React from 'react';

import {
  a4LandscapeBox,
  fitCellGrid,
  fitMonoLabelPt,
  PX_PER_PT,
} from '@/components/shared/print/print-fit';

import { resolveBandRampStop, printFillRgbAtStop, type LensRampId } from './lens-ramp';
import {
  LENS_YARD_MAP_EMPTY_BG,
  LENS_YARD_MAP_EMPTY_INK,
  LENS_YARD_MAP_HAIRLINE,
  LENS_YARD_MAP_LINE_HEIGHT,
  LENS_YARD_MAP_MIN_LOC_PT,
  LENS_YARD_MAP_MUTED_BG,
  LENS_YARD_MAP_MUTED_INK,
  LENS_YARD_MAP_NODATA_MARK,
  LENS_YARD_MAP_NODATA_PT,
  lensYardMapInkOn,
  lensYardMapLines,
  lensYardMapPaint,
  type LensYardMap,
  type LensYardMapCell,
} from './lens-yard-map-model';

/** Only what the map needs of a band: which one, what it is called, what colour. */
export interface LensYardMapBand {
  index: number;
  label: string;
  /** Stated by a NOMINAL lens; omitted by an ordinal one. See `lens-ramp.ts`. */
  rampStop?: number;
}

// ── The page geometry ───────────────────────────────────────────────────────
//
// Every one of these is an input to the solve above, so they are constants in ONE place
// and the numbers the header quotes were measured with exactly these values.

/** Heading + legend + a little slack, in px. */
const RESERVED_PX = 40;
/** The row-letter column each section carries. */
const GUTTER_PX = 16;
/** A lane's warehouse label row. */
const LABEL_H_PX = 13;
/** A lane's column-number row. */
const COLHDR_H_PX = 9;
const LANE_CHROME_PX = LABEL_H_PX + COLHDR_H_PX;
const LANE_GAP_PX = 5;
/** Between PCA and PCB, which share a lane. */
const SECTION_GAP_PX = 8;
/** A cell's two 1px borders. There is no padding — the loc is flex-centred. */
const CELL_CHROME_PX = 2;
const MIN_CELL_PX = 20;
/** A ceiling, so a hypothetically tiny yard does not get comic cells. */
const MAX_CELL_PX = 64;
/**
 * DESCENDING, and coarse for the same reason the rest of the print kit's ladders are.
 * 7 pt is the floor the whole kit keeps.
 */
const FONT_LADDER_PT = [13, 12, 11.5, 11, 10.5, 10, 9.5, 9, 8.5, 8, 7.5, 7] as const;
/**
 * The advance width of one glyph, as a fraction of the font size — the one MEASURED
 * input `print-fit.ts` cannot derive (Node has no font engine).
 *
 * ⚠️ **0.65, not RC Movement's 0.6, and the difference is a BUG THIS PAGE ALREADY HAD.**
 * A map cell's loc is `font-bold`, and the bold face is WIDER than the regular one: over
 * a 100-character run of `A-10A` in a real browser on this page, regular measured
 * **0.6039** and bold **0.6298**. Budgeted at 0.6 the five-character locs (`A-10A`,
 * `B-10A`, `D-10A`) overflowed their cell and the browser silently wrapped them mid-code,
 * which is visible in the very first PDF this page produced. 0.65 is the measured bold
 * figure rounded up, so the budget has real headroom rather than 1.2 px of luck.
 */
const MONO_ADVANCE_EM = 0.65;

export interface LensYardMapPageProps {
  map: LensYardMap;
  ramp: LensRampId;
  /** The bands the sheet is SHOWING, in the payload's order. */
  bands: readonly LensYardMapBand[];
  /** How many bands the yard has, for the ordinal stop arithmetic. */
  bandCount: number;
  /** The lens's own name — `Price lens` / `Age lens` / `Supplier lens`. */
  lensTitle: string;
  /** Must be the margin the sheet's own `@page` rule uses. */
  marginMm: number;
}

/** A swatch in the legend: the SAME solid fill the cells carry, never a class. */
function LegendSwatch({ bg, border }: { bg: string; border?: string }) {
  return (
    <span
      aria-hidden
      className="inline-block h-[7px] w-[7px] shrink-0 rounded-[1px]"
      style={{ backgroundColor: bg, border: `1px solid ${border ?? LENS_YARD_MAP_HAIRLINE}` }}
    />
  );
}

function MapCell({
  cell,
  ramp,
  stopByVisibleBand,
  cellPx,
  fontPt,
  wrapAll,
  sectionKey,
}: {
  cell: LensYardMapCell;
  ramp: LensRampId;
  stopByVisibleBand: ReadonlyMap<number, number>;
  cellPx: number;
  fontPt: number;
  /** The page decided to wrap EVERY loc rather than shrink it. See the solve below. */
  wrapAll: boolean;
  sectionKey: string;
}) {
  const paint = lensYardMapPaint(cell, ramp, stopByVisibleBand);
  const lines = wrapAll ? lensYardMapLines(sectionKey, cell.loc, true) : cell.lines;
  // An EMPTY slot's loc is deliberately smaller: it is still a location reference, but a
  // slot with nothing in it must not read as loudly as a pile.
  const pt = paint.kind === 'empty' ? Math.min(fontPt, 7.5) : fontPt;
  return (
    <div
      className="flex flex-col items-center justify-center overflow-hidden text-center font-mono font-bold leading-none"
      style={{
        width: cellPx,
        height: cellPx,
        boxSizing: 'border-box',
        border: `1px solid ${LENS_YARD_MAP_HAIRLINE}`,
        backgroundColor: paint.bg,
        color: paint.ink,
        fontSize: `${pt}pt`,
        fontWeight: paint.kind === 'empty' ? 400 : 700,
        // The MIXED marker, inset so it cannot read as a selection ring. Same shape and
        // same offset as `.lens-cat-mixed` on the grid.
        ...(paint.outline ? { outline: `1px dashed ${paint.outline}`, outlineOffset: '-2px' } : null),
      }}
    >
      {lines.map((line) => (
        <span key={line}>{line}</span>
      ))}
      {paint.kind === 'nodata' && (
        <span
          className="font-sans font-normal"
          style={{ fontSize: `${LENS_YARD_MAP_NODATA_PT}pt` }}
        >
          {LENS_YARD_MAP_NODATA_MARK}
        </span>
      )}
    </div>
  );
}

export function LensYardMapPage({
  map,
  ramp,
  bands,
  bandCount,
  lensTitle,
  marginMm,
}: LensYardMapPageProps) {
  // ── The colour lookup: ONLY the bands on the sheet ────────────────────────
  // Isolation is applied HERE, by omission — a band the reader hid is simply absent, so
  // its cells fall to the same grey the band tables' "Showing 2 of 4 bands" line implies.
  const stopByVisibleBand = new Map<number, number>();
  for (const b of bands) {
    stopByVisibleBand.set(b.index, resolveBandRampStop(ramp, b.index, bandCount, b.rampStop));
  }

  const fit = fitCellGrid({
    sections: map.sections.map((s) => ({
      key: s.key,
      cols: s.cols.length,
      rows: s.rows.length,
      lane: s.lane,
    })),
    box: a4LandscapeBox(marginMm),
    reservedHeightPx: RESERVED_PX,
    gutterPx: GUTTER_PX,
    laneChromePx: LANE_CHROME_PX,
    laneGapPx: LANE_GAP_PX,
    sectionGapPx: SECTION_GAP_PX,
    cellChromePx: CELL_CHROME_PX,
    minCellPx: MIN_CELL_PX,
    maxCellPx: MAX_CELL_PX,
    labelChars: map.labelChars,
    advanceEm: MONO_ADVANCE_EM,
    fontLadderPt: FONT_LADDER_PT,
  });

  // ── STAGE TWO: WRAP RATHER THAN SHRINK ───────────────────────────────────
  // The cell EDGE is fixed by the page, not by the label, so a label that does not fit
  // has exactly two outcomes: a smaller font, or two lines. Measured on A4 landscape at
  // 10 mm with PCA/PCB in (39.14 px cells): one line solves to **8.5 pt**, two lines to
  // **10 pt** — so wrapping makes the loc BIGGER. The height budget subtracts the
  // `nodata` dash, because that cell must hold three lines without clipping any of them
  // and sizing only the common case is how the one cell that carries a warning loses it.
  const dashPx = LENS_YARD_MAP_NODATA_PT * PX_PER_PT;
  const maxPtForLines = (n: number) =>
    (fit.labelBoxPx - dashPx) / n / (PX_PER_PT * LENS_YARD_MAP_LINE_HEIGHT);
  const onePt = fitMonoLabelPt({
    widthPx: fit.labelBoxPx,
    chars: map.labelChars,
    advanceEm: MONO_ADVANCE_EM,
    ladder: FONT_LADDER_PT,
    maxPt: maxPtForLines(1),
  });
  const wrapAll = onePt < LENS_YARD_MAP_MIN_LOC_PT;
  const fontPt = wrapAll
    ? fitMonoLabelPt({
        widthPx: fit.labelBoxPx,
        chars: map.wrappedLabelChars,
        advanceEm: MONO_ADVANCE_EM,
        ladder: FONT_LADDER_PT,
        maxPt: maxPtForLines(2),
      })
    : onePt;

  const lanes = [...new Set(map.sections.map((s) => s.lane))].sort((a, b) => a - b);
  const isolated = bands.length < bandCount;

  return (
    <div className="lens-print-yardmap">
      <h2 className="flex items-baseline gap-1.5 border-b border-zinc-400 pb-[1px] text-[11px] font-bold uppercase text-zinc-900">
        Yard map
        <span className="font-mono text-[9px] font-normal normal-case text-zinc-600">
          {lensTitle} · {map.occupiedCount} of {map.slotCount} slots occupied · location
          reference only
        </span>
      </h2>

      <div style={{ width: fit.totalWidthPx }}>
        {lanes.map((lane, laneIdx) => (
          <div
            key={lane}
            className="flex items-start"
            style={{ gap: SECTION_GAP_PX, marginTop: laneIdx === 0 ? 0 : LANE_GAP_PX }}
          >
            {map.sections
              .filter((s) => s.lane === lane)
              .map((s) => (
                <div key={s.key}>
                  <div
                    className="font-semibold uppercase tracking-wide text-zinc-600"
                    style={{ height: LABEL_H_PX, fontSize: '7pt', lineHeight: `${LABEL_H_PX}px` }}
                  >
                    {s.label}
                  </div>
                  <div
                    className="grid"
                    style={{
                      gridTemplateColumns: `${GUTTER_PX}px repeat(${s.cols.length}, ${fit.cellPx}px)`,
                      gridTemplateRows: `${COLHDR_H_PX}px repeat(${s.rows.length}, ${fit.cellPx}px)`,
                    }}
                  >
                    {/* The corner, above the row letters. */}
                    <div />
                    {s.cols.map((col) => (
                      <div
                        key={col}
                        className="flex items-end justify-center font-mono text-zinc-500"
                        style={{ fontSize: '5.5pt', lineHeight: 1 }}
                      >
                        {col}
                      </div>
                    ))}
                    {s.rows.map((row, ri) => (
                      <React.Fragment key={row}>
                        <div
                          className="flex items-center justify-center font-mono font-semibold text-zinc-500"
                          style={{ fontSize: '6.5pt' }}
                        >
                          {row}
                        </div>
                        {s.cells[ri].map((cell) => (
                          <MapCell
                            key={cell.loc}
                            cell={cell}
                            ramp={ramp}
                            stopByVisibleBand={stopByVisibleBand}
                            cellPx={fit.cellPx}
                            fontPt={fontPt}
                            wrapAll={wrapAll}
                            sectionKey={s.key}
                          />
                        ))}
                      </React.Fragment>
                    ))}
                  </div>
                </div>
              ))}
          </div>
        ))}
      </div>

      {/* ── ONE legend line: every band on the sheet, then the two non-band fills ── */}
      <p className="mt-[3px] flex flex-wrap items-center gap-x-2 gap-y-[1px] text-[7.5px] text-zinc-700">
        {bands.map((b) => {
          // THE SAME FILL THE CELLS CARRY, read through the same PRINT accessor — a legend
          // swatch in the screen saturation beside a pale cell is a legend that describes a
          // different map.
          const rgb = printFillRgbAtStop(
            ramp,
            resolveBandRampStop(ramp, b.index, bandCount, b.rampStop),
          );
          return (
            <span key={b.index} className="inline-flex items-center gap-1">
              <LegendSwatch bg={`rgb(${rgb})`} border={lensYardMapInkOn(rgb)} />
              {b.label}
            </span>
          );
        })}
        {isolated && (
          <span className="inline-flex items-center gap-1">
            <LegendSwatch bg={LENS_YARD_MAP_MUTED_BG} border={LENS_YARD_MAP_MUTED_INK} />
            other bands (not shown)
          </span>
        )}
        <span className="inline-flex items-center gap-1">
          <LegendSwatch bg={LENS_YARD_MAP_MUTED_BG} border={LENS_YARD_MAP_MUTED_INK} />
          {LENS_YARD_MAP_NODATA_MARK} no data ({map.nodataCount})
        </span>
        <span className="inline-flex items-center gap-1">
          <LegendSwatch bg={LENS_YARD_MAP_EMPTY_BG} border={LENS_YARD_MAP_EMPTY_INK} />
          empty slot
        </span>
        {map.sections.some((s) => s.key.length > 1) && (
          <span className="text-zinc-500">PCA/PCB shown because the yard has stock in them</span>
        )}
      </p>

      {/* Two things the map cannot draw, said rather than hidden. */}
      {map.offMapLocs.length > 0 && (
        <p className="mt-[1px] text-[7.5px] text-zinc-600">
          Not on the map ({map.offMapLocs.length}): {map.offMapLocs.join(' · ')} — the block
          code is not a slot on this warehouse layout.
        </p>
      )}
      {!fit.fits && (
        <p className="mt-[1px] text-[7.5px] font-semibold text-zinc-900">
          The yard does not fit this sheet at a legible size — {map.slotCount} slots over{' '}
          {fit.cellRowCount} rows. Print the per-band tables for the full list.
        </p>
      )}
    </div>
  );
}
