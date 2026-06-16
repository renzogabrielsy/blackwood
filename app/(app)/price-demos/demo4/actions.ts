'use server';

// =====================================================================
// Analyst Brief — live data layer for the demo-4 monthly price/volume table
// =====================================================================
// Graduates demo-4 from the static _mock/data.ts to live `deliveries` data.
//
// HARD RULES honored here:
//  • All aggregation / weighted averages live in SQL — this module only
//    SHAPES rows. Monthly grain comes from view_delivery_monthly_analytics;
//    the per-year footer comes from view_delivery_yearly_analytics (a true
//    weighted yearly rollup, NOT the monthly averages re-averaged in TS).
//  • Price gating (canViewPrices, lib/auth.ts) is CANONICAL. When the
//    effective role cannot view prices, phpPerKg AND phpTotal are nulled in
//    every row and in totalsByYear BEFORE the payload leaves the server.
//  • cost_basis = 0 / NULL is the gsheet UNPRICED placeholder (ledger L-008),
//    already excluded from price aggregates inside the views (but counted in
//    volume) — no special handling needed here.
// =====================================================================

import { createClient } from '@/lib/supabase/server';
import { canViewPrices } from '@/lib/auth';

/** One month slot in a year's 12-month axis. Lab + price fields are nullable:
 *  null = no data / unpriced / price-gated. */
export interface MonthlyDeliveryRow {
  year: number;
  /** ISO-ish key, e.g. '2026-01'. */
  monthKey: string;
  /** Short label, e.g. 'Jan'. */
  label: string;
  /** Full label, e.g. 'January'. */
  full: string;
  /** 0..11 (Jan..Dec). */
  monthIndex: number;
  /** Row count of deliveries that month (0 for empty months). */
  deliveries: number;
  /** Sum of sacks (0 for empty months). */
  sacks: number;
  /** Sum of weight_kg — counts ALL rows, priced or not (0 for empty months). */
  weightKg: number;
  /** Volume-weighted lab metrics; null when no data that month. */
  mc: number | null;
  grit: number | null;
  vm: number | null;
  ash: number | null;
  fc: number | null;
  bdAstm: number | null;
  bdJis: number | null;
  /** Volume-weighted ₱/kg over PRICED rows; null when no priced rows OR price-gated. */
  phpPerKg: number | null;
  /** Actual spend = Σ(cost_basis·weight_kg) over priced rows; null when 0/none OR price-gated. */
  phpTotal: number | null;
}

/** Footer rollup for one year. Sums for counts/volume/spend; volume-weighted for the rest. */
export interface Totals {
  deliveries: number;
  sacks: number;
  weightKg: number;
  mc: number | null;
  grit: number | null;
  vm: number | null;
  ash: number | null;
  fc: number | null;
  bdAstm: number | null;
  bdJis: number | null;
  /** Volume-weighted ₱/kg for the whole year; null when no priced rows OR price-gated. */
  phpPerKg: number | null;
  /** Total actual spend for the year; null when 0/none OR price-gated. */
  phpTotal: number | null;
}

/** Full payload returned to the demo-4 page. */
export interface MonthlyDeliveryAnalytics {
  /** Years that actually have deliveries, ascending. */
  years: number[];
  /** Per-year 12-month axis (always 12 rows, monthIndex 0..11, zero-filled). */
  byYear: Record<number, MonthlyDeliveryRow[]>;
  /** Per-year footer rollup. */
  totalsByYear: Record<number, Totals>;
  /** Whether the caller may see ₱ data. When false, all price fields above are null. */
  canViewPrices: boolean;
}

const MONTH_LABELS = [
  ['Jan', 'January'], ['Feb', 'February'], ['Mar', 'March'], ['Apr', 'April'],
  ['May', 'May'], ['Jun', 'June'], ['Jul', 'July'], ['Aug', 'August'],
  ['Sep', 'September'], ['Oct', 'October'], ['Nov', 'November'], ['Dec', 'December'],
] as const;

