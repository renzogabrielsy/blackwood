"use client";

// ─────────────────────────────────────────────────────────────────────────────
// THE ROW EXPAND — one KPI's whole history, plus the honesty copy it owes.
//
// ── WHERE IT RENDERS (owner feedback R1) ────────────────────────────────────
// IN PLACE, in a full-width row directly beneath the row that was clicked. It
// used to render below the whole table, and the reason was real — a `colSpan`
// panel inside an `overflow-x-auto` table is as wide as the scrolling table and
// drifts sideways with the columns. Renzo's verdict on the result was "such a
// long scroll", so the panel is now pinned instead of relocated: the row spans
// every column and the panel inside it is `sticky left-0` at the scroller's
// measured width (see `analytics-matrix.tsx`). This component is unchanged by
// that — it is still a plain page-width block — it simply has a new parent.
//
// ── PRINTING ONE METRIC (owner feedback R1) ─────────────────────────────────
// The Print button tags this panel's ancestors, adds `bw-printing` to <body>
// and calls `window.print()`; the print stylesheet in `globals.css` then
// `display: none`s everything that is not the card, not inside it and not on
// the path down to it, so one card lands at the top of one A4 sheet. Browser
// print-to-PDF, no PDF library, no server round trip. Two blocks exist only on
// paper: a title line naming the metric and the window, and the page's own
// restatement footer, because a printed figure that does not say what it is or
// when it was true is a figure someone will misquote later.
//
// ── WHAT IS REUSED, AND THE ONE THING THAT COULD NOT BE ─────────────────────
// `DrilldownSection`, `DrilldownStat`, `BreakdownRail`, `DRILLDOWN_AXIS_TICK`
// and `drilldownTooltipChrome` come straight from the proven drill-down
// chassis, so an expanded metric reads as the big version of a digest tile.
//
// `VolumeSeriesChart` itself does NOT fit, for two reasons, and bending it to
// fit would have cost more than the local chart below:
//   • `VolumePoint.value` is `number`, and half the point of this page is that
//     a missing figure is a GAP, not a zero — RC OUT has no value at all
//     before January 2024, and drawing 42 zero-height bars there would assert
//     the plant fed nothing;
//   • its rolling-mean legend is hardcoded to day/month by
//     `rollingLabel(granularity)`, and this chart's buckets are months,
//     QUARTERS or YEARS.
//
// ── THE YEAR CHECKLIST (owner feedback R2, 2026-09-02) ──────────────────────
// Renzo: *"I would also like the option to click which years to display."* The
// chart draws EVERY period on record — back to July 2020 — and several rows are
// honestly blank for most of that (rc_out begins 2024-01, production 2025-11),
// so a reader who wants to look at the last two years is reading a chart that
// is two thirds empty. The header now carries the same checklist the matrix's
// column filter uses (`period-filter.tsx`), listing the years this row's own
// history spans, everything on by default, with All / None.
//
// **Three things it changes, and one it deliberately does not.**
//   • The CHART redraws over what is left, and so do the axis domain and the
//     shaded window band.
//   • The ROLLING AVERAGE is recomputed over the selection and **breaks at a
//     hidden year** rather than bridging it — the hidden periods are nulled,
//     `rollingMean` is run over that sequence, and only then are they dropped,
//     so any window overlapping the gap yields null exactly as it already does
//     at a month nothing was recorded in. Joining 2023 straight to 2026 with a
//     smoothed line would invent a trend across a hole the reader made.
//   • The STAT STRIP recomputes — Latest, Highest, Lowest and the window figure
//     — and every one of those labels says `· selected` while it is filtered,
//     because "Highest" over three chosen years is a different claim from
//     "Highest" over the whole record. The window figure is re-folded through
//     `foldSelection`, i.e. the SAME rollup machinery every column uses, so a
//     selected price is still Σ pesos ÷ Σ priced kilos and never a mean of the
//     surviving points.
//   • It does NOT change any comparison. A cell's month-on-month move and its
//     year-ago chip read the real neighbouring period whether or not it is on
//     screen — comparison uses data, display uses the filter. Stated on the
//     card, not just here.
//
// **The selection is per-expand session state and is NOT written to the URL.**
// The page's own controls are (`year`, `g`, `wd`, `cmp`, `metric`, `hide`) and
// this one deliberately is not: it is scoped to ONE metric's chart, so a param
// carrying it would silently mean something different the moment `metric=`
// changed — a shared link would arrive with a filter belonging to a row the
// recipient is not looking at. The matrix's COLUMN filter is shareable and does
// live in the URL (`?hide=`), because it describes the page's own window rather
// than one card's exploration. Opening a different row starts fresh: both call
// sites key this component by metric.
// ─────────────────────────────────────────────────────────────────────────────

import * as React from "react";
import {
  Area,
  Bar,
  CartesianGrid,
  ComposedChart,
  Legend,
  Line,
  ReferenceArea,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip as RTooltip,
  XAxis,
  YAxis,
} from "recharts";
import { Check, Lock, Printer, X } from "lucide-react";
import {
  DRILLDOWN_AXIS_TICK,
  DrilldownSection,
  DrilldownStat,
  drilldownTooltipChrome,
} from "@/components/digest/drilldown/drilldown-modal";
import { BreakdownRail } from "@/components/digest/drilldown/series-parts";
import type { RailItem } from "@/components/digest/drilldown/series-parts";
import { cn } from "@/lib/utils";
import { printCard } from "./print-card";
import type {
  HistoryPoint,
  MatrixRow,
  Period,
  UnitRules,
} from "@/lib/analytics/matrix";
import {
  foldSelection,
  GRANULARITY_LABEL,
  rollingMean,
  rollingWindowFor,
  type Granularity,
} from "@/lib/analytics/matrix";
import { fmtCompact, unitGlyphFor, unitSuffix } from "@/lib/analytics/format";
import type { AnalyticsMonth, ProductionBatchRow } from "@/lib/analytics/types";
import type { MetricSpecOf } from "@/lib/analytics/metrics";

/**
 * The presentational half of a spec — label, unit, decimals, colours,
 * dictionary. `never` for the unit makes this whole card clock-agnostic (R6):
 * an RC Inventory row read against a calendar month and a Production row read
 * against a production batch render through the same component, which is what
 * keeps the two bands one design rather than two.
 */
type AnySpec = MetricSpecOf<never>;
import { PeriodFilter, type PeriodFilterOption } from "./period-filter";
import { NO_HIDDEN } from "@/lib/analytics/period-selection";

// R3: a CSS variable, not a number. The expand chart is the "see things
// clearer" payload, so it grows 260 -> 340 px above 1920 px — and because
// `ResponsiveContainer` is `height="100%"` inside this box, recharts
// re-measures for free with no `matchMedia` and no hydration seam.
const CHART_HEIGHT = "var(--an-chart)";

/**
 * R6 — the PLURAL, declared rather than derived.
 *
 * `${noun}s` was fine while every bucket was a month, a quarter or a year. The
 * batch clock produced "9 batchs with a figure" on the first render — the same
 * bug `PeriodFilter.nounPlural` was added for in R5, one component over. A
 * plural is a fact about a word, so it is stated.
 */
function bucketPluralFor(g: Granularity): string {
  return g === "B" ? "batches" : `${bucketNounFor(g)}s`;
}

function bucketNounFor(g: Granularity): string {
  return g === "M"
    ? "month"
    : g === "Q"
      ? "quarter"
      : g === "B"
        ? "batch"
        : "year";
}

/**
 * The magnitude at full precision — **NUMBER ONLY since R6.**
 *
 * It used to prefix a ₱ and suffix a `%`, which read fine beside a right-hand
 * unit label but is exactly the duplication the unit-on-the-left format
 * removes: the stat strip now prints `₱/kg  48.26`, not `₱/kg  ₱48.26%`. The
 * chart TOOLTIPS still append `unitSuffix()` and are unaffected — a tooltip is
 * a sentence, not a column, so a trailing unit is right there.
 */
function fmtExact(spec: AnySpec, v: number): string {
  return v.toLocaleString("en-US", {
    minimumFractionDigits: spec.decimals,
    maximumFractionDigits: spec.decimals,
  });
}

/** Axis / tooltip magnitude — compact for pesos, exact for everything else. */
function fmtAxis(spec: AnySpec, v: number): string {
  if (spec.unit === "php") return fmtCompact(v);
  if (Math.abs(v) >= 10_000) return fmtCompact(v);
  return v.toLocaleString("en-US", {
    minimumFractionDigits: 0,
    maximumFractionDigits: spec.decimals,
  });
}

/**
 * The padded domain a LINE metric needs. A price or a runway drawn against a
 * zero floor reads as a collapse; lifting the minimum off the axis is the same
 * treatment the RC In price card and its drill-down already use.
 */
