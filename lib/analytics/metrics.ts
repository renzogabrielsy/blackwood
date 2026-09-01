// =====================================================================
// ICTC Owner Analytics — the METRIC REGISTRY and the metric dictionary
// =====================================================================
// ONE module owns, per KPI row: its label, its unit, how a month's figure
// is READ, how a quarter or a year is ROLLED UP, whether it may be divided
// by working days, whether it is ₱-gated, and the plain-language
// definition the reader sees on hover / click.
//
// **The dictionary copy is derived from the view COMMENTs in
// `supabase/migrations/20260901115129_analytics_phase1_data_layer.sql`.**
// It is hardcoded here rather than fetched because a definition that only
// exists in the database is a definition nobody reads; and it is written
// ONCE here rather than beside each cell so the matrix, the row expand and
// the callouts can never describe the same number two ways.
//
// The audit's gap #1: "a number the reader can interrogate without asking
// anyone." Every entry therefore states four things explicitly — what it
// counts, what it EXCLUDES, what basis it is on, and how it rolls up.
//
// **Phase 2 adds eight MONEY rows** whose copy is derived the same way,
// from the COMMENTs in `20260901124822_analytics_phase2_money_layer.sql`.
// Three P2 conventions are load-bearing and are obeyed here rather than
// re-litigated per component:
//
//   1. **NULL is never 0.** A true ₱/kg with no fully-priced closed block
//      reads blank, and the row's dictionary says why.
//   2. **A coverage-short month shows the `_covered` figure, marked as an
//      ESTIMATE.** `view_rc_movement_month_price` prices fed kilos through
//      each fed batch's deliveries, so a batch with no delivery rows drags
//      the published price DOWN by exactly the share of untraceable kilos
//      (2024-03 is 98.4% untraceable and reads ₱0.30 against a real ~₱19).
//      Every money row therefore READS the covered figure — which is
//      byte-identical to the published one at 100% coverage — and declares
//      `estimated()` so the cell can mark itself.
//   3. **Percent vs fraction.** `yield_pct` and `loss_pct` are FRACTIONS in
//      SQL; `pct_over_120d` is already a PERCENT. The `read` functions are
//      the ONE place the ×100 happens.
//
// Pure and client-safe: no React, no Supabase, no `server-only`.
// =====================================================================

import type { AnalyticsMonth } from "./types";

/**
 * The twelve Phase-1 rows + the eight Phase-2 money rows + the six Phase-4
 * production rows, in display order.
 */
export type MetricKey =
  | "market_price"
  | "purchase_volume"
  | "active_suppliers"
  | "sundry_reentry"
  | "rc_in_total"
  | "rc_out"
  | "net_flow"
  | "ending_inventory"
  | "inventory_value"
  | "runway"
  | "active_batches"
  | "working_days"
  // ── P2, the money layer ──────────────────────────────────────────
  | "delivered_fed_price"
  | "php_per_produced"
  | "yield_rate"
  | "closed_blocks"
  | "closed_loss"
  | "closed_true_price"
  | "stock_age"
  | "over_120d"
  // ── P4, the production layer ──────────────────────────────────────
  | "production_output"
  | "production_per_day"
  | "downtime_hours"
  | "power_kwh"
  | "power_intensity"
  | "sacks_counted";

/**
 * The visual bands of the matrix. Twenty rows in one undifferentiated
 * stack is a wall; two named groups is a page. Purely presentational —
 * nothing about a rollup depends on it.
 */
export type MetricSection = "flow" | "money" | "production";

export const SECTIONS: readonly {
  key: MetricSection;
  label: string;
  hint: string;
}[] = [
  {
    key: "flow",
    label: "Volume & stock",
    hint: "What moved through the yard and what was left standing in it.",
  },
  {
    key: "money",
    label: "Money",
    hint:
      "What the charcoal we fed actually cost — on arrival, and again after the weight it lost while it sat. Calendar basis; the campaign basis is in the panel below.",
  },
  {
    key: "production",
    label: "Production",
    hint:
      "What the plant made, how long it stood still, and what it burned doing it. Measured against production's OWN reported days, never the yard's working days — and there is no ₱ anywhere in this band.",
  },
];

/**
 * What makes a blank on this row STRUCTURAL rather than "nothing happened".
 *
 * Feedings begin 2024-01 and production reports begin 2025-11, so a row
 * whose arithmetic needs one of those has no denominator before it exists.
 * Declared here so `matrix.ts` never carries a hardcoded list of keys.
 */
export type MetricDependency = "outflow" | "production";

/**
 * How a QUARTER or a YEAR column is built out of its months. Named, not
 * inferred — the audit's "weighted rollups only" rule, made checkable.
 */
export type RollupRule =
  /** Σ of the months. Volumes and day counts. */
  | "sum"
  /** Σ numerator ÷ Σ denominator. **Never** the average of the monthly averages. */
  | "weighted"
  /** The value of the LAST month in the period. Stock levels — a stock is not additive. */
  | "periodEnd"
  /**
   * The busiest single month. Used ONLY for `active_suppliers`, because the
   * distinct suppliers across a quarter is NOT derivable from twelve monthly
   * distinct counts, and inventing a sum would double-count anyone who sold
   * twice. Stated in the dictionary rather than quietly approximated.
   */
  | "peak";

/** How a cell's change is written — a percentage, or the raw difference. */
export type DeltaMode = "pct" | "abs";

/** How a value is turned into a string, and what the axis of its chart means. */
export type MetricUnit =
  | "php_per_kg"
  | "php"
  | "tonnes"
  | "count"
  | "days"
  | "pct"
  /** P4 — hours lost. */
  | "hours"
  /** P4 — metered electricity. */
  | "kwh"
  /** P4 — power intensity: units of electricity per kilo of product. */
  | "kwh_per_kg";

/**
 * A note attached to ONE period's cell — the mechanism a figure uses to say
 * "read me before you quote me" when the reason is not price coverage.
 *
 * P2 already had `estimated()`, but its `~` means exactly one thing (some fed
 * kilos carry no price) and its hover copy says so. P4 introduces three
 * different reasons a number needs a caveat — a mis-keyed meter reading, a
 * downtime duration that stopped being filled in, and a bag count that speaks
 * for a fraction of its month — so the caveat has to carry its OWN sentence
 * rather than borrow one that would be wrong.
 *
 * **`blocksCallout` is the load-bearing field.** An annotated cell may not set
 * a record or be the biggest move on the board, for the same reason an
 * estimate may not: a headline built on a figure the page itself is warning
 * about is a sentence about a hole in the data dressed as a sentence about the
 * business. August 2026's 0.00 downtime hours WOULD otherwise be the lowest
 * on record, and March 2026's power WOULD be the biggest mover ever recorded.
 * The cell still renders, still carries its delta, and still says why.
 */
