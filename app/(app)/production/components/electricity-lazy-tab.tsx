'use client';

import { useState, useEffect, useRef } from 'react';
import { useProductionTab } from './production-tab-context';
import { fetchElectricityTabData } from '../electricity/actions';
import { ElectricityView } from '../electricity/electricity-view';
import type { Tables } from '@/types/supabase';
import { Button } from '@/components/ui/button';
import { Loader2 } from 'lucide-react';

export type ElectricityReadingRow = Tables<'electricity_readings'>;
export type ElectricityMonthlyRow = Tables<'view_electricity_monthly'>;

interface ElectricityTabData {
    readings: ElectricityReadingRow[];
    monthly: ElectricityMonthlyRow[];
    year: number;
    month: number;
}

export function ElectricityLazyTab() {
    const { activeTab } = useProductionTab();
    const [data, setData] = useState<ElectricityTabData | null>(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const hasLoadedRef = useRef(false);

    const load = async () => {
        setLoading(true);
        setError(null);
        try {
            const result = await fetchElectricityTabData();
            if (result.error) {
                setError(result.error);
            } else if (result.data) {
                setData(result.data);
                hasLoadedRef.current = true;
            }
        } catch (e) {
            setError(e instanceof Error ? e.message : 'Failed to load electricity data');
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        if (activeTab === 'electricity' && !hasLoadedRef.current) {
            void load();
        }
    }, [activeTab]); // eslint-disable-line react-hooks/exhaustive-deps

    if (loading) {
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
                <Button variant="outline" size="sm" onClick={() => void load()}>
                    Retry
                </Button>
            </div>
        );
    }

    if (!data) return null;

    return (
        <ElectricityView
            readings={data.readings}
            monthly={data.monthly}
            year={data.year}
            month={data.month}
            onRefresh={load}
        />
    );
}
