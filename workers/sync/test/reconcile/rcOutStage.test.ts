/**
 * rcOutStage.test.ts — R2 SHADOW wiring + R4a cutover prereqs. Drives SYNTHETIC extracted rows
 * (proposed block-sections + gsheet RC OUT rows + movement day totals) THROUGH the bucketing
 * stage into the R1 engine, reproducing L-037, and asserts the resulting `source_diff`
 * descriptors. R4a additions: batch_id alignment (Deliverable 1), FEED-block keying (Deliverable
 * 2), and the pending vs held_overdue split (Deliverable 3).
 *
 * L-037 ground truth (2026-06-10): a block fed in multiple legs, whose Google Sheet total
 * carried a cross-block cumulative → over-stated. proposed's whole-day rc_out total reconciles
 * to the RC MOVEMENT day total; gsheet's does not → proposed recommended.
 */
import { describe, it, expect } from "vitest";

import {
  reconcileRcOutStage,
  bucketProposed,
  canonicalBatchKey,
  resolveBatchCandidates,
} from "../../src/reconcile/rcOutStage.js";
import type { ProposedRow } from "../../src/reports/rc_out/extract.js";
import type { RowDict } from "../../src/reports/gsheet/deductions.js";
import type { BatchLookup } from "../../src/reports/rc_out/classify.js";

const D = "2026-06-10";

/**
 * The batch_code → batch_id lookup R4a resolves against. BOTH month-prefix conventions
 * ("MARCH-…" and "MAR-…") map to the SAME id, so proposed and gsheet align by batch_id even
 * though they carry different code strings (Deliverable 1).
 */
const LOOKUP: BatchLookup = {
  "MARCH-26-BLK5": "id-blk5",
  "MAR-26-BLK5": "id-blk5",
  "MARCH-26-BLK6": "id-blk6",
  "MAR-26-BLK6": "id-blk6",
  "APRIL-26-BLK1": "id-blk1",
  "APR-26-BLK1": "id-blk1",
  "JUNE-26-FEED2": "id-feed2",
  "JUN-26-FEED2": "id-feed2",
};

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
 *    the ALTERNATE month-prefix convention ("MAR-…") to prove batch_id alignment aligns them.
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
  // runDate far after the L-037 day so single-witness facts are NOT the point of these tests.
  return { proposed, gsheetRcOut, movementByDate, batchLookup: LOOKUP };
}

describe("reconcileRcOutStage — L-037 through the bucketing stage (batch_id aligned)", () => {
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

  it("aligns two different code strings to the SAME resolved batch_id (no false single-source split)", () => {
    const { diffs } = reconcileRcOutStage(l037Input());
    // Both conventions resolve to "id-blk5" / "id-blk6" — the natural key is the batch_id now.
    const blk5 = diffs.find((d) => d.naturalKey.batch === "id-blk5")!;
    const blk6 = diffs.find((d) => d.naturalKey.batch === "id-blk6")!;
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
    expect(diffs.some((d) => d.naturalKey.batch === "id-blk1")).toBe(false);
  });

  it("each opinion carries the raw per-leg rows that summed to its value (R3 write-plan input)", () => {
    const { diffs } = reconcileRcOutStage(l037Input());
    const blk5 = diffs.find((d) => d.naturalKey.batch === "id-blk5")!;

    const prop = blk5.sources.find((s) => s.source === "proposed")!;
    const sheet = blk5.sources.find((s) => s.source === "gsheet")!;

    // proposed's legs: 10,813 + 20,932 (true) → sum 31,745.
    expect(prop.rows.map((r) => r.weight_kg).sort((a, b) => a - b)).toEqual([10_813, 20_932]);
    // gsheet's legs: 10,813 + 31,745 (the cross-block cumulative) → sum 42,558.
    expect(sheet.rows.map((r) => r.weight_kg).sort((a, b) => a - b)).toEqual([10_813, 31_745]);

    // Legs carry the RESOLVED batch_id + natural-key context (never a ₱/cost field).
    for (const leg of prop.rows) {
      expect(leg.block_loc).toBe("D-11B");
      expect(leg.destination).toBe("MAIN");
      expect(leg.transaction_date).toBe(D);
      expect(leg.batch_id).toBe("id-blk5");
      expect(leg).not.toHaveProperty("cost_basis");
    }
  });
});

