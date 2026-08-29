/**
 * mailClerk.ts — the PINNED Mail Clerk (SYNC_TS_MIGRATION_PLAN, Mail-fetching row).
 *
 * ONE Gmail IMAP session downloads all report attachments sequentially, uploads each
 * to Supabase Storage under `<runId>/<report>/<filename>`, and returns a manifest.
 * Per-report workflows then read from Storage (survives crashes; kills the Gmail
 * burst-EOF problem at the source — no more 4 parallel IMAP logins).
 *
 * That session now comes from the SHARED broker (`lib/gmailSession.ts`), not from a
 * client this file constructs: `runSync` pins one lease for the whole run, so the
 * clerk's session is the SAME one the labelers and the flecon fetcher reuse later.
 * Before 2026-07-28 those two — plus the production-schedule fetcher, removed with that
 * feature on 2026-08-28 — opened their own, and a run reached 7+ simultaneous IMAP
 * logins, past Gmail's ~15 cap — see specs/SHARED.md §1.8 (BUG-019).
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
 * TWO deliberate divergences from that verbatim set, both because a query said too little
 * about the DOCUMENT and too much about the PERSON:
 *
 *   1. `GMAIL_CZ` was sender-only, and on 2026-08-17 that let the clerk hand the price
 *      enricher a BANK CHEQUE-REQUISITION workbook (L-044). It now also pins the FILENAME
 *      — see the comment on the `deliveries_czarina` entry.
 *   2. Every `from:` is now the WHOLE ICTC ROSTER, not one person (L-045, 2026-08-29).
 *      Ivy sent MC's Daily Production Report while he was out and the single-sender query
 *      could not see it, so production/electricity/trucks all went stale with the report
 *      sitting in the mailbox. `lib/senderRoster.ts` owns the list; the SUBJECT is what
 *      identifies a report, never who pressed send.
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
import { isGmailConnectionLimit, type FetchedEmail } from "../lib/gmail.js";
import { rosterFrom } from "../lib/senderRoster.js";
import { withGmailSession, describeGmailFailure } from "../lib/gmailSession.js";
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
  /**
   * Attachment-name GLOBS handed to the IMAP part selector (`*.xlsx,*.xls` when absent).
   *
   * This is a DOWNLOAD HINT, not the guard — but it is load-bearing, because
   * `gmail.searchLatestAttachment` materializes the bytes of exactly ONE part: the newest
   * email that has a part MATCHING these globs. Narrow them and the clerk walks back past
   * the wrong workbooks to the right one; leave them wide and the only bytes in memory are
   * whatever arrived last, so a later predicate can reject but never recover. Deliberately
   * LOOSER than `attachmentMatches` (a superset), so the two can never disagree about a
   * file the predicate would accept.
   */
  attachmentPatterns?: string[];
  /**
   * THE GUARD (2026-08-18, L-044). Returns true when this filename is the file this query
   * is actually looking for. When nothing in the window matches, the clerk stores NOTHING
   * — an absent attachment is a state every consumer already handles and reports, whereas
   * the WRONG attachment is indistinguishable from the right one all the way down.
   *
   * Tenant knowledge lives HERE, on the query definition, beside the (already
   * tenant-specific) query string. `pickLatestXlsx` stays generic and knows no filenames.
   */
  attachmentMatches?: (filename: string) => boolean;
}

/**
 * Fold a human-typed attachment name to a comparable form: drop the extension, drop a
 * browser/Gmail "(1)" copy suffix, upper-case, and collapse every run of non-alphanumerics
 * to ONE space. So all four of these fold to `RAW CHARCOAL PURCHASES DAILY`:
 *
 *   "RAW CHARCOAL PURCHASES -Daily.xlsx"   "RAW CHARCOAL PURCHASES -Daily(1).xlsx"
 *   "raw charcoal purchases - daily.xlsx"  "RAW  CHARCOAL   PURCHASES-Daily.XLSX"
 *
 * Generic and tenant-free: it encodes only the ways a FILENAME drifts (case, spacing,
 * punctuation, copy suffix), never what any particular file is called. Same discipline as
 * `czarinaSheet.ts` normalizing a hand-typed WORKSHEET name — L-039 and L-042 are both the
 * same lesson, that a name a human typed is a convention to be folded, not malformed input.
 */
