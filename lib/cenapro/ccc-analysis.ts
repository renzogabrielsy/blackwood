// ─────────────────────────────────────────────────────────────────────────────
// CCC/QC analysis — the PRODUCTION data-layer contract (Cenapro tenant).
//
// This is the module the real feature reads. It deliberately contains NO
// aggregation math: totals, coverage and the four weighted averages are computed
// in SQL (`cenapro.view_ccc_analysis_daily` / `_monthly`) per CLAUDE.md. Its
// presentation sibling `ccc-analysis-view.ts` adapts those view rows into the shape
// the two QC routes render, and owns the display formatters.
//
// (The evaluation-era `ccc-analysis-draft.ts`, which computed the weighted averages
// in TypeScript over a JSON fixture under a prototype exemption, was deleted on
// 2026-08-01 when `/cenapro/qc` and `/cenapro/qc/breakdown` cut over to these views.)
//
// Backing objects (all in `public`, because the `cenapro` schema is not exposed
// to PostgREST — see CENAPRO_SCHEMA.md §2.2):
//   cenapro_analysis_samples       base ledger, auto-updatable (all 500 sheet rows)
//   cenapro_ccc_sample_groups      read model — one row per (date, src, whse) group
//   cenapro_ccc_analysis_daily     scope='all' | 'ex_dvo'
//   cenapro_ccc_analysis_monthly   scope='all' | 'ex_dvo'
//   cenapro_save_analysis_sample() the save RPC (optimistic concurrency)
// ─────────────────────────────────────────────────────────────────────────────

import type { Database } from '@/types/supabase';

// ─── Metrics ─────────────────────────────────────────────────────────────────

export type MetricKey = 'bd' | 'ash' | 'grit' | 'mc';

export const METRICS: readonly MetricKey[] = ['bd', 'ash', 'grit', 'mc'] as const;

export const METRIC_LABEL: Record<MetricKey, string> = {
    bd: 'BD',
    ash: 'ASH %',
    grit: 'GRIT %',
    mc: 'MC %',
};

export const METRIC_SHORT: Record<MetricKey, string> = { bd: 'BD', ash: 'ASH', grit: 'GRIT', mc: 'MC' };

/**
 * Per-sample display precision (CLAUDE.md → RC IN Column Config: 2 dp for
 * MC/GRIT/ASH, 3 dp for bulk density). A WEIGHTED bulk density gets a fourth
 * digit because three hide the month-over-month movement entirely.
 */
export const METRIC_DECIMALS: Record<MetricKey, number> = { bd: 3, ash: 2, grit: 2, mc: 2 };
export const METRIC_DECIMALS_WEIGHTED: Record<MetricKey, number> = { bd: 4, ash: 2, grit: 2, mc: 2 };

/** The column name of a metric's own weighted-average denominator, in kg. */
export const METRIC_WEIGHT_COLUMN = {
    bd: 'wtd_bd_kg',
    ash: 'wtd_ash_kg',
    grit: 'wtd_grit_kg',
    mc: 'wtd_mc_kg',
} as const satisfies Record<MetricKey, string>;

// ─── Scope ───────────────────────────────────────────────────────────────────

/**
 * Which slice of the partner receipts an aggregate row describes.
 *
 * `'all'`    — every partner receipt, DVO included. The entry ledger's view.
 * `'ex_dvo'` — DVO container-van receipts excluded. The reading page's headline
 *              figures, and the flavour the drafts render today.
 *
 * The daily and monthly views emit BOTH rows for every period, so a caller
 * always filters on this. `all_kg` / `dvo_kg` / `ex_dvo_kg` are period-wide on
 * either row, so one `ex_dvo` row still carries the whole split.
 */
export type AnalysisScope = 'all' | 'ex_dvo';

export const ANALYSIS_SCOPES: readonly AnalysisScope[] = ['all', 'ex_dvo'] as const;

// ─── Row shapes (straight from the generated DB types) ───────────────────────

type Views = Database['public']['Views'];

export type AnalysisSampleRow = Views['cenapro_analysis_samples']['Row'];
export type CccSampleGroupRow = Views['cenapro_ccc_sample_groups']['Row'];
export type CccAnalysisDailyRow = Views['cenapro_ccc_analysis_daily']['Row'];
export type CccAnalysisMonthlyRow = Views['cenapro_ccc_analysis_monthly']['Row'];

// ─── Key normalization — the JS twin of cenapro.fn_canon_token() ─────────────

/**
 * Trim, collapse internal whitespace, uppercase. The save RPC applies the same
 * function server-side, so a client that forgets is still correct; use this when
 * building a key for a lookup/`.eq()` against a stored row, where nothing
 * normalizes for you.
 */
export function canonToken(value: string | null | undefined): string {
    return (value ?? '').trim().replace(/\s+/g, ' ').toUpperCase();
}

/**
 * The effective warehouse of an event row: `warehouse_code` when present, else
 * `plant_code`. Tank and W7 partner draws carry a NULL `warehouse_code` and the
 * source sheet writes the plant there instead — this is why the sample table's
 * `whse_key` exists as a NOT NULL resolved column rather than a nullable FK.
 */
export function effectiveWhseKey(row: {
    warehouse_code?: string | null;
    plant_code?: string | null;
}): string {
    return canonToken(row.warehouse_code ?? row.plant_code);
}

/** Stable identity of a sample group — safe as a React key. */
export function sampleGroupKey(
    group: Pick<CccSampleGroupRow, 'sample_date' | 'source_location_code' | 'whse_key'>,
): string {
    return `${group.sample_date}|${group.source_location_code}|${group.whse_key}`;
}

// ─── The save RPC ────────────────────────────────────────────────────────────

/**
 * Outcome of `cenapro_save_analysis_sample`.
 *
 * `inserted` / `updated`  — written; `row_version` is the NEW version, keep it
 *                           for the next save.
 * `already_exists`        — you passed `p_expected_row_version: null` but a
 *                           sample appeared meanwhile. Reload, then edit.
 * `version_conflict`      — someone else saved first. `row_version` is theirs.
 * `not_found`             — the row was deleted underneath you.
 * `no_metrics`            — all four metrics were null; delete the row instead.
 * `invalid_key`           — a key component was missing.
 */
export type SaveSampleOutcome =
    | 'inserted'
    | 'updated'
    | 'already_exists'
    | 'version_conflict'
    | 'not_found'
    | 'no_metrics'
    | 'invalid_key';

export interface SaveSampleResult {
    ok: boolean;
    outcome: SaveSampleOutcome;
    id?: string;
    /** Present on success, and on the two conflict outcomes (the CURRENT version). */
    row_version?: number | null;
    message?: string;
}

/**
 * Arguments for `supabase.rpc('cenapro_save_analysis_sample', …)`.
 *
 * Pass `p_expected_row_version: null` (or omit it) to CREATE, or the
 * `sample_row_version` you read from `cenapro_ccc_sample_groups` to UPDATE — the
 * read model returns NULL there for an unsampled group, so threading the value
 * straight through does the right thing in both cases.
 */
export type SaveSampleArgs = Database['public']['Functions']['cenapro_save_analysis_sample']['Args'];
