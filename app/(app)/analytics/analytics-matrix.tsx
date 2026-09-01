"use client";

// ─────────────────────────────────────────────────────────────────────────────
// THE MONTHLY MATRIX — KPI rows × period columns.
//
// ── WHY THIS IS A BESPOKE TABLE AND NOT THE BLACKWOOD TABLE ──────────────────
//
// The platform grid is the right answer for a LEDGER: rows are records, columns
// are fields, and the machinery it brings (cell selection, inline editing,
// paste, keyboard nav, the pinned per-column footer) is machinery a ledger
// wants. This surface inverts that. Its rows are METRICS and its columns are
// PERIODS, which breaks three of the grid's load-bearing assumptions at once:
//
//   1. **The formatter belongs to the ROW, not the column.** `ColumnSpec.format`
//      is per column by construction; here `Mar` must print ₱48.26 on one row,
//      1,864.1 t on the next and 14 on the next. Every column would have to
//      switch on the row, which is the column spec turned inside out.
//   2. **A cell is three things, none of them editable** — a value, a
//      period-over-period delta and a year-ago chip. Nothing on this page is
//      ever written, so the edit journal, the paste sink and the caret model
//      are all cost with no benefit.
//   3. **The row expand is the point of the page.** A metric's chart is the
//      drill-down, and the grid reaches a non-addressable row only through
//      `renderChromeRow`, which returns cells INSIDE a `table-fixed` row — a
//      chart in there would be as wide as the whole scrolling table.
//
// Twelve rows also means virtualisation buys nothing. So: a plain table that
// obeys the same two rules the grid obeys.
//
//   • **"Never crush, always scroll"** — `table-fixed`, `width: max-content`, a
//     full `<colgroup>` of explicit pixel widths, wrapped in `overflow-x-auto`.
//     There is deliberately no flexible column; the flexible one is the one
//     that silently crushes.
//   • **Frozen panes are OPAQUE** — the KPI-name column is sticky-left
//     (`.frozen-col`, z10) over scrolling cells, so it paints a SOLID token and
//     repaints the hover tint solidly too; `.frozen-edge` kills the seam. The
//     header row is deliberately NOT sticky-top: the table is twelve rows and
//     never scrolls vertically inside its own box, so a sticky header would be
//     chrome with nothing to pin against.
//
// ── AND ONE THING THAT IS DELIBERATELY NOT HERE: COLOUR SEMANTICS ────────────
// The plan withholds threshold colouring until Renzo states real targets. So a
// delta is a DIRECTION GLYPH and a muted number — never red or green. A rising
// purchase price is not "up" in the cheerful sense, and inventing that
// judgement is exactly the invented-breach-rule the plan refuses.
// ─────────────────────────────────────────────────────────────────────────────

import * as React from "react";
import { ChevronRight, Lock } from "lucide-react";
import { cn } from "@/lib/utils";
import type { Matrix, MatrixCell, MatrixRow } from "@/lib/analytics/matrix";
import { DELTA_LABEL, groupBySection } from "@/lib/analytics/matrix";
import type {
  MetricKey,
  MetricSection,
  MetricSpec,
} from "@/lib/analytics/metrics";
import {
  BLANK_TITLE,
  directionGlyph,
  estimateTitle,
  fmtChange,
  fmtCompact,
  fmtMetricValue,
} from "@/lib/analytics/format";
import { MetricInfo, dictionaryTitle } from "./metric-info";

// Explicit pixel widths — the sum below IS the table's minWidth.
const W_NAME = 208;
const W_PERIOD = 100;
const W_TOTAL = 112;

/**
 * Big magnitudes are printed COMPACT in a 100px cell and exactly in the hover.
 * Pesos qualify, and so does kWh: a full year of metering runs to seven
 * figures, and 2026-03 alone reads 696,924 because of the mis-keyed reading
 * this page exists to flag.
 */
function isCompactUnit(spec: MetricSpec): boolean {
  return spec.unit === "php" || spec.unit === "kwh";
}

