'use client';

import * as React from 'react';
import { ArrowDown, ArrowUp, ChevronsUpDown, Loader2 } from 'lucide-react';

import { BlackwoodTable } from '@/components/shared/table';
import type { TableChromeRowApi, TableSummaryRow } from '@/components/shared/table';
import type { ColumnSpec, TableSettings } from '@/lib/table';
import { useTableEdits } from '@/lib/hooks/use-table-edits';
import { cn } from '@/lib/utils';

import { formatCccFlec } from '../types';
import type { ProductionEventRow } from '../types';
import type { CenaproPeriod } from './actions';
import { CenaproPeriodPicker } from './period-picker';
import { ScopeToggle, ViewModeSwitcher, useLedgerFilters } from './ledger-controls';
import { ColumnFilterMenu, FilterSummaryChip, FilteredEmptyState } from './column-filter-menu';
import {
    FILTER_SPECS,
    collectFilterPresence,
    describeActiveFilters,
    hasActiveFilters,
    matchesLedgerFilters,
    mergeDiscoveredGroups,
    mergeDiscoveredOptions,
    type FilterableEventFields,
    type LedgerFilters,
} from './ledger-url';
import {
    PRODUCTION_CTX_FOCUS,
    PRODUCTION_DATE_COLUMNS,
    PRODUCTION_FILTER_BY_KEY,
    PRODUCTION_KINDS,
    PRODUCTION_MIN_WIDTH,
    PRODUCTION_ROW_RULES,
    PRODUCTION_SPECS,
    flattenProductionRows,
    formatFlec,
    formatKgTotal,
    productionRowTint,
    productionStoredText,
    renderDayGapCells,
    renderDayTotalCells,
    renderHeadingCell,
    type ProductionGridCtx,
    type ProductionGridRow,
    type ProductionGroupField,
    type ProductionItem,
} from './production-grid-v2-shared';

// ═════════════════════════════════════════════════════════════════════════════════
// Cenapro production — the FOCUS-scope ledger, rendered through the Blackwood Table.
//
// The v2 twin of `production-ledger-grid.tsx` (`?scope=focus&view=ledger&grid=v2`). It is
// built BESIDE that grid, which is the production path and is not edited by one character
// — the strangler-fig method. Reverting this is deleting two files and three lines of
// `page.tsx`.
//
// ── READ-ONLY, AND THE ONE SENTENCE THAT MAKES IT SO ────────────────────────────
// No column spec in `production-grid-v2-shared.tsx` declares a `parse`, so
// `columnAcceptsEdit` refuses every cell: nothing opens an editor, a paste lands nowhere,
// no cell can go dirty, and `saveProductionEvents` is not imported here at all. What IS
// live is everything that reads: cell selection and rectangular ranges, the full keyboard
// (arrows, Tab, Ctrl+Arrow, Home/End, Ctrl+Home/End, PageUp/PageDown), copy to clipboard,
// column resize, frozen panes at BOTH ends, day headings, `Σ DAY TOTAL` rule-offs, a
// sticky period footer, the two date sorts and the six column filters.
//
// ── WHAT IS DELIBERATELY ABSENT, AND WHY IT IS ABSENT RATHER THAN INERT ─────────
// Save · Discard · the right-click row menu (insert / duplicate / delete) · `Add rows in
// the sheet` · the mobile card list · the Daily W6/W7 pivot. Every one of those either
// writes or is a different table shape, so this file renders NOTHING for them — a control
// that looks alive and does nothing is worse than a control that is not there.
//
// The SELECTION AGGREGATE PILL is now the TABLE's, and this file wires nothing for it.
// It used to be absent, because the platform computed SUM/AVERAGE/COUNT/MIN/MAX and did not
// hand them out — `onSelectionChange` gives the rectangle only, in NAV-ROW coordinates this
// component does not own — so the toolbar printed a cell COUNT, the one thing the rectangle
// honestly says. `BlackwoodTable` publishes the real figures to the app's status bar itself
// now, and the count chip is deleted rather than left to sit beside a truer number.
// ═════════════════════════════════════════════════════════════════════════════════

