/**
 * reportDeps.ts — the workflow-layer ADAPTERS that wire each report's own `deps`
 * type from shared building blocks (Wave 4A). This is the ONE place tenant reports
 * meet the durable worker's IO. It NEVER reshapes a report — it only adapts:
 *
 *   - db:        the live DbClient (or, in dryRun, a WRITE-BLOCKING proxy that passes
 *                reads through and no-ops every mutation — insert/update/audit/etc.).
 *   - progress:  a lib/progress emitter bound to (runId, reportType).
 *   - fetch a workbook to a local tmp path:  download from the Storage manifest OR
 *                (flecon) re-fetch the latest xlsx over Gmail to tmp.
 *   - labeler:   a Gmail X-GM-LABELS labeler (no-op in dryRun).
 *
 * The six reports settled on three deps shapes; each builder below produces exactly
 * the shape that report's `runReport` declares (flecon set the idiom; deliveries /
 * rc_out / production / rc_movement_audit followed; gsheet downloads itself).
 *
 * DRY-RUN CONTRACT (the run's `dryRun` flag): classify-only — no applies, no
 * labeling, no watermark writes. We honour it by (a) swapping in the write-blocking
 * db proxy so every apply mutation is a no-op, and (b) making the labeler a no-op.
 * The report's real classify still runs against live data, so the classify envelope
 * in the result is authoritative and identical to a real run's.
 */
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import { DbClient, type Row, type ReadRowsOptions, type InsertIfAbsentResult } from "../lib/db.js";
import { withGmailSession, type GmailSessionRunner } from "../lib/gmailSession.js";
import { makeEmitter, type ProgressEmitter } from "../lib/progress.js";
import { SYNC_INBOX_BUCKET } from "./mailClerk.js";

// ---------------------------------------------------------------------------
// Storage → local tmp downloader (shared by every report that reads a manifest file).
// ---------------------------------------------------------------------------
function storageClient(): SupabaseClient {
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error("Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY for Storage download");
  }
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

/** Download a stored attachment (sync-inbox/<path>) to a fresh tmp file; return its path. */
export function makeStorageFetcher(): (storagePath: string) => Promise<string> {
  const sb = storageClient();
  return async (storagePath: string): Promise<string> => {
    const { data, error } = await sb.storage.from(SYNC_INBOX_BUCKET).download(storagePath);
    if (error || !data) {
      throw new Error(`Storage download ${storagePath} failed: ${error?.message ?? "no data"}`);
    }
    const bytes = Buffer.from(await data.arrayBuffer());
    const dir = await mkdtemp(join(tmpdir(), "bw-sync-"));
    const base = storagePath.split("/").pop() || "workbook.xlsx";
    const local = join(dir, base);
    await writeFile(local, bytes);
    return local;
  };
}

// ---------------------------------------------------------------------------
// Write-blocking DB proxy for dryRun. Reads pass through the real DbClient; every
// mutation is a benign no-op so a report's apply phase runs to completion WITHOUT
// touching the database (no inserts, no updates, no audit rows, no watermark writes,
// no REPLACE-BY-DATE deletes). This keeps the reports' apply code path exercised end
// to end while proving "nothing was written" — the classify envelope is unaffected.
// ---------------------------------------------------------------------------
export function makeDryRunDb(real: DbClient): DbClient {
  const proxy = Object.create(DbClient.prototype) as DbClient;

  // Reads — delegate to the real client.
  const read = <A extends unknown[], R>(fn: (...a: A) => R) => (...a: A): R => fn.apply(real, a);
  Object.assign(proxy, {
    sb: real.sb,
    readRows: read((...a: [string, ReadRowsOptions?]) => real.readRows(...a)),
    selectOne: read((...a: [string, Record<string, string>, string?]) => real.selectOne(...a)),
    dataWatermark: read((...a: [string, string?]) => real.dataWatermark(...a)),
    productionRunsFrontier: read(() => real.productionRunsFrontier()),
    // Progress events are observational, not data mutations — let them flow so the
    // live feed still streams during a dry run.
    insertProgressEvent: read((...a: [Parameters<DbClient["insertProgressEvent"]>[0]]) =>
      real.insertProgressEvent(...a)),

    // sync_runs lifecycle — the workflow drives these directly on the REAL client,
    // never through a report's db handle, so proxying them read-through is harmless.
    setSyncRunStatus: read((...a: Parameters<DbClient["setSyncRunStatus"]>) => real.setSyncRunStatus(...a)),
    finishSyncRun: read((...a: Parameters<DbClient["finishSyncRun"]>) => real.finishSyncRun(...a)),
    createSyncRun: read((...a: Parameters<DbClient["createSyncRun"]>) => real.createSyncRun(...a)),

    // Mutations — no-op with benign return shapes matching the real signatures.
    insert: async (_table: string, _rows: Row[]): Promise<Row[]> => [],
    update: async (_table: string, _filters: Record<string, string>, _patch: Row): Promise<Row[]> => [],
    deleteByDate: async (_table: string, _date: string): Promise<void> => {},
    // flecon's ATOMIC replace-by-date RPC. MUST be listed here: an unassigned method
    // would fall through to DbClient.prototype (this proxy is Object.create'd from it)
    // and hit the REAL Supabase client with `sb` — writing during a "dry" run.
    replaceFleconDate: async (
      _date: string,
      _rows: Row[]
    ): Promise<{ deleted: number; deletedFirstId: string | null; inserted: number; firstId: string | null }> => ({
      deleted: 0,
      deletedFirstId: null,
      inserted: 0,
      firstId: null,
    }),
    // flecon's DATE-SETTLEMENT LEDGER writer (2026-07-29). Same prototype fall-through
    // hazard as replaceFleconDate above: unlisted → the real service-role write runs.
    // A dry run must not durably settle a date (settling is permanent protection).
    insertFleconSettlements: async (
      rows: Array<Record<string, unknown>>
    ): Promise<{ insertedCount: number; insertedDates: string[]; skippedCount: number }> => ({
      insertedCount: 0,
      insertedDates: [],
      skippedCount: rows.length,
    }),
    insertIfAbsent: async (_table: string, rows: Row[], _nk: string[]): Promise<InsertIfAbsentResult> => ({
      inserted: [],
      skipped: rows,
      insertedCount: 0,
      skippedCount: rows.length,
    }),
    writeIngestionAudit: async (): Promise<{ id: string } | null> => ({ id: "dry-run" }),
    stampIngestionAudit: async (): Promise<boolean> => true,
    upsertIngestionWatermark: async (): Promise<boolean> => true,
  });

  return proxy;
}

