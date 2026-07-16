'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { useProductionTab } from './production-tab-context';
import { useProductionPeriod } from './production-period-context';
import { batchToMonth } from '../lib/batch-month';
import { fetchElectricityTabData } from '../electricity/actions';
import { ElectricityView } from '../electricity/electricity-view';
import type { Tables } from '@/types/supabase';
import { Button } from '@/components/ui/button';
import { Loader2 } from 'lucide-react';

export type ElectricityReadingRow = Tables<'electricity_readings'>;

interface ElectricityTabData {
    readings: ElectricityReadingRow[];
    year: number | null;
    month: number | null;
}

function periodKey(year: number | null, batch: string | null): string {
    return `${year ?? 'all'}|${batch ?? 'all'}`;
}

export function ElectricityLazyTab() {
    const { activeTab } = useProductionTab();
    const { year, batch, periodsLoading } = useProductionPeriod();

    const [data, setData] = useState<ElectricityTabData | null>(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const fetchedPeriodRef = useRef<string | null>(null);

    // Electricity stores calendar dates, so the shared batch must be translated to
    // a 0-indexed month. Unrecognized / null batch → null month → whole year.
    const load = useCallback(async (y: number | null, b: string | null) => {
        setLoading(true);
        setError(null);
        try {
            const month = batchToMonth(b);
            const result = await fetchElectricityTabData(y, month);
            if (result.error) {
                setError(result.error);
            } else if (result.data) {
                setData(result.data);
                fetchedPeriodRef.current = periodKey(y, b);
            }
        } catch (e) {
            setError(e instanceof Error ? e.message : 'Failed to load electricity data');
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        if (activeTab !== 'electricity') return;
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
                <span className="text-sm">Loading electricity data...</span>
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
        <ElectricityView
            readings={data.readings}
            year={data.year}
            month={data.month}
            onRefresh={() => load(year, batch)}
        />
    );
}
