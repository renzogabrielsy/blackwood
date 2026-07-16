'use client';

/**
 * DEMO 4 of 4 — "ANALYST BRIEF" (CLIENT COMPONENT)
 *
 * An executive dashboard for the monthly Price & Volume review: a KPI strip, a
 * hero year-over-year price/volume story chart, and a dense RC IN–style Monthly
 * Deliveries ledger. Calm, scannable, at-a-glance.
 *
 * Now wired to LIVE `deliveries` data: the server component (page.tsx) calls
 * fetchMonthlyDeliveryAnalytics() and passes the normalized payload here as
 * props. This component holds ALL interactivity (KPI strip, hero chart, monthly
 * table, year pickers). It imports ONLY the `fmt` formatters from the mock —
 * never mock DATA. Theme-aware via semantic tokens + a runtime read of CSS
 * variables for recharts SVG chrome.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ComposedChart,
  Area,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
  ResponsiveContainer,
  ReferenceDot,
  type TooltipContentProps,
} from 'recharts';
import { fmt } from '../_mock/data';
import type { MonthlyDeliveryRow, Totals } from './actions';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { errorToast } from '@/lib/toast';
import { cn } from '@/lib/utils';
import { useCellSelection } from '@/lib/hooks/use-cell-selection';
import {
  useCellAggregation,
  type AggregationType,
} from '@/lib/hooks/use-cell-aggregation';
import { useStatusBar } from '@/components/providers/status-bar-context';

/* ------------------------------------------------------------------ */
/* Props                                                              */
/* ------------------------------------------------------------------ */

interface AnalystBriefClientProps {
  /** Years that actually have deliveries, ascending. */
  years: number[];
  /** Per-year 12-month axis (always 12 rows, monthIndex 0..11, zero-filled). */
  byYear: Record<number, MonthlyDeliveryRow[]>;
  /** Per-year footer rollup. */
  totalsByYear: Record<number, Totals>;
  /** Whether the caller may see ₱ data. When false, all ₱ fields are null. */
  canViewPrices: boolean;
  /** Set when the server-side fetch threw. */
  error?: string;
}

/* ------------------------------------------------------------------ */
/* Year color palette — THEME-AWARE, assigned by INDEX into the real    */
/* `years` array. Years are not a fixed set, so we map an ordered,       */
/* maximally-distinct palette over whatever years come back.            */
/*                                                                      */
/* Design goals (Renzo's feedback):                                      */
/*  - Maximize HUE separation so adjacent years never look alike. The    */
/*    order leads with a CMY-style spread (sky → amber → pink → emerald  */
/*    → violet → orange → red) so the first ~4 entries read as totally   */
/*    different colors.                                                  */
/*  - DARK mode → BRIGHT (~Tailwind 400) so each line pops off zinc-950. */
/*  - LIGHT mode → DEEPER (~Tailwind 600) so nothing washes out on white.*/
/*  - The FOCUS year (first slot of the assignment) gets the strongest,  */
/*    most prominent hue (sky/cyan).                                     */
/* ------------------------------------------------------------------ */

/** BRIGHT palette for DARK mode (~Tailwind 400). Index 0 = focus year. */
const YEAR_PALETTE_DARK = [
  '#38bdf8', // sky-400
  '#fbbf24', // amber-400
  '#f472b6', // pink-400
  '#34d399', // emerald-400
  '#a78bfa', // violet-400
  '#fb923c', // orange-400
  '#f87171', // red-400
] as const;

/** DEEPER palette for LIGHT mode (~Tailwind 600). Index 0 = focus year. */
const YEAR_PALETTE_LIGHT = [
  '#0284c7', // sky-600
  '#d97706', // amber-600
  '#db2777', // pink-600
  '#059669', // emerald-600
  '#7c3aed', // violet-600
  '#ea580c', // orange-600
  '#dc2626', // red-600
] as const;

/**
 * Build a stable year→hue map from the real `years` array, picking the palette
 * that matches the active theme. The LATEST year (the default focus) always
 * gets the FIRST, most prominent hue; earlier years walk the palette in
 * reverse-chronological order so the most recent comparison years stay the most
 * distinct. A year's area + line always share the SAME hue.
 */
function buildYearColors(
  years: number[],
  dark: boolean,
): Record<number, string> {
  const map: Record<number, string> = {};
  if (years.length === 0) return map;
  const palette = dark ? YEAR_PALETTE_DARK : YEAR_PALETTE_LIGHT;
  // Walk newest → oldest so the latest year takes palette[0] (focus hue) and
  // adjacent recent years get the maximally-distinct early slots.
  const newestFirst = [...years].reverse();
  newestFirst.forEach((year, i) => {
    map[year] = palette[i % palette.length];
  });
  return map;
}

/* ------------------------------------------------------------------ */
/* Theme chrome — recharts SVG needs concrete color strings, not       */
/* Tailwind classes. Read resolved CSS variables at runtime so the     */
/* charts track light/dark mode (the .dark class on <html>).           */
/* ------------------------------------------------------------------ */

interface ChartChrome {
  /** True when the .dark class is on <html>. Drives the year palette. */
  dark: boolean;
  grid: string;
  axisText: string;
  /** Year price LOW marker (good — cheaper). */
  low: string;
  /** Year price HIGH marker (bad — pricier). */
  high: string;
}

function readChrome(): ChartChrome {
  // SSR/first-paint fallback: assume LIGHT so we don't flash bright-on-white.
  // The real theme is resolved client-side after mount (see useChartChrome).
  const fallback: ChartChrome = {
    dark: false,
    grid: 'rgba(120,120,120,0.16)',
    axisText: '#71717a',
    low: '#16a34a',
    high: '#dc2626',
  };
  if (typeof window === 'undefined') return fallback;
  const dark = document.documentElement.classList.contains('dark');
  const root = getComputedStyle(document.documentElement);
  const read = (name: string, fb: string) => {
    const v = root.getPropertyValue(name).trim();
    return v || fb;
  };
  return {
    dark,
    grid: read('--border', fallback.grid),
    axisText: read('--muted-foreground', fallback.axisText),
    // Brighter green/red in dark mode so the LOW/HIGH dots pop off zinc-950.
    low: dark ? '#4ade80' : '#16a34a',
    high: dark ? '#f87171' : '#dc2626',
  };
}

