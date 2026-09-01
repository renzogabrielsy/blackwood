"use client";

// ─────────────────────────────────────────────────────────────────────────────
// RC IN drill-down — the FIRST body built on the chassis, and the reference for
// the universal feature set every other tile should inherit:
//
//   range toggle · big chart (bars + rolling average) · summary stat strip ·
//   one breakdown dimension · the last few underlying rows · a link out.
//
// NO ₱ ANYWHERE. `getRcInDrilldown` never selects `cost_basis`, so this surface
// has no price to gate — deliberate, and the reason the RC IN modal is safe for
// every role including Production.
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
  bucketNoun,
  type RailItem,
} from "./series-parts";
import type { DrilldownModalState } from "./use-drilldown";
import {
  RANGE_LABEL,
  type RcInDrilldown,
  type VolumePoint,
} from "@/lib/digest/drilldown-types";

/**
 * The wired modal — the ONE thing a caller mounts. Spread a
 * `useDrilldown(getRcInDrilldown)` controller's `modalProps` onto it and pass
 * its `data`; everything else (title, skeleton shape, footer link) is fixed
 * here so no call site can drift.
 */
export function RcInDrilldownModal({
  data,
  ...modal
}: DrilldownModalState & { data: RcInDrilldown | null }) {
  return (
    <DrilldownModal
      {...modal}
      // Short enough to survive a 375px header beside the range toggle — the
      // window and the unit live in the description, which has a full row.
      title="RC In"
      description={`${RANGE_LABEL[modal.range]} · kg received, by ${
        modal.range === "ytd" ? "month" : "day"
      }`}
      skeleton={<DrilldownChartSkeleton stats={4} sideRail tableRows={6} />}
      footerLink={[
        { href: "/inventory/rc-in", label: "Open RC IN" },
        { href: "/analytics?metric=purchase_volume", label: "Full analytics" },
      ]}
    >
      {data && <RcInDrilldownBody data={data} />}
    </DrilldownModal>
  );
}

export function RcInDrilldownBody({ data }: { data: RcInDrilldown }) {
  const { summary, granularity } = data;
  const noun = bucketNoun(granularity);

  // `RcInPoint.kg` predates the shared `VolumePoint.value` contract and is not
  // renamed: this payload is stable and five other fields read `kg`. Mapping is
  // the cheap side of the trade — the CHART then has one definition instead of
  // four near-copies.
  const chartSeries = React.useMemo<VolumePoint[]>(
    () =>
      data.series.map((p) => ({
        bucket: p.bucket,
        label: p.label,
        value: p.kg,
        avg: p.avg,
      })),
    [data.series]
  );

  const railItems = React.useMemo<RailItem[]>(
    () =>
      data.suppliers.map((s) => ({
        key: s.supplier,
        label: s.supplier,
        value: fmtKg(s.kg),
        unit: "kg",
        sharePct: s.sharePct,
        title: `${s.supplier} · ${s.deliveries} deliveries · ${s.sacks.toLocaleString(
          "en-US"
        )} sacks`,
      })),
    [data.suppliers]
  );

  return (
    <div className="flex flex-col gap-4">
      {data.truncated && (
        <TruncatedNotice noun="deliveries" module="RC IN" />
      )}

      {/* ── Summary strip ── */}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <DrilldownStat
          label="Total received"
          value={fmtKg(summary.totalKg)}
          unit="kg"
          sub={`${summary.deliveryCount.toLocaleString("en-US")} deliver${
            summary.deliveryCount === 1 ? "y" : "ies"
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
          } with a delivery`}
          title={`Mean of the ${noun}s that actually received charcoal — ${noun}s with no delivery are excluded.`}
        />
        <DrilldownStat
          label={`Peak ${noun}`}
          value={summary.peak ? fmtKg(summary.peak.kg) : "—"}
          unit={summary.peak ? "kg" : undefined}
          sub={summary.peak ? summary.peak.bucket : "no deliveries in range"}
        />
        {/* The window itself lives in the modal description, so it is NOT
            repeated here — at 375px it truncated into meaninglessness. */}
        <DrilldownStat
          label="Suppliers"
          value={summary.supplierCount.toLocaleString("en-US")}
          sub="delivered in this window"
        />
      </div>

      {/* ── Chart + supplier rail ── */}
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-[1fr_280px]">
        <DrilldownSection
          title="Received"
          subtitle={`by ${noun} · kg`}
          bodyClassName="p-2 pb-1"
        >
          <VolumeSeriesChart
            data={chartSeries}
            granularity={granularity}
            valueName="Received"
            fmt={fmtKg}
            unit="kg"
          />
        </DrilldownSection>

        <DrilldownSection
          title="By supplier"
          subtitle={`${data.suppliers.length} in range`}
          bodyClassName="p-0"
        >
          <BreakdownRail
            items={railItems}
            emptyText="No deliveries in this window."
          />
        </DrilldownSection>
      </div>

      {/* ── Recent underlying rows (Excel Standard density) ── */}
      <DrilldownSection
        title="Recent deliveries"
        subtitle={`latest ${data.recent.length}`}
        bodyClassName="p-0"
      >
        {data.recent.length === 0 ? (
          <p className="px-3 py-6 text-center text-xs text-muted-foreground">
            No deliveries in this window.
          </p>
        ) : (
          // "Never crush, always scroll": explicit min-width = the 410px of
          // fixed columns + a 180px floor for the flexible Supplier column,
          // which is the one column that would otherwise crush.
          <div className="overflow-x-auto">
            <table className="w-full min-w-[590px] table-fixed text-xs">
              <colgroup>
                <col className="w-[110px]" />
                <col />
                <col className="w-[110px]" />
                <col className="w-[80px]" />
                <col className="w-[110px]" />
              </colgroup>
              <thead>
                <tr className="border-b bg-muted/60 text-[10.5px] uppercase tracking-wide text-muted-foreground">
                  <th className="px-2 py-1 text-left font-medium">Date</th>
                  <th className="px-2 py-1 text-left font-medium">Supplier</th>
                  <th className="px-2 py-1 text-left font-medium">Truck</th>
                  <th className="px-2 py-1 text-right font-medium">Sacks</th>
                  <th className="px-2 py-1 text-right font-medium">Weight</th>
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
                    <td className="truncate px-2 py-1" title={r.supplier}>
                      {r.supplier}
                    </td>
                    <td className="truncate px-2 py-1 font-mono">
                      {r.truckPlate ?? "—"}
                    </td>
                    <td className="px-2 py-1 text-right font-mono tabular-nums">
                      {r.sacks == null ? "—" : r.sacks.toLocaleString("en-US")}
                    </td>
                    <td className="px-2 py-1 text-right font-mono tabular-nums">
                      {fmtKg(r.weightKg)}
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
