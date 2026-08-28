// =====================================================================
// Day-status resolver — the "misleading zero" + "lag-by-design" fix
// =====================================================================
// ORIGINAL PROBLEM (still solved here, do not regress): `getDigestData()`
// COALESCEs "no row for a stream on the operational date" and "a real 0
// reading" both to 0. On the operational date that made a quiet day, an
// unfiled report, and a stale stream all render as a flat "0" —
// indistinguishable and often alarming. This module resolves each stream
// to ONE of four states so a "0" carries meaning before it reaches the UI.
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
//   * "Older than expected" is measured in WORKING DAYS whose report is
//     outstanding (`missedDays`), computed in SQL and excluding the
//     operational date itself, so today is never late. (Until 2026-08-28 a
//     working day meant `production_schedule.shifts > 0`; with the production
//     plan retired, SQL derives it from days another stream reported. Same
//     column, same meaning here — this module only branches on the number.
//     Back-tested over 239 days x 5 streams: 1,188 of 1,195 stream-days keep
//     the IDENTICAL verdict, so the ladder below is unchanged in meaning and
//     very slightly MORE sensitive. **The blind spot, so it is never a
//     surprise: a day on which NO stream reported cannot be known to have been
//     a working day, so a total plant-wide outage now reads as a holiday and
//     raises nothing here.** That is structural — with the plan retired,
//     nothing in the system records INTENT to run. Do not try to patch it in
//     this module: it has only the scalars SQL hands it, and guessing intent
//     from absence is the exact class of error the `rest` state was removed
//     for.)
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

/**
 * Resolved status for one KPI card.
 * - `reported` — a real value is present → show the number + delta. For a
 *   lag-by-design stream the number belongs to `asOf` (its latest reported
 *   day), and `missedDays === 1` additionally tints the card amber.
 * - `awaiting` — a same-day stream has no row yet → amber. NOT emitted for
 *   lag-by-design streams (see the header): "today has no row" is their normal
 *   state, so this could otherwise be the whole working day.
 * - `stale`    — the stream is `OVERDUE_AFTER_MISSED_DAYS`+ working days
 *   behind → red "report overdue".
 * - `idle`     — RC In only: procurement is not shift-bound, so "no delivery
 *   today" is neutral, not a late report.
 */
// NOTE (2026-08-28): `rest` was removed with the production plan. It was the
// ONE state that could not be resolved from activity — only the plan knew a
// Sunday was a *planned* rest rather than a missing report — and inferring it
// from "no rows today" would have been a guess dressed as a fact.
export type DayState = "reported" | "awaiting" | "stale" | "idle";

export interface KpiDayStatus {
  state: DayState;
  /** how many WORKING days the stream is behind, for `stale` */
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
  /** WORKING days whose report is outstanding. 0 = on time,
   *  1 = amber (due), >= 2 = overdue. Undefined when not computable. */
  missedDays?: number;
}

/** KPI card key → the stream-freshness key that backs it. */
const KPI_STREAM_MAP: Record<string, string> = {
  rc_out: "rc_out",
  production: "production",
  power: "electricity",
  rc_in: "deliveries",
};

/** Missed WORKING days at which a lagging stream turns amber. One
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
 * The last day on which EVERY named stream has reported — i.e. the most recent
 * date for which a figure derived from all of them is complete.
 *
 * It is the MINIMUM of their `through_date`s, and the reasoning is that
 * `through_date` is a high-water mark: a stream that has reported through the
 * 3rd has also settled the 1st. So the earliest high-water mark is the latest
 * date none of them can still change.
 *
 * Returns null if any stream is missing or has never reported — with nothing to
 * anchor to, the caller falls back rather than inventing a date.
 */
export function resolveCompleteThroughDate(
  kpiKeys: string[],
  streams: StreamFreshness[]
): string | null {
  const dates: string[] = [];
  for (const key of kpiKeys) {
    const through = streamForKpi(key, streams)?.throughDate;
    if (!through) return null;
    dates.push(through);
  }
  if (dates.length === 0) return null;
  return dates.reduce((min, d) => (d < min ? d : min));
}

/** KPI cards derived from more than one stream → the streams they need. */
const DERIVED_KPI_INPUTS: Record<string, string[]> = {
  // Net Flow = RC In − RC Out. Both sides must have spoken for the number to mean
  // anything (2026-08-04).
  net_flow: ["rc_in", "rc_out"],
};

