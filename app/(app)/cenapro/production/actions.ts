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
