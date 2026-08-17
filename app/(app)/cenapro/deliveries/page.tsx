import {
    fetchDeliveryDimensions,
    fetchDeliveryMonth,
    fetchDeliveryMonthKeys,
    fetchDeliveryPage,
    type DeliveryAnchor,
} from './actions';
import { fetchPaymentDimensions } from '../liquidation/actions';
import { isPrivileged } from '@/lib/auth';
import { DeliveriesLedger } from './deliveries-ledger';
import { DeliveriesGridV2 } from './deliveries-grid-v2';
import {
    axesKey,
    parseColumnFilters,
    parseGrid,
    parseIssueLens,
    parseQuery,
    parseScope,
    resolvePeriod,
    GRID_V2,
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

    // ── WHICH GRID (`?grid=v2`) ──────────────────────────────────────────────────
    //
    // Stage 1D of the universal-table migration is built BESIDE the live ledger, not in
    // place of it (the strangler-fig method — see
    // `handoffs/2026-08-17-universal-table-phase-1-and-the-side-by-side-method.md`).
    // `DeliveriesGridV2` is the same screen rendered through `BlackwoodTable`, and it is
    // reachable ONLY on request: the default, and every existing link, still gets
    // `DeliveriesLedger`.
    //
    // Both branches below hand the two components the IDENTICAL prop set — v2 imports
    // `DeliveriesLedgerProps` rather than re-declaring it — and both read the same server
    // data. No action, RPC or query changes with the flag; it decides only which component
    // renders the payload. It joins `axesKey` so a switch remounts cleanly.
    //
    // Temporary: at cutover this param and the old ledger go together.
    const grid = parseGrid(params.grid);
    const v2 = grid === GRID_V2;

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

    const anchor: DeliveryAnchor = period
        ? { kind: 'period', year: period.year, month: period.month }
        : { kind: 'latest' };

    // The axes fingerprint keys the client so a scope/lens/search change remounts with
    // the server-prefetched window for the NEW axes — one deterministic seeding path,
    // and it resets react-virtuoso's `firstItemIndex` by construction (no scroll jump).
    const key = axesKey({ scope, period, issue, query, filters, grid });

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

        return v2 ? (
            <DeliveriesGridV2 key={key} {...focusProps} />
        ) : (
            <DeliveriesLedger key={key} {...focusProps} />
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

    return v2 ? (
        <DeliveriesGridV2 key={key} {...endlessProps} />
    ) : (
        <DeliveriesLedger key={key} {...endlessProps} />
    );
}
