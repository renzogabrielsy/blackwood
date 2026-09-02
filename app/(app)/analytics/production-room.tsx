"use client";

// ─────────────────────────────────────────────────────────────────────────────
// THE PRODUCTION ROOM — what the plant made, and what it took to make it.
//
// ── OWNER FEEDBACK R6 (2026-09-02): THE BAND READS PRODUCTION BATCHES ────────
// Its columns were calendar months until R6. They are now CAMPAIGNS — the same
// columns, in the same order, filtered by the same `?bhide=` checklist, as the
// By production batch panel directly above it.
//
// **The reason is a TIE, not a preference.** The Yield row here is literally
// `view_rc_movement_campaign_yield.yield_pct` — the very column that panel's
// own Yield row reads — carried through `view_analytics_production_by_batch`.
// So the two tables cannot disagree. On the calendar clock they agreed only by
// coincidence and drifted whenever a batch straddled a month boundary, which is
// most of them: AUGUST closed and SEPTEMBER opened on 2026-08-29.
//
// R5's month-mapping machinery is retired with it. A column IS a batch now, so
// the checklist drives this band DIRECTLY — no `selectedCampaignMonths`, no
// "a month overlapping a selected and an unselected batch is shown whole"
// caveat, because no such month exists any more.
//
// ── WHAT IS EXACT AND WHAT IS MAPPED ────────────────────────────────────────
// Tonnage, runs, shifts, reported days, downtime and bags are EXACT: every one
// of those records already carries its own batch tag. ELECTRICITY is the one
// MAPPED figure — meter readings carry a date and no batch, so a day's power
// goes to the batch that had most recently STARTED. The room says so where a
// reader meets it, not only in a context file.
//
// ── THE ONE THING THIS SECTION IS FREE OF ────────────────────────────────────
// **There is no ₱ anywhere in it, and none is derivable.** Production is the
// one module of the platform with no money in it, so nothing here is gated,
// nothing is nulled server-side, and the whole section is live for every role
// including Production. The money that MEETS a campaign lives on the panel
// above and is gated there.
//
// ── AND THE THREE FIGURES IT REFUSES TO PRINT PLAINLY ────────────────────────
// A 0.00 downtime hour that is really an unfilled duration (AUGUST 2026: 22 of
// 22 shifts), a kWh total carrying one mis-keyed reading worth 676,944 units
// (MARCH 2026), and a bag count that speaks for a fraction of its runs. Each
// carries the row's own ⚠ or ~ and its own sentence, and none can be quoted as
// a record. Nothing is corrected here: repairing the meter reading is Renzo's
// call and a separate, audited write.
// ─────────────────────────────────────────────────────────────────────────────

import * as React from "react";
import { Boxes, Factory } from "lucide-react";
import type { ComparisonMode, Matrix, MatrixRow } from "@/lib/analytics/matrix";
import { SECTION_ACCENT } from "@/lib/analytics/metrics";
import type { MetricKey, MetricSection } from "@/lib/analytics/metrics";
import { BATCH_GRANULARITY } from "@/lib/analytics/production-batch";
import { buildGradeSet, PRODUCTION_DICTIONARY } from "@/lib/analytics/production";
import type {
  ProductionBatchRow,
  ProductionGradeData,
} from "@/lib/analytics/types";
import { AnalyticsMatrix } from "./analytics-matrix";
import { BatchSideRail, MetricExpand } from "./metric-expand";
import { DictionaryPopover } from "./metric-info";
import { ProductionGrades } from "./production-grades";
import { GroupPrintPage, GroupPrintStage } from "./group-print";
import { UnitValue } from "./unit-value";

/** This section renders exactly one band of the batch matrix. */
const PRODUCTION_BAND: readonly MetricSection[] = ["production"];

