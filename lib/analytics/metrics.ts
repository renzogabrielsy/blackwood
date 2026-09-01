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
// Pure and client-safe: no React, no Supabase, no `server-only`.
// =====================================================================

import type { AnalyticsMonth } from "./types";

/** The twelve Phase-1 rows, in display order. */
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
  | "working_days";

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
export type MetricUnit = "php_per_kg" | "php" | "tonnes" | "count" | "days";

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
  dictionary: MetricDictionaryEntry;
}

const KG_PER_TONNE = 1000;

/** kg → tonnes, preserving null. The matrix is in tonnes; drill-downs stay in kg. */
function t(kg: number | null | undefined): number | null {
  return kg == null ? null : kg / KG_PER_TONNE;
}

// ---------------------------------------------------------------------
// The registry
// ---------------------------------------------------------------------

export const METRICS: readonly MetricSpec[] = [
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
        "Our own charcoal returning from sun-drying and anything re-cooked or re-fed are left out: we already paid for those kilos once, and the peso figure on a re-cook is a ₱1.50–₱1.75 processing fee, not a market price. A truckload still waiting on its price is left out of BOTH halves of the sum rather than counted as free.",
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

/** Lookup by key — the registry is small enough that a map is built once. */
export const METRIC_BY_KEY: ReadonlyMap<MetricKey, MetricSpec> = new Map(
  METRICS.map((m) => [m.key, m]),
);

/** The rows the working-day toggle actually changes. */
export const PER_WORKING_DAY_KEYS: readonly MetricKey[] = METRICS.filter(
  (m) => m.perWorkingDay,
).map((m) => m.key);