function exactText(spec: MetricSpec, value: number): string {
  const n = value.toLocaleString("en-US", {
    minimumFractionDigits: spec.decimals,
    maximumFractionDigits: spec.decimals,
  });
  if (spec.unit === "php") return `₱${n}`;
  if (spec.unit === "php_per_kg") return `₱${n} / kg`;
  if (spec.unit === "tonnes") return `${n} t`;
  if (spec.unit === "days") return `${n} days`;
  if (spec.unit === "pct") return `${n}%`;
  if (spec.unit === "hours") return `${n} hours`;
  if (spec.unit === "kwh") return `${n} kWh`;
  if (spec.unit === "kwh_per_kg") return `${n} kWh / kg`;
  return n;
}

/** The change pair under a value. Direction only — no good/bad colour. */
function ChangeLine({
  cell,
  spec,
  deltaWord,
}: {
  cell: MatrixCell;
  spec: MetricSpec;
  deltaWord: string;
}) {
  return (
    <>
      <div className="mt-0.5 h-3 truncate text-right font-mono text-[10px] leading-3 text-muted-foreground tabular-nums">
        {cell.delta ? (
          <span title={`${deltaWord} change`}>
            <span aria-hidden className="mr-0.5 text-[8px]">
              {directionGlyph(cell.delta.value)}
            </span>
            {fmtChange(cell.delta, spec)}
          </span>
        ) : (
          <span aria-hidden>&nbsp;</span>
        )}
      </div>
      <div className="mt-0.5 flex h-[13px] justify-end">
        {cell.yoy ? (
          <span
            title="Against the same period one year earlier"
            className="inline-flex items-center rounded border border-border/70 px-1 font-mono text-[9.5px] leading-[11px] text-muted-foreground tabular-nums"
          >
            <span className="mr-0.5 opacity-70">Y</span>
            {fmtChange(cell.yoy, spec)}
          </span>
        ) : null}
      </div>
    </>
  );
}

/**
 * The marks a figure can carry, all meaning "read the hover before you quote
 * this". Deliberately glyphs and not colour: the page has no threshold
 * semantics anywhere, and an amber cell would read as a judgement.
 *
 *   `·` the period summed over a hole — a FLOOR, not a total;
 *   `~` the figure is the coverage-adjusted ESTIMATE, because some of the
 *       kilos underneath it were fed out of piles with no delivery record;
 *   the ROW'S OWN mark (P4) — a `⚠` for a mis-keyed meter reading or a
 *       downtime duration that stopped being filled in, a `~` for a bag count
 *       that speaks for a fraction of its month. Its sentence comes from the
 *       registry rather than from here, because the three reasons are
 *       genuinely different and one shared sentence would be wrong on two of
 *       them.
 *
 * The ⚠ is the one mark that carries colour, and it is not a threshold: it
 * says a figure is known to rest on a broken or missing input, which is a
 * fact about the record rather than a judgement about the business.
 */
function CellMarks({
  cell,
  coveragePct,
}: {
  cell: MatrixCell;
  coveragePct: number | null;
}) {
  const ownMark = cell.annotation?.mark;
  if (!cell.holed && !cell.estimated && !ownMark) return null;
  return (
    <span className="flex shrink-0 items-baseline gap-px text-[10px] leading-none">
      {cell.estimated && (
        <span
          title={estimateTitle(coveragePct)}
          className="text-muted-foreground"
          aria-label="estimated"
        >
          ~
        </span>
      )}
      {ownMark && (
        <span
          title={cell.annotation?.title}
          aria-label="read the note on this figure"
          className={cn(
            ownMark === "⚠"
              ? "text-amber-600 dark:text-amber-400"
              : "text-muted-foreground",
          )}
        >
          {ownMark}
        </span>
      )}
      {cell.holed && (
        <span aria-hidden className="text-amber-600 dark:text-amber-400">
          ·
        </span>
      )}
    </span>
  );
}

