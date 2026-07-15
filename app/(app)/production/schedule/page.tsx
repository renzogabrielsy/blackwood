// Async Server Component — the Production Schedule table (month plan-vs-actual).
// Domain layer (charcoal-shaped): queries the `production_schedule` table and
// `view_digest_prod_actual_tons` DIRECTLY (this is the tenant CRUD layer, NOT
// the digest adapter). No ₱ anywhere — tons only — so no price gating needed.
import Link from "next/link";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { cn } from "@/lib/utils";
import {
  resolveScheduleRowState,
  type ScheduleRowState,
} from "@/lib/digest/day-status";
import { STATE_CHIP, STATE_LABEL } from "@/components/digest/status-tokens";

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
  grades: string | null;
  projectedTons: number | null;
  actualTons: number | null;
  variance: number | null; // actual − projected (only when actual present)
  remarks: string | null;
  isJoseph: boolean;
  state: ScheduleRowState;
  isToday: boolean;
  isRest: boolean;
}

/** Render the `grades` JSONB ({ "3X50": 25, … }) into a compact label. */
function gradesToText(grades: unknown): string | null {
  if (grades == null) return null;
  if (typeof grades === "string") return grades || null;
  if (Array.isArray(grades)) {
    const parts = grades.map((g) => String(g)).filter(Boolean);
    return parts.length ? parts.join(", ") : null;
  }
  if (typeof grades === "object") {
    const parts = Object.entries(grades as Record<string, unknown>).map(
      ([k, v]) => (v == null || v === "" ? k : `${k}: ${v}`)
    );
    return parts.length ? parts.join(", ") : null;
  }
  return null;
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
  grades: "w-[120px]",
  shifts: "w-[62px]",
  projected: "w-[92px]",
  actual: "w-[86px]",
  variance: "w-[80px]",
  status: "w-[128px]",
  source: "w-[86px]",
  remarks: "w-[240px]",
} as const;

export default async function ProductionSchedulePage({
  searchParams,
}: {
  searchParams: Promise<{ month?: string }>;
}) {
  const { month: monthParam } = await searchParams;
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

  // Plan (production_schedule) + actual tons (view) for the month, joined by date.
  const [schedRes, actualRes] = await Promise.all([
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
  ]);

  const actualByDate = new Map<string, number>();
  for (const a of actualRes.data ?? []) {
    if (a.date != null && a.actual_tons != null) {
      actualByDate.set(a.date, Number(a.actual_tons));
    }
  }

  const rows: ScheduleRow[] = (schedRes.data ?? []).map((r) => {
    const shifts = Math.trunc(Number(r.shifts ?? 0));
    const projectedTons =
      r.projected_tons == null ? null : Number(r.projected_tons);
    const actualTons = actualByDate.has(r.plan_date)
      ? actualByDate.get(r.plan_date)!
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
      grades: gradesToText(r.grades),
      projectedTons,
      actualTons,
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
  const totalVariance = totalActual - totalProjected;

  const headCls =
    "frozen-row bg-muted px-2 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground";

  return (
    <div className="mx-auto flex w-full max-w-7xl flex-col gap-4 px-4 py-5 sm:px-6">
      {/* Month switcher (navbar owns the page title — this is a sub-band). */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Link
            href={`/production/schedule?month=${bounds.prev}`}
            className="inline-flex h-7 items-center gap-1 rounded-md border bg-card px-2 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            <ChevronLeft className="h-3.5 w-3.5" />
            Prev
          </Link>
          <span className="min-w-[120px] text-center text-sm font-semibold tabular-nums">
            {bounds.label}
          </span>
          <Link
            href={`/production/schedule?month=${bounds.next}`}
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
        <div className="animate-fade-up overflow-auto rounded-xl border bg-card/95 backdrop-blur supports-backdrop-filter:bg-card/70">
          <table className="w-full table-fixed border-collapse text-xs">
            <thead>
              <tr>
                <th className={cn(headCls, COL.date, "text-left")}>Date</th>
                <th className={cn(headCls, COL.day, "text-left")}>Day</th>
                <th className={cn(headCls, COL.setup, "text-left")}>Setup</th>
                <th className={cn(headCls, COL.grades, "text-left")}>Grades</th>
                <th className={cn(headCls, COL.shifts, "text-right")}>Shifts</th>
                <th className={cn(headCls, COL.projected, "text-right")}>
                  Proj t
                </th>
                <th className={cn(headCls, COL.actual, "text-right")}>Act t</th>
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
                    <td
                      className="max-w-[120px] truncate px-2 py-1 text-muted-foreground"
                      title={r.grades ?? undefined}
                    >
                      {r.grades ?? "—"}
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
      )}
    </div>
  );
}
