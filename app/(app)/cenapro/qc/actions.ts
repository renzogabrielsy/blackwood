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
    parseWeightKg,
    type AddPartnerDrawArgs,
    type AddPartnerDrawOutcome,
    type AddPartnerDrawResult,
    type BatchResolution,
    type ExistingDraw,
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
export async function saveQcSamples(inputs: SaveQcSampleInput[]): Promise<SaveQcSamplesResult> {
    if (inputs.length === 0) return { results: [], savedCount: 0, failedCount: 0 };

    const supabase = await createClient();
    const results: SaveQcSampleResult[] = [];

    for (const input of inputs) {
        // Cheap client-side guard's server twin: the RPC rejects an all-null sample
        // (`no_metrics`), so never spend a round trip discovering that.
        if (METRICS.every((metric) => input[metric] == null)) {
            results.push({
                key: input.key,
                ok: false,
                outcome: 'no_metrics',
                rowVersion: input.expectedRowVersion,
                message:
                    'A sample must carry at least one of BD / ASH / GRIT / MC. Clearing every metric would delete the reading, which this screen does not do.',
            });
            continue;
        }

        const { data, error } = await supabase.rpc('cenapro_save_analysis_sample', buildArgs(input));

        if (error) {
            results.push({
                key: input.key,
                ok: false,
                outcome: 'rpc_error',
                rowVersion: null,
                message: error.message,
            });
            continue;
        }

        const raw = (data ?? {}) as RawSaveResult;
        results.push({
            key: input.key,
            ok: raw.ok === true,
            outcome: readOutcome(raw.outcome),
            rowVersion: typeof raw.row_version === 'number' ? raw.row_version : null,
            message: typeof raw.message === 'string' ? raw.message : null,
        });
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
    // bag field is a value the RPC would (rightly) refuse on a tank draw.
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
        plant_code: str(raw.plant_code) ?? null,
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
