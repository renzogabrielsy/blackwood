/**
 * differ.test.ts — unit tests for the deep differ. Inputs are ALREADY
 * canonicalized (that's the contract), so we canonicalize test data first.
 */
import { describe, it, expect } from "vitest";
import { canonicalize } from "./canonical.js";
import { diff } from "./differ.js";

const cdiff = (a: unknown, b: unknown) => diff(canonicalize(a), canonicalize(b));

describe("diff", () => {
  it("returns [] for equal values (post-canonical)", () => {
    expect(cdiff({ a: 1, b: [1, 2] }, { b: [1, 2], a: 1 })).toEqual([]);
    // 12.0 vs 12 are equal after the float rule
    expect(cdiff({ w: 12.0 }, { w: 12 })).toEqual([]);
  });

  it("detects a scalar value difference with the right path", () => {
    const d = cdiff({ counts: { insert: 1 } }, { counts: { insert: 2 } });
    expect(d).toHaveLength(1);
    expect(d[0].path).toBe("/counts/insert");
    expect(d[0].kind).toBe("value");
    expect(d[0].oracle).toBe(" num:1");
    expect(d[0].ts).toBe(" num:2");
  });

  it("flags a key present only in oracle (missing_in_ts)", () => {
    const d = cdiff({ a: 1, b: 2 }, { a: 1 });
    expect(d).toHaveLength(1);
    expect(d[0].kind).toBe("missing_in_ts");
    expect(d[0].path).toBe("/b");
  });

  it("flags a key present only in ts (missing_in_oracle)", () => {
    const d = cdiff({ a: 1 }, { a: 1, extra: 9 });
    expect(d[0].kind).toBe("missing_in_oracle");
    expect(d[0].path).toBe("/extra");
  });

  it("flags a type mismatch (array vs object)", () => {
    const d = cdiff({ x: [1] }, { x: { 0: 1 } });
    expect(d[0].kind).toBe("type");
    expect(d[0].path).toBe("/x");
  });

  it("compares row arrays index-aligned after natural-key sort", () => {
    // Same rows, different order -> no diff; a changed field -> a precise path.
    const oracle = [
      { transaction_date: "2026-06-01", batch_code: "A", weight_kg: 10 },
      { transaction_date: "2026-06-02", batch_code: "B", weight_kg: 20 },
    ];
    const ts = [
      { transaction_date: "2026-06-02", batch_code: "B", weight_kg: 20 },
      { transaction_date: "2026-06-01", batch_code: "A", weight_kg: 99 },
    ];
    const d = cdiff(oracle, ts);
    expect(d).toHaveLength(1);
    // A sorts before B -> index 0
    expect(d[0].path).toBe("/0/weight_kg");
    expect(d[0].oracle).toBe(" num:10");
    expect(d[0].ts).toBe(" num:99");
  });
});
