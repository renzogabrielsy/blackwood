
import { supabase } from '@/lib/supabase';
import Link from 'next/link';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { DeliveryMasterTable, DeliveryHistoryRow } from './delivery-master-table';

import { startOfMonth, endOfMonth, addMonths, subMonths, format, parse, isFuture, startOfQuarter, endOfQuarter, isBefore, isAfter } from 'date-fns';

export default async function RCInPage({
    searchParams
}: {
    searchParams: Promise<{ range?: string; view_date?: string; search?: string; field?: string }>;
}) {
    const { range: rawRange, view_date: rawViewDate, search, field } = await searchParams;
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
        .order('created_at', { ascending: false });

    // 4. Apply Filters
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
            // WHSE column displays block_loc OR "FEED" (derived from batch_code)
            // So we search both to ensure UI matches results
            query = query.or(`block_loc.ilike.${term},batch_code.ilike.${term}`);
        }
    } else {
        // Strict Date Range only if NOT searching
        query = query
            .gte('transaction_date', format(startDate, 'yyyy-MM-dd'))
            .lte('transaction_date', format(endDate, 'yyyy-MM-dd'));
    }

    const { data: deliveriesRaw, error } = await query.limit(10000); // Expanded limit for global search

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

    // Calculate Boundaries based on Range
    let minDate: Date | null = null;
    let maxDate: Date | null = null;

    if (range === 'this_month') {
        minDate = startOfMonth(now);
        maxDate = endOfMonth(now);
    } else if (range === 'this_quarter') {
        minDate = startOfQuarter(now);
        maxDate = endOfQuarter(now);
    } else if (range === 'this_year') {
        minDate = new Date(now.getFullYear(), 0, 1); // Start of Year
        maxDate = new Date(now.getFullYear(), 11, 31); // End of Year
    }

    // Disable Logic
    const isPrevDisabled = minDate ? isBefore(startOfMonth(prevMonthDate), startOfMonth(minDate)) : false;

    // Future Check:
    const isFutureDate = isFuture(startOfMonth(nextMonthDate));
    const isNextDisabled = (maxDate ? isAfter(startOfMonth(nextMonthDate), startOfMonth(maxDate)) : false) || isFutureDate;


    const prevLink = isPrevDisabled ? '#' : `/rc-in?range=${range}&view_date=${format(prevMonthDate, 'yyyy-MM')}`;
    const nextLink = isNextDisabled ? '#' : `/rc-in?range=${range}&view_date=${format(nextMonthDate, 'yyyy-MM')}`;

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
            {/* Master Log */}
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
                            const isActive = !search && range === f.value;
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
                    <DeliveryMasterTable data={deliveries} batches={activeBatches} />

                    {/* Pagination Bar Relocation: Bottom of Table */}
                    <div className="flex justify-between items-center mt-4 pt-4 border-t">
                        <div className="text-sm text-muted-foreground">
                            {search ? (
                                <span>Found <span className="font-semibold text-foreground">{deliveries.length}</span> results for "<span className="font-semibold text-foreground">{search}</span>"</span>
                            ) : (
                                <span>Current View: <span className="font-semibold text-foreground">{monthLabel}</span></span>
                            )}
                        </div>

                        {/* Pagination Controls - Only show if NOT searching */}
                        {!search && (
                            <div className="flex items-center space-x-2">
                                <Link
                                    href={prevLink}
                                    className={`px-3 py-1 text-sm border rounded hover:bg-muted bg-background ${isPrevDisabled ? 'opacity-50 pointer-events-none' : ''}`}
                                    aria-disabled={isPrevDisabled}
                                >
                                    ← {format(prevMonthDate, 'MMMM yyyy')}
                                </Link>
                                <Link
                                    href={nextLink}
                                    className={`px-3 py-1 text-sm border rounded hover:bg-muted bg-background ${isNextDisabled ? 'opacity-50 pointer-events-none' : ''}`}
                                    aria-disabled={isNextDisabled}
                                >
                                    {format(nextMonthDate, 'MMMM yyyy')} →
                                </Link>
                            </div>
                        )}
                    </div>
                </CardContent>
            </Card>
        </div>
    );
}