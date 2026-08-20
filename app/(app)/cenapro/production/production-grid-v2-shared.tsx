// ═════════════════════════════════════════════════════════════════════════════════
// Cenapro production ledger — the ADAPTER onto the platform's Blackwood Table.
//
// This is the tenant half of the universal-table rewire for `/cenapro/production`: the
// column table, the row families, the flatten, and the two treatments the ledger's
// IN/OUT/DVO wash needs. Both v2 grids — `production-ledger-grid-v2.tsx` (focus scope)
// and `production-endless-sheet-v2.tsx` (endless scope) — import everything here, so the
// two sides of the SCOPE axis cannot disagree about what a column is or what a row means.
//
// It exists BESIDE the live grids (`production-ledger-grid.tsx`,
// `production-endless-sheet.tsx`), which are the production path and are not edited by
// one character — the strangler-fig method from
// `handoffs/2026-08-17-universal-table-phase-1-and-the-side-by-side-method.md`. Both v2
// surfaces are reachable only at `?grid=v2`.
//
// ── READ-ONLY BY CONSTRUCTION, NOT BY DISCIPLINE ────────────────────────────────
// **No spec below carries a `parse`.** `columnAcceptsEdit` (in `use-table-rows.ts`) falls
// back to `spec.parse !== undefined` when a spec declares no `editable`, so a column with
// no `parse` cannot be typed into, cannot be pasted into, and cannot become dirty — the
// entire write surface is removed by one omission rather than by fifteen switches that
// each have to stay off. Nothing here reaches `saveProductionEvents`, the
// `cenapro_save_*` RPCs, or any mutation at all.
//
// The row families still declare an HONEST `editable` flag per slot (`CellSlot.editable`),
// because that is the ROW's half of the verdict — "this field is writable on this family"
// is a fact about the domain, and it is what a later editing pass builds on. The two
// halves are ANDed in exactly one place inside the module, so an honest row half plus a
// missing column half is read-only, which is precisely the state this file wants.
//
// ── WHAT THE COLUMN TABLE IS FAITHFUL TO ────────────────────────────────────────
// The 13 columns, their order, their pixel widths and the 4-column pinned identity block
// are copied from the live ledger's `<colgroup>` / `COL_MAP` (sum = 1228px, the same
// `minWidth` both current grids use). The display of every cell goes through the ledger's
// OWN exported helpers — `toGridRow`, `formatKg`, `rowDirection`,
// `rowDirectionTint`/`rowDirectionFrozenTint` — and the badge classes come from the pure
// `../badges` module. So a v2 cell shows the same characters the current cell shows,
// because it is the same function producing them.
//
// ONE deliberate geometry change: `SIDE` is `pin: 'end'`. The current grids pin only the
// leading four; a right-pinned column was inexpressible under the old `frozen: boolean`
// and is exactly what `pin: 'start' | 'end'` was introduced for. It is visible only when
// the sheet is narrower than 1228px, where it keeps the trailing lane on screen.
// ═════════════════════════════════════════════════════════════════════════════════

import * as React from 'react';
import { format as formatDateFns, isValid, parseISO } from 'date-fns';

import { needsGroupSpacer, pinnedEndOffsets, pinnedOffsets } from '@/lib/table';
import type { CellSlot, ColumnSpec, GridRow, RowKind, SummaryLane } from '@/lib/table';
import { formatDateShort } from '@/components/shared/grid';
import type { TableChromeRowApi } from '@/components/shared/table';
import { cn } from '@/lib/utils';

import { BADGE_BASE, cccFlecBadgeClass, plantBadgeClass } from '../badges';
import type { ProductionEventRow } from '../types';
// The ledger's own display + classification helpers, imported rather than re-implemented.
// `production-endless-sheet.tsx` already reaches for exactly these five from exactly here,
// so this is the established path and there is still ONE definition of each. Importing
// them does not call anything: they are pure functions of a row.
import {
    formatKg,
    rowDirection,
    rowDirectionFrozenTint,
    rowDirectionTint,
    toGridRow,
    type GridRow as LedgerRow,
} from './production-ledger-grid';
import type { FilterColumn } from './ledger-url';

// ═══ Geometry ═══════════════════════════════════════════════════════════════════

