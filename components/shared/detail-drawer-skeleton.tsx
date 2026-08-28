'use client';

// ─────────────────────────────────────────────────────────────────────────────
// PLATFORM LAYER — zero tenant knowledge. This is the "optimistic drawer"
// loading vocabulary: the shimmer primitive plus a right-side detail-drawer
// skeleton whose section rhythm matches a dense Blackwood slide-over (header
// identity · metric row · stat strip · one-line note · two history blocks).
//
// WHY IT EXISTS — the pattern, stated once:
//   A drawer opened by a click must SLIDE OUT ON THE CLICK FRAME, never after
//   its data resolves. The fetch runs concurrently and the drawer shows a
//   layout-matched skeleton until it lands. Waiting for data before opening
//   makes a fast interaction feel broken; an empty panel is just as bad. So:
//   open immediately → skeleton → fade the real content in.
//
// Used in two places for one open, and deliberately so:
//   1. `DetailDrawerSkeleton` — the whole fixed shell, as the Suspense fallback
//      for a lazily-imported drawer, so even the FIRST click (which also pays
//      the JS chunk download) opens on the click frame.
//   2. `DetailDrawerSkeletonBody` — just the inner sections, rendered INSIDE a
//      real drawer that is already mounted and owns its own slide transition
//      (see `app/(app)/inventory/_shared/blocking-detail-panel.tsx`, which takes
//      an opt-in `loading` prop).
//
// Motion rules (CLAUDE.md): opacity-only pulse (compositor-safe, never width /
// height), neutralized under `prefers-reduced-motion`, and NO stagger — a
// skeleton is a placeholder, not a reveal.
// ─────────────────────────────────────────────────────────────────────────────

import { X } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * Shimmer block. Defaults to a `bg-muted-foreground/15` fill so it reads on BOTH
 * `bg-background` (the drawer body) and `bg-muted` (the history boxes) — a plain
 * `bg-muted` block would be invisible inside the latter.
 */
export function Skeleton({ className }: { className?: string }) {
  return (
    <div
      aria-hidden
      className={cn(
        'animate-pulse rounded bg-muted-foreground/15 motion-reduce:animate-none',
        className,
      )}
    />
  );
}

/** One history block: a section label + a bordered box of placeholder rows. */
function HistorySkeleton({ rows }: { rows: number }) {
  return (
    <div>
      <div className="flex items-center justify-between mb-1.5">
        <Skeleton className="h-3 w-32" />
        <Skeleton className="h-3.5 w-14" />
      </div>
      <div className="rounded-md border border-border bg-muted">
        {Array.from({ length: rows }).map((_, i) => (
          <div
            key={i}
            className="flex items-center gap-2 border-b border-border/50 px-1.5 py-1 last:border-0"
          >
            <Skeleton className="h-3 w-16 shrink-0" />
            <Skeleton className="h-3 flex-1" />
            <Skeleton className="h-3 w-10 shrink-0" />
            <Skeleton className="h-3 w-12 shrink-0" />
          </div>
        ))}
      </div>
    </div>
  );
}

interface DetailDrawerSkeletonBodyProps {
  /**
   * The identity the CALLER already knows at click time (e.g. a block_loc).
   * Rendered as real text rather than a shimmer — showing what the user just
   * clicked is the cheapest way to make an instant drawer feel correct. Omit it
   * and the badge shimmers like everything else.
   */
  title?: string | null;
  /** Renders a working close button in the header. A loading drawer must be dismissible. */
  onClose?: () => void;
}

/**
 * The drawer's INNER sections while data is in flight. Emits FOUR top-level
 * siblings whose classes mirror the populated panel's four sections exactly
 * (sticky header · metrics · notes line · scrolling history), so React reuses
 * the same DOM nodes when the real content replaces them and nothing shifts.
 */
