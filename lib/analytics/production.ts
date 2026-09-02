// =====================================================================
// ICTC Owner Analytics — THE GRADE MIX's pure fold
// =====================================================================
// One pass over `view_analytics_production_grade_by_batch`'s rows turns them
// into the grade × CAMPAIGN mini-matrix: what the plant made, split by product.
//
// ── OWNER FEEDBACK R6 (2026-09-02): THE COLUMNS ARE CAMPAIGNS ─────────
// This fold was grade × calendar MONTH until R6 moved the whole Production
// band onto the production-batch clock. The arithmetic is unchanged line for
// line; what changed is the COLUMN, and with it the vocabulary — `columns`
// rather than `months`, a `columnNoun` the components print, and a `scopeLabel`
// that says what the trailing total is over. The month version is retired
// rather than kept beside it: two folds of the same tonnage under two clocks is
// exactly the second definition this file exists to refuse.
//
// Pure and client-safe — no React, no Supabase, no `server-only`. Same
// discipline as `matrix.ts` and `supplier.ts`: the SQL layer owns every
// DEFINITION, this module only folds published figures across columns.
//
// ── THE TIE THAT MAKES THIS BLOCK WORTH TRUSTING ──────────────────────
// The `Σ made` footer prints the **campaign's own published `producedKg`** —
// the very field the Production output row of the band reads — and NOT a sum of
// the grade rows above it. The two are equal by proof (Σ grade `kg` = the
// parent view's `produced_kg`, 0 mismatches across 10 of 10 campaigns, max gap
// 0.0 kg), so printing the published one means the grade mix and the band's row
// cannot drift apart even in principle. It is the same trick the supplier
// room's `Σ market` row uses, for the same reason — and the tie is still
// CHECKED on every render rather than assumed.
//
// ── AND ONE RULE ABOUT SHARES ─────────────────────────────────────────
// `shareOfCampaignPct` is SQL's own, and its denominator is JOINED from
// `view_analytics_production_by_batch` rather than re-summed there — so a grade
// share and the campaign headline are the same arithmetic. Nothing here
// recomputes a per-campaign share. The TOTAL share IS computed here, and it is
// Σ kilos ÷ Σ kilos (a weighted figure by construction), never the mean of a
// handful of percentages.
// =====================================================================

import type { MetricDictionaryEntry } from "./metrics";
import type { ProductionBatchRow, ProductionGradeBatch } from "./types";

/** One (grade × campaign) cell of the mini-matrix. */
export interface GradeCell {
  /** The column's identity — a `campaignLabel`. */
  key: string;
  /** `AUGUST 2026` — the hover's column name. */
  fullLabel: string;
  /** Kilos of this grade made in that campaign. `null` = the grade was not run. */
  kg: number | null;
  /** PERCENT 0-100, SQL's own. `null` when `kg` is. */
  sharePct: number | null;
  runCount: number | null;
  /** NULL (never 0) wherever bags were not being counted. */
  sacks: number | null;
}

/** One grade across the shown campaigns — the matrix row plus its total column. */
export interface GradeRow {
  grade: string;
  /** One slot per displayed column. `null` = this grade was not made then. */
  cells: readonly (GradeCell | null)[];
  /** Total kilos — a plain sum, the only rollup a volume allows. */
  kg: number;
  /** Share of everything made in the shown campaigns. Weighted (Σ ÷ Σ). */
  sharePct: number | null;
  runCount: number;
  /** Campaigns in which this grade was actually made. */
  activeColumns: number;
  /** 1-based rank by kilos. */
  rank: number;
  /** NULL (never 0) when no run of this grade recorded a bag count. */
  sacks: number | null;
}

/** One column of the mini-matrix — a production campaign. */
export interface GradeColumn {
  /** `AUGUST 2026` — the identity, and the `?bhide=` checklist's key. */
  key: string;
  /** `AUG 2026` — the header, exactly as the panel above prints it. */
  label: string;
  /** `AUGUST 2026` */
  fullLabel: string;
  /**
   * The campaign's produced kilos as **the band publishes them** — literally
   * the field the Production output row reads. The footer prints THIS, never a
   * sum of the column. See the file header.
   */
  producedKg: number | null;
  /** How many grades were made in that campaign. 1 = a single-product batch. */
  gradeCount: number;
}

/** Everything the grade mini-matrix renders. */
export interface GradeSet {
  /** Only campaigns that actually reported production — no empty columns. */
  columns: readonly GradeColumn[];
  /** Ranked by kilos, DESC. */
  rows: readonly GradeRow[];
  /** Σ of the campaigns' published produced kilos. The footer's total cell. */
  totalKg: number;
  /**
   * Σ of the grade rows' kilos. **Kept separate from `totalKg` on purpose**:
   * they are equal by proof, and the table prints the gap between them when it
   * is not zero rather than assuming it never will be. A tie that is asserted
   * and never checked is not a tie.
   */
  totalGradeKg: number;
  /** The biggest grade, and its share. The headline read. */
  topGrade: string | null;
  topGradeSharePct: number | null;
  /** How many distinct grades were run. */
  gradeCount: number;
  /** A batch selection narrowed the columns, so nothing here is "all of it". */
  filtered: boolean;
  /** What the trailing total column is headed — `All batches` / `Selected`. */
  totalLabel: string;
}

