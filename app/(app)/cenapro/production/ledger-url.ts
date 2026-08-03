// ─── Cenapro production ledger — URL axis helpers (pure, no React) ───────────────
// The production screen is governed by orthogonal URL axes. This module owns them as
// pure parse/format helpers so BOTH the server page (page.tsx) and the client toolbar
// controls (ledger-controls.tsx) share one source of truth without a client/server
// boundary hazard — there is NO 'use client' directive here, so the server component
// can call `parseViewMode` / `parseScope` / `plantViewOf` / `parseLedgerFilters`
// directly, and the 'use server' action module can import the filter types + matcher.
//
//   1. VIEW   (`?view=ledger|daily-w6|daily-w7`) — WHAT you look at: the flat ledger, or
//      the W6 / W7 daily pivot. (The EDIT lock/unlock axis is UI-only, no URL param.)
//   2. SCOPE  (`?scope=endless|focus`) — HOW MUCH history is in view: the whole
//      cursor-guided history (endless), or one clamped (batch_year, batch) period (focus).
//   3. FILTER (`?shift=`, `?grade=`, `?plant=`, `?whse=`, `?src=`, `?ccc=`) — WHICH rows
//      are shown. Per-column MULTI-SELECT; see the "Filter axis" block at the bottom.
//
// The axes are independent: every VIEW × SCOPE × FILTER combination is valid.

// ─── View axis ──────────────────────────────────────────────────────────────────
export const VIEW_MODES = ['ledger', 'daily-w6', 'daily-w7'] as const;
export type ViewMode = (typeof VIEW_MODES)[number];

export const VIEW_MODE_LABELS: Record<ViewMode, string> = {
    ledger: 'Ledger',
    'daily-w6': 'Daily W6',
    'daily-w7': 'Daily W7',
};

export function parseViewMode(raw: string | null | undefined): ViewMode {
    // Backward-compat: the legacy single Daily Block (`?view=daily`) maps to W6.
    if (raw === 'daily') return 'daily-w6';
    return raw && (VIEW_MODES as readonly string[]).includes(raw) ? (raw as ViewMode) : 'ledger';
}

/** Map a daily view mode → the plant variant the Daily Block renders (null for ledger). */
export function plantViewOf(mode: ViewMode): 'W6' | 'W7' | null {
    if (mode === 'daily-w6') return 'W6';
    if (mode === 'daily-w7') return 'W7';
    return null;
}

// ─── Scope axis ─────────────────────────────────────────────────────────────────
export const SCOPES = ['endless', 'focus'] as const;
export type Scope = (typeof SCOPES)[number];

// `endless` is the default and OMITS the param (clean URLs); anything invalid/absent
// resolves to endless. Only `focus` is written as `?scope=focus`.
export function parseScope(raw: string | null | undefined): Scope {
    return raw === 'focus' ? 'focus' : 'endless';
}

// ═══ Filter axis ════════════════════════════════════════════════════════════════
// SIX per-column MULTI-SELECT filters. Each column owns one URL param carrying a
// comma-separated list of the values to SHOW. The contract, in full:
//
//   • An EMPTY selection means "show all" — the param is OMITTED entirely (clean URLs).
//     There is deliberately no "show nothing" state, so a filter can never strand the
//     operator on an empty grid with no way back.
//   • `__NULL__` is the sentinel for a blank/NULL cell (Plant "— None", Whse
//     "— Unplaced"). It is the same sentinel the pre-multi-select grid already used.
//   • Values are the raw DB codes so a URL is human-readable: `?whse=WHSE+1,__NULL__`.
//   • Unknown values are preserved verbatim rather than dropped — a code that exists in
//     data but not in the canonical constants below stays selectable/shareable.
//
// CCC/FLEC is ONE on-screen column (Excel parity) standing in for TWO DB fields
// (`disposition_kind` + `partner_equipment_code`). Its selection is therefore an OR
// ACROSS TWO COLUMNS: `FLEC` ⇒ `disposition_kind = 'flec_bagging'`, and each equipment
// code ⇒ `partner_equipment_code = <code>`. `cccFlecPredicateParts()` below is the ONE
// place that split is expressed; `actions.ts` turns it into PostgREST, the client
// matcher compares against the merged `formatCccFlec()` cell. Same rule, two renderings.

