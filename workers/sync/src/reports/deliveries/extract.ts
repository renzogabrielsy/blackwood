/**
 * extract.ts — TS port of `.claude/skills/sync-ictc/scripts/extract_rc_deliveries.py`
 * (read the Python as spec; behavioral law = specs/deliveries.md §2).
 *
 * Reads ONE month sheet (default = the workbook's last-saved active sheet, via
 * sheet.ts::activeSheetName — sync_deliveries.py never passes --sheet/--all-sheets)
 * and emits delivery rows structurally identical to the Python extractor's `rows`.
 *
 * PARITY-CRITICAL faithful details:
 *   - FIXED 1-based column map (OPERATOR_COLUMNS), NOT header-signature-driven.
 *   - Dynamic header-row location + first-data-row scan (find_header_row /
 *     first_data_row_below), with the exact fallbacks.
 *   - Date carry-forward; the strict "no date, no prior date → SKIP" rule.
 *   - Row validity: supplier&weight both null → silent skip; weight null → warn+SKIP;
 *     weight out of (0,100000) → warn only; off-format block_loc → warn only.
 *   - translate_batch_code's ACTUAL source check order (FEEDING AREA → PILED IN
 *     remark → B-number → fallthrough), which diverges from its docstring (trap).
 *   - lab_results null-collapse, deduction fields (L-021), confidence, wet-recovery.
 *
 * Values are coerced via lib/norm's coerceDate/coerceFloat (openpyxl coerce_date /
 * coerce_float parity) and a local coerceInt/coerceStr mirroring the Python.
 */
import { coerceDate, coerceFloat } from "../../lib/norm.js";
import type { CellValue, LoadedSheet } from "../../lib/xlsx.js";
import type { DeliveriesWorkbook } from "./sheet.js";
import {
  detectDeduction,
  buildRecoveryRow,
  isRecoveryRowDict,
  isInheritableMother,
} from "./deductions.js";

// ---------------------------------------------------------------------------
// Constants (verbatim from extract_rc_deliveries.py)
// ---------------------------------------------------------------------------
const WEIGHT_KG_MIN = 0;
const WEIGHT_KG_MAX = 100_000;

const BLOCK_LOC_REGEX = /^(PCA|PCB|[A-DF])-\d{1,2}[A-D]$/;

/** short_key → (message, isPlausible) — mirrors LAB_PLAUSIBILITY. A warning is added
 *  when the value is NOT plausible. */
const LAB_PLAUSIBILITY: Record<string, [string, (v: number) => boolean]> = {
  mc: ["Moisture content unusually high", (v) => v < 20],
  ash: ["Ash content unusually high", (v) => v < 10],
  fc: ["Fixed carbon unusually low", (v) => v > 60],
  vm: ["Volatile matter unusually high", (v) => v < 25],
  grit: ["Grit value unusually high", (v) => v < 5],
  bd_astm: ["BD ASTM out of expected range", (v) => 0.2 < v && v < 1.0],
  bd_jis: ["BD JIS out of expected range", (v) => 0.2 < v && v < 1.0],
};

// Month name → full-name prefix (despite "ABBR", all values are the full name).
const MONTH_ABBR_VALUES = [
  "JANUARY", "FEBRUARY", "MARCH", "APRIL", "MAY", "JUNE",
  "JULY", "AUGUST", "SEPTEMBER", "OCTOBER", "NOVEMBER", "DECEMBER",
];
const MONTH_ABBR: Record<string, string> = Object.fromEntries(
  MONTH_ABBR_VALUES.map((m) => [m, m]),
);

// "PILED IN <MONTH> # <N>" in remarks. re.IGNORECASE.
const PILED_REMARK_RE =
  /PILED\s+IN\s+(JANUARY|FEBRUARY|MARCH|APRIL|MAY|JUNE|JULY|AUGUST|SEPTEMBER|OCTOBER|NOVEMBER|DECEMBER)\s*#\s*(\d+)/i;
