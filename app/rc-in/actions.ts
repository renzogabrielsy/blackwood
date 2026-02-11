
'use server';

import { revalidatePath } from 'next/cache';
import { supabase } from '@/lib/supabase';

export type DeliveryRow = {
    transaction_date: string;
    batch_code: string;
    state?: string; // Corresponds to Batches table 'status'
    block_loc: string; // Corresponds to Batches table 'location_ref'
    supplier: string;
    truck_plate: string;
    sacks: number;
    weight_kg: number;
    cost_basis: number;
    remarks?: string;
    lab_results: {
        mc: number;
        ash: number;
        bd_astm: number;
        bd_jis: number;
        grit: number;
        vm: number;
        fc: number;
    };
};

export async function submitBulkDeliveries(rows: DeliveryRow[]) {
    if (!rows || rows.length === 0) {
        return { success: false, message: 'No rows to submit' };
    }

    try {
        // 1. Process batches first -> Upsert to ensure they exist/update status
        const batchUpserts = rows.map(row => ({
            batch_code: row.batch_code,
            status: row.state || 'STORED', // Default to STORED if not provided
            location_ref: row.block_loc
        }));

        // Deduplicate batches by batch_code before upserting to avoid conflicts in this transaction
        const uniqueBatches = Array.from(new Map(batchUpserts.map(item => [item.batch_code, item])).values());

        const { error: batchError } = await supabase
            .from('batches')
            .upsert(uniqueBatches, { onConflict: 'batch_code' });

        if (batchError) {
            console.error('Error upserting batches:', batchError);
            throw new Error(`Batch Error: ${batchError.message}`);
        }

        // 2. Prepare deliveries payload -> Exclude 'state' and 'block_loc' as they belong to batch or are redundant if not needed in deliveries.
        // Assuming 'lab_results' is a JSONB column because the user reported 'ash' column not found when flattened.
        const deliveriesPayload = rows.map(row => {
            const { state, ...deliveryData } = row;
            return {
                ...deliveryData,
                weight_kg: Number(row.weight_kg),
                sacks: Number(row.sacks),
                cost_basis: Number(row.cost_basis),
                lab_results: row.lab_results
            };
        });

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
        // Upsert batches first (same pattern as submitBulkDeliveries)
        const batchUpserts = updates.map(u => ({
            batch_code: u.data.batch_code,
            status: u.data.state || 'STORED',
            location_ref: u.data.block_loc,
        }));
        const uniqueBatches = Array.from(new Map(batchUpserts.map(item => [item.batch_code, item])).values());

        const { error: batchError } = await supabase
            .from('batches')
            .upsert(uniqueBatches, { onConflict: 'batch_code' });

        if (batchError) {
            throw new Error(`Batch Error: ${batchError.message}`);
        }

        // Update each delivery
        for (const { id, data } of updates) {
            const { state, ...deliveryData } = data;
            const { error } = await supabase
                .from('deliveries')
                .update({
                    ...deliveryData,
                    weight_kg: Number(data.weight_kg),
                    sacks: Number(data.sacks),
                    cost_basis: Number(data.cost_basis),
                    lab_results: data.lab_results,
                })
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
