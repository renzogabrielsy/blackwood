'use client';

import { useState } from 'react';
import Link from 'next/link';

import { cn } from '@/lib/utils';
import { METRICS, type MetricKey } from '@/lib/cenapro/ccc-analysis';
import {
    formatCompactKg,
    formatCoverage,
    formatDayOfMonth,
    formatDow,
    formatKg,
    formatMetric,
    formatMonthHeading,
    type QcAggregate,
    type SeriesPoint,
} from '@/lib/cenapro/ccc-analysis-view';

import { Chip, Panel, Tile } from '../qc-chrome';
import { MetricTrendPanel } from '../qc-metric-charts';
import { MonthYearPicker } from '../month-year-picker';
import type { QcDayRow, QcMonthRow } from '../data';

interface QcBreakdownClientProps {
    /** `YYYY-MM` — the `?m=` axis, shared with the QC Ledger. Scopes everything DAILY. */
    month: string;
    /** Every `YYYY-MM` present in the data, ascending — feeds the Month/Year picker. */
    monthKeys: string[];
    months: QcMonthRow[];
    days: QcDayRow[];
    /** The selected month's `ex_dvo` rollup, or null when it carries no receipts. */
    monthAgg: QcAggregate | null;
    /** Every month folded into one — the KPI tiles' whole-history line. */
    overall: QcAggregate;
    metricSeries: Record<MetricKey, SeriesPoint[]>;
    dailyMetricSeries: Record<MetricKey, SeriesPoint[]>;
    uncoveredMonthLabel: string | null;
}

type Grain = 'daily' | 'monthly';

/**
 * QC Breakdown — the reading surface that pairs with the QC Ledger's entry grid over
 * one `?m=` month axis.
 *
 * WHAT IS DELIBERATELY ABSENT
 * Two stacked bar charts used to headline this page — monthly tonnage by source group
 * and its daily twin. Both were cut on Renzo's call ("the monthly rollup is much
 * better… the daily version is a bit useless"). The consequence is accepted: the Tanks
 * / Plant-direct / Flec source split does not appear here at all. Do not reintroduce it
 * as a different chart — if it must come back it belongs as a column or a filter.
 *
 * What remains is numbers first (the two rollup tables, which he prefers to charts),
 * then the four per-metric trend panels, sized as the page's primary visual.
 *
 * Every figure here is READ from `cenapro_ccc_analysis_monthly` / `_daily` at
 * `scope='ex_dvo'`. Nothing on this page is aggregated in TypeScript.
 */
