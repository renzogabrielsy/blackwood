'use client';

import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import {
    INVENTORY_NAVIGATE_EVENT,
    type BlockingDetailNavTarget,
} from '../_shared/blocking-detail-panel';

export type InventoryTab = 'deliveries' | 'usage';

const VALID_TABS: InventoryTab[] = ['deliveries', 'usage'];
const DEFAULT_TAB: InventoryTab = 'deliveries';
const STORAGE_KEY = 'inventory_active_tab';

function isValidTab(value: string | null | undefined): value is InventoryTab {
    return !!value && VALID_TABS.includes(value as InventoryTab);
}

interface InventoryTabContextType {
    activeTab: InventoryTab;
    setActiveTab: (tab: InventoryTab) => void;
}

const InventoryTabContext = createContext<InventoryTabContextType | null>(null);

/**
 * Tab state lives in the URL (`?tab=deliveries|usage`) — the source of truth, per the
 * project's search-param convention (same useSearchParams + router.replace house style
 * as the RC IN table; deliberately NOT the nuqs library). localStorage is a FALLBACK only:
 * it seeds the initial tab when the URL has no `?tab=` param, so a returning user lands on
 * their last tab, but any explicit `?tab=` in the URL always wins and is deep-linkable.
 */
export function InventoryTabProvider({ children }: { children: ReactNode }) {
    const router = useRouter();
    const pathname = usePathname();
    const searchParams = useSearchParams();

    const tabParam = searchParams.get('tab');
    // The URL param is authoritative when present and valid; otherwise default.
    const activeTab: InventoryTab = isValidTab(tabParam) ? tabParam : DEFAULT_TAB;

    // First-load fallback: when the URL has no `?tab=`, restore the last tab from
    // localStorage by writing it into the URL (replace, no history entry). Runs once
    // after hydration to avoid an SSR mismatch. An explicit `?tab=` in the URL skips this.
    const [restoredFromStorage, setRestoredFromStorage] = useState(false);
    useEffect(() => {
        if (restoredFromStorage) return;
        setRestoredFromStorage(true);
        if (tabParam !== null) return; // URL already drives the tab
        const stored = localStorage.getItem(STORAGE_KEY);
        if (isValidTab(stored) && stored !== DEFAULT_TAB) {
            const params = new URLSearchParams(searchParams.toString());
            params.set('tab', stored);
            router.replace(`${pathname}?${params.toString()}`, { scroll: false });
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [restoredFromStorage]);

    const setActiveTab = useCallback(
        (tab: InventoryTab) => {
            localStorage.setItem(STORAGE_KEY, tab);
            const params = new URLSearchParams(searchParams.toString());
            params.set('tab', tab);
            router.replace(`${pathname}?${params.toString()}`, { scroll: false });
        },
        [router, pathname, searchParams],
    );

    // Listen for the shell-agnostic navigation event emitted by the shared
    // BlockingDetailPanel ("Edit All" buttons) when it's rendered on a standalone route
    // (Blocking / RC Movement). The panel imports nothing from this shell — it announces
    // intent on `window`; we translate it into a tab switch so the deep-link the panel
    // also pushes (`/inventory?...`) lands on the right view.
    useEffect(() => {
        const handler = (e: Event) => {
            const detail = (e as CustomEvent<BlockingDetailNavTarget>).detail;
            if (detail?.view === 'deliveries') setActiveTab('deliveries');
            else if (detail?.view === 'usage') setActiveTab('usage');
        };
        window.addEventListener(INVENTORY_NAVIGATE_EVENT, handler);
        return () => window.removeEventListener(INVENTORY_NAVIGATE_EVENT, handler);
    }, [setActiveTab]);

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
