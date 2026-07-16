'use client'

import * as React from 'react'

import {
    Tooltip,
    TooltipContent,
    TooltipTrigger,
} from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'

interface ConfidenceDotProps {
    value: number | null | undefined
    /** When true, render without a tooltip wrapper (caller controls it). */
    bare?: boolean
}

/**
 * Small colored dot summarizing extraction confidence.
 *
 * - green (≥0.9): high confidence
 * - amber (0.7–0.9): some warnings
 * - red (<0.7): material issues, review carefully
 * - gray: unknown confidence
 */
export function ConfidenceDot({ value, bare }: ConfidenceDotProps) {
    const { tone, label } = classify(value)
    const dot = (
        <span
            className={cn(
                'inline-block h-2 w-2 rounded-full shrink-0',
                tone === 'green' && 'bg-emerald-500',
                tone === 'amber' && 'bg-amber-500',
                tone === 'red' && 'bg-red-500',
                tone === 'gray' && 'bg-muted-foreground/40'
            )}
            aria-label={label}
        />
    )
    if (bare) return dot
    return (
        <Tooltip>
            <TooltipTrigger asChild>{dot}</TooltipTrigger>
            <TooltipContent side="top" className="text-xs">
                {label}
            </TooltipContent>
        </Tooltip>
    )
}

function classify(v: number | null | undefined): {
    tone: 'green' | 'amber' | 'red' | 'gray'
    label: string
} {
    if (v === null || v === undefined || Number.isNaN(v)) {
        return { tone: 'gray', label: 'Confidence unknown' }
    }
    const pct = Math.round(v * 100)
    if (v >= 0.9) return { tone: 'green', label: `High confidence (${pct}%)` }
    if (v >= 0.7) return { tone: 'amber', label: `Some warnings (${pct}%)` }
    return { tone: 'red', label: `Low confidence (${pct}%) — review carefully` }
}
