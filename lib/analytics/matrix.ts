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
// Pure and client-safe: no React, no Supabase, no `server-only`.
// =====================================================================

import type { AnalyticsMonth } from "./types";
import {
  METRICS,
  type DeltaMode,
  type MetricKey,
  type MetricSpec,
} from "./metrics";

// ---------------------------------------------------------------------
// The period axis
// ---------------------------------------------------------------------

/** Month · Quarter · Year — the matrix's column granularity. */
export type Granularity = "M" | "Q" | "Y";

export const GRANULARITY_LABEL: Record<Granularity, string> = {
  M: "Month",
  Q: "Quarter",
  Y: "Year",
};

/** What the period-over-period delta is CALLED at each granularity. */
export const DELTA_LABEL: Record<Granularity, string> = {
  M: "MoM",
  Q: "QoQ",
  Y: "YoY",
};

const MONTH_SHORT = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

const MONTH_LONG = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

/** One column of the matrix — a month, a quarter or a year. */
export interface Period {
  /** Stable identity: `2026-03` · `2026-Q1` · `2026`. */
  key: string;
  /** Column header — `Mar` · `Q1` · `2026`. */
  label: string;
  /** Tooltip / chart axis — `March 2026` · `Q1 2026` · `2026`. */
  fullLabel: string;
  year: number;
  /** Position WITHIN the year: 1–12 · 1–4 · 1. Pairs a period with its year-ago twin. */
  seq: number;
  /** The months that make it up, ascending. Never empty. */
  months: AnalyticsMonth[];
  /** Some constituent month has not finished. A record cannot be claimed on it. */
  isPartial: boolean;
}

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
  /** Change against the immediately preceding period at this granularity. */
  delta: Change | null;
  /** Change against the same period one year earlier. Null in the YEAR view — it would repeat `delta`. */
  yoy: Change | null;
}

export interface MatrixRow {
  metric: MetricSpec;
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
  /** The row is ₱-bearing and this viewer may not see ₱. */
  restricted: boolean;
}

export interface HistoryPoint {
  periodKey: string;
  /** Chart axis label — short at month granularity, so 75 bars still tick. */
  label: string;
  fullLabel: string;
  value: number | null;
  isPartial: boolean;
  /** Trailing 3-period mean. Presentation smoothing only; null at YEAR granularity. */
  avg: number | null;
  /** Is this period inside the currently displayed window? Drives the chart's emphasis. */
  displayed: boolean;
}

/** What one period contributes for one metric, before deltas are attached. */
interface RawValue {
  value: number | null;
  holed: boolean;
  blankReason: BlankReason | null;
}

