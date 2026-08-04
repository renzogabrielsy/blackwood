'use server';

// ─────────────────────────────────────────────────────────────────────────────────
// RC Deliveries — the data path. Reads AND writes, same file, same pattern as
// `production/actions.ts`: the server page calls the fetchers directly and the client
// grid calls them again for each new page, so there is exactly one query per shape.
//
// Two boundaries are enforced here and NOWHERE else:
//
//   1. ₱ GATING. `canViewPrices()` is consulted on every read, and the price fields are
//      NULLED (`stripPrices`) BEFORE the payload is returned. Hiding them client-side
//      is not gating — the network response is the leak. The same check refuses a ₱ key
//      in a save patch, so a gated viewer cannot write a price they cannot see.
//
//   2. SEQUENCING A COMBINED SAVE. A receipt may have both field edits and sample edits.
//      The field patch bumps `row_version` (via the `fn_touch_rc_delivery` trigger), so
//      firing both calls with the SAME expected version would make the second one
//      conflict with the first. The patch therefore goes first and its returned version
//      is threaded into the samples call. Nothing retries and nothing force-writes: a
//      genuine `version_conflict` means another human moved, and a human has to look.
//
// The client never touches Supabase. It hands over `SaveDeliveryInput[]` and gets one
// verdict per receipt back, verbatim.
// ─────────────────────────────────────────────────────────────────────────────────

import { revalidatePath } from 'next/cache';

import { canViewPrices } from '@/lib/auth';
import { createClient } from '@/lib/supabase/server';
import {
    stripPrices,
    type DeliveryDimensions,
    type DeliveryRecord,
    type RcDeliveryRow,
    type RcDeliverySampleRow,
    type SaveDeliveryInput,
    type SaveDeliveryResult,
    type SaveOutcome,
    type DeliveryCursor,
} from './types';
import {
    periodBounds,
    type DeliveryPeriod,
    type IssueLens,
} from './ledger-url';

/** One keyset page. Sized to fill a tall viewport twice over without over-fetching. */
const PAGE_SIZE = 120;

/**
 * The read model's column list. A SINGLE string literal on purpose — the typed
 * PostgREST client parses it at the type level, and `+`-concatenation defeats that
 * inference and collapses the row type to an error.
 */
const ROW_COLS =
    'id, delivery_date, delivery_date_raw, delivery_year, truck_no, supplier_code, supplier_name, supplier_origin, permit_no, supplier_raw, sacks, gross_weight_kg, deduction_pct, net_weight_kg, weight_formula, bd, moisture_pct, grit, ash, dust, vm, fc, destination_code, destination_name, destination_kind, destination_has_sides, destination_side, destination_raw, remarks, base_price_php_kg, price_adjustment_php_kg, price_php_kg, price_formula, total_price_php, sheet_total_php, sheet_total_matches, sample_count, sample_avg_moisture_pct, provenance, source_sheet, source_row, is_suspected_duplicate, import_flags, import_flag_count, has_import_flags, supplier_unresolved, destination_unresolved, row_version, created_at, created_by, updated_at, updated_by';

const SAMPLE_COLS =
    'id, delivery_id, position, label, bd, moisture_pct, grit, ash, dust, vm, fc, source_row, created_at';

// ═══ Shared plumbing ════════════════════════════════════════════════════════════

/**
 * The keyset predicate, in PostgREST `or()` form.
 *
 * NULL dates are the whole reason this is a function rather than one inline string. A
 * plain `delivery_date.gt.X` never matches a NULL, so with `NULLS FIRST` ordering the
 * two undated receipts would sit at the head of history and be permanently unreachable
 * by a forward walk. Each direction therefore names the NULL group explicitly.
 */
function keysetPredicate(cursor: DeliveryCursor, direction: 'older' | 'newer'): string {
    const { delivery_date: d, id } = cursor;
    if (direction === 'newer') {
        return d === null
            // Past the NULL group: every dated row, plus later ids inside the group.
            ? `delivery_date.not.is.null,and(delivery_date.is.null,id.gt.${id})`
            : `delivery_date.gt.${d},and(delivery_date.eq.${d},id.gt.${id})`;
    }
    return d === null
        ? `and(delivery_date.is.null,id.lt.${id})`
        : `delivery_date.lt.${d},and(delivery_date.eq.${d},id.lt.${id}),delivery_date.is.null`;
}

