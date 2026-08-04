/**
 * streamStaleness.ts — turn `view_digest_stream_status` into a RUN FINDING.
 *
 * The recurring bug shape in this codebase is a detector nobody reads. This closes one
 * of them: the view has computed `missed_working_days` per stream since 2026-08-03
 * (migration `20260803070000`) and **nothing in the worker consumed it** — a stream
 * could go quiet for a week and the only way to notice was to look at the digest.
 *
 * The arithmetic is NOT reimplemented here. `missed_working_days` counts
 * `production_schedule` days with `shifts > 0` STRICTLY BETWEEN the stream's latest
 * reported day and the operational date, so:
 *   - a rest day is never late,
 *   - a next-day stream's not-yet-due report for today is never late,
 *   - `> 0` genuinely means "a working day passed and this stream said nothing."
 * That is why the threshold is a bare `> 0` and not a tunable — the tuning already
 * happened in SQL, where the calendar lives.
 *
 * NON-FATAL by contract, like every other reconciliation channel: any failure returns
 * an empty list. A staleness alert must never be the reason a sync run fails — the
 * whole point is to report on runs that otherwise look clean.
 */
import type { DbClient, Row } from "./db.js";

/** One stream that has missed at least one planned working day. */
export interface StaleStream {
  /** Stable key: `deliveries` | `rc_out` | `production` | `electricity` | `trucks`. */
  stream: string;
  /** Human label straight from the registry view ("RC Out (usage)"). */
  label: string;
  /** The latest date this stream has actually reported. Null if it never has. */
  through_date: string | null;
  /** The operational date the lateness is measured against. */
  operational_date: string | null;
  /** Planned working days between the two, exclusive. Always >= 1 here. */
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

/**
 * Read the stream status view and keep only the streams that are genuinely late.
 * Sorted worst-first so the run summary leads with the stream that needs attention.
 */
export function selectStaleStreams(rows: Row[]): StaleStream[] {
  return rows
    .map((r) => ({
      stream: String(r.stream ?? ""),
      label: String(r.label ?? r.stream ?? ""),
      through_date: asStr(r.through_date),
      operational_date: asStr(r.operational_date),
      missed_working_days: asNum(r.missed_working_days),
      reports_next_day: r.reports_next_day === true,
    }))
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

/**
 * Fetch the stale streams for this run. Fully guarded: a read failure logs nothing here
 * and returns [], leaving the caller to decide whether to mention it.
 */
export async function findStaleStreams(db: DbClient): Promise<StaleStream[]> {
  try {
    const rows = await db.readRows("view_digest_stream_status", {
      sinceDate: null,
      sinceColumn: null,
      columns: [
        "stream",
        "label",
        "reports_next_day",
        "through_date",
        "operational_date",
        "missed_working_days",
      ],
    });
    return selectStaleStreams(rows);
  } catch {
    return [];
  }
}
