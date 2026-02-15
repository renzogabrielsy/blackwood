'use client';

import { useInventoryTab } from './inventory-tab-context';
import { DeliveryMasterTableWrapper } from '../rc-in/components/delivery-master-table-wrapper';
import { RcOutLazyTab } from './rc-out-lazy-tab';
import type { DeliveryHistoryRow } from '@/types/rc-in';

interface InventoryViewProps {
    deliveries: DeliveryHistoryRow[];
    batches: { id: string; batch_code: string; location_ref: string }[];
    search?: string;
    allSuppliers: string[];
    allLocations: string[];
}

export function InventoryView({ deliveries, batches, search, allSuppliers, allLocations }: InventoryViewProps) {
    const { activeTab } = useInventoryTab();

    return (
        <>
            <div className={activeTab === 'deliveries' ? 'flex flex-col flex-1 min-h-0' : 'absolute inset-0 invisible pointer-events-none'}>
                <DeliveryMasterTableWrapper
                    data={deliveries}
                    batches={batches}
                    search={search}
                    allSuppliers={allSuppliers}
                    allLocations={allLocations}
                />
            </div>
            <div className={activeTab === 'usage' ? 'flex flex-col flex-1 min-h-0' : 'absolute inset-0 invisible pointer-events-none'}>
                <RcOutLazyTab />
            </div>
            <div className={activeTab === 'blocking' ? 'flex flex-col flex-1 min-h-0 items-center justify-center' : 'absolute inset-0 invisible pointer-events-none'}>
                <div className="text-muted-foreground text-sm">Coming soon</div>
            </div>
        </>
    );
}
