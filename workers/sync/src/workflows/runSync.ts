/**
 * runSync.ts — the real top-level "Run Sync" workflow (Wave 4A, M4-worker).
 *
 * Workflow ID: "run:<runId>" (set by the kick server — a duplicate kick is a no-op).
 *
 * Lifecycle & stages:
 *   sync_runs: queued → running (started_at) → succeeded | partial | failed
 *              (finished_at, result jsonb aggregating every report's envelope,
 *               error text on a whole-run failure). Status writes go through the
 *               service-role db (its own DBOS steps, so they are checkpointed).
 *
 *   Stage 1 — Mail Clerk (child workflow): ONE Gmail session → all report files into
 *             Supabase Storage. gsheet is NOT an email — its download is storage-ized
 *             inside the gsheet report (download.ts), so every report reads from a
 *             stable source and a crash mid-run never re-hits Gmail for what's done.
 *
 *   Stage 2 — Reports, in the EXACT panel order (app/(app)/sync/types.ts):
 *             gsheet FIRST and alone (source of truth) → then deliveries / rc_out /
 *             production / flecon as PARALLEL child workflows (DBOS.startWorkflow
 *             fan-out + Promise.allSettled) → rc_movement_audit LAST (read-only).
 *
 *   Each report is its OWN child workflow (reportWorkflow) with a stable workflowID
 *   ("report:<runId>:<type>"), so DBOS checkpoints and resumes each independently.
 *
 * dryRun (kick body {runId, dryRun}): classify-only — no applies, no labeling, no
 *   watermark writes (the write-blocking db proxy + no-op labeler in reportDeps.ts).
 *   Events + the full result still flow. This proves end-to-end without writing data.
 *
 * FAILURE ISOLATION: a report that throws returns an ok:false envelope (reportWorkflow
 * catches it); the run continues and its status becomes "partial". Only a failure in
 * the orchestration itself (Mail Clerk crash, DB unreachable) fails the whole run.
 */
import { DBOS, Error as DBOSErrors } from "@dbos-inc/dbos-sdk";
import { mailClerkWorkflow, type MailClerkManifest } from "./mailClerk.js";
import { reportWorkflow, type ReportEnvelope, type RunReportType } from "./reportWorkflow.js";
import { failedReportResult } from "./normalizeReport.js";
import { DbClient } from "../lib/db.js";
import { makeEmitter } from "../lib/progress.js";
import { mailClerkWorkflowId, reportWorkflowId } from "./ids.js";

/** True if a per-report envelope carries any failure (either phase ok:false). */
function reportFailed(r: ReportEnvelope): boolean {
  const classifyBad = r.classify != null && r.classify.ok === false;
  const applyBad = r.apply != null && r.apply.ok === false;
  return classifyBad || applyBad;
}

/**
 * True if an error is a DBOS workflow-cancellation (this workflow was cancelled) or
 * an awaited-child cancellation (a child we were awaiting was cancelled). Either way
 * the run was STOPPED on purpose — settle it as 'cancelled', never 'failed'.
 */
export function isCancellation(err: unknown): boolean {
  return (
    err instanceof DBOSErrors.DBOSWorkflowCancelledError ||
    err instanceof DBOSErrors.DBOSAwaitedWorkflowCancelledError
  );
}

export interface RunSyncParams {
  runId: string;
  /** Classify-only proof mode — no writes. Threaded to every report. */
  dryRun?: boolean;
  /** Gmail-date form YYYY/MM/DD for the Mail Clerk {since}. Defaults to a wide lookback. */
  since?: string;
}

export interface RunSyncResult {
  runId: string;
  dryRun: boolean;
  manifest: MailClerkManifest;
  reportsWithFiles: number;
  /** Per-report classify/apply envelopes, keyed by report_type. */
  reports: Record<string, ReportEnvelope>;
  /** Aggregate — the run's final disposition. */
  status: "succeeded" | "partial";
}

