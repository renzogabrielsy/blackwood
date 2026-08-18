'use client';

import * as React from 'react';
import { DailyLedgerGrid } from './daily-ledger-grid';
import { DailyGridV2 } from './daily-grid-v2';
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
    /**
     * `?grid=v2` — render the READ-ONLY Blackwood Table rewire instead of the live ledger.
     * The switch lives here rather than in the lazy tab so the phone card list below is
     * untouched by it: v2 is the desktop grid only, and `DailyCardsMobile` keeps serving
     * the phone on both sides. See `app/(app)/production/(tabs)/page.tsx`.
     */
    v2?: boolean;
}

export function DailyView({
    shifts,
    runs,
    downtime,
    waste,
    dataYear,
    dataBatch,
    onRefresh,
    v2 = false,
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
                    {v2 ? (
                        <DailyGridV2
                            key={`v2-${dataYear ?? 'all'}-${dataBatch ?? 'all'}`}
                            initialShifts={shifts}
                            initialRuns={runs}
                            initialDowntime={downtime}
                            initialWaste={waste}
                        />
                    ) : (
                        <DailyLedgerGrid
                            key={`${dataYear ?? 'all'}-${dataBatch ?? 'all'}`}
                            initialShifts={shifts}
                            initialRuns={runs}
                            initialDowntime={downtime}
                            initialWaste={waste}
                            onSaveSuccess={onRefresh}
                        />
                    )}
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
