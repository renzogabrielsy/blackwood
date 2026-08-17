// ─────────────────────────────────────────────────────────────────────────────────
// Blackwood Table — the clipboard exchange. PLATFORM LAYER, pure, no React.
//
// Renzo: *"allow us to copy and paste into existing entries and empty entries (from
// google sheet, into the app)"* · *"allow us to copy data from the app so its pastable
// into google sheet"*.
//
// The operators live in Google Sheets, so the clipboard is a real interchange format
// here, not a convenience. Everything below is PURE, so the exchange is decided in one
// place and asserted without a browser.
//
// Three rules, and each of them was a real defect in the grid this came from:
//
//   1. **A cell may contain a tab or a newline.** A free-text remarks column will. A
//      payload that joins raw cell text with `\t` / `\n` shreds the row alignment the
//      moment one cell holds a line break. So the writer QUOTES (`tsvEscape`) and the
//      reader UNDERSTANDS quotes (`parseClipboardTable`) — the convention Sheets and
//      Excel both speak.
//   2. **A spreadsheet wants a NUMBER, not a rendering.** `₱6,940,123.45` is text to
//      Sheets. `clipboardNumber` emits the source's own decimal digits, VERBATIM when it
//      is already a plain numeric string — because a DB `numeric` arrives as an exact
//      decimal string and re-deriving it through a JavaScript float is precisely how a
//      payment ledger goes wrong.
//   3. **A pasted number arrives WITH its rendering.** Sheets copies `27,045` and
//      `₱39.50`, so a numeric column strips formatting on the way in — and only a
//      numeric column, because free text may legitimately contain exactly those
//      characters. (That stripping is the column spec's `cleanPasted`, not this file's.)
// ─────────────────────────────────────────────────────────────────────────────────

// ═══ TSV in ═════════════════════════════════════════════════════════════════════

/**
 * Split a clipboard payload into a rectangle of cell texts.
 *
 * Tab between columns, newline between rows — plus the quoting convention Sheets and
 * Excel use, so a cell holding a tab or a line break survives the round trip. A doubled
 * `""` inside a quoted cell is one literal quote.
 *
 * TRAILING blank rows are dropped (Sheets ends its payload with a newline; that is not
 * an extra row). A blank row in the MIDDLE is kept — pasting a blank cell over a value
 * clears it, which is what Excel does.
 */
export function parseClipboardTable(text: string): string[][] {
    const rows: string[][] = [];
    let row: string[] = [];
    let cell = '';
    let quoted = false;

    for (let i = 0; i < text.length; i++) {
        const ch = text[i];

        if (quoted) {
            if (ch === '"') {
                if (text[i + 1] === '"') {
                    cell += '"';
                    i++;
                } else {
                    quoted = false;
                }
            } else {
                cell += ch;
            }
            continue;
        }

        if (ch === '"' && cell === '') {
            quoted = true;
        } else if (ch === '\t') {
            row.push(cell);
            cell = '';
        } else if (ch === '\n' || ch === '\r') {
            // CRLF is ONE row break, not two.
            if (ch === '\r' && text[i + 1] === '\n') i++;
            row.push(cell);
            rows.push(row);
            row = [];
            cell = '';
        } else {
            cell += ch;
        }
    }
    row.push(cell);
    rows.push(row);

    while (rows.length > 0 && rows[rows.length - 1].every((c) => c === '')) rows.pop();
    return rows;
}

// ═══ TSV out ════════════════════════════════════════════════════════════════════

