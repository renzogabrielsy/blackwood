'use server';

import { revalidatePath } from 'next/cache';
import { createClient } from '@/lib/supabase/server';
import type { Database } from '@/types/supabase';
import type { ProductionEventRow } from '../types';

// The auto-updatable VIEW's generated Insert shape. Identical to Update (same view),
// so we reuse it for both the upsert payload and the typed coercion below.
type ProductionEventInsert =
    Database['public']['Views']['cenapro_production_events']['Insert'];

// ─── Period (batch_year + batch) ─────────────────────────────────────────────────
// A cenapro "period" is one production batch: a month name (JANUARY…DECEMBER) within
// a batch_year. The production ledger loads ONE period at a time (752+ rows rendered
// at once with no virtualization was the perf bottleneck), so we need both the list
// of available periods (picker options) and a way to scope the row fetch to one.
export interface CenaproPeriod {
    batch_year: number;
    batch: string;
}

// Month name → calendar index (1-12) for deterministic newest-first ordering. Unknown
// batch names sort last (index 99) so a stray value never wins "latest".
const MONTH_INDEX: Record<string, number> = {
    JANUARY: 1, FEBRUARY: 2, MARCH: 3, APRIL: 4, MAY: 5, JUNE: 6,
    JULY: 7, AUGUST: 8, SEPTEMBER: 9, OCTOBER: 10, NOVEMBER: 11, DECEMBER: 12,
};

function monthIndex(batch: string): number {
    return MONTH_INDEX[batch?.toUpperCase?.() ?? ''] ?? 99;
}

// ─── Fetch available periods ─────────────────────────────────────────────────────
// Returns the DISTINCT (batch_year, batch) pairs present in the production-event view,
// sorted NEWEST-FIRST (year desc, then calendar month desc). The picker renders these
// as options; the page treats `periods[0]` as the default selection when the URL
// carries no `?year=&batch=`. Lightweight — only the two key columns are selected and
// the distinct set is tiny.
export async function fetchCenaproPeriods(): Promise<{
    periods?: CenaproPeriod[];
    error?: string;
}> {
    const supabase = await createClient();

    // PostgREST has no DISTINCT, so select just the two key columns and dedupe in JS.
    // The column count keeps the payload small even before dedupe.
    const { data, error } = await supabase
        .from('cenapro_production_events')
        .select('batch_year, batch');

    if (error) {
        return { error: `Failed to load Cenapro periods: ${error.message}` };
    }

    const seen = new Set<string>();
    const periods: CenaproPeriod[] = [];
    for (const row of data ?? []) {
        // Skip rows missing either key — they can't form a selectable period.
        if (row.batch_year == null || !row.batch) continue;
        const key = `${row.batch_year}|${row.batch}`;
        if (seen.has(key)) continue;
        seen.add(key);
        periods.push({ batch_year: row.batch_year, batch: row.batch });
    }

    // Newest-first: most recent year on top; within a year, latest calendar month on top.
    periods.sort((a, b) => {
        if (a.batch_year !== b.batch_year) return b.batch_year - a.batch_year;
        return monthIndex(b.batch) - monthIndex(a.batch);
    });

    return { periods };
}

// ─── Fetch production events for ONE period ──────────────────────────────────────
// Read path. Returns the cenapro production-event rows for a single (batch_year, batch)
// period, ordered newest-first by recv_date. Scoping to one period server-side is the
// primary perf fix — the grid renders ~30-160 rows instead of all 750+, and editing a
// cell no longer re-renders the whole sheet. Filtering/sorting WITHIN the period is
// still done client-side (the per-period dataset is small).
//
// `batch_year`/`batch` are optional so a first paint with no resolved period yet (or a
// malformed URL) returns an empty set rather than every row. The page resolves the
// default period (newest, from `fetchCenaproPeriods`) before calling this.
//
// Data path: the `public.cenapro_production_events` VIEW — an auto-updatable accessor
// in the already-served `public` schema. The normal Supabase client reaches it
// directly (no `.schema('cenapro')`, no cast).
export async function fetchProductionEvents(period?: {
    batch_year?: number | null;
    batch?: string | null;
}): Promise<{
    data?: ProductionEventRow[];
    error?: string;
}> {
    const supabase = await createClient();

    // No valid period → nothing to load (avoid the old 750-row firehose). The page
    // only reaches here without a period when there are no periods at all.
    if (period?.batch_year == null || !period.batch) {
        return { data: [] };
    }

    // The column list MUST be a single string literal (not `+`-concatenated): the
    // typed PostgREST client parses it at the type level to infer the row shape,
    // and a concatenated string defeats that inference (falls back to an error type).
    const { data, error } = await supabase
        .from('cenapro_production_events')
        .select(
            'id, recv_date, prod_date, batch, batch_year, shift_code, grade_code, plant_code, warehouse_code, source_location_code, weight_kg, disposition_kind, partner_equipment_code, flec_count, whse_side, unique_tag',
        )
        .eq('batch_year', period.batch_year)
        .eq('batch', period.batch)
        .order('recv_date', { ascending: false });

    if (error) {
        return { error: `Failed to load Cenapro production events: ${error.message}` };
    }

    return { data: data ?? [] };
}