/** Data-row height — the Excel Standard `h-8`, and what both current grids use. */
export const ROW_H = 32;
/** A day heading inside the body. Shorter than a data row; it is not a coordinate. */
export const GROUP_HEADER_H = 24;
/** A `Σ DAY TOTAL` rule-off. */
export const DAY_TOTAL_H = 28;
/** The endless scope's day boundary — a REAL blank row, same height as a data row. */
export const DAY_SPACER_H = 32;

// ═══ Ctx ════════════════════════════════════════════════════════════════════════

/**
 * The ambient state every `format` and every capability verdict is handed.
 *
 * It must be REFERENTIALLY STABLE — it is a dependency of the column resolution, of every
 * editability verdict and of every cell's `format`, so a fresh object per render
 * re-renders the whole sheet. Here that is guaranteed by construction rather than by a
 * `useMemo` in each consumer: the only two possible values are the two frozen
 * module-level constants below.
 */
export interface ProductionGridCtx {
    /**
     * The grid-wide edit gate, stated ONCE instead of implied by fifteen omissions.
     *
     * It is `false` in both v2 grids and nothing reads it to decide anything today — the
     * absence of `parse` is what actually makes the sheet read-only (see the file header).
     * It is here so that turning editing on later is one flag plus the parsers, and so the
     * intent is written down where a reviewer looks first.
     */
    canEdit: false;
    /** Which side of the SCOPE axis is rendering. The body chrome differs; cells do not. */
    scope: 'endless' | 'focus';
}

export const PRODUCTION_CTX_ENDLESS: ProductionGridCtx = Object.freeze({
    canEdit: false as const,
    scope: 'endless' as const,
});
export const PRODUCTION_CTX_FOCUS: ProductionGridCtx = Object.freeze({
    canEdit: false as const,
    scope: 'focus' as const,
});

// ═══ Rows ═══════════════════════════════════════════════════════════════════════

/**
 * Every writable field of a production event, DERIVED from the live ledger's own row
 * interface rather than re-typed.
 *
 * `_state` is the ledger's dirty marker, `id` is the upsert key and `batch_year` is
 * computed by the database and rides inside the BATCH cell — none of the three is a lane
 * of its own. Deriving the union means a field added to the ledger's row is a compile
 * error here rather than a column that silently never appears.
 */
export type ProductionField = Exclude<keyof LedgerRow, '_state' | 'id' | 'batch_year'>;

/** What the ledger's `rowDirection` answers. Its type is module-private over there. */
export type RowDirection = ReturnType<typeof rowDirection>;

/** One rendered production event. */
export interface ProductionGridRow {
    /**
     * The event as the live ledger's string row — converted ONCE, at flatten time, through
     * the ledger's own `toGridRow`. Every v2 cell therefore reads the exact string the
     * current grid reads.
     */
    g: LedgerRow;
    /** The raw view row, kept for the keyset cursor and for anything the string view drops. */
    raw: ProductionEventRow;
    /** 1-based position in the CURRENT VIEW — a fact about the sheet, not the database. */
    num: number;
    /** IN / OUT / DVO / none, by the ledger's own rule (warehouse first, then disposition). */
    dir: RowDirection;
}

export type ProductionItem = GridRow<ProductionGridRow>;

// ═══ The column table ═══════════════════════════════════════════════════════════

interface ProdCol {
    key: string;
    label: string;
    title?: string;
    width: number;
    pin?: 'start' | 'end';
    /** The field this column reads. `null` ⇒ derived (the row ordinal). */
    field: ProductionField | null;
    numeric?: boolean;
    summaryLane?: SummaryLane;
    /** The URL filter axis this column belongs to, where it has one. */
    filterColumn?: FilterColumn;
}

/**
 * The 13 columns, left to right, at the live ledger's own widths.
 *
 * Σ width = 1228px, which is the `minWidth` both current grids set — so "never crush,
 * always scroll" produces an identically-sized sheet and a horizontal scrollbar in the
 * same place.
 */
