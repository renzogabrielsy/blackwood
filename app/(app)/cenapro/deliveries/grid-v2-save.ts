// ─────────────────────────────────────────────────────────────────────────────────
// RC Deliveries — the v2 grid's EDIT + SAVE model. PURE (no React, no Supabase).
//
// Stage 1D, slice 2 of the universal-table migration. `deliveries-grid-v2.tsx` is the
// React adapter; everything here is a plain function over plain data, so the whole of
// "what does this cell mean, and what does Save actually post" is asserted by
// `scripts/verify-rc-deliveries-cells.ts` without a browser or a database.
//
// It exists as its own file, rather than inside the grid, for one reason: the two things
// slice 2 can most easily get silently wrong — WHICH RECEIPT a moisture draw's edit
// belongs to, and WHAT PATCH a dirty row produces — are not observable from the screen.
// A wrong answer to the first saves the right numbers onto the wrong receipt; a wrong
// answer to the second posts a value nobody typed.
//
// ═══ THE DRAW-BLOCK MODEL, and the decision at the centre of it ══════════════════
//
// `useTableEdits` is keyed PER CELL — `(rowId, field)`. The old ledger's dirty state is
// not: it is *"a `sampleDrafts` entry exists for this receipt"*, `sameDrafts()` compares
// the WHOLE draw block, and `toSamplePayload` posts EVERY draw including untouched ones,
// because `cenapro_save_rc_delivery_samples` REPLACES the block. Three consequences, and
// each of them is a rule below:
//
//   1. **A draw row needs its own row id, and it must be STABLE.** Slice 1 keyed them
//      `${deliveryId}#${index}` — positional, and therefore wrong the moment the block
//      changes shape: the ledger's `addSample` inserts AFTER an index, so every draw below
//      the insertion point renumbers, and an edit filed under `#1` would silently re-point
//      onto the blank draw that took its place. **`drawKeyOf` uses the draw's own
//      `rc_delivery_sample.id`** — a database uuid, stable across any insert, delete or
//      reorder — falling back to `p<position>` only for a row whose id did not come back.
//      A client-added draw (slice 3, with the row context menu) mints its own `n<seq>`
//      key and is equally stable. **Nothing anywhere keys a draw by its position.**
//   2. **A receipt is dirty when ANY of its draws is.** `useTableEdits` reports dirty ROW
//      ids, so a receipt whose only change is a lab reading on its third draw is not in
//      that set under its own id at all — it is in there as `${deliveryId}#<drawKey>`.
//      `dirtyReceiptIds` is the union that fixes it, and it is the ONE place the fold from
//      row ids to receipt ids happens.
//   3. **The save reassembles the FULL block, untouched draws included** — `buildSampleBlock`
//      — and `position` is re-derived from the block's ORDER (`i + 1`), never read back
//      from the stored row. That is what makes an insert correct without renumbering any
//      key: identity is the uuid, ORDER is the payload, and the two are independent.
//
// ═══ ONE definition of a field's verdict ════════════════════════════════════════
//
// `patchField` is the only place a cell's text becomes database columns. The column
// specs' `parse` calls it (so a commit refuses exactly what Save would refuse) and
// `buildDeliveryPatch` calls it (so Save refuses exactly what a commit did). The old
// ledger's `buildPatch` is the same logic and is module-private in a file this slice may
// not edit; at cutover that file goes and this becomes the only copy.
// ─────────────────────────────────────────────────────────────────────────────────

import { parsePriceInput, parseWeightInput } from '@/lib/cenapro/rc-formula';

import {
    SAMPLE_LAB_FIELDS,
    formatKg,
    formatRate,
    formatSupplierCell,
    num,
    parseDeliveryDate,
    parseDestinationCell,
    parseSupplierCell,
    type DeliveryField,
    type DeliveryPatch,
    type DeliveryRecord,
    type RcDeliverySampleRow,
    type SampleLabField,
    type SamplePayload,
    type SaveOutcome,
} from './types';

