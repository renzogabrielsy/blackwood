import { fetchProductionEvents } from './actions';
import { ProductionTable } from './production-table';

// Server component — fetches the full production_event spine once and hands it to
// the client table. The table does all filtering/sorting in the browser.
export default async function CenaproProductionPage() {
    const result = await fetchProductionEvents();

    return (
        <ProductionTable
            rows={result.data ?? []}
            loadError={result.error ?? null}
        />
    );
}
