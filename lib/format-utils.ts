/**
 * Formatting utilities for numbers, currency, weights, and lab values
 */

/**
 * Formats a number with compact suffix notation (k, m, b, t)
 * @param value - The number to format
 * @param decimals - Number of decimal places (default: 2)
 * @returns Formatted string with suffix (e.g., "1.5k", "2.3m")
 */
export function formatCompact(value: number, decimals: number = 2): string {
    const abs = Math.abs(value);
    if (abs >= 1e12) return (value / 1e12).toFixed(decimals) + 't';
    if (abs >= 1e9) return (value / 1e9).toFixed(decimals) + 'b';
    if (abs >= 1e6) return (value / 1e6).toFixed(decimals) + 'm';
    if (abs >= 1e3) return (value / 1e3).toFixed(decimals) + 'k';
    return value.toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

/**
 * Formats a number as Philippine peso accounting format with ₱ symbol
 * Uses flex layout with symbol pinned left and number pinned right
 * @param value - The currency value to format
 * @returns Formatted currency string
 */
export function formatCurrency(value: number): string {
    return `₱${value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/**
 * Formats a weight value in kilograms with locale string formatting
 * @param value - The weight in kg
 * @returns Formatted weight string with no decimals
 */
export function formatWeight(value: number): string {
    return value.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
}

/**
 * Formats lab result values with specified decimal precision
 * Returns empty string for null values
 * @param value - The lab value (or null)
 * @param decimals - Number of decimal places (default: 2)
 * @returns Formatted value string or empty string
 */
export function formatLabValue(value: number | null, decimals: number = 2): string {
    if (value === null || value === undefined) return '';
    return value.toFixed(decimals);
}

// ─── Canonical "always show" display formatters ──────────────────────────────
// These are the versions the digest UI uses and re-exports. They ROUND (half-up
// via Math.round) then group with en-US separators, and ALWAYS render zero as
// "0" — distinct from:
//   • formatWeight() above — no Math.round, uses toLocaleString rounding
//     (half-to-even), so e.g. 2.5 → "2" here vs "3" via fmtKg. Kept separate on
//     purpose.
//   • the blank-on-zero fmtKg locals in rc-movement-matrix.tsx and
//     cenapro/inventory/flec-inventory-client.tsx, which return '' for 0/empty so
//     dense grids show blank cells — a deliberately different presentation. NOT
//     unified.
//   • blend-proposal-pdf.ts's local fmtKg, which omits the 'en-US' locale for
//     PDF locale-safety — left as-is to avoid changing generated PDF output.

/** Thousands-separated integer kg, e.g. 12,480. Rounds; shows "0" for zero. */
export function fmtKg(value: number): string {
    return Math.round(value).toLocaleString('en-US');
}

/** ₱ accounting figure, 2 dp — NUMBER PART ONLY (no ₱ glyph). Contrast
 *  formatCurrency() above, which prefixes ₱. */
export function fmtPhpNumber(value: number): string {
    return value.toLocaleString('en-US', {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
    });
}
