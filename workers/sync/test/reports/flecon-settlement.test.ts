/**
 * flecon-settlement.test.ts — the FLECON DATE-SETTLEMENT LEDGER (2026-07-29).
 *
 * Three related fixes, all pinned here:
 *
 *   FIX 1 — `flecon_bag_date_settlements`. Ivy's `JANUARY 2026` tab has an operator
 *           year-typo in cell A75 (`2025-01-31`; rows 76-79 inherit it). Those five
 *           movements were HAND-BACKFILLED into `2026-01-31` on 2026-07-27 and Renzo
 *           decided NOT to correct the source cell. Today that backfill survives only
 *           because the sync's window never reaches January — a watermark reset would
 *           re-run from 2026-01-01, the extractor would refuse the mis-dated rows again,
 *           and REPLACE-BY-DATE would DELETE the backfill. A settled date is now skipped
 *           entirely: no extract-compare, no classify, no replace, NO DELETE.
 *   FIX 2 — the balance cross-check compared PRE-write app balances against the sheet's
 *           ALREADY-updated balance row, so every importing run reported phantom drift
 *           (run da9f2714: FG_ALL_BLACK "app 6 vs sheet 156" etc., all three matching the
 *           sheet once the day's movements landed). It now re-reads AFTER the writes.
 *   FIX 3 — the `out_of_year_date` finding asserted the rows "were NOT imported and never
 *           will be", which the backfill made false. A settled date suppresses it; a
 *           genuinely new out-of-year date still fires.
 */
import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { loadFleconWorkbook } from "../../src/reports/flecon/sheet.js";
import { extractFlecon, type FleconFlaggedRow } from "../../src/reports/flecon/extract.js";
import {
  computeFleconSettlements,
  correctedDate,
  type FleconSettlementDbRow,
} from "../../src/reports/flecon/settlement.js";
import {
  applyFlecon,
  buildBalanceDriftHold,
  buildFlaggedRowHolds,
  recomputeCrosscheckRows,
  type FleconApplyDeps,
} from "../../src/reports/flecon/apply.js";
import type { FleconClassified } from "../../src/reports/flecon/classify.js";
import { runReport, type FleconDeps } from "../../src/reports/flecon/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIX = resolve(__dirname, "../../fixtures/flecon");

const WORKBOOK = resolve(FIX, "workbooks/flecon_real_latest.xlsx");
const DB_WINDOW = resolve(FIX, "db_window/flecon_real_latest.json");

/** The mis-dated date the sheet literally carries, and its tab-year correction. */
const TYPO_DATE = "2025-01-31";
const BACKFILL_DATE = "2026-01-31";

// ─────────────────────────────────────────────────────────────────────────────
// Shared helpers
// ─────────────────────────────────────────────────────────────────────────────

interface DbWindow {
  movements: Array<Record<string, unknown>>;
  bag_types: Array<{ id: string; code: string }>;
  bag_type_registry: Array<Record<string, unknown>>;
  view_balance: Array<Record<string, unknown>>;
}

function loadDbWindow(): DbWindow {
  return JSON.parse(readFileSync(DB_WINDOW, "utf8")) as DbWindow;
}

/** Extract the REAL workbook at the January floor — the "watermark reset" scenario. */
async function extractAtJanuaryFloor(dw: DbWindow) {
  const wb = await loadFleconWorkbook(readFileSync(WORKBOOK));
  return extractFlecon(wb, "flecon_real_latest.xlsx", dw.bag_type_registry as never, "2026-01-01", null);
}

/**
 * The five hand-backfilled DB rows, derived FROM the sheet's own mis-dated rows — which
 * is exactly how the backfill was made (audit a6293bf8-…). Re-dated to the tab year.
 */
function backfillRowsFrom(flagged: FleconFlaggedRow[]): FleconSettlementDbRow[] {
  return flagged
    .filter((r) => r.out_of_year)
    .map((r) => ({
      transaction_date: BACKFILL_DATE,
      particular: r.particular,
      bag_type_code: r.bag_type_code,
      qty_delta: r.qty_delta,
    }));
}

