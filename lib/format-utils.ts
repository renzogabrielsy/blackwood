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
