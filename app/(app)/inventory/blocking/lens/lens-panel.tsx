'use client';

// ─────────────────────────────────────────────────────────────────────────────
// THE DOCKED LENS PANEL — the frame every lens is rendered inside.
//
// ── IT IS DOCKED, NOT MODAL, AND THAT IS THE WHOLE POINT ────────────────────
// A lens exists to make the GRID light up. A modal would cover the thing it is
// describing, so on a desktop the panel takes a 300px column beside the warehouse
// sections and the grid keeps the rest. Below `lg` there is no room for a column
// and it becomes a bottom sheet — still not covering the grid, which scrolls above
// it, because the sheet is capped at 65vh and the page keeps scrolling behind it.
//
// ── "NEVER CRUSH, ALWAYS SCROLL" IS PRESERVED, NOT DODGED ───────────────────
// The grid column is `min-w-0 flex-1`. Each warehouse section already carries its
// own `p-2 overflow-x-auto` wrapper and `.blocking-grid-cols` already floors every
// cell track at 104px (`minmax(104px, 1fr)`), so narrowing the column makes the
// SECTION scroll horizontally — it cannot make a cell crush. `min-w-0` is the load-
// bearing half: without it the flex item refuses to shrink below its content and
// the panel would push the page sideways instead.
//
// ── ESCAPE STEPS BACK ONE RUNG AT A TIME ────────────────────────────────────
// The detail panel already listens for Escape on the document. Rather than fight it
// with a capture-phase listener, this one BAILS while the detail panel is open, so
// Escape closes the drawer first and the lens on the next press — the same
// "step back one rung" behaviour `supplier-search.tsx` established in this module.
// It also bails when the event came from inside a Radix popper or dialog (the
// Customize popover, the basis select, the blend modal), whose own dismiss owns
// that key press.
// ─────────────────────────────────────────────────────────────────────────────

import * as React from 'react';
import { X } from 'lucide-react';

import { cn } from '@/lib/utils';
import type { BlockData } from '../types';
import type {
  BlockingLensCapabilities,
  BlockingLensClassifier,
  BlockingLensDefinition,
  BlockingLensId,
} from './types';

export interface BlockingLensPanelFrameProps {
  /** The lenses this reader may be offered, in tab order. Never empty when open. */
  lenses: readonly BlockingLensDefinition[];
  /** Which one is active. */
  activeId: BlockingLensId;
  onSelectLens: (id: BlockingLensId) => void;
  /** Close the panel entirely (also clears the grid's lens styling). */
  onClose: () => void;
  /** Drop the lens styling without closing — the panel's own Clear. */
  onClear: () => void;
  /** True when the active lens is currently marking anything. Enables Clear. */
  hasClassification: boolean;
  data: Record<string, BlockData>;
  caps: BlockingLensCapabilities;
  onClassifierChange: (classifier: BlockingLensClassifier | null) => void;
  /**
   * Select a block on the grid, exactly as clicking its cell does. Passed straight
   * through to the active lens, which uses it for a figure that NAMES a block (the
   * age lens's "oldest 1,176 days at B-7B").
   */
  onFocusBlock?: (blockLoc: string) => void;
  /**
   * Suppress the document Escape handler — passed `true` while the detail panel is
   * open so Escape closes the drawer first. See the header note.
   */
  escapeSuppressed?: boolean;
}

/** Would some other dismissable layer rightly own this key press? */
function fromDismissableLayer(target: EventTarget | null): boolean {
  const el = target as Element | null;
  if (!el || typeof el.closest !== 'function') return false;
  return !!el.closest('[data-radix-popper-content-wrapper],[role="dialog"],[role="listbox"]');
}

