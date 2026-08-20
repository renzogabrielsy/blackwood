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
    /**
     * A RICH header label — two lines, a unit under a name, a small icon beside it.
     *
     * `label` stays a plain `string` and stays REQUIRED, because three things read it as
     * text and none of them can render a node: the header's `title` tooltip, the resize
     * handle's `aria-label`, and any consumer building a column menu. So this is the
     * node and `label` is the name; supplying one never removes the other.
     *
     * Absent ⇒ `label` renders, byte-identical with before this field existed.
     */
    labelNode?: React_Node;
    /**
     * May the header label WRAP instead of truncating?
     *
     * The header is one `<th>` of a fixed pixel width and its label has always been
     * `truncate`, so a column named for something long — a batch code, a plate, a date
     * with a unit — read as `JAN-26-B…` and the operator had to hover every one of them
     * to tell two columns apart. With this set the label takes up to two lines and the
     * header row grows to fit the tallest.
     *
     * Defaults to false — one line, truncated, exactly as before.
     */
    headerWrap?: boolean;
    /**
     * A SECOND LINE under the label, smaller and muted.
     *
     * The header is one `<th>` with one name in it, so a column that is genuinely two
     * facts — a block location and the batch code stored in it, a plate and the reading
     * taken from it — had to spell both into `label` and watch the whole thing truncate.
     * `labelNode` can render two lines, but it is an escape hatch a consumer has to build:
     * this is the shape every such column actually wants, declared rather than drawn.
     *
     * **Rendered whenever it is present, independently of `headerWrap`.** They answer
     * different questions — `headerWrap` is "may the NAME take a second line", this is "the
     * name has a subtitle" — and a column may want either, both or neither. Omit it and
     * the header is one line, byte-identical with before it existed.
     *
     * A plain `string`, like `label` and for the same reason: it is text a tooltip and a
     * column menu can read. Use `labelNode` for anything richer.
     */
    subLabel?: string;
    /** Long form for the header's `title` when the label is an abbreviation. */
    title?: string;
    align?: 'left' | 'right' | 'center';
    cellKind?: CellKind;
    /**
     * What a click on the header LABEL does, INSTEAD of sweeping the column.
     *
     * Column-selection is the right default and the wrong behaviour for a header that
     * names a thing rather than a lane: a matrix whose columns are physical blocks opens
     * that block's detail when its header is clicked, and sweeping 400 cells is not what
     * the operator asked for. Present ⇒ this runs and the sweep does not happen at all.
     *
     * It replaces ONLY the label's own click. The sort caret and the filter trigger beside
     * it stay separately clickable, because a header that opens a drawer still has to be
     * sortable — they are different affordances in the same cell, and each keeps its own.
     *
     * Absent ⇒ the label sweeps the column, exactly as before.
     */
    onHeaderClick?(spec: ColumnSpec<Row, Ctx>): void;

    // ── Display / edit round trip ────────────────────────────────────────────────
    /** What the cell shows at rest. */
    format(row: Row, ctx: Ctx): React_Node;
    /** What the cell shows once it has FOCUS — the formula, not the result. */
    editText?(row: Row, ctx: Ctx): string;
    /**
     * What a cell carrying an UNSAVED value shows at rest.
     *
     * A dirty cell cannot render through `format`, which reads the STORED row — that was
     * the defect fixed in `Row.tsx`, and the fix renders the raw text instead. Raw text is
     * right for most columns and wrong for any column whose stored form is a DERIVATION of
     * what is typed: an arithmetic weight cell shows `=27045*88%` where every other row in
     * the lane shows a right-aligned figure, so the column loses its alignment and reads
     * as broken until the sheet is saved.
     *
     * It receives the text and nothing else, deliberately: it runs on the row render path,
     * and a cell context object would be an allocation per dirty cell per render for an
     * answer no such formatter needs (a lane's derivation does not change with the row
     * family). Omit it and the raw text renders, byte-identical with before it existed.
     */
    formatEdited?(text: string, ctx: Ctx): React_Node;
    /**
     * THE commit verdict, and the only one. Returns the patch to apply, or a refusal
     * the UI shows verbatim. Used by an inline commit AND by a paste, so a value typed
     * and the same value pasted can never be judged differently.
     *
     * `cell` says WHICH cell is being judged — see `CellContext`, and note that a column
     * can mean two different things on two row families, so a verdict that ignores it can
     * be flatly wrong on a child row. Optional and ignorable: a `parse` written before it
     * existed behaves exactly as it did.
     */
    parse?(text: string, ctx: Ctx, cell?: CellContext<Row>): ColumnParseResult;
    /**
     * Canonicalise what the operator COMMITTED, before it is written.
     *
     * Applied once, inside the single writer's commit, so every commit path — Enter, Tab,
     * a click on another cell, a blur out of the grid — stores the same thing, and what
     * the operator sees from that moment on is what will be saved. A date cell that turns
     * `6/27` into `2026-06-27` is the canonical case: without it the sheet holds two
     * spellings of one value (the typed one and the one `cleanPasted` produced for the
     * same text arriving on the clipboard), and a shorthand equal to the stored value can
     * never stop counting as dirty.
     *
     * It may NOT refuse — that is `parse`'s job, which runs immediately afterwards on
     * whatever this returns. Returning the text unchanged is always legal, and omitting it
     * is byte-identical with the behaviour before it existed.
     */
    normalize?(text: string, ctx: Ctx, cell?: CellContext<Row>): string;

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
    /**
     * Is this column part of **Copy row**? Defaults to true.
     *
     * "Copy row" means "give me this record", and a sheet may carry columns that are not
     * part of the record at all — a status rail, an actions cluster, a selection tick. RC
     * IN's STATE column is the case that found this: pasting a copied row into a
     * spreadsheet produced a leading cell of decoration nobody wanted, every time.
     *
     * **It narrows the ROW-COPY path and nothing else.** An ordinary rectangle copy
     * (Ctrl/Cmd+C, or Copy / Copy with headers over a swept range) is untouched: if the
     * operator deliberately sweeps the column, they asked for it and they get it. The rule
     * is only ever applied to a gesture that says "the whole row" without naming columns.
     */
    rowCopy?: boolean;
    /** Strip whatever rendering a spreadsheet copied in with a pasted value. */
    cleanPasted?(raw: string, ctx: Ctx): string;

    /**
     * Extra classes for THIS cell's interactive layer — how a consumer tints a WHOLE
     * CELL rather than painting a badge inside `format`.
     *
     * The gap it closes: `cell-classes.ts` owns every `<td>`'s className, so an
     * out-of-band lab reading could only be marked by rendering a coloured pill *inside*
     * the cell — which is what Renzo saw and rejected ("I want the entire cell tinted").
     * The same seam is what lets a row-status wash reach a PINNED cell, which a class on
     * the `<tr>` structurally cannot: a frozen cell is opaque by design, so any row tint
     * is covered on exactly the columns that are pinned.
     *
     * **PRECEDENCE: it layers UNDER the cell's own states.** The returned classes are
     * merged BEFORE the cached class string, so `selected`, `active`, `invalid` and
     * `dirty` all win — a selected out-of-band cell still reads as selected, and a
     * refused cell still reads as refused. That ordering is the whole safety property:
     * a consumer cannot accidentally hide the states the operator navigates by.
     *
     * **It costs one `twMerge` for every cell that returns a string.** The cached class
     * table is keyed on enums and this is consumer-provided free text, so it cannot go
     * through the cache; it is merged on top instead. A column that returns `undefined`
     * — which is nearly every cell of nearly every column — pays nothing at all.
     *
     * `row` is null on a row that exists nowhere yet (a draft).
     */
    cellClass?(row: Row | null, ctx: Ctx): string | undefined;

    // ── Chrome ───────────────────────────────────────────────────────────────────
    calcType?: CalcType;
    /**
     * May the operator SORT by this column from its header? Defaults to true, except on a
     * `derived` column (a row ordinal, an actions cluster), which has nothing to order by.
     *
     * The built-in sort is CLIENT-SIDE, over the rows currently loaded — so a consumer
     * whose window is a server keyset sets this false, or leaves the whole affordance off
     * with the table-level `enableSort`. See `lib/table/view.ts`.
     */
    sortable?: boolean;
    /** May the operator FILTER on this column from its header? Same default, same reason. */
    filterable?: boolean;
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

/**
 * WHICH cell a column-level verdict is about.
 *
 * A `ColumnSpec` describes a lane, but a lane is not the same thing on every row family:
 * `RowKind.occupies()` may hand back a DIFFERENT `field` for the same column on a child
 * row, and when it does, the two cells mean different things and must be judged
 * differently. `parse(text, ctx)` alone cannot tell them apart, so a column whose parent
 * cell resolves a value against a closed domain would refuse the free text that is
 * perfectly legal in its child's lane — and the operator would be locked out of a cell
 * with a persistent refusal and no way to satisfy it.
 *
 * `field` is therefore the load-bearing member: it is the slot's own answer, the same one
 * every edit is filed under. The rest is context a verdict may want and can ignore.
 *
 * This is `occupies()`'s insight one level further in, and the same shape as
 * `CellSlot.addressable`: two questions that were being answered with one value.
 */
export interface CellContext<Row> {
    /** The field `RowKind.occupies()` named for this cell — what distinguishes families. */
    field: string;
    /** The row family's `kind` name. */
    kind: string;
    rowId: string;
    /** The stored row, or null for a row that exists nowhere yet (a draft). */
    row: Row | null;
}

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
