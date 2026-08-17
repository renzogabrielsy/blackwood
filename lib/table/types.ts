// ─────────────────────────────────────────────────────────────────────────────────
// Blackwood Table — the PORT.
//
// PLATFORM LAYER. Pure module: no React, no Supabase, no `'use client'`, no tenant
// knowledge. Nothing here may mention charcoal, pesos, suppliers, batches or moisture.
//
// This is the Grafana-style data-frame contract from CLAUDE.md, applied to a grid: the
// table is the application CORE, these interfaces are its PORTS, and a consuming module
// writes the ADAPTER that fills them. A consumer describes its columns, its row shapes
// and where its data comes from; it never reaches inside the table, and the table never
// learns what the data means.
//
// Three contracts, and they answer three different questions:
//
//   • `ColumnSpec`  — what IS this column? (width, alignment, how to render, how to
//                     parse, whether it can be edited, summed, filtered, copied)
//   • `RowKind`     — what shape is THIS row? Above all `occupies(colKey)`: a table with
//                     more than one row family (a receipt and its lab sub-rows, a shift
//                     and its runs) has rows that do not agree about which columns they
//                     have, and every keyboard move, every paste and every selection
//                     total has to ask that question per cell.
//   • `DataSource`  — where do rows come from and where do edits go?
//
// The five domain switches these replace are named in `docs/universal-table/01-audit…`
// §C.1 under ENTANGLED: `isSelectableColumn`, `columnCalcType`, `getNumericCellValue`,
// `clipboardCellText` and `cleanPastedCell` were each a `switch` over the same hard-coded
// column keys, in five different files. They are fields on the spec now, so a column
// carries its own answers and adding one cannot leave four other files behind.
// ─────────────────────────────────────────────────────────────────────────────────

// ═══ Geometry — the minimum a column must declare to be laid out ════════════════

/**
 * The part of a column the geometry helpers need. Split out from `ColumnSpec` so the
 * pure layout maths in `geometry.ts` can be asserted against a two-property literal
 * rather than a fully-populated spec.
 *
 * **`pin` replaces the old `frozen: boolean`.** A boolean could only ever describe a
 * PREFIX — the helpers walked from index 0 and stopped at the first unfrozen column —
 * so a right-pinned actions column was inexpressible. Pinned columns must still form a
 * contiguous run at each end (that is what `position: sticky` can actually paint); a
 * `pin` in the middle simply ends the run and is treated as unpinned.
 */
export interface ColumnGeometry {
    /** Explicit pixel width. Never a fraction — see "never crush, always scroll". */
    width: number;
    /** Pinned to which edge of the scrollport, if any. */
    pin?: 'start' | 'end';
}

/** Where a figure in a summary row (a totals rule-off, a sticky footer) belongs. */
export type SummaryLane = 'label' | 'figure' | 'note' | 'total';

/** How a column offers to filter itself. The grammar lives in the consumer's URL module. */
export type FilterKind = 'set' | 'text' | 'range' | 'dateRange';

/** What the floating selection pill does with a run of this column's values. */
export type CalcType = 'SUM' | 'AVERAGE';

/**
 * What KIND of editor a cell wants. The table uses this to pick an editor and to decide
 * a few interaction details; the actual parse/format always goes through the spec's own
 * `parse` / `format`, so a consumer is never limited to what this union imagined.
 */
export type CellKind =
    | 'text'
    | 'number'
    | 'date'
    | 'select'
    /** Shows arithmetic on focus and a value on blur (the consumer supplies the engine). */
    | 'formula'
    /** Never editable, but may still be SELECTED — a DB-computed total, say. */
    | 'readonly'
    /** Not editable and not addressable — a row ordinal. */
    | 'derived';

// ═══ The column spec ════════════════════════════════════════════════════════════

/**
 * One column, completely described.
 *
 * `Row` is the consumer's row type; `Ctx` is whatever ambient state its callbacks need
 * (a price-visibility flag, a dimension list, the focused period). Everything is
 * optional except the identity, the geometry and how to render — a read-only display
 * column is four fields.
 */
export interface ColumnSpec<Row, Ctx = unknown> extends ColumnGeometry {
    /**
     * Stable identity. Used in URL filter params, in per-user column settings and as
     * half of an `invalidCells` key — so renaming one is a breaking change for a saved
     * layout, exactly as renaming a database column would be.
     */
    key: string;
    label: string;
    /** Long form for the header's `title` when the label is an abbreviation. */
    title?: string;
    align?: 'left' | 'right' | 'center';
    cellKind?: CellKind;

