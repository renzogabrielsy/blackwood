// ─────────────────────────────────────────────────────────────────────────────────
// Electricity — the v2 grid's EDIT + SAVE model. PURE (no React, no Supabase, no
// server action).
//
// `electricity-grid-v2.tsx` is the React adapter; everything here is a plain function
// over plain data, so the three things this pass can most easily get silently wrong —
// WHAT PAYLOAD a dirty row produces, WHICH ROWS COLLIDE on the natural key, and WHAT A
// FAILURE ACTUALLY MEANS — are asserted by `scripts/verify-electricity-trucks-grid.ts`
// without a browser or a database.
//
// It is the fourth instance of the shape `app/(app)/cenapro/deliveries/grid-v2-save.ts`,
// `app/(app)/inventory/rc-in/rc-in-grid-v2-save.ts` and
// `app/(app)/cenapro/qc/qc-grid-v2-save.ts` established. Where it DIFFERS it differs
// because this table's write path is a different shape, and each difference is written
// down below.
//
// ═══ THE PAYLOAD IS A **WHOLE ROW**, AND HERE THAT IS A CHOICE ══════════════════
//
// RC IN sends a whole row because it MUST: `toDeliveryPayload` rebuilds a fixed object
// and a partial patch would clear the columns it omits. Nothing forces it here —
// `saveBulkElectricity` hands `data` straight to `supabase.update()`, which is a genuine
// PATCH and leaves an absent column alone. The whole row is sent anyway, for one reason
// that is not style:
//
//     `saveBulkElectricity` guards END ≥ START with
//         `if (data.end_kwh !== undefined && data.start_kwh !== undefined)`
//
// — so a patch carrying only `end_kwh` SKIPS the readable check and lands on the DB
// CHECK constraint instead, arriving as `chk_electricity_readings_end_kwh` in the middle
// of a batch that is already half-written (see the staging note below). Sending both
// halves of every cross-field rule keeps the action's own guard engaged. The rule is
// also checked HERE, before anything is written at all, which is the only place a
// refusal costs nothing.
//
// ═══ THE ACTION IS **NOT** TRANSACTIONAL, AND THE UI MUST NOT PRETEND IT IS ═════
//
// `saveBulkElectricity` validates every INSERT first (so an invalid insert refuses
// before any write), then writes the inserts as ONE statement, then walks the UPDATES
// **one `supabase.update()` at a time**, then the deletes. It returns at the FIRST
// refusal — and its failure shape is `{ ok: false, error }` with **no counts**. So when
// a save fails:
//
//   • everything staged BEFORE the refusal is already in the database,
//   • everything after it was never attempted,
//   • and the client cannot know which is which, because no count comes back.
//
// That is why `buildElectricitySavePlan` refuses a whole save pre-flight the moment ONE
// dirty row is illegal (nothing is written unless every dirty row builds a legal
// payload), and why `saveFailureMessage` says the partial state out loud instead of
// claiming a rollback that did not happen.
//
// ═══ THE NATURAL KEY IS `(reading_date, meter)` AND IT IS CHECKED HERE ══════════
//
// A blank row typed for a meter that already has a reading that day, or a DATE edit that
// moves a row on top of another one, is a unique-violation — which would arrive as a
// Postgres error string mid-batch. The plan therefore computes every row's FINAL key
// (edited rows use their new one, untouched rows keep theirs) and refuses a duplicate by
// name, naming both sides. It can only see the rows in the PERIOD ON SCREEN, so a
// collision with a row outside the loaded window still comes back from the database —
// that one is reported by `saveFailureMessage`, not by this.
//
// ═══ WHAT THE DATABASE ACTUALLY ENFORCES, AND WHAT IT DOES NOT ═════════════════
//
// Measured against `supabase/migrations/20260527010000_create_production_tables.sql`
// (+ `20260529070745`), because a guard nobody checked is the whole reason this file
// carries its own:
//
//   • `UNIQUE (reading_date, meter)` — REAL. Hence the pre-flight key sweep above.
//   • `start_kwh >= 0`, `end_kwh >= 0` — REAL. `parseElectricityField` refuses a negative
//     by name so it never arrives as a constraint string.
//   • `meter_multiplier > 0` — REAL, and note it is **strictly** greater. A typed 0 is
//     therefore refused BY NAME here. The live grid's `parseFloat(x) || 120` silently
//     turns a typed 0 into **120** instead — a different number from the one the operator
//     typed, stored without a word. A BLANK still falls back to 120, which is both the
//     live default and the column's own DEFAULT.
//   • **`end_kwh >= start_kwh` — NOT A CONSTRAINT AT ALL.** `translateDbError` maps a
//     name (`chk_electricity_readings_end_kwh`) that no migration ever created. The rule
//     lives ONLY in `saveBulkElectricity` — unconditionally for an insert, and for an
//     update only when BOTH halves are in the patch. That is the second reason the payload
//     is a whole row, and the reason this file checks the rule itself: with a partial patch
//     a backwards meter would be stored by a save that nothing refused.
//
// ═══ ONE MORE PLACE THIS DELIBERATELY IMPROVES ON THE LIVE GRID ════════════════
//
//   • **A typed shorthand DATE is canonicalised.** The live grid stores whatever is
//     typed (`8/21` reaches the column verbatim); here `normalizeTypedDate` turns it into
//     `2026-08-21` at commit, the same rule RC IN's v2 sheet uses, so the cell shows what
//     will be stored.
//
// And one place it deliberately NARROWS: the live grid files a new reading when
// `meter || start_kwh` is truthy, so a blank row carrying only a remark inserts a
// 0 → 0 kWh reading. Here a new reading needs a START or an END, refused BY NAME rather
// than filed as a row of zeroes.
// ─────────────────────────────────────────────────────────────────────────────────

