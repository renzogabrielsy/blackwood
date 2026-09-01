// =====================================================================
// ICTC Owner Analytics — server-only query layer (the ADAPTER)
// =====================================================================
// Shapes rows from the three `view_analytics_*` views (+ the LIVE blocking
// grid) into the `AnalyticsData` contract. Same port/adapter discipline as
// `lib/digest/queries.ts`: one server-side function, one normalized
// payload, and the page's components never see Supabase.
//
// HARD RULE (CLAUDE.md): aggregation lives in SQL. This module performs
// ONLY mapping, the ₱ gate, and two deliberate NULLINGS documented below.
//
// ── THE PRICE GATE — a security boundary, not a display choice ────────
// `canViewPrices()` (the ONE helper, `lib/auth.ts`, which respects the
// impersonation cookie) decides whether a ₱ field crosses the wire. The
// complete list, taken from the two migrations' own COMMENTs:
//     view_analytics_rcin_monthly    → market_avg_price, market_php_total
//     view_analytics_inventory_eom   → ending_value_php, avg_unit_cost_php_kg
//     view_analytics_cost_monthly    → delivered_php_kg_fed,
//         delivered_php_kg_fed_covered, fed_value_php, php_per_produced_kg,
//         php_per_produced_kg_covered, closed_blocks_true_php_kg,
//         closed_blocks_delivered_php_kg, closed_blocks_uplift_php_kg
//     view_analytics_batch_cost      → delivered_php_kg_fed, fed_value_php,
//         delivered_php_kg, actual_fed_php_kg,
//         campaign_weighted_actual_fed_php_kg, uplift_php_kg,
//         php_per_produced_kg_delivered, php_per_produced_kg_true
//     view_analytics_aging_watchlist → delivered_php_kg, value_php
//     view_analytics_supplier_monthly→ avg_price_php_kg, php_total,
//         premium_php_kg, month_avg_price_php_kg
// They are nulled HERE, before the payload leaves the server — never
// hidden client-side, because the network response is the leak.
// `view_analytics_flow_monthly` and `view_analytics_aging_eom` carry no ₱
// and none is derivable from either, so aging stays visible for every role
// including Production.
//
// ── THE HONEST NULLINGS (three streams, one rule) ─────────────────────
// Deliveries begin 2020-07; `rc_out` begins 2024-01; `production_runs`
// begins 2025-11. A view that zero-fills a month before its stream existed
// is publishing a STRUCTURAL zero — the plant was fed, nobody wrote it
// down — and a zero would roll into a quarter and a year as if nothing had
// happened, which no downstream rollup could tell from a real quiet month.
// So:
//   • `outflow_recorded = false` → NULL `outKg`, `netKg`,
//     `outPerWorkingDay`, `runwayDays`, and EVERY `view_analytics_cost_monthly`
//     figure (feeding is the denominator of all of them);
//   • `produced_kg = 0`         → NULL `producedKg`, `yieldPct`,
//     `processLossKg` and both ₱-per-produced figures. This is the P2
//     addition, and it is the same argument one stream later: 24 months
//     publish `yield_pct = 0` because production was not being reported,
//     not because 8,000 tonnes of charcoal became nothing.
// Both flags ride along so the UI can say WHY a cell is blank.
// =====================================================================

import "server-only";
import { createClient } from "@/lib/supabase/server";
import { canViewPrices } from "@/lib/auth";
import type {
  AgingWatchItem,
  AgingWatchlist,
  AnalyticsData,
  AnalyticsMonth,
  BlockUtilization,
  CampaignCost,
  SupplierData,
  SupplierMonth,
} from "./types";

/** The operator's mental baseline — warehouses A/B/C/D only (PCA/PCB are opt-in). */
const STANDARD_BLOCK_SLOTS = 220;
const STANDARD_WAREHOUSE_LETTERS = new Set(["A", "B", "C", "D"]);

