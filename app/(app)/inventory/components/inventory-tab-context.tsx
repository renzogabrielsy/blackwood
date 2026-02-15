'use client';

import { createContext, useContext, useState, type ReactNode } from 'react';

export type InventoryTab = 'deliveries' | 'usage' | 'blocking';

interface InventoryTabContextType {
    activeTab: InventoryTab;
    setActiveTab: (tab: InventoryTab) => void;
}

const InventoryTabContext = createContext<InventoryTabContextType | null>(null);

export function InventoryTabProvider({ children }: { children: ReactNode }) {
    const [activeTab, setActiveTab] = useState<InventoryTab>('deliveries');
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
