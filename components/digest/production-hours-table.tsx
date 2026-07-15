// Server component — the Home Digest's Work & downtime hours table band.
// Presentation-only: renders the pre-aggregated `productionHours` slice from
// getDigestData() (view_digest_daily_hours, windowed to the last GRADE_DAYS) as
// a dense Excel-Standard table that sits BESIDE the Production-by-grade chart.
// No aggregation of source rows (that lives in SQL) — the totals footer is a
// simple presentational SUM of already-correct per-day hours, mirroring the
// month-total footers on /production/schedule. No ₱ data → no price gating.
import { cn } from "@/lib/utils";
import type { DailyHoursPoint } from "@/lib/digest/types";

interface ProductionHoursTableProps {
  /** last GRADE_DAYS (14) production days, ascending by date — same window as
   *  the Production-by-grade chart it pairs beside. */
  rows: DailyHoursPoint[];
}

/** Short MM-DD label from a yyyy-MM-dd date (matches the chart X axis). */
function shortDate(d: string): string {
  return d.length >= 10 ? d.slice(5) : d;
}

/** Compact hours — whole numbers bare, else one decimal. */
function fmtHrs(v: number): string {
  return Number.isInteger(v) ? String(v) : v.toFixed(1);
}

// Column widths — Excel Standard: table-fixed, explicit px.
const COL = {
  date: "w-[72px]",
  work: "w-auto",
  downtime: "w-auto",
} as const;

/**
 * Compact Work & downtime hours table for the Home Digest — one row per
 * production day over the last 14 days (ascending, so it reads left→right in
 * the same day order as the Production-by-grade bar chart it pairs beside), with
 * a totals footer summing work + downtime hours across the window. Dense,
 * Excel-Standard: `text-xs`, `font-mono` right-aligned numerics, capped height
 * with a sticky `.frozen-row` header + sticky `.frozen-row-bottom` totals
 * footer. Renders `null` when there is nothing to show.
 */
export function ProductionHoursTable({ rows }: ProductionHoursTableProps) {
  if (!rows.length) return null;

  // Presentational SUM of already-correct per-day hours (a display footer, not a
  // business aggregation — the per-day figures are SUMmed in the SQL view).
  const totalWork = rows.reduce((s, r) => s + r.workHrs, 0);
  const totalDowntime = rows.reduce((s, r) => s + r.downtimeHrs, 0);

  const headCls =
    "frozen-row bg-muted px-2 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground";

  return (
    <div className="hover-lift flex flex-col rounded-xl border bg-card/95 p-4 backdrop-blur supports-backdrop-filter:bg-card/70">
      <div className="mb-3 flex items-baseline justify-between gap-2">
        <h3 className="text-sm font-semibold tracking-tight">
          Work &amp; downtime hours
        </h3>
        <span className="text-[11px] text-muted-foreground">
          last 14 days · hrs
        </span>
      </div>

      <div className="max-h-[220px] overflow-y-auto rounded-lg border">
        <table className="w-full table-fixed border-collapse text-xs">
          <thead>
            <tr>
              <th className={cn(headCls, COL.date, "text-left")}>Date</th>
              <th className={cn(headCls, COL.work, "text-right")}>Work hrs</th>
              <th className={cn(headCls, COL.downtime, "text-right")}>
                Downtime hrs
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr
                key={r.date}
                className="border-t transition-colors hover:bg-muted/40"
              >
                <td className="px-2 py-1 font-mono tabular-nums">
                  {shortDate(r.date)}
                </td>
                <td className="px-2 py-1 text-right font-mono tabular-nums">
                  {fmtHrs(r.workHrs)}
                </td>
                <td
                  className={cn(
                    "px-2 py-1 text-right font-mono tabular-nums",
                    r.downtimeHrs > 0
                      ? "text-amber-600 dark:text-amber-400"
                      : "text-muted-foreground"
                  )}
                >
                  {r.downtimeHrs > 0 ? fmtHrs(r.downtimeHrs) : "—"}
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="frozen-row-bottom frozen-edge-top h-8 bg-muted font-semibold">
              <td className="px-2 py-1 text-[11px] uppercase tracking-wide text-muted-foreground">
                TTL
              </td>
              <td className="px-2 py-1 text-right font-mono tabular-nums">
                {fmtHrs(totalWork)}
              </td>
              <td
                className={cn(
                  "px-2 py-1 text-right font-mono tabular-nums",
                  totalDowntime > 0
                    ? "text-amber-600 dark:text-amber-400"
                    : "text-muted-foreground"
                )}
              >
                {fmtHrs(totalDowntime)}
              </td>
            </tr>
          </tfoot>
        </table>
      </div>
    </div>
  );
}
