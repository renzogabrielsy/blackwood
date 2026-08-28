"use client";

// ─────────────────────────────────────────────────────────────────────────────
// FLOW drill-down — received vs fed, and the net between them.
//
// ONE MODAL, TWO TRIGGERS. It is reachable from the NET FLOW KPI tile and from
// the Feed In vs Out chart card, because they are the same two series and the
// same arithmetic — they differ only in which mark the reader is meant to look
// at first. Two components would be two definitions of "net", and they would
// eventually disagree about a number the whole page is anchored on.
//
// The difference is carried by ONE prop, `emphasis`:
//   • "net"  (the KPI tile)   — the net bars lead; the two lines ride behind.
//   • "flow" (the chart card) — the two lines lead; the net bars ride behind.
// Same data, same chart, same axes: only stroke weight and fill opacity move,
// so a reader arriving from either trigger sees the same facts.
//
// NO BREAKDOWN RAIL. There is no third dimension here — the breakdown of a net
// IS its two inputs, so the range totals for both sit side by side instead,
// each linking to the module that owns it.
//
// NO ₱ ANYWHERE. Both source views are kg-only.
// ─────────────────────────────────────────────────────────────────────────────

import * as React from "react";
import {
  Bar,
  Cell,
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
import { ArrowRight } from "lucide-react";
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
import { TruncatedNotice, bucketNoun } from "./series-parts";
import type { DrilldownModalState } from "./use-drilldown";
import {
  RANGE_LABEL,
  type FlowDrilldown,
} from "@/lib/digest/drilldown-types";

/** Which mark leads. See the header — this is the ONLY difference between the
 *  KPI tile's modal and the chart card's. */
export type FlowEmphasis = "net" | "flow";

/**
 * The drift reminder, VERBATIM from the digest's existing wording (the net-flow
 * KPI card's tooltip and its phone detail sheet both carry this exact
 * sentence). Reused, not re-authored: a third phrasing of the same operational
 * fact is a third thing to keep true.
 */
const DRIFT_NOTE =
  "Continuous-flow drift is expected — the feed tank balances at month-end, not day-to-day. This is informational, not an alert.";

/**
 * The net bar's fill, by SIGN.
 *
 * **These are deliberately NOT `--chart-N`.** A sign is a semantic, not a
 * series identity, and the chart tokens are not stable across themes:
 * `--chart-5` is red in dark mode but AMBER in light, so a drawdown bar would
 * have rendered "warning orange" for every light-mode reader. The Tailwind
 * palette vars are theme-independent and are the same emerald/red the digest
 * already uses for every signed number (`text-emerald-700 dark:text-emerald-300`
 * / `text-red-700 dark:text-red-300`). Literal fallbacks are supplied so the
 * bars cannot render transparent if the palette var is ever dropped.
 */
const NET_POSITIVE_FILL = "var(--color-emerald-500, #10b981)";
const NET_NEGATIVE_FILL = "var(--color-red-500, #ef4444)";

/** Signed kg with the real minus glyph — "+12,400" / "−8,120". */
function fmtNetKg(v: number): string {
  const sign = v > 0 ? "+" : v < 0 ? "−" : "";
  return `${sign}${fmtKg(Math.abs(v))}`;
}

export function FlowDrilldownModal({
  data,
  emphasis,
  ...modal
}: DrilldownModalState & {
  data: FlowDrilldown | null;
  emphasis: FlowEmphasis;
}) {
  const noun = modal.range === "ytd" ? "month" : "day";
  return (
    <DrilldownModal
      {...modal}
      title={emphasis === "net" ? "Net flow" : "Feed In vs Out"}
      description={
        emphasis === "net"
          ? `${RANGE_LABEL[modal.range]} · received − fed, by ${noun}`
          : `${RANGE_LABEL[modal.range]} · kg received and kg fed, by ${noun}`
      }
      // No side rail: the breakdown of a net is its two inputs, and those are a
      // two-cell panel rather than a ranked list.
      skeleton={<DrilldownChartSkeleton stats={4} tableRows={0} />}
      footerNote={DRIFT_NOTE}
    >
      {data && <FlowDrilldownBody data={data} emphasis={emphasis} />}
    </DrilldownModal>
  );
}

/** One of the two input totals — the panel that replaces the breakdown rail. */
function InputTotal({
  label,
  kg,
  color,
  href,
  linkLabel,
  sub,
}: {
  label: string;
  kg: number;
  color: string;
  href: string;
  linkLabel: string;
  sub: string;
}) {
  return (
    <div className="min-w-0 rounded-lg border bg-card/60 px-3 py-2">
      <div className="flex items-center gap-1.5">
        <span
          className="h-[3px] w-3.5 shrink-0 rounded-full"
          style={{ background: color }}
          aria-hidden
        />
        <span className="truncate text-[10.5px] font-medium uppercase tracking-wide text-muted-foreground">
          {label}
        </span>
      </div>
      <div className="mt-0.5 flex items-baseline gap-1">
        <span className="truncate font-mono text-lg font-semibold tabular-nums leading-none">
          {fmtKg(kg)}
        </span>
        <span className="shrink-0 text-[10.5px] text-muted-foreground">kg</span>
      </div>
      <div className="mt-1 flex items-baseline justify-between gap-2">
        <span className="truncate text-[10.5px] text-muted-foreground">{sub}</span>
        <a
          href={href}
          className="inline-flex shrink-0 items-center gap-0.5 rounded text-[10.5px] font-medium text-foreground transition-colors duration-150 hover:text-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {linkLabel}
          <ArrowRight className="size-2.5" />
        </a>
      </div>
    </div>
  );
}

export function FlowDrilldownBody({
  data,
  emphasis,
}: {
  data: FlowDrilldown;
  emphasis: FlowEmphasis;
}) {
  const tip = drilldownTooltipChrome();
  const { summary, granularity } = data;
  const noun = bucketNoun(granularity);
  const leadNet = emphasis === "net";

  // Received / fed are kept as ZEROES here, not nulls: on this chart a zero is
  // one half of a real net, and the bar beside it depends on it. (The small
  // Feed In vs Out card nulls them so its LINES never plunge to the floor —
  // that is a line-chart problem, and this chart's leading mark is a bar.)
  const rows = data.series;

  return (
    <div className="flex flex-col gap-4">
      {data.truncated && (
        <TruncatedNotice noun="rows" module="RC IN or RC OUT" />
      )}

      {/* ── Summary strip ── */}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <DrilldownStat
          label="Net"
          value={fmtNetKg(summary.netKg)}
          unit="kg"
          // A surplus is stock building up and a deficit is stock drawing
          // down. Neither is good or bad on its own, so the tone is the plain
          // direction, and the footer says outright that drift is expected.
          tone={summary.netKg > 0 ? "up" : summary.netKg < 0 ? "down" : "muted"}
          sub={summary.netKg >= 0 ? "stock built up" : "stock drawn down"}
          title="Received minus fed over the whole window. Continuous-flow drift is expected; the feed tank balances at month-end."
        />
        <DrilldownStat
          label={`Avg net per ${noun}`}
          value={
            summary.avgNetPerBucket == null
              ? "—"
              : fmtNetKg(summary.avgNetPerBucket)
          }
          unit={summary.avgNetPerBucket == null ? undefined : "kg"}
          sub={`over ${summary.activeBuckets} active ${noun}${
            summary.activeBuckets === 1 ? "" : "s"
          }`}
          title={`Mean net over the ${noun}s where either side moved — a ${noun} on which nothing happened is a closed plant, not a zero-net ${noun}.`}
        />
        <DrilldownStat
          // Label kept short — at 375px "Biggest surplus day" ellipsised into
          // "Biggest surplus d…". The bucket in the sub-line says which day.
          label="Biggest surplus"
          value={
            summary.biggestSurplus
              ? fmtNetKg(summary.biggestSurplus.netKg)
              : "—"
          }
          unit={summary.biggestSurplus ? "kg" : undefined}
          tone={summary.biggestSurplus ? "up" : "default"}
          sub={summary.biggestSurplus?.bucket ?? `no surplus ${noun} in range`}
        />
        <DrilldownStat
          label="Biggest deficit"
          value={
            summary.biggestDeficit ? fmtNetKg(summary.biggestDeficit.netKg) : "—"
          }
          unit={summary.biggestDeficit ? "kg" : undefined}
          tone={summary.biggestDeficit ? "down" : "default"}
          sub={summary.biggestDeficit?.bucket ?? `no deficit ${noun} in range`}
        />
      </div>

      {/* ── The two inputs, side by side (this drill-down's "breakdown") ── */}
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <InputTotal
          label="Received (RC In)"
          kg={summary.inKg}
          color="var(--chart-2)"
          href="/inventory/rc-in"
          linkLabel="Open RC IN"
          sub={`${RANGE_LABEL[data.range].toLowerCase()} total`}
        />
        <InputTotal
          label="Fed (RC Out)"
          kg={summary.outKg}
          color="var(--chart-1)"
          href="/inventory/rc-out"
          linkLabel="Open RC OUT"
          sub={`${RANGE_LABEL[data.range].toLowerCase()} total`}
        />
      </div>

      {/* ── The chart ── */}
      <DrilldownSection
        title={leadNet ? "Net flow" : "Received vs fed"}
        subtitle={`by ${noun} · kg`}
        bodyClassName="p-2 pb-1"
      >
        {rows.length === 0 ? (
          <p className="px-3 py-12 text-center text-xs text-muted-foreground">
            No movement in this window.
          </p>
        ) : (
          <div className="h-[300px] w-full">
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart
                data={rows}
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
                {/* ONE axis for all three marks: the net is the difference of
                    the other two, so putting it on a second scale would make a
                    bar and the gap above it mean different things. */}
                <YAxis
                  tick={DRILLDOWN_AXIS_TICK}
                  tickLine={false}
                  axisLine={false}
                  width={52}
                  tickFormatter={(v: number) => fmtKg(v)}
                />
                <RTooltip
                  {...tip}
                  formatter={(value, name) => {
                    const v = value == null ? null : Number(value);
                    if (name === "netKg") {
                      return [v == null ? "—" : `${fmtNetKg(v)} kg`, "Net"];
                    }
                    return [
                      v == null ? "—" : `${fmtKg(v)} kg`,
                      name === "inKg" ? "Received" : "Fed",
                    ];
                  }}
                  labelFormatter={(label, payload) =>
                    payload?.[0]?.payload?.bucket ?? label
                  }
                />
                <Legend
                  wrapperStyle={{ fontSize: "11px", paddingTop: 4 }}
                  formatter={(v) =>
                    v === "netKg"
                      ? "Net"
                      : v === "inKg"
                        ? "Received"
                        : "Fed"
                  }
                />
                <ReferenceLine y={0} stroke="var(--border)" strokeWidth={1} />
                {/* NET — bars, coloured by SIGN so a drawdown reads instantly.
                    Per-bar colour needs <Cell>, which is why this is not a
                    single `fill`. */}
                <Bar
                  dataKey="netKg"
                  name="netKg"
                  maxBarSize={granularity === "month" ? 44 : 18}
                  isAnimationActive={false}
                  fillOpacity={leadNet ? 0.9 : 0.28}
                >
                  {rows.map((p) => (
                    <Cell
                      key={p.bucket}
                      fill={
                        p.netKg >= 0 ? NET_POSITIVE_FILL : NET_NEGATIVE_FILL
                      }
                    />
                  ))}
                </Bar>
                {/* RECEIVED / FED — the same two hues the small Feed In vs Out
                    card uses, so the expanded chart reads as the big version of
                    it rather than as a different product. */}
                <Line
                  type="monotone"
                  dataKey="inKg"
                  name="inKg"
                  stroke="var(--chart-2)"
                  strokeWidth={leadNet ? 1.25 : 2}
                  strokeOpacity={leadNet ? 0.7 : 1}
                  dot={false}
                  isAnimationActive={false}
                />
                <Line
                  type="monotone"
                  dataKey="outKg"
                  name="outKg"
                  stroke="var(--chart-1)"
                  strokeWidth={leadNet ? 1.25 : 2}
                  strokeOpacity={leadNet ? 0.7 : 1}
                  dot={false}
                  isAnimationActive={false}
                />
              </ComposedChart>
            </ResponsiveContainer>
          </div>
        )}
      </DrilldownSection>

      {/* ── Recent buckets (Excel Standard density) ── */}
      <DrilldownSection
        title={granularity === "month" ? "Recent months" : "Recent days"}
        subtitle="latest 10"
        bodyClassName="p-0"
      >
        <div className="overflow-x-auto">
          {/* "Never crush, always scroll": min-width = 330px of fixed numeric
              columns + a 110px floor for the flexible date column. */}
          <table className="w-full min-w-[440px] table-fixed text-xs">
            <colgroup>
              <col />
              <col className="w-[110px]" />
              <col className="w-[110px]" />
              <col className="w-[110px]" />
            </colgroup>
            <thead>
              <tr className="border-b bg-muted/60 text-[10.5px] uppercase tracking-wide text-muted-foreground">
                <th className="px-2 py-1 text-left font-medium">
                  {granularity === "month" ? "Month" : "Date"}
                </th>
                <th className="px-2 py-1 text-right font-medium">Received</th>
                <th className="px-2 py-1 text-right font-medium">Fed</th>
                <th className="px-2 py-1 text-right font-medium">Net</th>
              </tr>
            </thead>
            <tbody>
              {rows
                .slice(-10)
                .reverse()
                .map((p) => (
                  <tr
                    key={p.bucket}
                    className="h-8 border-b transition-all duration-150 last:border-0 hover:bg-muted/40"
                  >
                    <td className="truncate px-2 py-1 font-mono tabular-nums">
                      {p.bucket}
                    </td>
                    <td className="px-2 py-1 text-right font-mono tabular-nums">
                      {p.inKg === 0 ? (
                        <span className="text-muted-foreground">—</span>
                      ) : (
                        fmtKg(p.inKg)
                      )}
                    </td>
                    <td className="px-2 py-1 text-right font-mono tabular-nums">
                      {p.outKg === 0 ? (
                        <span className="text-muted-foreground">—</span>
                      ) : (
                        fmtKg(p.outKg)
                      )}
                    </td>
                    <td
                      className={cn(
                        "px-2 py-1 text-right font-mono tabular-nums",
                        p.inKg === 0 && p.outKg === 0
                          ? "text-muted-foreground"
                          : p.netKg > 0
                            ? "text-emerald-700 dark:text-emerald-300"
                            : p.netKg < 0
                              ? "text-red-700 dark:text-red-300"
                              : "text-muted-foreground"
                      )}
                    >
                      {p.inKg === 0 && p.outKg === 0 ? "—" : fmtNetKg(p.netKg)}
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      </DrilldownSection>
    </div>
  );
}