import { normalizeTypedDate, stripNumericFormatting, trimCellValue } from '@/lib/paste-utils';
import type { Tables } from '@/types/supabase';

export type ElectricityReadingRow = Tables<'electricity_readings'>;

// ═══ Row identity ═══════════════════════════════════════════════════════════════

/**
 * A blank row at the bottom of the sheet, before it has any identity of its own.
 *
 * Prefixed with the surface it belongs to (the QC sheet's habit, not RC IN's bare
 * `draft:`): a stored reading's id is a uuid, so a mis-routed id is obvious in a log
 * line rather than plausible.
 */
export const DRAFT_PREFIX = 'elecdraft:';

let draftSeq = 0;

/**
 * Fresh draft-row ids.
 *
 * A monotonic counter, never a random string: these are React keys AND the key each
 * blank row's typing is filed under, and two colliding would merge two meter readings
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
 * Every field an operator may type into — exactly the six the live grid lets them set,
 * and nothing else. `diff` and `consumption` are arithmetic over three of these and are
 * not on this list and never can be; `diff_kwh` is a GENERATED column and
 * `consumption_kwh` is written by the sync, so neither is ever in a payload either.
 */
export const ELECTRICITY_EDIT_FIELDS = [
    'reading_date', 'meter', 'start_kwh', 'end_kwh', 'meter_multiplier', 'remarks',
] as const;
export type ElectricityField = (typeof ELECTRICITY_EDIT_FIELDS)[number];

const EDIT_SET: ReadonlySet<string> = new Set<string>(ELECTRICITY_EDIT_FIELDS);

export function isElectricityEditField(key: string): key is ElectricityField {
    return EDIT_SET.has(key);
}

/** The meters the live grid offers in its METER select. Used as a hint, never a rule. */
export const KNOWN_METERS = ['MAIN', 'BUNKHOUSE', 'PUMP'] as const;

/**
 * What a blank row starts with — `createEmptyRow()` in the live grid, verbatim.
 *
 * These are DEFAULTS, not edits: they are also what `canonicalText` answers for a draft,
 * so typing `MAIN` into a blank row's METER cell by hand is a NON-edit rather than a row
 * that can never be made clean again. The sheet says them out loud above the grid,
 * because a value nobody typed must not reach the ledger unseen.
 */
export const DRAFT_METER = 'MAIN';
export const DRAFT_MULTIPLIER = '120';

/** The multiplier a BLANK cell falls back to — the live grid's own default. */
export const DEFAULT_MULTIPLIER = 120;

