"use client";

// ─────────────────────────────────────────────────────────────────────────────
// RC In price drill-down — the chart-card half of the same feature set.
//
// PRICE IS A SECURITY BOUNDARY. `getRcInPriceDrilldown` resolves
// `canViewPrices()` on the server and, for a denied role, returns an EMPTY
// payload with `restricted: true` — no ₱ ever crosses the wire. This component
// renders that as an explicit "restricted for your role" state rather than an
// empty chart, because a blank chart is indistinguishable from a broken one.
//
// Every ₱ figure drawn here is computed in SQL (weighted average per bucket);
// the only arithmetic in TypeScript is the bucket-over-bucket % change and a
// MEAN of the bucket prices — labelled as a mean, never as a weighted average.
// ─────────────────────────────────────────────────────────────────────────────

import * as React from "react";
import {
  Bar,
  CartesianGrid,
  ComposedChart,
  Legend,
  Line,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip as RTooltip,
  XAxis,
  YAxis,
} from "recharts";
import { Lock } from "lucide-react";
import { cn } from "@/lib/utils";
import { fmtPhpNumber } from "../format";
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
  type PriceDrilldown,
} from "@/lib/digest/drilldown-types";

/** Signed percent, e.g. "+3.2%" / "−1.1%" (real minus glyph). */
function fmtPctSigned(v: number): string {
  const sign = v > 0 ? "+" : v < 0 ? "−" : "";
  return `${sign}${Math.abs(v).toLocaleString("en-US", {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  })}%`;
}

/** "DoD" at day granularity, "MoM" at month. */
function changeLabel(granularity: PriceDrilldown["granularity"]): string {
  return granularity === "month" ? "MoM %" : "DoD %";
}

/**
 * The wired modal — the ONE thing a caller mounts. `populationNote` is surfaced
 * in the footer rather than swallowed: the monthly series comes from a slightly
 * different market-purchase set than the daily one, and a footnote is cheaper
 * than two definitions presented as one.
 */
export function RcInPriceDrilldownModal({
  data,
  ...modal
}: DrilldownModalState & { data: PriceDrilldown | null }) {
  return (
    <DrilldownModal
      {...modal}
      title="RC In price"
      description={`${RANGE_LABEL[modal.range]} · weighted ₱/kg per ${
        modal.range === "ytd" ? "month" : "day"
      }`}
      skeleton={<DrilldownChartSkeleton stats={4} tableRows={6} />}
      footerLink={[
        { href: "/inventory/rc-in", label: "Open RC IN" },
        { href: "/analytics?metric=market_price", label: "Full analytics" },
      ]}
      footerNote={data?.populationNote ?? null}
    >
      {data && <RcInPriceDrilldownBody data={data} />}
    </DrilldownModal>
  );
}

