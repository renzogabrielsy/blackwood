'use server';

import { revalidatePath } from 'next/cache';
import { createClient } from '@/lib/supabase/server';
import type { Tables, TablesInsert, TablesUpdate } from '@/types/supabase';
import { format } from 'date-fns';

// ─── Re-exported DB row types ──────────────────────────────────────────────────
export type ProductionShiftRow = Tables<'production_shifts'>;
export type ProductionRunRow = Tables<'production_runs'>;
export type ProductionDowntimeRow = Tables<'production_downtime'>;
export type ProductionWasteRow = Tables<'production_waste'>;

// ─── Constants ─────────────────────────────────────────────────────────────────
const VALID_GRADES = ['3X50', '6X50', '8X50', '2X6'] as const;
const VALID_SHIFTS = ['M', 'E', 'N'] as const;
type Grade = (typeof VALID_GRADES)[number];
type Shift = (typeof VALID_SHIFTS)[number];

// ─── Ledger save payload ───────────────────────────────────────────────────────
// Each element represents a single production_runs row in the ledger.
// Downtime and waste are keyed by shift — only the "primary" row (first grade)
// carries them. Subsequent rows for the same shift carry null for downtime/waste.

export interface LedgerRowPayload {
    _state: 'new' | 'modified' | 'deleted' | 'existing';
    _ids?: {
        shift_id?: string;
        run_id?: string;
        downtime_id?: string;
        waste_id?: string;
    };
    shift: {
        transaction_date: string;
        production_batch: string;
        shift: string;
    };
    run: {
        customer: string;
        grade: string;
        ttl_kg: number | null;
        sacks_bags: number | null;
        remarks: string | null;
    };
    // null = not the primary row for this shift (secondary grade rows)
    downtime: {
        shift_hrs: number | null;
        dt_hrs: number | null;
        dt_mins: number | null;
        dt_reason: string | null;
    } | null;
    waste: {
        rs1a_kg: number | null;
        rs1b_kg: number | null;
        bf_kg: number | null;
        rs23_kg: number | null;
        rs5_kg: number | null;
        trml1_kg: number | null;
        trml2_kg: number | null;
        grit_kg: number | null;
        remarks: string | null;
    } | null;
}

// ─── Error translation ─────────────────────────────────────────────────────────
function translateDbError(message: string): string {
    if (message.includes('chk_production_runs_grade') || message.includes('production_runs_grade_check')) {
        return 'Invalid grade. Must be one of: 3X50, 6X50, 8X50, 2X6.';
    }
    if (message.includes('chk_production_runs_shift') || message.includes('production_shifts_shift_check')) {
        return 'Invalid shift. Must be M (Morning), E (Evening), or N (Night).';
    }
    if (message.includes('chk_production_runs_ttl_kg') || message.includes('production_runs_ttl_kg_check')) {
        return 'Total KG must be 0 or greater.';
    }
    if (message.includes('chk_downtime_shift_hrs') || message.includes('production_downtime_shift_hrs_check')) {
        return 'Shift hours must be greater than 0.';
    }
    if (message.includes('unique') || message.includes('duplicate') || message.includes('already exists')) {
        return 'A duplicate record already exists for this date/batch/grade/shift combination.';
    }
    return message;
}

// ─── Fetch available periods ───────────────────────────────────────────────────
// Returns distinct years and per-year batch lists present in production_shifts.
// Used to populate the Year + Batch pickers in the toolbar.
export async function fetchAvailablePeriods(): Promise<{
    data?: { years: number[]; batchesByYear: Record<number, string[]> };
    error?: string;
}> {
    const supabase = await createClient();

    // Fetch all distinct (year, batch) combinations. We derive year from transaction_date server-side.
    // Supabase doesn't support EXTRACT in the JS client directly, so we select all shifts and
    // compute on the client — cheap since we only need the distinct pairs.
    const { data, error } = await supabase
        .from('production_shifts')
        .select('transaction_date, production_batch');

    if (error) {
        return { error: `Failed to load available periods: ${error.message}` };
    }

    const yearsSet = new Set<number>();
    const batchMap = new Map<number, Set<string>>();

    for (const row of data ?? []) {
        const y = new Date(row.transaction_date).getFullYear();
        yearsSet.add(y);
        if (!batchMap.has(y)) batchMap.set(y, new Set());
        if (row.production_batch) batchMap.get(y)!.add(row.production_batch);
    }

    const years = [...yearsSet].sort((a, b) => b - a); // descending

    const batchesByYear: Record<number, string[]> = {};
    for (const [y, batches] of batchMap) {
        // Sort batches deterministically (they are uppercase month names — alphabetical is fine)
        batchesByYear[y] = [...batches].sort();
    }

    return { data: { years, batchesByYear } };
}

