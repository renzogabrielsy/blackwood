// ─── RC Deliveries — URL axis helpers (pure, no React, no 'use client') ─────────
//
// Same discipline as `production/ledger-url.ts`: the axes are parsed and written by ONE
// module with no client directive, so the server page (`page.tsx`) and the client
// toolbar can share the contract without a client/server boundary hazard.
//
//   1. SCOPE  (`?scope=endless|focus`) — HOW MUCH history is in view. `endless` is the
//      default and OMITS the param (clean URLs).
//   2. PERIOD (`?year=&month=`) — WHICH month, in the focus scope only. Ignored (but
//      preserved) in endless, so toggling back returns you where you were.
//   3. FILTER (`?q=` search, `?issue=`) — WHICH rows. Deliberately small: this ledger's
//      job is to show every receipt, and the data-quality lens is the one cut that
//      earns a URL param (a link to "the 22 suspected duplicates" is worth sharing).
//
// Every SCOPE × PERIOD × FILTER combination is valid.

export const SCOPES = ['endless', 'focus'] as const;
export type Scope = (typeof SCOPES)[number];

export function parseScope(raw: string | string[] | null | undefined): Scope {
    return one(raw) === 'focus' ? 'focus' : 'endless';
}

/** A repeated param arrives as an array from the server searchParams — take the first. */
export function one(v: string | string[] | null | undefined): string | undefined {
    if (v === null || v === undefined) return undefined;
    return Array.isArray(v) ? v[0] : v;
}

// ─── Period axis (focus scope) ──────────────────────────────────────────────────

export interface DeliveryPeriod {
    year: number;
    /** 1–12. */
    month: number;
}

export function periodKey(p: DeliveryPeriod): string {
    return `${p.year}-${String(p.month).padStart(2, '0')}`;
}

export function parsePeriodKey(key: string): DeliveryPeriod | null {
    const m = /^(\d{4})-(\d{2})$/.exec(key.trim());
    if (!m) return null;
    const year = Number(m[1]);
    const month = Number(m[2]);
    if (month < 1 || month > 12) return null;
    return { year, month };
}

/**
 * Resolve the focus period from the URL, falling back to the NEWEST period that has
 * data. A malformed or out-of-range pair falls through to the default rather than
 * stranding the operator on an empty month they can't navigate out of.
 */
export function resolvePeriod(
    available: readonly string[],
    rawYear: string | string[] | null | undefined,
    rawMonth: string | string[] | null | undefined,
): DeliveryPeriod | null {
    const y = Number.parseInt(one(rawYear) ?? '', 10);
    const m = Number.parseInt(one(rawMonth) ?? '', 10);
    if (Number.isInteger(y) && Number.isInteger(m) && m >= 1 && m <= 12) {
        const key = periodKey({ year: y, month: m });
        if (available.includes(key)) return { year: y, month: m };
    }
    const newest = available.length > 0 ? available[available.length - 1] : null;
    return newest ? parsePeriodKey(newest) : null;
}

/** First / last calendar day of a period, as `yyyy-MM-dd`. Pure date math, no date-fns. */
export function periodBounds(p: DeliveryPeriod): { from: string; to: string } {
    const last = new Date(Date.UTC(p.year, p.month, 0)).getUTCDate();
    const mm = String(p.month).padStart(2, '0');
    return { from: `${p.year}-${mm}-01`, to: `${p.year}-${mm}-${String(last).padStart(2, '0')}` };
}

const MONTH_NAMES = [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December',
];

export function periodLabel(p: DeliveryPeriod): string {
    return `${MONTH_NAMES[p.month - 1]} ${p.year}`;
}

// ─── Issue lens (`?issue=`) ─────────────────────────────────────────────────────
//
// The import deliberately kept bad rows visible instead of fixing them, so the lens
// that isolates them is a first-class control, not a debugging aid. An empty selection
// means "show everything" and omits the param — there is no "show nothing" state.

export const ISSUE_LENSES = ['duplicate', 'unmapped', 'flagged', 'undated'] as const;
export type IssueLens = (typeof ISSUE_LENSES)[number];

export const ISSUE_LABELS: Record<IssueLens, string> = {
    duplicate: 'Suspected duplicates',
    unmapped: 'Needs mapping',
    flagged: 'Import flags',
    undated: 'Unparseable date',
};

export const ISSUE_HINTS: Record<IssueLens, string> = {
    duplicate: 'Rows the importer believes were pasted twice — they inflate every total on the page',
    unmapped: 'Supplier or warehouse text that never resolved to a known code',
    flagged: 'Rows carrying at least one import complaint',
    undated: 'Rows whose date could not be parsed; the operator’s literal text is preserved',
};

export function parseIssueLens(raw: string | string[] | null | undefined): IssueLens | null {
    const v = one(raw);
    return v && (ISSUE_LENSES as readonly string[]).includes(v) ? (v as IssueLens) : null;
}

// ─── Free-text search (`?q=`) ───────────────────────────────────────────────────

/** Defensive cap — a hand-crafted URL can't blow up the query string. */
const MAX_QUERY = 80;

export function parseQuery(raw: string | string[] | null | undefined): string {
    return (one(raw) ?? '').trim().slice(0, MAX_QUERY);
}

// ─── Derived ────────────────────────────────────────────────────────────────────

export interface DeliveryLedgerAxes {
    scope: Scope;
    period: DeliveryPeriod | null;
    issue: IssueLens | null;
    query: string;
}

/** Stable fingerprint — used as a React key so a lens change remounts the pager cleanly. */
export function axesKey(axes: DeliveryLedgerAxes): string {
    return [
        axes.scope,
        axes.period ? periodKey(axes.period) : 'none',
        axes.issue ?? 'all',
        axes.query,
    ].join('|');
}

export function hasActiveLens(axes: Pick<DeliveryLedgerAxes, 'issue' | 'query'>): boolean {
    return axes.issue !== null || axes.query.length > 0;
}
