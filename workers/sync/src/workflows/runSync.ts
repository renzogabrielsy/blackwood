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
import { readFile } from "node:fs/promises";

import { DBOS, Error as DBOSErrors } from "@dbos-inc/dbos-sdk";
import { mailClerkWorkflow, type MailClerkManifest, type StoredAttachment } from "./mailClerk.js";
import { reportWorkflow, type ReportEnvelope, type RunReportType } from "./reportWorkflow.js";
import { failedReportResult } from "./normalizeReport.js";
import { makeStorageFetcher } from "./reportDeps.js";
import { DbClient } from "../lib/db.js";
import { makeEmitter } from "../lib/progress.js";
import { loadWorkbook } from "../lib/xlsx.js";
import { mailClerkWorkflowId, reportWorkflowId } from "./ids.js";
import { extractProposed, extractMovement } from "../reports/rc_out/extract.js";
import { extractGsheet } from "../reports/gsheet/extract.js";
import { extractBlockingTab } from "../reports/gsheet/blocking.js";
import { downloadGsheet, GSHEET_EXPORT_URL, type FetchLike } from "../reports/gsheet/download.js";
import { reconcileRcOutStage, type ReconciliationChannel } from "../reconcile/rcOutStage.js";
import {
  reconcileBlockBalance,
  type BlockReconciliation,
  type ComputedBlock,
} from "../reconcile/blockBalance.js";
import { rcOutReconcileCutover } from "../lib/env.js";

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
  /**
   * R2 SHADOW: multi-source reconciliation output. Additive + observational — it
   * surfaces cross-source disagreements as `source_diff` cases (app fan-out) and
   * NEVER changes any write behavior. Absent when the reconcile stage found nothing
   * to compare or failed (shadow failures never fail the run). Sits ALONGSIDE
   * `reports`, so normalizeReport (which shapes per-report envelopes only) leaves it
   * untouched — it survives the assembly boundary as-is.
   */
  reconciliation?: ReconciliationChannel;
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

  // ── Stage 3: reconciliation — rc_out only, additive, no writes of its own.
  // Re-extracts the same three witnesses the reports read (proposed + movement from
  // Storage, gsheet re-download), buckets them into R1 SourceRecords, and captures the
  // disagreements. It still WRITES nothing itself (proposed remains the rc_out writer), but
  // under the R4b cutover it is the FLAGGING AUTHORITY: gsheet no longer clobbers rc_out, so
  // a gsheet↔proposed disagreement in-window becomes a `source_diff` / `single_source_overdue`
  // case here rather than a silent overwrite. Wrapped so ANY failure degrades to an absent
  // channel — this step must never fail a run or change a write. See reconcile/rcOutStage.ts.
  const rcOutRecon = await DBOS.runStep(
    () => reconcileRcOutShadow(runId, manifestResolved, since),
    { name: "reconcile:rc_out" },
  );

  // ── Stage 3b: RB block-balance cross-check — orthogonal, read-only. Extracts the Sheet
  // Blocking tab (previously never read) + reads the computed view_blocking_grid and
  // compares per-block + grand-total (SYNC_RECONCILIATION_MODEL.md RB). Produces
  // `block_diff` descriptors only — it writes NOTHING and never fails a run. Absent
  // channel on any failure or when the Sheet has no Blocking tab this run.
  const blockingRecon = await DBOS.runStep(
    () => reconcileBlockBalanceShadow(runId),
    { name: "reconcile:blocking" },
  );

  // Merge the two orthogonal reconciliation channels (either may be absent).
  const reconciliation: ReconciliationChannel | undefined =
    rcOutRecon || blockingRecon
      ? { ...(rcOutRecon ?? {}), ...(blockingRecon ? { blocking: blockingRecon } : {}) }
      : undefined;

  // ── Aggregate: any report failing either phase → the run is "partial".
  const anyFailed = Object.values(reports).some(reportFailed);
  const status: "succeeded" | "partial" = anyFailed ? "partial" : "succeeded";

  const result: RunSyncResult = {
    runId,
    dryRun,
    manifest: manifestResolved,
    reportsWithFiles,
    reports,
    ...(reconciliation ? { reconciliation } : {}),
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

/** First stored attachment for a manifest key, or null. */
function firstAtt(manifest: MailClerkManifest, key: string): StoredAttachment | null {
  const arr = manifest.reports[key];
  return arr && arr.length ? arr[0] : null;
}

/**
 * SHADOW reconcile step (R2). Re-extracts the three rc_out witnesses and runs the R1
 * engine over them, returning ONLY diffs + an agreement count — it applies nothing and
 * changes no write path. Every extraction is independently guarded; a source that is
 * missing or unreadable simply contributes no records. The whole body is wrapped so a
 * failure returns `null` (channel absent) and NEVER propagates — a shadow observer must
 * not break the run.
 *
 * Re-extraction (rather than threading rows out of the isolated report child-workflows)
 * is the minimal shadow-safe wiring: it touches ZERO report classify/apply/extract code
 * and is crash-safe (it re-derives from durable Storage + the Sheet inside its own DBOS
 * step). Cost: one extra Sheet download + two Storage reads per run. See rcOutStage.ts.
 */
async function reconcileRcOutShadow(
  runId: string,
  manifest: MailClerkManifest,
  since: string,
): Promise<ReconciliationChannel | null> {
  try {
    const db = DbClient.fromEnv();
    const emit = makeEmitter(db, runId, "_run");
    const fetchToLocalPath = makeStorageFetcher();
    const year = parseInt(since.slice(0, 4), 10) || new Date().getUTCFullYear();

    // PROPOSED (fine source) — from the Mail Clerk Storage manifest.
    let proposed: ReturnType<typeof extractProposed>["rows"] = [];
    const proposedAtt = firstAtt(manifest, "rc_out");
    if (proposedAtt) {
      try {
        const path = await fetchToLocalPath(proposedAtt.storagePath);
        proposed = extractProposed(await loadWorkbook(await readFile(path)), year).rows;
      } catch {
        /* absent/unreadable proposed → no proposed records (shadow) */
      }
    }

    // RC MOVEMENT (date-level witness) — from the Storage manifest.
    let movementByDate: Record<string, number> = {};
    const movementAtt = firstAtt(manifest, "rc_out_movement");
    if (movementAtt) {
      try {
        const path = await fetchToLocalPath(movementAtt.storagePath);
        movementByDate = extractMovement(await loadWorkbook(await readFile(path))).date_to_fed_kls;
      } catch {
        /* absent/unreadable movement → no corroboration witness (shadow) */
      }
    }

    // Google Sheet RC OUT (fine source) — re-downloaded (it self-downloads in its own
    // report; there is no Storage copy). A network failure just drops this witness.
    let gsheetRcOut: ReturnType<typeof extractGsheet>["rc_out"]["rows"] = [];
    try {
      const buf = await downloadGsheet(globalThis.fetch as unknown as FetchLike, GSHEET_EXPORT_URL);
      gsheetRcOut = extractGsheet(await loadWorkbook(buf)).rc_out.rows;
    } catch {
      /* Sheet unreachable → no gsheet records (shadow) */
    }

    // R4a Deliverable 1 — batch_code → batch_id map the reconciler resolves against (same shape
    // the rc_out report builds). Guarded: a failure leaves the lookup empty (tracked below).
    const batchLookup: Record<string, string> = {};
    let batchLookupOk = false;
    try {
      const batchRows = await db.readRows("batches", { columns: ["batch_code", "id"], sinceColumn: null });
      for (const b of batchRows) {
        const code = b.batch_code;
        if (code) batchLookup[String(code)] = String(b.id);
      }
      batchLookupOk = Object.keys(batchLookup).length > 0;
    } catch {
      /* no batch lookup → handled by the fail-safe below (cutover) or flood (shadow) */
    }

    // R4b FAIL-SAFE — with the cutover ON, an empty/failed batch lookup would make EVERY fine
    // row unresolvable and flood thousands of `unresolved_batch` cases. Since gsheet no longer
    // writes rc_out (the PROPOSED report is the sole writer and has its OWN batch resolver), the
    // safe degradation is to SKIP rc_out reconciliation flagging for this run and emit ONE
    // diagnostic — never a flood, never a mismap. (When the cutover is OFF we keep the R4a
    // shadow behavior: an empty lookup simply produces unresolved_batch markers as before.)
    if (rcOutReconcileCutover() && !batchLookupOk) {
      await emit(
        "reconcile",
        "Skipped the RC OUT cross-check this run — batch directory was unavailable (fail-safe).",
        96,
        "batch_code→batch_id lookup empty/failed; rc_out reconciliation flagging skipped to avoid mismapping. Proposed-report writes are unaffected.",
        "warn",
      );
      return null;
    }

    // R4a Deliverable 3 — the run's calendar date (YYYY-MM-DD) for the pending/held split.
    // Read from the run row (a fixed stored value → deterministic on replay); NEVER Date.now().
    let runDate: string | undefined;
    try {
      runDate = (await db.getSyncRunCreatedAt(runId))?.slice(0, 10) ?? undefined;
    } catch {
      /* no runDate → single-source facts get no pending/held disposition (shadow) */
    }

    const rc_out = reconcileRcOutStage({ proposed, gsheetRcOut, movementByDate, batchLookup, runDate });
    const flags = rc_out.diffs.length + rc_out.heldOverdue.length + rc_out.unresolvedBatches.length;
    await emit(
      "reconcile",
      flags > 0
        ? `Cross-checked sources — ${flags} item(s) to review`
        : "Cross-checked sources — all agree",
      96,
      undefined,
      flags > 0 ? "warn" : "info",
    );
    return { rc_out };
  } catch {
    // Shadow observer: a failure here must never fail the run or change a write.
    return null;
  }
}

/**
 * SHADOW block-balance cross-check (RB). Re-downloads the Sheet, extracts the **Blocking**
 * tab (`reports/gsheet/blocking.ts`), reads the computed `view_blocking_grid` + `batches`
 * (for the one-active-batch B3 count) over REST, and runs the pure engine
 * (`reconcile/blockBalance.ts`). Returns ONLY `block_diff` descriptors + totals — it writes
 * NOTHING to inventory tables and is fully guarded (any failure → null channel). If the
 * Sheet has no Blocking tab this run, or the Sheet has no occupied blocks, it skips
 * gracefully (null). Read-only, so no cutover fail-safe is needed.
 */
async function reconcileBlockBalanceShadow(
  runId: string,
): Promise<BlockReconciliation | null> {
  try {
    const db = DbClient.fromEnv();
    const emit = makeEmitter(db, runId, "_run");

    // Sheet side — re-download + extract the Blocking tab (self-contained; no Storage copy).
    let sheetBlocks: ReturnType<typeof extractBlockingTab>["blocks"] = [];
    let statedGrandTotalKg: number | null = null;
    try {
      const buf = await downloadGsheet(globalThis.fetch as unknown as FetchLike, GSHEET_EXPORT_URL);
      const wb = await loadWorkbook(buf);
      const sheet = wb.sheet("Blocking");
      if (!sheet) return null; // no Blocking tab this run → nothing to cross-check
      const ex = extractBlockingTab(sheet);
      sheetBlocks = ex.blocks;
      statedGrandTotalKg = ex.statedGrandTotalKg;
    } catch {
      return null; // Sheet unreachable / unreadable → skip (shadow)
    }
    if (sheetBlocks.length === 0) return null; // empty grid → nothing to compare

    // Computed side — the app's derived grid + a per-block active-batch count for B3.
    let computedBlocks: ComputedBlock[] = [];
    try {
      const viewRows = await db.readRows("view_blocking_grid", {
        columns: ["block_loc", "batch_code", "balance"],
        sinceColumn: null,
      });
      const batchRows = await db.readRows("batches", {
        columns: ["location_ref", "status"],
        sinceColumn: null,
      });
      const activeCount = new Map<string, number>();
      for (const b of batchRows) {
        const loc = b.location_ref ? String(b.location_ref).trim().toUpperCase() : "";
        if (!loc) continue;
        if (String(b.status ?? "") === "CLOSED") continue;
        activeCount.set(loc, (activeCount.get(loc) ?? 0) + 1);
      }
      computedBlocks = viewRows.map((r) => {
        const loc = String(r.block_loc ?? "").trim().toUpperCase();
        return {
          block_loc: loc,
          batch_code: r.batch_code ? String(r.batch_code) : null,
          balance_kg: r.balance == null ? null : Number(r.balance),
          activeBatchCount: activeCount.get(loc) ?? 1,
        };
      });
    } catch {
      return null; // view/batches unreadable → skip (shadow)
    }

    const recon = reconcileBlockBalance(sheetBlocks, computedBlocks, { sheetStatedTotalKg: statedGrandTotalKg });
    const n = recon.blockDiffs.length;
    await emit(
      "reconcile",
      n > 0
        ? `Blocking cross-check — ${n} block(s) to review`
        : "Blocking cross-check — the Sheet and the app agree",
      98,
      undefined,
      n > 0 ? "warn" : "info",
    );
    return recon;
  } catch {
    // Read-only shadow observer: a failure here must never fail the run.
    return null;
  }
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
