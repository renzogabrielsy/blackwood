// =====================================================================
// ICTC Owner Analytics — the PURE FOLD (months → matrix → callouts)
// =====================================================================
// One pass turns the monthly series into everything the page draws: the
// period axis, every cell (value + change + year-ago chip), the full
// history each row's expand charts, and the callout strip.
//
// **The callouts read the SAME cell objects the matrix renders.** They are
// not a second computation over the same data — the plan's rule, and the
// only way a headline can never disagree with the grid under it.
//
// NOTHING HERE IS A NEW DEFINITION OF A NUMBER. Every month's figure comes
// straight from a SQL view; this module only decides which months make up
// a period and applies the rollup rule the metric registry already states
// (`metrics.ts` → `MetricSpec.rollup`). The two arithmetic traps the data
// layer warned about are obeyed structurally rather than by convention:
//
//   • a weighted rollup is Σnumerator ÷ Σdenominator, and the ONLY rows
//     that carry a numerator/denominator pair are the ones allowed to use
//     it — an average of averages is not expressible here;
//   • a stock level rolls up as its PERIOD-END month, never as a sum, and
//     that too is the registry's declaration, not this module's opinion.
//
// ── OWNER FEEDBACK R2 (2026-09-02) — THE PERIOD FILTER ────────────────
// `MatrixOptions.hiddenPeriods` lets the reader switch columns off, and
// `foldSelection` lets the row expand fold an arbitrary set of periods.
// Both go through the SAME `foldPeriod` + `rawValue` pair every column
// already uses, so a filtered summary is Σ pesos ÷ Σ priced kilos exactly
// as an unfiltered one is — a mean of the surviving cells is still not
// expressible anywhere in this module.
//
// **Filtering HIDES, it never RESTATES.** Three consequences, all
// deliberate: a hidden period stays in `history` (a record is still judged
// against the metric's whole life); a visible cell's month-on-month move is
// still measured against the period that really precedes it, on screen or
// not; and the summary column's year-ago chip narrows the PRIOR year to the
// same positions rather than comparing four months to twelve.
//
// Pure and client-safe: no React, no Supabase, no `server-only`.
// =====================================================================

import type { AnalyticsMonth } from "./types";
import {
  METRICS,
  SECTIONS,
  type DeltaMode,
  type MetricAnnotation,
  type MetricDependency,
  type MetricKey,
  type MetricSection,
  type MetricSpecOf,
} from "./metrics";

// ---------------------------------------------------------------------
// The period axis
// ---------------------------------------------------------------------

/**
 * Month · Quarter · Year — the matrix's column granularity — **plus `B`, the
 * PRODUCTION-BATCH clock (owner feedback R6).**
 *
 * `B` is not offered by the Y/Q/M toggle and never comes out of `?g=`: it is
 * the fixed grain of the Production band, whose columns are campaigns rather
 * than calendar periods. It lives in this union rather than in a parallel type
 * so that every switch on granularity in this module and in the expand is
 * forced to answer for it — a bucket noun, a delta word, a rolling window —
 * instead of a second enum quietly defaulting somewhere.
 */
export type Granularity = "M" | "Q" | "Y" | "B";

export const GRANULARITY_LABEL: Record<Granularity, string> = {
  M: "Month",
  Q: "Quarter",
  Y: "Year",
  B: "Batch",
};

/** What the period-over-period delta is CALLED at each granularity. */
export const DELTA_LABEL: Record<Granularity, string> = {
  M: "MoM",
  Q: "QoQ",
  Y: "YoY",
  B: "batch-on-batch",
};

const MONTH_SHORT = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

const MONTH_LONG = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

/**
 * One column of the matrix — a month, a quarter, a year, or (R6) a production
 * CAMPAIGN.
 *
 * `U` is the unit a column is made of. It defaults to `AnalyticsMonth`, so
 * every calendar call site reads exactly as it did before; the Production band
 * instantiates it at `ProductionBatchRow` and gets the same folds.
 *
 * **`months` keeps its name at `U = AnalyticsMonth` and means "the units this
 * column is made of" in general.** Renaming it would have touched every rollup
 * in this file and every caller for no gain in truth — a campaign column is
 * genuinely "the campaign rows this column folds", which is a list of one.
 */
export interface Period<U = AnalyticsMonth> {
  /** Stable identity: `2026-03` · `2026-Q1` · `2026` · `AUGUST 2026`. */
  key: string;
  /** Column header — `Mar` · `Q1` · `2026` · `AUG 2026`. */
  label: string;
  /** Tooltip / chart axis — `March 2026` · `Q1 2026` · `2026` · `AUGUST 2026`. */
  fullLabel: string;
  year: number;
  /**
   * Position WITHIN the year: 1–12 · 1–4 · 1 — and, on the batch clock, the
   * month index of the campaign's NAME. Pairs a period with its year-ago twin,
   * which is what makes the batch band's YoY chip "the same-named campaign one
   * year earlier" with no extra machinery.
   */
  seq: number;
  /** The units that make it up, ascending. Never empty. */
  months: U[];
  /** Some constituent unit has not finished. A record cannot be claimed on it. */
  isPartial: boolean;
}

/**
 * The two things a fold needs to know about a UNIT that a metric spec cannot
 * say for itself — supplied per clock, so `rawValue` stays one function.
 *
 * There are exactly two of them because there are exactly two places the fold
 * reaches past `MetricSpec.read` into the unit: the per-working-day divisor,
 * and WHY a blank is blank. Both are properties of the clock rather than of the
 * row, so neither belongs in the registry.
 */
export interface UnitRules<U> {
  /** The divisor behind the per-working-day toggle. */
  workingDays(u: U): number;
  /**
   * Whether a blank is STRUCTURAL ("the stream did not exist yet") rather than
   * "nothing happened". The row declares which streams it needs
   * (`MetricSpec.dependsOn`); the clock decides whether this column had them.
   */
  structuralBlank(units: readonly U[], deps: readonly MetricDependency[]): BlankReason;
}

/** The calendar clock's rules — what every RC Inventory row folds through. */
export const MONTH_RULES: UnitRules<AnalyticsMonth> = {
  workingDays: (m) => m.workingDays ?? 0,
  structuralBlank: (months, deps) => {
    if (deps.includes("outflow") && months.every((m) => !m.outflowRecorded)) {
      return "no_outflow";
    }
    if (deps.includes("production") && months.every((m) => !m.productionRecorded)) {
      return "no_production";
    }
    return "no_data";
  },
};