function t1(kg: number): string {
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

/**
 * One chip. No colour, no threshold — a magnitude and a name.
 *
 * R6: the unit sits on the LEFT here too, so a chip and the table under it
 * announce a unit in the same place.
 */
function Chip({
  label,
  value,
  unit,
  note,
  title,
}: {
  label: string;
  value: string;
  unit: string;
  note?: string;
  title?: string;
}) {
  return (
    <div className="min-w-0 rounded-md border bg-background/40 px-2.5 py-1.5" title={title}>
      <div className="truncate text-[length:var(--bw-fs-105)] font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </div>
      <UnitValue
        glyph={unit}
        className="font-mono text-[length:var(--bw-fs-15)] tabular-nums"
        valueClassName="font-semibold"
        after={
          note ? (
            <span className="shrink-0 text-[length:var(--bw-fs-11)] text-muted-foreground">
              {note}
            </span>
          ) : undefined
        }
      >
        {value}
      </UnitValue>
    </div>
  );
}

export interface ProductionRoomProps {
  /** The BATCH-clock fold — campaigns as columns. */
  matrix: Matrix<ProductionBatchRow>;
  /** Every campaign's plant figures, in the panel's own chronological order. */
  batches: readonly ProductionBatchRow[];
  grades: ProductionGradeData;
  /** The expanded metric, shared with the matrix at the top of the page. */
  selected: MetricKey | null;
  onSelect(key: MetricKey | null): void;
  /** What the second chip under every value shows — the page's own control. */
  comparison: ComparisonMode;
  /** What a printed metric card says the reader was looking at. */
  printScope: string;
  asOfDate: string | null;
  /**
   * R3 — the page's master `Definitions` switch, passed straight through. This
   * room mounts its OWN `MetricExpand` (a production row's panel has to open
   * under the production band, not under the matrix at the top), so the switch
   * has to reach it here or half the page's expands would ignore it.
   */
  showDictionary: boolean;
  /**
   * R6 — the switched-OFF campaign keys, straight from `?bhide=`. THE SAME set
   * the campaign panel uses, applied to the same keys: one control, three
   * consumers, no mapping.
   */
  hiddenCampaigns: ReadonlySet<string>;
}

export function ProductionRoom({
  matrix,
  batches,
  grades,
  selected,
  onSelect,
  comparison,
  printScope,
  asOfDate,
  showDictionary,
  hiddenCampaigns,
}: ProductionRoomProps) {
  const gradeSet = React.useMemo(
    () => buildGradeSet(grades.rows, batches, hiddenCampaigns),
    [grades.rows, batches, hiddenCampaigns],
  );

  /** R5 — the band's group report, mounted only while it is being printed. */
  const [printKeys, setPrintKeys] = React.useState<readonly MetricKey[] | null>(
    null,
  );
  const startPrint = React.useCallback(
    (_section: MetricSection, keys: readonly MetricKey[]) => setPrintKeys(keys),
    [],
  );
  const endPrint = React.useCallback(() => setPrintKeys(null), []);
  const printRows = React.useMemo(() => {
    if (!printKeys) return [];
    const byKey = new Map(matrix.rows.map((r) => [r.metric.key, r] as const));
    return printKeys
      .map((k) => byKey.get(k))
      .filter((r): r is MatrixRow<ProductionBatchRow> => r != null);
  }, [printKeys, matrix.rows]);

  /** The selected row, but ONLY when it belongs to this band. */
  const expandedRow = React.useMemo(
    () => matrix.rows.find((r) => r.metric.key === selected) ?? null,
    [matrix.rows, selected],
  );

  /**
   * The newest campaign inside the displayed window — what the expand's side
   * rail describes. Same anchor rule the page's own expand uses, one clock over.
   */
  const anchorBatch: ProductionBatchRow | null = React.useMemo(() => {
    const shown = matrix.periods.flatMap((p) => p.months);
    return shown[shown.length - 1] ?? batches[batches.length - 1] ?? null;
  }, [matrix.periods, batches]);

  /**
   * The headline figures, over the campaigns actually on screen — so the chips
   * describe the same window the table under them does. A chip quietly reading
   * every batch beside a filtered grid would be the page disagreeing with
   * itself.
   *
   * `kwhUnmappedPreCampaign` is carried on every row (it is the same plant-wide
   * figure everywhere) so it is READ rather than summed — adding it up across
   * campaigns would multiply one hole by the number of columns.
   */
  const summary = React.useMemo(() => {
    const shown = batches.filter((b) => !hiddenCampaigns.has(b.campaignLabel));
    let producedKg = 0;
    let reportedDays = 0;
    let kwh = 0;
    let suspectReadings = 0;
    let reasonOnly = 0;
    let downtimeRecords = 0;
    let reportedBatches = 0;
    for (const b of shown) {
      producedKg += b.producedKg ?? 0;
      reportedDays += b.reportedDays ?? 0;
      kwh += b.kwh ?? 0;
      suspectReadings += b.kwhSuspectReadingCount ?? 0;
      reasonOnly += b.downtimeShiftsReasonOnly ?? 0;
      downtimeRecords += b.downtimeShiftCount ?? 0;
      if (b.productionReported) reportedBatches += 1;
    }
    return {
      shownCount: shown.length,
      producedKg,
      reportedDays,
      kwh,
      suspectReadings,
      reasonOnly,
      downtimeRecords,
      reportedBatches,
      unmappedKwh: batches[0]?.kwhUnmappedPreCampaign ?? null,
    };
  }, [batches, hiddenCampaigns]);

  const filtered = hiddenCampaigns.size > 0;

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
            className="text-[length:var(--bw-fs-13)] font-semibold uppercase tracking-wide"
            style={{ color: SECTION_ACCENT.production }}
          >
            Production
          </h2>
          <p className="text-[length:var(--bw-fs-12)] leading-relaxed text-muted-foreground">
            What the plant made, how long it stood still and what it burned
            doing it — read <strong className="font-medium text-foreground">
            per production batch</strong>, the same columns as the panel above.
            Everything here is measured against production&rsquo;s own reported
            days rather than the yard&rsquo;s working days, and there is no ₱
            anywhere in this section — it is live for every role.
          </p>
          {/* ── R6 — THE CLARIFICATION, AT THE POINT OF USE ────────────────
              R5 put a note here saying this band was the one place the CALENDAR
              clock was still right. R6 supersedes it, and the replacement says
              the two things a reader of a batch column is owed: why the columns
              are batches at all, and which single figure on the band is mapped
              rather than tagged. */}
          <p className="mt-1 flex items-start gap-1.5 text-[length:var(--bw-fs-115)] leading-relaxed text-muted-foreground">
            <Boxes className="mt-0.5 size-3 shrink-0" aria-hidden />
            <span>
              <strong className="font-medium text-foreground">
                A column is a production batch, not a month.
              </strong>{" "}
              A batch runs across month boundaries and a changeover day carries
              two of them — AUGUST closed and SEPTEMBER opened on the same day —
              so this is the clock the plant actually works to, and the{" "}
              <strong className="font-medium text-foreground">Yield</strong> row
              here is the same column the{" "}
              <a
                href="#section-campaigns"
                className="underline underline-offset-2 hover:text-foreground"
              >
                By production batch
              </a>{" "}
              panel prints, so the two cannot disagree. Tonnage, downtime, days
              and bags are grouped by a batch tag the records already carry;{" "}
              <strong className="font-medium text-foreground">
                electricity is the one mapped figure
              </strong>{" "}
              — meters record a date and no batch, so a day&rsquo;s power goes
              to the batch that had most recently started.
              {filtered ? (
                <>
                  {" "}
                  <strong className="font-medium text-foreground">
                    Filtered to {summary.shownCount} of {batches.length} batches
                  </strong>{" "}
                  by the <span className="font-medium text-foreground">
                  Batches</span> filter on that panel — one control, both tables.
                </>
              ) : (
                <>
                  {" "}
                  Use the{" "}
                  <span className="font-medium text-foreground">Batches</span>{" "}
                  filter on that panel to narrow this band; it drives both.
                </>
              )}
            </span>
          </p>
        </div>
        <span className="shrink-0 text-[length:var(--bw-fs-115)] text-muted-foreground">
          {summary.reportedBatches} batch
          {summary.reportedBatches === 1 ? "" : "es"} reported ·{" "}
          <span className="font-mono">{t1(summary.producedKg)}</span> t
        </span>
      </header>

      {/* ── The selection at a glance ─────────────────────────────────── */}
      <div className="grid grid-cols-2 gap-2 rounded-lg border bg-card p-2 sm:grid-cols-4">
        <Chip
          label="Made"
          value={t1(summary.producedKg)}
          unit="T"
          title={`Everything the plant produced across the ${summary.shownCount} batch${summary.shownCount === 1 ? "" : "es"} shown, as the Production output row publishes it. The grade table below re-cuts this same figure by product; it is never re-added.`}
        />
        <Chip
          label="Top grade"
          value={pct1(gradeSet.topGradeSharePct)}
          unit="%"
          note={gradeSet.topGrade ?? undefined}
          title={`${gradeSet.topGrade ?? "—"} was ${pct1(gradeSet.topGradeSharePct)}% of everything made across the batches shown, out of ${gradeSet.gradeCount} grade${gradeSet.gradeCount === 1 ? "" : "s"}. A magnitude, not a verdict — nothing on this page turns amber because a share is high.`}
        />
        <Chip
          label="Reported days"
          value={summary.reportedDays.toLocaleString("en-US")}
          unit="d"
          title={`Days production actually reported across the batches shown. This is the denominator behind the output-per-day row — deliberately NOT the yard's working days. A changeover day belongs to two batches and both really did run it, so these counts add to slightly more than the calendar: 221 batch-days across 214 dates.`}
        />
        <Chip
          label="Power"
          value={summary.kwh.toLocaleString("en-US", { maximumFractionDigits: 0 })}
          unit="kWh"
          note={summary.suspectReadings > 0 ? "⚠" : undefined}
          title={
            (summary.suspectReadings > 0
              ? `Metered consumption for the batches shown, published exactly as recorded — including ${summary.suspectReadings} reading${summary.suspectReadings === 1 ? "" : "s"} we can prove is mis-keyed. Nothing here corrects the underlying record; the power-intensity row is where the broken reading is taken out. `
              : "Metered consumption for the batches shown, across every meter. ") +
            (summary.unmappedKwh
              ? `A further ${summary.unmappedKwh.toLocaleString("en-US", { maximumFractionDigits: 0 })} kWh was metered before the first batch was reported and belongs to no batch on this clock — it is not lost, it is readable by month in the calendar production view.`
              : "")
          }
        />
      </div>

      <div className="-mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[length:var(--bw-fs-115)] text-muted-foreground">
        <Factory className="size-3 shrink-0" aria-hidden />
        <span className="inline-flex items-center gap-1">
          The batch clock
          <DictionaryPopover
            label={PRODUCTION_DICTIONARY.batch_clock.label}
            sublabel={PRODUCTION_DICTIONARY.batch_clock.sublabel}
            entry={PRODUCTION_DICTIONARY.batch_clock.dictionary}
          />
        </span>
        <span className="inline-flex items-center gap-1">
          · Reported days, not working days
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
            title={`${summary.reasonOnly} of the ${summary.downtimeRecords} downtime records in the batches shown named the repair and left the duration at zero. Those hours are missing from the Downtime row, which is why an affected cell is marked and can never be quoted as a record.`}
          >
            · {summary.reasonOnly} downtime record
            {summary.reasonOnly === 1 ? "" : "s"} carry a repair with no duration
          </span>
        )}
        {summary.unmappedKwh != null && summary.unmappedKwh > 0 && (
          <span
            title="The meters ran for 192 days before the first batch was reported. That electricity belongs to no batch on this clock, so it appears in no column — it is not lost, and the totals reconcile exactly against the calendar production view."
          >
            ·{" "}
            {summary.unmappedKwh.toLocaleString("en-US", {
              maximumFractionDigits: 0,
            })}{" "}
            kWh predates the first batch
          </span>
        )}
      </div>

      {/* ── The eight rows, in the page's own table language ────────────
          Rendered by the SAME component as the matrix at the top, through the
          SAME fold machinery — so a production record and a purchase record are
          judged by identical rules, on their own clocks. */}
      <AnalyticsMatrix
        matrix={matrix}
        selected={selected}
        onSelect={onSelect}
        perWorkingDay={false}
        comparison={comparison}
        sections={PRODUCTION_BAND}
        onPrintSection={startPrint}
        printingSection={printKeys ? "production" : null}
        expand={
          expandedRow ? (
            <MetricExpand
              // Keyed by metric — a fresh, all-batches-checked filter per card.
              // Same reason as the matrix at the top of the page.
              key={expandedRow.metric.key}
              row={expandedRow}
              granularity={BATCH_GRANULARITY}
              allPeriods={matrix.allPeriods}
              foldOptions={matrix.foldOptions}
              rules={matrix.rules}
              totalLabel={matrix.totalLabel}
              totalFullLabel={matrix.totalFullLabel}
              sideRail={
                <BatchSideRail spec={expandedRow.metric} batch={anchorBatch} />
              }
              perWorkingDay={false}
              scopeLabel={printScope}
              asOfDate={asOfDate}
              showDictionary={showDictionary}
              onClose={() => onSelect(null)}
            />
          ) : undefined
        }
      />

      {/* ── The grade mix ──────────────────────────────────────────────
          Same columns as the band above it, driven by the same checklist. */}
      <ProductionGrades
        data={gradeSet}
        truncated={grades.truncated}
        showDictionary={showDictionary}
        scopeLabel={printScope}
        asOfDate={asOfDate}
      />

      {/* R5 — the production band's group report, while it is printing. */}
      {printKeys && printRows.length > 0 && (
        <GroupPrintStage
          title="Production"
          subtitle={`${
            filtered
              ? `${summary.shownCount} of ${batches.length} production batches`
              : `all ${batches.length} production batches`
          }${asOfDate ? ` · records through ${asOfDate}` : ""}`}
          countLabel={`${printRows.length} metric${printRows.length === 1 ? "" : "s"}`}
          onDone={endPrint}
        >
          {printRows.map((r) => (
            <GroupPrintPage key={r.metric.key}>
              <MetricExpand
                row={r}
                granularity={BATCH_GRANULARITY}
                allPeriods={matrix.allPeriods}
                foldOptions={matrix.foldOptions}
                rules={matrix.rules}
                totalLabel={matrix.totalLabel}
                totalFullLabel={matrix.totalFullLabel}
                sideRail={<BatchSideRail spec={r.metric} batch={anchorBatch} />}
                perWorkingDay={false}
                scopeLabel={printScope}
                asOfDate={asOfDate}
                showDictionary={showDictionary}
                onClose={endPrint}
              />
            </GroupPrintPage>
          ))}
        </GroupPrintStage>
      )}
    </section>
  );
}
