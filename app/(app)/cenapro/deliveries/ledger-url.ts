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
//   3. LENS   (`?q=` search, `?issue=`) — WHICH rows, coarsely: a free-text sweep and
//      the data-quality cut (a link to "the 22 duplicate pairs" is worth sharing).
//   4. COLUMN FILTERS (`?f_<column>=…`) — WHICH rows, precisely, one column at a time.
//
// Every SCOPE × PERIOD × LENS × FILTER combination is valid.
//
// ── Why the filters live in the URL and not in React state ───────────────────────
// The endless scope is a bidirectional keyset pager: it holds a WINDOW of history, not
// the 991 rows. A filter applied to the loaded window would filter what happens to be
// in memory and quietly lie about the rest, so every filter is pushed into the SQL
// query — and a query the server runs has to be reachable from the URL, or the server
// cannot prefetch the first window and the link cannot be shared.
//
// ── The grammar ─────────────────────────────────────────────────────────────────
//
//     ?f_supplier=BRIX,PALAWAN        set     — comma-separated dimension codes
//     ?f_whse=WHSE%20A,W6%20PROD      set
//     ?f_truck=ABC                    text    — case-insensitive contains
//     ?f_remarks=czarina              text
//     ?f_date=2026-04-01..2026-04-30  dateRange — either side may be empty (`..2026-04-30`)
//     ?f_moist=8..12                  range     — numeric, either side may be empty
//
// The param name is `f_` + the COLUMN KEY, so the column table in `types.ts` is the
// only place that says what may be filtered and how. A param naming a column that has
// no `filterKind` — `?f_php_kg=30..40`, `?f_wt=0..1` — resolves to nothing and is
// dropped, which is what keeps a filter from becoming a price oracle.

import { FILTER_COLUMNS, isIsoDate, type DeliveryCol } from './types';

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
    duplicate: 'Duplicate pairs',
    unmapped: 'Needs mapping',
    flagged: 'Import flags',
    undated: 'Unparseable date',
};