const COLS: readonly ProdCol[] = [
    { key: 'num', label: '#', title: 'Row number in this view', width: 36, pin: 'start', field: null },
    { key: 'recv', label: 'Recv', title: 'Received date', width: 96, pin: 'start', field: 'recv_date' },
    { key: 'prod', label: 'Prod', title: 'Production date', width: 96, pin: 'start', field: 'prod_date' },
    { key: 'batch', label: 'Batch', width: 120, pin: 'start', field: 'batch' },
    { key: 'shift', label: 'Shift', width: 64, field: 'shift_code', filterColumn: 'shift' },
    { key: 'grade', label: 'Grade', width: 80, field: 'grade_code', filterColumn: 'grade' },
    { key: 'plant', label: 'Plant', width: 84, field: 'plant_code', filterColumn: 'plant' },
    { key: 'whse', label: 'Whse', title: 'Warehouse — blank means unplaced', width: 108, field: 'warehouse_code', filterColumn: 'whse' },
    { key: 'source', label: 'Source', title: 'Source location', width: 84, field: 'source_location_code', filterColumn: 'source' },
    { key: 'wt', label: 'Weight', title: 'Weight (kg)', width: 104, field: 'weight_kg', numeric: true, summaryLane: 'figure' },
    { key: 'ccc', label: 'CCC/FLEC', title: 'Disposition — FLEC bagging, or the crusher / kiln it went out to', width: 112, field: 'ccc_flec', filterColumn: 'ccc', summaryLane: 'note' },
    { key: 'flec', label: 'Flec', title: 'Flec count', width: 72, field: 'flec_count', numeric: true, summaryLane: 'total' },
    { key: 'side', label: 'Side', title: 'Warehouse side', width: 72, pin: 'end', field: 'whse_side' },
];

/**
 * Σ of the declared widths — the sheet's honest minimum, and it is 1228px, byte-for-byte
 * the `minWidth` both live grids hard-code. The platform derives its own from the RESOLVED
 * column table (`minTableWidth`), so this constant is not what lays the table out; it is
 * here so a consumer can state the number in a caption and so a width edited here is
 * visibly a width change rather than a silent one.
 */
export const PRODUCTION_MIN_WIDTH = COLS.reduce((sum, c) => sum + c.width, 0);

/** Which columns carry a URL filter, in display order — the header-slot wiring reads this. */
export const PRODUCTION_FILTER_BY_KEY: ReadonlyMap<string, FilterColumn> = new Map(
    COLS.flatMap((c) => (c.filterColumn ? ([[c.key, c.filterColumn]] as [string, FilterColumn][]) : [])),
);

/** The two DATE columns, so a consumer can hang a sort control off exactly those headers. */
export const PRODUCTION_DATE_COLUMNS: ReadonlyMap<string, 'recv_date' | 'prod_date'> = new Map([
    ['recv', 'recv_date'],
    ['prod', 'prod_date'],
]);

const dash = <span className="text-muted-foreground/40">—</span>;

/**
 * The IN/OUT/DVO wash on a PINNED cell — now through `ColumnSpec.cellClass`.
 *
 * ── WHY IT CANNOT GO ON THE `<tr>` (unchanged, and the reason this exists) ──────
 * `rowClassFor` puts classes on the row element, and that is enough for the nine
 * scrolling columns — their `<td>` has no background, so the row's wash shows through.
 * A PINNED `<td>` is different: `cell-classes.ts` gives it a solid `bg-background`,
 * correctly and deliberately (a frozen cell sits over scrolling content and any alpha
 * lets the moving rows bleed through it). An opaque cell background always covers the
 * row's, so a `<tr>`-level tint is invisible on exactly the four identity columns — and
 * the seam between a tinted scrolling half and an untinted frozen half is worse than no
 * tint at all. This is the same reason the live ledger carries TWO tint flavours.
 *
 * ── WHAT CHANGED: THE `-z-10` LAYER IS GONE ─────────────────────────────────────
 * This used to be an extra `<span aria-hidden className="absolute inset-0 -z-10">` emitted
 * from FIVE different `format`s, with the negative z-index load-bearing: a pinned `<td>` is
 * a stacking context, so `-z-10` was what put the wash above the cell's opaque background
 * and below the module's interactive layer, where the selection tint and the active ring
 * live. Get that one utility wrong and a selected pinned cell stopped looking selected.
 *
 * `cellClass` says the same thing without the extra element or the stacking-order trick:
 * the classes are merged UNDER the cached class string on the interactive layer itself, so
 * `selected` / `active` / `invalid` / `dirty` beat the wash by construction rather than by
 * a z-index that had to be remembered five times. Five DOM nodes per row are also five
 * fewer things for `[&>*]` to style and for the browser to lay out.
 *
 * Still the FROZEN flavour of the tint (`rowDirectionFrozenTint`), composited over the
 * cell's opaque base, exactly as the live ledger does it.
 */
function pinnedTintClass(row: ProductionGridRow | null): string | undefined {
    return row ? rowDirectionFrozenTint(row.dir) || undefined : undefined;
}

