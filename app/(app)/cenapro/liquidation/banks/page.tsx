import { canViewPrices } from '@/lib/auth';

import { fetchBanks } from '../actions';
import { PriceGateNotice } from '../price-gate-notice';
import { BanksView } from './banks-view';

// ─────────────────────────────────────────────────────────────────────────────────
// BANKS & ACCOUNTS (`/cenapro/liquidation/banks`) — the other half of Step 3's
// "banks, accounts, payments and the running balance".
//
// It exists because a cheque cannot be recorded without an account (the `rc_payment`
// shape CHECK requires one) and the migration seeded ZERO accounts on purpose. Until a
// real account is typed here, the dominant instrument in this business is unrecordable.
//
// Gated like the rest of the module. `cenapro_rc_banks` / `cenapro_rc_bank_accounts`
// carry no ₱ column, but an account is half a cheque's identity and this screen is the
// only way to create one — the same reasoning that gates the subgroups screen. The write
// actions re-check the gate server-side regardless.
//
// This page renders no title of its own — the navbar owns page titles.
// ─────────────────────────────────────────────────────────────────────────────────

export const dynamic = 'force-dynamic';

export default async function CenaproBanksPage() {
    if (!(await canViewPrices())) return <PriceGateNotice />;

    const { banks, accounts, error } = await fetchBanks();

    return <BanksView banks={banks} accounts={accounts} loadError={error} />;
}
