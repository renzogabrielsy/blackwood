/**
 * blockBalance.test.ts — the RB block-balance cross-check engine (reconcile/blockBalance.ts).
 *
 * Locks the two-level check (SYNC_RECONCILIATION_MODEL.md Refinement 2 / SYNC_VALIDITY_RULESET
 * B1–B4):
 *   - matching blocks → no diff
 *   - a per-block balance mismatch → a `balance` BlockDiff (B1)
 *   - a batch-identity mismatch → a `batch_mismatch` BlockDiff (B4), alias-aware (MARCH≡MAR)
 *   - the TWO-LEVEL case: per-block off but the grand total matches (offsetting errors) →
 *     B1 fires, B2 does NOT — the exact reason both levels exist
 *   - a grand-total mismatch → a `grand_total` BlockDiff (B2)
 *   - 2+ active batches on one block → a `multi_batch` BlockDiff (B3)
 *   - a negative computed balance alone → soft-warn, NO diff (O7); but a Sheet disagreement
 *     on that same block IS a diff
 *   - L-037 CONCEPTUAL: an over-stated (Sheet cumulative) block balance vs the correct
 *     computed balance → caught as a `balance` diff from a DIFFERENT angle than rc_out
 */
import { describe, it, expect } from "vitest";

import {
  reconcileBlockBalance,
  batchCodesMatch,
  type SheetBlock,
  type ComputedBlock,
} from "../../src/reconcile/blockBalance.js";

function sheet(loc: string, batch: string | null, bal: number | null): SheetBlock {
  return { block_loc: loc, batch_code: batch, balance_kg: bal };
}
function computed(
  loc: string,
  batch: string | null,
  bal: number | null,
  activeBatchCount = 1,
): ComputedBlock {
  return { block_loc: loc, batch_code: batch, balance_kg: bal, activeBatchCount };
}

const kinds = (r: ReturnType<typeof reconcileBlockBalance>) => r.blockDiffs.map((d) => d.kind);

