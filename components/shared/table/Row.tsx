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

function TableRowInner<Row, Ctx>(props: TableRowProps<Row, Ctx>) {
    const {
        navRow, kind, data, cols, ctx, rowEdits, activeCol, selectionBand,
        invalidCols, editing, renderEditor, pinnedLeft, pinnedRight,
        handlers, classes, rowClass,
    } = props;

    const startCount = pinnedLeft.length;
    const endStart = cols.length - pinnedRight.length;

    return (
        <tr
            className={rowClass}
            style={{ height: kind.height }}
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
                                {exists && data !== null ? col.format(data, ctx) : null}
                            </div>
                        )}
                    </td>
                );
            })}
        </tr>
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
 * Memoized on a shallow prop compare, with the two collection props compared by content
 * because they are rebuilt per render by their owners.
 *
 * `React.memo` loses the generic signature, so it is re-asserted through a cast — the
 * standard workaround, and the alternative (dropping the generics) would push `any` into
 * every consumer's column specs.
 */
export const TableRow = React.memo(TableRowInner, (a, b) => {
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
        a.handlers !== b.handlers ||
        a.classes !== b.classes ||
        a.rowClass !== b.rowClass ||
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
}) as <Row, Ctx>(props: TableRowProps<Row, Ctx>) => React.ReactElement;
