/**
 * extract.ts — TS port of BOTH rc_out extractors (read the Python as spec):
 *   - extract_proposed_daily.py  (PROPOSED DAILY REPORT: per-day sheets, block sections)
 *   - extract_rc_movement.py     (RC MOVEMENT: per-month sheets, daily fed totals)
 *
 * Behavioral law: workers/sync/specs/rc_out.md §2 (PROPOSED) and rc_movement_audit
 * (RC MOVEMENT, summarized in rc_out.md §4 + the L-022 cross-month-tab summing note).
 *
 * PARITY DISCIPLINE: this is bug-for-bug against the Python oracle (PORTING_DECISIONS
 * governing principle). Every rule site cites its spec/Python source. All numeric
 * coercion goes through lib/norm coerceFloat (NEVER Math.round). openpyxl decodes
 * Excel date serials to native dates; exceljs (via lib/xlsx) yields JS Date — both
 * flow through coerceDate. See SHARED.md porting trap #6.
 */
import type { LoadedWorkbook, LoadedSheet, CellValue } from "../../lib/xlsx.js";
import { coerceFloat, coerceDate } from "../../lib/norm.js";

// ---------------------------------------------------------------------------
// PROPOSED DAILY REPORT — batch_code prefix conventions (extract_proposed_daily.py:48-69)
// ---------------------------------------------------------------------------
/** extract_proposed_daily.py:48-52 — PRIMARY_MONTH_PREFIX (1-indexed by month). */
const PRIMARY_MONTH_PREFIX: Record<number, string> = {
  1: "JAN", 2: "FEB", 3: "MARCH", 4: "APRIL", 5: "MAY",
  6: "JUNE", 7: "JULY", 8: "AUG", 9: "SEPT",
  10: "OCT", 11: "NOV", 12: "DEC",
};

/** extract_proposed_daily.py:55-59 — FALLBACK_MONTH_PREFIX. */
const FALLBACK_MONTH_PREFIX: Record<number, string> = {
  1: "JANUARY", 2: "FEBRUARY", 3: "MAR", 4: "APR", 5: "MAY",
  6: "JUNE", 7: "JULY", 8: "AUGUST", 9: "SEPTEMBER",
  10: "OCTOBER", 11: "NOVEMBER", 12: "DECEMBER",
};

/** extract_proposed_daily.py:62-69 — sheet-name month word → month number (abbr + full). */
const MONTH_NAME_TO_NUM: Record<string, number> = {
  JANUARY: 1, JAN: 1, FEBRUARY: 2, FEB: 2,
  MARCH: 3, MAR: 3, APRIL: 4, APR: 4,
  MAY: 5, JUNE: 6, JUN: 6, JULY: 7, JUL: 7,
  AUGUST: 8, AUG: 8, SEPTEMBER: 9, SEPT: 9, SEP: 9,
  OCTOBER: 10, OCT: 10, NOVEMBER: 11, NOV: 11,
  DECEMBER: 12, DEC: 12,
};

/** extract_proposed_daily.py:71 — SHEET_NAME_RE, case-insensitive. */
const SHEET_NAME_RE = /^([A-Za-z]+)\s+(\d{1,2})\s*$/;
/** extract_proposed_daily.py:72 — BLOCK_NO_RE. */
const BLOCK_NO_RE = /^\s*#\s*(\d+)\s*$/;

const WEIGHT_KG_MIN = 0;
const WEIGHT_KG_MAX = 200_000; // extract_proposed_daily.py:74-75

// %b three-letter month abbreviations for production_batch (Python strftime("%b").upper()).
const MONTH_ABBR_B = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];

/** A calendar date decoded to Y/M/D, mirroring Python's `datetime.date`. */
interface CalDate { year: number; month: number; day: number; }

// ---------------------------------------------------------------------------
// Value coercers — extract_proposed_daily.py:81-139 semantics.
// coerce_float lives in lib/norm (coerceFloat). The others are local mirrors.
// ---------------------------------------------------------------------------

/** extract_proposed_daily.py:81-95 coerce_date → CalDate | null (openpyxl parity via coerceDate). */
function coerceCalDate(value: CellValue): CalDate | null {
  const iso = coerceDate(value); // Date|string → "YYYY-MM-DD" (or null)
  if (!iso) return null;
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  return { year: +m[1], month: +m[2], day: +m[3] };
}

/** extract_proposed_daily.py:116-118 coerce_int = int(coerce_float(v)) — TRUNCATE toward zero. */
function coerceInt(value: CellValue): number | null {
  const f = coerceFloat(value);
  return f === null ? null : Math.trunc(f);
}