/**
 * The COMPLETE axis, all history, at one granularity — built once and then
 * sliced. It has to be complete rather than year-scoped: January's
 * month-over-month change is against DECEMBER of the year before, which is
 * off the displayed window.
 */
export function buildPeriods(
  months: readonly AnalyticsMonth[],
  granularity: Granularity,
): Period[] {
  const byKey = new Map<string, Period>();

  for (const m of months) {
    let key: string;
    let label: string;
    let fullLabel: string;
    let seq: number;

    if (granularity === "M") {
      key = `${m.year}-${String(m.month).padStart(2, "0")}`;
      label = MONTH_SHORT[m.month - 1] ?? String(m.month);
      fullLabel = `${MONTH_LONG[m.month - 1] ?? m.month} ${m.year}`;
      seq = m.month;
    } else if (granularity === "Q") {
      const q = Math.floor((m.month - 1) / 3) + 1;
      key = `${m.year}-Q${q}`;
      label = `Q${q}`;
      fullLabel = `Q${q} ${m.year}`;
      seq = q;
    } else {
      key = String(m.year);
      label = String(m.year);
      fullLabel = String(m.year);
      seq = 1;
    }

    const existing = byKey.get(key);
    if (existing) {
      existing.months.push(m);
      existing.isPartial = existing.isPartial || m.isPartialMonth;
    } else {
      byKey.set(key, {
        key,
        label,
        fullLabel,
        year: m.year,
        seq,
        months: [m],
        isPartial: m.isPartialMonth,
      });
    }
  }

  return [...byKey.values()].sort((a, b) =>
    a.year !== b.year ? a.year - b.year : a.seq - b.seq,
  );
}

/**
 * The columns actually rendered. Month and quarter views are scoped to the
 * chosen year; the YEAR view shows every year there is, because "one column
 * per year, all years" is the whole point of that granularity.
 */
export function displayedPeriods(
  all: readonly Period[],
  granularity: Granularity,
  year: number,
): Period[] {
  if (granularity === "Y") return [...all];
  return all.filter((p) => p.year === year);
}

// ---------------------------------------------------------------------
// Cells
// ---------------------------------------------------------------------

/** Why a cell is blank. A blank is always EXPLAINED, never left ambiguous. */
export type BlankReason =
  /** ₱ withheld for this role — the value never left the server. */
  | "restricted"
  /** Feedings were not being recorded yet, so half the arithmetic did not exist. */
  | "no_outflow"
  /** Production was not being reported yet — the same shape, one stream later. */
  | "no_production"
  /** Nothing happened, or nothing was recorded. */
  | "no_data";

export interface Change {
  mode: DeltaMode;
  /** Signed. A percentage for `pct`, the raw difference in the row's own unit for `abs`. */
  value: number;
}

export interface MatrixCell {
  periodKey: string;
  /** In the row's DISPLAY unit (tonnes, ₱, count, days), already per-working-day if toggled. */
  value: number | null;
  blankReason: BlankReason | null;
  /**
   * At least one constituent month contributed nothing while another did, so
   * the figure is a FLOOR rather than a total. Only meaningful for additive
   * rollups; the matrix marks it with a dot and says so on hover.
   */
  holed: boolean;
  /** The period has not finished. */
  isPartial: boolean;
  /**
   * The figure is the coverage-adjusted ESTIMATE, not the strict published
   * one — some of the kilos underneath it carry no price at all. The cell
   * prints a `~`, and no callout may be built from it.
   */
  estimated: boolean;
  /**
   * P4 — the row's OWN caveat for this period, or null. A mis-keyed meter
   * reading, a downtime duration that stopped being filled in, a bag count
   * that speaks for a fraction of its month. The cell prints its mark, merges
   * its sentence into the hover, and — when the row's own value is blank but
   * an honest estimate exists — prints `annotation.alt` in its place, labelled.
   */
  annotation: MetricAnnotation | null;
  /**
   * May a headline quote this cell? False when the figure is an estimate,
   * when the row's own `annotate` flagged it, or when the period is the
   * metric's FIRST on record — a stream that started part-way through a month
   * makes that month a reporting boundary rather than a business fact
   * (production reporting opened mid-November 2025 at a yield of 11.9% and
   * ₱337 per produced kilo, which is not a record anyone should act on).
   * Purely a callout gate: the cell still renders.
   */
  calloutable: boolean;
  /** Change against the immediately preceding period at this granularity. */
  delta: Change | null;
  /**
   * May a headline quote `delta`? A change is a statement about TWO periods,
   * so the period it is measured FROM has to be quotable as well.
   *
   * Found by measurement, not by reasoning: with the production band in, the
   * top line of the strip read *"Power fell 97.6% MoM in April 2026, to 16,572
   * kWh — the biggest month-on-month move on the board."* April's own cell is
   * sound and passed every gate; the 97.6% is entirely the mis-keyed March
   * reading it was divided by. Gating the cell alone cannot catch that, and
   * the same shape applies to the period after a metric's FIRST — a fall from
   * a reporting boundary is a fact about when reporting started.
   */
  deltaQuotable: boolean;
  /**
   * The SAME period-over-period change as `delta`, always expressed as the raw
   * difference in the row's own unit — kilos, pesos, days, counts.
   *
   * OWNER FEEDBACK R1. The primary indicator under a value is always the
   * period-over-period move; the SECOND chip is what the page-level Compare
   * control switches, between the year-ago comparison and this. "Purchase
   * volume rose 12.4%" and "purchase volume rose 214.8 t" are the same fact
   * asked two ways, and which one is useful depends on the row.
   *
   * Null on a row whose `deltaMode` is already `abs` — the primary line IS the
   * actual change there, and printing it twice is noise, not a second reading.
   */
  deltaAbs: Change | null;
  /** Change against the same period one year earlier. Null in the YEAR view — it would repeat `delta`. */
  yoy: Change | null;
  /** The same rule for the year-ago comparison. */
  yoyQuotable: boolean;
}

