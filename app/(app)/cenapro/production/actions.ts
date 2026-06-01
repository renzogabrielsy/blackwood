'use server';

import { revalidatePath } from 'next/cache';
import { createClient } from '@/lib/supabase/server';
import type { Database } from '@/types/supabase';
import type { ProductionEventRow } from '../types';

// The auto-updatable VIEW's generated Insert shape. Identical to Update (same view),
// so we reuse it for both the upsert payload and the typed coercion below.
type ProductionEventInsert =
    Database['public']['Views']['cenapro_production_events']['Insert'];

// ─── Fetch all production events ─────────────────────────────────────────────────
// Read path. Returns the full cenapro production-event spine ordered newest-first by
// recv_date. Filtering/sorting beyond this is done client-side (the dataset is small
// enough that one fetch + browser-side filtering is snappier than per-filter trips).
//
// Data path: the `public.cenapro_production_events` VIEW — an auto-updatable accessor
// in the already-served `public` schema. The normal Supabase client reaches it
// directly (no `.schema('cenapro')`, no cast).
export async function fetchProductionEvents(): Promise<{
    data?: ProductionEventRow[];
    error?: string;
}> {
    const supabase = await createClient();

    // The column list MUST be a single string literal (not `+`-concatenated): the
    // typed PostgREST client parses it at the type level to infer the row shape,
    // and a concatenated string defeats that inference (falls back to an error type).
    const { data, error } = await supabase
        .from('cenapro_production_events')
        .select(
            'id, recv_date, prod_date, batch, batch_year, shift_code, grade_code, plant_code, warehouse_code, source_location_code, weight_kg, disposition_kind, partner_equipment_code, flec_count, whse_side, unique_tag',
        )
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
