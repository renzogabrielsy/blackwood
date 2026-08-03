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

// ─── The weight write path ───────────────────────────────────────────────────
//
// A DRAW's `weight_kg` on `cenapro.production_event` — the tonnage every weighted
// average is weighted BY. Editable from the QC Ledger so a typo can be fixed where
// it is noticed, through `public.cenapro_update_event_weight`.
//
// CONCURRENCY IS COMPARE-AND-SET, NOT A ROW VERSION. `production_event` carries no
// `row_version` column, and adding one would drag the production ledger's bulk
// upsert into respecting it too — far wider than a typo fix warrants. Instead the
// caller sends the weight it is LOOKING AT and the UPDATE only fires while the
// stored value still equals it, checked in the same statement as the write. Zero
// rows matched is a `conflict`; it is never retried and never force-written.
//
// `updated`   — the stored weight equalled what was on screen and now holds the new
//               value. The change is trailed in `cenapro.production_event_audit`.
// `conflict`  — somebody moved it underneath. `weight_kg` is the CURRENT value.
// `not_found` — the receipt row was deleted while it was being edited.
// `invalid`   — not a positive number, over 3 decimal places, over 10,000,000 kg,
//               or no expected value supplied. Nothing was written.
export type UpdateWeightOutcome = 'updated' | 'conflict' | 'not_found' | 'invalid';

export interface UpdateWeightResult {
    ok: boolean;
    outcome: UpdateWeightOutcome;
    id?: string;
    /** Present on success (the new value) and on `conflict` (the CURRENT stored one). */
    weight_kg?: number | null;
    message?: string;
}

/** Arguments for `supabase.rpc('cenapro_update_event_weight', …)`. */
export type UpdateWeightArgs =
    Database['public']['Functions']['cenapro_update_event_weight']['Args'];

// ─── The partner-draw ADD path ───────────────────────────────────────────────
//
// One new row on `cenapro.production_event`, through
// `public.cenapro_add_partner_draw`. PARTNER DRAWS ONLY — the partner reports its
// daily totals on a piece of paper and every line on it is a pull into one of its
// four crushers or four rotary kilns. What CI puts INTO inventory (flec bagging)
// arrives on a separate sheet and is entered in the Production ledger; the RPC
// refuses it here by name rather than leaving the boundary to the UI.
//
// The RPC — not the caller — derives `disposition_kind` from the machine and
// `plant_code` from the source, and resolves the running `batch` label. Those are
// not conveniences: `plant_code` IS the QC ledger's `whse_key` for a tank draw
// (`coalesce(warehouse_code, plant_code)`), and `batch` straddles month boundaries
// (JULY first appears 2026-06-27), so neither can be inferred client-side.

/**
 * Outcome of `cenapro_add_partner_draw`.
 *
 * `inserted`           — written. `sample_group` says where it landed in the QC
 *                        ledger; `notice` is a non-blocking remark, when present.
 * `duplicate_warning`  — a draw with the same (date, source, machine, grade,
 *                        shift) already exists, and `existing` lists them. SOFT:
 *                        two genuine trips in a day are real, so re-send the same
 *                        arguments with `p_allow_duplicate: true` to confirm.
 * `already_exists`     — an IDENTICAL row is already stored (same `unique_tag`).
 *                        Hard: the database cannot hold two, whatever the intent.
 *                        `id` is the row that is already there. Not confirmable.
 * `wrong_surface`      — no machine named, or flec bagging asked for. Point the
 *                        operator at the Production ledger.
 * `unsupported_source` — DVO. Container vans into WHSE 3 are a different document
 *                        and are still deferred; existing DVO rows stay editable.
 * `invalid_key`        — a dimension code is missing or unknown (machine, source,
 *                        grade, shift, warehouse, side).
 * `invalid`            — a value is out of bounds, or a bag field was supplied on
 *                        a source that consumes no bags (or omitted on one that
 *                        does). Nothing was written.
 */
