'use client';

import * as React from 'react';
import { Calendar } from 'lucide-react';
import { format as formatDate, parseISO, isValid as isValidDate } from 'date-fns';
import { cn } from '@/lib/utils';

// `formatDateShort` was a local helper in production-ledger-grid.tsx (the canonical
// source for this cell). It is not exported from any shared date util, so it is
// promoted here ALONGSIDE the cell — this file becomes its single source of truth.
// Other grids should re-import it from here rather than redefine it.
export function formatDateShort(iso: string): string {
    if (!iso) return '';
    const parsed = parseISO(iso);
    if (!isValidDate(parsed)) return iso;
    return formatDate(parsed, 'MMM d');
}

// ─── DatePickerCell ──────────────────────────────────────────────────────────────
// Always-visible date input with calendar icon + formatted display. The native
// <input type="date"> overlays (opacity:0) so clicks anywhere open the native picker.
// Selection (drag/anchor) is handled by the wrapping cell. Mirrors the ICTC ledger.
//
// Promoted VERBATIM from production-ledger-grid.tsx (the canonical source).
export interface DatePickerCellProps {
    value: string;
    onChange: (val: string) => void;
    onPaste: (e: React.ClipboardEvent) => void;
    isActive: boolean;
    isRangeSelected: boolean;
    isRangeAnchor: boolean;
    onCellMouseDown: (e: React.MouseEvent) => void;
    onCellMouseUp: () => void;
    onCellMouseEnter: () => void;
    muted?: boolean;
}

export function DatePickerCell({
    value,
    onChange,
    onPaste,
    isActive,
    isRangeSelected,
    isRangeAnchor,
    onCellMouseDown,
    onCellMouseUp,
    onCellMouseEnter,
    muted,
}: DatePickerCellProps) {
    const inputRef = React.useRef<HTMLInputElement>(null);
    return (
        <div
            className={cn(
                'group relative flex h-full w-full cursor-pointer select-none items-center justify-between gap-1 px-1',
                'border border-dashed border-border/40 transition-colors hover:border-blue-500/60 hover:bg-blue-500/5',
                isActive && !isRangeSelected && 'z-10 border-transparent ring-2 ring-primary ring-inset',
                isRangeSelected && 'bg-primary/10 dark:bg-primary/20',
                isRangeAnchor && 'z-10 border-transparent ring-2 ring-primary ring-inset',
            )}
            style={{ minHeight: '100%' }}
            onMouseDown={onCellMouseDown}
            onMouseUp={onCellMouseUp}
            onMouseEnter={onCellMouseEnter}
            onClick={(e) => {
                e.stopPropagation();
                const el = inputRef.current;
                if (!el) return;
                // `preventScroll` on both fallbacks: HTMLElement.focus() scrolls the
                // target into view with block AND inline "center" through every
                // scrolling ancestor, even when it is already visible — which jolts
                // the page out from under the click. Focus still moves.
                if (typeof el.showPicker === 'function') {
                    try {
                        el.showPicker();
                    } catch {
                        el.focus({ preventScroll: true });
                    }
                } else {
                    el.focus({ preventScroll: true });
                }
            }}
        >
            <span
                className={cn(
                    'truncate font-mono text-[11px] font-bold tabular-nums',
                    muted ? 'text-muted-foreground/60' : 'text-foreground',
                )}
            >
                {formatDateShort(value) || (muted ? '—' : '')}
            </span>
            <Calendar className="h-3 w-3 flex-none text-muted-foreground/70 transition-colors group-hover:text-blue-500" />
            <input
                ref={inputRef}
                type="date"
                value={value}
                onChange={(e) => onChange(e.target.value)}
                onPaste={onPaste}
                onMouseDown={(e) => e.stopPropagation()}
                onClick={(e) => e.stopPropagation()}
                className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
                tabIndex={-1}
                aria-label="Select date"
            />
        </div>
    );
}
