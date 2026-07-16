/**
 * mailClerk.ts — the PINNED Mail Clerk (SYNC_TS_MIGRATION_PLAN, Mail-fetching row).
 *
 * ONE Gmail IMAP session downloads all report attachments sequentially, uploads each
 * to Supabase Storage under `<runId>/<report>/<filename>`, and returns a manifest.
 * Per-report workflows then read from Storage (survives crashes; kills the Gmail
 * burst-EOF problem at the source — no more 4 parallel IMAP logins).
 *
 * The Gmail queries are copied VERBATIM from the Python orchestrators (read as spec):
 *   sync_deliveries.py : GMAIL_OP  label:"Work/ICTC Daily" subject:"RC DELIVERIES" after:{since} -label:"Blackwood-Processed"
 *                        GMAIL_CZ  from:czarinaloumaximoictc@gmail.com newer_than:5d   (price enrichment)
 *   sync_rc_out.py     : GMAIL_PROP label:"Work/ICTC Daily" subject:"PROPOSED DAILY REPORT" after:{since} -label:"Blackwood-Processed"
 *                        GMAIL_RCM  subject:"RC MOVEMENT" newer_than:7d -in:sent        (reconcile cross-check)
 *   sync_production.py : GMAIL_MC   from:mccontinedo.ictc@gmail.com subject:"Daily Production Report" after:{since} -label:"Blackwood-Processed"
 *                        GMAIL_IVY  from:edilloivymae306ictc@gmail.com subject:"WASTE PRODUCTION REPORT" after:{since} -label:"Blackwood-Processed"
 *   sync_flecon.py     : GMAIL     from:edilloivymae306ictc@gmail.com subject:"FLECON BAGGED" after:{since} -label:"Blackwood-Processed"
 *
 * `{since}` is the DATA watermark (MAX(transaction_date)) minus a lookback, computed
 * per report by the per-report workflows in M3. For the Mail Clerk (M1) the caller
 * supplies a `since` (YYYY/MM/DD Gmail-date form) so the clerk is a pure fetcher.
 *
 * This is a DBOS workflow: the single fetch is ONE step (so a crash after upload
 * doesn't re-download), and each upload is its own step. On a mid-run crash, DBOS
 * resumes from the last completed upload.
 */
import { DBOS } from "../dbos.js";
import { GmailClient, type FetchedEmail } from "../lib/gmail.js";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { DbClient } from "../lib/db.js";
import { makeEmitter } from "../lib/progress.js";

export const SYNC_INBOX_BUCKET = "sync-inbox";

/** A single Gmail query that feeds a report type. */
export interface MailQuery {
  /** Storage sub-key + manifest key, e.g. "deliveries", "deliveries_czarina". */
  key: string;
  /** The report type this attachment belongs to. */
  reportType: ReportType;
  /** Gmail X-GM-RAW query. `{since}` is substituted from params.since. */
  query: string;
  /** Whether this is the primary source or an auxiliary (price/reconcile) file. */
  role: "primary" | "auxiliary";
}

export type ReportType =
  | "deliveries"
  | "rc_out"
  | "production"
  | "flecon";

/**
 * The canonical query set — VERBATIM from the Python orchestrators. Auxiliary
 * queries (Czarina price, RC MOVEMENT) use their own time windows (newer_than) and
 * do NOT take {since}.
 */
export function mailQueries(): MailQuery[] {
  return [
    {
      key: "deliveries",
      reportType: "deliveries",
      role: "primary",
      query:
        'label:"Work/ICTC Daily" subject:"RC DELIVERIES" after:{since} -label:"Blackwood-Processed"',
    },
    {
      key: "deliveries_czarina",
      reportType: "deliveries",
      role: "auxiliary",
      query: "from:czarinaloumaximoictc@gmail.com newer_than:5d",
    },
    {
      key: "rc_out",
      reportType: "rc_out",
      role: "primary",
      query:
        'label:"Work/ICTC Daily" subject:"PROPOSED DAILY REPORT" after:{since} -label:"Blackwood-Processed"',
    },
    {
      key: "rc_out_movement",
      reportType: "rc_out",
      role: "auxiliary",
      query: 'subject:"RC MOVEMENT" newer_than:7d -in:sent',
    },
    {
      key: "production_mc",
      reportType: "production",
      role: "primary",
      query:
        'from:mccontinedo.ictc@gmail.com subject:"Daily Production Report" after:{since} -label:"Blackwood-Processed"',
    },
    {
      key: "production_waste",
      reportType: "production",
      role: "primary",
      query:
        'from:edilloivymae306ictc@gmail.com subject:"WASTE PRODUCTION REPORT" after:{since} -label:"Blackwood-Processed"',
    },
    {
      key: "flecon",
      reportType: "flecon",
      role: "primary",
      query:
        'from:edilloivymae306ictc@gmail.com subject:"FLECON BAGGED" after:{since} -label:"Blackwood-Processed"',
    },
  ];
}