/** The scrolling half of the same wash — translucent, so hover and selection blend through. */
export function productionRowTint(dir: RowDirection): string {
    return rowDirectionTint(dir);
}

/** A number for the selection pill and the summary lanes. `''` is absent, never 0. */
function numeric(text: string): number | null {
    if (text === '') return null;
    const n = Number.parseFloat(text);
    return Number.isFinite(n) ? n : null;
}

function specFor(col: ProdCol): ColumnSpec<ProductionGridRow, ProductionGridCtx> {
    const field = col.field;
    const base = {
        key: col.key,
        label: col.label,
        title: col.title,
        width: col.width,
        pin: col.pin,
        align: (col.numeric ? 'right' : 'left') as 'left' | 'right',
        summaryLane: col.summaryLane,
        // Declared for the header slot's benefit; the grammar stays in `ledger-url.ts` and
        // the platform still renders no filter UI and holds no filter state.
        filter: col.filterColumn ? ({ kind: 'set' as const, column: col.filterColumn }) : undefined,
        /**
         * COLLISION with the consumer's own header controls (2026-08-20).
         *
         * Both v2 grids hang their URL-driven chrome off `renderHeaderSlot`: a
         * `DateSortSlot` on the two DATE columns and a `ColumnFilterMenu` on the six that
         * carry a `filterColumn`. Those draw the SAME lucide glyphs the platform's built-in
         * sort caret and filter trigger draw, so a focus-scope header rendered two
         * identical carets — or two identical funnels — side by side, opening different
         * things. Worse, they answer different questions: the consumer's controls re-query
         * the SERVER through the URL and survive a reload; the built-ins are local view
         * state over the loaded rows only, and hide every chrome row while active.
         *
         * One control per question. The consumer's stays (it is the one that reaches the
         * data); the built-in is off on exactly the columns that already have one, and
         * every other column keeps both affordances untouched.
         */
        ...(PRODUCTION_DATE_COLUMNS.has(col.key) ? { sortable: false } : {}),
        ...(col.filterColumn ? { filterable: false } : {}),
        /**
         * NO `parse`, and NO `editable`. Together those two omissions are what make the
         * sheet read-only: `columnAcceptsEdit` returns `spec.parse !== undefined` when no
         * `editable` is declared, so every cell refuses to open, refuses a paste and can
         * never become dirty. See the file header — this is the whole write surface, removed
         * in one place.
         */
        // A run of figures is the most useful thing on a sheet to sweep and add up, so
        // every column may be covered by a rectangle EXCEPT the row ordinal, which has no
        // arithmetic meaning and is not a coordinate at all.
        selectable: field !== null,
        numericValue: col.numeric
            ? (row: ProductionGridRow) => numeric(row.g[field as ProductionField])
            : undefined,
        /**
         * A COPY puts the STORED value on the clipboard, never the rendering. `Weight`
         * renders `18,650` and copies `18650`, so a copied column pastes back into Excel as
         * numbers rather than as text the spreadsheet has to be told to reparse.
         */
        clipboardValue:
            field !== null ? (row: ProductionGridRow) => row.g[field] : undefined,
        calcType: col.numeric ? ('SUM' as const) : undefined,
    };

    switch (col.key) {
        case 'num':
            return {
                ...base,
                cellKind: 'derived',
                resizable: false,
                hideable: false,
                cellClass: pinnedTintClass,
                format: (row) => (
                    <span className="w-full text-center font-mono text-[10px] font-bold text-muted-foreground">
                        {row.num}
                    </span>
                ),
            };

        // Both date lanes render `MMM d` — the live grids' `formatDateShort`, reused rather
        // than re-decided, so a side-by-side comparison is comparing rows and not date
        // formats. The full `yyyy-MM-dd` rides in the cell's `title`, which is also what a
        // COPY puts on the clipboard (`clipboardValue` returns the stored ISO string).
        case 'recv':
            return {
                ...base,
                cellKind: 'date',
                cellClass: pinnedTintClass,
                format: (row) => (
                    <span className="font-mono text-xs font-bold" title={row.g.recv_date || undefined}>
                        {formatDateShort(row.g.recv_date) || dash}
                    </span>
                ),
            };

        case 'prod':
            return {
                ...base,
                cellKind: 'date',
                cellClass: pinnedTintClass,
                /* Muted, and often blank — the live ledger paints this lane the same way,
                   because a missing production date is normal rather than a gap. */
                format: (row) => (
                    <span
                        className="font-mono text-xs font-bold text-muted-foreground"
                        title={row.g.prod_date || undefined}
                    >
                        {formatDateShort(row.g.prod_date) || dash}
                    </span>
                ),
            };

        case 'batch':
            return {
                ...base,
                cellClass: pinnedTintClass,
                format: (row) => (
                    <span className="flex w-full min-w-0 items-center gap-1" title={row.g.batch || undefined}>
                        <span className="truncate font-mono text-xs font-bold">{row.g.batch || dash}</span>
                        {row.g.batch_year ? (
                            <span className="shrink-0 font-mono text-[10px] font-bold text-muted-foreground/60">
                                {row.g.batch_year}
                            </span>
                        ) : null}
                    </span>
                ),
            };

        case 'plant':
            return {
                ...base,
                cellKind: 'select',
                format: (row) =>
                    row.g.plant_code ? (
                        <span className={cn(BADGE_BASE, plantBadgeClass(row.g.plant_code))}>{row.g.plant_code}</span>
                    ) : (
                        dash
                    ),
            };

        case 'whse':
            return {
                ...base,
                cellKind: 'select',
                format: (row) =>
                    row.g.warehouse_code ? (
                        <span className="font-mono text-xs font-bold">{row.g.warehouse_code}</span>
                    ) : (
                        // "Unplaced" is a real state, not a missing value — the live ledger
                        // says the word rather than drawing a dash.
                        <span className="text-muted-foreground/40">unplaced</span>
                    ),
            };

        case 'ccc':
            return {
                ...base,
                format: (row) =>
                    row.g.ccc_flec ? (
                        <span className={cn(BADGE_BASE, cccFlecBadgeClass(row.g.ccc_flec))}>{row.g.ccc_flec}</span>
                    ) : (
                        dash
                    ),
            };

        case 'wt':
            return {
                ...base,
                cellKind: 'number',
                format: (row) => (
                    <span className="font-mono text-xs font-bold tabular-nums">{formatKg(row.g.weight_kg)}</span>
                ),
            };

        case 'flec':
            return {
                ...base,
                cellKind: 'number',
                format: (row) => (
                    <span className="font-mono text-xs font-bold tabular-nums text-muted-foreground">
                        {row.g.flec_count}
                    </span>
                ),
            };

        case 'side':
            return {
                ...base,
                cellKind: 'select',
                cellClass: pinnedTintClass,
                format: (row) => (
                    <span className="font-mono text-xs font-bold">{row.g.whse_side || dash}</span>
                ),
            };

        // Shift / Grade / Source — plain codes, dropdowns in the live ledger.
        default:
            return {
                ...base,
                cellKind: 'select',
                format: (row) => (
                    <span className="font-mono text-xs font-bold">
                        {(field !== null ? row.g[field] : '') || dash}
                    </span>
                ),
            };
    }
}

