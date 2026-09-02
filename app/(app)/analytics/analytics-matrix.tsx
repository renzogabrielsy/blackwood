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
// PERIODS, which breaks two of the grid's load-bearing assumptions at once:
//
//   1. **The formatter belongs to the ROW, not the column.** `ColumnSpec.format`
//      is per column by construction; here `Mar` must print ₱48.26 on one row,
//      1,864.1 t on the next and 14 on the next. Every column would have to
//      switch on the row, which is the column spec turned inside out.
//   2. **A cell is three things, none of them editable** — a value, a
//      period-over-period delta and a comparison chip. Nothing on this page is
//      ever written, so the edit journal, the paste sink and the caret model
//      are all cost with no benefit.
//
// Sixteen rows also means virtualisation buys nothing. So: a plain table that
// obeys the same two rules the grid obeys.
//
//   • **"Never crush, always scroll"** — `table-fixed`, `width: max-content`, a
//     full `<colgroup>` of explicit pixel widths, wrapped in `overflow-x-auto`.
//     There is deliberately no flexible column; the flexible one is the one
//     that silently crushes.
//   • **Frozen panes are OPAQUE** — the KPI-name column is sticky-left
//     (`.frozen-col`, z10) over scrolling cells, so it paints a SOLID token and
//     repaints the hover tint solidly too; `.frozen-edge` kills the seam. The
//     header row is deliberately NOT sticky-top: the table never scrolls
//     vertically inside its own box, so a sticky header would be chrome with
//     nothing to pin against.
//
// ── OWNER FEEDBACK ROUND 1 (2026-09-01) — THREE CHANGES HERE ─────────────────
//
// **1. The row expand now opens IN PLACE.** Renzo: "such a long scroll." It
// used to render below the whole table, which was a layout decision with a real
// reason — a `colSpan` panel inside an `overflow-x-auto` table is as wide as the
// scrolling table (up to ~1,500 px) and scrolls sideways with the columns. The
// fix is not to give up the colSpan, it is to make the panel INSIDE it
// `position: sticky; left: 0` at the SCROLLER's own width: the row spans every
// column so it sits exactly beneath the row that was clicked, and the panel
// inside it stays pinned to the visible frame however far the periods are
// scrolled. The width is measured, never assumed, and is clamped to the table's
// own width so a narrow table cannot be made to overflow by its own expand.
//
// **2. Everything moved up a type scale.** "The numbers look so tiny." Cell
// values went 12 → 14 px, row labels 12 → 13 px, and every explicit width was
// re-measured against the new metrics rather than left to clip: 208 → 232 (name),
// 100 → 116 (period), 112 → 128 (summary).
//
// **3. Colour, and what KIND of colour.** Each band wears its section accent as
// a left rule, and a change carries a green/red DIRECTION tint — the same
// convention the Home Digest uses for a signed number. Neither is a threshold:
// the accent says where you are and the tint says which way a number moved.
// There is still no cell anywhere on this page that turns amber because a value
// is high, and a rising purchase price is still not "up" in the cheerful sense —
// the tint follows the arithmetic sign and stops there.
// ─────────────────────────────────────────────────────────────────────────────

import * as React from "react";
import { ChevronRight, Lock } from "lucide-react";
import { cn } from "@/lib/utils";
import type {
  Change,
  ComparisonMode,
  Matrix,
  MatrixCell,
  MatrixRow,
} from "@/lib/analytics/matrix";
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
//
// RE-MEASURED for the R1 type bump. The frozen name column carries, left to
// right: 12 px chevron + 4 gap + the label at 13 px + 4 gap + a 16 px info
// button, inside 8 px padding either side. The longest label on the board is
// "Output per reported day" (~150 px at 13 px medium), so 232 leaves headroom
// and nothing truncates. A period cell prints at most "1,864.1" plus two marks
// at 14 px mono (~74 px) inside 16 px of padding — 116 fits with room, and the
// summary column is wider because it also carries "All time".
//
// OWNER FEEDBACK R3 (2026-09-02) — these are now CSS VARIABLES, not numbers.
// The big-screen scale bumps the type ~1.19x above 1920 px, and a width left
// behind would clip a header — exactly the failure R1 re-measured every width
// to avoid. Declaring both in `globals.css` means the two can only move
// together. Big values: 232 -> 276, 116 -> 138, 128 -> 152.
const W_NAME = "var(--an-w-name)";
const W_PERIOD = "var(--an-w-period)";
const W_TOTAL = "var(--an-w-total)";

