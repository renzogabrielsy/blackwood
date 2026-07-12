/**
 * settlement.test.ts — the DATE-SETTLEMENT LEDGER pure core (2026-07-12).
 * Ground truth: src/workflows/settlement.ts. See workers/sync/src/reconcile/CONTEXT.md
 * and specs/rc_out.md "§ Settlement" for the criterion + why it lives in orchestration.
 */
import { describe, it, expect } from "vitest";

import {
  computeQualifyingSettlements,
  SETTLEMENT_TOLERANCE_KG,
} from "../../src/workflows/settlement.js";
import type { RcOutSums } from "../../src/reports/rc_out/reconcile.js";

describe("computeQualifyingSettlements — settle criterion", () => {
  it("settles when DB>0 AND movement present AND |diff| <= tolerance", () => {
    const dbSums: RcOutSums = { "2026-05-15": 28087 };
    const movement = { "2026-05-15": 28087 };
    const out = computeQualifyingSettlements(dbSums, movement, new Set());
    expect(out).toEqual([{ transaction_date: "2026-05-15", db_sum_kg: 28087, movement_kg: 28087 }]);
  });

  it("settles at the exact tolerance boundary (diff == 50)", () => {
    const dbSums: RcOutSums = { "2026-06-01": 10050 };
    const movement = { "2026-06-01": 10000 };
    const out = computeQualifyingSettlements(dbSums, movement, new Set());
    expect(out).toHaveLength(1);
    expect(out[0].db_sum_kg).toBe(10050);
  });

  it("does NOT settle just past the tolerance boundary (diff == 50 + epsilon)", () => {
    const dbSums: RcOutSums = { "2026-06-01": 10050.01 };
    const movement = { "2026-06-01": 10000 };
    const out = computeQualifyingSettlements(dbSums, movement, new Set());
    expect(out).toHaveLength(0);
  });

  it("does NOT settle when DB sum is empty/zero (no rc_out rows that date)", () => {
    const dbSums: RcOutSums = { "2026-05-16": 0 };
    const movement = { "2026-05-16": 28000 };
    const out = computeQualifyingSettlements(dbSums, movement, new Set());
    expect(out).toHaveLength(0);
  });

  it("does NOT settle when movement is absent for that date (silence is not agreement)", () => {
    const dbSums: RcOutSums = { "2026-07-01": 12000 };
    const movement: Record<string, number> = {};
    const out = computeQualifyingSettlements(dbSums, movement, new Set());
    expect(out).toHaveLength(0);
  });

  it("does NOT settle when the drift exceeds tolerance (a real disagreement)", () => {
    // A May-15-style 937kg drift — must NOT settle.
    const dbSums: RcOutSums = { "2026-05-15": 29024 };
    const movement = { "2026-05-15": 28087 }; // diff = 937
    const out = computeQualifyingSettlements(dbSums, movement, new Set());
    expect(out).toHaveLength(0);
  });

  it("skips a date already in alreadySettled, even if it would otherwise qualify", () => {
    const dbSums: RcOutSums = { "2026-05-15": 28087 };
    const movement = { "2026-05-15": 28087 };
    const out = computeQualifyingSettlements(dbSums, movement, new Set(["2026-05-15"]));
    expect(out).toHaveLength(0);
  });

  it("backfill: settles multiple qualifying historical dates in one pass, skips the unbalanced one", () => {
    const dbSums: RcOutSums = {
      "2026-05-15": 28087, // balanced (0 diff)
      "2026-05-28": 56393, // balanced (0 diff)
      "2026-05-29": 30000, // unbalanced (937kg drift, mirrors the real incident)
    };
    const movement = {
      "2026-05-15": 28087,
      "2026-05-28": 56393,
      "2026-05-29": 29063,
    };
    const out = computeQualifyingSettlements(dbSums, movement, new Set());
    const dates = out.map((o) => o.transaction_date).sort();
    expect(dates).toEqual(["2026-05-15", "2026-05-28"]);
  });

  it("default tolerance constant is 50kg", () => {
    expect(SETTLEMENT_TOLERANCE_KG).toBe(50);
  });

  it("a movement-only date with no DB sum is never a candidate (nothing to settle)", () => {
    const dbSums: RcOutSums = {};
    const movement = { "2026-07-01": 12000 };
    const out = computeQualifyingSettlements(dbSums, movement, new Set());
    expect(out).toHaveLength(0);
  });
});
