// =====================================================================
// ICTC Owner Analytics — THE SUPPLIER ROOM's pure fold (P3)
// =====================================================================
// One pass over `view_analytics_supplier_monthly`'s rows turns them into
// everything the section renders: the (supplier × month) volume matrix for
// a year, the YTD summary column, the concentration header, the
// premium/discount list and a supplier's own monthly series.
//
// Pure and client-safe — no React, no Supabase, no `server-only`. Same
// discipline as `matrix.ts`: the SQL layer owns every DEFINITION, this
// module only folds published figures across months.
//
// ── THE ONE HARD RULE OF THIS FILE ───────────────────────────────────
// **`premium_php_kg` may only ever be averaged WEIGHTED by priced kilos.**
// The month's market price IS the priced-kg-weighted mean of the supplier
// prices, so weighted, the premiums come to exactly zero every month by
// construction (measured across all 49 months, max |Σ| = 7.1e-17). An
// UNWEIGHTED mean is not a weaker answer, it is a meaningless one that
// looks like a finding: 2026-03's unweighted mean premium is −₱2.5209,
// which is pure artefact of the top two sellers being 75% of the volume.
//
// `weightedPremiumPhpKg` below is the ONLY function in the codebase that
// aggregates that column, and it is the only export that touches it — so
// "does anything average this unweighted?" is one grep, not a review.
//
// ── AND THE ONE RULE ABOUT SUNDRY RETURNS ────────────────────────────
// `sundryOriginKg` is TRACEABILITY and is never added to `kg`, never
// enters share, rank, premium, price or any total that says "bought". A
// supplier whose only movement in a year was returning material still
// gets a row (SEVILLA, 2026: 140,590 kg returned, not one kilo bought) —
// an exclusion can be forgotten by a UI, a row cannot.
// =====================================================================

import type { MetricDictionaryEntry } from "./metrics";
import type { AnalyticsMonth, SupplierMonth } from "./types";

const MONTH_SHORT = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

const MONTH_LONG = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

/** How many rows the matrix shows before the reader has to ask for more. */
export const SUPPLIER_TOP_N = 12;

// ---------------------------------------------------------------------
// THE weighted premium — the one aggregation this column allows
// ---------------------------------------------------------------------

/**
 * Σ(premium × priced kg) ÷ Σ(priced kg) — **the only way this column may be
 * rolled up.** See the file header for why an unweighted mean is not a
 * cruder answer but a wrong one.
 *
 * A part with no premium or no priced kilos contributes to NEITHER side, so
 * a supplier whose month was entirely unpriced cannot drag the figure toward
 * zero. Returns `null` — never 0 — when nothing qualifies: "we do not know"
 * and "exactly at market" are different answers, exactly as the SQL column
 * itself distinguishes them.
 */
export function weightedPremiumPhpKg(
  parts: readonly { premiumPhpKg: number | null; pricedKg: number | null }[],
): number | null {
  let numerator = 0;
  let denominator = 0;
  for (const p of parts) {
    if (p.premiumPhpKg == null) continue;
    if (p.pricedKg == null || p.pricedKg <= 0) continue;
    numerator += p.premiumPhpKg * p.pricedKg;
    denominator += p.pricedKg;
  }
  return denominator > 0 ? numerator / denominator : null;
}

// ---------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------

/** One (supplier × month) cell of the volume matrix. */
export interface SupplierCell {
  /** yyyy-MM-01 — the cell's identity. */
  monthStart: string;
  /** 1..12 */
  month: number;
  /** `Mar 2026` — the hover's period name. */
  fullLabel: string;
  /** Kilos BOUGHT. `null` (never 0) on a returns-only month. */
  kg: number | null;
  /** % of the month's market kilos. `null` when `kg` is. */
  sharePct: number | null;
  /** 1 = biggest seller that month. `null` when `kg` is. */
  rank: number | null;
  deliveryCount: number | null;
  pricedKg: number | null;
  coveragePct: number | null;
  /** ₱ GATED. */
  avgPrice: number | null;
  /**
   * ₱ GATED — Σ pesos on their priced kilos that month.
   *
   * Carried since owner feedback R4 so the expand's month checklist can re-fold
   * a price over a SUBSET of months as Σ pesos ÷ Σ priced kilos. Reconstructing
   * it as `avgPrice × pricedKg` would have been almost right and quietly
   * lossy — the published total is what the year row already sums, so a
   * selection folds through the same numbers rather than through a rounding of
   * them.
   */
  phpTotal: number | null;
  /** ₱ GATED. Weighted rollups ONLY — see `weightedPremiumPhpKg`. */
  premium: number | null;
  /** ₱ GATED — the month's own market price, the premium's baseline. */
  monthPrice: number | null;
  /** TRACEABILITY. Never added to `kg`. */
  sundryKg: number | null;
  sundryDeliveryCount: number | null;
}

