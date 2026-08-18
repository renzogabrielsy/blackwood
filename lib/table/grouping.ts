// ─────────────────────────────────────────────────────────────────────────────────
// Blackwood Table — group spacers. PLATFORM LAYER, pure, no React.
//
// Renzo, on the ledger this came from: *"Make this specific table smart enough to auto
// skip a table row to separate and group days together. Nothing fancy."* — and, on the
// first attempt: *"It should be literally just an empty row, not some made up effect on
// screen, it just looks weird. Just place an actual row in between days."*
//
// So a spacer is **a real row of the spreadsheet**, not an effect between rows: the same
// height as a data row, one `<td>` PER COLUMN (never a `colSpan`, which erases the
// vertical rules and is exactly what gave the first version away), the same borders, and
// fully opaque under the pinned block. It carries the ordinary rules; it does not skip
// them.
//
// It is **not** a second heading system — no label, no count, no total. And it is NOT
// addressable: a spacer never enters the nav row list, so the keyboard coordinate space,
// the resolver, arrow movement and range selection are byte-identical with and without
// it. The caret cannot land on one by construction.
// ─────────────────────────────────────────────────────────────────────────────────

/**
 * Does a blank spacer row belong ABOVE the row whose group key is `key`?
 *
 * `prevKey === undefined` means there is nothing above it yet, which is the whole of the
 * "never a leading gap at the top of the sheet" rule — the first row in a window is never
 * preceded by a spacer, whatever group it is in.
 *
 * A row with no group value must be normalised to `''` by the caller rather than passed
 * as `undefined`. That falls out correctly with no special case: two consecutive
 * ungrouped rows compare equal and get no spacer, and the ungrouped → first-group
 * transition differs and gets one, like any other boundary.
 */
export function needsGroupSpacer(prevKey: string | undefined, key: string): boolean {
    if (prevKey === undefined) return false;
    return prevKey !== key;
}
