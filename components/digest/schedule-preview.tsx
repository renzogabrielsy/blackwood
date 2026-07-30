// Server component — the Home Digest's compact Production Schedule table band.
// Presentation-only: renders the pre-resolved `schedulePreview` slice from
// getDigestData() as a dense Excel-Standard table (a rolling ~2-week window),
// complementing the full month view at /?view=schedule and the WeekStrip cards.
// No aggregation, no ₱ data → no price gating.
//
// Responsive: tablet/desktop show the full dense table inline (unchanged). On
// phones the 9-column table is unreadable, so a condensed stacked list plus a
// "View full table" bottom sheet (SchedulePreviewMobile) takes over.
import Link from "next/link";
import { TriangleAlert } from "lucide-react";
import { ScheduleTable } from "./schedule-table";
import { SchedulePreviewMobile } from "./schedule-preview-mobile";
import type { SchedulePreviewRow } from "@/lib/digest/types";

interface SchedulePreviewProps {
  /** the operational date through the next 9 days (10 rows), plan + actual */
  rows: SchedulePreviewRow[];
  /** Days whose upstream (Joseph) change the sync withheld because a human owns
   *  them. Rendered as a quiet amber link to the schedule page; ZERO renders
   *  nothing at all. Surfaced here (not only on the schedule route) so a stale
   *  conflict cannot sit unread. */
  pendingConflicts?: number;
}

/**
 * Compact production-schedule band for the Home Digest — a rolling 10-day window
 * (today first), sized as a HALF-WIDTH scroll card. Today's row is accent-tinted,
 * rest days render dashed/muted, each working row carries a Status chip and a
 * Source chip (violet Joseph when the DB source starts with `joseph:`, else muted
 * Sheet). Renders `null` when there is nothing to show.
 */
export function SchedulePreview({
  rows,
  pendingConflicts = 0,
}: SchedulePreviewProps) {
  if (!rows.length && pendingConflicts === 0) return null;

  return (
    <div className="hover-lift flex min-w-0 flex-col rounded-xl border bg-card/95 p-4 backdrop-blur supports-backdrop-filter:bg-card/70">
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
        <div className="flex flex-wrap items-baseline gap-2">
          <h3 className="text-sm font-semibold tracking-tight">
            Production schedule
          </h3>
          <span className="text-[11px] text-muted-foreground">next 10 days</span>
          {pendingConflicts > 0 && (
            <Link
              href="/?view=schedule"
              title="The sync withheld an upstream change on these days because you own them. Open the schedule to arbitrate."
              className="inline-flex items-center gap-1 rounded-md bg-amber-500/12 px-1.5 py-0.5 text-[10px] font-semibold text-amber-700 transition-colors duration-150 hover:bg-amber-500/25 dark:text-amber-300"
            >
              <TriangleAlert className="h-3 w-3" />
              {pendingConflicts} pending upstream change
              {pendingConflicts === 1 ? "" : "s"}
            </Link>
          )}
        </div>
        <Link
          href="/?view=schedule"
          className="text-[11px] font-medium text-primary hover:underline"
        >
          View full schedule →
        </Link>
      </div>

      {/* The band can also render for a pending-conflict count alone (no rolling
          window on record) — in that case the tables are simply omitted. */}
      {rows.length > 0 && (
        <>
          {/* Tablet / desktop — full dense table inline (unchanged). `min-w-0` so the
              card's flex chain can shrink below the 820px table's intrinsic width,
              letting the inner `overflow-auto` engage (scroll inside the card) instead
              of forcing the whole band wide (→ clipped by the app-shell overflow-clip). */}
          <div className="hidden min-w-0 sm:block">
            <ScheduleTable
              rows={rows}
              maxHeightClass="max-h-[340px]"
              minWidthClass="min-w-[820px]"
            />
          </div>

          {/* Phone — condensed stacked list + tap-to-expand full table sheet. */}
          <div className="sm:hidden">
            <SchedulePreviewMobile rows={rows} />
          </div>
        </>
      )}
    </div>
  );
}
