/**
 * reportNotReceived.ts — THE one way "the daily report did not arrive" becomes an
 * operator-facing note (2026-08-18, L-044).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY A MISSING REPORT IS A FINDING AND NOT A REASSURANCE
 * ─────────────────────────────────────────────────────────────────────────────
 * When no RC DELIVERIES attachment was waiting, the deliveries run returned early and
 * emitted, at 100% progress:
 *
 *     "Nothing new today — no RC DELIVERIES report waiting."
 *
 * That sentence is true and it is the wrong thing to say. It reads as *the sync checked
 * and everything is fine*, and it was printed on the very days RC IN was going stale —
 * the days four truckloads sat unpriced and un-ingested. A run in which NOTHING arrived
 * is otherwise indistinguishable from a quiet day, which is exactly the shape of failure
 * that let RC OUT go five days stale in July and the price file go two weeks wrong in
 * August: the absence of a signal is not a signal, unless something says so out loud.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * NO SECOND STALENESS RULE — THE VIEW ALREADY OWNS IT
 * ─────────────────────────────────────────────────────────────────────────────
 * `view_digest_stream_status.missed_working_days` is the ONE definition of "late", and it
 * is lag-aware in ways nothing here should try to re-derive: it counts the days ANY OTHER
 * STREAM REPORTED, STRICTLY between the stream's latest reported day and the operational
 * date, so a Sunday is never late and a report that is not due yet is never late. This
 * module reads that number and decides only HOW LOUDLY to say the mail is missing. It
 * computes no calendar of its own — and that is the whole reason it survived the
 * production-schedule removal (2026-08-28) without a line changing: the definition moved
 * from a planned-days count to an activity-derived one INSIDE the view, where it belongs.
 * A second copy of the calendar here would have had to be found and rewritten.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * HOW THIS DIFFERS FROM THE `stale_stream` FINDING (they are not duplicates)
 * ─────────────────────────────────────────────────────────────────────────────
 * `stale_stream` (runSync Stage 3e) is a DATA fact: the `deliveries` table has no rows for
 * recent working days. This is a FETCH fact: no RC DELIVERIES email was in the mailbox
 * window this run. They are usually true together, and each is true without the other in a
 * case that matters:
 *
 *   - email missing, data current — the Google Sheet pass filled the day in. `stale_stream`
 *     is silent and correct; THIS is the only thing that notices the email pipeline has
 *     stopped. That is why the finding still fires at `missed_working_days = 0`, as `info`.
 *   - email arrived, data stale — MC sent an empty or old workbook. `stale_stream` catches
 *     it; this is silent and correct.
 *
 * So the escalation ladder is deliberately QUIETER than `stale_stream`'s at the low end
 * (`info` where that says `attention`), because when both fire the data-side finding is the
 * one carrying the alarm and this one is carrying the explanation.
 *
 * Severity, the L-042 `awaiting_batch_assignment` ladder verbatim — same thresholds, same
 * reason (a thing that normally self-clears is quiet; a thing that has not self-cleared in
 * four days is not late, it is forgotten):
 *   info      0-1 missed working days
 *   attention 2-3
 *   high      4+
 *
 * Nothing is written and nothing is HELD: no durable case, so there is never anything to
 * close by hand once the report shows up.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * "NOT RECEIVED" MUST NOT MEAN "ALREADY EATEN" (2026-09-03, L-048 part 3)
 * ─────────────────────────────────────────────────────────────────────────────
 * Every primary mailbox query ends `-label:"Blackwood-Processed"`, so the moment one run
 * labels an email, every LATER run on the same day sees an empty mailbox and this note
 * fired as though the sender had gone quiet. Measured: run `cc8c66f9` processed and
 * labeled the day's RC DELIVERIES email at 01:41 UTC; the manual Run Sync `f1e9f342` at
 * 03:13 UTC then reported "No RC DELIVERIES report arrived" about an email that had
 * arrived and been ingested ninety minutes earlier. A finding that cries wolf on every
 * second run of the day is a finding an operator learns to skip — which is precisely how
 * the failure this note exists to catch would get through.
 *
 * The evidence is `ingestion_watermarks`: `last_run_at` is stamped from inside apply, and
 * apply only runs when a source file was present, so a stamp from TODAY means an email was
 * consumed today. `last_email_received_at` is preferred when set (it is the mail's own
 * clock rather than the run's) and falls back to `last_run_at`. "Today" is the run's own
 * ASIA/MANILA calendar date — the plant's day, the same boundary `as_of` uses — because
 * that is the unit an operator means by "this morning's report".
 *
 * It is a DOWNGRADE, never a silence: the note still fires, carrying `already_processed`
 * so the finding can say WHO ate the mail instead of implying nobody sent it. Reporting
 * nothing would re-create the L-044 sentence in a new costume — a run that says nothing is
 * indistinguishable from a run that checked and was satisfied. And when the watermark read
 * FAILS, `already_processed` stays false: an unknown must never quieten an alarm.
 */

import type { LatenessUnknownReason, StreamStatusRead } from "../lib/streamStaleness.js";

