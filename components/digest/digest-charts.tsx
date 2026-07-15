"use client";

import * as React from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  ComposedChart,
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
import { ProductionHoursChart } from "./production-hours-chart";
import type {
  FlowPoint,
  PricePoint,
  GradePoint,
  DailyHoursPoint,
  WeekDayPlan,
} from "@/lib/digest/types";

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
  /** optional custom legend rendered between the header and the chart body */
  legend?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}

function ChartCard({
  title,
  subtitle,
  empty,
  legend,
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
      <div
        className={cn(
          "flex items-baseline justify-between gap-2",
          legend ? "mb-2" : "mb-3"
        )}
      >
        <h3 className="text-sm font-semibold tracking-tight">{title}</h3>
        {subtitle && (
          <span className="text-[11px] text-muted-foreground">{subtitle}</span>
        )}
      </div>
      {legend && !empty && <div className="mb-2">{legend}</div>}
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
// Chart 1 — Feed In vs Out (last 30 days), rest-day aware
// ---------------------------------------------------------------------
// A zero day is NOT a plunge to the floor: a planned rest day (0 shifts) or a
// day whose report hasn't landed yet is kept NULL so the line never dives to
// zero. But the lines CONNECT ACROSS those nulls (connectNulls={true}) — the
// trend reads as one smooth, continuous stroke instead of a broken series of
// gaps. Where the operational week's plan is known (weekPlan), a rest day still
// gets a faint background band and an awaiting day an amber marker so the
// bridged span reads as "pending"/"planned rest", never "nothing happened".

interface FlowChartRow {
  date: string;
  /** kg received; null when there was no delivery (procurement gap) */
  inKg: number | null;
  /** kg fed; null on a rest day or when the report is still awaited */
  outKg: number | null;
  /** full-height marker for rest days (a faint band behind the lines) */
  restBand: number | null;
  /** low-height marker for awaiting days (report pending) */
  awaitingBand: number | null;
}

function FlowChart({
  flow,
  planByDate,
}: {
  flow: FlowPoint[];
  planByDate: Map<string, WeekDayPlan>;
}) {
  const tip = tooltipChrome();

  const { rows, yMax } = React.useMemo(() => {
    const values = flow.flatMap((d) =>
      [d.in, d.out].filter((v) => v > 0)
    );
    const max = values.length ? Math.max(...values) : 1;
    const ceil = Math.ceil(max / 10_000) * 10_000 || max;
    const built: FlowChartRow[] = flow.map((f) => {
      const plan = planByDate.get(f.date);
      const rest = plan ? plan.shifts === 0 : false;
      // out === 0 on a KNOWN working day → the RC Out report hasn't landed yet.
      const awaiting = !rest && f.out === 0 && (plan ? plan.shifts > 0 : false);
      return {
        date: f.date,
        // no delivery → gap (procurement is not shift-bound)
        inKg: f.in > 0 ? f.in : null,
        // rest / pending / silent → gap, never a plunge to zero
        outKg: rest || f.out === 0 ? null : f.out,
        restBand: rest ? ceil : null,
        awaitingBand: awaiting ? ceil * 0.14 : null,
      };
    });
    return { rows: built, yMax: ceil };
  }, [flow, planByDate]);

  const legend = (
    <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-muted-foreground">
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
  );

  return (
    <ChartCard
      title="Feed In vs Out"
      subtitle="last 30 days · kg"
      empty={flow.length === 0}
      legend={legend}
    >
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart data={rows} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
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
            domain={[0, yMax]}
            tickFormatter={(v: number) => fmtKg(v)}
          />
          <RTooltip
            {...tip}
            formatter={(value, name) => {
              if (name === "restBand") return ["planned rest", "Status"];
              if (name === "awaitingBand") return ["report pending", "Status"];
              if (value == null) return ["—", name === "inKg" ? "Received" : "Fed"];
              return [
                `${fmtKg(Number(value))} kg`,
                name === "inKg" ? "Received" : "Fed",
              ];
            }}
            labelFormatter={(l) => l}
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
          {/* values stay null on rest/no-report/no-delivery days (never a
              plunge to zero), but connectNulls bridges ACROSS them so the line
              is one smooth continuous stroke, not a gapped series */}
          <Line
            type="monotone"
            dataKey="inKg"
            stroke="var(--chart-2)"
            strokeWidth={2}
            dot={{ r: 2.5, fill: "var(--background)", stroke: "var(--chart-2)", strokeWidth: 1.5 }}
            isAnimationActive={false}
            connectNulls={true}
          />
          <Line
            type="monotone"
            dataKey="outKg"
            stroke="var(--chart-1)"
            strokeWidth={2}
            dot={{ r: 2.5, fill: "var(--background)", stroke: "var(--chart-1)", strokeWidth: 1.5 }}
            isAnimationActive={false}
            connectNulls={true}
          />
        </ComposedChart>
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

  // ₱/kg axis domain — lift the lowest price OFF the chart floor so it never
  // reads as "reporting zero". We pad well below the min (headroom ≈ 60% of the
  // range, min 1.5₱) so the lowest point floats in the lower third, and a
  // little above the max (25% of the range, min 0.5₱). A flat series still gets
  // padding via the range floor of 1. Bounds are rounded to whole ₱ so the axis
  // ticks read cleanly. Empty series → recharts auto (chart is skipped anyway).
  const phpDomain = React.useMemo<[number, number] | undefined>(() => {
    if (rows.length === 0) return undefined;
    const values = rows.map((r) => r.phpPerKg);
    const min = Math.min(...values);
    const max = Math.max(...values);
    const range = Math.max(max - min, 1);
    const lower = Math.floor(min - Math.max(range * 0.6, 1.5));
    const upper = Math.ceil(max + Math.max(range * 0.25, 0.5));
    return [Math.max(0, lower), upper];
  }, [rows]);

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
          {/* Primary (left) axis — ₱/kg. Padded domain lifts the low off the floor. */}
          <YAxis
            yAxisId="php"
            tick={AXIS_TICK}
            tickLine={false}
            axisLine={false}
            width={52}
            domain={phpDomain ?? ["auto", "auto"]}
            allowDecimals={false}
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
  /** worked vs downtime hours per production day (same 14-day window as
   *  `grades`) — feeds the hours table paired beside the grade chart. */
  productionHours: DailyHoursPoint[];
  /** the operational date's week plan — drives the flow chart's rest/awaiting
   *  band markers (dates outside the week simply render gaps on zero days). */
  weekPlan: WeekDayPlan[];
}

export function DigestCharts({
  flow,
  price,
  grades,
  productionHours,
  weekPlan,
}: DigestChartsProps) {
  // The price series is EMPTY for price-denied roles (gated server-side in
  // getDigestData). Skip the ₱/kg chart entirely in that case so no broken /
  // empty-looking chart renders — mirrors how other digest bands drop out on
  // empty data.
  const showPrice = price.length > 0;
  const showHours = productionHours.length > 0;
  const planByDate = React.useMemo(
    () => new Map(weekPlan.map((w) => [w.date, w])),
    [weekPlan]
  );
  return (
    <div className="flex flex-col gap-3">
      {/* Row 1 — Feed In vs Out + RC In price. When price is gated the flow
          chart spans the full width (no empty half). */}
      <div className={cn("grid grid-cols-1 gap-3", showPrice && "lg:grid-cols-2")}>
        <FlowChart flow={flow} planByDate={planByDate} />
        {showPrice && <PriceChart price={price} />}
      </div>
      {/* Row 2 — Production by grade (left) paired with the Work & downtime
          hours stacked bar chart (right). This pairing is INDEPENDENT of the
          price chart above, so the two production panels always sit side-by-side
          on wide screens and stack on mobile. The grade chart spans full width
          only when there are no hours rows to pair with. */}
      <div className={cn("grid grid-cols-1 gap-3", showHours && "lg:grid-cols-2")}>
        <GradeChart grades={grades} />
        {showHours && <ProductionHoursChart rows={productionHours} />}
      </div>
    </div>
  );
}
