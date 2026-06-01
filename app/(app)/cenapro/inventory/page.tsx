import { fetchFlecInventory } from './actions';
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
// (URL params drive state per project convention), fetches balances + ledger,
// and hands them to the client. Defaults to WHSE 7 @ 2026-03-10, where the seeded
// opening balances live, so the page opens on meaningful data.
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

    const result = await fetchFlecInventory(warehouse, startDate);

    return (
        <FlecInventoryClient
            warehouse={warehouse}
            startDate={startDate}
            balances={result.balances ?? []}
            ledger={result.ledger ?? []}
            loadError={result.error ?? null}
        />
    );
}
