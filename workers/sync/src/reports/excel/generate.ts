/**
 * generate.ts — build the run's Excel report, store it, and record it. The impure half.
 *
 * CALLED AT THE END OF EVERY RUN, including a clean one and including a crashed one:
 *   - runSync's happy path calls it just before `finishRun`, from the assembled result.
 *   - `failRun` / `cancelRun` call it too, with no result. A crashed run is EXACTLY when
 *     the Run Log sheet is worth having, and "the report is missing" must never be the way
 *     you find out a run died.
 *
 * ================== IT CAN NEVER FAIL A SYNC RUN. THAT IS THE POINT. ==================
 * A reporting tool that can break the thing it reports on is worse than no tool. So:
 *   - `generateRunReport` NEVER throws. Every step is inside one try/catch and the catch
 *     returns `{ok:false, error}`.
 *   - Even the FAILURE bookkeeping is best-effort: if recording the failure row also throws,
 *     that is swallowed too, and the artifact still comes back `{ok:false}` so the run can
 *     surface it as a finding from the result alone.
 *   - The caller wraps the whole thing in `DBOS.runStep`, so a crash between build and
 *     upload replays cleanly (Storage upload is `upsert:true`, the path is deterministic).
 *
 * PESO GATE: the workbook builder audits its own output and reports `containsPrices`. That
 * boolean is written straight to `sync_run_reports.contains_prices`, whose DEFAULT is TRUE
 * (fail-closed) and which `getSyncRunReportUrl` checks against `canViewPrices()`. Nothing
 * here decides policy — it records a measured fact and lets the app enforce.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { DbClient } from "../../lib/db.js";
import type { ReportArtifact } from "./artifact.js";
import {
  buildSyncReportWorkbook,
  type ReportCaseRow,
  type ReportEventRow,
  type SyncReportInput,
} from "./workbook.js";
import type { AppSyncRunResult } from "./findingsBridge.js";

/** The PRIVATE bucket the workbooks live in (created in the 20260807060558 migration). */
export const SYNC_REPORTS_BUCKET = "sync-reports";

export const REPORT_TABLE = "sync_run_reports";

/**
 * Bumped whenever the workbook's shape changes, so a stored artifact can be traced to the
 * code that wrote it. Recorded in `sync_run_reports.generator_version`.
 */
export const REPORT_GENERATOR_VERSION = "excel-1.0";

const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

/** `YYYY-MM-DD` in Asia/Manila — the folder segment, so folders line up with Renzo's days. */
const MANILA_DATE = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Manila",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/** `HHmm` in Asia/Manila — the time part of the friendly download filename. */
const MANILA_HHMM = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Asia/Manila",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

function manilaDate(iso: string | null | undefined): string {
  const d = iso ? new Date(iso) : new Date();
  const use = Number.isNaN(d.getTime()) ? new Date() : d;
  return MANILA_DATE.format(use);
}

function manilaHHmm(iso: string | null | undefined): string {
  const d = iso ? new Date(iso) : new Date();
  const use = Number.isNaN(d.getTime()) ? new Date() : d;
  return MANILA_HHMM.format(use).replace(":", "");
}

/**
 * The DETERMINISTIC object path: `<Manila date>/<runId>.xlsx`.
 *
 * Deterministic matters twice over. It makes the upload idempotent under DBOS replay (an
 * `upsert:true` write to the same key), and it makes history browsable — one folder per
 * operating day, one object per run, no timestamp collisions to reason about. The date comes
 * from the RUN (its `started_at`), never from `now()`, so regenerating an old report a month
 * later still lands in that run's own folder.
 */
export function reportStoragePath(runId: string, startedAt: string | null): string {
  return `${manilaDate(startedAt)}/${runId}.xlsx`;
}

/** The friendly name the download is served as — the terse path is not what a human wants. */
export function reportFilename(runId: string, startedAt: string | null): string {
  return `blackwood-sync-${manilaDate(startedAt)}-${manilaHHmm(startedAt)}-${runId.slice(0, 8)}.xlsx`;
}

export interface GenerateRunReportOptions {
  /**
   * The assembled result, when the caller has one. Omitted/null on the crash + stop paths.
   * Passed in rather than re-read so the workbook describes EXACTLY the result the run is
   * about to persist, with no window for the two to disagree.
   */
  result?: AppSyncRunResult | null;
  /** Terminal status the caller is about to write (`succeeded` | `partial` | `failed` | …). */
  status?: string | null;
  /** Crash text for the Summary sheet, on the failure path. */
  runError?: string | null;
  /**
   * Skip the Storage upload and the DB row — used by the "does a failure break the run?"
   * proof and by any caller that wants the bytes without the side effects.
   */
  skipPersist?: boolean;
  /** Test seam: force the build to throw, to prove the run survives it. */
  failForTest?: boolean;
}

/**
 * Build + store + record the run's Excel report. Returns the artifact pointer. NEVER throws.
 */
