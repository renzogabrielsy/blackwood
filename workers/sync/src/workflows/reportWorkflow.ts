/**
 * reportWorkflow.ts — the per-report CHILD workflow (Wave 4A).
 *
 * The parent runSync starts one of these per report type. Each takes SERIALIZABLE
 * params only (runId, reportType, manifest slice, dryRun, since) — it constructs its
 * own DbClient / Gmail / progress inside (DBOS can't serialize live clients across a
 * crash boundary; every workflow rebuilds its IO from env on resume, exactly like the
 * Mail Clerk does).
 *
 * It dispatches to the report's OWN `runReport(deps, …)` (the workflow-layer idiom the
 * Wave-3 porters exported), adapting deps via reportDeps.ts. The report's logic is
 * untouched. The whole runReport call is ONE DBOS step, so a crash mid-report resumes
 * by re-running that report (fetch is idempotent; in a real run the apply's
 * insertIfAbsent + REPLACE-BY-DATE are themselves idempotent — the Wave-3 guarantee).
 *
 * FAILURE ISOLATION: a report that throws does NOT crash the run. The child workflow
 * catches, emits a warn event, and returns an envelope carrying `ok:false` + the error
 * text. The parent aggregates; one failure → run status "partial", others continue.
 */
import { DBOS, Error as DBOSErrors } from "@dbos-inc/dbos-sdk";
import { DbClient } from "../lib/db.js";
import type { MailClerkManifest, StoredAttachment } from "./mailClerk.js";
import {
  makeStorageFetcher,
  makeDryRunDb,
  makeLabeler,
  makeSingleLabeler,
  makeFleconFetcher,
  makeReportProgress,
} from "./reportDeps.js";
import {
  toReportResult,
  failedReportResult,
  type SyncRunReportResult,
} from "./normalizeReport.js";

import { runReport as runDeliveries } from "../reports/deliveries/index.js";
import { runReport as runRcOut } from "../reports/rc_out/index.js";
import { runReport as runProduction } from "../reports/production/index.js";
import { runReport as runFlecon } from "../reports/flecon/index.js";
import { runReport as runRcMovementAudit } from "../reports/rc_movement_audit/index.js";
import { runReport as runGsheet } from "../reports/gsheet/index.js";

/** The report types the run orchestrates. Note `rc_movement_audit` here maps to the
 *  panel's `rc_movement` card (types.ts) — the parent labels events with this key. */
export type RunReportType =
  | "gsheet"
  | "deliveries"
  | "rc_out"
  | "production"
  | "flecon"
  | "rc_movement_audit";

export interface ReportWorkflowParams {
  runId: string;
  reportType: RunReportType;
  /** The Mail Clerk manifest (Storage paths). gsheet ignores it (self-downloads). */
  manifest: MailClerkManifest;
  /** Classify-only: no applies, no labeling, no watermark writes. */
  dryRun: boolean;
  /** Optional window floor override (YYYY-MM-DD). Reports compute their own if absent. */
  since?: string;
}

/**
 * The uniform envelope every report contributes to the run result. This is now the
 * SAME shape the FRONTEND reads (app/(app)/sync/types.ts::SyncRunReportResult):
 * `{ classify, apply }` with a NESTED `apply.applied` and the FULL `apply.held` ROWS.
 * Reconciled here so the worker and the app describe the identical JSON — see
 * normalizeReport.ts. (Formerly a flat, held-collapsed-to-count shape — the bug.)
 */
export type ReportEnvelope = SyncRunReportResult;

/**
 * Map the worker's internal report type → the PANEL CARD KEY (app/(app)/sync/types.ts
 * SYNC_REPORTS). The only divergence is the read-only auditor: worker `rc_movement_audit`
 * → panel `rc_movement`. Progress EVENTS and the result envelope must both use the panel
 * key, or the reducer (`VALID_REPORT_TYPES`) drops them and the card never populates.
 */
export function panelCardKey(reportType: RunReportType): string {
  return reportType === "rc_movement_audit" ? "rc_movement" : reportType;
}

