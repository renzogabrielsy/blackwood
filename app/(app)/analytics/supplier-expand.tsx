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
//
// ── THE UNIVERSAL MODULE CONTRACT (owner feedback R4, 2026-09-02) ────────────
// Renzo: *"every expand card behaves identically… each module is something I
// look at and possibly report."* Audited against the KPI expand, this card was
// short four things, and every one of them mattered for the reason he gave —
// a card you might report from has to be filterable, readable and printable:
//
//   • **a period checklist.** Its axis is one year of months rather than years
//     of history, so it filters MONTHS — same `period-filter.tsx`, same All /
//     None, same "the state is what is hidden" shape. It opens on the months
//     the supplier actually did something in, which is R4's smart default read
//     onto this axis: a seller who appeared in three months of twelve was
//     reading a chart that was three quarters empty.
//   • **the stat strip recomputes with it**, through `foldSupplierSelection` —
//     the same arithmetic the year row uses over a shorter list, so a selected
//     price is still Σ pesos ÷ Σ priced kilos and a selected premium is still
//     weighted by priced kilos. Every label carries `· selected` while it is
//     filtered, exactly as the KPI expand's does.
//   • **a trailing-average switch**, on by default, drawn over the bars.
//   • **Print**, and the two paper-only blocks that go with it — a title line
//     saying what the sheet is and the page's restatement policy — plus the
//     master `Definitions` switch governing a dictionary block, so one control
//     in the page header governs every expand rather than most of them.
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
import { CornerDownLeft, Lock, Printer, X } from "lucide-react";
import {
  DRILLDOWN_AXIS_TICK,
  DrilldownSection,
  DrilldownStat,
  drilldownTooltipChrome,
} from "@/components/digest/drilldown/drilldown-modal";
import { BreakdownRail } from "@/components/digest/drilldown/series-parts";
import type { RailItem } from "@/components/digest/drilldown/series-parts";
import type { SupplierRow, SupplierYear } from "@/lib/analytics/supplier";
import {
  foldSupplierSelection,
  SUPPLIER_DICTIONARY,
} from "@/lib/analytics/supplier";
import { rollingMean } from "@/lib/analytics/matrix";
import { DictionaryPopover } from "./metric-info";
import { ChartToggle } from "./metric-expand";
import { PeriodFilter, type PeriodFilterOption } from "./period-filter";
import { NO_HIDDEN } from "@/lib/analytics/period-selection";
import { printCard } from "./print-card";

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
  /** R4 — the page's master `Definitions` switch, same as every other expand. */
  showDictionary: boolean;
  /** R4 — what a printed sheet says the reader was looking at. */
  scopeLabel: string;
  /** R4 — the newest record date, stamped on the printed sheet. */
  asOfDate: string | null;
  onClose(): void;
}