export const ISSUE_HINTS: Record<IssueLens, string> = {
    // BOTH members of every pair, not just the flagged copy. A lens that showed the 22
    // accusations without the 22 originals could not answer the only question worth
    // asking here — "is it really an exact copy of that row?" — which is the whole
    // point of the keep-or-drop decision.
    duplicate: 'Every receipt that has an exact twin — the flagged paste AND the original it was pasted from, side by side',
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

// ═══ Per-column filters (`?f_<column>=…`) ═══════════════════════════════════════

/** The URL param that carries a column's filter. */
export function filterParamName(colKey: string): string {
    return `f_${colKey}`;
}

export type ColumnFilter =
    | { kind: 'set'; values: string[] }
    | { kind: 'text'; text: string }
    | { kind: 'range'; min: number | null; max: number | null }
    | { kind: 'dateRange'; from: string | null; to: string | null };

/** Column key → its filter. A column absent from the map is unfiltered. */
export type ColumnFilters = Readonly<Record<string, ColumnFilter>>;

export const NO_FILTERS: ColumnFilters = Object.freeze({});

/** Defensive caps — a hand-crafted URL cannot blow up the query string. */
const MAX_SET_VALUES = 64;
const MAX_FILTER_TEXT = 60;

/**
 * Strip everything PostgREST reads as syntax before the text reaches an `ilike`
 * pattern: `*` and `%` are its wildcards, and `,` `(` `)` are its filter separators.
 * The search box next door does the same for the same reason.
 */
function safeFilterText(raw: string): string {
    return raw.replace(/[,()*%\\]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_FILTER_TEXT);
}

/** `a..b`, either side optionally empty. Anything else is not a range. */
function splitRange(raw: string): [string, string] | null {
    const i = raw.indexOf('..');
    if (i < 0) return null;
    return [raw.slice(0, i).trim(), raw.slice(i + 2).trim()];
}

function finiteOrNull(raw: string): number | null {
    if (!raw) return null;
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
}

/**
 * Parse ONE column's raw param against its own spec, or `null` when it says nothing.
 *
 * An inverted range is SWAPPED rather than honoured. `12..8` as typed matches nothing,
 * which reads to the operator as "the filter is broken"; the only thing they can have
 * meant is 8–12.
 */
export function parseColumnFilterValue(col: DeliveryCol, raw: string): ColumnFilter | null {
    const text = raw.trim();
    if (!text) return null;

    switch (col.filterKind) {
        case 'set': {
            const seen = new Set<string>();
            for (const part of text.split(',')) {
                const v = part.trim();
                if (v && !seen.has(v)) seen.add(v);
                if (seen.size >= MAX_SET_VALUES) break;
            }
            return seen.size > 0 ? { kind: 'set', values: [...seen] } : null;
        }
        case 'text': {
            const safe = safeFilterText(text);
            return safe ? { kind: 'text', text: safe } : null;
        }
        case 'range': {
            const parts = splitRange(text);
            if (!parts) return null;
            let min = finiteOrNull(parts[0]);
            let max = finiteOrNull(parts[1]);
            if (min === null && max === null) return null;
            if (min !== null && max !== null && min > max) [min, max] = [max, min];
            return { kind: 'range', min, max };
        }
        case 'dateRange': {
            const parts = splitRange(text);
            if (!parts) return null;
            let from = isIsoDate(parts[0]) ? parts[0] : null;
            let to = isIsoDate(parts[1]) ? parts[1] : null;
            if (from === null && to === null) return null;
            if (from !== null && to !== null && from > to) [from, to] = [to, from];
            return { kind: 'dateRange', from, to };
        }
        default:
            return null;
    }
}

/** Read every `f_<column>` param the column table recognises. Unknown names are dropped. */
export function parseColumnFilters(
    params: Record<string, string | string[] | undefined>,
): ColumnFilters {
    const out: Record<string, ColumnFilter> = {};
    for (const col of FILTER_COLUMNS) {
        const raw = one(params[filterParamName(col.key)]);
        if (raw === undefined) continue;
        const parsed = parseColumnFilterValue(col, raw);
        if (parsed) out[col.key] = parsed;
    }
    return out;
}

/** The param VALUE for a filter, or `null` when the param should be deleted. */
export function serializeColumnFilter(filter: ColumnFilter | null): string | null {
    if (!filter) return null;
    switch (filter.kind) {
        case 'set':
            return filter.values.length > 0 ? filter.values.join(',') : null;
        case 'text':
            return filter.text.trim() || null;
        case 'range': {
            if (filter.min === null && filter.max === null) return null;
            return `${filter.min ?? ''}..${filter.max ?? ''}`;
        }
        case 'dateRange': {
            if (filter.from === null && filter.to === null) return null;
            return `${filter.from ?? ''}..${filter.to ?? ''}`;
        }
    }
}

/** Apply one column's filter to the map, dropping the key when it says nothing. */
export function withColumnFilter(
    filters: ColumnFilters,
    colKey: string,
    next: ColumnFilter | null,
): ColumnFilters {
    const out: Record<string, ColumnFilter> = { ...filters };
    if (!next || serializeColumnFilter(next) === null) delete out[colKey];
    else out[colKey] = next;
    return out;
}

export function activeFilterCount(filters: ColumnFilters): number {
    return Object.keys(filters).length;
}

/** Column keys with a filter, in the sheet's own left-to-right order. */
export function filteredColumnKeys(filters: ColumnFilters): string[] {
    return FILTER_COLUMNS.filter((c) => filters[c.key] !== undefined).map((c) => c.key);
}

/** A human sentence for the chip row. */
export function describeFilter(col: DeliveryCol, filter: ColumnFilter): string {
    switch (filter.kind) {
        case 'set':
            return `${col.label}: ${filter.values.join(', ')}`;
        case 'text':
            return `${col.label} contains “${filter.text}”`;
        case 'range':
            if (filter.min !== null && filter.max !== null) return `${col.label} ${filter.min}–${filter.max}`;
            return filter.min !== null ? `${col.label} ≥ ${filter.min}` : `${col.label} ≤ ${filter.max}`;
        case 'dateRange':
            if (filter.from !== null && filter.to !== null) return `${col.label} ${filter.from} → ${filter.to}`;
            return filter.from !== null ? `${col.label} from ${filter.from}` : `${col.label} until ${filter.to}`;
    }
}

// ─── URL → SQL ──────────────────────────────────────────────────────────────────
//
// The ONE translation from a parsed filter to a PostgREST predicate. It is a pure
// DESCRIPTION rather than a builder call so this module stays free of Supabase and the
// verify script can assert the whole grammar without a database.
//
// Every predicate is a plain conjunct ANDed onto the same query with the SAME ORDER BY
// `(delivery_date, id)` — which is precisely why keyset paging survives a filter: the
// order is untouched and the walk just steps over a sparser set.

export type FilterPredicate =
    | { op: 'in'; column: string; values: string[] }
    | { op: 'ilike'; column: string; pattern: string }
    | { op: 'gte'; column: string; value: string | number }
    | { op: 'lte'; column: string; value: string | number };

/**
 * Turn the filter map into predicates, in the sheet's column order (stable, so a
 * request is byte-identical for the same filters and a test can compare a list).
 *
 * A filter whose `kind` disagrees with its column's `filterKind` is DROPPED rather
 * than coerced — the only way to produce one is to hand-build the object, and a
 * mismatched filter is a bug, not an intention.
 */
export function buildFilterPredicates(filters: ColumnFilters): FilterPredicate[] {
    const out: FilterPredicate[] = [];
    for (const col of FILTER_COLUMNS) {
        const filter = filters[col.key];
        const column = col.filterColumn;
        if (!filter || !column || filter.kind !== col.filterKind) continue;

        switch (filter.kind) {
            case 'set':
                if (filter.values.length > 0) out.push({ op: 'in', column, values: filter.values });
                break;
            case 'text':
                if (filter.text) out.push({ op: 'ilike', column, pattern: `*${filter.text}*` });
                break;
            case 'range':
                if (filter.min !== null) out.push({ op: 'gte', column, value: filter.min });
                if (filter.max !== null) out.push({ op: 'lte', column, value: filter.max });
                break;
            case 'dateRange':
                // NOTE: a `gte`/`lte` on `delivery_date` never matches a NULL date, and
                // that is the correct answer — an undated receipt is not inside any date
                // range. It is worth stating because the same asymmetry is a TRAP in the
                // keyset predicate next door, where the NULL group has to be named
                // explicitly or the two undated receipts become unreachable.
                if (filter.from !== null) out.push({ op: 'gte', column, value: filter.from });
                if (filter.to !== null) out.push({ op: 'lte', column, value: filter.to });
                break;
        }
    }
    return out;
}

/**
 * Does the DATE filter exclude the whole focused month? The two ranges AND together in
 * SQL, so a non-overlapping pair is a legal query that returns nothing — and an empty
 * sheet with no explanation reads as a bug. The empty state says which one to widen.
 */
export function dateFilterMissesPeriod(
    filters: ColumnFilters,
    period: DeliveryPeriod | null,
): boolean {
    const f = filters.date;
    if (!period || !f || f.kind !== 'dateRange') return false;
    const { from, to } = periodBounds(period);
    if (f.from !== null && f.from > to) return true;
    if (f.to !== null && f.to < from) return true;
    return false;
}

// ─── Derived ────────────────────────────────────────────────────────────────────

export interface DeliveryLedgerAxes {
    scope: Scope;
    period: DeliveryPeriod | null;
    issue: IssueLens | null;
    query: string;
    filters: ColumnFilters;
}

/**
 * Stable fingerprint of every axis — used as the client's React key, so a lens, a
 * search OR a column filter remounts the pager against the window the server just
 * prefetched for those axes. Filters are emitted in column order and their values in
 * the order they were parsed, so the same filters always produce the same key.
 */
export function axesKey(axes: DeliveryLedgerAxes): string {
    return [
        axes.scope,
        axes.period ? periodKey(axes.period) : 'none',
        axes.issue ?? 'all',
        axes.query,
        filtersKey(axes.filters),
    ].join('|');
}

export function filtersKey(filters: ColumnFilters): string {
    return FILTER_COLUMNS.map((c) => {
        const v = serializeColumnFilter(filters[c.key] ?? null);
        return v === null ? '' : `${c.key}=${v}`;
    })
        .filter(Boolean)
        .join(';');
}

export function hasActiveLens(
    axes: Pick<DeliveryLedgerAxes, 'issue' | 'query'> & { filters?: ColumnFilters },
): boolean {
    return (
        axes.issue !== null ||
        axes.query.length > 0 ||
        activeFilterCount(axes.filters ?? NO_FILTERS) > 0
    );
}

/** The lens+filter bundle every fetch has to carry, or the keyset walk drifts. */
export interface DeliveryLens {
    issue: IssueLens | null;
    query: string;
    filters: ColumnFilters;
}
