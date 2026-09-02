'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Search, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import {
    Command,
    CommandEmpty,
    CommandGroup,
    CommandInput,
    CommandItem,
    CommandList,
} from '@/components/ui/command';
import type { BlockingSupplierMap } from './types';

/**
 * The active supplier, already reduced to the two numbers the operator cares about.
 * Computed by the grid from `BlockingSupplierMap` (a count of map entries — no kg
 * aggregation happens in TypeScript).
 */
export interface ActiveSupplierSummary {
    key: string;
    display: string;
    /** allCount + someCount — every block this supplier appears in. */
    blockCount: number;
    /** Blocks that are ENTIRELY this supplier (`supplierCount === 1`). */
    allCount: number;
    /** Blocks this supplier SHARES with others (`supplierCount > 1`). */
    someCount: number;
}

interface BlockingSupplierSearchProps {
    /** Autosuggest source — every supplier present on the grid, ranked by reach. */
    suppliers: BlockingSupplierMap['suppliers'];
    /** null = no supplier filter; otherwise the resolved active supplier + counts. */
    active: ActiveSupplierSummary | null;
    /** Pick a supplier (key) or clear the filter (null). */
    onSelect: (key: string | null) => void;
    className?: string;
}

/** kg → "12.3 t" for the suggestion subline. */
function formatTonnes(kg: number): string {
    return `${(kg / 1000).toLocaleString(undefined, { maximumFractionDigits: 1 })} t`;
}

/**
 * Case-insensitive SUBSTRING match on the item's value (which carries both the
 * canonical key and the display spelling). A prefix hit outranks a mid-string one;
 * everything else scores 0 and is filtered out. Deliberately NOT cmdk's default
 * fuzzy scorer — an operator typing "ORN" wants ORNALES, not a fuzzy near-miss.
 */
function substringFilter(value: string, search: string): number {
    const q = search.trim().toLowerCase();
    if (!q) return 1;
    const idx = value.toLowerCase().indexOf(q);
    if (idx === -1) return 0;
    return idx === 0 ? 1 : 0.5;
}

/**
 * Supplier search for the Blocking grid — a cmdk combobox that highlights every
 * block a supplier filled (green = ALL of it, orange = SOME of it) and dims the
 * rest, the same spotlight vocabulary as the status chips beside it.
 *
 * Keyboard-first: type to filter, ↑/↓ to move, Enter picks the highlighted
 * suggestion, Escape steps back (clear query → close list → back to the chip).
 * The list is an ABSOLUTELY POSITIONED panel rather than a Popover so the input
 * itself stays the focus target and no focus trap fights the header.
 */
