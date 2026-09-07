/**
 * extract.ts — the PRODUCTS INVENTORY extractor. Pure: workbook in, rows out.
 *
 * Its only job is to capture what the sheet LITERALLY SAYS, per grade, with no
 * interpretation and no cross-record maths (Sync Integrity rule 1). Every balance in
 * this module is computed in SQL from what this file emits.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE SHAPE OF A TAB (measured on the live sheet, 2026-09-07)
 * ─────────────────────────────────────────────────────────────────────────────
 *   row 1                    `<NAME> INVENTORY`, merged across the width
 *   row 2                    TYPE | FLEC/SKS | KG | BLOCK | REMARKS  (the header block)
 *   rows 3..n   col A        stage names, col B = that stage's CURRENT count (a formula)
 *               col G+       threshold text: `ASH TRESHOLD : 1.7`, `50 ME UNDER : 2.00`,
 *                            `VM : 15 MAX` — note BOTH `TRESHOLD` and `THRESHOLD` occur
 *               col H/I      `VANS READY SHIP OUT` = FINAL / 44
 *   a "stage label" row      F..M carrying the stage names in ledger-column order
 *   `FLECON STARTING BALANCE`  label row, then the OPENING values row (+ `AS OF ...`)
 *   `FLECON RUNNING BALANCE`   label row, then the sheet's own current running row
 *   the DATE header row      DATE | TYPE | FLEC / SKS | KG | REMARKS | <stages...>
 *   the ledger               one row per movement, then formula-only rows to ~row 1000
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * FOUR RULES, EACH FOR A MEASURED REASON
 * ─────────────────────────────────────────────────────────────────────────────
 * 1. **THE DATE HEADER ROW IS FOUND, NEVER ASSUMED.** It is row 12 on four tabs and row
 *    13 on `Kuraray 3x50` (which carries an extra OLD PROD stage). Everything else —
 *    the ledger columns, the stage columns, the opening row — is located RELATIVE to it.
 *    A tab where it cannot be found is reported unreadable, never silently skipped.
 * 2. **STAGE COLUMNS COME FROM THE HEADER ROW'S OWN LABELS, NEVER A FIXED POSITION.**
 *    On four tabs F..L is PROD/AYAG/MAGNET/FINAL/BLENDED/SUNDRY/RECLASS; on Kuraray the
 *    whole block is shifted one right by OLD PROD. Reading by position would file every
 *    Kuraray balance under the wrong stage and the numbers would still look plausible.
 * 3. **THE DATE IS CARRIED FORWARD.** Only the first row of a day carries a DATE cell.
 *    Measured: 126 of 331 rows on 6X50, 87 of 216 on 2X6, 93 of 127 on Kuraray, 78 of
 *    101 on 4X8 inherit their date from the row above. Treating a blank DATE as "end of
 *    data" would drop three quarters of Kuraray. A blank DATE with NOTHING else on the
 *    row is a different thing — a spacer carrying only running-balance formulas — and is
 *    skipped.
 * 4. **kg IS NULLABLE AND IS NOT INVENTED.** One real row (6X50, 2025-10-03, AYAG, 2
 *    flec) states no kg. It is emitted with `kg_delta: null`, never 0.
 *
 * NO PESO ANYWHERE — this sheet has no prices in it at all.
 */
import type { LoadedSheet, LoadedWorkbook } from "../../lib/xlsx.js";
import { cellToDateISO } from "../../lib/xlsx.js";
import { monthNumberFromToken } from "../../lib/months.js";
import { canonicalProductToken } from "../../lib/productFingerprint.js";

/** One movement, exactly as the sheet states it. */
export interface ProductMovement {
  /** RESOLVED date (carried forward when the row states none). Always present. */
  transaction_date: string;
  /** Canonical stage from the TYPE column. */
  stage: string;
  flec_delta: number;
  /** null when the row states no kg — never 0. */
  kg_delta: number | null;
  remarks: string | null;
  /** 1-based worksheet row. Part of the row hash; see productFingerprint.ts. */
  source_row: number;
  /** The sheet's OWN running balances on this row, stage -> flecs. Cross-check only. */
  sheet_running: Record<string, number>;
}

