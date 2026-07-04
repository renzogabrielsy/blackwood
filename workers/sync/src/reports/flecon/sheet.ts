/**
 * sheet.ts — flecon-local merge-aware sheet reader.
 *
 * WHY THIS EXISTS (not lib/xlsx): openpyxl's default load (read_only=False, which
 * extract_flecon_bags.py uses) puts a merged region's value in the TOP-LEFT ANCHOR
 * cell only; every OTHER covered cell reads `None`. exceljs's `cell.value` instead
 * returns the MASTER's value on covered cells too. flecon's header signature is built
 * from vertically-MERGED cells (e.g. C5:C6), so the exceljs default DUPLICATES the
 * label across rows 5 AND 6 → "590 kls(Kuraray) 590 kls(Kuraray)" instead of the
 * oracle's single "590 kls(Kuraray)".
 *
 * lib/xlsx.ts::cellValue deliberately does NOT follow merges, but it also does NOT
 * NULL OUT covered cells — and it's a SHARED file this porter may not edit. So flecon
 * reads through this local wrapper, which returns null for any non-anchor merged cell,
 * exactly reproducing openpyxl's read_only=False behavior the Python relies on.
 *
 * The value-unwrapping (formula result / rich text / hyperlink / date / error→null)
 * mirrors lib/xlsx.ts::cellValue verbatim, so non-merged cells behave identically.
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
 * Load the FLECON workbook with openpyxl-parity merged-cell semantics. Returns the
 * SAME LoadedWorkbook/LoadedSheet interface lib/xlsx exposes, so extract.ts is
 * source-agnostic — the ONLY difference is covered (non-anchor) merged cells read null.
 */
export async function loadFleconWorkbook(data: Buffer): Promise<LoadedWorkbook> {
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
        // openpyxl read_only=False: only the anchor of a merged region carries the
        // value; covered cells are None. exceljs marks covered cells isMerged with a
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
