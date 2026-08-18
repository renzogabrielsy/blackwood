// ─────────────────────────────────────────────────────────────────────────────────
// RC Deliveries — the shared vocabulary. PURE module: no 'use client', no React, no
// Supabase. The server page, the server actions and the client grid all import it, so
// every rule below is expressed EXACTLY ONCE.
//
// Two of those rules are the reason this file exists at all.
//
// ── The single-column / multi-field problem ──────────────────────────────────────
// The operators' sheet has ONE supplier column and ONE warehouse column:
//
//     SUPPLIER    BRIX - SOUTH HILONGOS  ·  PALAWAN RANDY PSAU 282509-8
//     WAREHOUSE   WHSE A- LFT            ·  W6 PROD
//
// The database, correctly, does not: a receipt carries `supplier_code` (the cheque
// payee — the whole point of the liquidation feature that comes next), plus the
// free-text `supplier_origin` and the optional `permit_no`; a destination carries
// `destination_code` plus `destination_side`. Excel parity says one cell; the payment
// ledger says three columns.
//
// This is the same shape the production ledger already solved for CCC/FLEC (one
// on-screen column standing in for `disposition_kind` + `partner_equipment_code`), and
// it gets the same answer: a canonical PARSE/FORMAT PAIR, and only a parse/format pair.
// `formatSupplierCell` renders the fields as the sheet writes them; `parseSupplierCell`
// takes them back apart. Every write path — the grid's inline edit, a paste, a future
// bulk import — goes through this pair, so the split can never be expressed a second
// way and drift.
//
// A parse either RESOLVES to a known dimension row or FAILS. It never invents an
// unresolved row: the import was allowed to leave `supplier_code` NULL because it was
// transcribing a workbook nobody can go back and ask about, but a human typing into
// this grid today CAN be asked, so a value that doesn't resolve is refused at save with
// a persistent error naming the row.
//
// ── The formula cell ─────────────────────────────────────────────────────────────
// WT and PHP/KG hold arithmetic, not numbers (`=27045*88%`, `=39.5+2.7`). The parser
// and the round-trip helpers live in `lib/cenapro/rc-formula.ts`; this file only wires
// them to the row shape, in `weightEditText` / `priceEditText` — the two functions that
// decide what an operator sees when the cell takes focus, and therefore the two that
// make an IMPORTED row indistinguishable from one typed this morning.
//
// ── Settlement (liquidation Step 4, 2026-08-06) ──────────────────────────────────
// The liquidation vocabulary is IMPORTED from `../liquidation/types`, not re-declared.
// `settlement_status`, the "not priced yet" wording and the `is_allocatable` affordance
// are DATABASE facts with exactly one correct reading, and both doors onto the allocation
// surface have to agree about them — which they cannot do if each module keeps its own
// copy. Both files are PURE Cenapro tenant modules (no React, no Supabase, no
// 'use client'), so the import crosses no layer and drags nothing into the bundle.
//
// **Settlement is NOT on this module's read model.** `cenapro.view_rc_delivery` was
// deliberately left untouched by the Step 4 migration (60 columns, UI consumers, a
// 116-assertion verify script), so settlement rides ALONGSIDE a receipt on
// `DeliveryRecord.settlement`, fetched in its own round trip exactly the way the moisture
// sub-samples are. That is also why the settlement fields do NOT join `PRICE_FIELDS`:
// they are not fields of `RcDeliveryRow` and `satisfies keyof RcDeliveryRow` would refuse
// them. They are gated one step EARLIER and more strongly instead — the settlement query
// is not issued at all for a viewer who may not see prices. See `loadSettlements` in
// `actions.ts`.
// ─────────────────────────────────────────────────────────────────────────────────

import type { Database } from '@/types/supabase';
// The PLATFORM table core. This module is the first consumer of it: everything generic
// that used to live in this file — the geometry, the clipboard exchange, the dirty rules,
// the draft-row constants — is now `lib/table/`, and what remains here is the DOMAIN
// half. See `.agents/prompts/universal-table-module.md`.
import {
    pinnedOffsets,
    pinnedWidth,
    dragAutoScrollDelta as platformDragAutoScrollDelta,
    countUnsavedWork as platformCountUnsavedWork,
    describeUnsavedWork as platformDescribeUnsavedWork,
} from '@/lib/table';
import type {
    DragScrollInput as PlatformDragScrollInput,
    SummaryLane,
} from '@/lib/table';
import type { DeliverySettlementRow } from '../liquidation/types';
import {
    formulaCellText,
    priceFormulaFrom,
    weightFormulaFrom,
} from '@/lib/cenapro/rc-formula';
import { normalizeTypedDate, stripNumericFormatting, trimCellValue } from '@/lib/paste-utils';

// ─── Row shapes (derived from the generated types — never hand-authored) ─────────

/** The enriched read model, one row per receipt. */
export type RcDeliveryRow = Database['public']['Views']['cenapro_rc_delivery_rows']['Row'];
/** A moisture sub-sample (`#1`, `BLUE SACKS`, `NO MARK/SUNDRY`). */
export type RcDeliverySampleRow = Database['public']['Views']['cenapro_rc_delivery_samples']['Row'];
/** The cheque-payee dimension. */
export type RcSupplierRow = Database['public']['Views']['cenapro_rc_suppliers']['Row'];
/** The raw-charcoal yard dimension. */
export type RcDestinationRow = Database['public']['Views']['cenapro_rc_destinations']['Row'];

/**
 * One import complaint, as stored in `import_flags`. Typed here because the generated
 * type is `Json` — the shape is the importer's contract, not the DB's.
 */
export interface ImportFlag {
    kind: string;
    detail: string;
    raw?: string | null;
    source_row?: number | null;
}

/**
 * The same complaint, plus the read model's DERIVED verdict on whether the condition
 * it describes is still true today (`import_flags_state`). See `flagSummary` below.
 */
export interface ImportFlagState extends ImportFlag {
    /** `true` ⇒ a human has since repaired the underlying data. */
    resolved: boolean;
    /** For a resolved flag: what repaired it, in one sentence. `null` while live. */
    note: string | null;
}

/**
 * A receipt plus its samples — the unit the grid renders and the actions save.
 *
 * `settlement` (liquidation Step 4) rides ALONGSIDE the row rather than on it, because
 * `cenapro.view_rc_delivery` was deliberately left untouched: settlement state lives in
 * its own view, and the moment a `paid` flag appears on the receipt there are two truths
 * about the same money. It is `null` for a viewer who may not see prices — the query is
 * never issued — and `undefined` before the settlement fetch has landed.
 */
export interface DeliveryRecord {
    row: RcDeliveryRow;
    samples: RcDeliverySampleRow[];
    settlement?: DeliverySettlementRow | null;
}

/** The two dimension lists, read once on the server and threaded down. */
export interface DeliveryDimensions {
    suppliers: RcSupplierRow[];
    destinations: RcDestinationRow[];
}

/**
 * The endless window's keyset position. Canonical order is
 * `delivery_date ASC NULLS FIRST, id ASC`, so a cursor's date is nullable — the two
 * receipts whose date the workbook wrote as `5/262026` sit at the head of history and
 * still have to be walkable. Lives here rather than in `actions.ts` because a
 * `'use server'` module may only export async functions.
 */
export interface DeliveryCursor {
    delivery_date: string | null;
    id: string;
}

export function cursorFrom(row: RcDeliveryRow): DeliveryCursor {
    return { delivery_date: row.delivery_date ?? null, id: row.id ?? '' };
}

// ─── The ₱ boundary ─────────────────────────────────────────────────────────────
//
// Seven fields are money or derived from money: `base_price_php_kg`,
// `price_adjustment_php_kg`, `price_php_kg`, `price_formula`, `total_price_php`, and
// the workbook's own witness pair `sheet_total_php` / `sheet_total_matches`. They are
// NULLED SERVER-SIDE when `canViewPrices()` is false — the network response is the
// leak, so hiding them in the client would not be gating at all. This function is the
// ONLY place a row crosses that boundary, which is what keeps the set from drifting.
//
// Note that `price_formula` is in the list. It is not a number, but `=39.5+2.7` states
// the price as plainly as the number does.
//
// ── The list is a CONSTANT with two consumers (2026-08-05) ───────────────────────
// It used to be an object literal inside `stripPrices`, which was fine while a row
// shape was the only thing that crossed the boundary. It is not any more: the audit
// trail (`public.cenapro_rc_delivery_audit`) carries `changed` / `snapshot` as
// free-form jsonb holding EVERY column, `total_price_php` included, and `stripPrices`
// nulls NAMED FIELDS — it will not look inside a blob. So the names live here once and
// are read by BOTH `stripPrices` (rows) and `redactAuditJson` (jsonb). A field added to
// one and forgotten in the other is a hole in the boundary at exactly the surface
// nobody is looking at, and one list is what makes that impossible.
//
// `satisfies` proves at compile time that every name is a real column of the read
// model, so a typo cannot silently redact nothing.

