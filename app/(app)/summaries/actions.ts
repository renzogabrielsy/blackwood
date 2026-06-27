'use server';

// =====================================================================
// Summaries -> By Supplier — live data layer
// =====================================================================
// Supplier-dimension sibling of the demo-4 Analyst Brief (month-level).
// Mirrors fetchMonthlyDeliveryAnalytics but adds the SUPPLIER axis.
//
// HARD RULES honored here:
//  • All aggregation / weighted averages live in SQL — this module only
//    SHAPES rows. The per-(year, month, supplier) grain comes from
//    view_delivery_supplier_monthly_analytics; each supplier's per-year
//    rollup comes from view_delivery_supplier_yearly_analytics — a TRUE
//    weighted yearly rollup, NOT the monthly averages re-averaged in TS.
//  • Price gating (canViewPrices, lib/auth.ts) is CANONICAL. When the
//    effective role cannot view prices, phpPerKg AND phpTotal are nulled in
//    every monthly row AND in every supplier's totals BEFORE the payload
//    leaves the server, and canViewPrices is returned false.
//  • cost_basis = 0 / NULL is the gsheet UNPRICED placeholder (ledger L-008),
//    already excluded from price aggregates inside the views (but counted in
//    volume) — no special handling needed here.
//  • Supplier text is normalized in SQL (trim; NULL/'' -> 'UNKNOWN').
// =====================================================================

import { createClient } from '@/lib/supabase/server';
import { canViewPrices } from '@/lib/auth';

/** One month slot in a supplier's 12-month axis for a given year.
 *  Lab + price fields are nullable: null = no data / unpriced / price-gated. */
