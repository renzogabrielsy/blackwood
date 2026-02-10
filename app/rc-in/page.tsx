
import { supabase } from '@/lib/supabase';
import Link from 'next/link';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { DeliveryMasterTable, DeliveryHistoryRow } from './delivery-master-table';

import { startOfMonth, endOfMonth, addMonths, subMonths, format, parse, isFuture } from 'date-fns';

export default async function RCInPage({
    searchParams
}: {
    searchParams: Promise<{ view_date?: string; search?: string; field?: string }>;
}) {
    const { view_date: rawViewDate, search, field } = await searchParams;
    const now = new Date();

    // A "Page" is a Month — parse view_date or default to current month
    let currentViewDate = rawViewDate
        ? parse(rawViewDate, 'yyyy-MM', now)
        : startOfMonth(now);

    if (isNaN(currentViewDate.getTime())) {
        currentViewDate = startOfMonth(now);
    }

    const monthLabel = format(currentViewDate, 'MMMM yyyy');

    // Fetch active batches for the input form
    const { data: batches } = await supabase
        .from('batches')
        .select('id, batch_code, location_ref')
        .neq('status', 'CLOSED')
        .order('created_at', { ascending: false });

    // Build deliveries query
    const startDate = startOfMonth(currentViewDate);
    const endDate = endOfMonth(currentViewDate);

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
        query = query
            .gte('transaction_date', format(startDate, 'yyyy-MM-dd'))
            .lte('transaction_date', format(endDate, 'yyyy-MM-dd'));
    }

    const { data: deliveriesRaw, error } = await query;

    if (error) {
        throw new Error(`Failed to fetch deliveries: ${error.message}`);
    }

    const deliveries: DeliveryHistoryRow[] = (deliveriesRaw || []).map((d) => ({
        ...d,
        lab_results: typeof d.lab_results === 'string' ? JSON.parse(d.lab_results) : (d.lab_results || {}),
    }));

    const activeBatches = (batches || []).map(b => ({
        id: b.id,
        batch_code: b.batch_code,
        location_ref: b.location_ref,
    }));

    // Navigation — no future months allowed
    const prevMonthDate = subMonths(currentViewDate, 1);
    const nextMonthDate = addMonths(currentViewDate, 1);
    const isNextDisabled = isFuture(startOfMonth(nextMonthDate));

    const prevLink = `/rc-in?view_date=${format(prevMonthDate, 'yyyy-MM')}`;
    const nextLink = isNextDisabled ? '#' : `/rc-in?view_date=${format(nextMonthDate, 'yyyy-MM')}`;

    return (
        <div className="flex flex-col h-screen overflow-hidden bg-muted/10">
            {/* Header */}
            <div className="flex-none p-4 md:p-6 pb-2">
                <div className="flex flex-row items-center justify-between">
                    <div className="space-y-1">
                        <h2 className="text-2xl font-semibold tracking-tight">Master Log</h2>
                        <p className="text-sm text-muted-foreground">
                            Recent delivery history.
                        </p>
                    </div>
                </div>
            </div>

            {/* Main Content */}
            <div className="flex-1 min-h-0 px-4 md:px-6 pb-4 md:pb-6">
                <Card className="h-full flex flex-col border-none shadow-sm">
                    <CardHeader className="p-0 hidden" />
                    <CardContent className="flex-1 min-h-0 p-2 md:p-4 flex flex-col relative">
                        <DeliveryMasterTable
                            data={deliveries}
                            batches={activeBatches}
                            customFooter={
                                <div className="flex-none flex justify-between items-center p-2 border-t bg-background/30 backdrop-blur-xl backdrop-saturate-150 z-10">
                                    <div className="text-xs text-muted-foreground">
                                        {search ? (
                                            <span>Found <span className="font-semibold text-foreground">{deliveries.length}</span> results for &ldquo;<span className="font-semibold text-foreground">{search}</span>&rdquo;</span>
                                        ) : (
                                            <span>Current View: <span className="font-semibold text-foreground">{monthLabel}</span></span>
                                        )}
                                    </div>

                                    {!search && (
                                        <div className="flex items-center space-x-2">
                                            <Link
                                                href={prevLink}
                                                className="px-3 py-1 text-xs border rounded hover:bg-muted bg-background"
                                            >
                                                &larr; {format(prevMonthDate, 'MMM yyyy')}
                                            </Link>
                                            <Link
                                                href={nextLink}
                                                className={`px-3 py-1 text-xs border rounded hover:bg-muted bg-background ${isNextDisabled ? 'opacity-50 pointer-events-none' : ''}`}
                                                aria-disabled={isNextDisabled}
                                            >
                                                {format(nextMonthDate, 'MMM yyyy')} &rarr;
                                            </Link>
                                        </div>
                                    )}
                                </div>
                            }
                        />
                    </CardContent>
                </Card>
            </div>
        </div>
    );
}
