// ─────────────────────────────────────────────────────────────────────────────
// THE BLEND PRINT'S PAGE-ONE MARKET CHART — model, geometry and the HTML/SVG sheet.
//
// The owner, on the empty lower half of the blend proposal print's first page:
//   *"add a main chart below what is currently on it, showing: avg RC fed price (not
//   actual price) the past 12 months — blue line; avg RC deliveries price past 12 months
//   — orange line; avg RC fed volume past 12 months — purple area; avg RC deliveries
//   volume past 12 months — green area."*
//
// ONE model, ONE geometry, THREE thin renderers: the HTML iframe printout draws the SVG
// string built here, the jsPDF file (`blend-proposal-pdf.ts`) walks the SAME layout with
// its own primitives, and the ON-SCREEN dialog (`blend-market-chart-screen.tsx`, added
// 2026-09-26) renders the SAME layout as a React SVG in theme tokens — so the three cannot
// draw different charts. Each text item carries a `role` so the screen can re-ink it by
// meaning (axis tick, unit, month, …) while the print keeps its explicit colour; the role
// never reaches the printed SVG string, which stays byte-identical.
//
// ── ⚠️ IT COMPUTES NO STATISTIC ─────────────────────────────────────────────
// Every price and kilogram is a field of `fetchBlendMarketHistory`, which reads them
// verbatim from `view_analytics_cost_monthly` (fed) and `view_analytics_rcin_monthly`
// (market deliveries). What happens here is (a) FORMATTING, (b) a kg → tonne UNIT change
// for the volume axis, and (c) AXIS GEOMETRY — a min/max over published values to pick a
// domain, and scaling a value to a coordinate. There is no sum, no average and no
// re-weighting in this file (CLAUDE.md: never calculate weighted averages in TypeScript),
// and `scripts/verify-blend-market-chart.ts` greps for them.
//
// ── NULL IS NEVER 0 ─────────────────────────────────────────────────────────
// A month a view has no row for, or a NULL the view published, BREAKS the line and the
// area. Joining across it would draw a trend through a month nobody measured.
//
// ── PRICE GATE ──────────────────────────────────────────────────────────────
// The server nulls both ₱ series for a `!canViewPrices()` reader. The chart then drops
// the price series, the price axis, the price legend entries and the blend reference
// line, and draws the two volume areas on ONE axis (left). `showPrices` here is the
// EFFECTIVE flag (server gate AND the Prices display toggle) — hide-only.
//
// ── EXPLICIT PRINT INK ──────────────────────────────────────────────────────
// No theme token: the iframe has no stylesheet and a dark-mode reader must still print a
// light chart. Text is zinc-900 / zinc-700 on white (≥ 10:1); the areas are 22%-opacity
// tints with a darker edge, so overlap stays readable and a mono printer still sees the
// edges; the lines are the 700 shades of blue / orange.
//
// PURE: no React, no fetch, no server action — imported by the dialog, the jsPDF builder
// and the verify script alike.
// ─────────────────────────────────────────────────────────────────────────────

import type { BlendMarketHistory } from '../blocking/types';
import { escapeHtml } from './print-utils';

const PESO = '₱';
const EMDASH = '—';
const MIDDOT = '·';

/** Explicit, print-safe ink. The owner's four colours, as print-light tints with dark edges. */
export const BLEND_MARKET_INK = {
  text: '#18181b',
  axis: '#3f3f46',
  grid: '#d4d4d8',
  /** Blue line — avg RC FED price. */
  fedPrice: '#1d4ed8',
  /** Orange line — avg RC DELIVERIES price. */
  deliveredPrice: '#c2410c',
  /** Purple area — RC FED volume. */
  fedVolumeFill: '#a855f7',
  fedVolumeStroke: '#7e22ce',
  /** Green area — RC DELIVERIES volume. */
  deliveredVolumeFill: '#22c55e',
  deliveredVolumeStroke: '#15803d',
  /** The blend's own raw ₱/kg — near-black dashed, "the level", not a series. */
  ref: '#18181b',
} as const;

/** The areas' fill opacity: pale enough that the two overlap legibly under the lines. */
export const BLEND_MARKET_AREA_OPACITY = 0.22;

export type BlendMarketSeriesId = 'fedPrice' | 'deliveredPrice' | 'fedVolume' | 'deliveredVolume';

export interface BlendMarketSeries {
  id: BlendMarketSeriesId;
  label: string;
  /** One value per month slot. Prices in ₱/kg, volumes in TONNES. NULL = gap. */
  values: (number | null)[];
  stroke: string;
  /** Areas only. */
  fill?: string;
}

export interface BlendMarketAxisTick {
  value: number;
  label: string;
}

export interface BlendMarketAxis {
  domain: [number, number];
  ticks: BlendMarketAxisTick[];
  /** `₱/kg` or `t / month`. */
  unit: string;
}

export interface BlendMarketLegendEntry {
  kind: 'line' | 'area' | 'ref';
  label: string;
  stroke: string;
  fill?: string;
}

