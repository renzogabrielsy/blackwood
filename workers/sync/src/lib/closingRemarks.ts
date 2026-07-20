/**
 * closingRemarks.ts — the ONE canonical "is this remark a batch-close signal?" source.
 *
 * A batch is CLOSED (feeding finished) when its rc_out remark / operator status is one
 * of a small, fixed set of closing phrases. That set was historically DUPLICATED in two
 * places that could silently drift:
 *   - `reports/rc_out/extract.ts` (PROPOSED DAILY REPORT) normalizes a closing status to
 *     the literal remark "CLOSED".
 *   - the DB trigger `fn_is_close_remark` (see the migration
 *     20260720xxxxxx_harden_batch_close_close_only.sql) decides the SAME thing server-side
 *     when an rc_out row is written.
 * And now a THIRD reader — the gsheet close-scan (`workflows/runSync.ts` →
 * `lib/gsheetCloseScan.ts`) — needs the identical test to close a batch from a Google
 * Sheet RC OUT "CLOSED" remark that the R4b cutover would otherwise structurally drop
 * (gsheet no longer writes rc_out, so its close remark never reaches the DB trigger).
 *
 * This module is the SINGLE SOURCE the TS side shares, kept EXACTLY in lockstep with the
 * SQL `fn_is_close_remark` (trim + upper, exact phrase membership). Change one, change the
 * other, or a batch that closes in the app won't close in the sheet-scan and vice-versa.
 *
 * Pure module: zero imports, zero I/O. Safe for any layer (worker, app, tests).
 */

/**
 * The canonical closing phrases (already trimmed + upper-cased). MUST equal the SQL
 * `fn_is_close_remark` ARRAY exactly. "FEEDING DONE" is included (the DB matched it via
 * regex before this was tightened); the PROPOSED extractor previously used only
 * {DONE, DONE FEEDING, CLOSED} — adding "FEEDING DONE" is a superset that no fixture
 * exercises, so parity is unaffected while the three readers can no longer diverge.
 */
export const CLOSING_PHRASES: ReadonlySet<string> = new Set([
  "CLOSED",
  "DONE",
  "DONE FEEDING",
  "FEEDING DONE",
]);

/**
 * True when `remarks` is one of the canonical closing phrases (after trim + upper).
 * Exact-phrase membership — deliberately NOT a substring/word-boundary match, so raw
 * operator prose like "NOT CLOSED YET" or "ALMOST DONE" never counts as a close. Mirrors
 * the tightened SQL `fn_is_close_remark(text)` byte-for-byte.
 */
export function isClosingRemark(remarks: string | null | undefined): boolean {
  if (remarks === null || remarks === undefined) return false;
  return CLOSING_PHRASES.has(remarks.trim().toUpperCase());
}
