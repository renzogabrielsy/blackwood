'use server';

import { revalidatePath } from 'next/cache';
import { createClient } from '@/lib/supabase/server';
import { getUserRole, roleCanViewPrices, canViewPrices as canViewPricesGate } from '@/lib/auth';
import type { BlockingGridData, BlockingDetailData, FullDeliveryRecord, BlockDataForBatch, BlockData, BlockingSupplierMap, BlockSupplierShare } from './types';
import type {
  BlendProposalStatus,
  BlendProposalSummary,
  BlendProposalVersionSummary,
  BlendProposalSaveResult,
  BlendProposalWriteResult,
  BlendProposalVersionResult,
  BlockingMarketBasis,
  BlockingMarketBasisKey,
  BlockingMarketBasesResult,
  BlockingPriceBand,
  BlockingPriceLens,
  BlockingPriceLensResult,
  BlockingAgeBand,
  BlockingAgeLens,
  BlockingAgeLensResult,
  BlockingSupplierBand,
  BlockingSupplierBlock,
  BlockingSupplierLens,
  BlockingSupplierLensResult,
  BlockingSupplierSlice,
  BlendBlockFacts,
  BlendBlockFactsResult,
  BlendBlockSupplierShare,
  BlendAnalysis,
  BlendAnalysisAgeSection,
  BlendAnalysisBlockRef,
  BlendAnalysisInput,
  BlendAnalysisPriceSection,
  BlendAnalysisQualitySection,
  BlendAnalysisRefusalReason,
  BlendAnalysisResult,
  BlendAnalysisUnmeasured,
  BlendAgeBand,
  BlendAgeBlock,
  BlendNaturalCut,
  BlendNaturalGroupLabel,
  BlendNaturalStats,
  BlendPriceBlock,
  BlendPriceNatural,
  BlendPriceNaturalGroup,
  BlendQualityBlock,
  BlendQualityGroup,
  BlendQualityMetric,
  BlendQualityNatural,
  BlendVsMarket,
  BlendVsMarketBand,
  BlendVsMarketUnavailable,
} from './types';
import {
  BLOCKING_PRICE_LENS_DEFAULT_EDGES,
  BLOCKING_PRICE_LENS_MAX_EDGES,
  BLOCKING_TRAILING_DAYS_DEFAULT,
  BLOCKING_TRAILING_DAYS_MAX,
  BLOCKING_TRAILING_DAYS_MIN,
  BLOCKING_ROUNDED_UP_MIN_PHP,
  BLOCKING_ROUNDED_UP_MAX_PHP,
  BLOCKING_AGE_LENS_DEFAULT_EDGES,
  BLOCKING_AGE_LENS_MAX_EDGES,
  BLOCKING_AGE_EDGE_MIN_DAYS,
  BLOCKING_AGE_EDGE_MAX_DAYS,
  BLOCKING_SUPPLIER_LENS_DEFAULT_TOP_N,
  BLOCKING_SUPPLIER_LENS_MIN_TOP_N,
  BLOCKING_SUPPLIER_LENS_MAX_TOP_N,
  BLEND_BLOCK_FACTS_MAX_BATCH_IDS,
  BLEND_ANALYSIS_MAX_BLOCKS,
  BLEND_ANALYSIS_DEFAULT_PRICE_EDGES,
  BLEND_ANALYSIS_DEFAULT_AGE_EDGES,
  BLEND_ANALYSIS_QUALITY_METRICS,
} from './types';
import type { Json } from '@/types/supabase';

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
  /**
   * The batch occupying that block. Present only on a SAVED version (the SQL snapshot
   * builder records it) — the live what-if omits it. It is the IDENTITY a later
   * "Modify" resolves against, because `block_loc` is reused when a batch empties.
   */
  batch_id?: string | null;
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
        canViewPrices = roleCanViewPrices(role);
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
 * WHO filled each block on the grid — the data layer for the Blocking supplier search.
 *
 * Reads `view_blocking_block_suppliers` ONCE and folds it into a lookup the grid can
 * consult per cell. The view is scoped to exactly the blocks `view_blocking_grid`
 * shows, so the two can never disagree about what is on screen.
 *
 * NO AGGREGATION HAPPENS HERE. Every kilogram, share and count is computed in SQL
 * (`kg`, `share_pct`, `supplier_count_in_block`, `block_total_in_kg`); this function
 * only groups rows into the map. In particular the ALL-vs-SOME test is the view's own
 * `supplier_count_in_block` — never `shares.length`.
 *
 * NOT PRICE-GATED, deliberately: the view carries no ₱ column and none derivable, so
 * this payload is safe for every role including Production.
 */
