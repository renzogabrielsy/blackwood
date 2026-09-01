"use client";

// ─────────────────────────────────────────────────────────────────────────────
// THE ROW EXPAND — one KPI's whole history, plus the honesty copy it owes.
//
// It renders BELOW the matrix rather than inside it, and that is a layout fact
// rather than a preference: the matrix is `table-fixed` inside an
// `overflow-x-auto` wrapper, so a `colSpan` panel would be as wide as the
// scrolling table (up to ~1,500px) and a chart in it would need horizontal
// scrolling to read. Below the table the panel is page-width and responsive,
// and the expanded row stays highlighted so the connection is never lost.
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
import { Lock, X } from "lucide-react";
import {
  DRILLDOWN_AXIS_TICK,
  DrilldownSection,
  DrilldownStat,
  drilldownTooltipChrome,
} from "@/components/digest/drilldown/drilldown-modal";
import { BreakdownRail } from "@/components/digest/drilldown/series-parts";
import type { RailItem } from "@/components/digest/drilldown/series-parts";
import { cn } from "@/lib/utils";
import type { HistoryPoint, MatrixRow } from "@/lib/analytics/matrix";
import { GRANULARITY_LABEL, type Granularity } from "@/lib/analytics/matrix";
import { fmtCompact, unitSuffix } from "@/lib/analytics/format";
import type { AnalyticsMonth } from "@/lib/analytics/types";
import type { MetricSpec } from "@/lib/analytics/metrics";

const CHART_HEIGHT = 260;

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

