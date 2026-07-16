'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { ProductionLedgerGrid } from './production-ledger-grid';
import type { ProductionEventRow } from '../types';
import type { CenaproPeriod } from './actions';

interface ProductionViewProps {
    rows: ProductionEventRow[];
    periods: CenaproPeriod[];
    selectedPeriod: CenaproPeriod | null;
    loadError: string | null;
}

// Thin client wrapper. The server action's `revalidatePath('/cenapro/production')`
// re-runs the page fetch; `router.refresh()` pulls those fresh rows back into this
// tree. The grid is keyed by the row-set fingerprint so a successful save remounts it
// with the server's canonical state (new ids, computed unique_tag/batch_year applied)
// rather than leaving the optimistic local rows in place. The key also folds in the
// selected period, so switching period remounts the grid against the new period's rows
// with all dirty state cleared.
export function ProductionView({ rows, periods, selectedPeriod, loadError }: ProductionViewProps) {
    const router = useRouter();

    const handleSaveSuccess = React.useCallback(() => {
        router.refresh();
    }, [router]);

    // Fingerprint of the server data — changes after a save (once refreshed data lands)
    // or a period switch, forcing a clean remount so dirty-state borders reset against
    // the saved/scoped truth.
    const dataKey = React.useMemo(
        () =>
            `${selectedPeriod?.batch_year ?? ''}:${selectedPeriod?.batch ?? ''}:${rows.length}:${rows
                .map((r) => r.id ?? '')
                .join(',')}`,
        [rows, selectedPeriod],
    );

    return (
        <ProductionLedgerGrid
            key={dataKey}
            initialRows={rows}
            periods={periods}
            selectedPeriod={selectedPeriod}
            loadError={loadError}
            onSaveSuccess={handleSaveSuccess}
        />
    );
}