export async function fetchBlockingSupplierMap(): Promise<BlockingSupplierMap> {
  const empty: BlockingSupplierMap = { suppliers: [], byBlock: {} };

  try {
    const supabase = await createClient();

    const { data: rows, error } = await supabase
      .from('view_blocking_block_suppliers')
      .select('block_loc, supplier_key, supplier_display, kg, share_pct, delivery_count, supplier_count_in_block');

    if (error) {
      console.error('[Blocking] view_blocking_block_suppliers query error:', error);
      return empty;
    }
    if (!rows || rows.length === 0) {
      console.warn('[Blocking] view_blocking_block_suppliers returned no rows');
      return empty;
    }
    // PostgREST caps an unpaged read at 1000 rows. Measured 2026-09-02: 202 rows for
    // 170 occupied blocks — far under it. Say so loudly if that ever stops being true.
    if (rows.length >= 1000) {
      console.warn('[Blocking] supplier map hit the PostgREST 1000-row cap — results are truncated');
    }

    const byBlock: BlockingSupplierMap['byBlock'] = {};
    // key -> rollup for the autosuggest list
    const totals = new Map<string, { key: string; display: string; blockCount: number; totalKg: number }>();

    for (const row of rows) {
      const blockLoc = row.block_loc;
      const key = row.supplier_key;
      if (!blockLoc || !key) continue;

      const display = row.supplier_display ?? key;
      const kg = Number(row.kg ?? 0);

      const share: BlockSupplierShare = {
        supplierKey: key,
        supplierDisplay: display,
        kg,
        sharePct: Number(row.share_pct ?? 0),
        deliveryCount: Number(row.delivery_count ?? 0),
      };

      const bucket = byBlock[blockLoc];
      if (bucket) {
        bucket.shares.push(share);
      } else {
        byBlock[blockLoc] = {
          // SQL's count, not shares.length — see the doc comment.
          supplierCount: Number(row.supplier_count_in_block ?? 1),
          shares: [share],
        };
      }

      const rollup = totals.get(key);
      if (rollup) {
        rollup.blockCount += 1;
        rollup.totalKg += kg;
      } else {
        totals.set(key, { key, display, blockCount: 1, totalKg: kg });
      }
    }

    // Biggest contributor first within a block — the UI reads the top one as "mostly".
    for (const bucket of Object.values(byBlock)) {
      bucket.shares.sort((a, b) => b.kg - a.kg || a.supplierKey.localeCompare(b.supplierKey));
    }

    const suppliers = Array.from(totals.values()).sort(
      (a, b) => b.blockCount - a.blockCount || a.key.localeCompare(b.key),
    );

    return { suppliers, byBlock };
  } catch (err) {
    console.error('[Blocking] fetchBlockingSupplierMap failed:', err);
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
    const canViewPrices = roleCanViewPrices(role);

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
    const canViewPrices = roleCanViewPrices(role);

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
  // Normalize + dedupe the input; drop empties/whitespace.
  const locs = Array.from(
    new Set((blockLocs ?? []).map((l) => (l ?? '').trim()).filter((l) => l.length > 0)),
  );

  // Resolve price visibility once (canonical gate — respects impersonation, fails closed).
  let canView = false;
  try {
    canView = await canViewPricesGate();
  } catch {
    canView = false;
  }

  // The production-loss markup has ONE definition and it lives in SQL
  // (`fn_blend_production_loss_pct`), because a SAVED proposal must carry exactly the
  // product cost the operator saw and two copies of the number would eventually
  // disagree. The 0 below is only reachable when the database is unreachable, and on
  // every such path `raw_price_per_kg`/`product_cost_per_kg` are null — which is
  // precisely when the modal, the printout and the PDF do not render the percentage
  // at all, so the sentinel is never displayed.
  const emptyProposal = (lossPct: number): BlendProposal => ({
    blocks: [],
    block_count: 0,
    total_balance: 0,
    weighted: { mc: 0, ash: 0, bd_astm: 0, bd_jis: 0, grit: 0, vm: 0, fc: 0 },
    raw_price_per_kg: null,
    production_loss_pct: lossPct,
    product_cost_per_kg: null,
    can_view_prices: canView,
  });

  try {
    const supabase = await createClient();

    if (locs.length === 0) {
      const lossOnly = await supabase.rpc('fn_blend_production_loss_pct');
      if (lossOnly.error) {
        console.error('[Blocking] fn_blend_production_loss_pct error:', lossOnly.error);
      }
      return emptyProposal(lossOnly.error ? 0 : Number(lossOnly.data ?? 0));
    }

    // Per-block passthrough rows (no aggregation here — just shaping the view rows the
    // frontend lists). Ignore any block_loc not present in the view.
    const [rowsResult, aggResult, lossResult] = await Promise.all([
      supabase
        .from('view_blocking_grid')
        .select('block_loc, batch_code, status, balance, avg_mc, avg_ash, avg_bd_astm, avg_bd_jis, avg_grit, avg_vm, avg_fc, avg_php_kg')
        .in('block_loc', locs),
      // Balance-weighted aggregation — SQL-side, single row.
      supabase.rpc('fn_blend_proposal', { p_block_locs: locs }),
      // Same round trip, no added latency — see the note above.
      supabase.rpc('fn_blend_production_loss_pct'),
    ]);

    if (lossResult.error) {
      console.error('[Blocking] fn_blend_production_loss_pct error:', lossResult.error);
    }
    const PRODUCTION_LOSS_PCT = lossResult.error ? 0 : Number(lossResult.data ?? 0);

    if (rowsResult.error) {
      console.error('[Blocking] buildBlendProposal rows query error:', rowsResult.error);
      return emptyProposal(PRODUCTION_LOSS_PCT);
    }
    if (aggResult.error) {
      console.error('[Blocking] buildBlendProposal fn_blend_proposal error:', aggResult.error);
      return emptyProposal(PRODUCTION_LOSS_PCT);
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
      // The markup, applied with the percentage the DATABASE owns. At the current 30
      // this is ×1.3 exactly — the same arithmetic as before, one definition fewer.
      product_cost_per_kg: rawPrice !== null ? rawPrice * (1 + PRODUCTION_LOSS_PCT / 100) : null,
      can_view_prices: canView,
    };
  } catch (err) {
    console.error('[Blocking] buildBlendProposal failed:', err);
    return emptyProposal(0);
  }
}

// ─── Blend Proposal HISTORY — saved, versioned blends ────────────────────────
//
// Six actions over the two tables + three RPCs added by migration
// `20260902160452_blend_proposal_history`. Three rules govern this whole block:
//
//   1. NOTHING IS COMPUTED HERE. `fn_save_blend_proposal` builds the snapshot in SQL
//      from `view_blocking_grid` + `fn_blend_proposal()`, so a client can never store
//      numbers the yard did not have — and the saved product cost is exactly what the
//      modal showed, because the ×1.30 markup now lives in SQL too.
//   2. A BUSINESS REFUSAL IS DATA, NEVER A THROW. Every RPC returns a jsonb
//      `{ok:false, reason, message}` written for a human; these actions pass the
//      message straight through so the UI can hand it to `errorToast()`.
//   3. ₱ IS NULLED BEFORE THE PAYLOAD LEAVES THE SERVER. Only
//      `fetchBlendProposalVersion` touches prices at all — the list and the version
//      rail are peso-free by construction (their views carry no ₱ column).

/** Shape of the `{ok, ...}` envelope every blend-proposal RPC returns. */
type BlendRpcEnvelope = {
  ok?: boolean;
  reason?: string;
  outcome?: string;
  message?: string;
  unchanged?: boolean;
  proposal_id?: string;
  version_no?: number;
  row_version?: number;
  current_version_no?: number;
  blocks?: string[];
} | null;

const BLEND_RPC_UNREACHABLE =
  'Could not reach the database to save the proposal. Nothing was written — try again.';

/**
 * Save a blend proposal: creates one (no `proposalId`) or appends the next version.
 *
 * Concurrency: `expectedVersionNo` is the version the author was looking at, and the
 * RPC re-checks it inside the UPDATE's own WHERE — so a save made against a stale
 * reading is REFUSED (`reason: 'stale'`, carrying the real `currentVersionNo`) rather
 * than quietly overwriting someone else's version. Re-saving an identical blend
 * returns `unchanged: true` and writes no row.
 */
export async function saveBlendProposal(input: {
  /** Omit to create a new proposal. */
  proposalId?: string | null;
  /** Required and non-blank — the name the operator gives the blend. */
  title: string;
  /** The REMARK. Omitted (undefined/null) leaves an existing remark untouched. */
  notes?: string | null;
  blockLocs: string[];
  /** REQUIRED when `proposalId` is given — the version you were looking at. */
  expectedVersionNo?: number | null;
  /** Why this version differs from the last one. */
  changeNote?: string | null;
}): Promise<BlendProposalSaveResult> {
  try {
    const supabase = await createClient();
    const { data, error } = await supabase.rpc('fn_save_blend_proposal', {
      p_title: input.title,
      p_block_locs: input.blockLocs ?? [],
      p_proposal_id: input.proposalId ?? undefined,
      p_expected_version_no: input.expectedVersionNo ?? undefined,
      p_change_note: input.changeNote ?? undefined,
      p_notes: input.notes ?? undefined,
    });

    if (error) {
      console.error('[Blocking] saveBlendProposal RPC error:', error);
      return { ok: false, reason: 'rpc_error', message: error.message || BLEND_RPC_UNREACHABLE };
    }

    const res = data as BlendRpcEnvelope;
    if (!res?.ok) {
      return {
        ok: false,
        reason: res?.reason ?? 'unknown',
        message: res?.message ?? 'The proposal could not be saved.',
        currentVersionNo: res?.current_version_no,
        blocks: res?.blocks,
      };
    }

    revalidatePath('/inventory/blocking');
    return {
      ok: true,
      proposalId: String(res.proposal_id),
      versionNo: Number(res.version_no ?? 1),
      rowVersion: Number(res.row_version ?? 1),
      unchanged: res.unchanged === true,
      message: res.message,
    };
  } catch (err: unknown) {
    console.error('[Blocking] saveBlendProposal failed:', err);
    return { ok: false, reason: 'exception', message: BLEND_RPC_UNREACHABLE };
  }
}

/**
 * Edit a proposal's identity. The patch is ALLOWLISTED in SQL (`title`, `status`,
 * `fed_on`, `notes`) and a key outside it refuses the whole call — never a partial
 * apply. `status: 'fed'` requires `fedOn`; any other status clears it.
 */
export async function updateBlendProposalHeader(
  id: string,
  expectedRowVersion: number,
  patch: { title?: string; status?: BlendProposalStatus; fed_on?: string | null; notes?: string | null },
): Promise<BlendProposalWriteResult> {
  try {
    const supabase = await createClient();
    const { data, error } = await supabase.rpc('fn_update_blend_proposal_header', {
      p_id: id,
      p_expected_row_version: expectedRowVersion,
      p_patch: patch as unknown as Json,
    });

    if (error) {
      console.error('[Blocking] updateBlendProposalHeader RPC error:', error);
      return { ok: false, reason: 'rpc_error', message: error.message || BLEND_RPC_UNREACHABLE };
    }

    const res = data as BlendRpcEnvelope;
    if (!res?.ok) {
      return {
        ok: false,
        reason: res?.reason ?? 'unknown',
        message: res?.message ?? 'The proposal could not be updated.',
        rowVersion: res?.row_version ?? null,
      };
    }

    revalidatePath('/inventory/blocking');
    return { ok: true, rowVersion: res.row_version ?? null, unchanged: false };
  } catch (err: unknown) {
    console.error('[Blocking] updateBlendProposalHeader failed:', err);
    return { ok: false, reason: 'exception', message: BLEND_RPC_UNREACHABLE };
  }
}

/** One implementation for the archive/restore pair — they differ only by RPC name. */
async function callBlendArchiveRpc(
  fn: 'fn_archive_blend_proposal' | 'fn_restore_blend_proposal',
  id: string,
  expectedRowVersion?: number | null,
): Promise<BlendProposalWriteResult> {
  try {
    const supabase = await createClient();
    const { data, error } = await supabase.rpc(fn, {
      p_id: id,
      p_expected_row_version: expectedRowVersion ?? undefined,
    });

    if (error) {
      console.error(`[Blocking] ${fn} RPC error:`, error);
      return { ok: false, reason: 'rpc_error', message: error.message || BLEND_RPC_UNREACHABLE };
    }

    const res = data as BlendRpcEnvelope;
    if (!res?.ok) {
      return {
        ok: false,
        reason: res?.reason ?? 'unknown',
        message: res?.message ?? 'The proposal could not be changed.',
        rowVersion: res?.row_version ?? null,
      };
    }

    revalidatePath('/inventory/blocking');
    return { ok: true, rowVersion: res.row_version ?? null, unchanged: res.unchanged === true };
  } catch (err: unknown) {
    console.error(`[Blocking] ${fn} failed:`, err);
    return { ok: false, reason: 'exception', message: BLEND_RPC_UNREACHABLE };
  }
}

/**
 * SOFT-archive a proposal. There is no hard delete in this feature — no delete RPC,
 * no DELETE grant, no DELETE policy — because a proposal that was made is history
 * even if it was a bad idea. Archiving something already archived is a no-op.
 */
export async function archiveBlendProposal(
  id: string,
  expectedRowVersion?: number | null,
): Promise<BlendProposalWriteResult> {
  return callBlendArchiveRpc('fn_archive_blend_proposal', id, expectedRowVersion);
}

/** Undo `archiveBlendProposal`. A soft delete you cannot undo is not reversibility. */
export async function restoreBlendProposal(
  id: string,
  expectedRowVersion?: number | null,
): Promise<BlendProposalWriteResult> {
  return callBlendArchiveRpc('fn_restore_blend_proposal', id, expectedRowVersion);
}

/**
 * The Proposals list. Reads `view_blend_proposal_list`, which is PESO-FREE, so this
 * payload needs no price gate and is safe for every role including Production.
 *
 * Failure returns an empty list and logs — the same posture as
 * `fetchBlockingSupplierMap`: the proposals dialog degrades to "nothing saved yet"
 * rather than taking the Blocking page down with it.
 */
export async function fetchBlendProposalList(
  opts: { includeArchived?: boolean } = {},
): Promise<BlendProposalSummary[]> {
  try {
    const supabase = await createClient();
    let query = supabase
      .from('view_blend_proposal_list')
      .select(
        'id, title, notes, status, fed_on, current_version_no, row_version, version_count, block_count, total_balance_kg, w_mc, w_ash, w_bd_astm, current_version_change_note, current_version_created_at, is_archived, archived_at, created_at, created_by_name, updated_at, updated_by_name',
      )
      .order('updated_at', { ascending: false });

    if (!opts.includeArchived) query = query.is('archived_at', null);

    const { data, error } = await query;
    if (error) {
      console.error('[Blocking] fetchBlendProposalList error:', error);
      return [];
    }

    return (data ?? []).map((r) => ({
      id: String(r.id),
      title: String(r.title ?? ''),
      notes: r.notes ?? null,
      status: (r.status ?? 'draft') as BlendProposalStatus,
      fedOn: r.fed_on ?? null,
      currentVersionNo: Number(r.current_version_no ?? 1),
      rowVersion: Number(r.row_version ?? 1),
      versionCount: Number(r.version_count ?? 0),
      blockCount: r.block_count === null || r.block_count === undefined ? null : Number(r.block_count),
      totalBalanceKg:
        r.total_balance_kg === null || r.total_balance_kg === undefined ? null : Number(r.total_balance_kg),
      wMc: r.w_mc === null || r.w_mc === undefined ? null : Number(r.w_mc),
      wAsh: r.w_ash === null || r.w_ash === undefined ? null : Number(r.w_ash),
      wBdAstm: r.w_bd_astm === null || r.w_bd_astm === undefined ? null : Number(r.w_bd_astm),
      currentVersionChangeNote: r.current_version_change_note ?? null,
      currentVersionCreatedAt: r.current_version_created_at ?? null,
      isArchived: r.is_archived === true,
      archivedAt: r.archived_at ?? null,
      createdAt: String(r.created_at),
      createdByName: r.created_by_name ?? null,
      updatedAt: String(r.updated_at),
      updatedByName: r.updated_by_name ?? null,
    }));
  } catch (err: unknown) {
    console.error('[Blocking] fetchBlendProposalList failed:', err);
    return [];
  }
}

/** The version rail for one proposal — also peso-free, also degrades to []. */
export async function fetchBlendProposalVersions(
  proposalId: string,
): Promise<BlendProposalVersionSummary[]> {
  try {
    const supabase = await createClient();
    const { data, error } = await supabase
      .from('view_blend_proposal_versions')
      .select(
        'proposal_id, version_no, is_current, block_count, total_balance_kg, w_mc, w_ash, w_bd_astm, w_bd_jis, w_grit, w_vm, w_fc, change_note, parent_version_no, computed_at, created_at, created_by_name',
      )
      .eq('proposal_id', proposalId)
      .order('version_no', { ascending: true });

    if (error) {
      console.error('[Blocking] fetchBlendProposalVersions error:', error);
      return [];
    }

    const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));

    return (data ?? []).map((r) => ({
      proposalId: String(r.proposal_id),
      versionNo: Number(r.version_no),
      isCurrent: r.is_current === true,
      blockCount: num(r.block_count),
      totalBalanceKg: num(r.total_balance_kg),
      wMc: num(r.w_mc),
      wAsh: num(r.w_ash),
      wBdAstm: num(r.w_bd_astm),
      wBdJis: num(r.w_bd_jis),
      wGrit: num(r.w_grit),
      wVm: num(r.w_vm),
      wFc: num(r.w_fc),
      changeNote: r.change_note ?? null,
      parentVersionNo: r.parent_version_no === null || r.parent_version_no === undefined
        ? null
        : Number(r.parent_version_no),
      computedAt: r.computed_at ?? null,
      createdAt: String(r.created_at),
      createdByName: r.created_by_name ?? null,
    }));
  } catch (err: unknown) {
    console.error('[Blocking] fetchBlendProposalVersions failed:', err);
    return [];
  }
}

/**
 * One saved version, in the exact shape `BlendProposalDialog` renders.
 *
 * THIS IS THE ONE PRICE-BEARING READ IN THE FEATURE. The stored snapshot carries the
 * true ₱ figures; when `canViewPrices()` is false this nulls `raw_price_per_kg`,
 * `product_cost_per_kg` and EVERY `blocks[].php_kg` and sets `can_view_prices: false`
 * BEFORE the payload leaves the server — exactly what `buildBlendProposal` does, so
 * the dialog needs no new gating code.
 */