/** The panel's parallel writers (types.ts PARALLEL_WRITERS), run after gsheet. */
const PARALLEL_WRITERS: RunReportType[] = ["deliveries", "rc_out", "production", "flecon"];

async function runSyncBody(params: RunSyncParams): Promise<RunSyncResult> {
  const { runId } = params;
  const dryRun = params.dryRun ?? false;
  const since = params.since ?? defaultSince();

  await DBOS.runStep(() => markRunning(runId), { name: "markRunning" });
  await DBOS.runStep(
    () => emitProgress(runId, "fetch", dryRun ? "Starting a dry run — checking Gmail…" : "Checking Gmail for new reports…", 3),
    { name: "progress:fetchStart" },
  );

  // ── Stage 1: Mail Clerk (child workflow) — one Gmail session → Storage manifest.
  const manifest = await DBOS.startWorkflow(mailClerkWorkflow, {
    workflowID: mailClerkWorkflowId(runId),
  })({ runId, since });
  const manifestResolved = await manifest.getResult();

  const reportsWithFiles = Object.values(manifestResolved.reports).filter((a) => a.length > 0).length;
  await DBOS.runStep(
    () =>
      emitProgress(
        runId,
        "fetch",
        reportsWithFiles > 0 ? `Downloaded ${reportsWithFiles} report file(s)` : "No new email attachments",
        30,
      ),
    { name: "progress:fetchDone" },
  );

  const reports: Record<string, ReportEnvelope> = {};

  // ── Stage 2a: gsheet FIRST and alone (the source of truth). It self-downloads.
  const gsheetHandle = await DBOS.startWorkflow(reportWorkflow, {
    workflowID: reportWorkflowId(runId, "gsheet"),
  })({ runId, reportType: "gsheet", manifest: manifestResolved, dryRun, since: params.since });
  reports.gsheet = await gsheetHandle.getResult();

  // ── Stage 2b: the four writers in PARALLEL (DBOS fan-out + allSettled).
  const writerHandles = await Promise.all(
    PARALLEL_WRITERS.map((rt) =>
      DBOS.startWorkflow(reportWorkflow, { workflowID: reportWorkflowId(runId, rt) })({
        runId,
        reportType: rt,
        manifest: manifestResolved,
        dryRun,
        since: params.since,
      }),
    ),
  );
  const settled = await Promise.allSettled(writerHandles.map((h) => h.getResult()));
  // If the run was Stopped, a writer's getResult rejects with a cancellation. Surface
  // it as a run-level cancellation (re-throw → runSyncGuarded settles 'cancelled')
  // rather than a per-report failure — a stop halts the whole run, not one card.
  for (const res of settled) {
    if (res.status === "rejected" && isCancellation(res.reason)) {
      throw res.reason;
    }
  }
  settled.forEach((res, i) => {
    const rt = PARALLEL_WRITERS[i];
    if (res.status === "fulfilled") {
      reports[rt] = res.value;
    } else {
      // reportWorkflow already isolates report-level throws; an allSettled reject here
      // means the workflow machinery itself failed — record it as a contract-shaped
      // failed report so the card renders an error, not a missing-field crash.
      reports[rt] = failedReportResult(
        rt,
        res.reason instanceof Error ? res.reason.message : String(res.reason),
      );
    }
  });

  // ── Stage 2c: rc_movement_audit LAST (read-only — never writes, even on a real run).
  const auditHandle = await DBOS.startWorkflow(reportWorkflow, {
    workflowID: reportWorkflowId(runId, "rc_movement_audit"),
  })({ runId, reportType: "rc_movement_audit", manifest: manifestResolved, dryRun, since: params.since });
  // KEY IT AS `rc_movement` — the panel/reducer card key (types.ts SYNC_REPORTS), NOT the
  // worker's internal `rc_movement_audit` type. The events already use `rc_movement_audit`
  // as the report_type; those route to the `rc_movement` card too (reportWorkflowId maps).
  reports.rc_movement = await auditHandle.getResult();

  // ── Aggregate: any report failing either phase → the run is "partial".
  const anyFailed = Object.values(reports).some(reportFailed);
  const status: "succeeded" | "partial" = anyFailed ? "partial" : "succeeded";

  const result: RunSyncResult = {
    runId,
    dryRun,
    manifest: manifestResolved,
    reportsWithFiles,
    reports,
    status,
  };

  await DBOS.runStep(() => finishRun(runId, status, result), { name: "finishRun" });
  return result;
}

