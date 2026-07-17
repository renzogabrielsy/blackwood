/**
 * NOTIFICATIONS — route-level loading skeleton.
 *
 * Also exists to CONTAIN app/(app)/loading.tsx (see settings/loading.tsx).
 * Static pulses only — no staggered entrance on the feed (CLAUDE.md).
 */
export default function NotificationsLoading() {
    return (
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-3 px-4 py-6">
            <div className="h-5 w-36 animate-pulse rounded bg-muted" />
            {Array.from({ length: 8 }).map((_, i) => (
                <div
                    key={i}
                    className="flex items-center gap-3 rounded-lg border border-border bg-card p-3"
                >
                    <div className="h-8 w-8 shrink-0 animate-pulse rounded-full bg-muted" />
                    <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                        <div className="h-3 w-1/3 animate-pulse rounded bg-muted" />
                        <div className="h-3 w-2/3 animate-pulse rounded bg-muted/40" />
                    </div>
                </div>
            ))}
        </div>
    );
}