/** One product grade = one tab. */
export interface ProductGradeExtract {
  /** The tab name as typed. */
  sheet_name: string;
  /** Canonical identity: upper, trimmed, whitespace-collapsed. */
  code: string;
  /** Stage names in the ledger's own column order (Kuraray's differs). */
  stages: string[];
  /** `{ash_max?, me50_under?, vm_max?}` — any key may be absent. */
  thresholds: Record<string, number>;
  /** The FLECON STARTING BALANCE row's `AS OF ...` date, or null. */
  opening_as_of: string | null;
  openings: Array<{ stage: string; flecs: number }>;
  movements: ProductMovement[];
  /**
   * The tab's OWN header-block counts (col A stage name, col B count). NOT stored and
   * NOT an input to any balance — it is the sheet's independent statement of the same
   * fact, kept so the extractor's arithmetic can be checked against it. A stage the tab
   * leaves blank reads `null`, never 0.
   */
  header_counts: Record<string, number | null>;
  /** 1-based row of the DATE header. */
  header_row: number;
  /** Non-fatal oddities (a dateless first row, an unreadable flec count). */
  warnings: string[];
}

export interface ProductsExtract {
  grades: ProductGradeExtract[];
  /** Tab names whose ledger could be located. */
  readable_tabs: string[];
  /** Tab names whose ledger could NOT be located — the L-048 alarm channel. */
  unreadable_tabs: string[];
  /** Movements across every grade. */
  total_rows: number;
}

/** Ledger columns are located by LABEL, so a column inserted before them cannot silently
 *  shift what is read. Only DATE/TYPE/FLEC are structurally required. */
interface LedgerCols {
  date: number;
  type: number;
  flec: number;
  kg: number | null;
  remarks: number | null;
  /** column index -> canonical stage name. */
  stages: Array<{ col: number; stage: string }>;
}

const MAX_HEADER_SCAN = 40;
/** Stop looking for the ledger's end after this many consecutive wholly-blank rows. The
 *  tabs carry formula-only rows to ~1000; the real ledger ends well before that. */
const BLANK_RUN_LIMIT = 40;

function text(ws: LoadedSheet, row: number, col: number): string {
  const v = ws.cell(row, col);
  if (v == null) return "";
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return String(v).trim();
}

function numeric(ws: LoadedSheet, row: number, col: number): number | null {
  const v = ws.cell(row, col);
  if (v == null || v === "") return null;
  const n = typeof v === "number" ? v : Number(String(v).replace(/,/g, "").trim());
  return Number.isFinite(n) ? n : null;
}

/** Locate the DATE header row and everything hanging off it. Returns null when the tab
 *  has no recognisable ledger — the caller reports it unreadable rather than guessing. */
function findLedger(ws: LoadedSheet): { headerRow: number; cols: LedgerCols } | null {
  let headerRow = 0;
  const limit = Math.min(MAX_HEADER_SCAN, ws.rowCount || MAX_HEADER_SCAN);
  for (let r = 1; r <= limit; r++) {
    if (canonicalProductToken(text(ws, r, 1)) === "DATE") {
      headerRow = r;
      break;
    }
  }
  if (!headerRow) return null;

  const cols: LedgerCols = { date: 0, type: 0, flec: 0, kg: null, remarks: null, stages: [] };
  // Columns A..E carry the row's own fields; F onward carry the running-balance stages.
  for (let c = 1; c <= 5; c++) {
    const label = canonicalProductToken(text(ws, headerRow, c));
    if (!label) continue;
    if (label === "DATE") cols.date = c;
    else if (label === "TYPE") cols.type = c;
    else if (label.startsWith("FLEC")) cols.flec = c;
    else if (label === "KG") cols.kg = c;
    else if (label.startsWith("REMARK")) cols.remarks = c;
  }
  if (!cols.date || !cols.type || !cols.flec) return null;

  for (let c = 6; c <= Math.max(6, ws.columnCount || 20); c++) {
    const label = canonicalProductToken(text(ws, headerRow, c));
    if (label) cols.stages.push({ col: c, stage: label });
  }
  if (cols.stages.length === 0) return null;

  return { headerRow, cols };
}

