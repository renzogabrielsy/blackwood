// ─────────────────────────────────────────────────────────────────────────────────
// RC IN — the v2 grid's EDIT + SAVE model. PURE (no React, no Supabase, no actions).
//
// `delivery-grid-v2.tsx` is the React adapter; everything here is a plain function over
// plain data, so the two things this pass can most easily get silently wrong — WHAT PATCH
// a dirty row produces, and WHAT HAPPENS TO THE LAB PANEL a partial edit touches — are
// asserted by `scripts/verify-rc-in-grid.ts` without a browser or a database.
//
// It is the sibling of `app/(app)/cenapro/deliveries/grid-v2-save.ts` and follows its
// shape deliberately. Where it DIFFERS, it differs because the server on this side is a
// different shape, and each difference is written down below.
//
// ═══ THE PAYLOAD IS A **WHOLE ROW**, NOT A PATCH — and that is the server's rule ══
//
// Cenapro's `cenapro_save_rc_delivery` takes an allowlisted PARTIAL patch. RC IN's
// `bulkUpdateDeliveries` does not, and cannot be made to: `toDeliveryPayload` in
// `actions.ts` (which this file may not edit) rebuilds a fixed object from the row it is
// handed —
//
//     block_loc:  row.block_loc ? normalizeBlockLoc(row.block_loc) : null
//     weight_kg:  Number(row.weight_kg)      // Number(undefined) → NaN → JSON null
//     sacks:      Number(row.sacks)
//     cost_basis: row.cost_basis == null ? 0 : Number(row.cost_basis)
//
// — so a genuinely partial `data` object does not leave the other columns alone: it
// CLEARS `block_loc`, writes NULL over `weight_kg`/`sacks`, and writes **₱0 over the
// price**. `upsertBatchesFromRows` would additionally upsert a batch whose `batch_code`
// is `undefined`. Therefore every update this file produces is a COMPLETE `DeliveryRow`,
// assembled as *stored value unless the operator typed over it* — exactly what the
// bulk-input dialog's `inputRowToDelivery` sends, and the same coercions.
//
// ═══ THE LAB PANEL — why a partial edit still sends a FULL panel ═════════════════
//
// `fn_bulk_update_deliveries` merges with `to_jsonb(d) || v_data`, which is a **SHALLOW**
// jsonb merge: a `lab_results` object in the payload REPLACES the stored one wholesale,
// key for key. So sending `{ mc: 12 }` after an MC edit would delete GRIT, VM, ASH, FC and
// both BD readings from that delivery — six lab values gone, with a successful save and no
// error anywhere. The panel is therefore always reassembled from **the stored object plus
// the edits**, so untouched keys ride back unchanged.
//
// One deliberate improvement over the dialog, and it can only ever preserve MORE: the
// dialog rebuilds the panel as seven `parseFloat(...) || 0` fields, so editing a remark on
// a delivery whose panel was never filled in writes seven fabricated `0.00` readings — and
// a 0 in a lab lane is a READING, not a blank. Here an untouched key is copied verbatim
// (an absent one stays absent) and only a key the operator actually typed into is written.
// A cleared lab cell DELETES its key rather than storing 0, for the same reason.
// **Inserts still get the dialog's full seven-zero panel** — a new row has no stored panel
// to preserve, so there is nothing to improve and shape parity is worth more.
//
// ═══ THE ₱ RULE, AND WHY IT CLOSES THE WHOLE DOOR FOR A GATED ROLE ══════════════
//
// `page.tsx` sends `cost_basis: showPrices ? d.cost_basis : undefined`, so a Production
// viewer's rows carry no price. A whole-row payload built from those rows would hand
// `toDeliveryPayload` an undefined `cost_basis`, which it turns into **0** — the L-008
// unpriced placeholder — over a real delivered price, on every row the viewer touched.
// There is no partial-patch door available (see above) and this pass may not write a new
// server action. So the save path is CLOSED for a role that cannot see prices, refused
// here by name and never offered in the grid (`canEdit` is `canViewPrices`). That is a
// smaller loss than it sounds: the v2 grid was read-only for everyone until now.
// ─────────────────────────────────────────────────────────────────────────────────

import { normalizeTypedDate, stripNumericFormatting, trimCellValue } from '@/lib/paste-utils';
import { normalizeBlockLoc, validateBlockLoc } from '@/lib/validation';
import type { DeliveryHistoryRow, DeliveryRow } from '@/types/rc-in';

