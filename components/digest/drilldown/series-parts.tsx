"use client";

// ─────────────────────────────────────────────────────────────────────────────
// SHARED DRILL-DOWN BODY PARTS — the three pieces every volume drill-down has.
//
// Lifted VERBATIM from the RC IN reference body (`rc-in-drilldown.tsx`), which
// now consumes them too, so there is ONE definition of:
//
//   • the truncation notice     — "every figure below is a floor"
//   • the bar + rolling-mean chart
//   • the ranked breakdown rail with share bars
//
// Five bodies (RC IN · RC OUT · Production · Power, and any future tile) render
// the same density, the same tokens and the same empty states because they call
// the same functions — not because five files were kept in step by hand.
//
// The chart chrome deliberately reuses `DRILLDOWN_AXIS_TICK` /
// `drilldownTooltipChrome` from the chassis, which are in turn the tokens
// `digest-charts.tsx` uses: an expanded chart must read as the BIG version of
// the small one.
// ─────────────────────────────────────────────────────────────────────────────

import * as React from "react";
import {
  Bar,
  CartesianGrid,
  ComposedChart,
  Legend,
  Line,
  ResponsiveContainer,
  Tooltip as RTooltip,
  XAxis,
  YAxis,
} from "recharts";
import { AlertTriangle } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  DRILLDOWN_AXIS_TICK,
  drilldownTooltipChrome,
} from "./drilldown-modal";
import type {
  DrilldownGranularity,
  VolumePoint,
} from "@/lib/digest/drilldown-types";

// ---------------------------------------------------------------------
// Bucket vocabulary — ONE place that decides what a bucket is CALLED
// ---------------------------------------------------------------------

/** "day" / "month" — the noun a summary strip uses for one bucket. */
export function bucketNoun(granularity: DrilldownGranularity): string {
  return granularity === "month" ? "month" : "day";
}

/** "7-day avg" / "3-month avg" — the rolling window, named for the granularity.
 *  The window sizes are the adapter's `ROLLING_BUCKETS`; this is their label. */
export function rollingLabel(granularity: DrilldownGranularity): string {
  return granularity === "month" ? "3-month avg" : "7-day avg";
}

/**
 * The header suffix that states WHICH DAY a lag-by-design stream's figures run
 * through. RC OUT, production and electricity are all filed the morning after,
 * so a window ending "today" does not mean the numbers reach today — and a
 * modal that silently ends its axis at the operational date invites exactly the
 * misreading the KPI cards' `AsOfChip` exists to prevent.
 *
 * Empty string when the stream status view had nothing to say: an absent
 * as-of is stated by omission, never guessed from the data.
 */
export function asOfNote(asOf: string | null | undefined): string {
  return asOf ? ` · reported through ${asOf}` : "";
}

// ---------------------------------------------------------------------
// Truncation notice
// ---------------------------------------------------------------------

/**
 * The honesty banner for a capped read. It does NOT say "some rows are
 * missing" — it says every figure is a FLOOR, because that is the actionable
 * consequence, and it points at the module that has the complete ledger.
 */
