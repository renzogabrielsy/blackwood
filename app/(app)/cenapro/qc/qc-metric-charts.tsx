'use client';

// ─────────────────────────────────────────────────────────────────────────────────
// QC analysis — recharts chart chrome shared by the ledger and the breakdown.
//
// WHY RECHARTS AND NOT HAND-ROLLED SVG
// The evaluation drafts originally hand-rolled their charts, and every one of them
// set `preserveAspectRatio="none"` — which smears a fixed viewBox to fill its
// container, so the SAME series reads with a different slope and different x-spacing
// at 900px and at 1440px. Measured live at a 408px tile: an x-scale of 3.138 against
// a y-scale of 1.0, turning a nominal r=2.4 dot into a 15 × 4.8 ellipse. That is the
// stretched look Renzo rejected. `ResponsiveContainer` re-measures and re-lays-out on
// resize instead of scaling a coordinate space, so these measure 1:1 at every width.
//
// The axis config, CartesianGrid treatment and tooltip surface are deliberately the
// digest board's — Renzo asked for uniformity with it.
//
// LAYER RULE (CLAUDE.md): `components/digest/**` is ICTC **tenant** code and Cenapro
// is Tenant #2, so the pattern is REPRODUCED here, never imported. The only shared
// things are platform-level: the `--chart-N` CSS tokens and `--popover`/`--border`
// semantics, which are theme-aware in both light and dark.
// ─────────────────────────────────────────────────────────────────────────────────

import * as React from 'react';
import {
    Area,
    AreaChart,
    CartesianGrid,
    Line,
    LineChart,
    ResponsiveContainer,
    Tooltip as RTooltip,
    XAxis,
    YAxis,
} from 'recharts';

import { cn } from '@/lib/utils';
import { METRIC_LABEL, type MetricKey } from '@/lib/cenapro/ccc-analysis';
import { formatMetric, type SeriesPoint } from '@/lib/cenapro/ccc-analysis-view';

const AXIS_TICK = {
    fill: 'var(--muted-foreground)',
    fontSize: 10,
    fontFamily: 'var(--font-geist-sans, inherit)',
} as const;

/**
 * One stable hue per metric, from the PLATFORM chart tokens. Tokens (not literal hex)
 * because they already carry a light AND a dark value — a recharts `stroke` is a
 * string prop, so a Tailwind `dark:` class would silently do nothing here.
 */
export const METRIC_COLOR: Record<MetricKey, string> = {
    bd: 'var(--chart-1)',
    ash: 'var(--chart-2)',
    grit: 'var(--chart-3)',
    mc: 'var(--chart-4)',
};

/** Themed recharts tooltip surface — the digest's glass popover, verbatim in spirit. */
function tooltipChrome() {
    return {
        contentStyle: {
            background: 'var(--popover)',
            border: '1px solid var(--border)',
            borderRadius: '0.5rem',
            fontSize: '11px',
            color: 'var(--popover-foreground)',
            boxShadow: '0 4px 16px rgba(0,0,0,0.12)',
            padding: '4px 8px',
        } as React.CSSProperties,
        labelStyle: { color: 'var(--muted-foreground)', fontSize: '10px' },
        itemStyle: { color: 'var(--popover-foreground)' },
        cursor: { stroke: 'var(--border)', strokeWidth: 1 },
    };
}

/**
 * A padded y-domain so a near-flat series does not glue itself to the panel edges and
 * a real 0.02 BD movement stays visible. `undefined` (→ recharts auto) when there is
 * nothing to scale.
 */
function paddedDomain(series: SeriesPoint[]): [number, number] | undefined {
    const values = series.map((p) => p.value).filter((v): v is number => v != null);
    if (values.length === 0) return undefined;
    const min = Math.min(...values);
    const max = Math.max(...values);
    const range = max - min;
    // A single point / a flat series still needs a band around it, proportional to the
    // value itself so it works for BD (~0.55) and MC (~11) without a magic constant.
    const pad = range > 0 ? range * 0.18 : Math.max(Math.abs(max) * 0.05, 0.01);
    return [min - pad, max + pad];
}

function countSamples(series: SeriesPoint[]): number {
    let n = 0;
    for (const p of series) if (p.value != null) n += 1;
    return n;
}

// ─── Tile sparkline (the ledger's KPI tiles) ─────────────────────────────────────

interface MetricSparkTooltipPayload {
    payload?: { label?: string; value?: number | null };
}

function SparkTooltip({
    active,
    payload,
    metric,
    pointLabel,
}: {
    active?: boolean;
    payload?: MetricSparkTooltipPayload[];
    metric: MetricKey;
    pointLabel: string;
}) {
    const point = payload?.[0]?.payload;
    if (!active || !point || point.value == null) return null;
    return (
        <div className="rounded-md border border-border bg-popover/95 px-2 py-1 text-[10px] shadow-md backdrop-blur-lg">
            <div className="text-muted-foreground">
                {pointLabel} {point.label}
            </div>
            <div className="font-mono font-semibold tabular-nums text-popover-foreground">
                {formatMetric(point.value, metric, true)}
            </div>
        </div>
    );
}

/**
 * The glanceable trend inside a KPI tile — the digest's canonical small area spark, at
 * the grain the operator is actually working in.
 *
 * DAILY, not monthly: the ledger is month-scoped, so a month-over-month line answered
 * a question the page was not asking. One point per receipt DAY says something real —
 * where the month drifted and which days moved it.
 *
 * Gaps are honest (`connectNulls={false}`), so a day nobody sampled breaks the area
 * rather than inventing a slope across it. A day stranded between two gaps would draw
 * no segment at all, so dots turn ON while the series is sparse enough to read.
 */