function classified(over: Partial<FleconClassified> = {}): FleconClassified {
  return {
    table: "flecon_bag_movements",
    since: "2026-01-01",
    model: "REPLACE_BY_DATE",
    per_date: [],
    code_to_id: { ZAMBOANGA_BAG: "bag-uuid-1", ECOPACK_BEIGE: "bag-uuid-2" },
    balance_crosscheck: { available: false, rows: [], note: null },
    column_flags: { flagged: false, unmapped_columns: [], missing_columns: [], column_map: [], note: "" },
    summary: {
      new_days: 0,
      date_changed_days: 0,
      duplicate_noop_days: 0,
      total_days_in_window: 0,
      sheet_movements_in_window: 0,
      db_movements_in_window: 0,
      unmapped_columns: 0,
      missing_columns: 0,
      column_map_size: 0,
    },
    ...over,
  };
}

function makeApplyDeps() {
  const replaceFleconDate = vi.fn(async (_d: string, rows: Array<Record<string, unknown>>) => ({
    deleted: 5,
    deletedFirstId: "deleted-id-1",
    inserted: rows.length,
    firstId: rows.length ? "inserted-id-1" : null,
  }));
  const deps: FleconApplyDeps = {
    db: {
      replaceFleconDate,
      writeIngestionAudit: vi.fn(async () => ({ id: "audit-1" })),
      upsertIngestionWatermark: vi.fn(async () => true),
    },
    progress: async () => {},
    labelProcessed: vi.fn(async () => true),
  };
  return { deps, replaceFleconDate };
}

const APPLY_OPTS = { reportType: "flecon", emailUid: "42", emailThreadId: "t1", noLabel: false };

/** The shape that would DELETE the backfill: the sheet has one row for that date, the DB
 *  has five, so REPLACE-BY-DATE removes all five and writes one. Not the empty-day case
 *  (`delete_to_empty_blocked`) — that guard does not apply here. */
const replaceJanuary = classified({
  per_date: [
    {
      transaction_date: BACKFILL_DATE,
      class: "DATE_CHANGED",
      sheet_movement_count: 1,
      db_movement_count: 5,
      delta: { added: [], removed: [] },
      movements: [
        {
          transaction_date: BACKFILL_DATE,
          particular: "SOMETHING ELSE",
          bag_type_code: "ZAMBOANGA_BAG",
          qty_delta: -2,
          source_row: 74,
        },
      ],
    },
  ],
});

// ═════════════════════════════════════════════════════════════════════════════
// FIX 1a — the pure settle criterion
// ═════════════════════════════════════════════════════════════════════════════

describe("correctedDate — map a mis-dated row onto the tab's own year", () => {
  it("keeps month + day, swaps the year", () => {
    expect(correctedDate("2025-01-31", 2026)).toBe("2026-01-31");
    expect(correctedDate("2027-03-04", 2026)).toBe("2026-03-04");
  });

  it("returns null when there is nothing to correct or nothing to correct WITH", () => {
    expect(correctedDate("2026-01-31", 2026)).toBeNull(); // already in-year
    expect(correctedDate("2025-01-31", null)).toBeNull(); // unknown tab year
    expect(correctedDate("not-a-date", 2026)).toBeNull();
  });

  it("refuses an impossible calendar date rather than rolling it over", () => {
    expect(correctedDate("2024-02-29", 2026)).toBeNull(); // 2026 has no Feb 29
    expect(correctedDate("2024-02-29", 2028)).toBe("2028-02-29"); // leap → fine
  });
});