/** Build a report's manifest slice `{reports: {key: [att]}}` from the full manifest. */
function slice(manifest: MailClerkManifest, keys: string[]): { reports: Record<string, StoredAttachment[]> } {
  const reports: Record<string, StoredAttachment[]> = {};
  for (const k of keys) reports[k] = manifest.reports[k] ?? [];
  return { reports };
}

/**
 * Run a single report end to end. Constructs deps from env, adapts to the report's
 * own deps type, dispatches, and normalizes the return into a ReportEnvelope.
 */
async function runOneReport(params: ReportWorkflowParams): Promise<ReportEnvelope> {
  const { runId, reportType, manifest, dryRun } = params;
  const realDb = DbClient.fromEnv();
  const db = dryRun ? makeDryRunDb(realDb) : realDb;
  // Emit progress under the PANEL CARD KEY so the reducer routes it to the right card
  // (the auditor's worker type `rc_movement_audit` maps to the `rc_movement` card).
  const progress = makeReportProgress(realDb, runId, panelCardKey(reportType));
  const fetchToLocalPath = makeStorageFetcher();
  const labeler = makeLabeler(dryRun);
  const runTs = new Date().toISOString();

  switch (reportType) {
    case "deliveries": {
      const r = await runDeliveries(
        { db, fetchToLocalPath, labeler, progress, noLabel: dryRun, runTs },
        runId,
        slice(manifest, ["deliveries", "deliveries_czarina"]),
        params.since ? { since: params.since } : {},
      );
      return toReportResult({
        reportType: "deliveries",
        classify: r.classify,
        apply: dryRun ? null : r.apply,
      });
    }
    case "rc_out": {
      const r = await runRcOut(
        { db, fetchToLocalPath, labeler, progress, noLabel: dryRun, runTs },
        runId,
        slice(manifest, ["rc_out", "rc_out_movement"]),
        params.since ? { since: params.since } : {},
      );
      return toReportResult({
        reportType: "rc_out",
        classify: r.classify,
        apply: dryRun ? null : r.apply,
        // L-034 month-boundary label-variance notes: carry them on the classify block so
        // they reach the app (normalizeClassify preserves extra keys; reducer ignores it).
        classifyExtra: r.classify.soft_warnings.length
          ? { soft_warnings: r.classify.soft_warnings }
          : undefined,
      });
    }
    case "production": {
      const r = await runProduction(
        { db, fetchToLocalPath, labeler, progress, noLabel: dryRun, runTs },
        runId,
        // MC's slot is the canonical Mail-Clerk key "production_mc" (mailQueries + the
        // app investigator's SOURCE_KEYS), NOT "production" — slicing the bare "production"
        // dropped the downloaded MC workbook (2026-07-15 regression, run 134cd9bd).
        slice(manifest, ["production_mc", "production_waste"]),
        params.since ? { since: params.since } : {},
      );
      return toReportResult({
        reportType: "production",
        classify: r.classify,
        apply: dryRun ? null : r.apply,
        classifyExtra: { per_section: r.classify.per_section },
      });
    }
    case "flecon": {
      // flecon's deps are its own shape: db needs deleteByDate (on DbClient now) +
      // readRows/dataWatermark; it fetches its own workbook over Gmail and labels a
      // single uid. In dryRun the fetch still happens (read-only) but labeling no-ops.
      const r = await runFlecon(
        {
          db: db as unknown as Parameters<typeof runFlecon>[0]["db"],
          progress: (stage, label, pct, detail, level) => progress(stage, label, pct, detail, level),
          fetchLatestWorkbook: makeFleconFetcher(),
          labelProcessed: makeSingleLabeler(dryRun),
        },
        runId,
        { noLabel: dryRun },
      );
      const s = r.classified?.summary as
        | { duplicate_noop_days?: number; new_days?: number; date_changed_days?: number }
        | undefined;
      // flecon's classify is its own shape; synthesize the contract classify counts
      // (REPLACE-BY-DATE: new/changed/noop are DAY-level). apply carries replaced_dates.
      return toReportResult({
        reportType: "flecon",
        classify: {
          report_type: "flecon",
          ok: r.ok,
          gate_failures: [],
          counts: {
            noop: s?.duplicate_noop_days ?? 0,
            insert: s?.new_days ?? 0,
            update: s?.date_changed_days ?? 0,
            flagged: r.classified?.column_flags.flagged ? 1 : 0,
          },
          watermark: null,
        },
        apply: dryRun ? null : r.apply,
        classifyExtra: r.note ? { note: r.note } : undefined,
      });
    }
    case "gsheet": {
      // gsheet downloads the Sheet itself (no manifest file). Its deps: db + progress
      // + fetchImpl (platform fetch) + runTs. It never labels (a Sheet has no thread).
      const r = await runGsheet(
        { db, progress, runTs },
        runId,
        {},
        params.since ? { since: params.since } : {},
      );
      return toReportResult({
        reportType: "gsheet",
        classify: r.classify,
        apply: dryRun ? null : r.apply,
        classifyExtra: { per_mode: r.classify.per_mode },
      });
    }
    case "rc_movement_audit": {
      // Read-only auditor: NO apply, NEVER writes/labels (even in a real run). It only
      // needs db (reads rc_out sums) + fetchToLocalPath + progress. apply is ALWAYS null.
      const r = await runRcMovementAudit(
        { db, fetchToLocalPath, progress, since: params.since },
        runId,
        slice(manifest, ["rc_out_movement"]),
      );
      return toReportResult({
        reportType: "rc_movement_audit",
        classify: {
          report_type: "rc_movement_audit",
          ok: r.ok,
          gate_failures: r.gate_failures,
          counts: r.counts,
          watermark: r.watermark,
        },
        apply: null, // read-only auditor — no apply, ever.
        classifyExtra: { severity: r.severity, audit_since: r.audit_since, note: r.note },
      });
    }
    default: {
      const exhaustive: never = reportType;
      throw new Error(`unknown report type: ${String(exhaustive)}`);
    }
  }
}

