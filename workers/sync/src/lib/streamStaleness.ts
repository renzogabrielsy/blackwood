/**
 * streamStaleness.ts — turn `view_digest_stream_status` into a RUN FINDING.
 *
 * The recurring bug shape in this codebase is a detector nobody reads. This closes one
 * of them: the view has computed `missed_working_days` per stream since 2026-08-03
 * (migration `20260803070000`) and **nothing in the worker consumed it** — a stream
 * could go quiet for a week and the only way to notice was to look at the digest.
 *
 * The arithmetic is NOT reimplemented here, and this module does not read the plan — it
 * reads ONE view and trusts its number. `missed_working_days` counts the days ANY OTHER
 * STREAM REPORTED, STRICTLY BETWEEN this stream's latest reported day and the operational
 * date (rewritten 2026-08-28 when the production-schedule table was retired; it previously
 * counted planned days with `shifts > 0`). The three properties the watch depends on are
 * unchanged:
 *   - a rest day is never late,
 *   - a next-day stream's not-yet-due report for today is never late,
 *   - `> 0` genuinely means "a day the plant was demonstrably active passed and this
 *     stream said nothing."
 * That is why the threshold is a bare `> 0` and not a tunable — the tuning already
 * happened in SQL, where the definition lives.
 *
 * "A Sunday is never late" still holds, but NOT because nothing reports on a Sunday —
 * 8 of 2026's 34 Sundays carried a report. It holds because the bound is strictly
 * `< operational_date` and `operational_date` is itself activity-derived, so a quiet
 * stretch ENDING on a Sunday cannot count it. Replaying 2026 gave the same verdict on
 * 1,188 of 1,195 stream-days; the new rule is marginally MORE sensitive, and has one
 * structural blind spot — a day on which NO stream reported at all cannot be known to
 * have been a working day, so a total plant-wide outage reads as a holiday. See
 * `supabase/migrations/20260828013000_drop_production_schedule.sql` for the measurement.
 *
 * NON-FATAL by contract, like every other reconciliation channel: a failure never fails
 * the run. A staleness alert must never be the reason a sync run fails — the whole point
 * is to report on runs that otherwise look clean.
 *
 * ============================================================================
 * BUT NON-FATAL IS NOT THE SAME AS SILENT (2026-08-18, L-044)
 * ============================================================================
 * This module used to end in `catch { return [] }`, and that one line hid the watchdog's
 * own death for two weeks. The worker's service role had **no SELECT grant** on
 * `view_digest_stream_status` (the denial cascaded up the `security_invoker` chain from
 * `view_digest_operational_days`), so every read returned
 *
 *     {"code":"42501","message":"permission denied for view view_digest_stream_status"}
 *
 * ...which the catch turned into `[]` — and `[]` was then reported to the operator as
 * **"Every report stream is up to date."** Measured: `stale_streams` is absent from
 * `sync_runs.result.reconciliation` on **every run in the table**. The freshness watch
 * built on 2026-08-04 has never fired once, and nobody could tell, because its failure
 * mode was indistinguishable from a healthy plant.
 *
 * So: **`[]` must mean "I looked and nothing is late", NEVER "I could not look."** The
 * read returns `{streams, error}` and the caller reports a non-null `error` as a run
 * finding. Same treatment, same reason, as `readUnpricedOverdue` in
 * `reports/deliveries/index.ts` — the two watchdogs that were blind together.
 */
import type { DbClient, Row } from "./db.js";

/** One stream that has missed at least one working day the plant was active. */
export interface StaleStream {
  /** Stable key: `deliveries` | `rc_out` | `production` | `electricity` | `trucks`. */
  stream: string;
  /** Human label straight from the registry view ("RC Out (usage)"). */
  label: string;
  /** The latest date this stream has actually reported. Null if it never has. */
  through_date: string | null;
  /** The operational date the lateness is measured against. */
  operational_date: string | null;
  /** Active days between the two, exclusive (days another stream reported). Always >= 1 here. */
  missed_working_days: number;
  /** True when the stream reports a day behind by design (affects the wording only). */
  reports_next_day: boolean;
}

function asNum(v: unknown): number {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}

function asStr(v: unknown): string | null {
  return v === null || v === undefined || v === "" ? null : String(v);
}

/** The columns every reader of the view needs. ONE list, so two readers cannot drift. */
const STREAM_STATUS_COLUMNS = [
  "stream",
  "label",
  "reports_next_day",
  "through_date",
  "operational_date",
  "missed_working_days",
] as const;

/** Coerce one raw view row → StaleStream. Shape only; says nothing about lateness. */
function toStreamStatus(r: Row): StaleStream {
  return {
    stream: String(r.stream ?? ""),
    label: String(r.label ?? r.stream ?? ""),
    through_date: asStr(r.through_date),
    operational_date: asStr(r.operational_date),
    missed_working_days: asNum(r.missed_working_days),
    reports_next_day: r.reports_next_day === true,
  };
}

/**
 * Read the stream status view and keep only the streams that are genuinely late.
 * Sorted worst-first so the run summary leads with the stream that needs attention.
 */
export function selectStaleStreams(rows: Row[]): StaleStream[] {
  return rows
    .map(toStreamStatus)
    .filter((s) => s.stream !== "" && s.missed_working_days > 0)
    .sort((a, b) =>
      b.missed_working_days - a.missed_working_days ||
      (a.stream < b.stream ? -1 : a.stream > b.stream ? 1 : 0),
    );
}

