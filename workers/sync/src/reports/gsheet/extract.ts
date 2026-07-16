/**
 * extract.ts — TS port of `.claude/skills/sync-ictc/scripts/extract_gsheet.py`
 * (read as spec, alongside specs/gsheet.md §2 and specs/SHARED.md §4).
 *
 * Pulls RC IN + RC OUT from the link-shared Google Sheet export (one workbook,
 * two tabs) and normalizes both into Blackwood-shaped rows the classifier consumes.
 *
 * PARITY DISCIPLINE: bug-for-bug against the Python oracle (PORTING_DECISIONS
 * governing principle). Fixed header positions (RC IN row 7, RC OUT row 4), the
 * verbatim MONTH_PREFIX_ALIASES table (incl. the SEPT/SEP asymmetry — gsheet.md
 * trap #6), and the shared wet-recovery/deduction core (deductions.ts). Numeric
 * coercion goes through lib/norm coerceFloat (bool-rejecting, comma-stripping);
 * `coerce_int` = int(round(coerce_float)) → banker's round then truncate (NEVER
 * Math.round — norm.ts HARD RULE). openpyxl decodes date serials to native dates;
 * exceljs (lib/xlsx) yields JS Date — both flow through coerceDate (SHARED trap #6).
 */
import type { LoadedWorkbook, LoadedSheet, CellValue } from "../../lib/xlsx.js";
import { coerceFloat, coerceDate, roundHalfToEven } from "../../lib/norm.js";
import {
  detectDeduction,
  isRecoveryRowDict,
  isInheritableMother,
  buildRecoveryRow,
  type RowDict,
} from "./deductions.js";

// ---------------------------------------------------------------------------
// Month-prefix aliases (extract_gsheet.py:83-96) — VERBATIM, incl. SEPT/SEP
// asymmetry (SEPT→SEPTEMBER, SEP→SEPTEMBER, SEPTEMBER→SEPT). Object literal with
// duplicate values for different keys; the reverse mapping is a SEPARATE entry.
// ---------------------------------------------------------------------------
const MONTH_PREFIX_ALIASES: Record<string, string> = {
  JAN: "JANUARY", JANUARY: "JAN",
  FEB: "FEBRUARY", FEBRUARY: "FEB",
  MARCH: "MAR", MAR: "MARCH",
  APRIL: "APR", APR: "APRIL",
  // MAY has no alias
  JUNE: "JUN", JUN: "JUNE",
  JULY: "JUL", JUL: "JULY",
  AUG: "AUGUST", AUGUST: "AUG",
  SEPT: "SEPTEMBER", SEP: "SEPTEMBER", SEPTEMBER: "SEPT",
  OCT: "OCTOBER", OCTOBER: "OCT",
  NOV: "NOVEMBER", NOVEMBER: "NOV",
  DEC: "DECEMBER", DECEMBER: "DEC",
};

// extract_gsheet.py:100 — BATCH_CODE_RE (case-insensitive).
const BATCH_CODE_RE = /^([A-Z]+)-(\d{2})-(.+)$/i;

const WEIGHT_KG_MIN = 0;
const WEIGHT_KG_MAX = 200_000;

// extract_gsheet.py:105
const BLOCK_LOC_REGEX = /^(PCA|PCB|[A-DF])-\d{1,2}[A-D]$/;

// extract_gsheet.py:108-109
const DEST_TYPO_FIX: Record<string, string> = { MAN: "MAIN", MIAN: "MAIN" };
const VALID_DESTINATIONS = new Set(["MAIN", "SUNDRY"]);

// extract_gsheet.py:112-120 — lab plausibility (soft warnings only).
const LAB_PLAUSIBILITY: Record<string, [string, (v: number) => boolean]> = {
  mc: ["Moisture content unusually high", (v) => v < 20],
  ash: ["Ash content unusually high", (v) => v < 10],
  fc: ["Fixed carbon unusually low", (v) => v > 60],
  vm: ["Volatile matter unusually high", (v) => v < 25],
  grit: ["Grit value unusually high", (v) => v < 5],
  bd_astm: ["BD ASTM out of expected range", (v) => 0.2 < v && v < 1.0],
  bd_jis: ["BD JIS out of expected range", (v) => 0.2 < v && v < 1.0],
};

