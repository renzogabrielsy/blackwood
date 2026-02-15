
import { createClient } from '@/lib/supabase/server';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { DeliveryMasterTable, DeliveryHistoryRow } from './delivery-master-table';


import { format } from 'date-fns';

export default async function RCInPage({
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
    let deliveriesRaw: any[] = [];
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

    const { data: userRaw } = await supabase.auth.getUser();
    let role = 'Production';
    if (userRaw?.user) {
        const { data: profile } = await supabase
            .from('profiles')
            .select('role')
            .eq('id', userRaw.user.id)
            .single();
        if (profile?.role) role = profile.role;
    }

    const deliveries: DeliveryHistoryRow[] = (deliveriesRaw || []).map((d) => ({
        ...d,
        state: (d as any).batches?.status || 'STORED',
        lab_results: typeof d.lab_results === 'string' ? JSON.parse(d.lab_results) : (d.lab_results || {}),
        cost_basis: role === 'Production' ? undefined : d.cost_basis,
    }));

    const activeBatches = (batches || []).map(b => ({
        id: b.id,
        batch_code: b.batch_code,
        location_ref: b.location_ref,
    }));

    return (
        <div className="flex flex-col flex-1 min-h-0 overflow-hidden bg-muted/20">
            {/* Main Content */}
            <div className="flex-1 min-h-0 px-4 md:px-6 py-4 md:py-6">
                <Card className="h-full flex flex-col border-none shadow-xl">
                    <CardHeader className="p-0 hidden" />
                    <CardContent className="flex-1 min-h-0 p-2 md:p-4 flex flex-col relative">
                        <DeliveryMasterTable
                            data={deliveries}
                            batches={activeBatches}
                            search={search}
                            allSuppliers={allSuppliers}
                            allLocations={allLocations}
                        />
                    </CardContent>
                </Card>
            </div>
        </div>
    );
}
