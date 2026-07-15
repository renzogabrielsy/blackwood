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
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";
import { cn } from "@/lib/utils";
import { fmtByUnit, fmtDeltaPct } from "./format";
import { STATE_CHIP, STATE_LABEL, STATE_RAIL } from "./status-tokens";
import type { DigestKpi } from "@/lib/digest/types";
import type { KpiDayStatus } from "@/lib/digest/day-status";

interface KpiHeroProps {
  kpis: DigestKpi[];
  /** kpi.key → resolved operational-day state (the "misleading zero" fix).
   *  `reported` cards show the number + delta + sparkline; every other state
   *  shows a state label + severity rail + chip instead of a bare 0. */
  dayStatus: Record<string, KpiDayStatus>;
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

/** State pill for a non-reported card (Awaiting report / Rest day / …). */
function StateChip({ state }: { state: KpiDayStatus["state"] }) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full px-2 py-0.5 text-[10.5px] font-semibold",
        STATE_CHIP[state]
      )}
    >
      {STATE_LABEL[state]}
    </span>
  );
}

/** A non-reported card — a state label + severity rail + ghosted projection
 *  instead of a misleading zero, and NO sparkline (the stream has no active
 *  value today). Covers `awaiting` / `rest` / `stale` / `idle`. */
function StateCard({ kpi, status }: { kpi: DigestKpi; status: KpiDayStatus }) {
  const { state } = status;
  const ghost =
    state === "awaiting" && status.projectedTons != null ? (
      <>
        projected{" "}
        <b className="font-mono font-semibold text-violet-600 dark:text-violet-300">
          {status.projectedTons.toFixed(1)} t
        </b>
        {" · 1 shift"}
      </>
    ) : state === "stale" && status.staleDays != null ? (
      <>last reading {status.staleDays} days ago</>
    ) : state === "rest" ? (
      <>planned rest — zero is correct</>
    ) : state === "idle" ? (
      <>procurement — not shift-bound</>
    ) : null;

  return (
    <div
      className={cn(
        "hover-lift relative flex flex-col gap-2 overflow-hidden rounded-xl border p-3.5",
        "bg-muted/30 supports-backdrop-filter:bg-muted/20"
      )}
    >
      {/* left severity rail */}
      <span
        className={cn("absolute inset-y-0 left-0 w-[3px]", STATE_RAIL[state])}
        aria-hidden
      />
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          {kpi.label}
        </span>
        <StateChip state={state} />
      </div>
      <div className="flex items-baseline gap-1.5">
        <span className="text-base font-semibold leading-tight text-muted-foreground">
          {STATE_LABEL[state]}
        </span>
      </div>
      <div className="flex min-h-4 items-baseline justify-between gap-2 text-[11px] text-muted-foreground">
        <span className="truncate">{ghost}</span>
        <span className="shrink-0 tabular-nums">
          avg:{" "}
          <span className="font-mono font-medium text-foreground/80">
            {kpi.avg7 == null ? "—" : fmtSparkValue(kpi.avg7, kpi.unit)}
          </span>
        </span>
      </div>
      {/* no misleading sparkline — this stream has no active value today */}
      <div className="flex h-10 w-full items-center justify-center rounded bg-muted/30 text-[10px] italic text-muted-foreground/70">
        no active series
      </div>
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

/** Compact phone card — label + value (or state) + delta/state chip. The whole
 *  card is a tap target that opens the full card (sparkline, delta, 7-day avg)
 *  in a bottom sheet, so the phone grid stays glanceable without cramming five
 *  full cards into 375px. */
function MobileKpiCard({
  kpi,
  status,
  onOpen,
}: {
  kpi: DigestKpi;
  status: KpiDayStatus;
  onOpen: () => void;
}) {
  const reported = status.state === "reported";
  const neutral = isNeutralKpi(kpi.key);
  const valueStr = reported ? fmtByUnit(kpi.value, kpi.unit) : STATE_LABEL[status.state];

  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label={`${kpi.label} — tap for detail`}
      className={cn(
        "relative flex min-h-[76px] flex-col gap-1.5 overflow-hidden rounded-xl border p-3 text-left",
        "transition-colors duration-150 hover:border-primary/40 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        reported
          ? "bg-card/95 backdrop-blur supports-backdrop-filter:bg-card/70"
          : "bg-muted/30 supports-backdrop-filter:bg-muted/20",
        neutral && reported && "border-dashed bg-muted/30"
      )}
    >
      {!reported && (
        <span
          className={cn("absolute inset-y-0 left-0 w-[3px]", STATE_RAIL[status.state])}
          aria-hidden
        />
      )}
      <div className="flex items-center justify-between gap-1">
        <span className="truncate text-[10.5px] font-medium uppercase tracking-wide text-muted-foreground">
          {kpi.label}
        </span>
        {reported ? <DeltaBadge kpi={kpi} /> : <StateChip state={status.state} />}
      </div>
      <div className="flex items-baseline gap-1">
        <span
          className={cn(
            "font-mono font-semibold tabular-nums leading-none",
            reported ? "text-xl" : "text-sm text-muted-foreground"
          )}
        >
          {valueStr}
        </span>
        {reported && kpi.unit && (
          <span className="text-[10px] font-medium text-muted-foreground">
            {kpi.unit}
          </span>
        )}
      </div>
    </button>
  );
}

export function KpiHero({ kpis, dayStatus }: KpiHeroProps) {
  const [openKey, setOpenKey] = React.useState<string | null>(null);

  if (!kpis.length) {
    return (
      <div className="rounded-xl border border-dashed p-6 text-center text-sm text-muted-foreground">
        No operational data for today yet.
      </div>
    );
  }

  // Default to `reported` when a stream has no resolved status (e.g. the adapter
  // had no operational date) — preserves the prior behavior.
  const statusFor = (kpi: DigestKpi): KpiDayStatus =>
    dayStatus[kpi.key] ?? { state: "reported" as const };

  const openKpi = kpis.find((k) => k.key === openKey) ?? null;
  const openStatus = openKpi ? statusFor(openKpi) : null;

  return (
    <>
      {/* Desktop / tablet — full cards, IDENTICAL to the prior layout (grid,
          gap-3, stagger, 3-up on tablet portrait, 5-up on wide). */}
      <div className="hidden gap-3 stagger-children sm:grid sm:grid-cols-3 lg:grid-cols-5">
        {kpis.map((kpi) => {
          const status = statusFor(kpi);
          return status.state === "reported" ? (
            <KpiCard key={kpi.key} kpi={kpi} />
          ) : (
            <StateCard key={kpi.key} kpi={kpi} status={status} />
          );
        })}
      </div>

      {/* Phone — condensed 2-up cards; tap opens the full card in a bottom sheet. */}
      <div className="grid grid-cols-2 gap-2.5 stagger-fast sm:hidden">
        {kpis.map((kpi) => (
          <MobileKpiCard
            key={kpi.key}
            kpi={kpi}
            status={statusFor(kpi)}
            onOpen={() => setOpenKey(kpi.key)}
          />
        ))}
      </div>

      {/* Bottom-sheet detail for the tapped KPI (phone only — never mounts a
          trigger on desktop). Reuses the exact full KpiCard / StateCard. */}
      <Sheet open={openKey !== null} onOpenChange={(o) => !o && setOpenKey(null)}>
        <SheetContent
          side="bottom"
          className="max-h-[85dvh] gap-0 rounded-t-2xl pb-[max(1rem,env(safe-area-inset-bottom))]"
        >
          {openKpi && openStatus && (
            <>
              <SheetHeader className="px-4 pt-4">
                <SheetTitle className="uppercase tracking-wide">
                  {openKpi.label}
                </SheetTitle>
                <SheetDescription>
                  {openStatus.state === "reported"
                    ? "Operational-day value, delta and 7-day trend."
                    : "This stream has no active value today — here's why."}
                </SheetDescription>
              </SheetHeader>
              <div className="px-4 pt-1">
                {openStatus.state === "reported" ? (
                  <KpiCard kpi={openKpi} />
                ) : (
                  <StateCard kpi={openKpi} status={openStatus} />
                )}
                {isNeutralKpi(openKpi.key) && (
                  <p className="mt-3 rounded-lg border border-dashed bg-muted/30 p-3 text-[11px] leading-relaxed text-muted-foreground">
                    Continuous-flow drift is expected — the feed tank balances at
                    month-end, not day-to-day. This is informational, not an alert.
                  </p>
                )}
              </div>
            </>
          )}
        </SheetContent>
      </Sheet>
    </>
  );
}
