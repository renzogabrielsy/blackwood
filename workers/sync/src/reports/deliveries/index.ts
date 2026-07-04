/**
 * index.ts — deliveries report port entrypoint (Wave 3, port #3 — the L-033 flagship).
 *
 * Exports:
 *   classifyCase(workbookPaths, dbWindow, opts)  — the FROZEN parity entrypoint
 *       (src/reports/types.ts). Runs extract→classify→guard OFFLINE against the DB
 *       snapshot and returns the classify oracle unit (the guarded result dict).
 *   runReport(deps, runId, manifest, opts)       — the two-phase orchestrator
 *       (fetch → extract → enrich → classify+guard → apply). DB + Gmail injected as
 *       deps (copied idiom from src/reports/flecon/index.ts + rc_out/index.ts); this
 *       file never imports gmail/db beyond shared lib types.
 *
 * Ground truth: sync_deliveries.py (orchestration), extract_rc_deliveries.py,
 * enrich_prices.py, classify_deliveries.py, lib/deductions.py, and
 * workers/sync/scripts/parity_guards.py (the guard layer, part of the classify oracle).
 *
 * The classify "envelope" is the guarded classifier RESULT dict (summary/new/changed/
 * noop/malformed/flagged/dup_noops) — exactly what build_oracle.py::oracle_deliveries
 * returns. NOT the orchestrator_common.classify_envelope wrapper.
 */
import { readFile } from "node:fs/promises";
import { basename } from "node:path";

import type {
  ClassifyCase,
  ClassifyEnvelope,
  ClassifyOpts,
  DbWindow,
} from "../types.js";
import type { DbClient } from "../../lib/db.js";
import type { ProgressEmitter } from "../../lib/progress.js";

import { loadDeliveriesWorkbook } from "./sheet.js";
import { extractDeliveries, type ExtractResult } from "./extract.js";
import { enrichPrices, type CzarinaMatch } from "./enrich.js";
import {
  classifyDeliveries,
  applyDeliveriesGuard,
  type DeliveriesDbRow,
  type GuardedResult,
} from "./classify.js";
import { applyDeliveries, type DeliveriesCompact, type ApplyResult } from "./apply.js";

export const REPORT_TYPE = "deliveries";

const CODIFIED_RULES = [
  "L-001",
  "L-004",
  "L-006",
  "L-008",
  "L-020",
  "L-021",
  "L-033a",
  "L-033b",
  "batch_code-heuristic-translation",
  "never-auto-create-batch",
] as const;

// deliveries DB-window snapshot shape (types.ts: deliveries role keys).
//   deliveries   → deliveries rows the classifier diffs against
//   batch_codes  → the set of existing batch_codes the L-033b hint checks (offline
//                  stand-in for db.select_one("batches", ...), see parity_guards.py)
interface DeliveriesDbWindow {
  deliveries?: DeliveriesDbRow[];
  batch_codes?: string[];
}

function asDbWindow(dw: DbWindow): DeliveriesDbWindow {
  return (dw ?? {}) as DeliveriesDbWindow;
}

/** Shared extract→classify→guard body used by BOTH classifyCase and runReport. */
function runClassifyFromExtract(
  extract: ExtractResult,
  since: string,
  dbRows: DeliveriesDbRow[],
  batchCodes: Set<string>,
): GuardedResult {
  // Tail-filter by since (sync_deliveries.py filters Python-side after extract).
  const filtered: ExtractResult = {
    ...extract,
    rows: extract.rows.filter(
      (r) => String(r.transaction_date).slice(0, 10) >= since,
    ),
  };
  const classified = classifyDeliveries(filtered, dbRows);
  return applyDeliveriesGuard(classified, dbRows, batchCodes);
}