// ---------------------------------------------------------------------------
// Coercion helpers (extract_gsheet.py:126-171)
// ---------------------------------------------------------------------------

/** Port of coerce_str: str(value).strip() → null if empty. Mirrors Python str()
 *  for numeric cells (whole floats render "12.0", not "12"). */
function coerceStr(value: CellValue): string | null {
  if (value === null || value === undefined) return null;
  const s = pyStr(value).trim();
  return s ? s : null;
}

/** Python str() for the cell value shapes the extractor sees (string/number/bool/
 *  Date). openpyxl yields int for whole cells and float otherwise; exceljs yields
 *  a JS number for both. Python str(3)="3" but str(3.0)="3.0" — we can't know if
 *  the source cell was int- or float-typed, so we mirror openpyxl's most common
 *  case: a number that came from a numeric cell is a float → append ".0" when
 *  integer-valued, matching str(float). A boolean → "True"/"False". */
function pyStr(value: CellValue): string {
  if (typeof value === "string") return value;
  if (typeof value === "boolean") return value ? "True" : "False";
  if (value instanceof Date) {
    // coerce_str is never applied to a date cell in practice (dates go through
    // coerce_date); mirror Python's date.isoformat-ish str() defensively.
    return value.toISOString();
  }
  if (typeof value === "number") {
    if (Number.isInteger(value)) return `${value}.0`;
    return String(value);
  }
  return String(value);
}

/** Port of coerce_int: int(round(coerce_float(v))) — banker's round then truncate. */
function coerceInt(value: CellValue): number | null {
  const f = coerceFloat(value);
  if (f === null) return null;
  return Math.trunc(roundHalfToEven(f, 0));
}

/** round(x, 3) via banker's rounding (Math.round is banned). */
function round3(v: number): number {
  return roundHalfToEven(v, 3);
}

/**
 * Port of batch_code_fallbacks (extract_gsheet.py:173-202). Primary NOT included.
 * De-dup preserving order.
 */