export function DetailDrawerSkeletonBody({ title, onClose }: DetailDrawerSkeletonBodyProps) {
  return (
    <>
      {/* ── Header (mirrors the panel's sticky header) ── */}
      <div className="shrink-0 bg-background/95 backdrop-blur-md border-b border-border px-4 py-3">
        <div className="flex items-center justify-between mb-1.5">
          <div className="flex items-center gap-2">
            {title ? (
              <span className="inline-flex items-center px-2 py-0.5 rounded-md border border-border bg-muted font-mono font-bold text-sm text-muted-foreground">
                {title}
              </span>
            ) : (
              <Skeleton className="h-[22px] w-16 rounded-md" />
            )}
            <Skeleton className="h-[17px] w-[68px] rounded-full" />
          </div>
          <div className="flex items-center gap-1.5">
            <Skeleton className="h-7 w-7 rounded-md" />
            {onClose ? (
              <button
                type="button"
                onClick={onClose}
                className="flex items-center justify-center w-7 h-7 rounded-md border border-border
                           text-muted-foreground hover:text-foreground hover:bg-muted
                           transition-all duration-150 cursor-pointer"
                title="Close (Esc)"
                aria-label="Close"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            ) : (
              <Skeleton className="h-7 w-7 rounded-md" />
            )}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Skeleton className="h-5 w-44" />
        </div>
      </div>

      {/* ── Metrics (mirrors the 3-cell metric grid + 7-cell stat strip) ── */}
      <div className="shrink-0 px-4 pt-3 pb-2 space-y-2">
        <div className="grid grid-cols-3 gap-2">
          <div className="rounded-md border px-2 py-1.5">
            <Skeleton className="h-[13px] w-12" />
            <Skeleton className="mt-1 h-[18px] w-24" />
            <Skeleton className="mt-1 h-1 w-full rounded-full" />
            <Skeleton className="mt-0.5 h-[11px] w-full" />
          </div>
          <div className="rounded-md border px-2 py-1.5">
            <Skeleton className="h-[13px] w-12" />
            <Skeleton className="mt-1 h-[18px] w-16" />
          </div>
          <div className="rounded-md border px-2 py-1.5">
            <Skeleton className="h-[13px] w-14" />
            <Skeleton className="mt-1 h-[18px] w-16" />
          </div>
        </div>
        <div className="flex gap-1">
          {Array.from({ length: 7 }).map((_, i) => (
            <div key={i} className="flex-1 min-w-0 rounded-md border px-1 py-1">
              <Skeleton className="mx-auto h-[11px] w-6" />
              <Skeleton className="mx-auto mt-0.5 h-4 w-8" />
            </div>
          ))}
        </div>
      </div>

      {/* ── Notes line ── */}
      <div className="shrink-0 px-4 pb-2">
        <div className="flex items-center gap-1.5 min-h-[24px]">
          <Skeleton className="h-3 w-3 shrink-0 rounded-sm" />
          <Skeleton className="h-3 w-12 shrink-0" />
          <Skeleton className="h-3 flex-1" />
        </div>
      </div>

      {/* ── History blocks ── */}
      <div className="flex-1 min-h-0 overflow-y-auto px-4 pb-3">
        <HistorySkeleton rows={5} />
        <div className="mt-3">
          <HistorySkeleton rows={3} />
        </div>
      </div>
    </>
  );
}

interface DetailDrawerSkeletonProps {
  /** Drives the slide — `false` parks the shell off-screen so the transition can run. */
  open: boolean;
  title?: string | null;
  onClose?: () => void;
}

/**
 * The FULL fixed drawer shell (backdrop + right-side panel) around
 * `DetailDrawerSkeletonBody`. Geometry, safe-area insets, easing and z-index are
 * kept byte-identical to `BlockingDetailPanel`'s own shell so swapping one for
 * the other (when a lazy chunk resolves) is a pure content swap, not a jump.
 *
 * Use as the `<Suspense>` fallback for a lazily-imported drawer.
 */
export function DetailDrawerSkeleton({ open, title, onClose }: DetailDrawerSkeletonProps) {
  return (
    <>
      <div
        className={cn(
          'fixed inset-0 z-40 bg-black/40 transition-opacity duration-250',
          open ? 'opacity-100' : 'opacity-0 pointer-events-none',
        )}
        onClick={onClose}
      />
      <div
        aria-busy
        className={cn(
          'fixed top-0 right-0 h-dvh w-full sm:w-[520px] z-50 bg-background border-l border-border',
          'safe-t safe-r safe-b',
          'transition-transform duration-250 [transition-timing-function:cubic-bezier(0.16,1,0.3,1)]',
          'overflow-hidden shadow-2xl flex flex-col',
          open ? 'translate-x-0' : 'translate-x-full',
        )}
      >
        <DetailDrawerSkeletonBody title={title} onClose={onClose} />
      </div>
    </>
  );
}