function paddedDomain(values: number[]): [number, number] | undefined {
  if (values.length === 0) return undefined;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = Math.max(max - min, 1);
  return [
    Math.max(0, Math.floor(min - Math.max(range * 0.6, 1))),
    Math.ceil(max + Math.max(range * 0.25, 0.5)),
  ];
}

/**
 * Can this chart draw a trailing average AT ALL?
 *
 * THE ONE definition, so the toggle and the chart can never disagree about
 * whether the line exists. Two exclusions, both pre-existing:
 *
 *   • **YEAR granularity** — a 3-year trailing average over 7 points smooths
 *     away the only signal there is, and an always-empty series would still
 *     claim a legend entry.
 *   • **A PAIRED row** (Block price vs True cost of a fed kilo) — four lines in
 *     one chart reads as noise, so the comparison line takes the slot.
 *
 * Where this returns false there is no average to switch off, so the control is
 * not rendered either. A toggle for a line that cannot exist is a control that
 * lies about what the page can do.
 */
function canDrawAvg(spec: AnySpec, granularity: Granularity): boolean {
  return granularity !== "Y" && !spec.pair;
}

/**
 * OWNER FEEDBACK R3 — the switch for the trailing-average line.
 *
 * ── WHY A LABELLED CONTROL BESIDE `Years`, AND NOT A CLICKABLE LEGEND ───────
 * recharts' `<Legend>` will take an `onClick`, and it was the first idea. Two
 * things ruled it out. Its hit target is a ~10 px swatch and its own label,
 * sitting inside the SVG wrapper under the plot — it looks exactly like the
 * static legend it has always been, so nothing on the page would say it can be
 * clicked, and a control that has to be discovered by clicking things is not a
 * control. And it lives INSIDE the print card, which would put a piece of UI
 * chrome on the paper unless it were separately excluded.
 *
 * So: the same shape as the `Years` trigger it sits beside — same height, same
 * border, same type token — carrying the page's OWN checkbox mark (the one the
 * period checklist already uses) plus a rule in the series' colour, so the
 * control names the exact line it governs. Being a sibling of `Years` it is
 * inside the header's `data-print-hide` span and never reaches paper.
 *
 * ── OWNER FEEDBACK R4: generalised and EXPORTED ─────────────────────────────
 * It was `AvgToggle` and hardcoded the trailing-average copy. R4 adds a second
 * chart switch (the price overlay on Purchase volume) and gives the supplier
 * expand its own average line, so the shape is now shared and the SENTENCE is
 * a required prop: a control that governs a different line owes a different
 * explanation, and a default sentence here would be wrong on two of the three
 * call sites rather than merely vague.
 */
export function ChartToggle({
  on,
  onChange,
  label,
  color,
  title,
}: {
  on: boolean;
  onChange(next: boolean): void;
  label: string;
  color: string;
  /** What switching it does, in words. Always supplied — see the R4 note. */
  title: string;
}) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={on}
      onClick={() => onChange(!on)}
      title={title}
      className={cn(
        "inline-flex h-[var(--an-h-8)] shrink-0 cursor-pointer items-center gap-1.5 rounded-md border px-2 text-[length:var(--bw-fs-12)] font-medium leading-[var(--bw-lh-xs)]",
        "transition-colors duration-150 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        on
          ? "border-border bg-background text-foreground shadow-sm"
          : "border-border/60 bg-background text-muted-foreground hover:bg-muted/50 hover:text-foreground",
      )}
    >
      <span
        aria-hidden
        className={cn(
          "flex size-3.5 shrink-0 items-center justify-center rounded-[3px] border transition-colors duration-150",
          on
            ? "border-primary bg-primary text-primary-foreground"
            : "border-border bg-background",
        )}
      >
        {on && <Check className="size-2.5" strokeWidth={3} />}
      </span>
      {/* The series' own colour, so the label points at ONE line rather than
          at "the averages" in general. Muted when off — the swatch must not
          keep advertising a line that is not on the chart. */}
      <span
        aria-hidden
        className="h-[2px] w-3.5 shrink-0 rounded-full transition-opacity duration-150"
        style={{ background: color, opacity: on ? 1 : 0.35 }}
      />
      {label}
    </button>
  );
}

/**
 * OWNER FEEDBACK R4 — a metric drawn as a LINE is now drawn as a LINE ON AN
 * AREA: the digest sparkline aesthetic, at full scale.
 *
 * Renzo asked for the gradient fill, and the reason it is safe here is the same
 * reason a price is a line rather than a bar in the first place. A BAR is read
 * as a length from zero, so its axis must include zero; a LINE is read as a
 * SHAPE, so it gets `paddedDomain` and the fill runs down to that padded floor
 * rather than to zero. The fill therefore says "this is the series" — it never
 * asserts a magnitude the axis does not support.
 *
 * **Two rules keep it from obscuring anything.** It is ONE series, not an area
 * plus a line: a separate `<Area>` and `<Line>` over the same key would claim
 * two legend entries for one fact, so the `<Area>` carries the stroke itself.
 * And it is drawn FIRST among the series, under the comparison line and the
 * trailing average, at a top opacity of 0.28 fading to 0.02 — the gridlines
 * read through it and neither of the two lines that matter is ever behind it.
 *
 * Bars are untouched: Renzo's word was "metrics rendered as lines".
 */
