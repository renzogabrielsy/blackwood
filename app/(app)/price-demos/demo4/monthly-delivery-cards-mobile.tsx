'use client';

// ─────────────────────────────────────────────────────────────────────────────
// MonthlyDeliveryCardsMobile — Summaries "By Period" phone read layer.
//
// Rendered `sm:hidden` by AnalystBriefClient; the desktop MonthlyDeliveriesTable
// is `hidden sm:block` and untouched (Excel cell-range drag-select stays
// desktop-only). Built on the platform MobileCardList primitive (Archetype C).
// Fed the SAME `focusRows` (byYear[focusYear]) the desktop table renders — single
// source of truth, no refetch, no second data path.
//
// Card headline (≤6, NO ₱): month · weight (kg) · deliveries · MC.
// Detail sheet: deliveries · sacks · weight, the full lab panel, and ₱/kg + ₱
// Total (BOTH gated behind `canViewPrices`). ₱ NEVER appears in the card headline.
// ─────────────────────────────────────────────────────────────────────────────

import * as React from 'react';
import { cn } from '@/lib/utils';
import { MobileCardList } from '@/components/shared/mobile/mobile-card-list';
import type { MonthlyDeliveryRow } from './actions';

// ─── Formatters ──────────────────────────────────────────────────────────────

const fmt0 = (v: number | null | undefined) =>
  v == null ? '—' : v.toLocaleString('en-PH', { maximumFractionDigits: 0 });
const fmtN = (v: number | null | undefined, d: number) =>
  v == null || Number.isNaN(v)
    ? '—'
    : v.toLocaleString('en-PH', { minimumFractionDigits: d, maximumFractionDigits: d });
const fmtMoney = (v: number | null | undefined) =>
  v == null
    ? '—'
    : v.toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// ─── Props ───────────────────────────────────────────────────────────────────

export interface MonthlyDeliveryCardsMobileProps {
  /** The focus year's 12-month axis — the SAME array the desktop table renders. */
  rows: MonthlyDeliveryRow[];
  /** ₱ gate. When false, ₱ fields are already null upstream; the detail hides them. */
  canViewPrices: boolean;
}

// ─── Component ───────────────────────────────────────────────────────────────

export function MonthlyDeliveryCardsMobile({
  rows,
  canViewPrices,
}: MonthlyDeliveryCardsMobileProps) {
  return (
    <MobileCardList<MonthlyDeliveryRow>
      items={rows}
      getKey={(r) => r.monthKey}
      estimateSize={60}
      renderCard={(r) => <MonthCard row={r} />}
      renderDetail={(r) => <MonthDetail row={r} canViewPrices={canViewPrices} />}
      getDetailTitle={(r) => r.full}
      getDetailDescription={(r) =>
        `FY ${r.year} · ${r.deliveries.toLocaleString('en-PH')} deliveries`
      }
      emptyState={
        <div className="flex h-full flex-col items-center justify-center gap-1 py-16 text-center animate-fade-up">
          <p className="text-sm text-muted-foreground">No monthly data.</p>
        </div>
      }
      fullTableSlot={<MonthlyFullTable rows={rows} canViewPrices={canViewPrices} />}
      fullTableTitle="Monthly deliveries · full table"
    />
  );
}

// ─── Card headline (≤6 fields, NO ₱) ─────────────────────────────────────────

function MonthCard({ row }: { row: MonthlyDeliveryRow }) {
  const empty = row.weightKg === 0;
  return (
    <div className="flex items-start gap-2.5 px-3 py-2.5">
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline justify-between gap-2">
          <span className="truncate text-sm font-medium">{row.full}</span>
          <span
            className={cn(
              'shrink-0 font-mono text-sm tabular-nums',
              empty && 'text-muted-foreground/60',
            )}
          >
            {empty ? '—' : `${fmt0(row.weightKg)} kg`}
          </span>
        </div>
        <div className="mt-0.5 flex items-center gap-1.5 truncate font-mono text-[11px] text-muted-foreground">
          <span className="tabular-nums">
            {empty ? '0' : row.deliveries.toLocaleString('en-PH')} deliveries
          </span>
          <span aria-hidden>·</span>
          <span className="tabular-nums">MC {fmtN(row.mc, 2)}</span>
        </div>
      </div>
    </div>
  );
}

// ─── Detail sheet body (every field; ₱ gated) ────────────────────────────────

