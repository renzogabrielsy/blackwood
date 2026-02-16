'use client';

import { cn } from '@/lib/utils';
import { useInventoryTab, type InventoryTab } from './inventory-tab-context';

const TABS: { name: string; id: InventoryTab }[] = [
    { name: 'Deliveries', id: 'deliveries' },
    { name: 'Usage', id: 'usage' },
    { name: 'Blocking', id: 'blocking' },
];

export function InventorySheetTabs() {
    const { activeTab, setActiveTab } = useInventoryTab();
    return (
        <div className="flex-none flex items-center gap-1 px-3 py-1.5 border-t bg-muted/30">
            {TABS.map(tab => {
                const isActive = activeTab === tab.id;
                return (
                    <button
                        key={tab.id}
                        type="button"
                        onClick={() => setActiveTab(tab.id)}
                        className={cn(
                            "px-3 py-1 text-xs font-medium rounded-md transition-all duration-200",
                            isActive
                                ? "bg-card text-foreground shadow-sm border border-border/50"
                                : "text-muted-foreground hover:text-foreground hover:bg-muted/50"
                        )}
                    >
                        {tab.name}
                    </button>
                );
            })}
        </div>
    );
}
