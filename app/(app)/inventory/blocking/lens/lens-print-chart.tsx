'use client';

// ─────────────────────────────────────────────────────────────────────────────
// A CHART FOR PAPER — fixed size, no animation, no measurement, no theme token.
//
// The owner, on the barren first page of both lens prints: *"maybe a deliveries price
// for the year — an indication of what the market price is"* (price lens) and *"utilize
// the existing price-to-volume graph / area graph"* (supplier lens). Both are a series
// over months; both have to survive a `window.print()` that happens on the very frame
// after the offstage stage lays out.
//
// ── ⚠️ WHY THIS IS HAND-DRAWN SVG AND NOT RECHARTS ──────────────────────────
// `/analytics`' `supplier-expand.tsx` and `metric-expand.tsx` draw exactly this shape
// with recharts, and reusing them was the first idea. Three properties of THIS surface
// rule it out, and each one is a defect rather than a preference:
//
//   1. **RECHARTS MEASURES, AND THIS SHEET DOES NOT WAIT.** Both analytics charts are
//      `<ResponsiveContainer>`, which sizes itself from a ResizeObserver callback — i.e.
//      one frame LATER. `printCard` marks the card and calls `window.print()` as soon as
//      the stage has laid out, so a container that has not measured yet prints an empty
//      box. (Explicit `width`/`height` props would dodge that, which leaves 2 and 3.)
//   2. **ITS COLOURS ARE THEME TOKENS.** Every series there is `var(--chart-2)` /
//      `var(--border)`, and this sheet is laid out in the LIVE DOM — so a dark-mode
//      reader would print a dark chart onto white paper. The whole sheet is explicit
//      light ink for that exact reason, and the printed yard map's palette pass
//      (2026-09-22) was a whole migration about print contrast.
//   3. **IT WOULD PUT RECHARTS IN THE BLOCKING BUNDLE** for a print-only, twelve-point
//      series. The Blocking page imports none of it today.
//
// So this follows the printed YARD MAP's own precedent: hand-drawn geometry, explicit
// hex fills, `print-color-adjust: exact`, and a size the caller states in pixels.
//
// ── IT COMPUTES NO STATISTIC, AND IT FORMATS NOTHING ────────────────────────
// Every value is a number the payload published and every label is a string the caller
// already formatted. What happens here is SCALING — a value to a y coordinate — which is
// geometry, not arithmetic about charcoal. There is no sum, no average, no share and no
// currency glyph in this file, and the domains are handed in rather than derived.
//
// ── A GAP IS A GAP ──────────────────────────────────────────────────────────
// A `null` breaks the line and the area rather than drawing across it, the way
// `connectNulls={false}` does on the analytics charts. NULL IS NEVER 0 here either: a
// month with no priced kilos has no price, and joining across it would draw a trend
// through a month nobody measured.
// ─────────────────────────────────────────────────────────────────────────────

import * as React from 'react';

/** Explicit, print-safe ink. No theme token may appear in this file. */
export const PRINT_CHART_INK = {
  /** The plot frame and the horizontal guides. */
  grid: '#d4d4d8',
  /** Axis numbers and month ticks. */
  axis: '#52525b',
  /** The AREA series (volume): a pale fill a laser can hold, with a legible edge. */
  areaFill: '#dbeafe',
  areaStroke: '#3b82f6',
  /** The LINE series (price): dark enough to read in greyscale beside the pale area. */
  line: '#b45309',
  /** The reference line — near-black dashed, so it reads as "the level", not a series. */
  ref: '#18181b',
} as const;

/**
 * THE ONE LABEL SIZE ON A PRINTED CHART — its axis numbers, its reference level and its
 * month ticks, in SVG user units (= px at this scale).
 *
 * ⚠️ **IT IS THE SHEET'S LEGIBILITY FLOOR, NOT A FREE DIAL.** The first pass drew the axis
 * numbers at 6 and the month ticks at 5.5, which is roughly 4pt on paper — below anything
 * the rest of this sheet uses and below the print kit's stated 7pt floor. Both moved up to
 * the floor and the two horizontal pads widened to hold a label at the new size (measured:
 * `₱48.50` and `14,145t` are the widest strings either axis can produce).
 *
 * One constant rather than four literals, so a reader cannot shrink one axis and leave the
 * others behind — and so `scripts/verify-blocking-lens-ui.ts` has one thing to pin.
 */
export const LENS_PRINT_CHART_LABEL_PX = 7;

export interface PrintChartPoint {
  /** The x-axis tick, preformatted. An empty string draws no tick for this slot. */
  tick: string;
  /** The LINE value, or null for a genuine gap. */
  line: number | null;
  /** The AREA value, or null. Omit the key entirely on a line-only chart. */
  area?: number | null;
}

export interface PrintChartAxisTick {
  value: number;
  /** Preformatted — this file never turns a number into a string. */
  label: string;
}

export interface PrintChartRefLine {
  value: number;
  /** Preformatted. Drawn at the right-hand end of the line. */
  label: string;
}

