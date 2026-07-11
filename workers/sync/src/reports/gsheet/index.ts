/**
 * index.ts — the gsheet report port entrypoint.
 *
 * Exports:
 *   classifyCase(workbookPaths, dbWindow, opts)  — the FROZEN Wave-3 contract
 *     (src/reports/types.ts). Runs extract→classify OFFLINE against the DB-window
 *     snapshot and returns the classify envelope the parity harness diffs.
 *   runReport(deps, runId, manifest, opts)       — the workflow-layer entrypoint the
 *     DBOS worker will wire later (copies the flecon/rc_out idiom).
 *
 * gsheet's classify "envelope" is the COMPOSED dual-mode object {rc_in, rc_out},
 * each side being a classify_gsheet.py bundle. The oracle (build_oracle.py
 * ::oracle_gsheet) runs BOTH modes regardless of opts.mode and returns exactly that
 * shape, so classifyCase mirrors it (opts.mode is accepted but does not narrow the
 * output — parity is against the combined object).
 */
import { readFile } from "node:fs/promises";

import type {
  ClassifyCase,
  ClassifyEnvelope,
  ClassifyOpts,
  DbWindow,
} from "../types.js";
import { loadWorkbook } from "../../lib/xlsx.js";
import type { DbClient } from "../../lib/db.js";
import type { ProgressEmitter } from "../../lib/progress.js";

import { extractGsheet, type ExtractResult } from "./extract.js";
import {
  classifyGsheet,
  type GsheetClassified,
  type DeliveryDbRow,
  type RcOutDbRow,
  type BatchLookup,
} from "./classify.js";
import {
  applyGsheet,
  type ModeCompact,
  type CompactNewRcIn,
  type CompactNewRcOut,
  type CompactChanged,
  type CompactFlagged,
  type CompactUnmapped,
  type GsheetApplyResult,
} from "./apply.js";
import {
  downloadGsheet,
  GSHEET_FILE_ID,
  GSHEET_EXPORT_URL,
  type FetchLike,
} from "./download.js";

export const REPORT_TYPE = "gsheet";

const CODIFIED_RULES = [
  "rounding-null-zero-noop",
  "sheet-wins-material-value-changed",
  "L-004",
  "L-008",
  "L-013",
  "L-018",
  "batch_code-fallback-prefixes",
  "auto-create-pattern-valid-batch", // 2026-07-11 — reverses the old never-auto-create rule
  "never-delete",
  "2025-scope-floor",
] as const;

// ---------------------------------------------------------------------------
// FROZEN classify entrypoint (types.ts). Parity harness calls this per fixture.
// ---------------------------------------------------------------------------

interface GsheetDbWindow {
  deliveries?: DeliveryDbRow[];
  rc_out?: RcOutDbRow[];
  batch_lookup?: BatchLookup;
}

/**
 * Runs the gsheet extract→classify pipeline offline. Reads ONLY the `primary`
 * workbook (both RC IN + RC OUT tabs) and the `dbWindow` snapshot; never a live DB.
 * Returns the composed {rc_in, rc_out} classify object (the parity oracle unit).
 */
export const classifyCase: ClassifyCase = async (
  workbookPaths: Record<string, string>,
  dbWindow: DbWindow,
  opts: ClassifyOpts,
): Promise<ClassifyEnvelope> => {
  const dw = (dbWindow ?? {}) as GsheetDbWindow;
  const since = String(opts.since);

  const primaryPath = workbookPaths.primary;
  // A missing primary workbook mirrors the Python orchestrator's "no xlsx" early
  // return: classify empty extracts on both tabs (non-throwing).
  const extract: { rc_in: ExtractResult; rc_out: ExtractResult } = primaryPath
    ? extractGsheet(await loadWorkbook(await readFile(primaryPath)))
    : {
        rc_in: emptyExtract("RC IN"),
        rc_out: emptyExtract("RC OUT"),
      };

  const classified = classifyGsheet(
    { rc_in: extract.rc_in, rc_out: extract.rc_out },
    {
      deliveries: dw.deliveries ?? [],
      rc_out: dw.rc_out ?? [],
      batchLookup: dw.batch_lookup ?? {},
    },
    since,
  );

  return classified as unknown as ClassifyEnvelope;
};

function emptyExtract(tab: string): ExtractResult {
  return {
    tab,
    source_rows: 0,
    rows: [],
    summary: {
      total_rows: 0,
      overall_confidence: 0.0,
      warnings_count: 0,
      extraction_warnings: [],
    },
  };
}

// ---------------------------------------------------------------------------
// Workflow-layer entrypoint (copies the flecon/rc_out idiom).
// ---------------------------------------------------------------------------

export interface GsheetDeps {
  db: DbClient;
  progress?: ProgressEmitter;
  /** Injected fetch for the Sheet export (download.ts). Defaults to global fetch. */
  fetchImpl?: FetchLike;
  /** RUN timestamp string for provenance comments (mirrors oc.RUN_TS). */
  runTs?: string;
}

