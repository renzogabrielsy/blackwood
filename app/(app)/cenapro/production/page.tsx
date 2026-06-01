import { fetchProductionEvents } from './actions';
import { ProductionView } from './production-view';

// Server component — fetches the full production_event spine once and hands it to the
// editable client ledger. The grid does all filtering/sorting in the browser and
// writes back via the `saveProductionEvents` server action.
export default async function CenaproProductionPage() {
    const result = await fetchProductionEvents();

    return (
        <ProductionView
            rows={result.data ?? []}
            loadError={result.error ?? null}
        />
    );
}
