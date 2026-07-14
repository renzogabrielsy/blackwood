// =====================================================================
// Day-status resolver — the "misleading zero" fix (DRAFT)
// =====================================================================
// Today `getDigestData()` COALESCEs "no row for a stream on the operational
// date" and "a real 0 reading" both to 0. On the operational date that makes
// a planned Sunday, an unfiled report, and a stale stream all render as a
// flat "0" — indistinguishable and often alarming.
//
// This pure module resolves each stream/day to ONE of five states, so a "0"
// carries meaning before it reaches the UI. It has NO server imports (type-
// only import of the contract) and is safe on the client.
//
// When PROD SCHED lands in the DB, this logic should move into the
// `view_digest_day_status` SQL view (per the HARD RULE — no aggregation in
// TS); this module stands in for that view against the DRAFT plan constant.
// =====================================================================

import type { StreamFreshness } from "./types";
import type { ProdSchedDay } from "./prod-schedule-draft";

/**
 * Resolved status for one KPI on the operational date.
 * - `reported` — a real value is present → show the number + delta.
 * - `awaiting` — plant PLANNED to run but the stream has no row yet → amber,
 *   show the projected figure ghosted.
 * - `rest`     — schedule shifts == 0 (Sunday/holiday) → calm, never red.
 * - `stale`    — the stream's latest date lags the operational date beyond
 *   tolerance → red "report overdue".
 * - `idle`     — RC In only: procurement is not shift-bound, so "no delivery
 *   today" is neutral, not a late report.
 */
export type DayState = "reported" | "awaiting" | "rest" | "stale" | "idle";

export interface KpiDayStatus {
  state: DayState;
  /** planned output (tons) for an `awaiting` day, when known */
  projectedTons?: number;
  /** how many days the stream lags the operational date, for `stale` */
  staleDays?: number;
}

/** KPI card key → the stream-freshness key that backs it. */
const KPI_STREAM_MAP: Record<string, string> = {
  rc_out: "rc_out",
  production: "production",
  power: "electricity",
  rc_in: "deliveries",
};

/** Lag (in days) beyond which a silent stream is treated as overdue. */
const STALE_TOLERANCE_DAYS = 2;

/** Days between two yyyy-MM-dd strings (a - b), UTC. */
function daysBetween(a: string, b: string): number {
  const ad = Date.parse(a + "T00:00:00Z");
  const bd = Date.parse(b + "T00:00:00Z");
  return Math.round((ad - bd) / 86_400_000);
}

export interface ResolveKpiArgs {
  /** KPI card key: "rc_in" | "rc_out" | "production" | "power" | "net_flow" */
  kpiKey: string;
  /** the KPI's value on the operational date */
  value: number;
  /** the operational date (yyyy-MM-dd), or null if none */
  operationalDate: string | null;
  /** the day's PROD SCHED plan (may be undefined outside the draft window) */
  plan: ProdSchedDay | undefined;
  /** per-stream freshness from DigestData.meta.streams */
  streams: StreamFreshness[];
}

/**
 * Resolve a single KPI to a day-status. Net flow stays neutral (`reported`) —
 * it is a derived balance whose drift is expected, so it is never flagged.
 */
export function resolveKpiDayStatus({
  kpiKey,
  value,
  operationalDate,
  plan,
  streams,
}: ResolveKpiArgs): KpiDayStatus {
  // Net flow is a derived balance — never a "late report". Leave it neutral.
  if (kpiKey === "net_flow") return { state: "reported" };

  // RC In is procurement, not shift-bound: a day with no delivery is IDLE
  // (neutral), never an "awaiting report" or a rest day.
  if (kpiKey === "rc_in") {
    return value > 0 ? { state: "reported" } : { state: "idle" };
  }

  // Rest day: the plant was not scheduled to run → all-zero is correct.
  if (plan && plan.shifts === 0) return { state: "rest" };

  // A real value present → reported.
  if (value > 0) return { state: "reported" };

  // No value on a day the plant DID run: stale (stream is overdue) vs merely
  // awaiting (the report just hasn't landed yet).
  const streamKey = KPI_STREAM_MAP[kpiKey];
  const stream = streamKey
    ? streams.find((s) => s.stream === streamKey)
    : undefined;

  if (operationalDate && stream?.throughDate) {
    const lag = daysBetween(operationalDate, stream.throughDate);
    if (lag > STALE_TOLERANCE_DAYS) {
      return { state: "stale", staleDays: lag };
    }
  }

  return { state: "awaiting", projectedTons: plan?.projectedTons };
}

// ---------------------------------------------------------------------
// Schedule-table row state (plan vs actual for a whole month)
// ---------------------------------------------------------------------

/**
 * Row state for the Production Schedule table. Distinct from the KPI states:
 * a row can be a FUTURE `planned` day (not yet due) or the `today` row.
 */
export type ScheduleRowState =
  | "reported" // actual output on record
  | "awaiting" // past working day, no actual yet
  | "rest" // planned rest (0 shifts)
  | "planned" // future working day
  | "today"; // the operational date, no actual yet

export function resolveScheduleRowState(
  day: ProdSchedDay,
  actualTons: number | null,
  operationalDate: string | null
): ScheduleRowState {
  if (day.shifts === 0) return "rest";
  if (actualTons != null && actualTons > 0) return "reported";
  if (operationalDate && day.date === operationalDate) return "today";
  if (operationalDate && day.date > operationalDate) return "planned";
  return "awaiting";
}
