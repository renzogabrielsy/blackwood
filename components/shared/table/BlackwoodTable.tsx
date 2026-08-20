'use client';

import * as React from 'react';
import { TableVirtuoso } from 'react-virtuoso';
import type { ItemProps, TableComponents, TableProps, TableVirtuosoHandle } from 'react-virtuoso';

import { cn } from '@/lib/utils';
import {
    applyTableView, clampDraftAdd, columnFilterable, columnSortable, defaultTableMenu,
    DEFAULT_DRAFT_ROWS, nextSortDirection, NO_FILTERS,
} from '@/lib/table';
import type {
    CellAddress, ColumnFilter, ColumnSpec, GridRow, RowKind, SummarySpans, TableFilters,
    TableMenuAction, TableSettings, TableSort,
} from '@/lib/table';
import { useOptionalStatusBar } from '@/components/providers/status-bar-context';
import { GridContextMenu } from '@/components/shared/grid/GridContextMenu';
import type { GridMenuItem } from '@/components/shared/grid/GridContextMenu';
import { useGridContextMenu } from '@/lib/hooks/use-grid-context-menu';
import type { CellAggregates } from '@/lib/hooks/use-cell-aggregation';
import { useTableColumns } from '@/lib/hooks/use-table-columns';
import { columnAcceptsEdit, useTableRows } from '@/lib/hooks/use-table-rows';
import { useTableInteraction } from '@/lib/hooks/use-table-interaction';
import type { CellRange } from '@/lib/hooks/use-cell-selection';
import type { TableEdits } from '@/lib/hooks/use-table-edits';

import { createCellClassTable } from './cell-classes';
import { HeaderCell } from './HeaderCell';
import { PasteSink } from './PasteSink';
import { NO_EDITS, NO_INVALID, TableCells, TableRowShell } from './Row';
import type { RowHandlers } from './Row';

// ─────────────────────────────────────────────────────────────────────────────────
// BlackwoodTable — the container. PLATFORM LAYER, tenant-neutral.
//
// One Excel-style grid every editable ledger in the app is built on, so *"when I input
// data, I don't have to feel like I'm adjusting based on what feature I'm using"*.
//
// It owns three things and delegates everything else:
//   • the LAYOUT — a `table-fixed` with an explicit `minWidth` inside a horizontally
//     scrolling wrapper, a `<colgroup>` from the resolved widths, a sticky header, and a
//     `TableVirtuoso` or a plain `<table>` depending on the scope;
//   • the CHROME — summary rows on declared lanes, the blank-row pool's `Add N more rows`
//     control, the context menu, the paste sink;
//   • the WIRING — `useTableColumns` × `useTableRows` × `useTableInteraction`, composed
//     once, so a consumer describes its columns and its row families and nothing else.
//
// ── THE FOUR PERFORMANCE RULES, AND WHY THEY ARE RULES ──────────────────────────
//
// The grid this replaces was one ~3,780-line component with ZERO `React.memo` in 5,494
// lines: a keystroke re-rendered every mounted cell — ~900 `<td>` virtualised, 4,086 on a
// busy month, 40–110ms to show one character. Virtualisation bounded the DOM; it did not
// bound the WORK. So:
//
//   1. `computeItemKey` is a MODULE-LEVEL const. A fresh function identity per render
//      makes the virtualiser re-key every row it is holding.
//   2. `itemContent` and `fixedHeaderContent` are `useCallback`'d, so the list re-renders
//      only when something a row can actually SEE has changed.
//   3. The virtuoso `context` carries STATIC values only. A `Set` or a fresh object
//      rebuilt per render there re-renders every mounted row, silently.
//   4. Rows render through the memoized `TableCells`, and an untouched row is handed the
//      `NO_EDITS` / `NO_INVALID` singletons — `edits[id] ?? {}` allocates a new empty
//      object per row per render and defeats the memo with no symptom.
//
// **`ctx` must be referentially stable.** It is a dependency of the column resolution, of
// every editability verdict and of every cell's `format`, so a fresh object per render
// re-renders the whole sheet. A consumer wraps it in a `useMemo`; there is nothing this
// component can do about it from the inside.
//
// ── THE LAYOUT RULES ────────────────────────────────────────────────────────────
//
//   • `table-fixed` + an explicit `minWidth` = Σ column widths, inside `overflow-x-auto`:
//     "never crush, always scroll". There is deliberately NO flexible column — the one
//     that absorbs the slack is the one that silently crushes.
//   • `borderCollapse: 'separate'` + `borderSpacing: 0` is **LOAD-BEARING**. Under
//     `collapse` a border belongs to the TABLE rather than the cell, so a `position:
//     sticky` pinned column's borders scroll away and the pinned block loses its edges.
//     The cost is that a border on a `<tr>` is INERT — which is why every row rule lives
//     on the cells (`cell-classes.ts`), and why re-adding one to a `<tr>` would be both
//     invisible and a second copy of the table.
//   • Pinned cells are fully OPAQUE. Never glass, no alpha, no `backdrop-blur`.
//   • Nothing on a row, a cell or a selection is ever animated.
//
// ── THE SEAMS A REAL CONSUMER TURNED OUT TO NEED ────────────────────────────────
//
// Each of these was found the same way: by a migration that could not express something
// without it. Every one is purely additive — omit it and the grid behaves exactly as it
// did before the seam existed.
//
//   • **`firstItemIndex`** is the virtualiser's PUBLIC index base. It rebases the index
//     reported OUT and NOTHING handed IN — `scrollIntoView` and `initialTopMostItemIndex`
//     still take RAW array positions, because both clamp against `totalCount` and a
//     rebased index would resolve to the last row every time. The consumer decrements it
//     by the ITEMS it prepended, in the same state batch as the prepend.
//   • **`renderChromeRow`** lets a NON-ADDRESSABLE row render its own cells — a group
//     heading, a per-group rule-off — where `summaryRows` can only reach the footer. It
//     returns CELLS and never a `<tr>`, because the virtualiser owns the row element.
//   • **`apiRef`** is the imperative half — "go to row N", and handing the caret back
//     after a dialog closes. See `BlackwoodTableApi`.
//   • **`renderHeaderSlot`** reaches `HeaderCell.filterSlot`, which existed from the start
//     and had no wire to it. The module still renders no filter UI and holds no filter
//     state; it only gives a consumer's popover somewhere to hang.
//   • **`CellSlot.addressable`** (in `lib/table/types.ts`) is the row-family half: a cell
//     that RENDERS content the caret must never stop on. Read by the nav resolver, the
//     jump keys and `goToRow` — by nothing that paints, selects, copies or totals.
//
// ── AND FOUR THINGS THAT ARE NOT SEAMS, BECAUSE THEY ARE NOW DEFAULT-ON ─────────
//
// Renzo, on the ten grids built onto this module in one night: *"every part of the app
// that uses the table should also universally use the following features as well: the
// right click menu and the hover summary."* Each of the four below was present in the
// module and reachable only through a prop most consumers had not supplied — which is
// indistinguishable, from the operator's chair, from not being there at all.
//
//   • **The SUMMARY PILL publishes itself.** The selection's SUM/AVERAGE/COUNT/MIN/MAX
//     were computed on every gesture and discarded. They now go to the app's floating
//     status bar from inside this component, through an OPTIONAL provider so the grid
//     still mounts outside the app shell. A consumer wires nothing.
//   • **The CONTEXT MENU is built in.** `contextMenuItems` used to be the only menu there
//     was, so a grid that omitted it had none. There is now a default one on every grid,
//     and `contextMenuItems` adds to it rather than being it.
//   • **RESIZE works without persistence.** The handle was gated on `onSettingsChange`;
//     it now falls back to session-local widths, so no column is ever un-draggable.
//   • **The SELECTION is one box.** `cell-classes.ts` paints the rectangle's outer edges
//     and nothing inside it — see `lib/table/selection.ts` for the geometry.
// ─────────────────────────────────────────────────────────────────────────────────

/** A row's stable identity — its own id, or a chrome row's key. */
function itemKey<Row>(item: GridRow<Row>): string {
    return 'id' in item ? item.id : item.key;
}

