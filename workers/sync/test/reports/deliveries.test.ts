/**
 * deliveries.test.ts — unit tests for the deliveries port (Wave 3, port #3, the
 * L-033 flagship).
 *
 * The parity harness (`npm run parity -- --type deliveries`) is the primary gate
 * (2/2 against the Python oracle). These focused tests lock the guard-layer branches
 * and deduction math that are the point of this port — the pieces most likely to
 * silently drift from the Python:
 *   - L-033a same-loc dup → dup_noop; diff-loc → FLAGGED L033_cross_batch_loc_mismatch.
 *   - L-033b PILED-IN remark remap: month-variant hit, YEAR ROLLOVER (Dec pile / Jan
 *     truck), and NO remap when the target batch doesn't exist (never invents a batch).
 *   - L-004 block_loc correction (same date/batch/weight, different loc → FLAGGED).
 *   - low-confidence gate (< 0.7 strict).
 *   - deduction grammar math (true_weight_kg parse, note fragments).
 *
 * Ground truth: classify_deliveries.py, parity_guards.py, lib/deductions.py.
 */
import { describe, it, expect } from "vitest";

import {
  classifyDeliveries,
  applyDeliveriesGuard,
  type DeliveriesDbRow,
  type ClassifyResult,
} from "../../src/reports/deliveries/classify.js";
import type { DeliveryRow, ExtractResult } from "../../src/reports/deliveries/extract.js";
import { detectDeduction, buildRecoveryRow } from "../../src/reports/deliveries/deductions.js";
import { translateBatchCode } from "../../src/reports/deliveries/extract.js";

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------
function mkRow(over: Partial<DeliveryRow>): DeliveryRow {
  return {
    transaction_date: "2026-07-04",
    supplier: "Ornales",
    batch_code: "JULY-26-BLK9",
    operator_batch_label: "B09",
    block_loc: "A-19C",
    truck_plate: "CBN 2192",
    sacks: 270,
    weight_kg: 10870,
    cost_basis: null,
    remarks: null,
    lab_results: null,
    true_weight_kg: null,
    deduction_note: null,
    warnings: [],
    confidence: 0.9,
    _source_row: 7,
    ...over,
  };
}

function mkExtract(rows: DeliveryRow[]): ExtractResult {
  return {
    filename: "t.xlsx",
    sheets_processed: ["JULY 26"],
    rows,
    summary: { total_rows: rows.length, extraction_warnings: [], overall_confidence: 0.9, unmapped_batches: [] },
  };
}

/** classify + guard, the full CLASSIFY oracle unit. */
function guard(rows: DeliveryRow[], db: DeliveriesDbRow[], batchCodes: string[]) {
  const classified: ClassifyResult = classifyDeliveries(mkExtract(rows), db);
  return applyDeliveriesGuard(classified, db, new Set(batchCodes));
}

// A DB row at A-19C already recorded under JUNE-26-BLK9 for the same truckload.
function dbA19C(over: Partial<DeliveriesDbRow> = {}): DeliveriesDbRow {
  return {
    id: "db-a19c",
    transaction_date: "2026-07-04",
    supplier: "Ornales",
    batch_code: "JUNE-26-BLK9",
    block_loc: "A-19C",
    truck_plate: "MAV 9202",
    sacks: 580,
    weight_kg: 20640,
    cost_basis: 38,
    remarks: null,
    lab_results: null,
    ...over,
  };
}