/**
 * The child-workflow body. Wraps runOneReport in a DBOS step and provides failure
 * isolation: a thrown report becomes an ok:false envelope, never a crashed run.
 */
async function reportWorkflowBody(params: ReportWorkflowParams): Promise<ReportEnvelope> {
  const { runId, reportType } = params;
  // Progress + failure beats emit under the PANEL CARD KEY (auditor → rc_movement card).
  const cardKey = panelCardKey(reportType);
  try {
    return await DBOS.runStep(() => runOneReport(params), { name: `report:${reportType}` });
  } catch (err) {
    // A cancellation (the run was Stopped) must NOT be swallowed into an ok:false
    // envelope — re-throw so DBOS marks THIS child CANCELLED and the parent sees a
    // DBOSAwaitedWorkflowCancelledError (→ run status 'cancelled'). Rows this report
    // wrote before the stop boundary are kept (never rolled back).
    if (
      err instanceof DBOSErrors.DBOSWorkflowCancelledError ||
      err instanceof DBOSErrors.DBOSAwaitedWorkflowCancelledError
    ) {
      try {
        const db = DbClient.fromEnv();
        const emit = makeReportProgress(db, runId, cardKey);
        await emit("finalize", "Stopped.", 100, undefined, "warn");
      } catch {
        /* observational only */
      }
      throw err;
    }
    const message = err instanceof Error ? err.message : String(err);
    // Emit a warn beat so the live feed shows the failure, then carry it in the envelope.
    try {
      const db = DbClient.fromEnv();
      const emit = makeReportProgress(db, runId, cardKey);
      await emit("finalize", "This report hit a problem — the rest of the run continues.", 100, message, "warn");
    } catch {
      /* progress is observational — never let it mask the real error */
    }
    // Contract-shaped failure result (classify ok:false + apply with zeroed applied)
    // so the card renders an error state — never a missing-field crash. Key it to the
    // panel card so the reducer folds it into the right card.
    return failedReportResult(cardKey, message);
  }
}

export const reportWorkflow = DBOS.registerWorkflow(reportWorkflowBody, {
  name: "reportWorkflow",
});