export function QcBreakdownClient({
    month,
    monthKeys,
    months,
    days,
    monthAgg,
    overall,
    metricSeries,
    dailyMetricSeries,
    uncoveredMonthLabel,
}: QcBreakdownClientProps) {
    const [grain, setGrain] = useState<Grain>('monthly');

    return (
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
            <div className="shrink-0 border-b border-border px-3 py-2">
                <div className="flex flex-wrap items-center gap-2">
                    <span className="text-xs font-semibold tracking-wide">
                        {months[0]?.month.slice(0, 4) ?? '—'} –{' '}
                        {months[months.length - 1]?.month.slice(0, 4) ?? '—'}
                    </span>
                    <Chip tone="muted">Monthly + daily · ex-DVO</Chip>

                    <MonthYearPicker month={month} availableMonths={monthKeys} label="Daily focus" />

                    <Link
                        href={`/cenapro/qc?m=${month}`}
                        className="ml-auto shrink-0 text-[11px] text-muted-foreground underline underline-offset-2 transition-colors duration-150 hover:text-foreground"
                    >
                        ← QC Ledger (entry)
                    </Link>
                </div>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto p-3">
                {/* ── KPI tiles ────────────────────────────────────────────────────── */}
                <div className="mb-3 grid grid-cols-2 gap-2 lg:grid-cols-4">
                    <Tile
                        label="Received (ex-DVO)"
                        value={formatCompactKg(overall.totalKg)}
                        sub={
                            overall.dvoKg > 0
                                ? `+ ${formatCompactKg(overall.dvoKg)} DVO, excluded`
                                : 'no DVO receipts'
                        }
                    />
                    <Tile
                        label="Wtd BD"
                        value={formatMetric(overall.wtd.bd, 'bd', true)}
                        sub="across every sampled receipt"
                    />
                    <Tile
                        label="Wtd MC %"
                        value={formatMetric(overall.wtd.mc, 'mc', true)}
                        sub="across every sampled receipt"
                    />
                    <Tile
                        label="Sample coverage"
                        value={`${Math.round(overall.coverage * 100)}%`}
                        sub={
                            uncoveredMonthLabel
                                ? `${uncoveredMonthLabel}: 0% — needs entry`
                                : 'every month has samples'
                        }
                        subTone={uncoveredMonthLabel ? 'amber' : 'muted'}
                    />
                </div>

                {/* ── The two rollup tables, side by side ──────────────────────────────
                    Deliberately ONE band and deliberately ABOVE the charts. Pairing the
                    monthly table with the daily one puts the year and the selected month
                    where they can be read against each other. Numbers before pictures.

                    `items-start`: the two tables have genuinely different row counts (8
                    months vs up to 31 days). Stretching the shorter card to the taller
                    one's height just relocates the hole INSIDE the card — a bordered
                    panel with 140px of nothing under its last row. */}
                <div className="grid grid-cols-1 items-start gap-3 xl:grid-cols-[minmax(340px,0.85fr)_1.15fr]">
                    <RollupTable months={months} />
                    <DailyRollupTable month={month} days={days} monthAgg={monthAgg} />
                </div>

                {/* ── Per-metric trend panels — Daily | Monthly ────────────────────── */}
                <div className="mt-3">
                    <Panel
                        title={
                            grain === 'monthly'
                                ? 'Weighted averages by month — one panel per metric'
                                : `Weighted averages by day — ${formatMonthHeading(month)}`
                        }
                        subtitle={
                            grain === 'monthly'
                                ? 'separate scales by design: never a dual axis'
                                : 'gaps are days nobody sampled — never bridged'
                        }
                        actions={
                            <GrainToggle
                                grain={grain}
                                onChange={setGrain}
                                monthLabel={formatMonthHeading(month)}
                            />
                        }
                    >
                        {/* Two-up below xl so a panel never gets squeezed to a sliver —
                            the charts are the page's primary visual and they get room. */}
                        <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-4">
                            {METRICS.map((metric) => (
                                <MetricTrendPanel
                                    key={metric}
                                    metric={metric}
                                    series={
                                        grain === 'monthly'
                                            ? metricSeries[metric]
                                            : dailyMetricSeries[metric]
                                    }
                                    grain={grain}
                                />
                            ))}
                        </div>
                    </Panel>
                </div>

                <p className="mt-3 text-[11px] text-muted-foreground/70">
                    Entry lives on the{' '}
                    <Link
                        href={`/cenapro/qc?m=${month}`}
                        className="underline underline-offset-2 hover:text-foreground"
                    >
                        QC Ledger
                    </Link>
                    — the <code className="font-mono">?m=</code> month carries across. Every number
                    on this page is computed by a SQL view, never stored and never re-derived here.
                </p>
            </div>
        </div>
    );
}

// ─── Daily | Monthly grain toggle ────────────────────────────────────────────────

function GrainToggle({
    grain,
    onChange,
    monthLabel,
}: {
    grain: Grain;
    onChange: (next: Grain) => void;
    monthLabel: string;
}) {
    const options: { value: Grain; label: string; title: string }[] = [
        { value: 'daily', label: 'Daily', title: `Per-day weighted averages for ${monthLabel}` },
        { value: 'monthly', label: 'Monthly', title: 'Weighted average per month, whole history' },
    ];
    return (
        <div
            role="group"
            aria-label="Trend grain"
            className="inline-flex overflow-hidden rounded-md border border-border"
        >
            {options.map((option) => (
                <button
                    key={option.value}
                    type="button"
                    title={option.title}
                    aria-pressed={grain === option.value}
                    onClick={() => onChange(option.value)}
                    className={cn(
                        'px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider transition-colors duration-150',
                        grain === option.value
                            ? 'bg-foreground text-background'
                            : 'text-muted-foreground hover:bg-muted hover:text-foreground',
                    )}
                >
                    {option.label}
                </button>
            ))}
        </div>
    );
}

// ─── Daily rollup table ──────────────────────────────────────────────────────────

const DAILY_COLS = [
    { key: 'day', width: 44, label: 'Day' },
    { key: 'dow', width: 46, label: 'DOW' },
    { key: 'wt', width: 96, label: 'TTL WT', numeric: true },
    { key: 'bd', width: 66, label: 'BD', numeric: true },
    { key: 'ash', width: 58, label: 'ASH', numeric: true },
    { key: 'grit', width: 58, label: 'GRIT', numeric: true },
    { key: 'mc', width: 62, label: 'MC', numeric: true },
    { key: 'cov', width: 62, label: 'Cov', numeric: true },
];

const DAILY_MIN_WIDTH = DAILY_COLS.reduce((sum, c) => sum + c.width, 0);

/** Sticky-bottom month total. OPAQUE `bg-muted` + `.frozen-edge-top` — never glass. */
const DAILY_FOOTER_CELL =
    'frozen-row-bottom frozen-edge-top border-x border-border/60 bg-muted px-2 py-1 align-middle';