/**
 * MODULE-LEVEL, per rule 1. It reads the key off the item and ignores the index entirely,
 * which also makes it immune to the RAW-vs-PUBLIC index-space trap: a virtualiser reports
 * a PUBLIC index out (array position + `firstItemIndex`) and takes a RAW one in, and a
 * function that never looks at the argument cannot get that wrong.
 */
const computeItemKey = (_index: number, item: GridRow<unknown>): string => itemKey(item);

const EMPTY_INVALID: ReadonlyMap<string, ReadonlySet<string>> = new Map();

// ═══ Public shapes ══════════════════════════════════════════════════════════════

/**
 * What a consumer's custom editor is handed.
 *
 * **The editor owns its text; the grid learns it at COMMIT.** `initialValue` is what it
 * opens with (the type-over character, or the cell's current value), and `onChange` just
 * publishes what it holds. An edit session is ONE gesture, so it is ONE journal entry and
 * ONE write — wiring `onChange` to the store instead would make every keystroke a
 * separate Ctrl+Z and re-render the whole sheet per character.
 */
export interface TableEditorArgs<Row, Ctx> {
    cell: CellAddress;
    spec: ColumnSpec<Row, Ctx>;
    /** The stored row, or null for a row that exists nowhere yet. */
    row: Row | null;
    rowId: string;
    ctx: Ctx;
    initialValue: string;
    onChange(next: string): void;
    commit(): void;
}

/** One summary row — a totals rule-off, a sticky month footer. Lanes, never `colSpan`s. */
export interface TableSummaryRow {
    key: string;
    /** Everything left of the first figure. */
    label?: React.ReactNode;
    /** The `summaryLane: 'figure'` column. */
    figure?: React.ReactNode;
    /** Between the figure and the total. */
    note?: React.ReactNode;
    /** The `summaryLane: 'total'` column. */
    total?: React.ReactNode;
    /** Pin to the bottom of the scrollport. */
    sticky?: boolean;
    className?: string;
}

/** Everything about the grid a surface OUTSIDE it may need to react to. */
export interface TableState {
    activeCell: CellAddress | null;
    isEditing: boolean;
    selection: CellRange | null;
}

export interface TableContextTarget<Row> {
    cell: CellAddress;
    rowId: string | null;
    row: Row | null;
    kind: string | null;
    close(): void;
}

/**
 * What a CHROME row's renderer is handed — everything it needs to tile the column table
 * actually rendered, so it obeys the layout rules rather than guessing at them.
 *
 * All three are read off the resolved columns, so a column hidden for this viewer, moved
 * by a saved order or resized moves the chrome row with it.
 */
export interface TableChromeRowApi<Row, Ctx> {
    /** The visible columns, in display order, with saved widths applied. */
    cols: readonly ColumnSpec<Row, Ctx>[];
    /** The same lanes the summary rows tile with — `frozen`, `spacer`, `weight`, `note`, `total`, `trailing`. */
    spans: SummarySpans;
    /** `cols.length` — the `colSpan` of a cell that runs the whole width. */
    colCount: number;
}

/**
 * The three things a surface OUTSIDE the grid has to be able to DO to it, as opposed to
 * merely react to (`onStateChange` / `onSelectionChange` cover that half).
 *
 * Both of the gestures behind it are ones a consumer cannot express any other way:
 *
 *   • **"Go to row N"** — a link from a popover, a duplicate-peer jump, a search result.
 *     It has to move the caret AND scroll AND take focus, and every one of those lives
 *     inside this component.
 *   • **Giving the caret back after a dialog closes.** Radix restores focus to the
 *     TRIGGER, and a context-menu item has already unmounted by then — so focus lands on
 *     `<body>` and the next keystroke goes nowhere. `onCloseAutoFocus={e => {
 *     e.preventDefault(); api.current?.focus(); }}` is the fix, and it needs the grid's
 *     own sink, which no consumer holds a ref to.
 *
 * **Addressed by ROW ID, never by a nav-row index.** The consumer builds `items` but does
 * NOT own `navRows` — that axis is resolved inside `useTableRows`, and a consumer
 * computing an index from `items` would be a second definition of the row axis, which is
 * precisely the drift this module exists to prevent. `placeById` already answers it.
 *
 * **And it obeys the keyboard's own rule.** `goToRow` tests every candidate lane with
 * `cellAddressable`, so it can never park the caret somewhere the arrows and the Tab run
 * refuse to go.
 */
export interface BlackwoodTableApi {
    /** Put focus where the grid hears BOTH a keydown and a paste. Always `preventScroll`. */
    focus(): void;
    /**
     * Move the caret onto a row, scroll it into view, and take focus — the whole of
     * "go to row N". `colKey` picks the lane; omitted, the caret keeps the column it is
     * on when that row has one, else the first column the row occupies.
     *
     * Returns false when the row is not in the loaded window, so a caller can say so
     * rather than appearing to do nothing.
     */
    goToRow(rowId: string, colKey?: string): boolean;
    /** Scroll a row into view WITHOUT moving the caret. False ⇒ not in the window. */
    scrollToRow(rowId: string): boolean;
    /** The caret, imperatively. Null clears it. */
    setActiveCell(cell: CellAddress | null): void;
}