function MonthDetail({
  row,
  canViewPrices,
}: {
  row: MonthlyDeliveryRow;
  canViewPrices: boolean;
}) {
  return (
    <div className="flex flex-col gap-4">
      {/* Core numbers */}
      <div className="grid grid-cols-3 gap-x-4 gap-y-2">
        <Field label="Deliveries" value={fmt0(row.deliveries)} mono />
        <Field label="Sacks" value={fmt0(row.sacks)} mono />
        <Field label="Weight (kg)" value={fmt0(row.weightKg)} mono />
      </div>

      {/* Lab panel — MC/Grit/VM/Ash/FC (2dp), BD ASTM/BD JIS (3dp) */}
      <div>
        <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
          Lab (volume-weighted)
        </p>
        <div className="grid grid-cols-4 gap-px overflow-hidden rounded-md border bg-border">
          <LabCell label="MC" value={fmtN(row.mc, 2)} />
          <LabCell label="Grit" value={fmtN(row.grit, 2)} />
          <LabCell label="VM" value={fmtN(row.vm, 2)} />
          <LabCell label="Ash" value={fmtN(row.ash, 2)} />
          <LabCell label="FC" value={fmtN(row.fc, 2)} />
          <LabCell label="BD ASTM" value={fmtN(row.bdAstm, 3)} />
          <LabCell label="BD JIS" value={fmtN(row.bdJis, 3)} />
        </div>
      </div>

      {/* Prices — gated (Production never sees these) */}
      {canViewPrices ? (
        <div className="grid grid-cols-2 gap-x-4 gap-y-2">
          <MoneyField label="₱ / kg" value={fmtMoney(row.phpPerKg)} />
          <MoneyField label="₱ Total" value={fmtMoney(row.phpTotal)} />
        </div>
      ) : null}
    </div>
  );
}

// ─── Field primitives ────────────────────────────────────────────────────────

function Field({
  label,
  value,
  mono,
}: {
  label: string;
  value: React.ReactNode;
  mono?: boolean;
}) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
        {label}
      </span>
      <span className={cn('truncate text-sm', mono && 'font-mono tabular-nums')}>
        {value}
      </span>
    </div>
  );
}

function LabCell({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col items-center gap-0.5 bg-card px-1 py-1.5">
      <span className="text-[9px] font-semibold uppercase tracking-wide text-muted-foreground">
        {label}
      </span>
      <span className="font-mono text-xs tabular-nums">{value}</span>
    </div>
  );
}

function MoneyField({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
        {label}
      </span>
      <span className="flex items-center justify-between rounded-md border bg-muted/30 px-2 py-1 text-sm">
        <span className="text-muted-foreground">₱</span>
        <span className="font-mono tabular-nums">{value}</span>
      </span>
    </div>
  );
}

// ─── Full-table escape hatch (read-only, horizontally scrollable) ────────────

function MonthlyFullTable({
  rows,
  canViewPrices,
}: {
  rows: MonthlyDeliveryRow[];
  canViewPrices: boolean;
}) {
  return (
    <div className="overflow-auto">
      <table className="w-full min-w-[880px] caption-bottom border-collapse text-xs">
        <thead className="sticky top-0 z-10 bg-muted">
          <tr className="border-b">
            {[
              'Month',
              'Deliveries',
              'Sacks',
              'Weight',
              'MC',
              'Grit',
              'VM',
              'Ash',
              'FC',
              'BD ASTM',
              'BD JIS',
              ...(canViewPrices ? ['₱/kg', '₱ TTL'] : []),
            ].map((h, i) => (
              <th
                key={h}
                className={cn(
                  'whitespace-nowrap border-r px-2 py-1 font-bold text-foreground last:border-r-0',
                  i === 0 ? 'text-left' : 'text-right',
                )}
              >
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const empty = r.weightKg === 0;
            return (
              <tr key={r.monthKey} className="h-8 border-b last:border-0">
                <td className="whitespace-nowrap px-2 py-1">{r.full}</td>
                <td className="whitespace-nowrap px-2 py-1 text-right font-mono">
                  {empty ? '—' : r.deliveries.toLocaleString('en-PH')}
                </td>
                <td className="whitespace-nowrap px-2 py-1 text-right font-mono">
                  {empty ? '—' : fmt0(r.sacks)}
                </td>
                <td className="whitespace-nowrap px-2 py-1 text-right font-mono">
                  {empty ? '—' : fmt0(r.weightKg)}
                </td>
                <td className="whitespace-nowrap px-2 py-1 text-right font-mono">{fmtN(r.mc, 2)}</td>
                <td className="whitespace-nowrap px-2 py-1 text-right font-mono">{fmtN(r.grit, 2)}</td>
                <td className="whitespace-nowrap px-2 py-1 text-right font-mono">{fmtN(r.vm, 2)}</td>
                <td className="whitespace-nowrap px-2 py-1 text-right font-mono">{fmtN(r.ash, 2)}</td>
                <td className="whitespace-nowrap px-2 py-1 text-right font-mono">{fmtN(r.fc, 2)}</td>
                <td className="whitespace-nowrap px-2 py-1 text-right font-mono">{fmtN(r.bdAstm, 3)}</td>
                <td className="whitespace-nowrap px-2 py-1 text-right font-mono">{fmtN(r.bdJis, 3)}</td>
                {canViewPrices ? (
                  <>
                    <td className="whitespace-nowrap px-2 py-1 text-right font-mono">{fmtMoney(r.phpPerKg)}</td>
                    <td className="whitespace-nowrap px-2 py-1 text-right font-mono">{fmtMoney(r.phpTotal)}</td>
                  </>
                ) : null}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