export interface StoredAttachment {
  storagePath: string; // "<runId>/<key>/<filename>"
  filename: string;
  sizeBytes: number;
  emailUid: number;
  emailSubject: string;
  emailDate: string | null;
  threadId: string | null;
}

export interface MailClerkManifest {
  runId: string;
  since: string;
  /** key -> stored attachments (latest xlsx per query). */
  reports: Record<string, StoredAttachment[]>;
  /** Per-query email metadata (even when no attachment matched). */
  emailMeta: Record<
    string,
    { uid: number; subject: string; date: string | null; hadAttachment: boolean }[]
  >;
}

export interface MailClerkParams {
  runId: string;
  /** Gmail-date form YYYY/MM/DD used to substitute {since} in the primary queries. */
  since: string;
  /** If true, do NOT upload to Storage — return the manifest with in-memory sizes
   *  only (used by the M1 live read-only test so it never mutates Storage/Gmail). */
  dryRun?: boolean;
}

/**
 * Live progress sink threaded INTO the fetch so the user sees continuous movement
 * across the fetch stage (roughly pct 3→25 of the whole run; per-report classify/apply
 * own 25→100 later). Same shape as lib/progress.ProgressEmitter. It is a SIDE EFFECT
 * (writes a sync_run_events row) — safe to call inside the DBOS fetch step, never a
 * step result. Must NEVER throw into the fetch (the emitter already swallows).
 */
export type MailClerkProgress = (
  stage: "fetch",
  label: string,
  pct: number,
  detail?: string,
  level?: "info" | "warn"
) => Promise<void>;

// The fetch owns this slice of the overall run's progress bar. mailClerkBody emits
// pct 3 (fetchStart) before this; the per-report stages take over from ~25 onward.
const FETCH_PCT_START = 4;
const FETCH_PCT_END = 25;

/** Human-friendly report label for a MailQuery.key (plain English, no IMAP chatter). */
function reportLabel(key: string): string {
  switch (key) {
    case "deliveries":
      return "RC DELIVERIES";
    case "deliveries_czarina":
      return "Czarina price sheet";
    case "rc_out":
      return "PROPOSED DAILY REPORT";
    case "rc_out_movement":
      return "RC MOVEMENT";
    case "production_mc":
      return "Daily Production Report";
    case "production_waste":
      return "WASTE PRODUCTION REPORT";
    case "flecon":
      return "FLECON BAGGED";
    default:
      return key;
  }
}

