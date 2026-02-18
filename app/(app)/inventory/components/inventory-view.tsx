'use client';

import { useState, useEffect } from 'react';
import { useInventoryTab, type InventoryTab } from './inventory-tab-context';
import { DeliveryMasterTableWrapper } from '../rc-in/components/delivery-master-table-wrapper';
import { RcOutLazyTab } from './rc-out-lazy-tab';
import { BlockingLazyTab } from './blocking-lazy-tab';
import type { DeliveryHistoryRow } from '@/types/rc-in';
import type { RcInTableSettings } from '@/types/table-settings';

interface InventoryViewProps {
    deliveries: DeliveryHistoryRow[];
    batches: { id: string; batch_code: string; location_ref: string }[];
    search?: string;
    allSuppliers: string[];
    allLocations: string[];
    initialSettings: RcInTableSettings;
}

export function InventoryView({ deliveries, batches, search, allSuppliers, allLocations, initialSettings }: InventoryViewProps) {
    const { activeTab } = useInventoryTab();
    const [displayTab, setDisplayTab] = useState<InventoryTab>(activeTab);
    const [transitioning, setTransitioning] = useState(false);

    useEffect(() => {
        if (activeTab === displayTab) return;
        setTransitioning(true); // fade out current tab
        const t = setTimeout(() => {
            setDisplayTab(activeTab);  // swap content
            setTransitioning(false);   // fade in new tab
        }, 150);
        return () => clearTimeout(t);
    }, [activeTab]); // eslint-disable-line react-hooks/exhaustive-deps

    const getTabClass = (tabId: InventoryTab, extraClasses = '') => {
        const isVisible = displayTab === tabId;
        if (!isVisible) return 'absolute inset-0 invisible opacity-0 pointer-events-none';
        const base = `flex flex-col flex-1 min-h-0 transition-opacity duration-150 ease-in-out ${extraClasses}`.trim();
        return transitioning
            ? `${base} opacity-0 pointer-events-none`
            : `${base} opacity-100`;
    };

    return (
        <>
            <div className={getTabClass('blocking', 'overflow-y-auto')}>
                <BlockingLazyTab />
            </div>
            <div className={getTabClass('deliveries')}>
                <DeliveryMasterTableWrapper
                    data={deliveries}
                    batches={batches}
                    search={search}
                    allSuppliers={allSuppliers}
                    allLocations={allLocations}
                    initialSettings={initialSettings}
                />
            </div>
            <div className={getTabClass('usage')}>
                <RcOutLazyTab />
            </div>
        </>
    );
}
