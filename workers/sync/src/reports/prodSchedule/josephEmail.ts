/**
 * josephEmail.ts — guarded IMAP fetch of Joseph Go's latest "PRODUCTION SCHEDULE"
 * email, using the worker's own imapflow client (lib/gmail.ts GmailClient).
 *
 * Port of scripts/joseph-prod-sched.ts::fetchLatestJosephScheduleViaImap, adapted to
 * the worker's GmailClient (which already wraps imapflow + mailparser and knows how to
 * X-GM-RAW search "[Gmail]/All Mail", download the newest xlsx attachment, and log out
 * cleanly). Sender kitz323@yahoo.com; subject contains "PRODUCTION SCHEDULE" OR
 * "PROD SCHED"; the newest email carrying an xlsx wins. Revision label is derived from
 * the subject line (parseJosephRev).
 *
 * SESSION (corrected 2026-07-28, BUG-019): this used to open its OWN short-lived session,
 * on the reasoning that the Mail Clerk's session was already closed by the time the
 * schedule step ran. That reasoning was right about the ORDER and wrong about the COST —
 * combined with the four labelers and the flecon fetcher, which also opened their own, a
 * run reached 7+ IMAP logins and tripped Gmail's ~15 simultaneous-connection cap. It now
 * runs on THE shared session (lib/gmailSession.ts), which `runSync` pins for the whole
 * run, so the Mail Clerk's session is still open when this step arrives.
 *
 * Returns null when no matching email is found. THROWS on connect/auth failure; the
 * caller (refresh.ts) treats ANY throw or null as "Joseph unavailable" and falls back to
 * a Renzo-only refresh — the schedule band must never fail the daily sync.
 */
import { latestXlsx } from "../../lib/gmail.js";
import { withGmailSession, type GmailSessionRunner } from "../../lib/gmailSession.js";
import { parseJosephRev, type JosephRev } from "./parse.js";

const JOSEPH_SENDER = "kitz323@yahoo.com";
/** Gmail X-GM-RAW: sender + either subject phrase + must carry an attachment. */
export const JOSEPH_QUERY =
  `from:${JOSEPH_SENDER} (subject:"PRODUCTION SCHEDULE" OR subject:"PROD SCHED") has:attachment`;

export interface JosephSource {
  buffer: Buffer;
  rev: JosephRev;
  /** human description of where the workbook came from (subject line). */
  origin: string;
}

/**
 * Fetch the latest Joseph schedule workbook over THE shared Gmail session.
 * `runGmail` is injectable so tests can stub the whole IMAP path. Returns null when the
 * search finds no matching xlsx; throws only on a connection/auth failure.
 */
export async function fetchLatestJosephSchedule(
  runGmail: GmailSessionRunner = withGmailSession,
): Promise<JosephSource | null> {
  return runGmail(async (client) => {
    const result = await client.search(JOSEPH_QUERY, {
      outDir: null,
      patterns: ["*.xlsx", "*.xls"],
    });
    const latest = latestXlsx(result);
    if (!latest) return null;
    const subject = latest.email.subject ?? "";
    return {
      buffer: latest.attachment.content,
      rev: parseJosephRev(subject),
      origin: `IMAP "${subject}"`,
    };
  });
}
