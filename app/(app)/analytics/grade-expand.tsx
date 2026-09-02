"use client";

// ─────────────────────────────────────────────────────────────────────────────
// ONE GRADE'S YEAR — the grade mix's row expand (owner feedback R5)
//
// Renzo: *"production grade table gets expands — grade rows open charts /
// breakdown like everything else."* "Like everything else" is the whole brief,
// and R4 already wrote down what "everything else" means: the **universal
// module contract** — a period checklist with a smart default, a stat strip
// that recomputes from it, an average switch, Print, and the page's master
// Definitions switch. This card carries all five, so the grade mix stops being
// the one table on the page a reader cannot open.
//
// ── WHAT IT DRAWS, AND WHY TWO AXES ─────────────────────────────────────────
// Tonnes made as bars, and the grade's SHARE of each month as a line on its
// own right-hand axis. They are the two different questions a grade row asks —
// "how much of this did we make" and "how much of what we made was this" — and
// they part company constantly: a grade can rise in tonnes while its share
// falls because the plant made more of everything. One axis would have
// flattened the share into the baseline, which is the same reason the KPI
// expand's price overlay rides its own axis.
//
// ── THE ARITHMETIC IS NOT REPEATED HERE ─────────────────────────────────────
// Every monthly share is SQL's own (`share_of_month_pct`, whose denominator is
// JOINED from the monthly production view), and the folded stats go through
// `foldGradeSelection` in `lib/analytics/production.ts` — the same module the
// table itself folds with. Nothing in this file computes a share, and the
// selection's denominator is the months' published `producedKg`, never a sum
// of the grade rows. So a filtered share is a share of the months shown, and
// it can no more disagree with the table above it than the `Σ made` footer can
// disagree with the Production output row.
//
// **No ₱ exists in this card and none is derivable** — production is the one
// module of the platform with no money in it, so nothing here is gated and
// there is no restricted variant to render.
// ─────────────────────────────────────────────────────────────────────────────

import * as React from "react";
import {
  Bar,
  CartesianGrid,
  ComposedChart,
  Legend,
  Line,
  ResponsiveContainer,
  Tooltip as RTooltip,
  XAxis,
  YAxis,
} from "recharts";
import { Printer, X } from "lucide-react";
import {
  DRILLDOWN_AXIS_TICK,
  DrilldownSection,
  DrilldownStat,
  drilldownTooltipChrome,
} from "@/components/digest/drilldown/drilldown-modal";
import { BreakdownRail } from "@/components/digest/drilldown/series-parts";
import type { RailItem } from "@/components/digest/drilldown/series-parts";
import { rollingMean, rollingWindowFor } from "@/lib/analytics/matrix";
import {
  foldGradeSelection,
  PRODUCTION_DICTIONARY,
  type GradeRow,
  type GradeSet,
} from "@/lib/analytics/production";
import { ChartToggle } from "./metric-expand";
import { PeriodFilter, type PeriodFilterOption } from "./period-filter";
import { printCard } from "./print-card";
import { NO_HIDDEN } from "@/lib/analytics/period-selection";

const CHART_HEIGHT = "var(--an-chart-sm)";

function t1(kg: number | null): string {
  if (kg == null) return "—";
  return (kg / 1000).toLocaleString("en-US", {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  });
}

function pct1(v: number | null): string {
  if (v == null) return "—";
  return v.toLocaleString("en-US", {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  });
}

export interface GradeExpandProps {
  row: GradeRow;
  data: GradeSet;
  /** R3's master switch, threaded through the production room like every other. */
  showDictionary: boolean;
  /** What a printed card says the reader was looking at. */
  scopeLabel: string;
  asOfDate: string | null;
  onClose(): void;
}

