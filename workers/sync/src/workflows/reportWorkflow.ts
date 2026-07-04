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
import { DBOS } from "../dbos.js";
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

/** The uniform envelope every report contributes to the run result. */
export interface ReportEnvelope {
  report_type: string;
  ok: boolean;
  /** Classify counts (noop/insert/update/flagged) — present for all reports. */
  counts: { noop: number; insert: number; update: number; flagged: number };
  /** Hard-gate failures (rc_out drift/dup gates; rc_movement serious drift). */
  gate_failures: Array<{ gate: string; detail: string }>;
  /** Apply outcome summary (0/absent in dryRun or read-only). */
  apply?: {
    inserts: number;
    updates: number;
    held: number;
    labeled: boolean;
    watermark_updated: boolean;
    errors: string[];
  };
  watermark: string | null;
  /** Populated only when the report threw — failure isolation carries it here. */
  error?: string;
  /** Extra per-report detail (e.g. rc_movement severity, gsheet per_mode). */
  detail?: Record<string, unknown>;
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
  const progress = makeReportProgress(realDb, runId, reportType);
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
      return {
        report_type: "deliveries",
        ok: r.classify.ok,
        counts: r.classify.counts,
        gate_failures: r.classify.gate_failures,
        apply: applySummary(r.apply),
        watermark: r.classify.watermark,
      };
    }
    case "rc_out": {
      const r = await runRcOut(
        { db, fetchToLocalPath, labeler, progress, noLabel: dryRun, runTs },
        runId,
        slice(manifest, ["rc_out", "rc_out_movement"]),
        params.since ? { since: params.since } : {},
      );
      return {
        report_type: "rc_out",
        ok: r.classify.ok,
        counts: r.classify.counts,
        gate_failures: r.classify.gate_failures,
        apply: applySummary(r.apply),
        watermark: r.classify.watermark,
      };
    }
    case "production": {
      const r = await runProduction(
        { db, fetchToLocalPath, labeler, progress, noLabel: dryRun, runTs },
        runId,
        slice(manifest, ["production", "production_waste"]),
        params.since ? { since: params.since } : {},
      );
      return {
        report_type: "production",
        ok: r.classify.ok,
        counts: r.classify.counts,
        gate_failures: [],
        apply: applySummary(r.apply),
        watermark: r.classify.watermark,
        detail: { per_section: r.classify.per_section },
      };
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
      const s = r.classified?.summary;
      return {
        report_type: "flecon",
        ok: r.ok,
        counts: {
          noop: s?.duplicate_noop_days ?? 0,
          insert: s?.new_days ?? 0,
          update: s?.date_changed_days ?? 0,
          flagged: r.classified?.column_flags.flagged ? 1 : 0,
        },
        gate_failures: [],
        apply: r.apply
          ? {
              inserts: r.apply.inserts,
              updates: 0,
              held: r.apply.held.length,
              labeled: r.apply.labeled,
              watermark_updated: r.apply.watermark_updated,
              errors: r.apply.errors,
            }
          : undefined,
        watermark: null,
        detail: r.note ? { note: r.note } : undefined,
      };
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
      return {
        report_type: "gsheet",
        ok: r.classify.ok,
        counts: r.classify.counts,
        gate_failures: [],
        apply: applySummary(r.apply),
        watermark: r.classify.watermark,
        detail: { per_mode: r.classify.per_mode },
      };
    }
    case "rc_movement_audit": {
      // Read-only auditor: NO apply, NEVER writes/labels (even in a real run). It only
      // needs db (reads rc_out sums) + fetchToLocalPath + progress.
      const r = await runRcMovementAudit(
        { db, fetchToLocalPath, progress, since: params.since },
        runId,
        slice(manifest, ["rc_out_movement"]),
      );
      return {
        report_type: "rc_movement_audit",
        ok: r.ok,
        counts: r.counts,
        gate_failures: r.gate_failures,
        watermark: r.watermark,
        detail: { severity: r.severity, audit_since: r.audit_since, note: r.note },
      };
    }
    default: {
      const exhaustive: never = reportType;
      throw new Error(`unknown report type: ${String(exhaustive)}`);
    }
  }
}

function applySummary(apply: {
  inserts?: number;
  updates?: number;
  held?: unknown[];
  labeled?: boolean;
  watermark_updated?: boolean;
  errors?: string[];
}): ReportEnvelope["apply"] {
  return {
    inserts: apply.inserts ?? 0,
    updates: apply.updates ?? 0,
    held: Array.isArray(apply.held) ? apply.held.length : 0,
    labeled: Boolean(apply.labeled),
    watermark_updated: Boolean(apply.watermark_updated),
    errors: apply.errors ?? [],
  };
}

/**
 * The child-workflow body. Wraps runOneReport in a DBOS step and provides failure
 * isolation: a thrown report becomes an ok:false envelope, never a crashed run.
 */
async function reportWorkflowBody(params: ReportWorkflowParams): Promise<ReportEnvelope> {
  const { runId, reportType } = params;
  try {
    return await DBOS.runStep(() => runOneReport(params), { name: `report:${reportType}` });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Emit a warn beat so the live feed shows the failure, then carry it in the envelope.
    try {
      const db = DbClient.fromEnv();
      const emit = makeReportProgress(db, runId, reportType);
      await emit("finalize", "This report hit a problem — the rest of the run continues.", 100, message, "warn");
    } catch {
      /* progress is observational — never let it mask the real error */
    }
    return {
      report_type: reportType,
      ok: false,
      counts: { noop: 0, insert: 0, update: 0, flagged: 0 },
      gate_failures: [],
      watermark: null,
      error: message,
    };
  }
}

export const reportWorkflow = DBOS.registerWorkflow(reportWorkflowBody, {
  name: "reportWorkflow",
});