/** Bytes → a compact human size like "87 KB" / "1.2 MB". */
function humanSize(bytes: number): string {
  if (!bytes || bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${Math.round(kb)} KB`;
  return `${(kb / 1024).toFixed(1)} MB`;
}

function storageClient(): SupabaseClient {
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error("Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY for Storage upload");
  }
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/**
 * The Mail Clerk body. ONE Gmail session for all queries. Runs as a DBOS step so a
 * crash mid-fetch resumes cleanly (re-runs the whole fetch — fetching is read-only
 * and idempotent; only the uploads mutate Storage, and Storage upsert is idempotent).
 */
async function mailClerkBody(params: MailClerkParams): Promise<MailClerkManifest> {
  const manifest: MailClerkManifest = {
    runId: params.runId,
    since: params.since,
    reports: {},
    emailMeta: {},
  };

  // Live progress DURING the fetch (side effect — writes sync_run_events, never a
  // step result). On a dry run there's no run row to attach to, so skip the emitter.
  // makeEmitter's own guards keep pct monotonic and swallow any write error.
  const onProgress: MailClerkProgress | undefined = params.dryRun
    ? undefined
    : (() => {
        const db = DbClient.fromEnv();
        const emit = makeEmitter(db, params.runId, "_run");
        return (stage, label, pct, detail, level) => emit(stage, label, pct, detail, level);
      })();

  // ONE step: fetch every query's attachments over a SINGLE IMAP session. Progress
  // events emitted inside are side effects, not part of the step's memoized result —
  // a crash re-runs the whole (read-only) fetch and re-emits, which is fine.
  const fetched = await DBOS.runStep(
    () => fetchAllOverOneSession(params.since, onProgress),
    { name: "gmailFetchAllOneSession" }
  );

  // Upload step(s): one per (query, attachment). Storage upsert is idempotent.
  const sb = params.dryRun ? null : storageClient();

  for (const q of mailQueries()) {
    const res = fetched[q.key];
    manifest.emailMeta[q.key] = (res?.emails ?? []).map((e) => ({
      uid: e.uid,
      subject: e.subject,
      date: e.date,
      hadAttachment: e.hasMatchingAttachment ?? e.attachments.length > 0,
    }));

    const latest = pickLatestXlsx(res?.emails ?? []);
    if (!latest) {
      manifest.reports[q.key] = [];
      continue;
    }

    const storagePath = `${params.runId}/${q.key}/${latest.attachment.filename}`;
    if (sb) {
      await DBOS.runStep(
        () => uploadToStorage(sb, storagePath, latest.attachment.content, latest.attachment.mimeType),
        { name: `upload:${q.key}` }
      );
    }
    manifest.reports[q.key] = [
      {
        storagePath,
        filename: latest.attachment.filename,
        sizeBytes: latest.attachment.sizeBytes,
        emailUid: latest.email.uid,
        emailSubject: latest.email.subject,
        emailDate: latest.email.date,
        threadId: latest.email.threadId,
      },
    ];
  }

  return manifest;
}

/**
 * Fetch every query's matching emails+attachments over ONE Gmail session. Returns a
 * map keyed by MailQuery.key. This is the single point that touches Gmail — read-only
 * (never labels). Attachments are held in memory (Buffers) and uploaded by the caller.
 *
 * Emits live progress via `onProgress` as it goes (connect → per report: looking →
 * found+downloading → downloaded N of M), so the UI moves during the whole fetch
 * instead of freezing on "Checking Gmail…". pct climbs HONESTLY from FETCH_PCT_START
 * toward FETCH_PCT_END keyed off the completed-report count.
 *
 * Speed: each report is fetched attachment-part-only (searchLatestAttachment) — just
 * the newest xlsx part, not the full rfc822 source. If that path throws for one report
 * (a structure/part edge case), it falls back to the full-source `search` for THAT
 * report only and flags it `warn` — correctness beats speed.
 */
async function fetchAllOverOneSession(
  since: string,
  onProgress?: MailClerkProgress
): Promise<Record<string, { query: string; emails: FetchedEmail[] }>> {
  const emit = async (
    label: string,
    pct: number,
    detail?: string,
    level: "info" | "warn" = "info"
  ) => {
    if (!onProgress) return;
    try {
      await onProgress("fetch", label, pct, detail, level);
    } catch {
      /* progress is observational — never break the fetch */
    }
  };

  const gmail = GmailClient.fromEnv();
  const out: Record<string, { query: string; emails: FetchedEmail[] }> = {};
  const queries = mailQueries();
  const total = queries.length;

  await emit("Connecting to Gmail…", FETCH_PCT_START);
  await gmail.connect();
  try {
    let done = 0;
    // Honest pct: FETCH_PCT_START at connect, climbing to FETCH_PCT_END as reports land.
    const pctFor = (completed: number) =>
      FETCH_PCT_START +
      Math.round((FETCH_PCT_END - FETCH_PCT_START) * (completed / total));

    for (const q of queries) {
      const query = q.query.replace("{since}", since);
      const label = reportLabel(q.key);
      await emit(`Looking for ${label}…`, pctFor(done));

      let emails: FetchedEmail[];
      try {
        // FAST path — metadata-first, download only the newest xlsx part.
        const res = await gmail.searchLatestAttachment(query, {
          patterns: ["*.xlsx", "*.xls"],
        });
        emails = res.emails;
      } catch {
        // Fallback for THIS report — full-source parse (slower but robust).
        await emit(`Retrying ${label} the slow way…`, pctFor(done), undefined, "warn");
        const res = await gmail.search(query, {
          outDir: null,
          patterns: ["*.xlsx", "*.xls"],
        });
        emails = res.emails;
      }
      out[q.key] = { query, emails };

      // Report what we found (real filename + size from the chosen attachment).
      const latest = pickLatestXlsx(emails);
      if (latest) {
        await emit(
          `Found ${label} (${humanSize(latest.attachment.sizeBytes)})`,
          pctFor(done),
          latest.attachment.filename
        );
      }
      done += 1;
      await emit(`Downloaded ${done} of ${total} reports…`, pctFor(done));
    }
  } finally {
    await gmail.close();
  }
  return out;
}

function pickLatestXlsx(
  emails: FetchedEmail[]
): { attachment: FetchedEmail["attachments"][number]; email: FetchedEmail } | null {
  for (let i = emails.length - 1; i >= 0; i--) {
    const em = emails[i];
    for (const att of em.attachments) {
      const n = att.filename.toLowerCase();
      if (n.endsWith(".xlsx") || n.endsWith(".xls")) return { attachment: att, email: em };
    }
  }
  return null;
}

async function uploadToStorage(
  sb: SupabaseClient,
  path: string,
  content: Buffer,
  contentType: string
): Promise<void> {
  const { error } = await sb.storage.from(SYNC_INBOX_BUCKET).upload(path, content, {
    contentType:
      contentType ||
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    upsert: true, // idempotent on retry
  });
  if (error) {
    throw new Error(`Storage upload ${path} failed: ${error.message}`);
  }
}

export const mailClerkWorkflow = DBOS.registerWorkflow(mailClerkBody, {
  name: "mailClerkWorkflow",
});

/**
 * DBOS-FREE Mail Clerk for the M1 live read-only test and any non-durable caller.
 * Runs the SAME single-session fetch + manifest build as mailClerkBody, but without
 * DBOS.runStep wrapping (so it needs no launched DBOS runtime). When dryRun is
 * false it still uploads to Storage. Read-only when dryRun is true.
 */
export async function runMailClerk(
  params: MailClerkParams,
  onProgress?: MailClerkProgress
): Promise<MailClerkManifest> {
  const manifest: MailClerkManifest = {
    runId: params.runId,
    since: params.since,
    reports: {},
    emailMeta: {},
  };
  const fetched = await fetchAllOverOneSession(params.since, onProgress);
  const sb = params.dryRun ? null : storageClient();

  for (const q of mailQueries()) {
    const res = fetched[q.key];
    manifest.emailMeta[q.key] = (res?.emails ?? []).map((e) => ({
      uid: e.uid,
      subject: e.subject,
      date: e.date,
      hadAttachment: e.hasMatchingAttachment ?? e.attachments.length > 0,
    }));

    const latest = pickLatestXlsx(res?.emails ?? []);
    if (!latest) {
      manifest.reports[q.key] = [];
      continue;
    }
    const storagePath = `${params.runId}/${q.key}/${latest.attachment.filename}`;
    if (sb) {
      await uploadToStorage(
        sb,
        storagePath,
        latest.attachment.content,
        latest.attachment.mimeType
      );
    }
    manifest.reports[q.key] = [
      {
        storagePath,
        filename: latest.attachment.filename,
        sizeBytes: latest.attachment.sizeBytes,
        emailUid: latest.email.uid,
        emailSubject: latest.email.subject,
        emailDate: latest.email.date,
        threadId: latest.email.threadId,
      },
    ];
  }
  return manifest;
}

/** Direct (non-DBOS) invocation for the M1 live read-only test. */
export { runMailClerk as _mailClerkBodyForTest };
