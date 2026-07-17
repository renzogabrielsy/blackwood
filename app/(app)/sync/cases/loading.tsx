/**
 * SYNC REVIEW (`/sync/cases`) — route-level loading skeleton.
 *
 * Mirrors CasesClient: a filter/run toolbar over a list of case cards.
 * Static pulses only — no staggered entrance on the card list (CLAUDE.md).
 */
export default function SyncCasesLoading() {
    return (
        <div className="flex min-h-0 flex-1 flex-col bg-muted/10">
            {/* Toolbar */}
            <div className="flex flex-none items-center gap-2 border-b bg-background px-4 py-2">
                <div className="h-6 w-40 animate-pulse rounded bg-muted" />
                <div className="flex-1" />
                <div className="h-6 w-24 animate-pulse rounded bg-muted/50" />
                <div className="h-6 w-24 animate-pulse rounded bg-muted/50" />
            </div>

            {/* Case cards */}
            <div className="flex flex-col gap-3 p-4">
                {Array.from({ length: 6 }).map((_, i) => (
                    <div
                        key={i}
                        className="flex flex-col gap-2 rounded-lg border border-border bg-card p-3"
                    >
                        <div className="flex items-center gap-2">
                            <div className="h-4 w-20 animate-pulse rounded bg-muted" />
                            <div className="h-4 w-32 animate-pulse rounded bg-muted/50" />
                            <div className="flex-1" />
                            <div className="h-4 w-16 animate-pulse rounded bg-muted/50" />
                        </div>
                        <div className="h-3 w-3/4 animate-pulse rounded bg-muted/40" />
                        <div className="h-3 w-1/2 animate-pulse rounded bg-muted/40" />
                    </div>
                ))}
            </div>
        </div>
    );
}
