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

// ---------------------------------------------------------------------------
// R4a — FEED (null block) fine records + single-witness disposition
// ---------------------------------------------------------------------------

/** A FEED SourceRecord: block_loc null, batch is the discriminator (Deliverable 2). */
function feedRec(source: "proposed" | "gsheet", date: string, batch: string, weight: number): SourceRecord {
  return {
    source,
    naturalKey: { transaction_date: date, batch, block_loc: null, destination: "MAIN" },
    fields: { weight_kg: weight },
    selfConsistent: true,
    provenance: `${source} ${date} ${batch} (FEED)`,
  };
}

describe("reconcileRcOut — FEED (null block) fine records reconcile", () => {
  it("two null-block records for the same batch align and diff on weight", () => {
    const { diffs } = reconcileRcOut([
      feedRec("proposed", D, "id-feed2", 5_930),
      feedRec("gsheet", D, "id-feed2", 8_860),
    ]);
    expect(diffs).toHaveLength(1);
    expect(diffs[0].naturalKey.block_loc).toBeNull();
    expect(diffs[0].naturalKey.batch).toBe("id-feed2");
  });

  it("agreeing null-block records are a clean agreement", () => {
    const { diffs, agreements } = reconcileRcOut([
      feedRec("proposed", D, "id-feed2", 5_930),
      feedRec("gsheet", D, "id-feed2", 5_930),
    ]);
    expect(diffs).toHaveLength(0);
    expect(agreements.some((a) => a.naturalKey.block_loc === null && !a.singleSource)).toBe(true);
  });
});