export function draftSeedText(field: string, defaultDate: string): string {
    switch (field) {
        case 'reading_date': return defaultDate;
        case 'meter': return DRAFT_METER;
        case 'meter_multiplier': return DRAFT_MULTIPLIER;
        default: return '';
    }
}

// ═══ The derivations — the LIVE grid's inline formulas, over TEXT ═══════════════
//
// `electricity_readings` carries `diff_kwh` (generated) and `consumption_kwh`, but the
// live grid shows `end − start` and `diff × multiplier` computed in the client from the
// EDIT BUFFER — so a typed END updates DIFF and TTL KWH immediately. These take text for
// exactly that reason: the v2 sheet's derived lanes preview unsaved edits through the
// same two functions the stored rendering uses, so the two can never disagree.

const numOf = (text: string): number => {
    const n = Number.parseFloat(text);
    return Number.isFinite(n) ? n : 0;
};

/** END − START. Negative is possible and means the operator has more typing to do. */
export function diffKwhOf(startText: string, endText: string): number {
    return numOf(endText) - numOf(startText);
}

/** DIFF × MULT — and never negative, exactly as the live grid computes it. */
export function consumptionOf(startText: string, endText: string, multiplierText: string): number {
    const d = diffKwhOf(startText, endText);
    return d >= 0 ? d * numOf(multiplierText) : 0;
}

// ═══ Canonical cell text — ONE definition, shared by the grid and the save ══════

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

const numText = (v: number | null | undefined): string =>
    v === null || v === undefined ? '' : String(v);

/**
 * What a cell HOLDS as text.
 *
 * Three consumers, and they MUST agree or the sheet misbehaves in ways nothing on screen
 * explains: the editor's opening value, the jump keys' "is this cell filled" probe, and —
 * through `useTableEdits`' `canonicalText` — the value an edit must return to in order to
 * stop counting as unsaved. It is also what the save reads for every field the operator
 * did NOT touch, which is what makes the whole-row payload above correct.
 *
 * A read-only lane still HOLDS a value: returning '' for DIFF would make a run of
 * computed figures read as a blank gap to Ctrl+Arrow.
 */
export function storedFieldText(row: ElectricityReadingRow | null, field: string): string {
    if (!row) return '';
    switch (field) {
        case 'reading_date': return row.reading_date ?? '';
        case 'meter': return row.meter ?? '';
        case 'start_kwh': return numText(row.start_kwh);
        case 'end_kwh': return numText(row.end_kwh);
        case 'meter_multiplier': return numText(row.meter_multiplier);
        case 'remarks': return row.remarks ?? '';
        case 'diff': {
            const d = diffKwhOf(numText(row.start_kwh), numText(row.end_kwh));
            return d >= 0 ? d.toFixed(2) : '';
        }
        case 'consumption': {
            const c = consumptionOf(
                numText(row.start_kwh), numText(row.end_kwh), numText(row.meter_multiplier),
            );
            return c > 0 ? c.toFixed(2) : '';
        }
        default: return '';
    }
}

// ═══ ONE field, ONE verdict ════════════════════════════════════════════════════

/** Everything a verdict needs that is not the text itself. */
export interface ElectricityEnv {
    /** What a bare `8/21` means on THIS row. */
    contextYear: number;
}

export type FieldVerdict =
    | { ok: true; value: string | number | null }
    | { ok: false; error: string };

/**
 * Canonicalise what the operator COMMITTED, before it is written.
 *
 * Only the DATE lane has a canonical spelling, and imposing it at commit is what makes
 * the sheet show what will actually be stored: `8/21` becomes `2026-08-21` the moment you
 * leave the cell, Excel's own habit. Without it the sheet holds two spellings of one date
 * (`cleanPastedElectricityCell` already writes ISO for the same text arriving on the
 * clipboard) and a shorthand equal to the stored value could never stop counting as dirty.
 *
 * The METER lane is deliberately NOT case-folded. It is half of the natural key, and an
 * operator retyping a stored mixed-case meter name would otherwise produce an edit that
 * silently RENAMES the meter — a fabricated change nobody asked for.
 *
 * It may NOT refuse: `parseElectricityField` runs immediately afterwards on whatever this
 * returns, which is what keeps unreadable text both KEPT VERBATIM and REFUSED BY NAME.
 */
