'use client';

import * as React from 'react';
import { ChevronDown } from 'lucide-react';
import { cn } from '@/lib/utils';
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuTrigger,
    DropdownMenuRadioGroup,
    DropdownMenuRadioItem,
} from '@/components/ui/dropdown-menu';

// ─── SelectCell ──────────────────────────────────────────────────────────────────
// A categorical dropdown cell. The trigger shows the current value (or a muted dash
// for empty), and opens a DropdownMenu of the allowed options. Nullable columns get a
// leading "— None" item that clears to ''. The trigger stops propagation on
// mouse/pointer-down so opening the menu never starts a cell drag (same guard as the
// ICTC NoteCell / ColumnFilterMenu). Selection visuals come from the wrapping cell.
//
// Promoted VERBATIM from production-ledger-grid.tsx (the canonical source). Other
// grids should import from here rather than keep local copies.
export interface SelectCellProps {
    value: string;
    options: readonly string[];
    onChange: (val: string) => void;
    /** Render an option's label (defaults to the raw value). */
    renderLabel?: (opt: string) => string;
    /**
     * Render the CURRENT value in the trigger (display state) as a custom node —
     * e.g. a colored badge. Only affects the closed trigger; the dropdown menu items
     * still use `renderLabel`/raw text, and the edit path is untouched. Returns null to
     * fall back to the plain text label.
     */
    renderTrigger?: (value: string) => React.ReactNode;
    /** When true, prepend a "— None" item that clears the value. */
    nullable?: boolean;
    /** Placeholder shown when value is '' (defaults to a muted dash). */
    placeholder?: string;
    /** Disable + show a hint (e.g. equipment when disposition is bagging). */
    disabled?: boolean;
    disabledHint?: string;
    align?: 'start' | 'end';
}

export function SelectCell({
    value,
    options,
    onChange,
    renderLabel,
    renderTrigger,
    nullable,
    placeholder,
    disabled,
    disabledHint,
    align = 'start',
}: SelectCellProps) {
    const label = value ? (renderLabel ? renderLabel(value) : value) : '';
    const triggerNode = value && renderTrigger ? renderTrigger(value) : null;
    return (
        <DropdownMenu>
            <DropdownMenuTrigger asChild disabled={disabled}>
                <button
                    type="button"
                    aria-label={label || placeholder || 'Select'}
                    title={disabled ? disabledHint : label || placeholder}
                    onMouseDown={(e) => e.stopPropagation()}
                    onPointerDown={(e) => e.stopPropagation()}
                    className={cn(
                        'flex h-full w-full items-center justify-between gap-0.5 px-1 text-left outline-none transition-colors duration-150',
                        'focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-primary',
                        disabled
                            ? 'cursor-not-allowed bg-muted/30'
                            : 'hover:bg-accent/40',
                    )}
                >
                    {triggerNode ? (
                        <span className="flex min-w-0 items-center truncate">{triggerNode}</span>
                    ) : (
                        <span
                            className={cn(
                                'truncate font-mono text-xs font-bold',
                                value ? 'text-foreground' : 'text-muted-foreground/40',
                            )}
                        >
                            {label || (disabled ? '—' : placeholder ?? '—')}
                        </span>
                    )}
                    {!disabled && (
                        <ChevronDown className="h-3 w-3 flex-none text-muted-foreground/40" />
                    )}
                </button>
            </DropdownMenuTrigger>
            {!disabled && (
                <DropdownMenuContent align={align} className="min-w-[120px] bg-popover/95 backdrop-blur-lg">
                    <DropdownMenuRadioGroup value={value} onValueChange={onChange}>
                        {nullable && (
                            <DropdownMenuRadioItem value="" className="py-1 font-mono text-[11px] text-muted-foreground">
                                — None
                            </DropdownMenuRadioItem>
                        )}
                        {options.map((opt) => (
                            <DropdownMenuRadioItem key={opt} value={opt} className="py-1 font-mono text-[11px]">
                                {renderLabel ? renderLabel(opt) : opt}
                            </DropdownMenuRadioItem>
                        ))}
                    </DropdownMenuRadioGroup>
                </DropdownMenuContent>
            )}
        </DropdownMenu>
    );
}
