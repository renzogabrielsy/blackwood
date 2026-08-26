// ─────────────────────────────────────────────────────────────────────────────────
// Trucks — the v2 grid's PIVOT + EDIT + SAVE model. PURE (no React, no Supabase, no
// server action).
//
// `trucks-grid-v2.tsx` is the React adapter; everything here is a plain function over
// plain data, so the things this sheet can most easily get silently wrong are asserted by
// `scripts/verify-electricity-trucks-grid.ts` without a browser or a database.
//
// The sibling of `../electricity/electricity-grid-v2-save.ts`, and every rule written
// down in THAT header applies here too — the whole-row payload, the staged
// non-transactional action, the pre-flight natural-key sweep. What follows is only what
// is DIFFERENT, and the difference is the shape of the sheet.
//
// ═══ ONE ROW ON SCREEN IS N ROWS IN THE DATABASE ═══════════════════════════════
//
// `truck_readings` is one row per `(reading_date, plate_no)`. The sheet PIVOTS it: one
// rendered row per DAY, with a four-column band per truck. So a single day row can
// produce one update per plate, one insert per plate, or both at once — and the save has
// to file each of them against the right stored id. That is what `buildDayRows` keeps
// the per-plate `id` for (the read-only pass dropped it deliberately; a sheet that cannot
// save has no use for it).
//
// ═══ EDITING THE DATE MOVES **THE WHOLE DAY** ══════════════════════════════════
//
// The live grid marks the row `modified` when its date changes and then updates only the
// cells whose own value was touched — so changing ONLY the date saves **nothing at all**
// and the row stays dirty forever. That is not a rule worth porting: an operator who
// corrects a day's date means "these readings were booked under the wrong date", and the
// readings are what carry the date.
//
// So a DATE edit re-files EVERY stored reading on that row under the new date. Each one
// is an ordinary update whose payload is otherwise the stored values, so nothing else
// about the readings changes. If the target date already holds a reading for one of those
// trucks, the natural-key sweep refuses the whole save by name BEFORE anything is
// written — which is exactly what a unique violation arriving mid-batch could not do.
//
// ═══ WHAT THE DATABASE ACTUALLY ENFORCES, AND WHAT IT DOES NOT ═════════════════
//
// Measured against `supabase/migrations/20260527010000_create_production_tables.sql`:
// `UNIQUE (reading_date, plate_no)` is REAL (hence the pre-flight key sweep), and so are
// `start_km >= 0`, `end_km >= 0` and `fuel_liters >= 0` — all refused BY NAME here so they
// never arrive as a constraint string. But **`end_km >= start_km` is not a constraint at
// all**: `translateDbError` maps a name (`chk_truck_readings_end_km`) that no migration
// ever created, and `saveBulkTrucks` only checks it on an UPDATE when both halves are in
// the patch. That is why every payload carries both, and why the plan checks the rule
// itself — otherwise a backwards odometer would be stored by a save nothing refused.
//
// ═══ REMARKS ARE CARRIED, NEVER TYPED ══════════════════════════════════════════
//
// `truck_readings.remarks` exists and the sync writes it, but the matrix has no column
// for it — there is nowhere to put a text lane in a four-column plate band. The live grid
// keeps the stored remark in its pivot cell and sends it back on every update for exactly
// this reason, and so does this: the remark rides along untouched. It is never typeable
// here, so it is not in `TRUCK_EDIT_FIELDS`.
// ─────────────────────────────────────────────────────────────────────────────────

import { normalizeTypedDate, stripNumericFormatting, trimCellValue } from '@/lib/paste-utils';
import type { Tables } from '@/types/supabase';

export type TruckReadingRow = Tables<'truck_readings'>;

// ═══ Row identity ══════════════════════════════════════════════════════════════

/** A blank DAY row at the bottom of the sheet, before it has any identity of its own. */
export const DRAFT_PREFIX = 'truckdraft:';

let draftSeq = 0;

/**
 * Fresh draft-row ids.
 *
 * A monotonic counter, never a random string: these are React keys AND the key each blank
 * row's typing is filed under, and two colliding would merge two days into one.
 */
export function makeDraftIds(n: number): string[] {
    return Array.from({ length: n }, () => `${DRAFT_PREFIX}${++draftSeq}`);
}

