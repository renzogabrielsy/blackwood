/**
 * index.ts — rc_out report port entrypoint.
 *
 * Exports:
 *   classifyCase(workbookPaths, dbWindow, opts)  — the FROZEN parity entrypoint
 *       (src/reports/types.ts). Runs extract→classify OFFLINE against the DB
 *       snapshot and returns the classify envelope (the parity oracle unit).
 *   runReport(deps, runId, manifest, opts)       — the full two-phase orchestrator
 *       (fetch-from-storage → extract → reconcile GATES → classify → apply). DB and
 *       Gmail are injected as deps; this file never imports gmail/db directly beyond
 *       the shared lib types.
 *
 * Ground truth: sync_rc_out.py (orchestration), classify_rc_out.py (classify),
 * reconcile_rc_movement.py (gates), extract_proposed_daily.py + extract_rc_movement.py.
 */
import { readFile } from "node:fs/promises";

import type {
  ClassifyCase,
  ClassifyOpts,
  DbWindow,
  ClassifyEnvelope,
} from "../types.js";
import { loadWorkbook } from "../../lib/xlsx.js";
import type { DbClient } from "../../lib/db.js";
import type { ProgressEmitter } from "../../lib/progress.js";

import { extractProposed, extractMovement } from "./extract.js";
import { classifyRcOut, type ClassifyResult, type RcOutDbRow, type BatchLookup } from "./classify.js";
import {
  reconcile,
  rcOutSumsFromRows,
  type RcOutSums,
} from "./reconcile.js";
import { applyRcOut, type RcOutCompact, type ApplyResult } from "./apply.js";

export const REPORT_TYPE = "rc_out";

const CODIFIED_RULES = [
  "rounding-null-zero-noop",
  "L-019",
  "L-020",
  "rc_out-drift-gate-500kg",
  "rc_out-db-duplication-gate",
  "batch_code-fallback-prefixes",
  "never-auto-create-batch",
] as const;

// ---------------------------------------------------------------------------
// FROZEN classify entrypoint (types.ts). Parity harness calls this per fixture.
// ---------------------------------------------------------------------------

/**
 * Runs the rc_out extract→classify pipeline offline. Reads ONLY the workbook(s) in
 * `workbookPaths` (role `primary` = PROPOSED) and the `dbWindow` snapshot; never a
 * live DB. The movement workbook role is NOT consumed here — reconciliation is
 * orchestrator-level and not part of the classify oracle (fixtures/rc_out manifest).
 *
 * `opts.since` → year = int(since[:4]); `opts.watermark` → sub-watermark guard.
 */
export const classifyCase: ClassifyCase = async (
  workbookPaths: Record<string, string>,
  dbWindow: DbWindow,
  opts: ClassifyOpts,
): Promise<ClassifyEnvelope> => {
  const result = await runClassify(workbookPaths, dbWindow, opts);
  // The classify envelope IS the classify_rc_out.py result dict (top-level buckets +
  // summary). Cast through ClassifyEnvelope (the harness compares by value, not type).
  return result as unknown as ClassifyEnvelope;
};

/** Shared classify body used by BOTH classifyCase and runReport. */
async function runClassify(
  workbookPaths: Record<string, string>,
  dbWindow: DbWindow,
  opts: ClassifyOpts,
): Promise<ClassifyResult> {
  const primaryPath = workbookPaths.primary;
  const win = dbWindow as {
    rc_out?: RcOutDbRow[];
    batch_lookup?: BatchLookup;
  };
  const batchLookup: BatchLookup = win.batch_lookup ?? {};
  const dbRows: RcOutDbRow[] = win.rc_out ?? [];
  const watermark = opts.watermark ?? null;

  // A missing primary workbook = the PROPOSED email did not arrive: classify an
  // empty extract (mirrors sync_rc_out.py early-return producing zero rows), NOT throw.
  if (!primaryPath) {
    return classifyRcOut({ extractedRows: [], batchLookup, dbRows, watermark });
  }

  const year = parseInt(String(opts.since).slice(0, 4), 10);
  const buf = await readFile(primaryPath);
  const wb = await loadWorkbook(buf);
  const proposed = extractProposed(wb, year);

  return classifyRcOut({ extractedRows: proposed.rows, batchLookup, dbRows, watermark });
}

