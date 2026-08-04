'use server';

// ─────────────────────────────────────────────────────────────────────────────────
// QC analysis — the WRITE path (`/cenapro/qc`).
//
// The client never touches Supabase. It hands over one payload per SAMPLE GROUP and
// this module calls `public.cenapro_save_analysis_sample` once per group, threading
// that group's own `sample_row_version` through unchanged:
//
//   rowVersion === null  → INSERT. A losing race returns `already_exists`, never a
//                          clobber.
//   rowVersion === <int> → UPDATE, conditional on the version IN THE SAME STATEMENT
//                          as the write. A mismatch returns `version_conflict` plus
//                          the CURRENT version.
//
// Nothing here retries, force-writes, or "helpfully" re-reads the version and tries
// again — a conflict means a human changed the same reading and a human has to look
// at it. Every outcome is reported back verbatim for the UI to surface.
// ─────────────────────────────────────────────────────────────────────────────────

import { revalidatePath } from 'next/cache';

import { createClient } from '@/lib/supabase/server';
import {
    METRICS,
    METRIC_SHORT,
    isIsoDate,
    parseMetricValue,
    parseWeightKg,
    sampleGroupKey,
    type AddPartnerDrawArgs,
    type AddPartnerDrawOutcome,
    type AddPartnerDrawResult,
    type BatchResolution,
    type ExistingDraw,
    type MetricKey,
    type SaveSampleArgs,
    type SaveSampleOutcome,
    type UpdateWeightOutcome,
} from '@/lib/cenapro/ccc-analysis';

/** One sample group's save request. Mirrors the RPC's natural key + payload. */
export interface SaveQcSampleInput {
    /** `date|SRC|WHSE` — echoed back on the result so the client can match them up. */
    key: string;
    sampleDate: string;
    sourceLocationCode: string;
    whseKey: string;
    bd: number | null;
    ash: number | null;
    grit: number | null;
    mc: number | null;
    /** The group's `sample_row_version`. `null` = create. */
    expectedRowVersion: number | null;
}

export interface SaveQcSampleResult {
    key: string;
    ok: boolean;
    outcome: SaveSampleOutcome | 'rpc_error';
    rowVersion: number | null;
    message: string | null;
}

export interface SaveQcSamplesResult {
    results: SaveQcSampleResult[];
    savedCount: number;
    failedCount: number;
}

/** The RPC's jsonb return, before we trust any of it. */
interface RawSaveResult {
    ok?: unknown;
    outcome?: unknown;
    id?: unknown;
    row_version?: unknown;
    message?: unknown;
}

const OUTCOMES: readonly SaveSampleOutcome[] = [
    'inserted',
    'updated',
    'already_exists',
    'version_conflict',
    'not_found',
    'no_metrics',
    'invalid_key',
];

function readOutcome(value: unknown): SaveSampleOutcome | 'rpc_error' {
    return OUTCOMES.includes(value as SaveSampleOutcome)
        ? (value as SaveSampleOutcome)
        : 'rpc_error';
}

/**
 * Build the RPC argument object.
 *
 * A null metric is OMITTED rather than sent as `null`: every metric parameter is
 * `DEFAULT NULL`, so omitting one clears it on the UPDATE path exactly as an explicit
 * null would, and the generated `Args` type declares them as plain `number` (they
 * carry SQL defaults), so an explicit null would not type-check.
 */
function buildArgs(input: SaveQcSampleInput): SaveSampleArgs {
    const args: SaveSampleArgs = {
        p_sample_date: input.sampleDate,
        p_source_location_code: input.sourceLocationCode,
        p_whse_key: input.whseKey,
    };
    if (input.bd != null && Number.isFinite(input.bd)) args.p_bd = input.bd;
    if (input.ash != null && Number.isFinite(input.ash)) args.p_ash = input.ash;
    if (input.grit != null && Number.isFinite(input.grit)) args.p_grit = input.grit;
    if (input.mc != null && Number.isFinite(input.mc)) args.p_mc = input.mc;
    if (input.expectedRowVersion != null) args.p_expected_row_version = input.expectedRowVersion;
    return args;
}

/**
 * Save one or more sample groups. Each is an independent RPC call with its own
 * optimistic-concurrency check, so a conflict on one group never blocks the others —
 * the caller gets a per-group verdict and decides what to keep on screen.
 */
