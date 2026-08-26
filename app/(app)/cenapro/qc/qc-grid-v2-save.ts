// ─────────────────────────────────────────────────────────────────────────────────
// QC Ledger — the v2 grid's EDIT + SAVE model. PURE (no React, no Supabase).
//
// `qc-ledger-grid-v2.tsx` is the React adapter; everything here is a plain function
// over plain data, so the one thing this slice can most easily get silently wrong —
// **WHICH THING a cell's edit is actually a save to** — is asserted by
// `scripts/verify-qc-grid.ts` without a browser or a database.
//
// It is the third instance of the shape `app/(app)/cenapro/deliveries/grid-v2-save.ts`
// and `app/(app)/inventory/rc-in/rc-in-grid-v2-save.ts` established. Where it DIFFERS,
// it differs because this ledger's write model is a different shape, and each
// difference is written down below.
//
// ═══ THE SHEET HAS TWO LANES, AND THEY SAVE TO DIFFERENT ROWS ═══════════════════
//
// One rendered row is one DRAW (`cenapro.production_event`). But of the sixteen
// columns, only two lanes are writable at all, and they do not write to the same
// thing:
//
//   • **WT KG is PER DRAW.** `cenapro_update_event_weight`, one call per draw,
//     compare-and-set on the weight the operator was LOOKING AT. A weight never
//     carries to the group — it is this truckload's kilograms and nobody else's.
//   • **BD / ASH / GRIT / MC are PER SAMPLE GROUP.** One lab reading covers every
//     draw from the same source and warehouse on the same day, and the sheet shows
//     it on the group's FIRST draw. An edit on one of those four cells is therefore
//     **a save to the GROUP** — `cenapro_save_analysis_sample`, keyed
//     `date|SRC|WHSE`, compare-and-set on the group's own `sample_row_version` —
//     and it must NOT be filed against the draw the caret happened to be on.
//
// That is why `routeQcEdits` exists and why the verify script's first assertions are
// about it. Filing a metric edit against a draw would post the reading with a weight
// RPC's arguments; filing a weight against a group would restate every sibling draw.
//
// ═══ THE MERGE DECISION: THE GROUP RPC **REPLACES** THE READING ═════════════════
//
// `cenapro_save_analysis_sample` takes all four metrics as `DEFAULT NULL` parameters,
// and `actions.ts::buildArgs` OMITS a null one — which, on the UPDATE path, CLEARS it
// exactly as an explicit null would (its own comment says so). So the payload is not a
// patch: **whatever is not sent is deleted.**
//
// Therefore a partial metric edit is merged against the STORED reading before it is
// sent — `overlayMetrics(group.sample, edits)` — and the untouched metrics ride back
// unchanged. Typing an ASH on a group that already carries BD must not delete the BD.
// This is the same shape as RC IN's lab panel (a shallow jsonb merge that replaces the
// whole object) and Cenapro deliveries' draw block (an RPC that replaces the block):
// three different mechanisms, one rule — *reassemble the whole thing, always*.
//
// The merge uses `parseMetricValue`, the RPC's own shared twin, so a value that would
// be refused by the database is refused HERE by name rather than coerced. (The live
// ledger's private `overlay` uses a bare `Number.parseFloat`, which reads `1O.2` as 1.
// Nothing here can do that: `parseQcField` is the one verdict, and it runs at commit
// AND at save.)
//
// ═══ A DRAFT ROW IS A `DraftDraw`, NOT A SECOND SET OF RULES ════════════════════
//
// Every rule about what a NEW draw may contain — the required fields, the FLEC-only
// bag lanes, the date parse, the two-drafts-one-group reading conflict — already lives
// in `draw-entry-rows.tsx` (`draftBlocker`, `draftToInput`, `draftMetrics`,
// `isSendableDraft`, `findDraftReadingConflicts`), is exercised by
// `scripts/verify-qc-draw-cells.ts`, and is what the live composer runs. A second copy
// keyed off the table module's edit map would be a second definition of "is this row
// legal" that could drift from the one the operator has been using since 2026-08-04.
//
// So `draftFromEdits` is the ONLY new code on this path: it maps this grid's typeable
// COLUMN KEYS onto that interface's field names, and everything downstream is the
// composer's own functions, called verbatim. That file is not edited.
//
// ═══ WHAT IS **NOT** HERE, AND WHY ══════════════════════════════════════════════
//
// **No save-time reason dialog.** RC IN has one because `bulkUpdateDeliveries` takes a
// `comment` that the RPC glues onto the row's latest `audit_logs` entry. None of QC's
// three RPCs — `cenapro_save_analysis_sample`, `cenapro_update_event_weight`,
// `cenapro_add_partner_draw` — accepts a comment or a note in any form (see their
// `Args` types and `actions.ts`'s argument builders). A dialog collecting a sentence
// with nowhere to put it would be a lie about what was recorded, so there is none.
//
// **No new server action and no SQL.** The three actions above are called exactly as
// `qc-ledger-client.tsx` calls them, with the same payload shapes.
// ─────────────────────────────────────────────────────────────────────────────────

import {
    BAGGING_MACHINE_CODE,
    METRICS,
    METRIC_SHORT,
    canonToken,
    parseMetricValue,
    parseQcDate,
    parseWeightKg,
    type MetricKey,
} from '@/lib/cenapro/ccc-analysis';
import { EMPTY_METRIC_VALUES, type MetricValues } from '@/lib/cenapro/ccc-analysis-view';

