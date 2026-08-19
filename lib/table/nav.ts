// ─────────────────────────────────────────────────────────────────────────────────
// Blackwood Table — the jump gestures. PLATFORM LAYER, pure, no React.
//
// Ctrl/Cmd+Arrow, Home/End, Ctrl+Home/End and PageUp/PageDown: the four things that make
// a big sheet navigable by keyboard, and the four the grid this came from did not have
// at all. `NAV_KEYS` matched before any modifier was tested, so Ctrl+Arrow behaved as a
// plain arrow — every one of these gestures silently did something else.
//
// All of it is expressed as pure index maths over two injected probes, so the same
// functions serve a virtualised endless sheet and a plain month table, and so they can
// be asserted without a DOM:
//
//   • `exists(row, col)` — does the row HAVE that cell? (a child row does not have every
//     column; see `RowKind.occupies`)
//   • `filled(row, col)` — does it hold a value? This is what makes Ctrl+Arrow jump to
//     the edge of a data BLOCK rather than to the edge of the sheet, which is the whole
//     behaviour people mean when they press it.
// ─────────────────────────────────────────────────────────────────────────────────

import type { CellAddress } from './types';

export interface JumpGrid {
    rowCount: number;
    colCount: number;
    /** Does an addressable cell exist at this coordinate? */
    exists(row: number, col: number): boolean;
    /** Does that cell hold a value? Only consulted where `exists` is true. */
    filled(row: number, col: number): boolean;
}

export type JumpDir = 'up' | 'down' | 'left' | 'right';

const STEP: Record<JumpDir, { dr: number; dc: number }> = {
    up: { dr: -1, dc: 0 },
    down: { dr: 1, dc: 0 },
    left: { dr: 0, dc: -1 },
    right: { dr: 0, dc: 1 },
};

/**
 * Ctrl/Cmd+Arrow — jump to the edge of the current data block.
 *
 * Sheets' actual rule, which is subtler than "go to the last row":
 *   • standing on a FILLED cell with a filled neighbour → run to the LAST filled cell
 *     before the next gap;
 *   • standing on a filled cell at the edge of its block (next cell blank) → skip the
 *     gap and land on the NEXT filled cell;
 *   • standing on a BLANK cell → land on the next filled cell;
 *   • nothing filled that way → the last existing cell in that direction.
 *
 * Returns null when the caret is already there, so a jump that owes nothing is a no-op
 * rather than a re-render.
 */
export function edgeJump(grid: JumpGrid, from: CellAddress, dir: JumpDir): CellAddress | null {
    const { dr, dc } = STEP[dir];

    const inBounds = (r: number, c: number) =>
        r >= 0 && r < grid.rowCount && c >= 0 && c < grid.colCount;

    // The next addressable cell in this direction, skipping coordinates the row does not
    // have (a child row's missing columns must not stop a vertical run).
    const next = (r: number, c: number): CellAddress | null => {
        let rr = r + dr;
        let cc = c + dc;
        while (inBounds(rr, cc)) {
            if (grid.exists(rr, cc)) return { row: rr, col: cc };
            rr += dr;
            cc += dc;
        }
        return null;
    };

    const first = next(from.row, from.col);
    if (!first) return null;

    const startFilled = grid.exists(from.row, from.col) && grid.filled(from.row, from.col);
    const nextFilled = grid.filled(first.row, first.col);

    let cursor = first;
    let last = first;

    if (startFilled && nextFilled) {
        // Run to the last filled cell of this block.
        while (grid.filled(cursor.row, cursor.col)) {
            last = cursor;
            const step = next(cursor.row, cursor.col);
            if (!step) break;
            cursor = step;
        }
        return sameCell(last, from) ? null : last;
    }

    // Skip the gap: land on the next filled cell, or the far edge if there is none.
    while (!grid.filled(cursor.row, cursor.col)) {
        last = cursor;
        const step = next(cursor.row, cursor.col);
        if (!step) return sameCell(last, from) ? null : last;
        cursor = step;
    }
    return sameCell(cursor, from) ? null : cursor;
}

/**
 * Home / End — the first or last addressable cell of the current ROW.
 *
 * A row, not the sheet: with a pinned identity block on the left, "Home" meaning the row
 * ordinal column would put the caret somewhere it cannot type.
 */
export function rowEdge(grid: JumpGrid, from: CellAddress, edge: 'start' | 'end'): CellAddress | null {
    const range = edge === 'start'
        ? Array.from({ length: grid.colCount }, (_, i) => i)
        : Array.from({ length: grid.colCount }, (_, i) => grid.colCount - 1 - i);

    for (const col of range) {
        if (grid.exists(from.row, col)) {
            return col === from.col ? null : { row: from.row, col };
        }
    }
    return null;
}

/**
 * Ctrl+Home / Ctrl+End — the first or last addressable cell of the LOADED sheet.
 *
 * "Loaded" is doing real work in an endless keyset pager: `Ctrl+End` cannot mean "the
 * last row of history" without fetching to the end of time, so it means the last row
 * currently in the window. The caller is expected to say so in its help text.
 */
export function sheetCorner(grid: JumpGrid, corner: 'start' | 'end'): CellAddress | null {
    const rows = corner === 'start'
        ? Array.from({ length: grid.rowCount }, (_, i) => i)
        : Array.from({ length: grid.rowCount }, (_, i) => grid.rowCount - 1 - i);

    for (const row of rows) {
        for (let i = 0; i < grid.colCount; i++) {
            const col = corner === 'start' ? i : grid.colCount - 1 - i;
            if (grid.exists(row, col)) return { row, col };
        }
    }
    return null;
}

export interface PageJumpInput {
    /** Nav row heights, index-aligned with the rows. */
    rowHeights: readonly number[];
    /** The scroller's visible height. */
    viewportHeight: number;
    from: number;
    dir: 'up' | 'down';
}

/**
 * PageUp / PageDown — one viewport of rows, measured in real heights.
 *
 * Rows are not a uniform height (a child row is shorter, a group spacer is a full row),
 * so a page cannot be a row COUNT. It accumulates heights until the viewport is used up,
 * and always moves at least one row so the key is never a silent no-op at a boundary.
 */
export function pageJump(input: PageJumpInput): number {
    const { rowHeights, viewportHeight, from, dir } = input;
    if (rowHeights.length === 0) return from;

    const step = dir === 'down' ? 1 : -1;
    let used = 0;
    let row = from;

    while (true) {
        const nextRow = row + step;
        if (nextRow < 0 || nextRow >= rowHeights.length) break;
        used += rowHeights[nextRow] ?? 0;
        row = nextRow;
        if (used >= viewportHeight) break;
    }

    // Always move at least one row when there is one to move to.
    if (row === from) {
        const one = from + step;
        if (one >= 0 && one < rowHeights.length) return one;
    }
    return row;
}

function sameCell(a: CellAddress, b: CellAddress): boolean {
    return a.row === b.row && a.col === b.col;
}
