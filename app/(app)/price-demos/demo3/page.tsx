'use client';

/**
 * DEMO 3 of 4 — "HEATMAP"
 * Price & Volume Analysis design concept for Blackwood.
 *
 * A month × supplier color-encoded matrix. Rows = the 6 suppliers, columns =
 * the 12 months. Each cell is heat-tinted by the active METRIC (Price ₱/kg or
 * Volume kg), computed from the metric's min..max across active cells. Marginal
 * summaries (right column = per-supplier YTD, bottom row = per-month blended)
 * are tinted with the same scale at lower saturation. Hover → native tooltip;
 * click → an inline glass detail card with comparison deltas.
 *
 * Planning-stage frontend demo. Reads the shared static mock only — NOT wired
 * to Supabase. No domain mutations, no server actions.
 */

import { useMemo, useState } from 'react';
import { cn } from '@/lib/utils';
import {
  MONTHS,
  SUPPLIERS,
  CELLS,
  cell,
  MONTHLY_TOTALS,
  SUPPLIER_SUMMARIES,
  PORTFOLIO,
  fmt,
  type Cell,
} from '../_mock/data';

type Metric = 'price' | 'volume';

/* ------------------------------------------------------------------ */
/* Color scale — pure functions, computed hex/hsl per the brief.       */
/* ------------------------------------------------------------------ */

/**
 * Map a 0..1 position to an HSL string.
 *  - Price  → DIVERGING cool→warm (cheap = green/teal, expensive = red).
 *  - Volume → SEQUENTIAL single-hue ramp (low = pale indigo, high = deep indigo).
 * Lightness is nudged so text stays legible; `muted` lowers saturation for
 * the marginal summary band.
 */
function heatHsl(t: number, metric: Metric, muted = false): string {
  const clamped = Math.max(0, Math.min(1, t));
  if (metric === 'price') {
    // Hue 150 (green) → 0 (red). Saturation high, lightness eases at extremes.
    const hue = 150 - clamped * 150;
    const sat = muted ? 45 : 72;
    const light = muted ? 78 : 60 - Math.abs(clamped - 0.5) * 8;
    return `hsl(${hue.toFixed(0)} ${sat}% ${light}%)`;
  }
  // Volume: single indigo hue, ramp lightness (pale → deep) + slight sat rise.
  const hue = 245;
  const sat = muted ? 35 : 50 + clamped * 28;
  const light = muted ? 82 : 88 - clamped * 50;
  return `hsl(${hue} ${sat}% ${light}%)`;
}

/** Choose readable foreground (dark vs light) for a given scale position. */
function heatFg(t: number, metric: Metric): string {
  if (metric === 'volume') {
    // Deep end is dark → light text; pale end → dark text.
    return t > 0.55 ? 'hsl(245 30% 96%)' : 'hsl(245 30% 18%)';
  }
  // Price mid-band is brightest; extremes a touch darker → dark text reads on all.
  return 'hsl(0 0% 12%)';
}

