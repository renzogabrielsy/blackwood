"use client";

// ─────────────────────────────────────────────────────────────────────────────
// THE PRODUCTION ROOM (P4) — what the plant made, and what it took to make it.
//
// ── WHY IT IS A SECTION HERE AND NOT A BAND AT THE TOP ───────────────────────
// The page reads as one descending axis: PERIOD (the KPI matrix) → CAMPAIGN
// (the batch panel) → SUPPLIER (the room above) → PRODUCTION (here). Each block
// re-keys the same charcoal, and production is where the yard's kilos stop
// being charcoal and start being product — so it belongs after the two blocks
// that are about buying and holding it, not stacked into the volume band above
// them.
//
// It is still ONE `buildMatrix` fold: the six rows below live in the same
// registry as the ten above, go through the same rollup machinery, expand
// through the same panel and — the point — are ranked by the same callout
// strip. `AnalyticsMatrix` simply renders the `production` band here instead of
// at the top.
//
// ── THE ONE THING THIS SECTION IS FREE OF ────────────────────────────────────
// **There is no ₱ anywhere in it, and none is derivable.** Production is the
// one module of the platform with no money in it, so nothing here is gated,
// nothing is nulled server-side, and the whole section — tonnage, grades,
// downtime, power, bags — is live for every role including Production. The
// money that MEETS production lives in the Money band above and is gated there.
//
// ── AND THE THREE FIGURES IT REFUSES TO PRINT PLAINLY ────────────────────────
// A 0.00 downtime hour that is really an unfilled duration, a kWh total
// carrying one mis-keyed reading worth 676,944 units, and a bag count that
// speaks for one run out of thirty-eight. Each carries the row's own ⚠ or ~ and
// its own sentence (`MetricSpec.annotate`), and none of them can be quoted as a
// record or a biggest move. Nothing is corrected here: repairing the meter
// reading is Renzo's call and a separate, audited write.
// ─────────────────────────────────────────────────────────────────────────────

import * as React from "react";
import { Factory } from "lucide-react";
import type { ComparisonMode, Matrix } from "@/lib/analytics/matrix";
import { SECTION_ACCENT } from "@/lib/analytics/metrics";
import type { MetricKey, MetricSection } from "@/lib/analytics/metrics";
import type { Granularity } from "@/lib/analytics/matrix";
import { buildGradeYear, PRODUCTION_DICTIONARY } from "@/lib/analytics/production";
import type {
  AnalyticsMonth,
  ProductionGradeData,
} from "@/lib/analytics/types";
import { AnalyticsMatrix } from "./analytics-matrix";
import { MetricExpand } from "./metric-expand";
import { DictionaryPopover } from "./metric-info";
import { ProductionGrades } from "./production-grades";

/** This section renders exactly one band of the shared matrix. */
const PRODUCTION_BAND: readonly MetricSection[] = ["production"];

function t1(kg: number): string {
  return (kg / 1000).toLocaleString("en-US", {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  });
}

function pct1(v: number | null): string {
  if (v == null) return "—";
  return `${v.toLocaleString("en-US", { minimumFractionDigits: 1, maximumFractionDigits: 1 })}%`;
}

/** One chip. No colour, no threshold — a magnitude and a name. */
function Chip({
  label,
  value,
  sub,
  title,
}: {
  label: string;
  value: string;
  sub?: string;
  title?: string;
}) {
  return (
    <div className="min-w-0 rounded-md border bg-background/40 px-2.5 py-1.5" title={title}>
      <div className="truncate text-[10.5px] font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </div>
      <div className="flex items-baseline gap-1">
        <span className="truncate font-mono text-[15px] font-semibold tabular-nums">
          {value}
        </span>
        {sub && (
          <span className="truncate text-[11px] text-muted-foreground">{sub}</span>
        )}
      </div>
    </div>
  );
}