export interface MetricAnnotation {
  /** The glyph the cell prints, or "" for a caveat that needs no mark. */
  mark: string;
  /** The whole sentence, merged into the cell's hover. */
  title: string;
  /** This cell may not be quoted as a record or a mover. Effectively always true. */
  blocksCallout: boolean;
  /**
   * A figure to print in place of a BLANK, clearly labelled as not the row's
   * own value. Power intensity is NULL-strict on a month containing a broken
   * meter reading — the honest answer — but the honest ESTIMATE exists beside
   * it in SQL, and printing a blank where a real number is known would be
   * withholding rather than caution.
   */
  alt?: { value: number; label: string };
}

/**
 * A SECOND series drawn over the same row in its expand — the comparison
 * line a two-sided fact owes its reader (delivered vs true ₱/kg).
 *
 * It carries its own rollup pair because a comparison line that aggregates
 * differently from the line it is compared against is not a comparison.
 * Both halves are SQL figures; nothing here re-derives a monthly number.
 */
export interface MetricPair {
  label: string;
  /** Recharts colour token. Picked for contrast against `MetricSpec.color`. */
  color: string;
  read(m: AnalyticsMonth): number | null;
  numerator(m: AnalyticsMonth): number | null;
  denominator(m: AnalyticsMonth): number | null;
  /** One sentence under the chart saying what the gap between the lines IS. */
  note: string;
}

export interface MetricDictionaryEntry {
  /** One sentence: what the number IS. */
  definition: string;
  /** Numerator ÷ denominator, or "the sum of …" — the arithmetic, in words. */
  basis: string;
  /** What is deliberately left OUT, and why. Empty string when nothing is. */
  exclusions: string;
  /** How the Q and Y columns are built. Always stated, never assumed. */
  rollup: string;
  /** Which SQL view owns it — the reader's route to the source. */
  source: string;
  /** An honest limit worth printing beside the number, or null. */
  caveat?: string;
}

export interface MetricSpec {
  key: MetricKey;
  /** Which visual band of the matrix the row sits in. */
  section: MetricSection;
  /** The row label. Sized against the frozen column's width — see the matrix. */
  label: string;
  /** A 1–3 word qualifier under the label (the unit, mostly). */
  sublabel: string;
  unit: MetricUnit;
  rollup: RollupRule;
  /**
   * The month's own figure, in DISPLAY units (tonnes, not kg). Returning
   * `null` means "no figure", never zero — a null is skipped by `sum` and
   * marks the period cell as holed.
   */
  read(m: AnalyticsMonth): number | null;
  /** `weighted` only — the pesos side. */
  numerator?(m: AnalyticsMonth): number | null;
  /** `weighted` only — the kilos side. */
  denominator?(m: AnalyticsMonth): number | null;
  deltaMode: DeltaMode;
  /** May the working-day toggle divide this row? Volumes yes; stocks and rates no. */
  perWorkingDay: boolean;
  /** ₱-bearing — the server nulls it for a price-denied role and the row renders restricted. */
  price: boolean;
  /** The row-expand chart's shape. A price is a LINE (a bar from zero reads as a collapse). */
  chart: "bar" | "line";
  /** Recharts colour token for the expand chart. */
  color: string;
  /** Contrast colour for the rolling-mean line — picked against `color` in BOTH themes. */
  avgColor: string;
  /** Decimal places in the matrix. */
  decimals: number;
  /**
   * What a blank on this row means when the underlying stream did not exist
   * yet. Empty / absent = a blank is simply "no records".
   */
  dependsOn?: readonly MetricDependency[];
  /**
   * TRUE when this month's figure is the coverage-adjusted ESTIMATE rather
   * than the strict published one. The cell marks itself `~`, the hover
   * explains, and `matrix.ts` refuses to build any callout out of it — an
   * estimate can neither set a record nor be the biggest move on the board.
   */
  estimated?(m: AnalyticsMonth): boolean;
  /**
   * P4 — the row's own caveat for ONE period, or null when it has none.
   *
   * It takes the period's MONTHS rather than one month, because the caveat is
   * a property of the whole column: a quarter containing March 2026 carries
   * the mis-keyed meter reading exactly as March does, and hiding that behind
   * two clean months is the silent understatement this layer exists to
   * prevent — the same argument `rawValue` already applies to `estimated`.
   */
  annotate?(months: readonly AnalyticsMonth[]): MetricAnnotation | null;
  /** The comparison line drawn beside this row in its expand, if it has one. */
  pair?: MetricPair;
  dictionary: MetricDictionaryEntry;
}

const KG_PER_TONNE = 1000;

/** kg → tonnes, preserving null. The matrix is in tonnes; drill-downs stay in kg. */
function t(kg: number | null | undefined): number | null {
  return kg == null ? null : kg / KG_PER_TONNE;
}

/** FRACTION → percent, preserving null. The ONE place the ×100 happens. */
function pct(fraction: number | null | undefined): number | null {
  return fraction == null ? null : fraction * 100;
}

/** `a × b`, null if either side is missing. Used to rebuild a rollup numerator. */
function mul(a: number | null | undefined, b: number | null | undefined): number | null {
  return a == null || b == null ? null : a * b;
}

/**
 * A money row's own monthly figure is ALWAYS the coverage-adjusted one.
 *
 * At 100% coverage `delivered_php_kg_fed_covered` is byte-identical to the
 * published `delivered_php_kg_fed` (checked across all 75 months), so this
 * is not a second definition — it is the same definition, made honest on
 * the seven months where the published one is silently understated.
 */
function coveredFedValue(m: AnalyticsMonth): number | null {
  return mul(m.deliveredPhpKgFedCovered, m.fedKg);
}

/** Coverage is short, so what the cell shows is an extrapolation. */
function coverageShort(m: AnalyticsMonth): boolean {
  return m.fedPriceCoveragePct != null && m.fedPriceCoveragePct < 100;
}

// ---------------------------------------------------------------------
// The registry
// ---------------------------------------------------------------------