export function normalizeElectricityField(field: string, text: string, env: ElectricityEnv): string {
    if (!text.trim()) return text;
    if (field === 'reading_date') return normalizeTypedDate(text, env.contextYear);
    return text;
}

/**
 * One cell's text → the value that goes on the row, or a sentence saying why not.
 *
 * **A BLANK cell is legal here and means CLEARED** (`value: null`). The row builder
 * decides what a cleared cell becomes per field — 0 for a kWh reading, 120 for the
 * multiplier, null for a remark — and the two fields a reading cannot exist without
 * (`reading_date`, `meter`) are refused at ROW level rather than here, so clearing a cell
 * you are about to retype does not raise a persistent toast mid-typing. Same line the
 * live grid and every other v2 sheet draw.
 */
export function parseElectricityField(
    field: ElectricityField,
    raw: string,
    env: ElectricityEnv,
): FieldVerdict {
    const text = (raw ?? '').trim();

    switch (field) {
        case 'reading_date': {
            if (!text) return { ok: true, value: null };
            const iso = normalizeTypedDate(text, env.contextYear);
            if (!ISO_DATE.test(iso)) {
                return {
                    ok: false,
                    error: `the DATE cell — "${text}" is not a date I can read (try 2026-08-21, 8/21 or 8/21/26).`,
                };
            }
            return { ok: true, value: iso };
        }

        case 'meter':
            return { ok: true, value: text || null };

        case 'remarks':
            return { ok: true, value: text || null };

        case 'start_kwh':
        case 'end_kwh': {
            if (!text) return { ok: true, value: null };
            const n = Number(stripNumericFormatting(text));
            if (!Number.isFinite(n) || n < 0) {
                const lane = field === 'start_kwh' ? 'START KWH' : 'END KWH';
                return { ok: false, error: `${lane} "${text}" is not a meter reading in kWh.` };
            }
            return { ok: true, value: n };
        }

        case 'meter_multiplier': {
            if (!text) return { ok: true, value: null };
            const n = Number(stripNumericFormatting(text));
            // STRICTLY above zero — `electricity_readings_meter_multiplier_check`. A zero
            // is refused by name here rather than silently rewritten to 120 (the live
            // grid) or rejected as a constraint string half way through a batch.
            if (!Number.isFinite(n) || n <= 0) {
                return {
                    ok: false,
                    error: `MULT "${text}" is not a meter multiplier — it must be above 0 (a reading multiplied by zero is not a reading). Leave the cell blank for the usual ${DEFAULT_MULTIPLIER}.`,
                };
            }
            return { ok: true, value: n };
        }
    }
}

/**
 * A pasted cell loses whatever rendering a spreadsheet copied in with it, per column —
 * and a pasted DATE goes through the SAME normalisation a typed one does, with the same
 * context year, so `8/21` typed and `8/21` pasted can never land on two different years.
 * (The live grid uses `parseExcelDate` on the paste path and NOTHING on the typed path,
 * which is precisely how the two spellings diverge there.)
 */
export function cleanPastedElectricityCell(field: string, raw: string, env: ElectricityEnv): string {
    const text = trimCellValue(raw);
    if (!text) return text;
    if (field === 'reading_date') return normalizeTypedDate(text, env.contextYear);
    if (field === 'start_kwh' || field === 'end_kwh' || field === 'meter_multiplier') {
        return stripNumericFormatting(text);
    }
    return text;
}

// ═══ A whole row ═══════════════════════════════════════════════════════════════

/** The unsaved-text map `useTableEdits` holds, as this module reads it. */
export type FieldEditMap = Readonly<Record<string, string | undefined>>;
export type RowEditMap = Readonly<Record<string, FieldEditMap>>;

/**
 * The payload, and it is EXACTLY six keys.
 *
 * Declared as its own interface rather than as `TablesInsert<'electricity_readings'>`,
 * which would also accept `diff_kwh` (a GENERATED column the database refuses to be told
 * about) and `consumption_kwh`. It is structurally assignable to both the Insert and the
 * Update the action takes, so the door it goes through is unchanged — the narrower type
 * simply makes a generated column unreachable by construction.
 */