function DailyRollupTable({
    month,
    days,
    monthAgg,
}: {
    month: string;
    days: QcDayRow[];
    monthAgg: QcAggregate | null;
}) {
    return (
        <Panel
            title={`Daily rollup — ${formatMonthHeading(month)}`}
            subtitle="ex-DVO · foots to the monthly row"
        >
            {/* One scrollport for both axes: bounded height so the Σ footer pins,
                min-width on the table so nothing crushes. The height cap is what keeps a
                31-row month from pushing the charts off the fold. */}
            <div className="max-h-[420px] overflow-auto rounded-md border border-border">
                <table
                    className="w-full table-fixed border-collapse text-xs"
                    style={{ minWidth: `${DAILY_MIN_WIDTH}px` }}
                >
                    <colgroup>
                        {DAILY_COLS.map((col) => (
                            <col key={col.key} style={{ width: `${col.width}px` }} />
                        ))}
                    </colgroup>
                    <thead>
                        <tr>
                            {DAILY_COLS.map((col) => (
                                <th
                                    key={col.key}
                                    scope="col"
                                    className={cn(
                                        'frozen-row whitespace-nowrap border border-border bg-muted px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground',
                                        col.numeric ? 'text-right' : 'text-left',
                                    )}
                                >
                                    {col.label}
                                </th>
                            ))}
                        </tr>
                    </thead>
                    <tbody>
                        {days.map((day) => (
                            <tr
                                key={day.date}
                                className="h-8 transition-all duration-150 hover:bg-muted/40"
                            >
                                <td className="border border-border/60 px-2 py-1 font-mono">
                                    {formatDayOfMonth(day.date)}
                                </td>
                                <td className="border border-border/60 px-2 py-1 font-mono text-muted-foreground">
                                    {formatDow(day.date)}
                                </td>
                                <td className="border border-border/60 px-2 py-1 text-right font-mono tabular-nums">
                                    {formatKg(day.agg.totalKg)}
                                </td>
                                {METRICS.map((metric) => (
                                    <td
                                        key={metric}
                                        className={cn(
                                            'border border-border/60 px-2 py-1 text-right font-mono tabular-nums',
                                            day.agg.wtd[metric] == null && 'text-muted-foreground/50',
                                        )}
                                    >
                                        {formatMetric(day.agg.wtd[metric], metric, true)}
                                    </td>
                                ))}
                                <td
                                    className={cn(
                                        'border border-border/60 px-2 py-1 text-right font-mono tabular-nums',
                                        day.agg.coverage >= 1
                                            ? 'text-muted-foreground'
                                            : 'bg-amber-500/10 text-amber-700 dark:text-amber-300',
                                    )}
                                >
                                    {formatCoverage(day.agg.coverage)}
                                </td>
                            </tr>
                        ))}
                        {days.length === 0 ? (
                            <tr>
                                <td
                                    colSpan={DAILY_COLS.length}
                                    className="px-2 py-6 text-center text-xs text-muted-foreground"
                                >
                                    No partner receipts in {formatMonthHeading(month)}.
                                </td>
                            </tr>
                        ) : null}
                    </tbody>
                    {monthAgg ? (
                        <tfoot>
                            <tr>
                                <td
                                    colSpan={2}
                                    className={cn(
                                        DAILY_FOOTER_CELL,
                                        'truncate text-[10px] font-bold uppercase tracking-widest',
                                    )}
                                >
                                    Σ {formatMonthHeading(month)}
                                </td>
                                <td
                                    className={cn(
                                        DAILY_FOOTER_CELL,
                                        'text-right font-mono text-[11px] font-bold tabular-nums',
                                    )}
                                >
                                    {formatKg(monthAgg.totalKg)}
                                </td>
                                {METRICS.map((metric) => (
                                    <td
                                        key={metric}
                                        className={cn(
                                            DAILY_FOOTER_CELL,
                                            'text-right font-mono text-[11px] font-bold tabular-nums',
                                            monthAgg.wtd[metric] == null && 'text-muted-foreground/60',
                                        )}
                                    >
                                        {formatMetric(monthAgg.wtd[metric], metric, true)}
                                    </td>
                                ))}
                                <td
                                    className={cn(
                                        DAILY_FOOTER_CELL,
                                        'text-right font-mono text-[11px] font-bold tabular-nums',
                                        monthAgg.coverage < 1 && 'text-amber-700 dark:text-amber-300',
                                    )}
                                >
                                    {formatCoverage(monthAgg.coverage)}
                                </td>
                            </tr>
                        </tfoot>
                    ) : null}
                </table>
            </div>
        </Panel>
    );
}

// ─── Monthly rollup table ────────────────────────────────────────────────────────

const ROLLUP_COLS = [
    { key: 'mo', width: 48, label: 'Mo' },
    { key: 'wt', width: 92, label: 'TTL WT', numeric: true },
    { key: 'bd', width: 62, label: 'BD', numeric: true },
    { key: 'ash', width: 54, label: 'ASH', numeric: true },
    { key: 'grit', width: 54, label: 'GRIT', numeric: true },
    { key: 'mc', width: 58, label: 'MC', numeric: true },
    { key: 'cov', width: 54, label: 'Cov', numeric: true },
];