export function MetricSpark({
    series,
    metric,
    /** Prefix for the tooltip's first line, e.g. `"Day"`. */
    pointLabel = 'Day',
    className,
}: {
    series: SeriesPoint[];
    metric: MetricKey;
    pointLabel?: string;
    className?: string;
}) {
    const gradientId = React.useId();
    const stroke = METRIC_COLOR[metric];
    const samples = countSamples(series);

    if (samples === 0) {
        return (
            <div
                className={cn(
                    'mt-1 flex h-10 w-full items-center justify-center rounded bg-muted/40 text-[9.5px] text-muted-foreground/70',
                    className,
                )}
            >
                no samples this month
            </div>
        );
    }

    return (
        <div className={cn('mt-1 h-10 w-full min-w-0', className)}>
            <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={series} margin={{ top: 2, right: 1, bottom: 0, left: 1 }}>
                    <defs>
                        <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
                            <stop offset="0%" stopColor={stroke} stopOpacity={0.35} />
                            <stop offset="100%" stopColor={stroke} stopOpacity={0} />
                        </linearGradient>
                    </defs>
                    <YAxis hide domain={['dataMin', 'dataMax']} />
                    <RTooltip
                        content={<SparkTooltip metric={metric} pointLabel={pointLabel} />}
                        cursor={{ stroke: 'var(--border)', strokeWidth: 1 }}
                        isAnimationActive={false}
                        wrapperStyle={{ outline: 'none', zIndex: 50 }}
                    />
                    <Area
                        type="monotone"
                        dataKey="value"
                        stroke={stroke}
                        strokeWidth={1.75}
                        fill={`url(#${gradientId})`}
                        isAnimationActive={false}
                        connectNulls={false}
                        dot={samples <= 14 ? { r: 1.5, fill: stroke, strokeWidth: 0 } : false}
                        activeDot={{ r: 2.5, stroke, fill: 'var(--background)', strokeWidth: 1.5 }}
                    />
                </AreaChart>
            </ResponsiveContainer>
        </div>
    );
}

// ─── Metric small-multiple panel (the breakdown's four charts) ───────────────────

/**
 * One metric, one panel, one scale.
 *
 * BD (~0.55), ASH (~2.8), GRIT (~0.7) and MC (~11) live on wildly different scales, so
 * they get FOUR panels and never a dual axis.
 */
export function MetricTrendPanel({
    metric,
    series,
    grain,
    height = 176,
    emptyNote,
}: {
    metric: MetricKey;
    series: SeriesPoint[];
    grain: 'daily' | 'monthly';
    height?: number;
    emptyNote?: string;
}) {
    const tip = tooltipChrome();
    const stroke = METRIC_COLOR[metric];
    const samples = countSamples(series);
    const domain = paddedDomain(series);
    const last = React.useMemo(
        () => [...series].reverse().find((p) => p.value != null)?.value ?? null,
        [series],
    );
    const note = emptyNote ?? (grain === 'daily' ? 'no samples this month' : 'no samples yet');

    return (
        <section className="flex min-w-0 flex-col rounded-lg border border-border bg-card/60 p-2.5">
            <header className="mb-1 flex items-baseline justify-between gap-2">
                <h4 className="truncate text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
                    {METRIC_LABEL[metric]}
                </h4>
                <span
                    className="shrink-0 font-mono text-[11px] font-semibold tabular-nums"
                    style={{ color: stroke }}
                >
                    {formatMetric(last, metric, true)}
                </span>
            </header>

            {samples === 0 ? (
                <div
                    className="flex items-center justify-center rounded bg-muted/30 text-[10px] text-muted-foreground/70"
                    style={{ height }}
                >
                    {note}
                </div>
            ) : (
                <div className="w-full min-w-0" style={{ height }}>
                    <ResponsiveContainer width="100%" height="100%">
                        <LineChart data={series} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
                            <CartesianGrid stroke="var(--border)" strokeOpacity={0.4} vertical={false} />
                            <XAxis
                                dataKey="label"
                                tick={AXIS_TICK}
                                tickLine={false}
                                axisLine={{ stroke: 'var(--border)' }}
                                minTickGap={grain === 'daily' ? 18 : 8}
                            />
                            <YAxis
                                tick={AXIS_TICK}
                                tickLine={false}
                                axisLine={false}
                                width={46}
                                domain={domain ?? ['auto', 'auto']}
                                tickFormatter={(v: number) => formatMetric(v, metric)}
                            />
                            <RTooltip
                                {...tip}
                                formatter={(value) => [
                                    formatMetric(typeof value === 'number' ? value : null, metric, true),
                                    METRIC_LABEL[metric],
                                ]}
                                labelFormatter={(l) => (grain === 'daily' ? `Day ${l}` : String(l))}
                            />
                            {/* connectNulls={false} is load-bearing: a period nobody
                                sampled is a HOLE, and bridging it would draw a trend
                                that was never measured. Dots keep a stranded single
                                sample visible when its neighbours are holes. */}
                            <Line
                                type="monotone"
                                dataKey="value"
                                stroke={stroke}
                                strokeWidth={2}
                                isAnimationActive={false}
                                connectNulls={false}
                                dot={{ r: 1.8, fill: stroke, strokeWidth: 0 }}
                                activeDot={{
                                    r: 3.5,
                                    stroke,
                                    fill: 'var(--background)',
                                    strokeWidth: 1.5,
                                }}
                            />
                        </LineChart>
                    </ResponsiveContainer>
                </div>
            )}
        </section>
    );
}
