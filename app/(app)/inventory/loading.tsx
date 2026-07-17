/**
 * INVENTORY — route-level loading skeleton.
 *
 * Covers `/inventory` (the logs shell) and, by inheritance, its child routes that
 * have no loading.tsx of their own (`/inventory/blocking`, `/inventory/rc-movement`,
 * `/inventory/flecon-bags`) — all of which are dense grid surfaces, so one
 * toolbar + header + rows skeleton fits them all. Follows the
 * app/(app)/production/loading.tsx idiom.
 *
 * Static pulses only — no per-row entrance animation (CLAUDE.md).
 */
export default function InventoryLoading() {
    return (
        <div className="flex flex-1 flex-col min-h-0 overflow-hidden bg-muted/10">
            <div className="flex-1 min-h-0 px-4 py-4 md:px-6 md:py-6">
                <div className="flex h-full flex-col overflow-hidden rounded-lg border-none bg-card shadow-xl">
                    {/* Tab bar skeleton */}
                    <div className="flex flex-none items-center gap-2 border-b px-3 py-2">
                        <div className="h-6 w-24 animate-pulse rounded bg-muted" />
                        <div className="h-6 w-24 animate-pulse rounded bg-muted/50" />
                        <div className="flex-1" />
                        <div className="h-6 w-32 animate-pulse rounded bg-muted" />
                        <div className="h-6 w-16 animate-pulse rounded bg-muted" />
                    </div>
                    {/* Header row skeleton */}
                    <div className="flex h-8 items-center gap-2 border-b bg-muted/50 px-2">
                        {Array.from({ length: 12 }).map((_, i) => (
                            <div key={i} className="h-3 flex-1 animate-pulse rounded bg-muted" />
                        ))}
                    </div>
                    {/* Row skeletons */}
                    {Array.from({ length: 14 }).map((_, i) => (
                        <div key={i} className="flex h-8 items-center gap-2 border-b px-2">
                            {Array.from({ length: 12 }).map((_, j) => (
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
