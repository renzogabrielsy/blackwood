/**
 * gsheet.test.ts — unit tests for the gsheet port (Wave 3, port #4).
 *
 * The parity harness (`npm run parity -- --type gsheet`) is the primary CLASSIFY
 * gate; these tests lock the behaviors that ARE the point of this port:
 *   - The materiality gate (classify_gsheet.is_material via classifyGsheet):
 *       · the 11.5-vs-11 lab pair is MATERIAL (PORTING_DECISIONS #1 — CODE, not the
 *         stale docstring) → lands in `changed`.
 *       · sacks null↔0 is IMMATERIAL → `noop` with immaterial_note.
 *       · a remarks change is MATERIAL → `changed`.
 *   - 2025-scope floor: a 2024 row is dropped into out_of_scope, never MALFORMED.
 *   - APPLY rulings: PORTING_DECISIONS #3 (honor `decision:"skip"` on CHANGED rows)
 *     and #2 (the >50-NEW / confidence<0.7 gates return a proper envelope, no crash).
 *
 * Ground truth: classify_gsheet.py, sync_gsheet.py::_apply_from_compact.
 */
import { describe, it, expect } from "vitest";

import {
  classifyGsheet,
  type DeliveryDbRow,
} from "../../src/reports/gsheet/classify.js";
import type { RowDict } from "../../src/reports/gsheet/deductions.js";
import {
  applyFromCompact,
  type ModeCompact,
  type CompactChanged,
  type CompactNewRcIn,
} from "../../src/reports/gsheet/apply.js";

const SINCE = "2025-01-01";

// A minimal well-formed extracted RC IN row (matches extract_gsheet shape).
function mkRcIn(over: Partial<RowDict>): RowDict {
  return {
    transaction_date: "2026-06-10",
    supplier: "ACME",
    batch_code_primary: "JUNE-26-BLK1",
    batch_code_fallbacks: ["JUN-26-BLK1"],
    block_loc: "A-1A",
    truck_plate: "ABC 111",
    sacks: 100,
    weight_kg: 10000,
    cost_basis: null,
    remarks: null,
    lab_results: null,
    true_weight_kg: null,
    deduction_note: null,
    warnings: [],
    confidence: 1,
    _source_row: 8,
    _source_tab: "RC IN",
    ...over,
  };
}

function mkDbDeliv(over: Partial<DeliveryDbRow>): DeliveryDbRow {
  return {
    id: "d1",
    transaction_date: "2026-06-10",
    supplier: "ACME",
    batch_code: "JUNE-26-BLK1",
    block_loc: "A-1A",
    truck_plate: "ABC 111",
    sacks: 100,
    weight_kg: 10000,
    cost_basis: 30,
    remarks: null,
    lab_results: null,
    ...over,
  };
}

/** Run only the rc_in side (rc_out empty) for terse assertions. */
function classifyRcInOnly(
  rows: RowDict[],
  deliveries: DeliveryDbRow[],
  since = SINCE,
) {
  return classifyGsheet(
    { rc_in: { rows }, rc_out: { rows: [] } },
    { deliveries, rc_out: [], batchLookup: {} },
    since,
  ).rc_in;
}

