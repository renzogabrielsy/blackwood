/**
 * blockAliases.test.ts — unit tests for the PATIO BLOCK-NAME alias table
 * (../../src/reconcile/blockAliases.ts). Pure, no DB/fixtures — just the lookup table +
 * the two helper functions. Integration with the reconciler (bucketProposed / the
 * agree-vs-diff / attribution-matcher interplay) is covered separately in
 * test/reconcile/rcOutStage.test.ts § "Patio block aliases".
 */
import { describe, it, expect } from "vitest";

import {
  PROPOSED_PATIO_BLOCK_ALIASES,
  isKnownPatioAlias,
  normalizeProposedBlock,
} from "../../src/reconcile/blockAliases.js";

describe("normalizeProposedBlock — known aliases resolve to the Sheet's coded block", () => {
  it("resolves every seeded alias exactly", () => {
    expect(normalizeProposedBlock("16A NEAR WALL")).toBe("PCA-16A");
    expect(normalizeProposedBlock("16A HALF OF MIDDLE")).toBe("PCA-16B");
    expect(normalizeProposedBlock("16A NEAR PATHWAY")).toBe("PCA-16C");
    expect(normalizeProposedBlock("15A NEAR WALL")).toBe("PCA-15A");
    expect(normalizeProposedBlock("15A HALF OF MIDDLE")).toBe("PCA-15B");
    expect(normalizeProposedBlock("15A MIDDLE SIDE")).toBe("PCA-15C");
    expect(normalizeProposedBlock("16B ANEAR PATHWAY")).toBe("PCB-16A");
    expect(normalizeProposedBlock("17A MIDDLE SIDE AND 17ANEAR PATHWAY")).toBe("PCA-17B");
  });

  it("the table has exactly the 8 seeded rows (no accidental extra/missing entries)", () => {
    expect(Object.keys(PROPOSED_PATIO_BLOCK_ALIASES)).toHaveLength(8);
  });
});

describe("normalizeProposedBlock — unknown blocks pass through unchanged", () => {
  it("an ordinary standard block_loc is returned verbatim", () => {
    expect(normalizeProposedBlock("D-11B")).toBe("D-11B");
    expect(normalizeProposedBlock("A-1A")).toBe("A-1A");
  });

  it("a Sheet-coded block that is not one of the 8 patio codes still passes through unchanged", () => {
    expect(normalizeProposedBlock("PCA-99Z")).toBe("PCA-99Z");
  });

  it("never invents an alias for a near-miss / partial match", () => {
    expect(normalizeProposedBlock("16A NEAR")).toBe("16A NEAR"); // truncated, not a real alias
    expect(normalizeProposedBlock("16A NEAR WALLS")).toBe("16A NEAR WALLS"); // trailing extra char
  });
});

describe("normalizeProposedBlock — case + whitespace insensitive lookup", () => {
  it("lowercase input still resolves", () => {
    expect(normalizeProposedBlock("16a near wall")).toBe("PCA-16A");
  });

  it("mixed case still resolves", () => {
    expect(normalizeProposedBlock("16A Near Wall")).toBe("PCA-16A");
  });

  it("collapsed/extra internal whitespace still resolves", () => {
    expect(normalizeProposedBlock("16A   NEAR    WALL")).toBe("PCA-16A");
  });

  it("leading/trailing whitespace still resolves", () => {
    expect(normalizeProposedBlock("  16A NEAR WALL  ")).toBe("PCA-16A");
  });
});

describe("normalizeProposedBlock — null/blank handling", () => {
  it("null -> null", () => {
    expect(normalizeProposedBlock(null)).toBeNull();
  });

  it("undefined -> null", () => {
    expect(normalizeProposedBlock(undefined)).toBeNull();
  });

  it("empty string -> null", () => {
    expect(normalizeProposedBlock("")).toBeNull();
  });

  it("whitespace-only string -> null", () => {
    expect(normalizeProposedBlock("   ")).toBeNull();
  });
});

describe("isKnownPatioAlias", () => {
  it("true for a known alias (any case/whitespace variant)", () => {
    expect(isKnownPatioAlias("16A NEAR WALL")).toBe(true);
    expect(isKnownPatioAlias("  16a   near   wall  ")).toBe(true);
  });

  it("false for an unknown block", () => {
    expect(isKnownPatioAlias("D-11B")).toBe(false);
    expect(isKnownPatioAlias("PCA-99Z")).toBe(false);
  });

  it("false for null/undefined/blank", () => {
    expect(isKnownPatioAlias(null)).toBe(false);
    expect(isKnownPatioAlias(undefined)).toBe(false);
    expect(isKnownPatioAlias("")).toBe(false);
    expect(isKnownPatioAlias("   ")).toBe(false);
  });
});
