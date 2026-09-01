"use client";

// ─────────────────────────────────────────────────────────────────────────────
// THE GRADE MIX (P4) — grade rows × month columns, tonnes with the share under
// them. The same cell language as the supplier matrix above it, because it is
// the same shape of question: one dimension re-cutting a total the page has
// already published.
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

import type { GradeCell, GradeRow, GradeYear } from "@/lib/analytics/production";
import { PRODUCTION_DICTIONARY } from "@/lib/analytics/production";
import { DictionaryPopover } from "./metric-info";

// Explicit pixel widths — the sum below IS the table's minWidth.
const W_GRADE = 184;
const W_MONTH = 92;
const W_TOTAL = 124;

/** The two figures may drift by rounding; a real disagreement is a whole kilo. */
const TIE_TOLERANCE_KG = 1;

function t1(kg: number | null): string {
  if (kg == null) return "—";
  return (kg / 1000).toLocaleString("en-US", {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  });
}

function pct1(v: number | null): string {
  if (v == null) return "";
  return `${v.toLocaleString("en-US", { minimumFractionDigits: 1, maximumFractionDigits: 1 })}%`;
}

function kgExact(kg: number): string {
  return `${kg.toLocaleString("en-US", { maximumFractionDigits: 0 })} kg`;
}

function cellTitle(grade: string, cell: GradeCell): string {
  const parts = [`${grade} · ${cell.fullLabel}`];
  if (cell.kg != null) parts.push(`${kgExact(cell.kg)} made`);
  if (cell.sharePct != null)
    parts.push(`${pct1(cell.sharePct)} of everything made that month`);
  if (cell.runCount != null)
    parts.push(`${cell.runCount} production entr${cell.runCount === 1 ? "y" : "ies"}`);
  parts.push(
    cell.sacks == null
      ? "No bag count recorded for this grade that month."
      : `${cell.sacks.toLocaleString("en-US")} bags counted`,
  );
  return parts.join(" · ");
}

function ValueCell({ grade, cell }: { grade: string; cell: GradeCell | null }) {
  if (!cell) {
    return (
      <td
        className="border-l px-2 py-1"
        title={`${grade} was not made in this month.`}
      >
        <div className="flex h-[30px] items-center justify-end font-mono text-xs text-muted-foreground/50">
          ·
        </div>
      </td>
    );
  }
  return (
    <td className="border-l px-2 py-1" title={cellTitle(grade, cell)}>
      <div className="flex h-[30px] flex-col items-end justify-center">
        <span className="truncate font-mono text-xs leading-4 tabular-nums">
          {t1(cell.kg)}
        </span>
        <span className="truncate font-mono text-[10.5px] leading-4 text-muted-foreground tabular-nums">
          {pct1(cell.sharePct) || " "}
        </span>
      </div>
    </td>
  );
}

function GradeRowView({
  row,
  months,
}: {
  row: GradeRow;
  months: GradeYear["months"];
}) {
  return (
    <tr className="group h-[48px] border-b transition-all duration-150 hover:bg-muted/30">
      <th
        scope="row"
        // SOLID token only — this cell sits ON TOP of scrolling cells.
        className="frozen-col frozen-edge border-b bg-card px-2 py-1 text-left align-middle font-normal group-hover:bg-muted"
        style={{ left: 0 }}
        title={`${row.grade} · #${row.rank} by tonnage · ${kgExact(row.kg)} across ${row.activeMonths} month${row.activeMonths === 1 ? "" : "s"} and ${row.runCount} production entr${row.runCount === 1 ? "y" : "ies"}`}
      >
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="w-[16px] shrink-0 text-right font-mono text-[10.5px] text-muted-foreground tabular-nums">
            {row.rank}
          </span>
          <span className="min-w-0">
            <span className="block truncate font-mono text-[12.5px] font-medium leading-4">
              {row.grade}
            </span>
            <span className="block truncate text-[10.5px] leading-4 text-muted-foreground">
              {row.activeMonths} month{row.activeMonths === 1 ? "" : "s"} ·{" "}
              {row.runCount} entr{row.runCount === 1 ? "y" : "ies"}
            </span>
          </span>
        </span>
      </th>

      {months.map((m, i) => (
        <ValueCell key={m.monthStart} grade={row.grade} cell={row.cells[i]} />
      ))}

      <td
        className="border-l bg-muted/40 px-2 py-1"
        title={`${kgExact(row.kg)} of ${row.grade} across the year · ${pct1(row.sharePct)} of everything made${row.sacks == null ? " · no bag count recorded for this grade" : ` · ${row.sacks.toLocaleString("en-US")} bags counted`}`}
      >
        <div className="flex h-[30px] flex-col items-end justify-center">
          <span className="truncate font-mono text-xs font-semibold leading-4 tabular-nums">
            {t1(row.kg)}
          </span>
          <span className="truncate font-mono text-[10.5px] leading-4 text-muted-foreground tabular-nums">
            {pct1(row.sharePct) || " "}
          </span>
        </div>
      </td>
    </tr>
  );
}

