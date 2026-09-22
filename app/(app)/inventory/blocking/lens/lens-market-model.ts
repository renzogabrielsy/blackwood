// ─────────────────────────────────────────────────────────────────────────────
// THE TWO MARKET CONTEXT BLOCKS, AS PRINTABLE MODELS — pure, and formatting only.
//
// Page one of both lens prints was barren below the ratio bar. The owner:
//   *"maybe a deliveries price for the year — an indication of what the market price
//   is"* (price lens) and *"utilize the existing price-to-volume graph / area graph; a
//   table that shows the direction of price per supplier and its relationship with the
//   volume delivered"* (supplier lens).
//
// Both asks are the same shape — a market series over months — and both are answered by
// a payload that already computed every figure:
//   `fetchBlockingMarketContext(12)`   → `BlockingMarketContext`
//   `fetchBlockingSupplierMarket(12, keys)` → `BlockingSupplierMarket`
//
// ── ⚠️ NOT ONE NUMBER IS DERIVED HERE ───────────────────────────────────────
// Every price, kilogram, share, change, direction, correlation and premium below is a
// field of those payloads, rendered verbatim. There is no sum, no average, no division
// by a total and no re-weighting anywhere in this file — CLAUDE.md's rule, and the one
// the market functions exist to keep: they aggregate as Σ money ÷ Σ priced kg inside
// `view_analytics_rcin_monthly` / `view_analytics_supplier_monthly`, never as the mean of
// monthly averages, and a TypeScript copy of that would be a second definition.
//
// What this file does do is (a) FORMAT, and (b) work out a CHART DOMAIN — `Math.min` /
// `Math.max` over values the payload published, which is an axis range and not a statistic
// about charcoal. `verify-blocking-lens-ui.ts` pins both halves of that distinction.
//
// ── NULL IS NEVER 0, SIX TIMES ──────────────────────────────────────────────
// A price, a premium, a correlation, a price change, a volume change and a DIRECTION are
// each an em dash — never a zero and never the word "flat" — when the payload says NULL.
// `direction` in particular is NULL rather than `'flat'` when there is no change to read,
// because flat is a claim; and `priceVolumeCorr` is NULL below three priced months,
// because two points always correlate perfectly.
//
// ── DECIMALS, AND WHY THEY DIFFER BETWEEN THE TWO SHEETS ────────────────────
// The PRICE sheet speaks in two decimals throughout (its settings line reads
// `Market ₱39.86`, its per-block column `₱48.50`), so the market table and its chart do
// too — a second precision for the same number on one page reads as two numbers.
// The SUPPLIER sheet's band table already publishes the payload's own FOUR decimals
// (`₱43.5690`), so the weighted ₱/kg and the premium in its table match that; the
// first→last pair stays at two, because it is a pair in one narrow cell.
//
// PURE: no React, no fetch, no server action.
// ─────────────────────────────────────────────────────────────────────────────

import { format, parseISO } from 'date-fns';

import type {
  BlockingMarketContext,
  BlockingSupplierMarket,
  BlockingSupplierMarketEntry,
} from '../types';
import { LENS_EMDASH } from './lens-shared';
import type { PrintChartAxisTick, PrintChartPoint, PrintChartRefLine } from './lens-print-chart';

const PESO = '₱';

// ── Formatters ──────────────────────────────────────────────────────────────

function peso(v: number, decimals: number): string {
  return `${PESO}${v.toLocaleString(undefined, {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  })}`;
}

function pesoOrDash(v: number | null, decimals: number): string {
  return v === null ? LENS_EMDASH : peso(v, decimals);
}

/** `566,870 kg`. The lens's own kilogram shape, restated with no unit for tight cells. */
function kg(v: number): string {
  return `${Math.round(v).toLocaleString()} kg`;
}

function count(v: number): string {
  return v.toLocaleString();
}

