'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { useProductionTab } from './production-tab-context';
import { useProductionPeriod } from './production-period-context';
import { fetchDailyTabData } from '../daily/actions';
import { DailyView } from '../daily/daily-view';
import type {
    ProductionShiftRow,
    ProductionRunRow,
    ProductionDowntimeRow,
    ProductionWasteRow,
} from '../daily/actions';
import { Button } from '@/components/ui/button';
import { Loader2 } from 'lucide-react';

interface DailyTabData {
    shifts: ProductionShiftRow[];
    runs: ProductionRunRow[];
    downtime: ProductionDowntimeRow[];
    waste: ProductionWasteRow[];
    year: number | null;
    batch: string | null;
}

// Serialize a period to a stable string for stale-comparison.
function periodKey(year: number | null, batch: string | null): string {
    return `${year ?? 'all'}|${batch ?? 'all'}`;
}

/** `?grid=v2` — passed straight through to the view, which owns the switch. */
export interface DailyLazyTabProps {
    v2?: boolean;
}

export function DailyLazyTab({ v2 = false }: DailyLazyTabProps) {
    const { activeTab } = useProductionTab();
    const { year, batch, periodsLoading } = useProductionPeriod();

    const [data, setData] = useState<DailyTabData | null>(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);

    // The period this tab last fetched for. Used to detect staleness when the tab
    // is re-activated after the shared period changed while it was inactive.
    const fetchedPeriodRef = useRef<string | null>(null);

    const load = useCallback(async (y: number | null, b: string | null) => {
        setLoading(true);
        setError(null);
        try {
            const result = await fetchDailyTabData(y, b);
            if (result.error) {
                setError(result.error);
            } else if (result.data) {
                setData({
                    shifts: result.data.shifts,
                    runs: result.data.runs,
                    downtime: result.data.downtime,
                    waste: result.data.waste,
                    year: result.data.year,
                    batch: result.data.batch,
                });
                fetchedPeriodRef.current = periodKey(y, b);
            }
        } catch (e) {
            setError(e instanceof Error ? e.message : 'Failed to load daily data');
        } finally {
            setLoading(false);
        }
    }, []);

    // Fetch when this tab is active AND its data is stale (period changed or never
    // loaded). Inactive tabs never fetch — they pick up the latest period lazily on
    // next activation. We wait for periodsLoading to settle so the default batch is
    // resolved before the first fetch (avoids a wasted "all batches" request).
    useEffect(() => {
        if (activeTab !== 'daily') return;
        if (periodsLoading) return;
        const current = periodKey(year, batch);
        if (fetchedPeriodRef.current !== current) {
            void load(year, batch);
        }
    }, [activeTab, year, batch, periodsLoading, load]);

    // Show the spinner while fetching OR while the shared period (default batch)
    // is still resolving — a fetch is imminent, so avoid a blank content flash.
    if ((loading || periodsLoading) && !data) {
        return (
            <div className="flex items-center justify-center flex-1 gap-2 text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" />
                <span className="text-sm">Loading daily data...</span>
            </div>
        );
    }

    if (error) {
        return (
            <div className="flex flex-col items-center justify-center flex-1 gap-3">
                <p className="text-sm text-destructive">{error}</p>
                <Button variant="outline" size="sm" onClick={() => void load(year, batch)}>
                    Retry
                </Button>
            </div>
        );
    }

    if (!data) return null;

    return (
        <DailyView
            v2={v2}
            shifts={data.shifts}
            runs={data.runs}
            downtime={data.downtime}
            waste={data.waste}
            dataYear={data.year}
            dataBatch={data.batch}
            loading={loading}
            onRefresh={() => load(year, batch)}
        />
    );
}
