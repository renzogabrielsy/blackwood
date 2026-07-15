"use client";

// The Home Digest's Work & downtime hours band, rendered as a stacked bar chart
// that visually mirrors the Production-by-grade chart it pairs beside. Uses the
// SAME recharts + ChartCard chrome (ResponsiveContainer/BarChart, CartesianGrid,
// AXIS_TICK-styled axes, tooltipChrome, maxBarSize, top-rounded top segment,
// isAnimationActive={false}). Presentation-only: consumes the pre-aggregated
// `productionHours` slice from getDigestData() (view_digest_daily_hours, last
// GRADE_DAYS). One stacked bar per day — work hrs as the base, downtime stacked
// ON TOP in a contrasting amber cap. No ₱ data → no price gating. Renders `null`
// when empty. Shared chart chrome intentionally duplicates digest-charts.tsx so
// the two production panels read as siblings.
import * as React from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  ResponsiveContainer,
  Tooltip as RTooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { DailyHoursPoint } from "@/lib/digest/types";

interface ProductionHoursChartProps {
  /** last GRADE_DAYS (14) production days, ascending by date — same window as
   *  the Production-by-grade chart it pairs beside. */
  rows: DailyHoursPoint[];
}

// ---------------------------------------------------------------------
// Shared chart chrome (matched to digest-charts.tsx GradeChart)
// ---------------------------------------------------------------------

const AXIS_TICK = {
  fill: "var(--muted-foreground)",
  fontSize: 10,
  fontFamily: "var(--font-geist-sans, inherit)",
};

/** Short MM-DD label from a yyyy-MM-dd date (matches the grade chart X axis). */
function shortDate(d: string): string {
  return d.length >= 10 ? d.slice(5) : d;
}

/** Compact hours — whole numbers bare, else one decimal. */
function fmtHrs(v: number): string {
  return Number.isInteger(v) ? String(v) : v.toFixed(1);
}

/** Themed recharts tooltip surface (glass popover) — mirrors GradeChart. */
function tooltipChrome() {
  return {
    contentStyle: {
      background: "var(--popover)",
      border: "1px solid var(--border)",
      borderRadius: "0.5rem",
      fontSize: "11px",
      color: "var(--popover-foreground)",
      boxShadow: "0 4px 16px rgba(0,0,0,0.12)",
    } as React.CSSProperties,
    labelStyle: { color: "var(--muted-foreground)", fontSize: "10px" },
    itemStyle: { color: "var(--popover-foreground)" },
    cursor: { fill: "var(--muted)", fillOpacity: 0.3 },
  };
}

// Work hrs = calm base bar (chart-1, matching the grade chart's base hue);
// downtime = contrasting amber warning cap (chart-4) stacked ON TOP.
const WORK_COLOR = "var(--chart-1)";
const DOWNTIME_COLOR = "var(--chart-4)";

/** Row shape after deriving the productive base from the scheduled shift. */
interface HoursBarDatum {
  date: string;
  /** Actual productive hours = scheduled shift − downtime (never negative). */
  actualHrs: number;
  /** Time lost within the shift (unchanged from source). */
  downtimeHrs: number;
  /** Scheduled/expected shift length (source `workHrs`), for the tooltip. */
  scheduledHrs: number;
}

/**
 * Work & downtime hours as a stacked bar chart. One bar per production day over
 * the last 14 days (ascending → same left→right order as the Production-by-grade
 * chart).
 *
 * The stacked bar totals the SCHEDULED shift (source `workHrs`, e.g. 12), split
 * into the actual productive time (`actualHrs = max(0, workHrs − downtimeHrs)`)
 * as the base and the `downtimeHrs` cap stacked ON TOP. So base + top = the
 * expected shift, and downtime reads as the slice of the shift lost — never
 * extra time added on top. Renders `null` when there is nothing to show.
 */
export function ProductionHoursChart({ rows }: ProductionHoursChartProps) {
  const tip = tooltipChrome();

  // Derive the productive base per day: subtract downtime OUT OF the scheduled
  // shift so the two segments sum to workHrs (not workHrs + downtime). Guard the
  // 0/absent-shift case so we never render a negative base bar.
  const data = React.useMemo<HoursBarDatum[]>(
    () =>
      rows.map((r) => {
        const scheduledHrs = r.workHrs || 0;
        const downtimeHrs = r.downtimeHrs || 0;
        return {
          date: r.date,
          actualHrs: Math.max(0, scheduledHrs - downtimeHrs),
          downtimeHrs,
          scheduledHrs,
        };
      }),
    [rows],
  );

  if (!rows.length) return null;

  const legend = (
    <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-muted-foreground">
      <span className="inline-flex items-center gap-1.5">
        <span
          className="h-2.5 w-2.5 rounded-sm"
          style={{ background: WORK_COLOR }}
        />
        Work hrs
      </span>
      <span className="inline-flex items-center gap-1.5">
        <span
          className="h-2.5 w-2.5 rounded-sm"
          style={{ background: DOWNTIME_COLOR }}
        />
        Downtime
      </span>
    </div>
  );

  return (
    <div className="hover-lift flex flex-col rounded-xl border bg-card/95 p-4 backdrop-blur supports-backdrop-filter:bg-card/70">
      <div className="mb-2 flex items-baseline justify-between gap-2">
        <h3 className="text-sm font-semibold tracking-tight">
          Work &amp; downtime hours
        </h3>
        <span className="text-[11px] text-muted-foreground">
          last 14 days · hrs
        </span>
      </div>
      <div className="mb-2">{legend}</div>
      <div className="h-[220px] w-full">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={data} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
            <CartesianGrid
              stroke="var(--border)"
              strokeOpacity={0.4}
              vertical={false}
            />
            <XAxis
              dataKey="date"
              tickFormatter={shortDate}
              tick={AXIS_TICK}
              tickLine={false}
              axisLine={{ stroke: "var(--border)" }}
              minTickGap={20}
            />
            <YAxis
              tick={AXIS_TICK}
              tickLine={false}
              axisLine={false}
              width={44}
              tickFormatter={(v: number) => fmtHrs(v)}
            />
            <RTooltip
              {...tip}
              formatter={(value, name) => [
                `${fmtHrs(Number(value) || 0)} hrs`,
                name === "downtimeHrs" ? "Downtime" : "Work hrs",
              ]}
              // Append the scheduled shift total so the two segments read as
              // (actual work + downtime) = scheduled shift.
              labelFormatter={(l, payload) => {
                const d = payload?.[0]?.payload as HoursBarDatum | undefined;
                return d
                  ? `${l} · shift ${fmtHrs(d.scheduledHrs)} hrs`
                  : String(l);
              }}
            />
            <Legend
              iconType="square"
              wrapperStyle={{ fontSize: "11px", paddingTop: 4 }}
              formatter={(v) => (v === "downtimeHrs" ? "Downtime" : "Work hrs")}
            />
            {/* Base segment — actual productive hours (scheduled shift − downtime). */}
            <Bar
              dataKey="actualHrs"
              name="actualHrs"
              stackId="hours"
              fill={WORK_COLOR}
              isAnimationActive={false}
              radius={[0, 0, 0, 0]}
              maxBarSize={28}
            />
            {/* Top segment — downtime (contrasting amber cap, rounded top). */}
            <Bar
              dataKey="downtimeHrs"
              name="downtimeHrs"
              stackId="hours"
              fill={DOWNTIME_COLOR}
              isAnimationActive={false}
              radius={[3, 3, 0, 0]}
              maxBarSize={28}
            />
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
