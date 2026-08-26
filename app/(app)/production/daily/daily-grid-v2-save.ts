// ─────────────────────────────────────────────────────────────────────────────────
// Production Daily — the v2 grid's EDIT + SAVE model. PURE (no React, no Supabase).
//
// `daily-grid-v2.tsx` is the React adapter; everything here is a plain function over
// plain data, so the thing this sheet can most easily get silently wrong — **WHICH
// ROW a cell's edit is actually a save to** — is asserted by
// `scripts/verify-daily-grid.ts` without a browser or a database.
//
// It is the fourth instance of the shape `app/(app)/cenapro/deliveries/grid-v2-save.ts`,
// `app/(app)/inventory/rc-in/rc-in-grid-v2-save.ts` and
// `app/(app)/cenapro/qc/qc-grid-v2-save.ts` established. Where it DIFFERS, it differs
// because this ledger's write model is a different shape, and each difference is
// written down below.
//
// ═══ THE SHEET HAS FOUR LANES, AND THEY SAVE TO THREE DIFFERENT ROWS ═════════════
//
// One rendered row is one `production_runs` entry. But a shift owns its downtime and
// its waste 1:1, and the live ledger paints them on the shift's PRIMARY run row — so
// of the eighteen typeable columns:
//
//   • **CUSTOMER / GRADE / TTL KG / REM are PER RUN.** They belong to the row the
//     caret is on and to nothing else.
//   • **DT HRS / DT MIN / DT REASON are PER SHIFT** — one `production_downtime` row
//     per `(date, batch, shift)`, shown on that shift's primary run. An edit there is
//     a save to the SHIFT, not to the run the caret happened to be on.
//   • **The eight waste streams are PER SHIFT** too — one `production_waste` row,
//     same key, same rule.
//   • **DATE / BATCH / SHIFT are the shift's IDENTITY** and are typeable only on a
//     blank row. See "identity is not editable on a stored row" below.
//
// That is why `routeDailyEdits` exists and why the verify script's first assertions
// are about it. The live grid routes the same way at the WRITE site
// (`updateShiftData` walks to the shift's primary row before setting the field); this
// module routes at the PLAN site, which is the same rule expressed where it can be
// asserted.
//
// ═══ EVERY PAYLOAD IS A WHOLE THING, NOT A PATCH — the server's rule ═════════════
//
// `saveBulkDailyLedger` (which this pass may not edit) rebuilds a fixed object per
// table from whatever it is handed:
//
//     run:      customer / grade / ttl_kg / sacks_bags / remarks   (all five, always)
//     downtime: shift_hrs / dt_hrs / dt_mins / dt_reason           (UPSERT on shift_id)
//     waste:    the eight kg columns + remarks                     (UPSERT on shift_id)
//
// So a payload built only from the cells the operator typed does not leave the rest
// alone — it blanks them. Every block below is therefore assembled as *the stored
// value unless the operator typed over it*. Same rule as RC IN's whole-row delivery
// and QC's replaced sample reading; three different mechanisms, one discipline:
// **reassemble the whole thing, always.**
//
// Three columns are carried by this rule that the sheet does not even RENDER, and
// each was measured before it was written down:
//
//   • **`production_downtime.shift_hrs`** — NOT NULL, and the action gates the whole
//     downtime write on it (`hasDowntimeData = dt.shift_hrs !== null`). The live grid
//     sends `shift_hrs: null`, so **the live ledger has never written a downtime edit
//     at all** — DT HRS / DT MIN / DT REASON are typed, saved and silently discarded.
//     Sending the sheet's displayed 8 instead would be worse than doing nothing:
//     **no stored row holds 8.** Measured 2026-08-26 — 158 rows say 9 and 72 say 12,
//     zero say 8 — so a fabricated 8 would overwrite the reported shift length on
//     every downtime row it touched. The stored value therefore rides back in
//     (`shiftHrsByShiftId`), and 8 is used only where there is no downtime row yet
//     and the sheet's own PROD HRS arithmetic already assumes it.
//   • **`production_runs.sacks_bags`** (102 rows carry one) and
//     **`production_waste.remarks`** (63 rows carry one) — columns the ledger dropped
//     from its UI in 2026-05-28 and has hard-coded to `null` in every save since. The
//     row model still carries both (`bags`, `waste_remarks`), so here they ride back
//     unchanged instead of being erased by an edit that never looked at them.
//
// ═══ IDENTITY IS NOT EDITABLE ON A STORED ROW, AND THAT IS A NARROWING ═══════════
//
// The action's UPDATE branch writes `customer / grade / ttl_kg / sacks_bags / remarks`
// and **not `shift_id`**. So a stored run cannot be moved to another shift through it:
// changing DATE / BATCH / SHIFT on a saved row upserts a NEW `production_shifts` row
// (the natural key changed), leaves the run attached to the OLD shift, and pushes the
// downtime and waste onto the new empty one. The live grid lets that be typed; this
// grid refuses it by name instead. Trading a loud refusal for a quiet orphan is the
// wrong direction, and there is no second door — writing one would be a new server
// action, which this pass may not do.
//
// The three lanes stay fully typeable on a BLANK row, where the action's INSERT
// branch does set `shift_id` from the upserted shift.
//
// ═══ `4X8` IS A GRADE THE DATABASE ALLOWS AND THE ACTION REFUSES ════════════════
//
// `production_runs_grade_check` accepts `3X50 · 6X50 · 8X50 · 2X6 · 4X8`;
// `saveBulkDailyLedger`'s `VALID_GRADES` accepts the first four and validates EVERY
// row in the payload. **19 stored runs are `4X8`** (measured 2026-08-26), so a row
// that has been on the ledger for months cannot be saved through the only door this
// grid has. It is refused HERE, by name, naming the row — because the alternative is
// a round trip that comes back with a sentence about a grade the operator did not
// type. The sheet's own `parse` refuses it at the cell for the same reason.
//
// ═══ WHAT IS **NOT** HERE, AND WHY ══════════════════════════════════════════════
//
// **No delete.** `saveBulkDailyLedger` deletes a run for a payload row marked
// `_state: 'deleted'`, and the live grid reaches that through its right-click row
// menu — which this migration has not built. A delete with no affordance to trigger
// it is dead code; a delete wired to a gesture nobody asked for is worse.
//
// **No save-time reason dialog.** `saveBulkDailyLedger` takes no comment in any form
// (see `LedgerRowPayload`), unlike RC IN's `bulkUpdateDeliveries`. A dialog collecting
// a sentence with nowhere to put it would be a lie about what was recorded.
//
// **No new server action and no SQL.** `saveBulkDailyLedger` is called exactly as
// `daily-ledger-grid.tsx` calls it, with the same payload shape.
// ─────────────────────────────────────────────────────────────────────────────────

import { normalizeTypedDate, stripNumericFormatting, trimCellValue } from '@/lib/paste-utils';

