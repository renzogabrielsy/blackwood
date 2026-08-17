'use client';

import * as React from 'react';
import { TableVirtuoso } from 'react-virtuoso';
import type { ItemProps, TableComponents, TableProps, TableVirtuosoHandle } from 'react-virtuoso';

import { cn } from '@/lib/utils';
import { clampDraftAdd, DEFAULT_DRAFT_ROWS } from '@/lib/table';
import type {
    CellAddress, ColumnSpec, GridRow, RowKind, SummarySpans, TableSettings,
} from '@/lib/table';
import { useTableColumns } from '@/lib/hooks/use-table-columns';
import { useTableRows } from '@/lib/hooks/use-table-rows';
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
// ── THE TWO SEAMS A BIDIRECTIONAL PAGER AND A GROUPED SHEET NEED ────────────────
//
//   • **`firstItemIndex`** is the virtualiser's PUBLIC index base. It rebases the index
//     reported OUT and NOTHING handed IN — `scrollIntoView` and `initialTopMostItemIndex`
//     still take RAW array positions, because both clamp against `totalCount` and a
//     rebased index would resolve to the last row every time. The consumer decrements it
//     by the ITEMS it prepended, in the same state batch as the prepend.
//   • **`renderChromeRow`** lets a NON-ADDRESSABLE row render its own cells — a group
//     heading, a per-group rule-off — where `summaryRows` can only reach the footer. It
//     returns CELLS and never a `<tr>`, because the virtualiser owns the row element.
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
    /** Right-click menu content. Returning null shows no menu. */
    contextMenuItems?(target: TableContextTarget<Row>): React.ReactNode;
    /** Extra classes for a `<tr>` — a status rail, a duplicate wash. Never a border. */
    rowClassFor?(item: GridRow<Row>, navRow: number | null): string | undefined;
    /** Row family → bottom-rule classes. Defaults to `DEFAULT_ROW_RULES`. */
    rowRules?: Record<string, string>;
    onSelectionChange?(range: CellRange | null): void;
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
        rowKey, renderEditor: renderEditorProp, renderChromeRow, summaryRows, drafts,
        onAddDrafts, onRemoveDrafts, onRestoreDrafts, draftKind = 'draft', childKinds,
        contextMenuItems, rowClassFor, rowRules, onSelectionChange, onStateChange,
        className, startReached, endReached, initialTopMostItemIndex, firstItemIndex,
        emptyMessage,
    } = props;

    const columns = useTableColumns(specs, ctx, settings);
    const cols = columns.cols;
    const rows = useTableRows({ items, kinds, cols });

    // One class table per column set, so the cache lives exactly as long as what it
    // describes. A `<td>`'s className is then a Map lookup rather than two `twMerge` calls.
    const classes = React.useMemo(() => createCellClassTable(rowRules), [rowRules]);

    // ── Scrollers ────────────────────────────────────────────────────────────────
    const plainScrollerRef = React.useRef<HTMLDivElement | null>(null);
    const virtuosoScrollerRef = React.useRef<HTMLDivElement | null>(null);
    const virtuosoRef = React.useRef<TableVirtuosoHandle>(null);

    const scrollerEl = React.useCallback(
        (): HTMLElement | null =>
            scope === 'endless' ? virtuosoScrollerRef.current : plainScrollerRef.current,
        [scope],
    );

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
    const [menu, setMenu] = React.useState<{ x: number; y: number; target: TableContextTarget<Row> } | null>(null);

    const onContextMenu = React.useCallback(
        (cell: CellAddress, e: React.MouseEvent) => {
            if (!contextMenuItems) return;
            e.preventDefault();
            const nav = rows.navRows[cell.row];
            setMenu({
                x: e.clientX,
                y: e.clientY,
                target: {
                    cell,
                    rowId: nav?.rowId ?? null,
                    row: nav?.data ?? null,
                    kind: nav?.kind.kind ?? null,
                    close: () => setMenu(null),
                },
            });
        },
        [contextMenuItems, rows],
    );

    React.useEffect(() => {
        if (!menu) return;
        const onDown = (e: PointerEvent) => {
            const el = e.target as HTMLElement | null;
            if (el?.closest?.('[data-table-context-menu]')) return;
            setMenu(null);
        };
        const onKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape') setMenu(null);
        };
        document.addEventListener('pointerdown', onDown);
        document.addEventListener('keydown', onKey);
        return () => {
            document.removeEventListener('pointerdown', onDown);
            document.removeEventListener('keydown', onKey);
        };
    }, [menu]);

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
        setActiveCell, scrollTo, scrollToCol, focus: focusGrid,
    } = interaction;
    const { bandFor, selectColumn, range: selectionRange } = interaction.selection;

    React.useEffect(() => {
        onStateChange?.({ activeCell, isEditing, selection: selectionRange });
    }, [onStateChange, activeCell, isEditing, selectionRange]);

    // ── The imperative surface ───────────────────────────────────────────────────
    //
    // Everything here is expressed over `rows.placeById` and `rows.cellExists`, i.e. the
    // ONE resolved row axis — never over an index the caller computed from `items`, which
    // would be a second definition of that axis.
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
                const asked = colKey === undefined ? -1 : cols.findIndex((c) => c.key === colKey);
                const candidates = [asked, activeCol];
                let col = candidates.find((c) => c >= 0 && rows.cellExists(place.navRow, c)) ?? -1;
                if (col < 0) {
                    for (let c = 0; c < cols.length; c++) {
                        if (rows.cellExists(place.navRow, c)) { col = c; break; }
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
            if (!onSettingsChange) return;
            onSettingsChange({ ...settings, widths: { ...(settings?.widths ?? {}), [key]: width } });
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
                            onResize={onSettingsChange ? onResizeColumn : undefined}
                        />
                    );
                })}
            </tr>
        ),
        [cols, columns.pinned, columns.pinnedLeft, columns.pinnedRight, endStart, selectColumn, onResizeColumn, onSettingsChange],
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
            kinds, rows, cols, ctx, edits.edits, activeCell, bandFor, invalidByRow,
            isEditing, renderEditor, columns.pinnedLeft, columns.pinnedRight, classes,
            renderChromeRow, chromeApi,
        ],
    );

    // Position lookup, built once per `items` change. `Array.prototype.indexOf` per
    // visible row per render is ~30 linear scans of the whole window on every keystroke.
    const indexOfItem = React.useMemo(() => {
        const m = new Map<GridRow<Row>, number>();
        items.forEach((it, i) => m.set(it, i));
        return m;
    }, [items]);

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
    }, []);

    const virtuosoContext = React.useMemo<VirtuosoCtx>(
        () => ({ minWidth: columns.minWidth, colGroup, onScroller, handlers: rowHandlers, rowMeta }),
        [columns.minWidth, colGroup, onScroller, rowHandlers, rowMeta],
    );

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

    // ── Render ───────────────────────────────────────────────────────────────────
    const tableStyle: React.CSSProperties = {
        width: '100%',
        minWidth: columns.minWidth,
        borderCollapse: 'separate',
        borderSpacing: 0,
    };

    return (
        <div className={cn('flex min-h-0 flex-col', className)}>
            <div
                {...interaction.gridProps}
                data-blackwood-table
                className="relative min-h-0 flex-1 select-none outline-none"
            >
                <PasteSink {...interaction.sinkProps} />

                {items.length === 0 && emptyMessage ? (
                    <div className="animate-fade-up flex h-full items-center justify-center p-6 text-sm text-muted-foreground">
                        {emptyMessage}
                    </div>
                ) : scope === 'endless' ? (
                    <TableVirtuoso
                        ref={virtuosoRef}
                        data={items as GridRow<Row>[]}
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
                                {items.map((item, index) => {
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

            {draftControl}

            {menu && contextMenuItems ? (
                <div
                    data-table-context-menu
                    data-grid-chrome
                    role="menu"
                    style={{ left: menu.x, top: menu.y }}
                    className="animate-fade-in fixed z-50 min-w-44 rounded-md border border-border bg-popover/95 p-1 text-xs shadow-md backdrop-blur-lg"
                >
                    {contextMenuItems(menu.target)}
                </div>
            ) : null}
        </div>
    );
}