/**
 * ONE sample group's RPC round trip, extracted so the "add a draw, then apply its
 * reading" path (`addQcDraws`) and the "edit a saved row's reading" path
 * (`saveQcSamples`) cannot drift into two different write behaviours. The Supabase
 * client is passed in so a batch shares one.
 */
async function writeSampleGroup(
    supabase: Awaited<ReturnType<typeof createClient>>,
    input: SaveQcSampleInput,
): Promise<SaveQcSampleResult> {
    // Cheap client-side guard's server twin: the RPC rejects an all-null sample
    // (`no_metrics`), so never spend a round trip discovering that.
    if (METRICS.every((metric) => input[metric] == null)) {
        return {
            key: input.key,
            ok: false,
            outcome: 'no_metrics',
            rowVersion: input.expectedRowVersion,
            message:
                'A sample must carry at least one of BD / ASH / GRIT / MC. Clearing every metric would delete the reading, which this screen does not do.',
        };
    }

    const { data, error } = await supabase.rpc('cenapro_save_analysis_sample', buildArgs(input));

    if (error) {
        return {
            key: input.key,
            ok: false,
            outcome: 'rpc_error',
            rowVersion: null,
            message: error.message,
        };
    }

    const raw = (data ?? {}) as RawSaveResult;
    return {
        key: input.key,
        ok: raw.ok === true,
        outcome: readOutcome(raw.outcome),
        rowVersion: typeof raw.row_version === 'number' ? raw.row_version : null,
        message: typeof raw.message === 'string' ? raw.message : null,
    };
}

export async function saveQcSamples(inputs: SaveQcSampleInput[]): Promise<SaveQcSamplesResult> {
    if (inputs.length === 0) return { results: [], savedCount: 0, failedCount: 0 };

    const supabase = await createClient();
    const results: SaveQcSampleResult[] = [];

    for (const input of inputs) {
        results.push(await writeSampleGroup(supabase, input));
    }

    const savedCount = results.filter((r) => r.ok).length;

    // Both QC surfaces read the same aggregates, so both go stale on any write.
    if (savedCount > 0) {
        revalidatePath('/cenapro/qc');
        revalidatePath('/cenapro/qc/breakdown');
    }

    return { results, savedCount, failedCount: results.length - savedCount };
}

// ─────────────────────────────────────────────────────────────────────────────────
// Weight edits — one DRAW's `weight_kg` on `cenapro.production_event`.
//
// This is the QOL half of the ledger: a receipt weight is a number an operator
// mistypes, notices HERE (staring at the day's total), and today has to leave for
// the production ledger to fix. Same authority as that grid already grants; a more
// convenient place to exercise it.
//
// Two things make it safe to move here rather than merely handy:
//
//  1. COMPARE-AND-SET. Each call carries the weight the operator was looking at, and
//     `public.cenapro_update_event_weight` only writes while the stored value still
//     equals it — checked in the same statement as the UPDATE. A losing race gets
//     `conflict` and the CURRENT value; nothing retries, nothing force-writes.
//  2. AN AUDIT TRAIL. `cenapro.production_event` had none until now. The trigger
//     `tr_cenapro_pe_audit` records every change (old → new, actor, surface) in
//     `cenapro.production_event_audit` — on this path AND on the production grid's.
//
// A weight is PER-DRAW, so unlike a lab sample it never fans out to the group's
// sibling rows. One request per draw, one independent verdict per draw.
// ─────────────────────────────────────────────────────────────────────────────────

/** One draw's weight change. `expectedWeightKg` is what the operator saw. */
export interface SaveQcWeightInput {
    /** `cenapro.production_event.id` — echoed back so the client can match up. */
    id: string;
    /** The weight rendered in the cell before it was retyped. */
    expectedWeightKg: number;
    /** The raw text typed into the cell. Parsed and validated server-side too. */
    raw: string;
}

export interface SaveQcWeightResult {
    id: string;
    ok: boolean;
    outcome: UpdateWeightOutcome | 'rpc_error';
    /** On success the new value; on `conflict` the CURRENT stored one. */
    weightKg: number | null;
    message: string | null;
}

export interface SaveQcWeightsResult {
    results: SaveQcWeightResult[];
    savedCount: number;
    failedCount: number;
}

interface RawWeightResult {
    ok?: unknown;
    outcome?: unknown;
    weight_kg?: unknown;
    message?: unknown;
}