export function isDraftKey(rowId: string): boolean {
    return rowId.startsWith(DRAFT_PREFIX);
}

// ═══ Column keys ═══════════════════════════════════════════════════════════════
//
// The key is the column's stable IDENTITY — it lands in saved widths, in a cell's
// `data-col-key`, and it is the FIELD every edit is filed under. Encoded and decoded in
// ONE place so nothing has to take a key apart by hand.

export const DATE_KEY = 'date';
/** No plate contains it, so splitting a key back apart is unambiguous. */
export const KEY_SEP = '::';

/** The three lanes an operator may type into, per truck. */
export const TRUCK_METRICS = ['start_km', 'end_km', 'fuel_liters'] as const;
export type MetricField = (typeof TRUCK_METRICS)[number];

const METRIC_SET: ReadonlySet<string> = new Set<string>(TRUCK_METRICS);

export type ColumnLane =
    | { kind: 'date' }
    | { kind: 'metric'; plate: string; metric: MetricField }
    | { kind: 'ttl'; plate: string };

export function colKeyOf(plate: string, metric: MetricField | 'ttl_km'): string {
    return `${plate}${KEY_SEP}${metric}`;
}

/** A column key → what that column IS. `null` for anything this sheet does not own. */
export function parseColKey(key: string): ColumnLane | null {
    if (key === DATE_KEY) return { kind: 'date' };
    const at = key.indexOf(KEY_SEP);
    if (at < 0) return null;
    const plate = key.slice(0, at);
    const metric = key.slice(at + KEY_SEP.length);
    if (!plate) return null;
    if (metric === 'ttl_km') return { kind: 'ttl', plate };
    if (METRIC_SET.has(metric)) return { kind: 'metric', plate, metric: metric as MetricField };
    return null;
}

/** Is this column key something a human may type into? */
export function isTruckEditField(key: string): boolean {
    const lane = parseColKey(key);
    return lane !== null && lane.kind !== 'ttl';
}

// ═══ The pivot ═════════════════════════════════════════════════════════════════

/** Canonical plate set — always present, in this fixed order. The live grid's own. */
export const KNOWN_PLATES = ['AAV 6111', 'KCA 378', 'FORKLIFT'] as const;

/**
 * One truck's numbers for one day.
 *
 * `id` is the stored `truck_readings.id` — absent means this `(date, plate)` does not
 * exist yet, which is what tells the save an INSERT from an UPDATE. `remarks` is stored
 * text this sheet never shows and never edits; it is carried so an update can send it
 * back unchanged (see the header).
 */
export interface PlateCell {
    id?: string;
    start_km: string;
    end_km: string;
    fuel_liters: string;
    remarks: string;
}

/** One rendered row: a `reading_date` with every plate's cell beside it. */
export interface DayRow {
    reading_date: string;
    cells: Record<string, PlateCell>;
}

export function emptyPlateCell(): PlateCell {
    return { start_km: '', end_km: '', fuel_liters: '', remarks: '' };
}

const numText = (v: number | null | undefined): string =>
    v === null || v === undefined ? '' : String(v);

export function dbRowToPlateCell(r: TruckReadingRow): PlateCell {
    return {
        id: r.id,
        start_km: numText(r.start_km),
        end_km: numText(r.end_km),
        fuel_liters: numText(r.fuel_liters),
        remarks: r.remarks ?? '',
    };
}

/** The stable plate column set — the canonical three, then any extra plate, sorted. */
export function derivePlates(data: readonly TruckReadingRow[]): string[] {
    const known = new Set<string>(KNOWN_PLATES);
    const extras = new Set<string>();
    for (const r of data) {
        const p = r.plate_no?.trim();
        if (!p) continue;
        if (!known.has(p)) extras.add(p);
    }
    return [...KNOWN_PLATES, ...[...extras].sort((a, b) => a.localeCompare(b))];
}

/**
 * DB rows → the pivot, one row per `reading_date`, in the server's own order.
 *
 * The live grid's private `buildGridRows` without its `_state` / `_dirty` bookkeeping —
 * the table module owns "is this dirty" and there must not be a second answer to it — but
 * WITH the per-plate `id`, which is the one piece of it the save genuinely needs.
 */
