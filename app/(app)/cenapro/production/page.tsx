import {
    fetchProductionEvents,
    fetchCenaproPeriods,
    fetchLedgerPage,
    fetchDailyPivotWindow,
    type LedgerAnchor,
} from './actions';
import { GridVersionBar } from '@/components/shared/table';
import { GRID_V2, parseGrid } from '@/lib/table';
import { ProductionView } from './production-view';
import { ProductionEndlessSheet } from './production-endless-sheet';
import { ProductionEndlessPivots } from './production-endless-pivots';
import { ProductionEndlessSheetV2 } from './production-endless-sheet-v2';
import { ProductionLedgerGridV2 } from './production-ledger-grid-v2';
import {
    hasActiveFilters,
    ledgerFilterKey,
    parseLedgerFilters,
    parseScope,
    parseViewMode,
    plantViewOf,
} from './ledger-url';

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
    // The filter axis adds six optional params (shift/grade/plant/whse/src/ccc) — typed
    // loosely here and parsed by `parseLedgerFilters`, which owns their contract.
    searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
    const params = await searchParams;

    const periodsResult = await fetchCenaproPeriods();
    const periods = periodsResult.periods ?? [];

    // A repeated param arrives as an array — take the first, defensively.
    const one = (v: string | string[] | undefined): string | undefined =>
        Array.isArray(v) ? v[0] : v;

    // Resolve the active period. A valid ?year=&batch= wins; otherwise default to the
    // newest period. A malformed/stale pair falls through to the default (defensive).
    const rawYear = one(params.year);
    const urlYear = rawYear ? Number.parseInt(rawYear, 10) : NaN;
    const urlBatch = one(params.batch)?.toUpperCase();
    const urlPeriodValid =
        Number.isInteger(urlYear) &&
        !!urlBatch &&
        periods.some((p) => p.batch_year === urlYear && p.batch === urlBatch);

    const selectedPeriod = urlPeriodValid
        ? { batch_year: urlYear, batch: urlBatch! }
        : periods[0] ?? null;

    // ── Axis resolution ───────────────────────────────────────────────────────────
    // Legacy `?focus=1` (the retired silo param) maps to the focus scope for back-compat.
    const scope = one(params.focus) === '1' ? 'focus' : parseScope(one(params.scope));
    const view = parseViewMode(one(params.view));
    const plantView = plantViewOf(view); // 'W6' | 'W7' | null

    // ── FILTER axis ───────────────────────────────────────────────────────────────
    // Parsed here on the SERVER so the endless scope can push the predicates into the
    // keyset query (`fetchLedgerPage`) rather than hiding rows after the fact. The daily
    // W6/W7 pivots ignore filters (they own their own plant-source filtering) — the params
    // simply ride along in the URL so switching back to the ledger restores them.
    const filters = parseLedgerFilters((name) => params[name]);
    const filtersActive = hasActiveFilters(filters);
    // Folded into the endless-sheet React key so a filter change remounts cleanly with the
    // server-prefetched FILTERED first window — same deterministic seeding path the period
    // anchor already uses, and it resets `firstItemIndex` by construction (no scroll jump).
    const filterKey = ledgerFilterKey(filters);

    // ── The `?grid=v2` side-by-side axis (temporary; see `lib/table/grid-param.ts`) ──
    //
    // An axis of the CLIENT, never of the data: both implementations read the identical
    // server payload below, and nothing here reaches a query, an action or a role gate. The
    // param's ONLY effect is which component renders the rows that were fetched either way.
    //
    // The bar is mounted at EVERY return, so the toggle exists on all six view × scope
    // combinations and there is no dead end. It only SWITCHES anything on the two LEDGER
    // combinations, because the Daily W6 / W7 pivots are merged-`rowSpan` matrices rather
    // than ledgers and have no v2 — so on those two the note says so out loud rather than
    // letting the operator click a control that appears to do nothing.
    const v2 = parseGrid(params.grid) === GRID_V2;
    const gridBar = (
        <GridVersionBar
            note={
                plantView
                    ? 'The Daily W6 / W7 pivots have no v2 grid yet — this switch changes nothing on this view.'
                    : 'Same rows, same filters — this switches only which table renders them.'
            }
        />
    );

    // ── endless + ledger → the endless sheet. Anchor-first: resolve the anchor from the
    // URL, then prefetch the FIRST keyset window server-side (already anchored). ──────
    if (scope === 'endless' && view === 'ledger') {
        const anchor: LedgerAnchor = urlPeriodValid
            ? { kind: 'period', batch_year: urlYear, batch: urlBatch! }
            : { kind: 'latest' };

        const page = await fetchLedgerPage({ mode: 'anchor', anchor, filters });

        // Keying by the anchor forces a clean remount (fresh window + firstItemIndex) when
        // the dropdowns jump to a new period — a single, deterministic seeding path. The
        // filter fingerprint joins it for exactly the same reason.
        const anchorKey = anchor.kind === 'latest' ? 'latest' : `${anchor.batch_year}:${anchor.batch}`;

        // ONE props object, handed to whichever sheet the flag picked — so the two sides are
        // provably reading the identical payload rather than two similar-looking ones.
        const endlessProps = {
            initialPage: {
                rows: page.rows,
                hasOlder: page.hasOlder,
                hasNewer: page.hasNewer,
                notice: page.notice,
            },
            anchor,
            filters,
            filtersActive,
            periods,
            selectedPeriod,
            loadError: page.error ?? periodsResult.error ?? null,
        };

        return (
            <>
                {gridBar}
                {v2 ? (
                    <ProductionEndlessSheetV2 key={`${anchorKey}|${filterKey}`} {...endlessProps} />
                ) : (
                    <ProductionEndlessSheet key={`${anchorKey}|${filterKey}`} {...endlessProps} />
                )}
            </>
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

        // NO v2 branch: a day-windowed pivot is a merged-`rowSpan` matrix, not a ledger. The
        // bar still mounts (no dead ends), and its note says the switch does nothing here.
        return (
            <>
                {gridBar}
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
            </>
        );
    }

    // ── focus + any view → the month-scoped, EDITABLE ProductionView. The grid's own
    // toolbar carries the view switcher + scope toggle, so the axis framework stays
    // reachable here too. ─────────────────────────────────────────────────────────────
    //
    // `?grid=v2` substitutes the read-only Blackwood-Table ledger for the LEDGER view only.
    // On `daily-w6` / `daily-w7` the live `ProductionView` keeps rendering, because it is
    // what owns the merged-`rowSpan` daily pivot and there is no v2 of that shape.
    const result = await fetchProductionEvents(selectedPeriod ?? undefined);
    const focusProps = {
        rows: result.data ?? [],
        periods,
        selectedPeriod,
        loadError: result.error ?? periodsResult.error ?? null,
    };

    if (v2 && !plantView) {
        return (
            <>
                {gridBar}
                <ProductionLedgerGridV2 {...focusProps} />
            </>
        );
    }

    return (
        <>
            {gridBar}
            <ProductionView {...focusProps} />
        </>
    );
}