/**
 * The resolved specs. A module-level constant, so the array identity never changes and no
 * consumer needs a `useMemo` to keep the column resolution from re-running.
 */
export const PRODUCTION_SPECS: readonly ColumnSpec<ProductionGridRow, ProductionGridCtx>[] =
    COLS.map(specFor);

// ═══ Row families ═══════════════════════════════════════════════════════════════

/**
 * The slots one production event occupies.
 *
 * A production ledger has exactly ONE data family — there is no child sub-row here, which
 * is why `occupies()` is a plain map lookup rather than the two-family question it answers
 * on the RC Deliveries sheet. What it still has to say is the thing `CellSlot` was split
 * for: the `#` column RENDERS content (the row ordinal, and it carries the pinned wash)
 * and the caret must never stop on it. `addressable: false` is the middle answer — the
 * cell paints, tints, copies and may be swept into a selection, and only the keyboard
 * steps over it.
 *
 * **`editable` is the ROW's honest half of the verdict**, so every field-bearing lane says
 * `true`: on a production event these twelve fields ARE writable, and that is a fact about
 * the domain rather than about this grid's settings. The COLUMN's half is missing on
 * purpose (no `parse`), and the two are ANDed inside the module — so the sheet is
 * read-only while the row model stays true, which is exactly what a later editing pass
 * needs to find here.
 */
const EVENT_SLOTS: ReadonlyMap<string, CellSlot> = new Map(
    COLS.map((col) => [
        col.key,
        col.field === null
            ? { field: 'num', editable: false, addressable: false }
            : { field: col.field, editable: true },
    ]),
);