// ─── Endless sheet: keyset-paginated ledger reads ───────────────────────────────
// The "endless sheet" (production-endless-sheet.tsx) is ONE continuous, virtualized,
// read-only view of the ENTIRE cenapro_production_events history, ordered oldest-first
// (`recv_date ASC, id ASC`), lazy-loaded bidirectionally with keyset (cursor)
// pagination. The dropdown period picker is a JUMP-TO anchor, NOT a filter — the first
// query is already anchored at the selected period, never "load from the beginning then
// teleport".
//
// Cursor = the composite `(recv_date, id)` of a boundary row — `recv_date` primary,
// `id` (a stable uuid string) as the tiebreaker. The view has NO created_at, so this
// pair is the canonical total order. PostgREST types all view columns nullable; real
// rows are non-null, and we coalesce defensively when building filter strings.

const LEDGER_PAGE_SIZE = 100;

// An anchor selects WHERE the initial window opens.
//   • 'latest' → the newest rows (bottom of the oldest-first sheet) — the default.
//   • 'period' → the first (oldest) row of a (batch_year, batch) period, loading forward.
export type LedgerAnchor =
    | { kind: 'latest' }
    | { kind: 'period'; batch_year: number; batch: string };

// The boundary row a subsequent page pages off of.
export interface LedgerCursor {
    recv_date: string;
    id: string;
}

// One page request: either an initial anchored page, or a cursored older/newer page.
export type LedgerPageInput =
    | { mode: 'anchor'; anchor: LedgerAnchor }
    | { mode: 'cursor'; cursor: LedgerCursor; direction: 'older' | 'newer' };

// One page result. `rows` is ALWAYS oldest-first (canonical order), regardless of the
// direction fetched (DESC fetches are reversed in memory before returning). `hasOlder` /
// `hasNewer` report whether more rows exist beyond each edge of THIS page — the client
// hook consumes only the flag relevant to the direction it just fetched. `notice` is an
// optional info string (e.g. an empty jumped-to period). `error` (when present) is a
// single copyable string for errorToast (HARD RULE: persistent + Copy).
export interface LedgerPage {
    rows: ProductionEventRow[];
    hasOlder: boolean;
    hasNewer: boolean;
    notice?: string;
    error?: string;
}

// The single-string-literal column list. MUST match fetchProductionEvents exactly and
// stay a lone literal passed straight to `.select(...)` — the typed PostgREST client
// parses it at the type level to infer ProductionEventRow; a const/concatenated string
// defeats that inference (falls back to an error type).
async function ledgerErr(msg: string): Promise<LedgerPage> {
    return { rows: [], hasOlder: false, hasNewer: false, error: msg };
}

