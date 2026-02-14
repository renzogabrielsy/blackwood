'use server';

import { createClient } from '@/lib/supabase/server';
import { revalidatePath } from 'next/cache';
import type { RcOutRow, RcOutInput } from '@/types/rc-out';

export async function getRcOutRecords(
    search?: string,
    offset: number = 0,
    limit: number = 15,
    startDate?: string,
    endDate?: string
) {
    const supabase = await createClient();

    let query = supabase
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
        batch_code
      )
    `)
        .order('transaction_date', { ascending: false })
        .range(offset, offset + limit - 1);

    if (startDate && endDate) {
        query = query.gte('transaction_date', startDate).lte('transaction_date', endDate);
    }

    if (search) {
        // Search on Block Code (via join), Destination, or Remarks
        // Note: Supabase complex filtering on joined tables can be tricky.
        // We might need to split this if we want deep search, but for now let's try basic text search on local columns
        // or rely on client-side filtering if dataset is small enough (1400 rows is small).
        // Ideally, we search on everything.
        query = query.or(`production_batch.ilike.%${search}%,destination.ilike.%${search}%,remarks.ilike.%${search}%,block_loc.ilike.%${search}%`);
        // For joined batch_code, we might need a separate filter or flattened view. 
        // Let's stick to returning all and letting client filter OR basic server filter.
    }

    const { data, error } = await query;

    if (error) {
        console.error('Error fetching RC OUT:', JSON.stringify(error, null, 2));
        // Fallback or re-throw
        return [];
    }

    // Flatten the structure for the UI
    return data.map((d: any) => ({
        ...d,
        // Flatten computed columns if they come back as objects/arrays (Supabase RPC behavior varies)
        // Actually, computed cols in select usually come as direct values if scalar.
        // Let's verify type.
        avg_price: d.avg_price,
        avg_wtd_value: d.avg_wtd_value,
        batch_code: d.batches?.batch_code // Flatten for easier access
    })) as RcOutRow[];
}

export async function deleteRcOutRecord(id: string) {
    const supabase = await createClient();
    const { error } = await supabase.from('rc_out').delete().eq('id', id);

    if (error) {
        return { success: false, message: error.message };
    }
    revalidatePath('/inventory/rc-out');
    return { success: true };
}

export async function bulkDeleteRcOut(ids: string[]) {
    const supabase = await createClient();
    const { error } = await supabase.from('rc_out').delete().in('id', ids);

    if (error) {
        return { success: false, message: error.message };
    }
    revalidatePath('/inventory/rc-out');
    return { success: true };
}

export async function createRcOutRecord(input: RcOutInput) {
    const supabase = await createClient();
    const { error } = await supabase.from('rc_out').insert(input);
    if (error) return { success: false, message: error.message };
    revalidatePath('/inventory/rc-out');
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

        revalidatePath('/inventory/rc-out');
        return { success: true };
    } catch (error: any) {
        console.error('Submit Bulk Usage Failed:', error);
        return { success: false, message: error.message || 'Unknown error occurred' };
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

        revalidatePath('/inventory/rc-out');
        return { success: true };
    } catch (error: any) {
        console.error('Bulk Update Usage Failed:', error);
        return { success: false, message: error.message || 'Unknown error occurred' };
    }
}
