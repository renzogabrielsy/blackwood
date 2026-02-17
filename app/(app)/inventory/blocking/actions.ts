'use server';

import { revalidatePath } from 'next/cache';
import { createClient } from '@/lib/supabase/server';
import { getUserRole } from '@/lib/auth';
import type { BlockingGridData, BlockingDetailData, FullDeliveryRecord } from './types';

export async function fetchBlockingGridData(): Promise<BlockingGridData> {
  const empty: BlockingGridData = { blocks: {}, canViewPrices: false };

  try {
    const supabase = await createClient();

    const { data: { user }, error: authError } = await supabase.auth.getUser();
    if (authError || !user) return empty;

    const role = await getUserRole(user.id);
    const canViewPrices = role !== 'Production';

    const { data: rows, error } = await supabase
      .from('view_blocking_grid')
      .select('*');

    if (error || !rows) return { blocks: {}, canViewPrices };

    const blocks: BlockingGridData['blocks'] = {};

    for (const row of rows) {
      blocks[row.block_loc] = {
        batch_code: row.batch_code,
        batch_id:   row.batch_id,
        status:     row.status as 'STORED' | 'IN-USE' | 'SUNDRYING' | 'SUNDRIED',
        balance:    Number(row.balance ?? 0),
        total_in:   Number(row.total_in ?? 0),
        php:        canViewPrices ? (row.avg_php_kg !== null ? Number(row.avg_php_kg) : null) : null,
        bd_astm:    Number(row.avg_bd_astm ?? 0),
        bd_jis:     Number(row.avg_bd_jis  ?? 0),
        ash:        Number(row.avg_ash      ?? 0),
        mc:         Number(row.avg_mc       ?? 0),
        grit:       Number(row.avg_grit     ?? 0),
        vm:         Number(row.avg_vm       ?? 0),
        fc:         Number(row.avg_fc       ?? 0),
      };
    }

    return { blocks, canViewPrices };
  } catch {
    return empty;
  }
}

export async function fetchBlockingDetail(
  batchCode: string,
  batchId: string,
): Promise<BlockingDetailData> {
  const empty: BlockingDetailData = { deliveries: [], usage: [], notes: null, avg_cost: null };

  try {
    const supabase = await createClient();

    const { data: { user }, error: authError } = await supabase.auth.getUser();
    if (authError || !user) return empty;

    const role = await getUserRole(user.id);
    const canViewPrices = role !== 'Production';

    const [deliveriesResult, rcOutResult, batchResult] = await Promise.all([
      supabase
        .from('deliveries')
        .select('id, transaction_date, supplier, sacks, weight_kg, cost_basis, lab_results')
        .eq('batch_code', batchCode)
        .order('transaction_date', { ascending: false }),
      supabase
        .from('rc_out')
        .select('transaction_date, destination, weight_kg, production_batch')
        .eq('batch_id', batchId)
        .order('transaction_date', { ascending: false }),
      supabase
        .from('batches')
        .select('notes, avg_cost')
        .eq('id', batchId)
        .single(),
    ]);

    const deliveries = (deliveriesResult.data ?? []).map((d) => {
      const labResults = (d.lab_results as Record<string, number> | null) ?? {};
      const record: import('./types').DeliveryHistoryRecord = {
        id:               d.id,
        transaction_date: d.transaction_date,
        supplier:         d.supplier,
        sacks:            d.sacks ?? 0,
        weight_kg:        Number(d.weight_kg),
        mc:               labResults.mc !== undefined ? Number(labResults.mc) : undefined,
        bd_astm:          labResults.bd_astm !== undefined ? Number(labResults.bd_astm) : undefined,
        ash:              labResults.ash !== undefined ? Number(labResults.ash) : undefined,
      };
      if (canViewPrices && d.cost_basis !== null && d.cost_basis !== undefined) {
        record.cost_basis = Number(d.cost_basis);
      }
      return record;
    });

    const batchAvgCost = batchResult.data?.avg_cost ?? null;

    const usage = (rcOutResult.data ?? []).map((r) => ({
      transaction_date: r.transaction_date,
      destination:      r.destination,
      weight_kg:        Number(r.weight_kg),
      production_batch: r.production_batch ?? null,
      avg_price:        canViewPrices && batchAvgCost !== null ? Number(batchAvgCost) : null,
    }));

    return {
      deliveries,
      usage,
      notes: batchResult.data?.notes ?? null,
      avg_cost: canViewPrices && batchAvgCost !== null ? Number(batchAvgCost) : null,
    };
  } catch {
    return empty;
  }
}

export async function fetchSingleDelivery(
  deliveryId: string,
): Promise<{ success: true; delivery: FullDeliveryRecord } | { success: false; message: string }> {
  try {
    const supabase = await createClient();

    const { data: { user }, error: authError } = await supabase.auth.getUser();
    if (authError || !user) {
      return { success: false, message: 'Not authenticated' };
    }

    const { data, error } = await supabase
      .from('deliveries')
      .select('id, transaction_date, supplier, batch_code, block_loc, truck_plate, sacks, weight_kg, cost_basis, remarks, lab_results')
      .eq('id', deliveryId)
      .single();

    if (error || !data) {
      return { success: false, message: error?.message ?? 'Delivery not found' };
    }

    const labResults = (data.lab_results as Record<string, number> | null) ?? {};

    return {
      success: true,
      delivery: {
        id:               data.id,
        transaction_date: data.transaction_date,
        supplier:         data.supplier,
        batch_code:       data.batch_code ?? '',
        block_loc:        data.block_loc,
        truck_plate:      data.truck_plate,
        sacks:            data.sacks ?? 0,
        weight_kg:        Number(data.weight_kg),
        cost_basis:       Number(data.cost_basis),
        remarks:          data.remarks,
        lab_results: {
          mc:      Number(labResults.mc ?? 0),
          ash:     Number(labResults.ash ?? 0),
          bd_astm: Number(labResults.bd_astm ?? 0),
          bd_jis:  Number(labResults.bd_jis ?? 0),
          grit:    Number(labResults.grit ?? 0),
          vm:      Number(labResults.vm ?? 0),
          fc:      Number(labResults.fc ?? 0),
        },
      },
    };
  } catch (error: unknown) {
    console.error('fetchSingleDelivery failed:', error);
    return { success: false, message: error instanceof Error ? error.message : 'Unknown error occurred' };
  }
}

export async function updateBlockNotes(batchId: string, notes: string | null) {
  try {
    const supabase = await createClient();

    const { data: { user }, error: authError } = await supabase.auth.getUser();
    if (authError || !user) {
      return { success: false, message: 'Not authenticated' };
    }

    const { error } = await supabase
      .from('batches')
      .update({ notes })
      .eq('id', batchId);

    if (error) {
      console.error('Error updating block notes:', error);
      return { success: false, message: error.message };
    }

    revalidatePath('/inventory');
    return { success: true };
  } catch (error: unknown) {
    console.error('updateBlockNotes failed:', error);
    return { success: false, message: error instanceof Error ? error.message : 'Unknown error occurred' };
  }
}
