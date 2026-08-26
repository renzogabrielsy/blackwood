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
     * `?grid=` — render the Blackwood Table rewire (**this tab's default since
     * 2026-08-26**) instead of the Classic ledger, which stays reachable at `?grid=v1`.
     *
     * REQUIRED: the server page states the default once, in the one expression that reads
     * the param, and threads the answer down (see `app/(app)/production/(tabs)/page.tsx`).
     *
     * The switch lives here rather than in the lazy tab so the phone card list below is
     * untouched by it: this flag is the DESKTOP grid only, and `DailyCardsMobile` keeps
     * serving the phone identically on both sides.
     */
    v2: boolean;
}

export function DailyView({
    shifts,
    runs,
    downtime,
    waste,
    dataYear,
    dataBatch,
    onRefresh,
    v2,
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
                            // Load-bearing, not polish: this tab's rows are CLIENT state
                            // (the lazy tab's fetch), so `router.refresh()` cannot bring a
                            // saved row back — the host's `onRefresh` is the only path.
                            // Without it a save lands but the sheet keeps its pre-save
                            // values, which reads as a lost save.
                            onSaveSuccess={onRefresh}
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