describe("reconcileRcOutStage — R4a Deliverable 1 (batch_id alignment vs unresolved)", () => {
  it("a genuine value diff on the SAME batch_id is a diff (not masked by alignment)", () => {
    const input = {
      proposed: [pLeg("MARCH-26-BLK5", ["MAR-26-BLK5"], "D-11B", 20_000, 15_000, 5_000)],
      gsheetRcOut: [gRow("MAR-26-BLK5", ["MARCH-26-BLK5"], "D-11B", 6_000)],
      movementByDate: {},
      batchLookup: LOOKUP,
    };
    const { diffs } = reconcileRcOutStage(input);
    expect(diffs).toHaveLength(1);
    expect(diffs[0].naturalKey.batch).toBe("id-blk5");
    expect(diffs[0].sources.find((s) => s.source === "proposed")!.value).toBe(5_000);
    expect(diffs[0].sources.find((s) => s.source === "gsheet")!.value).toBe(6_000);
  });

  it("SAME id + SAME value → an agreement, NOT a diff", () => {
    const input = {
      proposed: [pLeg("MARCH-26-BLK5", ["MAR-26-BLK5"], "D-11B", 20_000, 15_000, 5_000)],
      gsheetRcOut: [gRow("MAR-26-BLK5", ["MARCH-26-BLK5"], "D-11B", 5_000)],
      movementByDate: {},
      batchLookup: LOOKUP,
    };
    const { diffs, agreements } = reconcileRcOutStage(input);
    expect(diffs).toHaveLength(0);
    expect(agreements).toBeGreaterThanOrEqual(1);
  });

  it("a batch that resolves to NO id → an unresolved_batch marker (not a silent single-source pass)", () => {
    const input = {
      proposed: [pLeg("JULY-26-BLK9", ["JUL-26-BLK9"], "D-9A", 20_000, 15_000, 5_000)],
      gsheetRcOut: [],
      movementByDate: {},
      batchLookup: LOOKUP, // JULY-26-BLK9 absent → 0 candidates
    };
    const { diffs, unresolvedBatches } = reconcileRcOutStage(input);
    expect(diffs).toHaveLength(0);
    expect(unresolvedBatches).toHaveLength(1);
    expect(unresolvedBatches[0].batch_code).toBe("JULY-26-BLK9");
    expect(unresolvedBatches[0].candidates).toHaveLength(0);
    expect(unresolvedBatches[0].sources).toContain("proposed");
    expect(unresolvedBatches[0].weight_kg).toBe(5_000);
  });

  it("a batch whose codes map to TWO different ids → unresolved (ambiguous), never aligned", () => {
    const ambiguous: BatchLookup = { "MARCH-26-BLK5": "id-a", "MAR-26-BLK5": "id-b" };
    const { batchId, candidates } = resolveBatchCandidates(
      "MARCH-26-BLK5",
      ["MAR-26-BLK5"],
      ambiguous,
    );
    expect(batchId).toBeNull();
    expect(candidates.sort()).toEqual(["id-a", "id-b"]);

    const { diffs, unresolvedBatches } = reconcileRcOutStage({
      proposed: [pLeg("MARCH-26-BLK5", ["MAR-26-BLK5"], "D-11B", 20_000, 15_000, 5_000)],
      gsheetRcOut: [],
      movementByDate: {},
      batchLookup: ambiguous,
    });
    expect(diffs).toHaveLength(0);
    expect(unresolvedBatches).toHaveLength(1);
    expect(unresolvedBatches[0].candidates.sort()).toEqual(["id-a", "id-b"]);
  });
});