export async function fetchBlendProposalVersion(
  proposalId: string,
  versionNo: number,
): Promise<BlendProposalVersionResult> {
  let canView = false;
  try {
    canView = await canViewPricesGate();
  } catch {
    canView = false;
  }

  try {
    const supabase = await createClient();

    const [snapResult, metaResult, headResult] = await Promise.all([
      supabase
        .from('blend_proposal_versions')
        .select('snapshot')
        .eq('proposal_id', proposalId)
        .eq('version_no', versionNo)
        .maybeSingle(),
      supabase
        .from('view_blend_proposal_versions')
        .select('version_no, change_note, computed_at, created_at, created_by_name')
        .eq('proposal_id', proposalId)
        .eq('version_no', versionNo)
        .maybeSingle(),
      supabase
        .from('view_blend_proposal_list')
        .select('title, notes')
        .eq('id', proposalId)
        .maybeSingle(),
    ]);

    if (snapResult.error) {
      console.error('[Blocking] fetchBlendProposalVersion snapshot error:', snapResult.error);
      return { ok: false, message: 'Could not load that version of the proposal.' };
    }
    if (!snapResult.data?.snapshot) {
      return { ok: false, message: `Version ${versionNo} of that proposal was not found.` };
    }

    const snap = snapResult.data.snapshot as Record<string, unknown>;
    const meta = metaResult.data;
    const head = headResult.data;

    const n = (v: unknown) => Number(v ?? 0);
    const rawSnapshotBlocks = Array.isArray(snap.blocks) ? (snap.blocks as Record<string, unknown>[]) : [];

    const blocks = rawSnapshotBlocks.map((b) => ({
      block_loc: String(b.block_loc ?? ''),
      batch_id: b.batch_id === null || b.batch_id === undefined ? null : String(b.batch_id),
      batch_code: String(b.batch_code ?? ''),
      status: String(b.status ?? ''),
      balance: n(b.balance),
      mc: n(b.mc),
      ash: n(b.ash),
      bd_astm: n(b.bd_astm),
      bd_jis: n(b.bd_jis),
      grit: n(b.grit),
      vm: n(b.vm),
      fc: n(b.fc),
      // Gate ₱ per block BEFORE it leaves the server.
      php_kg: canView && b.php_kg !== null && b.php_kg !== undefined ? Number(b.php_kg) : null,
    }));

    const rawPrice =
      canView && snap.raw_price_per_kg !== null && snap.raw_price_per_kg !== undefined
        ? Number(snap.raw_price_per_kg)
        : null;
    const productCost =
      canView && snap.product_cost_per_kg !== null && snap.product_cost_per_kg !== undefined
        ? Number(snap.product_cost_per_kg)
        : null;

    const weighted = (snap.weighted ?? {}) as Record<string, unknown>;

    return {
      ok: true,
      proposal: {
        blocks,
        block_count: Number(snap.block_count ?? blocks.length),
        total_balance: n(snap.total_balance),
        weighted: {
          mc: n(weighted.mc),
          ash: n(weighted.ash),
          bd_astm: n(weighted.bd_astm),
          bd_jis: n(weighted.bd_jis),
          grit: n(weighted.grit),
          vm: n(weighted.vm),
          fc: n(weighted.fc),
        },
        raw_price_per_kg: rawPrice,
        production_loss_pct: n(snap.production_loss_pct),
        product_cost_per_kg: productCost,
        can_view_prices: canView,
        proposal_id: proposalId,
        version_no: Number(meta?.version_no ?? versionNo),
        title: String(head?.title ?? ''),
        notes: head?.notes ?? null,
        change_note: meta?.change_note ?? null,
        created_at: String(meta?.created_at ?? ''),
        created_by_name: meta?.created_by_name ?? null,
        computed_at: (snap.computed_at as string | undefined) ?? meta?.computed_at ?? null,
      },
    };
  } catch (err: unknown) {
    console.error('[Blocking] fetchBlendProposalVersion failed:', err);
    return { ok: false, message: 'Could not load that version of the proposal.' };
  }
}

// ─── Price lens — DATA LAYER ──────────────────────────────────────────────────
//
// Renzo, 2026-09-19: see the blocking grid "ratio'd in highlights based on price
// filter" — if market is 40.23 then ₱41 and up is above market. Two actions over the
// two SQL functions added by migration `20260919025729_blocking_price_lens`:
//
//   fetchBlockingMarketBases()  what market COSTS right now, four ways
//   fetchBlockingPriceLens()    classify the yard against a market price you GIVE it
//
// Three rules govern this block.
//
//   1. THE GATE COMES FIRST, AND IT IS A REFUSAL — NOT A NULLING PASS.
//      Everywhere else in this file a ₱ field is set to null before the payload
//      leaves the server. That technique cannot work here: the lens's whole output
//      IS price information, because band membership pins a block's ₱/kg to within a
//      peso, and even `bands[].blockCount` describes the price distribution of the
//      yard. So both actions call the canonical `canViewPrices()` FIRST and return
//      `{ ok: false, reason: 'prices_hidden' }` WITHOUT TOUCHING THE DATABASE. There
//      is nothing to null, and a Production user's request never reaches the RPC.
//
//   2. NOTHING IS COMPUTED HERE. Market is a weighted average and the bands are
//      arithmetic over it, so all of it lives in SQL (CLAUDE.md: never compute a
//      weighted average in TypeScript). These functions validate their inputs,
//      camelCase the rows, and fold `blocks[]` into the `block_loc → band` lookup the
//      grid needs per cell. That fold is a re-keying, not an aggregation.
//
//   3. A BUSINESS REFUSAL IS DATA, NEVER A THROW. The RPC returns
//      `{ok:false, reason, message}` written for a human; these actions pass the
//      message straight through so the UI can hand it to `errorToast()`.
//
// Read-only: no writes, no audit logs, no `revalidatePath()`.

const PRICES_HIDDEN_MESSAGE =
  'The price lens is not available for your role — it describes what each block cost.';
const LENS_UNREACHABLE_MESSAGE =
  'Could not reach the database to work out the price lens. Nothing changed — try again.';

/** The `{ok, ...}` envelope `fn_blocking_price_lens` returns. */
type PriceLensEnvelope = {
  ok?: boolean;
  reason?: string;
  message?: string;
  market_php_kg?: number | string | null;
  rounded_up_php?: number | string | null;
  edge_offsets?: number[] | null;
  bands?: Array<Record<string, unknown>> | null;
  blocks?: Array<Record<string, unknown>> | null;
  unpriced?: { block_count?: number | null; kg?: number | string | null } | null;
  total?: {
    block_count?: number | null;
    kg?: number | string | null;
    kg_weighted_php_kg?: number | string | null;
  } | null;
} | null;

const lensNum = (v: unknown): number => Number(v ?? 0);
const lensNumOrNull = (v: unknown): number | null =>
  v === null || v === undefined ? null : Number(v);

/**
 * NORMALIZE THE EDGE LIST THE WAY SQL DOES — finite whole numbers, de-duplicated,
 * ascending — and refuse what it would refuse, so the two can never disagree.
 *
 * The one thing that MUST happen here rather than in SQL is the integrality check.
 * `p_edge_offsets` is declared `int[]`, so Postgres has already rounded `1.5` to `2`
 * by the time the function body runs and that refusal is structurally unreachable
 * there. It IS decidable in TypeScript, so it lives here — and it reuses the SQL's
 * own `invalid_edge` reason rather than inventing a second vocabulary.
 *
 * De-duplicating BEFORE the cap (rather than capping the raw length) is what keeps
 * the two caps identical: `[-1,-1,0,0,1,1,2]` is seven raw offsets but four real
 * edges, and SQL measures the cap on the collapsed list.
 */
function normalizeEdgeOffsets(
  input: readonly number[] | null | undefined,
):
  | { ok: true; edges: number[] }
  | { ok: false; reason: 'invalid_edge' | 'no_edges' | 'too_many_edges'; message: string } {
  const raw = input === null || input === undefined ? [...BLOCKING_PRICE_LENS_DEFAULT_EDGES] : input;

  if (!Array.isArray(raw)) {
    return {
      ok: false,
      reason: 'invalid_edge',
      message: 'Every band edge has to be a whole number of pesos away from market.',
    };
  }
  for (const e of raw) {
    if (typeof e !== 'number' || !Number.isFinite(e) || !Number.isInteger(e)) {
      return {
        ok: false,
        reason: 'invalid_edge',
        message: 'Every band edge has to be a whole number of pesos away from market.',
      };
    }
  }

  const edges = Array.from(new Set(raw)).sort((a, b) => a - b);

  if (edges.length === 0) {
    return {
      ok: false,
      reason: 'no_edges',
      message:
        'A price lens needs at least one band edge — with none, every block is in the same band and nothing is highlighted.',
    };
  }
  if (edges.length > BLOCKING_PRICE_LENS_MAX_EDGES) {
    return {
      ok: false,
      reason: 'too_many_edges',
      message: `A price lens takes at most ${BLOCKING_PRICE_LENS_MAX_EDGES} band edges; this one has ${edges.length}.`,
    };
  }
  return { ok: true, edges };
}

/**
 * What "market" costs right now, four ways — `this_month` (the default basis),
 * `last_month`, `last_3_months` and `trailing_days`.
 *
 * Market is the weighted average ₱/kg of MARKET-class PRICED deliveries, and the three
 * calendar bases are SELECTed from `view_analytics_rcin_monthly` inside the RPC so this
 * number can never disagree with the `/analytics` matrix. The fifth basis the UI offers,
 * `manual`, is a ₱ the operator types: it needs nothing from this action, and it goes
 * through the SAME classifier below.
 *
 * `bases[].marketPhpKg` is NULL — never 0 — when that window has no priced market
 * kilos. Offer another basis; do not coerce it to a number.
 *
 * PRICE-GATED BY REFUSAL: a `!canViewPrices()` caller gets
 * `{ ok: false, reason: 'prices_hidden' }` and the database is never queried.
 */
export async function fetchBlockingMarketBases(
  trailingDays: number = BLOCKING_TRAILING_DAYS_DEFAULT,
): Promise<BlockingMarketBasesResult> {
  // (1) THE GATE, BEFORE ANYTHING ELSE. Fails closed on any error.
  let canView = false;
  try {
    canView = await canViewPricesGate();
  } catch {
    canView = false;
  }
  if (!canView) return { ok: false, reason: 'prices_hidden', message: PRICES_HIDDEN_MESSAGE };

  const days = Number(trailingDays);
  if (
    !Number.isFinite(days) ||
    !Number.isInteger(days) ||
    days < BLOCKING_TRAILING_DAYS_MIN ||
    days > BLOCKING_TRAILING_DAYS_MAX
  ) {
    return {
      ok: false,
      reason: 'invalid_trailing_days',
      message: `The trailing window has to be a whole number of days between ${BLOCKING_TRAILING_DAYS_MIN} and ${BLOCKING_TRAILING_DAYS_MAX}.`,
    };
  }

  try {
    const supabase = await createClient();
    const { data, error } = await supabase.rpc('fn_blocking_market_bases', { p_trailing_days: days });

    if (error) {
      console.error('[Blocking] fn_blocking_market_bases error:', error);
      return { ok: false, reason: 'rpc_error', message: error.message || LENS_UNREACHABLE_MESSAGE };
    }

    // One row per basis. Typed locally rather than leaning on the generated RPC row
    // type, which declares `market_php_kg: number` and would hide the NULL the
    // function deliberately returns when a window has no priced market kilos.
    type BasisRow = {
      basis_key: string;
      market_php_kg: number | null;
      priced_kg: number | null;
      delivery_count: number | null;
      from_date: string;
      to_date: string;
    };

    const bases: BlockingMarketBasis[] = ((data ?? []) as BasisRow[]).map((r) => ({
      basisKey: r.basis_key as BlockingMarketBasisKey,
      // NULL is preserved on purpose — see the type doc. Never `?? 0`.
      marketPhpKg: lensNumOrNull(r.market_php_kg),
      pricedKg: lensNum(r.priced_kg),
      deliveryCount: lensNum(r.delivery_count),
      fromDate: String(r.from_date),
      toDate: String(r.to_date),
    }));

    return { ok: true, bases, trailingDays: days };
  } catch (err: unknown) {
    console.error('[Blocking] fetchBlockingMarketBases failed:', err);
    return { ok: false, reason: 'exception', message: LENS_UNREACHABLE_MESSAGE };
  }
}

/**
 * Classify every occupied block against a market ₱/kg — the lens itself.
 *
 * It takes the market price as an ARGUMENT, which is the point: whichever basis the
 * operator picked (or typed, for `manual`), the banding and classification happen in
 * ONE place, so "above market" can only ever mean one thing.
 *
 * `edgeOffsets` are whole-peso offsets from `R = floor(market) + 1`; the default
 * `[-1, 0]` gives below market / at market / above market. They are de-duplicated and
 * sorted here exactly as SQL does, and at most 6 survive.
 *
 * `roundedUpPhp` (2026-09-21) SETS R instead, because **a typed price is the line
 * itself**. The measured rule rounds up — right for a market of 40.23, wrong for an
 * operator who typed ₱41 and got a lens cut at 42. **THE UI RULE: for the `manual` basis
 * pass `Math.ceil(typedPrice)`; for every MEASURED basis pass nothing.** Omitted, the
 * payload is byte-identical to what it was before the parameter existed, so no existing
 * caller and no stored lens configuration changes.
 *
 * A block with NO price is ABSENT from `lens.bandByBlock` and counted in
 * `lens.unpriced` — render it un-lensed, never in the cheapest band.
 *
 * PRICE-GATED BY REFUSAL: a `!canViewPrices()` caller gets
 * `{ ok: false, reason: 'prices_hidden' }` and the database is never queried. Band
 * membership alone is a price leak, so there is no partial payload to return.
 */
