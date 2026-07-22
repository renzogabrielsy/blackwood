import {
    fetchProductionEvents,
    fetchCenaproPeriods,
    fetchLedgerPage,
    fetchDailyPivotWindow,
    type LedgerAnchor,
} from './actions';
import { ProductionView } from './production-view';
import { ProductionEndlessSheet } from './production-endless-sheet';
import { ProductionEndlessPivots } from './production-endless-pivots';
import { parseScope, parseViewMode, plantViewOf } from './ledger-url';

// Server component — the Cenapro production ledger is governed by TWO orthogonal URL
// axes (a third, EDIT lock/unlock, lands in Phase 3). Every combination is valid and
// reachable — no view is exclusive to a scope.
//
//   • VIEW  (`?view=ledger|daily-w6|daily-w7`) — WHAT you look at.
//   • SCOPE (`?scope=endless|focus`) — HOW MUCH history is in view. `endless` is the
//     default and omits the param; a legacy `?focus=1` maps to `scope=focus` (back-compat).
//
// Routing (six combinations, no dead-ends):
//   1. endless + ledger        → the endless sheet (server-prefetched anchored window).
//   2. endless + daily-w6/w7   → the endless DAY-WINDOWED PIVOT (Phase 2B): server-prefetch
//      the first anchored day-window, render the virtualized day-blocks. Read-only.
//   3. focus + any view        → the existing month-scoped, EDITABLE ProductionView
//      (which itself switches ledger/W6/W7 on `?view=`). Unchanged behavior inside focus.
//
// URL params remain the state carrier (CLAUDE.md rule) — a shared URL reproduces the view.
export default async function CenaproProductionPage({
    searchParams,
}: {
    searchParams: Promise<{ year?: string; batch?: string; scope?: string; view?: string; focus?: string }>;
}) {
    const params = await searchParams;

    const periodsResult = await fetchCenaproPeriods();
    const periods = periodsResult.periods ?? [];

    // Resolve the active period. A valid ?year=&batch= wins; otherwise default to the
    // newest period. A malformed/stale pair falls through to the default (defensive).
    const urlYear = params.year ? Number.parseInt(params.year, 10) : NaN;
    const urlBatch = params.batch?.toUpperCase();
    const urlPeriodValid =
        Number.isInteger(urlYear) &&
        !!urlBatch &&
        periods.some((p) => p.batch_year === urlYear && p.batch === urlBatch);

    const selectedPeriod = urlPeriodValid
        ? { batch_year: urlYear, batch: urlBatch! }
        : periods[0] ?? null;

    // ── Axis resolution ───────────────────────────────────────────────────────────
    // Legacy `?focus=1` (the retired silo param) maps to the focus scope for back-compat.
    const scope = params.focus === '1' ? 'focus' : parseScope(params.scope);
    const view = parseViewMode(params.view);
    const plantView = plantViewOf(view); // 'W6' | 'W7' | null

    // ── endless + ledger → the endless sheet. Anchor-first: resolve the anchor from the
    // URL, then prefetch the FIRST keyset window server-side (already anchored). ──────
    if (scope === 'endless' && view === 'ledger') {
        const anchor: LedgerAnchor = urlPeriodValid
            ? { kind: 'period', batch_year: urlYear, batch: urlBatch! }
            : { kind: 'latest' };

        const page = await fetchLedgerPage({ mode: 'anchor', anchor });

        // Keying by the anchor forces a clean remount (fresh window + firstItemIndex) when
        // the dropdowns jump to a new period — a single, deterministic seeding path.
        const anchorKey = anchor.kind === 'latest' ? 'latest' : `${anchor.batch_year}:${anchor.batch}`;

        return (
            <ProductionEndlessSheet
                key={anchorKey}
                initialPage={{
                    rows: page.rows,
                    hasOlder: page.hasOlder,
                    hasNewer: page.hasNewer,
                    notice: page.notice,
                }}
                anchor={anchor}
                periods={periods}
                selectedPeriod={selectedPeriod}
                loadError={page.error ?? periodsResult.error ?? null}
            />
        );
    }

    // ── endless + daily-w6/w7 → the endless DAY-WINDOWED PIVOT. Anchor-first: prefetch the
    // FIRST day-window server-side (already anchored at the period's first day / newest
    // days), then render the virtualized day-blocks. Keyed by the anchor so a dropdown jump
    // forces a clean remount (fresh window + firstItemIndex), mirroring the endless ledger. ─
    if (scope === 'endless' && plantView) {
        const anchor: LedgerAnchor = urlPeriodValid
            ? { kind: 'period', batch_year: urlYear, batch: urlBatch! }
            : { kind: 'latest' };

        const dayWindow = await fetchDailyPivotWindow({ mode: 'anchor', anchor, plant: plantView });
        const anchorKey = anchor.kind === 'latest' ? 'latest' : `${anchor.batch_year}:${anchor.batch}`;

        return (
            <ProductionEndlessPivots
                key={`${plantView}:${anchorKey}`}
                initialWindow={{
                    events: dayWindow.events,
                    hasOlder: dayWindow.hasOlder,
                    hasNewer: dayWindow.hasNewer,
                    notice: dayWindow.notice,
                }}
                anchor={anchor}
                plantView={plantView}
                view={view}
                periods={periods}
                selectedPeriod={selectedPeriod}
                loadError={dayWindow.error ?? periodsResult.error ?? null}
            />
        );
    }

    // ── focus + any view → the month-scoped, EDITABLE ProductionView. The grid's own
    // toolbar carries the view switcher + scope toggle, so the axis framework stays
    // reachable here too. ─────────────────────────────────────────────────────────────
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
