'use client';

import { useEffect, useState, useCallback, useRef } from 'react';
import { Loader2 } from 'lucide-react';
import { useInventoryTab } from './inventory-tab-context';
import { RcMovementTableWrapper } from '../rc-movement/components/rc-movement-table-wrapper';
import { fetchRcMovementData, type RcMovementData } from '../rc-movement/actions';

export function RcMovementLazyTab() {
    const { activeTab } = useInventoryTab();
    const now = new Date();
    const [year, setYear] = useState<number>(now.getFullYear());
    const [month, setMonth] = useState<number>(now.getMonth() + 1); // 1-indexed for actions API

    const [data, setData] = useState<RcMovementData | null>(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState(false);
    const hasFetchedRef = useRef(false);

    // Read URL params on mount (?y=YYYY&m=M) without triggering navigation
    useEffect(() => {
        if (typeof window === 'undefined') return;
        const params = new URLSearchParams(window.location.search);
        const y = params.get('y');
        const m = params.get('m');
        const parsedY = y ? parseInt(y, 10) : NaN;
        const parsedM = m ? parseInt(m, 10) : NaN;
        if (!Number.isNaN(parsedY) && parsedY >= 2010 && parsedY <= 2100) {
            setYear(parsedY);
        }
        if (!Number.isNaN(parsedM) && parsedM >= 1 && parsedM <= 12) {
            setMonth(parsedM);
        }
    }, []);

    const loadData = useCallback(async (y: number, m: number) => {
        setLoading(true);
        setError(false);
        try {
            const result = await fetchRcMovementData(y, m);
            setData(result);
            hasFetchedRef.current = true;
        } catch {
            setError(true);
        } finally {
            setLoading(false);
        }
    }, []);

    // Fetch when movement tab becomes active for the first time.
    // Subsequent month/year changes are triggered explicitly via handleChangeMonth.
    useEffect(() => {
        if (activeTab !== 'movement') return;
        if (hasFetchedRef.current) return;
        loadData(year, month);
    }, [activeTab, loadData, year, month]);

    const handleChangeMonth = useCallback(
        (nextYear: number, nextMonth: number) => {
            setYear(nextYear);
            setMonth(nextMonth);
            // Silently sync to URL so refreshing the page preserves the picker state.
            if (typeof window !== 'undefined') {
                const params = new URLSearchParams(window.location.search);
                params.set('y', String(nextYear));
                params.set('m', String(nextMonth));
                const qs = params.toString();
                window.history.replaceState(null, '', window.location.pathname + (qs ? '?' + qs : ''));
            }
            loadData(nextYear, nextMonth);
        },
        [loadData],
    );

    if (loading && !data) {
        return (
            <div className="h-full w-full flex items-center justify-center">
                <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
            </div>
        );
    }

    if (error || !data) {
        return (
            <div className="h-full w-full flex flex-col items-center justify-center gap-3">
                <p className="text-sm text-muted-foreground">Failed to load movement data.</p>
                <button
                    onClick={() => loadData(year, month)}
                    className="text-xs px-3 py-1.5 rounded border border-border hover:bg-muted/50 transition-colors"
                >
                    Retry
                </button>
            </div>
        );
    }

    return (
        <RcMovementTableWrapper
            data={data}
            year={year}
            month={month}
            loading={loading}
            onChangeMonth={handleChangeMonth}
        />
    );
}