function ValueCell({
  cell,
  spec,
  deltaWord,
  coveragePct,
  emphasis,
}: {
  cell: MatrixCell;
  spec: MetricSpec;
  deltaWord: string;
  /** Fed-price coverage for the period, for the `~` hover. Null when N/A. */
  coveragePct?: number | null;
  emphasis?: boolean;
}) {
  if (cell.value == null) {
    const reason = cell.blankReason ?? "no_data";
    const ann = cell.annotation;
    // A blank still carries the row's own sentence, and — where the data
    // layer publishes an honest estimate beside a suppressed measurement —
    // prints THAT rather than nothing. Withholding a number the page knows
    // is not caution, it is silence. It is labelled so it can never be read
    // as the row's own figure, and it is never a callout.
    const alt = ann?.alt ?? null;
    return (
      <td
        className={cn(
          "border-l px-2 py-1 align-top",
          emphasis && "bg-muted/40",
        )}
        // The row's OWN sentence REPLACES the generic one rather than
        // following it. "No records for this period" is simply false on a
        // power-intensity cell that is blank because the month's meter
        // reading is broken — the records exist, one of them is wrong — and
        // reading the two sentences in sequence contradicts the reader.
        // `restricted` is the exception and always wins: whether a ₱ crossed
        // the wire is never overridden by a display note.
        title={
          reason === "restricted"
            ? BLANK_TITLE.restricted
            : (ann?.title ?? BLANK_TITLE[reason])
        }
      >
        <div className="flex h-[17px] items-center justify-end gap-1 font-mono text-xs text-muted-foreground/60">
          {reason === "restricted" && <Lock className="size-2.5" aria-hidden />}
          {ann?.mark && (
            <span
              aria-hidden
              className="text-[10px] leading-none text-amber-600 dark:text-amber-400"
            >
              {ann.mark}
            </span>
          )}
          <span>{alt ? fmtMetricValue(spec, alt.value) : "—"}</span>
        </div>
        {alt && (
          <div className="mt-0.5 h-3 truncate text-right text-[9px] leading-3 text-muted-foreground">
            {alt.label}
          </div>
        )}
      </td>
    );
  }

  const shown = isCompactUnit(spec)
    ? fmtCompact(cell.value)
    : fmtMetricValue(spec, cell.value);

  const titleParts = [exactText(spec, cell.value)];
  if (cell.estimated) titleParts.push(estimateTitle(coveragePct ?? null));
  if (cell.annotation) titleParts.push(cell.annotation.title);
  if (cell.holed)
    titleParts.push(
      "Some months in this period recorded nothing, so this figure is a floor, not a total.",
    );
  if (cell.isPartial) titleParts.push("This period has not finished yet.");

  const marks = <CellMarks cell={cell} coveragePct={coveragePct ?? null} />;

  return (
    <td
      className={cn("border-l px-2 py-1 align-top", emphasis && "bg-muted/40")}
      title={titleParts.join(" · ")}
    >
      {/* Accounting format for ₱: glyph pinned left, number pinned right. */}
      {spec.unit === "php_per_kg" || spec.unit === "php" ? (
        <div className="flex h-[17px] items-baseline justify-between gap-1 font-mono text-xs tabular-nums">
          <span className="shrink-0 text-[10px] text-muted-foreground">₱</span>
          <span className="flex min-w-0 items-baseline gap-0.5">
            <span className="truncate font-medium">{shown}</span>
            {marks}
          </span>
        </div>
      ) : (
        <div className="flex h-[17px] items-baseline justify-end gap-1 font-mono text-xs tabular-nums">
          <span className="truncate font-medium">
            {shown}
            {spec.unit === "pct" && (
              <span className="ml-px text-[10px] text-muted-foreground">%</span>
            )}
          </span>
          {marks}
        </div>
      )}
      <ChangeLine cell={cell} spec={spec} deltaWord={deltaWord} />
    </td>
  );
}

export interface AnalyticsMatrixProps {
  matrix: Matrix;
  /** The expanded row, or null. */
  selected: MetricKey | null;
  onSelect(key: MetricKey | null): void;
  /** The working-day toggle is on — the affected rows say so in their label. */
  perWorkingDay: boolean;
  /**
   * Which bands this instance renders. Omitted = all of them.
   *
   * The page mounts this component TWICE — flow + money at the top, and the
   * production band down in its own section after the supplier room — because
   * the reading order is PERIOD → CAMPAIGN → SUPPLIER → PRODUCTION → PILE and
   * production belongs where the plant does, not where the yard does. It is
   * still ONE `buildMatrix` fold behind both, so the two tables and the
   * callout strip are the same numbers by construction.
   */
  sections?: readonly MetricSection[];
}

