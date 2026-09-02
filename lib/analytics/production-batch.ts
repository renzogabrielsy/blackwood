// =====================================================================
// ICTC Owner Analytics — THE PRODUCTION BAND, ON THE BATCH CLOCK (R6)
// =====================================================================
// The eight production rows and the axis they hang on. Everything here was
// the P4 calendar band until owner feedback R6, 2026-09-02, and the move is
// one decision with one measurable payoff.
//
// ── WHY THE CLOCK CHANGED ─────────────────────────────────────────────
// `production_shifts.production_batch` is NEVER the calendar month of the
// date. Batches run across month boundaries and a changeover day carries two
// of them — AUGUST closed and SEPTEMBER opened on 2026-08-29 — so a calendar
// month splits one campaign's output across two columns and mixes two
// campaigns into one. The band was answering a question about the plant on
// the yard's clock.
//
// **The payoff is a TIE, not a preference.** `yield_rate` here is literally
// `view_rc_movement_campaign_yield.yield_pct` — the very column the campaign
// panel above the band reads — SELECTed through
// `view_analytics_production_by_batch` rather than recomputed. So the yield on
// the panel and the yield in the band are the same column and cannot disagree.
// On the calendar clock they agreed only by coincidence, and drifted whenever
// a batch straddled a boundary, which is most of them.
//
// This is the R4 argument taken one step further. R4 retired the calendar
// MONEY rows because a campaign was the right clock for a cost; R6 retires the
// calendar PRODUCTION rows for the same reason, and the R5 note that said "this
// band is the one place the CALENDAR clock is still the right one" is thereby
// superseded — including the month-mapping machinery that carried the batch
// checklist into calendar months. The checklist now drives the band DIRECTLY:
// a campaign column IS a batch, so there is nothing left to map.
//
// ── WHAT IS EXACT AND WHAT IS MAPPED, SAID OUT LOUD ───────────────────
// Tonnage, runs, shifts, reported days, downtime and bags are EXACT: every one
// of those records already carries its own batch tag (measured — 250 of 250
// shifts carry a non-blank batch), so attributing them is a GROUP BY.
// ELECTRICITY is the one MAPPED figure: meter readings carry a date and no
// batch, so a day's consumption goes to the campaign that had most recently
// STARTED — **on a changeover day the power goes to the INCOMING batch**. The
// dictionary says which kind each row is, because a reader is entitled to know.
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
import type { MetricAnnotation, MetricSpecOf } from "./metrics";
import type { ProductionBatchRow } from "./types";

/** The band's fixed grain. Never selectable, never in `?g=`. */
export const BATCH_GRANULARITY: Granularity = "B";

const KG_PER_TONNE = 1000;

/** kg → tonnes, preserving null. The band is in tonnes; rails stay in kg. */
function t(kg: number | null | undefined): number | null {
  return kg == null ? null : kg / KG_PER_TONNE;
}

/**
 * FRACTION → percent, preserving null. The ONE place the ×100 happens for
 * Yield and Process loss — `yield_pct` is a fraction in SQL and stays one in
 * the contract, so that a reader of this file and a reader of the migration see
 * the same number.
 */
function pct(fraction: number | null | undefined): number | null {
  return fraction == null ? null : fraction * 100;
}