/** Row-family → bottom rule. Chrome rows carry their own, heavier, boundaries. */
export const PRODUCTION_ROW_RULES: Record<string, string> = {
    event: 'border-b border-b-border/30',
    spacer: 'border-b border-b-border',
    'group-header': 'border-b border-b-border/40',
    summary: 'border-b border-b-border/60',
};

/**
 * The four families. A module-level constant for the same reason the specs are.
 *
 * Only `event` is addressable. A spacer, a heading and a rule-off are real rows of the
 * spreadsheet but they are not coordinates, so none of them enters `navRows` and the
 * keyboard space is byte-identical with and without them.
 */
export const PRODUCTION_KINDS: ReadonlyMap<string, RowKind<ProductionGridRow>> = new Map<
    string,
    RowKind<ProductionGridRow>
>([
    [
        'event',
        {
            kind: 'event',
            height: ROW_H,
            addressable: true,
            occupies: (colKey) => EVENT_SLOTS.get(colKey) ?? null,
        },
    ],
    ['group-header', { kind: 'group-header', height: GROUP_HEADER_H, addressable: false, occupies: () => null }],
    ['summary', { kind: 'summary', height: DAY_TOTAL_H, addressable: false, occupies: () => null }],
    ['spacer', { kind: 'spacer', height: DAY_SPACER_H, addressable: false, occupies: () => null }],
]);

// ═══ Canonical cell text ════════════════════════════════════════════════════════

/**
 * What a cell HOLDS, as text.
 *
 * On a read-only sheet this feeds exactly two things: the jump keys' `filled` probe
 * (Ctrl+Arrow runs to the end of a block of non-empty cells) and the clipboard fallback
 * for any column that declares no `clipboardValue`. It is not an editor seed, because no
 * editor can open.
 *
 * `#` returns the ordinal rather than `''` — a column of row numbers that read as blank
 * would make Ctrl+Arrow treat the frozen block as a gap.
 */
export function productionStoredText(
    byRowId: ReadonlyMap<string, ProductionGridRow>,
    rowId: string,
    field: string,
): string {
    const row = byRowId.get(rowId);
    if (!row) return '';
    if (field === 'num') return String(row.num);
    const v = row.g[field as keyof LedgerRow];
    return typeof v === 'string' ? v : '';
}

// ═══ The flatten ════════════════════════════════════════════════════════════════

/** What a chrome row renders. Keyed by the chrome item's own `key`. */
export type ProductionChrome =
    | { kind: 'heading'; label: string; sub: string }
    | { kind: 'day-total'; rows: number; kg: number; flec: number }
    | { kind: 'day-gap' };

export interface ProductionTotals {
    rows: number;
    kg: number;
    flec: number;
}

export interface ProductionFlattened {
    items: ProductionItem[];
    chrome: Map<string, ProductionChrome>;
    totals: ProductionTotals;
}

/** Which date column the sheet is grouped (and, in focus, sorted) by. */
export type ProductionGroupField = 'recv_date' | 'prod_date';

function dayLabel(iso: string): string {
    if (!iso) return 'Undated';
    const d = parseISO(iso);
    return isValid(d) ? formatDateFns(d, 'EEEE · yyyy-MM-dd').toUpperCase() : iso;
}

function monthLabel(iso: string): string {
    if (!iso) return 'Undated';
    const d = parseISO(iso);
    return isValid(d) ? formatDateFns(d, 'MMMM yyyy').toUpperCase() : iso.slice(0, 7);
}

/**
 * Rows → the flat item array, and the ONE place the shape of the sheet is decided.
 *
 * The two scopes group differently, and each mirrors what its current grid already does:
 *
 *   • **focus** is one period — one month — so the useful boundary is the DAY. Each day
 *     gets a heading and a `Σ DAY TOTAL` rule-off, and the period's own totals ride out
 *     in `totals` for the sticky footer.
 *   • **endless** spans years, so a MONTH boundary gets a heading (the live endless sheet
 *     marks it with an inline month label and a top rule) and a DAY boundary inside a
 *     month gets a literal BLANK ROW. Never both: a month boundary is also a day boundary,
 *     and two chrome rows at one seam reads as a bug.
 *
 * `needsGroupSpacer` owns the "never a leading gap at the top of the sheet" rule —
 * `prevKey === undefined` is the whole of it — so the first row of a window is never
 * preceded by a spacer whatever group it is in.
 */
