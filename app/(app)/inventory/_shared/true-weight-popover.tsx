'use client';

import * as React from 'react';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';

/**
 * Display-only popover for the weight-deduction / true-weight feature
 * (locked design in `DEDUCTIONS_DESIGN.md`). Purely informational — it never
 * feeds a balance, total, or weighted average. The CALLER decides whether a row
 * is "tagged" (`true_weight_kg !== null`) and only mounts this when it is, so
 * `trueWeightKg` is non-null here.
 *
 * The marker that triggers the popover is the caller's responsibility — this
 * component only renders `{children}` inside `PopoverTrigger asChild`.
 *
 * Lines shown:
 *  1. True weight        — gross/physical weight BEFORE deductions (not gated)
 *  2. Recorded           — the Sheet-deducted `weight_kg` (not gated)
 *  3. Deduction          — short note, em dash when empty (not gated)
 *  4. Effective ₱/kg     — cost ÷ true weight, DISPLAYED only when the viewer
 *                          may see prices AND the math is well-defined (gated).
 */
interface TrueWeightPopoverProps {
  trueWeightKg: number; // non-null here — caller only renders the marker when tagged
  weightKg: number;
  deductionNote: string | null;
  costBasis: number | null; // already role-stripped by the caller where applicable
  canViewPrices: boolean;
  children: React.ReactNode; // the marker trigger (PopoverTrigger asChild wraps this)
}

function formatKg(value: number): string {
  return value.toLocaleString('en-US', {
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  });
}

function formatCurrency(value: number): string {
  return value.toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

export function TrueWeightPopover({
  trueWeightKg,
  weightKg,
  deductionNote,
  costBasis,
  canViewPrices,
  children,
}: TrueWeightPopoverProps) {
  const showEffective =
    canViewPrices && costBasis != null && trueWeightKg > 0;
  const effective = showEffective ? costBasis! / trueWeightKg : 0;

  return (
    <Popover>
      <PopoverTrigger asChild>{children}</PopoverTrigger>
      <PopoverContent
        align="end"
        sideOffset={4}
        // No entrance animation (CLAUDE.md motion rule — this sits in table rows):
        // override the base popover slide/zoom/fade with duration-0 + none.
        className="w-[220px] p-2 z-30 bg-popover/95 backdrop-blur-lg duration-0 data-[state=open]:animate-none data-[state=closed]:animate-none"
      >
        <div className="flex flex-col gap-1">
          {/* 1. True weight (not gated) */}
          <div className="flex items-center justify-between gap-3">
            <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
              True weight
            </span>
            <span className="font-mono text-xs">{formatKg(trueWeightKg)} kg</span>
          </div>

          {/* 2. Recorded after deduction (not gated) */}
          <div className="flex items-center justify-between gap-3">
            <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
              Recorded
            </span>
            <span className="font-mono text-xs">{formatKg(weightKg)} kg</span>
          </div>

          {/* 3. Deduction note (not gated) — em dash when empty */}
          <div className="flex items-start justify-between gap-3">
            <span className="text-[10px] uppercase tracking-wide text-muted-foreground shrink-0">
              Deduction
            </span>
            <span className="font-mono text-[10px] text-right leading-snug">
              {deductionNote && deductionNote.trim() ? deductionNote : '—'}
            </span>
          </div>

          {/* 4. Effective ₱/kg (price-gated) */}
          {showEffective && (
            <div className="flex items-center justify-between gap-3 border-t border-border/50 pt-1 mt-0.5">
              <span className="text-[10px] uppercase tracking-wide text-muted-foreground shrink-0">
                Effective ₱/kg
              </span>
              <span className="flex w-[90px] justify-between font-mono text-xs">
                <span className="text-muted-foreground">&#8369;</span>
                <span>{formatCurrency(effective)}</span>
              </span>
            </div>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
