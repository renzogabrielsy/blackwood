/**
 * rcOutStage.test.ts — R2 SHADOW wiring tests. Drives SYNTHETIC extracted rows
 * (proposed block-sections + gsheet RC OUT rows + movement day totals) THROUGH the
 * bucketing stage into the R1 engine, reproducing L-037, and asserts the resulting
 * `source_diff` descriptors. This is the integration layer above rcOut.test.ts (which
 * tests the pure engine on hand-built SourceRecords).
 *
 * L-037 ground truth (2026-06-10): a block fed in multiple legs, whose Google Sheet
 * total carried a cross-block cumulative → over-stated. proposed's whole-day rc_out
 * total reconciles to the RC MOVEMENT day total; gsheet's does not → proposed recommended.
 */
import { describe, it, expect } from "vitest";

import {
  reconcileRcOutStage,
  bucketProposed,
  canonicalBatchKey,
} from "../../src/reconcile/rcOutStage.js";
import type { ProposedRow } from "../../src/reports/rc_out/extract.js";
import type { RowDict } from "../../src/reports/gsheet/deductions.js";

const D = "2026-06-10";

/** A minimal PROPOSED block-section (one leg). Only the fields the stage reads matter. */
function pLeg(
  batchPrimary: string,
  batchFallbacks: string[],
  block: string,
  strt: number,
  end: number,
  dayTotal: number,
): ProposedRow {
  return {
    transaction_date: D,
    whse_label: block,
    block_loc: block,
    block_date: D,
    block_no: 0,
    is_feed: false,
    batch_code_primary: batchPrimary,
    batch_code_fallbacks: batchFallbacks,
    supplier: null,
    strt_bal_kg: strt,
    day_total_kg: dayTotal,
    end_bal_kg: end,
    weight_kg: dayTotal,
    destination: "MAIN",
    production_batch: "JUNE",
    remarks: null,
    operator_status: null,
    operator_remarks_raw: null,
    pallets_gross: [],
    pallets_count: [],
    pallets_net: [],
    pallet_count: 0,
    is_closing: false,
    warnings: [],
    confidence: 1,
    _source_row: 1,
  };
}

/** A minimal gsheet RC OUT row. */
function gRow(batchPrimary: string, batchFallbacks: string[], block: string, weight: number): RowDict {
  return {
    transaction_date: D,
    batch_code_primary: batchPrimary,
    batch_code_fallbacks: batchFallbacks,
    production_batch: "JUNE",
    destination: "MAIN",
    weight_kg: weight,
    block_loc: block,
    remarks: null,
    warnings: [],
    confidence: 1,
    _source_row: 1,
    _source_tab: "RC OUT",
  };
}

/**
 * The L-037 day as REAL extract rows:
 *  - BLK5 @ D-11B: proposed 2 legs (10,813 + 20,932 = 31,745, both self-consistent);
 *    gsheet over-states to 42,558 (10,813 + cross-block-cumulative 31,745). gsheet uses
 *    the ALTERNATE month-prefix convention ("MAR-…") to prove canonicalization aligns them.
 *  - BLK6 @ D-12B: proposed 5,930 (2,930 + 3,000); gsheet 8,860 (2,930 + 5,930).
 *  - BLK1 @ A-1A: a clean single-leg batch all sources agree on (10,000).
 *  - RC MOVEMENT day total = 31,745 + 5,930 + 10,000 = 47,675 (the PROPOSED picture).
 */
function l037Input() {
  const proposed: ProposedRow[] = [
    pLeg("MARCH-26-BLK5", ["MAR-26-BLK5"], "D-11B", 65_763, 54_950, 10_813),
    pLeg("MARCH-26-BLK5", ["MAR-26-BLK5"], "D-11B", 54_950, 34_018, 20_932),
    pLeg("MARCH-26-BLK6", ["MAR-26-BLK6"], "D-12B", 40_000, 37_070, 2_930),
    pLeg("MARCH-26-BLK6", ["MAR-26-BLK6"], "D-12B", 37_070, 34_070, 3_000),
    pLeg("APRIL-26-BLK1", ["APR-26-BLK1"], "A-1A", 20_000, 10_000, 10_000),
  ];
  const gsheetRcOut: RowDict[] = [
    gRow("MAR-26-BLK5", ["MARCH-26-BLK5"], "D-11B", 10_813),
    gRow("MAR-26-BLK5", ["MARCH-26-BLK5"], "D-11B", 31_745), // the cross-block cumulative
    gRow("MAR-26-BLK6", ["MARCH-26-BLK6"], "D-12B", 2_930),
    gRow("MAR-26-BLK6", ["MARCH-26-BLK6"], "D-12B", 5_930),
    gRow("APR-26-BLK1", ["APRIL-26-BLK1"], "A-1A", 10_000),
  ];
  const movementByDate = { [D]: 47_675 };
  return { proposed, gsheetRcOut, movementByDate };
}

