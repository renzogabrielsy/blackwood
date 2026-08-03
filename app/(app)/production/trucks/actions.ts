'use server';

import { revalidatePath } from 'next/cache';
import { createClient } from '@/lib/supabase/server';
import type { Tables, TablesInsert, TablesUpdate } from '@/types/supabase';
import { format } from 'date-fns';
// Shared generic for bulk save operations across all production modules
export type BulkSavePayload<TInsert, TUpdate> = {
    inserts: TInsert[];
    updates: { id: string; data: TUpdate }[];
    deletes: string[];
};

export type TruckReadingRow = Tables<'truck_readings'>;

// Human-edit latch: every in-app write CLAIMS the row, so the sync will not overwrite it
// (migration `20260803080000_production_human_edit_guard.sql`). The DB trigger
// `fn_stamp_human_edit` is the real guarantee — including `human_edited_by` from
// `auth.uid()`; this keeps the claim visible at the call site. Hand a row back with
// `releaseProductionRows` in `app/(app)/production/actions.ts`.
const claim = () => ({ human_edited_at: new Date().toISOString() });

function translateDbError(message: string): string {
    if (message.includes('chk_truck_readings_end_km')) {
        return 'End KM must be greater than or equal to Start KM.';
    }
    if (message.includes('chk_truck_readings_fuel')) {
        return 'Fuel liters must be 0 or greater.';
    }
    return message;
}

// ─── Fetch ────────────────────────────────────────────────────────────────────
// Filtered by the shared production period (year + month derived from the batch):
// - year=null              → all readings (no date filter)
// - year=<num>, month=null → all readings in that calendar year
// - year=<num>, month=<n>  → readings in that month of that year
// month is the 0-indexed month (the lazy tab derives it from the batch name).

export async function fetchTrucksTabData(
    year?: number | null,
    month?: number | null,
) {
    const supabase = await createClient();
    // Treat `undefined` as "not provided" → fall back to current period for
    // backwards compatibility; explicit `null` means "all".
    const now = new Date();
    const targetYear = year !== undefined ? year : now.getFullYear();
    const targetMonth = month !== undefined ? month : now.getMonth();

    let query = supabase.from('truck_readings').select('*');

    if (targetYear != null) {
        if (targetMonth != null) {
            // Specific month within the year
            const startDate = format(new Date(targetYear, targetMonth, 1), 'yyyy-MM-dd');
            const endDate = format(new Date(targetYear, targetMonth + 1, 0), 'yyyy-MM-dd');
            query = query.gte('reading_date', startDate).lte('reading_date', endDate);
        } else {
            // Whole year
            const startDate = format(new Date(targetYear, 0, 1), 'yyyy-MM-dd');
            const endDate = format(new Date(targetYear, 11, 31), 'yyyy-MM-dd');
            query = query.gte('reading_date', startDate).lte('reading_date', endDate);
        }
    }
    // targetYear == null → no date filter (all readings)

    const readingsRes = await query
        .order('reading_date', { ascending: false })
        .order('plate_no', { ascending: true });

    if (readingsRes.error) return { error: `Failed to load truck readings: ${readingsRes.error.message}` };

    return {
        data: {
            readings: readingsRes.data ?? [],
            year: targetYear,
            month: targetMonth,
        },
    };
}

// ─── Bulk Save — Trucks ───────────────────────────────────────────────────────

export async function saveBulkTrucks(
    payload: BulkSavePayload<TablesInsert<'truck_readings'>, TablesUpdate<'truck_readings'>>
) {
    const supabase = await createClient();

    for (let i = 0; i < payload.inserts.length; i++) {
        const r = payload.inserts[i];
        if (!r.reading_date) return { ok: false, error: `Insert row ${i + 1}: Date is required.` };
        if (!r.plate_no?.trim()) return { ok: false, error: `Insert row ${i + 1}: Plate number is required.` };
        if (Number(r.end_km) < Number(r.start_km)) {
            return { ok: false, error: `Insert row ${i + 1}: End KM must be ≥ Start KM.` };
        }
        if (r.fuel_liters !== null && r.fuel_liters !== undefined && Number(r.fuel_liters) < 0) {
            return { ok: false, error: `Insert row ${i + 1}: Fuel liters must be 0 or greater.` };
        }
    }

    let insertedCount = 0;
    let updatedCount = 0;
    let deletedCount = 0;

    if (payload.inserts.length > 0) {
        const { error } = await supabase.from('truck_readings').insert(
            payload.inserts.map(r => ({
                ...r,
                start_km: Number(r.start_km),
                end_km: Number(r.end_km),
                fuel_liters: r.fuel_liters !== null && r.fuel_liters !== undefined ? Number(r.fuel_liters) : null,
                ...claim(),
            }))
        );
        if (error) return { ok: false, error: translateDbError(error.message) };
        insertedCount = payload.inserts.length;
    }

    for (const { id, data } of payload.updates) {
        if (data.end_km !== undefined && data.start_km !== undefined) {
            if (Number(data.end_km) < Number(data.start_km)) {
                return { ok: false, error: 'End KM must be ≥ Start KM.' };
            }
        }
        const { error } = await supabase
            .from('truck_readings')
            .update({ ...data, ...claim() })
            .eq('id', id);
        if (error) return { ok: false, error: translateDbError(error.message) };
        updatedCount++;
    }

    for (const id of payload.deletes) {
        const { error } = await supabase.from('truck_readings').delete().eq('id', id);
        if (error) return { ok: false, error: error.message };
        deletedCount++;
    }

    revalidatePath('/production');
    return { ok: true, insertedCount, updatedCount, deletedCount };
}