export const PRICE_FIELDS = [
    'base_price_php_kg',
    'price_adjustment_php_kg',
    'price_php_kg',
    'price_formula',
    'total_price_php',
    'sheet_total_php',
    'sheet_total_matches',
] as const satisfies readonly (keyof RcDeliveryRow)[];

export type PriceField = (typeof PRICE_FIELDS)[number];

/** Is this column name money, or a plain statement of money? */
export function isPriceColumn(column: string): boolean {
    return (PRICE_FIELDS as readonly string[]).includes(column);
}

const NULLED_PRICES = Object.fromEntries(PRICE_FIELDS.map((f) => [f, null])) as {
    [K in PriceField]: null;
};

/** Null every ₱ field on a row. Called in the SERVER fetch, before the payload leaves. */
export function stripPrices(row: RcDeliveryRow): RcDeliveryRow {
    return { ...row, ...NULLED_PRICES };
}

// ─── Columns ────────────────────────────────────────────────────────────────────
//
// The sheet's own left-to-right order. Explicit pixel widths, and their SUM is the
// table's min-width — the wrapper scrolls rather than letting a column crush
// ("never crush, always scroll"). Nothing here is `1fr`.

/** What a column edits. `null` on the two read-only columns (`#`, TTL PRICE). */
export type DeliveryField =
    | 'delivery_date'
    | 'truck_no'
    | 'supplier'
    | 'sacks'
    | 'wt'
    | 'bd'
    | 'moisture_pct'
    | 'grit'
    | 'ash'
    | 'dust'
    | 'vm'
    | 'fc'
    | 'destination'
    | 'remarks'
    | 'price';

/**
 * How a column FILTERS, and therefore which control its header offers. `undefined`
 * means the column cannot be filtered at all.
 *
 * The four money/quantity columns (`SKS`, `WT`, `PHP/KG`, `TTL PRICE`) are deliberately
 * absent: Renzo asked for filters on everything EXCEPT those, and the two ₱ ones being
 * structurally unfilterable is also what stops a filter from becoming a price oracle —
 * `PRICE_COLS` is never consulted when the URL is parsed, so `?f_php_kg=30..40` has
 * nowhere to land.
 */
export type FilterKind =
    /** A checkbox list of the known dimension values (SUPPLIER, WAREHOUSE). */
    | 'set'
    /** Case-insensitive contains (TRK#, REMARKS). */
    | 'text'
    /** A numeric min/max (the seven lab columns). */
    | 'range'
    /** A from/to calendar range (DATE). */
    | 'dateRange';

/**
 * The READ-MODEL column a filter addresses. A closed union rather than a bare string,
 * so the typed PostgREST client still checks the name at the call site in `actions.ts`
 * and a typo cannot reach the wire.
 */
export type DeliveryFilterColumn =
    | 'delivery_date'
    | 'truck_no'
    | 'supplier_code'
    | 'destination_code'
    | 'remarks'
    | 'bd'
    | 'moisture_pct'
    | 'grit'
    | 'ash'
    | 'dust'
    | 'vm'
    | 'fc';

export interface DeliveryCol {
    key: string;
    label: string;
    width: number;
    /** Long form for the header `title` when the label is the sheet's abbreviation. */
    title?: string;
    /** Right-aligned + `font-mono tabular-nums`. */
    numeric?: boolean;
    /**
     * Part of the pinned identity block (`# · DATE · TRK# · SUPPLIER`).
     * `pin` is the platform spelling — see `lib/table/geometry.ts`; it replaced a
     * `frozen: boolean` that could only ever describe a PREFIX.
     */
    pin?: 'start' | 'end';
    /** Which lane this column occupies in a summary row (`Σ DAY TOTAL`, month footer). */
    summaryLane?: SummaryLane;
    /** The field this column edits — `null` makes it unaddressable by the keyboard. */
    field: DeliveryField | null;
    /** How this column filters. Absent ⇒ the header offers no filter control. */
    filterKind?: FilterKind;
    /** The read-model column that filter addresses. Present iff `filterKind` is. */
    filterColumn?: DeliveryFilterColumn;
}

const BASE_COLS: DeliveryCol[] = [
    { key: 'num', label: '#', width: 44, title: 'Row number in view', pin: 'start', field: null },
    {
        key: 'date',
        label: 'DATE',
        width: 92,
        pin: 'start',
        field: 'delivery_date',
        filterKind: 'dateRange',
        filterColumn: 'delivery_date',
    },
    {
        key: 'truck',
        label: 'TRK#',
        width: 78,
        title: 'Truck plate / number',
        pin: 'start',
        field: 'truck_no',
        filterKind: 'text',
        filterColumn: 'truck_no',
    },
    {
        key: 'supplier',
        label: 'SUPPLIER',
        width: 210,
        title: 'Trader − origin, plus the PSAU permit when the load carries one',
        pin: 'start',
        field: 'supplier',
        filterKind: 'set',
        filterColumn: 'supplier_code',
    },
    { key: 'sacks', label: 'SKS', width: 52, title: 'Sacks', numeric: true, field: 'sacks' },
    {
        key: 'wt',
        label: 'WT',
        width: 108,
        title: 'Net weight (kg). Type arithmetic: =27045*88% stores the 27,045 kg scale reading and the 12% deduction',
        numeric: true,
        field: 'wt',
        // The headline figure of a `Σ DAY TOTAL` / month-footer row. Replaces the
        // hard-coded `key === 'wt'` lookup `summarySpans` used to do.
        summaryLane: 'figure',
    },
    { key: 'bd', label: 'BD', width: 68, title: 'Bulk density', numeric: true, field: 'bd', filterKind: 'range', filterColumn: 'bd' },
    { key: 'moist', label: 'MOIST', width: 72, title: 'Moisture % — the official reading for the receipt', numeric: true, field: 'moisture_pct', filterKind: 'range', filterColumn: 'moisture_pct' },
    { key: 'grit', label: 'GRIT', width: 64, numeric: true, field: 'grit', filterKind: 'range', filterColumn: 'grit' },
    { key: 'ash', label: 'ASH', width: 64, numeric: true, field: 'ash', filterKind: 'range', filterColumn: 'ash' },
    { key: 'dust', label: 'DUST', width: 64, numeric: true, field: 'dust', filterKind: 'range', filterColumn: 'dust' },
    { key: 'vm', label: 'VM', width: 64, title: 'Volatile matter', numeric: true, field: 'vm', filterKind: 'range', filterColumn: 'vm' },
    { key: 'fc', label: 'FC', width: 64, title: 'Fixed carbon', numeric: true, field: 'fc', filterKind: 'range', filterColumn: 'fc' },
    {
        key: 'whse',
        label: 'WAREHOUSE',
        width: 128,
        title: 'Destination yard, with its side when the yard has one',
        field: 'destination',
        filterKind: 'set',
        filterColumn: 'destination_code',
    },
    { key: 'remarks', label: 'REMARKS', width: 200, field: 'remarks', filterKind: 'text', filterColumn: 'remarks' },
];

const PRICE_COLS: DeliveryCol[] = [
    { key: 'php_kg', label: 'PHP/KG', width: 104, title: '₱/kg. Type arithmetic: =39.5+2.7 stores the 39.50 base and the 2.70 add-on', numeric: true, field: 'price' },
    {
        key: 'ttl',
        label: 'TTL PRICE',
        width: 132,
        title: 'Net weight × ₱/kg — a DB-generated column. Read-only here, and never computed in the browser.',
        numeric: true,
        field: null,
        summaryLane: 'total',
    },
    // ── SETTLEMENT (liquidation Step 4) ──────────────────────────────────────────
    //
    // It is what makes the DELIVERY-FIRST door possible at all: you cannot liquidate
    // what you cannot see, and until this column existed the only way to know whether a
    // receipt had been paid for was to leave the ledger.
    //
    // In the ₱ group, and therefore ABSENT for a gated viewer, for the same reason
    // PHP/KG and TTL PRICE are: `balance_php` is money. It reads `field: null` — the
    // cell is derived state, not an editable one; settlement is written by assigning a
    // payment, never by typing in this column.
    {
        key: 'settle',
        label: 'PAID?',
        width: 150,
        title: 'What is still owed on this receipt, and its state: unpaid · part paid · paid · over · not priced. Derived from the payments assigned to it — never typed here, and never stored on the receipt. Right-click the row to assign a cheque.',
        field: null,
    },
];

/**
 * The column set for this viewer. When prices are gated the ₱ columns are ABSENT
 * — not blanked — so the keyboard coordinate space has no unreachable holes in it and
 * the table geometry stays honest.
 *
 * Step 4 added `settle` to that group. It carries a peso figure (`balance_php`), so it
 * belongs on the same side of the boundary as the other two: for a gated viewer the
 * column does not exist, and the settlement query behind it is never issued.
 */
