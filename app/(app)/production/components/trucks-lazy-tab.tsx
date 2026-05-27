'use client';

import { useState, useEffect, useRef } from 'react';
import { useProductionTab } from './production-tab-context';
import { fetchTrucksTabData } from '../trucks/actions';
import { TrucksView } from '../trucks/trucks-view';
import type { Tables } from '@/types/supabase';
import { Button } from '@/components/ui/button';
import { Loader2 } from 'lucide-react';

export type TruckReadingRow = Tables<'truck_readings'>;
export type TruckMonthlyRow = Tables<'view_trucks_monthly'>;

interface TrucksTabData {
    readings: TruckReadingRow[];
    monthly: TruckMonthlyRow[];
    year: number;
    month: number;
}

export function TrucksLazyTab() {
    const { activeTab } = useProductionTab();
    const [data, setData] = useState<TrucksTabData | null>(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const hasLoadedRef = useRef(false);

    const load = async () => {
        setLoading(true);
        setError(null);
        try {
            const result = await fetchTrucksTabData();
            if (result.error) {
                setError(result.error);
            } else if (result.data) {
                setData(result.data);
                hasLoadedRef.current = true;
            }
        } catch (e) {
            setError(e instanceof Error ? e.message : 'Failed to load trucks data');
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        if (activeTab === 'trucks' && !hasLoadedRef.current) {
            void load();
        }
    }, [activeTab]); // eslint-disable-line react-hooks/exhaustive-deps

    if (loading) {
        return (
            <div className="flex items-center justify-center flex-1 gap-2 text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" />
                <span className="text-sm">Loading trucks data...</span>
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
        <TrucksView
            readings={data.readings}
            monthly={data.monthly}
            year={data.year}
            month={data.month}
            onRefresh={load}
        />
    );
}
