/**
 * extractMc.ts — port of extract_daily_production.py (MC's "Daily Production Report").
 *
 * One sheet per production DAY, title "MM-DD-YY". A single day-sheet feeds FOUR
 * target sections: runs, downtime, electricity, trucks. transaction_date is the
 * SHEET TITLE's date, never an in-sheet header cell.
 *
 * Fixed cell coordinates (verified against real sheets — see the Python module
 * docstring). All coercion mirrors the Python's own coerce_* helpers, which have a
 * `"VALUE" in value` guard and use `coerce_int = int(coerce_float)` (TRUNCATE), NOT
 * lib/norm's round variants — kept local per parity discipline.
 *
 * --since is SHEET-level and EXCLUSIVE (`> since`): keep only day-sheets dated
 * strictly after the watermark, or whose title fails to parse.
 *
 * Ground truth: .claude/skills/sync-ictc/scripts/extract_daily_production.py.
 */
import type { LoadedWorkbook, LoadedSheet, CellValue } from "../../lib/xlsx.js";

// ── Domain constants (Python lines 79-165) ─────────────────────────────────
const VALID_GRADES = new Set(["3X50", "6X50", "8X50", "2X6", "4X8"]); // L-027

const SHIFT_LABEL_TO_CODE: Record<string, string> = {
  "MORNING SHIFT": "M",
  MORNING: "M",
  "NIGHT SHIFT": "E",
  NIGHT: "E",
  "EVENING SHIFT": "E",
  EVENING: "E",
  "AFTERNOON SHIFT": "E",
};

const DEFAULT_RUN_SHIFT = "M";
// MUST stay byte-identical to SHIFT_DEFAULT_NOTE in classify.ts (runs classifier).
export const SHIFT_DEFAULT_NOTE = "shift defaulted to Morning (operator left blank)";

const MONTH_NAME_UPPER: Record<number, string> = {
  1: "JANUARY", 2: "FEBRUARY", 3: "MARCH", 4: "APRIL", 5: "MAY", 6: "JUNE",
  7: "JULY", 8: "AUGUST", 9: "SEPTEMBER", 10: "OCTOBER", 11: "NOVEMBER", 12: "DECEMBER",
};

const SHEET_NAME_RE = /^(\d{1,2})-(\d{1,2})-(\d{2,4})$/;

// Cell coordinates (1-based).
const RUNS_FIRST_DATA_ROW = 8;
const RUNS_LAST_DATA_ROW = 12;
const COL_RUN_GRADE = 4; // D
const COL_RUN_SACKS = 5; // E
const COL_RUN_TTL_KG = 7; // G
const COL_RUN_SHIFT = 8; // H
const TOTAL_ROW = 13;

const COL_DT_CATEGORY = 3; // C
// LEGACY fallback rows (old MC template). The 3Q cumulative workbook shifted every
// section below the runs block DOWN by one row, so these fixed rows now read the
// header/blank instead of the data. Section locators below ANCHOR on stable label
// text and read at a fixed offset from the anchor, so BOTH the old template and the
// 3Q layout resolve to the correct data row. The fixed rows survive only as a
// fallback for a stripped sheet that carries no anchor label (e.g. the minimal
// synthetic downtime edge fixture, which has the category+detail but no header).
const DT_CATEGORY_ROW = 24;
const DT_RANGES_ROW = 27; // detail row (ranges / minutes / reason share one row)
const COL_DT_RANGES = 3; // C
const COL_DT_MINUTES = 5; // E
const COL_DT_REASON = 6; // F

const ELEC_MAIN_READING_ROW = 54;
const ELEC_MAIN_MULT_ROW = 60;
const COL_ELEC_START = 4; // D
const COL_ELEC_END = 5; // E
const COL_ELEC_MULT = 5; // E
const ELEC_BUNKHOUSE_ROW = 65;
const ELEC_PUMP_ROW = 67;
const COL_A = 1; // A (BUNKHOUSE / PUMP row labels)
const DEFAULT_METER_MULTIPLIER = 120.0;