/** P1 — what moved and what was left standing. Section assigned below. */
const FLOW_METRICS: readonly Omit<MetricSpec, "section">[] = [
  {
    key: "market_price",
    label: "Market price",
    sublabel: "₱/kg",
    unit: "php_per_kg",
    rollup: "weighted",
    read: (m) => m.marketAvgPrice,
    numerator: (m) => m.marketPhpTotal,
    denominator: (m) => m.marketPricedKg,
    deltaMode: "pct",
    perWorkingDay: false,
    price: true,
    chart: "line",
    color: "var(--chart-4)",
    avgColor: "var(--chart-3)",
    decimals: 2,
    dictionary: {
      definition:
        "What a kilo of bought charcoal cost us on average, for the month.",
      basis:
        "Total pesos paid ÷ total kilos priced — a weighted average, never the average of the daily prices.",
      exclusions:
        "Our own charcoal returning from sun-drying and anything re-cooked or re-fed are left out: we already paid for those kilos once, and the peso figure on a re-cook is a token processing fee, not a market price. A truckload still waiting on its price is left out of BOTH halves of the sum rather than counted as free.",
      rollup:
        "A quarter or a year is total-pesos ÷ total-kilos across its months — never the mean of the monthly prices.",
      source: "view_analytics_rcin_monthly.market_avg_price",
      caveat:
        "Price coverage reads 100% on every month today — every delivery in the table is priced. The coverage figure is structural honesty for the next time the price file lags, not a live alarm.",
    },
  },
  {
    key: "purchase_volume",
    label: "Purchase volume",
    sublabel: "tonnes",
    unit: "tonnes",
    rollup: "sum",
    read: (m) => t(m.marketKg),
    deltaMode: "pct",
    perWorkingDay: true,
    price: false,
    chart: "bar",
    color: "var(--chart-2)",
    avgColor: "var(--chart-4)",
    decimals: 1,
    dictionary: {
      definition: "How much charcoal we actually BOUGHT that month.",
      basis: "The sum of the delivered weights on market-class deliveries.",
      exclusions:
        "Sun-drying returns and re-cooked material are excluded — counting them would book the same kilos twice. They are reported on their own rows.",
      rollup: "Quarters and years are plain sums of their months.",
      source: "view_analytics_rcin_monthly.market_kg",
    },
  },
  {
    key: "active_suppliers",
    label: "Active suppliers",
    sublabel: "sellers",
    unit: "count",
    rollup: "peak",
    read: (m) => m.activeSuppliers,
    deltaMode: "abs",
    perWorkingDay: false,
    price: false,
    chart: "bar",
    color: "var(--chart-1)",
    avgColor: "var(--chart-3)",
    decimals: 0,
    dictionary: {
      definition:
        "How many different suppliers actually sold to us that month — the participation half of the price story.",
      basis:
        "Distinct suppliers on market deliveries, after folding the spelling variants together.",
      exclusions:
        "A sun-drying return carries its origin supplier's name but is not a sale, so it does not make that supplier active.",
      rollup:
        "A quarter or a year shows its BUSIEST MONTH's count, not the distinct sellers over the whole period — that is not derivable from monthly counts without double-counting anyone who sold twice. Labelled as a peak, never presented as a total.",
      source: "view_analytics_rcin_monthly.active_suppliers",
    },
  },
  {
    key: "sundry_reentry",
    label: "Sundry re-entry",
    sublabel: "tonnes",
    unit: "tonnes",
    rollup: "sum",
    read: (m) => t(m.sundryReentryKg),
    deltaMode: "pct",
    perWorkingDay: true,
    price: false,
    chart: "bar",
    color: "var(--chart-5)",
    avgColor: "var(--chart-3)",
    decimals: 1,
    dictionary: {
      definition:
        "Our own charcoal coming back into the yard after sun-drying — a recovery figure, not a purchase.",
      basis: "The sum of delivered weights on sundry-class deliveries.",
      exclusions:
        "A delivery filed on a sundry batch but remarked FOR SUNDRYING is fresh charcoal on its way OUT to dry, so it counts as a market purchase instead.",
      rollup: "Quarters and years are plain sums of their months.",
      source: "view_analytics_rcin_monthly.sundry_reentry_kg",
    },
  },
  {
    key: "rc_in_total",
    label: "RC IN total",
    sublabel: "tonnes",
    unit: "tonnes",
    rollup: "sum",
    read: (m) => t(m.inKg),
    deltaMode: "pct",
    perWorkingDay: true,
    price: false,
    chart: "bar",
    color: "var(--chart-2)",
    avgColor: "var(--chart-3)",
    decimals: 1,
    dictionary: {
      definition:
        "Everything that physically rolled through the gate — bought, returned from drying and re-cooked alike.",
      basis: "The sum of every delivery's weight for the month.",
      exclusions:
        "Nothing. The yard does not care who owned the kilos; the purchase question is the Purchase volume row's job.",
      rollup: "Quarters and years are plain sums of their months.",
      source: "view_analytics_flow_monthly.in_kg",
    },
  },
  {
    key: "rc_out",
    label: "RC OUT",
    sublabel: "tonnes fed",
    unit: "tonnes",
    rollup: "sum",
    read: (m) => t(m.outKg),
    deltaMode: "pct",
    perWorkingDay: true,
    price: false,
    chart: "bar",
    color: "var(--chart-1)",
    avgColor: "var(--chart-3)",
    decimals: 1,
    dependsOn: ["outflow"],
    dictionary: {
      definition: "Everything fed to the plant that month.",
      basis: "The sum of every feeding's weight.",
      exclusions: "Nothing.",
      rollup: "Quarters and years are plain sums of their months.",
      source: "view_analytics_flow_monthly.out_kg",
      caveat:
        "Feedings were only recorded from January 2024. Months before that are BLANK here, never zero — a structural zero would sum into a quarter and a year as if the plant had fed nothing.",
    },
  },
  {
    key: "net_flow",
    label: "Net flow",
    sublabel: "tonnes",
    unit: "tonnes",
    rollup: "sum",
    read: (m) => t(m.netKg),
    // A net crosses zero, so a percentage of last month's net is meaningless.
    deltaMode: "abs",
    perWorkingDay: true,
    price: false,
    chart: "bar",
    color: "var(--chart-3)",
    avgColor: "var(--chart-4)",
    decimals: 1,
    dependsOn: ["outflow"],
    dictionary: {
      definition:
        "Did the pile grow or shrink that month. Positive means we built stock; negative means we ate into it.",
      basis: "Everything in, minus everything fed.",
      exclusions: "Nothing.",
      rollup: "Quarters and years are plain sums of their months.",
      source: "view_analytics_flow_monthly.net_kg",
      caveat:
        "Blank before January 2024, for the same reason RC OUT is: half the subtraction did not exist yet.",
    },
  },
  {
    key: "ending_inventory",
    label: "Ending inventory",
    sublabel: "tonnes",
    unit: "tonnes",
    rollup: "periodEnd",
    read: (m) => t(m.endingKg),
    deltaMode: "pct",
    perWorkingDay: false,
    price: false,
    chart: "bar",
    color: "var(--chart-2)",
    avgColor: "var(--chart-4)",
    decimals: 1,
    dictionary: {
      definition:
        "How much charcoal we were holding when the month closed. Nothing is snapshotted — it is rebuilt from the delivery and feeding records themselves, so correcting an old record correctly restates history.",
      basis: "Everything in, minus everything out, per batch, as of month-end.",
      exclusions:
        "Nothing is excluded — but read the split in the row's expand. This is a NET.",
      rollup:
        "A quarter or a year shows the value at the PERIOD END, not a sum: a stock level is not additive.",
      source: "view_analytics_inventory_eom.ending_kg",
      caveat:
        "The total nets roughly −3,200 t spread over 77 batches carrying a negative balance. Those kilos are real and in the yard — they were fed out under one batch name while their arrival was booked under a different spelling of it. Misattribution, not evaporation. The split is in the row's expand.",
    },
  },
  {
    key: "inventory_value",
    label: "Inventory value",
    sublabel: "₱ at cost",
    unit: "php",
    rollup: "periodEnd",
    read: (m) => m.endingValuePhp,
    deltaMode: "pct",
    perWorkingDay: false,
    price: true,
    chart: "bar",
    color: "var(--chart-4)",
    avgColor: "var(--chart-3)",
    decimals: 0,
    dictionary: {
      definition:
        "What the charcoal on hand had COST us at month-end — not what it would fetch.",
      basis:
        "Each pile's remaining kilos priced at that pile's own weighted average purchase cost, summed.",
      exclusions:
        "Only piles with a POSITIVE balance are valued, so this figure pairs with the positive half of the stock, never with the net total. It does not yet include the extra cost of charcoal that shrank while it sat — that is a later layer, and mixing the two would make a third definition of what a kilo cost.",
      rollup: "The PERIOD-END month's value. A stock value is not additive.",
      source: "view_analytics_inventory_eom.ending_value_php",
    },
  },
  {
    key: "runway",
    label: "Runway",
    sublabel: "working days",
    unit: "days",
    rollup: "periodEnd",
    read: (m) => m.runwayDays,
    deltaMode: "abs",
    perWorkingDay: false,
    price: false,
    chart: "line",
    color: "var(--chart-3)",
    avgColor: "var(--chart-4)",
    decimals: 1,
    dependsOn: ["outflow"],
    dictionary: {
      definition:
        "The plain survival number: at the rate we fed the plant that month, how many working days the pile on hand would last.",
      basis: "Month-end stock ÷ that month's average feeding per working day.",
      exclusions: "Nothing.",
      rollup:
        "The PERIOD-END month's figure — a runway is a state, not something you add up.",
      source: "view_analytics_inventory_eom.runway_days",
      caveat:
        "Blank before January 2024: without a recorded feeding rate there is no denominator.",
    },
  },
  {
    key: "active_batches",
    label: "Active batches",
    sublabel: "piles > 500 kg",
    unit: "count",
    rollup: "periodEnd",
    read: (m) => m.activeBatches,
    deltaMode: "abs",
    perWorkingDay: false,
    price: false,
    chart: "bar",
    color: "var(--chart-1)",
    avgColor: "var(--chart-3)",
    decimals: 0,
    dictionary: {
      definition:
        "How many piles were actually holding stock at month-end.",
      basis: "Batches whose rebuilt balance was above 500 kg.",
      exclusions:
        "Anything at or below 500 kg — rounding dust and closed-out residue, not a pile anyone would walk out to look at.",
      rollup: "The PERIOD-END month's count. A count of what exists is not additive.",
      source: "view_analytics_inventory_eom.active_batches",
      caveat:
        "This is a count of BATCHES, not of warehouse blocks. How many of the 220 blocks were occupied in a past month is not reconstructable — a batch only records where it is now — so block occupancy is shown live, beside the matrix, and never as history.",
    },
  },
  {
    key: "working_days",
    label: "Working days",
    sublabel: "days active",
    unit: "days",
    rollup: "sum",
    read: (m) => m.workingDays,
    deltaMode: "abs",
    perWorkingDay: false,
    price: false,
    chart: "bar",
    color: "var(--chart-5)",
    avgColor: "var(--chart-3)",
    decimals: 0,
    dictionary: {
      definition:
        "Days the site actually did something — a delivery arrived, charcoal was fed, or a production shift was reported.",
      basis:
        "Measured from what happened, not from a calendar or a roster. It typically lands at 22–27 days against a 28–31 day month, which is a six-day week with rest days.",
      exclusions: "Rest days, and any day nothing was recorded.",
      rollup: "Quarters and years are plain sums of their months.",
      source: "view_analytics_flow_monthly.working_days",
      caveat:
        "One blind spot: a day the whole site was down looks exactly like a rest day. Nothing in the database records intent since the shift plan was retired.",
    },
  },
] as const;