export function normalizeAttachmentName(filename: string): string {
  return String(filename ?? "")
    .replace(/\.[A-Za-z0-9]{1,5}$/, "") // extension
    .replace(/\s*\(\d+\)\s*$/, "") // "(1)" copy suffix
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, " ")
    .trim();
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
 *
 * WHICH QUERIES CAN PICK UP THE WRONG WORKBOOK (audited 2026-08-18, L-044). A query is
 * exposed when its scope does not pin the DOCUMENT — only the sender or the window:
 *
 *   deliveries_czarina  from: ONLY, no subject, no filename  →  EXPOSED. Fixed below.
 *   rc_out_movement     subject:"RC MOVEMENT" newer_than:7d  →  subject-scoped. An email
 *                       whose SUBJECT says RC MOVEMENT carrying some other workbook is not
 *                       a thing that happens; the subject IS the document here.
 *   deliveries          label + subject "RC DELIVERIES"      →  label AND subject-scoped.
 *   rc_out              label + subject "PROPOSED DAILY…"    →  label AND subject-scoped.
 *   production_mc       from + subject "Daily Production…"   →  from AND subject-scoped.
 *   production_waste    from + subject "WASTE PRODUCTION…"   →  from AND subject-scoped.
 *   flecon              from + subject "FLECON BAGGED"       →  from AND subject-scoped.
 *
 * Only ONE of the seven was sender-only, and it is the one that broke. The other six are
 * deliberately left alone: adding a filename predicate to a query that is already pinned to
 * a subject buys nothing and costs a second place for a rename to break the sync silently.
 * If one of them ever becomes sender-only, it inherits this exposure — pin it then.
 *
 * ── THE SENDER IS A ROSTER (2026-08-29, L-045) ────────────────────────────────
 * Every `from:` below is `rosterFrom()` — the whole ICTC roster, never one person. Read
 * the audit above again with that in mind: the four sender-scoped queries were only ever
 * SAFE because of their second predicate, and it is that second predicate that still does
 * the identifying now.
 *
 *   production_mc      subject:"Daily Production Report"  ← identifies the report
 *   production_waste   subject:"WASTE PRODUCTION REPORT"  ← identifies the report
 *   flecon             subject:"FLECON BAGGED"            ← identifies the report
 *   deliveries_czarina attachmentMatches (L-044)          ← identifies the DOCUMENT, and
 *                      is strictly stronger than a subject, because it re-reads the actual
 *                      filename rather than trusting a Gmail operator.
 *
 * `deliveries`, `rc_out` and `rc_out_movement` carry no `from:` at all and never did —
 * they were already immune to who pressed send, and they are untouched.
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
      // ---------------------------------------------------------------------
      // THE PRICE FILE — identified by NAME, not merely by SENDER (2026-08-18, L-044).
      //
      // This query was `from:czarinaloumaximoictc@gmail.com newer_than:5d` and NOTHING
      // else, and `pickLatestXlsx` took the first .xlsx it saw. Czarina sends the office
      // several workbooks; measured over two weeks the sync had used ALL of these as "the
      // price list": `RAW CHARCOAL PURCHASES -Daily(1).xlsx` (correct),
      // `BDO REQUISTION DETAILS & WEEKLY CHECK ISSUANCE (REVISED)-2026.xlsx`,
      // `VAN LOADING FILE.xlsx`, `POWDER ( l. RIVERA).xlsx`.
      //
      // The 2026-08-17 run was holding the BDO CHEQUE-REQUISITION workbook. Its tabs are
      // `August 2026 Requisition Weekly`, `2025 Requisition Weekly`, `August 2026-Weekly
      // Check`, `MAY 2026` … `AUGUST 2026`. So L-039's month resolver found `AUGUST 2026`,
      // was satisfied, and raised NEITHER `price_tab_unresolved` NOR `price_file_unreadable`
      // — then searched a cheque ledger for truckloads, matched zero, and reported nothing,
      // because a row that matches nothing is an ordinary unmatched row. Four truckloads
      // (69,900 kg) went in at ₱0 and the run said "success".
      //
      // THE LESSON, and it generalises past this file: VERIFYING THAT A NAME HAS THE RIGHT
      // SHAPE IS NOT VERIFYING IT IS THE RIGHT THING. L-039 hardened the tab lookup so
      // hard that it happily validated a tab inside the wrong workbook. Nobody checked the
      // workbook.
      //
      // Three layers, each looser than the next, only the innermost authoritative:
      //   1. the Gmail operators below      — a search HINT (Gmail decides what `filename:`
      //                                       means; an operator is not a contract),
      //   2. `attachmentPatterns`           — which part's BYTES get downloaded, so the
      //                                       clerk RECOVERS the right file instead of
      //                                       merely rejecting the wrong one,
      //   3. `attachmentMatches`            — the guard that holds.
      // If all three come up empty the manifest gets NO price file, and the enricher's
      // "no price file" path fires and reports it (`price_file_missing`).
      // ---------------------------------------------------------------------
      // ROSTER (L-045): the price file is identified by its NAME at three layers, so who
      // sent it was never what made this query correct — and a price file forwarded by a
      // colleague while Czarina is out is exactly as plausible as Ivy sending MC's report.
      // Widening `from:` therefore costs nothing here: the predicate that already refuses
      // the BDO / VAN LOADING / POWDER workbooks refuses a roster-mate's daily report for
      // the same reason, and `attachmentPatterns` means a non-price workbook never even has
      // its bytes downloaded. The `newer_than:5d` window and the 50-UID cap are unchanged.
      key: "deliveries_czarina",
      reportType: "deliveries",
      role: "auxiliary",
      query: `${rosterFrom()} has:attachment filename:xlsx newer_than:5d`,
      // Wider than the predicate on purpose: any spacing/punctuation between the words,
      // any suffix, .xls or .xlsx. It only has to be narrow enough to skip the BDO / VAN
      // LOADING / POWDER workbooks when choosing which part to download.
      attachmentPatterns: ["*raw*charcoal*purchase*.xls*"],
      attachmentMatches: (filename) =>
        normalizeAttachmentName(filename).includes("RAW CHARCOAL PURCHASES"),
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
      // ROSTER (L-045): THE query the incident was about. It was pinned to MC alone, so
      // the two reports Ivy sent for him on 2026-08-28/29 were invisible and production,
      // electricity and trucks all went stale at once. The subject is the identifier.
      key: "production_mc",
      reportType: "production",
      role: "primary",
      query: `${rosterFrom()} subject:"Daily Production Report" after:{since} -label:"Blackwood-Processed"`,
    },
    {
      key: "production_waste",
      reportType: "production",
      role: "primary",
      query: `${rosterFrom()} subject:"WASTE PRODUCTION REPORT" after:{since} -label:"Blackwood-Processed"`,
    },
    {
      // Kept byte-identical to `reports/flecon/index.ts`'s own copy by construction —
      // both build the `from:` from the same roster (see that file's GMAIL_QUERY).
      key: "flecon",
      reportType: "flecon",
      role: "primary",
      query: `${rosterFrom()} subject:"FLECON BAGGED" after:{since} -label:"Blackwood-Processed"`,
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

/**
 * A Gmail search that took longer than `GMAIL_SEARCH_BUDGET_MS` (BUG-026, 2026-08-19).
 *
 * On 2026-08-19 the RC DELIVERIES search took **58 s** where it had taken 4–7 s on every
 * earlier run that day, on the identical build. Gmail was slow; nothing was broken. But a
 * slow run and a hung run look identical from the panel, and the operator — reasonably —
 * read it as a hang, pressed Stop, then pressed Run again, which put two IMAP sessions on
 * the account and made the next run slower still.
 *
 * So slowness is now RECORDED rather than merely endured: the day itself is the fact, and
 * "the sync took 12 minutes on the 19th" needs to be answerable a week later from the
 * Excel report, not reconstructed from progress beats nobody kept.
 *
 * Carries no ₱ and no row data — a query name, a Gmail query string and two durations.
 */
export interface SlowGmailSearch {
  /** The MailQuery.key, e.g. "deliveries", "deliveries_czarina". */
  key: string;
  /** Plain-English report label, e.g. "RC DELIVERIES". */
  label: string;
  /** The Gmail X-GM-RAW query as actually issued ({since} already substituted). */
  query: string;
  /** How long the search actually took. */
  elapsed_ms: number;
  /** The budget it exceeded, so a later reader knows what "slow" meant that day. */
  budget_ms: number;
}

export interface MailClerkManifest {
  runId: string;
  since: string;
  /** key -> stored attachments (latest xlsx per query). */
  reports: Record<string, StoredAttachment[]>;
  /**
   * Per-query email metadata (even when no attachment matched).
   *
   * `sender` is THE ACTUAL ENVELOPE SENDER, verbatim (2026-08-29, L-045) — the roster
   * widened what the clerk LOOKS for, and this is what keeps that from laundering a fact:
   * a Daily Production Report Ivy sent while MC was out reads as Ivy here, never as MC.
   * Nothing branches on it; it exists so "who actually filed this?" is answerable from the
   * run rather than reconstructed from a mailbox weeks later. Optional, so a manifest
   * written by an older build still parses.
   */
  emailMeta: Record<
    string,
    {
      uid: number;
      subject: string;
      date: string | null;
      hadAttachment: boolean;
      sender?: string;
    }[]
  >;
  /**
   * Searches that blew the budget. OMITTED (not `[]`) on a normal run, so a healthy
   * manifest keeps byte-identical shape — the same discipline as `stale_stream_check`.
   */
  slowSearches?: SlowGmailSearch[];
}

export interface MailClerkParams {
  runId: string;
  /** Gmail-date form YYYY/MM/DD used to substitute {since} in the primary queries. */
  since: string;
  /** If true, do NOT upload to Storage — return the manifest with in-memory sizes
   *  only (used by the M1 live read-only test so it never mutates Storage/Gmail). */
  dryRun?: boolean;
  /** Override the per-search budget (tests only). Production uses GMAIL_SEARCH_BUDGET_MS. */
  searchBudgetMs?: number;
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

/**
 * How long ONE Gmail search may take before the run says so out loud (BUG-026).
 *
 * 45 s, chosen against the measured record: the same searches ran in 4–7 s all day on
 * 2026-08-19 and the one that triggered the incident took 58 s. So this fires on a genuine
 * outlier and stays quiet on an ordinary slow day.
 *
 * **It is a REPORTING threshold, never an abort.** Gmail slow is not Gmail broken, and a
 * budget that killed the search would turn a slow morning into a failed sync — the socket
 * timeout (`lib/gmail.ts`, 5 min) remains the only thing that ends a true hang.
 */
export const GMAIL_SEARCH_BUDGET_MS = 45_000;

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
    () => fetchAllOverOneSession(params.since, onProgress, { searchBudgetMs: params.searchBudgetMs }),
    { name: "gmailFetchAllOneSession" }
  );
  // Only ever SET when something was actually slow — a healthy manifest keeps the shape it
  // has always had, so nothing downstream has to distinguish "fast" from "old manifest".
  if (fetched.slowSearches.length > 0) manifest.slowSearches = fetched.slowSearches;

  // Upload step(s): one per (query, attachment). Storage upsert is idempotent.
  const sb = params.dryRun ? null : storageClient();

  for (const q of mailQueries()) {
    const res = fetched.results[q.key];
    manifest.emailMeta[q.key] = (res?.emails ?? []).map((e) => ({
      uid: e.uid,
      subject: e.subject,
      date: e.date,
      hadAttachment: e.hasMatchingAttachment ?? e.attachments.length > 0,
      // Verbatim — never normalised to "whose report this is" (L-045).
      sender: e.sender,
    }));

    const latest = pickLatestXlsx(res?.emails ?? [], q.attachmentMatches);
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
  onProgress?: MailClerkProgress,
  opts: { searchBudgetMs?: number } = {}
): Promise<{
  results: Record<string, { query: string; emails: FetchedEmail[] }>;
  slowSearches: SlowGmailSearch[];
}> {
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

  const out: Record<string, { query: string; emails: FetchedEmail[] }> = {};
  const slowSearches: SlowGmailSearch[] = [];
  const budgetMs = opts.searchBudgetMs ?? GMAIL_SEARCH_BUDGET_MS;
  const queries = mailQueries();
  const total = queries.length;

  await emit("Connecting to Gmail…", FETCH_PCT_START);
  // ONE session for every query — and, because runSync pins a run-lease around the whole
  // run, the SAME session the labelers/fetchers reuse later (BUG-019). The broker owns
  // connect/close; this function never opens or closes a socket itself.
  try {
    return await withGmailSession(async (gmail) => {
      let done = 0;
      // Honest pct: FETCH_PCT_START at connect, climbing to FETCH_PCT_END as reports land.
      const pctFor = (completed: number) =>
        FETCH_PCT_START +
        Math.round((FETCH_PCT_END - FETCH_PCT_START) * (completed / total));

      for (const q of queries) {
        const query = q.query.replace("{since}", since);
        const label = reportLabel(q.key);
        await emit(`Looking for ${label}…`, pctFor(done));

        // The query's own download hint, when it has one. `searchLatestAttachment`
        // materializes exactly ONE part — the newest email carrying a part that matches
        // these — so a narrowed list is what lets the clerk walk back past a newer,
        // unrelated workbook and still come home with the right file.
        const patterns = q.attachmentPatterns ?? ["*.xlsx", "*.xls"];

        // ── SEARCH BUDGET (BUG-026). A timer that only ever SPEAKS: it fires WHILE the
        // search is still running, because the whole point is to reach the operator
        // during the wait rather than to explain it afterwards. It never aborts — Gmail
        // slow is not Gmail broken, and `lib/gmail.ts`'s socket timeout still owns a
        // true hang. On 2026-08-19 this beat is the sentence that would have kept a
        // 58-second search from being read as a hang and answered with Stop-then-Run.
        const searchStartedAt = Date.now();
        const budgetTimer = setTimeout(() => {
          void emit(
            `Gmail is slow today — the ${label} search has taken ` +
              `${Math.round(budgetMs / 1000)} s and is still running. Nothing is wrong; it will finish.`,
            pctFor(done),
            query,
            "warn",
          );
        }, budgetMs);
        budgetTimer.unref?.();

        let emails: FetchedEmail[];
        try {
          try {
            // FAST path — metadata-first, download only the newest matching xlsx part.
            const res = await gmail.searchLatestAttachment(query, { patterns });
            emails = res.emails;
          } catch (err) {
            // The slow fallback exists for per-message STRUCTURE/PART edge cases. A
            // connection-level refusal (the Gmail cap) is NOT one of those — retrying it
            // on a refused/dead session just burns another command, so let it out.
            if (isGmailConnectionLimit(err)) throw err;
            // Fallback for THIS report — full-source parse (slower but robust). SAME
            // patterns: a fallback that widens the filter would hand back a file the fast
            // path would have refused, i.e. exactly the bug, only intermittent.
            await emit(`Retrying ${label} the slow way…`, pctFor(done), undefined, "warn");
            const res = await gmail.search(query, { outDir: null, patterns });
            emails = res.emails;
          }
        } finally {
          clearTimeout(budgetTimer);
        }
        // The elapsed figure is taken AFTER the fallback, so a query that needed the slow
        // path is judged on what it actually cost the run, not on its first attempt.
        const elapsedMs = Date.now() - searchStartedAt;
        if (elapsedMs >= budgetMs) {
          slowSearches.push({ key: q.key, label, query, elapsed_ms: elapsedMs, budget_ms: budgetMs });
          await emit(
            `${label} took ${(elapsedMs / 1000).toFixed(1)} s to find — slower than usual.`,
            pctFor(done),
            query,
            "warn",
          );
        }
        out[q.key] = { query, emails };

        // Report what we found (real filename + size from the chosen attachment).
        const latest = pickLatestXlsx(emails, q.attachmentMatches);
        if (latest) {
          await emit(
            `Found ${label} (${humanSize(latest.attachment.sizeBytes)})`,
            pctFor(done),
            latest.attachment.filename
          );
        } else if (q.attachmentMatches) {
          // The predicate rejected everything. If spreadsheets DID arrive, name them —
          // this beat is the one that would have read "using BDO REQUISTION DETAILS…"
          // out loud on 2026-08-17 instead of nothing at all.
          const seen = spreadsheetNames(emails);
          if (seen.length) {
            await emit(
              `No ${label} in the mailbox window — ${seen.length} other workbook(s) from ` +
                `this sender were skipped because they are not that file.`,
              pctFor(done),
              seen.join(", "),
              "warn"
            );
          }
        }
        done += 1;
        await emit(`Downloaded ${done} of ${total} reports…`, pctFor(done));
      }
      return { results: out, slowSearches };
    });
  } catch (err) {
    // OBSERVABILITY (BUG-019 Fix 4): the whole run is about to fail on this. Emit the
    // SERVER'S OWN diagnosis as a plain-English warn beat — an operator must read
    // "Gmail connection limit hit — wait and retry", never "Command failed".
    const detail = describeGmailFailure(err);
    await emit(
      isGmailConnectionLimit(err)
        ? "Gmail refused the connection — too many are open right now. Wait a few minutes and run the sync again."
        : "Couldn't read the mailbox this run.",
      FETCH_PCT_START,
      detail,
      "warn"
    );
    throw err;
  }
}

/**
 * Newest-first, the first spreadsheet attachment that PASSES `matches`.
 *
 * Stays GENERIC — it knows "is a spreadsheet" and nothing else. Every filename a query
 * cares about is expressed by that query's own `attachmentMatches`, so this function can
 * never grow a tenant's document names (see the MailQuery doc). With no predicate the
 * behaviour is byte-identical to what it always was.
 */
function pickLatestXlsx(
  emails: FetchedEmail[],
  matches?: (filename: string) => boolean
): { attachment: FetchedEmail["attachments"][number]; email: FetchedEmail } | null {
  for (let i = emails.length - 1; i >= 0; i--) {
    const em = emails[i];
    for (const att of em.attachments) {
      const n = att.filename.toLowerCase();
      if (!n.endsWith(".xlsx") && !n.endsWith(".xls")) continue;
      if (matches && !matches(att.filename)) continue;
      return { attachment: att, email: em };
    }
  }
  return null;
}

/**
 * Every spreadsheet filename the fetch actually saw for a query, newest first.
 *
 * Only used to SAY what was there when the predicate rejected everything. "No price file
 * arrived" and "four workbooks arrived and none of them was the price file" are different
 * problems with different fixes, and the difference is exactly what nobody could see for
 * the two weeks the sync was reading a cheque ledger.
 */
function spreadsheetNames(emails: FetchedEmail[]): string[] {
  const out: string[] = [];
  for (let i = emails.length - 1; i >= 0; i--) {
    for (const att of emails[i].attachments) {
      const n = att.filename.toLowerCase();
      if (n.endsWith(".xlsx") || n.endsWith(".xls")) out.push(att.filename);
    }
  }
  return out;
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
  const fetched = await fetchAllOverOneSession(params.since, onProgress, {
    searchBudgetMs: params.searchBudgetMs,
  });
  if (fetched.slowSearches.length > 0) manifest.slowSearches = fetched.slowSearches;
  const sb = params.dryRun ? null : storageClient();

  for (const q of mailQueries()) {
    const res = fetched.results[q.key];
    manifest.emailMeta[q.key] = (res?.emails ?? []).map((e) => ({
      uid: e.uid,
      subject: e.subject,
      date: e.date,
      hadAttachment: e.hasMatchingAttachment ?? e.attachments.length > 0,
      // Verbatim — never normalised to "whose report this is" (L-045).
      sender: e.sender,
    }));

    const latest = pickLatestXlsx(res?.emails ?? [], q.attachmentMatches);
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