/**
 * The day a KPI card's headline value belongs to.
 *
 * Same-day streams (RC In) stay on the operational date. A lag-by-design stream
 * anchors to its latest REPORTED day, which comes from SQL
 * (`view_digest_stream_status.through_date`) — never from scanning the daily
 * series in TypeScript.
 *
 * **A DERIVED card anchors to the last day ALL of its inputs have reported
 * (2026-08-04, Renzo's decision).** Net Flow used to sit on the operational date,
 * where RC In already carries today's deliveries and RC Out (which reports the
 * morning after) does not — so the card read a large positive that was really
 * "everything in, nothing out". Subtracting a stream that has not spoken yet is
 * not a net flow, it is one side of one. Anchoring to the last complete day makes
 * the number a real in-minus-out again; it is a day or two behind, and the card's
 * existing `AsOfChip` already says which day it is showing.
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
  const inputs = DERIVED_KPI_INPUTS[kpiKey];
  if (inputs) return resolveCompleteThroughDate(inputs, streams) ?? operationalDate;

  const stream = streamForKpi(kpiKey, streams);
  if (!stream?.reportsNextDay) return operationalDate;
  return stream.throughDate ?? null;
}

/**
 * The previous COMPLETE day for a derived card — the comparison point for its delta.
 *
 * The anchor is set by whichever input is furthest behind (the minimum
 * `through_date`), so the previous complete day is that same stream's previous
 * reported day. Stepping back one calendar day instead would land on a non-
 * reporting day half the time; stepping back by the *other* stream's history would compare a
 * complete day against an incomplete one, which is the bug being fixed.
 */
export function resolveCompletePrevDate(
  kpiKeys: string[],
  streams: StreamFreshness[]
): string | null {
  let binding: StreamFreshness | undefined;
  for (const key of kpiKeys) {
    const s = streamForKpi(key, streams);
    if (!s?.throughDate) return null;
    if (!binding?.throughDate || s.throughDate < binding.throughDate) binding = s;
  }
  return binding?.prevReportedDate ?? null;
}

/** The reported day immediately before the anchor, for a meaningful delta.
 *  Same-day cards keep comparing against `prevOperationalDate`; a DERIVED card
 *  compares against the previous day all of its inputs had reported. */
export function resolveKpiPrevDate({
  kpiKey,
  prevOperationalDate,
  streams,
}: {
  kpiKey: string;
  prevOperationalDate: string | null;
  streams: StreamFreshness[];
}): string | null {
  const inputs = DERIVED_KPI_INPUTS[kpiKey];
  if (inputs) return resolveCompletePrevDate(inputs, streams) ?? prevOperationalDate;

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
  streams,
}: ResolveKpiArgs): KpiDayStatus {
  // Net flow is a derived balance — never a "late report". Its inputs' lateness is
  // already reported by their OWN cards, and repeating it here would double-count one
  // missing report as two problems. It stays neutral, permanently `reported`.
  //
  // But it is no longer anchored to today (2026-08-04): it now sits on the last day
  // BOTH of its inputs reported, so it MUST say which day that is. Without the chip the
  // card would silently show a day-old balance as if it were the current one — quieter
  // than the bug it replaces, and just as wrong to read. `asOf` is set only when the
  // anchor actually trails the operational date, so on a fully caught-up day the chip
  // disappears exactly as it does for every other card.
  if (kpiKey === "net_flow") {
    return anchorDate && operationalDate && anchorDate < operationalDate
      ? { state: "reported", asOf: anchorDate }
      : { state: "reported" };
  }

  const stream = streamForKpi(kpiKey, streams);

  // -------------------------------------------------------------------
  // SAME-DAY streams. RC In is procurement, not shift-bound: a day with no
  // delivery is IDLE (neutral), never an "awaiting report".
  // -------------------------------------------------------------------
  if (!stream?.reportsNextDay) {
    if (kpiKey === "rc_in") {
      return value > 0 ? { state: "reported" } : { state: "idle" };
    }
    // Any future same-day stream: reported when it has a number, else awaiting.
    if (value > 0) return { state: "reported" };
    return { state: "awaiting" };
  }

  // -------------------------------------------------------------------
  // LAG-BY-DESIGN streams (rc_out / production / power). The card is about
  // the latest REPORTED day, so "today has no row" is never itself a fault.
  // -------------------------------------------------------------------
  const missedDays = stream.missedDays ?? undefined;

  // Nothing usable on record — either the stream has never reported, or its
  // latest reported day falls outside the loaded daily window.
  if (!anchorDate) {
    return {
      state: "stale",
      lagByDesign: true,
      staleDays: missedDays,
      missedDays,
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
  };

  // Overdue: a working day's report was skipped, not just delayed.
  if (missedDays != null && missedDays >= OVERDUE_AFTER_MISSED_DAYS) {
    return { ...base, state: "stale", staleDays: missedDays };
  }

  // On time (0 missed) or one report due (1 missed → amber, rendered by the
  // card from `missedDays`). Either way the real number leads.
  return base;
}
