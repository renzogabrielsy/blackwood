// ─────────────────────────────────────────────────────────────────────────────────
// Blackwood Table — the bidirectional pager's index base. PLATFORM LAYER, pure, no React.
//
// A virtualiser that can PREPEND has two index spaces, and confusing them is the whole
// of this file:
//
//   • the RAW index — a position in the `items` array. Every inbound scroll API takes
//     one of these, because they clamp against the array's own length.
//   • the PUBLIC index — the raw position PLUS `firstItemIndex`. It is what the
//     virtualiser reports OUT, and the only index that survives a prepend unchanged.
//
// Prepending shifts every raw position by the number of items added, so a row keeps its
// public index — and the viewport keeps its place — only if `firstItemIndex` is
// DECREMENTED by exactly that number, in the same state batch as the prepend. Decrement
// by too little and the sheet jumps down by the difference; do it in a second render and
// it jumps and comes back.
//
// **The number is a count of ITEMS — rendered rows — never a count of RECORDS fetched.**
// One fetched record can add several items: its child sub-rows, the group spacer above
// it, a group heading. Counting records while the array grows by more is a bug class this
// codebase has already paid for, so this helper takes the two lengths of the FLAT array
// and does the subtraction itself: measure the array, do not count what you asked for.
// ─────────────────────────────────────────────────────────────────────────────────

/**
 * A large, round base for `firstItemIndex`, so a pager can walk backwards for a long time
 * before the public index space runs out. Not a limit on anything — the value is
 * arbitrary and only its HEADROOM matters, since every prepend spends some of it.
 */
export const DEFAULT_FIRST_ITEM_INDEX = 100_000;

export interface FirstItemIndexShiftInput {
    /** The base the list is currently rendering with. */
    firstItemIndex: number;
    /** `items.length` BEFORE the prepend. The flat array — not the record count. */
    previousItemCount: number;
    /** `items.length` AFTER it. */
    nextItemCount: number;
}

/**
 * The new `firstItemIndex` after a PREPEND, given the flat array's length either side.
 *
 * Call it only when the growth actually was a prepend — the two counts cannot tell one
 * from an append, and rebasing after an append would shove the viewport upwards by the
 * number of rows added at the far end.
 *
 * Two clamps, both deliberate:
 *
 *   • **A list that got SHORTER shifts nothing.** `firstItemIndex` is specified for
 *     inverse infinite scrolling and is only ever decreased; raising it back is not
 *     supported, so a shrink is reported as "no shift" rather than silently un-shifting
 *     and dragging the viewport with it.
 *   • **The result never goes negative.** The virtualiser requires a positive base, so a
 *     pager that walked past its own headroom stops rebasing rather than handing over a
 *     value the list cannot use.
 */
export function shiftFirstItemIndex(input: FirstItemIndexShiftInput): number {
    const { firstItemIndex, previousItemCount, nextItemCount } = input;
    const prepended = Math.max(0, nextItemCount - previousItemCount);
    return Math.max(0, firstItemIndex - prepended);
}
