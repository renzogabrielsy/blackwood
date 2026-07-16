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
 * This opens its own short-lived session. The Mail Clerk's single session (Stage 1) is
 * already closed by the time the schedule step runs, so this is a fresh guarded login —
 * exactly what the verified root script does. One extra sequential login (NOT four
 * parallel ones) does not reintroduce the Gmail burst-EOF problem the Mail Clerk solved.
 *
 * Returns null when no matching email is found. THROWS on connect/auth failure; the
 * caller (refresh.ts) treats ANY throw or null as "Joseph unavailable" and falls back to
 * a Renzo-only refresh — the schedule band must never fail the daily sync.
 */
import { GmailClient, latestXlsx } from "../../lib/gmail.js";
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
 * Fetch the latest Joseph schedule workbook over a fresh guarded Gmail session.
 * `clientFactory` is injectable so tests can stub the whole IMAP path. Returns null
 * when the search finds no matching xlsx; throws only on a connection/auth failure.
 */
export async function fetchLatestJosephSchedule(
  clientFactory: () => GmailClient = () => GmailClient.fromEnv(),
): Promise<JosephSource | null> {
  const client = clientFactory();
  await client.connect();
  try {
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
  } finally {
    await client.close();
  }
}