/** One supplier's whole year — the matrix row plus its YTD summary column. */
export interface SupplierRow {
  supplier: string;
  /** Twelve slots, Jan..Dec. `null` = this supplier did nothing that month. */
  cells: readonly (SupplierCell | null)[];

  /** YTD kilos BOUGHT — a plain sum, the only rollup a volume allows. */
  kg: number;
  /** YTD share of the year's market kilos. Weighted by construction (Σ ÷ Σ). */
  sharePct: number | null;
  /** Running share down the ranking — the top-3 answer without re-adding. */
  cumulativeSharePct: number | null;
  deliveries: number;
  pricedKg: number;
  /** PERCENT 0-100. */
  coveragePct: number | null;
  /** ₱ GATED — Σ pesos, the weighted price's numerator. */
  phpTotal: number | null;
  /** ₱ GATED — Σ pesos ÷ Σ priced kilos. NEVER a mean of the monthly prices. */
  avgPrice: number | null;
  /** ₱ GATED — **weighted** premium vs market for the year. */
  premium: number | null;
  /** TRACEABILITY. Never in `kg`, never in `sharePct`. */
  sundryKg: number;
  sundryDeliveries: number;
  /** Months in which they actually sold something. */
  activeMonths: number;
  /** 1-based rank by YTD kilos. `null` on a returns-only row — it bought nothing. */
  rank: number | null;
  /** They bought nothing this year; only their sun-drying material moved. */
  returnsOnly: boolean;
}

/** One column of the matrix — a month of the selected year. */
export interface SupplierMonthColumn {
  monthStart: string;
  month: number;
  /** `Mar` */
  label: string;
  /** `March 2026` */
  fullLabel: string;
  /**
   * The month's market kilos as **P1 publishes them**, carried on every
   * supplier row by the view's own join. The footer prints THIS rather than
   * a sum of the column, so the `Σ market` line is literally the monthly
   * matrix's Purchase volume figure and cannot drift from it.
   */
  marketKg: number | null;
  /** ₱ GATED — the month's market price. */
  marketPrice: number | null;
  /** Suppliers who actually sold that month (rows with kilos). */
  supplierCount: number;
  /** Returning sun-dried material booked that month, across all origins. */
  sundryKg: number;
}

/** The dependency-risk header. Magnitude only — no judgement, no colour. */
export interface SupplierConcentration {
  /** Distinct suppliers who SOLD in the year (returns-only names excluded). */
  supplierCount: number;
  /** % of the year's kilos from the single biggest seller. */
  top1Pct: number | null;
  top1Name: string | null;
  /** % from the three biggest. */
  top3Pct: number | null;
  top3Names: readonly string[];
  /** How many sellers it takes to reach half the year's kilos. */
  suppliersToHalf: number | null;
}

/** Everything the supplier room renders for one year. */
export interface SupplierYear {
  year: number;
  /** Only months that actually have a supplier row — no empty columns. */
  months: readonly SupplierMonthColumn[];
  /** Ranked by YTD kilos, DESC; returns-only rows appended last. */
  rows: readonly SupplierRow[];
  /** Σ of the months' P1-published market kilos. The footer's YTD cell. */
  totalKg: number;
  totalPricedKg: number;
  /** ₱ GATED. */
  totalPhpTotal: number | null;
  /** ₱ GATED — Σ pesos ÷ Σ priced kilos across the year. */
  totalAvgPrice: number | null;
  totalSundryKg: number;
  totalDeliveries: number;
  concentration: SupplierConcentration;
}

/** One point of the price × volume × participation explorer. */
export interface ExplorerPoint {
  monthStart: string;
  /** `Mar` */
  label: string;
  /** `March 2026` */
  fullLabel: string;
  /** Market purchase volume, TONNES. */
  tonnes: number | null;
  /** ₱/kg market price. GATED — null for a price-denied role. */
  price: number | null;
  /** Distinct market sellers — P1's own `active_suppliers`. */
  suppliers: number | null;
  /** The month has not finished, so its figures are still moving. */
  isPartial: boolean;
}

