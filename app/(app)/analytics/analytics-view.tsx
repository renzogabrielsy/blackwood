"use client";

// ─────────────────────────────────────────────────────────────────────────────
// /analytics — the client shell. Owns the three view controls, the callout
// strip, the matrix and the expanded row.
//
// ── WHY THE VIEW STATE IS REACT STATE THAT WRITES ITSELF INTO THE URL ────────
//
// The house rule is that URL search params drive filters and navigation state,
// and the reason for it is that a filter changes what the SERVER reads. Here
// nothing does: `getAnalyticsData()` returns ALL history in one payload (49 /
// 75 / 75 rows across three views — two orders of magnitude under the read
// cap), and the year, the granularity and the working-day toggle only re-slice
// what is already in the browser. Routing them through `router.replace` would
// re-run four Supabase reads and re-render the whole page to change a column
// header.
//
// So the state is local AND the URL is kept honest with
// `window.history.replaceState`: the address bar always describes what is on
// screen, a link is shareable and a reload lands where you left, without a
// server round-trip. The SERVER still resolves the initial values from
// `searchParams` — a deep link renders correctly on the first paint, not after
// a client effect.
//
// ── THE CALLOUTS ARE NOT A SECOND COMPUTATION ────────────────────────────────
// `buildMatrix` returns the cells AND the callouts from one pass over the same
// values, so a headline can never disagree with the grid beneath it. They are
// magnitude-only by the plan's rule: the biggest move, the widest year-ago gap,
// and records against a metric's own history. No thresholds, no invented
// "breach" rules, and no colour semantics anywhere on the page.
// ─────────────────────────────────────────────────────────────────────────────

import * as React from "react";
import { Layers, TrendingUp } from "lucide-react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import { buildMatrix, type Granularity } from "@/lib/analytics/matrix";
import type { MetricKey, MetricSection } from "@/lib/analytics/metrics";
import type { AnalyticsData, AnalyticsMonth } from "@/lib/analytics/types";
import { AnalyticsMatrix } from "./analytics-matrix";
import { AnalyticsNav } from "./analytics-nav";
import { MetricExpand } from "./metric-expand";
import { BatchCostPanel } from "./batch-cost-panel";
import { SupplierRoom } from "./supplier-room";
import { ProductionRoom } from "./production-room";
import { AgingWatchlist } from "./aging-watchlist";

/**
 * The bands the TOP matrix renders. The production band is deliberately not
 * one of them — it is the same fold, rendered by the same component, down in
 * its own section after the supplier room, because the page's reading order is
 * PERIOD → CAMPAIGN → SUPPLIER → PRODUCTION → PILE.
 */
const TOP_BANDS: readonly MetricSection[] = ["flow", "money"];

const GRANULARITIES: { key: Granularity; label: string; title: string }[] = [
  { key: "Y", label: "Y", title: "One column per year, all years" },
  { key: "Q", label: "Q", title: "Four quarter columns for the selected year" },
  { key: "M", label: "M", title: "Twelve month columns for the selected year" },
];

/** Keeps the address bar describing the screen — WITHOUT a server round-trip. */
function syncUrl(next: {
  year: number;
  granularity: Granularity;
  perWorkingDay: boolean;
  metric: MetricKey | null;
}) {
  if (typeof window === "undefined") return;
  const url = new URL(window.location.href);
  url.searchParams.set("year", String(next.year));
  url.searchParams.set("g", next.granularity);
  if (next.perWorkingDay) url.searchParams.set("wd", "1");
  else url.searchParams.delete("wd");
  if (next.metric) url.searchParams.set("metric", next.metric);
  else url.searchParams.delete("metric");
  window.history.replaceState(null, "", url.toString());
}

export interface AnalyticsViewProps {
  data: AnalyticsData;
  initialYear: number;
  initialGranularity: Granularity;
  initialPerWorkingDay: boolean;
  initialMetric: MetricKey | null;
}