import type { LedgerRowPayload } from './actions';
import type { GridRow as LedgerRow } from './daily-ledger-grid';

// ═══ Row identity ═══════════════════════════════════════════════════════════════

/**
 * A blank row at the bottom of the sheet, before it has any identity of its own.
 *
 * Deliberately NOT the bare `draft:` the two delivery sheets use: this sheet's stored
 * rows are keyed by a `production_runs` uuid OR by a `<shiftKey>#<index>` fallback, and
 * prefixing the blank rows with the surface they belong to makes a mis-routed id
 * obvious in a log line rather than plausible.
 */
export const DRAFT_PREFIX = 'dailydraft:';

let draftSeq = 0;

/**
 * Fresh draft-row ids.
 *
 * A monotonic counter, never a random string: these are React keys AND the key each
 * blank row's typing is filed under, and two colliding would merge two runs into one.
 */
export function makeDraftIds(n: number): string[] {
    return Array.from({ length: n }, () => `${DRAFT_PREFIX}${++draftSeq}`);
}

export function isDraftKey(rowId: string): boolean {
    return rowId.startsWith(DRAFT_PREFIX);
}

// ═══ The fields, and the LANE each one saves to ═════════════════════════════════

/** The shift's identity. Typeable on a blank row only — see the header. */
export const IDENTITY_FIELDS = ['date', 'batch', 'shift_code'] as const;
/** `production_runs` — the row the caret is on. */
export const RUN_FIELDS = ['customer', 'grade', 'ttl_kg', 'run_remarks'] as const;
/** `production_downtime` — ONE row per shift. */
export const DOWNTIME_FIELDS = ['dt_hrs', 'dt_mins', 'dt_reason'] as const;
/** `production_waste` — ONE row per shift, eight streams. */
export const WASTE_FIELDS = ['rs1a', 'rs1b', 'bf', 'rs23', 'rs5', 'trml1', 'trml2', 'grit'] as const;

export type IdentityField = (typeof IDENTITY_FIELDS)[number];
export type RunField = (typeof RUN_FIELDS)[number];
export type DowntimeField = (typeof DOWNTIME_FIELDS)[number];
export type WasteField = (typeof WASTE_FIELDS)[number];
export type DailyField = IdentityField | RunField | DowntimeField | WasteField;

/** Every field an operator may type into anywhere on this sheet — all eighteen. */
export const DAILY_EDIT_FIELDS: readonly DailyField[] = [
    ...IDENTITY_FIELDS, ...RUN_FIELDS, ...DOWNTIME_FIELDS, ...WASTE_FIELDS,
];

export type DailyLane = 'identity' | 'run' | 'downtime' | 'waste';

const LANES: ReadonlyMap<string, DailyLane> = new Map<string, DailyLane>([
    ...IDENTITY_FIELDS.map((f) => [f, 'identity'] as const),
    ...RUN_FIELDS.map((f) => [f, 'run'] as const),
    ...DOWNTIME_FIELDS.map((f) => [f, 'downtime'] as const),
    ...WASTE_FIELDS.map((f) => [f, 'waste'] as const),
]);

/**
 * THE routing primitive: which THING does an edit in this column save to.
 *
 * One definition, read by the column table, both row families, the plan builder and
 * the verify script — so "a waste figure belongs to the shift" is a fact stated once
 * rather than a rule re-derived at four call sites.
 */
export function laneOf(field: string): DailyLane | null {
    return LANES.get(field) ?? null;
}

export function isDailyEditField(key: string): key is DailyField {
    return LANES.has(key);
}

/** A shift-owned lane rides on the shift's PRIMARY run row and is absent elsewhere. */
export function isShiftOwnedField(field: string): boolean {
    const lane = laneOf(field);
    return lane === 'downtime' || lane === 'waste';
}

/**
 * The lanes a SAVED row may be edited in — everything except the shift's identity.
 *
 * `saveBulkDailyLedger`'s UPDATE branch does not write `shift_id`, so a stored run
 * cannot be moved between shifts through it. See the header.
 */
export function storedRowFieldIsEditable(field: string): boolean {
    const lane = laneOf(field);
    return lane !== null && lane !== 'identity';
}

// ═══ The closed lists, which are the ACTION's and not the database's ════════════

/** `production_shifts_shift_check`, and `saveBulkDailyLedger`'s own `VALID_SHIFTS`. */
export const SHIFT_CODES = ['M', 'E', 'N'] as const;

/**
 * The grades `saveBulkDailyLedger` accepts — its `VALID_GRADES`, verbatim.
 *
 * NOT the database's list, which also allows `4X8`. The action is the door this grid
 * has, so its list is the one an operator is held to. See the header.
 */
export const SAVEABLE_GRADES = ['3X50', '6X50', '8X50', '2X6'] as const;

/** Allowed by `production_runs_grade_check`, refused by the action. 19 rows carry it. */
export const DB_ONLY_GRADES = ['4X8'] as const;

const SHIFT_SET: ReadonlySet<string> = new Set<string>(SHIFT_CODES);
const GRADE_SET: ReadonlySet<string> = new Set<string>(SAVEABLE_GRADES);
const DB_ONLY_GRADE_SET: ReadonlySet<string> = new Set<string>(DB_ONLY_GRADES);

/** The default shift length the sheet's own PROD HRS arithmetic assumes. */
export const ASSUMED_SHIFT_HRS = 8;

/** The customer a blank CUSTOMER cell becomes — `saveBulkDailyLedger`'s own fallback. */
export const DEFAULT_CUSTOMER = 'CEBU';

// ═══ ONE field, ONE verdict ═════════════════════════════════════════════════════

/** Everything a verdict needs that is not the text itself. */
export interface DailyFieldEnv {
    /** What a bare `8/21` means on THIS row. */
    contextYear: number;
}

export type DailyFieldVerdict = { ok: true } | { ok: false; error: string };

const OK: DailyFieldVerdict = { ok: true };

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

const LABELS: Readonly<Record<DailyField, string>> = {
    date: 'DATE', batch: 'BATCH', shift_code: 'SHIFT',
    customer: 'CUSTOMER', grade: 'GRADE', ttl_kg: 'TTL KG', run_remarks: 'REM',
    dt_hrs: 'DT HRS', dt_mins: 'DT MIN', dt_reason: 'DT REASON',
    rs1a: 'RS1A', rs1b: 'RS1B', bf: 'BF', rs23: 'RS2/3',
    rs5: 'RS5', trml1: 'TRML1', trml2: 'TRML2', grit: 'GRIT',
};

/** The column's own name, so a refusal points at a header the operator can see. */
export function fieldLabel(field: DailyField): string {
    return LABELS[field];
}