// ---------------------------------------------------------------------
// The fold
// ---------------------------------------------------------------------

function sum(values: readonly (number | null)[]): number {
  let total = 0;
  for (const v of values) if (v != null) total += v;
  return total;
}

/**
 * Build one year of the supplier room.
 *
 * Columns come from the months that HAVE a supplier row, ascending — a month
 * in which nothing was bought has no sellers to show, and twelve columns with
 * four blanks in them would say a plant that had not reached December yet had
 * bought from nobody in it.
 */
export function buildSupplierYear(
  rows: readonly SupplierMonth[],
  year: number,
): SupplierYear {
  const inYear = rows.filter((r) => r.year === year);

  // ── Columns ──────────────────────────────────────────────────────
  const byMonth = new Map<string, SupplierMonth[]>();
  for (const r of inYear) {
    const list = byMonth.get(r.monthStart);
    if (list) list.push(r);
    else byMonth.set(r.monthStart, [r]);
  }

  const months: SupplierMonthColumn[] = [...byMonth.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([monthStart, list]) => {
      const anchor = list[0];
      return {
        monthStart,
        month: anchor.month,
        label: MONTH_SHORT[anchor.month - 1] ?? monthStart.slice(5, 7),
        fullLabel: `${MONTH_LONG[anchor.month - 1] ?? monthStart.slice(0, 7)} ${year}`,
        // P1's own published figure, identical on every row of the month.
        marketKg: anchor.monthMarketKg,
        marketPrice: anchor.monthAvgPricePhpKg,
        supplierCount: list.filter((r) => (r.kg ?? 0) > 0).length,
        sundryKg: sum(list.map((r) => r.sundryOriginKg)),
      };
    });

  const monthIndex = new Map(months.map((m, i) => [m.monthStart, i] as const));

  // ── Rows ─────────────────────────────────────────────────────────
  const bySupplier = new Map<string, SupplierMonth[]>();
  for (const r of inYear) {
    const list = bySupplier.get(r.supplier);
    if (list) list.push(r);
    else bySupplier.set(r.supplier, [r]);
  }

  // The denominator of every YTD share: the year's market kilos as P1
  // publishes them, month by month. NOT a sum of the supplier rows — the two
  // are equal by proof (0 mismatches / 49 months, max gap 0.00 kg) and using
  // the published one means the header, the footer and the monthly matrix are
  // literally the same number rather than three that happen to agree.
  const totalKg = sum(months.map((m) => m.marketKg));

  const built: SupplierRow[] = [...bySupplier.entries()].map(
    ([supplier, list]) => {
      const cells: (SupplierCell | null)[] = Array(months.length).fill(null);
      for (const r of list) {
        const i = monthIndex.get(r.monthStart);
        if (i == null) continue;
        const hasKg = (r.kg ?? 0) > 0;
        cells[i] = {
          monthStart: r.monthStart,
          month: r.month,
          fullLabel: `${MONTH_SHORT[r.month - 1] ?? r.monthStart.slice(5, 7)} ${r.year}`,
          // A zero here is the view's "no purchase this month" on a
          // sundry-only row, not a truckload weighing nothing.
          kg: hasKg ? r.kg : null,
          sharePct: hasKg ? r.shareOfMonthPct : null,
          rank: hasKg ? r.kgRankInMonth : null,
          deliveryCount: hasKg ? r.deliveryCount : null,
          pricedKg: hasKg ? r.pricedKg : null,
          coveragePct: hasKg ? r.priceCoveragePct : null,
          avgPrice: r.avgPricePhpKg,
          phpTotal: r.phpTotal,
          premium: r.premiumPhpKg,
          monthPrice: r.monthAvgPricePhpKg,
          sundryKg: (r.sundryOriginKg ?? 0) > 0 ? r.sundryOriginKg : null,
          sundryDeliveryCount: r.sundryOriginDeliveryCount,
        };
      }

      const kg = sum(list.map((r) => r.kg));
      const pricedKg = sum(list.map((r) => r.pricedKg));
      const phpParts = list.map((r) => r.phpTotal).filter((v) => v != null);
      const phpTotal = phpParts.length > 0 ? sum(phpParts) : null;

      return {
        supplier,
        cells,
        kg,
        sharePct: totalKg > 0 && kg > 0 ? (100 * kg) / totalKg : null,
        // Filled in below, once the rows are ranked.
        cumulativeSharePct: null,
        deliveries: sum(list.map((r) => r.deliveryCount)),
        pricedKg,
        coveragePct: kg > 0 ? (100 * pricedKg) / kg : null,
        phpTotal,
        // Σ pesos ÷ Σ priced kilos. Never the mean of the monthly prices —
        // the same rule the market-price row of the monthly matrix obeys.
        avgPrice: phpTotal != null && pricedKg > 0 ? phpTotal / pricedKg : null,
        // THE weighted premium. See this file's header.
        premium: weightedPremiumPhpKg(list),
        sundryKg: sum(list.map((r) => r.sundryOriginKg)),
        sundryDeliveries: sum(list.map((r) => r.sundryOriginDeliveryCount)),
        activeMonths: list.filter((r) => (r.kg ?? 0) > 0).length,
        rank: null,
        returnsOnly: kg <= 0,
      };
    },
  );

  // Sellers first, biggest first; returns-only names appended in kilo order
  // of what came BACK, so the SEVILLA case is always on screen rather than
  // hidden behind a "show all" nobody clicks.
  const sellers = built
    .filter((r) => !r.returnsOnly)
    .sort((a, b) => b.kg - a.kg || a.supplier.localeCompare(b.supplier));
  const returnsOnly = built
    .filter((r) => r.returnsOnly)
    .sort((a, b) => b.sundryKg - a.sundryKg || a.supplier.localeCompare(b.supplier));

  let running = 0;
  sellers.forEach((r, i) => {
    r.rank = i + 1;
    running += r.kg;
    r.cumulativeSharePct = totalKg > 0 ? (100 * running) / totalKg : null;
  });

  const top3Kg = sellers.slice(0, 3).reduce((acc, r) => acc + r.kg, 0);
  let half: number | null = null;
  let acc = 0;
  for (const [i, r] of sellers.entries()) {
    acc += r.kg;
    if (totalKg > 0 && acc >= totalKg / 2) {
      half = i + 1;
      break;
    }
  }

  const totalPricedKg = sum(inYear.map((r) => r.pricedKg));
  const totalPhpParts = inYear.map((r) => r.phpTotal).filter((v) => v != null);
  const totalPhpTotal = totalPhpParts.length > 0 ? sum(totalPhpParts) : null;

  return {
    year,
    months,
    rows: [...sellers, ...returnsOnly],
    totalKg,
    totalPricedKg,
    totalPhpTotal,
    totalAvgPrice:
      totalPhpTotal != null && totalPricedKg > 0
        ? totalPhpTotal / totalPricedKg
        : null,
    totalSundryKg: sum(months.map((m) => m.sundryKg)),
    totalDeliveries: sum(inYear.map((r) => r.deliveryCount)),
    concentration: {
      supplierCount: sellers.length,
      top1Pct: sellers[0]?.sharePct ?? null,
      top1Name: sellers[0]?.supplier ?? null,
      top3Pct: totalKg > 0 && sellers.length > 0 ? (100 * top3Kg) / totalKg : null,
      top3Names: sellers.slice(0, 3).map((r) => r.supplier),
      suppliersToHalf: half,
    },
  };
}

