import { Suspense } from 'react';
import { createClient } from '@/lib/supabase/server';
import type { DeliveryHistoryRow } from '@/types/rc-in';
import { format } from 'date-fns';
import { InventoryView } from './components/inventory-view';
import { LogsShell } from './components/logs-shell';
import { getTableSettings } from './rc-in/actions';
import { canViewPrices } from '@/lib/auth';

export default async function InventoryPage({
    searchParams
}: {
    searchParams: Promise<{ year?: string; search?: string }>;
}) {
    const supabase = await createClient();
    const { year: rawYear, search } = await searchParams;
    const now = new Date();
    const year = rawYear ? parseInt(rawYear, 10) : now.getFullYear();

    // Fetch active batches for the input form
    const { data: batches } = await supabase
        .from('batches')
        .select('id, batch_code, location_ref')
        .neq('status', 'CLOSED')
        .order('created_at', { ascending: false });

    // Build deliveries query (reusable for paginated fetch)
    const buildDeliveriesQuery = () => {
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
        return q;
    };

    // Paginated fetch — bypasses PostgREST max_rows (default 1000)
    const PAGE_SIZE = 1000;
    let deliveriesRaw: Awaited<ReturnType<ReturnType<typeof buildDeliveriesQuery>['range']>>['data'] = [];
    let from = 0;
    let hasMore = true;
    while (hasMore) {
        const { data, error } = await buildDeliveriesQuery().range(from, from + PAGE_SIZE - 1);
        if (error) throw new Error(`Failed to fetch deliveries: ${error.message}`);
        deliveriesRaw = deliveriesRaw.concat(data || []);
        hasMore = (data?.length || 0) === PAGE_SIZE;
        from += PAGE_SIZE;
    }

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

    return (
        // useSearchParams (inside LogsShell's tab provider) needs a Suspense boundary.
        <Suspense fallback={<div className="h-full w-full" />}>
            <LogsShell>
                <InventoryView
                    deliveries={deliveries}
                    batches={activeBatches}
                    search={search}
                    allSuppliers={allSuppliers}
                    allLocations={allLocations}
                    initialSettings={initialSettings}
                />
            </LogsShell>
        </Suspense>
    );
}
