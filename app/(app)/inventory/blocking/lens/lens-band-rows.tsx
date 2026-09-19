'use client';

// ─────────────────────────────────────────────────────────────────────────────
// THE BAND LEGEND — one toggle row per band, the kg|blocks switch, and the row for
// the population that is in NO band.
//
// Shared by every lens on this frame, because the three things it draws are the
// three things a "ratio of the yard" always needs and they must not drift apart:
//
//   • ONE ROW PER BAND, ALWAYS, including an EMPTY one. A legend that hides its
//     empty bands cannot show the reader the scale they configured.
//   • A REAL `<button aria-pressed>` per row, so isolating a band is keyboard-
//     reachable and announced. The picked ring is the frame's, not the ramp's.
//   • THE EXCLUDED ROW IS SEPARATE AND MUTED. A block with no price, or with no
//     delivery date, is in no band and out of every percentage — it gets its own
//     row and is never folded into the first band. That is the ₱11.01-vs-₱39.99
//     `avg_cost` bug, and each lens meets it in its own costume.
//
// NOTHING IS COMPUTED HERE. Every figure arrives as a preformatted string or as the
// server's own `sharePct`; there is no sum, no division and no average.
// ─────────────────────────────────────────────────────────────────────────────

import * as React from 'react';

import { cn } from '@/lib/utils';
import { rampClass, type LensRampId } from './lens-ramp';
import { formatLensSharePct, type LensUnit } from './lens-shared';

// ── kg | blocks ─────────────────────────────────────────────────────────────

export interface LensUnitSwitchProps {
  unit: LensUnit;
  onChange: (unit: LensUnit) => void;
  /** What the pair is switching, for the screen reader. */
  ariaLabel?: string;
}

/**
 * The unit pair. It changes the bar AND the row percentages together, so a segment
 * and the number beside it are never in different units.
 */
export function LensUnitSwitch({ unit, onChange, ariaLabel = 'Measure bands by' }: LensUnitSwitchProps) {
  return (
    <div
      role="group"
      aria-label={ariaLabel}
      className="inline-flex overflow-hidden rounded-md border border-border"
    >
      {(['kg', 'blocks'] as const).map((u) => (
        <button
          key={u}
          type="button"
          onClick={() => onChange(u)}
          aria-pressed={unit === u}
          className={cn(
            'px-1.5 py-0.5 text-[10px] font-semibold transition-colors duration-150 cursor-pointer',
            unit === u
              ? 'bg-primary text-primary-foreground'
              : 'bg-muted text-muted-foreground hover:bg-accent hover:text-foreground',
          )}
        >
          {u}
        </button>
      ))}
    </div>
  );
}

// ── The rows ────────────────────────────────────────────────────────────────

export interface LensBandRow {
  /** The value handed back to `onToggle` — the band's own index in the payload. */
  index: number;
  /** What this band is called: the reader's name, or the lens's generated label. */
  label: string;
  /** PERCENT 0–100 as published, in whatever unit the switch is on. Null = unknown. */
  sharePct: number | null;
  /** The quiet second line, preformatted by the lens (`22 blocks · 1,275,018 kg`). */
  detail: string;
}

export interface LensBandRowsProps {
  rows: readonly LensBandRow[];
  ramp: LensRampId;
  /** Which band indices are isolated. Empty = every band shown (the ratio view). */
  picked: ReadonlySet<number>;
  onToggle: (index: number) => void;
}

export function LensBandRows({ rows, ramp, picked, onToggle }: LensBandRowsProps) {
  return (
    <ul className="flex flex-col gap-1">
      {rows.map((row, i) => {
        const isPicked = picked.has(row.index);
        return (
          <li key={row.index}>
            <button
              type="button"
              onClick={() => onToggle(row.index)}
              aria-pressed={isPicked}
              className={cn(
                'flex w-full items-start gap-2 rounded-md border px-2 py-1.5 text-left transition-colors duration-150 cursor-pointer',
                isPicked
                  ? 'border-primary bg-primary/10'
                  : 'border-border bg-card hover:bg-accent/50',
              )}
            >
              <span
                aria-hidden
                className={cn(
                  'mt-[3px] h-3 w-3 shrink-0 rounded-sm border border-border/60',
                  rampClass(ramp, i, rows.length),
                  'lens-band-swatch',
                )}
              />
              <span className="min-w-0 flex-1">
                <span className="flex items-baseline justify-between gap-2">
                  <span className="truncate text-[11px] font-semibold text-foreground">
                    {row.label}
                  </span>
                  <span className="shrink-0 font-mono text-[11px] font-bold text-foreground">
                    {formatLensSharePct(row.sharePct)}
                  </span>
                </span>
                <span className="mt-0.5 block text-[10px] text-muted-foreground">
                  {row.detail}
                </span>
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

// ── The population that is in NO band ───────────────────────────────────────

export interface LensExcludedRowProps {
  /** `No price yet — 3 blocks, 84,000 kg` — the headline, preformatted. */
  title: string;
  /** Why it is not in a band and what its cells look like. */
  note: string;
}

/**
 * The muted row for blocks the lens cannot place: unpriced for the price lens,
 * undated for the age lens. Dashed border and muted text, deliberately NOT a band
 * swatch — it is not a band and must not read as the first one.
 */
export function LensExcludedRow({ title, note }: LensExcludedRowProps) {
  return (
    <div className="rounded-md border border-dashed border-border bg-muted/30 px-2 py-1.5">
      <p className="text-[11px] font-semibold text-muted-foreground">{title}</p>
      <p className="mt-0.5 text-[10px] leading-snug text-muted-foreground">{note}</p>
    </div>
  );
}