// ---------------------------------------------------------------------------
// Materiality gate — the LAB 11.5-vs-11 MATERIAL case (PORTING_DECISIONS #1).
// ---------------------------------------------------------------------------
describe("materiality gate — lab_results", () => {
  it("mc 11.5 (sheet) vs mc 11 (db) is MATERIAL → changed (CODE, not docstring)", () => {
    const res = classifyRcInOnly(
      [mkRcIn({ lab_results: { mc: 11.5 } })],
      [mkDbDeliv({ lab_results: { mc: 11 } })],
    );
    expect(res.changed).toHaveLength(1);
    expect(res.noop).toHaveLength(0);
    const d = (res.changed[0].diff as Array<{ field: string }>)[0];
    expect(d.field).toBe("lab_results");
  });

  it("mc null (sheet) vs mc 0 (db) is IMMATERIAL → noop (null↔0 pad)", () => {
    const res = classifyRcInOnly(
      [mkRcIn({ lab_results: { mc: null } })],
      [mkDbDeliv({ lab_results: { mc: 0 } })],
    );
    // sheet lab_results is {mc:null}; extractor emits null lab_results when all keys
    // are null — but here we force a present {mc:null}. deep_lab_equal compares at 2dp:
    // null vs 0 differ → a diff fires; is_material demotes it as immaterial (null↔0).
    expect(res.noop).toHaveLength(1);
    expect(res.changed).toHaveLength(0);
    expect(res.noop[0].immaterial_note).toBe("immaterial: lab(rounding)");
  });

  it("lab equal at 2dp → no diff at all → noop with no immaterial_note", () => {
    const res = classifyRcInOnly(
      [mkRcIn({ lab_results: { mc: 11.54 } })],
      [mkDbDeliv({ lab_results: { mc: 11.54 } })],
    );
    expect(res.noop).toHaveLength(1);
    expect(res.noop[0].immaterial_note).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Materiality gate — sacks null↔0 (immaterial) vs a real sacks change (material).
// ---------------------------------------------------------------------------
describe("materiality gate — sacks", () => {
  it("sacks null (sheet) vs 0 (db) is IMMATERIAL → noop", () => {
    const res = classifyRcInOnly(
      [mkRcIn({ sacks: null })],
      [mkDbDeliv({ sacks: 0 })],
    );
    expect(res.noop).toHaveLength(1);
    expect(res.noop[0].immaterial_note).toBe("immaterial: sacks(null↔0)");
  });

  it("sacks 100 (sheet) vs 90 (db) is MATERIAL → changed", () => {
    const res = classifyRcInOnly(
      [mkRcIn({ sacks: 100 })],
      [mkDbDeliv({ sacks: 90 })],
    );
    expect(res.changed).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Materiality gate — a remarks change is MATERIAL (sheet-wins).
// ---------------------------------------------------------------------------
describe("materiality gate — remarks (always material)", () => {
  it("null (db) → 'CORRECTED' (sheet) is MATERIAL → changed", () => {
    const res = classifyRcInOnly(
      [mkRcIn({ remarks: "CORRECTED" })],
      [mkDbDeliv({ remarks: null })],
    );
    expect(res.changed).toHaveLength(1);
    const d = (res.changed[0].diff as Array<{ field: string; sheetValue: unknown }>)[0];
    expect(d.field).toBe("remarks");
    expect(d.sheetValue).toBe("CORRECTED");
  });
});

// ---------------------------------------------------------------------------
// 2025-scope floor — a 2024 row is dropped into out_of_scope, not MALFORMED.
// ---------------------------------------------------------------------------
describe("2025-scope floor", () => {
  it("a 2024-12-31 row is out_of_scope, never MALFORMED / UNMAPPED / NEW", () => {
    const res = classifyRcInOnly(
      [mkRcIn({ transaction_date: "2024-12-31" })],
      [mkDbDeliv({})],
    );
    expect(res.summary.out_of_scope_count).toBe(1);
    expect(res.summary.in_scope_total).toBe(0);
    expect(res.malformed).toHaveLength(0);
    expect(res.unmapped).toHaveLength(0);
    expect(res.new).toHaveLength(0);
    expect(res.noop).toHaveLength(0);
  });

  it("a row exactly ON the floor (2025-01-01) is IN scope", () => {
    const res = classifyRcInOnly(
      [mkRcIn({ transaction_date: "2025-01-01", batch_code_primary: "GHOST-99-X", batch_code_fallbacks: [] })],
      [mkDbDeliv({})],
    );
    expect(res.summary.out_of_scope_count).toBe(0);
    // batch not in DB → UNMAPPED (in scope, just unresolved).
    expect(res.unmapped).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// UNMAPPED — batch_code (primary + fallbacks) not in DB → never auto-created.
// ---------------------------------------------------------------------------
describe("UNMAPPED reason string (Python repr parity)", () => {
  it("names the primary and the fallback list in Python-repr form", () => {
    const res = classifyRcInOnly(
      [mkRcIn({ batch_code_primary: "JUNE-26-BLK7", batch_code_fallbacks: ["JUN-26-BLK7"] })],
      [mkDbDeliv({})],
    );
    expect(res.unmapped).toHaveLength(1);
    expect(res.unmapped[0].reason).toBe(
      "batch_code primary='JUNE-26-BLK7' + fallbacks=['JUN-26-BLK7'] not in DB",
    );
  });
});

// ---------------------------------------------------------------------------
// APPLY — PORTING_DECISIONS #3 (L-018): honor `decision:"skip"` on CHANGED rows.
// ---------------------------------------------------------------------------
describe("apply — L-018 decision honoring on CHANGED rows (PD #3)", () => {
  // A DbClient stub that records update() calls and never hits a network.
  function stubDb() {
    const updates: Array<{ table: string; filters: unknown; patch: unknown }> = [];
    const inserts: Array<{ table: string; rows: unknown }> = [];
    const db = {
      async update(table: string, filters: unknown, patch: unknown) {
        updates.push({ table, filters, patch });
        return [{ id: "x" }];
      },
      async insert(table: string, rows: unknown[]) {
        inserts.push({ table, rows });
        return rows.map((_, i) => ({ id: `new-${i}` }));
      },
      async selectOne() {
        return { batch_code: "X" }; // batch already exists (skip creation)
      },
      async stampIngestionAudit() {
        return true;
      },
      async writeIngestionAudit() {
        return { id: "a" };
      },
      async upsertIngestionWatermark() {
        return true;
      },
    };
    return { db: db as never, updates, inserts };
  }

  const changed = (over: Partial<CompactChanged>): CompactChanged => ({
    kind: "VALUE_CHANGED",
    index: 8,
    db_id: "d1",
    date: "2026-06-10",
    batch_code: "JUNE-26-BLK1",
    diff: [{ field: "remarks", db: null, sheet: "CORRECTED" }],
    ...over,
  });

  const compact = (changedRows: CompactChanged[]): ModeCompact => ({
    mode: "rc_in",
    since: SINCE,
    actionable: { new: [], changed: changedRows, flagged: [], unmapped: [], malformed: [] },
  });

  it("a CHANGED row with decision:'skip' is SKIPPED (never updated)", async () => {
    const { db, updates } = stubDb();
    const res = await applyFromCompact(compact([changed({ decision: "skip" })]), { db });
    expect(res.updated).toBe(0);
    expect(updates).toHaveLength(0);
    expect(res.skipped.some((s) => s.index === 8)).toBe(true);
  });

  it("a CHANGED row with no skip/decision IS applied (baseline)", async () => {
    const { db, updates } = stubDb();
    const res = await applyFromCompact(compact([changed({})]), { db });
    expect(res.updated).toBe(1);
    expect(updates).toHaveLength(1);
    expect(updates[0].patch).toEqual({ remarks: "CORRECTED" });
  });

  it("a CHANGED row with top-level skip:true is SKIPPED (Python parity)", async () => {
    const { db, updates } = stubDb();
    const res = await applyFromCompact(compact([changed({ skip: true })]), { db });
    expect(res.updated).toBe(0);
    expect(updates).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// APPLY — PORTING_DECISIONS #2: gate-failure envelope (no bare-int crash).
// ---------------------------------------------------------------------------
describe("apply — safety gates return a proper envelope (PD #2)", () => {
  const stub = {
    async insert(_t: string, rows: unknown[]) {
      return (rows as unknown[]).map((_, i) => ({ id: `n${i}` }));
    },
    async selectOne() {
      return { batch_code: "X" };
    },
    async stampIngestionAudit() {
      return true;
    },
    async writeIngestionAudit() {
      return { id: "a" };
    },
  } as never;

  function newRcIn(i: number, conf = 1): CompactNewRcIn {
    return {
      kind: "NEW",
      index: i,
      date: "2026-06-10",
      batch_code: `NEW-26-BLK${i}`,
      block_loc: null,
      weight_kg: 1000,
      supplier: "ACME",
      truck_plate: null,
      sacks: null,
      remarks: null,
      lab_results: null,
      confidence: conf,
      true_weight_kg: null,
      deduction_note: null,
    };
  }

  it(">50 NEW rows trips the gate: ok:false, gate named, nothing inserted", async () => {
    const rows = Array.from({ length: 51 }, (_, i) => newRcIn(i));
    const res = await applyFromCompact(
      { mode: "rc_in", since: SINCE, actionable: { new: rows, changed: [], flagged: [], unmapped: [], malformed: [] } },
      { db: stub },
    );
    expect(res.ok).toBe(false);
    expect(res.gate_failure?.gate).toBe("too_many_new");
    expect(res.inserted).toBe(0);
  });

  it("a NEW row below confidence 0.7 trips the gate: ok:false, indexes listed", async () => {
    const rows = [newRcIn(1, 1), newRcIn(2, 0.5)];
    const res = await applyFromCompact(
      { mode: "rc_in", since: SINCE, actionable: { new: rows, changed: [], flagged: [], unmapped: [], malformed: [] } },
      { db: stub },
    );
    expect(res.ok).toBe(false);
    expect(res.gate_failure?.gate).toBe("low_confidence");
    expect(res.gate_failure?.indexes).toContain(2);
    expect(res.inserted).toBe(0);
  });

  it("exactly 50 NEW rows does NOT trip the >50 gate", async () => {
    const rows = Array.from({ length: 50 }, (_, i) => newRcIn(i));
    const res = await applyFromCompact(
      { mode: "rc_in", since: SINCE, actionable: { new: rows, changed: [], flagged: [], unmapped: [], malformed: [] } },
      { db: stub },
    );
    expect(res.ok).toBe(true);
    expect(res.inserted).toBe(50);
  });
});
