/**
 * PRICE DEMOS — route-level loading skeleton.
 *
 * Also exists to CONTAIN app/(app)/loading.tsx (see settings/loading.tsx).
 * Covers /price-demos and its demo1–demo4 children. Static pulses only (CLAUDE.md).
 */
export default function PriceDemosLoading() {
    return (
        <div className="flex w-full flex-col gap-4 p-4 lg:p-6">
            <div className="h-5 w-40 animate-pulse rounded bg-muted" />
            <div className="h-64 w-full animate-pulse rounded-lg border border-border bg-muted/40" />
            <div className="h-64 w-full animate-pulse rounded-lg border border-border bg-muted/40" />
        </div>
    );
}