// ═══ Row identity ═══════════════════════════════════════════════════════════════

/**
 * The separator between a receipt's id and one of its draws.
 *
 * A `#` is safe because the parent half is always a uuid, which cannot contain one — so
 * `parentRowId` is an exact split and never a guess.
 */
export const DRAW_ID_SEP = '#';

/** A blank row at the bottom of the sheet, before it has any identity of its own. */
export const DRAFT_PREFIX = 'draft:';

let draftSeq = 0;

/**
 * Fresh draft-row ids.
 *
 * A monotonic counter, never a random string: these are React keys AND the client half
 * of the save contract (`SaveDeliveryInput.key`), and two blank rows colliding would
 * merge two receipts' typing into one.
 */
export function makeDraftIds(n: number): string[] {
    return Array.from({ length: n }, () => `${DRAFT_PREFIX}${++draftSeq}`);
}

export function isDraftKey(rowId: string): boolean {
    return rowId.startsWith(DRAFT_PREFIX);
}

/**
 * A draw's STABLE key — its database id, and its position only as a last resort.
 *
 * The fallback exists because `rc_delivery_sample.id` is nullable in the generated view
 * type, not because a real row is ever without one. It is deliberately `p<position>`
 * rather than `p<index>`: `position` is the draw's own stored ordinal, so even the
 * fallback survives a reorder of the block around it.
 */
export function drawKeyOf(sample: RcDeliverySampleRow, index: number): string {
    const id = (sample.id ?? '').trim();
    if (id) return id;
    const pos = sample.position;
    return `p${pos === null || pos === undefined ? index + 1 : pos}`;
}

export function drawRowId(deliveryId: string, drawKey: string): string {
    return `${deliveryId}${DRAW_ID_SEP}${drawKey}`;
}

/** The receipt a row id belongs to — itself, for a receipt or a draft. */
export function parentRowId(rowId: string): string {
    const at = rowId.indexOf(DRAW_ID_SEP);
    return at < 0 ? rowId : rowId.slice(0, at);
}

export function isDrawRowId(rowId: string): boolean {
    return rowId.includes(DRAW_ID_SEP);
}

/**
 * THE dirty union — stored row ids folded onto the receipts they belong to.
 *
 * `useTableEdits.dirtyRecords` is per ROW, and a moisture draw is a row. Without this
 * fold, a receipt whose only unsaved change is a lab value on one of its draws is not in
 * the save's loop at all: it never looks dirty, the unsaved chip never counts it, Save
 * never posts it, and the operator's typing disappears at the next remount with no error
 * anywhere. Drafts are passed through unchanged (they have no draws).
 */
export function dirtyReceiptIds(dirtyRows: Iterable<string>): Set<string> {
    const out = new Set<string>();
    for (const rowId of dirtyRows) out.add(parentRowId(rowId));
    return out;
}

// ═══ The moisture-draw block ════════════════════════════════════════════════════

/** The unsaved-text map `useTableEdits` holds, as this module reads it. */
export type RowEditMap = Readonly<Record<string, Readonly<Record<string, string | undefined>>>>;

export interface SampleBlock {
    /** EVERY draw, in order, with the unsaved text folded in. The RPC replaces the block. */
    payload: SamplePayload[];
    /** At least one draw of this receipt carries unsaved text. */
    touched: boolean;
    /** Values the operator typed that are not numbers. Named, never silently nulled. */
    errors: string[];
}