export interface BlackwoodTableProps<Row, Ctx> {
    /**
     * The imperative half of the surface — see `BlackwoodTableApi`. Purely additive: a
     * consumer that omits it behaves exactly as before.
     */
    apiRef?: React.Ref<BlackwoodTableApi>;
    /** Already FLAT — records, their children, drafts and chrome rows, in render order. */
    items: readonly GridRow<Row>[];
    kinds: ReadonlyMap<string, RowKind<Row>>;
    specs: readonly ColumnSpec<Row, Ctx>[];
    /** Must be referentially stable. See the header. */
    ctx: Ctx;
    settings?: TableSettings;
    onSettingsChange?(next: TableSettings): void;
    /**
     * How the table decides its own width. Default `'content'`.
     *
     * `'content'` is byte-identical with what shipped: `width: 100%` over a `minWidth` of
     * Σ declared widths, which a consumer clamps from outside.
     *
     * `'fill'` fixes the measured layout bug behind that clamp. Under `table-layout:
     * fixed` a table wider than its `<col>`s scales **all** of them — a declared 76px
     * column rendered 94.703px in a 1600px container — while the sticky `left` offsets
     * come from the DECLARED widths, so on a wide monitor the frozen block **overlaps
     * itself**. Under `'fill'` the container's slack is distributed into the non-pinned
     * columns **inside `useTableColumns`' resolution**, and the table is then rendered at
     * that exact pixel width — so every offset, drag wall and footer corner is derived
     * from the widths actually painted. One number describes both.
     *
     * It needs a container observer, so it costs a `ResizeObserver` (rAF-throttled) and a
     * re-resolution of the column table on a genuine resize. A column the operator has
     * dragged, a pinned column and a `resizable: false` column are all excluded from the
     * distribution — see `distributeFill`.
     */
    sizing?: 'content' | 'fill';
    /**
     * May the operator SORT from the column headers?
     *
     * **Defaults to true in the `focus` scope and false in `endless`**, and that split is
     * not a preference. An endless grid's row order and its window are the SERVER's keyset:
     * a client-side sort would reorder only the rows currently loaded, and `hasOlder` /
     * `hasNewer` — which mean "there are older/newer rows beyond this window" in the
     * server's order — would become claims about an order that no longer exists. The
     * Cenapro endless ledger already declined a sort for exactly that reason.
     *
     * Set it true in `endless` deliberately, accepting that the sort covers the loaded
     * window only. A per-column `sortable: false` narrows it further either way.
     */
    enableSort?: boolean;
    /** May the operator FILTER from the column headers? Same default and same reasoning. */
    enableFilter?: boolean;
    /** THE single writer, from `useTableEdits`. */
    edits: TableEdits;
    /** The same function handed to `useTableEdits` as `canonicalText`. */
    storedText(rowId: string, field: string): string;
    scope: 'endless' | 'focus';
    /**
     * React key for a row in the PLAIN table. The virtualised list uses the module-level
     * `computeItemKey` (a virtualiser's key function must not change identity between
     * renders), which reads the same `id` / `key` off the item — keep the two in step.
     */
    rowKey?(item: GridRow<Row>, index: number): string;
    renderEditor?(args: TableEditorArgs<Row, Ctx>): React.ReactNode;
    /**
     * The CELLS of a row the caret can never land on — a group heading, a per-group
     * rule-off, an inline notice. Consulted **only** for items whose `RowKind.addressable`
     * is false; returning `null` (or omitting the prop) leaves today's behaviour exactly as
     * it is, one empty cell per column.
     *
     * **It returns cells, NOT a `<tr>`** — the container wraps them in its own row element
     * in both scopes, and that is load-bearing rather than a style choice. `TableVirtuoso`
     * owns the row element: it puts `data-index` / `data-known-size` / its own `style` on
     * the `<tr>` and measures rows by reading them back off `<tbody>`'s children, so a
     * renderer that emitted its own row element would lose measurement — the defect already
     * fixed once in `Row.tsx`, which is why `TableCells` and `TableRowShell` are separate.
     *
     * The row still gets its family's declared `height`, and it never enters `navRows`.
     *
     * Two layout rules the `api` exists so a consumer can OBEY rather than guess:
     *   • **A lane of span 0 renders NO cell at all.** `colSpan={0}` means "to the end of
     *     the column group" in HTML, which is the opposite of nothing.
     *   • **A cell sitting under a pinned column stays OPAQUE** — a solid theme token, never
     *     glass and never an alpha, or the scrolling cells bleed through it.
     *
     * Must be referentially stable (`useCallback`): it is a dependency of every row's
     * content, so a fresh identity per render re-renders the whole sheet.
     */
    renderChromeRow?(item: GridRow<Row>, api: TableChromeRowApi<Row, Ctx>): React.ReactNode | null;
    /**
     * What hangs off a column HEADER, beside its label — a filter trigger, a sort caret,
     * an active-filter dot.
     *
     * `HeaderCell` has carried a `filterSlot` since it was written, but `BlackwoodTable`
     * builds `headerRow` internally and passed nothing to it, so a consumer holding a
     * popover per column had nowhere to put it and no way to reach the cell. This is that
     * one wire, and nothing else: the module renders no filter UI, owns no filter state
     * and has no opinion about the grammar — the consumer's URL module keeps all of it.
     *
     * The node is wrapped in `data-grid-chrome`, so a keystroke or a paste aimed at it is
     * that control's business and never a grid gesture.
     *
     * `spec` is the RESOLVED column (saved width applied, hidden columns already gone) and
     * `index` is its DISPLAY position — the same index a column-selection click addresses,
     * so a consumer can key its popover state off either.
     *
     * Returning `null` (or omitting the prop) is byte-identical with the behaviour before
     * it existed. Must be referentially stable (`useCallback`): it is a dependency of every
     * header cell, so a fresh identity per render rebuilds the whole header row.
     */
    renderHeaderSlot?(spec: ColumnSpec<Row, Ctx>, index: number): React.ReactNode;
    summaryRows?: readonly TableSummaryRow[];
    /** Show the blank-row pool's `Add N more rows` control. */
    drafts?: { enabled: boolean; defaultCount?: number };
    /** Append N blank rows and return their ids, so an undo can take them away again. */
    onAddDrafts?(count: number): string[];
    onRemoveDrafts?(ids: readonly string[]): void;
    onRestoreDrafts?(ids: readonly string[]): void;
    /** The row-kind key a blank row has. */
    draftKind?: string;
    /** Row kinds that are CHILDREN — a paste anchored on one may never reach a parent. */
    childKinds?: readonly string[];
    /**
     * EXTRA right-click items, rendered ABOVE the built-in ones inside the same popover.
     *
     * **A default menu now ships with every grid** — Copy, Copy with headers, Copy row,
     * Select row, Select column, Clear selection, plus Clear contents / Paste / Fill down
     * wherever the clicked cell actually accepts an edit. Before this the prop existed and
     * nothing rendered without it, so right-click on ten migrated grids did whatever the
     * browser does.
     *
     * So this is now purely ADDITIVE content: return the consumer's own items (a "go to
     * peer", a "delete receipt") and the shared ones appear below a separator. Returning
     * null, or omitting the prop, leaves the built-in menu exactly as it is.
     */
    contextMenuItems?(target: TableContextTarget<Row>): React.ReactNode;
    /**
     * Suppress the built-in menu entirely — the escape hatch for a surface that owns its
     * own right-click gesture. Default false: the menu is ON everywhere, which is the
     * whole point of it.
     */
    disableDefaultContextMenu?: boolean;
    /** Extra classes for a `<tr>` — a status rail, a duplicate wash. Never a border. */
    rowClassFor?(item: GridRow<Row>, navRow: number | null): string | undefined;
    /** Row family → bottom-rule classes. Defaults to `DEFAULT_ROW_RULES`. */
    rowRules?: Record<string, string>;
    /**
     * The selection changed — and the SECOND argument is the half a consumer cannot
     * compute for itself.
     *
     * The range is in NAV-ROW coordinates, and that axis is resolved inside
     * `useTableRows`; re-totalling it against the consumer's own `items` would be a
     * second definition of the row axis, which is the same class of bug as rebasing
     * `firstItemIndex` by records instead of items. So the aggregates ride along.
     *
     * Note the table ALSO publishes them to the app's floating status bar by itself (see
     * `useOptionalStatusBar` below), so a consumer that only wanted the pill needs no
     * handler at all. This is for a consumer that wants the numbers somewhere else.
     */
    onSelectionChange?(range: CellRange | null, meta?: { size: number; aggregates: CellAggregates | null }): void;
    /**
     * The grid's observable state, whenever it moves. What a status bar, a save button or
     * an unsaved-work guard reads — and what makes the interaction testable from outside
     * without reaching into a class name.
     */
    onStateChange?(state: TableState): void;
    className?: string;
    /** endless only — the keyset pager's two edges. */
    startReached?(): void;
    endReached?(): void;
    initialTopMostItemIndex?: number;
    /**
     * endless only — the virtualiser's PUBLIC index base, which is what makes a
     * bidirectional keyset pager possible. Ignored in the focus scope.
     *
     * Seed it with a large number (`DEFAULT_FIRST_ITEM_INDEX`) and **DECREMENT it by the
     * number of ITEMS prepended — never by the number of RECORDS fetched.** One fetched
     * record can add several items: its child sub-rows, the group spacer above it, a
     * heading. Counting records while the array grows by more is a known bug class here,
     * and it fails in exactly the way this prop exists to prevent — the viewport jumps by
     * the difference. Measure `items.length` either side, or hand both lengths to
     * `shiftFirstItemIndex`.
     *
     * The prepend and the new base must land in **ONE state batch**. Two updates render the
     * list once with every row shifted and jump it back on the next commit.
     *
     * **It rebases the index the virtualiser reports OUT, and nothing this component hands
     * IN.** `scrollIntoView` and `initialTopMostItemIndex` still take RAW array positions:
     * both inbound APIs clamp against `totalCount`, so a rebased index resolves to the last
     * row every time.
     */
    firstItemIndex?: number;
    emptyMessage?: React.ReactNode;
}

// ═══ The virtualiser's own components ═══════════════════════════════════════════
//
// Module-level, per rule 3 — a component identity that changes between renders makes the
// virtualiser remount the whole list. Everything they need arrives through `context`,
// which is `useMemo`'d in the body below and is therefore stable too.

interface VirtuosoCtx {
    minWidth: number;
    colGroup: React.ReactNode;
    onScroller(el: HTMLDivElement | null): void;
    handlers: RowHandlers;
    rowMeta(item: GridRow<unknown>): { navRow: number; height: number; className?: string };
}

const VirtuosoScroller = React.forwardRef<
    HTMLDivElement,
    React.ComponentProps<'div'> & { context?: VirtuosoCtx }
