/**
 * Filename helpers for the Blend Proposal PDF — split OUT of `blend-proposal-pdf.ts`
 * (PERF-4) so importing them does NOT pull jsPDF + jspdf-autotable into the client
 * bundle.
 *
 * The dialog uses `composeBlendPdfFilename` SYNCHRONOUSLY on every render (the live
 * filename preview + the "label required" validity gate), so it must stay a cheap
 * static import. The heavy `buildBlendPdf`/`downloadBlendPdf` (which need jsPDF) are
 * loaded lazily via `await import('./blend-proposal-pdf')` at the moment the user
 * clicks Download. These helpers depend only on `date-fns`.
 *
 * `blend-proposal-pdf.ts` re-exports both for its own node/test path and back-compat.
 */

import { format } from 'date-fns';

/**
 * Reserved characters illegal/awkward in filenames across Windows/macOS/Linux:
 * `/ \ : * ? " < > |`. Spaces and dashes are intentionally KEPT (the user wants
 * `4x8 RUN` intact). Control characters are stripped separately by codepoint so this
 * regex carries no literal control bytes.
 */
const RESERVED_FILENAME_CHARS = /[/\\:*?"<>|]/g;

/**
 * Sanitize a user label for use in a filename. Strips the reserved characters
 * (`/ \ : * ? " < > |`) and any control characters (codepoint < 0x20), but KEEPS spaces
 * (`4x8 RUN` stays intact), collapses runs of whitespace, and trims. Returns `''` for an
 * all-illegal/blank label so callers can require a non-empty result.
 */
export function sanitizeLabel(label: string): string {
  return Array.from(label)
    .filter((ch) => ch.codePointAt(0)! >= 0x20) // drop control chars by codepoint
    .join('')
    .replace(RESERVED_FILENAME_CHARS, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Compose the blend-proposal PDF filename: `YYMMDD - {label}.pdf`, where YYMMDD is
 * `date` (defaults to NOW at call time — dynamic, never hardcoded) via date-fns. The
 * label is sanitized first. Returns `null` when the sanitized label is empty (the caller
 * should keep the Download button disabled until the label is non-empty).
 */
export function composeBlendPdfFilename(label: string, date: Date = new Date()): string | null {
  const safe = sanitizeLabel(label);
  if (!safe) return null;
  return `${format(date, 'yyMMdd')} - ${safe}.pdf`;
}
