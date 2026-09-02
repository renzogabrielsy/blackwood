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