function sumNonNull(
  months: readonly AnalyticsMonth[],
  pick: (m: AnalyticsMonth) => number | null,
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
 * ONE period's figure for ONE metric — the whole of the rollup contract.
 *
 * `perWorkingDay` divides an additive row by the period's OWN working days
 * (summed, exactly as the row is summed), which is why the toggle is
 * arithmetically safe on a quarter and a year and not only on a month.
 */
function rawValue(
  spec: MetricSpec,
  period: Period,
  opts: { canViewPrices: boolean; perWorkingDay: boolean },
): RawValue {
  if (spec.price && !opts.canViewPrices) {
    return { value: null, holed: false, blankReason: "restricted" };
  }

  const noOutflowEverywhere = period.months.every((m) => !m.outflowRecorded);

  const blankFor = (): BlankReason =>
    noOutflowEverywhere &&
    (spec.key === "rc_out" || spec.key === "net_flow" || spec.key === "runway")
      ? "no_outflow"
      : "no_data";

  if (spec.rollup === "weighted") {
    const num = sumNonNull(period.months, spec.numerator!);
    const den = sumNonNull(period.months, spec.denominator!);
    if (den.total <= 0 || num.had === 0) {
      return { value: null, holed: false, blankReason: blankFor() };
    }
    return { value: num.total / den.total, holed: false, blankReason: null };
  }

  if (spec.rollup === "periodEnd") {
    // The LAST month of the period, not the last month that happens to carry a
    // value: "as of the period end" is the claim, and silently reaching further
    // back would date the figure without saying so.
    const last = period.months[period.months.length - 1];
    const v = spec.read(last);
    if (v == null || !Number.isFinite(v)) {
      return { value: null, holed: false, blankReason: blankFor() };
    }
    return { value: v, holed: false, blankReason: null };
  }

  if (spec.rollup === "peak") {
    const vals = period.months
      .map((m) => spec.read(m))
      .filter((v): v is number => v != null && Number.isFinite(v));
    if (vals.length === 0) {
      return { value: null, holed: false, blankReason: blankFor() };
    }
    return {
      value: Math.max(...vals),
      holed: vals.length < period.months.length,
      blankReason: null,
    };
  }

  // sum
  const { total, had, missing } = sumNonNull(period.months, spec.read);
  if (had === 0) return { value: null, holed: false, blankReason: blankFor() };

  if (opts.perWorkingDay && spec.perWorkingDay) {
    const days = period.months.reduce((acc, m) => acc + (m.workingDays ?? 0), 0);
    if (days <= 0) return { value: null, holed: missing > 0, blankReason: "no_data" };
    return { value: total / days, holed: missing > 0, blankReason: null };
  }

  return { value: total, holed: missing > 0, blankReason: null };
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

/** Trailing mean over `window` periods, INCLUDING blanks as gaps (they break it). */
function rollingMean(values: (number | null)[], i: number, window: number): number | null {
  if (i + 1 < window) return null;
  let total = 0;
  for (let k = i - window + 1; k <= i; k += 1) {
    const v = values[k];
    if (v == null) return null;
    total += v;
  }
  return total / window;
}

export interface MatrixOptions {
  granularity: Granularity;
  year: number;
  canViewPrices: boolean;
  perWorkingDay: boolean;
}

export interface Matrix {
  granularity: Granularity;
  periods: Period[];
  rows: MatrixRow[];
  callouts: Callout[];
  /** Header for the trailing summary column — `2026` in M/Q, `All time` in Y. */
  totalLabel: string;
  totalFullLabel: string;
}

/**
 * A synthetic period standing for the whole displayed window, so the summary
 * column goes through the SAME `rawValue` the periods do. Building it as a
 * period rather than as its own arithmetic is what guarantees the total obeys
 * each row's declared rollup instead of inventing a thirteenth rule.
 */
function foldPeriod(
  periods: readonly Period[],
  key: string,
  label: string,
  fullLabel: string,
): Period | null {
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

/** THE fold. One pass, one set of numbers, shared by the grid, the charts and the callouts. */
export function buildMatrix(
  months: readonly AnalyticsMonth[],
  opts: MatrixOptions,
): Matrix {
  const all = buildPeriods(months, opts.granularity);
  const shown = displayedPeriods(all, opts.granularity, opts.year);
  const shownKeys = new Set(shown.map((p) => p.key));

  const indexByKey = new Map(all.map((p, i) => [p.key, i]));
  const yoyIndex = new Map<string, number>();
  for (const p of all) yoyIndex.set(`${p.year}:${p.seq}`, indexByKey.get(p.key)!);

  const rollingWindow = opts.granularity === "Y" ? 0 : 3;

  // The trailing summary column, and — for a year-scoped view — the SAME fold
  // over the year before, so the summary carries an honest year-ago chip
  // instead of a delta against nothing.
  const totalLabel = opts.granularity === "Y" ? "All time" : String(opts.year);
  const totalFullLabel =
    opts.granularity === "Y" ? "All years" : `${opts.year} · full year`;
  const totalPeriod = foldPeriod(shown, "__total", totalLabel, totalFullLabel);
  const priorTotalPeriod =
    opts.granularity === "Y"
      ? null
      : foldPeriod(
          displayedPeriods(all, opts.granularity, opts.year - 1),
          "__total_prior",
          String(opts.year - 1),
          `${opts.year - 1} · full year`,
        );

  const rows: MatrixRow[] = METRICS.map((spec) => {
    const raws = all.map((p) =>
      rawValue(spec, p, {
        canViewPrices: opts.canViewPrices,
        perWorkingDay: opts.perWorkingDay,
      }),
    );
    const values = raws.map((r) => r.value);

    const history: HistoryPoint[] = all.map((p, i) => ({
      periodKey: p.key,
      label: p.label === String(p.year) ? p.label : `${p.label} ${String(p.year).slice(2)}`,
      fullLabel: p.fullLabel,
      value: values[i],
      isPartial: p.isPartial,
      avg: rollingWindow > 0 ? rollingMean(values, i, rollingWindow) : null,
      displayed: shownKeys.has(p.key),
    }));

    const cells: MatrixCell[] = shown.map((p) => {
      const i = indexByKey.get(p.key)!;
      const raw = raws[i];
      const prev = i > 0 ? values[i - 1] : null;
      const yoyIdx = opts.granularity === "Y" ? undefined : yoyIndex.get(`${p.year - 1}:${p.seq}`);
      return {
        periodKey: p.key,
        value: raw.value,
        blankReason: raw.blankReason,
        holed: raw.holed,
        isPartial: p.isPartial,
        delta: change(raw.value, prev, spec.deltaMode),
        yoy:
          yoyIdx === undefined
            ? null
            : change(raw.value, values[yoyIdx], spec.deltaMode),
      };
    });

    const rollOpts = {
      canViewPrices: opts.canViewPrices,
      perWorkingDay: opts.perWorkingDay,
    };
    const totalRaw = totalPeriod ? rawValue(spec, totalPeriod, rollOpts) : null;
    const priorTotalRaw = priorTotalPeriod
      ? rawValue(spec, priorTotalPeriod, rollOpts)
      : null;

    const total: MatrixCell | null =
      totalPeriod && totalRaw
        ? {
            periodKey: totalPeriod.key,
            value: totalRaw.value,
            blankReason: totalRaw.blankReason,
            holed: totalRaw.holed,
            isPartial: totalPeriod.isPartial,
            // A summary column has no "previous column" in view; the honest
            // comparison for a full year IS the year before it.
            delta: null,
            yoy: change(totalRaw.value, priorTotalRaw?.value ?? null, spec.deltaMode),
          }
        : null;

    return {
      metric: spec,
      cells,
      total,
      history,
      restricted: spec.price && !opts.canViewPrices,
    };
  });

  return {
    granularity: opts.granularity,
    periods: shown,
    rows,
    callouts: buildCallouts(rows, opts.granularity),
    totalLabel,
    totalFullLabel,
  };
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

function plainValue(spec: MetricSpec, v: number): string {
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
    default:
      return n;
  }
}

export function buildCallouts(
  rows: readonly MatrixRow[],
  granularity: Granularity,
): Callout[] {
  const periodNoun =
    granularity === "M" ? "month" : granularity === "Q" ? "quarter" : "year";
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
      if (cell.delta) {
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
      if (cell.yoy) {
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
    const settled = row.history.filter(
      (h): h is HistoryPoint & { value: number } =>
        !h.isPartial && h.value != null,
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
