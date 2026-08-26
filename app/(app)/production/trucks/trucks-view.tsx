'use client';

import * as React from 'react';
import { TrucksGrid } from './trucks-grid';
import { TrucksGridV2 } from './trucks-grid-v2';
import type { Tables } from '@/types/supabase';

type TruckReadingRow = Tables<'truck_readings'>;

interface TrucksViewProps {
    readings: TruckReadingRow[];
    /** Resolved data scope. null year = all years; null month = whole year. */
    year: number | null;
    month: number | null;
    onRefresh: () => Promise<void>;
    /**
     * `?grid=` — render the Blackwood Table rewire (**this tab's default since
     * 2026-08-26**) instead of the Classic grid, which stays reachable at `?grid=v1`.
     *
     * REQUIRED: the server page states the default once and threads the answer down
     * (see `app/(app)/production/(tabs)/page.tsx`).
     *
     * DESKTOP ONLY, and that is the reason this switch is here: `TrucksGrid` carries its
     * own `sm:hidden` phone summary inside itself, so on a phone the Classic component must
     * keep rendering on BOTH sides — hence the `hidden sm:block` wrapper below the v2
     * branch, and the Classic grid left whole.
     */
    v2: boolean;
}

const MONTH_NAMES = [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December',
];

// The universal period control in the production layout owns period selection.
// This compact label just reflects what the loaded data actually represents.
function describeScope(year: number | null, month: number | null): string {
    if (year == null) return 'All Years';
    if (month == null) return String(year);
    return `${MONTH_NAMES[month]} ${year}`;
}

export function TrucksView({ readings, year, month, onRefresh, v2 }: TrucksViewProps) {
    return (
        <div className="flex flex-col gap-0 min-h-0">
            <div className="flex-none flex items-center gap-2 px-2 py-1 border-b bg-muted/20">
                <span className="text-[10px] text-muted-foreground uppercase tracking-wide">Showing:</span>
                <span className="text-xs font-medium text-foreground">{describeScope(year, month)}</span>
                <span className="ml-auto text-[10px] text-muted-foreground">
                    {readings.length} readings
                </span>
            </div>
            {v2 ? (
                <>
                    <div className="hidden sm:block">
                        {/* `onSaveSuccess` is load-bearing, not polish: this tab holds its
                            rows in CLIENT state, so `router.refresh()` cannot bring a saved
                            row back — the host's `onRefresh` is the only path. */}
                        <TrucksGridV2
                            initialData={readings}
                            onSaveSuccess={onRefresh}
                            periodYear={year}
                        />
                    </div>
                    {/* The phone summary lives INSIDE `TrucksGrid` (its `sm:hidden`
                        companion), and v2 is the desktop grid only — so on a phone the live
                        component still renders and nothing about the phone changes. Its own
                        `hidden sm:block` wrapper keeps the editable matrix off the phone. */}
                    <div className="sm:hidden">
                        <TrucksGrid
                            initialData={readings}
                            onSaveSuccess={onRefresh}
                        />
                    </div>
                </>
            ) : (
                <TrucksGrid
                    initialData={readings}
                    onSaveSuccess={onRefresh}
                />
            )}
        </div>
    );
}