// ─── Fetch ─────────────────────────────────────────────────────────────────────
// Returns shifts + their child rows for the given period, joined client-side in the UI.
// Filtering is now batch-name based (production_batch) + year-from-transaction_date:
// - year=null + batch=null → all data
// - year=<num> + batch=null → all shifts in that calendar year
// - year=null + batch=<str> → all shifts with that batch name (any year)
// - year=<num> + batch=<str> → shifts in that year with that batch name
export async function fetchDailyTabData(year?: number | null, batch?: string | null) {
    const supabase = await createClient();
    const now = new Date();
    // Default to current year + current month's batch derived from current date
    const targetYear = year !== undefined ? year : now.getFullYear();
    const targetBatch = batch !== undefined ? batch : null;

    // Build query
    let query = supabase
        .from('production_shifts')
        .select('*');

    // Filter by year range when a year is specified
    if (targetYear != null) {
        const startDate = format(new Date(targetYear, 0, 1), 'yyyy-MM-dd');
        const endDate = format(new Date(targetYear, 11, 31), 'yyyy-MM-dd');
        query = query.gte('transaction_date', startDate).lte('transaction_date', endDate);
    }

    // Filter by batch name when specified
    if (targetBatch != null) {
        query = query.eq('production_batch', targetBatch);
    }

    const { data: shifts, error: shiftsError } = await query
        .order('transaction_date', { ascending: true })
        .order('shift', { ascending: true });

    if (shiftsError) {
        return { error: `Failed to load production shifts: ${shiftsError.message}` };
    }

    if (!shifts || shifts.length === 0) {
        return {
            data: {
                shifts: [] as ProductionShiftRow[],
                runs: [] as ProductionRunRow[],
                downtime: [] as ProductionDowntimeRow[],
                waste: [] as ProductionWasteRow[],
                year: targetYear,
                batch: targetBatch,
            },
        };
    }

    const shiftIds = shifts.map(s => s.id);

    // Fetch all children in parallel
    const [runsRes, downtimeRes, wasteRes] = await Promise.all([
        supabase
            .from('production_runs')
            .select('*')
            .in('shift_id', shiftIds)
            .order('customer', { ascending: true })
            .order('grade', { ascending: true }),
        supabase
            .from('production_downtime')
            .select('*')
            .in('shift_id', shiftIds),
        supabase
            .from('production_waste')
            .select('*')
            .in('shift_id', shiftIds),
    ]);

    if (runsRes.error) return { error: `Failed to load production runs: ${runsRes.error.message}` };
    if (downtimeRes.error) return { error: `Failed to load downtime: ${downtimeRes.error.message}` };
    if (wasteRes.error) return { error: `Failed to load waste: ${wasteRes.error.message}` };

    return {
        data: {
            shifts: shifts,
            runs: runsRes.data ?? [],
            downtime: downtimeRes.data ?? [],
            waste: wasteRes.data ?? [],
            year: targetYear,
            batch: targetBatch,
        },
    };
}

// ─── Bulk Save — Unified Ledger ────────────────────────────────────────────────
// Atomically upserts shifts → runs → downtime → waste in a single call.
// Groups rows by (date, batch, shift) key to handle multi-grade shifts correctly.
export async function saveBulkDailyLedger(rows: LedgerRowPayload[]): Promise<
    | { ok: true; insertedShifts: number; upsertedRuns: number; upsertedDowntime: number; upsertedWaste: number; deletedRuns: number }
    | { ok: false; error: string }
