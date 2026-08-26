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
//   cenapro_grades                 the grade dimension, read-only (2026-08-26)
//   cenapro_add_grade()            the grade dimension's INSERT-only write path
// ─────────────────────────────────────────────────────────────────────────────

import { normalizeTypedDate } from '@/lib/paste-utils';
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

// ─── The QC-ledger ADD path ──────────────────────────────────────────────────
//
// One new row on `cenapro.production_event`, through
// `public.cenapro_add_partner_draw`. **TWO ENTRY KINDS since 2026-08-26**, told
// apart by the machine cell alone — the same cell, and the same aliases, that
// `parseCccFlec` reads in the Production ledger:
//
//   • `C1`–`C4` / `RK1`–`RK4` → a PARTNER DRAW. The partner reports its daily
//     totals on a piece of paper and every line is a pull into one of its four
//     crushers or four rotary kilns. `disposition_kind` is `partner_crusher` /
//     `partner_kiln`.
//   • `FLEC` (or `BAG` / `BAGGING` / `FLEC BAGGING` / `FLEC_BAGGING`) → a FLEC
//     BAGGING entry, an inventory IN: charcoal CI put INTO a warehouse.
//     `disposition_kind` is `flec_bagging` and `partner_equipment_code` is NULL —
//     exactly the row the Production ledger's `CCC/FLEC = FLEC` cell writes.
//
// This REVERSES the 2026-08-03 boundary ("bagging stays in the Production
// ledger"): the QC Ledger is now the one place operators type everything, the same
// reversal `p_plant` got on 2026-08-04. A BLANK machine is still `wrong_surface`.
//
// BAG FIELDS FOLLOW THE DIRECTION, NOT THE MACHINE. A FLEC-SOURCED draw (bags out)
// and a FLEC-MACHINE entry (bags in) both REQUIRE `warehouse_code` — a flec-count
// warehouse, WHSE 1/2/5/7, never WHSE 3 — and `flec_count`, and both treat
// `whse_side` as optional with the sideless `notice`, because `cenapro.flec_ledger`
// counts a row only when the warehouse is set and a side is present. Every other
// row refuses all three. **`SRC = FLEC` together with `MACH = FLEC` is refused**
// (`invalid`): it is a self-loop the flec ledger would count as an IN only, so the
// warehouse would gain bags that had just been taken out of it.
//
// The RPC — not the caller — derives `disposition_kind` from the machine and
// `plant_code` from the source, and resolves the running `batch` label. Those are
// not conveniences: `plant_code` IS the QC ledger's `whse_key` for a tank draw
// (`coalesce(warehouse_code, plant_code)`), and `batch` straddles month boundaries
// (JULY first appears 2026-06-27), so neither can be inferred client-side.

/**
 * THE machine-cell values that mean "this is a FLEC BAGGING entry, not a draw".
 *
 * Byte-for-byte the list `cenapro_add_partner_draw` tests
 * (`v_equip_in IN ('FLEC','BAG','BAGGING','FLEC BAGGING','FLEC_BAGGING')`), which is
 * itself `parseCccFlec`'s list in `app/(app)/cenapro/types.ts` — so a value typed into
 * the Production ledger's CCC/FLEC cell and the same value typed into the QC Ledger
 * mean the same thing in all three places.
 *
 * It lives HERE rather than being imported from `types.ts` because this module is
 * `lib/` and that one is `app/` — importing upward would invert the layering. The
 * copies are pinned equal by an assertion in `scripts/verify-qc-draw-cells.ts`, the
 * same discipline `TRIAGE_KIND` uses (CLAUDE.md → "Client/server module boundary
 * trap"): duplicate the constant, then make a script fail if the copies drift.
 *
 * NOTE the space in `FLEC BAGGING`. `canonToken` collapses runs of whitespace, so a
 * caller that normalizes first will match it; a `Set` built from a hand-typed list
 * that omits it will not — which is exactly the drift this constant exists to end.
 */
export const BAGGING_MACHINE_CODES: readonly string[] = [
    'FLEC',
    'BAG',
    'BAGGING',
    'FLEC BAGGING',
    'FLEC_BAGGING',
] as const;