/** `+4.2%` / `-11.7%` / an em dash. A SIGN is the content of a change figure. */
function signedPct(v: number | null, decimals = 1): string {
  if (v === null) return LENS_EMDASH;
  const body = Math.abs(v).toLocaleString(undefined, {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
  return `${v < 0 ? '-' : '+'}${body}%`;
}

/** `+₱0.4968` / an em dash. Positive = paid ABOVE the month's market. */
function signedPeso(v: number | null, decimals: number): string {
  if (v === null) return LENS_EMDASH;
  return `${v < 0 ? '-' : '+'}${peso(Math.abs(v), decimals)}`;
}

/** `Sep 2026` from a `yyyy-MM-01`. A LABEL, not a date — the project's date format is
 *  `yyyy-MM-dd` and is used for the windows this caption quotes. */
function monthLabel(iso: string): string {
  return format(parseISO(iso), 'MMM yyyy');
}

/** `Sep` — the chart's x tick. The caption carries the span, so the year is not repeated. */
function monthTick(iso: string): string {
  return format(parseISO(iso), 'MMM');
}

// ── Chart domains ───────────────────────────────────────────────────────────

/**
 * A `[min, max]` covering every value given, widened by 8% of its own span so a series
 * never runs along the frame — and widened to INCLUDE a reference level when one is
 * supplied, because a reference line drawn off the top of the plot says nothing.
 *
 * A flat series (every value identical) keeps a zero span, and `PrintSeriesChart` draws
 * that down the middle of the plot rather than on an edge. Twelve identical prices is a
 * real answer, not an error.
 *
 * ── ⚠️ `floor` EXISTS BECAUSE THE PAD PRINTED A NEGATIVE KILOGRAM ────────────
 * Measured on a real PDF (2026-09-22): the volume axis of every price-vs-volume panel read
 * `548t / 254t / −41t`, because the area domain starts at 0 and the 8% widening then pushed
 * its lower bound BELOW zero. A negative tonne is not a quantity, and a reader who sees one
 * is entitled to distrust the whole panel. Neither a kilogram nor a peso can be negative, so
 * every call site here passes `0` — and the clamp is applied AFTER the pad, so the top of the
 * plot still breathes.
 *
 * It is a FLOOR, not a zero-base: a price axis over ₱39–₱48 still starts near ₱38, because
 * forcing a price axis to zero would flatten the very movement the chart exists to show.
 */
export function printChartDomain(
  values: readonly (number | null | undefined)[],
  include: number | null = null,
  floor: number | null = null,
): [number, number] {
  const real: number[] = [];
  for (const v of values) {
    if (typeof v === 'number' && Number.isFinite(v)) real.push(v);
  }
  if (include !== null && Number.isFinite(include)) real.push(include);
  if (real.length === 0) return [0, 1];
  const lo = Math.min(...real);
  const hi = Math.max(...real);
  const clamp = (v: number) => (floor !== null && Number.isFinite(floor) ? Math.max(floor, v) : v);
  if (hi === lo) return [clamp(lo), hi];
  const pad = (hi - lo) * 0.08;
  return [clamp(lo - pad), hi + pad];
}

/** Three guides — bottom, middle, top of the domain — labelled by the caller's formatter. */
function threeTicks(
  domain: readonly [number, number],
  label: (v: number) => string,
): PrintChartAxisTick[] {
  const [lo, hi] = domain;
  if (hi === lo) return [{ value: lo, label: label(lo) }];
  const mid = lo + (hi - lo) / 2;
  return [
    { value: lo, label: label(lo) },
    { value: mid, label: label(mid) },
    { value: hi, label: label(hi) },
  ];
}

// ── (1) THE PRICE LENS'S MARKET CONTEXT ─────────────────────────────────────

export interface LensMarketRow {
  key: string;
  /** `month` rows are the series; `quarter` and `span` rows are its rollups. */
  kind: 'month' | 'quarter' | 'span';
  label: string;
  /** Preformatted ₱/kg, or an em dash when the payload published NULL. */
  price: string;
  kg: string;
  deliveries: string;
  /** Empty on a quarter or span row — the payload publishes it per MONTH only. */
  suppliers: string;
  /** The row the lens's own basis is measured over. At most one row is true. */
  highlighted: boolean;
  /** A quarter / span row, drawn a little heavier than a month. */
  rollup: boolean;
  /** `2 of 3 months` on a PARTIAL quarter at the window edge. Empty otherwise. */
  note: string;
}

export interface LensMarketChartModel {
  points: PrintChartPoint[];
  lineDomain: [number, number];
  lineTicks: PrintChartAxisTick[];
  refLine: PrintChartRefLine | null;
  ariaLabel: string;
}

export interface LensMarketPrintModel {
  rows: LensMarketRow[];
  /** `Deliveries, market class · priced kg only · 12 of 50 months` */
  caption: string;
  chart: LensMarketChartModel;
  /** `Monthly ₱/kg, Oct 2025 → Sep 2026 · dashed line = the lens's own basis` */
  chartCaption: string;
}

export interface BuildLensMarketPrintInput {
  context: BlockingMarketContext;
  /** The ₱ the lens is classifying against. Drawn as the chart's reference level. */
  basisPhpKg: number;
  /** `This quarter's deliveries` — the basis's OWN label from
   *  `PRICE_LENS_BASIS_LABELS`, lower-cased into the caption. Never spelled here. */
  basisLabel: string;
  /**
   * WHICH ROW the basis is measured over, when it is a row of this table at all.
   *
   * A calendar-month basis (`this_month` / `last_month`) is the month whose first day is
   * its `fromDate`; `this_quarter` is the quarter flagged `isCurrent`. `last_3_months`,
   * `trailing_days` and a TYPED price are aggregates this table does not carry a row for,
   * so nothing is highlighted and the caption names the basis instead. Inventing a row
   * for them would put a figure on the sheet that no view publishes.
   */
  highlight: { kind: 'month'; month: string } | { kind: 'currentQuarter' } | null;
}

export function buildLensMarketPrintModel({
  context,
  basisPhpKg,
  basisLabel,
  highlight,
}: BuildLensMarketPrintInput): LensMarketPrintModel {
  const rows: LensMarketRow[] = [];

  for (const m of context.months) {
    rows.push({
      key: `m-${m.month}`,
      kind: 'month',
      label: monthLabel(m.month),
      price: pesoOrDash(m.marketPhpKg, 2),
      kg: kg(m.marketKg),
      deliveries: count(m.deliveryCount),
      suppliers: count(m.activeSuppliers),
      highlighted: highlight?.kind === 'month' && highlight.month === m.month,
      rollup: false,
      note: '',
    });
  }

  for (const q of context.quarters) {
    rows.push({
      key: `q-${q.quarterKey}`,
      kind: 'quarter',
      label: q.isCurrent ? `${q.label} (current)` : q.label,
      price: pesoOrDash(q.marketPhpKg, 2),
      kg: kg(q.marketKg),
      deliveries: count(q.deliveryCount),
      suppliers: '',
      highlighted: highlight?.kind === 'currentQuarter' && q.isCurrent,
      rollup: true,
      // A QUARTER AT THE WINDOW EDGE IS PARTIAL and `monthCount` is what says so — a
      // one-month group labelled "Q2" reads as a full quarter.
      note: q.monthCount < 3 ? `${q.monthCount} of 3 months` : '',
    });
  }

  rows.push({
    key: 'span-ytd',
    kind: 'span',
    label: 'Year to date',
    price: pesoOrDash(context.yearToDate.marketPhpKg, 2),
    kg: kg(context.yearToDate.marketKg),
    deliveries: count(context.yearToDate.deliveryCount),
    suppliers: '',
    highlighted: false,
    rollup: true,
    note: `${context.yearToDate.monthCount} months`,
  });
  rows.push({
    key: 'span-t12',
    kind: 'span',
    label: 'Trailing 12 m',
    price: pesoOrDash(context.trailing12m.marketPhpKg, 2),
    kg: kg(context.trailing12m.marketKg),
    deliveries: count(context.trailing12m.deliveryCount),
    suppliers: '',
    highlighted: false,
    rollup: true,
    note: `${context.trailing12m.monthCount} months`,
  });

  const prices = context.months.map((m) => m.marketPhpKg);
  const lineDomain = printChartDomain(prices, basisPhpKg, 0);
  const points: PrintChartPoint[] = context.months.map((m) => ({
    tick: monthTick(m.month),
    line: m.marketPhpKg,
  }));

  const first = context.months[0];
  const last = context.months[context.months.length - 1];
  const span =
    first && last ? `${monthLabel(first.month)} → ${monthLabel(last.month)}` : '';

  return {
    rows,
    // A CAPTION IS A LIST OF FACTS — the same house style the analysis captions moved to.
    caption: [
      'Deliveries, market class',
      'priced kg only',
      `${context.monthsReturned} of ${context.monthsAvailable} months`,
      `market is ${basisLabel.toLowerCase()}`,
      `as of ${context.asOf}`,
    ].join(' · '),
    chart: {
      points,
      lineDomain,
      lineTicks: threeTicks(lineDomain, (v) => peso(v, 2)),
      refLine: { value: basisPhpKg, label: peso(basisPhpKg, 2) },
      ariaLabel: `Monthly market price per kilogram, ${span || 'the last months'}, against the lens's own ${peso(
        basisPhpKg,
        2,
      )}`,
    },
    chartCaption: span === '' ? 'Monthly ₱/kg' : `Monthly ₱/kg · ${span}`,
  };
}

// ── (2) THE SUPPLIER LENS'S PRICE vs VOLUME ─────────────────────────────────

export interface LensSupplierMarketPanel {
  key: string;
  title: string;
  /** `5,620,744 kg · ₱44.9225 · -11.7%` — the payload's own summary, in one line. */
  subtitle: string;
  points: PrintChartPoint[];
  lineDomain: [number, number];
  areaDomain: [number, number];
  lineTicks: PrintChartAxisTick[];
  areaTicks: PrintChartAxisTick[];
  ariaLabel: string;
}

export interface LensSupplierMarketRow {
  key: string;
  supplier: string;
  kg: string;
  phpKg: string;
  /** `₱50.86 -> ₱44.92`, or an em dash when either end has no priced kilos. */
  firstLast: string;
  changePct: string;
  /** `↑ up` / `↓ down` / `→ flat` / an em dash. NEVER "flat" for a NULL. */
  direction: string;
  volumeChangePct: string;
  /** Two decimals, or `n/a` under three priced months (with the count beside it). */
  corr: string;
  premium: string;
}

export interface LensSupplierMarketPrintModel {
  panels: LensSupplierMarketPanel[];
  rows: LensSupplierMarketRow[];
  footer: { label: string; kg: string; phpKg: string; note: string };
  caption: string;
  /**
   * What each INK means, two short words each — `kilograms delivered` and `₱/kg`.
   *
   * They live on the MODEL rather than in the sheet for the same reason every other string
   * does: the sheet spells no currency glyph. Measured on a real PDF (2026-09-22) the line's
   * swatch was labelled with the whole `chartCaption`, so the legend read *"kilograms
   * delivered ▬ Kilograms delivered (area, left) vs ₱/kg (line, right) · …"* — the area's
   * meaning stated twice and the line's not at all.
   */
  areaLegend: string;
  lineLegend: string;
  /** The note UNDER the legend — how to read two differently-scaled panels, and what a gap is. */
  chartCaption: string;
  /** Named bands the market payload has no series for, said rather than dropped silently. */
  omittedNote: string;
}

export interface BuildLensSupplierMarketInput {
  market: BlockingSupplierMarket;
  /**
   * The lens's own pretty spelling per key (`ORNALES` → `Ornales`).
   *
   * `view_analytics_supplier_monthly` publishes only the CANONICAL name, so
   * `BlockingSupplierMarketEntry.display` equals its `key`. The data layer's contract says
   * it outright: take the label from the LENS and join on `key`.
   */
  displayByKey: ReadonlyMap<string, string>;
  /** Every named band key the sheet asked about, so a missing series can be NAMED. */
  requestedKeys: readonly string[];
  /** How many chart panels the page will draw. The table still lists every row. */
  maxPanels: number;
}

type SupplierDirection = BlockingSupplierMarketEntry['summary']['direction'];

/** `↑ up` / `↓ down` / `→ flat`, or an em dash. A direction is a claim; NULL makes none. */
function directionText(d: SupplierDirection): string {
  if (d === 'up') return '↑ up';
  if (d === 'down') return '↓ down';
  if (d === 'flat') return '→ flat';
  return LENS_EMDASH;
}

function panelOf(
  entry: BlockingSupplierMarketEntry,
  months: readonly string[],
  title: string,
): LensSupplierMarketPanel {
  // The spine is THE WINDOW'S, never the selection's — a supplier with a quiet month gets
  // a gap on the axis rather than a shorter chart. That is why the payload publishes
  // `months` separately from each series.
  const byMonth = new Map(entry.series.map((p) => [p.month, p]));
  const points: PrintChartPoint[] = months.map((m) => {
    const p = byMonth.get(m);
    return {
      tick: monthTick(m),
      line: p?.avgPricePhpKg ?? null,
      // A zero-kilogram month is a real 0 (a sundry-only row), so it draws at the
      // baseline rather than breaking the area.
      area: p === undefined ? null : p.kg,
    };
  });

  // FLOORED AT 0 on both axes: neither a peso nor a kilogram can be negative, and the 8%
  // pad would otherwise print a NEGATIVE TONNE on the volume axis (measured 2026-09-22).
  const lineDomain = printChartDomain(points.map((p) => p.line), null, 0);
  const areaDomain = printChartDomain([0, ...points.map((p) => p.area)], null, 0);
  const s = entry.summary;

  return {
    key: entry.key,
    title,
    subtitle: [
      kg(s.totalKg),
      pesoOrDash(s.kgWeightedPhpKg, 4),
      signedPct(s.priceChangePct),
    ].join(' · '),
    points,
    lineDomain,
    areaDomain,
    lineTicks: threeTicks(lineDomain, (v) => peso(v, 2)),
    // Tonnes on the volume axis: twelve six-digit kilogram labels would not fit a 110px
    // panel, and the exact figure is in the table on the same page.
    areaTicks: threeTicks(areaDomain, (v) =>
      `${Math.round(v / 1000).toLocaleString()}t`,
    ),
    ariaLabel: `${title}: kilograms delivered as an area and price per kilogram as a line, per month`,
  };
}

export function buildLensSupplierMarketPrintModel({
  market,
  displayByKey,
  requestedKeys,
  maxPanels,
}: BuildLensSupplierMarketInput): LensSupplierMarketPrintModel {
  const label = (key: string) => displayByKey.get(key) ?? key;

  const panels = market.suppliers
    .slice(0, maxPanels)
    .map((e) => panelOf(e, market.months, label(e.key)));

  const rows: LensSupplierMarketRow[] = market.suppliers.map((e) => {
    const s = e.summary;
    return {
      key: e.key,
      supplier: label(e.key),
      kg: kg(s.totalKg),
      phpKg: pesoOrDash(s.kgWeightedPhpKg, 4),
      firstLast:
        s.firstPrice === null || s.lastPrice === null
          ? LENS_EMDASH
          : `${peso(s.firstPrice, 2)} → ${peso(s.lastPrice, 2)}`,
      changePct: signedPct(s.priceChangePct),
      direction: directionText(s.direction),
      volumeChangePct: signedPct(s.kgChangePct),
      // NULL exactly when fewer than three priced months — say WHICH, so a blank is
      // never read as "no relationship".
      corr:
        s.priceVolumeCorr === null
          ? `n/a (${s.corrMonthCount} m)`
          : s.priceVolumeCorr.toLocaleString(undefined, {
              minimumFractionDigits: 2,
              maximumFractionDigits: 2,
            }),
      premium: signedPeso(s.avgPremiumPhpKg, 4),
    };
  });

  const known = new Set(market.suppliers.map((s) => s.key));
  const missing = requestedKeys.filter((k) => !known.has(k));

  const span =
    market.fromMonth && market.toMonth
      ? `${market.monthsRequested} months to ${monthLabel(market.toMonth)}`
      : `${market.monthsRequested} months`;

  return {
    panels,
    rows,
    footer: {
      // The SELECTED suppliers' own total. `windowTotal` is the whole market and is what
      // the note compares it to — two names, because a selection's share of the market is
      // exactly the question a filtered read is asking.
      label: `${market.suppliers.length} supplier${market.suppliers.length === 1 ? '' : 's'} shown`,
      kg: kg(market.selectedTotal.marketKg),
      phpKg: pesoOrDash(market.selectedTotal.marketPhpKg, 4),
      note: `whole market ${kg(market.windowTotal.marketKg)} at ${pesoOrDash(
        market.windowTotal.marketPhpKg,
        4,
      )}`,
    },
    caption: [
      span,
      'market deliveries',
      'corr = price vs kg',
      `direction dead band ${market.directionDeadBandPct.toLocaleString(undefined, {
        maximumFractionDigits: 1,
      })}%`,
      `as of ${market.asOf}`,
    ].join(' · '),
    areaLegend: 'kilograms delivered (area, left)',
    lineLegend: `${PESO}/kg (line, right)`,
    chartCaption: [
      'each panel scales to its own range',
      'a gap is a month with no figure',
    ].join(' · '),
    omittedNote:
      missing.length === 0
        ? ''
        : `No purchase history in this window for: ${missing
            .map((k) => label(k))
            .join(' · ')}.`,
  };
}