export interface PrintSeriesChartProps {
  widthPx: number;
  heightPx: number;
  points: readonly PrintChartPoint[];
  /** `[min, max]` for the LINE series. Handed in, never derived here. */
  lineDomain: readonly [number, number];
  /** `[min, max]` for the AREA series. Omit for a line-only chart. */
  areaDomain?: readonly [number, number] | null;
  /** Guides + numbers for the axis the LINE is on. */
  lineTicks?: readonly PrintChartAxisTick[];
  /** Numbers for the AREA's own axis (left) — no guides, so the two do not cross-hatch. */
  areaTicks?: readonly PrintChartAxisTick[];
  refLine?: PrintChartRefLine | null;
  /** What a screen reader and a `pdftotext` reader get. Preformatted. */
  ariaLabel: string;
  /** Room for the axis numbers. An area chart needs both sides. */
  padLeftPx?: number;
  padRightPx?: number;
}

/** A contiguous run of defined points — what makes a gap a gap. */
interface Run {
  xs: number[];
  ys: number[];
}

/**
 * Split the series into contiguous runs of DEFINED points.
 *
 * Written with `entries()` rather than an index loop on purpose: `verify-blocking-lens-ui.ts`
 * bans `+=` outright in every lens file, and that blanket ban is worth more than the
 * convenience of `i += 1` — a rule with an exception for "loop counters" is a rule somebody
 * eventually accumulates a kilogram under.
 */
function runsOf(
  points: readonly PrintChartPoint[],
  pick: (p: PrintChartPoint) => number | null | undefined,
  x: (i: number) => number,
  y: (v: number) => number,
): Run[] {
  const runs: Run[] = [];
  let current: Run | null = null;
  for (const [i, p] of points.entries()) {
    const v = pick(p);
    if (v === null || v === undefined || !Number.isFinite(v)) {
      current = null;
      continue;
    }
    if (current === null) {
      current = { xs: [], ys: [] };
      runs.push(current);
    }
    current.xs.push(x(i));
    current.ys.push(y(v));
  }
  return runs;
}

function pointsAttr(run: Run): string {
  return run.xs.map((cx, i) => `${cx.toFixed(1)},${run.ys[i].toFixed(1)}`).join(' ');
}

/**
 * ONE chart shape, two uses: a bare line (the market series) and an area-plus-line (the
 * price-to-volume panels). The second series is present iff `areaDomain` is.
 */
