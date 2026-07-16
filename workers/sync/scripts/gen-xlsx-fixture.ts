/**
 * gen-xlsx-fixture.ts — synthesize a small real .xlsx (via exceljs) that exercises
 * the openpyxl semantics xlsx.ts must match: a date cell, a formula cell (data_only
 * → cached result), a merged region, a numeric cell, a string cell, and an empty
 * cell. Committed to test/fixtures/sample.xlsx so xlsx.test.ts has a real workbook
 * to read even though no ICTC xlsx exists in the repo. (Checked /tmp/sync-* and
 * scratchpad — none present — so we synthesize, as the work order allows.)
 */
import ExcelJS from "exceljs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdirSync } from "node:fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(__dirname, "../test/fixtures/sample.xlsx");

const wb = new ExcelJS.Workbook();
const ws = wb.addWorksheet("Sheet1");
const ws2 = wb.addWorksheet("July 2026");

// Row 1: header strings
ws.getRow(1).values = [undefined, "Date", "Supplier", "Weight", "Computed", "Merged"];
// Row 2: a date, a string, a number, a FORMULA (with cached result), a merged anchor
const r2 = ws.getRow(2);
r2.getCell(1).value = new Date(Date.UTC(2026, 6, 2)); // 2026-07-02 (date cell)
r2.getCell(2).value = "AVSECO";
r2.getCell(3).value = 5820.5;
// Formula cell WITH a cached result — exceljs writes both; loadWorkbook (data_only)
// must return the RESULT (11640.5), never the formula text.
r2.getCell(4).value = { formula: "C2*2", result: 11640.5 } as ExcelJS.CellFormulaValue;
r2.getCell(5).value = "anchor";
// Merge B3:C3 — anchor value in the top-left; covered cell reads null (openpyxl parity)
ws.mergeCells("E2:F2");
// Row 3: an empty cell in col 2, value in col 3
ws.getRow(3).getCell(3).value = 42;

// second sheet just to prove sheetNames / sheetAt
ws2.getRow(1).getCell(1).value = "month tab";

mkdirSync(dirname(OUT), { recursive: true });
await wb.xlsx.writeFile(OUT);
// eslint-disable-next-line no-console
console.log(`[fixtures] wrote ${OUT}`);
