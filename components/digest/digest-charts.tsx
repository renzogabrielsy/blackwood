"use client";

import * as React from "react";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip as RTooltip,
  XAxis,
  YAxis,
} from "recharts";
import { cn } from "@/lib/utils";
import { fmtKg, fmtPhpNumber } from "./format";
import type { FlowPoint, PricePoint, GradePoint } from "@/lib/digest/types";

// ---------------------------------------------------------------------
// Shared chart chrome
// ---------------------------------------------------------------------

const AXIS_TICK = {
  fill: "var(--muted-foreground)",
  fontSize: 10,
  fontFamily: "var(--font-geist-sans, inherit)",
};

/** Short MM-DD label from a yyyy-MM-dd date. */
function shortDate(d: string): string {
  return d.length >= 10 ? d.slice(5) : d;
}

interface ChartCardProps {
  title: string;
  subtitle?: string;
  empty?: boolean;
  children: React.ReactNode;
  className?: string;
}

function ChartCard({
  title,
  subtitle,
  empty,
  children,
  className,
}: ChartCardProps) {
  return (
    <div
      className={cn(
        "hover-lift flex flex-col rounded-xl border bg-card/95 p-4 backdrop-blur supports-backdrop-filter:bg-card/70",
        className
      )}
    >
      <div className="mb-3 flex items-baseline justify-between gap-2">
        <h3 className="text-sm font-semibold tracking-tight">{title}</h3>
        {subtitle && (
          <span className="text-[11px] text-muted-foreground">{subtitle}</span>
        )}
      </div>
      {empty ? (
        <div className="flex h-[220px] items-center justify-center text-sm text-muted-foreground">
          No data for this window
        </div>
      ) : (
        <div className="h-[220px] w-full">{children}</div>
      )}
    </div>
  );
}

/** Themed recharts tooltip surface (glass popover). */
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
    cursor: { stroke: "var(--border)", strokeWidth: 1 },
  };
}

// ---------------------------------------------------------------------
// Chart 1 — Feed In vs Out (last 30 days)
// ---------------------------------------------------------------------

function FlowChart({ flow }: { flow: FlowPoint[] }) {
  const tip = tooltipChrome();
  return (
    <ChartCard
      title="Feed In vs Out"
      subtitle="last 30 days · kg"
      empty={flow.length === 0}
    >
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={flow} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
          <defs>
            <linearGradient id="flow-in" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="var(--chart-2)" stopOpacity={0.3} />
              <stop offset="100%" stopColor="var(--chart-2)" stopOpacity={0} />
            </linearGradient>
            <linearGradient id="flow-out" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="var(--chart-1)" stopOpacity={0.3} />
              <stop offset="100%" stopColor="var(--chart-1)" stopOpacity={0} />
            </linearGradient>
          </defs>
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
            minTickGap={24}
          />
          <YAxis
            tick={AXIS_TICK}
            tickLine={false}
            axisLine={false}
            width={44}
            tickFormatter={(v: number) => fmtKg(v)}
          />
          <RTooltip
            {...tip}
            formatter={(value, name) => [
              `${fmtKg(Number(value) || 0)} kg`,
              name === "in" ? "Received" : "Fed",
            ]}
            labelFormatter={(l) => l}
          />
          <Legend
            iconType="plainline"
            wrapperStyle={{ fontSize: "11px", paddingTop: 4 }}
            formatter={(v) => (v === "in" ? "Received" : "Fed")}
          />
          {/* connectNulls keeps zero days flat (rows always carry 0, never gaps) */}
          <Area
            type="monotone"
            dataKey="in"
            stroke="var(--chart-2)"
            strokeWidth={1.75}
            fill="url(#flow-in)"
            isAnimationActive={false}
            dot={false}
            connectNulls
          />
          <Area
            type="monotone"
            dataKey="out"
            stroke="var(--chart-1)"
            strokeWidth={1.75}
            fill="url(#flow-out)"
            isAnimationActive={false}
            dot={false}
            connectNulls
          />
        </AreaChart>
      </ResponsiveContainer>
    </ChartCard>
  );
}

// ---------------------------------------------------------------------
// Chart 2 — RC In price (₱/kg) + day-over-day % change (dual axis)
// ---------------------------------------------------------------------

interface PriceRow {
  date: string;
  phpPerKg: number;
  /** day-over-day % change of price; null for the first point. */
  pctChange: number | null;
}

/** Display-only transform: compute DoD % change of an already-correct price
 *  series. NOT a DB aggregation — pure presentational math on data.price. */
function withPctChange(price: PricePoint[]): PriceRow[] {
  return price.map((p, i) => {
    if (i === 0) return { ...p, pctChange: null };
    const prev = price[i - 1].phpPerKg;
    const pctChange =
      prev !== 0 ? ((p.phpPerKg - prev) / prev) * 100 : null;
    return { ...p, pctChange };
  });
}

/** Signed percent for the right axis / tooltip, e.g. "+3.2%" / "-1.1%". */
function fmtPctSigned(v: number): string {
  const sign = v > 0 ? "+" : "";
  return `${sign}${v.toLocaleString("en-US", {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  })}%`;
}