export default function HeatmapDemoPage() {
  const [metric, setMetric] = useState<Metric>('price');
  const [selected, setSelected] = useState<{ supplier: string; monthIndex: number } | null>(null);

  /* Active min..max across the grid for the current metric. */
  const { min, max } = useMemo(() => {
    const vals = CELLS.filter((c) => (metric === 'price' ? c.price != null : c.volumeKg > 0)).map(
      (c) => (metric === 'price' ? (c.price as number) : c.volumeKg),
    );
    return { min: Math.min(...vals), max: Math.max(...vals) };
  }, [metric]);

  const norm = (v: number) => (max === min ? 0.5 : (v - min) / (max - min));

  /* Marginal-summary ranges (separate scale so they don't blow out the legend). */
  const supplierMargin = useMemo(() => {
    const vals = SUPPLIER_SUMMARIES.map((s) => (metric === 'price' ? s.avgPrice : s.totalVolumeKg));
    return { min: Math.min(...vals), max: Math.max(...vals) };
  }, [metric]);
  const monthMargin = useMemo(() => {
    const vals = MONTHLY_TOTALS.filter((m) => m.volumeKg > 0).map((m) =>
      metric === 'price' ? m.avgPrice : m.volumeKg,
    );
    return { min: Math.min(...vals), max: Math.max(...vals) };
  }, [metric]);
  const normMargin = (v: number, r: { min: number; max: number }) =>
    r.max === r.min ? 0.5 : (v - r.min) / (r.max - r.min);

  const selectedCell: Cell | undefined = selected
    ? cell(selected.supplier, selected.monthIndex)
    : undefined;

  return (
    <div className="animate-blur-in flex flex-col gap-3 p-4">
      {/* ---- Toolbar (header — navbar owns the page title) ---- */}
      <Toolbar metric={metric} onMetric={setMetric} min={min} max={max} />

      {/* ---- Matrix ---- */}
      <div className="rounded-lg border border-border bg-card">
        <div className="overflow-x-auto">
          <div
            className="grid min-w-[860px] text-xs"
            style={{
              // supplier label + 12 months + YTD margin
              gridTemplateColumns: '150px repeat(12, minmax(46px, 1fr)) 78px',
            }}
          >
            {/* Corner */}
            <HeaderCell className="frozen-corner sticky left-0 z-30 justify-start font-semibold text-foreground">
              Supplier
            </HeaderCell>
            {/* Month column headers */}
            {MONTHS.map((m) => (
              <HeaderCell key={m.key} title={m.full} className="justify-center text-muted-foreground">
                {m.label}
              </HeaderCell>
            ))}
            {/* YTD margin header */}
            <HeaderCell className="justify-center font-semibold text-foreground">
              {metric === 'price' ? 'YTD ₱' : 'YTD kg'}
            </HeaderCell>

            {/* Supplier rows */}
            {SUPPLIERS.map((s) => {
              const summary = SUPPLIER_SUMMARIES.find((x) => x.name === s.name)!;
              return (
                <RowGroup
                  key={s.name}
                  supplier={s.name}
                  color={s.color}
                  metric={metric}
                  norm={norm}
                  selected={selected}
                  onSelect={setSelected}
                  summaryVal={metric === 'price' ? summary.avgPrice : summary.totalVolumeKg}
                  summaryNorm={normMargin(
                    metric === 'price' ? summary.avgPrice : summary.totalVolumeKg,
                    supplierMargin,
                  )}
                />
              );
            })}

            {/* Bottom margin row — per-month blended avg / total */}
            <HeaderCell className="frozen-corner-bottom sticky bottom-0 left-0 z-30 justify-start font-semibold text-foreground">
              {metric === 'price' ? 'Blended ₱' : 'Total kg'}
            </HeaderCell>
            {MONTHLY_TOTALS.map((m) => {
              const val = metric === 'price' ? m.avgPrice : m.volumeKg;
              const t = normMargin(val, monthMargin);
              return (
                <MarginCell
                  key={m.monthKey}
                  metric={metric}
                  t={t}
                  title={`${m.full} — ${metric === 'price' ? fmt.php(m.avgPrice) + '/kg blended' : fmt.kg(m.volumeKg) + ' total'}`}
                >
                  {metric === 'price' ? m.avgPrice.toFixed(1) : Math.round(m.volumeKg / 1000) + 't'}
                </MarginCell>
              );
            })}
            {/* Grand corner cell */}
            <MarginCell
              metric={metric}
              t={0.5}
              corner
              title={
                metric === 'price'
                  ? `Portfolio blended ${fmt.php(PORTFOLIO.blendedAvgPrice)}/kg`
                  : `Portfolio total ${fmt.kg(PORTFOLIO.totalVolumeKg)}`
              }
            >
              {metric === 'price'
                ? PORTFOLIO.blendedAvgPrice.toFixed(1)
                : Math.round(PORTFOLIO.totalVolumeKg / 1000) + 't'}
            </MarginCell>
          </div>
        </div>
      </div>

      {/* ---- Detail card (glass) ---- */}
      {selectedCell && (
        <DetailCard
          cell={selectedCell}
          metric={metric}
          onClose={() => setSelected(null)}
        />
      )}

      {/* ---- Footnote ---- */}
      <p className="text-[11px] text-muted-foreground">
        Hatched cells = no deliveries that month (not ₱0). Cell heat is scaled across all active{' '}
        {metric === 'price' ? 'prices' : 'volumes'}; the summary band uses its own scale. Click any
        cell for the breakdown.
      </p>
    </div>
  );

  /* ---------------------------------------------------------------- */
  /* Inner components capture metric/scale closures for brevity.       */
  /* ---------------------------------------------------------------- */

  function RowGroup({
    supplier,
    color,
    norm,
    selected,
    onSelect,
    summaryVal,
    summaryNorm,
  }: {
    supplier: string;
    color: string;
    metric: Metric;
    norm: (v: number) => number;
    selected: { supplier: string; monthIndex: number } | null;
    onSelect: (s: { supplier: string; monthIndex: number } | null) => void;
    summaryVal: number;
    summaryNorm: number;
  }) {
    return (
      <>
        {/* Row header (frozen supplier name) */}
        <div className="frozen-col sticky left-0 z-10 flex h-9 items-center gap-2 border-b border-r border-border bg-card px-2">
          <span
            className="h-2.5 w-2.5 shrink-0 rounded-[3px]"
            style={{ backgroundColor: color }}
            aria-hidden
          />
          <span className="truncate text-[11px] font-medium text-foreground" title={supplier}>
            {supplier}
          </span>
        </div>

        {/* 12 data cells */}
        {MONTHS.map((m, i) => {
          const c = cell(supplier, i);
          const value = metric === 'price' ? c?.price ?? null : c?.volumeKg ?? 0;
          const empty = metric === 'price' ? value == null : value === 0;
          const isSel = selected?.supplier === supplier && selected?.monthIndex === i;

          if (empty) {
            return (
              <button
                key={m.key}
                type="button"
                disabled
                title={`${supplier} · ${m.full} — no deliveries`}
                className="heat-empty h-9 border-b border-r border-border/60"
                aria-label={`${supplier} ${m.full}: no deliveries`}
              />
            );
          }

          const t = norm(value as number);
          const bg = heatHsl(t, metric);
          const fg = heatFg(t, metric);
          return (
            <button
              key={m.key}
              type="button"
              onClick={() => onSelect(isSel ? null : { supplier, monthIndex: i })}
              title={`${supplier} · ${m.full}\n${fmt.php(c?.price)}/kg · ${fmt.kg(c?.volumeKg ?? 0)}`}
              className={cn(
                'relative flex h-9 items-center justify-center border-b border-r border-border/60 font-mono text-[11px] tabular-nums transition-[box-shadow,transform] duration-150 outline-none',
                'hover:z-20 hover:shadow-[inset_0_0_0_2px_var(--ring)] focus-visible:z-20 focus-visible:shadow-[inset_0_0_0_2px_var(--ring)]',
                isSel && 'z-20 shadow-[inset_0_0_0_2px_var(--foreground)]',
              )}
              style={{ backgroundColor: bg, color: fg }}
            >
              {metric === 'price'
                ? (value as number).toFixed(1)
                : Math.round((value as number) / 1000)}
            </button>
          );
        })}

        {/* YTD margin cell */}
        <MarginCell
          metric={metric}
          t={summaryNorm}
          title={
            metric === 'price'
              ? `${supplier} YTD avg ${fmt.php(summaryVal)}/kg`
              : `${supplier} YTD total ${fmt.kg(summaryVal)}`
          }
        >
          {metric === 'price' ? summaryVal.toFixed(1) : Math.round(summaryVal / 1000) + 't'}
        </MarginCell>
      </>
    );
  }
}