/**
 * The base read query with the issue lens + free-text search already applied. Both are
 * optional and AND together. Written as one builder function (rather than a generic
 * `applyLens` helper) so the PostgREST row type is INFERRED end-to-end — a hand-written
 * generic over the filter builder loses it and collapses the row shape to an error type.
 */
function buildRowQuery(
    supabase: Awaited<ReturnType<typeof createClient>>,
    issue: IssueLens | null,
    query: string,
) {
    const q = supabase.from('cenapro_rc_delivery_rows').select(ROW_COLS);

    const lensed =
        issue === 'duplicate'
            ? q.eq('is_suspected_duplicate', true)
            : issue === 'flagged'
              ? q.eq('has_import_flags', true)
              : issue === 'unmapped'
                ? q.or('supplier_unresolved.eq.true,destination_unresolved.eq.true')
                : issue === 'undated'
                  ? q.is('delivery_date', null)
                  : q;

    // Strip PostgREST's `or()` separators + wildcards so a comma or paren in the search
    // box cannot smuggle an extra predicate into the filter string.
    const safe = query.trim().replace(/[,()*\\.:]/g, ' ').trim();
    if (!safe) return lensed;

    const like = `*${safe}*`;
    return lensed.or(
        [
            `supplier_raw.ilike.${like}`,
            `supplier_code.ilike.${like}`,
            `supplier_origin.ilike.${like}`,
            `permit_no.ilike.${like}`,
            `truck_no.ilike.${like}`,
            `destination_raw.ilike.${like}`,
            `destination_code.ilike.${like}`,
            `remarks.ilike.${like}`,
        ].join(','),
    );
}

/** Fetch the sub-samples for a page of receipts, in one round trip. */
async function loadSamples(
    supabase: Awaited<ReturnType<typeof createClient>>,
    ids: string[],
): Promise<{ samples: RcDeliverySampleRow[]; error: string | null }> {
    if (ids.length === 0) return { samples: [], error: null };
    const { data, error } = await supabase
        .from('cenapro_rc_delivery_samples')
        .select(SAMPLE_COLS)
        .in('delivery_id', ids)
        .order('delivery_id', { ascending: true })
        .order('position', { ascending: true });
    if (error) return { samples: [], error: `Failed to load moisture sub-samples: ${error.message}` };
    return { samples: data ?? [], error: null };
}

/** Stitch rows + samples into the render unit, price-gating on the way out. */
function assemble(
    rows: RcDeliveryRow[],
    samples: RcDeliverySampleRow[],
    showPrices: boolean,
): DeliveryRecord[] {
    const byDelivery = new Map<string, RcDeliverySampleRow[]>();
    for (const s of samples) {
        const key = s.delivery_id ?? '';
        const list = byDelivery.get(key);
        if (list) list.push(s);
        else byDelivery.set(key, [s]);
    }
    return rows.map((row) => ({
        row: showPrices ? row : stripPrices(row),
        samples: byDelivery.get(row.id ?? '') ?? [],
    }));
}

// ═══ READ — the endless keyset pager ════════════════════════════════════════════

export type DeliveryAnchor =
    | { kind: 'latest' }
    | { kind: 'period'; year: number; month: number };

export interface DeliveryPageInput {
    mode: 'anchor' | 'cursor';
    anchor?: DeliveryAnchor;
    cursor?: DeliveryCursor;
    direction?: 'older' | 'newer';
    issue?: IssueLens | null;
    query?: string;
}

export interface DeliveryPage {
    records: DeliveryRecord[];
    hasOlder: boolean;
    hasNewer: boolean;
    canViewPrices: boolean;
    notice?: string;
    error?: string;
}

function pageErr(message: string, showPrices = false): DeliveryPage {
    return { records: [], hasOlder: false, hasNewer: false, canViewPrices: showPrices, error: message };
}

