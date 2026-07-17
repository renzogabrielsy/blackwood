/**
 * SETTINGS — route-level loading skeleton.
 *
 * Also exists to CONTAIN app/(app)/loading.tsx: without a loading file here this
 * segment would inherit the group-level digest skeleton, which is the wrong shape.
 * Static pulses only (CLAUDE.md).
 */
export default function SettingsLoading() {
    return (
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 px-4 py-6">
            <div className="h-5 w-40 animate-pulse rounded bg-muted" />
            {Array.from({ length: 4 }).map((_, i) => (
                <div
                    key={i}
                    className="h-28 animate-pulse rounded-lg border border-border bg-muted/40"
                />
            ))}
        </div>
    );
}