/**
 * ONE supplier's figures over an arbitrary SUBSET of the year's months —
 * owner feedback R4's universal module contract.
 *
 * Every expand on the page now carries a period checklist, and a checklist
 * that filtered only the chart while the stat strip above it kept describing
 * the whole year would be the exact dishonesty the KPI expand's `foldSelection`
 * was built to avoid: "Highest over three chosen years" is a different claim
 * from "Highest on record", and so is "₱/kg paid" over four chosen months.
 *
 * **Every rule the year row obeys is obeyed here, because it is the same
 * arithmetic over a shorter list.** The price is Σ pesos ÷ Σ priced kilos and
 * never the mean of the monthly prices; the premium goes through
 * `weightedPremiumPhpKg`, the only function allowed to touch that column; the
 * share's denominator is the P1-published market kilos of the SELECTED months,
 * so a four-month share is a share of those four months rather than of the
 * year. And `sundryOriginKg` stays out of all of it.
 */
export interface SupplierSelection {
  /** How many of the year's month columns are switched on. */
  monthCount: number;
  /** Of those, how many the supplier actually did something in. */
  activeMonths: number;
  kg: number;
  deliveries: number;
  pricedKg: number;
  /** PERCENT 0-100. */
  coveragePct: number | null;
  /** ₱ GATED — Σ pesos ÷ Σ priced kilos over the selection. */
  avgPrice: number | null;
  /** ₱ GATED — weighted by priced kilos, the only aggregation allowed. */
  premium: number | null;
  /** Their kilos ÷ the SELECTED months' market kilos. */
  sharePct: number | null;
  /** TRACEABILITY. Never in `kg`, never in `sharePct`. */
  sundryKg: number;
  sundryDeliveries: number;
}

