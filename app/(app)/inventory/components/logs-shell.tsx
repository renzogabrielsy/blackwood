'use client';

import { Card, CardContent } from '@/components/ui/card';
import { InventorySheetTabs } from './sheet-tabs';
import { InventoryTabProvider } from './inventory-tab-context';

/**
 * The "logs" tab shell — wraps ONLY the `/inventory` page (Deliveries + Usage). Owns the
 * Card frame, the URL-driven `InventoryTabProvider`, and the bottom tab bar. The standalone
 * Blocking / RC Movement routes deliberately do NOT use this shell (they render their own
 * full-height container), keeping them free of the tab system.
 *
 * Moved out of `layout.tsx` so the shared inventory layout stays tab-shell-agnostic.
 */
export function LogsShell({ children }: { children: React.ReactNode }) {
    return (
        <InventoryTabProvider>
            <Card className="h-full flex flex-col gap-0 py-0 border-none shadow-xl">
                <CardContent className="flex-1 min-h-0 p-2 md:p-4 flex flex-col relative">
                    {children}
                </CardContent>
                <InventorySheetTabs />
            </Card>
        </InventoryTabProvider>
    );
}
