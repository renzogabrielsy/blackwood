// Async Server Component — the Production Schedule MONTH view (plan vs actual).
//
// Extracted verbatim from the retired `/production/schedule` page so the schedule
// can live in the DIGEST world: it is now rendered by `/` under `?view=schedule`
// (see app/(app)/page.tsx + components/digest/home-view-toggle.tsx). The route
// `/production/schedule` redirects here, so the production tab shell (Daily ·
// Electricity · Trucks) no longer wraps it.
//
// Domain layer (charcoal-shaped): queries the `production_schedule` table plus
// `view_digest_prod_actual_tons` / `view_digest_daily_hours` DIRECTLY (this is the
// tenant CRUD layer, NOT the digest adapter). No ₱ anywhere — tons only — so no
// price gating needed.
//
// The component renders NO outer page container (no `mx-auto max-w-7xl`): the host
// page owns the shell. Month nav hrefs are built from `basePath` + `extraParams`,
// so the host decides which sibling params (e.g. `view=schedule`) survive.
import Link from "next/link";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { cn } from "@/lib/utils";
import {
  resolveScheduleRowState,
  type ScheduleRowState,
} from "@/lib/digest/day-status";
import { STATE_CHIP, STATE_LABEL } from "@/components/digest/status-tokens";
import {
  parseGradeTons,
  fmtGradeTons,
  gradeTonsTitle,
  type GradeTon,
} from "@/components/digest/format";
import {
  ScheduleCardsMobile,
  type ScheduleMobileRow,
} from "@/components/digest/schedule-cards-mobile";

// ---------------------------------------------------------------------
// Month helpers (pure yyyy-MM string math — no aggregation)
// ---------------------------------------------------------------------

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

const DOW_NAMES = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];

/** Weekday name for a yyyy-MM-dd date (UTC) — fallback when a row's dow is null. */
function dowNameFor(date: string): string {
  return DOW_NAMES[new Date(date + "T00:00:00Z").getUTCDay()] ?? "";
}

interface MonthBounds {
  month: string; // yyyy-MM
  year: number;
  monthNum: number; // 1-12
  start: string; // yyyy-MM-01
  end: string; // yyyy-MM-<lastDay>
  label: string; // e.g. "July 2026"
  prev: string; // yyyy-MM
  next: string; // yyyy-MM
}

function monthBounds(month: string): MonthBounds {
  const year = Number(month.slice(0, 4));
  const monthNum = Number(month.slice(5, 7));
  const daysInMonth = new Date(Date.UTC(year, monthNum, 0)).getUTCDate();
  const pad = (n: number) => String(n).padStart(2, "0");
  const prevY = monthNum === 1 ? year - 1 : year;
  const prevM = monthNum === 1 ? 12 : monthNum - 1;
  const nextY = monthNum === 12 ? year + 1 : year;
  const nextM = monthNum === 12 ? 1 : monthNum + 1;
  const label = new Date(Date.UTC(year, monthNum - 1, 1)).toLocaleDateString(
    "en-US",
    { month: "long", year: "numeric", timeZone: "UTC" }
  );
  return {
    month,
    year,
    monthNum,
    start: `${month}-01`,
    end: `${month}-${pad(daysInMonth)}`,
    label,
    prev: `${prevY}-${pad(prevM)}`,
    next: `${nextY}-${pad(nextM)}`,
  };
}

// ---------------------------------------------------------------------
// Row model
// ---------------------------------------------------------------------

interface ScheduleRow {
  date: string;
  dow: string;
  shifts: number;
  setup: string | null;
  /** per-grade projected tonnage (from the `grades` JSONB), heaviest first;
   *  empty on a rest day. The day TOTAL stays in `projectedTons`. */
  gradeTons: GradeTon[];
  projectedTons: number | null;
  actualTons: number | null;
  /** actual hours WORKED for the day (view_digest_daily_hours.work_hrs), or null
   *  when that date has no production/hours row (muted dash). */
  actualHrs: number | null;
  variance: number | null; // actual − projected (only when actual present)
  remarks: string | null;
  isJoseph: boolean;
  state: ScheduleRowState;
  isToday: boolean;
  isRest: boolean;
}

/** Compact tons — whole numbers bare, else one decimal. */
function fmtTons(v: number | null): string {
  if (v == null) return "—";
  return Number.isInteger(v) ? String(v) : v.toFixed(1);
}

/** Signed variance, one decimal, with a leading + on gains. */
function fmtVariance(v: number): string {
  const sign = v > 0 ? "+" : "";
  return `${sign}${v.toFixed(1)}`;
}