const BAGGING_MACHINE_SET = new Set<string>(BAGGING_MACHINE_CODES);

/**
 * Does this machine cell name a bagging entry? Canonicalizes first (`canonToken`,
 * the JS twin of `cenapro.fn_canon_token`), so ` flec bagging ` answers the same as
 * `FLEC BAGGING` — exactly as the RPC does.
 *
 * A BLANK cell is NOT bagging: it names no event at all, and the RPC answers it
 * `wrong_surface`. Callers must keep those two cases separate.
 */
export function isBaggingMachine(machine: string | null | undefined): boolean {
    return BAGGING_MACHINE_SET.has(canonToken(machine));
}

/**
 * The ONE spelling a MACH picker OFFERS for a bagging entry.
 *
 * `BAGGING_MACHINE_CODES` is the ACCEPT list — five spellings a human might already have
 * typed, and the RPC takes all of them. This is the one to WRITE, and the distinction
 * matters: a dropdown that offered all five would ask the operator to choose between
 * synonyms, and a screen that hard-coded its own sixth spelling would be the drift this
 * pair of constants exists to end.
 *
 * `FLEC` rather than `FLEC BAGGING` because that is what the Production ledger's
 * `CCC/FLEC` column already shows for the same event, and because `cccFlecBadgeClass`
 * paints exactly that token emerald — one word, one colour, both ledgers.
 *
 * Nothing is stored under it: the RPC files a bagging entry with `partner_equipment_code`
 * NULL and `disposition_kind: 'flec_bagging'`. It is a UI token that means "this row is an
 * IN, not a draw", and `scripts/verify-qc-draw-cells.ts` pins it inside the accept list.
 */
export const BAGGING_MACHINE_CODE = 'FLEC';

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
 * `wrong_surface`      — NO MACHINE NAMED. Since 2026-08-26 that is the whole of
 *                        it: `FLEC` is no longer refused here, it files a bagging
 *                        entry. A row naming neither a crusher/kiln nor FLEC
 *                        describes no event at all.
 * `unsupported_source` — DVO. Container vans into WHSE 3 are a different document
 *                        and are still deferred; existing DVO rows stay editable.
 * `invalid_key`        — a dimension code is missing or unknown (machine, source,
 *                        grade, shift, warehouse, side).
 * `invalid`            — a value is out of bounds, a bag field was supplied on a
 *                        row that touches no bag inventory (or omitted on one that
 *                        does), or the row asked for `SRC = FLEC` **and**
 *                        `MACH = FLEC` at once — the self-loop. Nothing was written.
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
    /**
     * The EFFECTIVE plant that was stored — the caller's `p_plant` when one was
     * supplied and accepted, otherwise the value derived from the source. NULL for a
     * FLEC draw with no supplied plant: origin is unknowable once bagged.
     */
    plant_code?: string | null;
    /**
     * Where `plant_code` came from (2026-08-04, `p_plant`). Mirrors the
     * `batch_resolution` idiom so a UI can render the provenance structurally instead
     * of parsing a sentence.
     */
    plant_source?: 'derived' | 'supplied';
    /** What the SOURCE alone would have given, whether or not it was used. */
    plant_derived?: string | null;
    /**
     * Non-blocking, and non-null ONLY when a supplied plant DISAGREES with the derived
     * one. Unlike `duplicate_warning` there is no confirm round trip — the operator is
     * transcribing a partner's slip, not resolving an ambiguity the machine can see —
     * so this accompanies a SUCCESSFUL write and is informational.
     *
     * Independent of `notice` below: a FLEC draw can carry both.
     */
    plant_notice?: string | null;
    /**
     * WHAT KIND OF ROW WAS FILED — and the only key that says so (2026-08-26).
     * `flec_bagging` means the machine cell said FLEC and this is an inventory IN;
     * the two partner values mean a draw. No separate `entry_kind` key is returned:
     * the disposition IS the entry kind, and a second field saying the same thing
     * would be a second place for it to drift.
     */
    disposition_kind?: 'partner_crusher' | 'partner_kiln' | 'flec_bagging';
    /** Exactly the `cenapro_ccc_sample_groups` key the new row now belongs to. */
    sample_group?: {
        sample_date: string;
        source_location_code: string;
        whse_key: string;
    };
    /**
     * Non-blocking remark on an otherwise successful write. Today the only one:
     * a bag-bearing row — a FLEC-sourced draw (bags out) or a FLEC-machine bagging
     * entry (bags in) — saved without an LS/RS side, which `cenapro.flec_ledger`
     * does not count, so the warehouse balance will not move until a side is set.
     * The sentence is worded for whichever direction the row is.
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

// ─── The grade dimension (2026-08-26) ────────────────────────────────────────
//
// `cenapro.grade` is ONE dimension shared by production rows, partner draws,
// bagging entries and the flec ledger's per-grade balance — and until now it could
// only be extended by a migration, because the `cenapro` schema is invisible to
// PostgREST and every UI list was the hardcoded `GRADE_CODES` constant in
// `app/(app)/cenapro/types.ts`. Two objects open it: `public.cenapro_grades`
// (read, SELECT only) and `public.cenapro_add_grade` (write, INSERT ONLY).
//
// THERE IS NO UPDATE RPC AND NO DELETE RPC, and that is a decision rather than an
// omission: `grade_code` is a TEXT foreign key carried by every `production_event`
// row, so renaming one would need a cascade nobody has reasoned about, and deleting
// one would succeed on a grade added by mistake five minutes ago and be refused by
// the FK later — succeeding and failing for reasons the operator cannot see.
// Adding is monotone and safe; the other two deserve their own migration when
// somebody actually needs them.

/** One row of `public.cenapro_grades`, straight from the generated DB types. */
export type CenaproGradeRow = Views['cenapro_grades']['Row'];