// ═══ Row identity ═══════════════════════════════════════════════════════════════

/** A blank row at the bottom of the sheet, before it has any identity of its own. */
export const DRAFT_PREFIX = 'draft:';

let draftSeq = 0;

/**
 * Fresh draft-row ids.
 *
 * A monotonic counter, never a random string: these are React keys AND the key each
 * draft's typing is filed under, and two blank rows colliding would merge two deliveries
 * into one.
 */
export function makeDraftIds(n: number): string[] {
    return Array.from({ length: n }, () => `${DRAFT_PREFIX}${++draftSeq}`);
}

export function isDraftKey(rowId: string): boolean {
    return rowId.startsWith(DRAFT_PREFIX);
}

// ═══ The fields ═════════════════════════════════════════════════════════════════

/**
 * The seven lab lanes and their precision — CLAUDE.md's "RC IN Column Config": MC · Grit ·
 * VM · Ash · FC to 2 places, BD ASTM · BD JIS to 3. The decimals live beside the parse so
 * a cell, the clipboard and the payload can never disagree about how many a lane has.
 */
export const LAB_FIELDS = ['mc', 'grit', 'vm', 'ash', 'fc', 'bd_astm', 'bd_jis'] as const;
export type LabField = (typeof LAB_FIELDS)[number];

export const LAB_DECIMALS: Readonly<Record<LabField, number>> = {
    mc: 2, grit: 2, vm: 2, ash: 2, fc: 2, bd_astm: 3, bd_jis: 3,
};

const LAB_SET: ReadonlySet<string> = new Set<string>(LAB_FIELDS);

export function isLabField(key: string): key is LabField {
    return LAB_SET.has(key);
}

/**
 * Every field an operator may type into — exactly the fields the bulk-input dialog lets
 * them set, and nothing else. `state` (the joined batch's status) and `php_total`
 * (arithmetic over two other cells) are not on this list and never can be.
 */
export const RC_IN_EDIT_FIELDS = [
    'transaction_date', 'supplier', 'batch_code', 'block_loc', 'truck_plate',
    'sacks', 'weight_kg', ...LAB_FIELDS, 'cost_basis', 'remarks',
] as const;
export type RcInField = (typeof RC_IN_EDIT_FIELDS)[number];

const EDIT_SET: ReadonlySet<string> = new Set<string>(RC_IN_EDIT_FIELDS);

export function isRcInEditField(key: string): key is RcInField {
    return EDIT_SET.has(key);
}

// ═══ Canonical cell text — ONE definition, shared by the grid and the save ═══════

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function numText(v: unknown): string {
    return v === null || v === undefined || v === '' ? '' : String(v);
}

/** The ₱ a delivery is worth. One definition, so the cell, the pill and the totals agree. */
export function phpTotalOf(row: DeliveryHistoryRow): number {
    const n = (v: unknown): number => {
        const x = typeof v === 'number' ? v : Number.parseFloat(String(v ?? ''));
        return Number.isFinite(x) ? x : 0;
    };
    return n(row.weight_kg) * n(row.cost_basis);
}

/**
 * A lab reading off a stored row.
 *
 * `lab_results` is TYPED as seven required numbers and is not one at runtime: it is a
 * JSONB blob, and a panel nobody has filled in arrives with the key missing, null, or an
 * empty string. Hence the widening — the type is the optimistic reading, this is what the
 * database actually holds.
 */
export function labValueOf(row: DeliveryHistoryRow, key: LabField): number | null {
    const raw: unknown = (row.lab_results as Record<string, unknown> | null | undefined)?.[key];
    if (raw === null || raw === undefined || raw === '') return null;
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
}

export function labTextOf(row: DeliveryHistoryRow, key: LabField): string {
    const v = labValueOf(row, key);
    return v === null ? '' : v.toFixed(LAB_DECIMALS[key]);
}

/**
 * What a cell HOLDS as text.
 *
 * Three consumers, and they MUST agree or the sheet misbehaves in ways nothing on screen
 * explains: it is the editor's opening value, the jump keys' "is this cell filled" probe,
 * and — through `useTableEdits`' `canonicalText` — the value an edit must return to in
 * order to stop counting as unsaved. It is also what the save reads for every field the
 * operator did NOT touch, which is what makes the whole-row payload above correct.
 *
 * A DRAFT row (`row === null`) holds nothing except the sheet's seeded date, which the
 * caller supplies — that is what makes typing the default date by hand a NON-edit rather
 * than a row that can never be made clean again.
 */
