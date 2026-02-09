
import { supabase } from '@/lib/supabase';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { BulkDeliveryInput } from './bulk-delivery-input';
import { DeliveryMasterTable, DeliveryHistoryRow } from './delivery-master-table';

export default async function RCInPage({
    searchParams
}: {
    searchParams: { range?: string };
}) {
    const range = searchParams.range || 'this_month';

    // 1. Fetch Batches (No UUID link required by Prompt, but for selector we need a list)
    const { data: batches } = await supabase
        .from('batches')
        .select('id, batch_code, location_ref') // Still useful to show location ref
        .neq('status', 'CLOSED')
        .order('created_at', { ascending: false });

    // 2. Build Query with Date Filter Logic
    let query = supabase
        .from('deliveries')
        .select('*, batches(location_ref)')
        .order('transaction_date', { ascending: false }) // Order by Transaction Date, then Created
        .order('created_at', { ascending: false });

    if (range !== 'all') {
        const now = new Date();
        let startDate = new Date();

        if (range === 'this_month') {
            startDate = new Date(now.getFullYear(), now.getMonth(), 1);
        } else if (range === 'this_quarter') {
            const quarter = Math.floor(now.getMonth() / 3);
            startDate = new Date(now.getFullYear(), quarter * 3, 1);
        } else if (range === 'last_6_months') {
            startDate = new Date(now.getFullYear(), now.getMonth() - 6, now.getDate());
        } else if (range === 'this_year') {
            startDate = new Date(now.getFullYear(), 0, 1);
        }

        query = query.gte('transaction_date', startDate.toISOString().split('T')[0]);
    }

    const { data: deliveriesRaw, error } = await query.limit(100);

    if (error) {
        console.error('Error fetching deliveries:', error);
    }

    // Cast and Parse Data
    const deliveries: DeliveryHistoryRow[] = (deliveriesRaw || []).map((d) => ({
        ...d,
        // Ensure lab_results is parsed if it came as string (though pg returns object usually)
        lab_results: typeof d.lab_results === 'string' ? JSON.parse(d.lab_results) : (d.lab_results || {}),
    }));

    const activeBatches = (batches || []).map(b => ({
        id: b.id,
        batch_code: b.batch_code,
        location_ref: b.location_ref,
    }));

    const filters = [
        { label: 'All', value: 'all' },
        { label: 'This Month', value: 'this_month' },
        { label: 'This Quarter', value: 'this_quarter' },
        { label: 'Last 6 Months', value: 'last_6_months' },
        { label: 'This Year', value: 'this_year' },
    ];

    return (
        <div className="container mx-auto py-6 space-y-8">
            {/* Top Section: Dynamic Bulk Input */}
            <Card>
                <CardHeader>
                    <CardTitle>Delivery Entry (Bulk)</CardTitle>
                    <CardDescription>Enter multiple deliveries and submit.</CardDescription>
                </CardHeader>
                <CardContent>
                    <BulkDeliveryInput batches={activeBatches} />
                </CardContent>
            </Card>

            {/* Bottom Section: Master Log */}
            <Card>
                <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                    <div className="space-y-1">
                        <CardTitle>Master Log</CardTitle>
                        <CardDescription>Recent delivery history.</CardDescription>
                    </div>
                    <div className="flex bg-muted p-1 rounded-md text-[10px]">
                        {filters.map((f) => (
                            <a
                                key={f.value}
                                href={`/rc-in?range=${f.value}`}
                                className={`px-3 py-1 rounded-sm transition-colors ${range === f.value
                                        ? 'bg-background text-foreground shadow-sm'
                                        : 'text-muted-foreground hover:text-foreground'
                                    }`}
                            >
                                {f.label}
                            </a>
                        ))}
                    </div>
                </CardHeader>
                <CardContent>
                    <DeliveryMasterTable data={deliveries} />
                </CardContent>
            </Card>
        </div>
    );
}