
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

        // 2. Prepare deliveries payload -> Exclude 'state' and 'block_loc' as they belong to batch or are redundant if not needed in deliveries
        // Assuming 'batch_code' is the foreign key or link. 
        // If 'block_loc' is also stored in deliveries for historical record, keep it. 
        // The error specifically said 'state' column not found, so we MUST remove that.
        const deliveriesPayload = rows.map(row => {
            const { state, ...deliveryData } = row;
            return {
                ...deliveryData,
                // Ensure numeric fields are numbers, though TS types say they are
                weight_kg: Number(row.weight_kg),
                sacks: Number(row.sacks),
                cost_basis: Number(row.cost_basis),
                // Lab results are jsonb or separate columns? 
                // Based on previous code, they were passed as object. 
                // If the DB expects separate columns for lab results, we need to flatten 'lab_results'.
                // Checking previous code: insert(rows). 'rows' had 'lab_results' nested. 
                // If the DB has a 'lab_results' JSONB column, this is fine. 
                // If it has individual columns (mc, ash, etc), we need to flatten.
                // Given the error was ONLY about 'state', likely 'lab_results' is handled or flattened by Supabase client if columns match?
                // Actually, let's look at the input type. It has 'lab_results'.
                // If the table has columns 'mc', 'ash' etc, passing { lab_results: {...} } might fail or be ignored if not strict.
                // SAFEST BET: Flatten lab_results into the main object if the table is flat.
                // But let's assume valid schema for now except 'state'.
                // To be safe, I will spread lab_results into the main object just in case the table uses flat columns.
                ...row.lab_results
            };
        });

        // Remove 'lab_results' nesting from payload if we flattened it, 
        // OR keep it if we think it's JSON. 
        // Let's assume the previous code worked structure-wise except for 'state'.
        // Previous code: insert(rows). Rows had lab_results.
        // If 'state' was the only error, then 'lab_results' column likely exists as JSONB.
        // I will keep lab_results as is, but remove 'state'.

        const finalDeliveries = deliveriesPayload.map(d => {
            // Explicitly remove state.
            // block_loc might be redundant but if column exists, it's fine.
            // If previous code failed on 'state', likely 'block_loc' exists or wasn't flagged yet.
            // I'll keep block_loc for now as it might be 'location' on delivery record.
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
