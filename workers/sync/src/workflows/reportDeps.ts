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
import { GmailClient } from "../lib/gmail.js";
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
// A live labeler opens ONE session, applies the label, closes. Kept lazy: only the
// two reports that label (writers with a Gmail thread) construct one.
// ---------------------------------------------------------------------------
export function makeLabeler(dryRun: boolean): (uids: Array<number | string>) => Promise<boolean> {
  if (dryRun) return async () => false;
  return async (uids: Array<number | string>): Promise<boolean> => {
    if (!uids || uids.length === 0) return false;
    const gmail = GmailClient.fromEnv();
    await gmail.connect();
    try {
      return await gmail.markProcessed(uids);
    } finally {
      await gmail.close();
    }
  };
}

/** flecon's labeler takes a single uid string (its own deps shape). */
export function makeSingleLabeler(dryRun: boolean): (uid: string) => Promise<boolean> {
  const multi = makeLabeler(dryRun);
  return async (uid: string): Promise<boolean> => multi([uid]);
}

// ---------------------------------------------------------------------------
// flecon re-fetches the latest FLECON BAGGED xlsx over Gmail itself (its runReport
// takes a `fetchLatestWorkbook(query)` callback, not a manifest). We honour that by
// opening one Gmail session, running the query, saving the newest xlsx to tmp.
// ---------------------------------------------------------------------------
export interface FleconWorkbookMeta {
  path: string;
  subject?: string | null;
  uid?: string | null;
  threadId?: string | null;
}

export function makeFleconFetcher(): (gmailQuery: string) => Promise<FleconWorkbookMeta | null> {
  return async (gmailQuery: string): Promise<FleconWorkbookMeta | null> => {
    const gmail = GmailClient.fromEnv();
    await gmail.connect();
    try {
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
    } finally {
      await gmail.close();
    }
  };
}

// ---------------------------------------------------------------------------
// Progress emitter bound to (runId, reportType). The frontend groups events by
// report_type; a report's own runReport emits its digestible track through this.
// ---------------------------------------------------------------------------
export function makeReportProgress(db: DbClient, runId: string, reportType: string): ProgressEmitter {
  return makeEmitter(db, runId, reportType);
}