export async function fetchBlockingPriceLens(
  marketPhpKg: number,
  edgeOffsets: readonly number[] = BLOCKING_PRICE_LENS_DEFAULT_EDGES,
  roundedUpPhp?: number | null,
): Promise<BlockingPriceLensResult> {
  // (1) THE GATE, BEFORE ANYTHING ELSE. Fails closed on any error.
  let canView = false;
  try {
    canView = await canViewPricesGate();
  } catch {
    canView = false;
  }
  if (!canView) return { ok: false, reason: 'prices_hidden', message: PRICES_HIDDEN_MESSAGE };

  // (2) Inputs. The same refusals the RPC would give, in the same words.
  const price = Number(marketPhpKg);
  if (marketPhpKg === null || marketPhpKg === undefined || Number.isNaN(price)) {
    return {
      ok: false,
      reason: 'no_market_price',
      message:
        'No market price to compare against yet. Pick a different market basis, or type one in.',
    };
  }
  if (!Number.isFinite(price) || price <= 0) {
    return {
      ok: false,
      reason: 'invalid_market_price',
      message:
        'The market price has to be a real amount above zero — a price of zero would put every block above market.',
    };
  }

  const normalized = normalizeEdgeOffsets(edgeOffsets);
  if (!normalized.ok) return { ok: false, reason: normalized.reason, message: normalized.message };

  // (3) The OPTIONAL typed cut line. `null`/`undefined` is not a refusal — it is the
  // "compute R from the market price" signal, and it is what every MEASURED basis sends.
  // Integrality is checked HERE because it cannot be checked in SQL: `p_rounded_up_php`
  // is declared `int`, so Postgres has already rounded 40.5 to 41 by the time the
  // function body runs. The upper bound is int4's ceiling, not a business rule.
  let overrideR: number | null = null;
  if (roundedUpPhp !== null && roundedUpPhp !== undefined) {
    const r = Number(roundedUpPhp);
    if (
      !Number.isFinite(r) ||
      !Number.isInteger(r) ||
      r < BLOCKING_ROUNDED_UP_MIN_PHP ||
      r > BLOCKING_ROUNDED_UP_MAX_PHP
    ) {
      return {
        ok: false,
        reason: 'invalid_rounded_up',
        message: `The price you type has to be a whole number of pesos, at least ₱${BLOCKING_ROUNDED_UP_MIN_PHP}.`,
      };
    }
    overrideR = r;
  }

  try {
    const supabase = await createClient();
    const { data, error } = await supabase.rpc('fn_blocking_price_lens', {
      p_market_php_kg: price,
      p_edge_offsets: normalized.edges,
      // Sent as an explicit null when absent, which is exactly the SQL default — so the
      // no-override path stays the one the pre-override function took.
      p_rounded_up_php: overrideR,
    });

    if (error) {
      console.error('[Blocking] fn_blocking_price_lens error:', error);
      return { ok: false, reason: 'rpc_error', message: error.message || LENS_UNREACHABLE_MESSAGE };
    }

    const res = data as PriceLensEnvelope;
    if (!res?.ok) {
      const reason = res?.reason;
      return {
        ok: false,
        // The RPC's own vocabulary, passed through; anything unrecognized is reported
        // as an rpc_error rather than silently widening the union.
        reason:
          reason === 'no_market_price' ||
          reason === 'invalid_market_price' ||
          reason === 'invalid_rounded_up' ||
          reason === 'invalid_edge' ||
          reason === 'no_edges' ||
          reason === 'too_many_edges'
            ? reason
            : 'rpc_error',
        message: res?.message ?? 'The price lens could not be worked out.',
      };
    }

    const bands: BlockingPriceBand[] = (res.bands ?? []).map((b) => ({
      index: lensNum(b.index),
      // null = OPEN. lensNumOrNull, never `?? 0` — a zero bound would be a real ₱0 edge.
      lowerPhp: lensNumOrNull(b.lower_php),
      upperPhp: lensNumOrNull(b.upper_php),
      blockCount: lensNum(b.block_count),
      kg: lensNum(b.kg),
      kgSharePct: lensNumOrNull(b.kg_share_pct),
      blockSharePct: lensNumOrNull(b.block_share_pct),
      // Null on an EMPTY band — no charcoal in the band means no price in the band.
      kgWeightedPhpKg: lensNumOrNull(b.kg_weighted_php_kg),
    }));

    // RE-KEY, not aggregate: the grid needs a per-cell lookup, and SQL already decided
    // which band every block is in. Unpriced blocks are absent from `blocks[]` by
    // construction, so they are absent here too — which is the contract.
    const bandByBlock: Record<string, number> = {};
    for (const b of res.blocks ?? []) {
      const loc = b.block_loc;
      if (typeof loc !== 'string' || loc.length === 0) continue;
      bandByBlock[loc] = lensNum(b.band_index);
    }

    const lens: BlockingPriceLens = {
      marketPhpKg: lensNum(res.market_php_kg),
      roundedUpPhp: lensNum(res.rounded_up_php),
      edgeOffsets: Array.isArray(res.edge_offsets)
        ? res.edge_offsets.map((e) => Number(e))
        : normalized.edges,
      bands,
      bandByBlock,
      unpriced: { blockCount: lensNum(res.unpriced?.block_count), kg: lensNum(res.unpriced?.kg) },
      total: {
        blockCount: lensNum(res.total?.block_count),
        kg: lensNum(res.total?.kg),
        // Weighted over the PRICED population only, while the counts cover every block —
        // see the type doc. Null-preserving: nothing priced means no price.
        kgWeightedPhpKg: lensNumOrNull(res.total?.kg_weighted_php_kg),
      },
    };

    return { ok: true, lens };
  } catch (err: unknown) {
    console.error('[Blocking] fetchBlockingPriceLens failed:', err);
    return { ok: false, reason: 'exception', message: LENS_UNREACHABLE_MESSAGE };
  }
}

// ─── Age lens — DATA LAYER ────────────────────────────────────────────────────
//
// "Show me the charcoal that has been sitting." The SECOND lens on the frame the price
// lens built, over `fn_blocking_age_lens` (migration `20260919133042_blocking_age_lens`).
// It is the price lens's sibling in shape and its OPPOSITE in exactly one respect:
//
//   ***  THERE IS NO PRICE GATE HERE, AND THAT IS DELIBERATE. DO NOT ADD ONE.  ***
//
//      Nothing in this payload is money and nothing in it is derivable back into
//      money: `fn_blocking_age_lens` publishes days, kilograms, counts and
//      percentages, and `view_batch_age_days` has no cost/price/value column at all.
//      So the Age lens is visible to EVERY role INCLUDING Production — the same
//      posture as `view_blocking_block_suppliers` and the whole analytics production
//      matrix. The price lens must REFUSE a `!canViewPrices()` caller because band
//      membership pins a block's ₱/kg to within a peso; that argument has no analogue
//      here, and copying the gate across would hide an age figure from the one role
//      that walks the yard. `scripts/verify-blocking-age-lens.ts` asserts that this
//      function contains NO `canViewPrices` call, so the asymmetry cannot be
//      "tidied up" by accident.
//
// What it DOES require is a signed-in user, the same way `fetchBlockDataForBatch` and
// the other non-price reads in this file do.
//
// Three rules it shares with its sibling.
//
//   1. NOTHING IS COMPUTED HERE. Age is a weighted mean and the bands are arithmetic
//      over it, so all of it lives in SQL (CLAUDE.md: never compute a weighted average
//      in TypeScript). This function validates its inputs, camelCases the rows, and
//      folds `blocks[]` into the two per-cell lookups the grid needs. That fold is a
//      re-keying, not an aggregation.
//
//   2. A BUSINESS REFUSAL IS DATA, NEVER A THROW. The RPC returns
//      `{ok:false, reason, message}` written for a human; this action passes the
//      message straight through so the UI can hand it to `errorToast()`.
//
//   3. NULL IS PRESERVED. An empty band's `kgWeightedAgeDays`, and the totals when
//      nothing is dated, are null — never coerced to 0. "No charcoal of this age" and
//      "charcoal that is 0 days old" are different answers.
//
// Read-only: no writes, no audit logs, no `revalidatePath()`.

const AGE_LENS_UNREACHABLE_MESSAGE =
  'Could not reach the database to work out the age lens. Nothing changed — try again.';
const AGE_LENS_EDGE_MESSAGE = `Every cut line has to be a whole number of days between ${BLOCKING_AGE_EDGE_MIN_DAYS} and ${BLOCKING_AGE_EDGE_MAX_DAYS.toLocaleString('en-US')}.`;

/** The `{ok, ...}` envelope `fn_blocking_age_lens` returns. */
type AgeLensEnvelope = {
  ok?: boolean;
  reason?: string;
  message?: string;
  as_of?: string | null;
  edge_days?: number[] | null;
  bands?: Array<Record<string, unknown>> | null;
  blocks?: Array<Record<string, unknown>> | null;
  undated?: { block_count?: number | null; kg?: number | string | null } | null;
  total?: {
    block_count?: number | null;
    kg?: number | string | null;
    kg_weighted_age_days?: number | string | null;
    oldest_age_days?: number | string | null;
    oldest_block_loc?: string | null;
  } | null;
} | null;

/**
 * NORMALIZE THE CUT LINES THE WAY SQL DOES — finite whole numbers of days, all in
 * 1..5000, de-duplicated, ascending — and refuse what it would refuse, so the two can
 * never disagree.
 *
 * The one check that MUST happen here rather than in SQL is INTEGRALITY. `p_edge_days`
 * is declared `int[]`, so Postgres has already rounded `59.5` to `60` by the time the
 * function body runs and that refusal is structurally unreachable there. It IS
 * decidable in TypeScript, so it lives here — reusing the SQL's own `invalid_edge`
 * reason rather than inventing a second vocabulary.
 *
 * De-duplicating BEFORE the cap (rather than capping the raw length) is what keeps the
 * two caps identical: `[60,60,120,120,365,365,730]` is seven raw cut lines but four
 * real ones, and SQL measures the cap on the collapsed list.
 *
 * NOT EXPORTED, and not because it wouldn't be useful: this file carries `'use server'`,
 * so every export must be an async server function — a synchronous helper cannot leave
 * it. The UI's own pure twin belongs in `lens/age-lens-settings.ts`, exactly as the
 * price lens keeps `normalizeEdgeOffsets` both here (local) and there (pure).
 */
function normalizeEdgeDays(
  input: readonly number[] | null | undefined,
):
  | { ok: true; edges: number[] }
  | { ok: false; reason: 'invalid_edge' | 'no_edges' | 'too_many_edges'; message: string } {
  const raw = input === null || input === undefined ? [...BLOCKING_AGE_LENS_DEFAULT_EDGES] : input;

  if (!Array.isArray(raw)) {
    return { ok: false, reason: 'invalid_edge', message: AGE_LENS_EDGE_MESSAGE };
  }
  for (const e of raw) {
    if (
      typeof e !== 'number' ||
      !Number.isFinite(e) ||
      !Number.isInteger(e) ||
      e < BLOCKING_AGE_EDGE_MIN_DAYS ||
      e > BLOCKING_AGE_EDGE_MAX_DAYS
    ) {
      return { ok: false, reason: 'invalid_edge', message: AGE_LENS_EDGE_MESSAGE };
    }
  }

  const edges = Array.from(new Set(raw)).sort((a, b) => a - b);

  if (edges.length === 0) {
    return {
      ok: false,
      reason: 'no_edges',
      message:
        'An age lens needs at least one cut line — with none, every block is in the same band and nothing is highlighted.',
    };
  }
  if (edges.length > BLOCKING_AGE_LENS_MAX_EDGES) {
    return {
      ok: false,
      reason: 'too_many_edges',
      message: `An age lens takes at most ${BLOCKING_AGE_LENS_MAX_EDGES} cut lines; this one has ${edges.length}.`,
    };
  }
  return { ok: true, edges };
}

/**
 * Classify every occupied block by HOW OLD its charcoal is — the age lens itself.
 *
 * `edgeDays` are cut lines in DAYS; the default `[60, 120, 365]` gives up to 60 days /
 * 60–120 / 120–365 / over a year. They are de-duplicated and sorted here exactly as SQL
 * does, and at most 6 survive.
 *
 * AGE IS NOT DEFINED HERE. It is the batch's kg-weighted MEAN DELIVERY DATE carried by
 * its remaining balance, read from `view_batch_age_days` inside the RPC — the same
 * statistic `view_analytics_aging_watchlist` publishes, proven equal every run. There
 * is no FIFO and none is possible.
 *
 * A block whose batch has NO dated delivery is ABSENT from `lens.bandByBlock` and
 * counted in `lens.undated` — render it un-lensed, never in the freshest band.
 *
 * NOT price-gated, on purpose — see the block comment above. Every role, Production
 * included, may read this.
 */
