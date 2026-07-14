import { cn } from "@/lib/utils";
import { STATE_CHIP, STATE_LABEL } from "./status-tokens";
import type { ScheduleRowState } from "@/lib/digest/day-status";
import type {
  ProdSchedDay,
  OrderCommitment,
  SetupGrade,
} from "@/lib/digest/prod-schedule-draft";

/** One month row: plan + actual + resolved row state. */
export interface ScheduleRow {
  day: ProdSchedDay;
  actualTons: number | null;
  state: ScheduleRowState;
}

interface ScheduleTableProps {
  rows: ScheduleRow[];
  orders: OrderCommitment[];
  setupReference: Record<string, SetupGrade[]>;
  operationalDate: string | null;
}

/** Fixed accent colors for the order customer badges. */
const CUSTOMER_COLOR: Record<string, string> = {
  KC: "bg-teal-600",
  MH: "bg-violet-600",
  FG: "bg-amber-600",
};

function StateChip({ state }: { state: ScheduleRowState }) {
  const key = state === "today" ? "today" : state;
  const label = state === "planned" ? "Planned" : STATE_LABEL[key];
  return (
    <span
      className={cn(
        "inline-block rounded-md px-1.5 py-0.5 text-[10px] font-semibold",
        STATE_CHIP[key]
      )}
    >
      {label}
    </span>
  );
}

export function ScheduleTable({
  rows,
  orders,
  setupReference,
  operationalDate,
}: ScheduleTableProps) {
  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-[1fr_300px]">
      {/* ---- month plan-vs-actual table (Excel Standard density) ---- */}
      <div className="overflow-hidden rounded-xl border bg-card">
        <div className="max-h-[520px] overflow-auto">
          <table className="w-full table-fixed border-collapse text-xs">
            <colgroup>
              <col className="w-[92px]" />
              <col className="w-[52px]" />
              <col className="w-[130px]" />
              <col className="w-[60px]" />
              <col className="w-[78px]" />
              <col className="w-[72px]" />
              <col className="w-[64px]" />
              <col className="w-[110px]" />
            </colgroup>
            <thead>
              <tr className="sticky top-0 z-10 bg-muted text-[10.5px] uppercase tracking-wide text-muted-foreground">
                <th className="px-2 py-1.5 text-left font-semibold">Date</th>
                <th className="px-2 py-1.5 text-left font-semibold">Day</th>
                <th className="px-2 py-1.5 text-left font-semibold">Setup / plan</th>
                <th className="px-2 py-1.5 text-right font-semibold">Shifts</th>
                <th className="px-2 py-1.5 text-right font-semibold">Proj t</th>
                <th className="px-2 py-1.5 text-right font-semibold">Actual t</th>
                <th className="px-2 py-1.5 text-right font-semibold">Var</th>
                <th className="px-2 py-1.5 text-left font-semibold">Status</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(({ day, actualTons, state }) => {
                const rest = day.shifts === 0;
                const isToday = operationalDate === day.date;
                const variance =
                  actualTons != null ? actualTons - day.projectedTons : null;
                const varTone =
                  variance == null
                    ? "text-muted-foreground"
                    : variance >= 0
                      ? "text-emerald-600 dark:text-emerald-400"
                      : "text-red-600 dark:text-red-400";
                return (
                  <tr
                    key={day.date}
                    className={cn(
                      "h-8 border-b border-border transition-colors last:border-0 hover:bg-muted/50",
                      rest && "bg-muted/40 text-muted-foreground",
                      isToday && "bg-[var(--chart-2)]/10"
                    )}
                  >
                    <td className="px-2 py-1 font-mono tabular-nums">
                      {isToday && (
                        <span
                          className="mr-1 inline-block h-2 w-0.5 -translate-y-px rounded-full bg-[var(--chart-2)] align-middle"
                          aria-hidden
                        />
                      )}
                      {day.date}
                    </td>
                    <td className="px-2 py-1">{day.dow}</td>
                    <td
                      className={cn(
                        "truncate px-2 py-1",
                        rest ? "italic" : "font-medium text-foreground"
                      )}
                      title={day.remarks ?? day.setup ?? undefined}
                    >
                      {day.setup ?? "— off —"}
                    </td>
                    <td className="px-2 py-1 text-right font-mono tabular-nums">
                      {day.shifts || "—"}
                    </td>
                    <td className="px-2 py-1 text-right font-mono tabular-nums text-violet-600 dark:text-violet-300">
                      {day.projectedTons || "—"}
                    </td>
                    <td className="px-2 py-1 text-right font-mono tabular-nums">
                      {actualTons != null ? (
                        actualTons.toFixed(1)
                      ) : (
                        <span className="text-muted-foreground/60">—</span>
                      )}
                    </td>
                    <td
                      className={cn(
                        "px-2 py-1 text-right font-mono font-semibold tabular-nums",
                        varTone
                      )}
                    >
                      {variance == null
                        ? "—"
                        : `${variance >= 0 ? "+" : ""}${variance.toFixed(1)}`}
                    </td>
                    <td className="px-2 py-1">
                      <StateChip state={state} />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* ---- rails: orders + setup reference ---- */}
      <div className="flex flex-col gap-4">
        <div className="overflow-hidden rounded-xl border bg-card">
          <div className="border-b border-border bg-muted px-3 py-2">
            <h3 className="text-[11px] font-bold uppercase tracking-wide text-foreground/80">
              Order commitments
            </h3>
            <p className="mt-0.5 text-[11px] text-muted-foreground">
              open vans from the ORDERS tab
            </p>
          </div>
          <div className="flex flex-col p-1.5">
            {orders.map((o, i) => (
              <div
                key={`${o.customer}-${o.etd}-${i}`}
                className="flex items-center gap-2.5 rounded-lg px-2 py-2 transition-colors hover:bg-muted/50"
              >
                <span
                  className={cn(
                    "grid h-8 w-8 flex-none place-items-center rounded-lg font-mono text-xs font-bold text-white",
                    CUSTOMER_COLOR[o.customer] ?? "bg-muted-foreground"
                  )}
                >
                  {o.customer}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline gap-1.5 text-xs font-semibold">
                    <span className="truncate">{o.volume}</span>
                    <span className="font-mono text-[10.5px] text-[var(--chart-2)]">
                      {o.setup}
                    </span>
                  </div>
                  <div className="truncate text-[11px] text-muted-foreground">
                    {o.note}
                  </div>
                </div>
                <div className="flex-none text-right">
                  <div className="text-[9.5px] font-semibold uppercase tracking-wide text-muted-foreground/70">
                    ETD
                  </div>
                  <div className="font-mono text-xs font-semibold">{o.etd}</div>
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="overflow-hidden rounded-xl border bg-card">
          <div className="border-b border-border bg-muted px-3 py-2">
            <h3 className="text-[11px] font-bold uppercase tracking-wide text-foreground/80">
              Setup reference
            </h3>
            <p className="mt-0.5 text-[11px] text-muted-foreground">
              tons/day by grade for each line setup
            </p>
          </div>
          <div className="px-2 py-1">
            {Object.entries(setupReference).map(([setup, grades]) => (
              <div
                key={setup}
                className="flex items-center justify-between gap-2 border-b border-border py-2 text-xs last:border-0"
              >
                <span className="font-semibold">{setup}</span>
                <span className="flex flex-wrap justify-end gap-1">
                  {grades.map((g) => (
                    <span
                      key={g.grade}
                      className="rounded border border-border bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground"
                    >
                      {g.grade} <b className="text-foreground/80">{g.tonsPerDay}t</b>
                    </span>
                  ))}
                </span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