export function buildColumns(canViewPrices: boolean): DeliveryCol[] {
    return canViewPrices ? [...BASE_COLS, ...PRICE_COLS] : [...BASE_COLS];
}

// ═══ Geometry — now the PLATFORM's, re-exported under this module's names ═══════
//
// These were defined here until 2026-08-17 and are now `lib/table/geometry.ts`, where
// they are generalised in one respect: a pinned column is `pin: 'start' | 'end'` rather
// than a `frozen: boolean` that could only describe a PREFIX. The reasoning, the comments
// and the assertions moved with them.
//
// The aliases below keep this module's existing vocabulary (`frozen…`) so the grid, the
// server page and the 120-assertion verify script are untouched by the move. They are
// DELETED when the ledger itself moves onto the module — they exist to make the
// extraction a no-op, not to be a permanent second naming.

export {
    columnOffsets,
    minTableWidth,
    columnScrollLeft,
    summarySpans,
    DRAG_EDGE_PX,
    DRAG_STEP_PX,
} from '@/lib/table';
export type { ColumnScrollInput, SummarySpans } from '@/lib/table';

/** Cumulative `left` offsets for the pinned identity block, in column order. */
export function frozenOffsets(cols: DeliveryCol[]): number[] {
    return pinnedOffsets(cols);
}

/** Total width of the pinned identity block. */
export function frozenBlockWidth(cols: DeliveryCol[]): number {
    return pinnedWidth(cols, 'start');
}

/** The drag auto-scroll's input, with this module's `frozen` spelling for the pinned block. */
export interface DragScrollInput extends Omit<PlatformDragScrollInput, 'pinnedStart' | 'pinnedEnd'> {
    /** Width of the pinned identity block — `frozenBlockWidth(cols)`. */
    frozen: number;
}

/** The per-frame scroll delta a drag owes, or `{0,0}` when it owes nothing. */
export function dragAutoScrollDelta(input: DragScrollInput): { dx: number; dy: number } {
    const { frozen, ...rest } = input;
    return platformDragAutoScrollDelta({ ...rest, pinnedStart: frozen });
}

/** Visual row height (Excel Standard `h-8`). */
export const ROW_H = 32;
/** A sample sub-row is deliberately shorter — it is a detail line, not an entry. */
export const SAMPLE_ROW_H = 26;

// ═══ The day spacer — a skipped row, not a second day-header system ═════════════
//
// Renzo: *"Make this specific table smart enough to auto skip a table row to separate
// and group days together. Nothing fancy."* — and then, on the 10px sliver that shipped
// first: *"It should be literally just an empty row, not some made up effect on screen,
// it just looks weird. Just place an actual row in between days."*
//
// In the ENDLESS scope the receipts run continuously with nothing marking where one day
// ends and the next begins. The FOCUS scope already answers that with a day heading and
// a `Σ DAY TOTAL` rule-off; endless deliberately does not want either — a heading every
// few rows in an infinite sheet is chrome, not information. So the endless answer is a
// literal blank ROW OF THE SHEET: full receipt height, a cell per column, the same
// vertical and horizontal rules every other row draws — a row you could have left blank
// yourself, not a rendered effect between rows.
//
// It is NOT addressable. The spacer never enters `navRows`, so the keyboard coordinate
// space, the per-cell `NavResolver`, arrow/Tab movement and range selection are
// byte-identical with and without it — asserted in `verify-rc-deliveries-cells.ts`.

/**
 * Height of the blank between-days row. It is EXACTLY `ROW_H`, and that identity is the
 * feature: a spacer of any other height reads as a rendering artefact rather than as an
 * empty row of the spreadsheet.
 */
export const DAY_SPACER_ROW_H = ROW_H;

/**
 * Does a blank spacer row belong ABOVE the receipt dated `date`?
 *
 * `prevDate === undefined` means there is no row above it yet, which is the whole of the
 * "never a leading gap at the top of the sheet" rule — the first receipt in the window is
 * never preceded by a spacer, whatever it is dated.
 *
 * An UNDATED receipt is normalised to `''` by the caller (canonical order is
 * `delivery_date ASC NULLS FIRST, id ASC`, so the undated group sits at the head of
 * history). That falls out correctly with no special case: two consecutive undated
 * receipts compare equal and get no spacer, and the undated → first-dated-day transition
 * differs and gets one, like any other boundary.
 */
export function needsDaySpacer(prevDate: string | undefined, date: string): boolean {
    if (prevDate === undefined) return false;
    return prevDate !== date;
}

// ─── The floating selection pill's per-column default ────────────────────────────
//
// Which aggregate the status-bar pill offers FIRST for a column. A weight, a sack
// count and a peso TOTAL add up; a lab reading and a ₱/kg RATE do not — averaging is
// the only thing a column of rates means. (`recommendedCalcType` in
// `useCellAggregation` promotes AVERAGE only when EVERY column in the range is an
// AVERAGE column, so a mixed selection still opens on SUM.)
export type DeliveryCalc = 'SUM' | 'AVERAGE';

export function columnCalcType(key: string): DeliveryCalc | null {
    switch (key) {
        case 'sacks':
        case 'wt':
        case 'ttl':
            return 'SUM';
        case 'bd':
        case 'moist':
        case 'grit':
        case 'ash':
        case 'dust':
        case 'vm':
        case 'fc':
        case 'php_kg':
            return 'AVERAGE';
        default:
            return null;
    }
}

/**
 * The columns a RANGE may cover. Wider than the keyboard's addressable set by exactly
 * one column: `TTL PRICE` is read-only (`field: null`, so nav never rests on it) yet it
 * is the single most useful figure to select a run of and total. `#` stays out — a row
 * ordinal has no arithmetic meaning.
 */
export function isSelectableColumn(col: DeliveryCol): boolean {
    return col.field !== null || col.key === 'ttl';
}

// ─── The filterable column table ────────────────────────────────────────────────
//
// Derived from `BASE_COLS` and NOT from `buildColumns(canViewPrices)`, which is the
// structural half of the price boundary: `PRICE_COLS` is never consulted, so no ₱
// column can be filtered by anybody, gated or not, however the URL is hand-crafted.
// (The other half is that neither ₱ column carries a `filterKind` in the first place.)

/** Every column that offers a filter, in the sheet's own left-to-right order. */
export const FILTER_COLUMNS: readonly DeliveryCol[] = BASE_COLS.filter(
    (c) => c.filterKind !== undefined,
);

/** The filter spec for a column key, or `undefined` when that column cannot filter. */
export function filterSpec(key: string): DeliveryCol | undefined {
    return FILTER_COLUMNS.find((c) => c.key === key);
}

export function isFilterableColumn(col: DeliveryCol): boolean {
    return col.filterKind !== undefined && col.filterColumn !== undefined;
}

// ─── Duplicate pairing — which row is this a copy OF? ───────────────────────────
//
// `is_suspected_duplicate` and `duplicate_group_key` are DIFFERENT FACTS and the UI
// must not conflate them:
//
//   • `is_suspected_duplicate` is the IMPORTER'S ACCUSATION, and the importer flagged
//     only the SECOND copy of each pasted receipt. 22 rows carry it.
//   • `duplicate_group_key` is a fact about the DATA — an exact twin exists. 44 rows
//     carry it: the 22 flagged copies AND the 22 originals they were pasted from,
//     which until now were invisible.
//
// So a row can be flagged-and-paired (the copy), paired-but-unflagged (the original),
// or — once a human edits either copy and the signature stops matching — flagged with
// its group dissolved. All three need saying out loud; none of them is "clean".

export type DuplicateRole = 'copy' | 'twin';

export interface DuplicateBadge {
    /** `copy` = the importer flagged this one. `twin` = an exact copy of it exists. */
    role: DuplicateRole;
    /** 1-based position in the group; `null` once the group has dissolved. */
    ordinal: number | null;
    size: number | null;
    /** Badge text — `DUP 2/2`, `TWIN 1/2`, or a bare `DUP` with no group left. */
    label: string;
    title: string;
    /** The OTHER receipts in the group. Empty when the group has dissolved. */
    peerIds: string[];
}

/**
 * The badge a receipt wears, or `null` when it is neither flagged nor paired.
 *
 * A "group" of one is not a group — `duplicate_group_size < 2` is treated as no group
 * at all, so a defensive read of a partially-populated row can never render `1 of 1`.
 */
