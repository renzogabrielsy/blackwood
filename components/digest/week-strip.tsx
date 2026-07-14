import { cn } from "@/lib/utils";
import { STATE_CHIP, STATE_LABEL } from "./status-tokens";
import type { WeekDayPlan } from "@/lib/digest/types";

interface WeekStripProps {
  /** the 7 days of the operational date's week (plan joined with actual tons) */
  week: WeekDayPlan[];
}

/** A static horizontal bar (width is data-driven; never animated — layout-safe). */
function Bar({
  fraction,
  tone,
}: {
  fraction: number;
  tone: "plan" | "actual";
}) {
  const pct = Math.max(4, Math.min(100, fraction * 100));
  return (
    <span className="relative block h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
      <span
        className={cn(
          "absolute inset-y-0 left-0 rounded-full",
          tone === "plan" ? "bg-violet-500/40" : "bg-[var(--chart-1)]"
        )}
        style={{ width: `${pct}%` }}
      />
    </span>
  );
}

/**
 * This-week plan-vs-actual strip: one card per day of the operational date's
 * week. Rest days render dashed and calm; today gets a ring; each working day
 * shows a violet planned bar over a chart-1 actual bar plus a state chip
 * (Reported / Awaiting / Planned / Today). Presentation-only — `state` and the
 * tons come pre-resolved from `getDigestData()`.
 */
export function WeekStrip({ week }: WeekStripProps) {
  // scale bars against the largest planned figure in the window
  const maxTons = Math.max(1, ...week.map((w) => w.projectedTons ?? 0));

  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-7">
      {week.map((day) => {
        const rest = day.shifts === 0;
        const projected = day.projectedTons ?? 0;
        const reported = day.actualTons != null && day.actualTons > 0;
        const chipState = reported
          ? "reported"
          : day.isToday
            ? "today"
            : "planned";
        return (
          <div
            key={day.date}
            className={cn(
              "flex flex-col gap-2 rounded-xl border bg-card p-2.5",
              rest && "border-dashed bg-muted/30",
              day.isToday && "ring-1 ring-[var(--chart-2)]"
            )}
          >
            <div className="flex items-baseline justify-between">
              <span className="text-[10.5px] font-bold uppercase tracking-wide text-muted-foreground">
                {day.dow.slice(0, 3)}
              </span>
              <span className="font-mono text-xs text-muted-foreground">
                {day.date.slice(8)}
              </span>
            </div>

            <div
              className={cn(
                "min-h-[15px] text-[11.5px] font-semibold",
                rest ? "italic text-muted-foreground/70" : "text-foreground"
              )}
            >
              {day.setup ?? "— off —"}
            </div>

            {rest ? (
              <div className="mt-0.5 text-[10.5px] italic text-muted-foreground/70">
                planned rest
              </div>
            ) : (
              <div className="flex flex-col gap-1.5">
                <div className="flex items-center gap-1.5">
                  <Bar fraction={projected / maxTons} tone="plan" />
                  <span className="w-8 text-right font-mono text-[9.5px] text-violet-600 dark:text-violet-300">
                    {projected}t
                  </span>
                </div>
                <div className="flex items-center gap-1.5">
                  <Bar
                    fraction={day.actualTons != null ? day.actualTons / maxTons : 0}
                    tone="actual"
                  />
                  <span className="w-8 text-right font-mono text-[9.5px] text-muted-foreground">
                    {day.actualTons != null ? `${day.actualTons.toFixed(1)}t` : "—"}
                  </span>
                </div>
              </div>
            )}

            {!rest && (
              <span
                className={cn(
                  "w-fit rounded-md px-1.5 py-0.5 text-[10px] font-semibold",
                  STATE_CHIP[chipState]
                )}
              >
                {chipState === "today" ? "Today" : STATE_LABEL[chipState]}
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}
