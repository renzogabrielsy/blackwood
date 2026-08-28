"use client";

// ─────────────────────────────────────────────────────────────────────────────
// PRODUCTION drill-down — kg produced, broken down by grade.
//
// TWO THINGS THIS BODY IS CAREFUL ABOUT:
//
//   1. THE AS-OF DATE IS IN THE HEADER. Production is filed the morning AFTER
//      (`view_digest_stream_registry.reports_next_day`), which is why the KPI
//      tile carries an `AsOfChip` and reads "yesterday". A modal whose axis
//      simply ends at the operational date would quietly undo that, so the
//      description states the day the figures run through.
//
//   2. SACKS ARE NULLABLE AND NULL IS NOT ZERO. 218 of 324 windowed runs
//      record no sack count at all. "0 bags" is a claim about the bagging line;
//      "not recorded" is a claim about the paperwork. They are different facts,
//      so an absent count renders as "not recorded" and never as a zero.
//
// NO ₱ ANYWHERE — `view_digest_production_grade_daily` carries no price column,
// so this surface needs no gate and is safe for every role.
// ─────────────────────────────────────────────────────────────────────────────

import * as React from "react";
import { fmtKg } from "../format";
import {
  DrilldownChartSkeleton,
  DrilldownModal,
  DrilldownSection,
  DrilldownStat,
} from "./drilldown-modal";
import {
  BreakdownRail,
  TruncatedNotice,
  VolumeSeriesChart,
  asOfNote,
  bucketNoun,
  type RailItem,
} from "./series-parts";
import type { DrilldownModalState } from "./use-drilldown";
import {
  RANGE_LABEL,
  type ProductionDrilldown,
} from "@/lib/digest/drilldown-types";

/** Human-readable shift, matching `digest-charts.tsx`'s grade legend. */
function shiftLabel(shift: string): string {
  switch (shift) {
    case "M":
      return "Morning";
    case "E":
      return "Evening";
    case "N":
      return "Night";
    default:
      return shift;
  }
}

const SACKS_NOT_RECORDED = "sacks not recorded";

export function ProductionDrilldownModal({
  data,
  ...modal
}: DrilldownModalState & { data: ProductionDrilldown | null }) {
  // The sack-coverage caveat is a FOOTNOTE, not a warning: an unrecorded sack
  // count is normal (218 of 324 windowed runs carry none) and nothing is
  // wrong. It is stated so a reader never totals the Sacks column and believes
  // it describes every run. Omitted entirely when coverage is complete.
  const sacksNote =
    data && data.summary.runCount > 0 &&
    data.summary.runsWithSacks < data.summary.runCount
      ? `Sack counts are recorded on ${data.summary.runsWithSacks} of ${data.summary.runCount} runs — a blank is "not recorded", not zero.`
      : null;

  return (
    <DrilldownModal
      {...modal}
      title="Production"
      description={`${RANGE_LABEL[modal.range]} · kg produced, by ${
        modal.range === "ytd" ? "month" : "day"
      }${asOfNote(data?.asOf)}`}
      skeleton={<DrilldownChartSkeleton stats={4} sideRail tableRows={6} />}
      footerLink={{ href: "/production", label: "Open Production" }}
      footerNote={sacksNote}
    >
      {data && <ProductionDrilldownBody data={data} />}
    </DrilldownModal>
  );
}