export function SupplierExpand({
  row,
  data,
  canViewPrices,
  showDictionary,
  scopeLabel,
  asOfDate,
  onClose,
}: SupplierExpandProps) {
  const tip = drilldownTooltipChrome();
  const cardRef = React.useRef<HTMLElement | null>(null);

  // ── The MONTH checklist, with R4's smart default ────────────────────────
  // The state is the HIDDEN set (the R2 shape), and it opens with the months
  // this supplier actually moved in — a seller present in three months of
  // twelve was otherwise reading a chart that was three quarters empty, which
  // is the same complaint the year checklist exists to answer, one axis down.
  // It can never hide everything: a supplier with no month at all opens fully
  // checked, because an empty chart the reader did not cause is worse than an
  // empty chart.
  const [hiddenMonths, setHiddenMonths] = React.useState<ReadonlySet<string>>(
    () => {
      const empty = data.months
        .filter((m, i) => {
          const cell = row.cells[i];
          return !cell || ((cell.kg ?? 0) <= 0 && (cell.sundryKg ?? 0) <= 0);
        })
        .map((m) => m.monthStart);
      if (empty.length === 0 || empty.length === data.months.length) {
        return NO_HIDDEN;
      }
      return new Set(empty);
    },
  );
  const isFiltered = hiddenMonths.size > 0;
  const selectedSuffix = isFiltered ? " · selected" : "";

  const [showAvg, setShowAvg] = React.useState(true);

  const monthOptions = React.useMemo<PeriodFilterOption[]>(
    () =>
      data.months.map((m, i) => {
        const cell = row.cells[i];
        const bought = (cell?.kg ?? 0) > 0;
        const returned = (cell?.sundryKg ?? 0) > 0;
        return {
          key: m.monthStart,
          label: m.label,
          meta: bought ? undefined : returned ? "returns" : "—",
          empty: !bought && !returned,
          title: bought
            ? `${m.fullLabel} — ${n((cell?.kg ?? 0) / 1000, 1)} t bought.`
            : returned
              ? `${m.fullLabel} — nothing bought; only returning sun-dried material moved.`
              : `${m.fullLabel} — this supplier did nothing at all. A genuine blank, not a zero; it changes no figure either way.`,
        };
      }),
    [data.months, row.cells],
  );

  const shownMonthCount = monthOptions.filter(
    (o) => !hiddenMonths.has(o.key),
  ).length;

  /** The stat strip's figures, re-folded over whatever months are on. */
  const fold = React.useMemo(
    () => foldSupplierSelection(row, data.months, hiddenMonths),
    [row, data.months, hiddenMonths],
  );

  // The trailing mean is computed over the FULL twelve months and nulled where
  // a month is hidden, then the hidden points are dropped — the exact order
  // `metric-expand.tsx` uses, and for the same reason: averaging after
  // filtering would draw a smooth line straight across a hole the reader made.
  const allPoints = data.months.map((m, i) => {
    const cell = row.cells[i];
    return {
      monthStart: m.monthStart,
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

  const points = React.useMemo(() => {
    const values = allPoints.map((p) =>
      hiddenMonths.has(p.monthStart) ? null : (p[barKey] ?? null),
    );
    const out: (typeof allPoints[number] & { avg: number | null })[] = [];
    allPoints.forEach((p, i) => {
      if (hiddenMonths.has(p.monthStart)) return;
      out.push({ ...p, avg: rollingMean(values, i, 3) });
    });
    return out;
  }, [allPoints, hiddenMonths, barKey]);

  /** The months, spelled out — for the printed sheet and the card's own note. */
  const selectedMonthsNote = isFiltered
    ? monthOptions
        .filter((o) => !hiddenMonths.has(o.key))
        .map((o) => o.label)
        .join(", ") || "none"
    : null;

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
    <section
      ref={cardRef}
      // THE PRINT TARGET (R4) — same contract as the KPI expand: everything
      // else on the page is hidden while `bw-printing` is on <body>, and this
      // subtree is what lands on the sheet.
      data-print-card
      className="animate-fade-up rounded-lg border bg-card"
    >
      {/* Paper only. A printed figure that does not say WHAT it is and WHEN it
          was true is a figure someone will misquote a month from now. */}
      <div className="hidden print:block print:pb-2">
        <h1 className="text-[length:var(--bw-fs-16)] leading-[var(--bw-lh-base)] font-semibold tracking-tight">
          {row.supplier}
        </h1>
        <p className="text-[length:var(--bw-fs-11)] text-muted-foreground">
          Supplier · {scopeLabel}
          {asOfDate ? ` · records through ${asOfDate}` : ""}
        </p>
        {selectedMonthsNote && (
          <p className="text-[length:var(--bw-fs-11)] text-muted-foreground">
            Filtered to {selectedMonthsNote} ({shownMonthCount} of{" "}
            {monthOptions.length} months). Hidden months are not restated — the
            figures above are folded over the months shown, by the same rules
            the year row uses.
          </p>
        )}
      </div>

      <header className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 border-b px-3 py-2 print:hidden">
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
        <div className="flex shrink-0 items-center gap-1.5" data-print-hide>
          <button
            type="button"
            onClick={() => printCard(cardRef.current)}
            title="Print just this supplier — their chart, their figures and their definitions — or save it as a PDF from the print dialog."
            className="inline-flex cursor-pointer items-center gap-1 rounded-md border border-border px-2 py-0.5 text-[length:var(--bw-fs-11)] text-muted-foreground transition-colors duration-150 hover:bg-muted hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <Printer className="size-3" aria-hidden />
            Print
          </button>
          <button
            type="button"
            onClick={onClose}
            className="inline-flex cursor-pointer items-center gap-1 rounded-md border border-border px-2 py-0.5 text-[length:var(--bw-fs-11)] text-muted-foreground transition-colors duration-150 hover:bg-muted hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <X className="size-3" aria-hidden />
            Close
          </button>
        </div>
      </header>

      <div className="flex flex-col gap-3 p-3">
        {/* R4 — every stat is folded over the SELECTED months and says so.
            "₱/kg paid" over four chosen months is a different claim from
            "₱/kg paid" over the year, and a stat that quietly changed meaning
            is the one thing a filter must not do. */}
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
          <DrilldownStat
            label={`Bought${selectedSuffix}`}
            value={row.returnsOnly ? "—" : t1(fold.kg)}
            unit={row.returnsOnly ? undefined : "t"}
            sub={`${fold.deliveries} truckload${fold.deliveries === 1 ? "" : "s"}${
              isFiltered ? ` · ${fold.monthCount} months` : ""
            }`}
            title="Kilos actually purchased in the months shown. Returning sun-dried material is never in here."
          />
          <DrilldownStat
            label={`Share${selectedSuffix}`}
            value={fold.sharePct == null ? "—" : n(fold.sharePct, 1)}
            unit={fold.sharePct == null ? undefined : "%"}
            sub={
              isFiltered
                ? "of the months shown"
                : row.cumulativeSharePct == null
                  ? undefined
                  : `${n(row.cumulativeSharePct, 1)}% cumulative`
            }
            title={
              isFiltered
                ? "Their kilos over everything the plant bought in the MONTHS SHOWN — the denominator narrows with the selection, so this is a share of those months rather than of the year."
                : "Their kilos over everything the plant bought in the year — a weighted figure, not an average of monthly percentages."
            }
          />
          <DrilldownStat
            label={`₱/kg paid${selectedSuffix}`}
            value={
              !canViewPrices ? "—" : fold.avgPrice == null ? "—" : n(fold.avgPrice, 2)
            }
            sub={canViewPrices ? undefined : "restricted"}
            tone={canViewPrices ? "default" : "muted"}
            title="Total pesos ÷ total priced kilos over the months shown — never the mean of the monthly prices."
          />
          <DrilldownStat
            label={`Premium${selectedSuffix}`}
            value={!canViewPrices ? "—" : signedMoney(fold.premium)}
            sub={canViewPrices ? "weighted by priced kg" : "restricted"}
            tone={canViewPrices ? "default" : "muted"}
            title="Their weighted price minus the market price for the same kilos. Averaged across the months shown WEIGHTED by priced kilos — the only aggregation this column allows."
          />
          <DrilldownStat
            label={`Priced${selectedSuffix}`}
            value={fold.coveragePct == null ? "—" : n(fold.coveragePct, 1)}
            unit={fold.coveragePct == null ? undefined : "%"}
            sub={`${t1(fold.pricedKg)} t of ${t1(fold.kg)} t`}
            title="What share of their kilos in the months shown already carry a price. An unpriced truckload is in neither half of any average, rather than counted as free."
          />
        </div>

        <div className="grid grid-cols-1 gap-3 lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
          <DrilldownSection
            title={
              isFiltered
                ? `${row.supplier} — the months you chose`
                : `${row.supplier} through ${data.year}`
            }
            subtitle={
              (purchaseless
                ? "tonnes returned from sundry"
                : showPremium
                  ? "tonnes bought · premium vs market"
                  : "tonnes bought") +
              (isFiltered
                ? ` · ${shownMonthCount}/${monthOptions.length} months`
                : "")
            }
            action={
              // `data-print-hide` — a control is not part of the report.
              <span
                className="flex flex-wrap items-center justify-end gap-1.5"
                data-print-hide
              >
                <ChartToggle
                  on={showAvg}
                  onChange={setShowAvg}
                  label="3-month avg"
                  color="var(--chart-3)"
                  title={
                    showAvg
                      ? "Hide the 3-month avg line. It is a trailing mean over the last three months and it breaks at a gap rather than drawing across one."
                      : "Draw the 3-month avg line — a trailing mean over the last three months, which breaks at a gap rather than drawing across one."
                  }
                />
                <PeriodFilter
                  label="Months"
                  noun="month"
                  align="end"
                  options={monthOptions}
                  hidden={hiddenMonths}
                  onChange={setHiddenMonths}
                  title="Choose which months this card covers. It opens on the months this supplier actually moved in; the rest are listed and one click brings them back. Hiding a month removes its bar AND its share of the figures above — the share's denominator narrows with it, so a filtered share is a share of the months shown."
                />
              </span>
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
                        : v === "avg"
                          ? "3-month avg (t)"
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
                  {/* R4 — the trailing mean, on the VOLUME axis, genuinely
                      removed rather than hidden when switched off: recharts
                      derives its legend from the children it is given. */}
                  {showAvg && (
                    <Line
                      yAxisId="volume"
                      type="monotone"
                      dataKey="avg"
                      name="avg"
                      stroke="var(--chart-3)"
                      strokeWidth={2}
                      dot={false}
                      isAnimationActive={false}
                      connectNulls={false}
                    />
                  )}
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
            {/* The honesty line the filter owes — same sentence the KPI expand
                prints, because it is the same rule. */}
            {isFiltered && (
              <p className="px-1 pb-1 pt-1.5 text-[length:var(--bw-fs-12)] leading-relaxed text-muted-foreground">
                Showing{" "}
                <span className="font-medium text-foreground">
                  {selectedMonthsNote}
                </span>
                . This card opens on the months this supplier moved in; the rest
                are one click away in{" "}
                <span className="font-medium text-foreground">Months</span>. The
                figures above are re-folded over what is left, by the same rules
                the year row uses — a price is still total pesos over total
                priced kilos, never a mean of the monthly prices.
              </p>
            )}
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

        {/* R4 — the dictionary blocks, behind the page's MASTER Definitions
            switch, so one control in the header governs every expand on the
            page rather than most of them. Same two-card layout as the KPI
            expand; the copy is `SUPPLIER_DICTIONARY`'s own, so the popovers
            above and these blocks can never describe a figure two ways. And it
            is deliberately ₱-FREE — this card renders for every role. */}
        {showDictionary && (
          <div
            className="grid grid-cols-1 gap-2 sm:grid-cols-2"
            data-print-block
          >
            <div className="rounded-lg border bg-background/40 px-3 py-2">
              <div className="text-[length:var(--bw-fs-105)] font-medium uppercase tracking-wide text-muted-foreground">
                What it is
              </div>
              <p className="mt-1 text-[length:var(--bw-fs-12)] leading-relaxed">
                {SUPPLIER_DICTIONARY.supplier_volume.dictionary.definition}
              </p>
              <p className="mt-1.5 text-[length:var(--bw-fs-12)] leading-relaxed text-muted-foreground">
                <span className="font-medium text-foreground">Worked out as: </span>
                {SUPPLIER_DICTIONARY.supplier_volume.dictionary.basis}
              </p>
              <p className="mt-1.5 text-[length:var(--bw-fs-12)] leading-relaxed text-muted-foreground">
                <span className="font-medium text-foreground">Leaves out: </span>
                {SUPPLIER_DICTIONARY.supplier_volume.dictionary.exclusions}
              </p>
            </div>
            <div className="rounded-lg border bg-background/40 px-3 py-2">
              <div className="text-[length:var(--bw-fs-105)] font-medium uppercase tracking-wide text-muted-foreground">
                Premium &amp; how it rolls up
              </div>
              <p className="mt-1 text-[length:var(--bw-fs-12)] leading-relaxed">
                {SUPPLIER_DICTIONARY.premium.dictionary.definition}
              </p>
              <p className="mt-1.5 text-[length:var(--bw-fs-12)] leading-relaxed text-muted-foreground">
                {SUPPLIER_DICTIONARY.premium.dictionary.rollup}
              </p>
              <p className="mt-1.5 text-[length:var(--bw-fs-12)] leading-relaxed text-muted-foreground">
                <span className="font-medium text-foreground">Worth knowing: </span>
                {SUPPLIER_DICTIONARY.premium.dictionary.caveat}
              </p>
              <p className="mt-1.5 font-mono text-[length:var(--bw-fs-10)] text-muted-foreground/80">
                {SUPPLIER_DICTIONARY.supplier_volume.dictionary.source}
              </p>
            </div>
          </div>
        )}

        {!canViewPrices && (
          <p className="flex items-center gap-1.5 text-[length:var(--bw-fs-105)] text-muted-foreground">
            <Lock className="size-3 shrink-0" aria-hidden />
            Prices and premiums are withheld server-side for your role; the
            volume and participation figures above are live.
          </p>
        )}

        {/* Paper only — the page's own restatement policy, travelling with the
            figure rather than staying behind on the screen. */}
        <p className="hidden text-[length:var(--bw-fs-10)] leading-relaxed text-muted-foreground print:block">
          Figures reflect the underlying records as of {asOfDate ?? "today"};
          nothing is snapshotted, so corrections to past records restate history
          (audited). A blank is never a zero.
        </p>
      </div>
    </section>
  );
}
