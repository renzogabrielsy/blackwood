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
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Maximize2 } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  fmtByUnit,
  fmtDayAge,
  fmtDeltaPct,
  fmtMissedDays,
  fmtReportsDue,
  fmtShortDate,
} from "./format";
import { useDrilldown } from "./drilldown/use-drilldown";
import { RcInDrilldownModal } from "./drilldown/rc-in-drilldown";
import { getRcInDrilldown } from "@/app/(app)/drilldown-actions";
import { STATE_CHIP, STATE_LABEL, STATE_RAIL } from "./status-tokens";
import type { DigestKpi } from "@/lib/digest/types";
import {
  LATE_AFTER_MISSED_DAYS,
  type KpiDayStatus,
} from "@/lib/digest/day-status";

interface KpiHeroProps {
  kpis: DigestKpi[];
  /** kpi.key → resolved day state (the "misleading zero" + lag-by-design fix).
   *  `reported` cards show the number + delta + sparkline; every other state
   *  shows a state label + severity rail + chip instead of a bare 0.
   *
   *  A LAG-BY-DESIGN stream (production / power / rc_out — the operator files
   *  them the following morning) is anchored to its latest REPORTED day, so
   *  its `reported` card additionally carries `asOf` and renders that date
   *  prominently. The amber/late treatment fires off `missedDays` — planned
   *  WORKING days of outstanding reports — never off "today has no row". */
  dayStatus: Record<string, KpiDayStatus>;
}

/** Is this card's stream behind on a report that was genuinely due? */
function isLate(status: KpiDayStatus): boolean {
  return (status.missedDays ?? 0) >= LATE_AFTER_MISSED_DAYS;
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

/** The date a lag-by-design card's number belongs to — rendered right next to
 *  the label so the value can NEVER be read as today's. Muted when the stream
 *  is on time, amber the moment a planned working day's report is outstanding.
 *  Renders nothing when the value IS the operational date's. */
function AsOfChip({ status }: { status: KpiDayStatus }) {
  if (!status.asOf) return null;
  const late = isLate(status);
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center rounded px-1.5 py-0.5 font-mono text-[10px] font-semibold tabular-nums",
        late
          ? "bg-amber-500/15 text-amber-700 dark:text-amber-300"
          : "bg-muted text-muted-foreground"
      )}
      title={`Latest reported day: ${status.asOf}`}
    >
      {fmtShortDate(status.asOf)}
    </span>
  );
}

/** Plain-text "when / how late" line for a lag-anchored card. The `AsOf` chip
 *  already carries the date, so this line carries the QUALIFIER: how old the
 *  number is, or — once a report is genuinely due — how late that report is.
 *  Kept to one short phrase; the sub-line shares its row with the 7-day avg. */
function lagNote(status: KpiDayStatus): string | null {
  if (!status.asOf) return null;
  return isLate(status) && status.missedDays != null
    ? fmtReportsDue(status.missedDays)
    : fmtDayAge(status.asOfAgeDays);
}

/** State pill for a non-reported card (Awaiting report / Report overdue / …). */
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
 *  value today). Covers `awaiting` / `stale` / `idle`.
 *
 *  An OVERDUE lag-by-design stream (`stale` with an `asOf`) keeps the alarm —
 *  red rail, red chip, an explicit "N working days behind" — but no longer
 *  throws the information away: it shows WHAT was last reported and WHEN, so
 *  the card is specific rather than blank. */
function StateCard({ kpi, status }: { kpi: DigestKpi; status: KpiDayStatus }) {
  const { state } = status;
  // An overdue stream we still have a real last reading for.
  const lastReading = state === "stale" && status.asOf ? status.asOf : null;

  // NOTE (2026-08-28): an `awaiting` card used to ghost the day's PROJECTED
  // tonnage from the `production_schedule` plan. The plan is retired, so the
  // card simply says the report is awaited rather than inventing a target.
  const ghost =
    lastReading ? (
      <>last reported {fmtShortDate(lastReading)}</>
    ) : state === "stale" && status.staleDays != null ? (
      // No usable last reading (never reported, or older than the loaded
      // 120-day window) — `staleDays` counts WORKING days, same as missedDays.
      <>{fmtMissedDays(status.staleDays)}</>
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
        {lastReading ? (
          // The last REAL number, dated by the ghost line directly below and
          // held back from the `reported` treatment (muted, no delta badge) so
          // it reads as history, not as today.
          <>
            <span className="font-mono text-xl font-semibold tabular-nums leading-none text-muted-foreground">
              {fmtByUnit(kpi.value, kpi.unit)}
            </span>
            {kpi.unit && (
              <span className="text-[11px] font-medium text-muted-foreground">
                {kpi.unit}
              </span>
            )}
          </>
        ) : (
          <span className="text-base font-semibold leading-tight text-muted-foreground">
            {STATE_LABEL[state]}
          </span>
        )}
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
      {/* no misleading sparkline — this stream has no active value today. For
          an overdue stream the slot carries the lateness instead, in working
          days (rest days excluded), which is the actionable number. */}
      <div
        className={cn(
          "flex h-10 w-full items-center justify-center rounded bg-muted/30 text-[10px]",
          lastReading && status.missedDays != null
            ? "font-medium text-red-700 dark:text-red-300"
            : "italic text-muted-foreground/70"
        )}
      >
        {lastReading && status.missedDays != null
          ? fmtMissedDays(status.missedDays)
          : "no active series"}
      </div>
    </div>
  );
}