/** A number this sheet will accept, or a sentence saying why not. */
function readNumber(
    field: DailyField,
    text: string,
    bounds: { min: number; maxExclusive?: number; noun: string },
): { ok: true; value: number } | { ok: false; error: string } {
    const n = Number(stripNumericFormatting(text));
    if (!Number.isFinite(n)) {
        return { ok: false, error: `${LABELS[field]} "${text}" is not a number.` };
    }
    if (n < bounds.min) {
        return { ok: false, error: `${LABELS[field]} "${text}" is below ${bounds.min} — ${bounds.noun}.` };
    }
    if (bounds.maxExclusive !== undefined && n >= bounds.maxExclusive) {
        return { ok: false, error: `${LABELS[field]} "${text}" must be less than ${bounds.maxExclusive} — ${bounds.noun}.` };
    }
    return { ok: true, value: n };
}

/**
 * One cell's text → a verdict, and it is the ONLY one.
 *
 * Every `ColumnSpec.parse` calls this, and so does every payload builder below, so a
 * value typed and the same value refused at save can never disagree — there is only
 * one of them. The bounds are the DATABASE's CHECK constraints and the ACTION's own
 * validation, asked here so a refusal lands on the cell instead of arriving as a
 * whole-batch rejection after Save.
 *
 * **A BLANK cell is legal here, in every lane.** Clearing a cell you are about to
 * retype must not raise a refusal that stays on screen until it is dismissed. What a
 * blank MEANS is decided at ROW level, where it can actually be judged:
 * `buildDailySavePlan` refuses a run whose DATE / BATCH / SHIFT / GRADE was emptied,
 * and a blank waste stream simply means zero kilograms of it.
 */
export function parseDailyField(field: DailyField, raw: string, env: DailyFieldEnv): DailyFieldVerdict {
    const text = (raw ?? '').trim();
    if (!text) return OK;

    switch (field) {
        case 'date': {
            const iso = normalizeTypedDate(text, env.contextYear);
            if (!ISO_DATE.test(iso)) {
                return { ok: false, error: `DATE "${text}" is not a date I can read (try 2026-08-21, 8/21 or 8/21/26).` };
            }
            return OK;
        }

        case 'batch':
        case 'run_remarks':
        case 'dt_reason':
        case 'customer':
            return OK;

        case 'shift_code': {
            const up = text.toUpperCase();
            if (!SHIFT_SET.has(up)) {
                return { ok: false, error: `SHIFT "${text}" is not one of: ${SHIFT_CODES.join(', ')} (morning, evening, night).` };
            }
            return OK;
        }

        case 'grade': {
            const up = text.toUpperCase();
            if (GRADE_SET.has(up)) return OK;
            if (DB_ONLY_GRADE_SET.has(up)) {
                // Named precisely, because the operator is not wrong about the grade —
                // the ledger genuinely holds 19 runs of it. The door is what refuses.
                return {
                    ok: false,
                    error: `GRADE "${up}" exists in the database but this ledger's save refuses it — it accepts only ${SAVEABLE_GRADES.join(', ')}. A ${up} run has to be edited from somewhere else.`,
                };
            }
            return { ok: false, error: `GRADE "${text}" is not one of: ${SAVEABLE_GRADES.join(', ')}.` };
        }

        case 'ttl_kg': {
            const v = readNumber(field, text, { min: 0, noun: 'output cannot be negative' });
            return v.ok ? OK : v;
        }

        case 'dt_hrs': {
            const v = readNumber(field, text, { min: 0, noun: 'downtime cannot be negative' });
            return v.ok ? OK : v;
        }

        case 'dt_mins': {
            // `production_downtime_dt_mins_check`: 0 <= dt_mins < 60. The whole hours
            // go in DT HRS, which is why 60 is not a legal number of minutes.
            const v = readNumber(field, text, { min: 0, maxExclusive: 60, noun: 'whole hours belong in DT HRS' });
            return v.ok ? OK : v;
        }

        default: {
            // A waste stream. Every one carries `CHECK (x_kg >= 0)`.
            const v = readNumber(field, text, { min: 0, noun: 'a waste stream cannot be negative' });
            return v.ok ? OK : v;
        }
    }
}

/**
 * Canonicalise what the operator COMMITTED, before it is written.
 *
 * Applied once, inside the module's single writer, so what the operator sees from
 * that moment on is what will be sent. Three lanes have a canonical spelling the
 * server would impose anyway:
 *
 *   • **DATE** — `8/21` becomes `2026-08-21` on the way out of the cell, Excel's own
 *     habit and what `parseExcelDate` already produces for the same text arriving on
 *     the clipboard. Without it the sheet holds two spellings of one date and a
 *     shorthand equal to the stored value could never stop counting as dirty.
 *   • **BATCH / SHIFT / CUSTOMER / GRADE** — uppercased, because that is how every
 *     one of them is stored and how the live grid's typeahead offers them. A cell
 *     that shows one spelling and stores another is a lie.
 *
 * It may NOT refuse: `parseDailyField` runs immediately afterwards on whatever this
 * returns, which is what keeps unreadable text both KEPT VERBATIM and REFUSED BY NAME.
 */
export function normalizeDailyField(field: DailyField, text: string, env: DailyFieldEnv): string {
    if (!text.trim()) return text;
    if (field === 'date') {
        const iso = normalizeTypedDate(text, env.contextYear);
        return ISO_DATE.test(iso) ? iso : text;
    }
    if (field === 'batch' || field === 'shift_code' || field === 'customer' || field === 'grade') {
        return text.trim().toUpperCase();
    }
    return text;
}

/**
 * A pasted cell loses whatever rendering a spreadsheet copied in with it — and a
 * pasted DATE goes through the SAME normalisation a typed one does, with the same
 * context year, so `8/21` typed and `8/21` pasted can never land on two different
 * years.
 */
export function cleanPastedDailyCell(field: DailyField, raw: string, env: DailyFieldEnv): string {
    const text = trimCellValue(raw);
    if (!text) return text;
    const lane = laneOf(field);
    if (field === 'ttl_kg' || field === 'dt_hrs' || field === 'dt_mins' || lane === 'waste') {
        return stripNumericFormatting(text);
    }
    return normalizeDailyField(field, text, env);
}

// ═══ Stored text — the merge base, and what a cell compares itself against ══════

/** The unsaved-text map `useTableEdits` holds, as this module reads it. */
export type RowEditMap = Readonly<Record<string, Readonly<Record<string, string | undefined>>>>;
export type FieldEditMap = Readonly<Record<string, string | undefined>>;

/**
 * What a stored cell HOLDS, as text.
 *
 * Three consumers, and they MUST agree: the editor's opening value, the value an edit
 * must return to in order to stop counting as unsaved (`canonicalText`), and the value
 * every payload below reads for a field the operator did NOT touch. One function, so
 * "unchanged" and "what gets saved" cannot drift.
 *
 * The row model already holds every one of these as a string (`buildGridRows` is the
 * ONE definition), which is why this is a lookup rather than a formatter.
 */