import {
    SHIFT_CODES,
    GRADE_CODES,
    PLANT_CODES,
    WAREHOUSE_CODES,
    SOURCE_LOCATION_CODES,
    CRUSHER_CODES,
    KILN_CODES,
} from '../types';

export const FILTER_COLUMNS = ['shift', 'grade', 'plant', 'whse', 'source', 'ccc'] as const;
export type FilterColumn = (typeof FILTER_COLUMNS)[number];

/** Per-column URL param name. `source` shortens to `src`; the rest are literal. */
export const FILTER_PARAMS: Record<FilterColumn, string> = {
    shift: 'shift',
    grade: 'grade',
    plant: 'plant',
    whse: 'whse',
    source: 'src',
    ccc: 'ccc',
};

/** Sentinel for a blank/NULL cell in a nullable column. */
export const FILTER_NULL = '__NULL__';

/** The selected value-set per column. An empty array = no filter on that column. */
export type LedgerFilters = Record<FilterColumn, readonly string[]>;

export const EMPTY_LEDGER_FILTERS: LedgerFilters = Object.freeze({
    shift: [],
    grade: [],
    plant: [],
    whse: [],
    source: [],
    ccc: [],
});

// ─── Option catalog (the CANONICAL domain, not "whatever the window loaded") ─────
// Sourcing options from loaded rows makes the menu mutate as you scroll and hides a
// value that only exists further back in history. These lists come from the seeded
// `cenapro` lookup constants in `../types.ts` instead, so the menu is stable and
// complete in every scope. Values PRESENT in data but missing here are appended by the
// caller (see `mergeDiscoveredOptions`) so nothing is ever unreachable.
export interface LedgerFilterOption {
    value: string;
    label: string;
    /** Extra searchable words (e.g. "Morning" for shift M). */
    hint?: string;
    /** Group key for a grouped menu (CCC/FLEC). */
    group?: string;
}

export interface LedgerFilterGroup {
    key: string;
    label: string;
    /** Member values — powers the group-level "select all / clear" toggle. */
    values: readonly string[];
}

export interface LedgerFilterSpec {
    column: FilterColumn;
    /** Column header label — also the menu title. */
    label: string;
    options: readonly LedgerFilterOption[];
    groups?: readonly LedgerFilterGroup[];
    /** Show a typeahead input (columns with many options). */
    searchable: boolean;
}

const plain = (v: string): LedgerFilterOption => ({ value: v, label: v });

const SHIFT_HINTS: Record<string, string> = { M: 'Morning', E: 'Evening', N: 'Night' };

export const FILTER_SPECS: Record<FilterColumn, LedgerFilterSpec> = {
    shift: {
        column: 'shift',
        label: 'Shift',
        options: SHIFT_CODES.map((c) => ({ value: c, label: c, hint: SHIFT_HINTS[c] })),
        searchable: false,
    },
    grade: {
        column: 'grade',
        label: 'Grade',
        options: GRADE_CODES.map(plain),
        searchable: false,
    },
    plant: {
        column: 'plant',
        label: 'Plant',
        options: [...PLANT_CODES.map(plain), { value: FILTER_NULL, label: '— None', hint: 'blank unspecified' }],
        searchable: false,
    },
    whse: {
        column: 'whse',
        label: 'Whse',
        options: [
            ...WAREHOUSE_CODES.map(plain),
            { value: FILTER_NULL, label: '— Unplaced', hint: 'blank null no warehouse' },
        ],
        searchable: false,
    },
    source: {
        column: 'source',
        label: 'Source',
        options: SOURCE_LOCATION_CODES.map(plain),
        searchable: true,
    },
    ccc: {
        column: 'ccc',
        label: 'CCC/FLEC',
        options: [
            { value: 'FLEC', label: 'FLEC', hint: 'bag bagging in', group: 'bagging' },
            ...CRUSHER_CODES.map((c) => ({ value: c, label: c, hint: 'crusher', group: 'crushers' })),
            ...KILN_CODES.map((k) => ({ value: k, label: k, hint: 'kiln retort', group: 'kilns' })),
        ],
        groups: [
            { key: 'bagging', label: 'Bagging', values: ['FLEC'] },
            { key: 'crushers', label: 'Crushers', values: CRUSHER_CODES },
            { key: 'kilns', label: 'Kilns', values: KILN_CODES },
        ],
        searchable: true,
    },
};

