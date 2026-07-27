/**
 * index.ts — the flecon report port entrypoint.
 *
 * Exports:
 *   classifyCase(workbookPaths, dbWindow, opts)  — the FROZEN Wave-3 contract
 *     (src/reports/types.ts). Runs extract→classify OFFLINE against the DB-window
 *     snapshot and returns the classify envelope the parity harness diffs.
 *   runReport(deps, runId, manifest, opts)       — the workflow-layer entrypoint the
 *     DBOS worker will wire later. Defined here (with a minimal deps type) so the
 *     rc_out porter can copy the idiom.
 *
 * flecon's classify "envelope" is the classify_flecon_bags.py `result` object itself
 * (table/since/model/per_date/code_to_id/balance_crosscheck/column_flags/summary) —
 * NOT the sync_flecon.py classify_envelope wrapper. The oracle (build_oracle.py
 * ::oracle_flecon) returns exactly that result, so classifyCase mirrors it.
 */
import { readFile } from "node:fs/promises";
import { basename } from "node:path";

import type {
  ClassifyCase,
  ClassifyEnvelope,
  ClassifyOpts,
  DbWindow,
} from "../types.js";
import { loadFleconWorkbook } from "./sheet.js";
import { extractFlecon, type BagTypeRegistryRow } from "./extract.js";
import {
  classifyFlecon,
  type DbMovementRow,
  type BagTypeRow,
  type ViewBalanceRow,
  type FleconClassified,
} from "./classify.js";
import { applyFlecon, type FleconApplyDeps, type FleconApplyResult } from "./apply.js";

/**
 * The flecon DB-window snapshot shape (types.ts: flecon role keys). The parity
 * harness loads fixtures/flecon/db_window/<case>.json verbatim into this.
 *   movements          → flecon_bag_movements rows (bag_type_id, not code)
 *   bag_types          → {id, code} — resolves id→code AND is the classify code_to_id
 *   bag_type_registry  → flecon_bag_types rows the EXTRACTOR maps columns against
 *   view_balance       → view_flecon_bag_balance rows for the informational cross-check
 */
interface FleconDbWindow {
  movements?: DbMovementRow[];
  bag_types?: BagTypeRow[];
  bag_type_registry?: BagTypeRegistryRow[];
  view_balance?: ViewBalanceRow[];
}

function asDbWindow(dw: DbWindow): FleconDbWindow {
  return (dw ?? {}) as FleconDbWindow;
}

/**
 * FROZEN entrypoint (types.ts::ClassifyCase). Reads the `primary` workbook, extracts
 * with the snapshot registry, classifies against the snapshot movements/types/view.
 */
export const classifyCase: ClassifyCase = async (
  workbookPaths: Record<string, string>,
  dbWindow: DbWindow,
  opts: ClassifyOpts,
): Promise<ClassifyEnvelope> => {
  const dw = asDbWindow(dbWindow);
  const since = String(opts.since);

  const primaryPath = workbookPaths.primary;
  // A missing primary workbook mirrors the Python orchestrator's "no xlsx" early
  // return (nothing to ingest). No fixture exercises this, but be non-throwing.
  if (!primaryPath) {
    const empty = classifyFlecon(
      {
        filename: "",
        sheet: "",
        sheet_year: null,
        flagged_rows: [],
        since,
        rows: [],
        opening_balances: {},
        balance_snapshot: null,
        column_map: [],
        unmapped_columns: [],
        missing_columns: [],
        summary: {
          total_rows: 0,
          distinct_dates: 0,
          date_min: null,
          date_max: null,
          total_in: 0,
          total_out: 0,
          dropped_before_since: 0,
          skipped_markers: 0,
          matched_columns: 0,
          unmapped_columns: 0,
          missing_columns: 0,
          extraction_warnings: [],
          overall_confidence: 1.0,
        },
      },
      since,
      { movements: [], bagTypes: dw.bag_types ?? [], viewBalance: dw.view_balance ?? [] },
    );
    return empty as unknown as ClassifyEnvelope;
  }

  const buf = await readFile(primaryPath);
  const wb = await loadFleconWorkbook(buf);
  const registry = dw.bag_type_registry ?? [];

  const extract = extractFlecon(wb, basename(primaryPath), registry, since, null);
  const classified: FleconClassified = classifyFlecon(extract, since, {
    movements: dw.movements ?? [],
    bagTypes: dw.bag_types ?? [],
    viewBalance: dw.view_balance ?? [],
  });

  return classified as unknown as ClassifyEnvelope;
};

