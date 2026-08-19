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
                // `group/th` is what makes the resize handle DISCOVERABLE: it was a 4px
                // invisible strip you had to already know about, which is why "width
                // adjustment doesn't exist on every table" was the operator's reading of
                // a feature that was in fact present. It now shows on header hover.
                'group/th relative select-none border-b border-b-border border-r border-r-border/40 bg-muted p-0 text-left align-middle font-medium',
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
                        'min-w-0 flex-1 text-left text-[11px] uppercase tracking-wide text-muted-foreground',
                        // WRAP or TRUNCATE — never both, and truncate is the default, so a
                        // column that says nothing renders exactly as it did before.
                        // `line-clamp-2` bounds the growth: a header may take two lines,
                        // not five, because the whole header row grows to the tallest cell.
                        spec.headerWrap
                            ? 'whitespace-normal break-words leading-tight line-clamp-2'
                            : 'truncate',
                        onSelectColumn && 'cursor-pointer hover:text-foreground',
                    )}
                >
                    {/* The NODE if the column has one, else the name. `label` stays a
                        string and stays required — `title`, the resize handle's
                        `aria-label` and any consumer-built column menu all read it as
                        text, and none of them can render a node. */}
                    {spec.labelNode ?? spec.label}
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
                        // 1.5 rather than 1: the old 4px strip was a hit zone you had to
                        // find by accident. `touch-none` so a pointer drag is not eaten by
                        // the scroller on a trackpad or a tablet.
                        'absolute inset-y-0 right-0 w-1.5 cursor-col-resize touch-none',
                        // 150ms — a micro-interaction, and the only thing in the header
                        // that transitions at all. Compositor-safe: colour only.
                        'transition-colors duration-150',
                        // VISIBLE on header hover, brighter under the pointer. The handle
                        // announcing itself is the whole difference between "this table
                        // can be resized" and "this table cannot".
                        //
                        // Two AXES, deliberately, so nothing depends on how Tailwind
                        // happens to order two variants of the same property: REVEAL is
                        // `opacity` (bare `opacity-0`, beaten by the `group-hover`
                        // variant), INTENSITY is `background-color` (bare `bg-border`,
                        // beaten by the `hover` variant). A bare utility always loses to
                        // a variant of itself, so both readings are ordering-proof.
                        'opacity-0 group-hover/th:opacity-100',
                        'bg-border hover:bg-primary/60',
                        // A drag that wanders off the header keeps its handle lit.
                        dragging && 'bg-primary opacity-100',
                    )}
                />
            ) : null}
        </th>
    );
}