export interface GsheetRunResult {
  classify: {
    report_type: string;
    ok: boolean;
    counts: { noop: number; insert: number; update: number; flagged: number };
    watermark: string;
    codified_rules_applied: readonly string[];
    per_mode: Record<string, { new: number; changed: number; flagged: number }>;
  };
  apply: GsheetApplyResult;
}

/**
 * The full gsheet sync (sync_gsheet.py contract path fused into one durable run).
 * Downloads the Sheet, extracts BOTH tabs, classifies each mode against a freshly
 * queried DB window (2025-scope floor — the fixed `since`, NOT a live MAX(date)),
 * builds the compact hand-off, and applies (Sheet-wins on material diffs; gates,
 * held rows, never-delete). labeled is ALWAYS false (a Sheet has no Gmail thread).
 */
export async function runReport(
  deps: GsheetDeps,
  runId: string,
  _manifest: Record<string, unknown> = {},
  opts: { since?: string } = {},
): Promise<GsheetRunResult> {
  void runId;
  const { db } = deps;
  const emit = deps.progress;
  const since = opts.since ?? "2025-01-01"; // LOCKED 2025 scope floor (fixed, not a watermark).

  await emit?.("fetch", "Downloading the Google Sheet…", 8);
  const fetchImpl = deps.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
  const buf = await downloadGsheet(fetchImpl, GSHEET_EXPORT_URL);

  await emit?.("extract", "Reading the RC IN + RC OUT tabs…", 25);
  const wb = await loadWorkbook(buf);
  const extract = extractGsheet(wb);

  // DB window (fresh each run — the classifier's idempotency guard).
  await emit?.("classify", "Comparing the sheet against the database…", 45);
  const deliveries = (await db.readRows("deliveries", {
    sinceDate: since,
    columns: [
      "id", "transaction_date", "supplier", "batch_code", "block_loc",
      "truck_plate", "sacks", "weight_kg", "cost_basis", "remarks", "lab_results",
    ],
  })) as DeliveryDbRow[];
  const rcOutRows = (await db.readRows("rc_out", {
    sinceDate: since,
    columns: [
      "id", "transaction_date", "batch_id", "production_batch", "destination",
      "weight_kg", "block_loc", "remarks",
    ],
  })) as RcOutDbRow[];
  const batchRows = await db.readRows("batches", { columns: ["batch_code", "id"], sinceColumn: null });
  const batchLookup: BatchLookup = {};
  for (const b of batchRows) {
    if (b.batch_code) batchLookup[String(b.batch_code)] = String(b.id);
  }

  const classified: GsheetClassified = classifyGsheet(
    { rc_in: extract.rc_in, rc_out: extract.rc_out },
    { deliveries, rc_out: rcOutRows, batchLookup },
    since,
  );

  const rcInS = classified.rc_in.summary;
  const rcOutS = classified.rc_out.summary;
  await emit?.(
    "classify",
    `${rcInS.noop_count + rcOutS.noop_count} already recorded · ` +
      `${rcInS.new_count + rcOutS.new_count} new · ` +
      `${rcInS.changed_count + rcOutS.changed_count} changed`,
    90,
  );

  // Build the compact hand-off (build_compact) for both modes and apply.
  const modes = {
    rc_in: buildCompact(classified.rc_in, "rc_in"),
    rc_out: buildCompact(classified.rc_out, "rc_out"),
  };
  const apply = await applyGsheet(modes, { db, progress: deps.progress, runTs: deps.runTs, batchLookup });

  const perMode = {
    rc_in: {
      new: rcInS.new_count,
      changed: rcInS.changed_count,
      flagged: rcInS.flagged_count + rcInS.unmapped_count + rcInS.malformed_count,
    },
    rc_out: {
      new: rcOutS.new_count,
      changed: rcOutS.changed_count,
      flagged: rcOutS.flagged_count + rcOutS.unmapped_count + rcOutS.malformed_count,
    },
  };

  return {
    classify: {
      report_type: REPORT_TYPE,
      ok: apply.ok,
      counts: {
        noop: rcInS.noop_count + rcOutS.noop_count,
        insert: rcInS.new_count + rcOutS.new_count,
        update: rcInS.changed_count + rcOutS.changed_count,
        flagged: perMode.rc_in.flagged + perMode.rc_out.flagged,
      },
      watermark: since,
      codified_rules_applied: CODIFIED_RULES,
      per_mode: perMode,
    },
    apply,
  };
}

// ---------------------------------------------------------------------------
// Compact builder (sync_gsheet.py::build_compact) — reduce a classify bundle to
// the actionable hand-off apply consumes. RC IN NEW carries true_weight_kg/
// deduction_note through (PORTING_DECISIONS #4 — apply writes them).
// ---------------------------------------------------------------------------
function buildCompact(
  bundle: GsheetClassified["rc_in"] | GsheetClassified["rc_out"],
  mode: "rc_in" | "rc_out",
): ModeCompact {
  return {
    mode,
    since: bundle.since,
    actionable: {
      new: bundle.new.map((i) => (mode === "rc_in" ? compactNewRcIn(i) : compactNewRcOut(i))),
      changed: bundle.changed.map((i) => compactChanged(i, mode)),
      flagged: bundle.flagged.map((i) => compactFlagged(i)),
      unmapped: bundle.unmapped.map((i) => compactUnmapped(i, mode)),
      malformed: bundle.malformed.slice(),
    },
  };
}