import { PLANT_CODES } from '../types';
import {
    draftBlocker,
    draftMetrics,
    draftToInput,
    findDraftReadingConflicts,
    isMeaningfulDraft,
    isSendableDraft,
    type DraftDraw,
} from './draw-entry-rows';
import type {
    AddQcDrawResult,
    AddQcDrawRow,
    QcGroupVersions,
    SaveQcSampleInput,
    SaveQcSampleResult,
    SaveQcWeightInput,
    SaveQcWeightResult,
} from './actions';
import type { QcDraw, QcDrawOptions, QcGroup } from './data';

// ═══ Row identity ═══════════════════════════════════════════════════════════════

/**
 * A blank row at the bottom of the sheet, before it has any identity of its own.
 *
 * Deliberately NOT the bare `draft:` the two delivery sheets use: a stored QC row's id
 * is a `production_event` uuid, and prefixing this one with the surface it belongs to
 * makes a mis-routed id obvious in a log line rather than plausible.
 */
export const DRAFT_PREFIX = 'qcdraft:';

let draftSeq = 0;

/**
 * Fresh draft-row ids.
 *
 * A monotonic counter, never a random string: these are React keys AND the key each
 * blank row's typing is filed under, and two colliding would merge two slip lines into
 * one draw.
 */
export function makeDraftIds(n: number): string[] {
    return Array.from({ length: n }, () => `${DRAFT_PREFIX}${++draftSeq}`);
}

export function isDraftKey(rowId: string): boolean {
    return rowId.startsWith(DRAFT_PREFIX);
}

// ═══ The fields ═════════════════════════════════════════════════════════════════

/**
 * The eleven identity/dimension lanes, in the sheet's column order — which is the
 * PRODUCTION ledger's order since 2026-08-25 (see `QC_COLUMNS` below). The order here is
 * documentation only: nothing reads this array positionally.
 */
export const QC_ROW_FIELDS = [
    'date', 'prod', 'shift', 'grade', 'plant', 'whse', 'src', 'wt', 'mach', 'bags', 'side',
] as const;
export type QcRowField = (typeof QC_ROW_FIELDS)[number];

/** Every field an operator may type into anywhere on this sheet. */
export type QcField = QcRowField | MetricKey;

// ═══ THE ARRANGEMENT — the production ledger's, column for column ════════════════
//
// Renzo, 2026-08-25: *"I'd like for the new table columns to be exact the same
// arrangement as the current prod ledger for cenapro as well. This way, it's the same tab
// feel and flow inputting in qc ledger rather than prod ledger… importing some of the
// columns that don't exist in qc ledger from prod ledger would also work."*
//
// So the order below is NOT this sheet's own taste — it is
// `production-grid-v2-shared.tsx`'s `COLS`, mapped onto QC's nouns, with QC's four lab
// lanes appended where the production ledger's columns run out. The two screens name four
// of the shared lanes differently and mean the same thing by them:
//
//   production `recv`   ⇄ QC `date`   — the receipt date at CCC
//   production `source` ⇄ QC `src`    — the source location
//   production `ccc`    ⇄ QC `mach`   — the partner machine (which alone decides the
//                                       disposition; production shows the merged
//                                       `CCC/FLEC` label, QC shows the machine code)
//   production `flec`   ⇄ QC `bags`   — the flec bag count
//
// **It lives here, in the pure module, because the grid RENDERS from it** — the React
// adapter builds one spec per key and then maps this array, so this is the arrangement
// rather than a description of one. `scripts/verify-qc-grid.ts` reads the production
// ledger's own column table off disk and asserts the two still line up, so a column added
// there is a failing assertion here rather than a silent divergence.
//
// `batch` carries no `QcField`: it is an IMPORTED lane with no QC write path (see
// `QC_IMPORTED_COLUMNS`), which is why `isQcField` still answers false for it.
//
// ── THE ONE SANCTIONED DEVIATION: `num` IS DROPPED (2026-08-26) ─────────────────
//
// Renzo, on the rearranged sheet: *"I dont think row number is necessary to display.
// Wasted space."* So the arrangement is the production ledger's order MINUS its leading
// `num`, with the four lab lanes still appended. It is stated here, and asserted in
// `scripts/verify-qc-grid.ts` as a deviation with a name rather than as a weakened check:
// the alignment test still reads the production ledger's `COLS` off disk, drops exactly
// one known key from it, and requires the rest to line up column for column. A column
// moved or added over there still fails here.
//
// One consequence is deliberately NOT papered over: a block copied out of the production
// ledger carries a leading ordinal cell that this sheet no longer has a slot for, so a
// positional paste lands one column to the left. See the file header of
// `qc-ledger-grid-v2.tsx`.
export const QC_COLUMNS = [
    'date', 'prod', 'batch',
    'shift', 'grade', 'plant', 'whse', 'src', 'wt', 'mach', 'bags', 'side',
    'bd', 'ash', 'grit', 'mc',
] as const;
export type QcColumnKey = (typeof QC_COLUMNS)[number];