export async function fetchBlockingAgeLens(
  edgeDays: readonly number[] = BLOCKING_AGE_LENS_DEFAULT_EDGES,
): Promise<BlockingAgeLensResult> {
  // (1) Inputs first — a refusal that needs no database costs no round trip. Same
  // refusals the RPC would give, in the same words, under the same reasons.
  const normalized = normalizeEdgeDays(edgeDays);
  if (!normalized.ok) return { ok: false, reason: normalized.reason, message: normalized.message };

  try {
    const supabase = await createClient();

    // (2) A signed-in user, the way the other non-price reads in this file require one.
    // NOTE this is NOT a price gate and must not become one.
    const { data: { user }, error: authError } = await supabase.auth.getUser();
    if (authError || !user) {
      return {
        ok: false,
        reason: 'not_signed_in',
        message: 'Your session has expired — reload the page and sign in again.',
      };
    }

    const { data, error } = await supabase.rpc('fn_blocking_age_lens', {
      p_edge_days: normalized.edges,
    });

    if (error) {
      console.error('[Blocking] fn_blocking_age_lens error:', error);
      return { ok: false, reason: 'rpc_error', message: error.message || AGE_LENS_UNREACHABLE_MESSAGE };
    }

    const res = data as AgeLensEnvelope;
    if (!res?.ok) {
      const reason = res?.reason;
      return {
        ok: false,
        // The RPC's own vocabulary, passed through; anything unrecognized is reported as
        // an rpc_error rather than silently widening the union.
        reason:
          reason === 'invalid_edge' || reason === 'no_edges' || reason === 'too_many_edges'
            ? reason
            : 'rpc_error',
        message: res?.message ?? 'The age lens could not be worked out.',
      };
    }

    const bands: BlockingAgeBand[] = (res.bands ?? []).map((b) => ({
      index: lensNum(b.index),
      // lowerDays is 0 on the first band and never null — age has a floor.
      lowerDays: lensNum(b.lower_days),
      // null = OPEN ABOVE. lensNumOrNull, never `?? 0` — a 0 here would read as
      // "this band ends at day zero".
      upperDays: lensNumOrNull(b.upper_days),
      blockCount: lensNum(b.block_count),
      kg: lensNum(b.kg),
      kgSharePct: lensNumOrNull(b.kg_share_pct),
      blockSharePct: lensNumOrNull(b.block_share_pct),
      // Null on an empty band. "No charcoal of this age" is not "0 days old".
      kgWeightedAgeDays: lensNumOrNull(b.kg_weighted_age_days),
    }));

    // RE-KEY, not aggregate: the grid needs per-cell lookups, and SQL already decided
    // which band every block is in and how old it is. Undated blocks are absent from
    // `blocks[]` by construction, so they are absent from both maps — the contract.
    const bandByBlock: Record<string, number> = {};
    const ageByBlock: Record<string, number> = {};
    for (const b of res.blocks ?? []) {
      const loc = b.block_loc;
      if (typeof loc !== 'string' || loc.length === 0) continue;
      bandByBlock[loc] = lensNum(b.band_index);
      ageByBlock[loc] = lensNum(b.age_days);
    }

    const lens: BlockingAgeLens = {
      asOf: String(res.as_of ?? ''),
      edgeDays: Array.isArray(res.edge_days) ? res.edge_days.map((e) => Number(e)) : normalized.edges,
      bands,
      bandByBlock,
      ageByBlock,
      undated: { blockCount: lensNum(res.undated?.block_count), kg: lensNum(res.undated?.kg) },
      total: {
        blockCount: lensNum(res.total?.block_count),
        kg: lensNum(res.total?.kg),
        // All three stay NULL-preserving: an all-undated yard has no age at all.
        kgWeightedAgeDays: lensNumOrNull(res.total?.kg_weighted_age_days),
        oldestAgeDays: lensNumOrNull(res.total?.oldest_age_days),
        oldestBlockLoc: res.total?.oldest_block_loc ?? null,
      },
    };

    return { ok: true, lens };
  } catch (err: unknown) {
    console.error('[Blocking] fetchBlockingAgeLens failed:', err);
    return { ok: false, reason: 'exception', message: AGE_LENS_UNREACHABLE_MESSAGE };
  }
}

// ─── Supplier lens — DATA LAYER ────────────────────────────────────────────────
//
// "Whose charcoal is in my yard." The THIRD lens on the frame the price lens built, over
// `fn_blocking_supplier_lens` (migration `20260922011759_blocking_supplier_lens`). It is
// the AGE lens's sibling in posture, not the price lens's:
//
//   ***  THERE IS NO PRICE GATE HERE, AND THAT IS DELIBERATE. DO NOT ADD ONE.  ***
//
//      Nothing in this payload is money and nothing in it is derivable back into money:
//      the RPC publishes supplier names, kilograms, counts and percentages, `cost_basis`
//      is never read and `avg_php_kg` is never selected. A supplier's name beside a
//      kilogram total says nothing about what it cost. So the Supplier lens is visible to
//      EVERY role INCLUDING Production — the same posture as
//      `view_blocking_block_suppliers` (which this lens reads) and
//      `fn_blocking_age_lens`. The PRICE lens must REFUSE a `!canViewPrices()` caller
//      because band membership pins a block's ₱/kg to within a peso; that argument has no
//      analogue here. `scripts/verify-blocking-supplier-lens.ts` asserts that this
//      function contains NO `canViewPrices` call, so the asymmetry cannot be "tidied up"
//      by accident.
//
// What it DOES require is a signed-in user, exactly as `fetchBlockingAgeLens` does.
//
// Three rules it shares with its siblings.
//
//   1. NOTHING IS COMPUTED HERE. The apportionment, the dominance, the bands and both
//      share families are arithmetic over the yard, so all of it lives in SQL
//      (CLAUDE.md: never aggregate in TypeScript). This function validates its input,
//      camelCases the rows, and folds `blocks[]` into the two per-cell lookups the grid
//      needs. That fold is a RE-KEYING, not an aggregation.
//
//   2. A BUSINESS REFUSAL IS DATA, NEVER A THROW. The RPC returns
//      `{ok:false, reason, message}` written for a human; this action passes the message
//      straight through so the UI can hand it to `errorToast()`.
//
//   3. NULL IS PRESERVED. A band's share percentages are null — never 0 — when nothing in
//      the yard has a supplier at all. But `dominantKg` and `dominantBlockCount` are
//      REAL ZEROES on a supplier that dominates no block (MERCADO today), so they are not
//      null-preserving: "dominates nothing" is a measurement, not a missing value.
//
// Read-only: no writes, no audit logs, no `revalidatePath()`.

const SUPPLIER_LENS_UNREACHABLE_MESSAGE =
  'Could not reach the database to work out the supplier lens. Nothing changed — try again.';
const SUPPLIER_LENS_TOP_N_MESSAGE =
  `Choose how many suppliers to show by name — a whole number between ${BLOCKING_SUPPLIER_LENS_MIN_TOP_N} and ${BLOCKING_SUPPLIER_LENS_MAX_TOP_N}. Everyone else is grouped as Others.`;

/** The `{ok, ...}` envelope `fn_blocking_supplier_lens` returns. */
type SupplierLensEnvelope = {
  ok?: boolean;
  reason?: string;
  message?: string;
  top_n?: number | null;
  bands?: Array<Record<string, unknown>> | null;
  blocks?: Array<Record<string, unknown>> | null;
  unattributed?: { block_count?: number | null; kg?: number | string | null } | null;
  total?: {
    block_count?: number | null;
    kg?: number | string | null;
    supplier_count?: number | null;
    mixed_block_count?: number | null;
    attributed_block_count?: number | null;
    attributed_kg?: number | string | null;
  } | null;
} | null;

/**
 * Classify every occupied block by WHOSE charcoal is in it — the supplier lens itself.
 *
 * `topN` is how many suppliers are named before the single `others` fold: a whole number
 * in 1…12, default 6. INTEGRALITY is enforced here rather than in SQL because `p_top_n` is
 * declared `int`, so Postgres has already rounded `6.5` to `7` by the time the function
 * body runs and that refusal is structurally unreachable there — the same deliberate
 * asymmetry the price and age lenses record, reusing the SQL's own `invalid_top_n` reason
 * rather than inventing a second vocabulary.
 *
 * NEITHER SUPPLIER IDENTITY NOR DOMINANCE IS DEFINED HERE. Identity and the ALL/SOME rule
 * come from `view_blocking_block_suppliers` inside the RPC; the dominant supplier uses
 * `fn_blend_block_facts`' own tie rule and is proven equal to it every verify run.
 *
 * **The two kilogram families are NOT interchangeable** — tint a cell from
 * `bandByBlock`, size a ratio bar from `bands[].apportionedKg`, and count blocks from
 * `bands[].dominantBlockCount`. See the `BlockingSupplierBand` doc comment.
 *
 * A block whose batch has NO delivery is ABSENT from both maps and counted in
 * `lens.unattributed` — render it un-lensed, and never fold it into `others`.
 *
 * NOT price-gated, on purpose — see the block comment above. Every role, Production
 * included, may read this.
 */
export async function fetchBlockingSupplierLens(
  topN: number = BLOCKING_SUPPLIER_LENS_DEFAULT_TOP_N,
): Promise<BlockingSupplierLensResult> {
  // (1) Inputs first — a refusal that needs no database costs no round trip. Same refusal
  // the RPC would give, under the same reason.
  if (
    typeof topN !== 'number' ||
    !Number.isFinite(topN) ||
    !Number.isInteger(topN) ||
    topN < BLOCKING_SUPPLIER_LENS_MIN_TOP_N ||
    topN > BLOCKING_SUPPLIER_LENS_MAX_TOP_N
  ) {
    return { ok: false, reason: 'invalid_top_n', message: SUPPLIER_LENS_TOP_N_MESSAGE };
  }

  try {
    const supabase = await createClient();

    // (2) A signed-in user, the way the other non-price reads in this file require one.
    // NOTE this is NOT a price gate and must not become one.
    const { data: { user }, error: authError } = await supabase.auth.getUser();
    if (authError || !user) {
      return {
        ok: false,
        reason: 'not_signed_in',
        message: 'Your session has expired — reload the page and sign in again.',
      };
    }

    const { data, error } = await supabase.rpc('fn_blocking_supplier_lens', { p_top_n: topN });

    if (error) {
      console.error('[Blocking] fn_blocking_supplier_lens error:', error);
      return { ok: false, reason: 'rpc_error', message: error.message || SUPPLIER_LENS_UNREACHABLE_MESSAGE };
    }

    const res = data as SupplierLensEnvelope;
    if (!res?.ok) {
      const reason = res?.reason;
      return {
        ok: false,
        // The RPC's own vocabulary, passed through; anything unrecognized is reported as
        // an rpc_error rather than silently widening the union.
        reason: reason === 'invalid_top_n' ? reason : 'rpc_error',
        message: res?.message ?? 'The supplier lens could not be worked out.',
      };
    }

    const bands: BlockingSupplierBand[] = (res.bands ?? []).map((b) => ({
      index: lensNum(b.index),
      // Null on the `others` band — read `isOthers`, never a null name.
      key: typeof b.key === 'string' ? b.key : null,
      display: typeof b.display === 'string' ? b.display : null,
      isOthers: b.is_others === true,
      supplierCount: lensNum(b.supplier_count),
      supplierKeys: Array.isArray(b.supplier_keys) ? b.supplier_keys.map((k) => String(k)) : null,
      // REAL ZEROES, not null-preserving: a supplier that dominates no block has measured
      // 0 dominated blocks and 0 dominated kg. That is an answer, not a gap.
      dominantBlockCount: lensNum(b.dominant_block_count),
      dominantKg: lensNum(b.dominant_kg),
      apportionedKg: lensNum(b.apportioned_kg),
      apportionedDeliveredKg: lensNum(b.apportioned_delivered_kg),
      // Null when nothing in the yard has a supplier at all — never 0 ÷ 0 read as 0%.
      kgSharePct: lensNumOrNull(b.kg_share_pct),
      blockSharePct: lensNumOrNull(b.block_share_pct),
      mixedBlockCount: lensNum(b.mixed_block_count),
    }));

    // RE-KEY, not aggregate: the grid needs per-cell lookups, and SQL already decided which
    // band every block is in. Unattributed blocks are absent from `blocks[]` by
    // construction, so they are absent from both maps — the contract.
    const bandByBlock: Record<string, number> = {};
    const blockByLoc: Record<string, BlockingSupplierBlock> = {};
    for (const b of res.blocks ?? []) {
      const loc = b.block_loc;
      if (typeof loc !== 'string' || loc.length === 0) continue;
      const suppliers: BlockingSupplierSlice[] = Array.isArray(b.suppliers)
        ? (b.suppliers as Array<Record<string, unknown>>).map((s) => ({
            key: String(s.key ?? ''),
            display: String(s.display ?? ''),
            kg: lensNum(s.kg),
            sharePct: lensNum(s.share_pct),
            balanceKg: lensNum(s.balance_kg),
          }))
        : [];
      bandByBlock[loc] = lensNum(b.band_index);
      blockByLoc[loc] = {
        blockLoc: loc,
        batchId: String(b.batch_id ?? ''),
        batchCode: String(b.batch_code ?? ''),
        bandIndex: lensNum(b.band_index),
        dominantSupplierKey: String(b.dominant_supplier_key ?? ''),
        dominantSupplierDisplay: String(b.dominant_supplier_display ?? ''),
        dominantSharePct: lensNumOrNull(b.dominant_share_pct),
        // THE ALL/SOME rule, carried through — never re-derived from suppliers.length.
        isMixed: b.is_mixed === true,
        supplierCount: lensNum(b.supplier_count),
        kg: lensNum(b.kg),
        suppliers,
      };
    }

    const lens: BlockingSupplierLens = {
      topN: lensNum(res.top_n),
      bands,
      bandByBlock,
      blockByLoc,
      unattributed: {
        blockCount: lensNum(res.unattributed?.block_count),
        kg: lensNum(res.unattributed?.kg),
      },
      total: {
        blockCount: lensNum(res.total?.block_count),
        kg: lensNum(res.total?.kg),
        supplierCount: lensNum(res.total?.supplier_count),
        mixedBlockCount: lensNum(res.total?.mixed_block_count),
        attributedBlockCount: lensNum(res.total?.attributed_block_count),
        attributedKg: lensNum(res.total?.attributed_kg),
      },
    };

    return { ok: true, lens };
  } catch (err: unknown) {
    console.error('[Blocking] fetchBlockingSupplierLens failed:', err);
    return { ok: false, reason: 'exception', message: SUPPLIER_LENS_UNREACHABLE_MESSAGE };
  }
}

