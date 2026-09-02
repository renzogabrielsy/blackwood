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
// **OWNER FEEDBACK R4 (2026-09-02) dissolved the MONEY band.** Phase 2 put
// eight calendar-basis money rows here; five are retired and three moved to
// the block that owns their question (see `MetricKey` below for the map and
// the reasoning). The `MetricSpec.estimated` machinery those rows used is
// deliberately LEFT IN PLACE — no row declares it today, and the day one
// does, the `~` mark, its hover and the callout gate all still work.
//
// Two conventions from that era are still load-bearing and are obeyed here
// rather than re-litigated per component:
//
//   1. **NULL is never 0.** A figure with no sound denominator reads blank,
//      and the row's dictionary says why.
//   2. **Percent vs fraction.** `yield_pct` and `loss_pct` are FRACTIONS in
//      SQL; `pct_over_120d` is already a PERCENT. The `read` functions are
//      the ONE place the ×100 happens.
//
// Pure and client-safe: no React, no Supabase, no `server-only`.
// =====================================================================

import type { AnalyticsMonth } from "./types";

/**
 * The ten RC Inventory rows + the eight production rows, in display order.
 *
 * ── OWNER FEEDBACK ROUND 1 (2026-09-01) — FOUR ROWS RETIRED ─────────────
 * Renzo read the live page and cut `sundry_reentry`, `runway`,
 * `active_batches` and `working_days`: none of them was a number he acts on,
 * and twelve rows in the volume band was a wall. **Only the ROWS went.** Every
 * underlying field still crosses the wire and is still read elsewhere —
 * `workingDays` is the divisor behind the per-working-day toggle (which is why
 * that toggle keeps working with its row gone), and the sundry kilos are the
 * supplier room's ↩ column. Nothing in SQL changed.
 *
 * `active_suppliers` was on that list and Renzo put it back — it stays.
 *
 * ── OWNER FEEDBACK ROUND 4 (2026-09-02) — THE MONEY SECTION IS DISSOLVED ─
 * Renzo: *"money is redundant, most of it is analyzable in the by-production
 * batch section."* He is right, and the reason is a CLOCK, not a duplication:
 * the money band's Block price was the CALENDAR-month basis of the very figure
 * the campaign panel already publishes on the CAMPAIGN basis — the same fact
 * read against two different clocks, and a campaign is the clock the plant
 * actually runs on (AUGUST closed and SEPTEMBER opened on 2026-08-29). Where a
 * money row survived, it moved to the block that owns its question:
 *
 *   • `delivered_fed_price` (Block price) · `php_per_produced` ·
 *     `closed_true_price` — **RETIRED.** The campaign panel carries BOTH bases
 *     (block price and true price, ₱ per produced kg on both), so nothing is
 *     lost. Every underlying field still crosses the wire, exactly as the R1
 *     retirements did; no view and no column changed.
 *   • `closed_blocks` · `closed_loss` — **moved to the campaign panel**, where
 *     "blocks closed" and "weight lost" are per-campaign facts rather than
 *     per-calendar-month ones.
 *   • `stock_age` · `over_120d` — **moved into RC Inventory**, which is where
 *     a reader already is when they ask how old the yard is. They carry no ₱
 *     and never did.
 *   • `yield_rate` — **moved into Production**, beside the output it divides,
 *     and joined by its complement `process_loss`.
 */
export type MetricKey =
  | "market_price"
  | "purchase_volume"
  | "active_suppliers"
  | "rc_in_total"
  | "rc_out"
  | "net_flow"
  | "ending_inventory"
  | "inventory_value"
  | "stock_age"
  | "over_120d"
  // ── P4, the production layer ──────────────────────────────────────
  | "production_output"
  | "production_per_day"
  | "yield_rate"
  | "process_loss"
  | "downtime_hours"
  | "power_kwh"
  | "power_intensity"
  | "sacks_counted";

