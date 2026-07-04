/**
 * canonical.test.ts — unit tests for the parity canonicalizer.
 *
 * These lock the four canonicalization rules (key sort, row-array sort, float
 * textual rule, volatile-key strip) AND prove idempotence — canonicalizing an
 * already-canonical tree must be a no-op, which the runner relies on (it
 * canonicalizes the on-disk oracle, which is ALREADY canonical, a second time).
 */
import { describe, it, expect } from "vitest";
import {
  canonicalize,
  canonicalJSON,
  canonicalizeNumber,
  stableStringify,
  FLOAT_TAG,
} from "./canonical.js";

describe("canonicalizeNumber — textual float rule", () => {
  it("collapses integer-valued numbers (12.0 -> 12)", () => {
    expect(canonicalizeNumber(12.0)).toBe(FLOAT_TAG + "12");
    expect(canonicalizeNumber(12)).toBe(FLOAT_TAG + "12");
    expect(canonicalizeNumber(-0)).toBe(FLOAT_TAG + "0");
  });
  it("rounds to 9dp and strips trailing zeros", () => {
    expect(canonicalizeNumber(1.5)).toBe(FLOAT_TAG + "1.5");
    expect(canonicalizeNumber(1234.501)).toBe(FLOAT_TAG + "1234.501");
    // last-bit noise erased at 9dp
    expect(canonicalizeNumber(0.1 + 0.2)).toBe(FLOAT_TAG + "0.3");
  });
  it("a value that rounds to an integer at 9dp collapses to integer text", () => {
    expect(canonicalizeNumber(12.0000000004)).toBe(FLOAT_TAG + "12");
  });
});

describe("canonicalize — object key sort + volatile strip", () => {
  it("sorts object keys recursively", () => {
    const c = canonicalize({ b: 1, a: { d: 2, c: 3 } }) as Record<string, unknown>;
    expect(Object.keys(c)).toEqual(["a", "b"]);
    expect(Object.keys(c.a as object)).toEqual(["c", "d"]);
  });
  it("drops volatile keys at any depth", () => {
    const c = canonicalize({
      counts: { insert: 1 },
      output_path: "/tmp/x.json",
      rows: [{ batch_code: "X", id: "uuid-1", source_row: 42 }],
    }) as Record<string, unknown>;
    expect("output_path" in c).toBe(false);
    const row = (c.rows as Record<string, unknown>[])[0];
    expect("id" in row).toBe(false);
    expect("source_row" in row).toBe(false);
    expect(row.batch_code).toBe("X");
  });
});

describe("canonicalize — row-array sort by natural key", () => {
  it("sorts object arrays so emission order is not a diff", () => {
    const a = canonicalJSON([
      { transaction_date: "2026-06-02", batch_code: "B", weight_kg: 10 },
      { transaction_date: "2026-06-01", batch_code: "A", weight_kg: 20 },
    ]);
    const b = canonicalJSON([
      { transaction_date: "2026-06-01", batch_code: "A", weight_kg: 20 },
      { transaction_date: "2026-06-02", batch_code: "B", weight_kg: 10 },
    ]);
    expect(a).toBe(b);
  });
  it("leaves scalar arrays in place (order preserved)", () => {
    expect(canonicalJSON([3, 1, 2])).toBe(canonicalJSON([3, 1, 2]));
    expect(canonicalJSON([3, 1, 2])).not.toBe(canonicalJSON([1, 2, 3]));
  });
  it("sorts multiset-key rows (flecon particular/code/qty) order-independently", () => {
    const x = canonicalJSON([
      { particular: "BAGGED", bag_type_code: "FG", qty_delta: -2 },
      { particular: "BAGGED", bag_type_code: "FG", qty_delta: -5 },
    ]);
    const y = canonicalJSON([
      { particular: "BAGGED", bag_type_code: "FG", qty_delta: -5 },
      { particular: "BAGGED", bag_type_code: "FG", qty_delta: -2 },
    ]);
    expect(x).toBe(y);
  });
});

describe("canonicalize — idempotence (the runner relies on this)", () => {
  const samples: unknown[] = [
    { b: 2, a: 1, nested: [{ transaction_date: "d", weight_kg: 1.5 }] },
    [{ code: "Z" }, { code: "A" }],
    { counts: { insert: 1, noop: 0 }, ok: true, weight: 21789.0000001 },
  ];
  for (const s of samples) {
    it(`canonicalize(canonicalize(x)) === canonicalize(x) :: ${JSON.stringify(s).slice(0, 40)}`, () => {
      const once = canonicalize(s);
      const twice = canonicalize(once);
      expect(stableStringify(twice)).toBe(stableStringify(once));
    });
  }
});