/**
 * The column imported from the production ledger that QC can never SAVE.
 *
 * `batch` is the production label. `data.ts` now SELECTS it (2026-08-26) so a stored row
 * shows the real batch rather than a dash forever — but it stays un-typeable, because
 * `cenapro_add_partner_draw` derives it SERVER-SIDE from `recv_date` and no QC RPC accepts
 * one, so there is nothing an operator could type that would be kept.
 *
 * It keeps its visual slot and is `addressable: false` in every row family — so Tab steps
 * straight over it while the lane still reads as the production ledger's.
 *
 * **It is not a `QcField`**, which is what makes "it must not accept text" structural: no
 * `parse` can be built for a key `parseQcField` has no case for, so nothing typed into it
 * could ever be silently discarded at save.
 *
 * It is a LIST of one rather than a scalar on purpose: `num` was here until 2026-08-26 and
 * the next production column QC cannot write would join it, so every consumer already
 * iterates.
 */
export const QC_IMPORTED_COLUMNS = ['batch'] as const;
export type QcImportedColumn = (typeof QC_IMPORTED_COLUMNS)[number];

const METRIC_SET: ReadonlySet<string> = new Set<string>(METRICS as readonly string[]);
const ROW_FIELD_SET: ReadonlySet<string> = new Set<string>(QC_ROW_FIELDS);

export function isMetricField(key: string): key is MetricKey {
    return METRIC_SET.has(key);
}

const IMPORTED_SET: ReadonlySet<string> = new Set<string>(QC_IMPORTED_COLUMNS);

/**
 * Is this column one of the ones imported from the production ledger?
 *
 * THE one definition, so the column table, both row families and the verify script all
 * answer it the same way. An imported column is painted and skipped: it has a slot (so
 * `format` runs and the lane is not blank scaffolding) that is `editable: false` and
 * `addressable: false`.
 */
export function isImportedColumn(key: string): key is QcImportedColumn {
    return IMPORTED_SET.has(key);
}

export function isQcField(key: string): key is QcField {
    return ROW_FIELD_SET.has(key) || METRIC_SET.has(key);
}

/**
 * The lanes a SAVED row may be edited in — and it is exactly two things, because the
 * database offers exactly two doors into a stored draw.
 *
 * `cenapro_update_event_weight` writes `weight_kg` and nothing else;
 * `cenapro_save_analysis_sample` writes the four metrics and nothing else. There is no
 * RPC that moves a stored draw's date, source, machine, grade, shift, plant, warehouse,
 * side or bag count — so those lanes are reference-only on a stored row, exactly as the
 * live ledger renders them. They are typeable on a DRAFT, where `cenapro_add_partner_draw`
 * takes every one of them.
 */
export function storedRowFieldIsEditable(field: string): boolean {
    return field === 'wt' || isMetricField(field);
}

// ═══ ONE field, ONE verdict ═════════════════════════════════════════════════════

/** Everything a verdict needs that is not the text itself. */
export interface QcFieldEnv {
    /** The DB-read dimension lists — the same object the "Add draw" composer renders. */
    options: QcDrawOptions;
    /** What a bare `6/27` means on THIS row. */
    contextYear: number;
}

export type QcFieldVerdict = { ok: true } | { ok: false; error: string };

const OK: QcFieldVerdict = { ok: true };

/**
 * The legal machines — crushers, kilns, and the bagging token, all in one column.
 *
 * **`BAGGING_MACHINE_CODE` is here because this list is a VALIDATOR, not a menu.**
 * `parseQcField('mach', …)` runs it through `inDomain`, so a code absent from it is
 * refused BY NAME with a persistent toast — and since 2026-08-26 `FLEC` in this cell is a
 * legal row that the RPC accepts and files as a bagging entry. Leaving it out would have
 * meant the database accepting a row the sheet would not let anyone type, which is the
 * same shape of bug as a newly added grade being refused by the cell that should offer it.
 *
 * Only the ONE canonical spelling is added, matching the composer's dropdown. The other
 * four aliases (`BAG`, `BAGGING`, `FLEC BAGGING`, `FLEC_BAGGING`) are deliberately NOT
 * here: `inDomain` compares through `canonToken`, so a pasted `flec bagging` still fails
 * this cell and is refused by name rather than being silently rewritten — and a refusal
 * naming the one spelling this sheet uses is better than five synonyms in an error
 * message. `actions.ts` still accepts all five for anything that reaches it by another
 * route, which is what `BAGGING_MACHINE_CODES` is for.
 */
export function machineCodes(options: QcDrawOptions): string[] {
    return [...options.crushers, ...options.kilns, BAGGING_MACHINE_CODE];
}

/**
 * A closed-domain cell: accepted when it names one of the codes the composer offers,
 * refused by name otherwise, LISTING them.
 *
 * The comparison is `canonToken` on both sides — the same function the RPC applies
 * server-side — so `c1`, `C1` and ` c1 ` are one machine and the operator never has to
 * match a spelling exactly.
 *
 * This is a COURTESY, not the authority: `cenapro_add_partner_draw` checks every code
 * against its own dimension table and refuses an unknown one `invalid_key` in its own
 * words. What it buys is that a typo is named on the cell instead of after a round trip
 * — and it is exactly as narrow as the live composer's dropdown, which offers these
 * same lists and nothing else.
 */
function inDomain(label: string, text: string, allowed: readonly string[]): QcFieldVerdict {
    const wanted = canonToken(text);
    for (const code of allowed) if (canonToken(code) === wanted) return OK;
    const list = allowed.length > 0 ? allowed.join(', ') : 'nothing — the dimension list is empty';
    return { ok: false, error: `${label} "${text.trim()}" is not one of: ${list}.` };
}

