'use client';

import { useState, useEffect, useRef } from 'react';
import { useProductionTab } from './production-tab-context';
import { fetchDailyTabData } from '../daily/actions';
import { DailyView } from '../daily/daily-view';
import type { Tables } from '@/types/supabase';
import { Button } from '@/components/ui/button';
import { Loader2 } from 'lucide-react';

export type ProductionRunRow = Tables<'production_runs'>;
export type ProductionDowntimeRow = Tables<'production_downtime'>;
export type ProductionWasteRow = Tables<'production_waste'>;

interface DailyTabData {
    runs: ProductionRunRow[];
    downtime: ProductionDowntimeRow[];
    waste: ProductionWasteRow[];
    year: number;
    month: number;
}

export function DailyLazyTab() {
    const { activeTab } = useProductionTab();
    const [data, setData] = useState<DailyTabData | null>(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const hasLoadedRef = useRef(false);

    const load = async () => {
        setLoading(true);
        setError(null);
        try {
            const result = await fetchDailyTabData();
            if (result.error) {
                setError(result.error);
            } else if (result.data) {
                setData(result.data);
                hasLoadedRef.current = true;
            }
        } catch (e) {
            setError(e instanceof Error ? e.message : 'Failed to load daily data');
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        if (activeTab === 'daily' && !hasLoadedRef.current) {
            void load();
        }
    }, [activeTab]); // eslint-disable-line react-hooks/exhaustive-deps

    if (loading) {
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
                <Button variant="outline" size="sm" onClick={() => void load()}>
                    Retry
                </Button>
            </div>
        );
    }

    if (!data) return null;

    return (
        <DailyView
            runs={data.runs}
            downtime={data.downtime}
            waste={data.waste}
            year={data.year}
            month={data.month}
            onRefresh={load}
        />
    );
}