export interface MatrixRow<U = AnalyticsMonth> {
  metric: MetricSpecOf<U>;
  /** One per DISPLAYED period, in column order. */
  cells: MatrixCell[];
  /**
   * The trailing summary column — the whole displayed window folded by the row's
   * OWN rollup rule, which is the only reason it is safe to print beside the
   * periods: the price total is Σ pesos ÷ Σ kilos, the stock total is the
   * period-end level, the volume total is a sum. A single "add the row up"
   * column would have been wrong on five of the twelve rows.
   */
  total: MatrixCell | null;
  /** One per period of the FULL axis — what the row expand charts and what a record is judged against. */
  history: HistoryPoint[];
  /**
   * The COMPARISON series (`MetricSpec.pairs`), each folded through the same
   * rollup machinery over the same periods, or null when the row declares
   * none. Same aggregation on every side is what makes it a comparison.
   *
   * R7 made it a LIST: Net flow declares two, because it is a subtraction and
   * both of its halves are worth drawing beside it.
   */
  pairHistories: HistoryPoint[][] | null;
  /** The row is ₱-bearing and this viewer may not see ₱. */
  restricted: boolean;
}

export interface HistoryPoint {
  periodKey: string;
  /** Chart axis label — short at month granularity, so 75 bars still tick. */
  label: string;
  fullLabel: string;
  /**
   * The calendar year this point belongs to. Carried explicitly rather than
   * parsed back out of `periodKey` at the point of use: the expand's own year
   * checklist (owner feedback R2) groups by it, and a second definition of
   * "which year is this" living in a string slice is exactly the kind of thing
   * that drifts the day a key format changes.
   */
  year: number;
  value: number | null;
  isPartial: boolean;
  /** Trailing 3-period mean. Presentation smoothing only; null at YEAR granularity. */
  avg: number | null;
  /** Is this period inside the currently displayed window? Drives the chart's emphasis. */
  displayed: boolean;
  /** P4 — the row's own caveat for this period, or null. Same object the cell carries. */
  annotation: MetricAnnotation | null;
  /**
   * May a headline quote this period? Records are judged against the WHOLE
   * history, not only the displayed window, so the gate has to live here as
   * well as on the cell. Same rule, one computation — see the callout block
   * comment below.
   */
  calloutable: boolean;
}

/** What one period contributes for one metric, before deltas are attached. */
interface RawValue {
  value: number | null;
  holed: boolean;
  estimated: boolean;
  blankReason: BlankReason | null;
}

function sumNonNull<U>(
  months: readonly U[],
  pick: (m: U) => number | null,
): { total: number; had: number; missing: number } {
  let total = 0;
  let had = 0;
  let missing = 0;
  for (const m of months) {
    const v = pick(m);
    if (v == null || !Number.isFinite(v)) missing += 1;
    else {
      total += v;
      had += 1;
    }
  }
  return { total, had, missing };
}

/**
 * Exactly what `rawValue` needs — no more. `MetricSpec` satisfies it, and so
 * does the synthetic spec a `MetricPair` is folded through, which is what
 * guarantees a comparison line aggregates by the SAME rules as the line it
 * is compared against.
 */
type RollupSpec<U> = Pick<
  MetricSpecOf<U>,
  | "rollup"
  | "read"
  | "numerator"
  | "denominator"
  | "price"
  | "perWorkingDay"
  | "estimated"
  | "dependsOn"
>;

/**
 * ONE period's figure for ONE metric — the whole of the rollup contract.
 *
 * `perWorkingDay` divides an additive row by the period's OWN working days
 * (summed, exactly as the row is summed), which is why the toggle is
 * arithmetically safe on a quarter and a year and not only on a month.
 */
function rawValue<U>(
  spec: RollupSpec<U>,
  period: Period<U>,
  opts: { canViewPrices: boolean; perWorkingDay: boolean },
  rules: UnitRules<U>,
): RawValue {
  if (spec.price && !opts.canViewPrices) {
    return { value: null, holed: false, estimated: false, blankReason: "restricted" };
  }

  // A period is an ESTIMATE if ANY month contributing to it is — a quarter
  // that folds in August 2026's untraceable kilos is no more exact than
  // August itself, and hiding that behind two clean months would be the
  // silent understatement this whole layer exists to expose.
  const estimated =
    spec.estimated != null && period.months.some((m) => spec.estimated!(m));

  /**
   * Why the blank is blank. A structural blank ("the stream did not exist
   * yet") is a completely different statement from "nothing happened", and
   * the row declares which streams it needs rather than this function
   * carrying a list of metric keys that would drift.
   */
  const blankFor = (): BlankReason =>
    rules.structuralBlank(period.months, spec.dependsOn ?? []);

  if (spec.rollup === "weighted") {
    const num = sumNonNull(period.months, spec.numerator!);
    const den = sumNonNull(period.months, spec.denominator!);
    // `<= 0` guards a zero denominator; a NEGATIVE weighted result is legal
    // and deliberately not clamped (closed-block loss reads −0.10% in
    // February 2026 — misfiled paperwork, shown as measured).
    if (den.total <= 0 || num.had === 0) {
      return { value: null, holed: false, estimated, blankReason: blankFor() };
    }
    return {
      value: num.total / den.total,
      holed: false,
      estimated,
      blankReason: null,
    };
  }

  if (spec.rollup === "periodEnd") {
    // The LAST month of the period, not the last month that happens to carry a
    // value: "as of the period end" is the claim, and silently reaching further
    // back would date the figure without saying so.
    const last = period.months[period.months.length - 1];
    const v = spec.read(last);
    if (v == null || !Number.isFinite(v)) {
      return { value: null, holed: false, estimated, blankReason: blankFor() };
    }
    return { value: v, holed: false, estimated, blankReason: null };
  }

  if (spec.rollup === "peak") {
    const vals = period.months
      .map((m) => spec.read(m))
      .filter((v): v is number => v != null && Number.isFinite(v));
    if (vals.length === 0) {
      return { value: null, holed: false, estimated, blankReason: blankFor() };
    }
    return {
      value: Math.max(...vals),
      holed: vals.length < period.months.length,
      estimated,
      blankReason: null,
    };
  }

  // sum
  const { total, had, missing } = sumNonNull(period.months, spec.read);
  if (had === 0) {
    return { value: null, holed: false, estimated, blankReason: blankFor() };
  }

  if (opts.perWorkingDay && spec.perWorkingDay) {
    const days = period.months.reduce((acc, m) => acc + rules.workingDays(m), 0);
    if (days <= 0) {
      return { value: null, holed: missing > 0, estimated, blankReason: "no_data" };
    }
    return { value: total / days, holed: missing > 0, estimated, blankReason: null };
  }

  return { value: total, holed: missing > 0, estimated, blankReason: null };
}

