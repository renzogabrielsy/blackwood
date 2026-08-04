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
}

const BASE_COLS: DeliveryCol[] = [
    { key: 'num', label: '#', width: 44, title: 'Row number in view', frozen: true, field: null },
    { key: 'date', label: 'DATE', width: 92, frozen: true, field: 'delivery_date' },
    { key: 'truck', label: 'TRK#', width: 78, title: 'Truck plate / number', frozen: true, field: 'truck_no' },
    {
        key: 'supplier',
        label: 'SUPPLIER',
        width: 210,
        title: 'Trader − origin, plus the PSAU permit when the load carries one',
        frozen: true,
        field: 'supplier',
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
    { key: 'bd', label: 'BD', width: 68, title: 'Bulk density', numeric: true, field: 'bd' },
    { key: 'moist', label: 'MOIST', width: 66, title: 'Moisture % — the official reading for the receipt', numeric: true, field: 'moisture_pct' },
    { key: 'grit', label: 'GRIT', width: 62, numeric: true, field: 'grit' },
    { key: 'ash', label: 'ASH', width: 62, numeric: true, field: 'ash' },
    { key: 'dust', label: 'DUST', width: 62, numeric: true, field: 'dust' },
    { key: 'vm', label: 'VM', width: 62, title: 'Volatile matter', numeric: true, field: 'vm' },
    { key: 'fc', label: 'FC', width: 62, title: 'Fixed carbon', numeric: true, field: 'fc' },
    { key: 'whse', label: 'WAREHOUSE', width: 128, title: 'Destination yard, with its side when the yard has one', field: 'destination' },
    { key: 'remarks', label: 'REMARKS', width: 200, field: 'remarks' },
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

/** Visual row height (Excel Standard `h-8`). */
export const ROW_H = 32;
/** A sample sub-row is deliberately shorter — it is a detail line, not an entry. */
export const SAMPLE_ROW_H = 26;

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
 */
export interface SaveDeliveryInput {
    id: string;
    expectedRowVersion: number;
    patch?: DeliveryPatch;
    samples?: SamplePayload[];
    /** Echoed back on the result so the client can match verdicts to rows. */
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
    id: string;
    label: string;
    ok: boolean;
    outcome: SaveOutcome;
    rowVersion: number | null;
    message: string | null;
}
