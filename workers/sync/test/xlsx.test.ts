/**
 * xlsx.test.ts — exceljs helpers match openpyxl semantics against a real workbook
 * (test/fixtures/sample.xlsx, synthesized by scripts/gen-xlsx-fixture.ts).
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadWorkbook, cellToDateISO } from "../src/lib/xlsx.js";
import { coerceDate, coerceFloat } from "../src/lib/norm.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const bytes = readFileSync(resolve(__dirname, "fixtures/sample.xlsx"));

describe("loadWorkbook + cellValue (openpyxl data_only parity)", () => {
  it("exposes sheet names in order", async () => {
    const wb = await loadWorkbook(bytes);
    expect(wb.sheetNames).toEqual(["Sheet1", "July 2026"]);
  });

  it("reads a date cell as a Date -> coerceDate gives ISO", async () => {
    const wb = await loadWorkbook(bytes);
    const sheet = wb.sheet("Sheet1")!;
    const raw = sheet.cell(2, 1); // B? no — 1-based col 1 == A? we wrote col1=Date
    // The date was written to row 2, col 1.
    expect(raw).toBeInstanceOf(Date);
    expect(coerceDate(raw)).toBe("2026-07-02");
    expect(cellToDateISO(raw)).toBe("2026-07-02");
  });

  it("reads a string cell verbatim", async () => {
    const wb = await loadWorkbook(bytes);
    const sheet = wb.sheet("Sheet1")!;
    expect(sheet.cell(2, 2)).toBe("AVSECO");
  });

  it("reads a numeric cell; coerceFloat passes it through", async () => {
    const wb = await loadWorkbook(bytes);
    const sheet = wb.sheet("Sheet1")!;
    expect(sheet.cell(2, 3)).toBe(5820.5);
    expect(coerceFloat(sheet.cell(2, 3))).toBe(5820.5);
  });

  it("FORMULA cell returns the CACHED RESULT, never the formula text (data_only)", async () => {
    const wb = await loadWorkbook(bytes);
    const sheet = wb.sheet("Sheet1")!;
    // C2*2 with cached result 11640.5 — we must get the number, not "C2*2".
    expect(sheet.cell(2, 4)).toBe(11640.5);
  });

  it("empty cell reads as null", async () => {
    const wb = await loadWorkbook(bytes);
    const sheet = wb.sheet("Sheet1")!;
    // row 3, col 2 was never set.
    expect(sheet.cell(3, 2)).toBe(null);
  });

  it("sheetAt is 0-based", async () => {
    const wb = await loadWorkbook(bytes);
    expect(wb.sheetAt(0)!.name).toBe("Sheet1");
    expect(wb.sheetAt(1)!.name).toBe("July 2026");
    expect(wb.sheetAt(2)).toBe(null);
  });
});
