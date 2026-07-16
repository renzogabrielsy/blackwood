"use client";

// ─────────────────────────────────────────────────────────────────────────────
// ScheduleCardsMobile — the phone read layer for /production/schedule.
//
// Rendered `sm:hidden` by the schedule page; the desktop dense `<table>` is
// `hidden sm:block` and untouched. Generalizes the digest's SchedulePreviewMobile
// pattern: the SAME shared `ScheduleRowCard` row, but a FULL-MONTH list (no 5-row
// preview slice) with the `Act hrs` / `Var` fields the digest omits.
//
// Fed the SAME `rows` the server page built for the desktop table (single source
// of truth) — no refetch. No ₱ anywhere → no price gating.
// ─────────────────────────────────────────────────────────────────────────────

import * as React from "react";
import {
  ScheduleRowCard,
  type ScheduleRowCardData,
} from "@/components/digest/schedule-row-card";

/** A serializable subset of the page's ScheduleRow — the fields the card needs. */
export type ScheduleMobileRow = ScheduleRowCardData & {
  /** true when isToday is false AND the row's state should force the chip. */
  chipState: ScheduleRowCardData["state"];
};

export function ScheduleCardsMobile({ rows }: { rows: ScheduleMobileRow[] }) {
  return (
    <ul className="animate-fade-up flex flex-col rounded-xl border bg-card/95">
      {rows.map((r) => (
        <ScheduleRowCard
          key={r.date}
          row={{
            date: r.date,
            dow: r.dow,
            shifts: r.shifts,
            setup: r.setup,
            gradeTons: r.gradeTons,
            projectedTons: r.projectedTons,
            actualTons: r.actualTons,
            state: r.chipState,
            isToday: r.isToday,
            actualHrs: r.actualHrs,
            variance: r.variance,
          }}
        />
      ))}
    </ul>
  );
}