/** The mirror of `parseClipboardTable`: quote a cell that would otherwise break the grid. */
export function tsvEscape(value: string): string {
    return /[\t\n\r"]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/**
 * A number the way a spreadsheet wants it: digits, a decimal point, nothing else.
 *
 * A `numeric` column arrives from PostgREST as a STRING, and that string is the
 * database's exact decimal. When it already looks like a plain number it is emitted
 * VERBATIM — no `Number()` round trip — so an exact stored total reaches the clipboard
 * as the ledger holds it rather than as the nearest float.
 */
export function clipboardNumber(v: number | string | null | undefined): string {
    if (v === null || v === undefined || v === '') return '';
    if (typeof v === 'number') return Number.isFinite(v) ? String(v) : '';
    const t = String(v).trim();
    if (/^-?\d+(\.\d+)?$/.test(t)) return t;
    const n = Number(t.replace(/[^0-9.-]/g, ''));
    return Number.isFinite(n) ? String(n) : '';
}

// ═══ Where a pasted block GOES ══════════════════════════════════════════════════

export interface PastePlanInput {
    /** The anchor cell — the block's top-left corner. */
    startRow: number;
    startCol: number;
    /** The clipboard block's shape. */
    blockRows: number;
    blockCols: number;
    /** The grid as it stands. */
    navRowCount: number;
    colCount: number;
    /** Are blank draft rows on screen at all? (A filtered view has none.) */
    canCreateRows: boolean;
    /** Defensive ceiling on one gesture. */
    maxNewRows: number;
}

export interface PastePlan {
    /** How many blank rows to append so the block fits. */
    newRows: number;
    /** Block rows that land nowhere and will NOT be written. */
    droppedRows: number;
    /** Block columns that fall past the last column of the sheet. */
    droppedCols: number;
}

/**
 * Where a pasted block goes — the arithmetic, on its own, so it can be asserted.
 *
 * The rule this exists to express: **a block taller than the rows available CREATES the
 * rows it needs.** The predecessor looped `r < Math.min(block.length, navRows.length)`,
 * so pasting a 30-row slip into a sheet showing 20 blank rows wrote 20 and threw 10 away
 * without a word. Blank rows only exist where a blank row MEANS something (never under a
 * filter or a search), so when they are absent the overflow is reported rather than
 * invented — `droppedRows` is what the operator is told about.
 */
export function planPaste(input: PastePlanInput): PastePlan {
    const needed = Math.max(0, input.startRow + input.blockRows - input.navRowCount);
    const newRows = input.canCreateRows ? Math.min(needed, Math.max(0, input.maxNewRows)) : 0;
    const lastTargetCol = input.startCol + input.blockCols - 1;
    return {
        newRows,
        droppedRows: needed - newRows,
        droppedCols: Math.max(0, lastTargetCol - (input.colCount - 1)),
    };
}

// ═══ WHICH rows a pasted block lands on ═════════════════════════════════════════
//
// `planPaste` answers "how many rows does this block need"; this answers "which rows are
// they". They are different questions the moment the sheet holds more than one ROW
// FAMILY, and the grid this came from never asked the second one: it mapped block row
// `r` to nav row `anchor.row + r`, straight through the sub-rows sitting under a parent.
// A 5-row block pasted onto a parent with 2 sub-rows wrote rows 1–2 into the SUB-ROWS —
// and only the columns they happen to share, because the rest failed the per-cell
// addressability test and were dropped in silence — then carried on into the following
// parents, and reported "Pasted 5 rows". Wrong data, reported as success. (BUG-024.)

/** How a row family relates to the anchor's for pasting purposes. */
export type PasteRowKind = 'record' | 'child' | 'draft' | (string & {});

/**
 * May a block anchored on `anchor` write to a row of kind `row`?
 *
 * A child row is not a small parent — it shares only some columns — so a block anchored
 * on one fills children only. In the other direction a block flowing off the last record
 * into the blank rows at the bottom is how a pasted slip BECOMES new records, which is
 * wanted behaviour: a record and a draft are ONE family for this purpose.
 *
 * `childKinds` names the families that are children; everything else is record-like.
 * Defaults to `['child', 'sample']` so the common cases need no configuration.
 */
export function pasteKindsCompatible(
    anchor: PasteRowKind,
    row: PasteRowKind,
    childKinds: readonly string[] = ['child', 'sample'],
): boolean {
    const anchorIsChild = childKinds.includes(anchor);
    const rowIsChild = childKinds.includes(row);
    if (anchorIsChild) return rowIsChild;
    return !rowIsChild;
}

export interface PasteRowTargetsInput {
    /** Every nav row's kind, in nav order. */
    kinds: readonly PasteRowKind[];
    /** The nav row the paste is anchored on. */
    anchorRow: number;
    /** How many rows the clipboard block has. */
    blockRows: number;
    /** Which kinds are child rows. See `pasteKindsCompatible`. */
    childKinds?: readonly string[];
}

export interface PasteRowTargets {
    /**
     * Nav row indices the block's rows land on, in block order. SHORTER than `blockRows`
     * when the block outruns the sheet — the remainder is the overflow `planPaste` turns
     * into new rows or reports as dropped.
     */
    targets: number[];
    /** Rows of another family stepped over inside the span actually used. */
    skipped: number;
}

/**
 * Resolve the nav rows a pasted block occupies, skipping rows of another family.
 *
 * Feed `targets.length` to `planPaste` as its `navRowCount` (with `startRow: 0`) and its
 * row arithmetic — `needed = startRow + blockRows − navRowCount` — becomes exactly the
 * overflow, while its column arithmetic is untouched.
 *
 * When no foreign rows are in the way this is byte-identical to the old positional
 * mapping: `targets` is `[anchorRow, anchorRow+1, …]` and `skipped` is 0.
 */
export function pasteRowTargets(input: PasteRowTargetsInput): PasteRowTargets {
    const { kinds, anchorRow, blockRows, childKinds } = input;
    const targets: number[] = [];
    if (blockRows <= 0 || anchorRow < 0 || anchorRow >= kinds.length) {
        return { targets, skipped: 0 };
    }
    const anchorKind = kinds[anchorRow];
    let skipped = 0;
    // A foreign row only counts as STEPPED OVER once a later row is actually landed on.
    // Held back until then, because a run of foreign rows at the point the block (or the
    // sheet) runs out was not stepped over by anything — reporting it as skipped would
    // double-count the overflow `planPaste` already reports as dropped rows.
    let pending = 0;
    for (let r = anchorRow; r < kinds.length && targets.length < blockRows; r++) {
        if (pasteKindsCompatible(anchorKind, kinds[r], childKinds)) {
            targets.push(r);
            skipped += pending;
            pending = 0;
        } else {
            pending++;
        }
    }
    return { targets, skipped };
}

// ═══ Tiling a block over a SELECTION (2026-08-17, new in v1) ════════════════════
//
// The single most-missed Sheets habit, and the one gesture the old paste could not do at
// all: copy ONE cell, select thirty, hit paste, and all thirty take the value. Sheets
// generalises that — when the selection is an exact multiple of the block in a
// dimension, the block TILES across it. Anything else pastes from the anchor, which is
// the behaviour that already existed.
//
// Expressed as a pure mapping so it is asserted without a grid: given the block's shape
// and the selection's shape, how many rows/cols does the paste actually cover, and which
// block cell feeds target offset (r, c)?

export interface TilePasteInput {
    blockRows: number;
    blockCols: number;
    /** The selected rectangle's shape. `1 × 1` means "no real selection". */
    selRows: number;
    selCols: number;
}

export interface TilePlan {
    /** How many rows the paste covers — the selection's when tiling, else the block's. */
    rows: number;
    /** How many columns the paste covers. */
    cols: number;
    /** True when the block was repeated to fill the selection. */
    tiled: boolean;
    /** Which block cell feeds target offset (r, c). */
    source(r: number, c: number): { row: number; col: number };
}

/**
 * Decide whether a paste tiles over the selection or anchors at its corner.
 *
 * Tiles when the selection is a whole-number multiple of the block in BOTH dimensions
 * and is bigger than it — which makes the 1×1 case ("fill the selection with this
 * value") fall out for free rather than being a special case. Otherwise the block is
 * pasted once from the anchor, exactly as before, and the selection is ignored.
 */
export function tilePaste(input: TilePasteInput): TilePlan {
    const { blockRows, blockCols, selRows, selCols } = input;

    const fits =
        blockRows > 0 &&
        blockCols > 0 &&
        selRows >= blockRows &&
        selCols >= blockCols &&
        selRows % blockRows === 0 &&
        selCols % blockCols === 0 &&
        (selRows > blockRows || selCols > blockCols);

    if (!fits) {
        return {
            rows: blockRows,
            cols: blockCols,
            tiled: false,
            source: (r, c) => ({ row: r, col: c }),
        };
    }

    return {
        rows: selRows,
        cols: selCols,
        tiled: true,
        source: (r, c) => ({ row: r % blockRows, col: c % blockCols }),
    };
}
