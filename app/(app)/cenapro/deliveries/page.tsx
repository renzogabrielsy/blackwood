import {
    fetchDeliveryDimensions,
    fetchDeliveryMonth,
    fetchDeliveryMonthKeys,
    fetchDeliveryPage,
    type DeliveryAnchor,
} from './actions';
import { DeliveriesLedger } from './deliveries-ledger';
import {
    axesKey,
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

export default async function CenaproDeliveriesPage({
    searchParams,
}: {
    searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
    const params = await searchParams;

    const scope = parseScope(params.scope);
    const issue = parseIssueLens(params.issue);
    const query = parseQuery(params.q);

    // The month index and the two dimension lists are independent of each other and of
    // the row read — one round trip, not three in series.
    const [months, dimensions] = await Promise.all([
        fetchDeliveryMonthKeys(),
        fetchDeliveryDimensions(),
    ]);
    const monthKeys = months.monthKeys;
    const period = resolvePeriod(monthKeys, params.year, params.month);

    const anchor: DeliveryAnchor = period
        ? { kind: 'period', year: period.year, month: period.month }
        : { kind: 'latest' };

    // The axes fingerprint keys the client so a scope/lens/search change remounts with
    // the server-prefetched window for the NEW axes — one deterministic seeding path,
    // and it resets react-virtuoso's `firstItemIndex` by construction (no scroll jump).
    const key = axesKey({ scope, period, issue, query });

    if (scope === 'focus') {
        const month = period
            ? await fetchDeliveryMonth(period, issue, query)
            : { records: [], canViewPrices: false, error: undefined };

        return (
            <DeliveriesLedger
                key={key}
                scope="focus"
                initialPage={null}
                monthRecords={month.records}
                anchor={anchor}
                period={period}
                monthKeys={monthKeys}
                issue={issue}
                query={query}
                dimensions={dimensions}
                canViewPrices={month.canViewPrices}
                loadError={month.error ?? months.error ?? dimensions.error ?? null}
            />
        );
    }

    // Endless: anchor-first — resolve the anchor from the URL, then prefetch the FIRST
    // keyset window server-side so the very first paint is already in the right place.
    const page = await fetchDeliveryPage({ mode: 'anchor', anchor: { kind: 'latest' }, issue, query });

    return (
        <DeliveriesLedger
            key={key}
            scope="endless"
            initialPage={{
                records: page.records,
                hasOlder: page.hasOlder,
                hasNewer: page.hasNewer,
                notice: page.notice,
            }}
            monthRecords={null}
            anchor={{ kind: 'latest' }}
            period={period}
            monthKeys={monthKeys}
            issue={issue}
            query={query}
            dimensions={dimensions}
            canViewPrices={page.canViewPrices}
            loadError={page.error ?? months.error ?? dimensions.error ?? null}
        />
    );
}
