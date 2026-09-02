"use client";

// ─────────────────────────────────────────────────────────────────────────────
// THE GRADE MIX — grade rows × PRODUCTION-BATCH columns, tonnes with the share
// under them. The same cell language as the supplier matrix, because it is the
// same shape of question: one dimension re-cutting a total the page has already
// published.
//
// ── OWNER FEEDBACK R6: THE COLUMNS ARE BATCHES ───────────────────────────────
// They were calendar months until R6 moved the whole Production band onto the
// batch clock. The `?bhide=` checklist on the campaign panel now drives these
// columns DIRECTLY — a column IS a batch — so R5's month-mapping step is
// retired along with the ambiguity it carried (a month overlapping a selected
// and an unselected batch had to be shown whole; there is no such month now).
//
// Both platform layout rules are obeyed, exactly as the two matrices above:
//
//   • **"Never crush, always scroll"** — `table-fixed`, `width: max-content`, a
//     full `<colgroup>` of explicit pixel widths, wrapped in `overflow-x-auto`.
//     No flexible column; the flexible one is the one that silently crushes.
//   • **Frozen panes are OPAQUE** — the grade column is sticky-left over
//     scrolling cells, so it paints a SOLID token (never `/opacity`, never a
//     backdrop-blur) and `.frozen-edge` kills the seam.
//
// ── THE ONE THING IT REFUSES TO DO ───────────────────────────────────────────
// **The `Σ made` footer is not a sum of the rows.** It prints the monthly
// series' own `producedKg` — the very field the Production output row of the
// matrix reads — so the grade mix and that row are the same number rather than
// two that happen to agree. They ARE equal (Σ grade kg = the parent view's
// produced_kg, 0 mismatches / 10 of 10 months, max gap 0.0 kg), and the tie is
// still CHECKED rather than assumed: when the two differ by more than a kilo
// the footer says so out loud instead of quietly showing one of them.
// ─────────────────────────────────────────────────────────────────────────────

import * as React from "react";
import { ChevronRight, Printer } from "lucide-react";
import { cn } from "@/lib/utils";
import type { GradeCell, GradeRow, GradeSet } from "@/lib/analytics/production";
import { PRODUCTION_DICTIONARY } from "@/lib/analytics/production";
import { UnitValue } from "./unit-value";
import { DictionaryPopover } from "./metric-info";
import { GradeExpand } from "./grade-expand";
import { GroupPrintPage, GroupPrintStage } from "./group-print";

// Explicit pixel widths — the sum below IS the table's minWidth.
// R3: CSS variables, so the widths move with the big-screen type scale.
// Big values: 184 -> 220, 92 -> 110, 124 -> 148.
const W_GRADE = "var(--an-w-grade)";
// R6 — a batch column ("AUG 2026") is wider than a month column ("Mar"), so it
// takes the campaign panel's own width rather than the supplier month's. The
// two tables sit one above the other and now line up.
const W_COLUMN = "var(--an-w-campaign)";
const W_TOTAL = "var(--an-w-month-total)";

/** The two figures may drift by rounding; a real disagreement is a whole kilo. */
const TIE_TOLERANCE_KG = 1;

function t1(kg: number | null): string {
  if (kg == null) return "—";
  return (kg / 1000).toLocaleString("en-US", {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  });
}

/**
 * The prose form — carries its `%`. Still what the HOVERS say, because a hover
 * is a sentence.
 */
function pct1(v: number | null): string {
  if (v == null) return "";
  return `${pctNum(v)}%`;
}

/** R6 — the CELL form: the number alone, because the `%` is pinned left. */
function pctNum(v: number | null): string {
  if (v == null) return "";
  return v.toLocaleString("en-US", {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  });
}

function kgExact(kg: number): string {
  return `${kg.toLocaleString("en-US", { maximumFractionDigits: 0 })} kg`;
}

function cellTitle(grade: string, cell: GradeCell): string {
  const parts = [`${grade} · ${cell.fullLabel}`];
  if (cell.kg != null) parts.push(`${kgExact(cell.kg)} made`);
  if (cell.sharePct != null)
    parts.push(`${pct1(cell.sharePct)} of everything that batch made`);
  if (cell.runCount != null)
    parts.push(`${cell.runCount} production entr${cell.runCount === 1 ? "y" : "ies"}`);
  parts.push(
    cell.sacks == null
      ? "No bag count recorded for this grade in that batch."
      : `${cell.sacks.toLocaleString("en-US")} bags counted`,
  );
  return parts.join(" · ");
}

