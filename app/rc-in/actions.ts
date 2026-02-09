
'use server';

import { revalidatePath } from 'next/cache';
import { supabase } from '@/lib/supabase';

export type DeliveryRow = {
    transaction_date: string;
    batch_code: string;
    state?: string; // Optional for now, corresponds to DB status
    block_loc: string;
    supplier: string;
    truck_plate: string;
    sacks: number;
    weight_kg: number;
    cost_basis: number;
    remarks?: string;
    lab_results: {
        mc: number;
        ash: number;
        bd_astm: number; // Renamed from bd
        bd_jis: number;  // New field
        grit: number;
        vm: number;
        fc: number;
    };
};

export async function submitBulkDeliveries(rows: DeliveryRow[]) {
    if (!rows || rows.length === 0) {
        return { success: false, message: 'No rows to submit' };
    }

    const { error } = await supabase.from('deliveries').insert(rows);

    if (error) {
        console.error('Error inserting bulk deliveries:', error);
        return { success: false, message: error.message };
    }

    revalidatePath('/rc-in');
    return { success: true };
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