export interface SupplierMonthRow {
  /** 0..11 (Jan..Dec). */
  monthIndex: number;
  /** Row count of this supplier's deliveries that month (0 for empty months). */
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

/** One constituent SUBGROUP under a MAIN supplier group (canonical_supplier()).
 *  E.g. main "ORNALES" -> subgroups ORNALES (direct) + MERCADO / ORNALES + ...
 *  Casing variants collapse into one subgroup; each distinct "/" combo is its own. */
export interface SupplierSubgroup {
  /** Normalized subgroup label = UPPER(TRIM(raw supplier)). */
  label: string;
  weightKg: number;
  sacks: number;
  deliveries: number;
  /** Volume-weighted ₱/kg over PRICED rows; null when no priced rows OR price-gated. */
  phpPerKg: number | null;
}

/** One supplier's full year: a 12-month axis plus a weighted yearly rollup. */
export interface SupplierYearSummary {
  supplier: string;
  /** ALWAYS length 12 (monthIndex 0..11), zero-filled for months with no deliveries. */
  monthly: SupplierMonthRow[];
  /** Constituent subgroups folded into this main group, sorted by weightKg DESC. */
  subgroups: SupplierSubgroup[];
  /** Year rollup — sums for counts/volume/spend; volume-weighted for price + lab. */
  totals: {
    deliveries: number;
    sacks: number;
    weightKg: number;
    phpTotal: number | null;
    mc: number | null;
    grit: number | null;
    vm: number | null;
    ash: number | null;
    fc: number | null;
    bdAstm: number | null;
    bdJis: number | null;
    phpPerKg: number | null;
  };
}

/** Full payload returned to the Summaries -> By Supplier page. */
export interface SupplierAnalytics {
  /** Years that actually have deliveries, ascending. */
  years: number[];
  /** Per-year list of suppliers active that year, SORTED BY totals.weightKg DESC
   *  (so the frontend can pick top-N = first N). */
  byYear: Record<number, SupplierYearSummary[]>;
  /** Whether the caller may see ₱ data. When false, all price fields above are null. */
  canViewPrices: boolean;
}

/** numeric|string|null from the view -> number|null (views may emit numerics as strings). */
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
 * Fetch live supplier-level delivery analytics for Summaries -> By Supplier.
 *
 * Return shape: { years, byYear, canViewPrices }.
 *  - byYear[year] is the list of suppliers active that year, sorted by yearly
 *    volume (weightKg) DESC. The frontend picks top-3 = first 3.
 *  - Each supplier's `monthly` is ALWAYS 12 rows (monthIndex 0..11). Months with
 *    no deliveries are zero-filled (deliveries/sacks/weightKg = 0) with null
 *    lab + price.
 *  - Each supplier's `totals` comes from the yearly view (a TRUE weighted rollup),
 *    not from re-averaging the monthly numbers here.
 *  - When canViewPrices is false, phpPerKg and phpTotal are null everywhere.
 *
 * Throws on query failure — the frontend should surface via errorToast().
 */
export async function fetchSupplierAnalytics(): Promise<SupplierAnalytics> {
  const supabase = await createClient();
  const showPrices = await canViewPrices();

  const [monthlyRes, yearlyRes, subgroupRes] = await Promise.all([
    supabase
      .from('view_delivery_supplier_monthly_analytics')
      .select('*')
      .order('year', { ascending: true })
      .order('month', { ascending: true })
      .order('supplier', { ascending: true }),
    supabase
      .from('view_delivery_supplier_yearly_analytics')
      .select('*')
      .order('year', { ascending: true })
      .order('supplier', { ascending: true }),
    supabase
      .from('view_delivery_supplier_subgroup_yearly_analytics')
      .select('*')
      .order('year', { ascending: true })
      .order('main_supplier', { ascending: true })
      .order('volume_kg', { ascending: false }),
  ]);

  if (monthlyRes.error) {
    throw new Error(`Failed to load supplier monthly analytics: ${monthlyRes.error.message}`);
  }
  if (yearlyRes.error) {
    throw new Error(`Failed to load supplier yearly totals: ${yearlyRes.error.message}`);
  }
  if (subgroupRes.error) {
    throw new Error(`Failed to load supplier subgroup breakdown: ${subgroupRes.error.message}`);
  }

  const monthlyRows = monthlyRes.data ?? [];
  const yearlyRows = yearlyRes.data ?? [];
  const subgroupRows = subgroupRes.data ?? [];

  // Index subgroups: `${year}-${main_supplier}` -> SupplierSubgroup[] (already weightKg DESC from SQL).
  const subgroupsByYearMain = new Map<string, SupplierSubgroup[]>();
  for (const r of subgroupRows) {
    if (r.year == null || r.main_supplier == null || r.subgroup == null) continue;
    const key = `${r.year} ${r.main_supplier}`;
    let list = subgroupsByYearMain.get(key);
    if (!list) {
      list = [];
      subgroupsByYearMain.set(key, list);
    }
    list.push({
      label: r.subgroup as string,
      weightKg: num0(r.volume_kg),
      sacks: num0(r.sacks),
      deliveries: num0(r.deliveries),
      phpPerKg: showPrices ? num(r.avg_price) : null,
    });
  }

  // Years that actually have data, ascending (derived from the yearly rollup).
  const years = Array.from(
    new Set(yearlyRows.map((r) => r.year).filter((y): y is number => y != null)),
  ).sort((a, b) => a - b);

  // Index monthly rows: `${year}-${supplier}` -> monthIndex -> row.
  const monthlyByYearSupplier = new Map<string, Map<number, (typeof monthlyRows)[number]>>();
  for (const r of monthlyRows) {
    if (r.year == null || r.month == null || r.supplier == null) continue;
    const key = `${r.year} ${r.supplier}`;
    let inner = monthlyByYearSupplier.get(key);
    if (!inner) {
      inner = new Map();
      monthlyByYearSupplier.set(key, inner);
    }
    inner.set(r.month - 1, r); // view stores 1..12 -> monthIndex 0..11
  }

  const byYear: Record<number, SupplierYearSummary[]> = {};
  for (const year of years) {
    // Suppliers active this year (from the yearly rollup) -> build a summary each.
    const yearSuppliers = yearlyRows.filter((r) => r.year === year && r.supplier != null);

    const summaries: SupplierYearSummary[] = yearSuppliers.map((y) => {
      const supplier = y.supplier as string;
      const inner = monthlyByYearSupplier.get(`${year} ${supplier}`);

      const monthly: SupplierMonthRow[] = Array.from({ length: 12 }, (_, monthIndex) => {
        const src = inner?.get(monthIndex);
        if (!src) {
          // zero-fill empty month
          return {
            monthIndex,
            deliveries: 0, sacks: 0, weightKg: 0,
            mc: null, grit: null, vm: null, ash: null, fc: null, bdAstm: null, bdJis: null,
            phpPerKg: null, phpTotal: null,
          };
        }
        return {
          monthIndex,
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

      return {
        supplier,
        monthly,
        subgroups: subgroupsByYearMain.get(`${year} ${supplier}`) ?? [],
        totals: {
          deliveries: num0(y.deliveries),
          sacks: num0(y.sacks),
          weightKg: num0(y.volume_kg),
          phpTotal: showPrices ? num(y.php_total) : null,
          mc: num(y.mc),
          grit: num(y.grit),
          vm: num(y.vm),
          ash: num(y.ash),
          fc: num(y.fc),
          bdAstm: num(y.bd_astm),
          bdJis: num(y.bd_jis),
          phpPerKg: showPrices ? num(y.avg_price) : null,
        },
      };
    });

    // Sort suppliers by yearly volume DESC so the frontend can take top-N = first N.
    summaries.sort((a, b) => b.totals.weightKg - a.totals.weightKg);
    byYear[year] = summaries;
  }

  return { years, byYear, canViewPrices: showPrices };
}