export function foldSupplierSelection(
  row: SupplierRow,
  months: readonly SupplierMonthColumn[],
  hidden: ReadonlySet<string>,
): SupplierSelection {
  let kg = 0;
  let deliveries = 0;
  let pricedKg = 0;
  let phpTotal = 0;
  let hasPhp = false;
  let sundryKg = 0;
  let sundryDeliveries = 0;
  let activeMonths = 0;
  let monthCount = 0;
  let marketKg = 0;
  const premiumParts: { premiumPhpKg: number | null; pricedKg: number | null }[] =
    [];

  months.forEach((m, i) => {
    if (hidden.has(m.monthStart)) return;
    monthCount += 1;
    marketKg += m.marketKg ?? 0;
    const cell = row.cells[i];
    if (!cell) return;
    if (cell.kg != null && cell.kg > 0) {
      kg += cell.kg;
      activeMonths += 1;
    }
    deliveries += cell.deliveryCount ?? 0;
    pricedKg += cell.pricedKg ?? 0;
    if (cell.phpTotal != null) {
      phpTotal += cell.phpTotal;
      hasPhp = true;
    }
    sundryKg += cell.sundryKg ?? 0;
    sundryDeliveries += cell.sundryDeliveryCount ?? 0;
    premiumParts.push({ premiumPhpKg: cell.premium, pricedKg: cell.pricedKg });
  });

  return {
    monthCount,
    activeMonths,
    kg,
    deliveries,
    pricedKg,
    coveragePct: kg > 0 ? (100 * pricedKg) / kg : null,
    avgPrice: hasPhp && pricedKg > 0 ? phpTotal / pricedKg : null,
    premium: weightedPremiumPhpKg(premiumParts),
    sharePct: marketKg > 0 && kg > 0 ? (100 * kg) / marketKg : null,
    sundryKg,
    sundryDeliveries,
  };
}

/**
 * The three-line story — price × volume × participation, for one year.
 *
 * Built from `AnalyticsMonth`, which is **P1's own monthly view already in the
 * payload**: no second read, and no second definition of a month's price,
 * volume or seller count. The supplier matrix above and this chart therefore
 * cannot disagree, because the matrix's column totals are the very same
 * published figures.
 */
export function buildExplorer(
  months: readonly AnalyticsMonth[],
  year: number,
): ExplorerPoint[] {
  return months
    .filter((m) => m.year === year)
    .map((m) => ({
      monthStart: m.monthStart,
      label: MONTH_SHORT[m.month - 1] ?? m.monthStart.slice(5, 7),
      fullLabel: `${MONTH_LONG[m.month - 1] ?? m.monthStart.slice(0, 7)} ${m.year}`,
      tonnes: m.marketKg == null ? null : m.marketKg / 1000,
      price: m.marketAvgPrice,
      suppliers: m.activeSuppliers,
      isPartial: m.isPartialMonth,
    }));
}

// ---------------------------------------------------------------------
// The dictionary — same shape and same discipline as `METRICS[].dictionary`
// ---------------------------------------------------------------------

/** The figures the supplier room introduces, each with an Info button. */
export type SupplierFigureKey =
  | "supplier_volume"
  | "share_of_month"
  | "concentration"
  | "premium"
  | "sundry_returns"
  | "explorer";

export interface SupplierFigure {
  label: string;
  sublabel: string;
  dictionary: MetricDictionaryEntry;
}

/**
 * Derived from `view_analytics_supplier_monthly`'s own COMMENT in migration
 * `20260901133909_analytics_phase3_supplier_layer.sql`, exactly as the P1/P2
 * entries were derived from theirs. Written ONCE here so the matrix, the
 * premium panel and the row expand can never describe the same number two
 * different ways.
 */
