'use server';

import { revalidatePath } from 'next/cache';
import { createClient } from '@/lib/supabase/server';
import { getUserRole, roleCanViewPrices, canViewPrices as canViewPricesGate } from '@/lib/auth';
import type { BlockingGridData, BlockingDetailData, FullDeliveryRecord, BlockDataForBatch, BlockData } from './types';

// ─── Blend Proposal ──────────────────────────────────────────────────────────
// A read-only "what-if": the user selects multiple warehouse blocks; this layer
// returns the blended (balance-weighted) lab stats + price across them, plus a
// yield-adjusted product cost. All weighted averages are computed SQL-side via the
// `fn_blend_proposal` RPC — TypeScript only does the trivial ×1.30 markup and shapes
// the object. Imported by the (separate) frontend selection UI.

/** One selected block's passthrough stats, as it appears in the blend. */
export interface BlendProposalBlock {
  block_loc: string;
  batch_code: string;
  status: string;
  /** current remaining kg in that block */
  balance: number;
  mc: number; ash: number; bd_astm: number; bd_jis: number; grit: number; vm: number; fc: number;
  /** that block's avg ₱/kg — NULL when prices are gated */
  php_kg: number | null;
}

/** The blended what-if result across the selected blocks. */
export interface BlendProposal {
  blocks: BlendProposalBlock[];
  block_count: number;
  /** SUM of balances across selected blocks, kg */
  total_balance: number;
  weighted: { mc: number; ash: number; bd_astm: number; bd_jis: number; grit: number; vm: number; fc: number };
  /** balance-weighted avg ₱/kg across selected blocks; NULL when gated */
  raw_price_per_kg: number | null;
  /** always 30 — the user's chosen "production loss" expressed as a 30% markup */
  production_loss_pct: number;
  /** raw_price_per_kg × 1.30 ; NULL when gated */
  product_cost_per_kg: number | null;
  can_view_prices: boolean;
}

export async function fetchBlockingGridData(): Promise<BlockingGridData> {
  const empty: BlockingGridData = { blocks: {}, canViewPrices: false };

  try {
    const supabase = await createClient();

    // Determine price visibility — default to hidden (safe) if auth unavailable.
    // Don't hard-gate the grid query on getUser(): a stale/expired session token
    // would silently return empty data. The view is readable by authenticated/anon.
    let canViewPrices = false;
    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (user) {
        const role = await getUserRole(user.id);
        canViewPrices = role !== 'Production';
      }
    } catch {
      // Auth check failed — proceed with canViewPrices = false
    }

    const { data: rows, error } = await supabase
      .from('view_blocking_grid')
      .select('*');

    if (error) {
      console.error('[Blocking] view_blocking_grid query error:', error);
      return { blocks: {}, canViewPrices };
    }
    if (!rows || rows.length === 0) {
      console.warn('[Blocking] view_blocking_grid returned no rows');
      return { blocks: {}, canViewPrices };
    }

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
  } catch (err) {
    console.error('[Blocking] fetchBlockingGridData failed:', err);
    return empty;
  }
}

/**
 * Batch-accurate header summary for ONE batch_id — used by the RC Movement matrix to
 * open the shared BlockingDetailPanel for a specific column's batch.
 *
 * Why not reuse `view_blocking_grid`? That view only exposes the batch CURRENTLY
 * occupying each block_loc (status STORED/IN-USE/SUNDRYING/SUNDRIED, non-empty loc).
 * A matrix column for a past cycle-month may point at a batch that is now CLOSED or
 * whose slot was reused — it would be absent from the view. This computes the same
 * weighted-average metrics straight from `batches` + `deliveries` + `rc_out`, keyed on
 * batch_id with NO status filter, so any historical column resolves correctly.
 *
 * Aggregation note: weighted averages (php/kg + lab) and balance are derived here in TS
 * from already-stored transaction rows — NOT recomputing inventory state, just shaping
 * the same numbers `view_blocking_grid` produces for a single batch the view omits.
 */