// Operator "B<N>" label. re.IGNORECASE.
const OPERATOR_B_LABEL_RE = /^B0?(\d{1,3})$/i;
/**
 * A FEEDING-area label in the operator's Block column (column D). re.IGNORECASE.
 *
 * WIDENED 2026-08-13 (L-042). It used to be `^FEEDING\s+AREA\s*(\d*)$`, which matched the
 * spelling the SHEET uses and NOT the one MC actually types. She writes `FEEDING # 1`, so
 * the label fell through to the raw-value branch: truthy (so it passed the malformed
 * guard), not pattern-valid (so it never auto-created), and therefore held on EVERY run
 * forever. Two real truckloads were stuck this way — 2026-08-05 / AAV 6111 / 19,185 kg for
 * a week, and 2026-08-12 / KCA 378 / 18,650 kg.
 *
 * ACCEPTED (all produce EXACTLY what `FEEDING AREA <N>` produces today):
 *   `FEEDING AREA 2` · `FEEDING # 2` · `FEEDING #2` · `FEEDING NO. 2` · `FEEDING NO 2`
 *   `FEEDING 2` · `FEEDING AREA #2` · `FEEDING AREA 2.` · `FEEDING` / `FEEDING AREA`
 * A numberless label keeps the pre-existing behaviour: raw label + "needs manual mapping".
 *
 * DELIBERATELY STILL REJECTED — the anchor is a leading `FEEDING`, and after the optional
 * `AREA`/`NO`/`#` designator only DIGITS may follow:
 *   `FEEDING AREA A` (a letter is not an area number — stays an unmapped label a human
 *   reads), `FEEDING AREA 1 AND 2` (two areas is not one batch), `RE-FEEDING 1` (does not
 *   start with FEEDING — `REFEED` is its own batch family, e.g. `MARCH-26-REFEED1`),
 *   `FEEDINGS 2`, and anything else that merely contains the word.
 */