export function duplicateBadge(row: {
    is_suspected_duplicate?: boolean | null;
    duplicate_group_key?: string | null;
    duplicate_group_size?: number | null;
    duplicate_group_ordinal?: number | null;
    duplicate_peer_ids?: string[] | null;
}): DuplicateBadge | null {
    const size = row.duplicate_group_size ?? 0;
    const paired = !!row.duplicate_group_key && size >= 2;
    const flagged = row.is_suspected_duplicate === true;
    if (!paired && !flagged) return null;

    const role: DuplicateRole = flagged ? 'copy' : 'twin';

    // Flagged, but the twin is gone: somebody edited one of the two copies, so the
    // exact-copy signature no longer matches. The flag is the importer's and stands
    // until a human clears it — saying so is more useful than dropping the badge.
    if (!paired) {
        return {
            role,
            ordinal: null,
            size: null,
            label: 'DUP',
            title:
                'The importer flagged this receipt as pasted twice, but no exact twin is left in the ledger — a value on one of the two has since been edited.',
            peerIds: [],
        };
    }

    const ordinal = row.duplicate_group_ordinal ?? 0;
    const peerIds = (row.duplicate_peer_ids ?? []).filter((id) => typeof id === 'string' && id !== '');
    return {
        role,
        ordinal,
        size,
        label: `${role === 'copy' ? 'DUP' : 'TWIN'} ${ordinal}/${size}`,
        title:
            role === 'copy'
                ? `Copy ${ordinal} of ${size} — the importer flagged THIS row as the paste. Its original is copy 1.`
                : `Copy ${ordinal} of ${size} — an exact twin of this receipt exists. The importer flagged the other one, not this one.`,
        peerIds,
    };
}

// ─── The lab columns a SAMPLE row can carry ─────────────────────────────────────
//
// Most sub-samples are a moisture draw and nothing else, but a few carry a full panel,
// so all seven are addressable on a sample row. Everything else on that row — date,
// truck, sacks, weight, warehouse, remarks, price — does not exist, which is why this
// grid needs a per-CELL resolver rather than a per-COLUMN one.
export const SAMPLE_LAB_FIELDS = ['bd', 'moisture_pct', 'grit', 'ash', 'dust', 'vm', 'fc'] as const;
export type SampleLabField = (typeof SAMPLE_LAB_FIELDS)[number];

/** The sample field a delivery column maps to on a sub-row, or `null` if none. */
export function sampleFieldFor(field: DeliveryField | null): SampleLabField | 'label' | null {
    if (field === null) return null;
    // The free-text label rides in the SUPPLIER lane: it is the widest frozen identity
    // column, so an indented `NO MARK/SUNDRY` stays readable while the sheet scrolls.
    if (field === 'supplier') return 'label';
    return (SAMPLE_LAB_FIELDS as readonly string[]).includes(field) ? (field as SampleLabField) : null;
}

// ═══ SUPPLIER — one Excel cell, three DB fields ═════════════════════════════════

export interface SupplierParts {
    supplier_code: string;
    supplier_origin: string | null;
    permit_no: string | null;
}

/**
 * A PSAU-style permit, anchored to the END of the cell: two-to-six letters, then a
 * number, then a dashed check digit — `PSAU 282509-8`. Anchored because the origin is
 * free text and could contain anything; the permit is only ever the tail.
 */
const PERMIT_TAIL = /\s+([A-Z]{2,6}\s*\d{4,}\s*-\s*\d{1,3})$/;

/** Collapse whitespace, drop the sheet's stray punctuation, upper-case. */
function normalizeCell(raw: string): string {
    return raw.replace(/\s+/g, ' ').trim().toUpperCase();
}

/**
 * Render the three fields the way the sheet writes them:
 *
 *     BRIX                          code only
 *     BRIX - SOUTH HILONGOS         code − origin
 *     PALAWAN PSAU 316759-8         code + permit
 *     PALAWAN - RANDY PSAU 282509-8 code − origin + permit
 *
 * An UNRESOLVED imported row (no `supplier_code`) falls back to the operator's original
 * `supplier_raw`, so the cell still shows what the workbook said while the row wears its
 * "needs mapping" state.
 */
export function formatSupplierCell(row: {
    supplier_code?: string | null;
    supplier_origin?: string | null;
    permit_no?: string | null;
    supplier_raw?: string | null;
}): string {
    const code = (row.supplier_code ?? '').trim();
    if (!code) return (row.supplier_raw ?? '').trim();
    const origin = (row.supplier_origin ?? '').trim();
    const permit = (row.permit_no ?? '').trim();
    const head = origin ? `${code} - ${origin}` : code;
    return permit ? `${head} ${permit}` : head;
}

/**
 * Take the cell back apart against the KNOWN supplier codes.
 *
 * Codes contain spaces (`ALI UNGA`), so the match is longest-first on a word boundary
 * rather than a split on the first separator. An empty cell is a legal clear. Anything
 * that does not resolve returns an `error` — the caller refuses the save and says which
 * row, because a receipt with no payee is a cheque that cannot be written.
 */
export function parseSupplierCell(
    input: string,
    codes: readonly string[],
): SupplierParts | { error: string } {
    const cell = normalizeCell(input);
    if (!cell) return { supplier_code: '', supplier_origin: null, permit_no: null };

    let rest = cell;
    let permit: string | null = null;
    const m = PERMIT_TAIL.exec(rest);
    if (m) {
        permit = m[1].replace(/\s*-\s*/, '-').replace(/\s+/g, ' ').trim();
        rest = rest.slice(0, m.index).trim();
    }

    const known = [...codes].map((c) => c.toUpperCase()).sort((a, b) => b.length - a.length);
    const code = known.find((c) => rest === c || rest.startsWith(`${c} `) || rest.startsWith(`${c}-`));
    if (!code) {
        return {
            error: `"${input.trim()}" is not a known supplier. Known traders: ${[...codes].sort().join(', ')}.`,
        };
    }

    // Whatever follows the code, minus the sheet's `-`/`–` separator, is the origin.
    const origin = rest.slice(code.length).replace(/^[\s\-–—]+/, '').trim();
    return { supplier_code: code, supplier_origin: origin || null, permit_no: permit };
}

// ═══ WAREHOUSE — one Excel cell, two DB fields ══════════════════════════════════

export interface DestinationParts {
    destination_code: string;
    destination_side: 'LFT' | 'RT' | null;
}

/**
 * The sheet writes the side glued to the code with a hyphen (`WHSE A- LFT`) or with a
 * plain space (`WHSE 3A RT`), and abbreviates it four different ways. `LT` is in the
 * list because the workbook actually contains `WHSE 3A LT`; the DB CHECK accepts only
 * `LFT` / `RT`, so every spelling normalises to one of those on the way in.
 *
 * The alternation is deliberately NOT just `L|R` plus optional letters: no destination
 * code ends in a bare `L` or `R` today, but one could, and a side matcher that could
 * eat the last letter of a yard name is a bug waiting for a new warehouse.
 */
const SIDE_TAIL = /[\s\-–—]+(LFT|LEFT|LT|L|RT|RIGHT|R)$/;

/** Render `WHSE A- LFT` / `W6 PROD`, falling back to the raw text on an unmapped row. */
export function formatDestinationCell(row: {
    destination_code?: string | null;
    destination_side?: string | null;
    destination_raw?: string | null;
}): string {
    const code = (row.destination_code ?? '').trim();
    if (!code) return (row.destination_raw ?? '').trim();
    const side = (row.destination_side ?? '').trim();
    return side ? `${code}- ${side}` : code;
}

/**
 * Take the cell back apart against the KNOWN destination codes. `LEFT`/`L` normalise to
 * `LFT` and `RIGHT`/`R` to `RT` (the DB CHECK accepts only those two), and a code typed
 * without its space (`WHSEA`) still resolves. Unresolvable ⇒ `error`, same rule as the
 * supplier: the import was allowed to leave a yard unmapped, a human typing today is not.
 */
export function parseDestinationCell(
    input: string,
    codes: readonly string[],
): DestinationParts | { error: string } {
    const cell = normalizeCell(input);
    if (!cell) return { destination_code: '', destination_side: null };

    let rest = cell;
    let side: 'LFT' | 'RT' | null = null;
    const m = SIDE_TAIL.exec(rest);
    if (m) {
        side = m[1].startsWith('L') ? 'LFT' : 'RT';
        rest = rest.slice(0, m.index).trim();
    }

    const squash = (s: string) => s.replace(/\s+/g, '');
    const code = [...codes]
        .map((c) => c.toUpperCase())
        .sort((a, b) => b.length - a.length)
        .find((c) => rest === c || squash(rest) === squash(c));

    if (!code) {
        return {
            error: `"${input.trim()}" is not a known warehouse. Known yards: ${[...codes].sort().join(', ')}.`,
        };
    }
    return { destination_code: code, destination_side: side };
}

// ═══ The formula cells — what the operator sees on FOCUS ════════════════════════

/**
 * WT on focus. A stored `weight_formula` wins; otherwise a deduction is REBUILT into
 * its canonical formula text so an imported `88%` row reads identically to one typed
 * today; otherwise the plain gross number.
 */
export function weightEditText(row: {
    weight_formula?: string | null;
    gross_weight_kg?: number | string | null;
    deduction_pct?: number | string | null;
}): string {
    const gross = num(row.gross_weight_kg);
    const pct = num(row.deduction_pct);
    return formulaCellText(row.weight_formula ?? weightFormulaFrom(gross, pct), gross);
}

