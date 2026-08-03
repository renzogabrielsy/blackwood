"use client";

// ─────────────────────────────────────────────────────────────────────────────
// CenaproLedgerCardsMobile — Cenapro Production LEDGER phone read layer.
//
// Rendered `sm:hidden` by ProductionLedgerGrid in `?view=ledger` mode only; the
// desktop editable `<table>` is `hidden sm:block` and untouched. Built on the
// platform MobileCardList primitive (Archetype C). Fed the SAME sorted/filtered
// `GridRow[]` the desktop grid holds (single source of truth) — no refetch, no
// second data path. Read-ONLY: the whole editable layer (inline edit, Bulk Add,
// paste, context menu) stays desktop-only — click-to-select cells degrade on touch.
//
// Card headline (≤6): recv · batch · shift+grade · source · weight · CCC/FLEC
//   — plus a small Plant chip. Status meaning is preserved via the SAME badge
//   helpers the desktop ledger uses (cccFlecBadgeClass + plantBadgeClass over the
//   shared BADGE_BASE), NOT a bare row tint.
// Detail sheet: every remaining field — prod date, warehouse, side, flec count, etc.
// No ₱ anywhere in Cenapro → zero price gating.
// ─────────────────────────────────────────────────────────────────────────────

import * as React from "react";
import { SlidersHorizontal, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";
import { MobileCardList } from "@/components/shared/mobile/mobile-card-list";
import { ColumnFilterMenu } from "./column-filter-menu";
import {
  FILTER_COLUMNS,
  FILTER_SPECS,
  mergeDiscoveredGroups,
  mergeDiscoveredOptions,
  type FilterColumn,
  type LedgerFilters,
} from "./ledger-url";
// Reuse the desktop ledger's row shape + badge helpers (single source of truth —
// no duplication). This mirrors RC IN, where the mobile card file imports helpers
// from its sibling desktop table (`delivery-master-table`).
import {
  type GridRow,
  cccFlecBadgeClass,
  plantBadgeClass,
  BADGE_BASE,
  formatKg,
} from "./production-ledger-grid";

// ─── Props ───────────────────────────────────────────────────────────────────
// The filter surface is the SAME multi-select model the desktop headers use — the
// URL filter axis (`?shift=&grade=&plant=&whse=&src=&ccc=`) parsed by the parent's
// `useLedgerFilters()` and handed down. One contract, three surfaces.
export interface CenaproLedgerCardsMobileProps {
  /** Already sorted + filter-hidden-excluded + deleted/empty-new-excluded rows. */
  rows: GridRow[];
  savedRowCount: number;
  /** Current per-column selections (empty array = no filter on that column). */
  filters: LedgerFilters;
  /** Values present in the loaded rows — dims options with nothing here. */
  presence: Record<FilterColumn, Set<string>>;
  /** Number of COLUMNS carrying a filter. */
  activeFilterCount: number;
  setFilterColumn: (column: FilterColumn, values: string[]) => void;
  clearFilters: () => void;
}

// ─── Component ───────────────────────────────────────────────────────────────
export function CenaproLedgerCardsMobile(props: CenaproLedgerCardsMobileProps) {
  const { rows, savedRowCount, activeFilterCount } = props;
  const [filtersOpen, setFiltersOpen] = React.useState(false);
  const anyFilterActive = activeFilterCount > 0;

  const toolbar = (
    <div className="flex items-center gap-2 border-b bg-background px-3 py-2">
      <span className="flex-1 truncate font-mono text-[11px] text-muted-foreground">
        {rows.length.toLocaleString("en-US")}
        {anyFilterActive ? ` of ${savedRowCount.toLocaleString("en-US")}` : ""} row
        {rows.length !== 1 ? "s" : ""}
      </span>
      <Button
        variant={anyFilterActive ? "default" : "outline"}
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
      <MobileCardList<GridRow>
        items={rows}
        getKey={(r) => r.id || `${r.recv_date}-${r.batch}-${r.weight_kg}`}
        estimateSize={72}
        toolbar={toolbar}
        renderCard={(r) => <LedgerCard row={r} />}
        renderDetail={(r) => <LedgerDetail row={r} />}
        getDetailTitle={(r) => r.batch || "Production event"}
        getDetailDescription={(r) =>
          `${r.recv_date || "—"} · ${r.shift_code || "—"}/${r.grade_code || "—"}`
        }
        emptyState={
          <div className="flex h-full flex-col items-center justify-center gap-1 py-16 text-center animate-fade-up">
            <p className="text-sm text-muted-foreground">No production events.</p>
            {anyFilterActive ? (
              <p className="text-xs text-muted-foreground/70">Try clearing filters.</p>
            ) : (
              <p className="text-xs text-muted-foreground/70">
                Use the desktop grid to add rows.
              </p>
            )}
          </div>
        }
        fullTableSlot={<LedgerFullTable rows={rows} />}
        fullTableTitle="Production ledger · full table"
      />

      <LedgerFilterSheet open={filtersOpen} onOpenChange={setFiltersOpen} {...props} />
    </>
  );
}

// ─── Card headline (≤6 fields — status via badges, NOT a bare tint) ──────────
function LedgerCard({ row }: { row: GridRow }) {
  return (
    <div className="flex flex-col gap-1 px-3 py-2.5">
      <div className="flex items-baseline justify-between gap-2">
        <span className="truncate font-mono text-sm font-bold">{row.batch || "—"}</span>
        <span className="shrink-0 font-mono text-sm font-bold tabular-nums">
          {formatKg(row.weight_kg) || "—"}
          <span className="ml-0.5 text-[11px] font-normal text-muted-foreground">kg</span>
        </span>
      </div>
      <div className="flex items-center gap-1.5 truncate font-mono text-[11px] text-muted-foreground">
        <span className="tabular-nums">{row.recv_date || "—"}</span>
        <span aria-hidden>·</span>
        <span>
          {row.shift_code || "—"}/{row.grade_code || "—"}
        </span>
        <span aria-hidden>·</span>
        <span className="truncate">{row.source_location_code || "—"}</span>
      </div>
      <div className="flex items-center gap-1.5">
        {row.ccc_flec ? (
          <span className={cn(BADGE_BASE, cccFlecBadgeClass(row.ccc_flec))}>{row.ccc_flec}</span>
        ) : (
          <span className="text-[11px] text-muted-foreground/40">no disposition</span>
        )}
        {row.plant_code ? (
          <span className={cn(BADGE_BASE, plantBadgeClass(row.plant_code))}>{row.plant_code}</span>
        ) : null}
      </div>
    </div>
  );
}

// ─── Detail sheet body (every field) ─────────────────────────────────────────
function LedgerDetail({ row }: { row: GridRow }) {
  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-2 gap-x-4 gap-y-2">
        <Field label="Recv Date" value={row.recv_date || "—"} mono />
        <Field label="Prod Date" value={row.prod_date || "—"} mono />
        <Field
          label="Batch"
          mono
          value={
            <span className="inline-flex items-center gap-1">
              {row.batch || "—"}
              {row.batch_year ? (
                <span className="font-mono text-[10px] text-muted-foreground/60">
                  {row.batch_year}
                </span>
              ) : null}
            </span>
          }
        />
        <Field label="Shift" value={row.shift_code || "—"} mono />
        <Field label="Grade" value={row.grade_code || "—"} mono />
        <Field
          label="Plant"
          value={
            row.plant_code ? (
              <span className={cn(BADGE_BASE, plantBadgeClass(row.plant_code))}>
                {row.plant_code}
              </span>
            ) : (
              "—"
            )
          }
        />
        <Field label="Warehouse" value={row.warehouse_code || "Unplaced"} mono />
        <Field label="Side" value={row.whse_side || "—"} mono />
        <Field label="Source" value={row.source_location_code || "—"} mono />
        <Field
          label="CCC / FLEC"
          value={
            row.ccc_flec ? (
              <span className={cn(BADGE_BASE, cccFlecBadgeClass(row.ccc_flec))}>
                {row.ccc_flec}
              </span>
            ) : (
              "—"
            )
          }
        />
        <Field label="Weight (kg)" value={formatKg(row.weight_kg) || "—"} mono align="left" />
        <Field label="Flec Count" value={row.flec_count || "—"} mono align="left" />
      </div>
    </div>
  );
}