/**
 * One cell's text → a verdict, and it is the ONLY one.
 *
 * Every `ColumnSpec.parse` calls this, and so does every save builder below, so a value
 * typed and the same value refused at save can never disagree — there is only one of
 * them.
 *
 * **A BLANK cell is legal here, in every lane.** Clearing a cell you are about to retype
 * must not raise a refusal that stays on screen until it is dismissed. What a blank
 * MEANS is decided at ROW level, where it can actually be judged: `draftBlocker` refuses
 * a new draw with no date / source / machine / grade / shift / weight, `buildQcSavePlan`
 * refuses a stored draw whose WT was emptied (`weight_kg` is NOT NULL, CHECK > 0), and a
 * blank metric genuinely means "this group says nothing about this metric" — which is
 * the sheet's own convention and how a group ends up carrying only BD.
 */
export function parseQcField(field: QcField, raw: string, env: QcFieldEnv): QcFieldVerdict {
    const text = (raw ?? '').trim();
    if (!text) return OK;

    if (isMetricField(field)) {
        const { error } = parseMetricValue(field, text);
        return error ? { ok: false, error } : OK;
    }

    switch (field) {
        case 'date':
        case 'prod': {
            const parsed = parseQcDate(text, env.contextYear);
            if ('error' in parsed) {
                return { ok: false, error: `${field === 'date' ? 'DATE' : 'PROD'} — ${parsed.error}` };
            }
            return OK;
        }

        case 'wt': {
            const { error } = parseWeightKg(text);
            return error ? { ok: false, error: `WT — ${error}` } : OK;
        }

        case 'bags': {
            // Whole flecs. A third of a bag is not a thing anyone counts, and the bound
            // stays with the RPC, which owns what a legal count is.
            const cleaned = text.replace(/[,\s_]/g, '');
            if (!/^\d+$/.test(cleaned)) {
                return { ok: false, error: `BAGS "${text}" must be a whole number of flecs.` };
            }
            return OK;
        }

        case 'src':
            return inDomain('SRC', text, env.options.sources);
        case 'mach':
            return inDomain('MACH', text, machineCodes(env.options));
        case 'grade':
            return inDomain('GRADE', text, env.options.grades);
        case 'shift':
            return inDomain('SH', text, env.options.shifts);
        case 'whse':
            return inDomain('WHSE', text, env.options.warehouses);
        case 'side':
            return inDomain('SIDE', text, env.options.sides);
        case 'plant':
            // Blank already returned OK above, and blank is what "follow SRC" is spelt
            // as — end to end, all the way to the RPC's omitted `p_plant`.
            return inDomain('PLANT', text, PLANT_CODES);
    }
}

/**
 * Canonicalise what the operator COMMITTED, before it is written.
 *
 * Applied once, inside the module's single writer, so what the operator sees from that
 * moment on is what will be sent. Two lanes have a canonical spelling the server would
 * impose anyway:
 *
 *   • **DATE / PROD** — `6/27` becomes `2026-06-27` on the way out of the cell, the
 *     contract the live QC date cells already have (they normalize on blur). Without it
 *     the sheet holds two spellings of one date and a shorthand equal to the stored
 *     value could never stop counting as dirty.
 *   • **Every closed-domain lane** — `c1` becomes `C1`, because `canonToken` is what the
 *     RPC stores. A cell that shows one spelling and stores another is a lie.
 *
 * It may NOT refuse: `parseQcField` runs immediately afterwards on whatever this
 * returns, which is what keeps unreadable text both KEPT VERBATIM and REFUSED BY NAME.
 */
export function normalizeQcField(field: QcField, text: string, env: QcFieldEnv): string {
    if (!text.trim()) return text;
    if (field === 'date' || field === 'prod') {
        const parsed = parseQcDate(text, env.contextYear);
        return 'error' in parsed ? text : parsed.iso;
    }
    if (field === 'src' || field === 'mach' || field === 'grade' || field === 'shift' ||
        field === 'whse' || field === 'side' || field === 'plant') {
        return canonToken(text);
    }
    return text;
}

/**
 * A pasted cell loses whatever rendering a spreadsheet copied in with it — and a pasted
 * DATE goes through the SAME normalisation a typed one does, with the same context year,
 * so `6/27` typed and `6/27` pasted can never land on two different years.
 */
export function cleanPastedQcCell(field: QcField, raw: string, env: QcFieldEnv): string {
    const text = (raw ?? '').replace(/\r/g, '').trim();
    if (!text) return text;
    if (field === 'wt' || field === 'bags' || isMetricField(field)) {
        // `parseWeightKg` and `parseMetricValue` do their own stripping; this only takes
        // off what a spreadsheet adds, so the raw text the operator sees stays theirs.
        return text.replace(/[₱\s]/g, '');
    }
    return normalizeQcField(field, text, env);
}

// ═══ The metric merge ═══════════════════════════════════════════════════════════

/** The unsaved-text map `useTableEdits` holds, as this module reads it. */
export type RowEditMap = Readonly<Record<string, Readonly<Record<string, string | undefined>>>>;
export type FieldEditMap = Readonly<Record<string, string | undefined>>;

export interface MetricOverlay {
    values: MetricValues;
    /** True when the edits actually moved something off the stored reading. */
    changed: boolean;
    /** Values the operator typed that are not readable readings. Named, never coerced. */
    errors: string[];
}

/**
 * The STORED reading plus whatever is unsaved — the payload the group RPC wants.
 *
 * **Every metric is carried, edited or not**, because `cenapro_save_analysis_sample`
 * REPLACES the reading: an omitted metric is cleared on the UPDATE path. Sending only
 * the metric that was typed would silently delete the other three.
 *
 * A blank edit is an explicit CLEAR (`null`), not "no opinion" — the operator emptied a
 * cell that had a number in it. Whether the *whole* reading may end up blank is a
 * row-level question, answered by `buildQcSavePlan` (the RPC refuses `no_metrics`,
 * because clearing every metric is a DELETE and this screen does not do those).
 */
