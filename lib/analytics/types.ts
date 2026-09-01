// =====================================================================
// ICTC Owner Analytics — the data contract (`/analytics`, Phase 1)
// =====================================================================
// Plain shapes only. No React, no Supabase, no `server-only` — this module
// is imported by the server adapter (`queries.ts`), by the pure fold
// (`matrix.ts`) and by client components, so it must stay portable.
//
// The contract is a MONTHLY SERIES plus one LIVE snapshot, because that is
// exactly what the SQL layer owns:
//
//   • `view_analytics_rcin_monthly`   — what we BOUGHT (market class only)
//   • `view_analytics_flow_monthly`   — in / out / net + the working day
//   • `view_analytics_inventory_eom`  — as-of month-end stock, value, runway
//   • `view_blocking_grid`            — LIVE block occupancy (see below)
//
// All aggregation across months (quarters, years, per-working-day) happens
// in `matrix.ts` as a documented ROLLUP RULE per metric — never as an
// average of averages, and never as a second definition of a number the
// views already own.
// =====================================================================

/**
 * One calendar month of the analytics spine.
 *
 * The spine is `view_analytics_flow_monthly` — EVERY month from the first
 * recorded event to the current Asia/Manila month, zero-filled. The other
 * two views hang off it, so a month with no delivery still has a row here
 * and its purchase fields read `null` (nothing arrived) rather than 0.
 *
 * **`null` is never 0 in this shape.** A null means "no figure exists" —
 * no delivery that month, no price the viewer may see, or a figure the
 * data layer says is not answerable (see `outflowRecorded`).
 */
export interface AnalyticsMonth {
  /** yyyy-MM-01 — the month's first day, the natural key of the row. */
  monthStart: string;
  year: number;
  /** 1..12 */
  month: number;
  /** The last day this month's figures speak for — month-end, or today. */
  asOfDate: string | null;
  /** The month has not finished yet, so every total on it is in progress. */
  isPartialMonth: boolean;

  // ── RC IN — the MARKET read (view_analytics_rcin_monthly) ──────────
  /** Kilos actually BOUGHT (market class: sundry re-entry + re-cooks excluded). */
  marketKg: number | null;
  /** The share of `marketKg` that carries a price — the weighted average's denominator. */
  marketPricedKg: number | null;
  /** ₱ — weighted ₱/kg over priced market kilos. GATED: null for a price-denied role. */
  marketAvgPrice: number | null;
  /** ₱ — total pesos spent on priced market kilos. GATED. The rollup NUMERATOR. */
  marketPhpTotal: number | null;
  /** Distinct suppliers (canonicalised) who sold to us that month. */
  activeSuppliers: number | null;
  /** Our own charcoal coming back after sun-drying — recovery, never a purchase. */
  sundryReentryKg: number | null;
  /** Material re-entering after re-cooking / re-feeding. Its ₱ is a processing fee. */
  recookKg: number | null;
  /** Market deliveries booked that month. */
  marketDeliveryCount: number | null;
  /** What share of the month's market kilos the price speaks for. 100 today, everywhere. */
  priceCoveragePct: number | null;

  // ── FLOW (view_analytics_flow_monthly) ─────────────────────────────
  /** EVERYTHING that physically arrived — market + sundry + re-cook. */
  inKg: number;
  /** Everything fed to the plant. `null` before feedings were recorded. */
  outKg: number | null;
  /** in − out. `null` when `outKg` is. */
  netKg: number | null;
  /** Days the site actually did something — the ONE working-day definition. */
  workingDays: number;
  /** `outKg / workingDays`. `null` when `outKg` is. */
  outPerWorkingDay: number | null;
  deliveryCount: number;
  feedingCount: number;

  // ── INVENTORY, as of month-end (view_analytics_inventory_eom) ──────
  /** NET stock: everything in minus everything out. Read with the split below. */
  endingKg: number | null;
  /** The positive half of `endingKg` — what `endingValuePhp` is priced against. */
  positiveBalanceKg: number | null;
  /** The negative half — misattributed kilos, NOT evaporation. See the UI caveat. */
  negativeBalanceKg: number | null;
  negativeBatchCount: number | null;
  /** Piles holding more than 500 kg. */
  activeBatches: number | null;
  /** `endingKg / outPerWorkingDay` — working days of feed on hand. `null` when un-answerable. */
  runwayDays: number | null;
  /** ₱ — avg-cost basis over POSITIVE balances only. GATED. */
  endingValuePhp: number | null;
  /** ₱ — `endingValuePhp / valuedKg`. GATED. */
  avgUnitCostPhpKg: number | null;
  /** What share of the stock the peso figure covers. */
  valueCoveragePct: number | null;
  /**
   * Were feedings being recorded by this month-end?
   *
   * Deliveries begin 2020-07; `rc_out` begins 2024-01. For a month where this
   * is false the adapter NULLS `outKg` / `netKg` / `runwayDays` rather than
   * letting a structural zero flow downstream — a zero would sum into a
   * quarter and a year as if the plant had fed nothing, which is a lie the
   * rollups could not see. The flag rides so the UI can say why the cell is
   * blank.
   */
  outflowRecorded: boolean;
}

/**
 * LIVE block occupancy — deliberately NOT part of the monthly series.
 *
 * `batches.location_ref` describes where a batch is NOW and is cleared and
 * reused, so there is no as-of block map and historical utilization is not
 * reconstructable (the migration says so in `view_analytics_inventory_eom`'s
 * comment). The page therefore shows this beside the matrix, labelled
 * "today", and never as a matrix ROW.
 */
export interface BlockUtilization {
  /** Distinct standard-warehouse (A–D) slots holding a batch right now. */
  occupied: number;
  /** The operator's mental baseline — A/B/C/D only; PCA/PCB are opt-in. */
  total: number;
}

/** Everything `/analytics` renders, in one payload. */
export interface AnalyticsData {
  /** ALL history, ascending by `monthStart`. The complete flow spine. */
  months: AnalyticsMonth[];
  /** Every year present in the spine, DESCENDING (newest first — the picker's order). */
  years: number[];
  /** The year the page opens on — the newest year in the spine. */
  defaultYear: number;
  /**
   * Did the server send ₱ figures? False for the Production role, which gets
   * `null` in every gated field — the values never cross the wire.
   */
  canViewPrices: boolean;
  /** LIVE, never historical. Null when the blocking view could not be read. */
  utilization: BlockUtilization | null;
  /** The newest month's as-of date — what the page footer stamps. */
  asOfDate: string | null;
}
