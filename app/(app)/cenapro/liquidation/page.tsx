import { fetchPaymentDimensions, fetchSupplierBalances } from './actions';
import { LiquidationView } from './liquidation-view';
import { PriceGateNotice } from './price-gate-notice';

// ─────────────────────────────────────────────────────────────────────────────────
// LIQUIDATION (`/cenapro/liquidation`) — what CI owes each raw-charcoal trader.
//
// Server component: check the gate, fetch, hand off. The client never talks to Supabase.
//
// ── THE GATE IS A FETCH DECISION, NOT A RENDER DECISION ──────────────────────────
// This whole module is money. There is no useful redacted version of a balance screen —
// remove the pesos and nothing is left — so `canViewPrices()` is consulted INSIDE the
// fetchers and a denied viewer's queries are never issued at all. The payload that
// reaches the browser is empty because there was nothing in it, not because something
// was hidden after the fact. The network response is the leak.
//
// The payment pickers are only fetched once the gate has passed, so a denied viewer does
// not even learn which bank accounts exist.
//
// This page renders no title of its own — the navbar owns page titles (see
// `getBreadcrumb()` in `components/navbar.tsx`).
// ─────────────────────────────────────────────────────────────────────────────────

export const dynamic = 'force-dynamic';

export default async function CenaproLiquidationPage() {
    const balances = await fetchSupplierBalances();

    if (!balances.canViewPrices) return <PriceGateNotice />;

    const dimensions = await fetchPaymentDimensions();

    return (
        <LiquidationView
            suppliers={balances.suppliers}
            groups={balances.groups}
            dimensionSuppliers={dimensions.suppliers}
            accounts={dimensions.accounts}
            loadError={balances.error ?? dimensions.error ?? null}
        />
    );
}