function PriceChart({ price }: { price: PricePoint[] }) {
  const tip = tooltipChrome();
  const rows = React.useMemo(() => withPctChange(price), [price]);
  // A single point yields no meaningful DoD change; still render the ₱/kg line.
  const hasPct = rows.some((r) => r.pctChange != null);

  return (
    <ChartCard
      title="RC In price"
      subtitle="₱/kg · DoD %"
      empty={price.length === 0}
    >
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={rows} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
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
            minTickGap={24}
          />
          {/* Primary (left) axis — ₱/kg */}
          <YAxis
            yAxisId="php"
            tick={AXIS_TICK}
            tickLine={false}
            axisLine={false}
            width={52}
            domain={["auto", "auto"]}
            tickFormatter={(v: number) => `₱${fmtPhpNumber(v)}`}
          />
          {/* Secondary (right) axis — day-over-day % change */}
          <YAxis
            yAxisId="pct"
            orientation="right"
            tick={AXIS_TICK}
            tickLine={false}
            axisLine={false}
            width={48}
            domain={["auto", "auto"]}
            tickFormatter={(v: number) => fmtPctSigned(v)}
          />
          <RTooltip
            {...tip}
            formatter={(value, name) => {
              if (name === "pctChange") {
                return value == null
                  ? ["—", "DoD %"]
                  : [fmtPctSigned(Number(value)), "DoD %"];
              }
              return [`₱${fmtPhpNumber(Number(value) || 0)}`, "₱/kg"];
            }}
            labelFormatter={(l) => l}
          />
          <Legend
            iconType="plainline"
            wrapperStyle={{ fontSize: "11px", paddingTop: 4 }}
            formatter={(v) => (v === "pctChange" ? "DoD %" : "₱/kg")}
          />
          {/* ₱/kg — prominent primary line */}
          <Line
            yAxisId="php"
            type="monotone"
            dataKey="phpPerKg"
            name="phpPerKg"
            stroke="var(--chart-4)"
            strokeWidth={2}
            isAnimationActive={false}
            dot={false}
          />
          {/* DoD % — thinner secondary dashed line on the right axis */}
          {hasPct && (
            <Line
              yAxisId="pct"
              type="monotone"
              dataKey="pctChange"
              name="pctChange"
              stroke="var(--chart-3)"
              strokeWidth={1.25}
              strokeDasharray="4 3"
              isAnimationActive={false}
              dot={false}
              connectNulls
            />
          )}
        </LineChart>
      </ResponsiveContainer>
    </ChartCard>
  );
}

// ---------------------------------------------------------------------
// Chart 3 — Production by grade (stacked bars)
// ---------------------------------------------------------------------

const GRADE_COLORS = [
  "var(--chart-1)",
  "var(--chart-2)",
  "var(--chart-3)",
  "var(--chart-4)",
  "var(--chart-5)",
];

interface GradeWideRow {
  date: string;
  [grade: string]: string | number;
}

function pivotGrades(grades: GradePoint[]): {
  rows: GradeWideRow[];
  gradeKeys: string[];
} {
  const byDate = new Map<string, GradeWideRow>();
  const gradeSet = new Set<string>();
  for (const g of grades) {
    gradeSet.add(g.grade);
    let row = byDate.get(g.date);
    if (!row) {
      row = { date: g.date };
      byDate.set(g.date, row);
    }
    // sum same grade on same day defensively (should already be aggregated)
    row[g.grade] = (Number(row[g.grade] ?? 0) + g.kg) as number;
  }
  const rows = Array.from(byDate.values()).sort((a, b) =>
    a.date < b.date ? -1 : a.date > b.date ? 1 : 0
  );
  // fill missing grade keys with 0 so stacks render consistently
  const gradeKeys = Array.from(gradeSet).sort();
  for (const row of rows) {
    for (const k of gradeKeys) {
      if (row[k] === undefined) row[k] = 0;
    }
  }
  return { rows, gradeKeys };
}

function GradeChart({ grades }: { grades: GradePoint[] }) {
  const tip = tooltipChrome();
  const { rows, gradeKeys } = React.useMemo(() => pivotGrades(grades), [grades]);
  const singleGrade = gradeKeys.length <= 1;

  return (
    <ChartCard
      title="Production by grade"
      subtitle={singleGrade ? "daily · kg" : "stacked · kg"}
      empty={rows.length === 0}
    >
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={rows} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
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
            tickFormatter={(v: number) => fmtKg(v)}
          />
          <RTooltip
            {...tip}
            formatter={(value, name) => [
              `${fmtKg(Number(value) || 0)} kg`,
              String(name),
            ]}
            labelFormatter={(l) => l}
          />
          {/* Only show legend when there's more than one grade to disambiguate. */}
          {!singleGrade && (
            <Legend
              iconType="square"
              wrapperStyle={{ fontSize: "11px", paddingTop: 4 }}
            />
          )}
          {gradeKeys.map((grade, i) => (
            <Bar
              key={grade}
              dataKey={grade}
              stackId="grade"
              fill={GRADE_COLORS[i % GRADE_COLORS.length]}
              isAnimationActive={false}
              radius={
                i === gradeKeys.length - 1 ? [3, 3, 0, 0] : [0, 0, 0, 0]
              }
              maxBarSize={28}
            />
          ))}
        </BarChart>
      </ResponsiveContainer>
    </ChartCard>
  );
}

// ---------------------------------------------------------------------

interface DigestChartsProps {
  flow: FlowPoint[];
  price: PricePoint[];
  grades: GradePoint[];
}

export function DigestCharts({ flow, price, grades }: DigestChartsProps) {
  return (
    <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
      <FlowChart flow={flow} />
      <PriceChart price={price} />
      <GradeChart grades={grades} />
    </div>
  );
}
