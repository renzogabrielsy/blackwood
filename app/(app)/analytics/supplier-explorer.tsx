"use client";

// ─────────────────────────────────────────────────────────────────────────────
// THE EXPLORER — price × volume × participation, the plan's three-line story.
//
// §1c of the plan: the hypothesis is that a high price does not merely buy more
// kilos from the same people, it brings SELLERS to the gate. Measured (market
// class only, 2026): ₱47-48 in Q1 drew 13/14/10 suppliers; the ₱38 summer drew
// 4. So the chart is three series over one year — bars for what we bought, a
// line for what it cost, a line for how many different people sold it to us.
//
// ── NO NEW READ ──────────────────────────────────────────────────────────────
// All three series are `view_analytics_rcin_monthly`'s own published figures,
// already in the payload as `AnalyticsMonth`. Nothing here re-derives a price,
// a tonnage or a seller count, so the chart cannot disagree with the KPI matrix
// above it or with the supplier matrix beside it.
//
// ── THE AXES, AND THE ONE COMPROMISE ─────────────────────────────────────────
// Volume is the left axis in tonnes. Price is the right axis in ₱/kg. A third
// visible axis for a 4-to-21 supplier count would crowd a 375px screen into
// uselessness, so the count rides on its own HIDDEN axis — its SHAPE is the
// story and the tooltip carries its exact value. When ₱ is restricted the right
// axis is free, so the count takes it and becomes fully labelled: the price
// line simply is not drawn, because nothing was sent to the browser.
//
// Bars force a zero baseline (a volume is read as a length); the price line
// gets a padded domain (a price drawn against zero reads as flat) — the same
// split, for the same reasons, as the KPI matrix's row expand.
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
import {
  DRILLDOWN_AXIS_TICK,
  drilldownTooltipChrome,
} from "@/components/digest/drilldown/drilldown-modal";
import type { ExplorerPoint } from "@/lib/analytics/supplier";
import { SUPPLIER_DICTIONARY } from "@/lib/analytics/supplier";
import { DictionaryPopover } from "./metric-info";

// R3: 260 -> 340 px above 1920 px. See `metric-expand.tsx`.
const CHART_HEIGHT = "var(--an-chart)";

/** A price against a zero floor reads as flat — lift the minimum off the axis. */
function paddedDomain(values: number[]): [number, number] | undefined {
  if (values.length === 0) return undefined;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = Math.max(max - min, 1);
  return [
    Math.max(0, Math.floor(min - Math.max(range * 0.6, 1))),
    Math.ceil(max + Math.max(range * 0.25, 0.5)),
  ];
}

export interface SupplierExplorerProps {
  points: readonly ExplorerPoint[];
  canViewPrices: boolean;
  year: number;
}

