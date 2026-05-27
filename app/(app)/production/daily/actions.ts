'use server';

import { revalidatePath } from 'next/cache';
import { createClient } from '@/lib/supabase/server';
import type { Tables, TablesInsert, TablesUpdate } from '@/types/supabase';
import { format } from 'date-fns';

export type ProductionRunRow = Tables<'production_runs'>;
export type ProductionDowntimeRow = Tables<'production_downtime'>;
export type ProductionWasteRow = Tables<'production_waste'>;

const VALID_GRADES = ['3X50', '6X50', '8X50', '2X6'] as const;
const VALID_SHIFTS = ['M', 'E', 'N'] as const;

type Grade = (typeof VALID_GRADES)[number];
type Shift = (typeof VALID_SHIFTS)[number];

function translateDbError(message: string): string {
    if (message.includes('chk_production_runs_grade')) {
        return 'Invalid grade. Must be one of: 3X50, 6X50, 8X50, 2X6.';
    }
    if (message.includes('chk_production_runs_shift')) {
        return 'Invalid shift. Must be M (Morning), E (Evening), or N (Night).';
    }
    if (message.includes('chk_production_runs_ttl_kg')) {
        return 'Total KG must be greater than 0.';
    }
    if (message.includes('chk_downtime_shift_hrs')) {
        return 'Shift hours must be greater than 0.';
    }
    if (message.includes('unique') || message.includes('duplicate')) {
        return 'A duplicate record already exists for this date/batch/grade/shift combination.';
    }
    return message;
}

// ─── Fetch ────────────────────────────────────────────────────────────────────

export async function fetchDailyTabData(year?: number, month?: number) {
    const supabase = await createClient();
    const now = new Date();
    const targetYear = year ?? now.getFullYear();
    const targetMonth = month ?? now.getMonth(); // 0-indexed

    const startDate = format(new Date(targetYear, targetMonth, 1), 'yyyy-MM-dd');
    const endDate = format(new Date(targetYear, targetMonth + 1, 0), 'yyyy-MM-dd');

    const [runsRes, downtimeRes, wasteRes] = await Promise.all([
        supabase
            .from('production_runs')
            .select('*')
            .gte('transaction_date', startDate)
            .lte('transaction_date', endDate)
            .order('transaction_date', { ascending: false })
            .order('shift', { ascending: true }),
        supabase
            .from('production_downtime')
            .select('*')
            .gte('transaction_date', startDate)
            .lte('transaction_date', endDate)
            .order('transaction_date', { ascending: false })
            .order('shift', { ascending: true }),
        supabase
            .from('production_waste')
            .select('*')
            .gte('transaction_date', startDate)
            .lte('transaction_date', endDate)
            .order('transaction_date', { ascending: false })
            .order('shift', { ascending: true }),
    ]);

    if (runsRes.error) return { error: `Failed to load production runs: ${runsRes.error.message}` };
    if (downtimeRes.error) return { error: `Failed to load downtime: ${downtimeRes.error.message}` };
    if (wasteRes.error) return { error: `Failed to load waste: ${wasteRes.error.message}` };

    return {
        data: {
            runs: runsRes.data ?? [],
            downtime: downtimeRes.data ?? [],
            waste: wasteRes.data ?? [],
            year: targetYear,
            month: targetMonth,
        },
    };
}

// ─── Bulk Save — Production Runs ──────────────────────────────────────────────

export type BulkSavePayload<TInsert, TUpdate> = {
    inserts: TInsert[];
    updates: { id: string; data: TUpdate }[];
    deletes: string[];
};

export async function saveBulkProductionRuns(
    payload: BulkSavePayload<TablesInsert<'production_runs'>, TablesUpdate<'production_runs'>>
) {
    const supabase = await createClient();

    // Validate inserts
    for (let i = 0; i < payload.inserts.length; i++) {
        const r = payload.inserts[i];
        if (!r.transaction_date) return { ok: false, error: `Insert row ${i + 1}: Date is required.` };
        if (!r.production_batch?.trim()) return { ok: false, error: `Insert row ${i + 1}: Batch is required.` };
        if (!VALID_GRADES.includes(r.grade as Grade)) {
            return { ok: false, error: `Insert row ${i + 1}: Grade must be one of ${VALID_GRADES.join(', ')}.` };
        }
        if (!VALID_SHIFTS.includes(r.shift as Shift)) {
            return { ok: false, error: `Insert row ${i + 1}: Shift must be M, E, or N.` };
        }
        if (!r.ttl_kg || Number(r.ttl_kg) <= 0) {
            return { ok: false, error: `Insert row ${i + 1}: Total KG must be greater than 0.` };
        }
    }

    let insertedCount = 0;
    let updatedCount = 0;
    let deletedCount = 0;

    if (payload.inserts.length > 0) {
        const { error } = await supabase.from('production_runs').insert(payload.inserts);
        if (error) return { ok: false, error: translateDbError(error.message) };
        insertedCount = payload.inserts.length;
    }

    for (const { id, data } of payload.updates) {
        const { error } = await supabase.from('production_runs').update(data).eq('id', id);
        if (error) return { ok: false, error: translateDbError(error.message) };
        updatedCount++;
    }

    for (const id of payload.deletes) {
        const { error } = await supabase.from('production_runs').delete().eq('id', id);
        if (error) return { ok: false, error: error.message };
        deletedCount++;
    }

    revalidatePath('/production');
    return { ok: true, insertedCount, updatedCount, deletedCount };
}