/* ------------------------------------------------------------------ */
/* Presentational sub-components                                       */
/* ------------------------------------------------------------------ */

function HeaderCell({
  children,
  className,
  title,
}: {
  children: React.ReactNode;
  className?: string;
  title?: string;
}) {
  return (
    <div
      title={title}
      className={cn(
        'frozen-row sticky top-0 z-20 flex h-8 items-center border-b border-r border-border bg-muted px-2 text-[11px] font-medium',
        className,
      )}
    >
      {children}
    </div>
  );
}

function MarginCell({
  children,
  metric,
  t,
  title,
  corner = false,
}: {
  children?: React.ReactNode;
  metric: Metric;
  t: number;
  title?: string;
  corner?: boolean;
}) {
  const bg = heatHsl(t, metric, true);
  return (
    <div
      title={title}
      className={cn(
        'flex h-9 items-center justify-center border-b border-r border-border font-mono text-[10px] font-semibold tabular-nums text-foreground/80',
        corner && 'font-bold',
      )}
      style={{ backgroundColor: bg }}
    >
      {children}
    </div>
  );
}

function Toolbar({
  metric,
  onMetric,
  min,
  max,
}: {
  metric: Metric;
  onMetric: (m: Metric) => void;
  min: number;
  max: number;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-background/95 px-3 py-2 backdrop-blur supports-[backdrop-filter]:bg-background/60">
      {/* Metric toggle */}
      <div className="inline-flex items-center rounded-md border border-border bg-muted/50 p-0.5 text-xs">
        {(
          [
            ['price', 'Price ₱/kg'],
            ['volume', 'Volume kg'],
          ] as const
        ).map(([key, label]) => (
          <button
            key={key}
            type="button"
            onClick={() => onMetric(key)}
            aria-pressed={metric === key}
            className={cn(
              'rounded px-3 py-1 font-medium transition-colors duration-150',
              metric === key
                ? 'bg-background text-foreground shadow-sm'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {label}
          </button>
        ))}
      </div>

      {/* Color-scale legend */}
      <Legend metric={metric} min={min} max={max} />
    </div>
  );
}

function Legend({ metric, min, max }: { metric: Metric; min: number; max: number }) {
  const stops = Array.from({ length: 9 }, (_, i) => i / 8);
  const gradient = `linear-gradient(to right, ${stops
    .map((t) => heatHsl(t, metric))
    .join(', ')})`;
  const lo = metric === 'price' ? fmt.php(min, 1) : fmt.kg(min);
  const hi = metric === 'price' ? fmt.php(max, 1) : fmt.kg(max);
  return (
    <div className="flex items-center gap-2">
      <span className="text-[10px] font-medium text-muted-foreground">
        {metric === 'price' ? 'cheap' : 'low'}
      </span>
      <span className="font-mono text-[10px] tabular-nums text-foreground/70">{lo}</span>
      <div
        className="h-3 w-40 rounded-sm border border-border/60"
        style={{ background: gradient }}
        aria-hidden
      />
      <span className="font-mono text-[10px] tabular-nums text-foreground/70">{hi}</span>
      <span className="text-[10px] font-medium text-muted-foreground">
        {metric === 'price' ? 'expensive' : 'high'}
      </span>
      {/* Empty swatch key */}
      <span className="ml-2 flex items-center gap-1">
        <span className="heat-empty h-3 w-3 rounded-sm border border-border/60" aria-hidden />
        <span className="text-[10px] text-muted-foreground">none</span>
      </span>
    </div>
  );
}

function DetailCard({
  cell,
  metric,
  onClose,
}: {
  cell: Cell;
  metric: Metric;
  onClose: () => void;
}) {
  const month = MONTHS[cell.monthIndex];
  const supplier = SUPPLIERS.find((s) => s.name === cell.supplier);
  const summary = SUPPLIER_SUMMARIES.find((s) => s.name === cell.supplier)!;
  const monthTotal = MONTHLY_TOTALS[cell.monthIndex];

  // Comparison deltas.
  const priceVsSupplier =
    cell.price != null && summary.avgPrice > 0
      ? ((cell.price - summary.avgPrice) / summary.avgPrice) * 100
      : null;
  const priceVsMonth =
    cell.price != null && monthTotal.avgPrice > 0
      ? ((cell.price - monthTotal.avgPrice) / monthTotal.avgPrice) * 100
      : null;
  const volVsSupplierAvg =
    summary.totalVolumeKg > 0
      ? ((cell.volumeKg - summary.totalVolumeKg / 12) / (summary.totalVolumeKg / 12)) * 100
      : null;
  const volShareOfMonth =
    monthTotal.volumeKg > 0 ? (cell.volumeKg / monthTotal.volumeKg) * 100 : null;

  return (
    <div className="animate-fade-up overflow-hidden rounded-lg border border-border bg-background/95 shadow-lg backdrop-blur-xl supports-[backdrop-filter]:bg-background/80">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-border bg-background/90 px-3 py-2 backdrop-blur-sm">
        <div className="flex items-center gap-2">
          <span
            className="h-2.5 w-2.5 rounded-[3px]"
            style={{ backgroundColor: supplier?.color }}
            aria-hidden
          />
          <span className="text-sm font-semibold text-foreground">{cell.supplier}</span>
          <span className="text-muted-foreground">·</span>
          <span className="text-sm text-foreground">{month.full} 2026</span>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="rounded px-2 py-0.5 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          aria-label="Close detail"
        >
          Close ✕
        </button>
      </div>

      {/* Body: two stat columns */}
      <div className="grid gap-px bg-border sm:grid-cols-2">
        <StatBlock label="₱/kg this month" value={fmt.php(cell.price)} highlight={metric === 'price'}>
          <Delta pct={priceVsSupplier} suffix={`vs ${cell.supplier} YTD`} invert />
          <Delta pct={priceVsMonth} suffix={`vs ${month.label} blended`} invert />
        </StatBlock>
        <StatBlock label="Volume this month" value={fmt.kg(cell.volumeKg)} highlight={metric === 'volume'}>
          <Delta pct={volVsSupplierAvg} suffix="vs supplier monthly avg" />
          {volShareOfMonth != null && (
            <p className="text-[11px] text-muted-foreground">
              <span className="font-mono font-semibold text-foreground tabular-nums">
                {volShareOfMonth.toFixed(1)}%
              </span>{' '}
              of {month.label} total volume
            </p>
          )}
        </StatBlock>
      </div>

      {/* Reference footer */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-border bg-muted/40 px-3 py-1.5 text-[11px] text-muted-foreground">
        <span>
          {cell.supplier} YTD avg{' '}
          <span className="font-mono text-foreground tabular-nums">{fmt.php(summary.avgPrice)}/kg</span>
        </span>
        <span>
          {month.label} blended{' '}
          <span className="font-mono text-foreground tabular-nums">{fmt.php(monthTotal.avgPrice)}/kg</span>
        </span>
        <span>
          {cell.supplier} YTD vol{' '}
          <span className="font-mono text-foreground tabular-nums">{fmt.tonnes(summary.totalVolumeKg)}</span>
        </span>
      </div>
    </div>
  );
}

function StatBlock({
  label,
  value,
  highlight,
  children,
}: {
  label: string;
  value: string;
  highlight?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className={cn('bg-card px-3 py-2', highlight && 'bg-muted/30')}>
      <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className="mt-0.5 font-mono text-lg font-semibold tabular-nums text-foreground">{value}</p>
      <div className="mt-1 space-y-0.5">{children}</div>
    </div>
  );
}

/**
 * A signed % delta line. `invert` flips the color meaning for PRICE (cheaper =
 * good = green), since a higher price is a negative for a buyer.
 */
function Delta({ pct, suffix, invert = false }: { pct: number | null; suffix: string; invert?: boolean }) {
  if (pct == null) return null;
  const good = invert ? pct < 0 : pct > 0;
  const neutral = Math.abs(pct) < 0.05;
  return (
    <p className="text-[11px] text-muted-foreground">
      <span
        className={cn(
          'font-mono font-semibold tabular-nums',
          neutral
            ? 'text-foreground'
            : good
              ? 'text-emerald-600 dark:text-emerald-400'
              : 'text-red-600 dark:text-red-400',
        )}
      >
        {fmt.pct(pct)}
      </span>{' '}
      {suffix}
    </p>
  );
}
