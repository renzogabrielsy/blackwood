'use client';

import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';

export type InventoryTab = 'deliveries' | 'usage' | 'blocking' | 'movement';

const VALID_TABS: InventoryTab[] = ['deliveries', 'usage', 'blocking', 'movement'];
const STORAGE_KEY = 'inventory_active_tab';

interface InventoryTabContextType {
    activeTab: InventoryTab;
    setActiveTab: (tab: InventoryTab) => void;
}

const InventoryTabContext = createContext<InventoryTabContextType | null>(null);

export function InventoryTabProvider({ children }: { children: ReactNode }) {
    const [activeTab, setActiveTabState] = useState<InventoryTab>('deliveries');

    // Sync from localStorage after hydration (avoids SSR mismatch)
    useEffect(() => {
        const stored = localStorage.getItem(STORAGE_KEY);
        if (stored && VALID_TABS.includes(stored as InventoryTab)) {
            setActiveTabState(stored as InventoryTab);
        }
    }, []);

    const setActiveTab = useCallback((tab: InventoryTab) => {
        setActiveTabState(tab);
        localStorage.setItem(STORAGE_KEY, tab);
    }, []);

    return (
        <InventoryTabContext.Provider value={{ activeTab, setActiveTab }}>
            {children}
        </InventoryTabContext.Provider>
    );
}

export function useInventoryTab() {
    const ctx = useContext(InventoryTabContext);
    if (!ctx) throw new Error('useInventoryTab must be used within InventoryTabProvider');
    return ctx;
}
