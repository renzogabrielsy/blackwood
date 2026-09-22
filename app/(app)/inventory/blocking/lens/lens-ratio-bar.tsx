'use client';

// ─────────────────────────────────────────────────────────────────────────────
// THE STACKED RATIO BAR — the "ratio'd" picture, in one 12px strip.
//
// ── THE WIDTHS *ARE* THE PUBLISHED SHARES ───────────────────────────────────
// A segment's width is the server's own `sharePct`, written straight into `width`.
// Nothing here sums the segments, normalises them or divides by a total: SQL
// guarantees they add to 100 (proven against the live database by
// `scripts/verify-blocking-price-lens.ts` and `…-age-lens.ts`), so re-deriving them
// could only ever make the picture disagree with the rows beneath it.
//
// A segment whose share is NULL or zero renders NOTHING rather than a zero-width
// div — an empty band is a legitimate answer and it belongs in the legend, not in
// the bar.
//
// `role="img"` + an `aria-label` naming every band and its share is the bar's text
// alternative: the shape is the information, so a screen reader is given the shape.
// ─────────────────────────────────────────────────────────────────────────────

import * as React from 'react';

import { cn } from '@/lib/utils';
import { rampClass, rampClassAtStop, type LensRampId } from './lens-ramp';

export interface LensRatioSegment {
  key: React.Key;
  /** PERCENT 0–100, exactly as the server published it. Null = nothing to draw. */
  sharePct: number | null;
  /**
   * The ramp stop this segment wears, when the LENS decides it rather than its position.
   * Ordinal lenses omit it; a NOMINAL one states it. See `lens-ramp.ts`.
   */
  rampStop?: number;
}

export interface LensRatioBarProps {
  segments: readonly LensRatioSegment[];
  /** Which colour scale — the active lens's own `ramp`. */
  ramp: LensRampId;
  /** Names every band and its share; the bar's accessible text alternative. */
  ariaLabel: string;
  /**
   * The TRACK's classes, for a surface that is not the app's own.
   *
   * The printed lens summary is laid out in the live DOM and then printed, so a track
   * painted with `bg-muted` would come out of a dark-mode browser as a dark strip. The
   * SEGMENTS need no such escape — `lens-band-swatch` is a solid `rgb(var(--lens-hue))`
   * and is identical in both themes.
   */
  trackClassName?: string;
}

export function LensRatioBar({ segments, ramp, ariaLabel, trackClassName }: LensRatioBarProps) {
  return (
    <div
      className={cn(
        'flex h-3 w-full overflow-hidden rounded-full border',
        trackClassName ?? 'border-border bg-muted',
      )}
      role="img"
      aria-label={ariaLabel}
    >
      {segments.map((seg, i) => {
        const s = seg.sharePct;
        if (s === null || s <= 0) return null;
        return (
          <div
            key={seg.key}
            className={cn(
              'h-full',
              seg.rampStop === undefined
                ? rampClass(ramp, i, segments.length)
                : rampClassAtStop(ramp, seg.rampStop),
              'lens-band-swatch',
            )}
            style={{ width: `${s}%` }}
          />
        );
      })}
    </div>
  );
}