export async function fetchLedgerPage(input: LedgerPageInput): Promise<LedgerPage> {
    const supabase = await createClient();

    // ── Initial anchored page ────────────────────────────────────────────────────
    if (input.mode === 'anchor') {
        const anchor = input.anchor;

        // 'latest' → load the FINAL page (query DESC, limit, then reverse to asc) so the
        // view opens at the BOTTOM (newest rows). No newer rows exist beyond the end;
        // a full page implies there's older history above.
        if (anchor.kind === 'latest') {
            const { data, error } = await supabase
                .from('cenapro_production_events')
                .select(
                    'id, recv_date, prod_date, batch, batch_year, shift_code, grade_code, plant_code, warehouse_code, source_location_code, weight_kg, disposition_kind, partner_equipment_code, flec_count, whse_side, unique_tag',
                )
                .order('recv_date', { ascending: false })
                .order('id', { ascending: false })
                .limit(LEDGER_PAGE_SIZE);
            if (error) return ledgerErr(`Failed to load ledger page: ${error.message}`);
            const fetched = data ?? [];
            const hasOlder = fetched.length === LEDGER_PAGE_SIZE;
            return { rows: fetched.reverse(), hasOlder, hasNewer: false };
        }

        // 'period' → anchor at the period's FIRST (oldest, canonical-order) row, then
        // load forward INCLUSIVE (>= that row). The period is a jump target only; the
        // window still spans all history in both directions from there.
        const { data: firstRows, error: firstErr } = await supabase
            .from('cenapro_production_events')
            .select(
                'id, recv_date, prod_date, batch, batch_year, shift_code, grade_code, plant_code, warehouse_code, source_location_code, weight_kg, disposition_kind, partner_equipment_code, flec_count, whse_side, unique_tag',
            )
            .eq('batch_year', anchor.batch_year)
            .eq('batch', anchor.batch)
            .order('recv_date', { ascending: true })
            .order('id', { ascending: true })
            .limit(1);
        if (firstErr) return ledgerErr(`Failed to resolve period anchor: ${firstErr.message}`);

        const first = firstRows?.[0];
        if (!first) {
            // Empty jumped-to period (edge case — the picker only offers periods that
            // exist in data). Show nothing but an inline notice rather than a blank void.
            return {
                rows: [],
                hasOlder: false,
                hasNewer: false,
                notice: `No entries in ${anchor.batch} ${anchor.batch_year}`,
            };
        }

        const d = first.recv_date ?? '';
        const i = first.id ?? '';
        const { data, error } = await supabase
            .from('cenapro_production_events')
            .select(
                'id, recv_date, prod_date, batch, batch_year, shift_code, grade_code, plant_code, warehouse_code, source_location_code, weight_kg, disposition_kind, partner_equipment_code, flec_count, whse_side, unique_tag',
            )
            .or(`recv_date.gt.${d},and(recv_date.eq.${d},id.gte.${i})`)
            .order('recv_date', { ascending: true })
            .order('id', { ascending: true })
            .limit(LEDGER_PAGE_SIZE + 1);
        if (error) return ledgerErr(`Failed to load ledger page: ${error.message}`);
        const fetched = data ?? [];
        const hasNewer = fetched.length > LEDGER_PAGE_SIZE;
        const rows = fetched.slice(0, LEDGER_PAGE_SIZE);

        // hasOlder: anything strictly BEFORE the period's first row (older months)?
        const { count, error: probeErr } = await supabase
            .from('cenapro_production_events')
            .select('id', { count: 'exact', head: true })
            .or(`recv_date.lt.${d},and(recv_date.eq.${d},id.lt.${i})`);
        if (probeErr) return ledgerErr(`Failed to probe ledger history: ${probeErr.message}`);

        return { rows, hasOlder: (count ?? 0) > 0, hasNewer };
    }

    // ── Cursored older/newer page ────────────────────────────────────────────────
    const { recv_date: d, id: i } = input.cursor;

    if (input.direction === 'older') {
        // Rows strictly BEFORE the cursor. Fetch DESC (limit+1 to probe), then reverse
        // to canonical asc for return.
        const { data, error } = await supabase
            .from('cenapro_production_events')
            .select(
                'id, recv_date, prod_date, batch, batch_year, shift_code, grade_code, plant_code, warehouse_code, source_location_code, weight_kg, disposition_kind, partner_equipment_code, flec_count, whse_side, unique_tag',
            )
            .or(`recv_date.lt.${d},and(recv_date.eq.${d},id.lt.${i})`)
            .order('recv_date', { ascending: false })
            .order('id', { ascending: false })
            .limit(LEDGER_PAGE_SIZE + 1);
        if (error) return ledgerErr(`Failed to load earlier entries: ${error.message}`);
        const fetched = data ?? [];
        const hasOlder = fetched.length > LEDGER_PAGE_SIZE;
        const rows = fetched.slice(0, LEDGER_PAGE_SIZE).reverse();
        return { rows, hasOlder, hasNewer: false };
    }

    // direction === 'newer' → rows strictly AFTER the cursor, already canonical asc.
    const { data, error } = await supabase
        .from('cenapro_production_events')
        .select(
            'id, recv_date, prod_date, batch, batch_year, shift_code, grade_code, plant_code, warehouse_code, source_location_code, weight_kg, disposition_kind, partner_equipment_code, flec_count, whse_side, unique_tag',
        )
        .or(`recv_date.gt.${d},and(recv_date.eq.${d},id.gt.${i})`)
        .order('recv_date', { ascending: true })
        .order('id', { ascending: true })
        .limit(LEDGER_PAGE_SIZE + 1);
    if (error) return ledgerErr(`Failed to load newer entries: ${error.message}`);
    const fetched = data ?? [];
    const hasNewer = fetched.length > LEDGER_PAGE_SIZE;
    const rows = fetched.slice(0, LEDGER_PAGE_SIZE);
    return { rows, hasOlder: false, hasNewer };
}