/** Plain number, for annotation copy. */
function nfmt(v: number, decimals = 0): string {
  return v.toLocaleString("en-US", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

function sumOf(
  rows: readonly ProductionBatchRow[],
  pick: (r: ProductionBatchRow) => number | null,
): number {
  let total = 0;
  for (const r of rows) total += pick(r) ?? 0;
  return total;
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
export const BATCH_RULES: UnitRules<ProductionBatchRow> = {
  workingDays: () => 0,
  structuralBlank: (rows, deps) => {
    if (deps.includes("production") && rows.every((r) => !r.productionReported)) {
      return "no_production";
    }
    return "no_data";
  },
};

// ---------------------------------------------------------------------
// The three figures that need a caveat rather than a silent correction
// ---------------------------------------------------------------------

/**
 * A downtime total of 0.00 hours can mean two completely different things.
 *
 * Ported verbatim from the calendar band, and the batch clock makes it SHARPER
 * rather than softer: the AUGUST 2026 campaign reads 0.00 hours across 22
 * shifts that ALL filed a repair reason and NONE recorded a duration. (The
 * calendar month's 23 reason-only shifts split JULY 3 / AUGUST 22 here, because
 * 2026-08-01 is JULY's closing day — the clock working, not a discrepancy.)
 */
function downtimeAnnotation(
  rows: readonly ProductionBatchRow[],
): MetricAnnotation | null {
  const reasonOnly = sumOf(rows, (r) => r.downtimeShiftsReasonOnly);
  if (reasonOnly <= 0) return null;
  const withDuration = sumOf(rows, (r) => r.downtimeShiftsWithDuration);
  const records = sumOf(rows, (r) => r.downtimeShiftCount);
  const shift = (n: number) => `${n} shift${n === 1 ? "" : "s"}`;
  return {
    mark: "⚠",
    blocksCallout: true,
    title:
      withDuration === 0
        ? `All ${shift(reasonOnly)} with a downtime record named the repair and left the duration at zero. This total is a gap in the report, not a campaign in which the plant never stopped. Shown as recorded; never quoted as a record.`
        : `${reasonOnly} of the ${shift(records)} with a downtime record named the repair and left the duration at zero, so these hours are short by an unknown amount. Shown as recorded; never quoted as a record.`,
  };
}

/**
 * ONE mis-keyed meter reading can be 97% of its campaign, and it does not look
 * wrong — it looks like a finding.
 *
 * The detector is STRUCTURAL and lives in SQL: a `start_kwh` of 0 is a genuine
 * meter reset only if the counter WRAPPED. Over all 818 readings it fires on
 * exactly one row (2026-03-01 / MAIN, ×120 multiplier), and on this clock that
 * row lands in the MARCH 2026 campaign — which therefore publishes 696,948 kWh
 * against a real ~20,004. Nothing is repaired: correcting the reading is
 * Renzo's call and a separate, audited write.
 */
function powerAnnotation(
  rows: readonly ProductionBatchRow[],
): MetricAnnotation | null {
  const count = sumOf(rows, (r) => r.kwhSuspectReadingCount);
  if (count <= 0) return null;
  const suspect = sumOf(rows, (r) => r.kwhSuspectKwh);
  const total = sumOf(rows, (r) => r.kwh);
  const share = total > 0 ? (suspect / total) * 100 : null;
  return {
    mark: "⚠",
    blocksCallout: true,
    title:
      `${count} meter reading${count === 1 ? "" : "s"} here ${count === 1 ? "is" : "are"} mis-keyed — a start left at zero against an end still climbing — and ${nfmt(suspect)} kWh of this total comes from ${count === 1 ? "it" : "them"}` +
      (share == null ? "" : `, ${nfmt(share, 1)}% of the campaign`) +
      `. Published exactly as metered: fixing the reading is a separate, audited write. Power intensity is where it is taken out. Never quoted as a record.`,
  };
}

/**
 * The intensity's own annotation — the mirror image of the one above, and the
 * distinction between them is the whole rule. The kWh total is FACTUALLY WRONG,
 * so its ratio is suppressed; the total itself is still published as metered.
 * Suppressing a correct number is how a data layer starts lying, so the honest
 * estimate prints beside the ⚠ rather than being withheld.
 */
function powerIntensityAnnotation(
  rows: readonly ProductionBatchRow[],
): MetricAnnotation | null {
  const base = powerAnnotation(rows);
  if (!base) return null;
  const only = rows.length === 1 ? rows[0] : null;
  const excl = only?.kwhPerProducedKgExclSuspect ?? null;
  const clean = rows.filter((r) => (r.kwhSuspectReadingCount ?? 0) === 0).length;
  return {
    mark: "⚠",
    blocksCallout: true,
    alt:
      excl == null
        ? undefined
        : { value: excl, label: "excl. the mis-keyed reading" },
    title:
      `Blank rather than wrong: this campaign holds a mis-keyed meter reading, and an intensity built on it reports an efficiency collapse that never happened (MARCH 2026 would read against neighbours at 0.03). ` +
      (excl != null
        ? `The figure beside the ⚠ is the same sum with the bad reading removed — an estimate, labelled as one.`
        : clean > 0
          ? `The figure above is measured over the ${clean} unaffected campaign${clean === 1 ? "" : "s"} only.`
          : `Every campaign here is affected, so there is no honest figure to show.`),
  };
}

/**
 * Bags did not exist before May 2026, so a run with no bag count is NULL rather
 * than 0 and a short-coverage campaign says what share it speaks for.
 */
function sacksAnnotation(
  rows: readonly ProductionBatchRow[],
): MetricAnnotation | null {
  const runs = sumOf(rows, (r) => r.productionRunCount);
  if (runs <= 0) return null;
  const withSacks = sumOf(rows, (r) => r.runsWithSacks);
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
    title: `This speaks for ${withSacks} of the campaign's ${runs} production entries — ${nfmt((100 * withSacks) / runs, 1)}% coverage — so it is a floor, not the campaign's bags. Never quoted as a record.`,
  };
}

/**
 * May this campaign contribute to a power-intensity rollup AT ALL?
 *
 * A weighted rollup sums numerator and denominator INDEPENDENTLY, so a campaign
 * with one and not the other adds to one side of the fraction and nothing to
 * the other. **22 of the 32 campaigns never reported production**, and the
 * eight pre-campaign metered months are excluded from this clock entirely
 * (`kwhUnmappedPreCampaign` carries them), so the hazard is smaller here than
 * it was on the calendar — but it is the same hazard and gets the same gate.
 * The suspect test rides here too, which is why a selection containing MARCH
 * 2026 is measured over its unaffected campaigns.
 */
function intensityUsable(r: ProductionBatchRow): boolean {
  if ((r.kwhSuspectReadingCount ?? 0) > 0) return false;
  return r.kwh != null && r.producedKg != null && r.producedKg > 0;
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
function yieldUsable(r: ProductionBatchRow): boolean {
  return r.fedKg != null && r.fedKg > 0 && r.producedKg != null;
}

// ---------------------------------------------------------------------
// The registry
// ---------------------------------------------------------------------
//
// **Not one row is `price: true`, and that is structural.** No ₱ column exists
// in either batch view and none is derivable from them (the migration asserts
// it), so the whole band is visible to every role including Production and the
// adapter has nothing to null.
//
// **No row is `perWorkingDay`, and that is also structural.** The toggle is the
// yard's normalisation; the plant's own denominator is `reportedDays`, which is
// its own row and says so in its dictionary.

const BATCH_METRIC_LIST: readonly Omit<
  MetricSpecOf<ProductionBatchRow>,
  "section"
>[] = [
  {
    key: "production_output",
    label: "Production output",
    sublabel: "tonnes made",
    unit: "tonnes",
    rollup: "sum",
    read: (r) => t(r.producedKg),
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
        "Nothing. Every grade and every shift. What went IN is Charcoal fed on the panel above.",
      rollup: "A selection of batches is the plain sum of those batches.",
      source: "view_analytics_production_by_batch.produced_kg",
      caveat:
        "Blank, never zero, on the 22 campaigns that ran before daily production reporting began on 27 November 2025 — the plant did not run and make nothing, it simply was not reporting yet.",
    },
  },
  {
    key: "production_per_day",
    label: "Output per reported day",
    sublabel: "tonnes / day reported",
    unit: "tonnes",
    rollup: "weighted",
    read: (r) => t(r.producedPerReportedDay),
    numerator: (r) => t(r.producedKg),
    denominator: (r) => r.reportedDays,
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
        "How much the plant made on a day it was actually running — the fair way to compare a short campaign with a long one.",
      basis:
        "Tonnes produced ÷ the days that campaign reported production, using the same rule the home dashboard uses (a day with at least one production entry).",
      exclusions:
        "Days production did not report are out of the denominator, so a rest day cannot dilute the figure.",
      rollup:
        "A selection is total tonnes ÷ total reported days, not the mean of the campaigns.",
      source: "view_analytics_production_by_batch.produced_per_reported_day",
      caveat:
        "A changeover day belongs to TWO campaigns and both really did run it, so day counts across campaigns add to slightly more than the calendar: 221 campaign-days over 214 dates, the difference being exactly the seven changeover days.",
    },
  },
  {
    key: "yield_rate",
    label: "Yield",
    sublabel: "% of fed kilos",
    unit: "pct",
    rollup: "weighted",
    read: (r) => pct(r.yieldPct),
    // ×100 on the NUMERATOR so the weighted rule stays Σnum ÷ Σden and the
    // result lands in percent — no second scaling step to forget.
    numerator: (r) =>
      yieldUsable(r) && r.producedKg != null ? r.producedKg * 100 : null,
    denominator: (r) => (yieldUsable(r) ? r.fedKg : null),
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
        "Kilos produced ÷ kilos fed — read straight from the campaign view the panel above uses, not recomputed here. The change under a cell is in percentage POINTS.",
      exclusions:
        "A campaign that fed charcoal before production reporting existed is out of BOTH halves, and so is one that has produced but not yet been fed.",
      rollup:
        "A selection is total produced ÷ total fed, not the mean of the campaigns.",
      source: "view_analytics_production_by_batch.yield_pct",
      caveat:
        "This is the SAME column the Yield row on the By production batch panel prints — the whole reason this band reads batches rather than months. On a calendar clock the two agreed only by coincidence, because a batch straddles month boundaries. SEPTEMBER 2026 is blank: it opened on 29 August and every kilo it has consumed was still being booked to AUGUST, so there is no denominator yet.",
    },
  },
  {
    key: "process_loss",
    label: "Process loss",
    sublabel: "% of fed kilos",
    unit: "pct",
    rollup: "weighted",
    read: (r) => (r.yieldPct == null ? null : (1 - r.yieldPct) * 100),
    numerator: (r) =>
      yieldUsable(r) && r.fedKg != null && r.producedKg != null
        ? (r.fedKg - r.producedKg) * 100
        : null,
    denominator: (r) => (yieldUsable(r) ? r.fedKg : null),
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
        "This is cooking loss, not yard loss. Weight that evaporated while charcoal SAT is a different figure and lives on the panel above as Weight lost.",
    },
  },
  {
    key: "downtime_hours",
    label: "Downtime",
    sublabel: "hours lost",
    unit: "hours",
    rollup: "sum",
    read: (r) => r.downtimeHrs,
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
        "How many hours the plant stood still during that campaign, as the shift reports recorded it.",
      basis:
        "The hours-and-minutes pair on each shift's downtime record, folded the same way the Daily production ledger folds it, over the shifts carrying that batch.",
      exclusions:
        "A shift that filed no downtime record is not counted as zero downtime — it is simply not in the sum.",
      rollup: "A selection of batches is the plain sum of those batches.",
      source: "view_analytics_production_by_batch.downtime_hrs",
      caveat:
        "A zero here means two different things, so read it with the ⚠. The AUGUST 2026 campaign reads 0.00 h across 22 shifts that all named a repair and none of which recorded how long it took: the work was recorded, the number stopped being.",
    },
  },
  {
    key: "power_kwh",
    label: "Power",
    sublabel: "kWh metered",
    unit: "kwh",
    rollup: "sum",
    read: (r) => r.kwh,
    deltaMode: "pct",
    perWorkingDay: false,
    price: false,
    chart: "bar",
    color: "var(--chart-3)",
    avgColor: "var(--chart-4)",
    decimals: 0,
    // NO `dependsOn`: power is metered whether or not production reported, and
    // blanking it would call real electricity "not reported".
    annotate: powerAnnotation,
    dictionary: {
      definition:
        "How much electricity the site drew during that campaign, across every meter.",
      basis:
        "Each daily reading's consumption, multiplier applied, added up over the campaign's date span.",
      exclusions:
        "The 192 metered days that precede the first campaign — 561,930 kWh — belong to no campaign on this clock and are not in any column. They are readable by month in the calendar production view, and the totals reconcile exactly.",
      rollup: "A selection of batches is the plain sum of those batches.",
      source: "view_analytics_production_by_batch.kwh",
      caveat:
        "THIS IS THE ONE MAPPED FIGURE ON THE BAND. Meter readings carry a date and no batch, so a day's consumption goes to the campaign that had most recently STARTED — on a changeover day the power goes to the INCOMING batch. Every metered day from the first campaign onward belongs to exactly one campaign, so nothing is counted twice and nothing is lost. One reading on 1 March 2026 was mis-keyed and lands in MARCH 2026; it is marked ⚠ and NOT corrected here. Only the MAIN meter has reported since December 2025.",
    },
  },
  {
    key: "power_intensity",
    label: "Power intensity",
    sublabel: "kWh / kg made",
    unit: "kwh_per_kg",
    rollup: "weighted",
    read: (r) => r.kwhPerProducedKg,
    numerator: (r) => (intensityUsable(r) ? r.kwh : null),
    denominator: (r) => (intensityUsable(r) ? r.producedKg : null),
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
      basis: "The campaign's metered kWh ÷ the kilos it produced.",
      exclusions:
        "A campaign holding a mis-keyed meter reading is left out entirely, here and in any selection it belongs to.",
      rollup:
        "A selection is total kWh ÷ total kilos produced across its clean campaigns, not the mean of the rates.",
      source: "view_analytics_production_by_batch.kwh_per_produced_kg",
      caveat:
        "Blank rather than wrong on MARCH 2026, whose ⚠ carries the honest 0.0225 beside it. DECEMBER 2025 reads a high 0.0855 and is NOT suppressed: it is correct, and it is the only campaign with three live meters (the bunkhouse and pump meters stopped reporting on 12 December 2025). Suppressing a correct number is how a page starts lying.",
    },
  },
  {
    key: "sacks_counted",
    label: "Bags counted",
    sublabel: "sacks",
    unit: "count",
    // R6 — a count has to say what it counts; `UNIT_GLYPH.count` is blank.
    glyph: "bags",
    rollup: "sum",
    read: (r) => r.sacks,
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
      definition: "How many bags the campaign's production entries recorded.",
      basis: "The bag counts on the campaign's production runs, added up.",
      exclusions:
        "A run with no bag count is not counted as zero bags — it is simply not in the sum, and the ~ says how many such runs there were.",
      rollup: "A selection of batches is the plain sum of those batches.",
      source: "view_analytics_production_by_batch.sacks",
      caveat:
        "Bags were not counted before May 2026, so earlier campaigns are blank rather than zero.",
    },
  },
];