export interface ElectricityWrite {
    reading_date: string;
    meter: string;
    start_kwh: number;
    end_kwh: number;
    meter_multiplier: number;
    remarks: string | null;
}

export interface BuiltElectricityRow {
    /** The complete payload, or null when the row was refused. */
    row: ElectricityWrite | null;
    /** Every refusal, by name. Nothing is written unless this is empty for EVERY row. */
    errors: string[];
}

/** A cleared kWh cell saves 0 — the live grid's own coercion. */
const kwhOf = (text: string): number => {
    const n = Number.parseFloat(text);
    return Number.isFinite(n) ? n : 0;
};

/**
 * A cleared multiplier falls back to 120 — the live grid's default and the column's own.
 * A typed 0 never reaches here: `parseElectricityField` refuses it by name, because the
 * database refuses it too (`meter_multiplier > 0`).
 */
const multiplierOf = (text: string): number => {
    const n = Number.parseFloat(text);
    return Number.isFinite(n) ? n : DEFAULT_MULTIPLIER;
};

function assemble(
    pick: (field: ElectricityField) => string,
    errors: string[],
    kind: 'edited' | 'new',
): ElectricityWrite | null {
    const date = pick('reading_date');
    const meter = pick('meter');
    const start = kwhOf(pick('start_kwh'));
    const end = kwhOf(pick('end_kwh'));

    if (!date) {
        errors.push(
            kind === 'new'
                ? 'a new reading needs a date.'
                : 'a reading needs a date — the DATE cell cannot be cleared.',
        );
    }
    if (!meter) {
        errors.push(
            kind === 'new'
                ? 'a new reading needs a meter — the meter is what the kilowatt-hours are booked against.'
                : 'a reading needs a meter — the METER cell cannot be cleared.',
        );
    }
    // Checked HERE, before anything is written, because the action checks it too late:
    // by the time an UPDATE is refused server-side, every row staged ahead of it is
    // already stored (see the staging note in the header).
    if (end < start) {
        errors.push(
            `END KWH (${end}) is below START KWH (${start}) — a meter does not run backwards.`,
        );
    }

    if (errors.length > 0) return null;

    return {
        reading_date: date,
        meter,
        start_kwh: start,
        end_kwh: end,
        meter_multiplier: multiplierOf(pick('meter_multiplier')),
        remarks: pick('remarks') || null,
    };
}

/**
 * A stored reading plus its unsaved text → the COMPLETE row the server action wants.
 *
 * Every field is read as *the operator's text if they typed one, otherwise the stored
 * value* — through `storedFieldText`, the same function `canonicalText` uses, so the value
 * that stopped counting as dirty and the value that gets saved are produced by one
 * function and cannot drift.
 */
export function buildElectricityUpdate(
    base: ElectricityReadingRow,
    edits: FieldEditMap,
    env: ElectricityEnv,
): BuiltElectricityRow {
    const errors: string[] = [];
    const values: Partial<Record<ElectricityField, string | number | null>> = {};

    for (const field of ELECTRICITY_EDIT_FIELDS) {
        const raw = edits[field];
        if (raw === undefined) continue;
        const verdict = parseElectricityField(field, raw, env);
        if (verdict.ok) values[field] = verdict.value;
        else errors.push(verdict.error);
    }

    const pick = (field: ElectricityField): string => {
        if (field in values) {
            const v = values[field];
            return v === null || v === undefined ? '' : String(v);
        }
        return storedFieldText(base, field);
    };

    const row = assemble(pick, errors, 'edited');
    return { row, errors };
}

/**
 * A blank row's unsaved text → a NEW reading, or a refusal.
 *
 * The seeded DATE / METER / MULT ride in as `edits[field] ?? seed`, so a blank row the
 * operator only typed a START into still files a complete reading — which is what the
 * live grid does with its pre-filled `createEmptyRow`.
 *
 * The one narrowing over the live rule is written down in the header: a new reading needs
 * a START or an END. A blank row nobody typed anything real into is not offered here at
 * all — `useTableEdits` reports only drafts carrying a value that differs from the seed.
 */
