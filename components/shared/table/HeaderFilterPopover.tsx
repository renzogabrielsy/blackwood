'use client';

import * as React from 'react';

import { cn } from '@/lib/utils';
import { isColumnFilterActive } from '@/lib/table';
import type { ColumnFilter } from '@/lib/table';

// ─────────────────────────────────────────────────────────────────────────────────
// HeaderFilterPopover — the built-in per-column filter. PLATFORM LAYER.
//
// **Not Radix, and not shadcn's `Popover`** — the same decision `GridContextMenu` records
// in capitals: a Radix layer inside a grid takes focus on open and RESTORES it to the
// trigger on close, and the trigger here lives inside a `<th>` that a column resize or a
// re-sort can re-render out from under it. A plain `position: fixed` div with its own
// outside-click and Escape handling is 40 lines and has no opinion about the caret.
//
// Three rules it obeys, and each is a way the obvious version breaks inside a table:
//
//   • **FIXED, not absolute.** The header lives inside the horizontally scrolling
//     scrollport, so a popover positioned against the `<th>` is CLIPPED by it — the panel
//     would be cut off on any column past the fold. It is anchored to the trigger's
//     viewport rect instead, and flipped when it would run past an edge.
//   • **`data-grid-chrome`.** Every keystroke and every paste inside it is the input's
//     business, never a grid gesture — otherwise typing `d` into a filter box would open
//     a cell editor somewhere behind it.
//   • **The value goes out on every keystroke, and `undefined` means "no filter".** The
//     grid re-filters live, which is what makes the box feel like a search rather than a
//     form; clearing the text has to hand back `undefined` rather than `{ text: '' }`, or
//     the view stays transformed with nothing on screen to say why.
// ─────────────────────────────────────────────────────────────────────────────────

/** Panel geometry, so the flip maths has one set of numbers. */
const PANEL_W = 224;
const PANEL_H_TEXT = 132;
const PANEL_H_NUMERIC = 196;

export interface HeaderFilterPopoverProps {
    /** The column's plain-text name — the panel says which column it is filtering. */
    label: string;
    /** Does the column declare a `numericValue`? Decides whether bounds are offered. */
    numeric: boolean;
    value: ColumnFilter | undefined;
    /** `undefined` clears the column's filter entirely. */
    onChange(next: ColumnFilter | undefined): void;
    /** The trigger's viewport rect — the panel hangs off its bottom-left. */
    anchor: { left: number; bottom: number };
    onClose(): void;
}

/** `''` ⇒ absent. A bound the operator emptied is not a bound of 0. */
function toBound(raw: string): number | undefined {
    const t = raw.trim();
    if (t === '') return undefined;
    const n = Number(t.replace(/,/g, ''));
    return Number.isFinite(n) ? n : undefined;
}