const FEEDING_AREA_RE = /^FEEDING(?:\s*(?:AREA|NO))?\s*[#.:-]?\s*(\d*)\s*\.?$/i;

// ---------------------------------------------------------------------------
// Row type
// ---------------------------------------------------------------------------
export type LabResults = Record<string, number | null>;

export interface DeliveryRow {
  transaction_date: string;
  supplier: string | null;
  batch_code: string | null;
  operator_batch_label: string | null;
  block_loc: string | null;
  truck_plate: string | null;
  sacks: number | null;
  weight_kg: number;
  cost_basis: number | null;
  remarks: string | null;
  lab_results: LabResults | null;
  true_weight_kg: number | null;
  deduction_note: string | null;
  warnings: string[];
  confidence: number;
  _source_row: number;
  _source_sheet?: string;
  // recovery bookkeeping (present only on recovery sub-rows)
  _recovery?: boolean;
  _mother_source_row?: unknown;
  [key: string]: unknown;
}

export interface ExtractSummary {
  total_rows: number;
  extraction_warnings: string[];
  overall_confidence: number;
  unmapped_batches: string[];
}

export interface ExtractResult {
  filename: string;
  sheets_processed: string[];
  rows: DeliveryRow[];
  summary: ExtractSummary;
}

// ---------------------------------------------------------------------------
// Coercion helpers (Python coerce_int / coerce_str; coerce_date/float via norm)
// ---------------------------------------------------------------------------
/** Python coerce_int = int(coerce_float(v)) — TRUNCATE toward zero. */
function coerceInt(value: CellValue): number | null {
  const f = coerceFloat(value);
  return f === null ? null : Math.trunc(f);
}

/** Python coerce_str = str(v).strip() or None. */
function coerceStr(value: CellValue): string | null {
  if (value === null || value === undefined) return null;
  const s = String(value).trim();
  return s ? s : null;
}

// ---------------------------------------------------------------------------
// Header detection (find_header_row / first_data_row_below)
// ---------------------------------------------------------------------------
function findHeaderRow(sheet: LoadedSheet): number | null {
  const maxRow = sheet.rowCount;
  for (let r = 1; r < Math.min(maxRow + 1, 16); r++) {
    let first6 = "";
    for (let c = 1; c < 7; c++) {
      const v = sheet.cell(r, c);
      first6 += (v === null || v === undefined ? "" : String(v)).toUpperCase();
      if (c < 6) first6 += " ";
    }
    if (
      (first6.includes("DATE OF") || first6.includes("DELIVERY")) &&
      (first6.includes("SUPPLIER") || first6.includes("SAMPLE"))
    ) {
      return r;
    }
  }
  return null;
}

function firstDataRowBelow(sheet: LoadedSheet, headerRow: number): number {
  const maxRow = sheet.rowCount;
  for (let r = headerRow + 1; r < Math.min(maxRow + 1, headerRow + 9); r++) {
    if (coerceDate(sheet.cell(r, 2)) !== null) return r;
  }
  return headerRow + 4;
}

// ---------------------------------------------------------------------------
// Batch code translation (translate_batch_code) — ACTUAL source check order:
//   FEEDING AREA → PILED IN remark → B-number → fallthrough (see specs trap).
// ---------------------------------------------------------------------------
export function translateBatchCode(
  operatorLabel: string | null,
  remarks: string | null,
  deliveryDate: string | null,
): [string | null, string[]] {
  if (!operatorLabel) return [null, ["No operator batch label in row"]];

  const label = operatorLabel.trim();

  // Rule (source-first): a FEEDING label (`FEEDING AREA N` / `FEEDING # N` / …)
  // → "<MMM>-<YY>-FEED<N>". ONE output shape for every accepted spelling.
  const mFeed = FEEDING_AREA_RE.exec(label);
  if (mFeed) {
    const feedNum = mFeed[1];
    if (feedNum && deliveryDate) {
      const dt = parseISODate(deliveryDate);
      if (dt) {
        const mmm = MONTH_ABBR_VALUES[dt.month - 1];
        const yy = deliveryDate.slice(2, 4);
        return [`${mmm}-${yy}-FEED${parseInt(feedNum, 10)}`, []];
      }
    }
    return [
      label,
      [
        `FEEDING label '${label}' could not be auto-numbered ` +
          `(missing area number or delivery date). Needs manual mapping.`,
      ],
    ];
  }

  // Rule: PILED IN <MONTH> # <N> in remarks.
  if (remarks) {
    const m = PILED_REMARK_RE.exec(remarks);
    if (m) {
      const monthName = m[1].toUpperCase();
      const num = parseInt(m[2], 10);
      const mmm = MONTH_ABBR[monthName];
      let yy = "26";
      if (deliveryDate) {
        yy = deliveryDate.slice(2, 4);
      }
      if (mmm) {
        return [`${mmm}-${yy}-BLK${num}`, []];
      }
    }
  }

  // Rule: B<N> label, infer month from delivery_date.
  const mB = OPERATOR_B_LABEL_RE.exec(label);
  if (mB && deliveryDate) {
    const num = parseInt(mB[1], 10);
    const dt = parseISODate(deliveryDate);
    if (dt) {
      const mmm = MONTH_ABBR_VALUES[dt.month - 1];
      const yy = deliveryDate.slice(2, 4);
      return [
        `${mmm}-${yy}-BLK${num}`,
        [
          `Batch code translated heuristically: '${label}' -> '${mmm}-${yy}-BLK${num}' ` +
            `(no remarks hint, used delivery month ${mmm})`,
        ],
      ];
    }
  }

  // Fallthrough: emit raw label with warning.
  return [
    label,
    [
      `Could not map operator batch label '${label}' to a Blackwood batch_code; ` +
        `emitting raw value. Row may need manual mapping.`,
    ],
  ];
}

/** Parse a strict "YYYY-MM-DD" ISO date into {year, month, day} (Python
 * datetime.strptime(delivery_date, "%Y-%m-%d")). Returns null if not that exact
 * shape — delivery_date always arrives pre-normalized to ISO from coerce_date. */
function parseISODate(iso: string): { year: number; month: number; day: number } | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return null;
  const year = +m[1], month = +m[2], day = +m[3];
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return { year, month, day };
}

// ---------------------------------------------------------------------------
// Row extraction
// ---------------------------------------------------------------------------
function isAverageOrSummaryRow(sheet: LoadedSheet, rowNum: number): boolean {
  const col1 = sheet.cell(rowNum, 1);
  if (typeof col1 === "string") {
    const t = col1.trim().toLowerCase();
    if (t === "average" || t === "total" || t === "sum") return true;
  }
  if (
    coerceStr(sheet.cell(rowNum, 3)) === null &&
    coerceFloat(sheet.cell(rowNum, 7)) === null &&
    coerceDate(sheet.cell(rowNum, 2)) === null
  ) {
    return true;
  }
  return false;
}

interface ExtractRowOut {
  row: DeliveryRow | null;
  lastSeenDate: string | null;
  extra: string[];
}

