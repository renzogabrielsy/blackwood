'use client';

// =====================================================================
// Production Schedule — the SETUP cell (a library dropdown, not free text).
// =====================================================================
// Renzo's report: "changing setup ran doesnt automatically compute for the
// projected grades." It could not: the cell was a free-text `EditInput`, so the
// grid had no idea whether "3X50 / 6X50" was a known configuration or a typo.
// Making it a dropdown over `production_setups` is what makes the projection
// possible at all — the recompute lives in the grid, this file is the picker.
//
// Modelled on the shared `components/shared/grid/SelectCell` (same DropdownMenu
// primitives, same drag-suppressing mouse/pointer-down guards, same trigger
// shape) but NOT that component, because a setup picker needs three things a
// generic categorical cell must not grow:
//   1. a "+ New setup…" ACTION at the bottom (not an option — picking it opens a
//      dialog rather than setting a value),
//   2. a per-option "t/shift" hint so the operator can pick by tonnage,
//   3. a pinned LEGACY row for a stored setup string that is not in the library.
//      `production_schedule.setup` is free text with no FK, so a day can (and
//      does) carry a name nobody has added yet or that has since been retired.
//      Silently dropping it from the list would make the cell read as empty and
//      the first pick would destroy a real value.
// SelectCell stays platform-layer and untouched; this is tenant-layer.
//
// `open` is CONTROLLED by the grid so the keyboard model still works: F2 / Enter
// on a selected setup cell opens this menu, exactly where the other columns
// would open an inline editor.

import * as React from 'react';
import { ChevronDown, Plus } from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  projectSetup,
  type ProductionSetup,
} from '@/lib/production/setup-projection';

export interface ScheduleSetupCellProps {
  /** The day's current setup string (`''` = no setup / rest day). */
  value: string;
  /** ACTIVE setups only, already in `sort_order`. */
  setups: readonly ProductionSetup[];
  /** A library code was picked → the grid recomputes grades + projected tons. */
  onPickSetup: (code: string) => void;
  /** "No setup" was picked → the grid clears the label only (see the grid). */
  onClear: () => void;
  /** "+ New setup…" — the grid opens the create dialog for THIS day. */
  onCreateNew: () => void;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function ScheduleSetupCell({
  value,
  setups,
  onPickSetup,
  onClear,
  onCreateNew,
  open,
  onOpenChange,
}: ScheduleSetupCellProps) {
  const known = setups.some((s) => s.code === value);
  const isLegacy = value !== '' && !known;

  return (
    <DropdownMenu open={open} onOpenChange={onOpenChange}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={value ? `Setup: ${value}` : 'Choose a setup'}
          title={
            isLegacy
              ? `${value} — not in the setup library, so picking a shift count cannot rescale this day. Add it from the setup library to make it projectable.`
              : value || 'No setup — rest day'
          }
          onMouseDown={(e) => e.stopPropagation()}
          onPointerDown={(e) => e.stopPropagation()}
          className={cn(
            'flex h-8 w-full items-center justify-between gap-0.5 px-2 text-left outline-none',
            'transition-colors duration-150 hover:bg-sky-500/10',
            'focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-primary'
          )}
        >
          <span
            className={cn(
              'truncate text-xs',
              value ? 'text-foreground' : 'italic text-muted-foreground/70',
              isLegacy && 'text-amber-700 dark:text-amber-300'
            )}
          >
            {value || '— off —'}
          </span>
          <ChevronDown className="h-3 w-3 flex-none text-muted-foreground/40" />
        </button>
      </DropdownMenuTrigger>

      <DropdownMenuContent
        align="start"
        className="min-w-[220px] bg-popover/95 backdrop-blur-lg"
      >
        <DropdownMenuLabel className="text-[10px] uppercase tracking-wide text-muted-foreground">
          Setup library · tons per shift
        </DropdownMenuLabel>

        <DropdownMenuRadioGroup
          value={value}
          onValueChange={(v) => v && onPickSetup(v)}
        >
          {isLegacy && (
            <DropdownMenuRadioItem
              value={value}
              className="py-1 text-[11px]"
              // Re-picking a value with no template cannot project anything, so
              // it would be a no-op that LOOKS like a recompute. Say why.
              title="Not in the setup library — no mix to project from."
            >
              <span className="flex w-full items-center justify-between gap-3">
                <span className="truncate font-mono">{value}</span>
                <span className="shrink-0 text-[10px] text-amber-700 dark:text-amber-300">
                  not in library
                </span>
              </span>
            </DropdownMenuRadioItem>
          )}

          {setups.map((s) => {
            const perShift = projectSetup(s.gradeMix, 1).projectedTons;
            return (
              <DropdownMenuRadioItem
                key={s.code}
                value={s.code}
                className="py-1 text-[11px]"
                title={s.notes ?? s.label ?? s.code}
              >
                <span className="flex w-full items-center justify-between gap-3">
                  <span className="truncate font-mono">{s.code}</span>
                  <span className="shrink-0 font-mono tabular-nums text-muted-foreground">
                    {perShift} t
                  </span>
                </span>
              </DropdownMenuRadioItem>
            );
          })}
        </DropdownMenuRadioGroup>

        <DropdownMenuSeparator />

        <DropdownMenuItem
          className="py-1 text-[11px] text-muted-foreground"
          onSelect={onClear}
        >
          — No setup (rest day)
        </DropdownMenuItem>

        <DropdownMenuSeparator />

        <DropdownMenuItem className="py-1 text-[11px]" onSelect={onCreateNew}>
          <Plus className="h-3 w-3" />
          New setup…
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
