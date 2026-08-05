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
    buildFilterPredicates,
    periodBounds,
    NO_FILTERS,
    type ColumnFilters,
    type DeliveryLens,
    type DeliveryPeriod,
    type IssueLens,
} from './ledger-url';

/** One keyset page. Sized to fill a tall viewport twice over without over-fetching. */
const PAGE_SIZE = 120;

/**
 * The duplicate lens is a WORKLIST, not a walk through history, and it is bounded on
 * purpose — see `duplicatePairs()` below.
 */
const DUPLICATE_WORKLIST_MAX = 600;

/**
 * The read model's column list. A SINGLE string literal on purpose — the typed
 * PostgREST client parses it at the type level, and `+`-concatenation defeats that
 * inference and collapses the row type to an error.
 */
const ROW_COLS =
    'id, delivery_date, delivery_date_raw, delivery_year, truck_no, supplier_code, supplier_name, supplier_origin, permit_no, supplier_raw, sacks, gross_weight_kg, deduction_pct, net_weight_kg, weight_formula, bd, moisture_pct, grit, ash, dust, vm, fc, destination_code, destination_name, destination_kind, destination_has_sides, destination_side, destination_raw, remarks, base_price_php_kg, price_adjustment_php_kg, price_php_kg, price_formula, total_price_php, sheet_total_php, sheet_total_matches, sample_count, sample_avg_moisture_pct, provenance, source_sheet, source_row, is_suspected_duplicate, import_flags, import_flag_count, has_import_flags, supplier_unresolved, destination_unresolved, row_version, created_at, created_by, updated_at, updated_by, duplicate_group_key, duplicate_group_size, duplicate_group_ordinal, duplicate_peer_ids, import_flags_state, unresolved_flag_count, resolved_flag_count, has_unresolved_flags';

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
 * The base read query with the issue lens, the per-column filters and the free-text
 * search already applied. All three are optional and AND together. Written as one
 * builder function (rather than a generic `applyLens` helper) so the PostgREST row type
 * is INFERRED end-to-end — a hand-written generic over the filter builder loses it and
 * collapses the row shape to an error type.
 *
 * The column filters are applied here, in SQL, and NOWHERE ELSE. Filtering the loaded
 * window in the browser would filter the ~120 rows the keyset pager happens to be
 * holding and silently claim that was the whole ledger.
 */
