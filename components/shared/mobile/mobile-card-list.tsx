"use client";

// ─────────────────────────────────────────────────────────────────────────────
// MobileCardList — the canonical **Archetype C** mobile primitive.
//
// Platform-layer, data-agnostic. Turns any dense desktop `<table>` into a
// phone-friendly, virtualized card list: one tappable card per row, tap opens a
// full-width bottom Sheet with the row's full-field detail, and an optional
// "View full table" escape hatch mounts the untouched wide table in its own
// horizontally-scrolling Sheet.
//
// It knows NOTHING about the domain (no ₱ logic, no charcoal terms, no columns).
// The caller supplies:
//   • the data (`items`) and a stable `getKey`
//   • `renderCard(item)`   → the ≤6-field headline (NEVER prices)
//   • `renderDetail(item)` → the full-field detail body (caller owns gating)
//   • optional `toolbar`   → search / filter chrome pinned above the list
//   • optional `fullTableSlot` → the desktop `<table>` for the escape hatch
//
// Precedent: components/digest/schedule-preview-mobile.tsx (list + bottom sheet).
// Reference sites: RC IN (DeliveryCardsMobile), RC OUT (RcOutCardsMobile).
// See components/shared/mobile/CONTEXT.md.
// ─────────────────────────────────────────────────────────────────────────────

import * as React from "react";
import { Table2, Inbox } from "lucide-react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { cn } from "@/lib/utils";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";

export interface MobileCardListProps<T> {
  /** Rows to render — already filtered/sorted by the caller (single source of truth). */
  items: T[];
  /** Stable, unique key per row (used for React keys + active-detail tracking). */
  getKey: (item: T) => string;
  /** The compact headline card (≤6 identity/metric fields). Never render prices here. */
  renderCard: (item: T) => React.ReactNode;
  /** The full-field detail body shown in the bottom sheet. Caller owns all gating. */
  renderDetail: (item: T) => React.ReactNode;
  /** Optional detail-sheet title (defaults to "Details"). */
  getDetailTitle?: (item: T) => string;
  /** Optional detail-sheet description line (defaults to a generic label). */
  getDetailDescription?: (item: T) => string;
  /** Initial estimated card height in px (virtualizer measures real height after mount). */
  estimateSize?: number;
  /** Chrome pinned above the scrolling list (search, filter trigger, segmented control…). */
  toolbar?: React.ReactNode;
  /** Rendered instead of the list when `items` is empty. */
  emptyState?: React.ReactNode;
  /** The desktop `<table>` (or any wide read-only view) for the "View full table" escape hatch. */
  fullTableSlot?: React.ReactNode;
  /** Title for the full-table sheet. */
  fullTableTitle?: string;
  /** Description for the full-table sheet. */
  fullTableDescription?: string;
  /** Label for the full-table trigger button. */
  fullTableLabel?: string;
  className?: string;
}

