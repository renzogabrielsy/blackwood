"use client";

// Phone-only condensed view of the rolling schedule preview. The dense 9-column
// table is unreadable at 375px, so on phones we show a compact stacked list of
// the nearest few days and a "tap to expand" button that opens the FULL table
// (reusing ScheduleTable) in a bottom sheet. Rendered `sm:hidden` by the parent;
// the desktop card keeps the full table inline (unchanged).
import * as React from "react";
import { Maximize2 } from "lucide-react";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
  SheetTrigger,
} from "@/components/ui/sheet";
import { parseGradeTons } from "./format";
import { ScheduleTable } from "./schedule-table";
import { ScheduleRowCard } from "./schedule-row-card";
import type { SchedulePreviewRow } from "@/lib/digest/types";

/** How many days to surface in the condensed phone list before "expand". */
const PREVIEW_ROWS = 5;

export function SchedulePreviewMobile({ rows }: { rows: SchedulePreviewRow[] }) {
  const preview = rows.slice(0, PREVIEW_ROWS);
  const remaining = rows.length - preview.length;

  return (
    <div className="flex flex-col">
      <ul className="flex flex-col rounded-lg border">
        {preview.map((r) => (
          <ScheduleRowCard
            key={r.date}
            row={{
              date: r.date,
              dow: r.dow,
              shifts: r.shifts,
              setup: r.setup,
              gradeTons: parseGradeTons(r.grades),
              projectedTons: r.projectedTons,
              actualTons: r.actualTons,
              state: r.state,
              isToday: r.state === "today",
            }}
          />
        ))}
      </ul>

      <Sheet>
        <SheetTrigger asChild>
          <button
            type="button"
            className="mt-2 inline-flex h-10 items-center justify-center gap-1.5 rounded-lg border bg-muted/40 px-3 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
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
