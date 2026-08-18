'use client';

import * as React from 'react';

import type { CellAddress, ColumnSpec, GridRow, RowKind } from '@/lib/table';
import type { NavMove, NavResolver } from '@/lib/hooks/use-grid-keyboard-nav';

// ─────────────────────────────────────────────────────────────────────────────────
// useTableRows — the ROW axis, resolved once. PLATFORM LAYER.
//
// The column hook answers "which columns are there and where do they sit"; this one
// answers the other half — "which rows can the caret land on, how tall is each rendered
// row, and **does this row have a cell in this column at all**".
//
// That last question is `RowKind.occupies()`, and it is the reason this hook exists
// rather than a `navRows.filter(...)` at each call site. A sheet with more than one row
// FAMILY (a record and its child sub-rows; a shift and its runs) has rows that disagree
// about which columns they have, and FOUR unrelated behaviours have to ask per cell:
//
//   • the keyboard steps OVER a coordinate the row does not have,
//   • a paste must not land on one (that was BUG-024 — a paste mapped block rows onto
//     nav rows by arithmetic, wrote a record's data into its child rows, and reported
//     success),
//   • the selection pill must not total one,
//   • the cell must paint no tint and offer no hit area.
//
// So `cellExists` / `cellAddressable` / `cellEditable` are computed HERE, once, and
// everything else reads them. Three predicates, one definition each.
//
// The middle one is the seam between the first bullet and the other three. `occupies()`
// used to answer "does this row RENDER content here" and "may the CARET land here" with a
// single value, so a column carrying a row ordinal or a database-computed total could
// either be blank or be a dead stop in every Tab run — and nothing else. A slot may now
// say `addressable: false`, which keeps the cell rendering, tinting, copying and
// selectable while the keyboard steps over it. It DEFAULTS to true, so a row family that
// never mentions it behaves exactly as it did before the field existed.
//
// The other load-bearing rule: **a non-addressable item never enters `navRows`.** A
// group spacer, a heading and a summary rule-off are real rows of the spreadsheet, but
// they are not coordinates — so the nav space is byte-identical with and without them
// and the caret cannot land on one by construction. `rowHeights`, by contrast, covers
// EVERY item, because virtualisation has to size the rows it is not allowed to visit.
// ─────────────────────────────────────────────────────────────────────────────────

/** One addressable row, as the keyboard and the selection see it. */
export interface NavRowEntry<Row> {
    /** Position in the `items` array — what a virtualiser scrolls to. */
    index: number;
    /** The row's family: its height, its bottom rule, and which cells it has. */
    kind: RowKind<Row>;
    /** The stored row, or null for a row that exists nowhere yet (a draft). */
    data: Row | null;
    /** Stable id — the key every edit, every journal entry and every save is filed under. */
    rowId: string;
}

export interface ResolvedRows<Row> {
    /** ONLY the addressable rows, in order. This is the keyboard's coordinate space. */
    navRows: NavRowEntry<Row>[];
    /** Height of EVERY item, index-aligned with `items` — virtuoso measures nothing. */
    rowHeights: number[];
    /** Height of every NAV row, index-aligned with `navRows` — what `pageJump` accumulates. */
    navRowHeights: number[];
    /** `items` index → nav row index. Absent for chrome rows, which have none. */
    navIndexOfItem: Map<number, number>;
    /** Nav row index → `items` index. The direction a scroll-to-row needs. */
    itemIndexOfNav: Map<number, number>;
    /** Row id → where it sits, so "go to row X" needs no scan. */
    placeById: Map<string, { navRow: number; index: number }>;
    /**
     * Does a cell exist at this coordinate? `false` means the row simply has no cell
     * there — not that it is empty, and not that it is read-only.
     *
     * **This is the RENDER question**, and it is what everything except the caret reads:
     * whether to paint content and a tint, whether a selection may cover it, whether a
     * paste may write it, whether the pill may total it.
     */
    cellExists(navRow: number, col: number): boolean;
    /**
     * May the CARET land at this coordinate?
     *
     * The narrower twin of `cellExists`, and the only predicate the keyboard reads. A
     * slot that omits `addressable` defaults to true, so on a table where nothing declares
     * it this function is byte-identical with `cellExists` — which is exactly what makes
     * the seam additive.
     *
     * Where they differ is a cell with CONTENT and no keyboard business: a row ordinal, a
     * database-computed total, a derived status badge. It renders, it copies, it can be
     * swept into a selection — and a Tab run walks past it instead of stopping there.
     */
    cellAddressable(navRow: number, col: number): boolean;
    /**
     * May this cell be edited, as far as the ROW FAMILY is concerned? The column has its
     * own say — see `columnAcceptsEdit`, which is the other half and is combined with
     * this one in exactly one place (`use-table-interaction`).
     */
    cellEditable(navRow: number, col: number): boolean;
    /**
     * Item kinds that are not in the `kinds` map. A programming error, surfaced rather
     * than swallowed: such an item is NOT addressable (fail-closed — the caret may not
     * land on a row nobody described) and is measured as zero-height.
     */
    unknownKinds: string[];
}

