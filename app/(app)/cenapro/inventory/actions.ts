'use server';

import { createClient } from '@/lib/supabase/server';
import type { FlecBalanceRow, FlecLedgerRow } from '../types';

// Minimal structural type for the cast — exposes only the `.schema().rpc()` path
// we use, returning the row shapes this module declares.
type SchemaRpcClient = {
    schema: (s: string) => {
        rpc: (
            fn: string,
            params: Record<string, string>,
        ) => Promise<{ data: unknown; error: { message: string } | null }>;
    };
};

// ─── Fetch flec balances + ledger for one warehouse / start date ─────────────────
// Read-only. Calls the two start-date-scoped set-returning functions in parallel:
//   • cenapro.flec_balance(warehouse, start_date) → closing count per (grade, side)
//   • cenapro.flec_ledger(warehouse, start_date)  → the movement detail (show-the-math)
//
// STOPGAP: the cenapro schema isn't yet exposed to PostgREST / generated types, so
// we call through `.schema('cenapro').rpc(...)` on a client cast to a minimal
// structural type. Until exposure is enabled these RPCs error in the browser —
// expected; the page renders a graceful empty/error state. Swap the cast for the
// generated `Database['cenapro']` function types after regeneration.
export async function fetchFlecInventory(
    warehouse: string,
    startDate: string,
): Promise<{
    balances?: FlecBalanceRow[];
    ledger?: FlecLedgerRow[];
    error?: string;
}> {
    const supabase = await createClient();
    const client = supabase as unknown as SchemaRpcClient;
    const params = { p_warehouse_code: warehouse, p_start_date: startDate };

    const [balanceRes, ledgerRes] = await Promise.all([
        client.schema('cenapro').rpc('flec_balance', params),
        client.schema('cenapro').rpc('flec_ledger', params),
    ]);

    if (balanceRes.error) {
        return { error: `Failed to load flec balances: ${balanceRes.error.message}` };
    }
    if (ledgerRes.error) {
        return { error: `Failed to load flec ledger: ${ledgerRes.error.message}` };
    }

    return {
        balances: (balanceRes.data as FlecBalanceRow[] | null) ?? [],
        ledger: (ledgerRes.data as FlecLedgerRow[] | null) ?? [],
    };
}
