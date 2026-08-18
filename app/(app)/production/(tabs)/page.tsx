// `/production` — the tab index. Inside the `(tabs)` route group (URL-invisible),
// so it still resolves at `/production` but the shell it inherits no longer
// reaches `/production/schedule`.
//
// ── WHICH GRID (`?grid=v2`) ──────────────────────────────────────────────────────
//
// The universal-table migration builds each screen's new grid BESIDE the existing one and
// picks between them on one query param (`lib/table/grid-param.ts`), so the three
// production sheets can be compared row-for-row on the same real data and the rewire can
// be reverted by deleting three files. The live grids are not edited at all.
//
// This route is the ONE server page behind all three tabs — Daily / Electricity / Trucks
// are client tabs of a single page, not sibling routes — so the flag is read once here and
// threaded down as a prop. `useSearchParams()` in each view would need its own Suspense
// boundary on a page that has not opted out of static prerendering; a prop cannot fail
// that way. The bar is mounted once and governs whichever tab is on screen.
//
// The param is an axis of the CLIENT, never of the DATA: both grids read the identical
// rows, which each tab fetches for itself, and nothing here reaches a query, an action or
// a role gate. `?grid=` absent, misspelt, or `V2` all mean the CURRENT grid.
import { GridVersionBar } from '@/components/shared/table';
import { GRID_V2, parseGrid } from '@/lib/table';

import { ProductionView } from '../components/production-view';

export default async function ProductionPage({
    searchParams,
}: {
    searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
    const params = await searchParams;
    const v2 = parseGrid(params.grid) === GRID_V2;

    const gridBar = (
        <GridVersionBar note="Same rows, same filters — this switches only which table renders them." />
    );

    return (
        <>
            {gridBar}
            <ProductionView v2={v2} />
        </>
    );
}
