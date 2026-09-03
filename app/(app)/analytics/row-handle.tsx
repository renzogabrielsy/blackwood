"use client";

// ─────────────────────────────────────────────────────────────────────────────
// THE DRAG HANDLE — one row's grip, and its keyboard equivalent (R5)
//
// Renzo asked for drag-to-reorder on the row label. Three decisions:
//
// 1. **The HANDLE is draggable, not the row.** A row on this page already
//    carries a click (open the expand) and, in the frozen name column, an Info
//    popover. Making the whole row a drag source would make every attempt to
//    open a chart feel like the start of a drag. The grip is a separate 14 px
//    target that does one thing.
//
// 2. **HTML5 drag and drop, not a pointer-move implementation.** The rows live
//    inside a `table-fixed` inside an `overflow-x-auto` with a sticky frozen
//    column; a hand-rolled drag would have to reimplement auto-scroll and hit
//    testing against exactly that geometry, and the platform already does it.
//    The payload is the row key, and the drop target is the row's own `<tr>`.
//
// 3. **The keyboard path is not an afterthought and not a second mechanism.**
//    The handle is a real `<button>`: focus it and Arrow Up / Arrow Down move
//    the row through the SAME `move()` the pointer path ends in
//    (`lib/analytics/row-order.ts`). So a reader who cannot drag reorders the
//    table with the keys, and there is one definition of what a move is.
//
// The group is the whole vocabulary: a handle only ever emits its own key and a
// drop only ever resolves against keys in the same group's order, so a
// cross-section drag is not refused — it is unrepresentable.
// ─────────────────────────────────────────────────────────────────────────────

import * as React from "react";
import { GripVertical } from "lucide-react";
import { cn } from "@/lib/utils";

export interface RowHandleProps {
  /** This row's key, in its group's order. */
  rowKey: string;
  /** What the row is called — the handle's accessible name says it out loud. */
  label: string;
  /** 1-based position and the group size, for the hover and the aria label. */
  position: number;
  total: number;
  onMove(key: string, delta: number): void;
  onDragStart(key: string): void;
  onDragEnd(): void;
  className?: string;
}

export function RowHandle({
  rowKey,
  label,
  position,
  total,
  onMove,
  onDragStart,
  onDragEnd,
  className,
}: RowHandleProps) {
  return (
    <button
      type="button"
      draggable
      aria-label={`Reorder ${label} — position ${position} of ${total}. Drag, or press the up and down arrow keys.`}
      title={`Drag to move ${label} within this group, or focus this handle and use ↑ / ↓. The order is saved to your account and changes no figure.`}
      onDragStart={(e) => {
        // `text/plain` is the one format every engine carries without a fuss,
        // and the payload is the row key — the drop target resolves it against
        // its own group's order, so a payload from anywhere else matches
        // nothing and does nothing.
        e.dataTransfer.setData("text/plain", rowKey);
        e.dataTransfer.effectAllowed = "move";
        onDragStart(rowKey);
      }}
      onDragEnd={onDragEnd}
      onKeyDown={(e) => {
        if (e.key === "ArrowUp") {
          e.preventDefault();
          e.stopPropagation();
          onMove(rowKey, -1);
        } else if (e.key === "ArrowDown") {
          e.preventDefault();
          e.stopPropagation();
          onMove(rowKey, 1);
        }
      }}
      // Never on paper: an order control is chrome, not a figure.
      data-print-hide
      className={cn(
        "flex size-4 shrink-0 cursor-grab items-center justify-center rounded",
        "text-muted-foreground/40 transition-colors duration-150",
        "hover:bg-muted hover:text-foreground active:cursor-grabbing",
        "focus:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        // Revealed on row hover / handle focus, so ten grips do not compete
        // with ten row labels for the eye on a dense grid. `opacity` only —
        // it stays in layout, so nothing reflows when it appears.
        "opacity-0 group-hover:opacity-100 focus-visible:opacity-100",
        className,
      )}
    >
      <GripVertical className="size-3" aria-hidden />
    </button>
  );
}

/**
 * The props a `<tr>` needs to accept a dropped row. Kept as a function rather
 * than a component because the target IS the existing row element — wrapping
 * it in anything would break the table's own box tree.
 */
export function rowDropProps(
  rowKey: string,
  dragging: string | null,
  onDrop: (key: string, target: string) => void,
): React.HTMLAttributes<HTMLTableRowElement> {
  if (!dragging || dragging === rowKey) return {};
  return {
    onDragOver: (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
    },
    onDrop: (e) => {
      e.preventDefault();
      const key = e.dataTransfer.getData("text/plain") || dragging;
      onDrop(key, rowKey);
    },
  };
}
