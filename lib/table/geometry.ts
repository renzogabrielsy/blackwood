// ─────────────────────────────────────────────────────────────────────────────────
// Blackwood Table — layout arithmetic. PLATFORM LAYER, pure, no React.
//
// Extracted from `app/(app)/cenapro/deliveries/types.ts` (2026-08-17) and generalised in
// exactly one respect: **a pinned column is `pin: 'start' | 'end'`, not `frozen: true`.**
// The old boolean could only describe a PREFIX — every helper walked from index 0 and
// stopped at the first unfrozen column — so a right-pinned actions column could not be
// expressed at all, and four separate consumers (the caret-follow, the drag auto-scroll,
// the footer's bottom-left corner, the summary spans) all read that assumption.
//
// Everything else is the shipped behaviour, comments included. It is load-bearing and it
// was argued for once already; see `app/(app)/cenapro/deliveries/CONTEXT.md` →
// "Following the caret" and "Dragging a selection to the edge".
// ─────────────────────────────────────────────────────────────────────────────────

import type { ColumnGeometry, SummaryLane } from './types';

// ═══ Pinned runs ════════════════════════════════════════════════════════════════

/**
 * How many columns form the pinned run at each end.
 *
 * A run STOPS at the first column that is not pinned to that side. That is not a
 * limitation, it is what `position: sticky` can actually paint — a pinned column with a
 * scrolling column to its left has nothing coherent to stick to. A stray `pin` in the
 * middle therefore ends the run and is laid out as an ordinary column.
 */
export function pinnedCounts(cols: readonly ColumnGeometry[]): { start: number; end: number } {
    let start = 0;
    while (start < cols.length && cols[start].pin === 'start') start++;

    let end = 0;
    while (end < cols.length - start && cols[cols.length - 1 - end].pin === 'end') end++;

    return { start, end };
}

/**
 * Cumulative `left` offsets for the start-pinned run, in column order — the value each
 * sticky cell needs. Index-aligned with the run, so `out.length` IS the run length.
 */
export function pinnedOffsets(cols: readonly ColumnGeometry[]): number[] {
    const { start } = pinnedCounts(cols);
    const out: number[] = [];
    let x = 0;
    for (let i = 0; i < start; i++) {
        out.push(x);
        x += cols[i].width;
    }
    return out;
}

/**
 * Cumulative `right` offsets for the end-pinned run, **in column order** (left → right),
 * so the array can be indexed by `col - (cols.length - endCount)` without reversing it.
 */
export function pinnedEndOffsets(cols: readonly ColumnGeometry[]): number[] {
    const { end } = pinnedCounts(cols);
    const out: number[] = [];
    let x = 0;
    for (let i = 0; i < end; i++) {
        out.unshift(x);
        x += cols[cols.length - 1 - i].width;
    }
    return out;
}

/**
 * Total width of a pinned block — the strip of the scrollport a scrolling column is
 * hidden UNDERNEATH rather than merely scrolled past. Same walk as the offsets, so the
 * two can never disagree about where the block ends.
 */
export function pinnedWidth(cols: readonly ColumnGeometry[], side: 'start' | 'end' = 'start'): number {
    const { start, end } = pinnedCounts(cols);
    let x = 0;
    if (side === 'start') {
        for (let i = 0; i < start; i++) x += cols[i].width;
    } else {
        for (let i = 0; i < end; i++) x += cols[cols.length - 1 - i].width;
    }
    return x;
}

/** Is this column pinned to either edge? Pinned columns are visible at every offset. */
export function isPinned(cols: readonly ColumnGeometry[], col: number): boolean {
    const { start, end } = pinnedCounts(cols);
    return col < start || col >= cols.length - end;
}

// ═══ Widths ═════════════════════════════════════════════════════════════════════

/**
 * The table's `min-width` — the sum of every column's declared width.
 *
 * This is the "never crush, always scroll" rule in one function: the table gets this as
 * an explicit minimum inside an `overflow-x-auto` wrapper, so a narrow viewport SCROLLS
 * instead of compressing a column below its intrinsic size. There is deliberately no
 * flexible column to absorb slack — that column is the one that silently crushes.
 */
export function minTableWidth(cols: readonly ColumnGeometry[]): number {
    return cols.reduce((sum, c) => sum + c.width, 0);
}

