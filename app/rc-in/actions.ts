
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
                // Ensure numeric fields are numbers
                weight_kg: Number(row.weight_kg),
                sacks: Number(row.sacks),
                cost_basis: Number(row.cost_basis),
                // Pass lab_results AS IS (nested object), DO NOT SPREAD IT.
                // This assumes the DB has a 'lab_results' JSONB column.
                lab_results: row.lab_results
            };
        });

        const finalDeliveries = deliveriesPayload.map(d => {
            const { ...rest } = d;
            return rest;
        });

        const { error: deliveryError } = await supabase
            .from('deliveries')
            .insert(finalDeliveries);

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
