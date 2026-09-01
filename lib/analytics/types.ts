// =====================================================================
// ICTC Owner Analytics — the data contract (`/analytics`, Phases 1 + 2)
// =====================================================================
// Plain shapes only. No React, no Supabase, no `server-only` — this module
// is imported by the server adapter (`queries.ts`), by the pure fold
// (`matrix.ts`) and by client components, so it must stay portable.
//
// The contract is a MONTHLY SERIES plus three snapshots, because that is
// exactly what the SQL layer owns:
//
//   • `view_analytics_rcin_monthly`   — what we BOUGHT (market class only)
//   • `view_analytics_flow_monthly`   — in / out / net + the working day
//   • `view_analytics_inventory_eom`  — as-of month-end stock, value, runway
//   • `view_analytics_cost_monthly`   — P2: what the charcoal we FED cost
//   • `view_analytics_aging_eom`      — P2: how old the open stock was
//   • `view_analytics_batch_cost`     — P2: the PRODUCTION-BATCH basis
//   • `view_analytics_aging_watchlist`— P2: LIVE "go and look at these"
//   • `view_blocking_grid`            — LIVE block occupancy (see below)
//
// All aggregation across months (quarters, years, per-working-day) happens
// in `matrix.ts` as a documented ROLLUP RULE per metric — never as an
// average of averages, and never as a second definition of a number the
// views already own.
//
// ── TWO UNIT CONVENTIONS, INHERITED FROM SQL AND NOT RE-BASED ────────
// `yieldPct`, `closedBlocksLossPct` and `lossPct` are **FRACTIONS**
// (0.0454 = 4.54%), matching `view_rc_movement_campaign_yield.yield_pct`.
// `fedPriceCoveragePct`, `pctOver60d` and `pctOver120d` are **PERCENTS
// 0-100**. The registry multiplies the fractions by 100 for display; the
// contract keeps them exactly as the view publishes them so a reader of
// this file and a reader of the migration see the same number.
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

  // ── THE MONEY LAYER, calendar basis (view_analytics_cost_monthly) ───
  //
  // Everything down to `productionRecorded` is nulled by the adapter for a
  // month where `outflowRecorded` is false — feeding is the denominator of
  // every one of them, so a structural zero would be a lie the rollups
  // could not see (the same nulling `outKg` gets, for the same reason).

  /** Kilos fed, as `view_rc_movement_month_price` publishes them. */
  fedKg: number | null;
  /** ₱ — weighted ARRIVAL cost of the kilos fed. GATED. **Understated when coverage < 100.** */
  deliveredPhpKgFed: number | null;
  /** ₱ — the same money over only the kilos a price can speak for. GATED. The honest partial. */
  deliveredPhpKgFedCovered: number | null;
  /** ₱ — `deliveredPhpKgFed × fedKg`, the month's charcoal bill. GATED. */
  fedValuePhp: number | null;
  /** Kilos fed out of batches that HAVE delivery rows — the price's real denominator. */
  fedKgPriceTraceable: number | null;
  /** The rest: pre-system stock and the L-042 phantom codes. Kilos with no price at all. */
  fedKgPriceUntraceable: number | null;
  /**
   * PERCENT 0-100. What share of the month's fed kilos the published price
   * speaks for. 100 on every month but seven; 2026-08 reads 97.33.
   * **Below 100 the published price is UNDERSTATED** and the UI shows the
   * `_covered` figure instead, marked as an estimate.
   */
  fedPriceCoveragePct: number | null;

  /** Finished product out the other end. Null before production was reported. */
  producedKg: number | null;
  /** FRACTION — produced ÷ fed. Null before production was reported. */
  yieldPct: number | null;
  /** Fed minus produced, in kg. */
  processLossKg: number | null;
  /** ₱ — the month's bill ÷ its produced kilos. GATED. **NULL unless coverage is 100.** */
  phpPerProducedKg: number | null;
  /** ₱ — the same over covered kilos only. GATED. Always available; an ESTIMATE below 100% coverage. */
  phpPerProducedKgCovered: number | null;
  /**
   * Was production being reported by this month?
   *
   * Feedings begin 2024-01; `production_runs` begins 2025-11. The view
   * publishes `produced_kg = 0` and `yield_pct = 0` for every month before
   * that, which is a STRUCTURAL zero of exactly the `outKg` kind — a 0%
   * yield would roll into a quarter as if the plant had turned 8,000 tonnes
   * of charcoal into nothing. The adapter nulls `producedKg` / `yieldPct` /
   * `processLossKg` and both ₱-per-produced figures when this is false.
   */
  productionRecorded: boolean;

  /** Blocks whose LAST FEEDING fell in this month — the undated-close approximation. */
  closedBlocksCount: number | null;
  /** Of those, the ones every truckload of which carries a price. */
  closedBlocksInPrice: number | null;
  /** Closed with deliveries but at least one still awaiting a price. */
  closedBlocksUnpriced: number | null;
  /** Closed with NO delivery rows at all — nothing to value. */
  closedBlocksNoDelivery: number | null;
  closedBlocksDeliveredKg: number | null;
  closedBlocksFedKg: number | null;
  closedBlocksLostKg: number | null;
  /** FRACTION. **Can be slightly NEGATIVE** (2026-02 = −0.001022) and is never clamped. */
  closedBlocksLossPct: number | null;
  /** ₱ — money ÷ FED kilos over fully-priced closed blocks. GATED. NULL, never 0. */
  closedBlocksTruePhpKg: number | null;
  /** ₱ — the SAME blocks at their arrival price. GATED. The comparison line. */
  closedBlocksDeliveredPhpKg: number | null;
  /** ₱ — true − delivered. Literally the cost of letting charcoal sit. GATED. */
  closedBlocksUpliftPhpKg: number | null;
  /** The fed kilos the two ₱ figures above are measured over. */
  closedBlocksPricedFedKg: number | null;

  // ── AGING, as of month-end (view_analytics_aging_eom) ───────────────
  // ₱-FREE by construction — safe for every role including Production, so
  // nothing below is gated and nothing below depends on `outflowRecorded`.

  /** Stock in blocks NOT YET CLOSED at that month-end. Closed residue is excluded. */
  openKg: number | null;
  openBatches: number | null;
  /** Weight-weighted mean age of a kilo in the yard. Balance-weighted, never FIFO. */
  wtdAgeDays: number | null;
  kgOver60d: number | null;
  kgOver120d: number | null;
  batchesOver120d: number | null;
  /** PERCENT 0-100. */
  pctOver60d: number | null;
  /** PERCENT 0-100. The number that matters — old charcoal keeps losing weight. */
  pctOver120d: number | null;
  oldestAgeDays: number | null;
  /** The resiko: what closed blocks still carry on the books. LOSS, not stock. */
  closedResidueKg: number | null;
  closedResidueBatches: number | null;
}