/** `AS OF AUGUST 30, 2025` -> `2025-08-30`. The month token goes through lib/months.ts —
 *  the ONE month table (L-039's rule), never a local map. */
export function parseAsOfDate(raw: string): string | null {
  const m = /AS\s+OF\s+([A-Za-z.]+)\s+(\d{1,2})\s*,?\s*(\d{4})/i.exec(raw);
  if (!m) return null;
  const month = monthNumberFromToken(m[1].replace(/\./g, ""));
  if (!month) return null;
  const day = Number(m[2]);
  const year = Number(m[3]);
  if (!(day >= 1 && day <= 31) || !(year >= 1900 && year <= 2999)) return null;
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/**
 * Pull the three lab thresholds out of the free text above the ledger. TOLERANT on
 * purpose: the sheet spells it `TRESHOLD` on three tabs and `THRESHOLD` on a fourth, and
 * 8X50 states none at all. A threshold that is not stated is ABSENT from the object, not
 * zero — the whole point of the tolerance is that silence stays silence.
 */
export function parseThresholds(lines: readonly string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const raw of lines) {
    const s = raw.toUpperCase();
    let m = /\bASH\b[^:0-9]*:?\s*([0-9]+(?:\.[0-9]+)?)/.exec(s);
    if (m && out.ash_max === undefined) out.ash_max = Number(m[1]);
    m = /\b50\s*ME\b[^:0-9]*:?\s*([0-9]+(?:\.[0-9]+)?)/.exec(s);
    if (m && out.me50_under === undefined) out.me50_under = Number(m[1]);
    m = /\bVM\b\s*:?\s*([0-9]+(?:\.[0-9]+)?)/.exec(s);
    if (m && out.vm_max === undefined) out.vm_max = Number(m[1]);
  }
  return out;
}