/**
 * P2 — THE MONEY LAYER, calendar basis.
 *
 * Every ₱ row here is `price: true`, so the adapter nulls it server-side for
 * a role that may not see pesos and the row renders locked. The two aging
 * rows carry NO peso column and none is derivable from them, so they stay
 * visible for every role including Production — which is the whole reason
 * `view_analytics_aging_eom` was built ₱-free.
 */
const MONEY_METRICS: readonly Omit<MetricSpec, "section">[] = [
  {
    key: "delivered_fed_price",
    label: "Delivered ₱/kg fed",
    sublabel: "arrival cost",
    unit: "php_per_kg",
    rollup: "weighted",
    read: (m) => m.deliveredPhpKgFedCovered,
    numerator: coveredFedValue,
    denominator: (m) => m.fedKg,
    estimated: coverageShort,
    deltaMode: "pct",
    perWorkingDay: false,
    price: true,
    chart: "line",
    color: "var(--chart-4)",
    avgColor: "var(--chart-3)",
    decimals: 2,
    dependsOn: ["outflow"],
    dictionary: {
      definition:
        "What the charcoal we actually FED cost us on the day it arrived at the gate — the same monthly figure the RC Movement screen shows, so the two can never disagree.",
      basis:
        "Total pesos paid for the kilos fed ÷ those kilos. A weighted average, never the mean of the daily prices.",
      exclusions:
        "Some kilos were fed out of piles with no delivery record at all — old pre-system stock, and the misfiled 'FEEDING # 2' pile — and those kilos carry no price. They are left out of BOTH halves of the sum rather than counted as free, so the figure speaks only for the kilos it can actually price.",
      rollup:
        "A quarter or a year is total-pesos ÷ total-kilos-fed across its months — never the mean of the monthly prices.",
      source: "view_analytics_cost_monthly.delivered_php_kg_fed_covered",
      caveat:
        "Seven months are short of full price coverage and are marked with a ~. Early 2024 is the worst — March 2024 can price only 1.6% of what it fed — and August 2026 is 97.3% because of the 18,650 kg phantom pile. On those months this row shows the price of the kilos it CAN trace, which is the honest answer; the raw published figure for March 2024 would be a tiny fraction of the real one.",
    },
  },
  {
    key: "php_per_produced",
    label: "₱ per produced kg",
    sublabel: "arrival basis",
    unit: "php_per_kg",
    rollup: "weighted",
    read: (m) => m.phpPerProducedKg ?? m.phpPerProducedKgCovered,
    numerator: coveredFedValue,
    denominator: (m) => m.producedKg,
    estimated: coverageShort,
    deltaMode: "pct",
    perWorkingDay: false,
    price: true,
    chart: "line",
    color: "var(--chart-5)",
    avgColor: "var(--chart-3)",
    decimals: 2,
    dependsOn: ["outflow", "production"],
    dictionary: {
      definition:
        "The owner number: what ONE KILO of finished product cost us in raw charcoal that month.",
      basis:
        "The month's charcoal bill ÷ the kilos of product that came out. Identically, the fed price divided by the yield — a low yield makes every produced kilo carry more charcoal.",
      exclusions:
        "Only the charcoal. No labour, no power, no bags, no depreciation. And it uses the ARRIVAL price: the extra cost of the weight charcoal loses while it sits is not in here, because that is only final once a block closes — it is in the True ₱/kg row below and in the campaign panel.",
      rollup:
        "A quarter or a year is total charcoal bill ÷ total kilos produced across its months — never the mean of the monthly figures.",
      source: "view_analytics_cost_monthly.php_per_produced_kg",
      caveat:
        "Production has only been reported since November 2025, so this row is blank before then — blank, never zero. November 2025 itself covers only part of the month and reads implausibly high — a reporting boundary rather than a real cost — so it is excluded from every headline on this page. Months where the fed price cannot cover all the kilos are marked ~ and show the honest estimate rather than the naive published figure.",
    },
  },
  {
    key: "yield_rate",
    label: "Yield",
    sublabel: "% of fed kilos",
    unit: "pct",
    rollup: "weighted",
    read: (m) => pct(m.yieldPct),
    // ×100 on the NUMERATOR so the weighted rule stays Σnum ÷ Σden and the
    // result lands in percent — there is no second scaling step to forget.
    numerator: (m) => (m.producedKg == null ? null : m.producedKg * 100),
    denominator: (m) => m.fedKg,
    deltaMode: "abs",
    perWorkingDay: false,
    price: false,
    chart: "line",
    color: "var(--chart-2)",
    avgColor: "var(--chart-4)",
    decimals: 1,
    dependsOn: ["outflow", "production"],
    dictionary: {
      definition:
        "How much finished product came out of every hundred kilos of charcoal fed in.",
      basis:
        "Kilos produced ÷ kilos fed, for the month. The change under a cell is in percentage POINTS, not a percentage of a percentage.",
      exclusions:
        "Nothing. Everything fed is in the denominator and everything produced is in the numerator, whichever pile or grade it came from.",
      rollup:
        "A quarter or a year is total produced ÷ total fed across its months — never the mean of the monthly yields.",
      source: "view_analytics_cost_monthly.yield_pct",
      caveat:
        "Blank before November 2025, when production reporting started — blank, never 0%, because a structural zero would roll into a quarter as if the plant had turned eight thousand tonnes of charcoal into nothing. November 2025 itself covers only part of the month (11.9%) and is excluded from every headline for the same reason.",
    },
  },
  {
    key: "closed_blocks",
    label: "Blocks closed",
    sublabel: "piles finished",
    unit: "count",
    rollup: "sum",
    read: (m) => m.closedBlocksCount,
    deltaMode: "abs",
    perWorkingDay: false,
    price: false,
    chart: "bar",
    color: "var(--chart-1)",
    avgColor: "var(--chart-3)",
    decimals: 0,
    dependsOn: ["outflow"],
    dictionary: {
      definition:
        "How many piles were finished off that month — fed down and closed out.",
      basis:
        "Blocks whose LAST FEEDING fell in the month. Status changes are not dated anywhere in the database, so the last feeding (or the feeding remarked CLOSED) is what stands in for the closing date.",
      exclusions:
        "A pile still being fed at month-end belongs to no month yet, so it is not counted anywhere until it finishes.",
      rollup: "Quarters and years are plain sums of their months.",
      source: "view_analytics_cost_monthly.closed_blocks_count",
      caveat:
        "This is the SAME approximation the RC Movement screen uses, deliberately — reusing it is what keeps the two screens from disagreeing about which month a block closed in.",
    },
  },
  {
    key: "closed_loss",
    label: "Closed-block loss",
    sublabel: "% of delivered kg",
    unit: "pct",
    rollup: "weighted",
    read: (m) => pct(m.closedBlocksLossPct),
    numerator: (m) =>
      m.closedBlocksLostKg == null ? null : m.closedBlocksLostKg * 100,
    denominator: (m) => m.closedBlocksDeliveredKg,
    deltaMode: "abs",
    perWorkingDay: false,
    price: false,
    chart: "line",
    color: "var(--chart-3)",
    avgColor: "var(--chart-4)",
    decimals: 2,
    dependsOn: ["outflow"],
    dictionary: {
      definition:
        "How much weight the piles that closed that month lost while they sat — charcoal dries out, and the money already spent on it does not shrink with it.",
      basis:
        "Weight lost ÷ weight delivered in, added up over every block that closed that month, weighted by size. Never the average of the per-block percentages.",
      exclusions:
        "Nothing. Loss is physical and needs no price, so this uses every closed block — including the ones whose peso figures are missing.",
      rollup:
        "A quarter or a year is total kilos lost ÷ total kilos delivered across its closed blocks.",
      source: "view_analytics_cost_monthly.closed_blocks_loss_pct",
      caveat:
        "It can go slightly NEGATIVE — February 2026 reads −0.10% — meaning those blocks fed out marginally more than was booked into them. That is misfiled paperwork, not a measurement error, and it is shown as measured rather than clamped to zero.",
    },
  },
  {
    key: "closed_true_price",
    label: "True ₱/kg (closed)",
    sublabel: "after shrinkage",
    unit: "php_per_kg",
    rollup: "weighted",
    read: (m) => m.closedBlocksTruePhpKg,
    numerator: (m) => mul(m.closedBlocksTruePhpKg, m.closedBlocksPricedFedKg),
    denominator: (m) => m.closedBlocksPricedFedKg,
    deltaMode: "pct",
    perWorkingDay: false,
    price: true,
    chart: "line",
    color: "var(--chart-4)",
    avgColor: "var(--chart-3)",
    decimals: 2,
    dependsOn: ["outflow"],
    pair: {
      label: "Delivered ₱/kg (same blocks)",
      color: "var(--chart-2)",
      read: (m) => m.closedBlocksDeliveredPhpKg,
      numerator: (m) =>
        mul(m.closedBlocksDeliveredPhpKg, m.closedBlocksPricedFedKg),
      denominator: (m) => m.closedBlocksPricedFedKg,
      note:
        "The gap between the two lines IS the cost of letting charcoal sit. Both are the same blocks and the same money; the true line divides it by the kilos that actually reached the plant, the delivered line by the kilos that arrived.",
    },
    dictionary: {
      definition:
        "What the charcoal in the piles that closed that month REALLY cost by the time it was fed — after paying for the weight that evaporated in the yard.",
      basis:
        "Every peso spent on those blocks ÷ every kilo that actually came out of them. Because the weight shrinks and the money does not, this always sits above the arrival price.",
      exclusions:
        "A block with even one truckload still awaiting a price is left out ENTIRELY rather than valued at part of its money — a numerator missing pesos against a full denominator would understate the figure and point the exact opposite way from the thing this row exists to show. Blocks with no delivery record at all are left out for the same reason. The row's expand says how many that was.",
      rollup:
        "A quarter or a year is total pesos ÷ total kilos fed across its fully-priced closed blocks.",
      source: "view_analytics_cost_monthly.closed_blocks_true_php_kg",
      caveat:
        "Blank — never zero — for a month with no fully-priced closed block. A closed block always costs more per kilo than it arrived at — the gap is pure storage time (July 2026 lost 4.68% of its weight while sitting).",
    },
  },
  {
    key: "stock_age",
    label: "Avg stock age",
    sublabel: "days, open piles",
    unit: "days",
    rollup: "periodEnd",
    read: (m) => m.wtdAgeDays,
    deltaMode: "abs",
    perWorkingDay: false,
    price: false,
    chart: "line",
    color: "var(--chart-5)",
    avgColor: "var(--chart-3)",
    decimals: 1,
    dictionary: {
      definition:
        "How old the charcoal standing in the yard was when the month closed, averaged by weight — a big fresh pile pulls it down, a small old one barely moves it.",
      basis:
        "Each pile takes the average delivery date of everything tipped into it, weighted by weight, and the whole remaining balance carries that one age.",
      exclusions:
        "Closed blocks are kept out. A closed block keeps a small logged remainder forever, which is the weight that evaporated rather than stock anyone can go and use; counting it made the yard read 416 days old with a six-year-old pile in it, against 387 days and a three-year-old pile once it is set aside. Piles carrying a negative balance have no meaningful age and are also left out.",
      rollup:
        "A quarter or a year shows the PERIOD-END month's figure — an age is a state, not something you add up.",
      source: "view_analytics_aging_eom.wtd_age_days",
      caveat:
        "There is no first-in-first-out accounting and none is possible: the feeding records say which PILE kilos left, never which truckload within it, so a FIFO answer would be a precise-looking guess. Deliveries into one pile land within days of each other, so the error is small against ages measured in hundreds of days.",
    },
  },
  {
    key: "over_120d",
    label: "Stock over 120 days",
    sublabel: "% of open kg",
    unit: "pct",
    rollup: "periodEnd",
    read: (m) => m.pctOver120d,
    deltaMode: "abs",
    perWorkingDay: false,
    price: false,
    chart: "line",
    color: "var(--chart-1)",
    avgColor: "var(--chart-4)",
    decimals: 1,
    dictionary: {
      definition:
        "How much of the yard was sitting in piles older than four months — the share of stock that is quietly losing weight.",
      basis:
        "Kilos in open piles aged over 120 days ÷ all kilos in open piles, at month-end. Already a percentage, 0 to 100.",
      exclusions:
        "The same exclusions as average stock age — closed-block residue and negative balances are out.",
      rollup:
        "A quarter or a year shows the PERIOD-END month's figure. A share of what exists is not additive.",
      source: "view_analytics_aging_eom.pct_over_120d",
      caveat:
        "120 days is a reading threshold, not a policy: nothing on this page turns amber or red because of it. The companion 60-day figure and the oldest pile are in the row's expand.",
    },
  },
] as const;