export function buildElectricityInsert(
    edits: FieldEditMap,
    defaultDate: string,
    env: ElectricityEnv,
): BuiltElectricityRow {
    const errors: string[] = [];
    const values: Partial<Record<ElectricityField, string | number | null>> = {};

    for (const field of ELECTRICITY_EDIT_FIELDS) {
        // The operator's text if they typed one — INCLUDING an empty string, which means
        // they cleared a seeded cell and meant it — otherwise the seed.
        const typed = edits[field];
        const seed = draftSeedText(field, defaultDate);
        const raw = typed !== undefined ? typed : (seed === '' ? undefined : seed);
        if (raw === undefined) continue;
        const verdict = parseElectricityField(field, raw, env);
        if (verdict.ok) values[field] = verdict.value;
        else errors.push(verdict.error);
    }

    const pick = (field: ElectricityField): string => {
        const v = values[field];
        return v === null || v === undefined ? '' : String(v);
    };

    if (!pick('start_kwh') && !pick('end_kwh')) {
        errors.push('a new reading needs a meter reading — START KWH and END KWH are both blank.');
    }

    const row = assemble(pick, errors, 'new');
    return { row, errors };
}

// ═══ Naming a row in an error ══════════════════════════════════════════════════

/** How a stored reading is named in a refusal — enough to find it in the sheet. */
export function rowLabel(row: ElectricityReadingRow): string {
    const date = row.reading_date || 'undated';
    const meter = row.meter || 'no meter';
    return `${date} · ${meter}`;
}

/** How a blank row is named, before it has an identity of its own. */
export function draftLabel(edits: FieldEditMap, defaultDate: string): string {
    const date = (edits.reading_date ?? defaultDate).trim() || 'undated';
    const meter = (edits.meter ?? DRAFT_METER).trim() || 'no meter';
    return `new row ${date} · ${meter}`;
}

// ═══ The plan ══════════════════════════════════════════════════════════════════

/** `(reading_date, meter)` — the table's natural key, spelled once. */
export function naturalKey(date: string, meter: string): string {
    return `${date} ${meter}`;
}

export interface ElectricitySavePlan {
    updates: { id: string; data: ElectricityWrite }[];
    inserts: ElectricityWrite[];
    /** Row ids to `forget` once the updates land. */
    updatedRowIds: string[];
    /** Draft ids to retire once the inserts land. */
    insertedDraftIds: string[];
    /** Every refusal, already labelled with the row it belongs to. */
    problems: string[];
}

export interface ElectricityPlanInput {
    edits: RowEditMap;
    dirtyRecords: ReadonlySet<string>;
    dirtyDrafts: ReadonlySet<string>;
    /** The blank rows, in sheet order, so refusals read top to bottom. */
    draftIds: readonly string[];
    /** Every reading currently on screen, by id. */
    rowsById: ReadonlyMap<string, ElectricityReadingRow>;
    /** The date a blank row starts on. */
    defaultDate: string;
    env: ElectricityEnv;
}

/**
 * Everything the Save button is about to do, decided before anything is sent.
 *
 * **Nothing is written unless every dirty row builds a legal payload.** That rule is
 * doubly load-bearing here: the action is staged and non-transactional (header), so a
 * batch that posted the good rows and let the server refuse the rest would leave the
 * sheet genuinely half-saved with no way to tell which half.
 *
 * The natural-key sweep runs LAST, over the state the save would leave behind: every
 * stored row keeps its key unless this save moves it, plus one key per new row. A
 * duplicate is refused with BOTH sides named.
 */