describe("reconcileRcOutStage — R4a Deliverable 2 (FEED-block keying)", () => {
  /** A FEED proposed leg: whse in the feeding area, block_loc null, batch is the discriminator. */
  function pFeed(primary: string, fallbacks: string[], dayTotal: number): ProposedRow {
    const r = pLeg(primary, fallbacks, "FEEDING AREA", 0, 0, dayTotal);
    r.block_loc = null;
    r.is_feed = true;
    // no balance columns for feed → un-checkable, stays self-consistent
    r.strt_bal_kg = null;
    r.end_bal_kg = null;
    return r;
  }
  /** A FEED gsheet row (null block). */
  function gFeed(primary: string, fallbacks: string[], weight: number): RowDict {
    const r = gRow(primary, fallbacks, "", weight);
    r.block_loc = null;
    return r;
  }

  it("a FEED row (null block) now reconciles and produces a diff (June-10 FEED2)", () => {
    const { diffs } = reconcileRcOutStage({
      proposed: [pFeed("JUNE-26-FEED2", ["JUN-26-FEED2"], 5_930)],
      gsheetRcOut: [gFeed("JUN-26-FEED2", ["JUNE-26-FEED2"], 8_860)], // over-stated
      movementByDate: {},
      batchLookup: LOOKUP,
    });
    expect(diffs).toHaveLength(1);
    const d = diffs[0];
    expect(d.naturalKey.batch).toBe("id-feed2");
    expect(d.naturalKey.block_loc).toBeNull();
    expect(d.sources.find((s) => s.source === "proposed")!.value).toBe(5_930);
    expect(d.sources.find((s) => s.source === "gsheet")!.value).toBe(8_860);
  });

  it("a FEED row all sources agree on is an agreement, not a diff", () => {
    const { diffs, agreements } = reconcileRcOutStage({
      proposed: [pFeed("JUNE-26-FEED2", ["JUN-26-FEED2"], 5_930)],
      gsheetRcOut: [gFeed("JUN-26-FEED2", ["JUNE-26-FEED2"], 5_930)],
      movementByDate: {},
      batchLookup: LOOKUP,
    });
    expect(diffs).toHaveLength(0);
    expect(agreements).toBeGreaterThanOrEqual(1);
  });
});

describe("reconcileRcOutStage — R4b Deliverable 3 (pending vs held_overdue, proposed-span window)", () => {
  // R4b: the window is the PROPOSED extract's date span (± buffer). We anchor it with a
  // proposed+gsheet AGREEMENT on `anchorDate` (multi-source → carries no disposition) and put
  // the lone gsheet fact under test at `date`.
  function singleWitnessInput(date: string, runDate: string, anchorDate = date) {
    const g = gRow("MAR-26-BLK5", ["MARCH-26-BLK5"], "D-11B", 5_000);
    g.transaction_date = date;
    // window anchor: proposed leg + matching gsheet row on anchorDate (they agree → no case).
    const pa = pLeg("APRIL-26-BLK1", ["APR-26-BLK1"], "A-1A", 20_000, 10_000, 10_000);
    pa.transaction_date = anchorDate;
    pa.block_date = anchorDate;
    const ga = gRow("APR-26-BLK1", ["APRIL-26-BLK1"], "A-1A", 10_000);
    ga.transaction_date = anchorDate;
    return { proposed: [pa], gsheetRcOut: [ga, g], movementByDate: {}, batchLookup: LOOKUP, runDate };
  }

  it("a RECENT single-witness fact inside the proposed span is `pending` — telemetry only, NO case", () => {
    // fact date 2026-06-10, anchor 2026-06-10 → window covers it; age 1 (<= LAG_DAYS 2) → pending.
    const res = reconcileRcOutStage(singleWitnessInput("2026-06-10", "2026-06-11"));
    expect(res.pending).toBe(1);
    expect(res.heldOverdue).toHaveLength(0);
  });

  it("an OLD single-witness fact (inside the proposed span) is `held_overdue` — a case", () => {
    // fact date 2026-06-10, anchor 2026-06-10, runDate 2026-06-15 → age 5 (> LAG_DAYS) → overdue.
    const res = reconcileRcOutStage(singleWitnessInput("2026-06-10", "2026-06-15"));
    expect(res.pending).toBe(0);
    expect(res.heldOverdue).toHaveLength(1);
    const o = res.heldOverdue[0];
    expect(o.source).toBe("gsheet");
    expect(o.value).toBe(5_000);
    expect(o.ageDays).toBe(5);
    expect(o.naturalKey.batch).toBe("id-blk5");
  });

  it("a lone Sheet fact OUTSIDE the proposed span is neither pending nor a case (settled)", () => {
    // proposed only reaches 2026-07-05; the 06-10 Sheet fact is outside [07-03..07-07] → settled.
    const res = reconcileRcOutStage(singleWitnessInput("2026-06-10", "2026-07-08", "2026-07-05"));
    expect(res.pending).toBe(0);
    expect(res.heldOverdue).toHaveLength(0);
  });

  it("NO proposed extract this run → EMPTY window → a recent lone Sheet fact gets NO disposition (anti-clobber)", () => {
    // The load-bearing R4b guarantee: without a proposed second witness present, a lone recent
    // Sheet row is NEVER auto-acted-on — otherwise the cutover would re-create Sheet-wins/L-037.
    const g = gRow("MAR-26-BLK5", ["MARCH-26-BLK5"], "D-11B", 5_000);
    g.transaction_date = "2026-06-10";
    const res = reconcileRcOutStage({
      proposed: [],
      gsheetRcOut: [g],
      movementByDate: {},
      batchLookup: LOOKUP,
      runDate: "2026-06-11",
    });
    expect(res.pending).toBe(0);
    expect(res.heldOverdue).toHaveLength(0);
    expect(res.agreements).toBeGreaterThanOrEqual(1); // still counted as an agreement, just not acted on
  });

  it("without a runDate, single-witness facts get no disposition (back-compat)", () => {
    const g = gRow("MAR-26-BLK5", ["MARCH-26-BLK5"], "D-11B", 5_000);
    const res = reconcileRcOutStage({
      proposed: [],
      gsheetRcOut: [g],
      movementByDate: {},
      batchLookup: LOOKUP,
    });
    expect(res.pending).toBe(0);
    expect(res.heldOverdue).toHaveLength(0);
    expect(res.agreements).toBeGreaterThanOrEqual(1); // still counted as an agreement
  });
});

