"use client";

// ─────────────────────────────────────────────────────────────────────────────
// DeliveryCardsMobile — RC IN (Deliveries) phone read layer.
//
// Rendered `sm:hidden` by DeliveryMasterTable; the desktop `<table>` is
// `hidden sm:*` and untouched. Built on the platform MobileCardList primitive
// (Archetype C). Fed the SAME `filteredData` + filter state the desktop table
// uses (single source of truth) — no refetch, no second data path.
//
// Card headline (≤6, NO ₱): date · supplier · batch · weight (kg) · block_loc · state.
// Detail sheet: every field — full lab panel, ₱/kg + ₱ total (BOTH gated behind
// `canViewPrices`), truck, sacks, remarks, deduction annotation, history entry point.
// ₱ NEVER appears in the card headline.
// ─────────────────────────────────────────────────────────────────────────────

import * as React from "react";
import { Search, SlidersHorizontal, History, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";
import { MobileCardList } from "@/components/shared/mobile/mobile-card-list";
import { getStateDotClass } from "@/types/table-settings";
import { TrueWeightPopover } from "@/app/(app)/inventory/_shared/true-weight-popover";
import { LocFilterContent } from "../delivery-master-table";
import type { DeliveryHistoryRow } from "@/types/rc-in";

// ─── Formatters ──────────────────────────────────────────────────────────────

const fmt0 = (v: number | null | undefined) =>
  v == null ? "—" : v.toLocaleString("en-US", { maximumFractionDigits: 0 });
const fmtN = (v: number | null | undefined, d: number) =>
  v == null || Number.isNaN(v)
    ? "—"
    : v.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
const fmtMoney = (v: number | null | undefined) =>
  v == null ? "—" : v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// ─── Props ───────────────────────────────────────────────────────────────────

export interface DeliveryCardsMobileProps {
  data: DeliveryHistoryRow[];
  canViewPrices: boolean;
  // Search — reuse the desktop table's server-search state.
  searchTerm: string;
  onSearchChange: (value: string) => void;
  matchCount: number;
  // Filter state (shared with the desktop table's column-header popovers).
  uniqueStates: string[];
  stateExcluded: Set<string>;
  onToggleState: (value: string, exclude: boolean) => void;
  onSelectAllStates: () => void;
  onDeselectAllStates: (all: string[]) => void;
  allSuppliers: string[];
  supIncluded: Set<string>;
  onToggleSupplier: (value: string) => void;
  onClearSuppliers: () => void;
  locsByWhse: Record<string, string[]>;
  locIncluded: Set<string>;
  onLocFiltersChange: (next: Set<string>) => void;
  hasActiveFilters: boolean;
  onClearAllFilters: () => void;
  // Read-only history entry point (reuses the parent's DeliveryHistoryDialog).
  onViewHistory: (row: DeliveryHistoryRow) => void;
}

// ─── Component ───────────────────────────────────────────────────────────────

export function DeliveryCardsMobile(props: DeliveryCardsMobileProps) {
  const {
    data,
    canViewPrices,
    searchTerm,
    onSearchChange,
    matchCount,
    hasActiveFilters,
    onViewHistory,
  } = props;

  const [filtersOpen, setFiltersOpen] = React.useState(false);

  const activeFilterCount =
    (props.stateExcluded.size > 0 && props.stateExcluded.size < props.uniqueStates.length ? 1 : 0) +
    (props.supIncluded.size > 0 ? 1 : 0) +
    (props.locIncluded.size > 0 ? 1 : 0);

  const toolbar = (
    <div className="flex items-center gap-2 border-b bg-background px-3 py-2">
      <div className="relative flex-1">
        <Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
        <Input
          placeholder="Search supplier, batch, truck…"
          value={searchTerm}
          onChange={(e) => onSearchChange(e.target.value)}
          className="h-9 w-full pl-7 text-sm"
        />
      </div>
      {searchTerm ? (
        <span className="shrink-0 rounded-full bg-primary/10 px-1.5 text-[10px] font-medium text-primary">
          {matchCount}
        </span>
      ) : null}
      <Button
        variant={hasActiveFilters ? "default" : "outline"}
        size="sm"
        className="h-9 shrink-0 gap-1.5 px-3"
        onClick={() => setFiltersOpen(true)}
      >
        <SlidersHorizontal className="size-3.5" />
        Filters
        {activeFilterCount > 0 ? (
          <span className="rounded-full bg-background/20 px-1 text-[10px] font-semibold leading-none">
            {activeFilterCount}
          </span>
        ) : null}
      </Button>
    </div>
  );

  return (
    <>
      <MobileCardList<DeliveryHistoryRow>
        items={data}
        getKey={(d) => d.id}
        estimateSize={64}
        toolbar={toolbar}
        renderCard={(d) => <DeliveryCard row={d} />}
        renderDetail={(d) => (
          <DeliveryDetail row={d} canViewPrices={canViewPrices} onViewHistory={onViewHistory} />
        )}
        getDetailTitle={(d) => d.supplier || "Delivery"}
        getDetailDescription={(d) =>
          `${d.transaction_date} · ${d.batch_code || "—"}`
        }
        emptyState={
          <div className="flex h-full flex-col items-center justify-center gap-1 py-16 text-center animate-fade-up">
            <p className="text-sm text-muted-foreground">No deliveries found.</p>
            {hasActiveFilters || searchTerm ? (
              <p className="text-xs text-muted-foreground/70">Try clearing filters or search.</p>
            ) : null}
          </div>
        }
        fullTableSlot={<DeliveryFullTable data={data} canViewPrices={canViewPrices} />}
        fullTableTitle="Deliveries · full table"
      />

      <DeliveryFilterSheet open={filtersOpen} onOpenChange={setFiltersOpen} {...props} />
    </>
  );
}

// ─── Card headline (≤6 fields, NO ₱) ─────────────────────────────────────────

function DeliveryCard({ row }: { row: DeliveryHistoryRow }) {
  const state = row.state || "STORED";
  const loc = row.block_loc || row.batches?.location_ref || "—";
  return (
    <div className="flex items-start gap-2.5 px-3 py-2.5">
      <span
        className={cn("mt-1 inline-block size-2 shrink-0 rounded-full", getStateDotClass(state))}
        aria-hidden
      />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline justify-between gap-2">
          <span className="truncate text-sm font-medium">{row.supplier || "—"}</span>
          <span className="shrink-0 font-mono text-sm tabular-nums">{fmt0(row.weight_kg)} kg</span>
        </div>
        <div className="mt-0.5 flex items-center gap-1.5 truncate font-mono text-[11px] text-muted-foreground">
          <span className="tabular-nums">{row.transaction_date}</span>
          <span aria-hidden>·</span>
          <span className="truncate">{row.batch_code || "—"}</span>
          <span aria-hidden>·</span>
          <span>{loc}</span>
        </div>
      </div>
    </div>
  );
}

// ─── Detail sheet body (every field; ₱ gated) ────────────────────────────────

function DeliveryDetail({
  row,
  canViewPrices,
  onViewHistory,
}: {
  row: DeliveryHistoryRow;
  canViewPrices: boolean;
  onViewHistory: (row: DeliveryHistoryRow) => void;
}) {
  const lab = row.lab_results ?? {};
  const tagged = row.true_weight_kg != null;
  const phpTotal =
    canViewPrices && row.cost_basis != null
      ? row.cost_basis * (row.weight_kg || 0)
      : null;

  return (
    <div className="flex flex-col gap-4">
      {/* Identity + core numbers */}
      <div className="grid grid-cols-2 gap-x-4 gap-y-2">
        <Field label="Date" value={row.transaction_date} mono />
        <Field label="State" value={row.state || "STORED"} />
        <Field label="Batch" value={row.batch_code || "—"} mono />
        <Field label="Block / Loc" value={row.block_loc || row.batches?.location_ref || "—"} mono />
        <Field label="Truck Plate" value={row.truck_plate || "—"} mono />
        <Field label="Sacks" value={fmt0(row.sacks)} mono align="left" />
        <Field
          label="Weight (kg)"
          mono
          value={
            <span className="inline-flex items-center gap-1">
              {fmt0(row.weight_kg)}
              {tagged ? (
                <TrueWeightPopover
                  trueWeightKg={row.true_weight_kg!}
                  weightKg={row.weight_kg}
                  deductionNote={row.deduction_note ?? null}
                  costBasis={canViewPrices ? row.cost_basis ?? null : null}
                  canViewPrices={canViewPrices}
                >
                  <button
                    type="button"
                    className="text-muted-foreground/70 transition-colors hover:text-foreground"
                    aria-label="Weight deduction details"
                  >
                    <span className="font-mono text-[10px]">Σ</span>
                  </button>
                </TrueWeightPopover>
              ) : null}
            </span>
          }
        />
      </div>

      {/* Lab panel — MC/Grit/VM/Ash/FC (2dp), BD ASTM/BD JIS (3dp) */}
      <div>
        <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
          Lab Results
        </p>
        <div className="grid grid-cols-4 gap-px overflow-hidden rounded-md border bg-border">
          <LabCell label="MC" value={fmtN(lab.mc, 2)} />
          <LabCell label="Grit" value={fmtN(lab.grit, 2)} />
          <LabCell label="VM" value={fmtN(lab.vm, 2)} />
          <LabCell label="Ash" value={fmtN(lab.ash, 2)} />
          <LabCell label="FC" value={fmtN(lab.fc, 2)} />
          <LabCell label="BD ASTM" value={fmtN(lab.bd_astm, 3)} />
          <LabCell label="BD JIS" value={fmtN(lab.bd_jis, 3)} />
        </div>
      </div>

      {/* Prices — gated (Production never sees these) */}
      {canViewPrices ? (
        <div className="grid grid-cols-2 gap-x-4 gap-y-2">
          <MoneyField label="PHP / KG" value={row.cost_basis != null ? fmtMoney(row.cost_basis) : "—"} />
          <MoneyField label="PHP Total" value={phpTotal != null ? fmtMoney(phpTotal) : "—"} />
        </div>
      ) : null}

      {/* Deduction note */}
      {row.deduction_note ? (
        <Field label="Deduction" value={row.deduction_note} />
      ) : null}

      {/* Remarks */}
      <Field label="Remarks" value={row.remarks?.trim() ? row.remarks : "—"} wrap />

      {/* History entry point */}
      <Button
        variant="outline"
        size="sm"
        className="h-10 w-full gap-1.5"
        onClick={() => onViewHistory(row)}
      >
        <History className="size-3.5" />
        View history & audit trail
      </Button>
    </div>
  );
}

// ─── Field primitives ────────────────────────────────────────────────────────

function Field({
  label,
  value,
  mono,
  wrap,
  align = "left",
}: {
  label: string;
  value: React.ReactNode;
  mono?: boolean;
  wrap?: boolean;
  align?: "left" | "right";
}) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
        {label}
      </span>
      <span
        className={cn(
          "text-sm",
          mono && "font-mono tabular-nums",
          wrap ? "break-words" : "truncate",
          align === "right" && "text-right",
        )}
      >
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

// ─── Mobile Filter Sheet ─────────────────────────────────────────────────────

function DeliveryFilterSheet({
  open,
  onOpenChange,
  uniqueStates,
  stateExcluded,
  onToggleState,
  onSelectAllStates,
  onDeselectAllStates,
  allSuppliers,
  supIncluded,
  onToggleSupplier,
  onClearSuppliers,
  locsByWhse,
  locIncluded,
  onLocFiltersChange,
  hasActiveFilters,
  onClearAllFilters,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
} & Omit<DeliveryCardsMobileProps, "data" | "canViewPrices" | "searchTerm" | "onSearchChange" | "matchCount" | "onViewHistory">) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="bottom"
        className="flex max-h-[90dvh] flex-col gap-0 rounded-t-2xl p-0"
      >
        <SheetHeader className="shrink-0 flex-row items-center justify-between border-b bg-background/90 px-4 py-3 backdrop-blur-sm">
          <div>
            <SheetTitle>Filters</SheetTitle>
            <SheetDescription>Filter deliveries by state, supplier and location.</SheetDescription>
          </div>
          {hasActiveFilters ? (
            <Button
              variant="ghost"
              size="sm"
              className="h-8 gap-1 px-2 text-xs text-muted-foreground"
              onClick={onClearAllFilters}
            >
              <X className="size-3" />
              Clear all
            </Button>
          ) : null}
        </SheetHeader>

        <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-4 py-4">
          {/* STATE (exclusion model) */}
          <section>
            <div className="mb-2 flex items-center justify-between">
              <p className="text-xs font-semibold text-muted-foreground">State</p>
              <div className="flex gap-3">
                <button
                  onClick={onSelectAllStates}
                  className="text-[10px] text-muted-foreground hover:text-foreground"
                >
                  Select all
                </button>
                <button
                  onClick={() => onDeselectAllStates(uniqueStates)}
                  className="text-[10px] text-muted-foreground hover:text-foreground"
                >
                  Deselect all
                </button>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-1">
              {uniqueStates.map((s) => (
                <label
                  key={s}
                  className="flex items-center gap-2 rounded px-1 py-1.5 text-sm hover:bg-muted"
                >
                  <Checkbox
                    checked={!stateExcluded.has(s)}
                    onCheckedChange={(checked) => onToggleState(s, !checked)}
                    className="size-4"
                  />
                  <span className="inline-flex items-center gap-1.5">
                    <span className={cn("inline-block size-1.5 shrink-0 rounded-full", getStateDotClass(s))} />
                    <span className="text-xs uppercase">{s}</span>
                  </span>
                </label>
              ))}
            </div>
          </section>

          {/* SUPPLIER (inclusion model) */}
          <section>
            <div className="mb-2 flex items-center justify-between">
              <p className="text-xs font-semibold text-muted-foreground">Supplier</p>
              {supIncluded.size > 0 ? (
                <button onClick={onClearSuppliers} className="text-[10px] text-muted-foreground hover:text-foreground">
                  Clear
                </button>
              ) : null}
            </div>
            <div className="rounded-md border">
              <Command>
                <CommandInput placeholder="Search suppliers…" className="text-sm" />
                <CommandList className="max-h-48">
                  <CommandEmpty>No supplier found.</CommandEmpty>
                  <CommandGroup>
                    {allSuppliers.map((s) => (
                      <CommandItem
                        key={s}
                        value={s}
                        onSelect={() => onToggleSupplier(s)}
                        className="text-xs font-mono"
                      >
                        <Checkbox checked={supIncluded.has(s)} className="mr-2 size-4" />
                        {s}
                      </CommandItem>
                    ))}
                  </CommandGroup>
                </CommandList>
              </Command>
            </div>
          </section>

          {/* LOCATION (inclusion model) — reuse the desktop whse-tree content */}
          <section>
            <LocFilterContent
              locsByWhse={locsByWhse}
              activeLocFilters={locIncluded}
              onFiltersChange={onLocFiltersChange}
            />
          </section>
        </div>

        <div className="shrink-0 border-t bg-background/90 px-4 py-3 backdrop-blur-sm">
          <Button className="h-10 w-full" onClick={() => onOpenChange(false)}>
            Done
          </Button>
        </div>
      </SheetContent>
    </Sheet>
  );
}

