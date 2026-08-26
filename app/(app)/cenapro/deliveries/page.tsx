import {
    fetchDeliveryDimensions,
    fetchDeliveryMonth,
    fetchDeliveryMonthKeys,
    fetchDeliveryPage,
    type DeliveryAnchor,
} from './actions';
import { fetchPaymentDimensions } from '../liquidation/actions';
import { isPrivileged } from '@/lib/auth';
import { GridVersionBar, PeriodPicker } from '@/components/shared/table';
import { GRID_V1, GRID_V2, resolveGrid } from '@/lib/table';
import { DeliveriesLedger } from './deliveries-ledger';
import { DeliveriesGridV2 } from './deliveries-grid-v2';
import { DeliveriesScopeToggle } from './scope-toggle';
import {
    axesKey,
    parseColumnFilters,
    parseIssueLens,
    parseQuery,
    parseScope,
    resolvePeriod,
} from './ledger-url';

// ─────────────────────────────────────────────────────────────────────────────────
// RC Deliveries (`/cenapro/deliveries`) — Cenapro's raw-charcoal receipt ledger.
//
// Server component: resolve the URL axes, fetch, hand off. The client never talks to
// Supabase, and — critically — the ₱ columns are already NULLED in this payload when
// the viewer's role cannot see prices (`canViewPrices()` inside the fetchers). A gated
// viewer's network response contains no money at all.
//
// Two orthogonal axes, every combination valid:
//   • SCOPE  (`?scope=endless|focus`) — endless is the default and omits the param.
//   • PERIOD (`?year=&month=`) — the focus scope's month; preserved across a scope flip.
// Plus the data-quality lens (`?issue=`) and free-text search (`?q=`), which apply in
// BOTH scopes and are pushed into the SQL query rather than filtering after the fact.
//
// This page renders no title of its own — the navbar owns page titles (see
// `getBreadcrumb()` in `components/navbar.tsx`).
// ─────────────────────────────────────────────────────────────────────────────────

export const dynamic = 'force-dynamic';

/**
 * The years the period dropdown offers — every year the MONTH INDEX holds, newest first.
 *
 * Derived from `fetchDeliveryMonthKeys()`, never a hard-coded range and never the loaded
 * rows: the endless scope holds a WINDOW of history, so deriving the list from what
 * happens to be on screen would offer only the years the pager had already walked. There
 * is deliberately no `+ current year` clause (unlike the QC ledger, where an empty month
 * is where the first draw of a new month has to land) — this ledger's receipts arrive by
 * import and by typing into the sheet, and `resolvePeriod` only honours a period the
 * index actually contains, so a year with no receipts is not a place the focus scope can
 * go. A year the URL names that the index does not hold is prepended by the control
 * itself, so the trigger can never read empty for a period the page is genuinely showing.
 */
function yearsOf(monthKeys: readonly string[]): number[] {
    const years = new Set<number>();
    for (const key of monthKeys) {
        const y = Number(key.slice(0, 4));
        if (Number.isFinite(y)) years.add(y);
    }
    return [...years].sort((a, b) => b - a);
}

