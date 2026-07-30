export default function ProductionLoading() {
    return (
        <div className="flex flex-col flex-1 min-h-0 overflow-hidden bg-muted/10">
            <div className="flex-1 min-h-0 px-4 md:px-6 py-4 md:py-6">
                <div className="h-full flex flex-col border-none shadow-xl rounded-lg bg-card overflow-hidden">
                    {/* Toolbar skeleton */}
                    <div className="flex-none flex items-center gap-2 px-3 py-2 border-b">
                        <div className="h-6 w-24 bg-muted animate-pulse rounded" />
                        <div className="flex-1" />
                        <div className="h-6 w-16 bg-muted animate-pulse rounded" />
                        <div className="h-6 w-16 bg-muted animate-pulse rounded" />
                    </div>
                    {/* Header skeleton */}
                    <div className="h-8 bg-muted/50 border-b flex items-center gap-2 px-2">
                        {Array.from({ length: 8 }).map((_, i) => (
                            <div key={i} className="h-3 bg-muted animate-pulse rounded flex-1" />
                        ))}
                    </div>
                    {/* Row skeletons */}
                    {Array.from({ length: 12 }).map((_, i) => (
                        <div key={i} className="h-8 border-b flex items-center gap-2 px-2">
                            {Array.from({ length: 8 }).map((_, j) => (
                                <div key={j} className="h-3 bg-muted/40 animate-pulse rounded flex-1" />
                            ))}
                        </div>
                    ))}
                </div>
            </div>
        </div>
    );
}
