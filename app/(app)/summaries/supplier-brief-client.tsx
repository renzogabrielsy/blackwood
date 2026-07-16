'use client';

/**
 * SUMMARIES — "BY SUPPLIER" VIEW (CLIENT COMPONENT)
 *
 * The supplier-dimension twin of the period view (analyst-brief-client). Where
 * the period view overlays YEARS on a 12-month axis, this view fixes a single
 * year and overlays SUPPLIERS across a selectable period axis (months or
 * quarters). It mirrors the period view's technical patterns verbatim so it
 * inherits the same bug fixes:
 *   • chartReady mount-gate around every recharts ResponsiveContainer (avoids a
 *     hydration useId crash from ResponsiveContainer rendering empty on server).
 *   • stableRange cell-selection wiring keyed on coords (avoids an infinite
 *     render loop from the status-bar push re-firing the aggregation effect).
 *   • <colgroup> with comments glued to <col/> (no whitespace text nodes).
 *   • click-away mousedown deselect that ignores the floating status bar +
 *     portaled radix popper content.
 *   • theme-aware useChartChrome + bright(dark)/deep(light) palette + area-fill
 *     opacities.
 *   • Excel-Standard table: sticky glass header, opaque pinned tfoot.
 *
 * Scales to MANY suppliers (2026 has ~41). The supplier-on-graph control is a
 * removable-chip + searchable-add-dropdown combo capped at ~6 graphed suppliers;
 * the full supplier list lives in the table, not as a chip wall.
 *
 * ROLLUP NOTE: this component rolls the DB's per-MONTH pre-weighted figures up
 * to quarters / selected-period spans CLIENT-SIDE by VOLUME-WEIGHTING the monthly
 * values (price & lab re-weighted by each month's volumeKg; volume/sacks/
 * deliveries summed). It is NOT a from-scratch TS average of raw rows — it
 * re-weights the server's already-weighted monthly numbers, which is exact for
 * additive volume weights.
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
  type TooltipContentProps,
} from 'recharts';
import { ChevronsUpDown, Plus, X } from 'lucide-react';
import { fmt } from '../price-demos/_mock/data';
import type {
  SupplierMonthRow,
  SupplierSubgroup,
  SupplierYearSummary,
} from './actions';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from '@/components/ui/sheet';
import { errorToast } from '@/lib/toast';
import { cn } from '@/lib/utils';
import { useCellSelection } from '@/lib/hooks/use-cell-selection';
import {
  useCellAggregation,
  type AggregationType,
} from '@/lib/hooks/use-cell-aggregation';
import { useStatusBar } from '@/components/providers/status-bar-context';
import { SupplierCardsMobile } from './supplier-cards-mobile';

/* ------------------------------------------------------------------ */
/* Props                                                              */
/* ------------------------------------------------------------------ */

interface SupplierBriefClientProps {
  /** Years that actually have deliveries, ascending. */
  years: number[];
  /** Per-year supplier list, SORTED BY yearly volume (weightKg) DESC. */
  byYear: Record<number, SupplierYearSummary[]>;
  /** Whether the caller may see ₱ data. When false, all ₱ fields are null. */
  canViewPrices: boolean;
  /** Set when the server-side fetch threw. */
  error?: string;
}

/* ------------------------------------------------------------------ */
/* Supplier color palette — THEME-AWARE, assigned by INDEX into the     */
/* currently-graphed supplier list. Same bright(dark)/deep(light) idea   */
/* as the period view's year palette; here it cycles per supplier.       */
/* ------------------------------------------------------------------ */

/** BRIGHT palette for DARK mode (~Tailwind 400). */
const SUPPLIER_PALETTE_DARK = [
  '#38bdf8', // sky-400
  '#fbbf24', // amber-400
  '#f472b6', // pink-400
  '#34d399', // emerald-400
  '#a78bfa', // violet-400
  '#fb923c', // orange-400
  '#f87171', // red-400
] as const;

/** DEEPER palette for LIGHT mode (~Tailwind 600). */
const SUPPLIER_PALETTE_LIGHT = [
  '#0284c7', // sky-600
  '#d97706', // amber-600
  '#db2777', // pink-600
  '#059669', // emerald-600
  '#7c3aed', // violet-600
  '#ea580c', // orange-600
  '#dc2626', // red-600
] as const;

/** Max suppliers overlaid on the hero graph at once (legibility cap). */
const MAX_GRAPHED = 6;

/* ------------------------------------------------------------------ */
/* Theme chrome — recharts SVG needs concrete color strings, not        */
/* Tailwind classes. Read resolved CSS variables at runtime so the      */
/* charts track light/dark mode (the .dark class on <html>).            */
/* ------------------------------------------------------------------ */

interface ChartChrome {
  dark: boolean;
  grid: string;
  axisText: string;
}

function readChrome(): ChartChrome {
  const fallback: ChartChrome = {
    dark: false,
    grid: 'rgba(120,120,120,0.16)',
    axisText: '#71717a',
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
  };
}

