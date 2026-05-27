'use client'

import * as React from 'react'

import { cn } from '@/lib/utils'

export type RowDecision = 'email_wins' | 'db_wins' | 'both'

interface RowDecisionToggleProps {
    value: RowDecision
    onChange: (next: RowDecision) => void
    disabled?: boolean
}

const OPTIONS: Array<{
    value: RowDecision
    label: string
    tooltip: string
}> = [
    {
        value: 'email_wins',
        label: 'Email wins',
        tooltip: 'Update DB row to match email values',
    },
    {
        value: 'db_wins',
        label: 'DB wins',
        tooltip: 'Keep existing DB row, ignore email values',
    },
    {
        value: 'both',
        label: 'Both',
        tooltip: 'Insert email values as a new row (split shipment)',
    },
]

/**
 * 3-state segmented control for VALUE_CHANGED rows.
 *
 * Rolled by hand because the project has neither ToggleGroup nor RadioGroup
 * primitives. Built on plain buttons so it keeps the dense Excel look —
 * each option is `h-6 px-2 text-[10px]`, the same scale as our table cells.
 */
export function RowDecisionToggle({
    value,
    onChange,
    disabled,
}: RowDecisionToggleProps) {
    return (
        <div
            role="radiogroup"
            aria-label="Conflict resolution"
            className={cn(
                'inline-flex items-center rounded-md border border-border bg-background p-0.5',
                disabled && 'opacity-50 pointer-events-none'
            )}
        >
            {OPTIONS.map((opt) => {
                const active = value === opt.value
                return (
                    <button
                        key={opt.value}
                        type="button"
                        role="radio"
                        aria-checked={active}
                        title={opt.tooltip}
                        disabled={disabled}
                        onClick={() => onChange(opt.value)}
                        className={cn(
                            'h-6 px-2 text-[10px] font-medium rounded-[5px]',
                            'transition-colors duration-150',
                            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40',
                            active
                                ? 'bg-primary text-primary-foreground shadow-sm'
                                : 'text-muted-foreground hover:text-foreground hover:bg-muted'
                        )}
                    >
                        {opt.label}
                    </button>
                )
            })}
        </div>
    )
}