// ─── Field primitive ─────────────────────────────────────────────────────────
function Field({
  label,
  value,
  mono,
  align = "left",
}: {
  label: string;
  value: React.ReactNode;
  mono?: boolean;
  align?: "left" | "right";
}) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
        {label}
      </span>
      <span
        className={cn(
          "truncate text-sm",
          mono && "font-mono tabular-nums",
          align === "right" && "text-right",
        )}
      >
        {value}
      </span>
    </div>
  );
}

// ─── Mobile Filter Sheet (the SAME multi-select menus as the desktop headers) ─
function LedgerFilterSheet({
  open,
  onOpenChange,
  filters,
  presence,
  activeFilterCount,
  setFilterColumn,
  clearFilters,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
} & Omit<CenaproLedgerCardsMobileProps, "rows" | "savedRowCount">) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="bottom"
        className="flex max-h-[90dvh] flex-col gap-0 rounded-t-2xl p-0"
      >
        <SheetHeader className="shrink-0 flex-row items-center justify-between border-b bg-background/90 px-4 py-3 backdrop-blur-sm">
          <div>
            <SheetTitle>Filters</SheetTitle>
            <SheetDescription>
              Pick the values to show per column. Nothing picked = show everything.
            </SheetDescription>
          </div>
          {activeFilterCount > 0 ? (
            <Button
              variant="ghost"
              size="sm"
              className="h-8 gap-1 px-2 text-xs text-muted-foreground"
              onClick={clearFilters}
            >
              <X className="size-3" />
              Clear all
            </Button>
          ) : null}
        </SheetHeader>

        <div className="min-h-0 flex-1 space-y-2 overflow-y-auto px-4 py-4">
          {FILTER_COLUMNS.map((column) => (
            <FilterRow
              key={column}
              column={column}
              selected={filters[column]}
              presence={presence[column]}
              onChange={(values) => setFilterColumn(column, values)}
            />
          ))}
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