describe("computeFleconSettlements — settle ONLY a provably-arbitrated date", () => {
  it("settles when the DB already holds the mis-dated movements under the tab year", async () => {
    const dw = loadDbWindow();
    const extract = await extractAtJanuaryFloor(dw);
    const db = backfillRowsFrom(extract.flagged_rows);
    expect(db).toHaveLength(5); // the real A75 typo group

    const out = computeFleconSettlements(extract.flagged_rows, extract.sheet_year, db, new Set());
    expect(out).toHaveLength(1);
    expect(out[0].transaction_date).toBe(BACKFILL_DATE);
    expect(out[0].db_movement_count).toBe(5);
    expect(out[0].db_net_qty).toBe(231); // 100 + 128 − 1 + 18 − 14, as in production
    expect(out[0].reason).toBe("human_arbitrated_backfill");
    expect(out[0].note).toContain(BACKFILL_DATE);
  });

  it("NEVER settles without corroboration — silence is not agreement", async () => {
    const dw = loadDbWindow();
    const extract = await extractAtJanuaryFloor(dw);
    const db = backfillRowsFrom(extract.flagged_rows);

    // Nothing backfilled at all.
    expect(computeFleconSettlements(extract.flagged_rows, extract.sheet_year, [], new Set())).toEqual([]);
    // Backfill is incomplete (one row short).
    expect(
      computeFleconSettlements(extract.flagged_rows, extract.sheet_year, db.slice(1), new Set()),
    ).toEqual([]);
    // Backfill exists but a quantity differs — not the same movements.
    const tweaked = db.map((r, i) => (i === 0 ? { ...r, qty_delta: 999 } : r));
    expect(computeFleconSettlements(extract.flagged_rows, extract.sheet_year, tweaked, new Set())).toEqual([]);
    // Unknown tab year → no correction is derivable.
    expect(computeFleconSettlements(extract.flagged_rows, null, db, new Set())).toEqual([]);
    // Already settled → no duplicate row.
    expect(
      computeFleconSettlements(extract.flagged_rows, extract.sheet_year, db, new Set([BACKFILL_DATE])),
    ).toEqual([]);
  });

  it("ignores plain sub-floor drops — only an out-of-year group is evidence", () => {
    const inYearDrop: FleconFlaggedRow = {
      transaction_date: "2026-03-04",
      source_row: 12,
      particular: "USED BAG OF SUNDRY",
      bag_type_code: "KOREA_WHITE_SUNDRY",
      qty_delta: -4,
      dropped: true,
      out_of_year: false,
    };
    const db: FleconSettlementDbRow[] = [
      { transaction_date: "2026-03-04", particular: "USED BAG OF SUNDRY", bag_type_code: "KOREA_WHITE_SUNDRY", qty_delta: -4 },
    ];
    expect(computeFleconSettlements([inYearDrop], 2026, db, new Set())).toEqual([]);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// FIX 1b — THE REGRESSION THAT MATTERS: a settled date is never deleted.
// ═════════════════════════════════════════════════════════════════════════════

describe("applyFlecon — a settled date is skipped, never replaced, never deleted", () => {
  it("CONTROL: without the ledger, REPLACE-BY-DATE deletes the backfilled day", async () => {
    const { deps, replaceFleconDate } = makeApplyDeps();
    const res = await applyFlecon(deps, replaceJanuary, APPLY_OPTS);

    // This is the data loss: five hand-placed rows removed, one sheet row written back.
    expect(replaceFleconDate).toHaveBeenCalledOnce();
    expect(replaceFleconDate.mock.calls[0][0]).toBe(BACKFILL_DATE);
    expect(res.replaced_dates).toBe(1);
    expect(res.settled_dates_skipped).toBe(0);
  });

  it("with the date settled, replaceFleconDate is never called for it", async () => {
    const { deps, replaceFleconDate } = makeApplyDeps();
    const res = await applyFlecon(deps, replaceJanuary, {
      ...APPLY_OPTS,
      settledDates: new Set([BACKFILL_DATE]),
    });

    expect(replaceFleconDate).not.toHaveBeenCalled();
    expect(res.replaced_dates).toBe(0);
    expect(res.inserts).toBe(0);
    expect(res.settled_dates_skipped).toBe(1);
    expect(res.ok).toBe(true);
    // A settled date is not a problem to report — it is silence by design.
    expect(res.held.filter((h) => JSON.stringify(h).includes(BACKFILL_DATE))).toEqual([]);
  });

  it("settling one date does not stop any other date from writing", async () => {
    const { deps, replaceFleconDate } = makeApplyDeps();
    const res = await applyFlecon(
      deps,
      classified({
        per_date: [
          ...replaceJanuary.per_date,
          {
            transaction_date: "2026-07-27",
            class: "NEW",
            sheet_movement_count: 1,
            db_movement_count: 0,
            delta: { added: [], removed: [] },
            movements: [
              {
                transaction_date: "2026-07-27",
                particular: "RS 1 ZAMBOANGA",
                bag_type_code: "ZAMBOANGA_BAG",
                qty_delta: -2,
                source_row: 500,
              },
            ],
          },
        ],
      }),
      { ...APPLY_OPTS, settledDates: new Set([BACKFILL_DATE]) },
    );

    expect(replaceFleconDate).toHaveBeenCalledOnce();
    expect(replaceFleconDate.mock.calls[0][0]).toBe("2026-07-27");
    expect(res.replaced_dates).toBe(1);
    expect(res.settled_dates_skipped).toBe(1);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// FIX 1c — chokepoint: runReport, re-run scoped back to January (watermark reset).
// ═════════════════════════════════════════════════════════════════════════════

function makeRunDeps(opts: {
  dbMovements: Array<Record<string, unknown>>;
  settled: string[];
}) {
  const dw = loadDbWindow();
  const codeToId = new Map(dw.bag_types.map((t) => [t.code, t.id]));
  // The DB movements the fake table holds, expressed with bag_type_id like the real table.
  const rows = opts.dbMovements.map((m, i) => ({
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
    async (settleRows: Array<{ transaction_date: string }>) => ({
      insertedCount: settleRows.length,
      insertedDates: settleRows.map((r) => r.transaction_date),
      skippedCount: 0,
    }),
  );
  const settled = new Set(opts.settled);

  const db = {
    dataWatermark: async () => null, // ← the watermark reset: since falls to 2026-01-01
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
    readFleconSettledDates: async () => new Set(settled),
    insertFleconSettlements,
    replaceFleconDate,
    writeIngestionAudit: async () => ({ id: "a" }),
    upsertIngestionWatermark: async () => true,
  };

  const deps: FleconDeps = {
    db: db as unknown as FleconDeps["db"],
    progress: async () => {},
    fetchLatestWorkbook: async () => ({ path: WORKBOOK, subject: "FLECON BAGGED", uid: "9", threadId: "t9" }),
    labelProcessed: async () => true,
  };
  return { deps, replaceFleconDate, insertFleconSettlements, dw };
}

describe("runReport — a January-scoped re-run can no longer delete the backfill", () => {
  it("SETTLED: 2026-01-31 never reaches classify, never reaches replaceFleconDate", async () => {
    const dw = loadDbWindow();
    const extract = await extractAtJanuaryFloor(dw);
    const backfill = backfillRowsFrom(extract.flagged_rows);

    const { deps, replaceFleconDate } = makeRunDeps({
      dbMovements: backfill as unknown as Array<Record<string, unknown>>,
      settled: [BACKFILL_DATE],
    });

    const res = await runReport(deps, "run-jan", { noLabel: true });

    // The date is invisible to classify — no per_date entry of any class.
    expect(res.classified?.per_date.some((p) => p.transaction_date === BACKFILL_DATE)).toBe(false);
    // …and no write of any kind touched it. THIS is the regression guard.
    expect(replaceFleconDate.mock.calls.map((c) => c[0])).not.toContain(BACKFILL_DATE);
    // FIX 3: the out-of-year finding is suppressed — the rows ARE imported, under 2026-01-31.
    const heldJson = (res.apply?.held ?? []).map((h) => JSON.stringify(h));
    expect(heldJson.some((s) => s.includes(TYPO_DATE))).toBe(false);
    expect((res.apply?.held ?? []).some((h) => h.reason === "out_of_year_date")).toBe(false);
  });

  it("AUTO-SETTLE: an empty ledger settles the already-backfilled date on this very run", async () => {
    const dw = loadDbWindow();
    const extract = await extractAtJanuaryFloor(dw);
    const backfill = backfillRowsFrom(extract.flagged_rows);

    const { deps, replaceFleconDate, insertFleconSettlements } = makeRunDeps({
      dbMovements: backfill as unknown as Array<Record<string, unknown>>,
      settled: [],
    });

    const res = await runReport(deps, "run-auto", { noLabel: true });

    expect(insertFleconSettlements).toHaveBeenCalledOnce();
    const written = insertFleconSettlements.mock.calls[0][0] as Array<Record<string, unknown>>;
    expect(written).toHaveLength(1);
    expect(written[0].transaction_date).toBe(BACKFILL_DATE);
    expect(written[0].settled_by_run_id).toBe("run-auto");
    // Settled THIS run → the skip already applies on the same run.
    expect(replaceFleconDate.mock.calls.map((c) => c[0])).not.toContain(BACKFILL_DATE);
    expect(res.classified?.per_date.some((p) => p.transaction_date === BACKFILL_DATE)).toBe(false);
  });

  it("CONTROL: with no ledger AND no matching backfill, the date is back in play", async () => {
    const dw = loadDbWindow();
    const extract = await extractAtJanuaryFloor(dw);
    // A backfill that does NOT match the sheet's mis-dated rows → never auto-settles.
    const mismatched = backfillRowsFrom(extract.flagged_rows).map((r) => ({ ...r, qty_delta: 777 }));

    const { deps, insertFleconSettlements } = makeRunDeps({
      dbMovements: mismatched as unknown as Array<Record<string, unknown>>,
      settled: [],
    });

    const res = await runReport(deps, "run-control", { noLabel: true });

    expect(insertFleconSettlements).not.toHaveBeenCalled();
    // The date reaches classify (and is caught by the BUG-015 empty-day guard, not the ledger).
    expect(res.classified?.per_date.some((p) => p.transaction_date === BACKFILL_DATE)).toBe(true);
    // …and the out-of-year finding fires, because nobody has arbitrated this.
    expect((res.apply?.held ?? []).some((h) => h.reason === "out_of_year_date")).toBe(true);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// FIX 2 — the balance cross-check reads AFTER the writes.
// ═════════════════════════════════════════════════════════════════════════════

describe("balance cross-check — compares POST-write app balances", () => {
  /** The exact numbers run da9f2714 (2026-07-29) reported as drift, and the live values. */
  const preWrite = classified({
    balance_crosscheck: {
      available: true,
      note: "INFORMATIONAL",
      rows: [
        { code: "FG_ALL_BLACK", db_view_balance: 6, sheet_snapshot_balance: 156, drift: -150 },
        { code: "KOREA_WHITE_SUNDRY", db_view_balance: 306, sheet_snapshot_balance: 282, drift: 24 },
        { code: "ZAMBOANGA_BAG", db_view_balance: 0, sheet_snapshot_balance: 160, drift: -160 },
      ],
    },
    per_date: [
      {
        transaction_date: "2026-07-27",
        class: "NEW",
        sheet_movement_count: 1,
        db_movement_count: 0,
        delta: { added: [], removed: [] },
        movements: [
          {
            transaction_date: "2026-07-27",
            particular: "RS 1 ZAMBOANGA",
            bag_type_code: "ZAMBOANGA_BAG",
            qty_delta: -2,
            source_row: 500,
          },
        ],
      },
    ],
  });

  /** What the DB actually reads once this run's 2026-07-27 movements have landed. */
  const postWrite = [
    { code: "FG_ALL_BLACK", balance: 156 },
    { code: "KOREA_WHITE_SUNDRY", balance: 282 },
    { code: "ZAMBOANGA_BAG", balance: 160 },
  ];

  it("recomputes drift against the fresh balances", () => {
    const rows = recomputeCrosscheckRows(preWrite.balance_crosscheck.rows, postWrite);
    expect(rows.map((r) => r.drift)).toEqual([0, 0, 0]);
    expect(rows.find((r) => r.code === "FG_ALL_BLACK")?.db_view_balance).toBe(156);
    // A code the fresh read does not carry is un-comparable, never "drift".
    expect(recomputeCrosscheckRows(preWrite.balance_crosscheck.rows, [])[0]).toMatchObject({
      db_view_balance: null,
      drift: null,
    });
  });

  it("reports NO drift when the run itself imported the movements (the false alarm)", async () => {
    const { deps, replaceFleconDate } = makeApplyDeps();
    deps.readBalances = vi.fn(async () => postWrite);

    const res = await applyFlecon(deps, preWrite, APPLY_OPTS);

    expect(replaceFleconDate).toHaveBeenCalledOnce(); // the day still wrote
    expect(deps.readBalances).toHaveBeenCalledOnce();
    expect(res.held.some((h) => h.reason === "balance_crosscheck_drift")).toBe(false);
  });

  it("still reports GENUINE drift — the tolerance was not widened", async () => {
    const { deps } = makeApplyDeps();
    deps.readBalances = vi.fn(async () => [
      { code: "FG_ALL_BLACK", balance: 156 },
      { code: "KOREA_WHITE_SUNDRY", balance: 282 },
      { code: "ZAMBOANGA_BAG", balance: 159 }, // one bag genuinely missing after the write
    ]);

    const res = await applyFlecon(deps, preWrite, APPLY_OPTS);
    const h = res.held.find((x) => x.reason === "balance_crosscheck_drift");
    expect(h).toBeDefined();
    expect(h!.row?.bag_type_codes).toEqual(["ZAMBOANGA_BAG"]);
    expect(h!.detail).toContain("app says 159");
  });

  it("falls back to the classify-time rows when no re-read is wired (offline callers)", async () => {
    const { deps } = makeApplyDeps();
    const res = await applyFlecon(deps, preWrite, APPLY_OPTS);
    expect(res.held.some((h) => h.reason === "balance_crosscheck_drift")).toBe(true);
    expect(buildBalanceDriftHold(preWrite)).not.toBeNull();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// FIX 3 — the out-of-year finding: suppressed once settled, loud when new.
// ═════════════════════════════════════════════════════════════════════════════

describe("out_of_year_date — settled suppresses, new still fires", () => {
  const typoRows: FleconFlaggedRow[] = [
    { transaction_date: TYPO_DATE, source_row: 75, particular: "FIBC ECOPACK", bag_type_code: "ECOPACK_BEIGE", qty_delta: 100, dropped: true, out_of_year: true },
    { transaction_date: TYPO_DATE, source_row: 76, particular: "ZAMBOANGA DELIVERED", bag_type_code: "ZAMBOANGA_BAG", qty_delta: 128, dropped: true, out_of_year: true },
  ];
  const newTypo: FleconFlaggedRow[] = [
    { transaction_date: "2025-06-04", source_row: 300, particular: "USED BAG OF SUNDRY", bag_type_code: "KOREA_WHITE_SUNDRY", qty_delta: -9, dropped: true, out_of_year: true },
  ];

  it("suppresses the finding once the CORRECTED date is settled", () => {
    expect(buildFlaggedRowHolds(typoRows, [BACKFILL_DATE])).toHaveLength(1); // no ledger → fires
    expect(
      buildFlaggedRowHolds(typoRows, [BACKFILL_DATE], {
        dates: new Set([BACKFILL_DATE]),
        sheetYear: 2026,
      }),
    ).toEqual([]);
  });

  it("a genuinely NEW out-of-year date still fires at full volume", () => {
    const held = buildFlaggedRowHolds([...typoRows, ...newTypo], [BACKFILL_DATE], {
      dates: new Set([BACKFILL_DATE]),
      sheetYear: 2026,
    });
    expect(held).toHaveLength(1);
    expect(held[0].reason).toBe("out_of_year_date");
    expect(held[0].row?.transaction_date).toBe("2025-06-04");
    expect(held[0].detail).toContain("KOREA_WHITE_SUNDRY −9");
  });

  it("an unrelated settled date does not silence a different typo", () => {
    const held = buildFlaggedRowHolds(typoRows, [BACKFILL_DATE], {
      dates: new Set(["2026-05-05"]),
      sheetYear: 2026,
    });
    expect(held).toHaveLength(1);
    expect(held[0].row?.transaction_date).toBe(TYPO_DATE);
  });
});