/** PHP/KG on focus — the same rule over `base` + `adjustment`. */
export function priceEditText(row: {
    price_formula?: string | null;
    base_price_php_kg?: number | string | null;
    price_adjustment_php_kg?: number | string | null;
}): string {
    const base = num(row.base_price_php_kg);
    const adj = num(row.price_adjustment_php_kg);
    return formulaCellText(row.price_formula ?? priceFormulaFrom(base, adj), base);
}

// ═══ Display formatting (Excel Standard) ════════════════════════════════════════

/** PostgREST returns `numeric` as a string — one coercion, used everywhere. */
export function num(v: number | string | null | undefined): number | null {
    if (v === null || v === undefined || v === '') return null;
    const n = typeof v === 'number' ? v : Number(v);
    return Number.isFinite(n) ? n : null;
}

const KG = new Intl.NumberFormat('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
const PESO = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const RATE = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 4 });

export function formatKg(v: number | string | null | undefined): string {
    const n = num(v);
    return n === null ? '' : KG.format(n);
}

/** Whole pesos + centavos, for the accounting cell and the footers. */
export function formatPeso(v: number | string | null | undefined): string {
    const n = num(v);
    return n === null ? '' : PESO.format(n);
}

/** ₱/kg keeps up to 4 dp — `=38.5+2.61` must not round before it reaches the total. */
export function formatRate(v: number | string | null | undefined): string {
    const n = num(v);
    return n === null ? '' : RATE.format(n);
}

export function formatInt(v: number | string | null | undefined): string {
    const n = num(v);
    return n === null ? '' : String(Math.round(n));
}

/** Lab values → 2 dp; BD → 3 dp (project rule). */
export function formatLab(v: number | string | null | undefined, dp: 2 | 3 = 2): string {
    const n = num(v);
    return n === null ? '' : n.toFixed(dp);
}

export function labDecimals(field: string): 2 | 3 {
    return field === 'bd' ? 3 : 2;
}

// ═══ The DATE cell — free text in, `yyyy-MM-dd` out ═════════════════════════════
//
// The cell used to be a native `<input type="date">`, which meant it was the one column
// in the sheet that did not behave like a cell: no type-over, no F2, no double-click, a
// browser widget instead of the grid's editor. It is now a plain text cell on the same
// edit path as every other column, and this is where its text becomes a date.
//
// `normalizeTypedDate` (shared with the production ledger and the paste path) already
// speaks every form the operators use — `6/27`, `6/27/26`, `2026-06-27`, `27 Jun 26`,
// and an Excel serial. It is deliberately NOT extended here: it is shared, and the one
// thing this ledger needs on top of it is a VERDICT rather than a passthrough. Where
// `normalizeTypedDate` hands back the operator's text unchanged when it cannot read it,
// this refuses — because writing a silently wrong date onto a payment ledger is the one
// outcome that must be impossible.
//
// `contextYear` is what a bare `6/27` means. The ledger supplies it from the row's own
// surroundings (the focused month's year in the focus scope; otherwise the year of the
// receipt being edited, falling back to the newest dated row in the window).

/**
 * `yyyy-MM-dd` AND a day that exists. The second half is not pedantry: `normalizeTypedDate`
 * hands back the operator's text unchanged when it cannot validate it, so a typed
 * `2026-02-30` comes out of it still looking exactly like an ISO date. A shape test alone
 * would wave it through to Postgres, which would reject it as a raw `date` cast — an
 * error the operator cannot read, about a cell the UI already said was fine.
 */
export function isIsoDate(text: string): boolean {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
    if (!m) return false;
    const y = Number(m[1]);
    const mo = Number(m[2]);
    const d = Number(m[3]);
    // UTC so a timezone offset can never roll the round-trip onto the neighbouring day.
    const dt = new Date(Date.UTC(y, mo - 1, d));
    return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
}

export function parseDeliveryDate(
    input: string,
    contextYear: number,
): { iso: string } | { error: string } {
    const text = input.trim();
    if (!text) return { error: 'a receipt needs a date.' };
    const iso = normalizeTypedDate(text, contextYear);
    if (!isIsoDate(iso)) {
        return {
            error: `"${text}" is not a date. Try 6/27, 6/27/26, 2026-06-27 or 27 Jun 26 — a bare day-and-month takes ${contextYear}.`,
        };
    }
    return { iso };
}

// ═══ The clipboard — TSV in, TSV out ════════════════════════════════════════════
//
// Renzo: *"allow us to copy and paste into existing entries and empty entries (from
// google sheet, into the app)"* · *"allow us to copy data from the app so its pastable
// into google sheet"*.
//
// The operators live in Google Sheets, so the clipboard is a real interchange format
// here, not a convenience. Everything below is PURE so the exchange is decided in one
// place and asserted without a browser (`verify-rc-deliveries-cells.ts`).
//
// Three rules, and each of them was a real defect:
//
//   1. **A cell may contain a tab or a newline.** REMARKS is free text. A payload that
//      joins raw cell text with `\t` / `\n` shreds the row alignment the moment one
//      remark holds a line break — the block pastes into Sheets as gibberish. So the
//      writer QUOTES (`tsvEscape`) and the reader UNDERSTANDS quotes
//      (`parseClipboardTable`), which is the convention Sheets and Excel both speak.
//   2. **A spreadsheet wants a NUMBER, not a rendering.** `₱6,940,123.45` is text to
//      Sheets. `clipboardNumber` emits the DB's own decimal digits — and it emits them
//      VERBATIM when the source is already a plain numeric string, because
//      `net_weight_kg` / `price_php_kg` / `total_price_php` are STORED GENERATED exact
//      decimals and re-deriving them through a JavaScript float is precisely how a
//      payment ledger goes wrong.
//   3. **A pasted number arrives WITH its rendering.** Sheets copies `27,045` and
//      `₱39.50`, so a numeric column strips formatting on the way in — and only a
//      numeric column, because a supplier origin may legitimately contain a comma.

// The TSV reader/writer moved to `lib/table/clipboard.ts` on 2026-08-17 — comments and
// reasoning included. `cleanPastedCell` below stays HERE: it is the one piece of the
// exchange that is domain-shaped, because it knows which column holds a date and which
// holds free text.
export { parseClipboardTable, tsvEscape, clipboardNumber } from '@/lib/table';

/**
 * Clean ONE pasted cell for its target column.
 *
 * DATE goes through the same verdict a typed date does, with the same context year, so a
 * pasted `6/27` and a typed `6/27` can never land on different years. A numeric column
 * loses the rendering Sheets copied with it (`₱`, thousands commas, stray quotes); a
 * TEXT column keeps every character, because a supplier origin or a remark may contain
 * exactly those.
 */
export function cleanPastedCell(col: DeliveryCol, raw: string, contextYear: number): string {
    const text = trimCellValue(raw);
    if (!text) return '';
    if (col.field === 'delivery_date') {
        const parsed = parseDeliveryDate(text, contextYear);
        return 'error' in parsed ? text : parsed.iso;
    }
    return col.numeric ? stripNumericFormatting(text) : text;
}

// The paste PLAN (how many rows a block needs) and the paste TARGETS (which rows it
// lands on, by row family) moved to `lib/table/clipboard.ts` on 2026-08-17, together
// with the new `tilePaste` — the Sheets habit where one copied value fills a whole
// selected range.
export { planPaste, pasteKindsCompatible, pasteRowTargets, tilePaste } from '@/lib/table';
export type {
    PastePlanInput,
    PastePlan,
    PasteRowKind,
    PasteRowTargetsInput,
    PasteRowTargets,
} from '@/lib/table';

// ═══ Unsaved cell text, and when it stops being unsaved ═════════════════════════

/** Per-receipt unsaved field edits, held as the raw text the operator typed. */
export type FieldEdits = Partial<Record<DeliveryField, string>>;

// Both moved to `lib/table/edits.ts` on 2026-08-17 — the "an edit that undoes itself is
// not an edit" rule, comments and all. They are the module's ONE definition of dirty.
export { mergeFieldEdit, isDirtyFieldEdits } from '@/lib/table';

// ═══ Unsaved work — what an axis change is about to destroy ═════════════════════
//
// Changing ANY URL axis (the scope, the month, a lens, the search, one of the twelve
// column filters) rewrites the URL, which changes `axesKey(...)`, which REMOUNTS the
// grid against a window the server prefetched for the new axes. Every pending edit and
// every typed blank row goes with it. So the grid guards those writes — and the guard
// must fire on EXACTLY the condition that lights the Save button, never a keystroke
// wider.
//
// That is what this function is for. It takes the two dirty sets the grid already
// maintains and produces the ONE number the "N unsaved" chip, the Save button and the
// guard all read, so "the guard fired but Save was greyed out" is not a state the code
// can express. The upstream rules stay upstream and are not restated here: an untouched
// blank row never reaches `dirtyDrafts` (`isDirtyFieldEdits`), and a cell typed back to
// its stored value has already left `dirtyReceipts` (`mergeFieldEdit`).
//
// The two kinds are counted SEPARATELY because they are different losses. An edited
// receipt still exists in the database with its old values; a typed blank row exists
// nowhere at all, and eight of them is a morning's work.