export function storedFieldText(row: DeliveryHistoryRow | null, field: string): string {
    if (!row) return '';
    switch (field) {
        case 'state': return row.state || 'STORED';
        case 'transaction_date': return row.transaction_date ?? '';
        case 'supplier': return row.supplier ?? '';
        case 'batch_code': return row.batch_code ?? '';
        // The same fallback the live table uses: the batch's `location_ref` when the
        // delivery carries none of its own.
        case 'block_loc': return row.block_loc || row.batches?.location_ref || '';
        case 'truck_plate': return row.truck_plate ?? '';
        case 'sacks': return numText(row.sacks);
        case 'weight_kg': return numText(row.weight_kg);
        case 'cost_basis': return numText(row.cost_basis);
        case 'remarks': return row.remarks ?? '';
        // Not editable, but NOT empty either. `storedText` is what the jump keys read to
        // decide whether a cell is FILLED, so returning '' here would make a column of
        // computed totals read as a blank gap to Ctrl+Arrow.
        case 'php_total': return String(phpTotalOf(row));
        default: return isLabField(field) ? labTextOf(row, field) : '';
    }
}

/**
 * What an UNTOUCHED field contributes to a whole-row payload — `storedFieldText` in every
 * lane but one.
 *
 * **`block_loc` is the exception, and it matters.** The sheet DISPLAYS the batch's
 * `location_ref` when a delivery carries no location of its own (the live table's habit,
 * kept). Reading that back into a save would take a fallback the operator is only being
 * SHOWN and write it onto the delivery — a column silently filled in on every row an
 * unrelated remark edit touched. The dialog's `deliveryToInputRow` has no fallback for
 * exactly this reason, and this matches it.
 *
 * The two answers cannot desync in the other direction either: `mergeFieldEdit` compares
 * against the DISPLAYED text, so typing the fallback back into the cell is a non-edit and
 * never reaches the payload at all.
 */
export function savedFieldText(row: DeliveryHistoryRow, field: string): string {
    if (field === 'block_loc') return row.block_loc ?? '';
    return storedFieldText(row, field);
}

// ═══ ONE field, ONE verdict ═════════════════════════════════════════════════════

/** Everything a verdict needs that is not the text itself. */
export interface PatchEnv {
    /**
     * A viewer who cannot SEE a price cannot WRITE one — and on this side cannot write
     * ANYTHING, because the only available server action rewrites the ₱ column on every
     * row it touches. Refused by name, never dropped silently.
     */
    canViewPrices: boolean;
    /** What a bare `6/27` means on THIS row. */
    contextYear: number;
}

export type FieldVerdict =
    | { ok: true; value: string | number | null }
    | { ok: false; error: string };

/**
 * Canonicalise what the operator COMMITTED, before it is written.
 *
 * Two lanes have a canonical spelling the server would impose anyway, and imposing it at
 * commit is what makes the sheet show what will actually be stored:
 *
 *   • **DATE** — `6/27` becomes `2026-06-27` the moment you leave the cell, Excel's own
 *     habit. Without it the sheet holds two spellings of one date (`cleanPasted` already
 *     writes ISO for the same text arriving on the clipboard), and a shorthand equal to
 *     the stored value could never stop counting as dirty.
 *   • **BLOCK/LOC** — `a-12b` becomes `A-12B`, because `toDeliveryPayload` runs
 *     `normalizeBlockLoc` on the way to the database regardless. A cell that shows one
 *     spelling and stores another is a lie the operator cannot see.
 *
 * It may NOT refuse: `parseRcInField` runs immediately afterwards on whatever this
 * returns, which is what keeps unreadable text both KEPT VERBATIM and REFUSED BY NAME.
 */
export function normalizeRcInField(field: string, text: string, env: PatchEnv): string {
    if (!text.trim()) return text;
    if (field === 'transaction_date') return normalizeTypedDate(text, env.contextYear);
    if (field === 'block_loc') return normalizeBlockLoc(text);
    return text;
}

/**
 * One cell's text → the value that goes on the row, or a sentence saying why not.
 *
 * **A BLANK cell is legal here and means CLEARED** (`value: null`). The row builder decides
 * what a cleared cell becomes per field — `''` for text, `0` for a number, a deleted key in
 * the lab panel — and the two fields a delivery cannot exist without (`transaction_date`,
 * `batch_code`) are refused at ROW level rather than here, so clearing a cell you are about
 * to retype does not raise a persistent toast mid-typing. Same line the cenapro sheet and
 * the live table both draw.
 */
