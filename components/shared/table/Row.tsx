'use client';

import * as React from 'react';

import type { ColumnSpec, FieldEdits, RowKind } from '@/lib/table';
import type { CellClassTable } from './cell-classes';

// ─────────────────────────────────────────────────────────────────────────────────
// TableRow — THE render boundary. PLATFORM LAYER.
//
// This one component is roughly 90% of the performance fix, and the reason it exists is
// measured rather than theoretical. The grid this module replaces was a single
// ~3,780-line component with **zero `React.memo` in 5,494 lines**, so a keystroke
// re-rendered every mounted cell: ~900 `<td>` in the virtualised view and **4,086 on a
// busy month** — 40–110ms of work to show one character in one input. Virtualisation
// bounded the DOM; it did not bound the WORK.
//
// A memo is only worth having if its props can actually be equal, so every prop here is
// a primitive, a stable reference, or an object that changes exactly when this row's
// appearance changes:
//
//   • `rowEdits` — this row's unsaved fields, or the shared `NO_EDITS` singleton. Passing
//     `edits[id] ?? {}` would allocate a fresh empty object per untouched row per render
//     and defeat the memo silently, which is why the singleton is exported and used.
//   • `handlers` — ONE stable bundle for the whole table. Handlers are attached per ROW
//     and dispatch by `data-col`, so a row of 18 cells creates 3 closures instead of 72.
//   • `classes` — the memoized class table (`cell-classes.ts`), so a `<td>`'s className
//     is a cache lookup rather than two `twMerge` calls.
//
// What must NOT be passed: anything derived from the whole edit map (a `Set` rebuilt each
// render), anything from the selection that changes on every caret move, or an inline
// arrow. Any one of those re-renders every row and the memo becomes a lie that costs a
// comparison.
// ─────────────────────────────────────────────────────────────────────────────────

/** The shared empty edit map. Passing a fresh `{}` per row would defeat the memo. */
export const NO_EDITS: FieldEdits = Object.freeze({});

/**
 * The one handler bundle, created once per table. Every cell event carries its column
 * index in `data-col`, so the row needs no per-cell closures.
 */
export interface RowHandlers {
    onCellMouseDown(row: number, col: number, e: React.MouseEvent): void;
    onCellMouseEnter(row: number, col: number): void;
    onCellDoubleClick(row: number, col: number, e: React.MouseEvent): void;
    onCellContextMenu(row: number, col: number, e: React.MouseEvent): void;
}

export interface TableRowProps<Row, Ctx> {
    /** Index in the NAV row space — what the keyboard and selection address. */
    navRow: number;
    /** The row's family. Decides its height, its rule, and which cells it has. */
    kind: RowKind<Row>;
    /** The stored row, or null for a draft. */
    data: Row | null;
    /** Stable id — the row's own, or the draft's. */
    rowId: string;
    cols: readonly ColumnSpec<Row, Ctx>[];
    ctx: Ctx;
    /** This row's unsaved fields, or `NO_EDITS`. */
    rowEdits: FieldEdits;
    /** The caret's column when it is on THIS row, else -1. */
    activeCol: number;
    /** `[fromCol, toCol]` of the selection band on THIS row, or null. */
    selectionBand: readonly [number, number] | null;
    /** Column keys refused at commit on this row. Usually the frozen empty set. */
    invalidCols: ReadonlySet<string>;
    /** Is an editor mounted on the active cell? */
    editing: boolean;
    /** Renders the editor for the active cell. Stable. */
    renderEditor: (navRow: number, col: number) => React.ReactNode;
    /** Cumulative `left` px for start-pinned columns. */
    pinnedLeft: readonly number[];
    /** Cumulative `right` px for end-pinned columns, in column order. */
    pinnedRight: readonly number[];
    handlers: RowHandlers;
    classes: CellClassTable;
    /** Extra classes for the `<tr>` — a status rail, a duplicate wash. */
    rowClass?: string;
}

/** The shared empty set, for the same reason as `NO_EDITS`. */
export const NO_INVALID: ReadonlySet<string> = Object.freeze(new Set<string>()) as ReadonlySet<string>;

/**
 * The `<tr>` — and ONLY the `<tr>`.
 *
 * Split out of `TableRow` (2026-08-17) because **`TableVirtuoso` owns the row element
 * too**: it puts `data-index` / `data-known-size` / its own `style` on the `<tr>` and
 * measures the rows by reading them back off `<tbody>`'s children. A component that
 * renders its own `<tr>` cannot receive those, so the endless scope would either lose
 * measurement or grow a second copy of the cell markup. The shell takes the virtualiser's
 * props through `...rest`; the cells are `children`, so there is exactly one definition of
 * each and both scopes use both.
 *
 * The handlers live HERE, on the row, and dispatch by `data-col` — 4 closures per row
 * instead of 4 per cell.
 */
export interface TableRowShellProps extends React.HTMLAttributes<HTMLTableRowElement> {
    navRow: number;
    height: number;
    handlers: RowHandlers;
}

export function TableRowShell({
    navRow, height, handlers, children, style, ...rest
}: TableRowShellProps) {
    return (
        <tr
            {...rest}
            data-nav-row={navRow}
            // Height last: a virtualiser's own `style` must never decide a row's height,
            // because the row family already declared it and virtuoso measures what it
            // finds rather than the other way round.
            style={{ ...style, height }}
            onMouseDown={(e) => {
                const col = colOf(e);
                if (col !== null) handlers.onCellMouseDown(navRow, col, e);
            }}
            onMouseOver={(e) => {
                const col = colOf(e);
                if (col !== null) handlers.onCellMouseEnter(navRow, col);
            }}
            onDoubleClick={(e) => {
                const col = colOf(e);
                if (col !== null) handlers.onCellDoubleClick(navRow, col, e);
            }}
            onContextMenu={(e) => {
                const col = colOf(e);
                if (col !== null) handlers.onCellContextMenu(navRow, col, e);
            }}
        >
            {children}
        </tr>
    );
}