export interface BlendMarketChartModel {
  title: string;
  /** `Oct 2025 – Sep 2026`. */
  range: string;
  /** The definitions, one line. */
  subtitle: string;
  /** `Oct '25` … one per slot. */
  ticks: string[];
  /** `Oct 2025` … one per slot — the on-screen tooltip's heading. */
  monthLabels: string[];
  /** Per slot: the current, still-growing month. */
  partial: boolean[];
  /** Drawn in this order, BEHIND the lines. Deliveries first so fed sits on top. */
  areas: BlendMarketSeries[];
  /** Empty for a price-denied reader. */
  lines: BlendMarketSeries[];
  /** Left axis: ₱/kg for a price viewer, tonnes for everyone else. */
  leftAxis: BlendMarketAxis;
  /** Right axis: tonnes for a price viewer; null → ONE axis. */
  rightAxis: BlendMarketAxis | null;
  refLine: { value: number; label: string } | null;
  legend: BlendMarketLegendEntry[];
  footnotes: string[];
  ariaLabel: string;
  showPrices: boolean;
}

// ── Formatters ──────────────────────────────────────────────────────────────

function monthDate(iso: string): { y: number; m: number } {
  return { y: Number(iso.slice(0, 4)), m: Number(iso.slice(5, 7)) };
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** `Oct '25`. */
export function blendMarketTick(iso: string): string {
  const { y, m } = monthDate(iso);
  return `${MONTHS[m - 1]} '${String(y % 100).padStart(2, '0')}`;
}

/** `Oct 2025`. */
function monthLong(iso: string): string {
  const { y, m } = monthDate(iso);
  return `${MONTHS[m - 1]} ${y}`;
}

function peso(v: number, decimals: number): string {
  return `${PESO}${v.toLocaleString('en-US', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  })}`;
}

function tonnes(v: number): string {
  return `${v.toLocaleString('en-US', { maximumFractionDigits: 0 })} t`;
}

function pct(v: number): string {
  return `${v.toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 })}%`;
}

// ── Axis geometry ───────────────────────────────────────────────────────────

/** The smallest "nice" step (1, 2, 2.5, 5 × 10^k) at or above `raw`. */
function niceStep(raw: number): number {
  if (!Number.isFinite(raw) || raw <= 0) return 1;
  const pow = 10 ** Math.floor(Math.log10(raw));
  for (const m of [1, 2, 2.5, 5, 10]) {
    if (m * pow >= raw - 1e-12) return m * pow;
  }
  return 10 * pow;
}

/** The domain's bounds, over published values only. An axis range, not a statistic. */
function bounds(values: readonly (number | null)[], include: number | null): [number, number] | null {
  const real = values.filter((v): v is number => v !== null && Number.isFinite(v));
  if (include !== null && Number.isFinite(include)) real.push(include);
  if (real.length === 0) return null;
  return [Math.min(...real), Math.max(...real)];
}

/**
 * A tick ladder of exactly `intervals` equal steps covering `[lo, hi]`, starting on a
 * multiple of the step and never below `floor`. Two axes built with the SAME interval
 * count share their horizontal guides, so the right-hand numbers sit on the left's lines.
 */
function ladder(
  lo: number,
  hi: number,
  intervals: number,
  floor: number,
): { start: number; step: number } {
  const span = Math.max(hi - lo, Math.abs(hi) * 0.02, 1e-9);
  let step = niceStep(span / intervals);
  for (let guard = 0; guard < 8; guard = guard + 1) {
    const start = Math.max(floor, Math.floor(lo / step) * step);
    if (start + step * intervals >= hi - 1e-9) return { start, step };
    step = niceStep(step * 1.0001);
  }
  return { start: Math.max(floor, Math.floor(lo / step) * step), step };
}

function axisOf(
  start: number,
  step: number,
  intervals: number,
  unit: string,
  label: (v: number) => string,
): BlendMarketAxis {
  const ticks = Array.from({ length: intervals + 1 }, (_, i) => {
    const value = start + step * i;
    return { value, label: label(value) };
  });
  return { domain: [start, start + step * intervals], ticks, unit };
}

/** Pick the interval count (4–6) that fits the price range most tightly. */
function priceLadder(lo: number, hi: number): { start: number; step: number; intervals: number } {
  let best: { start: number; step: number; intervals: number } | null = null;
  for (const intervals of [4, 5, 6]) {
    const l = ladder(lo, hi, intervals, 0);
    const waste = l.step * intervals - (hi - lo);
    const bestWaste = best ? best.step * best.intervals - (hi - lo) : Infinity;
    if (waste < bestWaste - 1e-9) best = { ...l, intervals };
  }
  return best ?? { start: 0, step: 1, intervals: 4 };
}

// ── The slot ────────────────────────────────────────────────────────────────

/**
 * What page one's chart slot holds. A failed or unfinished read NEVER fails the document:
 * the slot then prints a one-line note in the chart's place, so a reader can tell "the
 * market history could not be read" from "someone removed the chart".
 */
export type BlendMarketChartSlot =
  | { kind: 'chart'; model: BlendMarketChartModel }
  | { kind: 'unavailable'; reason: string };

export const BLEND_MARKET_CHART_TITLE = 'RC market — last 12 months';
export const BLEND_MARKET_UNAVAILABLE_HEADLINE = 'Market history unavailable';
/** The slot's reason while the read has not answered yet (printed only if Print wins the race). */
export const BLEND_MARKET_LOADING_REASON =
  'The twelve-month market history was still loading when this was printed — print again in a moment to include it.';

// ── The model ───────────────────────────────────────────────────────────────

/**
 * The definitions line, one sentence per series family. Exported so the on-screen chart
 * can print it while the read is still loading (the section keeps its height) — the
 * model uses the same function, so the two can never word it differently.
 */
export function blendMarketSubtitle(showPrices: boolean): string {
  return showPrices
    ? `Fed price = delivered cost of the charcoal fed to the plant (MAIN feed only; not the shrinkage-adjusted actual price) ${MIDDOT} Deliveries = market purchases only (no sundry re-entries or re-cooks) ${MIDDOT} Volumes are monthly totals`
    : `Fed = charcoal fed to the plant (MAIN feed only) ${MIDDOT} Deliveries = market purchases only (no sundry re-entries or re-cooks) ${MIDDOT} Volumes are monthly totals`;
}

export interface BuildBlendMarketChartInput {
  history: BlendMarketHistory;
  /** EFFECTIVE price flag: server gate AND the Prices toggle. Hide-only. */
  showPrices: boolean;
  /** The blend's own raw ₱/kg — a dashed reference level. Ignored unless `showPrices`. */
  blendRawPhpKg?: number | null;
}

export function buildBlendMarketChartModel(input: BuildBlendMarketChartInput): BlendMarketChartModel {
  const { history } = input;
  const showPrices = input.showPrices && history.canViewPrices;
  const months = history.months;

  const ticks = months.map((m) => blendMarketTick(m.monthStart));
  const monthLabels = months.map((m) => monthLong(m.monthStart));
  const partial = months.map((m) => m.isPartialMonth);

  // kg → tonnes: a UNIT change for the axis, not an aggregate.
  const toT = (v: number | null): number | null => (v === null ? null : v / 1000);

  const areas: BlendMarketSeries[] = [
    {
      id: 'deliveredVolume',
      label: 'RC deliveries volume (t / month)',
      values: months.map((m) => toT(m.deliveredKg)),
      stroke: BLEND_MARKET_INK.deliveredVolumeStroke,
      fill: BLEND_MARKET_INK.deliveredVolumeFill,
    },
    {
      id: 'fedVolume',
      label: 'RC fed volume (t / month)',
      values: months.map((m) => toT(m.fedKg)),
      stroke: BLEND_MARKET_INK.fedVolumeStroke,
      fill: BLEND_MARKET_INK.fedVolumeFill,
    },
  ];

  const lines: BlendMarketSeries[] = showPrices
    ? [
        {
          id: 'deliveredPrice',
          label: `Avg RC deliveries price (${PESO}/kg)`,
          values: months.map((m) => m.deliveredPhpKg),
          stroke: BLEND_MARKET_INK.deliveredPrice,
        },
        {
          id: 'fedPrice',
          label: `Avg RC fed price (${PESO}/kg)`,
          values: months.map((m) => m.fedPhpKg),
          stroke: BLEND_MARKET_INK.fedPrice,
        },
      ]
    : [];

  const refValue =
    showPrices && input.blendRawPhpKg !== null && input.blendRawPhpKg !== undefined &&
    Number.isFinite(input.blendRawPhpKg)
      ? input.blendRawPhpKg
      : null;

  // ── Axes ──
  const volBounds = bounds([...areas[0].values, ...areas[1].values], null);
  const volHi = volBounds ? Math.max(volBounds[1], 0) : 1;
  let leftAxis: BlendMarketAxis;
  let rightAxis: BlendMarketAxis | null = null;

  const priceBounds = showPrices ? bounds([...lines[0].values, ...lines[1].values], refValue) : null;
  if (showPrices && priceBounds) {
    const p = priceLadder(priceBounds[0], priceBounds[1]);
    // Decimals follow the STEP, so a 2.5 ladder reads ₱37.5 / ₱40.0, never a rounded ₱38.
    const decimals = Number.isInteger(p.step) ? 0 : Number.isInteger(p.step * 10) ? 1 : 2;
    leftAxis = axisOf(p.start, p.step, p.intervals, `${PESO}/kg`, (v) => peso(v, decimals));
    const vl = ladder(0, volHi, p.intervals, 0);
    rightAxis = axisOf(0, vl.step, p.intervals, 't / month', tonnes);
  } else {
    const vl = ladder(0, volHi, 4, 0);
    leftAxis = axisOf(0, vl.step, 4, 't / month', tonnes);
  }

  // ── Legend: the lines first (they are what the eye reads), then the areas ──
  const legend: BlendMarketLegendEntry[] = [
    ...[...lines].reverse().map<BlendMarketLegendEntry>((s) => ({ kind: 'line', label: s.label, stroke: s.stroke })),
    ...[...areas].reverse().map<BlendMarketLegendEntry>((s) => ({
      kind: 'area',
      label: s.label,
      stroke: s.stroke,
      fill: s.fill,
    })),
  ];
  const refLine =
    refValue !== null ? { value: refValue, label: `This blend ${peso(refValue, 2)}/kg` } : null;
  if (refLine) legend.push({ kind: 'ref', label: `This blend, raw (${PESO}/kg)`, stroke: BLEND_MARKET_INK.ref });

  // ── Footnotes: every one a published fact, said once ──
  const footnotes: string[] = [];
  const partialMonth = months.find((m) => m.isPartialMonth);
  if (partialMonth) {
    footnotes.push(
      `${monthLong(partialMonth.monthStart)} is the current month${
        partialMonth.measuredTo ? `, measured to ${partialMonth.measuredTo}` : ''
      } ${EMDASH} its totals are still growing (${showPrices ? 'hollow points, ' : ''}"partial" under its month).`,
    );
  }
  if (showPrices) {
    for (const m of months) {
      if (m.fedPriceCoveragePct !== null && m.fedPriceCoveragePct < 100 && m.fedKg !== null && m.fedKg > 0) {
        footnotes.push(
          `${monthLong(m.monthStart)}: ${pct(m.fedPriceCoveragePct)} of fed kg traceable to a delivery price ${EMDASH} the fed price is over those kilos only.`,
        );
      }
    }
    for (const m of months) {
      if (
        m.deliveredPriceCoveragePct !== null &&
        m.deliveredPriceCoveragePct < 100 &&
        m.deliveredKg !== null &&
        m.deliveredKg > 0
      ) {
        footnotes.push(
          `${monthLong(m.monthStart)}: ${pct(m.deliveredPriceCoveragePct)} of delivered kg priced ${EMDASH} the deliveries price is over those kilos only.`,
        );
      }
    }
  }
  const series = [...areas, ...lines];
  if (series.some((s) => s.values.some((v) => v === null))) {
    footnotes.push('A break in a line or area is a month with no figure — never a zero.');
  }

  const range = months.length
    ? `${monthLong(months[0].monthStart)} ${EMDASH} ${monthLong(months[months.length - 1].monthStart)}`
    : '';

  const subtitle = blendMarketSubtitle(showPrices);

  const ariaLabel = `${showPrices ? 'RC fed and deliveries price and volume' : 'RC fed and deliveries volume'}, ${range}`;

  return {
    title: BLEND_MARKET_CHART_TITLE,
    range,
    subtitle,
    ticks,
    monthLabels,
    partial,
    areas,
    lines,
    leftAxis,
    rightAxis,
    refLine,
    legend,
    footnotes,
    ariaLabel,
    showPrices,
  };
}

// ── Geometry ────────────────────────────────────────────────────────────────

export interface BlendMarketPoint {
  x: number;
  y: number;
}

/**
 * What a label IS, so a renderer with its own palette (the screen) can ink it by meaning.
 * The print ignores it and uses `color`.
 */
export type BlendMarketTextRole =
  | 'leftTick'
  | 'leftUnit'
  | 'rightTick'
  | 'rightUnit'
  | 'month'
  | 'partial'
  | 'ref';

export interface BlendMarketTextItem {
  x: number;
  y: number;
  text: string;
  role: BlendMarketTextRole;
  /** The month slot a `month` / `partial` label belongs to (lets a narrow screen thin them). */
  slot?: number;
  anchor: 'start' | 'middle' | 'end';
  bold?: boolean;
  italic?: boolean;
  size: number;
  color: string;
}

export interface BlendMarketLayout {
  width: number;
  height: number;
  plot: { x: number; y: number; w: number; h: number };
  /** Horizontal guides (y), on the left axis's ticks. */
  guides: number[];
  /** One polygon per contiguous run, closed to the baseline. */
  areas: { id: BlendMarketSeriesId; fill: string; stroke: string; polygons: BlendMarketPoint[][] }[];
  lines: {
    id: BlendMarketSeriesId;
    stroke: string;
    runs: BlendMarketPoint[][];
    dots: (BlendMarketPoint & { hollow: boolean })[];
  }[];
  ref: { y: number; x1: number; x2: number } | null;
  texts: BlendMarketTextItem[];
  /** x of each month slot's centre — exported for the verify script. */
  slotX: number[];
  baselineY: number;
}

/**
 * Lay the chart out in an abstract W × H box (px for the SVG, pt for jsPDF). `font` is the
 * label size in the same unit; `charW` the average glyph advance as a fraction of `font`.
 * `measure`, when given, replaces the estimate with a real text width in the same unit
 * (the jsPDF path passes `doc.getTextWidth`, whose `PHP ` spelling is wider than `₱`).
 */
export function layoutBlendMarketChart(
  model: BlendMarketChartModel,
  width: number,
  height: number,
  font: number,
  charW = 0.58,
  measure?: (s: string) => number,
): BlendMarketLayout {
  const labelW = (s: string) => (measure ? measure(s) : s.length * font * charW);
  const leftLabelMax = Math.max(...model.leftAxis.ticks.map((t) => labelW(t.label)), labelW(model.leftAxis.unit));
  const rightLabelMax = model.rightAxis
    ? Math.max(...model.rightAxis.ticks.map((t) => labelW(t.label)), labelW(model.rightAxis.unit))
    : 0;

  const padTop = font * 1.9; // the axis units sit above the plot
  const hasPartial = model.partial.some(Boolean);
  const padBottom = font * (hasPartial ? 2.9 : 1.9);
  const padLeft = leftLabelMax + font * 0.8;
  const padRight = model.rightAxis ? rightLabelMax + font * 0.8 : font * 0.6;

  const plot = {
    x: padLeft,
    y: padTop,
    w: Math.max(10, width - padLeft - padRight),
    h: Math.max(10, height - padTop - padBottom),
  };
  const n = model.ticks.length;
  const slotW = plot.w / Math.max(1, n);
  const slotX = model.ticks.map((_, i) => plot.x + slotW * (i + 0.5));
  const baselineY = plot.y + plot.h;

  const scaleOn = (axis: BlendMarketAxis) => (v: number) => {
    const [lo, hi] = axis.domain;
    const span = hi - lo;
    if (!Number.isFinite(span) || span <= 0) return plot.y + plot.h / 2;
    return plot.y + plot.h - (plot.h * (v - lo)) / span;
  };
  const yLeft = scaleOn(model.leftAxis);
  const yVol = model.rightAxis ? scaleOn(model.rightAxis) : yLeft;

  const runs = (values: readonly (number | null)[], y: (v: number) => number) => {
    const out: { idx: number[]; pts: BlendMarketPoint[] }[] = [];
    let cur: { idx: number[]; pts: BlendMarketPoint[] } | null = null;
    for (const [i, v] of values.entries()) {
      if (v === null || !Number.isFinite(v)) {
        cur = null;
        continue;
      }
      if (cur === null) {
        cur = { idx: [], pts: [] };
        out.push(cur);
      }
      cur.idx.push(i);
      cur.pts.push({ x: slotX[i], y: y(v) });
    }
    return out;
  };

  const areas = model.areas.map((s) => ({
    id: s.id,
    fill: s.fill ?? s.stroke,
    stroke: s.stroke,
    polygons: runs(s.values, yVol).map((r) => {
      // A lone month would be a zero-width polygon; draw it as a narrow column instead so
      // an isolated figure is still visible.
      const pts =
        r.pts.length === 1
          ? [
              { x: r.pts[0].x - slotW * 0.18, y: r.pts[0].y },
              { x: r.pts[0].x + slotW * 0.18, y: r.pts[0].y },
            ]
          : r.pts;
      return [
        { x: pts[0].x, y: baselineY },
        ...pts,
        { x: pts[pts.length - 1].x, y: baselineY },
      ];
    }),
  }));

  const lines = model.lines.map((s) => {
    const rs = runs(s.values, yLeft);
    return {
      id: s.id,
      stroke: s.stroke,
      runs: rs.map((r) => r.pts),
      dots: rs.flatMap((r) =>
        r.pts.map((p, k) => ({ ...p, hollow: model.partial[r.idx[k]] === true })),
      ),
    };
  });

  const texts: BlendMarketTextItem[] = [];
  const guides = model.leftAxis.ticks.map((t) => yLeft(t.value));
  for (const t of model.leftAxis.ticks) {
    texts.push({
      x: plot.x - font * 0.45,
      y: yLeft(t.value) + font * 0.35,
      text: t.label,
      role: 'leftTick',
      anchor: 'end',
      size: font,
      color: BLEND_MARKET_INK.axis,
    });
  }
  texts.push({
    x: plot.x - font * 0.45,
    y: plot.y - font * 0.8,
    text: model.leftAxis.unit,
    role: 'leftUnit',
    anchor: 'end',
    bold: true,
    size: font,
    color: BLEND_MARKET_INK.text,
  });
  if (model.rightAxis) {
    const yR = scaleOn(model.rightAxis);
    for (const t of model.rightAxis.ticks) {
      texts.push({
        x: plot.x + plot.w + font * 0.45,
        y: yR(t.value) + font * 0.35,
        text: t.label,
        role: 'rightTick',
        anchor: 'start',
        size: font,
        color: BLEND_MARKET_INK.axis,
      });
    }
    texts.push({
      x: plot.x + plot.w + font * 0.45,
      y: plot.y - font * 0.8,
      text: model.rightAxis.unit,
      role: 'rightUnit',
      anchor: 'start',
      bold: true,
      size: font,
      color: BLEND_MARKET_INK.text,
    });
  }
  for (const [i, tick] of model.ticks.entries()) {
    texts.push({
      x: slotX[i],
      y: baselineY + font * 1.3,
      text: tick,
      role: 'month',
      slot: i,
      anchor: 'middle',
      bold: model.partial[i],
      size: font,
      color: BLEND_MARKET_INK.axis,
    });
    if (model.partial[i]) {
      texts.push({
        x: slotX[i],
        y: baselineY + font * 2.4,
        text: 'partial',
        role: 'partial',
        slot: i,
        anchor: 'middle',
        italic: true,
        size: font * 0.9,
        color: BLEND_MARKET_INK.axis,
      });
    }
  }

  let ref: BlendMarketLayout['ref'] = null;
  if (model.refLine) {
    const ry = yLeft(model.refLine.value);
    ref = { y: ry, x1: plot.x, x2: plot.x + plot.w };
    texts.push({
      x: plot.x + font * 0.4,
      y: ry - font * 0.45,
      text: model.refLine.label,
      role: 'ref',
      anchor: 'start',
      bold: true,
      size: font,
      color: BLEND_MARKET_INK.ref,
    });
  }

  return { width, height, plot, guides, areas, lines, ref, texts, slotX, baselineY };
}

// ── The on-screen crosshair: hit-test + tooltip rows ────────────────────────
//
// Pure, so the screen renderer stays thin and the verify script can pin the wording.
// FORMATTING ONLY: every value is a field of the model (prices as published, volumes in
// tonnes after the one unit change above). A NULL is "no data" — never 0.

/** The month slot under an x coordinate in the layout's unit, or null outside the plot. */
export function blendMarketSlotAt(layout: BlendMarketLayout, x: number): number | null {
  const n = layout.slotX.length;
  if (n === 0) return null;
  const { plot } = layout;
  if (x < plot.x || x > plot.x + plot.w) return null;
  const i = Math.floor(((x - plot.x) / plot.w) * n);
  return Math.min(n - 1, Math.max(0, i));
}

/** Short names for the screen legend and the tooltip rows. The model's labels stay the long ones. */
export const BLEND_MARKET_SHORT_LABEL: Record<BlendMarketSeriesId | 'ref', string> = {
  fedPrice: 'Fed price',
  deliveredPrice: 'Deliveries price',
  fedVolume: 'Fed volume',
  deliveredVolume: 'Deliveries volume',
  ref: 'This blend',
};

export interface BlendMarketTooltipRow {
  id: BlendMarketSeriesId;
  label: string;
  kind: 'line' | 'area';
  /** `₱43.09/kg` or `730.3 t`; null = no data for that month (NEVER printed as 0). */
  text: string | null;
}

export interface BlendMarketTooltip {
  /** `Sep 2026`. */
  month: string;
  partial: boolean;
  rows: BlendMarketTooltipRow[];
}

function tonnesPrecise(v: number): string {
  return `${v.toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 })} t`;
}

/**
 * The tooltip for month slot `i`: the lines first (what the eye reads), then the areas —
 * the legend's own order. A price-denied model has no lines, so no ₱ can appear here.
 */
export function blendMarketTooltip(model: BlendMarketChartModel, i: number): BlendMarketTooltip {
  const rows: BlendMarketTooltipRow[] = [
    ...[...model.lines].reverse().map<BlendMarketTooltipRow>((s) => {
      const v = s.values[i] ?? null;
      return {
        id: s.id,
        label: BLEND_MARKET_SHORT_LABEL[s.id],
        kind: 'line',
        text: v === null || !Number.isFinite(v) ? null : `${peso(v, 2)}/kg`,
      };
    }),
    ...[...model.areas].reverse().map<BlendMarketTooltipRow>((s) => {
      const v = s.values[i] ?? null;
      return {
        id: s.id,
        label: BLEND_MARKET_SHORT_LABEL[s.id],
        kind: 'area',
        text: v === null || !Number.isFinite(v) ? null : tonnesPrecise(v),
      };
    }),
  ];
  return { month: model.monthLabels[i] ?? model.ticks[i] ?? '', partial: model.partial[i] === true, rows };
}

// ── The HTML sheet (the iframe printout) ────────────────────────────────────

/**
 * The SVG's own coordinate box, in CSS px at 96 dpi. Its WIDTH is the A4-landscape content
 * width at the print's 10 mm margin (277 mm); its HEIGHT is chosen by the caller from what
 * else sits on page one (see `blendMarketPlotHeightPx`). The SVG is drawn with
 * `preserveAspectRatio="xMidYMid meet"` inside a flex box that owns the REST of page one,
 * so if the head runs taller than planned the chart shrinks uniformly instead of spilling
 * onto page two — the text shrinks with it, never distorts.
 */
export const BLEND_MARKET_SVG_WIDTH_PX = 1047;
/** The label size in SVG units: 10 px ≈ 7.5 pt at scale 1 — the print kit's 7 pt floor, with room. */
export const BLEND_MARKET_LABEL_PX = 10;

/**
 * How tall to make the SVG's coordinate box, from what page one also carries.
 *
 * MEASURED (headless Chromium, A4 landscape, 10 mm margin — `scripts/verify-blend-market-chart.ts`):
 * page one's box is 189 mm ≈ 714 px. Measured 2026-09-26 on the look rig, the plot box the
 * flex column leaves was 403 px with no Pricing section and a one-line remark, 320 px with
 * Pricing (the section + its formula line cost ~82 px), and each extra footnote ~12 px;
 * each remark line ~14 px. The figure returned tracks that box to within a few px, so the
 * chart is WIDTH-bound at full label size in the ordinary case and the SVG's `meet` only
 * absorbs a small error (or an outlier head) — never by distorting the text.
 */
export function blendMarketPlotHeightPx(opts: {
  hasPricing: boolean;
  /** The printed remark (italic, `pre-wrap`), or '' — its wrapped line count is estimated here. */
  remarkText: string;
  footnoteCount: number;
}): number {
  const base = 412;
  const pricing = opts.hasPricing ? 80 : 0;
  const remark = blendRemarkLineCount(opts.remarkText) * 14;
  const notes = Math.max(0, opts.footnoteCount - 1) * 12;
  return Math.max(170, Math.round(base - pricing - remark - notes));
}

/**
 * How many printed lines the remark takes at the page-one width: every hard line break
 * starts a line, and a line longer than ~180 characters (11 px italic over 277 mm) wraps.
 * A layout estimate for the chart's aspect ratio only — the flex box absorbs any error.
 */
export function blendRemarkLineCount(remarkText: string): number {
  const text = remarkText.trim();
  if (text === '') return 0;
  let lines = 0;
  for (const line of text.split('\n')) lines += Math.max(1, Math.ceil(line.length / 180));
  return lines;
}

function pointsAttr(pts: readonly BlendMarketPoint[]): string {
  return pts.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
}

/** The chart as an SVG string (no React — the print document is a string). */
export function blendMarketChartSvg(layout: BlendMarketLayout, ariaLabel: string): string {
  const parts: string[] = [];
  const L = layout;
  // Guides.
  for (const gy of L.guides) {
    parts.push(
      `<line x1="${L.plot.x.toFixed(1)}" x2="${(L.plot.x + L.plot.w).toFixed(1)}" y1="${gy.toFixed(1)}" y2="${gy.toFixed(1)}" stroke="${BLEND_MARKET_INK.grid}" stroke-width="0.7"/>`,
    );
  }
  // Areas, BEHIND everything else.
  for (const a of L.areas) {
    for (const poly of a.polygons) {
      parts.push(
        `<polygon data-series="${a.id}" points="${pointsAttr(poly)}" fill="${a.fill}" fill-opacity="${BLEND_MARKET_AREA_OPACITY}" stroke="${a.stroke}" stroke-width="1.1" stroke-linejoin="round"/>`,
      );
    }
  }
  // Baseline + frame sides.
  parts.push(
    `<line x1="${L.plot.x.toFixed(1)}" x2="${(L.plot.x + L.plot.w).toFixed(1)}" y1="${L.baselineY.toFixed(1)}" y2="${L.baselineY.toFixed(1)}" stroke="${BLEND_MARKET_INK.axis}" stroke-width="0.9"/>`,
  );
  // Reference level.
  if (L.ref) {
    parts.push(
      `<line data-series="ref" x1="${L.ref.x1.toFixed(1)}" x2="${L.ref.x2.toFixed(1)}" y1="${L.ref.y.toFixed(1)}" y2="${L.ref.y.toFixed(1)}" stroke="${BLEND_MARKET_INK.ref}" stroke-width="1" stroke-dasharray="5 3"/>`,
    );
  }
  // Lines + dots.
  for (const ln of L.lines) {
    for (const run of ln.runs) {
      if (run.length > 1) {
        parts.push(
          `<polyline data-series="${ln.id}" points="${pointsAttr(run)}" fill="none" stroke="${ln.stroke}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`,
        );
      }
    }
    for (const d of ln.dots) {
      parts.push(
        `<circle data-series="${ln.id}"${d.hollow ? ' data-partial="1"' : ''} cx="${d.x.toFixed(1)}" cy="${d.y.toFixed(1)}" r="${d.hollow ? 3.2 : 2.6}" fill="${d.hollow ? '#ffffff' : ln.stroke}" stroke="${ln.stroke}" stroke-width="${d.hollow ? 1.6 : 0}"/>`,
      );
    }
  }
  // Labels.
  for (const t of L.texts) {
    parts.push(
      `<text x="${t.x.toFixed(1)}" y="${t.y.toFixed(1)}" font-size="${t.size.toFixed(1)}" fill="${t.color}" text-anchor="${t.anchor}"${t.bold ? ' font-weight="700"' : ''}${t.italic ? ' font-style="italic"' : ''} font-family="ui-monospace, Menlo, Consolas, monospace">${escapeHtml(t.text)}</text>`,
    );
  }
  return (
    `<svg class="mchart-svg" viewBox="0 0 ${L.width} ${L.height}" preserveAspectRatio="xMidYMid meet" role="img" aria-label="${escapeHtml(ariaLabel)}" xmlns="http://www.w3.org/2000/svg">` +
    parts.join('') +
    `</svg>`
  );
}

function legendSwatch(e: BlendMarketLegendEntry): string {
  if (e.kind === 'line') {
    return `<span class="mchart-sw" style="width:14px;height:0;border-top:2.5px solid ${e.stroke}"></span>`;
  }
  if (e.kind === 'ref') {
    return `<span class="mchart-sw" style="width:14px;height:0;border-top:1.5px dashed ${e.stroke}"></span>`;
  }
  return `<span class="mchart-sw" style="width:12px;height:9px;background:${e.fill};opacity:1;border:1.2px solid ${e.stroke}"></span>`;
}

/**
 * Page one's chart section. Its box is the flex REMAINDER of page one (see
 * `BLEND_MARKET_CHART_PRINT_CSS` and the `.p1` wrapper in `buildBlendPrintDocument`).
 */
export function buildBlendMarketChartSection(
  model: BlendMarketChartModel,
  plotHeightPx: number,
): string {
  const layout = layoutBlendMarketChart(
    model,
    BLEND_MARKET_SVG_WIDTH_PX,
    plotHeightPx,
    BLEND_MARKET_LABEL_PX,
  );
  const legend = model.legend
    .map(
      (e) =>
        `<span class="mchart-lg" data-legend="${e.kind}">${legendSwatch(e)}${escapeHtml(e.label)}</span>`,
    )
    .join('');
  const notes = model.footnotes.length
    ? `<ul class="mchart-notes">${model.footnotes.map((f) => `<li>${escapeHtml(f)}</li>`).join('')}</ul>`
    : '';
  return `
  <section class="mchart" data-blend-market-chart="1" data-prices="${model.showPrices ? '1' : '0'}">
    <h2>${escapeHtml(model.title)} <span class="mchart-range">${escapeHtml(model.range)}</span></h2>
    <p class="mchart-sub">${escapeHtml(model.subtitle)}</p>
    <div class="mchart-legend">${legend}</div>
    <div class="mchart-plot">${blendMarketChartSvg(layout, model.ariaLabel)}</div>
    ${notes}
  </section>`;
}

/**
 * The slot's NOTE when the history could not be read (or had not answered yet). It sits
 * where the chart would, under the same heading, so page one keeps its shape and the
 * rest of the document prints exactly as it would with a chart.
 */
export function buildBlendMarketUnavailableSection(reason: string): string {
  return `
  <section class="mchart mchart-unavailable" data-blend-market-chart="unavailable">
    <h2>${escapeHtml(BLEND_MARKET_CHART_TITLE)}</h2>
    <p class="mchart-na"><strong>${escapeHtml(BLEND_MARKET_UNAVAILABLE_HEADLINE)}.</strong> ${escapeHtml(reason)}</p>
  </section>`;
}

/** The slot, as HTML — the chart, or the note in its place. */
export function buildBlendMarketSlotHtml(slot: BlendMarketChartSlot, plotHeightPx: number): string {
  return slot.kind === 'chart'
    ? buildBlendMarketChartSection(slot.model, plotHeightPx)
    : buildBlendMarketUnavailableSection(slot.reason);
}

/**
 * The chart's CSS, plus the `.p1` wrapper that makes page one a fixed-height flex column:
 * the head takes its natural height and the chart takes EXACTLY what is left, so page one
 * is one page by construction. `break-after: page` then starts the blocks table on sheet
 * two — where it went anyway whenever it was too long to share page one.
 *
 * 190 mm = 210 mm A4-landscape height − 2 × the print's 10 mm margin; 1 mm is left as
 * rounding slack so a sub-pixel overshoot cannot push a blank page.
 */
export const BLEND_MARKET_CHART_PRINT_CSS = `
  .p1 { height: 189mm; display: flex; flex-direction: column; overflow: hidden; break-after: page; }
  .p1 > * { flex: 0 0 auto; }
  .p1 > section.mchart { flex: 1 1 0; min-height: 0; display: flex; flex-direction: column; margin: 0; }
  .mchart h2 { margin-top: 8px; }
  .mchart-range { font-weight: 400; text-transform: none; letter-spacing: 0; color: #3f3f46; margin-left: 6px; }
  .mchart-sub { margin: 0 0 2px; font-size: 8pt; color: #3f3f46; }
  .mchart-legend { display: flex; flex-wrap: wrap; gap: 2px 14px; font-size: 8pt; color: #18181b; margin: 0 0 2px; }
  .mchart-lg { display: inline-flex; align-items: center; gap: 4px; white-space: nowrap; }
  .mchart-sw { display: inline-block; flex: 0 0 auto; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  .mchart-plot { flex: 1 1 0; min-height: 0; position: relative; }
  .mchart-svg { position: absolute; inset: 0; width: 100%; height: 100%; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  .mchart-notes { margin: 2px 0 0; padding: 0 0 0 12px; font-size: 7.5pt; color: #3f3f46; flex: 0 0 auto; }
  .mchart-notes li { margin: 0; }
  .p1 > section.mchart-unavailable { flex: 0 0 auto; }
  .mchart-na { margin: 2px 0 0; font-size: 9pt; color: #3f3f46; }
`;
