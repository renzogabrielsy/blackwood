/**
 * sync-prod-schedule.ts — populate `public.production_schedule` from the LIVE
 * Google Sheet "PROD SCHED" tab.
 *
 * This is the repeatable populate routine for the daily production PLAN that
 * backs the Home Digest operational-day STATES (reported / awaiting / rest /
 * stale / idle) + the plant-status + this-week plan. It is idempotent
 * (upsert by plan_date / replace-by-date), so it can be re-run any time and
 * later wired into the sync worker so the plan self-refreshes each run.
 *
 * Source: the link-shared workbook (no auth) exported as XLSX. The "PROD SCHED"
 * tab holds one row per calendar day starting at row 14. Monthly-total rows
 * carry a STRING in the DATE column (e.g. "2026 July") and are skipped — only
 * rows whose DATE cell is a real date are ingested.
 *
 * Columns (1-indexed): A=YEAR, B=DATE, C=MONTH(name), D=DOW, E=REMARKS,
 *   F=MORNING setup, G=EVENING setup, H=NIGHT setup, I=NO. OF SHIFTS(0/1/2),
 *   J=3X50, K=6X50, L=8X50, M=4X8, N=2X6 (per-grade projected tons),
 *   S(19)=TTL (projected total tons).
 *
 * Run directly:  npx tsx scripts/sync-prod-schedule.ts
 * Or import { syncProdSchedule } and call from the sync worker.
 *
 * Writes with the SERVICE ROLE key (bypasses RLS) — never expose to the browser.
 */
import { createClient } from "@supabase/supabase-js";
import * as XLSX from "xlsx";
import dotenv from "dotenv";

dotenv.config({ path: ".env.local" });

const WORKBOOK_URL =
  "https://docs.google.com/spreadsheets/d/1yBZ0wW0DTr4ktYYtDIgXSVVoGsiETawyppkdyV1EiMM/export?format=xlsx";
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

/** yyyy-MM-dd from a JS Date read in UTC (xlsx cellDates yields UTC-anchored dates). */
function dateISO(v: unknown): string | null {
  if (v instanceof Date && !isNaN(v.getTime())) {
    const y = v.getUTCFullYear();
    const m = String(v.getUTCMonth() + 1).padStart(2, "0");
    const d = String(v.getUTCDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
  }
  return null;
}

/** Parse the "PROD SCHED" tab bytes into schedule rows (pure — no IO). */
export function parseProdSchedule(buf: Buffer): ProdScheduleRow[] {
  const wb = XLSX.read(buf, { cellDates: true });
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

/** Download the workbook bytes (link-shared, no auth). Verifies the PK header. */
export async function downloadWorkbook(url = WORKBOOK_URL): Promise<Buffer> {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Workbook download failed: ${res.status} ${res.statusText}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < 2 || buf[0] !== 0x50 || buf[1] !== 0x4b) {
    throw new Error(
      `Downloaded file is not an XLSX (expected PK header, got ${buf
        .subarray(0, 8)
        .toString("hex")}). The share link may have changed.`
    );
  }
  return buf;
}

export interface SyncProdScheduleResult {
  parsed: number;
  upserted: number;
  minDate: string | null;
  maxDate: string | null;
}

/**
 * Full populate routine: download → parse → upsert by plan_date. Idempotent.
 * Pass a preloaded buffer (e.g. the worker's already-downloaded workbook) to
 * skip the network fetch.
 */
export async function syncProdSchedule(
  opts: { buffer?: Buffer } = {}
): Promise<SyncProdScheduleResult> {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceKey) {
    throw new Error(
      "Missing NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY in .env.local"
    );
  }
  const supabase = createClient(supabaseUrl, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const buf = opts.buffer ?? (await downloadWorkbook());
  const rows = parseProdSchedule(buf);
  if (rows.length === 0) {
    throw new Error("Parsed 0 schedule rows — refusing to write (sheet layout may have changed).");
  }

  // Upsert by primary key plan_date (replace-by-date). updated_at refreshes.
  const payload = rows.map((r) => ({ ...r, updated_at: new Date().toISOString() }));
  const { error } = await supabase
    .from("production_schedule")
    .upsert(payload, { onConflict: "plan_date" });
  if (error) throw new Error(`Upsert failed: ${error.message}`);

  const dates = rows.map((r) => r.plan_date).sort();
  return {
    parsed: rows.length,
    upserted: payload.length,
    minDate: dates[0] ?? null,
    maxDate: dates[dates.length - 1] ?? null,
  };
}

// --- CLI entry ---
const isMain =
  typeof process !== "undefined" &&
  process.argv[1] &&
  process.argv[1].endsWith("sync-prod-schedule.ts");

if (isMain) {
  syncProdSchedule()
    .then((res) => {
      console.log(
        `[sync-prod-schedule] parsed=${res.parsed} upserted=${res.upserted} range=${res.minDate}..${res.maxDate}`
      );
      process.exit(0);
    })
    .catch((err) => {
      console.error("[sync-prod-schedule] FAILED:", err.message ?? err);
      process.exit(1);
    });
}