export function buildElectricitySavePlan(input: ElectricityPlanInput): ElectricitySavePlan {
    const { edits, dirtyRecords, dirtyDrafts, draftIds, rowsById, defaultDate, env } = input;

    const plan: ElectricitySavePlan = {
        updates: [], inserts: [], updatedRowIds: [], insertedDraftIds: [], problems: [],
    };

    /**
     * key → how the row holding it is named, for the collision message.
     *
     * Answers FALSE when the key was already taken, and the caller then leaves the row out
     * of the plan — so the invariant "a row that produced a problem is never in the plan"
     * holds for a collision exactly as it does for an unreadable cell.
     */
    const claimed = new Map<string, string>();
    const claim = (key: string, who: string): boolean => {
        const other = claimed.get(key);
        if (other === undefined) {
            claimed.set(key, who);
            return true;
        }
        plan.problems.push(
            `${who}: a reading for this meter on this date already exists (${other}). One meter has one reading per day — edit that row instead.`,
        );
        return false;
    };

    // Untouched stored rows keep their key, and they are claimed FIRST so a collision
    // always reads as "the row you are moving/adding hit this one", never the reverse.
    for (const [id, row] of rowsById) {
        if (dirtyRecords.has(id)) continue;
        claimed.set(naturalKey(row.reading_date ?? '', row.meter ?? ''), rowLabel(row));
    }

    for (const id of dirtyRecords) {
        const stored = rowsById.get(id);
        // Filtered out from under the edit between the typing and the Save. Its text is
        // gone with it, so there is nothing to post and nothing to warn about.
        if (!stored) continue;
        const built = buildElectricityUpdate(stored, edits[id] ?? {}, env);
        if (built.errors.length > 0) {
            for (const e of built.errors) plan.problems.push(`${rowLabel(stored)}: ${e}`);
            continue;
        }
        if (!built.row) continue;
        if (!claim(naturalKey(built.row.reading_date, built.row.meter), rowLabel(stored))) continue;
        plan.updates.push({ id, data: built.row });
        plan.updatedRowIds.push(id);
    }

    for (const draftId of draftIds) {
        if (!dirtyDrafts.has(draftId)) continue;
        const e = edits[draftId] ?? {};
        const built = buildElectricityInsert(e, defaultDate, env);
        if (built.errors.length > 0) {
            for (const err of built.errors) plan.problems.push(`${draftLabel(e, defaultDate)}: ${err}`);
            continue;
        }
        if (!built.row) continue;
        if (!claim(naturalKey(built.row.reading_date, built.row.meter), draftLabel(e, defaultDate))) continue;
        plan.inserts.push(built.row);
        plan.insertedDraftIds.push(draftId);
    }

    return plan;
}

// ═══ What the server said ══════════════════════════════════════════════════════

/**
 * `saveBulkElectricity` answers with ONE `{ ok, error }` for the whole batch and — on
 * failure — **no counts at all**. It is also STAGED and not transactional: inserts (one
 * statement), then updates one at a time, then deletes, returning at the first refusal.
 *
 * So a failure means *some prefix of this save is already stored and the rest was never
 * attempted*, and the client genuinely cannot say where the line fell. This says exactly
 * that rather than claiming a rollback that did not happen, and the sheet reloads from
 * the database underneath it so the operator can SEE where the line fell.
 *
 * The action's own message is always appended, never replaced: `translateDbError` has
 * already made the common constraints readable, and swallowing it would leave a sentence
 * with no evidence behind it.
 */
export function saveFailureMessage(
    counts: { updates: number; inserts: number },
    message: string | null | undefined,
): string {
    const parts: string[] = [];
    if (counts.inserts > 0) parts.push(`${counts.inserts} new reading${counts.inserts === 1 ? '' : 's'}`);
    if (counts.updates > 0) parts.push(`${counts.updates} edited reading${counts.updates === 1 ? '' : 's'}`);
    const what = parts.join(' and ') || 'this save';

    const head =
        `Saving ${what} stopped at the first refusal. This save path writes in stages — new rows first, then edits one at a time — and it is NOT one transaction, so anything staged before the refusal IS already stored and everything after it was never attempted. No counts come back, so the sheet cannot say where the line fell: it has been reloaded from the database, and every keystroke is still on screen on top of it.`;

    const detail = (message ?? '').trim();
    return detail ? `${head}\n\n${detail}` : head;
}

/** The success line — one sentence, whatever the mix of new and edited rows. */
export function saveSuccessMessage(counts: { updates: number; inserts: number }): string {
    const parts: string[] = [];
    if (counts.inserts > 0) parts.push(`${counts.inserts} added`);
    if (counts.updates > 0) parts.push(`${counts.updates} updated`);
    return `Saved — ${parts.join(', ')}`;
}