export interface ProductionLedgerGridV2Props {
    /**
     * The selected period's rows, exactly as `fetchProductionEvents` returned them — the
     * same payload `ProductionView` hands the live grid. Nothing here fetches.
     */
    rows: ProductionEventRow[];
    periods: CenaproPeriod[];
    selectedPeriod: CenaproPeriod | null;
    loadError: string | null;
}

/** Which date column drives the sort. Both date headers are clickable, as in the live grid. */
type DateSortKey = ProductionGroupField;

/**
 * Module-level so the prop identity never changes between renders.
 *
 * There is no blank-row pool on this sheet, so no row id is ever a draft — which is also
 * why `useTableEdits` can never report unsaved work here.
 */
const NEVER_A_DRAFT = (): boolean => false;

/**
 * The live grid's sort rule, re-expressed.
 *
 * Stable sort on the chosen date column with `id` as a deterministic tiebreaker, and
 * **empty dates pushed to the BOTTOM in both directions** — `prod_date` is blank on a great
 * many rows, and a descending sort that floated every blank to the top would bury the data.
 *
 * It is a second copy rather than an import because `sortGridRows` is module-private in
 * `production-ledger-grid.tsx` and that file may not be edited while both grids are alive.
 * Same three clauses, same order, and it operates on the raw view row instead of the
 * ledger's string row (identical outcome — both read the same ISO date strings).
 */
function sortEvents(
    rows: readonly ProductionEventRow[],
    key: DateSortKey,
    dir: 'asc' | 'desc',
): ProductionEventRow[] {
    return [...rows].sort((a, b) => {
        const av = a[key] ?? '';
        const bv = b[key] ?? '';
        const aid = a.id ?? '';
        const bid = b.id ?? '';
        if (!av && !bv) return aid.localeCompare(bid);
        if (!av) return 1;
        if (!bv) return -1;
        const cmp = av.localeCompare(bv);
        const primary = dir === 'asc' ? cmp : -cmp;
        return primary !== 0 ? primary : aid.localeCompare(bid);
    });
}

/**
 * The shape the client-side filter matcher wants.
 *
 * `ccc_flec` is ONE on-screen column standing in for two DB fields, so it has to be merged
 * through `formatCccFlec` before `matchesLedgerFilters` can compare it — the same
 * conversion the live grid does via `toGridRow`. `ledger-url.ts` owns the matching rule;
 * this only feeds it.
 */
function filterFieldsOf(r: ProductionEventRow): FilterableEventFields {
    return {
        shift_code: r.shift_code,
        grade_code: r.grade_code,
        plant_code: r.plant_code,
        warehouse_code: r.warehouse_code,
        source_location_code: r.source_location_code,
        ccc_flec: formatCccFlec(r.disposition_kind, r.partner_equipment_code),
    };
}

/** A date header's sort control, hung off `HeaderCell.filterSlot` via `renderHeaderSlot`. */
function DateSortSlot({
    active,
    dir,
    onClick,
    label,
}: {
    active: boolean;
    dir: 'asc' | 'desc';
    label: string;
    onClick(): void;
}) {
    return (
        <button
            type="button"
            onClick={onClick}
            aria-label={`Sort by ${label}${active ? ` (${dir === 'asc' ? 'ascending' : 'descending'})` : ''}`}
            title={
                active
                    ? `${label}: ${dir === 'desc' ? 'newest first' : 'oldest first'} — click to flip`
                    : `Sort by ${label}`
            }
            className={cn(
                'flex h-4 w-4 items-center justify-center rounded outline-none transition-colors duration-150',
                'focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-primary',
                active ? 'text-primary hover:text-primary/80' : 'text-muted-foreground/40 hover:text-foreground',
            )}
        >
            {active ? (
                dir === 'desc' ? <ArrowDown className="h-3 w-3" /> : <ArrowUp className="h-3 w-3" />
            ) : (
                <ChevronsUpDown className="h-3 w-3" />
            )}
        </button>
    );
}