export function AnalyticsView({
  data,
  initialYear,
  initialGranularity,
  initialPerWorkingDay,
  initialMetric,
}: AnalyticsViewProps) {
  const [year, setYear] = React.useState(initialYear);
  const [granularity, setGranularity] =
    React.useState<Granularity>(initialGranularity);
  const [perWorkingDay, setPerWorkingDay] = React.useState(initialPerWorkingDay);
  const [metric, setMetric] = React.useState<MetricKey | null>(initialMetric);

  React.useEffect(() => {
    syncUrl({ year, granularity, perWorkingDay, metric });
  }, [year, granularity, perWorkingDay, metric]);

  const matrix = React.useMemo(
    () =>
      buildMatrix(data.months, {
        granularity,
        year,
        canViewPrices: data.canViewPrices,
        perWorkingDay,
      }),
    [data.months, data.canViewPrices, granularity, year, perWorkingDay],
  );

  /**
   * The expanded row, but ONLY when it belongs to a band this matrix renders.
   * A production row's expand opens inside the production section instead, so
   * the panel always sits directly under the table that named it.
   */
  const expandedRow = React.useMemo(() => {
    if (!metric) return null;
    const row = matrix.rows.find((r) => r.metric.key === metric) ?? null;
    return row && row.metric.section !== "production" ? row : null;
  }, [matrix.rows, metric]);

  /** The newest month inside the displayed window — what the split panel describes. */
  const anchorMonth: AnalyticsMonth | null = React.useMemo(() => {
    const inWindow = matrix.periods.flatMap((p) => p.months);
    return inWindow[inWindow.length - 1] ?? data.months[data.months.length - 1] ?? null;
  }, [matrix.periods, data.months]);

  const scopeNote =
    granularity === "Y"
      ? "every year on record"
      : `${year}${matrix.periods.some((p) => p.isPartial) ? " · the marked column is still in progress" : ""}`;

  return (
    <div className="flex flex-col gap-4">
      {/* ── In-page anchors ──────────────────────────────────────────────
          P4 completes the page, and completion is what makes it long: two
          matrix bands, the campaign panel, the supplier room, the production
          room and the watchlist. Sticky, so it never leaves; a flow element,
          so pinning it shifts nothing. */}
      <AnalyticsNav />

      {/* ── Controls ─────────────────────────────────────────────────────── */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <div className="flex items-center gap-2">
          <span className="text-[10.5px] font-medium uppercase tracking-wide text-muted-foreground">
            Year
          </span>
          <Select
            value={String(year)}
            onValueChange={(v) => setYear(Number(v))}
            disabled={granularity === "Y"}
          >
            <SelectTrigger
              className="h-7 w-[92px] gap-1 border-border/60 bg-background px-2 font-mono text-[11px] hover:bg-muted/50"
              aria-label="Year"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {data.years.map((y) => (
                <SelectItem key={y} value={String(y)} className="font-mono text-[11px]">
                  {y}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div
          role="group"
          aria-label="Column granularity"
          className="inline-flex shrink-0 items-center gap-0.5 rounded-md border bg-muted/40 p-0.5"
        >
          {GRANULARITIES.map((g) => {
            const active = g.key === granularity;
            return (
              <button
                key={g.key}
                type="button"
                title={g.title}
                aria-pressed={active}
                onClick={() => !active && setGranularity(g.key)}
                className={cn(
                  "cursor-pointer rounded px-2.5 py-1 text-[11px] font-medium transition-colors duration-150",
                  "focus:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  active
                    ? "bg-background text-foreground shadow-sm"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                {g.label}
              </button>
            );
          })}
        </div>

        <label className="flex cursor-pointer select-none items-center gap-2">
          <Switch
            checked={perWorkingDay}
            onCheckedChange={setPerWorkingDay}
            aria-label="Show volumes per working day"
          />
          <span
            className={cn(
              "text-[11px] transition-colors duration-150",
              perWorkingDay ? "font-medium text-foreground" : "text-muted-foreground",
            )}
            title="Divides the volume and consumption rows by the days the site was actually active, so a short month is comparable with a long one. Prices, stock levels and counts are unaffected."
          >
            Per working day
          </span>
          {perWorkingDay && (
            <span className="rounded border border-border/70 px-1 font-mono text-[9.5px] leading-[14px] text-muted-foreground">
              volumes ÷ working days
            </span>
          )}
        </label>

        <span className="ml-auto flex items-center gap-3 text-[10.5px] text-muted-foreground">
          {/* LIVE, never historical — a batch only records where it is NOW, so
              past block occupancy is not reconstructable and is never a row. */}
          {data.utilization && (
            <span
              className="inline-flex items-center gap-1"
              title="How many of the 220 standard warehouse blocks hold a batch RIGHT NOW. Historical occupancy is not reconstructable — a batch only records where it is today — so this is never shown as a month-by-month row."
            >
              <Layers className="size-3" aria-hidden />
              <span className="font-mono tabular-nums text-foreground">
                {data.utilization.occupied}/{data.utilization.total}
              </span>
              blocks occupied
              <span className="rounded border border-border/70 px-1 text-[9px] uppercase tracking-wide">
                today
              </span>
            </span>
          )}
          <span className="hidden sm:inline">{scopeNote}</span>
        </span>
      </div>

      {/* ── Callouts ─────────────────────────────────────────────────────── */}
      {matrix.callouts.length > 0 && (
        <ul className="stagger-fast grid grid-cols-1 gap-1.5 lg:grid-cols-2">
          {matrix.callouts.map((c) => (
            <li
              key={c.key}
              className="flex items-start gap-2 rounded-md border bg-card/60 px-2.5 py-1.5"
            >
              <TrendingUp
                className="mt-0.5 size-3 shrink-0 text-muted-foreground"
                aria-hidden
              />
              <p className="text-[11.5px] leading-relaxed text-foreground">{c.text}</p>
            </li>
          ))}
        </ul>
      )}

      {/* ── The matrix ───────────────────────────────────────────────────── */}
      <AnalyticsMatrix
        matrix={matrix}
        selected={metric}
        onSelect={setMetric}
        perWorkingDay={perWorkingDay}
        sections={TOP_BANDS}
      />

      {/* ── The expanded row ─────────────────────────────────────────────── */}
      {expandedRow && (
        <MetricExpand
          row={expandedRow}
          granularity={granularity}
          totalLabel={matrix.totalLabel}
          totalFullLabel={matrix.totalFullLabel}
          anchorMonth={anchorMonth}
          perWorkingDay={perWorkingDay}
          onClose={() => setMetric(null)}
        />
      )}

      {/* ── The BATCH basis, and the live watchlist ───────────────────────
          Both are OUTSIDE the matrix on purpose. The campaign panel is a
          different AXIS (campaigns cross month boundaries, so a campaign is
          not a period), and the watchlist is a different GRAIN entirely —
          one row per named pile, today, not one column per period. Folding
          either into the matrix would have meant a column that is neither a
          month nor a quarter sitting beside columns that are. */}
      <div id="section-campaigns" className="scroll-mt-24">
        <BatchCostPanel campaigns={data.campaigns} canViewPrices={data.canViewPrices} />
      </div>

      {/* ── The SUPPLIER axis ──────────────────────────────────────────
          Third of the five cuts this page makes through the same yard:
          period → campaign → supplier → production → pile. It follows the
          year picker above (a supplier year is a calendar year, always) but
          not the Y/Q/M toggle: a quarter column of suppliers would be a
          different question, and the room's own axis is already twelve
          months wide. */}
      <div id="section-suppliers" className="scroll-mt-24">
        <SupplierRoom
          suppliers={data.suppliers}
          months={data.months}
          year={year}
          canViewPrices={data.canViewPrices}
        />
      </div>

      {/* ── The PRODUCTION axis ────────────────────────────────────────
          Where the yard's kilos stop being charcoal and start being
          product. Its six rows are the SAME `buildMatrix` fold as the table
          at the top — same rollups, same expand, same callout strip — the
          band is simply rendered here, after the three blocks that are
          about buying and holding. No ₱ exists anywhere in it, so it is
          live for every role including Production. */}
      <ProductionRoom
        matrix={matrix}
        months={data.months}
        grades={data.productionGrades}
        year={year}
        granularity={granularity}
        selected={metric}
        onSelect={setMetric}
        perWorkingDay={perWorkingDay}
      />

      <div id="section-watchlist" className="scroll-mt-24">
        <AgingWatchlist
          watchlist={data.watchlist}
          canViewPrices={data.canViewPrices}
        />
      </div>

      {/* ── Footer: the restatement policy, printed once, on the page ─────
          The analyst audit's gap #4. Every figure here is rebuilt from the
          delivery and feeding records themselves — nothing is snapshotted — so
          a correction to a past record correctly changes a past column. Saying
          so is the difference between a restatement and an unexplained
          discrepancy. */}
      <footer className="flex flex-col gap-1 border-t pt-3 text-[10.5px] leading-relaxed text-muted-foreground">
        <p>
          Figures reflect the underlying records as of today; corrections to past
          records restate history (audited).
        </p>
        <p>
          Nothing on this page is snapshotted — every month is rebuilt from the
          delivery and feeding rows themselves, so the newest column equals the
          live inventory total exactly. A blank cell is never a zero: hover it and
          it says why it is empty.
          {data.asOfDate && (
            <>
              {" "}
              Records run through{" "}
              <span className="font-mono text-foreground">{data.asOfDate}</span>.
            </>
          )}
        </p>
      </footer>
    </div>
  );
}
