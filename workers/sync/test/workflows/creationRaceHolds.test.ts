/**
 * creationRaceHolds.test.ts — the post-writers creation-race re-resolve pass (Fix 1).
 *
 * Covers the three dispositions the pass makes over gsheet `unmapped_batch_code` holds
 * after the parallel writers complete:
 *   1. AUTO-CLEAR — batch resolves + a sibling writer wrote the row (the JULY-26-BLK4
 *      timing false-alarm) → dropped from held + counted.
 *   2. KEEP unchanged — the code STILL doesn't resolve (a genuine new/typo batch).
 *   3. RECLASSIFY — batch now exists but no matching record → kept, reason/detail
 *      updated, NEVER auto-written.
 * Plus: fallback-alias resolution, and non-unmapped holds passing through untouched.
 */
import { describe, it, expect } from "vitest";

import {
  reResolveCreationRaceHolds,
  type HeldRowLike,
  type RecordExistsFn,
} from "../../src/workflows/creationRaceHolds.js";

const yes: RecordExistsFn = async () => true;
const no: RecordExistsFn = async () => false;

/** A gsheet rc_in unmapped_batch_code hold (as apply.ts now builds it). */
function unmappedHold(over: Partial<HeldRowLike> = {}): HeldRowLike {
  return {
    reason: "unmapped left as skip — never auto-create a batch",
    natural_key: "RC IN row 1220 · JULY-26-BLK4",
    detail: "unmapped left as skip — never auto-create a batch",
    kind: "unmapped_batch_code",
    row: {
      mode: "rc_in",
      index: 1220,
      batch_code: "JULY-26-BLK4",
      transaction_date: "2026-07-26",
      block_loc: "B-4A",
      weight_kg: 21789,
      supplier: "ACME",
      truck_plate: "MAN 3625",
    },
    source_index: 1220,
    ...over,
  };
}

describe("creation-race re-resolve — AUTO-CLEAR (the JULY-26-BLK4 race)", () => {
  it("drops a hold whose batch resolves AND whose record a sibling already wrote", async () => {
    const held = [unmappedHold()];
    const out = await reResolveCreationRaceHolds(held, { "JULY-26-BLK4": "b1" }, yes);

    expect(out.autoCleared).toBe(1);
    expect(out.reclassified).toBe(0);
    expect(out.keptUnmapped).toBe(0);
    expect(out.newHeld).toBeDefined();
    expect(out.newHeld).toHaveLength(0); // the false-alarm hold is gone
  });

  it("resolves via a month-alias FALLBACK (primary JUL-… , batch registered as JULY-…)", async () => {
    const held = [
      unmappedHold({
        natural_key: "RC IN row 1220 · JUL-26-BLK4",
        row: { mode: "rc_in", index: 1220, batch_code: "JUL-26-BLK4", transaction_date: "2026-07-26" },
      }),
    ];
    // Lookup only has the LONG form; batchCodeFallbacks('JUL-26-BLK4') → 'JULY-26-BLK4'.
    const out = await reResolveCreationRaceHolds(held, { "JULY-26-BLK4": "b1" }, yes);
    expect(out.autoCleared).toBe(1);
    expect(out.newHeld).toHaveLength(0);
  });
});

describe("creation-race re-resolve — KEEP genuinely-unmapped", () => {
  it("keeps a hold whose code STILL does not resolve (no batch, no record)", async () => {
    const held = [unmappedHold()];
    const out = await reResolveCreationRaceHolds(held, {}, no);

    expect(out.autoCleared).toBe(0);
    expect(out.reclassified).toBe(0);
    expect(out.keptUnmapped).toBe(1);
    // Nothing changed → no rebuilt array (caller leaves the result as-is).
    expect(out.newHeld).toBeUndefined();
  });
});

describe("creation-race re-resolve — RECLASSIFY batch-now-exists-but-row-unwritten", () => {
  it("keeps the hold, updates reason/detail + a row marker, never auto-writes", async () => {
    const held = [unmappedHold()];
    const out = await reResolveCreationRaceHolds(held, { "JULY-26-BLK4": "b1" }, no);

    expect(out.autoCleared).toBe(0);
    expect(out.reclassified).toBe(1);
    expect(out.keptUnmapped).toBe(0);
    expect(out.newHeld).toHaveLength(1); // KEPT (not auto-written)

    const kept = out.newHeld![0];
    // kind stays a valid HeldKind (frontend KIND_LABEL is exhaustive over HeldKind).
    expect(kept.kind).toBe("unmapped_batch_code");
    expect(kept.detail).toMatch(/now exists/i);
    expect(kept.detail).toMatch(/not auto-written/i);
    expect(kept.row?.batch_now_exists).toBe(true);
    expect(kept.row?.resolved_batch_id).toBe("b1");
    // natural_key is unchanged → the case fingerprint (reportType, kind, natural_key) is stable.
    expect(kept.natural_key).toBe("RC IN row 1220 · JULY-26-BLK4");
  });
});

describe("creation-race re-resolve — untouched rows + mixed sets", () => {
  it("passes NON-unmapped holds through verbatim", async () => {
    const other: HeldRowLike = {
      reason: "gate_failure",
      natural_key: "RC OUT — too_many_new",
      detail: "…",
      kind: "gate_failure",
    };
    const out = await reResolveCreationRaceHolds([other], {}, yes);
    // No unmapped rows at all → pure no-op (no rebuilt array).
    expect(out.newHeld).toBeUndefined();
    expect(out.autoCleared).toBe(0);
  });

  it("clears the false-alarm but preserves a sibling non-unmapped hold + a genuine one", async () => {
    const gate: HeldRowLike = { reason: "gate", natural_key: "G", detail: "d", kind: "gate_failure" };
    const genuine = unmappedHold({
      natural_key: "RC IN row 99 · TYPO-26-BLKZ",
      row: { mode: "rc_in", index: 99, batch_code: "TYPO-26-BLKZ", transaction_date: "2026-07-26" },
    });
    const raced = unmappedHold(); // JULY-26-BLK4 — will auto-clear
    const out = await reResolveCreationRaceHolds(
      [gate, genuine, raced],
      { "JULY-26-BLK4": "b1" },
      yes,
    );

    expect(out.autoCleared).toBe(1);
    expect(out.keptUnmapped).toBe(1);
    expect(out.newHeld).toHaveLength(2); // gate + genuine kept; raced dropped
    expect(out.newHeld!.map((h) => h.natural_key)).toEqual(["G", "RC IN row 99 · TYPO-26-BLKZ"]);
  });
});
