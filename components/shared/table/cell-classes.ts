// ─────────────────────────────────────────────────────────────────────────────────
// Blackwood Table — the cell class table. PLATFORM LAYER, PURE (no React import).
//
// This file exists for one measured reason. The audit clocked the grid this module
// replaces at **~12 allocations and 2 `twMerge` calls per `<td>` per render** — and on a
// busy month that is 4,086 cells, so ~51,000 allocations and ~8,500 tailwind merges for
// a single keystroke. `cn()` is `twMerge(clsx(...))`: it parses class strings and
// resolves conflicts at RUNTIME, which is exactly the wrong thing to do per cell.
//
// A cell's classes are a pure function of a handful of ENUMS — is it pinned, is it the
// last pinned column, what family is the row, is it active / selected / invalid / dirty,
// is it numeric. So they are computed ONCE per distinct combination and cached. There
// are a few dozen combinations in a real table; there are thousands of cells.
//
// Two rules are baked in here rather than left to call sites, because both have already
// been shipped as bugs:
//
//   • **ONE `bg-*` class, chosen by an explicit precedence.** Stacking background
//     utilities and hoping is not a rule — Tailwind emits them in ITS order, not the
//     order they are written, so which one wins is luck. Invalid outranks selected
//     outranks dirty: a cell the operator must come back and fix stays visible under
//     every other state.
//   • **A pinned cell is OPAQUE and its tint rides on an inner layer.** A pinned column
//     sits ON TOP of scrolling content; any alpha in its base and the moving cells bleed
//     through it. So the `<td>` gets a solid token and the state tint goes on the inner
//     `absolute inset-0` div, above it.
// ─────────────────────────────────────────────────────────────────────────────────

/** Everything that can change a cell's appearance. All of it enumerable. */
export interface CellClassKey {
    /** Pinned to an edge, and therefore opaque + sticky. */
    pin: 'start' | 'end' | null;
    /** The last column of the start block / the first of the end block — carries the seam. */
    edge: boolean;
    /** The row family, which decides the bottom rule's weight. */
    rowKind: string;
    /** Does the row actually have this cell? A missing cell paints nothing. */
    exists: boolean;
    /** The caret is here. */
    active: boolean;
    /** Inside the current rectangular selection. */
    selected: boolean;
    /** Refused at commit — the operator has to come back to it. */
    invalid: boolean;
    /** Carries an unsaved value. */
    dirty: boolean;
    /** Right-aligned, tabular figures. */
    numeric: boolean;
    /** Editable — decides the cursor only. */
    editable: boolean;
    /** On the TOP edge of the selection rectangle. */
    edgeTop: boolean;
    /** On the RIGHT edge of the selection rectangle. */
    edgeRight: boolean;
    /** On the BOTTOM edge of the selection rectangle. */
    edgeBottom: boolean;
    /** On the LEFT edge of the selection rectangle. */
    edgeLeft: boolean;
    /**
     * Is this cell inside a selection rectangle that covers **more than one cell** — i.e.
     * one that actually has a perimeter box drawn around it?
     *
     * It exists to suppress ONE thing: the anchor cell's own ring. Renzo, on a swept
     * range: *"not intended behavior"* — the perimeter painted correctly and the cell the
     * sweep started from still carried its full ring, so the selection read as two nested
     * boxes with the inner one a pixel inside the outer. In a multi-cell selection **the
     * box IS the selection**; a second rectangle around the anchor says nothing the
     * operator needs and looks like a rendering fault.
     *
     * **A 1×1 selection is untouched.** A plain click paints no box at all
     * (`cellRangeEdges` returns `NO_RANGE_EDGES` for it), so the ring is the whole answer
     * there and must stay exactly as it was. The two rules are complementary halves of
     * one statement: **there is always exactly one rectangle on screen.**
     *
     * And it is deliberately not simply `!active`: a caret sitting OUTSIDE the rectangle —
     * which is what a header click's column sweep leaves behind — is not boxed, so it
     * keeps its ring and the operator can still see where the keyboard is.
     */
    boxed: boolean;
}

