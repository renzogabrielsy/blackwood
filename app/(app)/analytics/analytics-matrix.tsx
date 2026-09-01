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
import { DELTA_LABEL } from "@/lib/analytics/matrix";
import type { MetricKey, MetricSpec } from "@/lib/analytics/metrics";
import {
  BLANK_TITLE,
  directionGlyph,
  fmtChange,
  fmtCompact,
  fmtMetricValue,
} from "@/lib/analytics/format";
import { MetricInfo, dictionaryTitle } from "./metric-info";

// Explicit pixel widths — the sum below IS the table's minWidth.
const W_NAME = 208;
const W_PERIOD = 100;
const W_TOTAL = 112;

/** Big pesos are printed COMPACT in a 100px cell and exactly in the hover. */
function isCompactPhp(spec: MetricSpec): boolean {
  return spec.unit === "php";
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

function ValueCell({
  cell,
  spec,
  deltaWord,
  emphasis,
}: {
  cell: MatrixCell;
  spec: MetricSpec;
  deltaWord: string;
  emphasis?: boolean;
}) {
  if (cell.value == null) {
    const reason = cell.blankReason ?? "no_data";
    return (
      <td
        className={cn(
          "border-l px-2 py-1 align-top",
          emphasis && "bg-muted/40",
        )}
        title={BLANK_TITLE[reason]}
      >
        <div className="flex h-[17px] items-center justify-end gap-1 font-mono text-xs text-muted-foreground/60">
          {reason === "restricted" && <Lock className="size-2.5" aria-hidden />}
          <span>—</span>
        </div>
      </td>
    );
  }

  const shown = isCompactPhp(spec)
    ? fmtCompact(cell.value)
    : fmtMetricValue(spec, cell.value);

  const titleParts = [exactText(spec, cell.value)];
  if (cell.holed)
    titleParts.push(
      "Some months in this period recorded nothing, so this figure is a floor, not a total.",
    );
  if (cell.isPartial) titleParts.push("This period has not finished yet.");

  return (
    <td
      className={cn("border-l px-2 py-1 align-top", emphasis && "bg-muted/40")}
      title={titleParts.join(" · ")}
    >
      {/* Accounting format for ₱: glyph pinned left, number pinned right. */}
      {spec.unit === "php_per_kg" || spec.unit === "php" ? (
        <div className="flex h-[17px] items-baseline justify-between gap-1 font-mono text-xs tabular-nums">
          <span className="shrink-0 text-[10px] text-muted-foreground">₱</span>
          <span className="truncate font-medium">{shown}</span>
        </div>
      ) : (
        <div className="flex h-[17px] items-baseline justify-end gap-1 font-mono text-xs tabular-nums">
          <span className="truncate font-medium">{shown}</span>
          {cell.holed && (
            <span aria-hidden className="text-[10px] text-amber-600 dark:text-amber-400">
              ·
            </span>
          )}
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
}

export function AnalyticsMatrix({
  matrix,
  selected,
  onSelect,
  perWorkingDay,
}: AnalyticsMatrixProps) {
  const deltaWord = DELTA_LABEL[matrix.granularity];
  const minWidth =
    W_NAME + matrix.periods.length * W_PERIOD + W_TOTAL;

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
          {matrix.rows.map((row) => (
            <MatrixRowView
              key={row.metric.key}
              row={row}
              deltaWord={deltaWord}
              selected={selected === row.metric.key}
              onSelect={onSelect}
              perWorkingDay={perWorkingDay}
            />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function MatrixRowView({
  row,
  deltaWord,
  selected,
  onSelect,
  perWorkingDay,
}: {
  row: MatrixRow;
  deltaWord: string;
  selected: boolean;
  onSelect(key: MetricKey | null): void;
  perWorkingDay: boolean;
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
        />
      ))}

      {row.total ? (
        <ValueCell cell={row.total} spec={spec} deltaWord={deltaWord} emphasis />
      ) : (
        <td className="border-l bg-muted/40 px-2 py-1" />
      )}
    </tr>
  );
}