// ---------------------------------------------------------------------------
// Full orchestrator — runReport (apply-phase; DB + Gmail injected).
// ---------------------------------------------------------------------------

export interface StoredAttachmentLike {
  storagePath: string;
  filename: string;
  emailUid: number | string;
  emailSubject?: string;
  threadId?: string | null;
}

/** Per-report manifest slice: role → attachments. rc_out uses `primary` + `movement`. */
export interface RcOutManifest {
  /** key → attachments (mail clerk keys: "rc_out" primary, "rc_out_movement" auxiliary). */
  reports: Record<string, StoredAttachmentLike[]>;
}

export interface RunReportDeps {
  db: DbClient;
  /** Download a stored attachment (Storage path → local file path) — injected. */
  fetchToLocalPath: (storagePath: string) => Promise<string>;
  /** Gmail labeler — injected (apply never imports gmail). */
  labeler?: (uids: Array<number | string>) => Promise<boolean>;
  /** Progress emitter bound to (runId, "rc_out"). */
  progress?: ProgressEmitter;
  noLabel?: boolean;
  runTs?: string;
}

export interface RunReportResult {
  classify: {
    report_type: string;
    ok: boolean;
    gate_failures: Array<{ gate: string; detail: string }>;
    counts: { noop: number; insert: number; update: number; flagged: number };
    watermark: string | null;
    codified_rules_applied: readonly string[];
  };
  apply: ApplyResult;
}

/**
 * The full rc_out sync (sync_rc_out.py phase_classify + phase_apply fused into one
 * durable run for the worker). Computes `since`/`watermark` from the live DB, extracts
 * PROPOSED + (optional) RC MOVEMENT, runs the TWO HARD GATES, classifies, and applies.
 *
 * Gate semantics (rc_out.md §1/§4): if either gate trips (severity >= 2), the classify
 * envelope still carries the full classification but ok:false and apply writes nothing.
 */
