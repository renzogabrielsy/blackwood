'use client';

import * as React from 'react';
import { ProductionRunsGrid } from './production-runs-grid';
import { DowntimeGrid } from './downtime-grid';
import { WasteGrid } from './waste-grid';
import type { Tables } from '@/types/supabase';

type ProductionRunRow = Tables<'production_runs'>;
type ProductionDowntimeRow = Tables<'production_downtime'>;
type ProductionWasteRow = Tables<'production_waste'>;

interface DailyViewProps {
    runs: ProductionRunRow[];
    downtime: ProductionDowntimeRow[];
    waste: ProductionWasteRow[];
    year: number;
    month: number;
    onRefresh: () => Promise<void>;
}

const MONTH_NAMES = [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December',
];

export function DailyView({ runs, downtime, waste, year, month, onRefresh }: DailyViewProps) {
    return (
        <div className="flex flex-col gap-0 min-h-0">
            {/* Period indicator */}
            <div className="flex-none flex items-center gap-2 px-2 py-1 border-b bg-muted/20">
                <span className="text-[10px] text-muted-foreground uppercase tracking-wide">
                    Period:
                </span>
                <span className="text-xs font-medium text-foreground">
                    {MONTH_NAMES[month]} {year}
                </span>
                <span className="ml-auto text-[10px] text-muted-foreground">
                    {runs.length} runs · {downtime.length} downtime · {waste.length} waste
                </span>
            </div>

            {/* Three grids side-by-side with horizontal scroll */}
            <div className="overflow-x-auto">
                <div className="flex flex-row items-start">
                    <div className="w-[620px] shrink-0">
                        <ProductionRunsGrid
                            initialData={runs}
                            onSaveSuccess={onRefresh}
                        />
                    </div>
                    <div className="w-[700px] shrink-0 border-l border-border/50">
                        <DowntimeGrid
                            initialData={downtime}
                            onSaveSuccess={onRefresh}
                        />
                    </div>
                    <div className="w-[1200px] shrink-0 border-l border-border/50">
                        <WasteGrid
                            initialData={waste}
                            onSaveSuccess={onRefresh}
                        />
                    </div>
                </div>
            </div>
        </div>
    );
}
