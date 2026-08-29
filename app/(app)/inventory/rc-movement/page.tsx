import { Suspense } from 'react';
import { Loader2 } from 'lucide-react';
import { GridVersionBar } from '@/components/shared/table';
import { GRID_V2, resolveGrid } from '@/lib/table';
import { RcMovementRouteView } from './rc-movement-route-view';
import { RcMovementGridV2 } from './rc-movement-grid-v2';
import { fetchRcMovementMatrix } from './actions';

/**
 * Standalone RC Movement route (`/inventory/rc-movement`). Renders the campaign-scoped
 * day×block feed matrix. Campaign lives in `?campaign=`; both grids own their own picker.
 * No tab shell — see inventory/layout.tsx + components/logs-shell.tsx.
 *
 * ── THIS SCREEN'S DEFAULT IS v2 (2026-08-29) ────────────────────────────────────
 * `?grid=` absent, misspelt, `V2` or `3` all mean the **Blackwood Table**; the Classic
 * matrix is `?grid=v1`. A DEFAULT FLIP, not a cutover: `rc-movement-matrix.tsx` and
 * `rc-movement-route-view.tsx` are not edited by one character, stay mounted, and stay
 * fully functional — which matters here more than on most screens, because two surfaces
 * still live only in the Classic matrix (the open-blocks dialog behind the coverage badge,
 * and the Radix hover info card per footer column). See this folder's CONTEXT.md.
 *
 * `?grid=` is an axis of the CLIENT, never of the data (`lib/table/grid-param.ts`). Both
 * branches read the SAME payload from the SAME read action, with the same server-side
 * price gate inside it; the param reaches no query, no mutation and no role gate.
 *
 * The two branches differ in WHERE that payload is fetched, and only because the Classic
 * host may not be touched: `RcMovementRouteView` fetches it on the client (its own
 * `useEffect` + `?campaign=` handling, unchanged), while the v2 branch is fetched HERE and
 * handed down as a prop — so no line of the Classic host is edited and the v2 grid needs
 * no client fetch, no spinner state and no second copy of the campaign-resolution logic.
 */
export default async function RcMovementPage({
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
            note="Same campaign, same rows — this switches only which table renders them; the open-blocks dialog behind the coverage badge is still Classic-only."
        />
    );

    // A flex column, not a bare fragment: the inventory layout's content area is a plain
    // block and both matrices are full-height, so without a column here the bar's height
    // would push the sheet past the bottom of the (overflow-hidden) shell. It is also
    // what makes `GridVersionBar`'s own `shrink-0` mean something.
    if (v2) {
        const campaign = Array.isArray(params.campaign) ? params.campaign[0] : params.campaign;
        const data = await fetchRcMovementMatrix(campaign || undefined);
        return (
            <div className="flex h-full min-h-0 flex-col">
                {gridBar}
                <div className="min-h-0 flex-1 pt-3">
                    <RcMovementGridV2 data={data} searchParams={params} />
                </div>
            </div>
        );
    }

    return (
        <div className="flex h-full min-h-0 flex-col">
            {gridBar}
            <div className="min-h-0 flex-1 pt-3">
                <Suspense
                    fallback={
                        <div className="flex h-full w-full items-center justify-center">
                            <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
                        </div>
                    }
                >
                    <RcMovementRouteView />
                </Suspense>
            </div>
        </div>
    );
}
