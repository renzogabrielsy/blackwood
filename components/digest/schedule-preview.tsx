// Server component — the Home Digest's compact Production Schedule table band.
// Presentation-only: renders the pre-resolved `schedulePreview` slice from
// getDigestData() as a dense Excel-Standard table (a rolling ~2-week window),
// complementing the full page at /production/schedule and the WeekStrip cards.
// No aggregation, no ₱ data → no price gating.
//
// Responsive: tablet/desktop show the full dense table inline (unchanged). On
// phones the 9-column table is unreadable, so a condensed stacked list plus a
// "View full table" bottom sheet (SchedulePreviewMobile) takes over.
import Link from "next/link";
import { ScheduleTable } from "./schedule-table";
import { SchedulePreviewMobile } from "./schedule-preview-mobile";
import type { SchedulePreviewRow } from "@/lib/digest/types";

interface SchedulePreviewProps {
  /** the operational date through the next 9 days (10 rows), plan + actual */
  rows: SchedulePreviewRow[];
}

/**
 * Compact production-schedule band for the Home Digest — a rolling 10-day window
 * (today first), sized as a HALF-WIDTH scroll card. Today's row is accent-tinted,
 * rest days render dashed/muted, each working row carries a Status chip and a
 * Source chip (violet Joseph when the DB source starts with `joseph:`, else muted
 * Sheet). Renders `null` when there is nothing to show.
 */
export function SchedulePreview({ rows }: SchedulePreviewProps) {
  if (!rows.length) return null;

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

      {/* Tablet / desktop — full dense table inline (unchanged). */}
      <div className="hidden sm:block">
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
    </div>
  );
}