const TRUCK_DATA_ROWS = [47, 49, 51];
const COL_TRUCK_PLATE = 3; // C
const COL_TRUCK_START_KM = 4; // D
const COL_TRUCK_END_KM = 5; // E
const COL_TRUCK_TTL_KM = 6; // F
const COL_TRUCK_LITERS = 8; // H
const COL_TRUCK_GAUGE_START = 10; // J
const COL_TRUCK_GAUGE_END = 11; // K

// ── Anchor search windows (1-based, inclusive) ──────────────────────────────
// Generous but bounded so an anchor label can only match inside its own section.
// The invariant OFFSET from each anchor to its data row is layout-independent:
// the old template and the 3Q layout differ only by which row the anchor sits on.
const DT_ANCHOR_MIN = 20;
const DT_ANCHOR_MAX = 40;
const ELEC_ANCHOR_MIN = 45;
const ELEC_ANCHOR_MAX = 58; // MAIN readings header only — below the trucks block, above bunkhouse
const MULT_ANCHOR_MIN = 56;
const MULT_ANCHOR_MAX = 64;
const BUNK_ANCHOR_MIN = 62;
const BUNK_ANCHOR_MAX = 75;
const TRUCK_ANCHOR_MIN = 42;
const TRUCK_ANCHOR_MAX = 52;
const TOTAL_ANCHOR_MIN = 12;
const TOTAL_ANCHOR_MAX = 18;

// ── Anchor helpers — locate a section by stable label, not a fixed row ───────
/** Uppercased, trimmed string form of a cell, or "" for null/non-string-ish. */
function cellUpper(value: CellValue): string {
  const s = coerceStr(value);
  return s === null ? "" : s.trim().toUpperCase();
}

/** First row in [start,end] where predicate(row) holds, else null. */
function findAnchorRow(
  start: number,
  end: number,
  predicate: (row: number) => boolean,
): number | null {
  for (let r = start; r <= end; r++) {
    if (predicate(r)) return r;
  }
  return null;
}

/** True if any cell in columns [c1,c2] on `row` equals `label` (trimmed, upper). */
function rowHasLabel(ws: LoadedSheet, row: number, c1: number, c2: number, label: string): boolean {
  const want = label.toUpperCase();
  for (let col = c1; col <= c2; col++) {
    if (cellUpper(ws.cell(row, col)) === want) return true;
  }
  return false;
}

/** True if cell(row,col), uppercased, CONTAINS `needle` (already uppercase). */
function cellContainsUpper(ws: LoadedSheet, row: number, col: number, needle: string): boolean {
  return cellUpper(ws.cell(row, col)).includes(needle);
}

// ── Coercers (mirror the Python coerce_* verbatim) ─────────────────────────
function coerceFloat(value: CellValue): number | null {
  if (value === null || value === "") return null;
  if (typeof value === "boolean") return null;
  if (typeof value === "string" && value.includes("VALUE")) return null;
  if (typeof value === "number") return value;
  if (value instanceof Date) return null;
  if (typeof value === "string") {
    const cleaned = value.replace(/,/g, "").trim();
    if (!cleaned) return null;
    const f = Number(cleaned);
    return Number.isFinite(f) ? f : null;
  }
  return null;
}

/** coerce_int = int(coerce_float) — Python int() TRUNCATES toward zero. */
function coerceInt(value: CellValue): number | null {
  const f = coerceFloat(value);
  return f !== null ? Math.trunc(f) : null;
}

/**
 * True when a cell is genuinely EMPTY — nothing was entered — as opposed to
 * present-but-unparseable. Both collapse to `null` under coerceFloat, so this is
 * the ONLY way to tell "no production this shift" (blank) apart from a real data
 * error (text / date / boolean / Excel error / negative). Used so a valid-grade
 * runs row with a blank TOTAL-kg cell becomes a benign no-output skip rather than
 * MALFORMED. NOTE: the xlsx loader already collapses Excel error cells (#VALUE!,
 * #DIV/0! …) to `null`, so an error formula in the kg cell reads as blank here —
 * an accepted edge; the common real case is a genuinely empty cell.
 */
