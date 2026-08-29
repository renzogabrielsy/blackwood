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
import { extractFlecon, type BagTypeRegistryRow, type FleconExtract } from "./extract.js";
import {
  classifyFlecon,
  type DbMovementRow,
  type BagTypeRow,
  type ViewBalanceRow,
  type FleconClassified,
} from "./classify.js";
import { applyFlecon, type FleconApplyDeps, type FleconApplyResult } from "./apply.js";
import { errText } from "../../lib/operatorError.js";
import { rosterFrom } from "../../lib/senderRoster.js";
import {
  computeFleconSettlements,
  correctedDate,
  type FleconSettlementDbRow,
} from "./settlement.js";

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
    /** DATE-SETTLEMENT LEDGER (flecon_bag_date_settlements, 2026-07-29). */
    readFleconSettledDates(): Promise<Set<string>>;
    insertFleconSettlements(
      rows: Array<{
        transaction_date: string;
        db_movement_count: number;
        db_net_qty: number;
        reason?: string;
        note?: string | null;
        settled_by_run_id?: string | null;
      }>,
    ): Promise<{ insertedCount: number; insertedDates: string[]; skippedCount: number }>;
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
   *
   * Two gates today: `stale_workbook` (the attachment is an older copy than the DB) and
   * `settlement_ledger_unreadable` (2026-08-26 — the protection that says which dates must
   * not be rewritten could not be read, so the report refuses to run at all).
   */
  gate_failures: Array<{ gate: string; detail: string }>;
}

const REPORT_TYPE = "flecon";
/**
 * ROSTER, not identity (2026-08-29, L-045). This was `from:edilloivymae306ictc@gmail.com`
 * — Ivy alone. `subject:"FLECON BAGGED"` is what identifies the report; the `from:` only
 * narrows the search to the office, and is built from `lib/senderRoster.ts` so this copy
 * and the Mail Clerk's `flecon` entry cannot drift apart. Nothing else about the query,
 * the window, or the extractor's validation changed.
 *
 * EXPORTED so a test can assert it is byte-identical to the Mail Clerk's `flecon` entry —
 * two copies of one query are a drift hazard even when they share a builder.
 */
