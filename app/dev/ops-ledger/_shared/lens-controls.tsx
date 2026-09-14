'use client';

import * as React from 'react';

import { cn } from '@/lib/utils';
import { COLUMN_GROUPS, LENS_PRESETS, presetFor, type ColumnGroupId } from './column-groups';

// ═════════════════════════════════════════════════════════════════════════════════
// The two controls that make the unification thesis operable — requirements (1) and (2).
//
//   `ColumnGroupChips`   — (1) "toggle buttons to see which table group to display"
//   `LensSwitcher`       — (2) "switch back and forth between this ledger and RC Movement"
//
// THEY ARE THE SAME STATE. `LensSwitcher` writes a SET of column-group ids; the chips
// write the same set one element at a time. That is the whole argument in interaction
// form: RC Movement is not a destination you navigate to, it is a preset of these chips,
// and clicking a chip after picking a preset simply leaves the preset behind (the switcher
// then reads "Custom", which is honest rather than a lie about which screen you are on).
//
// Both are kept deliberately plain — no icons, no colour coding. Six chips in a rail read
// faster as text than as a small zoo of glyphs, and the only colour on this page should be
// carrying data.
// ═════════════════════════════════════════════════════════════════════════════════

export interface LensSwitcherProps {
    groups: readonly ColumnGroupId[];
    onChange(next: ColumnGroupId[]): void;
    /** Render the preset's one-line explanation underneath. */
    showHint?: boolean;
    className?: string;
}

export function LensSwitcher({ groups, onChange, showHint = true, className }: LensSwitcherProps) {
    const active = presetFor(groups);

    return (
        <div className={cn('flex flex-col gap-1', className)}>
            <div
                role="tablist"
                aria-label="Lens"
                // `p-0.5` + a moving background is the segmented-control idiom. The
                // indicator is a sibling background rather than an animated bar, so
                // nothing animates a layout property.
                className="inline-flex shrink-0 items-center gap-0.5 rounded-md border border-input bg-muted/50 p-0.5"
            >
                {LENS_PRESETS.map((p) => {
                    const on = active?.id === p.id;
                    return (
                        <button
                            key={p.id}
                            type="button"
                            role="tab"
                            aria-selected={on}
                            onClick={() => onChange([...p.groups])}
                            title={p.hint}
                            className={cn(
                                'h-7 whitespace-nowrap rounded px-2.5 text-xs font-medium',
                                'transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                                on
                                    ? 'bg-background text-foreground shadow-sm'
                                    : 'text-muted-foreground hover:text-foreground',
                            )}
                        >
                            {p.label}
                        </button>
                    );
                })}
                {active === null ? (
                    <span className="h-7 whitespace-nowrap rounded bg-background px-2.5 text-xs font-medium leading-7 shadow-sm">
                        Custom
                    </span>
                ) : null}
            </div>
            {showHint ? (
                <p className="max-w-[60ch] text-[11px] leading-snug text-muted-foreground">
                    {active
                        ? active.hint
                        : 'Custom set — the lens presets are just saved combinations of the chips below.'}
                </p>
            ) : null}
        </div>
    );
}

export interface ColumnGroupChipsProps {
    groups: readonly ColumnGroupId[];
    onChange(next: ColumnGroupId[]): void;
    /** Hide the ₱ group entirely — the price boundary, expressed as absence. */
    canViewPrices: boolean;
    /** Print each group's approximate px cost on the chip. */
    showWidth?: boolean;
    className?: string;
}

export function ColumnGroupChips({
    groups,
    onChange,
    canViewPrices,
    showWidth = false,
    className,
}: ColumnGroupChipsProps) {
    const visible = COLUMN_GROUPS.filter((g) => canViewPrices || !g.carriesPrice);

    const toggle = (id: ColumnGroupId) => {
        onChange(groups.includes(id) ? groups.filter((g) => g !== id) : [...groups, id]);
    };

    return (
        // NEVER CRUSH, ALWAYS SCROLL, applied to a control rail: `shrink-0` chips inside an
        // `overflow-x-auto` track, so a phone scrolls the rail sideways instead of
        // compressing six labels into unreadable stubs.
        <div
            className={cn('flex items-center gap-1.5 overflow-x-auto pb-0.5', className)}
            role="group"
            aria-label="Column groups"
        >
            {visible.map((g) => {
                const on = groups.includes(g.id);
                return (
                    <button
                        key={g.id}
                        type="button"
                        aria-pressed={on}
                        onClick={() => toggle(g.id)}
                        title={g.hint}
                        className={cn(
                            'flex h-7 shrink-0 items-center gap-1.5 rounded-full border px-2.5 text-xs',
                            'transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                            on
                                ? 'border-foreground/30 bg-foreground text-background'
                                : 'border-input bg-background text-muted-foreground hover:bg-muted hover:text-foreground',
                        )}
                    >
                        <span className="whitespace-nowrap font-medium">{g.label}</span>
                        {showWidth ? (
                            <span
                                className={cn(
                                    'font-mono text-[10px] tabular-nums',
                                    on ? 'text-background/70' : 'text-muted-foreground/70',
                                )}
                            >
                                {g.approxWidth}px
                            </span>
                        ) : null}
                    </button>
                );
            })}
        </div>
    );
}
