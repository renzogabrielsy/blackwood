'use client';

/**
 * DEMO 1 of 4 — "TERMINAL"
 * A Bloomberg-style dual-axis command view of monthly RC delivery VOLUME vs
 * weighted-average PRICE.
 *
 * Planning-stage design concept. Consumes the shared static mock at
 * ../_mock/data (charcoal-shaped, NOT wired to Supabase). Theme-aware via
 * semantic tokens + a runtime read of CSS variables for recharts SVG chrome.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ComposedChart,
  Bar,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
  ResponsiveContainer,
  Legend,
} from 'recharts';
import {
  MONTHS,
  SUPPLIERS,
  MONTHLY_TOTALS,
  SUPPLIER_SUMMARIES,
  PORTFOLIO,
  fmt,
  type SupplierMeta,
} from '../_mock/data';
import { cn } from '@/lib/utils';

/* ------------------------------------------------------------------ */
/* Theme chrome — recharts SVG needs concrete color strings, not       */
/* Tailwind classes. Read the resolved CSS variables at runtime so the */
/* chart tracks light/dark mode (the .dark class on <html>).           */
/* ------------------------------------------------------------------ */

interface ChartChrome {
  grid: string;
  axis: string;
  axisText: string;
  bar: string;
  line: string;
}

function readChrome(): ChartChrome {
  if (typeof window === 'undefined') {
    return {
      grid: 'rgba(120,120,120,0.18)',
      axis: 'rgba(120,120,120,0.35)',
      axisText: '#71717a',
      bar: '#3f3f46',
      line: '#f59e0b',
    };
  }
  const root = getComputedStyle(document.documentElement);
  const read = (name: string, fallback: string) => {
    const v = root.getPropertyValue(name).trim();
    return v || fallback;
  };
  return {
    grid: read('--border', 'rgba(120,120,120,0.18)'),
    axis: read('--border', 'rgba(120,120,120,0.35)'),
    axisText: read('--muted-foreground', '#71717a'),
    // Volume bars: muted neutral so the price line is the protagonist.
    bar: read('--muted-foreground', '#52525b'),
    // Blended price line: amber — the "terminal ticker" accent.
    line: '#f59e0b',
  };
}

/** Re-reads chart chrome whenever the .dark class on <html> flips. */
function useChartChrome(): ChartChrome {
  const [chrome, setChrome] = useState<ChartChrome>(() => readChrome());
  useEffect(() => {
    const update = () => setChrome(readChrome());
    update();
    const observer = new MutationObserver(update);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class'],
    });
    return () => observer.disconnect();
  }, []);
  return chrome;
}

/* ------------------------------------------------------------------ */
/* Chart data assembly                                                  */
/* ------------------------------------------------------------------ */

interface ChartRow {
  label: string;
  full: string;
  volumeKg: number;
  avgPrice: number | null;
  deliveries: number;
}

/** ALL/BLENDED selection, or a single supplier name for isolation. */
type Selection = 'ALL' | string;

function buildSeries(selection: Selection): ChartRow[] {
  if (selection === 'ALL') {
    return MONTHLY_TOTALS.map((m) => ({
      label: m.label,
      full: m.full,
      volumeKg: m.volumeKg,
      avgPrice: m.avgPrice > 0 ? m.avgPrice : null,
      deliveries: m.deliveries,
    }));
  }
  const summary = SUPPLIER_SUMMARIES.find((s) => s.name === selection);
  if (!summary) return [];
  return MONTHS.map((m, i) => {
    const vol = summary.volumeSeries[i];
    return {
      label: m.label,
      full: m.full,
      volumeKg: vol,
      avgPrice: summary.priceSeries[i],
      deliveries: vol > 0 ? Math.max(1, Math.round(vol / 18000)) : 0,
    };
  });
}

/* ------------------------------------------------------------------ */
/* Custom tooltip                                                       */
/* ------------------------------------------------------------------ */

interface TerminalTooltipProps {
  active?: boolean;
  payload?: Array<{ payload?: ChartRow }>;
  lineColor: string;
}

