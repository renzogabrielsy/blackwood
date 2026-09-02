// =====================================================================
// ICTC Owner Analytics — THE PRODUCTION ROOM's pure fold (P4)
// =====================================================================
// One pass over `view_analytics_production_grade_monthly`'s rows turns them
// into the grade × month mini-matrix: what the plant made, split by product.
//
// Pure and client-safe — no React, no Supabase, no `server-only`. Same
// discipline as `matrix.ts` and `supplier.ts`: the SQL layer owns every
// DEFINITION, this module only folds published figures across months.
//
// ── THE TIE THAT MAKES THIS BLOCK WORTH TRUSTING ──────────────────────
// The `Σ made` footer prints the **monthly series' own `producedKg`** — the
// very field the Production output row of the matrix reads — and NOT a sum of
// the grade rows above it. The two are equal by proof (Σ grade `kg` = the
// parent view's `produced_kg`, 0 mismatches across 10 of 10 months, max gap
// 0.0 kg), so printing the published one means the grade mix and the matrix
// row cannot drift apart even in principle. It is the same trick the supplier
// room's `Σ market` row uses, for the same reason.
//
// ── AND ONE RULE ABOUT SHARES ─────────────────────────────────────────
// `shareOfMonthPct` is SQL's own, and its denominator is JOINED from
// `view_analytics_production_monthly` rather than re-summed there — so a
// grade share and the monthly headline are the same arithmetic. Nothing here
// recomputes a monthly share. The YEAR share IS computed here, and it is
// Σ kilos ÷ Σ kilos (a weighted figure by construction), never the mean of
// twelve monthly percentages.
// =====================================================================

import type { MetricDictionaryEntry } from "./metrics";
import type { AnalyticsMonth, ProductionGradeMonth } from "./types";

const MONTH_SHORT = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

const MONTH_LONG = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

/** One (grade × month) cell of the mini-matrix. */
export interface GradeCell {
  monthStart: string;
  /** `Mar 2026` — the hover's period name. */
  fullLabel: string;
  /** Kilos of this grade made that month. `null` = the grade was not run. */
  kg: number | null;
  /** PERCENT 0-100, SQL's own. `null` when `kg` is. */
  sharePct: number | null;
  runCount: number | null;
  /** NULL (never 0) wherever bags were not being counted. */
  sacks: number | null;
}

/** One grade's whole year — the matrix row plus its YTD summary column. */
export interface GradeRow {
  grade: string;
  /** One slot per displayed month. `null` = this grade was not made that month. */
  cells: readonly (GradeCell | null)[];
  /** YTD kilos — a plain sum, the only rollup a volume allows. */
  kg: number;
  /** YTD share of the year's produced kilos. Weighted by construction (Σ ÷ Σ). */
  sharePct: number | null;
  runCount: number;
  /** Months in which this grade was actually made. */
  activeMonths: number;
  /** 1-based rank by YTD kilos. */
  rank: number;
  /** NULL (never 0) when no run of this grade recorded a bag count all year. */
  sacks: number | null;
}

/** One column of the mini-matrix — a month of the selected year. */
export interface GradeMonthColumn {
  monthStart: string;
  month: number;
  /** `Mar` */
  label: string;
  /** `March 2026` */
  fullLabel: string;
  /**
   * The month's produced kilos as **the monthly series publishes them** —
   * literally the field the Production output row reads. The footer prints
   * THIS, never a sum of the column. See the file header.
   */
  producedKg: number | null;
  /** How many grades were made that month. 1 = a single-product month. */
  gradeCount: number;
}

/** Everything the grade mini-matrix renders for one year. */
export interface GradeYear {
  year: number;
  /** Only months that actually reported production — no empty columns. */
  months: readonly GradeMonthColumn[];
  /** Ranked by YTD kilos, DESC. */
  rows: readonly GradeRow[];
  /** Σ of the months' published produced kilos. The footer's YTD cell. */
  totalKg: number;
  /**
   * Σ of the grade rows' kilos. **Kept separate from `totalKg` on purpose**:
   * they are equal by proof, and the room prints the gap between them when it
   * is not zero rather than assuming it never will be. A tie that is asserted
   * and never checked is not a tie.
   */
  totalGradeKg: number;
  /** The biggest grade of the year, and its share. The headline read. */
  topGrade: string | null;
  topGradeSharePct: number | null;
  /** How many distinct grades the year ran. */
  gradeCount: number;
  /**
   * R5 — a batch selection narrowed the columns, so every figure here is over
   * THOSE months and the room must say so rather than calling it the year.
   */
  filtered: boolean;
}

function sum(values: readonly (number | null)[]): number {
  let total = 0;
  for (const v of values) if (v != null) total += v;
  return total;
}

