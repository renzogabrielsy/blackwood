import { Suspense } from 'react';
import { Loader2 } from 'lucide-react';
import { RcMovementRouteView } from './rc-movement-route-view';

/**
 * Standalone RC Movement route (`/inventory/rc-movement`). Renders the campaign-scoped
 * day×block feed matrix. Campaign lives in `?campaign=`; the matrix owns the picker.
 * No tab shell — see inventory/layout.tsx + components/logs-shell.tsx.
 */
export default function RcMovementPage() {
    return (
        <Suspense
            fallback={
                <div className="h-full w-full flex items-center justify-center">
                    <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
                </div>
            }
        >
            <RcMovementRouteView />
        </Suspense>
    );
}