export interface ProductionGradesProps {
  data: GradeYear;
  /** The read came back at the row cap — the panel says so rather than assuming. */
  truncated: boolean;
}

export function ProductionGrades({ data, truncated }: ProductionGradesProps) {
  if (data.months.length === 0) {
    return (
      <div className="rounded-lg border bg-card px-4 py-8 text-center text-xs text-muted-foreground">
        Production was not reported in {data.year}.
      </div>
    );
  }

  const minWidth = W_GRADE + data.months.length * W_MONTH + W_TOTAL;
  // The tie, CHECKED. Equal by proof today; printed the moment it is not.
  const tieGap = data.totalGradeKg - data.totalKg;
  const tieBroken = Math.abs(tieGap) > TIE_TOLERANCE_KG;

  return (
    <div className="flex flex-col gap-2">
      <div className="overflow-x-auto rounded-lg border bg-card">
        <table
          className="table-fixed text-sm"
          style={{
            width: "max-content",
            minWidth,
            borderCollapse: "separate",
            borderSpacing: 0,
          }}
        >
          <colgroup>
            <col style={{ width: W_GRADE }} />
            {data.months.map((m) => (
              <col key={m.monthStart} style={{ width: W_MONTH }} />
            ))}
            <col style={{ width: W_TOTAL }} />
          </colgroup>

          <thead>
            <tr className="h-9 border-b">
              <th
                scope="col"
                className="frozen-col frozen-edge border-b bg-muted px-2 py-1 text-left align-bottom text-[11.5px] font-medium uppercase tracking-wide text-muted-foreground"
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
              {data.months.map((m) => (
                <th
                  key={m.monthStart}
                  scope="col"
                  title={`${m.fullLabel} · ${m.producedKg == null ? "nothing reported" : kgExact(m.producedKg)} made across ${m.gradeCount} grade${m.gradeCount === 1 ? "" : "s"}`}
                  className="border-b border-l bg-muted px-2 py-1 text-right align-bottom"
                >
                  <span className="block truncate text-[11.5px] font-medium uppercase tracking-wide text-muted-foreground">
                    {m.label}
                  </span>
                  <span className="block truncate font-mono text-[10px] leading-3 text-muted-foreground/70">
                    {m.gradeCount} grade{m.gradeCount === 1 ? "" : "s"}
                  </span>
                </th>
              ))}
              <th
                scope="col"
                title={`Everything made in ${data.year}, and each grade's share of it. The year figure is the sum of the months and the share is that sum over the year's produced kilos — never an average of monthly percentages.`}
                className="border-b border-l bg-muted px-2 py-1 text-right align-bottom"
              >
                <span className="block truncate text-[11.5px] font-medium uppercase tracking-wide text-muted-foreground">
                  {data.year}
                </span>
                <span className="block truncate font-mono text-[10px] leading-3 text-muted-foreground/70">
                  tonnes · share
                </span>
              </th>
            </tr>
          </thead>

          <tbody>
            {data.rows.map((row) => (
              <GradeRowView key={row.grade} row={row} months={data.months} />
            ))}

            {/* ── Σ made — the matrix's OWN figure, not a sum of the column ── */}
            <tr className="h-9 border-t bg-muted/30">
              <th
                scope="row"
                title="Everything the plant made that month, as the Production output row above publishes it. This row is not added up from the grades — it is the same figure, so the two can never drift apart."
                className="frozen-col frozen-edge bg-muted px-2 py-1 text-left text-[11px] font-semibold uppercase tracking-wide text-muted-foreground"
                style={{ left: 0 }}
              >
                Σ made
              </th>
              {data.months.map((m) => (
                <td
                  key={m.monthStart}
                  className="border-l px-2 py-1 text-right"
                  title={`${m.fullLabel} · ${m.producedKg == null ? "nothing reported" : kgExact(m.producedKg)} — the Production output row's own figure.`}
                >
                  <span className="font-mono text-xs font-semibold tabular-nums">
                    {t1(m.producedKg)}
                  </span>
                </td>
              ))}
              <td
                className="border-l bg-muted/40 px-2 py-1 text-right"
                title={`${kgExact(data.totalKg)} made in ${data.year}.`}
              >
                <span className="font-mono text-xs font-semibold tabular-nums">
                  {t1(data.totalKg)}
                </span>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <p className="text-[11.5px] leading-relaxed text-muted-foreground">
        A cell is tonnes of that grade with its share of the month under it; a{" "}
        <span className="font-mono">·</span> means the grade was not run that
        month. The <span className="font-mono">Σ made</span> row is the
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
        {truncated &&
          " This read came back at the database row limit, so the grade set may be short of the full one."}
      </p>
    </div>
  );
}