/**
 * Rebuild a receipt's whole draw block from its stored draws plus whatever is unsaved.
 *
 * **Every draw is included, edited or not**, because `cenapro_save_rc_delivery_samples`
 * REPLACES the block: posting only the touched draws would delete the rest.
 *
 * **`position` comes from the block's ORDER, not from the stored row.** That is what
 * separates identity from ordering: a draw keeps its key (and therefore its edits) while
 * an insert above it moves its position, and a stored block with a gap in its positions
 * comes back renumbered `1..n` rather than preserving the gap.
 *
 * A lab value that is not a number is REPORTED rather than coerced. The old ledger runs
 * every draw field through `num()`, which turns `"1O.2"` into NULL and posts it as a
 * successful save — silently destroying a reading. The receipt-side rule already refuses
 * that by name (`patchField`'s lab branch), so the draw side does too.
 */
export function buildSampleBlock(
    deliveryId: string,
    samples: readonly RcDeliverySampleRow[],
    edits: RowEditMap,
): SampleBlock {
    const payload: SamplePayload[] = [];
    const errors: string[] = [];
    let touched = false;

    samples.forEach((s, i) => {
        const rowEdits = edits[drawRowId(deliveryId, drawKeyOf(s, i))];
        if (rowEdits && Object.keys(rowEdits).length > 0) touched = true;

        const read = (field: string): string => {
            const unsaved = rowEdits?.[field];
            if (unsaved !== undefined) return unsaved;
            const stored = (s as unknown as Record<string, unknown>)[field];
            return stored === null || stored === undefined ? '' : String(stored);
        };

        const draw: SamplePayload = {
            position: i + 1,
            label: read('label').trim() || null,
            bd: null,
            moisture_pct: null,
            grit: null,
            ash: null,
            dust: null,
            vm: null,
            fc: null,
        };

        for (const field of SAMPLE_LAB_FIELDS) {
            const text = read(field).trim();
            if (!text) continue;
            const n = num(text);
            if (n === null) {
                errors.push(`draw ${i + 1} ${field.toUpperCase()} "${text}" is not a number.`);
                continue;
            }
            draw[field as SampleLabField] = n;
        }

        payload.push(draw);
    });

    return { payload, touched, errors };
}

// ═══ ONE field, ONE verdict ═════════════════════════════════════════════════════

/** Everything a verdict needs that is not the text itself. */
export interface PatchEnv {
    supplierCodes: readonly string[];
    destinationCodes: readonly string[];
    /** A viewer who cannot SEE a price cannot WRITE one. Refused by name, never dropped. */
    canViewPrices: boolean;
    /** What a bare `6/27` means on THIS row. */
    contextYear: number;
}

export type FieldVerdict =
    | { ok: true; patch: DeliveryPatch }
    | { ok: false; error: string };

const DELIVERY_FIELDS: ReadonlySet<string> = new Set<DeliveryField>([
    'delivery_date', 'truck_no', 'supplier', 'sacks', 'wt',
    'bd', 'moisture_pct', 'grit', 'ash', 'dust', 'vm', 'fc',
    'destination', 'remarks', 'price',
]);

export function isDeliveryField(key: string): key is DeliveryField {
    return DELIVERY_FIELDS.has(key);
}

/**
 * One cell's text → the database columns behind it, or a sentence saying why not.
 *
 * The two dimension cells and the two formula cells are the whole reason this is a
 * function and not an object spread: each is ONE cell that becomes THREE columns, and a
 * value that does not resolve comes back as an error rather than being written as an
 * unresolved row. The import was allowed to leave a supplier NULL because it was
 * transcribing a workbook nobody can go back and ask about; a human typing today can be
 * asked, so this refuses instead.
 *
 * **A BLANK cell is judged here, and it is not always legal.** `delivery_date` and
 * `supplier` refuse a blank outright; every other field takes it as an explicit clear.
 * The column specs deliberately do NOT run a blank through this at COMMIT time — see
 * `parseCellText` in the grid — because clearing a cell you are about to retype must not
 * raise a persistent refusal. Save is where a blank that cannot stand is caught.
 */
