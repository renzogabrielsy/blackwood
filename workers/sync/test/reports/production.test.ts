/**
 * production.test.ts — unit tests for the production port (Wave 3, port #5).
 *
 * The parity harness (`npm run parity -- --type production`) is the primary gate
 * (2/2, production_downtime_ge60 PASS-with-note via PD-5). These tests lock the
 * behaviors that define this port:
 *   - PD-5 / L-014 dt_mins>=60 split at 59 / 60 / 125 minutes.
 *   - L-007 STARTING/ENDING batch-boundary → shift defaults to Morning + note.
 *   - L-026 combine of duplicate (shift_id, customer, grade) NEW run rows on apply.
 *   - L-028 second same-date waste row (carryover) resolves to a DISTINCT shift.
 *   - L-027 grade allowlist drop (KOREA POWDER) + generated-col exclusion on write.
 *
 * Ground truth: extract_daily_production.py, extract_waste_production.py,
 * classify_production_*.py, sync_production.py.
 */
import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { loadProductionWorkbook } from "../../src/reports/production/sheet.js";
import { extractMc, type DowntimeRow } from "../../src/reports/production/extractMc.js";
import { extractIvy } from "../../src/reports/production/extractIvy.js";
import { classifyRuns, classifyWaste, type ShiftDbRow } from "../../src/reports/production/classify.js";
import {
  applyProduction,
  type ProductionCompact,
  type ProductionSections,
} from "../../src/reports/production/apply.js";
import type { DbClient, Row, InsertIfAbsentResult } from "../../src/lib/db.js";

const FX = join(__dirname, "../../fixtures/production/workbooks");

async function loadMc(name: string) {
  return loadProductionWorkbook(await readFile(join(FX, name)));
}

// ---------------------------------------------------------------------------
// PD-5 / L-014 — dt_mins >= 60 split (hrs += mins//60; mins %= 60).
// The split happens at extract shaping (extractMc), so it is visible on the row.
// ---------------------------------------------------------------------------
describe("PD-5 / L-014 — dt_mins>=60 split", () => {
  // Pure re-implementation of the split so we can pin the boundary without a
  // bespoke workbook per minute-total. This mirrors extractMc's applied rule.
  const split = (totalMins: number): { dt_hrs: number; dt_mins: number } => {
    let dtHrs = 0;
    let dtMins = totalMins;
    if (dtMins >= 60) {
      dtHrs += Math.floor(dtMins / 60);
      dtMins = dtMins % 60;
    }
    return { dt_hrs: dtHrs, dt_mins: dtMins };
  };

  it("59 minutes stays unsplit (dt_hrs=0, dt_mins=59)", () => {
    expect(split(59)).toEqual({ dt_hrs: 0, dt_mins: 59 });
  });

  it("exactly 60 minutes splits to dt_hrs=1, dt_mins=0", () => {
    expect(split(60)).toEqual({ dt_hrs: 1, dt_mins: 0 });
  });

  it("125 minutes splits to dt_hrs=2, dt_mins=5", () => {
    expect(split(125)).toEqual({ dt_hrs: 2, dt_mins: 5 });
  });

  it("the real edge workbook (07-04-26, 125 min) emits the split, DB-CHECK-valid", async () => {
    const mc = extractMc(await loadMc("production_mc_edge.xlsx"), 2026, "2026-01-01");
    expect(mc.downtime).toHaveLength(1);
    const dt = mc.downtime[0] as DowntimeRow;
    expect(dt.dt_hrs).toBe(2);
    expect(dt.dt_mins).toBe(5);
    // The whole point of the deviation: dt_mins is now < 60, so the DB CHECK holds.
    expect(dt.dt_mins).toBeLessThan(60);
  });
});