function buildRowQuery(
    supabase: Awaited<ReturnType<typeof createClient>>,
    lens: { issue: IssueLens | null; query: string; filters?: ColumnFilters },
    // `head`/`count` do not change the builder's STATIC type (verified in
    // `PostgrestQueryBuilder.select` — only the request method and one header move), so
    // the count query and the row query can share this one builder without a union.
    opts?: { count: 'exact'; head: true },
) {
    const { issue, query } = lens;
    const q = supabase.from('cenapro_rc_delivery_rows').select(ROW_COLS, opts);

    let out =
        // BOTH members of every duplicate pair. `is_suspected_duplicate` is the
        // importer's flag on the SECOND copy only, so filtering on it returned 22
        // orphans with their originals invisible — useless for the one decision this
        // lens exists to support. `duplicate_group_key IS NOT NULL` returns all 44.
        issue === 'duplicate'
            ? q.not('duplicate_group_key', 'is', null)
            : issue === 'flagged'
              // LIVE problems only — `has_unresolved_flags`, NOT `has_import_flags`.
              // A flag is never cleared (it is the only witness to what the workbook
              // literally said), so the historical boolean returned 12 receipts when
              // only 2 still had anything to do. A worklist that is five-sixths done
              // is a worklist nobody opens. `import_flags` is untouched and still
              // travels on every row — the popover shows the full history.
              ? q.eq('has_unresolved_flags', true)
              : issue === 'unmapped'
                ? q.or('supplier_unresolved.eq.true,destination_unresolved.eq.true')
                : issue === 'undated'
                  ? q.is('delivery_date', null)
                  : q;

    for (const p of buildFilterPredicates(lens.filters ?? NO_FILTERS)) {
        switch (p.op) {
            case 'in':
                out = out.in(p.column, p.values);
                break;
            case 'ilike':
                out = out.ilike(p.column, p.pattern);
                break;
            case 'gte':
                out = out.gte(p.column, p.value);
                break;
            case 'lte':
                out = out.lte(p.column, p.value);
                break;
        }
    }

    // Strip PostgREST's `or()` separators + wildcards so a comma or paren in the search
    // box cannot smuggle an extra predicate into the filter string.
    const safe = query.trim().replace(/[,()*\\.:]/g, ' ').trim();
    if (!safe) return out;

    const like = `*${safe}*`;
    return out.or(
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

/**
 * How many receipts the CURRENT lens+filters match, in total — not how many are loaded.
 *
 * A `head` request with `count: 'exact'`, so it costs one count and no payload. Run
 * only on an ANCHOR fetch (first paint, reset, refresh); a cursor page inherits the
 * number it was given, because the total cannot change by scrolling.
 */
async function countRows(
    supabase: Awaited<ReturnType<typeof createClient>>,
    lens: { issue: IssueLens | null; query: string; filters?: ColumnFilters },
): Promise<number | null> {
    const { count, error } = await buildRowQuery(supabase, lens, { count: 'exact', head: true });
    return error ? null : (count ?? null);
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
    /** Per-column filters, pushed into SQL. Every page MUST carry them or the walk drifts. */
    filters?: ColumnFilters;
}

export interface DeliveryPage {
    records: DeliveryRecord[];
    hasOlder: boolean;
    hasNewer: boolean;
    canViewPrices: boolean;
    /** How many receipts the lens+filters match in TOTAL. `null` on a cursor page. */
    totalCount?: number | null;
    notice?: string;
    error?: string;
}

function pageErr(message: string, showPrices = false): DeliveryPage {
    return { records: [], hasOlder: false, hasNewer: false, canViewPrices: showPrices, error: message };
}

/**
 * The `?issue=duplicate` lens, as a BOUNDED WORKLIST rather than a keyset walk.
 *
 * Two members of a pair have to sit next to each other or the lens cannot answer the
 * question it exists for ("is this really an exact copy of that row?"), and adjacency
 * needs the ordering `(delivery_date, duplicate_group_key, duplicate_group_ordinal)` —
 * which is NOT the `(delivery_date, id)` the keyset cursor is expressed in. A page walk
 * over one ordering with a cursor in another silently skips and repeats rows, so this
 * lens does not page at all: it returns the whole worklist in one window, with
 * `hasOlder`/`hasNewer` false so nothing ever asks for a cursor page.
 *
 * That is honest because the set is inherently small — it is an arbitration queue, not
 * history (22 pairs / 44 rows today). The cap is explicit and, if it is ever reached,
 * SAID OUT LOUD in the notice rather than silently truncating the operator's worklist.
 */
async function duplicatePairs(
    supabase: Awaited<ReturnType<typeof createClient>>,
    lens: DeliveryLens,
    showPrices: boolean,
): Promise<DeliveryPage> {
    const { data, error } = await buildRowQuery(supabase, lens)
        .order('delivery_date', { ascending: true, nullsFirst: true })
        .order('duplicate_group_key', { ascending: true, nullsFirst: false })
        .order('duplicate_group_ordinal', { ascending: true, nullsFirst: false })
        .order('id', { ascending: true })
        .limit(DUPLICATE_WORKLIST_MAX + 1);
    if (error) return pageErr(`Failed to load the duplicate pairs: ${error.message}`, showPrices);

    const fetched = data ?? [];
    const clipped = fetched.length > DUPLICATE_WORKLIST_MAX ? fetched.slice(0, DUPLICATE_WORKLIST_MAX) : fetched;
    const { samples, error: sErr } = await loadSamples(
        supabase,
        clipped.map((r) => r.id ?? '').filter(Boolean),
    );
    if (sErr) return pageErr(sErr, showPrices);

    const totalCount = await countRows(supabase, lens);
    return {
        records: assemble(clipped, samples, showPrices),
        hasOlder: false,
        hasNewer: false,
        canViewPrices: showPrices,
        totalCount,
        ...(fetched.length > DUPLICATE_WORKLIST_MAX
            ? {
                  notice: `More than ${DUPLICATE_WORKLIST_MAX} receipts are part of a duplicate pair — only the first ${DUPLICATE_WORKLIST_MAX} are shown. Narrow the view with a column filter.`,
              }
            : {}),
    };
}

export async function fetchDeliveryPage(input: DeliveryPageInput): Promise<DeliveryPage> {
    const supabase = await createClient();
    const showPrices = await canViewPrices();
    const lens: DeliveryLens = {
        issue: input.issue ?? null,
        query: input.query ?? '',
        filters: input.filters ?? NO_FILTERS,
    };

    const base = () => buildRowQuery(supabase, lens);

    // The duplicate lens is its own shape entirely — one window, paired ordering, no
    // cursor. Handled before the anchor/cursor split so `reset`, `refreshWindow` and a
    // stray cursor request all land on the same answer.
    if (lens.issue === 'duplicate') return duplicatePairs(supabase, lens, showPrices);

    // ── Initial anchored page ────────────────────────────────────────────────────
    if (input.mode === 'anchor') {
        const anchor = input.anchor ?? { kind: 'latest' };

        // 'latest' → the FINAL page (query DESC, limit, reverse to asc) so the sheet
        // opens at the bottom, on the newest receipts. Nothing is newer; a full page
        // implies history above.
        if (anchor.kind === 'latest') {
            // The count is independent of the page — one round trip, not two in series.
            const [{ data, error }, totalCount] = await Promise.all([
                base()
                    .order('delivery_date', { ascending: false, nullsFirst: false })
                    .order('id', { ascending: false })
                    .limit(PAGE_SIZE),
                countRows(supabase, lens),
            ]);
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
                totalCount,
            };
        }

        // 'period' → anchor at the month's FIRST matching receipt, then load forward
        // INCLUSIVE. The month is a jump target only; the window still spans all history
        // in both directions from there.
        const { from } = periodBounds({ year: anchor.year, month: anchor.month });
        const [{ data: firstRows, error: firstErr }, totalCount] = await Promise.all([
            base()
                .gte('delivery_date', from)
                .order('delivery_date', { ascending: true, nullsFirst: true })
                .order('id', { ascending: true })
                .limit(1),
            countRows(supabase, lens),
        ]);
        if (firstErr) return pageErr(`Failed to resolve the month anchor: ${firstErr.message}`, showPrices);

        const first = firstRows?.[0];
        if (!first) {
            const fallback = await fetchDeliveryPage({
                mode: 'anchor',
                anchor: { kind: 'latest' },
                issue: lens.issue,
                query: lens.query,
                filters: lens.filters,
            });
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
            totalCount,
        };
    }

    // ── Cursor page ──────────────────────────────────────────────────────────────
    //
    // A filter changes nothing here, and that is the point: every predicate is a plain
    // conjunct on the SAME `ORDER BY (delivery_date, id)`, so the cursor still names a
    // unique position in the filtered set and the walk just steps over a sparser one.
    // What WOULD break it is a page that forgot the filters — hence `input.filters` is
    // threaded through every call site, including the hook's `lensRef`.
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
        totalCount: null,
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
    filters: ColumnFilters = NO_FILTERS,
): Promise<DeliveryMonth> {
    const supabase = await createClient();
    const showPrices = await canViewPrices();
    const { from, to } = periodBounds(period);
    const lens: DeliveryLens = { issue, query, filters };

    const scoped = buildRowQuery(supabase, lens)
        .gte('delivery_date', from)
        .lte('delivery_date', to);

    // Under the duplicate lens the two members of a pair must be ADJACENT, and
    // `source_row` is precisely what differs between an original and its paste (639 vs
    // 664) — ordering by it would put the two halves of a pair pages apart. The focus
    // scope loads a whole month in one query, so there is no cursor to keep in step and
    // the ordering can simply change.
    const ordered =
        issue === 'duplicate'
            ? scoped
                  .order('delivery_date', { ascending: true, nullsFirst: true })
                  .order('duplicate_group_key', { ascending: true, nullsFirst: false })
                  .order('duplicate_group_ordinal', { ascending: true, nullsFirst: false })
                  .order('id', { ascending: true })
            : scoped
                  .order('delivery_date', { ascending: true, nullsFirst: true })
                  .order('source_row', { ascending: true, nullsFirst: false })
                  .order('id', { ascending: true });

    const { data, error } = await ordered;

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

function readId(raw: unknown): string | null {
    return typeof raw === 'string' && raw.trim() ? raw : null;
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
 *
 * An input with `id: null` is a DRAFT row from the bottom of the sheet. The RPC takes
 * that as an INSERT, and refuses the call outright if an expected version rides along —
 * so both `p_id` and `p_expected_row_version` are OMITTED rather than sent as null (the
 * generated Args type makes them optional, which is exactly the shape the insert branch
 * wants). The new id and version come back on the result so the client can turn the
 * draft into a real row without a second save re-inserting it.
 */
export async function saveDeliveries(inputs: SaveDeliveryInput[]): Promise<SaveDeliveriesResult> {
    const supabase = await createClient();
    const showPrices = await canViewPrices();
    const results: SaveDeliveryResult[] = [];

    for (const input of inputs) {
        const base = { key: input.key, id: input.id, label: input.label };
        const isInsert = input.id === null;

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

        let id = input.id;
        let version = input.expectedRowVersion;
        let touched = false;

        // ── 1. The field patch (or the insert) ───────────────────────────────────
        if (input.patch && Object.keys(input.patch).length > 0) {
            const { data, error } = await supabase.rpc(
                'cenapro_save_rc_delivery',
                isInsert
                    ? { p_patch: input.patch }
                    : { p_id: input.id!, p_expected_row_version: version ?? undefined, p_patch: input.patch },
            );
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
            id = readId(r.id) ?? id;
        } else if (isInsert) {
            // A draft with nothing in its patch has nothing to insert. Refused rather
            // than silently reported as saved — the client already filters these out,
            // so reaching here means the two disagree and the operator should be told.
            results.push({
                ...base,
                ok: false,
                outcome: 'invalid',
                rowVersion: null,
                message: 'A new receipt needs at least one value.',
            });
            continue;
        }

        // ── 2. The sample block (replace-in-full), on the FRESH version ───────────
        if (input.samples && id !== null && version !== null) {
            const { data, error } = await supabase.rpc('cenapro_save_rc_delivery_samples', {
                p_delivery_id: id,
                p_expected_row_version: version,
                p_samples: input.samples,
            });
            if (error) {
                results.push({ ...base, id, ok: false, outcome: 'rpc_error', rowVersion: version, message: error.message });
                continue;
            }
            const r = (data ?? {}) as RawRpcResult;
            const ok = r.ok === true;
            const nextVersion = readVersion(r.row_version);
            if (!ok) {
                results.push({
                    ...base,
                    id,
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
            id,
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