export function BlockingLensPanel({
  lenses,
  activeId,
  onSelectLens,
  onClose,
  onClear,
  hasClassification,
  data,
  caps,
  onClassifierChange,
  onFocusBlock,
  escapeSuppressed = false,
}: BlockingLensPanelFrameProps) {
  const active = lenses.find((l) => l.id === activeId) ?? lenses[0];

  const closeRef = React.useRef(onClose);
  React.useEffect(() => {
    closeRef.current = onClose;
  }, [onClose]);

  React.useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key !== 'Escape') return;
      if (escapeSuppressed) return;
      if (fromDismissableLayer(e.target)) return;
      closeRef.current();
    }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [escapeSuppressed]);

  if (!active) return null;
  const ActiveIcon = active.icon;
  const ActivePanel = active.Panel;

  return (
    <aside
      data-blocking-lens-panel
      aria-label={`${active.label} lens`}
      className={cn(
        // DESKTOP: a sticky column beside the grid. `shrink-0` + an explicit width
        // so the grid column (min-w-0 flex-1) is the one that gives, and it gives by
        // SCROLLING its sections rather than by crushing a cell.
        'shrink-0 rounded-lg border border-border bg-card',
        'lg:w-[300px] lg:sticky lg:top-[92px] lg:max-h-[calc(100dvh-108px)] lg:overflow-y-auto',
        // BELOW lg: a bottom sheet. Glass here is correct — it floats OVER the page
        // rather than sitting on top of scrolling grid cells (the frozen-pane rule
        // governs the latter, not this).
        'max-lg:fixed max-lg:inset-x-2 max-lg:bottom-2 max-lg:z-40 max-lg:max-h-[65dvh]',
        'max-lg:overflow-y-auto max-lg:shadow-lg',
        'max-lg:bg-background/95 max-lg:backdrop-blur max-lg:supports-backdrop-filter:bg-background/60',
        // A reveal, not a decoration: 250ms, opacity+transform only.
        'animate-fade-up',
      )}
    >
      {/* ── Header ── */}
      <div className="sticky top-0 z-10 flex items-start gap-2 border-b border-border bg-card/90 px-2.5 py-2 backdrop-blur-sm max-lg:bg-transparent">
        <ActiveIcon className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-xs font-bold text-foreground">{active.label} lens</h2>
          <p className="mt-0.5 text-[10px] leading-snug text-muted-foreground">{active.blurb}</p>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {hasClassification && (
            <button
              type="button"
              onClick={onClear}
              className="rounded-sm border border-border bg-muted px-1.5 py-0.5 text-[10px] font-semibold text-muted-foreground transition-colors duration-150 hover:text-foreground cursor-pointer"
              title="Remove the lens styling from the grid"
            >
              Clear
            </button>
          )}
          <button
            type="button"
            onClick={onClose}
            aria-label="Close the lens panel"
            title="Close (Esc)"
            className="rounded-sm p-0.5 text-muted-foreground transition-colors duration-150 hover:text-foreground cursor-pointer"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      {/* ── Tab strip — only once there is a choice to make. ──
          Two lenses are registered (Price, Age), so a price-viewer gets a strip. A
          reader who may be offered only ONE of them — Production, or anyone with the
          page's Prices toggle off — gets no strip at all rather than a lone tab or a
          disabled placeholder; the header already names the lens. The frame handles N. */}
      {lenses.length > 1 && (
        <div
          role="tablist"
          aria-label="Lenses"
          className="flex gap-1 border-b border-border px-2.5 py-1.5"
        >
          {lenses.map((l) => {
            const Icon = l.icon;
            const selected = l.id === active.id;
            return (
              <button
                key={l.id}
                type="button"
                role="tab"
                aria-selected={selected}
                onClick={() => onSelectLens(l.id)}
                className={cn(
                  'inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-semibold transition-colors duration-150 cursor-pointer',
                  selected
                    ? 'bg-primary text-primary-foreground'
                    : 'bg-muted text-muted-foreground hover:bg-accent hover:text-foreground',
                )}
              >
                <Icon className="h-3 w-3" />
                {l.label}
              </button>
            );
          })}
        </div>
      )}

      {/* ── The active lens's body. Keyed by id so switching MOUNTS the next one
             (and unmounts this one), which is what keeps each lens's own hooks and
             its own fetch lifecycle out of the other's way. ── */}
      <div className="px-2.5 py-2.5">
        <ActivePanel
          key={active.id}
          data={data}
          caps={caps}
          onClassifierChange={onClassifierChange}
          onRequestClose={onClose}
          onFocusBlock={onFocusBlock}
        />
      </div>
    </aside>
  );
}
