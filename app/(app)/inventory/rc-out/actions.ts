'use server';

import { createClient } from '@/lib/supabase/server';
import { revalidatePath } from 'next/cache';
import type { RcOutRow, RcOutInput } from '@/types/rc-out';
import type { Tables } from '@/types/supabase';
import { canViewPrices } from '@/lib/auth';

export async function deleteRcOutRecord(id: string) {
    const supabase = await createClient();
    const { error } = await supabase.from('rc_out').delete().eq('id', id);

    if (error) {
        return { success: false, message: error.message };
    }
    revalidatePath('/inventory');
    return { success: true };
}

export async function bulkDeleteRcOut(ids: string[]) {
    const supabase = await createClient();
    const { error } = await supabase.from('rc_out').delete().in('id', ids);

    if (error) {
        return { success: false, message: error.message };
    }
    revalidatePath('/inventory');
    return { success: true };
}

export async function submitBulkUsage(rows: RcOutInput[]) {
    if (!rows || rows.length === 0) {
        return { success: false, message: 'No rows to submit' };
    }

    try {
        const supabase = await createClient();
        const { error } = await supabase.from('rc_out').insert(rows);

        if (error) {
            console.error('Error inserting RC OUT records:', error.message);
            throw new Error(`Insert Error: ${error.message}`);
        }

        revalidatePath('/inventory');
        return { success: true };
    } catch (error: unknown) {
        console.error('Submit Bulk Usage Failed:', error);
        return { success: false, message: error instanceof Error ? error.message : 'Unknown error occurred' };
    }
}

export async function bulkUpdateUsage(updates: { id: string; data: RcOutInput; comment?: string }[]) {
    if (!updates || updates.length === 0) {
        return { success: false, message: 'No rows to update' };
    }

    try {
        const supabase = await createClient();
        const { data: { user } } = await supabase.auth.getUser();

        for (const { id, data, comment } of updates) {
            // Set audit comment if provided
            if (comment) {
                await supabase.rpc('set_audit_comment', { comment });
            } else {
                await supabase.rpc('set_audit_comment', { comment: null });
            }

            const { error } = await supabase
                .from('rc_out')
                .update(data)
                .eq('id', id);

            if (error) {
                throw new Error(`Update Error (${id}): ${error.message}`);
            }

            // Post the edit remark as a discussion comment on the new audit log
            if (comment && user) {
                const { data: latestLog } = await supabase
                    .from('audit_logs')
                    .select('id')
                    .eq('record_id', id)
                    .order('performed_at', { ascending: false })
                    .limit(1)
                    .single();

                if (latestLog) {
                    await supabase
                        .from('audit_comments')
                        .insert({
                            audit_log_id: latestLog.id,
                            user_id: user.id,
                            body: comment,
                        });
                }
            }
        }

        revalidatePath('/inventory');
        return { success: true };
    } catch (error: unknown) {
        console.error('Bulk Update Usage Failed:', error);
        return { success: false, message: error instanceof Error ? error.message : 'Unknown error occurred' };
    }
}