/** numeric|string|null from the view -> number|null (views emit numerics as strings). */
function num(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

/** numeric|string|null -> number, defaulting to 0 (for count/volume columns). */
function num0(v: unknown): number {
  return num(v) ?? 0;
}

/**
 * Fetch the live monthly delivery analytics for the Analyst Brief.
 *
 * Return shape: { years, byYear, totalsByYear, canViewPrices }.
 *  - byYear[year] is ALWAYS 12 rows (monthIndex 0..11). Months without
 *    deliveries are zero-filled (deliveries/sacks/weightKg = 0) with null
 *    lab + price, so the frontend has a consistent 12-month axis.
 *  - When canViewPrices is false, phpPerKg and phpTotal are null everywhere.
 *
 * Throws on query failure — the frontend should surface via errorToast().
 */
export async function fetchMonthlyDeliveryAnalytics(): Promise<MonthlyDeliveryAnalytics> {
  const supabase = await createClient();
  const showPrices = await canViewPrices();

  const [monthlyRes, yearlyRes] = await Promise.all([
    supabase
      .from('view_delivery_monthly_analytics')
      .select('*')
      .order('year', { ascending: true })
      .order('month', { ascending: true }),
    supabase
      .from('view_delivery_yearly_analytics')
      .select('*')
      .order('year', { ascending: true }),
  ]);

  if (monthlyRes.error) {
    throw new Error(`Failed to load monthly delivery analytics: ${monthlyRes.error.message}`);
  }
  if (yearlyRes.error) {
    throw new Error(`Failed to load yearly delivery totals: ${yearlyRes.error.message}`);
  }

  const monthlyRows = monthlyRes.data ?? [];
  const yearlyRows = yearlyRes.data ?? [];

  // Years that actually have data, ascending.
  const years = Array.from(
    new Set(yearlyRows.map((r) => r.year as number).filter((y): y is number => y != null)),
  ).sort((a, b) => a - b);

  // Index monthly rows by year -> monthIndex for O(1) lookup.
  const monthlyByYearMonth = new Map<string, (typeof monthlyRows)[number]>();
  for (const r of monthlyRows) {
    if (r.year == null || r.month == null) continue;
    monthlyByYearMonth.set(`${r.year}-${r.month}`, r);
  }

  const byYear: Record<number, MonthlyDeliveryRow[]> = {};
  for (const year of years) {
    byYear[year] = Array.from({ length: 12 }, (_, monthIndex) => {
      const month = monthIndex + 1; // view stores 1..12
      const src = monthlyByYearMonth.get(`${year}-${month}`);
      const [label, full] = MONTH_LABELS[monthIndex];
      const monthKey = `${year}-${String(month).padStart(2, '0')}`;

      if (!src) {
        // zero-fill empty month
        return {
          year, monthKey, label, full, monthIndex,
          deliveries: 0, sacks: 0, weightKg: 0,
          mc: null, grit: null, vm: null, ash: null, fc: null, bdAstm: null, bdJis: null,
          phpPerKg: null, phpTotal: null,
        };
      }

      return {
        year, monthKey, label, full, monthIndex,
        deliveries: num0(src.deliveries),
        sacks: num0(src.sacks),
        weightKg: num0(src.volume_kg),
        mc: num(src.mc),
        grit: num(src.grit),
        vm: num(src.vm),
        ash: num(src.ash),
        fc: num(src.fc),
        bdAstm: num(src.bd_astm),
        bdJis: num(src.bd_jis),
        phpPerKg: showPrices ? num(src.avg_price) : null,
        phpTotal: showPrices ? num(src.php_total) : null,
      };
    });
  }

  const yearlyByYear = new Map<number, (typeof yearlyRows)[number]>();
  for (const r of yearlyRows) {
    if (r.year != null) yearlyByYear.set(r.year as number, r);
  }

  const totalsByYear: Record<number, Totals> = {};
  for (const year of years) {
    const y = yearlyByYear.get(year);
    totalsByYear[year] = {
      deliveries: num0(y?.deliveries),
      sacks: num0(y?.sacks),
      weightKg: num0(y?.volume_kg),
      mc: num(y?.mc),
      grit: num(y?.grit),
      vm: num(y?.vm),
      ash: num(y?.ash),
      fc: num(y?.fc),
      bdAstm: num(y?.bd_astm),
      bdJis: num(y?.bd_jis),
      phpPerKg: showPrices ? num(y?.avg_price) : null,
      phpTotal: showPrices ? num(y?.php_total) : null,
    };
  }

  return { years, byYear, totalsByYear, canViewPrices: showPrices };
}
