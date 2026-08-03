// =====================================================================
// Day-status resolver — the "misleading zero" + "lag-by-design" fix
// =====================================================================
// ORIGINAL PROBLEM (still solved here, do not regress): `getDigestData()`
// COALESCEs "no row for a stream on the operational date" and "a real 0
// reading" both to 0. On the operational date that made a planned Sunday,
// an unfiled report, and a stale stream all render as a flat "0" —
// indistinguishable and often alarming. This module resolves each stream
// to ONE of five states so a "0" carries meaning before it reaches the UI.
//
// SECOND PROBLEM (2026-08-03): most streams are reported a day BEHIND by
// design. MC's Daily Production Report (production + electricity + trucks)
// and the PROPOSED DAILY REPORT (rc_out) describe YESTERDAY. Keying those
// cards to the operational date meant PRODUCTION and POWER read "Awaiting
// report" every working day and only filled in retroactively — a sync that
// landed 14,296 kg for 08-01 left the board looking untouched on 08-03.
//
// THE RULE NOW:
//   * A lag-by-design stream's card is anchored to its LATEST REPORTED DAY,
//     not to the operational date, and always carries that day's date.
//   * "Older than expected" is measured in PLANNED WORKING DAYS whose report
//     is outstanding (`missedDays`), computed in SQL against
//     `production_schedule.shifts > 0` and excluding the operational date
//     itself. Sunday is never late; today is never late.
//   * 0 missed → calm. 1 missed → amber (a report is genuinely due).
//     >= 2 missed → red `stale` (overdue), and the card still shows WHAT was
//     last reported and WHEN, so the alarm is specific rather than blank.
//   * RC In is procurement, not shift-bound: unchanged, `idle` on a no-
//     delivery day. Net flow is a derived balance: unchanged, always neutral.
//
// WHERE THE LOGIC LIVES: every ROW-SET fact — the latest reported day per
// stream, the previous reported day, the missed-working-day count — is
// computed in SQL (`view_digest_stream_status`, migration
// 20260803070000). This module only BRANCHES over those scalars, which is
// per-day state resolution, not aggregation. It has NO server imports
// (type-only import of the contract) and is safe on the client.
// =====================================================================

import type { StreamFreshness } from "./types";

// ---------------------------------------------------------------------
// PROD SCHED day shape (moved here from the retired prod-schedule-draft
// constant — the live plan now comes from the `production_schedule` table
// via getDigestData()). Shared by the digest adapter + the resolvers below.
// ---------------------------------------------------------------------

/** Planned shift count for a day. 0 = planned rest (Sunday / holiday). */
export type PlannedShifts = 0 | 1 | 2;

/** One day of the PROD SCHED plan (from `production_schedule`).
 *  `projectedTons` is the planned output in TONS. */
export interface ProdSchedDay {
  /** yyyy-MM-dd */
  date: string;
  /** short weekday, e.g. "Mon" */
  dow: string;
  shifts: PlannedShifts;
  /** line setup label, e.g. "3X50 / 4X8"; null on a rest day */
  setup: string | null;
  /** planned output in TONS */
  projectedTons: number;
  /** free-text planning note from the sheet, when present */
  remarks?: string;
}

/**
 * Resolved status for one KPI card.
 * - `reported` — a real value is present → show the number + delta. For a
 *   lag-by-design stream the number belongs to `asOf` (its latest reported
 *   day), and `missedDays === 1` additionally tints the card amber.
 * - `awaiting` — plant PLANNED to run but the stream has no row yet → amber,
 *   show the projected figure ghosted. NOT emitted for lag-by-design streams
 *   (see the header): "today has no row" is their normal state, so this
 *   could otherwise be the whole working day.
 * - `rest`     — schedule shifts == 0 (Sunday/holiday) → calm, never red.
 * - `stale`    — the stream is `OVERDUE_AFTER_MISSED_DAYS`+ planned working
 *   days behind → red "report overdue".
 * - `idle`     — RC In only: procurement is not shift-bound, so "no delivery
 *   today" is neutral, not a late report.
 */
export type DayState = "reported" | "awaiting" | "rest" | "stale" | "idle";

export interface KpiDayStatus {
  state: DayState;
  /** planned output (tons) for an `awaiting` day, when known */
  projectedTons?: number;
  /** how many planned WORKING days the stream is behind, for `stale` */
  staleDays?: number;
  /** true when this KPI's stream is reported a day behind BY DESIGN, so the
   *  card is anchored to `asOf` rather than to the operational date. */
  lagByDesign?: boolean;
  /** the day the headline value belongs to (yyyy-MM-dd). Set ONLY when that
   *  day is not the operational date — i.e. exactly when the card must show
   *  a date so the number can't be mistaken for today's. */
  asOf?: string;
  /** calendar days between `asOf` and the operational date ("2 days ago"). */
  asOfAgeDays?: number;
  /** planned WORKING days whose report is outstanding. 0 = on time,
   *  1 = amber (due), >= 2 = overdue. Undefined when not computable. */
  missedDays?: number;
  /** the operational date itself is a planned rest day (shifts === 0) —
   *  rendered as a calm side-note, never as an alarm. */
  restToday?: boolean;
}

/** KPI card key → the stream-freshness key that backs it. */
const KPI_STREAM_MAP: Record<string, string> = {
  rc_out: "rc_out",
  production: "production",
  power: "electricity",
  rc_in: "deliveries",
};

/** Missed planned WORKING days at which a lagging stream turns amber. One
 *  outstanding working day = the report is genuinely due right now. */
