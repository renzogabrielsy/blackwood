import { cn } from "@/lib/utils";
import { STATE_CHIP, STATE_LABEL } from "./status-tokens";
import type { ProdSchedDay } from "@/lib/digest/prod-schedule-draft";

/** One day's plan-vs-actual cell for the week strip. */
export interface WeekDay {
  day: ProdSchedDay;
  /** actual production in tons, null when not yet reported */
  actualTons: number | null;
  isToday: boolean;
}

interface WeekStripProps {
  week: WeekDay[];
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

export function WeekStrip({ week }: WeekStripProps) {
  // scale bars against the largest planned figure in the window
  const maxTons = Math.max(1, ...week.map((w) => w.day.projectedTons));

  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-7">
      {week.map(({ day, actualTons, isToday }) => {
        const rest = day.shifts === 0;
        return (
          <div
            key={day.date}
            className={cn(
              "flex flex-col gap-2 rounded-xl border bg-card p-2.5",
              rest && "border-dashed bg-muted/30",
              isToday && "ring-1 ring-[var(--chart-2)]"
            )}
          >
            <div className="flex items-baseline justify-between">
              <span className="text-[10.5px] font-bold uppercase tracking-wide text-muted-foreground">
                {day.dow}
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
                  <Bar fraction={day.projectedTons / maxTons} tone="plan" />
                  <span className="w-8 text-right font-mono text-[9.5px] text-violet-600 dark:text-violet-300">
                    {day.projectedTons}t
                  </span>
                </div>
                <div className="flex items-center gap-1.5">
                  <Bar
                    fraction={actualTons != null ? actualTons / maxTons : 0}
                    tone="actual"
                  />
                  <span className="w-8 text-right font-mono text-[9.5px] text-muted-foreground">
                    {actualTons != null ? `${actualTons.toFixed(1)}t` : "—"}
                  </span>
                </div>
              </div>
            )}

            {isToday ? (
              <span
                className={cn(
                  "w-fit rounded-md px-1.5 py-0.5 text-[10px] font-semibold",
                  actualTons != null && actualTons > 0
                    ? STATE_CHIP.reported
                    : STATE_CHIP.today
                )}
              >
                {actualTons != null && actualTons > 0
                  ? STATE_LABEL.reported
                  : "Today"}
              </span>
            ) : !rest ? (
              <span
                className={cn(
                  "w-fit rounded-md px-1.5 py-0.5 text-[10px] font-semibold",
                  actualTons != null && actualTons > 0
                    ? STATE_CHIP.reported
                    : STATE_CHIP.planned
                )}
              >
                {actualTons != null && actualTons > 0
                  ? STATE_LABEL.reported
                  : STATE_LABEL.planned}
              </span>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