// ─── Blend BLOCK FACTS — DATA LAYER ───────────────────────────────────────────
//
// The supplier picture and the two ages for the blend modal's "Selected blocks" table,
// over `fn_blend_block_facts` (migration
// `20260921034512_blend_block_facts_and_price_lens_rounded_up`). One action, two callers:
// the LIVE what-if (no `asOf`) and a SAVED version's viewer (the version's own Manila
// date), so "the whole block is one supplier" can only ever mean one thing.
//
// Five rules, four shared with the lenses above.
//
//   1. NOTHING IS COMPUTED HERE. Kilograms, shares, the dominant supplier, the green/
//      orange flag and both day counts all come out of SQL (CLAUDE.md: never aggregate in
//      TypeScript). This function validates its inputs, camelCases the rows and KEYS them
//      by `batchId`. That last step is a re-keying, not an aggregation.
//
//   2. KEYED BY `batch_id`, NEVER BY `block_loc` — a block address is reused when a pile
//      empties, so a saved version resolved by block name would describe different
//      charcoal under the same address and nothing on screen would look wrong.
//
//   3. NO PRICE GATE, AND THAT IS THE POINT. Nothing in this payload is money and none is
//      derivable from it, so every role INCLUDING Production may read it — the same
//      posture as `fetchBlockingSupplierMap` and `fetchBlockingAgeLens`, and the OPPOSITE
//      of the price lens, whose band membership alone pins a block's ₱/kg to within a
//      peso. `scripts/verify-blend-block-facts.ts` asserts the gate's ABSENCE, so the
//      asymmetry cannot be "tidied up" by accident. What it DOES require is a signed-in
//      user, like the other non-price reads in this file.
//
//   4. A BUSINESS REFUSAL IS DATA, NEVER A THROW — `{ok:false, reason, message}`, and the
//      message goes straight to `errorToast()`.
//
//   5. NULL IS PRESERVED. An undated block's dominant fields, dates and day counts are
//      null, never 0; `isSingleSupplier` is null, never false. "Nobody has delivered into
//      this pile yet" and "this pile is one supplier, 0 days old" are different answers.
//
// Read-only: no writes, no audit logs, no `revalidatePath()`.

const BLEND_FACTS_UNREACHABLE_MESSAGE =
  'Could not reach the database to work out the block details. Nothing changed — try again.';

/** A plain uuid shape check. A malformed id is a caller bug, not a missing batch. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** One row of `fn_blend_block_facts`, as PostgREST hands it over. */
type BlendBlockFactsRow = {
  batch_id: string | null;
  batch_code: string | null;
  as_of: string | null;
  supplier_count: number | null;
  dominant_supplier_key: string | null;
  dominant_supplier_display: string | null;
  dominant_share_pct: number | string | null;
  is_single_supplier: boolean | null;
  suppliers: unknown;
  first_delivery_date: string | null;
  last_delivery_date: string | null;
  days_since_opened: number | null;
  days_since_last_piled: number | null;
  delivery_count: number | null;
};

/**
 * WHO filled each of these blocks and HOW LONG AGO — as of today, or as of the day a
 * saved proposal version was written.
 *
 * `batchIds` are `batches.id` values: on the live path the grid's occupant of each ticked
 * block, and on a saved path `snapshot.blocks[].batch_id`, which
 * `fn_blend_proposal_snapshot` records for exactly this kind of resolution. Up to 250,
 * de-duplicated here. **An id that is not a batch is ABSENT from `facts`** — never
 * zero-filled.
 *
 * `asOf` omitted or null = TODAY in Asia/Manila (the live modal). A saved version passes
 * the Asia/Manila calendar date of its own `created_at` — read
 * `BlendProposalVersionSummary.createdAt` (or the snapshot's `computed_at`, which the
 * version read model also exposes as `computedAt`) and take its Manila date. Only
 * deliveries dated on or before it are considered, which is what makes the saved viewer's
 * answer a statement about the yard ON THAT DAY rather than about the yard now.
 *
 * NOT price-gated, on purpose — see the block comment above. Every role may read this.
 */
export async function fetchBlendBlockFacts(
  batchIds: readonly string[],
  asOf?: string | null,
): Promise<BlendBlockFactsResult> {
  // (1) Inputs first — a refusal that needs no database costs no round trip.
  if (!Array.isArray(batchIds)) {
    return {
      ok: false,
      reason: 'invalid_batch_id',
      message: 'Expected a list of batch ids.',
    };
  }
  for (const id of batchIds) {
    if (typeof id !== 'string' || !UUID_RE.test(id)) {
      return {
        ok: false,
        reason: 'invalid_batch_id',
        message: 'One of the blocks does not carry a usable batch id — reload the page and try again.',
      };
    }
  }

  const ids = Array.from(new Set(batchIds));
  if (ids.length === 0) {
    return {
      ok: false,
      reason: 'no_batch_ids',
      message: 'Pick at least one block first.',
    };
  }
  if (ids.length > BLEND_BLOCK_FACTS_MAX_BATCH_IDS) {
    return {
      ok: false,
      reason: 'too_many_batch_ids',
      message: `That is ${ids.length} blocks; this can describe at most ${BLEND_BLOCK_FACTS_MAX_BATCH_IDS} at a time.`,
    };
  }

  let requestedAsOf: string | null = null;
  if (asOf !== null && asOf !== undefined && asOf !== '') {
    const raw = String(asOf);
    // A real calendar date, not just four-two-two digits: `2026-02-31` round-trips to
    // 2026-03-03 through Date, and that mismatch is what catches it.
    const parsed = new Date(`${raw}T00:00:00Z`);
    const roundTrip = Number.isNaN(parsed.getTime()) ? '' : parsed.toISOString().slice(0, 10);
    if (!ISO_DATE_RE.test(raw) || roundTrip !== raw) {
      return {
        ok: false,
        reason: 'invalid_as_of',
        message: 'The as-of date has to be a real calendar date written as yyyy-mm-dd.',
      };
    }
    // THE FUTURE CHECK IS MEASURED IN ASIA/MANILA, NOT UTC — PH is UTC+8, so between
    // 16:00 and midnight UTC the Manila calendar date is already tomorrow by UTC's
    // reckoning and a UTC-based test would refuse a perfectly ordinary "today". Same
    // reasoning, same technique (`Intl`, `en-CA` so the format IS `yyyy-MM-dd`) as
    // `lib/operations/excel/workbook.ts::manilaDate`; not imported from there because
    // that module pulls in the Excel writer. `yyyy-MM-dd` compares correctly as a string.
    const manilaToday = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Manila',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date());
    if (raw > manilaToday) {
      return {
        ok: false,
        reason: 'invalid_as_of',
        message: `A blend describes charcoal that has already arrived, so it cannot be dated after today (${manilaToday}).`,
      };
    }
    requestedAsOf = raw;
  }

  try {
    const supabase = await createClient();

    // (2) A signed-in user, the way the other non-price reads in this file require one.
    // NOTE this is NOT a price gate and must not become one.
    const { data: { user }, error: authError } = await supabase.auth.getUser();
    if (authError || !user) {
      return {
        ok: false,
        reason: 'not_signed_in',
        message: 'Your session has expired — reload the page and sign in again.',
      };
    }

    const { data, error } = await supabase.rpc('fn_blend_block_facts', {
      p_batch_ids: ids,
      // An explicit null is the SQL default: "today, in Asia/Manila".
      p_as_of: requestedAsOf,
    });

    if (error) {
      console.error('[Blocking] fn_blend_block_facts error:', error);
      return { ok: false, reason: 'rpc_error', message: error.message || BLEND_FACTS_UNREACHABLE_MESSAGE };
    }

    const rows = (data ?? []) as unknown as BlendBlockFactsRow[];

    // RE-KEY, not aggregate. SQL already decided every number on every row.
    const facts: Record<string, BlendBlockFacts> = {};
    let asOfUsed: string | null = requestedAsOf;

    for (const row of rows) {
      const id = row.batch_id;
      if (typeof id !== 'string' || id.length === 0) continue;
      if (asOfUsed === null && typeof row.as_of === 'string') asOfUsed = row.as_of;

      const suppliers: BlendBlockSupplierShare[] = Array.isArray(row.suppliers)
        ? (row.suppliers as Array<Record<string, unknown>>).map((s) => ({
            key: String(s.key ?? ''),
            display: String(s.display ?? s.key ?? ''),
            kg: lensNum(s.kg),
            // NULL-preserving: 0% and "the block weighs nothing" are different answers.
            sharePct: lensNumOrNull(s.share_pct),
          }))
        : [];

      facts[id] = {
        batchId: id,
        batchCode: String(row.batch_code ?? ''),
        supplierCount: lensNum(row.supplier_count),
        dominantSupplierKey: row.dominant_supplier_key ?? null,
        dominantSupplierDisplay: row.dominant_supplier_display ?? null,
        dominantSharePct: lensNumOrNull(row.dominant_share_pct),
        // Null, never false — an undated block is neither green nor orange.
        isSingleSupplier: row.is_single_supplier ?? null,
        suppliers,
        firstDeliveryDate: row.first_delivery_date ?? null,
        lastDeliveryDate: row.last_delivery_date ?? null,
        daysSinceOpened: lensNumOrNull(row.days_since_opened),
        daysSinceLastPiled: lensNumOrNull(row.days_since_last_piled),
        deliveryCount: lensNum(row.delivery_count),
      };
    }

    return { ok: true, asOf: asOfUsed, facts };
  } catch (err: unknown) {
    console.error('[Blocking] fetchBlendBlockFacts failed:', err);
    return { ok: false, reason: 'exception', message: BLEND_FACTS_UNREACHABLE_MESSAGE };
  }
}