function isBlankCell(value: CellValue): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value === "string") return value.trim() === "";
  return false;
}

function coerceStr(value: CellValue): string | null {
  if (value === null || value === undefined) return null;
  const s = cellToStr(value).trim();
  return s ? s : null;
}

/** openpyxl str(value) for the value shapes a data_only cell can carry. */
function cellToStr(value: CellValue): string {
  if (value instanceof Date) {
    // openpyxl str(datetime.datetime) — production date cells are the sheet TITLE,
    // never read as a cell here, so this branch is effectively unreached for the
    // cells we coerce_str. Keep a deterministic ISO-ish fallback.
    return value.toISOString();
  }
  return String(value);
}

// ── Date/sheet helpers ─────────────────────────────────────────────────────
interface YMD {
  y: number;
  m: number;
  d: number;
}

function parseSheetDate(sheetName: string, yearOverride: number | null): YMD | null {
  const mt = sheetName.trim().match(SHEET_NAME_RE);
  if (!mt) return null;
  const month = parseInt(mt[1], 10);
  const day = parseInt(mt[2], 10);
  const yy = mt[3];
  let year: number;
  if (yearOverride !== null) year = yearOverride;
  else if (yy.length === 2) year = 2000 + parseInt(yy, 10);
  else year = parseInt(yy, 10);
  // Validate the calendar date the way Python date() would raise.
  const dt = new Date(Date.UTC(year, month - 1, day));
  if (dt.getUTCFullYear() !== year || dt.getUTCMonth() !== month - 1 || dt.getUTCDate() !== day) {
    return null;
  }
  return { y: year, m: month, d: day };
}

