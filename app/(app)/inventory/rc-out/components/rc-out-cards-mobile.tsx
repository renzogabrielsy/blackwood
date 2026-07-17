"use client";

// ─────────────────────────────────────────────────────────────────────────────
// RcOutCardsMobile — RC OUT (Usage) phone read layer.
//
// Rendered `sm:hidden` by RcOutTable; the desktop `<table>` paths are `hidden sm:*`
// and untouched. Built on the platform MobileCardList primitive (Archetype C),
// fed the SAME `filteredData` + filter state the desktop table uses.
//
// A "Feeding / Closed Blocks" segmented control above the list swaps the data
// source (reusing the same card primitive): feeding rows (RcOutRow) or the
// closed-blocks summary (view_rc_out_closed_blocks).
//
// Feeding headline (≤6, NO ₱): date · batch · plant/dest · weight · block_loc · state.
// Detail: full fields incl. computed avg ₱/kg + avg value (BOTH gated by canViewPrices).
// ─────────────────────────────────────────────────────────────────────────────

import * as React from "react";
import { Search, SlidersHorizontal, X, Loader2, PackageCheck, ListTree } from "lucide-react";
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
import type { RcOutRow } from "@/types/rc-out";
import type { Tables } from "@/types/supabase";

type ClosedBlockRow = Tables<"view_rc_out_closed_blocks">;

// ─── Formatters ──────────────────────────────────────────────────────────────

const fmt0 = (v: number | null | undefined) =>
  v == null ? "—" : v.toLocaleString("en-US", { maximumFractionDigits: 0 });
const fmtMoney = (v: number | null | undefined) =>
  v == null ? "—" : v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// ─── Props ───────────────────────────────────────────────────────────────────

export interface RcOutCardsMobileProps {
  data: RcOutRow[];
  canViewPrices: boolean;
  searchTerm: string;
  onSearchChange: (value: string) => void;
  // Closed-blocks segmented control (swaps the data source).
  closedBlocksMode: boolean;
  onToggleClosedBlocksMode: (on: boolean) => void;
  closedBlocks: ClosedBlockRow[] | null;
  closedLoading: boolean;
  closedCanViewPrices: boolean;
  // Filters (feeding view only).
  stateOptions: string[];
  stateExcluded: Set<string>;
  onToggleState: (value: string) => void;
  yearOptions: number[];
  selectedYears: Set<number>;
  onToggleYear: (year: number) => void;
  batchOptions: string[];
  selectedBatches: Set<string>;
  onToggleBatch: (value: string) => void;
  destinations: string[];
  selectedDestinations: Set<string>;
  onToggleDestination: (value: string) => void;
  blockLocs: string[];
  selectedBlockLocs: Set<string>;
  onToggleBlockLoc: (value: string) => void;
  hasActiveFilters: boolean;
  onClearAllFilters: () => void;
}

// ─── Component ───────────────────────────────────────────────────────────────