export async function fetchRcOutTabData() {
    const supabase = await createClient();

    // CANONICAL price gate — Production (incl. impersonated) must NOT receive ₱ data.
    // Resolved ONCE here, then the avg_price / avg_wtd_value fields are nulled BEFORE
    // the payload leaves the server (the security boundary). The returned canViewPrices
    // boolean lets the client conditionally render without re-deriving the role.
    const showPrices = await canViewPrices();

    // Paginated fetch helper to bypass PostgREST max_rows (1000)
    const PAGE = 1000;
    async function fetchAll<T>(buildQuery: () => any): Promise<T[]> {
        let all: T[] = [];
        let from = 0;
        let hasMore = true;
        while (hasMore) {
            const { data } = await buildQuery().range(from, from + PAGE - 1);
            all = all.concat(data || []);
            hasMore = (data?.length || 0) === PAGE;
            from += PAGE;
        }
        return all;
    }

    // Fetch ALL rc_out records with batch join
    const rcOutRaw = await fetchAll<any>(() =>
        supabase
            .from('rc_out')
            .select(`
                id,
                transaction_date,
                batch_id,
                production_batch,
                destination,
                weight_kg,
                remarks,
                block_loc,
                created_at,
                avg_price:rc_out_avg_price,
                avg_wtd_value:rc_out_avg_wtd_value,
                batches (
                    batch_code,
                    status,
                    location_ref
                )
            `)
            .order('transaction_date', { ascending: false })
    );

    // Flatten the batches join
    const records: RcOutRow[] = rcOutRaw.map((d) => {
        const batchesArray = Array.isArray(d.batches) ? d.batches : (d.batches ? [d.batches] : []);
        const batchCode = batchesArray[0]?.batch_code;

        return {
            id: d.id,
            transaction_date: d.transaction_date,
            batch_id: d.batch_id,
            production_batch: d.production_batch,
            destination: d.destination,
            weight_kg: d.weight_kg,
            remarks: d.remarks,
            block_loc: d.block_loc,
            created_at: d.created_at,
            // Price fields nulled server-side when the role can't view prices —
            // they never reach a Production user's network payload.
            avg_price: showPrices ? d.avg_price : null,
            avg_wtd_value: showPrices ? d.avg_wtd_value : null,
            batches: batchCode ? { batch_code: batchCode, status: batchesArray[0]?.status || 'STORED', location_ref: batchesArray[0]?.location_ref || '' } : undefined,
        } as RcOutRow;
    });

    // Fetch batches for bulk input resolution
    const batchesRes = await supabase
        .from('batches')
        .select('id, batch_code, location_ref')
        .order('batch_code');
    const batches = batchesRes.data ?? [];

    // Fetch block_loc values from BOTH rc_out and batches.location_ref
    const [blockLocsFromRcOut, blockLocsFromBatches] = await Promise.all([
        fetchAll<{ block_loc: string }>(() =>
            supabase.from('rc_out').select('block_loc').not('block_loc', 'is', null).order('block_loc')
        ),
        fetchAll<{ location_ref: string }>(() =>
            supabase.from('batches').select('location_ref').not('location_ref', 'is', null).order('location_ref')
        ),
    ]);
    const blockLocsSet = new Set<string>();
    blockLocsFromRcOut.forEach(d => { if (d.block_loc) blockLocsSet.add(d.block_loc); });
    blockLocsFromBatches.forEach(d => { if (d.location_ref) blockLocsSet.add(d.location_ref); });
    // Natural sort: "A1" < "A10" < "B1"
    const blockLocs = Array.from(blockLocsSet).sort((a, b) =>
        a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' })
    );

    // Derive distinct destinations, batchOptions, and yearOptions from records
    const destinations = Array.from(new Set(records.map(r => r.destination).filter(Boolean))).sort();
    const MONTH_ORDER: Record<string, number> = {
        JANUARY: 1, FEBRUARY: 2, MARCH: 3, APRIL: 4, MAY: 5, JUNE: 6,
        JULY: 7, AUGUST: 8, SEPTEMBER: 9, OCTOBER: 10, NOVEMBER: 11, DECEMBER: 12,
    };
    const batchOptions = Array.from(new Set(records.map(r => r.production_batch).filter(Boolean)))
        .sort((a, b) => (MONTH_ORDER[a.toUpperCase()] ?? 99) - (MONTH_ORDER[b.toUpperCase()] ?? 99));
    const yearOptions = Array.from(
        new Set(records.map(r => {
            const yr = parseInt(r.transaction_date?.slice(0, 4) || '');
            return isNaN(yr) ? null : yr;
        }).filter(Boolean) as number[])
    ).sort((a, b) => b - a); // descending

    return {
        records,
        batches,
        destinations,
        batchOptions,
        yearOptions,
        blockLocs,
        // Canonical price-gate flag — drives conditional render on the client.
        canViewPrices: showPrices,
    };
}

export async function fetchClosedBlocks(): Promise<{ rows: Tables<'view_rc_out_closed_blocks'>[]; canViewPrices: boolean; error?: string }> {
    const supabase = await createClient();
    const showPrices = await canViewPrices();

    const { data, error } = await supabase
        .from('view_rc_out_closed_blocks')
        .select('*')
        .order('close_date', { ascending: false });

    if (error) {
        return { rows: [], canViewPrices: showPrices, error: error.message };
    }

    // Price gate is the security boundary: null ₱ fields BEFORE the payload leaves the
    // server so a Production user's network response never contains them.
    const rows = (data ?? []).map((r) =>
        showPrices ? r : { ...r, total_value: null, avg_price: null }
    );

    return { rows, canViewPrices: showPrices };
}
