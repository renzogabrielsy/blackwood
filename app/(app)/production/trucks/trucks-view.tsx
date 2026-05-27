'use client';

import * as React from 'react';
import { TrucksGrid } from './trucks-grid';
import type { Tables } from '@/types/supabase';

type TruckReadingRow = Tables<'truck_readings'>;
type TruckMonthlyRow = Tables<'view_trucks_monthly'>;

interface TrucksViewProps {
    readings: TruckReadingRow[];
    monthly: TruckMonthlyRow[];
    year: number;
    month: number;
    onRefresh: () => Promise<void>;
}

const MONTH_NAMES = [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December',
];

export function TrucksView({ readings, monthly, year, month, onRefresh }: TrucksViewProps) {
    return (
        <div className="flex flex-col gap-0 min-h-0">
            <div className="flex-none flex items-center gap-2 px-2 py-1 border-b bg-muted/20">
                <span className="text-[10px] text-muted-foreground uppercase tracking-wide">Period:</span>
                <span className="text-xs font-medium text-foreground">{MONTH_NAMES[month]} {year}</span>
                <span className="ml-auto text-[10px] text-muted-foreground">
                    {readings.length} readings
                </span>
            </div>
            <TrucksGrid
                initialData={readings}
                monthly={monthly}
                onSaveSuccess={onRefresh}
            />
        </div>
    );
}