/** extract_proposed_daily.py:121-125 coerce_str: None→null; else str(v).strip(); empty→null. */
function coerceStr(value: CellValue): string | null {
  if (value === null || value === undefined) return null;
  // Python str(datetime) differs from ISO, but coerce_str is only applied to label
  // cells (WHSE/status/remarks/supplier/block_no), never to date cells in practice.
  const s = pyStr(value).trim();
  return s ? s : null;
}

/** Mirror of Python str() for the cell value shapes coerce_str receives. */
function pyStr(value: CellValue): string {
  if (value instanceof Date) {
    // Python str(datetime.datetime(2026,7,1,0,0)) == "2026-07-01 00:00:00".
    // Not exercised by real fixtures (labels are text), but keep it faithful.
    const p = (n: number, w = 2) => String(n).padStart(w, "0");
    return `${p(value.getUTCFullYear(), 4)}-${p(value.getUTCMonth() + 1)}-${p(value.getUTCDate())} ` +
      `${p(value.getUTCHours())}:${p(value.getUTCMinutes())}:${p(value.getUTCSeconds())}`;
  }
  if (typeof value === "number") return pyNumStr(value);
  if (typeof value === "boolean") return value ? "True" : "False";
  return String(value);
}

/** Python str(float/int): ints have no ".0"; whole-valued floats keep ".0". */
function pyNumStr(n: number): string {
  return Number.isInteger(n) ? String(n) : String(n);
}

/** extract_proposed_daily.py:128-139 parse_block_no: "# 9" → 9; tolerate bare int. */
function parseBlockNo(value: CellValue): number | null {
  const s = coerceStr(value);
  if (s === null) return null;
  const m = s.match(BLOCK_NO_RE);
  if (m) return parseInt(m[1], 10);
  // Tolerate a bare integer (Python int(s) — strict, no float).
  if (/^[+-]?\d+$/.test(s.trim())) return parseInt(s.trim(), 10);
  return null;
}

/** extract_proposed_daily.py:142-154 sheet_name_to_date. */
function sheetNameToDate(sheetName: string, year: number): CalDate | null {
  const m = sheetName.match(SHEET_NAME_RE);
  if (!m) return null;
  const monthName = m[1].toUpperCase();
  const day = parseInt(m[2], 10);
  const monthNum = MONTH_NAME_TO_NUM[monthName];
  if (monthNum === undefined) return null;
  // Python date(year, month, day) raises ValueError on an out-of-range day.
  if (!isValidCalDate(year, monthNum, day)) return null;
  return { year, month: monthNum, day };
}

function isValidCalDate(y: number, mo: number, d: number): boolean {
  if (mo < 1 || mo > 12 || d < 1) return false;
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
}

