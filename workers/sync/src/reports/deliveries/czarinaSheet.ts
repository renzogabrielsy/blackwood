/**
 * czarinaSheet.ts — resolve which tab of Czarina's "RAW CHARCOAL PURCHASES -Daily"
 * workbook holds a given calendar month.
 *
 * ============================================================================
 * WHY THIS FILE EXISTS (BUG: the sync priced ZERO August deliveries)
 * ============================================================================
 * The old code built the tab name as `${FULL_MONTHS[m-1]} ${y}` → "August 2026"
 * and handed it to `wb.getWorksheet(name)`, which is an EXACT string match. The
 * real tabs, read from the live workbook on 2026-08-07, are:
 *
 *   July.2024  Oct.24     Nov.24     Dec.24     JAN.2025   Feb.25    March25
 *   April 25   May 25     June 25    July 25    Aug. 25    Sept. 25
 *   Feb. 2026  Aug. 2026  July 2026  June 2026  May 2026   April 2026
 *   March 2026 Jan. 2026. Dec. 25.   "Nov 25. " Oct 25.
 *
 * March–July 2026 happen to be spelled the full way, which is why pricing worked
 * all spring. February and August are not ("Feb. 2026", "Aug. 2026"), so the
 * lookup returned undefined, `loadCzarinaRows` threw, and index.ts swallowed it.
 *
 * Twenty-four tabs written by hand over two years carry at least four conventions
 * (abbreviated/full month, with/without a period, 2-/4-digit year, with/without a
 * space, and one with a TRAILING period and one with TRAILING whitespace). Exact
 * string matching was never going to hold. So: normalize both sides to
 * (month, year) and compare THAT.
 *
 * AMBIGUITY IS REFUSED, NEVER GUESSED. If two tabs normalize to the same month and
 * year — e.g. someone adds a second "Aug 2026" working copy — this returns
 * `ambiguous` with both names rather than silently picking one. Picking the wrong
 * duplicate would price a whole month from a scratch tab, which is exactly the
 * class of silent-wrongness this module was written to end.
 *
 * Month-token knowledge is NOT redefined here: `monthNumberFromToken` in
 * lib/months.ts owns it (including the SEPT/SEP asymmetry).
 *
 * Pure module: no I/O, no DB. Takes a list of names, returns a decision.
 */
import { monthNumberFromToken } from "../../lib/months.js";

/** A tab name decoded to the month it holds. */
export interface CzarinaTab {
  /** The worksheet name EXACTLY as the workbook spells it (what to pass to wb.sheet). */
  name: string;
  month: number;
  year: number;
}

export type CzarinaTabResolution =
  | { ok: true; tab: CzarinaTab }
  /** No tab normalizes to this month+year. `looked_for` is the human description. */
  | { ok: false; reason: "not_found"; looked_for: string; available: string[] }
  /** Two or more tabs normalize to the same month+year — refuse, never pick. */
  | { ok: false; reason: "ambiguous"; looked_for: string; candidates: string[]; available: string[] };

/**
 * Decode one worksheet name into (month, year), or null when it is not a month tab.
 *
 * Normalization, in order:
 *   1. trim (kills the trailing space on "Nov 25. ")
 *   2. uppercase
 *   3. drop EVERY character that is not a letter or a digit — this is what kills
 *      the periods ("Aug." / "Jan. 2026." / "July.2024"), the spaces, and any
 *      stray punctuation, all at once.
 *   4. split the leading letter run from the trailing digit run.
 *
 * The year is 4 digits as-is, or 2 digits read as 20YY. Anything else (3 digits, 5
 * digits, no digits, no letters, digits before letters) is not a month tab and
 * returns null — so a "SUMMARY" or "Sheet1" tab is ignored rather than misread.
 */
export function parseCzarinaTabName(raw: string): CzarinaTab | null {
  const squashed = raw.trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
  const m = /^([A-Z]+)(\d{2}|\d{4})$/.exec(squashed);
  if (!m) return null;

  const month = monthNumberFromToken(m[1]);
  if (month === null) return null;

  const digits = m[2];
  const year = digits.length === 4 ? parseInt(digits, 10) : 2000 + parseInt(digits, 10);
  // A 4-digit year outside a sane spreadsheet range is a mis-parse, not a tab.
  if (year < 2000 || year > 2099) return null;

  return { name: raw, month, year };
}

/** Decode every worksheet name; non-month tabs are dropped. */
export function parseCzarinaTabs(sheetNames: readonly string[]): CzarinaTab[] {
  const out: CzarinaTab[] = [];
  for (const n of sheetNames) {
    const t = parseCzarinaTabName(n);
    if (t) out.push(t);
  }
  return out;
}

/** "August 2026 (month 8 of 2026)" — what the failure message quotes. */
function describe(year: number, month: number): string {
  const names = [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December",
  ];
  return `${names[month - 1] ?? `month ${month}`} ${year}`;
}

/**
 * Find the tab holding (year, month). Never guesses: 0 matches → `not_found`,
 * 2+ matches → `ambiguous`. Both failure shapes carry the FULL tab list so the
 * run finding can say what it looked for AND what it actually found.
 */
export function resolveCzarinaTab(
  sheetNames: readonly string[],
  year: number,
  month: number,
): CzarinaTabResolution {
  const lookedFor = describe(year, month);
  const available = [...sheetNames];
  const hits = parseCzarinaTabs(sheetNames).filter((t) => t.year === year && t.month === month);

  if (hits.length === 1) return { ok: true, tab: hits[0] };
  if (hits.length === 0) return { ok: false, reason: "not_found", looked_for: lookedFor, available };
  return {
    ok: false,
    reason: "ambiguous",
    looked_for: lookedFor,
    candidates: hits.map((t) => t.name),
    available,
  };
}

/** `{year, month}` for an ISO date string (the month a delivery's price lives in). */
export function monthOfISO(iso: string): { year: number; month: number } {
  return { year: parseInt(iso.slice(0, 4), 10), month: parseInt(iso.slice(5, 7), 10) };
}

/**
 * Every DISTINCT (year, month) the given delivery dates span, ascending.
 *
 * The old code loaded ONE tab — `czarinaMonthSheet(maxDate(windowRows))` — so a run
 * whose window crossed a month boundary left the earlier month's rows unpriced with
 * no complaint at all. That is not hypothetical: the sync window is
 * `watermark − 3 days`, so it straddles a month boundary on the 1st, 2nd and 3rd of
 * EVERY month, and two of the ten rows backfilled on 2026-08-07 were dated
 * 2026-08-01 while their prices sat on the "Aug. 2026" tab alongside 2026-08-05
 * rows. Load them all.
 */
export function monthsSpanned(dates: readonly string[]): Array<{ year: number; month: number }> {
  const seen = new Map<string, { year: number; month: number }>();
  for (const d of dates) {
    const iso = String(d).slice(0, 10);
    if (iso.length < 7) continue;
    const ym = monthOfISO(iso);
    if (!Number.isFinite(ym.year) || !Number.isFinite(ym.month)) continue;
    if (ym.month < 1 || ym.month > 12) continue;
    seen.set(`${ym.year}-${ym.month}`, ym);
  }
  return [...seen.values()].sort((a, b) => a.year - b.year || a.month - b.month);
}
