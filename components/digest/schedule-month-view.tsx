// Async Server Component — the Production Schedule MONTH view (plan vs actual),
// now the EDITING surface for the plan (Phase B of the master plotter).
//
// It lives in the DIGEST world: rendered by `/` under `?view=schedule` (see
// app/(app)/page.tsx + components/digest/home-view-toggle.tsx). The route
// `/production/schedule` redirects here, so the production tab shell (Daily ·
// Electricity · Trucks) no longer wraps it.
//
// Domain layer (charcoal-shaped): queries `view_production_schedule_state` (the
// ownership-aware read model), `view_production_schedule_conflicts` (parked
// upstream proposals), plus `view_digest_prod_actual_tons` /
// `view_digest_daily_hours` DIRECTLY — this is the tenant CRUD layer, NOT the
// digest adapter. No ₱ anywhere — tons only — so no price gating needed.
//
// SERVER fetches, CLIENT edits: this component shapes rows and hands them to
// `<ScheduleMonthGrid />` ('use client'), which owns all interaction and calls
// the server actions in `app/(app)/production/schedule/actions.ts`. The client
// never touches Supabase.
//
// The component renders NO outer page container (no `mx-auto max-w-7xl`): the
// host page owns the shell. Month nav hrefs are built from `basePath` +
// `extraParams`, so the host decides which sibling params survive.
import Link from "next/link";
import { ChevronLeft, ChevronRight, TriangleAlert } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { cn } from "@/lib/utils";
import { resolveScheduleRowState } from "@/lib/digest/day-status";
import { parseGradeTons } from "@/components/digest/format";
import {
  ScheduleCardsMobile,
  type ScheduleMobileRow,
} from "@/components/digest/schedule-cards-mobile";
import { ScheduleMonthGrid } from "@/components/digest/schedule-month-grid";
import { toScheduleOwner } from "@/components/digest/schedule-owner";
import type {
  ScheduleConflict,
  ScheduleConflictSide,
  ScheduleGridRow,
} from "@/components/digest/schedule-types";

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
// JSONB narrowing (the two conflict sides + changed_fields)
// ---------------------------------------------------------------------

type Jsonish = unknown;

function asObject(v: Jsonish): Record<string, Jsonish> | null {
  return v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, Jsonish>)
    : null;
}

function asNumber(v: Jsonish): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function asString(v: Jsonish): string | null {
  return typeof v === "string" && v.trim() !== "" ? v : null;
}

/** `{ "3X50": 21, "4X8": 5 }` → the same, numbers coerced; null when empty. */
function asGrades(v: Jsonish): Record<string, number> | null {
  const obj = asObject(v);
  if (!obj) return null;
  const out: Record<string, number> = {};
  for (const [k, raw] of Object.entries(obj)) {
    const n = asNumber(raw);
    if (n != null) out[k] = n;
  }
  return Object.keys(out).length > 0 ? out : null;
}

function asSide(v: Jsonish): ScheduleConflictSide | null {
  const obj = asObject(v);
  if (!obj) return null;
  return {
    shifts: asNumber(obj.shifts),
    setup: asString(obj.setup),
    projected_tons: asNumber(obj.projected_tons),
    grades: asGrades(obj.grades),
    remarks: asString(obj.remarks),
    source: asString(obj.source),
  };
}

function asChangedFields(v: Jsonish): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

// ---------------------------------------------------------------------
// Display helpers
// ---------------------------------------------------------------------