export function RcOutCardsMobile(props: RcOutCardsMobileProps) {
  const {
    data,
    canViewPrices,
    searchTerm,
    onSearchChange,
    closedBlocksMode,
    onToggleClosedBlocksMode,
    closedBlocks,
    closedLoading,
    closedCanViewPrices,
    hasActiveFilters,
  } = props;

  const [filtersOpen, setFiltersOpen] = React.useState(false);

  const activeFilterCount =
    (props.stateExcluded.size > 0 && props.stateExcluded.size < props.stateOptions.length ? 1 : 0) +
    (props.selectedYears.size > 0 ? 1 : 0) +
    (props.selectedBatches.size > 0 ? 1 : 0) +
    (props.selectedDestinations.size > 0 ? 1 : 0) +
    (props.selectedBlockLocs.size > 0 ? 1 : 0);

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Shared chrome: segmented control + (feeding) search & filters */}
      <div className="shrink-0 space-y-2 border-b bg-background px-3 py-2">
        {/* Feeding / Closed Blocks segmented control */}
        <div className="flex rounded-lg border p-0.5">
          <SegmentButton
            active={!closedBlocksMode}
            onClick={() => onToggleClosedBlocksMode(false)}
            icon={<ListTree className="size-3.5" />}
            label="Feeding"
          />
          <SegmentButton
            active={closedBlocksMode}
            onClick={() => onToggleClosedBlocksMode(true)}
            icon={<PackageCheck className="size-3.5" />}
            label="Closed Blocks"
          />
        </div>

        {!closedBlocksMode ? (
          <div className="flex items-center gap-2">
            <div className="relative flex-1">
              <Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                placeholder="Search batch, plant, block…"
                value={searchTerm}
                onChange={(e) => onSearchChange(e.target.value)}
                className="h-9 w-full pl-7 text-sm"
              />
            </div>
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
        ) : null}
      </div>

      {/* Body: feeding cards OR closed-blocks cards */}
      <div className="min-h-0 flex-1">
        {!closedBlocksMode ? (
          <MobileCardList<RcOutRow>
            items={data}
            getKey={(d) => d.id}
            estimateSize={64}
            renderCard={(d) => <FeedingCard row={d} />}
            renderDetail={(d) => <FeedingDetail row={d} canViewPrices={canViewPrices} />}
            getDetailTitle={(d) => d.production_batch || d.batches?.batch_code || "Usage"}
            getDetailDescription={(d) => `${d.transaction_date} · ${d.destination || "—"}`}
            emptyState={
              <div className="flex h-full flex-col items-center justify-center gap-1 py-16 text-center animate-fade-up">
                <p className="text-sm text-muted-foreground">No usage records found.</p>
                {hasActiveFilters || searchTerm ? (
                  <p className="text-xs text-muted-foreground/70">Try clearing filters or search.</p>
                ) : null}
              </div>
            }
            fullTableSlot={<FeedingFullTable data={data} canViewPrices={canViewPrices} />}
            fullTableTitle="Usage · full table"
          />
        ) : closedLoading && closedBlocks === null ? (
          <div className="flex h-full items-center justify-center">
            <Loader2 className="size-5 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <MobileCardList<ClosedBlockRow>
            items={closedBlocks ?? []}
            getKey={(b) => b.batch_id ?? `${b.batch_code}-${b.block_loc}-${b.close_date}`}
            estimateSize={60}
            renderCard={(b) => <ClosedBlockCard row={b} />}
            renderDetail={(b) => <ClosedBlockDetail row={b} canViewPrices={closedCanViewPrices} />}
            getDetailTitle={(b) => b.batch_code ?? "Closed block"}
            getDetailDescription={(b) => `Closed ${b.close_date ?? "—"} · ${b.block_loc || "—"}`}
            emptyState={
              <div className="flex h-full flex-col items-center justify-center py-16 text-center animate-fade-up">
                <p className="text-sm text-muted-foreground">No closed blocks.</p>
              </div>
            }
          />
        )}
      </div>

      <RcOutFilterSheet open={filtersOpen} onOpenChange={setFiltersOpen} {...props} />
    </div>
  );
}

// ─── Segmented control button ────────────────────────────────────────────────

function SegmentButton({
  active,
  onClick,
  icon,
  label,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex flex-1 items-center justify-center gap-1.5 rounded-md px-2 py-1.5 text-xs font-medium transition-colors",
        active
          ? "bg-primary text-primary-foreground shadow-sm"
          : "text-muted-foreground hover:text-foreground",
      )}
    >
      {icon}
      {label}
    </button>
  );
}

// ─── Feeding card headline (≤6, NO ₱) ────────────────────────────────────────

function FeedingCard({ row }: { row: RcOutRow }) {
  const state = row.batches?.status || "STORED";
  const loc = row.block_loc || row.batches?.location_ref || "—";
  const name = row.production_batch || row.batches?.batch_code || "—";
  return (
    <div className="flex items-start gap-2.5 px-3 py-2.5">
      <span
        className={cn("mt-1 inline-block size-2 shrink-0 rounded-full", getStateDotClass(state))}
        aria-hidden
      />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline justify-between gap-2">
          <span className="truncate text-sm font-medium">{name}</span>
          <span className="shrink-0 font-mono text-sm tabular-nums">{fmt0(row.weight_kg)} kg</span>
        </div>
        <div className="mt-0.5 flex items-center gap-1.5 truncate font-mono text-[11px] text-muted-foreground">
          <span className="tabular-nums">{row.transaction_date}</span>
          <span aria-hidden>·</span>
          <span className="truncate">{row.destination || "—"}</span>
          <span aria-hidden>·</span>
          <span>{loc}</span>
        </div>
      </div>
    </div>
  );
}

function FeedingDetail({ row, canViewPrices }: { row: RcOutRow; canViewPrices: boolean }) {
  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-2 gap-x-4 gap-y-2">
        <Field label="Date" value={row.transaction_date} mono />
        <Field label="State" value={row.batches?.status || "STORED"} />
        <Field label="Batch" value={row.production_batch || "—"} mono />
        <Field label="Batch Code" value={row.batches?.batch_code || "—"} mono />
        <Field label="Plant / Etc" value={row.destination || "—"} />
        <Field label="Block / Loc" value={row.block_loc || row.batches?.location_ref || "—"} mono />
        <Field label="Weight (kg)" value={fmt0(row.weight_kg)} mono />
      </div>

      {canViewPrices ? (
        <div className="grid grid-cols-2 gap-x-4 gap-y-2">
          <MoneyField label="Avg ₱/KG" value={row.avg_price != null ? fmtMoney(row.avg_price) : "—"} />
          <MoneyField label="Avg Value" value={row.avg_wtd_value != null ? fmtMoney(row.avg_wtd_value) : "—"} />
        </div>
      ) : null}

      <Field label="Remarks" value={row.remarks?.trim() ? row.remarks : "—"} wrap />
    </div>
  );
}