// The counting moved to `lib/table/edits.ts`. These three are thin ADAPTERS that keep
// this module's vocabulary — a stored row here is a "receipt", and the guard dialog says
// so. The platform version takes the nouns as a parameter precisely so each consumer can
// name its own rows without a second copy of the counting.

export interface UnsavedWork {
    /** Stored receipts carrying unsaved cell edits or moisture-draw changes. */
    editedReceipts: number;
    /** Blank rows at the bottom the operator has typed real values into. */
    newRows: number;
    /** What the Save button, the unsaved chip and the axis guard all count. */
    total: number;
}

export function countUnsavedWork(
    dirtyReceipts: ReadonlySet<string>,
    dirtyDrafts: ReadonlySet<string>,
): UnsavedWork {
    const work = platformCountUnsavedWork(dirtyReceipts, dirtyDrafts);
    return { editedReceipts: work.editedRecords, newRows: work.newRows, total: work.total };
}

/** True exactly when the Save button is enabled. The guard's whole firing condition. */
export function hasUnsavedWork(work: UnsavedWork): boolean {
    return work.total > 0;
}

/** The phrase the guard dialog names the stakes with. */
export function describeUnsavedWork(work: UnsavedWork): string {
    return platformDescribeUnsavedWork(
        { editedRecords: work.editedReceipts, newRows: work.newRows, total: work.total },
        { record: 'edited receipt', draft: 'typed new row' },
    );
}

// ═══ Draft receipts (the blank rows at the bottom) ══════════════════════════════
//
// Google Sheets keeps a run of blank rows under the last real one and an
// `Add [N] more rows at the bottom` control under those. This ledger does the same: a
// draft is a fully addressable, fully editable row that simply has no `id` yet, and it
// becomes a real receipt through the SAME insert path as anything else
// (`cenapro_save_rc_delivery` with `p_id IS NULL`).
//
// A draft the operator never touches is not saved and is not counted as unsaved.

export { DEFAULT_DRAFT_ROWS, MAX_DRAFT_ADD, clampDraftAdd } from '@/lib/table';

// ═══ Data-quality surface ═══════════════════════════════════════════════════════

/** Why a row is flagged. Drives the left rail colour and the row's badge set. */
export type RowIssue = 'duplicate' | 'unmapped' | 'flagged' | 'undated';

export function rowIssues(row: RcDeliveryRow): RowIssue[] {
    const out: RowIssue[] = [];
    if (row.is_suspected_duplicate) out.push('duplicate');
    if (row.supplier_unresolved || row.destination_unresolved) out.push('unmapped');
    if (!row.delivery_date && row.delivery_date_raw) out.push('undated');
    // LIVE flags only — a flag whose problem a human has since repaired is history,
    // not a queue entry. `flagSummary` is the ONE place that verdict is reached, and
    // the grid's rail, its badge and this issue set all read it. See the block below.
    if (flagSummary(row).live && !row.is_suspected_duplicate) out.push('flagged');
    return out;
}

/** `import_flags` is `Json` in the generated types — narrow it once, here. */
export function readImportFlags(raw: unknown): ImportFlag[] {
    if (!Array.isArray(raw)) return [];
    return raw.flatMap((f) => {
        if (!f || typeof f !== 'object') return [];
        const o = f as Record<string, unknown>;
        return [
            {
                kind: typeof o.kind === 'string' ? o.kind : 'unknown',
                detail: typeof o.detail === 'string' ? o.detail : '',
                raw: typeof o.raw === 'string' ? o.raw : null,
                source_row: typeof o.source_row === 'number' ? o.source_row : null,
            },
        ];
    });
}

// ─── Flag resolution — is the flag's problem STILL TRUE? ────────────────────────
//
// `import_flags` records what the extractor saw ON THE DAY, and it is NEVER cleared,
// edited or deleted — it is the only surviving witness that the workbook literally said
// `WHSE A/R#16` ("flagged, never fixed"). So it does not stop describing a problem when
// a human repairs one, and the `?issue=flagged` lens drifted into a lie: 12 receipts
// carried a flag while only 2 still had a live problem.
//
// The READ MODEL now derives the verdict per flag (`import_flags_state`, plus the counts
// and `has_unresolved_flags`) — migration `20260805090000`. Nothing is mutated. This
// module's job is only to (a) narrow the jsonb, (b) decide the ONE predicate the rail,
// the badge and the `flagged` issue all share, and (c) say what repaired a resolved
// flag. What changed here is what the UI EMPHASISES, never what is stored.
//
// TWO fail-safes, both in the "still a problem" direction, matching the backend's own
// asymmetry — a wrong `resolved` silently hides a real problem, a wrong `unresolved`
// merely leaves a row where a human will see it:
//   • an element whose `resolved` is not literally `true` counts as UNRESOLVED (so an
//     unknown `kind`, or a row read before the state column existed, stays in the queue);
//   • `has_unresolved_flags` is ORed in, so a boolean saying "still live" is never
//     overridden by an array that lost its verdicts.

/** The row fields the flag surface reads. Structural, so a partial row still works. */
export interface FlagSurfaceRow {
    import_flags?: unknown;
    import_flags_state?: unknown;
    has_unresolved_flags?: boolean | null;
    supplier_code?: string | null;
    destination_code?: string | null;
    delivery_date?: string | null;
    bd?: number | null;
}

export interface FlagSummary {
    /** Every flag the row carries — live AND historical. Never filtered. */
    flags: ImportFlagState[];
    unresolved: number;
    resolved: number;
    /** At least one flag still describes a live problem. THE lens/rail predicate. */
    live: boolean;
    /** The row carries flags and every one of them is history. */
    historyOnly: boolean;
}

/**
 * What repaired a resolved flag, read off the row's CURRENT state — the same state the
 * SQL predicate asked about. Presentation copy, kept here so the popover renders it and
 * the verify script can assert it without a browser.
 */
function resolutionNote(kind: string, row: FlagSurfaceRow): string {
    const named = (v: unknown) => (typeof v === 'string' && v ? ` (${v})` : '');
    switch (kind) {
        case 'supplier_unmapped':
        case 'supplier_no_trader_prefix':
            return `Resolved — the receipt now names a payee${named(row.supplier_code)}.`;
        case 'destination_unmapped':
            return `Resolved — the receipt now has a warehouse${named(row.destination_code)}.`;
        case 'date_unparseable':
            return `Resolved — the receipt now has a date${named(row.delivery_date)}.`;
        case 'bd_out_of_range':
            return `Resolved — the receipt now has a BD reading${
                typeof row.bd === 'number' ? ` (${row.bd})` : ''
            }.`;
        case 'suspected_duplicate':
            return 'Resolved — no exact twin of this receipt is left in the ledger.';
        default:
            return 'Resolved — the condition this flag describes no longer holds.';
    }
}

/**
 * The ONE flag verdict. Everything on screen that reacts to a flag — the sky rail, the
 * warning badge, the quiet history affordance, the `flagged` issue and therefore this
 * client's agreement with the SQL lens — reads this and only this.
 */
export function flagSummary(row: FlagSurfaceRow): FlagSummary {
    // `import_flags_state` is the array WITH verdicts; `import_flags` is the same array
    // without them. Falling back to the latter costs nothing and keeps every flag
    // visible (as unresolved) if the state column is ever absent from a projection.
    const source = Array.isArray(row.import_flags_state) ? row.import_flags_state : row.import_flags;
    const rawArr: unknown[] = Array.isArray(source) ? source : [];

    // Walked element-by-element rather than zipped against `readImportFlags` by INDEX:
    // that helper DROPS a non-object element, so a single malformed entry would shift
    // every verdict after it onto the wrong flag. One flag in, one flag out, always.
    const flags: ImportFlagState[] = rawArr.map((el) => {
        const [f] = readImportFlags([el]);
        const base: ImportFlag = f ?? { kind: 'unknown', detail: '', raw: null, source_row: null };
        const resolved =
            !!el && typeof el === 'object' && (el as Record<string, unknown>).resolved === true;
        return { ...base, resolved, note: resolved ? resolutionNote(base.kind, row) : null };
    });

    const unresolved = flags.filter((f) => !f.resolved).length;
    const resolved = flags.length - unresolved;
    const live = unresolved > 0 || row.has_unresolved_flags === true;
    return { flags, unresolved, resolved, live, historyOnly: flags.length > 0 && !live };
}

