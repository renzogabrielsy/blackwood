// No 'use client' — async Server Component. Fetches FLECON bag inventory data
// and hands it to the client view. The navbar owns the page title/description,
// so no header is rendered here (project rule). Thin by design — the view owns
// the container and all interactivity.
import { GridVersionBar } from '@/components/shared/table';
import { GRID_V2, parseGrid } from '@/lib/table';
import { fetchFleconBagData } from './actions';
import { FleconBagsView } from './components/flecon-bags-view';
import { FleconBagsGridV2 } from './components/flecon-bags-grid-v2';

export default async function FleconBagsPage({
    searchParams,
}: {
    // `grid` is the universal-table side-by-side axis (`lib/table/grid-param.ts`) — an
    // axis of the CLIENT, never of the data. It picks which component renders the rows
    // below; it reaches no query, no action and no role gate, and the fetch above runs
    // identically either way. `?grid=` absent, misspelt or `V2` all mean the live matrix.
    searchParams: Promise<{ grid?: string }>;
}) {
    const { grid } = await searchParams;
    const { balances, movements, error } = await fetchFleconBagData();

    const v2 = parseGrid(grid) === GRID_V2;
    const gridBar = (
        <GridVersionBar note="Same rows, same balances — this switches only which table renders them." />
    );

    return (
        // A flex column, not a bare fragment: the inventory layout's content area is a
        // plain block and both matrices are `h-full`, so without a column here the bar's
        // height would push the sheet past the bottom of the (overflow-hidden) shell.
        // This is also what makes `GridVersionBar`'s own `shrink-0` mean something.
        <div className="flex h-full min-h-0 flex-col">
            {gridBar}
            <div className="min-h-0 flex-1 pt-3">
                {v2 ? (
                    <FleconBagsGridV2
                        balances={balances}
                        movements={movements}
                        error={error}
                    />
                ) : (
                    <FleconBagsView
                        balances={balances}
                        movements={movements}
                        error={error}
                    />
                )}
            </div>
        </div>
    );
}
