/**
 * runSync.ts — the top-level "Run Sync" workflow.
 *
 * M0/M1 scope: this workflow (a) marks the sync_runs row running, (b) invokes the
 * Mail Clerk to pull all report attachments into Storage, (c) records the manifest
 * and finishes the run. The per-report extract→classify→apply child workflows are
 * M3 — they will be added here as `DBOS.startWorkflow(reportWorkflow, …)` fan-outs
 * that consume the Mail Clerk manifest from Storage.
 *
 * Because it is a DBOS workflow, a crash anywhere resumes from the last completed
 * step: if the Mail Clerk already uploaded to Storage, a restart does not re-fetch.
 */
import { DBOS } from "../dbos.js";
import { mailClerkWorkflow, type MailClerkManifest } from "./mailClerk.js";
import { DbClient } from "../lib/db.js";
import { makeEmitter } from "../lib/progress.js";

export interface RunSyncParams {
  runId: string;
  /** Gmail-date form YYYY/MM/DD for {since}. Defaults to a wide lookback if omitted. */
  since?: string;
}

export interface RunSyncResult {
  runId: string;
  manifest: MailClerkManifest;
  reportsWithFiles: number;
}

async function runSyncBody(params: RunSyncParams): Promise<RunSyncResult> {
  const { runId } = params;
  // A generous default lookback so the primary queries catch anything recent; the
  // per-report DATA watermark refinement lands in M3.
  const since = params.since ?? defaultSince();

  // DB status transitions + progress are their own steps so they are checkpointed.
  await DBOS.runStep(() => markRunning(runId), { name: "markRunning" });
  await DBOS.runStep(() => emitProgress(runId, "fetch", "Checking Gmail for new reports…", 5), {
    name: "progress:fetchStart",
  });

  // Mail Clerk as a CHILD workflow — one Gmail session, uploads to Storage.
  const manifest = await mailClerkWorkflow({ runId, since });

  const reportsWithFiles = Object.values(manifest.reports).filter(
    (arr) => arr.length > 0
  ).length;

  await DBOS.runStep(
    () =>
      emitProgress(
        runId,
        "fetch",
        reportsWithFiles > 0
          ? `Downloaded ${reportsWithFiles} report file(s)`
          : "Nothing new to download",
        40
      ),
    { name: "progress:fetchDone" }
  );

  const result: RunSyncResult = { runId, manifest, reportsWithFiles };

  // M0/M1: no per-report apply yet — mark succeeded with the manifest as the result.
  await DBOS.runStep(() => finishRun(runId, result), { name: "finishRun" });
  return result;
}

// -- step bodies (plain async fns wrapped in DBOS.runStep) -------------------
async function markRunning(runId: string): Promise<void> {
  const db = DbClient.fromEnv();
  await db.setSyncRunStatus(runId, "running");
}

async function emitProgress(
  runId: string,
  stage: "fetch" | "extract" | "classify" | "apply" | "reconcile" | "finalize",
  label: string,
  pct: number
): Promise<void> {
  const db = DbClient.fromEnv();
  const emit = makeEmitter(db, runId, "_run");
  await emit(stage, label, pct);
}

async function finishRun(runId: string, result: RunSyncResult): Promise<void> {
  const db = DbClient.fromEnv();
  await db.finishSyncRun(runId, "succeeded", result as unknown as Record<string, unknown>);
  const emit = makeEmitter(db, runId, "_run");
  await emit("finalize", "Done", 100);
}

function defaultSince(): string {
  // 60-day lookback in Gmail's YYYY/MM/DD form.
  const d = new Date(Date.now() - 60 * 24 * 3600 * 1000);
  return `${d.getUTCFullYear()}/${String(d.getUTCMonth() + 1).padStart(2, "0")}/${String(
    d.getUTCDate()
  ).padStart(2, "0")}`;
}

export const runSyncWorkflow = DBOS.registerWorkflow(runSyncBody, { name: "runSyncWorkflow" });