export async function fetchDeliveryPage(input: DeliveryPageInput): Promise<DeliveryPage> {
    const supabase = await createClient();
    const showPrices = await canViewPrices();
    const issue = input.issue ?? null;
    const query = input.query ?? '';

    const base = () => buildRowQuery(supabase, issue, query);

    // ── Initial anchored page ────────────────────────────────────────────────────
    if (input.mode === 'anchor') {
        const anchor = input.anchor ?? { kind: 'latest' };

        // 'latest' → the FINAL page (query DESC, limit, reverse to asc) so the sheet
        // opens at the bottom, on the newest receipts. Nothing is newer; a full page
        // implies history above.
        if (anchor.kind === 'latest') {
            const { data, error } = await base()
                .order('delivery_date', { ascending: false, nullsFirst: false })
                .order('id', { ascending: false })
                .limit(PAGE_SIZE);
            if (error) return pageErr(`Failed to load receipts: ${error.message}`, showPrices);
            const fetched = (data ?? []).reverse();
            const { samples, error: sErr } = await loadSamples(
                supabase,
                fetched.map((r) => r.id ?? '').filter(Boolean),
            );
            if (sErr) return pageErr(sErr, showPrices);
            return {
                records: assemble(fetched, samples, showPrices),
                hasOlder: fetched.length === PAGE_SIZE,
                hasNewer: false,
                canViewPrices: showPrices,
            };
        }

        // 'period' → anchor at the month's FIRST matching receipt, then load forward
        // INCLUSIVE. The month is a jump target only; the window still spans all history
        // in both directions from there.
        const { from } = periodBounds({ year: anchor.year, month: anchor.month });
        const { data: firstRows, error: firstErr } = await base()
            .gte('delivery_date', from)
            .order('delivery_date', { ascending: true, nullsFirst: true })
            .order('id', { ascending: true })
            .limit(1);
        if (firstErr) return pageErr(`Failed to resolve the month anchor: ${firstErr.message}`, showPrices);

        const first = firstRows?.[0];
        if (!first) {
            const fallback = await fetchDeliveryPage({ mode: 'anchor', anchor: { kind: 'latest' }, issue, query });
            return {
                ...fallback,
                notice: `Nothing on or after ${from} — showing the newest receipts instead.`,
            };
        }

        const d = first.delivery_date ?? '';
        const i = first.id ?? '';
        const { data, error } = await base()
            .or(`delivery_date.gt.${d},and(delivery_date.eq.${d},id.gte.${i})`)
            .order('delivery_date', { ascending: true, nullsFirst: true })
            .order('id', { ascending: true })
            .limit(PAGE_SIZE + 1);
        if (error) return pageErr(`Failed to load receipts: ${error.message}`, showPrices);
        const fetched = data ?? [];
        const hasNewer = fetched.length > PAGE_SIZE;
        const rows = hasNewer ? fetched.slice(0, PAGE_SIZE) : fetched;
        const { samples, error: sErr } = await loadSamples(
            supabase,
            rows.map((r) => r.id ?? '').filter(Boolean),
        );
        if (sErr) return pageErr(sErr, showPrices);
        return {
            records: assemble(rows, samples, showPrices),
            hasOlder: true,
            hasNewer,
            canViewPrices: showPrices,
        };
    }

    // ── Cursor page ──────────────────────────────────────────────────────────────
    const cursor = input.cursor;
    const direction = input.direction ?? 'newer';
    if (!cursor) return pageErr('A cursor page needs a cursor.', showPrices);

    const asc = direction === 'newer';
    const { data, error } = await base()
        .or(keysetPredicate(cursor, direction))
        .order('delivery_date', { ascending: asc, nullsFirst: asc })
        .order('id', { ascending: asc })
        .limit(PAGE_SIZE + 1);
    if (error) return pageErr(`Failed to load receipts: ${error.message}`, showPrices);

    const fetched = data ?? [];
    const more = fetched.length > PAGE_SIZE;
    const clipped = more ? fetched.slice(0, PAGE_SIZE) : fetched;
    // The backward page came back newest-first — flip it so the caller always gets a
    // window in canonical (oldest-first) order and can prepend it wholesale.
    const rows = asc ? clipped : clipped.reverse();

    const { samples, error: sErr } = await loadSamples(
        supabase,
        rows.map((r) => r.id ?? '').filter(Boolean),
    );
    if (sErr) return pageErr(sErr, showPrices);

    return {
        records: assemble(rows, samples, showPrices),
        hasOlder: asc ? true : more,
        hasNewer: asc ? more : true,
        canViewPrices: showPrices,
    };
}

// ═══ READ — the focus scope (one month, whole) ══════════════════════════════════

export interface DeliveryMonth {
    records: DeliveryRecord[];
    canViewPrices: boolean;
    error?: string;
}

