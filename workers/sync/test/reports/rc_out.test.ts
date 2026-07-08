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

import ExcelJS from "exceljs";

import { reconcile } from "../../src/reports/rc_out/reconcile.js";
import { classifyRcOut } from "../../src/reports/rc_out/classify.js";
import { extractProposed, type ProposedRow } from "../../src/reports/rc_out/extract.js";
import { loadWorkbook } from "../../src/lib/xlsx.js";

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
    // Balances default to null so the L-037 balance-integrity guard is INERT for tests
    // targeting other rules (a null STRT/END is never validated). The L-037 suite below
    // supplies explicit, balance-consistent (or deliberately broken) STRT/END values.
    strt_bal_kg: null,
    day_total_kg: 1414,
    end_bal_kg: null,
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
// L-034 month-boundary label variance — the 2026-07-07 incident.
// FEB-26-BLK4 · MAIN · 2026-06-30 · 2,507 kg (block_loc A-7C) was ALREADY in the DB
// (written 2026-07-01) with production_batch "JULY" (June-30 sheet header = STARTING
// OF JULY FEEDING). The incoming June-30 row labels it "JUNE" (calendar month). Every
// HARD field matches (batch_id/date/destination/weight_kg/block_loc); ONLY the run label
// differs. It must be NOOP + a soft warning — never a hold, never a needless label-flip
// UPDATE. The real fix is TWO-part: (1) the orchestrator widens the compare-set floor so
// the settled DB copy is IN the window (else it is a false sub-watermark hold); (2) when the
// natural key then MATCHES and the ONLY diff is production_batch, classify demotes it to a
// NOOP + soft warning. These unit tests exercise part (2) by supplying the DB copy in dbRows
// (window already covers it); the window widening is proven via the REGRESSION test below.
// ---------------------------------------------------------------------------
describe("classify — L-034 month-boundary label variance", () => {
  const BID = "a455437e"; // same batch_id both codes resolve to (real incident)
  const batchLookup = { "JUNE-26-FEED4": BID, "JULY-26-FEED4": BID, "FEB-26-BLK4": BID };

  // The DB row exactly as written 2026-07-01 (production_batch = JULY).
  const dbRow = {
    id: "rcout-existing-1",
    transaction_date: "2026-06-30",
    batch_id: BID,
    destination: "MAIN",
    weight_kg: 2507,
    block_loc: "A-7C",
    production_batch: "JULY",
    remarks: null,
  };

  // The incoming June-30 row: same hard fields, production_batch = JUNE.
  const mkIncident = (over: Partial<ProposedRow> = {}) =>
    mkRow({
      transaction_date: "2026-06-30",
      block_loc: "A-7C",
      whse_label: "A-7C",
      batch_code_primary: "FEB-26-BLK4",
      batch_code_fallbacks: [],
      day_total_kg: 2507,
      weight_kg: 2507,
      production_batch: "JUNE",
      _source_row: 7,
      ...over,
    });

  it("(A) natural-key MATCH, only production_batch differs → NOOP + soft warning, NOT VALUE_CHANGED", () => {
    const res = classifyRcOut({
      extractedRows: [mkIncident()],
      batchLookup,
      dbRows: [dbRow], // DB row IS in the window (widened compare-set)
      watermark: "2026-07-05",
    });
    expect(res.summary.flagged_count).toBe(0);
    expect(res.summary.new_count).toBe(0);
    expect(res.summary.changed_count).toBe(0); // NOT a VALUE_CHANGED — no label-flip UPDATE
    expect(res.summary.noop_count).toBe(1);
    expect(res.noop[0].db_id).toBe("rcout-existing-1");
    expect(res.soft_warnings).toHaveLength(1);
    expect(res.soft_warnings[0].kind).toBe("sub_watermark_suspected_dup");
    expect(res.soft_warnings[0].message).toContain("already saved — no action needed");
    expect(res.soft_warnings[0].message).toContain("JUNE");
    expect(res.soft_warnings[0].message).toContain("JULY");
  });

  it("(A) natural-key MATCH with label ALSO matching → silent NOOP (no soft warning)", () => {
    const res = classifyRcOut({
      extractedRows: [mkIncident({ production_batch: "JULY" })],
      batchLookup,
      dbRows: [dbRow],
      watermark: "2026-07-05",
    });
    expect(res.summary.noop_count).toBe(1);
    expect(res.summary.changed_count).toBe(0);
    expect(res.soft_warnings).toHaveLength(0);
  });

  it("(A) a REAL change (weight) alongside a label diff is STILL a VALUE_CHANGED", () => {
    // weight differs → the row genuinely changed; must not be swallowed to NOOP.
    const res = classifyRcOut({
      extractedRows: [mkIncident({ day_total_kg: 2600, weight_kg: 2600 })],
      batchLookup,
      dbRows: [dbRow],
      watermark: "2026-07-05",
    });
    expect(res.summary.changed_count).toBe(1);
    expect(res.summary.noop_count).toBe(0);
    expect(res.soft_warnings).toHaveLength(0);
  });

  it("REGRESSION (window bug): a settled row older than watermark−3d whose exact DB copy exists → NOOP, not held", () => {
    // The four extra false-flags (all 2026-06-30, watermark 2026-07-04 → since 2026-07-01).
    // With the widened compare-set the DB copy is present → natural-key match → NOOP.
    // Label identical here (proves the window fix alone resolves it, independent of L-034 label logic).
    const march = {
      id: "rcout-march-blk9",
      transaction_date: "2026-06-30",
      batch_id: "bid-march-blk9",
      destination: "MAIN",
      weight_kg: 1414,
      block_loc: "C-6A",
      production_batch: "JUNE",
      remarks: null,
    };
    const incoming = mkRow({
      transaction_date: "2026-06-30",
      block_loc: "C-6A",
      whse_label: "C-6A",
      batch_code_primary: "MARCH-26-BLK9",
      batch_code_fallbacks: [],
      day_total_kg: 1414,
      weight_kg: 1414,
      production_batch: "JUNE",
      _source_row: 3,
    });
    const res = classifyRcOut({
      extractedRows: [incoming],
      batchLookup: { "MARCH-26-BLK9": "bid-march-blk9" },
      dbRows: [march], // present because the compare-set was widened to cover 2026-06-30
      watermark: "2026-07-04",
    });
    expect(res.summary.noop_count).toBe(1);
    expect(res.summary.flagged_count).toBe(0);
    expect(res.soft_warnings).toHaveLength(0);
  });

  it("NEGATIVE: a genuinely-missing settled row (no DB copy at all) is STILL held", () => {
    const res = classifyRcOut({
      extractedRows: [mkIncident()],
      batchLookup,
      dbRows: [], // truly absent — a real miss, not a window artifact
      watermark: "2026-07-05",
    });
    expect(res.summary.flagged_count).toBe(1);
    expect(res.summary.noop_count).toBe(0);
    expect(res.flagged[0].reason).toContain("sub-watermark NEW");
    expect(res.soft_warnings).toHaveLength(0);
  });

  it("NEGATIVE: a settled row present but differing in weight_kg → hard-key miss → STILL held", () => {
    const res = classifyRcOut({
      extractedRows: [mkIncident({ day_total_kg: 3000, weight_kg: 3000 })],
      batchLookup: { "FEB-26-BLK4": "other-bid" }, // different batch_id → natural-key miss
      dbRows: [dbRow], // weight 2507 vs incoming 3000 → no 5-field rescue
      watermark: "2026-07-05",
    });
    expect(res.summary.flagged_count).toBe(1);
    expect(res.soft_warnings).toHaveLength(0);
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

// ---------------------------------------------------------------------------
// L-037 — balances become VALIDATION, not scraped data.
//
// The June-10 production bug: MARCH-26-BLK5 at D-11B was fed in TWO consecutive legs on
// one sheet. Leg 1 DAY TOTAL 10,813 (STRT 65,763 → END 54,950). Leg 2 DAY TOTAL 20,932
// (STRT 54,950 → END 34,018). The DB stored 10,813 and 31,745 — leg 2 got a CROSS-BLOCK
// cumulative (65,763 − 34,018 = day-opening minus leg-2's end), over-stating the feeding.
// The extractor reads each block's own DAY TOTAL scoped to that block; the guard is the
// validation layer that HOLDS a row whose scraped DAY TOTAL disagrees with the block's own
// STRT/END, or whose STRT breaks continuity from the prior same-slot leg.
// ---------------------------------------------------------------------------
describe("classify — L-037 balance-integrity guard", () => {
  const batchLookup = { "MARCH-26-BLK5": "bid-blk5" };

  // The correct two-leg day — each leg's DAY TOTAL agrees with its own STRT − END.
  const leg1 = () =>
    mkRow({
      transaction_date: "2026-06-10",
      whse_label: "D-11B",
      block_loc: "D-11B",
      block_date: "2026-03-01",
      block_no: 5,
      batch_code_primary: "MARCH-26-BLK5",
      batch_code_fallbacks: [],
      strt_bal_kg: 65763,
      end_bal_kg: 54950,
      day_total_kg: 10813,
      weight_kg: 10813,
      production_batch: "JUNE",
      _source_row: 8,
    });
  const leg2 = (over: Partial<ProposedRow> = {}) =>
    mkRow({
      transaction_date: "2026-06-10",
      whse_label: "D-11B",
      block_loc: "D-11B",
      block_date: "2026-03-01",
      block_no: 5,
      batch_code_primary: "MARCH-26-BLK5",
      batch_code_fallbacks: [],
      strt_bal_kg: 54950,
      end_bal_kg: 34018,
      day_total_kg: 20932,
      weight_kg: 20932,
      production_batch: "JUNE",
      _source_row: 12,
      ...over,
    });

  it("two consistent legs are BOTH accepted (weights 10,813 and 20,932 — never 31,745)", () => {
    const res = classifyRcOut({
      extractedRows: [leg1(), leg2()],
      batchLookup,
      dbRows: [],
      watermark: null,
    });
    expect(res.summary.flagged_count).toBe(0);
    expect(res.summary.new_count).toBe(2);
    const weights = res.new.map((n) => n.row.weight_kg);
    expect(weights).toEqual([10813, 20932]);
    expect(weights).not.toContain(31745);
  });

  it("HOLDS leg 2 when its DAY TOTAL is a cross-block cumulative (31,745 vs STRT−END 20,932)", () => {
    // The exact June-10 corruption: leg 2's DAY TOTAL cell carries 31,745 (= 65,763 − 34,018),
    // but its own STRT 54,950 − END 34,018 = 20,932. The guard flags it, never inserts.
    const res = classifyRcOut({
      extractedRows: [leg1(), leg2({ day_total_kg: 31745, weight_kg: 31745 })],
      batchLookup,
      dbRows: [],
      watermark: null,
    });
    expect(res.summary.new_count).toBe(1); // leg 1 still clean → NEW
    expect(res.summary.flagged_count).toBe(1);
    expect(res.flagged[0].reason).toContain("balance integrity");
    expect(res.flagged[0].reason).toContain("cross-block cumulative");
    expect(res.flagged[0].row.weight_kg).toBe(31745);
  });

  it("HOLDS on a slot-continuity break (leg 2 STRT ≠ leg 1 END) even when leg 2 is internally consistent", () => {
    // leg 2 opens at 50,000 (≠ leg 1's END 54,950) but is internally consistent
    // (50,000 − 29,068 = 20,932), so only the continuity check catches it.
    const res = classifyRcOut({
      extractedRows: [leg1(), leg2({ strt_bal_kg: 50000, end_bal_kg: 29068 })],
      batchLookup,
      dbRows: [],
      watermark: null,
    });
    expect(res.summary.flagged_count).toBe(1);
    expect(res.summary.new_count).toBe(1);
    expect(res.flagged[0].reason).toContain("slot continuity");
  });

  it("continuity does NOT fire across DIFFERENT slots (different whse) even if STRT ≠ prior END", () => {
    const other = leg2({
      whse_label: "A-7C",
      block_loc: "A-7C",
      block_no: 4,
      batch_code_primary: "MARCH-26-BLK5", // same code, different physical slot
      strt_bal_kg: 99999, // ≠ leg1 END, but a different slot → not compared
      end_bal_kg: 79067, // 99999 − 79067 = 20932 (internally consistent)
    });
    const res = classifyRcOut({
      extractedRows: [leg1(), other],
      batchLookup,
      dbRows: [],
      watermark: null,
    });
    expect(res.summary.flagged_count).toBe(0);
    expect(res.summary.new_count).toBe(2);
  });

  it("the guard prevents a corrupt DAY TOTAL from OVERWRITING a corrected DB row (no VALUE_CHANGED)", () => {
    // The DB already holds the CORRECT 20,932 (hand-corrected). The sheet still carries the
    // corrupt 31,745. Without the guard this is a VALUE_CHANGED that would re-corrupt the DB;
    // with the guard it is HELD instead.
    const dbRow = {
      id: "rcout-corrected",
      transaction_date: "2026-06-10",
      batch_id: "bid-blk5",
      destination: "MAIN",
      weight_kg: 20932,
      block_loc: "D-11B",
      production_batch: "JUNE",
      remarks: null,
    };
    const res = classifyRcOut({
      extractedRows: [leg2({ day_total_kg: 31745, weight_kg: 31745 })],
      batchLookup,
      dbRows: [dbRow],
      watermark: null,
    });
    expect(res.summary.changed_count).toBe(0);
    expect(res.summary.flagged_count).toBe(1);
    expect(res.flagged[0].reason).toContain("balance integrity");
  });

  it("is INERT when STRT/END are absent (a blank-balance section is never held)", () => {
    const res = classifyRcOut({
      extractedRows: [leg2({ strt_bal_kg: null, end_bal_kg: null, day_total_kg: 31745, weight_kg: 31745 })],
      batchLookup,
      dbRows: [],
      watermark: null,
    });
    expect(res.summary.flagged_count).toBe(0);
    expect(res.summary.new_count).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// L-037 EXTRACTOR regression — a two-leg sheet must yield each leg's OWN DAY TOTAL.
// This is the end-to-end proof that the extractor scopes DAY TOTAL to its block and
// never reaches into a previous block's balance (the source of the 31,745 cumulative).
// ---------------------------------------------------------------------------
describe("extract — two-leg same-batch same-day sheet", () => {
  // Geometry mirrors the real PROPOSED sections: col A labels, whse in col B, block date
  // and block no in col B (R+1/R+2), STRT/DAY/END stats in col 12.
  function writeSection(
    ws: ExcelJS.Worksheet,
    R: number,
    s: { whse: string; blockDate: Date; blockNo: string; strt: number; day: number; end: number },
  ): void {
    ws.getRow(R + 0).getCell(1).value = "WHSE #";
    ws.getRow(R + 0).getCell(2).value = s.whse;
    ws.getRow(R + 0).getCell(11).value = "STRT. BAL";
    ws.getRow(R + 0).getCell(12).value = s.strt;
    ws.getRow(R + 1).getCell(1).value = "BLOCK DATE";
    ws.getRow(R + 1).getCell(2).value = s.blockDate;
    ws.getRow(R + 1).getCell(11).value = "DAY TOTAL";
    ws.getRow(R + 1).getCell(12).value = s.day;
    ws.getRow(R + 2).getCell(1).value = "BLOCK NO.";
    ws.getRow(R + 2).getCell(2).value = s.blockNo;
    ws.getRow(R + 2).getCell(11).value = "END BAL.";
    ws.getRow(R + 2).getCell(12).value = s.end;
    ws.getRow(R + 3).getCell(1).value = "Gross weight";
  }

  async function buildTwoLegWorkbook(leg2Day: number) {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("JUNE 10");
    const bd = new Date(Date.UTC(2026, 2, 1)); // 2026-03-01 → MARCH-26-BLK5
    writeSection(ws, 4, { whse: "D-11B", blockDate: bd, blockNo: "# 5", strt: 65763, day: 10813, end: 54950 });
    writeSection(ws, 12, { whse: "D-11B", blockDate: bd, blockNo: "# 5", strt: 54950, day: leg2Day, end: 34018 });
    const buf = Buffer.from(await wb.xlsx.writeBuffer());
    return loadWorkbook(buf);
  }

  it("reads each leg's OWN DAY TOTAL — [10,813, 20,932], NEVER [10,813, 31,745]", async () => {
    const wb = await buildTwoLegWorkbook(20932);
    const { rows } = extractProposed(wb, 2026);
    expect(rows.map((r) => r.weight_kg)).toEqual([10813, 20932]);
    expect(rows.map((r) => r.day_total_kg)).toEqual([10813, 20932]);
    // Both legs carry their own scoped balances (the guard validates these downstream).
    expect(rows[1].strt_bal_kg).toBe(54950);
    expect(rows[1].end_bal_kg).toBe(34018);
    expect(rows.map((r) => r.batch_code_primary)).toEqual(["MARCH-26-BLK5", "MARCH-26-BLK5"]);
  });

  it("even when leg 2's DAY TOTAL cell is a cumulative, the extractor scrapes THAT cell verbatim (the guard, not the extractor, holds it)", async () => {
    // Proves the extractor does NOT silently 'fix' the number — it faithfully reports the
    // sheet's DAY TOTAL (31,745). classify's L-037 guard is what catches the STRT−END mismatch.
    const wb = await buildTwoLegWorkbook(31745);
    const { rows } = extractProposed(wb, 2026);
    expect(rows[1].weight_kg).toBe(31745);
    const res = classifyRcOut({
      extractedRows: rows,
      batchLookup: { "MARCH-26-BLK5": "bid-blk5" },
      dbRows: [],
      watermark: null,
    });
    expect(res.summary.flagged_count).toBe(1);
    expect(res.flagged[0].reason).toContain("cross-block cumulative");
  });
});
