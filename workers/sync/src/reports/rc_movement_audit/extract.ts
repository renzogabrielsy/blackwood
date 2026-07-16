/**
 * extract.ts — local TS port of extract_rc_movement.py (read the Python as spec).
 *
 * SCOPE FENCE: rc_out/extract.ts already ports this extractor for its own gates, but
 * this port owns ONLY src/reports/rc_movement_audit/** and may NOT import from rc_out/.
 * This is an independent, byte-faithful local copy of the RC MOVEMENT extractor.
 *
 * Behavioral law: workers/sync/specs/rc_movement_audit.md §2. The reconciler only
 * consumes `date_to_fed_kls` (date → summed daily fed total). The per-row
 * `product_breakdown` the Python captures is informational and unused by any gate, so
 * it is deliberately NOT ported (rc_movement_audit.md §2 "product_breakdown" note).
 *
 * PARITY DISCIPLINE: bug-for-bug against the Python oracle (PORTING_DECISIONS governing
 * principle). Every rule site cites its Python source line.
 *
 * MERGED-CELL NOTE: the real RC MOVEMENT workbook DOES contain merged cells (44 ranges
 * across the month tabs), but NONE of them touch column A (date) or column B (fed) —
 * verified empirically. The extractor only ever reads cols A/B for load-bearing data,
 * so the flecon-style merge wrapper is NOT needed here (same conclusion as gsheet).
 * Uses the shared lib/xlsx.loadWorkbook directly.
 */
import type { LoadedWorkbook, LoadedSheet, CellValue } from "../../lib/xlsx.js";
import { coerceFloat, coerceDate } from "../../lib/norm.js";

const WEIGHT_KG_MAX = 200_000; // extract_rc_movement.py:48

/** extract_rc_movement.py:132 SECTION_BREAK_TOKENS — a string col-A value STOPS the scan. */
const SECTION_BREAK_TOKENS = new Set([
  "SUPPLIERS",
  "REMARKS:",
  "REMARKS",
  "NOTES",
  "TOTAL",
  "TOTALS",
]);

/**
 * extract_rc_movement.py:88-92 coerce_str: None→null; else str(v).strip(); empty→null.
 * Used for the DATE-header detection and the section-break token check.
 */
function coerceStr(value: CellValue): string | null {
  if (value === null || value === undefined) return null;
  const s = pyStr(value).trim();
  return s ? s : null;
}

/** Mirror of Python str() for the cell shapes coerce_str receives (label/text cells). */
function pyStr(value: CellValue): string {
  if (value instanceof Date) {
    // Not exercised: header/token cells are text, never date cells. Kept faithful.
    const p = (n: number, w = 2) => String(n).padStart(w, "0");
    return (
      `${p(value.getUTCFullYear(), 4)}-${p(value.getUTCMonth() + 1)}-${p(value.getUTCDate())} ` +
      `${p(value.getUTCHours())}:${p(value.getUTCMinutes())}:${p(value.getUTCSeconds())}`
    );
  }
  if (typeof value === "boolean") return value ? "True" : "False";
  return String(value);
}

/**
 * extract_rc_movement.py:51-67 coerce_date. openpyxl already decodes Excel date serials
 * to native dates before Python sees them; exceljs likewise yields a JS Date, both flow
 * through lib/norm.coerceDate. This variant ALSO treats a bare "-" string as null (the
 * Python guards `s == "-"` at line 60), which lib/norm.coerceDate does not, so guard here.
 */
function rcmCoerceDateISO(value: CellValue): string | null {
  if (typeof value === "string") {
    const s = value.trim();
    if (!s || s === "-") return null;
  }
  return coerceDate(value);
}

/**
 * extract_rc_movement.py:70-85 coerce_float. Treats a bare "-" string (after comma-strip
 * + trim) as null (Python line 79), which lib/norm.coerceFloat does not, so guard here.
 * lib/norm.coerceFloat otherwise matches: strips commas, rejects bool, parses numeric str.
 */
function rcmCoerceFloat(value: CellValue): number | null {
  if (typeof value === "string") {
    const cleaned = value.replace(/,/g, "").trim();
    if (!cleaned || cleaned === "-") return null;
  }
  return coerceFloat(value);
}

