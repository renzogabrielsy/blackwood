/**
 * parse.ts — PURE parse + merge for the production PLAN (`production_schedule`).
 *
 * FAITHFUL PORT of the two verified root scripts (read as the SPEC), byte-for-byte
 * behaviour preserved so the worker's output is identical to what already populated
 * `production_schedule` (273 rows: 91 joseph:REV2 + 182 gsheet:PROD SCHED):
 *
 *   - scripts/sync-prod-schedule.ts  → parseProdSchedule() + the cell coercers +
 *     the TIMEZONE-SAFE `dateISO()` (XLSX.SSF.parse_date_code — do NOT regress to a
 *     JS Date, which anchors to local midnight and shifts every plan_date one day
 *     early on a UTC+8 host).
 *   - scripts/joseph-prod-sched.ts   → parseJosephRev() + parseJosephSchedule() +
 *     mergeSchedules() (Joseph's scheduling wins, Renzo's tonnages kept, zeroed on
 *     Joseph's non-work days) + composeJosephRemarks().
 *
 * This module has ZERO IO — no dotenv, no supabase, no fs, no Gmail. It imports only
 * SheetJS (`xlsx`). The worker deliberately re-parses the raw workbook bytes with
 * SheetJS here (rather than the worker's exceljs `loadWorkbook`) precisely because the
 * verified date handling relies on SheetJS's SSF serial decoder. The IO wrappers live
 * in ./josephEmail.ts and ./refresh.ts.
 */
// SheetJS is a CommonJS module. Under the worker's ESM, a namespace star-import does
// NOT expose `SSF` (Node's cjs-module-lexer detects `read`/`utils` but misses `SSF`),
// which silently breaks the timezone-safe `SSF.parse_date_code` date path. The DEFAULT
// import yields the full CJS exports object (SSF + read + utils all present) — verified
// under tsx, vitest, and esbuild. Do NOT switch this to `import * as XLSX`.
import XLSX from "xlsx";
import type { WorkSheet } from "xlsx";

// ===========================================================================
// Renzo's PROD SCHED tab  (port of scripts/sync-prod-schedule.ts pure core)
// ===========================================================================

const TAB_NAME = "PROD SCHED";
const FIRST_DATA_ROW = 14;

/** Per-grade projected-tons columns (1-indexed) → grade label. */
const GRADE_COLS: ReadonlyArray<readonly [number, string]> = [
  [10, "3X50"],
  [11, "6X50"],
  [12, "8X50"],
  [13, "4X8"],
  [14, "2X6"],
];

const MONTHS: Record<string, number> = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
  july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
};

export interface ProdScheduleRow {
  plan_date: string; // yyyy-MM-dd
  year: number;
  month: number;
  dow: string | null;
  shifts: number;
  setup: string | null;
  projected_tons: number | null;
  grades: Record<string, number> | null;
  remarks: string | null;
  source: string;
}

// --- pure cell coercers (mirror the workers/sync norm helpers) ---

function toStr(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s.length ? s : null;
}