/**
 * ONE production campaign — the BATCH basis (`view_analytics_batch_cost`).
 *
 * Deliberately NOT a field of `AnalyticsMonth`: a campaign routinely spans a
 * month boundary (AUGUST closed and SEPTEMBER opened on 2026-08-29), so it is
 * a different AXIS, not another column of the same one. Renzo's decision 2 of
 * 2026-09-01 is that BOTH bases are shown, side by side and labelled.
 */
export interface CampaignCost {
  /** `AUGUST` — the production batch name as the plant writes it. */
  productionBatch: string;
  campaignYear: number;
  /** `AUGUST 2026` — the column header. */
  campaignLabel: string;
  firstFedDate: string | null;
  lastFedDate: string | null;
  feedDays: number | null;

  fedKg: number | null;
  /** ₱ — arrival cost of what this campaign fed. GATED. */
  deliveredPhpKgFed: number | null;
  /** ₱ GATED. */
  fedValuePhp: number | null;
  fedKgPriceTraceable: number | null;
  fedKgPriceUntraceable: number | null;
  /** PERCENT 0-100. */
  fedPriceCoveragePct: number | null;

  /** ₱ — whole-block delivered price of the blocks this campaign drew from. GATED. */
  deliveredPhpKg: number | null;
  /** ₱ — whole-block true price (block value ÷ block all-time fed kg). GATED. */
  actualFedPhpKg: number | null;
  /**
   * ₱ — the TRUE price attributed to THIS campaign's own fed kilos. GATED.
   * **This is the one to compare against `deliveredPhpKgFed`** — same shape,
   * so the two sit side by side honestly.
   */
  campaignWeightedActualFedPhpKg: number | null;
  /** ₱ — `actualFedPhpKg − deliveredPhpKg`. THE shrinkage cost. GATED. */
  upliftPhpKg: number | null;
  weightLostKg: number | null;
  /** FRACTION. */
  lossPct: number | null;