export function PrintSeriesChart({
  widthPx,
  heightPx,
  points,
  lineDomain,
  areaDomain = null,
  lineTicks = [],
  areaTicks = [],
  refLine = null,
  ariaLabel,
  padLeftPx,
  padRightPx,
}: PrintSeriesChartProps) {
  const padTop = 6;
  const padBottom = 13;
  const padLeft = padLeftPx ?? (areaDomain ? 34 : 6);
  const padRight = padRightPx ?? 36;

  const plotW = widthPx - padLeft - padRight;
  const plotH = heightPx - padTop - padBottom;

  const n = points.length;
  // A single point sits in the middle rather than on the left edge; two or more span the
  // plot. `n - 1` is never a division by zero because of the guard.
  const x = (i: number) => (n <= 1 ? padLeft + plotW / 2 : padLeft + (plotW * i) / (n - 1));

  const scale = (v: number, domain: readonly [number, number]) => {
    const span = domain[1] - domain[0];
    // A flat series draws down the middle rather than on an edge — a zero span is a real
    // answer (twelve identical prices), not an error.
    if (!Number.isFinite(span) || span <= 0) return padTop + plotH / 2;
    return padTop + plotH - (plotH * (v - domain[0])) / span;
  };
  const yLine = (v: number) => scale(v, lineDomain);
  const yArea = (v: number) => scale(v, areaDomain ?? lineDomain);

  const lineRuns = runsOf(points, (p) => p.line, x, yLine);
  const areaRuns = areaDomain ? runsOf(points, (p) => p.area, x, yArea) : [];
  const baselineY = padTop + plotH;

  return (
    <svg
      width={widthPx}
      height={heightPx}
      viewBox={`0 0 ${widthPx} ${heightPx}`}
      role="img"
      aria-label={ariaLabel}
      // A chart on paper must keep its ink. The same declaration the printed yard map's
      // cells rely on, stated on the element that carries the colour.
      style={{ printColorAdjust: 'exact', WebkitPrintColorAdjust: 'exact' } as React.CSSProperties}
    >
      {/* ── The guides, on the LINE's axis only ─────────────────────────────
          One set of horizontals. A second set for the area would cross-hatch the plot
          and make neither readable. */}
      {lineTicks.map((t) => {
        const ty = yLine(t.value);
        return (
          <g key={`g${t.value}`}>
            <line
              x1={padLeft}
              x2={padLeft + plotW}
              y1={ty}
              y2={ty}
              stroke={PRINT_CHART_INK.grid}
              strokeWidth={0.5}
            />
            <text
              x={padLeft + plotW + 3}
              y={ty + 2.5}
              fill={PRINT_CHART_INK.axis}
              fontSize={LENS_PRINT_CHART_LABEL_PX}
              fontFamily="ui-monospace, monospace"
            >
              {t.label}
            </text>
          </g>
        );
      })}

      {/* The AREA's own numbers, on the left, with no guides of their own. */}
      {areaTicks.map((t) => (
        <text
          key={`a${t.value}`}
          x={padLeft - 3}
          y={yArea(t.value) + 2.5}
          fill={PRINT_CHART_INK.axis}
          fontSize={LENS_PRINT_CHART_LABEL_PX}
          textAnchor="end"
          fontFamily="ui-monospace, monospace"
        >
          {t.label}
        </text>
      ))}

      {/* The baseline. */}
      <line
        x1={padLeft}
        x2={padLeft + plotW}
        y1={baselineY}
        y2={baselineY}
        stroke={PRINT_CHART_INK.axis}
        strokeWidth={0.6}
      />

      {/* ── The AREA (volume) ──────────────────────────────────────────────
          One polygon per contiguous run, closed to the baseline, so a month with no
          figure leaves a hole rather than a fabricated slope. */}
      {areaRuns.map((run, i) => (
        <polygon
          key={`ar${i}`}
          points={`${run.xs[0].toFixed(1)},${baselineY.toFixed(1)} ${pointsAttr(run)} ${run.xs[
            run.xs.length - 1
          ].toFixed(1)},${baselineY.toFixed(1)}`}
          fill={PRINT_CHART_INK.areaFill}
          stroke={PRINT_CHART_INK.areaStroke}
          strokeWidth={0.7}
        />
      ))}

      {/* ── THE REFERENCE LINE — the level the series is being judged against ── */}
      {refLine !== null && (
        <g>
          <line
            x1={padLeft}
            x2={padLeft + plotW}
            y1={yLine(refLine.value)}
            y2={yLine(refLine.value)}
            stroke={PRINT_CHART_INK.ref}
            strokeWidth={0.8}
            strokeDasharray="3 2"
          />
          <text
            x={padLeft + plotW - 1}
            y={yLine(refLine.value) - 2.5}
            fill={PRINT_CHART_INK.ref}
            fontSize={LENS_PRINT_CHART_LABEL_PX}
            fontWeight={700}
            textAnchor="end"
            fontFamily="ui-monospace, monospace"
          >
            {refLine.label}
          </text>
        </g>
      )}

      {/* ── The LINE (price) ───────────────────────────────────────────────── */}
      {lineRuns.map((run, i) => (
        <polyline
          key={`ln${i}`}
          points={pointsAttr(run)}
          fill="none"
          stroke={PRINT_CHART_INK.line}
          strokeWidth={1.2}
          strokeLinejoin="round"
        />
      ))}
      {lineRuns.map((run, ri) =>
        run.xs.map((cx, i) => (
          <circle
            key={`d${ri}-${i}`}
            cx={cx}
            cy={run.ys[i]}
            r={1.2}
            fill={PRINT_CHART_INK.line}
          />
        )),
      )}

      {/* ── The month ticks ────────────────────────────────────────────────── */}
      {points.map((p, i) =>
        p.tick === '' ? null : (
          <text
            key={`t${i}-${p.tick}`}
            x={x(i)}
            y={heightPx - 3}
            fill={PRINT_CHART_INK.axis}
            fontSize={LENS_PRINT_CHART_LABEL_PX}
            textAnchor="middle"
            fontFamily="ui-monospace, monospace"
          >
            {p.tick}
          </text>
        ),
      )}
    </svg>
  );
}

/** One entry of a printed chart's legend: the ink, and what it means. */
export interface PrintChartLegendEntry {
  /** A fill from `PRINT_CHART_INK`, or the dashed reference marker. */
  kind: 'area' | 'line' | 'ref';
  label: string;
}

/** The legend, in the sheet's own 7.5px light ink. Drawn beside a chart, never inside it. */
export function PrintChartLegend({ entries }: { entries: readonly PrintChartLegendEntry[] }) {
  return (
    <p className="mt-[1px] flex flex-wrap items-center gap-x-2 gap-y-[1px] text-[7.5px] text-zinc-700">
      {entries.map((e) => (
        <span key={`${e.kind}-${e.label}`} className="inline-flex items-center gap-1">
          {e.kind === 'line' && (
            <span
              aria-hidden
              className="inline-block h-[2px] w-[9px] shrink-0"
              style={{
                backgroundColor: PRINT_CHART_INK.line,
                printColorAdjust: 'exact',
              } as React.CSSProperties}
            />
          )}
          {e.kind === 'area' && (
            <span
              aria-hidden
              className="inline-block h-[7px] w-[9px] shrink-0"
              style={{
                backgroundColor: PRINT_CHART_INK.areaFill,
                border: `1px solid ${PRINT_CHART_INK.areaStroke}`,
                printColorAdjust: 'exact',
              } as React.CSSProperties}
            />
          )}
          {e.kind === 'ref' && (
            <span
              aria-hidden
              className="inline-block h-0 w-[9px] shrink-0"
              style={{
                borderTop: `1px dashed ${PRINT_CHART_INK.ref}`,
                printColorAdjust: 'exact',
              } as React.CSSProperties}
            />
          )}
          {e.label}
        </span>
      ))}
    </p>
  );
}