/** Re-reads chart chrome whenever the .dark class on <html> flips. */
function useChartChrome(): ChartChrome {
  const [chrome, setChrome] = useState<ChartChrome>(() => ({
    dark: false,
    grid: 'rgba(120,120,120,0.16)',
    axisText: '#71717a',
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
/* Period model — months or quarters                                    */
/* ------------------------------------------------------------------ */

type Granularity = 'months' | 'quarters';

const MONTH_LABELS = [
  ['Jan', 'January'], ['Feb', 'February'], ['Mar', 'March'], ['Apr', 'April'],
  ['May', 'May'], ['Jun', 'June'], ['Jul', 'July'], ['Aug', 'August'],
  ['Sep', 'September'], ['Oct', 'October'], ['Nov', 'November'], ['Dec', 'December'],
] as const;

const QUARTER_LABELS = [
  ['Q1', 'Q1 (Jan–Mar)'], ['Q2', 'Q2 (Apr–Jun)'],
  ['Q3', 'Q3 (Jul–Sep)'], ['Q4', 'Q4 (Oct–Dec)'],
] as const;

/** A period "slot" the user can select: an id, short label, full label, and the
 *  set of monthIndexes (0..11) it spans. Months span one; quarters span three. */
interface PeriodSlot {
  id: string;
  label: string;
  full: string;
  /** monthIndex values (0..11) that fall in this slot. */
  monthIndexes: number[];
}

/** Build the ordered list of selectable period slots for a granularity. */
function buildPeriodSlots(granularity: Granularity): PeriodSlot[] {
  if (granularity === 'quarters') {
    return QUARTER_LABELS.map(([label, full], q) => ({
      id: label,
      label,
      full,
      monthIndexes: [q * 3, q * 3 + 1, q * 3 + 2],
    }));
  }
  return MONTH_LABELS.map(([label, full], i) => ({
    id: label,
    label,
    full,
    monthIndexes: [i],
  }));
}

/* ------------------------------------------------------------------ */
/* Volume-weighted rollup — the heart of months→quarters/selection.     */
/* ------------------------------------------------------------------ */

/** An aggregated bucket — same shape as a month row, minus the index. Volume,
 *  sacks, deliveries are summed; price + lab are volume-weighted over months
 *  that carry data; ₱ total is summed over priced months. Null when no data. */
interface RolledMetrics {
  deliveries: number;
  sacks: number;
  weightKg: number;
  mc: number | null;
  grit: number | null;
  vm: number | null;
  ash: number | null;
  fc: number | null;
  bdAstm: number | null;
  bdJis: number | null;
  phpPerKg: number | null;
  phpTotal: number | null;
}

const EMPTY_ROLLED: RolledMetrics = {
  deliveries: 0, sacks: 0, weightKg: 0,
  mc: null, grit: null, vm: null, ash: null, fc: null, bdAstm: null, bdJis: null,
  phpPerKg: null, phpTotal: null,
};

const WEIGHTED_LAB_KEYS = ['mc', 'grit', 'vm', 'ash', 'fc', 'bdAstm', 'bdJis'] as const;
type WeightedLabKey = (typeof WEIGHTED_LAB_KEYS)[number];

/**
 * Roll a set of monthly rows (the DB's already-per-month-weighted figures) up
 * into one bucket by VOLUME-WEIGHTING. This re-weights the server's weighted
 * monthly values — NOT a from-scratch average of raw delivery rows:
 *   • deliveries / sacks / weightKg → simple SUM.
 *   • lab + ₱/kg → Σ(value · monthVolume) / Σ(monthVolume), counting only
 *     months where that value is non-null (a month with null price doesn't
 *     drag the blended price toward zero — it's simply excluded).
 *   • ₱ total → SUM over months that carry a ₱ total.
 * Returns EMPTY_ROLLED when there are no contributing months.
 */
function rollMonths(rows: SupplierMonthRow[]): RolledMetrics {
  if (rows.length === 0) return EMPTY_ROLLED;

  let deliveries = 0;
  let sacks = 0;
  let weightKg = 0;

  // Per-metric weighted accumulators: numerator Σ(value·vol), denominator Σ(vol).
  const labNum: Record<WeightedLabKey, number> = {
    mc: 0, grit: 0, vm: 0, ash: 0, fc: 0, bdAstm: 0, bdJis: 0,
  };
  const labDen: Record<WeightedLabKey, number> = {
    mc: 0, grit: 0, vm: 0, ash: 0, fc: 0, bdAstm: 0, bdJis: 0,
  };
  let priceNum = 0;
  let priceDen = 0;
  let phpTotal = 0;
  let phpTotalCount = 0;

  for (const r of rows) {
    deliveries += r.deliveries;
    sacks += r.sacks;
    weightKg += r.weightKg;

    const w = r.weightKg;
    for (const key of WEIGHTED_LAB_KEYS) {
      const v = r[key];
      if (v != null && w > 0) {
        labNum[key] += v * w;
        labDen[key] += w;
      }
    }
    if (r.phpPerKg != null && w > 0) {
      priceNum += r.phpPerKg * w;
      priceDen += w;
    }
    if (r.phpTotal != null) {
      phpTotal += r.phpTotal;
      phpTotalCount += 1;
    }
  }

  const weighted = (num: number, den: number): number | null =>
    den > 0 ? num / den : null;

  return {
    deliveries,
    sacks,
    weightKg,
    mc: weighted(labNum.mc, labDen.mc),
    grit: weighted(labNum.grit, labDen.grit),
    vm: weighted(labNum.vm, labDen.vm),
    ash: weighted(labNum.ash, labDen.ash),
    fc: weighted(labNum.fc, labDen.fc),
    bdAstm: weighted(labNum.bdAstm, labDen.bdAstm),
    bdJis: weighted(labNum.bdJis, labDen.bdJis),
    phpPerKg: weighted(priceNum, priceDen),
    phpTotal: phpTotalCount > 0 ? phpTotal : null,
  };
}

/** Pull the subset of a supplier's monthly rows that fall in the selected
 *  monthIndex set, then roll them up. */
function rollSelected(
  supplier: SupplierYearSummary,
  selectedMonthIndexes: Set<number>,
): RolledMetrics {
  const rows = supplier.monthly.filter((m) => selectedMonthIndexes.has(m.monthIndex));
  return rollMonths(rows);
}

/* ------------------------------------------------------------------ */
/* Hero chart data — overlay graphed suppliers across selected periods. */
/* ------------------------------------------------------------------ */

type HeroRow = {
  label: string;
  full: string;
} & Record<string, number | string | undefined>;

const volKey = (supplier: string) => `vol::${supplier}`;
const phpKey = (supplier: string) => `php::${supplier}`;

/**
 * Build the chart dataset: one row per SELECTED period slot, with each graphed
 * supplier's volume + ₱/kg keyed in. Each slot's value is the volume-weighted
 * rollup of that supplier's months within the slot. Volume shows 0 (flat area)
 * for empty slots; price is left undefined so connectNulls bridges the gap.
 */
function buildHeroRows(
  slots: PeriodSlot[],
  graphedSuppliers: SupplierYearSummary[],
): HeroRow[] {
  return slots.map((slot) => {
    const row: HeroRow = { label: slot.label, full: slot.full };
    const slotMonths = new Set(slot.monthIndexes);
    for (const sup of graphedSuppliers) {
      const rolled = rollSelected(sup, slotMonths);
      row[volKey(sup.supplier)] = rolled.weightKg;
      if (rolled.phpPerKg != null) row[phpKey(sup.supplier)] = rolled.phpPerKg;
    }
    return row;
  });
}

/* ------------------------------------------------------------------ */
/* Hero tooltip                                                         */
/* ------------------------------------------------------------------ */

function HeroTooltip({
  active,
  payload,
  graphedSuppliers,
  colors,
  showPrices,
}: Partial<TooltipContentProps<number, string>> & {
  graphedSuppliers: string[];
  colors: Record<string, string>;
  showPrices: boolean;
}) {
  if (!active || !payload || payload.length === 0) return null;
  const row = payload[0]?.payload as HeroRow | undefined;
  if (!row) return null;
  const present = graphedSuppliers.filter(
    (s) => row[phpKey(s)] != null || row[volKey(s)] != null,
  );
  if (present.length === 0) return null;
  return (
    <div className="min-w-[240px] rounded-md border border-border bg-popover/95 p-2.5 shadow-xl backdrop-blur-lg animate-fade-in">
      <div className="mb-2 flex items-center justify-between border-b border-border/60 pb-1.5">
        <span className="text-xs font-semibold tracking-wide text-foreground">
          {row.full}
        </span>
        <span className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
          by supplier
        </span>
      </div>
      <dl className="space-y-2">
        {present.map((supplier) => {
          const php = row[phpKey(supplier)] as number | undefined;
          const vol = row[volKey(supplier)] as number | undefined;
          const color = colors[supplier];
          return (
            <div key={supplier} className="space-y-0.5">
              <div className="flex items-center gap-1.5">
                <span
                  className="inline-block h-2 w-2 shrink-0 rounded-full"
                  style={{ backgroundColor: color }}
                />
                <span className="truncate font-mono text-[11px] font-semibold tracking-wide text-foreground">
                  {supplier}
                </span>
              </div>
              {showPrices && (
                <div className="flex items-center justify-between gap-4 pl-3.5">
                  <dt className="text-[11px] text-muted-foreground">₱/kg</dt>
                  <dd className="font-mono text-xs font-semibold tabular-nums text-foreground">
                    {php == null ? '—' : fmt.php(php)}
                  </dd>
                </div>
              )}
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
          'mt-2 truncate font-mono text-xl font-semibold leading-none tabular-nums',
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
/* Numeric helpers                                                      */
/* ------------------------------------------------------------------ */

function num(value: number, dp: number): string {
  return value.toLocaleString('en-PH', {
    minimumFractionDigits: dp,
    maximumFractionDigits: dp,
  });
}

function numOrDash(value: number | null, dp: number): string {
  return value == null ? '—' : num(value, dp);
}

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

/* ------------------------------------------------------------------ */
/* Supplier table — column model + sorting + cell selection             */
/* ------------------------------------------------------------------ */

/** A fully-rolled-up table row: a supplier plus its selected-period metrics. */
interface SupplierTableRow extends RolledMetrics {
  supplier: SupplierYearSummary;
  name: string;
}

interface NumericColumn {
  key: string;
  label: string;
  /** dp for plain numerics; ₱ columns render via AccountingCell. */
  dp: number;
  get: (row: SupplierTableRow) => number | null;
  calc: AggregationType;
  /** Render as accounting ₱ cell. */
  money?: boolean;
  /** Present only when prices are visible. */
  priceOnly?: boolean;
}

/** Ordered numeric columns, mirroring RC IN order:
 *  Deliveries | Sacks | Weight | MC | Grit | VM | Ash | FC | BD ASTM | BD JIS | ₱/kg | ₱ Total. */
const NUMERIC_COLUMNS: NumericColumn[] = [
  { key: 'deliveries', label: 'Deliveries', dp: 0, get: (r) => r.deliveries, calc: 'SUM' },
  { key: 'sacks', label: 'Sacks', dp: 0, get: (r) => r.sacks, calc: 'SUM' },
  { key: 'weight', label: 'Weight (kg)', dp: 0, get: (r) => r.weightKg, calc: 'SUM' },
  { key: 'mc', label: 'MC', dp: 2, get: (r) => r.mc, calc: 'AVERAGE' },
  { key: 'grit', label: 'Grit', dp: 2, get: (r) => r.grit, calc: 'AVERAGE' },
  { key: 'vm', label: 'VM', dp: 2, get: (r) => r.vm, calc: 'AVERAGE' },
  { key: 'ash', label: 'Ash', dp: 2, get: (r) => r.ash, calc: 'AVERAGE' },
  { key: 'fc', label: 'FC', dp: 2, get: (r) => r.fc, calc: 'AVERAGE' },
  { key: 'bdAstm', label: 'BD ASTM', dp: 3, get: (r) => r.bdAstm, calc: 'AVERAGE' },
  { key: 'bdJis', label: 'BD JIS', dp: 3, get: (r) => r.bdJis, calc: 'AVERAGE' },
  { key: 'phpPerKg', label: '₱/kg', dp: 2, get: (r) => r.phpPerKg, calc: 'AVERAGE', money: true, priceOnly: true },
  { key: 'phpTotal', label: '₱ Total', dp: 2, get: (r) => r.phpTotal, calc: 'SUM', money: true, priceOnly: true },
];

type SortKey = 'supplier' | string;
type SortDir = 'asc' | 'desc';

/** Selected-cell styling — mirrors GridCell.tsx / the period view. */
function selectedCellClasses(selected: boolean, anchor: boolean): string {
  return cn(
    selected && 'bg-primary/10 dark:bg-primary/20',
    anchor && 'ring-2 ring-primary ring-inset',
  );
}

function SupplierTable({
  rows,
  totals,
  graphed,
  graphedFull,
  onToggleGraph,
  onOpenSupplier,
  colors,
  showPrices,
  resetKey,
}: {
  rows: SupplierTableRow[];
  totals: RolledMetrics;
  /** Currently-graphed supplier names. */
  graphed: Set<string>;
  /** True when the graph cap is reached (unchecked rows disabled). */
  graphedFull: boolean;
  onToggleGraph: (name: string) => void;
  onOpenSupplier: (name: string) => void;
  colors: Record<string, string>;
  showPrices: boolean;
  /** Identity changes (year / period swap) → clear stale selection. */
  resetKey: string;
}) {
  const { setCellSelectionCount, setCellAggregates } = useStatusBar();

  const numCell = 'px-2 py-1 text-right font-mono tabular-nums';
  const headCell =
    'px-2 py-1 text-right text-[10px] font-semibold uppercase tracking-wide text-muted-foreground';

  /* ---- Sorting ---------------------------------------------------- */
  const [sortKey, setSortKey] = useState<SortKey>('supplier');
  // 'supplier' default = volume-desc order already supplied; first numeric click
  // sorts that column desc.
  const [sortDir, setSortDir] = useState<SortDir>('asc');

  const sortedRows = useMemo(() => {
    if (sortKey === 'supplier') {
      // Default (asc) keeps the server's volume-desc order; clicking the
      // Supplier header sorts alphabetically.
      if (sortDir === 'asc') return rows;
      return [...rows].sort((a, b) => b.name.localeCompare(a.name));
    }
    const col = NUMERIC_COLUMNS.find((c) => c.key === sortKey);
    if (!col) return rows;
    return [...rows].sort((a, b) => {
      const av = col.get(a);
      const bv = col.get(b);
      // Nulls always sort to the bottom regardless of direction.
      if (av == null && bv == null) return 0;
      if (av == null) return 1;
      if (bv == null) return -1;
      return sortDir === 'asc' ? av - bv : bv - av;
    });
  }, [rows, sortKey, sortDir]);

  const onSort = (key: SortKey) => {
    if (key === sortKey) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortKey(key);
      // Numeric columns default to desc (biggest first); name defaults to asc.
      setSortDir(key === 'supplier' ? 'asc' : 'desc');
    }
  };

  /* ---- Cell selection wiring (Excel-style sum/avg/count popup) -----
   * Selectable grid = the supplier rows × the VISIBLE numeric columns. The
   * leading checkbox + Supplier name cells are row headers and are NOT part of
   * this col grid (so the name stays clickable for the slide-out). */
  const visibleNumericColumns = useMemo(
    () => NUMERIC_COLUMNS.filter((c) => showPrices || !c.priceOnly),
    [showPrices],
  );

  const scrollContainerRef = useRef<HTMLDivElement>(null);

  const cellSelection = useCellSelection({
    rowCount: sortedRows.length,
    colCount: visibleNumericColumns.length,
    scrollContainerRef,
  });

  const selectionSize = cellSelection.getSelectionSize();

  // Stabilize the selection range BY VALUE (keyed on coords) so the aggregation
  // memo + status-bar push effect don't re-fire on every context update — the
  // infinite-loop fix carried over verbatim from the period view.
  const r = cellSelection.range;
  const rangeKey = r ? `${r.startRow}:${r.startCol}:${r.endRow}:${r.endCol}` : '';
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const stableRange = useMemo(() => r, [rangeKey]);

  const getNumericCellValue = useMemo(
    () =>
      (rowIdx: number, colIdx: number): number | null => {
        const row = sortedRows[rowIdx];
        const col = visibleNumericColumns[colIdx];
        if (!row || !col) return null;
        return col.get(row);
      },
    [sortedRows, visibleNumericColumns],
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

  // Push count + aggregates to the shared status bar.
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

  // Reset selection when the underlying data identity changes (year / period /
  // sort swap brings a new row ordering).
  const { clearSelection } = cellSelection;
  useEffect(() => {
    clearSelection();
    setCellSelectionCount(0);
    setCellAggregates(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resetKey, sortKey, sortDir]);

  // Click-away deselect — ignore the floating status bar + portaled radix
  // poppers (so a popover/sheet interaction doesn't wipe the selection).
  useEffect(() => {
    const onMouseDown = (e: MouseEvent) => {
      const target = e.target as Element | null;
      if (!target) return;
      if (scrollContainerRef.current?.contains(target)) return;
      if (target.closest('[data-floating-status-bar]')) return;
      if (target.closest('[data-radix-popper-content-wrapper]')) return;
      clearSelection();
      setCellSelectionCount(0);
      setCellAggregates(null);
    };
    document.addEventListener('mousedown', onMouseDown);
    return () => document.removeEventListener('mousedown', onMouseDown);
  }, [clearSelection, setCellSelectionCount, setCellAggregates]);

  // On unmount, clear the status bar so a stale popup doesn't show elsewhere.
  useEffect(() => {
    return () => {
      setCellSelectionCount(0);
      setCellAggregates(null);
    };
  }, [setCellSelectionCount, setCellAggregates]);

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

  const SortHeader = ({
    label,
    colKey,
    align = 'right',
  }: {
    label: string;
    colKey: SortKey;
    align?: 'left' | 'right';
  }) => {
    const activeSort = sortKey === colKey;
    return (
      <button
        type="button"
        onClick={() => onSort(colKey)}
        className={cn(
          'flex w-full items-center gap-1 transition-colors hover:text-foreground',
          align === 'right' ? 'justify-end' : 'justify-start',
          activeSort && 'text-foreground',
        )}
      >
        <span>{label}</span>
        <span className="font-mono text-[9px]">
          {activeSort ? (sortDir === 'asc' ? '▲' : '▼') : ''}
        </span>
      </button>
    );
  };

  return (
    <div className="overflow-x-auto rounded-lg border border-border bg-card">
      <div
        ref={scrollContainerRef}
        tabIndex={0}
        onKeyDown={cellSelection.handleKeyDown}
        className="max-h-[560px] overflow-y-auto outline-none select-none"
      >
        <table className="w-full table-fixed border-collapse text-xs">
          <colgroup>
            <col className="w-[44px]" />{/* checkbox */}
            <col className="w-[200px]" />{/* Supplier */}
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

          {/* Sticky glass header (floats over scrolling body → glass is correct). */}
          <thead className="sticky top-0 z-10 bg-muted/90 backdrop-blur-sm">
            <tr className="border-b border-border">
              <th scope="col" className="px-2 py-1.5">
                <span className="sr-only">On graph</span>
              </th>
              <th
                scope="col"
                className="px-2 py-1.5 text-left text-[10px] font-semibold uppercase tracking-wide text-muted-foreground"
              >
                <SortHeader label="Supplier" colKey="supplier" align="left" />
              </th>
              {visibleNumericColumns.map((c) => (
                <th key={c.key} scope="col" className={headCell}>
                  <SortHeader label={c.label} colKey={c.key} />
                </th>
              ))}
            </tr>
          </thead>

          <tbody>
            {sortedRows.map((row, rowIdx) => {
              const name = row.name;
              const isGraphed = graphed.has(name);
              const empty = row.weightKg === 0;
              const checkboxDisabled = !isGraphed && graphedFull;
              const swatch = isGraphed ? colors[name] : undefined;
              return (
                <tr
                  key={name}
                  className={cn(
                    'h-8 border-b border-border/60 transition-all duration-150 hover:bg-muted/50',
                    empty && 'text-muted-foreground/60',
                  )}
                >
                  {/* Leading checkbox — toggles graph membership. Row header,
                      NOT part of the selectable numeric grid. */}
                  <td className="px-2 py-1 text-center">
                    <Checkbox
                      checked={isGraphed}
                      disabled={checkboxDisabled}
                      onCheckedChange={() => onToggleGraph(name)}
                      aria-label={`Show ${name} on graph`}
                      className="size-3.5"
                    />
                  </td>
                  {/* Supplier name — clickable row header opening the slide-out.
                      Excluded from the numeric grid so the click never starts a
                      cell selection. */}
                  <th
                    scope="row"
                    className="px-2 py-1 text-left text-xs font-medium"
                  >
                    <button
                      type="button"
                      onClick={() => onOpenSupplier(name)}
                      className="flex w-full items-center gap-1.5 truncate text-left text-foreground transition-colors hover:text-primary hover:underline"
                      title={name}
                    >
                      {swatch && (
                        <span
                          className="inline-block h-2 w-2 shrink-0 rounded-full"
                          style={{ backgroundColor: swatch }}
                        />
                      )}
                      <span className="truncate">{name}</span>
                    </button>
                  </th>
                  {visibleNumericColumns.map((c) => {
                    const v = c.get(row);
                    if (c.money) {
                      return (
                        <td
                          key={c.key}
                          {...cellSelProps(rowIdx, c.key, 'px-2 py-1 font-mono')}
                        >
                          {v == null ? (
                            <div className="text-right tabular-nums">—</div>
                          ) : (
                            <AccountingCell value={v} dp={c.dp} />
                          )}
                        </td>
                      );
                    }
                    return (
                      <td key={c.key} {...cellSelProps(rowIdx, c.key, numCell)}>
                        {numOrDash(v, c.dp)}
                      </td>
                    );
                  })}
                </tr>
              );
            })}
            {sortedRows.length === 0 && (
              <tr>
                <td
                  colSpan={2 + visibleNumericColumns.length}
                  className="px-2 py-6 text-center text-xs text-muted-foreground"
                >
                  No suppliers for the selected periods.
                </td>
              </tr>
            )}
          </tbody>

          {/* Frozen FOOTER total row — OPAQUE mirror of the header (NOT glass). */}
          <tfoot>
            <tr className="frozen-row-bottom frozen-edge-top h-9 bg-muted font-semibold">
              <td className="bg-muted px-2 py-1" />
              <th
                scope="row"
                className="bg-muted px-2 py-1 text-left text-xs font-bold uppercase tracking-wide text-foreground"
              >
                Total
              </th>
              {visibleNumericColumns.map((c) => {
                const v = c.get({
                  ...totals,
                  supplier: undefined as never,
                  name: '',
                });
                if (c.money) {
                  return (
                    <td
                      key={c.key}
                      className="bg-muted px-2 py-1 font-mono text-foreground"
                      title={c.calc === 'AVERAGE' ? 'volume-weighted average' : undefined}
                    >
                      {v == null ? (
                        <div className="text-right tabular-nums">—</div>
                      ) : (
                        <AccountingCell value={v} dp={c.dp} />
                      )}
                    </td>
                  );
                }
                return (
                  <td
                    key={c.key}
                    className="bg-muted px-2 py-1 text-right font-mono tabular-nums text-foreground"
                    title={c.calc === 'AVERAGE' ? 'volume-weighted average' : undefined}
                  >
                    {numOrDash(v, c.dp)}
                  </td>
                );
              })}
            </tr>
          </tfoot>
        </table>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Granularity toggle + period multi-select                            */
/* ------------------------------------------------------------------ */

function GranularityToggle({
  value,
  onChange,
}: {
  value: Granularity;
  onChange: (g: Granularity) => void;
}) {
  const opts: { id: Granularity; label: string }[] = [
    { id: 'months', label: 'Months' },
    { id: 'quarters', label: 'Quarters' },
  ];
  return (
    <div
      role="tablist"
      aria-label="Granularity"
      className="inline-flex items-center gap-0.5 rounded-md border border-border bg-muted/50 p-0.5"
    >
      {opts.map((o) => {
        const active = value === o.id;
        return (
          <button
            key={o.id}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onChange(o.id)}
            className={cn(
              'rounded-sm px-3 py-1 text-xs font-medium transition-all duration-150',
              active
                ? 'bg-background text-foreground shadow-sm'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

function PeriodMultiSelect({
  slots,
  selected,
  onToggle,
  onAll,
  onNone,
}: {
  slots: PeriodSlot[];
  selected: Set<string>;
  onToggle: (id: string) => void;
  onAll: () => void;
  onNone: () => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-1.5" aria-label="Periods">
      {slots.map((slot) => {
        const on = selected.has(slot.id);
        return (
          <button
            key={slot.id}
            type="button"
            aria-pressed={on}
            onClick={() => onToggle(slot.id)}
            title={slot.full}
            className={cn(
              'inline-flex items-center rounded-full border px-2.5 py-1 font-mono text-[11px] font-medium tabular-nums transition-all duration-150',
              on
                ? 'border-primary/60 bg-primary/10 text-foreground dark:bg-primary/20'
                : 'border-border text-muted-foreground hover:text-foreground',
            )}
          >
            {slot.label}
          </button>
        );
      })}
      <span className="ml-1 flex items-center gap-1.5">
        <button
          type="button"
          onClick={onAll}
          className="rounded-sm border border-border px-2 py-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground transition-colors hover:text-foreground"
        >
          All
        </button>
        <button
          type="button"
          onClick={onNone}
          className="rounded-sm border border-border px-2 py-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground transition-colors hover:text-foreground"
        >
          None
        </button>
      </span>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Graphed-supplier control — removable chips + searchable add dropdown */
/* ------------------------------------------------------------------ */

function GraphSupplierControl({
  allSuppliers,
  graphed,
  graphedOrder,
  colors,
  canGraphMore,
  onRemove,
  onAdd,
}: {
  /** All supplier names for the year (volume-desc). */
  allSuppliers: string[];
  graphed: Set<string>;
  /** Stable order graphed chips render in (for color stability). */
  graphedOrder: string[];
  colors: Record<string, string>;
  canGraphMore: boolean;
  onRemove: (name: string) => void;
  onAdd: (name: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const addable = allSuppliers.filter((s) => !graphed.has(s));

  return (
    <div className="flex flex-wrap items-center gap-1.5" aria-label="Graphed suppliers">
      {graphedOrder.map((name) => {
        const color = colors[name];
        return (
          <span
            key={name}
            className="inline-flex max-w-[200px] items-center gap-1.5 rounded-full border px-2.5 py-1 font-mono text-[11px] font-medium"
            style={{ borderColor: color, backgroundColor: `${color}1f` }}
          >
            <span
              className="inline-block h-2 w-2 shrink-0 rounded-full"
              style={{ backgroundColor: color }}
            />
            <span className="truncate text-foreground" title={name}>
              {name}
            </span>
            <button
              type="button"
              onClick={() => onRemove(name)}
              aria-label={`Remove ${name} from graph`}
              className="shrink-0 rounded-sm text-muted-foreground transition-colors hover:text-foreground"
            >
              <X className="h-3 w-3" />
            </button>
          </span>
        );
      })}

      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            disabled={!canGraphMore || addable.length === 0}
            className={cn(
              'inline-flex items-center gap-1 rounded-full border border-dashed border-border px-2.5 py-1 text-[11px] font-medium transition-colors',
              canGraphMore && addable.length > 0
                ? 'text-muted-foreground hover:text-foreground hover:border-foreground/40'
                : 'cursor-not-allowed text-muted-foreground/50',
            )}
            title={
              !canGraphMore
                ? `Graph is capped at ${MAX_GRAPHED} suppliers — remove one to add another`
                : addable.length === 0
                  ? 'All suppliers already graphed'
                  : 'Add a supplier to the graph'
            }
          >
            <Plus className="h-3 w-3" />
            Add supplier
            <ChevronsUpDown className="h-3 w-3 opacity-60" />
          </button>
        </PopoverTrigger>
        <PopoverContent
          align="end"
          className="w-[260px] bg-popover/95 p-0 backdrop-blur-lg"
        >
          <Command>
            <CommandInput placeholder="Search suppliers…" className="text-xs" />
            <CommandList>
              <CommandEmpty>No suppliers found.</CommandEmpty>
              <CommandGroup>
                {addable.map((name) => (
                  <CommandItem
                    key={name}
                    value={name}
                    onSelect={() => {
                      onAdd(name);
                      setOpen(false);
                    }}
                    className="font-mono text-xs"
                  >
                    <Plus className="mr-2 h-3 w-3 opacity-60" />
                    <span className="truncate">{name}</span>
                  </CommandItem>
                ))}
              </CommandGroup>
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>

      {!canGraphMore && (
        <span className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
          max {MAX_GRAPHED} on graph
        </span>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Supplier detail slide-out                                            */
/* ------------------------------------------------------------------ */

interface SupplierPanelStats {
  name: string;
  rank: number;
  totalSuppliers: number;
  /** Share of the year's total volume (0..1). */
  share: number;
  /** Full-year rollup (from the supplier's own monthly axis). */
  year: RolledMetrics;
  /** Lowest / highest priced month, if any. */
  priceLow: { label: string; value: number } | null;
  priceHigh: { label: string; value: number } | null;
  /** vs prior available year (null when no prior). */
  volumeYoYPct: number | null;
  priceYoYPct: number | null;
  prevYear: number | null;
  /** Constituent subgroups merged into this main group, weightKg DESC (server-sorted). */
  subgroups: SupplierSubgroup[];
}

function StatRow({
  label,
  value,
  tone = 'default',
}: {
  label: string;
  value: string;
  tone?: 'default' | 'good' | 'warn';
}) {
  return (
    <div className="flex items-center justify-between gap-4 border-b border-border/50 py-1.5">
      <span className="text-[11px] text-muted-foreground">{label}</span>
      <span
        className={cn(
          'font-mono text-xs font-semibold tabular-nums',
          tone === 'warn'
            ? 'text-red-600 dark:text-red-400'
            : tone === 'good'
              ? 'text-emerald-600 dark:text-emerald-400'
              : 'text-foreground',
        )}
      >
        {value}
      </span>
    </div>
  );
}

function SupplierDetailPanel({
  stats,
  monthly,
  color,
  showPrices,
  chrome,
  chartReady,
}: {
  stats: SupplierPanelStats;
  monthly: SupplierMonthRow[];
  color: string;
  showPrices: boolean;
  chrome: ChartChrome;
  chartReady: boolean;
}) {
  // The supplier's own 12-month mini series. Volume is always a number (0 → flat
  // area); price is undefined for null months so connectNulls bridges gaps.
  const miniRows = MONTH_LABELS.map(([label], i) => {
    const m = monthly[i];
    const row: { label: string; vol: number; php?: number } = {
      label,
      vol: m?.weightKg ?? 0,
    };
    if (m?.phpPerKg != null) row.php = m.phpPerKg;
    return row;
  });

  const y = stats.year;

  return (
    <div className="flex flex-col gap-4 overflow-y-auto px-4 pb-6">
      {/* Headline rank/share */}
      <div className="grid grid-cols-2 gap-2">
        <div className="rounded-md border border-border bg-card px-3 py-2">
          <div className="text-[10px] font-medium uppercase tracking-widest text-muted-foreground">
            Volume
          </div>
          <div className="mt-1 font-mono text-lg font-semibold tabular-nums text-foreground">
            {fmt.tonnes(y.weightKg)}
          </div>
          <div className="mt-0.5 text-[11px] text-muted-foreground">
            rank #{stats.rank} of {stats.totalSuppliers} ·{' '}
            {(stats.share * 100).toFixed(1)}% of year
          </div>
        </div>
        <div className="rounded-md border border-border bg-card px-3 py-2">
          <div className="text-[10px] font-medium uppercase tracking-widest text-muted-foreground">
            {showPrices ? 'Blended ₱/kg' : 'Deliveries'}
          </div>
          <div className="mt-1 font-mono text-lg font-semibold tabular-nums text-foreground">
            {showPrices ? fmt.php(y.phpPerKg) : y.deliveries.toLocaleString('en-PH')}
          </div>
          <div className="mt-0.5 text-[11px] text-muted-foreground">
            {showPrices ? 'volume-weighted' : `${y.sacks.toLocaleString('en-PH')} sacks`}
          </div>
        </div>
      </div>

      {/* Mini chart — chartReady-gated, same pattern as the hero. */}
      <div className="rounded-md border border-border bg-card p-2">
        <div className="mb-1 flex items-center justify-between">
          <span className="text-[10px] font-medium uppercase tracking-widest text-muted-foreground">
            By month
          </span>
          <span className="font-mono text-[9px] uppercase tracking-widest text-muted-foreground">
            {showPrices ? 'area = vol · line = ₱/kg' : 'area = vol'}
          </span>
        </div>
        <div className="h-[160px] w-full">
          {chartReady ? (
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart
                data={miniRows}
                margin={{ top: 6, right: 6, bottom: 0, left: 0 }}
              >
                <defs>
                  <linearGradient id="miniVol" x1="0" y1="0" x2="0" y2="1">
                    <stop
                      offset="0%"
                      stopColor={color}
                      stopOpacity={chrome.dark ? 0.26 : 0.18}
                    />
                    <stop offset="100%" stopColor={color} stopOpacity={0.01} />
                  </linearGradient>
                </defs>
                <CartesianGrid
                  strokeDasharray="2 5"
                  stroke={chrome.grid}
                  vertical={false}
                />
                <XAxis
                  dataKey="label"
                  tick={{ fontSize: 9, fill: chrome.axisText, fontFamily: 'var(--font-mono, monospace)' }}
                  tickLine={false}
                  axisLine={{ stroke: chrome.grid }}
                  interval={0}
                />
                <YAxis
                  yAxisId="vol"
                  orientation="right"
                  tick={{ fontSize: 9, fill: chrome.axisText, fontFamily: 'var(--font-mono, monospace)' }}
                  tickLine={false}
                  axisLine={false}
                  width={32}
                  tickFormatter={(v: number) => `${Math.round(v / 1000)}t`}
                />
                {showPrices && (
                  <YAxis
                    yAxisId="price"
                    orientation="left"
                    domain={['dataMin - 1.5', 'dataMax + 1.5']}
                    tick={{ fontSize: 9, fill: chrome.axisText, fontFamily: 'var(--font-mono, monospace)' }}
                    tickLine={false}
                    axisLine={false}
                    width={34}
                    tickFormatter={(v: number) => `₱${v.toFixed(0)}`}
                  />
                )}
                <Area
                  yAxisId="vol"
                  type="monotone"
                  dataKey="vol"
                  stroke="none"
                  fill="url(#miniVol)"
                  connectNulls
                  isAnimationActive={false}
                />
                {showPrices && (
                  <Line
                    yAxisId="price"
                    type="monotone"
                    dataKey="php"
                    stroke={color}
                    strokeWidth={2}
                    dot={{ r: 2, fill: color, strokeWidth: 0 }}
                    connectNulls
                    isAnimationActive={false}
                  />
                )}
              </ComposedChart>
            </ResponsiveContainer>
          ) : null}
        </div>
      </div>

      {/* Precise stats */}
      <div className="rounded-md border border-border bg-card px-3 py-1">
        <StatRow label="Deliveries" value={y.deliveries.toLocaleString('en-PH')} />
        <StatRow label="Sacks" value={y.sacks.toLocaleString('en-PH')} />
        <StatRow label="Weight (kg)" value={num(y.weightKg, 0)} />
        {showPrices && (
          <StatRow
            label="₱ Total"
            value={y.phpTotal == null ? '—' : `₱${num(y.phpTotal, 2)}`}
          />
        )}
        {showPrices && (
          <StatRow
            label="Min month ₱/kg"
            value={
              stats.priceLow == null
                ? '—'
                : `${fmt.php(stats.priceLow.value)} (${stats.priceLow.label})`
            }
          />
        )}
        {showPrices && (
          <StatRow
            label="Max month ₱/kg"
            value={
              stats.priceHigh == null
                ? '—'
                : `${fmt.php(stats.priceHigh.value)} (${stats.priceHigh.label})`
            }
          />
        )}
      </div>

      {/* Volume-weighted lab metrics */}
      <div className="rounded-md border border-border bg-card px-3 py-1">
        <div className="py-1.5 text-[10px] font-medium uppercase tracking-widest text-muted-foreground">
          Lab (volume-weighted)
        </div>
        <StatRow label="MC" value={numOrDash(y.mc, 2)} />
        <StatRow label="Grit" value={numOrDash(y.grit, 2)} />
        <StatRow label="VM" value={numOrDash(y.vm, 2)} />
        <StatRow label="Ash" value={numOrDash(y.ash, 2)} />
        <StatRow label="FC" value={numOrDash(y.fc, 2)} />
        <StatRow label="BD ASTM" value={numOrDash(y.bdAstm, 3)} />
        <StatRow label="BD JIS" value={numOrDash(y.bdJis, 3)} />
      </div>

      {/* vs prior year */}
      {stats.prevYear != null && (
        <div className="rounded-md border border-border bg-card px-3 py-1">
          <div className="py-1.5 text-[10px] font-medium uppercase tracking-widest text-muted-foreground">
            vs {stats.prevYear}
          </div>
          <StatRow
            label="Volume YoY"
            value={stats.volumeYoYPct == null ? '—' : fmt.pct(stats.volumeYoYPct)}
            tone={
              stats.volumeYoYPct == null
                ? 'default'
                : stats.volumeYoYPct >= 0
                  ? 'good'
                  : 'warn'
            }
          />
          {showPrices && (
            <StatRow
              label="₱/kg YoY"
              value={stats.priceYoYPct == null ? '—' : fmt.pct(stats.priceYoYPct)}
              // Rising price = concern → warn; falling → good.
              tone={
                stats.priceYoYPct == null
                  ? 'default'
                  : stats.priceYoYPct > 0
                    ? 'warn'
                    : 'good'
              }
            />
          )}
        </div>
      )}

      {/* "Made up of" — constituent subgroups merged into this main group.
          Shown ONLY for genuinely-merged suppliers (>1 subgroup); a single-
          constituent supplier would just repeat its own name. */}
      {stats.subgroups.length > 1 && (
        <SubgroupBreakdown
          subgroups={stats.subgroups}
          supplierName={stats.name}
          color={color}
          showPrices={showPrices}
        />
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* "Made up of" — subgroup breakdown for merged supplier groups         */
/* ------------------------------------------------------------------ */

/**
 * Lists the constituent subgroups folded into a main supplier group: the direct
 * deliveries (label === the supplier's own name) plus every misdeclared "/" combo.
 * Server-sorted weightKg DESC, so the direct/biggest row reads first.
 *
 * Share % is each subgroup's slice of the SUM of the supplier's subgroup weights
 * (not the year total) — so the shares of the rows shown always sum to ~100%.
 * ₱/kg is rendered only when `showPrices`; a null phpPerKg renders "—".
 */
function SubgroupBreakdown({
  subgroups,
  supplierName,
  color,
  showPrices,
}: {
  subgroups: SupplierSubgroup[];
  supplierName: string;
  color: string;
  showPrices: boolean;
}) {
  const totalWeight = subgroups.reduce((s, g) => s + g.weightKg, 0);

  return (
    <div className="rounded-md border border-border bg-card px-3 py-1">
      <div className="flex items-baseline justify-between gap-2 py-1.5">
        <span className="text-[10px] font-medium uppercase tracking-widest text-muted-foreground">
          Made up of
        </span>
        <span className="font-mono text-[10px] tabular-nums text-muted-foreground">
          {subgroups.length} subgroups
        </span>
      </div>
      <p className="pb-1.5 text-[10px] leading-snug text-muted-foreground/80">
        Variants &amp; misdeclared combos merged into this supplier.
      </p>
      <ul className="flex flex-col gap-1.5 pb-1.5">
        {subgroups.map((g) => {
          const share = totalWeight > 0 ? g.weightKg / totalWeight : 0;
          const isDirect = g.label === supplierName;
          return (
            <li key={g.label} className="flex flex-col gap-1">
              <div className="flex items-center justify-between gap-2">
                <span
                  className={cn(
                    'flex min-w-0 items-center gap-1.5 text-[11px]',
                    isDirect ? 'font-semibold text-foreground' : 'text-foreground',
                  )}
                >
                  <span
                    className="inline-block h-1.5 w-1.5 shrink-0 rounded-full"
                    style={{
                      backgroundColor: color,
                      opacity: isDirect ? 1 : 0.45,
                    }}
                  />
                  <span className="truncate" title={g.label}>
                    {g.label}
                  </span>
                </span>
                <span
                  className="shrink-0 font-mono text-[11px] font-semibold tabular-nums text-foreground"
                  title={`${num(g.weightKg, 0)} kg`}
                >
                  {fmt.tonnes(g.weightKg)}
                </span>
              </div>
              {/* Thin share bar (transform/width is on a static element → fine). */}
              <div className="flex items-center gap-2">
                <div className="h-1 flex-1 overflow-hidden rounded-full bg-muted">
                  <div
                    className="h-full rounded-full"
                    style={{
                      width: `${(share * 100).toFixed(1)}%`,
                      backgroundColor: color,
                      opacity: isDirect ? 0.9 : 0.5,
                    }}
                  />
                </div>
                <span className="w-9 shrink-0 text-right font-mono text-[10px] tabular-nums text-muted-foreground">
                  {(share * 100).toFixed(1)}%
                </span>
              </div>
              <div className="flex items-center justify-between gap-2 text-[10px] text-muted-foreground">
                <span className="font-mono tabular-nums">
                  {g.deliveries.toLocaleString('en-PH')} deliveries
                </span>
                {showPrices && (
                  <span className="font-mono tabular-nums">
                    {g.phpPerKg == null ? '—' : fmt.php(g.phpPerKg)}
                  </span>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Error / empty states                                                 */
/* ------------------------------------------------------------------ */

function ErrorState({ message }: { message: string }) {
  useEffect(() => {
    errorToast('Failed to load the By-Supplier brief', { description: message });
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
              Couldn&apos;t load supplier analytics
            </h3>
            <p className="mt-1 break-words font-mono text-xs text-muted-foreground">
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

export default function SupplierBriefClient({
  years,
  byYear,
  canViewPrices,
  error,
}: SupplierBriefClientProps) {
  const chrome = useChartChrome();

  // chartReady mount-gate — keeps SSR + first client render identical so the
  // ResponsiveContainer's internal useId doesn't shift downstream ids and break
  // hydration. Mirrors the period view. Gates BOTH the hero and the mini chart.
  const [chartReady, setChartReady] = useState(false);
  useEffect(() => setChartReady(true), []);

  const latestYear = years.length ? years[years.length - 1] : 0;

  /* ---- State model -------------------------------------------------
   * year         — the single year driving everything; default = latest. All
   *                sub-state derives from byYear[year].
   * granularity  — 'months' | 'quarters'; selects which period slots exist.
   * selectedPeriods — Set<slotId> the table aggregation + graph x-axis scope to.
   *                Default = ALL slots. Reset to ALL whenever granularity flips.
   * graphedSet   — Set<supplierName> currently overlaid on the hero (cap 6).
   *                Default = top-3 by yearly volume (first 3 of byYear[year]).
   * graphedOrder — insertion-ordered list of graphed names → stable hue mapping
   *                (color = palette[indexInOrder]).
   * openSupplier — name of the supplier whose slide-out is open (null = closed).
   * ----------------------------------------------------------------- */
  const [year, setYear] = useState<number>(latestYear);
  const [granularity, setGranularity] = useState<Granularity>('months');

  const slots = useMemo(() => buildPeriodSlots(granularity), [granularity]);

  const [selectedPeriods, setSelectedPeriods] = useState<Set<string>>(
    () => new Set(buildPeriodSlots('months').map((s) => s.id)),
  );

  // Suppliers active in the selected year, volume-desc (server-sorted).
  const yearSuppliers = useMemo(() => byYear[year] ?? [], [byYear, year]);
  const supplierNames = useMemo(
    () => yearSuppliers.map((s) => s.supplier),
    [yearSuppliers],
  );

  const [graphedOrder, setGraphedOrder] = useState<string[]>(() =>
    (byYear[latestYear] ?? []).slice(0, 3).map((s) => s.supplier),
  );

  const [openSupplier, setOpenSupplier] = useState<string | null>(null);

  /* ---- Reset-on-change via the "adjust state during render" pattern ----
   * When `year` or `granularity` changes we must reset dependent state (graphed
   * suppliers → that year's top-3; selected periods → all slots of the new
   * granularity). React's documented lint-clean way to do this is to track the
   * previous trigger value in state and call the setters DURING RENDER when it
   * differs — not in an effect (which would add a wasted render pass and trip
   * react-hooks/set-state-in-effect). React bails out of the in-progress render
   * and immediately re-renders with the corrected state.
   * https://react.dev/learn/you-might-not-need-an-effect#adjusting-some-state-when-a-prop-changes */
  const [prevYearSel, setPrevYearSel] = useState(year);
  if (prevYearSel !== year) {
    setPrevYearSel(year);
    setGraphedOrder((byYear[year] ?? []).slice(0, 3).map((s) => s.supplier));
    setOpenSupplier(null);
  }

  const [prevGranularity, setPrevGranularity] = useState(granularity);
  if (prevGranularity !== granularity) {
    setPrevGranularity(granularity);
    setSelectedPeriods(new Set(buildPeriodSlots(granularity).map((s) => s.id)));
  }

  const graphedSet = useMemo(() => new Set(graphedOrder), [graphedOrder]);
  const canGraphMore = graphedOrder.length < MAX_GRAPHED;

  // Stable supplier→hue map keyed on graphedOrder index + theme.
  const colors = useMemo(() => {
    const palette = chrome.dark ? SUPPLIER_PALETTE_DARK : SUPPLIER_PALETTE_LIGHT;
    const map: Record<string, string> = {};
    graphedOrder.forEach((name, i) => {
      map[name] = palette[i % palette.length];
    });
    return map;
  }, [graphedOrder, chrome.dark]);

  const toggleGraph = (name: string) => {
    setGraphedOrder((prev) => {
      if (prev.includes(name)) return prev.filter((n) => n !== name);
      if (prev.length >= MAX_GRAPHED) return prev; // cap — ignore adds
      return [...prev, name];
    });
  };

  const togglePeriod = (id: string) => {
    setSelectedPeriods((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const selectAllPeriods = () =>
    setSelectedPeriods(new Set(slots.map((s) => s.id)));
  const selectNoPeriods = () => setSelectedPeriods(new Set());

  // The monthIndex set the table + KPIs aggregate over (union of selected slots).
  const selectedMonthIndexes = useMemo(() => {
    const set = new Set<number>();
    for (const slot of slots) {
      if (selectedPeriods.has(slot.id)) {
        for (const mi of slot.monthIndexes) set.add(mi);
      }
    }
    return set;
  }, [slots, selectedPeriods]);

  // Selected-only slots, in canonical order, for the graph x-axis.
  const selectedSlots = useMemo(
    () => slots.filter((s) => selectedPeriods.has(s.id)),
    [slots, selectedPeriods],
  );

  if (error) {
    return <ErrorState message={error} />;
  }

  if (years.length === 0) {
    return (
      <div className="animate-fade-up mx-auto flex w-full max-w-[1400px] flex-col gap-4 p-5 lg:p-6">
        <div className="rounded-lg border border-border bg-card p-8 text-center">
          <p className="text-sm font-medium text-foreground">No delivery data yet</p>
          <p className="mt-1 text-xs text-muted-foreground">
            Once deliveries are recorded, the By-Supplier brief will populate here.
          </p>
        </div>
      </div>
    );
  }

  /* ---- Table rows — each supplier rolled to the selected periods ---- */
  const tableRows: SupplierTableRow[] = yearSuppliers.map((sup) => ({
    ...rollSelected(sup, selectedMonthIndexes),
    supplier: sup,
    name: sup.supplier,
  }));

  // Footer totals — roll EVERY supplier's selected months together. This is a
  // volume-weighted rollup of the per-month figures, not a re-average of rows.
  const allSelectedRows: SupplierMonthRow[] = yearSuppliers.flatMap((sup) =>
    sup.monthly.filter((m) => selectedMonthIndexes.has(m.monthIndex)),
  );
  const footerTotals = rollMonths(allSelectedRows);

  /* ---- Graphed suppliers (in stable order) -------------------------- */
  const graphedSuppliers = graphedOrder
    .map((name) => yearSuppliers.find((s) => s.supplier === name))
    .filter((s): s is SupplierYearSummary => s != null);

  const heroRows = buildHeroRows(selectedSlots, graphedSuppliers);

  /* ---- KPI derivations (year-scoped, from server yearly totals) -----
   * KPIs use each supplier's FULL-YEAR totals (not the period selection) so they
   * read as stable year indicators; the table/graph carry the period scoping. */
  const yearVolumeKg = yearSuppliers.reduce((s, sup) => s + sup.totals.weightKg, 0);

  // Blended ₱/kg across the year = Σ(supplier ₱total) / Σ(priced volume). We
  // approximate priced volume via suppliers that carry a blended price. Use the
  // server's per-supplier weighted price re-weighted by volume.
  let blendNum = 0;
  let blendDen = 0;
  for (const sup of yearSuppliers) {
    if (sup.totals.phpPerKg != null && sup.totals.weightKg > 0) {
      blendNum += sup.totals.phpPerKg * sup.totals.weightKg;
      blendDen += sup.totals.weightKg;
    }
  }
  const blendedPrice = blendDen > 0 ? blendNum / blendDen : null;

  const supplierCount = yearSuppliers.length;
  const topSupplier = yearSuppliers[0]; // server-sorted volume-desc
  const topShare =
    topSupplier && yearVolumeKg > 0
      ? topSupplier.totals.weightKg / yearVolumeKg
      : 0;

  // Cheapest / most-expensive supplier by blended ₱/kg (priced suppliers only).
  const pricedSuppliers = yearSuppliers.filter((s) => s.totals.phpPerKg != null);
  const cheapest =
    pricedSuppliers.length > 0
      ? pricedSuppliers.reduce((lo, s) =>
          s.totals.phpPerKg! < lo.totals.phpPerKg! ? s : lo,
        )
      : null;
  const priciest =
    pricedSuppliers.length > 0
      ? pricedSuppliers.reduce((hi, s) =>
          s.totals.phpPerKg! > hi.totals.phpPerKg! ? s : hi,
        )
      : null;

  // "Supplier to watch" — biggest ₱/kg RISE vs the previous available year.
  const yearIdx = years.indexOf(year);
  const prevYear = yearIdx > 0 ? years[yearIdx - 1] : null;
  const prevSuppliers = prevYear != null ? byYear[prevYear] ?? [] : [];
  const prevPriceByName = new Map<string, number>();
  for (const s of prevSuppliers) {
    if (s.totals.phpPerKg != null) prevPriceByName.set(s.supplier, s.totals.phpPerKg);
  }
  let watch: { name: string; risePct: number } | null = null;
  if (prevYear != null) {
    for (const s of yearSuppliers) {
      const cur = s.totals.phpPerKg;
      const prev = prevPriceByName.get(s.supplier);
      if (cur != null && prev != null && prev > 0) {
        const risePct = ((cur - prev) / prev) * 100;
        if (risePct > 0 && (watch == null || risePct > watch.risePct)) {
          watch = { name: s.supplier, risePct };
        }
      }
    }
  }

  /* ---- Slide-out stats for the open supplier ----------------------- */
  let panelStats: SupplierPanelStats | null = null;
  let panelMonthly: SupplierMonthRow[] = [];
  if (openSupplier) {
    const idx = yearSuppliers.findIndex((s) => s.supplier === openSupplier);
    const sup = idx >= 0 ? yearSuppliers[idx] : null;
    if (sup) {
      panelMonthly = sup.monthly;
      const yearRolled = rollMonths(sup.monthly); // full-year (all 12)
      const priced = sup.monthly.filter((m) => m.phpPerKg != null);
      const lo =
        priced.length > 0
          ? priced.reduce((a, b) => (b.phpPerKg! < a.phpPerKg! ? b : a))
          : null;
      const hi =
        priced.length > 0
          ? priced.reduce((a, b) => (b.phpPerKg! > a.phpPerKg! ? b : a))
          : null;
      const prevSup =
        prevYear != null
          ? (byYear[prevYear] ?? []).find((s) => s.supplier === openSupplier)
          : undefined;
      const volYoY =
        prevSup && prevSup.totals.weightKg > 0
          ? ((yearRolled.weightKg - prevSup.totals.weightKg) /
              prevSup.totals.weightKg) *
            100
          : null;
      const priceYoY =
        prevSup?.totals.phpPerKg != null &&
        prevSup.totals.phpPerKg > 0 &&
        yearRolled.phpPerKg != null
          ? ((yearRolled.phpPerKg - prevSup.totals.phpPerKg) /
              prevSup.totals.phpPerKg) *
            100
          : null;
      panelStats = {
        name: openSupplier,
        rank: idx + 1,
        totalSuppliers: supplierCount,
        share: yearVolumeKg > 0 ? sup.totals.weightKg / yearVolumeKg : 0,
        year: yearRolled,
        priceLow: lo ? { label: MONTH_LABELS[lo.monthIndex][0], value: lo.phpPerKg! } : null,
        priceHigh: hi ? { label: MONTH_LABELS[hi.monthIndex][0], value: hi.phpPerKg! } : null,
        volumeYoYPct: volYoY,
        priceYoYPct: priceYoY,
        prevYear,
        subgroups: sup.subgroups,
      };
    }
  }

  // Color for the open supplier in the panel (graphed hue if graphed, else
  // the focus palette[0]).
  const panelColor =
    openSupplier && colors[openSupplier]
      ? colors[openSupplier]
      : chrome.dark
        ? SUPPLIER_PALETTE_DARK[0]
        : SUPPLIER_PALETTE_LIGHT[0];

  // resetKey for the table's selection-clear effect — changes on any scope swap.
  const tableResetKey = `${year}:${granularity}:${selectedSlots.map((s) => s.id).join(',')}`;

  const periodScopeLabel =
    selectedSlots.length === slots.length
      ? granularity === 'months'
        ? 'full year'
        : 'all quarters'
      : selectedSlots.map((s) => s.label).join(', ') || 'no periods';

  return (
    <div className="animate-blur-in mx-auto flex w-full max-w-[1400px] flex-col gap-6 p-5 lg:p-6">
      {/* ---- Contextual sub-header + year picker ---- */}
      <header className="flex flex-wrap items-end justify-between gap-3 border-b border-border pb-4">
        <div className="flex items-center gap-2.5">
          <span className="inline-flex h-5 items-center rounded-sm bg-indigo-500/15 px-1.5 font-mono text-[10px] font-bold uppercase tracking-widest text-indigo-700 dark:text-indigo-300">
            Supplier
          </span>
          <h2 className="text-sm font-medium text-foreground">
            Supplier Mix — FY {year} Review
          </h2>
          <span className="hidden text-xs text-muted-foreground sm:inline">
            — who supplied what, at what price
          </span>
        </div>
        <div className="flex items-center gap-2">
          <span className="hidden font-mono text-[11px] uppercase tracking-widest text-muted-foreground sm:inline">
            {fmt.tonnes(yearVolumeKg)} · {supplierCount} suppliers
          </span>
          <Select value={String(year)} onValueChange={(v) => setYear(Number(v))}>
            <SelectTrigger
              size="sm"
              aria-label="Year"
              className="w-[120px] font-mono text-xs tabular-nums"
            >
              <SelectValue placeholder="Year" />
            </SelectTrigger>
            <SelectContent className="bg-popover/95 backdrop-blur-lg">
              {[...years]
                .reverse()
                .map((yr) => (
                  <SelectItem
                    key={yr}
                    value={String(yr)}
                    className="font-mono text-xs tabular-nums"
                  >
                    {yr}
                  </SelectItem>
                ))}
            </SelectContent>
          </Select>
        </div>
      </header>

      {/* ---- KPI strip (year-scoped) ---- */}
      <section
        className={cn(
          'stagger-children grid grid-cols-2 gap-3 md:grid-cols-3',
          canViewPrices ? 'xl:grid-cols-6' : 'xl:grid-cols-3',
        )}
        aria-label="Year-scoped supplier metrics"
      >
        <StatCard
          label={`${year} Volume`}
          value={fmt.tonnes(yearVolumeKg)}
          sub="raw charcoal received"
        />
        {canViewPrices && (
          <StatCard
            label="Blended ₱/kg"
            value={fmt.php(blendedPrice)}
            sub="volume-weighted, all suppliers"
          />
        )}
        <StatCard
          label="Suppliers"
          value={supplierCount.toLocaleString('en-PH')}
          sub="active this year"
        />
        <StatCard
          label="Top Supplier"
          value={topSupplier ? topSupplier.supplier : '—'}
          sub={
            topSupplier
              ? `${(topShare * 100).toFixed(1)}% of volume`
              : 'no data'
          }
          swatch={topSupplier ? colors[topSupplier.supplier] : undefined}
        />
        {canViewPrices && (
          <StatCard
            label="Cheapest / Priciest"
            value={
              cheapest && priciest
                ? `${fmt.php(cheapest.totals.phpPerKg)} → ${fmt.php(priciest.totals.phpPerKg)}`
                : '—'
            }
            sub={
              cheapest && priciest
                ? `${cheapest.supplier} · ${priciest.supplier}`
                : 'no priced suppliers'
            }
          />
        )}
        {canViewPrices && (
          <StatCard
            label="Supplier to Watch"
            value={watch ? `${fmt.pct(watch.risePct)}` : '—'}
            sub={
              prevYear == null
                ? 'no prior year'
                : watch
                  ? `${watch.name} · ₱/kg rise vs ${prevYear}`
                  : `no rise vs ${prevYear}`
            }
            tone={watch ? 'warn' : 'default'}
          />
        )}
      </section>

      {/* ---- Controls: granularity + period multi-select ---- */}
      <section className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <GranularityToggle value={granularity} onChange={setGranularity} />
        <PeriodMultiSelect
          slots={slots}
          selected={selectedPeriods}
          onToggle={togglePeriod}
          onAll={selectAllPeriods}
          onNone={selectNoPeriods}
        />
      </section>

      {/* ---- Hero: supplier overlay across selected periods ---- */}
      <section className="animate-fade-up rounded-xl border border-border bg-card p-4 lg:p-5">
        <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
          <div>
            <h3 className="text-sm font-semibold tracking-tight text-foreground">
              Supplier comparison — {periodScopeLabel}
            </h3>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {canViewPrices
                ? 'Volume-weighted ₱/kg (line) over volume received (area), '
                : 'Volume received (area), '}
              one hue per supplier across the selected{' '}
              {granularity === 'months' ? 'months' : 'quarters'}.
            </p>
          </div>
          <GraphSupplierControl
            allSuppliers={supplierNames}
            graphed={graphedSet}
            graphedOrder={graphedOrder}
            colors={colors}
            canGraphMore={canGraphMore}
            onRemove={toggleGraph}
            onAdd={toggleGraph}
          />
        </div>

        <div className="h-[300px] w-full sm:h-[340px]">
          {chartReady && selectedSlots.length > 0 && graphedSuppliers.length > 0 ? (
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart
                data={heroRows}
                margin={{ top: 16, right: 16, bottom: 4, left: 4 }}
              >
                <defs>
                  {graphedSuppliers.map((sup) => {
                    const color = colors[sup.supplier];
                    const top = chrome.dark ? 0.22 : 0.15;
                    return (
                      <linearGradient
                        key={sup.supplier}
                        id={`supVol_${encodeURIComponent(sup.supplier)}`}
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
                      graphedSuppliers={graphedOrder}
                      colors={colors}
                      showPrices={canViewPrices}
                    />
                  }
                />
                {graphedSuppliers.map((sup) => (
                  <Area
                    key={`area-${sup.supplier}`}
                    yAxisId="volume"
                    type="monotone"
                    dataKey={volKey(sup.supplier)}
                    stroke="none"
                    fill={`url(#supVol_${encodeURIComponent(sup.supplier)})`}
                    connectNulls
                    isAnimationActive={false}
                  />
                ))}
                {canViewPrices &&
                  graphedSuppliers.map((sup) => {
                    const color = colors[sup.supplier];
                    return (
                      <Line
                        key={`line-${sup.supplier}`}
                        yAxisId="price"
                        type="monotone"
                        dataKey={phpKey(sup.supplier)}
                        stroke={color}
                        strokeWidth={2}
                        dot={{ r: 2.5, fill: color, strokeWidth: 0 }}
                        activeDot={{ r: 5, strokeWidth: 0, fill: color }}
                        connectNulls
                        isAnimationActive={false}
                      />
                    );
                  })}
              </ComposedChart>
            </ResponsiveContainer>
          ) : (
            <div className="flex h-full items-center justify-center rounded-lg border border-dashed border-border text-center">
              <p className="text-xs text-muted-foreground">
                {selectedSlots.length === 0
                  ? 'Select at least one period to plot.'
                  : 'Check a supplier to plot it on the graph.'}
              </p>
            </div>
          )}
        </div>
      </section>

      {/* ---- Supplier table ---- */}
      <section aria-label={`Suppliers for FY ${year}`}>
        <div className="mb-3 flex flex-wrap items-end justify-between gap-3">
          <div>
            <h3 className="text-sm font-semibold tracking-tight text-foreground">
              Suppliers — FY {year}
            </h3>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Each supplier aggregated over {periodScopeLabel}. Lab metrics
              {canViewPrices ? ' and ₱/kg are' : ' are'} volume-weighted; sacks,
              weight{canViewPrices ? ' and ₱ total' : ''} are summed. Check a row
              to plot it; click a name for details.
            </p>
          </div>
        </div>
        {/* Desktop table (sm+) — Excel cell-range drag-select + sortable headers
            stay desktop-only. */}
        <div className="hidden sm:block">
          <SupplierTable
            rows={tableRows}
            totals={footerTotals}
            graphed={graphedSet}
            graphedFull={!canGraphMore}
            onToggleGraph={toggleGraph}
            onOpenSupplier={setOpenSupplier}
            colors={colors}
            showPrices={canViewPrices}
            resetKey={tableResetKey}
          />
        </div>
        {/* Phone card list (Archetype C) — SAME tableRows + gating, no refetch. */}
        <div className="h-[70dvh] overflow-hidden rounded-lg border border-border bg-card sm:hidden">
          <SupplierCardsMobile
            rows={tableRows}
            canViewPrices={canViewPrices}
            graphed={graphedSet}
            graphedFull={!canGraphMore}
            colors={colors}
            onToggleGraph={toggleGraph}
            onOpenSupplier={setOpenSupplier}
          />
        </div>
      </section>

      {/* ---- Footer note ---- */}
      <p className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
        Live `deliveries` data ·{' '}
        {canViewPrices
          ? 'blended line is volume-weighted ₱/kg · '
          : 'prices hidden for your role · '}
        quarter / period figures roll up the DB&apos;s per-month weighted values
      </p>

      {/* ---- Supplier detail slide-out ---- */}
      <Sheet
        open={openSupplier != null}
        onOpenChange={(o) => {
          if (!o) setOpenSupplier(null);
        }}
      >
        <SheetContent
          side="right"
          className="w-full gap-0 sm:max-w-md"
        >
          {panelStats && (
            <>
              <SheetHeader className="border-b border-border">
                <div className="flex items-center gap-2">
                  <span
                    className="inline-block h-2.5 w-2.5 shrink-0 rounded-full"
                    style={{ backgroundColor: panelColor }}
                  />
                  <SheetTitle className="truncate" title={panelStats.name}>
                    {panelStats.name}
                  </SheetTitle>
                </div>
                <SheetDescription>
                  FY {year} · rank #{panelStats.rank} of {panelStats.totalSuppliers}
                </SheetDescription>
              </SheetHeader>
              <SupplierDetailPanel
                stats={panelStats}
                monthly={panelMonthly}
                color={panelColor}
                showPrices={canViewPrices}
                chrome={chrome}
                chartReady={chartReady}
              />
            </>
          )}
        </SheetContent>
      </Sheet>
    </div>
  );
}