/**
 * Canonical options for a column, PLUS any value seen in data that the canonical list
 * doesn't know about (appended, flagged `unmapped`). Guarantees a present-but-unmapped
 * value is always reachable from the menu instead of silently unfilterable.
 */
export function mergeDiscoveredOptions(
    column: FilterColumn,
    discovered: Iterable<string>,
): LedgerFilterOption[] {
    const spec = FILTER_SPECS[column];
    const known = new Set(spec.options.map((o) => o.value));
    const extras: LedgerFilterOption[] = [];
    const seen = new Set<string>();
    for (const raw of discovered) {
        const v = (raw ?? '').trim();
        if (!v || known.has(v) || seen.has(v)) continue;
        seen.add(v);
        extras.push({ value: v, label: v, hint: 'unmapped', group: spec.groups ? 'other' : undefined });
    }
    if (extras.length === 0) return [...spec.options];
    return [...spec.options, ...extras];
}

/** Groups for a column, extended with an "Other" bucket when unmapped values exist. */
export function mergeDiscoveredGroups(
    column: FilterColumn,
    options: readonly LedgerFilterOption[],
): readonly LedgerFilterGroup[] | undefined {
    const spec = FILTER_SPECS[column];
    if (!spec.groups) return undefined;
    const others = options.filter((o) => o.group === 'other').map((o) => o.value);
    if (others.length === 0) return spec.groups;
    return [...spec.groups, { key: 'other', label: 'Other', values: others }];
}

// ─── Parse / write ──────────────────────────────────────────────────────────────
// `parseLedgerFilters` takes a plain getter so BOTH callers work unchanged: the server
// page passes `(k) => searchParams[k]` (its awaited plain object) and the client passes
// `(k) => useSearchParams().get(k)`. No React, no Next imports.

/** Defensive cap — a hand-crafted URL can't blow up the query string or the menu. */
const MAX_VALUES_PER_COLUMN = 40;

export type FilterParamGetter = (name: string) => string | string[] | null | undefined;

function parseValueList(raw: string | string[] | null | undefined): string[] {
    if (raw == null) return [];
    // A repeated param (?whse=A&whse=B) arrives as an array from the server searchParams.
    const joined = Array.isArray(raw) ? raw.join(',') : raw;
    const out: string[] = [];
    const seen = new Set<string>();
    for (const part of joined.split(',')) {
        const v = part.trim();
        if (!v || seen.has(v)) continue;
        seen.add(v);
        out.push(v);
        if (out.length >= MAX_VALUES_PER_COLUMN) break;
    }
    return out;
}

export function parseLedgerFilters(get: FilterParamGetter): LedgerFilters {
    return {
        shift: parseValueList(get(FILTER_PARAMS.shift)),
        grade: parseValueList(get(FILTER_PARAMS.grade)),
        plant: parseValueList(get(FILTER_PARAMS.plant)),
        whse: parseValueList(get(FILTER_PARAMS.whse)),
        source: parseValueList(get(FILTER_PARAMS.source)),
        ccc: parseValueList(get(FILTER_PARAMS.ccc)),
    };
}

/** Write the filters onto a URLSearchParams IN PLACE — an empty column deletes its param. */
export function writeLedgerFilters(sp: URLSearchParams, filters: LedgerFilters): void {
    for (const col of FILTER_COLUMNS) {
        const param = FILTER_PARAMS[col];
        const values = filters[col];
        if (!values || values.length === 0) sp.delete(param);
        else sp.set(param, values.join(','));
    }
}

/** Strip every filter param (used by the "clear all" affordances). */
export function deleteLedgerFilters(sp: URLSearchParams): void {
    for (const col of FILTER_COLUMNS) sp.delete(FILTER_PARAMS[col]);
}

// ─── Derived helpers ────────────────────────────────────────────────────────────

/** How many COLUMNS carry a filter (not how many values) — the toolbar chip count. */
export function countActiveFilterColumns(filters: LedgerFilters): number {
    let n = 0;
    for (const col of FILTER_COLUMNS) if (filters[col].length > 0) n++;
    return n;
}

export function hasActiveFilters(filters: LedgerFilters): boolean {
    return countActiveFilterColumns(filters) > 0;
}