export const SUPPLIER_DICTIONARY: Record<SupplierFigureKey, SupplierFigure> = {
  supplier_volume: {
    label: "Supplier volume",
    sublabel: "tonnes bought",
    dictionary: {
      definition: "How much charcoal one supplier sold us in a month, and across the year.",
      basis:
        "Their market deliveries, added up. A supplier is the canonical name, so every spelling of one seller counts once.",
      exclusions:
        "Sun-dried returns and re-cooks. We already paid for those kilos once; they ride separately as a returns figure.",
      rollup: "The year column is a plain sum of the months.",
      source: "view_analytics_supplier_monthly.kg",
      caveat:
        "The Σ market row is the KPI matrix's own Purchase volume figure, not a sum of the rows above it, so the two cannot disagree.",
    },
  },
  share_of_month: {
    label: "Share of the month",
    sublabel: "% of everything bought",
    dictionary: {
      definition:
        "What proportion of everything bought that month came from this one supplier.",
      basis:
        "Their kilos ÷ the month's total market kilos, with the denominator read from the monthly view rather than re-added here.",
      exclusions:
        "Sun-dried returns are in neither half, so a supplier whose material merely came back cannot claim a share.",
      rollup:
        "The year share is the year's kilos over the year's market kilos, never the average of twelve monthly percentages.",
      source: "view_analytics_supplier_monthly.share_of_month_pct",
    },
  },
  concentration: {
    label: "Concentration",
    sublabel: "top-1 / top-3 share",
    dictionary: {
      definition:
        "How much of our supply comes from the biggest one, and the biggest three, sellers.",
      basis:
        "The year's kilos from the top seller (and from the top three together) over the year's total market kilos.",
      exclusions:
        "A supplier who bought nothing in the year is not counted as a seller, however much of their material came back from drying.",
      rollup: "Ranked by kilos over the whole year, not by averaging monthly rankings.",
      source:
        "view_analytics_supplier_monthly.kg_rank_in_month / cumulative_share_pct",
      caveat:
        "A magnitude, not a verdict. Nothing here turns amber because a share is high.",
    },
  },
  premium: {
    label: "Premium / discount",
    sublabel: "₱/kg vs the market",
    dictionary: {
      definition:
        "Whether we paid a supplier above or below the going rate that month. Positive means above market.",
      basis:
        "Their weighted price minus the month's own market price. Both sides count only truckloads that already carry a price.",
      exclusions:
        "A truckload still awaiting its price is in neither average. The figure is blank, never zero, when a side has no priced kilos — \u201Cwe do not know yet\u201D is not \u201Cexactly at market\u201D.",
      rollup:
        "Always weighted by priced kilos. Weighted that way it comes to zero every month by construction, because the market price IS the kilo-weighted average of the supplier prices. There is no unweighted average anywhere on this page.",
      source: "view_analytics_supplier_monthly.premium_php_kg",
      // ₱-FREE ON PURPOSE. This card renders for every role, including the
      // one the server withholds prices from, so a worked example with a real
      // peso figure in it would be a price leak dressed as documentation.
      caveat:
        "The big sellers sit near market by construction — once the top two are three quarters of the volume they largely ARE the average. The spread lives at the bottom of the book. And every row is measured against the months that supplier sold in, never the whole year.",
    },
  },
  sundry_returns: {
    label: "Returned from sundry",
    sublabel: "tonnes, traceability only",
    dictionary: {
      definition:
        "Our OWN charcoal coming back after sun-drying, carrying this supplier's name. The name says where it came from originally, not that anyone sold it to us again.",
      basis:
        "Sundry-class deliveries, with the batch suffix stripped and the name folded through the same canonical rule.",
      exclusions:
        "It is out of the supplier's kilos, share, rank, price and premium — every other figure on the row. Counting it twice would inflate the tonnage and drag the price toward the recovery price.",
      rollup: "A plain sum, and it never joins the purchase totals.",
      source: "view_analytics_supplier_monthly.sundry_origin_kg",
      caveat:
        "A supplier can appear with nothing bought in a year where only their returning material moved — SEVILLA in 2026, 140.6 t back and no sale. Those rows are always shown.",
    },
  },
  explorer: {
    label: "Price, volume & participation",
    sublabel: "the three-line story",
    dictionary: {
      definition:
        "What charcoal cost, how much we bought, and how many different sellers turned up — the three, together.",
      basis: "All three lines are the monthly view's own published figures for the year.",
      // ₱-FREE ON PURPOSE — see the premium entry's note above.
      exclusions:
        "Sun-dried returns and re-cooks are out of all three. Counting them made April 2026 read 7 sellers when only 4 sold us anything.",
      rollup: "None. Every point is one month, exactly as published.",
      source: "view_analytics_rcin_monthly",
      caveat:
        "An observation, never a cause. The dear months of early 2026 drew about three times the sellers the cheap summer did; the chart cannot tell you which way that runs.",
    },
  },
};
