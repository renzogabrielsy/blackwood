
import { supabase } from '@/lib/supabase';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { BulkDeliveryInput } from './bulk-delivery-input';
import { DeliveryMasterTable, DeliveryHistoryRow } from './delivery-master-table';

import { startOfMonth, endOfMonth, addMonths, subMonths, format, parse, isFuture, startOfQuarter } from 'date-fns';

export default async function RCInPage({
    searchParams
}: {
    searchParams: Promise<{ range?: string; view_date?: string }>;
}) {
    const { range: rawRange, view_date: rawViewDate } = await searchParams;
    const range = rawRange || 'this_month';
    const now = new Date();

    // 1. Determine Current View Date
    let currentViewDate: Date;

    if (rawViewDate) {
        // User is navigating specific months
        currentViewDate = parse(rawViewDate, 'yyyy-MM', now);
    } else {
        // Default logic based on range if no specific view_date provided
        if (range === 'this_quarter') {
            currentViewDate = startOfQuarter(now);
        } else if (range === 'last_6_months') {
            currentViewDate = subMonths(now, 6); // Or whatever "start" means here, but usually page=month
        } else if (range === 'this_year') {
            currentViewDate = new Date(now.getFullYear(), 0, 1);
        } else {
            // Default to this month
            currentViewDate = startOfMonth(now);
        }
    }

    // Ensure valid date, fallback to now
    if (isNaN(currentViewDate.getTime())) {
        currentViewDate = startOfMonth(now);
    }

    const viewDateStr = format(currentViewDate, 'yyyy-MM');
    const monthLabel = format(currentViewDate, 'MMMM yyyy');

    // 2. Fetch Batches
    const { data: batches } = await supabase
        .from('batches')
        .select('id, batch_code, location_ref')
        .neq('status', 'CLOSED')
        .order('created_at', { ascending: false });

    // 3. Build Query with Strict Month Filter
    // "A Page is a Month" -> Get full month range
    const startDate = startOfMonth(currentViewDate);
    const endDate = endOfMonth(currentViewDate);

    // If 'all' or specific ranges, logic might differ?
    // Prompt says: "Query: .gte(start).lte(end)... NO .limit()"
    // Exception: "All" -> "Sets view_date to current month. 'Previous' button goes back in time (forever)."
    // This implies "All" just resets user to 'current month' view, but allows infinite scrolling back?
    // Actually, "All" usually implies NO DATE FILTER.
    // BUT prompt says: "[All]: Sets view_date to current month."
    // Let's stick to the prompt's "Strict Rule": "A 'Page' is a Month".
    // So even for 'all', we show *a month* at a time?
    // Re-reading: "The Core Concept (Strict Rule): A 'Page' is a Month."
    // So YES, we always filter by month.

    let query = supabase
        .from('deliveries')
        .select('*, batches(location_ref)')
        .order('transaction_date', { ascending: false })
        .order('created_at', { ascending: false })
        .gte('transaction_date', startDate.toISOString())
        .lte('transaction_date', endDate.toISOString());
    // Using ISO string for full timestamp comparison. 
    // endOfMonth returns X-X-X 23:59:59.999 local time. toISOString converts to UTC.
    // This is generally correct for timestamptz comparisons.

    const { data: deliveriesRaw, error } = await query; // LIMIT REMOVED

    if (error) {
        console.error('Error fetching deliveries:', error);
    }

    // Cast and Parse Data
    const deliveries: DeliveryHistoryRow[] = (deliveriesRaw || []).map((d) => ({
        ...d,
        lab_results: typeof d.lab_results === 'string' ? JSON.parse(d.lab_results) : (d.lab_results || {}),
    }));

    const activeBatches = (batches || []).map(b => ({
        id: b.id,
        batch_code: b.batch_code,
        location_ref: b.location_ref,
    }));

    // Navigation Logic
    const prevMonthDate = subMonths(currentViewDate, 1);
    const nextMonthDate = addMonths(currentViewDate, 1);

    const prevLink = `/rc-in?range=${range}&view_date=${format(prevMonthDate, 'yyyy-MM')}`;
    const nextLink = `/rc-in?range=${range}&view_date=${format(nextMonthDate, 'yyyy-MM')}`;

    // Disable Next if:
    // 1. Strict mode (range=this_month) AND next month is future?
    // Prompt: "If range=this_year and we are at Dec, disable 'Next'".
    // Let's simplified strictness: if next month > now, disable (unless 'future' allowed?).
    // Usually we don't have future data.
    const isNextDisabled = isFuture(nextMonthDate) && range !== 'all';
    // Or if specifically restricted by range type?
    // "If range=this_year and we are at Dec" -> Dec 2026? 
    // Let's just disable if it's strictly in the future for now.

    // Filter Presets
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
                <CardHeader className="pb-2">
                    <div className="flex flex-row items-center justify-between">
                        <div className="space-y-1">
                            <CardTitle>Master Log</CardTitle>
                            <CardDescription>
                                Recent delivery history.
                            </CardDescription>
                        </div>
                    </div>

                    <div className="flex bg-muted p-1 rounded-md text-[10px] w-fit">
                        {filters.map((f) => {
                            // Logic: The filter button resets view_date to 'default' for that range
                            // We do NOT pass view_date here, allowing the default logic (lines 20-30) 
                            // to pick the correct starting month for that range.
                            const isActive = range === f.value;
                            return (
                                <a
                                    key={f.value}
                                    href={`/rc-in?range=${f.value}`}
                                    className={`px-3 py-1 rounded-sm transition-colors ${isActive
                                        ? 'bg-background text-foreground shadow-sm'
                                        : 'text-muted-foreground hover:text-foreground'
                                        }`}
                                >
                                    {f.label}
                                </a>
                            );
                        })}
                    </div>
                </CardHeader>
                <CardContent>
                    <DeliveryMasterTable data={deliveries} />

                    {/* Pagination Bar Relocation: Bottom of Table */}
                    <div className="flex justify-between items-center mt-4 pt-4 border-t">
                        <div className="text-sm text-muted-foreground">
                            Current View: <span className="font-semibold text-foreground">{monthLabel}</span>
                        </div>

                        {/* Pagination Controls */}
                        <div className="flex items-center space-x-2">
                            <a
                                href={prevLink}
                                className="px-3 py-1 text-sm border rounded hover:bg-muted bg-background"
                            >
                                ← {format(prevMonthDate, 'MMMM yyyy')}
                            </a>
                            <a
                                href={nextLink}
                                className={`px-3 py-1 text-sm border rounded hover:bg-muted bg-background ${isNextDisabled ? 'opacity-50 pointer-events-none' : ''}`}
                                aria-disabled={isNextDisabled}
                            >
                                {format(nextMonthDate, 'MMMM yyyy')} →
                            </a>
                        </div>
                    </div>
                </CardContent>
            </Card>
        </div>
    );
}