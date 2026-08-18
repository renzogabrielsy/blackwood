'use client';

import { useInventoryTab, type InventoryTab } from './inventory-tab-context';
import { DeliveryGridV2 } from '../rc-in/delivery-grid-v2';
import { RcOutLazyTabV2 } from './rc-out-lazy-tab-v2';
import type { DeliveryHistoryRow } from '@/types/rc-in';

// ─────────────────────────────────────────────────────────────────────────────────
// The `?grid=v2` twin of `inventory-view.tsx` — the same two tabs, hosting the two
// read-only Blackwood Table grids instead of the live tables.
//
// A separate file rather than a flag on the existing one: `inventory-view.tsx` is on the
// production path and this migration does not edit it. It reads the SAME
// `InventoryTabProvider` (the `?tab=` param), so flipping the grid never changes which tab
// you are on and flipping the tab never changes which grid you are in — which is the whole
// point of ONE toggle governing both tabs.
//
// Both panes stay MOUNTED and the inactive one is hidden, exactly as the live view does,
// so the Usage tab's lazily fetched rows survive a switch away and back — unmounting it
// would re-run the fetch every time.
//
// The live view's 150ms cross-fade is deliberately NOT copied. It is driven by a
// `setTransitioning(true)` inside a `useEffect`, which `react-hooks` reports as an error
// (`inventory-view.tsx:26:9` is one of the repo's 28 pre-existing lint errors); copying it
// would have added a 29th. The swap here is instant instead. Nothing else differs.
// ─────────────────────────────────────────────────────────────────────────────────

interface InventoryViewV2Props {
    deliveries: DeliveryHistoryRow[];
    batches: { id: string; batch_code: string; location_ref: string }[];
    search?: string;
    allSuppliers: string[];
    allLocations: string[];
    /**
     * The canonical server-side price gate (`lib/auth.canViewPrices()`), resolved in
     * `page.tsx` — the same call that already stripped `cost_basis` from `deliveries`.
     * Threaded down rather than re-derived, so the render can never disagree with the
     * payload.
     */
    canViewPrices: boolean;
}

export function InventoryViewV2({
    deliveries,
    batches,
    search,
    allSuppliers,
    allLocations,
    canViewPrices,
}: InventoryViewV2Props) {
    const { activeTab } = useInventoryTab();

    const getTabClass = (tabId: InventoryTab) =>
        activeTab === tabId
            ? 'flex flex-col flex-1 min-h-0'
            : 'absolute inset-0 invisible opacity-0 pointer-events-none';

    return (
        <>
            <div className={getTabClass('deliveries')}>
                <DeliveryGridV2
                    data={deliveries}
                    batches={batches}
                    search={search}
                    allSuppliers={allSuppliers}
                    allLocations={allLocations}
                    canViewPrices={canViewPrices}
                />
            </div>
            <div className={getTabClass('usage')}>
                <RcOutLazyTabV2 />
            </div>
        </>
    );
}
