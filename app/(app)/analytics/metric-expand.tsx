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
import type { HistoryPoint, MatrixRow, Period } from "@/lib/analytics/matrix";
import {
  foldSelection,
  GRANULARITY_LABEL,
  rollingMean,
  rollingWindowFor,
  type Granularity,
} from "@/lib/analytics/matrix";
import { fmtCompact, unitSuffix } from "@/lib/analytics/format";
import type { AnalyticsMonth } from "@/lib/analytics/types";
import type { MetricSpec } from "@/lib/analytics/metrics";
import { PeriodFilter, type PeriodFilterOption } from "./period-filter";
import { NO_HIDDEN } from "@/lib/analytics/period-selection";

// R3: a CSS variable, not a number. The expand chart is the "see things
// clearer" payload, so it grows 260 -> 340 px above 1920 px — and because
// `ResponsiveContainer` is `height="100%"` inside this box, recharts
// re-measures for free with no `matchMedia` and no hydration seam.
const CHART_HEIGHT = "var(--an-chart)";

function bucketNounFor(g: Granularity): string {
  return g === "M" ? "month" : g === "Q" ? "quarter" : "year";
}

function fmtExact(spec: MetricSpec, v: number): string {
  const n = v.toLocaleString("en-US", {
    minimumFractionDigits: spec.decimals,
    maximumFractionDigits: spec.decimals,
  });
  switch (spec.unit) {
    case "php":
      return `₱${n}`;
    case "php_per_kg":
      return `₱${n}`;
    case "pct":
      return `${n}%`;
    default:
      return n;
  }
}

