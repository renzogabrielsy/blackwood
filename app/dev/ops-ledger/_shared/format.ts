// ═════════════════════════════════════════════════════════════════════════════════
// Formatting — ONE definition each, shared by all three drafts.
//
// It lives here rather than in each layout for the reason every duplicated formatter
// eventually proves: three copies of "how a kilogram is printed" drift, and then the same
// day reads 34,120 on one draft and 34,120.00 on another, and the comparison the three
// drafts exist for is comparing the formatters instead of the layouts.
//
// Excel Standard, verbatim: figures are mono + right-aligned, a zero renders BLANK (a
// spreadsheet does not print 0 in an empty cell), and ₱ is an ACCOUNTING cell — symbol
// pinned left, number pinned right — never `₱43.50` run together.
// ═════════════════════════════════════════════════════════════════════════════════

/** Integer kg with separators. 0 / null / undefined render BLANK. */
export function kg(n: number | null | undefined): string {
    if (!n) return '';
    return Math.round(n).toLocaleString('en-US');
}

/** Kg as TONNES, 1 dp — the unit the EOQ rollup is read in. Blank at zero. */
export function tons(n: number | null | undefined): string {
    if (!n) return '';
    return (n / 1000).toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
}

/** A bare 2-dp figure for an accounting cell. NULL renders blank — never ₱0.00. */
export function php(n: number | null | undefined): string {
    if (n === null || n === undefined) return '';
    return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** Millions of pesos, 2 dp — a campaign's buying total is 8 digits and unreadable raw. */
export function phpM(n: number | null | undefined): string {
    if (!n) return '';
    return (n / 1_000_000).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** A FRACTION → a 1-dp percent. Null renders an em-dash, never 0%. */
export function pctFromFraction(fraction: number | null | undefined, dp = 1): string {
    if (fraction === null || fraction === undefined) return '—';
    return `${(fraction * 100).toFixed(dp)}%`;
}

/** Hours, 2 dp. A genuine 0.00 PRINTS — an hour count of zero is a claim, not a blank. */
export function hours(n: number | null | undefined): string {
    if (n === null || n === undefined) return '';
    return n.toFixed(2);
}

/** A plain integer. Blank at zero. */
export function count(n: number | null | undefined): string {
    if (!n) return '';
    return String(n);
}

/** `2026-07-04` → `Jul 4`. For a heading, never for a data cell. */
export function shortDate(iso: string): string {
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    return `${months[Number(iso.slice(5, 7)) - 1]} ${Number(iso.slice(8, 10))}`;
}