// ─── Bulk Save — Downtime ─────────────────────────────────────────────────────

export async function saveBulkDowntime(
    payload: BulkSavePayload<TablesInsert<'production_downtime'>, TablesUpdate<'production_downtime'>>
) {
    const supabase = await createClient();

    for (let i = 0; i < payload.inserts.length; i++) {
        const r = payload.inserts[i];
        if (!r.transaction_date) return { ok: false, error: `Insert row ${i + 1}: Date is required.` };
        if (!r.production_batch?.trim()) return { ok: false, error: `Insert row ${i + 1}: Batch is required.` };
        if (!VALID_SHIFTS.includes(r.shift as Shift)) {
            return { ok: false, error: `Insert row ${i + 1}: Shift must be M, E, or N.` };
        }
        if (!r.shift_hrs || Number(r.shift_hrs) <= 0) {
            return { ok: false, error: `Insert row ${i + 1}: Shift hours must be greater than 0.` };
        }
        if (Number(r.dt_mins ?? 0) >= 60) {
            return { ok: false, error: `Insert row ${i + 1}: DT minutes must be less than 60.` };
        }
        const dtTtl = Number(r.dt_hrs ?? 0) + Number(r.dt_mins ?? 0) / 60;
        if (dtTtl > Number(r.shift_hrs)) {
            return { ok: false, error: `Insert row ${i + 1}: DT total cannot exceed shift hours.` };
        }
    }

    let insertedCount = 0;
    let updatedCount = 0;
    let deletedCount = 0;

    if (payload.inserts.length > 0) {
        const { error } = await supabase.from('production_downtime').insert(payload.inserts);
        if (error) return { ok: false, error: translateDbError(error.message) };
        insertedCount = payload.inserts.length;
    }

    for (const { id, data } of payload.updates) {
        const { error } = await supabase.from('production_downtime').update(data).eq('id', id);
        if (error) return { ok: false, error: translateDbError(error.message) };
        updatedCount++;
    }

    for (const id of payload.deletes) {
        const { error } = await supabase.from('production_downtime').delete().eq('id', id);
        if (error) return { ok: false, error: error.message };
        deletedCount++;
    }

    revalidatePath('/production');
    return { ok: true, insertedCount, updatedCount, deletedCount };
}

// ─── Bulk Save — Waste ────────────────────────────────────────────────────────

export async function saveBulkWaste(
    payload: BulkSavePayload<TablesInsert<'production_waste'>, TablesUpdate<'production_waste'>>
) {
    const supabase = await createClient();

    for (let i = 0; i < payload.inserts.length; i++) {
        const r = payload.inserts[i];
        if (!r.transaction_date) return { ok: false, error: `Insert row ${i + 1}: Date is required.` };
        if (!r.production_batch?.trim()) return { ok: false, error: `Insert row ${i + 1}: Batch is required.` };
        if (!VALID_SHIFTS.includes(r.shift as Shift)) {
            return { ok: false, error: `Insert row ${i + 1}: Shift must be M, E, or N.` };
        }
    }

    let insertedCount = 0;
    let updatedCount = 0;
    let deletedCount = 0;

    if (payload.inserts.length > 0) {
        const { error } = await supabase.from('production_waste').insert(payload.inserts);
        if (error) return { ok: false, error: translateDbError(error.message) };
        insertedCount = payload.inserts.length;
    }

    for (const { id, data } of payload.updates) {
        const { error } = await supabase.from('production_waste').update(data).eq('id', id);
        if (error) return { ok: false, error: translateDbError(error.message) };
        updatedCount++;
    }

    for (const id of payload.deletes) {
        const { error } = await supabase.from('production_waste').delete().eq('id', id);
        if (error) return { ok: false, error: error.message };
        deletedCount++;
    }

    revalidatePath('/production');
    return { ok: true, insertedCount, updatedCount, deletedCount };
}