/** Axis / tooltip magnitude — compact for pesos, exact for everything else. */
function fmtAxis(spec: MetricSpec, v: number): string {
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
function canDrawAvg(spec: MetricSpec, granularity: Granularity): boolean {
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
 */
function AvgToggle({
  on,
  onChange,
  label,
  color,
  noun,
}: {
  on: boolean;
  onChange(next: boolean): void;
  label: string;
  color: string;
  noun: string;
}) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={on}
      onClick={() => onChange(!on)}
      title={
        on
          ? `Hide the ${label} line. It is a trailing mean over the last three ${noun}s and it breaks at a gap rather than drawing across one — hiding it changes nothing else on the chart, and the printed sheet follows whatever you leave switched on.`
          : `Draw the ${label} line — a trailing mean over the last three ${noun}s, which breaks at a gap rather than drawing across one.`
      }
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

function MetricTrendChart({
  spec,
  history,
  pairHistory,
  granularity,
  showAvg,
  emptyText,
}: {
  spec: MetricSpec;
  history: readonly HistoryPoint[];
  /** The comparison series, folded by the SAME rollup rules. Null when none. */
  pairHistory: readonly HistoryPoint[] | null;
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
  const data = history.map((h) => ({
    ...h,
    pair: pair ? (pairByKey.get(h.periodKey) ?? null) : null,
  }));

  const values = data
    .flatMap((h) => [h.value, h.pair])
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
          <RTooltip
            {...tip}
            formatter={(value, name) => [
              value == null ? "—" : `${fmtExact(spec, Number(value))} ${unit}`,
              name === "avg" ? avgLabel : name === "pair" ? (pair?.label ?? "") : spec.label,
            ]}
            labelFormatter={(label, payload) =>
              payload?.[0]?.payload?.fullLabel ?? label
            }
          />
          <Legend
            wrapperStyle={{ fontSize: "var(--bw-fs-11)", paddingTop: 4 }}
            formatter={(v) =>
              v === "avg" ? avgLabel : v === "pair" ? (pair?.label ?? "") : spec.label
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
            <Line
              type="monotone"
              dataKey="value"
              name="value"
              stroke={spec.color}
              strokeWidth={2}
              dot={granularity === "M" ? false : { r: 2.5 }}
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
 * WHY A MONEY ROW'S BLANK IS BLANK, as numbers rather than as a sentence.
 *
 * `view_rc_movement_month_price` prices a month's fed kilos through each fed
 * batch's own deliveries, so a batch with no delivery rows at all — old
 * pre-system stock, and the L-042 `FEEDING # 2` phantom — puts KILOS in the
 * denominator and NOTHING in the numerator. The published price is therefore
 * understated by exactly the share of untraceable kilos, which is the thing
 * this rail makes visible.
 */
function CoverageSplit({ month }: { month: AnalyticsMonth }) {
  const traceable = month.fedKgPriceTraceable ?? 0;
  const untraceable = month.fedKgPriceUntraceable ?? 0;
  const total = traceable + untraceable;
  // Three zero bars say less than one sentence. When there is nothing to
  // split, the rail's own empty state is the honest render.
  const items: RailItem[] = total <= 0 ? [] : [
    {
      key: "traceable",
      label: "Kilos the price can see",
      value: (traceable / 1000).toLocaleString("en-US", { maximumFractionDigits: 1 }),
      unit: "t",
      sharePct: total > 0 ? (traceable / total) * 100 : 0,
      title: "Fed out of piles that have delivery records, so every kilo carries a price.",
    },
    {
      key: "untraceable",
      label: "Kilos with no delivery record",
      value: (untraceable / 1000).toLocaleString("en-US", { maximumFractionDigits: 1 }),
      unit: "t",
      sharePct: total > 0 ? (untraceable / total) * 100 : 0,
      title:
        "Old pre-system stock, and the misfiled pile the sync could never place. Real charcoal, no price.",
    },
  ];
  return (
    <div className="flex flex-col gap-2">
      <BreakdownRail items={items} emptyText="Nothing fed this month." maxHeight={120} />
      <p className="px-3 pb-1 text-[length:var(--bw-fs-115)] leading-relaxed text-muted-foreground">
        Untraceable kilos drag the raw published price DOWN, because they add
        weight to the sum and no money.{" "}
        <strong className="font-semibold">
          What this page shows is the price of the kilos it CAN trace
        </strong>{" "}
        — the honest answer — and any figure resting on less than full coverage
        is marked <span className="font-mono">~</span> and is never quoted as a
        record or a biggest move.
      </p>
    </div>
  );
}

/** What the closed-block ₱ figures do and do not cover, that month. */
function ClosedBlocksSplit({ month }: { month: AnalyticsMonth }) {
  const priced = month.closedBlocksInPrice ?? 0;
  const unpriced = month.closedBlocksUnpriced ?? 0;
  const noDelivery = month.closedBlocksNoDelivery ?? 0;
  const total = priced + unpriced + noDelivery;
  const items: RailItem[] = total <= 0 ? [] : [
    {
      key: "priced",
      label: "Closed and fully priced",
      value: String(priced),
      unit: "blocks",
      sharePct: total > 0 ? (priced / total) * 100 : 0,
      title: "The only blocks the peso figures are measured over.",
    },
    {
      key: "unpriced",
      label: "Awaiting a price",
      value: String(unpriced),
      unit: "blocks",
      sharePct: total > 0 ? (unpriced / total) * 100 : 0,
      title:
        "Closed, but at least one truckload has no price yet — left out entirely rather than valued at part of its money.",
    },
    {
      key: "no_delivery",
      label: "No delivery record",
      value: String(noDelivery),
      unit: "blocks",
      sharePct: total > 0 ? (noDelivery / total) * 100 : 0,
      title: "Nothing to value at all.",
    },
  ];
  return (
    <div className="flex flex-col gap-2">
      <BreakdownRail items={items} emptyText="No block closed this month." maxHeight={130} />
      <p className="px-3 pb-1 text-[length:var(--bw-fs-115)] leading-relaxed text-muted-foreground">
        A block with one truckload still awaiting its price is left out{" "}
        <strong className="font-semibold">entirely</strong>, never valued at part
        of its money — a numerator missing pesos against a full denominator would
        understate the cost and point the exact opposite way from what this row
        exists to show. The loss percentage has no such restriction: weight is
        physical, so it uses every closed block.
      </p>
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
function DowntimeSplit({ month }: { month: AnalyticsMonth }) {
  const withDuration = month.downtimeShiftsWithDuration ?? 0;
  const reasonOnly = month.downtimeShiftsReasonOnly ?? 0;
  const records = month.downtimeShiftCount ?? 0;
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
      <BreakdownRail items={items} emptyText="No downtime record this month." maxHeight={130} />
      <p className="px-3 pb-1 text-[length:var(--bw-fs-115)] leading-relaxed text-muted-foreground">
        A downtime total of zero can mean two completely different things.{" "}
        <strong className="font-semibold">
          A shift that named the repair and left the duration blank is real
          downtime the hours cannot see
        </strong>{" "}
        — August 2026 is 23 shifts of exactly that, which is why its 0.00 hours
        is marked and can never be quoted as a record. Nothing is estimated in
        to fill the gap; the count is what makes the gap visible.
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
function PowerSplit({ month }: { month: AnalyticsMonth }) {
  const total = month.kwh ?? 0;
  const suspect = month.kwhSuspectKwh ?? 0;
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
      meta: `${month.kwhSuspectReadingCount ?? 0} reading${(month.kwhSuspectReadingCount ?? 0) === 1 ? "" : "s"}`,
      value: suspect.toLocaleString("en-US", { maximumFractionDigits: 0 }),
      unit: "kWh",
      sharePct: (suspect / total) * 100,
      title:
        "A starting reading left at zero against an end that was still climbing. A start of zero is only a genuine meter reset when the counter WRAPPED — this one did not.",
    },
  ].filter((i) => i.sharePct > 0);
  return (
    <div className="flex flex-col gap-2">
      <BreakdownRail items={items} emptyText="No meter reading this month." maxHeight={120} />
      <p className="px-3 pb-1 text-[length:var(--bw-fs-115)] leading-relaxed text-muted-foreground">
        The kWh total is published{" "}
        <strong className="font-semibold">exactly as metered</strong> — it is
        the record, and it must agree with the daily power tile on the home
        page. The power-intensity row is where a mis-keyed reading is taken
        out, because a wrong reading there does not look wrong, it looks like a
        twenty-fold efficiency collapse. Nothing on this page corrects the
        underlying reading.{" "}
        {month.powerMeterCount != null && (
          <>
            {month.powerMeterCount} meter
            {month.powerMeterCount === 1 ? "" : "s"} reported over{" "}
            {month.powerDays ?? 0} day{(month.powerDays ?? 0) === 1 ? "" : "s"}.
          </>
        )}
      </p>
    </div>
  );
}

/**
 * Which side panel a row earns, if any. Declared here rather than on the
 * registry because it is a LAYOUT fact about this component — the registry
 * describes numbers, not which pane they sit beside.
 */
type SidePanel = "coverage" | "closed" | "aging" | "downtime" | "power" | null;

function sidePanelFor(key: MetricSpec["key"]): SidePanel {
  switch (key) {
    case "delivered_fed_price":
    case "php_per_produced":
      return "coverage";
    case "closed_true_price":
    case "closed_loss":
    case "closed_blocks":
      return "closed";
    case "stock_age":
    case "over_120d":
      return "aging";
    case "downtime_hours":
      return "downtime";
    case "power_kwh":
    case "power_intensity":
      return "power";
    default:
      return null;
  }
}

/**
 * PRINT ONE CARD.
 *
 * `bw-printing` on <body> is what the print stylesheet keys off, and every
 * ancestor from the card up to <body> is tagged `data-print-ancestor` so the
 * sheet can `display: none` everything ELSE rather than merely hide it. That
 * distinction is the whole mechanism — see the block comment on the print
 * rules in `globals.css`: hiding by visibility leaves the page's full height
 * behind and the card lands on page three of a mostly blank document.
 *
 * Both marks come off on `afterprint`, whether the user printed, saved a PDF
 * or cancelled the dialog. The `setTimeout` fallback is there because not every
 * engine fires `afterprint` on a dismissed dialog, and a body left in the
 * printing class would print the wrong thing NEXT time.
 */
function printCard(card: HTMLElement | null) {
  if (typeof document === "undefined" || !card) return;
  const body = document.body;

  const tagged: HTMLElement[] = [];
  for (
    let el: HTMLElement | null = card.parentElement;
    el && el !== document.documentElement;
    el = el.parentElement
  ) {
    el.setAttribute("data-print-ancestor", "");
    tagged.push(el);
  }

  const clear = () => {
    body.classList.remove("bw-printing");
    for (const el of tagged) el.removeAttribute("data-print-ancestor");
  };

  body.classList.add("bw-printing");
  window.addEventListener("afterprint", clear, { once: true });
  window.setTimeout(clear, 1000);
  window.print();
}

export interface MetricExpandProps {
  row: MatrixRow;
  granularity: Granularity;
  /**
   * The COMPLETE period axis at this granularity (`Matrix.allPeriods`). The
   * year checklist folds whatever survives it into the window stat, and it has
   * to be periods rather than the row's own history points because a rollup
   * needs the MONTHS underneath — a price over a selection is Σ pesos ÷ Σ
   * priced kilos, which no amount of averaging the points can produce.
   */
  allPeriods: readonly Period[];
  /**
   * The options the matrix itself was folded with (`Matrix.foldOptions`).
   * Passed through rather than re-derived so a selection can never be folded
   * under different rules than the grid it sits inside.
   */
  foldOptions: { canViewPrices: boolean; perWorkingDay: boolean };
  /** Header for the trailing summary column, so the strip names the window. */
  totalLabel: string;
  totalFullLabel: string;
  /** The newest month inside the displayed window — the split panel's subject. */
  anchorMonth: AnalyticsMonth | null;
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
  onClose(): void;
}

export function MetricExpand({
  row,
  granularity,
  allPeriods,
  foldOptions,
  totalLabel,
  totalFullLabel,
  anchorMonth,
  perWorkingDay,
  scopeLabel,
  asOfDate,
  showDictionary,
  onClose,
}: MetricExpandProps) {
  const spec = row.metric;
  const cardRef = React.useRef<HTMLElement | null>(null);
  const noun = bucketNounFor(granularity);
  const unit = unitSuffix(spec.unit);
  const normalised = perWorkingDay && spec.perWorkingDay;
  const sidePanel = sidePanelFor(spec.key);

  // ── THE YEAR CHECKLIST (owner feedback R2) ──────────────────────────────
  // Session state, keyed to this card, never to the URL — see the block
  // comment at the top of the file. The state is the HIDDEN set, so the
  // "always default to all checked" requirement is a property of the shape.
  const [hiddenYears, setHiddenYears] =
    React.useState<ReadonlySet<string>>(NO_HIDDEN);
  const isFiltered = hiddenYears.size > 0;

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
            : `${y} — ${e.withValue} of ${e.total} ${noun}s carry a figure.`,
      }));
  }, [row.history, granularity, noun]);

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
    if (!isFiltered) {
      return { history: row.history, pair: row.pairHistory };
    }
    const keep = (h: HistoryPoint) => !hiddenYears.has(String(h.year));
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
    };
  }, [row.history, row.pairHistory, hiddenYears, isFiltered, rollWindow]);

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
    return foldSelection(spec, selected, foldOptions);
  }, [isFiltered, allPeriods, hiddenYears, spec, foldOptions]);

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
    `Across ${comparable.length} comparable ${noun}s.` +
    ` An in-progress ${noun} cannot set a record, and neither can an estimate or the first ${noun} a figure was ever recorded.` +
    (excluded > 0
      ? ` ${excluded} settled ${noun}${excluded === 1 ? " is" : "s are"} held out on those grounds.`
      : "") +
    (isFiltered
      ? ` Only the ${shownYearCount} year${shownYearCount === 1 ? "" : "s"} you left switched on are considered — this is the highest and lowest of the SELECTION, not of the whole record.`
      : "");

  /** What the chart card's own header says it is drawing. */
  const chartSubtitle = isFiltered
    ? `${settled.length} settled ${noun}s · ${shownYearCount}/${yearOptions.length} years`
    : granularity === "Y"
      ? `${settled.length} settled ${noun}s`
      : `${settled.length} settled ${noun}s · shaded band is the window above`;

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
              unit={latest?.value == null ? undefined : unit}
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
                unit={selectionFold.value == null ? undefined : unit}
                sub={`${shownYearCount} of ${yearOptions.length} years · ${selectionFold.periodCount} ${noun}s`}
                title={`Folded over the years you left switched on, by this row's own rule — ${spec.dictionary.rollup} It is never an average of the points on the chart.`}
              />
            ) : (
              <DrilldownStat
                label={totalLabel}
                value={
                  row.total?.value == null ? "—" : fmtExact(spec, row.total.value)
                }
                unit={row.total?.value == null ? undefined : unit}
                sub={totalFullLabel}
                title={`How the ${totalLabel} column is built: ${spec.dictionary.rollup}`}
              />
            )}
            <DrilldownStat
              label={`Highest${selectedSuffix}`}
              value={high ? fmtExact(spec, high.value) : "—"}
              unit={high ? unit : undefined}
              sub={high?.fullLabel}
              title={recordScope}
            />
            <DrilldownStat
              label={`Lowest${selectedSuffix}`}
              value={low ? fmtExact(spec, low.value) : "—"}
              unit={low ? unit : undefined}
              sub={low?.fullLabel}
              title={recordScope}
            />
          </div>

          <div
            className={cn(
              "grid grid-cols-1 gap-3",
              (spec.key === "ending_inventory" || sidePanel) &&
                "lg:grid-cols-[1fr_320px]",
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
                <span className="flex items-center gap-1.5" data-print-hide>
                  {/* Only where a trailing average can exist at all — see
                      `canDrawAvg`. A switch for a line the chart would never
                      draw is a control that lies about what the page can do. */}
                  {avgAvailable && (
                    <AvgToggle
                      on={showAvg}
                      onChange={setShowAvg}
                      label={`3-${noun} avg`}
                      color={spec.avgColor}
                      noun={noun}
                    />
                  )}
                  <PeriodFilter
                    label="Years"
                    noun="year"
                    align="end"
                    options={yearOptions}
                    hidden={hiddenYears}
                    onChange={setHiddenYears}
                    title={`Choose which years this chart draws. Every year is on by default. Hiding one removes its points and its share of the figures above — it never changes what a remaining ${noun} says, and a rolling average breaks at the gap rather than drawing across it.`}
                  />
                </span>
              }
              bodyClassName="p-2 pb-1"
            >
              <MetricTrendChart
                spec={spec}
                history={view.history}
                pairHistory={view.pair}
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
                  . Hidden years are still in the record and still stand behind
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

            {spec.key === "ending_inventory" && anchorMonth && (
              <DrilldownSection
                title="What the net is made of"
                subtitle={anchorMonth.monthStart.slice(0, 7)}
                bodyClassName="p-0"
              >
                <InventorySplit month={anchorMonth} />
              </DrilldownSection>
            )}

            {sidePanel === "coverage" && anchorMonth && (
              <DrilldownSection
                title="What the price can speak for"
                subtitle={anchorMonth.monthStart.slice(0, 7)}
                bodyClassName="p-0"
              >
                <CoverageSplit month={anchorMonth} />
              </DrilldownSection>
            )}

            {sidePanel === "closed" && anchorMonth && (
              <DrilldownSection
                title="Blocks that closed"
                subtitle={anchorMonth.monthStart.slice(0, 7)}
                bodyClassName="p-0"
              >
                <ClosedBlocksSplit month={anchorMonth} />
              </DrilldownSection>
            )}

            {sidePanel === "aging" && anchorMonth && (
              <DrilldownSection
                title="How the yard is aged"
                subtitle={anchorMonth.monthStart.slice(0, 7)}
                bodyClassName="p-0"
              >
                <AgingSplit month={anchorMonth} />
              </DrilldownSection>
            )}

            {sidePanel === "downtime" && anchorMonth && (
              <DrilldownSection
                title="What the downtime records say"
                subtitle={anchorMonth.monthStart.slice(0, 7)}
                bodyClassName="p-0"
              >
                <DowntimeSplit month={anchorMonth} />
              </DrilldownSection>
            )}

            {sidePanel === "power" && anchorMonth && (
              <DrilldownSection
                title="What the meters recorded"
                subtitle={anchorMonth.monthStart.slice(0, 7)}
                bodyClassName="p-0"
              >
                <PowerSplit month={anchorMonth} />
              </DrilldownSection>
            )}
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
