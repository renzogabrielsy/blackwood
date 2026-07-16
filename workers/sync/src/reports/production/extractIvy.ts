/**
 * extractIvy.ts — port of extract_waste_production.py (Ivy's "WASTE PRODUCTION REPORT").
 *
 * One sheet per MONTH, title "MONTHNAME YYYY" (leading space tolerated). One row per
 * (date, shift). Positional column map (NOT header-signature-driven). The 8 SACKS
 * columns are intentionally dropped; only the 8 KLS value columns are stored.
 *
 * --since is ROW-level and EXCLUSIVE (`txn_date <= since -> skip`), unlike MC's
 * sheet-level filter, because waste sheets are MONTHLY and individual rows can be
 * carryovers from an adjacent month (L-028). A carryover row (date's month != sheet
 * month) is still emitted with its TRUE date, plus a warning.
 *
 * normalize_shift here is a SUBSTRING match ("MORNING"/"EVENING"/"NIGHT" in up) —
 * deliberately NOT the same function as extractMc's exact-dict-match. Kept separate.
 *
 * Ground truth: .claude/skills/sync-ictc/scripts/extract_waste_production.py.
 */
import type { LoadedWorkbook, LoadedSheet, CellValue } from "../../lib/xlsx.js";
import { roundHalfToEven } from "../../lib/norm.js";

// ── Month-name conventions ──────────────────────────────────────────────────
const MONTH_NAME_TO_NUM: Record<string, number> = {
  JANUARY: 1, FEBRUARY: 2, MARCH: 3, APRIL: 4, MAY: 5, JUNE: 6,
  JULY: 7, AUGUST: 8, SEPTEMBER: 9, OCTOBER: 10, NOVEMBER: 11, DECEMBER: 12,
};
const NUM_TO_MONTH_NAME: Record<number, string> = Object.fromEntries(
  Object.entries(MONTH_NAME_TO_NUM).map(([k, v]) => [v, k]),
);

const SHEET_NAME_RE = /^\s*([A-Za-z]+)\s+(\d{4})\s*$/;

// Column indices (1-based) — KLS value columns only.
const COL_DATE = 1; // A
const COL_RS1A = 3; // C
const COL_RS1B = 5; // E
const COL_BF = 7; // G
const COL_RS23 = 9; // I
const COL_RS5 = 11; // K
const COL_TRML1 = 13; // M
const COL_TRML2 = 15; // O
const COL_GRIT = 17; // Q
const COL_TTL = 18; // R
const COL_BUYER = 19; // S
const COL_SHIFT = 22; // V

const DATA_START_ROW = 5;

// ── Coercers (mirror the Python coerce_* verbatim) ─────────────────────────
function coerceFloat(value: CellValue): number | null {
  if (value === null || value === "") return null;
  if (typeof value === "boolean") return null;
  if (typeof value === "number") return value;
  if (value instanceof Date) return null;
  if (typeof value === "string") {
    if (value.includes("VALUE")) return null;
    const cleaned = value.replace(/,/g, "").trim();
    if (!cleaned) return null;
    const f = Number(cleaned);
    return Number.isFinite(f) ? f : null;
  }
  return null;
}

function coerceStr(value: CellValue): string | null {
  if (value === null || value === undefined) return null;
  const s = (value instanceof Date ? value.toISOString() : String(value)).trim();
  return s ? s : null;
}

interface YMD {
  y: number;
  m: number;
  d: number;
}

/** coerce_date: Date -> its calendar date; string -> a small set of formats. */
function coerceDate(value: CellValue): YMD | null {
  if (value === null || value === "") return null;
  if (value instanceof Date) {
    if (isNaN(value.getTime())) return null;
    return { y: value.getUTCFullYear(), m: value.getUTCMonth() + 1, d: value.getUTCDate() };
  }
  if (typeof value === "string") {
    const s = value.trim();
    if (s.includes("VALUE")) return null;
    return (
      tryFmt(s, /^(\d{1,4})-(\d{1,2})-(\d{1,2})$/, [1, 2, 3]) ??
      tryFmt(s, /^(\d{1,2})\/(\d{1,2})\/(\d{1,4})$/, [3, 1, 2]) ??
      tryFmtDmy(s) ??
      tryFmt(s, /^(\d{1,4})\/(\d{1,2})\/(\d{1,2})$/, [1, 2, 3]) ??
      tryFmt(s, /^(\d{1,2})-(\d{1,2})-(\d{1,4})$/, [3, 1, 2]) ??
      null
    );
  }
  return null;
}

/** order = [yearGroup, monthGroup, dayGroup] (1-based capture indices). */
function tryFmt(s: string, re: RegExp, order: [number, number, number]): YMD | null {
  const m = s.match(re);
  if (!m) return null;
  const y = +m[order[0]];
  const mo = +m[order[1]];
  const d = +m[order[2]];
  return validYmd(y, mo, d);
}

/** %d/%m/%Y — the 3rd format; separate because it shares the / regex with %m/%d/%Y. */
function tryFmtDmy(s: string): YMD | null {
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{1,4})$/);
  if (!m) return null;
  return validYmd(+m[3], +m[2], +m[1]);
}