export function SupplierExplorer({
  points,
  canViewPrices,
  year,
}: SupplierExplorerProps) {
  const tip = drilldownTooltipChrome();

  const prices = points
    .map((p) => p.price)
    .filter((v): v is number => v != null);
  const showPriceLine = canViewPrices && prices.length > 0;
  const priceDomain = paddedDomain(prices);

  const counts = points
    .map((p) => p.suppliers)
    .filter((v): v is number => v != null);
  const countDomain: [number, number] = [
    0,
    Math.max(...(counts.length > 0 ? counts : [1])) + 1,
  ];

  const hasAnything = points.some(
    (p) => p.tonnes != null || p.price != null || p.suppliers != null,
  );

  return (
    <section className="flex flex-col gap-2">
      <header className="min-w-0">
        <h3 className="flex items-center gap-1 text-[length:var(--bw-fs-11)] font-semibold uppercase tracking-wide">
          Price, volume &amp; participation
          <DictionaryPopover
            label={SUPPLIER_DICTIONARY.explorer.label}
            sublabel={SUPPLIER_DICTIONARY.explorer.sublabel}
            entry={SUPPLIER_DICTIONARY.explorer.dictionary}
          />
        </h3>
        <p className="text-[length:var(--bw-fs-11)] leading-relaxed text-muted-foreground">
          {canViewPrices
            ? "What charcoal cost, how much of it we bought, and how many different people sold it to us — the same three figures the matrix above publishes, for the selected year. Observational: the chart shows the association and cannot say which way it runs."
            : "How much charcoal we bought and how many different people sold it to us, month by month. The price line is withheld for your role — nothing was sent to this browser."}
        </p>
      </header>

      <div className="rounded-lg border bg-card p-2">
        {!hasAnything ? (
          <p className="px-3 py-12 text-center text-[length:var(--bw-fs-12)] leading-[var(--bw-lh-xs)] text-muted-foreground">
            Nothing was bought in {year}.
          </p>
        ) : (
          <div className="w-full" style={{ height: CHART_HEIGHT }}>
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart
                data={points as ExplorerPoint[]}
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
                {/* Volume — a length from a zero baseline, always. */}
                <YAxis
                  yAxisId="volume"
                  tick={DRILLDOWN_AXIS_TICK}
                  tickLine={false}
                  axisLine={false}
                  width={48}
                  domain={[0, "auto"]}
                  tickFormatter={(v: number) =>
                    v.toLocaleString("en-US", { maximumFractionDigits: 0 })
                  }
                />
                {/* Price on the right when it may be shown; when it may not,
                    the right axis belongs to the supplier count instead. */}
                <YAxis
                  yAxisId="price"
                  orientation="right"
                  hide={!showPriceLine}
                  tick={DRILLDOWN_AXIS_TICK}
                  tickLine={false}
                  axisLine={false}
                  width={44}
                  domain={priceDomain ?? ["auto", "auto"]}
                  tickFormatter={(v: number) => `₱${v.toFixed(0)}`}
                />
                <YAxis
                  yAxisId="suppliers"
                  orientation="right"
                  hide={showPriceLine}
                  tick={DRILLDOWN_AXIS_TICK}
                  tickLine={false}
                  axisLine={false}
                  width={36}
                  allowDecimals={false}
                  domain={countDomain}
                />
                <RTooltip
                  {...tip}
                  formatter={(value, name) => {
                    if (value == null) return ["—", String(name)];
                    const v = Number(value);
                    if (name === "price")
                      return [`₱${v.toFixed(2)} /kg`, "Market price"];
                    if (name === "suppliers")
                      return [
                        `${v.toFixed(0)} seller${v === 1 ? "" : "s"}`,
                        "Active suppliers",
                      ];
                    return [
                      `${v.toLocaleString("en-US", { maximumFractionDigits: 1 })} t`,
                      "Purchase volume",
                    ];
                  }}
                  labelFormatter={(label, payload) =>
                    payload?.[0]?.payload?.fullLabel ?? label
                  }
                />
                <Legend
                  wrapperStyle={{ fontSize: "var(--bw-fs-11)", paddingTop: 4 }}
                  formatter={(v) =>
                    v === "price"
                      ? "Market price (₱/kg, right)"
                      : v === "suppliers"
                        ? showPriceLine
                          ? "Active suppliers (own scale)"
                          : "Active suppliers (right)"
                        : "Purchase volume (t, left)"
                  }
                />
                <Bar
                  yAxisId="volume"
                  dataKey="tonnes"
                  name="tonnes"
                  fill="var(--chart-2)"
                  radius={[3, 3, 0, 0]}
                  maxBarSize={28}
                  isAnimationActive={false}
                />
                {showPriceLine && (
                  <Line
                    yAxisId="price"
                    type="monotone"
                    dataKey="price"
                    name="price"
                    stroke="var(--chart-4)"
                    strokeWidth={2}
                    dot={{ r: 2.5 }}
                    isAnimationActive={false}
                    connectNulls={false}
                  />
                )}
                <Line
                  yAxisId="suppliers"
                  type="monotone"
                  dataKey="suppliers"
                  name="suppliers"
                  stroke="var(--chart-1)"
                  strokeWidth={1.75}
                  strokeDasharray="4 3"
                  dot={{ r: 2 }}
                  isAnimationActive={false}
                  connectNulls={false}
                />
              </ComposedChart>
            </ResponsiveContainer>
          </div>
        )}
      </div>

      {/* The worked example names two real April prices, so it is ₱ and is
          gated like any other ₱ — the point survives without the numbers. */}
      <p className="text-[length:var(--bw-fs-115)] leading-relaxed text-muted-foreground">
        {showPriceLine
          ? "The supplier line is drawn on its own scale so its SHAPE can be read beside the price — hover a month for the exact count. "
          : ""}
        {canViewPrices
          ? "Every series excludes sun-drying returns and re-cooks, which matters: counting them made April 2026 read ₱44.58 with 7 sellers when the market truth was ₱46.84 with 4."
          : "Every series excludes sun-drying returns and re-cooks, which matters: counting them made April 2026 look like 7 sellers when only 4 of them actually sold us anything."}
      </p>
    </section>
  );
}