export function overlayMetrics(
    stored: MetricValues | null,
    edits: Partial<Record<MetricKey, string | undefined>>,
): MetricOverlay {
    const values: MetricValues = { ...(stored ?? EMPTY_METRIC_VALUES) };
    const errors: string[] = [];
    let changed = false;

    for (const metric of METRICS) {
        const raw = edits[metric];
        if (raw === undefined) continue;
        const text = raw.trim();
        if (!text) {
            if (values[metric] !== null) {
                values[metric] = null;
                changed = true;
            }
            continue;
        }
        const { value, error } = parseMetricValue(metric, text);
        if (value === null) {
            errors.push(error ?? `${METRIC_SHORT[metric]} "${text}" could not be read.`);
            continue;
        }
        if (values[metric] !== value) {
            values[metric] = value;
            changed = true;
        }
    }

    return { values, changed, errors };
}

/** Does a reading carry anything at all? The RPC's `no_metrics` guard, client-side. */
export function hasAnyReading(values: MetricValues): boolean {
    return METRICS.some((metric) => values[metric] !== null);
}

// ═══ A draft row → the composer's own `DraftDraw` ═══════════════════════════════

const BLANK_METRICS: Record<MetricKey, string> = { bd: '', ash: '', grit: '', mc: '' };

/**
 * The table module's edit map for one blank row → the interface every draft rule in
 * `draw-entry-rows.tsx` is written against.
 *
 * The ONLY new code on the new-draw path. Everything downstream — `draftBlocker`,
 * `draftToInput`, `draftMetrics`, `isSendableDraft`, `findDraftReadingConflicts` — is
 * called verbatim, so the v2 sheet and the live composer cannot disagree about whether a
 * typed line is legal.
 *
 * `anchorDate` is `null` because the blank-row pool lives at the BOTTOM of the sheet, in
 * one run under the last day, rather than inside a day block. That is the table module's
 * draft model (`drafts` + `draftKind`), it is what RC IN and Cenapro Deliveries do, and
 * it is layout only — the field is never read by any save path.
 */
export function draftFromEdits(rowId: string, e: FieldEditMap): DraftDraw {
    const read = (key: string): string => (e[key] ?? '').trim();
    return {
        id: rowId,
        anchorDate: null,
        recvDate: read('date'),
        prodDate: read('prod'),
        shift: read('shift'),
        grade: read('grade'),
        plant: read('plant'),
        whse: read('whse'),
        side: read('side'),
        bags: read('bags'),
        src: read('src'),
        mach: read('mach'),
        wt: read('wt'),
        metrics: {
            ...BLANK_METRICS,
            bd: read('bd'),
            ash: read('ash'),
            grit: read('grit'),
            mc: read('mc'),
        },
        status: 'draft',
    };
}

// ═══ Routing — WHICH thing does this row's edits save to ════════════════════════

/** One rendered row of the sheet: a draw, its group, and whether it leads the group. */
export interface QcSaveRow {
    draw: QcDraw;
    group: QcGroup;
    isFirstOfGroup: boolean;
}

export interface RoutedEdits {
    /** Group key → the metric text typed anywhere in that group. */
    metricsByGroup: Map<string, { group: QcGroup; edits: Partial<Record<MetricKey, string>>; rowIds: string[] }>;
    /** Draw id → the raw WT text typed on that draw. */
    weightByDraw: Map<string, { row: QcSaveRow; raw: string }>;
    /** A field that reached a stored row it can never be saved from. Named, never dropped. */
    problems: string[];
}

/**
 * Split a stored row's unsaved cells by WHERE they are written.
 *
 * This is the function the two-lane model lives in, and the reason it is separate from
 * the plan builder is that it is the part with no I/O shape at all: given rows and text,
 * which RPC does each cell belong to. `scripts/verify-qc-grid.ts` asserts both directions
 * — a metric edit on a `draw-first` row patches the GROUP and not the draw, and a WT edit
 * patches only its own draw and no sibling.
 *
 * A metric edit is filed under `row.group.key` **whatever row it arrived on**. The row
 * families already make it structurally impossible for one to arrive on a non-leading
 * draw (`occupies()` returns `null` for the four metric columns there, so there is no
 * cell, no coordinate and no paste target), but routing by the group rather than by the
 * row means that guarantee is not the only thing standing between a reading and the
 * wrong sample group.
 */
