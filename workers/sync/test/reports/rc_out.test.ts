/**
 * rc_out.test.ts — unit tests for the rc_out port (Wave 3, port #2).
 *
 * The parity harness (`npm run parity -- --type rc_out`) is the primary gate;
 * these tests lock the SAFETY-GATE behavior that is the point of this port:
 *   - BOTH hard reconcile gates: trip / no-trip at exactly 500kg (serious) and
 *     50kg (tolerance) boundaries, for P-vs-M (GATE 1) and O-vs-M (GATE 2).
 *   - The L-019 sub-watermark guard: a settled-date NEW → FLAGGED, never inserted.
 *   - batch_code primary→fallback resolution order.
 *
 * Ground truth: reconcile_rc_movement.py, classify_rc_out.py.
 */
import { describe, it, expect } from "vitest";

import { reconcile } from "../../src/reports/rc_out/reconcile.js";
import { classifyRcOut } from "../../src/reports/rc_out/classify.js";
import type { ProposedRow } from "../../src/reports/rc_out/extract.js";

// A minimal well-formed extracted PROPOSED row.
function mkRow(over: Partial<ProposedRow>): ProposedRow {
  return {
    transaction_date: "2026-07-04",
    whse_label: "C-6A",
    block_loc: "C-6A",
    block_date: "2026-07-01",
    block_no: 9,
    is_feed: false,
    batch_code_primary: "JULY-26-BLK9",
    batch_code_fallbacks: [],
    supplier: null,
    strt_bal_kg: 9999,
    day_total_kg: 1414,
    end_bal_kg: 0,
    weight_kg: 1414,
    destination: "MAIN",
    production_batch: "JUL",
    remarks: null,
    operator_status: null,
    operator_remarks_raw: null,
    pallets_gross: [1498],
    pallets_count: [84],
    pallets_net: [1414],
    pallet_count: 1,
    is_closing: false,
    warnings: [],
    confidence: 1,
    _source_row: 4,
    ...over,
  };
}

// ---------------------------------------------------------------------------
// GATE 1 — PROPOSED vs RC MOVEMENT drift (serious >500kg). severity>=2 halts.
// ---------------------------------------------------------------------------
describe("GATE 1 — proposed_vs_movement_drift (P vs M)", () => {
  const D = "2026-07-04";
  const runGate1 = (P: number, M: number) =>
    reconcile(
      { rows: [{ transaction_date: D, weight_kg: P }] },
      { date_to_fed_kls: { [D]: M } },
      null, // GATE 1 runs WITHOUT rc_out_sums
      50,
      500,
    );

  it("does NOT trip at EXACTLY 500kg drift (boundary is strict >)", () => {
    // abs(P-M) == 500 → NOT serious (`> 500` is strict). It IS > tolerance (50) →
    // severity 1 (warning), which does NOT halt (sync checks `>= 2`).
    const rep = runGate1(1500, 1000);
    expect(rep.severity).toBe(1);
    expect(rep.summary.max_severity).toBe("warning");
  });

  it("TRIPS just past 500kg drift (500.01)", () => {
    const rep = runGate1(1500.01, 1000);
    expect(rep.severity).toBe(2);
    expect(rep.summary.max_severity).toBe("serious");
    expect(rep.drift_dates[0].notes.join(" ")).toContain("SERIOUS drift PROPOSED vs RC MOVEMENT");
  });

  it("does NOT trip at EXACTLY 50kg (tolerance boundary is strict >)", () => {
    // abs == 50 → not > tolerance → severity 0, a clean OK date.
    const rep = runGate1(1050, 1000);
    expect(rep.severity).toBe(0);
    expect(rep.summary.max_severity).toBe("none");
    expect(rep.summary.ok_dates).toBe(1);
  });

  it("warns (severity 1, no halt) just past 50kg (50.01)", () => {
    const rep = runGate1(1050.01, 1000);
    expect(rep.severity).toBe(1);
  });

  it("a missing RC MOVEMENT entry does not trip — only a note", () => {
    const rep = reconcile(
      { rows: [{ transaction_date: D, weight_kg: 1234 }] },
      { date_to_fed_kls: {} },
      null,
    );
    expect(rep.severity).toBe(0);
    expect(rep.drift_dates[0].notes).toContain("No RC MOVEMENT entry for this date");
  });
});