describe("reconcileBlockBalance", () => {
  it("matching blocks → no diffs", () => {
    const s = [sheet("A-1A", "FEB-26-BLK3", 73_575), sheet("A-2A", "FEB-26-BLK11", 63_115)];
    const c = [computed("A-1A", "FEB-26-BLK3", 73_575), computed("A-2A", "FEB-26-BLK11", 63_115)];
    const r = reconcileBlockBalance(s, c, { sheetStatedTotalKg: 136_690 });
    expect(r.blockDiffs).toEqual([]);
    expect(r.totals.comparedBlocks).toBe(2);
    expect(r.totals.sheetSumKg).toBe(136_690);
    expect(r.totals.computedSumKg).toBe(136_690);
  });

  it("within tolerance (1 kg) → no diff", () => {
    const r = reconcileBlockBalance([sheet("A-1A", "X-26-BLK1", 1_000)], [computed("A-1A", "X-26-BLK1", 999)]);
    expect(r.blockDiffs).toEqual([]);
  });

  it("a per-block balance mismatch → a `balance` BlockDiff (B1)", () => {
    const r = reconcileBlockBalance(
      [sheet("A-1A", "X-26-BLK1", 73_575)],
      [computed("A-1A", "X-26-BLK1", 60_000)],
    );
    // A single block off by 13,575 kg also diverges the grand total (coarse backstop) — both fire.
    expect(kinds(r)).toContain("balance");
    const d = r.blockDiffs.find((x) => x.kind === "balance")!;
    expect(d.block_loc).toBe("A-1A");
    expect(d.sheet_kg).toBe(73_575);
    expect(d.computed_kg).toBe(60_000);
    expect(d.delta).toBe(13_575);
  });

  it("a batch-identity mismatch → a `batch_mismatch` BlockDiff (B4)", () => {
    const r = reconcileBlockBalance(
      [sheet("A-1A", "FEB-26-BLK3", 73_575)],
      [computed("A-1A", "MARCH-26-BLK4", 73_575)],
    );
    expect(kinds(r)).toEqual(["batch_mismatch"]);
    expect(r.blockDiffs[0].sheet_batch).toBe("FEB-26-BLK3");
    expect(r.blockDiffs[0].computed_batch).toBe("MARCH-26-BLK4");
  });

  it("batch identity is alias-aware — MARCH-…≡MAR-… → NO diff", () => {
    expect(batchCodesMatch("MARCH-26-BLK5", "MAR-26-BLK5")).toBe(true);
    expect(batchCodesMatch("SEPT-23-BLK4", "SEP-23-BLK4")).toBe(true);
    expect(batchCodesMatch("FEB-26-BLK3", "MARCH-26-BLK3")).toBe(false);
    const r = reconcileBlockBalance(
      [sheet("A-1A", "MARCH-26-BLK5", 73_575)],
      [computed("A-1A", "MAR-26-BLK5", 73_575)],
    );
    expect(r.blockDiffs).toEqual([]);
  });

  it("TWO-LEVEL: per-block off but the grand total MATCHES → B1 fires, B2 does NOT", () => {
    // 5,000 kg mis-attributed from A-2A to A-1A: each block is off by 5,000 but the total
    // is identical, so ONLY the per-block net catches it (the whole point of both levels).
    const s = [sheet("A-1A", "X-26-BLK1", 75_000), sheet("A-2A", "X-26-BLK2", 65_000)];
    const c = [computed("A-1A", "X-26-BLK1", 70_000), computed("A-2A", "X-26-BLK2", 70_000)];
    const r = reconcileBlockBalance(s, c, { sheetStatedTotalKg: 140_000 });
    expect(r.totals.sheetSumKg).toBe(140_000);
    expect(r.totals.computedSumKg).toBe(140_000);
    expect(r.totals.delta).toBe(0);
    expect(kinds(r).filter((k) => k === "grand_total")).toEqual([]); // B2 silent
    expect(kinds(r).filter((k) => k === "balance")).toEqual(["balance", "balance"]); // B1 caught both
  });

  it("a grand-total mismatch → a `grand_total` BlockDiff (B2)", () => {
    // A whole Sheet block the DB is missing → the totals diverge beyond the coarse tol.
    const s = [sheet("A-1A", "X-26-BLK1", 70_000), sheet("A-2A", "X-26-BLK2", 70_000)];
    const c = [computed("A-1A", "X-26-BLK1", 70_000)];
    const r = reconcileBlockBalance(s, c, { sheetStatedTotalKg: 140_000 });
    expect(kinds(r)).toContain("grand_total");
    const gt = r.blockDiffs.find((d) => d.kind === "grand_total")!;
    expect(gt.block_loc).toBeNull();
    expect(gt.sheet_kg).toBe(140_000);
    expect(gt.computed_kg).toBe(70_000);
    expect(gt.delta).toBe(70_000);
  });

  it("2+ active batches on one block → a `multi_batch` BlockDiff (B3)", () => {
    const r = reconcileBlockBalance(
      [sheet("A-1A", "X-26-BLK1", 70_000)],
      [computed("A-1A", "X-26-BLK1", 70_000, 2)],
    );
    expect(kinds(r)).toEqual(["multi_batch"]);
    expect(r.blockDiffs[0].active_batch_count).toBe(2);
  });

  it("a negative computed balance ALONE → soft-warn, NO diff (O7)", () => {
    // Sheet agrees with the negative computed balance (within tol) → no balance diff; the
    // negative is only recorded as a soft-warn.
    const r = reconcileBlockBalance(
      [sheet("A-1A", "X-26-BLK1", -500)],
      [computed("A-1A", "X-26-BLK1", -500)],
    );
    expect(r.blockDiffs).toEqual([]);
    expect(r.totals.negativeComputedBlocks).toEqual(["A-1A"]);
  });

  it("a negative computed balance that DISAGREES with the Sheet → still a `balance` diff", () => {
    const r = reconcileBlockBalance(
      [sheet("A-1A", "X-26-BLK1", 4_000)],
      [computed("A-1A", "X-26-BLK1", -500)],
    );
    expect(kinds(r)).toContain("balance");
    expect(r.totals.negativeComputedBlocks).toEqual(["A-1A"]);
  });

  it("block on the Sheet but not the app (and vice-versa) → a presence `balance` diff", () => {
    const r = reconcileBlockBalance(
      [sheet("A-1A", "X-26-BLK1", 70_000)],
      [computed("B-2B", "Y-26-BLK2", 50_000)],
    );
    expect(kinds(r).sort()).toEqual(["balance", "balance", "grand_total"].sort());
    const a1a = r.blockDiffs.find((d) => d.block_loc === "A-1A")!;
    expect(a1a.computed_kg).toBeNull();
    const b2b = r.blockDiffs.find((d) => d.block_loc === "B-2B")!;
    expect(b2b.sheet_kg).toBeNull();
  });

  it("L-037 CONCEPTUAL: an over-stated Sheet balance vs the correct computed → `balance` diff", () => {
    // L-037: the gsheet's cross-block cumulative over-stated rc_out by ~10,813 kg on the
    // BLK5 block, so its remaining BALANCE would read LOWER than the true DB balance. The
    // block-balance net catches that gap from a different angle than rc_out reconciliation.
    const trueBalance = 31_745;
    const overStatedSheet = trueBalance - 10_813; // Sheet balance depressed by the double-count
    const r = reconcileBlockBalance(
      [sheet("D-11B", "MARCH-26-BLK5", overStatedSheet)],
      [computed("D-11B", "MAR-26-BLK5", trueBalance)],
    );
    expect(kinds(r)).toContain("balance");
    const d = r.blockDiffs.find((x) => x.kind === "balance")!;
    expect(Math.abs(d.delta!)).toBe(10_813);
  });

  // ── The grand-total RESIDUAL (2026-08-12, Renzo's ask) ──────────────────────
  // `residual = delta − Σ(signed per-block gaps)`. Zero ⇒ every kilogram of the total gap is
  // accounted for by the blocks already flagged (consistent with Sheet lag, never asserted).
  // Non-zero ⇒ kg are missing that nothing above explains — the alarming shape.
  describe("grand-total residual", () => {
    const grand = (r: ReturnType<typeof reconcileBlockBalance>) =>
      r.blockDiffs.find((d) => d.kind === "grand_total");

    it("RESIDUAL ZERO — reproduces run dc944b54 (2026-08-12) to the kilogram", () => {
      // The real run: 4 flagged blocks, two of them the "Sheet has a batch, the app has no
      // active batch" PRESENCE shape (delta: null). 6,240 + 23,264 + 3,669 + 2,975 = 36,148.
      // Padding block carries the remaining inventory so both sides' totals are realistic.
      const pad = 10_286_727 - 42_726 - 70_201; // app total minus the two comparable blocks
      const s = [
        sheet("A-8A", "JULY-26-BLK1", 48_966),
        sheet("D-13D", "JULY-26-BLK2", 23_264), // app-side absent
        sheet("D-15B", "JULY-26-BLK9", 73_870),
        sheet("D-20B", "JULY-26-BLK12", 2_975), // app-side absent
        sheet("A-1A", "JULY-26-PAD", pad),
      ];
      const c = [
        computed("A-8A", "JULY-26-BLK1", 42_726),
        computed("D-15B", "JULY-26-BLK9", 70_201),
        computed("A-1A", "JULY-26-PAD", pad),
      ];
      const r = reconcileBlockBalance(s, c, { sheetStatedTotalKg: 10_322_875 });

      expect(r.totals.sheetSumKg).toBe(10_322_875);
      expect(r.totals.computedSumKg).toBe(10_286_727);
      expect(r.totals.delta).toBe(36_148);

      const gt = grand(r)!;
      expect(gt.delta).toBe(36_148);
      // The PRESENCE diffs (delta: null) must enter the sum — Σ(sheet−computed) not Σ(delta).
      expect(gt.accounted_block_count).toBe(4);
      expect(gt.accounted_block_kg).toBe(36_148);
      expect(gt.residual_kg).toBe(0);
      expect(gt.fully_accounted).toBe(true);
      // Wording: accounted for + CONSISTENT WITH lag, never "this is a lag issue".
      expect(gt.detail).toContain("All of it is accounted for by the 4 block(s)");
      expect(gt.detail).toContain("consistent with");
      expect(gt.detail).toContain("likely not urgent");
      expect(gt.detail).not.toContain("not explained");
    });

    it("summing `delta` instead of (sheet − computed) would have been WRONG here", () => {
      // Guards the exact trap: the two presence rows carry delta: null, so Σdelta = 9,909
      // and would fabricate a 26,239 kg residual out of nothing.
      const s = [
        sheet("A-8A", "B1", 48_966),
        sheet("D-13D", "B2", 23_264),
        sheet("D-15B", "B9", 73_870),
        sheet("D-20B", "B12", 2_975),
      ];
      const c = [computed("A-8A", "B1", 42_726), computed("D-15B", "B9", 70_201)];
      const r = reconcileBlockBalance(s, c);
      const sumOfDeltaField = r.blockDiffs
        .filter((d) => d.kind === "balance")
        .reduce((n, d) => n + (d.delta ?? 0), 0);
      expect(sumOfDeltaField).toBe(9_909); // the naive sum
      expect(grand(r)!.accounted_block_kg).toBe(36_148); // the correct one
      expect(grand(r)!.residual_kg).toBe(0);
    });

    it("RESIDUAL NON-ZERO — names the unexplained kg and stays unexplained", () => {
      // ONE block flagged at 5,000 kg, plus 200 blocks each drifting 75 kg — under the fine
      // net, so none of them is flagged. Total gap 20,000; only 5,000 is accounted for, so
      // 15,000 kg is real and nothing above points at it. (This diffuse-drift-under-the-net
      // shape is what an unexplained residual actually looks like in the field.)
      const filler = Array.from({ length: 200 }, (_, i) => `B-${i + 1}A`);
      const s = [
        sheet("A-1A", "B1", 75_000),
        ...filler.map((loc) => sheet(loc, "B1", 1_075)),
      ];
      const c = [
        computed("A-1A", "B1", 70_000),
        ...filler.map((loc) => computed(loc, "B1", 1_000)),
      ];
      const r = reconcileBlockBalance(s, c, { blockBalanceTolKg: 100 });
      expect(r.blockDiffs.filter((d) => d.kind === "balance").length).toBe(1);
      const gt = grand(r)!;
      expect(gt.delta).toBe(20_000);
      expect(gt.accounted_block_count).toBe(1);
      expect(gt.accounted_block_kg).toBe(5_000);
      expect(gt.residual_kg).toBe(15_000);
      expect(gt.fully_accounted).toBe(false);
      expect(gt.detail).toContain("15,000 kg NOT explained by any flagged block");
      expect(gt.detail).not.toContain("consistent with");
    });

    it("ZERO BLOCKS flagged but the grand total fires → the WHOLE gap is unexplained", () => {
      // The most alarming shape: every block agrees within the fine net, yet the totals do
      // not. Nothing above says where the kilograms went. Built as a sub-per-block-tolerance
      // drift spread across many blocks (a one-sided block would be a presence diff instead).
      const many = Array.from({ length: 200 }, (_, i) => `B-${i + 1}A`);
      const s2 = many.map((loc) => sheet(loc, "B1", 1_000));
      const c2 = many.map((loc) => computed(loc, "B1", 999)); // 1 kg each → within B1's tol
      const r = reconcileBlockBalance(s2, c2);
      expect(r.blockDiffs.filter((d) => d.kind === "balance")).toEqual([]); // B1 silent
      const gt = grand(r)!;
      expect(gt.delta).toBe(200); // 200 blocks × 1 kg, past the coarse 100 kg net
      expect(gt.accounted_block_count).toBe(0);
      expect(gt.accounted_block_kg).toBe(0);
      expect(gt.residual_kg).toBe(200); // the WHOLE gap
      expect(gt.fully_accounted).toBe(false);
      expect(gt.detail).toContain("NO individual block was flagged");
      expect(gt.detail).toContain("whole 200 kg is unexplained");
    });

    it("OPPOSITE directions CANCEL — they must not add", () => {
      // +5,000 on one block and −5,000 on another net to zero, exactly as they do in the
      // grand total. A third (presence) block supplies the +20,000 that makes B2 fire.
      const s = [
        sheet("A-1A", "B1", 75_000),
        sheet("A-2A", "B2", 65_000),
        sheet("A-3A", "B3", 20_000), // app-side absent
      ];
      const c = [computed("A-1A", "B1", 70_000), computed("A-2A", "B2", 70_000)];
      const r = reconcileBlockBalance(s, c);
      const balances = r.blockDiffs.filter((d) => d.kind === "balance");
      expect(balances.length).toBe(3);
      expect(balances.find((d) => d.block_loc === "A-1A")!.delta).toBe(5_000);
      expect(balances.find((d) => d.block_loc === "A-2A")!.delta).toBe(-5_000);
      const gt = grand(r)!;
      expect(gt.delta).toBe(20_000);
      // 5,000 − 5,000 + 20,000 = 20,000. Summing MAGNITUDES would give 30,000 and a bogus
      // −10,000 residual.
      expect(gt.accounted_block_kg).toBe(20_000);
      expect(gt.residual_kg).toBe(0);
      expect(gt.fully_accounted).toBe(true);
    });

    it("a batch_mismatch/multi_batch on a flagged block never DOUBLE-COUNTS its kg", () => {
      // A-1A disagrees on BOTH balance and batch, and the app stacks 2 batches on it → three
      // diffs for one block. Only its single `balance` diff may contribute.
      const s = [sheet("A-1A", "FEB-26-BLK3", 75_000), sheet("A-2A", "B2", 20_000)];
      const c = [computed("A-1A", "MARCH-26-BLK4", 70_000, 2), computed("A-2A", "B2", 20_000)];
      const r = reconcileBlockBalance(s, c);
      expect(kinds(r).sort()).toEqual(
        ["balance", "batch_mismatch", "grand_total", "multi_batch"].sort(),
      );
      const gt = grand(r)!;
      expect(gt.delta).toBe(5_000);
      expect(gt.accounted_block_count).toBe(1); // NOT 3
      expect(gt.accounted_block_kg).toBe(5_000); // NOT 15,000
      expect(gt.residual_kg).toBe(0);
      expect(gt.fully_accounted).toBe(true);
    });

    it("the residual uses the SAME tolerance as the grand-total check, not a second one", () => {
      // Residual exactly AT the tolerance counts as zero (the check fires strictly ABOVE it).
      const s = [sheet("A-1A", "B1", 75_000), sheet("A-2A", "B2", 20_100)];
      const c = [computed("A-1A", "B1", 70_000), computed("A-2A", "B2", 20_000)];
      // A-2A's 100 kg gap is flagged per-block too (tol 1 kg), so widen the fine net past it.
      const r = reconcileBlockBalance(s, c, { blockBalanceTolKg: 1_000 });
      const gt = grand(r)!;
      expect(gt.delta).toBe(5_100);
      expect(gt.accounted_block_kg).toBe(5_000);
      expect(gt.residual_kg).toBe(100); // == grandTotalTolKg
      expect(gt.fully_accounted).toBe(true);

      const r2 = reconcileBlockBalance(
        [sheet("A-1A", "B1", 75_000), sheet("A-2A", "B2", 20_101)],
        c,
        { blockBalanceTolKg: 1_000 },
      );
      expect(grand(r2)!.residual_kg).toBe(101);
      expect(grand(r2)!.fully_accounted).toBe(false);
    });

    it("a grand total BELOW tolerance emits no diff at all (unchanged)", () => {
      const r = reconcileBlockBalance(
        [sheet("A-1A", "B1", 70_050)],
        [computed("A-1A", "B1", 70_000)],
        { blockBalanceTolKg: 1_000 },
      );
      expect(r.blockDiffs).toEqual([]);
      expect(grand(r)).toBeUndefined();
    });
  });

  it("block_loc normalization — casing/whitespace aligns both sides", () => {
    const r = reconcileBlockBalance(
      [sheet("  a-1a ", "X-26-BLK1", 70_000)],
      [computed("A-1A", "X-26-BLK1", 70_000)],
    );
    expect(r.blockDiffs).toEqual([]);
    expect(r.totals.comparedBlocks).toBe(1);
  });
});
