/**
 * rcOut.test.ts — R1 reconciliation engine tests, anchored on the L-037 incident.
 *
 * L-037 ground truth (real production data, 2026-06-10):
 *   MARCH-26-BLK5 @ D-11B fed in TWO legs — 10,813 (STRT 65,763→END 54,950) and
 *   20,932 (STRT 54,950→END 34,018). TRUE block/day total = 31,745. The Google Sheet
 *   carried a cross-block cumulative for leg 2 (31,745 = 65,763−34,018), so the gsheet
 *   block/day total came out 10,813+31,745 = 42,558. Same signature on JUNE-26-FEED2:
 *   proposed 2,930+3,000 = 5,930 vs gsheet 2,930+5,930 = 8,860.
 *
 * The reconciler must: raise exactly the BLK5 + FEED2 weight diffs, recommend `proposed`
 * on each (self-consistent, and its whole-day total corroborates the RC MOVEMENT day
 * total; gsheet is the uncorroborated outlier), and leave a fully-agreeing batch as a
 * clean Agreement with NO diff. Advisory only — it never picks the winner.
 *
 * Ground truth: SYNC_RECONCILIATION_MODEL.md (R1) + LEARNING_LEDGER.md L-037.
 */
import { describe, it, expect } from "vitest";

import { reconcileRcOut, proposedLegsSelfConsistent } from "../../src/reconcile/rcOut.js";
import type { SourceRecord } from "../../src/reconcile/types.js";

// ---------------------------------------------------------------------------
// SourceRecord builders
// ---------------------------------------------------------------------------

function proposed(
  date: string,
  batch: string,
  block: string,
  weight: number,
  opts: { selfConsistent?: boolean; note?: string } = {},
): SourceRecord {
  return {
    source: "proposed",
    naturalKey: { transaction_date: date, batch, block_loc: block, destination: "MAIN" },
    fields: { weight_kg: weight },
    selfConsistent: opts.selfConsistent ?? true,
    selfConsistencyNote: opts.note,
    provenance: `PROPOSED DAILY REPORT ${date} ${batch} @ ${block}`,
  };
}

function gsheet(date: string, batch: string, block: string, weight: number): SourceRecord {
  return {
    source: "gsheet",
    naturalKey: { transaction_date: date, batch, block_loc: block, destination: "MAIN" },
    fields: { weight_kg: weight },
    selfConsistent: true, // gsheet has no balance columns → cannot fail its own check
    provenance: `Google Sheet RC OUT ${date} ${batch} @ ${block}`,
  };
}

function movement(date: string, total: number): SourceRecord {
  return {
    source: "movement",
    naturalKey: { transaction_date: date, batch: null, block_loc: null, destination: null },
    fields: { raw_charcoal_fed_kls: total },
    selfConsistent: true,
    provenance: `RC MOVEMENT ${date} day total`,
  };
}

const D = "2026-06-10";

/** The real L-037 day: two over-stated batches + one clean batch, with a corroborating movement total. */
function l037Records(): SourceRecord[] {
  return [
    // MARCH-26-BLK5 @ D-11B — proposed 31,745 (10,813+20,932) vs gsheet 42,558 (10,813+31,745).
    proposed(D, "MARCH-26-BLK5", "D-11B", 31_745),
    gsheet(D, "MARCH-26-BLK5", "D-11B", 42_558),
    // JUNE-26-FEED2 — proposed 5,930 (2,930+3,000) vs gsheet 8,860 (2,930+5,930).
    proposed(D, "JUNE-26-FEED2", "D-FEED2", 5_930),
    gsheet(D, "JUNE-26-FEED2", "D-FEED2", 8_860),
    // APRIL-26-BLK1 @ A-1A — a clean single-leg batch all sources agree on.
    proposed(D, "APRIL-26-BLK1", "A-1A", 10_000),
    gsheet(D, "APRIL-26-BLK1", "A-1A", 10_000),
    // RC MOVEMENT day total = sum of the PROPOSED picture = 31,745 + 5,930 + 10,000.
    movement(D, 47_675),
  ];
}