const WEIGHT_OUTCOMES: readonly UpdateWeightOutcome[] = [
    'updated',
    'conflict',
    'not_found',
    'invalid',
];

function readWeightOutcome(value: unknown): UpdateWeightOutcome | 'rpc_error' {
    return WEIGHT_OUTCOMES.includes(value as UpdateWeightOutcome)
        ? (value as UpdateWeightOutcome)
        : 'rpc_error';
}

/**
 * Apply one or more per-draw weight corrections. Each is an independent RPC call
 * with its own compare-and-set, so a conflict on one draw never blocks the others.
 */
export async function saveQcWeights(
    inputs: SaveQcWeightInput[],
): Promise<SaveQcWeightsResult> {
    if (inputs.length === 0) return { results: [], savedCount: 0, failedCount: 0 };

    const supabase = await createClient();
    const results: SaveQcWeightResult[] = [];

    for (const input of inputs) {
        // The client's guard's server twin — same `parseWeightKg`, so the two can
        // never disagree, and a value the RPC would reject costs no round trip.
        const { kg, error: parseError } = parseWeightKg(input.raw);
        if (kg == null) {
            results.push({
                id: input.id,
                ok: false,
                outcome: 'invalid',
                weightKg: null,
                message: parseError,
            });
            continue;
        }

        const { data, error } = await supabase.rpc('cenapro_update_event_weight', {
            p_event_id: input.id,
            p_expected_weight_kg: input.expectedWeightKg,
            p_weight_kg: kg,
        });

        if (error) {
            results.push({
                id: input.id,
                ok: false,
                outcome: 'rpc_error',
                weightKg: null,
                message: error.message,
            });
            continue;
        }

        const raw = (data ?? {}) as RawWeightResult;
        results.push({
            id: input.id,
            ok: raw.ok === true,
            outcome: readWeightOutcome(raw.outcome),
            weightKg: typeof raw.weight_kg === 'number' ? raw.weight_kg : null,
            message: typeof raw.message === 'string' ? raw.message : null,
        });
    }

    const savedCount = results.filter((r) => r.ok).length;

    if (savedCount > 0) {
        // A weight moves the QC aggregates AND the production ledger that shows the
        // same row, so all three surfaces go stale.
        revalidatePath('/cenapro/qc');
        revalidatePath('/cenapro/qc/breakdown');
        revalidatePath('/cenapro/production');
    }

    return { results, savedCount, failedCount: results.length - savedCount };
}

// ─────────────────────────────────────────────────────────────────────────────────
// Adding a partner draw — ONE new row on `cenapro.production_event`.
//
// The partner hands over a slip of paper listing what it pulled that day; this is the
// path that logs a line of it. PARTNER DRAWS ONLY: what CI puts INTO inventory (flec
// bagging) is a different document and is entered in the Production ledger. The
// boundary is the RPC's, not this module's — `cenapro_add_partner_draw` refuses a
// bagging row by name, so a hand-rolled caller cannot cross it either.
//
// Everything derived is derived SERVER-SIDE and nothing here re-derives it:
// `disposition_kind` comes from the machine, `plant_code` from the source, and `batch`
// from whichever label was actually running at `recv_date` (JULY starts 2026-06-27 —
// it is not the calendar month). The verdict carries all three back so the UI can say
// where the row landed instead of guessing.
//
// The pre-flight below only re-states rules this file can be CERTAIN of — required
// fields, `parseWeightKg` (literally the RPC's shared JS twin), the source-conditional
// bag fields. It exists to spend no round trip on a typo, never to be the authority:
// anything it lets through is judged by the RPC, and the RPC's `message` is what the
// operator reads.
// ─────────────────────────────────────────────────────────────────────────────────