/**
 * Stable, order-insensitive fingerprint — used as a React key (endless remount) and to
 * detect when an optimistic client selection has been overtaken by the URL.
 */
export function ledgerFilterKey(filters: LedgerFilters): string {
    return FILTER_COLUMNS.map((c) => `${c}=${[...filters[c]].sort().join('|')}`).join(';');
}

/** Human-readable breakdown for the empty state ("no rows match BECAUSE of these"). */
export function describeActiveFilters(filters: LedgerFilters): { label: string; values: string[] }[] {
    const out: { label: string; values: string[] }[] = [];
    for (const col of FILTER_COLUMNS) {
        const values = filters[col];
        if (values.length === 0) continue;
        const spec = FILTER_SPECS[col];
        out.push({
            label: spec.label,
            values: values.map((v) => spec.options.find((o) => o.value === v)?.label ?? v),
        });
    }
    return out;
}

// ─── CCC/FLEC two-field split ───────────────────────────────────────────────────
/**
 * Split a CCC/FLEC selection into the two DB-field predicates it stands for. The result
 * is an OR: a row matches when its disposition is `flec_bagging` (only if `flecBagging`)
 * OR its `partner_equipment_code` is in `equipment`. This single helper is what keeps the
 * server (PostgREST) and the client (row matcher) expressing the SAME rule.
 */
export function cccFlecPredicateParts(values: readonly string[]): {
    flecBagging: boolean;
    equipment: string[];
} {
    let flecBagging = false;
    const equipment: string[] = [];
    for (const v of values) {
        if (v === 'FLEC') flecBagging = true;
        else if (v !== FILTER_NULL) equipment.push(v);
    }
    return { flecBagging, equipment };
}

// ─── Client-side row matcher (Focus scope + unsaved-row checks) ─────────────────
// Structural, so BOTH row shapes satisfy it: the editable grid's `GridRow` (all
// non-null strings) and a `ProductionEventRow` mapped through `formatCccFlec()`.
export interface FilterableEventFields {
    shift_code?: string | null;
    grade_code?: string | null;
    plant_code?: string | null;
    warehouse_code?: string | null;
    source_location_code?: string | null;
    /** The MERGED Excel-parity CCC/FLEC cell — "FLEC" | "C1".."C4" | "RK1".."RK4". */
    ccc_flec?: string | null;
}

function matchOne(raw: string | null | undefined, selected: readonly string[]): boolean {
    if (selected.length === 0) return true; // empty selection = no filter = show all
    const v = (raw ?? '').trim();
    if (v === '') return selected.includes(FILTER_NULL);
    return selected.includes(v);
}

/**
 * Which values each column actually carries in the rows currently on screen. Used to DIM
 * (never hide, never disable) options with no rows here — in the endless scope a value
 * absent from the loaded window can still exist further back, and the query-side filter
 * will find it. A blank cell registers as the `__NULL__` sentinel.
 */
export function collectFilterPresence(
    rows: readonly FilterableEventFields[],
): Record<FilterColumn, Set<string>> {
    const out: Record<FilterColumn, Set<string>> = {
        shift: new Set(),
        grade: new Set(),
        plant: new Set(),
        whse: new Set(),
        source: new Set(),
        ccc: new Set(),
    };
    const add = (set: Set<string>, raw: string | null | undefined) => {
        const v = (raw ?? '').trim();
        set.add(v === '' ? FILTER_NULL : v);
    };
    for (const r of rows) {
        add(out.shift, r.shift_code);
        add(out.grade, r.grade_code);
        add(out.plant, r.plant_code);
        add(out.whse, r.warehouse_code);
        add(out.source, r.source_location_code);
        add(out.ccc, r.ccc_flec);
    }
    return out;
}

/** True when the row survives EVERY active column filter (columns AND together). */
export function matchesLedgerFilters(row: FilterableEventFields, filters: LedgerFilters): boolean {
    return (
        matchOne(row.shift_code, filters.shift) &&
        matchOne(row.grade_code, filters.grade) &&
        matchOne(row.plant_code, filters.plant) &&
        matchOne(row.warehouse_code, filters.whse) &&
        matchOne(row.source_location_code, filters.source) &&
        matchOne(row.ccc_flec, filters.ccc)
    );
}