function extractGrade(ws: LoadedSheet): ProductGradeExtract | null {
  const found = findLedger(ws);
  if (!found) return null;
  const { headerRow, cols } = found;
  const warnings: string[] = [];

  // ── header-block text: everything above the ledger, for thresholds ──────────
  const headerText: string[] = [];
  for (let r = 1; r < headerRow; r++) {
    for (let c = 1; c <= Math.max(6, ws.columnCount || 20); c++) {
      const t = text(ws, r, c);
      if (t) headerText.push(t);
    }
  }

  // ── the FLECON STARTING BALANCE row: the label, then the values on the NEXT row ──
  let openingRow = 0;
  for (let r = 1; r < headerRow && !openingRow; r++) {
    for (let c = 1; c <= Math.max(6, ws.columnCount || 20); c++) {
      if (canonicalProductToken(text(ws, r, c)).startsWith("FLECON STARTING")) {
        openingRow = r + 1;
        break;
      }
    }
  }
  const openings: Array<{ stage: string; flecs: number }> = [];
  let openingAsOf: string | null = null;
  if (openingRow && openingRow < headerRow) {
    for (const s of cols.stages) {
      const v = numeric(ws, openingRow, s.col);
      if (v != null) openings.push({ stage: s.stage, flecs: Math.round(v) });
    }
    for (let c = 1; c <= Math.max(6, ws.columnCount || 24); c++) {
      const parsed = parseAsOfDate(text(ws, openingRow, c));
      if (parsed) {
        openingAsOf = parsed;
        break;
      }
    }
  } else {
    warnings.push("No FLECON STARTING BALANCE row found — opening balances read as zero.");
  }

  // ── the tab's own header-block counts (the independent witness) ─────────────
  const stageNames = cols.stages.map((s) => s.stage);
  const headerCounts: Record<string, number | null> = {};
  for (let r = 2; r < headerRow; r++) {
    const name = canonicalProductToken(text(ws, r, 1));
    if (!name || !stageNames.includes(name)) continue;
    headerCounts[name] = numeric(ws, r, 2);
  }

  // ── the ledger ─────────────────────────────────────────────────────────────
  const movements: ProductMovement[] = [];
  let currentDate: string | null = null;
  let blankRun = 0;
  const lastRow = ws.rowCount || headerRow;
  for (let r = headerRow + 1; r <= lastRow && blankRun < BLANK_RUN_LIMIT; r++) {
    const dateCell = ws.cell(r, cols.date);
    const iso = cellToDateISO(dateCell);
    if (iso) currentDate = iso;

    const stageRaw = text(ws, r, cols.type);
    const flec = numeric(ws, r, cols.flec);
    const kg = cols.kg == null ? null : numeric(ws, r, cols.kg);

    if (!stageRaw && flec == null && kg == null) {
      // Rule 3: a spacer row (running-balance formulas only), or trailing emptiness.
      // Only rows with nothing AT ALL on them count toward the end-of-ledger run.
      const anything = cols.stages.some((s) => ws.cell(r, s.col) != null && ws.cell(r, s.col) !== "");
      blankRun = anything || iso ? 0 : blankRun + 1;
      continue;
    }
    blankRun = 0;

    if (dateCell != null && dateCell !== "" && !iso) {
      warnings.push(`Row ${r}: the DATE cell is not a date (${JSON.stringify(dateCell)}) — skipped.`);
      continue;
    }
    if (!stageRaw) {
      warnings.push(`Row ${r}: a movement with no TYPE (flec ${flec ?? "—"}, kg ${kg ?? "—"}) — skipped.`);
      continue;
    }
    if (!currentDate) {
      warnings.push(`Row ${r}: ${stageRaw} has no date and none to carry forward — skipped.`);
      continue;
    }
    if (flec == null || !Number.isInteger(flec)) {
      warnings.push(`Row ${r}: ${stageRaw} has no whole flec count (${flec ?? "blank"}) — skipped.`);
      continue;
    }

    const running: Record<string, number> = {};
    for (const s of cols.stages) {
      const v = numeric(ws, r, s.col);
      if (v != null) running[s.stage] = v;
    }

    movements.push({
      transaction_date: currentDate,
      stage: canonicalProductToken(stageRaw),
      flec_delta: flec,
      kg_delta: kg,
      remarks: cols.remarks == null ? null : text(ws, r, cols.remarks) || null,
      source_row: r,
      sheet_running: running,
    });
  }

  return {
    sheet_name: ws.name,
    code: canonicalProductToken(ws.name),
    stages: stageNames,
    thresholds: parseThresholds(headerText),
    opening_as_of: openingAsOf,
    openings,
    movements,
    header_counts: headerCounts,
    header_row: headerRow,
    warnings,
  };
}

/** Extract every product grade in the workbook. Never throws on a bad tab: an
 *  unreadable one lands in `unreadable_tabs` so the run can say so out loud (L-048). */
export function extractProducts(wb: LoadedWorkbook): ProductsExtract {
  const grades: ProductGradeExtract[] = [];
  const readable: string[] = [];
  const unreadable: string[] = [];

  for (const name of wb.sheetNames) {
    const ws = wb.sheet(name);
    if (!ws) {
      unreadable.push(name);
      continue;
    }
    let grade: ProductGradeExtract | null = null;
    try {
      grade = extractGrade(ws);
    } catch {
      grade = null;
    }
    if (!grade) {
      unreadable.push(name);
      continue;
    }
    readable.push(name);
    grades.push(grade);
  }

  return {
    grades,
    readable_tabs: readable,
    unreadable_tabs: unreadable,
    total_rows: grades.reduce((n, g) => n + g.movements.length, 0),
  };
}
