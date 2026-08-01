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
import { METRICS, type SaveSampleArgs, type SaveSampleOutcome } from '@/lib/cenapro/ccc-analysis';

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
