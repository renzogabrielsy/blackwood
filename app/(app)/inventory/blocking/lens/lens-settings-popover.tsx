'use client';

// ─────────────────────────────────────────────────────────────────────────────
// THE SETTINGS POPOVER — everything that used to BE the docked sidebar.
//
// The legend bar (`lens-panel.tsx`) holds what a reader looks at while scanning the
// grid. This holds what they set up ONCE and then stop reading: the market basis and
// its coverage line, the detailed band rows with their counts and averages, Customize
// bands, and the inline refusal banner.
//
// ── IT FLOATS OVER THE GRID, AND ONLY WHILE IT IS OPEN ──────────────────────
// That is the whole difference from the sidebar it replaces. A docked column costs
// the grid its width for as long as the lens is open; this costs nothing until the
// gear is clicked, and closes on an outside click or Escape (Radix's own dismiss —
// which is also why the frame's Escape handler bails on a `[role="dialog"]` target,
// so one press closes the popover and the next closes the lens).
//
// ── IT OWNS THE SHELL, NEVER THE WORDS ──────────────────────────────────────
// Same discipline as `lens-customize.tsx`: the glass, the width, the scroll cap and
// the gear live here so two lenses cannot drift; every label, figure and dimension is
// passed in by the lens. Below `lg` it widens to the viewport rather than staying at
// a desktop column width, so a phone gets a full-width sheet-like surface instead of
// a 320px box wedged against one edge.
// ─────────────────────────────────────────────────────────────────────────────

import * as React from 'react';
import { Settings2 } from 'lucide-react';

import { cn } from '@/lib/utils';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';

export interface LensSettingsPopoverProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Named for the screen reader — "Price lens settings". */
  label: string;
  /** True while anything is off this lens's shipped defaults. Marks the gear. */
  customised?: boolean;
  /** The lens's own controls. */
  children: React.ReactNode;
}

export function LensSettingsPopover({
  open,
  onOpenChange,
  label,
  customised = false,
  children,
}: LensSettingsPopoverProps) {
  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={label}
          title={label}
          data-blocking-lens-settings
          className={cn(
            'inline-flex shrink-0 items-center gap-1 rounded-md border px-1.5 py-0.5',
            'text-[10px] font-semibold transition-colors duration-150 cursor-pointer',
            open || customised
              ? 'border-primary bg-primary/15 text-foreground'
              : 'border-border bg-muted text-muted-foreground hover:bg-accent hover:text-foreground',
          )}
        >
          <Settings2 className="h-3 w-3" />
          <span className="max-lg:hidden">Settings</span>
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        sideOffset={6}
        // The canonical popover glass, plus an internal scroll cap so a 7-band
        // Customize disclosure cannot run off the bottom of a short viewport.
        className={cn(
          'bg-popover/95 backdrop-blur-lg',
          'w-[320px] max-lg:w-[calc(100vw-1.5rem)]',
          'max-h-[min(70dvh,560px)] overflow-y-auto p-2.5',
        )}
      >
        <div className="flex flex-col gap-3 text-xs">{children}</div>
      </PopoverContent>
    </Popover>
  );
}