export function flattenProductionRows(
    rows: readonly ProductionEventRow[],
    scope: 'endless' | 'focus',
    groupField: ProductionGroupField = 'recv_date',
): ProductionFlattened {
    const items: ProductionItem[] = [];
    const chrome = new Map<string, ProductionChrome>();
    const totals: ProductionTotals = { rows: 0, kg: 0, flec: 0 };

    // Counted once up front — a `filter` inside the row loop would make this quadratic.
    const dayCounts = new Map<string, number>();
    const monthCounts = new Map<string, number>();
    const converted = rows.map((raw, i) => {
        const g = toGridRow(raw);
        const day = g[groupField] ?? '';
        dayCounts.set(day, (dayCounts.get(day) ?? 0) + 1);
        const month = day.slice(0, 7);
        monthCounts.set(month, (monthCounts.get(month) ?? 0) + 1);
        return { raw, g, day, month, num: i + 1, dir: rowDirection(g) };
    });

    let prevDay: string | undefined;
    let prevMonth: string | undefined;
    let openDay = '';
    let dayRows = 0;
    let dayKg = 0;
    let dayFlec = 0;

    const closeDay = () => {
        if (scope !== 'focus' || dayRows === 0) return;
        const key = `total:${openDay || 'undated'}`;
        items.push({ kind: 'summary', key });
        chrome.set(key, { kind: 'day-total', rows: dayRows, kg: dayKg, flec: dayFlec });
        dayRows = 0;
        dayKg = 0;
        dayFlec = 0;
    };

    for (const rec of converted) {
        if (scope === 'focus') {
            if (needsGroupSpacer(prevDay, rec.day) || prevDay === undefined) {
                closeDay();
                openDay = rec.day;
                const key = `day:${rec.day || 'undated'}`;
                items.push({ kind: 'group-header', key });
                const n = dayCounts.get(rec.day) ?? 0;
                chrome.set(key, {
                    kind: 'heading',
                    label: dayLabel(rec.day),
                    sub: `${n} row${n === 1 ? '' : 's'}`,
                });
            }
        } else if (needsGroupSpacer(prevMonth, rec.month) || prevMonth === undefined) {
            // A month boundary — including the very first row of the window, which is the
            // one place a heading IS wanted at the top (it names what you are looking at).
            const key = `month:${rec.month || 'undated'}`;
            items.push({ kind: 'group-header', key });
            const n = monthCounts.get(rec.month) ?? 0;
            chrome.set(key, {
                kind: 'heading',
                label: monthLabel(rec.day),
                sub: `${n} row${n === 1 ? '' : 's'} loaded`,
            });
        } else if (needsGroupSpacer(prevDay, rec.day)) {
            const key = `gap:${rec.raw.id ?? rec.num}`;
            items.push({ kind: 'spacer', key });
            chrome.set(key, { kind: 'day-gap' });
        }

        prevDay = rec.day;
        prevMonth = rec.month;

        items.push({
            kind: 'event',
            id: rec.raw.id ?? `row-${rec.num}`,
            data: { g: rec.g, raw: rec.raw, num: rec.num, dir: rec.dir },
        });

        const kg = numeric(rec.g.weight_kg) ?? 0;
        const flec = numeric(rec.g.flec_count) ?? 0;
        totals.rows++;
        totals.kg += kg;
        totals.flec += flec;
        dayRows++;
        dayKg += kg;
        dayFlec += flec;
    }
    closeDay();

    return { items, chrome, totals };
}

// ═══ Chrome row rendering ═══════════════════════════════════════════════════════

/**
 * A `Σ DAY TOTAL` cell treatment — a SOLID `bg-muted`, never glass. A chrome row is inside
 * the body, so it scrolls over data rows and any alpha would let them read through it.
 */
export const TOTAL_CELL =
    'border-b border-border/60 border-t-2 border-t-foreground/45 bg-muted py-1 align-middle text-foreground';
/** A day / month heading. Same rule: opaque. */
export const HEADING_CELL = 'h-6 border-b border-border/40 bg-muted/25 px-2 py-1';

/** Integer counts (the flec lane) — never a fraction, and blank rather than a bare `0`. */
export function formatFlec(n: number): string {
    return n === 0 ? '' : n.toLocaleString('en-US', { maximumFractionDigits: 0 });
}

