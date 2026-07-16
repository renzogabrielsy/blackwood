import { Suspense } from 'react';
import { Loader2 } from 'lucide-react';
import { BlockingRouteView } from './blocking-route-view';

/**
 * Standalone Blocking route (`/inventory/blocking`). Replaces the old "Coming soon" stub.
 * Renders the warehouse grid + the shared detail panel; selection lives in `?block=`.
 * No tab shell — see inventory/layout.tsx + components/logs-shell.tsx for why the tab bar
 * is scoped to the logs page only.
 */
export default function BlockingPage() {
    return (
        <Suspense
            fallback={
                <div className="h-full w-full flex items-center justify-center">
                    <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
                </div>
            }
        >
            <BlockingRouteView />
        </Suspense>
    );
}