/**
 * Outcome of `cenapro_add_grade`.
 *
 * `inserted`       — written. The returned fields are the row as STORED (the code
 *                    canonicalized, the display name defaulted to it when blank,
 *                    the sort order defaulted to the end of the list).
 * `already_exists` — a grade with that code is on file. Matching is
 *                    CASE- and WHITESPACE-INSENSITIVE (`cenapro.fn_canon_token`),
 *                    so a typed `3x50` can never open a second grade beside
 *                    `3X50`; the returned fields are the row that IS stored and
 *                    `message` names both spellings when they differ. Not
 *                    confirmable — there is only ever one of a grade.
 * `invalid`        — a blank code, a code over 24 characters, a display name over
 *                    64, or a sort order outside 0–10000. Nothing was written.
 */
export type AddGradeOutcome = 'inserted' | 'already_exists' | 'invalid';

export interface AddGradeResult {
    ok: boolean;
    outcome: AddGradeOutcome;
    message?: string;

    // ── Present on `inserted` (the row as stored) and on `already_exists` (the
    //    row that is already there). Absent on `invalid`. ──────────────────────
    code?: string;
    display_name?: string;
    sort_order?: number;
    /**
     * The QC bag-weight tolerance. NOT settable through `cenapro_add_grade` — it
     * is a tolerance, not part of naming a grade, and two of the four seeded rows
     * carry neither, so NULL is the normal state rather than a gap.
     */
    expected_kg_per_bag_min?: number | null;
    expected_kg_per_bag_max?: number | null;
}

/** Arguments for `supabase.rpc('cenapro_add_grade', …)`. */
export type AddGradeArgs = Database['public']['Functions']['cenapro_add_grade']['Args'];

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

// ─── Typed dates ─────────────────────────────────────────────────────────────
//
// A QC date cell is FREE TEXT that becomes `yyyy-MM-dd` when you leave it — the same
// contract the RC Deliveries ledger settled on (`parseDeliveryDate` in
// `app/(app)/cenapro/deliveries/types.ts`). The shared `normalizeTypedDate` already
// speaks every form the operators use (`6/27`, `6/27/26`, `2026-06-27`, `27 Jun 26`,
// an Excel serial); it is NOT extended here, because it is shared with the production
// ledger and the paste path.
//
// What this pair adds on top is a VERDICT. `normalizeTypedDate` hands the operator's
// text straight back when it cannot read it — perfectly right for a paste, and exactly
// wrong for a receipt date, where a passthrough would send `6/45` to Postgres as a
// `date` cast and come back as an error about a cell the UI already accepted.
//
// The pair is duplicated rather than imported from the deliveries module on purpose:
// that module is the RC-receipt vocabulary (991 columns' worth of it) and QC has no
// business pulling it in for fifteen lines. They must stay behaviourally identical,
// which is what `scripts/verify-qc-draw-cells.ts` asserts.

