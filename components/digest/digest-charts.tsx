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

/** Stepped fill opacity for successive shift segments within a single grade. */
const SHIFT_OPACITY = [1, 0.7, 0.45, 0.3];

interface GradeWideRow {
  date: string;
  [seriesKey: string]: string | number;
}

/** Series-key separator between grade and shift, e.g. "3X50·M". */
const SHIFT_SEP = "·";

/** Human-readable shift suffix for legends/tooltips. */
function shiftLabel(shift: string): string {
  switch (shift) {
    case "M":
      return "Morning";
    case "E":
      return "Evening";
    case "N":
      return "Night";
    default:
      return shift;
  }
}

interface PivotResult {
  rows: GradeWideRow[];
  /** chart dataKeys, in stack order (grouped by grade, then shift) */
  seriesKeys: string[];
  /** seriesKey → legend/tooltip label */
  keyLabels: Record<string, string>;
  /** seriesKey → grade it belongs to (drives color + stackId) */
  keyGrade: Record<string, string>;
  /** distinct grades, sorted — drives the color ramp */
  grades: string[];
  /** true when no shift segmentation is in play (one bar series per grade) */
  singleSeries: boolean;
}

/**
 * Pivot long GradePoint[] (date, grade, shift, kg) into wide rows for the
 * stacked bar chart. A (grade) is split into per-shift series ONLY when that
 * grade actually has >1 distinct shift across the window — so single-shift (or
 * shift-less) grades stay as one clean bar with a bare-grade legend label.
 */
function pivotGrades(grades: GradePoint[]): PivotResult {
  // 1. Discover the distinct shifts each grade carries across the window.
  const shiftsByGrade = new Map<string, Set<string>>();
  for (const g of grades) {
    const shift = g.shift ?? "";
    let set = shiftsByGrade.get(g.grade);
    if (!set) {
      set = new Set<string>();
      shiftsByGrade.set(g.grade, set);
    }
    set.add(shift);
  }

  const gradeList = Array.from(shiftsByGrade.keys()).sort();

  /** Should this grade be segmented by shift? Only if it has >1 real shift. */
  const splitGrade = (grade: string): boolean => {
    const set = shiftsByGrade.get(grade);
    if (!set) return false;
    const real = Array.from(set).filter((s) => s !== "");
    return real.length > 1;
  };

  /** Compute the series key for a row's contribution. */
  const seriesKeyFor = (grade: string, shift: string): string =>
    splitGrade(grade) && shift !== "" ? `${grade}${SHIFT_SEP}${shift}` : grade;

  // 2. Build wide rows keyed by date, summing into each series key.
  const byDate = new Map<string, GradeWideRow>();
  const seriesSet = new Set<string>();
  for (const g of grades) {
    const key = seriesKeyFor(g.grade, g.shift ?? "");
    seriesSet.add(key);
    let row = byDate.get(g.date);
    if (!row) {
      row = { date: g.date };
      byDate.set(g.date, row);
    }
    row[key] = (Number(row[key] ?? 0) + g.kg) as number;
  }

  const rows = Array.from(byDate.values()).sort((a, b) =>
    a.date < b.date ? -1 : a.date > b.date ? 1 : 0
  );

  // 3. Order series by grade, then by shift, for stable stacks + colors.
  const seriesKeys = Array.from(seriesSet).sort((a, b) => {
    const ga = a.split(SHIFT_SEP)[0];
    const gb = b.split(SHIFT_SEP)[0];
    if (ga !== gb) return ga < gb ? -1 : 1;
    return a < b ? -1 : a > b ? 1 : 0;
  });

  // 4. Fill missing series keys with 0 so stacks render consistently.
  for (const row of rows) {
    for (const k of seriesKeys) {
      if (row[k] === undefined) row[k] = 0;
    }
  }

  // 5. Labels + grade mapping for color/stack assignment.
  const keyLabels: Record<string, string> = {};
  const keyGrade: Record<string, string> = {};
  for (const k of seriesKeys) {
    const [grade, shift] = k.split(SHIFT_SEP);
    keyGrade[k] = grade;
    keyLabels[k] = shift ? `${grade} (${shiftLabel(shift)})` : grade;
  }

  return {
    rows,
    seriesKeys,
    keyLabels,
    keyGrade,
    grades: gradeList,
    singleSeries: seriesKeys.length <= 1,
  };
}

function GradeChart({ grades }: { grades: GradePoint[] }) {
  const tip = tooltipChrome();
  const { rows, seriesKeys, keyLabels, keyGrade, grades: gradeList, singleSeries } =
    React.useMemo(() => pivotGrades(grades), [grades]);

  // Color is assigned per GRADE so all shift segments of a grade share a hue;
  // shifts within a grade are distinguished by a stepped fill opacity instead.
  const gradeColorIndex = React.useMemo(() => {
    const idx: Record<string, number> = {};
    gradeList.forEach((g, i) => {
      idx[g] = i % GRADE_COLORS.length;
    });
    return idx;
  }, [gradeList]);

  // Per-grade running shift index → opacity step (1.0, 0.7, 0.45 …).
  const shiftOpacityForKey = React.useMemo(() => {
    const seenPerGrade: Record<string, number> = {};
    const op: Record<string, number> = {};
    for (const k of seriesKeys) {
      const grade = keyGrade[k];
      const n = seenPerGrade[grade] ?? 0;
      // single-series-per-grade keeps full opacity; only split grades step down
      op[k] = SHIFT_OPACITY[Math.min(n, SHIFT_OPACITY.length - 1)];
      seenPerGrade[grade] = n + 1;
    }
    return op;
  }, [seriesKeys, keyGrade]);

  // The single top-most series of the shared stack gets rounded top corners.
  const topSeriesKey = seriesKeys[seriesKeys.length - 1];

  return (
    <ChartCard
      title="Production by grade"
      subtitle={singleSeries ? "daily · kg" : "by grade · shift · kg"}
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
              keyLabels[String(name)] ?? String(name),
            ]}
            labelFormatter={(l) => l}
          />
          {/* Legend only when there's more than one series to disambiguate. */}
          {!singleSeries && (
            <Legend
              iconType="square"
              wrapperStyle={{ fontSize: "11px", paddingTop: 4 }}
              formatter={(v) => keyLabels[String(v)] ?? String(v)}
            />
          )}
          {seriesKeys.map((key) => {
            const grade = keyGrade[key];
            const isTop = key === topSeriesKey;
            return (
              <Bar
                key={key}
                dataKey={key}
                name={key}
                // ONE shared stack per day: series are pre-ordered grade→shift,
                // so a grade's shift segments sit contiguously within the column
                // and the day still reads as a single stacked bar across grades.
                stackId="grade"
                fill={GRADE_COLORS[gradeColorIndex[grade] ?? 0]}
                fillOpacity={shiftOpacityForKey[key] ?? 1}
                isAnimationActive={false}
                radius={isTop ? [3, 3, 0, 0] : [0, 0, 0, 0]}
                maxBarSize={28}
              />
            );
          })}
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
  // The price series is EMPTY for price-denied roles (gated server-side in
  // getDigestData). Skip the ₱/kg chart entirely in that case so no broken /
  // empty-looking chart renders — mirrors how other digest bands drop out on
  // empty data.
  const showPrice = price.length > 0;
  return (
    <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
      <FlowChart flow={flow} />
      {showPrice && <PriceChart price={price} />}
      <GradeChart grades={grades} />
    </div>
  );
}