/**
 * The visual bands of the matrix. Two since R4 dissolved the money band —
 * purely presentational, nothing about a rollup depends on it.
 */
export type MetricSection = "flow" | "production";

/**
 * The five reading blocks of the page and the accent each one wears.
 *
 * `accentVar` names a custom property declared in `globals.css` (both themes).
 * It is applied INLINE as `--bw-accent` so a component can wear a section's
 * colour without a dynamic Tailwind class — and it is only ever a RULE or a
 * label tint, never a background on a frozen pane, which must stay opaque.
 *
 * Aesthetic identity only: a section colour says where you are, it never says
 * a number is good or bad. The page still has no threshold semantics.
 */
export type SectionAccentKey =
  | "flow"
  | "money"
  | "campaigns"
  | "suppliers"
  | "production";

export const SECTION_ACCENT: Record<SectionAccentKey, string> = {
  flow: "var(--bw-sec-flow)",
  money: "var(--bw-sec-money)",
  campaigns: "var(--bw-sec-campaigns)",
  suppliers: "var(--bw-sec-suppliers)",
  production: "var(--bw-sec-production)",
};

export const SECTIONS: readonly {
  key: MetricSection;
  label: string;
  hint: string;
  accent: string;
}[] = [
  {
    // OWNER FEEDBACK R4: "Volume & stock" is now **RC Inventory**, and it
    // absorbed the two aging rows. The block answers one question end to end —
    // what came in, what went out, what is standing in the yard and how old it
    // is — which is what makes the name a description rather than a label.
    key: "flow",
    label: "RC Inventory",
    hint:
      "What moved through the yard, what is left standing in it, what that stock cost and how old it is.",
    accent: SECTION_ACCENT.flow,
  },
  {
    key: "production",
    label: "Production",
    hint:
      "What the plant made, how long it stood still, and what it burned doing it. No ₱ anywhere in this band.",
    accent: SECTION_ACCENT.production,
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


// ---------------------------------------------------------------------
// The registry
// ---------------------------------------------------------------------

/**
 * RC INVENTORY — what moved, what is left standing, what it cost and how old
 * it is. Section assigned below.
 *
 * The last two rows (`stock_age`, `over_120d`) arrived here in owner feedback
 * R4 from the dissolved money band. They read `view_analytics_aging_eom`,
 * which is ₱-FREE by construction, so moving them changed no gate: the whole
 * aging story stays visible to the Production role exactly as it was.
 */
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
      definition: "What a kilo of bought charcoal cost us, on average, that month.",
      basis: "Total pesos paid ÷ total kilos priced. Weighted, not an average of averages.",
      exclusions:
        "Sun-dried returns and re-cooks: we already paid for those kilos once. A truckload still waiting on its price is out of both halves, never counted as free.",
      rollup: "A quarter or a year is total pesos ÷ total kilos, not the mean of the months.",
      source: "view_analytics_rcin_monthly.market_avg_price",
      caveat: "Every delivery on record is priced today, so coverage reads 100%.",
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
      definition: "How much charcoal we actually bought that month.",
      basis: "The delivered weights on market deliveries, added up.",
      exclusions:
        "Sun-dried returns and re-cooks. Counting them would book the same kilos twice.",
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
      definition: "How many different suppliers actually sold to us that month.",
      basis: "Distinct suppliers on market deliveries, spelling variants folded together.",
      exclusions:
        "A sun-dried return carries its origin supplier's name but is not a sale, so it does not make them active.",
      rollup:
        "A quarter or a year shows its BUSIEST MONTH, not the distinct sellers across the period — monthly counts cannot be added without double-counting anyone who sold twice.",
      source: "view_analytics_rcin_monthly.active_suppliers",
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
        "Everything that rolled through the gate — bought, returned from drying and re-cooked alike.",
      basis: "Every delivery's weight for the month, added up.",
      exclusions:
        "Nothing. The yard does not care who owned the kilos; Purchase volume is the row that does.",
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
      basis: "Every feeding's weight, added up.",
      exclusions: "Nothing.",
      rollup: "Quarters and years are plain sums of their months.",
      source: "view_analytics_flow_monthly.out_kg",
      caveat:
        "Feedings were only written down from January 2024. Earlier months are blank, never zero — a zero would sum into a year as if the plant had fed nothing.",
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
        "Did the pile grow or shrink. Positive means we built stock; negative means we ate into it.",
      basis: "Everything in, minus everything fed.",
      exclusions: "Nothing.",
      rollup: "Quarters and years are plain sums of their months.",
      source: "view_analytics_flow_monthly.net_kg",
      caveat: "Blank before January 2024 — half the subtraction did not exist yet.",
    },
  },
  {
    key: "ending_inventory",
    label: "Ending inventory",
    sublabel: "tonnes on hand",
    unit: "tonnes",
    rollup: "periodEnd",
    // ── OWNER FEEDBACK R1: the OPEN-PILES basis ─────────────────────────
    // This row has now been wrong in two directions, and the second one is
    // the instructive one.
    //
    // It began on `endingKg`, the NET of every batch balance: 8,492 t against
    // a Blocking screen reading 10,000+. Renzo: "kind of a weird basis." It
    // is — the net silently subtracts ~3,200 t of BOOKKEEPING, batches
    // carrying a negative balance because charcoal was fed out under one
    // spelling of a name whose arrival was booked under another. Nothing
    // evaporated.
    //
    // The first fix over-corrected to `positiveBalanceKg` (11,707.9 t), which
    // bounces off Renzo's anchor from the OTHER side, because it folds in
    // 1,214.6 t of CLOSED-BLOCK RESIDUE. Per the project's standing resiko
    // doctrine that residue is LOSS — weight that evaporated in the yard and
    // is still logged — never stock anyone can walk out and use. A stock row
    // that counts it is not a stock row.
    //
    // So the headline is `openKg`: every pile with a positive balance that
    // was NOT YET CLOSED at that month-end. Two properties make it the right
    // one rather than merely the closest:
    //   • it is Renzo's own anchor — `view_blocking_grid`'s population;
    //   • it is AS-OF, not a snapshot of today. `view_analytics_aging_eom`
    //     tests `close_date IS NULL OR close_date > as_of_date`, so a block
    //     closed last week still counts in the months it was open. A
    //     current-`status` rule would have retroactively emptied history.
    // Measured: non-null and non-zero on all 75 months of the spine, so the
    // row can never go structurally blank.
    //
    // Tie, 2026-09-01: 10,493,304 kg here − 18,650 kg (the L-042
    // AUGUST-26-FEED2 phantom, which carries no `location_ref` and so has no
    // cell in the 220-slot grid) = 10,474,654 kg — `view_blocking_grid`'s
    // grand total to the kilo. Both the residue and the phantom are printed
    // in the row's expand rather than quietly netted away.
    read: (m) => t(m.openKg),
    deltaMode: "pct",
    perWorkingDay: false,
    price: false,
    chart: "bar",
    color: "var(--chart-2)",
    avgColor: "var(--chart-4)",
    decimals: 1,
    dictionary: {
      definition:
        "How much usable charcoal was standing in the yard when the month closed — the same piles the Blocking screen counts.",
      basis:
        "Every still-open pile with a positive balance, added up. Rebuilt from the delivery and feeding rows, never snapshotted, so correcting an old record correctly restates an old month.",
      exclusions:
        "Closed-block residue — about 1,215 t of weight that evaporated but is still logged. It is loss, not stock. Piles with a negative balance are also out: they are bookkeeping, not missing charcoal.",
      rollup: "A quarter or a year shows the month-end level. A stock is not additive.",
      source: "view_analytics_aging_eom.open_kg",
      caveat:
        "Whether a pile was open is judged as of THAT month-end, not today, so closing a block this week does not empty last year. It ties to the Blocking grand total bar one pile — AUGUST-26-FEED2, 18.7 t, which has no block location and so has no cell in the grid.",
    },
  },
  {
    // ── OWNER FEEDBACK R4: a WEIGHTED AVERAGE, not a total ───────────────
    // Renzo asked for the average unit cost of the stock on hand instead of
    // the ₱ total. The total was a magnitude that moved mostly because the
    // YARD moved — a big month of deliveries lifts it whatever prices did —
    // so it answered "how much charcoal do we have" a second time rather than
    // "what is it worth per kilo", which is the question the row above it does
    // NOT answer. The average is the figure that moves when PRICE moves.
    //
    // `avg_unit_cost_php_kg` is the view's OWN column (`ending_value_php ÷
    // valued_kg`), so nothing here divides two published figures and invents a
    // third definition of what a kilo cost — the exact thing `avg_cost` was
    // narrowed to prevent (BUG-018 / L-039). The key is unchanged, so every
    // `?metric=inventory_value` deep link still resolves.
    key: "inventory_value",
    label: "Stock avg cost",
    sublabel: "₱/kg on hand",
    unit: "php_per_kg",
    rollup: "periodEnd",
    read: (m) => m.avgUnitCostPhpKg,
    deltaMode: "pct",
    perWorkingDay: false,
    price: true,
    chart: "line",
    color: "var(--chart-4)",
    avgColor: "var(--chart-3)",
    decimals: 2,
    dictionary: {
      definition:
        "What the average kilo standing in the yard had COST us at month-end — not what it would fetch.",
      basis:
        "Every valued pile's remaining kilos at that pile's own weighted purchase cost, divided by those kilos. A weighted average, never the mean of the piles' prices.",
      exclusions:
        "Piles with a negative balance, and kilos with no price at all — an unpriced truckload is in neither half rather than counted as free. It does not carry the extra cost of charcoal that shrank while it sat; that is the campaign panel's true price.",
      rollup: "The month-end figure. An average cost is a state, not a sum.",
      source: "view_analytics_inventory_eom.avg_unit_cost_php_kg",
      // ── THE ONE PLACE THE TWO STOCK ROWS DO NOT AGREE, SAID OUT LOUD ──
      // The Ending inventory row above moved to the OPEN-PILES basis in owner
      // feedback R1; this row is measured over every POSITIVE balance, closed
      // blocks included, because `view_analytics_inventory_eom` has no notion
      // of a close date at all — it derives balances from `batch_code` deltas
      // and never joins `batches`. Making the two agree is a new SQL column,
      // not a client-side division. The gap is DISCLOSED, not papered over —
      // and note it matters far LESS to an average than it did to the total it
      // replaced: residue is 8.19% of the value against a similar share of the
      // kilos, so it moves a ₱/kg figure barely at all.
      caveat:
        "Measured over a slightly wider set of piles than the row above — closed-block residue is still in it, 8.19% of the valued money today. Being a ratio, that shifts the figure far less than it shifted the ₱ total this row replaced. The expand prints the valued and unvalued kilos and the ₱ total behind it.",
    },
  },
  // ── The two aging rows, moved here from the dissolved money band (R4) ──
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
        "How old the charcoal standing in the yard was at month-end, averaged by weight — a big fresh pile pulls it down, a small old one barely moves it.",
      basis:
        "Each pile takes the weighted average delivery date of everything tipped into it, and its whole remaining balance carries that one age.",
      exclusions:
        "Closed blocks and negative balances. A closed block's logged remainder is evaporated weight, not stock; counting it made the yard read 416 days old instead of 387.",
      rollup: "A quarter or a year shows the month-end figure. An age is a state, not a sum.",
      source: "view_analytics_aging_eom.wtd_age_days",
      caveat:
        "No first-in-first-out, and none is possible: the feeding records say which PILE kilos left, never which truckload. Deliveries into one pile land days apart, so the error is small against ages in the hundreds of days.",
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
        "How much of the yard sat in piles older than four months — the share that is quietly losing weight.",
      basis: "Kilos in open piles over 120 days ÷ all kilos in open piles, at month-end.",
      exclusions: "Same as average stock age: closed-block residue and negative balances.",
      rollup: "A quarter or a year shows the month-end figure. A share is not additive.",
      source: "view_analytics_aging_eom.pct_over_120d",
      caveat:
        "120 days is a reading line, not a policy — nothing turns amber because of it. The 60-day figure and the oldest pile are in the expand.",
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
        ? `All ${shift(reasonOnly)} with a downtime record named the repair and left the duration at zero. This total is a gap in the report, not a period when the plant never stopped. Shown as recorded; never quoted as a record.`
        : `${reasonOnly} of the ${shift(records)} with a downtime record named the repair and left the duration at zero, so these hours are short by an unknown amount. Shown as recorded; never quoted as a record.`,
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
      `${count} meter reading${count === 1 ? "" : "s"} here ${count === 1 ? "is" : "are"} mis-keyed — a start left at zero against an end still climbing — and ${nfmt(suspect)} kWh of this total comes from ${count === 1 ? "it" : "them"}` +
      (share == null ? "" : `, ${nfmt(share, 1)}% of the period`) +
      `. Published exactly as metered: fixing the reading is a separate, audited write. Power intensity is where it is taken out. Never quoted as a record.`,
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
      `Blank rather than wrong: this period holds a mis-keyed meter reading, and an intensity built on it reports an efficiency collapse that never happened (March 2026 would read 0.7630 against neighbours at 0.03). ` +
      (excl != null
        ? `The figure beside the ⚠ is the same sum with the bad reading removed — an estimate, labelled as one.`
        : clean > 0
          ? `The figure above is measured over the ${clean} unaffected month${clean === 1 ? "" : "s"} only.`
          : `Every month here is affected, so there is no honest figure to show.`),
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
      title: `None of the ${runs} production entries here recorded a bag count — bags were only counted from May 2026. Blank, never zero: "we did not count" and "we made none" are different answers.`,
    };
  }
  return {
    mark: "~",
    blocksCallout: true,
    title: `This speaks for ${withSacks} of the period's ${runs} production entries — ${nfmt((100 * withSacks) / runs, 1)}% coverage — so it is a floor, not the period's bags. Never quoted as a record.`,
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

/**
 * May this month contribute to a YIELD (or process-loss) rollup AT ALL?
 *
 * The same predicate as `intensityUsable` above, for the same measured reason,
 * and it was a real bug found while moving the Yield row into this band in
 * owner feedback R4. A weighted rollup sums numerator and denominator
 * INDEPENDENTLY, and the spine carries months with FED kilos and no production
 * at all — feedings begin 2024-01, production reporting begins 2025-11. A
 * quarter or a year spanning that boundary put ten months of fed kilos into the
 * denominator against two months of product in the numerator: **2025 read a
 * 2.5% yield instead of ~14%**, and the `num.had === 0` guard could not catch
 * it because two of the twelve months genuinely did report.
 *
 * So both halves gate on ONE predicate: a month counts only if it has fed kilos
 * AND a produced figure to divide them by. `dependsOn` does not do this job —
 * it decides what a BLANK means, not which months an average may be built from.
 */
function yieldUsable(m: AnalyticsMonth): boolean {
  return m.fedKg != null && m.fedKg > 0 && m.producedKg != null;
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
      definition: "How much finished charcoal the plant made that month.",
      basis:
        "The month's production entries, taken straight from the RC Movement production view rather than counted again — so this row and that screen cannot disagree.",
      exclusions: "Nothing. Every grade and every shift. What went IN is the RC OUT row.",
      rollup: "Quarters and years are plain sums of their months.",
      source: "view_analytics_production_monthly.produced_kg",
      caveat:
        "Daily reporting began 27 November 2025, so earlier months are blank, never zero. November itself is three days inside a full month and is kept out of every headline.",
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
      basis: "Tonnes produced ÷ the days production reported that month.",
      exclusions:
        "Days production did not report are out of the denominator, so a rest day cannot dilute the figure.",
      rollup:
        "A quarter or a year is total tonnes ÷ total reported days, not the mean of the months.",
      source: "view_analytics_production_monthly.produced_per_reported_day",
      caveat:
        "The denominator is PRODUCTION'S own reported days, not days the yard was busy — the yard can take charcoal in on a day the plant does not run. That is also why the per-working-day toggle leaves this whole band alone.",
    },
  },
  // ── Yield and its complement (owner feedback R4) ─────────────────────
  // Yield arrived here from the dissolved money band. It belongs beside the
  // output it divides: it is a statement about the PLANT (how much product
  // came out of what went in), not about what anything cost, and it carries no
  // ₱ — which is why moving it changed no gate.
  {
    key: "yield_rate",
    label: "Yield",
    sublabel: "% of fed kilos",
    unit: "pct",
    rollup: "weighted",
    read: (m) => pct(m.yieldPct),
    // ×100 on the NUMERATOR so the weighted rule stays Σnum ÷ Σden and the
    // result lands in percent — there is no second scaling step to forget.
    // BOTH halves gate on `yieldUsable`: see that function for the measured
    // reason (2025 read 2.5% against a real ~14% before it existed).
    numerator: (m) =>
      yieldUsable(m) && m.producedKg != null ? m.producedKg * 100 : null,
    denominator: (m) => (yieldUsable(m) ? m.fedKg : null),
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
        "Kilos produced ÷ kilos fed. The change under a cell is in percentage POINTS, not a percentage of a percentage.",
      exclusions:
        "A month that fed charcoal before production reporting existed is out of BOTH halves — counting its kilos in the denominator alone would have read 2025 as a 2.5% yield.",
      rollup: "A quarter or a year is total produced ÷ total fed, not the mean of the months.",
      source: "view_analytics_cost_monthly.yield_pct",
      caveat:
        "Blank before November 2025, never 0% — a zero would roll into a year as if the plant had turned eight thousand tonnes into nothing. November itself is a part-month at 11.9% and is kept out of the headlines.",
    },
  },
  {
    // ── OWNER FEEDBACK R4 — the other side of the same fraction ─────────
    // Renzo: "what the kilns ate." Yield says what came out; this says what
    // did not, and the two are the same measurement read from opposite ends.
    // It is a SEPARATE ROW rather than a hover on the yield row because it is
    // the number he wants to watch move — a loss going up is the alarming
    // reading of a yield going down, and a page that only prints the cheerful
    // half makes the reader do the subtraction.
    //
    // `read` is literally `1 − yield`, so the two rows always sum to exactly
    // 100 in a MONTH cell; the weighted rollup is Σ(fed − produced) ÷ Σ fed,
    // which is algebraically 1 − Σproduced ÷ Σfed, so they sum to 100 in a
    // quarter and a year too. Same `yieldUsable` gate on both halves.
    key: "process_loss",
    label: "Process loss",
    sublabel: "% of fed kilos",
    unit: "pct",
    rollup: "weighted",
    read: (m) => (m.yieldPct == null ? null : (1 - m.yieldPct) * 100),
    numerator: (m) =>
      yieldUsable(m) && m.fedKg != null && m.producedKg != null
        ? (m.fedKg - m.producedKg) * 100
        : null,
    denominator: (m) => (yieldUsable(m) ? m.fedKg : null),
    deltaMode: "abs",
    perWorkingDay: false,
    price: false,
    chart: "line",
    color: "var(--chart-5)",
    avgColor: "var(--chart-3)",
    decimals: 1,
    dependsOn: ["outflow", "production"],
    dictionary: {
      definition:
        "What the kilns ate — the difference between the charcoal fed in and the product that came out.",
      basis:
        "Kilos fed minus kilos produced, over kilos fed. Exactly one hundred minus the yield above it, by construction rather than by coincidence.",
      exclusions:
        "Same as yield: a month that fed charcoal before production reporting existed is out of both halves.",
      rollup:
        "A quarter or a year is total kilos lost ÷ total kilos fed, not the mean of the months. It still adds to exactly 100 with the yield beside it.",
      source: "view_analytics_cost_monthly.yield_pct (its complement)",
      caveat:
        "This is cooking loss, not yard loss. Weight that evaporated while charcoal SAT is a different figure and lives on the campaign panel as Weight lost. The change under a cell is in percentage POINTS.",
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
      definition: "How many hours the plant stood still that month, as the shift reports recorded it.",
      basis:
        "The hours-and-minutes pair on each shift's downtime record, folded the same way the Daily production ledger folds it. Two halves of one duration, not alternatives.",
      exclusions:
        "A shift that filed no downtime record is not counted as zero downtime — it is simply not in the sum.",
      rollup: "Quarters and years are plain sums of their months.",
      source: "view_analytics_production_monthly.downtime_hrs",
      caveat:
        "A zero here means two different things, so read it with the ⚠. In August 2026 all 23 shifts named a repair and every one left the duration blank: the work was recorded, the number stopped being. That month reads 0.00 h and was not a flawless month.",
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
        "How much electricity the site drew that month, across every meter — the same figure the home dashboard shows daily.",
      basis: "Each daily reading's consumption, multiplier applied, added up.",
      exclusions:
        "Nothing. The total is published exactly as metered, including a reading we can prove is wrong.",
      rollup: "Quarters and years are plain sums of their months.",
      source: "view_analytics_production_monthly.kwh",
      caveat:
        "One reading on 1 March 2026 was mis-keyed, and at a ×120 multiplier it alone publishes 676,944 kWh into a month whose real draw is about 20,000. Marked ⚠ and NOT corrected here — this row is the metered record. Only the MAIN meter has reported since December 2025.",
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
        "Units of electricity per kilo of product — whether the plant is getting more or less efficient.",
      basis: "The month's metered kWh ÷ the kilos it produced.",
      exclusions:
        "A month holding a mis-keyed meter reading is left out entirely, here and in any quarter or year it belongs to.",
      rollup:
        "A quarter or a year is total kWh ÷ total kilos produced across its clean months, not the mean of the monthly rates.",
      source: "view_analytics_production_monthly.kwh_per_produced_kg",
      caveat:
        "Blank rather than wrong. March 2026 would read 0.7630 against neighbours at 0.03 — a collapse that never happened — so it is suppressed and the figure without the bad reading (0.0219) prints beside the ⚠. November 2025 reads 1.2766 and is NOT suppressed: it is correct, just not comparable.",
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
        "A run with no bag count is not counted as zero bags — it is simply not in the sum, and the ~ says how many such runs there were.",
      rollup: "Quarters and years are plain sums of their months.",
      source: "view_analytics_production_monthly.sacks",
      caveat:
        "Bags were not counted before May 2026, so those months are blank rather than zero. May itself covers 1 run of 38, so its 270 bags describe a single entry; June onward is effectively complete.",
    },
  },
] as const;

/**
 * THE registry — the RC Inventory rows, then the production rows, section
 * stamped by construction so a row can never be filed under the wrong band by
 * hand. (The money band between them was dissolved in owner feedback R4; every
 * field it read still crosses the wire.)
 */
export const METRICS: readonly MetricSpec[] = [
  ...FLOW_METRICS.map((m): MetricSpec => ({ ...m, section: "flow" })),
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