// ---------------------------------------------------------------------------
// Gmail labeler — a callback the apply layers invoke on full success. No-op in dryRun.
//
// BUG-019 (2026-07-28): this used to call `GmailClient.fromEnv() + connect()` on EVERY
// label application — up to four reports label, so four fresh IMAP logins per run on top
// of the Mail Clerk's, the flecon fetcher's and the schedule fetcher's. That is how a run
// reached 7+ simultaneous sessions and tripped Gmail's ~15-connection cap. It now runs on
// THE shared session (lib/gmailSession.ts), which `runSync` pins for the whole run.
// ---------------------------------------------------------------------------
export function makeLabeler(
  dryRun: boolean,
  /** Test seam — defaults to the shared-session broker. */
  runGmail: GmailSessionRunner = withGmailSession,
): (uids: Array<number | string>) => Promise<boolean> {
  if (dryRun) return async () => false;
  return async (uids: Array<number | string>): Promise<boolean> => {
    if (!uids || uids.length === 0) return false;
    return runGmail((gmail) => gmail.markProcessed(uids));
  };
}

/** flecon's labeler takes a single uid string (its own deps shape). */
export function makeSingleLabeler(
  dryRun: boolean,
  runGmail: GmailSessionRunner = withGmailSession,
): (uid: string) => Promise<boolean> {
  const multi = makeLabeler(dryRun, runGmail);
  return async (uid: string): Promise<boolean> => multi([uid]);
}

// ---------------------------------------------------------------------------
// flecon re-fetches the latest FLECON BAGGED xlsx over Gmail itself (its runReport
// takes a `fetchLatestWorkbook(query)` callback, not a manifest). We honour that by
// running the query on THE shared session — it used to open its own (BUG-019).
// ---------------------------------------------------------------------------
export interface FleconWorkbookMeta {
  path: string;
  subject?: string | null;
  uid?: string | null;
  threadId?: string | null;
}

export function makeFleconFetcher(
  /** Test seam — defaults to the shared-session broker. */
  runGmail: GmailSessionRunner = withGmailSession,
): (gmailQuery: string) => Promise<FleconWorkbookMeta | null> {
  return async (gmailQuery: string): Promise<FleconWorkbookMeta | null> =>
    runGmail(async (gmail) => {
      const dir = await mkdtemp(join(tmpdir(), "bw-sync-flecon-"));
      const res = await gmail.search(gmailQuery, { outDir: dir, patterns: ["*.xlsx", "*.xls"] });
      // Walk newest→oldest for the first email carrying an xlsx (orchestrator_common.latest_xlsx).
      for (let i = res.emails.length - 1; i >= 0; i--) {
        const em = res.emails[i];
        for (const att of em.attachments) {
          const n = att.filename.toLowerCase();
          if ((n.endsWith(".xlsx") || n.endsWith(".xls")) && att.path) {
            return {
              path: att.path,
              subject: em.subject,
              uid: String(em.uid),
              threadId: em.threadId,
            };
          }
        }
      }
      return null;
    });
}

// ---------------------------------------------------------------------------
// Progress emitter bound to (runId, reportType). The frontend groups events by
// report_type; a report's own runReport emits its digestible track through this.
// ---------------------------------------------------------------------------
export function makeReportProgress(db: DbClient, runId: string, reportType: string): ProgressEmitter {
  return makeEmitter(db, runId, reportType);
}