export const LATE_AFTER_MISSED_DAYS = 1;

/** …and at which it turns red / `stale`. Two outstanding working days means
 *  a report was skipped, not merely delayed by a morning. */
export const OVERDUE_AFTER_MISSED_DAYS = 2;

/** Days between two yyyy-MM-dd strings (a - b), UTC. */
function daysBetween(a: string, b: string): number {
  const ad = Date.parse(a + "T00:00:00Z");
  const bd = Date.parse(b + "T00:00:00Z");
  return Math.round((ad - bd) / 86_400_000);
}

/** The stream backing a KPI card, or undefined for derived cards. */
export function streamForKpi(
  kpiKey: string,
  streams: StreamFreshness[]
): StreamFreshness | undefined {
  const key = KPI_STREAM_MAP[kpiKey];
  return key ? streams.find((s) => s.stream === key) : undefined;
}

/**
 * The day a KPI card's headline value belongs to.
 *
 * Same-day streams (RC In) and derived cards stay on the operational date.
 * A lag-by-design stream anchors to its latest REPORTED day, which comes
 * from SQL (`view_digest_stream_status.through_date`) — never from scanning
 * the daily series in TypeScript.
 */
export function resolveKpiAnchorDate({
  kpiKey,
  operationalDate,
  streams,
}: {
  kpiKey: string;
  operationalDate: string | null;
  streams: StreamFreshness[];
}): string | null {
  const stream = streamForKpi(kpiKey, streams);
  if (!stream?.reportsNextDay) return operationalDate;
  return stream.throughDate ?? null;
}

/** The reported day immediately before the anchor, for a meaningful delta.
 *  Same-day / derived cards keep comparing against `prevOperationalDate`. */
export function resolveKpiPrevDate({
  kpiKey,
  prevOperationalDate,
  streams,
}: {
  kpiKey: string;
  prevOperationalDate: string | null;
  streams: StreamFreshness[];
}): string | null {
  const stream = streamForKpi(kpiKey, streams);
  if (!stream?.reportsNextDay) return prevOperationalDate;
  return stream.prevReportedDate ?? null;
}

export interface ResolveKpiArgs {
  /** KPI card key: "rc_in" | "rc_out" | "production" | "power" | "net_flow" */
  kpiKey: string;
  /** the KPI's value at its anchor day */
  value: number;
  /** the day that value belongs to — `resolveKpiAnchorDate()` narrowed to a
   *  day the loaded daily series actually carries; null when there is no
   *  usable reported value at all. */
  anchorDate: string | null;
  /** the operational date (yyyy-MM-dd), or null if none */
  operationalDate: string | null;
  /** the day's PROD SCHED plan (may be undefined outside the plan window) */
  plan: ProdSchedDay | undefined;
  /** per-stream status from DigestData.meta.streams */
  streams: StreamFreshness[];
}

/**
 * Resolve a single KPI to a day-status. Net flow stays neutral (`reported`) —
 * it is a derived balance whose drift is expected, so it is never flagged.
 */
export function resolveKpiDayStatus({
  kpiKey,
  value,
  anchorDate,
  operationalDate,
  plan,
  streams,
}: ResolveKpiArgs): KpiDayStatus {
  // Net flow is a derived balance — never a "late report". Leave it neutral.
  if (kpiKey === "net_flow") return { state: "reported" };

  const stream = streamForKpi(kpiKey, streams);
  const restToday = plan?.shifts === 0;

  // -------------------------------------------------------------------
  // SAME-DAY streams. RC In is procurement, not shift-bound: a day with no
  // delivery is IDLE (neutral), never an "awaiting report" or a rest day.
  // -------------------------------------------------------------------
  if (!stream?.reportsNextDay) {
    if (kpiKey === "rc_in") {
      return value > 0 ? { state: "reported" } : { state: "idle" };
    }
    // Any future same-day stream: keep the original plan-driven ladder.
    if (restToday) return { state: "rest" };
    if (value > 0) return { state: "reported" };
    return { state: "awaiting", projectedTons: plan?.projectedTons };
  }

  // -------------------------------------------------------------------
  // LAG-BY-DESIGN streams (rc_out / production / power). The card is about
  // the latest REPORTED day, so "today has no row" is never itself a fault.
  // -------------------------------------------------------------------
  const missedDays = stream.missedDays ?? undefined;

  // Nothing usable on record — either the stream has never reported, or its
  // latest reported day falls outside the loaded daily window.
  if (!anchorDate) {
    if (stream.throughDate == null && restToday) {
      return { state: "rest", lagByDesign: true, restToday: true };
    }
    return {
      state: "stale",
      lagByDesign: true,
      staleDays: missedDays,
      missedDays,
      restToday: restToday || undefined,
    };
  }

  const asOf = anchorDate === operationalDate ? undefined : anchorDate;
  const base: KpiDayStatus = {
    state: "reported",
    lagByDesign: true,
    missedDays,
    ...(asOf ? { asOf } : {}),
    ...(asOf && operationalDate
      ? { asOfAgeDays: daysBetween(operationalDate, asOf) }
      : {}),
    ...(restToday ? { restToday: true } : {}),
  };

  // Overdue: a planned working day's report was skipped, not just delayed.
  if (missedDays != null && missedDays >= OVERDUE_AFTER_MISSED_DAYS) {
    return { ...base, state: "stale", staleDays: missedDays };
  }

  // On time (0 missed) or one report due (1 missed → amber, rendered by the
  // card from `missedDays`). Either way the real number leads.
  return base;
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
