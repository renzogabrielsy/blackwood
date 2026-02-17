'use client';

import * as React from 'react';
import { cn } from '@/lib/utils';
import { useInventoryTab, type InventoryTab } from './inventory-tab-context';

const TABS: { name: string; id: InventoryTab }[] = [
    { name: 'Deliveries', id: 'deliveries' },
    { name: 'Usage', id: 'usage' },
    { name: 'Blocking', id: 'blocking' },
];

export function InventorySheetTabs() {
    const { activeTab, setActiveTab } = useInventoryTab();
    const containerRef = React.useRef<HTMLDivElement>(null);
    const buttonRefs = React.useRef<(HTMLButtonElement | null)[]>([]);
    const [indicator, setIndicator] = React.useState({ left: 0, width: 0 });

    const activeIndex = TABS.findIndex(t => t.id === activeTab);

    React.useEffect(() => {
        const container = containerRef.current;
        const target = buttonRefs.current[activeIndex];
        if (!container || !target) return;

        const containerRect = container.getBoundingClientRect();
        const targetRect = target.getBoundingClientRect();
        setIndicator({
            left: targetRect.left - containerRect.left,
            width: targetRect.width,
        });
    }, [activeIndex]);

    return (
        <div className="flex-none flex items-center px-3 py-1.5 border-t bg-muted/50 backdrop-blur-sm">
            <div
                ref={containerRef}
                className="relative flex items-center gap-1 bg-muted/40 rounded-lg border border-border/50 p-1"
            >
                {/* Sliding indicator */}
                <div
                    className="absolute rounded-md bg-zinc-800 dark:bg-zinc-200 shadow-sm transition-all duration-300 ease-in-out"
                    style={{
                        left: `${indicator.left}px`,
                        width: `${indicator.width}px`,
                        top: '4px',
                        bottom: '4px',
                    }}
                />
                {TABS.map((tab, i) => {
                    const isActive = activeTab === tab.id;
                    return (
                        <button
                            key={tab.id}
                            ref={(el) => { buttonRefs.current[i] = el; }}
                            type="button"
                            onClick={() => setActiveTab(tab.id)}
                            className={cn(
                                "relative z-10 px-3 py-1 text-xs font-medium rounded-md transition-colors duration-200",
                                isActive
                                    ? "text-background"
                                    : "text-muted-foreground hover:text-foreground"
                            )}
                        >
                            {tab.name}
                        </button>
                    );
                })}
            </div>
        </div>
    );
}