function ValueCell({ grade, cell }: { grade: string; cell: GradeCell | null }) {
  if (!cell) {
    return (
      <td
        className="border-l px-2 py-1"
        title={`${grade} was not made in this batch.`}
      >
        <div className="flex h-[var(--an-h-30)] items-center justify-end font-mono text-[length:var(--bw-fs-12)] leading-[var(--bw-lh-xs)] text-muted-foreground/50">
          ·
        </div>
      </td>
    );
  }
  return (
    <td className="border-l px-2 py-1" title={cellTitle(grade, cell)}>
      {/* R6 — unit on the LEFT on both lines: tonnes above, the batch share
          below. Two stacked figures in different units is exactly the case a
          trailing suffix reads worst in. */}
      <div className="flex h-[var(--an-h-30)] flex-col justify-center">
        <UnitValue
          glyph="T"
          className="font-mono text-[length:var(--bw-fs-12)] leading-[var(--bw-lh-4)] tabular-nums"
        >
          {t1(cell.kg)}
        </UnitValue>
        <UnitValue
          glyph={cell.sharePct == null ? "" : "%"}
          className="font-mono text-[length:var(--bw-fs-105)] leading-[var(--bw-lh-4)] text-muted-foreground tabular-nums"
          glyphClassName="text-[length:var(--bw-fs-105)]"
        >
          {pctNum(cell.sharePct) || " "}
        </UnitValue>
      </div>
    </td>
  );
}

function GradeRowView({
  row,
  columns,
  selected,
  onSelect,
}: {
  row: GradeRow;
  columns: GradeSet["columns"];
  selected: boolean;
  onSelect(grade: string | null): void;
}) {
  return (
    <tr
      className={cn(
        // R5 — the divider, carried by the opaque frozen cell too.
        "group bw-row-rule h-[var(--an-h-48)] transition-all duration-150",
        selected ? "bg-muted/50" : "hover:bg-muted/30",
      )}
    >
      <th
        scope="row"
        // SOLID token only — this cell sits ON TOP of scrolling cells.
        className={cn(
          "frozen-col frozen-edge px-2 py-1 text-left align-middle font-normal",
          selected ? "bg-accent" : "bg-card group-hover:bg-muted",
        )}
        style={{ left: 0 }}
      >
        {/* R5 — grade rows open like everything else on the page. There is
            deliberately NO drag handle here: a grade row prints its own RANK
            (#1 by tonnage), so a hand-sorted order would contradict the number
            in the row beside it. Reordering is for METRIC rows, whose order is
            arbitrary; a ranked list already has one. */}
        <button
          type="button"
          onClick={() => onSelect(selected ? null : row.grade)}
          aria-expanded={selected}
          title={`${row.grade} · #${row.rank} by tonnage · ${kgExact(row.kg)} across ${row.activeColumns} batch${row.activeColumns === 1 ? "" : "es"} and ${row.runCount} production entr${row.runCount === 1 ? "y" : "ies"}`}
          className="flex w-full min-w-0 cursor-pointer items-center gap-1.5 rounded text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <ChevronRight
            aria-hidden
            className={cn(
              "size-3 shrink-0 text-muted-foreground transition-transform duration-150",
              selected && "rotate-90 text-foreground",
            )}
          />
          <span className="w-[16px] shrink-0 text-right font-mono text-[length:var(--bw-fs-105)] text-muted-foreground tabular-nums">
            {row.rank}
          </span>
          <span className="min-w-0">
            <span className="block truncate font-mono text-[length:var(--bw-fs-125)] font-medium leading-[var(--bw-lh-4)]">
              {row.grade}
            </span>
            <span className="block truncate text-[length:var(--bw-fs-105)] leading-[var(--bw-lh-4)] text-muted-foreground">
              {row.activeColumns} batch{row.activeColumns === 1 ? "" : "es"} ·{" "}
              {row.runCount} entr{row.runCount === 1 ? "y" : "ies"}
            </span>
          </span>
        </button>
      </th>

      {columns.map((c, i) => (
        <ValueCell key={c.key} grade={row.grade} cell={row.cells[i]} />
      ))}

      <td
        className="border-l bg-muted/40 px-2 py-1"
        title={`${kgExact(row.kg)} of ${row.grade} across the batches shown · ${pct1(row.sharePct)} of everything made${row.sacks == null ? " · no bag count recorded for this grade" : ` · ${row.sacks.toLocaleString("en-US")} bags counted`}`}
      >
        <div className="flex h-[var(--an-h-30)] flex-col justify-center">
          <UnitValue
            glyph="T"
            className="font-mono text-[length:var(--bw-fs-12)] leading-[var(--bw-lh-4)] tabular-nums"
            valueClassName="font-semibold"
          >
            {t1(row.kg)}
          </UnitValue>
          <UnitValue
            glyph={row.sharePct == null ? "" : "%"}
            className="font-mono text-[length:var(--bw-fs-105)] leading-[var(--bw-lh-4)] text-muted-foreground tabular-nums"
            glyphClassName="text-[length:var(--bw-fs-105)]"
          >
            {pctNum(row.sharePct) || " "}
          </UnitValue>
        </div>
      </td>
    </tr>
  );
}

