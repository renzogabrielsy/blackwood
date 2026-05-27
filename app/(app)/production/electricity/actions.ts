'use server';

import { revalidatePath } from 'next/cache';
import { createClient } from '@/lib/supabase/server';
import type { Tables, TablesInsert, TablesUpdate } from '@/types/supabase';
import { format } from 'date-fns';
import type { BulkSavePayload } from '../daily/actions';

export type ElectricityReadingRow = Tables<'electricity_readings'>;
export type ElectricityMonthlyRow = Tables<'view_electricity_monthly'>;

function translateDbError(message: string): string {
    if (message.includes('chk_electricity_readings_end_kwh')) {
        return 'End KWH must be greater than or equal to Start KWH.';
    }
    if (message.includes('unique') || message.includes('duplicate')) {
        return 'A reading for this meter on this date already exists.';
    }
    return message;
}

// ─── Fetch ────────────────────────────────────────────────────────────────────

export async function fetchElectricityTabData(year?: number, month?: number) {
    const supabase = await createClient();
    const now = new Date();
    const targetYear = year ?? now.getFullYear();
    const targetMonth = month ?? now.getMonth();

    const startDate = format(new Date(targetYear, targetMonth, 1), 'yyyy-MM-dd');
    const endDate = format(new Date(targetYear, targetMonth + 1, 0), 'yyyy-MM-dd');

    const [readingsRes, monthlyRes] = await Promise.all([
        supabase
            .from('electricity_readings')
            .select('*')
            .gte('reading_date', startDate)
            .lte('reading_date', endDate)
            .order('reading_date', { ascending: false })
            .order('meter', { ascending: true }),
        supabase
            .from('view_electricity_monthly')
            .select('*')
            .order('month', { ascending: false }),
    ]);

    if (readingsRes.error) return { error: `Failed to load electricity readings: ${readingsRes.error.message}` };
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

// ─── Bulk Save — Electricity ──────────────────────────────────────────────────

export async function saveBulkElectricity(
    payload: BulkSavePayload<TablesInsert<'electricity_readings'>, TablesUpdate<'electricity_readings'>>
) {
    const supabase = await createClient();

    for (let i = 0; i < payload.inserts.length; i++) {
        const r = payload.inserts[i];
        if (!r.reading_date) return { ok: false, error: `Insert row ${i + 1}: Date is required.` };
        if (!r.meter?.trim()) return { ok: false, error: `Insert row ${i + 1}: Meter is required.` };
        if (Number(r.end_kwh) < Number(r.start_kwh)) {
            return { ok: false, error: `Insert row ${i + 1}: End KWH must be ≥ Start KWH.` };
        }
        if (Number(r.rate_php_per_kwh ?? 0) < 0) {
            return { ok: false, error: `Insert row ${i + 1}: Rate must be 0 or greater.` };
        }
    }

    let insertedCount = 0;
    let updatedCount = 0;
    let deletedCount = 0;

    if (payload.inserts.length > 0) {
        const { error } = await supabase.from('electricity_readings').insert(
            payload.inserts.map(r => ({
                ...r,
                start_kwh: Number(r.start_kwh),
                end_kwh: Number(r.end_kwh),
                rate_php_per_kwh: Number(r.rate_php_per_kwh ?? 0),
            }))
        );
        if (error) return { ok: false, error: translateDbError(error.message) };
        insertedCount = payload.inserts.length;
    }

    for (const { id, data } of payload.updates) {
        if (data.end_kwh !== undefined && data.start_kwh !== undefined) {
            if (Number(data.end_kwh) < Number(data.start_kwh)) {
                return { ok: false, error: 'End KWH must be ≥ Start KWH.' };
            }
        }
        const { error } = await supabase.from('electricity_readings').update(data).eq('id', id);
        if (error) return { ok: false, error: translateDbError(error.message) };
        updatedCount++;
    }

    for (const id of payload.deletes) {
        const { error } = await supabase.from('electricity_readings').delete().eq('id', id);
        if (error) return { ok: false, error: error.message };
        deletedCount++;
    }

    revalidatePath('/production');
    return { ok: true, insertedCount, updatedCount, deletedCount };
}