/** The two class strings a cell needs: the `<td>` and the interactive layer inside it. */
export interface CellClasses {
    td: string;
    inner: string;
}

/** Row-family → bottom-rule weight. A parent's rule is heavier than a child's. */
export const DEFAULT_ROW_RULES: Record<string, string> = {
    record: 'border-b border-b-border/30',
    child: 'border-b border-b-border/20',
    draft: 'border-b border-b-border/20',
    spacer: 'border-b border-b-border',
};

const SELECT_TINT = 'bg-primary/10';
const DIRTY_TINT = 'bg-amber-500/10';
const INVALID_TINT = 'bg-destructive/15';

/**
 * The interactive layer is `absolute inset-0`, NOT `h-full`.
 *
 * That is a correctness rule, not a preference. `h-full` is a percentage height against a
 * table cell the browser has not committed to, so it collapses onto the cell's own TEXT —
 * which shipped as two apparently separate bugs: the active ring traced the text instead
 * of the cell, and an EMPTY cell had zero height and therefore no hit area at all, so it
 * could not be clicked, let alone typed into.
 */
const CELL_BASE = [
    'absolute inset-0 flex items-center px-2 text-xs outline-none',

    // ── A CELL CLIPS. ────────────────────────────────────────────────────────────
    //
    // Without this a value wider than its column simply PAINTED OVER the neighbour —
    // measured on the QC sheet, where a `yyyy-MM-dd` in a 62px column spilled into the
    // cell beside it and `WHSE 3` wrapped to two lines inside a 32px row. Neither is a
    // width problem the consumer can fix by widening, because neither is visible as a
    // width problem: the sheet just reads as though two columns had swapped values.
    //
    // `overflow-hidden` is the hard guarantee (nothing ever leaves its own cell) and
    // `whitespace-nowrap` is the other half (a cell is one line, always — a row's height
    // is declared by its family and a wrapped line has nowhere to go).
    'overflow-hidden whitespace-nowrap',
    // TRUE ellipsis for the common case. A flex container is not a block container, so
    // `text-overflow` on it does nothing for bare text — it is the element CHILDREN a
    // `format` returns that can carry it, and they need `min-w-0` first or a flex item
    // refuses to shrink below its content. A `format` returning a bare string still
    // CLIPS (the rule above); wrap it in a `<span>` to get the ellipsis too.
    '[&>*]:min-w-0 [&>*]:overflow-hidden [&>*]:text-ellipsis',

    // ── THE SELECTION BOX'S GUTTER, RESERVED ON EVERY CELL. ──────────────────────
    //
    // The rectangle's border is painted with a real border (below), and a border added
    // only to the cells that happen to be on an edge would move their text by a pixel
    // the moment a sweep reached them — a shimmer running along the perimeter of every
    // drag. So all four sides are declared on EVERY cell and only their COLOUR changes:
    // transparent inside the rectangle and outside it, `primary` on an edge. Zero
    // layout, zero jitter, and the four sides are always written together so their
    // stylesheet order can never decide which one wins.
    'border',
].join(' ');

function buildTd(k: CellClassKey, rules: Record<string, string>): string {
    const parts = [
        // Side-specific colour, so the row rule's `border-b-*` cannot land in the same
        // tailwind-merge group and silently restyle the vertical line.
        'border-r border-r-border p-0 align-middle',
        rules[k.rowKind] ?? '',
    ];

    if (k.pin) {
        // Opaque, always. Never glass, never an alpha — see the header.
        parts.push('frozen-col bg-background group-hover:bg-muted');
        if (k.edge) parts.push('frozen-edge');
    } else {
        // A containing block for the `absolute inset-0` layer. A pinned cell already has
        // one (`position: sticky` is one), and giving it a second would fight the CSS
        // that pins it.
        parts.push('relative');
    }

    return parts.filter(Boolean).join(' ');
}

