'use client';

import * as React from 'react';

import { cn } from '@/lib/utils';
import type { ColumnSpec } from '@/lib/table';

// ─────────────────────────────────────────────────────────────────────────────────
// HeaderCell — one `<th>`. PLATFORM LAYER.
//
// Three jobs, and the third is the only one with a trap in it:
//
//   • It NAMES the column (`label`, with `title` for the long form when the label is an
//     abbreviation — a header that says `BD` and nothing else is a question the operator
//     has to ask someone).
//   • It SELECTS the column: clicking the label sweeps the whole column, the gesture
//     every spreadsheet has.
//   • It RESIZES. The handle reports a new width through `onSettingsChange` — on
//     POINTERUP, not per frame. A live report re-resolves the column table on every
//     mouse move, which re-renders every mounted row of the sheet; the drag stays a
//     local number and lands once.
//
// **The header is a frozen surface, so it is fully OPAQUE — never glass.** A sticky
// header sits ON TOP of scrolling rows; any alpha or `backdrop-blur` and the moving cells
// bleed through it. That is the opposite of the rule for a floating bar over empty space,
// and it is why this file uses solid `bg-muted` and no `/opacity` anywhere.
// ─────────────────────────────────────────────────────────────────────────────────

/** The narrowest a column may be dragged to. Below this the label has nowhere to go. */
export const MIN_COLUMN_WIDTH = 48;

export interface HeaderCellProps<Row, Ctx> {
    spec: ColumnSpec<Row, Ctx>;
    /** Display index — what a column-selection click addresses. */
    index: number;
    pin: 'start' | 'end' | null;
    /** The last start-pinned column / the first end-pinned one — carries the seam. */
    edge: boolean;
    /** Sticky offset for a pinned header cell. */
    left?: number;
    right?: number;
    /** Sweep the whole column. Absent ⇒ the label is not clickable. */
    onSelectColumn?(index: number): void;
    /** Report a new width for this column. Called ONCE, when the drag ends. */
    onResize?(key: string, width: number): void;
    /**
     * A filter trigger, a sort caret — anything the consumer hangs off the header.
     *
     * `BlackwoodTable` fills it from its `renderHeaderSlot` prop; absent, no slot element
     * is rendered at all.
     */
    filterSlot?: React.ReactNode;
}

export function HeaderCell<Row, Ctx>({
    spec, index, pin, edge, left, right, onSelectColumn, onResize, filterSlot,
}: HeaderCellProps<Row, Ctx>) {
    const [dragging, setDragging] = React.useState(false);
    const resizable = spec.resizable !== false && onResize !== undefined;

    const startResize = React.useCallback(
        (e: React.PointerEvent<HTMLSpanElement>) => {
            if (!onResize) return;
            // The handle is chrome, not a cell: neither the column-selection click behind
            // it nor the grid's own mousedown may see this gesture.
            e.preventDefault();
            e.stopPropagation();

            const startX = e.clientX;
            const startWidth = spec.width;
            const handle = e.currentTarget;
            handle.setPointerCapture(e.pointerId);
            setDragging(true);

            let width = startWidth;
            const onMove = (ev: PointerEvent) => {
                width = Math.max(MIN_COLUMN_WIDTH, Math.round(startWidth + (ev.clientX - startX)));
            };
            const onUp = () => {
                handle.removeEventListener('pointermove', onMove);
                handle.removeEventListener('pointerup', onUp);
                handle.removeEventListener('pointercancel', onUp);
                setDragging(false);
                if (width !== startWidth) onResize(spec.key, width);
            };
            handle.addEventListener('pointermove', onMove);
            handle.addEventListener('pointerup', onUp);
            handle.addEventListener('pointercancel', onUp);
        },
        [onResize, spec.key, spec.width],
    );

    const style: React.CSSProperties = { width: spec.width };
    if (pin === 'start') style.left = left;
    else if (pin === 'end') style.right = right;

    return (
        <th
            data-col={index}
            data-col-key={spec.key}
            scope="col"
            title={spec.title ?? spec.label}
            style={style}
            className={cn(
                // Solid `bg-muted`, always — a frozen surface that overlaps scrolling
                // content is opaque or it leaks.
                'relative select-none border-b border-b-border border-r border-r-border/40 bg-muted p-0 text-left align-middle font-medium',
                // The z-scale from CLAUDE.md: a header cell that is ALSO pinned sideways
                // is a corner and out-ranks both (30); a plain header cell is the row (20).
                pin ? 'frozen-corner' : 'frozen-row',
                edge && 'frozen-edge',
            )}
        >
            <div className="flex h-full items-center gap-1 px-2 py-1">
                <button
                    type="button"
                    tabIndex={-1}
                    onMouseDown={(e) => {
                        if (!onSelectColumn) return;
                        e.preventDefault();
                        e.stopPropagation();
                        onSelectColumn(index);
                    }}
                    className={cn(
                        'min-w-0 flex-1 truncate text-left text-[11px] uppercase tracking-wide text-muted-foreground',
                        onSelectColumn && 'cursor-pointer hover:text-foreground',
                    )}
                >
                    {spec.label}
                </button>
                {filterSlot ? (
                    // Marked as chrome so a keystroke or a paste aimed at it is that
                    // control's business, not a grid gesture.
                    <span data-grid-chrome className="shrink-0">
                        {filterSlot}
                    </span>
                ) : null}
            </div>

            {resizable ? (
                <span
                    data-grid-chrome
                    data-resize-handle={spec.key}
                    role="separator"
                    aria-orientation="vertical"
                    aria-label={`Resize ${spec.label}`}
                    onPointerDown={startResize}
                    onDoubleClick={(e) => e.stopPropagation()}
                    className={cn(
                        'absolute inset-y-0 right-0 w-1 cursor-col-resize',
                        // 150ms — a micro-interaction, and the only thing in the header
                        // that transitions at all.
                        'transition-colors duration-150 hover:bg-primary/60',
                        dragging && 'bg-primary',
                    )}
                />
            ) : null}
        </th>
    );
}
