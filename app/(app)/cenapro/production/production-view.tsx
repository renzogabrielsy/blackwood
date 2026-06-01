'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { ProductionLedgerGrid } from './production-ledger-grid';
import type { ProductionEventRow } from '../types';

interface ProductionViewProps {
    rows: ProductionEventRow[];
    loadError: string | null;
}

// Thin client wrapper. The server action's `revalidatePath('/cenapro/production')`
// re-runs the page fetch; `router.refresh()` pulls those fresh rows back into this
// tree. The grid is keyed by the row-set fingerprint so a successful save remounts it
// with the server's canonical state (new ids, computed unique_tag/batch_year applied)
// rather than leaving the optimistic local rows in place.
export function ProductionView({ rows, loadError }: ProductionViewProps) {
    const router = useRouter();

    const handleSaveSuccess = React.useCallback(() => {
        router.refresh();
    }, [router]);

    // Fingerprint of the server data — changes after a save once refreshed data lands,
    // forcing a clean remount so dirty-state borders reset against the saved truth.
    const dataKey = React.useMemo(
        () => `${rows.length}:${rows.map((r) => r.id ?? '').join(',')}`,
        [rows],
    );

    return (
        <ProductionLedgerGrid
            key={dataKey}
            initialRows={rows}
            loadError={loadError}
            onSaveSuccess={handleSaveSuccess}
        />
    );
}