describe("reconcileRcOut — L-037 anchor", () => {
  it("raises exactly the BLK5 + FEED2 weight diffs, recommends proposed on each", () => {
    const { diffs } = reconcileRcOut(l037Records());

    expect(diffs).toHaveLength(2);
    for (const d of diffs) {
      expect(d.field).toBe("weight_kg");
      expect(d.table).toBe("rc_out");
      // Never auto-picked — but the advisory hint points at proposed.
      expect(d.recommended?.source).toBe("proposed");
      expect(d.recommended?.why).toMatch(/RC MOVEMENT day total/);
      expect(d.recommended?.why).toMatch(/gsheet .*uncorroborated/);
      // proposed carries the movement corroboration; gsheet is the outlier.
      const prop = d.sources.find((s) => s.source === "proposed")!;
      const sheet = d.sources.find((s) => s.source === "gsheet")!;
      expect(prop.corroboratedBy).toContain("movement");
      expect(sheet.corroboratedBy).toHaveLength(0);
    }
  });

  it("carries the exact competing values per batch", () => {
    const { diffs } = reconcileRcOut(l037Records());
    const blk5 = diffs.find((d) => d.naturalKey.batch === "MARCH-26-BLK5")!;
    const feed2 = diffs.find((d) => d.naturalKey.batch === "JUNE-26-FEED2")!;

    expect(blk5.sources.find((s) => s.source === "proposed")!.value).toBe(31_745);
    expect(blk5.sources.find((s) => s.source === "gsheet")!.value).toBe(42_558);
    expect(feed2.sources.find((s) => s.source === "proposed")!.value).toBe(5_930);
    expect(feed2.sources.find((s) => s.source === "gsheet")!.value).toBe(8_860);
  });

  it("leaves the fully-agreeing batch as a clean Agreement with NO diff", () => {
    const { agreements, diffs } = reconcileRcOut(l037Records());

    const clean = agreements.find(
      (a) => a.naturalKey.batch === "APRIL-26-BLK1" && a.field === "weight_kg",
    );
    expect(clean).toBeDefined();
    expect(clean!.value).toBe(10_000);
    expect(clean!.singleSource).toBe(false);
    expect(clean!.sources.sort()).toEqual(["gsheet", "proposed"]);
    // The agreeing batch is NOT among the diffs.
    expect(diffs.some((d) => d.naturalKey.batch === "APRIL-26-BLK1")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe("reconcileRcOut — edges", () => {
  it("single-source field → Agreement tagged single-source, no diff", () => {
    const { agreements, diffs } = reconcileRcOut([
      proposed("2026-06-11", "MAY-26-BLK7", "B-2A", 12_000),
      // no gsheet, no movement
    ]);
    expect(diffs).toHaveLength(0);
    const a = agreements.find((x) => x.field === "weight_kg")!;
    expect(a.singleSource).toBe(true);
    expect(a.sources).toEqual(["proposed"]);
    expect(a.value).toBe(12_000);
  });

  it("within-tolerance near-equal → Agreement (not a diff)", () => {
    const { agreements, diffs } = reconcileRcOut([
      proposed("2026-06-11", "MAY-26-BLK7", "B-2A", 10_000),
      gsheet("2026-06-11", "MAY-26-BLK7", "B-2A", 10_000.5), // within 1 kg
    ]);
    expect(diffs).toHaveLength(0);
    const a = agreements.find((x) => x.field === "weight_kg")!;
    expect(a.singleSource).toBe(false);
    expect(a.sources.sort()).toEqual(["gsheet", "proposed"]);
  });

  it("a proposed record with selfConsistent:false is reflected in the diff and never recommended", () => {
    const day = "2026-06-12";
    // proposed fails its OWN balance check (selfConsistent:false) AND its rollup does not
    // match movement; gsheet is self-consistent and its rollup DOES match movement.
    const { diffs } = reconcileRcOut([
      proposed(day, "FEB-26-BLK28", "D-8A", 8_860, {
        selfConsistent: false,
        note: "STRT-END != DAY TOTAL (L-037)",
      }),
      gsheet(day, "FEB-26-BLK28", "D-8A", 5_930),
      movement(day, 5_930), // corroborates gsheet's picture
    ]);

    expect(diffs).toHaveLength(1);
    const d = diffs[0];
    const prop = d.sources.find((s) => s.source === "proposed")!;
    expect(prop.selfConsistent).toBe(false);
    // The self-inconsistent source is NOT the pick; the self-consistent + corroborated one is.
    expect(d.recommended?.source).toBe("gsheet");
  });

  it("suppresses the recommendation when the corroborated source fails its self-check", () => {
    const day = "2026-06-13";
    // proposed is corroborated by movement BUT selfConsistent:false → disqualified.
    // gsheet is self-consistent BUT uncorroborated → disqualified. No single qualifier → no hint.
    const { diffs } = reconcileRcOut([
      proposed(day, "FEB-26-BLK28", "D-8A", 5_930, { selfConsistent: false }),
      gsheet(day, "FEB-26-BLK28", "D-8A", 8_860),
      movement(day, 5_930), // matches proposed's rollup
    ]);
    expect(diffs).toHaveLength(1);
    expect(diffs[0].recommended).toBeUndefined();
  });

  it("with no movement witness, a two-source weight disagreement still diffs but gets no rollup hint", () => {
    const { diffs } = reconcileRcOut([
      proposed("2026-06-14", "MAR-26-BLK5", "D-11B", 31_745),
      gsheet("2026-06-14", "MAR-26-BLK5", "D-11B", 42_558),
    ]);
    expect(diffs).toHaveLength(1);
    const prop = diffs[0].sources.find((s) => s.source === "proposed")!;
    expect(prop.corroboratedBy).toHaveLength(0);
    // Neither is corroborated ⇒ no single qualifier ⇒ no recommendation.
    expect(diffs[0].recommended).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// proposedLegsSelfConsistent helper (L-037 balance rule, mirrors classify.ts::balanceIntegrity)
// ---------------------------------------------------------------------------

describe("proposedLegsSelfConsistent", () => {
  it("passes when every leg's STRT − END == DAY TOTAL", () => {
    const r = proposedLegsSelfConsistent([
      { strt_bal_kg: 65_763, end_bal_kg: 54_950, day_total_kg: 10_813 },
      { strt_bal_kg: 54_950, end_bal_kg: 34_018, day_total_kg: 20_932 },
    ]);
    expect(r.selfConsistent).toBe(true);
  });

  it("fails when a leg carries a cross-block cumulative (the L-037 signature)", () => {
    // leg 2 DAY TOTAL = 31,745 but STRT−END = 54,950−34,018 = 20,932 → inconsistent.
    const r = proposedLegsSelfConsistent([
      { strt_bal_kg: 65_763, end_bal_kg: 54_950, day_total_kg: 10_813 },
      { strt_bal_kg: 54_950, end_bal_kg: 34_018, day_total_kg: 31_745 },
    ]);
    expect(r.selfConsistent).toBe(false);
    expect(r.note).toMatch(/cross-block cumulative/);
  });

  it("never fails an un-checkable leg (a blank STRT/END)", () => {
    const r = proposedLegsSelfConsistent([
      { strt_bal_kg: null, end_bal_kg: null, day_total_kg: 5_930 },
    ]);
    expect(r.selfConsistent).toBe(true);
  });
});
