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
// impersonation cookie) decides whether the FOUR ₱ fields cross the wire:
//     view_analytics_rcin_monthly  → market_avg_price, market_php_total
//     view_analytics_inventory_eom → ending_value_php, avg_unit_cost_php_kg
// They are nulled HERE, before the payload leaves the server — never
// hidden client-side, because the network response is the leak.
// `view_analytics_flow_monthly` carries no ₱ and none is derivable.
//
// ── THE ONE HONEST NULLING ────────────────────────────────────────────
// Deliveries begin 2020-07; `rc_out` begins 2024-01. For a month where the
// view says `outflow_recorded = false`, `out_kg` is a STRUCTURAL zero — the
// plant was fed, nobody wrote it down. A zero here would sum into a quarter
// and a year as if the plant had eaten nothing, and no rollup downstream
// could tell that apart from a real quiet month. So `outKg`, `netKg`,
// `outPerWorkingDay` and `runwayDays` are set to NULL for those months and
// the flag rides along so the UI can say why the cell is blank.
// =====================================================================

import "server-only";
import { createClient } from "@/lib/supabase/server";
import { canViewPrices } from "@/lib/auth";
import type { AnalyticsData, AnalyticsMonth, BlockUtilization } from "./types";

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

/**
 * THE adapter. One call, one payload, everything `/analytics` renders.
 *
 * Row budget: the three views measure 49 / 75 / 75 rows — two orders of
 * magnitude under PostgREST's 1000-row cap — so these reads are deliberately
 * UNWINDOWED and span all history. A month-on-month matrix that could not
 * reach 2024 would not be the thing that was asked for. If a future view
 * grows a daily grain, it must be windowed (see the digest's note).
 */
export async function getAnalyticsData(): Promise<AnalyticsData> {
  const supabase = await createClient();
  const showPrices = await canViewPrices();

  const [flowRes, rcinRes, invRes, blocksRes] = await Promise.all([
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
  ]);

  if (flowRes.error) throw new Error(`Analytics flow read failed: ${flowRes.error.message}`);
  if (rcinRes.error) throw new Error(`Analytics RC IN read failed: ${rcinRes.error.message}`);
  if (invRes.error) throw new Error(`Analytics inventory read failed: ${invRes.error.message}`);

  const rcinByMonth = new Map<string, RcInRow>();
  for (const r of (rcinRes.data ?? []) as RcInRow[]) {
    if (r.month_start) rcinByMonth.set(r.month_start, r);
  }
  const invByMonth = new Map<string, InventoryRow>();
  for (const r of (invRes.data ?? []) as InventoryRow[]) {
    if (r.month_start) invByMonth.set(r.month_start, r);
  }

  const months: AnalyticsMonth[] = ((flowRes.data ?? []) as FlowRow[])
    .filter((f): f is FlowRow & { month_start: string } => Boolean(f.month_start))
    .map((f) => {
      const rc = rcinByMonth.get(f.month_start);
      const inv = invByMonth.get(f.month_start);
      const outflowRecorded = inv?.outflow_recorded ?? false;

      // The honest nulling — see the header. `out_kg` for a month before
      // feedings were recorded is a structural zero, not a measurement.
      const outKg = outflowRecorded ? num(f.out_kg) : null;

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
      } satisfies AnalyticsMonth;
    });

  const years = [...new Set(months.map((m) => m.year))].sort((a, b) => b - a);
  const latest = months[months.length - 1];

  return {
    months,
    years,
    defaultYear: years[0] ?? new Date().getFullYear(),
    canViewPrices: showPrices,
    utilization: blocksRes.error ? null : countOccupied(blocksRes.data),
    asOfDate: latest?.asOfDate ?? null,
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
