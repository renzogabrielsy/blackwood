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
//     view_analytics_supplier_monthly→ avg_price_php_kg, php_total,
//         premium_php_kg, month_avg_price_php_kg
// They are nulled HERE, before the payload leaves the server — never
// hidden client-side, because the network response is the leak.
// `view_analytics_flow_monthly` and `view_analytics_aging_eom` carry no ₱
// and none is derivable from either, so aging stays visible for every role
// including Production.
//
// **THE TWO P4 PRODUCTION VIEWS HAVE NOTHING TO NULL.** No ₱ column exists
// in either and none is derivable (asserted by the migration: 0 of 35
// columns match `php|peso|cost|price|value|amount`), so the whole
// production matrix — tonnage, grades, downtime, power, bags — crosses the
// wire intact for every role including Production. That is structural, not
// an oversight: production is the one module of the platform with no money
// in it, and the money that MEETS production already lives in
// `view_analytics_cost_monthly` and is gated above.
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
  AnalyticsData,
  AnalyticsMonth,
  BlockUtilization,
  CampaignCost,
  ProductionGradeData,
  ProductionGradeMonth,
  SupplierData,
  SupplierMonth,
} from "./types";
import { campaignSeq } from "./campaign";

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

interface ProductionRow {
  month_start: string | null;
  production_reported: boolean | null;
  run_count: number | null;
  shift_count: number | null;
  reported_days: number | null;
  produced_per_reported_day: number | null;
  first_reported_date: string | null;
  last_reported_date: string | null;
  downtime_hrs: number | null;
  downtime_shift_count: number | null;
  downtime_shifts_with_duration: number | null;
  downtime_shifts_reason_only: number | null;
  kwh: number | null;
  power_days: number | null;
  power_meter_count: number | null;
  kwh_suspect_reading_count: number | null;
  kwh_suspect: number | null;
  kwh_per_produced_kg: number | null;
  kwh_per_produced_kg_excl_suspect: number | null;
  sacks: number | null;
  runs_with_sacks: number | null;
  sacks_coverage_pct: number | null;
}

interface ProductionGradeRow {
  month_start: string | null;
  year: number | null;
  month: number | null;
  grade: string | null;
  kg: number | null;
  run_count: number | null;
  share_of_month_pct: number | null;
  month_produced_kg: number | null;
  sacks: number | null;
  runs_with_sacks: number | null;
}

/**
 * PostgREST's default ceiling. The biggest read here is 275 rows, but a
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
 *
 * OWNER FEEDBACK R5: `campaignSeq` and its month list moved to
 * `lib/analytics/campaign.ts` — a PURE module — because the campaign panel's
 * new checklist has to list campaigns in the same chronological order these
 * columns are in, and this file is `server-only`. One definition, two callers;
 * a copy of the twelve names inside a client component would have drifted the
 * first time one of them was touched.
 */