export function TruncatedNotice({
  /** what the window has too many of — "feedings", "deliveries", "readings" */
  noun,
  /** where the complete ledger lives — "RC OUT", "Production" */
  module,
}: {
  noun: string;
  module: string;
}) {
  return (
    <div
      role="alert"
      className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2"
    >
      <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-amber-600 dark:text-amber-400" />
      <p className="text-[11px] leading-relaxed text-muted-foreground">
        This window has more {noun} than one read returns, so every figure below
        is a <strong className="font-semibold">floor</strong>, not a total. Open{" "}
        {module} for the complete ledger.
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------
// The bar + rolling-mean chart
// ---------------------------------------------------------------------

export interface VolumeSeriesChartProps {
  data: VolumePoint[];
  granularity: DrilldownGranularity;
  /** legend / tooltip caption for the bars — "Received", "Fed", "Produced" */
  valueName: string;
  /** how a magnitude is written — `fmtKg` or `fmtKwh` */
  fmt: (v: number) => string;
  /** appended after a tooltip value — "kg" / "kWh" */
  unit: string;
  /** bar fill */
  color?: string;
  /**
   * Stroke for the rolling-mean line. **It must be picked against the BAR
   * COLOUR IN BOTH THEMES, which is why it is a prop and not a constant.**
   * The chart tokens rotate hue between light and dark, so a single hardcoded
   * mean colour cannot stay legible: `--chart-4` (yellow in light) reads
   * clearly over `--chart-2` teal bars but almost vanishes over `--chart-1`
   * orange ones — measured in the browser, light mode, RC OUT. Callers on
   * `--chart-1` pass `--chart-3` instead (dark blue in light, amber in dark:
   * high contrast either way).
   */
  avgColor?: string;
  /** chart height in px (the rail beside it is sized to match) */
  height?: number;
}

export function VolumeSeriesChart({
  data,
  granularity,
  valueName,
  fmt,
  unit,
  color = "var(--chart-2)",
  avgColor = "var(--chart-4)",
  height = 240,
}: VolumeSeriesChartProps) {
  const tip = drilldownTooltipChrome();
  const avgLabel = rollingLabel(granularity);

  return (
    <div className="w-full" style={{ height }}>
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart
          data={data}
          margin={{ top: 6, right: 8, bottom: 0, left: 0 }}
        >
          <CartesianGrid
            stroke="var(--border)"
            strokeOpacity={0.4}
            vertical={false}
          />
          <XAxis
            dataKey="label"
            tick={DRILLDOWN_AXIS_TICK}
            tickLine={false}
            axisLine={{ stroke: "var(--border)" }}
            minTickGap={granularity === "month" ? 8 : 24}
          />
          <YAxis
            tick={DRILLDOWN_AXIS_TICK}
            tickLine={false}
            axisLine={false}
            width={48}
            tickFormatter={(v: number) => fmt(v)}
          />
          <RTooltip
            {...tip}
            formatter={(value, name) => [
              value == null ? "—" : `${fmt(Number(value))} ${unit}`,
              name === "avg" ? avgLabel : valueName,
            ]}
            labelFormatter={(label, payload) =>
              payload?.[0]?.payload?.bucket ?? label
            }
          />
          <Legend
            wrapperStyle={{ fontSize: "11px", paddingTop: 4 }}
            formatter={(v) => (v === "avg" ? avgLabel : valueName)}
          />
          {/* A 0 bar simply is not drawn — an honest gap on a bar chart, and
              unlike a line it never "plunges" to the floor (the convention
              digest-charts' FlowChart states for its lines). */}
          <Bar
            dataKey="value"
            name="value"
            fill={color}
            radius={[3, 3, 0, 0]}
            maxBarSize={granularity === "month" ? 44 : 22}
            isAnimationActive={false}
          />
          {/* The rolling mean DOES include zero buckets — that is what makes it
              an average of the period rather than of the busy days. */}
          <Line
            type="monotone"
            dataKey="avg"
            name="avg"
            stroke={avgColor}
            strokeWidth={2}
            dot={false}
            isAnimationActive={false}
            connectNulls={false}
          />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}

// ---------------------------------------------------------------------
// The ranked breakdown rail
// ---------------------------------------------------------------------

export interface RailItem {
  /** react key AND the identity of the row */
  key: string;
  /** primary name — supplier, batch code, grade, meter */
  label: string;
  /** small muted qualifier rendered after the label (a block, a destination) */
  meta?: React.ReactNode;
  /** already-formatted magnitude, right-aligned mono */
  value: string;
  /** "kg" / "kWh" — rendered small after the magnitude */
  unit?: string;
  /** 0–100; drives the share bar and the trailing percentage */
  sharePct: number;
  /** hover detail (counts that do not fit on the row) */
  title?: string;
}

/**
 * A ranked list with share bars — chosen over stacked bars because 35
 * suppliers (or 20 batches) do not stack legibly at this size.
 *
 * The first entry is drawn at full strength and the rest at 55%, so the leader
 * is readable at a glance without a second colour scale. **A one-entry rail is
 * a valid rendering, not an empty state** (Power: only MAIN has reported since
 * 2025-12-12) — nothing here apologises for a short list.
 */
export function BreakdownRail({
  items,
  emptyText,
  maxHeight = 240,
  color = "var(--chart-2)",
}: {
  items: RailItem[];
  emptyText: string;
  /**
   * Any CSS length. It was `number` until 2026-09-02; the analytics row expand
   * now sizes its rails off the same custom property its chart uses, so the
   * rail beside a chart keeps matching it when the big-screen scale grows both.
   * A plain number still means px, so every existing caller is unchanged.
   */
  maxHeight?: number | string;
  color?: string;
}) {
  if (items.length === 0) {
    return (
      <p className="px-3 py-6 text-center text-xs text-muted-foreground">
        {emptyText}
      </p>
    );
  }

  return (
    <ol className="overflow-y-auto px-3 py-2" style={{ maxHeight }}>
      {items.map((item, i) => (
        <li key={item.key} className="py-1">
          <div className="flex items-baseline justify-between gap-2">
            <span
              className="min-w-0 truncate text-[length:var(--bw-fs-12,0.75rem)] leading-[var(--bw-lh-xs,1rem)]"
              title={item.title}
            >
              <span className="mr-1.5 font-mono text-[length:var(--bw-fs-10,10px)] text-muted-foreground tabular-nums">
                {i + 1}
              </span>
              {item.label}
              {item.meta && (
                <span className="ml-1.5 text-[length:var(--bw-fs-10,10px)] text-muted-foreground">
                  {item.meta}
                </span>
              )}
            </span>
            <span className="shrink-0 font-mono text-[length:var(--bw-fs-12,0.75rem)] leading-[var(--bw-lh-xs,1rem)] tabular-nums">
              {item.value}
              {item.unit && (
                <span className="ml-1 text-[length:var(--bw-fs-10,10px)] text-muted-foreground">
                  {item.unit}
                </span>
              )}
            </span>
          </div>
          <div className="mt-0.5 flex items-center gap-2">
            <div className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-muted">
              <div
                className={cn("h-full origin-left rounded-full")}
                style={{
                  width: `${Math.min(100, item.sharePct)}%`,
                  background: color,
                  opacity: i === 0 ? 1 : 0.55,
                }}
              />
            </div>
            <span className="w-10 shrink-0 text-right font-mono text-[10px] text-muted-foreground tabular-nums">
              {item.sharePct.toFixed(1)}%
            </span>
          </div>
        </li>
      ))}
    </ol>
  );
}
