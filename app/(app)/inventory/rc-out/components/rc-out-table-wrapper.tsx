'use client';

import dynamic from 'next/dynamic';
import { Loader2 } from 'lucide-react';
import type { RcOutRow } from '@/types/rc-out';

const RcOutTable = dynamic(
    () => import('./rc-out-table').then(m => m.RcOutTable),
    {
        ssr: false,
        loading: () => (
            <div className="h-full w-full flex items-center justify-center">
                <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
            </div>
        ),
    }
);

type Batch = {
    id: string;
    batch_code: string;
    location_ref: string;
};

interface RcOutTableWrapperProps {
    data: RcOutRow[];
    search?: string;
    year?: string;
    month?: string;
    batches: Batch[];
    destinations: string[];
    productionBatches: string[];
}

export function RcOutTableWrapper(props: RcOutTableWrapperProps) {
    return <RcOutTable {...props} />;
}
