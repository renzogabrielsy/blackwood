// ═════════════════════════════════════════════════════════════════════════════════
// FORMATTING — one definition each, for the whole `/operations` screen.
//
// Excel Standard, verbatim: numerics are mono + right-aligned, and ₱ is an
// ACCOUNTING cell (symbol pinned left, number pinned right) — never `₱43.50` run
// together.
//
// THE ONE RULE THESE FUNCTIONS EXIST TO ENFORCE: **NULL IS NEVER 0** (the port's
// class note, and `app/(app)/operations/CONTEXT.md` → "the eight things to know",
// item 3). So `kg(null)` is BLANK and `kg(0)` prints `0` — a day that fed nothing
// reads null and stays blank, while a genuine recorded zero is a claim and prints.
// The drafts at `/dev/ops-ledger` collapsed the two (`if (!n) return ''`); the real
// payload distinguishes them, so this module must too.
//
// NOTHING HERE COMPUTES. Every figure was aggregated in SQL (CLAUDE.md → "Never
// calculate weighted averages or inventory balances in TypeScript"); these are
// renderers, and a `+` or a `/` in this file is a number that escaped the view.
// ═════════════════════════════════════════════════════════════════════════════════

/** Integer kg with separators. NULL renders blank; a recorded 0 prints `0`. */
export function kg(n: number | null | undefined): string {
  if (n === null || n === undefined) return '';
  return Math.round(n).toLocaleString('en-US');
}

/** Kg as TONNES, 1 dp — the unit the EOQ rollup is read in. NULL blank, 0 prints. */
export function tons(n: number | null | undefined): string {
  if (n === null || n === undefined) return '';
  return (n / 1000).toLocaleString('en-US', {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  });
}

/** A bare 2-dp figure for an accounting cell. NULL renders blank — never ₱0.00. */
export function php(n: number | null | undefined): string {
  if (n === null || n === undefined) return '';
  return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/**
 * A FRACTION (0.8292) → a percent. Null renders an em-dash, never 0%.
 *
 * `yieldPct`, `processLossPct`, `blockResikoLossPct`, `campaignFedKgIncludedPct`,
 * `lossPct`, `resikoPct` and `coveredFedKgShare` are fractions. See the PERCENT
 * twin below — the two conventions were deliberately NOT harmonised in SQL so this
 * screen can be compared with `/analytics` digit for digit, which means the UI is
 * the place the distinction has to be respected.
 */
export function pctFromFraction(fraction: number | null | undefined, dp = 1): string {
  if (fraction === null || fraction === undefined) return '—';
  return `${(fraction * 100).toFixed(dp)}%`;
}

/**
 * A FRACTION → the BARE percent number, with no `%` glyph on it.
 *
 * The twin of {@link pctFromFraction}, for a cell that states its unit somewhere
 * else — the EOQ strip pins every unit on the LEFT (`UnitValue`), so a trailing
 * `%` there would print the unit twice and move the last digit off the column.
 * NULL renders BLANK rather than an em-dash, because the caller decides what an
 * absent figure looks like (and drops the glyph with it).
 */
export function pctNumFromFraction(fraction: number | null | undefined, dp = 1): string {
  if (fraction === null || fraction === undefined) return '';
  return (fraction * 100).toFixed(dp);
}

/** An ALREADY-PERCENT (0–100): `sharePct`, `fedPriceCoveragePct`, `sacksCoveragePct`. */
export function pctFromPercent(pct: number | null | undefined, dp = 1): string {
  if (pct === null || pct === undefined) return '—';
  return `${pct.toFixed(dp)}%`;
}

/**
 * A LAB READING at a fixed precision — 2 dp for MC / ASH / GRIT / VM / FC, 3 dp
 * for BD ASTM / BD JIS (CLAUDE.md → "Lab results").
 *
 * NULL renders BLANK, never `0.00`: 53 of the 525 blocks a campaign has ever fed
 * carry no lab reading at all, and a printed zero would read as "0 % moisture"
 * rather than "not measured" — the L-008 placeholder mistake in a new costume.
 */
export function lab(n: number | null | undefined, dp: number): string {
  if (n === null || n === undefined) return '';
  return n.toFixed(dp);
}

/** Hours, 2 dp. A genuine 0.00 PRINTS — an hour count of zero is a claim, not a blank. */
export function hours(n: number | null | undefined): string {
  if (n === null || n === undefined) return '';
  return n.toFixed(2);
}

/**
 * A plain integer count, blank at zero.
 *
 * Unlike {@link kg} this DOES collapse 0 to blank, and on purpose: `shiftCount` /
 * `runCount` arrive as integers rather than nulls, so a rest day carries `0` in
 * them. Printing a column of zeros down every Sunday is exactly the noise the
 * "rest days are blank rows" rule exists to avoid.
 */
export function count(n: number | null | undefined): string {
  if (!n) return '';
  return String(n);
}

/** `2026-07-04` → `Jul 4`. Headings only — a data cell always shows `yyyy-MM-dd`. */
export function shortDate(iso: string | null | undefined): string {
  if (!iso || iso.length < 10) return '';
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${months[Number(iso.slice(5, 7)) - 1]} ${Number(iso.slice(8, 10))}`;
}
