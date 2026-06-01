'use server';

import { revalidatePath } from 'next/cache';
import { createClient } from '@/lib/supabase/server';
import type {
    FlecBalanceRow,
    FlecLedgerRow,
    OpeningBalanceRow,
    OpeningBalanceHistoryRow,
    OpeningBalanceCellChange,
} from '../types';

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

// ─── Fetch the CURRENT effective opening balances (the STARTING block seed) ───────
// Read-only. `cenapro_opening_balances(warehouse, asOf)` returns the effective
// opening per (grade, side) as of `asOf` (greatest period_start_date ≤ asOf,
// tie-broken by created_at). Drives the editable STARTING grid; unlike
// `cenapro_flec_balance` it returns a (grade, side) even with no events forward.
export async function fetchOpeningBalances(
    warehouse: string,
    asOf: string,
): Promise<{ openings?: OpeningBalanceRow[]; error?: string }> {
    const supabase = await createClient();

    const { data, error } = await supabase.rpc('cenapro_opening_balances', {
        p_warehouse_code: warehouse,
        p_as_of_date: asOf,
    });

    if (error) {
        return { error: `Failed to load opening balances: ${error.message}` };
    }
    return { openings: data ?? [] };
}

// ─── Fetch the FULL append-only opening-balance history (backtracking data) ───────
// Read-only. `cenapro_opening_balance_history(warehouse)` returns every opening
// entry ever set for the warehouse, newest-first per (grade, side). The UI groups
// these by (grade, side) so the operator can backtrack what the opening was on any
// past effective date.
export async function fetchOpeningBalanceHistory(
    warehouse: string,
): Promise<{ history?: OpeningBalanceHistoryRow[]; error?: string }> {
    const supabase = await createClient();

    const { data, error } = await supabase.rpc('cenapro_opening_balance_history', {
        p_warehouse_code: warehouse,
    });

    if (error) {
        return { error: `Failed to load opening-balance history: ${error.message}` };
    }
    return { history: data ?? [] };
}

// ─── Save the CHANGED STARTING cells (append-only) ────────────────────────────────
// Each changed cell becomes a NEW opening row via `cenapro_set_opening_balance`
// (INSERT-only — never an overwrite). The effective date is the page's START date,
// so changing the date and/or values sets a fresh starting point for a period while
// every prior value is preserved as history. Loops the RPC once per changed cell.
//
// Write path: the RPC is SECURITY INVOKER and granted to `authenticated` only — this
// action runs as the logged-in user (server-side), so the INSERT is authorized.
// The anon/browser key is correctly denied (proven 2026-06-01). `revalidatePath`
// re-runs the page so the STARTING seed + the ledger below re-derive from the new
// opening.
export async function saveOpeningBalances(
    changes: OpeningBalanceCellChange[],
): Promise<{ savedCount?: number; error?: string }> {
    if (changes.length === 0) {
        return { savedCount: 0 };
    }

    const supabase = await createClient();

    for (const cell of changes) {
        const { error } = await supabase.rpc('cenapro_set_opening_balance', {
            p_warehouse_code: cell.warehouse,
            p_grade_code: cell.grade,
            p_side: cell.side,
            p_effective_date: cell.effectiveDate,
            p_count: cell.count,
        });

        if (error) {
            // Stop at the first failure and surface which cell broke so the
            // persistent errorToast is actionable. Earlier cells already committed
            // (each RPC is its own append-only INSERT) — the page revalidation below
            // is skipped so the grid keeps the operator's unsaved edits.
            return {
                error: `Failed to save ${cell.grade} / ${cell.side} (= ${cell.count}, as of ${cell.effectiveDate}): ${error.message}`,
            };
        }
    }

    revalidatePath('/cenapro/inventory');
    return { savedCount: changes.length };
}
