'use client';

import * as React from 'react';
import { Check, ChevronDown, Filter, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import {
    Command,
    CommandEmpty,
    CommandGroup,
    CommandInput,
    CommandItem,
    CommandList,
    CommandSeparator,
} from '@/components/ui/command';
import type { LedgerFilterGroup, LedgerFilterOption } from './ledger-url';

// ─── Cenapro production ledger — per-column MULTI-SELECT filter menu ─────────────
// ONE component, used by every filtered column in BOTH scopes (the Focus editable grid's
// header, the Endless sheet's frozen header, and the mobile filter sheet) so the two
// surfaces can never drift apart.
//
// Semantics (mirrors `ledger-url.ts`):
//   • EMPTY selection = no filter = show all. There is no "show nothing" state, so the
//     menu can never strand the operator on an empty grid.
//   • Row click TOGGLES the value (the least-surprising primary action for a checkbox
//     list); a hover-/focus-revealed "only" button on the right collapses the selection
//     to that ONE value — the Excel/Sheets single-value idiom, kept as an explicit
//     affordance rather than a hidden meaning attached to the label click.
//   • Grouped columns (CCC/FLEC) get a group toggle row ("All crushers") so selecting
//     C1–C4 is one click, not four.
//   • Options with no rows in the loaded window are DIMMED, never hidden or disabled —
//     in the endless scope a value absent from the window may still exist further back
//     in history, and the query-side filter will find it.
//
// Density: the trigger is the same tiny chevron the single-select menu used, plus a count
// chip when active. The header row height is unchanged (h-8).

export interface ColumnFilterMenuProps {
    /** Column header label — rendered before the trigger and as the menu title. */
    label: string;
    /** Render the inline label + count chip before the trigger. Off on mobile, where the
     *  surrounding row already shows the column name and a selection summary. */
    showLabel?: boolean;
    /** Currently selected values (empty = no filter). */
    selected: readonly string[];
    /** Canonical option domain (already merged with any discovered unmapped values). */
    options: readonly LedgerFilterOption[];
    /** Optional grouping; each group gets a one-click select-all/clear row. */
    groups?: readonly LedgerFilterGroup[];
    /** Values PRESENT in the currently loaded rows — everything else renders dimmed. */
    present?: ReadonlySet<string>;
    /** Show the typeahead input (columns with many options). */
    searchable?: boolean;
    onChange: (next: string[]) => void;
    align?: 'start' | 'end';
    disabled?: boolean;
    disabledHint?: string;
}

export function ColumnFilterMenu({
    label,
    showLabel = true,
    selected,
    options,
    groups,
    present,
    searchable = false,
    onChange,
    align = 'start',
    disabled = false,
    disabledHint,
}: ColumnFilterMenuProps) {
    const [open, setOpen] = React.useState(false);
    const selectedSet = React.useMemo(() => new Set(selected), [selected]);
    const count = selected.length;
    const isActive = count > 0;

    // Keep the caller's canonical ORDER when writing back, so the URL is stable regardless
    // of the click sequence (`?ccc=FLEC,C1` never flips to `?ccc=C1,FLEC`).
    const order = React.useMemo(() => options.map((o) => o.value), [options]);
    const emit = React.useCallback(
        (next: Set<string>) => {
            const ordered = order.filter((v) => next.has(v));
            // Any value not in the canonical list (a stale URL value) is preserved at the end.
            for (const v of next) if (!ordered.includes(v)) ordered.push(v);
            onChange(ordered);
        },
        [order, onChange],
    );

    const toggle = React.useCallback(
        (value: string) => {
            const next = new Set(selectedSet);
            if (next.has(value)) next.delete(value);
            else next.add(value);
            emit(next);
        },
        [selectedSet, emit],
    );

    const only = React.useCallback((value: string) => onChange([value]), [onChange]);
    const selectAll = React.useCallback(() => onChange([...order]), [order, onChange]);
    const clear = React.useCallback(() => onChange([]), [onChange]);

    const toggleGroup = React.useCallback(
        (group: LedgerFilterGroup) => {
            const allOn = group.values.every((v) => selectedSet.has(v));
            const next = new Set(selectedSet);
            for (const v of group.values) {
                if (allOn) next.delete(v);
                else next.add(v);
            }
            emit(next);
        },
        [selectedSet, emit],
    );

    const renderOption = (opt: LedgerFilterOption) => {
        const checked = selectedSet.has(opt.value);
        const absent = present ? !present.has(opt.value) : false;
        return (
            <CommandItem
                key={opt.value}
                // cmdk matches on `value` — fold the label + hint in so typeahead finds
                // "morning" for M and "crusher" for C1. Uniqueness is preserved.
                value={`${opt.value} ${opt.label} ${opt.hint ?? ''}`}
                onSelect={() => toggle(opt.value)}
                aria-label={`${opt.label}${checked ? ', selected' : ''}`}
                className="group/opt gap-2 px-2 py-1 text-[11px]"
            >
                <span
                    aria-hidden
                    className={cn(
                        'flex size-3.5 shrink-0 items-center justify-center rounded-[3px] border transition-colors duration-150',
                        checked ? 'border-primary bg-primary text-primary-foreground' : 'border-muted-foreground/40',
                    )}
                >
                    {checked && <Check className="size-2.5" strokeWidth={3.5} />}
                </span>
                <span className={cn('min-w-0 flex-1 truncate font-mono', absent && 'text-muted-foreground/45')}>
                    {opt.label}
                </span>
                {opt.hint === 'unmapped' && (
                    <span className="shrink-0 rounded bg-amber-500/15 px-1 text-[9px] font-semibold uppercase text-amber-700 dark:text-amber-300">
                        new
                    </span>
                )}
                {absent && opt.hint !== 'unmapped' && (
                    <span className="shrink-0 text-[9px] uppercase tracking-wide text-muted-foreground/40">
                        none here
                    </span>
                )}
                <button
                    type="button"
                    tabIndex={-1}
                    // Collapse to this ONE value. Stop the click before cmdk's item handler
                    // sees it, otherwise the row would also toggle.
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={(e) => {
                        e.stopPropagation();
                        only(opt.value);
                    }}
                    className="shrink-0 rounded px-1 text-[9px] font-semibold uppercase tracking-wide text-muted-foreground opacity-0 transition-opacity duration-150 hover:text-primary group-hover/opt:opacity-100 group-data-[selected=true]/opt:opacity-100"
                >
                    only
                </button>
            </CommandItem>
        );
    };

    const grouped = groups && groups.length > 0;
    const optionsByGroup = React.useMemo(() => {
        const map = new Map<string, LedgerFilterOption[]>();
        for (const o of options) {
            const key = o.group ?? '_';
            const list = map.get(key);
            if (list) list.push(o);
            else map.set(key, [o]);
        }
        return map;
    }, [options]);

    return (
        <span className="inline-flex min-w-0 items-center gap-1">
            {showLabel && <span className="truncate">{label}</span>}
            {showLabel && isActive && (
                <span className="shrink-0 rounded bg-primary/15 px-1 font-mono text-[9px] font-bold leading-[1.4] text-primary">
                    {count}
                </span>
            )}
            <Popover open={open} onOpenChange={(o) => !disabled && setOpen(o)}>
                <PopoverTrigger asChild>
                    <button
                        type="button"
                        disabled={disabled}
                        aria-label={`Filter ${label}${isActive ? ` (${count} selected)` : ''}`}
                        title={disabled ? disabledHint : isActive ? `${label}: ${selected.join(', ')}` : `Filter ${label}`}
                        // Header cells sit inside the grid's mousedown/selection surface —
                        // don't let opening a menu start a cell drag.
                        onMouseDown={(e) => e.stopPropagation()}
                        onPointerDown={(e) => e.stopPropagation()}
                        className={cn(
                            'flex shrink-0 items-center justify-center rounded p-0.5 outline-none transition-colors duration-150',
                            'focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-primary',
                            disabled && 'cursor-not-allowed opacity-40',
                            isActive
                                ? 'text-primary hover:text-primary/80'
                                : 'text-muted-foreground/50 hover:text-muted-foreground',
                        )}
                    >
                        <ChevronDown className="h-3 w-3" />
                    </button>
                </PopoverTrigger>
                <PopoverContent align={align} sideOffset={4} className="w-56 p-0">
                    <Command loop>
                        <div className="flex items-center justify-between gap-2 border-b px-2 py-1.5">
                            <span className="truncate text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                                {label}
                            </span>
                            <span className="flex shrink-0 items-center gap-1">
                                <button
                                    type="button"
                                    onClick={selectAll}
                                    className="rounded px-1 text-[10px] font-medium text-muted-foreground transition-colors duration-150 hover:text-foreground"
                                >
                                    All
                                </button>
                                <button
                                    type="button"
                                    onClick={clear}
                                    disabled={!isActive}
                                    className="rounded px-1 text-[10px] font-medium text-muted-foreground transition-colors duration-150 hover:text-foreground disabled:opacity-40"
                                >
                                    Clear
                                </button>
                            </span>
                        </div>
                        {searchable && <CommandInput placeholder={`Search ${label.toLowerCase()}…`} className="h-8 text-xs" />}
                        <CommandList className="max-h-64">
                            <CommandEmpty className="py-4 text-center text-[11px] text-muted-foreground">
                                No match.
                            </CommandEmpty>
                            {grouped
                                ? groups.map((g) => {
                                      const opts = optionsByGroup.get(g.key) ?? [];
                                      if (opts.length === 0) return null;
                                      const allOn = g.values.every((v) => selectedSet.has(v));
                                      return (
                                          <CommandGroup key={g.key} heading={g.label} className="p-1">
                                              {g.values.length > 1 && (
                                                  <CommandItem
                                                      value={`all ${g.label} ${g.values.join(' ')}`}
                                                      onSelect={() => toggleGroup(g)}
                                                      className="gap-2 px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground"
                                                  >
                                                      <Check
                                                          className={cn(
                                                              'size-3 shrink-0',
                                                              allOn ? 'text-primary' : 'text-muted-foreground/30',
                                                          )}
                                                          strokeWidth={3}
                                                      />
                                                      {allOn ? `Clear ${g.label}` : `All ${g.label.toLowerCase()}`}
                                                  </CommandItem>
                                              )}
                                              {opts.map(renderOption)}
                                          </CommandGroup>
                                      );
                                  })
                                : <CommandGroup className="p-1">{options.map(renderOption)}</CommandGroup>}
                        </CommandList>
                        <CommandSeparator />
                        <div className="px-2 py-1 text-[10px] text-muted-foreground">
                            {isActive ? `${count} shown · everything else hidden` : 'All values shown'}
                        </div>
                    </Command>
                </PopoverContent>
            </Popover>
        </span>
    );
}

// ─── Toolbar chip — "how many filters are on, and get me out" ────────────────────
export function FilterSummaryChip({
    count,
    onClear,
    pending,
    disabled,
    disabledHint,
}: {
    count: number;
    onClear: () => void;
    pending?: boolean;
    disabled?: boolean;
    disabledHint?: string;
}) {
    if (count === 0) return null;
    return (
        <span
            className={cn(
                'animate-fade-in inline-flex h-6 items-center gap-1 rounded-md border border-primary/40 bg-primary/10 pl-1.5 pr-0.5 text-[11px] font-medium text-primary',
                pending && 'opacity-70',
            )}
            title={disabled ? disabledHint : `${count} column filter${count !== 1 ? 's' : ''} active`}
        >
            <Filter className="h-3 w-3" />
            Filters · {count}
            <Button
                variant="ghost"
                size="icon"
                disabled={disabled}
                title={disabled ? disabledHint : 'Clear all filters'}
                aria-label="Clear all filters"
                onClick={onClear}
                className="h-5 w-5 text-primary transition-colors duration-150 hover:bg-primary/15 hover:text-primary disabled:opacity-40"
            >
                <X className="h-3 w-3" />
            </Button>
        </span>
    );
}

// ─── Shared empty state — names the filters responsible ──────────────────────────
export function FilteredEmptyState({
    active,
    onClear,
    disabled,
}: {
    active: { label: string; values: string[] }[];
    onClear: () => void;
    disabled?: boolean;
}) {
    return (
        <div className="flex flex-col items-center justify-center gap-2 px-4 text-center">
            <Filter className="h-7 w-7 text-muted-foreground/30" />
            <p className="text-sm text-muted-foreground">No rows match the current filters.</p>
            {active.length > 0 && (
                <p className="max-w-md text-xs text-muted-foreground/70">
                    {active.map((a, i) => (
                        <span key={a.label}>
                            {i > 0 && <span className="text-muted-foreground/40"> · </span>}
                            <span className="font-semibold">{a.label}</span>{' '}
                            <span className="font-mono">{a.values.join(', ')}</span>
                        </span>
                    ))}
                </p>
            )}
            <Button
                variant="outline"
                size="sm"
                className="h-6 px-2 text-[11px]"
                onClick={onClear}
                disabled={disabled}
            >
                Clear filters
            </Button>
        </div>
    );
}
