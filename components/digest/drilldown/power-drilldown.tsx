"use client";

// ─────────────────────────────────────────────────────────────────────────────
// POWER drill-down — kWh consumed, broken down by meter.
//
// TWO THINGS THIS BODY IS CAREFUL ABOUT:
//
//   1. THE AS-OF DATE IS IN THE HEADER. Electricity is filed the morning AFTER
//      (`reports_next_day`), the same as production and RC OUT, so the modal
//      states the day its figures run through rather than letting the axis end
//      at the operational date and read as "today".
//
//   2. A ONE-BAR RAIL IS CORRECT DATA, NOT AN EMPTY STATE. BUNKHOUSE and PUMP
//      were last reported 2025-12-12, so a 30d or 90d window legitimately
//      contains MAIN alone. It renders plainly — no apology, no "only one
//      meter?" empty state — and the subtitle simply counts what reported.
//
// The series is `sum(consumption_kwh)`, the exact column the POWER KPI tile
// sums, so the modal total always equals the tile. No ₱ anywhere.
// ─────────────────────────────────────────────────────────────────────────────

import * as React from "react";
import { fmtKwh } from "../format";
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
  type PowerDrilldown,
} from "@/lib/digest/drilldown-types";

export function PowerDrilldownModal({
  data,
  ...modal
}: DrilldownModalState & { data: PowerDrilldown | null }) {
  return (
    <DrilldownModal
      {...modal}
      title="Power"
      description={`${RANGE_LABEL[modal.range]} · kWh consumed, by ${
        modal.range === "ytd" ? "month" : "day"
      }${asOfNote(data?.asOf)}`}
      skeleton={<DrilldownChartSkeleton stats={4} sideRail tableRows={6} />}
      footerLink={{ href: "/production/electricity", label: "Open Electricity" }}
    >
      {data && <PowerDrilldownBody data={data} />}
    </DrilldownModal>
  );
}

export function PowerDrilldownBody({ data }: { data: PowerDrilldown }) {
  const { summary, granularity } = data;
  const noun = bucketNoun(granularity);

  const railItems = React.useMemo<RailItem[]>(
    () =>
      data.meters.map((m) => ({
        key: m.meter,
        label: m.meter,
        meta: `${m.readings} reading${m.readings === 1 ? "" : "s"}`,
        value: fmtKwh(m.kwh),
        unit: "kWh",
        sharePct: m.sharePct,
        title: `${m.meter} · ${fmtKwh(m.kwh)} kWh over ${m.readings} reading${
          m.readings === 1 ? "" : "s"
        }`,
      })),
    [data.meters]
  );

  return (
    <div className="flex flex-col gap-4">
      {data.truncated && <TruncatedNotice noun="readings" module="Electricity" />}

      {/* ── Summary strip ── */}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <DrilldownStat
          label="Total consumed"
          value={fmtKwh(summary.total)}
          unit="kWh"
          sub={`${summary.readingCount.toLocaleString("en-US")} reading${
            summary.readingCount === 1 ? "" : "s"
          }`}
        />
        <DrilldownStat
          label={`Avg per active ${noun}`}
          value={
            summary.avgPerActiveBucket == null
              ? "—"
              : fmtKwh(summary.avgPerActiveBucket)
          }
          unit={summary.avgPerActiveBucket == null ? undefined : "kWh"}
          sub={`over ${summary.activeBuckets} ${noun}${
            summary.activeBuckets === 1 ? "" : "s"
          } with a reading`}
          title={`Mean of the ${noun}s that carried a meter reading — ${noun}s with none are excluded.`}
        />
        <DrilldownStat
          label={`Peak ${noun}`}
          value={summary.peak ? fmtKwh(summary.peak.value) : "—"}
          unit={summary.peak ? "kWh" : undefined}
          sub={summary.peak ? summary.peak.bucket : "no readings in range"}
        />
        {/* A count of 1 is a real answer here — see the header. */}
        <DrilldownStat
          label="Meters"
          value={summary.meterCount.toLocaleString("en-US")}
          sub="reported in this window"
          title="Only the meters that actually reported inside this window are counted. BUNKHOUSE and PUMP last reported 2025-12-12, so a short window normally shows MAIN alone."
        />
      </div>

      {/* ── Chart + meter rail ── */}
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-[1fr_280px]">
        <DrilldownSection
          title="Consumed"
          subtitle={`by ${noun} · kWh`}
          bodyClassName="p-2 pb-1"
        >
          <VolumeSeriesChart
            data={data.series}
            granularity={granularity}
            valueName="Consumed"
            fmt={fmtKwh}
            unit="kWh"
            color="var(--chart-3)"
          />
        </DrilldownSection>

        <DrilldownSection
          title="By meter"
          subtitle={`${data.meters.length} reported`}
          bodyClassName="p-0"
        >
          <BreakdownRail
            items={railItems}
            emptyText="No meter readings in this window."
            color="var(--chart-3)"
          />
        </DrilldownSection>
      </div>

      {/* ── Recent underlying rows (Excel Standard density) ── */}
      <DrilldownSection
        title="Recent readings"
        subtitle={`latest ${data.recent.length}`}
        bodyClassName="p-0"
      >
        {data.recent.length === 0 ? (
          <p className="px-3 py-6 text-center text-xs text-muted-foreground">
            No meter readings in this window.
          </p>
        ) : (
          // "Never crush, always scroll": min-width = 240px of fixed columns +
          // a 160px floor for the flexible Meter column.
          <div className="overflow-x-auto">
            <table className="w-full min-w-[400px] table-fixed text-xs">
              <colgroup>
                <col className="w-[110px]" />
                <col />
                <col className="w-[130px]" />
              </colgroup>
              <thead>
                <tr className="border-b bg-muted/60 text-[10.5px] uppercase tracking-wide text-muted-foreground">
                  <th className="px-2 py-1 text-left font-medium">Date</th>
                  <th className="px-2 py-1 text-left font-medium">Meter</th>
                  <th className="px-2 py-1 text-right font-medium">kWh</th>
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
                    <td className="truncate px-2 py-1" title={r.meter}>
                      {r.meter}
                    </td>
                    {/* consumption_kwh is nullable — a missing consumption is
                        an em dash, never a fabricated 0 kWh. */}
                    <td
                      className="px-2 py-1 text-right font-mono tabular-nums"
                      title={
                        r.kwh == null
                          ? "Consumption not recorded for this reading"
                          : undefined
                      }
                    >
                      {r.kwh == null ? (
                        <span className="text-muted-foreground">—</span>
                      ) : (
                        fmtKwh(r.kwh)
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
