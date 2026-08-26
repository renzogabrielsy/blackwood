'use client';

import * as React from 'react';
import { ElectricityGrid } from './electricity-grid';
import { ElectricityGridV2 } from './electricity-grid-v2';
import { ElectricityCardsMobile } from './electricity-cards-mobile';
import type { Tables } from '@/types/supabase';

type ElectricityReadingRow = Tables<'electricity_readings'>;

interface ElectricityViewProps {
    readings: ElectricityReadingRow[];
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
     * DESKTOP ONLY: the phone card list below renders identically on both sides.
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

export function ElectricityView({ readings, year, month, onRefresh, v2 }: ElectricityViewProps) {
    return (
        <div className="flex flex-col gap-0 min-h-0">
            <div className="flex-none flex items-center gap-2 px-2 py-1 border-b bg-muted/20">
                <span className="text-[10px] text-muted-foreground uppercase tracking-wide">Showing:</span>
                <span className="text-xs font-medium text-foreground">{describeScope(year, month)}</span>
                <span className="ml-auto text-[10px] text-muted-foreground">
                    {readings.length} readings
                </span>
            </div>
            {/* Tablet / desktop — the dense inline-editable grid (unchanged). */}
            <div className="hidden sm:block">
                {v2 ? (
                    // `onSaveSuccess` is load-bearing, not polish: this tab holds its rows
                    // in CLIENT state (the lazy tab's useState), so `router.refresh()`
                    // cannot bring a saved row back — the host's `onRefresh` is the only
                    // path. Without it a save succeeds, the toast says so, and the sheet
                    // keeps showing the pre-save values, which reads as a lost save.
                    <ElectricityGridV2
                        initialData={readings}
                        onSaveSuccess={onRefresh}
                        periodYear={year}
                    />
                ) : (
                    <ElectricityGrid
                        initialData={readings}
                        onSaveSuccess={onRefresh}
                    />
                )}
            </div>
            {/* Phone — read-only card list + detail sheet. */}
            <div className="h-[70dvh] sm:hidden">
                <ElectricityCardsMobile readings={readings} />
            </div>
        </div>
    );
}