function MetricTrendChart({
  spec,
  history,
  pairHistory,
  overlay,
  granularity,
  showAvg,
  emptyText,
}: {
  spec: AnySpec;
  history: readonly HistoryPoint[];
  /** The comparison series, folded by the SAME rollup rules. Null when none. */
  pairHistory: readonly HistoryPoint[] | null;
  /**
   * R4 — the optional SECONDARY-AXIS series (today: market price over purchase
   * volume). It arrives as a folded `MatrixRow` history, so it is the same
   * numbers the price row itself prints, and it rides its own right-hand axis
   * because a ₱/kg and a tonnage share no scale.
   */
  overlay: {
    spec: AnySpec;
    history: readonly HistoryPoint[];
  } | null;
  granularity: Granularity;
  /**
   * OWNER FEEDBACK R3 — draw the trailing average line, or leave it out.
   *
   * It is genuinely REMOVED, not hidden: recharts derives the legend from the
   * children it is given, so dropping the `<Line>` drops its legend entry with
   * it and the chart reads as one series rather than as one series plus a
   * blank key. That is also why print needs no rule of its own — the paper
   * gets whatever the chart was drawing.
   */
  showAvg: boolean;
  /**
   * What to say when there is nothing to draw. The default is "nothing was
   * ever recorded"; the year checklist supplies a different sentence, because
   * switching every year off is a state the reader created and can undo, and
   * telling them the metric has no data would simply be false.
   */
  emptyText?: string;
}) {
  const tip = drilldownTooltipChrome();
  const noun = bucketNounFor(granularity);
  const avgLabel = `3-${noun} avg`;
  const unit = unitSuffix(spec.unit);
  const pair = spec.pair ?? null;

  const shown = history.filter((h) => h.displayed);
  const first = shown[0]?.label;
  const last = shown[shown.length - 1]?.label;

  // The pair rides on the SAME point objects, keyed by period, so recharts
  // draws two lines over one axis rather than two charts side by side — the
  // gap between them IS the fact, and two charts would hide it.
  const pairByKey = new Map(
    (pairHistory ?? []).map((p) => [p.periodKey, p.value] as const),
  );
  const overlayByKey = new Map(
    (overlay?.history ?? []).map((p) => [p.periodKey, p.value] as const),
  );
  const data = history.map((h) => ({
    ...h,
    pair: pair ? (pairByKey.get(h.periodKey) ?? null) : null,
    overlay: overlay ? (overlayByKey.get(h.periodKey) ?? null) : null,
  }));

  // A unique gradient id per chart. Two expands can be mounted at once (the
  // top matrix and the production room), and a duplicated SVG `id` makes the
  // second chart paint with the first one's colour.
  const gradientId = React.useId().replace(/:/g, "");

  const values = data
    .flatMap((h) => [h.value, h.pair])
    .filter((v): v is number => v != null);
  const overlayValues = data
    .map((h) => h.overlay)
    .filter((v): v is number => v != null);
  const crossesZero = values.some((v) => v < 0);
  // A BAR is read as a length from the baseline, so its axis MUST include zero —
  // recharts' "auto" domain would start at 6,000 t and turn a 30% spread into a
  // chart that looks like a collapse. A LINE is read as a shape, so it gets the
  // padded domain instead (the same treatment the RC In price card uses, and for
  // the same reason in reverse: a price against a zero floor reads as flat).
  const domain: [number | string, number | string] =
    spec.chart === "line"
      ? (paddedDomain(values) ?? ["auto", "auto"])
      : [crossesZero ? "auto" : 0, "auto"];

  if (values.length === 0) {
    return (
      <p className="px-3 py-12 text-center text-[length:var(--bw-fs-12)] leading-[var(--bw-lh-xs)] text-muted-foreground">
        {emptyText ?? "Nothing recorded for this metric yet."}
      </p>
    );
  }

  return (
    <div className="w-full" style={{ height: CHART_HEIGHT }}>
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart data={data} margin={{ top: 6, right: 8, bottom: 0, left: 0 }}>
          {/* The area's own gradient. Declared even on a bar chart — an unused
              <defs> paints nothing — so the chart has one shape rather than
              two conditional ones. */}
          <defs>
            <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={spec.color} stopOpacity={0.28} />
              <stop offset="100%" stopColor={spec.color} stopOpacity={0.02} />
            </linearGradient>
          </defs>
          <CartesianGrid stroke="var(--border)" strokeOpacity={0.4} vertical={false} />
          <XAxis
            dataKey="label"
            tick={DRILLDOWN_AXIS_TICK}
            tickLine={false}
            axisLine={{ stroke: "var(--border)" }}
            minTickGap={granularity === "M" ? 16 : 6}
          />
          <YAxis
            tick={DRILLDOWN_AXIS_TICK}
            tickLine={false}
            axisLine={false}
            width={56}
            domain={domain}
            tickFormatter={(v: number) => fmtAxis(spec, v)}
          />
          {/* R4 — the overlay's OWN axis, on the right. A ₱/kg and a tonnage
              share no scale, so plotting them against one axis would flatten
              one of them into the baseline. It is only mounted while the
              overlay is switched on, so an unused right gutter never eats
              chart width. */}
          {overlay && (
            <YAxis
              yAxisId="overlay"
              orientation="right"
              tick={DRILLDOWN_AXIS_TICK}
              tickLine={false}
              axisLine={false}
              width={52}
              domain={paddedDomain(overlayValues) ?? ["auto", "auto"]}
              tickFormatter={(v: number) => fmtAxis(overlay.spec, v)}
            />
          )}
          <RTooltip
            {...tip}
            formatter={(value, name) =>
              name === "overlay"
                ? [
                    value == null
                      ? "—"
                      : `${fmtExact(overlay!.spec, Number(value))} ${unitSuffix(overlay!.spec.unit)}`,
                    overlay!.spec.label,
                  ]
                : [
                    value == null ? "—" : `${fmtExact(spec, Number(value))} ${unit}`,
                    name === "avg"
                      ? avgLabel
                      : name === "pair"
                        ? (pair?.label ?? "")
                        : spec.label,
                  ]
            }
            labelFormatter={(label, payload) =>
              payload?.[0]?.payload?.fullLabel ?? label
            }
          />
          <Legend
            wrapperStyle={{ fontSize: "var(--bw-fs-11)", paddingTop: 4 }}
            formatter={(v) =>
              v === "avg"
                ? avgLabel
                : v === "pair"
                  ? (pair?.label ?? "")
                  : v === "overlay"
                    ? `${overlay?.spec.label ?? ""} (right)`
                    : spec.label
            }
          />
          {/* The displayed window, shaded — so the columns above and the whole
              history below are visibly the same numbers. */}
          {first && last && (
            <ReferenceArea
              x1={first}
              x2={last}
              fill="var(--foreground)"
              fillOpacity={0.05}
              ifOverflow="extendDomain"
            />
          )}
          {crossesZero && <ReferenceLine y={0} stroke="var(--border)" strokeWidth={1} />}
          {spec.chart === "bar" ? (
            <Bar
              dataKey="value"
              name="value"
              fill={spec.color}
              radius={[3, 3, 0, 0]}
              maxBarSize={granularity === "M" ? 20 : 44}
              isAnimationActive={false}
            />
          ) : (
            // ONE series: the <Area> carries its own stroke, so the chart has
            // a single legend key rather than an area and a line claiming to
            // be two things. Drawn before the comparison and average lines, so
            // the fill can never sit on top of either.
            <Area
              type="monotone"
              dataKey="value"
              name="value"
              stroke={spec.color}
              strokeWidth={2}
              fill={`url(#${gradientId})`}
              fillOpacity={1}
              dot={granularity === "M" ? false : { r: 2.5 }}
              activeDot={{ r: 3.5 }}
              isAnimationActive={false}
              connectNulls={false}
            />
          )}
          {/* The COMPARISON line. Dashed, so which series is the row's own is
              never in doubt, and drawn after it so the gap reads as depth
              below the headline figure rather than as two rival series. */}
          {pair && (
            <Line
              type="monotone"
              dataKey="pair"
              name="pair"
              stroke={pair.color}
              strokeWidth={1.75}
              strokeDasharray="4 3"
              dot={false}
              isAnimationActive={false}
              connectNulls={false}
            />
          )}
          {/* The trailing mean. `canDrawAvg` owns WHEN it is possible (never at
              YEAR granularity, never on a paired chart — see that function);
              `showAvg` is the reader's own switch on top of it. */}
          {canDrawAvg(spec, granularity) && showAvg && (
            <Line
              type="monotone"
              dataKey="avg"
              name="avg"
              stroke={spec.avgColor}
              strokeWidth={2}
              dot={false}
              isAnimationActive={false}
              connectNulls={false}
            />
          )}
          {/* R4 — the price overlay, LAST, so it sits above the bars it is
              read against and above the area fill. Dashed for the same reason
              the comparison line is: which series is the row's own is never in
              doubt. */}
          {overlay && (
            <Line
              yAxisId="overlay"
              type="monotone"
              dataKey="overlay"
              name="overlay"
              stroke={overlay.spec.color}
              strokeWidth={2}
              strokeDasharray="4 3"
              dot={false}
              isAnimationActive={false}
              connectNulls={false}
            />
          )}
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}

/**
 * WHAT THE ENDING-INVENTORY HEADLINE IS, AND THE THREE THINGS IT IS NOT.
 *
 * The row has been wrong in two directions and the second is the instructive
 * one. It began on the NET of every batch balance (8,492 t) — *"kind of a weird
 * basis"*, because a net subtracts a bookkeeping artefact from a physical
 * quantity. The first correction over-shot to every POSITIVE balance
 * (11,707.9 t), which bounces off Renzo's anchor from the other side: it folds
 * in closed-block residue, and by the project's standing resiko doctrine that
 * residue is LOSS already recognised, never stock anyone can walk out and use.
 *
 * The headline is now `openKg` — still-open piles with a positive balance, the
 * population the Blocking screen totals. So this panel exists to print, as
 * numbers rather than as claims, the three things it deliberately leaves out.
 */
function InventorySplit({ month }: { month: AnalyticsMonth }) {
  const open = month.openKg ?? 0;
  const residue = month.closedResidueKg ?? 0;
  const neg = Math.abs(month.negativeBalanceKg ?? 0);
  const gross = open + residue;
  const t1 = (kg: number) =>
    (kg / 1000).toLocaleString("en-US", { maximumFractionDigits: 1 });

  const items: RailItem[] = gross <= 0 ? [] : [
    {
      key: "open",
      label: "Open piles — this row",
      meta: `${month.openBatches ?? 0} piles`,
      value: t1(open),
      unit: "t",
      sharePct: (open / gross) * 100,
      title:
        "Charcoal in piles that were still open at this month-end — the population the Blocking screen totals. Whether a pile was open is judged as of that month, never as of today.",
    },
    {
      key: "residue",
      label: "Closed-block residue — excluded",
      meta: `${month.closedResidueBatches ?? 0} blocks`,
      value: t1(residue),
      unit: "t",
      sharePct: (residue / gross) * 100,
      title:
        "Weight still logged against blocks that have been closed out. This is the resiko — charcoal that evaporated while it sat. It is loss already taken, not stock, so it is not in the headline.",
    },
  ];

  return (
    <div className="flex flex-col gap-2">
      <BreakdownRail items={items} emptyText="No balances." maxHeight={120} />
      <ul className="flex flex-col gap-1.5 px-3 pb-1 text-[length:var(--bw-fs-115)] leading-relaxed text-muted-foreground">
        <li>
          <strong className="font-semibold text-foreground">
            Resiko is not stock.
          </strong>{" "}
          Counting the <span className="font-mono">{t1(residue)} t</span> above
          would read <span className="font-mono">{t1(gross)} t</span> — every
          positive balance on the books. That is weight the yard has already
          lost; it is disclosed here and never in the headline.
        </li>
        <li>
          <strong className="font-semibold text-foreground">
            Against Blocking.
          </strong>{" "}
          The headline is the same population the Blocking grand total counts,
          bar any pile with no block location — measured 2026-09-01, exactly one:{" "}
          <span className="font-mono">AUGUST-26-FEED2</span>, 18.7 t, the L-042
          phantom, which has no cell in the 220-slot grid.
        </li>
        <li>
          <strong className="font-semibold text-foreground">
            Negative balances are not netted off.
          </strong>{" "}
          <span className="font-mono">−{t1(neg)} t</span> across{" "}
          {month.negativeBatchCount ?? 0} batches would take it to{" "}
          <span className="font-mono">{t1(Math.max(open - neg, 0))} t</span>.
          Those are kilos fed out under one batch name while their arrival was
          booked under a different spelling of it —{" "}
          <strong className="font-semibold">
            misattribution, not missing charcoal
          </strong>
          .
        </li>
      </ul>
    </div>
  );
}

/**
 * WHAT THE STOCK AVERAGE COST IS MEASURED OVER — and where the ₱ TOTAL went.
 *
 * OWNER FEEDBACK R4. The Inventory value row printed the ₱ total of the yard;
 * Renzo asked for the weighted average unit cost instead, because the total
 * moved mostly when the YARD moved and therefore answered "how much charcoal
 * do we have" a second time. The total is not lost — it is the numerator of
 * the figure that replaced it, so it belongs here, beside the kilos it was
 * divided by, rather than as a row of its own.
 *
 * The rail is the coverage split, because that is the honest question about an
 * average: how much of the stock does the price actually speak for? An unpriced
 * truckload is in NEITHER half (the `avg_cost` narrowing of L-039), so the
 * unvalued kilos are real charcoal the figure cannot describe.
 */
function StockValueSplit({ month }: { month: AnalyticsMonth }) {
  const positive = month.positiveBalanceKg ?? 0;
  const coverage = month.valueCoveragePct;
  // `valued_kg` is not on the wire, but it IS `positive × coverage%` by the
  // view's own definition — derived from two published figures for a rail
  // label, never used as a number anything is computed from.
  const valued = coverage == null ? positive : (positive * coverage) / 100;
  const unvalued = Math.max(positive - valued, 0);
  const t1 = (kg: number) =>
    (kg / 1000).toLocaleString("en-US", { maximumFractionDigits: 1 });

  const items: RailItem[] = positive <= 0 ? [] : [
    {
      key: "valued",
      label: "Kilos the cost speaks for",
      value: t1(valued),
      unit: "t",
      sharePct: (valued / positive) * 100,
      title:
        "Charcoal sitting in piles whose deliveries all carry a price, so every kilo has a cost behind it. These are the only kilos in the average above.",
    },
    {
      key: "unvalued",
      label: "Kilos with no price yet",
      value: t1(unvalued),
      unit: "t",
      sharePct: (unvalued / positive) * 100,
      title:
        "Real charcoal awaiting a price. It is in NEITHER half of the average rather than counted as free — the same rule that stops an unpriced truckload dragging a batch's cost toward zero.",
    },
  ];

  return (
    <div className="flex flex-col gap-2">
      <BreakdownRail items={items} emptyText="No valued stock." maxHeight={120} />
      <ul className="flex flex-col gap-1.5 px-3 pb-1 text-[length:var(--bw-fs-115)] leading-relaxed text-muted-foreground">
        <li>
          <strong className="font-semibold text-foreground">
            The ₱ total behind the average.
          </strong>{" "}
          <span className="font-mono">
            {month.endingValuePhp == null
              ? "—"
              : `₱${month.endingValuePhp.toLocaleString("en-US", { maximumFractionDigits: 0 })}`}
          </span>{" "}
          over <span className="font-mono">{t1(valued)} t</span>. This used to be
          a row of its own; it moved here because a total mostly tracks how much
          charcoal is standing, while the average tracks what it COST.
        </li>
        <li>
          <strong className="font-semibold text-foreground">
            A wider set of piles than the row above.
          </strong>{" "}
          The valuation is measured over every positive balance, closed-block
          residue included, because the view it comes from has no notion of a
          close date. Being a ratio, that moves this figure far less than it
          moved the ₱ total — but it is a different population from Ending
          inventory, and the page says so rather than implying they match.
        </li>
      </ul>
    </div>
  );
}

/** The 60/120-day bands, plus the resiko kept deliberately outside them. */
function AgingSplit({ month }: { month: AnalyticsMonth }) {
  const open = month.openKg ?? 0;
  const over120 = month.kgOver120d ?? 0;
  const over60 = Math.max((month.kgOver60d ?? 0) - over120, 0);
  const fresh = Math.max(open - (month.kgOver60d ?? 0), 0);
  const items: RailItem[] = open <= 0 ? [] : [
    {
      key: "fresh",
      label: "Under 60 days",
      value: (fresh / 1000).toLocaleString("en-US", { maximumFractionDigits: 1 }),
      unit: "t",
      sharePct: open > 0 ? (fresh / open) * 100 : 0,
    },
    {
      key: "mid",
      label: "60 to 120 days",
      value: (over60 / 1000).toLocaleString("en-US", { maximumFractionDigits: 1 }),
      unit: "t",
      sharePct: open > 0 ? (over60 / open) * 100 : 0,
    },
    {
      key: "old",
      label: "Over 120 days",
      meta: `${month.batchesOver120d ?? 0} piles`,
      value: (over120 / 1000).toLocaleString("en-US", { maximumFractionDigits: 1 }),
      unit: "t",
      sharePct: open > 0 ? (over120 / open) * 100 : 0,
      title: "The share that is quietly losing weight while the money stays spent.",
    },
  ];
  return (
    <div className="flex flex-col gap-2">
      <BreakdownRail items={items} emptyText="No open stock." maxHeight={130} />
      <p className="px-3 pb-1 text-[length:var(--bw-fs-115)] leading-relaxed text-muted-foreground">
        Closed blocks are kept OUT of all of this. Their{" "}
        <span className="font-mono">
          {((month.closedResidueKg ?? 0) / 1000).toLocaleString("en-US", {
            maximumFractionDigits: 1,
          })}{" "}
          t
        </span>{" "}
        of leftover weight across {month.closedResidueBatches ?? 0} blocks is the
        charcoal that evaporated —{" "}
        <strong className="font-semibold">loss, not stock anyone can use</strong>{" "}
        — and counting it made the yard read 416 days old with a six-year-old pile
        in it, against 387 days once it is set aside. The oldest OPEN pile is{" "}
        <span className="font-mono">
          {month.oldestAgeDays == null
            ? "—"
            : Math.round(month.oldestAgeDays).toLocaleString("en-US")}
        </span>{" "}
        days.
      </p>
    </div>
  );
}

/**
 * P4 — WHY A ZERO DOWNTIME HOUR IS NOT A PERFECT MONTH, as counts rather than
 * as a sentence.
 *
 * The two halves of the shift report drifted apart in both directions:
 * Nov 2025 – Apr 2026 recorded durations and not one reason; reasons begin
 * May 2026; August 2026 records a reason on all 23 shifts and a duration on
 * none. So the rail splits the month's downtime records three ways and lets
 * the reader see which kind they are looking at.
 */
interface DowntimeRecord {
  downtimeShiftsWithDuration: number | null;
  downtimeShiftsReasonOnly: number | null;
  downtimeShiftCount: number | null;
}

function DowntimeSplit({ record }: { record: DowntimeRecord }) {
  const withDuration = record.downtimeShiftsWithDuration ?? 0;
  const reasonOnly = record.downtimeShiftsReasonOnly ?? 0;
  const records = record.downtimeShiftCount ?? 0;
  const other = Math.max(records - withDuration - reasonOnly, 0);
  const total = withDuration + reasonOnly + other;
  const items: RailItem[] = total <= 0 ? [] : [
    {
      key: "duration",
      label: "Duration recorded",
      value: String(withDuration),
      unit: "shifts",
      sharePct: (withDuration / total) * 100,
      title: "Shifts that put a number on how long the plant stood still. These are the only ones the hours above can see.",
    },
    {
      key: "reason_only",
      label: "Repair named, duration left at zero",
      value: String(reasonOnly),
      unit: "shifts",
      sharePct: (reasonOnly / total) * 100,
      title:
        "The work was recorded — cleaned a screen, changed a spring — and the duration was not. Real downtime that contributes nothing to the total.",
    },
    {
      key: "other",
      label: "Filed with neither",
      value: String(other),
      unit: "shifts",
      sharePct: (other / total) * 100,
      title: "A downtime record carrying no reason and no duration.",
    },
  ].filter((i) => Number(i.value) > 0);
  return (
    <div className="flex flex-col gap-2">
      <BreakdownRail items={items} emptyText="No downtime record here." maxHeight={130} />
      <p className="px-3 pb-1 text-[length:var(--bw-fs-115)] leading-relaxed text-muted-foreground">
        A downtime total of zero can mean two completely different things.{" "}
        <strong className="font-semibold">
          A shift that named the repair and left the duration blank is real
          downtime the hours cannot see
        </strong>{" "}
        — the AUGUST 2026 campaign is 22 shifts of exactly that, which is why
        its 0.00 hours is marked and can never be quoted as a record. Nothing is
        estimated in to fill the gap; the count is what makes the gap visible.
      </p>
    </div>
  );
}

/**
 * P4 — the metered total against the part of it we can prove is wrong.
 *
 * The raw kWh is published exactly as metered so it can never disagree with
 * the home dashboard's daily tile. This rail is where the mis-keyed reading is
 * quantified instead — and nothing here repairs it, because correcting the
 * underlying row is Renzo's call and a separate, audited write.
 */
interface PowerRecord {
  kwh: number | null;
  kwhSuspectKwh: number | null;
  kwhSuspectReadingCount: number | null;
  powerMeterCount: number | null;
  powerDays: number | null;
}

function PowerSplit({ record }: { record: PowerRecord }) {
  const total = record.kwh ?? 0;
  const suspect = record.kwhSuspectKwh ?? 0;
  const sound = Math.max(total - suspect, 0);
  const items: RailItem[] = total <= 0 ? [] : [
    {
      key: "sound",
      label: "Readings that walk forward",
      value: sound.toLocaleString("en-US", { maximumFractionDigits: 0 }),
      unit: "kWh",
      sharePct: (sound / total) * 100,
      title: "Every reading whose start follows the previous day's end, as a meter does.",
    },
    {
      key: "suspect",
      label: "Mis-keyed readings",
      meta: `${record.kwhSuspectReadingCount ?? 0} reading${(record.kwhSuspectReadingCount ?? 0) === 1 ? "" : "s"}`,
      value: suspect.toLocaleString("en-US", { maximumFractionDigits: 0 }),
      unit: "kWh",
      sharePct: (suspect / total) * 100,
      title:
        "A starting reading left at zero against an end that was still climbing. A start of zero is only a genuine meter reset when the counter WRAPPED — this one did not.",
    },
  ].filter((i) => i.sharePct > 0);
  return (
    <div className="flex flex-col gap-2">
      <BreakdownRail items={items} emptyText="No meter reading here." maxHeight={120} />
      <p className="px-3 pb-1 text-[length:var(--bw-fs-115)] leading-relaxed text-muted-foreground">
        The kWh total is published{" "}
        <strong className="font-semibold">exactly as metered</strong> — it is
        the record, and it must agree with the daily power tile on the home
        page. The power-intensity row is where a mis-keyed reading is taken
        out, because a wrong reading there does not look wrong, it looks like a
        twenty-fold efficiency collapse. Nothing on this page corrects the
        underlying reading.{" "}
        {record.powerMeterCount != null && (
          <>
            {record.powerMeterCount} meter
            {record.powerMeterCount === 1 ? "" : "s"} reported over{" "}
            {record.powerDays ?? 0} day{(record.powerDays ?? 0) === 1 ? "" : "s"}.
          </>
        )}
      </p>
    </div>
  );
}

/**
 * ── THE SIDE RAIL IS NOW A PROP, NOT A SWITCH (owner feedback R6) ──────────
 *
 * It used to be `sidePanelFor(spec.key)` reading `anchorMonth`, which quietly
 * assumed every row on this page was read against a calendar month. R6 makes
 * the card clock-agnostic, so the rail is built by whoever OWNS the clock and
 * handed in as a node: `MonthSideRail` below for the RC Inventory band,
 * `BatchSideRail` for the Production band. The card only has to know whether
 * there IS one, which is what the two-column layout needs.
 *
 * Both are exported so the two rooms compose them; both return `null` for a row
 * that has earned no rail, so `sideRail && …` is the whole layout rule.
 */
export function MonthSideRail({
  spec,
  month,
}: {
  spec: AnySpec;
  month: AnalyticsMonth | null;
}): React.ReactElement | null {
  if (!month) return null;
  const subtitle = month.monthStart.slice(0, 7);
  if (spec.key === "ending_inventory") {
    return (
      <DrilldownSection
        title="What the net is made of"
        subtitle={subtitle}
        bodyClassName="p-0"
      >
        <InventorySplit month={month} />
      </DrilldownSection>
    );
  }
  if (spec.key === "inventory_value") {
    return (
      <DrilldownSection
        title="What the average is measured over"
        subtitle={subtitle}
        bodyClassName="p-0"
      >
        <StockValueSplit month={month} />
      </DrilldownSection>
    );
  }
  if (spec.key === "stock_age" || spec.key === "over_120d") {
    return (
      <DrilldownSection
        title="How the yard is aged"
        subtitle={subtitle}
        bodyClassName="p-0"
      >
        <AgingSplit month={month} />
      </DrilldownSection>
    );
  }
  return null;
}

/**
 * The Production band's rails, on the BATCH clock.
 *
 * `DowntimeSplit` and `PowerSplit` are the SAME components the calendar band
 * used, unchanged: they were narrowed to the exact fields they read
 * (`DowntimeRecord`, `PowerRecord`), and a `ProductionBatchRow` carries those
 * fields under the same names because it is the same fact on a different clock.
 * One panel, not two that would drift.
 */
export function BatchSideRail({
  spec,
  batch,
}: {
  spec: AnySpec;
  batch: ProductionBatchRow | null;
}): React.ReactElement | null {
  if (!batch) return null;
  if (spec.key === "downtime_hours") {
    return (
      <DrilldownSection
        title="What the downtime records say"
        subtitle={batch.campaignLabel}
        bodyClassName="p-0"
      >
        <DowntimeSplit record={batch} />
      </DrilldownSection>
    );
  }
  if (spec.key === "power_kwh" || spec.key === "power_intensity") {
    return (
      <DrilldownSection
        title="What the meters recorded"
        subtitle={batch.campaignLabel}
        bodyClassName="p-0"
      >
        <PowerSplit record={batch} />
      </DrilldownSection>
    );
  }
  return null;
}

export interface MetricExpandProps<U> {
  row: MatrixRow<U>;
  granularity: Granularity;
  /**
   * The COMPLETE period axis at this granularity (`Matrix.allPeriods`). The
   * year checklist folds whatever survives it into the window stat, and it has
   * to be periods rather than the row's own history points because a rollup
   * needs the MONTHS underneath — a price over a selection is Σ pesos ÷ Σ
   * priced kilos, which no amount of averaging the points can produce.
   */
  allPeriods: readonly Period<U>[];
  /**
   * The options the matrix itself was folded with (`Matrix.foldOptions`).
   * Passed through rather than re-derived so a selection can never be folded
   * under different rules than the grid it sits inside.
   */
  foldOptions: { canViewPrices: boolean; perWorkingDay: boolean };
  /**
   * R6 — the CLOCK's own rules (`Matrix.rules`), threaded for the same reason
   * `foldOptions` is: a selection re-folded here must obey the same blank rules
   * the grid did, or a blank in the card would be explained by a sentence about
   * a different clock.
   */
  rules: UnitRules<U>;
  /** Header for the trailing summary column, so the strip names the window. */
  totalLabel: string;
  totalFullLabel: string;
  /**
   * R6 — the side rail, already built by whoever owns the clock (see
   * `MonthSideRail` / `BatchSideRail`). Omitted or null = a one-column card.
   */
  sideRail?: React.ReactNode;
  perWorkingDay: boolean;
  /** What the printed sheet says the reader was looking at. */
  scopeLabel: string;
  /** The newest record date, stamped on the printed sheet. */
  asOfDate: string | null;
  /**
   * OWNER FEEDBACK R3 — the page-level `Definitions` switch.
   *
   * It governs the two DICTIONARY CARDS at the foot of this panel and nothing
   * else. The row name's own hover/`Info` popover (`metric-info.tsx`) is
   * deliberately untouched by it: that is the definition AT THE POINT OF USE,
   * which is the thing a reader reaches for while scanning a grid, and it costs
   * no vertical space to leave on. What this hides is the block of prose that
   * pushes the chart up the screen once you already know what a row means.
   *
   * MASTER, not per card: Renzo asked for one switch, and per-card state would
   * also mean the setting evaporated every time a different row was opened
   * (both call sites `key` this component by metric).
   */
  showDictionary: boolean;
  /**
   * OWNER FEEDBACK R4 — the OPTIONAL secondary series this card may overlay,
   * as a folded `MatrixRow`.
   *
   * Renzo asked for it on Purchase volume only: *"an optional overlay price
   * toggle, default OFF, drawing the market price line on a secondary axis
   * over the volume bars."* It arrives as a row of the SAME `buildMatrix` fold
   * rather than as raw months, which is what makes the overlaid line literally
   * the Market price row's own numbers — the two can no more disagree than the
   * grade mix can disagree with the production total.
   *
   * **The ₱ gate is structural, not a render-time check.** A restricted row
   * carries `null` in every cell (the values never left the server), so the
   * card refuses to render the CONTROL when `row.restricted` is true: a toggle
   * for a line that would draw nothing is a control that lies about what the
   * page can do, and worse, it would advertise the existence of a figure the
   * reader may not have.
   */
  priceOverlay?: MatrixRow<U> | null;
  onClose(): void;
}

export function MetricExpand<U>({
  row,
  granularity,
  allPeriods,
  foldOptions,
  rules,
  totalLabel,
  totalFullLabel,
  sideRail,
  perWorkingDay,
  scopeLabel,
  asOfDate,
  showDictionary,
  priceOverlay,
  onClose,
}: MetricExpandProps<U>) {
  const spec = row.metric;
  const cardRef = React.useRef<HTMLElement | null>(null);
  const noun = bucketNounFor(granularity);
  const nouns = bucketPluralFor(granularity);
  // R6 — the stat strip wears the unit on the LEFT, like every value cell on
  // the page, so `unitSuffix` is no longer read here at all. It remains the
  // CHART's vocabulary ("48.26 ₱/kg" inside a tooltip is a sentence, not a
  // column) and is still used by `MetricTrendChart` above.
  const statGlyph = unitGlyphFor(spec) || undefined;
  const normalised = perWorkingDay && spec.perWorkingDay;

  // ── THE YEAR CHECKLIST (R2), WITH SMART DEFAULTS (R4) ───────────────────
  // Session state, keyed to this card, never to the URL — see the block
  // comment at the top of the file. The state is still the HIDDEN set; what
  // changed in R4 is what that set STARTS as.
  //
  // R2 shipped "always default to all checked", and Renzo has now superseded
  // it for THIS control: *"the Years checklist defaults to checking only years
  // WITH data for that metric."* Which is the same complaint that produced the
  // control in the first place, taken one step further — RC OUT is honestly
  // blank for 2020–2023, and opening its chart with four empty years switched
  // on means every reader does the same four clicks before they can read it.
  //
  // Three properties keep it honest, and they are why this is a DEFAULT rather
  // than a filter the reader cannot see:
  //   • it is derived from the row's own history (`withValue === 0`), never
  //     from a date, so it retires itself the moment a year gets a figure;
  //   • the empty years are still LISTED, still toggleable, and each says
  //     `0/12` beside it — the coverage count the control has always shown is
  //     exactly what makes the default legible rather than mysterious;
  //   • **it can never hide everything.** If no year carries a figure the card
  //     opens fully checked, because an empty chart under an empty-state
  //     sentence the reader did not cause is worse than an empty chart.
  //
  // The MATRIX's column filter is deliberately NOT changed: its periods come
  // from the flow spine, which is complete by construction, so "the ones with
  // data" and "all of them" are the same set there.
  const [hiddenYears, setHiddenYears] = React.useState<ReadonlySet<string>>(
    () => {
      const byYear = new Map<number, boolean>();
      for (const h of row.history) {
        byYear.set(h.year, (byYear.get(h.year) ?? false) || h.value != null);
      }
      const empty = [...byYear.entries()]
        .filter(([, hasValue]) => !hasValue)
        .map(([y]) => String(y));
      // Every year empty → hide none. See the third property above.
      if (empty.length === 0 || empty.length === byYear.size) return NO_HIDDEN;
      return new Set(empty);
    },
  );
  const isFiltered = hiddenYears.size > 0;

  // ── THE PRICE OVERLAY (owner feedback R4) ───────────────────────────────
  // DEFAULT OFF, as asked. Not rendered at all for a role that may not see
  // pesos — `row.restricted` is set server-side from the same `canViewPrices()`
  // that nulled the values, so there is nothing to reveal and nothing to hint
  // at.
  const overlayRow =
    priceOverlay && !priceOverlay.restricted ? priceOverlay : null;
  const [showOverlay, setShowOverlay] = React.useState(false);

  // ── THE TRAILING-AVERAGE SWITCH (owner feedback R3) ─────────────────────
  // DEFAULT ON — today's behaviour, so nobody has to switch anything on to get
  // back the page they know. Session state on this card, matched deliberately
  // to the Years checklist beside it: both are one card's exploration of one
  // row rather than a description of the page's window, so neither belongs in
  // an address someone might share. The card is keyed by metric at both call
  // sites, so opening a different row starts with the line drawn again.
  const [showAvg, setShowAvg] = React.useState(true);
  const avgAvailable = canDrawAvg(spec, granularity);

  /**
   * One line per year this row's history spans, carrying how much of that year
   * actually holds a figure. That count is the point: the whole reason the
   * control exists is that several rows are honestly blank for years at a time,
   * and a reader deciding what to switch off should be able to see which years
   * those are without switching them off first.
   */
  const yearOptions = React.useMemo<PeriodFilterOption[]>(() => {
    const byYear = new Map<number, { total: number; withValue: number }>();
    for (const h of row.history) {
      const e = byYear.get(h.year) ?? { total: 0, withValue: 0 };
      e.total += 1;
      if (h.value != null) e.withValue += 1;
      byYear.set(h.year, e);
    }
    return [...byYear.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([y, e]) => ({
        key: String(y),
        label: String(y),
        // At YEAR granularity every year IS one period, so "1/1" on every line
        // is chrome that says nothing.
        meta: granularity === "Y" ? undefined : `${e.withValue}/${e.total}`,
        empty: e.withValue === 0,
        title:
          e.withValue === 0
            ? `${y} — nothing was recorded for this figure. A genuine blank, not a zero; switching it off tidies the chart and changes no number.`
            : `${y} — ${e.withValue} of ${e.total} ${nouns} carry a figure.`,
      }));
  }, [row.history, granularity, nouns]);

  const shownYearCount = yearOptions.filter((o) => !hiddenYears.has(o.key)).length;
  const selectedSuffix = isFiltered ? " · selected" : "";

  const rollWindow = rollingWindowFor(granularity);

  /**
   * The chart's data, after the checklist.
   *
   * THE ORDER MATTERS AND IS THE WHOLE TRICK: the hidden periods are nulled
   * FIRST, the trailing mean is recomputed over that nulled sequence, and only
   * THEN are they dropped. So a window that spans a hidden year yields null and
   * the average line breaks at the gap — the same break a month with no records
   * already makes — instead of joining the two sides of a hole the reader made
   * and calling the join a trend. Filtering first and averaging after would
   * have produced exactly that fabricated line.
   */
  const view = React.useMemo(() => {
    const keep = (h: HistoryPoint) => !hiddenYears.has(String(h.year));
    // The overlay follows the SAME year selection — an overlaid price for a
    // year whose bars are switched off would draw a line over nothing.
    const overlay = overlayRow
      ? isFiltered
        ? overlayRow.history.filter(keep)
        : overlayRow.history
      : null;
    if (!isFiltered) {
      return { history: row.history, pair: row.pairHistory, overlay };
    }
    const values = row.history.map((h) => (keep(h) ? h.value : null));
    const history: HistoryPoint[] = [];
    for (let i = 0; i < row.history.length; i += 1) {
      const h = row.history[i];
      if (!keep(h)) continue;
      history.push({
        ...h,
        avg: rollWindow > 0 ? rollingMean(values, i, rollWindow) : null,
      });
    }
    return {
      history,
      pair: row.pairHistory ? row.pairHistory.filter(keep) : null,
      overlay,
    };
  }, [
    row.history,
    row.pairHistory,
    overlayRow,
    hiddenYears,
    isFiltered,
    rollWindow,
  ]);

  /**
   * The window figure, re-folded over the selected years through the SAME
   * `foldPeriod` + `rawValue` pair every matrix column goes through. Null while
   * nothing is filtered, where the honest figure is the matrix's own summary
   * column and re-deriving it here would only create a way for the two to
   * disagree.
   */
  const selectionFold = React.useMemo(() => {
    if (!isFiltered) return null;
    const selected = allPeriods.filter((p) => !hiddenYears.has(String(p.year)));
    return foldSelection(spec, selected, foldOptions, rules);
  }, [isFiltered, allPeriods, hiddenYears, spec, foldOptions, rules]);

  const settled = React.useMemo(
    () =>
      view.history.filter(
        (h): h is HistoryPoint & { value: number } => !h.isPartial && h.value != null,
      ),
    [view.history],
  );
  /**
   * The COMPARABLE subset — the same gate the callout strip uses, so the
   * expand's "highest" and the strip's "on record" can never name different
   * periods. It drops an unfinished period, a coverage-adjusted ESTIMATE,
   * and the metric's very first period (a stream that opened mid-month is a
   * reporting boundary, not a business fact). `settled` still describes what
   * the chart DRAWS, which is everything.
   */
  const comparable = React.useMemo(
    () => settled.filter((h) => h.calloutable),
    [settled],
  );
  const latest = React.useMemo(
    () => [...view.history].reverse().find((h) => h.value != null) ?? null,
    [view.history],
  );
  /**
   * The annotated periods INSIDE the displayed window, so the panel names them
   * rather than leaving a gap in the chart unexplained. Scoped to the window
   * on purpose: the chart draws all history, but a caveat about a period the
   * reader is not looking at is noise.
   */
  const annotated = React.useMemo(
    () => view.history.filter((h) => h.displayed && h.annotation),
    [view.history],
  );
  const high = comparable.length
    ? comparable.reduce((a, b) => (b.value > a.value ? b : a))
    : null;
  const low = comparable.length
    ? comparable.reduce((a, b) => (b.value < a.value ? b : a))
    : null;
  const excluded = settled.length - comparable.length;
  const recordScope =
    `Across ${comparable.length} comparable ${nouns}.` +
    ` An in-progress ${noun} cannot set a record, and neither can an estimate or the first ${noun} a figure was ever recorded.` +
    (excluded > 0
      ? ` ${excluded} settled ${noun}${excluded === 1 ? " is" : "s are"} held out on those grounds.`
      : "") +
    (isFiltered
      ? ` Only the ${shownYearCount} year${shownYearCount === 1 ? "" : "s"} you left switched on are considered — this is the highest and lowest of the SELECTION, not of the whole record.`
      : "");

  /**
   * ── THE STAT-STRIP MISMATCH, FOUND AND FIXED (owner feedback R4) ─────────
   *
   * Renzo's screenshot showed the `Selected` stat reading *"4/7 years · 45
   * months"* beside a chart header reading *"44 settled months"*, and the two
   * were describing DIFFERENT POPULATIONS under labels that both said
   * "months".
   *
   *   • `SelectionFold.periodCount` was simply `periods.length` — every period
   *     in the selection, **including the ones that carry no figure at all**.
   *     On RC OUT with every year on that read 63 or 75 months, against 33
   *     months in which anything was ever fed. The number under a total that
   *     says "23,388 t" reading "63 months" invites exactly the wrong division.
   *   • The chart header counted SETTLED periods, which additionally drops the
   *     in-progress one — hence 45 against 44.
   *
   * Both now print ONE derived count, `withValue`: periods in the selection
   * that carry a figure. It cannot disagree with the chart because it IS the
   * chart's data — `view.history` is the exact series the chart is handed —
   * and it is the honest denominator for the fold beside it. `settled` is
   * still what the Highest/Lowest population is judged on; that is a different
   * question and it says so in its own hover.
   */
  const withValue = React.useMemo(
    () => view.history.filter((h) => h.value != null).length,
    [view.history],
  );

  /** What the chart card's own header says it is drawing. */
  const chartSubtitle = isFiltered
    ? `${withValue} ${nouns} with a figure · ${shownYearCount}/${yearOptions.length} years`
    : granularity === "Y"
      ? `${withValue} ${nouns} with a figure`
      : `${withValue} ${nouns} with a figure · shaded band is the window above`;

  /** The years, spelled out — for the printed sheet and the card's own note. */
  const selectedYearsNote = isFiltered
    ? yearOptions
        .filter((o) => !hiddenYears.has(o.key))
        .map((o) => o.label)
        .join(", ") || "none"
    : null;

  return (
    <section
      ref={cardRef}
      // THE PRINT TARGET. Everything else on the page is hidden while
      // `bw-printing` is on <body>; this subtree is what lands on the sheet.
      data-print-card
      className="animate-fade-up rounded-lg border bg-card/60"
    >
      {/* Paper only. A printed figure that does not say WHAT it is and WHEN it
          was true is a figure someone will misquote a month from now. */}
      <div className="hidden print:block print:pb-2">
        <h1 className="text-[length:var(--bw-fs-16)] leading-[var(--bw-lh-base)] font-semibold tracking-tight">{spec.label}</h1>
        <p className="text-[length:var(--bw-fs-11)] text-muted-foreground">
          {normalised ? `${spec.sublabel} / working day` : spec.sublabel} ·{" "}
          {scopeLabel} · {GRANULARITY_LABEL[granularity].toLowerCase()} columns
          {asOfDate ? ` · records through ${asOfDate}` : ""}
        </p>
        {/* The paper must say what was FILTERED OUT. A printed chart that
            silently omits three years is the exact thing this page's
            restatement policy exists to prevent. */}
        {selectedYearsNote && (
          <p className="text-[length:var(--bw-fs-11)] text-muted-foreground">
            History filtered to {selectedYearsNote} ({shownYearCount} of{" "}
            {yearOptions.length} years). Hidden years are not restated — every
            change shown is still measured against the period that really
            precedes it.
          </p>
        )}
      </div>

      <header className="flex flex-wrap items-baseline justify-between gap-2 border-b px-3 py-2 print:hidden">
        <div className="min-w-0">
          <h3 className="truncate text-[length:var(--bw-fs-14)] leading-[var(--bw-lh-sm)] font-semibold tracking-tight">
            {spec.label}
          </h3>
          <p className="truncate text-[length:var(--bw-fs-115)] text-muted-foreground">
            {normalised ? `${spec.sublabel} / working day` : spec.sublabel} ·{" "}
            {GRANULARITY_LABEL[granularity].toLowerCase()} history, all records
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1.5" data-print-hide>
          <button
            type="button"
            onClick={() => printCard(cardRef.current)}
            title="Print just this metric — its chart, its figures and its definition — or save it as a PDF from the print dialog."
            className="inline-flex cursor-pointer items-center gap-1 rounded-md border border-border px-2 py-0.5 text-[length:var(--bw-fs-11)] text-muted-foreground transition-colors duration-150 hover:bg-muted hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <Printer className="size-3" aria-hidden />
            Print
          </button>
          <button
            type="button"
            onClick={onClose}
            className="inline-flex cursor-pointer items-center gap-1 rounded-md border border-border px-2 py-0.5 text-[length:var(--bw-fs-11)] text-muted-foreground transition-colors duration-150 hover:bg-muted hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <X className="size-3" aria-hidden />
            Close
          </button>
        </div>
      </header>

      {row.restricted ? (
        <div className="flex flex-col items-center justify-center gap-2 px-6 py-14 text-center">
          <Lock className="size-5 text-muted-foreground" aria-hidden />
          <p className="text-[length:var(--bw-fs-14)] leading-[var(--bw-lh-sm)] font-medium">
            ₱ figures are restricted for your role
          </p>
          <p className="max-w-[440px] text-[length:var(--bw-fs-12)] leading-relaxed text-muted-foreground">
            Purchase prices and inventory value are withheld server-side for the
            Production role, so nothing was sent to this browser. Every other row
            on this page is live.
          </p>
        </div>
      ) : (
        <div className="flex flex-col gap-3 p-3">
          {/* Summary strip — the same four questions every drill-down answers. */}
          {/* Every label carries `· selected` while the checklist is filtered.
              "Highest" over three chosen years is a different claim from
              "Highest" over the whole record, and an unlabelled stat that
              quietly changed meaning is the one thing a filter must not do. */}
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <DrilldownStat
              label={`Latest${selectedSuffix}`}
              value={latest?.value == null ? "—" : fmtExact(spec, latest.value)}
              unit={latest?.value == null ? undefined : statGlyph}
              unitSide="left"
              sub={latest?.fullLabel}
              title={
                isFiltered
                  ? "The newest period among the years you left switched on."
                  : undefined
              }
            />
            {selectionFold ? (
              <DrilldownStat
                label="Selected"
                value={
                  selectionFold.value == null
                    ? "—"
                    : fmtExact(spec, selectionFold.value)
                }
                unit={selectionFold.value == null ? undefined : statGlyph}
                unitSide="left"
                // R4 — `withValue`, the SAME count the chart header prints, so
                // the strip and the chart can never appear to disagree. See
                // the block comment on `withValue`.
                sub={`${shownYearCount} of ${yearOptions.length} years · ${withValue} ${nouns} with a figure`}
                title={`Folded over the years you left switched on, by this row's own rule — ${spec.dictionary.rollup} It is never an average of the points on the chart. The ${noun} count is how many carry a figure; ${selectionFold.periodCount} ${nouns} are in the selection in all.`}
              />
            ) : (
              <DrilldownStat
                label={totalLabel}
                value={
                  row.total?.value == null ? "—" : fmtExact(spec, row.total.value)
                }
                unit={row.total?.value == null ? undefined : statGlyph}
                unitSide="left"
                sub={totalFullLabel}
                title={`How the ${totalLabel} column is built: ${spec.dictionary.rollup}`}
              />
            )}
            <DrilldownStat
              label={`Highest${selectedSuffix}`}
              value={high ? fmtExact(spec, high.value) : "—"}
              unit={high ? statGlyph : undefined}
              unitSide="left"
              sub={high?.fullLabel}
              title={recordScope}
            />
            <DrilldownStat
              label={`Lowest${selectedSuffix}`}
              value={low ? fmtExact(spec, low.value) : "—"}
              unit={low ? statGlyph : undefined}
              unitSide="left"
              sub={low?.fullLabel}
              title={recordScope}
            />
          </div>

          <div
            className={cn(
              "grid grid-cols-1 gap-3",
              sideRail && "lg:grid-cols-[1fr_320px]",
            )}
          >
            <DrilldownSection
              className="print:break-inside-avoid"
              title={
                isFiltered
                  ? `${spec.label} — the years you chose`
                  : `${spec.label} — every ${noun} on record`
              }
              subtitle={chartSubtitle}
              action={
                // `data-print-hide` — a control is not part of the report.
                <span className="flex flex-wrap items-center justify-end gap-1.5" data-print-hide>
                  {/* R4 — the price overlay. Purchase volume only, default
                      OFF, and absent entirely for a role that may not see a
                      peso (see `priceOverlay` on the props). */}
                  {overlayRow && (
                    <ChartToggle
                      on={showOverlay}
                      onChange={setShowOverlay}
                      label="Overlay price"
                      color={overlayRow.metric.color}
                      title={
                        showOverlay
                          ? `Hide the ${overlayRow.metric.label} line. It rides its own axis on the right, because a ₱/kg and a tonnage share no scale — it is the same figure that row publishes, not a second calculation.`
                          : `Draw the ${overlayRow.metric.label} line over these bars, on its own axis to the right. It is the very figure that row publishes, folded by the same rule, so the two can never disagree.`
                      }
                    />
                  )}
                  {/* Only where a trailing average can exist at all — see
                      `canDrawAvg`. A switch for a line the chart would never
                      draw is a control that lies about what the page can do. */}
                  {avgAvailable && (
                    <ChartToggle
                      on={showAvg}
                      onChange={setShowAvg}
                      label={`3-${noun} avg`}
                      color={spec.avgColor}
                      title={
                        showAvg
                          ? `Hide the 3-${noun} avg line. It is a trailing mean over the last three ${nouns} and it breaks at a gap rather than drawing across one — hiding it changes nothing else on the chart, and the printed sheet follows whatever you leave switched on.`
                          : `Draw the 3-${noun} avg line — a trailing mean over the last three ${nouns}, which breaks at a gap rather than drawing across one.`
                      }
                    />
                  )}
                  <PeriodFilter
                    label="Years"
                    noun="year"
                    align="end"
                    options={yearOptions}
                    hidden={hiddenYears}
                    onChange={setHiddenYears}
                    // R4 — the copy follows the smart default. Saying "every
                    // year is on by default" beside a control that opens with
                    // four years off would be the page contradicting itself.
                    title={`Choose which years this chart draws. It opens with the years that actually carry a figure for this row — the rest are listed with a 0/… count and one click brings them back. Hiding a year removes its points and its share of the figures above; it never changes what a remaining ${noun} says, and a rolling average breaks at the gap rather than drawing across it.`}
                  />
                </span>
              }
              bodyClassName="p-2 pb-1"
            >
              <MetricTrendChart
                spec={spec}
                history={view.history}
                pairHistory={view.pair}
                overlay={
                  overlayRow && showOverlay && view.overlay
                    ? { spec: overlayRow.metric, history: view.overlay }
                    : null
                }
                granularity={granularity}
                showAvg={showAvg}
                emptyText={
                  isFiltered
                    ? "Every year is switched off. Open the Years filter and turn one back on — nothing has been discarded."
                    : undefined
                }
              />
              {spec.pair && (
                <p className="px-1 pb-1 pt-1.5 text-[length:var(--bw-fs-12)] leading-relaxed text-muted-foreground">
                  {spec.pair.note}
                </p>
              )}
              {/* The honesty line the filter owes. Hiding a year changes what
                  is DRAWN; it never changes what a drawn figure means. */}
              {isFiltered && (
                <p className="px-1 pb-1 pt-1.5 text-[length:var(--bw-fs-12)] leading-relaxed text-muted-foreground">
                  Showing{" "}
                  <span className="font-medium text-foreground">
                    {selectedYearsNote}
                  </span>
                  . This card opens on the years that carry a figure for this
                  row; the rest are one click away in{" "}
                  <span className="font-medium text-foreground">Years</span>.
                  Hidden years are still in the record and still stand behind
                  every comparison — a change is measured against the period
                  that really precedes it, on screen or not.
                  {/* Only claimed while the line is actually drawn — a sentence
                      describing a series the reader has switched off is a
                      sentence about something that is not on the chart. */}
                  {avgAvailable && showAvg && (
                    <>
                      {" "}
                      The trailing average is recomputed over what is left and{" "}
                      <strong className="font-semibold">breaks at the gap</strong>{" "}
                      rather than drawing across a year you put away.
                    </>
                  )}
                </p>
              )}
              {/* P4 — the row's OWN caveats, named period by period. The
                  chart draws a GAP where a figure is suppressed (power
                  intensity, March 2026) and the note beside it is the only
                  thing that says a gap is deliberate rather than missing. */}
              {annotated.length > 0 && (
                <ul className="flex flex-col gap-1 px-1 pb-1 pt-1.5">
                  {annotated.map((h) => (
                    <li
                      key={h.periodKey}
                      className="flex items-start gap-1.5 text-[length:var(--bw-fs-12)] leading-relaxed text-muted-foreground"
                    >
                      <span
                        aria-hidden
                        className="mt-px shrink-0 text-[length:var(--bw-fs-10)] text-amber-600 dark:text-amber-400"
                      >
                        {h.annotation?.mark || "·"}
                      </span>
                      <span>
                        <strong className="font-medium text-foreground">
                          {h.fullLabel}
                        </strong>{" "}
                        {h.annotation?.title}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </DrilldownSection>

            {sideRail}
          </div>

          {/* The dictionary, spelled out — the same copy the row's info button
              shows, so the two can never drift.
              OWNER FEEDBACK R3: behind the page's `Definitions` switch. When it
              is off these blocks are not RENDERED, so the panel is genuinely
              shorter (the whole point — they push the chart up the screen) and
              a printed sheet carries whatever the reader had on screen rather
              than quietly re-adding two paragraphs they had put away. The row
              name's own Info popover is unaffected and still explains the
              figure at the point of use. */}
          {showDictionary && (
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2" data-print-block>
            <div className="rounded-lg border bg-background/40 px-3 py-2">
              <div className="text-[length:var(--bw-fs-105)] font-medium uppercase tracking-wide text-muted-foreground">
                What it is
              </div>
              <p className="mt-1 text-[length:var(--bw-fs-12)] leading-relaxed">
                {spec.dictionary.definition}
              </p>
              <p className="mt-1.5 text-[length:var(--bw-fs-12)] leading-relaxed text-muted-foreground">
                <span className="font-medium text-foreground">Worked out as: </span>
                {spec.dictionary.basis}
              </p>
              {spec.dictionary.exclusions && (
                <p className="mt-1.5 text-[length:var(--bw-fs-12)] leading-relaxed text-muted-foreground">
                  <span className="font-medium text-foreground">Leaves out: </span>
                  {spec.dictionary.exclusions}
                </p>
              )}
            </div>
            <div className="rounded-lg border bg-background/40 px-3 py-2">
              <div className="text-[length:var(--bw-fs-105)] font-medium uppercase tracking-wide text-muted-foreground">
                Quarter &amp; year columns
              </div>
              <p className="mt-1 text-[length:var(--bw-fs-12)] leading-relaxed">
                {spec.dictionary.rollup}
              </p>
              {spec.dictionary.caveat && (
                <p className="mt-1.5 text-[length:var(--bw-fs-12)] leading-relaxed text-muted-foreground">
                  <span className="font-medium text-foreground">Worth knowing: </span>
                  {spec.dictionary.caveat}
                </p>
              )}
              <p className="mt-1.5 font-mono text-[length:var(--bw-fs-10)] text-muted-foreground/80">
                {spec.dictionary.source}
              </p>
            </div>
          </div>
          )}

          {/* Paper only — the page's own restatement policy, travelling with
              the figure rather than staying behind on the screen. */}
          <p className="hidden text-[length:var(--bw-fs-10)] leading-relaxed text-muted-foreground print:block">
            Figures reflect the underlying records as of{" "}
            {asOfDate ?? "today"}; nothing is snapshotted, so corrections to
            past records restate history (audited). A blank is never a zero.
          </p>
        </div>
      )}
    </section>
  );
}
