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
  granularity,
}: {
  spec: MetricSpec;
  history: readonly HistoryPoint[];
  granularity: Granularity;
}) {
  const tip = drilldownTooltipChrome();
  const noun = bucketNounFor(granularity);
  const avgLabel = `3-${noun} avg`;
  const unit = unitSuffix(spec.unit);

  const shown = history.filter((h) => h.displayed);
  const first = shown[0]?.label;
  const last = shown[shown.length - 1]?.label;

  const values = history
    .map((h) => h.value)
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
        <ComposedChart data={history as HistoryPoint[]} margin={{ top: 6, right: 8, bottom: 0, left: 0 }}>
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
              name === "avg" ? avgLabel : spec.label,
            ]}
            labelFormatter={(label, payload) =>
              payload?.[0]?.payload?.fullLabel ?? label
            }
          />
          <Legend
            wrapperStyle={{ fontSize: "11px", paddingTop: 4 }}
            formatter={(v) => (v === "avg" ? avgLabel : spec.label)}
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
          {/* No rolling mean at YEAR granularity — a 3-year trailing average
              over 7 points smooths away the only signal there is, and an
              always-empty series would still claim a legend entry. */}
          {granularity !== "Y" && (
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

  const settled = React.useMemo(
    () =>
      row.history.filter(
        (h): h is HistoryPoint & { value: number } => !h.isPartial && h.value != null,
      ),
    [row.history],
  );
  const latest = React.useMemo(
    () => [...row.history].reverse().find((h) => h.value != null) ?? null,
    [row.history],
  );
  const high = settled.length
    ? settled.reduce((a, b) => (b.value > a.value ? b : a))
    : null;
  const low = settled.length
    ? settled.reduce((a, b) => (b.value < a.value ? b : a))
    : null;

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
              title={`Across ${settled.length} settled ${noun}s. An in-progress ${noun} cannot set a record.`}
            />
            <DrilldownStat
              label="Lowest"
              value={low ? fmtExact(spec, low.value) : "—"}
              unit={low ? unit : undefined}
              sub={low?.fullLabel}
              title={`Across ${settled.length} settled ${noun}s. An in-progress ${noun} cannot set a record.`}
            />
          </div>

          <div
            className={cn(
              "grid grid-cols-1 gap-3",
              spec.key === "ending_inventory" && "lg:grid-cols-[1fr_320px]",
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
                granularity={granularity}
              />
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