/** A SUMMED kg figure, through the ledger's own cell formatter so a total reads as a cell. */
export function formatKgTotal(n: number): string {
    return formatKg(String(n));
}

// Re-exported so the two v2 grids reach the ledger's kg formatter through this one adapter
// rather than each importing the 1,771-line client component for itself.
export { formatKg };

type ChromeApi = TableChromeRowApi<ProductionGridRow, ProductionGridCtx>;

/**
 * The DAY BOUNDARY, as an actual empty row of the spreadsheet.
 *
 * Renzo, on the first attempt at this in another module: *"It should be literally just an
 * empty row, not some made up effect on screen… Just place an actual row in between days."*
 * So: ONE `<td>` PER COLUMN rather than a spanning cell — a `colSpan` erases the vertical
 * rules, which is exactly what gives a fake spacer away — and the pinned block behaves
 * exactly as a data row's does.
 *
 * **Both pinned runs are handled, and both are FULLY OPAQUE.** A pinned cell sits over
 * scrolling content, so an alpha background lets the moving rows read through the gap. The
 * `frozen-edge` seam goes on the LAST start-pinned column and the FIRST end-pinned one —
 * the same two positions `BlackwoodTable` marks on its header, so the gap row's edges line
 * up with every other row's instead of being a second opinion about where the block ends.
 */
export function renderDayGapCells(api: ChromeApi): React.ReactNode {
    const left = pinnedOffsets(api.cols);
    const right = pinnedEndOffsets(api.cols);
    const endStart = api.cols.length - right.length;
    return (
        <>
            {api.cols.map((c, ci) => {
                const startPinned = ci < left.length;
                const endPinned = ci >= endStart;
                return (
                    <td
                        key={c.key}
                        aria-hidden="true"
                        className={cn(
                            'border-b border-b-border border-r border-r-border p-0 align-middle',
                            (startPinned || endPinned) && 'frozen-col bg-background',
                            ((startPinned && ci === left.length - 1) || (endPinned && ci === endStart)) &&
                                'frozen-edge',
                        )}
                        style={{
                            height: DAY_SPACER_H,
                            ...(startPinned ? { left: left[ci] } : {}),
                            ...(endPinned ? { right: right[ci - endStart] } : {}),
                        }}
                    />
                );
            })}
        </>
    );
}

/** A day (focus) or month (endless) heading — one spanning cell, the full width. */
export function renderHeadingCell(
    api: ChromeApi,
    payload: Extract<ProductionChrome, { kind: 'heading' }>,
): React.ReactNode {
    return (
        <td colSpan={api.colCount} className={HEADING_CELL}>
            <span className="font-mono text-[11px] font-bold uppercase tracking-wide text-muted-foreground">
                {payload.label}
                <span className="ml-2 font-normal normal-case text-muted-foreground/60">{payload.sub}</span>
            </span>
        </td>
    );
}

/**
 * `Σ DAY TOTAL`, tiled on the DECLARED summary lanes.
 *
 * The spans come off the RESOLVED column table (`api.spans`), so hiding or resizing a
 * column moves the figures with it rather than leaving them behind. **A lane of span 0
 * renders NO cell at all** — `colSpan={0}` means "to the end of the column group" in HTML,
 * which is the opposite of nothing — and the five lanes always tile to `cols.length`.
 */
export function renderDayTotalCells(
    api: ChromeApi,
    payload: Extract<ProductionChrome, { kind: 'day-total' }>,
): React.ReactNode {
    const s = api.spans;
    const figure = cn(TOTAL_CELL, 'px-2 text-right font-mono text-[11px] font-bold tabular-nums');
    return (
        <>
            <td colSpan={s.label} className={cn(TOTAL_CELL, 'px-2')}>
                <span className="font-mono text-[11px] font-bold uppercase tracking-wide">
                    Σ Day · {payload.rows} row{payload.rows === 1 ? '' : 's'}
                </span>
            </td>
            {s.weight > 0 ? (
                <td colSpan={s.weight} className={figure}>
                    {formatKgTotal(payload.kg)}
                </td>
            ) : null}
            {s.note > 0 ? <td colSpan={s.note} className={cn(TOTAL_CELL, 'px-2')} /> : null}
            {s.total > 0 ? (
                <td colSpan={s.total} className={figure}>
                    {formatFlec(payload.flec)}
                </td>
            ) : null}
            {s.trailing > 0 ? <td colSpan={s.trailing} className={TOTAL_CELL} /> : null}
        </>
    );
}
