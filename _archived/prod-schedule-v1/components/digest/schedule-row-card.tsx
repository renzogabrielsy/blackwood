"use client";

// ─────────────────────────────────────────────────────────────────────────────
// ScheduleRowCard — the shared, phone-friendly schedule row.
//
// Extracted verbatim from the digest's SchedulePreviewMobile `<li>` so BOTH the
// Home Digest preview list AND the full-month `/production/schedule` mobile list
// render one identical row shape (single source of truth for the phone layout).
//
// The digest omits Act hrs / Var; the production schedule page passes them, so
// they render as an extra line ONLY when the caller supplies them (`actualHrs`
// / `variance` !== undefined). No ₱ anywhere → no price gating.
// ─────────────────────────────────────────────────────────────────────────────

import * as React from "react";
import { cn } from "@/lib/utils";
import { STATE_CHIP, STATE_LABEL, type StatusKey } from "./status-tokens";
import { fmtGradeTons, gradeTonsTitle, type GradeTon } from "./format";
import { fmtTons } from "./schedule-table";
import type { ScheduleRowState } from "@/lib/digest/day-status";

/** Signed variance, one decimal, with a leading + on gains. */
function fmtVariance(v: number): string {
  const sign = v > 0 ? "+" : "";
  return `${sign}${v.toFixed(1)}`;
}

/** Normalized, presentation-ready shape both callers map their rows into. */
export interface ScheduleRowCardData {
  /** yyyy-MM-dd */
  date: string;
  /** weekday name, e.g. "Tuesday" */
  dow: string;
  shifts: number;
  setup: string | null;
  /** per-grade projected tonnage (heaviest first); empty on a rest day. */
  gradeTons: GradeTon[];
  projectedTons: number | null;
  actualTons: number | null;
  /** The chip/label state (already resolved by the caller). */
  state: ScheduleRowState;
  /** Drives the amber "today" row tint. */
  isToday: boolean;
  /** Actual worked hours — production page only; omit on the digest preview. */
  actualHrs?: number | null;
  /** Actual − projected tons — production page only; omit on the digest preview. */
  variance?: number | null;
}

export function ScheduleRowCard({ row }: { row: ScheduleRowCardData }) {
  const rest = row.shifts === 0;
  const chipState: StatusKey = row.state;
  const showExtended =
    row.actualHrs !== undefined || row.variance !== undefined;

  return (
    <li
      className={cn(
        "flex items-start gap-2.5 border-t px-2.5 py-2 first:border-t-0",
        row.isToday && "bg-amber-500/[0.07]"
      )}
    >
      {/* date + weekday */}
      <div className="w-[46px] shrink-0">
        <div
          className={cn(
            "font-mono text-xs tabular-nums",
            row.isToday && "font-semibold"
          )}
        >
          {row.date.slice(5)}
        </div>
        <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
          {row.dow.slice(0, 3)}
        </div>
      </div>

      {/* setup + grades */}
      <div className="min-w-0 flex-1">
        <div
          className={cn(
            "truncate text-xs font-medium",
            rest && "italic text-muted-foreground/70"
          )}
        >
          {row.setup ?? "— off —"}
        </div>
        {row.gradeTons.length > 0 && (
          <div
            className="mt-0.5 truncate text-[10px] leading-tight text-muted-foreground"
            title={gradeTonsTitle(row.gradeTons)}
          >
            {row.gradeTons.map((g, i) => (
              <span key={g.grade}>
                {i > 0 && " · "}
                <span className="font-medium text-foreground/70">{g.grade}</span>{" "}
                <span className="font-mono tabular-nums">
                  {fmtGradeTons(g.tons)}t
                </span>
              </span>
            ))}
          </div>
        )}
        {/* Extended (production page): actual hours worked. */}
        {showExtended && (
          <div className="mt-0.5 flex items-center gap-2 text-[10px] leading-tight text-muted-foreground">
            <span>
              Hrs{" "}
              <span
                className={cn(
                  "font-mono tabular-nums",
                  row.actualHrs == null && "text-muted-foreground/60"
                )}
              >
                {fmtTons(row.actualHrs ?? null)}
              </span>
            </span>
            {row.variance != null && (
              <span>
                Var{" "}
                <span
                  className={cn(
                    "font-mono tabular-nums",
                    row.variance > 0
                      ? "text-emerald-600 dark:text-emerald-400"
                      : row.variance < 0
                        ? "text-red-600 dark:text-red-400"
                        : "text-muted-foreground"
                  )}
                >
                  {fmtVariance(row.variance)}
                </span>
              </span>
            )}
          </div>
        )}
      </div>

      {/* tons + status */}
      <div className="flex shrink-0 flex-col items-end gap-1">
        <div className="font-mono text-xs tabular-nums">
          {row.shifts > 0 ? (
            <>
              <span className="font-semibold text-violet-600 dark:text-violet-300">
                {fmtTons(row.projectedTons)}t
              </span>
              {row.actualTons != null && (
                <span className="text-muted-foreground">
                  {" "}
                  · {fmtTons(row.actualTons)}t
                </span>
              )}
            </>
          ) : (
            <span className="text-muted-foreground">—</span>
          )}
        </div>
        <span
          className={cn(
            "rounded px-1.5 py-0.5 text-[9.5px] font-semibold",
            STATE_CHIP[chipState]
          )}
        >
          {chipState === "today" ? "Today" : STATE_LABEL[chipState]}
        </span>
      </div>
    </li>
  );
}
