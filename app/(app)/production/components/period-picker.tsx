'use client';

import * as React from 'react';
import {
    Select,
    SelectContent,
    SelectItem,
    SelectSeparator,
    SelectTrigger,
    SelectValue,
} from '@/components/ui/select';
import { useProductionPeriod } from './production-period-context';

// ─── Universal Period Picker ──────────────────────────────────────────────────
// Module-level Year + Batch selects shared by all three production tabs (Daily /
// Electricity / Trucks). Lives in the production layout above the tab content so
// it stays mounted and visible regardless of the active tab.
//
// CRITICAL: the picker is NEVER disabled by any tab's loading state — it must stay
// interactive at all times. Per-tab spinners live in each tab's content area.
export function PeriodPicker() {
    const { year, batch, availablePeriods, setPeriod } = useProductionPeriod();

    // Batches for the selected year, or the union across all years when year=All.
    const batchOptions = React.useMemo(() => {
        if (!availablePeriods) return [];
        if (year == null) {
            const all = new Set<string>();
            for (const list of Object.values(availablePeriods.batchesByYear)) {
                for (const b of list) all.add(b);
            }
            return [...all].sort();
        }
        return availablePeriods.batchesByYear[year] ?? [];
    }, [availablePeriods, year]);

    return (
        <div className="flex items-center gap-1.5">
            {/* Year select */}
            <Select
                value={year == null ? 'all' : String(year)}
                onValueChange={(val) => {
                    const nextYear = val === 'all' ? null : parseInt(val, 10);
                    setPeriod(nextYear, batch);
                }}
            >
                <SelectTrigger className="h-6 px-2 text-[11px] font-mono gap-1 border-border/60 bg-background hover:bg-muted/50 w-[80px]">
                    <SelectValue placeholder="Year" />
                </SelectTrigger>
                <SelectContent className="text-xs font-mono">
                    <SelectItem value="all" className="text-[11px]">All Years</SelectItem>
                    {availablePeriods && availablePeriods.years.length > 0 && <SelectSeparator />}
                    {(availablePeriods?.years ?? []).map((y) => (
                        <SelectItem key={y} value={String(y)} className="text-[11px]">
                            {y}
                        </SelectItem>
                    ))}
                </SelectContent>
            </Select>

            {/* Batch (Month) select */}
            <Select
                value={batch == null ? 'all' : batch}
                onValueChange={(val) => {
                    const nextBatch = val === 'all' ? null : val;
                    setPeriod(year, nextBatch);
                }}
            >
                <SelectTrigger className="h-6 px-2 text-[11px] font-mono gap-1 border-border/60 bg-background hover:bg-muted/50 w-[110px]">
                    <SelectValue placeholder="Batch" />
                </SelectTrigger>
                <SelectContent className="text-xs font-mono">
                    <SelectItem value="all" className="text-[11px]">All Batches</SelectItem>
                    {batchOptions.length > 0 && <SelectSeparator />}
                    {batchOptions.map((b) => (
                        <SelectItem key={b} value={b} className="text-[11px]">
                            {b}
                        </SelectItem>
                    ))}
                </SelectContent>
            </Select>
        </div>
    );
}