// ---------------------------------------------------------------------------
// FROZEN classify entrypoint (types.ts). Parity harness calls this per fixture.
// ---------------------------------------------------------------------------
export const classifyCase: ClassifyCase = async (
  workbookPaths: Record<string, string>,
  dbWindow: DbWindow,
  opts: ClassifyOpts,
): Promise<ClassifyEnvelope> => {
  const dw = asDbWindow(dbWindow);
  const since = String(opts.since);
  const dbRows = dw.deliveries ?? [];
  const batchCodes = new Set(dw.batch_codes ?? []);

  const primaryPath = workbookPaths.primary;
  // A missing primary workbook = the RC DELIVERIES email did not arrive: classify an
  // empty extract (mirrors sync_deliveries.py's no-xlsx early return), NOT throw.
  if (!primaryPath) {
    const emptyExtract: ExtractResult = {
      filename: "",
      sheets_processed: [],
      rows: [],
      summary: { total_rows: 0, extraction_warnings: [], overall_confidence: 0.0, unmapped_batches: [] },
    };
    const guarded = runClassifyFromExtract(emptyExtract, since, dbRows, batchCodes);
    return guarded as unknown as ClassifyEnvelope;
  }

  const buf = await readFile(primaryPath);
  const wb = await loadDeliveriesWorkbook(buf);
  const extract = extractDeliveries(wb, basename(primaryPath));

  // NOTE: the classify oracle path (build_oracle.py::oracle_deliveries) does NOT run
  // enrich_prices — enrichment is an apply-phase step whose only effect (cost_basis)
  // is never diffed when the extract side is null, and is not exercised by any
  // deliveries fixture. So classifyCase deliberately skips enrich, matching the oracle.
  const guarded = runClassifyFromExtract(extract, since, dbRows, batchCodes);
  return guarded as unknown as ClassifyEnvelope;
};

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

/** Per-report manifest slice: role → attachments. deliveries uses `deliveries`
 *  (operator RC DELIVERIES) + optional `deliveries_czarina` (price file). */
export interface DeliveriesManifest {
  reports: Record<string, StoredAttachmentLike[]>;
}

export interface RunReportDeps {
  db: DbClient;
  /** Download a stored attachment (Storage path → local file path) — injected. */
  fetchToLocalPath: (storagePath: string) => Promise<string>;
  /** Gmail labeler — injected (apply never imports gmail). */
  labeler?: (uids: Array<number | string>) => Promise<boolean>;
  /** Progress emitter bound to (runId, "deliveries"). */
  progress?: ProgressEmitter;
  noLabel?: boolean;
  runTs?: string;
}

export interface RunReportResult {
  classify: {
    report_type: string;
    ok: boolean;
    gate_failures: never[];
    counts: { noop: number; insert: number; update: number; flagged: number };
    watermark: string | null;
    codified_rules_applied: readonly string[];
  };
  apply: ApplyResult;
}

/**
 * The full deliveries sync (sync_deliveries.py phase_classify + phase_apply fused for
 * the worker). Computes since from the live DB watermark (−3d tail scope), extracts
 * the operator file, OPTIONALLY enriches from Czarina, classifies + runs the guard
 * layer, and applies. There is NO hard gate in deliveries (gate_failures always []).
 */