// ── step bodies (plain async fns wrapped in DBOS.runStep) ───────────────────
async function markRunning(runId: string): Promise<void> {
  const db = DbClient.fromEnv();
  await db.setSyncRunStatus(runId, "running");
}

async function emitProgress(
  runId: string,
  stage: "fetch" | "extract" | "classify" | "apply" | "reconcile" | "finalize",
  label: string,
  pct: number,
): Promise<void> {
  const db = DbClient.fromEnv();
  const emit = makeEmitter(db, runId, "_run");
  await emit(stage, label, pct);
}

async function finishRun(
  runId: string,
  status: "succeeded" | "partial",
  result: RunSyncResult,
): Promise<void> {
  const db = DbClient.fromEnv();
  await db.finishSyncRun(runId, status, result as unknown as Record<string, unknown>);
  const emit = makeEmitter(db, runId, "_run");
  const label =
    status === "partial"
      ? "Done — but one or more reports need a look."
      : result.dryRun
        ? "Dry run complete — nothing was written."
        : "Done";
  await emit("finalize", label, 100, undefined, status === "partial" ? "warn" : "info");
}

function defaultSince(): string {
  // 60-day lookback in Gmail's YYYY/MM/DD form.
  const d = new Date(Date.now() - 60 * 24 * 3600 * 1000);
  return `${d.getUTCFullYear()}/${String(d.getUTCMonth() + 1).padStart(2, "0")}/${String(
    d.getUTCDate(),
  ).padStart(2, "0")}`;
}

/**
 * Top-level failure path: if the orchestration itself throws (Mail Clerk crash, DB
 * unreachable), mark the run failed with the error text before rethrowing so DBOS can
 * record the terminal state. Wrapped as the registered workflow.
 */
async function runSyncGuarded(params: RunSyncParams): Promise<RunSyncResult> {
  try {
    return await runSyncBody(params);
  } catch (err) {
    // A cancellation (Stop button) is NOT a crash: settle 'cancelled', keep every
    // already-written row, and re-throw so DBOS records the terminal CANCELLED state.
    if (isCancellation(err)) {
      try {
        await DBOS.runStep(() => cancelRun(params.runId), { name: "cancelRun" });
      } catch {
        /* best-effort terminal write */
      }
      throw err;
    }
    const message = err instanceof Error ? err.message : String(err);
    try {
      await DBOS.runStep(() => failRun(params.runId, message), { name: "failRun" });
    } catch {
      /* best-effort terminal write */
    }
    throw err;
  }
}

async function failRun(runId: string, message: string): Promise<void> {
  const db = DbClient.fromEnv();
  await db.finishSyncRun(runId, "failed", null, message);
  const emit = makeEmitter(db, runId, "_run");
  await emit("finalize", "The run could not complete.", 100, message, "warn");
}

/**
 * Terminal write for a STOPPED run. Marks status 'cancelled' ONLY if the row is still
 * non-terminal (the app action may have already flipped it to 'cancelled' for instant
 * UI feedback — that's fine, this is a harmless no-op then). No result is written and
 * NOTHING is rolled back: rows applied before the stop are kept by design. Emits one
 * calm "Stopped." beat on the overall track.
 */
async function cancelRun(runId: string): Promise<void> {
  const db = DbClient.fromEnv();
  await db.cancelSyncRunIfActive(runId);
  const emit = makeEmitter(db, runId, "_run");
  await emit("finalize", "Stopped. Anything already written was kept.", 100, undefined, "warn");
}

export const runSyncWorkflow = DBOS.registerWorkflow(runSyncGuarded, { name: "runSyncWorkflow" });
