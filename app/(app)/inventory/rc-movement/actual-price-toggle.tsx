'use client';

import { cn } from '@/lib/utils';

// ═════════════════════════════════════════════════════════════════════════════════
// THE `ACTUAL ₱` SWITCH — one definition, three hosts (2026-09-17).
//
// Renzo, on the trimmed block footer: *"Being able to toggle on/off the ability to
// see the actual price of the block in the footer would be really cool."*
//
// ── WHY IT IS A FILE AND NOT THREE BUTTONS ──────────────────────────────────────
// Three surfaces show a block footer: the Classic matrix (`?grid=v1` AND the
// `/operations` RC FED modal, which hosts it) and the v2 Blackwood-Table grid. A
// toggle copied into each is three chances to drift — a different label, a different
// default, a different `aria-pressed`. This is the control; the hosts own only where
// the state LIVES (the URL on the route, React state inside the modal).
//
// ── IT HOLDS NO ROUTER HOOK, DELIBERATELY ───────────────────────────────────────
// `rc-movement-matrix.tsx` must stay prop-driven — `/operations`'s RC FED modal is a
// second HOST for it, and a `useSearchParams` in that tree would rewrite
// `/operations`'s own address (see `app/(app)/inventory/rc-movement/CONTEXT.md` →
// "Consumers outside this route"). So this is a controlled button and nothing else.
//
// ── AND IT IS ABSENT, NOT DISABLED, FOR A PRICE-DENIED READER ───────────────────
// A Production reader has no ACTUAL ₱/kg to reveal: `fetchRcMovementMatrix` does not
// even QUERY the three actual-price views for them. A greyed switch would advertise a
// figure that does not exist. Every host guards on `canViewPrices` before rendering.
// ═════════════════════════════════════════════════════════════════════════════════

/** `?actual=on`. OFF is the default, and is spelled as ABSENCE. */
export const ACTUAL_PARAM = 'actual';
export const ACTUAL_ON = 'on';

/** `?actual=` → whether the block footer carries its ACTUAL ₱/kg line. */
export function parseActualPrice(raw: string | string[] | undefined): boolean {
  const v = Array.isArray(raw) ? raw[0] : raw;
  return v === ACTUAL_ON;
}

export interface ActualPriceToggleProps {
  value: boolean;
  onChange(next: boolean): void;
  className?: string;
}

export function ActualPriceToggle({ value, onChange, className }: ActualPriceToggleProps) {
  return (
    <button
      type="button"
      aria-pressed={value}
      onClick={() => onChange(!value)}
      title={
        value
          ? 'Hide the ACTUAL ₱/kg line from each block footer. It is what a kilogram that actually reached the plant cost, and it exists only once a block is CLOSED and fully priced.'
          : 'Show each block’s ACTUAL ₱/kg in its footer — what a kilogram that actually reached the plant cost, after the pile lost weight. Blank on a block that is still open, carries an unpriced delivery, or had a sun-drying outflow.'
      }
      className={cn(
        'flex h-7 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md border border-input px-2.5 text-xs font-medium transition-colors duration-150',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        value
          ? 'bg-violet-100 text-violet-900 shadow-sm dark:bg-violet-950 dark:text-violet-200'
          : 'bg-background text-muted-foreground hover:text-foreground',
        className,
      )}
    >
      <span
        className={cn(
          'size-1.5 shrink-0 rounded-full bg-violet-500 transition-opacity duration-150',
          value ? 'opacity-100' : 'opacity-40',
        )}
      />
      Actual &#8369;
    </button>
  );
}
