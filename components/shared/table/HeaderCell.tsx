'use client';

import * as React from 'react';
import { ArrowDown, ArrowUp, ChevronsUpDown, ListFilter } from 'lucide-react';

import { cn } from '@/lib/utils';
import type { ColumnFilter, ColumnSpec, SortDirection } from '@/lib/table';
import { HeaderFilterPopover } from './HeaderFilterPopover';

// ─────────────────────────────────────────────────────────────────────────────────
// HeaderCell — one `<th>`. PLATFORM LAYER.
//
// Three jobs, and the third is the only one with a trap in it:
//
//   • It NAMES the column (`label`, with `title` for the long form when the label is an
//     abbreviation — a header that says `BD` and nothing else is a question the operator
//     has to ask someone).
//   • It SELECTS the column: clicking the label sweeps the whole column, the gesture
//     every spreadsheet has.
//   • It RESIZES. The handle reports a new width through `onSettingsChange` — on
//     POINTERUP, not per frame. A live report re-resolves the column table on every
//     mouse move, which re-renders every mounted row of the sheet; the drag stays a
//     local number and lands once.
//
// **The header is a frozen surface, so it is fully OPAQUE — never glass.** A sticky
// header sits ON TOP of scrolling rows; any alpha or `backdrop-blur` and the moving cells
// bleed through it. That is the opposite of the rule for a floating bar over empty space,
// and it is why this file uses solid `bg-muted` and no `/opacity` anywhere.
// ─────────────────────────────────────────────────────────────────────────────────

/** The narrowest a column may be dragged to. Below this the label has nowhere to go. */
export const MIN_COLUMN_WIDTH = 48;

export interface HeaderCellProps<Row, Ctx> {
    spec: ColumnSpec<Row, Ctx>;
    /** Display index — what a column-selection click addresses. */
    index: number;
    pin: 'start' | 'end' | null;
    /** The last start-pinned column / the first end-pinned one — carries the seam. */
    edge: boolean;
    /** Sticky offset for a pinned header cell. */
    left?: number;
    right?: number;
    /** Sweep the whole column. Absent ⇒ the label is not clickable. */
    onSelectColumn?(index: number): void;
    /** Report a new width for this column. Called ONCE, when the drag ends. */
    onResize?(key: string, width: number): void;
    /**
     * A filter trigger, a sort caret — anything the CONSUMER hangs off the header.
     *
     * `BlackwoodTable` fills it from its `renderHeaderSlot` prop; absent, no slot element
     * is rendered at all. It renders BESIDE the built-in sort and filter affordances
     * below, never instead of them: a consumer's own URL-driven filter and the table's
     * local one are different tools and a screen may legitimately want both.
     */
    filterSlot?: React.ReactNode;

    // ── The BUILT-IN sort / filter affordances ───────────────────────────────────
    //
    // Both are `undefined` when the table does not offer them for this column (the scope
    // has them off, or the spec opted out), and `undefined` renders no control at all —
    // which is what keeps a header that offers neither byte-identical with before.

    /** This column's current sort direction, or null when the table is sorted by another. */
    sortDir?: SortDirection | null;
    /** Cycle this column's sort: asc → desc → off. Absent ⇒ no caret is rendered. */
    onToggleSort?(key: string): void;
    /** This column's active filter, if any. */
    filter?: ColumnFilter;
    /** Set (or clear, with `undefined`) this column's filter. Absent ⇒ no trigger. */
    onFilterChange?(key: string, next: ColumnFilter | undefined): void;
    /** Does the column declare a `numericValue`? Decides whether bounds are offered. */
    numericFilter?: boolean;
}