function toNum(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

function toInt(v: unknown): number | null {
  const n = toNum(v);
  return n === null ? null : Math.trunc(n);
}

/**
 * yyyy-MM-dd from an Excel DATE cell, timezone-INDEPENDENT.
 *
 * The workbook is read with `cellDates: false`, so a real date cell arrives as a
 * raw Excel serial (a number). We convert it with SheetJS's `SSF.parse_date_code`,
 * which returns integer `{ y, m, d }` calendar fields directly — no JS `Date`, no
 * host-timezone shift.
 *
 * Monthly-total rows carry a STRING in the DATE column (e.g. "2026 July") and
 * blank filler rows are null — both are non-numeric here, return null, and are
 * skipped by the caller.
 */
function dateISO(v: unknown): string | null {
  if (typeof v !== "number" || !Number.isFinite(v)) return null;
  const d = XLSX.SSF.parse_date_code(v);
  if (!d || !d.y || !d.m || !d.d) return null;
  return `${d.y}-${String(d.m).padStart(2, "0")}-${String(d.d).padStart(2, "0")}`;
}

/** Parse the "PROD SCHED" tab bytes into schedule rows (pure — no IO). */
export function parseProdSchedule(buf: Buffer): ProdScheduleRow[] {
  // cellDates:false → DATE cells stay raw Excel serials (numbers); dateISO()
  // decodes them with SSF.parse_date_code, host-timezone-independent. Do NOT
  // switch this back to cellDates:true — that reintroduces the local-midnight
  // anchoring that shifted every plan_date one day early on a UTC+8 host.
  const wb = XLSX.read(buf, { cellDates: false });
  const ws = wb.Sheets[TAB_NAME];
  if (!ws) {
    throw new Error(
      `Tab "${TAB_NAME}" not found. Tabs: ${wb.SheetNames.join(", ")}`
    );
  }
  const range = XLSX.utils.decode_range(ws["!ref"]!);
  const cell = (r: number, c: number): unknown => {
    const addr = XLSX.utils.encode_cell({ r: r - 1, c: c - 1 });
    const obj = ws[addr] as { v?: unknown } | undefined;
    return obj ? obj.v : null;
  };

  const rows: ProdScheduleRow[] = [];
  for (let r = FIRST_DATA_ROW; r <= range.e.r + 1; r++) {
    const rawDate = cell(r, 2);
    const planDate = dateISO(rawDate);
    // Skip any row whose DATE cell is not a real date (monthly-total rows carry
    // a STRING like "2026 July"; blank filler rows are null).
    if (!planDate) continue;

    const year = toInt(cell(r, 1));
    const monthName = toStr(cell(r, 3));
    const month = monthName ? MONTHS[monthName.toLowerCase()] ?? null : null;
    // year/month are NOT NULL columns — fall back to the plan_date if the sheet
    // ever leaves the label blank on a dated row.
    const resolvedYear = year ?? Number(planDate.slice(0, 4));
    const resolvedMonth = month ?? Number(planDate.slice(5, 7));

    const dow = toStr(cell(r, 4));
    const shifts = toInt(cell(r, 9)) ?? 0;

    // setup = first non-empty of MORNING / EVENING / NIGHT (morning primary);
    // null on a planned rest day (shifts === 0).
    let setup: string | null = null;
    if (shifts > 0) {
      setup = toStr(cell(r, 6)) ?? toStr(cell(r, 7)) ?? toStr(cell(r, 8));
    }

    const projected = toNum(cell(r, 19));

    // grades: drop null/zero contributions.
    const grades: Record<string, number> = {};
    for (const [col, label] of GRADE_COLS) {
      const g = toNum(cell(r, col));
      if (g && g !== 0) grades[label] = g;
    }

    rows.push({
      plan_date: planDate,
      year: resolvedYear,
      month: resolvedMonth,
      dow,
      shifts,
      setup,
      projected_tons: projected,
      grades: Object.keys(grades).length ? grades : null,
      remarks: toStr(cell(r, 5)),
      source: "gsheet:PROD SCHED",
    });
  }
  return rows;
}

// ===========================================================================
// Joseph Go's overlay  (port of scripts/joseph-prod-sched.ts pure core)
// ===========================================================================

export interface JosephRev {
  /** provenance tag written to production_schedule.source, e.g. "joseph:REV2" */
  sourceTag: string;
  /** human label used in remarks, e.g. "Joseph REV#2" */
  remarkLabel: string;
  /** revision number, or null when unknown */
  n: number | null;
}

/** Derive a revision label from a subject line or filename fragment. */
export function parseJosephRev(s: string | null | undefined): JosephRev {
  const text = s ?? "";
  // "REVISION # 2 ...", "REV#2", "REV 2", "REV2"
  const m = text.match(/REV(?:ISION)?\s*#?\s*(\d+)/i);
  const n = m ? Number(m[1]) : null;
  if (n === null) {
    return { sourceTag: "joseph:REV", remarkLabel: "Joseph", n: null };
  }
  return { sourceTag: `joseph:REV${n}`, remarkLabel: `Joseph REV#${n}`, n };
}

/**
 * Exact-string map from Joseph's col-D production text (normalized: uppercased,
 * internal whitespace collapsed, trimmed) → Renzo's canonical setup vocabulary.
 * Renzo's valid setups: SOLID 3X50, 3X50 / 6X50, 3X50 / 8X50, 3X50 / 4X8, 3X50 / 2X6.
 * Every key here was verified verbatim against the REV#2 workbook's 2026 3Q tab.
 */
const KNOWN_SETUP_MAP: Record<string, string> = {
  "12HRS OPS MIX PROD: 4X8 MHTA & 3X50 CNP": "3X50 / 4X8",
  "SOLID PRODUCTION 3X50 CEBU": "SOLID 3X50",
  "MIX PROD: 6X50FG & 3X50 CNP": "3X50 / 6X50",
  "MIX PROD: 8X50 MHTA & 3X50 CNP": "3X50 / 8X50",
  "PAHUBAS 3 X 50 SOLID FOR CEBU ONLY": "SOLID 3X50",
};

/**
 * col-D labels that are HOLIDAY designations, not production setups. On a work
 * day these carry a note but yield NO setup from Joseph (merge falls back to
 * Renzo's setup) — they must NOT be logged as "unmapped setup".
 */
const NON_SETUP_LABELS = new Set(["NINOY HOLIDAY SPCL", "HOLIDAY SWAP"]);

function normDText(v: string): string {
  return v.replace(/\s+/g, " ").trim().toUpperCase();
}

const MONTH_ABBR: Record<string, number> = {
  JAN: 1, FEB: 2, MAR: 3, APR: 4, MAY: 5, JUN: 6,
  JUL: 7, AUG: 8, SEP: 9, OCT: 10, NOV: 11, DEC: 12,
};

/** month number from a word like "JULY" / "AUG." / "SEPT." (first 3 letters). */
function monthFromWord(word: string): number | null {
  const key = word.replace(/\./g, "").trim().toUpperCase().slice(0, 3);
  return MONTH_ABBR[key] ?? null;
}

export interface JosephDay {
  plan_date: string; // yyyy-MM-dd
  shifts: number; // 1 = work, 0 = rest (PAHUBAS => 1)
  /** normalized setup, or null when Joseph specifies none (holiday-only / empty). */
  setup: string | null;
  /** 8 or 12, or null when the row states no shift hours (e.g. bare PAHUBAS). */
  shiftHours: number | null;
  /** non-work reason on a rest day ("Sunday" / "Optional leave day" / "Holiday"). */
  reason: string | null;
  /** special note on a work day ("Holiday: Ninoy" / "Holiday swap" / "PAHUBAS wind-down"). */
  note: string | null;
  rawB: string;
  rawD: string | null;
}

export interface JosephParseResult {
  days: JosephDay[];
  selectedTabs: string[];
  warnings: string[];
}

function toStrCell(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s.length ? s : null;
}

/**
 * Parse Joseph's workbook. Selects the current + forward quarter tabs of
 * `targetYear` (tabs named "<year> <q>Q"), ignoring all history tabs.
 */
export function parseJosephSchedule(
  buf: Buffer,
  opts: { targetYear: number; fromQuarter: number }
): JosephParseResult {
  const wb = XLSX.read(buf, { cellDates: false });
  const warnings: string[] = [];

  // Pick this-year tabs at/after the current quarter (trim — some tab names
  // carry a trailing space, e.g. "2026 2Q ").
  const selected: Array<{ name: string; quarter: number }> = [];
  for (const raw of wb.SheetNames) {
    const m = raw.trim().match(/^(\d{4})\s*(\d)Q$/);
    if (!m) continue;
    const y = Number(m[1]);
    const q = Number(m[2]);
    if (y === opts.targetYear && q >= opts.fromQuarter) {
      selected.push({ name: raw, quarter: q });
    }
  }
  selected.sort((a, b) => a.quarter - b.quarter);

  const days: JosephDay[] = [];
  for (const { name } of selected) {
    parseQuarterTab(wb.Sheets[name], name, opts.targetYear, days, warnings);
  }

  return { days, selectedTabs: selected.map((s) => s.name), warnings };
}

function parseQuarterTab(
  ws: WorkSheet,
  tabName: string,
  tabYear: number,
  out: JosephDay[],
  warnings: string[]
): void {
  const range = XLSX.utils.decode_range(ws["!ref"]!);
  const cell = (r: number, c: number): unknown => {
    const addr = XLSX.utils.encode_cell({ r: r - 1, c: c - 1 });
    const obj = ws[addr] as { v?: unknown } | undefined;
    return obj ? obj.v : null;
  };

  let currentMonth: number | null = null;

  for (let r = 1; r <= range.e.r + 1; r++) {
    // (1) section-header scan (cols A..F) — "MONTH OF JULY 2026".
    for (let c = 1; c <= 6; c++) {
      const s = toStrCell(cell(r, c));
      if (!s) continue;
      const mh = s.match(/MONTH OF\s+([A-Za-z]+)\.?\s+(\d{4})/i);
      if (mh) {
        const mnum = monthFromWord(mh[1]);
        if (mnum) currentMonth = mnum;
      }
    }

    // (2) date token in col A.
    const tokenRaw = toStrCell(cell(r, 1));
    if (!tokenRaw) continue;
    const token = tokenRaw.replace(/\s+/g, " ").trim();

    let month: number | null;
    let day: number | null;
    const withMonth = token.match(/^([A-Za-z]+)\.?\s+(\d{1,2})$/);
    const dayOnly = token.match(/^(\d{1,2})$/);
    if (withMonth) {
      month = monthFromWord(withMonth[1]);
      day = Number(withMonth[2]);
      if (month && currentMonth && month !== currentMonth) {
        warnings.push(
          `${tabName}: row ${r} token "${tokenRaw}" month ${month} disagrees with section month ${currentMonth}`
        );
      }
    } else if (dayOnly) {
      month = currentMonth;
      day = Number(dayOnly[1]);
    } else {
      continue; // not a date row (headers like "REV# 1", "DATE", etc.)
    }
    if (!month || !day) continue;

    const planDate = `${tabYear}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;

    const bRaw = toStrCell(cell(r, 2));
    const dRaw = toStrCell(cell(r, 4));

    // A dated row with no operation text = not-yet-scheduled → do NOT override.
    if (!bRaw) {
      warnings.push(`${planDate}: date present but empty operation text (col B) — left to Renzo`);
      continue;
    }

    const B = bRaw.replace(/\s+/g, " ").trim().toUpperCase();
    const D = dRaw ? normDText(dRaw) : null;

    let shifts: number;
    let reason: string | null = null;
    let note: string | null = null;

    // Classify work/rest primarily from col B.
    if (B.includes("NO OPERATION")) {
      shifts = 0;
      reason = B.includes("SUNDAY") ? "Sunday" : "No operation";
    } else if (B.includes("NO WORK")) {
      shifts = 0;
      reason = B.includes("LEAVE") ? "Optional leave day" : "No work";
    } else if (B.includes("HOLIDAY") && B.includes("NO") && B.includes("OP")) {
      shifts = 0;
      reason = "Holiday";
    } else if (B.includes("PAHUBAS")) {
      shifts = 1;
      note = "PAHUBAS wind-down";
    } else if (B.includes("SINGLE SHIFT") || B.includes("SHIFT")) {
      shifts = 1;
    } else {
      warnings.push(`${planDate}: unrecognized operation text "${bRaw}" — left to Renzo`);
      continue;
    }

    // Shift hours from col B.
    let shiftHours: number | null = null;
    if (B.includes("12HR") || B.includes("8-8PM")) shiftHours = 12;
    else if (B.includes("8HR") || B.includes("8-5PM")) shiftHours = 8;

    // Setup + work-day notes from col D.
    let setup: string | null = null;
    if (shifts > 0 && D) {
      if (KNOWN_SETUP_MAP[D]) {
        setup = KNOWN_SETUP_MAP[D];
      } else if (NON_SETUP_LABELS.has(D)) {
        setup = null; // holiday label, not a setup — fall back to Renzo on merge
      } else {
        setup = null;
        warnings.push(`${planDate}: unmapped setup text "${dRaw}" — kept null, Renzo setup retained`);
      }
      // Work-day notes derived from col D.
      if (D.includes("NINOY")) note = joinNote(note, "Holiday: Ninoy");
      else if (D.includes("HOLIDAY SWAP")) note = joinNote(note, "Holiday swap");
      else if (D.includes("PAHUBAS")) note = joinNote(note, "PAHUBAS wind-down");
    }

    out.push({
      plan_date: planDate,
      shifts,
      setup,
      shiftHours,
      reason,
      note,
      rawB: bRaw,
      rawD: dRaw,
    });
  }
}

function joinNote(existing: string | null, add: string): string {
  if (!existing) return add;
  if (existing.includes(add)) return existing;
  return `${existing} · ${add}`;
}

function composeJosephRemarks(j: JosephDay, rev: JosephRev): string {
  const parts: string[] = [];
  if (j.shifts > 0) {
    if (j.shiftHours) parts.push(`${j.shiftHours}-hr`);
    if (j.note) parts.push(j.note);
  } else if (j.reason) {
    parts.push(j.reason);
  }
  const base = parts.join(" · ");
  return base ? `${base} (per ${rev.remarkLabel})` : `(per ${rev.remarkLabel})`;
}

export interface MergeResult {
  rows: ProdScheduleRow[];
  overriddenDates: string[];
}

/**
 * Overlay Joseph's scheduling onto Renzo's base rows. Renzo's tons/grades are
 * kept on work days and zeroed on Joseph's non-work days. Setup is Joseph's
 * normalized setup on work days (falling back to Renzo's when Joseph gives none),
 * null on rest days. Dates Joseph doesn't cover stay 100% Renzo's.
 */
export function mergeSchedules(
  renzoRows: ProdScheduleRow[],
  josephDays: JosephDay[],
  rev: JosephRev
): MergeResult {
  const byDate = new Map<string, JosephDay>();
  for (const j of josephDays) byDate.set(j.plan_date, j);

  const overriddenDates: string[] = [];
  const rows = renzoRows.map((base) => {
    const j = byDate.get(base.plan_date);
    if (!j) return base; // uncovered → keep Renzo (source stays gsheet:PROD SCHED)

    overriddenDates.push(base.plan_date);
    const work = j.shifts > 0;
    return {
      ...base,
      shifts: j.shifts,
      // work: Joseph's setup, else fall back to Renzo's; rest: null.
      setup: work ? (j.setup ?? base.setup) : null,
      // KEEP Renzo's tonnage/grades on work days; zero them on non-work days.
      projected_tons: work ? base.projected_tons : 0,
      grades: work ? base.grades : null,
      remarks: composeJosephRemarks(j, rev),
      source: rev.sourceTag,
    };
  });

  return { rows, overriddenDates };
}
