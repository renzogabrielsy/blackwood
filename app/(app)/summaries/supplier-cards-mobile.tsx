'use client';

// ─────────────────────────────────────────────────────────────────────────────
// SupplierCardsMobile — Summaries "By Supplier" phone read layer.
//
// Rendered `sm:hidden` by SupplierBriefClient; the desktop SupplierTable is
// `hidden sm:block` and untouched (Excel cell-range drag-select + sortable
// headers stay desktop-only). Built on the platform MobileCardList primitive
// (Archetype C). Fed the SAME `tableRows` the desktop table renders — single
// source of truth, no refetch.
//
// Card headline (≤6, NO ₱): [on-graph toggle] · supplier · weight (kg) ·
// deliveries · sacks. The leading checkbox becomes a small in-header toggle
// wired to the SAME `toggleGraph` handler as the desktop table.
// Detail sheet: deliveries · sacks · weight, the full lab panel, ₱/kg + ₱ Total
// (BOTH gated behind `canViewPrices`), and an "Open full profile" button that
// opens the EXISTING SupplierDetailPanel Sheet (via onOpenSupplier — no logic
// duplicated). ₱ NEVER appears in the card headline.
// ─────────────────────────────────────────────────────────────────────────────

import * as React from 'react';
import { PanelRightOpen } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { MobileCardList } from '@/components/shared/mobile/mobile-card-list';

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

// ─── Row shape (structural subset of the desktop SupplierTableRow) ───────────

/** The flat per-supplier metrics the cards need. SupplierTableRow satisfies this
 *  structurally (it adds `supplier`), so the page passes `tableRows` directly. */
export interface SupplierCardRow {
  name: string;
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

// ─── Props ───────────────────────────────────────────────────────────────────

export interface SupplierCardsMobileProps {
  /** Rolled-up supplier rows for the selected periods — SAME array as the table. */
  rows: SupplierCardRow[];
  /** ₱ gate. When false, ₱ fields are already null upstream; the detail hides them. */
  canViewPrices: boolean;
  /** Currently-graphed supplier names (shared with the desktop control). */
  graphed: Set<string>;
  /** True when the 6-supplier graph cap is reached (unchecked toggles disabled). */
  graphedFull: boolean;
  /** Graphed supplier → hue (for the card swatch), shared with the desktop table. */
  colors: Record<string, string>;
  /** Toggle graph membership — the SAME handler the desktop checkbox column uses. */
  onToggleGraph: (name: string) => void;
  /** Open the existing right-side SupplierDetailPanel Sheet for a supplier. */
  onOpenSupplier: (name: string) => void;
}

// ─── Component ───────────────────────────────────────────────────────────────

export function SupplierCardsMobile({
  rows,
  canViewPrices,
  graphed,
  graphedFull,
  colors,
  onToggleGraph,
  onOpenSupplier,
}: SupplierCardsMobileProps) {
  return (
    <MobileCardList<SupplierCardRow>
      items={rows}
      getKey={(r) => r.name}
      estimateSize={64}
      renderCard={(r) => (
        <SupplierCard
          row={r}
          isGraphed={graphed.has(r.name)}
          graphedFull={graphedFull}
          swatch={graphed.has(r.name) ? colors[r.name] : undefined}
          onToggleGraph={onToggleGraph}
        />
      )}
      renderDetail={(r) => (
        <SupplierDetail
          row={r}
          canViewPrices={canViewPrices}
          onOpenSupplier={onOpenSupplier}
        />
      )}
      getDetailTitle={(r) => r.name}
      getDetailDescription={(r) =>
        `${fmt0(r.weightKg)} kg · ${r.deliveries.toLocaleString('en-PH')} deliveries`
      }
      emptyState={
        <div className="flex h-full flex-col items-center justify-center gap-1 py-16 text-center animate-fade-up">
          <p className="text-sm text-muted-foreground">
            No suppliers for the selected periods.
          </p>
        </div>
      }
      fullTableSlot={<SupplierFullTable rows={rows} canViewPrices={canViewPrices} />}
      fullTableTitle="Suppliers · full table"
    />
  );
}

// ─── Card headline (≤6 fields, NO ₱; leading on-graph toggle) ────────────────

function SupplierCard({
  row,
  isGraphed,
  graphedFull,
  swatch,
  onToggleGraph,
}: {
  row: SupplierCardRow;
  isGraphed: boolean;
  graphedFull: boolean;
  swatch?: string;
  onToggleGraph: (name: string) => void;
}) {
  const empty = row.weightKg === 0;
  const toggleDisabled = !isGraphed && graphedFull;
  return (
    <div className="flex items-start gap-2.5 px-3 py-2.5">
      {/* On-graph toggle — stopPropagation so it doesn't open the detail sheet. */}
      <span
        className="mt-0.5 shrink-0"
        onClick={(e) => e.stopPropagation()}
        onPointerDown={(e) => e.stopPropagation()}
      >
        <Checkbox
          checked={isGraphed}
          disabled={toggleDisabled}
          onCheckedChange={() => onToggleGraph(row.name)}
          aria-label={`Show ${row.name} on graph`}
          className="size-4"
        />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline justify-between gap-2">
          <span className="flex min-w-0 items-center gap-1.5">
            {swatch ? (
              <span
                className="inline-block size-2 shrink-0 rounded-full"
                style={{ backgroundColor: swatch }}
                aria-hidden
              />
            ) : null}
            <span className="truncate text-sm font-medium">{row.name}</span>
          </span>
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
            {row.deliveries.toLocaleString('en-PH')} deliveries
          </span>
          <span aria-hidden>·</span>
          <span className="tabular-nums">{fmt0(row.sacks)} sacks</span>
        </div>
      </div>
    </div>
  );
}

// ─── Detail sheet body (every field; ₱ gated; profile entry point) ───────────

function SupplierDetail({
  row,
  canViewPrices,
  onOpenSupplier,
}: {
  row: SupplierCardRow;
  canViewPrices: boolean;
  onOpenSupplier: (name: string) => void;
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

      {/* Full profile — reuses the existing SupplierDetailPanel Sheet. */}
      <Button
        variant="outline"
        size="sm"
        className="h-10 w-full gap-1.5"
        onClick={() => onOpenSupplier(row.name)}
      >
        <PanelRightOpen className="size-3.5" />
        Open full profile
      </Button>
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

function SupplierFullTable({
  rows,
  canViewPrices,
}: {
  rows: SupplierCardRow[];
  canViewPrices: boolean;
}) {
  return (
    <div className="overflow-auto">
      <table className="w-full min-w-[980px] caption-bottom border-collapse text-xs">
        <thead className="sticky top-0 z-10 bg-muted">
          <tr className="border-b">
            {[
              'Supplier',
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
          {rows.map((r) => (
            <tr key={r.name} className="h-8 border-b last:border-0">
              <td className="max-w-[180px] truncate px-2 py-1" title={r.name}>{r.name}</td>
              <td className="whitespace-nowrap px-2 py-1 text-right font-mono">{fmt0(r.deliveries)}</td>
              <td className="whitespace-nowrap px-2 py-1 text-right font-mono">{fmt0(r.sacks)}</td>
              <td className="whitespace-nowrap px-2 py-1 text-right font-mono">{fmt0(r.weightKg)}</td>
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
          ))}
        </tbody>
      </table>
    </div>
  );
}
