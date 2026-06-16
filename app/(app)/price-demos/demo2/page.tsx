'use client';

/**
 * DEMO 2 of 4 — "LEDGER"
 * Price & Volume Analysis design concept for Blackwood.
 *
 * Concept: a dense, sortable supplier league-table in the Excel-Standard
 * aesthetic (table-fixed, px-2 py-1, text-xs, font-mono right-aligned numerics,
 * h-8-ish rows) with INLINE custom-SVG sparklines + volume mini-bars, so a
 * buyer can scan every supplier's price & volume trend in one decision table.
 *
 * Table-FIRST: no big charts. The micro-viz lives inside the cells.
 * All data comes from the shared mock (`../_mock/data`) — NOT wired to Supabase.
 */

import { useMemo, useState } from 'react';
import { ArrowDown, ArrowUp, ChevronsUpDown, TrendingDown, TrendingUp, AlertTriangle } from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  SUPPLIER_SUMMARIES,
  MONTHLY_TOTALS,
  PORTFOLIO,
  MONTHS,
  fmt,
  type SupplierSummary,
} from '../_mock/data';
import { Sparkline, MiniBars, ShareBar } from './sparkline';

/* ------------------------------------------------------------------ */
/* Sorting                                                             */
/* ------------------------------------------------------------------ */

type SortKey =
  | 'name'
  | 'avgPrice'
  | 'range'
  | 'priceChangePct'
  | 'totalVolumeKg'
  | 'volumeShare';

type SortDir = 'asc' | 'desc';

const NUMERIC_DESC_FIRST: SortKey[] = [
  'avgPrice',
  'range',
  'priceChangePct',
  'totalVolumeKg',
  'volumeShare',
];

function sortValue(s: SupplierSummary, key: SortKey): number | string {
  switch (key) {
    case 'name':
      return s.name;
    case 'range':
      return s.maxPrice - s.minPrice;
    default:
      return s[key];
  }
}

/* ------------------------------------------------------------------ */
/* Page                                                                */
/* ------------------------------------------------------------------ */

