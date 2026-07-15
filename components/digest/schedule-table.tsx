// Shared dense Excel-Standard Production Schedule table for the Home Digest.
// Client-safe (no 'use client', no server-only imports) so BOTH the server
// SchedulePreview card (desktop) AND the client SchedulePreviewMobile bottom
// sheet render the exact same table. Presentation-only — no aggregation.
import { cn } from "@/lib/utils";
import { STATE_CHIP, STATE_LABEL } from "./status-tokens";
import { parseGradeTons, fmtGradeTons, gradeTonsTitle } from "./format";
import type { SchedulePreviewRow } from "@/lib/digest/types";

// Column widths — Excel Standard: table-fixed, explicit px.
const COL = {
  date: "w-[104px]",
  day: "w-[56px]",
  setup: "w-auto",
  shifts: "w-[58px]",
  projected: "w-[68px]",
  actual: "w-[68px]",
  actualHrs: "w-[68px]",
  status: "w-[124px]",
  source: "w-[74px]",
} as const;

/** Compact tons — whole numbers bare, else one decimal; em-dash when null. */
function fmtTons(v: number | null): string {
  if (v == null) return "—";
  return Number.isInteger(v) ? String(v) : v.toFixed(1);
}

interface ScheduleTableProps {
  rows: SchedulePreviewRow[];
  /** scroll cap for the wrapper (e.g. "max-h-[340px]"); omit for no cap (sheet). */
  maxHeightClass?: string;
  /** min table width so columns keep their pixel widths and the wrapper scrolls
   *  horizontally on narrow screens instead of crushing the cells. */
  minWidthClass?: string;
}

/**
 * The dense schedule table body. On its own it does not draw the card chrome or
 * the "View full schedule →" header — the host (SchedulePreview card or the
 * mobile bottom sheet) owns that. The wrapper is `overflow-auto` so a table
 * wider than the viewport scrolls inside its own box (never the page).
 */
export function ScheduleTable({
  rows,
  maxHeightClass = "max-h-[340px]",
  minWidthClass,
}: ScheduleTableProps) {
  const headCls =
    "frozen-row bg-muted px-2 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground";

  return (
    <div className={cn("overflow-auto rounded-lg border", maxHeightClass)}>
      <table
        className={cn("w-full table-fixed border-collapse text-xs", minWidthClass)}
      >
        <thead>
          <tr>
            <th className={cn(headCls, COL.date, "text-left")}>Date</th>
            <th className={cn(headCls, COL.day, "text-left")}>Day</th>
            <th className={cn(headCls, COL.setup, "text-left")}>Setup / grades</th>
            <th className={cn(headCls, COL.shifts, "text-right")}>Sh</th>
            <th className={cn(headCls, COL.projected, "text-right")}>Total t</th>
            <th className={cn(headCls, COL.actual, "text-right")}>Act t</th>
            <th className={cn(headCls, COL.actualHrs, "text-right")}>Act hrs</th>
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
                        <span key={g.grade} className="shrink-0 whitespace-nowrap">
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
                <td
                  className={cn(
                    "px-2 py-1 text-right font-mono tabular-nums",
                    r.actualHrs == null && "text-muted-foreground"
                  )}
                >
                  {fmtTons(r.actualHrs)}
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
  );
}

export { fmtTons };