// ─── Blend ANALYSIS — DATA LAYER ──────────────────────────────────────────────
//
// The extra viewer / print pages for a blend proposal: the blocks GROUPED by price, by
// lab reading and by age, with footers. One action over `fn_blend_analysis` (migration
// `20260921084500_blend_analysis_natural_breaks`).
//
// FOUR RULES, and the FIRST is the one that makes this action different from every other
// price-bearing read in this file.
//
//   1. THE PRICE GATE IS A DELETION, NOT A REFUSAL — and not a nulling pass either.
//      `fetchBlockingPriceLens` REFUSES a `!canViewPrices()` caller outright, because a
//      price lens is price all the way through: even a band's block count describes the
//      yard's price distribution. This payload is not like that. It SPLITS: `price` is
//      money (group ₱/kg, band edges, Σ kg·₱, and band membership itself), while
//      `quality` and `age` are readings, kilograms, day counts and shares with no money
//      key and nothing derivable into one. So the whole `price` SECTION IS DELETED —
//      set to `null`, with `pricesHidden: true` — BEFORE the payload leaves the server,
//      and Production still gets the quality and age pages. Deleting the section rather
//      than nulling fields inside it is what makes the gate total: there is no
//      `bands[].blockCount` left to read a distribution off.
//
//   2. NOTHING IS COMPUTED HERE. The groups, the cut lines, the goodness-of-fit, every
//      share and every weighted average come out of SQL (CLAUDE.md: never aggregate in
//      TypeScript). This function validates its inputs and camelCases the payload.
//
//   3. A BUSINESS REFUSAL IS DATA, NEVER A THROW — `{ok:false, reason, message}`, and the
//      message goes straight to `errorToast()`.
//
//   4. NULL IS PRESERVED EVERYWHERE. `gvf` on a single-valued blend, an empty group's
//      weighted average, a share when nothing is measured, an undated block's age: all
//      null, never 0. "There is nothing of this kind" and "there is something and it
//      measures zero" are different answers, and the ₱ column is where confusing them is
//      expensive.
//
// Read-only: no writes, no audit logs, no `revalidatePath()`.

const BLEND_ANALYSIS_UNREACHABLE_MESSAGE =
  'Could not reach the database to work out the blend analysis. Nothing changed — try again.';
const BLEND_ANALYSIS_PRICE_EDGE_MESSAGE =
  'Every band edge has to be a whole number of pesos away from market.';
const BLEND_ANALYSIS_AGE_EDGE_MESSAGE = `Every cut line has to be a whole number of days between ${BLOCKING_AGE_EDGE_MIN_DAYS} and ${BLOCKING_AGE_EDGE_MAX_DAYS.toLocaleString('en-US')}.`;

/** The `{ok, ...}` envelope `fn_blend_analysis` returns. Typed loosely on purpose: every
 *  figure is mapped through `lensNum` / `lensNumOrNull` below so a NULL the function
 *  deliberately returns cannot be coerced by an optimistic generated type. */
type BlendAnalysisEnvelope = {
  ok?: boolean;
  reason?: string;
  message?: string;
  source?: string;
  as_of?: string | null;
  proposal_id?: string | null;
  version_no?: number | null;
  title?: string | null;
  snapshot_computed_at?: string | null;
  computed_at?: string | null;
  block_count?: number | null;
  total_kg?: number | string | null;
  sections?: {
    price?: Record<string, unknown> | null;
    quality?: Record<string, unknown> | null;
    age?: Record<string, unknown> | null;
  } | null;
} | null;

type Row = Record<string, unknown>;

const asRows = (v: unknown): Row[] => (Array.isArray(v) ? (v as Row[]) : []);
const asRow = (v: unknown): Row => (v && typeof v === 'object' ? (v as Row) : {});
const asStr = (v: unknown): string => (typeof v === 'string' ? v : '');
const asStrOrNull = (v: unknown): string | null => (typeof v === 'string' ? v : null);

/** The identity half of every block row. A RE-KEY, never a computation. */
function mapBlockRef(b: Row): BlendAnalysisBlockRef {
  return {
    batchId: asStrOrNull(b.batch_id),
    blockLoc: asStr(b.block_loc),
    batchCode: asStr(b.batch_code),
    kg: lensNum(b.kg),
  };
}

function mapCuts(v: unknown): BlendNaturalCut[] {
  return asRows(v).map((c) => ({
    index: lensNum(c.index),
    below: lensNum(c.below),
    above: lensNum(c.above),
    value: lensNum(c.value),
  }));
}

function mapStats(v: unknown): BlendNaturalStats {
  const s = asRow(v);
  return {
    n: lensNum(s.n),
    distinctCount: lensNum(s.distinct_count),
    totalWeight: lensNum(s.total_weight),
    // All four of these are NULL on a blend with nothing measurable.
    weightedMean: lensNumOrNull(s.weighted_mean),
    totalSs: lensNumOrNull(s.total_ss),
    withinSs: lensNumOrNull(s.within_ss),
    betweenSs: lensNumOrNull(s.between_ss),
    candidatesConsidered: lensNum(s.candidates_considered),
  };
}

function mapUnmeasured(v: unknown): BlendAnalysisUnmeasured {
  const u = asRow(v);
  return {
    blockCount: lensNum(u.block_count),
    kg: lensNum(u.kg),
    noValueCount: lensNum(u.no_value_count),
    noWeightCount: lensNum(u.no_weight_count),
    blocks: asRows(u.blocks).map(mapBlockRef),
  };
}

/** The label vocabulary is CLOSED in SQL; anything else is a contract break, so it falls
 *  back to the neutral `mid` rather than widening the union at runtime. */
function mapLabel(v: unknown): BlendNaturalGroupLabel {
  return v === 'low' || v === 'mid' || v === 'high' ? v : 'mid';
}

function mapPriceNatural(v: unknown): BlendPriceNatural {
  const n = asRow(v);
  const o = asRow(n.overall);
  const groups: BlendPriceNaturalGroup[] = asRows(n.groups).map((g) => ({
    index: lensNum(g.index),
    label: mapLabel(g.label),
    rangeMin: lensNum(g.range_min),
    rangeMax: lensNum(g.range_max),
    blockCount: lensNum(g.block_count),
    kg: lensNum(g.kg),
    kgSharePct: lensNumOrNull(g.kg_share_pct),
    blockSharePct: lensNumOrNull(g.block_share_pct),
    // Null on an empty group. "No charcoal here" is not "₱0 here".
    kgWeightedPhpKg: lensNumOrNull(g.kg_weighted_php_kg),
    valuePhp: lensNum(g.value_php),
    blocks: asRows(g.blocks).map((b): BlendPriceBlock => ({ ...mapBlockRef(b), phpKg: lensNum(b.php_kg) })),
  }));
  return {
    metric: 'php_kg',
    groupCount: lensNum(n.group_count),
    gvf: lensNumOrNull(n.gvf),
    cuts: mapCuts(n.cuts),
    stats: mapStats(n.stats),
    groups,
    unmeasured: mapUnmeasured(n.unmeasured),
    overall: {
      blockCount: lensNum(o.block_count),
      kg: lensNum(o.kg),
      kgWeightedPhpKg: lensNumOrNull(o.kg_weighted_php_kg),
      valuePhp: lensNum(o.value_php),
      snapshotPhpKg: lensNumOrNull(o.snapshot_php_kg),
      snapshotGap: lensNumOrNull(o.snapshot_gap),
      // Tri-state on purpose: null means "cannot say", not "no".
      equalsSnapshot: typeof o.equals_snapshot === 'boolean' ? o.equals_snapshot : null,
    },
  };
}

function mapVsMarket(v: unknown): BlendVsMarket | null {
  if (!v || typeof v !== 'object') return null;
  const m = asRow(v);
  const o = asRow(m.overall);
  const u = asRow(m.unmeasured);
  const bands: BlendVsMarketBand[] = asRows(m.bands).map((b) => ({
    index: lensNum(b.index),
    // null = OPEN. lensNumOrNull, never `?? 0` — a zero bound would be a real ₱0 edge.
    lowerPhp: lensNumOrNull(b.lower_php),
    upperPhp: lensNumOrNull(b.upper_php),
    blockCount: lensNum(b.block_count),
    kg: lensNum(b.kg),
    kgSharePct: lensNumOrNull(b.kg_share_pct),
    blockSharePct: lensNumOrNull(b.block_share_pct),
    kgWeightedPhpKg: lensNumOrNull(b.kg_weighted_php_kg),
    valuePhp: lensNum(b.value_php),
    blocks: asRows(b.blocks).map((x): BlendPriceBlock => ({ ...mapBlockRef(x), phpKg: lensNum(x.php_kg) })),
  }));
  return {
    marketPhpKg: lensNum(m.market_php_kg),
    marketBasis: m.market_basis === 'given' ? 'given' : 'as_of_month',
    marketBasisMonth: asStrOrNull(m.market_basis_month),
    roundedUpPhp: lensNum(m.rounded_up_php),
    edgeOffsets: Array.isArray(m.edge_offsets) ? m.edge_offsets.map((e) => Number(e)) : [],
    bands,
    unmeasured: {
      blockCount: lensNum(u.block_count),
      kg: lensNum(u.kg),
      blocks: asRows(u.blocks).map(mapBlockRef),
    },
    overall: {
      blockCount: lensNum(o.block_count),
      kg: lensNum(o.kg),
      kgWeightedPhpKg: lensNumOrNull(o.kg_weighted_php_kg),
      valuePhp: lensNum(o.value_php),
    },
  };
}

function mapVsMarketUnavailable(v: unknown): BlendVsMarketUnavailable | null {
  if (!v || typeof v !== 'object') return null;
  const x = asRow(v);
  return {
    reason: 'no_market_price',
    message: asStr(x.message),
    marketBasis: x.market_basis === 'given' ? 'given' : 'as_of_month',
    marketBasisMonth: asStrOrNull(x.market_basis_month),
  };
}

function mapQualityNatural(metric: BlendQualityMetric, v: unknown): BlendQualityNatural {
  const n = asRow(v);
  const o = asRow(n.overall);
  const groups: BlendQualityGroup[] = asRows(n.groups).map((g) => ({
    index: lensNum(g.index),
    label: mapLabel(g.label),
    rangeMin: lensNum(g.range_min),
    rangeMax: lensNum(g.range_max),
    blockCount: lensNum(g.block_count),
    kg: lensNum(g.kg),
    kgSharePct: lensNumOrNull(g.kg_share_pct),
    blockSharePct: lensNumOrNull(g.block_share_pct),
    kgWeightedValue: lensNumOrNull(g.kg_weighted_value),
    blocks: asRows(g.blocks).map((b): BlendQualityBlock => ({ ...mapBlockRef(b), value: lensNum(b.value) })),
  }));
  return {
    metric,
    groupCount: lensNum(n.group_count),
    gvf: lensNumOrNull(n.gvf),
    cuts: mapCuts(n.cuts),
    stats: mapStats(n.stats),
    groups,
    unmeasured: mapUnmeasured(n.unmeasured),
    overall: {
      blockCount: lensNum(o.block_count),
      kg: lensNum(o.kg),
      kgWeightedValue: lensNumOrNull(o.kg_weighted_value),
      snapshotValue: lensNumOrNull(o.snapshot_value),
      snapshotGap: lensNumOrNull(o.snapshot_gap),
      equalsSnapshot: typeof o.equals_snapshot === 'boolean' ? o.equals_snapshot : null,
    },
  };
}

function mapAgeSection(v: unknown): BlendAnalysisAgeSection {
  const a = asRow(v);
  const o = asRow(a.overall);
  const u = asRow(a.undated);
  const bands: BlendAgeBand[] = asRows(a.bands).map((b) => ({
    index: lensNum(b.index),
    // lowerDays is 0 on the first band and never null — age has a floor.
    lowerDays: lensNum(b.lower_days),
    // null = OPEN ABOVE. A 0 here would read as "this band ends at day zero".
    upperDays: lensNumOrNull(b.upper_days),
    blockCount: lensNum(b.block_count),
    kg: lensNum(b.kg),
    kgSharePct: lensNumOrNull(b.kg_share_pct),
    blockSharePct: lensNumOrNull(b.block_share_pct),
    kgWeightedAgeDays: lensNumOrNull(b.kg_weighted_age_days),
    blocks: asRows(b.blocks).map((x): BlendAgeBlock => ({
      ...mapBlockRef(x),
      ageDays: lensNum(x.age_days),
      firstDeliveryDate: asStrOrNull(x.first_delivery_date),
      lastDeliveryDate: asStrOrNull(x.last_delivery_date),
      deliveryCount: lensNum(x.delivery_count),
    })),
  }));
  return {
    asOf: asStr(a.as_of),
    edgeDays: Array.isArray(a.edge_days) ? a.edge_days.map((e) => Number(e)) : [],
    bands,
    undated: {
      blockCount: lensNum(u.block_count),
      kg: lensNum(u.kg),
      blocks: asRows(u.blocks).map(mapBlockRef),
    },
    overall: {
      blockCount: lensNum(o.block_count),
      kg: lensNum(o.kg),
      kgWeightedAgeDays: lensNumOrNull(o.kg_weighted_age_days),
      oldestAgeDays: lensNumOrNull(o.oldest_age_days),
      oldestBlockLoc: asStrOrNull(o.oldest_block_loc),
      oldestBatchCode: asStrOrNull(o.oldest_batch_code),
    },
  };
}

