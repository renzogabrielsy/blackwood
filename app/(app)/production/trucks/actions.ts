'use server';

import { revalidatePath } from 'next/cache';
import { createClient } from '@/lib/supabase/server';
import type { Tables, TablesInsert, TablesUpdate } from '@/types/supabase';
import { format } from 'date-fns';
import type { BulkSavePayload } from '../daily/actions';

export type TruckReadingRow = Tables<'truck_readings'>;
export type TruckMonthlyRow = Tables<'view_trucks_monthly'>;

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

export async function fetchTrucksTabData(year?: number, month?: number) {
    const supabase = await createClient();
    const now = new Date();
    const targetYear = year ?? now.getFullYear();
    const targetMonth = month ?? now.getMonth();

    const startDate = format(new Date(targetYear, targetMonth, 1), 'yyyy-MM-dd');
    const endDate = format(new Date(targetYear, targetMonth + 1, 0), 'yyyy-MM-dd');

    const [readingsRes, monthlyRes] = await Promise.all([
        supabase
            .from('truck_readings')
            .select('*')
            .gte('reading_date', startDate)
            .lte('reading_date', endDate)
            .order('reading_date', { ascending: false })
            .order('plate_no', { ascending: true }),
        supabase
            .from('view_trucks_monthly')
            .select('*')
            .order('month', { ascending: false }),
    ]);

    if (readingsRes.error) return { error: `Failed to load truck readings: ${readingsRes.error.message}` };
    if (monthlyRes.error) return { error: `Failed to load monthly summary: ${monthlyRes.error.message}` };

    return {
        data: {
            readings: readingsRes.data ?? [],
            monthly: monthlyRes.data ?? [],
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
        const { error } = await supabase.from('truck_readings').update(data).eq('id', id);
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