function isoDate({ y, m, d }: YMD): string {
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${p(y, 4)}-${p(m)}-${p(d)}`;
}

/** Compare two ISO date strings (lexicographic works for YYYY-MM-DD). */
function isoGreater(a: string, b: string): boolean {
  return a > b;
}

function productionBatchFor(ymd: YMD): string {
  return MONTH_NAME_UPPER[ymd.m];
}

// ── Shift resolution (L-025) ────────────────────────────────────────────────
function normalizeShift(label: CellValue): { code: string | null; warn: string | null } {
  const s = coerceStr(label);
  if (s === null) return { code: null, warn: null };
  const code = SHIFT_LABEL_TO_CODE[s.toUpperCase()];
  if (code === undefined) return { code: null, warn: `Unrecognized shift label '${s}'` };
  return { code, warn: null };
}

function resolveRunShift(label: CellValue): { code: string; defaulted: boolean; warn: string | null } {
  const { code } = normalizeShift(label);
  if (code !== null) return { code, defaulted: false, warn: null };
  const raw = coerceStr(label);
  const reason =
    raw === null
      ? "shift cell blank/absent — defaulted to Morning"
      : `unrecognized shift '${raw}' — defaulted to Morning`;
  return { code: DEFAULT_RUN_SHIFT, defaulted: true, warn: reason };
}

function appendNote(existing: string | null, note: string): string {
  const base = coerceStr(existing);
  if (base === null) return note;
  if (base.includes(note)) return base;
  return `${base} | ${note}`;
}

function splitMultiline(value: CellValue): string[] {
  const s = coerceStr(value);
  if (s === null) return [];
  return s
    .split(/\r\n|\r|\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/** Python round(x, 3) via banker's rounding is only needed on confidence here. */
function round3(x: number): number {
  // confidence values are 1.0, 0.9, 0.8, ... — exact multiples of 0.1 that carry
  // no half-boundary ambiguity at 3dp, so a straight round is exact for this domain.
  return Math.round(x * 1000) / 1000;
}

// ── Row shapes ──────────────────────────────────────────────────────────────
export interface RunRow {
  transaction_date: string;
  production_batch: string;
  shift: string;
  customer: string;
  grade: string;
  ttl_kg: number | null;
  sacks_bags: number | null;
  remarks: string | null;
  _shift_defaulted: boolean;
  _source_sheet: string;
  _source_row: number;
  warnings: string[];
  confidence: number;
  /**
   * True ONLY when the TOTAL-kg cell was genuinely EMPTY (no production this
   * shift). Lets classifyRuns treat a valid-grade no-output row as a benign
   * SKIPPED_NO_OUTPUT instead of MALFORMED. Optional and OMITTED when false so a
   * real (produced) row's classify `record` stays byte-identical to the Python
   * oracle for parity — no existing fixture carries a blank-kg row.
   */
  _ttl_blank?: boolean;
}

export interface DowntimeRow {
  transaction_date: string;
  production_batch: string;
  shift: string;
  shift_hrs: number;
  dt_hrs: number;
  dt_mins: number;
  dt_reason: string | null;
  remarks: string | null;
  _source_sheet: string;
  warnings: string[];
}

export interface ElectricityRow {
  reading_date: string;
  meter: string;
  start_kwh: number | null;
  end_kwh: number | null;
  meter_multiplier: number;
  remarks: string | null;
  _source_sheet: string;
  warnings: string[];
}

export interface TruckRow {
  reading_date: string;
  plate_no: string | null;
  start_km: number | null;
  end_km: number | null;
  fuel_liters: number | null;
  remarks: string | null;
  _source_sheet: string;
  _source_row: number;
  warnings: string[];
}

export interface McExtract {
  runs: RunRow[];
  downtime: DowntimeRow[];
  electricity: ElectricityRow[];
  trucks: TruckRow[];
  /** G13 day total per date (reconcile-only; NOT part of the classify oracle). */
  dayTotals: Record<string, number | null>;
}

// ── Section A — production runs ─────────────────────────────────────────────
function routeGrade(rawGrade: string): { customer: string | null; grade: string | null; keep: boolean } {
  const text = rawGrade.trim().toUpperCase();
  const tokens = text.split(/\s+/).filter((t) => t.length > 0);
  if (tokens.length === 0) return { customer: null, grade: null, keep: false };
  if (tokens.length === 1) {
    const grade = tokens[0];
    return VALID_GRADES.has(grade)
      ? { customer: "CEBU", grade, keep: true }
      : { customer: null, grade: null, keep: false };
  }
  const grade = tokens[tokens.length - 1];
  const customer = tokens.slice(0, -1).join(" ");
  if (VALID_GRADES.has(grade)) return { customer, grade, keep: true };
  return { customer: null, grade: null, keep: false };
}

function extractRuns(
  ws: LoadedSheet,
  titleStripped: string,
  txnIso: string,
  productionBatch: string,
): RunRow[] {
  const runs: RunRow[] = [];
  for (let r = RUNS_FIRST_DATA_ROW; r <= RUNS_LAST_DATA_ROW; r++) {
    const rawGrade = coerceStr(ws.cell(r, COL_RUN_GRADE));
    if (rawGrade === null) continue;
    const { customer, grade, keep } = routeGrade(rawGrade);
    if (!keep || grade === null || customer === null) continue;

    const ttlCell = ws.cell(r, COL_RUN_TTL_KG);
    const ttlKg = coerceFloat(ttlCell);
    // Genuinely-empty kg cell = no production this shift (benign). A present-but-
    // unparseable/negative value still holds — see classifyRuns.
    const ttlBlank = ttlKg === null && isBlankCell(ttlCell);
    const sacks = coerceInt(ws.cell(r, COL_RUN_SACKS));
    const { code: shiftCode, defaulted: shiftDefaulted, warn: shiftWarn } = resolveRunShift(
      ws.cell(r, COL_RUN_SHIFT),
    );

    const rowWarnings: string[] = [];
    if (shiftWarn) rowWarnings.push(shiftWarn);
    if (ttlKg === null) rowWarnings.push(`missing TOTAL kg (G${r}) for ${grade}`);
    else if (ttlKg < 0) rowWarnings.push(`negative ttl_kg=${ttlKg}`);

    const remarks = shiftDefaulted ? appendNote(null, SHIFT_DEFAULT_NOTE) : null;
    const confidence = Math.max(0.0, 1.0 - 0.1 * rowWarnings.length);

    const runRow: RunRow = {
      transaction_date: txnIso,
      production_batch: productionBatch,
      shift: shiftCode,
      customer,
      grade,
      ttl_kg: ttlKg,
      sacks_bags: sacks,
      remarks,
      _shift_defaulted: shiftDefaulted,
      _source_sheet: titleStripped,
      _source_row: r,
      warnings: rowWarnings,
      confidence: round3(confidence),
    };
    // Set ONLY when true so the record stays parity-identical for produced rows.
    if (ttlBlank) runRow._ttl_blank = true;
    runs.push(runRow);
  }
  return runs;
}

// ── Section B — downtime (PD-5 dt_mins>=60 split is applied HERE) ────────────
/**
 * Locate the downtime category + detail rows by anchoring on the "DURATION"
 * header (present in every real MC sheet), which sits ONE row below the category
 * label and TWO rows above the detail row (time-ranges / minutes / reason) in
 * BOTH the old template and the 3Q layout. A stripped synthetic sheet with no
 * DURATION header falls back to the legacy fixed rows.
 */
function resolveDowntimeRows(ws: LoadedSheet): { categoryRow: number; detailRow: number } {
  const durationRow = findAnchorRow(DT_ANCHOR_MIN, DT_ANCHOR_MAX, (r) =>
    rowHasLabel(ws, r, COL_DT_CATEGORY, COL_DT_REASON, "DURATION"),
  );
  if (durationRow !== null) {
    return { categoryRow: durationRow - 1, detailRow: durationRow + 2 };
  }
  return { categoryRow: DT_CATEGORY_ROW, detailRow: DT_RANGES_ROW };
}

function extractDowntime(
  ws: LoadedSheet,
  titleStripped: string,
  txnIso: string,
  productionBatch: string,
): DowntimeRow | null {
  const { categoryRow, detailRow } = resolveDowntimeRows(ws);
  const category = coerceStr(ws.cell(categoryRow, COL_DT_CATEGORY));
  const ranges = splitMultiline(ws.cell(detailRow, COL_DT_RANGES));
  const minuteLines = splitMultiline(ws.cell(detailRow, COL_DT_MINUTES));
  const reasons = splitMultiline(ws.cell(detailRow, COL_DT_REASON));

  const rowWarnings: string[] = [];
  let totalMins = 0.0;
  for (const line of minuteLines) {
    const stripped = line.replace(/[^0-9.]/g, "");
    const f = coerceFloat(stripped === "" ? null : stripped);
    if (f !== null) totalMins += f;
    else rowWarnings.push(`could not parse downtime minutes from '${line}'`);
  }

  const hasReason = reasons.length > 0 || category !== null;
  if (totalMins <= 0 && !hasReason) return null;

  const reasonParts: string[] = [];
  if (category) reasonParts.push(category);
  if (reasons.length > 0) reasonParts.push(reasons.join("; "));
  const dtReason = reasonParts.length > 0 ? reasonParts.join(" | ") : null;

  if (totalMins <= 0 && hasReason) rowWarnings.push("downtime reason present but no parseable minutes");

  const remarks = ranges.length > 0 ? "Time ranges: " + ranges.join("; ") : null;

  // ── PORTING_DECISIONS #5 (PD-5), L-014 — DEVIATION-LOGGED ──────────────────
  // The Python extractor emits dt_hrs:0 and the FULL total minutes in dt_mins,
  // which violates the production_downtime CHECK(dt_mins >= 0 AND dt_mins < 60)
  // for any day totalling >= 60 min. The ledger defines the fix (never implemented
  // in Python): hrs += mins // 60; mins %= 60. We implement it HERE at extract
  // shaping so the split is visible in the classify record. The parity harness
  // carries the expected-deviation entry PD-5 (production_downtime_ge60), so the
  // resulting dt_hrs/dt_mins value change is a registered PASS-with-note, not a bug.
  let dtHrs = 0;
  let dtMins = totalMins;
  if (dtMins >= 60) {
    dtHrs += Math.floor(dtMins / 60);
    dtMins = dtMins % 60;
  }

  return {
    transaction_date: txnIso,
    production_batch: productionBatch,
    shift: "M",
    shift_hrs: 12,
    dt_hrs: dtHrs,
    dt_mins: dtMins,
    dt_reason: dtReason,
    remarks,
    _source_sheet: titleStripped,
    warnings: rowWarnings,
  };
}

// ── Section C — electricity ─────────────────────────────────────────────────
function emitElectricity(
  meter: string,
  startKwh: number | null,
  endKwh: number | null,
  multiplier: number | null,
  txnIso: string,
  titleStripped: string,
): ElectricityRow | null {
  if (startKwh === null && endKwh === null) return null;
  if ((startKwh || 0) === 0 && (endKwh || 0) === 0) return null;

  const rowWarnings: string[] = [];
  if (startKwh === null) rowWarnings.push("missing start_kwh");
  if (endKwh === null) rowWarnings.push("missing end_kwh");
  if (startKwh !== null && endKwh !== null && endKwh < startKwh) {
    rowWarnings.push(`end_kwh (${endKwh}) < start_kwh (${startKwh})`);
  }

  const mult = multiplier !== null ? multiplier : DEFAULT_METER_MULTIPLIER;

  return {
    reading_date: txnIso,
    meter,
    start_kwh: startKwh,
    end_kwh: endKwh,
    meter_multiplier: mult,
    remarks: null,
    _source_sheet: titleStripped,
    warnings: rowWarnings,
  };
}

/**
 * Locate the MAIN electricity readings row + multiplier row by anchoring on the
 * "PRESENT READING" header (MAIN only — the BUNKHOUSE block uses "CURRENT
 * READING") and the "METER MULTIPLIER" header. The data sits ONE row below each
 * header in BOTH the old template and the 3Q layout. Falls back to the legacy
 * fixed rows when a header is absent (a stripped sheet).
 */
function resolveMainReadingRow(ws: LoadedSheet): number {
  const hdr = findAnchorRow(ELEC_ANCHOR_MIN, ELEC_ANCHOR_MAX, (r) =>
    cellContainsUpper(ws, r, COL_ELEC_END, "PRESENT READING"),
  );
  return hdr !== null ? hdr + 1 : ELEC_MAIN_READING_ROW;
}

function resolveMainMultRow(ws: LoadedSheet): number {
  const hdr = findAnchorRow(MULT_ANCHOR_MIN, MULT_ANCHOR_MAX, (r) =>
    cellContainsUpper(ws, r, COL_ELEC_MULT, "METER MULTIPLIER"),
  );
  return hdr !== null ? hdr + 1 : ELEC_MAIN_MULT_ROW;
}

/** BUNKHOUSE / PUMP reading row: anchor on the column-A label, else legacy row. */
function resolveMeterRow(ws: LoadedSheet, label: string, legacyRow: number): number {
  const row = findAnchorRow(BUNK_ANCHOR_MIN, BUNK_ANCHOR_MAX, (r) =>
    rowHasLabel(ws, r, COL_A, COL_A, label),
  );
  return row !== null ? row : legacyRow;
}

function extractElectricity(ws: LoadedSheet, titleStripped: string, txnIso: string): ElectricityRow[] {
  const readings: ElectricityRow[] = [];
  const mainReadingRow = resolveMainReadingRow(ws);
  const mainMultRow = resolveMainMultRow(ws);
  const mainStart = coerceFloat(ws.cell(mainReadingRow, COL_ELEC_START));
  const mainEnd = coerceFloat(ws.cell(mainReadingRow, COL_ELEC_END));
  const mainMult = coerceFloat(ws.cell(mainMultRow, COL_ELEC_MULT));
  const main = emitElectricity("MAIN", mainStart, mainEnd, mainMult, txnIso, titleStripped);
  if (main !== null) readings.push(main);

  for (const [meter, legacyRow] of [
    ["BUNKHOUSE", ELEC_BUNKHOUSE_ROW],
    ["PUMP", ELEC_PUMP_ROW],
  ] as Array<[string, number]>) {
    const row = resolveMeterRow(ws, meter, legacyRow);
    const start = coerceFloat(ws.cell(row, COL_ELEC_START));
    const end = coerceFloat(ws.cell(row, COL_ELEC_END));
    const rec = emitElectricity(meter, start, end, null, txnIso, titleStripped);
    if (rec !== null) readings.push(rec);
  }
  return readings;
}

// ── Section D — trucks ──────────────────────────────────────────────────────
/**
 * Locate the truck data rows by anchoring on the "Truck Plate No." header. Each
 * of the three truck slots is a 2-row merge, so the data rows sit at header+1,
 * header+3, header+5 in BOTH the old template and the 3Q layout. Falls back to
 * the legacy fixed rows when the header is absent (a stripped sheet).
 */
function resolveTruckRows(ws: LoadedSheet): number[] {
  const hdr = findAnchorRow(TRUCK_ANCHOR_MIN, TRUCK_ANCHOR_MAX, (r) =>
    cellContainsUpper(ws, r, COL_TRUCK_PLATE, "TRUCK PLATE NO"),
  );
  if (hdr !== null) return [hdr + 1, hdr + 3, hdr + 5];
  return [...TRUCK_DATA_ROWS];
}

function extractTrucks(ws: LoadedSheet, titleStripped: string, txnIso: string): TruckRow[] {
  const trucks: TruckRow[] = [];
  for (const r of resolveTruckRows(ws)) {
    const plate = coerceStr(ws.cell(r, COL_TRUCK_PLATE));
    const startKm = coerceFloat(ws.cell(r, COL_TRUCK_START_KM));
    const endKm = coerceFloat(ws.cell(r, COL_TRUCK_END_KM));
    const ttlKm = coerceFloat(ws.cell(r, COL_TRUCK_TTL_KM));
    const fuel = coerceFloat(ws.cell(r, COL_TRUCK_LITERS));
    const gaugeStart = coerceStr(ws.cell(r, COL_TRUCK_GAUGE_START));
    const gaugeEnd = coerceStr(ws.cell(r, COL_TRUCK_GAUGE_END));

    const moved =
      (startKm !== null && endKm !== null && endKm > startKm) || (ttlKm !== null && ttlKm > 0);
    const hasFuel = fuel !== null && fuel > 0;
    if (!moved && !hasFuel) continue;

    const rowWarnings: string[] = [];
    if (plate === null) rowWarnings.push("movement/fuel present but plate is blank");

    const gaugeBits: string[] = [];
    if (gaugeStart) gaugeBits.push(`start fuel: ${gaugeStart}`);
    if (gaugeEnd) gaugeBits.push(`arriving fuel: ${gaugeEnd}`);
    const remarks = gaugeBits.length > 0 ? gaugeBits.join("; ") : null;

    trucks.push({
      reading_date: txnIso,
      plate_no: plate,
      start_km: startKm,
      end_km: endKm,
      fuel_liters: hasFuel ? fuel : null,
      remarks,
      _source_sheet: titleStripped,
      _source_row: r,
      warnings: rowWarnings,
    });
  }
  return trucks;
}

// ── Per-sheet + selection ───────────────────────────────────────────────────
interface SheetResult {
  runs: RunRow[];
  downtime: DowntimeRow[];
  electricity: ElectricityRow[];
  trucks: TruckRow[];
  txnIso: string | null;
  dayTotal: number | null;
}

const COL_C13 = COL_RUN_GRADE - 1; // C

/**
 * Day-total row, trusted when its column-C cell == "TOTAL" (else still used if
 * G is non-null). Anchored on the "TOTAL" label in column C — the 3Q layout
 * pushed this row from 13 to 14 — with the legacy fixed row as the fallback.
 * (Reconcile-only; NOT part of the classify oracle, so this never affects parity.)
 */
function extractDayTotal(ws: LoadedSheet): number | null {
  const totalRow =
    findAnchorRow(TOTAL_ANCHOR_MIN, TOTAL_ANCHOR_MAX, (r) =>
      rowHasLabel(ws, r, COL_C13, COL_C13, "TOTAL"),
    ) ?? TOTAL_ROW;
  const cLabel = coerceStr(ws.cell(totalRow, COL_C13));
  const gTotal = coerceFloat(ws.cell(totalRow, COL_RUN_TTL_KG));
  if (cLabel && cLabel.trim().toUpperCase() === "TOTAL") return gTotal;
  if (gTotal !== null) return gTotal;
  return null;
}

function extractSheet(ws: LoadedSheet, yearOverride: number | null): SheetResult {
  const titleStripped = ws.name.trim();
  const ymd = parseSheetDate(ws.name, yearOverride);
  if (ymd === null) {
    return { runs: [], downtime: [], electricity: [], trucks: [], txnIso: null, dayTotal: null };
  }
  const txnIso = isoDate(ymd);
  const productionBatch = productionBatchFor(ymd);

  const runs = extractRuns(ws, titleStripped, txnIso, productionBatch);
  const downtime = extractDowntime(ws, titleStripped, txnIso, productionBatch);
  const electricity = extractElectricity(ws, titleStripped, txnIso);
  const trucks = extractTrucks(ws, titleStripped, txnIso);
  const dayTotal = extractDayTotal(ws);

  return {
    runs,
    downtime: downtime !== null ? [downtime] : [],
    electricity,
    trucks,
    txnIso,
    dayTotal,
  };
}

/** resolve_sheets with --all-sheets + --since (sheet-level, exclusive). */
function resolveSheets(wb: LoadedWorkbook, yearOverride: number | null, since: string | null): string[] {
  let selected = [...wb.sheetNames];
  if (since !== null) {
    selected = selected.filter((n) => {
      const ymd = parseSheetDate(n, yearOverride);
      return ymd === null || isoGreater(isoDate(ymd), since);
    });
  }
  return selected;
}

/**
 * Extract the MC Daily Production Report across ALL sheets, applying the
 * exclusive --since sheet filter. `year` is the century override (int(since[:4])).
 */
export function extractMc(wb: LoadedWorkbook, year: number, since: string | null): McExtract {
  const sheetNames = resolveSheets(wb, year, since);
  const runs: RunRow[] = [];
  const downtime: DowntimeRow[] = [];
  const electricity: ElectricityRow[] = [];
  const trucks: TruckRow[] = [];
  const dayTotals: Record<string, number | null> = {};
  for (const name of sheetNames) {
    const ws = wb.sheet(name);
    if (!ws) continue;
    const res = extractSheet(ws, year);
    runs.push(...res.runs);
    downtime.push(...res.downtime);
    electricity.push(...res.electricity);
    trucks.push(...res.trucks);
    if (res.txnIso) dayTotals[res.txnIso] = res.dayTotal;
  }
  return { runs, downtime, electricity, trucks, dayTotals };
}