export function routeQcEdits(
    edits: RowEditMap,
    dirtyRecords: Iterable<string>,
    rowsById: ReadonlyMap<string, QcSaveRow>,
): RoutedEdits {
    const metricsByGroup = new Map<string, { group: QcGroup; edits: Partial<Record<MetricKey, string>>; rowIds: string[] }>();
    const weightByDraw = new Map<string, { row: QcSaveRow; raw: string }>();
    const problems: string[] = [];

    for (const rowId of dirtyRecords) {
        const row = rowsById.get(rowId);
        // Scrolled or filtered out from under the edit between the typing and the Save.
        // Its text went with it, so there is nothing to post and nothing to warn about.
        if (!row) continue;

        const fields = edits[rowId];
        if (!fields) continue;

        for (const [field, raw] of Object.entries(fields)) {
            if (raw === undefined) continue;

            if (isMetricField(field)) {
                const bucket = metricsByGroup.get(row.group.key) ?? {
                    group: row.group,
                    edits: {} as Partial<Record<MetricKey, string>>,
                    rowIds: [],
                };
                bucket.edits[field] = raw;
                if (!bucket.rowIds.includes(rowId)) bucket.rowIds.push(rowId);
                metricsByGroup.set(row.group.key, bucket);
                continue;
            }

            if (field === 'wt') {
                weightByDraw.set(row.draw.id, { row, raw });
                continue;
            }

            // Reference-only on a stored draw — there is no RPC that moves it. Named
            // rather than silently dropped: a cell that accepted typing and then wrote
            // nothing is the worst of the three possible behaviours.
            problems.push(
                `${drawLabel(row)}: ${field.toUpperCase()} cannot be changed on a saved draw — only the weight and the group's lab reading are editable here.`,
            );
        }
    }

    return { metricsByGroup, weightByDraw, problems };
}

// ═══ The plan ═══════════════════════════════════════════════════════════════════

export interface BuildQcSaveInput {
    edits: RowEditMap;
    dirtyRecords: Iterable<string>;
    dirtyDrafts: ReadonlySet<string>;
    /** In sheet order, so refusals read down the page. */
    draftIds: readonly string[];
    rowsById: ReadonlyMap<string, QcSaveRow>;
    /** Every group on screen — the `sample_row_version` map a new draw needs. */
    groups: Iterable<QcGroup>;
    env: QcFieldEnv;
}

export interface QcSavePlan {
    /** One per touched sample GROUP, each carrying the merged four-metric reading. */
    samples: SaveQcSampleInput[];
    /** One per touched DRAW. */
    weights: SaveQcWeightInput[];
    /** One per typed blank row. */
    draws: AddQcDrawRow[];
    /** Every group the screen can see, so a new draw joining one updates rather than collides. */
    groupVersions: QcGroupVersions;
    /** Group key → the row ids whose metric text it carries, for `edits.forget`. */
    rowIdsByGroup: Record<string, string[]>;
    /** Every refusal, by name. Nothing is written unless this is empty. */
    problems: string[];
}

/**
 * Every dirty row → the three payloads, or a list of refusals.
 *
 * ONE RULE ABOVE EVERYTHING: **nothing is written unless every dirty row builds a legal
 * payload.** A batch that posted the good rows and reported the rest would leave the
 * sheet half-saved with the refusals still on screen, and the operator with no way to
 * tell which half landed. (That is about what the CLIENT sends. What comes BACK is
 * per-row and is rendered per-row — see the outcome messages below.)
 */
export function buildQcSavePlan(input: BuildQcSaveInput): QcSavePlan {
    const { edits, dirtyRecords, dirtyDrafts, draftIds, rowsById, groups, env } = input;

    const routed = routeQcEdits(edits, dirtyRecords, rowsById);
    const problems: string[] = [...routed.problems];

    // ── Sample groups ────────────────────────────────────────────────────────────
    const samples: SaveQcSampleInput[] = [];
    const rowIdsByGroup: Record<string, string[]> = {};
    for (const [key, bucket] of routed.metricsByGroup) {
        const label = groupLabel(bucket.group);
        const merged = overlayMetrics(bucket.group.sample, bucket.edits);
        if (merged.errors.length > 0) {
            for (const e of merged.errors) problems.push(`${label}: ${e}`);
            continue;
        }
        if (!merged.changed) continue; // an edit that undoes itself is not an edit
        if (!hasAnyReading(merged.values)) {
            problems.push(
                `${label}: every metric was cleared. A sample must keep at least one of BD / ASH / GRIT / MC — clearing the reading would delete it, which this screen does not do.`,
            );
            continue;
        }
        samples.push({
            key,
            sampleDate: bucket.group.date,
            sourceLocationCode: bucket.group.src,
            whseKey: bucket.group.whse,
            bd: merged.values.bd,
            ash: merged.values.ash,
            grit: merged.values.grit,
            mc: merged.values.mc,
            // Straight through: NULL creates, an integer updates against that exact
            // version. Never re-read and retry — a conflict is a human's to look at.
            expectedRowVersion: bucket.group.rowVersion,
        });
        rowIdsByGroup[key] = bucket.rowIds;
    }

    // ── Per-draw weights ─────────────────────────────────────────────────────────
    const weights: SaveQcWeightInput[] = [];
    for (const [drawId, { row, raw }] of routed.weightByDraw) {
        const { kg, error } = parseWeightKg(raw);
        if (kg === null) {
            problems.push(`${drawLabel(row)}: ${error ?? 'that weight cannot be saved.'}`);
            continue;
        }
        if (kg === row.draw.weightKg) continue; // typed back to what is stored
        weights.push({
            id: drawId,
            // Compare-and-set: the weight this operator was LOOKING AT. If the stored
            // value has moved since, the write does not happen.
            expectedWeightKg: row.draw.weightKg,
            raw,
        });
    }

    // ── Blank rows ───────────────────────────────────────────────────────────────
    const drafts: DraftDraw[] = [];
    for (const draftId of draftIds) {
        if (!dirtyDrafts.has(draftId)) continue;
        drafts.push(draftFromEdits(draftId, edits[draftId] ?? {}));
    }

    const draws: AddQcDrawRow[] = [];
    for (const draft of drafts) {
        // An untouched blank is scaffolding, not unsaved work — `dirtyDrafts` already
        // excludes one, and this is the composer's own second opinion.
        if (!isMeaningfulDraft(draft)) continue;
        const blocker = draftBlocker(draft, env.contextYear);
        if (blocker) {
            problems.push(`${draftRowLabel(draft)}: ${blocker}.`);
            continue;
        }
        if (!isSendableDraft(draft, env.contextYear)) continue;
        draws.push({
            rowId: draft.id,
            input: draftToInput(draft, env.contextYear),
            // The lab cells, if any. The SERVER applies them to whichever sample group
            // the insert actually reports — never to a key derived here.
            metrics: draftMetrics(draft),
        });
    }

    // Two typed rows landing in ONE sample group and disagreeing about a metric. A
    // reading covers the whole group, so there is no answer a machine may pick — the
    // composer's own check, run over the same drafts, refusing before anything leaves.
    for (const conflict of findDraftReadingConflicts(drafts, env.contextYear)) {
        problems.push(
            `${conflict.rowIds.length} new draws land in the sample group ${conflict.label} but give ` +
                `${METRIC_SHORT[conflict.metric]} as ${conflict.values.join(' and ')}. A reading covers the ` +
                `whole group, so make the numbers match or leave it on one row.`,
        );
    }

    const groupVersions: QcGroupVersions = {};
    for (const group of groups) groupVersions[group.key] = group.rowVersion;

    return { samples, weights, draws, groupVersions, rowIdsByGroup, problems };
}