export function savedFieldText(row: LedgerRow | null, field: string): string {
    if (!row) return '';
    const v = (row as unknown as Record<string, unknown>)[field];
    return v === null || v === undefined ? '' : String(v);
}

/** The values a blank row starts with, so typing one of them by hand is a NON-edit. */
export interface DraftDefaults {
    /** `createEmptyRow`'s own seed: today. */
    date: string;
    /** The period's batch when every loaded row agrees on one, else blank. */
    batch: string;
    /** `createEmptyRow`'s own seed: `M`. */
    shift: string;
    /** `createEmptyRow`'s own seed: `CEBU`. */
    customer: string;
}

/**
 * What a BLANK row's cell holds before anybody types in it.
 *
 * The live grid's `createEmptyRow` seeds four fields; a blank row here carries the
 * same four as CANONICAL text rather than as pre-filled edits, which is what makes
 * typing the default by hand a non-edit instead of a row that can never be made clean
 * again. The strip above the sheet says all four out loud, because a value nobody
 * typed must not reach the ledger unseen.
 */
export function draftFieldText(field: string, defaults: DraftDefaults): string {
    switch (field) {
        case 'date': return defaults.date;
        case 'batch': return defaults.batch;
        case 'shift_code': return defaults.shift;
        case 'customer': return defaults.customer;
        default: return '';
    }
}

/** A draft cell's current text: what was typed, else the seeded default. */
export function draftText(edits: FieldEditMap, field: string, defaults: DraftDefaults): string {
    const raw = edits[field];
    return (raw === undefined ? draftFieldText(field, defaults) : raw).trim();
}

// ═══ The shift key ══════════════════════════════════════════════════════════════

/**
 * `date|batch|shift` — the live grid's own `makeShiftKey`, and the natural key
 * `saveBulkDailyLedger` groups by. Restated rather than imported because the live
 * grid does not export it, and asserted equal to the row model's `_shiftKey` in
 * `scripts/verify-daily-grid.ts` so the two cannot drift.
 */
export function shiftKeyOf(date: string, batch: string, shift: string): string {
    return `${date}|${batch}|${shift}`;
}

/** A blank row's shift key, from whatever identity it currently carries. */
export function draftShiftKey(edits: FieldEditMap, defaults: DraftDefaults): string {
    return shiftKeyOf(
        draftText(edits, 'date', defaults),
        draftText(edits, 'batch', defaults),
        draftText(edits, 'shift_code', defaults),
    );
}

// ═══ Routing — WHICH thing does this row's edits save to ════════════════════════

/** Run-lane (and, on a blank row, identity-lane) text, filed against ONE row. */
export interface RoutedRunEdits {
    rowId: string;
    /** The stored row, or null on a blank row. */
    row: LedgerRow | null;
    isDraft: boolean;
    shiftKey: string;
    fields: Partial<Record<IdentityField | RunField, string>>;
}

/** Shift-lane text, filed against ONE shift — whatever row it was typed on. */
export interface RoutedShiftEdits {
    shiftKey: string;
    fields: Partial<Record<DowntimeField | WasteField, string>>;
    /** Every row whose typing landed in this bucket, for `edits.forget`. */
    rowIds: string[];
    /** Two rows of one shift disagreeing about one shift field. Never guessed. */
    conflicts: string[];
}

export interface RoutedDailyEdits {
    runs: Map<string, RoutedRunEdits>;
    shifts: Map<string, RoutedShiftEdits>;
    /** A field that reached a row it can never be saved from. Named, never dropped. */
    problems: string[];
}

export interface RouteDailyInput {
    edits: RowEditMap;
    dirtyRecords: Iterable<string>;
    dirtyDrafts: ReadonlySet<string>;
    /** In sheet order, so refusals read down the page. */
    draftIds: readonly string[];
    /** The stored rows currently on screen, by the id the grid gave each one. */
    rowsById: ReadonlyMap<string, LedgerRow>;
    defaults: DraftDefaults;
}

/**
 * Split every dirty cell by WHERE it is written.
 *
 * This is the function the four-lane model lives in, and the reason it is separate
 * from the plan builder is that it is the part with no payload shape at all: given
 * rows and text, which THING does each cell belong to. `scripts/verify-daily-grid.ts`
 * asserts both directions — a waste figure typed on a primary run row patches the
 * SHIFT and not the run, and a TTL KG edit patches only its own run and no sibling.
 *
 * A shift-lane edit is filed under the row's `_shiftKey` **whatever row it arrived
 * on**. The row families already make it structurally impossible for one to arrive on
 * a SECONDARY run (`occupies()` returns `null` for every downtime and waste column
 * there, so there is no cell, no coordinate and no paste target), but routing by the
 * shift rather than by the row means that guarantee is not the only thing standing
 * between a waste figure and the wrong shift.
 */
export function routeDailyEdits(input: RouteDailyInput): RoutedDailyEdits {
    const { edits, dirtyRecords, dirtyDrafts, draftIds, rowsById, defaults } = input;

    const runs = new Map<string, RoutedRunEdits>();
    const shifts = new Map<string, RoutedShiftEdits>();
    const problems: string[] = [];

    const shiftBucket = (key: string): RoutedShiftEdits => {
        const found = shifts.get(key);
        if (found) return found;
        const made: RoutedShiftEdits = { shiftKey: key, fields: {}, rowIds: [], conflicts: [] };
        shifts.set(key, made);
        return made;
    };

    const fileShiftField = (
        key: string,
        rowId: string,
        label: string,
        field: DowntimeField | WasteField,
        raw: string,
    ) => {
        const bucket = shiftBucket(key);
        const existing = bucket.fields[field];
        if (existing !== undefined && existing.trim() !== raw.trim()) {
            // A shift has ONE downtime row and ONE waste row, so there is no answer a
            // machine may pick between two rows that disagree.
            bucket.conflicts.push(
                `${label}: two rows of the shift ${key} give ${LABELS[field]} as "${existing.trim()}" and "${raw.trim()}". Downtime and waste belong to the whole shift — make them match or leave the figure on one row.`,
            );
            return;
        }
        bucket.fields[field] = raw;
        if (!bucket.rowIds.includes(rowId)) bucket.rowIds.push(rowId);
    };

    // ── Stored rows ──────────────────────────────────────────────────────────────
    for (const rowId of dirtyRecords) {
        const row = rowsById.get(rowId);
        // Filtered or scrolled out from under the edit between the typing and the
        // Save. Its text went with it, so there is nothing to post and nothing to
        // warn about.
        if (!row) continue;
        const fields = edits[rowId];
        if (!fields) continue;

        for (const [field, raw] of Object.entries(fields)) {
            if (raw === undefined) continue;
            const lane = laneOf(field);
            if (lane === null) continue;

            if (lane === 'identity') {
                // Reference-only on a stored run — there is no write path that moves
                // one between shifts. Named rather than silently dropped: a cell that
                // accepted typing and then wrote nothing is the worst of the three
                // possible behaviours.
                problems.push(
                    `${rowLabel(row)}: ${LABELS[field as IdentityField]} cannot be changed on a saved row — this ledger's save cannot move a run to another shift, and writing it would leave the run where it is and create an empty shift beside it.`,
                );
                continue;
            }

            if (lane === 'run') {
                const entry = runs.get(rowId) ?? {
                    rowId, row, isDraft: false, shiftKey: row._shiftKey, fields: {},
                };
                entry.fields[field as RunField] = raw;
                runs.set(rowId, entry);
                continue;
            }

            fileShiftField(row._shiftKey, rowId, rowLabel(row), field as DowntimeField | WasteField, raw);
        }
    }

    // ── Blank rows ───────────────────────────────────────────────────────────────
    // Walked in SHEET order rather than in the dirty set's iteration order, so two
    // drafts that disagree are reported top-down.
    for (const draftId of draftIds) {
        if (!dirtyDrafts.has(draftId)) continue;
        const fields = edits[draftId];
        if (!fields) continue;

        const key = draftShiftKey(fields, defaults);
        const entry: RoutedRunEdits = {
            rowId: draftId, row: null, isDraft: true, shiftKey: key, fields: {},
        };

        for (const [field, raw] of Object.entries(fields)) {
            if (raw === undefined) continue;
            const lane = laneOf(field);
            if (lane === null) continue;
            if (lane === 'identity' || lane === 'run') {
                entry.fields[field as IdentityField | RunField] = raw;
                continue;
            }
            fileShiftField(key, draftId, draftRowLabel(fields, defaults), field as DowntimeField | WasteField, raw);
        }

        runs.set(draftId, entry);
    }

    return { runs, shifts, problems };
}

