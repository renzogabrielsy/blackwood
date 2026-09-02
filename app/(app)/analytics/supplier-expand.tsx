"use client";

// ─────────────────────────────────────────────────────────────────────────────
// ONE SUPPLIER, EXPANDED — their year as a chart plus the five numbers that
// describe it.
//
// It renders BELOW the table rather than inside it, for the same layout reason
// the KPI row expand does: the matrix is `table-fixed` inside an
// `overflow-x-auto` wrapper, so a `colSpan` panel would be as wide as the
// scrolling table and a chart in it would need horizontal scrolling to read.
//
// The chart is bars for kilos bought (a volume is a length from zero) and a
// dashed line for the premium against that month's market price (a signed
// ₱/kg, so its axis is centred on zero rather than padded). The premium line
// is simply absent for a price-denied role — nothing was sent to the browser.
//
// ── THE TWO THINGS IT WILL NOT DO ────────────────────────────────────────────
// Returned sun-dried material is shown as its own stat and its own muted note,
// never added to the bars. And the year premium in the stat strip is the
// WEIGHTED one from `lib/analytics/supplier.ts` — the strip never means an
// average of the monthly premiums, which for this column is meaningless.
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
import { CornerDownLeft, Lock, X } from "lucide-react";
import {
  DRILLDOWN_AXIS_TICK,
  DrilldownSection,
  DrilldownStat,
  drilldownTooltipChrome,
} from "@/components/digest/drilldown/drilldown-modal";
import { BreakdownRail } from "@/components/digest/drilldown/series-parts";
import type { RailItem } from "@/components/digest/drilldown/series-parts";
import type { SupplierRow, SupplierYear } from "@/lib/analytics/supplier";
import { SUPPLIER_DICTIONARY } from "@/lib/analytics/supplier";
import { DictionaryPopover } from "./metric-info";

// R3: 220 -> 290 px above 1920 px. See `metric-expand.tsx`.
const CHART_HEIGHT = "var(--an-chart-sm)";

function t1(kg: number | null): string {
  if (kg == null) return "—";
  return (kg / 1000).toLocaleString("en-US", {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  });
}