// ═══ Which rows may be FORGOTTEN once the verdicts are in ═══════════════════════

export interface ForgetInput {
    edits: RowEditMap;
    dirtyRecords: Iterable<string>;
    rowsById: ReadonlyMap<string, QcSaveRow>;
    /** Groups the plan actually POSTED — a group whose edits changed nothing is absent. */
    sentGroupKeys: ReadonlySet<string>;
    savedGroupKeys: ReadonlySet<string>;
    /** Draws the plan actually POSTED. */
    sentDrawIds: ReadonlySet<string>;
    savedDrawIds: ReadonlySet<string>;
}

/**
 * The stored rows whose unsaved text may be dropped — and this is finer than it looks.
 *
 * `TableEdits.forget` works on WHOLE ROWS, and one QC row can carry two changes that go
 * to two different RPCs with two independent verdicts: a group reading and its own
 * weight. So forgetting a row because "its group saved" would throw away a WT edit that
 * came back `conflict` — the operator's typing gone, silently, on a save that reported
 * a failure they now cannot act on.
 *
 * A row is therefore forgettable only when EVERY field on it is settled, where settled
 * means either *the payload it belongs to landed* or *no payload was built for it at
 * all*. The second half matters: a metric retyped to the same number in a different
 * spelling (`12.50` over a stored `12.5`) is still an edit as far as the edit map is
 * concerned but produces nothing to write, and without this clause its row could never
 * stop counting as unsaved.
 */
export function forgettableRowIds(input: ForgetInput): string[] {
    const { edits, dirtyRecords, rowsById, sentGroupKeys, savedGroupKeys, sentDrawIds, savedDrawIds } = input;
    const out: string[] = [];

    for (const rowId of dirtyRecords) {
        const row = rowsById.get(rowId);
        if (!row) continue;
        const fields = edits[rowId];
        if (!fields) continue;

        let settled = true;
        for (const [field, raw] of Object.entries(fields)) {
            if (raw === undefined) continue;
            if (isMetricField(field)) {
                const key = row.group.key;
                if (sentGroupKeys.has(key) && !savedGroupKeys.has(key)) settled = false;
            } else if (field === 'wt') {
                const id = row.draw.id;
                if (sentDrawIds.has(id) && !savedDrawIds.has(id)) settled = false;
            } else {
                // A lane with no write path — the save refused the whole batch before
                // reaching here, so this is unreachable. Keeping the text is the safe
                // answer to an unreachable branch.
                settled = false;
            }
            if (!settled) break;
        }
        if (settled) out.push(rowId);
    }

    return out;
}

// ═══ Unsaved work, in this sheet's own nouns ════════════════════════════════════

export interface QcUnsavedWork {
    /** Sample GROUPS carrying unsaved metric text — not rows, because a reading is a group. */
    readings: number;
    /** Draws carrying unsaved WT text. */
    weights: number;
    /** Blank rows the operator has typed something real into. */
    draws: number;
    total: number;
}

/**
 * What is unsaved, counted the way it will be SAVED.
 *
 * The platform's `countUnsavedWork` splits a sheet two ways — stored records and drafts —
 * and this sheet is genuinely three, because one stored row can carry two kinds of change
 * that go to two different RPCs. Counting rows would also over-count: four metric cells
 * typed across the same group's four draws is ONE reading and one save, not four.
 */
export function countQcUnsaved(
    edits: RowEditMap,
    dirtyRecords: Iterable<string>,
    dirtyDrafts: ReadonlySet<string>,
    rowsById: ReadonlyMap<string, QcSaveRow>,
): QcUnsavedWork {
    const routed = routeQcEdits(edits, dirtyRecords, rowsById);
    const readings = routed.metricsByGroup.size;
    const weights = routed.weightByDraw.size;
    const draws = dirtyDrafts.size;
    return { readings, weights, draws, total: readings + weights + draws };
}

