import { Suspense } from 'react';
import { createClient } from '@/lib/supabase/server';
import type { DeliveryHistoryRow } from '@/types/rc-in';
import { format } from 'date-fns';
import { InventoryView } from './components/inventory-view';
import { InventoryViewV2 } from './components/inventory-view-v2';
import { LogsShell } from './components/logs-shell';
import { getTableSettings } from '@/lib/actions/table-settings';
import { canViewPrices } from '@/lib/auth';
import { fetchAllRows } from '@/lib/supabase/paginate';
import { GridVersionBar } from '@/components/shared/table';
import { GRID_V2, resolveGrid } from '@/lib/table';

export default async function InventoryPage({
    searchParams
}: {
    // `grid` is the universal-table side-by-side axis (`lib/table/grid-param.ts`) — an
    // axis of the CLIENT, never of the data. It picks which component renders the rows
    // below; it reaches no query, no action and no role gate, and every fetch on this page
    // runs identically either way.
    searchParams: Promise<{ year?: string; search?: string; grid?: string }>;
}) {
    const supabase = await createClient();
    const { year: rawYear, search, grid } = await searchParams;
    const now = new Date();
    const year = rawYear ? parseInt(rawYear, 10) : now.getFullYear();

    // Fetch active batches for the input form
    const { data: batches } = await supabase
        .from('batches')
        .select('id, batch_code, location_ref')
        .neq('status', 'CLOSED')
        .order('created_at', { ascending: false });

    // Build deliveries query for a given page window (filters/ordering reapplied
    // per page). Passed to the shared fetchAllRows pagination helper.
    const buildDeliveriesQuery = (from: number, to: number) => {
        let q = supabase
            .from('deliveries')
            .select('*, batches(location_ref, status)')
            .order('transaction_date', { ascending: false })
            .order('created_at', { ascending: false });

        if (search) {
            const term = `%${search}%`;
            q = q.or(`supplier.ilike.${term},batch_code.ilike.${term},truck_plate.ilike.${term},block_loc.ilike.${term}`);
        } else if (rawYear !== 'all') {
            const startDate = new Date(year, 0, 1);
            const endDate = new Date(year, 11, 31);
            q = q.gte('transaction_date', format(startDate, 'yyyy-MM-dd'))
                 .lte('transaction_date', format(endDate, 'yyyy-MM-dd'));
        }
        return q.range(from, to);
    };

    // Paginated fetch — bypasses PostgREST max_rows (default 1000).
    type DeliveryRaw = NonNullable<Awaited<ReturnType<typeof buildDeliveriesQuery>>['data']>[number];
    const deliveriesRaw = await fetchAllRows<DeliveryRaw>((from, to) => buildDeliveriesQuery(from, to));

    // Fetch ALL distinct suppliers and locations (not scoped by year) for header bar filters
    const [{ data: supRows }, { data: locRows }] = await Promise.all([
        supabase.from('deliveries').select('supplier').not('supplier', 'is', null),
        supabase.from('deliveries').select('block_loc').not('block_loc', 'is', null),
    ]);
    const allSuppliers = [...new Set((supRows || []).map(r => r.supplier).filter(Boolean))].sort() as string[];
    const allLocations = [...new Set((locRows || []).map(r => r.block_loc).filter(Boolean))].sort(
        (a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' })
    ) as string[];

    // CANONICAL price gate — derives the EFFECTIVE role via lib/auth.getUserRole(),
    // so the dev-impersonation cookie is respected (an Owner "viewing as Production"
    // is correctly denied). Replaces the previous inline profiles lookup, which
    // ignored the cookie and leaked cost_basis to impersonating admins.
    const showPrices = await canViewPrices();

    const deliveries: DeliveryHistoryRow[] = (deliveriesRaw || []).map((d) => ({
        ...d,
        state: (d.batches as Record<string, unknown> | null)?.status as string || 'STORED',
        lab_results: typeof d.lab_results === 'string' ? JSON.parse(d.lab_results) : (d.lab_results || {}),
        cost_basis: showPrices ? d.cost_basis : undefined,
    }));

    const activeBatches = (batches || []).map(b => ({
        id: b.id,
        batch_code: b.batch_code,
        location_ref: b.location_ref,
    }));

    const initialSettings = await getTableSettings('rc_in');

    // ONE toggle for BOTH tabs. Deliveries and Usage are two views of the same shell, so
    // two switches would let the screen sit in a half-migrated state nobody asked for.
    //
    // ── This screen's DEFAULT is v2 (2026-08-21) ────────────────────────────────
    // Renzo authorised the flip for RC IN and RC OUT specifically ("I'm satisfied with
    // ICTC Deliveries and Usage table so we can start to make grid v2 as our current
    // table now for those 2"). So `?grid=` absent, misspelt, `V2` or `3` all mean the NEW
    // tables here, and the classic ones are `?grid=v1` — a DEFAULT FLIP, not a cutover:
    // nothing is deleted, the old tables stay fully reachable and fully functional, and
    // they remain where Add/Edit lives until the v2 editing pass lands.
    //
    // Every other screen still on the toggle passes no default and is unchanged.
    const v2 = resolveGrid(grid, GRID_V2) === GRID_V2;
    const gridBar = (
        <GridVersionBar
            defaultVersion={GRID_V2}
            currentLabel="Classic"
            newLabel="Table (new)"
            note="Same rows, same filters — this switches only which table renders them. Adding and editing rows still happens in the Classic table for now."
        />
    );

    return (
        // useSearchParams (inside LogsShell's tab provider) needs a Suspense boundary.
        <Suspense fallback={<div className="h-full w-full" />}>
            <LogsShell>
                {gridBar}
                {v2 ? (
                    <InventoryViewV2
                        deliveries={deliveries}
                        batches={activeBatches}
                        search={search}
                        allSuppliers={allSuppliers}
                        allLocations={allLocations}
                        // The gate is resolved ONCE, server-side, above — the same call
                        // that already stripped `cost_basis` from `deliveries`. Threaded
                        // down rather than re-derived on the client.
                        canViewPrices={showPrices}
                    />
                ) : (
                    <InventoryView
                        deliveries={deliveries}
                        batches={activeBatches}
                        search={search}
                        allSuppliers={allSuppliers}
                        allLocations={allLocations}
                        initialSettings={initialSettings}
                    />
                )}
            </LogsShell>
        </Suspense>
    );
}