/**
 * Build one year of the grade mix.
 *
 * Columns come from the months that actually REPORTED production, ascending.
 * A month the plant did not report has no grades to show, and twelve columns
 * with four blanks in them would say a year that has not reached December yet
 * had made nothing in it — the same reasoning the supplier room's columns use.
 *
 * `months` is the page's own `AnalyticsMonth` series, already loaded: it is
 * where `producedKg` comes from, so no second read and no second definition.
 */
export function buildGradeYear(
  rows: readonly ProductionGradeMonth[],
  months: readonly AnalyticsMonth[],
  year: number,
  /**
   * OWNER FEEDBACK R5 — the `YYYY-MM` months the selected production batches
   * ran in, or `null` for no filter at all.
   *
   * It narrows the COLUMNS, and everything downstream re-folds over what is
   * left through the arithmetic that was already here: the year column is
   * still a plain sum of the columns, the year share is still Σ kilos ÷ Σ
   * kilos, and `totalKg` is still the published `producedKg` of the months
   * shown rather than a sum of the grade rows. So a filtered grade mix is a
   * mix of those months rather than the year with columns painted out — the
   * same rule the matrix's own column checklist obeys.
   *
   * `null` and "every month" are deliberately different values: `null` means
   * the reader has not filtered anything, which is what lets the room say
   * "the year" instead of "the months you chose".
   */
  monthFilter?: ReadonlySet<string> | null,
): GradeYear {
  const inYear = rows.filter(
    (r) =>
      r.year === year &&
      (r.kg ?? 0) > 0 &&
      (!monthFilter || monthFilter.has(r.monthStart.slice(0, 7))),
  );

  const byMonth = new Map<string, ProductionGradeMonth[]>();
  for (const r of inYear) {
    const list = byMonth.get(r.monthStart);
    if (list) list.push(r);
    else byMonth.set(r.monthStart, [r]);
  }

  // The published monthly figure, keyed for the footer. Read from the SAME
  // series the Production output row reads.
  const producedByMonth = new Map<string, number | null>();
  for (const m of months) {
    if (m.year === year) producedByMonth.set(m.monthStart, m.producedKg);
  }

  const columns: GradeMonthColumn[] = [...byMonth.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([monthStart, list]) => {
      const monthNo = list[0].month;
      return {
        monthStart,
        month: monthNo,
        label: MONTH_SHORT[monthNo - 1] ?? monthStart.slice(5, 7),
        fullLabel: `${MONTH_LONG[monthNo - 1] ?? monthStart.slice(0, 7)} ${year}`,
        producedKg: producedByMonth.get(monthStart) ?? null,
        gradeCount: list.length,
      };
    });

  const monthIndex = new Map(columns.map((m, i) => [m.monthStart, i] as const));

  const byGrade = new Map<string, ProductionGradeMonth[]>();
  for (const r of inYear) {
    const list = byGrade.get(r.grade);
    if (list) list.push(r);
    else byGrade.set(r.grade, [r]);
  }

  const totalKg = sum(columns.map((m) => m.producedKg));

  const built: GradeRow[] = [...byGrade.entries()].map(([grade, list]) => {
    const cells: (GradeCell | null)[] = Array(columns.length).fill(null);
    for (const r of list) {
      const i = monthIndex.get(r.monthStart);
      if (i == null) continue;
      cells[i] = {
        monthStart: r.monthStart,
        fullLabel: `${MONTH_SHORT[r.month - 1] ?? r.monthStart.slice(5, 7)} ${r.year}`,
        kg: r.kg,
        // SQL's own share. Never recomputed here — its denominator is the
        // monthly view's published total, joined rather than re-added.
        sharePct: r.shareOfMonthPct,
        runCount: r.runCount,
        sacks: r.sacks,
      };
    }
    const kg = sum(list.map((r) => r.kg));
    // NULL, never 0, when not one run of this grade recorded a bag count.
    const sacksParts = list.map((r) => r.sacks).filter((v) => v != null);
    return {
      grade,
      cells,
      kg,
      sharePct: totalKg > 0 ? (100 * kg) / totalKg : null,
      runCount: sum(list.map((r) => r.runCount)),
      activeMonths: list.length,
      rank: 0,
      sacks: sacksParts.length > 0 ? sum(sacksParts) : null,
    };
  });

  built.sort((a, b) => b.kg - a.kg || a.grade.localeCompare(b.grade));
  built.forEach((r, i) => {
    r.rank = i + 1;
  });

  return {
    year,
    months: columns,
    rows: built,
    totalKg,
    totalGradeKg: built.reduce((acc, r) => acc + r.kg, 0),
    topGrade: built[0]?.grade ?? null,
    topGradeSharePct: built[0]?.sharePct ?? null,
    gradeCount: built.length,
    filtered: monthFilter != null,
  };
}