// ─── Closed-block card + detail ──────────────────────────────────────────────

function ClosedBlockCard({ row }: { row: ClosedBlockRow }) {
  return (
    <div className="flex items-start gap-2.5 px-3 py-2.5">
      <PackageCheck className="mt-0.5 size-3.5 shrink-0 text-red-500" aria-hidden />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline justify-between gap-2">
          <span className="truncate text-sm font-medium">{row.batch_code ?? "—"}</span>
          <span className="shrink-0 font-mono text-sm tabular-nums">{fmt0(row.total_fed_kg)} kg</span>
        </div>
        <div className="mt-0.5 flex items-center gap-1.5 truncate font-mono text-[11px] text-muted-foreground">
          <span className="tabular-nums">{row.close_date ?? "—"}</span>
          <span aria-hidden>·</span>
          <span>{row.block_loc || "—"}</span>
          <span aria-hidden>·</span>
          <span className="tabular-nums">{fmt0(row.feed_count)} feed{row.feed_count === 1 ? "" : "s"}</span>
        </div>
      </div>
    </div>
  );
}

function ClosedBlockDetail({ row, canViewPrices }: { row: ClosedBlockRow; canViewPrices: boolean }) {
  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-2 gap-x-4 gap-y-2">
        <Field label="Close Date" value={row.close_date ?? "—"} mono />
        <Field label="First Fed" value={row.first_fed_date ?? "—"} mono />
        <Field label="Batch" value={row.batch_code ?? "—"} mono />
        <Field label="Block" value={row.block_loc || "—"} mono />
        <Field label="Total Fed (kg)" value={fmt0(row.total_fed_kg)} mono />
        <Field label="Feedings" value={fmt0(row.feed_count)} mono />
      </div>

      {canViewPrices ? (
        <div className="grid grid-cols-2 gap-x-4 gap-y-2">
          <MoneyField label="Avg ₱/KG" value={row.avg_price != null ? fmtMoney(row.avg_price) : "—"} />
          <MoneyField label="Total Value" value={row.total_value != null ? fmtMoney(row.total_value) : "—"} />
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
  wrap,
}: {
  label: string;
  value: React.ReactNode;
  mono?: boolean;
  wrap?: boolean;
}) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
        {label}
      </span>
      <span className={cn("text-sm", mono && "font-mono tabular-nums", wrap ? "break-words" : "truncate")}>
        {value}
      </span>
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

// ─── Mobile Filter Sheet (feeding only) ──────────────────────────────────────

function RcOutFilterSheet({
  open,
  onOpenChange,
  stateOptions,
  stateExcluded,
  onToggleState,
  yearOptions,
  selectedYears,
  onToggleYear,
  batchOptions,
  selectedBatches,
  onToggleBatch,
  destinations,
  selectedDestinations,
  onToggleDestination,
  blockLocs,
  selectedBlockLocs,
  onToggleBlockLoc,
  hasActiveFilters,
  onClearAllFilters,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
} & Omit<
  RcOutCardsMobileProps,
  | "data"
  | "canViewPrices"
  | "searchTerm"
  | "onSearchChange"
  | "closedBlocksMode"
  | "onToggleClosedBlocksMode"
  | "closedBlocks"
  | "closedLoading"
  | "closedCanViewPrices"
>) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="bottom"
        className="flex max-h-[90dvh] flex-col gap-0 rounded-t-2xl p-0"
      >
        <SheetHeader className="shrink-0 flex-row items-center justify-between border-b bg-background/90 px-4 py-3 backdrop-blur-sm">
          <div>
            <SheetTitle>Filters</SheetTitle>
            <SheetDescription>Filter usage by state, year, batch, plant and location.</SheetDescription>
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
          {/* STATE (exclusion) */}
          <FilterSection title="State">
            <div className="grid grid-cols-2 gap-1">
              {stateOptions.map((s) => (
                <label key={s} className="flex items-center gap-2 rounded px-1 py-1.5 text-sm hover:bg-muted">
                  <Checkbox
                    checked={!stateExcluded.has(s)}
                    onCheckedChange={() => onToggleState(s)}
                    className="size-4"
                  />
                  <span className="inline-flex items-center gap-1.5">
                    <span className={cn("inline-block size-1.5 shrink-0 rounded-full", getStateDotClass(s))} />
                    <span className="text-xs uppercase">{s}</span>
                  </span>
                </label>
              ))}
            </div>
          </FilterSection>

          {/* YEAR (inclusion) */}
          <FilterSection title="Year">
            <div className="flex flex-wrap gap-1.5">
              {yearOptions.map((y) => {
                const on = selectedYears.has(y);
                return (
                  <button
                    key={y}
                    onClick={() => onToggleYear(y)}
                    className={cn(
                      "rounded-md border px-3 py-1.5 font-mono text-xs transition-colors",
                      on ? "border-primary bg-primary text-primary-foreground" : "hover:bg-muted",
                    )}
                  >
                    {y}
                  </button>
                );
              })}
            </div>
          </FilterSection>

          {/* BATCH (inclusion) */}
          <CommandFilterSection
            title="Batch"
            placeholder="Search batches…"
            options={batchOptions}
            selected={selectedBatches}
            onToggle={onToggleBatch}
          />

          {/* PLANT / ETC (inclusion) */}
          <CommandFilterSection
            title="Plant / Etc"
            placeholder="Search plants…"
            options={destinations}
            selected={selectedDestinations}
            onToggle={onToggleDestination}
          />

          {/* BLOCK LOC (inclusion) */}
          <CommandFilterSection
            title="Block Loc"
            placeholder="Search locations…"
            options={blockLocs}
            selected={selectedBlockLocs}
            onToggle={onToggleBlockLoc}
          />
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

function FilterSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <p className="mb-2 text-xs font-semibold text-muted-foreground">{title}</p>
      {children}
    </section>
  );
}

