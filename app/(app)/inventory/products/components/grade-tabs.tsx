'use client';

import * as React from 'react';

import type { ProductGrade } from '@/lib/products/types';
import { cn } from '@/lib/utils';

// ═════════════════════════════════════════════════════════════════════════════════
// The grade rail — BIG tab cards.
//
// Renzo, on Option A: *"Also make the grade tabs bigger."* The mockup's 24px pill chips
// became 60px cards: the grade name at 15px semibold, and beneath it the two numbers a
// person actually picks a tab by — FINAL flecs and vans ready — in mono 11px.
//
// A NEW GRADE APPEARS BY ITSELF. The rail is `ProductsData.grades`, which is
// `view_product_onhand` filtered to `active` — so a tab the sync discovers in the
// workbook is a tab here on the next run, with no code change. Nothing retires a grade
// automatically either: `active = false` can only be set by hand.
//
// NEVER CRUSH, ALWAYS SCROLL: the rail is `overflow-x-auto` with `shrink-0` cards, so on
// a phone it scrolls sideways rather than compressing five names into unreadable slivers.
// ═════════════════════════════════════════════════════════════════════════════════

function int(value: number): string {
    return value.toLocaleString('en-US', { maximumFractionDigits: 0 });
}

function vans(value: number): string {
    return value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export interface GradeTabsProps {
    grades: readonly ProductGrade[];
    /** The grade code currently shown — optimistic, so a click paints on the same frame. */
    selectedCode: string | null;
    onSelect(code: string): void;
    /** Dim while the newly selected grade's ledger is still in flight. */
    pending?: boolean;
}

export function GradeTabs({ grades, selectedCode, onSelect, pending }: GradeTabsProps) {
    if (grades.length === 0) return null;

    return (
        <div
            role="tablist"
            aria-label="Product grade"
            className={cn(
                'flex shrink-0 gap-2 overflow-x-auto pb-1',
                pending && 'opacity-70 transition-opacity duration-150',
            )}
        >
            {grades.map((grade) => {
                const active = grade.gradeCode === selectedCode;
                return (
                    <button
                        key={grade.gradeId}
                        type="button"
                        role="tab"
                        aria-selected={active}
                        onClick={() => onSelect(grade.gradeCode)}
                        title={`${grade.displayName} — ${int(grade.totalFlecs)} flec on hand across ${grade.stageCount} stage${grade.stageCount === 1 ? '' : 's'}`}
                        className={cn(
                            // 60px tall, and `shrink-0` so the rail scrolls instead of crushing.
                            'flex h-[60px] shrink-0 flex-col items-start justify-center gap-1 rounded-lg border px-4',
                            'transition-[background-color,border-color,color,transform] duration-150',
                            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                            active
                                ? 'border-primary bg-primary text-primary-foreground shadow-sm'
                                : 'border-border bg-card text-foreground hover:border-foreground/25 hover:bg-muted/60',
                        )}
                    >
                        <span className="whitespace-nowrap text-[15px] font-semibold leading-none">
                            {grade.displayName}
                        </span>
                        <span
                            className={cn(
                                'whitespace-nowrap font-mono text-[11px] leading-none tabular-nums',
                                active ? 'text-primary-foreground/75' : 'text-muted-foreground',
                            )}
                        >
                            FINAL {int(grade.finalFlecs)} flec · {vans(grade.vansReady)} vans
                        </span>
                    </button>
                );
            })}
        </div>
    );
}