function sum(values: readonly (number | null)[]): number {
  let total = 0;
  for (const v of values) if (v != null) total += v;
  return total;
}

/**
 * Build the grade mix over a set of campaigns.
 *
 * Columns come from the campaigns that actually REPORTED production, in the
 * order `batches` arrives in (the adapter already sorts them chronologically by
 * the month each batch is NAMED for — the same order the panel's columns and
 * its checklist are in). A campaign the plant did not report has no grades to
 * show, and an empty column would say a batch made nothing rather than that
 * nobody was reporting.
 *
 * `batches` is the band's own `ProductionBatchRow` series, already loaded: it
 * is where `producedKg` comes from, so no second read and no second definition.
 *
 * `hidden` is the page's `?bhide=` set — the SAME keys the campaign panel uses,
 * so one control narrows the panel, the band and this table with no mapping
 * step. R5's month-mapping is retired: a column IS a batch now.
 */
export function buildGradeSet(
  rows: readonly ProductionGradeBatch[],
  batches: readonly ProductionBatchRow[],
  hidden: ReadonlySet<string>,
): GradeSet {
  const filtered = hidden.size > 0;
  const shownBatches = batches.filter((b) => !hidden.has(b.campaignLabel));
  const shownKeys = new Set(shownBatches.map((b) => b.campaignLabel));

  const inScope = rows.filter(
    (r) => (r.kg ?? 0) > 0 && shownKeys.has(r.campaignLabel),
  );

  const byColumn = new Map<string, ProductionGradeBatch[]>();
  for (const r of inScope) {
    const list = byColumn.get(r.campaignLabel);
    if (list) list.push(r);
    else byColumn.set(r.campaignLabel, [r]);
  }

  const columns: GradeColumn[] = shownBatches
    .filter((b) => byColumn.has(b.campaignLabel))
    .map((b) => ({
      key: b.campaignLabel,
      label: `${b.productionBatch.slice(0, 3)} ${b.campaignYear}`,
      fullLabel: b.campaignLabel,
      // The published figure, read from the SAME series the Production output
      // row reads.
      producedKg: b.producedKg,
      gradeCount: byColumn.get(b.campaignLabel)?.length ?? 0,
    }));

  const columnIndex = new Map(columns.map((c, i) => [c.key, i] as const));

  const byGrade = new Map<string, ProductionGradeBatch[]>();
  for (const r of inScope) {
    const list = byGrade.get(r.grade);
    if (list) list.push(r);
    else byGrade.set(r.grade, [r]);
  }

  const totalKg = sum(columns.map((c) => c.producedKg));

  const built: GradeRow[] = [...byGrade.entries()].map(([grade, list]) => {
    const cells: (GradeCell | null)[] = Array(columns.length).fill(null);
    for (const r of list) {
      const i = columnIndex.get(r.campaignLabel);
      if (i == null) continue;
      cells[i] = {
        key: r.campaignLabel,
        fullLabel: r.campaignLabel,
        kg: r.kg,
        // SQL's own share. Never recomputed here — its denominator is the
        // campaign view's published total, joined rather than re-added.
        sharePct: r.shareOfCampaignPct,
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
      activeColumns: list.length,
      rank: 0,
      sacks: sacksParts.length > 0 ? sum(sacksParts) : null,
    };
  });

  built.sort((a, b) => b.kg - a.kg || a.grade.localeCompare(b.grade));
  built.forEach((r, i) => {
    r.rank = i + 1;
  });

  return {
    columns,
    rows: built,
    totalKg,
    totalGradeKg: built.reduce((acc, r) => acc + r.kg, 0),
    topGrade: built[0]?.grade ?? null,
    topGradeSharePct: built[0]?.sharePct ?? null,
    gradeCount: built.length,
    filtered,
    totalLabel: filtered ? "Selected" : "All batches",
  };
}

/**
 * ONE grade's figures over an arbitrary subset of the shown campaigns.
 *
 * The grade rows became expandable in R5 — Renzo: *"grade rows open charts /
 * breakdown like everything else"* — and an expand carries its own checklist,
 * so its stats have to re-fold. Every rule the total column obeys is obeyed
 * here because it is the same arithmetic over a shorter list: kilos are a plain
 * sum, and **the SHARE's denominator narrows with the selection** (the
 * campaigns' own published `producedKg`, never a sum of the grade rows), so a
 * four-batch share is a share of those four batches.
 *
 * Nothing is averaged: there is no figure on a grade row that an average of
 * percentages could produce.
 */
export interface GradeFold {
  kg: number;
  /** PERCENT 0-100 — Σ this grade ÷ Σ everything made in the columns shown. */
  sharePct: number | null;
  /** Columns in the selection this grade was actually made in. */
  activeColumns: number;
  /** Columns in the selection, whether or not this grade ran. */
  columnCount: number;
  runCount: number;
  /** NULL (never 0) when no run in the selection recorded a bag count. */
  sacks: number | null;
  /** The grade's best campaign in the selection, by kilos. */
  bestColumn: GradeCell | null;
}

export function foldGradeSelection(
  row: GradeRow,
  columns: readonly GradeColumn[],
  /** The switched-OFF column keys. Empty = every column. */
  hiddenColumns: ReadonlySet<string>,
): GradeFold {
  let kg = 0;
  let denominator = 0;
  let activeColumns = 0;
  let columnCount = 0;
  let runCount = 0;
  let sacks = 0;
  let hadSacks = false;
  let bestColumn: GradeCell | null = null;

  columns.forEach((c, i) => {
    if (hiddenColumns.has(c.key)) return;
    columnCount += 1;
    if (c.producedKg != null) denominator += c.producedKg;
    const cell = row.cells[i];
    if (!cell || cell.kg == null) return;
    activeColumns += 1;
    kg += cell.kg;
    runCount += cell.runCount ?? 0;
    if (cell.sacks != null) {
      hadSacks = true;
      sacks += cell.sacks;
    }
    if (!bestColumn || cell.kg > (bestColumn.kg ?? 0)) bestColumn = cell;
  });

  return {
    kg,
    sharePct: denominator > 0 ? (100 * kg) / denominator : null,
    activeColumns,
    columnCount,
    runCount,
    sacks: hadSacks ? sacks : null,
    bestColumn,
  };
}

// ---------------------------------------------------------------------
// The dictionary — same shape and same discipline as `METRICS[].dictionary`
// ---------------------------------------------------------------------

export type ProductionFigureKey = "grade_mix" | "reported_days" | "batch_clock";

export interface ProductionFigure {
  label: string;
  sublabel: string;
  dictionary: MetricDictionaryEntry;
}

/**
 * Derived from `view_analytics_production_by_batch`'s and
 * `view_analytics_production_grade_by_batch`'s own COMMENTs in migration
 * `20260902083625_analytics_production_by_batch_clock.sql`, exactly as the
 * P1/P2/P3/P4 entries were derived from theirs.
 *
 * **₱-FREE, and here that is free rather than a discipline** — there is no peso
 * anywhere in the production layer to leak.
 */
export const PRODUCTION_DICTIONARY: Record<
  ProductionFigureKey,
  ProductionFigure
> = {
  grade_mix: {
    label: "Grade mix",
    sublabel: "tonnes made, by product",
    dictionary: {
      definition: "What each production batch made, split by product.",
      basis:
        "Each grade's kilos are the same arithmetic the batch's own total is — a sum over the shifts carrying that batch — split by grade rather than counted again. The share under a cell is that grade over everything the batch produced.",
      exclusions:
        "Nothing. Every production entry belongs to exactly one grade, so no tonnage falls between the rows.",
      rollup:
        "The total column is a plain sum of the batches shown; its share is those kilos over those batches' produced kilos, never the average of a handful of percentages.",
      source: "view_analytics_production_grade_by_batch.kg",
      caveat:
        "The Σ made footer is the band's own Production output figure, not a sum of the rows above it — and the two are checked against each other on every render, not assumed equal.",
    },
  },
  reported_days: {
    label: "Reported days",
    sublabel: "production's own denominator",
    dictionary: {
      definition:
        "How many days a production batch actually reported — the denominator behind every per-day figure here.",
      basis:
        "Days carrying at least one production entry. The same rule the home dashboard's stream freshness uses, so there is one definition and not two.",
      exclusions:
        "A day the yard took charcoal in but the plant did not run is not a reported production day, so it cannot dilute an output-per-day figure.",
      rollup: "A selection of batches is the plain sum of those batches.",
      source: "view_analytics_production_by_batch.reported_days",
      caveat:
        "A CHANGEOVER DAY BELONGS TO TWO BATCHES and both really did run it, so these counts add to slightly more than the calendar: 221 batch-days across 214 dates, the difference being exactly the seven changeover days. That is correct, not double counting.",
    },
  },
  batch_clock: {
    label: "The batch clock",
    sublabel: "why these columns are batches",
    dictionary: {
      definition:
        "This whole band reads production batches, not calendar months — the unit the plant actually runs.",
      basis:
        "Every shift, run, downtime record and bag count in the database already carries the batch it belongs to, taken from the daily report's own start and end markers, so grouping them by batch is exact rather than estimated. Yield and charcoal fed are read straight from the same campaign view the panel above uses.",
      exclusions:
        "Nothing is left out, but ONE figure is MAPPED rather than tagged: electricity is metered by date and carries no batch, so a day's power goes to the batch that had most recently started — on a changeover day, to the incoming batch.",
      rollup:
        "There is no quarter or year here. A selection of batches folds by each row's own rule, exactly as a selection of months does on the band above.",
      source: "view_analytics_production_by_batch",
      caveat:
        "The meters were running for 192 days before the first batch was reported, and that 561,930 kWh belongs to no batch on this clock. It is not lost — it is readable by month in the calendar production view, and the totals reconcile exactly. A batch is not a month: AUGUST closed and SEPTEMBER opened on 29 August 2026.",
    },
  },
};