function CommandFilterSection({
  title,
  placeholder,
  options,
  selected,
  onToggle,
}: {
  title: string;
  placeholder: string;
  options: string[];
  selected: Set<string>;
  onToggle: (value: string) => void;
}) {
  return (
    <FilterSection title={title}>
      <div className="rounded-md border">
        <Command>
          <CommandInput placeholder={placeholder} className="text-sm" />
          <CommandList className="max-h-40">
            <CommandEmpty>None found.</CommandEmpty>
            <CommandGroup>
              {options.map((o) => (
                <CommandItem key={o} value={o} onSelect={() => onToggle(o)} className="text-xs font-mono">
                  <Checkbox checked={selected.has(o)} className="mr-2 size-4" />
                  {o}
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </div>
    </FilterSection>
  );
}

// ─── Full-table escape hatch (feeding, read-only) ────────────────────────────

function FeedingFullTable({ data, canViewPrices }: { data: RcOutRow[]; canViewPrices: boolean }) {
  return (
    <div className="overflow-auto">
      <table className="w-full min-w-[720px] caption-bottom border-collapse text-xs">
        <thead className="sticky top-0 z-10 bg-muted">
          <tr className="border-b">
            {[
              "Date",
              "State",
              "Batch",
              "Block",
              "WT",
              "Plant/Etc",
              "Remarks",
              ...(canViewPrices ? ["Avg ₱/KG", "Avg Val"] : []),
            ].map((h) => (
              <th key={h} className="whitespace-nowrap border-r px-2 py-1 text-left font-bold text-foreground last:border-r-0">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {data.map((d) => (
            <tr key={d.id} className="h-8 border-b last:border-0">
              <td className="whitespace-nowrap px-2 py-1 font-mono">{d.transaction_date}</td>
              <td className="whitespace-nowrap px-2 py-1">{d.batches?.status || "STORED"}</td>
              <td className="whitespace-nowrap px-2 py-1 font-mono">{d.production_batch || "—"}</td>
              <td className="whitespace-nowrap px-2 py-1 font-mono">{d.block_loc || d.batches?.location_ref || "—"}</td>
              <td className="whitespace-nowrap px-2 py-1 text-right font-mono">{fmt0(d.weight_kg)}</td>
              <td className="whitespace-nowrap px-2 py-1">{d.destination || "—"}</td>
              <td className="max-w-[160px] truncate px-2 py-1" title={d.remarks || ""}>{d.remarks || "—"}</td>
              {canViewPrices ? (
                <>
                  <td className="whitespace-nowrap px-2 py-1 text-right font-mono">{d.avg_price != null ? fmtMoney(d.avg_price) : "—"}</td>
                  <td className="whitespace-nowrap px-2 py-1 text-right font-mono">{d.avg_wtd_value != null ? fmtMoney(d.avg_wtd_value) : "—"}</td>
                </>
              ) : null}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