export interface ProductionRoomProps {
  matrix: Matrix;
  /** P1's own monthly series — where `producedKg` and the year chips come from. */
  months: readonly AnalyticsMonth[];
  grades: ProductionGradeData;
  /** The year the page's own picker is on. The grade mix follows it. */
  year: number;
  granularity: Granularity;
  /** The expanded metric, shared with the matrix at the top of the page. */
  selected: MetricKey | null;
  onSelect(key: MetricKey | null): void;
  perWorkingDay: boolean;
  /** What the second chip under every value shows — the page's own control. */
  comparison: ComparisonMode;
  /** What a printed metric card says the reader was looking at. */
  printScope: string;
  asOfDate: string | null;
}

export function ProductionRoom({
  matrix,
  months,
  grades,
  year,
  granularity,
  selected,
  onSelect,
  perWorkingDay,
  comparison,
  printScope,
  asOfDate,
}: ProductionRoomProps) {
  const gradeYear = React.useMemo(
    () => buildGradeYear(grades.rows, months, year),
    [grades.rows, months, year],
  );

  /** The selected row, but ONLY when it belongs to this band. */
  const expandedRow = React.useMemo(() => {
    if (!selected) return null;
    const row = matrix.rows.find((r) => r.metric.key === selected) ?? null;
    return row && row.metric.section === "production" ? row : null;
  }, [matrix.rows, selected]);

  /**
   * The newest month inside the displayed window — what the expand's side rail
   * describes. Same anchor rule the page's own expand uses.
   */
  const anchorMonth: AnalyticsMonth | null = React.useMemo(() => {
    const inWindow = matrix.periods.flatMap((p) => p.months);
    return inWindow[inWindow.length - 1] ?? months[months.length - 1] ?? null;
  }, [matrix.periods, months]);

  /** The year's own headline figures, straight from the monthly series. */
  const summary = React.useMemo(() => {
    const inYear = months.filter((m) => m.year === year);
    let reportedDays = 0;
    let kwh = 0;
    let suspectReadings = 0;
    let reasonOnly = 0;
    let downtimeRecords = 0;
    let reportedMonths = 0;
    for (const m of inYear) {
      reportedDays += m.reportedDays ?? 0;
      kwh += m.kwh ?? 0;
      suspectReadings += m.kwhSuspectReadingCount ?? 0;
      reasonOnly += m.downtimeShiftsReasonOnly ?? 0;
      downtimeRecords += m.downtimeShiftCount ?? 0;
      if (m.productionReported) reportedMonths += 1;
    }
    return {
      reportedDays,
      kwh,
      suspectReadings,
      reasonOnly,
      downtimeRecords,
      reportedMonths,
    };
  }, [months, year]);

  return (
    <section id="section-production" className="flex scroll-mt-24 flex-col gap-3">
      <header
        className="bw-accent-rule flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 pl-2.5"
        style={
          { "--bw-accent": SECTION_ACCENT.production } as React.CSSProperties
        }
      >
        <div className="min-w-0">
          <h2
            className="text-[13px] font-semibold uppercase tracking-wide"
            style={{ color: SECTION_ACCENT.production }}
          >
            Production
          </h2>
          <p className="text-xs leading-relaxed text-muted-foreground">
            What the plant made in {gradeYear.year}, how long it stood still and
            what it burned doing it. Everything here is measured against
            production&rsquo;s own reported days rather than the yard&rsquo;s
            working days, and there is no ₱ anywhere in this section — it is
            live for every role.
          </p>
        </div>
        <span className="shrink-0 text-[11.5px] text-muted-foreground">
          {summary.reportedMonths} month
          {summary.reportedMonths === 1 ? "" : "s"} reported ·{" "}
          <span className="font-mono">{t1(gradeYear.totalKg)}</span> t
        </span>
      </header>

      {/* ── The year at a glance ──────────────────────────────────────── */}
      <div className="grid grid-cols-2 gap-2 rounded-lg border bg-card p-2 sm:grid-cols-4">
        <Chip
          label="Made"
          value={t1(gradeYear.totalKg)}
          sub="t"
          title={`Everything the plant produced in ${gradeYear.year}, as the Production output row publishes it. The grade table below re-cuts this same figure by product; it is never re-added.`}
        />
        <Chip
          label="Top grade"
          value={pct1(gradeYear.topGradeSharePct)}
          sub={gradeYear.topGrade ?? undefined}
          title={`${gradeYear.topGrade ?? "—"} was ${pct1(gradeYear.topGradeSharePct)} of everything made in ${gradeYear.year}, across ${gradeYear.gradeCount} grade${gradeYear.gradeCount === 1 ? "" : "s"}. A magnitude, not a verdict — nothing on this page turns amber because a share is high.`}
        />
        <Chip
          label="Reported days"
          value={summary.reportedDays.toLocaleString("en-US")}
          sub="days"
          title={`Days production actually reported in ${gradeYear.year}. This is the denominator behind the output-per-day row — deliberately NOT the Working days row above, which counts days the whole SITE did something.`}
        />
        <Chip
          label="Power"
          value={summary.kwh.toLocaleString("en-US", { maximumFractionDigits: 0 })}
          sub={summary.suspectReadings > 0 ? "kWh ⚠" : "kWh"}
          title={
            summary.suspectReadings > 0
              ? `Metered consumption for ${gradeYear.year}, published exactly as recorded — including ${summary.suspectReadings} reading${summary.suspectReadings === 1 ? "" : "s"} we can prove is mis-keyed. Nothing here corrects the underlying record; the power-intensity row is where the broken reading is taken out.`
              : `Metered consumption for ${gradeYear.year}, across every meter.`
          }
        />
      </div>

      <div className="-mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11.5px] text-muted-foreground">
        <Factory className="size-3 shrink-0" aria-hidden />
        <span className="inline-flex items-center gap-1">
          Reported days, not working days
          <DictionaryPopover
            label={PRODUCTION_DICTIONARY.reported_days.label}
            sublabel={PRODUCTION_DICTIONARY.reported_days.sublabel}
            entry={PRODUCTION_DICTIONARY.reported_days.dictionary}
          />
        </span>
        <span className="inline-flex items-center gap-1">
          · Grade mix
          <DictionaryPopover
            label={PRODUCTION_DICTIONARY.grade_mix.label}
            sublabel={PRODUCTION_DICTIONARY.grade_mix.sublabel}
            entry={PRODUCTION_DICTIONARY.grade_mix.dictionary}
          />
        </span>
        {summary.reasonOnly > 0 && (
          <span
            title={`${summary.reasonOnly} of ${gradeYear.year}'s ${summary.downtimeRecords} downtime records named the repair and left the duration at zero. Those hours are missing from the Downtime row, which is why an affected cell is marked and can never be quoted as a record.`}
          >
            · {summary.reasonOnly} downtime record
            {summary.reasonOnly === 1 ? "" : "s"} carry a repair with no
            duration
          </span>
        )}
      </div>

      {/* ── The six rows, in the page's own table language ──────────────
          Rendered by the SAME component as the matrix at the top, from the
          SAME fold — so a production record and a purchase record are judged
          by identical machinery and land in the same callout strip. */}
      <AnalyticsMatrix
        matrix={matrix}
        selected={selected}
        onSelect={onSelect}
        perWorkingDay={perWorkingDay}
        comparison={comparison}
        sections={PRODUCTION_BAND}
        expand={
          expandedRow ? (
            <MetricExpand
              // Keyed by metric — a fresh, all-years-checked year filter per
              // card. Same reason as the matrix at the top of the page.
              key={expandedRow.metric.key}
              row={expandedRow}
              granularity={granularity}
              allPeriods={matrix.allPeriods}
              foldOptions={matrix.foldOptions}
              totalLabel={matrix.totalLabel}
              totalFullLabel={matrix.totalFullLabel}
              anchorMonth={anchorMonth}
              perWorkingDay={perWorkingDay}
              scopeLabel={printScope}
              asOfDate={asOfDate}
              onClose={() => onSelect(null)}
            />
          ) : undefined
        }
      />

      {/* ── The grade mix ────────────────────────────────────────────────
          Follows the YEAR picker and deliberately not the Y/Q/M toggle: a
          product mix is read across a year's months, and a quarter column of
          grades would be a different question. */}
      <ProductionGrades data={gradeYear} truncated={grades.truncated} />
    </section>
  );
}
