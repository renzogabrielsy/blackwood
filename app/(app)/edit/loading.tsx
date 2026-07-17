/**
 * EDIT (audit-log detail) — route-level loading skeleton.
 *
 * Also exists to CONTAIN app/(app)/loading.tsx (see settings/loading.tsx).
 * Static pulses only (CLAUDE.md).
 */
export default function EditLoading() {
    return (
        <div className="mx-auto flex w-full max-w-4xl flex-col gap-4 px-4 py-6">
            <div className="h-5 w-56 animate-pulse rounded bg-muted" />
            <div className="h-32 w-full animate-pulse rounded-lg border border-border bg-muted/40" />
            <div className="h-64 w-full animate-pulse rounded-lg border border-border bg-muted/40" />
        </div>
    );
}
