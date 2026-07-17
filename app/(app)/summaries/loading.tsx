/**
 * SUMMARIES — route-level loading skeleton.
 *
 * Mirrors summaries-client.tsx: a right-aligned view-toggle strip over the
 * analyst brief (year rail + a monthly table). Static pulses only (CLAUDE.md).
 */
export default function SummariesLoading() {
    return (
        <div className="flex w-full flex-col">
            {/* Header strip — toggle pinned right (navbar owns the title) */}
            <div className="flex items-center justify-end border-b border-border bg-background px-5 py-2 lg:px-6">
                <div className="h-7 w-44 animate-pulse rounded-md bg-muted" />
            </div>

            <div className="flex flex-col gap-4 p-4 lg:p-6">
                {/* Year rail */}
                <div className="flex items-center gap-2">
                    {Array.from({ length: 4 }).map((_, i) => (
                        <div key={i} className="h-6 w-16 animate-pulse rounded bg-muted" />
                    ))}
                </div>

                {/* Totals strip */}
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                    {Array.from({ length: 4 }).map((_, i) => (
                        <div
                            key={i}
                            className="h-20 animate-pulse rounded-lg border border-border bg-muted/40"
                        />
                    ))}
                </div>

                {/* Monthly table */}
                <div className="overflow-hidden rounded-lg border border-border bg-card">
                    <div className="flex h-8 items-center gap-2 border-b bg-muted/50 px-2">
                        {Array.from({ length: 8 }).map((_, i) => (
                            <div key={i} className="h-3 flex-1 animate-pulse rounded bg-muted" />
                        ))}
                    </div>
                    {Array.from({ length: 12 }).map((_, i) => (
                        <div key={i} className="flex h-8 items-center gap-2 border-b px-2">
                            {Array.from({ length: 8 }).map((_, j) => (
                                <div
                                    key={j}
                                    className="h-3 flex-1 animate-pulse rounded bg-muted/40"
                                />
                            ))}
                        </div>
                    ))}
                </div>
            </div>
        </div>
    );
}