export function patchField(field: DeliveryField, raw: string, env: PatchEnv): FieldVerdict {
    const text = (raw ?? '').trim();

    switch (field) {
        case 'delivery_date': {
            if (!text) return { ok: false, error: 'a receipt entered in the app needs a date.' };
            const parsed = parseDeliveryDate(text, env.contextYear);
            if ('error' in parsed) {
                return { ok: false, error: `the DATE cell — ${parsed.error}` };
            }
            return { ok: true, patch: { delivery_date: parsed.iso } };
        }

        case 'truck_no':
            return { ok: true, patch: { truck_no: text || null } };

        case 'supplier': {
            if (!text) {
                return {
                    ok: false,
                    error: 'the supplier cannot be cleared — a receipt with no payee cannot be liquidated.',
                };
            }
            const parsed = parseSupplierCell(text, env.supplierCodes);
            if ('error' in parsed) return { ok: false, error: parsed.error };
            return {
                ok: true,
                patch: {
                    supplier_code: parsed.supplier_code,
                    supplier_origin: parsed.supplier_origin,
                    permit_no: parsed.permit_no,
                    // The raw column is the operator's own words — rewrite it to what they
                    // just typed, so the row's audit trail matches the screen.
                    supplier_raw: text,
                },
            };
        }

        case 'destination': {
            if (!text) {
                return {
                    ok: true,
                    patch: { destination_code: null, destination_side: null, destination_raw: null },
                };
            }
            const parsed = parseDestinationCell(text, env.destinationCodes);
            if ('error' in parsed) return { ok: false, error: parsed.error };
            return {
                ok: true,
                patch: {
                    destination_code: parsed.destination_code,
                    destination_side: parsed.destination_side,
                    destination_raw: text,
                },
            };
        }

        case 'sacks': {
            if (!text) return { ok: true, patch: { sacks: null } };
            const n = num(text);
            if (n === null || n < 0) return { ok: false, error: `"${text}" is not a sack count.` };
            return { ok: true, patch: { sacks: Math.round(n) } };
        }

        case 'wt': {
            if (!text) {
                return {
                    ok: true,
                    patch: { gross_weight_kg: null, deduction_pct: null, weight_formula: null },
                };
            }
            const parsed = parseWeightInput(text);
            if ('error' in parsed) return { ok: false, error: `WT "${text}" — ${parsed.error}` };
            // The DB derives `net_weight_kg` (and `total_price_php`) from these three.
            // Nothing here computes the net; a generated column cannot be written to.
            return {
                ok: true,
                patch: {
                    gross_weight_kg: parsed.grossKg,
                    deduction_pct: parsed.deductionPct,
                    weight_formula: parsed.formula,
                },
            };
        }

        case 'price': {
            if (!env.canViewPrices) return { ok: false, error: 'your role cannot edit price data.' };
            if (!text) {
                return {
                    ok: true,
                    patch: { base_price_php_kg: null, price_adjustment_php_kg: null, price_formula: null },
                };
            }
            const parsed = parsePriceInput(text);
            if ('error' in parsed) return { ok: false, error: `PHP/KG "${text}" — ${parsed.error}` };
            return {
                ok: true,
                patch: {
                    base_price_php_kg: parsed.basePhpKg,
                    price_adjustment_php_kg: parsed.adjustmentPhpKg,
                    price_formula: parsed.formula,
                },
            };
        }

        case 'remarks':
            return { ok: true, patch: { remarks: text || null } };

        default: {
            // A lab column.
            if (!text) return { ok: true, patch: { [field]: null } as DeliveryPatch };
            const n = num(text);
            if (n === null) return { ok: false, error: `${field.toUpperCase()} "${text}" is not a number.` };
            return { ok: true, patch: { [field]: n } as DeliveryPatch };
        }
    }
}

/**
 * A whole row's unsaved text → the allowlisted patch, plus every refusal by name.
 *
 * Keys that are not editable fields (`num`, `ttl`, `settle`) are skipped rather than
 * refused: they can never carry an edit — no slot marks them editable — so reaching one
 * would be a programming error in this file, not something to tell an operator about.
 */
