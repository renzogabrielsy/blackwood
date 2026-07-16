/**
 * flecon.test.ts — unit tests for the flecon port's trickiest internal functions.
 *
 * The end-to-end classify parity is gated by `npm run parity -- --type flecon`
 * (3/3 against the Python oracle). These focused unit tests lock in the two pieces
 * most likely to silently drift from the Python:
 *   1. DAY-SET multiset identity / order-independence (movementSig + NOOP semantics).
 *   2. HEADER-SIGNATURE column matching, incl. the merged-cell parity fix (a
 *      vertically-merged C5:C6 header must yield ONE signature, not a duplicated one).
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { movementSig, normParticular, classifyFlecon } from "../../src/reports/flecon/classify.js";
import { extractFlecon, type BagTypeRegistryRow } from "../../src/reports/flecon/extract.js";
import { loadFleconWorkbook } from "../../src/reports/flecon/sheet.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIX = resolve(__dirname, "../../fixtures/flecon");

describe("normParticular", () => {
  it("uppercases and collapses ALL whitespace", () => {
    expect(normParticular("  bagged   powder  ")).toBe("BAGGED POWDER");
    expect(normParticular("bagged\tpowder\n-x")).toBe("BAGGED POWDER -X");
  });
  it("maps null/undefined to empty string", () => {
    expect(normParticular(null)).toBe("");
    expect(normParticular(undefined)).toBe("");
  });
  it("does NOT canonicalize spelling — ZAMBOANGA vs ZAMBAONGA stay distinct", () => {
    expect(normParticular("RS 1 ZAMBOANGA")).not.toBe(normParticular("RS 1 ZAMBAONGA"));
  });
});

describe("movementSig — the multiset element identity", () => {
  it("is a (particular^, code^, int(round(qty))) tuple, order-independent as a set key", () => {
    const a = movementSig({ particular: "bagged powder", bag_type_code: "kuraray_590", qty_delta: -1 });
    const b = movementSig({ particular: " BAGGED  POWDER ", bag_type_code: "KURARAY_590", qty_delta: -1 });
    expect(a).toBe(b); // case/whitespace/code all normalized identically
  });
  it("rounds qty via banker's rounding then truncates (int(round(float(x))))", () => {
    // 2.5 → banker's round → 2 (even); 3.5 → 4 (even); "-1" string → -1.
    expect(movementSig({ particular: "x", bag_type_code: "C", qty_delta: 2.5 })).toContain(",2]");
    expect(movementSig({ particular: "x", bag_type_code: "C", qty_delta: 3.5 })).toContain(",4]");
    expect(movementSig({ particular: "x", bag_type_code: "C", qty_delta: "-1" })).toContain(",-1]");
  });
  it("treats an unparseable qty as 0 (except TypeError/ValueError → qty=0)", () => {
    expect(movementSig({ particular: "x", bag_type_code: "C", qty_delta: "abc" })).toContain(",0]");
    expect(movementSig({ particular: "x", bag_type_code: "C", qty_delta: null })).toContain(",0]");
  });
});

describe("day-set multiset NOOP — order-independent", () => {
  // Two identical multisets in DIFFERENT row order must classify DUPLICATE_NOOP.
  const registry: BagTypeRegistryRow[] = [
    { code: "KURARAY_590", source_label: "590 kls(Kuraray)", source_column: "C", sort_order: 1, label: "K" },
    { code: "UNUSABLE", source_label: "Un-usable bag", source_column: "D", sort_order: 2, label: "U" },
  ];

  it("classifies reordered-but-identical days as NOOP (Counter equality)", async () => {
    const wb = await loadFleconWorkbook(readFileSync(resolve(FIX, "workbooks/flecon_noop_reorder.xlsx")));
    const extract = extractFlecon(wb, "flecon_noop_reorder.xlsx", registry, "2026-01-01", null);
    // DB rows in a DIFFERENT order than the sheet, same multiset.
    const dbWindow = JSON.parse(
      readFileSync(resolve(FIX, "db_window/flecon_noop_reorder.json"), "utf8"),
    );
    const classified = classifyFlecon(extract, "2026-01-01", {
      movements: dbWindow.movements,
      bagTypes: dbWindow.bag_types,
      viewBalance: dbWindow.view_balance,
    });
    expect(classified.summary.duplicate_noop_days).toBe(1);
    expect(classified.summary.date_changed_days).toBe(0);
    expect(classified.per_date).toHaveLength(0); // NOOP days never dumped
  });
});

describe("header-signature matching + merged-cell parity", () => {
  it("builds ONE signature per column from merged rows 3/5/6 (no duplication)", async () => {
    const dbWindow = JSON.parse(
      readFileSync(resolve(FIX, "db_window/flecon_real_latest.json"), "utf8"),
    );
    const wb = await loadFleconWorkbook(
      readFileSync(resolve(FIX, "workbooks/flecon_real_latest.xlsx")),
    );
    const extract = extractFlecon(
      wb,
      "flecon_real_latest.xlsx",
      dbWindow.bag_type_registry,
      "2026-01-01",
      null,
    );
    const colC = extract.column_map.find((e) => e.column_letter === "C");
    // C5:C6 is a vertical merge carrying "590 kls(Kuraray)". openpyxl parity: the
    // covered cell (C6) reads null, so the signature is the value ONCE, not twice.
    expect(colC?.signature).toBe("590 kls(Kuraray)");
    expect(colC?.matched_code).toBe("KURARAY_590");
  });

  it("leaves an ambiguous / unmatched column UNMAPPED, never guessed", async () => {
    const dbWindow = JSON.parse(readFileSync(resolve(FIX, "db_window/flecon_edge.json"), "utf8"));
    const wb = await loadFleconWorkbook(readFileSync(resolve(FIX, "workbooks/flecon_edge.xlsx")));
    const extract = extractFlecon(wb, "flecon_edge.xlsx", dbWindow.bag_type_registry, "2026-01-01", null);
    // Column I in the edge sheet has signature "MYSTERY BRAND XYZ" — matches nothing.
    const colI = extract.column_map.find((e) => e.column_letter === "I");
    expect(colI?.matched_code).toBeNull();
    // A reshuffled registry (F/G swapped) still maps by signature, not by position.
    const colF = extract.column_map.find((e) => e.column_letter === "F");
    const colG = extract.column_map.find((e) => e.column_letter === "G");
    expect(colF?.matched_code).toBe("FG_ALL_BLACK");
    expect(colG?.matched_code).toBe("FG_BLACK_SLING_6X50");
  });
});