function KpiCard({ kpi, status }: { kpi: DigestKpi; status: KpiDayStatus }) {
  const neutral = isNeutralKpi(kpi.key);
  const valueStr = fmtByUnit(kpi.value, kpi.unit);
  const note = lagNote(status);
  // Amber only when a planned working day's report is genuinely outstanding —
  // NOT merely because a next-day stream has no row for today.
  const late = isLate(status);

  const card = (
    <div
      className={cn(
        "hover-lift relative flex flex-col gap-2 overflow-hidden rounded-xl border p-3.5",
        "bg-card/95 backdrop-blur supports-backdrop-filter:bg-card/70",
        neutral && "border-dashed bg-muted/30 supports-backdrop-filter:bg-muted/20"
      )}
    >
      {late && (
        <span
          className={cn("absolute inset-y-0 left-0 w-[3px]", STATE_RAIL.awaiting)}
          aria-hidden
        />
      )}
      <div className="flex items-center justify-between gap-2">
        <span className="truncate text-xs font-medium uppercase tracking-wide text-muted-foreground">
          {kpi.label}
        </span>
        <DeltaBadge kpi={kpi} />
      </div>

      {/* The as-of date sits ON the value row, not beside the label: it
          qualifies the NUMBER, and putting it in the header squeezed long
          labels ("PRODUCTION") into an ellipsis at 5-up. */}
      <div className="flex items-baseline justify-between gap-2">
        <span className="flex min-w-0 items-baseline gap-1.5">
          <span className="font-mono text-2xl font-semibold tabular-nums leading-none">
            {valueStr}
          </span>
          {kpi.unit && (
            <span className="text-xs font-medium text-muted-foreground">
              {kpi.unit}
            </span>
          )}
        </span>
        <AsOfChip status={status} />
      </div>

      <div className="flex min-h-4 items-baseline justify-between gap-2 text-[11px] text-muted-foreground">
        <span
          className={cn("truncate", late && "text-amber-700 dark:text-amber-400")}
          title={note ?? undefined}
        >
          {note ? (
            note
          ) : kpi.sub ? (
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
  const late = isLate(status);
  // An overdue lag-by-design stream still has a real last reading — show it
  // (muted) rather than a bare state label, same as the desktop StateCard.
  const lastReading = !reported && status.asOf ? status.asOf : null;
  const showValue = reported || lastReading !== null;
  const valueStr = showValue
    ? fmtByUnit(kpi.value, kpi.unit)
    : STATE_LABEL[status.state];
  // The date the number belongs to — always rendered when it isn't today's,
  // so a phone glance can't mistake a two-day-old figure for the current one.
  const dateLabel = status.asOf ? fmtShortDate(status.asOf) : null;

  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label={`${kpi.label} — tap for detail`}
      className={cn(
        "relative flex min-h-[84px] flex-col gap-1 overflow-hidden rounded-xl border p-3 text-left",
        "transition-colors duration-150 hover:border-primary/40 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        reported
          ? "bg-card/95 backdrop-blur supports-backdrop-filter:bg-card/70"
          : "bg-muted/30 supports-backdrop-filter:bg-muted/20",
        neutral && reported && "border-dashed bg-muted/30"
      )}
    >
      {(!reported || late) && (
        <span
          className={cn(
            "absolute inset-y-0 left-0 w-[3px]",
            STATE_RAIL[reported ? "awaiting" : status.state]
          )}
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
            reported ? "text-xl" : "text-base text-muted-foreground",
            !showValue && "text-sm"
          )}
        >
          {valueStr}
        </span>
        {showValue && kpi.unit && (
          <span className="text-[10px] font-medium text-muted-foreground">
            {kpi.unit}
          </span>
        )}
      </div>
      {dateLabel && (
        <span
          className={cn(
            "truncate font-mono text-[10px] tabular-nums",
            // Match the card's own severity: red once overdue, amber while a
            // report is merely due, muted when the stream is simply next-day.
            status.state === "stale"
              ? "text-red-700 dark:text-red-300"
              : late
                ? "text-amber-700 dark:text-amber-400"
                : "text-muted-foreground"
          )}
        >
          {dateLabel}
          {status.missedDays != null &&
            status.missedDays >= LATE_AFTER_MISSED_DAYS &&
            ` · ${fmtReportsDue(status.missedDays)}`}
        </span>
      )}
    </button>
  );
}

/** Which KPI tiles open a drill-down. RC IN is the prototype; the chassis is
 *  deliberately generic, so adding a tile here is one entry plus a fetcher. */
const DRILLDOWN_KPI = "rc_in";

/**
 * THE DRILL-DOWN AFFORDANCE. Wraps an EXISTING KPI card in a real `<button>`
 * without touching a pixel of the card itself, so the tile's look is unchanged
 * and only the interaction is added: pointer cursor, a soft ring on hover, a
 * focus ring for keyboards, and a small expand glyph that fades in on
 * hover/focus so the capability is discoverable without being loud.
 *
 * Opacity + ring only — no layout property animates (CLAUDE.md motion rules),
 * and the card's own `hover-lift` keeps running underneath.
 */
function ExpandableTile({
  label,
  onOpen,
  children,
}: {
  label: string;
  onOpen: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label={`${label} — open detailed chart`}
      className={cn(
        "group relative block w-full rounded-xl text-left",
        "cursor-pointer transition-shadow duration-150",
        "hover:ring-2 hover:ring-primary/30",
        "focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      )}
    >
      {children}
      <span
        aria-hidden
        className="pointer-events-none absolute bottom-2 right-2 inline-flex items-center justify-center rounded-md bg-card/85 p-1 text-muted-foreground opacity-0 backdrop-blur-sm transition-opacity duration-150 group-hover:opacity-100 group-focus-visible:opacity-100"
      >
        <Maximize2 className="size-3.5" />
      </span>
    </button>
  );
}

export function KpiHero({ kpis, dayStatus }: KpiHeroProps) {
  const [openKey, setOpenKey] = React.useState<string | null>(null);
  // Open-first drill-down for the RC IN tile — the modal appears on the click
  // frame with a chart-shaped skeleton and the fetch runs concurrently. Adding
  // the next tile is one more `useDrilldown(...)` + one more modal.
  const rcInDrilldown = useDrilldown(getRcInDrilldown);

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
          const card =
            status.state === "reported" ? (
              <KpiCard kpi={kpi} status={status} />
            ) : (
              <StateCard kpi={kpi} status={status} />
            );
          // Only the prototype tile is interactive this pass; every other card
          // renders EXACTLY as before.
          return kpi.key === DRILLDOWN_KPI ? (
            <ExpandableTile
              key={kpi.key}
              label={kpi.label}
              onOpen={rcInDrilldown.open}
            >
              {card}
            </ExpandableTile>
          ) : (
            <React.Fragment key={kpi.key}>{card}</React.Fragment>
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

      {/* Centered-modal detail for the tapped KPI (phone only — the triggering
          MobileKpiCard grid is `sm:hidden`, so no useMediaQuery is needed). The
          content is SHORT and fixed-height (one card), so a Dialog is correct: a
          bottom sheet would hug the bottom under a dimmed void. Tall SCROLLING
          content (the schedule full table) keeps its bottom sheet. Reuses the
          exact full KpiCard / StateCard. */}
      <Dialog open={openKey !== null} onOpenChange={(o) => !o && setOpenKey(null)}>
        <DialogContent className="max-h-[85dvh] gap-0 overflow-y-auto p-4">
          {openKpi && openStatus && (
            <>
              <DialogHeader className="pb-2">
                <DialogTitle className="uppercase tracking-wide">
                  {openKpi.label}
                </DialogTitle>
                <DialogDescription>
                  {openStatus.state !== "reported"
                    ? "This stream has no active value today — here's why."
                    : openStatus.asOf
                      ? `Reported for ${openStatus.asOf} — this stream is filed the morning after.`
                      : "Operational-day value, delta and 7-day trend."}
                </DialogDescription>
              </DialogHeader>
              <div>
                {openStatus.state === "reported" ? (
                  <KpiCard kpi={openKpi} status={openStatus} />
                ) : (
                  <StateCard kpi={openKpi} status={openStatus} />
                )}
                {isNeutralKpi(openKpi.key) && (
                  <p className="mt-3 rounded-lg border border-dashed bg-muted/30 p-3 text-[11px] leading-relaxed text-muted-foreground">
                    Continuous-flow drift is expected — the feed tank balances at
                    month-end, not day-to-day. This is informational, not an alert.
                  </p>
                )}
                {/* Phone route into the drill-down. The KPI sheet CLOSES first —
                    two stacked Radix dialogs fight over the focus trap, and the
                    drill-down is the surface the user asked for. */}
                {openKpi.key === DRILLDOWN_KPI && (
                  <button
                    type="button"
                    onClick={() => {
                      setOpenKey(null);
                      rcInDrilldown.open();
                    }}
                    className="mt-3 inline-flex w-full cursor-pointer items-center justify-center gap-1.5 rounded-lg border bg-card/60 px-3 py-2 text-xs font-medium transition-colors duration-150 hover:bg-muted focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <Maximize2 className="size-3.5" />
                    Open detailed chart
                  </button>
                )}
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>

      {/* The RC IN drill-down. Mounted once for both the desktop tile and the
          phone sheet's button — one controller, one modal, no duplicate state. */}
      <RcInDrilldownModal
        {...rcInDrilldown.modalProps}
        data={rcInDrilldown.data}
      />
    </>
  );
}