/**
 * `yyyy-MM-dd` AND a day that exists. The second half is not pedantry:
 * `normalizeTypedDate` returns the input unchanged when it cannot validate it, so a
 * typed `2026-02-30` comes back still SHAPED like an ISO date. A shape test alone
 * would wave it through.
 */
export function isIsoDate(text: string): boolean {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
    if (!m) return false;
    const y = Number(m[1]);
    const mo = Number(m[2]);
    const d = Number(m[3]);
    // UTC so a timezone offset can never roll the round-trip onto the neighbouring day.
    const dt = new Date(Date.UTC(y, mo - 1, d));
    return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
}

/**
 * A typed QC date cell → `yyyy-MM-dd`, or a reason it is not a date.
 *
 * `contextYear` is what a bare `6/27` means. The QC ledger is month-scoped, so it
 * supplies the FOCUSED MONTH's year — the month whose rows are on screen, which is the
 * month the slip being transcribed belongs to.
 */
export function parseQcDate(input: string, contextYear: number): { iso: string } | { error: string } {
    const text = input.trim();
    if (!text) return { error: 'a date is required.' };
    const iso = normalizeTypedDate(text, contextYear);
    if (!isIsoDate(iso)) {
        return {
            error: `"${text}" is not a date. Try 6/27, 6/27/26, 2026-06-27 or 27 Jun 26 — a bare day-and-month takes ${contextYear}.`,
        };
    }
    return { iso };
}

// ─── Typed lab readings ──────────────────────────────────────────────────────

/**
 * The RANGE each metric is allowed to take, mirroring the four CHECK constraints on
 * `cenapro.analysis_sample` (migration `20260801073405`). The database is still the
 * authority; this exists so a mistyped decimal is named in the row instead of coming
 * back as a constraint-violation string.
 */
const METRIC_RANGE: Record<MetricKey, { min: number; max: number; minExclusive: boolean }> = {
    bd: { min: 0, max: 5, minExclusive: true },
    ash: { min: 0, max: 100, minExclusive: false },
    grit: { min: 0, max: 100, minExclusive: false },
    mc: { min: 0, max: 100, minExclusive: false },
};

/**
 * The ONE place a typed lab reading becomes a number — shared by the draft rows' live
 * check and the server action that writes them, so the two can never disagree.
 *
 * A BLANK cell is not an error: it means "this row says nothing about this metric",
 * which is the sheet's own convention and how a group ends up carrying, say, only BD.
 */
export function parseMetricValue(
    metric: MetricKey,
    raw: string,
): { value: number | null; error: string | null } {
    const cleaned = raw.replace(/[\s_]/g, '');
    if (cleaned === '') return { value: null, error: null };
    // A comma is NOT stripped the way `parseWeightKg` strips one. Every metric tops out
    // at 100, so a comma can never be a thousands separator here — it is a decimal comma
    // or a typo, and stripping it would silently turn `2,80` into 280.
    if (cleaned.includes(',')) {
        return {
            value: null,
            error: `${METRIC_SHORT[metric]} takes a dot for the decimal point, not a comma.`,
        };
    }
    if (!/^\d*\.?\d*$/.test(cleaned) || cleaned === '.') {
        return { value: null, error: `${METRIC_SHORT[metric]} must be a plain number.` };
    }
    const value = Number(cleaned);
    if (!Number.isFinite(value)) {
        return { value: null, error: `${METRIC_SHORT[metric]} must be a plain number.` };
    }
    const range = METRIC_RANGE[metric];
    const tooLow = range.minExclusive ? value <= range.min : value < range.min;
    if (tooLow || value > range.max) {
        return {
            value: null,
            error: `${METRIC_SHORT[metric]} must be between ${range.minExclusive ? 'over ' : ''}${range.min} and ${range.max}.`,
        };
    }
    return { value, error: null };
}