export function buildDayRows(
    data: readonly TruckReadingRow[],
    plates: readonly string[],
): DayRow[] {
    const byDate = new Map<string, DayRow>();
    const order: string[] = [];

    for (const r of data) {
        const date = r.reading_date ?? '';
        if (!date) continue;
        let row = byDate.get(date);
        if (!row) {
            const cells: Record<string, PlateCell> = {};
            for (const p of plates) cells[p] = emptyPlateCell();
            row = { reading_date: date, cells };
            byDate.set(date, row);
            order.push(date);
        }
        const plate = r.plate_no?.trim();
        // Last write wins on a duplicate `(date, plate)` — the natural key says it cannot
        // happen; the live grid stays defensive about it and so does this.
        if (plate && row.cells[plate]) row.cells[plate] = dbRowToPlateCell(r);
    }

    return order.map((d) => byDate.get(d)!);
}

export function cellOf(row: DayRow, plate: string): PlateCell {
    return row.cells[plate] ?? emptyPlateCell();
}

// ═══ The derivation — the LIVE grid's inline formula, over TEXT ═════════════════
//
// `truck_readings.ttl_km` is a GENERATED column, but the live grid shows `end − start`
// computed in the client from the EDIT BUFFER, so a typed END updates TTL immediately.
// This takes text for exactly that reason: the v2 sheet's TTL lane previews unsaved edits
// through the same function the stored rendering uses, so the two cannot disagree.

const numOf = (text: string): number => {
    const n = Number.parseFloat(text);
    return Number.isFinite(n) ? n : 0;
};

export function ttlKmOf(startText: string, endText: string): number {
    return numOf(endText) - numOf(startText);
}

// ═══ Canonical cell text ═══════════════════════════════════════════════════════

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * What a cell HOLDS as text — the editor's opening value, the jump keys' "is this cell
 * filled" probe, the value an edit must return to in order to stop counting as unsaved,
 * and what the save reads for every field the operator did NOT touch.
 *
 * The read-only TTL lane still HOLDS a value: returning '' would make a run of computed
 * distances read as a blank gap to Ctrl+Arrow.
 */
export function storedFieldText(row: DayRow | null, field: string): string {
    if (!row) return '';
    const lane = parseColKey(field);
    if (lane === null) return '';
    if (lane.kind === 'date') return row.reading_date;
    const cell = cellOf(row, lane.plate);
    if (lane.kind === 'ttl') {
        const t = ttlKmOf(cell.start_km, cell.end_km);
        return t > 0 ? String(t) : '';
    }
    return cell[lane.metric];
}

// ═══ ONE field, ONE verdict ════════════════════════════════════════════════════

export interface TrucksEnv {
    /** What a bare `8/21` means on THIS row. */
    contextYear: number;
}

export type FieldVerdict =
    | { ok: true; value: string | number | null }
    | { ok: false; error: string };

/** The short name each metric goes by in a refusal. */
const METRIC_LABEL: Record<MetricField, string> = {
    start_km: 'START KM',
    end_km: 'END KM',
    fuel_liters: 'FUEL',
};

/**
 * Canonicalise what the operator COMMITTED. Only the DATE lane has a canonical spelling;
 * it may not refuse, because `parseTruckField` runs immediately afterwards on whatever
 * this returns.
 */
export function normalizeTruckField(field: string, text: string, env: TrucksEnv): string {
    if (!text.trim()) return text;
    if (parseColKey(field)?.kind === 'date') return normalizeTypedDate(text, env.contextYear);
    return text;
}

/**
 * One cell's text → the value that goes on the row, or a sentence saying why not.
 *
 * **A BLANK cell is legal and means CLEARED.** The plan decides what a cleared cell
 * becomes — 0 for an odometer reading, null for fuel — and the one field a day cannot
 * exist without (`reading_date`) is refused at ROW level, so clearing a cell you are
 * about to retype does not raise a persistent toast mid-typing.
 */
