
import { supabase } from '@/lib/supabase';
import Link from 'next/link';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { BulkDeliveryInput } from './bulk-delivery-input';
import { DeliveryMasterTable, DeliveryHistoryRow } from './delivery-master-table';

import { startOfMonth, endOfMonth, addMonths, subMonths, format, parse, isFuture, startOfQuarter, endOfQuarter, isBefore, isAfter } from 'date-fns';

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
        .gte('transaction_date', format(startDate, 'yyyy-MM-dd'))
        .lte('transaction_date', format(endDate, 'yyyy-MM-dd'));
    // Using simple date string 'YYYY-MM-DD' for date column comparison avoids timezone offsets.

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
    // 'all' and 'last_6_months' (rolling) generally don't have hard forward/backward limits 
    // unrelated to "future" or "data existence", but 'last_6_months' implies a window.
    // However, user only specified strictness for Month, Quarter, Year.

    // Disable Logic
    // Prev: If minDate exists AND prevMonth is BEFORE minDate (strict month check)
    // We compare start of months to be safe.
    const isPrevDisabled = minDate ? isBefore(startOfMonth(prevMonthDate), startOfMonth(minDate)) : false;

    // Next: 
    // 1. If maxDate exists AND nextMonth is AFTER maxDate
    // 2. OR if nextMonth is in the Future (unless 'all' allows future, but standard is no future)
    // 3. User said: "if we are in march then it should just be march" -> strict single month implies next/prev disabled.
    //    Our min/max logic handles this: min=Mar1, max=Mar31. Prev(Feb) < Mar1 -> Disabled. Next(Apr) > Mar31 -> Disabled. Correct.

    // Future Check:
    // "For this quarter it should just be the current months WITHIN the current quarter."
    // If Quarter is Jan-Mar, and today is Feb. Next is Mar. Mar is <= EndOfQuarter. 
    // BUT is Mar in the future? If today is Feb 9, Mar 1 is future. 
    // Do we allow navigating to empty future months? "months WITHIN the current quarter" implies valid months.
    // Usually we disable future.
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
                    </div>
                </CardContent>
            </Card>
        </div>
    );
}