    // ── Display / edit round trip ────────────────────────────────────────────────
    /** What the cell shows at rest. */
    format(row: Row, ctx: Ctx): React_Node;
    /** What the cell shows once it has FOCUS — the formula, not the result. */
    editText?(row: Row, ctx: Ctx): string;
    /**
     * THE commit verdict, and the only one. Returns the patch to apply, or a refusal
     * the UI shows verbatim. Used by an inline commit AND by a paste, so a value typed
     * and the same value pasted can never be judged differently.
     */
    parse?(text: string, ctx: Ctx): ColumnParseResult;

    // ── Capabilities, declared rather than switched on ───────────────────────────
    /** May this cell be edited right now? Absent ⇒ editable iff `parse` exists. */
    editable?(row: Row | null, ctx: Ctx): boolean;
    /**
     * Does this column exist for this viewer at all? A hidden column is ABSENT from the
     * coordinate space — never blanked — so the keyboard has no unreachable holes, the
     * min-width stays honest, and a filter or a copy can never address it. This is how
     * a price boundary reaches the grid: the SERVER decides, the table only obeys.
     */
    visible?(ctx: Ctx): boolean;
    /**
     * May a rectangular selection cover it? Defaults to "yes if it is addressable".
     * Setting it true on a read-only column is deliberate and useful — a run of
     * computed totals is the most useful thing on a sheet to add up.
     */
    selectable?: boolean;
    /** The number the selection pill should total. Null ⇒ this cell has no number. */
    numericValue?(row: Row): number | null;
    /**
     * What a COPY puts on the clipboard — the STORED value, never the edit text and
     * never the on-screen rendering. A spreadsheet wants the fact, not the derivation.
     */
    clipboardValue?(row: Row): string;
    /** Strip whatever rendering a spreadsheet copied in with a pasted value. */
    cleanPasted?(raw: string, ctx: Ctx): string;

    // ── Chrome ───────────────────────────────────────────────────────────────────
    calcType?: CalcType;
    filter?: { kind: FilterKind; column: string };
    summaryLane?: SummaryLane;
    /** Per-user column layout. All default to true. */
    resizable?: boolean;
    reorderable?: boolean;
    hideable?: boolean;
}

/**
 * Structural stand-in for `React.ReactNode`, so this module stays free of a React
 * import. A consumer passing real JSX satisfies it; nothing here inspects it.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type React_Node = any;

/** A refusal carries a sentence for the operator; success carries the patch to apply. */
export type ColumnParseResult =
    | { ok: true; patch: Record<string, unknown> }
    | { ok: false; error: string };

// ═══ Rows ═══════════════════════════════════════════════════════════════════════

/**
 * What a row family HAS at one column — the answer `occupies()` gives.
 *
 * **`addressable` separates "this row renders content here" from "the caret may land
 * here", and they are genuinely different questions.** A row ordinal, a database-computed
 * total and a derived status badge all carry real content that must be painted, copied and
 * (for a total) swept into a selection — while a keyboard run must walk straight past
 * them, because there is nothing there to do.
 *
 * Before this field, `occupies()` answered both with one value: returning `null` blanked
 * the cell (the renderer only calls `format` where a slot exists), and returning a slot
 * made it a stop in every Tab run. A consumer with a content-bearing, caret-free column
 * could only pick which of the two defects it preferred.
 *
 * It is the PER-CELL twin of `RowKind.addressable`, which is per-ROW, and of
 * `ColumnSpec.selectable`, which is per-COLUMN. This is the granularity gap `occupies()`
 * itself was introduced to close (BUG-024), one level further in.
 */
export interface CellSlot {
    /** The field this cell reads and writes — the key every edit is filed under. */
    field: string;
    /** May it be edited, as far as the ROW FAMILY is concerned? */
    editable: boolean;
    /**
     * May the caret land here?
     *
     * **Defaults to `true`, and omitting it is byte-identical with the behaviour before
     * this field existed** — which is what keeps the seam purely additive. Set it false
     * for a cell that has content but no keyboard business: the cell still renders, still
     * tints, still copies and may still be swept into a selection, and only the caret
     * (arrows, Tab, Enter, the jump keys and `apiRef.goToRow`) steps over it.
     */
    addressable?: boolean;
}

