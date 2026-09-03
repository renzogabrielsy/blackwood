// =====================================================================
// ICTC Owner Analytics — THE CAMPAIGN TABLE (owner feedback R7)
// =====================================================================
// ONE table, one clock, ELEVEN rows (sixteen until R8): what a production
// campaign FED, what that charcoal COST and what the plant MADE from it. It
// replaces two tables that sat one above the other.
//
// ── R8 TOOK FIVE ROWS OFF IT, AND ONLY OFF IT ─────────────────────────
// Renzo, 2026-09-03, after reading the shipped page: remove Output per
// reported day, Downtime, Power, Power intensity and Bags counted **for now**.
// The words "for now" are load-bearing and the change obeys them literally —
// **not one query, view, adapter field or type moved.** Every figure those
// five rows published still crosses the wire on `ProductionBatchRow` and is
// still folded by `campaign-room.tsx` for the selection strip. This is a
// PRESENTATION removal, so restoring any of the five is one entry in the
// registry below plus (for four of them) its annotation.
//
// A `?metric=` link naming a removed row resolves to NOTHING and the page
// renders whole at the section top: `resolveMetric` in `page.tsx` tests
// `CAMPAIGN_METRIC_BY_KEY.has(...)`, which is built from this registry, so a
// key that names no row is simply not "known". No alias was invented for them
// — R7's `RETIRED_METRIC_ALIASES` exists for rows whose QUESTION moved to
// another row, and none of these five has a home to be redirected to.
//
// ── WHY THE MERGE ─────────────────────────────────────────────────────
// Renzo, 2026-09-02: *"It doesn't make sense for it to be separated and have
// redundant metrics… better to reference all of that in one table."* He is
// describing a duplication that R6 created and then made obvious: the campaign
// panel printed **Produced**, **Yield** and **₱ per produced kg** on the batch
// clock, and the Production band directly beneath it printed **Produced** and
// **Yield** on the same batch clock, from a sibling view built on the SAME
// spine (`campaign_options UNION campaign_yield`). Two tables, two headers, two
// checklists — for one axis whose columns were already index-for-index equal.
//
// So this is a FRONTEND FOLD, not a join anyone had to invent: the two views
// are keyed on `(production_batch, campaign_year)` and the adapter already
// sorts both by `campaignSeq`. No SQL was written for R7.
//
// ── THE ONE PLACE THE TWO SOURCES OVERLAP, AND HOW IT IS SETTLED ──────
// Both views publish `fed_kg` and `yield_pct`, and both take them from
// `view_rc_movement_campaign_yield` (measured: 0 of 32 mismatches). Rather than
// assert that, `foldCampaignRows` COUNTS the disagreements and the room prints
// a line if it ever finds one. The rows themselves pick ONE source each and say
// which, in the dictionary:
//
//   • `fedKg` → the COST view (`view_analytics_batch_cost`), because the money
//     rows are ratios OVER those exact kilos and a headline that disagreed with
//     its own denominator would be worse than one that disagreed with a sibling
//     view.
//   • `producedKg` / `yieldPct` → the PRODUCTION view
//     (`view_analytics_production_by_batch`), because that one is NULL, never
//     0, on the 22 campaigns that predate daily production reporting. The cost
//     view publishes 0 there deliberately — for it that column is a money
//     DENOMINATOR — and a 0 in an owner-facing headline reads as a plant that
//     ran and made nothing.
//
// ── WHY THE CLOCK IS THE BATCH (carried over from R6) ─────────────────
// `production_shifts.production_batch` is NEVER the calendar month of the date.
// Batches run across month boundaries and a changeover day carries two of them
// — AUGUST closed and SEPTEMBER opened on 2026-08-29 — so a calendar month
// splits one campaign's output across two columns and mixes two campaigns into
// one. `yield_rate` here is literally `view_rc_movement_campaign_yield`'s own
// column, SELECTed through the production view rather than recomputed.
//
// ── WHAT IS EXACT AND WHAT IS MAPPED, SAID OUT LOUD ───────────────────
// Tonnage, runs, shifts, reported days, downtime and bags are EXACT: every one
// of those records already carries its own batch tag (measured — 250 of 250
// shifts carry a non-blank batch), so attributing them is a GROUP BY.
// ELECTRICITY is the one MAPPED figure: meter readings carry a date and no
// batch, so a day's consumption goes to the campaign that had most recently
// STARTED — **on a changeover day the power goes to the INCOMING batch**.
//
// Pure and client-safe: no React, no Supabase, no `server-only`.
// =====================================================================

