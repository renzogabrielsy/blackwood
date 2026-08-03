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
