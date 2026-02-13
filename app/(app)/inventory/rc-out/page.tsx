import { getRcOutRecords } from './actions';
import { RcOutTable } from './components/rc-out-table';
import { Suspense } from 'react';
import { Loader2 } from 'lucide-react';
import { Metadata } from 'next';
import { startOfMonth, endOfMonth, format } from "date-fns";
import { Card, CardContent, CardHeader } from '@/components/ui/card';

export const metadata: Metadata = {
    title: 'Inventory Usage | Blackwood',
    description: 'Inventory Depletion Records',
};

export default async function RcOutPage({
    searchParams,
}: {
    searchParams: Promise<{ search?: string; year?: string; month?: string }>;
}) {
    const { search, year: yearParam, month: monthParam } = await searchParams;

    // Date Logic
    // Default to 'All Years' if not specified? Or current year?
    // RC IN defaults to current year.
    // If year is 'all', we don't apply date filter (fetch all).
    // If year is selected but month is 'all', filter by year.
    // If year and month selected, filter by month.

    // However, for infinite scroll, let's default to CURRENT MONTH to populate the table nicely without fetching 1000s of old records?
    // User requested "Same footer year month picker". RC IN typically defaults to current year.
    // Let's default to Current Year, All Months for broad overview, OR Current Month?
    // Given "Inventory Depletion" is high volume, Current Month is safer.
    // Let's try: Year = Current, Month = Current.

    const now = new Date();
    const year = yearParam ?? String(now.getFullYear());
    const month = monthParam ?? String(now.getMonth()); // 0-indexed in JS, but usually stored as 0-11 string in params?

    let startDate: string | undefined;
    let endDate: string | undefined;

    if (year !== 'all') {
        const y = parseInt(year, 10);
        if (month !== 'all') {
            const m = parseInt(month, 10);
            const start = new Date(y, m, 1);
            const end = endOfMonth(start);
            startDate = format(start, 'yyyy-MM-dd');
            endDate = format(end, 'yyyy-MM-dd');
        } else {
            const start = new Date(y, 0, 1);
            const end = new Date(y, 11, 31);
            startDate = format(start, 'yyyy-MM-dd');
            endDate = format(end, 'yyyy-MM-dd');
        }
    }

    // Fetch data on the server - Initial load of 40 to fill viewport, then client loads 15 at a time
    const data = await getRcOutRecords(search, 0, 40, startDate, endDate);

    return (
        <div className="flex flex-col flex-1 min-h-0 overflow-hidden bg-muted/20">
            {/* Main Content */}
            <div className="flex-1 min-h-0 px-4 md:px-6 py-4 md:py-6">
                <Card className="h-full flex flex-col border-none shadow-xl">
                    <CardHeader className="p-0 hidden" />
                    <CardContent className="flex-1 min-h-0 p-2 md:p-4 flex flex-col relative">
                        <div className="flex items-center justify-between mb-4">
                            <h2 className="text-3xl font-bold tracking-tight">Inventory Usage</h2>
                        </div>
                        <Suspense fallback={
                            <div className="h-full w-full flex items-center justify-center">
                                <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
                            </div>
                        }>
                            <RcOutTable
                                data={data}
                                search={search}
                                year={year}
                                month={month}
                            />
                        </Suspense>
                    </CardContent>
                </Card>
            </div>
        </div>
    );
}