/** `2 edited readings and 1 edited weight` — and never a kind that is zero. */
export function describeQcUnsaved(work: QcUnsavedWork): string {
    const parts: string[] = [];
    if (work.readings > 0) parts.push(`${work.readings} edited reading${work.readings === 1 ? '' : 's'}`);
    if (work.weights > 0) parts.push(`${work.weights} edited weight${work.weights === 1 ? '' : 's'}`);
    if (work.draws > 0) parts.push(`${work.draws} new draw${work.draws === 1 ? '' : 's'}`);
    if (parts.length === 0) return 'nothing unsaved';
    if (parts.length === 1) return parts[0];
    return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

// ═══ Naming a row in an error ═══════════════════════════════════════════════════

/** How a sample group is named in a refusal — enough to find it in the sheet. */
export function groupLabel(group: QcGroup): string {
    return `${group.date} · ${group.src} · ${group.whse}`;
}

/** A weight belongs to one DRAW, so its label names the draw, not just the group. */
export function drawLabel(row: QcSaveRow): string {
    return `${groupLabel(row.group)} · ${row.draw.equip ?? 'draw'}`;
}

/** How a blank row is named, before it has an identity of its own. */
export function draftRowLabel(draft: DraftDraw): string {
    return newDrawLabel(draft.recvDate, draft.src, draft.mach);
}

/**
 * The same label, off the payload that was actually SENT.
 *
 * The verdict for a new draw comes back keyed by the client row id and nothing else, and
 * by then the `DraftDraw` that produced it is two functions upstream. Labelling from the
 * plan's own `AddQcDrawInput` keeps the sentence identical to the one a pre-flight
 * refusal would have printed, with no second shape to keep in step.
 */
export function drawInputLabel(input: {
    recvDate: string;
    sourceLocationCode: string;
    partnerEquipmentCode: string;
}): string {
    return newDrawLabel(input.recvDate, input.sourceLocationCode, input.partnerEquipmentCode);
}

function newDrawLabel(date: string, src: string, mach: string): string {
    const d = (date ?? '').trim() || 'undated';
    const s = (src ?? '').trim() || 'no source';
    const m = (mach ?? '').trim();
    return `new draw ${d} · ${s}${m ? ` · ${m}` : ''}`;
}

// ═══ What the server said ═══════════════════════════════════════════════════════
//
// All THREE actions answer PER ROW — `saveQcSamples` one verdict per group,
// `saveQcWeights` one per draw, `addQcDraws` one per typed row (plus a second one for
// the reading typed beside it). Nothing here is all-or-nothing on the way back, and the
// grid says exactly which rows landed and which refused rather than pretending either
// way. Each RPC carries its own compare-and-set, so a conflict on one row genuinely
// leaves the others written.

/** One group's refusal, in a sentence — the live ledger's own wording, verbatim. */
export function qcSampleFailureMessage(
    outcome: SaveQcSampleResult['outcome'],
    message: string | null,
): string {
    switch (outcome) {
        case 'version_conflict':
            return 'Someone else changed this sample while you were editing, so nothing was written. Reload to see their values.';
        case 'already_exists':
            return 'A sample was logged for this group while you were typing. Reload, then edit the value that is now stored.';
        case 'not_found':
            return 'That sample was deleted while you were editing. Reload the ledger.';
        case 'no_metrics':
            return 'Every metric was cleared. A sample must keep at least one of BD / ASH / GRIT / MC.';
        case 'invalid_key':
            return detailed('The database could not identify this sample group.', message);
        default:
            return detailed('The database refused the reading.', message);
    }
}

/** One draw's weight refusal, in a sentence. */
export function qcWeightFailureMessage(
    outcome: SaveQcWeightResult['outcome'],
    message: string | null,
): string {
    switch (outcome) {
        case 'conflict':
            return detailed(
                'This weight changed while you were editing, so nothing was written. Reload to see the value that is now stored.',
                message,
            );
        case 'not_found':
            return 'That receipt row was deleted while you were editing. Reload the ledger.';
        case 'invalid':
            return detailed('That weight cannot be saved.', message);
        default:
            return detailed('The database refused the weight.', message);
    }
}

/**
 * One new draw's refusal.
 *
 * `duplicate_warning` is deliberately NOT re-worded: it is the RPC listing the draws
 * already on file under the same key, and only the operator knows whether the slip lists
 * two trips or they keyed one twice. The live ledger answers it by re-sending that row
 * with `allowDuplicate`; this grid stops and says so, because a confirm affordance is a
 * separate pass and inventing a silent one would file a receipt twice.
 */
export function qcDrawFailureMessage(
    outcome: AddQcDrawResult['outcome'],
    message: string | null | undefined,
): string {
    switch (outcome) {
        case 'duplicate_warning':
            return detailed(
                'A draw matching this one is already on file, so nothing was written. Check the slip: if it really is a second trip, log it from the classic ledger, which can confirm a duplicate.',
                message ?? null,
            );
        case 'already_exists':
            return detailed('That draw is already in the database.', message ?? null);
        case 'wrong_surface':
            return detailed('That row belongs on a different sheet.', message ?? null);
        case 'unsupported_source':
            return detailed('That source cannot be entered here.', message ?? null);
        default:
            return detailed('The database refused the draw.', message ?? null);
    }
}

/**
 * The database's own sentence is always APPENDED, never replaced: it names the row, the
 * version or the constraint, and swallowing it would leave the operator with a sentence
 * and no evidence behind it.
 */
function detailed(head: string, message: string | null): string {
    const detail = (message ?? '').trim();
    return detail ? `${head} ${detail}` : head;
}
