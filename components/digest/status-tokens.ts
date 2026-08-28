// =====================================================================
// Digest — operational-day status style tokens
// =====================================================================
// One home for the chip / rail / label styling of every day-status so the
// digest's bands stay visually consistent. Pure module (no imports) — client-
// and server-safe. Colors follow the digest's existing severity idiom
// (emerald/amber/red/muted, from kpi-hero & digest-header).
//
// TRIMMED 2026-08-28: `rest`, `planned` and `today` went with the production
// plan. `rest` was the DayState only the plan could resolve; `planned`/`today`
// were the schedule table's forward-looking row states. The keys here now
// mirror `DayState` in `lib/digest/day-status.ts` exactly, which is the point —
// a token map with states nothing can produce invites a dead branch.
// =====================================================================

export type StatusKey = "reported" | "awaiting" | "idle" | "stale";

/** Pill/chip background + text per state. */
export const STATE_CHIP: Record<StatusKey, string> = {
  reported: "bg-emerald-500/12 text-emerald-700 dark:text-emerald-300",
  awaiting: "bg-amber-500/12 text-amber-700 dark:text-amber-300",
  idle: "bg-muted text-muted-foreground",
  stale: "bg-red-500/12 text-red-700 dark:text-red-300",
};

/** Left severity-rail background per state (for KPI cards). */
export const STATE_RAIL: Record<StatusKey, string> = {
  reported: "bg-emerald-500",
  awaiting: "bg-amber-500",
  idle: "bg-muted-foreground/40",
  stale: "bg-red-500",
};

/** Short human label per state. */
export const STATE_LABEL: Record<StatusKey, string> = {
  reported: "Reported",
  awaiting: "Awaiting report",
  idle: "No delivery",
  stale: "Report overdue",
};
