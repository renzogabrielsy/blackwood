'use server';

import { revalidatePath } from 'next/cache';
import { createClient } from '@/lib/supabase/server';
import type { DeliveryRow } from '@/types/rc-in';

export type { DeliveryRow } from '@/types/rc-in';

/** Deduplicates and upserts batches from delivery rows */
async function upsertBatchesFromRows(rows: DeliveryRow[]) {
    const supabase = await createClient();
    const batchUpserts = rows.map(row => ({
        batch_code: row.batch_code,
        status: row.state || 'STORED',
        location_ref: row.block_loc,
    }));

    const uniqueBatches = Array.from(
        new Map(batchUpserts.map(item => [item.batch_code, item])).values()
    );

    const { error } = await supabase
        .from('batches')
        .upsert(uniqueBatches, { onConflict: 'batch_code' });

    if (error) {
        throw new Error(`Batch Error: ${error.message}`);
    }
}

/** Strips `state` and casts numerics for the deliveries table */
function toDeliveryPayload(row: DeliveryRow) {
    const { state, ...deliveryData } = row;
    return {
        ...deliveryData,
        weight_kg: Number(row.weight_kg),
        sacks: Number(row.sacks),
        cost_basis: Number(row.cost_basis),
        lab_results: row.lab_results,
    };
}

export async function submitBulkDeliveries(rows: DeliveryRow[]) {
    if (!rows || rows.length === 0) {
        return { success: false, message: 'No rows to submit' };
    }

    try {
        await upsertBatchesFromRows(rows);

        const supabase = await createClient();
        const deliveriesPayload = rows.map(toDeliveryPayload);

        const { error: deliveryError } = await supabase
            .from('deliveries')
            .insert(deliveriesPayload);

        if (deliveryError) {
            console.error('Error inserting deliveries:', deliveryError);
            throw new Error(`Delivery Insert Error: ${deliveryError.message}`);
        }

        revalidatePath('/rc-in');
        return { success: true };

    } catch (error: any) {
        console.error('Submit Transaction Failed:', error);
        return { success: false, message: error.message || 'Unknown error occurred' };
    }
}

export async function updateDelivery(id: string, data: Partial<DeliveryRow>) {
    const supabase = await createClient();
    const { error } = await supabase
        .from('deliveries')
        .update(data)
        .eq('id', id);

    if (error) {
        console.error('Error updating delivery:', error);
        return { success: false, message: error.message };
    }

    revalidatePath('/rc-in');
    return { success: true };
}

export async function bulkUpdateDeliveries(updates: { id: string; data: DeliveryRow }[]) {
    if (!updates || updates.length === 0) {
        return { success: false, message: 'No rows to update' };
    }

    try {
        const rows = updates.map(u => u.data);
        await upsertBatchesFromRows(rows);

        const supabase = await createClient();
        for (const { id, data } of updates) {
            const payload = toDeliveryPayload(data);
            const { error } = await supabase
                .from('deliveries')
                .update(payload)
                .eq('id', id);

            if (error) {
                throw new Error(`Update Error (${id}): ${error.message}`);
            }
        }

        revalidatePath('/rc-in');
        return { success: true };
    } catch (error: any) {
        console.error('Bulk Update Failed:', error);
        return { success: false, message: error.message || 'Unknown error occurred' };
    }
}

export async function bulkDeleteDeliveries(ids: string[]) {
    if (!ids || ids.length === 0) {
        return { success: false, message: 'No IDs to delete' };
    }

    const supabase = await createClient();
    const { error } = await supabase
        .from('deliveries')
        .delete()
        .in('id', ids);

    if (error) {
        console.error('Error bulk deleting deliveries:', error);
        return { success: false, message: error.message };
    }

    revalidatePath('/rc-in');
    return { success: true };
}

export async function deleteDelivery(id: string) {
    const supabase = await createClient();
    const { error } = await supabase
        .from('deliveries')
        .delete()
        .eq('id', id);

    if (error) {
        console.error('Error deleting delivery:', error);
        return { success: false, message: error.message };
    }

    revalidatePath('/rc-in');
    return { success: true };
}
