/**
 * sheet.ts — deliveries-local merge-aware sheet reader + active-tab resolution.
 *
 * WHY THIS EXISTS (not lib/xlsx): the deliveries extractor
 * (extract_rc_deliveries.py) opens the workbook with
 * `load_workbook(data_only=True, read_only=True)`. In BOTH openpyxl modes a merged
 * region's value lives ONLY in the TOP-LEFT anchor cell; every OTHER covered cell
 * reads `None`. exceljs's `cell.value` instead returns the MASTER's value on covered
 * cells too. The real RC DELIVERIES workbook has merged cells inside the data region
 * (e.g. C29:C30 / D29:D30 in JULY 26), so the exceljs default would DUPLICATE the
 * anchor value down onto the covered rows — a silent divergence from the Python. This
 * is the same MERGED-CELL TRAP the flecon porter hit (see src/reports/flecon/sheet.ts,
 * whose pattern we copy — we cannot import from flecon/, so this is a local mirror).
 *
 * lib/xlsx.ts::cellValue deliberately does NOT follow merges, but it also does NOT
 * NULL OUT covered cells, and it is a SHARED file this porter may not edit. So the
 * deliveries extractor reads through this local wrapper, which returns null for any
 * non-anchor merged cell, exactly reproducing openpyxl's covered-cell behavior.
 *
 * It ALSO resolves the "active sheet" the way sync_deliveries.py relies on: the
 * Python passes no --sheet / --all-sheets, so extract_rc_deliveries.py defaults to
 * `wb.active.title` — the sheet that was selected when the workbook was last saved.
 * openpyxl reads this from the workbook view's `activeTab` attribute; exceljs exposes
 * the same value at `wb.views[0].activeTab` (a 0-based index into the ordered sheet
 * list). activeSheetName() reproduces that selection.
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

export interface DeliveriesWorkbook extends LoadedWorkbook {
  /** The name of the last-saved active sheet (openpyxl `wb.active.title` parity). */
  activeSheetName(): string | null;
}

/**
 * Load the RC DELIVERIES workbook with openpyxl-parity merged-cell semantics AND
 * active-tab resolution. Returns the SAME LoadedWorkbook/LoadedSheet interface
 * lib/xlsx exposes (so extract.ts is source-agnostic), plus activeSheetName().
 * The ONLY read difference vs lib/xlsx is that covered (non-anchor) merged cells
 * read null.
 */
export async function loadDeliveriesWorkbook(data: Buffer): Promise<DeliveriesWorkbook> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(data as unknown as ExcelJS.Buffer);

  // eachSheet iterates in orderNo order, which is exactly the order activeTab indexes.
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
        // openpyxl: only the anchor of a merged region carries the value; covered
        // cells are None. exceljs marks covered cells isMerged with `.master` at the
        // anchor — return null unless this IS the anchor.
        const master = (c as ExcelJS.Cell & { master?: ExcelJS.Cell }).master;
        if (c.isMerged && master && master !== c) return null;
        return unwrap(c);
      },
    };
  };

  // openpyxl `wb.active` = the sheet at the workbook view's activeTab index.
  const activeTab = wb.views?.[0]?.activeTab ?? 0;
  const activeName = sheetNames[activeTab] ?? sheetNames[0] ?? null;

  return {
    sheetNames,
    sheet(name: string) {
      return wrapSheet(wb.getWorksheet(name));
    },
    sheetAt(index: number) {
      const nm = sheetNames[index];
      return nm ? wrapSheet(wb.getWorksheet(nm)) : null;
    },
    activeSheetName() {
      return activeName;
    },
  };
}