/** Everything `TableCells` needs — `TableRowProps` minus the `<tr>`'s own concerns. */
export type TableCellsProps<Row, Ctx> = Omit<TableRowProps<Row, Ctx>, 'handlers' | 'rowClass'>;

function TableCellsInner<Row, Ctx>(props: TableCellsProps<Row, Ctx>) {
    const {
        navRow, kind, data, cols, ctx, rowEdits, activeCol, selectionBand,
        invalidCols, editing, renderEditor, pinnedLeft, pinnedRight, classes,
    } = props;

    const startCount = pinnedLeft.length;
    const endStart = cols.length - pinnedRight.length;

    return (
        <>
            {cols.map((col, i) => {
                const slot = kind.occupies(col.key, data);
                const exists = slot !== null;
                const isActive = activeCol === i;
                const selected =
                    exists && selectionBand !== null && i >= selectionBand[0] && i <= selectionBand[1];
                const pin = i < startCount ? 'start' : i >= endStart ? 'end' : null;

                const cls = classes.get({
                    pin,
                    // The seam sits on the LAST start-pinned column and the FIRST
                    // end-pinned one — the two boundaries with scrolling content.
                    edge: (pin === 'start' && i === startCount - 1) || (pin === 'end' && i === endStart),
                    rowKind: kind.kind,
                    exists,
                    active: isActive,
                    selected,
                    invalid: exists && invalidCols.has(col.key),
                    dirty: exists && slot !== null && rowEdits[slot.field] !== undefined,
                    numeric: col.align === 'right',
                    editable: exists && slot.editable,
                });

                const style: React.CSSProperties = { height: kind.height };
                if (pin === 'start') style.left = pinnedLeft[i];
                else if (pin === 'end') style.right = pinnedRight[i - endStart];

                return (
                    <td key={col.key} data-col={i} className={cls.td} style={style}>
                        {isActive && editing ? (
                            <div className="absolute inset-0">{renderEditor(navRow, i)}</div>
                        ) : (
                            <div className={cls.inner}>
                                {/* An UNSAVED value is what the cell shows. `format` renders
                                    the STORED row, so without this a cell would keep showing
                                    the old figure after a commit and the whole sheet would
                                    read as broken — the amber dirty tint would be the only
                                    sign anything had been typed at all. A consumer that
                                    wants the typed text formatted (a formula's result, say)
                                    does it in its own editor and its own `format`. */}
                                {slot !== null && rowEdits[slot.field] !== undefined
                                    ? rowEdits[slot.field]
                                    : exists && data !== null
                                      ? col.format(data, ctx)
                                      : null}
                            </div>
                        )}
                    </td>
                );
            })}
        </>
    );
}

/** Read the column index off the `<td>` an event passed through. */
function colOf(e: React.MouseEvent): number | null {
    const td = (e.target as HTMLElement | null)?.closest?.('td');
    const raw = td?.getAttribute('data-col');
    if (raw === null || raw === undefined) return null;
    const n = Number.parseInt(raw, 10);
    return Number.isFinite(n) ? n : null;
}

/**
 * THE memo boundary — memoized on a shallow prop compare, with the one collection prop
 * compared by content because it is rebuilt per render by its owner.
 *
 * It sits on the CELLS rather than on the `<tr>` so that both scopes can share it: the
 * plain table wraps it in a `TableRowShell`, and `TableVirtuoso` renders the shell itself
 * (it owns the row element) with this as its `itemContent`. Either way an untouched row's
 * props are referentially equal and its ~18 `<td>` are not rebuilt.
 *
 * `React.memo` loses the generic signature, so it is re-asserted through a cast — the
 * standard workaround, and the alternative (dropping the generics) would push `any` into
 * every consumer's column specs.
 */
export const TableCells = React.memo(TableCellsInner, (a, b) => {
    if (
        a.navRow !== b.navRow ||
        a.data !== b.data ||
        a.rowId !== b.rowId ||
        a.kind !== b.kind ||
        a.cols !== b.cols ||
        a.ctx !== b.ctx ||
        a.rowEdits !== b.rowEdits ||
        a.activeCol !== b.activeCol ||
        a.editing !== b.editing ||
        a.invalidCols !== b.invalidCols ||
        a.classes !== b.classes ||
        a.pinnedLeft !== b.pinnedLeft ||
        a.pinnedRight !== b.pinnedRight ||
        a.renderEditor !== b.renderEditor
    ) {
        return false;
    }
    // The band is a fresh tuple each render; compare it by value or no row is ever equal.
    const x = a.selectionBand;
    const y = b.selectionBand;
    if (x === y) return true;
    if (x === null || y === null) return false;
    return x[0] === y[0] && x[1] === y[1];
}) as <Row, Ctx>(props: TableCellsProps<Row, Ctx>) => React.ReactElement;

/**
 * A whole row — the shell plus the memoized cells. What a NON-virtualised table renders.
 *
 * The external API is unchanged from the single-component version; only the seam is new.
 */
export function TableRow<Row, Ctx>(props: TableRowProps<Row, Ctx>) {
    const { handlers, rowClass, ...cells } = props;
    return (
        <TableRowShell
            navRow={props.navRow}
            height={props.kind.height}
            handlers={handlers}
            className={rowClass}
        >
            <TableCells {...cells} />
        </TableRowShell>
    );
}