import {
  assembleMatrix,
  type Granularity,
  type Matrix,
  type UnitRules,
} from "./matrix";
import { campaignMonthIndex, campaignSeq } from "./campaign";
import type { MetricSpecOf } from "./metrics";
import type { CampaignCost, ProductionBatchRow } from "./types";

/** The band's fixed grain. Never selectable, never in `?g=`. */
export const CAMPAIGN_GRANULARITY: Granularity = "B";

const KG_PER_TONNE = 1000;

/**
 * ONE production campaign, both halves of it.
 *
 * The two view rows are kept as NAMED HALVES rather than spread into one flat
 * object, and that is deliberate: both carry `productionBatch`,
 * `campaignYear`, `campaignLabel`, `fedKg`, `producedKg` and `yieldPct`, so a
 * spread would settle six collisions silently by declaration order. Here every
 * `read` says which view it is reading, at the point of use, and a reviewer can
 * see it without leaving the line.
 *
 * Both halves are nullable because the fold is an OUTER join. Today the two
 * spines are identical (32 rows each, same keys), and writing the join as if
 * that were guaranteed is how a missing row becomes a crash rather than a blank.
 */
export interface CampaignMatrixRow {
  productionBatch: string;
  campaignYear: number;
  /** `AUGUST 2026` — the identity the `?bhide=` checklist keys on. */
  campaignLabel: string;
  /** `view_analytics_batch_cost` — the money and yard half. */
  cost: CampaignCost | null;
  /** `view_analytics_production_by_batch` — the plant half. */
  batch: ProductionBatchRow | null;
}

/** kg → tonnes, preserving null. The band is in tonnes; rails stay in kg. */
function t(kg: number | null | undefined): number | null {
  return kg == null ? null : kg / KG_PER_TONNE;
}

/**
 * FRACTION → percent, preserving null. The ONE place the ×100 happens for
 * Yield, Process loss and Weight lost — all three are fractions in SQL and stay
 * fractions in the contract, so a reader of this file and a reader of the
 * migration see the same number.
 */
function pct(fraction: number | null | undefined): number | null {
  return fraction == null ? null : fraction * 100;
}

// ---------------------------------------------------------------------
// The fold that makes one row out of two views
// ---------------------------------------------------------------------

/**
 * Two `fed_kg` figures are the SAME figure when they differ by less than a
 * kilo. Both are `view_rc_movement_campaign_yield.total_fed` carried through
 * different views, so the tolerance exists for float round-tripping through
 * PostgREST's JSON, not for a real difference of opinion.
 */
const FED_KG_TOLERANCE = 1;

export interface CampaignFold {
  rows: CampaignMatrixRow[];
  /**
   * Campaigns where the two views' `fed_kg` disagree by more than a kilo.
   * **Measured 0 of 32.** It is counted rather than asserted because the whole
   * merge rests on the two spines being the same spine, and a silent divergence
   * is exactly the thing this page exists not to do. The room prints a line
   * only when this is non-empty, so the normal state is no sentence at all.
   */
  fedKgMismatches: string[];
}

/**
 * OUTER-join the two campaign views on `(production_batch, campaign_year)` and
 * sort them chronologically by the month each campaign is NAMED for — the SAME
 * `campaignSeq` order the adapter already puts both payload arrays in, so the
 * merged columns line up with the `?bhide=` checklist by construction rather
 * than by coincidence.
 */
export function foldCampaignRows(
  costs: readonly CampaignCost[],
  batches: readonly ProductionBatchRow[],
): CampaignFold {
  const byKey = new Map<string, CampaignMatrixRow>();
  const put = (
    productionBatch: string,
    campaignYear: number,
    campaignLabel: string,
  ): CampaignMatrixRow => {
    const key = `${campaignYear}::${productionBatch}`;
    let row = byKey.get(key);
    if (!row) {
      row = { productionBatch, campaignYear, campaignLabel, cost: null, batch: null };
      byKey.set(key, row);
    }
    return row;
  };

  for (const c of costs) {
    put(c.productionBatch, c.campaignYear, c.campaignLabel).cost = c;
  }
  for (const b of batches) {
    put(b.productionBatch, b.campaignYear, b.campaignLabel).batch = b;
  }

  const rows = [...byKey.values()].sort(
    (a, b) =>
      a.campaignYear - b.campaignYear ||
      campaignSeq(a.productionBatch) - campaignSeq(b.productionBatch),
  );

  const fedKgMismatches = rows
    .filter((r) => {
      const a = r.cost?.fedKg;
      const b = r.batch?.fedKg;
      return a != null && b != null && Math.abs(a - b) > FED_KG_TOLERANCE;
    })
    .map((r) => r.campaignLabel);

  return { rows, fedKgMismatches };
}