// ---------------------------------------------------------------------------
// Workflow-layer entrypoint (the rc_out porter copies this idiom).
// ---------------------------------------------------------------------------

/**
 * Deps the workflow layer injects. Kept minimal + injected (not imported) so this
 * module never reaches into Gmail/DB singletons directly — the workflow wires:
 *   - db:        the live DbClient (reads registry/movements/types/view; writes).
 *   - progress:  the bound ProgressEmitter (lib/progress.makeEmitter).
 *   - fetchLatestWorkbook: returns the newest FLECON BAGGED attachment (path+meta)
 *       or null when no email is waiting (mirrors oc.latest_xlsx early-return).
 *   - labelProcessed: applies the Blackwood-Processed Gmail label — a CALLBACK, so
 *       apply.ts never imports gmail (label-only-on-full-success per flecon.md §5).
 */
export interface FleconWorkbookMeta {
  path: string;
  subject?: string | null;
  uid?: string | null;
  threadId?: string | null;
}

export interface FleconDeps {
  db: {
    readRows(table: string, opts?: Record<string, unknown>): Promise<Array<Record<string, unknown>>>;
    dataWatermark(table: string, dateColumn?: string): Promise<string | null>;
  } & FleconApplyDeps["db"];
  progress: (
    stage: "fetch" | "extract" | "classify" | "apply" | "reconcile" | "finalize",
    label: string,
    pct: number,
    detail?: string,
    level?: "info" | "warn",
  ) => Promise<void>;
  fetchLatestWorkbook: (gmailQuery: string) => Promise<FleconWorkbookMeta | null>;
  labelProcessed: (uid: string) => Promise<boolean>;
}

export interface RunReportManifest {
  /** Passed through to apply's Gmail labeling; the workflow decides label suppression. */
  noLabel?: boolean;
}

export interface RunReportResult {
  ok: boolean;
  classified: FleconClassified | null;
  apply: FleconApplyResult | null;
  note?: string;
  /**
   * HARD stops that prevented this report from writing (BUG-015 defect C1). flecon
   * previously never emitted any — its classify was always `ok:true`. The stale-workbook
   * refusal is the first, and it must reach the panel card as a gate failure, not as a
   * silent zero-row apply. Empty array = no gate tripped (the normal case).
   */
  gate_failures: Array<{ gate: string; detail: string }>;
}

const REPORT_TYPE = "flecon";
const GMAIL_QUERY =
  'from:edilloivymae306ictc@gmail.com subject:"FLECON BAGGED" after:{since} -label:"Blackwood-Processed"';

/**
 * The two-phase run (fetch→extract→classify→apply), mirroring sync_flecon.py end to
 * end but with all IO injected via `deps`. This is scaffolding for the DBOS worker
 * wiring; the parity gate only exercises classifyCase. Kept faithful to the Python
 * pipeline (watermark → since, first-run floor 2026-01-01, digestible progress).
 */
