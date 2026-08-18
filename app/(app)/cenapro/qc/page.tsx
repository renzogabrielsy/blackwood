import { resolveQcMonth } from '@/lib/cenapro/ccc-analysis-view';

import { loadQcDrawOptions, loadQcLedgerData, loadQcMonthKeys } from './data';
import { LoadError } from './load-error';
import { QcLedgerClient } from './qc-ledger-client';
import { QcLedgerGridV2 } from './qc-ledger-grid-v2';
import { GridVersionBar } from '@/components/shared/table';
import { GRID_V2, parseGrid } from '@/lib/table';

// ─────────────────────────────────────────────────────────────────────────────────
// QC Ledger (`/cenapro/qc`) — the ENTRY surface for CCC's partner lab results.
//
// The CCC-CI ANALYSIS sheet as a live grid: every partner receipt of the selected
// month, grouped into the (date · source · effective warehouse) samples a lab reading
// actually covers, with the four metric columns editable and every other column
// reference-only.
//
// Server component: fetch, hand off. Every total and weighted average comes from the
// SQL aggregate views (`scope='all'` here — the entry surface shows everything an
// operator can type against, DVO included). See `./data.ts`.
// ─────────────────────────────────────────────────────────────────────────────────

export const dynamic = 'force-dynamic';

export default async function QcLedgerPage({
    searchParams,
}: {
    searchParams: Promise<{ m?: string; grid?: string }>;
}) {
    const params = await searchParams;
    const { monthKeys, error: monthsError } = await loadQcMonthKeys();
    const month = resolveQcMonth(monthKeys, params.m);
    // The ledger read and the ADD form's dimension lists are independent — one round
    // trip, not two in series.
    const [data, drawOptions] = await Promise.all([
        loadQcLedgerData(month, monthKeys),
        loadQcDrawOptions(),
    ]);
    const error = monthsError ?? data.error ?? drawOptions.error;

    // ── WHICH GRID (`?grid=v2`) ──────────────────────────────────────────────────
    // `QcLedgerGridV2` is this same screen rendered through `BlackwoodTable`, built
    // BESIDE the existing client rather than replacing it. The DEFAULT is unchanged:
    // no `?grid=v2` means byte-identical behaviour to before it existed. ONE props
    // object is built and spread into whichever component the flag picks, so the two
    // sides provably read the identical payload.
    const v2 = parseGrid(params.grid) === GRID_V2;

    const gridProps = {
        month: data.month,
        days: data.days,
        monthAgg: data.monthAgg,
        monthKeys: data.monthKeys,
        previousWtd: data.previousWtd,
        previousLabel: data.previousLabel,
        drawOptions,
    };

    return (
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
            {error ? (
                <div className="p-4">
                    <LoadError message={error} />
                </div>
            ) : null}
            <GridVersionBar note="Same month, same draws — this switches only which table renders them." />
            {v2 ? (
                <QcLedgerGridV2 {...gridProps} />
            ) : (
                <QcLedgerClient {...gridProps} />
            )}
        </div>
    );
}