>(function VirtuosoScroller({ style, context, ...props }, ref) {
    // Virtuoso owns this element's ref and the grid needs the element too (to follow the
    // caret sideways, and to run the drag auto-scroll). So the two are MERGED rather than
    // one replacing the other — stealing virtuoso's ref breaks its own scrolling.
    const onScroller = context?.onScroller;
    const setRef = React.useCallback(
        (el: HTMLDivElement | null) => {
            if (typeof ref === 'function') ref(el);
            else if (ref) ref.current = el;
            onScroller?.(el);
        },
        [ref, onScroller],
    );
    return <div ref={setRef} {...props} className="outline-none" style={{ overflowX: 'auto', ...style }} />;
});

const VirtuosoTable = ({ style, children, context }: TableProps & { context?: VirtuosoCtx }) => (
    <table
        className="relative table-fixed text-xs"
        style={{
            ...style,
            width: '100%',
            minWidth: context?.minWidth,
            // LOAD-BEARING. See the header of this file.
            borderCollapse: 'separate',
            borderSpacing: 0,
        }}
    >
        {context?.colGroup}
        {children}
    </table>
);

const VirtuosoTableHead = React.forwardRef<
    HTMLTableSectionElement,
    React.ComponentProps<'thead'> & { context?: unknown }
>(function VirtuosoTableHead({ style, context: _ctx, ...props }, ref) {
    void _ctx;
    return <thead ref={ref} {...props} className="frozen-row bg-muted" style={{ ...style, zIndex: 20 }} />;
});

const VirtuosoTableRow = ({
    item, context, children, ...rest
}: ItemProps<GridRow<unknown>> & { context?: VirtuosoCtx }) => {
    const meta = context?.rowMeta(item);
    return (
        <TableRowShell
            {...rest}
            navRow={meta?.navRow ?? -1}
            height={meta?.height ?? 0}
            className={meta?.className}
            handlers={context!.handlers}
        >
            {children}
        </TableRowShell>
    );
};

const VIRTUOSO_COMPONENTS = {
    Scroller: VirtuosoScroller,
    Table: VirtuosoTable,
    TableHead: VirtuosoTableHead,
    TableRow: VirtuosoTableRow,
} as TableComponents<GridRow<unknown>, VirtuosoCtx>;

// ═══ The default cell editor ═══════════════════════════════════════════════════

function DefaultCellEditor({
    initialValue, align, onChange, onCommit,
}: {
    initialValue: string;
    align?: 'left' | 'right' | 'center';
    onChange(next: string): void;
    onCommit(): void;
}) {
    const ref = React.useRef<HTMLInputElement | null>(null);
    // The editor owns its text — see `TableEditorArgs`. It is keyed by cell, so a new
    // cell is a new component and this seed is read exactly once per edit session.
    const [value, setValue] = React.useState(initialValue);

    React.useEffect(() => {
        const el = ref.current;
        if (!el) return;
        // ALWAYS `preventScroll`. A bare `.focus()` is specified to scroll its target into
        // view with block AND inline "center" in every scrolling box up to the document,
        // so starting an edit would re-centre the row and drag the page with it.
        el.focus({ preventScroll: true });
        // Caret at the END, so a type-over character is not immediately replaced.
        const n = el.value.length;
        el.setSelectionRange(n, n);
    }, []);

    return (
        <input
            ref={ref}
            data-table-editor
            value={value}
            onChange={(e) => {
                setValue(e.target.value);
                onChange(e.target.value);
            }}
            onBlur={onCommit}
            className={cn(
                'absolute inset-0 size-full bg-background px-2 text-xs outline-none ring-2 ring-primary ring-inset',
                align === 'right' && 'text-right font-mono tabular-nums',
                align === 'center' && 'text-center',
            )}
        />
    );
}

// ═══ The table ══════════════════════════════════════════════════════════════════

