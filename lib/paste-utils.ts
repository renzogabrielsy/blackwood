/**
 * Shared paste utilities for Excel-like grid input
 * Used by RC IN and RC OUT bulk input modules
 */

function formatYMD(d: Date): string {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * Converts Excel serial numbers, common date formats, or ISO strings to yyyy-MM-dd
 * @param raw - The raw date string from clipboard
 * @returns Formatted date string in yyyy-MM-dd format
 */
export function parseExcelDate(raw: string): string {
    const trimmed = raw.trim();

    // Already yyyy-MM-dd
    if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return trimmed;

    // Excel serial number (pure integer, realistic range ~1900–2100)
    const num = Number(trimmed);
    if (!isNaN(num) && Number.isInteger(num) && num >= 1 && num < 2958466) {
        // Excel's epoch is Jan 1 1900, but it has a fake Feb 29 1900 (serial 60)
        const adjusted = num > 59 ? num - 1 : num;
        const d = new Date(1900, 0, adjusted);
        return formatYMD(d);
    }

    // MM/DD/YYYY or M/D/YY (slash or dash separated, assumes US locale)
    const parts = trimmed.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})$/);
    if (parts) {
        const [, a, b, yr] = parts;
        let y = parseInt(yr);
        if (y < 100) y += 2000;
        const m = parseInt(a), d = parseInt(b);
        if (m >= 1 && m <= 12 && d >= 1 && d <= 31) {
            return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
        }
    }

    // Last resort: let the browser try
    const parsed = new Date(trimmed);
    if (!isNaN(parsed.getTime())) return formatYMD(parsed);

    return trimmed;
}

/**
 * Normalizes a TYPED shorthand date into the canonical yyyy-MM-dd format, the way Excel
 * auto-transcribes a cell when you tab/enter out of it. Unlike `parseExcelDate` (paste
 * path), this also handles a bare 2-part "M/D" with NO year by injecting `defaultYear`.
 *
 * Accepted inputs (US month-first), all → yyyy-MM-dd:
 *   "6/2", "06-02", "6.2"   (2-part M/D)        → defaultYear-06-02
 *   "6/2/26"                (2-digit year)      → 2026-06-02
 *   "6/2/2026"              (4-digit year)      → 2026-06-02
 *   "2026-06-02", "2026/6/2" (already ISO-ish)  → 2026-06-02
 *   Excel serial / browser-parseable           → delegated to parseExcelDate
 *
 * Separators accepted between parts: "/", "-", ".".
 * INVALID input (bad month/day, "13/40", "abc") → returns the ORIGINAL input UNCHANGED
 * so the operator can see and fix it (never wipes their text). Empty → "".
 *
 * @param input - The raw typed cell text
 * @param defaultYear - Year to inject when the input omits one (current cycle year)
 * @returns yyyy-MM-dd, or the original input if it isn't a real date
 */
export function normalizeTypedDate(input: string, defaultYear: number): string {
    const trimmed = input.trim();
    if (!trimmed) return ''; // empty stays empty — don't fabricate a date

    // Validates (year, month, day) form a real calendar date, then formats yyyy-MM-dd.
    // Rejects e.g. month 13 or Feb 30 via Date round-trip — returns null if not real.
    const toIso = (y: number, m: number, d: number): string | null => {
        if (m < 1 || m > 12 || d < 1 || d > 31) return null;
        const dt = new Date(y, m - 1, d);
        if (dt.getFullYear() !== y || dt.getMonth() !== m - 1 || dt.getDate() !== d) return null;
        return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    };

    // Bare 2-part "M/D" (no year) — the case parseExcelDate's 3-part regex can't handle.
    // Inject defaultYear. Separators: / - .
    const twoPart = trimmed.match(/^(\d{1,2})[\/\-.](\d{1,2})$/);
    if (twoPart) {
        const m = parseInt(twoPart[1], 10);
        const d = parseInt(twoPart[2], 10);
        const iso = toIso(defaultYear, m, d);
        return iso ?? input;
    }

    // 3-part "M/D/YY" or "M/D/YYYY" (or dot-separated) — validate ourselves so an
    // out-of-range value (e.g. "13/40/2026") returns the original instead of garbage.
    const threePart = trimmed.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})$/);
    if (threePart) {
        const m = parseInt(threePart[1], 10);
        const d = parseInt(threePart[2], 10);
        let y = parseInt(threePart[3], 10);
        if (y < 100) y += 2000;
        const iso = toIso(y, m, d);
        return iso ?? input;
    }

    // ISO-ish "yyyy-MM-dd" or "yyyy/M/D" or "yyyy.M.D" — normalize/passthrough.
    const isoLike = trimmed.match(/^(\d{4})[\/\-.](\d{1,2})[\/\-.](\d{1,2})$/);
    if (isoLike) {
        const y = parseInt(isoLike[1], 10);
        const m = parseInt(isoLike[2], 10);
        const d = parseInt(isoLike[3], 10);
        const iso = toIso(y, m, d);
        return iso ?? input;
    }

    // Everything else (Excel serial, full date strings) — delegate to parseExcelDate,
    // which already handles serials, M/D/Y, and browser-parseable strings. If it can't
    // convert (returns the input verbatim), keep the original untouched.
    const delegated = parseExcelDate(trimmed);
    if (/^\d{4}-\d{2}-\d{2}$/.test(delegated)) return delegated;
    return input;
}

/**
 * Strips common numeric formatting characters from a string
 * Removes: currency symbols (₱), commas, quotes
 * @param raw - The raw numeric string
 * @returns Cleaned numeric string
 */
export function stripNumericFormatting(raw: string): string {
    return raw.replace(/[₱,"']/g, '');
}

/**
 * Trims and removes leading/trailing quotes from a cell value
 * @param raw - The raw cell value
 * @returns Cleaned cell value
 */
export function trimCellValue(raw: string): string {
    return raw.trim().replace(/^"|"$/g, '');
}
