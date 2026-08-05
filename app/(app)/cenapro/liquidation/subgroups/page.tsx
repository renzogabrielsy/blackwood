import { canViewPrices } from '@/lib/auth';

import { fetchSupplierGroups } from '../actions';
import { PriceGateNotice } from '../price-gate-notice';
import { SubgroupsView } from './subgroups-view';

// ─────────────────────────────────────────────────────────────────────────────────
// SUPPLIER SUBGROUPS (`/cenapro/liquidation/subgroups`) — Liquidation Step 2's UI half.
//
// ── WHY THIS IS BEHIND THE ₱ GATE THOUGH IT SHOWS NO MONEY ───────────────────────
// `public.cenapro_rc_supplier_groups` carries no ₱ column at all — `rc_supplier` has
// none — so nothing on this screen is a price. It is gated anyway, and deliberately.
//
// The gate here is not protecting a FIGURE, it is protecting a DECISION: `parent_code`
// says who may be paid for whom, and re-pointing it retroactively changes which past
// payments were legitimate. It is the payment model's most consequential single field.
// A role that may not see what CI owes a trader has no business deciding whose cheques
// may settle whose deliveries — and the write path (`saveSupplierParent`) checks the same
// gate server-side, so this page-level check is the visible half of a rule that is
// enforced whether or not the button was ever rendered.
//
// This page renders no title of its own — the navbar owns page titles.
// ─────────────────────────────────────────────────────────────────────────────────

export const dynamic = 'force-dynamic';

export default async function CenaproSubgroupsPage() {
    if (!(await canViewPrices())) return <PriceGateNotice />;

    const { suppliers, error } = await fetchSupplierGroups();

    return <SubgroupsView suppliers={suppliers} loadError={error} />;
}