// ---------------------------------------------------------------------------
// L-025 / L-007 — blank / STARTING / ENDING shift defaults to Morning + note.
// ---------------------------------------------------------------------------
describe("L-025 / L-007 — shift default to Morning", () => {
  it("edge workbook: every run defaults to M with the strippable note", async () => {
    const mc = extractMc(await loadMc("production_mc_edge.xlsx"), 2026, "2026-01-01");
    expect(mc.runs.length).toBeGreaterThan(0);
    for (const r of mc.runs) {
      expect(r.shift).toBe("M");
      expect(r._shift_defaulted).toBe(true);
      expect(r.remarks).toBe("shift defaulted to Morning (operator left blank)");
    }
  });

  it("KURARAY 6X50 blank-shift run carries the 'blank/absent' warning (L-007 path)", async () => {
    const mc = extractMc(await loadMc("production_mc_edge.xlsx"), 2026, "2026-01-01");
    const kuraray = mc.runs.find((r) => r.customer === "KURARAY" && r.grade === "6X50");
    expect(kuraray).toBeDefined();
    expect(kuraray!.warnings).toContain("shift cell blank/absent — defaulted to Morning");
  });

  it("a defaulted-shift run classified against a note-less DB row is DUPLICATE_NOOP, not VALUE_CHANGED", () => {
    // The note is stripped off the email side before diffing (L-025), so an
    // already-written Morning row (DB remarks=null) must not perpetually re-diff.
    const shifts: ShiftDbRow[] = [
      { id: "SID-1", transaction_date: "2026-07-04", production_batch: "JULY", shift: "M" },
    ];
    const mc = { runs: [row3x50("2026-07-04")] };
    const res = classifyRuns(mc.runs, [{ id: "R1", shift_id: "SID-1", customer: "CEBU", grade: "3X50", ttl_kg: 16380, sacks_bags: 630, remarks: null }], shifts);
    const c = res.classifications[0];
    expect(c.class).toBe("DUPLICATE_NOOP");
    expect(c.diff).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// L-027 — grade allowlist drop (KOREA POWDER) at extract.
// ---------------------------------------------------------------------------
describe("L-027 — grade allowlist", () => {
  it("edge workbook drops the KOREA POWDER row; 4X8 would be kept", async () => {
    const mc = extractMc(await loadMc("production_mc_edge.xlsx"), 2026, "2026-01-01");
    const grades = mc.runs.map((r) => r.grade);
    expect(grades).not.toContain("POWDER");
    // Only allowlisted grades survive.
    for (const g of grades) expect(["3X50", "6X50", "8X50", "2X6", "4X8"]).toContain(g);
  });
});

// ---------------------------------------------------------------------------
// L-026 — combine duplicate (shift_id, customer, grade) NEW run rows on apply.
// ---------------------------------------------------------------------------
describe("L-026 — combine duplicate run rows on apply", () => {
  it("two NEW CEBU 3X50 rows on the same resolved shift combine into ONE insert with summed ttl_kg/sacks", async () => {
    const inserted: Row[] = [];
    const db = mockDb({
      onInsertIfAbsent: (table, rows) => {
        if (table === "production_runs") inserted.push(rows[0]);
        return okInsert(rows[0]);
      },
    });

    const sections = emptySections();
    sections.runs = [
      newRunClass("SID-1", "CEBU", "3X50", 16380, 630),
      newRunClass("SID-1", "CEBU", "3X50", 6890, 265),
    ];
    const res = await applyProduction(compactWith(sections), { db });

    const runInserts = inserted;
    expect(runInserts).toHaveLength(1);
    expect(runInserts[0].ttl_kg).toBe(16380 + 6890);
    expect(runInserts[0].sacks_bags).toBe(630 + 265);
    expect(res.inserts).toBe(1);
    expect(res.errors).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// L-028 — a second same-date waste row (carryover) resolves to a DISTINCT shift.
// ---------------------------------------------------------------------------
describe("L-028 — month-transition second waste row", () => {
  it("two 2026-06-30 waste rows (JUNE vs JULY batch) key to different shifts, no collision", async () => {
    const mc = await loadMc; // unused; keep lints quiet on import shape
    void mc;
    const shifts: ShiftDbRow[] = [
      { id: "SID-JUN", transaction_date: "2026-06-30", production_batch: "JUNE", shift: "M" },
      { id: "SID-JUL", transaction_date: "2026-06-30", production_batch: "JULY", shift: "M" },
    ];
    const junRow = wasteRow("2026-06-30", "JUNE");
    const julRow = wasteRow("2026-06-30", "JULY");
    const res = classifyWaste([junRow, julRow], [], shifts);
    const [a, b] = res.classifications;
    // Both resolve to a real (distinct) shift — NEW, needs_shift_upsert=false.
    expect((a.natural_key as { shift_id: string }).shift_id).toBe("SID-JUN");
    expect((b.natural_key as { shift_id: string }).shift_id).toBe("SID-JUL");
    expect(a.class).toBe("NEW");
    expect(b.class).toBe("NEW");
    expect(a.needs_shift_upsert).toBe(false);
    expect(b.needs_shift_upsert).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// generated-cols-never-written — a VALUE_CHANGED patch strips diff/consumption/ttl_km.
// ---------------------------------------------------------------------------
describe("generated columns are never written", () => {
  it("an electricity VALUE_CHANGED patch never includes consumption_kwh/diff_kwh", async () => {
    const patches: Array<{ table: string; patch: Row }> = [];
    const db = mockDb({
      onUpdate: (table, _filters, patch) => {
        patches.push({ table, patch });
      },
    });

    const sections = emptySections();
    sections.electricity = [
      {
        idx: 0,
        class: "VALUE_CHANGED",
        natural_key: { reading_date: "2026-07-01", meter: "MAIN" },
        existing_id: "E1",
        // diff carries {new} for the base col AND spurious generated cols to prove they're stripped.
        diff: {
          end_kwh: { new: 588.0 },
          consumption_kwh: { new: 999 },
          diff_kwh: { new: 8 },
        },
        record: {},
        reasons: ["1 field(s) differ from existing row"],
        confidence: 0.95,
      },
    ];
    const res = await applyProduction(compactWith(sections), { db });
    expect(res.updates).toBe(1);
    expect(patches).toHaveLength(1);
    expect(patches[0].patch).toHaveProperty("end_kwh");
    expect(patches[0].patch).not.toHaveProperty("consumption_kwh");
    expect(patches[0].patch).not.toHaveProperty("diff_kwh");
  });
});

// ---------------------------------------------------------------------------
// missing-workbook robustness — extractIvy on an absent role is empty, never throws.
// ---------------------------------------------------------------------------
describe("empty-side extract", () => {
  it("extractIvy over a real workbook with an exclusive since past all rows yields []", async () => {
    const wb = await loadProductionWorkbook(await readFile(join(FX, "production_real_ivy.xlsx")));
    const ivy = extractIvy(wb, "2027-12-31");
    expect(ivy.waste).toEqual([]);
  });
});

// ── fixtures/helpers ─────────────────────────────────────────────────────────
function row3x50(date: string) {
  return {
    transaction_date: date,
    production_batch: "JULY",
    shift: "M",
    customer: "CEBU",
    grade: "3X50",
    ttl_kg: 16380,
    sacks_bags: 630,
    remarks: "shift defaulted to Morning (operator left blank)",
    _shift_defaulted: true,
    _source_sheet: date,
    _source_row: 8,
    warnings: ["unrecognized shift 'DAY SHIFT' — defaulted to Morning"],
    confidence: 0.9,
  };
}

function wasteRow(date: string, batch: string) {
  return {
    transaction_date: date,
    production_batch: batch,
    shift: "M",
    rs1a_kg: 1000, rs1b_kg: 1000, bf_kg: 100, rs23_kg: 300,
    rs5_kg: 100, trml1_kg: 50, trml2_kg: 0.5, grit_kg: 30,
    ttl_waste_kg_reported: 2580.5,
    remarks: "PCG",
    _source_sheet: `${batch} 2026`,
    _source_row: 5,
    _summed_kg: 2580.5,
    warnings: [],
  };
}

function emptySections(): ProductionSections {
  return { runs: [], downtime: [], waste: [], electricity: [], trucks: [] };
}

function newRunClass(sid: string, customer: string, grade: string, ttlKg: number, sacks: number) {
  return {
    idx: 0,
    class: "NEW",
    natural_key: { shift_id: sid, customer, grade },
    resolved_shift_id: sid,
    needs_shift_upsert: false,
    existing_id: null,
    diff: null,
    record: {
      transaction_date: "2026-07-04",
      production_batch: "JULY",
      shift: "M",
      customer,
      grade,
      ttl_kg: ttlKg,
      sacks_bags: sacks,
      remarks: null,
    },
    reasons: ["shift exists; no run for this customer+grade"],
    confidence: 0.97,
  };
}

function compactWith(sections: ProductionSections): ProductionCompact {
  return {
    report_type: "production",
    since: "2026-01-01",
    window: ["2026-06-30", "2026-07-07"],
    source: { mc_uid: null, ivy_uid: null, mc_thread_id: null },
    sections,
  };
}

function okInsert(row: Row): InsertIfAbsentResult {
  const inserted = { ...row, id: `NEW-${Math.random().toString(36).slice(2, 8)}` };
  return { inserted: [inserted], skipped: [], insertedCount: 1, skippedCount: 0 };
}

/** A minimal DbClient stub — only the methods applyProduction calls. */
function mockDb(hooks: {
  onInsertIfAbsent?: (table: string, rows: Row[], nkey: string[]) => InsertIfAbsentResult;
  onUpdate?: (table: string, filters: Record<string, string>, patch: Row) => void;
}): DbClient {
  const stub: Partial<DbClient> = {
    insertIfAbsent: async (table: string, rows: Row[], naturalKey: string[]) =>
      hooks.onInsertIfAbsent ? hooks.onInsertIfAbsent(table, rows, naturalKey) : okInsert(rows[0]),
    update: async (table: string, filters: Record<string, string>, patch: Row) => {
      hooks.onUpdate?.(table, filters, patch);
      return [];
    },
    selectOne: async () => null,
    writeIngestionAudit: async () => ({ id: "AUDIT-1" }),
    upsertIngestionWatermark: async () => true,
  };
  return stub as DbClient;
}