/** Numeric coercion that keeps NULL meaning "no figure" instead of collapsing it to 0. */
function num(v: number | string | null | undefined): number | null {
  if (v == null) return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Same, for a column the contract declares non-nullable (the flow spine zero-fills). */
function num0(v: number | string | null | undefined): number {
  return num(v) ?? 0;
}

interface FlowRow {
  month_start: string | null;
  year: number | null;
  month: number | null;
  as_of_date: string | null;
  is_partial_month: boolean | null;
  in_kg: number | null;
  out_kg: number | null;
  net_kg: number | null;
  working_days: number | null;
  out_per_working_day: number | null;
  delivery_count: number | null;
  feeding_count: number | null;
}

interface RcInRow {
  month_start: string | null;
  market_kg: number | null;
  market_priced_kg: number | null;
  market_avg_price: number | null;
  market_php_total: number | null;
  market_delivery_count: number | null;
  active_suppliers: number | null;
  price_coverage_pct: number | null;
  sundry_reentry_kg: number | null;
  recook_kg: number | null;
}

interface InventoryRow {
  month_start: string | null;
  ending_kg: number | null;
  positive_balance_kg: number | null;
  negative_balance_kg: number | null;
  negative_batch_count: number | null;
  active_batches: number | null;
  runway_days: number | null;
  ending_value_php: number | null;
  avg_unit_cost_php_kg: number | null;
  value_coverage_pct: number | null;
  outflow_recorded: boolean | null;
}

interface CostRow {
  month_start: string | null;
  fed_kg: number | null;
  delivered_php_kg_fed: number | null;
  delivered_php_kg_fed_covered: number | null;
  fed_value_php: number | null;
  fed_kg_price_traceable: number | null;
  fed_kg_price_untraceable: number | null;
  fed_price_coverage_pct: number | null;
  produced_kg: number | null;
  yield_pct: number | null;
  process_loss_kg: number | null;
  php_per_produced_kg: number | null;
  php_per_produced_kg_covered: number | null;
  closed_blocks_count: number | null;
  closed_blocks_in_price: number | null;
  closed_blocks_unpriced: number | null;
  closed_blocks_no_delivery: number | null;
  closed_blocks_delivered_kg: number | null;
  closed_blocks_fed_kg: number | null;
  closed_blocks_lost_kg: number | null;
  closed_blocks_loss_pct: number | null;
  closed_blocks_true_php_kg: number | null;
  closed_blocks_delivered_php_kg: number | null;
  closed_blocks_uplift_php_kg: number | null;
  closed_blocks_priced_fed_kg: number | null;
}

interface AgingRow {
  month_start: string | null;
  open_kg: number | null;
  open_batches: number | null;
  wtd_age_days: number | null;
  kg_over_60d: number | null;
  kg_over_120d: number | null;
  batches_over_120d: number | null;
  pct_over_60d: number | null;
  pct_over_120d: number | null;
  oldest_age_days: number | null;
  closed_residue_kg: number | null;
  closed_residue_batches: number | null;
}

interface BatchCostRow {
  production_batch: string | null;
  campaign_year: number | null;
  campaign_label: string | null;
  first_fed_date: string | null;
  last_fed_date: string | null;
  feed_days: number | null;
  fed_kg: number | null;
  delivered_php_kg_fed: number | null;
  fed_value_php: number | null;
  fed_kg_price_traceable: number | null;
  fed_kg_price_untraceable: number | null;
  fed_price_coverage_pct: number | null;
  delivered_php_kg: number | null;
  actual_fed_php_kg: number | null;
  campaign_weighted_actual_fed_php_kg: number | null;
  uplift_php_kg: number | null;
  weight_lost_kg: number | null;
  loss_pct: number | null;
  blocks_fed: number | null;
  blocks_closed: number | null;
  blocks_open: number | null;
  blocks_in_price: number | null;
  blocks_closed_unpriced: number | null;
  campaign_fed_kg_included: number | null;
  campaign_fed_kg_excluded: number | null;
  campaign_fed_kg_included_pct: number | null;
  is_fully_covered: boolean | null;
  produced_kg: number | null;
  yield_pct: number | null;
  process_loss_kg: number | null;
  php_per_produced_kg_delivered: number | null;
  php_per_produced_kg_true: number | null;
}

interface WatchlistRow {
  batch_id: string | null;
  batch_code: string | null;
  status: string | null;
  block_loc: string | null;
  balance_kg: number | null;
  age_days: number | null;
  days_since_last_delivery: number | null;
  first_delivery_date: string | null;
  last_delivery_date: string | null;
  delivered_kg: number | null;
  delivery_count: number | null;
  unpriced_delivery_count: number | null;
  has_unpriced_delivery: boolean | null;
  delivered_php_kg: number | null;
  value_php: number | null;
  fed_kg_to_date: number | null;
  last_fed_date: string | null;
  has_been_fed: boolean | null;
  as_of_date: string | null;
}

interface SupplierRow {
  month_start: string | null;
  year: number | null;
  month: number | null;
  supplier_canonical: string | null;
  kg: number | null;
  delivery_count: number | null;
  priced_kg: number | null;
  price_coverage_pct: number | null;
  avg_price_php_kg: number | null;
  php_total: number | null;
  share_of_month_pct: number | null;
  kg_rank_in_month: number | null;
  cumulative_share_pct: number | null;
  premium_php_kg: number | null;
  sundry_origin_kg: number | null;
  sundry_origin_delivery_count: number | null;
  month_market_kg: number | null;
  month_avg_price_php_kg: number | null;
}

/**
 * PostgREST's default ceiling. The watchlist measures 170 rows today, but a
 * read that silently comes back capped is exactly the failure mode
 * CLAUDE.md's row-budget note is about, so the payload carries a flag
 * instead of the caller assuming.
 */
const POSTGREST_ROW_CAP = 1000;

/**
 * The campaign panel's column order: chronological, newest LAST.
 *
 * A campaign is named for a month (`AUGUST`), so the order is (year, month
 * index) — NOT `first_fed_date`, which is NULL for a campaign that has
 * produced but not yet been fed (SEPTEMBER 2026 is exactly that today) and
 * would sort it to an end of the axis rather than to its place in the year.
 */
const CAMPAIGN_MONTHS = [
  "JANUARY", "FEBRUARY", "MARCH", "APRIL", "MAY", "JUNE",
  "JULY", "AUGUST", "SEPTEMBER", "OCTOBER", "NOVEMBER", "DECEMBER",
];

function campaignSeq(batch: string): number {
  const i = CAMPAIGN_MONTHS.indexOf(batch.trim().toUpperCase());
  // An unrecognised batch name sorts after the twelve months of its year
  // rather than silently landing in January.
  return i === -1 ? 99 : i;
}

/**
 * THE adapter. One call, one payload, everything `/analytics` renders.
 *
 * Row budget: the eight views measure 49 / 75 / 75 / 75 / 75 / 32 / 170 / 275
 * — an order of magnitude or two under PostgREST's 1000-row cap — so these
 * reads are deliberately UNWINDOWED and span all history. A month-on-month
 * matrix that could not reach 2024 would not be the thing that was asked
 * for. The watchlist is the only one anywhere near the cap and it carries a
 * `truncated` flag. If a future view grows a daily grain, it must be
 * windowed (see the digest's note).
 */
export async function getAnalyticsData(): Promise<AnalyticsData> {
  const supabase = await createClient();
  const showPrices = await canViewPrices();

  const [
    flowRes,
    rcinRes,
    invRes,
    blocksRes,
    costRes,
    agingRes,
    batchRes,
    watchRes,
    supplierRes,
  ] = await Promise.all([
    supabase
      .from("view_analytics_flow_monthly")
      .select(
        "month_start, year, month, as_of_date, is_partial_month, in_kg, out_kg, net_kg, working_days, out_per_working_day, delivery_count, feeding_count",
      )
      .order("month_start", { ascending: true }),
    supabase
      .from("view_analytics_rcin_monthly")
      .select(
        "month_start, market_kg, market_priced_kg, market_avg_price, market_php_total, market_delivery_count, active_suppliers, price_coverage_pct, sundry_reentry_kg, recook_kg",
      )
      .order("month_start", { ascending: true }),
    supabase
      .from("view_analytics_inventory_eom")
      .select(
        "month_start, ending_kg, positive_balance_kg, negative_balance_kg, negative_batch_count, active_batches, runway_days, ending_value_php, avg_unit_cost_php_kg, value_coverage_pct, outflow_recorded",
      )
      .order("month_start", { ascending: true }),
    // LIVE utilization only — historical block occupancy is not reconstructable.
    supabase.from("view_blocking_grid").select("block_loc"),
    supabase
      .from("view_analytics_cost_monthly")
      .select(
        "month_start, fed_kg, delivered_php_kg_fed, delivered_php_kg_fed_covered, fed_value_php, fed_kg_price_traceable, fed_kg_price_untraceable, fed_price_coverage_pct, produced_kg, yield_pct, process_loss_kg, php_per_produced_kg, php_per_produced_kg_covered, closed_blocks_count, closed_blocks_in_price, closed_blocks_unpriced, closed_blocks_no_delivery, closed_blocks_delivered_kg, closed_blocks_fed_kg, closed_blocks_lost_kg, closed_blocks_loss_pct, closed_blocks_true_php_kg, closed_blocks_delivered_php_kg, closed_blocks_uplift_php_kg, closed_blocks_priced_fed_kg",
      )
      .order("month_start", { ascending: true }),
    supabase
      .from("view_analytics_aging_eom")
      .select(
        "month_start, open_kg, open_batches, wtd_age_days, kg_over_60d, kg_over_120d, batches_over_120d, pct_over_60d, pct_over_120d, oldest_age_days, closed_residue_kg, closed_residue_batches",
      )
      .order("month_start", { ascending: true }),
    supabase
      .from("view_analytics_batch_cost")
      .select(
        "production_batch, campaign_year, campaign_label, first_fed_date, last_fed_date, feed_days, fed_kg, delivered_php_kg_fed, fed_value_php, fed_kg_price_traceable, fed_kg_price_untraceable, fed_price_coverage_pct, delivered_php_kg, actual_fed_php_kg, campaign_weighted_actual_fed_php_kg, uplift_php_kg, weight_lost_kg, loss_pct, blocks_fed, blocks_closed, blocks_open, blocks_in_price, blocks_closed_unpriced, campaign_fed_kg_included, campaign_fed_kg_excluded, campaign_fed_kg_included_pct, is_fully_covered, produced_kg, yield_pct, process_loss_kg, php_per_produced_kg_delivered, php_per_produced_kg_true",
      ),
    // The view is already ORDER BY age_days DESC — oldest first — so no
    // client-side sort is applied and the list the screen shows is the
    // list the database ranked.
    supabase
      .from("view_analytics_aging_watchlist")
      .select(
        "batch_id, batch_code, status, block_loc, balance_kg, age_days, days_since_last_delivery, first_delivery_date, last_delivery_date, delivered_kg, delivery_count, unpriced_delivery_count, has_unpriced_delivery, delivered_php_kg, value_php, fed_kg_to_date, last_fed_date, has_been_fed, as_of_date",
      ),
    // P3 — the supplier room. UNWINDOWED, same reasoning as every read above:
    // 275 rows for ALL of history (113 for the busiest single year), ~4x under
    // the cap. The YEAR filter is applied in the browser, not here, because
    // every control on this page re-slices a payload it already holds; the
    // read still carries a `truncated` flag rather than the caller assuming.
    supabase
      .from("view_analytics_supplier_monthly")
      .select(
        "month_start, year, month, supplier_canonical, kg, delivery_count, priced_kg, price_coverage_pct, avg_price_php_kg, php_total, share_of_month_pct, kg_rank_in_month, cumulative_share_pct, premium_php_kg, sundry_origin_kg, sundry_origin_delivery_count, month_market_kg, month_avg_price_php_kg",
      )
      .order("month_start", { ascending: true })
      .order("kg", { ascending: false }),
  ]);

  if (flowRes.error) throw new Error(`Analytics flow read failed: ${flowRes.error.message}`);
  if (rcinRes.error) throw new Error(`Analytics RC IN read failed: ${rcinRes.error.message}`);
  if (invRes.error) throw new Error(`Analytics inventory read failed: ${invRes.error.message}`);
  if (costRes.error) throw new Error(`Analytics cost read failed: ${costRes.error.message}`);
  if (agingRes.error) throw new Error(`Analytics aging read failed: ${agingRes.error.message}`);
  if (batchRes.error)
    throw new Error(`Analytics campaign read failed: ${batchRes.error.message}`);
  if (watchRes.error)
    throw new Error(`Analytics watchlist read failed: ${watchRes.error.message}`);
  if (supplierRes.error)
    throw new Error(`Analytics supplier read failed: ${supplierRes.error.message}`);

  const rcinByMonth = new Map<string, RcInRow>();
  for (const r of (rcinRes.data ?? []) as RcInRow[]) {
    if (r.month_start) rcinByMonth.set(r.month_start, r);
  }
  const invByMonth = new Map<string, InventoryRow>();
  for (const r of (invRes.data ?? []) as InventoryRow[]) {
    if (r.month_start) invByMonth.set(r.month_start, r);
  }
  const costByMonth = new Map<string, CostRow>();
  for (const r of (costRes.data ?? []) as CostRow[]) {
    if (r.month_start) costByMonth.set(r.month_start, r);
  }
  const ageByMonth = new Map<string, AgingRow>();
  for (const r of (agingRes.data ?? []) as AgingRow[]) {
    if (r.month_start) ageByMonth.set(r.month_start, r);
  }

  const months: AnalyticsMonth[] = ((flowRes.data ?? []) as FlowRow[])
    .filter((f): f is FlowRow & { month_start: string } => Boolean(f.month_start))
    .map((f) => {
      const rc = rcinByMonth.get(f.month_start);
      const inv = invByMonth.get(f.month_start);
      const age = ageByMonth.get(f.month_start);
      const outflowRecorded = inv?.outflow_recorded ?? false;

      // The honest nulling — see the header. `out_kg` for a month before
      // feedings were recorded is a structural zero, not a measurement.
      const outKg = outflowRecorded ? num(f.out_kg) : null;

      // The money layer hangs off feeding, so a month with no recorded
      // feeding has no money layer either — `cost` is dropped wholesale
      // rather than nulled field by field, which is one decision instead of
      // twenty and cannot be half-applied by a later edit.
      const cost = outflowRecorded ? costByMonth.get(f.month_start) : undefined;

      // The SECOND honest nulling (P2). `produced_kg = 0` on 24 months is a
      // structural zero: production reports begin 2025-11, and a 0% yield
      // would roll into a quarter as if 8,000 tonnes of charcoal had become
      // nothing. Measured from the data itself, never from a hardcoded date.
      const producedKg = num(cost?.produced_kg);
      const productionRecorded = producedKg != null && producedKg > 0;
      const money = productionRecorded ? cost : undefined;

      return {
        monthStart: f.month_start,
        year: num0(f.year),
        month: num0(f.month),
        asOfDate: f.as_of_date,
        isPartialMonth: Boolean(f.is_partial_month),

        marketKg: num(rc?.market_kg),
        marketPricedKg: num(rc?.market_priced_kg),
        marketAvgPrice: showPrices ? num(rc?.market_avg_price) : null,
        marketPhpTotal: showPrices ? num(rc?.market_php_total) : null,
        activeSuppliers: num(rc?.active_suppliers),
        sundryReentryKg: num(rc?.sundry_reentry_kg),
        recookKg: num(rc?.recook_kg),
        marketDeliveryCount: num(rc?.market_delivery_count),
        priceCoveragePct: num(rc?.price_coverage_pct),

        inKg: num0(f.in_kg),
        outKg,
        netKg: outKg == null ? null : num(f.net_kg),
        workingDays: num0(f.working_days),
        outPerWorkingDay: outKg == null ? null : num(f.out_per_working_day),
        deliveryCount: num0(f.delivery_count),
        feedingCount: num0(f.feeding_count),

        endingKg: num(inv?.ending_kg),
        positiveBalanceKg: num(inv?.positive_balance_kg),
        negativeBalanceKg: num(inv?.negative_balance_kg),
        negativeBatchCount: num(inv?.negative_batch_count),
        activeBatches: num(inv?.active_batches),
        runwayDays: outflowRecorded ? num(inv?.runway_days) : null,
        endingValuePhp: showPrices ? num(inv?.ending_value_php) : null,
        avgUnitCostPhpKg: showPrices ? num(inv?.avg_unit_cost_php_kg) : null,
        valueCoveragePct: num(inv?.value_coverage_pct),
        outflowRecorded,

        // ── P2: the money layer, calendar basis ──────────────────────
        fedKg: num(cost?.fed_kg),
        deliveredPhpKgFed: showPrices ? num(cost?.delivered_php_kg_fed) : null,
        deliveredPhpKgFedCovered: showPrices
          ? num(cost?.delivered_php_kg_fed_covered)
          : null,
        fedValuePhp: showPrices ? num(cost?.fed_value_php) : null,
        fedKgPriceTraceable: num(cost?.fed_kg_price_traceable),
        fedKgPriceUntraceable: num(cost?.fed_kg_price_untraceable),
        fedPriceCoveragePct: num(cost?.fed_price_coverage_pct),

        producedKg: productionRecorded ? producedKg : null,
        yieldPct: num(money?.yield_pct),
        processLossKg: num(money?.process_loss_kg),
        phpPerProducedKg: showPrices ? num(money?.php_per_produced_kg) : null,
        phpPerProducedKgCovered: showPrices
          ? num(money?.php_per_produced_kg_covered)
          : null,
        productionRecorded,

        closedBlocksCount: num(cost?.closed_blocks_count),
        closedBlocksInPrice: num(cost?.closed_blocks_in_price),
        closedBlocksUnpriced: num(cost?.closed_blocks_unpriced),
        closedBlocksNoDelivery: num(cost?.closed_blocks_no_delivery),
        closedBlocksDeliveredKg: num(cost?.closed_blocks_delivered_kg),
        closedBlocksFedKg: num(cost?.closed_blocks_fed_kg),
        closedBlocksLostKg: num(cost?.closed_blocks_lost_kg),
        closedBlocksLossPct: num(cost?.closed_blocks_loss_pct),
        closedBlocksTruePhpKg: showPrices
          ? num(cost?.closed_blocks_true_php_kg)
          : null,
        closedBlocksDeliveredPhpKg: showPrices
          ? num(cost?.closed_blocks_delivered_php_kg)
          : null,
        closedBlocksUpliftPhpKg: showPrices
          ? num(cost?.closed_blocks_uplift_php_kg)
          : null,
        closedBlocksPricedFedKg: num(cost?.closed_blocks_priced_fed_kg),

        // ── P2: aging. ₱-FREE, so no gate and no outflow dependency ──
        openKg: num(age?.open_kg),
        openBatches: num(age?.open_batches),
        wtdAgeDays: num(age?.wtd_age_days),
        kgOver60d: num(age?.kg_over_60d),
        kgOver120d: num(age?.kg_over_120d),
        batchesOver120d: num(age?.batches_over_120d),
        pctOver60d: num(age?.pct_over_60d),
        pctOver120d: num(age?.pct_over_120d),
        oldestAgeDays: num(age?.oldest_age_days),
        closedResidueKg: num(age?.closed_residue_kg),
        closedResidueBatches: num(age?.closed_residue_batches),
      } satisfies AnalyticsMonth;
    });

  const years = [...new Set(months.map((m) => m.year))].sort((a, b) => b - a);
  const latest = months[months.length - 1];

  const campaigns: CampaignCost[] = ((batchRes.data ?? []) as BatchCostRow[])
    .filter(
      (b): b is BatchCostRow & { production_batch: string; campaign_year: number } =>
        Boolean(b.production_batch) && b.campaign_year != null,
    )
    .map((b) => ({
      productionBatch: b.production_batch,
      campaignYear: b.campaign_year,
      campaignLabel: b.campaign_label ?? `${b.production_batch} ${b.campaign_year}`,
      firstFedDate: b.first_fed_date,
      lastFedDate: b.last_fed_date,
      feedDays: num(b.feed_days),

      fedKg: num(b.fed_kg),
      deliveredPhpKgFed: showPrices ? num(b.delivered_php_kg_fed) : null,
      fedValuePhp: showPrices ? num(b.fed_value_php) : null,
      fedKgPriceTraceable: num(b.fed_kg_price_traceable),
      fedKgPriceUntraceable: num(b.fed_kg_price_untraceable),
      fedPriceCoveragePct: num(b.fed_price_coverage_pct),

      deliveredPhpKg: showPrices ? num(b.delivered_php_kg) : null,
      actualFedPhpKg: showPrices ? num(b.actual_fed_php_kg) : null,
      campaignWeightedActualFedPhpKg: showPrices
        ? num(b.campaign_weighted_actual_fed_php_kg)
        : null,
      upliftPhpKg: showPrices ? num(b.uplift_php_kg) : null,
      weightLostKg: num(b.weight_lost_kg),
      lossPct: num(b.loss_pct),

      blocksFed: num(b.blocks_fed),
      blocksClosed: num(b.blocks_closed),
      blocksOpen: num(b.blocks_open),
      blocksInPrice: num(b.blocks_in_price),
      blocksClosedUnpriced: num(b.blocks_closed_unpriced),
      campaignFedKgIncluded: num(b.campaign_fed_kg_included),
      campaignFedKgExcluded: num(b.campaign_fed_kg_excluded),
      campaignFedKgIncludedPct: num(b.campaign_fed_kg_included_pct),
      isFullyCovered: Boolean(b.is_fully_covered),

      // A campaign's production is genuinely 0 for the pre-2025-11 ones, and
      // the same structural-zero rule applies: `yield_pct = 0` there means
      // "not reported", not "nothing came out".
      producedKg: num(b.produced_kg) || null,
      yieldPct: num(b.produced_kg) ? num(b.yield_pct) : null,
      processLossKg: num(b.produced_kg) ? num(b.process_loss_kg) : null,
      phpPerProducedKgDelivered: showPrices
        ? num(b.php_per_produced_kg_delivered)
        : null,
      phpPerProducedKgTrue: showPrices ? num(b.php_per_produced_kg_true) : null,
    }))
    .sort(
      (a, b) =>
        a.campaignYear - b.campaignYear ||
        campaignSeq(a.productionBatch) - campaignSeq(b.productionBatch),
    );

  const watchRows = (watchRes.data ?? []) as WatchlistRow[];
  const items: AgingWatchItem[] = watchRows
    .filter((w): w is WatchlistRow & { batch_id: string; batch_code: string } =>
      Boolean(w.batch_id) && Boolean(w.batch_code),
    )
    .map((w) => ({
      batchId: w.batch_id,
      batchCode: w.batch_code,
      status: w.status,
      blockLoc: w.block_loc,
      balanceKg: num(w.balance_kg),
      ageDays: num(w.age_days),
      daysSinceLastDelivery: num(w.days_since_last_delivery),
      firstDeliveryDate: w.first_delivery_date,
      lastDeliveryDate: w.last_delivery_date,
      deliveredKg: num(w.delivered_kg),
      deliveryCount: num(w.delivery_count),
      unpricedDeliveryCount: num(w.unpriced_delivery_count),
      hasUnpricedDelivery: Boolean(w.has_unpriced_delivery),
      deliveredPhpKg: showPrices ? num(w.delivered_php_kg) : null,
      valuePhp: showPrices ? num(w.value_php) : null,
      fedKgToDate: num(w.fed_kg_to_date),
      lastFedDate: w.last_fed_date,
      hasBeenFed: Boolean(w.has_been_fed),
    }));

  // The headline is the newest month-end aging row, NOT a sum of the list
  // above — `open_kg` there is the same population, measured equal to the
  // kilo, and re-adding it here would be a second definition of how much
  // charcoal is standing in the yard.
  const watchlist: AgingWatchlist = {
    items,
    openKg: latest?.openKg ?? null,
    openBatches: latest?.openBatches ?? null,
    wtdAgeDays: latest?.wtdAgeDays ?? null,
    pctOver120d: latest?.pctOver120d ?? null,
    oldestAgeDays: latest?.oldestAgeDays ?? null,
    closedResidueKg: latest?.closedResidueKg ?? null,
    closedResidueBatches: latest?.closedResidueBatches ?? null,
    asOfDate: watchRows[0]?.as_of_date ?? latest?.asOfDate ?? null,
    truncated: watchRows.length >= POSTGREST_ROW_CAP,
  };

  // ── P3: the supplier room ──────────────────────────────────────────
  // Four ₱ columns are gated. Everything else — kilos, share, ranks,
  // counts, sundry origin — is peso-free and none of it is derivable back
  // into a price, so the volume and participation half of the supplier
  // room stays fully visible to Production, the same split that made
  // `view_analytics_aging_eom` useful to a restricted role in P2.
  const supplierRows = (supplierRes.data ?? []) as SupplierRow[];
  const suppliers: SupplierData = {
    rows: supplierRows
      .filter(
        (s): s is SupplierRow & { month_start: string; supplier_canonical: string } =>
          Boolean(s.month_start) && Boolean(s.supplier_canonical),
      )
      .map((s) => ({
        monthStart: s.month_start,
        year: num0(s.year),
        month: num0(s.month),
        supplier: s.supplier_canonical,

        kg: num(s.kg),
        deliveryCount: num(s.delivery_count),
        pricedKg: num(s.priced_kg),
        priceCoveragePct: num(s.price_coverage_pct),

        avgPricePhpKg: showPrices ? num(s.avg_price_php_kg) : null,
        phpTotal: showPrices ? num(s.php_total) : null,

        shareOfMonthPct: num(s.share_of_month_pct),
        kgRankInMonth: num(s.kg_rank_in_month),
        cumulativeSharePct: num(s.cumulative_share_pct),

        premiumPhpKg: showPrices ? num(s.premium_php_kg) : null,

        sundryOriginKg: num(s.sundry_origin_kg),
        sundryOriginDeliveryCount: num(s.sundry_origin_delivery_count),

        monthMarketKg: num(s.month_market_kg),
        monthAvgPricePhpKg: showPrices ? num(s.month_avg_price_php_kg) : null,
      })) satisfies SupplierMonth[],
    truncated: supplierRows.length >= POSTGREST_ROW_CAP,
  };

  return {
    months,
    years,
    defaultYear: years[0] ?? new Date().getFullYear(),
    canViewPrices: showPrices,
    utilization: blocksRes.error ? null : countOccupied(blocksRes.data),
    asOfDate: latest?.asOfDate ?? null,
    campaigns,
    watchlist,
    suppliers,
  };
}

/**
 * LIVE block occupancy — distinct standard-warehouse slots holding a batch.
 *
 * `view_blocking_grid` emits one row per ACTIVE batch with its current
 * `block_loc`, so a distinct count of A–D slots is the occupancy. PCA/PCB
 * are prepared-charcoal sundrying slots and are excluded, exactly as the
 * Blocking grid's own 220-slot baseline excludes them; a FEED-area row has
 * no warehouse letter and is excluded too.
 */
function countOccupied(
  rows: { block_loc: string | null }[] | null,
): BlockUtilization | null {
  if (!rows) return null;
  const slots = new Set<string>();
  for (const r of rows) {
    const loc = r.block_loc?.trim().toUpperCase();
    if (!loc) continue;
    if (loc.startsWith("PCA-") || loc.startsWith("PCB-")) continue;
    if (!STANDARD_WAREHOUSE_LETTERS.has(loc.charAt(0))) continue;
    slots.add(loc);
  }
  return { occupied: slots.size, total: STANDARD_BLOCK_SLOTS };
}
