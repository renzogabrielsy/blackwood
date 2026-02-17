'use client';

import { useEffect, useState, useCallback } from 'react';
import { Loader2 } from 'lucide-react';
import { RcOutTableWrapper } from '../rc-out/components/rc-out-table-wrapper';
import { fetchRcOutTabData } from '../rc-out/actions';
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
}

export function RcOutLazyTab() {
    const [data, setData] = useState<RcOutTabData | null>(null);
    const [loading, setLoading] = useState(true);

    const loadData = useCallback(async () => {
        const result = await fetchRcOutTabData();
        setData(result);
        setLoading(false);
    }, []);

    useEffect(() => {
        let mounted = true;
        fetchRcOutTabData().then((result) => {
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
        <RcOutTableWrapper
            data={data.records}
            batches={data.batches}
            destinations={data.destinations}
            batchOptions={data.batchOptions}
            yearOptions={data.yearOptions}
            blockLocs={data.blockLocs}
            onRefresh={refetch}
        />
    );
}