export function ProductionLedgerGridV2({
    rows,
    periods,
    selectedPeriod,
    loadError,
}: ProductionLedgerGridV2Props) {
    // ── The axes this grid reads but does not own ────────────────────────────────
    //
    // `useLedgerFilters` is the module's ONE client entry point to the FILTER axis: it
    // reads the URL, writes it back with `router.replace` and preserves every other param
    // — which is what keeps `?grid=v2` on the URL when a filter changes, so a filter edit
    // does not silently drop the operator back onto the live grid.
    const filterUi = useLedgerFilters();
    const filters: LedgerFilters = filterUi.filters;
    const filtersActive = hasActiveFilters(filters);

    // ── Sort ─────────────────────────────────────────────────────────────────────
    const [sortKey, setSortKey] = React.useState<DateSortKey>('recv_date');
    const [sortDir, setSortDir] = React.useState<'asc' | 'desc'>('desc');

    // Flat setState calls, never nested: React Strict Mode double-invokes an updater, so a
    // flip nested inside another updater would run twice and cancel out. Same note the live
    // grid carries, for the same bug.
    const handleSort = React.useCallback(
        (key: DateSortKey) => {
            if (key === sortKey) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
            else {
                setSortKey(key);
                setSortDir('desc');
            }
        },
        [sortKey],
    );

    const sorted = React.useMemo(() => sortEvents(rows, sortKey, sortDir), [rows, sortKey, sortDir]);

    /**
     * Presence is measured over the WHOLE period, never over the filtered result — a menu
     * built from what survived its own filter would dim (and then hide) the option you just
     * picked. `ledger-url.ts` is explicit that presence DIMS and never disables.
     */
    const presence = React.useMemo(
        () => collectFilterPresence(sorted.map(filterFieldsOf)),
        [sorted],
    );

    /**
     * The rows this sheet shows.
     *
     * The focus scope filters CLIENT-side because the server hands over the whole period in
     * one payload (the endless twin pushes the same predicates into the keyset query
     * instead, because there a client-side hide would corrupt the pager's edge flags).
     *
     * The filtered-out rows are REMOVED rather than hidden, which is the one visible
     * difference from the live grid: it keeps them in the DOM under `hidden` and numbers
     * every row by its position in the unfiltered list, so its `#` column skips. Here the
     * ordinal is a position in the CURRENT VIEW and therefore runs 1…N without gaps.
     */
    const visible = React.useMemo(
        () => (filtersActive ? sorted.filter((r) => matchesLedgerFilters(filterFieldsOf(r), filters)) : sorted),
        [sorted, filtersActive, filters],
    );

    const { items, chrome, totals } = React.useMemo(
        () => flattenProductionRows(visible, 'focus', sortKey),
        [visible, sortKey],
    );

    // ── The grid's own state ─────────────────────────────────────────────────────
    const [settings, setSettings] = React.useState<TableSettings>({});

    const byRowId = React.useMemo(() => {
        const m = new Map<string, ProductionGridRow>();
        for (const it of items) if ('data' in it) m.set(it.id, it.data);
        return m;
    }, [items]);

    const storedText = React.useCallback(
        (rowId: string, field: string) => productionStoredText(byRowId, rowId, field),
        [byRowId],
    );

    /**
     * The single writer. It is wired up because `BlackwoodTable` requires it — and it stays
     * permanently empty, because no column declares a `parse` so nothing can ever call
     * `applyEdits`. `isDraft` answers `false` for every id: this sheet has no blank-row
     * pool, so there is no row that exists nowhere.
     */
    const edits = useTableEdits({ canonicalText: storedText, isDraft: NEVER_A_DRAFT });

    // ── Chrome rows — CELLS, never a `<tr>` ─────────────────────────────────────
    //
    // The container wraps whatever this returns in its OWN row element in both scopes, and
    // that is load-bearing: `TableVirtuoso` puts `data-index` / `data-known-size` / its own
    // `style` on the `<tr>` and measures rows off `<tbody>`'s children, so a renderer that
    // emitted its own row element would lose measurement.
    //
    // All three treatments live in the shared adapter, so the focus and endless sheets
    // cannot grow two opinions about what a day boundary looks like.
    const renderChromeRow = React.useCallback(
        (item: ProductionItem, api: TableChromeRowApi<ProductionGridRow, ProductionGridCtx>) => {
            if (!('key' in item)) return null;
            const payload = chrome.get(item.key);
            if (!payload) return null;
            if (payload.kind === 'day-gap') return renderDayGapCells(api);
            if (payload.kind === 'heading') return renderHeadingCell(api, payload);
            return renderDayTotalCells(api, payload);
        },
        [chrome],
    );

    // ── The sticky period footer ────────────────────────────────────────────────
    const summaryRows = React.useMemo<TableSummaryRow[]>(
        () => [
            {
                key: 'period',
                sticky: true,
                label: (
                    <span className="font-mono text-[11px] font-bold uppercase tracking-wide">
                        Σ {selectedPeriod ? `${selectedPeriod.batch} ${selectedPeriod.batch_year}` : 'Period'} ·{' '}
                        {totals.rows} row{totals.rows === 1 ? '' : 's'}
                        {filtersActive ? <span className="ml-1 font-normal normal-case text-primary">· filtered</span> : null}
                    </span>
                ),
                figure: <span className="font-mono text-[11px] font-bold tabular-nums">{formatKgTotal(totals.kg)}</span>,
                total: <span className="font-mono text-[11px] font-bold tabular-nums">{formatFlec(totals.flec)}</span>,
            },
        ],
        [selectedPeriod, totals, filtersActive],
    );

    // ── Row washes ──────────────────────────────────────────────────────────────
    //
    // The scrolling half of the IN/OUT/DVO tint. The pinned half cannot come from here —
    // a frozen `<td>` carries an opaque background that covers any `<tr>` wash — so it is
    // painted inside the pinned columns' own `format`. See `pinnedTint` in the shared module.
    const rowClassFor = React.useCallback((item: ProductionItem) => {
        if (item.kind !== 'event' || !('data' in item)) return undefined;
        return cn('group transition-colors duration-150 hover:bg-muted', productionRowTint(item.data.dir));
    }, []);

    // ── Header slots: the six column filters + the two date sorts ───────────────
    const renderHeaderSlot = React.useCallback(
        (spec: ColumnSpec<ProductionGridRow, ProductionGridCtx>) => {
            const dateField = PRODUCTION_DATE_COLUMNS.get(spec.key);
            if (dateField) {
                return (
                    <DateSortSlot
                        active={sortKey === dateField}
                        dir={sortDir}
                        label={spec.label}
                        onClick={() => handleSort(dateField)}
                    />
                );
            }
            const column = PRODUCTION_FILTER_BY_KEY.get(spec.key);
            if (!column) return null;
            const options = mergeDiscoveredOptions(column, presence[column]);
            return (
                <ColumnFilterMenu
                    label={FILTER_SPECS[column].label}
                    showLabel={false}
                    selected={filters[column]}
                    options={options}
                    groups={mergeDiscoveredGroups(column, options)}
                    present={presence[column]}
                    searchable={FILTER_SPECS[column].searchable}
                    onChange={(values) => filterUi.setColumn(column, values)}
                    align={column === 'ccc' ? 'end' : 'start'}
                />
            );
        },
        [sortKey, sortDir, handleSort, presence, filters, filterUi],
    );

    const activeFilterDescription = React.useMemo(() => describeActiveFilters(filters), [filters]);

    return (
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
            {/* Toolbar. A solid token, not glass: this is a `shrink-0` flex child, not a
                sticky surface, and a `backdrop-filter` over an opaque page paints nothing
                while still costing a compositor layer. */}
            <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border bg-muted/40 px-2 py-1.5 text-[11px] text-muted-foreground md:px-3">
                <span className="rounded-sm border border-amber-500/40 px-1 font-medium text-amber-600 dark:text-amber-400">
                    grid=v2
                </span>
                <CenaproPeriodPicker periods={periods} selected={selectedPeriod} />
                <span className="h-4 w-px bg-border/60" />
                {/* This component is mounted only for `view=ledger` — the two Daily pivots
                    have no v2, and `page.tsx` keeps serving them from the live path. */}
                <ViewModeSwitcher mode="ledger" />
                <span className="h-4 w-px bg-border/60" />
                <ScopeToggle scope="focus" />
                <span className="h-4 w-px bg-border/60" />
                <span className="font-mono">
                    {filtersActive
                        ? `${visible.length.toLocaleString('en-US')} of ${sorted.length.toLocaleString('en-US')}`
                        : sorted.length.toLocaleString('en-US')}{' '}
                    row{sorted.length === 1 ? '' : 's'}
                </span>
                {/* The `N cells selected` chip that used to sit here is GONE. It existed
                    because the platform computed SUM/AVERAGE/COUNT/MIN/MAX over the
                    rectangle and did not hand them out, and a consumer cannot re-derive
                    them from a range in nav-row coordinates it does not own — so a COUNT
                    was the only honest thing this toolbar could print. `BlackwoodTable`
                    now publishes the real aggregates to the app's floating status bar
                    itself. A count beside a total is not a second opinion, it is noise. */}
                <div className="flex-1" />
                {filterUi.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
                {filterUi.activeCount > 0 ? (
                    <FilterSummaryChip
                        count={filterUi.activeCount}
                        onClear={filterUi.clearAll}
                        pending={filterUi.isPending}
                    />
                ) : null}
                <span className="font-mono text-muted-foreground/50">read-only · {PRODUCTION_MIN_WIDTH}px min</span>
            </div>

            {loadError ? (
                // Inline error, per the HARD RULE: it persists until dismissed and it can be
                // copied. Nothing in this component raises a toast.
                <div className="flex shrink-0 items-start gap-2 border-b border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
                    <span className="min-w-0 flex-1 whitespace-pre-wrap break-words">{loadError}</span>
                    <button
                        type="button"
                        onClick={() => void navigator.clipboard.writeText(loadError)}
                        className="shrink-0 rounded border border-destructive/40 px-1.5 py-0.5 font-medium transition-colors duration-150 hover:bg-destructive/15"
                    >
                        Copy
                    </button>
                </div>
            ) : null}

            <BlackwoodTable<ProductionGridRow, ProductionGridCtx>
                items={items}
                kinds={PRODUCTION_KINDS}
                specs={PRODUCTION_SPECS}
                ctx={PRODUCTION_CTX_FOCUS}
                edits={edits}
                storedText={storedText}
                scope="focus"
                settings={settings}
                onSettingsChange={setSettings}
                rowRules={PRODUCTION_ROW_RULES}
                rowClassFor={rowClassFor}
                renderChromeRow={renderChromeRow}
                renderHeaderSlot={renderHeaderSlot}
                summaryRows={summaryRows}
                emptyMessage={
                    filtersActive ? (
                        // Name the filters responsible — a bare "nothing here" reads as missing
                        // data when it is actually a predicate the operator set.
                        <FilteredEmptyState active={activeFilterDescription} onClear={filterUi.clearAll} />
                    ) : (
                        'No production events in this period.'
                    )
                }
                className="min-h-0 flex-1"
            />
        </div>
    );
}