/**
 * Read a row's id. Chrome rows (`spacer` / `group-header` / `summary`) carry a `key`
 * instead and have no id, because nothing is ever filed against them.
 */
function itemId<Row>(item: GridRow<Row>): string | null {
    return 'id' in item ? item.id : null;
}

/** Read a row's stored data. A draft and every chrome row have none. */
function itemData<Row>(item: GridRow<Row>): Row | null {
    return 'data' in item ? (item.data as Row) : null;
}

/**
 * The whole row resolution, as a PURE function.
 *
 * The hook below is `useMemo(resolveRows)` and nothing else — deliberately, and for the
 * same reason as `resolveColumns`: a test of this function is a test of the hook,
 * without a renderer. Writing the body twice would be a second definition of the row
 * axis, which is precisely the failure this module exists to prevent.
 *
 * `items` is expected to be ALREADY FLAT — the consumer interleaves its children and its
 * chrome rows, because only the consumer knows what order they belong in. A `children`
 * array left on an item is ignored rather than expanded, so a consumer that flattened
 * and forgot to clear it cannot render its child rows twice.
 */
export function resolveRows<Row, Ctx>(input: {
    items: readonly GridRow<Row>[];
    kinds: ReadonlyMap<string, RowKind<Row>>;
    cols: readonly ColumnSpec<Row, Ctx>[];
}): ResolvedRows<Row> {
    const { items, kinds, cols } = input;

    const navRows: NavRowEntry<Row>[] = [];
    const rowHeights: number[] = [];
    const navRowHeights: number[] = [];
    const navIndexOfItem = new Map<number, number>();
    const itemIndexOfNav = new Map<number, number>();
    const placeById = new Map<string, { navRow: number; index: number }>();
    const unknown = new Set<string>();

    for (let index = 0; index < items.length; index++) {
        const item = items[index];
        const kind = kinds.get(item.kind);

        if (!kind) {
            unknown.add(item.kind);
            rowHeights.push(0);
            continue;
        }

        rowHeights.push(kind.height);
        if (!kind.addressable) continue;

        const navRow = navRows.length;
        // A row that can be addressed must be identifiable: every edit, every journal
        // entry and every save verdict is filed under this id. An addressable row with
        // no id would be a cell nobody could write to, so it falls back to its position
        // rather than colliding with another row's edits under `''`.
        const rowId = itemId(item) ?? `${item.kind}:${index}`;

        navRows.push({ index, kind, data: itemData(item), rowId });
        navRowHeights.push(kind.height);
        navIndexOfItem.set(index, navRow);
        itemIndexOfNav.set(navRow, index);
        placeById.set(rowId, { navRow, index });
    }

    const slotAt = (navRow: number, col: number) => {
        const nav = navRows[navRow];
        const spec = cols[col];
        if (!nav || !spec) return null;
        return nav.kind.occupies(spec.key, nav.data);
    };

    return {
        navRows,
        rowHeights,
        navRowHeights,
        navIndexOfItem,
        itemIndexOfNav,
        placeById,
        cellExists: (navRow, col) => slotAt(navRow, col) !== null,
        // `!== false`, never `=== true`: the field is OPTIONAL and its default is true, so
        // a slot that never mentions it must answer exactly as `cellExists` does.
        cellAddressable: (navRow, col) => {
            const slot = slotAt(navRow, col);
            return slot !== null && slot.addressable !== false;
        },
        cellEditable: (navRow, col) => slotAt(navRow, col)?.editable === true,
        unknownKinds: [...unknown],
    };
}

export function useTableRows<Row, Ctx>(input: {
    items: readonly GridRow<Row>[];
    kinds: ReadonlyMap<string, RowKind<Row>>;
    cols: readonly ColumnSpec<Row, Ctx>[];
}): ResolvedRows<Row> {
    const { items, kinds, cols } = input;
    return React.useMemo(() => resolveRows({ items, kinds, cols }), [items, kinds, cols]);
}

// ═══ The column's half of two verdicts the row also has a say in ════════════════

/**
 * May this COLUMN be edited, for this row, in this context?
 *
 * The row family's answer is `ResolvedRows.cellEditable`; this is the column's. They are
 * genuinely different questions — "a child row has no weight cell" versus "nobody may
 * retype a database-computed total" — and they are combined in exactly ONE place so
 * neither can be forgotten at a call site.
 *
 * A column with no `parse` is read-only by construction: there is nothing that could
 * turn typed text into a patch, so an editor on it could only ever discard what it
 * collected. That is what makes `parse` the default answer rather than `true`.
 */
export function columnAcceptsEdit<Row, Ctx>(
    spec: ColumnSpec<Row, Ctx>,
    row: Row | null,
    ctx: Ctx,
): boolean {
    if (spec.cellKind === 'readonly' || spec.cellKind === 'derived') return false;
    if (spec.editable) return spec.editable(row, ctx);
    return spec.parse !== undefined;
}