function change(
  current: number | null,
  previous: number | null,
  mode: DeltaMode,
): Change | null {
  if (current == null || previous == null) return null;
  if (mode === "abs") return { mode, value: current - previous };
  // A percentage of zero is not a number anyone can read, so it is reported as
  // no comparison rather than as an infinite one.
  if (previous === 0) return null;
  return { mode, value: ((current - previous) / Math.abs(previous)) * 100 };
}

/**
 * Trailing mean over `window` periods, INCLUDING blanks as gaps (they break it).
 *
 * EXPORTED for the row expand's year checklist (owner feedback R2). When the
 * reader switches a year off, the average must be recomputed over what is left
 * and must NOT bridge the hole — so the expand nulls the hidden periods, calls
 * THIS function over that sequence, and only then drops them. Any window
 * overlapping a hidden period therefore yields null and the line breaks exactly
 * as it already breaks at a month nothing was recorded in. Reusing this rather
 * than re-implementing it is what keeps one definition of the smoothing.
 */
export function rollingMean(
  values: readonly (number | null)[],
  i: number,
  window: number,
): number | null {
  if (i + 1 < window) return null;
  let total = 0;
  for (let k = i - window + 1; k <= i; k += 1) {
    const v = values[k];
    if (v == null) return null;
    total += v;
  }
  return total / window;
}

/**
 * How many periods the trailing mean spans, per granularity — and 0 at YEAR,
 * where a 3-year average over 7 points smooths away the only signal there is.
 * The ONE place that number is decided.
 */
export function rollingWindowFor(granularity: Granularity): number {
  return granularity === "Y" ? 0 : 3;
}

export interface MatrixOptions {
  granularity: Granularity;
  year: number;
  canViewPrices: boolean;
  perWorkingDay: boolean;
  /**
   * OWNER FEEDBACK R2 — period keys the reader has switched OFF in the column
   * checklist. Absent or empty means every column, which is the default and is
   * structural: the state is what is HIDDEN, so an empty set cannot mean
   * "nothing selected".
   *
   * A hidden period is removed from the columns AND from the trailing summary
   * fold, so the summary is genuinely the selection rather than the window with
   * a couple of columns painted out. It is NOT removed from `history`, and it
   * is NOT removed from the arithmetic behind a neighbouring cell: a March cell
   * still reads its move against February whether or not February is on screen.
   * Hiding a period may never restate one.
   */
  hiddenPeriods?: ReadonlySet<string>;
}

export interface Matrix<U = AnalyticsMonth> {
  granularity: Granularity;
  /** The columns actually rendered — the window, minus anything switched off. */
  periods: Period<U>[];
  /**
   * The window BEFORE the column filter — what the checklist lists, so the
   * control can still offer a period back after it has been hidden.
   */
  windowPeriods: Period<U>[];
  /**
   * The COMPLETE axis at this granularity, all history. What a row expand folds
   * an arbitrary year selection over (`foldSelection`), so the expand's own
   * "Selected" figure comes out of the same rollup machinery as every column.
   */
  allPeriods: Period<U>[];
  /** Some column is switched off, so the summary column is a SELECTION. */
  filtered: boolean;
  /**
   * The options this matrix was folded with. Carried so a consumer re-folding a
   * subset (the expand) cannot fold it under different rules than the grid did.
   */
  foldOptions: { canViewPrices: boolean; perWorkingDay: boolean };
  /**
   * R6 — the CLOCK's own rules, carried for the same reason `foldOptions` is:
   * the expand re-folds a selection through `foldSelection`, and folding a
   * campaign selection under the calendar's blank rules would explain a blank
   * with the wrong sentence.
   */
  rules: UnitRules<U>;
  rows: MatrixRow<U>[];
  callouts: Callout[];
  /**
   * Header for the trailing summary column — `2026` in M/Q, `All time` in Y,
   * and **`Selected` whenever a column is switched off**, because a fold over
   * four chosen months is not the year to date and must never be labelled as
   * one.
   */
  totalLabel: string;
  totalFullLabel: string;
}

/** What `foldSelection` answers: one figure over an arbitrary set of periods. */
export interface SelectionFold {
  value: number | null;
  blankReason: BlankReason | null;
  holed: boolean;
  estimated: boolean;
  isPartial: boolean;
  /** How many periods went into it. */
  periodCount: number;
}

/**
 * Fold an ARBITRARY set of periods through a row's OWN rollup rule.
 *
 * The row expand's year checklist needs a headline figure over whatever the
 * reader left switched on, and the one thing it must not do is average the
 * cells: a price is Σ pesos ÷ Σ priced kilos, a stock level is its period-end
 * month, and a mean of twelve monthly prices is a different — wrong — number.
 * So this is a thin wrapper over the SAME `foldPeriod` + `rawValue` pair the
 * summary column already goes through. No new arithmetic exists here at all.
 */
export function foldSelection<U>(
  spec: MetricSpecOf<U>,
  periods: readonly Period<U>[],
  opts: { canViewPrices: boolean; perWorkingDay: boolean },
  rules: UnitRules<U>,
): SelectionFold | null {
  const folded = foldPeriod(periods, "__selection", "Selected", "Selected periods");
  if (!folded) return null;
  const raw = rawValue(spec, folded, opts, rules);
  return {
    value: raw.value,
    blankReason: raw.blankReason,
    holed: raw.holed,
    estimated: raw.estimated,
    isPartial: folded.isPartial,
    periodCount: periods.length,
  };
}

/**
 * A synthetic period standing for the whole displayed window, so the summary
 * column goes through the SAME `rawValue` the periods do. Building it as a
 * period rather than as its own arithmetic is what guarantees the total obeys
 * each row's declared rollup instead of inventing a thirteenth rule.
 */
function foldPeriod<U>(
  periods: readonly Period<U>[],
  key: string,
  label: string,
  fullLabel: string,
): Period<U> | null {
  if (periods.length === 0) return null;
  const months = periods.flatMap((p) => p.months);
  if (months.length === 0) return null;
  return {
    key,
    label,
    fullLabel,
    year: periods[periods.length - 1].year,
    seq: 1,
    months,
    isPartial: periods.some((p) => p.isPartial),
  };
}

