import {
    fetchFlecInventory,
    fetchOpeningBalances,
    fetchOpeningBalanceHistory,
} from './actions';
import { FlecInventoryClient } from './flec-inventory-client';
import {
    FLEC_WAREHOUSES,
    DEFAULT_FLEC_WAREHOUSE,
    DEFAULT_FLEC_START_DATE,
    type FlecWarehouse,
} from '../types';

// Basic ISO-date guard so a malformed ?date= param can't be passed to the RPC.
function isIsoDate(v: string | undefined): v is string {
    return !!v && /^\d{4}-\d{2}-\d{2}$/.test(v);
}

// Server component — reads warehouse + start-date from URL search params
// (URL params drive state per project convention), fetches the editable opening
// balances (STARTING block seed), the current closing balances + movement ledger,
// and the full append-only opening history (for backtracking), then hands them to
// the client. Defaults to WHSE 7 @ 2026-03-10, where the seeded opening balances
// live, so the page opens on meaningful data.
export default async function CenaproInventoryPage({
    searchParams,
}: {
    searchParams: Promise<{ whse?: string; date?: string }>;
}) {
    const params = await searchParams;

    const warehouse: FlecWarehouse =
        params.whse && (FLEC_WAREHOUSES as readonly string[]).includes(params.whse)
            ? (params.whse as FlecWarehouse)
            : DEFAULT_FLEC_WAREHOUSE;

    const startDate = isIsoDate(params.date) ? params.date : DEFAULT_FLEC_START_DATE;

    // All four reads are independent — fetch in parallel. The START date is the
    // "as of" date for both the openings seed and the ledger seed (Renzo's rule:
    // the starting count is always relative to the chosen start date). History is
    // warehouse-scoped (date-independent) — it's the full backtracking trail.
    const [inventory, openings, history] = await Promise.all([
        fetchFlecInventory(warehouse, startDate),
        fetchOpeningBalances(warehouse, startDate),
        fetchOpeningBalanceHistory(warehouse),
    ]);

    return (
        <FlecInventoryClient
            warehouse={warehouse}
            startDate={startDate}
            balances={inventory.balances ?? []}
            ledger={inventory.ledger ?? []}
            openings={openings.openings ?? []}
            history={history.history ?? []}
            loadError={inventory.error ?? openings.error ?? history.error ?? null}
        />
    );
}