/** Re-reads chart chrome whenever the .dark class on <html> flips. */
function useChartChrome(): ChartChrome {
  // Start from the light fallback to match SSR output (no hydration mismatch),
  // then resolve the real theme on mount via the effect below.
  const [chrome, setChrome] = useState<ChartChrome>(() => ({
    dark: false,
    grid: 'rgba(120,120,120,0.16)',
    axisText: '#71717a',
    low: '#16a34a',
    high: '#dc2626',
  }));
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
/* Derived hero data — MULTI-YEAR overlay on a shared 12-month axis.    */
/* ------------------------------------------------------------------ */

const MONTH_LABELS = [
  ['Jan', 'January'], ['Feb', 'February'], ['Mar', 'March'], ['Apr', 'April'],
  ['May', 'May'], ['Jun', 'June'], ['Jul', 'July'], ['Aug', 'August'],
  ['Sep', 'September'], ['Oct', 'October'], ['Nov', 'November'], ['Dec', 'December'],
] as const;

/**
 * One row per month (Jan…Dec) with per-year keyed price + volume fields, so
 * recharts can overlay an Area + Line pair per selected year on the same X axis.
 * Keys: `vol_<year>` (volume kg) and `php_<year>` (₱/kg). Volume is always a
 * number (0 for empty months → flat area); price is `undefined` for null months
 * so connectNulls bridges the gap.
 */
type HeroRow = {
  label: string;
  full: string;
  monthIndex: number;
} & Record<string, number | string | undefined>;

const volKey = (year: number) => `vol_${year}`;
const phpKey = (year: number) => `php_${year}`;

/** Build the merged month-axis dataset for the given set of years. */
function buildHeroRows(
  years: number[],
  byYear: Record<number, MonthlyDeliveryRow[]>,
): HeroRow[] {
  return MONTH_LABELS.map(([label, full], i) => {
    const row: HeroRow = { label, full, monthIndex: i };
    for (const year of years) {
      const r = byYear[year]?.[i];
      if (!r) continue;
      // Volume shows 0 for empty months (flat area). Price skips nulls so the
      // line connects across gaps instead of dropping to zero.
      row[volKey(year)] = r.weightKg;
      if (r.phpPerKg != null) row[phpKey(year)] = r.phpPerKg;
    }
    return row;
  });
}

interface YearExtremum {
  label: string;
  full: string;
  phpPerKg: number;
}

/**
 * The month rows that hit a year's blended low / high PRICE. Returns null when
 * the year has no priced months (e.g. price-gated, or sparse year with no
 * priced data) — markers are simply skipped in that case.
 */
function yearLowHigh(
  year: number,
  byYear: Record<number, MonthlyDeliveryRow[]>,
): { low: YearExtremum; high: YearExtremum } | null {
  const priced = (byYear[year] ?? []).filter((r) => r.phpPerKg != null);
  if (priced.length === 0) return null;
  const low = priced.reduce((lo, r) => (r.phpPerKg! < lo.phpPerKg! ? r : lo));
  const high = priced.reduce((hi, r) => (r.phpPerKg! > hi.phpPerKg! ? r : hi));
  return {
    low: { label: low.label, full: low.full, phpPerKg: low.phpPerKg! },
    high: { label: high.label, full: high.full, phpPerKg: high.phpPerKg! },
  };
}

interface DotLabelRenderProps {
  viewBox?: { x?: number; y?: number };
}

/**
 * Render fn for ReferenceDot labels — recharts passes the dot's viewBox.
 * recharts' `ImplicitLabelType` types the render fn param as `any`; we accept a
 * narrow shape internally and cast at the boundary so the rest stays typed.
 */
function makeDotLabel(
  text: string,
  color: string,
  place: 'top' | 'bottom',
): (props: DotLabelRenderProps) => React.ReactElement {
  const DotLabel = (props: DotLabelRenderProps) => {
    const x = props.viewBox?.x ?? 0;
    const y = props.viewBox?.y ?? 0;
    return (
      <text
        x={x}
        y={place === 'top' ? y - 12 : y + 18}
        fill={color}
        fontSize={10}
        fontFamily="var(--font-mono, monospace)"
        fontWeight={600}
        textAnchor="middle"
      >
        {text}
      </text>
    );
  };
  DotLabel.displayName = 'DotLabel';
  return DotLabel;
}

/* ------------------------------------------------------------------ */
/* Hero tooltip                                                         */
/* ------------------------------------------------------------------ */

function HeroTooltip({
  active,
  payload,
  years,
  focusYear,
  colors,
}: Partial<TooltipContentProps<number, string>> & {
  /** Selected years, in display order (focus first). */
  years: number[];
  focusYear: number;
  colors: Record<number, string>;
}) {
  if (!active || !payload || payload.length === 0) return null;
  const row = payload[0]?.payload as HeroRow | undefined;
  if (!row) return null;
  // Only show years that actually have data for this month.
  const present = years.filter(
    (y) => row[phpKey(y)] != null || row[volKey(y)] != null,
  );
  if (present.length === 0) return null;
  return (
    <div className="min-w-[220px] rounded-md border border-border bg-popover/95 p-2.5 shadow-xl backdrop-blur-lg animate-fade-in">
      <div className="mb-2 flex items-center justify-between border-b border-border/60 pb-1.5">
        <span className="text-xs font-semibold tracking-wide text-foreground">
          {row.full}
        </span>
        <span className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
          year-over-year
        </span>
      </div>
      <dl className="space-y-2">
        {present.map((year) => {
          const php = row[phpKey(year)] as number | undefined;
          const vol = row[volKey(year)] as number | undefined;
          const color = colors[year];
          return (
            <div key={year} className="space-y-0.5">
              <div className="flex items-center gap-1.5">
                <span
                  className="inline-block h-2 w-2 rounded-full"
                  style={{ backgroundColor: color }}
                />
                <span
                  className={cn(
                    'font-mono text-[11px] font-semibold tracking-wide',
                    year === focusYear
                      ? 'text-foreground'
                      : 'text-muted-foreground',
                  )}
                >
                  {year}
                </span>
                {year === focusYear && (
                  <span className="font-mono text-[9px] uppercase tracking-widest text-muted-foreground">
                    focus
                  </span>
                )}
              </div>
              <div className="flex items-center justify-between gap-4 pl-3.5">
                <dt className="text-[11px] text-muted-foreground">₱/kg</dt>
                <dd className="font-mono text-xs font-semibold tabular-nums text-foreground">
                  {php == null ? '—' : fmt.php(php)}
                </dd>
              </div>
              <div className="flex items-center justify-between gap-4 pl-3.5">
                <dt className="text-[11px] text-muted-foreground">Volume IN</dt>
                <dd className="font-mono text-xs font-medium tabular-nums text-foreground">
                  {vol == null ? '—' : fmt.tonnes(vol)}
                </dd>
              </div>
            </div>
          );
        })}
      </dl>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* KPI card                                                            */
/* ------------------------------------------------------------------ */

interface StatCardProps {
  label: string;
  value: string;
  sub?: string;
  tone?: 'default' | 'good' | 'warn';
  /** Optional swatch dot (e.g. year color). */
  swatch?: string;
}

function StatCard({ label, value, sub, tone = 'default', swatch }: StatCardProps) {
  return (
    <div
      className={cn(
        'hover-lift relative flex flex-col justify-between overflow-hidden rounded-lg border bg-card px-4 py-3.5',
        tone === 'warn'
          ? 'border-red-500/30'
          : tone === 'good'
            ? 'border-emerald-500/30'
            : 'border-border',
      )}
    >
      {tone !== 'default' && (
        <span
          className={cn(
            'absolute inset-y-0 left-0 w-0.5',
            tone === 'warn' ? 'bg-red-500' : 'bg-emerald-500',
          )}
        />
      )}
      <div className="flex items-center gap-1.5">
        {swatch && (
          <span
            className="inline-block h-2 w-2 rounded-full"
            style={{ backgroundColor: swatch }}
          />
        )}
        <span className="text-[10px] font-medium uppercase tracking-widest text-muted-foreground">
          {label}
        </span>
      </div>
      <div
        className={cn(
          'mt-2 font-mono text-xl font-semibold leading-none tabular-nums',
          tone === 'warn'
            ? 'text-red-600 dark:text-red-400'
            : tone === 'good'
              ? 'text-emerald-600 dark:text-emerald-400'
              : 'text-foreground',
        )}
      >
        {value}
      </div>
      {sub && (
        <div className="mt-1.5 truncate text-[11px] text-muted-foreground">
          {sub}
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Monthly Deliveries table — dense RC IN–style ledger                 */
/* ------------------------------------------------------------------ */

/** Accounting-format ₱ cell: symbol pinned left, number pinned right. */
function AccountingCell({
  value,
  dp = 2,
  className,
}: {
  value: number;
  dp?: number;
  className?: string;
}) {
  return (
    <div className={cn('flex items-baseline justify-between gap-1 tabular-nums', className)}>
      <span className="text-muted-foreground">₱</span>
      <span>
        {value.toLocaleString('en-PH', {
          minimumFractionDigits: dp,
          maximumFractionDigits: dp,
        })}
      </span>
    </div>
  );
}

/** Plain right-aligned numeric, fixed decimals, thousands separators. */
function num(value: number, dp: number): string {
  return value.toLocaleString('en-PH', {
    minimumFractionDigits: dp,
    maximumFractionDigits: dp,
  });
}

/** Render a nullable numeric value as an em-dash when null, else fixed dp. */
function numOrDash(value: number | null, dp: number): string {
  return value == null ? '—' : num(value, dp);
}

/* Lab metric columns rendered in canonical RC IN order. The map keeps the
   header, body, and footer cells in lockstep so the column order can't drift. */
const LAB_COLUMNS: {
  key: keyof Pick<
    MonthlyDeliveryRow,
    'mc' | 'grit' | 'vm' | 'ash' | 'fc' | 'bdAstm' | 'bdJis'
  >;
  label: string;
  dp: number;
}[] = [
  { key: 'mc', label: 'MC', dp: 2 },
  { key: 'grit', label: 'Grit', dp: 2 },
  { key: 'vm', label: 'VM', dp: 2 },
  { key: 'ash', label: 'Ash', dp: 2 },
  { key: 'fc', label: 'FC', dp: 2 },
  { key: 'bdAstm', label: 'BD ASTM', dp: 3 },
  { key: 'bdJis', label: 'BD JIS', dp: 3 },
];

/* ------------------------------------------------------------------ */
/* Excel-style cell-range selection — column model                     */
/* ------------------------------------------------------------------ */
/*
 * The selectable grid is the 12 MONTH rows × the NUMERIC data columns only.
 * The Month label column is the ROW HEADER → never part of the col grid.
 *
 * `NumericColumn` is a stable, ordered descriptor of one selectable column:
 *   - `get(row)`     → the numeric value for a given month row (null = empty,
 *                      excluded from sums/averages).
 *   - `calc`         → the recommended aggregation per the rc-out pattern
 *                      (SUM for additive cols, AVERAGE for rate/quality cols).
 *   - `priceOnly`    → present only when ₱ data is visible. The visible column
 *                      list filters these out when prices are hidden, so col
 *                      indices stay correct (Deliveries is always col 0, the
 *                      ₱ columns are simply absent when gated).
 */
interface NumericColumn {
  key: string;
  get: (row: MonthlyDeliveryRow) => number | null;
  calc: AggregationType;
  priceOnly?: boolean;
}

/** Full ordered numeric-column list, mirroring the body's left-to-right order.
 *  The two ₱ columns are flagged priceOnly and dropped when prices are hidden. */
const NUMERIC_COLUMNS: NumericColumn[] = [
  { key: 'deliveries', get: (r) => r.deliveries, calc: 'SUM' },
  { key: 'sacks', get: (r) => r.sacks, calc: 'SUM' },
  { key: 'weight', get: (r) => r.weightKg, calc: 'SUM' },
  { key: 'mc', get: (r) => r.mc, calc: 'AVERAGE' },
  { key: 'grit', get: (r) => r.grit, calc: 'AVERAGE' },
  { key: 'vm', get: (r) => r.vm, calc: 'AVERAGE' },
  { key: 'ash', get: (r) => r.ash, calc: 'AVERAGE' },
  { key: 'fc', get: (r) => r.fc, calc: 'AVERAGE' },
  { key: 'bdAstm', get: (r) => r.bdAstm, calc: 'AVERAGE' },
  { key: 'bdJis', get: (r) => r.bdJis, calc: 'AVERAGE' },
  { key: 'phpPerKg', get: (r) => r.phpPerKg, calc: 'AVERAGE', priceOnly: true },
  { key: 'phpTotal', get: (r) => r.phpTotal, calc: 'SUM', priceOnly: true },
];

/** Selected-cell styling — mirrors GridCell.tsx (range bg + anchor ring). */
function selectedCellClasses(selected: boolean, anchor: boolean): string {
  return cn(
    selected && 'bg-primary/10 dark:bg-primary/20',
    anchor && 'ring-2 ring-primary ring-inset',
  );
}

function MonthlyDeliveriesTable({
  rows,
  totals,
  focusYear,
  showPrices,
}: {
  rows: MonthlyDeliveryRow[];
  totals: Totals;
  focusYear: number;
  showPrices: boolean;
}) {
  const { setCellSelectionCount, setCellAggregates } = useStatusBar();

  // Rainy-season tint cue: flag the highest-moisture months subtly (only when
  // there are any priced/labelled MC values to compare against).
  const mcValues = rows.map((r) => r.mc).filter((v): v is number => v != null);
  const mcThreshold = mcValues.length ? Math.max(...mcValues) - 0.4 : Infinity;

  const numCell = 'px-2 py-1 text-right font-mono tabular-nums';
  const headCell =
    'px-2 py-1 text-right text-[10px] font-semibold uppercase tracking-wide text-muted-foreground';

  /* ---- Cell selection wiring (Excel-style sum/avg/count popup) -------
   * The selectable grid is rows = the 12 months, cols = the VISIBLE numeric
   * columns (₱ columns drop out when prices are hidden, keeping col indices
   * stable: Deliveries is always col 0). The Month label is the row header and
   * is NOT part of the col grid, so every column here is selectable. */
  const visibleNumericColumns = useMemo(
    () => NUMERIC_COLUMNS.filter((c) => showPrices || !c.priceOnly),
    [showPrices],
  );

  const scrollContainerRef = useRef<HTMLDivElement>(null);

  const cellSelection = useCellSelection({
    rowCount: rows.length,
    colCount: visibleNumericColumns.length,
    // Every numeric column is selectable; the Month row header is excluded by
    // simply not being part of this col grid.
    scrollContainerRef,
  });

  const selectionSize = cellSelection.getSelectionSize();

  // Stabilize the selection range BY VALUE. useCellSelection rebuilds `range` as
  // a fresh object every render; feeding that identity into the aggregation memo
  // and the status-bar push effect made the effect re-fire on every context
  // update (the push itself re-renders this consumer) — an infinite loop that
  // trips React's max update depth. Keying on the coords keeps the reference
  // stable until the selection actually changes.
  const r = cellSelection.range;
  const rangeKey = r ? `${r.startRow}:${r.startCol}:${r.endRow}:${r.endCol}` : '';
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const stableRange = useMemo(() => r, [rangeKey]);

  const getNumericCellValue = useMemo(
    () =>
      (rowIdx: number, colIdx: number): number | null => {
        const row = rows[rowIdx];
        const col = visibleNumericColumns[colIdx];
        if (!row || !col) return null;
        return col.get(row);
      },
    [rows, visibleNumericColumns],
  );

  const getColumnDefaultCalcType = useMemo(
    () =>
      (colIdx: number): AggregationType | null =>
        visibleNumericColumns[colIdx]?.calc ?? null,
    [visibleNumericColumns],
  );

  const aggregates = useCellAggregation({
    range: stableRange,
    getNumericCellValue,
    getColumnDefaultCalcType,
  });

  // Push count + aggregates to the shared status bar. FloatingStatusBar (mounted
  // app-wide in app-shell) shows the sum/avg/count popup only when count > 1.
  useEffect(() => {
    const count = stableRange ? selectionSize : 0;
    setCellSelectionCount(count);
    setCellAggregates(count > 1 ? aggregates : null);
  }, [
    stableRange,
    selectionSize,
    aggregates,
    setCellSelectionCount,
    setCellAggregates,
  ]);

  // Reset on context change (focusYear swap brings a new `rows` array) so a
  // stale range from the previous year never lingers.
  const { clearSelection } = cellSelection;
  useEffect(() => {
    clearSelection();
    setCellSelectionCount(0);
    setCellAggregates(null);
    // `rows` identity changes when focusYear changes (new byYear[year] array).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows]);

  // Click anywhere outside the table deselects the current range (Excel-style
  // click-away) — but ignore clicks on the stats popup bar and any portaled
  // menu/popover, so changing the SUM/AVG calc type doesn't wipe the selection.
  useEffect(() => {
    const onMouseDown = (e: MouseEvent) => {
      const target = e.target as Element | null;
      if (!target) return;
      if (scrollContainerRef.current?.contains(target)) return; // inside the table
      if (target.closest('[data-floating-status-bar]')) return; // the sum/avg popup
      if (target.closest('[data-radix-popper-content-wrapper]')) return; // portaled menus
      clearSelection();
      setCellSelectionCount(0);
      setCellAggregates(null);
    };
    document.addEventListener('mousedown', onMouseDown);
    return () => document.removeEventListener('mousedown', onMouseDown);
  }, [clearSelection, setCellSelectionCount, setCellAggregates]);

  // On unmount (navigating away from /price-demos/demo4), clear the status bar
  // so the popup doesn't show stale stats elsewhere in the app.
  useEffect(() => {
    return () => {
      setCellSelectionCount(0);
      setCellAggregates(null);
    };
  }, [setCellSelectionCount, setCellAggregates]);

  /** Build the selection handlers + merged styling for a numeric body cell at
   *  (rowIdx, colKey). `base` is the cell's existing class string; the selection
   *  ring/bg + cursor-cell are layered on top. Spread the result onto the <td>. */
  const cellSelProps = (rowIdx: number, colKey: string, base: string) => {
    const colIdx = visibleNumericColumns.findIndex((c) => c.key === colKey);
    if (colIdx === -1) return { className: base };
    return {
      onMouseDown: (e: React.MouseEvent) => {
        e.preventDefault();
        cellSelection.handleCellMouseDown(rowIdx, colIdx, e);
        scrollContainerRef.current?.focus({ preventScroll: true });
      },
      onMouseEnter: cellSelection.isDragging
        ? () => cellSelection.handleCellMouseEnter(rowIdx, colIdx)
        : undefined,
      className: cn(
        base,
        'cursor-cell',
        selectedCellClasses(
          cellSelection.isSelected(rowIdx, colIdx),
          cellSelection.isAnchor(rowIdx, colIdx),
        ),
      ),
    };
  };

  return (
    <div className="overflow-x-auto rounded-lg border border-border bg-card">
      {/* Bounded height so the sticky header + footer have something to pin
          against; the body scrolls between them like the real master log.
          Focusable + keyboard-wired for Shift+Arrow / Ctrl+A / Esc selection;
          select-none so drag-select never highlights text. */}
      <div
        ref={scrollContainerRef}
        tabIndex={0}
        onKeyDown={cellSelection.handleKeyDown}
        className="max-h-[520px] overflow-y-auto outline-none select-none"
      >
        <table className="w-full table-fixed border-collapse text-xs">
          <colgroup>
            <col className="w-[120px]" />{/* Month */}
            <col className="w-[90px]" />{/* Deliveries */}
            <col className="w-[80px]" />{/* Sacks */}
            <col className="w-[110px]" />{/* Weight */}
            <col className="w-[64px]" />{/* MC */}
            <col className="w-[64px]" />{/* Grit */}
            <col className="w-[64px]" />{/* VM */}
            <col className="w-[64px]" />{/* Ash */}
            <col className="w-[64px]" />{/* FC */}
            <col className="w-[80px]" />{/* BD ASTM */}
            <col className="w-[80px]" />{/* BD JIS */}
            {showPrices && <col className="w-[96px]" />}{/* ₱/kg */}
            {showPrices && <col className="w-[132px]" />}{/* ₱ Total */}
          </colgroup>

          {/* Sticky glass header (floats over scrolling body → glass is correct here) */}
          <thead className="sticky top-0 z-10 bg-muted/90 backdrop-blur-sm">
            <tr className="border-b border-border">
              <th
                scope="col"
                className="px-2 py-1.5 text-left text-[10px] font-semibold uppercase tracking-wide text-muted-foreground"
              >
                Month
              </th>
              <th scope="col" className={headCell}>
                Deliveries
              </th>
              <th scope="col" className={headCell}>
                Sacks
              </th>
              <th scope="col" className={headCell}>
                Weight (kg)
              </th>
              {LAB_COLUMNS.map((c) => (
                <th key={c.key} scope="col" className={headCell}>
                  {c.label}
                </th>
              ))}
              {showPrices && (
                <th scope="col" className={headCell}>
                  ₱/kg
                </th>
              )}
              {showPrices && (
                <th scope="col" className={headCell}>
                  ₱ Total
                </th>
              )}
            </tr>
          </thead>

          <tbody>
            {rows.map((r, rowIdx) => {
              const empty = r.weightKg === 0;
              const humid =
                !empty && r.mc != null && r.mc >= mcThreshold;
              const priceCell = 'px-2 py-1 font-mono';
              return (
                <tr
                  key={r.monthKey}
                  className={cn(
                    'h-8 border-b border-border/60 transition-all duration-150 hover:bg-muted/50',
                    humid && 'bg-amber-500/[0.06] dark:bg-amber-400/[0.05]',
                    empty && 'text-muted-foreground/60',
                  )}
                >
                  <th
                    scope="row"
                    className="px-2 py-1 text-left text-xs font-medium text-foreground"
                  >
                    {r.full}
                  </th>
                  <td {...cellSelProps(rowIdx, 'deliveries', numCell)}>
                    {empty ? '—' : r.deliveries.toLocaleString('en-PH')}
                  </td>
                  <td {...cellSelProps(rowIdx, 'sacks', numCell)}>
                    {empty ? '—' : r.sacks.toLocaleString('en-PH')}
                  </td>
                  {/* Weight: plain right-aligned mono number. */}
                  <td {...cellSelProps(rowIdx, 'weight', numCell)}>
                    {empty ? '—' : num(r.weightKg, 0)}
                  </td>
                  {LAB_COLUMNS.map((c) => (
                    <td key={c.key} {...cellSelProps(rowIdx, c.key, numCell)}>
                      {numOrDash(r[c.key], c.dp)}
                    </td>
                  ))}
                  {showPrices && (
                    <td {...cellSelProps(rowIdx, 'phpPerKg', priceCell)}>
                      {r.phpPerKg == null ? (
                        <div className="text-right tabular-nums">—</div>
                      ) : (
                        <AccountingCell value={r.phpPerKg} dp={2} />
                      )}
                    </td>
                  )}
                  {showPrices && (
                    <td {...cellSelProps(rowIdx, 'phpTotal', priceCell)}>
                      {r.phpTotal == null ? (
                        <div className="text-right tabular-nums">—</div>
                      ) : (
                        <AccountingCell value={r.phpTotal} dp={2} />
                      )}
                    </td>
                  )}
                </tr>
              );
            })}
          </tbody>

          {/* Frozen FOOTER total row — OPAQUE mirror of the header (NOT glass):
              it sits over scrolling content, so solid bg-muted + .frozen-row-bottom. */}
          <tfoot>
            <tr className="frozen-row-bottom frozen-edge-top h-9 bg-muted font-semibold">
              <th
                scope="row"
                className="bg-muted px-2 py-1 text-left text-xs font-bold uppercase tracking-wide text-foreground"
              >
                {focusYear} Total
              </th>
              <td className="bg-muted px-2 py-1 text-right font-mono tabular-nums text-foreground">
                {totals.deliveries.toLocaleString('en-PH')}
              </td>
              <td className="bg-muted px-2 py-1 text-right font-mono tabular-nums text-foreground">
                {totals.sacks.toLocaleString('en-PH')}
              </td>
              <td className="bg-muted px-2 py-1 text-right font-mono tabular-nums text-foreground">
                {num(totals.weightKg, 0)}
              </td>
              {LAB_COLUMNS.map((c) => (
                <td
                  key={c.key}
                  className="bg-muted px-2 py-1 text-right font-mono tabular-nums text-foreground"
                  title="volume-weighted average"
                >
                  {numOrDash(totals[c.key], c.dp)}
                </td>
              ))}
              {showPrices && (
                <td className="bg-muted px-2 py-1 font-mono text-foreground" title="volume-weighted average">
                  {totals.phpPerKg == null ? (
                    <div className="text-right tabular-nums">—</div>
                  ) : (
                    <AccountingCell value={totals.phpPerKg} dp={2} />
                  )}
                </td>
              )}
              {showPrices && (
                <td className="bg-muted px-2 py-1 font-mono text-foreground">
                  {totals.phpTotal == null ? (
                    <div className="text-right tabular-nums">—</div>
                  ) : (
                    <AccountingCell value={totals.phpTotal} dp={2} />
                  )}
                </td>
              )}
            </tr>
          </tfoot>
        </table>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Year controls                                                       */
/* ------------------------------------------------------------------ */

/**
 * Dropdown single-year picker for the TABLE. Sets focusYear, which also drives
 * the always-on/emphasized series on the hero graph above. Changing focus does
 * NOT add anything to the graph's comparison set.
 */
function YearDropdown({
  value,
  years,
  colors,
  onChange,
}: {
  value: number;
  years: number[];
  colors: Record<number, string>;
  onChange: (year: number) => void;
}) {
  return (
    <Select
      value={String(value)}
      onValueChange={(v) => onChange(Number(v))}
    >
      <SelectTrigger
        size="sm"
        aria-label="Focus year"
        className="w-[120px] font-mono text-xs tabular-nums"
      >
        <SelectValue placeholder="Year" />
      </SelectTrigger>
      <SelectContent className="bg-popover/95 backdrop-blur-lg">
        {years.map((year) => (
          <SelectItem
            key={year}
            value={String(year)}
            className="font-mono text-xs tabular-nums"
          >
            <span className="flex items-center gap-2">
              <span
                className="inline-block h-2 w-2 rounded-full"
                style={{ backgroundColor: colors[year] }}
              />
              {year}
            </span>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/**
 * Multi-select year toggle chips for the graph overlay. Each chip is tinted
 * with its hue. The focusYear chip is always active and marked "focus" —
 * clicking it is a NO-OP (change focus via the table dropdown). Other chips
 * add/remove their overlay from the comparison set.
 */
function YearChips({
  comparisonYears,
  focusYear,
  years,
  colors,
  onToggle,
}: {
  comparisonYears: Set<number>;
  focusYear: number;
  years: number[];
  colors: Record<number, string>;
  onToggle: (year: number) => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-1.5" aria-label="Compare years">
      {years.map((year) => {
        const isFocus = year === focusYear;
        // A chip is "on" when it's the focus year (always shown) OR explicitly
        // pinned in the comparison set.
        const on = isFocus || comparisonYears.has(year);
        const color = colors[year];
        return (
          <button
            key={year}
            type="button"
            aria-pressed={on}
            disabled={isFocus}
            title={
              isFocus
                ? 'Focus year (set via the table dropdown)'
                : on
                  ? 'Click to remove from comparison'
                  : 'Click to add to comparison'
            }
            onClick={() => onToggle(year)}
            className={cn(
              'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 font-mono text-[11px] font-medium tabular-nums transition-all duration-150',
              on
                ? 'text-foreground'
                : 'border-border text-muted-foreground hover:text-foreground',
              isFocus && 'cursor-default',
            )}
            style={
              on
                ? {
                    borderColor: color,
                    backgroundColor: `${color}1f`, // ~12% tint
                  }
                : undefined
            }
          >
            <span
              className={cn(
                'inline-block h-2 w-2 rounded-full transition-opacity',
                on ? 'opacity-100' : 'opacity-40',
              )}
              style={{ backgroundColor: color }}
            />
            {year}
            {isFocus && (
              <span className="text-[9px] uppercase tracking-widest text-muted-foreground">
                focus
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Error state                                                         */
/* ------------------------------------------------------------------ */

function ErrorState({ message }: { message: string }) {
  // Fire the canonical persistent + copyable error toast once on mount.
  useEffect(() => {
    errorToast('Failed to load the Analyst Brief', { description: message });
  }, [message]);

  const copy = () => {
    void navigator.clipboard.writeText(message);
  };

  return (
    <div className="animate-fade-up mx-auto flex w-full max-w-[1400px] flex-col gap-4 p-5 lg:p-6">
      <div className="rounded-lg border border-red-500/40 bg-red-500/5 p-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h3 className="text-sm font-semibold text-red-600 dark:text-red-400">
              Couldn&apos;t load delivery analytics
            </h3>
            <p className="mt-1 font-mono text-xs text-muted-foreground break-words">
              {message}
            </p>
          </div>
          <button
            type="button"
            onClick={copy}
            className="shrink-0 rounded-md border border-border bg-background px-2.5 py-1 text-xs font-medium text-foreground transition-colors hover:bg-muted"
          >
            Copy
          </button>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Page                                                                */
/* ------------------------------------------------------------------ */

export default function AnalystBriefClient({
  years,
  byYear,
  totalsByYear,
  canViewPrices,
  error,
}: AnalystBriefClientProps) {
  const chrome = useChartChrome();

  // Defer the recharts chart until after mount. ResponsiveContainer renders an
  // empty tree on the server (no measured width) but a full chart with internal
  // useId calls on the client — that shifts every downstream auto-generated id
  // (including the year <Select>'s aria-controls) and breaks hydration. Gating
  // it keeps SSR and the first client render identical, then the chart mounts
  // client-side.
  const [chartReady, setChartReady] = useState(false);
  useEffect(() => setChartReady(true), []);

  // Theme-aware palette: recomputes when the user flips light/dark so the
  // chart series, legend, chips, area fills, markers and KPI accents all update
  // live. `chrome.dark` is resolved client-side after mount (no hydration flash).
  const colors = useMemo(
    () => buildYearColors(years, chrome.dark),
    [years, chrome.dark],
  );
  const latestYear = years.length ? years[years.length - 1] : 0;

  /* ---- State model -------------------------------------------------
   * focusYear        — the single year driving the TABLE; always shown +
   *                    emphasized on the graph. Set via the dropdown.
   * comparisonYears  — ONLY years the user explicitly toggled via the graph
   *                    chips. NEVER contains focusYear. Default: empty.
   *
   * The graph renders the de-duped union [focusYear, ...comparisonYears].
   * Changing focusYear does NOT touch comparisonYears — so when focus moves
   * 2026→2025, the old 2026 disappears UNLESS it was explicitly pinned. This is
   * the fix for the old "years pile up forever" bug. ------------------------ */
  const [focusYear, setFocusYear] = useState<number>(latestYear);
  const [comparisonYears, setComparisonYears] = useState<Set<number>>(
    () => new Set<number>(),
  );

  const toggleComparisonYear = (year: number) => {
    // The focus year is driven by the dropdown — its chip is a no-op here.
    if (year === focusYear) return;
    setComparisonYears((prev) => {
      const next = new Set(prev);
      if (next.has(year)) next.delete(year);
      else next.add(year);
      return next;
    });
  };

  if (error) {
    return <ErrorState message={error} />;
  }

  if (years.length === 0) {
    return (
      <div className="animate-fade-up mx-auto flex w-full max-w-[1400px] flex-col gap-4 p-5 lg:p-6">
        <div className="rounded-lg border border-border bg-card p-8 text-center">
          <p className="text-sm font-medium text-foreground">No delivery data yet</p>
          <p className="mt-1 text-xs text-muted-foreground">
            Once deliveries are recorded, the Analyst Brief will populate here.
          </p>
        </div>
      </div>
    );
  }

  // Years to render on the graph: focus FIRST (for legend/tooltip order), then
  // explicit comparison years (excluding focus), in the canonical ascending
  // order from `years`.
  const comparison = years.filter(
    (y) => y !== focusYear && comparisonYears.has(y),
  );
  const orderedYears = [focusYear, ...comparison];
  // Render order: non-focus first (underneath / lighter), focus last (on top).
  const renderYears = [...comparison, focusYear];

  const heroRows = buildHeroRows(renderYears, byYear);
  const focusExtremes = yearLowHigh(focusYear, byYear);
  // Low/high markers only in single-year (focus-only) mode AND when prices exist.
  const showMarkers =
    comparison.length === 0 && canViewPrices && focusExtremes != null;

  const focusRows = byYear[focusYear] ?? [];
  const focusTotals = totalsByYear[focusYear];

  /* ---- KPI derivations (from REAL focus-year data) ------------------ */
  // Focus-year total volume (tonnes).
  const focusVolumeKg = focusTotals?.weightKg ?? 0;
  // Focus-year blended ₱/kg (already volume-weighted in SQL; gated upstream).
  const focusBlendedPrice = focusTotals?.phpPerKg ?? null;

  // Focus-year price high/low month (over priced months only).
  const focusPriceRange = focusExtremes;

  // YoY change vs the previous AVAILABLE year (not just focusYear-1, since some
  // years are missing, e.g. 2021). Plain computation — cheap array lookup, no
  // hook (we're past early returns, so a hook here would break rule-of-hooks).
  const focusIdx = years.indexOf(focusYear);
  const prevYear = focusIdx > 0 ? years[focusIdx - 1] : null;

  const prevTotals = prevYear != null ? totalsByYear[prevYear] : undefined;

  const volumeYoYPct =
    prevTotals && prevTotals.weightKg > 0
      ? ((focusVolumeKg - prevTotals.weightKg) / prevTotals.weightKg) * 100
      : null;

  const priceYoYPct =
    prevTotals?.phpPerKg != null &&
    prevTotals.phpPerKg > 0 &&
    focusBlendedPrice != null
      ? ((focusBlendedPrice - prevTotals.phpPerKg) / prevTotals.phpPerKg) * 100
      : null;

  const focusDeliveries = focusTotals?.deliveries ?? 0;

  return (
    <div className="animate-blur-in mx-auto flex w-full max-w-[1400px] flex-col gap-6 p-5 lg:p-6">
      {/* ---- Contextual sub-header ---- */}
      <header className="flex flex-wrap items-end justify-between gap-3 border-b border-border pb-4">
        <div className="flex items-center gap-2.5">
          <span className="inline-flex h-5 items-center rounded-sm bg-teal-500/15 px-1.5 font-mono text-[10px] font-bold uppercase tracking-widest text-teal-700 dark:text-teal-300">
            Brief
          </span>
          <h2 className="text-sm font-medium text-foreground">
            Price &amp; Volume — FY {focusYear} Review
          </h2>
          <span className="hidden text-xs text-muted-foreground sm:inline">
            — the year in one read
          </span>
        </div>
        <span className="font-mono text-[11px] uppercase tracking-widest text-muted-foreground">
          {fmt.tonnes(focusVolumeKg)} · {focusDeliveries.toLocaleString('en-PH')} deliveries
        </span>
      </header>

      {/* ---- KPI strip (re-derived from REAL focus-year data) ---- */}
      <section
        className={cn(
          'stagger-children grid grid-cols-2 gap-3 md:grid-cols-3',
          canViewPrices ? 'xl:grid-cols-5' : 'xl:grid-cols-3',
        )}
        aria-label="Focus-year headline metrics"
      >
        <StatCard
          label={`${focusYear} Volume`}
          value={fmt.tonnes(focusVolumeKg)}
          sub="raw charcoal received"
          swatch={colors[focusYear]}
        />
        <StatCard
          label="Volume YoY"
          value={volumeYoYPct == null ? '—' : fmt.pct(volumeYoYPct)}
          sub={prevYear == null ? 'no prior year' : `vs ${prevYear}`}
          tone={
            volumeYoYPct == null
              ? 'default'
              : volumeYoYPct >= 0
                ? 'good'
                : 'warn'
          }
        />
        {canViewPrices && (
          <StatCard
            label="Blended ₱/kg"
            value={fmt.php(focusBlendedPrice)}
            sub="volume-weighted, all suppliers"
          />
        )}
        {canViewPrices && (
          <StatCard
            label="Price Range"
            value={
              focusPriceRange == null
                ? '—'
                : `${fmt.php(focusPriceRange.low.phpPerKg)} → ${fmt.php(focusPriceRange.high.phpPerKg)}`
            }
            sub={
              focusPriceRange == null
                ? 'no priced months'
                : `low ${focusPriceRange.low.label} · high ${focusPriceRange.high.label}`
            }
          />
        )}
        {canViewPrices && (
          <StatCard
            label="Price YoY"
            value={priceYoYPct == null ? '—' : fmt.pct(priceYoYPct)}
            sub={prevYear == null ? 'no prior year' : `blended vs ${prevYear}`}
            tone={
              priceYoYPct == null
                ? 'default'
                : // Rising price is the concern → warn; falling → good.
                  priceYoYPct > 0
                  ? 'warn'
                  : 'good'
            }
          />
        )}
      </section>

      {/* ---- Hero: year-over-year seasonal comparison ---- */}
      <section className="animate-fade-up rounded-xl border border-border bg-card p-4 lg:p-5">
        <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
          <div>
            <h3 className="text-sm font-semibold tracking-tight text-foreground">
              Price &amp; volume, year over year
            </h3>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {canViewPrices
                ? 'Volume-weighted ₱/kg (line) over total volume received (area), '
                : 'Total volume received (area), '}
              overlaid across years on a shared month axis. Each year owns a hue.
            </p>
          </div>
          {/* Year toggle chips — drive the graph comparison set. */}
          <YearChips
            comparisonYears={comparisonYears}
            focusYear={focusYear}
            years={years}
            colors={colors}
            onToggle={toggleComparisonYear}
          />
        </div>

        {/* Legend keyed BY YEAR (focus first). */}
        <div className="mb-2 flex flex-wrap items-center gap-x-4 gap-y-1 font-mono text-[11px] text-muted-foreground">
          {orderedYears.map((year) => (
            <span key={year} className="flex items-center gap-1.5">
              <span
                className="h-2.5 w-3.5 rounded-[2px]"
                style={{ backgroundColor: colors[year] }}
              />
              <span
                className={cn(
                  'tabular-nums',
                  year === focusYear && 'font-semibold text-foreground',
                )}
              >
                {year}
              </span>
              {year === focusYear && (
                <span className="text-[9px] uppercase tracking-widest">focus</span>
              )}
            </span>
          ))}
          <span className="ml-auto flex items-center gap-3 text-[10px] uppercase tracking-widest">
            <span>area = volume</span>
            {canViewPrices && <span>line = ₱/kg</span>}
          </span>
        </div>

        <div className="h-[300px] w-full sm:h-[340px]">
          {chartReady ? (
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart
              data={heroRows}
              margin={{ top: 16, right: 16, bottom: 4, left: 4 }}
            >
              <defs>
                {renderYears.map((year) => {
                  const color = colors[year];
                  // Area fills sit UNDER the line (the primary signal). Low-alpha
                  // fills vanish on zinc-950, so dark mode runs a touch hotter
                  // (~0.24/0.20) than light (~0.18/0.12). Focus > comparison.
                  const isFocusArea = year === focusYear;
                  const top = chrome.dark
                    ? isFocusArea
                      ? 0.26
                      : 0.2
                    : isFocusArea
                      ? 0.18
                      : 0.12;
                  return (
                    <linearGradient
                      key={year}
                      id={`heroVolume_${year}`}
                      x1="0"
                      y1="0"
                      x2="0"
                      y2="1"
                    >
                      <stop offset="0%" stopColor={color} stopOpacity={top} />
                      <stop offset="100%" stopColor={color} stopOpacity={0.01} />
                    </linearGradient>
                  );
                })}
              </defs>
              <CartesianGrid
                strokeDasharray="2 5"
                stroke={chrome.grid}
                vertical={false}
              />
              <XAxis
                dataKey="label"
                tick={{ fontSize: 11, fill: chrome.axisText, fontFamily: 'var(--font-mono, monospace)' }}
                tickLine={false}
                axisLine={{ stroke: chrome.grid }}
                dy={4}
              />
              <YAxis
                yAxisId="volume"
                orientation="right"
                tick={{ fontSize: 10, fill: chrome.axisText, fontFamily: 'var(--font-mono, monospace)' }}
                tickLine={false}
                axisLine={false}
                width={42}
                tickFormatter={(v: number) => `${Math.round(v / 1000)}t`}
              />
              {canViewPrices && (
                <YAxis
                  yAxisId="price"
                  orientation="left"
                  domain={['dataMin - 1.5', 'dataMax + 1.5']}
                  tick={{ fontSize: 10, fill: chrome.axisText, fontFamily: 'var(--font-mono, monospace)' }}
                  tickLine={false}
                  axisLine={false}
                  width={46}
                  tickFormatter={(v: number) => `₱${v.toFixed(0)}`}
                />
              )}
              <Tooltip
                cursor={{ stroke: chrome.grid, strokeWidth: 1 }}
                content={
                  <HeroTooltip
                    years={orderedYears}
                    focusYear={focusYear}
                    colors={colors}
                  />
                }
              />
              {/* One Area per year — volume. Non-focus first (underneath), focus
                  last (on top). */}
              {renderYears.map((year) => (
                <Area
                  key={`area-${year}`}
                  yAxisId="volume"
                  type="monotone"
                  dataKey={volKey(year)}
                  stroke="none"
                  fill={`url(#heroVolume_${year})`}
                  connectNulls
                  isAnimationActive={false}
                />
              ))}
              {/* One Line per year — price (only when prices are visible). */}
              {canViewPrices &&
                renderYears.map((year) => {
                  const color = colors[year];
                  const isFocus = year === focusYear;
                  return (
                    <Line
                      key={`line-${year}`}
                      yAxisId="price"
                      type="monotone"
                      dataKey={phpKey(year)}
                      stroke={color}
                      strokeWidth={isFocus ? 2.5 : 1.75}
                      // Comparison lines stay near full-color so the distinct
                      // hues read; width (not opacity) is the focus cue.
                      strokeOpacity={isFocus ? 1 : 0.85}
                      dot={
                        isFocus
                          ? { r: 2.5, fill: color, strokeWidth: 0 }
                          : false
                      }
                      activeDot={{ r: 5, strokeWidth: 0, fill: color }}
                      connectNulls
                      isAnimationActive={false}
                    />
                  );
                })}
              {/* Low/high markers only in single-year (focus-only) priced mode. */}
              {showMarkers && focusExtremes && (
                <ReferenceDot
                  yAxisId="price"
                  x={focusExtremes.low.label}
                  y={focusExtremes.low.phpPerKg}
                  r={5}
                  fill={chrome.low}
                  stroke="var(--card)"
                  strokeWidth={2}
                  label={
                    makeDotLabel(
                      `LOW ${fmt.php(focusExtremes.low.phpPerKg)}`,
                      chrome.low,
                      'bottom',
                    ) as (props: unknown) => React.ReactElement
                  }
                />
              )}
              {showMarkers && focusExtremes && (
                <ReferenceDot
                  yAxisId="price"
                  x={focusExtremes.high.label}
                  y={focusExtremes.high.phpPerKg}
                  r={5}
                  fill={chrome.high}
                  stroke="var(--card)"
                  strokeWidth={2}
                  label={
                    makeDotLabel(
                      `HIGH ${fmt.php(focusExtremes.high.phpPerKg)}`,
                      chrome.high,
                      'top',
                    ) as (props: unknown) => React.ReactElement
                  }
                />
              )}
            </ComposedChart>
          </ResponsiveContainer>
          ) : null}
        </div>
      </section>

      {/* ---- Monthly Deliveries ledger ---- */}
      <section aria-label={`Monthly deliveries for FY ${focusYear}`}>
        <div className="mb-3 flex flex-wrap items-end justify-between gap-3">
          <div>
            <h3 className="text-sm font-semibold tracking-tight text-foreground">
              Monthly Deliveries — FY {focusYear}
            </h3>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Per-month rollup in the RC IN ledger format. Lab metrics
              {canViewPrices ? ' and ₱/kg are' : ' are'} volume-weighted; sacks,
              weight{canViewPrices ? ' and ₱ total' : ''} are summed.
            </p>
          </div>
          {/* Dropdown year picker — sets focusYear (also drives the graph above). */}
          <YearDropdown
            value={focusYear}
            years={years}
            colors={colors}
            onChange={setFocusYear}
          />
        </div>
        {focusTotals ? (
          <MonthlyDeliveriesTable
            rows={focusRows}
            totals={focusTotals}
            focusYear={focusYear}
            showPrices={canViewPrices}
          />
        ) : (
          <div className="rounded-lg border border-border bg-card p-6 text-center text-xs text-muted-foreground">
            No data for {focusYear}.
          </div>
        )}
      </section>

      {/* ---- Footer note ---- */}
      <p className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
        Live `deliveries` data ·{' '}
        {canViewPrices
          ? 'blended line is volume-weighted ₱/kg · '
          : 'prices hidden for your role · '}
        monthly lab metrics{canViewPrices ? ' & ₱/kg' : ''} are volume-weighted
        averages
      </p>
    </div>
  );
}