export async function generateRunReport(
  runId: string,
  options: GenerateRunReportOptions = {},
): Promise<ReportArtifact> {
  let db: DbClient | null = null;
  try {
    db = DbClient.fromEnv();

    if (options.failForTest) {
      throw new Error("forced report-generation failure (failForTest)");
    }

    const input = await gatherReportInput(db, runId, options);
    const built = await buildSyncReportWorkbook(input);

    if (options.skipPersist) {
      return {
        ok: true,
        bucket: null,
        path: null,
        filename: reportFilename(runId, input.startedAt),
        bytes: built.buffer.byteLength,
        sheet_counts: built.sheetCounts,
        finding_count: built.findingCount,
        warn_count: built.warnCount,
        error_count: built.errorCount,
        contains_prices: built.containsPrices,
      };
    }

    const path = reportStoragePath(runId, input.startedAt);
    const filename = reportFilename(runId, input.startedAt);
    await uploadReport(db.sb, path, built.buffer);

    const artifact: ReportArtifact = {
      ok: true,
      bucket: SYNC_REPORTS_BUCKET,
      path,
      filename,
      bytes: built.buffer.byteLength,
      sheet_counts: built.sheetCounts,
      finding_count: built.findingCount,
      warn_count: built.warnCount,
      error_count: built.errorCount,
      contains_prices: built.containsPrices,
    };

    await db.insert(REPORT_TABLE, [
      {
        run_id: runId,
        storage_bucket: SYNC_REPORTS_BUCKET,
        storage_path: path,
        filename,
        bytes: built.buffer.byteLength,
        finding_count: built.findingCount,
        warn_count: built.warnCount,
        error_count: built.errorCount,
        sheet_counts: built.sheetCounts,
        contains_prices: built.containsPrices,
        generator_version: REPORT_GENERATOR_VERSION,
        ok: true,
        error: null,
      },
    ]);

    return artifact;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Best-effort failure record. If THIS throws too we still return {ok:false}, because the
    // artifact travels back in the run result and the app raises the finding from there —
    // the DB row is for the history list, not for the alarm.
    if (db) {
      try {
        await db.insert(REPORT_TABLE, [
          {
            run_id: runId,
            storage_bucket: SYNC_REPORTS_BUCKET,
            storage_path: null,
            filename: null,
            bytes: null,
            sheet_counts: {},
            // Fail-closed: an artifact we could not audit is treated as price-bearing.
            contains_prices: true,
            generator_version: REPORT_GENERATOR_VERSION,
            ok: false,
            error: message.slice(0, 2000),
          },
        ]);
      } catch {
        /* the run must not care */
      }
    }
    return { ok: false, error: message.slice(0, 2000) };
  }
}

/**
 * Read everything the workbook needs. Three small reads, all scoped to one run:
 *   - the `sync_runs` row (timing + status + the dry-run flag),
 *   - every `sync_run_events` row (the Run Log sheet),
 *   - every `sync_held_cases` row this run RAISED OR RE-RAISED (`last_run_id`), which is the
 *     honest scope for "awaiting arbitration": a case first opened weeks ago but re-seen
 *     today is this run's business, and one nothing touched today is not.
 */
async function gatherReportInput(
  db: DbClient,
  runId: string,
  options: GenerateRunReportOptions,
): Promise<SyncReportInput> {
  const runRow = await db.selectOne(
    "sync_runs",
    { id: `eq.${runId}` },
    "id,status,started_at,finished_at,result,error",
  );

  // The caller's in-hand result wins: on the happy path it is the exact object about to be
  // persisted, and reading it back would race the write that has not happened yet.
  const result =
    options.result !== undefined
      ? options.result
      : ((runRow?.result ?? null) as AppSyncRunResult | null);

  const status = options.status ?? (runRow?.status as string | undefined) ?? "unknown";
  const runError = options.runError ?? ((runRow?.error as string | null) ?? null);
  const startedAt = (runRow?.started_at as string | null) ?? null;
  const finishedAt = (runRow?.finished_at as string | null) ?? null;

  const dryRun =
    result && typeof result === "object" && typeof (result as Record<string, unknown>).dryRun === "boolean"
      ? ((result as Record<string, unknown>).dryRun as boolean)
      : false;

  const events = (await db.readRows("sync_run_events", {
    sinceColumn: null,
    columns: ["report_type", "stage", "pct", "label", "detail", "level", "at"],
    extraFilters: { run_id: `eq.${runId}`, order: "at.asc,id.asc" },
  })) as unknown as ReportEventRow[];

  const cases = (await db.readRows("sync_held_cases", {
    sinceColumn: null,
    columns: [
      "report_type",
      "kind",
      "natural_key",
      "status",
      "reason",
      "detail",
      "row",
      "occurrence_count",
      "created_at",
      "last_seen_at",
      "known_ruling_id",
    ],
    extraFilters: { last_run_id: `eq.${runId}`, order: "kind.asc" },
  })) as unknown as ReportCaseRow[];

  return {
    runId,
    runStatus: status,
    startedAt,
    finishedAt,
    dryRun,
    result,
    events,
    cases,
    runError,
    generatorVersion: REPORT_GENERATOR_VERSION,
  };
}

/** Upload with `upsert:true` so a DBOS replay (or a deliberate regeneration) is idempotent. */
async function uploadReport(sb: SupabaseClient, path: string, content: Buffer): Promise<void> {
  const { error } = await sb.storage.from(SYNC_REPORTS_BUCKET).upload(path, content, {
    contentType: XLSX_MIME,
    upsert: true,
  });
  if (error) {
    throw new Error(`Storage upload ${SYNC_REPORTS_BUCKET}/${path} failed: ${error.message}`);
  }
}