// ---------------------------------------------------------------------
// The clock's own rules
// ---------------------------------------------------------------------

/**
 * The batch clock's `UnitRules`.
 *
 * **`workingDays` is 0 and that is not a stub.** The per-working-day toggle is
 * the YARD's normalisation, and no row in this band is `perWorkingDay` — the
 * plant's own denominator is `reportedDays`, which is its own row. So the
 * divisor is never reached; returning 0 makes that structural rather than
 * incidental (a `perWorkingDay` row added here would read blank, loudly, rather
 * than quietly dividing by a number nobody defined).
 *
 * **A blank is `no_production` whenever every campaign in the column reported
 * nothing.** 22 of the 32 campaigns predate daily production reporting, and a
 * zero there would read as a plant that ran and made nothing.
 */
export const CAMPAIGN_RULES: UnitRules<CampaignMatrixRow> = {
  workingDays: () => 0,
  structuralBlank: (rows, deps) => {
    if (
      deps.includes("production") &&
      rows.every((r) => !r.batch?.productionReported)
    ) {
      return "no_production";
    }
    return "no_data";
  },
};

// ---------------------------------------------------------------------
// The gates a weighted rollup needs, written once
// ---------------------------------------------------------------------

/**
 * A campaign's DELIVERED kilos, which no view publishes directly.
 *
 * `loss_pct` is `Σ weight_lost_kg ÷ Σ delivered_kg` over the campaign's blocks,
 * so the delivered total is the published numerator divided by the published
 * ratio. That is an INVERSION of the view's own arithmetic — exact, not an
 * estimate, and it is used for exactly one thing: the denominator of the Weight
 * lost row's rollup, so a selection of campaigns is Σ lost ÷ Σ delivered rather
 * than the mean of the campaigns' percentages (the "average of averages" the
 * whole page refuses).
 *
 * A zero `loss_pct` yields null rather than a division by zero, which takes
 * that campaign out of BOTH halves of the rollup — the same discipline
 * `yieldUsable` applies. The per-campaign CELL never touches this: it prints
 * `loss_pct` verbatim.
 */
function campaignDeliveredKg(c: CampaignCost | null): number | null {
  if (!c || c.lossPct == null || c.lossPct === 0 || c.weightLostKg == null) {
    return null;
  }
  return c.weightLostKg / c.lossPct;
}

/** May this campaign contribute to a FED-price rollup? */
function fedPriceUsable(r: CampaignMatrixRow): boolean {
  const c = r.cost;
  return c != null && c.fedKg != null && c.fedKg > 0;
}

/**
 * May this campaign contribute to a YIELD (or process-loss) rollup AT ALL?
 *
 * The same predicate, for the same measured reason: the spine carries campaigns
 * with FED kilos and no production at all (feedings begin 2024-01, production
 * reporting 2025-11), so an ungated weighted rollup would put 22 campaigns of
 * fed kilos into the denominator against 10 campaigns of product in the
 * numerator. `dependsOn` cannot do this job — it decides what a BLANK means,
 * not which units an average may be built from.
 *
 * SEPTEMBER 2026 is the mirror case and is caught by the same clause: it has
 * PRODUCED (7,506 kg) and not yet been fed, so it has a numerator and no
 * denominator, and it stays out of both halves rather than inflating a yield.
 */
function yieldUsable(r: CampaignMatrixRow): boolean {
  const b = r.batch;
  return b != null && b.fedKg != null && b.fedKg > 0 && b.producedKg != null;
}

// ---------------------------------------------------------------------
// R8 — THE FOUR ANNOTATION HELPERS THAT LIVED HERE ARE GONE
// ---------------------------------------------------------------------
//
// `intensityUsable`, `downtimeAnnotation`, `powerAnnotation`,
// `powerIntensityAnnotation` and `sacksAnnotation` existed for exactly the five
// rows Renzo asked to be taken off the table in R8 — Output per reported day,
// Downtime, Power, Power intensity and Bags counted. With no row declaring
// them there is nothing left for them to annotate, and a helper kept "in case"
// is a second, unexercised definition of a caveat.
//
// **NOTHING WAS LOST IN THE DATA.** `view_analytics_production_by_batch` is
// untouched, every field still crosses the wire on `ProductionBatchRow`
// (`downtimeShiftsReasonOnly`, `kwhSuspectReadingCount`, `kwhSuspectKwh`,
// `kwhPerProducedKgExclSuspect`, `runsWithSacks` …), the adapter still reads
// them, and `campaign-room.tsx` still folds them for the selection strip. The
// PRESENTATION dropped; the measurement did not. Restoring a row is a registry
// entry plus its annotation, and the facts each one needs are already here.
//
// The two side rails those rows opened (`DowntimeSplit` / `PowerSplit` in
// `metric-expand.tsx`) are deliberately left in place for the same reason: a
// separate charts pass follows this round, and they are the panels a restored
// row would want back.