const ROLLUP_MIN_WIDTH = ROLLUP_COLS.reduce((sum, c) => sum + c.width, 0);

/** Sticky-bottom whole-history total, mirroring the daily table's footer. */
const ROLLUP_FOOTER_CELL = DAILY_FOOTER_CELL;

function RollupTable({ months }: { months: QcMonthRow[] }) {
    // The all-months line. Weighted averages are NOT printed here — a mean of monthly
    // means is not the true weighted average, and the honest figure already exists in
    // the KPI tiles. So the footer totals WEIGHT only, and says so, rather than
    // printing four numbers that would quietly disagree with the tiles above them.
    const totalKg = months.reduce((sum, row) => sum + row.agg.totalKg, 0);

    return (
        <Panel title="Monthly rollup" subtitle="the BREAKDOWN-CCC table, live">
            <div className="max-h-[420px] overflow-auto rounded-md border border-border">
                <table
                    className="w-full table-fixed border-collapse text-xs"
                    style={{ minWidth: `${ROLLUP_MIN_WIDTH}px` }}
                >
                    <colgroup>
                        {ROLLUP_COLS.map((col) => (
                            <col key={col.key} style={{ width: `${col.width}px` }} />
                        ))}
                    </colgroup>
                    <thead>
                        <tr>
                            {ROLLUP_COLS.map((col) => (
                                <th
                                    key={col.key}
                                    scope="col"
                                    className={cn(
                                        'frozen-row whitespace-nowrap border border-border bg-muted px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground',
                                        col.numeric ? 'text-right' : 'text-left',
                                    )}
                                >
                                    {col.label}
                                </th>
                            ))}
                        </tr>
                    </thead>
                    <tbody>
                        {months.map((row) => {
                            const noSamples = row.agg.sampledGroupCount === 0;
                            return (
                                <tr
                                    key={row.month}
                                    className="h-8 transition-all duration-150 hover:bg-muted/40"
                                >
                                    <td className="border border-border/60 px-2 py-1 font-mono">
                                        {row.label}
                                    </td>
                                    <td className="border border-border/60 px-2 py-1 text-right font-mono tabular-nums">
                                        {formatKg(row.agg.totalKg)}
                                    </td>
                                    {noSamples ? (
                                        <td
                                            colSpan={5}
                                            className="truncate border border-border/60 bg-amber-500/10 px-2 py-1 text-center text-[11px] text-amber-700 dark:text-amber-300"
                                        >
                                            no samples yet — enter {row.label} analysis
                                        </td>
                                    ) : (
                                        <>
                                            {METRICS.map((metric) => (
                                                <td
                                                    key={metric}
                                                    className="border border-border/60 px-2 py-1 text-right font-mono tabular-nums"
                                                >
                                                    {formatMetric(row.agg.wtd[metric], metric, true)}
                                                </td>
                                            ))}
                                            <td
                                                className={cn(
                                                    'border border-border/60 px-2 py-1 text-right font-mono tabular-nums',
                                                    row.agg.coverage >= 1
                                                        ? 'text-muted-foreground'
                                                        : 'bg-amber-500/10 text-amber-700 dark:text-amber-300',
                                                )}
                                            >
                                                {formatCoverage(row.agg.coverage)}
                                            </td>
                                        </>
                                    )}
                                </tr>
                            );
                        })}
                        {months.length === 0 ? (
                            <tr>
                                <td
                                    colSpan={ROLLUP_COLS.length}
                                    className="px-2 py-6 text-center text-xs text-muted-foreground"
                                >
                                    No partner receipts on record.
                                </td>
                            </tr>
                        ) : null}
                    </tbody>
                    {months.length > 0 ? (
                        <tfoot>
                            <tr>
                                <td
                                    className={cn(
                                        ROLLUP_FOOTER_CELL,
                                        'truncate text-[10px] font-bold uppercase tracking-widest',
                                    )}
                                >
                                    Σ All
                                </td>
                                <td
                                    className={cn(
                                        ROLLUP_FOOTER_CELL,
                                        'text-right font-mono text-[11px] font-bold tabular-nums',
                                    )}
                                >
                                    {formatKg(totalKg)}
                                </td>
                                <td
                                    colSpan={5}
                                    className={cn(
                                        ROLLUP_FOOTER_CELL,
                                        'truncate text-right text-[9.5px] font-medium text-muted-foreground',
                                    )}
                                >
                                    weighted averages across all months are in the tiles above
                                </td>
                            </tr>
                        </tfoot>
                    ) : null}
                </table>
            </div>
        </Panel>
    );
}
