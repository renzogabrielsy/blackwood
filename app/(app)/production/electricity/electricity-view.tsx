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
     * `?grid=v2` — render the READ-ONLY Blackwood Table rewire instead of the live grid.
     * Desktop only: the phone card list below is untouched on both sides.
     * See `app/(app)/production/(tabs)/page.tsx`.
     */
    v2?: boolean;
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

export function ElectricityView({ readings, year, month, onRefresh, v2 = false }: ElectricityViewProps) {
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
                    <ElectricityGridV2 initialData={readings} />
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