/** One plain-language sentence per stale stream, for the run summary beat. */
export function describeStaleStream(s: StaleStream): string {
  const days = s.missed_working_days === 1 ? "1 working day" : `${s.missed_working_days} working days`;
  const last = s.through_date ? `last reported ${s.through_date}` : "has never reported";
  return `${s.label} — ${last}, ${days} missed.`;
}

/** What a staleness read produced: an ANSWER, or the reason there isn't one. */
export interface StaleStreamRead {
  /** Streams genuinely late. Meaningful ONLY when `error` is null. */
  streams: StaleStream[];
  /** Non-null when the view could not be read. `streams` is then empty and MEANINGLESS. */
  error: string | null;
}

/**
 * Fetch the stale streams for this run.
 *
 * Still guarded — it never throws, so it can never fail a run — but the guard now RETURNS
 * THE FAILURE instead of erasing it. An empty `streams` with a non-null `error` is the
 * caller's cue to say "not checked"; an empty `streams` with a null `error` is the only
 * form that means "nothing is late". See the module header for what the old
 * `catch { return [] }` cost.
 */
export async function findStaleStreams(db: DbClient): Promise<StaleStreamRead> {
  try {
    const rows = await db.readRows("view_digest_stream_status", {
      sinceDate: null,
      sinceColumn: null,
      columns: [...STREAM_STATUS_COLUMNS],
    });
    return { streams: selectStaleStreams(rows), error: null };
  } catch (err) {
    return { streams: [], error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * WHY the lateness number is missing. Three states that used to be one `null`.
 *
 * They are not interchangeable, because the operator's NEXT ACTION differs:
 *   - `unreadable`     — the view could not be read. **This is the two-week failure**: a
 *                        missing `service_role` SELECT grant returned 42501 on every call.
 *                        Someone must check grants/the view. Naming it is the difference
 *                        between an actionable finding and a shrug.
 *   - `unregistered`   — the view read fine and has no row for this stream. A registry gap
 *                        (`view_digest_stream_registry`), i.e. a config bug, not an outage.
 *   - `not_computable` — the row exists but the view itself returned NULL, which it does
 *                        when the stream has NEVER reported (no `through_date`). Nothing is
 *                        broken; there is simply no baseline to count working days from.
 */
export type LatenessUnknownReason = "unreadable" | "unregistered" | "not_computable";

/** What a single-stream status read produced: an ANSWER, or WHY there isn't one. */
export interface StreamStatusRead {
  /** The row, when one was found. Null for every `unknown` reason. */
  status: StaleStream | null;
  /**
   * The view's own `missed_working_days`, **preserving SQL NULL**. Non-null ONLY when the
   * number was genuinely measured — so a consumer can never mistake "not computable" for
   * "0", which means "measured, and on time".
   */
  missedWorkingDays: number | null;
  /** Null exactly when `missedWorkingDays` is a real measurement. */
  unknownReason: LatenessUnknownReason | null;
  /** The read failure's message, set only when `unknownReason === "unreadable"`. */
  error: string | null;
}

/**
 * The status of ONE stream, late or not (2026-08-18, L-044).
 *
 * `findStaleStreams` answers "who is behind"; this answers "how far behind is THIS one,
 * including zero". A report that did not arrive in a run needs the second question: the
 * fact worth reporting is that the email is missing, and `missed_working_days` only says
 * how loudly to say it — a 0 is still a real answer ("the mail is missing but the data is
 * not behind, so nothing is late yet"), and dropping it would silently downgrade the
 * finding to nothing.
 *
 * The lateness arithmetic is STILL the view's alone — this adds no second rule, and both
 * readers select the same columns from the same view.
 *
 * It returns a REASON, not a bare null (tightened 2026-08-18, second pass). One `null`
 * previously meant "the read failed" AND "no such stream", and those want different words
 * to a human — see `LatenessUnknownReason`. It also stops `asNum` turning the view's own
 * SQL NULL into `0`: that is the `Number(null) === 0` trap one level down, and `0` is the
 * one value a reader is entitled to trust as a measurement.
 */
export async function findStreamStatus(
  db: DbClient,
  stream: string,
): Promise<StreamStatusRead> {
  let rows: Row[];
  try {
    rows = await db.readRows("view_digest_stream_status", {
      sinceDate: null,
      sinceColumn: null,
      columns: [...STREAM_STATUS_COLUMNS],
      extraFilters: { stream: `eq.${stream}` },
    });
  } catch (err) {
    return {
      status: null,
      missedWorkingDays: null,
      unknownReason: "unreadable",
      error: err instanceof Error ? err.message : String(err),
    };
  }

  const hit = rows.find((r) => String(r.stream ?? "") === stream);
  if (!hit) {
    return { status: null, missedWorkingDays: null, unknownReason: "unregistered", error: null };
  }

  // The view returns NULL when there is no `through_date` to count from. `asNum` would
  // read that as 0 — "measured, on time" — so the raw value is inspected here instead.
  const raw = hit.missed_working_days;
  const measured = raw === null || raw === undefined ? null : asNum(raw);
  return {
    status: toStreamStatus(hit),
    missedWorkingDays: measured,
    unknownReason: measured === null ? "not_computable" : null,
    error: null,
  };
}