export function parseTruckField(field: string, raw: string, env: TrucksEnv): FieldVerdict {
    const lane = parseColKey(field);
    if (lane === null || lane.kind === 'ttl') {
        return { ok: false, error: `${field} is not a cell that can be typed into.` };
    }

    const text = (raw ?? '').trim();

    if (lane.kind === 'date') {
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

    if (!text) return { ok: true, value: null };
    const n = Number(stripNumericFormatting(text));
    if (!Number.isFinite(n) || n < 0) {
        const noun =
            lane.metric === 'fuel_liters' ? 'a fuel figure in litres' : 'an odometer reading in km';
        return { ok: false, error: `${lane.plate} ${METRIC_LABEL[lane.metric]} "${text}" is not ${noun}.` };
    }
    return { ok: true, value: n };
}

/**
 * A pasted cell loses whatever rendering a spreadsheet copied in with it — and a pasted
 * DATE goes through the SAME normalisation a typed one does, with the same context year.
 */
export function cleanPastedTruckCell(field: string, raw: string, env: TrucksEnv): string {
    const text = trimCellValue(raw);
    if (!text) return text;
    const lane = parseColKey(field);
    if (lane?.kind === 'date') return normalizeTypedDate(text, env.contextYear);
    if (lane?.kind === 'metric') return stripNumericFormatting(text);
    return text;
}

// ═══ The payload ═══════════════════════════════════════════════════════════════

export type FieldEditMap = Readonly<Record<string, string | undefined>>;
export type RowEditMap = Readonly<Record<string, FieldEditMap>>;

/**
 * EXACTLY six keys — the live grid's own payload shape.
 *
 * Declared as its own interface rather than as `TablesInsert<'truck_readings'>`, which
 * would also accept `ttl_km`, a GENERATED column the database refuses to be told about.
 * Structurally assignable to both the Insert and the Update the action takes, so the door
 * it goes through is unchanged.
 */
export interface TruckWrite {
    reading_date: string;
    plate_no: string;
    start_km: number;
    end_km: number;
    fuel_liters: number | null;
    remarks: string | null;
}

/** A cleared odometer cell saves 0 — the live grid's own coercion. */
const kmOf = (text: string): number => {
    const n = Number.parseFloat(text);
    return Number.isFinite(n) ? n : 0;
};

/** A cleared FUEL cell saves NULL, not 0 — "not recorded" is not "no fuel". */
const fuelOf = (text: string): number | null => {
    if (!text.trim()) return null;
    const n = Number.parseFloat(text);
    return Number.isFinite(n) ? n : null;
};

// ═══ Naming a row in an error ══════════════════════════════════════════════════

export function cellLabel(date: string, plate: string): string {
    return `${date || 'undated'} · ${plate}`;
}

export function draftLabel(edits: FieldEditMap, defaultDate: string): string {
    const date = (edits[DATE_KEY] ?? defaultDate).trim() || 'undated';
    return `new day ${date}`;
}

// ═══ The plan ══════════════════════════════════════════════════════════════════

/** `(reading_date, plate_no)` — the table's natural key, spelled once. */
export function naturalKey(date: string, plate: string): string {
    return `${date} ${plate}`;
}

export interface TrucksSavePlan {
    updates: { id: string; data: TruckWrite }[];
    inserts: TruckWrite[];
    /** Day-row ids to `forget` once their readings land. */
    updatedRowIds: string[];
    /** Draft ids to retire once their readings land. */
    insertedDraftIds: string[];
    problems: string[];
}

export interface TrucksPlanInput {
    edits: RowEditMap;
    dirtyRecords: ReadonlySet<string>;
    dirtyDrafts: ReadonlySet<string>;
    draftIds: readonly string[];
    /** The pivot currently on screen, in render order. Row id IS the stored date. */
    dayRows: readonly DayRow[];
    plates: readonly string[];
    defaultDate: string;
    env: TrucksEnv;
}

/**
 * Everything the Save button is about to do, decided before anything is sent.
 *
 * **Nothing is written unless every dirty row builds a legal payload** — the action is
 * staged and non-transactional, so a batch that posted the good rows and let the server
 * refuse the rest would leave the sheet genuinely half-saved with no way to tell which
 * half (see `saveFailureMessage`).
 *
 * The natural-key sweep runs over the state this save would LEAVE BEHIND: every stored
 * reading claims its final `(date, plate)` — its new date if this save moves the day, its
 * stored one otherwise — and every new reading claims its own. A duplicate is refused
 * with both sides named. It can only see the period on screen; a collision with a row
 * outside the loaded window still comes back from the database.
 */
export function buildTrucksSavePlan(input: TrucksPlanInput): TrucksSavePlan {
    const { edits, dirtyRecords, dirtyDrafts, draftIds, dayRows, plates, defaultDate, env } = input;

    const plan: TrucksSavePlan = {
        updates: [], inserts: [], updatedRowIds: [], insertedDraftIds: [], problems: [],
    };

    /** key → how the reading holding it is named, for the collision message. */
    const claimed = new Map<string, string>();
    const collide = (key: string, who: string) => {
        const other = claimed.get(key);
        if (other === undefined) {
            claimed.set(key, who);
            return;
        }
        plan.problems.push(
            `${who}: this truck already has a reading on this date (${other}). One truck has one reading per day — edit that row instead.`,
        );
    };

    // Untouched days keep their keys, claimed FIRST so a collision always reads as "the
    // row you are moving or adding hit this one", never the reverse.
    for (const row of dayRows) {
        if (dirtyRecords.has(row.reading_date)) continue;
        for (const plate of plates) {
            const cell = cellOf(row, plate);
            if (cell.id) claimed.set(naturalKey(row.reading_date, plate), cellLabel(row.reading_date, plate));
        }
    }

    for (const row of dayRows) {
        const rowId = row.reading_date;
        if (!dirtyRecords.has(rowId)) continue;
        const rowEdits = edits[rowId] ?? {};
        const problemsBefore = plan.problems.length;

        // ── The day's date ────────────────────────────────────────────────────────
        let finalDate = row.reading_date;
        const dateEdit = rowEdits[DATE_KEY];
        if (dateEdit !== undefined) {
            const verdict = parseTruckField(DATE_KEY, dateEdit, env);
            if (!verdict.ok) {
                plan.problems.push(`${row.reading_date}: ${verdict.error}`);
            } else if (verdict.value === null) {
                plan.problems.push(
                    `${row.reading_date}: a day needs a date — the DATE cell cannot be cleared.`,
                );
            } else {
                finalDate = String(verdict.value);
            }
        }
        const dayMoved = finalDate !== row.reading_date;

        const rowUpdates: { id: string; data: TruckWrite }[] = [];
        const rowInserts: TruckWrite[] = [];

        for (const plate of plates) {
            const cell = cellOf(row, plate);
            const touched = TRUCK_METRICS.some((m) => rowEdits[colKeyOf(plate, m)] !== undefined);

            // Every STORED reading occupies its final key whether or not this save
            // rewrites it — an untouched truck on a day that moved still moves.
            if (cell.id) collide(naturalKey(finalDate, plate), cellLabel(finalDate, plate));

            if (!touched && !(cell.id && dayMoved)) continue;

            const values: Partial<Record<MetricField, string>> = {};
            let refused = false;
            for (const metric of TRUCK_METRICS) {
                const raw = rowEdits[colKeyOf(plate, metric)];
                if (raw === undefined) {
                    values[metric] = cell[metric];
                    continue;
                }
                const verdict = parseTruckField(colKeyOf(plate, metric), raw, env);
                if (!verdict.ok) {
                    plan.problems.push(`${cellLabel(finalDate, plate)}: ${verdict.error}`);
                    refused = true;
                    continue;
                }
                values[metric] = verdict.value === null ? '' : String(verdict.value);
            }
            if (refused) continue;

            const start = kmOf(values.start_km ?? '');
            const end = kmOf(values.end_km ?? '');
            if (end < start) {
                plan.problems.push(
                    `${cellLabel(finalDate, plate)}: END KM (${end}) is below START KM (${start}) — an odometer does not run backwards.`,
                );
                continue;
            }

            const write: TruckWrite = {
                reading_date: finalDate,
                plate_no: plate,
                start_km: start,
                end_km: end,
                fuel_liters: fuelOf(values.fuel_liters ?? ''),
                // Carried, never typed — the matrix has no remarks column (see header).
                remarks: cell.remarks || null,
            };

            if (cell.id) {
                rowUpdates.push({ id: cell.id, data: write });
                continue;
            }
            // A truck with no stored reading and nothing typed into it is not a row —
            // it is the blank the pivot paints for every plate on every day.
            const hasValue = !!(values.start_km || values.end_km || values.fuel_liters);
            if (!hasValue) continue;
            collide(naturalKey(finalDate, plate), cellLabel(finalDate, plate));
            rowInserts.push(write);
        }

        // A day is filed as a whole: if any of its cells was refused, none of its cells
        // is posted, so a half-saved DAY is not representable even before the run-wide
        // "nothing is written unless everything is legal" rule applies.
        if (plan.problems.length > problemsBefore) continue;
        if (rowUpdates.length === 0 && rowInserts.length === 0) continue;
        plan.updates.push(...rowUpdates);
        plan.inserts.push(...rowInserts);
        plan.updatedRowIds.push(rowId);
    }

    for (const draftId of draftIds) {
        if (!dirtyDrafts.has(draftId)) continue;
        const rowEdits = edits[draftId] ?? {};
        const problemsBefore = plan.problems.length;
        const label = draftLabel(rowEdits, defaultDate);

        let date = defaultDate;
        const dateEdit = rowEdits[DATE_KEY];
        if (dateEdit !== undefined) {
            const verdict = parseTruckField(DATE_KEY, dateEdit, env);
            if (!verdict.ok) plan.problems.push(`${label}: ${verdict.error}`);
            else if (verdict.value === null) plan.problems.push(`${label}: a new day needs a date.`);
            else date = String(verdict.value);
        }

        const rowInserts: TruckWrite[] = [];
        for (const plate of plates) {
            const values: Partial<Record<MetricField, string>> = {};
            let refused = false;
            for (const metric of TRUCK_METRICS) {
                const raw = rowEdits[colKeyOf(plate, metric)];
                if (raw === undefined) continue;
                const verdict = parseTruckField(colKeyOf(plate, metric), raw, env);
                if (!verdict.ok) {
                    plan.problems.push(`${cellLabel(date, plate)}: ${verdict.error}`);
                    refused = true;
                    continue;
                }
                values[metric] = verdict.value === null ? '' : String(verdict.value);
            }
            if (refused) continue;
            if (!values.start_km && !values.end_km && !values.fuel_liters) continue;

            const start = kmOf(values.start_km ?? '');
            const end = kmOf(values.end_km ?? '');
            if (end < start) {
                plan.problems.push(
                    `${cellLabel(date, plate)}: END KM (${end}) is below START KM (${start}) — an odometer does not run backwards.`,
                );
                continue;
            }
            rowInserts.push({
                reading_date: date,
                plate_no: plate,
                start_km: start,
                end_km: end,
                fuel_liters: fuelOf(values.fuel_liters ?? ''),
                remarks: null,
            });
        }

        if (plan.problems.length > problemsBefore) continue;
        if (rowInserts.length === 0) {
            plan.problems.push(
                `${label}: a new day needs at least one truck reading — every START, END and FUEL cell on it is blank.`,
            );
            continue;
        }
        // Claimed BEFORE the push and re-checked after, so a colliding blank row is
        // refused AND absent from the plan — the same invariant an unreadable cell has.
        for (const write of rowInserts) {
            collide(naturalKey(write.reading_date, write.plate_no), cellLabel(write.reading_date, write.plate_no));
        }
        if (plan.problems.length > problemsBefore) continue;
        plan.inserts.push(...rowInserts);
        plan.insertedDraftIds.push(draftId);
    }

    return plan;
}

// ═══ What the server said ══════════════════════════════════════════════════════

/**
 * `saveBulkTrucks` answers with ONE `{ ok, error }` for the whole batch and — on failure
 * — **no counts at all**. It is STAGED and not transactional: the inserts go as one
 * statement, then the updates one `supabase.update()` at a time, returning at the first
 * refusal.
 *
 * So a failure means *some prefix of this save is already stored and the rest was never
 * attempted*, and the client genuinely cannot say where the line fell. This says exactly
 * that rather than claiming a rollback that did not happen. The count is in READINGS, not
 * in rows on screen, because one day row can carry three trucks and the database refused
 * one of them.
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
        `Saving ${what} stopped at the first refusal. This save path writes in stages — new readings first, then edits one at a time — and it is NOT one transaction, so anything staged before the refusal IS already stored and everything after it was never attempted. No counts come back, so the sheet cannot say where the line fell: it has been reloaded from the database, and every keystroke is still on screen on top of it.`;

    const detail = (message ?? '').trim();
    return detail ? `${head}\n\n${detail}` : head;
}

export function saveSuccessMessage(counts: { updates: number; inserts: number }): string {
    const parts: string[] = [];
    if (counts.inserts > 0) parts.push(`${counts.inserts} added`);
    if (counts.updates > 0) parts.push(`${counts.updates} updated`);
    return `Saved — ${parts.join(', ')}`;
}
