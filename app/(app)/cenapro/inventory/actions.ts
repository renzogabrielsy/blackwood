'use server';

import { revalidatePath } from 'next/cache';
import { createClient } from '@/lib/supabase/server';
import {
    GRADE_CODES,
    type FlecBalanceRow,
    type FlecLedgerRow,
    type OpeningBalanceRow,
    type OpeningBalanceHistoryRow,
    type OpeningBalanceCellChange,
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

// ─── Fetch the GRADE dimension (2026-08-26) ──────────────────────────────────────
// The STARTING block and the balance grid used to be built from `GRADE_CODES`, the
// hardcoded seed mirror in `../types.ts`. Grades became addable from this screen the
// day `public.cenapro_add_grade` landed, and a grade nobody can SEE is a grade nobody
// added — so the row list is read from the dimension itself.
//
// `public.cenapro_grades` is the `security_invoker` read accessor over `cenapro.grade`
// (SELECT only, `authenticated` + `service_role`), already ordered by `sort_order, code`
// — that order IS the canonical one and is never re-sorted here.
//
// NON-FATAL by design. A failed read falls back to `GRADE_CODES`, which is an exact
// mirror of the seed, so the screen still renders every grade that existed before this
// feature; only a grade added since would be missing. The reason is returned separately
// from the page's fatal `loadError` so the balances/ledger empty-states keep their
// meaning — a grade list that fell back is a caption, not a broken page.
export async function fetchGradeCodes(): Promise<{ codes: string[]; error?: string }> {
    const supabase = await createClient();

    const { data, error } = await supabase
        .from('cenapro_grades')
        .select('code, display_name, sort_order');

    if (error) {
        return {
            codes: [...GRADE_CODES],
            error: `Failed to load the grade list: ${error.message}. Showing the built-in grades — a grade added recently may be missing until this read succeeds.`,
        };
    }

    // Every column on the accessor is nullable (it is a view), so a blank/absent code
    // is dropped rather than rendered as an empty row nobody can type into.
    const codes: string[] = [];
    const seen = new Set<string>();
    for (const row of data ?? []) {
        const code = (row.code ?? '').trim();
        if (!code || seen.has(code)) continue;
        seen.add(code);
        codes.push(code);
    }

    // An empty dimension cannot be right (four grades are seeded) and would render a
    // STARTING block with no rows at all — fall back rather than show nothing.
    if (codes.length === 0) return { codes: [...GRADE_CODES] };

    return { codes };
}

// ─── Add ONE grade (INSERT-only) ─────────────────────────────────────────────────
// `public.cenapro_add_grade(p_code, p_display_name, p_sort_order)` is INSERT-ONLY —
// there is no update RPC and no delete RPC, deliberately: `grade_code` is a TEXT
// foreign key carried by every `cenapro.production_event` row, so a rename needs a
// cascade nobody has reasoned about and a delete would succeed on a fresh mistake and
// be refused by the FK later. Adding is monotone and safe.
//
// The code is canonicalized SERVER-SIDE (`cenapro.fn_canon_token` — trim / collapse
// whitespace / uppercase), so `3x50` comes back `already_exists` naming the stored
// spelling `3X50`. Nothing here re-implements that: the only pre-flight is the blank
// check, because a blank field costs a round trip to learn nothing. Every other
// refusal is the RPC's, and the RPC's own sentence is what the operator reads.
//
// `sort_order` is deliberately NOT offered. It defaults to `max + 1` (append to the
// end), it is ordering only, nothing keys on it, and a spinner for it would imply the
// number means something.
export type AddGradeOutcome = 'inserted' | 'already_exists' | 'invalid' | 'rpc_error';

export interface AddGradeResult {
    ok: boolean;
    outcome: AddGradeOutcome;
    /** The STORED spelling — canonicalized on insert, or the existing row's on a clash. */
    code: string | null;
    displayName: string | null;
    /** The RPC's own words on a refusal. Absent on `inserted` (there is nothing to say). */
    message: string | null;
}

const ADD_GRADE_OUTCOMES: readonly AddGradeOutcome[] = ['inserted', 'already_exists', 'invalid'];

function readAddGradeOutcome(value: unknown): AddGradeOutcome {
    return ADD_GRADE_OUTCOMES.includes(value as AddGradeOutcome)
        ? (value as AddGradeOutcome)
        : 'rpc_error';
}

export async function addGrade(input: {
    code: string;
    displayName?: string | null;
}): Promise<AddGradeResult> {
    const code = (input.code ?? '').trim();
    const displayName = (input.displayName ?? '').trim();

    if (!code) {
        return {
            ok: false,
            outcome: 'invalid',
            code: null,
            displayName: null,
            message:
                'A grade needs a code — it is what every production row, partner draw and bagging entry refers to.',
        };
    }

    const supabase = await createClient();
    const { data, error } = await supabase.rpc('cenapro_add_grade', {
        p_code: code,
        // Omitted when blank, never sent as an explicit null: the RPC defaults the
        // display name to the code, which is exactly what all four seeded rows do.
        ...(displayName ? { p_display_name: displayName } : {}),
    });

    if (error) {
        return { ok: false, outcome: 'rpc_error', code: null, displayName: null, message: error.message };
    }

    const raw = (data ?? {}) as Record<string, unknown>;
    const outcome = readAddGradeOutcome(raw.outcome);
    const result: AddGradeResult = {
        ok: raw.ok === true,
        outcome,
        code: typeof raw.code === 'string' ? raw.code : null,
        displayName: typeof raw.display_name === 'string' ? raw.display_name : null,
        message: typeof raw.message === 'string' ? raw.message : null,
    };

    if (result.ok && outcome === 'inserted') {
        // The grade dimension feeds this screen's rows AND the QC ledger's draw-entry
        // grade picker (`loadQcDrawOptions` reads the same accessor), so both go stale.
        revalidatePath('/cenapro/inventory');
        revalidatePath('/cenapro/qc');
    }

    return result;
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
