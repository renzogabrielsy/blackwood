
import { supabase } from '@/lib/supabase';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { BulkDeliveryInput } from './bulk-delivery-input';
import { DeliveryMasterTable, DeliveryHistoryRow } from './delivery-master-table';

export default async function RCInPage() {
    // 1. Fetch Batches (No UUID link required by Prompt, but for selector we need a list)
    const { data: batches } = await supabase
        .from('batches')
        .select('id, batch_code, location_ref') // Still useful to show location ref
        .neq('status', 'CLOSED')
        .order('created_at', { ascending: false });

    // 2. Fetch Recent Deliveries for Master Log
    const { data: deliveriesRaw, error } = await supabase
        .from('deliveries')
        .select('*')
        .order('transaction_date', { ascending: false }) // Order by Transaction Date, then Created
        .order('created_at', { ascending: false })
        .limit(100);

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
                <CardHeader>
                    <CardTitle>Master Log</CardTitle>
                    <CardDescription>Recent delivery history.</CardDescription>
                </CardHeader>
                <CardContent>
                    <DeliveryMasterTable data={deliveries} />
                </CardContent>
            </Card>
        </div>
    );
}