export async function runReport(
  deps: RunReportDeps,
  runId: string,
  manifest: DeliveriesManifest,
  opts: { since?: string } = {},
): Promise<RunReportResult> {
  void runId;
  const { db } = deps;
  const emit = deps.progress;

  await emit?.("fetch", "Checking Gmail for new delivery reports…", 5);

  // Watermark + since (sync_deliveries.py:81-83): watermark −3d tail scope, else 2025-01-01.
  const watermark = await db.dataWatermark("deliveries");
  const since = opts.since ?? (watermark ? minusDaysISO(watermark, 3) : "2025-01-01");

  const primaryAtt = firstAttachment(manifest, "deliveries");
  const czarinaAtt = firstAttachment(manifest, "deliveries_czarina");

  if (!primaryAtt) {
    await emit?.("finalize", "Nothing new today — no RC DELIVERIES report waiting.", 100);
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

  await emit?.("fetch", `Found the report: ${primaryAtt.emailSubject ?? "RC DELIVERIES"}`, 15);
  const primaryPath = await deps.fetchToLocalPath(primaryAtt.storagePath);

  await emit?.("extract", "Reading the delivery spreadsheet…", 28);
  const wb = await loadDeliveriesWorkbook(await readFile(primaryPath));
  const extract = extractDeliveries(wb, basename(primaryPath));

  // Tail-filter for enrichment scope + Czarina sheet selection.
  const windowRows = extract.rows.filter(
    (r) => String(r.transaction_date).slice(0, 10) >= since,
  );

  // OPTIONAL price enrichment (sync_deliveries.py:118-140). File-based handoff in the
  // Python; here it's a direct call. Failure → proceed un-enriched (cost_basis stays
  // null → L-008 placeholder at apply). Enrichment mutates cost_basis on `windowRows`.
  if (czarinaAtt && windowRows.length) {
    try {
      await emit?.("extract", "Matching delivery prices from Czarina's file…", 40);
      const czarinaPath = await deps.fetchToLocalPath(czarinaAtt.storagePath);
      const czBuf = await readFile(czarinaPath);
      const sheet = czarinaMonthSheet(maxDate(windowRows));
      const matches: CzarinaMatch = await enrichPrices(czBuf, sheet, windowRows);
      void matches;
    } catch {
      await emit?.("extract", "Price file unavailable — proceeding without prices.", 40, undefined, "warn");
    }
  }

  await emit?.("classify", "Comparing the report against the database…", 58);
  const dbRows = (await db.readRows("deliveries", {
    sinceDate: since,
    columns: [
      "id", "transaction_date", "supplier", "batch_code", "block_loc", "truck_plate",
      "sacks", "weight_kg", "cost_basis", "remarks", "lab_results",
    ],
  })) as DeliveriesDbRow[];
  const batchRows = await db.readRows("batches", { columns: ["batch_code"], sinceColumn: null });
  const batchCodes = new Set<string>();
  for (const b of batchRows) {
    if (b.batch_code) batchCodes.add(String(b.batch_code));
  }

  const filtered: ExtractResult = { ...extract, rows: windowRows };
  const classified = classifyDeliveries(filtered, dbRows);
  const guarded = applyDeliveriesGuard(classified, dbRows, batchCodes);

  const s = guarded.summary;
  await emit?.(
    "classify",
    `${s.noop_count} already recorded · ${guarded.new.length} new · ${s.changed_count} changed`,
    90,
  );

  const compact: DeliveriesCompact = {
    report_type: REPORT_TYPE,
    since,
    watermark,
    source: {
      email_subject: primaryAtt.emailSubject ?? null,
      email_uid: primaryAtt.emailUid,
      email_thread_id: primaryAtt.threadId ?? null,
    },
    actionable: {
      new: guarded.new,
      changed: guarded.changed,
      flagged: guarded.flagged,
      dup_noops: guarded.dup_noops,
      malformed: guarded.malformed.map((m) => ({ reason: m.reason })),
    },
    batch_codes: [...batchCodes],
  };

  const apply = await applyDeliveries(compact, {
    db,
    labeler: deps.labeler,
    progress: deps.progress,
    noLabel: deps.noLabel,
    runTs: deps.runTs,
  });

  return {
    classify: {
      report_type: REPORT_TYPE,
      ok: true, // no hard gate in deliveries
      gate_failures: [],
      counts: {
        noop: s.noop_count + guarded.dup_noops.length,
        insert: guarded.new.length,
        update: s.changed_count,
        flagged: guarded.flagged.length,
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
function firstAttachment(manifest: DeliveriesManifest, key: string): StoredAttachmentLike | null {
  const arr = manifest.reports?.[key];
  return arr && arr.length ? arr[0] : null;
}

/** since = watermark − N days (sync_deliveries.py: date.fromisoformat − timedelta). */
function minusDaysISO(iso: string, days: number): string {
  const [y, m, d] = iso.slice(0, 10).split("-").map((x) => parseInt(x, 10));
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() - days);
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${p(dt.getUTCFullYear(), 4)}-${p(dt.getUTCMonth() + 1)}-${p(dt.getUTCDate())}`;
}

function maxDate(rows: Array<{ transaction_date: string }>): string {
  let mx = "";
  for (const r of rows) {
    const d = String(r.transaction_date).slice(0, 10);
    if (d > mx) mx = d;
  }
  return mx;
}

/** _month_sheet: "<Month> <YYYY>" (sync_deliveries.py:73-75, date(y,m,1).strftime("%B")). */
const FULL_MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];
function czarinaMonthSheet(iso: string): string {
  const y = parseInt(iso.slice(0, 4), 10);
  const m = parseInt(iso.slice(5, 7), 10);
  return `${FULL_MONTHS[m - 1]} ${y}`;
}