/**
 * Big magnitudes are printed COMPACT in a period cell and exactly in the hover.
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

/**
 * The DIRECTION tint. Green up, red down, muted flat — the same convention the
 * digest's signed numbers already use.
 *
 * This is arithmetic, not judgement: it says which way the number moved and
 * nothing about whether that is good. The page still has no threshold anywhere.
 */
function directionCls(value: number): string {
  if (value > 0) return "text-emerald-600 dark:text-emerald-400";
  if (value < 0) return "text-red-600 dark:text-red-400";
  return "text-muted-foreground";
}

/** The change pair under a value: the move, then whichever chip is selected. */
function ChangeLine({
  cell,
  spec,
  deltaWord,
  comparison,
}: {
  cell: MatrixCell;
  spec: MetricSpec;
  deltaWord: string;
  comparison: ComparisonMode;
}) {
  // OWNER FEEDBACK R1: the FIRST line is always the period-over-period move.
  // Only the SECOND is switchable.
  const secondary: { change: Change; label: string; title: string } | null =
    comparison === "yoy"
      ? cell.yoy
        ? {
            change: cell.yoy,
            label: "Y",
            title: "Against the same period one year earlier",
          }
        : null
      : cell.deltaAbs
        ? {
            change: cell.deltaAbs,
            label: "Δ",
            title: `The same ${deltaWord} move as a real amount rather than a percentage`,
          }
        : null;

  return (
    <>
      <div className="mt-1 h-[var(--an-h-4)] truncate text-right font-mono text-[length:var(--bw-fs-11)] leading-[var(--bw-lh-4)] tabular-nums">
        {cell.delta ? (
          <span
            title={`${deltaWord} change`}
            className={directionCls(cell.delta.value)}
          >
            <span aria-hidden className="mr-0.5 text-[length:var(--bw-fs-9)]">
              {directionGlyph(cell.delta.value)}
            </span>
            {fmtChange(cell.delta, spec)}
          </span>
        ) : (
          <span aria-hidden>&nbsp;</span>
        )}
      </div>
      <div className="mt-0.5 flex h-[var(--an-h-15)] justify-end">
        {secondary ? (
          <span
            title={secondary.title}
            className="inline-flex items-center rounded border border-border/70 px-1 font-mono text-[length:var(--bw-fs-10)] leading-[var(--bw-lh-13)] text-muted-foreground tabular-nums"
          >
            <span className="mr-0.5 opacity-70">{secondary.label}</span>
            {fmtChange(secondary.change, spec)}
          </span>
        ) : null}
      </div>
    </>
  );
}

