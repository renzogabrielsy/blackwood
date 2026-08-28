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
import { AlertTriangle } from "lucide-react";
import { cn } from "@/lib/utils";
import { fmtKg } from "../format";
import {
  DRILLDOWN_AXIS_TICK,
  DrilldownChartSkeleton,
  DrilldownModal,
  DrilldownSection,
  DrilldownStat,
  drilldownTooltipChrome,
} from "./drilldown-modal";
import type { DrilldownModalState } from "./use-drilldown";
import {
  RANGE_LABEL,
  type RcInDrilldown,
} from "@/lib/digest/drilldown-types";

/** "7-day avg" / "3-month avg" — the rolling window, named for the granularity. */
export function rollingLabel(granularity: RcInDrilldown["granularity"]): string {
  return granularity === "month" ? "3-month avg" : "7-day avg";
}

const BUCKET_NOUN: Record<RcInDrilldown["granularity"], string> = {
  day: "day",
  month: "month",
};

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
      footerLink={{ href: "/inventory/rc-in", label: "Open RC IN" }}
    >
      {data && <RcInDrilldownBody data={data} />}
    </DrilldownModal>
  );
}

export function RcInDrilldownBody({ data }: { data: RcInDrilldown }) {
  const tip = drilldownTooltipChrome();
  const { summary, granularity } = data;
  const noun = BUCKET_NOUN[granularity];
  const avgLabel = rollingLabel(granularity);

  return (
    <div className="flex flex-col gap-4">
      {data.truncated && (
        <div
          role="alert"
          className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2"
        >
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-amber-600 dark:text-amber-400" />
          <p className="text-[11px] leading-relaxed text-muted-foreground">
            This window has more deliveries than one read returns, so every
            figure below is a <strong className="font-semibold">floor</strong>,
            not a total. Open RC IN for the complete ledger.
          </p>
        </div>
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
          <div className="h-[240px] w-full">
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart
                data={data.series}
                margin={{ top: 6, right: 8, bottom: 0, left: 0 }}
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
                  minTickGap={granularity === "month" ? 8 : 24}
                />
                <YAxis
                  tick={DRILLDOWN_AXIS_TICK}
                  tickLine={false}
                  axisLine={false}
                  width={48}
                  tickFormatter={(v: number) => fmtKg(v)}
                />
                <RTooltip
                  {...tip}
                  formatter={(value, name) => [
                    value == null ? "—" : `${fmtKg(Number(value))} kg`,
                    name === "avg" ? avgLabel : "Received",
                  ]}
                  labelFormatter={(_label, payload) =>
                    payload?.[0]?.payload?.bucket ?? _label
                  }
                />
                <Legend
                  wrapperStyle={{ fontSize: "11px", paddingTop: 4 }}
                  formatter={(v) => (v === "avg" ? avgLabel : "Received")}
                />
                {/* A 0 bar simply is not drawn — an honest gap on a bar chart,
                    and unlike a line it never "plunges" to the floor (the
                    convention digest-charts' FlowChart states for its lines). */}
                <Bar
                  dataKey="kg"
                  name="kg"
                  fill="var(--chart-2)"
                  radius={[3, 3, 0, 0]}
                  maxBarSize={granularity === "month" ? 44 : 22}
                  isAnimationActive={false}
                />
                {/* The rolling mean DOES include zero days — that is what makes
                    it an average of the period rather than of the busy days. */}
                <Line
                  type="monotone"
                  dataKey="avg"
                  name="avg"
                  stroke="var(--chart-4)"
                  strokeWidth={2}
                  dot={false}
                  isAnimationActive={false}
                  connectNulls={false}
                />
              </ComposedChart>
            </ResponsiveContainer>
          </div>
        </DrilldownSection>

        <DrilldownSection
          title="By supplier"
          subtitle={`${data.suppliers.length} in range`}
          bodyClassName="p-0"
        >
          {data.suppliers.length === 0 ? (
            <p className="px-3 py-6 text-center text-xs text-muted-foreground">
              No deliveries in this window.
            </p>
          ) : (
            <ol className="max-h-[240px] overflow-y-auto px-3 py-2">
              {data.suppliers.map((s, i) => (
                <li key={s.supplier} className="py-1">
                  <div className="flex items-baseline justify-between gap-2">
                    <span
                      className="min-w-0 truncate text-xs"
                      title={`${s.supplier} · ${s.deliveries} deliveries · ${s.sacks.toLocaleString(
                        "en-US"
                      )} sacks`}
                    >
                      <span className="mr-1.5 font-mono text-[10px] text-muted-foreground tabular-nums">
                        {i + 1}
                      </span>
                      {s.supplier}
                    </span>
                    <span className="shrink-0 font-mono text-xs tabular-nums">
                      {fmtKg(s.kg)}
                      <span className="ml-1 text-[10px] text-muted-foreground">
                        kg
                      </span>
                    </span>
                  </div>
                  <div className="mt-0.5 flex items-center gap-2">
                    <div className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-muted">
                      <div
                        className={cn(
                          "h-full origin-left rounded-full",
                          i === 0 ? "bg-[var(--chart-2)]" : "bg-[var(--chart-2)]/55"
                        )}
                        style={{ width: `${Math.min(100, s.sharePct)}%` }}
                      />
                    </div>
                    <span className="w-10 shrink-0 text-right font-mono text-[10px] text-muted-foreground tabular-nums">
                      {s.sharePct.toFixed(1)}%
                    </span>
                  </div>
                </li>
              ))}
            </ol>
          )}
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