export interface ProductionGradesProps {
  data: GradeSet;
  /** The read came back at the row cap — the panel says so rather than assuming. */
  truncated: boolean;
  /** R3's master switch, threaded down so this room's expands obey it too. */
  showDictionary: boolean;
  scopeLabel: string;
  asOfDate: string | null;
}

export function ProductionGrades({
  data,
  truncated,
  showDictionary,
  scopeLabel,
  asOfDate,
}: ProductionGradesProps) {
  const [selected, setSelected] = React.useState<string | null>(null);
  const [printing, setPrinting] = React.useState(false);

  /**
   * The VISIBLE width of the scroller, for the in-place expand — measured,
   * never assumed, and clamped to the table's own width so a table narrower
   * than the viewport cannot be pushed into horizontal overflow by its own
   * expand. The same mechanism the two matrices use; see the KPI matrix's
   * header comment for why a non-positive measurement means "not measured
   * yet" rather than "zero wide".
   */
  const scrollerRef = React.useRef<HTMLDivElement | null>(null);
  const [frameWidth, setFrameWidth] = React.useState<number | null>(null);

  React.useEffect(() => {
    const el = scrollerRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const measure = () => {
      const w = el.clientWidth;
      if (w > 0) setFrameWidth(w);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // A grade need not exist in every batch, and the batch filter can take one
  // off the table mid-session.
  React.useEffect(() => {
    if (selected && !data.rows.some((r) => r.grade === selected)) {
      setSelected(null);
    }
  }, [selected, data.rows]);

  const endPrint = React.useCallback(() => setPrinting(false), []);

  if (data.columns.length === 0) {
    return (
      <div className="rounded-lg border bg-card px-4 py-8 text-center text-[length:var(--bw-fs-12)] leading-[var(--bw-lh-xs)] text-muted-foreground">
        {data.filtered
          ? "None of the selected batches reported production."
          : "No production batch has reported production yet."}
      </div>
    );
  }

  const minWidth = `calc(${W_GRADE} + ${data.columns.length} * ${W_COLUMN} + ${W_TOTAL})`;
  const panelWidth =
    frameWidth == null ? undefined : `min(${frameWidth}px, ${minWidth})`;
  const colCount = data.columns.length + 2;
  // The tie, CHECKED. Equal by proof today; printed the moment it is not.
  const tieGap = data.totalGradeKg - data.totalKg;
  const tieBroken = Math.abs(tieGap) > TIE_TOLERANCE_KG;

  return (
    <div className="flex flex-col gap-2">
      {/* ── R5 — the grade group's own header and Print action ────────── */}
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <p className="text-[length:var(--bw-fs-115)] text-muted-foreground">
          <span className="font-medium text-foreground">Grade mix</span> ·{" "}
          {data.gradeCount} grade{data.gradeCount === 1 ? "" : "s"} across{" "}
          {data.columns.length} production batch
          {data.columns.length === 1 ? "" : "es"}
          {data.filtered ? " you selected" : ""}. Open a grade for its chart.
        </p>
        {data.rows.length > 0 && (
          <button
            type="button"
            disabled={printing}
            onClick={() => setPrinting(true)}
            data-print-hide
            title={`Print all ${data.rows.length} grades as one landscape report — each grade's chart, figures and definitions on its own page, in the order shown here.`}
            className="inline-flex shrink-0 cursor-pointer items-center gap-1 rounded-md border border-border/60 bg-background px-2 py-0.5 text-[length:var(--bw-fs-11)] text-muted-foreground transition-colors duration-150 hover:bg-muted hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-wait disabled:opacity-60"
          >
            <Printer className="size-3" aria-hidden />
            {printing ? "Preparing…" : `Print ${data.rows.length}`}
          </button>
        )}
      </div>

      <div ref={scrollerRef} className="overflow-x-auto rounded-lg border bg-card">
        <table
          className="table-fixed text-[length:var(--bw-fs-14)] leading-[var(--bw-lh-sm)]"
          style={{
            width: "max-content",
            minWidth,
            borderCollapse: "separate",
            borderSpacing: 0,
          }}
        >
          <colgroup>
            <col style={{ width: W_GRADE }} />
            {data.columns.map((c) => (
              <col key={c.key} style={{ width: W_COLUMN }} />
            ))}
            <col style={{ width: W_TOTAL }} />
          </colgroup>

          <thead>
            <tr className="h-[var(--an-h-9)] border-b">
              <th
                scope="col"
                className="frozen-col frozen-edge border-b bg-muted px-2 py-1 text-left align-bottom text-[length:var(--bw-fs-115)] font-medium uppercase tracking-wide text-muted-foreground"
                style={{ left: 0 }}
              >
                <span className="flex items-center gap-1">
                  Grade
                  <DictionaryPopover
                    label={PRODUCTION_DICTIONARY.grade_mix.label}
                    sublabel={PRODUCTION_DICTIONARY.grade_mix.sublabel}
                    entry={PRODUCTION_DICTIONARY.grade_mix.dictionary}
                  />
                </span>
              </th>
              {data.columns.map((c) => (
                <th
                  key={c.key}
                  scope="col"
                  title={`${c.fullLabel} · ${c.producedKg == null ? "nothing reported" : kgExact(c.producedKg)} made across ${c.gradeCount} grade${c.gradeCount === 1 ? "" : "s"}`}
                  className="border-b border-l bg-muted px-2 py-1 text-right align-bottom"
                >
                  <span className="block truncate text-[length:var(--bw-fs-115)] font-medium uppercase tracking-wide text-muted-foreground">
                    {c.label}
                  </span>
                  <span className="block truncate font-mono text-[length:var(--bw-fs-10)] leading-[var(--bw-lh-3)] text-muted-foreground/70">
                    {c.gradeCount} grade{c.gradeCount === 1 ? "" : "s"}
                  </span>
                </th>
              ))}
              <th
                scope="col"
                title={`Everything made across the batches shown, and each grade's share of it. The total is the sum of those batches and the share is that sum over their produced kilos — never an average of per-batch percentages.`}
                className="border-b border-l bg-muted px-2 py-1 text-right align-bottom"
              >
                <span className="block truncate text-[length:var(--bw-fs-115)] font-medium uppercase tracking-wide text-muted-foreground">
                  {data.totalLabel}
                </span>
                <span className="block truncate font-mono text-[length:var(--bw-fs-10)] leading-[var(--bw-lh-3)] text-muted-foreground/70">
                  tonnes · share
                </span>
              </th>
            </tr>
          </thead>

          <tbody>
            {data.rows.map((row) => (
              <React.Fragment key={row.grade}>
                <GradeRowView
                  row={row}
                  columns={data.columns}
                  selected={selected === row.grade}
                  onSelect={setSelected}
                />
                {/* The expand, IN PLACE — pinned to the visible frame so it
                    does not drift sideways when the months are scrolled. */}
                {selected === row.grade && (
                  <tr className="border-b">
                    <td colSpan={colCount} className="p-0 align-top">
                      <div
                        className="sticky left-0 p-2"
                        style={{ width: panelWidth ?? "100%" }}
                      >
                        <GradeExpand
                          // Keyed by grade AND the batch selection — a fresh,
                          // smart-defaulted batch filter per card, the same
                          // discipline every other expand on this page keeps.
                          key={`${row.grade}:${data.columns.length}`}
                          row={row}
                          data={data}
                          showDictionary={showDictionary}
                          scopeLabel={scopeLabel}
                          asOfDate={asOfDate}
                          onClose={() => setSelected(null)}
                        />
                      </div>
                    </td>
                  </tr>
                )}
              </React.Fragment>
            ))}

            {/* ── Σ made — the matrix's OWN figure, not a sum of the column ── */}
            <tr className="h-[var(--an-h-9)] border-t bg-muted/30">
              <th
                scope="row"
                title="Everything the plant made in that batch, as the Production output row above publishes it. This row is not added up from the grades — it is the same figure, so the two can never drift apart."
                className="frozen-col frozen-edge bg-muted px-2 py-1 text-left text-[length:var(--bw-fs-11)] font-semibold uppercase tracking-wide text-muted-foreground"
                style={{ left: 0 }}
              >
                Σ made
              </th>
              {data.columns.map((c) => (
                <td
                  key={c.key}
                  className="border-l px-2 py-1"
                  title={`${c.fullLabel} · ${c.producedKg == null ? "nothing reported" : kgExact(c.producedKg)} — the Production output row's own figure.`}
                >
                  <UnitValue
                    glyph="T"
                    className="font-mono text-[length:var(--bw-fs-12)] leading-[var(--bw-lh-xs)] tabular-nums"
                    valueClassName="font-semibold"
                  >
                    {t1(c.producedKg)}
                  </UnitValue>
                </td>
              ))}
              <td
                className="border-l bg-muted/40 px-2 py-1"
                title={`${kgExact(data.totalKg)} made across the batches shown.`}
              >
                <UnitValue
                  glyph="T"
                  className="font-mono text-[length:var(--bw-fs-12)] leading-[var(--bw-lh-xs)] tabular-nums"
                  valueClassName="font-semibold"
                >
                  {t1(data.totalKg)}
                </UnitValue>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <p className="text-[length:var(--bw-fs-115)] leading-relaxed text-muted-foreground">
        A cell is tonnes of that grade with its share of the batch under it; a{" "}
        <span className="font-mono">·</span> means the grade was not run in that
        batch. The <span className="font-mono">Σ made</span> row is the
        Production output row&rsquo;s own figure rather than a sum of the grades
        above it, so the two can never drift apart.
        {tieBroken ? (
          <>
            {" "}
            <strong className="font-semibold text-foreground">
              They do not agree today:
            </strong>{" "}
            the grades add to{" "}
            <span className="font-mono">{kgExact(data.totalGradeKg)}</span>{" "}
            against a published{" "}
            <span className="font-mono">{kgExact(data.totalKg)}</span> — a gap
            of <span className="font-mono">{kgExact(Math.abs(tieGap))}</span>.
            Neither figure has been adjusted to hide it.
          </>
        ) : (
          " The grades add to the published total exactly."
        )}
        {data.filtered &&
          " These columns are the batches you selected above; the total column is folded over those batches, not every batch on record."}
        {truncated &&
          " This read came back at the database row limit, so the grade set may be short of the full one."}
      </p>

      {/* R5 — the group report, while it is printing. Off-screen but genuinely
          laid out, because recharts measures a real box. See `group-print.tsx`. */}
      {printing && (
        <GroupPrintStage
          title="Grade mix"
          subtitle={`${data.columns.length} production batch${data.columns.length === 1 ? "" : "es"}${
            data.filtered ? " (the ones you selected)" : ""
          } · ${scopeLabel}${asOfDate ? ` · records through ${asOfDate}` : ""}`}
          countLabel={`${data.rows.length} grade${data.rows.length === 1 ? "" : "s"}`}
          onDone={endPrint}
        >
          {data.rows.map((row) => (
            <GroupPrintPage key={row.grade}>
              <GradeExpand
                row={row}
                data={data}
                showDictionary={showDictionary}
                scopeLabel={scopeLabel}
                asOfDate={asOfDate}
                onClose={endPrint}
              />
            </GroupPrintPage>
          ))}
        </GroupPrintStage>
      )}
    </div>
  );
}