/** THE batch registry, section stamped by construction. */
export const BATCH_METRICS: readonly MetricSpecOf<ProductionBatchRow>[] =
  BATCH_METRIC_LIST.map((m) => ({ ...m, section: "production" as const }));

/** Lookup by key — so a `?metric=` deep link into this band still resolves. */
export const BATCH_METRIC_BY_KEY: ReadonlyMap<
  string,
  MetricSpecOf<ProductionBatchRow>
> = new Map(BATCH_METRICS.map((m) => [m.key as string, m]));

// ---------------------------------------------------------------------
// The axis, and the fold
// ---------------------------------------------------------------------

/** `AUGUST 2026` → the header `AUG 2026`, exactly as the panel above prints it. */
function columnLabel(r: ProductionBatchRow): string {
  return `${r.productionBatch.slice(0, 3)} ${r.campaignYear}`;
}

/**
 * THE fold, on the batch clock.
 *
 * `hiddenPeriods` is the page's own `?bhide=` set, keyed by `campaignLabel` —
 * the SAME keys the campaign panel's checklist uses, which is what lets one
 * control drive the panel, this band and the grade mix with no mapping step at
 * all. R5 needed `selectedCampaignMonths` to carry the selection into calendar
 * columns; a campaign column IS a batch, so that machinery is retired.
 *
 * The axis is EVERY campaign, unwindowed, exactly like the panel above it (and
 * unlike the calendar matrix, which is scoped to a year). The two tables
 * therefore show the same columns in the same order, and the checklist is the
 * only thing that narrows either.
 */
export function buildBatchMatrix(
  rows: readonly ProductionBatchRow[],
  opts: {
    canViewPrices: boolean;
    hiddenPeriods?: ReadonlySet<string>;
  },
): Matrix<ProductionBatchRow> {
  const ordered = [...rows].sort(
    (a, b) =>
      a.campaignYear - b.campaignYear ||
      campaignSeq(a.productionBatch) - campaignSeq(b.productionBatch),
  );

  const all = ordered.map((r, i) => {
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
      isPartial: i === ordered.length - 1,
    };
  });

  return assembleMatrix(
    BATCH_METRICS,
    {
      granularity: BATCH_GRANULARITY,
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
    BATCH_RULES,
  );
}