export async function fetchDeliveryMonth(
    period: DeliveryPeriod,
    issue: IssueLens | null = null,
    query = '',
): Promise<DeliveryMonth> {
    const supabase = await createClient();
    const showPrices = await canViewPrices();
    const { from, to } = periodBounds(period);

    const { data, error } = await buildRowQuery(supabase, issue, query)
        .gte('delivery_date', from)
        .lte('delivery_date', to)
        .order('delivery_date', { ascending: true, nullsFirst: true })
        .order('source_row', { ascending: true, nullsFirst: false })
        .order('id', { ascending: true });

    if (error) {
        return { records: [], canViewPrices: showPrices, error: `Failed to load the month: ${error.message}` };
    }
    const rows = data ?? [];
    const { samples, error: sErr } = await loadSamples(
        supabase,
        rows.map((r) => r.id ?? '').filter(Boolean),
    );
    if (sErr) return { records: [], canViewPrices: showPrices, error: sErr };

    return { records: assemble(rows, samples, showPrices), canViewPrices: showPrices };
}

// ═══ READ — dimensions + the month index ════════════════════════════════════════

export async function fetchDeliveryDimensions(): Promise<DeliveryDimensions & { error?: string }> {
    const supabase = await createClient();
    const [sup, dest] = await Promise.all([
        supabase
            .from('cenapro_rc_suppliers')
            .select('code, display_name, sort_order, active, notes, created_at, updated_at')
            .order('sort_order', { ascending: true }),
        supabase
            .from('cenapro_rc_destinations')
            .select('code, display_name, kind, has_sides, sort_order, active, notes, created_at, updated_at')
            .order('sort_order', { ascending: true }),
    ]);
    const error = sup.error?.message ?? dest.error?.message;
    return {
        suppliers: sup.data ?? [],
        destinations: dest.data ?? [],
        ...(error ? { error: `Failed to load the supplier/warehouse lists: ${error}` } : {}),
    };
}

/**
 * Every `YYYY-MM` that has at least one receipt, ascending — feeds the month picker.
 *
 * Derived from `delivery_year` + `delivery_date` rather than a GROUP BY, because
 * PostgREST cannot aggregate without a dedicated view and this module is not allowed to
 * add one. 991 dates is a trivial payload; the DISTINCT happens in one pass here.
 */
export async function fetchDeliveryMonthKeys(): Promise<{ monthKeys: string[]; error?: string }> {
    const supabase = await createClient();
    const { data, error } = await supabase
        .from('cenapro_rc_delivery_rows')
        .select('delivery_date')
        .not('delivery_date', 'is', null)
        .order('delivery_date', { ascending: true });
    if (error) return { monthKeys: [], error: `Failed to load the month list: ${error.message}` };
    const seen = new Set<string>();
    for (const r of data ?? []) {
        const d = r.delivery_date;
        if (d) seen.add(d.slice(0, 7));
    }
    return { monthKeys: [...seen] };
}

// ═══ WRITE ══════════════════════════════════════════════════════════════════════

/** The RPCs' jsonb return, before any of it is trusted. */
interface RawRpcResult {
    ok?: unknown;
    outcome?: unknown;
    id?: unknown;
    delivery_id?: unknown;
    row_version?: unknown;
    message?: unknown;
    samples_deleted?: unknown;
}

const OUTCOMES: readonly SaveOutcome[] = [
    'updated', 'inserted', 'saved', 'noop', 'version_conflict',
    'not_found', 'unsupported_field', 'invalid', 'rpc_error', 'forbidden',
];

function readOutcome(raw: unknown, fallback: SaveOutcome): SaveOutcome {
    return typeof raw === 'string' && (OUTCOMES as readonly string[]).includes(raw)
        ? (raw as SaveOutcome)
        : fallback;
}

function readVersion(raw: unknown): number | null {
    return typeof raw === 'number' && Number.isFinite(raw) ? raw : null;
}

function readMessage(raw: unknown): string | null {
    return typeof raw === 'string' && raw.trim() ? raw : null;
}

/** The ₱ patch keys a gated viewer must never be able to write. */
const PRICE_PATCH_KEYS = ['base_price_php_kg', 'price_adjustment_php_kg', 'price_formula'] as const;

export interface SaveDeliveriesResult {
    results: SaveDeliveryResult[];
    savedCount: number;
    failedCount: number;
}