// ---------------------------------------------------------------------
// Column widths (Excel Standard — table-fixed, explicit px)
// ---------------------------------------------------------------------
const COL = {
  date: "w-[104px]",
  day: "w-[92px]",
  setup: "w-[132px]",
  grades: "w-[188px]",
  shifts: "w-[62px]",
  projected: "w-[92px]",
  actual: "w-[86px]",
  actualHrs: "w-[80px]",
  variance: "w-[80px]",
  status: "w-[128px]",
  source: "w-[86px]",
  remarks: "w-[240px]",
} as const;

interface ScheduleMonthViewProps {
  /** `?month=YYYY-MM` from the host page (validated here; falls back to the
   *  operational month). */
  month?: string;
  /** Route the prev/next month links point at (e.g. `/`). */
  basePath: string;
  /** Sibling query params the month links must preserve (e.g. `{ view: 'schedule' }`). */
  extraParams?: Record<string, string>;
}

export async function ScheduleMonthView({
  month: monthParam,
  basePath,
  extraParams,
}: ScheduleMonthViewProps) {
  const supabase = await createClient();

  // Default month = the operational month (falls back to today's month).
  let defaultMonth: string;
  const { data: opDays } = await supabase
    .from("view_digest_operational_days")
    .select("operational_date")
    .maybeSingle();
  const operationalDate = opDays?.operational_date ?? null;
  if (operationalDate) {
    defaultMonth = operationalDate.slice(0, 7);
  } else {
    defaultMonth = new Date().toISOString().slice(0, 7);
  }

  const month =
    monthParam && MONTH_RE.test(monthParam) ? monthParam : defaultMonth;
  const bounds = monthBounds(month);

  /** Month-nav href — keeps the host's sibling params (e.g. `view=schedule`). */
  const monthHref = (m: string) => {
    const params = new URLSearchParams(extraParams);
    params.set("month", m);
    return `${basePath}?${params.toString()}`;
  };

  // Plan (production_schedule) + actual tons (view) + actual worked hours (view)
  // for the month, all joined by date.
  const [schedRes, actualRes, hoursRes] = await Promise.all([
    supabase
      .from("production_schedule")
      .select("plan_date, dow, shifts, setup, projected_tons, grades, remarks, source")
      .gte("plan_date", bounds.start)
      .lte("plan_date", bounds.end)
      .order("plan_date", { ascending: true }),
    supabase
      .from("view_digest_prod_actual_tons")
      .select("date, actual_tons")
      .gte("date", bounds.start)
      .lte("date", bounds.end),
    supabase
      .from("view_digest_daily_hours")
      .select("date, work_hrs")
      .gte("date", bounds.start)
      .lte("date", bounds.end),
  ]);

  const actualByDate = new Map<string, number>();
  for (const a of actualRes.data ?? []) {
    if (a.date != null && a.actual_tons != null) {
      actualByDate.set(a.date, Number(a.actual_tons));
    }
  }

  const hoursByDate = new Map<string, number>();
  for (const h of hoursRes.data ?? []) {
    if (h.date != null && h.work_hrs != null) {
      hoursByDate.set(h.date, Number(h.work_hrs));
    }
  }

  const rows: ScheduleRow[] = (schedRes.data ?? []).map((r) => {
    const shifts = Math.trunc(Number(r.shifts ?? 0));
    const projectedTons =
      r.projected_tons == null ? null : Number(r.projected_tons);
    const actualTons = actualByDate.has(r.plan_date)
      ? actualByDate.get(r.plan_date)!
      : null;
    const actualHrs = hoursByDate.has(r.plan_date)
      ? hoursByDate.get(r.plan_date)!
      : null;
    const variance =
      actualTons != null && projectedTons != null
        ? actualTons - projectedTons
        : null;
    const isRest = shifts === 0;
    const state = resolveScheduleRowState(
      // resolveScheduleRowState only reads .shifts and .date
      { date: r.plan_date, dow: r.dow ?? "", shifts: shifts as 0 | 1 | 2, setup: r.setup, projectedTons: projectedTons ?? 0 },
      actualTons,
      operationalDate
    );
    return {
      date: r.plan_date,
      dow: r.dow ?? dowNameFor(r.plan_date),
      shifts,
      setup: r.setup,
      gradeTons: parseGradeTons(r.grades),
      projectedTons,
      actualTons,
      actualHrs,
      variance,
      remarks: r.remarks,
      isJoseph: (r.source ?? "").startsWith("joseph:"),
      state,
      isToday: r.plan_date === operationalDate,
      isRest,
    };
  });

  // Month totals (presentational sum of already-correct per-day tons — this is a
  // simple display footer, not a business aggregation; the actual tons are
  // SUMmed in the SQL view, projected is the plan figure straight from the row).
  const totalProjected = rows.reduce((s, r) => s + (r.projectedTons ?? 0), 0);
  const totalActual = rows.reduce((s, r) => s + (r.actualTons ?? 0), 0);
  const totalActualHrs = rows.reduce((s, r) => s + (r.actualHrs ?? 0), 0);
  const totalVariance = totalActual - totalProjected;

  // Phone read layer — same `rows` (single source of truth), reshaped to the
  // shared ScheduleRowCard contract. chipState mirrors the desktop table's
  // "today wins unless already reported" rule.
  const mobileRows: ScheduleMobileRow[] = rows.map((r) => ({
    date: r.date,
    dow: r.dow,
    shifts: r.shifts,
    setup: r.setup,
    gradeTons: r.gradeTons,
    projectedTons: r.projectedTons,
    actualTons: r.actualTons,
    actualHrs: r.actualHrs,
    variance: r.variance,
    state: r.state,
    isToday: r.isToday,
    chipState: r.isToday && r.state !== "reported" ? "today" : r.state,
  }));

  const headCls =
    "frozen-row bg-muted px-2 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground";

  return (
    <div className="flex w-full flex-col gap-4">
      {/* Month switcher (navbar owns the page title — this is a sub-band). */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Link
            href={monthHref(bounds.prev)}
            className="inline-flex h-7 items-center gap-1 rounded-md border bg-card px-2 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            <ChevronLeft className="h-3.5 w-3.5" />
            Prev
          </Link>
          <span className="min-w-[120px] text-center text-sm font-semibold tabular-nums">
            {bounds.label}
          </span>
          <Link
            href={monthHref(bounds.next)}
            className="inline-flex h-7 items-center gap-1 rounded-md border bg-card px-2 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            Next
            <ChevronRight className="h-3.5 w-3.5" />
          </Link>
        </div>
        <div className="flex items-center gap-3 text-[11px] text-muted-foreground">
          <span className="inline-flex items-center gap-1.5">
            <span className="inline-block h-2 w-2 rounded-sm bg-violet-500/60" />
            Joseph (authoritative)
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span className="inline-block h-2 w-2 rounded-sm bg-muted-foreground/40" />
            Sheet
          </span>
        </div>
      </div>

      {rows.length === 0 ? (
        <div className="flex h-40 items-center justify-center rounded-xl border bg-card/95 text-sm text-muted-foreground">
          No schedule on record for {bounds.label}.
        </div>
      ) : (
        <>
        {/* Phone — full-month condensed card list (desktop table hidden). */}
        <div className="sm:hidden">
          <ScheduleCardsMobile rows={mobileRows} />
        </div>

        {/* Tablet / desktop — the dense Excel-Standard table (unchanged). */}
        <div className="hidden animate-fade-up overflow-x-auto rounded-xl border bg-card/95 backdrop-blur supports-backdrop-filter:bg-card/70 sm:block">
          <table className="w-full min-w-[1080px] table-fixed border-collapse text-xs">
            <thead>
              <tr>
                <th className={cn(headCls, COL.date, "text-left")}>Date</th>
                <th className={cn(headCls, COL.day, "text-left")}>Day</th>
                <th className={cn(headCls, COL.setup, "text-left")}>Setup</th>
                <th className={cn(headCls, COL.grades, "text-left")}>
                  Grades (t)
                </th>
                <th className={cn(headCls, COL.shifts, "text-right")}>Shifts</th>
                <th className={cn(headCls, COL.projected, "text-right")}>
                  Proj t
                </th>
                <th className={cn(headCls, COL.actual, "text-right")}>Act t</th>
                <th className={cn(headCls, COL.actualHrs, "text-right")}>
                  Act hrs
                </th>
                <th className={cn(headCls, COL.variance, "text-right")}>Var</th>
                <th className={cn(headCls, COL.status, "text-left")}>Status</th>
                <th className={cn(headCls, COL.source, "text-left")}>Source</th>
                <th className={cn(headCls, COL.remarks, "text-left")}>
                  Remarks
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const chipState = r.isToday && r.state !== "reported" ? "today" : r.state;
                return (
                  <tr
                    key={r.date}
                    className={cn(
                      "h-8 border-t transition-colors hover:bg-muted/40",
                      r.isRest && "bg-muted/20 text-muted-foreground",
                      r.isToday && "bg-amber-500/[0.07]"
                    )}
                  >
                    <td
                      className={cn(
                        "px-2 py-1 font-mono tabular-nums",
                        r.isToday && "font-semibold text-foreground"
                      )}
                    >
                      {r.date}
                    </td>
                    <td className="px-2 py-1">{r.dow.slice(0, 3)}</td>
                    <td
                      className={cn(
                        "truncate px-2 py-1",
                        r.isRest && "italic text-muted-foreground/70"
                      )}
                      title={r.setup ?? undefined}
                    >
                      {r.setup ?? "— off —"}
                    </td>
                    <td className="px-2 py-1">
                      {r.gradeTons.length === 0 ? (
                        <span className="text-muted-foreground">—</span>
                      ) : (
                        <div
                          className="flex items-center gap-1 overflow-hidden"
                          title={gradeTonsTitle(r.gradeTons)}
                        >
                          {r.gradeTons.map((g) => (
                            <span
                              key={g.grade}
                              className="inline-flex shrink-0 items-baseline gap-0.5 rounded bg-muted px-1 py-0.5 text-[10px] font-medium leading-none"
                            >
                              <span className="uppercase tracking-tight">
                                {g.grade}
                              </span>
                              <span className="font-mono tabular-nums text-muted-foreground">
                                {fmtGradeTons(g.tons)}t
                              </span>
                            </span>
                          ))}
                        </div>
                      )}
                    </td>
                    <td className="px-2 py-1 text-right font-mono tabular-nums">
                      {r.shifts}
                    </td>
                    <td className="px-2 py-1 text-right font-mono tabular-nums text-violet-600 dark:text-violet-300">
                      {r.projectedTons ? fmtTons(r.projectedTons) : "—"}
                    </td>
                    <td className="px-2 py-1 text-right font-mono tabular-nums">
                      {fmtTons(r.actualTons)}
                    </td>
                    <td
                      className={cn(
                        "px-2 py-1 text-right font-mono tabular-nums",
                        r.actualHrs == null && "text-muted-foreground"
                      )}
                    >
                      {fmtTons(r.actualHrs)}
                    </td>
                    <td
                      className={cn(
                        "px-2 py-1 text-right font-mono tabular-nums",
                        r.variance == null
                          ? "text-muted-foreground"
                          : r.variance > 0
                            ? "text-emerald-600 dark:text-emerald-400"
                            : r.variance < 0
                              ? "text-red-600 dark:text-red-400"
                              : "text-muted-foreground"
                      )}
                    >
                      {r.variance == null ? "—" : fmtVariance(r.variance)}
                    </td>
                    <td className="px-2 py-1">
                      <span
                        className={cn(
                          "inline-block rounded-md px-1.5 py-0.5 text-[10px] font-semibold",
                          STATE_CHIP[chipState]
                        )}
                      >
                        {chipState === "today"
                          ? "Today"
                          : STATE_LABEL[chipState]}
                      </span>
                    </td>
                    <td className="px-2 py-1">
                      <span
                        className={cn(
                          "inline-block rounded px-1.5 py-0.5 text-[10px] font-medium",
                          r.isJoseph
                            ? "bg-violet-500/12 text-violet-700 dark:text-violet-300"
                            : "bg-muted text-muted-foreground"
                        )}
                      >
                        {r.isJoseph ? "Joseph" : "Sheet"}
                      </span>
                    </td>
                    <td
                      className="max-w-[240px] truncate px-2 py-1 text-muted-foreground"
                      title={r.remarks ?? undefined}
                    >
                      {r.remarks ?? ""}
                    </td>
                  </tr>
                );
              })}
            </tbody>
            <tfoot>
              <tr className="frozen-row-bottom frozen-edge-top h-8 bg-muted font-semibold">
                <td className="px-2 py-1 text-[11px] uppercase tracking-wide text-muted-foreground" colSpan={5}>
                  Month total · {rows.length} days
                </td>
                <td className="px-2 py-1 text-right font-mono tabular-nums text-violet-600 dark:text-violet-300">
                  {fmtTons(totalProjected)}
                </td>
                <td className="px-2 py-1 text-right font-mono tabular-nums">
                  {fmtTons(totalActual)}
                </td>
                <td className="px-2 py-1 text-right font-mono tabular-nums">
                  {fmtTons(totalActualHrs)}
                </td>
                <td
                  className={cn(
                    "px-2 py-1 text-right font-mono tabular-nums",
                    totalVariance > 0
                      ? "text-emerald-600 dark:text-emerald-400"
                      : totalVariance < 0
                        ? "text-red-600 dark:text-red-400"
                        : "text-muted-foreground"
                  )}
                >
                  {fmtVariance(totalVariance)}
                </td>
                <td colSpan={3} />
              </tr>
            </tfoot>
          </table>
        </div>
        </>
      )}
    </div>
  );
}