function n(v: number | null, decimals: number): string {
  if (v == null) return "—";
  return v.toLocaleString("en-US", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

function signedMoney(v: number | null): string {
  if (v == null) return "—";
  const sign = v > 0 ? "+" : v < 0 ? "−" : "";
  return `${sign}₱${n(Math.abs(v), 2)}`;
}

export interface SupplierExpandProps {
  row: SupplierRow;
  data: SupplierYear;
  canViewPrices: boolean;
  onClose(): void;
}

export function SupplierExpand({
  row,
  data,
  canViewPrices,
  onClose,
}: SupplierExpandProps) {
  const tip = drilldownTooltipChrome();

  const points = data.months.map((m, i) => {
    const cell = row.cells[i];
    return {
      label: m.label,
      fullLabel: m.fullLabel,
      tonnes: cell?.kg == null ? null : cell.kg / 1000,
      premium: cell?.premium ?? null,
      sundry: cell?.sundryKg == null ? null : cell.sundryKg / 1000,
      sharePct: cell?.sharePct ?? null,
    };
  });

  // A supplier who bought nothing all year would otherwise get an empty box
  // with axes on it. The chart draws their RETURNING material instead —
  // labelled as such in the legend and the tooltip, in the muted returns
  // colour, so it can never be read as a purchase. It is the only series
  // they have.
  const purchaseless = row.returnsOnly;
  const barKey = purchaseless ? "sundry" : "tonnes";
  const barName = purchaseless ? "Returned from sundry" : "Bought";

  const premiums = points
    .map((p) => p.premium)
    .filter((v): v is number => v != null);
  const showPremium = canViewPrices && premiums.length > 0;
  const premiumBound =
    premiums.length > 0
      ? Math.max(...premiums.map((v) => Math.abs(v))) * 1.25 || 1
      : 1;

  const railItems: RailItem[] = points
    .filter((p) => p.tonnes != null || p.sundry != null)
    .map((p) => ({
      key: p.fullLabel,
      label: p.fullLabel,
      meta:
        p.sundry != null ? (
          <span
            className="inline-flex items-center gap-0.5"
            title={`${n(p.sundry, 1)} t of their material returned from sun-drying that month — traceability only.`}
          >
            <CornerDownLeft className="size-2.5" aria-hidden />
            {n(p.sundry, 1)}t
          </span>
        ) : undefined,
      value: p.tonnes == null ? "—" : n(p.tonnes, 1),
      // No unit on a dash — "—t" reads as a broken number rather than a blank.
      unit: p.tonnes == null ? undefined : "t",
      sharePct: p.sharePct ?? 0,
      title:
        p.tonnes == null
          ? "Nothing bought from them this month."
          : `${n(p.tonnes, 1)} t — ${n(p.sharePct, 1)}% of everything bought that month.`,
    }));

  return (
    <section className="animate-fade-up rounded-lg border bg-card">
      <header className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 border-b px-3 py-2">
        <div className="min-w-0">
          <h3 className="truncate text-[length:var(--bw-fs-14)] leading-[var(--bw-lh-sm)] font-semibold tracking-tight">
            {row.supplier}
          </h3>
          <p className="text-[length:var(--bw-fs-105)] text-muted-foreground">
            {row.returnsOnly
              ? `Bought nothing in ${data.year} — only returning sun-dried material carried their name.`
              : `#${row.rank} of ${data.concentration.supplierCount} sellers in ${data.year} · active in ${row.activeMonths} month${row.activeMonths === 1 ? "" : "s"}`}
          </p>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="inline-flex shrink-0 cursor-pointer items-center gap-1 rounded px-1.5 py-0.5 text-[length:var(--bw-fs-11)] text-muted-foreground transition-colors duration-150 hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <X className="size-3" aria-hidden />
          Close
        </button>
      </header>

      <div className="flex flex-col gap-3 p-3">
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
          <DrilldownStat
            label="Bought"
            value={row.returnsOnly ? "—" : t1(row.kg)}
            unit={row.returnsOnly ? undefined : "t"}
            sub={`${row.deliveries} truckload${row.deliveries === 1 ? "" : "s"}`}
            title="Kilos actually purchased in the selected year. Returning sun-dried material is never in here."
          />
          <DrilldownStat
            label="Share"
            value={row.sharePct == null ? "—" : n(row.sharePct, 1)}
            unit={row.sharePct == null ? undefined : "%"}
            sub={
              row.cumulativeSharePct == null
                ? undefined
                : `${n(row.cumulativeSharePct, 1)}% cumulative`
            }
            title="Their kilos over everything the plant bought in the year — a weighted figure, not an average of monthly percentages."
          />
          <DrilldownStat
            label="₱/kg paid"
            value={
              !canViewPrices ? "—" : row.avgPrice == null ? "—" : n(row.avgPrice, 2)
            }
            sub={canViewPrices ? undefined : "restricted"}
            tone={canViewPrices ? "default" : "muted"}
            title="Total pesos ÷ total priced kilos for the year — never the mean of the monthly prices."
          />
          <DrilldownStat
            label="Premium"
            value={!canViewPrices ? "—" : signedMoney(row.premium)}
            sub={canViewPrices ? "weighted by priced kg" : "restricted"}
            tone={canViewPrices ? "default" : "muted"}
            title="Their weighted price minus the market price for the same kilos. Averaged across months WEIGHTED by priced kilos — the only aggregation this column allows."
          />
          <DrilldownStat
            label="Priced"
            value={row.coveragePct == null ? "—" : n(row.coveragePct, 1)}
            unit={row.coveragePct == null ? undefined : "%"}
            sub={`${t1(row.pricedKg)} t of ${t1(row.kg)} t`}
            title="What share of their year's kilos already carry a price. An unpriced truckload is in neither half of any average, rather than counted as free."
          />
        </div>

        <div className="grid grid-cols-1 gap-3 lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
          <DrilldownSection
            title={`${row.supplier} through ${data.year}`}
            subtitle={
              purchaseless
                ? "tonnes returned from sundry"
                : showPremium
                  ? "tonnes bought · premium vs market"
                  : "tonnes bought"
            }
            bodyClassName="p-2"
          >
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
                  <YAxis
                    yAxisId="premium"
                    orientation="right"
                    hide={!showPremium}
                    tick={DRILLDOWN_AXIS_TICK}
                    tickLine={false}
                    axisLine={false}
                    width={46}
                    domain={[-premiumBound, premiumBound]}
                    tickFormatter={(v: number) => `₱${v.toFixed(1)}`}
                  />
                  <RTooltip
                    {...tip}
                    formatter={(value, name) => {
                      if (value == null) return ["—", String(name)];
                      const v = Number(value);
                      if (name === "premium")
                        return [`${signedMoney(v)} /kg`, "Premium vs market"];
                      return [`${n(v, 1)} t`, barName];
                    }}
                    labelFormatter={(label, payload) =>
                      payload?.[0]?.payload?.fullLabel ?? label
                    }
                  />
                  <Legend
                    wrapperStyle={{ fontSize: "var(--bw-fs-11)", paddingTop: 4 }}
                    formatter={(v) =>
                      v === "premium"
                        ? "Premium (₱/kg, right)"
                        : `${barName} (t, left)`
                    }
                  />
                  <Bar
                    yAxisId="volume"
                    dataKey={barKey}
                    name={barKey}
                    fill={purchaseless ? "var(--chart-5)" : "var(--chart-2)"}
                    radius={[3, 3, 0, 0]}
                    maxBarSize={28}
                    isAnimationActive={false}
                  />
                  {showPremium && (
                    <>
                      <ReferenceLine
                        yAxisId="premium"
                        y={0}
                        stroke="var(--border)"
                        strokeWidth={1}
                      />
                      <Line
                        yAxisId="premium"
                        type="monotone"
                        dataKey="premium"
                        name="premium"
                        stroke="var(--chart-4)"
                        strokeWidth={1.75}
                        strokeDasharray="4 3"
                        dot={{ r: 2 }}
                        isAnimationActive={false}
                        connectNulls={false}
                      />
                    </>
                  )}
                </ComposedChart>
              </ResponsiveContainer>
            </div>
          </DrilldownSection>

          <DrilldownSection
            title="Month by month"
            subtitle="share of each month"
            bodyClassName="p-0"
          >
            <BreakdownRail
              items={railItems}
              emptyText="Nothing recorded for this supplier in the selected year."
              maxHeight={`calc(${CHART_HEIGHT} + 20px)`}
            />
          </DrilldownSection>
        </div>

        {row.sundryKg > 0 && (
          <div className="flex items-start gap-2 rounded-md border bg-background/40 px-2.5 py-2">
            <CornerDownLeft
              className="mt-0.5 size-3 shrink-0 text-muted-foreground"
              aria-hidden
            />
            <p className="text-[length:var(--bw-fs-11)] leading-relaxed text-muted-foreground">
              <strong className="font-medium text-foreground">
                {t1(row.sundryKg)} t returned from sundry
              </strong>{" "}
              in {data.year}, across {row.sundryDeliveries} deliver
              {row.sundryDeliveries === 1 ? "y" : "ies"}. That is our OWN
              charcoal coming back after sun-drying with {row.supplier}&rsquo;s
              name on it — it says where the material originally came from, not
              that they sold it to us again, so it is in none of the figures
              above.
              <DictionaryPopover
                label={SUPPLIER_DICTIONARY.sundry_returns.label}
                sublabel={SUPPLIER_DICTIONARY.sundry_returns.sublabel}
                entry={SUPPLIER_DICTIONARY.sundry_returns.dictionary}
                className="ml-1 inline-flex translate-y-0.5"
              />
            </p>
          </div>
        )}

        {!canViewPrices && (
          <p className="flex items-center gap-1.5 text-[length:var(--bw-fs-105)] text-muted-foreground">
            <Lock className="size-3 shrink-0" aria-hidden />
            Prices and premiums are withheld server-side for your role; the
            volume and participation figures above are live.
          </p>
        )}
      </div>
    </section>
  );
}