export default function LedgerDemoPage() {
  // Default sort: YTD volume desc (the biggest suppliers first).
  const [sortKey, setSortKey] = useState<SortKey>('totalVolumeKg');
  const [sortDir, setSortDir] = useState<SortDir>('desc');
  // Which series the inline micro-viz emphasizes (both always render; this just
  // dims the other so a buyer can scan one signal at a time).
  const [focus, setFocus] = useState<'price' | 'volume' | 'both'>('both');

  function toggleSort(key: SortKey) {
    if (key === sortKey) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortKey(key);
      setSortDir(NUMERIC_DESC_FIRST.includes(key) ? 'desc' : 'asc');
    }
  }

  const rows = useMemo(() => {
    const arr = [...SUPPLIER_SUMMARIES];
    arr.sort((a, b) => {
      const av = sortValue(a, sortKey);
      const bv = sortValue(b, sortKey);
      let cmp: number;
      if (typeof av === 'string' || typeof bv === 'string') {
        cmp = String(av).localeCompare(String(bv));
      } else {
        cmp = av - bv;
      }
      return sortDir === 'asc' ? cmp : -cmp;
    });
    return arr;
  }, [sortKey, sortDir]);

  const cheapestName = PORTFOLIO.cheapestSupplier.name;
  const dearestName = PORTFOLIO.mostExpensiveSupplier.name;
  const watchName = PORTFOLIO.steepestRiser.name;

  return (
    <div className="flex flex-col gap-3 p-4 animate-fade-up">
      {/* Compact toolbar (no <h1> — navbar owns titles) */}
      <Toolbar focus={focus} setFocus={setFocus} />

      {/* The Ledger */}
      <div className="rounded-lg border border-border bg-card overflow-hidden shadow-sm">
        <div className="max-h-[70vh] overflow-auto">
          <table className="w-full table-fixed border-collapse text-xs">
            <colgroup>
              <col className="w-[148px]" />
              <col className="w-[92px]" />
              <col className="w-[120px]" />
              <col className="w-[104px]" />
              <col className="w-[136px]" />
              <col className="w-[136px]" />
              <col className="w-[148px]" />
            </colgroup>

            <thead>
              <tr className="frozen-row bg-muted/90 backdrop-blur-sm text-[11px] uppercase tracking-wide text-muted-foreground">
                <Th
                  align="left"
                  active={sortKey === 'name'}
                  dir={sortDir}
                  onClick={() => toggleSort('name')}
                >
                  Supplier
                </Th>
                <Th
                  align="right"
                  active={sortKey === 'avgPrice'}
                  dir={sortDir}
                  onClick={() => toggleSort('avgPrice')}
                >
                  YTD Avg ₱/kg
                </Th>
                <Th
                  align="right"
                  active={sortKey === 'range'}
                  dir={sortDir}
                  onClick={() => toggleSort('range')}
                  title="Year's price range (min / max)"
                >
                  Min / Max
                </Th>
                <Th
                  align="right"
                  active={sortKey === 'priceChangePct'}
                  dir={sortDir}
                  onClick={() => toggleSort('priceChangePct')}
                  title="First → last active-month price change"
                >
                  YTD Δ
                </Th>
                <Th align="left" sortable={false}>
                  Price trend
                </Th>
                <Th align="left" sortable={false}>
                  Volume / mo
                </Th>
                <Th
                  align="right"
                  active={sortKey === 'totalVolumeKg' || sortKey === 'volumeShare'}
                  dir={sortDir}
                  onClick={() => toggleSort('totalVolumeKg')}
                  title="YTD total volume + share of portfolio"
                >
                  YTD Volume
                </Th>
              </tr>
            </thead>

            <tbody>
              {rows.map((s) => {
                const rising = s.priceChangePct > 0;
                const flat = Math.abs(s.priceChangePct) < 0.05;
                const isCheapest = s.name === cheapestName;
                const isDearest = s.name === dearestName;
                const isWatch = s.name === watchName;

                return (
                  <tr
                    key={s.name}
                    className={cn(
                      'group h-9 border-t border-border/60 transition-all duration-150 hover:bg-muted/50',
                      isCheapest && 'bg-emerald-500/[0.06] hover:bg-emerald-500/10',
                      isDearest && 'bg-red-500/[0.06] hover:bg-red-500/10',
                    )}
                  >
                    {/* 1. Supplier */}
                    <td className="px-2 py-1">
                      <div className="flex items-center gap-2">
                        <span
                          className="h-2.5 w-2.5 shrink-0 rounded-full ring-1 ring-black/10 dark:ring-white/10"
                          style={{ backgroundColor: s.color }}
                          aria-hidden
                        />
                        <span className="truncate font-medium text-foreground">
                          {s.name}
                        </span>
                        {isWatch && (
                          <span
                            className="ml-auto inline-flex shrink-0 items-center gap-0.5 rounded-sm bg-amber-500/15 px-1 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-amber-700 dark:text-amber-400"
                            title={`Steepest YTD riser (${fmt.pct(s.priceChangePct)}) — watch this supplier`}
                          >
                            <AlertTriangle className="h-2.5 w-2.5" />
                            Watch
                          </span>
                        )}
                      </div>
                    </td>

                    {/* 2. YTD Avg ₱/kg (accounting) */}
                    <td className="px-2 py-1">
                      <div
                        className={cn(
                          'flex justify-between font-mono tabular-nums',
                          isCheapest && 'font-semibold text-emerald-700 dark:text-emerald-400',
                          isDearest && 'font-semibold text-red-700 dark:text-red-400',
                        )}
                      >
                        <span className="text-muted-foreground">₱</span>
                        <span>{s.avgPrice.toFixed(2)}</span>
                      </div>
                    </td>

                    {/* 3. Min / Max */}
                    <td className="px-2 py-1 text-right font-mono tabular-nums text-muted-foreground">
                      <span className="text-foreground/70">{s.minPrice.toFixed(2)}</span>
                      <span className="px-1 text-border">/</span>
                      <span className="text-foreground/70">{s.maxPrice.toFixed(2)}</span>
                    </td>

                    {/* 4. YTD Δ — trend arrow + % (rising = bad/red for a buyer) */}
                    <td className="px-2 py-1">
                      <div
                        className={cn(
                          'flex items-center justify-end gap-1 font-mono tabular-nums font-medium',
                          flat
                            ? 'text-muted-foreground'
                            : rising
                              ? 'text-red-600 dark:text-red-400'
                              : 'text-emerald-600 dark:text-emerald-400',
                        )}
                      >
                        {!flat &&
                          (rising ? (
                            <TrendingUp className="h-3 w-3" />
                          ) : (
                            <TrendingDown className="h-3 w-3" />
                          ))}
                        <span>{fmt.pct(s.priceChangePct)}</span>
                      </div>
                    </td>

                    {/* 5. Price sparkline (inline SVG) */}
                    <td className="px-2 py-1">
                      <div
                        className={cn(
                          'transition-opacity duration-150',
                          focus === 'volume' && 'opacity-30',
                        )}
                      >
                        <Sparkline
                          data={s.priceSeries}
                          color={s.color}
                          label={`${s.name} price trend`}
                        />
                      </div>
                    </td>

                    {/* 6. Volume mini-bars (inline SVG) */}
                    <td className="px-2 py-1">
                      <div
                        className={cn(
                          'transition-opacity duration-150',
                          focus === 'price' && 'opacity-30',
                        )}
                      >
                        <MiniBars
                          data={s.volumeSeries}
                          color={s.color}
                          label={`${s.name} monthly volume`}
                        />
                      </div>
                    </td>

                    {/* 7. YTD Volume (tonnes) + share bar */}
                    <td className="px-2 py-1">
                      <div className="flex flex-col items-end gap-1">
                        <div className="flex w-full items-baseline justify-end gap-1 font-mono tabular-nums">
                          <span>{fmt.tonnes(s.totalVolumeKg)}</span>
                          <span className="text-[10px] text-muted-foreground">
                            {(s.volumeShare * 100).toFixed(1)}%
                          </span>
                        </div>
                        <ShareBar value={s.volumeShare} color={s.color} width={120} />
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>

            {/* Blended portfolio TOTAL row (frozen footer) */}
            <tfoot>
              <tr className="frozen-row-bottom frozen-edge-top h-10 bg-muted text-xs font-medium">
                <td className="px-2 py-1">
                  <span className="font-semibold uppercase tracking-wide text-muted-foreground">
                    Portfolio
                  </span>
                </td>
                <td className="px-2 py-1">
                  <div className="flex justify-between font-mono tabular-nums font-semibold">
                    <span className="text-muted-foreground">₱</span>
                    <span title="Volume-weighted blended ₱/kg">
                      {PORTFOLIO.blendedAvgPrice.toFixed(2)}
                    </span>
                  </div>
                </td>
                <td className="px-2 py-1 text-right font-mono tabular-nums text-muted-foreground">
                  <span>{PORTFOLIO.yearLowPrice.toFixed(2)}</span>
                  <span className="px-1 text-border">/</span>
                  <span>{PORTFOLIO.yearHighPrice.toFixed(2)}</span>
                </td>
                <td className="px-2 py-1 text-right text-[10px] text-muted-foreground">
                  blended
                </td>
                {/* blended price trend across all months */}
                <td className="px-2 py-1">
                  <Sparkline
                    data={MONTHLY_TOTALS.map((m) => (m.volumeKg > 0 ? m.avgPrice : null))}
                    color="var(--color-foreground, currentColor)"
                    label="Portfolio blended price trend"
                  />
                </td>
                {/* total monthly volume */}
                <td className="px-2 py-1">
                  <MiniBars
                    data={MONTHLY_TOTALS.map((m) => m.volumeKg)}
                    color="var(--color-muted-foreground, currentColor)"
                    label="Portfolio monthly volume"
                  />
                </td>
                <td className="px-2 py-1">
                  <div className="flex flex-col items-end gap-1">
                    <div className="font-mono tabular-nums font-semibold">
                      {fmt.tonnes(PORTFOLIO.totalVolumeKg)}
                    </div>
                    <div className="text-[10px] text-muted-foreground">
                      100% · {MONTHS.length} mo
                    </div>
                  </div>
                </td>
              </tr>
            </tfoot>
          </table>
        </div>
      </div>

      {/* Legend / how-to-read */}
      <Legend />
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Toolbar                                                             */
/* ------------------------------------------------------------------ */

function Toolbar({
  focus,
  setFocus,
}: {
  focus: 'price' | 'volume' | 'both';
  setFocus: (f: 'price' | 'volume' | 'both') => void;
}) {
  const options: { key: 'both' | 'price' | 'volume'; label: string }[] = [
    { key: 'both', label: 'Both' },
    { key: 'price', label: 'Price' },
    { key: 'volume', label: 'Volume' },
  ];
  return (
    <div className="flex flex-wrap items-center justify-between gap-2">
      <div className="flex items-baseline gap-2">
        <span className="text-sm font-semibold text-foreground">Supplier Ledger</span>
        <span className="text-xs text-muted-foreground">
          {SUPPLIER_SUMMARIES.length} suppliers · YTD · click a column to sort
        </span>
      </div>

      <div className="flex items-center gap-1.5">
        <span className="text-[11px] uppercase tracking-wide text-muted-foreground">
          Emphasize
        </span>
        <div className="inline-flex rounded-md border border-border bg-card p-0.5">
          {options.map((o) => (
            <button
              key={o.key}
              type="button"
              onClick={() => setFocus(o.key)}
              className={cn(
                'rounded-[5px] px-2 py-0.5 text-xs transition-all duration-150',
                focus === o.key
                  ? 'bg-primary text-primary-foreground shadow-sm'
                  : 'text-muted-foreground hover:text-foreground',
              )}
            >
              {o.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Sortable header cell                                                */
/* ------------------------------------------------------------------ */

function Th({
  children,
  align,
  active,
  dir,
  onClick,
  sortable = true,
  title,
}: {
  children: React.ReactNode;
  align: 'left' | 'right';
  active?: boolean;
  dir?: SortDir;
  onClick?: () => void;
  sortable?: boolean;
  title?: string;
}) {
  if (!sortable) {
    return (
      <th
        className={cn(
          'px-2 py-1.5 font-medium',
          align === 'right' ? 'text-right' : 'text-left',
        )}
        title={title}
      >
        {children}
      </th>
    );
  }
  return (
    <th
      className={cn('px-2 py-1.5 font-medium', align === 'right' ? 'text-right' : 'text-left')}
    >
      <button
        type="button"
        onClick={onClick}
        title={title}
        aria-sort={active ? (dir === 'asc' ? 'ascending' : 'descending') : 'none'}
        className={cn(
          'inline-flex items-center gap-1 transition-colors duration-150 hover:text-foreground',
          align === 'right' && 'flex-row-reverse',
          active && 'text-foreground',
        )}
      >
        <span>{children}</span>
        {active ? (
          dir === 'asc' ? (
            <ArrowUp className="h-3 w-3" />
          ) : (
            <ArrowDown className="h-3 w-3" />
          )
        ) : (
          <ChevronsUpDown className="h-3 w-3 opacity-40" />
        )}
      </button>
    </th>
  );
}

/* ------------------------------------------------------------------ */
/* Legend                                                              */
/* ------------------------------------------------------------------ */

function Legend() {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-muted-foreground">
      <span className="inline-flex items-center gap-1">
        <span className="h-2 w-2 rounded-full bg-emerald-500/70" />
        cheapest avg
      </span>
      <span className="inline-flex items-center gap-1">
        <span className="h-2 w-2 rounded-full bg-red-500/70" />
        most expensive avg
      </span>
      <span className="inline-flex items-center gap-1">
        <TrendingUp className="h-3 w-3 text-red-500" />
        price rising (bad for a buyer)
      </span>
      <span className="inline-flex items-center gap-1">
        <TrendingDown className="h-3 w-3 text-emerald-500" />
        price falling (good)
      </span>
      <span className="inline-flex items-center gap-1">
        <AlertTriangle className="h-3 w-3 text-amber-500" />
        steepest YTD riser
      </span>
    </div>
  );
}