/**
 * WHAT THE SECOND CHIP UNDER A VALUE SHOWS (owner feedback R1).
 *
 * The FIRST indicator is always the period-over-period move and is not
 * switchable — it is the question the page is built around. This control only
 * decides what rides beside it: the same period a year earlier, or the same
 * move again as a raw amount in the row's own unit.
 */
export type ComparisonMode = "yoy" | "actual";

export const COMPARISON_MODES: readonly {
  key: ComparisonMode;
  label: string;
  title: string;
}[] = [
  {
    key: "yoy",
    label: "YoY %",
    title: "Second chip: the same period one year earlier, as a percentage.",
  },
  {
    key: "actual",
    label: "Δ actual",
    title:
      "Second chip: the change against the previous column as a real amount — tonnes, pesos, days — instead of a percentage.",
  },
];

/** One visual band of the matrix, with the rows that belong to it. */
export interface MatrixSection<U = AnalyticsMonth> {
  key: MetricSection;
  label: string;
  hint: string;
  /** The band's accent colour — a CSS var reference, applied as a left rule. */
  accent: string;
  rows: MatrixRow<U>[];
}

/**
 * Rows grouped into their declared bands, in `SECTIONS` order, empty bands
 * dropped. Presentation only — the grouping cannot change a single number,
 * which is why it lives beside the fold rather than inside it.
 *
 * `only` narrows to a subset of bands so the SAME table component can render
 * the flow + money bands at the top of the page and the production band down
 * in its own section. The fold is unchanged either way: `buildMatrix` still
 * produces every row in one pass, so the callout strip still ranks production
 * against money against volume, and a production record is judged by exactly
 * the same machinery.
 */
export function groupBySection<U>(
  rows: readonly MatrixRow<U>[],
  only?: readonly MetricSection[],
): MatrixSection<U>[] {
  const wanted = only ? new Set(only) : null;
  return SECTIONS.filter((s) => !wanted || wanted.has(s.key))
    .map((s) => ({
      key: s.key,
      label: s.label,
      hint: s.hint,
      accent: s.accent,
      rows: rows.filter((r) => r.metric.section === s.key),
    }))
    .filter((s) => s.rows.length > 0);
}

/**
 * What `assembleMatrix` needs that is not a `MetricSpec` — one object per
 * CLOCK, so the fold below is written once (owner feedback R6).
 */
export interface MatrixAxis<U> {
  granularity: Granularity;
  /** The COMPLETE axis, all history, ascending. */
  all: Period<U>[];
  /** The window this view shows, BEFORE the column filter. */
  windowPeriods: Period<U>[];
  /** Header + hover for the trailing summary column, given the selection. */
  totalLabels(shown: readonly Period<U>[], filtered: boolean): {
    label: string;
    fullLabel: string;
  };
  /**
   * The like-for-like comparison fold behind the summary column's chip, or
   * `null` where none is honest. It is a callback rather than a period because
   * the answer depends on the selection: folding four chosen months against a
   * full prior twelve would be a restatement wearing a year-ago comparison.
   */
  priorTotal(
    selectedSeq: ReadonlySet<number>,
    filtered: boolean,
  ): Period<U> | null;
}

/**
 * THE fold, over any clock. One pass, one set of numbers, shared by the grid,
 * the charts and the callouts.
 *
 * R6 split this out of `buildMatrix` so the Production band's campaign columns
 * go through the identical machinery — same rollup contract, same callout gate,
 * same delta rules — rather than through a second implementation that would
 * have drifted. `buildMatrix` below is now the calendar instantiation of it and
 * behaves exactly as it did.
 */
