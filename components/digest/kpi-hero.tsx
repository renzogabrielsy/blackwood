"use client";

import * as React from "react";
import {
  Area,
  AreaChart,
  ResponsiveContainer,
  Tooltip as RTooltip,
  YAxis,
} from "recharts";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { fmtByUnit, fmtDeltaPct } from "./format";
import type { DigestKpi } from "@/lib/digest/types";

interface KpiHeroProps {
  kpis: DigestKpi[];
}

/** Net-flow is a derived balance — drift is EXPECTED, so it gets neutral
 *  delta coloring and a distinct surface, never red-as-alarm. */
function isNeutralKpi(key: string): boolean {
  return key === "net_flow";
}

function DeltaBadge({ kpi }: { kpi: DigestKpi }) {
  if (kpi.deltaPct == null) {
    return (
      <span className="text-[11px] font-medium text-muted-foreground">
        no prior
      </span>
    );
  }
  const up = kpi.deltaPct > 0;
  const flat = kpi.deltaPct === 0;
  const neutral = isNeutralKpi(kpi.key);

  const tone = neutral
    ? "bg-muted text-muted-foreground"
    : up
      ? "bg-emerald-500/12 text-emerald-700 dark:text-emerald-300"
      : flat
        ? "bg-muted text-muted-foreground"
        : "bg-red-500/12 text-red-700 dark:text-red-300";

  const arrow = flat ? "→" : up ? "▲" : "▼";

  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[11px] font-semibold tabular-nums",
        tone
      )}
    >
      <span className="text-[9px] leading-none">{arrow}</span>
      {fmtDeltaPct(Math.abs(kpi.deltaPct))}
    </span>
  );
}

/** Append the card's unit to a formatted spark value (kg/kWh/₱). */
function fmtSparkValue(value: number, unit: string): string {
  if (unit === "₱") return `₱${fmtByUnit(value, unit)}`;
  const str = fmtByUnit(value, unit);
  return unit ? `${str} ${unit}` : str;
}

/** Lightweight glass tooltip for a hovered sparkline point. */
function SparkTooltip({
  active,
  payload,
  unit,
}: {
  active?: boolean;
  payload?: Array<{ payload?: { date?: string; value?: number } }>;
  unit: string;
}) {
  if (!active || !payload?.length) return null;
  const point = payload[0]?.payload;
  if (!point) return null;
  return (
    <div className="rounded-md border border-border bg-popover/95 px-2 py-1 text-[10px] shadow-md backdrop-blur-lg">
      <div className="text-muted-foreground">{point.date}</div>
      <div className="font-mono font-semibold tabular-nums text-popover-foreground">
        {fmtSparkValue(point.value ?? 0, unit)}
      </div>
    </div>
  );
}

function Sparkline({ kpi }: { kpi: DigestKpi }) {
  const gradientId = `spark-${kpi.key}`;
  const neutral = isNeutralKpi(kpi.key);
  // chart-2 is the cool/teal token; net_flow uses the muted chart-3.
  const stroke = neutral ? "var(--chart-3)" : "var(--chart-2)";

  if (!kpi.spark.length) {
    return <div className="h-10 w-full rounded bg-muted/40" aria-hidden />;
  }

  return (
    <div className="h-10 w-full">
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart
          data={kpi.spark}
          margin={{ top: 2, right: 0, bottom: 0, left: 0 }}
        >
          <defs>
            <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={stroke} stopOpacity={0.35} />
              <stop offset="100%" stopColor={stroke} stopOpacity={0} />
            </linearGradient>
          </defs>
          <YAxis hide domain={["dataMin", "dataMax"]} />
          <RTooltip
            content={<SparkTooltip unit={kpi.unit} />}
            cursor={{ stroke: "var(--border)", strokeWidth: 1 }}
            isAnimationActive={false}
            wrapperStyle={{ outline: "none", zIndex: 50 }}
          />
          <Area
            type="monotone"
            dataKey="value"
            stroke={stroke}
            strokeWidth={1.75}
            fill={`url(#${gradientId})`}
            isAnimationActive={false}
            dot={false}
            activeDot={{ r: 2.5, stroke, fill: "var(--background)", strokeWidth: 1.5 }}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}

function KpiCard({ kpi }: { kpi: DigestKpi }) {
  const neutral = isNeutralKpi(kpi.key);
  const valueStr = fmtByUnit(kpi.value, kpi.unit);

  const card = (
    <div
      className={cn(
        "hover-lift flex flex-col gap-2 rounded-xl border p-3.5",
        "bg-card/95 backdrop-blur supports-backdrop-filter:bg-card/70",
        neutral && "border-dashed bg-muted/30 supports-backdrop-filter:bg-muted/20"
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          {kpi.label}
        </span>
        <DeltaBadge kpi={kpi} />
      </div>

      <div className="flex items-baseline gap-1.5">
        <span className="font-mono text-2xl font-semibold tabular-nums leading-none">
          {valueStr}
        </span>
        {kpi.unit && (
          <span className="text-xs font-medium text-muted-foreground">
            {kpi.unit}
          </span>
        )}
      </div>

      <div className="flex min-h-4 items-baseline justify-between gap-2 text-[11px] text-muted-foreground">
        <span className="truncate">
          {kpi.sub ? (
            kpi.sub
          ) : neutral ? (
            <span className="italic">RC In − RC Out</span>
          ) : null}
        </span>
        <span className="shrink-0 tabular-nums">
          7-day avg:{" "}
          <span className="font-mono font-medium text-foreground/80">
            {kpi.avg7 == null ? "—" : fmtSparkValue(kpi.avg7, kpi.unit)}
          </span>
        </span>
      </div>

      <Sparkline kpi={kpi} />
    </div>
  );

  // net_flow gets an "expected drift" tooltip rather than a red flag.
  if (neutral) {
    return (
      <TooltipProvider delayDuration={150}>
        <Tooltip>
          <TooltipTrigger asChild>
            <div className="cursor-help">{card}</div>
          </TooltipTrigger>
          <TooltipContent side="bottom" className="max-w-[220px] text-xs">
            Continuous-flow drift is expected — the feed tank balances at
            month-end, not day-to-day. This is informational, not an alert.
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    );
  }

  return card;
}

export function KpiHero({ kpis }: KpiHeroProps) {
  if (!kpis.length) {
    return (
      <div className="rounded-xl border border-dashed p-6 text-center text-sm text-muted-foreground">
        No operational data for today yet.
      </div>
    );
  }

  return (
    <div className="grid grid-cols-2 gap-3 stagger-children sm:grid-cols-3 lg:grid-cols-5">
      {kpis.map((kpi) => (
        <KpiCard key={kpi.key} kpi={kpi} />
      ))}
    </div>
  );
}
