'use client';

import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';

export type ProductionTab = 'daily' | 'electricity' | 'trucks';

const VALID_TABS: ProductionTab[] = ['daily', 'electricity', 'trucks'];
const STORAGE_KEY = 'production_active_tab';

interface ProductionTabContextType {
    activeTab: ProductionTab;
    setActiveTab: (tab: ProductionTab) => void;
}

const ProductionTabContext = createContext<ProductionTabContextType | null>(null);

export function ProductionTabProvider({ children }: { children: ReactNode }) {
    const [activeTab, setActiveTabState] = useState<ProductionTab>('daily');

    // Sync from localStorage after hydration (avoids SSR mismatch)
    useEffect(() => {
        const stored = localStorage.getItem(STORAGE_KEY);
        if (stored && VALID_TABS.includes(stored as ProductionTab)) {
            setActiveTabState(stored as ProductionTab);
        }
    }, []);

    const setActiveTab = useCallback((tab: ProductionTab) => {
        setActiveTabState(tab);
        localStorage.setItem(STORAGE_KEY, tab);
    }, []);

    return (
        <ProductionTabContext.Provider value={{ activeTab, setActiveTab }}>
            {children}
        </ProductionTabContext.Provider>
    );
}

export function useProductionTab() {
    const ctx = useContext(ProductionTabContext);
    if (!ctx) throw new Error('useProductionTab must be used within ProductionTabProvider');
    return ctx;
}