/** One line of the partner's slip, as typed. Raw text in, parsing done here. */
export interface AddQcDrawInput {
    /** `YYYY-MM-DD` — the receipt date at CCC. */
    recvDate: string;
    /** TNK 1–4 · W6 · W7 · FLEC. DVO is refused by the RPC (`unsupported_source`). */
    sourceLocationCode: string;
    /** C1–C4 (crusher) or RK1–RK4 (kiln). This ALONE decides the disposition. */
    partnerEquipmentCode: string;
    gradeCode: string;
    shiftCode: string;
    /** The raw text typed into the weight field. Parsed with the shared helper. */
    weightRaw: string;
    /**
     * The PLANT the operator OVERRODE the derivation with (2026-08-04, `p_plant`).
     *
     * Blank / absent = follow the source, byte-for-byte as before — so a derived value
     * is never echoed back as a supplied one. A real `cenapro.plant` code is accepted
     * even when it contradicts the source (the partner's slip is allowed to know
     * better) and comes back with `plant_source: 'supplied'` plus a non-blocking
     * `plant_notice`; anything else is refused `invalid_key` by the RPC, in its words.
     */
    plant?: string | null;
    prodDate?: string | null;
    /** FLEC source ONLY — required there, refused anywhere else. */
    warehouseCode?: string | null;
    /** FLEC source ONLY — required there, refused anywhere else. Whole bags. */
    flecCountRaw?: string | null;
    /** FLEC source only, and optional there — but see the `notice` on the verdict. */
    whseSide?: string | null;
    notes?: string | null;
    /** Only ever true on the operator's explicit re-send after a `duplicate_warning`. */
    allowDuplicate?: boolean;
}

export type AddQcDrawOutcome = AddPartnerDrawOutcome | 'rpc_error';

/** The RPC's verdict, narrowed and made safe to read. */
export interface AddQcDrawResult extends Omit<AddPartnerDrawResult, 'outcome'> {
    outcome: AddQcDrawOutcome;
}

const ADD_OUTCOMES: readonly AddPartnerDrawOutcome[] = [
    'inserted',
    'duplicate_warning',
    'already_exists',
    'wrong_surface',
    'unsupported_source',
    'invalid_key',
    'invalid',
];

const BATCH_RESOLUTIONS: readonly BatchResolution[] = ['explicit', 'running', 'calendar'];

const PLANT_SOURCES: readonly NonNullable<AddPartnerDrawResult['plant_source']>[] = [
    'derived',
    'supplied',
];

/** Where the stored plant came from — narrowed, so an unexpected string is dropped. */
function readPlantSource(value: unknown): AddPartnerDrawResult['plant_source'] {
    return PLANT_SOURCES.includes(value as NonNullable<AddPartnerDrawResult['plant_source']>)
        ? (value as NonNullable<AddPartnerDrawResult['plant_source']>)
        : undefined;
}

function readAddOutcome(value: unknown): AddQcDrawOutcome {
    return ADD_OUTCOMES.includes(value as AddPartnerDrawOutcome)
        ? (value as AddPartnerDrawOutcome)
        : 'rpc_error';
}

function str(value: unknown): string | undefined {
    return typeof value === 'string' ? value : undefined;
}