function extractRow(
  sheet: LoadedSheet,
  rowNum: number,
  lastSeenDate: string | null,
): ExtractRowOut {
  const warnings: string[] = [];

  if (isAverageOrSummaryRow(sheet, rowNum)) {
    return { row: null, lastSeenDate, extra: [] };
  }

  // Forward-fill date.
  const rawDate = sheet.cell(rowNum, 2);
  let txnDate = coerceDate(rawDate);
  if (txnDate === null) {
    if (lastSeenDate === null) {
      return {
        row: null,
        lastSeenDate,
        extra: [`Row ${rowNum}: no date and no prior date to forward-fill`],
      };
    }
    txnDate = lastSeenDate;
  } else {
    lastSeenDate = txnDate;
  }

  const supplier = coerceStr(sheet.cell(rowNum, 3));
  const weightKg = coerceFloat(sheet.cell(rowNum, 7));

  if (supplier === null && weightKg === null) {
    return { row: null, lastSeenDate, extra: [] };
  }

  if (weightKg === null) {
    warnings.push(`Row ${rowNum}: missing weight_kg — row skipped`);
    return { row: null, lastSeenDate, extra: warnings };
  }
  if (!(WEIGHT_KG_MIN < weightKg && weightKg < WEIGHT_KG_MAX)) {
    warnings.push(
      `Row ${rowNum}: weight ${pyNum(weightKg)} outside plausible range ` +
        `(${WEIGHT_KG_MIN}-${WEIGHT_KG_MAX})`,
    );
  }

  if (supplier === null) {
    warnings.push(`Row ${rowNum}: missing supplier`);
  }

  const blockLoc = coerceStr(sheet.cell(rowNum, 5));
  if (blockLoc && !BLOCK_LOC_REGEX.test(blockLoc)) {
    warnings.push(
      `Row ${rowNum}: block_loc '${blockLoc}' does not match ` +
        `Blackwood format (e.g. A-1A, D-20D, PCA-15A)`,
    );
  }

  const truckPlate = coerceStr(sheet.cell(rowNum, 6));
  const sacks = coerceInt(sheet.cell(rowNum, 8));
  const remarks = coerceStr(sheet.cell(rowNum, 16));

  const operatorBatchLabel = coerceStr(sheet.cell(rowNum, 4));
  const [batchCode, batchWarnings] = translateBatchCode(operatorBatchLabel, remarks, txnDate);
  for (const w of batchWarnings) warnings.push(w);

  // Lab metrics.
  const labResults: LabResults = {};
  const labCols: Array<[number, string]> = [
    [9, "mc"], [10, "grit"], [11, "bd_astm"], [12, "bd_jis"],
    [13, "vm"], [14, "ash"], [15, "fc"],
  ];
  for (const [col, shortKey] of labCols) {
    const val = coerceFloat(sheet.cell(rowNum, col));
    labResults[shortKey] = val;
    if (val !== null && shortKey in LAB_PLAUSIBILITY) {
      const [msg, check] = LAB_PLAUSIBILITY[shortKey];
      if (!check(val)) {
        warnings.push(`Row ${rowNum}: ${msg} (${shortKey}=${pyNum(val)})`);
      }
    }
  }

  const ded = detectDeduction(remarks, weightKg);
  for (const w of ded.warnings) warnings.push(`Row ${rowNum}: ${w}`);

  const confidence = Math.max(0.0, 1.0 - 0.1 * warnings.length);

  const anyLab = Object.values(labResults).some((v) => v !== null);

  const rowDict: DeliveryRow = {
    transaction_date: txnDate,
    supplier,
    batch_code: batchCode,
    operator_batch_label: operatorBatchLabel,
    block_loc: blockLoc,
    truck_plate: truckPlate,
    sacks,
    weight_kg: weightKg,
    cost_basis: null,
    remarks,
    lab_results: anyLab ? labResults : null,
    true_weight_kg: ded.trueWeightKg,
    deduction_note: ded.deductionNote,
    warnings,
    confidence: round3(confidence),
    _source_row: rowNum,
  };
  return { row: rowDict, lastSeenDate, extra: [] };
}

/** Email-path wrapper: compute has_own_date from the RAW col-2 date cell. */
function isRecoveryCandidate(sheet: LoadedSheet, rowNum: number, rowDict: DeliveryRow): boolean {
  const hasOwnDate = coerceDate(sheet.cell(rowNum, 2)) !== null;
  return isRecoveryRowDict(rowDict as unknown as Record<string, unknown>, hasOwnDate);
}