describe("reconcileRcOut — single-witness disposition (R4b proposed-span window)", () => {
  // R4b: the actionable window is the PROPOSED extract's date span (± buffer). To exercise a
  // single-witness gsheet fact we anchor the window with a proposed+gsheet AGREEMENT on a
  // date (multi-source → itself carries NO disposition), then vary the lone gsheet fact.
  function anchor(date: string) {
    return [proposed(date, "id-anchor", "A-1A", 9_000), gsheet(date, "id-anchor", "A-1A", 9_000)];
  }
  const soleGsheet = (date: string, w = 5_000) => gsheet(date, "id-blk5", "D-11B", w);
  const findBlk5 = (agreements: ReturnType<typeof reconcileRcOut>["agreements"]) =>
    agreements.find((x) => x.field === "weight_kg" && x.naturalKey.batch === "id-blk5")!;

  it("no runDate → single-source agreement has no disposition (back-compat)", () => {
    const { agreements } = reconcileRcOut([soleGsheet(D)]);
    const a = findBlk5(agreements);
    expect(a.singleSource).toBe(true);
    expect(a.disposition).toBeUndefined();
  });

  it("no proposed extract this run → EMPTY window → recent lone Sheet fact gets NO disposition (anti-clobber)", () => {
    // The load-bearing R4b rule: a lone recent Sheet witness with no proposed second witness
    // present is NEVER auto-acted-on (that would be Sheet-wins under a new name / L-037).
    const { agreements } = reconcileRcOut([soleGsheet("2026-06-10")], { runDate: "2026-06-11" });
    expect(findBlk5(agreements).disposition).toBeUndefined();
  });

  it("recent single-witness INSIDE the proposed span → pending (age <= LAG_DAYS)", () => {
    const { agreements } = reconcileRcOut([...anchor("2026-06-10"), soleGsheet("2026-06-10")], {
      runDate: "2026-06-11",
    });
    const a = findBlk5(agreements);
    expect(a.disposition).toBe("pending");
    expect(a.ageDays).toBe(1);
  });

  it("old single-witness INSIDE the proposed span → held_overdue (LAG_DAYS < age)", () => {
    const { agreements } = reconcileRcOut([...anchor("2026-06-10"), soleGsheet("2026-06-10")], {
      runDate: "2026-06-15",
    });
    const a = findBlk5(agreements);
    expect(a.disposition).toBe("held_overdue");
    expect(a.ageDays).toBe(5);
  });

  it("a lone Sheet fact OUTSIDE the proposed span → settled, no disposition (window follows proposed, not a fixed lookback)", () => {
    // Proposed only reaches 2026-07-05; the old 06-10 Sheet row is outside [07-03..07-07] →
    // settled/untouched even though it is only 28 days old (R4a's fixed 14-day would also have
    // settled it, but R4b settles it because it's outside the PROPOSED span, not by a day count).
    const { agreements } = reconcileRcOut([...anchor("2026-07-05"), soleGsheet("2026-06-10")], {
      runDate: "2026-07-08",
    });
    expect(findBlk5(agreements).disposition).toBeUndefined();
  });

  it("a lone Sheet fact just past the proposed max but inside the buffer → still actionable (pending)", () => {
    // proposed max = 06-10; fact on 06-11 (today) is +1 day, within the 2-day buffer → pending.
    const { agreements } = reconcileRcOut([...anchor("2026-06-10"), soleGsheet("2026-06-11")], {
      runDate: "2026-06-11",
    });
    expect(findBlk5(agreements).disposition).toBe("pending");
  });

  it("multi-source agreements never carry a disposition", () => {
    const { agreements } = reconcileRcOut(
      [gsheet("2026-06-10", "id-blk5", "D-11B", 5_000), proposed("2026-06-10", "id-blk5", "D-11B", 5_000)],
      { runDate: "2026-06-15" },
    );
    const a = agreements.find((x) => x.field === "weight_kg" && !x.singleSource)!;
    expect(a.disposition).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Second-pass attribution matcher — the real 2026-07-11 forensics finding: 47
// `single_source_overdue` cases that were really ~20 pairs of the SAME physical
// feeding seen under two different batch/block attributions (proposed derives its
// batch from block_date+block_no; the Sheet carries an operator-typed code).
// ---------------------------------------------------------------------------

describe("reconcileRcOut — second-pass attribution matcher", () => {
  it("pair found (weight agrees, batch+block differ) → ONE attribution_diff, no overdue pair for either side", () => {
    // The real 2026-05-04 case: proposed 5,943 kg @ "16A NEAR PATHWAY" (NOV-24-BLK10) vs
    // gsheet 5,943 kg @ "PCA-16C" (MARCH-26-SUNDRY4) — same kilograms, different attribution.
    const day = "2026-05-04";
    const { agreements, attributionDiffs, diffs } = reconcileRcOut(
      [
        proposed(day, "NOV-24-BLK10", "16A NEAR PATHWAY", 5_943),
        gsheet(day, "MARCH-26-SUNDRY4", "PCA-16C", 5_943),
      ],
      { runDate: "2026-05-09" }, // age 5 days > LAG_DAYS(2) → would be held_overdue for BOTH
    );

    expect(diffs).toHaveLength(0); // different fine keys — never a source_diff
    expect(attributionDiffs).toHaveLength(1);

    const pair = attributionDiffs[0];
    expect(pair.transaction_date).toBe(day);
    expect(pair.destination).toBe("MAIN");
    expect(pair.weight_kg).toBe(5_943); // both sides agree exactly → average = itself
    expect(pair.proposed).toMatchObject({
      source: "proposed",
      batch: "NOV-24-BLK10",
      block_loc: "16A NEAR PATHWAY",
      weight_kg: 5_943,
    });
    expect(pair.gsheet).toMatchObject({
      source: "gsheet",
      batch: "MARCH-26-SUNDRY4",
      block_loc: "PCA-16C",
      weight_kg: 5_943,
    });

    // The pair REPLACES the two single-witness facts — neither surfaces as a standalone
    // pending/held_overdue Agreement anymore.
    const weightAgreements = agreements.filter((a) => a.field === "weight_kg");
    expect(weightAgreements).toHaveLength(0);
  });

  it("weight mismatch (digit transposition) → NO pairing; both stay lone witnesses", () => {
    // The real 2026-05-11 case: 3,692 vs 3,962 kg — a genuine transposition, not the same
    // feeding. Must NOT pair; both keep their held_overdue disposition untouched.
    const day = "2026-05-11";
    const { agreements, attributionDiffs } = reconcileRcOut(
      [
        proposed(day, "id-a", "BLK-A", 3_692),
        gsheet(day, "id-b", "BLK-B", 3_962),
      ],
      { runDate: "2026-05-16" }, // age 5 days > LAG_DAYS
    );

    expect(attributionDiffs).toHaveLength(0);
    const weightAgreements = agreements.filter((a) => a.field === "weight_kg");
    expect(weightAgreements).toHaveLength(2);
    for (const a of weightAgreements) {
      expect(a.singleSource).toBe(true);
      expect(a.disposition).toBe("held_overdue");
    }
  });

  it("multiple same-weight candidates on one date → deterministic 1:1 pairing regardless of input order", () => {
    const day = "2026-05-20";
    const opts = { runDate: "2026-05-25" };
    const buildRecords = () => [
      // Deliberately shuffled / interleaved input order.
      gsheet(day, "id-g2", "BLK-G2", 5_000),
      proposed(day, "id-p2", "BLK-P2", 5_000),
      gsheet(day, "id-g1", "BLK-G1", 5_000),
      proposed(day, "id-p1", "BLK-P1", 5_000),
    ];

    const { attributionDiffs } = reconcileRcOut(buildRecords(), opts);
    expect(attributionDiffs).toHaveLength(2);
    // Deterministic: sorted-by-fine-key order pairs id-p1<->id-g1, id-p2<->id-g2.
    const byProposedBatch = (b: string) => attributionDiffs.find((d) => d.proposed.batch === b)!;
    expect(byProposedBatch("id-p1").gsheet.batch).toBe("id-g1");
    expect(byProposedBatch("id-p2").gsheet.batch).toBe("id-g2");

    // Re-run with the array reversed — same pairing (order-independent).
    const reversed = buildRecords().reverse();
    const { attributionDiffs: attributionDiffs2 } = reconcileRcOut(reversed, opts);
    expect(attributionDiffs2).toHaveLength(2);
    const byProposedBatch2 = (b: string) => attributionDiffs2.find((d) => d.proposed.batch === b)!;
    expect(byProposedBatch2("id-p1").gsheet.batch).toBe("id-g1");
    expect(byProposedBatch2("id-p2").gsheet.batch).toBe("id-g2");
  });

  it("tolerance boundary: exactly at weightTolKg pairs; just past it does not", () => {
    const day = "2026-05-30";
    const opts = { runDate: "2026-06-04" };

    const atBoundary = reconcileRcOut(
      [proposed(day, "id-x1", "BLK-X1", 4_000), gsheet(day, "id-y1", "BLK-Y1", 4_001)],
      opts,
    );
    expect(atBoundary.attributionDiffs).toHaveLength(1); // diff = 1 kg == default weightTolKg

    const pastBoundary = reconcileRcOut(
      [proposed(day, "id-x2", "BLK-X2", 4_000), gsheet(day, "id-y2", "BLK-Y2", 4_001.5)],
      opts,
    );
    expect(pastBoundary.attributionDiffs).toHaveLength(0); // diff = 1.5 kg > default weightTolKg
    const weightAgreements = pastBoundary.agreements.filter((a) => a.field === "weight_kg");
    expect(weightAgreements).toHaveLength(2);
  });

  it("does not pair across different destinations, even with matching weight + date", () => {
    const day = "2026-06-01";
    const mainRec = proposed(day, "id-m1", "BLK-M1", 2_000);
    const sundryRec: SourceRecord = {
      ...gsheet(day, "id-m2", "BLK-M2", 2_000),
      naturalKey: { transaction_date: day, batch: "id-m2", block_loc: "BLK-M2", destination: "SUNDRY" },
    };
    const { attributionDiffs } = reconcileRcOut([mainRec, sundryRec], { runDate: "2026-06-06" });
    expect(attributionDiffs).toHaveLength(0);
  });

  it("only pairs pending/held_overdue candidates — a settled (outside-window) fact never pairs", () => {
    // Anchor the proposed window at 2026-07-05; a lone gsheet fact from 2026-06-10 is
    // OUTSIDE the window (settled) and must never be swept into a pairing even if a
    // same-weight proposed fact exists elsewhere in-window.
    const { attributionDiffs } = reconcileRcOut(
      [
        proposed("2026-07-05", "id-anchor", "A-1A", 9_000),
        gsheet("2026-07-05", "id-anchor", "A-1A", 9_000),
        gsheet("2026-06-10", "id-old", "OLD-BLK", 5_943),
        proposed("2026-07-05", "id-new", "NEW-BLK", 5_943),
      ],
      { runDate: "2026-07-08" },
    );
    expect(attributionDiffs).toHaveLength(0);
  });
});