export function RcInPriceDrilldownBody({ data }: { data: PriceDrilldown }) {
  const tip = drilldownTooltipChrome();
  const { summary, granularity } = data;
  const changeCaption = changeLabel(granularity);

  // Same padded-domain treatment as the small card: lift the lowest price OFF
  // the axis floor so it never READS as zero.
  const phpDomain = React.useMemo<[number, number] | undefined>(() => {
    const values = data.series
      .map((p) => p.phpPerKg)
      .filter((v): v is number => v != null);
    if (values.length === 0) return undefined;
    const min = Math.min(...values);
    const max = Math.max(...values);
    const range = Math.max(max - min, 1);
    return [
      Math.max(0, Math.floor(min - Math.max(range * 0.6, 1.5))),
      Math.ceil(max + Math.max(range * 0.25, 0.5)),
    ];
  }, [data.series]);

  if (data.restricted) {
    return (
      <div className="flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed bg-muted/30 px-6 py-16 text-center">
        <Lock className="size-5 text-muted-foreground" aria-hidden />
        <p className="text-sm font-medium">Price data is restricted for your role</p>
        <p className="max-w-[420px] text-xs leading-relaxed text-muted-foreground">
          ₱/kg purchase prices are withheld server-side for the Production role,
          so nothing was sent to this browser. The RC In volume drill-down is
          available to every role.
        </p>
      </div>
    );
  }

  const recent = data.series.slice(-10).reverse();

  return (
    <div className="flex flex-col gap-4">
      {/* ── Summary strip ── */}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <DrilldownStat
          label="Latest"
          value={summary.latestPhp == null ? "—" : `₱${fmtPhpNumber(summary.latestPhp)}`}
          unit={summary.latestPhp == null ? undefined : "/kg"}
          sub={data.series.length ? data.series[data.series.length - 1].bucket : undefined}
        />
        {/* Low leads, high rides in the sub-line — one ₱ per row never
            truncates on a 375px card, where "₱44.00 – ₱52.86" did. */}
        <DrilldownStat
          label="Low"
          value={summary.minPhp == null ? "—" : `₱${fmtPhpNumber(summary.minPhp)}`}
          unit={summary.minPhp == null ? undefined : "/kg"}
          sub={
            summary.maxPhp == null
              ? undefined
              : `high ₱${fmtPhpNumber(summary.maxPhp)}`
          }
        />
        <DrilldownStat
          label="Mean"
          value={summary.meanPhp == null ? "—" : `₱${fmtPhpNumber(summary.meanPhp)}`}
          unit={summary.meanPhp == null ? undefined : "/kg"}
          sub={granularity === "month" ? "of monthly prices" : "of daily prices"}
          title="The simple mean of the per-bucket weighted averages — NOT the range's weighted average price, which is a SQL figure and is not computed here."
        />
        <DrilldownStat
          label="Biggest swing"
          value={
            summary.biggestSwing == null
              ? "—"
              : fmtPctSigned(summary.biggestSwing.pct)
          }
          tone={
            summary.biggestSwing == null
              ? "default"
              : summary.biggestSwing.pct > 0
                ? "down" // a price RISE is bad news for a buyer
                : "up"
          }
          sub={
            summary.biggestSwing
              ? `${changeCaption} · ${summary.biggestSwing.bucket}`
              : undefined
          }
          title="The largest single bucket-over-bucket move. A price RISE is coloured as the adverse direction — this is a purchase price."
        />
      </div>

      {/* ── Chart ── */}
      <DrilldownSection
        title="Purchase price"
        subtitle={`₱/kg · ${changeCaption}`}
        bodyClassName="p-2 pb-1"
      >
        {data.series.length === 0 ? (
          <p className="px-3 py-12 text-center text-xs text-muted-foreground">
            No priced purchases in this window.
          </p>
        ) : (
          <div className="h-[280px] w-full">
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
                  yAxisId="php"
                  tick={DRILLDOWN_AXIS_TICK}
                  tickLine={false}
                  axisLine={false}
                  width={56}
                  domain={phpDomain ?? ["auto", "auto"]}
                  allowDecimals={false}
                  tickFormatter={(v: number) => `₱${fmtPhpNumber(v)}`}
                />
                <YAxis
                  yAxisId="pct"
                  orientation="right"
                  tick={DRILLDOWN_AXIS_TICK}
                  tickLine={false}
                  axisLine={false}
                  width={52}
                  domain={["auto", "auto"]}
                  tickFormatter={(v: number) => fmtPctSigned(v)}
                />
                <RTooltip
                  {...tip}
                  formatter={(value, name) => {
                    if (name === "changePct") {
                      return value == null
                        ? ["—", changeCaption]
                        : [fmtPctSigned(Number(value)), changeCaption];
                    }
                    return value == null
                      ? ["—", "₱/kg"]
                      : [`₱${fmtPhpNumber(Number(value))}`, "₱/kg"];
                  }}
                  labelFormatter={(label, payload) =>
                    payload?.[0]?.payload?.bucket ?? label
                  }
                />
                <Legend
                  wrapperStyle={{ fontSize: "11px", paddingTop: 4 }}
                  formatter={(v) => (v === "changePct" ? changeCaption : "₱/kg")}
                />
                <ReferenceLine
                  yAxisId="pct"
                  y={0}
                  stroke="var(--border)"
                  strokeWidth={1}
                />
                {/* The change reads as bars behind the price line — at this size
                    a second dashed line competes with the primary series. */}
                <Bar
                  yAxisId="pct"
                  dataKey="changePct"
                  name="changePct"
                  fill="var(--chart-3)"
                  fillOpacity={0.45}
                  maxBarSize={granularity === "month" ? 32 : 14}
                  isAnimationActive={false}
                />
                <Line
                  yAxisId="php"
                  type="monotone"
                  dataKey="phpPerKg"
                  name="phpPerKg"
                  stroke="var(--chart-4)"
                  strokeWidth={2}
                  dot={granularity === "month" ? { r: 2.5 } : false}
                  isAnimationActive={false}
                  connectNulls
                />
              </ComposedChart>
            </ResponsiveContainer>
          </div>
        )}
      </DrilldownSection>

      {/* ── Recent buckets (Excel Standard density) ── */}
      <DrilldownSection
        title={granularity === "month" ? "Recent months" : "Recent days"}
        subtitle={`latest ${recent.length}`}
        bodyClassName="p-0"
      >
        {recent.length === 0 ? (
          <p className="px-3 py-6 text-center text-xs text-muted-foreground">
            No priced purchases in this window.
          </p>
        ) : (
          <div className="overflow-x-auto">
            {/* "Never crush, always scroll": min-width = the sum of the column
                minimums (110 + 150 + 100), so the date can never be squeezed to
                an ellipsis — the wrapper scrolls instead. */}
            <table className="w-full min-w-[360px] table-fixed text-xs">
              {/* Date is the FLEXIBLE column (it absorbs surplus width, so the
                  accounting ₱ never stretches across half the table); the
                  min-width above guarantees its 110px floor. */}
              <colgroup>
                <col />
                <col className="w-[150px]" />
                <col className="w-[100px]" />
              </colgroup>
              <thead>
                <tr className="border-b bg-muted/60 text-[10.5px] uppercase tracking-wide text-muted-foreground">
                  <th className="px-2 py-1 text-left font-medium">
                    {granularity === "month" ? "Month" : "Date"}
                  </th>
                  <th className="px-2 py-1 text-right font-medium">₱/kg</th>
                  <th className="px-2 py-1 text-right font-medium">
                    {changeCaption}
                  </th>
                </tr>
              </thead>
              <tbody>
                {recent.map((p) => (
                  <tr
                    key={p.bucket}
                    className="h-8 border-b transition-all duration-150 last:border-0 hover:bg-muted/40"
                  >
                    <td className="truncate px-2 py-1 font-mono tabular-nums">
                      {p.bucket}
                    </td>
                    {/* Accounting format: ₱ pinned left, number pinned right. */}
                    <td className="px-2 py-1">
                      {p.phpPerKg == null ? (
                        <span className="block text-right font-mono text-muted-foreground">
                          —
                        </span>
                      ) : (
                        <span className="flex justify-between gap-2 font-mono tabular-nums">
                          <span className="text-muted-foreground">₱</span>
                          <span>{fmtPhpNumber(p.phpPerKg)}</span>
                        </span>
                      )}
                    </td>
                    <td
                      className={cn(
                        "px-2 py-1 text-right font-mono tabular-nums",
                        p.changePct == null
                          ? "text-muted-foreground"
                          : p.changePct > 0
                            ? "text-red-700 dark:text-red-300"
                            : p.changePct < 0
                              ? "text-emerald-700 dark:text-emerald-300"
                              : "text-muted-foreground"
                      )}
                    >
                      {p.changePct == null ? "—" : fmtPctSigned(p.changePct)}
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