function TerminalTooltip({ active, payload, lineColor }: TerminalTooltipProps) {
  if (!active || !payload || payload.length === 0) return null;
  const row = payload[0]?.payload;
  if (!row) return null;

  return (
    <div className="min-w-[180px] rounded-md border border-border bg-popover/95 backdrop-blur-lg p-2.5 shadow-xl animate-fade-in">
      <div className="mb-2 flex items-center justify-between border-b border-border/60 pb-1.5">
        <span className="text-xs font-semibold tracking-wide text-foreground">
          {row.full}
        </span>
        <span className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
          2026
        </span>
      </div>
      <dl className="space-y-1.5">
        <div className="flex items-center justify-between gap-4">
          <dt className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
            <span className="inline-block h-2 w-2 rounded-[2px] bg-muted-foreground/70" />
            Volume
          </dt>
          <dd className="font-mono text-xs font-medium tabular-nums text-foreground">
            {fmt.tonnes(row.volumeKg)}
          </dd>
        </div>
        <div className="flex items-center justify-between gap-4">
          <dt className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
            <span
              className="inline-block h-2 w-2 rounded-full"
              style={{ backgroundColor: lineColor }}
            />
            Wtd. price
          </dt>
          <dd className="font-mono text-xs font-medium tabular-nums text-foreground">
            {fmt.php(row.avgPrice)}
            <span className="ml-0.5 text-[10px] text-muted-foreground">/kg</span>
          </dd>
        </div>
        <div className="flex items-center justify-between gap-4">
          <dt className="text-[11px] text-muted-foreground">Deliveries</dt>
          <dd className="font-mono text-xs font-medium tabular-nums text-foreground">
            {row.deliveries > 0 ? `~${row.deliveries}` : '—'}
          </dd>
        </div>
      </dl>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* KPI tile                                                             */
/* ------------------------------------------------------------------ */

interface KpiTileProps {
  label: string;
  value: string;
  sub?: string;
  accent?: boolean;
  tone?: 'default' | 'warn';
}

function KpiTile({ label, value, sub, accent, tone = 'default' }: KpiTileProps) {
  return (
    <div
      className={cn(
        'hover-lift relative flex min-w-0 flex-col justify-between overflow-hidden rounded-md border px-3 py-2.5',
        accent
          ? 'border-amber-500/40 bg-amber-500/5'
          : 'border-border bg-card',
      )}
    >
      {accent && (
        <span className="absolute inset-y-0 left-0 w-0.5 bg-amber-500" />
      )}
      <div className="flex items-center gap-1.5">
        <span className="text-[10px] font-medium uppercase tracking-widest text-muted-foreground">
          {label}
        </span>
        {tone === 'warn' && (
          <span className="text-amber-500" aria-hidden>
            ⚠
          </span>
        )}
      </div>
      <div
        className={cn(
          'mt-1 font-mono text-lg font-semibold leading-none tabular-nums',
          tone === 'warn' ? 'text-amber-600 dark:text-amber-400' : 'text-foreground',
        )}
      >
        {value}
      </div>
      {sub && (
        <div className="mt-1 truncate text-[11px] text-muted-foreground">{sub}</div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Supplier toggle chip                                                 */
/* ------------------------------------------------------------------ */

interface ChipProps {
  active: boolean;
  color?: string;
  onClick: () => void;
  children: React.ReactNode;
}

function Chip({ active, color, onClick, children }: ChipProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-medium tracking-wide transition-all duration-150',
        active
          ? 'border-foreground/30 bg-foreground/10 text-foreground shadow-sm'
          : 'border-border bg-transparent text-muted-foreground hover:bg-muted/60 hover:text-foreground',
      )}
    >
      {color && (
        <span
          className="inline-block h-2 w-2 rounded-full"
          style={{
            backgroundColor: color,
            opacity: active ? 1 : 0.55,
          }}
        />
      )}
      {children}
    </button>
  );
}

/* ------------------------------------------------------------------ */
/* Page                                                                 */
/* ------------------------------------------------------------------ */

export default function TerminalDemoPage() {
  const [selection, setSelection] = useState<Selection>('ALL');
  const chrome = useChartChrome();

  const data = useMemo(() => buildSeries(selection), [selection]);

  const activeSupplier: SupplierMeta | undefined = useMemo(
    () => (selection === 'ALL' ? undefined : SUPPLIERS.find((s) => s.name === selection)),
    [selection],
  );

  // The price line follows the isolated supplier's color; amber for blended.
  const lineColor = activeSupplier?.color ?? chrome.line;
  const barColor = activeSupplier ? `${activeSupplier.color}` : chrome.bar;

  const select = useCallback((s: Selection) => setSelection(s), []);

  const riser = PORTFOLIO.steepestRiser;

  // Active-view headline numbers (recompute for the isolated supplier).
  const view = useMemo(() => {
    if (selection === 'ALL') {
      return {
        totalVolumeKg: PORTFOLIO.totalVolumeKg,
        avgPrice: PORTFOLIO.blendedAvgPrice,
        lowPrice: PORTFOLIO.yearLowPrice,
        highPrice: PORTFOLIO.yearHighPrice,
        scopeLabel: 'All suppliers · blended',
      };
    }
    const s = SUPPLIER_SUMMARIES.find((x) => x.name === selection)!;
    return {
      totalVolumeKg: s.totalVolumeKg,
      avgPrice: s.avgPrice,
      lowPrice: s.minPrice,
      highPrice: s.maxPrice,
      scopeLabel: `${s.name} · ${fmt.pct(s.priceChangePct)} YTD`,
    };
  }, [selection]);

  return (
    <div className="animate-blur-in flex h-full flex-col gap-3 p-4">
      {/* ---- Contextual sub-header / toolbar ---- */}
      <div className="flex flex-wrap items-end justify-between gap-3 border-b border-border pb-3">
        <div className="flex items-center gap-2">
          <span className="inline-flex h-5 items-center rounded-sm bg-amber-500/15 px-1.5 font-mono text-[10px] font-bold uppercase tracking-widest text-amber-600 dark:text-amber-400">
            Terminal
          </span>
          <span className="text-sm font-medium text-foreground">
            Price &amp; Volume
          </span>
          <span className="hidden text-xs text-muted-foreground sm:inline">
            — monthly delivery volume vs weighted-average ₱/kg
          </span>
        </div>
        <div className="flex items-center gap-3 font-mono text-[11px] text-muted-foreground">
          <span className="flex items-center gap-1.5">
            <span className="h-2.5 w-2.5 rounded-[2px] bg-muted-foreground/70" />
            Volume
          </span>
          <span className="flex items-center gap-1.5">
            <span
              className="h-2.5 w-2.5 rounded-full"
              style={{ backgroundColor: lineColor }}
            />
            ₱/kg
          </span>
        </div>
      </div>

      {/* ---- KPI rail ---- */}
      <div className="stagger-children grid grid-cols-2 gap-2 lg:grid-cols-4">
        <KpiTile
          label="YTD Volume"
          value={fmt.tonnes(view.totalVolumeKg)}
          sub={view.scopeLabel}
        />
        <KpiTile
          label={selection === 'ALL' ? 'Blended ₱/kg' : 'Wtd. ₱/kg'}
          value={fmt.php(view.avgPrice)}
          sub="volume-weighted"
        />
        <KpiTile
          label="Price Range"
          value={`${fmt.php(view.lowPrice)} → ${fmt.php(view.highPrice)}`}
          sub="year low → high"
        />
        <KpiTile
          label="Supplier to Watch"
          value={riser.name}
          sub={`${fmt.php(riser.minPrice)} → ${fmt.php(riser.maxPrice)} · ${fmt.pct(
            riser.priceChangePct,
          )}`}
          accent
          tone="warn"
        />
      </div>

      {/* ---- Supplier toggle chips ---- */}
      <div className="flex flex-wrap items-center gap-1.5">
        <Chip active={selection === 'ALL'} onClick={() => select('ALL')}>
          All / Blended
        </Chip>
        <span className="mx-0.5 h-4 w-px bg-border" aria-hidden />
        {SUPPLIERS.map((s) => (
          <Chip
            key={s.name}
            active={selection === s.name}
            color={s.color}
            onClick={() => select(s.name)}
          >
            {s.name}
          </Chip>
        ))}
      </div>

      {/* ---- Hero ComposedChart ---- */}
      <div className="animate-fade-up relative min-h-[320px] flex-1 rounded-md border border-border bg-card p-3">
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart
            data={data}
            margin={{ top: 8, right: 12, bottom: 4, left: 4 }}
            barCategoryGap="28%"
          >
            <CartesianGrid
              strokeDasharray="2 4"
              stroke={chrome.grid}
              vertical={false}
            />
            <XAxis
              dataKey="label"
              tick={{ fontSize: 11, fill: chrome.axisText, fontFamily: 'var(--font-mono, monospace)' }}
              tickLine={false}
              axisLine={{ stroke: chrome.axis }}
              dy={4}
            />
            <YAxis
              yAxisId="volume"
              orientation="left"
              tick={{ fontSize: 10, fill: chrome.axisText, fontFamily: 'var(--font-mono, monospace)' }}
              tickLine={false}
              axisLine={false}
              width={44}
              tickFormatter={(v: number) => `${Math.round(v / 1000)}t`}
            />
            <YAxis
              yAxisId="price"
              orientation="right"
              domain={['dataMin - 2', 'dataMax + 2']}
              tick={{ fontSize: 10, fill: chrome.axisText, fontFamily: 'var(--font-mono, monospace)' }}
              tickLine={false}
              axisLine={false}
              width={48}
              tickFormatter={(v: number) => `₱${v.toFixed(0)}`}
            />
            <Tooltip
              cursor={{ fill: chrome.grid, opacity: 0.4 }}
              content={<TerminalTooltip lineColor={lineColor} />}
            />
            <Legend
              verticalAlign="top"
              height={24}
              iconType="plainline"
              wrapperStyle={{
                fontSize: 11,
                fontFamily: 'var(--font-mono, monospace)',
                color: chrome.axisText,
              }}
            />
            <Bar
              yAxisId="volume"
              dataKey="volumeKg"
              name="Volume (kg)"
              fill={barColor}
              fillOpacity={0.55}
              radius={[2, 2, 0, 0]}
              isAnimationActive={false}
            />
            <Line
              yAxisId="price"
              type="monotone"
              dataKey="avgPrice"
              name="Wtd. ₱/kg"
              stroke={lineColor}
              strokeWidth={2}
              dot={{ r: 2.5, fill: lineColor, strokeWidth: 0 }}
              activeDot={{ r: 4, strokeWidth: 0 }}
              connectNulls
              isAnimationActive={false}
            />
          </ComposedChart>
        </ResponsiveContainer>
      </div>

      {/* ---- Footer note ---- */}
      <p className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
        Design concept · static mock data · left axis = volume (t) · right axis = ₱/kg ·{' '}
        {selection === 'ALL'
          ? 'showing blended portfolio'
          : `isolated: ${selection}`}
      </p>
    </div>
  );
}