export function parseRcInField(field: RcInField, raw: string, env: PatchEnv): FieldVerdict {
    const text = (raw ?? '').trim();

    switch (field) {
        case 'transaction_date': {
            if (!text) return { ok: true, value: null };
            const iso = normalizeTypedDate(text, env.contextYear);
            if (!ISO_DATE.test(iso)) {
                return { ok: false, error: `the DATE cell — "${text}" is not a date I can read (try 2026-08-21, 8/21 or 8/21/26).` };
            }
            return { ok: true, value: iso };
        }

        case 'supplier':
        case 'truck_plate':
        case 'batch_code':
        case 'remarks':
            return { ok: true, value: text || null };

        case 'block_loc': {
            if (!text) return { ok: true, value: null };
            const loc = normalizeBlockLoc(text);
            // The SAME predicate `actions.ts` runs server-side, asked here so the refusal
            // arrives on the cell rather than as a whole-batch rejection after Save.
            const verdict = validateBlockLoc(loc);
            if (!verdict.valid) return { ok: false, error: `the LOC cell — ${verdict.error}` };
            return { ok: true, value: loc };
        }

        case 'sacks': {
            if (!text) return { ok: true, value: null };
            const n = Number(stripNumericFormatting(text));
            if (!Number.isFinite(n) || n < 0) return { ok: false, error: `SKS "${text}" is not a sack count.` };
            return { ok: true, value: Math.round(n) };
        }

        case 'weight_kg': {
            if (!text) return { ok: true, value: null };
            const n = Number(stripNumericFormatting(text));
            if (!Number.isFinite(n) || n < 0) return { ok: false, error: `WEIGHT "${text}" is not a weight in kilograms.` };
            return { ok: true, value: n };
        }

        case 'cost_basis': {
            if (!env.canViewPrices) return { ok: false, error: 'your role cannot edit price data.' };
            if (!text) return { ok: true, value: null };
            const n = Number(stripNumericFormatting(text));
            if (!Number.isFinite(n) || n < 0) return { ok: false, error: `PHP/KG "${text}" is not a price.` };
            return { ok: true, value: n };
        }

        default: {
            // A lab lane.
            if (!text) return { ok: true, value: null };
            const n = Number(stripNumericFormatting(text));
            if (!Number.isFinite(n)) {
                return { ok: false, error: `${field.toUpperCase().replace('_', ' ')} "${text}" is not a number.` };
            }
            return { ok: true, value: n };
        }
    }
}

/**
 * A pasted cell loses whatever rendering a spreadsheet copied in with it, per column —
 * and a pasted DATE goes through the SAME normalisation a typed one does, with the same
 * context year, so `8/21` typed and `8/21` pasted can never land on two different years.
 */
export function cleanPastedRcInCell(field: string, raw: string, env: PatchEnv): string {
    const text = trimCellValue(raw);
    if (!text) return text;
    if (field === 'transaction_date') return normalizeTypedDate(text, env.contextYear);
    if (field === 'block_loc') return normalizeBlockLoc(text);
    if (field === 'sacks' || field === 'weight_kg' || field === 'cost_basis' || isLabField(field)) {
        return stripNumericFormatting(text);
    }
    return text;
}

// ═══ A whole row ════════════════════════════════════════════════════════════════

/** The unsaved-text map `useTableEdits` holds, as this module reads it. */
export type RowEditMap = Readonly<Record<string, Readonly<Record<string, string | undefined>>>>;
export type FieldEditMap = Readonly<Record<string, string | undefined>>;

type LabPanel = DeliveryRow['lab_results'];

export interface BuiltRow {
    /** The complete payload, or null when the row was refused or had nothing to say. */
    row: DeliveryRow | null;
    /** Every refusal, by name. Nothing is written unless this is empty for EVERY row. */
    errors: string[];
}

/**
 * The lab panel a save should send.
 *
 * `undefined` means "say nothing about the panel" — the key is then absent from the JSON
 * and `to_jsonb(d) || data` leaves the stored panel exactly as it was. That is the answer
 * whenever no lab cell was edited, so an ordinary remark edit cannot disturb seven
 * readings it never looked at.
 */