/** "17 of 20 blocks closed, 16 priced" — the sentence a blank owes its reader. */
export function coverageSentence(c: CampaignCost | null): string {
  if (!c || c.blocksFed == null) {
    return "This campaign has not fed anything yet, so there is nothing to price.";
  }
  return `${c.blocksClosed ?? 0} of ${c.blocksFed} blocks closed, ${c.blocksInPrice ?? 0} fully priced.`;
}

/**
 * R8 — THE MARK LEGEND, MOVED OUT OF THE FOOTNOTE AND INTO THE DEFINITIONS.
 *
 * The campaign table carried a paragraph under it explaining what a `~` and a
 * `—` mean. Renzo asked for the paragraph to go; the FACT it carried is
 * load-bearing, so it moved into the dictionary entry of every row that can
 * actually print either mark, where the master `Definitions` switch still
 * surfaces it and where a reader meets it beside the figure rather than three
 * screens down. A legend nobody scrolls to is not a legend.
 *
 * Appended to a caveat rather than replacing one: a row's own reason for being
 * partial is more specific than the mark's general meaning, and both are owed.
 */
const MARK_LEGEND =
  " A ~ marks a figure measured over only part of the campaign — either blocks that are not yet closed and priced, or kilos fed out of piles with no delivery record at all. A dash is never a zero: hover it and it says what is missing.";

const TRUE_PRICE_CAVEAT =
  "The true price only exists once EVERY block the campaign fed has been closed AND priced — an open block has no final fed total, and a block with a truckload still awaiting its price has money missing from the sum. Blank rather than wrong." +
  MARK_LEGEND;

// ---------------------------------------------------------------------
// The registry — eleven rows, in the order Renzo asked for
// ---------------------------------------------------------------------
//
// The order is his: what went IN and what it cost (fed · block price · true
// price · storage uplift · weight lost · blocks closed), then what came OUT
// (produced · yield · process loss), then what a kilo of product cost on both
// bases. It reads as one sentence about a campaign rather than as two tables.
//
// R8 removed the fourth movement — what the plant BURNED (output per reported
// day · downtime · power · power intensity · bags) — in full. The order of
// what remains is untouched, so a reader who had learned the table finds every
// surviving row exactly where it was.
//
// **Five rows are `price: true`, and the gate is the SAME one the RC Inventory
// band's Market price row uses** — the adapter nulls every ₱ field before the
// payload leaves the server, so a restricted role's row carries `null` in every
// cell and renders locked. There is nothing here to hide client-side because
// nothing arrived.
//
// **No row is `perWorkingDay`, and that is structural.** The toggle is the
// yard's normalisation and the plant's own denominator is `reportedDays` — a
// distinction R8's removal of the per-reported-day row does not weaken, since
// the answer stays "this table is never divided by the yard's activity".

const CAMPAIGN_METRIC_LIST: readonly Omit<
  MetricSpecOf<CampaignMatrixRow>,
  "section"