/**
 * ONE grade's figures over an arbitrary subset of its year's months (R5).
 *
 * The grade rows became expandable in R5 — Renzo: *"grade rows open charts /
 * breakdown like everything else"* — and an expand carries a month checklist,
 * so its stats have to re-fold. Every rule the year column obeys is obeyed
 * here because it is the same arithmetic over a shorter list: kilos are a
 * plain sum, and **the SHARE's denominator narrows with the selection** (the
 * months' own published `producedKg`, never a sum of the grade rows), so a
 * four-month share is a share of those four months rather than of the year.
 *
 * Nothing is averaged: there is no figure on a grade row that an average of
 * monthly percentages could produce.
 */
export interface GradeFold {
  kg: number;
  /** PERCENT 0-100 — Σ this grade ÷ Σ everything made in the months shown. */
  sharePct: number | null;
  /** Months in the selection this grade was actually made in. */
  activeMonths: number;
  /** Months in the selection, whether or not this grade ran. */
  monthCount: number;
  runCount: number;
  /** NULL (never 0) when no run in the selection recorded a bag count. */
  sacks: number | null;
  /** The grade's best month in the selection, by kilos. */
  bestMonth: GradeCell | null;
}

export function foldGradeSelection(
  row: GradeRow,
  months: readonly GradeMonthColumn[],
  /** The switched-OFF `monthStart` values. Empty = every month. */
  hiddenMonths: ReadonlySet<string>,
): GradeFold {
  let kg = 0;
  let denominator = 0;
  let activeMonths = 0;
  let monthCount = 0;
  let runCount = 0;
  let sacks = 0;
  let hadSacks = false;
  let bestMonth: GradeCell | null = null;

  months.forEach((m, i) => {
    if (hiddenMonths.has(m.monthStart)) return;
    monthCount += 1;
    if (m.producedKg != null) denominator += m.producedKg;
    const cell = row.cells[i];
    if (!cell || cell.kg == null) return;
    activeMonths += 1;
    kg += cell.kg;
    runCount += cell.runCount ?? 0;
    if (cell.sacks != null) {
      hadSacks = true;
      sacks += cell.sacks;
    }
    if (!bestMonth || cell.kg > (bestMonth.kg ?? 0)) bestMonth = cell;
  });

  return {
    kg,
    sharePct: denominator > 0 ? (100 * kg) / denominator : null,
    activeMonths,
    monthCount,
    runCount,
    sacks: hadSacks ? sacks : null,
    bestMonth,
  };
}

// ---------------------------------------------------------------------
// The dictionary — same shape and same discipline as `METRICS[].dictionary`
// ---------------------------------------------------------------------

export type ProductionFigureKey = "grade_mix" | "reported_days";

export interface ProductionFigure {
  label: string;
  sublabel: string;
  dictionary: MetricDictionaryEntry;
}

/**
 * Derived from `view_analytics_production_grade_monthly`'s own COMMENT in
 * migration `20260901142417_analytics_phase4_production_layer.sql`, exactly as
 * the P1/P2/P3 entries were derived from theirs.
 *
 * **₱-FREE, and here that is free rather than a discipline** — there is no
 * peso anywhere in the production layer to leak.
 */
export const PRODUCTION_DICTIONARY: Record<
  ProductionFigureKey,
  ProductionFigure
> = {
  grade_mix: {
    label: "Grade mix",
    sublabel: "tonnes made, by product",
    dictionary: {
      definition: "What the plant made, split by product.",
      basis:
        "Each grade's kilos come from the same RC Movement view the monthly total is built from — the same arithmetic, split, not a second count. The share under a cell is that grade over everything made that month.",
      exclusions:
        "Nothing. Every production entry belongs to exactly one grade, so no tonnage falls between the rows.",
      rollup:
        "The year column is a plain sum of the months; the year share is the year's kilos over the year's produced kilos, never the average of monthly percentages.",
      source: "view_analytics_production_grade_monthly.kg",
      caveat:
        "The Σ made footer is the matrix's own Production output figure, not a sum of the rows above it — and the two are checked against each other on every render, not assumed equal.",
    },
  },
  reported_days: {
    label: "Reported days",
    sublabel: "production's own denominator",
    dictionary: {
      definition:
        "How many days production actually reported in a month — the denominator behind every per-day figure here.",
      basis:
        "Days carrying at least one production entry. The same rule the home dashboard's stream freshness uses, so there is one definition and not two.",
      exclusions:
        "A day the yard took charcoal in but the plant did not run is not a reported production day, so it cannot dilute an output-per-day figure.",
      rollup: "Quarters and years are plain sums of their months.",
      source: "view_analytics_production_monthly.reported_days",
      caveat:
        "Deliberately NOT the days the whole SITE was busy — the yard can take deliveries on a day the plant is idle. That is also why the per-working-day toggle leaves this band alone.",
    },
  },
};
