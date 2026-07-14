// No 'use client' — async Server Component (Dashboard Draft).
// A DRAFT proposal that reworks the Home Digest around operational-day STATES
// (reported / awaiting / rest / stale / idle) and adds a Production Schedule
// band sourced from the sheet's PROD SCHED plan. It reuses the LIVE digest
// adapter (getDigestData) for real KPIs/flow/meta, and stands in for the
// not-yet-ingested PROD SCHED tab with a labeled draft constant.
//
// Visual target/reference for this route was the static mock formerly at
// public/verbose-dashboard.html (now removed — this route supersedes it).
import { getDigestData } from "@/lib/digest/queries";
import { createClient } from "@/lib/supabase/server";
import {
  getMonthPlan,
  getPlanForDate,
  getWeekPlan,
  ORDER_COMMITMENTS,
  SETUP_REFERENCE,
} from "@/lib/digest/prod-schedule-draft";
import {
  resolveKpiDayStatus,
  resolveScheduleRowState,
  type KpiDayStatus,
} from "@/lib/digest/day-status";
import { PlantStatusHeader } from "@/components/digest/draft/plant-status-header";
import { DraftKpiHero } from "@/components/digest/draft/draft-kpi-hero";
import {
  DraftFlowChart,
  type DraftFlowPoint,
} from "@/components/digest/draft/draft-flow-chart";
import { WeekStrip, type WeekDay } from "@/components/digest/draft/week-strip";
import {
  ScheduleTable,
  type ScheduleRow,
} from "@/components/digest/draft/schedule-table";

/** How many trailing operational days the draft flow chart shows. */
const FLOW_WINDOW_DAYS = 9;

/** Derive {year, month} (month 1–12) from an operational date, else today. */
function yearMonthOf(operationalDate: string | null): { year: number; month: number } {
  if (operationalDate && operationalDate.length >= 7) {
    return {
      year: Number(operationalDate.slice(0, 4)),
      month: Number(operationalDate.slice(5, 7)),
    };
  }
  const now = new Date();
  return { year: now.getUTCFullYear(), month: now.getUTCMonth() + 1 };
}

/**
 * Actual production tons per date for a month. DRAFT rollup: sums
 * `production_runs.ttl_kg` grouped by the parent shift's `transaction_date`,
 * /1000 for tons. This TS-side sum is a stand-in ONLY — a real implementation
 * would read a `view_digest_day_status` SQL view (aggregation belongs in SQL
 * per the HARD RULE); it lives here because the PROD SCHED plan itself is not
 * yet in the DB, so there is no view to join against.
 */
async function getActualTonsByDate(
  year: number,
  month: number
): Promise<Map<string, number>> {
  const supabase = await createClient();
  const mm = String(month).padStart(2, "0");
  const monthStart = `${year}-${mm}-01`;
  const monthEnd = `${year}-${mm}-31`;

  const { data } = await supabase
    .from("production_shifts")
    .select("transaction_date, production_runs(ttl_kg)")
    .gte("transaction_date", monthStart)
    .lte("transaction_date", monthEnd);

  const kgByDate = new Map<string, number>();
  const rows =
    (data as
      | { transaction_date: string; production_runs: { ttl_kg: number }[] | null }[]
      | null) ?? [];
  for (const row of rows) {
    const runs = row.production_runs ?? [];
    const kg = runs.reduce((sum, r) => sum + (Number(r.ttl_kg) || 0), 0);
    kgByDate.set(row.transaction_date, (kgByDate.get(row.transaction_date) ?? 0) + kg);
  }

  const tonsByDate = new Map<string, number>();
  for (const [date, kg] of kgByDate) tonsByDate.set(date, kg / 1000);
  return tonsByDate;
}

