/**
 * joseph-prod-sched.ts — parse Joseph Go's authoritative "PRODUCTION SCHEDULE"
 * workbook and overlay its SCHEDULING onto Renzo's PROD SCHED base rows.
 *
 * THE RULE (confirmed by Renzo):
 *   - Renzo's PROD SCHED tab is the BASE: full-year daily template + projected
 *     tonnages + grades.
 *   - Joseph's latest revision's SCHEDULING wins: which days work vs rest, the
 *     setup/grade per day, campaign-switch dates, non-work day-types, shift hours.
 *   - Joseph's TONNAGES ARE IGNORED — Renzo's per-date tons/grades are kept on
 *     work days, and zeroed only when Joseph marks the day non-work.
 *
 * Joseph's file: one tab PER QUARTER ("2026 3Q" = Jul–Sep), plus history back to
 * 2023. Only the current + forward quarters of the current year are parsed; all
 * history tabs are ignored. Within a quarter tab the daily section starts after a
 * "DATE" header (~row 13); month context comes from "MONTH OF <MONTH> <YEAR>"
 * section headers (col F). Per row: col A = date token ("JULY 1", "AUG. 3",
 * " SEPT. 1"); col B = operation/shift text; col D = setup/production text;
 * E/G/I = his plan tons, F/H/J = his actuals — ALL of Joseph's tonnage columns
 * are ignored.
 *
 * Pure parser + merge (no IO) live here; the guarded IMAP fetch is at the bottom.
 */
import * as XLSX from "xlsx";
import fs from "fs";
import path from "path";
import { createRequire } from "module";
import type { ProdScheduleRow } from "./sync-prod-schedule";