export default async function CenaproDeliveriesPage({
    searchParams,
}: {
    searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
    const params = await searchParams;

    const scope = parseScope(params.scope);
    const issue = parseIssueLens(params.issue);
    const query = parseQuery(params.q);
    // `?f_<column>=…`, one param per filterable column. Parsed against the column table
    // in `types.ts`, so a param naming an unfilterable column (`?f_php_kg=…`) is dropped
    // rather than honoured — a filter is never a price oracle.
    const filters = parseColumnFilters(params);

    // ── WHICH GRID (`?grid=`) ────────────────────────────────────────────────────
    //
    // **This screen's DEFAULT is v2.** `?grid=` absent, misspelt, `V2` or `3` all mean the
    // NEW table; the Classic ledger is `?grid=v1` — a DEFAULT FLIP, not a cutover:
    // nothing is deleted, `DeliveriesLedger` stays mounted, fully reachable and fully
    // functional, and it remains where search, the issue lenses, the per-column filter
    // popovers and the three dialogs (history / assign cheque / delete) live until those
    // land on v2.
    //
    // Both branches below hand the two components the IDENTICAL prop set — v2 imports
    // `DeliveriesLedgerProps` rather than re-declaring it — and both read the same server
    // data. No action, RPC or query changes with the flag; it decides only which component
    // renders the payload.
    //
    // The default is stated exactly ONCE, here, at the single place the param is read —
    // and `defaultVersion={GRID_V2}` on the control below is the same fact told to the
    // toggle, or it would light the side the page did not render.
    const v2 = resolveGrid(params.grid, GRID_V2) === GRID_V2;
    // The RESOLVED version, for the client key. Keying on the raw param would give the
    // two URLs that both mean v2 (absent, and an explicit `?grid=v2`) two different keys,
    // and — worse on a flipped page — would give `?grid=v1` and a typo the same one.
    const gridVersion = v2 ? GRID_V2 : GRID_V1;

    // The month index, the two dimension lists and the payment pickers are independent of
    // each other and of the row read — one round trip, not four in series.
    //
    // ── THE PAYMENT PICKERS (liquidation Step 4) ─────────────────────────────────
    // The trader list and the bank-account list feed the "Add cheque" form, which is the
    // liquidation module's own dialog rendered from this page. They are fetched HERE
    // rather than lazily in the client so recording a cheque costs no round trip, and they
    // are behind `canViewPrices()` INSIDE the fetcher — a gated viewer does not even learn
    // which bank accounts exist, and the button they would feed is not rendered for that
    // role either.
    //
    // ── WHO MAY DELETE ───────────────────────────────────────────────────────────
    // Owner / Admin / Dev. Resolved here, on the server, and passed down as a plain
    // boolean — the same path `canViewPrices` takes, and for the same reason: a client
    // component must never re-derive a capability (an inline role lookup would ignore
    // the impersonation cookie). It only hides the menu item; `deleteDelivery` itself
    // re-checks with the same predicate, which is the gate that holds.
    const [months, dimensions, payment, canDelete] = await Promise.all([
        fetchDeliveryMonthKeys(),
        fetchDeliveryDimensions(),
        fetchPaymentDimensions(),
        isPrivileged(),
    ]);
    const monthKeys = months.monthKeys;
    const period = resolvePeriod(monthKeys, params.year, params.month);
    // The SAME resolver with nothing to resolve — THE definition of what a paramless URL
    // means on this screen, rather than a second expression that could disagree with it.
    const defaultPeriod = resolvePeriod(monthKeys, undefined, undefined);

    const anchor: DeliveryAnchor = period
        ? { kind: 'period', year: period.year, month: period.month }
        : { kind: 'latest' };

    // The axes fingerprint keys the client so a scope/lens/search change remounts with
    // the server-prefetched window for the NEW axes — one deterministic seeding path,
    // and it resets react-virtuoso's `firstItemIndex` by construction (no scroll jump).
    const key = axesKey({ scope, period, issue, query, filters, grid: gridVersion });

    // ── The chrome strip: the grid switch, the SCOPE toggle and the PERIOD picker ──
    //
    // Mounted HERE, above whichever grid the flag selected, rather than inside either of
    // them — which is the whole point. `deliveries-ledger.tsx` is the production path and
    // this migration does not edit it by one character, so its toolbar is not available;
    // putting the controls in the page means they cost ONE mount, with neither table
    // component touched. It is a `shrink-0` strip in the Cenapro layout's flex column, so
    // the sheet below keeps `flex-1 min-h-0` and is not squeezed.
    //
    // EVERY OTHER PARAM SURVIVES EVERY ONE OF THEM. The toggle writes only `?grid=`, the
    // scope control only `?scope=`, the picker only `?year=`/`?month=` — each copies the
    // query exhaustively and touches nothing else, or a flip would move the operator to a
    // different set of receipts and the comparison would be worthless.
    //
    // ── The period controls are v2-ONLY ─────────────────────────────────────────
    // The Classic ledger carries its own scope toggle and month dropdown in its own
    // toolbar (untouched). Mounting a second pair above it would give that screen two of
    // each, over one param, free to disagree.
    //
    // ── What each SCOPE offers ──────────────────────────────────────────────────
    //   endless — the scope toggle ALONE. Its period is the keyset window, not a month;
    //             `?year=`/`?month=` are still carried (so a flip back to focus lands
    //             where you left) but they select nothing, and a picker that selected
    //             nothing would be a control lying about what it does.
    //   focus   — the toggle plus the shared `PeriodPicker`, over this screen's existing
    //             `?year=` + `?month=` params. `all` is offered on NEITHER axis:
    //             `fetchDeliveryMonth` takes ONE period and `resolvePeriod` cannot
    //             produce `all`, so a hand-typed `?year=all` resolves to this page's
    //             default — the same answer any unrecognised value gets.
    const availableYears = yearsOf(monthKeys);
    const periodPicker =
        v2 && scope === 'focus' && period ? (
            <PeriodPicker
                years={availableYears}
                year={period.year}
                month={period.month}
                // What a paramless URL ALREADY means: `resolvePeriod` falls back to the
                // newest month that has receipts, so a param is written only when the
                // operator picked something else and the default state stays a clean URL.
                // Note the default follows the data forward, which is the behaviour — the
                // screen opens on the month worth reading.
                defaults={defaultPeriod ?? { year: period.year, month: period.month }}
                allowAllYears={false}
                allowAllMonths={false}
            />
        ) : null;

    const gridBar = (
        <GridVersionBar
            defaultVersion={GRID_V2}
            currentLabel="Classic"
            newLabel="Table (new)"
            note="Same rows, same filters — this switches only which table renders them. Search, filters and history still live in the Classic table for now."
            trailing={
                v2 ? (
                    <>
                        <DeliveriesScopeToggle scope={scope} />
                        {periodPicker}
                    </>
                ) : null
            }
        />
    );

    if (scope === 'focus') {
        const month = period
            ? await fetchDeliveryMonth(period, issue, query, filters)
            : { records: [], canViewPrices: false, error: undefined };

        const focusProps = {
            scope: 'focus' as const,
            initialPage: null,
            monthRecords: month.records,
            anchor,
            period,
            monthKeys,
            issue,
            query,
            filters,
            dimensions,
            canViewPrices: month.canViewPrices,
            canDelete,
            paymentSuppliers: payment.suppliers,
            paymentAccounts: payment.accounts,
            loadError: month.error ?? months.error ?? dimensions.error ?? null,
        };

        return (
            <>
                {gridBar}
                {v2 ? (
                    <DeliveriesGridV2 key={key} {...focusProps} />
                ) : (
                    <DeliveriesLedger key={key} {...focusProps} />
                )}
            </>
        );
    }

    // Endless: anchor-first — resolve the anchor from the URL, then prefetch the FIRST
    // keyset window server-side so the very first paint is already in the right place.
    const page = await fetchDeliveryPage({
        mode: 'anchor',
        anchor: { kind: 'latest' },
        issue,
        query,
        filters,
    });

    const endlessProps = {
        scope: 'endless' as const,
        initialPage: {
            records: page.records,
            hasOlder: page.hasOlder,
            hasNewer: page.hasNewer,
            totalCount: page.totalCount ?? null,
            notice: page.notice,
        },
        monthRecords: null,
        anchor: { kind: 'latest' } as const,
        period,
        monthKeys,
        issue,
        query,
        filters,
        dimensions,
        canViewPrices: page.canViewPrices,
        canDelete,
        paymentSuppliers: payment.suppliers,
        paymentAccounts: payment.accounts,
        loadError: page.error ?? months.error ?? dimensions.error ?? null,
    };

    return (
        <>
            {gridBar}
            {v2 ? (
                <DeliveriesGridV2 key={key} {...endlessProps} />
            ) : (
                <DeliveriesLedger key={key} {...endlessProps} />
            )}
        </>
    );
}
