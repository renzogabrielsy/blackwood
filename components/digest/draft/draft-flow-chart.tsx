"use client";

import * as React from "react";
import {
  Bar,
  CartesianGrid,
  ComposedChart,
  Line,
  ResponsiveContainer,
  Tooltip as RTooltip,
  XAxis,
  YAxis,
} from "recharts";
import { fmtKg } from "../format";

/** One day of the draft flow series. A `null` value is a GAP, not a zero. */
export interface DraftFlowPoint {
  date: string; // yyyy-MM-dd
  /** kg received; null when there was no delivery (procurement gap) */
  inKg: number | null;
  /** kg fed; null on a rest day or when the report is still awaited */
  outKg: number | null;
  /** planned rest day (0 shifts) → drawn as a shaded band, no line plunge */
  rest: boolean;
  /** plant ran but the RC Out report hasn't landed → hatched "pending" marker */
  awaiting: boolean;
}

interface DraftFlowChartProps {
  data: DraftFlowPoint[];
}

const AXIS_TICK = {
  fill: "var(--muted-foreground)",
  fontSize: 10,
  fontFamily: "var(--font-geist-sans, inherit)",
};

function shortDate(d: string): string {
  return d.length >= 10 ? d.slice(5) : d;
}

interface ChartRow extends DraftFlowPoint {
  /** full-height marker for rest days (renders a faint band behind the lines) */
  restBand: number | null;
  /** low-height marker for awaiting days (report pending) */
  awaitingBand: number | null;
}

export function DraftFlowChart({ data }: DraftFlowChartProps) {
  const { rows, yMax } = React.useMemo(() => {
    const values = data.flatMap((d) =>
      [d.inKg, d.outKg].filter((v): v is number => v != null)
    );
    const max = values.length ? Math.max(...values) : 1;
    // round up to a tidy ceiling for the marker heights
    const ceil = Math.ceil(max / 10_000) * 10_000 || max;
    const built: ChartRow[] = data.map((d) => ({
      ...d,
      restBand: d.rest ? ceil : null,
      awaitingBand: d.awaiting ? ceil * 0.14 : null,
    }));
    return { rows: built, yMax: ceil };
  }, [data]);

  return (
    <div className="hover-lift flex flex-col rounded-xl border bg-card/95 p-4 backdrop-blur supports-backdrop-filter:bg-card/70">
      <div className="mb-1 flex items-baseline justify-between gap-2">
        <h3 className="text-sm font-semibold tracking-tight">Feed — In vs Out</h3>
        <span className="text-[11px] text-muted-foreground">
          trailing operational days · kg
        </span>
      </div>
      {/* custom legend — recharts legend can't express the band swatches */}
      <div className="mb-2 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-muted-foreground">
        <span className="inline-flex items-center gap-1.5">
          <span className="h-[3px] w-3.5 rounded-full bg-[var(--chart-2)]" />
          Received
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="h-[3px] w-3.5 rounded-full bg-[var(--chart-1)]" />
          Fed
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="h-2.5 w-2.5 rounded-sm border border-dashed border-border bg-muted" />
          Rest day (planned)
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="h-2.5 w-2.5 rounded-sm bg-amber-500/25" />
          Awaiting report
        </span>
      </div>

      <div className="h-[220px] w-full">
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={rows} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
            <CartesianGrid stroke="var(--border)" strokeOpacity={0.4} vertical={false} />
            <XAxis
              dataKey="date"
              tickFormatter={shortDate}
              tick={AXIS_TICK}
              tickLine={false}
              axisLine={{ stroke: "var(--border)" }}
              minTickGap={12}
            />
            <YAxis
              tick={AXIS_TICK}
              tickLine={false}
              axisLine={false}
              width={44}
              domain={[0, yMax]}
              tickFormatter={(v: number) => fmtKg(v)}
            />
            <RTooltip
              contentStyle={{
                background: "var(--popover)",
                border: "1px solid var(--border)",
                borderRadius: "0.5rem",
                fontSize: "11px",
                color: "var(--popover-foreground)",
                boxShadow: "0 4px 16px rgba(0,0,0,0.12)",
              }}
              labelStyle={{ color: "var(--muted-foreground)", fontSize: "10px" }}
              formatter={(value, name) => {
                if (name === "restBand") return ["planned rest", "Status"];
                if (name === "awaitingBand") return ["report pending", "Status"];
                if (value == null) return ["—", name === "inKg" ? "Received" : "Fed"];
                return [
                  `${fmtKg(Number(value))} kg`,
                  name === "inKg" ? "Received" : "Fed",
                ];
              }}
              cursor={{ stroke: "var(--border)", strokeWidth: 1 }}
            />
            {/* rest-day band (behind the lines) */}
            <Bar
              dataKey="restBand"
              fill="var(--muted-foreground)"
              fillOpacity={0.1}
              isAnimationActive={false}
              maxBarSize={72}
            />
            {/* awaiting-report marker near the baseline */}
            <Bar
              dataKey="awaitingBand"
              fill="var(--chart-4)"
              fillOpacity={0.35}
              isAnimationActive={false}
              maxBarSize={40}
              radius={[3, 3, 0, 0]}
            />
            {/* connectNulls={false} → a gap (rest / no-delivery), never a plunge */}
            <Line
              type="monotone"
              dataKey="inKg"
              stroke="var(--chart-2)"
              strokeWidth={2}
              dot={{ r: 2.5, fill: "var(--background)", stroke: "var(--chart-2)", strokeWidth: 1.5 }}
              isAnimationActive={false}
              connectNulls={false}
            />
            <Line
              type="monotone"
              dataKey="outKg"
              stroke="var(--chart-1)"
              strokeWidth={2}
              dot={{ r: 2.5, fill: "var(--background)", stroke: "var(--chart-1)", strokeWidth: 1.5 }}
              isAnimationActive={false}
              connectNulls={false}
            />
          </ComposedChart>
        </ResponsiveContainer>
      </div>

      <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">
        Planned rest days are drawn as a{" "}
        <span className="font-medium text-foreground/80">gap</span>, not a plunge to
        zero — the line no longer nose-dives. Days the plant ran but the report is
        still missing get an{" "}
        <span className="font-medium text-amber-700 dark:text-amber-300">amber</span>{" "}
        marker so a gap reads as &ldquo;pending&rdquo;, not &ldquo;nothing happened&rdquo;.
      </p>
    </div>
  );
}