/**
 * THE adapter. One call, one payload, everything `/analytics` renders.
 *
 * Row budget: the nine views measure 49 / 75 / 75 / 75 / 75 / 32 / 275 / 18 / 39
 * — an order of magnitude or two under PostgREST's 1000-row cap — so these
 * reads are deliberately UNWINDOWED and span all history. A month-on-month
 * matrix that could not reach 2024 would not be the thing that was asked
 * for. The supplier read is the largest and it carries a `truncated` flag.
 * If a future view grows a daily grain, it must be windowed (see the
 * digest's note).
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
    supplierRes,
    prodRes,
    gradeRes,
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
    // P4 — the production matrix. 18 rows all-history (production months
    // UNION electricity months: the meters start 2025-03 and production
    // reporting starts 2025-11, so eight months carry power and no output).
    // Three orders of magnitude under the cap, same unwindowed reasoning as
    // every read above, and the `truncated` flag still rides on the grade
    // read rather than the caller assuming.
    supabase
      .from("view_analytics_production_monthly")
      .select(
        "month_start, production_reported, run_count, shift_count, reported_days, produced_per_reported_day, first_reported_date, last_reported_date, downtime_hrs, downtime_shift_count, downtime_shifts_with_duration, downtime_shifts_reason_only, kwh, power_days, power_meter_count, kwh_suspect_reading_count, kwh_suspect, kwh_per_produced_kg, kwh_per_produced_kg_excl_suspect, sacks, runs_with_sacks, sacks_coverage_pct",
      )
      .order("month_start", { ascending: true }),
    // 39 rows all-history.
    supabase
      .from("view_analytics_production_grade_monthly")
      .select(
        "month_start, year, month, grade, kg, run_count, share_of_month_pct, month_produced_kg, sacks, runs_with_sacks",
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
  if (supplierRes.error)
    throw new Error(`Analytics supplier read failed: ${supplierRes.error.message}`);
  if (prodRes.error)
    throw new Error(`Analytics production read failed: ${prodRes.error.message}`);
  if (gradeRes.error)
    throw new Error(`Analytics production grade read failed: ${gradeRes.error.message}`);

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
  const prodByMonth = new Map<string, ProductionRow>();
  for (const r of (prodRes.data ?? []) as ProductionRow[]) {
    if (r.month_start) prodByMonth.set(r.month_start, r);
  }

  const months: AnalyticsMonth[] = ((flowRes.data ?? []) as FlowRow[])
    .filter((f): f is FlowRow & { month_start: string } => Boolean(f.month_start))
    .map((f) => {
      const rc = rcinByMonth.get(f.month_start);
      const inv = invByMonth.get(f.month_start);
      const age = ageByMonth.get(f.month_start);
      // P4. NOT gated on `outflowRecorded`: the production view's own spine
      // is production months ∪ ELECTRICITY months, and eight of those carry
      // power with no output at all. Dropping the row wholesale (the way the
      // money layer is dropped) would have thrown away 577,438 kWh from a
      // block that has a kWh row in it.
      const prod = prodByMonth.get(f.month_start);
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

        // ── P4: production. ₱-FREE, so no gate anywhere below ─────────
        // Every figure the view publishes is mapped verbatim, INCLUDING the
        // four companion counts (`downtime_shifts_reason_only`,
        // `kwh_suspect_reading_count`, `runs_with_sacks`,
        // `sacks_coverage_pct`). They are what keep a 0.00 downtime hour, a
        // 696,924 kWh month and a blank bag count honest, and an adapter
        // that dropped them would have handed the UI a number with no way
        // to say what is wrong with it.
        productionReported: Boolean(prod?.production_reported),
        productionRunCount: num(prod?.run_count),
        productionShiftCount: num(prod?.shift_count),
        reportedDays: num(prod?.reported_days),
        producedPerReportedDay: num(prod?.produced_per_reported_day),
        firstReportedDate: prod?.first_reported_date ?? null,
        lastReportedDate: prod?.last_reported_date ?? null,

        downtimeHrs: num(prod?.downtime_hrs),
        downtimeShiftCount: num(prod?.downtime_shift_count),
        downtimeShiftsWithDuration: num(prod?.downtime_shifts_with_duration),
        downtimeShiftsReasonOnly: num(prod?.downtime_shifts_reason_only),

        kwh: num(prod?.kwh),
        powerDays: num(prod?.power_days),
        powerMeterCount: num(prod?.power_meter_count),
        kwhSuspectReadingCount: num(prod?.kwh_suspect_reading_count),
        kwhSuspectKwh: num(prod?.kwh_suspect),
        kwhPerProducedKg: num(prod?.kwh_per_produced_kg),
        kwhPerProducedKgExclSuspect: num(prod?.kwh_per_produced_kg_excl_suspect),

        sacks: num(prod?.sacks),
        runsWithSacks: num(prod?.runs_with_sacks),
        sacksCoveragePct: num(prod?.sacks_coverage_pct),
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

  // ── OWNER FEEDBACK R1: THE AGING WATCHLIST IS GONE ─────────────────
  // Renzo, 2026-09-01, in as many words: "take out piles to go look at."
  // The section, its nav anchor and this read all went with it, so the page
  // makes one fewer round trip.
  //
  // **`view_analytics_aging_watchlist` still EXISTS in the database and is
  // untouched** — dropping a view because one screen stopped rendering it
  // would be destroying a thing to tidy a page. The `AgingWatchItem` /
  // `AgingWatchlist` types and `aging-watchlist.tsx` are likewise left in
  // place, unmounted, so the block can be brought back by re-adding this read
  // and one JSX element.
  //
  // The AGING MATRIX ROWS are a different thing entirely and are unaffected:
  // Avg stock age and Stock over 120 days read `view_analytics_aging_eom`,
  // which is still read above and still feeds the ending-inventory expand's
  // closed-residue split.

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

  // ── P4: the grade mix ──────────────────────────────────────────────
  // Nothing is gated and nothing is nulled — there is no ₱ column in this
  // view and none is derivable from it. The `share_of_month_pct` its rows
  // carry is SQL's own, whose denominator is JOINED from the monthly
  // production view rather than re-summed, so a grade share and the monthly
  // headline cannot drift apart. Nothing is recomputed here.
  const gradeRows = (gradeRes.data ?? []) as ProductionGradeRow[];
  const productionGrades: ProductionGradeData = {
    rows: gradeRows
      .filter(
        (g): g is ProductionGradeRow & { month_start: string; grade: string } =>
          Boolean(g.month_start) && Boolean(g.grade),
      )
      .map((g) => ({
        monthStart: g.month_start,
        year: num0(g.year),
        month: num0(g.month),
        grade: g.grade,
        kg: num(g.kg),
        runCount: num(g.run_count),
        shareOfMonthPct: num(g.share_of_month_pct),
        monthProducedKg: num(g.month_produced_kg),
        sacks: num(g.sacks),
        runsWithSacks: num(g.runs_with_sacks),
      })) satisfies ProductionGradeMonth[],
    truncated: gradeRows.length >= POSTGREST_ROW_CAP,
  };

  return {
    months,
    years,
    defaultYear: years[0] ?? new Date().getFullYear(),
    canViewPrices: showPrices,
    utilization: blocksRes.error ? null : countOccupied(blocksRes.data),
    asOfDate: latest?.asOfDate ?? null,
    campaigns,
    suppliers,
    productionGrades,
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