// ---------------------------------------------------------------------------
// GATE 2 — DB-vs-RC-MOVEMENT duplication (O>M). Only O ABOVE M trips.
// ---------------------------------------------------------------------------
describe("GATE 2 — db_vs_movement_duplication (O vs M)", () => {
  const D = "2026-06-16";
  const runGate2 = (O: number, M: number, P?: number) =>
    reconcile(
      { rows: P === undefined ? [] : [{ transaction_date: D, weight_kg: P }] },
      { date_to_fed_kls: { [D]: M } },
      { [D]: O }, // GATE 2 supplies rc_out_sums → activates O>M
      50,
      500,
    );

  it("does NOT trip at EXACTLY 500kg excess (strict >)", () => {
    const rep = runGate2(1500, 1000);
    expect(rep.severity).toBe(1); // >tolerance, ≤serious → warning, no halt
  });

  it("TRIPS just past 500kg excess (O-M = 500.01)", () => {
    const rep = runGate2(1500.01, 1000);
    expect(rep.severity).toBe(2);
    expect(rep.drift_dates[0].notes.join(" ")).toContain("SERIOUS DB-side DUPLICATION");
  });

  it("O BELOW M never trips (continuous-flow tank lag)", () => {
    // O well under M — the normal case; must be severity 0.
    const rep = runGate2(200, 5000);
    expect(rep.severity).toBe(0);
    expect(rep.summary.max_severity).toBe("none");
  });

  it("checks a DB-only date (no PROPOSED row for it) — L-019 full-span", () => {
    // No PROPOSED row for D, but the DB has a doubled sum → the gate still fires.
    const rep = runGate2(6000, 1000);
    expect(rep.severity).toBe(2);
    expect(rep.summary.proposed_dates).toBe(0);
    expect(rep.summary.db_dates_checked).toBe(1);
  });

  it("O with no M present does not trip (gate needs both O and M)", () => {
    const rep = reconcile(
      { rows: [] },
      { date_to_fed_kls: {} }, // no M for D
      { [D]: 999999 },
      50,
      500,
    );
    expect(rep.severity).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// L-019 sub-watermark guard — a settled-date NEW is FLAGGED, never NEW.
// ---------------------------------------------------------------------------
describe("classify — L-019 sub-watermark guard", () => {
  const batchLookup = { "JULY-26-BLK9": "bid-blk9" };

  it("FLAGS a sub-watermark row (date <= watermark) with no natural-key match", () => {
    const row = mkRow({ transaction_date: "2026-07-04" });
    const res = classifyRcOut({
      extractedRows: [row],
      batchLookup,
      dbRows: [],
      watermark: "2026-07-10", // 2026-07-04 <= 2026-07-10 → FLAGGED
    });
    expect(res.summary.new_count).toBe(0);
    expect(res.summary.flagged_count).toBe(1);
    expect(res.flagged[0].reason).toContain("sub-watermark NEW");
    // The flagged row is enriched with the resolved batch_id (classify mutation).
    expect(res.flagged[0].row.batch_id).toBe("bid-blk9");
  });

  it("does NOT flag when the date is strictly AFTER the watermark (→ NEW)", () => {
    const row = mkRow({ transaction_date: "2026-07-11" });
    const res = classifyRcOut({
      extractedRows: [row],
      batchLookup,
      dbRows: [],
      watermark: "2026-07-10",
    });
    expect(res.summary.new_count).toBe(1);
    expect(res.summary.flagged_count).toBe(0);
  });

  it("does NOT flag on the boundary being ABOVE watermark, but DOES on equality", () => {
    // transaction_date === watermark → `<=` is true → FLAGGED (settled date).
    const eq = classifyRcOut({
      extractedRows: [mkRow({ transaction_date: "2026-07-10" })],
      batchLookup,
      dbRows: [],
      watermark: "2026-07-10",
    });
    expect(eq.summary.flagged_count).toBe(1);
  });

  it("with watermark null the guard is disabled — settled-looking date → NEW", () => {
    const res = classifyRcOut({
      extractedRows: [mkRow({ transaction_date: "2020-01-01" })],
      batchLookup,
      dbRows: [],
      watermark: null,
    });
    expect(res.summary.new_count).toBe(1);
    expect(res.summary.flagged_count).toBe(0);
  });

  it("UNMAPPED is decided BEFORE the sub-watermark guard", () => {
    // A batch_code absent from the lookup → UNMAPPED even on a sub-watermark date.
    const row = mkRow({
      transaction_date: "2026-07-04",
      batch_code_primary: "JULY-26-BLK99",
      batch_code_fallbacks: [],
    });
    const res = classifyRcOut({
      extractedRows: [row],
      batchLookup,
      dbRows: [],
      watermark: "2026-07-10",
    });
    expect(res.summary.unmapped_count).toBe(1);
    expect(res.summary.flagged_count).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// batch_code primary → fallback resolution order.
// ---------------------------------------------------------------------------
describe("classify — batch resolution (primary then fallbacks)", () => {
  it("resolves via PRIMARY when present", () => {
    const res = classifyRcOut({
      extractedRows: [mkRow({ batch_code_primary: "MARCH-26-BLK1", batch_code_fallbacks: ["MAR-26-BLK1"] })],
      batchLookup: { "MARCH-26-BLK1": "id-primary", "MAR-26-BLK1": "id-fallback" },
      dbRows: [],
      watermark: null,
    });
    expect(res.summary.new_count).toBe(1);
    expect(res.new[0].row.batch_code_resolved).toBe("MARCH-26-BLK1");
    expect(res.new[0].row.batch_id).toBe("id-primary");
  });

  it("falls back to the FALLBACK code when primary is absent from the lookup", () => {
    const res = classifyRcOut({
      extractedRows: [mkRow({ batch_code_primary: "MARCH-26-BLK1", batch_code_fallbacks: ["MAR-26-BLK1"] })],
      batchLookup: { "MAR-26-BLK1": "id-fallback" }, // primary NOT present
      dbRows: [],
      watermark: null,
    });
    expect(res.summary.new_count).toBe(1);
    expect(res.new[0].row.batch_code_resolved).toBe("MAR-26-BLK1");
    expect(res.new[0].row.batch_id).toBe("id-fallback");
  });

  it("tries fallbacks in ORDER, first hit wins", () => {
    const res = classifyRcOut({
      extractedRows: [mkRow({ batch_code_primary: "NOPE", batch_code_fallbacks: ["FB1", "FB2"] })],
      batchLookup: { FB1: "id-fb1", FB2: "id-fb2" },
      dbRows: [],
      watermark: null,
    });
    expect(res.new[0].row.batch_code_resolved).toBe("FB1");
    expect(res.new[0].row.batch_id).toBe("id-fb1");
  });

  it("UNMAPPED when neither primary nor any fallback resolves", () => {
    const res = classifyRcOut({
      extractedRows: [mkRow({ batch_code_primary: "NOPE", batch_code_fallbacks: ["ALSO-NOPE"] })],
      batchLookup: { SOMETHING_ELSE: "x" },
      dbRows: [],
      watermark: null,
    });
    expect(res.summary.unmapped_count).toBe(1);
    expect(res.unmapped[0].reason).toContain("No batch_id found for primary='NOPE'");
    expect(res.unmapped[0].reason).toContain("fallbacks=['ALSO-NOPE']");
  });
});

// ---------------------------------------------------------------------------
// MALFORMED — a genuine zero total is dropped (not a NOOP).
// ---------------------------------------------------------------------------
describe("classify — malformed zero weight", () => {
  it("treats a zero day-total as MALFORMED, not a legitimate NOOP", () => {
    const res = classifyRcOut({
      extractedRows: [mkRow({ weight_kg: 0, day_total_kg: 0 })],
      batchLookup: { "JULY-26-BLK9": "bid-blk9" },
      dbRows: [],
      watermark: null,
    });
    expect(res.summary.malformed_count).toBe(1);
    expect(res.malformed[0].reason).toBe("missing or zero weight");
  });
});
