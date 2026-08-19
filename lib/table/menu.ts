// ─────────────────────────────────────────────────────────────────────────────────
// Blackwood Table — the DEFAULT right-click menu, as data. PLATFORM LAYER, PURE.
//
// `BlackwoodTable` has carried a `contextMenuItems` prop from the start and rendered
// **nothing at all** when a consumer omitted it — so every grid in the app either wrote
// its own menu or had none, and right-click on ten of them did what the browser does.
// Renzo: *"every part of the app that uses the table should also universally use the
// following features as well: the right click menu and the hover summary."*
//
// The item LIST is a pure function of two facts about the cell that was right-clicked,
// which is why it lives here rather than inside the component:
//
//   • **Is this cell editable?** The three mutating items (clear, paste, fill down) are
//     absent — not disabled, ABSENT — on a read-only grid. All ten v2 grids are read-only
//     by construction (no `ColumnSpec` declares a `parse`), so a menu offering Paste
//     there would be a menu whose every mutating item silently does nothing.
//   • **Is there a row under the pointer?** A right-click that lands on chrome has no row
//     to copy and no row to select.
//
// Nothing here renders, imports React or knows what a Blackwood row is. The component
// maps each `action` onto the interaction hook's own callback, so there is exactly one
// definition of what "Copy" means and it is the same one Ctrl/Cmd+C uses.
// ─────────────────────────────────────────────────────────────────────────────────

/** Every action the built-in menu can ask the grid to perform. */
export type TableMenuAction =
    | 'copy'
    | 'copy-with-headers'
    | 'copy-row'
    | 'select-row'
    | 'select-column'
    | 'clear-selection'
    | 'clear-contents'
    | 'paste'
    | 'fill-down';

/** One row of the built-in menu, or the rule between two groups. */
export interface TableMenuItemSpec {
    action: TableMenuAction;
    label: string;
    /** The keyboard equivalent, shown right-aligned. Purely informational. */
    shortcut?: string;
    /** Draw a separator ABOVE this item. */
    separatorBefore?: boolean;
    /** A mutating item — present only where the cell actually accepts an edit. */
    mutates?: boolean;
}

/**
 * The built-in menu for one right-click.
 *
 * **Read-only items always; mutating items only where `editable` is true.** That single
 * predicate is what makes the menu safe to switch on for every grid at once: a sheet with
 * no editable column gets a menu that cannot ask it to change.
 *
 * `hasRow` is false when the click landed on a chrome row (a heading, a spacer) — there
 * is no row to copy and none to select, so those two items are dropped rather than
 * offered and ignored.
 */
export function defaultTableMenu(input: {
    /** Does the clicked cell accept an edit — the row family AND the column agreeing? */
    editable: boolean;
    /** Was there an addressable row under the pointer at all? */
    hasRow: boolean;
    /** Is more than one cell selected? Decides only whether "Clear selection" is offered. */
    hasSelection: boolean;
}): TableMenuItemSpec[] {
    const { editable, hasRow, hasSelection } = input;
    const out: TableMenuItemSpec[] = [
        { action: 'copy', label: 'Copy', shortcut: '⌘C' },
        { action: 'copy-with-headers', label: 'Copy with headers' },
    ];
    if (hasRow) out.push({ action: 'copy-row', label: 'Copy row' });

    if (editable) {
        out.push({ action: 'clear-contents', label: 'Clear contents', shortcut: '⌫', separatorBefore: true, mutates: true });
        out.push({ action: 'paste', label: 'Paste', shortcut: '⌘V', mutates: true });
        out.push({ action: 'fill-down', label: 'Fill down', shortcut: '⌘D', mutates: true });
    }

    if (hasRow) out.push({ action: 'select-row', label: 'Select row', separatorBefore: true });
    out.push({
        action: 'select-column',
        label: 'Select column',
        separatorBefore: !hasRow,
    });
    if (hasSelection) out.push({ action: 'clear-selection', label: 'Clear selection', shortcut: 'Esc' });

    return out;
}