/**
 * Save a batch of receipts. One RPC call per receipt for the field patch, plus one for
 * the sample block when it changed — sequenced, never parallel, because the patch bumps
 * the very `row_version` the samples call has to present.
 */
export async function saveDeliveries(inputs: SaveDeliveryInput[]): Promise<SaveDeliveriesResult> {
    const supabase = await createClient();
    const showPrices = await canViewPrices();
    const results: SaveDeliveryResult[] = [];

    for (const input of inputs) {
        const base = { id: input.id, label: input.label };

        // ₱ boundary: a viewer who cannot SEE a price cannot WRITE one. Refused here,
        // per receipt, rather than filtered silently — a silent drop would look like a
        // successful save that lost the operator's typing.
        if (!showPrices && input.patch) {
            const offending = PRICE_PATCH_KEYS.filter((k) => k in input.patch!);
            if (offending.length > 0) {
                results.push({
                    ...base,
                    ok: false,
                    outcome: 'forbidden',
                    rowVersion: null,
                    message: `Your role cannot edit price data (${offending.join(', ')}).`,
                });
                continue;
            }
        }

        let version = input.expectedRowVersion;
        let touched = false;

        // ── 1. The field patch ───────────────────────────────────────────────────
        if (input.patch && Object.keys(input.patch).length > 0) {
            const { data, error } = await supabase.rpc('cenapro_save_rc_delivery', {
                p_id: input.id,
                p_expected_row_version: version,
                p_patch: input.patch,
            });
            if (error) {
                results.push({ ...base, ok: false, outcome: 'rpc_error', rowVersion: null, message: error.message });
                continue;
            }
            const r = (data ?? {}) as RawRpcResult;
            const ok = r.ok === true;
            const nextVersion = readVersion(r.row_version);
            if (!ok) {
                results.push({
                    ...base,
                    ok: false,
                    outcome: readOutcome(r.outcome, 'rpc_error'),
                    rowVersion: nextVersion,
                    message: readMessage(r.message),
                });
                continue;
            }
            touched = true;
            if (nextVersion !== null) version = nextVersion;
        }

        // ── 2. The sample block (replace-in-full), on the FRESH version ───────────
        if (input.samples) {
            const { data, error } = await supabase.rpc('cenapro_save_rc_delivery_samples', {
                p_delivery_id: input.id,
                p_expected_row_version: version,
                p_samples: input.samples,
            });
            if (error) {
                results.push({ ...base, ok: false, outcome: 'rpc_error', rowVersion: version, message: error.message });
                continue;
            }
            const r = (data ?? {}) as RawRpcResult;
            const ok = r.ok === true;
            const nextVersion = readVersion(r.row_version);
            if (!ok) {
                results.push({
                    ...base,
                    ok: false,
                    outcome: readOutcome(r.outcome, 'rpc_error'),
                    rowVersion: nextVersion,
                    message: readMessage(r.message),
                });
                continue;
            }
            touched = true;
            if (nextVersion !== null) version = nextVersion;
        }

        results.push({
            ...base,
            ok: true,
            outcome: touched ? 'saved' : 'noop',
            rowVersion: version,
            message: null,
        });
    }

    if (results.some((r) => r.ok)) revalidatePath('/cenapro/deliveries');

    return {
        results,
        savedCount: results.filter((r) => r.ok).length,
        failedCount: results.filter((r) => !r.ok).length,
    };
}

export interface DeleteDeliveryResult {
    ok: boolean;
    outcome: SaveOutcome | 'deleted';
    samplesDeleted: number;
    message: string | null;
}

export async function deleteDelivery(
    id: string,
    expectedRowVersion: number,
): Promise<DeleteDeliveryResult> {
    const supabase = await createClient();
    const { data, error } = await supabase.rpc('cenapro_delete_rc_delivery', {
        p_id: id,
        p_expected_row_version: expectedRowVersion,
    });
    if (error) {
        return { ok: false, outcome: 'rpc_error', samplesDeleted: 0, message: error.message };
    }
    const r = (data ?? {}) as RawRpcResult;
    const ok = r.ok === true;
    if (ok) revalidatePath('/cenapro/deliveries');
    return {
        ok,
        outcome: ok ? 'deleted' : readOutcome(r.outcome, 'rpc_error'),
        samplesDeleted: typeof r.samples_deleted === 'number' ? r.samples_deleted : 0,
        message: readMessage(r.message),
    };
}