/**
 * May a rectangular selection cover this column?
 *
 * Defaults to "yes unless the column is a pure ornament". Setting `selectable: true` on
 * a read-only column is deliberate and useful — a run of computed totals is the most
 * useful thing on a sheet to add up — while a row ordinal has no arithmetic meaning and
 * is the one thing Ctrl/Cmd+A must not sweep in.
 */
export function columnSelectable<Row, Ctx>(spec: ColumnSpec<Row, Ctx>): boolean {
    if (spec.selectable !== undefined) return spec.selectable;
    return spec.cellKind !== 'derived';
}

// ═══ The nav resolver — per CELL, never per column ══════════════════════════════

export interface TableNavGeometry {
    rowCount: number;
    colCount: number;
    /**
     * **May the caret land there? `ResolvedRows.cellAddressable` — deliberately NOT
     * `cellExists`.**
     *
     * The field is named for the question rather than for the predicate that used to
     * answer it, because feeding this the render predicate is a silent defect rather than
     * a type error: the sheet would still work, and a Tab run would simply acquire dead
     * stops on every content-bearing, caret-free column. Naming it `addressable` makes the
     * mis-wiring impossible to write by accident.
     */
    addressable(row: number, col: number): boolean;
    /** May it be edited? The two halves above, already combined. */
    editable(row: number, col: number): boolean;
}

/**
 * Target resolution for `useGridKeyboardNav`, asked **per cell**.
 *
 * `createCoordinateNavResolver`'s `columnMap` is per-COLUMN, which cannot express a sheet
 * whose row families disagree about which columns they have: it would let ArrowDown land
 * on a coordinate a child row does not occupy. Every branch here instead asks "is there
 * an addressable cell that way?" and returns `null` (stay put) when there is not.
 *
 * The behavioural consequence is exactly the asymmetry the data already has: ArrowDown in
 * a column only records occupy walks record-to-record, stepping over the children in
 * between, while ArrowDown in a shared column walks through every child.
 *
 * **This is the ONE reader of `cellAddressable`.** Every branch below places the caret, so
 * every branch asks the caret's own question — never the render one. A cell that exists
 * without being addressable is therefore invisible to the keyboard and fully present to
 * everything else.
 */
export function createTableNavResolver(geo: TableNavGeometry): NavResolver<CellAddress> {
    const { rowCount, colCount, addressable, editable } = geo;
    const lastCol = colCount - 1;

    const rowStep = (row: number, col: number, dir: 1 | -1): number | null => {
        for (let r = row + dir; r >= 0 && r < rowCount; r += dir) {
            if (addressable(r, col)) return r;
        }
        return null;
    };

    const colStep = (row: number, col: number, dir: 1 | -1): number | null => {
        for (let c = col + dir; c >= 0 && c < colCount; c += dir) {
            if (addressable(row, c)) return c;
        }
        return null;
    };

    /** Reading order: on across the row, then down to the next. Skips inert cells. */
    const tabStep = (from: CellAddress, dir: 1 | -1): CellAddress | null => {
        let { row, col } = from;
        // Bounded so a sheet where NOTHING is addressable cannot spin.
        const limit = rowCount * colCount + colCount + 1;
        for (let guard = 0; guard < limit; guard++) {
            col += dir;
            if (col > lastCol) {
                row += 1;
                col = 0;
            } else if (col < 0) {
                row -= 1;
                col = lastCol;
            }
            if (row < 0 || row >= rowCount) return null;
            if (addressable(row, col)) return { row, col };
        }
        return null;
    };

    return {
        resolve(from, move: NavMove) {
            if (move.kind === 'arrow') {
                if (move.dir === 'up' || move.dir === 'down') {
                    const r = rowStep(from.row, from.col, move.dir === 'down' ? 1 : -1);
                    return r === null ? null : { row: r, col: from.col };
                }
                const c = colStep(from.row, from.col, move.dir === 'right' ? 1 : -1);
                return c === null ? null : { row: from.row, col: c };
            }
            if (move.kind === 'enter') {
                const r = rowStep(from.row, from.col, move.shift ? -1 : 1);
                return r === null ? null : { row: r, col: from.col };
            }
            return tabStep(from, move.shift ? -1 : 1);
        },
        laneOf: (id) => id.col,
        resolveInRow(from, lane, dir) {
            const col = typeof lane === 'number' ? lane : from.col;
            const r = rowStep(from.row, col, dir);
            if (r !== null) return { row: r, col };
            // The Tab run's lane may not exist in the next row (a child row is narrower).
            // Falling back to the CURRENT column is what keeps Enter from becoming a
            // silent no-op there — the caret still advances, it just keeps its lane.
            const fallback = rowStep(from.row, from.col, dir);
            return fallback === null ? null : { row: fallback, col: from.col };
        },
        isEditable: (id) => editable(id.row, id.col),
    };
}