export function HeaderFilterPopover({
    label, numeric, value, onChange, anchor, onClose,
}: HeaderFilterPopoverProps) {
    const ref = React.useRef<HTMLDivElement | null>(null);
    const [text, setText] = React.useState(value?.text ?? '');
    const [min, setMin] = React.useState(value?.min === undefined ? '' : String(value.min));
    const [max, setMax] = React.useState(value?.max === undefined ? '' : String(value.max));

    // The three inputs are the panel's own state and are published on every change, so
    // the sheet filters live. `publish` is the ONE place a `ColumnFilter` is assembled —
    // an empty one collapses to `undefined`, which is what "no filter" has to be.
    const publish = React.useCallback(
        (next: { text: string; min: string; max: string }) => {
            const filter: ColumnFilter = {};
            if (next.text.trim() !== '') filter.text = next.text;
            const lo = toBound(next.min);
            const hi = toBound(next.max);
            if (lo !== undefined) filter.min = lo;
            if (hi !== undefined) filter.max = hi;
            onChange(isColumnFilterActive(filter) ? filter : undefined);
        },
        [onChange],
    );

    React.useEffect(() => {
        const onDown = (e: PointerEvent) => {
            const target = e.target;
            if (target instanceof Node && ref.current?.contains(target)) return;
            onClose();
        };
        const onKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape') {
                e.stopPropagation();
                onClose();
            }
        };
        // Capture, so a click on another header's trigger closes this one before that one
        // opens — two panels open at once is the failure of every hand-rolled popover.
        document.addEventListener('pointerdown', onDown, true);
        document.addEventListener('keydown', onKey, true);
        return () => {
            document.removeEventListener('pointerdown', onDown, true);
            document.removeEventListener('keydown', onKey, true);
        };
    }, [onClose]);

    const height = numeric ? PANEL_H_NUMERIC : PANEL_H_TEXT;
    const left = Math.max(4, Math.min(anchor.left, window.innerWidth - PANEL_W - 4));
    const flip = anchor.bottom + height > window.innerHeight;
    const top = flip ? Math.max(4, anchor.bottom - height - 24) : anchor.bottom + 2;

    const field =
        'h-6 w-full rounded border border-input bg-background px-1.5 text-xs outline-none focus-visible:ring-1 focus-visible:ring-ring';

    return (
        <div
            ref={ref}
            data-grid-chrome
            data-table-filter-popover={label}
            role="dialog"
            aria-label={`Filter ${label}`}
            // Glass is CORRECT here and wrong on a frozen cell: this floats over empty
            // space rather than sitting on top of scrolling content.
            className="animate-fade-in fixed z-[9999] rounded-md border border-border bg-popover/95 p-2 shadow-lg backdrop-blur-lg"
            style={{ left, top, width: PANEL_W }}
        >
            <div className="mb-1.5 truncate text-[10px] uppercase tracking-wide text-muted-foreground">
                Filter · {label}
            </div>

            <input
                autoFocus
                data-testid="filter-text"
                value={text}
                placeholder="contains…"
                aria-label={`${label} contains`}
                onChange={(e) => {
                    setText(e.target.value);
                    publish({ text: e.target.value, min, max });
                }}
                onKeyDown={(e) => {
                    if (e.key === 'Enter') onClose();
                }}
                className={field}
            />

            {numeric ? (
                <div className="mt-2 grid grid-cols-2 gap-1.5">
                    <label className="flex flex-col gap-0.5 text-[10px] text-muted-foreground">
                        MIN
                        <input
                            data-testid="filter-min"
                            inputMode="decimal"
                            value={min}
                            aria-label={`${label} minimum`}
                            onChange={(e) => {
                                setMin(e.target.value);
                                publish({ text, min: e.target.value, max });
                            }}
                            className={cn(field, 'text-right font-mono tabular-nums')}
                        />
                    </label>
                    <label className="flex flex-col gap-0.5 text-[10px] text-muted-foreground">
                        MAX
                        <input
                            data-testid="filter-max"
                            inputMode="decimal"
                            value={max}
                            aria-label={`${label} maximum`}
                            onChange={(e) => {
                                setMax(e.target.value);
                                publish({ text, min, max: e.target.value });
                            }}
                            className={cn(field, 'text-right font-mono tabular-nums')}
                        />
                    </label>
                </div>
            ) : null}

            <div className="mt-2 flex items-center justify-between">
                <button
                    type="button"
                    data-testid="filter-clear"
                    onClick={() => {
                        setText('');
                        setMin('');
                        setMax('');
                        onChange(undefined);
                    }}
                    className="h-6 rounded border border-input px-2 text-[11px] transition-colors duration-150 hover:bg-muted"
                >
                    Clear
                </button>
                <button
                    type="button"
                    data-testid="filter-done"
                    onClick={onClose}
                    className="h-6 rounded border border-input px-2 text-[11px] transition-colors duration-150 hover:bg-muted"
                >
                    Done
                </button>
            </div>
        </div>
    );
}
