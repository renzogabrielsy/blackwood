/**
 * flecon-guards.test.ts — the BUG-015 guards (2026-07-27).
 *
 * Three defects, all confirmed against production data, all pinned here:
 *
 *   A. The extractor silently dropped every `< since` row behind a bare counter. An
 *      operator year-typo (`2025-01-31` typed inside the `JANUARY 2026` tab, sheet rows
 *      75–79) therefore fell below the floor on EVERY run and was never ingested, never
 *      flagged. The real fixture workbook reproduces the typo byte-for-byte.
 *   B. `balance_crosscheck` was computed on every run and thrown away — it had been
 *      correctly reporting the resulting −100 / −4 / −127 drift for three weeks.
 *   C. A stale (older-revision) workbook made a real day classify DATE_CHANGED with an
 *      EMPTY movement list, and the non-transactional delete+insert wiped the day with
 *      NO audit row. Confirmed 3x in production; 2026-07-22 was gone for ~19 hours.
 *
 * These assert the GUARDS, not the wording.
 */
import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
  extractFlecon,
  parseSheetYear,
  type FleconFlaggedRow,
} from "../../src/reports/flecon/extract.js";
import { loadFleconWorkbook } from "../../src/reports/flecon/sheet.js";
import {
  applyFlecon,
  buildBalanceDriftHold,
  buildFlaggedRowHolds,
  type FleconApplyDeps,
} from "../../src/reports/flecon/apply.js";
import type { FleconClassified } from "../../src/reports/flecon/classify.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIX = resolve(__dirname, "../../fixtures/flecon");

// ─────────────────────────────────────────────────────────────────────────────
// Test doubles
// ─────────────────────────────────────────────────────────────────────────────

function makeDeps() {
  const replaceFleconDate = vi.fn(
    async (_date: string, rows: Array<Record<string, unknown>>) => ({
      deleted: 1,
      deletedFirstId: "deleted-id-1",
      inserted: rows.length,
      firstId: rows.length ? "inserted-id-1" : null,
    }),
  );
  const writeIngestionAudit = vi.fn(
    async (_args: Parameters<FleconApplyDeps["db"]["writeIngestionAudit"]>[0]) => ({ id: "audit-1" }),
  );
  const upsertIngestionWatermark = vi.fn(async () => true);
  const labelProcessed = vi.fn(async () => true);
  const deps: FleconApplyDeps = {
    db: { replaceFleconDate, writeIngestionAudit, upsertIngestionWatermark },
    progress: async () => {},
    labelProcessed,
  };
  return { deps, replaceFleconDate, writeIngestionAudit, upsertIngestionWatermark, labelProcessed };
}