export default async function DashboardDraftPage() {
  const data = await getDigestData();
  const opDate = data.meta.operationalDate;
  const { year, month } = yearMonthOf(opDate);

  const [actualTonsByDate] = await Promise.all([getActualTonsByDate(year, month)]);

  const todaysPlan = opDate ? getPlanForDate(opDate) : undefined;

  // ---- resolve each KPI to a day-status (the "misleading zero" fix) ----
  const statuses: Record<string, KpiDayStatus> = {};
  for (const kpi of data.kpis) {
    statuses[kpi.key] = resolveKpiDayStatus({
      kpiKey: kpi.key,
      value: kpi.value,
      operationalDate: opDate,
      plan: todaysPlan,
      streams: data.meta.streams,
    });
  }

  const fedKg = data.kpis.find((k) => k.key === "rc_out")?.value ?? 0;
  const streamsBehind = data.meta.streams.filter((s) => s.status === "warn").length;

  // ---- draft flow series: rest days = gap, awaiting days marked ----
  const flowTail = data.flow.slice(-FLOW_WINDOW_DAYS);
  const flowData: DraftFlowPoint[] = flowTail.map((f) => {
    const plan = getPlanForDate(f.date);
    const rest = plan?.shifts === 0;
    // out === 0 on a working day means the RC Out report hasn't landed yet
    const awaiting = !rest && f.out === 0 && (plan ? plan.shifts > 0 : true);
    return {
      date: f.date,
      inKg: f.in > 0 ? f.in : null, // no delivery → gap (procurement, not shift-bound)
      outKg: rest || f.out === 0 ? null : f.out, // rest / pending → gap, not a plunge
      rest,
      awaiting,
    };
  });

  // ---- this week: plan vs actual ----
  const week: WeekDay[] = opDate
    ? getWeekPlan(opDate).map((day) => ({
        day,
        actualTons: actualTonsByDate.get(day.date) ?? null,
        isToday: day.date === opDate,
      }))
    : [];

  // ---- month schedule: plan vs actual ----
  const scheduleRows: ScheduleRow[] = getMonthPlan(year, month).map((day) => {
    const actualTons = actualTonsByDate.get(day.date) ?? null;
    return {
      day,
      actualTons,
      state: resolveScheduleRowState(day, actualTons, opDate),
    };
  });

  const projectedTotal = scheduleRows.reduce((s, r) => s + r.day.projectedTons, 0);
  const actualTotal = scheduleRows.reduce((s, r) => s + (r.actualTons ?? 0), 0);
  const plannedDays = scheduleRows.filter((r) => r.day.shifts > 0).length;
  const reportsIn = scheduleRows.filter(
    (r) => r.actualTons != null && r.actualTons > 0
  ).length;

  return (
    <div className="mx-auto flex w-full max-w-7xl flex-col gap-6 px-4 py-5 sm:px-6">
      {/* DRAFT affordance + intro explainer */}
      <div className="animate-fade-up rounded-xl border border-dashed bg-muted/30 p-4">
        <div className="mb-1.5 flex items-center gap-2">
          <span className="rounded bg-violet-500/15 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-violet-700 dark:text-violet-300">
            Draft proposal
          </span>
          <span className="text-[11px] text-muted-foreground">
            not wired into the live digest — PROD SCHED stands in as a labeled constant
          </span>
        </div>
        <h2 className="text-sm font-semibold tracking-tight">
          A &ldquo;0&rdquo; can mean three different things — and today they all look
          identical.
        </h2>
        <p className="mt-1 max-w-[70ch] text-[13px] leading-relaxed text-muted-foreground">
          The live digest coalesces every empty stream to{" "}
          <span className="font-mono">0</span>, so a planned rest day, a report that
          hasn&rsquo;t landed yet, and a genuinely idle stream are indistinguishable —
          and a plain zero reads as an alarm. This draft resolves each stream to an{" "}
          <span className="font-medium text-foreground/80">operational-day status</span>{" "}
          using the PROD SCHED plan: <b>rest</b> (planned, calm), <b>awaiting</b> (plant
          ran, report late — projection ghosted), <b>stale</b> (stream overdue), or{" "}
          <b>reported</b> (real value + delta).
        </p>
      </div>

      {/* Plant status header */}
      <section>
        <PlantStatusHeader
          operationalDate={opDate}
          plan={todaysPlan}
          fedKg={fedKg}
          lastSyncAt={data.meta.lastSyncAt}
          freshness={data.meta.freshness}
          streamsBehind={streamsBehind}
        />
      </section>

      {/* State-aware KPI hero */}
      <section className="flex flex-col gap-2">
        <div className="flex items-baseline justify-between gap-2">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Headline KPIs
          </h2>
          <span className="text-[11px] text-muted-foreground">
            state resolved per stream against the day&rsquo;s plan — not a bare number
          </span>
        </div>
        <DraftKpiHero kpis={data.kpis} statuses={statuses} />
      </section>

      {/* Rest-day-aware flow chart */}
      <section>
        <DraftFlowChart data={flowData} />
      </section>

      {/* This week · plan vs actual */}
      <section className="flex flex-col gap-2">
        <div className="flex items-baseline justify-between gap-2">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            This week · plan vs actual
          </h2>
          <span className="text-[11px] text-muted-foreground">
            new digest band, sourced from PROD SCHED
          </span>
        </div>
        <WeekStrip week={week} />
      </section>

      {/* Production Schedule band */}
      <section className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-x-5 gap-y-2 rounded-xl border bg-card/95 p-4 backdrop-blur supports-backdrop-filter:bg-card/70">
          <div className="flex flex-col">
            <span className="text-base font-semibold tracking-tight">
              Production Schedule — {scheduleRows[0]?.day.date.slice(0, 7) ?? "—"}
            </span>
            <span className="text-xs text-muted-foreground">
              from the PROD SCHED tab · KC 3X50 + MH 4X8 campaign
            </span>
          </div>
          <div className="flex-1" />
          <div className="flex flex-col gap-0.5">
            <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground/80">
              Planned days
            </span>
            <span className="font-mono text-sm font-semibold tabular-nums">
              {plannedDays}
            </span>
          </div>
          <div className="flex flex-col gap-0.5">
            <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground/80">
              Projected
            </span>
            <span className="font-mono text-sm font-semibold tabular-nums text-violet-600 dark:text-violet-300">
              {projectedTotal.toFixed(0)} t
            </span>
          </div>
          <div className="flex flex-col gap-0.5">
            <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground/80">
              Actual to date
            </span>
            <span className="font-mono text-sm font-semibold tabular-nums">
              {actualTotal.toFixed(1)} t
            </span>
          </div>
          <div className="flex flex-col gap-0.5">
            <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground/80">
              Reports in
            </span>
            <span className="font-mono text-sm font-semibold tabular-nums text-amber-700 dark:text-amber-300">
              {reportsIn} / {plannedDays}
            </span>
          </div>
        </div>

        <ScheduleTable
          rows={scheduleRows}
          orders={ORDER_COMMITMENTS}
          setupReference={SETUP_REFERENCE}
          operationalDate={opDate}
        />
      </section>
    </div>
  );
}