function num(value: unknown): number | undefined {
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** The `duplicate_warning` list — the draws already on file under the same key. */
function readExisting(value: unknown): ExistingDraw[] | undefined {
    if (!Array.isArray(value)) return undefined;
    const rows: ExistingDraw[] = [];
    for (const item of value) {
        if (!item || typeof item !== 'object') continue;
        const row = item as Record<string, unknown>;
        const id = str(row.id);
        if (!id) continue;
        rows.push({
            id,
            weight_kg: num(row.weight_kg) ?? 0,
            prod_date: str(row.prod_date) ?? null,
            warehouse_code: str(row.warehouse_code) ?? null,
            whse_side: str(row.whse_side) ?? null,
            batch: str(row.batch) ?? '',
        });
    }
    return rows;
}

/** The exact `cenapro_ccc_sample_groups` key the new row joined. Never re-derived. */
function readSampleGroup(value: unknown): AddPartnerDrawResult['sample_group'] {
    if (!value || typeof value !== 'object') return undefined;
    const group = value as Record<string, unknown>;
    const sampleDate = str(group.sample_date);
    const source = str(group.source_location_code);
    const whse = str(group.whse_key);
    if (!sampleDate || !source || whse === undefined) return undefined;
    return { sample_date: sampleDate, source_location_code: source, whse_key: whse };
}

/** A refusal decided here, worded the way the RPC words its own. */
function refuse(outcome: AddQcDrawOutcome, message: string): AddQcDrawResult {
    return { ok: false, outcome, message };
}

/**
 * The bag count on a FLEC draw. Whole bags — a third of a flec is not a thing anyone
 * counts — but the bound stays with the RPC, which owns what a legal count is.
 */
function parseFlecCount(raw: string): { count: number | null; error: string | null } {
    const cleaned = raw.replace(/[,\s_]/g, '');
    if (cleaned === '') {
        return { count: null, error: 'A FLEC draw takes bags out of a warehouse — enter how many.' };
    }
    if (!/^\d+$/.test(cleaned)) {
        return { count: null, error: 'The bag count must be a whole number of flecs.' };
    }
    return { count: Number(cleaned), error: null };
}

const BAGGING_CODES = new Set(['FLEC', 'BAG', 'BAGGING', 'FLEC_BAGGING']);

function clean(value: string | null | undefined): string {
    return (value ?? '').trim();
}

/**
 * Add one partner draw.
 *
 * Returns the RPC's verdict rather than throwing on a refusal: four of the seven
 * outcomes are things the operator can act on (confirm a duplicate, open the row that
 * already exists, go to the Production ledger, retype a value), and a thrown error
 * would flatten all of them into "it failed".
 */
export async function addPartnerDraw(input: AddQcDrawInput): Promise<AddQcDrawResult> {
    const recvDate = clean(input.recvDate);
    const source = clean(input.sourceLocationCode).toUpperCase();
    const machine = clean(input.partnerEquipmentCode).toUpperCase();
    const grade = clean(input.gradeCode).toUpperCase();
    const shift = clean(input.shiftCode).toUpperCase();
    // Deliberately NOT validated here. The RPC owns the list of real plants and refuses
    // an unknown one by name, listing the valid codes and what the source would have
    // given — a sentence this module could only ever paraphrase worse. Blank is not a
    // refusal at all: it means "follow the source", so it is simply not sent.
    const plant = clean(input.plant).toUpperCase();
    const prodDate = clean(input.prodDate);
    const warehouse = clean(input.warehouseCode).toUpperCase();
    const flecCountRaw = clean(input.flecCountRaw);
    const side = clean(input.whseSide).toUpperCase();
    const notes = clean(input.notes);

    // ── The surface boundary, restated where it is cheapest to notice ─────────────
    if (!machine || BAGGING_CODES.has(machine)) {
        return refuse(
            'wrong_surface',
            'A draw needs the partner machine it went into (C1–C4 or RK1–RK4). Flec bagging is reported on a different sheet — enter it in the Production ledger.',
        );
    }

    const missing = [
        !recvDate && 'a receipt date',
        !source && 'a source',
        !grade && 'a grade',
        !shift && 'a shift',
    ].filter(Boolean) as string[];
    if (missing.length > 0) {
        return refuse('invalid_key', `This draw is missing ${missing.join(', ')}.`);
    }

    // ── The dates arrive already normalized, and this is where that is checked ────
    // The QC date cells are FREE TEXT that becomes `yyyy-MM-dd` when you leave them, so
    // by the time a row is sent it is ISO. If it is not — a row saved from a focused
    // cell whose text never parsed, or any caller that is not this screen — the RPC's
    // `date` cast would fail with a Postgres message about a column the operator never
    // named. Refuse it here instead, in this module's own voice. Deliberately NOT
    // "helpfully" parsed: only the client knows which year a bare `6/27` means, and
    // guessing one here is exactly the silent wrong write this ledger must not make.
    if (!isIsoDate(recvDate)) {
        return refuse(
            'invalid_key',
            `"${recvDate}" is not a receipt date. Dates are written as yyyy-MM-dd — retype the date cell and tab out of it.`,
        );
    }
    if (prodDate && !isIsoDate(prodDate)) {
        return refuse(
            'invalid',
            `"${prodDate}" is not a production date. Dates are written as yyyy-MM-dd — retype the date cell and tab out of it, or clear it.`,
        );
    }

    // ── The weight, through the same parser the client previewed with ─────────────
    const { kg, error: weightError } = parseWeightKg(input.weightRaw ?? '');
    if (kg == null) return refuse('invalid', weightError ?? 'That weight cannot be saved.');

    if (prodDate && prodDate > recvDate) {
        return refuse(
            'invalid',
            'The production date cannot be after the receipt date — material is drawn after it is made.',
        );
    }

    // ── Source-conditional bag fields ─────────────────────────────────────────────
    // A FLEC draw is bags leaving a warehouse, so the warehouse and the count are part
    // of what happened. Any other source consumes no bags at all, and the RPC refuses
    // the fields by name rather than dropping them quietly — so neither does this.
    const isFlec = source === 'FLEC';
    let flecCount: number | null = null;

    if (isFlec) {
        if (!warehouse) {
            return refuse(
                'invalid',
                'A FLEC draw takes bags out of a specific warehouse — choose which one.',
            );
        }
        const parsed = parseFlecCount(flecCountRaw);
        if (parsed.count == null) return refuse('invalid', parsed.error ?? 'The bag count is missing.');
        flecCount = parsed.count;
    } else if (warehouse || flecCountRaw || side) {
        return refuse(
            'invalid',
            `A ${source} draw consumes no bags, so it carries no warehouse, bag count or side. Clear those, or change the source to FLEC.`,
        );
    }

    const args: AddPartnerDrawArgs = {
        p_recv_date: recvDate,
        p_source_location_code: source,
        p_partner_equipment_code: machine,
        p_grade_code: grade,
        p_shift_code: shift,
        p_weight_kg: kg,
    };
    // Every optional argument is OMITTED when it does not apply — an explicit null on a
    // bag field is a value the RPC would (rightly) refuse on a tank draw. `p_plant`
    // follows the same idiom for a different reason: omitted, null and blank all mean
    // "derive from the source", and omitting is the form every pre-2026-08-04 call site
    // already used, so the derive path stays byte-for-byte the one that was proven live.
    if (plant) args.p_plant = plant;
    if (prodDate) args.p_prod_date = prodDate;
    if (isFlec) {
        args.p_warehouse_code = warehouse;
        if (flecCount != null) args.p_flec_count = flecCount;
        if (side) args.p_whse_side = side;
    }
    if (notes) args.p_notes = notes;
    if (input.allowDuplicate) args.p_allow_duplicate = true;

    const supabase = await createClient();
    const { data, error } = await supabase.rpc('cenapro_add_partner_draw', args);

    if (error) {
        return { ok: false, outcome: 'rpc_error', message: error.message };
    }

    const raw = (data ?? {}) as Record<string, unknown>;
    const outcome = readAddOutcome(raw.outcome);
    const batchResolution = BATCH_RESOLUTIONS.includes(raw.batch_resolution as BatchResolution)
        ? (raw.batch_resolution as BatchResolution)
        : undefined;
    const disposition = raw.disposition_kind;

    const result: AddQcDrawResult = {
        ok: raw.ok === true,
        outcome,
        id: str(raw.id),
        message: str(raw.message),
        unique_tag: str(raw.unique_tag),
        batch: str(raw.batch),
        batch_year: num(raw.batch_year),
        batch_resolution: batchResolution,
        // `plant_code` keeps its key and now carries the EFFECTIVE value — typed when
        // one was supplied and accepted, derived otherwise. The three keys beside it say
        // which, what the source alone would have given, and (only on a real
        // disagreement) a non-blocking sentence naming both.
        plant_code: str(raw.plant_code) ?? null,
        plant_source: readPlantSource(raw.plant_source),
        plant_derived: str(raw.plant_derived) ?? null,
        plant_notice: str(raw.plant_notice) ?? null,
        disposition_kind:
            disposition === 'partner_crusher' || disposition === 'partner_kiln'
                ? disposition
                : undefined,
        sample_group: readSampleGroup(raw.sample_group),
        notice: str(raw.notice) ?? null,
        existing: readExisting(raw.existing),
        weight_kg: num(raw.weight_kg),
    };

    if (result.ok && outcome === 'inserted') {
        // A new receipt moves the QC aggregates, the breakdown that reads the same
        // views, and the production ledger that renders the very same row.
        revalidatePath('/cenapro/qc');
        revalidatePath('/cenapro/qc/breakdown');
        revalidatePath('/cenapro/production');
    }

    return result;
}

// ─────────────────────────────────────────────────────────────────────────────────
// Typed rows → draws, and then their readings (2026-08-04, second pass).
//
// A lab reading belongs to a sample GROUP, and until a draw is saved that group may not
// exist. That is why BD/ASH/GRIT/MC were inert on a draft row. They are typable now, and
// the sequencing that makes them safe lives HERE rather than in the browser:
//
//   1. every row's draw is inserted, sequentially (see `addQcDraws` below);
//   2. each successful insert reports the sample group it landed in — `sample_group` on
//      the RPC's own verdict, computed by the same `coalesce(warehouse_code, plant_code)`
//      the view groups by. Nothing re-derives it;
//   3. the rows that carried a reading are bucketed by THAT key, and each bucket gets
//      ONE `cenapro_save_analysis_sample` call.
//
// Step 3 is where two rows can disagree. Two draws from the same source and warehouse on
// the same day are one sample group by definition, so two typed readings for them must
// agree; if they do not, no machine can pick. The bucket is refused, named, and NOTHING
// is written for it — the draws themselves stay (they are real receipts and not in
// dispute), and the operator types the reading once on the saved row.
//
// A union is not a conflict: one row giving BD and another giving MC is how a slip that
// splits its analysis across lines is meant to read, and the two merge.
// ─────────────────────────────────────────────────────────────────────────────────

/** What happened to the reading typed on a row, once its draw was in. */
export interface AddQcReadingResult {
    ok: boolean;
    outcome: SaveSampleOutcome | 'rpc_error' | 'reading_conflict' | 'skipped';
    /** The sample group the reading was aimed at — the RPC's own key, never re-derived. */
    groupKey: string | null;
    message: string | null;
}

/** One typed row's verdict, carried back with the row it belongs to. */
export interface AddQcDrawRowResult {
    /** The client's own row id — the ONLY way to put a verdict back on the right row. */
    rowId: string;
    result: AddQcDrawResult;
    /** Present only when the row carried BD/ASH/GRIT/MC. */
    reading?: AddQcReadingResult;
}

/** One typed row on its way in: the draw, plus whatever was typed in the lab cells. */
export interface AddQcDrawRow {
    rowId: string;
    input: AddQcDrawInput;
    /** Raw metric text, blanks already dropped. Omitted when the row says nothing. */
    metrics?: Partial<Record<MetricKey, string>>;
}

/**
 * The `sample_row_version` of each group the CLIENT can currently see, keyed exactly as
 * `sampleGroupKey` builds it. A group already carrying a reading needs its version, or
 * the RPC (rightly) answers `already_exists` rather than overwriting a stored reading
 * against a blind `null`. A key that is absent means "no sample there as far as the
 * screen knows" → `null` → INSERT, and a losing race comes back `already_exists`.
 * Never a re-read-and-retry.
 */
export type QcGroupVersions = Record<string, number | null>;

/**
 * Save a batch of typed draw rows — the spreadsheet entry path (2026-08-04).
 *
 * Deliberately a LOOP over `addPartnerDraw`, not a new RPC. Every rule that makes a draw
 * legal (the surface boundary, the source-conditional bag fields, the weight parser, the
 * date-typo guards) already lives in that one function and in the RPC underneath it; a
 * bulk variant would be a second place for those rules to drift.
 *
 * **Sequential on purpose.** `cenapro_add_partner_draw` resolves the running `batch` by
 * looking at the rows already logged at or before the new date, so a run of same-day draws
 * must see each other land. Firing them in parallel would have every row resolve against
 * the pre-batch state — usually the same answer, but silently wrong on the one day a year
 * it is not: a changeover.
 *
 * **Nothing is all-or-nothing.** Each row carries its own verdict, exactly like
 * `saveQcSamples` / `saveQcWeights`, so one bad line never discards the nine good ones and
 * the client can keep what was typed in the rows that failed. A `duplicate_warning` is a
 * refusal the operator confirms through by re-sending that row with `allowDuplicate`.
 */
export async function addQcDraws(
    rows: AddQcDrawRow[],
    groupVersions: QcGroupVersions = {},
): Promise<AddQcDrawRowResult[]> {
    const out: AddQcDrawRowResult[] = [];
    for (const { rowId, input } of rows) {
        out.push({ rowId, result: await addPartnerDraw(input) });
    }

    // ── The readings, bucketed by the group each insert actually landed in ────────
    interface Bucket {
        key: string;
        sampleDate: string;
        src: string;
        whse: string;
        rowIds: string[];
        /** Per metric: the agreed value. A second, different one is a conflict. */
        values: Partial<Record<MetricKey, number>>;
        /** The first disagreement found — recorded, then worded once the bucket is whole. */
        conflict: { metric: MetricKey; a: number; b: number } | null;
        /** A metric that could not be read at all — the row is named, nothing written. */
        invalid: string | null;
    }
    const buckets = new Map<string, Bucket>();
    const readingByRow = new Map<string, AddQcReadingResult>();

    for (let i = 0; i < rows.length; i++) {
        const { rowId, metrics } = rows[i];
        if (!metrics || Object.keys(metrics).length === 0) continue;

        const verdict = out[i].result;
        if (!(verdict.ok && verdict.outcome === 'inserted')) {
            readingByRow.set(rowId, {
                ok: false,
                outcome: 'skipped',
                groupKey: null,
                message:
                    'The draw did not save, so its reading was not written either. Fix the row and save again.',
            });
            continue;
        }
        const group = verdict.sample_group;
        if (!group) {
            readingByRow.set(rowId, {
                ok: false,
                outcome: 'rpc_error',
                groupKey: null,
                message:
                    'The draw saved, but the database did not report which sample group it joined, so the reading was not written. Type it on the saved row.',
            });
            continue;
        }

        const key = sampleGroupKey({
            sample_date: group.sample_date,
            source_location_code: group.source_location_code,
            whse_key: group.whse_key,
        });
        const bucket: Bucket = buckets.get(key) ?? {
            key,
            sampleDate: group.sample_date,
            src: group.source_location_code,
            whse: group.whse_key,
            rowIds: [],
            values: {},
            conflict: null,
            invalid: null,
        };
        bucket.rowIds.push(rowId);

        for (const metric of METRICS) {
            const raw = metrics[metric];
            if (raw == null || raw.trim() === '') continue;
            const { value, error } = parseMetricValue(metric, raw);
            if (value == null) {
                bucket.invalid ??= error ?? `${METRIC_SHORT[metric]} could not be read.`;
                continue;
            }
            const seen = bucket.values[metric];
            if (seen == null) {
                bucket.values[metric] = value;
            } else if (seen !== value) {
                // Two typed rows, one sample group, two different numbers for the same
                // metric. There is no correct answer to pick, so none is picked.
                bucket.conflict ??= { metric, a: seen, b: value };
            }
        }
        buckets.set(key, bucket);
    }

    if (buckets.size > 0) {
        const supabase = await createClient();

        for (const bucket of buckets.values()) {
            const refusal = bucket.conflict
                ? `${bucket.rowIds.length} new rows land in the sample group ` +
                  `${bucket.sampleDate} · ${bucket.src} · ${bucket.whse} but give ` +
                  `${METRIC_SHORT[bucket.conflict.metric]} as ${bucket.conflict.a} and ` +
                  `${bucket.conflict.b}. A reading covers the whole group, so none was saved ` +
                  `for it — the draws are in; make the numbers match, or type the reading once ` +
                  `on the saved row.`
                : bucket.invalid;
            if (refusal) {
                for (const rowId of bucket.rowIds) {
                    readingByRow.set(rowId, {
                        ok: false,
                        outcome: bucket.conflict ? 'reading_conflict' : 'rpc_error',
                        groupKey: bucket.key,
                        message: refusal,
                    });
                }
                continue;
            }
            if (Object.keys(bucket.values).length === 0) continue;

            const result = await writeSampleGroup(supabase, {
                key: bucket.key,
                sampleDate: bucket.sampleDate,
                sourceLocationCode: bucket.src,
                whseKey: bucket.whse,
                bd: bucket.values.bd ?? null,
                ash: bucket.values.ash ?? null,
                grit: bucket.values.grit ?? null,
                mc: bucket.values.mc ?? null,
                // Straight through, exactly as an edit on a saved row would: `null`
                // creates, an integer updates against that exact version. A group whose
                // reading moved while the slip was being typed comes back
                // `version_conflict`, never clobbered.
                expectedRowVersion: groupVersions[bucket.key] ?? null,
            });
            for (const rowId of bucket.rowIds) {
                readingByRow.set(rowId, {
                    ok: result.ok,
                    outcome: result.outcome,
                    groupKey: bucket.key,
                    message: result.message,
                });
            }
        }
    }

    if (readingByRow.size > 0) {
        for (const row of out) {
            const reading = readingByRow.get(row.rowId);
            if (reading) row.reading = reading;
        }
        // A reading moves both QC surfaces. `addPartnerDraw` already revalidated for the
        // insert; this covers a save where only the reading landed.
        if ([...readingByRow.values()].some((r) => r.ok)) {
            revalidatePath('/cenapro/qc');
            revalidatePath('/cenapro/qc/breakdown');
        }
    }

    return out;
}
