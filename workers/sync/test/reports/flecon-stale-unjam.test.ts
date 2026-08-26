/**
 * flecon-stale-unjam.test.ts — the 2026-08-26 flecon fixes.
 *
 * Three things, all measured in the live system first:
 *
 *   1. UNJAM. Ivy's FLECON BAGGED email of 2026-08-24 00:58 (uid 126413) carries a
 *      workbook whose last dated row is 2026-08-21 while the DB watermark is 2026-08-25.
 *      The `stale_workbook` gate correctly refuses to write it — but because the gate
 *      failed, `labelProcessed` was never called, so the SAME dead email was re-fetched
 *      and re-refused on every run (4a8602ac, 7f23dd88, a67e9c4a — all `partial`). An
 *      older copy of a CUMULATIVE workbook can never become applicable, so it is now
 *      labeled processed on the run that refuses it. The refusal to WRITE is unchanged.
 *
 *   2. THE MESSAGE NAMES A DATE THAT EXISTS. The gate detail read "…only carries bag
 *      movements up to (no dated rows)" because it used `extract.summary.date_max`, which
 *      is computed over the rows that SURVIVED the `since` window — and in this jam every
 *      row in the file is below the floor. `wholeSheetMaxDate` answers the question the
 *      sentence is actually asking.
 *
 *   3. THE SETTLED-DATES READ FAILS CLOSED. `flecon_bag_date_settlements` is the only
 *      thing standing between REPLACE-BY-DATE and a date a human arbitrated by hand. A
 *      read failure used to degrade to "nothing is settled" and carry on — L-044's exact
 *      shape. It now refuses the whole report.
 *
 * These assert the GUARDS, not the wording.
 */
import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { loadFleconWorkbook } from "../../src/reports/flecon/sheet.js";
import { extractFlecon, type FleconExtract } from "../../src/reports/flecon/extract.js";
import { runReport, wholeSheetMaxDate, type FleconDeps } from "../../src/reports/flecon/index.js";
import { applyFlecon, type FleconApplyDeps } from "../../src/reports/flecon/apply.js";
import type { FleconClassified } from "../../src/reports/flecon/classify.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIX = resolve(__dirname, "../../fixtures/flecon");
const WORKBOOK = resolve(FIX, "workbooks/flecon_real_latest.xlsx");
const DB_WINDOW = resolve(FIX, "db_window/flecon_real_latest.json");

/** The real fixture workbook's own last dated row (whole sheet, in-year). */
const SHEET_MAX = "2026-07-02";
/** A watermark far enough ahead that `since` (= watermark − 3d) drops EVERY sheet row. */
const AHEAD_WATERMARK = "2026-07-23";

interface DbWindow {
  movements: Array<Record<string, unknown>>;
  bag_types: Array<{ id: string; code: string }>;
  bag_type_registry: Array<Record<string, unknown>>;
  view_balance: Array<Record<string, unknown>>;
}
function loadDbWindow(): DbWindow {
  return JSON.parse(readFileSync(DB_WINDOW, "utf8")) as DbWindow;
}