function asRow(item: Record<string, unknown>): Record<string, unknown> {
  return (item.row as Record<string, unknown>) ?? {};
}

function compactNewRcIn(item: Record<string, unknown>): CompactNewRcIn {
  const r = asRow(item);
  return {
    kind: "NEW",
    index: item.index ?? null,
    date: (r.transaction_date as string | null) ?? null,
    batch_code: (r.batch_code_resolved as string | null) || (r.batch_code_primary as string | null) || null,
    block_loc: (r.block_loc as string | null) ?? null,
    weight_kg: (r.weight_kg as number | null) ?? null,
    supplier: (r.supplier as string | null) ?? null,
    truck_plate: (r.truck_plate as string | null) ?? null,
    sacks: (r.sacks as number | null) ?? null,
    remarks: (r.remarks as string | null) ?? null,
    lab_results: (r.lab_results as Record<string, unknown> | null) ?? null,
    confidence: (r.confidence as number | null) ?? null,
    true_weight_kg: (r.true_weight_kg as number | null) ?? null,
    deduction_note: (r.deduction_note as string | null) ?? null,
  };
}

function compactNewRcOut(item: Record<string, unknown>): CompactNewRcOut {
  const r = asRow(item);
  return {
    kind: "NEW",
    index: item.index ?? null,
    date: (r.transaction_date as string | null) ?? null,
    batch_code: (r.batch_code_resolved as string | null) || (r.batch_code_primary as string | null) || null,
    batch_id: (r.batch_id as string | null) ?? null,
    destination: (r.destination as string | null) ?? null,
    weight_kg: (r.weight_kg as number | null) ?? null,
    production_batch: (r.production_batch as string | null) ?? null,
    block_loc: (r.block_loc as string | null) ?? null,
    remarks: (r.remarks as string | null) ?? null,
    confidence: (r.confidence as number | null) ?? null,
  };
}

function compactChanged(item: Record<string, unknown>, mode: "rc_in" | "rc_out"): CompactChanged {
  const r = asRow(item);
  const diffs = ((item.diff as Array<Record<string, unknown>>) ?? []).map((d) => ({
    field: d.field as string,
    db: d.dbValue,
    sheet: d.sheetValue,
  }));
  const out: CompactChanged = {
    kind: "VALUE_CHANGED",
    index: item.index ?? null,
    db_id: (item.db_id as string) ?? "",
    date: (r.transaction_date as string | null) ?? null,
    batch_code: (r.batch_code_resolved as string | null) || (r.batch_code_primary as string | null) || null,
    diff: diffs,
  };
  if (mode === "rc_in") out.block_loc = (r.block_loc as string | null) ?? null;
  else out.destination = (r.destination as string | null) ?? null;
  return out;
}

function compactFlagged(item: Record<string, unknown>): CompactFlagged {
  const conflicts = (item.db_conflicts as Array<Record<string, unknown>>) ?? [];
  return {
    kind: "FLAGGED",
    index: item.index ?? null,
    flag_kind: item.kind as string | undefined,
    reason: item.reason as string | undefined,
    db_conflict_ids: conflicts.map((c) => c.id),
    db_conflict_batches: conflicts.map((c) => c.batch_code),
    decision: "skip",
  };
}

function compactUnmapped(item: Record<string, unknown>, mode: "rc_in" | "rc_out"): CompactUnmapped {
  const r = asRow(item);
  const base: CompactUnmapped = {
    kind: "UNMAPPED",
    index: item.index ?? null,
    decision: "skip",
    // Fix 2 + Fix 1: carry the offending code (primary) + the natural-key fields.
    batch_code: (r.batch_code_primary as string | null) ?? null,
    date: (r.transaction_date as string | null) ?? null,
    block_loc: (r.block_loc as string | null) ?? null,
    weight_kg: (r.weight_kg as number | null) ?? null,
    // 2026-07-11 auto-create policy: the FULL row, same shape a "new" bucket item
    // carries — apply writes it through the normal NEW insert path when the code
    // turns out pattern-valid + genuinely new (see apply.ts's UNMAPPED loop).
    full: mode === "rc_in" ? compactNewRcIn(item) : compactNewRcOut(item),
  };
  if (mode === "rc_in") {
    base.supplier = (r.supplier as string | null) ?? null;
    base.truck_plate = (r.truck_plate as string | null) ?? null;
  } else {
    base.destination = (r.destination as string | null) ?? null;
    base.production_batch = (r.production_batch as string | null) ?? null;
  }
  return base;
}

// Re-export the constants for callers/tests.
export { GSHEET_FILE_ID, GSHEET_EXPORT_URL };