/** One emitted movement row — mirrors extract_rc_movement.py:163-169 (only load-bearing fields). */
export interface MovementRow {
  transaction_date: string;
  raw_charcoal_fed_kls: number;
  _source_row: number;
  _source_sheet: string;
}

export interface MovementExtract {
  rows: MovementRow[];
  /** date → summed fed_kls across ALL month-tabs (L-022 cross-month summing). */
  date_to_fed_kls: Record<string, number>;
}

/**
 * extract_rc_movement.py:109-171 extract_sheet — extract per-date fed totals from one
 * RC MOVEMENT month sheet. Returns just the rows (warnings are informational and not
 * consumed by the reconciler / oracle).
 */
function extractSheet(ws: LoadedSheet): MovementRow[] {
  // Header detection: the first row (scanned 1..9) whose col-A value stripped+uppercased
  // == "DATE" (extract_rc_movement.py:115-123). None → skip the sheet entirely.
  let headerRow: number | null = null;
  const scanMax = Math.min(ws.rowCount, 9);
  for (let r = 1; r <= scanMax; r++) {
    const v = coerceStr(ws.cell(r, 1));
    if (v && v.toUpperCase() === "DATE") {
      headerRow = r;
      break;
    }
  }
  if (headerRow === null) return [];

  const rows: MovementRow[] = [];
  // Data starts 3 rows below the DATE header (skip sub-header + unit row).
  // extract_rc_movement.py:134.
  const dataStart = headerRow + 3;
  for (let r = dataStart; r <= ws.rowCount; r++) {
    const aVal = ws.cell(r, 1);
    // Section break: a STRING col-A value in the token set STOPS the scan (break, not
    // continue) — extract_rc_movement.py:138-141.
    if (typeof aVal === "string") {
      const stripped = aVal.trim().toUpperCase();
      if (SECTION_BREAK_TOKENS.has(stripped)) break;
    }

    const d = rcmCoerceDateISO(aVal);
    // Non-date, non-token col A → silently skip (continue) — allows blank/spacer rows
    // between dates without terminating the scan (extract_rc_movement.py:143-145).
    if (d === null) continue;

    const fedKls = rcmCoerceFloat(ws.cell(r, 2));
    // Date present but no fed total → Python warns + skips the row (extract_rc_movement.py:146-150).
    if (fedKls === null) continue;
    // fed out of [0, 200000] only WARNS in Python; the row is STILL emitted (line 151-152).
    void WEIGHT_KG_MAX;

    rows.push({
      transaction_date: d,
      raw_charcoal_fed_kls: fedKls,
      _source_row: r,
      _source_sheet: ws.name,
    });
  }

  return rows;
}

/**
 * Port of extract_rc_movement.py main() with --all-sheets (audit_rc_movement.py:95 always
 * passes --all-sheets). Iterates wb.sheetnames in order.
 *
 * L-022 (extract_rc_movement.py:219-222): a boundary date can appear on MORE THAN ONE
 * month-tab (e.g. 2026-05-29 closes out the MAY tab and opens the JUNE tab) with DIFFERENT
 * fed portions. SUM across every row sharing a date, across all sheets — NEVER overwrite —
 * rounding the running total to 2dp on each accumulation step. A dict-literal assignment
 * would silently undercount a cross-month date and false-trip the O>M duplication gate.
 * This uses a running-sum accumulator keyed by date string, exactly like the Python.
 */
export function extractMovement(wb: LoadedWorkbook): MovementExtract {
  const rows: MovementRow[] = [];
  for (const name of wb.sheetNames) {
    const ws = wb.sheet(name);
    if (!ws) continue;
    rows.push(...extractSheet(ws));
  }

  const dateIndex: Record<string, number> = {};
  for (const r of rows) {
    const d = r.transaction_date;
    // round(prev + fed, 2) each step — matches extract_rc_movement.py:222.
    dateIndex[d] = round2((dateIndex[d] ?? 0.0) + r.raw_charcoal_fed_kls);
  }

  return { rows, date_to_fed_kls: dateIndex };
}

/**
 * Python round(x, 2). The movement fed totals are plain kg readings, never at a true
 * .5-boundary that would expose a half-up vs half-even divergence, so a fixed-decimal
 * round is safe here (banker's rounding is reserved for norm_num diff comparisons).
 */
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