export function assembleMatrix<U>(
  specs: readonly MetricSpecOf<U>[],
  axis: MatrixAxis<U>,
  opts: {
    canViewPrices: boolean;
    perWorkingDay: boolean;
    hiddenPeriods?: ReadonlySet<string>;
  },
  rules: UnitRules<U>,
): Matrix<U> {
  const all = axis.all;
  const windowPeriods = axis.windowPeriods;

  // ── OWNER FEEDBACK R2 — the column checklist ──────────────────────────
  // Hidden periods leave the COLUMNS and leave the SUMMARY fold. They do not
  // leave `all`, so every delta and every year-ago chip is still measured
  // against the period that really precedes it.
  const hidden = opts.hiddenPeriods;
  const shown =
    hidden && hidden.size > 0
      ? windowPeriods.filter((p) => !hidden.has(p.key))
      : windowPeriods;
  const filtered = shown.length < windowPeriods.length;
  // `displayed` is what makes a hidden period unquotable by the callout strip:
  // the record branch requires the extreme period to be displayed, and the
  // mover / year-ago branches only ever walk `cells`, which are built from
  // `shown`. One set, both guarantees.
  const shownKeys = new Set(shown.map((p) => p.key));

  const indexByKey = new Map(all.map((p, i) => [p.key, i]));
  const yoyIndex = new Map<string, number>();
  for (const p of all) yoyIndex.set(`${p.year}:${p.seq}`, indexByKey.get(p.key)!);

  const rollingWindow = rollingWindowFor(axis.granularity);

  // The trailing summary column, and — where the clock has one — the SAME fold
  // over the comparable prior window, so the summary carries an honest
  // year-ago chip instead of a delta against nothing.
  const { label: totalLabel, fullLabel: totalFullLabel } = axis.totalLabels(
    shown,
    filtered,
  );
  const totalPeriod = foldPeriod(shown, "__total", totalLabel, totalFullLabel);
  // The summary's comparison chip must compare LIKE WITH LIKE. Folding four
  // selected months against the previous year's full twelve would not be a
  // year-ago comparison, it would be a restatement wearing one — so the prior
  // year is narrowed to the same positions within it.
  const selectedSeq = new Set(shown.map((p) => p.seq));
  const priorTotalPeriod = axis.priorTotal(selectedSeq, filtered);

  const rows: MatrixRow<U>[] = specs.map((spec) => {
    const raws = all.map((p) =>
      rawValue(
        spec,
        p,
        {
          canViewPrices: opts.canViewPrices,
          perWorkingDay: opts.perWorkingDay,
        },
        rules,
      ),
    );
    const values = raws.map((r) => r.value);

    const pointLabel = (p: Period<U>) =>
      p.label === String(p.year) ? p.label : `${p.label} ${String(p.year).slice(2)}`;

    // The metric's FIRST period on record. A stream that opened part-way
    // through a period makes that period a reporting boundary, not a
    // business fact — so it is the ONE period no headline may quote.
    // The row's own caveats, one per period of the FULL axis. Computed here
    // beside `raws` so the callout gate below can read them by index — the
    // same reason `estimated` is folded in `rawValue` rather than checked at
    // the point of render.
    const anns = all.map((p) =>
      spec.annotate ? spec.annotate(p.months) : null,
    );

    const firstIdx = values.findIndex((v) => v != null);
    const quotable = (i: number) =>
      !all[i].isPartial &&
      !raws[i].estimated &&
      !anns[i]?.blocksCallout &&
      firstIdx >= 0 &&
      i > firstIdx;

    const history: HistoryPoint[] = all.map((p, i) => ({
      periodKey: p.key,
      label: pointLabel(p),
      fullLabel: p.fullLabel,
      year: p.year,
      value: values[i],
      isPartial: p.isPartial,
      avg: rollingWindow > 0 ? rollingMean(values, i, rollingWindow) : null,
      displayed: shownKeys.has(p.key),
      annotation: anns[i],
      calloutable: quotable(i),
    }));

    const cells: MatrixCell[] = shown.map((p) => {
      const i = indexByKey.get(p.key)!;
      const raw = raws[i];
      const prev = i > 0 ? values[i - 1] : null;
      const yoyIdx =
        axis.granularity === "Y" ? undefined : yoyIndex.get(`${p.year - 1}:${p.seq}`);
      return {
        periodKey: p.key,
        value: raw.value,
        blankReason: raw.blankReason,
        holed: raw.holed,
        isPartial: p.isPartial,
        estimated: raw.estimated,
        annotation: anns[i],
        calloutable: quotable(i),
        delta: change(raw.value, prev, spec.deltaMode),
        deltaAbs:
          spec.deltaMode === "abs" ? null : change(raw.value, prev, "abs"),
        deltaQuotable: i > 0 && quotable(i - 1),
        yoy:
          yoyIdx === undefined
            ? null
            : change(raw.value, values[yoyIdx], spec.deltaMode),
        yoyQuotable: yoyIdx !== undefined && quotable(yoyIdx),
      };
    });

    // The comparison series, folded through the SAME rollup rules over the
    // SAME periods. No rolling mean: two trend lines plus two smoothed ones
    // is four series in a 260px chart, which reads as noise.
    const pairHistories: HistoryPoint[][] | null = spec.pairs?.length
      ? spec.pairs.map((pair) =>
          all.map((p) => {
            const raw = rawValue(
              {
                rollup: spec.rollup,
                read: pair.read,
                numerator: pair.numerator,
                denominator: pair.denominator,
                price: spec.price,
                perWorkingDay: spec.perWorkingDay,
                estimated: spec.estimated,
                dependsOn: spec.dependsOn,
              },
              p,
              {
                canViewPrices: opts.canViewPrices,
                perWorkingDay: opts.perWorkingDay,
              },
              rules,
            );
            return {
              periodKey: p.key,
              label: pointLabel(p),
              fullLabel: p.fullLabel,
              year: p.year,
              value: raw.value,
              isPartial: p.isPartial,
              avg: null,
              displayed: shownKeys.has(p.key),
              annotation: null,
              // A comparison line is context for the row's own series; it is
              // never itself the subject of a headline.
              calloutable: false,
            };
          }),
        )
      : null;

    const rollOpts = {
      canViewPrices: opts.canViewPrices,
      perWorkingDay: opts.perWorkingDay,
    };
    const totalRaw = totalPeriod
      ? rawValue(spec, totalPeriod, rollOpts, rules)
      : null;
    const priorTotalRaw = priorTotalPeriod
      ? rawValue(spec, priorTotalPeriod, rollOpts, rules)
      : null;

    const total: MatrixCell | null =
      totalPeriod && totalRaw
        ? {
            periodKey: totalPeriod.key,
            value: totalRaw.value,
            blankReason: totalRaw.blankReason,
            holed: totalRaw.holed,
            isPartial: totalPeriod.isPartial,
            estimated: totalRaw.estimated,
            annotation: spec.annotate ? spec.annotate(totalPeriod.months) : null,
            // The summary column is never a callout subject: it is a fold of
            // the window, not a period anyone can point at.
            calloutable: false,
            // A summary column has no "previous column" in view; the honest
            // comparison for a full year IS the year before it.
            delta: null,
            // A summary column has no previous column, so its "actual change"
            // is the same year-on-year comparison its chip already makes —
            // expressed in the row's own unit rather than as a percentage.
            deltaAbs:
              spec.deltaMode === "abs"
                ? null
                : change(totalRaw.value, priorTotalRaw?.value ?? null, "abs"),
            deltaQuotable: false,
            yoy: change(totalRaw.value, priorTotalRaw?.value ?? null, spec.deltaMode),
            yoyQuotable: false,
          }
        : null;

    return {
      metric: spec,
      cells,
      total,
      history,
      pairHistories,
      restricted: spec.price && !opts.canViewPrices,
    };
  });

  return {
    granularity: axis.granularity,
    periods: shown,
    windowPeriods,
    allPeriods: all,
    filtered,
    foldOptions: {
      canViewPrices: opts.canViewPrices,
      perWorkingDay: opts.perWorkingDay,
    },
    rules,
    rows,
    callouts: buildCallouts(rows, axis.granularity),
    totalLabel,
    totalFullLabel,
  };
}

/**
 * The CALENDAR instantiation — the RC Inventory band, unchanged in behaviour.
 *
 * Every label rule that used to live inline in the fold lives here now, which
 * is where it belongs: "All time" at YEAR granularity and "the same months" on
 * a filtered prior year are facts about a CALENDAR, and the batch clock answers
 * both questions differently.
 */