// ─── Full-table escape hatch (read-only, horizontally scrollable) ────────────

function DeliveryFullTable({
  data,
  canViewPrices,
}: {
  data: DeliveryHistoryRow[];
  canViewPrices: boolean;
}) {
  return (
    <div className="overflow-auto">
      <table className="w-full min-w-[1120px] caption-bottom border-collapse text-xs">
        <thead className="sticky top-0 z-10 bg-muted">
          <tr className="border-b">
            {[
              "State",
              "Date",
              "Supplier",
              "Batch",
              "Loc",
              "Truck",
              "WT",
              "Sacks",
              "MC",
              "Grit",
              "BD ASTM",
              "BD JIS",
              "VM",
              "Ash",
              "FC",
              "Remarks",
              ...(canViewPrices ? ["₱/KG", "₱ TTL"] : []),
            ].map((h) => (
              <th
                key={h}
                className="whitespace-nowrap border-r px-2 py-1 text-left font-bold text-foreground last:border-r-0"
              >
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {data.map((d) => {
            const lab = d.lab_results ?? {};
            const total = canViewPrices && d.cost_basis != null ? d.cost_basis * (d.weight_kg || 0) : null;
            return (
              <tr key={d.id} className="h-8 border-b last:border-0">
                <td className="whitespace-nowrap px-2 py-1">{d.state || "STORED"}</td>
                <td className="whitespace-nowrap px-2 py-1 font-mono">{d.transaction_date}</td>
                <td className="whitespace-nowrap px-2 py-1">{d.supplier || "—"}</td>
                <td className="whitespace-nowrap px-2 py-1 font-mono">{d.batch_code || "—"}</td>
                <td className="whitespace-nowrap px-2 py-1 font-mono">{d.block_loc || d.batches?.location_ref || "—"}</td>
                <td className="whitespace-nowrap px-2 py-1 font-mono">{d.truck_plate || "—"}</td>
                <td className="whitespace-nowrap px-2 py-1 text-right font-mono">{fmt0(d.weight_kg)}</td>
                <td className="whitespace-nowrap px-2 py-1 text-right font-mono">{fmt0(d.sacks)}</td>
                <td className="whitespace-nowrap px-2 py-1 text-right font-mono">{fmtN(lab.mc, 2)}</td>
                <td className="whitespace-nowrap px-2 py-1 text-right font-mono">{fmtN(lab.grit, 2)}</td>
                <td className="whitespace-nowrap px-2 py-1 text-right font-mono">{fmtN(lab.bd_astm, 3)}</td>
                <td className="whitespace-nowrap px-2 py-1 text-right font-mono">{fmtN(lab.bd_jis, 3)}</td>
                <td className="whitespace-nowrap px-2 py-1 text-right font-mono">{fmtN(lab.vm, 2)}</td>
                <td className="whitespace-nowrap px-2 py-1 text-right font-mono">{fmtN(lab.ash, 2)}</td>
                <td className="whitespace-nowrap px-2 py-1 text-right font-mono">{fmtN(lab.fc, 2)}</td>
                <td className="max-w-[160px] truncate px-2 py-1" title={d.remarks || ""}>{d.remarks || "—"}</td>
                {canViewPrices ? (
                  <>
                    <td className="whitespace-nowrap px-2 py-1 text-right font-mono">{d.cost_basis != null ? fmtMoney(d.cost_basis) : "—"}</td>
                    <td className="whitespace-nowrap px-2 py-1 text-right font-mono">{total != null ? fmtMoney(total) : "—"}</td>
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
