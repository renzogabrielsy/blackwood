/**
 * closingRemarks.test.ts — locks the ONE canonical closing-remark test shared by the
 * PROPOSED extractor, the gsheet close-scan, and (byte-for-byte) the SQL fn_is_close_remark.
 * Exact-phrase membership: a canonical phrase (any case, trimmed) closes; prose that merely
 * CONTAINS a phrase ("NOT CLOSED YET", "CLOSED SOON") must NOT.
 */
import { describe, it, expect } from "vitest";
import { CLOSING_PHRASES, isClosingRemark } from "../../src/lib/closingRemarks.js";

describe("CLOSING_PHRASES", () => {
  it("is exactly the canonical set kept in lockstep with fn_is_close_remark", () => {
    expect([...CLOSING_PHRASES].sort()).toEqual(
      ["CLOSED", "DONE", "DONE FEEDING", "FEEDING DONE"].sort(),
    );
  });
});

describe("isClosingRemark", () => {
  it("matches every canonical phrase, case- and whitespace-insensitively", () => {
    for (const s of [
      "CLOSED",
      "closed",
      "  Closed  ",
      "DONE",
      "done",
      "DONE FEEDING",
      "done feeding",
      "  FEEDING DONE ",
      "feeding done",
    ]) {
      expect(isClosingRemark(s)).toBe(true);
    }
  });

  it("does NOT match prose that merely contains a closing word", () => {
    for (const s of [
      "NOT CLOSED YET",
      "CLOSED SOON",
      "ALMOST DONE",
      "DONE FEEDING BLOCK 3", // extra words → not the exact phrase
      "FOR FEEDING",
      "partial",
      "",
      "   ",
    ]) {
      expect(isClosingRemark(s)).toBe(false);
    }
  });

  it("treats null/undefined as not closing", () => {
    expect(isClosingRemark(null)).toBe(false);
    expect(isClosingRemark(undefined)).toBe(false);
  });
});
