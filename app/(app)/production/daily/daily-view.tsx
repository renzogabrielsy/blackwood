'use client';

import * as React from 'react';
import { DailyLedgerGrid } from './daily-ledger-grid';
import { DailyCardsMobile } from './daily-cards-mobile';
import type {
    ProductionShiftRow,
    ProductionRunRow,
    ProductionDowntimeRow,
    ProductionWasteRow,
} from './actions';

interface DailyViewProps {
    shifts: ProductionShiftRow[];
    runs: ProductionRunRow[];
    downtime: ProductionDowntimeRow[];
    waste: ProductionWasteRow[];
    /** What the loaded data actually represents (after fetch). Used as grid remount key. */
    dataYear: number | null;
    dataBatch: string | null;
    loading: boolean;
    onRefresh: () => Promise<void>;
}

export function DailyView({
    shifts,
    runs,
    downtime,
    waste,
    dataYear,
    dataBatch,
    onRefresh,
}: DailyViewProps) {
    return (
        <div className="flex flex-col gap-0 min-h-0 flex-1">
            {/* Single unified ledger. The period picker now lives in the production
                layout (shared across all tabs) — the grid only owns its own data.
                key forces a remount only AFTER fresh data arrives — stale data never
                shown in a "new" grid. */}
            <div className="min-w-0 flex-1 min-h-0">
                {/* Tablet / desktop — the dense inline-editable ledger (unchanged). */}
                <div className="hidden sm:block">
                    <DailyLedgerGrid
                        key={`${dataYear ?? 'all'}-${dataBatch ?? 'all'}`}
                        initialShifts={shifts}
                        initialRuns={runs}
                        initialDowntime={downtime}
                        initialWaste={waste}
                        onSaveSuccess={onRefresh}
                    />
                </div>
                {/* Phone — read-only card list + section-grouped detail sheet. */}
                <div className="h-[72dvh] sm:hidden">
                    <DailyCardsMobile
                        shifts={shifts}
                        runs={runs}
                        downtime={downtime}
                        waste={waste}
                    />
                </div>
            </div>
        </div>
    );
}
