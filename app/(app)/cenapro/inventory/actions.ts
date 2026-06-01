'use server';

import { createClient } from '@/lib/supabase/server';
import type { FlecBalanceRow, FlecLedgerRow } from '../types';

// ─── Fetch flec balances + ledger for one warehouse / start date ─────────────────
// Read-only. Calls the two start-date-scoped set-returning functions in parallel:
//   • cenapro_flec_balance(warehouse, start_date) → closing count per (grade, side)
//   • cenapro_flec_ledger(warehouse, start_date)  → the movement detail (show-the-math)
//
// Data path: both are read-only accessors in the already-served `public` schema
// (granted to authenticated + anon), so the normal Supabase client reaches them
// via `supabase.rpc(...)` directly — no `.schema('cenapro')`, no cast. Their
// generated Returns types flow straight through into the typed `data`.
export async function fetchFlecInventory(
    warehouse: string,
    startDate: string,
): Promise<{
    balances?: FlecBalanceRow[];
    ledger?: FlecLedgerRow[];
    error?: string;
}> {
    const supabase = await createClient();
    const params = { p_warehouse_code: warehouse, p_start_date: startDate };

    const [balanceRes, ledgerRes] = await Promise.all([
        supabase.rpc('cenapro_flec_balance', params),
        supabase.rpc('cenapro_flec_ledger', params),
    ]);

    if (balanceRes.error) {
        return { error: `Failed to load flec balances: ${balanceRes.error.message}` };
    }
    if (ledgerRes.error) {
        return { error: `Failed to load flec ledger: ${ledgerRes.error.message}` };
    }

    return {
        balances: balanceRes.data ?? [],
        ledger: ledgerRes.data ?? [],
    };
}
