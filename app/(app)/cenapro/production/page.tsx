import {
    fetchProductionEvents,
    fetchCenaproPeriods,
    fetchLedgerPage,
    type LedgerAnchor,
} from './actions';
import { ProductionView } from './production-view';
import { ProductionEndlessSheet } from './production-endless-sheet';
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
//   2. endless + daily-w6/w7   → Phase-1 fallback: the month-scoped daily block (option
//      (b), "transparently fall back to focus rendering") + a courtesy hint. Phase 2 will
//      replace this with the true day-windowed endless pivot.
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

    // ── Everything else → the month-scoped ProductionView. This serves FOCUS (any view)
    // AND the endless + daily-w6/w7 fallback (Phase 1). The grid's own toolbar carries the
    // view switcher + scope toggle, so the axis framework stays reachable here too. ─────
    const result = await fetchProductionEvents(selectedPeriod ?? undefined);
    const view3 = (
        <ProductionView
            rows={result.data ?? []}
            periods={periods}
            selectedPeriod={selectedPeriod}
            loadError={result.error ?? periodsResult.error ?? null}
        />
    );

    // In the endless + daily fallback, surface a small honest hint that the true endless
    // (cross-month) pivot is still coming — the block below is month-scoped this phase.
    if (scope === 'endless' && plantView) {
        return (
            <div className="flex h-full flex-col">
                <div className="flex flex-none items-center gap-2 border-b bg-muted/20 px-2 py-1 md:px-3">
                    <span className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground/70">
                        Endless {plantView} · coming in a later pass — showing this month
                    </span>
                </div>
                <div className="min-h-0 flex-1">{view3}</div>
            </div>
        );
    }

    return view3;
}