>[] = [
  {
    key: "fed_kg",
    label: "Charcoal fed",
    sublabel: "tonnes, this campaign",
    unit: "tonnes",
    rollup: "sum",
    read: (r) => t(r.cost?.fedKg ?? null),
    deltaMode: "pct",
    perWorkingDay: false,
    price: false,
    chart: "bar",
    color: "var(--chart-1)",
    avgColor: "var(--chart-3)",
    decimals: 1,
    dictionary: {
      definition:
        "Everything this campaign fed to the plant, across every day it ran.",
      basis:
        "Every feeding tagged to this batch, added up — destination MAIN only, so a pull taken out of a block for sun-drying is not counted as plant feed.",
      exclusions:
        "Sundry pulls: they left the pile but never reached the tank, and they come back later as a delivery. Counting them would book the same kilos twice.",
      rollup: "A selection of batches is the plain sum of those batches.",
      source: "view_analytics_batch_cost.fed_kg",
      caveat:
        "Measured on the BATCH clock, not the calendar — a campaign straddles month boundaries (AUGUST closed and SEPTEMBER opened on the same day), so this and the Usage row in RC Inventory are the same kilos cut two different ways and will not match month for month. The sibling production view publishes the same figure and the two are checked against each other on every render.",
    },
  },
  {
    key: "delivered_fed_price",
    label: "Block price",
    sublabel: "₱/kg on arrival",
    unit: "php_per_kg",
    rollup: "weighted",
    read: (r) => r.cost?.deliveredPhpKgFed ?? null,
    numerator: (r) => (fedPriceUsable(r) ? (r.cost?.fedValuePhp ?? null) : null),
    denominator: (r) => (fedPriceUsable(r) ? (r.cost?.fedKg ?? null) : null),
    deltaMode: "pct",
    perWorkingDay: false,
    price: true,
    chart: "line",
    color: "var(--chart-4)",
    avgColor: "var(--chart-3)",
    decimals: 2,
    estimated: (r) =>
      r.cost?.fedPriceCoveragePct != null && r.cost.fedPriceCoveragePct < 100,
    dictionary: {
      definition:
        "The price of the charcoal when it ARRIVED at the block, for everything this campaign fed. Renzo's own name for it.",
      basis:
        "Total pesos paid for the kilos this campaign fed ÷ those kilos. Weighted over kilos fed, never the mean of the daily prices.",
      exclusions:
        "Kilos fed out of piles that carry no delivery record at all — the money for them is not in the numerator, so the `~` says the figure speaks for part of the campaign.",
      rollup:
        "A selection is total pesos ÷ total kilos fed, not the mean of the campaigns.",
      source: "view_analytics_batch_cost.delivered_php_kg_fed",
      caveat:
        "Measured BY BATCH, not by calendar months. This is the same fact the old monthly Money row carried, read on the clock the plant actually runs on — which is why that row was retired in R4 rather than kept beside this one." +
        MARK_LEGEND,
    },
  },
  {
    key: "true_fed_price",
    label: "True ₱/kg fed",
    sublabel: "campaign-weighted",
    unit: "php_per_kg",
    rollup: "weighted",
    read: (r) => r.cost?.campaignWeightedActualFedPhpKg ?? null,
    numerator: (r) => {
      const c = r.cost;
      if (!fedPriceUsable(r) || c?.campaignWeightedActualFedPhpKg == null) return null;
      return c.campaignWeightedActualFedPhpKg * (c.fedKg ?? 0);
    },
    denominator: (r) =>
      fedPriceUsable(r) && r.cost?.campaignWeightedActualFedPhpKg != null
        ? (r.cost?.fedKg ?? null)
        : null,
    deltaMode: "pct",
    perWorkingDay: false,
    price: true,
    chart: "line",
    color: "var(--chart-5)",
    avgColor: "var(--chart-3)",
    decimals: 2,
    estimated: (r) => !(r.cost?.isFullyCovered ?? false),
    dictionary: {
      definition:
        "What that charcoal REALLY cost by the time it was fed — after paying for the weight that evaporated while it sat in the yard.",
      basis:
        "Each block's whole money over its whole fed tonnage, attributed to THIS campaign's own kilos. That attribution is what makes it directly comparable with the block price above; the whole-block variant is a different question.",
      exclusions:
        "Blocks that are still open (no final fed total) and blocks with a truckload still awaiting its price (money missing from the sum).",
      rollup:
        "A selection is total true pesos ÷ total kilos fed, weighted the same way the row itself is.",
      source: "view_analytics_batch_cost.campaign_weighted_actual_fed_php_kg",
      caveat: TRUE_PRICE_CAVEAT,
    },
  },
  {
    key: "storage_uplift",
    label: "Cost of storage time",
    sublabel: "₱/kg the weight loss added",
    unit: "php_per_kg",
    rollup: "weighted",
    read: (r) => r.cost?.upliftPhpKg ?? null,
    numerator: (r) => {
      const c = r.cost;
      if (!fedPriceUsable(r) || c?.upliftPhpKg == null) return null;
      return c.upliftPhpKg * (c.fedKg ?? 0);
    },
    denominator: (r) =>
      fedPriceUsable(r) && r.cost?.upliftPhpKg != null
        ? (r.cost?.fedKg ?? null)
        : null,
    // The uplift is already a DIFFERENCE, and it can cross zero on a block that
    // fed out marginally more than was booked in — so a percentage of last
    // campaign's uplift would be the meaningless figure `net_flow` refuses too.
    deltaMode: "abs",
    perWorkingDay: false,
    price: true,
    chart: "line",
    color: "var(--chart-2)",
    avgColor: "var(--chart-4)",
    decimals: 2,
    estimated: (r) => !(r.cost?.isFullyCovered ?? false),
    dictionary: {
      definition:
        "The gap between the block price and the true price — literally what it cost to let the charcoal sit.",
      basis:
        "True ₱/kg minus block ₱/kg on the same blocks. The weight shrinks, the money does not, so the same pesos end up spread over fewer kilos.",
      exclusions: "The same blocks the true price leaves out.",
      rollup: "A selection is weighted by kilos fed, exactly as the two prices it is the gap between.",
      source: "view_analytics_batch_cost.uplift_php_kg",
      caveat: TRUE_PRICE_CAVEAT,
    },
  },
  {
    key: "weight_lost",
    label: "Weight lost",
    sublabel: "% of delivered kg",
    unit: "pct",
    rollup: "weighted",
    read: (r) => pct(r.cost?.lossPct ?? null),
    numerator: (r) =>
      r.cost?.weightLostKg != null && campaignDeliveredKg(r.cost) != null
        ? r.cost.weightLostKg * 100
        : null,
    denominator: (r) => campaignDeliveredKg(r.cost),
    // It crosses zero — 2026-02 reads −0.001022 — so a percentage change of it
    // would be meaningless. Percentage POINTS.
    deltaMode: "abs",
    perWorkingDay: false,
    price: false,
    chart: "line",
    color: "var(--chart-5)",
    avgColor: "var(--chart-4)",
    decimals: 2,
    dictionary: {
      definition:
        "How much weight the blocks this campaign fed lost while they sat, as a share of what was delivered into them.",
      basis:
        "Kilos lost ÷ kilos delivered, over every block the campaign fed. Physical, so it needs no price and uses every block — including ones whose peso figures are missing.",
      exclusions:
        "Nothing. This is the yard's own shrinkage; the kilns' loss is Process loss further down.",
      rollup:
        "A selection is total kilos lost ÷ total kilos delivered, never the mean of the campaigns' percentages.",
      source: "view_analytics_batch_cost.loss_pct",
      caveat:
        "It can read slightly negative where a block fed out a little more than was booked in; that is misfiled paperwork, shown as measured rather than clamped to zero.",
    },
  },
  {
    key: "closed_blocks",
    label: "Blocks closed",
    sublabel: "piles finished",
    unit: "count",
    glyph: "piles",
    rollup: "sum",
    read: (r) => r.cost?.blocksClosed ?? null,
    deltaMode: "abs",
    perWorkingDay: false,
    price: false,
    chart: "bar",
    color: "var(--chart-3)",
    avgColor: "var(--chart-4)",
    decimals: 0,
    dictionary: {
      definition:
        "How many of the piles this campaign fed have been finished off and closed out.",
      basis: "A count of the campaign's blocks whose feeding has ended.",
      exclusions: "Piles the campaign fed that are still open.",
      rollup: "A selection of batches is the plain sum of those batches.",
      source: "view_analytics_batch_cost.blocks_closed",
      caveat:
        "Nothing in the database dates a status change, so a block's LAST FEEDING stands in for its closing date — the same approximation the RC Movement screen uses, on purpose, so the two cannot disagree about which campaign closed a block.",
    },
  },
  {
    key: "production_output",
    label: "Produced",
    sublabel: "tonnes made",
    unit: "tonnes",
    rollup: "sum",
    read: (r) => t(r.batch?.producedKg ?? null),
    deltaMode: "pct",
    perWorkingDay: false,
    price: false,
    chart: "bar",
    color: "var(--chart-2)",
    avgColor: "var(--chart-4)",
    decimals: 1,
    dependsOn: ["production"],
    dictionary: {
      definition: "How much finished charcoal the plant made in that campaign.",
      basis:
        "Every production entry filed under that batch, added up. The batch comes from the daily report's own start and end markers, so this is a grouping of records that already know which campaign they belong to — not an estimate.",
      exclusions:
        "Nothing. Every grade and every shift. What went IN is Charcoal fed, six rows above.",
      rollup: "A selection of batches is the plain sum of those batches.",
      source: "view_analytics_production_by_batch.produced_kg",
      caveat:
        "Blank, never zero, on the 22 campaigns that ran before daily production reporting began on 27 November 2025 — the plant did not run and make nothing, it simply was not reporting yet. (The cost view publishes 0 there because for IT this column is a money denominator; this row deliberately reads the production view instead.)",
    },
  },
  {
    key: "yield_rate",
    label: "Yield",
    sublabel: "% of fed kilos",
    unit: "pct",
    rollup: "weighted",
    read: (r) => pct(r.batch?.yieldPct ?? null),
    // ×100 on the NUMERATOR so the weighted rule stays Σnum ÷ Σden and the
    // result lands in percent — no second scaling step to forget.
    numerator: (r) =>
      yieldUsable(r) && r.batch?.producedKg != null
        ? r.batch.producedKg * 100
        : null,
    denominator: (r) => (yieldUsable(r) ? (r.batch?.fedKg ?? null) : null),
    deltaMode: "abs",
    perWorkingDay: false,
    price: false,
    chart: "line",
    color: "var(--chart-2)",
    avgColor: "var(--chart-4)",
    decimals: 1,
    dependsOn: ["production"],
    dictionary: {
      definition:
        "How much finished product came out of every hundred kilos of charcoal fed into that campaign.",
      basis:
        "Kilos produced ÷ kilos fed — read straight from the campaign view the RC Movement screen uses, not recomputed here. The change under a cell is in percentage POINTS.",
      exclusions:
        "A campaign that fed charcoal before production reporting existed is out of BOTH halves, and so is one that has produced but not yet been fed.",
      rollup:
        "A selection is total produced ÷ total fed, not the mean of the campaigns.",
      source: "view_analytics_production_by_batch.yield_pct",
      caveat:
        "This is `view_rc_movement_campaign_yield.yield_pct` verbatim — the same column the RC Movement campaign panel prints, which is the whole reason this table reads batches rather than months. SEPTEMBER 2026 is blank: it opened on 29 August and every kilo it has consumed was still being booked to AUGUST, so there is no denominator yet.",
    },
  },
  {
    key: "process_loss",
    label: "Process loss",
    sublabel: "% of fed kilos",
    unit: "pct",
    rollup: "weighted",
    read: (r) =>
      r.batch?.yieldPct == null ? null : (1 - r.batch.yieldPct) * 100,
    numerator: (r) =>
      yieldUsable(r) && r.batch?.fedKg != null && r.batch?.producedKg != null
        ? (r.batch.fedKg - r.batch.producedKg) * 100
        : null,
    denominator: (r) => (yieldUsable(r) ? (r.batch?.fedKg ?? null) : null),
    deltaMode: "abs",
    perWorkingDay: false,
    price: false,
    chart: "line",
    color: "var(--chart-5)",
    avgColor: "var(--chart-3)",
    decimals: 1,
    dependsOn: ["production"],
    dictionary: {
      definition:
        "What the kilns ate — the difference between the charcoal fed into a campaign and the product that came out.",
      basis:
        "Kilos fed minus kilos produced, over kilos fed. Exactly one hundred minus the yield above it, by construction rather than by coincidence.",
      exclusions:
        "Same as yield: a campaign with fed kilos and no reported production, or reported production and no feeding, is out of both halves.",
      rollup:
        "A selection is total kilos lost ÷ total kilos fed, and it still adds to exactly 100 with the yield beside it.",
      source: "view_analytics_production_by_batch.yield_pct (its complement)",
      caveat:
        "This is cooking loss, not yard loss. Weight that evaporated while charcoal SAT is the Weight lost row above.",
    },
  },
  {
    key: "php_per_produced_delivered",
    label: "₱ per produced kg",
    sublabel: "block-price basis",
    unit: "php_per_kg",
    rollup: "weighted",
    read: (r) => r.cost?.phpPerProducedKgDelivered ?? null,
    numerator: (r) => {
      const c = r.cost;
      if (c?.phpPerProducedKgDelivered == null || !c.producedKg) return null;
      return c.phpPerProducedKgDelivered * c.producedKg;
    },
    denominator: (r) =>
      r.cost?.phpPerProducedKgDelivered != null
        ? (r.cost?.producedKg ?? null)
        : null,
    deltaMode: "pct",
    perWorkingDay: false,
    price: true,
    chart: "line",
    color: "var(--chart-4)",
    avgColor: "var(--chart-3)",
    decimals: 2,
    dependsOn: ["production"],
    dictionary: {
      definition:
        "What one kilo of finished product cost in charcoal, at the BLOCK PRICE — what the charcoal cost on arrival.",
      basis: "The campaign's charcoal bill ÷ the kilos it produced.",
      exclusions:
        "Charcoal only: no labour, power, bags or depreciation. A campaign whose kilos came partly out of piles with no delivery record reads blank rather than understated.",
      rollup:
        "A selection is total pesos ÷ total kilos produced, not the mean of the campaigns.",
      source: "view_analytics_batch_cost.php_per_produced_kg_delivered",
      caveat:
        "Blank where fed-price coverage is below 100%: some of the money is missing, and an understated cost per kilo points the exact opposite way from the truth.",
    },
  },
  {
    key: "php_per_produced_true",
    label: "₱ per produced kg",
    sublabel: "TRUE basis",
    unit: "php_per_kg",
    rollup: "weighted",
    read: (r) => r.cost?.phpPerProducedKgTrue ?? null,
    numerator: (r) => {
      const c = r.cost;
      if (c?.phpPerProducedKgTrue == null || !c.producedKg) return null;
      return c.phpPerProducedKgTrue * c.producedKg;
    },
    denominator: (r) =>
      r.cost?.phpPerProducedKgTrue != null ? (r.cost?.producedKg ?? null) : null,
    deltaMode: "pct",
    perWorkingDay: false,
    price: true,
    chart: "line",
    color: "var(--chart-5)",
    avgColor: "var(--chart-3)",
    decimals: 2,
    dependsOn: ["production"],
    dictionary: {
      definition:
        "The number this whole layer was built for: what one kilo of finished product cost in charcoal AFTER paying for the weight that evaporated in the yard.",
      basis: "The campaign's TRUE charcoal bill ÷ the kilos it produced.",
      exclusions:
        "Charcoal only. A campaign with any block still open or still unpriced reads blank.",
      rollup:
        "A selection is total pesos ÷ total kilos produced, not the mean of the campaigns.",
      source: "view_analytics_batch_cost.php_per_produced_kg_true",
      caveat: TRUE_PRICE_CAVEAT,
    },
  },
];