export async function runReport(
  deps: FleconDeps,
  runId: string,
  manifest: RunReportManifest = {},
  _opts: Record<string, unknown> = {},
): Promise<RunReportResult> {
  void runId;

  await deps.progress("fetch", "Checking Gmail for the bag inventory report…", 5);

  // watermark = MAX(flecon_bag_movements.transaction_date); null → first-run backfill.
  const watermark = await deps.db.dataWatermark("flecon_bag_movements");
  let since: string;
  let sinceGmail: string;
  if (watermark) {
    since = subtractDays(watermark, 3);
    sinceGmail = since.replace(/-/g, "/");
  } else {
    since = "2026-01-01"; // HARDCODED flecon first-run floor (NOT 2025 — flecon.md §2 trap #3)
    sinceGmail = "2025/12/31";
  }

  const wbMeta = await deps.fetchLatestWorkbook(GMAIL_QUERY.replace("{since}", sinceGmail));
  if (!wbMeta) {
    await deps.progress("finalize", "Nothing new today — no FLECON BAGGED report waiting.", 100);
    return {
      ok: true,
      classified: null,
      apply: null,
      note: "No FLECON BAGGED email in window.",
      gate_failures: [],
    };
  }
  await deps.progress("fetch", `Found the report: ${wbMeta.subject ?? "FLECON BAGGED"}`, 18);

  await deps.progress("extract", "Reading the bag inventory spreadsheet…", 30);
  const buf = await readFile(wbMeta.path);
  const wb = await loadFleconWorkbook(buf);
  const registry = (await deps.db.readRows("flecon_bag_types", {
    columns: ["code", "source_label", "source_column", "sort_order", "label"],
    sinceColumn: null,
  })) as unknown as BagTypeRegistryRow[];
  const extract = extractFlecon(wb, basename(wbMeta.path), registry, since, null);

  await deps.progress("classify", "Comparing bag movements against the database…", 55);
  const movements = (await deps.db.readRows("flecon_bag_movements", {
    sinceDate: since,
    sinceColumn: "transaction_date",
    columns: ["id", "transaction_date", "particular", "bag_type_id", "qty_delta"],
  })) as unknown as DbMovementRow[];
  const bagTypes = (await deps.db.readRows("flecon_bag_types", {
    columns: ["id", "code"],
    sinceColumn: null,
  })) as unknown as BagTypeRow[];
  let viewBalance: ViewBalanceRow[] = [];
  try {
    viewBalance = (await deps.db.readRows("view_flecon_bag_balance", {
      sinceColumn: null,
    })) as unknown as ViewBalanceRow[];
  } catch {
    viewBalance = [];
  }

  const classified = classifyFlecon(extract, since, { movements, bagTypes, viewBalance });
  const s = classified.summary;
  const columnFlagged = classified.column_flags.flagged;
  await deps.progress(
    "classify",
    `${s.duplicate_noop_days} day(s) already recorded · ${s.new_days} new · ${s.date_changed_days} changed` +
      (columnFlagged ? " · columns to review" : ""),
    90,
  );

  // ── BUG-015 defect C1: refuse a workbook OLDER than what the DB already holds. ──
  // The fetcher takes the newest EMAIL carrying an xlsx; that attachment can still be an
  // older REVISION of the cumulative workbook. Its missing days classify DATE_CHANGED
  // with an empty movement list, which REPLACE-BY-DATE used to honour by wiping the day
  // (confirmed 3x in production — see docs/BUG_LEDGER.md BUG-015).
  const workbookMaxDate = extract.summary.date_max;
  const stale =
    watermark !== null && (workbookMaxDate === null || workbookMaxDate < watermark)
      ? { workbookMaxDate, dbWatermark: watermark }
      : null;

  // ── BUG-015 defect A: every date the DB holds, so the apply can tell a benign
  // settled-history drop from a dropped date that was never recorded at all. ──
  let dbDates: string[] | undefined;
  try {
    const allDates = await deps.db.readRows("flecon_bag_movements", {
      columns: ["transaction_date"],
      sinceColumn: null,
    });
    dbDates = allDates.map((r) => String(r.transaction_date ?? "").slice(0, 10));
  } catch {
    dbDates = undefined; // read failed → skip the benign/never-recorded split, never crash
  }

  const applyResult = await applyFlecon(
    {
      db: deps.db,
      progress: deps.progress,
      labelProcessed: deps.labelProcessed,
    },
    classified,
    {
      reportType: REPORT_TYPE,
      emailUid: wbMeta.uid ?? null,
      emailThreadId: wbMeta.threadId ?? null,
      noLabel: manifest.noLabel ?? false,
      flaggedRows: extract.flagged_rows,
      dbDates,
      staleWorkbook: stale,
    },
  );

  return {
    ok: applyResult.ok,
    classified,
    apply: applyResult,
    gate_failures: stale
      ? [
          {
            gate: "stale_workbook",
            detail:
              `The FLECON BAGGED attachment only carries bag movements up to ` +
              `${stale.workbookMaxDate ?? "(no dated rows)"}, but the app already has them through ` +
              `${stale.dbWatermark}. This is an older copy of the workbook — nothing was written.`,
          },
        ]
      : [],
  };
}

/** YYYY-MM-DD minus N days (UTC), mirroring date.fromisoformat(...) - timedelta(days=N). */
function subtractDays(iso: string, days: number): string {
  const [y, m, d] = iso.slice(0, 10).split("-").map(Number);
  const ms = Date.UTC(y, m - 1, d) - days * 86400000;
  const dt = new Date(ms);
  const p2 = (n: number) => String(n).padStart(2, "0");
  return `${dt.getUTCFullYear()}-${p2(dt.getUTCMonth() + 1)}-${p2(dt.getUTCDate())}`;
}