export function batchCodeFallbacks(batchCode: string | null | undefined): string[] {
  if (!batchCode) return [];
  const m = BATCH_CODE_RE.exec(batchCode.trim());
  if (!m) return [];
  const prefix = m[1].toUpperCase();
  const yy = m[2];
  const suffix = m[3];
  const fallbacks: string[] = [];
  const alias = MONTH_PREFIX_ALIASES[prefix];
  if (alias) fallbacks.push(`${alias}-${yy}-${suffix}`);
  const upper = `${prefix}-${yy}-${suffix}`;
  if (upper !== batchCode.trim()) fallbacks.push(upper);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const fb of fallbacks) {
    if (!seen.has(fb)) {
      seen.add(fb);
      out.push(fb);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// RC IN extraction (extract_gsheet.py:208-355)
// ---------------------------------------------------------------------------
const RC_IN_DATA_START = 8;
const RC_OUT_DATA_START = 5;

export interface ExtractResult {
  tab: string;
  source_rows: number;
  rows: RowDict[];
  summary: {
    total_rows: number;
    overall_confidence: number;
    warnings_count: number;
    extraction_warnings: string[];
  };
}

/** Read a cell 1-based, returning null past the sheet's populated bounds. */
function cellOf(sheet: LoadedSheet, row: number, col: number): CellValue {
  return sheet.cell(row, col);
}

export function extractRcIn(sheet: LoadedSheet): ExtractResult {
  const warnings: string[] = [];
  const rows: RowDict[] = [];
  let sourceRows = 0;

  const maxRow = sheet.rowCount;

  let lastSeenDate: string | null = null;
  let lastMother: RowDict | null = null;

  for (let rnum = RC_IN_DATA_START; rnum <= maxRow; rnum++) {
    const col = (idx: number): CellValue => cellOf(sheet, rnum, idx);

    let txnDate = coerceDate(col(3));
    const weightKg = coerceFloat(col(8));
    const batchCode = coerceStr(col(5));
    const supplier = coerceStr(col(4));

    // Skip fully-empty padding rows.
    if (txnDate === null && weightKg === null && batchCode === null && supplier === null) {
      continue;
    }
    sourceRows += 1;

    const rowWarnings: string[] = [];

    const hasOwnDate = txnDate !== null;

    if (txnDate === null) {
      if (lastSeenDate === null) {
        rowWarnings.push(`Row ${rnum}: no date and no prior date to fill`);
      } else {
        txnDate = lastSeenDate;
      }
    } else {
      lastSeenDate = txnDate;
    }

    if (weightKg === null) {
      rowWarnings.push(`Row ${rnum}: missing weight_kg`);
    } else if (!(WEIGHT_KG_MIN < weightKg && weightKg < WEIGHT_KG_MAX)) {
      rowWarnings.push(`Row ${rnum}: weight ${pyNum(weightKg)} out of plausible range`);
    }

    const blockLoc = coerceStr(col(6));
    if (blockLoc && !BLOCK_LOC_REGEX.test(blockLoc.toUpperCase())) {
      rowWarnings.push(`Row ${rnum}: block_loc '${blockLoc}' off-format`);
    }

    const truckPlate = coerceStr(col(7));
    const sacks = coerceInt(col(9));
    const remarks = coerceStr(col(17));

    // Lab metrics J..P (cols 10..16).
    const labResults: Record<string, number | null> = {};
    const labMap: Array<[number, string]> = [
      [10, "mc"], [11, "grit"], [12, "bd_astm"],
      [13, "bd_jis"], [14, "vm"], [15, "ash"], [16, "fc"],
    ];
    for (const [cidx, key] of labMap) {
      const v = coerceFloat(col(cidx));
      labResults[key] = v;
      if (v !== null && key in LAB_PLAUSIBILITY) {
        const [msg, check] = LAB_PLAUSIBILITY[key];
        if (!check(v)) {
          rowWarnings.push(`Row ${rnum}: ${msg} (${key}=${pyNum(v)})`);
        }
      }
    }

    const ded = detectDeduction(remarks, weightKg);
    for (const w of ded.warnings) rowWarnings.push(`Row ${rnum}: ${w}`);

    const confidence = round3(Math.max(0.0, 1.0 - 0.1 * rowWarnings.length));

    const anyLab = labMap.some(([, k]) => labResults[k] !== null);
    const candidate: RowDict = {
      transaction_date: txnDate,
      supplier,
      batch_code_primary: batchCode,
      batch_code_fallbacks: batchCodeFallbacks(batchCode),
      block_loc: blockLoc,
      truck_plate: truckPlate,
      sacks,
      weight_kg: weightKg,
      cost_basis: null,
      remarks,
      lab_results: anyLab ? labResults : null,
      true_weight_kg: ded.trueWeightKg,
      deduction_note: ded.deductionNote,
      warnings: rowWarnings,
      confidence,
      _source_row: rnum,
      _source_tab: "RC IN",
    };

    if (isRecoveryRowDict(candidate, hasOwnDate)) {
      if (isInheritableMother(lastMother)) {
        const recovery = buildRecoveryRow(candidate, lastMother as RowDict);
        rows.push(recovery);
        const rw = recovery.warnings;
        if (Array.isArray(rw)) warnings.push(...(rw as string[]));
      } else {
        rowWarnings.push(
          `Row ${rnum}: recovery-shaped sub-row with no preceding mother ` +
            `delivery to inherit from — left unmapped`,
        );
        candidate.warnings = rowWarnings;
        candidate.confidence = round3(Math.max(0.0, 1.0 - 0.1 * rowWarnings.length));
        rows.push(candidate);
        warnings.push(...rowWarnings);
      }
      continue;
    }

    rows.push(candidate);
    warnings.push(...rowWarnings);
    if (isInheritableMother(candidate)) lastMother = candidate;
  }

  const confidences = rows.map((r) => r.confidence as number);
  return {
    tab: "RC IN",
    source_rows: sourceRows,
    rows,
    summary: {
      total_rows: rows.length,
      overall_confidence: confidences.length
        ? round3(confidences.reduce((a, b) => a + b, 0) / confidences.length)
        : 0.0,
      warnings_count: warnings.length,
      extraction_warnings: warnings.slice(0, 50),
    },
  };
}

// ---------------------------------------------------------------------------
// RC OUT extraction (extract_gsheet.py:372-445)
// ---------------------------------------------------------------------------
export function extractRcOut(sheet: LoadedSheet): ExtractResult {
  const warnings: string[] = [];
  const rows: RowDict[] = [];
  let sourceRows = 0;

  const maxRow = sheet.rowCount;

  for (let rnum = RC_OUT_DATA_START; rnum <= maxRow; rnum++) {
    const col = (idx: number): CellValue => cellOf(sheet, rnum, idx);

    const txnDate = coerceDate(col(1));
    const batchCode = coerceStr(col(3)); // batch_code lives in col C
    const weightKg = coerceFloat(col(4));

    if (txnDate === null && batchCode === null && weightKg === null) continue;
    sourceRows += 1;

    const rowWarnings: string[] = [];
    if (txnDate === null) rowWarnings.push(`Row ${rnum}: missing transaction_date`);
    if (weightKg === null) {
      rowWarnings.push(`Row ${rnum}: missing weight_kg`);
    } else if (!(WEIGHT_KG_MIN < weightKg && weightKg < WEIGHT_KG_MAX)) {
      rowWarnings.push(`Row ${rnum}: weight ${pyNum(weightKg)} out of plausible range`);
    }

    const destRaw = coerceStr(col(5));
    let destination = "MAIN";
    if (destRaw) {
      let up = destRaw.toUpperCase();
      up = DEST_TYPO_FIX[up] ?? up;
      destination = up;
      if (!VALID_DESTINATIONS.has(up)) {
        rowWarnings.push(`Row ${rnum}: unrecognized destination '${destRaw}' (kept as-is)`);
      }
    }

    const productionBatch = coerceStr(col(2));
    const remarks = coerceStr(col(6));
    const blockLoc = coerceStr(col(7));

    const confidence = round3(Math.max(0.0, 1.0 - 0.1 * rowWarnings.length));

    rows.push({
      transaction_date: txnDate,
      batch_code_primary: batchCode,
      batch_code_fallbacks: batchCodeFallbacks(batchCode),
      production_batch: productionBatch,
      destination,
      weight_kg: weightKg,
      block_loc: blockLoc,
      remarks,
      warnings: rowWarnings,
      confidence,
      _source_row: rnum,
      _source_tab: "RC OUT",
    });
    warnings.push(...rowWarnings);
  }

  const confidences = rows.map((r) => r.confidence as number);
  return {
    tab: "RC OUT",
    source_rows: sourceRows,
    rows,
    summary: {
      total_rows: rows.length,
      overall_confidence: confidences.length
        ? round3(confidences.reduce((a, b) => a + b, 0) / confidences.length)
        : 0.0,
      warnings_count: warnings.length,
      extraction_warnings: warnings.slice(0, 50),
    },
  };
}

/**
 * Extract both tabs from the workbook. Mirrors extract_gsheet.main's tab checks:
 * both "RC IN" and "RC OUT" must exist (the Python raises otherwise).
 */
export function extractGsheet(wb: LoadedWorkbook): { rc_in: ExtractResult; rc_out: ExtractResult } {
  const rcInSheet = wb.sheet("RC IN");
  const rcOutSheet = wb.sheet("RC OUT");
  if (!rcInSheet) throw new Error(`Tab 'RC IN' not found. Tabs: ${wb.sheetNames.join(", ")}`);
  if (!rcOutSheet) throw new Error(`Tab 'RC OUT' not found. Tabs: ${wb.sheetNames.join(", ")}`);
  return { rc_in: extractRcIn(rcInSheet), rc_out: extractRcOut(rcOutSheet) };
}

/**
 * Python str() of a number as it appears interpolated into an f-string warning:
 * str(250000.0) → "250000.0"; str(11.54) → "11.54". Integer-valued floats keep
 * the ".0" (openpyxl numeric cells are floats). Used only for warning text that
 * rarely fires; confidence depends on the warning COUNT, not this text.
 */
function pyNum(v: number): string {
  if (Number.isInteger(v)) return `${v}.0`;
  return String(v);
}