export type AddPartnerDrawOutcome =
    | 'inserted'
    | 'duplicate_warning'
    | 'already_exists'
    | 'wrong_surface'
    | 'unsupported_source'
    | 'invalid_key'
    | 'invalid';

/** How the RPC arrived at the `batch` label it stored. */
export type BatchResolution =
    /** The caller supplied `p_batch`. */
    | 'explicit'
    /** Resolved from the batch actually running at `recv_date`. The normal case. */
    | 'running'
    /** No history at or before that date at all — fell back to the calendar month. */
    | 'calendar';

/** One draw already on file, listed by a `duplicate_warning`. */
export interface ExistingDraw {
    id: string;
    weight_kg: number;
    prod_date: string | null;
    warehouse_code: string | null;
    whse_side: string | null;
    batch: string;
}

export interface AddPartnerDrawResult {
    ok: boolean;
    outcome: AddPartnerDrawOutcome;
    /** Present on `inserted`, and on `already_exists` (the row already stored). */
    id?: string;
    message?: string;

    // ── `inserted` only ──────────────────────────────────────────────────────
    unique_tag?: string;
    batch?: string;
    batch_year?: number;
    batch_resolution?: BatchResolution;
    /** Derived from the source. NULL for a FLEC draw — origin is unknowable once bagged. */
    plant_code?: string | null;
    disposition_kind?: 'partner_crusher' | 'partner_kiln';
    /** Exactly the `cenapro_ccc_sample_groups` key the new row now belongs to. */
    sample_group?: {
        sample_date: string;
        source_location_code: string;
        whse_key: string;
    };
    /**
     * Non-blocking remark on an otherwise successful write. Today the only one:
     * a FLEC draw saved without an LS/RS side, which `cenapro.flec_ledger` does
     * not count, so the warehouse balance will not move until a side is set.
     */
    notice?: string | null;

    // ── `duplicate_warning` only ─────────────────────────────────────────────
    existing?: ExistingDraw[];

    // ── `already_exists` only ────────────────────────────────────────────────
    weight_kg?: number;
}

/** Arguments for `supabase.rpc('cenapro_add_partner_draw', …)`. */
export type AddPartnerDrawArgs =
    Database['public']['Functions']['cenapro_add_partner_draw']['Args'];

/**
 * The ONE place a typed weight becomes a number, shared by the client's live preview
 * and the server action's pre-flight — so the two can never disagree about what is
 * acceptable, and the client can block a bad value before it costs a round trip.
 *
 * Mirrors the production ledger's own habit of stripping `,`/`₱`/whitespace off a
 * pasted numeric cell before `Number()`, then adds the RPC's rules on top. Returns
 * `null` with a reason rather than throwing; the reason is what the UI shows.
 *
 * Used by BOTH write paths — `cenapro_update_event_weight` (correcting a stored
 * weight) and `cenapro_add_partner_draw` (typing a new one) apply identical rules,
 * so a number that is acceptable in one is acceptable in the other.
 */
export function parseWeightKg(raw: string): { kg: number | null; error: string | null } {
    const cleaned = raw.replace(/[,\s₱_]/g, '');
    if (cleaned === '') return { kg: null, error: 'A weight is required — this row cannot be blank.' };
    if (!/^\d*\.?\d*$/.test(cleaned) || cleaned === '.') {
        return { kg: null, error: 'A weight must be a plain number of kilograms.' };
    }
    const decimals = cleaned.split('.')[1]?.length ?? 0;
    if (decimals > 3) return { kg: null, error: 'A weight carries at most 3 decimal places.' };
    const kg = Number(cleaned);
    if (!Number.isFinite(kg) || kg <= 0) {
        return { kg: null, error: 'A weight must be a positive number of kilograms.' };
    }
    if (kg > 10_000_000) {
        return { kg: null, error: 'That weight is over 10,000,000 kg — check for a mistyped digit.' };
    }
    return { kg, error: null };
}
