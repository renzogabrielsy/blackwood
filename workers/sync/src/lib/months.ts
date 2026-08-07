/**
 * months.ts — the ONE canonical month-name source for `production_batch`.
 *
 * BUG-005 (2026-07-17): `rc_out.production_batch` accumulated BOTH `JUL` and
 * `JULY` (and a stray `APR` vs `APRIL`) because the two writers of that column
 * spelled the same month differently:
 *   - `reports/rc_out/extract.ts` derived a 3-letter `%b` abbreviation (a ported
 *     quirk of `extract_proposed_daily.py`), overriding only May/June to the full
 *     word.
 *   - `reports/gsheet/extract.ts` read the Sheet cell literally — historically the
 *     full month name.
 * Campaign keys are built from the raw string (`encodeCampaign()`), so `JUL-2026`
 * and `JULY-2026` split into two phantom campaigns.
 *
 * The canonical convention is the **full uppercase month name** (what the Sheet —
 * and therefore the vast majority of live rows — already uses). Every writer of
 * `production_batch` derives it from here, so the two conventions structurally
 * cannot diverge again.
 *
 * NOTE — this is NOT the batch_code month prefix. `batch_code` has its own,
 * deliberately mixed convention (JAN/MARCH/APRIL/SEPT + the SEPT/SEP asymmetry)
 * defined per-extractor (`PRIMARY_MONTH_PREFIX`, `MONTH_PREFIX_ALIASES`). Do not
 * unify the two — they are different identifiers with different histories.
 *
 * Pure module: zero imports, zero I/O. Safe for any layer.
 */

/** Full uppercase month names, index 0 = January (use `monthName()` for 1-indexed). */
export const MONTH_NAMES: readonly string[] = [
  "JANUARY", "FEBRUARY", "MARCH", "APRIL", "MAY", "JUNE",
  "JULY", "AUGUST", "SEPTEMBER", "OCTOBER", "NOVEMBER", "DECEMBER",
];

/** Recognized spellings (abbreviation or full) → canonical full name. */
const MONTH_TOKEN_TO_NAME: Record<string, string> = {
  JAN: "JANUARY", JANUARY: "JANUARY",
  FEB: "FEBRUARY", FEBRUARY: "FEBRUARY",
  MAR: "MARCH", MARCH: "MARCH",
  APR: "APRIL", APRIL: "APRIL",
  MAY: "MAY",
  JUN: "JUNE", JUNE: "JUNE",
  JUL: "JULY", JULY: "JULY",
  AUG: "AUGUST", AUGUST: "AUGUST",
  SEP: "SEPTEMBER", SEPT: "SEPTEMBER", SEPTEMBER: "SEPTEMBER",
  OCT: "OCTOBER", OCTOBER: "OCTOBER",
  NOV: "NOVEMBER", NOVEMBER: "NOVEMBER",
  DEC: "DECEMBER", DECEMBER: "DECEMBER",
};

/**
 * Canonical `production_batch` value for a 1-indexed calendar month (1 = January).
 * Throws on an out-of-range month — callers always pass a decoded calendar date.
 */
export function monthName(month: number): string {
  const name = MONTH_NAMES[month - 1];
  if (!name) throw new RangeError(`monthName: month out of range: ${month}`);
  return name;
}

/**
 * Canonicalize a month name READ from a source (e.g. the Sheet's production_batch
 * cell) to the full uppercase name. A recognized abbreviation (`Jul`, `SEPT`) maps
 * to its full name; anything unrecognized is returned **unchanged**, so this can
 * never silently rewrite a value the extractor was asked to capture literally.
 */
export function canonicalMonthName<T extends string | null | undefined>(raw: T): T | string {
  if (raw === null || raw === undefined) return raw;
  return MONTH_TOKEN_TO_NAME[raw.trim().toUpperCase()] ?? raw;
}

/**
 * 1-indexed calendar month for a recognized month TOKEN (abbreviation or full name),
 * or `null` if the token is not a month at all.
 *
 * This is the inverse of `monthName()` and reads the SAME `MONTH_TOKEN_TO_NAME` table
 * `canonicalMonthName()` uses — so the SEPT/SEP asymmetry (and every other spelling
 * this project has met) is handled in exactly one place. Added 2026-08-07 for the
 * Czarina price-file tab resolver, which has to recognize a month written four
 * different ways across 24 worksheet tabs; do NOT give it a private month table.
 *
 * Case- and whitespace-insensitive. Punctuation is NOT stripped here (a caller that
 * needs "Aug." → AUG normalizes first) so this stays a pure token lookup.
 */
export function monthNumberFromToken(token: string | null | undefined): number | null {
  if (token === null || token === undefined) return null;
  const name = MONTH_TOKEN_TO_NAME[token.trim().toUpperCase()];
  if (!name) return null;
  const idx = MONTH_NAMES.indexOf(name);
  return idx < 0 ? null : idx + 1;
}