// One column row in the sheet. The trigger + menu are the SHARED ColumnFilterMenu,
// so mobile and desktop can never drift apart in semantics — only in chrome (here
// the label sits on the left and the menu is a touch-sized summary button).
function FilterRow({
  column,
  selected,
  presence,
  onChange,
}: {
  column: FilterColumn;
  selected: readonly string[];
  presence: ReadonlySet<string>;
  onChange: (values: string[]) => void;
}) {
  const spec = FILTER_SPECS[column];
  const options = React.useMemo(() => mergeDiscoveredOptions(column, presence), [column, presence]);
  const groups = React.useMemo(() => mergeDiscoveredGroups(column, options), [column, options]);
  const summary =
    selected.length === 0
      ? "All"
      : selected.length <= 2
        ? selected.join(", ")
        : `${selected.length} selected`;
  return (
    <div className="flex items-center justify-between gap-3 rounded-md border px-3 py-2">
      <span className="text-xs font-semibold text-muted-foreground">{spec.label}</span>
      <span
        className={cn(
          "flex h-8 min-w-[130px] items-center justify-between gap-2 rounded-md border px-2 font-mono text-[11px]",
          selected.length > 0 ? "border-primary/40 bg-primary/10 text-primary" : "text-muted-foreground",
        )}
      >
        <span className="truncate">{summary}</span>
        <ColumnFilterMenu
          label={spec.label}
          showLabel={false}
          selected={selected}
          options={options}
          groups={groups}
          present={presence}
          searchable={spec.searchable}
          onChange={onChange}
          align="end"
        />
      </span>
    </div>
  );
}

// ─── Full-table escape hatch (read-only, horizontally scrollable) ────────────
// The desktop ledger table is EDITABLE (click-to-select cells) — it must stay
// desktop-only, so the escape hatch mounts a read-only mirror of the same columns
// (not the interactive grid). Excel column order.
function LedgerFullTable({ rows }: { rows: GridRow[] }) {
  return (
    <div className="overflow-auto">
      <table className="w-full min-w-[900px] caption-bottom border-collapse text-xs">
        <thead className="sticky top-0 z-10 bg-muted">
          <tr className="border-b">
            {[
              "Recv",
              "Prod",
              "Batch",
              "Shift",
              "Grade",
              "Plant",
              "Whse",
              "Source",
              "Weight",
              "CCC/FLEC",
              "Flec",
              "Side",
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
          {rows.map((r) => (
            <tr key={r.id || `${r.recv_date}-${r.batch}-${r.weight_kg}`} className="h-8 border-b last:border-0">
              <td className="whitespace-nowrap px-2 py-1 font-mono">{r.recv_date || "—"}</td>
              <td className="whitespace-nowrap px-2 py-1 font-mono">{r.prod_date || "—"}</td>
              <td className="whitespace-nowrap px-2 py-1 font-mono">{r.batch || "—"}</td>
              <td className="whitespace-nowrap px-2 py-1 font-mono">{r.shift_code || "—"}</td>
              <td className="whitespace-nowrap px-2 py-1 font-mono">{r.grade_code || "—"}</td>
              <td className="whitespace-nowrap px-2 py-1 font-mono">{r.plant_code || "—"}</td>
              <td className="whitespace-nowrap px-2 py-1 font-mono">{r.warehouse_code || "—"}</td>
              <td className="whitespace-nowrap px-2 py-1 font-mono">{r.source_location_code || "—"}</td>
              <td className="whitespace-nowrap px-2 py-1 text-right font-mono">{formatKg(r.weight_kg) || "—"}</td>
              <td className="whitespace-nowrap px-2 py-1 font-mono">{r.ccc_flec || "—"}</td>
              <td className="whitespace-nowrap px-2 py-1 text-right font-mono">{r.flec_count || "—"}</td>
              <td className="whitespace-nowrap px-2 py-1 font-mono">{r.whse_side || "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