function extractSheet(sheet: LoadedSheet): [DeliveryRow[], string[]] {
  const sheetWarnings: string[] = [];
  const headerRow = findHeaderRow(sheet);
  if (headerRow === null) {
    sheetWarnings.push(
      `Sheet '${sheet.name}': no recognizable header row found in first 15 rows`,
    );
    return [[], sheetWarnings];
  }

  const dataStart = firstDataRowBelow(sheet, headerRow);
  const rows: DeliveryRow[] = [];
  let lastSeenDate: string | null = null;
  let lastMother: DeliveryRow | null = null;

  const maxRow = sheet.rowCount;
  for (let r = dataStart; r < maxRow + 1; r++) {
    const out = extractRow(sheet, r, lastSeenDate);
    lastSeenDate = out.lastSeenDate;
    for (const w of out.extra) sheetWarnings.push(w);
    if (out.row === null) continue;
    const rowDict = out.row;

    if (isRecoveryCandidate(sheet, r, rowDict)) {
      if (isInheritableMother(lastMother as unknown as Record<string, unknown>)) {
        const recovery = buildRecoveryRow(
          rowDict as unknown as Record<string, unknown>,
          lastMother as unknown as Record<string, unknown>,
        ) as unknown as DeliveryRow;
        rows.push(recovery);
        // A recovery does NOT become the mother for a subsequent recovery.
      } else {
        sheetWarnings.push(
          `Row ${r}: recovery-shaped sub-row with no preceding mother ` +
            `delivery to inherit from — left unmapped`,
        );
        rows.push(rowDict);
      }
      continue;
    }

    rows.push(rowDict);
    if (isInheritableMother(rowDict as unknown as Record<string, unknown>)) {
      lastMother = rowDict;
    }
  }

  return [rows, sheetWarnings];
}

// ---------------------------------------------------------------------------
// Public entrypoint — mirrors main()'s default-active-sheet path.
// ---------------------------------------------------------------------------
export function extractDeliveries(
  wb: DeliveriesWorkbook,
  filename: string,
): ExtractResult {
  // Default: the workbook's last-saved active sheet (sync_deliveries.py never passes
  // --sheet/--all-sheets). No sheet available → empty result (mirrors an empty wb).
  const activeName = wb.activeSheetName();
  const sheetNames = activeName ? [activeName] : [];

  const allRows: DeliveryRow[] = [];
  const allWarnings: string[] = [];
  const sheetsProcessed: string[] = [];

  for (const name of sheetNames) {
    const ws = wb.sheet(name);
    if (!ws) continue;
    const [rows, warns] = extractSheet(ws);
    for (const row of rows) row._source_sheet = name;
    allRows.push(...rows);
    allWarnings.push(...warns);
    sheetsProcessed.push(name);
  }

  const confidences = allRows.map((r) => r.confidence);
  const overallConfidence =
    confidences.length > 0
      ? round3(confidences.reduce((a, b) => a + b, 0) / confidences.length)
      : 0.0;

  // unmapped_batches: sorted set of operator labels where batch_code == raw label.
  const unmappedSet = new Set<string>();
  for (const r of allRows) {
    if (r.batch_code === r.operator_batch_label && r.operator_batch_label) {
      unmappedSet.add(r.operator_batch_label);
    }
  }
  const unmapped = [...unmappedSet].sort();

  return {
    filename,
    sheets_processed: sheetsProcessed,
    rows: allRows,
    summary: {
      total_rows: allRows.length,
      extraction_warnings: allWarnings,
      overall_confidence: overallConfidence,
      unmapped_batches: unmapped,
    },
  };
}

// ---------------------------------------------------------------------------
// Local helpers
// ---------------------------------------------------------------------------
import { roundHalfToEven } from "../../lib/norm.js";

function round3(x: number): number {
  return roundHalfToEven(x, 3);
}

/**
 * Python string interpolation of a float in warning messages uses `str(v)` /
 * f-string default, which prints e.g. `20640.0` (a float) but `270` stays via
 * coerce paths. weight_kg is always a float here (coerce_float → float), so a value
 * like 105000.0 must render as "105000.0", matching Python's `f"{weight_kg}"`. These
 * warning strings are NOT diffed by the classifier, so exact form is belt-and-braces.
 */
function pyNum(v: number): string {
  if (Number.isInteger(v)) return `${v}.0`;
  return String(v);
}
