'use client';

// Tab shell for the Daily · Electricity · Trucks surfaces ONLY.
//
// It lives inside the `(tabs)` ROUTE GROUP (URL-invisible) rather than at
// `production/` so that sibling production routes can opt OUT of it. That is the
// whole point of the group. Its original beneficiaries — `/production/schedule`
// and `/production/setups` — were retired on 2026-08-28
// (`_archived/prod-schedule-v1/`), so the group currently guards nothing; KEEP IT
// anyway, because the next non-tab route under `/production` needs exactly this
// escape and re-deriving it is how BUG-003 happened in the first place.
// See docs/BUG_LEDGER.md → BUG-003 (Fallback S, the "route-group escape").
import { Card, CardContent } from '@/components/ui/card';
import { ProductionSheetTabs } from '../components/sheet-tabs';
import { ProductionTabProvider } from '../components/production-tab-context';
import { ProductionPeriodProvider } from '../components/production-period-context';
import { PeriodPicker } from '../components/period-picker';

export default function ProductionLayout({ children }: { children: React.ReactNode }) {
    return (
        <ProductionTabProvider>
            <ProductionPeriodProvider>
                <div className="flex flex-col flex-1 min-h-0 overflow-hidden bg-muted/20">
                    <div className="flex-1 min-h-0 px-4 md:px-6 py-4 md:py-6">
                        <Card className="h-full flex flex-col gap-0 py-0 border-none shadow-xl">
                            {/* Universal period control — persistently visible across all tabs.
                                Mounted once in the layout so switching tabs never remounts or
                                disables it. */}
                            <div className="flex-none flex items-center gap-2 px-2 md:px-4 py-1.5 border-b bg-muted/30">
                                <span className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                                    Period
                                </span>
                                <PeriodPicker />
                            </div>
                            <CardContent className="flex-1 min-h-0 p-2 md:p-4 flex flex-col relative">
                                {children}
                            </CardContent>
                            <ProductionSheetTabs />
                        </Card>
                    </div>
                </div>
            </ProductionPeriodProvider>
        </ProductionTabProvider>
    );
}
