'use client'

import * as React from 'react'
import { format, formatDistanceToNow, parseISO } from 'date-fns'
import { ArrowLeft, CheckCircle2, Loader2, XCircle } from 'lucide-react'
import { toast } from 'sonner'

import { errorToast } from '@/lib/toast'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import {
    AlertDialog,
    AlertDialogAction,
    AlertDialogCancel,
    AlertDialogContent,
    AlertDialogDescription,
    AlertDialogFooter,
    AlertDialogHeader,
    AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Textarea } from '@/components/ui/textarea'
import { cn } from '@/lib/utils'

import { ClassifiedRowsTable } from './ClassifiedRowsTable'
import { ConfidenceDot } from './ConfidenceDot'
import type { RowDecision } from './RowDecisionToggle'

import {
    approveReview,
    getReviewDetail,
    rejectReview,
    type PendingReviewDetail,
} from '@/app/(app)/review-queue/actions'

interface ReviewDetailPanelProps {
    id: string
    onBack: () => void
    onDecided: () => void
}

export function ReviewDetailPanel({ id, onBack, onDecided }: ReviewDetailPanelProps) {
    const [detail, setDetail] = React.useState<PendingReviewDetail | null>(null)
    const [loading, setLoading] = React.useState(true)
    const [loadError, setLoadError] = React.useState<string | null>(null)
    const [decisions, setDecisions] = React.useState<Record<number, RowDecision>>({})
    const [approving, setApproving] = React.useState(false)
    const [rejecting, setRejecting] = React.useState(false)
    const [approveOpen, setApproveOpen] = React.useState(false)
    const [rejectOpen, setRejectOpen] = React.useState(false)
    const [rejectReason, setRejectReason] = React.useState('')

    // Initial fetch
    React.useEffect(() => {
        let cancelled = false
        setLoading(true)
        setLoadError(null)
        getReviewDetail(id)
            .then((data) => {
                if (cancelled) return
                setDetail(data)
                // Seed every VALUE_CHANGED row with the default decision.
                const seed: Record<number, RowDecision> = {}
                for (const r of data.rows) {
                    if (r.class === 'VALUE_CHANGED') seed[r.index] = 'email_wins'
                }
                setDecisions(seed)
            })
            .catch((err) => {
                if (cancelled) return
                const msg = err instanceof Error ? err.message : 'Failed to load review'
                setLoadError(msg)
                errorToast('Failed to load review', { description: msg })
            })
            .finally(() => {
                if (!cancelled) setLoading(false)
            })
        return () => {
            cancelled = true
        }
    }, [id])

    const handleDecisionChange = React.useCallback(
        (idx: number, next: RowDecision) => {
            setDecisions((d) => ({ ...d, [idx]: next }))
        },
        []
    )

    const handleApprove = async () => {
        if (!detail || approving) return
        setApproving(true)
        try {
            const result = await approveReview({ id: detail.id, decisions })
            const parts: string[] = []
            if (result.inserted) parts.push(`${result.inserted} inserted`)
            if (result.updated) parts.push(`${result.updated} updated`)
            if (result.skipped) parts.push(`${result.skipped} skipped`)
            toast.success(
                parts.length > 0 ? parts.join(' · ') : 'Review approved',
                { duration: 4000 }
            )
            setApproveOpen(false)
            onDecided()
        } catch (err) {
            errorToast(
                err instanceof Error ? err.message : 'Approve failed',
                { description: 'No rows were committed.' }
            )
        } finally {
            setApproving(false)
        }
    }

    const handleReject = async () => {
        if (!detail || rejecting) return
        setRejecting(true)
        try {
            await rejectReview({
                id: detail.id,
                reason: rejectReason.trim() || undefined,
            })
            toast.success('Review rejected', { duration: 3000 })
            setRejectOpen(false)
            setRejectReason('')
            onDecided()
        } catch (err) {
            errorToast(
                err instanceof Error ? err.message : 'Reject failed'
            )
        } finally {
            setRejecting(false)
        }
    }

    // ─── Render ──────────────────────────────────────────────────────────────

    if (loading) {
        return (
            <Card className="p-10 flex items-center justify-center text-xs text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin mr-2" />
                Loading review…
            </Card>
        )
    }

    if (loadError || !detail) {
        return (
            <Card className="p-6 space-y-3">
                <p className="text-sm font-medium text-destructive">
                    Couldn&apos;t load this review.
                </p>
                {loadError && (
                    <p className="text-xs text-muted-foreground break-words">
                        {loadError}
                    </p>
                )}
                <Button variant="outline" size="sm" onClick={onBack}>
                    <ArrowLeft className="h-4 w-4 mr-1" /> Back to queue
                </Button>
            </Card>
        )
    }

    const newRows = detail.rows.filter((r) => r.class === 'NEW')
    const changedRows = detail.rows.filter((r) => r.class === 'VALUE_CHANGED')
    const approvableCount = newRows.length + changedRows.length

    const received = detail.received_at
        ? formatDistanceToNow(parseISO(detail.received_at), { addSuffix: true })
        : null
    const extracted = detail.extracted_at
        ? format(parseISO(detail.extracted_at), 'yyyy-MM-dd HH:mm')
        : null

    return (
        <Card className="overflow-hidden p-0 animate-fade-up">
            {/* Sticky glass header */}
            <div className="sticky top-0 z-20 border-b border-border bg-background/90 backdrop-blur-sm px-4 py-3">
                <div className="flex items-start justify-between gap-3">
                    <div className="flex items-start gap-3 min-w-0">
                        <Button
                            variant="ghost"
                            size="icon-sm"
                            onClick={onBack}
                            disabled={approving || rejecting}
                            className="shrink-0"
                            aria-label="Back to queue"
                        >
                            <ArrowLeft className="h-4 w-4" />
                        </Button>
                        <div className="min-w-0">
                            <div className="flex items-center gap-2">
                                <ConfidenceDot value={detail.overall_confidence} />
                                <p className="text-sm font-semibold tracking-tight truncate">
                                    {detail.source_filename ?? 'Manual upload'}
                                </p>
                            </div>
                            <p className="text-[11px] text-muted-foreground mt-0.5">
                                <span className="uppercase tracking-wide">
                                    {detail.report_type.replace(/_/g, ' ')}
                                </span>
                                {received && <> · received {received}</>}
                                {extracted && <> · extracted {extracted}</>}
                            </p>
                        </div>
                    </div>

                    {/* Top-right summary chips */}
                    <div className="flex items-center gap-2 shrink-0">
                        <SummaryChip count={newRows.length} label="new" tone="green" />
                        <SummaryChip count={changedRows.length} label="changed" tone="amber" />
                    </div>
                </div>

                {/* Diagnostic messages, if any */}
                {detail.diagnostic.length > 0 && (
                    <div className="mt-2 rounded-md border border-border bg-muted/50 px-2.5 py-1.5">
                        <ul className="text-[11px] text-muted-foreground space-y-0.5">
                            {detail.diagnostic.map((d, i) => (
                                <li key={i} className="leading-snug">
                                    {d}
                                </li>
                            ))}
                        </ul>
                    </div>
                )}
            </div>

            {/* Table */}
            <div className="overflow-auto">
                <ClassifiedRowsTable
                    rows={detail.rows}
                    decisions={decisions}
                    onDecisionChange={handleDecisionChange}
                    disabled={approving || rejecting}
                />
            </div>

            {/* Footer — action bar */}
            <div className="sticky bottom-0 z-20 border-t border-border bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60 px-4 py-2.5">
                <div className="flex items-center justify-between gap-3">
                    <p className="text-[11px] text-muted-foreground">
                        {approvableCount === 0
                            ? 'Nothing to approve — all rows are unchanged.'
                            : `Approving will insert ${newRows.length} new row${
                                newRows.length === 1 ? '' : 's'
                            } and apply ${changedRows.length} change decision${
                                changedRows.length === 1 ? '' : 's'
                            }.`}
                    </p>
                    {/* Review actions — desktop only (mobile scope: approve/reject stay desktop) */}
                    <div className="hidden sm:flex items-center gap-2">
                        <Button
                            variant="outline"
                            size="sm"
                            disabled={approving || rejecting}
                            onClick={() => setRejectOpen(true)}
                            className="gap-1.5"
                        >
                            <XCircle className="h-4 w-4" />
                            Reject
                        </Button>
                        <Button
                            size="sm"
                            disabled={approving || rejecting || approvableCount === 0}
                            onClick={() => setApproveOpen(true)}
                            className="gap-1.5"
                        >
                            {approving ? (
                                <Loader2 className="h-4 w-4 animate-spin" />
                            ) : (
                                <CheckCircle2 className="h-4 w-4" />
                            )}
                            {approving
                                ? 'Committing…'
                                : `Approve ${approvableCount} row${approvableCount === 1 ? '' : 's'}`}
                        </Button>
                    </div>
                    {/* Mobile placeholder — review actions are desktop-only */}
                    <p className="sm:hidden shrink-0 text-[11px] text-muted-foreground">
                        Review actions are available on desktop.
                    </p>
                </div>
            </div>

            {/* Reject confirm */}
            <AlertDialog open={rejectOpen} onOpenChange={(open) => !rejecting && setRejectOpen(open)}>
                <AlertDialogContent className={cn(
                    'bg-background/95 backdrop-blur-xl supports-[backdrop-filter]:bg-background/80'
                )}>
                    <AlertDialogHeader>
                        <AlertDialogTitle>Reject this review?</AlertDialogTitle>
                        <AlertDialogDescription>
                            The pending review will be marked rejected. No rows are committed.
                            Add an optional reason for the audit trail.
                        </AlertDialogDescription>
                    </AlertDialogHeader>
                    <Textarea
                        value={rejectReason}
                        onChange={(e) => setRejectReason(e.target.value)}
                        placeholder="Reason (optional)…"
                        rows={3}
                        disabled={rejecting}
                        className="text-sm"
                    />
                    <AlertDialogFooter>
                        <AlertDialogCancel disabled={rejecting}>Cancel</AlertDialogCancel>
                        <AlertDialogAction
                            onClick={(e) => {
                                e.preventDefault()
                                void handleReject()
                            }}
                            disabled={rejecting}
                            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                        >
                            {rejecting ? (
                                <Loader2 className="h-4 w-4 animate-spin mr-1.5" />
                            ) : null}
                            Reject
                        </AlertDialogAction>
                    </AlertDialogFooter>
                </AlertDialogContent>
            </AlertDialog>

            {/* Approve confirm */}
            <AlertDialog open={approveOpen} onOpenChange={(open) => !approving && setApproveOpen(open)}>
                <AlertDialogContent className={cn(
                    'bg-background/95 backdrop-blur-xl supports-[backdrop-filter]:bg-background/80'
                )}>
                    <AlertDialogHeader>
                        <AlertDialogTitle>
                            Approve and write {approvableCount} row{approvableCount === 1 ? '' : 's'} to deliveries?
                        </AlertDialogTitle>
                        <AlertDialogDescription>
                            This inserts {newRows.length} new row{newRows.length === 1 ? '' : 's'} and applies{' '}
                            {changedRows.length} change decision{changedRows.length === 1 ? '' : 's'} to the
                            deliveries table. This can&apos;t be undone.
                        </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                        <AlertDialogCancel disabled={approving}>Cancel</AlertDialogCancel>
                        <AlertDialogAction
                            onClick={(e) => {
                                e.preventDefault()
                                void handleApprove()
                            }}
                            disabled={approving}
                            className="gap-1.5"
                        >
                            {approving ? (
                                <Loader2 className="h-4 w-4 animate-spin mr-1.5" />
                            ) : null}
                            Approve {approvableCount} row{approvableCount === 1 ? '' : 's'}
                        </AlertDialogAction>
                    </AlertDialogFooter>
                </AlertDialogContent>
            </AlertDialog>
        </Card>
    )
}

// ─── Subcomponents ───────────────────────────────────────────────────────

interface SummaryChipProps {
    count: number
    label: string
    tone: 'green' | 'amber'
}

function SummaryChip({ count, label, tone }: SummaryChipProps) {
    const toneClass = {
        green:
            'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 border-emerald-500/30',
        amber:
            'bg-amber-500/10 text-amber-700 dark:text-amber-300 border-amber-500/30',
    }[tone]

    return (
        <span
            className={cn(
                'inline-flex items-center gap-1 rounded-full border px-2 py-0.5',
                'text-[10px] font-medium tabular-nums',
                toneClass
            )}
        >
            <span className="font-mono">{count}</span>
            <span className="uppercase tracking-wide">{label}</span>
        </span>
    )
}
