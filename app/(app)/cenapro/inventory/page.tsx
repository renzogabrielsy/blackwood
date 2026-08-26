import {
    fetchFlecInventory,
    fetchOpeningBalances,
    fetchOpeningBalanceHistory,
    fetchGradeCodes,
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

// RETIRED 2026-08-20 — the `?grid=v2` universal-table preview of this screen.
// Renzo's call on the live review: "You can take out the v2 for flec inventory
// cenapro. I don't think it's appropriate and I think it needs customized
// behavior that is more niche than the table we're making." The custom behaviour
// stays on the bespoke `FlecInventoryClient` below, which was never edited for
// the preview and is once again the ONLY renderer of this route. `?grid=` is now
// INERT here — an unread search param, never an error.

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

    // All reads are independent — fetch in parallel. The START date is the "as of"
    // date for both the openings seed and the ledger seed (Renzo's rule: the starting
    // count is always relative to the chosen start date). History is warehouse-scoped
    // (date-independent) — it's the full backtracking trail.
    //
    // The GRADE list (2026-08-26) is read from `public.cenapro_grades` rather than the
    // `GRADE_CODES` constant, because grades are addable from this screen now and a
    // grade added there must appear without anyone editing a file. It is warehouse- and
    // date-independent, so it joins the same parallel batch.
    const [inventory, openings, history, grades] = await Promise.all([
        fetchFlecInventory(warehouse, startDate),
        fetchOpeningBalances(warehouse, startDate),
        fetchOpeningBalanceHistory(warehouse),
        fetchGradeCodes(),
    ]);

    return (
        <FlecInventoryClient
            warehouse={warehouse}
            startDate={startDate}
            balances={inventory.balances ?? []}
            ledger={inventory.ledger ?? []}
            openings={openings.openings ?? []}
            history={history.history ?? []}
            gradeCodes={grades.codes}
            loadError={inventory.error ?? openings.error ?? history.error ?? null}
            // Kept OUT of `loadError` on purpose: a grade read that fell back to the
            // seeded list is a caption, not a broken page, and folding it in would flip
            // the balance/ledger empty-states to "No data to display."
            gradesError={grades.error ?? null}
        />
    );
}