function buildLabPanel(
    base: DeliveryHistoryRow | null,
    edits: FieldEditMap,
    env: PatchEnv,
    errors: string[],
): LabPanel | undefined {
    const touched = LAB_FIELDS.filter((f) => edits[f] !== undefined);

    if (base === null) {
        // A NEW delivery: the dialog's shape exactly — all seven keys, blank reading as 0.
        // There is no stored panel to preserve, so there is nothing to improve on.
        const panel: Record<string, number> = {};
        for (const f of LAB_FIELDS) {
            const verdict = parseRcInField(f, edits[f] ?? '', env);
            if (!verdict.ok) { errors.push(verdict.error); continue; }
            panel[f] = typeof verdict.value === 'number' ? verdict.value : 0;
        }
        return panel as LabPanel;
    }

    if (touched.length === 0) {
        // Untouched. Hand back the stored object BY REFERENCE — identical bytes on the
        // wire to what the row already holds, and never `{}` over a stored null.
        return (base.lab_results ?? undefined) as LabPanel | undefined;
    }

    // Stored ∪ edits. A SHALLOW jsonb merge replaces the whole object, so every untouched
    // key has to ride along or it is deleted.
    const panel: Record<string, unknown> = { ...((base.lab_results as Record<string, unknown> | null) ?? {}) };
    for (const f of touched) {
        const verdict = parseRcInField(f, edits[f] ?? '', env);
        if (!verdict.ok) { errors.push(verdict.error); continue; }
        // A CLEARED lab cell deletes its key rather than storing 0 — a 0 in a lab lane is
        // a reading, and "we never measured it" is a different fact from "it measured 0".
        if (verdict.value === null) delete panel[f];
        else panel[f] = verdict.value;
    }
    return panel as LabPanel;
}

/** The refusal a price-blind role gets, in one place so both locks say the same thing. */
export const PRICE_BLIND_REFUSAL =
    'your role cannot save deliveries here — this save path rewrites every column of the row including PHP/KG, and the price is withheld from your view, so saving would overwrite it with zero. Ask someone who can see prices to make this edit.';

/**
 * A stored delivery plus its unsaved text → the COMPLETE row the server action wants.
 *
 * Every field is read as *the operator's text if they typed one, otherwise the stored
 * value* — through `storedFieldText`, the same function `canonicalText` uses, so the value
 * that stopped counting as dirty and the value that gets saved are produced by one
 * function and cannot drift.
 *
 * The coercions are the bulk-input dialog's, deliberately: `parseInt(...) || 0` for sacks,
 * `parseFloat(...) || 0` for the three decimals. A cleared numeric cell therefore saves 0,
 * which is what the dialog does today and what `toDeliveryPayload` would produce anyway.
 */
export function buildDeliveryUpdate(
    base: DeliveryHistoryRow,
    edits: FieldEditMap,
    env: PatchEnv,
): BuiltRow {
    const errors: string[] = [];
    if (!env.canViewPrices) return { row: null, errors: [PRICE_BLIND_REFUSAL] };

    const values: Record<string, string | number | null> = {};
    for (const field of RC_IN_EDIT_FIELDS) {
        if (isLabField(field)) continue; // the panel is assembled separately
        const raw = edits[field];
        if (raw === undefined) continue;
        const verdict = parseRcInField(field, raw, env);
        if (verdict.ok) values[field] = verdict.value;
        else errors.push(verdict.error);
    }

    const lab = buildLabPanel(base, edits, env, errors);

    const pick = (field: RcInField): string => {
        if (field in values) {
            const v = values[field];
            return v === null || v === undefined ? '' : String(v);
        }
        return savedFieldText(base, field);
    };

    const date = pick('transaction_date');
    const batchCode = pick('batch_code');
    if (!date) errors.push('a delivery needs a date — the DATE cell cannot be cleared.');
    if (!batchCode) errors.push('a delivery needs a batch code — the BATCH cell cannot be cleared.');

    if (errors.length > 0) return { row: null, errors };

    return {
        row: {
            // Stripped by `toDeliveryPayload`; carried for shape parity with the dialog.
            state: base.state || 'STORED',
            transaction_date: date,
            supplier: pick('supplier'),
            batch_code: batchCode,
            block_loc: pick('block_loc'),
            truck_plate: pick('truck_plate'),
            sacks: Number.parseInt(pick('sacks'), 10) || 0,
            weight_kg: Number.parseFloat(pick('weight_kg')) || 0,
            cost_basis: Number.parseFloat(pick('cost_basis')) || 0,
            remarks: pick('remarks'),
            // `undefined` is DROPPED by `JSON.stringify`, so an untouched null panel says
            // nothing at all rather than writing `{}` over it.
            lab_results: lab as LabPanel,
        },
        errors: [],
    };
}