/**
 * A row FAMILY — what shape rows of this kind have.
 *
 * `occupies()` is the whole point, and the thing the old code never had. A ledger that
 * interleaves records, their child sub-rows and blank draft rows has rows that disagree
 * about which columns they have. Without a per-row answer, a paste mapped block rows onto
 * nav rows by ARITHMETIC and scattered cells into the sub-rows while reporting success
 * (BUG-024), and the keyboard needed a bespoke resolver.
 */
export interface RowKind<Row = unknown> {
    /** Open string, never a closed union — a new family must not be a compile error. */
    kind: string;
    /** Explicit row height in px. Virtualisation measures nothing. */
    height: number;
    /** The bottom-rule class for this family (weights differ: parent vs child vs draft). */
    rule?: string;
    /**
     * Which column this family occupies, and as what field. `null` ⇒ **this row has no
     * cell there** — nothing is rendered, the keyboard steps over it, a paste skips it,
     * the pill ignores it, and no tint is painted.
     *
     * A slot with `addressable: false` is the middle answer: the cell RENDERS but the
     * caret never lands on it. See `CellSlot`.
     */
    occupies(colKey: string, row: Row | null): CellSlot | null;
    /**
     * Can the keyboard land on this family at all? Group spacers, headings and summary
     * rows are `false` and never enter the coordinate space — which is what keeps the
     * caret from ever resting on one.
     *
     * Whole-ROW. The per-CELL question is `CellSlot.addressable`; a family may be
     * addressable and still have individual cells the caret must skip.
     */
    addressable: boolean;
}

/** One rendered row: a record (possibly with children), a draft, or pure chrome. */
export type GridRow<Row> =
    | { kind: string; id: string; data: Row; children?: GridRow<Row>[] }
    | { kind: 'draft'; id: string }
    | { kind: 'spacer' | 'group-header' | 'summary'; key: string };

/** A cell coordinate in the rendered grid. Row index is into the NAV row list. */
export interface CellAddress {
    row: number;
    col: number;
}

/** Unsaved cell text for one row, keyed by field. Raw text, exactly as typed. */
export type FieldEdits = Record<string, string | undefined>;

// ═══ Per-user layout — a PORT, not a provider dependency ════════════════════════

/**
 * Column layout the operator owns. Handed in as a prop with a setter, so the TABLE has
 * no opinion about persistence: one consumer can wire it to `user_table_settings`,
 * another to local state, another to nothing at all.
 */
export interface TableSettings {
    /** Column key → px. Absent ⇒ the spec's declared width. */
    widths?: Record<string, number>;
    /** Column keys in display order. Absent ⇒ spec order. Reorder is within a pin group. */
    order?: string[];
    /** Column keys the operator has hidden. */
    hidden?: string[];
    density?: 'normal' | 'expanded';
    fontSize?: number;
}

// ═══ The data source ════════════════════════════════════════════════════════════

/** Where a window of rows starts from. */
export type WindowAnchor =
    | { kind: 'latest' }
    | { kind: 'period'; year: number; month: number }
    | { kind: 'cursor'; cursor: unknown; direction: 'older' | 'newer' };

export interface WindowResult<Row> {
    rows: Row[];
    hasOlder: boolean;
    hasNewer: boolean;
    /** The SERVER's match count for the current filters — never `rows.length`. */
    totalCount?: number | null;
    notice?: string;
    error?: string;
}

/** One row's verdict from a batch save. Per row, because one bad row is not a failure. */
export type SaveOutcome =
    | 'saved'
    | 'inserted'
    | 'version_conflict'
    | 'forbidden'
    | 'invalid'
    | 'missing';

export interface SaveVerdict {
    /** The client key the input carried, so a verdict can be matched to a row with no id. */
    key: string;
    outcome: SaveOutcome;
    id?: string;
    rowVersion?: number;
    message?: string;
}

/**
 * The adapter the table talks to. The table never imports Supabase, never builds a
 * query and never learns a table name.
 */
export interface DataSource<Row, Lens = unknown> {
    fetchWindow(req: { anchor: WindowAnchor; lens: Lens }): Promise<WindowResult<Row>>;
    saveBatch(inputs: unknown[]): Promise<{ results: SaveVerdict[]; savedCount: number }>;
    deleteRow?(id: string, expectedVersion: number, opts?: unknown): Promise<SaveVerdict>;
    /** Values for `set` filters — the canonical domain, never the loaded window. */
    dimensions?(): Promise<Record<string, { code: string; label: string }[]>>;
    /** The keyset cursor for a row, in the adapter's own ORDER BY. */
    cursorOf(row: Row): unknown;
    identityOf(row: Row): { id: string; version: number | null };
}
