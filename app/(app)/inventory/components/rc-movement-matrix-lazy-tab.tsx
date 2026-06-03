'use client';

import { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { RcMovementMatrix } from '../rc-movement/rc-movement-matrix';
import { fetchRcMovementMatrix, type RcMovementMatrix as RcMovementMatrixData } from '../rc-movement/actions';

/**
 * Lazy-mounting host for the RC Movement MATRIX inside the inventory tab system.
 *
 * Owns the selected cycle-month. `month` starts empty so the first fetch lets the
 * server action resolve its default (the most recent month with >2 feed days);
 * the resolved value comes back on `data.month` and the toolbar Select reflects it.
 * Re-fetches whenever the user picks a different month via `onMonthChange`.
 *
 * Mirrors the rc-out-lazy-tab pattern: fetch on first render, show a spinner while
 * loading, and stay mounted so tab switches preserve state (the parent keeps this
 * subtree mounted and just toggles visibility).
 */
export function RcMovementMatrixLazyTab() {
    // Empty string => server action resolves the default cycle-month.
    const [month, setMonth] = useState<string>('');
    const [data, setData] = useState<RcMovementMatrixData | null>(null);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        let mounted = true;
        setLoading(true);
        fetchRcMovementMatrix(month || undefined).then((result) => {
            if (mounted) {
                setData(result);
                setLoading(false);
            }
        });
        return () => {
            mounted = false;
        };
    }, [month]);

    if (loading && !data) {
        return (
            <div className="h-full w-full flex items-center justify-center">
                <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
            </div>
        );
    }

    if (!data) {
        return (
            <div className="h-full w-full flex items-center justify-center">
                <p className="text-sm text-muted-foreground">Failed to load movement data.</p>
            </div>
        );
    }

    return <RcMovementMatrix data={data} onMonthChange={setMonth} />;
}