export const GMAIL_QUERY = `${rosterFrom()} subject:"FLECON BAGGED" after:{since} -label:"Blackwood-Processed"`;

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

  // ── THE DATE-SETTLEMENT LEDGER IS READ FIRST, AND IT FAILS CLOSED (2026-08-26). ──
  // flecon's write model is REPLACE-BY-DATE: for every date in scope it DELETEs the day
  // and re-INSERTs the sheet's version of it. `flecon_bag_date_settlements` is the ONLY
  // thing standing between that and a date a human deliberately arbitrated — the
  // hand-backfilled 2026-01-31 movements (§6a) exist nowhere in the sheet, so a run that
  // believes NOTHING is settled will delete them.
  //
  // This read used to sit inside a `catch { settledDates = new Set() }` alongside the
  // compute/insert, i.e. an unreadable ledger degraded to "nothing is settled" and the run
  // carried on with the protection silently switched off. That is L-044's shape exactly: a
  // read that fails quietly and renders as "nothing to report". A protection that cannot be
  // read is a protection that is not in force, so the report REFUSES to run: no
  // extract-compare, no classify, no writes, no watermark, no label.
  //
  // The COMPUTE/INSERT half below stays best-effort on purpose — failing to record a NEW
  // settlement loses nothing that was already protected, so it must not stop the run.
  let knownSettled: ReadonlySet<string>;
  try {
    knownSettled = await deps.db.readFleconSettledDates();
  } catch (exc) {
    await deps.progress(
      "finalize",
      "Stopped — the list of locked bag dates could not be read, so nothing was touched.",
      100,
      undefined,
      "warn",
    );
    return {
      ok: false,
      classified: null,
      apply: null,
      note: "Settlement ledger unreadable — flecon refused to run.",
      gate_failures: [
        {
          gate: "settlement_ledger_unreadable",
          detail:
            `The list of bag dates that are locked (already sorted out by hand) could not be ` +
            `read from the database, so this run does not know which days it must leave alone. ` +
            `Bag movements are saved by rewriting a whole day at a time, so continuing could ` +
            `erase a day someone deliberately corrected. NOTHING was read, written or marked ` +
            `as processed — the report will try again on the next run.\n` +
            `Technical detail: ${errText(exc)}`,
        },
      ],
    };
  }

  await deps.progress("extract", "Reading the bag inventory spreadsheet…", 30);
  const buf = await readFile(wbMeta.path);
  const wb = await loadFleconWorkbook(buf);
  const registry = (await deps.db.readRows("flecon_bag_types", {
    columns: ["code", "source_label", "source_column", "sort_order", "label"],
    sinceColumn: null,
  })) as unknown as BagTypeRegistryRow[];
  const extract = extractFlecon(wb, basename(wbMeta.path), registry, since, null);

  await deps.progress("classify", "Comparing bag movements against the database…", 55);
  const movementsAll = (await deps.db.readRows("flecon_bag_movements", {
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

  // ── BUG-015 defect A: every date the DB holds (FULL history, not just >= since), so
  // the apply can tell a benign settled-history drop from a dropped date that was never
  // recorded at all. The same read feeds the DATE-SETTLEMENT criterion below, which needs
  // the movements themselves (not just the dates) for the out-of-year twin comparison. ──
  let dbDates: string[] | undefined;
  let dbAllMovements: FleconSettlementDbRow[] = [];
  try {
    const idToCode = new Map<unknown, string>();
    for (const t of bagTypes) idToCode.set(t.id, String(t.code ?? "").trim().toUpperCase());
    const allRows = await deps.db.readRows("flecon_bag_movements", {
      columns: ["transaction_date", "particular", "bag_type_id", "qty_delta"],
      sinceColumn: null,
    });
    dbDates = allRows.map((r) => String(r.transaction_date ?? "").slice(0, 10));
    dbAllMovements = allRows.map((r) => ({
      transaction_date: String(r.transaction_date ?? "").slice(0, 10),
      particular: r.particular,
      bag_type_code: idToCode.get(r.bag_type_id) ?? "",
      qty_delta: r.qty_delta,
    }));
  } catch {
    dbDates = undefined; // read failed → skip the benign/never-recorded split, never crash
    dbAllMovements = [];
  }

  // ── DATE-SETTLEMENT LEDGER (2026-07-29) ──────────────────────────────────────────
  // Mirrors rc_out's `runSync.ts::persistSettlements` → `reports/rc_out/index.ts` skip
  // pair, adapted to flecon's single-source reality: the ONLY thing settled automatically
  // is an out-of-year sheet-row group whose movements ALREADY EXIST in the DB under the
  // tab's own year (the 2026-01-31 hand-backfill shape). Everything else is settled by a
  // human seeding the ledger.
  //
  // The ledger itself was already READ (and its failure already refused the run) above —
  // ADDING a new settlement is what is guarded here. A failure to record a new one leaves
  // every date that was already settled just as protected as it was, so it degrades to
  // `knownSettled` rather than failing the run. It must NEVER degrade to an empty set.
  let settledDates: ReadonlySet<string> = knownSettled;
  try {
    const qualifying = computeFleconSettlements(
      extract.flagged_rows,
      extract.sheet_year,
      dbAllMovements,
      knownSettled,
    );
    const mutable = new Set(knownSettled);
    if (qualifying.length) {
      const res = await deps.db.insertFleconSettlements(
        qualifying.map((q) => ({ ...q, settled_by_run_id: runId })),
      );
      for (const d of res.insertedDates) mutable.add(d);
      if (res.insertedCount > 0) {
        await deps.progress(
          "classify",
          `Locked ${res.insertedCount} already-corrected date(s) — future runs will leave them alone.`,
          58,
        );
      }
    }
    settledDates = mutable;
  } catch {
    settledDates = knownSettled; // could not ADD one → keep every date already protected
  }

  // Settled dates are dropped from BOTH sides before classify — sheet rows AND the DB
  // compare-set. Dropping only the sheet side would leave the date present in db_by_date
  // with an empty sheet day, which classifies DATE_CHANGED-to-zero and lands in
  // `delete_to_empty_blocked` instead of being genuinely skipped.
  let skippedSettledRows = 0;
  let extractForClassify = extract;
  let movements = movementsAll;
  if (settledDates.size > 0) {
    const rows = extract.rows.filter((r) => {
      if (settledDates.has(r.transaction_date)) {
        skippedSettledRows += 1;
        return false;
      }
      return true;
    });
    // The mis-dated sheet rows carry the TYPO date (2025-01-31), not the settled date
    // (2026-01-31) — suppress them via the same tab-year correction the ledger settled on.
    const flaggedRows = extract.flagged_rows.filter((r) => {
      if (settledDates.has(r.transaction_date)) return false;
      const corrected = correctedDate(r.transaction_date, extract.sheet_year);
      return !(corrected !== null && settledDates.has(corrected));
    });
    extractForClassify = { ...extract, rows, flagged_rows: flaggedRows };
    movements = movementsAll.filter(
      (m) => !settledDates.has(String(m.transaction_date ?? "").slice(0, 10)),
    );
    if (skippedSettledRows > 0) {
      await deps.progress(
        "classify",
        `Skipped ${skippedSettledRows} bag movement(s) on already-settled date(s) — no re-check needed.`,
        60,
      );
    }
  }

  const classified = classifyFlecon(extractForClassify, since, {
    movements,
    bagTypes,
    viewBalance,
  });
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
  //
  // 2026-08-26: this used to read `extract.summary.date_max`, which is computed over the
  // rows that SURVIVED the `since` window. In the jam this fix unblocked, EVERY row in
  // Ivy's workbook was older than `since` (= watermark − 3 days), so `date_max` was null
  // and the operator was told the file "only carries bag movements up to (no dated rows)"
  // — about a workbook whose last row is plainly 2026-08-21. It now uses the WHOLE-SHEET
  // max (`wholeSheetMaxDate`), which names a date that actually exists.
  const workbookMaxDate = wholeSheetMaxDate(extract);
  const stale =
    watermark !== null && (workbookMaxDate === null || workbookMaxDate < watermark)
      ? { workbookMaxDate, dbWatermark: watermark }
      : null;

  const applyResult = await applyFlecon(
    {
      db: deps.db,
      progress: deps.progress,
      labelProcessed: deps.labelProcessed,
      // POST-WRITE balance re-read (2026-07-29). The cross-check must compare the app's
      // balances AFTER this run's own writes against the sheet's already-updated balance
      // row; reading them at classify time reported phantom drift on every importing run.
      readBalances: async () =>
        (await deps.db.readRows("view_flecon_bag_balance", { sinceColumn: null })) as Array<{
          code?: unknown;
          balance?: unknown;
        }>,
    },
    classified,
    {
      reportType: REPORT_TYPE,
      emailUid: wbMeta.uid ?? null,
      emailThreadId: wbMeta.threadId ?? null,
      noLabel: manifest.noLabel ?? false,
      flaggedRows: extractForClassify.flagged_rows,
      dbDates,
      staleWorkbook: stale,
      settledDates,
      sheetYear: extract.sheet_year,
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
              `${stale.dbWatermark}. This is an older copy of the workbook — nothing was written.` +
              (applyResult.labeled
                ? ` This older copy was marked as processed so it stops re-firing on every run; ` +
                  `nothing was written and the watermark did not move. Send the current FLECON ` +
                  `BAGGED file when there is one.`
                : ``),
          },
        ]
      : [],
  };
}

/**
 * The workbook's OWN latest bag-movement date, across the WHOLE SHEET (2026-08-26).
 *
 * NOT `extract.summary.date_max`: that is computed over `extract.rows`, which the `since`
 * floor has already filtered, so it answers "the newest day IN THIS RUN'S WINDOW". For the
 * staleness question — "is this attachment an older copy than what we already loaded?" —
 * the honest input is the newest day the FILE contains, window or no window. When every
 * row in the file is below the floor (exactly the 2026-08-24 jam: watermark 2026-08-25,
 * floor 2026-08-22, last sheet row 2026-08-21) `summary.date_max` is null and the message
 * degenerates to "(no dated rows)" about a workbook that is full of dated rows.
 *
 * The verdict is unchanged in every case that mattered — `since` is a FLOOR derived from
 * the watermark, so dropping rows below it can never lower the maximum unless it empties
 * the set, and an emptied set means every row was below `watermark − 3` and the workbook
 * was genuinely stale anyway. What changes is that the comparison no longer depends on
 * that coincidence, and the sentence names a real date.
 *
 * OUT-OF-YEAR rows are excluded. A date whose year is not the tab's own year is an operator
 * TYPO (§2a) and never evidence of how fresh the file is — a `2027-01-31` slip would
 * otherwise make a genuinely stale workbook look newer than the database and disarm this
 * gate entirely. The predicate is the same one `extract.ts` uses to set `out_of_year`.
 *
 * Returns null only when the file carries no usable dated movement row at all.
 */
export function wholeSheetMaxDate(extract: FleconExtract): string | null {
  const sheetYear = extract.sheet_year;
  let max: string | null = null;
  const consider = (raw: unknown): void => {
    const d = String(raw ?? "").slice(0, 10);
    if (!d) return;
    if (sheetYear !== null && Number(d.slice(0, 4)) !== sheetYear) return; // out-of-year typo
    if (max === null || d > max) max = d;
  };
  for (const r of extract.rows) consider(r.transaction_date);
  for (const f of extract.flagged_rows) consider(f.transaction_date);
  return max;
}

/** YYYY-MM-DD minus N days (UTC), mirroring date.fromisoformat(...) - timedelta(days=N). */
function subtractDays(iso: string, days: number): string {
  const [y, m, d] = iso.slice(0, 10).split("-").map(Number);
  const ms = Date.UTC(y, m - 1, d) - days * 86400000;
  const dt = new Date(ms);
  const p2 = (n: number) => String(n).padStart(2, "0");
  return `${dt.getUTCFullYear()}-${p2(dt.getUTCMonth() + 1)}-${p2(dt.getUTCDate())}`;
}
