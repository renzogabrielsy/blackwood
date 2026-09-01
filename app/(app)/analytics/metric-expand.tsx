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
import { Lock, Printer, X } from "lucide-react";
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
      <ul className="flex flex-col gap-1.5 px-3 pb-1 text-[11.5px] leading-relaxed text-muted-foreground">
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
      <p className="px-3 pb-1 text-[11.5px] leading-relaxed text-muted-foreground">
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
      <p className="px-3 pb-1 text-[11.5px] leading-relaxed text-muted-foreground">
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
      <p className="px-3 pb-1 text-[11.5px] leading-relaxed text-muted-foreground">
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
      <p className="px-3 pb-1 text-[11.5px] leading-relaxed text-muted-foreground">
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
      <p className="px-3 pb-1 text-[11.5px] leading-relaxed text-muted-foreground">
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
  onClose(): void;
}

export function MetricExpand({
  row,
  granularity,
  totalLabel,
  totalFullLabel,
  anchorMonth,
  perWorkingDay,
  scopeLabel,
  asOfDate,
  onClose,
}: MetricExpandProps) {
  const spec = row.metric;
  const cardRef = React.useRef<HTMLElement | null>(null);
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
        <h1 className="text-base font-semibold tracking-tight">{spec.label}</h1>
        <p className="text-[11px] text-muted-foreground">
          {normalised ? `${spec.sublabel} / working day` : spec.sublabel} ·{" "}
          {scopeLabel} · {GRANULARITY_LABEL[granularity].toLowerCase()} columns
          {asOfDate ? ` · records through ${asOfDate}` : ""}
        </p>
      </div>

      <header className="flex flex-wrap items-baseline justify-between gap-2 border-b px-3 py-2 print:hidden">
        <div className="min-w-0">
          <h3 className="truncate text-sm font-semibold tracking-tight">
            {spec.label}
          </h3>
          <p className="truncate text-[11.5px] text-muted-foreground">
            {normalised ? `${spec.sublabel} / working day` : spec.sublabel} ·{" "}
            {GRANULARITY_LABEL[granularity].toLowerCase()} history, all records
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1.5" data-print-hide>
          <button
            type="button"
            onClick={() => printCard(cardRef.current)}
            title="Print just this metric — its chart, its figures and its definition — or save it as a PDF from the print dialog."
            className="inline-flex cursor-pointer items-center gap-1 rounded-md border border-border px-2 py-0.5 text-[11px] text-muted-foreground transition-colors duration-150 hover:bg-muted hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <Printer className="size-3" aria-hidden />
            Print
          </button>
          <button
            type="button"
            onClick={onClose}
            className="inline-flex cursor-pointer items-center gap-1 rounded-md border border-border px-2 py-0.5 text-[11px] text-muted-foreground transition-colors duration-150 hover:bg-muted hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <X className="size-3" aria-hidden />
            Close
          </button>
        </div>
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
              className="print:break-inside-avoid"
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
                <p className="px-1 pb-1 pt-1.5 text-xs leading-relaxed text-muted-foreground">
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
                      className="flex items-start gap-1.5 text-xs leading-relaxed text-muted-foreground"
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
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2" data-print-block>
            <div className="rounded-lg border bg-background/40 px-3 py-2">
              <div className="text-[10.5px] font-medium uppercase tracking-wide text-muted-foreground">
                What it is
              </div>
              <p className="mt-1 text-xs leading-relaxed">
                {spec.dictionary.definition}
              </p>
              <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">
                <span className="font-medium text-foreground">Worked out as: </span>
                {spec.dictionary.basis}
              </p>
              {spec.dictionary.exclusions && (
                <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">
                  <span className="font-medium text-foreground">Leaves out: </span>
                  {spec.dictionary.exclusions}
                </p>
              )}
            </div>
            <div className="rounded-lg border bg-background/40 px-3 py-2">
              <div className="text-[10.5px] font-medium uppercase tracking-wide text-muted-foreground">
                Quarter &amp; year columns
              </div>
              <p className="mt-1 text-xs leading-relaxed">
                {spec.dictionary.rollup}
              </p>
              {spec.dictionary.caveat && (
                <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">
                  <span className="font-medium text-foreground">Worth knowing: </span>
                  {spec.dictionary.caveat}
                </p>
              )}
              <p className="mt-1.5 font-mono text-[10px] text-muted-foreground/80">
                {spec.dictionary.source}
              </p>
            </div>
          </div>

          {/* Paper only — the page's own restatement policy, travelling with
              the figure rather than staying behind on the screen. */}
          <p className="hidden text-[10px] leading-relaxed text-muted-foreground print:block">
            Figures reflect the underlying records as of{" "}
            {asOfDate ?? "today"}; nothing is snapshotted, so corrections to
            past records restate history (audited). A blank is never a zero.
          </p>
        </div>
      )}
    </section>
  );
}