> {
    const supabase = await createClient();

    // 1. Separate deletes
    const deleteRows = rows.filter(r => r._state === 'deleted' && r._ids?.run_id);
    const activeRows = rows.filter(r => r._state !== 'deleted');

    // 2. Group active rows by shift key
    type ShiftKey = string; // "date|batch|shift"
    const shiftKeyFor = (r: LedgerRowPayload) =>
        `${r.shift.transaction_date}|${r.shift.production_batch}|${r.shift.shift}`;

    const shiftGroups = new Map<ShiftKey, LedgerRowPayload[]>();
    for (const row of activeRows) {
        const key = shiftKeyFor(row);
        const group = shiftGroups.get(key) ?? [];
        group.push(row);
        shiftGroups.set(key, group);
    }

    // 3. Validate
    for (const [, group] of shiftGroups) {
        for (const row of group) {
            if (!row.shift.transaction_date) return { ok: false, error: 'Date is required.' };
            if (!row.shift.production_batch?.trim()) return { ok: false, error: 'Batch is required.' };
            if (!VALID_SHIFTS.includes(row.shift.shift as Shift)) {
                return { ok: false, error: `Shift must be M, E, or N. Got: "${row.shift.shift}"` };
            }
            if (!VALID_GRADES.includes(row.run.grade as Grade)) {
                return { ok: false, error: `Grade must be one of ${VALID_GRADES.join(', ')}. Got: "${row.run.grade}"` };
            }
            if (row.run.ttl_kg !== null && row.run.ttl_kg < 0) {
                return { ok: false, error: `Total KG must be 0 or greater.` };
            }

            // Validate downtime if present
            if (row.downtime) {
                if (row.downtime.shift_hrs !== null && row.downtime.shift_hrs <= 0) {
                    return { ok: false, error: 'Shift hours must be greater than 0.' };
                }
                if (row.downtime.dt_mins !== null && row.downtime.dt_mins >= 60) {
                    return { ok: false, error: 'DT minutes must be less than 60.' };
                }
                if (
                    row.downtime.shift_hrs !== null &&
                    row.downtime.dt_hrs !== null &&
                    row.downtime.dt_mins !== null
                ) {
                    const dtTtl = row.downtime.dt_hrs + row.downtime.dt_mins / 60;
                    if (dtTtl > row.downtime.shift_hrs) {
                        return { ok: false, error: 'DT total cannot exceed shift hours.' };
                    }
                }
            }
        }
    }

    let insertedShifts = 0;
    let upsertedRuns = 0;
    let upsertedDowntime = 0;
    let upsertedWaste = 0;
    let deletedRuns = 0;

    // 4. Process each shift group
    for (const [, group] of shiftGroups) {
        const firstRow = group[0];
        const shiftData: TablesInsert<'production_shifts'> = {
            transaction_date: firstRow.shift.transaction_date,
            production_batch: firstRow.shift.production_batch,
            shift: firstRow.shift.shift,
        };

        // Upsert shift by natural key — get back the id
        const { data: shiftResult, error: shiftError } = await supabase
            .from('production_shifts')
            .upsert(shiftData, {
                onConflict: 'transaction_date,production_batch,shift',
                ignoreDuplicates: false,
            })
            .select('id')
            .single();

        if (shiftError) {
            return { ok: false, error: `Failed to upsert shift: ${translateDbError(shiftError.message)}` };
        }

        const shiftId = shiftResult.id;
        if (!firstRow._ids?.shift_id) insertedShifts++;

        // 5. Update existing runs by id, insert new runs
        // KEY: use run_id presence (not _state) to determine UPDATE vs INSERT.
        // When the user edits a natural-key field (e.g., customer CEBU → FG), _state becomes
        // 'modified' but the row STILL has an existing run_id — we must UPDATE that id, not
        // INSERT a new row that just happens to have the new natural key.
        for (const row of group) {
            if (row._ids?.run_id) {
                // Existing row (regardless of _state) — UPDATE by id
                const updateData: TablesUpdate<'production_runs'> = {
                    customer: row.run.customer || 'CEBU',
                    grade: row.run.grade,
                    ttl_kg: row.run.ttl_kg ?? 0,
                    sacks_bags: row.run.sacks_bags ?? null,
                    remarks: row.run.remarks || null,
                };
                const { error: runError } = await supabase
                    .from('production_runs')
                    .update(updateData)
                    .eq('id', row._ids.run_id);
                if (runError) return { ok: false, error: `Failed to update run: ${translateDbError(runError.message)}` };
            } else {
                // Truly new row — INSERT
                const insertData: TablesInsert<'production_runs'> = {
                    shift_id: shiftId,
                    customer: row.run.customer || 'CEBU',
                    grade: row.run.grade,
                    ttl_kg: row.run.ttl_kg ?? 0,
                    sacks_bags: row.run.sacks_bags ?? null,
                    remarks: row.run.remarks || null,
                };
                const { error: runError } = await supabase
                    .from('production_runs')
                    .insert(insertData);
                if (runError) return { ok: false, error: `Failed to insert run: ${translateDbError(runError.message)}` };
            }
            upsertedRuns++;
        }

        // 6. Upsert downtime — find the primary row (one with downtime data)
        const downtimeRow = group.find(r => r.downtime !== null);
        if (downtimeRow?.downtime) {
            const dt = downtimeRow.downtime;
            const hasDowntimeData = dt.shift_hrs !== null;
            if (hasDowntimeData) {
                const downtimeData: TablesInsert<'production_downtime'> = {
                    shift_id: shiftId,
                    shift_hrs: dt.shift_hrs ?? 8,
                    dt_hrs: dt.dt_hrs ?? 0,
                    dt_mins: dt.dt_mins ?? 0,
                    dt_reason: dt.dt_reason || null,
                };
                const { error: dtError } = await supabase
                    .from('production_downtime')
                    .upsert(downtimeData, {
                        onConflict: 'shift_id',
                        ignoreDuplicates: false,
                    });
                if (dtError) return { ok: false, error: `Failed to upsert downtime: ${translateDbError(dtError.message)}` };
                upsertedDowntime++;
            }
        }

        // 7. Upsert waste — find the primary row (one with waste data)
        const wasteRow = group.find(r => r.waste !== null);
        if (wasteRow?.waste) {
            const w = wasteRow.waste;
            const hasWasteData =
                w.rs1a_kg !== null || w.rs1b_kg !== null || w.bf_kg !== null ||
                w.rs23_kg !== null || w.rs5_kg !== null || w.trml1_kg !== null ||
                w.trml2_kg !== null || w.grit_kg !== null;
            if (hasWasteData) {
                const wasteData: TablesInsert<'production_waste'> = {
                    shift_id: shiftId,
                    rs1a_kg: w.rs1a_kg ?? 0,
                    rs1b_kg: w.rs1b_kg ?? 0,
                    bf_kg: w.bf_kg ?? 0,
                    rs23_kg: w.rs23_kg ?? 0,
                    rs5_kg: w.rs5_kg ?? 0,
                    trml1_kg: w.trml1_kg ?? 0,
                    trml2_kg: w.trml2_kg ?? 0,
                    grit_kg: w.grit_kg ?? 0,
                    remarks: w.remarks || null,
                };
                const { error: wError } = await supabase
                    .from('production_waste')
                    .upsert(wasteData, {
                        onConflict: 'shift_id',
                        ignoreDuplicates: false,
                    });
                if (wError) return { ok: false, error: `Failed to upsert waste: ${translateDbError(wError.message)}` };
                upsertedWaste++;
            }
        }
    }

    // 8. Handle run deletes
    for (const row of deleteRows) {
        if (!row._ids?.run_id) continue;
        const { error } = await supabase
            .from('production_runs')
            .delete()
            .eq('id', row._ids.run_id);
        if (error) return { ok: false, error: `Failed to delete run: ${error.message}` };
        deletedRuns++;
    }

    revalidatePath('/production');
    return { ok: true, insertedShifts, upsertedRuns, upsertedDowntime, upsertedWaste, deletedRuns };
}
