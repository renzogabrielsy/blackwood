'use client';

import * as React from 'react';
import { Loader2 } from 'lucide-react';

import { BlackwoodTable } from '@/components/shared/table';
import type { TableChromeRowApi, TableSummaryRow } from '@/components/shared/table';
import { DEFAULT_FIRST_ITEM_INDEX, shiftFirstItemIndex } from '@/lib/table';
import type { ColumnSpec, TableSettings } from '@/lib/table';
import type { CellRange } from '@/lib/hooks/use-cell-selection';
import { useTableEdits } from '@/lib/hooks/use-table-edits';
import { cn } from '@/lib/utils';

import { formatCccFlec } from '../types';
import type { CenaproPeriod, LedgerAnchor } from './actions';
import { CenaproPeriodPicker } from './period-picker';
import { ScopeToggle, ViewModeSwitcher, useLedgerFilters } from './ledger-controls';
import { ColumnFilterMenu, FilterSummaryChip, FilteredEmptyState } from './column-filter-menu';
import {
    FILTER_SPECS,
    collectFilterPresence,
    describeActiveFilters,
    mergeDiscoveredGroups,
    mergeDiscoveredOptions,
    type FilterableEventFields,
    type LedgerFilters,
} from './ledger-url';
import { useLedgerWindow, type InitialLedgerPage } from './use-ledger-window';
import {
    PRODUCTION_CTX_ENDLESS,
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
    type ProductionItem,
} from './production-grid-v2-shared';

// ═════════════════════════════════════════════════════════════════════════════════
// Cenapro production — the ENDLESS-scope sheet, rendered through the Blackwood Table.
//
// The v2 twin of `production-endless-sheet.tsx` (the DEFAULT view of
// `/cenapro/production`, at `?grid=v2`). Built BESIDE that sheet, which is the production
// path and is not edited by one character.
//
// ── READ-ONLY, AND WHY THAT IS STRUCTURAL ───────────────────────────────────────
// No column spec declares a `parse`, so `columnAcceptsEdit` refuses every cell. There is
// therefore no lock/unlock toggle, no draft pool, no localStorage draft mirror, no resume
// prompt, no Save and no Discard — none of those has anything to guard. `saveProductionEvents`
// is not imported. What IS live: selection, ranges, the full keyboard, copy, column resize,
// frozen panes at both ends, month headings, day spacers, and a sticky window footer.
//
// ── THE PAGER, AND THE ONE NUMBER IT IS EASY TO GET WRONG ───────────────────────
// The window itself is `useLedgerWindow` — the SAME hook, unmodified, calling the SAME
// read-only `fetchLedgerPage` action the live sheet calls, with the SAME server-applied
// filters. Nothing new is queried.
//
// What is NOT reused is that hook's `firstItemIndex`. It decrements its base by the number
// of RECORDS it prepended, and this sheet's flat item array grows by MORE than that: a
// month boundary brings a heading and a day boundary brings a blank spacer row. Rebasing
// by records while the array grew by items leaves the viewport short by exactly the
// difference, and the sheet visibly jumps when older rows land. `lib/table/paging.ts` is
// explicit about it — *measure the array, do not count what you asked for*.
//
// So the base is derived HERE, as a pure function of the items array, using
// `shiftFirstItemIndex`: **how many items sit above a FIXED anchor row.** Two properties
// fall out of that shape, and each of them is a way this otherwise goes wrong:
//
//   • The prepend and the new base are produced by the SAME render, so they cannot be
//     committed separately — stronger than the "one state batch" rule the prop asks for.
//   • It measures items ABOVE AN ANCHOR rather than `items.length`, because the array also
//     grows when `fetchNewer` APPENDS at the far end, and rebasing after an append would
//     shove the viewport upwards by the rows added below the fold.
//
// `initialTopMostItemIndex` is deliberately NOT rebased: every inbound scroll API takes a
// RAW array position and clamps against the count, so a rebased index resolves to the last
// row every time.
//
// ── DELIBERATELY ABSENT ─────────────────────────────────────────────────────────
// There is no SORT control, and that is not an omission: the endless order is the server's
// keyset order (`recv_date ASC, id ASC`) and it is what every cursor is expressed in. A
// client-side re-sort would reorder the rows the pager is walking and make `hasOlder` /
// `hasNewer` describe a different sheet than the one on screen.
//
// The selection aggregate pill is absent because the platform computes SUM/AVERAGE for its
// own use and does not hand them out — see the note in the focus grid and the report.
// ═════════════════════════════════════════════════════════════════════════════════

