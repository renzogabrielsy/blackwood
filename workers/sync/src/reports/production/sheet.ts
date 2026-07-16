/**
 * sheet.ts — production-local merge-aware sheet reader (MC + Ivy workbooks).
 *
 * WHY THIS EXISTS (not lib/xlsx): both production extractors open their workbooks
 * with openpyxl `read_only=True` (extract_daily_production.py:775,
 * extract_waste_production.py:313). In read_only mode openpyxl returns the STORED
 * value of every cell — and a merged region stores its value ONLY in the top-left
 * anchor; every other covered cell is `None`. exceljs instead returns the MASTER's
 * value on covered cells too.
 *
 * The MC Daily Production Report is merge-heavy (261 merged ranges per day-sheet).
 * Verified empirically (2026-07-04) that read cells the extractor touches ARE
 * covered non-anchor cells — e.g. C13 (covered by C7 "SHIFT"), truck rows 49/51
 * C/D/E/F/H/J/K (covered by row-48/50 anchors), PUMP row 67 D/E. openpyxl yields
 * None for all of them; exceljs yields "SHIFT" / "AAV 6111" / etc. Without nulling
 * these, the truck extractor would fabricate plate rows and the day-total logic
 * would read "SHIFT" instead of None — a hard parity break.
 *
 * So production reads through this local wrapper, which returns null for any
 * non-anchor merged cell, exactly reproducing openpyxl's read_only behavior. The
 * value-unwrapping mirrors lib/xlsx.ts::cellValue verbatim, so non-merged cells
 * behave identically. This is the same fix flecon/sheet.ts applies for a different
 * (read_only=False) merge case — kept local (no cross-imports) per the scope fence.
 */
import ExcelJS from "exceljs";
import type { LoadedWorkbook, LoadedSheet, CellValue } from "../../lib/xlsx.js";

/** Unwrap an exceljs cell value to the openpyxl-equivalent `.value` (see lib/xlsx). */
function unwrap(cell: ExcelJS.Cell): CellValue {
  const v = cell.value;
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v;
  if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") return v;
  if (typeof v === "object") {
    const o = v as unknown as Record<string, unknown>;
    if ("result" in o) {
      const r = o.result;
      if (r === null || r === undefined) return null;
      if (r instanceof Date) return r;
      if (typeof r === "string" || typeof r === "number" || typeof r === "boolean") return r;
      return null;
    }
    if ("richText" in o && Array.isArray(o.richText)) {
      return (o.richText as Array<{ text?: string }>).map((t) => t.text ?? "").join("");
    }
    if ("text" in o && typeof o.text === "string") return o.text;
    if ("error" in o) return null;
  }
  return null;
}

/**
 * Load a production workbook (MC or Ivy) with openpyxl-`read_only`-parity merged-cell
 * semantics. Returns the SAME LoadedWorkbook/LoadedSheet interface lib/xlsx exposes,
 * so extractMc.ts / extractIvy.ts are source-agnostic — the ONLY difference from
 * lib/xlsx is that covered (non-anchor) merged cells read null.
 */
export async function loadProductionWorkbook(data: Buffer): Promise<LoadedWorkbook> {
  const wb = new ExcelJS.Workbook();
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
        const c = ws.getRow(row).getCell(col);
        // openpyxl read_only: only the anchor of a merged region carries the value;
        // every covered cell is None. exceljs marks covered cells isMerged with a
        // `.master` pointing at the anchor — return null unless this IS the anchor.
        const master = (c as ExcelJS.Cell & { master?: ExcelJS.Cell }).master;
        if (c.isMerged && master && master !== c) return null;
        return unwrap(c);
      },
    };
  };

  return {
    sheetNames,
    sheet(name: string) {
      return wrapSheet(wb.getWorksheet(name));
    },
    sheetAt(index: number) {
      const nm = sheetNames[index];
      return nm ? wrapSheet(wb.getWorksheet(nm)) : null;
    },
  };
}