// ═══ The blocks ═════════════════════════════════════════════════════════════════

type RunBlock = LedgerRowPayload['run'];
type DowntimeBlock = NonNullable<LedgerRowPayload['downtime']>;
type WasteBlock = NonNullable<LedgerRowPayload['waste']>;

function numberOrNull(text: string): number | null {
    const t = text.trim();
    if (!t) return null;
    const n = Number(stripNumericFormatting(t));
    return Number.isFinite(n) ? n : null;
}

/**
 * The RUN a save should send: every one of the five columns the action writes.
 *
 * `sacks_bags` rides back from the row model rather than being nulled. The live grid
 * hard-codes `null` there, so every one of its saves erases the bag count of every row
 * it posts — 102 stored runs carry one. This grid does not render the column and
 * therefore has no business changing it.
 */
export function buildRunBlock(
    base: LedgerRow | null,
    fields: Partial<Record<RunField, string>>,
    defaults: DraftDefaults,
): { block: RunBlock; changed: boolean } {
    const pick = (field: RunField): string => {
        const typed = fields[field];
        if (typed !== undefined) return typed.trim();
        return base ? savedFieldText(base, field).trim() : draftFieldText(field, defaults);
    };

    const customer = pick('customer') || DEFAULT_CUSTOMER;
    const grade = pick('grade');
    const ttlText = pick('ttl_kg');
    const remarks = pick('run_remarks');

    const block: RunBlock = {
        customer,
        grade,
        ttl_kg: numberOrNull(ttlText),
        // Not rendered by this sheet, so never changed by it.
        sacks_bags: base ? numberOrNull(savedFieldText(base, 'bags')) : null,
        remarks: remarks || null,
    };

    if (!base) return { block, changed: true };

    const changed =
        customer !== (savedFieldText(base, 'customer').trim() || DEFAULT_CUSTOMER) ||
        grade !== savedFieldText(base, 'grade').trim() ||
        (block.ttl_kg ?? null) !== numberOrNull(savedFieldText(base, 'ttl_kg')) ||
        (block.remarks ?? '') !== savedFieldText(base, 'run_remarks').trim();

    return { block, changed };
}

/**
 * The DOWNTIME a save should send: all four columns, merged over what is stored.
 *
 * **`shift_hrs` is the load-bearing one.** It is NOT NULL, the action gates the entire
 * downtime write on it being non-null, and the live grid always sends `null` — which
 * is why the live ledger has never once written a downtime edit. It is also the one
 * column here the sheet does not display, so it can only ride back from the stored row:
 * measured 2026-08-26, every stored value is 9 or 12 and **none is 8**, so the sheet's
 * displayed 8-hour assumption is used ONLY where there is no downtime row yet.
 */
export function buildDowntimeBlock(
    base: LedgerRow | null,
    fields: Partial<Record<DowntimeField, string>>,
    storedShiftHrs: number | null,
): { block: DowntimeBlock; changed: boolean; dtTtl: number; shiftHrs: number } {
    const pick = (field: DowntimeField): string => {
        const typed = fields[field];
        if (typed !== undefined) return typed.trim();
        return base ? savedFieldText(base, field).trim() : '';
    };

    const dtHrsText = pick('dt_hrs');
    const dtMinsText = pick('dt_mins');
    const reason = pick('dt_reason');

    const shiftHrs = storedShiftHrs ?? ASSUMED_SHIFT_HRS;
    const dtHrs = numberOrNull(dtHrsText) ?? 0;
    const dtMins = numberOrNull(dtMinsText) ?? 0;
    // The sheet's own DT TTL, in the one place the save can refuse it: the action
    // rejects a downtime longer than the shift, and so does the operator's arithmetic.
    const dtTtl = dtHrs + dtMins / 60;

    const block: DowntimeBlock = {
        shift_hrs: shiftHrs,
        dt_hrs: dtHrs,
        dt_mins: dtMins,
        dt_reason: reason || null,
    };

    if (!base) return { block, changed: true, dtTtl, shiftHrs };

    const changed =
        dtHrs !== (numberOrNull(savedFieldText(base, 'dt_hrs')) ?? 0) ||
        dtMins !== (numberOrNull(savedFieldText(base, 'dt_mins')) ?? 0) ||
        (block.dt_reason ?? '') !== savedFieldText(base, 'dt_reason').trim();

    return { block, changed, dtTtl, shiftHrs };
}

/**
 * The WASTE a save should send: all eight streams plus the remark, merged over what
 * is stored.
 *
 * The UPSERT replaces the row, so a partial payload would zero the seven streams the
 * operator did not type into — and `remarks`, which the live grid hard-codes to `null`
 * on every save, would erase the 63 stored waste remarks it has never displayed.
 */