async function extractAt(since: string): Promise<FleconExtract> {
  const dw = loadDbWindow();
  const wb = await loadFleconWorkbook(readFileSync(WORKBOOK));
  return extractFlecon(
    wb,
    "FLECON BAG MOVEMENT 2026 .xlsx",
    dw.bag_type_registry as never,
    since,
    null,
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// A runReport harness. Everything is injected; nothing touches Gmail or a DB.
// ─────────────────────────────────────────────────────────────────────────────

function makeRunDeps(
  opts: {
    watermark?: string | null;
    settled?: string[];
    readSettledThrows?: boolean;
    insertSettlementsThrows?: boolean;
    dbMovements?: Array<Record<string, unknown>>;
    labelThrows?: boolean;
  } = {},
) {
  const dw = loadDbWindow();
  const codeToId = new Map(dw.bag_types.map((t) => [t.code, t.id]));
  const rows = (opts.dbMovements ?? []).map((m, i) => ({
    id: `db-${i}`,
    transaction_date: m.transaction_date,
    particular: m.particular,
    bag_type_id: codeToId.get(String(m.bag_type_code)) ?? "unknown-id",
    qty_delta: m.qty_delta,
  }));

  const replaceFleconDate = vi.fn(async (_d: string, r: Array<Record<string, unknown>>) => ({
    deleted: 0,
    deletedFirstId: null,
    inserted: r.length,
    firstId: r.length ? "ins-1" : null,
  }));
  const insertFleconSettlements = vi.fn(
    async (settleRows: Array<{ transaction_date: string }>) => {
      if (opts.insertSettlementsThrows) throw new Error("settlement insert 503");
      return {
        insertedCount: settleRows.length,
        insertedDates: settleRows.map((r) => r.transaction_date),
        skippedCount: 0,
      };
    },
  );
  const readFleconSettledDates = vi.fn(async () => {
    if (opts.readSettledThrows) {
      throw new Error('permission denied for table flecon_bag_date_settlements (42501)');
    }
    return new Set(opts.settled ?? []);
  });
  const upsertIngestionWatermark = vi.fn(async () => true);
  const labelProcessed = vi.fn(async () => {
    if (opts.labelThrows) throw new Error("IMAP STORE failed");
    return true;
  });

  const db = {
    dataWatermark: async () => opts.watermark ?? null,
    readRows: async (table: string, o: Record<string, unknown> = {}) => {
      if (table === "flecon_bag_types") {
        const cols = (o.columns as string[]) ?? [];
        return cols.includes("source_label")
          ? (dw.bag_type_registry as Array<Record<string, unknown>>)
          : (dw.bag_types as unknown as Array<Record<string, unknown>>);
      }
      if (table === "view_flecon_bag_balance") return dw.view_balance;
      if (table === "flecon_bag_movements") {
        const since = o.sinceDate as string | undefined;
        return since ? rows.filter((r) => String(r.transaction_date) >= since) : rows;
      }
      return [];
    },
    readFleconSettledDates,
    insertFleconSettlements,
    replaceFleconDate,
    writeIngestionAudit: async () => ({ id: "a" }),
    upsertIngestionWatermark,
  };

  const deps: FleconDeps = {
    db: db as unknown as FleconDeps["db"],
    progress: async () => {},
    fetchLatestWorkbook: async () => ({
      path: WORKBOOK,
      subject: "FLECON BAGGED",
      uid: "126413",
      threadId: "t9",
    }),
    labelProcessed,
  };
  return {
    deps,
    replaceFleconDate,
    insertFleconSettlements,
    readFleconSettledDates,
    upsertIngestionWatermark,
    labelProcessed,
  };
}

// ═════════════════════════════════════════════════════════════════════════════
// FIX 2 — the workbook's OWN max date, not the window's.
// ═════════════════════════════════════════════════════════════════════════════

describe("wholeSheetMaxDate — the date the message is allowed to name", () => {
  it("reproduces the jam: the window-scoped max is null while the sheet plainly has dates", async () => {
    const ex = await extractAt("2026-07-20"); // every row in the file is older than this
    expect(ex.rows).toHaveLength(0);
    expect(ex.summary.date_max).toBeNull(); // ← what the old message printed as "(no dated rows)"
    expect(wholeSheetMaxDate(ex)).toBe(SHEET_MAX);
  });

  it("agrees with the window max when the window contains the newest row", async () => {
    const ex = await extractAt("2026-01-01");
    expect(ex.summary.date_max).toBe(SHEET_MAX);
    expect(wholeSheetMaxDate(ex)).toBe(SHEET_MAX);
  });

  it("IGNORES an out-of-year typo date — a slip must not disarm the staleness gate", async () => {
    const ex = await extractAt("2026-01-01");
    const withFutureTypo: FleconExtract = {
      ...ex,
      flagged_rows: [
        ...ex.flagged_rows,
        {
          transaction_date: "2027-01-31", // an operator year-typo inside the 2026 tab
          source_row: 900,
          particular: "TYPO",
          bag_type_code: "ZAMBOANGA_BAG",
          qty_delta: 1,
          dropped: false,
          out_of_year: true,
        },
      ],
    };
    expect(withFutureTypo.sheet_year).toBe(2026);
    expect(wholeSheetMaxDate(withFutureTypo)).toBe(SHEET_MAX);
  });

  it("returns null only when the file carries no usable dated row at all", async () => {
    const ex = await extractAt("2026-01-01");
    expect(wholeSheetMaxDate({ ...ex, rows: [], flagged_rows: [] })).toBeNull();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// FIX 1 — a deterministically-stale attachment is labeled, once, after refusal.
// ═════════════════════════════════════════════════════════════════════════════

/** A minimal classified envelope with one day the stale workbook is missing. */
function staleClassified(): FleconClassified {
  return {
    table: "flecon_bag_movements",
    since: "2026-07-20",
    model: "REPLACE_BY_DATE",
    per_date: [
      {
        transaction_date: "2026-07-22",
        class: "DATE_CHANGED",
        sheet_movement_count: 0,
        db_movement_count: 4,
        delta: { added: [], removed: [] },
        movements: [],
      },
    ],
    code_to_id: { ZAMBOANGA_BAG: "bag-uuid-1" },
    balance_crosscheck: { available: false, rows: [], note: null },
    column_flags: {
      flagged: false,
      unmapped_columns: [],
      missing_columns: [],
      column_map: [],
      note: "",
    },
    summary: {
      new_days: 0,
      date_changed_days: 1,
      duplicate_noop_days: 0,
      total_days_in_window: 1,
      sheet_movements_in_window: 0,
      db_movements_in_window: 4,
      unmapped_columns: 0,
      missing_columns: 0,
      column_map_size: 0,
    },
  } as FleconClassified;
}

function makeApplyDeps(opts: { labelThrows?: boolean } = {}) {
  const replaceFleconDate = vi.fn(async () => ({
    deleted: 0,
    deletedFirstId: null,
    inserted: 0,
    firstId: null,
  }));
  const upsertIngestionWatermark = vi.fn(async () => true);
  const labelProcessed = vi.fn(async () => {
    if (opts.labelThrows) throw new Error("IMAP STORE failed");
    return true;
  });
  const deps: FleconApplyDeps = {
    db: {
      replaceFleconDate,
      writeIngestionAudit: async () => ({ id: "a" }),
      upsertIngestionWatermark,
    } as unknown as FleconApplyDeps["db"],
    progress: async () => {},
    labelProcessed,
  };
  return { deps, replaceFleconDate, upsertIngestionWatermark, labelProcessed };
}

const APPLY_OPTS = {
  reportType: "flecon",
  emailUid: "126413",
  emailThreadId: "t9",
  noLabel: false,
};

describe("stale workbook — refuse the write, but stop re-reading the dead email", () => {
  it("labels a STRICTLY-older attachment and still reports the gate failure", async () => {
    const { deps, replaceFleconDate, upsertIngestionWatermark, labelProcessed } = makeApplyDeps();
    const res = await applyFlecon(deps, staleClassified(), {
      ...APPLY_OPTS,
      staleWorkbook: { workbookMaxDate: "2026-08-21", dbWatermark: "2026-08-25" },
    });

    // The REFUSAL is untouched: nothing written, no watermark, still not ok.
    expect(replaceFleconDate).not.toHaveBeenCalled();
    expect(upsertIngestionWatermark).not.toHaveBeenCalled();
    expect(res.watermark_updated).toBe(false);
    expect(res.inserts).toBe(0);
    expect(res.ok).toBe(false); // ← this run is still `partial`; the human sees it ONCE
    // Only the LABEL decision changed.
    expect(labelProcessed).toHaveBeenCalledWith("126413");
    expect(res.labeled).toBe(true);
    const h = res.held.find((x) => x.reason === "stale_workbook")!;
    expect(h.kind).toBe("gate_failure");
    expect(h.row?.email_labeled_processed).toBe(true);
  });

  it("does NOT label a workbook with no dated rows at all — that is a different failure", async () => {
    const { deps, labelProcessed } = makeApplyDeps();
    const res = await applyFlecon(deps, staleClassified(), {
      ...APPLY_OPTS,
      staleWorkbook: { workbookMaxDate: null, dbWatermark: "2026-08-25" },
    });

    expect(labelProcessed).not.toHaveBeenCalled();
    expect(res.labeled).toBe(false);
    expect(res.ok).toBe(false);
    expect(res.held.find((x) => x.reason === "stale_workbook")!.row?.email_labeled_processed).toBe(
      false,
    );
  });

  it("does NOT label in a dry run (noLabel)", async () => {
    const { deps, labelProcessed } = makeApplyDeps();
    const res = await applyFlecon(deps, staleClassified(), {
      ...APPLY_OPTS,
      noLabel: true,
      staleWorkbook: { workbookMaxDate: "2026-08-21", dbWatermark: "2026-08-25" },
    });

    expect(labelProcessed).not.toHaveBeenCalled();
    expect(res.labeled).toBe(false);
  });

  it("survives a labeling failure — a Gmail error never turns a clean refusal into a crash", async () => {
    const { deps } = makeApplyDeps({ labelThrows: true });
    const res = await applyFlecon(deps, staleClassified(), {
      ...APPLY_OPTS,
      staleWorkbook: { workbookMaxDate: "2026-08-21", dbWatermark: "2026-08-25" },
    });

    expect(res.labeled).toBe(false);
    expect(res.ok).toBe(false);
    expect(res.errors).toEqual([]);
  });

  it("END TO END: the real workbook, an ahead-of-it watermark → labeled once, named honestly", async () => {
    const { deps, replaceFleconDate, upsertIngestionWatermark, labelProcessed } = makeRunDeps({
      watermark: AHEAD_WATERMARK,
      settled: [],
    });

    const res = await runReport(deps, "run-stale", { noLabel: false });

    expect(res.ok).toBe(false);
    expect(res.gate_failures.map((g) => g.gate)).toEqual(["stale_workbook"]);
    // FIX 2: the sentence names the workbook's own last date, never "(no dated rows)".
    const detail = res.gate_failures[0].detail;
    expect(detail).toContain(SHEET_MAX);
    expect(detail).toContain(AHEAD_WATERMARK);
    expect(detail).not.toContain("no dated rows");
    // FIX 1: nothing written, watermark untouched — but the dead email is done.
    expect(replaceFleconDate).not.toHaveBeenCalled();
    expect(upsertIngestionWatermark).not.toHaveBeenCalled();
    expect(labelProcessed).toHaveBeenCalledWith("126413");
    expect(res.apply?.labeled).toBe(true);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// FIX 3 — the settled-dates read fails CLOSED.
// ═════════════════════════════════════════════════════════════════════════════

describe("settlement ledger — unreadable means the report refuses to run", () => {
  it("REFUSES the whole report: no extract-compare, no write, no watermark, no label", async () => {
    const { deps, replaceFleconDate, upsertIngestionWatermark, labelProcessed } = makeRunDeps({
      watermark: null, // the January floor — the widest, most dangerous window there is
      readSettledThrows: true,
    });

    const res = await runReport(deps, "run-ledger-down", {});

    expect(res.ok).toBe(false);
    expect(res.gate_failures.map((g) => g.gate)).toEqual(["settlement_ledger_unreadable"]);
    expect(res.gate_failures[0].detail).toContain("42501"); // names the actual read error
    expect(res.classified).toBeNull();
    expect(res.apply).toBeNull();
    expect(replaceFleconDate).not.toHaveBeenCalled();
    expect(upsertIngestionWatermark).not.toHaveBeenCalled();
    expect(labelProcessed).not.toHaveBeenCalled();
  });

  it("CONTROL: the same run with a readable ledger proceeds and classifies", async () => {
    const { deps, readFleconSettledDates } = makeRunDeps({ watermark: null, settled: [] });

    const res = await runReport(deps, "run-ledger-up", { noLabel: true });

    expect(readFleconSettledDates).toHaveBeenCalledOnce();
    expect(res.gate_failures).toEqual([]);
    expect(res.classified).not.toBeNull();
    expect(res.classified!.per_date.length).toBeGreaterThan(0);
  });

  it("a failure to RECORD a new settlement is not fatal, and keeps every settled date protected", async () => {
    const PROTECTED = "2026-01-31";
    const { deps, replaceFleconDate } = makeRunDeps({
      watermark: null,
      settled: [PROTECTED],
      insertSettlementsThrows: true,
    });

    const res = await runReport(deps, "run-insert-down", { noLabel: true });

    // The run continues…
    expect(res.gate_failures).toEqual([]);
    expect(res.classified).not.toBeNull();
    // …and the already-settled date is STILL skipped — it never degrades to an empty set.
    expect(res.classified!.per_date.some((p) => p.transaction_date === PROTECTED)).toBe(false);
    expect(replaceFleconDate.mock.calls.map((c) => c[0])).not.toContain(PROTECTED);
  });
});