/**
 * The four sides of the selection box, ALWAYS all four, so no two of them can land in
 * the same tailwind-merge group at different specificities and disagree.
 *
 * `primary` on an edge of the rectangle, `transparent` everywhere else — which is what
 * makes "one big box surrounding the selected cells WITHOUT inner borders" a property of
 * each cell rather than an overlay something has to position.
 */
function selectionBorders(k: CellClassKey): string {
    return [
        k.edgeTop ? 'border-t-primary' : 'border-t-transparent',
        k.edgeRight ? 'border-r-primary' : 'border-r-transparent',
        k.edgeBottom ? 'border-b-primary' : 'border-b-transparent',
        k.edgeLeft ? 'border-l-primary' : 'border-l-transparent',
    ].join(' ');
}

function buildInner(k: CellClassKey): string {
    if (!k.exists) {
        // A cell the row does not have: inert, no hit area, no tint, no cursor. It still
        // reserves the border gutter, or its neighbours' text would sit a pixel off.
        return `${CELL_BASE} border-transparent pointer-events-none`;
    }

    const parts = [CELL_BASE, selectionBorders(k)];
    if (k.numeric) parts.push('justify-end font-mono tabular-nums');

    // ONE background, by explicit precedence.
    const tint = k.invalid ? INVALID_TINT : k.selected ? SELECT_TINT : k.dirty ? DIRTY_TINT : '';
    if (tint) parts.push(tint);
    if (k.invalid) parts.push('text-destructive');

    // The ring sits at z-20 so it clears a pinned cell (z-10) — otherwise a pinned cell
    // paints over its own ring. No transition: cell selection is never animated.
    //
    // SUPPRESSED inside a multi-cell selection: the perimeter box is already drawing the
    // one rectangle, and the anchor's ring inside it is a second one. See `boxed`.
    if (k.active && !k.boxed) parts.push('z-20 ring-2 ring-primary ring-inset');

    parts.push(k.editable ? 'cursor-cell' : 'cursor-default');
    return parts.join(' ');
}

/**
 * Cache key. Every field is an enum or a boolean, so the key is short and collision-free
 * by construction — which is what makes the cache sound rather than merely fast.
 */
export function cellClassKey(k: CellClassKey): string {
    return [
        k.pin ?? '-',
        k.edge ? 'E' : '-',
        k.rowKind,
        k.exists ? 'x' : '-',
        k.active ? 'a' : '-',
        k.selected ? 's' : '-',
        k.invalid ? 'i' : '-',
        k.dirty ? 'd' : '-',
        k.numeric ? 'n' : '-',
        k.editable ? 'e' : '-',
        // The selection box. These MUST be in the key: they change the class string, so
        // omitting them would serve the first combination the cache ever saw to every
        // cell of the rectangle — one box's worth of borders painted on all of them.
        k.edgeTop ? 'T' : '-',
        k.edgeRight ? 'R' : '-',
        k.edgeBottom ? 'B' : '-',
        k.edgeLeft ? 'L' : '-',
        // In the key for the same reason as the four edges: it changes the class string.
        // Omitted, the first combination the cache ever saw would decide the ring for
        // every cell after it — the anchor would keep or lose its ring at random.
        k.boxed ? 'X' : '-',
    ].join('|');
}

/**
 * A memoized class-table builder.
 *
 * One instance per table (created in a `useMemo`), so the cache lives as long as the
 * column set it describes and is thrown away with it. `size()` exists so a test can prove
 * the cache is actually being hit rather than silently rebuilding every cell.
 */
export function createCellClassTable(rowRules: Record<string, string> = DEFAULT_ROW_RULES) {
    const cache = new Map<string, CellClasses>();
    return {
        get(k: CellClassKey): CellClasses {
            const key = cellClassKey(k);
            let hit = cache.get(key);
            if (!hit) {
                hit = { td: buildTd(k, rowRules), inner: buildInner(k) };
                cache.set(key, hit);
            }
            return hit;
        },
        size: () => cache.size,
    };
}

export type CellClassTable = ReturnType<typeof createCellClassTable>;