/** One report whose source file did not arrive in a run. Mirrors `app/(app)/sync/types.ts::ReportNotReceived`. */
export interface ReportNotReceived {
  /** The `sync_runs.result.reports` key that went without a file, e.g. "deliveries". */
  report_type: string;
  /** Plain-English name of the missing document ("RC DELIVERIES report"). */
  source_label: string;
  /** The `view_digest_stream_status` key this report feeds. */
  stream: string;
  /** The stream's own label from the registry view ("RC In (deliveries)"). */
  stream_label: string;
  /** The Gmail window floor this run searched from (YYYY-MM-DD), so "since when" is exact. */
  since: string;
  /** The latest date the stream has data for. Null if it never has. */
  through_date: string | null;
  /** The operational date the view measured lateness against. */
  operational_date: string | null;
  /**
   * Active working days missed, straight from the view. NULL when the number was not
   * measured — never 0, because 0 means "measured, not late" and a guess must not
   * impersonate a measurement. When it is null, `lateness_unknown_reason` says WHY.
   */
  missed_working_days: number | null;
  /**
   * Why `missed_working_days` is null; null when it is a real measurement. Set because one
   * bare null used to mean "the read failed" AND "no such stream", and the operator's next
   * action differs — the first is the grant failure that blinded the freshness watch for
   * two weeks, the second is a registry gap.
   */
  lateness_unknown_reason: LatenessUnknownReason | null;
  /** True when this stream reports a day behind by design (wording only). */
  reports_next_day: boolean;
  /** The run's Asia/Manila calendar date — what "today" means at the plant. */
  as_of: string;
  /**
   * TRUE when an earlier run on the SAME Manila day already ingested (and labeled) this
   * stream's email — so the empty mailbox is this sync's own doing, not a silent sender.
   * FALSE whenever it could not be established, including when the bookkeeping read
   * failed: an unknown must never quieten an alarm.
   */
  already_processed: boolean;
  /** The timestamp that proved it — `last_email_received_at` if set, else `last_run_at`.
   *  Null when there is no bookkeeping row or it could not be read. */
  last_processed_at: string | null;
  /** The Gmail thread id that run recorded, when there is one. */
  last_processed_email_id: string | null;
}

/**
 * The run's date in ASIA/MANILA (UTC+8, no DST), as YYYY-MM-DD.
 *
 * Manila, not UTC: `runTs` is UTC and a run started after 16:00 UTC is already the next day
 * at the plant. The same reasoning (and the same fixed offset) as
 * `reports/deliveries/apply.ts::daysPendingManila`; kept as its own small function rather
 * than shared because that one returns an AGE and this one returns a DATE, and collapsing
 * them would mean one of the two call sites reading a number it has to reinterpret.
 */
export function manilaDate(runTs: string): string {
  const t = Date.parse(runTs);
  const ms = Number.isFinite(t) ? t : Date.now();
  return new Date(ms + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

/** One `ingestion_watermarks` row, as `DbClient.readIngestionWatermark` returns it. */
export interface IngestionWatermarkRow {
  last_run_at: string | null;
  last_email_id: string | null;
  last_email_received_at: string | null;
}

/**
 * Did an earlier run on the SAME Asia/Manila day already ingest this stream's email?
 *
 * Exported so the rule is testable on its own and stated once. `null`/absent input ⇒
 * `false` — a missing or unreadable bookkeeping row can never be read as "already
 * handled", because that would let a failed read silence the finding.
 */
export function alreadyProcessedToday(
  row: IngestionWatermarkRow | null | undefined,
  asOfManilaDate: string,
): { already: boolean; at: string | null; emailId: string | null } {
  if (!row) return { already: false, at: null, emailId: null };
  // The MAIL's own clock when we have it, else the run's. Both are UTC ISO strings and
  // both are converted through the same Manila shift, so the comparison is like-for-like.
  const at = row.last_email_received_at ?? row.last_run_at ?? null;
  if (!at) return { already: false, at: null, emailId: row.last_email_id ?? null };
  const t = Date.parse(at);
  if (!Number.isFinite(t)) return { already: false, at, emailId: row.last_email_id ?? null };
  const stampedDay = manilaDate(new Date(t).toISOString());
  return {
    already: stampedDay === asOfManilaDate,
    at,
    emailId: row.last_email_id ?? null,
  };
}

/** The ONE constructor. Build a note any other way and the fields below can disagree. */
export function reportNotReceivedNote(args: {
  reportType: string;
  sourceLabel: string;
  stream: string;
  since: string;
  runTs: string;
  /** The `view_digest_stream_status` read for `stream` — the ANSWER, or WHY there isn't one. */
  read: StreamStatusRead;
  /**
   * The stream's `ingestion_watermarks` row, when it could be read. Omitted/null ⇒ the
   * note reports at full volume (see `alreadyProcessedToday`).
   */
  watermarkRow?: IngestionWatermarkRow | null;
}): ReportNotReceived {
  const { status, missedWorkingDays, unknownReason } = args.read;
  const asOf = manilaDate(args.runTs);
  const consumed = alreadyProcessedToday(args.watermarkRow, asOf);
  return {
    report_type: args.reportType,
    source_label: args.sourceLabel,
    stream: args.stream,
    stream_label: status?.label ?? args.sourceLabel,
    since: String(args.since).slice(0, 10),
    through_date: status?.through_date ?? null,
    operational_date: status?.operational_date ?? null,
    // Straight from the read, so the "never 0 unless measured" rule holds in ONE place.
    missed_working_days: missedWorkingDays,
    lateness_unknown_reason: unknownReason,
    reports_next_day: status?.reports_next_day ?? false,
    as_of: asOf,
    already_processed: consumed.already,
    last_processed_at: consumed.at,
    last_processed_email_id: consumed.emailId,
  };
}