export interface ProductionEndlessSheetV2Props {
    /** The server-prefetched, already-anchored, already-FILTERED first window. */
    initialPage: InitialLedgerPage;
    anchor: LedgerAnchor;
    /**
     * The filters the server ALREADY APPLIED to `initialPage`. Every subsequent page must
     * carry the same set or the keyset walk drifts back to unfiltered history — which is
     * why they are pushed into the query rather than hiding rows after the fact.
     */
    filters: LedgerFilters;
    filtersActive: boolean;
    periods: CenaproPeriod[];
    selectedPeriod: CenaproPeriod | null;
    loadError: string | null;
}

/** Module-level: there is no blank-row pool here, so no id is ever a draft. */
const NEVER_A_DRAFT = (): boolean => false;

export function ProductionEndlessSheetV2({
    initialPage,
    anchor,
    filters,
    filtersActive,
    periods,
    selectedPeriod,
    loadError,
}: ProductionEndlessSheetV2Props) {
    // The window. Same hook, same action, same filters as the live sheet.
    const win = useLedgerWindow(initialPage, filters);
    // Destructured, never held as the container: the hook returns a FRESH object every
    // render while its members are individually stable, so depending on `win` would hand
    // the virtualiser a new edge callback per render and re-key the list.
    const { rows: committed, hasOlder, hasNewer, loadingOlder, loadingNewer, notice, fetchOlder, fetchNewer } = win;

    // The FILTER axis. `filterUi.filters` is the OPTIMISTIC control state (a checkbox ticks
    // instantly); the rows on screen reflect the `filters` PROP, which is what the server
    // query used. Its writes preserve every other param, `grid=v2` included.
    const filterUi = useLedgerFilters();

    const { items, chrome, totals } = React.useMemo(
        () => flattenProductionRows(committed, 'endless', 'recv_date'),
        [committed],
    );

    const [settings, setSettings] = React.useState<TableSettings>({});
    const [selection, setSelection] = React.useState<CellRange | null>(null);

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
     * Wired because `BlackwoodTable` requires a writer, and permanently empty because no
     * column declares a `parse`, so `applyEdits` can never be reached.
     */
    const edits = useTableEdits({ canonicalText: storedText, isDraft: NEVER_A_DRAFT });

    /**
     * Which values each column carries in the rows CURRENTLY LOADED. Used to DIM — never to
     * hide and never to disable: in the endless scope a value absent from the loaded window
     * can still exist further back in history, and the query-side filter will find it.
     */
    const presence = React.useMemo(
        () =>
            collectFilterPresence(
                committed.map(
                    (r): FilterableEventFields => ({
                        shift_code: r.shift_code,
                        grade_code: r.grade_code,
                        plant_code: r.plant_code,
                        warehouse_code: r.warehouse_code,
                        source_location_code: r.source_location_code,
                        ccc_flec: formatCccFlec(r.disposition_kind, r.partner_equipment_code),
                    }),
                ),
            ),
        [committed],
    );

    // ── The pager's PUBLIC index base ───────────────────────────────────────────
    //
    // See the file header. The anchor is the FIRST event row of the window as it was first
    // seen; `itemsAbove` is how many items sat above it then, and the live measurement is
    // how many sit above it now. The difference IS the number of items prepended.
    const [pagerAnchor, setPagerAnchor] = React.useState<{ id: string; itemsAbove: number } | null>(null);

    React.useEffect(() => {
        if (pagerAnchor && items.some((it) => 'id' in it && it.id === pagerAnchor.id)) return;
        // First paint, or the window was re-anchored under us (a period jump): take the
        // first event row as the new origin and start the base over.
        const at = items.findIndex((it) => it.kind === 'event');
        setPagerAnchor(at >= 0 ? { id: (items[at] as { id: string }).id, itemsAbove: at } : null);
    }, [items, pagerAnchor]);

    const firstItemIndex = React.useMemo(() => {
        if (!pagerAnchor) return DEFAULT_FIRST_ITEM_INDEX;
        const at = items.findIndex((it) => 'id' in it && it.id === pagerAnchor.id);
        if (at < 0) return DEFAULT_FIRST_ITEM_INDEX;
        return shiftFirstItemIndex({
            firstItemIndex: DEFAULT_FIRST_ITEM_INDEX,
            previousItemCount: pagerAnchor.itemsAbove,
            nextItemCount: at,
        });
    }, [items, pagerAnchor]);

    /**
     * Open on the NEWEST row when the anchor is `latest`, and at the TOP when it is a
     * period jump (the window opens at that period's oldest row and pages forward).
     *
     * A LAZY `useState` initialiser rather than a value recomputed per render: it runs
     * exactly once, on mount, against the server-seeded window — the only window it is
     * allowed to describe. And it is a RAW array position, never rebased by
     * `firstItemIndex`, because the inbound API clamps against the count.
     */
    const [initialTop] = React.useState<number>(() => {
        if (anchor.kind !== 'latest') return 0;
        for (let i = items.length - 1; i >= 0; i--) if (items[i].kind === 'event') return i;
        return 0;
    });

    // ── Chrome rows ─────────────────────────────────────────────────────────────
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

    /**
     * The sticky footer, and it says LOADED rather than TOTAL on purpose.
     *
     * This sheet holds a window of history, not all of it, so a figure labelled "total"
     * would be a number nobody could reconcile against anything. `hasOlder` / `hasNewer`
     * say out loud that more exists either side.
     */
    const summaryRows = React.useMemo<TableSummaryRow[]>(
        () => [
            {
                key: 'loaded',
                sticky: true,
                label: (
                    <span className="font-mono text-[11px] font-bold uppercase tracking-wide">
                        Σ Loaded · {totals.rows.toLocaleString('en-US')} row{totals.rows === 1 ? '' : 's'}
                        {hasOlder || hasNewer ? (
                            <span className="ml-1 font-normal normal-case text-muted-foreground/60">
                                (more {hasOlder && hasNewer ? 'above and below' : hasOlder ? 'above' : 'below'})
                            </span>
                        ) : null}
                        {filtersActive ? (
                            <span className="ml-1 font-normal normal-case text-primary">· filtered</span>
                        ) : null}
                    </span>
                ),
                figure: <span className="font-mono text-[11px] font-bold tabular-nums">{formatKgTotal(totals.kg)}</span>,
                total: <span className="font-mono text-[11px] font-bold tabular-nums">{formatFlec(totals.flec)}</span>,
            },
        ],
        [totals, hasOlder, hasNewer, filtersActive],
    );

    // The scrolling half of the IN/OUT/DVO tint. The pinned half is painted inside the
    // pinned columns' `format` — a frozen `<td>` carries an opaque background that covers
    // any `<tr>` wash. See `pinnedTint` in the shared adapter.
    const rowClassFor = React.useCallback((item: ProductionItem) => {
        if (item.kind !== 'event' || !('data' in item)) return undefined;
        return cn('group transition-colors duration-150 hover:bg-muted', productionRowTint(item.data.dir));
    }, []);

    // ── Header slots: the six column filters ────────────────────────────────────
    const renderHeaderSlot = React.useCallback(
        (spec: ColumnSpec<ProductionGridRow, ProductionGridCtx>) => {
            const column = PRODUCTION_FILTER_BY_KEY.get(spec.key);
            if (!column) return null;
            const options = mergeDiscoveredOptions(column, presence[column]);
            return (
                <ColumnFilterMenu
                    label={FILTER_SPECS[column].label}
                    showLabel={false}
                    selected={filterUi.filters[column]}
                    options={options}
                    groups={mergeDiscoveredGroups(column, options)}
                    present={presence[column]}
                    searchable={FILTER_SPECS[column].searchable}
                    onChange={(values) => filterUi.setColumn(column, values)}
                    align={column === 'ccc' ? 'end' : 'start'}
                />
            );
        },
        [presence, filterUi],
    );

    const startReached = React.useCallback(() => void fetchOlder(), [fetchOlder]);
    const endReached = React.useCallback(() => void fetchNewer(), [fetchNewer]);

    const activeFilterDescription = React.useMemo(() => describeActiveFilters(filters), [filters]);
    const selectedCells = selection
        ? (selection.endRow - selection.startRow + 1) * (selection.endCol - selection.startCol + 1)
        : 0;

    return (
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
            {/* Toolbar. Solid, not glass — a `shrink-0` flex child, not a sticky surface. */}
            <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border bg-muted/40 px-2 py-1.5 text-[11px] text-muted-foreground md:px-3">
                <span className="rounded-sm border border-amber-500/40 px-1 font-medium text-amber-600 dark:text-amber-400">
                    grid=v2
                </span>
                {/* The period picker is a JUMP-TO anchor here, not a clamp — it re-seeds the
                    window server-side and `page.tsx` remounts this component. */}
                <CenaproPeriodPicker periods={periods} selected={selectedPeriod} />
                <span className="h-4 w-px bg-border/60" />
                <ViewModeSwitcher mode="ledger" />
                <span className="h-4 w-px bg-border/60" />
                <ScopeToggle scope="endless" />
                <span className="h-4 w-px bg-border/60" />
                <span className="font-mono">
                    {committed.length.toLocaleString('en-US')} loaded
                    {filtersActive ? <span className="ml-1 text-primary">· filtered</span> : null}
                    {hasOlder || hasNewer ? (
                        <span className="ml-1 text-muted-foreground/50">· scroll to load more</span>
                    ) : null}
                </span>
                {selectedCells > 0 ? (
                    <span className="font-mono text-muted-foreground/70">
                        · {selectedCells.toLocaleString('en-US')} cell{selectedCells === 1 ? '' : 's'} selected
                    </span>
                ) : null}
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
                // Inline error, per the HARD RULE: persists until dismissed, and copyable.
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

            {notice ? (
                <div className="shrink-0 border-b border-amber-500/30 bg-amber-500/10 px-3 py-1.5 text-[11px] text-amber-700 dark:text-amber-300">
                    {notice}
                </div>
            ) : null}

            {/* The two edge spinners. `pointer-events-none` so neither ever eats a click on a
                cell underneath, and both are ABSOLUTE over the sheet rather than inserted
                into the flex column — a strip that appears and disappears between renders
                would resize the scrollport and move the rows under the operator's caret. */}
            <div className="relative flex min-h-0 flex-1 flex-col">
                {loadingOlder ? (
                    <div className="pointer-events-none absolute inset-x-0 top-0 z-40 flex items-center justify-center gap-1.5 border-b border-border/40 bg-muted/85 py-1 text-[11px] text-muted-foreground backdrop-blur-sm">
                        <Loader2 className="h-3 w-3 animate-spin" />
                        Loading earlier entries…
                    </div>
                ) : null}

                <BlackwoodTable<ProductionGridRow, ProductionGridCtx>
                    items={items}
                    kinds={PRODUCTION_KINDS}
                    specs={PRODUCTION_SPECS}
                    ctx={PRODUCTION_CTX_ENDLESS}
                    edits={edits}
                    storedText={storedText}
                    scope="endless"
                    settings={settings}
                    onSettingsChange={setSettings}
                    rowRules={PRODUCTION_ROW_RULES}
                    rowClassFor={rowClassFor}
                    renderChromeRow={renderChromeRow}
                    renderHeaderSlot={renderHeaderSlot}
                    summaryRows={summaryRows}
                    onSelectionChange={setSelection}
                    firstItemIndex={firstItemIndex}
                    initialTopMostItemIndex={initialTop}
                    startReached={startReached}
                    endReached={endReached}
                    emptyMessage={
                        filtersActive ? (
                            <FilteredEmptyState active={activeFilterDescription} onClear={filterUi.clearAll} />
                        ) : (
                            (notice ?? 'No production events to display.')
                        )
                    }
                    className="min-h-0 flex-1"
                />

                {loadingNewer ? (
                    <div className="pointer-events-none absolute inset-x-0 bottom-0 z-40 flex items-center justify-center gap-1.5 border-t border-border/40 bg-muted/85 py-1 text-[11px] text-muted-foreground backdrop-blur-sm">
                        <Loader2 className="h-3 w-3 animate-spin" />
                        Loading newer entries…
                    </div>
                ) : null}
            </div>
        </div>
    );
}