/**
 * NORMALIZE AN EDGE LIST THE WAY SQL DOES and refuse what it would refuse, so the two can
 * never disagree. The one check that MUST happen here is INTEGRALITY: both SQL parameters
 * are `int[]`, so Postgres has already rounded `1.5` to `2` by the time the function body
 * runs and that refusal is structurally unreachable there. De-duplicating BEFORE the cap
 * is what keeps the two caps identical — SQL measures the cap on the collapsed list.
 */
function normalizeAnalysisEdges(
  input: readonly number[] | null | undefined,
  fallback: readonly number[],
  kind: 'price' | 'age',
):
  | { ok: true; edges: number[] }
  | { ok: false; reason: BlendAnalysisRefusalReason; message: string } {
  const isPrice = kind === 'price';
  const badEdge = {
    ok: false as const,
    reason: (isPrice ? 'invalid_price_edge' : 'invalid_age_edge') as BlendAnalysisRefusalReason,
    message: isPrice ? BLEND_ANALYSIS_PRICE_EDGE_MESSAGE : BLEND_ANALYSIS_AGE_EDGE_MESSAGE,
  };

  const raw = input === null || input === undefined ? [...fallback] : input;
  if (!Array.isArray(raw)) return badEdge;

  for (const e of raw) {
    if (typeof e !== 'number' || !Number.isFinite(e) || !Number.isInteger(e)) return badEdge;
    // Age cut lines additionally have a range; price offsets legitimately go negative.
    if (!isPrice && (e < BLOCKING_AGE_EDGE_MIN_DAYS || e > BLOCKING_AGE_EDGE_MAX_DAYS)) return badEdge;
  }

  const edges = Array.from(new Set(raw)).sort((a, b) => a - b);

  if (edges.length === 0) {
    return {
      ok: false,
      reason: isPrice ? 'no_price_edges' : 'no_age_edges',
      message: isPrice
        ? 'A price lens needs at least one band edge — with none, every block is in the same band and nothing is highlighted.'
        : 'An age lens needs at least one cut line — with none, every block is in the same band and nothing is highlighted.',
    };
  }
  const cap = isPrice ? BLOCKING_PRICE_LENS_MAX_EDGES : BLOCKING_AGE_LENS_MAX_EDGES;
  if (edges.length > cap) {
    return {
      ok: false,
      reason: isPrice ? 'too_many_price_edges' : 'too_many_age_edges',
      message: isPrice
        ? `A price lens takes at most ${cap} band edges; this one has ${edges.length}.`
        : `An age lens takes at most ${cap} cut lines; this one has ${edges.length}.`,
    };
  }
  return { ok: true, edges };
}

/**
 * The blend ANALYSIS: this blend's blocks grouped by PRICE (weighted natural breaks, plus
 * the price lens's market comparison), by LAB READING (mc / ash / BD ASTM / BD JIS) and by
 * AGE, each with a footer that totals and weights.
 *
 * EXACTLY ONE SOURCE. `proposalId` (+ optional `versionNo`, default the proposal's current
 * version) reads the STORED snapshot verbatim — a proposal is a statement about the yard
 * on a particular day, and its snapshot is immutable and hashed. `blockLocs` computes the
 * same thing live from `fn_blend_proposal_snapshot`, the ONE existing builder. Giving both
 * is `both_sources`; giving neither (or a `versionNo` on its own) is `no_source`.
 *
 * `asOf` is decided by the DATABASE — the saved version's own Manila date, or today — and
 * it narrows the AGE section only, so a delivery that lands after a proposal was saved can
 * never repaint it.
 *
 * PRICE GATING IS A DELETION: a `!canViewPrices()` caller gets `price: null` and
 * `pricesHidden: true`, and still gets `quality` and `age`. See the block comment above
 * for why that is different from the price lens's outright refusal.
 */
export async function fetchBlendAnalysis(
  input: BlendAnalysisInput = {},
): Promise<BlendAnalysisResult> {
  // (1) SOURCE. Exactly one, decided before anything else touches the database.
  const hasProposal = input.proposalId !== null && input.proposalId !== undefined && input.proposalId !== '';
  const hasLocs = input.blockLocs !== null && input.blockLocs !== undefined;

  if (hasProposal && hasLocs) {
    return {
      ok: false,
      reason: 'both_sources',
      message: 'Analyse either a saved proposal version or a live list of blocks — not both at once.',
    };
  }
  if (!hasProposal && !hasLocs) {
    return {
      ok: false,
      reason: 'no_source',
      message:
        input.versionNo !== null && input.versionNo !== undefined
          ? 'A version number needs a proposal to belong to. Give the proposal as well, or give a list of blocks.'
          : 'Nothing to analyse yet — give a saved proposal, or a list of blocks.',
    };
  }

  let proposalId: string | null = null;
  let versionNo: number | null = null;
  let blockLocs: string[] | null = null;

  if (hasProposal) {
    const id = String(input.proposalId);
    if (!UUID_RE.test(id)) {
      return {
        ok: false,
        reason: 'invalid_proposal_id',
        message: 'That proposal reference is not usable — reopen the proposals list and try again.',
      };
    }
    proposalId = id;

    if (input.versionNo !== null && input.versionNo !== undefined) {
      const v = Number(input.versionNo);
      if (!Number.isFinite(v) || !Number.isInteger(v) || v < 1) {
        return {
          ok: false,
          reason: 'invalid_version_no',
          message: 'A version number has to be a whole number of at least 1.',
        };
      }
      versionNo = v;
    }
  } else {
    const raw = input.blockLocs ?? [];
    if (!Array.isArray(raw)) {
      return { ok: false, reason: 'no_blocks', message: 'Pick at least one block first.' };
    }
    // Trimmed, blanks dropped, de-duplicated — exactly what SQL does, so the cap and the
    // "no blocks" test are measured on the same list on both sides.
    const locs = Array.from(
      new Set(raw.map((l) => (typeof l === 'string' ? l.trim() : '')).filter((l) => l.length > 0)),
    );
    if (locs.length === 0) {
      return { ok: false, reason: 'no_blocks', message: 'Pick at least one block first.' };
    }
    if (locs.length > BLEND_ANALYSIS_MAX_BLOCKS) {
      return {
        ok: false,
        reason: 'too_many_blocks',
        message: `That is ${locs.length} blocks; an analysis covers at most ${BLEND_ANALYSIS_MAX_BLOCKS} at a time.`,
      };
    }
    blockLocs = locs;
  }

  // (2) The two edge lists, then the optional typed cut line and market price.
  const priceEdges = normalizeAnalysisEdges(
    input.priceEdgeOffsets,
    BLEND_ANALYSIS_DEFAULT_PRICE_EDGES,
    'price',
  );
  if (!priceEdges.ok) return { ok: false, reason: priceEdges.reason, message: priceEdges.message };

  const ageEdges = normalizeAnalysisEdges(input.ageEdgeDays, BLEND_ANALYSIS_DEFAULT_AGE_EDGES, 'age');
  if (!ageEdges.ok) return { ok: false, reason: ageEdges.reason, message: ageEdges.message };

  let roundedUpPhp: number | null = null;
  if (input.roundedUpPhp !== null && input.roundedUpPhp !== undefined) {
    const r = Number(input.roundedUpPhp);
    // Integrality is checked HERE because it cannot be checked in SQL: the parameter is
    // `int`, so Postgres has already rounded 40.5 to 41 by the time the body runs.
    if (
      !Number.isFinite(r) ||
      !Number.isInteger(r) ||
      r < BLOCKING_ROUNDED_UP_MIN_PHP ||
      r > BLOCKING_ROUNDED_UP_MAX_PHP
    ) {
      return {
        ok: false,
        reason: 'invalid_rounded_up',
        message: `The price you type has to be a whole number of pesos, at least ₱${BLOCKING_ROUNDED_UP_MIN_PHP}.`,
      };
    }
    roundedUpPhp = r;
  }

  let marketPhpKg: number | null = null;
  if (input.marketPhpKg !== null && input.marketPhpKg !== undefined) {
    const m = Number(input.marketPhpKg);
    if (!Number.isFinite(m) || m <= 0) {
      return {
        ok: false,
        reason: 'invalid_market_price',
        message:
          'The market price has to be a real amount above zero — a price of zero would put every block above market.',
      };
    }
    marketPhpKg = m;
  }

  try {
    const supabase = await createClient();

    // (3) A signed-in user, the way the other reads in this file require one. The PRICE
    // gate is separate and comes below; this is not it.
    const { data: { user }, error: authError } = await supabase.auth.getUser();
    if (authError || !user) {
      return {
        ok: false,
        reason: 'not_signed_in',
        message: 'Your session has expired — reload the page and sign in again.',
      };
    }

    const { data, error } = await supabase.rpc('fn_blend_analysis', {
      p_proposal_id: proposalId,
      p_version_no: versionNo,
      p_block_locs: blockLocs,
      p_price_edge_offsets: priceEdges.edges,
      p_age_edge_days: ageEdges.edges,
      p_market_php_kg: marketPhpKg,
      p_rounded_up_php: roundedUpPhp,
    });

    if (error) {
      console.error('[Blocking] fn_blend_analysis error:', error);
      return { ok: false, reason: 'rpc_error', message: error.message || BLEND_ANALYSIS_UNREACHABLE_MESSAGE };
    }

    const res = data as BlendAnalysisEnvelope;
    if (!res?.ok) {
      const reason = res?.reason;
      const known: readonly string[] = [
        'both_sources',
        'no_source',
        'unknown_proposal',
        'unknown_version',
        'no_blocks',
        'too_many_blocks',
        'unknown_block_loc',
        'invalid_price_edge',
        'no_price_edges',
        'too_many_price_edges',
        'invalid_age_edge',
        'no_age_edges',
        'too_many_age_edges',
        'invalid_rounded_up',
        'invalid_market_price',
      ];
      return {
        ok: false,
        // The RPC's own vocabulary, passed through; anything unrecognized is reported as
        // an rpc_error rather than silently widening the union.
        reason: (typeof reason === 'string' && known.includes(reason)
          ? reason
          : 'rpc_error') as BlendAnalysisRefusalReason,
        message: res?.message ?? 'The blend analysis could not be worked out.',
      };
    }

    // (4) THE PRICE GATE. Fails closed on any error, and it is a DELETION of the whole
    // section — see rule 1 in the block comment above.
    let canView = false;
    try {
      canView = await canViewPricesGate();
    } catch {
      canView = false;
    }

    const sections = res.sections ?? {};

    const price: BlendAnalysisPriceSection | null = canView
      ? {
          natural: mapPriceNatural(asRow(sections.price).natural),
          vsMarket: mapVsMarket(asRow(sections.price).vs_market),
          vsMarketUnavailable: mapVsMarketUnavailable(asRow(sections.price).vs_market_unavailable),
        }
      : null;

    const qualityRaw = asRow(sections.quality);
    const byMetric = {} as Record<BlendQualityMetric, BlendQualityNatural>;
    for (const m of BLEND_ANALYSIS_QUALITY_METRICS) {
      byMetric[m] = mapQualityNatural(m, qualityRaw[m]);
    }
    const quality: BlendAnalysisQualitySection = {
      metrics: [...BLEND_ANALYSIS_QUALITY_METRICS],
      byMetric,
    };

    const analysis: BlendAnalysis = {
      source: res.source === 'live' ? 'live' : 'saved',
      asOf: asStr(res.as_of),
      proposalId: asStrOrNull(res.proposal_id),
      versionNo: lensNumOrNull(res.version_no),
      title: asStrOrNull(res.title),
      snapshotComputedAt: asStrOrNull(res.snapshot_computed_at),
      computedAt: asStr(res.computed_at),
      blockCount: lensNum(res.block_count),
      totalKg: lensNum(res.total_kg),
      price,
      pricesHidden: !canView,
      quality,
      age: mapAgeSection(sections.age),
    };

    return { ok: true, analysis };
  } catch (err: unknown) {
    console.error('[Blocking] fetchBlendAnalysis failed:', err);
    return { ok: false, reason: 'exception', message: BLEND_ANALYSIS_UNREACHABLE_MESSAGE };
  }
}
