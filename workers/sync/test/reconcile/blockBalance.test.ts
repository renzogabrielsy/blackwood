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

  it("block_loc normalization — casing/whitespace aligns both sides", () => {
    const r = reconcileBlockBalance(
      [sheet("  a-1a ", "X-26-BLK1", 70_000)],
      [computed("A-1A", "X-26-BLK1", 70_000)],
    );
    expect(r.blockDiffs).toEqual([]);
    expect(r.totals.comparedBlocks).toBe(1);
  });
});