/**
 * The marks a figure can carry, all meaning "read the hover before you quote
 * this".
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
 * The ⚠ carries amber, and it is not a threshold: it says a figure is known to
 * rest on a broken or missing input, which is a fact about the record.
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
    <span className="flex shrink-0 items-baseline gap-px text-[length:var(--bw-fs-11)] leading-none">
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
  comparison,
  coveragePct,
  emphasis,
}: {
  cell: MatrixCell;
  spec: MetricSpec;
  deltaWord: string;
  comparison: ComparisonMode;
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
          "border-l px-2 py-1.5 align-top",
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
        <div className="flex h-[var(--an-h-5)] items-center justify-end gap-1 font-mono text-[length:var(--bw-fs-14)] leading-[var(--bw-lh-sm)] text-muted-foreground/60">
          {reason === "restricted" && <Lock className="size-3" aria-hidden />}
          {ann?.mark && (
            <span
              aria-hidden
              className="text-[length:var(--bw-fs-11)] leading-none text-amber-600 dark:text-amber-400"
            >
              {ann.mark}
            </span>
          )}
          <span>{alt ? fmtMetricValue(spec, alt.value) : "—"}</span>
        </div>
        {alt && (
          <div className="mt-0.5 h-[var(--an-h-4)] truncate text-right text-[length:var(--bw-fs-10)] leading-[var(--bw-lh-4)] text-muted-foreground">
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
      className={cn("border-l px-2 py-1.5 align-top", emphasis && "bg-muted/40")}
      title={titleParts.join(" · ")}
    >
      {/* Accounting format for ₱: glyph pinned left, number pinned right. */}
      {spec.unit === "php_per_kg" || spec.unit === "php" ? (
        <div className="flex h-[var(--an-h-5)] items-baseline justify-between gap-1 font-mono text-[length:var(--bw-fs-14)] leading-[var(--bw-lh-sm)] tabular-nums">
          <span className="shrink-0 text-[length:var(--bw-fs-11)] text-muted-foreground">₱</span>
          <span className="flex min-w-0 items-baseline gap-0.5">
            <span className="truncate font-medium">{shown}</span>
            {marks}
          </span>
        </div>
      ) : (
        <div className="flex h-[var(--an-h-5)] items-baseline justify-end gap-1 font-mono text-[length:var(--bw-fs-14)] leading-[var(--bw-lh-sm)] tabular-nums">
          <span className="truncate font-medium">
            {shown}
            {spec.unit === "pct" && (
              <span className="ml-px text-[length:var(--bw-fs-11)] text-muted-foreground">%</span>
            )}
          </span>
          {marks}
        </div>
      )}
      <ChangeLine
        cell={cell}
        spec={spec}
        deltaWord={deltaWord}
        comparison={comparison}
      />
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
  /** What the second chip under every value shows. */
  comparison: ComparisonMode;
  /**
   * The detail panel for `selected`, rendered as a full-width row DIRECTLY
   * beneath that row. Omitted when the selected metric belongs to a band this
   * instance does not render — the production room passes its own.
   */
  expand?: React.ReactNode;
  /**
   * Which bands this instance renders. Omitted = all of them.
   *
   * The page mounts this component TWICE — flow + money at the top, and the
   * production band down in its own section after the supplier room — because
   * the reading order is PERIOD → CAMPAIGN → SUPPLIER → PRODUCTION and
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
  comparison,
  expand,
  sections: only,
}: AnalyticsMatrixProps) {
  const deltaWord = DELTA_LABEL[matrix.granularity];
  // The sum of the colgroup IS the table's minWidth ("never crush, always
  // scroll"). It is a `calc()` rather than an addition now that the widths are
  // variables, so it re-resolves at the breakpoint with no JavaScript.
  const minWidth = `calc(${W_NAME} + ${matrix.periods.length} * ${W_PERIOD} + ${W_TOTAL})`;

  const sections = React.useMemo(
    () => groupBySection(matrix.rows, only),
    [matrix.rows, only],
  );

  /**
   * The VISIBLE width of the scroller, for the in-place expand.
   *
   * The expand row spans every column, so its `<td>` is as wide as the whole
   * table. The panel inside it is `sticky left-0` at this width instead, so it
   * stays in the visible frame while the periods scroll under it — and it is
   * clamped to the table's own width so a table narrower than the viewport
   * cannot be pushed into horizontal overflow by its own expand.
   *
   * Measured, never assumed: `null` until the first paint, where the panel
   * falls back to 100% of the cell (correct, just not yet pinned).
   */
  const scrollerRef = React.useRef<HTMLDivElement | null>(null);
  const [frameWidth, setFrameWidth] = React.useState<number | null>(null);

  React.useEffect(() => {
    const el = scrollerRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    // A NON-POSITIVE measurement is treated as "not measured yet" and leaves
    // the panel at 100% of its cell. Measured: an observer callback can land
    // while the element has no layout at all (a hidden pane, a reload mid-
    // paint) and reported 0, which pinned the expand to zero width.
    const measure = () => {
      const w = el.clientWidth;
      if (w > 0) setFrameWidth(w);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Clamped in CSS rather than in JS: `minWidth` is a `calc()` string now, so
  // the smaller of "the visible frame" and "the table's own width" is a
  // `min()` — the same semantics, resolved at the same breakpoint as the
  // widths it clamps against.
  const panelWidth =
    frameWidth == null ? undefined : `min(${frameWidth}px, ${minWidth})`;

  /** Fed-price coverage per COLUMN, for the `~` hover only.
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
    // TWO completely different states, and calling them both "no records"
    // would be false in the second. The window genuinely being empty is a
    // fact about the data; every column switched off is a state the reader
    // created a second ago and can undo — telling them there are no records
    // would send them looking for a bug.
    const everythingHidden = matrix.windowPeriods.length > 0;
    return (
      <div className="rounded-lg border bg-card px-4 py-10 text-center text-[length:var(--bw-fs-12)] leading-[var(--bw-lh-xs)] text-muted-foreground">
        {everythingHidden
          ? `Every column is switched off. Open the Columns filter above and turn one back on — all ${matrix.windowPeriods.length} are still there.`
          : "No months recorded in this period."}
      </div>
    );
  }

  const colCount = matrix.periods.length + 2;

  return (
    <div ref={scrollerRef} className="overflow-x-auto rounded-lg border bg-card">
      <table
        className="table-fixed text-[length:var(--bw-fs-14)] leading-[var(--bw-lh-sm)]"
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
          <tr className="h-[var(--an-h-9)] border-b">
            {/* Sticky-left AND opaque — it overlaps scrolling cells. */}
            <th
              scope="col"
              className="frozen-col frozen-edge border-b bg-muted px-2 py-1 text-left text-[length:var(--bw-fs-115)] font-medium uppercase tracking-wide text-muted-foreground"
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
                  "border-b border-l bg-muted px-2 py-1 text-right text-[length:var(--bw-fs-115)] font-medium uppercase tracking-wide text-muted-foreground",
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
              className="border-b border-l bg-muted px-2 py-1 text-right text-[length:var(--bw-fs-115)] font-semibold uppercase tracking-wide text-foreground/80"
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
                accent={section.accent}
                span={matrix.periods.length + 1}
              />
              {section.rows.map((row) => (
                <React.Fragment key={row.metric.key}>
                  <MatrixRowView
                    row={row}
                    deltaWord={deltaWord}
                    comparison={comparison}
                    accent={section.accent}
                    selected={selected === row.metric.key}
                    onSelect={onSelect}
                    perWorkingDay={perWorkingDay}
                    coverageByPeriod={coverageByPeriod}
                  />
                  {/* ── The expand, IN PLACE ────────────────────────────
                      A full-width row directly beneath the row that was
                      clicked, with the panel `sticky left-0` inside it at the
                      scroller's measured width so it never drifts off-screen
                      when the periods are scrolled. */}
                  {expand && selected === row.metric.key && (
                    <tr className="border-b">
                      <td colSpan={colCount} className="p-0 align-top">
                        <div
                          className="sticky left-0 p-2"
                          style={{ width: panelWidth ?? "100%" }}
                        >
                          {expand}
                        </div>
                      </td>
                    </tr>
                  )}
                </React.Fragment>
              ))}
            </React.Fragment>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * A thin band naming the group of rows beneath it, wearing that section's
 * accent as a left rule (owner feedback R1 — "a splash of color").
 *
 * The label cell is `.frozen-col` like every other cell in that column, so
 * it stays put while the periods scroll — a band that scrolled away would
 * leave the rows under it unlabelled exactly when the reader is furthest
 * from the header. The accent is an inset box-shadow rather than a
 * background: a frozen cell has to stay fully opaque.
 */
function SectionBand({
  id,
  label,
  hint,
  accent,
  span,
}: {
  /** Anchor target for the in-page nav. `scroll-mt-*` clears the sticky bar. */
  id?: string;
  label: string;
  hint: string;
  accent: string;
  span: number;
}) {
  return (
    <tr id={id} className="h-[var(--an-h-7)] scroll-mt-24 border-b bg-muted/40">
      {/* The accent is a real LEFT BORDER here, not `.bw-accent-rule`.
          `.frozen-edge` already owns this cell's `box-shadow` (the inset right
          border that kills the frozen↔scroll seam) and is deliberately
          unlayered so a caller cannot override it — measured: the accent's
          shadow was being dropped entirely. A border does not collide, and the
          cell stays fully opaque either way. */}
      <th
        scope="colgroup"
        title={hint}
        className="frozen-col frozen-edge border-b bg-muted py-0.5 pl-2 pr-2 text-left text-[length:var(--bw-fs-11)] font-semibold uppercase tracking-[0.08em]"
        style={{
          left: 0,
          color: accent,
          borderLeft: `3px solid ${accent}`,
        }}
      >
        {label}
      </th>
      <td colSpan={span} className="border-b border-l px-2 py-0.5">
        <span className="block truncate text-[length:var(--bw-fs-11)] leading-[var(--bw-lh-4)] text-muted-foreground/80">
          {hint}
        </span>
      </td>
    </tr>
  );
}

function MatrixRowView({
  row,
  deltaWord,
  comparison,
  accent,
  selected,
  onSelect,
  perWorkingDay,
  coverageByPeriod,
}: {
  row: MatrixRow;
  deltaWord: string;
  comparison: ComparisonMode;
  accent: string;
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
        "group h-[var(--an-h-62)] border-b transition-all duration-150",
        selected ? "bg-muted/50" : "hover:bg-muted/30",
      )}
    >
      {/* The frozen cell repaints the row state with a SOLID token — an alpha
          here would let the scrolling cells bleed through it. */}
      <th
        scope="row"
        className={cn(
          "frozen-col frozen-edge border-b px-2 py-1.5 text-left align-top font-normal",
          selected ? "bg-accent" : "bg-card group-hover:bg-muted",
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
                "mt-0.5 size-3.5 shrink-0 text-muted-foreground transition-transform duration-150",
                selected && "rotate-90 text-foreground",
              )}
            />
            <span className="min-w-0">
              <span
                className={cn(
                  "block truncate text-[length:var(--bw-fs-13)] font-medium leading-[var(--bw-lh-17)]",
                  // A ₱ row wears its band's accent on the LABEL only — a
                  // quiet way to say "this one is money" without colouring a
                  // single figure. Direction tints below are separate.
                  spec.price && "text-[color:var(--bw-accent)]",
                )}
                style={
                  spec.price
                    ? ({ "--bw-accent": accent } as React.CSSProperties)
                    : undefined
                }
              >
                {spec.label}
              </span>
              <span className="block truncate text-[length:var(--bw-fs-11)] leading-[var(--bw-lh-4)] text-muted-foreground">
                {normalised ? `${spec.sublabel} / working day` : spec.sublabel}
              </span>
            </span>
          </button>
          <MetricInfo spec={spec} className="mt-0.5" />
        </div>
        {row.restricted && (
          <span className="mt-1 inline-flex items-center gap-1 rounded border border-border/70 px-1 text-[length:var(--bw-fs-10)] leading-[var(--bw-lh-14)] text-muted-foreground">
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
          comparison={comparison}
          coveragePct={coverageByPeriod.get(cell.periodKey) ?? null}
        />
      ))}

      {row.total ? (
        <ValueCell
          cell={row.total}
          spec={spec}
          deltaWord={deltaWord}
          comparison={comparison}
          coveragePct={coverageByPeriod.get(row.total.periodKey) ?? null}
          emphasis
        />
      ) : (
        <td className="border-l bg-muted/40 px-2 py-1" />
      )}
    </tr>
  );
}
