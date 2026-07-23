// Route-level skeleton for /shipments — matches the list page shell so it
// collapses into the real content without a jump. Static pulses only (no stagger,
// no row animation — CLAUDE.md). Sibling routes under (app) inherit the digest
// skeleton unless they ship their own loading.tsx; this is ours.
export default function ShipmentsLoading() {
  return (
    <div className="flex-1 min-h-0 overflow-y-auto">
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-4 px-3 py-4 sm:px-6 sm:py-6">
        <div className="flex items-center gap-2">
          <div className="h-6 w-40 animate-pulse rounded-full bg-muted" />
          <div className="h-4 w-56 animate-pulse rounded bg-muted/60" />
        </div>
        <div className="flex flex-col gap-2.5">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="rounded-lg border border-border bg-card p-4">
              <div className="flex items-start justify-between gap-3">
                <div className="flex flex-col gap-2">
                  <div className="h-4 w-64 animate-pulse rounded bg-muted" />
                  <div className="h-3 w-80 animate-pulse rounded bg-muted/50" />
                </div>
                <div className="flex flex-col items-end gap-2">
                  <div className="h-5 w-16 animate-pulse rounded-full bg-muted" />
                  <div className="h-3 w-24 animate-pulse rounded bg-muted/50" />
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