// ---------------------------------------------------------------------------
// L-033a — cross-batch duplicate, SAME location → dup_noop
// ---------------------------------------------------------------------------
describe("L-033a cross-batch dup", () => {
  it("same date/truck/weight AT THE SAME LOC under a different batch → dup_noop (not new, not flagged)", () => {
    // Candidate = a phantom JULY code for the exact truckload the DB holds as JUNE.
    const cand = mkRow({
      truck_plate: "MAV 9202",
      weight_kg: 20640,
      batch_code: "JULY-26-BLK9",
      block_loc: "A-19C",
      remarks: null,
      _source_row: 6,
    });
    const out = guard([cand], [dbA19C()], ["JUNE-26-BLK9", "JULY-26-BLK9"]);
    expect(out.new).toHaveLength(0);
    expect(out.flagged).toHaveLength(0);
    expect(out.dup_noops).toHaveLength(1);
    expect(out.dup_noops[0].note).toContain("already recorded as JUNE-26-BLK9");
    // natural_key uses RAW truck + Python-float weight formatting.
    expect(out.dup_noops[0].natural_key).toBe("2026-07-04|MAV 9202|20640.0");
    // summary keeps the RAW pre-guard counts (new_count reflects the classifier).
    expect(out.summary.new_count).toBe(1);
  });

  it("same date/truck/weight but a DIFFERENT loc → FLAGGED L033_cross_batch_loc_mismatch (skip)", () => {
    // DB holds the truckload at A-19C; the report says D-19C — a location mismatch.
    const cand = mkRow({
      truck_plate: "MAV 9202",
      weight_kg: 20640,
      batch_code: "JULY-26-BLK9",
      block_loc: "D-19C",
      _source_row: 6,
    });
    const out = guard([cand], [dbA19C()], ["JUNE-26-BLK9", "JULY-26-BLK9"]);
    expect(out.dup_noops).toHaveLength(0);
    expect(out.new).toHaveLength(0);
    expect(out.flagged).toHaveLength(1);
    expect(out.flagged[0].kind).toBe("L033_cross_batch_loc_mismatch");
    expect(out.flagged[0].decision).toBe("skip");
  });

  it("does NOT fire via the dtw index when the truck plate is blank", () => {
    const cand = mkRow({ truck_plate: null, weight_kg: 20640, batch_code: "JULY-26-BLK9", block_loc: "A-19C" });
    const out = guard([cand], [dbA19C({ truck_plate: null })], ["JUNE-26-BLK9", "JULY-26-BLK9"]);
    // No dup match (blank truck excluded from the index) → genuine insert.
    expect(out.dup_noops).toHaveLength(0);
    expect(out.flagged).toHaveLength(0);
    expect(out.new).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// L-033b — PILED-IN remark re-map (only to EXISTING batches)
// ---------------------------------------------------------------------------
describe("L-033b PILED-IN remark remap", () => {
  it("re-maps the phantom code to an EXISTING month-variant batch and inserts", () => {
    // July-dated truck, remark points to June; JUNE-26-BLK9 exists → remap.
    const cand = mkRow({
      truck_plate: "CBN 2192",
      weight_kg: 10870,
      batch_code: "JULY-26-BLK9",
      block_loc: "A-19C",
      remarks: "PILED IN JUNE BLOCK 9",
      _source_row: 7,
    });
    // DB window has NO CBN 2192 truckload → no dup; only the JUNE batch exists.
    const out = guard([cand], [dbA19C()], ["JUNE-26-BLK9", "JULY-26-BLK9"]);
    expect(out.new).toHaveLength(1);
    expect(out.new[0].row.batch_code).toBe("JUNE-26-BLK9");
    expect(out.new[0].notes?.[0]).toContain("batch re-mapped JULY-26-BLK9 → JUNE-26-BLK9");
  });

  it("YEAR ROLLOVER: a December pile on a January-dated truck maps to the PRIOR year", () => {
    // txn 2026-01, remark 'PILED IN DECEMBER' → month 12 > month 1 → year 2025.
    const cand = mkRow({
      transaction_date: "2026-01-05",
      truck_plate: "XYZ 1",
      weight_kg: 5000,
      batch_code: "JAN-26-BLK3",
      block_loc: "B-3A",
      remarks: "PILED IN DECEMBER BLOCK 3",
      _source_row: 4,
    });
    const out = guard([cand], [], ["DEC-25-BLK3"]);
    expect(out.new).toHaveLength(1);
    expect(out.new[0].row.batch_code).toBe("DEC-25-BLK3");
  });

  it("does NOT remap (and never invents a batch) when NO month-variant exists in the DB", () => {
    const cand = mkRow({
      truck_plate: "CBN 2192",
      weight_kg: 10870,
      batch_code: "JULY-26-BLK9",
      block_loc: "A-19C",
      remarks: "PILED IN JUNE BLOCK 9",
      _source_row: 7,
    });
    // Only JULY exists; JUNE-26-BLK9 / JUNE-26 variants absent → hint ignored, code kept.
    const out = guard([cand], [dbA19C()], ["JULY-26-BLK9"]);
    expect(out.new).toHaveLength(1);
    expect(out.new[0].row.batch_code).toBe("JULY-26-BLK9");
    expect(out.new[0].notes).toBeUndefined();
  });

  it("tries the MARCH long-name variant before MAR", () => {
    const cand = mkRow({
      transaction_date: "2026-04-02",
      truck_plate: "AAA 1",
      weight_kg: 3000,
      batch_code: "APRIL-26-BLK5",
      block_loc: "C-5A",
      remarks: "PILED IN MARCH BLOCK 5",
      _source_row: 4,
    });
    const out = guard([cand], [], ["MARCH-26-BLK5", "MAR-26-BLK5"]);
    expect(out.new[0].row.batch_code).toBe("MARCH-26-BLK5");
  });
});

// ---------------------------------------------------------------------------
// L-004 — block_loc correction
// ---------------------------------------------------------------------------
describe("L-004 block_loc correction", () => {
  it("same date/batch/weight at a DIFFERENT block_loc → FLAGGED L004_block_loc_correction (skip)", () => {
    const cand = mkRow({
      truck_plate: "LFF 835",
      weight_kg: 12725,
      batch_code: "JULY-26-BLK2",
      block_loc: "D-19B",
      _source_row: 8,
    });
    // DB already holds this date/batch/weight at D-13D (a different loc). Use a
    // DIFFERENT truck plate so the L-033a dtw check misses and L-004 is the one to fire.
    const db: DeliveriesDbRow[] = [
      { id: "db-1", transaction_date: "2026-07-04", batch_code: "JULY-26-BLK2", weight_kg: 12725, block_loc: "D-13D", truck_plate: "OTHER 99" },
    ];
    const out = guard([cand], db, ["JULY-26-BLK2"]);
    expect(out.new).toHaveLength(0);
    expect(out.flagged).toHaveLength(1);
    expect(out.flagged[0].kind).toBe("L004_block_loc_correction");
    expect(out.flagged[0].decision).toBe("skip");
  });
});

// ---------------------------------------------------------------------------
// low-confidence gate — strict < 0.7
// ---------------------------------------------------------------------------
describe("low-confidence gate", () => {
  it("confidence exactly 0.7 is NOT flagged (strict <)", () => {
    const cand = mkRow({ confidence: 0.7, truck_plate: "NEW 1", weight_kg: 111, batch_code: "JULY-26-BLK1", block_loc: "D-1A" });
    const out = guard([cand], [], ["JULY-26-BLK1"]);
    expect(out.flagged).toHaveLength(0);
    expect(out.new).toHaveLength(1);
  });
  it("confidence 0.6999 IS flagged low_confidence (skip)", () => {
    const cand = mkRow({ confidence: 0.6999, truck_plate: "NEW 2", weight_kg: 222, batch_code: "JULY-26-BLK1", block_loc: "D-1A" });
    const out = guard([cand], [], ["JULY-26-BLK1"]);
    expect(out.flagged).toHaveLength(1);
    expect(out.flagged[0].kind).toBe("low_confidence");
  });
});

// ---------------------------------------------------------------------------
// MALFORMED + additive-field non-diffing
// ---------------------------------------------------------------------------
describe("classifier buckets", () => {
  it("a row with a null batch_code → MALFORMED, not new", () => {
    const cand = mkRow({ batch_code: null, operator_batch_label: "MYSTERY", truck_plate: "M 1", weight_kg: 1, block_loc: null });
    const out = guard([cand], [], []);
    expect(out.malformed).toHaveLength(1);
    expect(out.new).toHaveLength(0);
  });

  it("true_weight_kg / deduction_note differences do NOT trigger VALUE_CHANGED (additive, L-021)", () => {
    // Same natural key; extract carries deduction fields, DB has none. Must be NOOP.
    const cand = mkRow({
      truck_plate: "MAV 9202",
      weight_kg: 20640,
      batch_code: "JUNE-26-BLK9",
      block_loc: "A-19C",
      supplier: "Ornales",
      sacks: 580,
      cost_basis: null,
      true_weight_kg: 21000,
      deduction_note: "−360 kg wet",
    });
    const out = guard([cand], [dbA19C()], ["JUNE-26-BLK9"]);
    expect(out.changed).toHaveLength(0);
    expect(out.noop).toHaveLength(1);
  });

  it("cost_basis is SKIPPED from the diff when the extracted side is null (operator file has no price)", () => {
    // DB cost_basis=38, extract cost_basis=null → NOOP (not a perpetual VALUE_CHANGED).
    const cand = mkRow({
      truck_plate: "MAV 9202",
      weight_kg: 20640,
      batch_code: "JUNE-26-BLK9",
      block_loc: "A-19C",
      supplier: "Ornales",
      sacks: 580,
      cost_basis: null,
    });
    const out = guard([cand], [dbA19C({ cost_basis: 38 })], ["JUNE-26-BLK9"]);
    expect(out.changed).toHaveLength(0);
    expect(out.noop).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// deduction math (lib/deductions.py port)
// ---------------------------------------------------------------------------
describe("detectDeduction", () => {
  it("parses gross directly and builds a two-fragment note", () => {
    const r = detectDeduction("CBN2192 net kilos of 10,945 - 1.60%(MC) & 2.88%(ASH) = 10,455", 10455);
    expect(r.trueWeightKg).toBe(10945);
    expect(r.deductionNote).toBe("−1.60% MC; −2.88% ASH");
    expect(r.warnings).toHaveLength(0);
  });

  it("does NOT tag when there is no 'net kilos' signal", () => {
    const r = detectDeduction("ordinary load, nothing to see", 12000);
    expect(r.trueWeightKg).toBeNull();
    expect(r.deductionNote).toBeNull();
  });

  it("refuses to tag (gross ≤ net) but still returns a note", () => {
    const r = detectDeduction("net kilos of 9,000 - 5%(MC) = 10,000", 10000);
    expect(r.trueWeightKg).toBeNull();
    expect(r.deductionNote).toContain("−5% MC");
    expect(r.warnings.some((w) => w.includes("gross must exceed net"))).toBe(true);
  });

  it("handles a misspelled ASAH → ASH and an absolute-kilos fragment", () => {
    const r = detectDeduction("ALA 9425 net kilos of 33,950 - 1.88%(ASAH) = 33,312", 33312);
    expect(r.trueWeightKg).toBe(33950);
    expect(r.deductionNote).toBe("−1.88% ASH");
  });
});

describe("buildRecoveryRow", () => {
  it("inherits the mother's identity, keeps the candidate's own weight/sacks", () => {
    const mother = mkRow({
      truck_plate: "MAN 3625",
      batch_code: "JULY-26-BLK1",
      block_loc: "D-19B",
      supplier: "Tagat",
      weight_kg: 22000,
      _source_row: 8,
    });
    const candidate = mkRow({
      truck_plate: null,
      batch_code: null,
      block_loc: null,
      supplier: null,
      operator_batch_label: null,
      weight_kg: 300,
      sacks: 8,
      remarks: null,
      _source_row: 9,
    });
    const rec = buildRecoveryRow(
      candidate as unknown as Record<string, unknown>,
      mother as unknown as Record<string, unknown>,
    );
    expect(rec.batch_code).toBe("JULY-26-BLK1");
    expect(rec.truck_plate).toBe("MAN 3625");
    expect(rec.block_loc).toBe("D-19B");
    expect(rec.weight_kg).toBe(300);
    expect(rec.sacks).toBe(8);
    expect(rec._recovery).toBe(true);
    expect(rec._mother_source_row).toBe(8);
  });
});

// ---------------------------------------------------------------------------
// translate_batch_code — source-order (FEEDING AREA → PILED IN → B<N> → raw)
// ---------------------------------------------------------------------------
describe("translateBatchCode", () => {
  it("B<N> → <FULLMONTH>-<YY>-BLK<N> from the delivery month, with the heuristic warning", () => {
    const [code, warns] = translateBatchCode("B09", null, "2026-07-04");
    expect(code).toBe("JULY-26-BLK9");
    expect(warns[0]).toContain("translated heuristically");
  });

  it("PILED IN <MONTH> # <N> remark wins over the B-number path", () => {
    const [code, warns] = translateBatchCode("B09", "PILED IN JUNE # 5", "2026-07-04");
    expect(code).toBe("JUNE-26-BLK5");
    expect(warns).toHaveLength(0);
  });

  it("FEEDING AREA N → <FULLMONTH>-<YY>-FEED<N>", () => {
    const [code] = translateBatchCode("FEEDING AREA 2", null, "2026-07-04");
    expect(code).toBe("JULY-26-FEED2");
  });

  it("unmappable label falls through to the raw value with a warning", () => {
    const [code, warns] = translateBatchCode("MYSTERY", null, "2026-07-04");
    expect(code).toBe("MYSTERY");
    expect(warns[0]).toContain("Could not map");
  });
});
