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
 * NOTE — the `production_batch` campaign name is NOT the batch_code month prefix.
 * The two are different identifiers with different histories and must never be
 * unified: a campaign is `SEPTEMBER` (full name, above), a batch is `SEPT-26-BLK12`
 * (the house batch-code prefix, `BATCH_CODE_MONTH_PREFIX` / `shortMonthPrefix()`
 * below). Both tables live in this one file so neither can grow a second copy.
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

// ─────────────────────────────────────────────────────────────────────────────
// THE HOUSE BATCH-CODE MONTH PREFIX (2026-09-25, Renzo — L-053)
// ─────────────────────────────────────────────────────────────────────────────
//
// The ONE table every code the worker INVENTS takes its month prefix from. A code a
// human typed is never rewritten through it — this governs only what the sync derives
// (the deliveries extractor's `FEEDING # N` / `PILED IN <MONTH> # N` / `B<N>` rules and
// the PROPOSED report's BLOCK DATE derivation).
//
// Values = the spelling ALREADY IN USE for that month in `batches` (measured
// 2026-09-25 over every `<MONTH>-<YY>-` code): JAN 60 (no JANUARY), FEB 70 (no
// FEBRUARY), MARCH (65; every 2025+ code — MAR survives only on 2021–2024 codes),
// APRIL (40; every 2025+ code — APR only on 2022–2024), MAY, JUNE (no JUN), JULY (no
// JUL), AUG 62 vs AUGUST 15 (the 15 are all 2026 codes the sync itself invented),
// SEPT 54 vs SEPTEMBER 3 (all three sync-invented, renamed the same day), OCT, NOV, DEC.
// It is byte-identical to the PROPOSED report's long-standing PRIMARY prefix, so the two
// derivers now read one table instead of disagreeing — which is exactly how
// `SEPTEMBER-26-BLK12` came to sit beside `SEPT-26-BLK2` … `SEPT-26-BLK11`.

/** Batch-code month prefix, index 0 = January (use `shortMonthPrefix()` for 1-indexed). */
export const BATCH_CODE_MONTH_PREFIX: readonly string[] = [
  "JAN", "FEB", "MARCH", "APRIL", "MAY", "JUNE",
  "JULY", "AUG", "SEPT", "OCT", "NOV", "DEC",
];

/**
 * The house batch-code month prefix for a 1-indexed calendar month (1 = January),
 * e.g. `shortMonthPrefix(9)` → `"SEPT"`. Throws on an out-of-range month — callers
 * always pass a decoded calendar date.
 */
export function shortMonthPrefix(month: number): string {
  const p = BATCH_CODE_MONTH_PREFIX[month - 1];
  if (!p) throw new RangeError(`shortMonthPrefix: month out of range: ${month}`);
  return p;
}
