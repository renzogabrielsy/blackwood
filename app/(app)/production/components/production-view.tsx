'use client';

import { useState, useEffect } from 'react';
import { useProductionTab, type ProductionTab } from './production-tab-context';

// Lazy tab wrappers — each fetches its own data on first activation
import { DailyLazyTab } from './daily-lazy-tab';
import { ElectricityLazyTab } from './electricity-lazy-tab';
import { TrucksLazyTab } from './trucks-lazy-tab';

/**
 * `?grid=` — which implementation of each tab's grid renders. Read once by the server
 * page and threaded down; see `app/(app)/production/(tabs)/page.tsx`.
 *
 * **REQUIRED, and that is the point.** These tabs default to v2 (2026-08-26), and the
 * page states that default in the one expression that reads the param. A `v2 = false`
 * fallback here would be a second, contradicting statement of it — silent whenever a
 * caller forgot the prop, which is exactly the case a default is supposed to cover.
 */
export interface ProductionViewProps {
    v2: boolean;
}

export function ProductionView({ v2 }: ProductionViewProps) {
    const { activeTab } = useProductionTab();
    const [displayTab, setDisplayTab] = useState<ProductionTab>(activeTab);
    const [transitioning, setTransitioning] = useState(false);

    useEffect(() => {
        if (activeTab === displayTab) return;
        setTransitioning(true);
        const t = setTimeout(() => {
            setDisplayTab(activeTab);
            setTransitioning(false);
        }, 150);
        return () => clearTimeout(t);
    }, [activeTab]); // eslint-disable-line react-hooks/exhaustive-deps

    const getTabClass = (tabId: ProductionTab, extraClasses = '') => {
        const isVisible = displayTab === tabId;
        if (!isVisible) return 'absolute inset-0 invisible opacity-0 pointer-events-none';
        const base = `flex flex-col flex-1 min-h-0 transition-opacity duration-150 ease-in-out overflow-y-auto ${extraClasses}`.trim();
        return transitioning
            ? `${base} opacity-0 pointer-events-none`
            : `${base} opacity-100`;
    };

    return (
        <>
            <div className={getTabClass('daily')}>
                <DailyLazyTab v2={v2} />
            </div>
            <div className={getTabClass('electricity')}>
                <ElectricityLazyTab v2={v2} />
            </div>
            <div className={getTabClass('trucks')}>
                <TrucksLazyTab v2={v2} />
            </div>
        </>
    );
}