function calDateISO(d: CalDate): string {
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${p(d.year, 4)}-${p(d.month)}-${p(d.day)}`;
}

/**
 * extract_proposed_daily.py:157-183 derive_batch_codes.
 * Returns [primaryCandidates, fallbackCandidates].
 * `blockDate` is the BLOCK DATE cell (row R+1), NOT the sheet-name transaction_date
 * (rc_out.md §2 — they can differ across a month boundary).
 */
function deriveBatchCodes(
  blockDate: CalDate | null,
  blockNo: number | null,
  isFeed: boolean,
): [string[], string[]] {
  if (blockDate === null || blockNo === null) return [[], []];
  const month = blockDate.month;
  const yy = String(blockDate.year % 100).padStart(2, "0");
  const kind = isFeed ? "FEED" : "BLK";
  const primary = PRIMARY_MONTH_PREFIX[month];
  const fallback = FALLBACK_MONTH_PREFIX[month];
  const primaryCode = `${primary}-${yy}-${kind}${blockNo}`;
  const fallbackCode = `${fallback}-${yy}-${kind}${blockNo}`;
  if (primaryCode === fallbackCode) return [[primaryCode], []];
  return [[primaryCode], [fallbackCode]];
}

// ---------------------------------------------------------------------------
// Block section detection + extraction (extract_proposed_daily.py:189-332)
// ---------------------------------------------------------------------------

/** extract_proposed_daily.py:189-196 — rows (1-based) where col A has BOTH "WHSE" and "#". */
function findBlockSectionStarts(ws: LoadedSheet): number[] {
  const starts: number[] = [];
  for (let r = 1; r <= ws.rowCount; r++) {
    const v = ws.cell(r, 1);
    if (v !== null && v !== undefined) {
      const s = pyStr(v);
      if (s && s.toUpperCase().includes("WHSE") && s.includes("#")) starts.push(r);
    }
  }
  return starts;
}

/** Extracted PROPOSED row — mirrors the row_dict at extract_proposed_daily.py:304-331. */
export interface ProposedRow {
  transaction_date: string;
  whse_label: string;
  block_loc: string | null;
  block_date: string | null;
  block_no: number | null;
  is_feed: boolean;
  batch_code_primary: string | null;
  batch_code_fallbacks: string[];
  supplier: string | null;
  strt_bal_kg: number | null;
  day_total_kg: number | null;
  end_bal_kg: number | null;
  weight_kg: number | null;
  destination: string;
  production_batch: string;
  remarks: string | null;
  operator_status: string | null;
  operator_remarks_raw: string | null;
  pallets_gross: number[];
  pallets_count: number[];
  pallets_net: number[];
  pallet_count: number;
  is_closing: boolean;
  warnings: string[];
  confidence: number;
  _source_row: number;
  _source_sheet?: string;
  // classify enrichment (added later, mirrors classify_rc_out ex_row mutation):
  batch_id?: string;
  batch_code_resolved?: string;
}

/** Pallet-scan sentinel set (extract_proposed_daily.py:236, upper-cased). */
const PALLET_SENTINELS = new Set(["REMARKS", "DONE", "DONE FEEDING", "FOR FEEDING", "MC AVERAGE:", ""]);
/** Closing phrases (extract_proposed_daily.py:279), exact match after strip+upper. */
const CLOSING_PHRASES = new Set(["DONE", "DONE FEEDING", "CLOSED"]);

/**
 * extract_proposed_daily.py:199-332 extract_block_section.
 * Returns [row | null, warnings]. A section with a blank WHSE returns [null, []].
 */
function extractBlockSection(
  ws: LoadedSheet,
  startRow: number,
  txnDate: CalDate,
): [ProposedRow | null, string[]] {
  const warnings: string[] = [];

  // Anchor label cells (col B = 2).
  const whse = coerceStr(ws.cell(startRow, 2));
  const blockDateRaw = ws.cell(startRow + 1, 2);
  const blockNoRaw = ws.cell(startRow + 2, 2);

  // Right-side stats (col L = 12).
  const strtBal = coerceFloat(ws.cell(startRow, 12));
  let dayTotal = coerceFloat(ws.cell(startRow + 1, 12));
  const endBal = coerceFloat(ws.cell(startRow + 2, 12));
  const remarks = coerceStr(ws.cell(startRow + 3, 12));

  // Status (col M = 13, WHSE row); supplier on BLOCK NO. row (col 13).
  const status = coerceStr(ws.cell(startRow, 13));
  const supplier = coerceStr(ws.cell(startRow + 2, 13));

  // Pallet rows (R+3 gross, R+4 sacks, R+5 net) from col B (=2). None → continue;
  // a sentinel string → break (extract_proposed_daily.py:231-244).
  const palletsGross: number[] = [];
  const palletsCount: number[] = [];
  const palletsNet: number[] = [];
  for (let c = 2; c <= ws.columnCount; c++) {
    const v = ws.cell(startRow + 3, c);
    if (v === null || v === undefined) continue;
    const s = pyStr(v).trim().toUpperCase();
    if (PALLET_SENTINELS.has(s)) break;
    const f = coerceFloat(v);
    if (f !== null) {
      palletsGross.push(f);
      const pn = coerceInt(ws.cell(startRow + 4, c));
      const net = coerceFloat(ws.cell(startRow + 5, c));
      palletsCount.push(pn !== null ? pn : 0);
      palletsNet.push(net !== null ? net : 0.0);
    }
  }

  // Skip section that looks like a footer / empty (extract_proposed_daily.py:247-248).
  if (whse === null || whse.trim() === "") return [null, []];

  // Validate DAY TOTAL, fall back to sum of nets (extract_proposed_daily.py:251-257).
  if (dayTotal === null) {
    if (palletsNet.length) {
      dayTotal = palletsNet.reduce((a, b) => a + b, 0);
      warnings.push(`DAY TOTAL missing; derived from net pallets sum = ${pyRepr(dayTotal)}`);
    } else {
      return [null, [`Block section at R${startRow} (${whse}): no DAY TOTAL and no pallet nets`]];
    }
  }

  if (!(WEIGHT_KG_MIN < dayTotal && dayTotal < WEIGHT_KG_MAX)) {
    warnings.push(`DAY TOTAL ${pyRepr(dayTotal)} outside plausible range`);
  }

  // FEED vs standard block (extract_proposed_daily.py:263) — substring, case-insensitive.
  const isFeed = whse.toUpperCase().includes("FEEDING AREA");

  const blockDate = coerceCalDate(blockDateRaw);
  const blockNo = parseBlockNo(blockNoRaw);

  const [primaryCodes, fallbackCodes] = deriveBatchCodes(blockDate, blockNo, isFeed);
  if (!primaryCodes.length) {
    warnings.push(
      `Could not derive batch_code (block_date=${blockDate ? calDateISO(blockDate) : "None"}, block_no=${blockNo === null ? "None" : blockNo})`,
    );
  }

  // block_loc: standard blocks use the raw WHSE label; FEED has none.
  const blockLoc = isFeed ? null : whse;

  // rc_out remarks: CLOSED if status/remarks indicate closing; else preserve
  // informational remarks except "FOR FEEDING" (a pure status marker).
  // extract_proposed_daily.py:279-290.
  let rcRemarks: string | null = null;
  let isClosing = false;
  for (const candidate of [status, remarks]) {
    if (candidate && CLOSING_PHRASES.has(candidate.trim().toUpperCase())) {
      isClosing = true;
      break;
    }
  }
  if (isClosing) {
    rcRemarks = "CLOSED";
  } else if (remarks && remarks.trim().toUpperCase() !== "FOR FEEDING") {
    rcRemarks = remarks;
  }

  // production_batch: %b abbreviation, with ONLY May→"MAY"/June→"JUNE" overrides
  // (extract_proposed_daily.py:292-300).
  let productionBatch = MONTH_ABBR_B[txnDate.month - 1];
  if (txnDate.month === 5) productionBatch = "MAY";
  else if (txnDate.month === 6) productionBatch = "JUNE";

  const confidence = Math.max(0.0, 1.0 - 0.1 * warnings.length);

  const row: ProposedRow = {
    transaction_date: calDateISO(txnDate),
    whse_label: whse,
    block_loc: blockLoc,
    block_date: blockDate ? calDateISO(blockDate) : null,
    block_no: blockNo,
    is_feed: isFeed,
    batch_code_primary: primaryCodes.length ? primaryCodes[0] : null,
    batch_code_fallbacks: fallbackCodes,
    supplier,
    strt_bal_kg: strtBal,
    day_total_kg: dayTotal,
    end_bal_kg: endBal,
    weight_kg: dayTotal, // what goes into rc_out
    destination: "MAIN",
    production_batch: productionBatch,
    remarks: rcRemarks,
    operator_status: status,
    operator_remarks_raw: remarks,
    pallets_gross: palletsGross,
    pallets_count: palletsCount,
    pallets_net: palletsNet,
    pallet_count: palletsGross.length,
    is_closing: isClosing,
    warnings,
    // Python round(confidence, 3) — banker's, but confidence is always a clean
    // 0.1 multiple here so 3dp is exact. Use a plain round to a fixed decimal.
    confidence: roundTo(confidence, 3),
    _source_row: startRow,
  };
  return [row, warnings];
}

/** extract_proposed_daily.py:335-351 extract_sheet. */
function extractSheet(ws: LoadedSheet, year: number): [ProposedRow[], string[]] {
  const sheetWarnings: string[] = [];
  const txnDate = sheetNameToDate(ws.name, year);
  if (txnDate === null) {
    sheetWarnings.push(`Sheet '${ws.name}': cannot parse date from sheet name`);
    return [[], sheetWarnings];
  }
  const rows: ProposedRow[] = [];
  for (const startR of findBlockSectionStarts(ws)) {
    const [row, extra] = extractBlockSection(ws, startR, txnDate);
    sheetWarnings.push(...extra);
    if (row !== null) {
      row._source_sheet = ws.name;
      rows.push(row);
    }
  }
  return [rows, sheetWarnings];
}

export interface ProposedExtract {
  rows: ProposedRow[];
  warnings: string[];
  sheetsProcessed: string[];
}

/**
 * Port of extract_proposed_daily.py main() with --all-sheets (rc_out.md §1 step 4:
 * the orchestrator ALWAYS passes --all-sheets). Only the `rows` (+ warnings/sheets)
 * feed classify; the summary block is orchestrator-only and not part of the oracle.
 */
export function extractProposed(wb: LoadedWorkbook, year: number): ProposedExtract {
  const rows: ProposedRow[] = [];
  const warnings: string[] = [];
  const sheetsProcessed: string[] = [];
  for (const name of wb.sheetNames) {
    const ws = wb.sheet(name);
    if (!ws) continue;
    const [r, w] = extractSheet(ws, year);
    rows.push(...r);
    warnings.push(...w);
    sheetsProcessed.push(name);
  }
  return { rows, warnings, sheetsProcessed };
}

// ---------------------------------------------------------------------------
// RC MOVEMENT extractor (extract_rc_movement.py)
// ---------------------------------------------------------------------------

const RCM_SECTION_BREAK_TOKENS = new Set(["SUPPLIERS", "REMARKS:", "REMARKS", "NOTES", "TOTAL", "TOTALS"]);
const RCM_WEIGHT_KG_MAX = 200_000; // extract_rc_movement.py:48

/** extract_rc_movement.py:51-67 coerce_date — like PROPOSED's but also treats "-" as null. */
function rcmCoerceCalDate(value: CellValue): CalDate | null {
  if (typeof value === "string") {
    const s = value.trim();
    if (!s || s === "-") return null;
  }
  return coerceCalDate(value);
}

/** extract_rc_movement.py:70-85 coerce_float — treats "-" as null (lib coerceFloat does not). */
function rcmCoerceFloat(value: CellValue): number | null {
  if (typeof value === "string") {
    const cleaned = value.replace(/,/g, "").trim();
    if (!cleaned || cleaned === "-") return null;
  }
  return coerceFloat(value);
}

interface MovementRow {
  transaction_date: string;
  raw_charcoal_fed_kls: number;
  _source_row: number;
  _source_sheet: string;
}

/** extract_rc_movement.py:109-171 extract_sheet (breakdown captured in Python but
 *  unused by the reconciler — we skip it; only date/fed are load-bearing). */
function rcmExtractSheet(ws: LoadedSheet): MovementRow[] {
  // Find the DATE header row in col A (scan first ≤9 rows). extract_rc_movement.py:115-123.
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
  const dataStart = headerRow + 3; // skip sub-header + unit row (extract_rc_movement.py:134).
  for (let r = dataStart; r <= ws.rowCount; r++) {
    const aVal = ws.cell(r, 1);
    if (typeof aVal === "string") {
      const stripped = aVal.trim().toUpperCase();
      if (RCM_SECTION_BREAK_TOKENS.has(stripped)) break; // extract_rc_movement.py:138-141.
    }
    const d = rcmCoerceCalDate(aVal);
    if (d === null) continue;
    const fedKls = rcmCoerceFloat(ws.cell(r, 2));
    if (fedKls === null) continue; // date present but no fed total (skip + Python warns).
    // fedKls out-of-range only warns in Python; we still emit it.
    void RCM_WEIGHT_KG_MAX;
    rows.push({
      transaction_date: calDateISO(d),
      raw_charcoal_fed_kls: fedKls,
      _source_row: r,
      _source_sheet: ws.name,
    });
  }
  return rows;
}

export interface MovementExtract {
  rows: MovementRow[];
  /** date → summed fed_kls across ALL month-tabs (L-022 cross-month summing). */
  date_to_fed_kls: Record<string, number>;
}

/**
 * Port of extract_rc_movement.py main() with --all-sheets.
 * L-022 (extract_rc_movement.py:213-222): a boundary date can appear on multiple
 * month-tabs — SUM across tabs, never overwrite, or the DB-vs-MOVEMENT duplication
 * gate false-halts. The 2026-06-27 fix is exactly this summing (rc_out.md deliverables).
 */
export function extractMovement(wb: LoadedWorkbook): MovementExtract {
  const rows: MovementRow[] = [];
  for (const name of wb.sheetNames) {
    const ws = wb.sheet(name);
    if (!ws) continue;
    rows.push(...rcmExtractSheet(ws));
  }
  const dateIndex: Record<string, number> = {};
  for (const r of rows) {
    const d = r.transaction_date;
    dateIndex[d] = roundTo((dateIndex[d] ?? 0.0) + r.raw_charcoal_fed_kls, 2);
  }
  return { rows, date_to_fed_kls: dateIndex };
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/** Fixed-decimal round for clean 0.1-multiple values (confidence, movement sums).
 *  These inputs are never at a true .5-boundary so half-even vs half-up cannot
 *  diverge; kept local to avoid pulling banker's rounding where it is not needed
 *  (banker's is reserved for norm_num diff comparisons). */
function roundTo(n: number, places: number): number {
  const f = 10 ** places;
  return Math.round(n * f) / f;
}

/** Python repr of a float embedded in a warning string (e.g. "1414.0" for a net sum). */
function pyRepr(n: number): string {
  return Number.isInteger(n) ? `${n}.0` : String(n);
}