describe("reconcileRcOutStage — L-037 through the bucketing stage", () => {
  it("raises exactly the 2 over-stated weight diffs, recommends proposed on each", () => {
    const { diffs, agreements } = reconcileRcOutStage(l037Input());

    expect(diffs).toHaveLength(2);
    expect(agreements).toBeGreaterThanOrEqual(1); // the clean BLK1 agreement

    for (const d of diffs) {
      expect(d.field).toBe("weight_kg");
      expect(d.table).toBe("rc_out");
      expect(d.recommended?.source).toBe("proposed");
      expect(d.recommended?.why).toMatch(/RC MOVEMENT day total/);
      const prop = d.sources.find((s) => s.source === "proposed")!;
      const sheet = d.sources.find((s) => s.source === "gsheet")!;
      expect(prop.corroboratedBy).toContain("movement");
      expect(sheet.corroboratedBy).toHaveLength(0);
      expect(prop.selfConsistent).toBe(true); // legs balance
    }
  });

  it("carries the exact summed competing values per batch (leg sums)", () => {
    const { diffs } = reconcileRcOutStage(l037Input());
    // Both sources canonicalize to the smaller alias "MAR-26-BLK5" / "MAR-26-BLK6".
    const blk5 = diffs.find((d) => d.naturalKey.batch === "MAR-26-BLK5")!;
    const blk6 = diffs.find((d) => d.naturalKey.batch === "MAR-26-BLK6")!;
    expect(blk5).toBeDefined();
    expect(blk6).toBeDefined();

    expect(blk5.sources.find((s) => s.source === "proposed")!.value).toBe(31_745);
    expect(blk5.sources.find((s) => s.source === "gsheet")!.value).toBe(42_558);
    expect(blk6.sources.find((s) => s.source === "proposed")!.value).toBe(5_930);
    expect(blk6.sources.find((s) => s.source === "gsheet")!.value).toBe(8_860);
    // block_loc + destination survive onto the natural key (for the human label).
    expect(blk5.naturalKey.block_loc).toBe("D-11B");
    expect(blk5.naturalKey.destination).toBe("MAIN");
  });

  it("the clean batch is NOT a diff", () => {
    const { diffs } = reconcileRcOutStage(l037Input());
    expect(diffs.some((d) => d.naturalKey.batch === "APR-26-BLK1")).toBe(false);
  });
});

describe("bucketProposed — self-consistency + FEED skip", () => {
  it("marks a bucket self-inconsistent when a leg's STRT − END != DAY TOTAL (L-037 signature)", () => {
    // leg 2 DAY TOTAL = 31,745 but STRT−END = 54,950−34,018 = 20,932 → inconsistent bucket.
    const recs = bucketProposed([
      pLeg("MARCH-26-BLK5", ["MAR-26-BLK5"], "D-11B", 65_763, 54_950, 10_813),
      pLeg("MARCH-26-BLK5", ["MAR-26-BLK5"], "D-11B", 54_950, 34_018, 31_745),
    ]);
    expect(recs).toHaveLength(1);
    expect(recs[0].selfConsistent).toBe(false);
    expect(recs[0].selfConsistencyNote).toMatch(/cross-block cumulative/);
    // Still sums the stated weights (10,813 + 31,745).
    expect(recs[0].fields.weight_kg).toBe(42_558);
  });

  it("skips a FEED block (null block_loc) — it cannot form a fine key in R2", () => {
    const feed = pLeg("JUNE-26-FEED2", ["JUN-26-FEED2"], "IGNORED", 0, 0, 5_930);
    feed.block_loc = null;
    feed.is_feed = true;
    expect(bucketProposed([feed])).toHaveLength(0);
  });
});

describe("canonicalBatchKey", () => {
  it("aligns the two month-prefix conventions to the same key", () => {
    expect(canonicalBatchKey("MARCH-26-BLK5", ["MAR-26-BLK5"])).toBe("MAR-26-BLK5");
    expect(canonicalBatchKey("MAR-26-BLK5", ["MARCH-26-BLK5"])).toBe("MAR-26-BLK5");
  });

  it("returns null when no code is present", () => {
    expect(canonicalBatchKey(null, [])).toBeNull();
    expect(canonicalBatchKey("", ["  "])).toBeNull();
  });
});