// ═══ The audit trail — one receipt's whole story ════════════════════════════════
//
// Migration `20260805100000` gave `cenapro.rc_delivery` (and its CASCADE child
// `rc_delivery_sample`) a trigger-written, append-only trail, read through the
// SELECT-only accessor `public.cenapro_rc_delivery_audit`. Both entities land in ONE
// table keyed by the PARENT `delivery_id`, so a receipt's history is a single indexed
// query rather than a UNION.
//
// It exists because on 2026-08-04 twenty-two receipts were hard-DELETEd — ₱17,185,938.70
// of payable total — and nothing anywhere recorded it. Liquidation is about to point
// CHEQUES at these rows; a supplier disagreement six months from now has to be
// answerable from the system rather than from memory.
//
// ── THE HAZARD, and it is the reason this block is in `types.ts` ─────────────────
// `changed` and `snapshot` are FREE-FORM JSONB carrying every column of the base table,
// `total_price_php` included. `stripPrices()` nulls NAMED FIELDS on a row shape and
// cannot reach inside a blob — so a history action that merely fetched and rendered
// would hand a gated viewer every price in the ledger, and the NETWORK RESPONSE is the
// leak. `redactAuditJson` below deletes the keys, it is called SERVER-SIDE in
// `actions.ts::getDeliveryHistory` before the payload returns, and it reads the SAME
// `PRICE_FIELDS` list `stripPrices` does.
//
// Everything here is PURE, so the dialog renders it and the verify script can assert it
// without a browser.

/** The read-only accessor's row. `cenapro` is not exposed to PostgREST; this view is. */
export type RcDeliveryAuditRow = Database['public']['Views']['cenapro_rc_delivery_audit']['Row'];

/**
 * The day the trail begins. NOTHING before it was ever recorded — the migration wrote
 * not one historical row, because inventing one would put a fabrication in the one
 * table whose entire value is that it is not fabricated. The empty state says this date
 * out loud rather than implying the receipt was never touched.
 */
export const AUDIT_TRAIL_START = '2026-08-05';

export type AuditOperation = 'INSERT' | 'UPDATE' | 'DELETE';
/** `delivery` = the receipt itself; `sample` = one of its moisture draws. */
export type AuditEntity = 'delivery' | 'sample';

/** One column that actually moved, already redacted, labelled and ordered. */
export interface AuditFieldChange {
    column: string;
    label: string;
    from: unknown;
    to: unknown;
}

/** One row of the trail, as the dialog consumes it. */
export interface DeliveryHistoryEntry {
    /** React key — the trail's own identity, never a row index. */
    key: string;
    entity: AuditEntity;
    operation: AuditOperation;
    /** The draw's 1-based position, for a `sample` entry. */
    samplePosition: number | null;
    /** ISO timestamp. `''` only if the trail ever hands one back without it. */
    changedAt: string;
    /**
     * The person who made the change, or **null for a write with no `auth.uid()`** —
     * a service-role / importer / psql write. Rendered as "system", never as a blank:
     * "nobody" and "not a logged-in human" are different answers.
     */
    actorName: string | null;
    /** PostgREST role behind the write (`authenticated` / `service_role` / …). */
    actorRole: string | null;
    /** Which surface wrote it. NULL on everything today — no writer sets the GUC. */
    source: string | null;
    changes: AuditFieldChange[];
    /**
     * How many ₱ columns moved but were REDACTED out of `changes` for this viewer.
     * The entry still renders — see the note on `redactAuditJson`.
     */
    redactedChanges: number;
    /** The full row (NEW on INSERT/UPDATE, OLD on DELETE), ₱-redacted. */
    snapshot: Record<string, unknown> | null;
    /** Denormalised identity, so a DELETED receipt's trail is still readable. */
    deliveryDate: string | null;
    supplierCode: string | null;
    truckNo: string | null;
}

export interface DeliveryHistoryResult {
    entries: DeliveryHistoryEntry[];
    canViewPrices: boolean;
    /** Set when the per-receipt cap was reached — said out loud, never silently clipped. */
    notice?: string;
    error?: string;
}

/** A `changed_by` we could not resolve to a profile. There is deliberately no FK. */
export const UNKNOWN_ACTOR = 'Unknown user';

/**
 * Drop every ₱ key from an audit blob, and say how many went.
 *
 * Works on BOTH shapes because both are flat objects keyed by column: `snapshot` is
 * `{col: value}` and `changed` is `{col: {old, new}}`. Guarding at the key level rather
 * than the value level is what makes that true — and what makes it safe if the trigger
 * ever records a new money column, since `PRICE_FIELDS` is the only thing to update.
 *
 * `showPrices` is a PARAMETER rather than a caller-side `if`, so there is exactly one
 * code path into the payload and no way to build an entry that skipped the gate.
 */
export function redactAuditJson(
    raw: unknown,
    showPrices: boolean,
): { json: Record<string, unknown>; removed: number } {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { json: {}, removed: 0 };
    const out: Record<string, unknown> = {};
    let removed = 0;
    for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
        if (!showPrices && isPriceColumn(key)) {
            removed++;
            continue;
        }
        out[key] = value;
    }
    return { json: out, removed };
}

/**
 * Two columns the diff deliberately does not list, both pure bookkeeping and both
 * already stated elsewhere on the same entry:
 *
 *   • `updated_by` — the touch trigger sets it to `auth.uid()`, which is the very value
 *     the audit row's own `changed_by` carries. The actor line says it once.
 *   • `delivery_year` — a STORED GENERATED mirror of `delivery_date`, so it only ever
 *     moves because the date directly above it did.
 *
 * Nothing else is hidden. `updated_at` and `row_version` never arrive in the first
 * place — the trigger excludes them, because it bumps both on every single write.
 */
const AUDIT_BOOKKEEPING_COLUMNS = new Set(['updated_by', 'delivery_year']);

/** Plumbing a SNAPSHOT summary never shows. The diff still lists all of these. */
const AUDIT_SNAPSHOT_SKIP = new Set([
    'id', 'delivery_id', 'row_version', 'created_at', 'created_by', 'updated_at', 'updated_by',
    'delivery_year', 'source_sheet',
]);

/** The sheet's own names, so a diff reads like the grid it describes. */
const AUDIT_LABELS: Record<string, string> = {
    delivery_date: 'DATE',
    delivery_date_raw: 'Date (as written)',
    delivery_year: 'Year',
    truck_no: 'TRK#',
    supplier_code: 'SUPPLIER',
    supplier_origin: 'Origin',
    permit_no: 'Permit',
    supplier_raw: 'Supplier (as written)',
    sacks: 'SKS',
    gross_weight_kg: 'Gross WT',
    deduction_pct: 'Deduction',
    net_weight_kg: 'WT (net)',
    weight_formula: 'WT formula',
    bd: 'BD',
    moisture_pct: 'MOIST',
    grit: 'GRIT',
    ash: 'ASH',
    dust: 'DUST',
    vm: 'VM',
    fc: 'FC',
    destination_code: 'WAREHOUSE',
    destination_side: 'Side',
    destination_raw: 'Warehouse (as written)',
    remarks: 'REMARKS',
    base_price_php_kg: 'PHP/KG base',
    price_adjustment_php_kg: 'PHP/KG add-on',
    price_php_kg: 'PHP/KG',
    price_formula: 'PHP/KG formula',
    total_price_php: 'TTL PRICE',
    sheet_total_php: 'Sheet total',
    provenance: 'Provenance',
    source_row: 'Sheet row',
    import_flags: 'Import flags',
    is_suspected_duplicate: 'Suspected duplicate',
    // `rc_delivery_sample`'s own columns.
    position: 'Draw #',
    label: 'Draw label',
};

export function auditColumnLabel(column: string): string {
    return AUDIT_LABELS[column] ?? column;
}

/**
 * Left-to-right, the sheet's order — so a diff of four columns reads in the order the
 * operator would have typed them. Anything unlisted sorts after, in name order, which
 * keeps a column added to the table tomorrow visible rather than silently first.
 */
const AUDIT_COLUMN_ORDER: readonly string[] = [
    'delivery_date', 'delivery_date_raw', 'truck_no',
    'supplier_code', 'supplier_origin', 'permit_no', 'supplier_raw',
    'position', 'label',
    'sacks', 'gross_weight_kg', 'deduction_pct', 'net_weight_kg', 'weight_formula',
    'bd', 'moisture_pct', 'grit', 'ash', 'dust', 'vm', 'fc',
    'destination_code', 'destination_side', 'destination_raw', 'remarks',
    'base_price_php_kg', 'price_adjustment_php_kg', 'price_php_kg', 'price_formula',
    'total_price_php', 'sheet_total_php',
    'provenance', 'source_row', 'import_flags', 'is_suspected_duplicate',
];

function auditColumnRank(column: string): number {
    const i = AUDIT_COLUMN_ORDER.indexOf(column);
    return i === -1 ? AUDIT_COLUMN_ORDER.length : i;
}

/**
 * Narrow the trigger's `{col: {old, new}}` into an ordered, labelled list.
 *
 * `?? null` rather than `||` throughout: a change TO `0`, `''` or `false` is a real
 * change and must not be flattened into "nothing".
 */
