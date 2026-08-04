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
// ─────────────────────────────────────────────────────────────────────────────────

import type { Database } from '@/types/supabase';
import {
    formulaCellText,
    priceFormulaFrom,
    weightFormulaFrom,
} from '@/lib/cenapro/rc-formula';
import { normalizeTypedDate } from '@/lib/paste-utils';

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

/** A receipt plus its samples — the unit the grid renders and the actions save. */
export interface DeliveryRecord {
    row: RcDeliveryRow;
    samples: RcDeliverySampleRow[];
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

/** Null every ₱ field on a row. Called in the SERVER fetch, before the payload leaves. */
export function stripPrices(row: RcDeliveryRow): RcDeliveryRow {
    return {
        ...row,
        base_price_php_kg: null,
        price_adjustment_php_kg: null,
        price_php_kg: null,
        price_formula: null,
        total_price_php: null,
        sheet_total_php: null,
        sheet_total_matches: null,
    };
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
    /** Part of the frozen identity block (`# · DATE · TRK# · SUPPLIER`). */
    frozen?: boolean;
    /** The field this column edits — `null` makes it unaddressable by the keyboard. */
    field: DeliveryField | null;
    /** How this column filters. Absent ⇒ the header offers no filter control. */
    filterKind?: FilterKind;
    /** The read-model column that filter addresses. Present iff `filterKind` is. */
    filterColumn?: DeliveryFilterColumn;
}

const BASE_COLS: DeliveryCol[] = [
    { key: 'num', label: '#', width: 44, title: 'Row number in view', frozen: true, field: null },
    {
        key: 'date',
        label: 'DATE',
        width: 92,
        frozen: true,
        field: 'delivery_date',
        filterKind: 'dateRange',
        filterColumn: 'delivery_date',
    },
    {
        key: 'truck',
        label: 'TRK#',
        width: 78,
        title: 'Truck plate / number',
        frozen: true,
        field: 'truck_no',
        filterKind: 'text',
        filterColumn: 'truck_no',
    },
    {
        key: 'supplier',
        label: 'SUPPLIER',
        width: 210,
        title: 'Trader − origin, plus the PSAU permit when the load carries one',
        frozen: true,
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
    },
];

/**
 * The column set for this viewer. When prices are gated the two ₱ columns are ABSENT
 * — not blanked — so the keyboard coordinate space has no unreachable holes in it and
 * the table geometry stays honest.
 */
export function buildColumns(canViewPrices: boolean): DeliveryCol[] {
    return canViewPrices ? [...BASE_COLS, ...PRICE_COLS] : [...BASE_COLS];
}

/** Cumulative `left` offsets for the frozen identity block, in column order. */
export function frozenOffsets(cols: DeliveryCol[]): number[] {
    const out: number[] = [];
    let x = 0;
    for (const c of cols) {
        if (!c.frozen) break;
        out.push(x);
        x += c.width;
    }
    return out;
}

export function minTableWidth(cols: DeliveryCol[]): number {
    return cols.reduce((sum, c) => sum + c.width, 0);
}

/** Cumulative `left` offset of EVERY column, index-aligned with `cols`. */
export function columnOffsets(cols: DeliveryCol[]): number[] {
    const out: number[] = [];
    let x = 0;
    for (const c of cols) {
        out.push(x);
        x += c.width;
    }
    return out;
}

/**
 * Total width of the pinned identity block — the strip of the scrollport that a
 * scrolling column is hidden UNDERNEATH rather than merely scrolled past. Same walk as
 * `frozenOffsets` (stop at the first non-frozen column), so the two can never disagree
 * about where the frozen block ends.
 */
export function frozenBlockWidth(cols: DeliveryCol[]): number {
    let x = 0;
    for (const c of cols) {
        if (!c.frozen) break;
        x += c.width;
    }
    return x;
}

export interface ColumnScrollInput {
    /** Index of the column the caret has just moved to. */
    col: number;
    cols: DeliveryCol[];
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
 *   • **The frozen block.** `# · DATE · TRK# · SUPPLIER` are pinned over the first 424px
 *     of the scrollport, so the window a scrolling column is actually visible in starts
 *     at `scrollLeft + frozenBlockWidth`, not at `scrollLeft`. Scrolling a target to its
 *     own `left` would park it UNDERNEATH the pinned columns, which reads as "Tab went
 *     somewhere invisible".
 *   • **Minimum nudge.** A column already fully inside that window returns null, so a
 *     purely VERTICAL move never shifts the sheet sideways — and a frozen column, which
 *     is visible at every offset, returns null always.
 */
export function columnScrollLeft(input: ColumnScrollInput): number | null {
    const { col, cols, scrollLeft, clientWidth, scrollWidth } = input;
    const c = cols[col];
    if (!c || c.frozen) return null;

    // Nothing overflows ⇒ nothing to scroll. This is also the branch that keeps the
    // maths honest: `table-fixed` + `width:100%` stretches the columns past their
    // declared widths ONLY when there is no overflow, so the declared widths below are
    // exact in precisely the case where they are consulted.
    const maxScroll = Math.max(0, scrollWidth - clientWidth);
    if (maxScroll <= 0) return null;

    const left = columnOffsets(cols)[col];
    const right = left + c.width;
    const frozen = frozenBlockWidth(cols);

    let next: number;
    if (left < scrollLeft + frozen) next = left - frozen;
    else if (right > scrollLeft + clientWidth) next = right - clientWidth;
    else return null;

    next = Math.max(0, Math.min(next, maxScroll));
    return next === scrollLeft ? null : next;
}

/** Visual row height (Excel Standard `h-8`). */
export const ROW_H = 32;
/** A sample sub-row is deliberately shorter — it is a detail line, not an entry. */
export const SAMPLE_ROW_H = 26;

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

// ═══ Unsaved cell text, and when it stops being unsaved ═════════════════════════

/** Per-receipt unsaved field edits, held as the raw text the operator typed. */
export type FieldEdits = Partial<Record<DeliveryField, string>>;

/**
 * Apply one cell's new text to a row's edit map — and DROP the field when the text is
 * back to what the database already holds.
 *
 * This is the whole of item 5. `useGridEditSession.revertChanges` cancels an Escape by
 * calling `setValue` with the pre-edit snapshot, which is a perfectly correct VALUE and
 * a perfectly wrong DIRTY STATE: the field stayed present in the map, so the row stayed
 * in `dirtyIds`, the unsaved-count chip kept counting it and Save stayed enabled with
 * nothing to write. Removing the key here fixes Escape as a special case of the general
 * rule — a cell typed back to its stored value is not an edit, however it got there.
 */
export function mergeFieldEdit(
    current: FieldEdits | undefined,
    field: DeliveryField,
    value: string,
    canonical: string,
): FieldEdits {
    const next: FieldEdits = { ...(current ?? {}) };
    if (value === canonical) delete next[field];
    else next[field] = value;
    return next;
}

/** Does this edit map hold anything worth saving? Whitespace alone does not count. */
export function isDirtyFieldEdits(edits: FieldEdits | undefined): boolean {
    if (!edits) return false;
    return Object.values(edits).some((v) => (v ?? '').trim() !== '');
}

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
    return {
        editedReceipts: dirtyReceipts.size,
        newRows: dirtyDrafts.size,
        total: dirtyReceipts.size + dirtyDrafts.size,
    };
}

/** True exactly when the Save button is enabled. The guard's whole firing condition. */
export function hasUnsavedWork(work: UnsavedWork): boolean {
    return work.total > 0;
}

/**
 * The phrase the guard dialog names the stakes with. Both kinds when both exist, and
 * never a kind that is zero — "0 typed new rows" reads as a machine talking to itself
 * and buries the number that matters.
 */
export function describeUnsavedWork(work: UnsavedWork): string {
    const parts: string[] = [];
    if (work.editedReceipts > 0) {
        parts.push(`${work.editedReceipts} edited receipt${work.editedReceipts === 1 ? '' : 's'}`);
    }
    if (work.newRows > 0) {
        parts.push(`${work.newRows} typed new row${work.newRows === 1 ? '' : 's'}`);
    }
    if (parts.length === 0) return 'nothing unsaved';
    return parts.join(' and ');
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

export const DEFAULT_DRAFT_ROWS = 20;
/** Defensive ceiling on one "add more rows" click — 20 blank rows is the point. */
export const MAX_DRAFT_ADD = 500;

export function clampDraftAdd(raw: string): number {
    const n = Number.parseInt(raw.trim(), 10);
    if (!Number.isFinite(n) || n < 1) return 1;
    return Math.min(n, MAX_DRAFT_ADD);
}

// ═══ Data-quality surface ═══════════════════════════════════════════════════════

/** Why a row is flagged. Drives the left rail colour and the row's badge set. */
export type RowIssue = 'duplicate' | 'unmapped' | 'flagged' | 'undated';

export function rowIssues(row: RcDeliveryRow): RowIssue[] {
    const out: RowIssue[] = [];
    if (row.is_suspected_duplicate) out.push('duplicate');
    if (row.supplier_unresolved || row.destination_unresolved) out.push('unmapped');
    if (!row.delivery_date && row.delivery_date_raw) out.push('undated');
    if (row.has_import_flags && !row.is_suspected_duplicate) out.push('flagged');
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
