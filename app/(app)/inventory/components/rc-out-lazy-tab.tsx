'use client';

import { useEffect, useState, useCallback, useRef } from 'react';
import { Loader2 } from 'lucide-react';
import { RcOutTableWrapper } from '../rc-out/components/rc-out-table-wrapper';
import { fetchRcOutTabData } from '../rc-out/actions';
import { errorToast } from '@/lib/toast';
import type { RcOutRow } from '@/types/rc-out';

type Batch = {
    id: string;
    batch_code: string;
    location_ref: string;
};

interface RcOutTabData {
    records: RcOutRow[];
    batches: Batch[];
    destinations: string[];
    batchOptions: string[];
    yearOptions: number[];
    blockLocs: string[];
    // Canonical server-side price gate (lib/auth.canViewPrices). FALSE for Production.
    // The price fields in `records` are already nulled server-side when this is false;
    // this flag is threaded through RcOutTableWrapper → RcOutTable to drive the
    // conditional render of the price columns/footer (single source of truth — the
    // table no longer self-derives via hasPermission).
    canViewPrices: boolean;
}

export function RcOutLazyTab() {
    const [data, setData] = useState<RcOutTabData | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(false);
    // Guards the initial-mount fetch against StrictMode double-invoke / re-mounts
    // once we already have good data.
    const hasFetchedRef = useRef(false);

    const loadData = useCallback(async () => {
        setLoading(true);
        setError(false);
        try {
            const result = await fetchRcOutTabData();
            setData(result);
            hasFetchedRef.current = true;
        } catch (err) {
            setError(true);
            errorToast('Failed to load Usage data.', {
                description: err instanceof Error ? err.message : String(err),
            });
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        if (hasFetchedRef.current) return;
        loadData();
    }, [loadData]);

    // Re-runs the same fetch; reused by the table's onRefresh and the retry button.
    const refetch = useCallback(async () => {
        await loadData();
    }, [loadData]);

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
                <p className="text-sm text-muted-foreground">Failed to load Usage data.</p>
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
        <RcOutTableWrapper
            data={data.records}
            batches={data.batches}
            destinations={data.destinations}
            batchOptions={data.batchOptions}
            yearOptions={data.yearOptions}
            blockLocs={data.blockLocs}
            canViewPrices={data.canViewPrices}
            onRefresh={refetch}
        />
    );
}