export function BlackwoodTable<Row, Ctx>(props: BlackwoodTableProps<Row, Ctx>) {
    const {
        apiRef,
        items, kinds, specs, ctx, settings, onSettingsChange, edits, storedText, scope,
        rowKey, renderEditor: renderEditorProp, renderChromeRow, renderHeaderSlot,
        summaryRows, drafts,
        onAddDrafts, onRemoveDrafts, onRestoreDrafts, draftKind = 'draft', childKinds,
        contextMenuItems, disableDefaultContextMenu = false,
        rowClassFor, rowRules, onSelectionChange, onStateChange,
        className, startReached, endReached, initialTopMostItemIndex, firstItemIndex,
        emptyMessage, sizing = 'content',
    } = props;

    // The scope decides, unless the consumer says otherwise. See the two props.
    const sortEnabled = props.enableSort ?? scope === 'focus';
    const filterEnabled = props.enableFilter ?? scope === 'focus';

    // ── Column widths, resizable WHETHER OR NOT the consumer persists them ───────
    //
    // The handle used to appear only when a consumer passed `onSettingsChange`, so on
    // every grid that had not wired per-user settings yet the columns simply could not be
    // dragged — which is exactly what Renzo saw: *"Width adjustment also doesn't exist on
    // every table used."* It existed; it was gated behind a prop nine of ten screens had
    // not supplied.
    //
    // Resize is now DEFAULT-ON. With `onSettingsChange` the width is delegated exactly as
    // before (persisted, and this state stays empty and inert); without it the width lives
    // here for the session, so a column can always be widened to read a value. A spec that
    // says `resizable: false` still opts out — that verdict never moved.
    const [localWidths, setLocalWidths] = React.useState<Record<string, number>>({});

    // The identity matters: `useTableColumns` memoizes on the widths OBJECT, so handing it
    // a fresh `{}` per render would re-resolve the column table — and with it every sticky
    // offset — on every keystroke. Undefined while nothing has been dragged, which is what
    // keeps an unmanaged grid byte-identical with before this existed.
    const effectiveWidths = React.useMemo(() => {
        if (onSettingsChange || Object.keys(localWidths).length === 0) return settings?.widths;
        return { ...(settings?.widths ?? {}), ...localWidths };
    }, [onSettingsChange, settings?.widths, localWidths]);

    const effectiveSettings = React.useMemo<TableSettings | undefined>(() => {
        if (effectiveWidths === settings?.widths) return settings;
        return { ...settings, widths: effectiveWidths };
    }, [settings, effectiveWidths]);

    // ── Scrollers ────────────────────────────────────────────────────────────────
    //
    // Declared HERE, above the column resolution, because `sizing: 'fill'` measures the
    // scrollport and the column widths are resolved from that measurement — so the ref
    // and its reader have to exist before the resolution that consumes them.
    const plainScrollerRef = React.useRef<HTMLDivElement | null>(null);
    const virtuosoScrollerRef = React.useRef<HTMLDivElement | null>(null);
    const virtuosoRef = React.useRef<TableVirtuosoHandle>(null);

    const scrollerEl = React.useCallback(
        (): HTMLElement | null =>
            scope === 'endless' ? virtuosoScrollerRef.current : plainScrollerRef.current,
        [scope],
    );

    // ── `sizing: 'fill'` — the container width, measured rather than assumed ─────
    //
    // A PRIMITIVE in state, so the column memo compares by `===` and a resize that moved
    // nothing re-resolves nothing. Zero until it has been measured, and zero distributes
    // no slack — so the first paint is the declared widths and never a guess.
    const wrapRef = React.useRef<HTMLDivElement | null>(null);
    const [fillWidth, setFillWidth] = React.useState(0);
    // Bumped when the virtualiser hands over its scroller. The scroller does not exist on
    // the first commit, and its `clientWidth` is the only honest number — the wrapper's is
    // wider by the vertical scrollbar, which would buy a permanent horizontal one.
    const [scrollerTick, setScrollerTick] = React.useState(0);

    React.useEffect(() => {
        if (sizing !== 'fill') return;
        const el = wrapRef.current;
        if (!el) return;

        let raf = 0;
        const measure = () => {
            raf = 0;
            const w = scrollerEl()?.clientWidth || el.clientWidth;
            // Sub-pixel churn is not a resize. Without this guard the distribution and the
            // scrollbar can trade a pixel back and forth forever.
            setFillWidth((prev) => (Math.abs(prev - w) < 1 ? prev : w));
        };
        // rAF-throttled: a drag of the window edge fires the observer per frame, and each
        // one would otherwise re-resolve the column table synchronously.
        const ro = new ResizeObserver(() => {
            if (raf === 0) raf = requestAnimationFrame(measure);
        });
        ro.observe(el);
        measure();
        return () => {
            ro.disconnect();
            if (raf !== 0) cancelAnimationFrame(raf);
        };
        // `scrollerEl` is stable per scope. `scrollerTick` appears here and nowhere in the
        // body ON PURPOSE: it is the signal that the scroller now EXISTS, which is the one
        // thing a ResizeObserver on the wrapper cannot notice by itself.
    }, [sizing, scrollerEl, scrollerTick]);

    const columns = useTableColumns(
        specs,
        ctx,
        effectiveSettings,
        sizing === 'fill' ? fillWidth : undefined,
    );
    const cols = columns.cols;

    // ── SORT + FILTER — view state, and nothing but ──────────────────────────────
    //
    // It never mutates a row, never touches the URL and never reaches a query. A consumer
    // whose filters already live in search params keeps them; this is a second, local
    // axis, and `renderHeaderSlot` still hangs that consumer's own control beside these.
    const [sort, setSort] = React.useState<TableSort | null>(null);
    const [filters, setFilters] = React.useState<TableFilters>(NO_FILTERS);

    const activeSort = sortEnabled ? sort : null;
    const activeFilters = filterEnabled ? filters : NO_FILTERS;

    const view = React.useMemo(
        () =>
            applyTableView({
                items, kinds, cols,
                sort: activeSort,
                filters: activeFilters,
                childKinds, draftKind, storedText,
            }),
        [items, kinds, cols, activeSort, activeFilters, childKinds, draftKind, storedText],
    );

    // THE row array from here down. Identical to `items` when neither axis is on, so a
    // grid that never sorts pays one `Map` build and nothing else.
    const viewItems = view.items;
    const rows = useTableRows({ items: viewItems, kinds, cols });

    // One class table per column set, so the cache lives exactly as long as what it
    // describes. A `<td>`'s className is then a Map lookup rather than two `twMerge` calls.
    const classes = React.useMemo(() => createCellClassTable(rowRules), [rowRules]);

    const scrollToIndexFn = React.useCallback((index: number) => {
        // RAW array position — never `firstItemIndex + index`. Virtuoso offsets only the
        // index it reports OUT; both inbound scroll APIs clamp against `totalCount`, so a
        // rebased index resolves to the LAST row every time.
        virtuosoRef.current?.scrollIntoView({ index, behavior: 'auto' });
    }, []);

    // ── Invalid cells, owned here so no consumer keeps the bookkeeping ───────────
    const [invalidByRow, setInvalidByRow] =
        React.useState<ReadonlyMap<string, ReadonlySet<string>>>(EMPTY_INVALID);

    const handleInvalid = React.useCallback((rowId: string, colKey: string, invalid: boolean) => {
        setInvalidByRow((prev) => {
            const current = prev.get(rowId);
            if ((current?.has(colKey) ?? false) === invalid) return prev; // no churn, no render
            const next = new Map(prev);
            const set = new Set(current ?? []);
            if (invalid) set.add(colKey);
            else set.delete(colKey);
            if (set.size === 0) next.delete(rowId);
            else next.set(rowId, set);
            return next;
        });
    }, []);

    // ── Context menu ─────────────────────────────────────────────────────────────
    //
    // The state, the viewport edge-flip and the close-on-outside/Escape all come from
    // `useGridContextMenu` — the shared primitive the older grids already use — rather
    // than from a third hand-rolled copy of the same 30 lines.
    const menu = useGridContextMenu<TableContextTarget<Row>>({ width: 200, height: 300 });
    const openMenu = menu.open;
    const closeMenu = menu.close;

    const onContextMenu = React.useCallback(
        (cell: CellAddress, e: React.MouseEvent) => {
            // The menu is UNIVERSAL now: it opens whether or not the consumer supplied
            // items of its own, because Copy / Select column / Clear selection are the
            // grid's own gestures and every sheet has them.
            if (disableDefaultContextMenu && !contextMenuItems) return;
            e.preventDefault();
            const nav = rows.navRows[cell.row];
            openMenu(
                {
                    cell,
                    rowId: nav?.rowId ?? null,
                    row: nav?.data ?? null,
                    kind: nav?.kind.kind ?? null,
                    close: () => closeMenu(),
                },
                e.clientX,
                e.clientY,
            );
        },
        [disableDefaultContextMenu, contextMenuItems, rows, openMenu, closeMenu],
    );

    // ── Interaction ──────────────────────────────────────────────────────────────
    const interaction = useTableInteraction<Row, Ctx>({
        rows,
        columns,
        ctx,
        edits,
        storedText,
        scrollerEl,
        scrollToIndex: scope === 'endless' ? scrollToIndexFn : undefined,
        canCreateRows: drafts?.enabled === true,
        onAddDrafts,
        onRemoveDrafts,
        onRestoreDrafts,
        draftKind,
        childKinds,
        onInvalid: handleInvalid,
        onContextMenu,
        onSelectionChange,
    });

    // Destructured, never held as one object: every one of these is individually stable,
    // and depending on the container would give `renderEditor` a new identity per render
    // and re-render every row of the sheet. See the structural rule in
    // `use-table-interaction.ts`.
    const {
        activeCell, isEditing, rowHandlers, editorInitialText, setEditorText, commitEdit,
        setActiveCell, scrollTo, scrollToCol, focus: focusGrid, menuActions,
    } = interaction;
    const {
        bandFor, rowEdgeFor, selectColumn, range: selectionRange,
        size: selectionSize, aggregates, clear: clearSelectionCells,
    } = interaction.selection;

    React.useEffect(() => {
        onStateChange?.({ activeCell, isEditing, selection: selectionRange });
    }, [onStateChange, activeCell, isEditing, selectionRange]);

    // ── A SORT OR A FILTER DROPS THE SELECTION ───────────────────────────────────
    //
    // The rectangle is in NAV-ROW coordinates, and re-sorting or filtering is exactly the
    // operation that changes which row each of those coordinates names. Keeping it would
    // leave a selection that LOOKS untouched pointing at four different rows — and a
    // Delete or a Fill down aimed at it would land on rows the operator never chose. So
    // the axis moving takes the selection with it, and the caret too.
    //
    // The first run is skipped: on mount there is nothing selected, and clearing anyway
    // would be a state write on every grid in the app for no reason.
    const viewRef = React.useRef<{ sort: TableSort | null; filters: TableFilters } | null>(null);
    React.useEffect(() => {
        const prev = viewRef.current;
        viewRef.current = { sort: activeSort, filters: activeFilters };
        if (prev === null) return;
        if (prev.sort === activeSort && prev.filters === activeFilters) return;
        clearSelectionCells();
        setActiveCell(null);
    }, [activeSort, activeFilters, clearSelectionCells, setActiveCell]);

    const toggleSort = React.useCallback((key: string) => {
        setSort((prev) => {
            const dir = nextSortDirection(prev?.key === key ? prev.dir : null);
            return dir === null ? null : { key, dir };
        });
    }, []);

    const setColumnFilter = React.useCallback((key: string, next: ColumnFilter | undefined) => {
        setFilters((prev) => {
            if (next === undefined) {
                if (prev[key] === undefined) return prev; // no churn, no re-filter
                const out = { ...prev };
                delete out[key];
                return out;
            }
            return { ...prev, [key]: next };
        });
    }, []);

    /** Put the sheet back exactly as the consumer built it — one control, both axes. */
    const clearView = React.useCallback(() => {
        setSort(null);
        setFilters(NO_FILTERS);
    }, []);

    // ── The floating summary pill, published by the TABLE itself ─────────────────
    //
    // `useTableInteraction` has always computed SUM / AVERAGE / COUNT / MIN / MAX over the
    // selected rectangle and then thrown them away, so every migrated grid showed a cell
    // COUNT where the live ledgers showed a total — and none of them could fix it, because
    // the rectangle is in nav-row coordinates the consumer does not own. Renzo: *"every
    // part of the app that uses the table should also universally use … the hover summary
    // (the one on the bottom right where it shows the summation/average/count of the
    // highlighted cells)."*
    //
    // So the table publishes them ITSELF, and a consumer wires nothing at all.
    //
    // The provider is OPTIONAL by construction (`useOptionalStatusBar`): the grid is
    // mountable outside the app shell — the dev playground is — and a shared primitive
    // that crashes a page over a missing ambient provider is not shared. Absent, this is
    // silently a no-op.
    const statusBar = useOptionalStatusBar();
    const setCellSelectionCount = statusBar?.setCellSelectionCount;
    const setCellAggregates = statusBar?.setCellAggregates;

    React.useEffect(() => {
        setCellSelectionCount?.(selectionSize);
        setCellAggregates?.(aggregates);
    }, [setCellSelectionCount, setCellAggregates, selectionSize, aggregates]);

    // Clearing is its OWN effect with only the two stable setters as dependencies, so it
    // runs on unmount and at no other time. Folding it into the cleanup above would fire a
    // "0 cells" between every two selections — a pill that flickers empty on every drag.
    React.useEffect(
        () => () => {
            setCellSelectionCount?.(0);
            setCellAggregates?.(null);
        },
        [setCellSelectionCount, setCellAggregates],
    );

    // ── The imperative surface ───────────────────────────────────────────────────
    //
    // Everything here is expressed over `rows.placeById` and `rows.cellAddressable`, i.e.
    // the ONE resolved row axis — never over an index the caller computed from `items`,
    // which would be a second definition of that axis.
    const activeCol = activeCell?.col ?? 0;

    React.useImperativeHandle(
        apiRef,
        (): BlackwoodTableApi => ({
            focus: focusGrid,
            setActiveCell,
            scrollToRow(rowId) {
                const place = rows.placeById.get(rowId);
                if (!place) return false;
                scrollTo(place.navRow);
                return true;
            },
            goToRow(rowId, colKey) {
                const place = rows.placeById.get(rowId);
                if (!place) return false;
                // The lane, in preference order: the one asked for, the one the caret is
                // already in, then the first this row actually occupies. A row family that
                // has no cell in the requested column must not leave the caret nowhere.
                //
                // Every candidate is tested with `cellAddressable`, NOT `cellExists`: this
                // method PLACES THE CARET, so it must obey the same rule the keyboard does.
                // Reading the render predicate here would park the caret on a cell no
                // arrow and no Tab run can ever reach — the same defect as a keyboard dead
                // stop, wearing the other hat, and reachable only through the API.
                const asked = colKey === undefined ? -1 : cols.findIndex((c) => c.key === colKey);
                const candidates = [asked, activeCol];
                let col = candidates.find((c) => c >= 0 && rows.cellAddressable(place.navRow, c)) ?? -1;
                if (col < 0) {
                    for (let c = 0; c < cols.length; c++) {
                        if (rows.cellAddressable(place.navRow, c)) { col = c; break; }
                    }
                }
                if (col < 0) return false;
                setActiveCell({ row: place.navRow, col });
                scrollTo(place.navRow);
                scrollToCol(col);
                focusGrid();
                return true;
            },
        }),
        [rows, cols, activeCol, focusGrid, setActiveCell, scrollTo, scrollToCol],
    );

    // ── The editor ───────────────────────────────────────────────────────────────
    const renderEditor = React.useCallback(
        (navRow: number, col: number): React.ReactNode => {
            const cell: CellAddress = { row: navRow, col };
            const spec = cols[col];
            const nav = rows.navRows[navRow];
            if (!spec || !nav) return null;
            const initialValue = editorInitialText();

            if (renderEditorProp) {
                return (
                    <React.Fragment key={`${nav.rowId}:${spec.key}`}>
                        {renderEditorProp({
                            cell,
                            spec,
                            row: nav.data,
                            rowId: nav.rowId,
                            ctx,
                            initialValue,
                            onChange: setEditorText,
                            commit: commitEdit,
                        })}
                    </React.Fragment>
                );
            }
            return (
                <DefaultCellEditor
                    key={`${nav.rowId}:${spec.key}`}
                    initialValue={initialValue}
                    align={spec.align}
                    onChange={setEditorText}
                    onCommit={commitEdit}
                />
            );
        },
        [cols, rows, ctx, editorInitialText, setEditorText, commitEdit, renderEditorProp],
    );

    // ── Column chrome ────────────────────────────────────────────────────────────
    const onResizeColumn = React.useCallback(
        (key: string, width: number) => {
            // Delegate when the consumer persists layout; otherwise keep it for the
            // session. One handler, two homes — a caller never has to know which.
            if (onSettingsChange) {
                onSettingsChange({ ...settings, widths: { ...(settings?.widths ?? {}), [key]: width } });
                return;
            }
            setLocalWidths((prev) => (prev[key] === width ? prev : { ...prev, [key]: width }));
        },
        [onSettingsChange, settings],
    );

    const colGroup = React.useMemo(
        () => (
            <colgroup>
                {cols.map((c) => (
                    <col key={c.key} style={{ width: c.width }} />
                ))}
            </colgroup>
        ),
        [cols],
    );

    const endStart = cols.length - columns.pinned.end;

    const headerRow = React.useMemo(
        () => (
            <tr>
                {cols.map((spec, i) => {
                    const pin = i < columns.pinned.start ? 'start' : i >= endStart ? 'end' : null;
                    return (
                        <HeaderCell
                            key={spec.key}
                            spec={spec}
                            index={i}
                            pin={pin}
                            edge={
                                (pin === 'start' && i === columns.pinned.start - 1) ||
                                (pin === 'end' && i === endStart)
                            }
                            left={pin === 'start' ? columns.pinnedLeft[i] : undefined}
                            right={pin === 'end' ? columns.pinnedRight[i - endStart] : undefined}
                            onSelectColumn={selectColumn}
                            // ALWAYS supplied — see `onResizeColumn`. `resizable: false`
                            // on the spec is still the way a column opts out.
                            onResize={onResizeColumn}
                            // The BUILT-IN sort and filter. `undefined` renders no control
                            // at all, which is what a scope with them off, or a column that
                            // opted out, resolves to — so a header that offers neither is
                            // byte-identical with before they existed.
                            sortDir={sort?.key === spec.key ? sort.dir : null}
                            onToggleSort={sortEnabled && columnSortable(spec) ? toggleSort : undefined}
                            filter={filters[spec.key]}
                            onFilterChange={
                                filterEnabled && columnFilterable(spec) ? setColumnFilter : undefined
                            }
                            // Bounds are offered only where there is a number to bound.
                            numericFilter={spec.numericValue !== undefined}
                            // The seam the consumer's own column-filter chrome needs. It
                            // renders BESIDE the two above, never instead of them.
                            filterSlot={renderHeaderSlot ? renderHeaderSlot(spec, i) : undefined}
                        />
                    );
                })}
            </tr>
        ),
        [
            cols, columns.pinned, columns.pinnedLeft, columns.pinnedRight, endStart,
            selectColumn, onResizeColumn, renderHeaderSlot,
            sort, filters, sortEnabled, filterEnabled, toggleSort, setColumnFilter,
        ],
    );

    const fixedHeaderContent = React.useCallback(() => headerRow, [headerRow]);

    // ── Summary rows ─────────────────────────────────────────────────────────────
    const summary = React.useMemo(() => {
        if (!summaryRows || summaryRows.length === 0) return null;
        const s = columns.spans;
        const base = 'border-b border-b-border border-r border-r-border/40 bg-muted px-2 py-1 text-[11px]';
        // A frozen surface that overlaps scrolling content is OPAQUE — `bg-muted`, never
        // a glass token.
        const stickyCell = (corner: boolean) =>
            corner ? 'frozen-corner-bottom frozen-edge frozen-edge-top' : 'frozen-row-bottom frozen-edge-top';

        return summaryRows.map((row) => (
            <tr key={row.key} className={row.className}>
                {/* A span of 0 renders NO cell at all — `colSpan={0}` means "to the end of
                    the column group" in HTML, which is the opposite of nothing. */}
                {s.frozen > 0 ? (
                    <th
                        colSpan={s.frozen}
                        scope="row"
                        className={cn(base, 'text-left font-medium', row.sticky && stickyCell(true))}
                        style={row.sticky ? { left: 0 } : undefined}
                    >
                        {row.label}
                    </th>
                ) : null}
                {s.spacer > 0 ? (
                    <td colSpan={s.spacer} className={cn(base, row.sticky && stickyCell(false))}>
                        {s.frozen === 0 ? row.label : null}
                    </td>
                ) : null}
                {s.weight > 0 ? (
                    <td
                        colSpan={s.weight}
                        className={cn(base, 'text-right font-mono tabular-nums', row.sticky && stickyCell(false))}
                    >
                        {row.figure}
                    </td>
                ) : null}
                {s.note > 0 ? (
                    <td colSpan={s.note} className={cn(base, row.sticky && stickyCell(false))}>
                        {row.note}
                    </td>
                ) : null}
                {s.total > 0 ? (
                    <td
                        colSpan={s.total}
                        className={cn(base, 'text-right font-mono tabular-nums', row.sticky && stickyCell(false))}
                    >
                        {row.total}
                    </td>
                ) : null}
                {s.trailing > 0 ? (
                    <td colSpan={s.trailing} className={cn(base, row.sticky && stickyCell(false))} />
                ) : null}
            </tr>
        ));
    }, [summaryRows, columns.spans]);

    const fixedFooterContent = React.useCallback(() => <>{summary}</>, [summary]);

    // ── Rows ─────────────────────────────────────────────────────────────────────

    /**
     * The lanes and the column table a chrome row tiles. Memoized because it is a
     * dependency of every row's content — a fresh object here re-renders the whole sheet.
     */
    const chromeApi = React.useMemo<TableChromeRowApi<Row, Ctx>>(
        () => ({ cols, spans: columns.spans, colCount: cols.length }),
        [cols, columns.spans],
    );

    /** Everything a row needs that is NOT static, resolved per item. */
    const cellsFor = React.useCallback(
        (item: GridRow<Row>, index: number): React.ReactNode => {
            const kind = kinds.get(item.kind);
            if (!kind) return null;

            // A NON-ADDRESSABLE row may render its own cells — a group heading, a
            // per-group rule-off. Asked here and nowhere else, and gated on `addressable`,
            // so an addressable row can never be replaced by chrome and the caret can never
            // be pointed at one. Returning null falls through to the ordinary cells, which
            // is what keeps "omit the prop" byte-identical with the behaviour before it.
            if (!kind.addressable && renderChromeRow) {
                const chrome = renderChromeRow(item, chromeApi);
                if (chrome !== null && chrome !== undefined) return chrome;
            }

            const navRow = rows.navIndexOfItem.get(index) ?? -1;
            const nav = navRow >= 0 ? rows.navRows[navRow] : undefined;
            const rowId = nav?.rowId ?? null;
            const onThisRow = navRow >= 0 && activeCell !== null && activeCell.row === navRow;
            return (
                <TableCells
                    navRow={navRow}
                    kind={kind}
                    data={nav?.data ?? null}
                    rowId={rowId ?? itemKey(item)}
                    cols={cols}
                    ctx={ctx}
                    // The singletons, per rule 4: `edits[id] ?? {}` allocates a fresh empty
                    // object per untouched row per render and defeats the memo in silence.
                    rowEdits={(rowId ? edits.edits[rowId] : undefined) ?? NO_EDITS}
                    activeCol={onThisRow ? activeCell.col : -1}
                    selectionBand={navRow >= 0 ? bandFor(navRow) : null}
                    // The other half of the selection box: which HORIZONTAL edges of the
                    // rectangle this row sits on. A primitive, so it crosses the row memo
                    // by `===`.
                    selectionRowEdge={navRow >= 0 ? rowEdgeFor(navRow) : 'none'}
                    invalidCols={(rowId ? invalidByRow.get(rowId) : undefined) ?? NO_INVALID}
                    editing={isEditing && onThisRow}
                    renderEditor={renderEditor}
                    pinnedLeft={columns.pinnedLeft}
                    pinnedRight={columns.pinnedRight}
                    classes={classes}
                />
            );
        },
        [
            kinds, rows, cols, ctx, edits.edits, activeCell, bandFor, rowEdgeFor, invalidByRow,
            isEditing, renderEditor, columns.pinnedLeft, columns.pinnedRight, classes,
            renderChromeRow, chromeApi,
        ],
    );

    // Position lookup, built once per `items` change. `Array.prototype.indexOf` per
    // visible row per render is ~30 linear scans of the whole window on every keystroke.
    const indexOfItem = React.useMemo(() => {
        const m = new Map<GridRow<Row>, number>();
        viewItems.forEach((it, i) => m.set(it, i));
        return m;
    }, [viewItems]);

    const itemContent = React.useCallback(
        (_index: number, item: GridRow<Row>) => {
            // The virtualiser reports a PUBLIC index (array position + `firstItemIndex`),
            // so it may not be used as an array position. The item itself is the key.
            const at = indexOfItem.get(item) ?? -1;
            return at >= 0 ? cellsFor(item, at) : null;
        },
        [indexOfItem, cellsFor],
    );

    const rowMeta = React.useCallback(
        (item: GridRow<unknown>) => {
            const typed = item as GridRow<Row>;
            const kind = kinds.get(typed.kind);
            const id = 'id' in typed ? typed.id : null;
            const place = id ? rows.placeById.get(id) : undefined;
            return {
                navRow: place?.navRow ?? -1,
                height: kind?.height ?? 0,
                className: rowClassFor?.(typed, place?.navRow ?? null),
            };
        },
        [kinds, rows, rowClassFor],
    );

    const onScroller = React.useCallback((el: HTMLDivElement | null) => {
        virtuosoScrollerRef.current = el;
        // `sizing: 'fill'` measures the SCROLLER, which does not exist on the first
        // commit. This is the one signal that it now does; the ResizeObserver on the
        // wrapper cannot notice a child appearing.
        if (el) setScrollerTick((n) => n + 1);
    }, []);

    const virtuosoContext = React.useMemo<VirtuosoCtx>(
        () => ({ minWidth: columns.minWidth, colGroup, onScroller, handlers: rowHandlers, rowMeta }),
        [columns.minWidth, colGroup, onScroller, rowHandlers, rowMeta],
    );

    // ── The built-in right-click menu ────────────────────────────────────────────
    //
    // The item LIST is `defaultTableMenu` — a pure function in `lib/table/menu.ts` of two
    // facts about the clicked cell — and this maps each action onto the interaction hook's
    // OWN callback. So "Copy" in the menu is the same function Ctrl/Cmd+C calls, and
    // there is no second definition of any gesture here.
    //
    // The mutating items (Clear contents / Paste / Fill down) are ABSENT, not disabled,
    // wherever the cell does not accept an edit — which is every cell of every read-only
    // grid, so switching the menu on for all of them cannot offer an action that would
    // silently do nothing.
    const menuTarget = menu.state?.ref ?? null;

    const defaultMenuItems = React.useMemo<GridMenuItem<TableContextTarget<Row>>[]>(() => {
        if (disableDefaultContextMenu || !menuTarget) return [];
        const { cell, rowId } = menuTarget;
        const spec = cols[cell.col];
        const nav = rows.navRows[cell.row];
        const slot = spec && nav ? nav.kind.occupies(spec.key, nav.data) : null;
        // BOTH halves of the verdict, exactly as `useTableInteraction` combines them:
        // the row family's `editable` AND the column's `columnAcceptsEdit`.
        const editable =
            slot !== null && slot.editable && spec !== undefined
                ? columnAcceptsEdit(spec, nav?.data ?? null, ctx)
                : false;

        const run: Record<TableMenuAction, () => void> = {
            copy: menuActions.copy,
            'copy-with-headers': menuActions.copyWithHeaders,
            'copy-row': () => menuActions.copyRow(cell.row),
            'select-row': () => menuActions.selectRow(cell.row),
            'select-column': () => menuActions.selectColumn(cell.col),
            'clear-selection': menuActions.clearSelection,
            'clear-contents': menuActions.clearContents,
            paste: menuActions.paste,
            'fill-down': menuActions.fillDown,
        };

        const out: GridMenuItem<TableContextTarget<Row>>[] = [];
        for (const item of defaultTableMenu({
            editable,
            hasRow: rowId !== null,
            hasSelection: selectionSize > 1,
        })) {
            if (item.separatorBefore && out.length > 0) out.push({ kind: 'separator' });
            out.push({
                kind: 'item',
                label: item.label,
                trailingLabel: item.shortcut,
                onSelect: run[item.action],
            });
        }
        return out;
    }, [disableDefaultContextMenu, menuTarget, cols, rows, ctx, menuActions, selectionSize]);

    const consumerMenu = menuTarget && contextMenuItems ? contextMenuItems(menuTarget) : null;

    /**
     * Closing the menu HANDS THE CARET BACK.
     *
     * A menu item is unmounted by the time focus would be restored to it, so focus lands
     * on `<body>` and the next keystroke goes nowhere — the sheet reads as dead until
     * another cell is clicked. This is the same fix `apiRef.focus()` exists for, applied
     * to the grid's own menu so no consumer has to remember it.
     */
    const dismissMenu = React.useCallback(() => {
        closeMenu();
        focusGrid();
    }, [closeMenu, focusGrid]);

    // ── Draft pool control ───────────────────────────────────────────────────────
    const [addCount, setAddCount] = React.useState(String(drafts?.defaultCount ?? DEFAULT_DRAFT_ROWS));
    const draftControl =
        drafts?.enabled && onAddDrafts ? (
            <div
                data-grid-chrome
                className="flex shrink-0 items-center gap-2 border-t border-border bg-background/95 px-2 py-1 text-xs text-muted-foreground backdrop-blur supports-backdrop-filter:bg-background/60"
            >
                <span>Add</span>
                <input
                    type="number"
                    min={1}
                    max={500}
                    value={addCount}
                    aria-label="How many blank rows to add"
                    onChange={(e) => setAddCount(e.target.value)}
                    className="h-6 w-16 rounded border border-input bg-background px-1 text-right font-mono text-xs tabular-nums outline-none focus-visible:ring-1 focus-visible:ring-ring"
                />
                <span>more rows at the bottom</span>
                <button
                    type="button"
                    data-testid="add-rows"
                    onClick={() => onAddDrafts(clampDraftAdd(addCount))}
                    className="h-6 rounded border border-input px-2 text-xs transition-colors duration-150 hover:bg-muted"
                >
                    Add
                </button>
            </div>
        ) : null;

    // ── The view strip — what a sort or a filter is currently doing ──────────────
    //
    // Small, and only present while the view is transformed: a sheet nobody has sorted or
    // filtered looks exactly as it did. The count is the answer to the only question a
    // filter raises ("how much am I not looking at?"), and the Clear puts both axes back
    // in one click — a filter you cannot find the off switch for is a bug report.
    const sortedLabel = sort ? (cols.find((c) => c.key === sort.key)?.label ?? sort.key) : null;
    const viewStrip =
        view.filtered || (sortedLabel !== null && sortEnabled) ? (
            <div
                data-grid-chrome
                data-testid="table-view-strip"
                className="flex shrink-0 items-center gap-3 border-t border-border bg-background/95 px-2 py-1 text-[11px] text-muted-foreground backdrop-blur supports-backdrop-filter:bg-background/60"
            >
                {view.filtered ? (
                    <span data-testid="table-view-count">
                        <span className="font-mono tabular-nums">{view.matched}</span> of{' '}
                        <span className="font-mono tabular-nums">{view.total}</span> rows
                    </span>
                ) : null}
                {sortedLabel !== null && sortEnabled ? (
                    <span data-testid="table-view-sort">
                        sorted by {sortedLabel} {sort?.dir === 'asc' ? '↑' : '↓'}
                    </span>
                ) : null}
                <button
                    type="button"
                    data-testid="table-view-clear"
                    onClick={clearView}
                    className="h-5 rounded border border-input px-1.5 text-[11px] transition-colors duration-150 hover:bg-muted"
                >
                    Clear
                </button>
            </div>
        ) : null;

    // ── Render ───────────────────────────────────────────────────────────────────
    //
    // `'content'` is the shipped style, untouched. `'fill'` renders the table at the
    // EXACT pixel sum of its resolved widths — which, once the slack has been
    // distributed, is the container's own width. That is what stops `table-layout: fixed`
    // scaling the columns out from under the sticky offsets: there is no slack left for
    // it to scale into, and if there was none to distribute (every column pinned or
    // hand-sized) the table simply sizes to content rather than overlapping itself.
    const tableStyle: React.CSSProperties =
        sizing === 'fill'
            ? {
                  width: columns.minWidth,
                  minWidth: columns.minWidth,
                  borderCollapse: 'separate',
                  borderSpacing: 0,
              }
            : {
                  width: '100%',
                  minWidth: columns.minWidth,
                  borderCollapse: 'separate',
                  borderSpacing: 0,
              };

    return (
        <div ref={wrapRef} className={cn('flex min-h-0 flex-col', className)}>
            <div
                {...interaction.gridProps}
                data-blackwood-table
                className="relative min-h-0 flex-1 select-none outline-none"
            >
                <PasteSink {...interaction.sinkProps} />

                {viewItems.length === 0 && emptyMessage ? (
                    <div className="animate-fade-up flex h-full items-center justify-center p-6 text-sm text-muted-foreground">
                        {emptyMessage}
                    </div>
                ) : scope === 'endless' ? (
                    <TableVirtuoso
                        ref={virtuosoRef}
                        data={viewItems as GridRow<Row>[]}
                        context={virtuosoContext}
                        computeItemKey={computeItemKey}
                        initialTopMostItemIndex={initialTopMostItemIndex}
                        // The PUBLIC index base, and the ONLY place it is used. Nothing this
                        // component hands the virtualiser is rebased by it — see the prop.
                        firstItemIndex={firstItemIndex}
                        startReached={startReached}
                        endReached={endReached}
                        increaseViewportBy={{ top: 400, bottom: 400 }}
                        components={VIRTUOSO_COMPONENTS as TableComponents<GridRow<Row>, VirtuosoCtx>}
                        fixedHeaderContent={fixedHeaderContent}
                        fixedFooterContent={summary ? fixedFooterContent : undefined}
                        itemContent={itemContent}
                        style={{ height: '100%' }}
                    />
                ) : (
                    <div ref={plainScrollerRef} className="h-full overflow-auto">
                        <table className="relative table-fixed text-xs" style={tableStyle}>
                            {colGroup}
                            <thead className="frozen-row bg-muted" style={{ zIndex: 20 }}>
                                {headerRow}
                            </thead>
                            <tbody>
                                {viewItems.map((item, index) => {
                                    const meta = rowMeta(item as GridRow<unknown>);
                                    return (
                                        <TableRowShell
                                            key={rowKey ? rowKey(item, index) : itemKey(item)}
                                            navRow={meta.navRow}
                                            height={meta.height}
                                            className={meta.className}
                                            handlers={rowHandlers}
                                        >
                                            {cellsFor(item, index)}
                                        </TableRowShell>
                                    );
                                })}
                            </tbody>
                            {summary ? (
                                <tfoot className="frozen-row-bottom" style={{ zIndex: 20 }}>
                                    {summary}
                                </tfoot>
                            ) : null}
                        </table>
                    </div>
                )}
            </div>

            {viewStrip}
            {draftControl}

            <GridContextMenu
                state={menu.state}
                items={defaultMenuItems}
                onClose={dismissMenu}
                containerProps={{
                    // Kept from the hand-rolled menu this replaced: `data-grid-chrome` is
                    // what tells the grid a keystroke or a paste aimed at the menu is the
                    // menu's business, and the other two are the hooks tests and older
                    // consumers already address it by.
                    'data-table-context-menu': true,
                    'data-grid-chrome': true,
                    role: 'menu',
                }}
            >
                {consumerMenu}
            </GridContextMenu>
        </div>
    );
}