// ---------------------------------------------------------------------------
// Revision label
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Setup normalization (col D → Renzo's setup vocabulary)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Month tokens
// ---------------------------------------------------------------------------

const MONTH_ABBR: Record<string, number> = {
  JAN: 1, FEB: 2, MAR: 3, APR: 4, MAY: 5, JUN: 6,
  JUL: 7, AUG: 8, SEP: 9, OCT: 10, NOV: 11, DEC: 12,
};

/** month number from a word like "JULY" / "AUG." / "SEPT." (first 3 letters). */
function monthFromWord(word: string): number | null {
  const key = word.replace(/\./g, "").trim().toUpperCase().slice(0, 3);
  return MONTH_ABBR[key] ?? null;
}

// ---------------------------------------------------------------------------
// Parsed Joseph day
// ---------------------------------------------------------------------------

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
  ws: XLSX.WorkSheet,
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

// ---------------------------------------------------------------------------
// Merge
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// IO: load Joseph's workbook (saved file by default, optional IMAP fetch)
// ---------------------------------------------------------------------------

export const JOSEPH_DIR = ".sync-flags/joseph-prod-sched";
export const JOSEPH_SAVED_FILE = path.join(
  JOSEPH_DIR,
  "joseph_REV2_2026_PRODUCTION_SCHEDULE.xlsx"
);
const JOSEPH_SENDER = "kitz323@yahoo.com";

export interface JosephSource {
  buffer: Buffer;
  rev: JosephRev;
  origin: string; // human description of where the workbook came from
}

/**
 * Load Joseph's workbook. By default reads the saved REV#2 file. When
 * `useImap` is set, attempts an IMAP fetch of his latest schedule email first
 * and falls back to the saved file if IMAP is unavailable or finds nothing.
 */
export async function loadJosephSchedule(
  opts: { useImap?: boolean; savedFile?: string } = {}
): Promise<JosephSource> {
  const savedFile = opts.savedFile ?? JOSEPH_SAVED_FILE;

  if (opts.useImap) {
    try {
      const fetched = await fetchLatestJosephScheduleViaImap();
      if (fetched) return fetched;
      console.warn("[joseph] IMAP found no matching email — using saved file.");
    } catch (err) {
      console.warn(
        `[joseph] IMAP fetch failed (${(err as Error).message}) — using saved file.`
      );
    }
  }

  if (!fs.existsSync(savedFile)) {
    throw new Error(`Joseph saved schedule not found at ${savedFile}`);
  }
  const buffer = fs.readFileSync(savedFile);
  return {
    buffer,
    rev: parseJosephRev(path.basename(savedFile)),
    origin: `saved file ${savedFile}`,
  };
}

/**
 * Guarded IMAP fetch of Joseph's latest "PRODUCTION SCHEDULE" email. Returns
 * null when no matching email is found. Throws on connection/auth failure (the
 * caller treats any throw as "IMAP unavailable" and falls back to the saved
 * file). Uses GMAIL_USER / GMAIL_APP_PASSWORD from workers/sync/.env and the
 * imapflow + mailparser installed under workers/sync (dynamically resolved so
 * this root script carries no new dependency).
 */
export async function fetchLatestJosephScheduleViaImap(): Promise<JosephSource | null> {
  // Load Gmail creds from the worker env file (App Password only).
  loadWorkerEnv();
  const user = process.env.GMAIL_USER;
  const pass = process.env.GMAIL_APP_PASSWORD;
  if (!user || !pass) {
    throw new Error("GMAIL_USER / GMAIL_APP_PASSWORD not set (workers/sync/.env)");
  }

  // Resolve imapflow + mailparser from workers/sync/node_modules.
  const workerRequire = createRequire(
    path.resolve("workers/sync/package.json")
  );
  // Dynamically resolved from workers/sync/node_modules — typed as any so this
  // root script needs no imapflow/mailparser dependency or type packages.
  /* eslint-disable @typescript-eslint/no-explicit-any */
  const { ImapFlow } = workerRequire("imapflow") as any;
  const { simpleParser } = workerRequire("mailparser") as any;
  /* eslint-enable @typescript-eslint/no-explicit-any */

  const client = new ImapFlow({
    host: "imap.gmail.com",
    port: 993,
    secure: true,
    auth: { user, pass },
    logger: false,
  });

  await client.connect();
  try {
    const lock = await client.getMailboxLock("[Gmail]/All Mail").catch(() => null);
    const usingLock = lock ?? (await client.getMailboxLock("INBOX"));
    try {
      // Gmail X-GM-RAW search: sender + either subject phrase.
      const uids = (await client.search(
        {
          gmailRaw: `from:${JOSEPH_SENDER} (subject:"PRODUCTION SCHEDULE" OR subject:"PROD SCHED") has:attachment`,
        },
        { uid: true }
      )) as number[] | false;

      if (!uids || uids.length === 0) return null;

      // Newest UID last; walk from newest until we find an xlsx attachment.
      const ordered = [...uids].sort((a, b) => b - a);
      for (const uid of ordered) {
        const msg = await client.fetchOne(
          String(uid),
          { source: true, envelope: true },
          { uid: true }
        );
        if (!msg || !msg.source) continue;
        const parsed = await simpleParser(msg.source as Buffer);
        const subject = parsed.subject ?? "";
        const att = (parsed.attachments ?? []).find(
          (a: { filename?: string; contentType?: string }) =>
            /\.xlsx$/i.test(a.filename ?? "") ||
            (a.contentType ?? "").includes("spreadsheetml")
        );
        if (!att) continue;

        const rev = parseJosephRev(subject);
        fs.mkdirSync(JOSEPH_DIR, { recursive: true });
        const safeRev = rev.n !== null ? `REV${rev.n}` : "REVX";
        const outPath = path.join(
          JOSEPH_DIR,
          `joseph_${safeRev}_fetched.xlsx`
        );
        fs.writeFileSync(outPath, att.content);
        console.log(
          `[joseph] IMAP fetched "${subject}" → ${outPath} (${att.content.length} bytes)`
        );
        return { buffer: att.content as Buffer, rev, origin: `IMAP "${subject}"` };
      }
      return null;
    } finally {
      usingLock.release();
    }
  } finally {
    await client.logout().catch(() => {});
  }
}

/** Load workers/sync/.env into process.env without clobbering existing keys. */
function loadWorkerEnv(): void {
  const envPath = path.resolve("workers/sync/.env");
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
    if (!m) continue;
    const key = m[1];
    let val = m[2];
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = val;
  }
}
