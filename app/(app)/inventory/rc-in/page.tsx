
import { createClient } from '@/lib/supabase/server';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { DeliveryMasterTable, DeliveryHistoryRow } from './delivery-master-table';


import { startOfMonth, endOfMonth, format } from 'date-fns';

export default async function RCInPage({
    searchParams
}: {
    searchParams: Promise<{ year?: string; search?: string; field?: string }>;
}) {
    const supabase = await createClient();
    const { year: rawYear, search, field } = await searchParams;
    const now = new Date();

    const year = rawYear ? parseInt(rawYear, 10) : now.getFullYear();

    // Fetch active batches for the input form
    const { data: batches } = await supabase
        .from('batches')
        .select('id, batch_code, location_ref')
        .neq('status', 'CLOSED')
        .order('created_at', { ascending: false });

    // Build deliveries query
    let query = supabase
        .from('deliveries')
        .select('*, batches(location_ref)')
        .order('transaction_date', { ascending: false })
        .order('created_at', { ascending: false });

    if (search) {
        const term = `%${search}%`;
        const searchField = field || 'all';

        if (searchField === 'all') {
            query = query.or(`supplier.ilike.${term},batch_code.ilike.${term},truck_plate.ilike.${term},block_loc.ilike.${term}`);
        } else if (searchField === 'supplier') {
            query = query.ilike('supplier', term);
        } else if (searchField === 'batch_code') {
            query = query.ilike('batch_code', term);
        } else if (searchField === 'truck_plate') {
            query = query.ilike('truck_plate', term);
        } else if (searchField === 'whse') {
            query = query.or(`block_loc.ilike.${term},batch_code.ilike.${term}`);
        }
    } else {
        // Fetch full year or all years
        if (rawYear !== 'all') {
            const startDate = new Date(year, 0, 1);
            const endDate = new Date(year, 11, 31);

            query = query
                .gte('transaction_date', format(startDate, 'yyyy-MM-dd'))
                .lte('transaction_date', format(endDate, 'yyyy-MM-dd'));
        }
    }

    const { data: deliveriesRaw, error } = await query;

    if (error) {
        throw new Error(`Failed to fetch deliveries: ${error.message}`);
    }

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
                        />
                    </CardContent>
                </Card>
            </div>
        </div>
    );
}