export function ProductionDrilldownBody({
  data,
}: {
  data: ProductionDrilldown;
}) {
  const { summary, granularity } = data;
  const noun = bucketNoun(granularity);

  const railItems = React.useMemo<RailItem[]>(
    () =>
      data.grades.map((g) => ({
        key: g.grade,
        label: g.grade,
        meta: `${g.runs} run${g.runs === 1 ? "" : "s"}`,
        value: fmtKg(g.kg),
        unit: "kg",
        sharePct: g.sharePct,
        title: [
          g.grade,
          `${g.runs} run${g.runs === 1 ? "" : "s"}`,
          // NULL sacks is stated in words. A grade whose runs recorded SOME
          // counts says how many of them did, so a partial total is never read
          // as a complete one.
          g.sacks == null
            ? SACKS_NOT_RECORDED
            : `${g.sacks.toLocaleString("en-US")} sacks over ${g.runsWithSacks} of ${g.runs} runs`,
        ].join(" · "),
      })),
    [data.grades]
  );

  const sacksSub =
    summary.sacks == null
      ? SACKS_NOT_RECORDED
      : `${summary.sacks.toLocaleString("en-US")} sacks`;

  return (
    <div className="flex flex-col gap-4">
      {data.truncated && <TruncatedNotice noun="runs" module="Production" />}

      {/* ── Summary strip ── */}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <DrilldownStat
          label="Total produced"
          value={fmtKg(summary.total)}
          unit="kg"
          sub={`${summary.runCount.toLocaleString("en-US")} run${
            summary.runCount === 1 ? "" : "s"
          }`}
        />
        <DrilldownStat
          label={`Avg per active ${noun}`}
          value={
            summary.avgPerActiveBucket == null
              ? "—"
              : fmtKg(summary.avgPerActiveBucket)
          }
          unit={summary.avgPerActiveBucket == null ? undefined : "kg"}
          sub={`over ${summary.activeBuckets} ${noun}${
            summary.activeBuckets === 1 ? "" : "s"
          } with output`}
          title={`Mean of the ${noun}s the plant actually produced on — ${noun}s with no run are excluded.`}
        />
        <DrilldownStat
          label={`Peak ${noun}`}
          value={summary.peak ? fmtKg(summary.peak.value) : "—"}
          unit={summary.peak ? "kg" : undefined}
          sub={summary.peak ? summary.peak.bucket : "no output in range"}
        />
        <DrilldownStat
          label="Grades"
          value={summary.gradeCount.toLocaleString("en-US")}
          sub={sacksSub}
          tone={summary.sacks == null ? "muted" : "default"}
          title={
            summary.sacks == null
              ? "No run in this window recorded a sack count. That is a gap in the report, not a zero."
              : `${summary.runsWithSacks} of ${summary.runCount} runs recorded a sack count.`
          }
        />
      </div>

      {/* ── Chart + grade rail ── */}
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-[1fr_280px]">
        <DrilldownSection
          title="Produced"
          subtitle={`by ${noun} · kg`}
          bodyClassName="p-2 pb-1"
        >
          <VolumeSeriesChart
            data={data.series}
            granularity={granularity}
            valueName="Produced"
            fmt={fmtKg}
            unit="kg"
            // chart-1 is the base hue of the digest's Production-by-grade
            // stacked bars — the expanded chart keeps the family.
            color="var(--chart-1)"
            // The mean line must contrast with chart-1 in BOTH themes:
            // chart-4 (yellow in light) all but vanishes over orange bars.
            avgColor="var(--chart-3)"
          />
        </DrilldownSection>

        <DrilldownSection
          title="By grade"
          subtitle={`${data.grades.length} in range`}
          bodyClassName="p-0"
        >
          <BreakdownRail
            items={railItems}
            emptyText="No production in this window."
            color="var(--chart-1)"
          />
        </DrilldownSection>
      </div>

      {/* ── Recent underlying rows (Excel Standard density) ── */}
      <DrilldownSection
        title="Recent runs"
        subtitle={`latest ${data.recent.length}`}
        bodyClassName="p-0"
      >
        {data.recent.length === 0 ? (
          <p className="px-3 py-6 text-center text-xs text-muted-foreground">
            No production in this window.
          </p>
        ) : (
          // "Never crush, always scroll": min-width = the 380px of fixed
          // columns + a 140px floor for the flexible Grade column.
          <div className="overflow-x-auto">
            <table className="w-full min-w-[520px] table-fixed text-xs">
              <colgroup>
                <col className="w-[110px]" />
                <col className="w-[70px]" />
                <col />
                <col className="w-[110px]" />
                <col className="w-[90px]" />
              </colgroup>
              <thead>
                <tr className="border-b bg-muted/60 text-[10.5px] uppercase tracking-wide text-muted-foreground">
                  <th className="px-2 py-1 text-left font-medium">Date</th>
                  <th className="px-2 py-1 text-left font-medium">Shift</th>
                  <th className="px-2 py-1 text-left font-medium">Grade</th>
                  <th className="px-2 py-1 text-right font-medium">Weight</th>
                  <th className="px-2 py-1 text-right font-medium">Sacks</th>
                </tr>
              </thead>
              <tbody>
                {data.recent.map((r) => (
                  <tr
                    key={r.id}
                    className="h-8 border-b transition-all duration-150 last:border-0 hover:bg-muted/40"
                  >
                    <td className="truncate px-2 py-1 font-mono tabular-nums">
                      {r.date}
                    </td>
                    <td
                      className="truncate px-2 py-1 font-mono"
                      title={r.shift ? shiftLabel(r.shift) : undefined}
                    >
                      {r.shift ?? "—"}
                    </td>
                    <td className="truncate px-2 py-1" title={r.grade}>
                      {r.grade}
                    </td>
                    <td className="px-2 py-1 text-right font-mono tabular-nums">
                      {fmtKg(r.kg)}
                    </td>
                    {/* NULL ≠ 0 — an em dash with the reason on hover, never a
                        fabricated "0 bags". */}
                    <td
                      className="px-2 py-1 text-right font-mono tabular-nums"
                      title={
                        r.sacks == null
                          ? "Sacks not recorded for this run"
                          : undefined
                      }
                    >
                      {r.sacks == null ? (
                        <span className="text-muted-foreground">—</span>
                      ) : (
                        r.sacks.toLocaleString("en-US")
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </DrilldownSection>
    </div>
  );
}
