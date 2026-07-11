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
import { splitPvmDrift, dupDriftDates } from "../../src/reports/rc_out/index.js";
import {
  applyRcOut,
  type RcOutCompact,
  type QuarantinedDate,
} from "../../src/reports/rc_out/apply.js";
import type { DbClient, Row } from "../../src/lib/db.js";

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

// ---------------------------------------------------------------------------
// FEED-label detection regression (2026-07-11 production incident).
//
// The JULY 8/9 2026 PROPOSED DAILY REPORT day-tabs' section #1 uses the WHSE header
// "FOR FEEDING" (STRT/DAY/END/REMARKS geometry copied verbatim from the real workbook,
// runId 789775c4-2b61-498a-9a54-9c5a01484a89, rc_out storage path). The OLD detector
// (`whse.toUpperCase().includes("FEEDING AREA")`) only matched the exact legacy phrase
// "FEEDING AREA" and missed "FOR FEEDING" entirely, so this section extracted as a
// STANDARD block ("JULY-26-BLK1") instead of a FEED batch ("JULY-26-FEED1") — draining
// an unrelated real batch (D-19B) by 19,605 kg and closing it by mistake. The fix
// (FEED_LABEL_RE, a whole-word FEED/FEEDING match) must both recognize "FOR FEEDING"
// AND still leave real block labels alone.
// ---------------------------------------------------------------------------
describe("extract — FEED-label detection (\"FOR FEEDING\" WHSE header)", () => {
  // Geometry matches the real workbook exactly (see extractBlockSection: whse=col2,
  // STRT/DAY/END=col12 at R/R+1/R+2, REMARKS=col12 at R+3, pallet gross/count/net at
  // col2 rows R+3/R+4/R+5).
  function writeFeedSection(
    ws: ExcelJS.Worksheet,
    R: number,
    s: {
      whse: string;
      blockDate: Date;
      blockNo: string;
      strt: number;
      day: number;
      end: number | null;
      remarks: string;
      grossKg: number;
    },
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
    ws.getRow(R + 3).getCell(2).value = s.grossKg;
    ws.getRow(R + 3).getCell(11).value = "REMARKS";
    ws.getRow(R + 3).getCell(12).value = s.remarks;
    ws.getRow(R + 4).getCell(1).value = "Pallet";
    ws.getRow(R + 4).getCell(2).value = 0;
    ws.getRow(R + 5).getCell(1).value = "Net";
    ws.getRow(R + 5).getCell(2).value = s.grossKg;
  }

  async function buildFeedWorkbook(sheetName: string, over: Partial<Parameters<typeof writeFeedSection>[2]>) {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet(sheetName);
    writeFeedSection(ws, 43, {
      whse: "FOR FEEDING",
      blockDate: new Date(Date.UTC(2026, 6, 1)), // 2026-07-01
      blockNo: "# 1",
      strt: 19605,
      day: 3000,
      end: 16605,
      remarks: "FOR FEEDING",
      grossKg: 3000,
      ...over,
    });
    const buf = Buffer.from(await wb.xlsx.writeBuffer());
    return loadWorkbook(buf);
  }

  it('JULY 8 section: WHSE "FOR FEEDING" → is_feed=true, block_loc=null, FEED-prefixed derived code', async () => {
    const wb = await buildFeedWorkbook("JULY 8", {});
    const { rows } = extractProposed(wb, 2026);
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row.whse_label).toBe("FOR FEEDING");
    expect(row.is_feed).toBe(true);
    expect(row.block_loc).toBeNull();
    // July: PRIMARY_MONTH_PREFIX and FALLBACK_MONTH_PREFIX are both "JULY" → no fallback list.
    expect(row.batch_code_primary).toBe("JULY-26-FEED1");
    expect(row.batch_code_fallbacks).toEqual([]);
    expect(row.weight_kg).toBe(3000);
    // "FOR FEEDING" remarks is a pure status marker — dropped, not preserved.
    expect(row.remarks).toBeNull();
  });

  it('JULY 9 section: WHSE "FOR FEEDING" with a "DONE" close → still FEED1, remarks normalized to CLOSED', async () => {
    const wb = await buildFeedWorkbook("JULY 9", {
      strt: 16605,
      day: 16605,
      end: null,
      remarks: "DONE",
      grossKg: 16605,
    });
    const { rows } = extractProposed(wb, 2026);
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row.is_feed).toBe(true);
    expect(row.block_loc).toBeNull();
    expect(row.batch_code_primary).toBe("JULY-26-FEED1");
    expect(row.weight_kg).toBe(16605);
    expect(row.is_closing).toBe(true);
    expect(row.remarks).toBe("CLOSED");
  });

  it("does NOT mis-detect a real block label as FEED (conservative word-boundary match)", async () => {
    for (const whse of ["A-16D", "16A NEAR PATHWAY", "A-5B"]) {
      const wb = await buildFeedWorkbook("JULY 8", { whse, blockNo: "# 9" });
      const { rows } = extractProposed(wb, 2026);
      expect(rows).toHaveLength(1);
      expect(rows[0].is_feed).toBe(false);
      expect(rows[0].block_loc).toBe(whse);
      expect(rows[0].batch_code_primary).toBe("JULY-26-BLK9");
    }
  });

  it('still recognizes the legacy "FEEDING AREA" label (no regression on the pre-2026-07 template)', async () => {
    const wb = await buildFeedWorkbook("JULY 8", { whse: "FEEDING AREA" });
    const { rows } = extractProposed(wb, 2026);
    expect(rows[0].is_feed).toBe(true);
    expect(rows[0].block_loc).toBeNull();
    expect(rows[0].batch_code_primary).toBe("JULY-26-FEED1");
  });

  it("end-to-end classify: the FEED-derived code resolves to the FEED batch, never the coincidental BLK1 batch", () => {
    const feedRow = mkRow({
      transaction_date: "2026-07-08",
      whse_label: "FOR FEEDING",
      block_loc: null,
      block_date: "2026-07-01",
      block_no: 1,
      is_feed: true,
      batch_code_primary: "JULY-26-FEED1",
      batch_code_fallbacks: [],
      day_total_kg: 3000,
      weight_kg: 3000,
      remarks: null,
      _source_row: 43,
    });
    const res = classifyRcOut({
      extractedRows: [feedRow],
      // Both a FEED batch and an UNRELATED numbered-block batch exist in the lookup —
      // proves the resolved code, not a coincidental collision, drives the write.
      batchLookup: { "JULY-26-FEED1": "bid-feed1", "JULY-26-BLK1": "bid-blk1-unrelated" },
      dbRows: [],
      watermark: null,
    });
    expect(res.summary.new_count).toBe(1);
    expect(res.new[0].row.batch_id).toBe("bid-feed1");
    expect(res.new[0].row.batch_id).not.toBe("bid-blk1-unrelated");
    expect(res.new[0].row.block_loc).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Date-scoped quarantine (2026-07-11) — the run 83d17774 forensics fix.
//
// The HARD gates used to be a run-wide halt: ANY drifted date (even stale ones deep in
// the PROPOSED workbook's history) blocked apply from writing EVERY row, including
// today's clean feedings (the July 8-9 incident). This suite locks:
//   (a) GATE 1's witness-corroboration downgrade — a drifted date whose DB sum already
//       matches the movement sheet is NOT quarantined (informational only).
//   (b) A drifted date the DB does NOT corroborate (absent or also-disagreeing) IS
//       quarantined.
//   (c) GATE 2's duplication detail is isolated to REAL O-vs-M excess — never tripped
//       by a P-vs-M drift riding along in the same reconcile pass (the "no detail" bug).
//   (d) apply.ts only holds actionable rows on quarantined dates; every other date
//       writes normally, and the run still ends CLEAN/DIFFS-PENDING (not a silent
//       overwrite, not a blanket halt).
// ---------------------------------------------------------------------------
describe("GATE 1 quarantine — witness-corroboration downgrade", () => {
  it("(a) a serious P-vs-M drift where the DB already matches the movement sheet is NOT quarantined — attention only", () => {
    // The exact 83d17774 forensics: proposed 29,024 vs movement 28,087 on a settled date,
    // but rc_out DB SUM for that date already equals 28,087 (the movement total exactly).
    const rep = reconcile(
      { rows: [{ transaction_date: "2026-05-15", weight_kg: 29024 }] },
      { date_to_fed_kls: { "2026-05-15": 28087 } },
      null,
      50,
      500,
    );
    const { quarantine, attention } = splitPvmDrift(rep, { "2026-05-15": 28087 }, 50);
    expect(quarantine).toHaveLength(0);
    expect(attention).toHaveLength(1);
    expect(attention[0]).toContain("2026-05-15");
    expect(attention[0]).toContain("informational");
  });

  it("(a) the second 83d17774 date (2026-05-28, proposed 59,142 vs movement 56,393, DB==56,393) is also NOT quarantined", () => {
    const rep = reconcile(
      { rows: [{ transaction_date: "2026-05-28", weight_kg: 59142 }] },
      { date_to_fed_kls: { "2026-05-28": 56393 } },
      null,
      50,
      500,
    );
    const { quarantine, attention } = splitPvmDrift(rep, { "2026-05-28": 56393 }, 50);
    expect(quarantine).toHaveLength(0);
    expect(attention).toHaveLength(1);
  });

  it("(b) a serious P-vs-M drift with NO DB row for that date IS quarantined (no corroboration possible)", () => {
    const rep = reconcile(
      { rows: [{ transaction_date: "2026-07-01", weight_kg: 5000 }] },
      { date_to_fed_kls: { "2026-07-01": 1000 } },
      null,
      50,
      500,
    );
    const { quarantine, attention } = splitPvmDrift(rep, {}, 50);
    expect(quarantine).toHaveLength(1);
    expect(quarantine[0]).toMatchObject({
      date: "2026-07-01",
      proposed_kg: 5000,
      movement_kg: 1000,
      diff_kg: 4000,
    });
    expect(attention).toHaveLength(0);
  });

  it("(b) a serious P-vs-M drift where the DB ALSO disagrees with movement (beyond tolerance) IS quarantined", () => {
    const rep = reconcile(
      { rows: [{ transaction_date: "2026-07-02", weight_kg: 5000 }] },
      { date_to_fed_kls: { "2026-07-02": 1000 } },
      null,
      50,
      500,
    );
    // DB sum (4800) is within 50kg of proposed (5000) but NOT within 50kg of movement
    // (1000) — the corroboration test is DB-vs-MOVEMENT, not DB-vs-PROPOSED.
    const { quarantine } = splitPvmDrift(rep, { "2026-07-02": 4800 }, 50);
    expect(quarantine).toHaveLength(1);
  });

  it("a missing movement entry is ALWAYS quarantined — no second witness to corroborate against", () => {
    const rep = reconcile(
      { rows: [{ transaction_date: "2026-07-03", weight_kg: 5000 }] },
      { date_to_fed_kls: {} },
      null,
      50,
      500,
    );
    const { quarantine, attention } = splitPvmDrift(rep, { "2026-07-03": 5000 }, 50);
    expect(quarantine).toHaveLength(1);
    expect(quarantine[0].note).toBe("no movement entry");
    expect(attention).toHaveLength(0);
  });

  it("a tolerable (non-serious) P-vs-M drift is neither quarantined nor an attention note", () => {
    const rep = reconcile(
      { rows: [{ transaction_date: "2026-07-04", weight_kg: 1100 }] },
      { date_to_fed_kls: { "2026-07-04": 1000 } }, // diff=100, >50 tolerance but <=500 serious
      null,
      50,
      500,
    );
    const { quarantine, attention } = splitPvmDrift(rep, { "2026-07-04": 1000 }, 50);
    expect(quarantine).toHaveLength(0);
    expect(attention).toHaveLength(0);
  });
});

describe("GATE 2 quarantine — isolated from P-vs-M bleed-through", () => {
  it("(c) a P-vs-M-only drift date produces ZERO duplication entries (the 'no detail' bug)", () => {
    // Same shape as the 83d17774 forensics: PROPOSED disagrees with MOVEMENT, but the DB
    // sum for the date equals MOVEMENT exactly — genuinely NOT a duplication case. Before
    // this fix, GATE 2 reran the SAME reconcile pass and its severity>=2 check (bumped by
    // the P-vs-M drift alone) tripped the gate while dupDriftDates() returned [] — a held
    // row with no date/amounts (undiagnosable).
    const rep2 = reconcile(
      { rows: [{ transaction_date: "2026-05-28", weight_kg: 59142 }] },
      { date_to_fed_kls: { "2026-05-28": 56393 } },
      { "2026-05-28": 56393 }, // O == M exactly → zero excess
      50,
      500,
    );
    expect(dupDriftDates(rep2)).toHaveLength(0);
  });

  it("(c) a genuine O>M excess date carries full {date, db_sum_kg, movement_kg, excess_kg} detail", () => {
    const rep2 = reconcile(
      { rows: [] },
      { date_to_fed_kls: { "2026-06-16": 1000 } },
      { "2026-06-16": 2000 }, // O exceeds M by 1000 > 500 serious threshold
      50,
      500,
    );
    const dup = dupDriftDates(rep2);
    expect(dup).toHaveLength(1);
    expect(dup[0]).toMatchObject({
      date: "2026-06-16",
      db_sum_kg: 2000,
      movement_kg: 1000,
      excess_kg: 1000,
    });
  });

  it("O-vs-M excess at exactly 500kg does NOT trip (boundary is strict >)", () => {
    const rep2 = reconcile(
      { rows: [] },
      { date_to_fed_kls: { "2026-06-17": 1000 } },
      { "2026-06-17": 1500 },
      50,
      500,
    );
    expect(dupDriftDates(rep2)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// apply.ts — partition-level quarantine: only actionable rows on a quarantined date are
// held; every other date writes normally, and the run never silently overwrites.
// ---------------------------------------------------------------------------
describe("apply — date-scoped quarantine (partition-level, not a run-wide halt)", () => {
  function mkDb(hooks: { onInsert?: (table: string, rows: Row[]) => void } = {}): DbClient {
    const stub: Partial<DbClient> = {
      insertIfAbsent: async (table, rows) => {
        hooks.onInsert?.(table, rows);
        return {
          inserted: [{ ...rows[0], id: `NEW-${Math.random().toString(36).slice(2, 8)}` }],
          skipped: [],
          insertedCount: 1,
          skippedCount: 0,
        };
      },
      update: async () => [],
      writeIngestionAudit: async () => ({ id: "AUDIT-1" }),
      upsertIngestionWatermark: async () => true,
    };
    return stub as DbClient;
  }

  function newItem(date: string): { index: unknown; row: ProposedRow } {
    return {
      index: `${date}-idx`,
      row: mkRow({
        transaction_date: date,
        batch_id: "bid-blk9",
        batch_code_resolved: "JULY-26-BLK9",
      }),
    };
  }

  function baseCompact(over: Partial<RcOutCompact> = {}): RcOutCompact {
    return {
      report_type: "rc_out",
      since: "2026-07-01",
      watermark: null,
      gate_failures: [],
      quarantined_dates: [],
      source: { email_subject: null, email_uid: 1, email_thread_id: null },
      actionable: { new: [], changed: [], flagged: [], unmapped: [], malformed: [] },
      batch_lookup: {},
      ...over,
    };
  }

  it("(d) writes NEW rows on clean dates even while another date is quarantined — no run-wide halt", async () => {
    const inserted: Row[] = [];
    const db = mkDb({ onInsert: (_t, rows) => inserted.push(rows[0]) });
    const q: QuarantinedDate = {
      date: "2026-05-15",
      gate: "proposed_vs_movement_drift_500kg",
      detail: { date: "2026-05-15", proposed_kg: 29024, movement_kg: 28087, diff_kg: 937 },
    };
    const compact = baseCompact({
      quarantined_dates: [q],
      actionable: {
        new: [newItem("2026-05-15"), newItem("2026-07-08"), newItem("2026-07-09")],
        changed: [],
        flagged: [],
        unmapped: [],
        malformed: [],
      },
    });

    const res = await applyRcOut(compact, { db });

    // The July 8-9 forensics scenario: today's clean feedings write despite the stale
    // May-15 drift.
    expect(res.inserts).toBe(2);
    expect(inserted.map((r) => r.transaction_date).sort()).toEqual(["2026-07-08", "2026-07-09"]);

    const gateHolds = res.held.filter((h) => h.kind === "gate_failure");
    expect(gateHolds).toHaveLength(1);
    expect(gateHolds[0].row?.transaction_date).toBe("2026-05-15");
    expect(gateHolds[0].row?.drift_dates).toEqual([q.detail]);

    // A quarantine hold is NOT a write failure — labeling/watermark can still proceed
    // (same precedent as flagged/unmapped/malformed holds).
    expect(res.errors).toEqual([]);
    expect(res.ok).toBe(true);
  });

  it("a quarantined date with ZERO actionable rows this run still emits ONE summary held entry (visibility never lost)", async () => {
    const db = mkDb();
    const q: QuarantinedDate = {
      date: "2026-06-16",
      gate: "db_vs_movement_duplication",
      detail: { date: "2026-06-16", db_sum_kg: 2000, movement_kg: 1000, excess_kg: 1000 },
    };
    const compact = baseCompact({ quarantined_dates: [q] });

    const res = await applyRcOut(compact, { db });

    expect(res.inserts).toBe(0);
    expect(res.held).toHaveLength(1);
    expect(res.held[0].kind).toBe("gate_failure");
    expect(res.held[0].reason).toBe("db_vs_movement_duplication");
    expect(res.held[0].row?.drift_dates).toEqual([q.detail]);
  });

  it("(e) two gates quarantining the SAME date accumulate into one held row with both details", async () => {
    const db = mkDb();
    const q1: QuarantinedDate = {
      date: "2026-05-20",
      gate: "proposed_vs_movement_drift_500kg",
      detail: { date: "2026-05-20", proposed_kg: 5000, movement_kg: 1000, diff_kg: 4000 },
    };
    const q2: QuarantinedDate = {
      date: "2026-05-20",
      gate: "db_vs_movement_duplication",
      detail: { date: "2026-05-20", db_sum_kg: 2000, movement_kg: 1000, excess_kg: 1000 },
    };
    const compact = baseCompact({
      quarantined_dates: [q1, q2],
      actionable: { new: [newItem("2026-05-20")], changed: [], flagged: [], unmapped: [], malformed: [] },
    });

    const res = await applyRcOut(compact, { db });

    expect(res.inserts).toBe(0);
    const gateHolds = res.held.filter((h) => h.kind === "gate_failure");
    expect(gateHolds).toHaveLength(1);
    expect(gateHolds[0].row?.drift_dates).toEqual([q1.detail, q2.detail]);
    expect(gateHolds[0].reason).toContain("proposed_vs_movement_drift_500kg");
    expect(gateHolds[0].reason).toContain("db_vs_movement_duplication");
  });

  it("(d) an all-clean run (no quarantined dates) writes everything — unchanged from before this fix", async () => {
    const inserted: Row[] = [];
    const db = mkDb({ onInsert: (_t, rows) => inserted.push(rows[0]) });
    const compact = baseCompact({
      actionable: {
        new: [newItem("2026-07-08"), newItem("2026-07-09")],
        changed: [],
        flagged: [],
        unmapped: [],
        malformed: [],
      },
    });

    const res = await applyRcOut(compact, { db });

    expect(res.inserts).toBe(2);
    expect(inserted).toHaveLength(2);
    expect(res.held).toHaveLength(0);
    expect(res.ok).toBe(true);
    expect(res.errors).toEqual([]);
  });
});
