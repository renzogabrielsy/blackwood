'use client';

// ─────────────────────────────────────────────────────────────────────────────
// THE LENS LEGEND BAR — the frame every lens is rendered inside.
//
// ── IT IS A BAR, NOT A SIDEBAR (2026-09-21) ─────────────────────────────────
// It used to be a docked 300px `sticky` COLUMN beside the warehouse sections. The
// owner's verdict on the live page: *"the right sidebar is completely static and not
// minimizable … taking up precious space; we want to see the entire blocking as much
// as possible."* Both halves of that are fair — the grid gave up a fifth of its width
// permanently, to a panel that was mostly detail nobody reads twice.
//
// So the frame is now ONE SLIM ROW directly under the header strip, full width,
// sticky with it, holding only what a reader looks at while scanning the grid: which
// lens, the headline, one chip per band (the isolate toggles), a thin ratio bar, the
// kg|blocks switch, the "in no band" chip, and a GEAR. Everything else — the market
// basis and its coverage line, the detailed band rows with their counts and averages,
// Customize bands, the refusal banner — moved into a POPOVER behind that gear, which
// floats OVER the grid only while it is open and is never the default state.
//
// **The grid is full width again.** There is no flex row and no `min-w-0` column
// left to reason about: each warehouse section keeps its own `overflow-x-auto` and
// `.blocking-grid-cols` still floors every track at 104px, so "never crush, always
// scroll" holds for the reason it always did.
//
// ── THE BAR NEVER WRAPS ─────────────────────────────────────────────────────
// It is one line at every width. The band chips overflow by HORIZONTAL SCROLL inside
// their own `min-w-0 overflow-x-auto` box, because a legend that grows a second line
// pushes the whole grid down every time a cut line is added — which is the same
// mistake the header strip was rebuilt to stop making.
//
// ── ESCAPE STEPS BACK ONE RUNG AT A TIME ────────────────────────────────────
// Unchanged. The detail panel already listens for Escape on the document, so this
// handler BAILS while the drawer is open (Escape closes the drawer first, the lens on
// the next press) and bails when the press belongs to a Radix popper, dialog or
// listbox — which now includes the Settings popover itself, so Escape closes the
// popover before it closes the lens.
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
  /** Close the bar entirely (also clears the grid's lens styling). */
  onClose: () => void;
  /** Drop the lens styling without closing — the bar's own Clear. */
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
  const ActivePanel = active.Panel;

  return (
    <div
      data-blocking-lens-bar
      data-blocking-lens-panel
      aria-label={`${active.label} lens`}
      role="region"
      className={cn(
        // ONE LINE, FULL WIDTH, never wrapping. Same glass as the header strip it
        // sits under, because the two are one sticky unit over the scrolling grid.
        'flex h-9 min-w-0 flex-nowrap items-center gap-2 overflow-hidden rounded-lg',
        'border border-border bg-card/95 px-2 backdrop-blur-sm',
        // A reveal, not a decoration: 250ms, opacity+transform only.
        'animate-fade-up',
      )}
    >
      {/* ── The lens switch — only once there is a choice to make. ──
          Two lenses are registered (Price, Age), so a price-viewer gets a switch. A
          reader who may be offered only ONE of them — Production, or anyone with the
          page's Prices toggle off — gets a plain label instead of a lone tab. */}
      {lenses.length > 1 ? (
        <div
          role="tablist"
          aria-label="Lenses"
          className="flex shrink-0 items-center gap-0.5 overflow-hidden rounded-md border border-border"
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
                title={l.blurb}
                className={cn(
                  'inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px] font-semibold',
                  'transition-colors duration-150 cursor-pointer',
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
      ) : (
        <span
          className="inline-flex shrink-0 items-center gap-1 text-[10px] font-bold uppercase tracking-wide text-foreground"
          title={active.blurb}
        >
          <active.icon className="h-3 w-3 text-primary" />
          {active.label}
        </span>
      )}

      <span aria-hidden className="h-4 w-px shrink-0 bg-border" />

      {/* ── The active lens's own bar content. Keyed by id so switching MOUNTS the
             next one (and unmounts this one), which is what keeps each lens's hooks
             and its own fetch lifecycle out of the other's way. ── */}
      <div className="flex min-w-0 flex-1 items-center gap-2 overflow-hidden">
        <ActivePanel
          key={active.id}
          data={data}
          caps={caps}
          onClassifierChange={onClassifierChange}
          onRequestClose={onClose}
          onFocusBlock={onFocusBlock}
        />
      </div>

      {/* ── Frame actions ── */}
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
          aria-label="Close the lens bar"
          title="Close (Esc)"
          className="rounded-sm p-0.5 text-muted-foreground transition-colors duration-150 hover:text-foreground cursor-pointer"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
}