export function buildWasteBlock(
    base: LedgerRow | null,
    fields: Partial<Record<WasteField, string>>,
): { block: WasteBlock; changed: boolean } {
    let changed = false;

    /** One stream: the typed figure if there is one, else exactly what is stored. */
    const stream = (field: WasteField): number => {
        const stored = base ? (numberOrNull(savedFieldText(base, field)) ?? 0) : 0;
        const typed = fields[field];
        const value = typed === undefined ? stored : (numberOrNull(typed) ?? 0);
        if (value !== stored) changed = true;
        return value;
    };

    const block: WasteBlock = {
        rs1a_kg: stream('rs1a'),
        rs1b_kg: stream('rs1b'),
        bf_kg: stream('bf'),
        rs23_kg: stream('rs23'),
        rs5_kg: stream('rs5'),
        trml1_kg: stream('trml1'),
        trml2_kg: stream('trml2'),
        grit_kg: stream('grit'),
        remarks: base ? (savedFieldText(base, 'waste_remarks').trim() || null) : null,
    };

    return { block, changed: base ? changed : true };
}

// ═══ The plan ═══════════════════════════════════════════════════════════════════

export interface BuildDailySaveInput {
    edits: RowEditMap;
    dirtyRecords: Iterable<string>;
    dirtyDrafts: ReadonlySet<string>;
    /** In sheet order, so refusals read down the page. */
    draftIds: readonly string[];
    /** Every stored row on screen, by grid row id. */
    rowsById: ReadonlyMap<string, LedgerRow>;
    /** Every stored row, in sheet order — how a shift's PRIMARY run is found. */
    rows: readonly LedgerRow[];
    /**
     * `production_downtime.shift_hrs` by `shift_id`, straight off the fetched rows.
     * The one column this sheet writes and never shows — see `buildDowntimeBlock`.
     */
    shiftHrsByShiftId: ReadonlyMap<string, number>;
    defaults: DraftDefaults;
    env: DailyFieldEnv;
}

export interface DailySavePlan {
    /** Exactly what `saveBulkDailyLedger` is called with. */
    payload: LedgerRowPayload[];
    /** Stored rows whose typing is settled once the save returns ok. */
    savedRowIds: string[];
    /** Blank rows that became runs. */
    savedDraftIds: string[];
    counts: { editedRuns: number; editedShifts: number; newRuns: number };
    /** Every refusal, by name. Nothing is written unless this is empty. */
    problems: string[];
}

/**
 * Every dirty row → one `saveBulkDailyLedger` payload, or a list of refusals.
 *
 * ONE RULE ABOVE EVERYTHING: **nothing is written unless every dirty row builds a
 * legal payload.** A batch that posted the good rows and reported the rest would leave
 * the sheet half-saved with the refusals still on screen, and the operator with no way
 * to tell which half landed.
 *
 * **Only the rows that need writing are sent.** The live grid posts every row on the
 * sheet on every save, which is why one stored `4X8` run makes the whole month
 * unsaveable there. A row this plan does not mention is not touched by the action at
 * all — the one exception is a shift whose downtime or waste was edited, whose PRIMARY
 * run has to ride along to carry the block (the action reads it off a payload row),
 * and which is therefore re-posted with its own stored values.
 */
