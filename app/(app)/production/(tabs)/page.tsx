// `/production` — the tab index. Inside the `(tabs)` route group (URL-invisible),
// so it still resolves at `/production` but the shell it inherits no longer
// reaches `/production/schedule`.
//
// ── WHICH GRID (`?grid=`) ────────────────────────────────────────────────────────
//
// The universal-table migration builds each screen's new grid BESIDE the existing one and
// picks between them on one query param (`lib/table/grid-param.ts`), so the three
// production sheets can be compared row-for-row on the same real data.
//
// **These three tabs DEFAULT to v2 (2026-08-26).** `?grid=` absent, misspelt, `V2` or `3`
// all mean the NEW tables; the Classic ones are `?grid=v1` — a DEFAULT FLIP, not a
// cutover: nothing is deleted, all three live grids stay mounted, fully reachable and
// fully functional, and the whole rewire still reverts by changing this one default back.
//
// ONE flag governs all three tabs, exactly as it did before the flip. Daily / Electricity
// / Trucks are client tabs of a SINGLE server page, not sibling routes, and the operator
// switches between them with localStorage and no navigation — so a per-tab default would
// be a state the URL cannot express and the toggle above could not honestly describe.
//
// This route being the ONE server page behind all three is also why the flag is read here
// and threaded down as a PROP rather than re-read per view: `useSearchParams()` in each
// view would need its own Suspense boundary on a page that has not opted out of static
// prerendering, and a prop cannot fail that way. The prop is REQUIRED the whole way down
// (`ProductionView` → each `*-lazy-tab.tsx` → each `*-view.tsx`), so the default is stated
// exactly once — here — and no intermediate file can quietly carry a stale second copy of
// it. The bar is mounted once and governs whichever tab is on screen.
//
// The param is an axis of the CLIENT, never of the DATA: both grids read the identical
// rows, which each tab fetches for itself, and nothing here reaches a query, an action or
// a role gate. The PERIOD axis is the module's own Year + Batch picker in `(tabs)/
// layout.tsx` (`?y=` / `?b=`), which is mounted above BOTH sides and is untouched by this.
import { GridVersionBar } from '@/components/shared/table';
import { GRID_V2, resolveGrid } from '@/lib/table';

import { ProductionView } from '../components/production-view';

export default async function ProductionPage({
    searchParams,
}: {
    searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
    const params = await searchParams;
    const v2 = resolveGrid(params.grid, GRID_V2) === GRID_V2;

    const gridBar = (
        <GridVersionBar
            defaultVersion={GRID_V2}
            currentLabel="Classic"
            newLabel="Table (new)"
            // Deliberately says nothing about WHERE editing happens. Both sides of this
            // toggle are moving targets this week, and a note that named one of them would
            // be wrong before the operator read it. What is true either way is that the
            // rows and the period are the same on both sides.
            note="Same rows, same period — this switches only which table renders them."
        />
    );

    return (
        <>
            {gridBar}
            <ProductionView v2={v2} />
        </>
    );
}