/** Cumulative `left` offset of EVERY column, index-aligned with `cols`. */
export function columnOffsets(cols: readonly ColumnGeometry[]): number[] {
    const out: number[] = [];
    let x = 0;
    for (const c of cols) {
        out.push(x);
        x += c.width;
    }
    return out;
}

// ═══ Following the caret, horizontally ══════════════════════════════════════════

export interface ColumnScrollInput {
    /** Index of the column the caret has just moved to. */
    col: number;
    cols: readonly ColumnGeometry[];
    /** The scroller's current horizontal offset. */
    scrollLeft: number;
    /** The scroller's visible width. */
    clientWidth: number;
    /** The scroller's full scrollable width. */
    scrollWidth: number;
}

/**
 * The horizontal offset that brings `col` into view, or **null when nothing is owed** —
 * which is the whole point: Tab must never move the sheet a pixel it does not have to.
 *
 * Two things this has to get right that a bare `scrollIntoView` does not:
 *
 *   • **The pinned blocks.** Pinned columns cover the first N and last M pixels of the
 *     scrollport, so the window a scrolling column is actually VISIBLE in is
 *     `[scrollLeft + pinnedStart, scrollLeft + clientWidth − pinnedEnd]`. Scrolling a
 *     target to its own `left` would park it underneath the pinned block, which reads as
 *     "Tab went somewhere invisible".
 *   • **Minimum nudge.** A column already fully inside that window returns null, so a
 *     purely VERTICAL move never shifts the sheet sideways — and a pinned column, which
 *     is visible at every offset, returns null always.
 */
export function columnScrollLeft(input: ColumnScrollInput): number | null {
    const { col, cols, scrollLeft, clientWidth, scrollWidth } = input;
    const c = cols[col];
    if (!c || isPinned(cols, col)) return null;

    // Nothing overflows ⇒ nothing to scroll. This is also the branch that keeps the
    // maths honest: `table-fixed` + `width:100%` stretches the columns past their
    // declared widths ONLY when there is no overflow, so the declared widths below are
    // exact in precisely the case where they are consulted.
    const maxScroll = Math.max(0, scrollWidth - clientWidth);
    if (maxScroll <= 0) return null;

    const left = columnOffsets(cols)[col];
    const right = left + c.width;
    const padStart = pinnedWidth(cols, 'start');
    const padEnd = pinnedWidth(cols, 'end');

    let next: number;
    if (left < scrollLeft + padStart) next = left - padStart;
    else if (right > scrollLeft + clientWidth - padEnd) next = right - clientWidth + padEnd;
    else return null;

    next = Math.max(0, Math.min(next, maxScroll));
    return next === scrollLeft ? null : next;
}

// ═══ Drag auto-scroll — where the pointer must be for the sheet to follow ═══════
//
// Click-dragging a selection to the edge of the scrollport has to scroll it, and the
// thing that makes this different from a naive edge test is the same thing the
// caret-follow had to solve: **a pinned block is a WALL, not a scroll position.** A
// pointer 100px in from the left edge is not near an edge — it is sitting ON the pinned
// columns with scrolling cells hidden underneath, so a band measured from the scrollport
// would stall there and the covered cells would be undraggable-to. Both bands are
// therefore measured from the INNER edge of their pinned block.
//
// Both deltas are zeroed at their wall, so the loop cannot grind against a scroller with
// nowhere left to go — and a table that fits its scrollport never scrolls sideways.

/** How close to an edge the pointer has to get. */
export const DRAG_EDGE_PX = 40;
/** Pixels per animation frame. Applied by assignment — never a smooth scroll. */
export const DRAG_STEP_PX = 5;

export interface DragScrollInput {
    /** The pointer, in viewport coordinates. */
    pointer: { x: number; y: number };
    /** The scroller's own viewport rect. */
    rect: { top: number; bottom: number; left: number; right: number };
    /** Width of the start-pinned block — `pinnedWidth(cols, 'start')`. */
    pinnedStart: number;
    /** Width of the end-pinned block. Defaults to 0. */
    pinnedEnd?: number;
    scrollTop: number;
    scrollLeft: number;
    maxScrollTop: number;
    maxScrollLeft: number;
}

/**
 * The per-frame scroll delta a drag owes, or `{0,0}` when it owes nothing — the drag
 * counterpart of `columnScrollLeft` returning null.
 */