export function buildDailySavePlan(input: BuildDailySaveInput): DailySavePlan {
    const { edits, dirtyRecords, dirtyDrafts, draftIds, rowsById, rows, shiftHrsByShiftId, defaults, env } = input;

    const routed = routeDailyEdits({ edits, dirtyRecords, dirtyDrafts, draftIds, rowsById, defaults });
    const problems: string[] = [...routed.problems];
    for (const bucket of routed.shifts.values()) problems.push(...bucket.conflicts);

    // ── The shift a stored row belongs to, and which of its rows is PRIMARY ──────
    const primaryByShift = new Map<string, LedgerRow>();
    for (const row of rows) {
        if (row._isPrimary && !primaryByShift.has(row._shiftKey)) primaryByShift.set(row._shiftKey, row);
    }

    /**
     * The grid's id for a stored row, inverted from the map the grid already built.
     *
     * The v2 grid keys a row by its `run_id` when it has one and by
     * `<shiftKey>#<index>` when it does not; deriving that here would be a second
     * definition of row identity, so the answer is looked up rather than rebuilt.
     */
    const idByRow = new Map<LedgerRow, string>();
    for (const [id, row] of rowsById) if (!idByRow.has(row)) idByRow.set(row, id);

    // ── Every cell's verdict, once, before anything is assembled ────────────────
    const refuseField = (label: string, field: DailyField, raw: string) => {
        const verdict = parseDailyField(field, raw, env);
        if (!verdict.ok) problems.push(`${label}: ${verdict.error}`);
        return verdict.ok;
    };

    for (const entry of routed.runs.values()) {
        const label = entry.isDraft
            ? draftRowLabel(edits[entry.rowId] ?? {}, defaults)
            : rowLabel(entry.row!);
        for (const [field, raw] of Object.entries(entry.fields)) {
            if (raw === undefined) continue;
            refuseField(label, field as DailyField, raw);
        }
    }
    for (const bucket of routed.shifts.values()) {
        const label = `shift ${bucket.shiftKey}`;
        for (const [field, raw] of Object.entries(bucket.fields)) {
            if (raw === undefined) continue;
            refuseField(label, field as DailyField, raw);
        }
    }

    // ── Which rows go in the payload, and which one carries each shift's block ──
    interface Pending {
        rowId: string;
        row: LedgerRow | null;
        isDraft: boolean;
        shiftKey: string;
        runFields: Partial<Record<RunField, string>>;
        identity: { date: string; batch: string; shift: string };
        carriesShiftBlock: boolean;
    }

    const pending = new Map<string, Pending>();

    const identityOfDraft = (e: FieldEditMap) => ({
        date: draftText(e, 'date', defaults),
        batch: draftText(e, 'batch', defaults).toUpperCase(),
        shift: draftText(e, 'shift_code', defaults).toUpperCase(),
    });

    for (const entry of routed.runs.values()) {
        const e = edits[entry.rowId] ?? {};
        const identity = entry.isDraft
            ? identityOfDraft(e)
            : {
                date: savedFieldText(entry.row, 'date'),
                batch: savedFieldText(entry.row, 'batch'),
                shift: savedFieldText(entry.row, 'shift_code'),
            };
        const runFields: Partial<Record<RunField, string>> = {};
        for (const field of RUN_FIELDS) {
            const raw = entry.fields[field];
            if (raw !== undefined) runFields[field] = raw;
        }
        pending.set(entry.rowId, {
            rowId: entry.rowId,
            row: entry.row,
            isDraft: entry.isDraft,
            shiftKey: entry.isDraft ? shiftKeyOf(identity.date, identity.batch, identity.shift) : entry.shiftKey,
            runFields,
            identity,
            carriesShiftBlock: false,
        });
    }

    // A shift whose downtime or waste was edited needs ONE row in the payload to
    // carry the block. The stored PRIMARY run is that row when there is one — the
    // action reads the block off whichever payload row carries it and writes it
    // against the shift, so any row of the shift would do, and the primary is the row
    // the sheet paints it on.
    const shiftBlockCarrier = new Map<string, string>();
    for (const shiftKey of routed.shifts.keys()) {
        const primary = primaryByShift.get(shiftKey);
        if (primary) {
            const id = idByRow.get(primary) ?? null;
            if (id === null) {
                problems.push(
                    `shift ${shiftKey}: the row that carries this shift's downtime and waste is not on screen, so nothing was written.`,
                );
                continue;
            }
            if (!pending.has(id)) {
                pending.set(id, {
                    rowId: id,
                    row: primary,
                    isDraft: false,
                    shiftKey,
                    runFields: {},
                    identity: {
                        date: savedFieldText(primary, 'date'),
                        batch: savedFieldText(primary, 'batch'),
                        shift: savedFieldText(primary, 'shift_code'),
                    },
                    carriesShiftBlock: true,
                });
            } else {
                pending.get(id)!.carriesShiftBlock = true;
            }
            shiftBlockCarrier.set(shiftKey, id);
            continue;
        }

        // A brand-new shift: the first blank row that names it carries the block.
        const draftCarrier = draftIds.find((id) => pending.get(id)?.shiftKey === shiftKey);
        if (draftCarrier) {
            pending.get(draftCarrier)!.carriesShiftBlock = true;
            shiftBlockCarrier.set(shiftKey, draftCarrier);
            continue;
        }

        problems.push(
            `shift ${shiftKey}: downtime or waste was typed for a shift with no run row on this sheet. Downtime and waste are saved through a run, so type the run first.`,
        );
    }

    // ── Assemble, validating exactly what the action validates ─────────────────
    const payload: LedgerRowPayload[] = [];
    const savedRowIds: string[] = [];
    const savedDraftIds: string[] = [];
    let editedRuns = 0;
    let newRuns = 0;

    for (const item of pending.values()) {
        const e = edits[item.rowId] ?? {};
        const label = item.isDraft ? draftRowLabel(e, defaults) : rowLabel(item.row!);

        // A saved run that cannot go through this door at all. Checked before the
        // block is built so the refusal names the grade rather than a constraint.
        if (!item.isDraft) {
            const storedGrade = savedFieldText(item.row, 'grade').trim().toUpperCase();
            const typedGrade = item.runFields.grade?.trim().toUpperCase();
            const effective = typedGrade ?? storedGrade;
            if (!item.row!._ids.run_id) {
                problems.push(
                    `${label}: this shift has no run row in the database, so there is nothing here to edit yet. Add the run from a blank row at the bottom.`,
                );
                continue;
            }
            if (effective && !GRADE_SET.has(effective)) {
                problems.push(
                    `${label}: this row's GRADE is ${effective}, which this ledger's save refuses (it accepts only ${SAVEABLE_GRADES.join(', ')}) — so no cell on it can be saved from here.`,
                );
                continue;
            }
        }

        const { block: run, changed: runChanged } = buildRunBlock(item.row, item.runFields, defaults);

        // Identity, the action's own three refusals.
        if (!item.identity.date) { problems.push(`${label}: a run needs a DATE.`); continue; }
        if (!item.identity.batch) { problems.push(`${label}: a run needs a BATCH.`); continue; }
        if (!SHIFT_SET.has(item.identity.shift)) {
            problems.push(`${label}: SHIFT must be one of ${SHIFT_CODES.join(', ')} — this row says "${item.identity.shift || 'nothing'}".`);
            continue;
        }
        if (!GRADE_SET.has(run.grade.toUpperCase())) {
            problems.push(`${label}: GRADE must be one of ${SAVEABLE_GRADES.join(', ')} — this row says "${run.grade || 'nothing'}".`);
            continue;
        }
        if (item.isDraft && run.ttl_kg === null) {
            // The action would write 0. A new run with no output is a real thing and
            // has to be SAID, not defaulted into existence by a row nobody finished.
            problems.push(`${label}: a new run needs a TTL KG — type 0 if that grade genuinely produced nothing.`);
            continue;
        }
        if (run.ttl_kg !== null && run.ttl_kg < 0) {
            problems.push(`${label}: TTL KG cannot be negative.`);
            continue;
        }

        run.grade = run.grade.toUpperCase();
        run.customer = run.customer.toUpperCase();

        // ── The shift's block, on the carrier row only ──────────────────────────
        let downtime: LedgerRowPayload['downtime'] = null;
        let waste: LedgerRowPayload['waste'] = null;
        let shiftChanged = false;

        if (item.carriesShiftBlock) {
            const bucket = routed.shifts.get(item.shiftKey);
            const dtFields: Partial<Record<DowntimeField, string>> = {};
            const wasteFields: Partial<Record<WasteField, string>> = {};
            for (const field of DOWNTIME_FIELDS) {
                const raw = bucket?.fields[field];
                if (raw !== undefined) dtFields[field] = raw;
            }
            for (const field of WASTE_FIELDS) {
                const raw = bucket?.fields[field];
                if (raw !== undefined) wasteFields[field] = raw;
            }

            const shiftId = item.row?._ids.shift_id;
            const storedShiftHrs = shiftId ? (shiftHrsByShiftId.get(shiftId) ?? null) : null;

            if (Object.keys(dtFields).length > 0) {
                const built = buildDowntimeBlock(item.row, dtFields, storedShiftHrs);
                if (built.dtTtl > built.shiftHrs) {
                    problems.push(
                        `${label}: the downtime totals ${built.dtTtl.toFixed(2)} h, which is more than the shift's ${built.shiftHrs} h.`,
                    );
                    continue;
                }
                if (built.changed) { downtime = built.block; shiftChanged = true; }
            }

            if (Object.keys(wasteFields).length > 0) {
                const built = buildWasteBlock(item.row, wasteFields);
                if (built.changed) { waste = built.block; shiftChanged = true; }
            }
        }

        if (item.isDraft) {
            payload.push({
                _state: 'new',
                _ids: {},
                shift: {
                    transaction_date: item.identity.date,
                    production_batch: item.identity.batch,
                    shift: item.identity.shift,
                },
                run,
                downtime,
                waste,
            });
            savedDraftIds.push(item.rowId);
            newRuns += 1;
            continue;
        }

        // An edit that undoes itself is not an edit: a row whose text merges back to
        // what is stored, and which carries no block, has nothing to post — but its
        // typing is still SETTLED, so it is forgotten rather than left lit forever.
        if (!runChanged && !shiftChanged) {
            savedRowIds.push(item.rowId);
            continue;
        }

        payload.push({
            _state: 'modified',
            _ids: { ...item.row!._ids },
            shift: {
                transaction_date: item.identity.date,
                production_batch: item.identity.batch,
                shift: item.identity.shift,
            },
            run,
            downtime,
            waste,
        });
        savedRowIds.push(item.rowId);
        if (runChanged) editedRuns += 1;
    }

    // Every row whose typing rode into a shift's BLOCK is settled by that block's
    // verdict, not by its own — a waste figure typed on the primary row and a
    // DT REASON typed beside it are one downtime/waste save. `TableEdits.forget`
    // works on whole rows, so each of them has to be named or its text stays
    // permanently unsaved over values that are now stored.
    for (const [shiftKey, carrierId] of shiftBlockCarrier) {
        const carrierSettled = savedRowIds.includes(carrierId) || savedDraftIds.includes(carrierId);
        if (!carrierSettled) continue; // the carrier was refused — nothing is settled
        const bucket = routed.shifts.get(shiftKey);
        if (!bucket) continue;
        for (const rowId of bucket.rowIds) {
            if (isDraftKey(rowId)) {
                if (!savedDraftIds.includes(rowId)) savedDraftIds.push(rowId);
            } else if (!savedRowIds.includes(rowId)) {
                savedRowIds.push(rowId);
            }
        }
    }

    const counts = { editedRuns, editedShifts: routed.shifts.size, newRuns };

    // **Nothing is written unless every dirty row built a legal payload**, and that is a
    // property of the PLAN rather than a rule each caller has to remember: a refusal
    // anywhere empties the batch. A save that posted the good rows and reported the rest
    // would leave the sheet half-saved with the refusals still on screen — and on THIS
    // action, which is not transactional, "half" would be a real, silent half.
    if (problems.length > 0) {
        return { payload: [], savedRowIds: [], savedDraftIds: [], counts, problems };
    }

    return { payload, savedRowIds, savedDraftIds, counts, problems };
}

