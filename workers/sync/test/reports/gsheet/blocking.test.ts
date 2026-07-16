/**
 * blocking.test.ts — the Sheet **Blocking**-tab extractor (reports/gsheet/blocking.ts).
 *
 * The fixture mirrors the REAL tab layout investigated 2026-07-08 against the live Sheet:
 *   - col A carries the "INVENTORY TONS" total a few rows down (tons → kg).
 *   - a BAND is 6 stacked rows: LABEL (col 7 = row letter; cols 8+ = block_loc strings),
 *     then BLOCK (batch codes), BALANCE (kg), BD, ASH, MC — block/batch/balance share a
 *     COLUMN. A PCA extension shares the same LABEL row at higher columns.
 *   - vacant slots have a loc header but no batch/balance → skipped.
 */
import { describe, it, expect } from "vitest";

import type { LoadedSheet, CellValue } from "../../../src/lib/xlsx.js";
import { extractBlockingTab } from "../../../src/reports/gsheet/blocking.js";

/** Build a LoadedSheet from a { "A1": value } cell map (Excel A1 refs). */
function mkSheet(name: string, cells: Record<string, CellValue>): LoadedSheet {
  const parse = (ref: string): [number, number] => {
    const m = /^([A-Z]+)(\d+)$/.exec(ref)!;
    let col = 0;
    for (const ch of m[1]) col = col * 26 + (ch.charCodeAt(0) - 64);
    return [parseInt(m[2], 10), col];
  };
  const grid = new Map<string, CellValue>();
  let maxRow = 1;
  let maxCol = 1;
  for (const [ref, v] of Object.entries(cells)) {
    const [r, c] = parse(ref);
    grid.set(`${r}:${c}`, v);
    maxRow = Math.max(maxRow, r);
    maxCol = Math.max(maxCol, c);
  }
  return {
    name,
    rowCount: maxRow,
    columnCount: maxCol,
    cell: (row, col) => grid.get(`${row}:${col}`) ?? null,
  };
}

/**
 * A two-band fixture:
 *   Band 1 (rows 2-7) — WHSE A row A: cols 8,9,10 = A-1A/A-2A/A-3A (A-3A vacant), PLUS a
 *   PCA extension at col 31 = PCA-15A sharing the same LABEL row.
 *   Band 2 (rows 8-13) — WHSE A row B: cols 8,9 = A-1B/A-2B.
 * col A2 = "INVENTORY TONS", A4 = 0.500 tons total (→ 500 kg).
 */
function fixture(): LoadedSheet {
  return mkSheet("Blocking", {
    A2: "INVENTORY TONS",
    A4: 0.5, // 0.5 tons → 500 kg stated grand total
    // ── Band 1: LABEL row (r2), BLOCK (r3), BALANCE (r4) ──
    G2: "A",
    H2: "A-1A", I2: "A-2A", J2: "A-3A",
    AE2: "PCA-15A", // col 31
    G3: "BLOCK",
    H3: "FEB-26-BLK3", I3: "FEB-26-BLK11", /* J3 vacant */
    AE3: "JUNE-26-BLK1",
    G4: "BALANCE",
    H4: 100, I4: 200, /* J4 vacant */
    AE4: 50,
    // ── Band 2: LABEL (r8), BLOCK (r9), BALANCE (r10) ──
    G8: "B",
    H8: "A-1B", I8: "A-2B",
    G9: "BLOCK",
    H9: "MARCH-26-BLK4", I9: "JAN-26-BLK1",
    G10: "BALANCE",
    H10: 100, I10: 50,
  });
}

describe("extractBlockingTab", () => {
  it("extracts occupied blocks column-aligned (LABEL/BLOCK/BALANCE) incl. the PCA extension", () => {
    const r = extractBlockingTab(fixture());
    const byLoc = Object.fromEntries(r.blocks.map((b) => [b.block_loc, b]));

    expect(byLoc["A-1A"]).toEqual({ block_loc: "A-1A", batch_code: "FEB-26-BLK3", balance_kg: 100 });
    expect(byLoc["A-2A"]).toEqual({ block_loc: "A-2A", batch_code: "FEB-26-BLK11", balance_kg: 200 });
    expect(byLoc["PCA-15A"]).toEqual({ block_loc: "PCA-15A", batch_code: "JUNE-26-BLK1", balance_kg: 50 });
    expect(byLoc["A-1B"]).toEqual({ block_loc: "A-1B", batch_code: "MARCH-26-BLK4", balance_kg: 100 });
    expect(byLoc["A-2B"]).toEqual({ block_loc: "A-2B", batch_code: "JAN-26-BLK1", balance_kg: 50 });
  });

  it("skips vacant slots (loc header but no batch/balance)", () => {
    const r = extractBlockingTab(fixture());
    expect(r.blocks.find((b) => b.block_loc === "A-3A")).toBeUndefined();
    expect(r.blocks).toHaveLength(5);
  });

  it("reads the stated grand total from col A (tons → kg)", () => {
    const r = extractBlockingTab(fixture());
    expect(r.statedGrandTotalKg).toBe(500);
  });

  it("does NOT mistake a batch code (BLOCK row) for a block_loc header", () => {
    // "FEB-26-BLK3" must never match the block_loc regex — only "A-1A"-shaped strings do.
    const r = extractBlockingTab(fixture());
    expect(r.blocks.map((b) => b.block_loc).sort()).toEqual(
      ["A-1A", "A-1B", "A-2A", "A-2B", "PCA-15A"].sort(),
    );
  });

  it("emitted Sheet sum matches the stated grand total on a complete extract", () => {
    const r = extractBlockingTab(fixture());
    const sum = r.blocks.reduce((a, b) => a + (b.balance_kg ?? 0), 0);
    expect(sum).toBe(500); // 100 + 200 + 50 + 100 + 50
    expect(sum).toBe(r.statedGrandTotalKg);
  });
});
