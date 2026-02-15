'use client';

import dynamic from 'next/dynamic';
import { Loader2 } from 'lucide-react';
import type { DeliveryHistoryRow } from '@/types/rc-in';

const DeliveryMasterTable = dynamic(
    () => import('../delivery-master-table').then(m => m.DeliveryMasterTable),
    {
        ssr: false,
        loading: () => (
            <div className="h-full w-full flex items-center justify-center">
                <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
            </div>
        ),
    }
);

interface DeliveryMasterTableWrapperProps {
    data: DeliveryHistoryRow[];
    batches: { id: string; batch_code: string; location_ref: string }[];
    search?: string;
    allSuppliers: string[];
    allLocations: string[];
}

export function DeliveryMasterTableWrapper(props: DeliveryMasterTableWrapperProps) {
    return <DeliveryMasterTable {...props} />;
}