// ---------------------------------------------------------------------
// P4 — THE PRODUCTION LAYER
// ---------------------------------------------------------------------
//
// **Not one row here is `price: true`, and that is structural.** No ₱ column
// exists in either P4 view and none is derivable from them (the migration
// asserts it: 0 of 35 columns match `php|peso|cost|price|value|amount`), so
// the whole production band is visible to every role including Production and
// the adapter has nothing to null. The money that MEETS production already
// lives in the money band above and is gated there.
//
// **The denominator rule this band exists to protect.** `reported_days` is
// PRODUCTION'S OWN count of days it reported, not the flow view's working
// days, and the two answer different questions. So `production_output` is
// deliberately NOT `perWorkingDay` — the toggle would divide the plant's
// tonnage by the YARD's activity and silently change what the figure means.
// The honest normalisation is its own row, `production_per_day`, which
// divides by the right denominator and says so.
//
// **Three figures are wrong-looking-right or right-looking-wrong, and each
// carries an `annotate` rather than a silent correction.** See
// `MetricAnnotation` above for why an annotated cell can never be a headline.

/** Plain number, for annotation copy. */
function nfmt(v: number, decimals = 0): string {
  return v.toLocaleString("en-US", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

function sumOf(
  months: readonly AnalyticsMonth[],
  pick: (m: AnalyticsMonth) => number | null,
): number {
  let total = 0;
  for (const m of months) total += pick(m) ?? 0;
  return total;
}

/**
 * A downtime total of 0.00 hours can mean two completely different things.
 *
 * Measured across the history: Nov 2025 – Apr 2026 recorded durations and NOT
 * ONE reason; reasons begin May 2026 (5 of 22); Jun and Jul record both; and
 * **August 2026 is reason-only 23 of 23** — every shift named a repair
 * ("CLEANED SCREEN RS 2A AND RS 2B") and none said how long it took. On a
 * matrix that renders as the best month the plant has ever had. The two
 * halves of the report drifted apart in both directions, so this is a count
 * of a real pattern, never an invented threshold.
 */
function downtimeAnnotation(
  months: readonly AnalyticsMonth[],
): MetricAnnotation | null {
  const reasonOnly = sumOf(months, (m) => m.downtimeShiftsReasonOnly);
  if (reasonOnly <= 0) return null;
  const withDuration = sumOf(months, (m) => m.downtimeShiftsWithDuration);
  const records = sumOf(months, (m) => m.downtimeShiftCount);
  const shift = (n: number) => `${n} shift${n === 1 ? "" : "s"}`;
  return {
    mark: "⚠",
    blocksCallout: true,
    title:
      withDuration === 0
        ? `EVERY one of the ${shift(reasonOnly)} that filed a downtime record in this period described the repair and left the duration at zero. Not one put a number on it, so this total is a gap in the report — NOT a period in which the plant never stopped. It is shown exactly as recorded, and it is never quoted as a record or a biggest move.`
        : `${reasonOnly} of the ${shift(records)} that filed a downtime record in this period described the repair but left the duration at zero, so these hours are short by an unknown amount. Shown as recorded, and never quoted as a record or a biggest move.`,
  };
}

/**
 * ONE mis-keyed meter reading can be 97% of its month, and it does not look
 * wrong — it looks like a finding.
 *
 * The detector is STRUCTURAL, not a hardcoded date: a `start_kwh` of 0 is a
 * genuine meter reset only if the counter WRAPPED, i.e. that row's end is
 * BELOW the meter's previous end. Over all 818 readings the rule fires on
 * exactly one row (2026-03-01 / MAIN, ×120 multiplier, 676,944 kWh into a
 * month whose real consumption is about 20,000) and correctly clears
 * 2026-03-04, which is a real rollover. Nothing is repaired — correcting the
 * reading is a separate, audited write.
 */
function powerAnnotation(
  months: readonly AnalyticsMonth[],
): MetricAnnotation | null {
  const count = sumOf(months, (m) => m.kwhSuspectReadingCount);
  if (count <= 0) return null;
  const suspect = sumOf(months, (m) => m.kwhSuspectKwh);
  const total = sumOf(months, (m) => m.kwh);
  const share = total > 0 ? (suspect / total) * 100 : null;
  return {
    mark: "⚠",
    blocksCallout: true,
    title:
      `${count} meter reading${count === 1 ? "" : "s"} in this period can be shown to be mis-keyed — a starting reading left at zero against an end that was still climbing — and ${nfmt(suspect)} kWh of the total shown comes from ${count === 1 ? "it" : "them"}` +
      (share == null ? "" : `, which is ${nfmt(share, 1)}% of the period`) +
      `. The total is published EXACTLY AS METERED: nothing here silently corrects the underlying record, and correcting the reading itself is a separate, audited write. The power-intensity row is where the broken reading is taken out. This cell is never quoted as a record or a biggest move.`,
  };
}

/**
 * The intensity's own annotation — the mirror image of the one above, and the
 * distinction between them is the whole rule. The kWh total is FACTUALLY
 * WRONG, so its ratio is suppressed; the total itself is still published as
 * metered. Suppressing a correct number is how a data layer starts lying, so
 * the honest estimate is printed beside the ⚠ rather than withheld.
 */
function powerIntensityAnnotation(
  months: readonly AnalyticsMonth[],
): MetricAnnotation | null {
  const base = powerAnnotation(months);
  if (!base) return null;
  const only = months.length === 1 ? months[0] : null;
  const excl = only?.kwhPerProducedKgExclSuspect ?? null;
  const clean = months.filter((m) => (m.kwhSuspectReadingCount ?? 0) === 0).length;
  return {
    mark: "⚠",
    blocksCallout: true,
    alt:
      excl == null
        ? undefined
        : { value: excl, label: "excl. the mis-keyed reading" },
    title:
      `Left BLANK rather than wrong: this period contains a meter reading that is provably mis-keyed, and an intensity computed on it would report an efficiency collapse that never happened (2026-03 reads 0.7630 kWh/kg against neighbours reading 0.03). ` +
      (excl != null
        ? `The figure shown beside the ⚠ is the SAME arithmetic with the broken reading removed — the honest estimate — and it is labelled as such rather than presented as the measurement.`
        : clean > 0
          ? `The period figure above is measured over its ${clean} unaffected month${clean === 1 ? "" : "s"} only.`
          : `Every month in this period is affected, so there is no honest figure to show.`),
  };
}

/**
 * Bags did not exist before May 2026. Zero of the 179 runs from Nov 2025
 * through Apr 2026 carry a bag count; May carries 1 of 38, June 36 of 38,
 * July 44 of 44, August 33 of 33. A 0 would assert "we produced no bags"
 * where the truth is "we did not count them", so SQL publishes NULL and this
 * says what the coverage is when it is short.
 */
function sacksAnnotation(
  months: readonly AnalyticsMonth[],
): MetricAnnotation | null {
  const runs = sumOf(months, (m) => m.productionRunCount);
  if (runs <= 0) return null;
  const withSacks = sumOf(months, (m) => m.runsWithSacks);
  if (withSacks >= runs) return null;
  if (withSacks === 0) {
    return {
      mark: "",
      blocksCallout: true,
      title: `Not one of the ${runs} production entries in this period recorded a bag count — bags were only counted from May 2026 on. Blank, never zero: "we did not count bags" and "we produced no bags" are different answers, and a zero would assert the second.`,
    };
  }
  return {
    mark: "~",
    blocksCallout: true,
    title: `This count speaks for ${withSacks} of the period's ${runs} production entries — ${nfmt((100 * withSacks) / runs, 1)}% coverage — so it is a floor rather than the period's bags. It is never quoted as a record or a biggest move.`,
  };
}

/**
 * May this month contribute to a power-intensity rollup AT ALL?
 *
 * A weighted rollup sums the numerator and the denominator INDEPENDENTLY, so a
 * month that has one and not the other adds to one side of the fraction and
 * nothing to the other. Every other weighted row on this page is safe from
 * that by construction — its two halves are co-null — but this one is not, and
 * it was measured going wrong on the very first render: the P4 spine carries
 * **eight months with metered power and no production at all** (the meters
 * start 2025-03, production reporting starts 2025-11), so the 2025 column
 * added 577,438 kWh to the numerator against a denominator those months
 * contribute nothing to, and the year read **0.9190 kWh/kg against a true
 * 0.1527** — six times too high, in the exact shape of the silent hole this
 * codebase keeps re-learning.
 *
 * So both halves are gated on the SAME predicate: a month counts only if it
 * has a sound kWh reading AND a produced figure to divide it by. The suspect
 * test rides here too, which is why a quarter containing March 2026 is
 * measured over its unaffected months.
 */
function intensityUsable(m: AnalyticsMonth): boolean {
  if ((m.kwhSuspectReadingCount ?? 0) > 0) return false;
  return m.kwh != null && m.producedKg != null && m.producedKg > 0;
}

const PRODUCTION_METRICS: readonly Omit<MetricSpec, "section">[] = [
  {
    key: "production_output",
    label: "Production output",
    sublabel: "tonnes made",
    unit: "tonnes",
    rollup: "sum",
    // The SAME `producedKg` the money band reads — both are
    // `view_rc_movement_yield_monthly.total_produced` (measured equal on 10
    // of 10 months, max gap 0.0 kg). One field, one definition; a second
    // would be a second definition waiting to drift.
    read: (m) => t(m.producedKg),
    deltaMode: "pct",
    // Deliberately NOT divisible by working days — see the band's header.
    perWorkingDay: false,
    price: false,
    chart: "bar",
    color: "var(--chart-2)",
    avgColor: "var(--chart-4)",
    decimals: 1,
    dependsOn: ["production"],
    dictionary: {
      definition: "How much finished charcoal the plant actually made that month.",
      basis:
        "The month's production entries added up, taken straight from the RC Movement production view rather than counted again — so this row and the RC Movement screen can never disagree, and the grade mix below is literally the same arithmetic split by product.",
      exclusions:
        "Nothing. Every grade and every shift is in here. What went IN is the RC OUT row; what came out is this.",
      rollup: "Quarters and years are plain sums of their months.",
      source: "view_analytics_production_monthly.produced_kg",
      caveat:
        "Daily production reporting only began on 27 November 2025, so this row is BLANK — never zero — before then. November 2025 itself is a three-day month inside a full calendar month, so it is excluded from every headline on this page and should not be compared with anything.",
    },
  },
  {
    key: "production_per_day",
    label: "Output per reported day",
    sublabel: "tonnes / day reported",
    unit: "tonnes",
    rollup: "weighted",
    read: (m) => t(m.producedPerReportedDay),
    numerator: (m) => t(m.producedKg),
    denominator: (m) => m.reportedDays,
    deltaMode: "pct",
    perWorkingDay: false,
    price: false,
    chart: "bar",
    color: "var(--chart-1)",
    avgColor: "var(--chart-3)",
    decimals: 1,
    dependsOn: ["production"],
    dictionary: {
      definition:
        "How much the plant made on a day it was actually running — the fair way to compare a short month with a long one.",
      basis:
        "Tonnes produced ÷ the number of days production reported that month.",
      exclusions:
        "Days production did not report are not in the denominator, so a rest day or a shutdown cannot dilute the figure.",
      rollup:
        "A quarter or a year is total tonnes ÷ total reported days across its months — never the mean of the monthly rates.",
      source: "view_analytics_production_monthly.produced_per_reported_day",
      caveat:
        "The denominator is PRODUCTION'S OWN reported days, not the Working days row above, and the two are different questions: the yard can take in charcoal on a day the plant does not run. That is also why the per-working-day toggle deliberately leaves this band alone — dividing the plant's tonnage by the yard's activity would silently change what the number means.",
    },
  },
  {
    key: "downtime_hours",
    label: "Downtime",
    sublabel: "hours lost",
    unit: "hours",
    rollup: "sum",
    read: (m) => m.downtimeHrs,
    deltaMode: "abs",
    perWorkingDay: false,
    price: false,
    chart: "bar",
    color: "var(--chart-5)",
    avgColor: "var(--chart-3)",
    decimals: 2,
    dependsOn: ["production"],
    annotate: downtimeAnnotation,
    dictionary: {
      definition:
        "How many hours the plant stood still that month, as the shift reports recorded it.",
      basis:
        "The hours-and-minutes pair on each shift's downtime record, folded exactly the way the Daily production ledger folds it — the same SQL definition, selected rather than written a second time. They are two components of ONE duration, not alternates.",
      exclusions:
        "A shift that filed no downtime record at all is not counted as zero downtime — it is simply not in the sum.",
      rollup: "Quarters and years are plain sums of their months.",
      source: "view_analytics_production_monthly.downtime_hrs",
      caveat:
        "A ZERO HERE CAN MEAN TWO VERY DIFFERENT THINGS, so read it with the ⚠. In August 2026 all 23 shifts named a repair — cleaned a screen, changed a spring — and every one of them left the duration at zero. The work was recorded; the number stopped being filled in. That month reads 0.00 hours and it was not a flawless month, so the cell is marked and can never be quoted as a record.",
    },
  },
  {
    key: "power_kwh",
    label: "Power",
    sublabel: "kWh metered",
    unit: "kwh",
    rollup: "sum",
    read: (m) => m.kwh,
    deltaMode: "pct",
    perWorkingDay: false,
    price: false,
    chart: "bar",
    color: "var(--chart-3)",
    avgColor: "var(--chart-4)",
    decimals: 0,
    // NO `dependsOn`. The meters start March 2025 and production reporting
    // starts November 2025, so eight months carry power and no output at all.
    // Declaring a production dependency would have blanked eight months of
    // real metered electricity — 577,438 kWh — and called it "not reported".
    annotate: powerAnnotation,
    dictionary: {
      definition:
        "How much electricity the site drew that month, across every meter — the same figure the home dashboard shows day by day.",
      basis:
        "Each daily reading's consumption, multiplier applied, added up over the month.",
      exclusions:
        "Nothing. The raw total is published exactly as metered, including a reading we can prove is wrong — see the note.",
      rollup: "Quarters and years are plain sums of their months.",
      source: "view_analytics_production_monthly.kwh",
      caveat:
        "One reading on 1 March 2026 was mis-keyed — a starting reading left at zero against an end that was still climbing — and at a ×120 multiplier that single row publishes 676,944 kWh into a month whose real consumption is about 20,000. It is marked with a ⚠ and NOT corrected here: this row is the metered record, and repairing the reading is Renzo's call and a separate, audited write. Also worth knowing that only the MAIN meter has reported since December 2025 — the bunkhouse and pump meters stopped — so the meter count reads 1 from January 2026 on.",
    },
  },
  {
    key: "power_intensity",
    label: "Power intensity",
    sublabel: "kWh / kg made",
    unit: "kwh_per_kg",
    rollup: "weighted",
    read: (m) => m.kwhPerProducedKg,
    // NULL-STRICT and PAIRED — see `intensityUsable`.
    numerator: (m) => (intensityUsable(m) ? m.kwh : null),
    denominator: (m) => (intensityUsable(m) ? m.producedKg : null),
    deltaMode: "pct",
    perWorkingDay: false,
    price: false,
    chart: "line",
    color: "var(--chart-4)",
    avgColor: "var(--chart-3)",
    decimals: 4,
    dependsOn: ["production"],
    annotate: powerIntensityAnnotation,
    dictionary: {
      definition:
        "Units of electricity per kilo of product — the number that says whether the plant is getting more or less efficient at what it does.",
      basis: "The month's metered kWh ÷ the kilos it produced.",
      exclusions:
        "A month containing a meter reading we can prove is mis-keyed is left out entirely rather than valued on a broken number, and so is its contribution to any quarter or year it belongs to.",
      rollup:
        "A quarter or a year is total kWh ÷ total kilos produced across its unaffected months — never the mean of the monthly intensities.",
      source: "view_analytics_production_monthly.kwh_per_produced_kg",
      caveat:
        "BLANK, never wrong. A bad meter reading here does not look wrong, it looks like a finding: March 2026 would read 0.7630 against neighbours reading 0.03 — a twenty-fold efficiency collapse that never happened — so that month is suppressed and the honest figure with the broken reading removed (0.0219) is printed beside the ⚠ instead. November 2025 is the opposite case and is deliberately NOT suppressed: it divides 24 days of metering by 3 days of output and reads 1.2766, which is factually RIGHT and merely not comparable. Suppressing a correct number is how a page starts lying, so it is published and held out of the headlines instead.",
    },
  },
  {
    key: "sacks_counted",
    label: "Bags counted",
    sublabel: "sacks",
    unit: "count",
    rollup: "sum",
    read: (m) => m.sacks,
    deltaMode: "pct",
    perWorkingDay: false,
    price: false,
    chart: "bar",
    color: "var(--chart-1)",
    avgColor: "var(--chart-4)",
    decimals: 0,
    dependsOn: ["production"],
    annotate: sacksAnnotation,
    dictionary: {
      definition: "How many bags the month's production entries recorded.",
      basis: "The bag counts on the month's production runs, added up.",
      exclusions:
        "A run that recorded no bag count is not counted as zero bags — it is simply not in the sum, and the coverage note says how many such runs there were.",
      rollup: "Quarters and years are plain sums of their months.",
      source: "view_analytics_production_monthly.sacks",
      caveat:
        "BAGS DID NOT EXIST BEFORE MAY 2026 — not one production run recorded a count before then, so those months are BLANK rather than zero. May 2026 itself covers 1 run out of 38, so its 270 bags describe a single entry; June onward is effectively complete. A cell whose coverage is short is marked and can never be quoted as a record.",
    },
  },
] as const;

/**
 * THE registry — P1 rows, then P2 money rows, then P4 production rows,
 * section stamped by construction so a row can never be filed under the wrong
 * band by hand.
 */
export const METRICS: readonly MetricSpec[] = [
  ...FLOW_METRICS.map((m): MetricSpec => ({ ...m, section: "flow" })),
  ...MONEY_METRICS.map((m): MetricSpec => ({ ...m, section: "money" })),
  ...PRODUCTION_METRICS.map((m): MetricSpec => ({ ...m, section: "production" })),
];

/** Lookup by key — the registry is small enough that a map is built once. */
export const METRIC_BY_KEY: ReadonlyMap<MetricKey, MetricSpec> = new Map(
  METRICS.map((m) => [m.key, m]),
);

/** The rows the working-day toggle actually changes. */
export const PER_WORKING_DAY_KEYS: readonly MetricKey[] = METRICS.filter(
  (m) => m.perWorkingDay,
).map((m) => m.key);