export async function fetchBlockDataForBatch(batchId: string): Promise<BlockDataForBatch> {
  const empty: BlockDataForBatch = { blockData: null, canViewPrices: false };

  try {
    const supabase = await createClient();

    const { data: { user }, error: authError } = await supabase.auth.getUser();
    if (authError || !user) return empty;

    const role = await getUserRole(user.id);
    const canViewPrices = role !== 'Production';

    const { data: batch, error: batchError } = await supabase
      .from('batches')
      .select('id, batch_code, location_ref, status')
      .eq('id', batchId)
      .single();

    if (batchError || !batch) return { blockData: null, canViewPrices };

    const [deliveriesResult, rcOutResult] = await Promise.all([
      supabase
        .from('deliveries')
        .select('weight_kg, cost_basis, lab_results')
        .eq('batch_code', batch.batch_code),
      supabase
        .from('rc_out')
        .select('weight_kg')
        .eq('batch_id', batchId),
    ]);

    const deliveries = deliveriesResult.data ?? [];
    const rcOut = rcOutResult.data ?? [];

    // Weighted-average accumulators (SUM(metric * weight) / SUM(weight_with_metric)).
    let totalIn = 0;
    let wCost = 0;
    let costWeight = 0;
    const labKeys = ['bd_astm', 'bd_jis', 'ash', 'mc', 'grit', 'vm', 'fc'] as const;
    const wLab: Record<string, number> = {};
    const labWeight: Record<string, number> = {};
    for (const k of labKeys) {
      wLab[k] = 0;
      labWeight[k] = 0;
    }

    for (const d of deliveries) {
      const w = Number(d.weight_kg ?? 0);
      totalIn += w;
      if (d.cost_basis !== null && d.cost_basis !== undefined) {
        wCost += Number(d.cost_basis) * w;
        costWeight += w;
      }
      const lab = (d.lab_results as Record<string, unknown> | null) ?? {};
      for (const k of labKeys) {
        const raw = lab[k];
        if (raw !== null && raw !== undefined && raw !== '') {
          wLab[k] += Number(raw) * w;
          labWeight[k] += w;
        }
      }
    }

    const totalOut = rcOut.reduce((s, r) => s + Number(r.weight_kg ?? 0), 0);
    const wavg = (k: string): number => (labWeight[k] > 0 ? wLab[k] / labWeight[k] : 0);

    const blockData: BlockData = {
      batch_code: batch.batch_code,
      batch_id:   batch.id,
      status:     (batch.status as string) ?? 'CLOSED',
      balance:    totalIn - totalOut,
      total_in:   totalIn,
      php:        canViewPrices ? (costWeight > 0 ? wCost / costWeight : null) : null,
      bd_astm:    wavg('bd_astm'),
      bd_jis:     wavg('bd_jis'),
      ash:        wavg('ash'),
      mc:         wavg('mc'),
      grit:       wavg('grit'),
      vm:         wavg('vm'),
      fc:         wavg('fc'),
    };

    return { blockData, canViewPrices };
  } catch (err) {
    console.error('[Blocking] fetchBlockDataForBatch failed:', err);
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
        .select('id, transaction_date, supplier, sacks, weight_kg, cost_basis, true_weight_kg, deduction_note, lab_results')
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
        // Display-only annotation, passed straight through (NOT price-gated here).
        true_weight_kg:   d.true_weight_kg ?? null,
        deduction_note:   d.deduction_note ?? null,
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

    // Resolve the EFFECTIVE role (respects dev-impersonation cookie) and gate price
    // fields exactly like the sibling fetchBlockingDetail — Production must never receive
    // cost_basis, even via the detail panel's edit dialog / delivery-info path.
    const role = await getUserRole(user.id);
    const canViewPrices = roleCanViewPrices(role);

    const { data, error } = await supabase
      .from('deliveries')
      .select('id, transaction_date, supplier, batch_code, block_loc, truck_plate, sacks, weight_kg, cost_basis, true_weight_kg, deduction_note, remarks, lab_results')
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
        // Withhold cost_basis (omit → undefined) when the caller may not view prices.
        cost_basis:       canViewPrices && data.cost_basis !== null && data.cost_basis !== undefined
          ? Number(data.cost_basis)
          : null,
        // Display-only annotation, passed straight through (NOT price-gated here).
        true_weight_kg:   data.true_weight_kg ?? null,
        deduction_note:   data.deduction_note ?? null,
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

/**
 * Build a Blend Proposal for the given selected blocks — a read-only what-if.
 *
 * The blended `weighted.*` values and `raw_price_per_kg` are BALANCE-WEIGHTED averages
 * computed in SQL (the `fn_blend_proposal` RPC: SUM(stat * balance) / SUM(balance) over
 * the selected rows), per the project rule "never compute weighted averages in TS".
 * Here in TS we only apply the ×1.30 product-cost markup and assemble the object.
 *
 * Price gating: uses the canonical `canViewPrices()` (respects dev-impersonation). When
 * denied, `raw_price_per_kg`, `product_cost_per_kg`, and EVERY block's `php_kg` are set
 * to null BEFORE returning — ₱ data never leaves the server for a no-price user.
 *
 * This is a pure read-only computation: no writes, no audit logs, no revalidatePath.
 */
export async function buildBlendProposal(blockLocs: string[]): Promise<BlendProposal> {
  const PRODUCTION_LOSS_PCT = 30;

  // Normalize + dedupe the input; drop empties/whitespace.
  const locs = Array.from(
    new Set((blockLocs ?? []).map((l) => (l ?? '').trim()).filter((l) => l.length > 0)),
  );

  const emptyProposal: BlendProposal = {
    blocks: [],
    block_count: 0,
    total_balance: 0,
    weighted: { mc: 0, ash: 0, bd_astm: 0, bd_jis: 0, grit: 0, vm: 0, fc: 0 },
    raw_price_per_kg: null,
    production_loss_pct: PRODUCTION_LOSS_PCT,
    product_cost_per_kg: null,
    can_view_prices: false,
  };

  // Resolve price visibility once (canonical gate — respects impersonation, fails closed).
  let canView = false;
  try {
    canView = await canViewPricesGate();
  } catch {
    canView = false;
  }

  if (locs.length === 0) {
    return { ...emptyProposal, can_view_prices: canView };
  }

  try {
    const supabase = await createClient();

    // Per-block passthrough rows (no aggregation here — just shaping the view rows the
    // frontend lists). Ignore any block_loc not present in the view.
    const [rowsResult, aggResult] = await Promise.all([
      supabase
        .from('view_blocking_grid')
        .select('block_loc, batch_code, status, balance, avg_mc, avg_ash, avg_bd_astm, avg_bd_jis, avg_grit, avg_vm, avg_fc, avg_php_kg')
        .in('block_loc', locs),
      // Balance-weighted aggregation — SQL-side, single row.
      supabase.rpc('fn_blend_proposal', { p_block_locs: locs }),
    ]);

    if (rowsResult.error) {
      console.error('[Blocking] buildBlendProposal rows query error:', rowsResult.error);
      return { ...emptyProposal, can_view_prices: canView };
    }
    if (aggResult.error) {
      console.error('[Blocking] buildBlendProposal fn_blend_proposal error:', aggResult.error);
      return { ...emptyProposal, can_view_prices: canView };
    }

    const blocks: BlendProposalBlock[] = (rowsResult.data ?? []).map((r) => ({
      block_loc:  r.block_loc,
      batch_code: r.batch_code,
      status:     r.status,
      balance:    Number(r.balance ?? 0),
      mc:         Number(r.avg_mc      ?? 0),
      ash:        Number(r.avg_ash     ?? 0),
      bd_astm:    Number(r.avg_bd_astm ?? 0),
      bd_jis:     Number(r.avg_bd_jis  ?? 0),
      grit:       Number(r.avg_grit    ?? 0),
      vm:         Number(r.avg_vm      ?? 0),
      fc:         Number(r.avg_fc      ?? 0),
      // Gate ₱ per block BEFORE it leaves the server.
      php_kg:     canView && r.avg_php_kg !== null ? Number(r.avg_php_kg) : null,
    }));

    // fn_blend_proposal returns a single row (or none if no block matched).
    const agg = Array.isArray(aggResult.data) ? aggResult.data[0] : aggResult.data;

    if (!agg || Number(agg.block_count ?? 0) === 0) {
      // No selected loc exists in the view (or SUM(balance) = 0) — graceful empty.
      return {
        blocks,
        block_count: blocks.length,
        total_balance: 0,
        weighted: { mc: 0, ash: 0, bd_astm: 0, bd_jis: 0, grit: 0, vm: 0, fc: 0 },
        raw_price_per_kg: null,
        production_loss_pct: PRODUCTION_LOSS_PCT,
        product_cost_per_kg: null,
        can_view_prices: canView,
      };
    }

    const rawPrice =
      canView && agg.raw_price_per_kg !== null && agg.raw_price_per_kg !== undefined
        ? Number(agg.raw_price_per_kg)
        : null;

    return {
      blocks,
      block_count: Number(agg.block_count ?? blocks.length),
      total_balance: Number(agg.total_balance ?? 0),
      weighted: {
        mc:      Number(agg.w_mc      ?? 0),
        ash:     Number(agg.w_ash     ?? 0),
        bd_astm: Number(agg.w_bd_astm ?? 0),
        bd_jis:  Number(agg.w_bd_jis  ?? 0),
        grit:    Number(agg.w_grit    ?? 0),
        vm:      Number(agg.w_vm      ?? 0),
        fc:      Number(agg.w_fc      ?? 0),
      },
      raw_price_per_kg: rawPrice,
      production_loss_pct: PRODUCTION_LOSS_PCT,
      // ×1.30 exactly (30% markup) — the only price math done in TS.
      product_cost_per_kg: rawPrice !== null ? rawPrice * 1.3 : null,
      can_view_prices: canView,
    };
  } catch (err) {
    console.error('[Blocking] buildBlendProposal failed:', err);
    return { ...emptyProposal, can_view_prices: canView };
  }
}