export function BlockingSupplierSearch({
    suppliers,
    active,
    onSelect,
    className,
}: BlockingSupplierSearchProps) {
    const [query, setQuery] = useState('');
    const [open, setOpen] = useState(false);
    /** With a supplier active the bar shows a chip; this flips it back to the input. */
    const [editing, setEditing] = useState(false);
    const rootRef = useRef<HTMLDivElement | null>(null);
    const inputRef = useRef<HTMLInputElement | null>(null);

    const showInput = !active || editing;

    // Focus the input the moment the chip flips back into search mode.
    useEffect(() => {
        if (editing) inputRef.current?.focus();
    }, [editing]);

    // Close the suggestion panel on an outside click (and drop back to the chip).
    useEffect(() => {
        if (!open && !editing) return;
        function onPointerDown(e: MouseEvent) {
            if (rootRef.current?.contains(e.target as Node)) return;
            setOpen(false);
            setQuery('');
            setEditing(false);
        }
        document.addEventListener('mousedown', onPointerDown);
        return () => document.removeEventListener('mousedown', onPointerDown);
    }, [open, editing]);

    const pick = useCallback(
        (key: string) => {
            onSelect(key);
            setQuery('');
            setOpen(false);
            setEditing(false);
            inputRef.current?.blur();
        },
        [onSelect],
    );

    const clear = useCallback(() => {
        onSelect(null);
        setQuery('');
        setOpen(false);
        setEditing(false);
    }, [onSelect]);

    const handleKeyDown = useCallback(
        (e: React.KeyboardEvent<HTMLDivElement>) => {
            if (e.key !== 'Escape') return;
            // Stop the native event too — the detail panel listens for Escape on the
            // document, and stepping back through the search must not also close it.
            e.preventDefault();
            e.stopPropagation();
            if (query) {
                setQuery('');
                return;
            }
            if (open) {
                setOpen(false);
                return;
            }
            if (active) {
                // Was re-searching with a filter still applied — go back to the chip.
                setEditing(false);
                return;
            }
            onSelect(null);
        },
        [active, onSelect, open, query],
    );

    return (
        <div ref={rootRef} className={cn('relative', className)}>
            {showInput ? (
                <Command
                    filter={substringFilter}
                    loop
                    onKeyDown={handleKeyDown}
                    // `overflow-visible` so the absolutely-positioned suggestion panel is
                    // not clipped by shadcn's default `overflow-hidden` on the root.
                    className={cn(
                        'overflow-visible rounded-md border border-border bg-background/60',
                        '[&_[data-slot=command-input-wrapper]]:h-7 [&_[data-slot=command-input-wrapper]]:border-b-0',
                        '[&_[data-slot=command-input-wrapper]]:gap-1.5 [&_[data-slot=command-input-wrapper]]:px-2',
                        '[&_[data-slot=command-input-wrapper]_svg]:size-3.5',
                    )}
                >
                    <CommandInput
                        ref={inputRef}
                        value={query}
                        onValueChange={(v) => {
                            setQuery(v);
                            setOpen(true);
                        }}
                        onFocus={() => setOpen(true)}
                        placeholder="Search supplier…"
                        className="h-7 py-0 text-[11px]"
                    />
                    {open && (
                        <div
                            className="absolute left-0 top-[calc(100%+4px)] z-50 w-full min-w-[220px] overflow-hidden
                                       rounded-md border border-border bg-popover/95 shadow-lg backdrop-blur-lg"
                        >
                            <CommandList className="max-h-[260px]">
                                <CommandEmpty className="py-4 text-center text-[11px] text-muted-foreground">
                                    No supplier found.
                                </CommandEmpty>
                                <CommandGroup>
                                    {suppliers.map((s) => (
                                        <CommandItem
                                            key={s.key}
                                            // Both spellings live in the value so the substring
                                            // filter matches either one.
                                            value={`${s.key} ${s.display}`}
                                            onSelect={() => pick(s.key)}
                                            className="gap-2 px-2 py-1 text-[11px]"
                                        >
                                            <span className="truncate font-semibold">{s.display}</span>
                                            <span className="ml-auto shrink-0 font-mono text-[10px] text-muted-foreground">
                                                {s.blockCount} block{s.blockCount === 1 ? '' : 's'} ·{' '}
                                                {formatTonnes(s.totalKg)}
                                            </span>
                                        </CommandItem>
                                    ))}
                                </CommandGroup>
                            </CommandList>
                        </div>
                    )}
                </Command>
            ) : (
                <div
                    className="flex h-7 items-center gap-1.5 rounded-md border border-emerald-500/40
                               bg-emerald-500/10 px-2"
                >
                    <Search className="h-3 w-3 shrink-0 text-emerald-600 dark:text-emerald-400" />
                    <button
                        type="button"
                        onClick={() => setEditing(true)}
                        className="min-w-0 truncate text-[11px] font-semibold text-foreground hover:underline cursor-pointer"
                        title="Search a different supplier"
                    >
                        {active.display}
                    </button>
                    <span className="shrink-0 font-mono text-[10px] text-muted-foreground">
                        · {active.blockCount} blocks (all {active.allCount} · some {active.someCount})
                    </span>
                    <button
                        type="button"
                        onClick={clear}
                        aria-label="Clear supplier filter"
                        title="Clear supplier filter"
                        className="ml-0.5 shrink-0 rounded-sm p-0.5 text-muted-foreground transition-colors
                                   duration-150 hover:bg-muted hover:text-foreground cursor-pointer"
                    >
                        <X className="h-3 w-3" />
                    </button>
                </div>
            )}
        </div>
    );
}