export function GradeExpand({
  row,
  data,
  showDictionary,
  scopeLabel,
  asOfDate,
  onClose,
}: GradeExpandProps) {
  const cardRef = React.useRef<HTMLElement | null>(null);
  const tip = drilldownTooltipChrome();

  /**
   * The BATCH checklist, with the R4 smart default: it opens on the batches
   * this GRADE was actually made in. (R6: these were months until the band
   * moved to the batch clock; the rule is unchanged, the unit is not.)
   *
   * Same three properties that keep the KPI card's year default honest — it is
   * derived from the row's own cells rather than from a date, the empty batches
   * are still listed and one click brings them back, and **it can never hide
   * everything** (a grade with no batch at all opens fully checked, because an
   * empty chart under an empty-state sentence the reader did not cause is
   * worse than an empty chart).
   */
  const [hiddenCols, setHiddenCols] = React.useState<ReadonlySet<string>>(() => {
    const empty = data.columns
      .filter((c, i) => row.cells[i]?.kg == null)
      .map((c) => c.key);
    if (empty.length === 0 || empty.length === data.columns.length) {
      return NO_HIDDEN;
    }
    return new Set(empty);
  });
  const isFiltered = hiddenCols.size > 0;
  const [showAvg, setShowAvg] = React.useState(true);

  const colOptions = React.useMemo<PeriodFilterOption[]>(
    () =>
      data.columns.map((c, i) => {
        const cell = row.cells[i];
        return {
          key: c.key,
          label: c.label,
          meta: cell?.kg == null ? "—" : `${t1(cell.kg)}t`,
          empty: cell?.kg == null,
          title:
            cell?.kg == null
              ? `${c.fullLabel} — ${row.grade} was not run in that batch. A genuine blank, not a zero.`
              : `${c.fullLabel} — ${t1(cell.kg)} t of ${row.grade}, ${pct1(cell.sharePct)}% of everything that batch made.`,
        };
      }),
    [data.columns, row.cells, row.grade],
  );

  const shownColCount = colOptions.filter((o) => !hiddenCols.has(o.key)).length;
  const selectedSuffix = isFiltered ? " · selected" : "";

  const fold = React.useMemo(
    () => foldGradeSelection(row, data.columns, hiddenCols),
    [row, data.columns, hiddenCols],
  );

  /**
   * The chart series.
   *
   * THE ORDER MATTERS, and it is the same order the KPI expand uses: hidden
   * months are NULLED first, the trailing mean is run over that nulled
   * sequence, and only then are they dropped. So a window spanning a hidden
   * month yields null and the average line BREAKS at the gap rather than
   * drawing across a hole the reader made. `rollingMean` and
   * `rollingWindowFor` are imported from `matrix.ts` rather than
   * re-implemented, so there is one definition of the smoothing on this page.
   */
  const points = React.useMemo(() => {
    const win = rollingWindowFor("B");
    const values = data.columns.map((c, i) =>
      hiddenCols.has(c.key) ? null : (row.cells[i]?.kg ?? null),
    );
    const out: {
      key: string;
      label: string;
      fullLabel: string;
      tonnes: number | null;
      share: number | null;
      avg: number | null;
    }[] = [];
    data.columns.forEach((c, i) => {
      if (hiddenCols.has(c.key)) return;
      const cell = row.cells[i];
      const raw = win > 0 ? rollingMean(values, i, win) : null;
      out.push({
        key: c.key,
        label: c.label,
        fullLabel: c.fullLabel,
        tonnes: cell?.kg == null ? null : cell.kg / 1000,
        share: cell?.sharePct ?? null,
        avg: raw == null ? null : raw / 1000,
      });
    });
    return out;
  }, [data.columns, row.cells, hiddenCols]);

  const railItems: RailItem[] = points
    .filter((p) => p.tonnes != null)
    .map((p) => ({
      key: p.key,
      label: p.fullLabel,
      value: t1((p.tonnes ?? 0) * 1000),
      unit: "t",
      sharePct: p.share ?? 0,
      title: `${t1((p.tonnes ?? 0) * 1000)} t of ${row.grade} — ${pct1(p.share)}% of everything that batch made.`,
    }));

  const selectedColsNote = isFiltered
    ? colOptions
        .filter((o) => !hiddenCols.has(o.key))
        .map((o) => o.label)
        .join(", ") || "none"
    : null;

  const drewSomething = points.some((p) => p.tonnes != null);

  return (
    <section
      ref={cardRef}
      // THE PRINT TARGET — the same contract the two other expands keep.
      data-print-card
      className="animate-fade-up rounded-lg border bg-card"
    >
      {/* Paper only. A printed figure that does not say what it is and when it
          was true is a figure somebody misquotes a month later. */}
      <div className="hidden print:block print:pb-2">
        <h1 className="text-[length:var(--bw-fs-16)] leading-[var(--bw-lh-base)] font-semibold tracking-tight">
          {row.grade}
        </h1>
        <p className="text-[length:var(--bw-fs-11)] text-muted-foreground">
          Production grade · by production batch · {scopeLabel}
          {asOfDate ? ` · records through ${asOfDate}` : ""}
        </p>
        {selectedColsNote && (
          <p className="text-[length:var(--bw-fs-11)] text-muted-foreground">
            Filtered to {selectedColsNote} ({shownColCount} of{" "}
            {colOptions.length} batches). Hidden batches are not restated — the
            figures above are folded over the batches shown, and the
            share&rsquo;s denominator narrowed with them.
          </p>
        )}
      </div>

      <header className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 border-b px-3 py-2 print:hidden">
        <div className="min-w-0">
          <h3 className="truncate font-mono text-[length:var(--bw-fs-14)] leading-[var(--bw-lh-sm)] font-semibold tracking-tight">
            {row.grade}
          </h3>
          <p className="text-[length:var(--bw-fs-105)] text-muted-foreground">
            #{row.rank} of {data.gradeCount} grade
            {data.gradeCount === 1 ? "" : "s"} · made in {row.activeColumns}{" "}
            batch{row.activeColumns === 1 ? "" : "es"}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1.5" data-print-hide>
          <button
            type="button"
            onClick={() => printCard(cardRef.current)}
            title="Print just this grade — its chart, its figures and its definition — or save it as a PDF from the print dialog."
            className="inline-flex cursor-pointer items-center gap-1 rounded-md border border-border px-2 py-0.5 text-[length:var(--bw-fs-11)] text-muted-foreground transition-colors duration-150 hover:bg-muted hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <Printer className="size-3" aria-hidden />
            Print
          </button>
          <button
            type="button"
            onClick={onClose}
            className="inline-flex cursor-pointer items-center gap-1 rounded-md border border-border px-2 py-0.5 text-[length:var(--bw-fs-11)] text-muted-foreground transition-colors duration-150 hover:bg-muted hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <X className="size-3" aria-hidden />
            Close
          </button>
        </div>
      </header>

      <div className="flex flex-col gap-3 p-3">
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          {/* R6 — the unit sits on the LEFT here too, so the strip and the
              table under it announce a unit in the same place. */}
          <DrilldownStat
            label={`Made${selectedSuffix}`}
            value={t1(fold.kg)}
            unit="T"
            unitSide="left"
            sub={`${fold.runCount} production entr${fold.runCount === 1 ? "y" : "ies"}${
              isFiltered ? ` · ${fold.columnCount} batches` : ""
            }`}
            title="Kilos of this grade in the batches shown. A plain sum — the only rollup a volume allows."
          />
          <DrilldownStat
            label={`Share${selectedSuffix}`}
            value={pct1(fold.sharePct)}
            unit={fold.sharePct == null ? undefined : "%"}
            unitSide="left"
            sub={isFiltered ? "of the batches shown" : "of the batches on show"}
            title={
              isFiltered
                ? "This grade's kilos over everything the plant made in the BATCHES SHOWN — the denominator narrows with the selection, so this is a share of those batches rather than of every batch."
                : "This grade's kilos over everything the plant made in these batches — Σ ÷ Σ, never the average of the per-batch percentages."
            }
          />
          <DrilldownStat
            label={`Best batch${selectedSuffix}`}
            value={t1(fold.bestColumn?.kg ?? null)}
            unit={fold.bestColumn ? "T" : undefined}
            unitSide="left"
            sub={fold.bestColumn?.fullLabel}
            title="The biggest batch for this grade among the ones shown. A magnitude, not a verdict."
          />
          <DrilldownStat
            label={`Bags${selectedSuffix}`}
            value={
              fold.sacks == null ? "—" : fold.sacks.toLocaleString("en-US")
            }
            unit={fold.sacks == null ? undefined : "bags"}
            unitSide="left"
            sub={fold.sacks == null ? "not recorded" : "counted"}
            tone={fold.sacks == null ? "muted" : "default"}
            title="Bags counted against this grade in the batches shown. It is NULL and never 0 where bags were not being counted — the plant only began recording them in May 2026, and a zero would claim none were filled."
          />
        </div>

        <div className="grid grid-cols-1 gap-3 lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
          <DrilldownSection
            title={
              isFiltered
                ? `${row.grade} — the batches you chose`
                : `${row.grade}, batch by batch`
            }
            subtitle={
              `tonnes made · share of the batch` +
              (isFiltered
                ? ` · ${shownColCount}/${colOptions.length} batches`
                : "")
            }
            action={
              // `data-print-hide` — a control is not part of the report.
              <span
                className="flex flex-wrap items-center justify-end gap-1.5"
                data-print-hide
              >
                <ChartToggle
                  on={showAvg}
                  onChange={setShowAvg}
                  label="3-batch avg"
                  color="var(--chart-3)"
                  title={
                    showAvg
                      ? "Hide the 3-batch avg line. It is a trailing mean over the last three batches and it breaks at a gap rather than drawing across one."
                      : "Draw the 3-batch avg line — a trailing mean over the last three batches, which breaks at a gap rather than drawing across one."
                  }
                />
                <PeriodFilter
                  label="Batches"
                  noun="batch"
                  nounPlural="batches"
                  align="end"
                  options={colOptions}
                  hidden={hiddenCols}
                  onChange={setHiddenCols}
                  title="Choose which production batches this card covers. It opens on the batches this grade was actually run in; the rest are listed and one click brings them back. Hiding a batch removes its bar AND its share of the figures above — the share's denominator narrows with it, so a filtered share is a share of the batches shown."
                />
              </span>
            }
            bodyClassName="p-2"
          >
            {drewSomething ? (
              <div className="w-full" style={{ height: CHART_HEIGHT }}>
                <ResponsiveContainer width="100%" height="100%">
                  <ComposedChart
                    data={points}
                    margin={{ top: 6, right: 4, bottom: 0, left: 0 }}
                  >
                    <CartesianGrid
                      stroke="var(--border)"
                      strokeOpacity={0.4}
                      vertical={false}
                    />
                    <XAxis
                      dataKey="label"
                      tick={DRILLDOWN_AXIS_TICK}
                      tickLine={false}
                      axisLine={{ stroke: "var(--border)" }}
                      minTickGap={8}
                    />
                    {/* A BAR is read as a length from the baseline, so its axis
                        must include zero. */}
                    <YAxis
                      yAxisId="volume"
                      tick={DRILLDOWN_AXIS_TICK}
                      tickLine={false}
                      axisLine={false}
                      width={46}
                      domain={[0, "auto"]}
                      tickFormatter={(v: number) =>
                        v.toLocaleString("en-US", { maximumFractionDigits: 0 })
                      }
                    />
                    {/* The share's OWN axis, fixed 0–100: a share is a share of
                        the whole, and letting recharts auto-scale it would make
                        a grade that never exceeds 20% look like it fills the
                        plant. */}
                    <YAxis
                      yAxisId="share"
                      orientation="right"
                      tick={DRILLDOWN_AXIS_TICK}
                      tickLine={false}
                      axisLine={false}
                      width={44}
                      domain={[0, 100]}
                      tickFormatter={(v: number) => `${v}%`}
                    />
                    <RTooltip
                      {...tip}
                      formatter={(value, name) => {
                        if (value == null) return ["—", String(name)];
                        const v = Number(value);
                        if (name === "share")
                          return [`${pct1(v)}%`, "Share of the batch"];
                        if (name === "avg")
                          return [`${v.toFixed(1)} t`, "3-batch avg"];
                        return [`${v.toFixed(1)} t`, `${row.grade} made`];
                      }}
                      labelFormatter={(label, payload) =>
                        payload?.[0]?.payload?.fullLabel ?? label
                      }
                    />
                    <Legend
                      wrapperStyle={{
                        fontSize: "var(--bw-fs-11)",
                        paddingTop: 4,
                      }}
                      formatter={(v) =>
                        v === "share"
                          ? "Share of the batch (%, right)"
                          : v === "avg"
                            ? "3-batch avg (t)"
                            : `${row.grade} (t, left)`
                      }
                    />
                    <Bar
                      yAxisId="volume"
                      dataKey="tonnes"
                      name="tonnes"
                      fill="var(--chart-1)"
                      radius={[3, 3, 0, 0]}
                      maxBarSize={28}
                      isAnimationActive={false}
                    />
                    {/* Genuinely removed rather than hidden when switched off:
                        recharts derives its legend from the children it is
                        given, so a hidden line would leave a blank key. */}
                    {showAvg && (
                      <Line
                        yAxisId="volume"
                        type="monotone"
                        dataKey="avg"
                        name="avg"
                        stroke="var(--chart-3)"
                        strokeWidth={2}
                        dot={false}
                        isAnimationActive={false}
                        connectNulls={false}
                      />
                    )}
                    <Line
                      yAxisId="share"
                      type="monotone"
                      dataKey="share"
                      name="share"
                      stroke="var(--chart-4)"
                      strokeWidth={1.75}
                      strokeDasharray="4 3"
                      dot={{ r: 2 }}
                      isAnimationActive={false}
                      connectNulls={false}
                    />
                  </ComposedChart>
                </ResponsiveContainer>
              </div>
            ) : (
              <p className="px-3 py-10 text-center text-[length:var(--bw-fs-12)] leading-[var(--bw-lh-xs)] text-muted-foreground">
                {isFiltered
                  ? "Every batch is switched off. Open the Batches filter and turn one back on — nothing has been discarded."
                  : `${row.grade} was not run in any of these batches.`}
              </p>
            )}
            {isFiltered && drewSomething && (
              <p className="px-1 pb-1 pt-1.5 text-[length:var(--bw-fs-12)] leading-relaxed text-muted-foreground">
                Showing{" "}
                <span className="font-medium text-foreground">
                  {selectedColsNote}
                </span>
                . This card opens on the batches this grade was actually run in;
                the rest are one click away in{" "}
                <span className="font-medium text-foreground">Batches</span>.
                The figures above are re-folded over what is left, and the
                share&rsquo;s denominator is the produced kilos of those batches
                — never a sum of the grade rows.
                {showAvg && (
                  <>
                    {" "}
                    The trailing average is recomputed over what is left and{" "}
                    <strong className="font-semibold">breaks at the gap</strong>{" "}
                    rather than drawing across a batch you put away.
                  </>
                )}
              </p>
            )}
          </DrilldownSection>

          <DrilldownSection
            title="Batch by batch"
            subtitle="share of everything made"
            bodyClassName="p-0"
          >
            <BreakdownRail
              items={railItems}
              emptyText={`Nothing recorded for ${row.grade} in the months shown.`}
              maxHeight={`calc(${CHART_HEIGHT} + 20px)`}
            />
          </DrilldownSection>
        </div>

        {/* The dictionary, behind the page's MASTER Definitions switch — the
            same copy the Grade column's own Info popover shows, so the two can
            never describe a figure two ways. ₱-free, and here that is free
            rather than a discipline: there is no peso in the production layer
            to leak. */}
        {showDictionary && (
          <div
            className="grid grid-cols-1 gap-2 sm:grid-cols-2"
            data-print-block
          >
            <div className="rounded-lg border bg-background/40 px-3 py-2">
              <div className="text-[length:var(--bw-fs-105)] font-medium uppercase tracking-wide text-muted-foreground">
                What it is
              </div>
              <p className="mt-1 text-[length:var(--bw-fs-12)] leading-relaxed">
                {PRODUCTION_DICTIONARY.grade_mix.dictionary.definition}
              </p>
              <p className="mt-1.5 text-[length:var(--bw-fs-12)] leading-relaxed text-muted-foreground">
                <span className="font-medium text-foreground">
                  Worked out as:{" "}
                </span>
                {PRODUCTION_DICTIONARY.grade_mix.dictionary.basis}
              </p>
              <p className="mt-1.5 text-[length:var(--bw-fs-12)] leading-relaxed text-muted-foreground">
                <span className="font-medium text-foreground">Leaves out: </span>
                {PRODUCTION_DICTIONARY.grade_mix.dictionary.exclusions}
              </p>
            </div>
            <div className="rounded-lg border bg-background/40 px-3 py-2">
              <div className="text-[length:var(--bw-fs-105)] font-medium uppercase tracking-wide text-muted-foreground">
                Year column &amp; the tie
              </div>
              <p className="mt-1 text-[length:var(--bw-fs-12)] leading-relaxed">
                {PRODUCTION_DICTIONARY.grade_mix.dictionary.rollup}
              </p>
              <p className="mt-1.5 text-[length:var(--bw-fs-12)] leading-relaxed text-muted-foreground">
                <span className="font-medium text-foreground">
                  Worth knowing:{" "}
                </span>
                {PRODUCTION_DICTIONARY.grade_mix.dictionary.caveat}
              </p>
              <p className="mt-1.5 font-mono text-[length:var(--bw-fs-10)] text-muted-foreground/80">
                {PRODUCTION_DICTIONARY.grade_mix.dictionary.source}
              </p>
            </div>
          </div>
        )}

        {/* Paper only — the page's own restatement policy, travelling with the
            figure rather than staying behind on the screen. */}
        <p className="hidden text-[length:var(--bw-fs-10)] leading-relaxed text-muted-foreground print:block">
          Figures reflect the underlying records as of {asOfDate ?? "today"};
          nothing is snapshotted, so corrections to past records restate history
          (audited). A blank is never a zero.
        </p>
      </div>
    </section>
  );
}