export function dragAutoScrollDelta(input: DragScrollInput): { dx: number; dy: number } {
    const {
        pointer, rect, pinnedStart, pinnedEnd = 0,
        scrollTop, scrollLeft, maxScrollTop, maxScrollLeft,
    } = input;

    let dy = 0;
    if (pointer.y < rect.top + DRAG_EDGE_PX) dy = -DRAG_STEP_PX;
    else if (pointer.y > rect.bottom - DRAG_EDGE_PX) dy = DRAG_STEP_PX;

    // Each band starts where the PINNED columns end, not where the scrollport does.
    let dx = 0;
    if (pointer.x < rect.left + pinnedStart + DRAG_EDGE_PX) dx = -DRAG_STEP_PX;
    else if (pointer.x > rect.right - pinnedEnd - DRAG_EDGE_PX) dx = DRAG_STEP_PX;

    if (dy < 0 && scrollTop <= 0) dy = 0;
    if (dy > 0 && scrollTop >= maxScrollTop) dy = 0;
    if (dx < 0 && scrollLeft <= 0) dx = 0;
    if (dx > 0 && scrollLeft >= maxScrollLeft) dx = 0;

    return { dx, dy };
}

// ═══ Summary-row spans — read off the column table, never counted ═══════════════
//
// A totals rule-off and a sticky footer are ordinary `<tr>`s that have to TILE the same
// column table the data rows do, with each figure landing on its own column. They used
// to derive their `colSpan`s arithmetically (`spanAll - 7`, `cols.length - frozenCount -
// 3`, a literal `colSpan={5}`), with a gating ternary standing in for "is the total
// column there". That was correct for both shapes that existed and wrong the moment
// anyone touched the column table: the constants encoded WHERE two particular columns
// sat, and nothing said so.
//
// So the lanes are derived from the columns themselves, via `summaryLane` on the spec —
// which is the generalisation of the old hard-coded `'wt'` / `'ttl'` keys. Insert a
// column anywhere and the lane containing it widens on its own; hide a column for a role
// and its lane disappears with it.

export interface SummarySpans {
    /** Everything LEFT of the first figure — the row's label lane. */
    label: number;
    /** Exactly the start-pinned block — a sticky footer's bottom-left corner. */
    frozen: number;
    /** The gap between that corner and the first figure. */
    spacer: number;
    /** The `figure` column, where the headline number sits. */
    weight: number;
    /** Between the figure and the total, exclusive — an annotation lane. */
    note: number;
    /** The `total` column, or **0** when it is absent for this viewer. */
    total: number;
    /**
     * Anything RIGHT of the total — rendered as an empty filler so a column appended at
     * the far end is COVERED rather than leaving the summary row short of the data rows.
     * This lane is the difference between "tiles for the shapes that exist" and "tiles".
     */
    trailing: number;
}

export interface SummaryLaneCol extends ColumnGeometry {
    summaryLane?: SummaryLane;
}

/**
 * Where each figure in a summary row sits, given the column table actually rendered.
 *
 * Both forms tile exactly: `label + weight + note + total + trailing` and
 * `frozen + spacer + weight + note + total + trailing` each equal `cols.length`, for ANY
 * column table. **A span of 0 means the segment has no column and its cell must not be
 * rendered at all** — `colSpan={0}` is "to the end of the column group" in HTML, which is
 * the opposite of nothing.
 */
export function summarySpans(cols: readonly SummaryLaneCol[]): SummarySpans {
    const frozen = pinnedCounts(cols).start;
    const totalIdx = cols.findIndex((c) => c.summaryLane === 'total');
    const noteEnd = totalIdx >= 0 ? totalIdx : cols.length;

    // A column table with no figure lane degenerates cleanly rather than throwing on a
    // render path: the label lane simply swallows the whole row.
    const figIdx = cols.findIndex((c) => c.summaryLane === 'figure');
    const hasWeight = figIdx >= 0 && figIdx < noteEnd;
    const label = hasWeight ? figIdx : noteEnd;

    return {
        label,
        frozen,
        spacer: Math.max(0, label - frozen),
        weight: hasWeight ? 1 : 0,
        note: Math.max(0, noteEnd - label - (hasWeight ? 1 : 0)),
        total: totalIdx >= 0 ? 1 : 0,
        trailing: totalIdx >= 0 ? cols.length - totalIdx - 1 : 0,
    };
}