function MetricTrendChart({
  spec,
  history,
  pairHistory,
  granularity,
}: {
  spec: MetricSpec;
  history: readonly HistoryPoint[];
  /** The comparison series, folded by the SAME rollup rules. Null when none. */
  pairHistory: readonly HistoryPoint[] | null;
  granularity: Granularity;
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
      <p className="px-3 py-12 text-center text-xs text-muted-foreground">
        Nothing recorded for this metric yet.
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
            wrapperStyle={{ fontSize: "11px", paddingTop: 4 }}
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
          {/* No rolling mean at YEAR granularity — a 3-year trailing average
              over 7 points smooths away the only signal there is, and an
              always-empty series would still claim a legend entry. A pair
              chart drops it too: four lines in 260px reads as noise. */}
          {granularity !== "Y" && !pair && (
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
 * The ending-inventory split — the caveat the plan says the page OWES its
 * reader, rendered as numbers rather than as a sentence they have to trust.
 */
function InventorySplit({ month }: { month: AnalyticsMonth }) {
  const pos = month.positiveBalanceKg ?? 0;
  const neg = Math.abs(month.negativeBalanceKg ?? 0);
  const gross = pos + neg;
  const items: RailItem[] = [
    {
      key: "positive",
      label: "Piles holding stock",
      value: (pos / 1000).toLocaleString("en-US", { maximumFractionDigits: 1 }),
      unit: "t",
      sharePct: gross > 0 ? (pos / gross) * 100 : 0,
      title: "The positive half of the balance — this is what the peso value is priced against.",
    },
    {
      key: "negative",
      label: "Filed against the wrong pile",
      meta: `${month.negativeBatchCount ?? 0} batches`,
      value: `−${(neg / 1000).toLocaleString("en-US", { maximumFractionDigits: 1 })}`,
      unit: "t",
      sharePct: gross > 0 ? (neg / gross) * 100 : 0,
      title:
        "Charcoal fed out under one batch name whose arrival was booked under a different spelling of it. The kilos are real and in the yard.",
    },
  ];
  return (
    <div className="flex flex-col gap-2">
      <BreakdownRail items={items} emptyText="No balances." maxHeight={120} />
      <p className="px-3 pb-1 text-[11px] leading-relaxed text-muted-foreground">
        The headline is the NET of those two. The negative half is{" "}
        <strong className="font-semibold">misattribution, not evaporation</strong> —
        charcoal fed out under one batch name while its arrival was booked under a
        different spelling of that name. The two sides are the same physical yard, so
        they cancel in the total; the split is printed because a right number with an
        invisible hole in it is worse than a smaller one.
      </p>
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
      <p className="px-3 pb-1 text-[11px] leading-relaxed text-muted-foreground">
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
      <p className="px-3 pb-1 text-[11px] leading-relaxed text-muted-foreground">
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
      <p className="px-3 pb-1 text-[11px] leading-relaxed text-muted-foreground">
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
      <p className="px-3 pb-1 text-[11px] leading-relaxed text-muted-foreground">
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
      <p className="px-3 pb-1 text-[11px] leading-relaxed text-muted-foreground">
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

export interface MetricExpandProps {
  row: MatrixRow;
  granularity: Granularity;
  /** Header for the trailing summary column, so the strip names the window. */
  totalLabel: string;
  totalFullLabel: string;
  /** The newest month inside the displayed window — the split panel's subject. */
  anchorMonth: AnalyticsMonth | null;
  perWorkingDay: boolean;
  onClose(): void;
}

export function MetricExpand({
  row,
  granularity,
  totalLabel,
  totalFullLabel,
  anchorMonth,
  perWorkingDay,
  onClose,
}: MetricExpandProps) {
  const spec = row.metric;
  const noun = bucketNounFor(granularity);
  const unit = unitSuffix(spec.unit);
  const normalised = perWorkingDay && spec.perWorkingDay;
  const sidePanel = sidePanelFor(spec.key);

  const settled = React.useMemo(
    () =>
      row.history.filter(
        (h): h is HistoryPoint & { value: number } => !h.isPartial && h.value != null,
      ),
    [row.history],
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
    () => [...row.history].reverse().find((h) => h.value != null) ?? null,
    [row.history],
  );
  /**
   * The annotated periods INSIDE the displayed window, so the panel names them
   * rather than leaving a gap in the chart unexplained. Scoped to the window
   * on purpose: the chart draws all history, but a caveat about a period the
   * reader is not looking at is noise.
   */
  const annotated = React.useMemo(
    () => row.history.filter((h) => h.displayed && h.annotation),
    [row.history],
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
      : "");

  return (
    <section className="animate-fade-up rounded-lg border bg-card/60">
      <header className="flex flex-wrap items-baseline justify-between gap-2 border-b px-3 py-2">
        <div className="min-w-0">
          <h3 className="truncate text-sm font-semibold tracking-tight">
            {spec.label}
          </h3>
          <p className="truncate text-[11px] text-muted-foreground">
            {normalised ? `${spec.sublabel} / working day` : spec.sublabel} ·{" "}
            {GRANULARITY_LABEL[granularity].toLowerCase()} history, all records
          </p>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="inline-flex cursor-pointer items-center gap-1 rounded-md border border-border px-2 py-0.5 text-[10.5px] text-muted-foreground transition-colors duration-150 hover:bg-muted hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <X className="size-3" aria-hidden />
          Close
        </button>
      </header>

      {row.restricted ? (
        <div className="flex flex-col items-center justify-center gap-2 px-6 py-14 text-center">
          <Lock className="size-5 text-muted-foreground" aria-hidden />
          <p className="text-sm font-medium">
            ₱ figures are restricted for your role
          </p>
          <p className="max-w-[440px] text-xs leading-relaxed text-muted-foreground">
            Purchase prices and inventory value are withheld server-side for the
            Production role, so nothing was sent to this browser. Every other row
            on this page is live.
          </p>
        </div>
      ) : (
        <div className="flex flex-col gap-3 p-3">
          {/* Summary strip — the same four questions every drill-down answers. */}
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <DrilldownStat
              label="Latest"
              value={latest?.value == null ? "—" : fmtExact(spec, latest.value)}
              unit={latest?.value == null ? undefined : unit}
              sub={latest?.fullLabel}
            />
            <DrilldownStat
              label={totalLabel}
              value={
                row.total?.value == null ? "—" : fmtExact(spec, row.total.value)
              }
              unit={row.total?.value == null ? undefined : unit}
              sub={totalFullLabel}
              title={`How the ${totalLabel} column is built: ${spec.dictionary.rollup}`}
            />
            <DrilldownStat
              label="Highest"
              value={high ? fmtExact(spec, high.value) : "—"}
              unit={high ? unit : undefined}
              sub={high?.fullLabel}
              title={recordScope}
            />
            <DrilldownStat
              label="Lowest"
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
              title={`${spec.label} — every ${noun} on record`}
              subtitle={
                granularity === "Y"
                  ? `${settled.length} settled ${noun}s`
                  : `${settled.length} settled ${noun}s · shaded band is the window above`
              }
              bodyClassName="p-2 pb-1"
            >
              <MetricTrendChart
                spec={spec}
                history={row.history}
                pairHistory={row.pairHistory}
                granularity={granularity}
              />
              {spec.pair && (
                <p className="px-1 pb-1 pt-1.5 text-[11px] leading-relaxed text-muted-foreground">
                  {spec.pair.note}
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
                      className="flex items-start gap-1.5 text-[11px] leading-relaxed text-muted-foreground"
                    >
                      <span
                        aria-hidden
                        className="mt-px shrink-0 text-[10px] text-amber-600 dark:text-amber-400"
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
              shows, so the two can never drift. */}
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <div className="rounded-lg border bg-background/40 px-3 py-2">
              <div className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                How it is worked out
              </div>
              <p className="mt-1 text-[11.5px] leading-relaxed">
                {spec.dictionary.basis}
              </p>
              {spec.dictionary.exclusions && (
                <p className="mt-1.5 text-[11.5px] leading-relaxed text-muted-foreground">
                  <span className="font-medium text-foreground">Leaves out: </span>
                  {spec.dictionary.exclusions}
                </p>
              )}
            </div>
            <div className="rounded-lg border bg-background/40 px-3 py-2">
              <div className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                Quarter &amp; year columns
              </div>
              <p className="mt-1 text-[11.5px] leading-relaxed">
                {spec.dictionary.rollup}
              </p>
              {spec.dictionary.caveat && (
                <p className="mt-1.5 text-[11.5px] leading-relaxed text-muted-foreground">
                  <span className="font-medium text-foreground">Worth knowing: </span>
                  {spec.dictionary.caveat}
                </p>
              )}
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
