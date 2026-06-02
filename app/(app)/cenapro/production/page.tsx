import { fetchProductionEvents, fetchCenaproPeriods } from './actions';
import { ProductionView } from './production-view';

// Server component — resolves the selected production period from the URL, loads ONLY
// that period's rows (the perf fix — one batch-month at a time instead of all 750+),
// and hands them plus the available-period list to the editable client ledger. The
// grid does all WITHIN-period filtering/sorting in the browser and writes back via the
// `saveProductionEvents` server action.
//
// Period selection: `?year=&batch=` drive state (URL params, per project convention).
// When absent, default to the NEWEST period (`periods[0]` — fetchCenaproPeriods sorts
// newest-first) so the page opens fast on the most recent month rather than the whole
// dataset. An explicit URL param always wins; the default is only the fallback.
export default async function CenaproProductionPage({
    searchParams,
}: {
    searchParams: Promise<{ year?: string; batch?: string }>;
}) {
    const params = await searchParams;

    const periodsResult = await fetchCenaproPeriods();
    const periods = periodsResult.periods ?? [];

    // Resolve the active period. A valid ?year=&batch= wins; otherwise default to the
    // newest period. A year param that doesn't parse, or a (year, batch) pair not in
    // the available set, falls through to the default too (defensive against stale links).
    const urlYear = params.year ? Number.parseInt(params.year, 10) : NaN;
    const urlBatch = params.batch?.toUpperCase();
    const urlPeriodValid =
        Number.isInteger(urlYear) &&
        !!urlBatch &&
        periods.some((p) => p.batch_year === urlYear && p.batch === urlBatch);

    const selectedPeriod = urlPeriodValid
        ? { batch_year: urlYear, batch: urlBatch! }
        : periods[0] ?? null;

    const result = await fetchProductionEvents(selectedPeriod ?? undefined);

    return (
        <ProductionView
            rows={result.data ?? []}
            periods={periods}
            selectedPeriod={selectedPeriod}
            loadError={result.error ?? periodsResult.error ?? null}
        />
    );
}