export function HeaderCell<Row, Ctx>({
    spec, index, pin, edge, left, right, onSelectColumn, onResize, filterSlot,
    sortDir = null, onToggleSort, filter, onFilterChange, numericFilter = false,
}: HeaderCellProps<Row, Ctx>) {
    const [dragging, setDragging] = React.useState(false);
    const [filterAnchor, setFilterAnchor] = React.useState<{ left: number; bottom: number } | null>(null);
    const resizable = spec.resizable !== false && onResize !== undefined;
    const filterActive = filter !== undefined;
    // A header that OPENS SOMETHING is not a header that sweeps a column. The override
    // replaces the label's click entirely — see `ColumnSpec.onHeaderClick`.
    const headerClick = spec.onHeaderClick;
    const labelClickable = headerClick !== undefined || onSelectColumn !== undefined;

    const startResize = React.useCallback(
        (e: React.PointerEvent<HTMLSpanElement>) => {
            if (!onResize) return;
            // The handle is chrome, not a cell: neither the column-selection click behind
            // it nor the grid's own mousedown may see this gesture.
            e.preventDefault();
            e.stopPropagation();

            const startX = e.clientX;
            const startWidth = spec.width;
            const handle = e.currentTarget;
            handle.setPointerCapture(e.pointerId);
            setDragging(true);

            let width = startWidth;
            const onMove = (ev: PointerEvent) => {
                width = Math.max(MIN_COLUMN_WIDTH, Math.round(startWidth + (ev.clientX - startX)));
            };
            const onUp = () => {
                handle.removeEventListener('pointermove', onMove);
                handle.removeEventListener('pointerup', onUp);
                handle.removeEventListener('pointercancel', onUp);
                setDragging(false);
                if (width !== startWidth) onResize(spec.key, width);
            };
            handle.addEventListener('pointermove', onMove);
            handle.addEventListener('pointerup', onUp);
            handle.addEventListener('pointercancel', onUp);
        },
        [onResize, spec.key, spec.width],
    );

    const style: React.CSSProperties = { width: spec.width };
    if (pin === 'start') style.left = left;
    else if (pin === 'end') style.right = right;

    return (
        <th
            data-col={index}
            data-col-key={spec.key}
            scope="col"
            title={spec.title ?? spec.label}
            style={style}
            className={cn(
                // Solid `bg-muted`, always — a frozen surface that overlaps scrolling
                // content is opaque or it leaks.
                // `group/th` is what makes the resize handle DISCOVERABLE: it was a 4px
                // invisible strip you had to already know about, which is why "width
                // adjustment doesn't exist on every table" was the operator's reading of
                // a feature that was in fact present. It now shows on header hover.
                'group/th relative select-none border-b border-b-border border-r border-r-border/40 bg-muted p-0 text-left align-middle font-medium',
                // The z-scale from CLAUDE.md: a header cell that is ALSO pinned sideways
                // is a corner and out-ranks both (30); a plain header cell is the row (20).
                pin ? 'frozen-corner' : 'frozen-row',
                edge && 'frozen-edge',
            )}
        >
            <div className="flex h-full items-center gap-1 px-2 py-1">
                <button
                    type="button"
                    tabIndex={-1}
                    onMouseDown={(e) => {
                        if (!labelClickable) return;
                        e.preventDefault();
                        e.stopPropagation();
                        // The OVERRIDE, and it is `instead of`, not `as well as`: a header
                        // that opens a detail drawer must not also sweep 400 cells behind
                        // the drawer. The sort caret and the filter trigger are separate
                        // buttons and keep working either way.
                        if (headerClick) headerClick(spec);
                        else onSelectColumn?.(index);
                    }}
                    className={cn(
                        'min-w-0 flex-1 text-left',
                        labelClickable && 'cursor-pointer',
                    )}
                >
                    <span
                        className={cn(
                            'block text-[11px] uppercase tracking-wide text-muted-foreground',
                            // WRAP or TRUNCATE — never both, and truncate is the default,
                            // so a column that says nothing renders exactly as it did
                            // before. `line-clamp-2` bounds the growth: a header may take
                            // two lines, not five, because the whole header row grows to
                            // the tallest cell.
                            spec.headerWrap
                                ? 'whitespace-normal break-words leading-tight line-clamp-2'
                                : 'truncate',
                            labelClickable && 'hover:text-foreground',
                        )}
                    >
                        {/* The NODE if the column has one, else the name. `label` stays a
                            string and stays required — `title`, the resize handle's
                            `aria-label` and any consumer-built column menu all read it as
                            text, and none of them can render a node. */}
                        {spec.labelNode ?? spec.label}
                    </span>
                    {/* The SUB-LABEL: a second line, always one line, always truncated.
                        Independent of `headerWrap` — that governs whether the NAME may
                        take two lines, and this is a subtitle under whatever the name
                        did. Truncating rather than wrapping is what keeps the header a
                        bounded two lines: the row grows to its tallest cell, and a
                        subtitle free to wrap would grow it without limit. */}
                    {spec.subLabel ? (
                        <span
                            data-sub-label
                            className="block truncate text-[9px] leading-tight text-muted-foreground/70"
                        >
                            {spec.subLabel}
                        </span>
                    ) : null}
                </button>

                {/* SORT — one button, cycling asc → desc → off. Faint until the column is
                    actually sorted, then permanent, so a header row of eight columns is
                    not eight competing carets. */}
                {onToggleSort ? (
                    <button
                        type="button"
                        data-grid-chrome
                        data-sort-toggle={spec.key}
                        tabIndex={-1}
                        aria-label={`Sort by ${spec.label}`}
                        title={
                            sortDir === 'asc'
                                ? `${spec.label} — ascending. Click for descending.`
                                : sortDir === 'desc'
                                  ? `${spec.label} — descending. Click to clear.`
                                  : `Sort by ${spec.label}`
                        }
                        onMouseDown={(e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            onToggleSort(spec.key);
                        }}
                        className={cn(
                            'shrink-0 rounded-sm p-0.5 transition-colors duration-150 hover:text-foreground',
                            sortDir
                                ? 'text-primary opacity-100'
                                : 'text-muted-foreground opacity-0 group-hover/th:opacity-100',
                        )}
                    >
                        {sortDir === 'asc' ? (
                            <ArrowUp className="size-3" />
                        ) : sortDir === 'desc' ? (
                            <ArrowDown className="size-3" />
                        ) : (
                            <ChevronsUpDown className="size-3" />
                        )}
                    </button>
                ) : null}

                {/* FILTER — a trigger and its own panel. Same reveal rule as the sort. */}
                {onFilterChange ? (
                    <button
                        type="button"
                        data-grid-chrome
                        data-filter-toggle={spec.key}
                        data-filter-active={filterActive ? 'true' : 'false'}
                        tabIndex={-1}
                        aria-label={`Filter ${spec.label}`}
                        title={`Filter ${spec.label}`}
                        onMouseDown={(e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            if (filterAnchor) {
                                setFilterAnchor(null);
                                return;
                            }
                            const r = e.currentTarget.getBoundingClientRect();
                            setFilterAnchor({ left: r.left, bottom: r.bottom });
                        }}
                        className={cn(
                            'shrink-0 rounded-sm p-0.5 transition-colors duration-150 hover:text-foreground',
                            filterActive || filterAnchor
                                ? 'text-primary opacity-100'
                                : 'text-muted-foreground opacity-0 group-hover/th:opacity-100',
                        )}
                    >
                        <ListFilter className="size-3" />
                    </button>
                ) : null}

                {filterSlot ? (
                    // Marked as chrome so a keystroke or a paste aimed at it is that
                    // control's business, not a grid gesture.
                    <span data-grid-chrome className="shrink-0">
                        {filterSlot}
                    </span>
                ) : null}
            </div>

            {filterAnchor && onFilterChange ? (
                <HeaderFilterPopover
                    label={spec.label}
                    numeric={numericFilter}
                    value={filter}
                    onChange={(next) => onFilterChange(spec.key, next)}
                    anchor={filterAnchor}
                    onClose={() => setFilterAnchor(null)}
                />
            ) : null}

            {resizable ? (
                <span
                    data-grid-chrome
                    data-resize-handle={spec.key}
                    role="separator"
                    aria-orientation="vertical"
                    aria-label={`Resize ${spec.label}`}
                    onPointerDown={startResize}
                    onDoubleClick={(e) => e.stopPropagation()}
                    className={cn(
                        // 1.5 rather than 1: the old 4px strip was a hit zone you had to
                        // find by accident. `touch-none` so a pointer drag is not eaten by
                        // the scroller on a trackpad or a tablet.
                        'absolute inset-y-0 right-0 w-1.5 cursor-col-resize touch-none',
                        // 150ms — a micro-interaction, and the only thing in the header
                        // that transitions at all. Compositor-safe: colour only.
                        'transition-colors duration-150',
                        // VISIBLE on header hover, brighter under the pointer. The handle
                        // announcing itself is the whole difference between "this table
                        // can be resized" and "this table cannot".
                        //
                        // Two AXES, deliberately, so nothing depends on how Tailwind
                        // happens to order two variants of the same property: REVEAL is
                        // `opacity` (bare `opacity-0`, beaten by the `group-hover`
                        // variant), INTENSITY is `background-color` (bare `bg-border`,
                        // beaten by the `hover` variant). A bare utility always loses to
                        // a variant of itself, so both readings are ordering-proof.
                        'opacity-0 group-hover/th:opacity-100',
                        'bg-border hover:bg-primary/60',
                        // A drag that wanders off the header keeps its handle lit.
                        dragging && 'bg-primary opacity-100',
                    )}
                />
            ) : null}
        </th>
    );
}