// ═══ Unsaved work, in this sheet's own nouns ════════════════════════════════════

export interface DailyUnsavedWork {
    /** Runs carrying unsaved CUSTOMER / GRADE / TTL KG / REM text. */
    runs: number;
    /** SHIFTS carrying unsaved downtime or waste text — not rows: a shift owns one of each. */
    shifts: number;
    /** Blank rows the operator has typed something real into. */
    newRuns: number;
    total: number;
}

/**
 * What is unsaved, counted the way it will be SAVED.
 *
 * The platform's `countUnsavedWork` splits a sheet two ways — stored records and
 * drafts — and this sheet is genuinely three, because one stored row can carry two
 * kinds of change that go to two different tables. Counting rows would also
 * over-count: a waste figure typed on one row and a DT REASON on another of the same
 * shift is ONE downtime/waste save, not two.
 */
export function countDailyUnsaved(input: RouteDailyInput): DailyUnsavedWork {
    const routed = routeDailyEdits(input);
    let runs = 0;
    let newRuns = 0;
    for (const entry of routed.runs.values()) {
        if (entry.isDraft) newRuns += 1;
        else if (Object.keys(entry.fields).length > 0) runs += 1;
    }
    const shifts = routed.shifts.size;
    return { runs, shifts, newRuns, total: runs + shifts + newRuns };
}

/** `2 edited runs and 1 edited shift` — and never a kind that is zero. */
export function describeDailyUnsaved(work: DailyUnsavedWork): string {
    const parts: string[] = [];
    if (work.runs > 0) parts.push(`${work.runs} edited run${work.runs === 1 ? '' : 's'}`);
    if (work.shifts > 0) parts.push(`${work.shifts} edited shift${work.shifts === 1 ? '' : 's'}`);
    if (work.newRuns > 0) parts.push(`${work.newRuns} new run${work.newRuns === 1 ? '' : 's'}`);
    if (parts.length === 0) return 'nothing unsaved';
    if (parts.length === 1) return parts[0];
    return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

// ═══ Naming a row in an error ═══════════════════════════════════════════════════

/** How a stored run is named in a refusal — enough to find it in the sheet. */
export function rowLabel(row: LedgerRow): string {
    const date = row.date || 'undated';
    const batch = row.batch || 'no batch';
    const shift = row.shift_code || '?';
    const grade = row.grade ? ` · ${row.grade}` : '';
    return `${date} · ${batch} · ${shift}${grade}`;
}

/** How a blank row is named, before it has an identity of its own. */
export function draftRowLabel(edits: FieldEditMap, defaults: DraftDefaults): string {
    const date = draftText(edits, 'date', defaults) || 'undated';
    const batch = draftText(edits, 'batch', defaults) || 'no batch';
    const shift = draftText(edits, 'shift_code', defaults) || '?';
    const grade = draftText(edits, 'grade', defaults);
    return `new run ${date} · ${batch} · ${shift}${grade ? ` · ${grade}` : ''}`;
}

// ═══ What the server said ═══════════════════════════════════════════════════════

/**
 * `saveBulkDailyLedger` answers with ONE verdict for the whole batch —
 * `{ ok: true, …counts }` or `{ ok: false, error }` — never one per row.
 *
 * **And it is NOT transactional.** It walks its shift groups with a sequential
 * `await` per table and returns on the first failure, so the groups it already
 * processed ARE written. That is the opposite of RC IN's
 * `fn_bulk_update_deliveries`, which rolls the whole batch back — so the refusal here
 * must not borrow RC IN's "nothing was written" sentence, which would be false and
 * would send the operator back to retype rows that are already stored. It says what is
 * actually true: reload before retrying.
 */
export function dailySaveFailureMessage(
    counts: DailySavePlan['counts'],
    message: string | null | undefined,
): string {
    const parts: string[] = [];
    if (counts.editedRuns > 0) parts.push(`${counts.editedRuns} edited run${counts.editedRuns === 1 ? '' : 's'}`);
    if (counts.editedShifts > 0) parts.push(`${counts.editedShifts} shift${counts.editedShifts === 1 ? '' : 's'}`);
    if (counts.newRuns > 0) parts.push(`${counts.newRuns} new run${counts.newRuns === 1 ? '' : 's'}`);
    const what = parts.length > 0 ? parts.join(', ') : 'this save';
    const head =
        `The ledger refused ${what}. This save is applied shift by shift and is NOT rolled back, ` +
        `so any shift processed before the failure IS already stored — reload the tab to see what landed before you retry. ` +
        `Every keystroke is still on screen.`;
    const detail = (message ?? '').trim();
    return detail ? `${head}\n\n${detail}` : head;
}

/** `3 runs · 1 shift` — what a successful save actually did, in the sheet's nouns. */
export function dailySaveSuccessMessage(counts: DailySavePlan['counts']): string {
    const parts: string[] = [];
    if (counts.editedRuns > 0) parts.push(`${counts.editedRuns} edited run${counts.editedRuns === 1 ? '' : 's'}`);
    if (counts.newRuns > 0) parts.push(`${counts.newRuns} new run${counts.newRuns === 1 ? '' : 's'}`);
    if (counts.editedShifts > 0) parts.push(`${counts.editedShifts} shift${counts.editedShifts === 1 ? '' : 's'} of downtime / waste`);
    return parts.length > 0 ? `Saved ${parts.join(', ')}.` : 'Saved.';
}