  blocksFed: number | null;
  blocksClosed: number | null;
  blocksOpen: number | null;
  blocksInPrice: number | null;
  blocksClosedUnpriced: number | null;
  campaignFedKgIncluded: number | null;
  campaignFedKgExcluded: number | null;
  /** PERCENT 0-100. */
  campaignFedKgIncludedPct: number | null;
  /** Every block the campaign fed is CLOSED **and** fully priced. */
  isFullyCovered: boolean;

  producedKg: number | null;
  /** FRACTION. */
  yieldPct: number | null;
  processLossKg: number | null;
  /** ₱ — arrival basis. GATED. NULL unless fed-price coverage is 100. */
  phpPerProducedKgDelivered: number | null;
  /** ₱ — TRUE basis. GATED. NULL unless `isFullyCovered`. The number P2 exists for. */
  phpPerProducedKgTrue: number | null;
}

/**
 * ONE open pile on the LIVE watchlist (`view_analytics_aging_watchlist`).
 *
 * "Open" is `status <> 'CLOSED'`, deliberately wider than IN-USE: only three
 * piles over a tonne are actively being fed while 167 STORED piles hold
 * 10,401 tonnes doing nothing but ageing, and those are what the list exists
 * to find.
 */
export interface AgingWatchItem {
  batchId: string;
  batchCode: string;
  /** `STORED` · `IN-USE` · `FEED` · … — never `CLOSED`. */
  status: string | null;
  /** Where it is now — the `?block=` deep link into the Blocking grid. */
  blockLoc: string | null;
  balanceKg: number | null;
  /** Weight-weighted mean age of what was tipped in. Same formula as the month-end view. */
  ageDays: number | null;
  daysSinceLastDelivery: number | null;
  firstDeliveryDate: string | null;
  lastDeliveryDate: string | null;
  deliveredKg: number | null;
  deliveryCount: number | null;
  unpricedDeliveryCount: number | null;
  hasUnpricedDelivery: boolean;
  /** ₱ — `batches.avg_cost` over PRICED deliveries. GATED. Blank, never free. */
  deliveredPhpKg: number | null;
  /** ₱ — what is left × that price. What it COST us, not what it would fetch. GATED. */
  valuePhp: number | null;
  fedKgToDate: number | null;
  lastFedDate: string | null;
  hasBeenFed: boolean;
}

/** The live watchlist plus the headline the SQL layer already owns. */
export interface AgingWatchlist {
  /** Every open pile over a tonne, OLDEST FIRST — the view's own order. */
  items: AgingWatchItem[];
  /**
   * The headline totals, taken from the NEWEST `view_analytics_aging_eom`
   * row and **not summed in TypeScript**: `open_kg` there is the same
   * population (measured equal to the kilo — 10,493,304.00 kg over 170
   * batches), and re-adding it here would create a second definition of how
   * much charcoal is in the yard.
   */
  openKg: number | null;
  openBatches: number | null;
  wtdAgeDays: number | null;
  pctOver120d: number | null;
  oldestAgeDays: number | null;
  /** Disclosed BESIDE the headline, never inside it. Resiko — loss, not stock. */
  closedResidueKg: number | null;
  closedResidueBatches: number | null;
  /** The Asia/Manila date the live rows speak for. */
  asOfDate: string | null;
  /**
   * The read came back at PostgREST's row cap, so the list may be short of
   * the truth. Measured 170 rows today against a 1000 cap; structural
   * honesty, not a live alarm.
   */
  truncated: boolean;
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
  /**
   * The BATCH-basis money panel, newest campaign LAST (so the panel can
   * scroll to its right edge and land on the current one). 32 rows today.
   */
  campaigns: CampaignCost[];
  /** The LIVE aging watchlist + its SQL-owned headline. */
  watchlist: AgingWatchlist;
}
