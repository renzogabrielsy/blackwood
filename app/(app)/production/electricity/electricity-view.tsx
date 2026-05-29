'use client';

import * as React from 'react';
import { ElectricityGrid } from './electricity-grid';
import type { Tables } from '@/types/supabase';

type ElectricityReadingRow = Tables<'electricity_readings'>;

interface ElectricityViewProps {
    readings: ElectricityReadingRow[];
    /** Resolved data scope. null year = all years; null month = whole year. */
    year: number | null;
    month: number | null;
    onRefresh: () => Promise<void>;
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

export function ElectricityView({ readings, year, month, onRefresh }: ElectricityViewProps) {
    return (
        <div className="flex flex-col gap-0 min-h-0">
            <div className="flex-none flex items-center gap-2 px-2 py-1 border-b bg-muted/20">
                <span className="text-[10px] text-muted-foreground uppercase tracking-wide">Showing:</span>
                <span className="text-xs font-medium text-foreground">{describeScope(year, month)}</span>
                <span className="ml-auto text-[10px] text-muted-foreground">
                    {readings.length} readings
                </span>
            </div>
            <ElectricityGrid
                initialData={readings}
                onSaveSuccess={onRefresh}
            />
        </div>
    );
}