export function buildMatrix(
  months: readonly AnalyticsMonth[],
  opts: MatrixOptions,
): Matrix {
  const all = buildPeriods(months, opts.granularity);
  const windowPeriods = displayedPeriods(all, opts.granularity, opts.year);
  const periodPlural =
    opts.granularity === "M"
      ? "months"
      : opts.granularity === "Q"
        ? "quarters"
        : "years";

  return assembleMatrix(
    METRICS,
    {
      granularity: opts.granularity,
      all,
      windowPeriods,
      totalLabels: (shown, filtered) => {
        // A fold over four chosen months is NOT the year to date. When anything
        // is switched off the column says so in its own header rather than
        // carrying a year label over a number that is not the year.
        const windowLabel =
          opts.granularity === "Y" ? "All time" : String(opts.year);
        return {
          label: filtered ? "Selected" : windowLabel,
          fullLabel: filtered
            ? `${shown.length} of ${windowPeriods.length} ${periodPlural} selected` +
              (opts.granularity === "Y" ? "" : ` · ${opts.year}`)
            : opts.granularity === "Y"
              ? "All years"
              : `${opts.year} · full year`,
        };
      },
      priorTotal: (selectedSeq, filtered) =>
        opts.granularity === "Y"
          ? null
          : foldPeriod(
              displayedPeriods(all, opts.granularity, opts.year - 1).filter(
                (p) => !filtered || selectedSeq.has(p.seq),
              ),
              "__total_prior",
              String(opts.year - 1),
              filtered
                ? `${opts.year - 1} · the same ${periodPlural}`
                : `${opts.year - 1} · full year`,
            ),
    },
    {
      canViewPrices: opts.canViewPrices,
      perWorkingDay: opts.perWorkingDay,
      hiddenPeriods: opts.hiddenPeriods,
    },
    MONTH_RULES,
  );
}

// ---------------------------------------------------------------------
// Callouts — MAGNITUDE ONLY
// ---------------------------------------------------------------------
//
// The plan is explicit: no thresholds, no invented "breach" rules, no
// target-based colouring. So a callout may only ever say one of three
// things, each of which is a fact about the SIZE of a move:
//
//   1. the largest period-over-period change in the displayed window;
//   2. the largest year-ago change in the displayed window;
//   3. a value that is the highest or lowest this metric has ever read.
//
// A record is judged against the metric's OWN history at the SAME
// granularity, and an in-progress period is excluded from BOTH sides of
// that test — it can neither set a record nor depress one, because it is
// not finished.
//
// A restricted (₱-withheld) row contributes nothing: its values are null,
// so no sentence about it can be composed, and no peso reaches a role that
// may not see one.
//
// ── THE P2 GUARD: AN ESTIMATE OR A FIRST PERIOD MAY NOT BE A HEADLINE ──
// P1's population filter was "settled and non-null", which was enough while
// every row was a plain count of things that happened. The money rows break
// it in two measurable ways, so `MatrixCell.calloutable` (built in
// `buildMatrix`, where the indices are known) gates every candidate here:
//
//   • **An ESTIMATE cannot be a record or the biggest move.** Seven months
//     cannot price all the kilos they fed, so their money figures are
//     extrapolations from the kilos they can trace. Quoting March 2024 —
//     which prices 1.6% of what it fed — as the cheapest month on record
//     would be a sentence about a hole in the data dressed as a sentence
//     about the business.
//   • **Nor can a metric's FIRST period.** A stream that opened part-way
//     through a month makes that month a reporting boundary. Production
//     reporting opened in mid-November 2025, so November reads an 11.9%
//     yield and ₱337 per produced kilo against a real ~₱50 — the single
//     largest "record" and "biggest move" on the whole board, and a lie
//     about the plant. Derived from the data (the first non-null period),
//     never from a hardcoded date, so it retires itself as history fills in.
//
//   • **Nor an IN-PROGRESS period, for a MOVER either.** P1 already refused
//     to let an unfinished period set or depress a record, and stated the
//     reason as "it is not finished" — but the mover and year-ago branches
//     never applied it, which nobody noticed while every row was a volume.
//     A ratio breaks it immediately: on the first day of a month the money
//     rows carry one day of feeding against one day of production, and the
//     strip's top line became "₱ per produced kg rose 177.7% MoM in
//     September 2026 — the biggest month-on-month move on the board." The
//     rule is now applied once, to all three kinds.
//
//   • **NOR AN ANNOTATED CELL (P4).** A row may declare its own caveat for a
//     period (`MetricSpec.annotate`), and a figure the page is itself warning
//     about can never be the thing the page leads with. Measured, both would
//     have topped the strip on the first render: August 2026 reads 0.00
//     downtime hours because all 23 shifts recorded the repair and none
//     recorded the duration — the lowest "record" on the board — and March
//     2026 carries one mis-keyed meter reading worth 676,944 kWh, which is
//     both the largest month-on-month move and the highest value the Power
//     row has ever had. Same rule, same one gate.
//
//   • **AND A CHANGE NEEDS BOTH ENDS.** `cell.calloutable` gates the period a
//     sentence is ABOUT; a mover and a year-ago gap are statements about two
//     periods, so the one being measured FROM has to pass the same gate.
//     Measured on the first P4 render, this was the top line of the strip:
//     *"Power fell 97.6% MoM in April 2026, to 16,572 kWh — the biggest
//     month-on-month move on the board."* April's own cell is sound and
//     passed every gate above; the 97.6% is entirely the mis-keyed March
//     reading it was divided by. The same shape had been latent since P1 for
//     the period immediately after a metric's first — a fall from a reporting
//     boundary is a fact about when reporting started, not about the plant.
//
// All five gates are CALLOUT-ONLY. Every one of those cells still renders,
// still carries its delta, and still says in its hover exactly what it is.

export type CalloutKind = "mover" | "yoy" | "high" | "low";

export interface Callout {
  key: string;
  kind: CalloutKind;
  metricKey: MetricKey;
  /** The whole sentence, already written. */
  text: string;
}

/** Records need enough history to be worth the word "record". */
const MIN_HISTORY_FOR_RECORD = 6;
const MAX_CALLOUTS = 5;

