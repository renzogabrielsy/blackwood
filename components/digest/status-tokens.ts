// =====================================================================
// Digest — operational-day status style tokens
// =====================================================================
// One home for the chip / rail / label styling of every day-status so the
// KpiHero, plant-status header and week strip stay visually consistent.
// Pure module (no imports) — client- and server-safe. Colors follow the
// digest's existing severity idiom (emerald/amber/red/muted, from kpi-hero
// & digest-header); `planned` uses violet to mark the forward-looking PLAN
// layer.
// =====================================================================

export type StatusKey =
  | "reported"
  | "awaiting"
  | "rest"
  | "idle"
  | "stale"
  | "planned"
  | "today";

/** Pill/chip background + text per state. */
export const STATE_CHIP: Record<StatusKey, string> = {
  reported: "bg-emerald-500/12 text-emerald-700 dark:text-emerald-300",
  awaiting: "bg-amber-500/12 text-amber-700 dark:text-amber-300",
  rest: "bg-muted text-muted-foreground",
  idle: "bg-muted text-muted-foreground",
  stale: "bg-red-500/12 text-red-700 dark:text-red-300",
  planned: "bg-violet-500/12 text-violet-700 dark:text-violet-300",
  today: "bg-amber-500/12 text-amber-700 dark:text-amber-300",
};

/** Left severity-rail background per state (for KPI cards). */
export const STATE_RAIL: Record<StatusKey, string> = {
  reported: "bg-emerald-500",
  awaiting: "bg-amber-500",
  rest: "bg-muted-foreground/50",
  idle: "bg-muted-foreground/40",
  stale: "bg-red-500",
  planned: "bg-violet-500",
  today: "bg-amber-500",
};

/** Short human label per state. */
export const STATE_LABEL: Record<StatusKey, string> = {
  reported: "Reported",
  awaiting: "Awaiting report",
  rest: "Rest day",
  idle: "No delivery",
  stale: "Report overdue",
  planned: "Planned",
  today: "Today · due",
};

/** Status-beacon dot color (plant running vs rest). */
export const BEACON_DOT = {
  run: "bg-emerald-500",
  rest: "bg-muted-foreground",
} as const;
