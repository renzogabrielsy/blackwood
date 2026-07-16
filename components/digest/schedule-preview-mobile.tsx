"use client";

// Phone-only condensed view of the rolling schedule preview. The dense 9-column
// table is unreadable at 375px, so on phones we show a compact stacked list of
// the nearest few days and a "tap to expand" button that opens the FULL table
// (reusing ScheduleTable) in a bottom sheet. Rendered `sm:hidden` by the parent;
// the desktop card keeps the full table inline (unchanged).
import * as React from "react";
import { Maximize2 } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
  SheetTrigger,
} from "@/components/ui/sheet";
import { STATE_CHIP, STATE_LABEL } from "./status-tokens";
import { parseGradeTons, fmtGradeTons, gradeTonsTitle } from "./format";
import { ScheduleTable, fmtTons } from "./schedule-table";
import type { SchedulePreviewRow } from "@/lib/digest/types";

/** How many days to surface in the condensed phone list before "expand". */
const PREVIEW_ROWS = 5;

export function SchedulePreviewMobile({ rows }: { rows: SchedulePreviewRow[] }) {
  const preview = rows.slice(0, PREVIEW_ROWS);
  const remaining = rows.length - preview.length;

  return (
    <div className="flex flex-col">
      <ul className="flex flex-col rounded-lg border">
        {preview.map((r) => {
          const rest = r.shifts === 0;
          const isToday = r.state === "today";
          const gradeTons = parseGradeTons(r.grades);
          return (
            <li
              key={r.date}
              className={cn(
                "flex items-start gap-2.5 border-t px-2.5 py-2 first:border-t-0",
                isToday && "bg-amber-500/[0.07]"
              )}
            >
              {/* date + weekday */}
              <div className="w-[46px] shrink-0">
                <div
                  className={cn(
                    "font-mono text-xs tabular-nums",
                    isToday && "font-semibold"
                  )}
                >
                  {r.date.slice(5)}
                </div>
                <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
                  {r.dow.slice(0, 3)}
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
                  {r.setup ?? "— off —"}
                </div>
                {gradeTons.length > 0 && (
                  <div
                    className="mt-0.5 truncate text-[10px] leading-tight text-muted-foreground"
                    title={gradeTonsTitle(gradeTons)}
                  >
                    {gradeTons.map((g, i) => (
                      <span key={g.grade}>
                        {i > 0 && " · "}
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
              </div>

              {/* tons + status */}
              <div className="flex shrink-0 flex-col items-end gap-1">
                <div className="font-mono text-xs tabular-nums">
                  {r.shifts > 0 ? (
                    <>
                      <span className="font-semibold text-violet-600 dark:text-violet-300">
                        {fmtTons(r.projectedTons)}t
                      </span>
                      {r.actualTons != null && (
                        <span className="text-muted-foreground">
                          {" "}
                          · {fmtTons(r.actualTons)}t
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
                    STATE_CHIP[r.state]
                  )}
                >
                  {r.state === "today" ? "Today" : STATE_LABEL[r.state]}
                </span>
              </div>
            </li>
          );
        })}
      </ul>

      <Sheet>
        <SheetTrigger asChild>
          <button
            type="button"
            className="mt-2 inline-flex h-9 items-center justify-center gap-1.5 rounded-lg border bg-muted/40 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <Maximize2 className="h-3.5 w-3.5" />
            {remaining > 0
              ? `View full table (+${remaining} more day${remaining === 1 ? "" : "s"})`
              : "View full table"}
          </button>
        </SheetTrigger>
        <SheetContent
          side="bottom"
          className="max-h-[88dvh] gap-0 rounded-t-2xl pb-[max(1rem,env(safe-area-inset-bottom))]"
        >
          <SheetHeader className="px-4 pt-4">
            <SheetTitle>Production schedule · next 10 days</SheetTitle>
            <SheetDescription>
              Swipe the table sideways to see all columns.
            </SheetDescription>
          </SheetHeader>
          <div className="min-h-0 flex-1 overflow-hidden px-3 pb-3 pt-1">
            <ScheduleTable
              rows={rows}
              maxHeightClass="max-h-[72dvh]"
              minWidthClass="min-w-[640px]"
            />
          </div>
        </SheetContent>
      </Sheet>
    </div>
  );
}