/**
 * A blank row's unsaved text → a NEW delivery, or a refusal.
 *
 * The validity rule is the dialog's, verbatim: **a batch code and a weight above zero**
 * (`rows.forEach` in `handleSubmit`). A blank row the operator never touched is not
 * offered here at all — `useTableEdits` reports only drafts carrying real values.
 */
export function buildDeliveryInsert(
    edits: FieldEditMap,
    defaultDate: string,
    env: PatchEnv,
): BuiltRow {
    const errors: string[] = [];
    if (!env.canViewPrices) return { row: null, errors: [PRICE_BLIND_REFUSAL] };

    const values: Record<string, string | number | null> = {};
    for (const field of RC_IN_EDIT_FIELDS) {
        if (isLabField(field)) continue;
        const raw = field === 'transaction_date' ? (edits[field] ?? defaultDate) : edits[field];
        if (raw === undefined) continue;
        const verdict = parseRcInField(field, raw, env);
        if (verdict.ok) values[field] = verdict.value;
        else errors.push(verdict.error);
    }

    const lab = buildLabPanel(null, edits, env, errors);

    const pick = (field: RcInField): string => {
        const v = values[field];
        return v === null || v === undefined ? '' : String(v);
    };

    const date = pick('transaction_date');
    const batchCode = pick('batch_code');
    const weight = Number.parseFloat(pick('weight_kg')) || 0;

    if (!date) errors.push('a new delivery needs a date.');
    if (!batchCode) errors.push('a new delivery needs a batch code — the batch is what the weight is booked against.');
    if (!(weight > 0)) errors.push('a new delivery needs a weight above 0 kg.');

    if (errors.length > 0) return { row: null, errors };

    return {
        row: {
            state: 'STORED',
            transaction_date: date,
            supplier: pick('supplier'),
            batch_code: batchCode,
            block_loc: pick('block_loc'),
            truck_plate: pick('truck_plate'),
            sacks: Number.parseInt(pick('sacks'), 10) || 0,
            weight_kg: weight,
            cost_basis: Number.parseFloat(pick('cost_basis')) || 0,
            remarks: pick('remarks'),
            lab_results: lab as LabPanel,
        },
        errors: [],
    };
}

// ═══ Naming a row in an error ═══════════════════════════════════════════════════

/** How a stored delivery is named in a refusal — enough to find it in the sheet. */
export function rowLabel(row: DeliveryHistoryRow): string {
    const date = row.transaction_date || 'undated';
    const who = row.supplier || 'unknown supplier';
    const batch = row.batch_code ? ` · ${row.batch_code}` : '';
    const truck = row.truck_plate ? ` · ${row.truck_plate}` : '';
    return `${date} · ${who}${batch}${truck}`;
}

/** How a blank row is named, before it has an identity of its own. */
export function draftLabel(edits: FieldEditMap, defaultDate: string): string {
    const date = (edits.transaction_date ?? defaultDate).trim() || 'undated';
    const who = (edits.supplier ?? '').trim() || 'no supplier';
    const batch = (edits.batch_code ?? '').trim();
    return `new row ${date} · ${who}${batch ? ` · ${batch}` : ''}`;
}

// ═══ What the server said ═══════════════════════════════════════════════════════

/**
 * The two RC IN write actions BOTH return `{ success: boolean; message?: string }` — one
 * verdict for the WHOLE batch, never one per row. `fn_bulk_update_deliveries` is
 * transactional, so a refusal genuinely means **nothing was written**, and this says so
 * rather than leaving the operator to guess which half landed.
 *
 * The action's own message is always appended, never replaced: it carries the row number
 * and the constraint name (`translateDbError` has already made the common ones readable),
 * and swallowing it would leave a sentence with no evidence behind it.
 */
export function saveFailureMessage(
    kind: 'update' | 'insert',
    count: number,
    message: string | null | undefined,
): string {
    const noun = count === 1 ? 'delivery' : 'deliveries';
    const head =
        kind === 'update'
            ? `${count} edited ${noun} could not be saved — the whole batch was rolled back, so nothing was written and every keystroke is still on screen.`
            : `${count} new ${noun} could not be added — nothing was written, and every keystroke is still on screen.`;
    const detail = (message ?? '').trim();
    return detail ? `${head}\n\n${detail}` : head;
}