/** Compact tons — whole numbers bare, else one decimal. */
function fmtTons(v: number | null): string {
  if (v == null) return "—";
  return Number.isInteger(v) ? String(v) : v.toFixed(1);
}

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

  // Plan STATE (ownership-aware read model) + parked conflicts + actual tons +
  // actual worked hours for the month, all joined by date.
  const [schedRes, conflictRes, actualRes, hoursRes] = await Promise.all([
    supabase
      .from("view_production_schedule_state")
      .select(
        "plan_date, dow, shifts, setup, projected_tons, grades, remarks, source, owner, effective_owner, is_reported, row_version, human_edited_at"
      )
      .gte("plan_date", bounds.start)
      .lte("plan_date", bounds.end)
      .order("plan_date", { ascending: true }),
    supabase
      .from("view_production_schedule_conflicts")
      .select(
        "plan_date, proposed, current_values, changed_fields, pending_source_rev, observed_at"
      )
      .gte("plan_date", bounds.start)
      .lte("plan_date", bounds.end),
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

  const conflictByDate = new Map<string, ScheduleConflict>();
  for (const c of conflictRes.data ?? []) {
    if (c.plan_date == null) continue;
    conflictByDate.set(c.plan_date, {
      changedFields: asChangedFields(c.changed_fields),
      proposed: asSide(c.proposed),
      current: asSide(c.current_values),
      pendingSourceRev: c.pending_source_rev ?? null,
      observedAt: c.observed_at ?? null,
    });
  }

  const rows: ScheduleGridRow[] = (schedRes.data ?? [])
    .filter((r): r is typeof r & { plan_date: string } => r.plan_date != null)
    .map((r) => {
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
        {
          date: r.plan_date,
          dow: r.dow ?? "",
          shifts: shifts as 0 | 1 | 2,
          setup: r.setup,
          projectedTons: projectedTons ?? 0,
        },
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
        state,
        isToday: r.plan_date === operationalDate,
        isRest,
        owner: toScheduleOwner(r.owner),
        effectiveOwner: toScheduleOwner(r.effective_owner),
        isReported: r.is_reported === true,
        // row_version is NOT NULL on the table; the view types it nullable.
        rowVersion: r.row_version ?? 1,
        humanEditedAt: r.human_edited_at ?? null,
        conflict: conflictByDate.get(r.plan_date) ?? null,
      } satisfies ScheduleGridRow;
    });

  // Month totals (presentational sum of already-correct per-day tons — this is a
  // simple display footer, not a business aggregation; the actual tons are
  // SUMmed in the SQL view, projected is the plan figure straight from the row).
  const totalProjected = rows.reduce((s, r) => s + (r.projectedTons ?? 0), 0);
  const totalActual = rows.reduce((s, r) => s + (r.actualTons ?? 0), 0);
  const totalActualHrs = rows.reduce((s, r) => s + (r.actualHrs ?? 0), 0);
  const totalVariance = totalActual - totalProjected;

  const pendingCount = rows.filter((r) => r.conflict != null).length;

  // Phone read layer — same `rows` (single source of truth), reshaped to the
  // shared ScheduleRowCard contract. chipState mirrors the desktop table's
  // "today wins unless already reported" rule. Editing stays desktop-only.
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

  return (
    <div className="flex w-full min-w-0 flex-col gap-4">
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
        <div className="flex flex-wrap items-center gap-3 text-[11px] text-muted-foreground">
          {pendingCount > 0 && (
            <span
              className={cn(
                "inline-flex items-center gap-1 rounded-md bg-amber-500/12 px-1.5 py-0.5",
                "font-medium text-amber-700 dark:text-amber-300"
              )}
              title="Days where the sync withheld an upstream change because you own them. Open the amber marker on the row to arbitrate."
            >
              <TriangleAlert className="h-3 w-3" />
              {pendingCount} pending upstream change
              {pendingCount === 1 ? "" : "s"}
            </span>
          )}
          <span className="inline-flex items-center gap-1.5">
            <span className="inline-block h-2 w-2 rounded-sm bg-violet-500/60" />
            Joseph
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span className="inline-block h-2 w-2 rounded-sm bg-muted-foreground/40" />
            Sheet
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span className="inline-block h-2 w-2 rounded-sm bg-sky-500/60" />
            You
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span className="inline-block h-2 w-2 rounded-sm bg-emerald-500/60" />
            Actual (frozen)
          </span>
        </div>
      </div>

      {rows.length === 0 ? (
        <div className="flex h-40 items-center justify-center rounded-xl border bg-card/95 text-sm text-muted-foreground">
          No schedule on record for {bounds.label}.
        </div>
      ) : (
        <>
          {/* Phone — full-month condensed card list, READ-ONLY (the dense
              editable grid is desktop/tablet only, same posture as the other
              production surfaces). */}
          <div className="sm:hidden flex flex-col gap-2">
            <ScheduleCardsMobile rows={mobileRows} />
            <p className="text-[11px] text-muted-foreground">
              Editing the plan is available on a larger screen.
            </p>
          </div>

          {/* Tablet / desktop — the dense Excel-Standard editable grid. */}
          <div className="hidden min-w-0 sm:block">
            <ScheduleMonthGrid
              rows={rows}
              totals={{
                projected: totalProjected,
                actual: totalActual,
                actualHrs: totalActualHrs,
                variance: totalVariance,
              }}
            />
          </div>

          {/* Screen-reader / no-JS parity for the footer figures the grid draws. */}
          <p className="sr-only">
            Month total across {rows.length} days: projected{" "}
            {fmtTons(totalProjected)} tons, actual {fmtTons(totalActual)} tons.
          </p>
        </>
      )}
    </div>
  );
}
