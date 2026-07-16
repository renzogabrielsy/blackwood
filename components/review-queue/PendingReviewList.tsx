'use client'

import * as React from 'react'
import { formatDistanceToNow, parseISO } from 'date-fns'
import { ChevronRight, FileSpreadsheet } from 'lucide-react'

import { Card } from '@/components/ui/card'
import {
    Tooltip,
    TooltipContent,
    TooltipProvider,
    TooltipTrigger,
} from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'

import { ConfidenceDot } from './ConfidenceDot'
import type { PendingReviewSummary } from '@/app/(app)/review-queue/actions'

interface PendingReviewListProps {
    entries: PendingReviewSummary[]
    onSelect: (id: string) => void
}

export function PendingReviewList({ entries, onSelect }: PendingReviewListProps) {
    return (
        <TooltipProvider delayDuration={200}>
            <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                {entries.map((entry) => (
                    <PendingReviewCard
                        key={entry.id}
                        entry={entry}
                        onClick={() => onSelect(entry.id)}
                    />
                ))}
            </div>
        </TooltipProvider>
    )
}

interface PendingReviewCardProps {
    entry: PendingReviewSummary
    onClick: () => void
}

function PendingReviewCard({ entry, onClick }: PendingReviewCardProps) {
    const received = entry.received_at
        ? formatDistanceToNow(parseISO(entry.received_at), { addSuffix: true })
        : entry.extracted_at
            ? `extracted ${formatDistanceToNow(parseISO(entry.extracted_at), { addSuffix: true })}`
            : 'just now'

    const { new: newCount, changed: changedCount, total } = entry.rowCounts
    const noopCount = Math.max(0, total - newCount - changedCount)

    return (
        <Card
            role="button"
            tabIndex={0}
            onClick={onClick}
            onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault()
                    onClick()
                }
            }}
            className={cn(
                'group cursor-pointer p-4 hover-lift',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40',
                'flex flex-col gap-2'
            )}
        >
            {/* Top — confidence + status + chevron */}
            <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2 min-w-0">
                    <ConfidenceDot value={entry.overall_confidence} />
                    <span className="text-[10px] uppercase tracking-wide text-muted-foreground/80 font-medium">
                        {entry.report_type.replace(/_/g, ' ')}
                    </span>
                </div>
                <ChevronRight className="h-4 w-4 text-muted-foreground/60 group-hover:text-foreground transition-colors shrink-0" />
            </div>

            {/* Filename + icon */}
            <div className="flex items-start gap-2 min-w-0">
                <FileSpreadsheet className="h-4 w-4 text-muted-foreground/70 mt-0.5 shrink-0" />
                <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium text-foreground truncate">
                        {entry.source_filename ?? 'Manual upload'}
                    </p>
                    <p className="text-[11px] text-muted-foreground">{received}</p>
                </div>
            </div>

            {/* Bottom — count badges */}
            <div className="flex flex-wrap items-center gap-1.5 pt-1">
                {newCount > 0 && (
                    <CountBadge
                        label="new"
                        count={newCount}
                        tone="green"
                        tooltip={`${newCount} row${newCount === 1 ? '' : 's'} not yet in deliveries`}
                    />
                )}
                {changedCount > 0 && (
                    <CountBadge
                        label="changed"
                        count={changedCount}
                        tone="amber"
                        tooltip={`${changedCount} row${changedCount === 1 ? '' : 's'} with field-level diffs vs DB`}
                    />
                )}
                {noopCount > 0 && (
                    <CountBadge
                        label="skipped"
                        count={noopCount}
                        tone="gray"
                        tooltip="Identical to existing rows — silently skipped"
                    />
                )}
                {newCount === 0 && changedCount === 0 && noopCount === 0 && (
                    <span className="text-[11px] text-muted-foreground italic">
                        no rows
                    </span>
                )}
            </div>
        </Card>
    )
}

interface CountBadgeProps {
    label: string
    count: number
    tone: 'green' | 'amber' | 'gray'
    tooltip: string
}

function CountBadge({ label, count, tone, tooltip }: CountBadgeProps) {
    const toneClass = {
        green:
            'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 border-emerald-500/30',
        amber:
            'bg-amber-500/10 text-amber-700 dark:text-amber-300 border-amber-500/30',
        gray:
            'bg-muted text-muted-foreground border-border',
    }[tone]

    return (
        <Tooltip>
            <TooltipTrigger asChild>
                <span
                    className={cn(
                        'inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5',
                        'text-[10px] font-medium tabular-nums',
                        toneClass
                    )}
                >
                    <span className="font-mono">{count}</span>
                    <span className="uppercase tracking-wide">{label}</span>
                </span>
            </TooltipTrigger>
            <TooltipContent side="top" className="text-xs">
                {tooltip}
            </TooltipContent>
        </Tooltip>
    )
}
