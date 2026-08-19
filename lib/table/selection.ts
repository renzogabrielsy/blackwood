// ─────────────────────────────────────────────────────────────────────────────────
// Blackwood Table — the SELECTION RECTANGLE's own geometry. PLATFORM LAYER, PURE.
//
// The module painted a selection with two states and nothing between them: `active`
// (a ring on ONE cell) and `selected` (a tint on the rest). So a swept block read as a
// wash with a ring in the corner it started from, and the border never grew — which is
// what Renzo saw and named: *"highlighting and selecting multiple cells keeps the border
// only on the first selected cell and never grows to the rest of the selection (only
// highlight does)… grow it into one big box surrounding the selected cells WITHOUT inner
// borders."*
//
// "One big box without inner borders" is not a property of the selection — it is a
// property of each CELL, and it is decidable per cell from two numbers and an index:
// a cell paints an edge exactly where the rectangle ends. So the whole thing is a pure
// function, computed here and painted in `components/shared/table/cell-classes.ts`,
// which is what keeps it out of a render-time `twMerge`.
//
// Two rules are baked in rather than left to the caller, because both are the difference
// between "a box" and "a mess":
//
//   • **A 1×1 selection paints NO box.** The caret already carries a ring, and a ring
//     inside a border on the same cell is two rectangles a pixel apart. A single-cell
//     selection is therefore byte-identical with the behaviour before this file existed.
//   • **The row's edges are decided ONCE per row, not per cell.** `rangeRowEdge` is a
//     primitive (a string), so it can ride through the row memo by `===` — an object per
//     row per render would defeat the memo silently, which is the one failure this module
//     keeps having to prevent.
// ─────────────────────────────────────────────────────────────────────────────────

/**
 * Where a nav row sits in the selection rectangle, vertically.
 *
 * A STRING rather than a pair of booleans on purpose: it crosses the row memo boundary,
 * and a primitive compares by `===` where an object would need a custom comparator or
 * would compare unequal on every render.
 */
export type SelectionRowEdge = 'none' | 'top' | 'middle' | 'bottom' | 'both';

/** The four edges one cell paints. All false ⇒ the cell is interior, or not selected. */
export interface CellRangeEdges {
    top: boolean;
    right: boolean;
    bottom: boolean;
    left: boolean;
}

/** Nothing to paint — the shared instance, so an interior cell allocates nothing. */
export const NO_RANGE_EDGES: CellRangeEdges = Object.freeze({
    top: false,
    right: false,
    bottom: false,
    left: false,
});

/**
 * Which horizontal edges of the rectangle this nav row is on.
 *
 * `'both'` is a one-row selection (top AND bottom), `'middle'` is a row with a rectangle
 * above and below it, `'none'` means the row is outside the selection entirely.
 */
export function rangeRowEdge(startRow: number, endRow: number, navRow: number): SelectionRowEdge {
    if (navRow < startRow || navRow > endRow) return 'none';
    const top = navRow === startRow;
    const bottom = navRow === endRow;
    if (top && bottom) return 'both';
    if (top) return 'top';
    if (bottom) return 'bottom';
    return 'middle';
}

/**
 * The edges ONE cell paints, given its row's vertical position in the rectangle and the
 * rectangle's column bounds.
 *
 * **Interior cells return `NO_RANGE_EDGES`** — that is the "without inner borders" half,
 * and it is structural rather than a stylesheet's job.
 *
 * **A 1×1 selection returns `NO_RANGE_EDGES` too.** The caret's ring is already there;
 * drawing a second rectangle a pixel inside it is the artefact this rule exists to
 * prevent, and it keeps a plain click byte-identical with before.
 */
export function cellRangeEdges(input: {
    rowEdge: SelectionRowEdge;
    /** The rectangle's first and last column. */
    fromCol: number;
    toCol: number;
    /** This cell's column index. */
    col: number;
}): CellRangeEdges {
    const { rowEdge, fromCol, toCol, col } = input;
    if (rowEdge === 'none') return NO_RANGE_EDGES;
    if (col < fromCol || col > toCol) return NO_RANGE_EDGES;
    // One cell tall AND one cell wide: the ring is the whole answer.
    if (rowEdge === 'both' && fromCol === toCol) return NO_RANGE_EDGES;

    const top = rowEdge === 'top' || rowEdge === 'both';
    const bottom = rowEdge === 'bottom' || rowEdge === 'both';
    const left = col === fromCol;
    const right = col === toCol;
    if (!top && !bottom && !left && !right) return NO_RANGE_EDGES;
    return { top, right, bottom, left };
}