export function AnalyticsMatrix({
  matrix,
  selected,
  onSelect,
  perWorkingDay,
  sections: only,
}: AnalyticsMatrixProps) {
  const deltaWord = DELTA_LABEL[matrix.granularity];
  const minWidth =
    W_NAME + matrix.periods.length * W_PERIOD + W_TOTAL;

  const sections = React.useMemo(
    () => groupBySection(matrix.rows, only),
    [matrix.rows, only],
  );

  /**
   * Fed-price coverage per COLUMN, for the `~` hover only.
   *
   * Σ traceable ÷ Σ all over the column's months — the same Σnum ÷ Σden the
   * weighted rows use, over two columns the SQL layer publishes. It is
   * hover copy, never a figure the grid prints, and it is computed here
   * rather than in the fold because it belongs to a PERIOD rather than to
   * any one row.
   */
  const coverageByPeriod = React.useMemo(() => {
    const out = new Map<string, number | null>();
    let winTraceable = 0;
    let winAll = 0;
    for (const p of matrix.periods) {
      let traceable = 0;
      let all = 0;
      for (const m of p.months) {
        traceable += m.fedKgPriceTraceable ?? 0;
        all += (m.fedKgPriceTraceable ?? 0) + (m.fedKgPriceUntraceable ?? 0);
      }
      out.set(p.key, all > 0 ? (traceable / all) * 100 : null);
      winTraceable += traceable;
      winAll += all;
    }
    // The trailing summary column too — its `~` needs a hover that names a
    // real share rather than falling back to the generic sentence.
    if (matrix.rows[0]?.total) {
      out.set(
        matrix.rows[0].total.periodKey,
        winAll > 0 ? (winTraceable / winAll) * 100 : null,
      );
    }
    return out;
  }, [matrix.periods, matrix.rows]);

  if (matrix.periods.length === 0) {
    return (
      <div className="rounded-lg border bg-card px-4 py-10 text-center text-xs text-muted-foreground">
        No months recorded in this period.
      </div>
    );
  }

  return (
    <div className="overflow-x-auto rounded-lg border bg-card">
      <table
        className="table-fixed text-xs"
        style={{ width: "max-content", minWidth, borderCollapse: "separate", borderSpacing: 0 }}
      >
        <colgroup>
          <col style={{ width: W_NAME }} />
          {matrix.periods.map((p) => (
            <col key={p.key} style={{ width: W_PERIOD }} />
          ))}
          <col style={{ width: W_TOTAL }} />
        </colgroup>

        <thead>
          <tr className="h-8 border-b">
            {/* Sticky-left AND opaque — it overlaps scrolling cells. */}
            <th
              scope="col"
              className="frozen-col frozen-edge border-b bg-muted px-2 py-1 text-left text-[10.5px] font-medium uppercase tracking-wide text-muted-foreground"
              style={{ left: 0 }}
            >
              Metric
            </th>
            {matrix.periods.map((p) => (
              <th
                key={p.key}
                scope="col"
                title={p.fullLabel + (p.isPartial ? " · in progress" : "")}
                className={cn(
                  "border-b border-l bg-muted px-2 py-1 text-right text-[10.5px] font-medium uppercase tracking-wide text-muted-foreground",
                  p.isPartial && "text-foreground/70",
                )}
              >
                {p.label}
                {p.isPartial && (
                  <span aria-hidden className="ml-0.5 font-normal normal-case opacity-70">
                    *
                  </span>
                )}
              </th>
            ))}
            <th
              scope="col"
              title={matrix.totalFullLabel}
              className="border-b border-l bg-muted px-2 py-1 text-right text-[10.5px] font-semibold uppercase tracking-wide text-foreground/80"
            >
              {matrix.totalLabel}
            </th>
          </tr>
        </thead>

        <tbody>
          {sections.map((section) => (
            <React.Fragment key={section.key}>
              <SectionBand
                id={`band-${section.key}`}
                label={section.label}
                hint={section.hint}
                span={matrix.periods.length + 1}
              />
              {section.rows.map((row) => (
                <MatrixRowView
                  key={row.metric.key}
                  row={row}
                  deltaWord={deltaWord}
                  selected={selected === row.metric.key}
                  onSelect={onSelect}
                  perWorkingDay={perWorkingDay}
                  coverageByPeriod={coverageByPeriod}
                />
              ))}
            </React.Fragment>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * A thin band naming the group of rows beneath it. Twenty rows in one
 * undifferentiated stack is a wall; two named groups is a page.
 *
 * The label cell is `.frozen-col` like every other cell in that column, so
 * it stays put while the periods scroll — a band that scrolled away would
 * leave the rows under it unlabelled exactly when the reader is furthest
 * from the header.
 */
function SectionBand({
  id,
  label,
  hint,
  span,
}: {
  /** Anchor target for the in-page nav. `scroll-mt-*` clears the sticky bar. */
  id?: string;
  label: string;
  hint: string;
  span: number;
}) {
  return (
    <tr id={id} className="h-6 scroll-mt-24 border-b bg-muted/40">
      <th
        scope="colgroup"
        title={hint}
        className="frozen-col frozen-edge border-b bg-muted px-2 py-0.5 text-left text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground"
        style={{ left: 0 }}
      >
        {label}
      </th>
      <td colSpan={span} className="border-b border-l px-2 py-0.5">
        <span className="block truncate text-[10px] leading-4 text-muted-foreground/80">
          {hint}
        </span>
      </td>
    </tr>
  );
}

function MatrixRowView({
  row,
  deltaWord,
  selected,
  onSelect,
  perWorkingDay,
  coverageByPeriod,
}: {
  row: MatrixRow;
  deltaWord: string;
  selected: boolean;
  onSelect(key: MetricKey | null): void;
  perWorkingDay: boolean;
  coverageByPeriod: ReadonlyMap<string, number | null>;
}) {
  const spec = row.metric;
  const normalised = perWorkingDay && spec.perWorkingDay;

  return (
    <tr
      className={cn(
        "group h-[52px] border-b transition-all duration-150 last:border-0",
        selected ? "bg-muted/50" : "hover:bg-muted/30",
      )}
    >
      {/* The frozen cell repaints the row state with a SOLID token — an alpha
          here would let the scrolling cells bleed through it. */}
      <th
        scope="row"
        className={cn(
          "frozen-col frozen-edge border-b px-2 py-1 text-left align-top font-normal",
          selected
            ? "bg-accent"
            : "bg-card group-hover:bg-muted",
        )}
        style={{ left: 0 }}
      >
        <div className="flex items-start gap-1">
          <button
            type="button"
            onClick={() => onSelect(selected ? null : spec.key)}
            aria-expanded={selected}
            title={dictionaryTitle(spec)}
            className="flex min-w-0 flex-1 cursor-pointer items-start gap-1 rounded text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <ChevronRight
              aria-hidden
              className={cn(
                "mt-0.5 size-3 shrink-0 text-muted-foreground transition-transform duration-150",
                selected && "rotate-90 text-foreground",
              )}
            />
            <span className="min-w-0">
              <span className="block truncate text-xs font-medium leading-4">
                {spec.label}
              </span>
              <span className="block truncate text-[10px] leading-3 text-muted-foreground">
                {normalised ? `${spec.sublabel} / working day` : spec.sublabel}
              </span>
            </span>
          </button>
          <MetricInfo spec={spec} className="mt-0.5" />
        </div>
        {row.restricted && (
          <span className="mt-1 inline-flex items-center gap-1 rounded border border-border/70 px-1 text-[9.5px] leading-[13px] text-muted-foreground">
            <Lock className="size-2.5" aria-hidden />
            Restricted
          </span>
        )}
      </th>

      {row.cells.map((cell) => (
        <ValueCell
          key={cell.periodKey}
          cell={cell}
          spec={spec}
          deltaWord={deltaWord}
          coveragePct={coverageByPeriod.get(cell.periodKey) ?? null}
        />
      ))}

      {row.total ? (
        <ValueCell
          cell={row.total}
          spec={spec}
          deltaWord={deltaWord}
          coveragePct={coverageByPeriod.get(row.total.periodKey) ?? null}
          emphasis
        />
      ) : (
        <td className="border-l bg-muted/40 px-2 py-1" />
      )}
    </tr>
  );
}
