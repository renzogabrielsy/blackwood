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
 *   ONE IMAP SESSION PER RUN (2026-07-28, BUG-019): the whole body runs inside
 *   `withGmailRunLease` (lib/gmailSession.ts), which pins the shared Gmail session for
 *   the run. Stage 1 opens it; the labelers (2b), the flecon fetcher (2b) and the
 *   schedule fetcher (3c) reuse it instead of opening their own. Released in a
 *   `finally`, so it closes exactly once on success, failure and cancellation alike.
 *   See specs/SHARED.md §1.8.
 *
 *   Stage 1 — Mail Clerk (child workflow): ONE Gmail session → all report files into
 *             Supabase Storage. gsheet is NOT an email — its download is storage-ized
 *             inside the gsheet report (download.ts), so every report reads from a
 *             stable source and a crash mid-run never re-hits Gmail for what's done.
 *
 *   Stage 1b — date-settlement ledger (persistSettlements, 2026-07-12/07-13). Runs
 *              IMMEDIATELY after Stage 1 (manifestResolved) and BEFORE every reader of
 *              `rc_out_date_settlements` this run — the parallel writers (Stage 2b) and
 *              the shadow reconcile (Stage 3) both call `db.readSettledDates()` fresh, so
 *              writing the ledger first means a date settled THIS run is skipped by BOTH
 *              same-run, not just by Stage 3 as before. Depends only on `runId` +
 *              `manifestResolved` — see the function doc for the dependency proof.
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
import { withGmailRunLease } from "../lib/gmailSession.js";
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
import { rcOutSumsFromRows } from "../reports/rc_out/reconcile.js";
import { computeQualifyingSettlements, SETTLEMENT_BACKFILL_FLOOR } from "./settlement.js";
import {
  reResolveCreationRaceHolds,
  type CreationRaceOutcome,
  type HeldRowLike,
  type RecordExistsFn,
} from "./creationRaceHolds.js";
import {
  refreshProductionSchedule,
  type ScheduleConflict,
} from "../reports/prodSchedule/refresh.js";
import { planGsheetCloses, toChannelBatchCloses, type BatchClose, type BatchDirEntry } from "../lib/gsheetCloseScan.js";
import { findStaleStreams, describeStaleStream, type StaleStream } from "../lib/streamStaleness.js";
import { generateRunReport } from "../reports/excel/generate.js";
import type { AppSyncRunResult } from "../reports/excel/findingsBridge.js";

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

  // ── Stage 1b: settle balanced dates FIRST so the writers + reconcile skip them
  // same-run (2026-07-13, Renzo's directive — moved from the old post-writers "Stage 2d"
  // position). Depends ONLY on `runId` + `manifestResolved` (verified — see
  // persistSettlements' doc comment): it does NOT read `since`, does NOT read any
  // Stage-2 writer/reconcile output, and does its own DB read for the rc_out sums it
  // compares against the movement witness. Running it here means Stage 2b's rc_out
  // writer AND Stage 3's reconcileRcOutShadow both see the freshly-written ledger via
  // their own `db.readSettledDates()` call — previously only Stage 3 benefited
  // same-run because Stage 2b had already read (and found empty) the ledger by the
  // time the old Stage 2d ran.
  //
  // Accepted tradeoff: a date that would only balance AFTER this run's OWN writes
  // (Stage 2b below) now settles on the NEXT run instead of this one — recent dates
  // are cheap to re-check every run, so that's fine. The expensive problem this
  // solves is old, ALREADY-balanced dates (settled before this run even started)
  // getting re-walked through the writers'/reconcile's full-history extract on every
  // run — those settle here and are skipped same-run, same as before. Guarded
  // end-to-end: any failure is a silent no-op (settlement is a re-ingestion
  // optimization, never a correctness requirement).
  await DBOS.runStep(
    () => persistSettlements(runId, manifestResolved),
    { name: "persistSettlements" },
  );

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

  // ── Stage 2b′: post-writers re-resolve pass — auto-clear the creation-race false holds.
  // gsheet classified BEFORE the parallel writers ran, so a BRAND-NEW batch created by the
  // deliveries/rc_out writer ~1s later left gsheet holding the row `unmapped_batch_code` — a
  // pure timing artifact (the batch + its row now exist). Reload the FRESH batch lookup,
  // re-resolve each such hold, and DROP the ones whose record a sibling already wrote. This
  // pass is READ-ONLY (no operational writes) — it only removes confirmed-redundant holds from
  // the assembled result so the app fan-out (ensureCasesForRun) never opens a case for them.
  // Guarded end-to-end (any failure leaves the holds as-is; never fails the run). See
  // workflows/creationRaceHolds.ts. dryRun → gsheet apply is null → no-op.
  const raceOutcome = await DBOS.runStep(
    () => resolveCreationRaceHolds(runId, reports.gsheet?.apply?.held ?? null),
    { name: "resolve:creation_race_holds" },
  );
  if (raceOutcome.newHeld && reports.gsheet?.apply) {
    reports.gsheet.apply.held = raceOutcome.newHeld;
  }

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

  // ── Stage 3c: production-PLAN refresh — orthogonal, non-fatal, additive. Re-parses
  // Renzo's PROD SCHED tab (re-downloads the Sheet, same as the reconcile shadows do —
  // the gsheet report's buffer lives inside its isolated child workflow and is not
  // threaded across the DBOS boundary; a multi-MB Buffer in a workflow result would bloat
  // the checkpoint), overlays Joseph Go's latest schedule email (guarded — Renzo-only on
  // any Joseph failure), and writes `production_schedule` CONDITIONALLY (2026-07-30):
  // unchanged revisions write nothing, reported days are frozen, and a human-owned day's
  // upstream value is PARKED rather than applied. WRITES ONLY `production_schedule` — it
  // touches NO inventory/report table and can NEVER fail the run: the whole step is
  // wrapped so any throw is a logged warning and the sync continues. Returns the parked
  // conflicts so they join the run's honest findings list.
  const scheduleConflicts = await DBOS.runStep(() => refreshProdSchedule(runId), {
    name: "refresh:prod_schedule",
  });

  // ── Stage 3d: gsheet batch close-scan — CLOSE-ONLY, monotonic, additive. Reads the
  // Google Sheet RC OUT close remarks ("CLOSED"/"DONE"/…) and flips the named batch
  // IN-USE→CLOSED via `fn_close_batch` (a batches.status-only write — NEVER writes rc_out,
  // so the R4b cutover + PROPOSED-is-sole-rc_out-writer invariant hold). This closes the
  // structural gap where, under the cutover, a "CLOSED" typed into the Sheet's RC OUT tab
  // never reaches the DB close trigger. Runs AFTER the writers (Stage 2b) so a same-run
  // PROPOSED MAIN feeding can't reopen what we just closed. A close is a machine-verifiable
  // MONOTONIC state flip (the Sheet says CLOSED, nothing contradicts it), NOT a source
  // disagreement — so it is a direct write, not a reconciliation diff case. Guarded
  // end-to-end (any failure → empty list, never fails the run); a no-op on dryRun.
  const batchCloses = await DBOS.runStep(
    () => closeBatchesFromGsheet(runId, dryRun),
    { name: "close:gsheet_batches" },
  );

  // ── Stage 3e: freshness watch — READ-ONLY, never a write, never a gate. Reads
  // `view_digest_stream_status` and reports any stream that has missed a planned
  // working day. This runs LAST, after every writer, so it judges the state the run
  // actually leaves behind. It is the one finding that is about what did NOT arrive:
  // a run where nothing came in is otherwise indistinguishable from a quiet day, and
  // that is precisely how RC OUT went 5 days stale in July without anyone noticing.
  const staleStreams = await DBOS.runStep(() => checkStreamFreshness(runId), {
    name: "check:stream_freshness",
  });

  // Merge the orthogonal reconciliation channels (any may be absent).
  const hasCloses = batchCloses.length > 0;
  const hasScheduleConflicts = scheduleConflicts.length > 0;
  const hasStaleStreams = staleStreams.length > 0;
  const reconciliation: ReconciliationChannel | undefined =
    rcOutRecon || blockingRecon || hasCloses || hasScheduleConflicts || hasStaleStreams
      ? {
          ...(rcOutRecon ?? {}),
          ...(blockingRecon ? { blocking: blockingRecon } : {}),
          ...(hasCloses ? { batch_closes: batchCloses } : {}),
          ...(hasScheduleConflicts ? { schedule_conflicts: scheduleConflicts } : {}),
          ...(hasStaleStreams ? { stale_streams: staleStreams } : {}),
        }
      : undefined;

  // ── Aggregate: any report failing either phase → the run is "partial".
  const anyFailed = Object.values(reports).some(reportFailed);
  const status: "succeeded" | "partial" = anyFailed ? "partial" : "succeeded";

  const baseResult: RunSyncResult = {
    runId,
    dryRun,
    manifest: manifestResolved,
    reportsWithFiles,
    reports,
    ...(reconciliation ? { reconciliation } : {}),
    status,
  };

  // ── Stage 4: the Excel sync report — the LAST thing the run does, and the only stage
  // whose failure is guaranteed to be harmless. It renders `baseResult` (the exact object
  // about to be persisted) into a workbook, stores it in the private `sync-reports` bucket
  // and records it in `sync_run_reports`.
  //
  // It runs BEFORE finishRun for one specific reason: a generation FAILURE has to reach the
  // operator, and the only durable channel to the panel is `sync_runs.result`. So the
  // artifact pointer is folded into the result that finishRun then writes. The workbook
  // itself is built from `baseResult`, which does not contain the pointer — a report cannot
  // hold the record of its own failure, and would be stale the moment it tried.
  //
  // `generateRunReport` never throws (see its doc). The pointer is attached on success too:
  // it is provenance, it lets the panel offer the download without a second query, and only
  // `ok:false` becomes a finding.
  const reportArtifact = await DBOS.runStep(
    () => generateRunReport(runId, { result: baseResult as unknown as AppSyncRunResult, status }),
    { name: "report:excel" },
  );

  const result: RunSyncResult = {
    ...baseResult,
    reconciliation: {
      ...(reconciliation ?? {}),
      report_artifact: reportArtifact,
    },
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
 * Fix 1 STEP — the post-writers creation-race re-resolve pass. Reloads a FRESH
 * batch_code → batch_id lookup (now including batches the parallel writers created this
 * run), re-resolves every gsheet `unmapped_batch_code` hold, and returns the rebuilt
 * held array + telemetry. READ-ONLY: the only DB touches are the batch lookup + the
 * per-row existence probe. Guarded — any failure returns a no-op outcome (holds kept
 * as-is), NEVER fails the run. Deterministic on replay: the workflow re-hydrates the
 * returned outcome from the checkpoint and re-applies the (deterministic) assignment.
 */
async function resolveCreationRaceHolds(
  runId: string,
  gsheetHeld: readonly HeldRowLike[] | null,
): Promise<CreationRaceOutcome> {
  const noop: CreationRaceOutcome = { autoCleared: 0, reclassified: 0, keptUnmapped: 0 };
  if (!gsheetHeld || gsheetHeld.length === 0) return noop;
  if (!gsheetHeld.some((h) => h.kind === "unmapped_batch_code")) return noop;

  try {
    const db = DbClient.fromEnv();
    const emit = makeEmitter(db, runId, "_run");

    // FRESH batch_code → batch_id lookup — includes batches the writers just created.
    const batchLookup: Record<string, string> = {};
    const batchRows = await db.readRows("batches", {
      columns: ["batch_code", "id"],
      sinceColumn: null,
    });
    for (const b of batchRows) {
      if (b.batch_code) batchLookup[String(b.batch_code)] = String(b.id);
    }

    const recordExists: RecordExistsFn = (a) =>
      creationRaceRecordExists(db, a.mode, a.resolvedCode, a.resolvedId, a.row);
    const outcome = await reResolveCreationRaceHolds(gsheetHeld, batchLookup, recordExists);

    if (outcome.autoCleared > 0 || outcome.reclassified > 0) {
      await emit(
        "reconcile",
        `Re-checked new-batch holds — cleared ${outcome.autoCleared} timing false-alarm(s)` +
          (outcome.reclassified ? `, ${outcome.reclassified} now need a write` : ""),
        95,
        undefined,
        outcome.reclassified > 0 ? "warn" : "info",
      );
    }
    return outcome;
  } catch {
    // Read-only self-heal — a failure must never fail the run or change a write.
    return noop;
  }
}

/**
 * READ-ONLY existence probe for the creation-race pass: did a sibling writer already
 * write THIS held row's record? rc_in → a `deliveries` row on (date, resolved batch_code,
 * block, weight±1kg); rc_out → an `rc_out` row on (date, resolved batch_id, dest,
 * weight±1kg). Weight is matched within 1 kg to tolerate per-block/per-truck aggregation.
 */
async function creationRaceRecordExists(
  db: DbClient,
  mode: string | null,
  resolvedCode: string,
  resolvedId: string,
  row: Record<string, unknown>,
): Promise<boolean> {
  const date = (row.transaction_date as string | null) ?? null;
  if (!date) return false;
  const w = row.weight_kg == null ? null : Number(row.weight_kg);
  const wOk = (rw: number | null): boolean => w === null || rw === null || Math.abs(rw - w) <= 1.0;

  if (mode === "rc_in") {
    const block = row.block_loc ? String(row.block_loc).trim().toUpperCase() : null;
    const rows = await db.readRows("deliveries", {
      sinceColumn: null,
      columns: ["transaction_date", "batch_code", "block_loc", "weight_kg"],
      extraFilters: { transaction_date: `eq.${date}`, batch_code: `eq.${resolvedCode}` },
    });
    return rows.some((r) => {
      const rb = r.block_loc ? String(r.block_loc).trim().toUpperCase() : null;
      const rw = r.weight_kg == null ? null : Number(r.weight_kg);
      const blockOk = block === null || rb === block;
      return blockOk && wOk(rw);
    });
  }

  // rc_out (also covers a null/unknown mode — rc_out is the fine-key table).
  const dest = (row.destination as string | null) || "MAIN";
  const rows = await db.readRows("rc_out", {
    sinceColumn: null,
    columns: ["transaction_date", "batch_id", "destination", "weight_kg"],
    extraFilters: { transaction_date: `eq.${date}`, batch_id: `eq.${resolvedId}` },
  });
  return rows.some((r) => {
    const rd = (r.destination as string | null) || "MAIN";
    const rw = r.weight_kg == null ? null : Number(r.weight_kg);
    return rd === dest && wOk(rw);
  });
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

    // DATE-SETTLEMENT LEDGER (2026-07-12): drop proposed + gsheet rows on a settled date
    // BEFORE bucketing, so source_diff / single_source_overdue / attribution_diff /
    // unresolved_batch are never generated for it. Guarded — a failed read just means no
    // dates are filtered this run (fail-safe: narrows nothing, never wrongly excludes a
    // date that should still be reconciled). Note the R4b window (proposed-span ± buffer,
    // computed inside reconcileRcOut from the records themselves) can only get NARROWER
    // from pre-filtering settled dates out of the proposed span — never wider — so this
    // filter cannot accidentally widen the actionable window past what it already was.
    let settledDates = new Set<string>();
    try {
      settledDates = await db.readSettledDates();
    } catch {
      /* non-fatal — proceed unfiltered (shadow) */
    }
    if (settledDates.size) {
      proposed = proposed.filter((r) => !settledDates.has(r.transaction_date));
      gsheetRcOut = gsheetRcOut.filter(
        (r) => !settledDates.has(String((r as { transaction_date?: string | null }).transaction_date ?? "")),
      );
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
    const flags =
      rc_out.diffs.length +
      rc_out.heldOverdue.length +
      rc_out.unresolvedBatches.length +
      rc_out.attributionDiffs.length;
    await emit(
      "reconcile",
      flags > 0
        ? `Cross-checked sources — ${flags} item(s) to review`
        : "Cross-checked sources — all agree",
      96,
      undefined,
      flags > 0 ? "warn" : "info",
    );
    // Patio block-name aliases (reconcile/blockAliases.ts, 2026-07-13) — visibility line.
    // These are NOT part of `flags`: an aliased row that fully agrees never became a
    // diff/held/attribution case in the first place, so this is reported separately so
    // the alignment stays visible even on an otherwise all-clear run.
    if (rc_out.patioAliasesApplied > 0) {
      await emit(
        "reconcile",
        `Auto-matched ${rc_out.patioAliasesApplied} patio feeding(s) via block aliases — ` +
          `proposed descriptive names reconciled to the Sheet's coded blocks.`,
        96,
        undefined,
        "info",
      );
    }
    return { rc_out };
  } catch {
    // Shadow observer: a failure here must never fail the run or change a write.
    return null;
  }
}

/**
 * Stage 3d STEP — the gsheet batch close-scan. Re-downloads the Sheet, extracts its RC OUT
 * rows, and closes each batch whose row carries a closing remark ("CLOSED"/"DONE"/…) via
 * `fn_close_batch` — a `batches.status`-only write (the ONE close entry point). This is how
 * a "CLOSED" typed into the Sheet reaches the DB under the R4b cutover: gsheet no longer
 * writes rc_out, so the DB close trigger never sees the remark, and the batch would stay
 * IN-USE forever. CLOSE-ONLY + MONOTONIC — `fn_close_batch` never re-opens, and the scan
 * only flips batches that are not already CLOSED. A close is a machine-verifiable state flip
 * (the Sheet says CLOSED, nothing contradicts it), so it writes directly and is NOT a
 * reconciliation diff case. Returns the surfaced `BatchClose[]` (actually-flipped closes +
 * unmatched warnings; already-closed no-ops are silent) for the run result / findings.
 * Guarded end-to-end — any failure returns [] and never fails the run; a dry run writes
 * nothing and returns [].
 */
async function closeBatchesFromGsheet(runId: string, dryRun: boolean): Promise<BatchClose[]> {
  if (dryRun) return [];
  try {
    const db = DbClient.fromEnv();
    const emit = makeEmitter(db, runId, "_run");

    // Re-download + extract the Sheet's RC OUT rows (self-download; no Storage copy). A
    // network failure just drops the scan for this run.
    let gsheetRcOut: ReturnType<typeof extractGsheet>["rc_out"]["rows"] = [];
    try {
      const buf = await downloadGsheet(globalThis.fetch as unknown as FetchLike, GSHEET_EXPORT_URL);
      gsheetRcOut = extractGsheet(await loadWorkbook(buf)).rc_out.rows;
    } catch {
      return [];
    }
    if (!gsheetRcOut.length) return [];

    // Live batch directory keyed by batch_code → {id, status, location_ref}.
    const batchByCode: Record<string, BatchDirEntry> = {};
    try {
      const rows = await db.readRows("batches", {
        columns: ["batch_code", "id", "status", "location_ref"],
        sinceColumn: null,
      });
      for (const b of rows) {
        const code = b.batch_code;
        if (code) {
          batchByCode[String(code)] = {
            id: String(b.id),
            status: String(b.status ?? ""),
            location_ref: b.location_ref == null ? null : String(b.location_ref),
          };
        }
      }
    } catch {
      return []; // no directory → cannot safely resolve → skip (fail-safe)
    }

    const plan = planGsheetCloses(gsheetRcOut, batchByCode);
    if (!plan.closes.length && !plan.unmatched.length) return [];

    // Apply the closes (batches.status-only, monotonic) + audit each. Per-close guarded so a
    // single failure never aborts the rest or the run.
    const applied: typeof plan.closes = [];
    for (const c of plan.closes) {
      try {
        const flipped = await db.closeBatch(c.batch_id);
        if (!flipped) continue; // already CLOSED by the time we got here — nothing to report
        applied.push(c);
        try {
          await db.writeIngestionAudit({
            tableName: "batches",
            recordId: c.batch_id,
            operation: "UPDATE",
            comment:
              `provenance=gsheet close-scan | Closed batch ${c.batch_code} from a Google Sheet ` +
              `RC OUT close remark (block ${c.block_loc ?? "?"}, ${c.transaction_date ?? "?"}, row ` +
              `${c.source_row ?? "?"}). batches.status-only write — rc_out untouched (R4b cutover).`,
            diff: { status: { new: "CLOSED" } },
          });
        } catch {
          /* audit is provenance-only; a failure must not fail the close */
        }
        await emit(
          "reconcile",
          `Closed batch ${c.batch_code} — feeding marked done on the Sheet` +
            (c.block_loc ? ` (block ${c.block_loc})` : ""),
          97,
          undefined,
          "info",
        );
      } catch {
        /* one close failing must not abort the scan */
      }
    }

    for (const u of plan.unmatched) {
      await emit(
        "reconcile",
        `Sheet marked ${u.requested_code ?? "a block"} CLOSED but no matching batch exists — skipped.`,
        97,
        `transaction_date=${u.transaction_date ?? "?"} block=${u.block_loc ?? "?"} row=${u.source_row ?? "?"}`,
        "warn",
      );
    }

    // Surface only ACTUALLY-flipped closes + unmatched warnings (already-closed no-ops stay
    // silent) on the reconciliation channel.
    return toChannelBatchCloses({
      closes: applied,
      alreadyClosed: plan.alreadyClosed,
      unmatched: plan.unmatched,
    });
  } catch {
    return [];
  }
}

/**
 * DATE-SETTLEMENT LEDGER writer (2026-07-12, Renzo's directive; moved to Stage 1b on
 * 2026-07-13 — see the file-header stage list and the call site above). A dedicated
 * stage — NOT inside rc_movement_audit, which must stay "never writes to the DB"
 * (specs/rc_movement_audit.md §1 "No apply phase"). Computes the settle criterion (pure
 * core: `./settlement.ts`) from two independent witnesses and persists newly-qualifying
 * dates to `rc_out_date_settlements`. FULL-HISTORY BACKFILL: reads rc_out sums since
 * `SETTLEMENT_BACKFILL_FLOOR` (not just this run's tail window) so the first run after
 * this ships settles every already-balanced historical date at once — the auditor's own
 * 30-day lookback window is too narrow for that (rc_movement_audit.md §1:
 * `watermark - 30 days`). Guarded end-to-end: any failure, or no movement witness this
 * run, is a silent no-op — settlement is a re-ingestion optimization, never a correctness
 * requirement, and must never fail or slow down the run.
 *
 * DEPENDENCY PROOF (why this is safe to run BEFORE the parallel writers / Stage 2b):
 * this function's only inputs are `runId` and `manifest` (the resolved Mail Clerk
 * manifest from Stage 1 — read here only for `firstAtt(manifest, "rc_out_movement")`,
 * a Storage path, not report output). Everything else is its own DB read
 * (`db.readSettledDates()`, `db.readRows("rc_out", …)` since the fixed backfill floor)
 * and its own file fetch/extract (`extractMovement`). It does NOT read `since`, does
 * NOT read `reports.*` (gsheet/deliveries/rc_out/production/flecon output), and does
 * NOT read the Stage 3 reconciliation channel. So moving its call site earlier changes
 * nothing about what it computes THIS run — it only changes how early the ledger row
 * lands, which is the whole point (Stage 2b's rc_out writer and Stage 3's
 * reconcileRcOutShadow both call `db.readSettledDates()` fresh, so an earlier write is
 * visible to both same-run instead of only to Stage 3).
 */
async function persistSettlements(runId: string, manifest: MailClerkManifest): Promise<void> {
  try {
    const db = DbClient.fromEnv();
    const emit = makeEmitter(db, runId, "_run");

    // Can't verify without the movement witness — skip entirely (non-fatal).
    const movementAtt = firstAtt(manifest, "rc_out_movement");
    if (!movementAtt) return;

    let movementByDate: Record<string, number>;
    try {
      const fetchToLocalPath = makeStorageFetcher();
      const path = await fetchToLocalPath(movementAtt.storagePath);
      movementByDate = extractMovement(await loadWorkbook(await readFile(path))).date_to_fed_kls;
    } catch {
      return; // movement attachment unreadable → can't verify, skip (non-fatal)
    }

    const settledAlready = await db.readSettledDates();

    // Cheap 2-column aggregate over full history — only dates NOT already settled matter.
    const dbRows = await db.readRows("rc_out", {
      sinceDate: SETTLEMENT_BACKFILL_FLOOR,
      columns: ["transaction_date", "weight_kg"],
    });
    const dbSums = rcOutSumsFromRows(dbRows);

    const qualifying = computeQualifyingSettlements(dbSums, movementByDate, settledAlready);
    if (qualifying.length === 0) return;

    const { insertedCount } = await db.insertSettlements(
      qualifying.map((q) => ({ ...q, settled_by_run_id: runId })),
    );
    if (insertedCount > 0) {
      const total = settledAlready.size + insertedCount;
      await emit(
        "reconcile",
        `Settled ${insertedCount} new date(s) · ${total} total settled — future runs will skip them.`,
        97,
      );
    }
  } catch {
    // Non-fatal: settlement is a re-ingestion optimization, never blocks or fails the run.
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

/**
 * NON-FATAL production-schedule refresh step (Stage 3c). Delegates to
 * refreshProductionSchedule (reports/prodSchedule/refresh.ts), which is itself fully
 * guarded and returns ok:false rather than throwing. This wrapper adds the progress
 * beats and a belt-and-braces try/catch so NOTHING here can fail the sync run — the
 * production PLAN feeds a read-only Home Digest band, never a write gate.
 *
 * Emits one info/warn beat describing the outcome (what was written vs left alone, Joseph
 * overlay applied or the Renzo-only fallback reason). A total failure logs a single warn
 * and returns [] — the NON-FATAL contract is unchanged: this step can never fail a run.
 *
 * Returns the human-owned days whose upstream value was PARKED this run, so runSync can
 * fold them into `result.reconciliation.schedule_conflicts` → the panel's findings list.
 * An empty array on every failure path.
 */
async function refreshProdSchedule(runId: string): Promise<ScheduleConflict[]> {
  try {
    const db = DbClient.fromEnv();
    const emit = makeEmitter(db, runId, "_run");
    const res = await refreshProductionSchedule({ db });
    if (!res.ok) {
      await emit(
        "reconcile",
        "Skipped the production-plan refresh this run.",
        99,
        res.error,
        "warn",
      );
      return [];
    }
    const josephBit = res.joseph
      ? `Joseph ${res.joseph.sourceTag} overlaid ${res.joseph.overridden} day(s)`
      : `Renzo-only${res.josephSkippedReason ? ` (${res.josephSkippedReason})` : ""}`;

    const p = res.plan;
    const parked = res.conflicts.length;
    // The honest headline: in the steady state this reads "nothing to change".
    const changed =
      res.upserted === 0
        ? "nothing to change"
        : `${res.upserted} day(s) updated (${p.inserted} new, ${p.applied} changed, ${p.reclaimed} back in sync)`;
    const held = parked
      ? ` ${parked} day(s) you edited were left alone — Joseph's version is waiting for your decision.`
      : "";
    const frozen = p.frozen + p.frozenAtWrite;
    const frozenBit = frozen ? ` ${frozen} day(s) already reported — untouched.` : "";

    await emit(
      "reconcile",
      `Production plan — ${changed}, ${res.minDate}..${res.maxDate}. ${josephBit}.${held}${frozenBit}`,
      99,
      [
        res.joseph?.warnings.length ? `${res.joseph.warnings.length} schedule warning(s)` : null,
        p.versionConflicts
          ? `${p.versionConflicts} day(s) changed underneath the sync and were not written`
          : null,
      ]
        .filter(Boolean)
        .join(" · ") || undefined,
      parked > 0 ? "warn" : "info",
    );
    return res.conflicts;
  } catch (err) {
    // Belt-and-braces: refreshProductionSchedule already guards, but a failure in the
    // emitter/db construction must still never fail the run.
    // eslint-disable-next-line no-console
    console.error(
      `[warn] production-schedule refresh step failed (non-fatal): ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return [];
  }
}

/**
 * checkStreamFreshness — the freshness watch (Stage 3e).
 *
 * Reads `view_digest_stream_status` and emits ONE beat naming every stream that has
 * missed a planned working day. The lateness arithmetic is entirely the view's (rest
 * days and not-yet-due next-day reports are already excluded there), so this only
 * decides how to say it.
 *
 * NON-FATAL, like every other Stage-3 channel: any throw is swallowed and returns [].
 * A watchdog that can fail the thing it watches is worse than no watchdog.
 *
 * Returns the stale streams so runSync can fold them into
 * `result.reconciliation.stale_streams` → the panel's findings list.
 */
async function checkStreamFreshness(runId: string): Promise<StaleStream[]> {
  try {
    const db = DbClient.fromEnv();
    const emit = makeEmitter(db, runId, "_run");
    const stale = await findStaleStreams(db);

    if (stale.length === 0) {
      await emit("reconcile", "Every report stream is up to date.", 99, undefined, "info");
      return [];
    }

    const worst = stale[0].missed_working_days;
    const names = stale.map((s) => s.label).join(", ");
    await emit(
      "reconcile",
      `${stale.length} report stream(s) behind: ${names}. Worst is ${worst} working day(s) with no report.`,
      99,
      stale.map(describeStaleStream).join(" "),
      "warn",
    );
    return stale;
  } catch (err) {
    // Never fails the run — see the module note.
    DBOS.logger.warn(`stream freshness check skipped: ${String(err)}`);
    return [];
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
    // ── ONE IMAP SESSION PER RUN (BUG-019). The lease PINS the shared Gmail session
    // (lib/gmailSession.ts) for the whole run without forcing a connect: the Mail Clerk
    // opens it in Stage 1, and the labelers (Stage 2b), the flecon fetcher and the
    // schedule fetcher (Stage 3c) all reuse that same connection instead of opening
    // their own. `withGmailRunLease` releases in a `finally`, so the session is closed
    // exactly once — on success, on failure, and on a DBOS cancellation alike.
    return await withGmailRunLease(() => runSyncBody(params));
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
  // A crashed run gets a report TOO — with no findings, but with the full Run Log, which is
  // exactly what someone wants when a run died. Best-effort and last: the terminal status is
  // already written, so nothing here can make the failure worse.
  await generateReportQuietly(runId, { result: null, status: "failed", runError: message });
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
  // A stopped run kept every row it had already written, so its log is worth reading.
  await generateReportQuietly(runId, { result: null, status: "cancelled" });
}

/**
 * Report generation on the TERMINAL-FAILURE paths (`failRun` / `cancelRun`).
 *
 * `generateRunReport` already never throws, so this wrapper exists for one reason: those two
 * paths run inside a `catch` that is about to re-throw the original error, and nothing there
 * may introduce a new one. Belt and braces — the original failure is the one that must
 * survive, not a reporting hiccup on top of it.
 */
async function generateReportQuietly(
  runId: string,
  opts: { result: null; status: string; runError?: string },
): Promise<void> {
  try {
    await generateRunReport(runId, opts);
  } catch {
    /* the crash we are already reporting is the one that matters */
  }
}

export const runSyncWorkflow = DBOS.registerWorkflow(runSyncGuarded, { name: "runSyncWorkflow" });