function classified(over: Partial<FleconClassified> = {}): FleconClassified {
  return {
    table: "flecon_bag_movements",
    since: "2026-07-01",
    model: "REPLACE_BY_DATE",
    per_date: [],
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

const OPTS = {
  reportType: "flecon",
  emailUid: "42",
  emailThreadId: "t1",
  noLabel: false,
};

// ═════════════════════════════════════════════════════════════════════════════
// A. Out-of-year rows — the real 2025-01-31 typo, straight from the fixture.
// ═════════════════════════════════════════════════════════════════════════════

describe("defect A — the mis-dated JANUARY rows are no longer swallowed", () => {
  it("parses the tab's own year from its sheet name", () => {
    expect(parseSheetYear("JANUARY 2026")).toBe(2026);
    expect(parseSheetYear("JANUARY2022")).toBe(2022);
    expect(parseSheetYear("SUMMARY")).toBeNull();
  });

  it("flags sheet rows 75-79 (dated 2025-01-31 inside the JANUARY 2026 tab)", async () => {
    const dbWindow = JSON.parse(
      readFileSync(resolve(FIX, "db_window/flecon_real_latest.json"), "utf8"),
    );
    const wb = await loadFleconWorkbook(
      readFileSync(resolve(FIX, "workbooks/flecon_real_latest.xlsx")),
    );
    const extract = extractFlecon(
      wb,
      "flecon_real_latest.xlsx",
      dbWindow.bag_type_registry,
      "2026-01-01",
      null,
    );

    expect(extract.sheet_year).toBe(2026);
    const misdated = extract.flagged_rows.filter((r) => r.out_of_year);
    expect(misdated.map((r) => r.source_row)).toEqual([75, 76, 77, 78, 79]);
    expect(misdated.every((r) => r.transaction_date === "2025-01-31")).toBe(true);
    expect(misdated.every((r) => r.dropped)).toBe(true);

    // The exact drift the sheet's own balance row reported: ECOPACK +100,
    // ZAMBOANGA +127 (128 − 1), KOREA_WHITE_SUNDRY +4 (18 − 14).
    const net = new Map<string, number>();
    for (const r of misdated) net.set(r.bag_type_code, (net.get(r.bag_type_code) ?? 0) + r.qty_delta);
    expect(net.get("ECOPACK_BEIGE")).toBe(100);
    expect(net.get("ZAMBOANGA_BAG")).toBe(127);
    expect(net.get("KOREA_WHITE_SUNDRY")).toBe(4);

    // NEVER auto-corrected: not one of them was emitted as a movement.
    expect(extract.rows.some((m) => m.transaction_date === "2025-01-31")).toBe(false);
    // …and the legacy counter still agrees with the structured list.
    expect(extract.summary.dropped_before_since).toBe(extract.flagged_rows.filter((r) => r.dropped).length);
  });

  it("turns them into ONE attention-level held row naming the rows and bag types", () => {
    const flagged: FleconFlaggedRow[] = [
      { transaction_date: "2025-01-31", source_row: 75, particular: "FIBC ECOPACK", bag_type_code: "ECOPACK_BEIGE", qty_delta: 100, dropped: true, out_of_year: true },
      { transaction_date: "2025-01-31", source_row: 76, particular: "ZAMBOANGA DELIVERED", bag_type_code: "ZAMBOANGA_BAG", qty_delta: 128, dropped: true, out_of_year: true },
      { transaction_date: "2025-01-31", source_row: 77, particular: "RS 1 ZAMBOANGA", bag_type_code: "ZAMBOANGA_BAG", qty_delta: -1, dropped: true, out_of_year: true },
    ];
    const held = buildFlaggedRowHolds(flagged, ["2026-01-30"]);
    expect(held).toHaveLength(1);
    expect(held[0].kind).toBe("malformed"); // an existing HeldKind — the enum is frontend-locked
    expect(held[0].reason).toBe("out_of_year_date");
    expect(held[0].detail).toContain("rows 75–77");
    expect(held[0].detail).toContain("2025-01-31");
    expect(held[0].detail).toContain("ECOPACK_BEIGE +100");
    expect(held[0].row?.source_rows).toEqual([75, 76, 77]);
    expect(held[0].row?.bag_type_codes).toEqual(["ECOPACK_BEIGE", "ZAMBOANGA_BAG"]);
  });

  it("raises an in-year sub-floor drop ONLY when the DB has never recorded that date", () => {
    const row = (date: string): FleconFlaggedRow => ({
      transaction_date: date,
      source_row: 12,
      particular: "USED BAG OF SUNDRY",
      bag_type_code: "KOREA_WHITE_SUNDRY",
      qty_delta: -4,
      dropped: true,
      out_of_year: false,
    });

    // Ordinary settled history (the DB already holds the day) → silent, every run.
    expect(buildFlaggedRowHolds([row("2026-03-04")], ["2026-03-04"])).toHaveLength(0);

    // A dropped date the DB has NEVER seen → held, loud.
    const held = buildFlaggedRowHolds([row("2026-03-04")], ["2026-03-05"]);
    expect(held).toHaveLength(1);
    expect(held[0].kind).toBe("below_since_floor");
    expect(held[0].reason).toBe("dropped_before_since_unrecorded");
    expect(held[0].detail).toContain("2026-03-04");
    expect(held[0].detail).toContain("row 12");

    // No dbDates supplied → the benign/never-recorded split cannot be made; stay quiet.
    expect(buildFlaggedRowHolds([row("2026-03-04")], undefined)).toHaveLength(0);
  });

  it("emits nothing when nothing was dropped or mis-dated", () => {
    expect(buildFlaggedRowHolds([], ["2026-03-04"])).toEqual([]);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// B. balance_crosscheck finally reaches the operator.
// ═════════════════════════════════════════════════════════════════════════════

describe("defect B — balance cross-check drift becomes a finding", () => {
  const drifted = classified({
    balance_crosscheck: {
      available: true,
      note: "INFORMATIONAL",
      rows: [
        { code: "ECOPACK_BEIGE", db_view_balance: 0, sheet_snapshot_balance: 100, drift: -100 },
        { code: "KOREA_WHITE_SUNDRY", db_view_balance: 302, sheet_snapshot_balance: 306, drift: -4 },
        { code: "ZAMBOANGA_BAG", db_view_balance: -127, sheet_snapshot_balance: 0, drift: -127 },
        { code: "KOREA_500", db_view_balance: 55, sheet_snapshot_balance: 55, drift: 0 },
        { code: "OLD_STOCKS", db_view_balance: null, sheet_snapshot_balance: 3, drift: null },
      ],
    },
  });

  it("names every drifting bag type and both numbers", () => {
    const held = buildBalanceDriftHold(drifted);
    expect(held).not.toBeNull();
    expect(held!.reason).toBe("balance_crosscheck_drift");
    expect(held!.row?.drifting_count).toBe(3);
    expect(held!.row?.bag_type_codes).toEqual([
      "ECOPACK_BEIGE",
      "KOREA_WHITE_SUNDRY",
      "ZAMBOANGA_BAG",
    ]);
    expect(held!.detail).toContain("app says -127");
    expect(held!.detail).toContain("the sheet says 0");
    // Zero-drift and un-comparable rows are not reported as drift.
    expect(held!.natural_key).not.toContain("KOREA_500");
    expect(held!.natural_key).not.toContain("OLD_STOCKS");
  });

  it("is silent when everything reconciles, or when no snapshot was found", () => {
    expect(
      buildBalanceDriftHold(
        classified({
          balance_crosscheck: {
            available: true,
            note: null,
            rows: [{ code: "KOREA_500", db_view_balance: 55, sheet_snapshot_balance: 55, drift: 0 }],
          },
        }),
      ),
    ).toBeNull();
    expect(buildBalanceDriftHold(classified())).toBeNull();
  });

  it("is a FINDING, never a write gate — the day still writes", async () => {
    const { deps, replaceFleconDate } = makeDeps();
    const res = await applyFlecon(
      deps,
      classified({
        ...drifted,
        per_date: [
          {
            transaction_date: "2026-07-20",
            class: "NEW",
            sheet_movement_count: 1,
            db_movement_count: 0,
            delta: { added: [], removed: [] },
            movements: [
              {
                transaction_date: "2026-07-20",
                particular: "RS 1 ZAMBOANGA",
                bag_type_code: "ZAMBOANGA_BAG",
                qty_delta: -2,
                source_row: 400,
              },
            ],
          },
        ],
      }),
      OPTS,
    );
    expect(res.ok).toBe(true);
    expect(res.replaced_dates).toBe(1);
    expect(replaceFleconDate).toHaveBeenCalledOnce();
    expect(res.held.some((h) => h.reason === "balance_crosscheck_drift")).toBe(true);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// C. A stale workbook can no longer wipe a day.
// ═════════════════════════════════════════════════════════════════════════════

describe("defect C — no silent day-wipe", () => {
  const wipeDay = classified({
    per_date: [
      {
        transaction_date: "2026-07-22",
        class: "DATE_CHANGED",
        sheet_movement_count: 0,
        db_movement_count: 4,
        delta: { added: [], removed: [] },
        movements: [], // the stale workbook simply lacks the section
      },
    ],
  });

  it("HOLDS a DATE_CHANGED that resolves to zero rows instead of deleting the day", async () => {
    const { deps, replaceFleconDate, writeIngestionAudit } = makeDeps();
    const res = await applyFlecon(deps, wipeDay, OPTS);

    expect(replaceFleconDate).not.toHaveBeenCalled(); // NOTHING was deleted
    expect(writeIngestionAudit).not.toHaveBeenCalled();
    expect(res.replaced_dates).toBe(0);
    expect(res.inserts).toBe(0);
    const h = res.held.find((x) => x.reason === "delete_to_empty_blocked");
    expect(h).toBeDefined();
    expect(h!.kind).toBe("gate_failure");
    expect(h!.row?.transaction_date).toBe("2026-07-22");
    expect(h!.row?.db_movement_count).toBe(4);
  });

  it("refuses the WHOLE apply when the workbook is older than the DB watermark", async () => {
    const { deps, replaceFleconDate, upsertIngestionWatermark, labelProcessed } = makeDeps();
    const res = await applyFlecon(deps, wipeDay, {
      ...OPTS,
      staleWorkbook: { workbookMaxDate: "2026-07-21", dbWatermark: "2026-07-22" },
    });

    expect(res.ok).toBe(false);
    expect(replaceFleconDate).not.toHaveBeenCalled();
    expect(upsertIngestionWatermark).not.toHaveBeenCalled();
    expect(res.watermark_updated).toBe(false);
    // 2026-08-26 UNJAM: the WRITE refusal is unchanged, but a strictly-older attachment
    // IS labeled processed so the same dead email stops re-firing every run. See
    // flecon-stale-unjam.test.ts for the full split (strictly-older vs no-dated-rows).
    expect(labelProcessed).toHaveBeenCalledWith("42");
    expect(res.labeled).toBe(true);
    const h = res.held.find((x) => x.reason === "stale_workbook");
    expect(h).toBeDefined();
    expect(h!.kind).toBe("gate_failure");
    expect(h!.row?.workbook_max_date).toBe("2026-07-21");
    expect(h!.row?.db_watermark).toBe("2026-07-22");
    expect(h!.row?.email_labeled_processed).toBe(true);
  });

  it("writes the audit row for EVERY replace, with a deleted-row id as the fallback marker", async () => {
    const { deps, writeIngestionAudit } = makeDeps();
    // A replace whose insert returns no representation still has a deleted-row marker.
    deps.db.replaceFleconDate = vi.fn(async () => ({
      deleted: 4,
      deletedFirstId: "deleted-id-9",
      inserted: 0,
      firstId: null,
    }));

    await applyFlecon(
      deps,
      classified({
        per_date: [
          {
            transaction_date: "2026-07-22",
            class: "DATE_CHANGED",
            sheet_movement_count: 1,
            db_movement_count: 4,
            delta: { added: [], removed: [] },
            movements: [
              {
                transaction_date: "2026-07-22",
                particular: "RS 1 ZAMBOANGA",
                bag_type_code: "ZAMBOANGA_BAG",
                qty_delta: -2,
                source_row: 401,
              },
            ],
          },
        ],
      }),
      OPTS,
    );

    expect(writeIngestionAudit).toHaveBeenCalledOnce();
    const arg = writeIngestionAudit.mock.calls[0][0] as Record<string, unknown>;
    expect(arg.recordId).toBe("deleted-id-9");
    expect(arg.operation).toBe("REPLACE");
    expect((arg.snapshot as Record<string, unknown>).deleted_count).toBe(4);
  });
});