function validYmd(y: number, mo: number, d: number): YMD | null {
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
  return { y, m: mo, d };
}

function isoDate({ y, m, d }: YMD): string {
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${p(y, 4)}-${p(m)}-${p(d)}`;
}

/** normalize_shift — SUBSTRING match (distinct from extractMc's exact match). */
function normalizeShift(value: CellValue): string {
  const s = coerceStr(value);
  if (s === null) return "M";
  const up = s.toUpperCase();
  if (up.includes("MORNING")) return "M";
  if (up.includes("EVENING")) return "E";
  if (up.includes("NIGHT")) return "E";
  return "M";
}

function sheetNameToMonth(sheetName: string): number | null {
  const m = sheetName.match(SHEET_NAME_RE);
  if (!m) return null;
  return MONTH_NAME_TO_NUM[m[1].toUpperCase()] ?? null;
}

// ── Row shape ───────────────────────────────────────────────────────────────
export interface WasteRow {
  transaction_date: string;
  production_batch: string;
  shift: string;
  rs1a_kg: number;
  rs1b_kg: number;
  bf_kg: number;
  rs23_kg: number;
  rs5_kg: number;
  trml1_kg: number;
  trml2_kg: number;
  grit_kg: number;
  ttl_waste_kg_reported: number | null;
  remarks: string | null;
  _source_sheet: string;
  _source_row: number;
  _summed_kg: number;
  warnings: string[];
}

export interface IvyExtract {
  waste: WasteRow[];
}

const STREAM_COLS: Array<[keyof Pick<WasteRow, "rs1a_kg" | "rs1b_kg" | "bf_kg" | "rs23_kg" | "rs5_kg" | "trml1_kg" | "trml2_kg" | "grit_kg">, number]> = [
  ["rs1a_kg", COL_RS1A],
  ["rs1b_kg", COL_RS1B],
  ["bf_kg", COL_BF],
  ["rs23_kg", COL_RS23],
  ["rs5_kg", COL_RS5],
  ["trml1_kg", COL_TRML1],
  ["trml2_kg", COL_TRML2],
  ["grit_kg", COL_GRIT],
];

function extractWasteSheet(ws: LoadedSheet, since: string | null): WasteRow[] {
  const sheetMonth = sheetNameToMonth(ws.name);
  if (sheetMonth === null) return [];

  const rows: WasteRow[] = [];
  const maxRow = ws.rowCount;
  for (let r = DATA_START_ROW; r <= maxRow; r++) {
    const ymd = coerceDate(ws.cell(r, COL_DATE));
    if (ymd === null) continue;
    const txnIso = isoDate(ymd);
    if (since !== null && txnIso <= since) continue; // exclusive, silent

    const rowWarnings: string[] = [];
    if (ymd.m !== sheetMonth) {
      rowWarnings.push(
        `Carryover date ${txnIso} in sheet '${ws.name}' ` +
          `(sheet month=${String(sheetMonth).padStart(2, "0")}) — extracted with true date`,
      );
    }

    // 8 streams; missing -> 0.0 (schema NOT NULL DEFAULT 0). `coerce_float(x) or 0.0`
    // — note a genuine 0.0 also falls through to 0.0, matching Python's `or`.
    const streams: Record<string, number> = {};
    for (const [field, col] of STREAM_COLS) {
      streams[field] = coerceFloat(ws.cell(r, col)) || 0.0;
    }
    for (const [field, val] of Object.entries(streams)) {
      if (val < 0) rowWarnings.push(`${field} is negative: ${val}`);
    }

    const shift = normalizeShift(ws.cell(r, COL_SHIFT));
    const productionBatch = NUM_TO_MONTH_NAME[ymd.m];
    const ttlReported = coerceFloat(ws.cell(r, COL_TTL));
    const remarks = coerceStr(ws.cell(r, COL_BUYER));

    const sumStreams = STREAM_COLS.reduce((acc, [f]) => acc + streams[f], 0);
    const summed = roundHalfToEven(sumStreams, 4);

    rows.push({
      transaction_date: txnIso,
      production_batch: productionBatch,
      shift,
      rs1a_kg: streams.rs1a_kg,
      rs1b_kg: streams.rs1b_kg,
      bf_kg: streams.bf_kg,
      rs23_kg: streams.rs23_kg,
      rs5_kg: streams.rs5_kg,
      trml1_kg: streams.trml1_kg,
      trml2_kg: streams.trml2_kg,
      grit_kg: streams.grit_kg,
      ttl_waste_kg_reported: ttlReported,
      remarks,
      _source_sheet: ws.name,
      _source_row: r,
      _summed_kg: summed,
      warnings: rowWarnings,
    });
  }
  return rows;
}

/**
 * Extract Ivy's WASTE PRODUCTION REPORT across ALL sheets, applying the exclusive
 * row-level --since filter.
 */
export function extractIvy(wb: LoadedWorkbook, since: string | null): IvyExtract {
  const waste: WasteRow[] = [];
  for (const name of wb.sheetNames) {
    const ws = wb.sheet(name);
    if (!ws) continue;
    waste.push(...extractWasteSheet(ws, since));
  }
  return { waste };
}
