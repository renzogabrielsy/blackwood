'use client'

import * as React from 'react'
import { useRouter } from 'next/navigation'
import { Copy, Inbox } from 'lucide-react'
import { toast } from 'sonner'

import { errorToast } from '@/lib/toast'
import { Card } from '@/components/ui/card'
import { cn } from '@/lib/utils'

import { UploadXlsxForm } from './UploadXlsxForm'
import { PendingReviewList } from './PendingReviewList'
import { ReviewDetailPanel } from './ReviewDetailPanel'

import type { PendingReviewSummary } from '@/app/(app)/review-queue/actions'

interface ReviewQueueClientProps {
    initial: PendingReviewSummary[]
    initialError: string | null
}

export function ReviewQueueClient({ initial, initialError }: ReviewQueueClientProps) {
    const router = useRouter()
    const [activeId, setActiveId] = React.useState<string | null>(null)
    const [refreshKey, setRefreshKey] = React.useState(0)

    // Surface the server-side error from `listPending()` once, on mount.
    React.useEffect(() => {
        if (initialError) {
            errorToast('Failed to load pending reviews', {
                description: initialError,
            })
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [])

    // Force the active panel to refetch and the server list to revalidate.
    const refresh = React.useCallback(() => {
        setRefreshKey((k) => k + 1)
        router.refresh()
    }, [router])

    const handleUploaded = React.useCallback(
        (summary: { newCount: number; changedCount: number; noopCount: number }) => {
            const total = summary.newCount + summary.changedCount + summary.noopCount
            toast.success(
                `Processed ${total} rows · ${summary.newCount} new · ${summary.changedCount} changed · ${summary.noopCount} unchanged`,
                { duration: 4000 }
            )
            refresh()
        },
        [refresh]
    )

    const handleDecided = React.useCallback(() => {
        setActiveId(null)
        refresh()
    }, [refresh])

    return (
        <div className="flex-1 min-h-0 px-4 md:px-6 py-4 md:py-6 overflow-auto">
            <div className="mx-auto w-full max-w-[1400px] space-y-4">
                {/* Inline error banner — persistent + copy, per HARD RULE */}
                {initialError && (
                    <Card className="border-destructive/40 bg-destructive/5 px-4 py-3">
                        <div className="flex items-start justify-between gap-3 text-xs">
                            <div className="space-y-1 min-w-0">
                                <p className="font-medium text-destructive">
                                    Failed to load pending reviews
                                </p>
                                <p className="text-muted-foreground break-words">
                                    {initialError}
                                </p>
                            </div>
                            <button
                                type="button"
                                className="inline-flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground transition-colors shrink-0"
                                onClick={() => {
                                    void navigator.clipboard
                                        .writeText(initialError)
                                        .then(() => {
                                            toast.success('Error copied', { duration: 2000 })
                                        })
                                }}
                            >
                                <Copy className="h-3 w-3" /> Copy
                            </button>
                        </div>
                    </Card>
                )}

                {/* Upload control — always visible at the top */}
                <UploadXlsxForm onUploaded={handleUploaded} />

                {/* Detail panel replaces the list when something is selected */}
                {activeId ? (
                    <ReviewDetailPanel
                        key={`${activeId}:${refreshKey}`}
                        id={activeId}
                        onBack={() => setActiveId(null)}
                        onDecided={handleDecided}
                    />
                ) : initial.length === 0 ? (
                    <EmptyState />
                ) : (
                    <PendingReviewList entries={initial} onSelect={setActiveId} />
                )}
            </div>
        </div>
    )
}

function EmptyState() {
    return (
        <Card
            className={cn(
                'flex flex-col items-center justify-center text-center py-16 px-6',
                'animate-fade-up'
            )}
        >
            <div className="mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-muted text-muted-foreground">
                <Inbox className="h-6 w-6" />
            </div>
            <p className="text-sm font-medium text-foreground">No reviews pending</p>
            <p className="mt-1 text-xs text-muted-foreground max-w-[320px]">
                Upload an XLSX file above to extract rows and queue them for approval.
            </p>
        </Card>
    )
}
