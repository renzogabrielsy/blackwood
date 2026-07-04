/**
 * xlsx.ts — exceljs helpers matching the openpyxl semantics the Python extractors
 * rely on. The extractors read cells with 1-based `sheet.cell(row, col).value`
 * under `load_workbook(data_only=True)` (cached formula RESULTS, not formulas),
 * iterate `wb.sheetnames`, and coerce every value through coerce_date / coerce_float
 * / coerce_str / coerce_int (see norm.ts for the value coercers).
 *
 * The two semantics that MUST match openpyxl exactly:
 *   1. data_only=True  → for a formula cell, return the cached RESULT, never the
 *      "=A1+B1" formula text. exceljs surfaces this as cell.result (or the
 *      {formula, result} object) — cellValue() below unwraps it.
 *   2. date cells      → openpyxl yields a native datetime/date; exceljs yields a
 *      JS Date. Both are handed to coerceDate(), which takes the calendar Y-M-D.
 *      exceljs parses date-typed cells as UTC, so cellToDateISO reads UTC parts —
 *      norm.coerceDate already does this for Date inputs.
 *   3. merged cells    → in openpyxl(read_only=False) a merged region's value lives
 *      in its TOP-LEFT (anchor) cell; the other covered cells read as null. exceljs
 *      behaves the same by default (getCell on a covered cell returns the master's
 *      address but a null value unless you follow .master). getMergedValue() follows
 *      the master so callers that need the anchor value get it — the date
 *      carry-forward logic in the extractors handles the null-covered case itself,
 *      so cellValue() deliberately does NOT auto-follow merges (openpyxl parity).
 *
 * Reading the raw bytes: loadWorkbook(buffer) reads from a Buffer (the Gmail
 * attachment / Storage object) — no temp file needed.
 */
import ExcelJS from "exceljs";

export interface LoadedSheet {
  name: string;
  rowCount: number;
  columnCount: number;
  /** 1-based cell read, openpyxl `sheet.cell(row, col).value` parity. */
  cell(row: number, col: number): CellValue;
}

export interface LoadedWorkbook {
  sheetNames: string[];
  sheet(name: string): LoadedSheet | null;
  sheetAt(index: number): LoadedSheet | null; // 0-based
}

/** The normalized value a cell can carry — mirrors what openpyxl `.value` returns. */
export type CellValue = string | number | boolean | Date | null;

/**
 * Load a workbook from a Buffer. `data_only`-equivalent: cellValue() returns cached
 * formula results (never formula text), matching openpyxl load_workbook(data_only=True).
 */
export async function loadWorkbook(data: Buffer): Promise<LoadedWorkbook> {
  const wb = new ExcelJS.Workbook();
  // exceljs types its loader against the older Buffer<ArrayBuffer>; Node 20's Buffer
  // is Buffer<ArrayBufferLike>. The bytes are identical — coerce through unknown.
  await wb.xlsx.load(data as unknown as ExcelJS.Buffer);

  const sheetNames: string[] = [];
  wb.eachSheet((ws) => sheetNames.push(ws.name));

  const wrapSheet = (ws: ExcelJS.Worksheet | undefined): LoadedSheet | null => {
    if (!ws) return null;
    return {
      name: ws.name,
      rowCount: ws.rowCount,
      columnCount: ws.columnCount,
      cell(row: number, col: number): CellValue {
        // exceljs is 1-based for getRow/getCell — same as openpyxl sheet.cell.
        const c = ws.getRow(row).getCell(col);
        return cellValue(c);
      },
    };
  };

  return {
    sheetNames,
    sheet(name: string) {
      return wrapSheet(wb.getWorksheet(name));
    },
    sheetAt(index: number) {
      // exceljs worksheets are 1-based by id; use the name list for 0-based access.
      const nm = sheetNames[index];
      return nm ? wrapSheet(wb.getWorksheet(nm)) : null;
    },
  };
}

/**
 * Normalize an exceljs cell to the openpyxl-equivalent `.value`:
 *   - formula cell (data_only) → its cached RESULT (cell.result), unwrapping the
 *     { formula, result } shape. If result is a rich error object, → null.
 *   - date cell → JS Date (passed through; coerceDate handles it downstream).
 *   - hyperlink / rich text → the display text.
 *   - empty / null → null.
 */
export function cellValue(cell: ExcelJS.Cell): CellValue {
  const v = cell.value;
  if (v === null || v === undefined) return null;

  // exceljs value types:
  if (v instanceof Date) return v;
  if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
    return v;
  }

  // Formula cell: { formula, result } — data_only means we take the RESULT.
  if (typeof v === "object") {
    const o = v as unknown as Record<string, unknown>;

    if ("result" in o) {
      const r = o.result;
      if (r === null || r === undefined) return null;
      if (r instanceof Date) return r;
      if (typeof r === "string" || typeof r === "number" || typeof r === "boolean") {
        return r;
      }
      // { error: '#DIV/0!' } etc. → null (openpyxl data_only yields None for errors).
      return null;
    }

    // Rich text: { richText: [{ text }, ...] } → concatenated text.
    if ("richText" in o && Array.isArray(o.richText)) {
      return (o.richText as Array<{ text?: string }>).map((t) => t.text ?? "").join("");
    }

    // Hyperlink: { text, hyperlink } → display text.
    if ("text" in o && typeof o.text === "string") return o.text;

    // Shared formula / error object without result → null.
    if ("error" in o) return null;
  }

  return null;
}

/**
 * Follow a merged cell to its anchor (master) value. openpyxl in read/write mode
 * puts a merged region's value in the TOP-LEFT anchor; covered cells read null.
 * Most extractors handle the null themselves (date carry-forward), so use this ONLY
 * where the extractor explicitly expects the anchor value.
 */
export function getMergedValue(ws: ExcelJS.Worksheet, row: number, col: number): CellValue {
  const c = ws.getRow(row).getCell(col);
  // exceljs: a covered cell's .master points to the anchor cell.
  const master = (c as ExcelJS.Cell & { master?: ExcelJS.Cell }).master;
  if (master && master !== c) return cellValue(master);
  return cellValue(c);
}

/**
 * Convert a date-typed cell to ISO YYYY-MM-DD using UTC parts (exceljs stores date
 * cells as UTC). Thin convenience over norm.coerceDate for callers that already
 * have a Date. Kept here so xlsx callers don't import norm just for this.
 */
export function cellToDateISO(value: CellValue): string | null {
  if (value instanceof Date) {
    if (isNaN(value.getTime())) return null;
    const y = value.getUTCFullYear();
    const m = String(value.getUTCMonth() + 1).padStart(2, "0");
    const d = String(value.getUTCDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
  }
  return null;
}