/** Magnitude only — for a sentence whose VERB already says which way it went. */
function unsigned(value: number, decimals: number): string {
  return value.toLocaleString("en-US", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

function signed(value: number, decimals: number): string {
  const sign = value > 0 ? "+" : value < 0 ? "−" : "";
  return `${sign}${Math.abs(value).toLocaleString("en-US", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  })}`;
}

function plainValue(spec: MetricSpecOf<unknown>, v: number): string {
  const n = v.toLocaleString("en-US", {
    minimumFractionDigits: spec.decimals,
    maximumFractionDigits: spec.decimals,
  });
  switch (spec.unit) {
    case "php_per_kg":
      return `₱${n}/kg`;
    case "php":
      return `₱${n}`;
    case "tonnes":
      return `${n} t`;
    case "days":
      return `${n} days`;
    case "pct":
      return `${n}%`;
    case "hours":
      return `${n} h`;
    case "kwh":
      return `${n} kWh`;
    case "kwh_per_kg":
      return `${n} kWh/kg`;
    default:
      return n;
  }
}

export function buildCallouts<U>(
  rows: readonly MatrixRow<U>[],
  granularity: Granularity,
): Callout[] {
  const periodNoun =
    granularity === "M"
      ? "month"
      : granularity === "Q"
        ? "quarter"
        : granularity === "B"
          ? "batch"
          : "year";
  const deltaWord = DELTA_LABEL[granularity];

  interface Candidate {
    callout: Callout;
    /** Ranking magnitude WITHIN its kind. */
    magnitude: number;
    /**
     * The same sentence WITHOUT the superlative. Only the top-ranked mover may
     * claim to be the biggest move on the board — a backfilled one that repeats
     * the claim makes every line on the strip a lie about the others.
     */
    plainText?: string;
  }

  const movers: Candidate[] = [];
  const yoys: Candidate[] = [];
  const records: Candidate[] = [];

  for (const row of rows) {
    const spec = row.metric;
    if (row.restricted) continue;

    const labelForPeriod = (key: string) =>
      row.history.find((h) => h.periodKey === key)?.fullLabel ?? key;

    // ── 1 + 2. Movers, ranked WITHIN their delta mode ──────────────────
    // A percentage and a raw difference are not comparable, so they are ranked
    // separately and the percentage list is preferred — "volume fell 34%" reads
    // as a finding, "suppliers fell by 2" reads as a fact.
    for (const cell of row.cells) {
      if (cell.value == null) continue;
      if (!cell.calloutable) continue;
      // A change is a statement about TWO periods, so the base has to be
      // quotable too — see `MatrixCell.deltaQuotable`.
      if (cell.delta && cell.deltaQuotable) {
        const moveWords =
          spec.deltaMode === "pct"
            ? `${cell.delta.value > 0 ? "rose" : "fell"} ${unsigned(Math.abs(cell.delta.value), 1)}% ${deltaWord}`
            : `moved ${signed(cell.delta.value, spec.decimals)} ${deltaWord}`;
        const moveHead = `${spec.label} ${moveWords} in ${labelForPeriod(cell.periodKey)}, to ${plainValue(spec, cell.value)}`;
        movers.push({
          magnitude:
            (spec.deltaMode === "pct" ? 1000 : 1) * Math.abs(cell.delta.value),
          plainText: `${moveHead}.`,
          callout: {
            key: `mover:${spec.key}:${cell.periodKey}`,
            kind: "mover",
            metricKey: spec.key,
            // The VERB already carries the direction, so the number must not
            // carry a sign too — "fell −100%" reads as a rise.
            text: `${moveHead} — the biggest ${periodNoun}-on-${periodNoun} move on the board.`,
          },
        });
      }
      if (cell.yoy && cell.yoyQuotable) {
        yoys.push({
          magnitude:
            (spec.deltaMode === "pct" ? 1000 : 1) * Math.abs(cell.yoy.value),
          callout: {
            key: `yoy:${spec.key}:${cell.periodKey}`,
            kind: "yoy",
            metricKey: spec.key,
            text:
              spec.deltaMode === "pct"
                ? `${spec.label} in ${labelForPeriod(cell.periodKey)} is ${signed(cell.yoy.value, 1)}% against a year earlier — the widest year-ago gap in view.`
                : `${spec.label} in ${labelForPeriod(cell.periodKey)} is ${signed(cell.yoy.value, spec.decimals)} against a year earlier — the widest year-ago gap in view.`,
          },
        });
      }
    }

    // ── 3. Records, over the metric's OWN complete history ─────────────
    // The population is BOTH sides of the test, so an estimate or a
    // first-period boundary is excluded from the runner-up comparison too —
    // otherwise ₱337 in November 2025 would still be the thing every other
    // month is measured against.
    const settled = row.history.filter(
      (h): h is HistoryPoint & { value: number } =>
        !h.isPartial && h.value != null && h.calloutable,
    );
    if (settled.length < MIN_HISTORY_FOR_RECORD) continue;

    let max = settled[0];
    let min = settled[0];
    for (const h of settled) {
      if (h.value > max.value) max = h;
      if (h.value < min.value) min = h;
    }

    for (const [extreme, kind] of [
      [max, "high"],
      [min, "low"],
    ] as const) {
      const inWindow = row.history.find(
        (h) => h.periodKey === extreme.periodKey && h.displayed,
      );
      if (!inWindow) continue;
      // How far clear of the runner-up it is — the ranking, so a record that
      // merely ties last year does not outrank one that broke away.
      const others = settled.filter((h) => h.periodKey !== extreme.periodKey);
      const runnerUp =
        kind === "high"
          ? Math.max(...others.map((h) => h.value))
          : Math.min(...others.map((h) => h.value));
      const gap = runnerUp === 0 ? 0 : Math.abs((extreme.value - runnerUp) / runnerUp) * 100;
      records.push({
        magnitude: gap,
        callout: {
          key: `${kind}:${spec.key}:${extreme.periodKey}`,
          kind,
          metricKey: spec.key,
          text: `${extreme.fullLabel} is the ${kind === "high" ? "highest" : "lowest"} ${spec.label} on record at ${plainValue(spec, extreme.value)}, across ${settled.length} settled ${periodNoun}s.`,
        },
      });
    }
  }

  const byMagnitude = (a: Candidate, b: Candidate) => b.magnitude - a.magnitude;
  movers.sort(byMagnitude);
  yoys.sort(byMagnitude);
  records.sort(byMagnitude);

  // Order: the biggest move, the biggest year-ago gap, then records — and never
  // two lines about the same metric, which reads as padding rather than as news.
  const out: Callout[] = [];
  const seenMetrics = new Set<MetricKey>();
  const push = (c: Callout | undefined) => {
    if (!c || out.length >= MAX_CALLOUTS || seenMetrics.has(c.metricKey)) return;
    seenMetrics.add(c.metricKey);
    out.push(c);
  };

  push(movers[0]?.callout);
  push(yoys[0]?.callout);
  for (const r of records) push(r.callout);
  // Backfill with the next-biggest movers when there were no records to report —
  // WITHOUT the superlative, which belongs to the first one alone.
  for (const m of movers.slice(1)) {
    push(m.plainText ? { ...m.callout, text: m.plainText } : m.callout);
  }

  return out;
}
