/**
 * HOME (`/`) — route-level loading skeleton.
 *
 * The digest is the app's slowest server render (getDigestData() fans out to the
 * view_digest_* views), so a navigation here used to show a blank frame. This
 * mirrors the band layout of app/(app)/page.tsx — same SHELL_CLS container, same
 * band order — so the skeleton collapses into the real thing without a jump.
 *
 * Static pulses only: no staggered entrance, no per-row animation (CLAUDE.md).
 */
export default function HomeLoading() {
    return (
        <div className="mx-auto flex w-full max-w-7xl flex-col gap-4 px-3 py-4 sm:gap-6 sm:px-6 sm:py-5">
            {/* A. Header strip + sync launcher */}
            <div className="flex flex-wrap items-end justify-between gap-3">
                <div className="flex min-w-0 flex-1 flex-col gap-2">
                    <div className="h-5 w-48 animate-pulse rounded bg-muted" />
                    <div className="h-3 w-64 animate-pulse rounded bg-muted/50" />
                </div>
                <div className="h-8 w-28 animate-pulse rounded-md bg-muted" />
            </div>

            {/* A2. Operational-day band */}
            <div className="h-20 w-full animate-pulse rounded-lg border border-border bg-muted/40" />

            {/* A4. Open blocks — full width (the schedule preview that used to
                share this row with it was retired on 2026-08-28). */}
            <div className="h-56 w-full animate-pulse rounded-lg border border-border bg-muted/40" />

            {/* B. KPI hero — 5 KPIs */}
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
                {Array.from({ length: 5 }).map((_, i) => (
                    <div
                        key={i}
                        className="h-24 animate-pulse rounded-lg border border-border bg-muted/40"
                    />
                ))}
            </div>

            {/* C. Charts */}
            <div className="grid gap-4 lg:grid-cols-2">
                <div className="h-64 animate-pulse rounded-lg border border-border bg-muted/40" />
                <div className="h-64 animate-pulse rounded-lg border border-border bg-muted/40" />
            </div>

            {/* C2/C3. Trucks + bag inventory */}
            <div className="h-32 w-full animate-pulse rounded-lg border border-border bg-muted/40" />
            <div className="h-40 w-full animate-pulse rounded-lg border border-border bg-muted/40" />

            {/* D. Sync band */}
            <div className="flex flex-col gap-3">
                <div className="h-16 w-full animate-pulse rounded-lg border border-border bg-muted/40" />
                <div className="h-48 w-full animate-pulse rounded-lg border border-border bg-muted/40" />
            </div>

            {/* E. Footer band */}
            <div className="h-28 w-full animate-pulse rounded-lg border border-border bg-muted/40" />
        </div>
    );
}