/** THE campaign registry, section stamped by construction. */
export const CAMPAIGN_METRICS: readonly MetricSpecOf<CampaignMatrixRow>[] =
  CAMPAIGN_METRIC_LIST.map((m) => ({ ...m, section: "campaigns" as const }));

/** Lookup by key — so a `?metric=` deep link into this table still resolves. */
export const CAMPAIGN_METRIC_BY_KEY: ReadonlyMap<
  string,
  MetricSpecOf<CampaignMatrixRow>
> = new Map(CAMPAIGN_METRICS.map((m) => [m.key as string, m]));

// ---------------------------------------------------------------------
// The axis, and the fold
// ---------------------------------------------------------------------

/** `AUGUST 2026` → the header `AUG 2026`. */
function columnLabel(r: CampaignMatrixRow): string {
  return `${r.productionBatch.slice(0, 3)} ${r.campaignYear}`;
}

/**
 * THE fold, on the batch clock.
 *
 * `hiddenPeriods` is the page's own `?bhide=` set, keyed by `campaignLabel` —
 * the SAME keys the checklist in this table's header uses, which is what lets
 * one control drive the table and the grade mix beneath it with no mapping step
 * at all.
 *
 * The axis is EVERY campaign, unwindowed — this table is not scoped to a year,
 * and the checklist is the only thing that narrows it.
 */
