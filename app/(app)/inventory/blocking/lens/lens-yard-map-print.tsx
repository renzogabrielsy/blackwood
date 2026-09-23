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

import { resolveBandRampStop, printFillRgbAtStop, type LensRampId } from './lens-ramp';
import {
  LENS_YARD_MAP_EMPTY_BG,
  LENS_YARD_MAP_EMPTY_INK,
  LENS_YARD_MAP_HAIRLINE,
  LENS_YARD_MAP_MUTED_BG,
  LENS_YARD_MAP_MUTED_INK,
  LENS_YARD_MAP_NODATA_MARK,
  LENS_YARD_MAP_NODATA_PT,
  YARD_MAP_COLHDR_H_PX,
  YARD_MAP_GUTTER_PX,
  YARD_MAP_LABEL_H_PX,
  YARD_MAP_LANE_GAP_PX,
  YARD_MAP_SECTION_GAP_PX,
  lensYardMapInkOn,
  lensYardMapLines,
  lensYardMapPaint,
  solveYardMapFit,
  type LensYardMap,
  type LensYardMapBand,
  type LensYardMapCell,
} from './lens-yard-map-model';

// ── The page geometry and the fit live in the MODEL ─────────────────────────
//
// Both were HERE until 2026-09-23, when the blend proposal print grew the same map
// through a non-React path and could not import a component. They moved beside the
// geometry they measure (`solveYardMapFit`, `YARD_MAP_*`) so there is exactly one
// statement of how big a cell is — nothing about the inputs changed, so this page lays
// out identically.

export type { LensYardMapBand };

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

  // ONE solve, shared with the blend proposal print. See `solveYardMapFit`.
  const { cells: fit, fontPt, wrapAll } = solveYardMapFit(map, marginMm);

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
            style={{ gap: YARD_MAP_SECTION_GAP_PX, marginTop: laneIdx === 0 ? 0 : YARD_MAP_LANE_GAP_PX }}
          >
            {map.sections
              .filter((s) => s.lane === lane)
              .map((s) => (
                <div key={s.key}>
                  <div
                    className="font-semibold uppercase tracking-wide text-zinc-600"
                    style={{ height: YARD_MAP_LABEL_H_PX, fontSize: '7pt', lineHeight: `${YARD_MAP_LABEL_H_PX}px` }}
                  >
                    {s.label}
                  </div>
                  <div
                    className="grid"
                    style={{
                      gridTemplateColumns: `${YARD_MAP_GUTTER_PX}px repeat(${s.cols.length}, ${fit.cellPx}px)`,
                      gridTemplateRows: `${YARD_MAP_COLHDR_H_PX}px repeat(${s.rows.length}, ${fit.cellPx}px)`,
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
