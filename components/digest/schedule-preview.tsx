// Server component — the Home Digest's compact Production Schedule table band.
// Presentation-only: renders the pre-resolved `schedulePreview` slice from
// getDigestData() as a dense Excel-Standard table (a rolling ~2-week window),
// complementing the full page at /production/schedule and the WeekStrip cards.
// No aggregation, no ₱ data → no price gating.
import Link from "next/link";
import { cn } from "@/lib/utils";
import { STATE_CHIP, STATE_LABEL } from "./status-tokens";
import { parseGradeTons, fmtGradeTons, gradeTonsTitle } from "./format";
import type { SchedulePreviewRow } from "@/lib/digest/types";

interface SchedulePreviewProps {
  /** the operational date through the next 9 days (10 rows), plan + actual */
  rows: SchedulePreviewRow[];
}

// Column widths — Excel Standard: table-fixed, explicit px.
const COL = {
  date: "w-[104px]",
  day: "w-[56px]",
  setup: "w-auto",
  shifts: "w-[58px]",
  projected: "w-[68px]",
  actual: "w-[68px]",
  status: "w-[124px]",
  source: "w-[74px]",
} as const;

/** Compact tons — whole numbers bare, else one decimal; em-dash when null. */
function fmtTons(v: number | null): string {
  if (v == null) return "—";
  return Number.isInteger(v) ? String(v) : v.toFixed(1);
}

/**
 * Compact production-schedule table for the Home Digest — a rolling 10-day
 * window (today first), sized as a HALF-WIDTH scroll card (capped height +
 * sticky header) rather than a tall full-width slab. Dense, Excel-Standard:
 * today's row is accent-tinted, rest days render dashed/muted, each working row
 * carries a Status chip (STATE_CHIP/STATE_LABEL) and a Source chip (violet
 * Joseph when the DB source starts with `joseph:`, else muted Sheet — matching
 * /production/schedule). The Setup cell stacks a muted per-grade tonnage
 * breakdown (`3X50 21t · 4X8 5t`) beneath the setup name; the Proj t column is
 * the day TOTAL. Renders `null` when there is nothing to show.
 */
export function SchedulePreview({ rows }: SchedulePreviewProps) {
  if (!rows.length) return null;

  const headCls =
    "frozen-row bg-muted px-2 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground";

  return (
    <div className="hover-lift flex flex-col rounded-xl border bg-card/95 p-4 backdrop-blur supports-backdrop-filter:bg-card/70">
      <div className="mb-3 flex items-baseline justify-between gap-2">
        <div className="flex items-baseline gap-2">
          <h3 className="text-sm font-semibold tracking-tight">
            Production schedule
          </h3>
          <span className="text-[11px] text-muted-foreground">next 10 days</span>
        </div>
        <Link
          href="/production/schedule"
          className="text-[11px] font-medium text-primary hover:underline"
        >
          View full schedule →
        </Link>
      </div>

      <div className="max-h-[340px] overflow-auto rounded-lg border">
        <table className="w-full table-fixed border-collapse text-xs">
          <thead>
            <tr>
              <th className={cn(headCls, COL.date, "text-left")}>Date</th>
              <th className={cn(headCls, COL.day, "text-left")}>Day</th>
              <th className={cn(headCls, COL.setup, "text-left")}>
                Setup / grades
              </th>
              <th className={cn(headCls, COL.shifts, "text-right")}>Sh</th>
              <th className={cn(headCls, COL.projected, "text-right")}>Total t</th>
              <th className={cn(headCls, COL.actual, "text-right")}>Act t</th>
              <th className={cn(headCls, COL.status, "text-left")}>Status</th>
              <th className={cn(headCls, COL.source, "text-left")}>Src</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const rest = r.shifts === 0;
              const isToday = r.state === "today";
              const isJoseph = (r.source ?? "").startsWith("joseph:");
              const gradeTons = parseGradeTons(r.grades);
              return (
                <tr
                  key={r.date}
                  className={cn(
                    "border-t align-top transition-colors hover:bg-muted/40",
                    rest && "bg-muted/20 text-muted-foreground",
                    isToday && "bg-amber-500/[0.07]"
                  )}
                >
                  <td
                    className={cn(
                      "px-2 py-1 font-mono tabular-nums",
                      isToday && "font-semibold text-foreground"
                    )}
                  >
                    {r.date}
                  </td>
                  <td className="px-2 py-1">{r.dow.slice(0, 3)}</td>
                  <td className="px-2 py-1">
                    <div
                      className={cn(
                        "truncate",
                        rest && "italic text-muted-foreground/70"
                      )}
                      title={r.setup ?? undefined}
                    >
                      {r.setup ?? "— off —"}
                    </div>
                    {gradeTons.length > 0 && (
                      <div
                        className="mt-0.5 flex items-center gap-1.5 overflow-hidden text-[10px] leading-tight text-muted-foreground"
                        title={gradeTonsTitle(gradeTons)}
                      >
                        {gradeTons.map((g) => (
                          <span
                            key={g.grade}
                            className="shrink-0 whitespace-nowrap"
                          >
                            <span className="font-medium text-foreground/70">
                              {g.grade}
                            </span>{" "}
                            <span className="font-mono tabular-nums">
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
                  <td className="px-2 py-1 text-right font-mono font-semibold tabular-nums text-violet-600 dark:text-violet-300">
                    {r.projectedTons ? fmtTons(r.projectedTons) : "—"}
                  </td>
                  <td className="px-2 py-1 text-right font-mono tabular-nums">
                    {fmtTons(r.actualTons)}
                  </td>
                  <td className="px-2 py-1">
                    <span
                      className={cn(
                        "inline-block rounded-md px-1.5 py-0.5 text-[10px] font-semibold",
                        STATE_CHIP[r.state]
                      )}
                    >
                      {r.state === "today" ? "Today" : STATE_LABEL[r.state]}
                    </span>
                  </td>
                  <td className="px-2 py-1">
                    <span
                      className={cn(
                        "inline-block rounded px-1.5 py-0.5 text-[10px] font-medium",
                        isJoseph
                          ? "bg-violet-500/12 text-violet-700 dark:text-violet-300"
                          : "bg-muted text-muted-foreground"
                      )}
                    >
                      {isJoseph ? "Joseph" : "Sheet"}
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