export function buildCampaignMatrix(
  rows: readonly CampaignMatrixRow[],
  opts: {
    canViewPrices: boolean;
    hiddenPeriods?: ReadonlySet<string>;
  },
): Matrix<CampaignMatrixRow> {
  const all = rows.map((r, i) => {
    const named = campaignMonthIndex(r.productionBatch);
    return {
      key: r.campaignLabel,
      label: columnLabel(r),
      fullLabel: r.campaignLabel,
      year: r.campaignYear,
      // The month index of the NAME, so the year-ago chip lands on the
      // same-named campaign a year earlier with no extra machinery. An
      // unrecognised name sorts after the twelve rather than into January.
      seq: named === -1 ? 99 : named + 1,
      months: [r],
      // A campaign is finished exactly when a LATER one has opened — that is
      // what a changeover is. So the newest campaign, and only it, is in
      // progress, which is why SEPTEMBER 2026 is marked and can set no record.
      isPartial: i === rows.length - 1,
    };
  });

  return assembleMatrix(
    CAMPAIGN_METRICS,
    {
      granularity: CAMPAIGN_GRANULARITY,
      all,
      windowPeriods: all,
      totalLabels: (shown, filtered) => ({
        label: filtered ? "Selected" : "All batches",
        fullLabel: filtered
          ? `${shown.length} of ${all.length} batches selected`
          : `Every production batch on record · ${all.length}`,
      }),
      // No prior window exists: the axis is ALL of history, so there is nothing
      // "a year earlier" for it to be compared with. The calendar matrix answers
      // the same way in its YEAR view, for the same reason — a summary column
      // with a fabricated comparison is worse than one with none.
      priorTotal: () => null,
    },
    {
      canViewPrices: opts.canViewPrices,
      // Structurally off: no row in this band declares `perWorkingDay`, and the
      // plant's honest normalisation is its own row.
      perWorkingDay: false,
      hiddenPeriods: opts.hiddenPeriods,
    },
    CAMPAIGN_RULES,
  );
}
