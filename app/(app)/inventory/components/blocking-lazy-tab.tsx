'use client';

import { useEffect, useState, useCallback } from 'react';
import { Loader2 } from 'lucide-react';
import { BlockingGrid } from '../blocking/blocking-grid';
import { fetchBlockingGridData } from '../blocking/actions';
import type { BlockingGridData } from '../blocking/types';

export function BlockingLazyTab() {
    const [data, setData] = useState<BlockingGridData | null>(null);
    const [loading, setLoading] = useState(true);

    const loadData = useCallback(async () => {
        const result = await fetchBlockingGridData();
        setData(result);
        setLoading(false);
    }, []);

    useEffect(() => {
        let mounted = true;
        fetchBlockingGridData().then((result) => {
            if (mounted) {
                setData(result);
                setLoading(false);
            }
        });
        return () => { mounted = false; };
    }, []);

    const refetch = useCallback(async () => {
        await loadData();
    }, [loadData]);

    if (loading || !data) {
        return (
            <div className="h-full w-full flex items-center justify-center">
                <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
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