// ─── Dirty-row payload (client → server) ─────────────────────────────────────────
// One entry per new/modified grid row. The client sends raw editable fields as
// strings (grid cells are text); the server coerces numbers/dates and strips empties
// to null. `id` present → UPDATE that view row; absent → INSERT a fresh one. The base
// trigger computes `unique_tag` + `batch_year` — both are READ-ONLY and never sent.
export interface ProductionEventDirtyRow {
    id?: string | null;
    recv_date: string;
    prod_date: string;
    batch: string;
    shift_code: string;
    grade_code: string;
    plant_code: string;
    warehouse_code: string;
    source_location_code: string;
    weight_kg: string;
    disposition_kind: string;
    partner_equipment_code: string;
    flec_count: string;
    whse_side: string;
}

// ─── Coercion helpers ────────────────────────────────────────────────────────────
// Grid cells are strings. Empty/whitespace → null; otherwise trimmed. Numerics parse
// to finite numbers (NaN → null so the DB never receives garbage).
function textOrNull(v: string | null | undefined): string | null {
    if (v === null || v === undefined) return null;
    const t = v.trim();
    return t === '' ? null : t;
}

function numOrNull(v: string | null | undefined): number | null {
    if (v === null || v === undefined) return null;
    const t = v.trim();
    if (t === '') return null;
    const n = Number(t);
    return Number.isFinite(n) ? n : null;
}

// ─── Save (upsert + delete) ──────────────────────────────────────────────────────
// Writes through the auto-updatable VIEW: dirty rows are upserted (id → UPDATE,
// no id → INSERT) and deletedIds are removed. The base trigger fills unique_tag +
// batch_year, so we never send those. Errors are returned as a single string for the
// client to surface via errorToast (HARD RULE: persistent + Copy). The DB enforces a
// partner-equipment-presence CHECK (equipment required when disposition ≠
// flec_bagging); the client guards first, but a violation here is surfaced verbatim.
export async function saveProductionEvents(
    dirtyRows: ProductionEventDirtyRow[],
    deletedIds: string[],
): Promise<{
    ok: boolean;
    error?: string;
    upserted?: number;
    deleted?: number;
}> {
    const supabase = await createClient();

    // ─── Delete first (so a row deleted in the same save can't collide on re-insert) ─
    let deleted = 0;
    const idsToDelete = deletedIds.filter((id) => id && id.trim() !== '');
    if (idsToDelete.length > 0) {
        const { error: delError } = await supabase
            .from('cenapro_production_events')
            .delete()
            .in('id', idsToDelete);
        if (delError) {
            return { ok: false, error: `Failed to delete production rows: ${delError.message}` };
        }
        deleted = idsToDelete.length;
    }

    // ─── Upsert dirty rows ───────────────────────────────────────────────────────
    let upserted = 0;
    if (dirtyRows.length > 0) {
        // Coerce each dirty row to the view's Insert shape. NOTE: never send
        // unique_tag / batch_year — the base trigger computes them. For INSERT rows
        // (no id) we omit `id` entirely so the base default generates it.
        const payload: ProductionEventInsert[] = dirtyRows.map((r) => {
            const base: ProductionEventInsert = {
                recv_date: textOrNull(r.recv_date),
                prod_date: textOrNull(r.prod_date),
                batch: textOrNull(r.batch),
                shift_code: textOrNull(r.shift_code),
                grade_code: textOrNull(r.grade_code),
                plant_code: textOrNull(r.plant_code),
                warehouse_code: textOrNull(r.warehouse_code),
                source_location_code: textOrNull(r.source_location_code),
                weight_kg: numOrNull(r.weight_kg),
                disposition_kind: textOrNull(r.disposition_kind),
                partner_equipment_code: textOrNull(r.partner_equipment_code),
                flec_count: numOrNull(r.flec_count),
                whse_side: textOrNull(r.whse_side),
            };
            const id = textOrNull(r.id);
            return id ? { ...base, id } : base;
        });

        const { error: upsertError } = await supabase
            .from('cenapro_production_events')
            .upsert(payload);

        if (upsertError) {
            return { ok: false, error: `Failed to save production rows: ${upsertError.message}` };
        }
        upserted = payload.length;
    }

    if (upserted === 0 && deleted === 0) {
        return { ok: true, upserted: 0, deleted: 0 };
    }

    revalidatePath('/cenapro/production');
    return { ok: true, upserted, deleted };
}