export function readAuditChanges(raw: unknown): AuditFieldChange[] {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return [];
    const out: AuditFieldChange[] = [];
    for (const [column, delta] of Object.entries(raw as Record<string, unknown>)) {
        if (AUDIT_BOOKKEEPING_COLUMNS.has(column)) continue;
        const d = (delta && typeof delta === 'object' && !Array.isArray(delta)
            ? (delta as Record<string, unknown>)
            : {});
        out.push({
            column,
            label: auditColumnLabel(column),
            from: d.old ?? null,
            to: d.new ?? null,
        });
    }
    return out.sort(
        (a, b) => auditColumnRank(a.column) - auditColumnRank(b.column) || a.column.localeCompare(b.column),
    );
}

/** The columns a created / deleted receipt is summarised by, in the sheet's order. */
export const AUDIT_SUMMARY_COLUMNS: readonly string[] = [
    'delivery_date', 'truck_no', 'supplier_code', 'sacks', 'net_weight_kg',
    'destination_code', 'total_price_php',
];

/**
 * Every column of a SAMPLE snapshot worth showing, in sheet order and skipping the
 * plumbing. A draw is mostly nulls (one moisture reading is the common case), so the
 * caller drops the empties rather than rendering seven dashes.
 */
export function auditSnapshotColumns(
    snapshot: Record<string, unknown> | null,
    order: readonly string[],
): string[] {
    if (!snapshot) return [];
    return order.filter((c) => !AUDIT_SNAPSHOT_SKIP.has(c) && c in snapshot);
}

export const AUDIT_SAMPLE_SUMMARY_COLUMNS: readonly string[] = [
    'position', 'label', 'moisture_pct', 'bd', 'grit', 'ash', 'dust', 'vm', 'fc',
];

/** A formatted audit value, plus what the renderer needs to lay it out. */
export interface AuditValueText {
    text: string;
    /** Accounting layout: ₱ pinned left, figure right. */
    peso: boolean;
    /** `true` when the value is NULL — rendered as an em dash, not as "0". */
    empty: boolean;
    /** Right-align + `font-mono tabular-nums`. */
    numeric: boolean;
}

const AUDIT_RATE_COLUMNS = new Set(['base_price_php_kg', 'price_adjustment_php_kg', 'price_php_kg']);
const AUDIT_PESO_COLUMNS = new Set(['total_price_php', 'sheet_total_php']);
const AUDIT_KG_COLUMNS = new Set(['gross_weight_kg', 'net_weight_kg']);
const AUDIT_INT_COLUMNS = new Set(['sacks', 'source_row', 'position', 'delivery_year']);
const AUDIT_LAB_COLUMNS = new Set(['bd', 'moisture_pct', 'grit', 'ash', 'dust', 'vm', 'fc']);

/**
 * One audit value, formatted the way its column is formatted in the grid — kg to the
 * ledger's own precision, lab values to 2 dp (BD to 3), ₱ in accounting form, dates as
 * `yyyy-MM-dd`. The formatters are the module's existing ones; nothing new is invented,
 * so a figure in the history and the same figure in the sheet can never disagree.
 *
 * `delivery_date` needs no parsing — Postgres serialises a `date` to `yyyy-MM-dd`, which
 * is already the project format. It is sliced defensively in case a timestamp ever lands
 * in the column.
 */
export function formatAuditValue(column: string, value: unknown): AuditValueText {
    const numericCol =
        AUDIT_RATE_COLUMNS.has(column) ||
        AUDIT_PESO_COLUMNS.has(column) ||
        AUDIT_KG_COLUMNS.has(column) ||
        AUDIT_INT_COLUMNS.has(column) ||
        AUDIT_LAB_COLUMNS.has(column) ||
        column === 'deduction_pct';

    if (value === null || value === undefined || value === '') {
        return { text: '—', peso: false, empty: true, numeric: numericCol };
    }
    if (typeof value === 'boolean') {
        return { text: value ? 'yes' : 'no', peso: false, empty: false, numeric: false };
    }
    if (typeof value === 'object') {
        // `import_flags` and anything else structural. Compact JSON beats "[object Object]".
        return { text: JSON.stringify(value), peso: false, empty: false, numeric: false };
    }

    const scalar = value as number | string;
    if (AUDIT_PESO_COLUMNS.has(column)) {
        return { text: formatPeso(scalar), peso: true, empty: false, numeric: true };
    }
    if (AUDIT_RATE_COLUMNS.has(column)) {
        return { text: formatRate(scalar), peso: true, empty: false, numeric: true };
    }
    if (AUDIT_KG_COLUMNS.has(column)) {
        return { text: formatKg(scalar), peso: false, empty: false, numeric: true };
    }
    if (AUDIT_INT_COLUMNS.has(column)) {
        return { text: formatInt(scalar), peso: false, empty: false, numeric: true };
    }
    if (AUDIT_LAB_COLUMNS.has(column)) {
        return { text: formatLab(scalar, labDecimals(column)), peso: false, empty: false, numeric: true };
    }
    if (column === 'deduction_pct') {
        const n = num(scalar);
        return { text: n === null ? String(scalar) : `${n}%`, peso: false, empty: false, numeric: true };
    }
    if (column === 'delivery_date') {
        return { text: String(scalar).slice(0, 10), peso: false, empty: false, numeric: true };
    }
    return { text: String(scalar), peso: false, empty: false, numeric: false };
}

/** What an entry's headline says. One sentence, no jargon, no row ids. */
export function auditHeadline(entity: AuditEntity, operation: AuditOperation): string {
    if (entity === 'sample') {
        return operation === 'INSERT'
            ? 'Moisture draw added'
            : operation === 'DELETE'
              ? 'Moisture draw removed'
              : 'Moisture draw edited';
    }
    return operation === 'INSERT'
        ? 'Receipt created'
        : operation === 'DELETE'
          ? 'Receipt deleted'
          : 'Receipt edited';
}

// ═══ Save payloads (the UI ⇄ server-action contract) ════════════════════════════

/** The allowlisted patch keys `cenapro_save_rc_delivery` accepts. */
export type DeliveryPatch = Partial<{
    delivery_date: string | null;
    delivery_date_raw: string | null;
    truck_no: string | null;
    supplier_code: string | null;
    supplier_origin: string | null;
    permit_no: string | null;
    supplier_raw: string | null;
    sacks: number | null;
    gross_weight_kg: number | null;
    deduction_pct: number | null;
    weight_formula: string | null;
    bd: number | null;
    moisture_pct: number | null;
    grit: number | null;
    ash: number | null;
    dust: number | null;
    vm: number | null;
    fc: number | null;
    destination_code: string | null;
    destination_side: string | null;
    destination_raw: string | null;
    remarks: string | null;
    base_price_php_kg: number | null;
    price_adjustment_php_kg: number | null;
    price_formula: string | null;
}>;

/** One sub-sample in a replace-the-whole-block save. */
export interface SamplePayload {
    position: number;
    label: string | null;
    bd: number | null;
    moisture_pct: number | null;
    grit: number | null;
    ash: number | null;
    dust: number | null;
    vm: number | null;
    fc: number | null;
}

/**
 * One receipt's unit of work. `patch` and `samples` are BOTH optional and BOTH may be
 * present — the action applies the patch first (which bumps `row_version` via the touch
 * trigger) and threads the returned version into the samples call, so a combined edit
 * cannot conflict with itself.
 *
 * `id: null` is a DRAFT — a blank row the operator filled in at the bottom of the sheet.
 * `cenapro_save_rc_delivery` inserts when `p_id IS NULL`, and refuses the call outright
 * if an expected version is supplied alongside, so both fields travel as null together.
 * The RPC hands back the new row's `id` + `row_version`, which is why the result carries
 * an id of its own rather than echoing the input's.
 */
export interface SaveDeliveryInput {
    /** `null` ⇒ INSERT a new receipt. */
    id: string | null;
    /** `null` ⇒ INSERT (a blind update is refused by the RPC, and should be). */
    expectedRowVersion: number | null;
    patch?: DeliveryPatch;
    samples?: SamplePayload[];
    /**
     * The CLIENT's own row key — the receipt id for a stored row, the draft key for a
     * new one. Echoed back verbatim so a verdict can be matched to the row that produced
     * it even when the row had no id when it was sent.
     */
    key: string;
    /** Echoed back on the result so the client can name the row in an error. */
    label: string;
}

export type SaveOutcome =
    | 'updated'
    | 'inserted'
    | 'saved'
    | 'noop'
    | 'version_conflict'
    | 'not_found'
    | 'unsupported_field'
    | 'invalid'
    | 'rpc_error'
    | 'forbidden';

export interface SaveDeliveryResult {
    /** The client row key that was sent — the ONE reliable way back to the row. */
    key: string;
    /** The row's id AFTER the write: the input id for an update, the new id for an insert. */
    id: string | null;
    label: string;
    ok: boolean;
    outcome: SaveOutcome;
    rowVersion: number | null;
    message: string | null;
}