export function buildDeliveryPatch(
    fieldEdits: Readonly<Record<string, string | undefined>>,
    env: PatchEnv,
): { patch: DeliveryPatch; errors: string[] } {
    const patch: DeliveryPatch = {};
    const errors: string[] = [];

    for (const [key, raw] of Object.entries(fieldEdits)) {
        if (raw === undefined) continue;
        if (!isDeliveryField(key)) continue;
        const verdict = patchField(key, raw, env);
        if (verdict.ok) Object.assign(patch, verdict.patch);
        else errors.push(verdict.error);
    }

    return { patch, errors };
}

// ═══ Naming a row in an error ═══════════════════════════════════════════════════

/** How a receipt is named in an error message — enough to find it in the sheet. */
export function rowLabel(rec: DeliveryRecord): string {
    const r = rec.row;
    const date = r.delivery_date ?? r.delivery_date_raw ?? 'undated';
    const who = formatSupplierCell(r) || 'unknown supplier';
    const truck = r.truck_no ? ` · ${r.truck_no}` : '';
    return `${date} · ${who}${truck}`;
}

/** How a blank row is named in an error message, before it has an identity of its own. */
export function draftLabel(
    edits: Readonly<Record<string, string | undefined>>,
    defaultDate: string,
): string {
    const date = (edits.delivery_date ?? defaultDate).trim() || 'undated';
    const who = (edits.supplier ?? '').trim() || 'no supplier';
    const truck = (edits.truck_no ?? '').trim();
    return `new row ${date} · ${who}${truck ? ` · ${truck}` : ''}`;
}

/**
 * What the RPC's verdict means, in a sentence.
 *
 * **A stale-version refusal is a normal outcome, not a crash** — the save RPCs are
 * compare-and-set on `row_version`, so someone else saving the same receipt while you
 * were typing lands here. The database's own message is always appended rather than
 * replaced: it names the row and the version, and swallowing it would leave the operator
 * with a sentence and no evidence.
 */
export function saveOutcomeMessage(outcome: SaveOutcome, message: string | null): string {
    const head =
        outcome === 'version_conflict'
            ? 'someone else changed this receipt while you were typing, so nothing was written — reload the ledger and make the edit again'
            : outcome === 'forbidden'
              ? 'your role is not allowed to make that change'
              : outcome === 'not_found'
                ? 'that receipt is no longer in the database'
                : outcome === 'invalid'
                  ? 'the database refused the values'
                  : outcome === 'unsupported_field'
                    ? 'the save carried a field the database does not accept'
                    : outcome === 'rpc_error'
                      ? 'the database refused the write'
                      : `the save came back "${outcome}"`;
    const detail = (message ?? '').trim();
    return detail ? `${head} — ${detail}` : `${head}.`;
}

// ═══ What an UNSAVED cell shows at rest ═════════════════════════════════════════

/**
 * The text a cell carrying an unsaved value shows when it does not have focus.
 *
 * Only the two formula lanes differ from the raw text: `=27045*88%` becomes the kilos it
 * evaluates to, so a row being typed reads exactly like the stored receipt above it and a
 * numeric column keeps its alignment. Unparseable text is left VERBATIM — the operator's
 * typing is never replaced by a guess, and Save refuses it by name.
 *
 * One function for stored rows and blank rows alike, which is why it takes the column key
 * rather than a row: a dirty WT is a dirty WT wherever it is.
 */
export function editedCellText(colKey: string, text: string): string {
    if (!text.trim()) return '';
    if (colKey === 'wt') {
        const parsed = parseWeightInput(text);
        return 'error' in parsed ? text : formatKg(parsed.netKg);
    }
    if (colKey === 'php_kg') {
        const parsed = parsePriceInput(text);
        return 'error' in parsed ? text : formatRate(parsed.effectivePhpKg);
    }
    return text;
}