export async function runReport(
  deps: RunReportDeps,
  runId: string,
  manifest: RcOutManifest,
  opts: { since?: string } = {},
): Promise<RunReportResult> {
  void runId;
  const { db } = deps;
  const emit = deps.progress;

  // Watermark + since (sync_rc_out.py:90-92).
  const watermark = await db.dataWatermark("rc_out");
  const since = opts.since ?? (watermark ? minusDaysISO(watermark, 3) : "2025-01-01");

  // Locate workbooks from the manifest (mail clerk keys → classify roles).
  const primaryAtt = firstAttachment(manifest, "rc_out");
  const movementAtt = firstAttachment(manifest, "rc_out_movement");

  if (!primaryAtt) {
    // No PROPOSED email — early return ok:true, nothing to ingest (sync_rc_out.py:98-106).
    await emit?.("finalize", "Nothing new today — no PROPOSED DAILY REPORT waiting.", 100);
    const emptyApply: ApplyResult = {
      report_type: REPORT_TYPE,
      ok: true,
      inserts: 0,
      updates: 0,
      held: [],
      labeled: false,
      watermark_updated: false,
      errors: [],
    };
    return {
      classify: {
        report_type: REPORT_TYPE,
        ok: true,
        gate_failures: [],
        counts: { noop: 0, insert: 0, update: 0, flagged: 0 },
        watermark,
        codified_rules_applied: CODIFIED_RULES,
      },
      apply: emptyApply,
    };
  }

  await emit?.("fetch", `Found the report: ${primaryAtt.emailSubject ?? "PROPOSED DAILY REPORT"}`, 15);
  const primaryPath = await deps.fetchToLocalPath(primaryAtt.storagePath);

  // Extract PROPOSED (all sheets, year from since[:4]).
  const year = parseInt(since.slice(0, 4), 10);
  await emit?.("extract", "Reading the daily feeding spreadsheet…", 28);
  const proposedWb = await loadWorkbook(await readFile(primaryPath));
  const proposed = extractProposed(proposedWb, year);

  // GATES (only when the RC MOVEMENT cross-check is present).
  const gateFailures: Array<{ gate: string; detail: string }> = [];
  if (movementAtt) {
    await emit?.("reconcile", "Cross-checking feeding totals against the movement sheet…", 42);
    const movementPath = await deps.fetchToLocalPath(movementAtt.storagePath);
    const movementWb = await loadWorkbook(await readFile(movementPath));
    const movement = extractMovement(movementWb);

    // GATE 1 — PROPOSED vs RC MOVEMENT (no sums): severity >= 2 halts.
    const rep1 = reconcile({ rows: proposed.rows }, movement, null, 50, 500);
    if (rep1.severity >= 2) {
      gateFailures.push({
        gate: "proposed_vs_movement_drift_500kg",
        detail: `${rep1.summary.drift_dates} drift date(s); serious >500kg — HALT, write nothing.`,
      });
    }

    // GATE 2 — DB-vs-RC-MOVEMENT duplication (WITH sums): O>M halts.
    const dbSumRows = await db.readRows("rc_out", {
      sinceDate: since,
      columns: ["transaction_date", "weight_kg"],
    });
    const sums: RcOutSums = rcOutSumsFromRows(dbSumRows);
    const rep2 = reconcile({ rows: proposed.rows }, movement, sums, 50, 500);
    if (rep2.severity >= 2) {
      gateFailures.push({
        gate: "db_vs_movement_duplication",
        detail:
          "rc_out DB SUM exceeds RC MOVEMENT (O>M) on a settled date — suspected duplication; HALT.",
      });
    }
  } else {
    await emit?.("reconcile", "No movement cross-check available — proceeding without drift gates.", 42, undefined, "warn");
  }

  // Classify (offline against a fresh snapshot). Build the DB window the same way the
  // orchestrator does: batch_lookup over ALL batches, rc_out over the since window.
  await emit?.("classify", "Comparing the report against the database…", 58);
  const batchRows = await db.readRows("batches", { columns: ["batch_code", "id"], sinceColumn: null });
  const batchLookup: BatchLookup = {};
  for (const b of batchRows) {
    const code = b.batch_code;
    if (code) batchLookup[String(code)] = String(b.id);
  }
  const dbRows = (await db.readRows("rc_out", {
    sinceDate: since,
    columns: ["id", "transaction_date", "batch_id", "production_batch", "destination", "weight_kg", "block_loc", "remarks"],
  })) as RcOutDbRow[];

  const classified = classifyRcOut({
    extractedRows: proposed.rows,
    batchLookup,
    dbRows,
    watermark,
  });
  const s = classified.summary;

  const gateTripped = gateFailures.length > 0;
  await emit?.(
    "classify",
    `${s.noop_count} already recorded · ${s.new_count} new · ${s.changed_count} changed`,
    90,
  );

  // Build the compact hand-off and run apply.
  const compact: RcOutCompact = {
    report_type: REPORT_TYPE,
    since,
    watermark,
    gate_failures: gateFailures,
    source: {
      email_subject: primaryAtt.emailSubject ?? null,
      email_uid: primaryAtt.emailUid,
      email_thread_id: primaryAtt.threadId ?? null,
    },
    actionable: {
      new: classified.new,
      changed: classified.changed,
      flagged: classified.flagged.map((f) => ({ index: f.index, reason: f.reason })),
      unmapped: classified.unmapped.map((u) => ({ index: u.index, reason: u.reason })),
      malformed: classified.malformed.map((m) => ({ reason: m.reason })),
    },
    batch_lookup: batchLookup,
  };

  const apply = await applyRcOut(compact, {
    db,
    labeler: deps.labeler,
    progress: deps.progress,
    noLabel: deps.noLabel,
    runTs: deps.runTs,
  });

  return {
    classify: {
      report_type: REPORT_TYPE,
      ok: !gateTripped,
      gate_failures: gateFailures,
      counts: {
        noop: s.noop_count,
        insert: s.new_count,
        update: s.changed_count,
        flagged: s.flagged_count + s.unmapped_count + s.malformed_count,
      },
      watermark,
      codified_rules_applied: CODIFIED_RULES,
    },
    apply,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function firstAttachment(manifest: RcOutManifest, key: string): StoredAttachmentLike | null {
  const arr = manifest.reports?.[key];
  return arr && arr.length ? arr[0] : null;
}

/** since = watermark - N days (sync_rc_out.py: date.fromisoformat - timedelta). */
function minusDaysISO(iso: string, days: number): string {
  const [y, m, d] = iso.split("-").map((x) => parseInt(x, 10));
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() - days);
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${p(dt.getUTCFullYear(), 4)}-${p(dt.getUTCMonth() + 1)}-${p(dt.getUTCDate())}`;
}