describe("bucketProposed — self-consistency + FEED keying", () => {
  it("marks a bucket self-inconsistent when a leg's STRT − END != DAY TOTAL (L-037 signature)", () => {
    // leg 2 DAY TOTAL = 31,745 but STRT−END = 54,950−34,018 = 20,932 → inconsistent bucket.
    const { records } = bucketProposed(
      [
        pLeg("MARCH-26-BLK5", ["MAR-26-BLK5"], "D-11B", 65_763, 54_950, 10_813),
        pLeg("MARCH-26-BLK5", ["MAR-26-BLK5"], "D-11B", 54_950, 34_018, 31_745),
      ],
      LOOKUP,
    );
    expect(records).toHaveLength(1);
    expect(records[0].selfConsistent).toBe(false);
    expect(records[0].selfConsistencyNote).toMatch(/cross-block cumulative/);
    // Still sums the stated weights (10,813 + 31,745).
    expect(records[0].fields.weight_kg).toBe(42_558);
    // Keyed by the RESOLVED batch_id.
    expect(records[0].naturalKey.batch).toBe("id-blk5");
  });

  it("a FEED block (null block_loc) now forms a fine record keyed on (date, batch_id, dest)", () => {
    const feed = pLeg("JUNE-26-FEED2", ["JUN-26-FEED2"], "IGNORED", 0, 0, 5_930);
    feed.block_loc = null;
    feed.is_feed = true;
    const { records } = bucketProposed([feed], LOOKUP);
    expect(records).toHaveLength(1);
    expect(records[0].naturalKey.batch).toBe("id-feed2");
    expect(records[0].naturalKey.block_loc).toBeNull();
    expect(records[0].fields.weight_kg).toBe(5_930);
  });

  it("an unresolvable batch produces an unresolved marker, no record", () => {
    const { records, unresolved } = bucketProposed(
      [pLeg("JULY-26-BLK9", [], "D-9A", 20_000, 15_000, 5_000)],
      LOOKUP,
    );
    expect(records).toHaveLength(0);
    expect(unresolved).toHaveLength(1);
    expect(unresolved[0].batch_code).toBe("JULY-26-BLK9");
  });
});

describe("resolveBatchCandidates", () => {
  it("resolves primary or a fallback to the one id", () => {
    expect(resolveBatchCandidates("MARCH-26-BLK5", ["MAR-26-BLK5"], LOOKUP).batchId).toBe("id-blk5");
    expect(resolveBatchCandidates("UNKNOWN", ["MAR-26-BLK5"], LOOKUP).batchId).toBe("id-blk5");
  });
  it("returns null + empty candidates when nothing matches", () => {
    const r = resolveBatchCandidates("NOPE", ["ALSO-NOPE"], LOOKUP);
    expect(r.batchId).toBeNull();
    expect(r.candidates).toHaveLength(0);
  });
});

describe("canonicalBatchKey (legacy alias helper — retained, superseded by batch_id resolution)", () => {
  it("aligns the two month-prefix conventions to the same key", () => {
    expect(canonicalBatchKey("MARCH-26-BLK5", ["MAR-26-BLK5"])).toBe("MAR-26-BLK5");
    expect(canonicalBatchKey("MAR-26-BLK5", ["MARCH-26-BLK5"])).toBe("MAR-26-BLK5");
  });

  it("returns null when no code is present", () => {
    expect(canonicalBatchKey(null, [])).toBeNull();
    expect(canonicalBatchKey("", ["  "])).toBeNull();
  });
});
