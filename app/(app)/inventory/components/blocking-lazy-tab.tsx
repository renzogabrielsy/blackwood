'use client';

import { useEffect, useState, useCallback, useRef } from 'react';
import { Loader2 } from 'lucide-react';
import { BlockingGrid } from '../blocking/blocking-grid';
import { fetchBlockingGridData } from '../blocking/actions';
import { useInventoryTab } from './inventory-tab-context';
import type { BlockingGridData } from '../blocking/types';

export function BlockingLazyTab() {
    const [data, setData] = useState<BlockingGridData | null>(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState(false);
    const { activeTab } = useInventoryTab();
    const hasFetchedRef = useRef(false);

    const loadData = useCallback(async () => {
        setLoading(true);
        setError(false);
        try {
            const result = await fetchBlockingGridData();
            // Server action returns empty blocks on failure — treat as error if no data came back
            if (Object.keys(result.blocks).length === 0) {
                setError(true);
            } else {
                setData(result);
                hasFetchedRef.current = true;
            }
        } catch {
            setError(true);
        } finally {
            setLoading(false);
        }
    }, []);

    // Fetch when the blocking tab becomes active. Re-fetches on each activation
    // if data hasn't loaded successfully yet (handles Supabase autopause recovery).
    useEffect(() => {
        if (activeTab !== 'blocking') return;
        if (hasFetchedRef.current) return; // already have good data
        loadData();
    }, [activeTab, loadData]);

    if (loading) {
        return (
            <div className="h-full w-full flex items-center justify-center">
                <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
            </div>
        );
    }

    if (error || !data) {
        return (
            <div className="h-full w-full flex flex-col items-center justify-center gap-3">
                <p className="text-sm text-muted-foreground">Failed to load blocking data.</p>
                <button
                    onClick={loadData}
                    className="text-xs px-3 py-1.5 rounded border border-border hover:bg-muted/50 transition-colors"
                >
                    Retry
                </button>
            </div>
        );
    }

    return (
        <BlockingGrid
            data={data.blocks}
            canViewPrices={data.canViewPrices}
        />
    );
}