export function MobileCardList<T>({
  items,
  getKey,
  renderCard,
  renderDetail,
  getDetailTitle,
  getDetailDescription,
  estimateSize = 68,
  toolbar,
  emptyState,
  fullTableSlot,
  fullTableTitle = "Full table",
  fullTableDescription = "Swipe the table sideways to see all columns.",
  fullTableLabel = "View full table",
  className,
}: MobileCardListProps<T>) {
  const scrollRef = React.useRef<HTMLDivElement>(null);
  const [activeKey, setActiveKey] = React.useState<string | null>(null);
  const [fullTableOpen, setFullTableOpen] = React.useState(false);

  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => estimateSize,
    overscan: 8,
  });

  // Resolve the active row from the live `items` array so a data refresh while the
  // detail sheet is open re-reads fresh fields (and auto-closes if the row vanished).
  const activeItem = React.useMemo(
    () => (activeKey == null ? null : items.find((it) => getKey(it) === activeKey) ?? null),
    [activeKey, items, getKey],
  );

  return (
    <div className={cn("flex h-full min-h-0 flex-col", className)}>
      {toolbar ? <div className="shrink-0">{toolbar}</div> : null}

      <div
        ref={scrollRef}
        className="min-h-0 flex-1 overflow-auto overscroll-contain"
      >
        {items.length === 0 ? (
          emptyState ?? <DefaultEmptyState />
        ) : (
          <ul
            className="relative w-full"
            style={{ height: virtualizer.getTotalSize() }}
          >
            {virtualizer.getVirtualItems().map((vRow) => {
              const item = items[vRow.index];
              const key = getKey(item);
              return (
                <li
                  key={key}
                  data-index={vRow.index}
                  ref={virtualizer.measureElement}
                  className="absolute left-0 top-0 w-full"
                  style={{ transform: `translateY(${vRow.start}px)` }}
                >
                  <button
                    type="button"
                    onClick={() => setActiveKey(key)}
                    className="block w-full border-b text-left transition-colors duration-150 focus:outline-none focus-visible:bg-muted/60 active:bg-muted/60"
                  >
                    {renderCard(item)}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {fullTableSlot ? (
        <div className="shrink-0 border-t bg-background/95 px-3 py-2 pb-[max(0.5rem,env(safe-area-inset-bottom))] backdrop-blur supports-[backdrop-filter]:bg-background/60">
          <button
            type="button"
            onClick={() => setFullTableOpen(true)}
            className="inline-flex h-10 w-full items-center justify-center gap-1.5 rounded-lg border bg-muted/40 px-3 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <Table2 className="h-3.5 w-3.5" />
            {fullTableLabel}
          </button>
        </div>
      ) : null}

      {/* ─── Detail bottom sheet ─── */}
      <Sheet
        open={activeItem !== null}
        onOpenChange={(open) => {
          if (!open) setActiveKey(null);
        }}
      >
        <SheetContent
          side="bottom"
          className="max-h-[90dvh] gap-0 overflow-y-auto rounded-t-2xl p-0 pb-[max(1rem,env(safe-area-inset-bottom))]"
        >
          {activeItem ? (
            <>
              <SheetHeader className="sticky top-0 z-10 border-b bg-background/90 px-4 py-3 backdrop-blur-sm">
                <SheetTitle>
                  {getDetailTitle ? getDetailTitle(activeItem) : "Details"}
                </SheetTitle>
                <SheetDescription
                  className={cn(!getDetailDescription && "sr-only")}
                >
                  {getDetailDescription
                    ? getDetailDescription(activeItem)
                    : "Record details"}
                </SheetDescription>
              </SheetHeader>
              <div className="px-4 py-3">{renderDetail(activeItem)}</div>
            </>
          ) : null}
        </SheetContent>
      </Sheet>

      {/* ─── Full-table escape hatch sheet ─── */}
      {fullTableSlot ? (
        <Sheet open={fullTableOpen} onOpenChange={setFullTableOpen}>
          <SheetContent
            side="bottom"
            className="flex max-h-[90dvh] flex-col gap-0 rounded-t-2xl p-0 pb-[max(1rem,env(safe-area-inset-bottom))]"
          >
            <SheetHeader className="shrink-0 border-b bg-background/90 px-4 py-3 backdrop-blur-sm">
              <SheetTitle>{fullTableTitle}</SheetTitle>
              <SheetDescription>{fullTableDescription}</SheetDescription>
            </SheetHeader>
            <div className="min-h-0 flex-1 overflow-auto p-2">
              {fullTableSlot}
            </div>
          </SheetContent>
        </Sheet>
      ) : null}
    </div>
  );
}

function DefaultEmptyState() {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 py-16 text-center animate-fade-up">
      <Inbox className="h-8 w-8 text-muted-foreground/50" />
      <p className="text-sm text-muted-foreground">No records found.</p>
    </div>
  );
}
