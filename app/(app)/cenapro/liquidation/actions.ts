'use server';

// ─────────────────────────────────────────────────────────────────────────────────
// Cenapro LIQUIDATION — the data path. Reads AND writes, same file, same pattern as
// `deliveries/actions.ts`. The client never touches Supabase.
//
// ── THE ₱ BOUNDARY IS THE WHOLE MODULE, NOT A FIELD LIST ─────────────────────────
// `deliveries/actions.ts` nulls SEVEN named fields on a row that is otherwise fine to
// show. Nothing here is like that: `cenapro_rc_supplier_balances`,
// `cenapro_rc_supplier_group_balances` and `cenapro_rc_payments` are ₱-BEARING END TO
// END — a balance with its money removed is not a redacted balance, it is a blank
// screen. So there is no `stripPrices()` analogue here and there must not be one.
// The gate is COARSER AND EARLIER: when `canViewPrices()` is false the query is NOT
// ISSUED AT ALL and the payload comes back empty with a reason. The network response is
// the leak, and the surest way to keep money out of it is never to fetch the money.
//
// Every WRITE re-checks the same gate server-side before it reaches an RPC. A client
// that never renders the button is not a permission check.
//
// ── REFUSALS ARE QUOTED, NEVER RE-WORDED ─────────────────────────────────────────
// Each RPC returns `{ok, outcome, message}` where `message` is written for a toast and
// names precisely which of a dozen rules was broken ("Cheque #001234 has already been
// recorded against that account…"). This layer passes it through verbatim. A generic
// "Save failed" thrown over the top would discard the only part of the response that
// tells the operator what to do next.
// ─────────────────────────────────────────────────────────────────────────────────

import { revalidatePath } from 'next/cache';

import { canViewPrices } from '@/lib/auth';
import { createClient } from '@/lib/supabase/server';
import {
    LIQUIDATION_OUTCOMES,
    PRICE_GATE_NOTE,
    type BankAccountRow,
    type BankRow,
    type LiquidationOutcome,
    type LiquidationResult,
    type PaymentPatch,
    type PaymentRow,
    type RpcPatch,
    type SetOpeningBalanceArgs,
    type SupplierBalanceRow,
    type SupplierGroupBalanceRow,
    type SupplierGroupRow,
} from './types';

/**
 * Every liquidation route reads from the same three views, so any write invalidates all
 * of them: recording a payment moves the balance, and re-pointing a parent moves the
 * group rollup. One helper so a new write path cannot forget one of the routes.
 */
function revalidateLiquidation() {
    revalidatePath('/cenapro/liquidation');
    revalidatePath('/cenapro/liquidation/subgroups');
    revalidatePath('/cenapro/liquidation/banks');
}

/**
 * Defensive ceilings. Twelve traders and a projected few hundred payments a year make
 * these unreachable in practice; they exist so a runaway read can never page an entire
 * ledger into a dialog.
 */
const BALANCE_MAX = 500;
const PAYMENT_MAX = 500;

// ── THE PROJECTIONS ARE FULL, AND THAT IS LOAD-BEARING ───────────────────────────
//
// Every column of each read model, so the fetched shape IS the generated `Row` type and
// the aliases exported from `types.ts` stay usable across files. A partial projection
// types as a structurally different row and forces a `Pick<>` at every consumer for no
// gain: these are 12-row and 4-row relations.
//
// "Full" is a claim that goes STALE, and it did. Opening balances widened
// `cenapro_rc_supplier_balances` 30 → 53 columns and
// `cenapro_rc_supplier_group_balances` 27 → 49 (migration `20260805130000`), and the two
// lists below kept typechecking only because `types/supabase.ts` had not been
// regenerated. The moment it was, both assignments failed with "missing 22 properties".
//
// So: if you add a column to either balance view, add it here in the same changeset.
// `npx tsc --noEmit` is the check — it fails loudly rather than silently returning a row
// with holes in it.
//
// A SINGLE string literal per relation — `+` concatenation defeats type inference.
const BALANCE_COLS =
    'supplier_code, display_name, active, sort_order, is_unassigned, parent_code, group_code, group_display_name, group_sort_order, is_parent, is_child, receipt_count, receipts_php, first_receipt_date, last_receipt_date, unpriced_receipt_count, unpriced_receipt_kg, unpriced_awaiting_weight_count, unpriced_awaiting_price_count, unpriced_awaiting_both_count, payment_count, payments_php, cash_out_php, cash_in_php, cash_net_php, adjustment_php, adjustment_count, first_payment_date, last_payment_date, running_balance_php, opening_balance_php, opening_as_of_date, has_opening_balance, opening_note, opening_set_at, opening_revision_id, opening_revision_count, carried_receipt_count, carried_receipt_php, carried_payment_count, carried_payment_php, receipt_count_all, receipts_all_php, payment_count_all, payments_all_php, cash_out_all_php, cash_in_all_php, cash_net_all_php, adjustment_all_php, adjustment_count_all, running_balance_all_php, unpriced_receipt_count_window, unpriced_receipt_kg_window';

const GROUP_BALANCE_COLS =
    'group_code, group_display_name, group_sort_order, is_unassigned, supplier_count, child_count, supplier_codes, any_active, receipt_count, receipts_php, first_receipt_date, last_receipt_date, unpriced_receipt_count, unpriced_receipt_kg, unpriced_awaiting_weight_count, unpriced_awaiting_price_count, unpriced_awaiting_both_count, payment_count, payments_php, cash_out_php, cash_in_php, cash_net_php, adjustment_php, adjustment_count, first_payment_date, last_payment_date, running_balance_php, opening_balance_php, has_opening_balance, opening_supplier_count, opening_as_of_date, opening_as_of_date_min, opening_as_of_date_max, carried_receipt_count, carried_receipt_php, carried_payment_count, carried_payment_php, receipt_count_all, receipts_all_php, payment_count_all, payments_all_php, cash_out_all_php, cash_in_all_php, cash_net_all_php, adjustment_all_php, adjustment_count_all, running_balance_all_php, unpriced_receipt_count_window, unpriced_receipt_kg_window';

const PAYMENT_COLS =
    'id, supplier_code, supplier_name, group_code, group_display_name, payment_date, method, amount_php, direction, stated_term, bank_account_id, bank_code, bank_display_name, account_label, account_no, bank_account_label, cheque_no, cheque_date, reference_no, remarks, balance_effect_php, is_cash, is_deleted, deleted_at, deleted_by, row_version, created_at, created_by, updated_at, updated_by';

const OPENING_HISTORY_COLS =
    'id, supplier_code, supplier_display_name, as_of_date, opening_balance_php, note, is_current, created_at, created_by';

const SUPPLIER_GROUP_COLS =
    'code, display_name, sort_order, active, notes, parent_code, parent_display_name, group_code, group_display_name, group_sort_order, is_parent, is_child, child_count, child_codes, row_version, created_at, updated_at';

const BANK_ACCOUNT_COLS =
    'id, bank_code, bank_display_name, bank_active, bank_sort_order, account_label, account_no, display_label, active, sort_order, notes, row_version, created_at, updated_at';

const BANK_COLS_SELECT =
    'code, display_name, sort_order, active, notes, row_version, created_at, updated_at';

// ═══ READ ═══════════════════════════════════════════════════════════════════════

export interface SupplierBalancesResult {
    suppliers: SupplierBalanceRow[];
    groups: SupplierGroupBalanceRow[];
    /** False ⇒ NOTHING was fetched. The arrays are empty because the query never ran. */
    canViewPrices: boolean;
    error: string | null;
}

/**
 * The balance screen's whole payload: one row per trader AND the group rollup, so the
 * screen shows both levels without ever adding two numbers together itself.
 *
 * Both come back including the synthetic no-payee row (`is_unassigned = true`,
 * `supplier_code IS NULL`) — the receipts that have no payee and therefore cannot be
 * liquidated at all. It is emitted by the view only while such receipts exist, so
 * nothing here has to decide whether to show it.
 */
export async function fetchSupplierBalances(): Promise<SupplierBalancesResult> {
    const showPrices = await canViewPrices();
    if (!showPrices) {
        return { suppliers: [], groups: [], canViewPrices: false, error: null };
    }

    const supabase = await createClient();

    // Independent of each other — one round trip, not two in series.
    const [supplierRes, groupRes] = await Promise.all([
        supabase
            .from('cenapro_rc_supplier_balances')
            .select(BALANCE_COLS)
            // Ordering is re-applied client-side by `buildBalanceTree` (which also has to
            // sink the no-payee bucket); asking for it here keeps the payload stable and
            // the tree build a pure re-shuffle rather than a sort of arbitrary input.
            .order('group_sort_order', { ascending: true })
            .order('sort_order', { ascending: true })
            .limit(BALANCE_MAX),
        supabase
            .from('cenapro_rc_supplier_group_balances')
            .select(GROUP_BALANCE_COLS)
            .order('group_sort_order', { ascending: true })
            .limit(BALANCE_MAX),
    ]);

    const error =
        supplierRes.error?.message ??
        groupRes.error?.message ??
        null;

    return {
        suppliers: supplierRes.data ?? [],
        groups: groupRes.data ?? [],
        canViewPrices: true,
        error: error ? `Failed to load supplier balances: ${error}` : null,
    };
}

export interface PaymentDimensionsResult {
    /** Every trader, with its subgroup resolution — the payee picker. */
    suppliers: SupplierGroupRow[];
    /** CI's own accounts, bank name folded in — the "drawn on" picker. */
    accounts: BankAccountRow[];
    error: string | null;
}

/**
 * The two lists the payment form picks from. NOT ₱-bearing in themselves, but only ever
 * fetched for a screen that is, so the caller is already behind the gate.
 */
export async function fetchPaymentDimensions(): Promise<PaymentDimensionsResult> {
    const supabase = await createClient();

    const [supplierRes, accountRes] = await Promise.all([
        supabase
            .from('cenapro_rc_supplier_groups')
            .select(SUPPLIER_GROUP_COLS)
            .order('sort_order', { ascending: true })
            .order('code', { ascending: true }),
        supabase
            .from('cenapro_rc_bank_accounts')
            .select(BANK_ACCOUNT_COLS)
            .order('bank_sort_order', { ascending: true })
            .order('sort_order', { ascending: true })
            .order('account_label', { ascending: true }),
    ]);

    const error = supplierRes.error?.message ?? accountRes.error?.message ?? null;
    return {
        suppliers: supplierRes.data ?? [],
        accounts: accountRes.data ?? [],
        error: error ? `Failed to load the payment pickers: ${error}` : null,
    };
}

export interface SupplierPaymentsResult {
    payments: PaymentRow[];
    canViewPrices: boolean;
    error: string | null;
}

/**
 * One trader's payments, newest first.
 *
 * SOFT-DELETED ROWS ARE INCLUDED, deliberately. §5c asked for reverting to be robust
 * throughout this feature, and a voided cheque that vanishes from the screen is not
 * recoverable in any sense an operator can act on — they cannot restore what they cannot
 * see. Every balance still excludes them, because the VIEW does; this list marks them
 * instead, and offers the restore.
 *
 * `supplierCode` is the payee, so a parent's list shows the cheques MADE OUT TO the
 * parent — not its children's. That is the correct reading: a payment is a fact about
 * who was paid. Which receipts it settles is Step 4.
 */
export async function fetchSupplierPayments(supplierCode: string): Promise<SupplierPaymentsResult> {
    const showPrices = await canViewPrices();
    if (!showPrices) return { payments: [], canViewPrices: false, error: null };

    const code = supplierCode.trim();
    if (!code) return { payments: [], canViewPrices: true, error: 'No trader was named.' };

    const supabase = await createClient();
    const { data, error } = await supabase
        .from('cenapro_rc_payments')
        .select(PAYMENT_COLS)
        .eq('supplier_code', code)
        .order('payment_date', { ascending: false })
        .order('created_at', { ascending: false })
        .limit(PAYMENT_MAX);

    if (error) {
        return { payments: [], canViewPrices: true, error: `Failed to load payments: ${error.message}` };
    }
    return { payments: data ?? [], canViewPrices: true, error: null };
}

export interface BanksResult {
    banks: BankRow[];
    accounts: BankAccountRow[];
    error: string | null;
}

/**
 * CI's own banks and their accounts — the maintenance screen's payload.
 *
 * INACTIVE ROWS ARE INCLUDED. A bank or account is retired with `active = false` and is
 * never deleted, because historic payments must keep naming it; a retired account that
 * vanished from this screen could never be restored by the person looking at it, and
 * they would have no way to see that it still exists at all. The pickers filter to
 * active; this screen shows everything and labels it.
 */
export async function fetchBanks(): Promise<BanksResult> {
    const supabase = await createClient();

    const [bankRes, accountRes] = await Promise.all([
        supabase
            .from('cenapro_rc_banks')
            .select(BANK_COLS_SELECT)
            .order('sort_order', { ascending: true })
            .order('code', { ascending: true }),
        supabase
            .from('cenapro_rc_bank_accounts')
            .select(BANK_ACCOUNT_COLS)
            .order('bank_sort_order', { ascending: true })
            .order('sort_order', { ascending: true })
            .order('account_label', { ascending: true }),
    ]);

    const error = bankRes.error?.message ?? accountRes.error?.message ?? null;
    return {
        banks: bankRes.data ?? [],
        accounts: accountRes.data ?? [],
        error: error ? `Failed to load banks and accounts: ${error}` : null,
    };
}

/** One revision, with `created_by` already resolved to a name the operator will recognise. */
export interface OpeningBalanceRevision {
    key: string;
    asOfDate: string | null;
    /** SIGNED, exactly as stored: negative = we owe them. */
    openingBalancePhp: number | string | null;
    note: string | null;
    isCurrent: boolean;
    createdAt: string | null;
    /** `null` for a service-role / psql write, which the dialog renders as "system". */
    actorName: string | null;
}

export interface OpeningBalanceHistoryResult {
    revisions: OpeningBalanceRevision[];
    canViewPrices: boolean;
    error: string | null;
}

/** A revision whose author's profile is gone. An expected state, not an error. */
const UNKNOWN_ACTOR = 'Unknown user';

const OPENING_HISTORY_MAX = 200;

/**
 * One trader's FULL opening-balance history, newest revision first.
 *
 * Every revision is shown, not just the current one, because that is the entire reason
 * the table is append-only: a figure someone will revise as suppliers confirm their
 * statements is worth nothing if the superseded numbers cannot be read back. `is_current`
 * comes from the view (the greatest `id` per supplier) — it is never re-derived here.
 *
 * ₱-BEARING, so it is behind the same gate as the balance itself and the query is not
 * issued at all when the gate refuses.
 */
export async function fetchOpeningBalanceHistory(
    supplierCode: string,
): Promise<OpeningBalanceHistoryResult> {
    const showPrices = await canViewPrices();
    if (!showPrices) return { revisions: [], canViewPrices: false, error: null };

    const code = supplierCode.trim();
    if (!code) return { revisions: [], canViewPrices: true, error: 'No trader was named.' };

    const supabase = await createClient();
    const { data, error } = await supabase
        .from('cenapro_rc_supplier_opening_balance_history')
        .select(OPENING_HISTORY_COLS)
        .eq('supplier_code', code)
        // `id` is a monotone identity, so this is both "newest first" and tie-free —
        // several revisions can share a `created_at` to the microsecond only in theory,
        // but ordering on the identity means it can never matter.
        .order('id', { ascending: false })
        .limit(OPENING_HISTORY_MAX);

    if (error) {
        return {
            revisions: [],
            canViewPrices: true,
            error: `Failed to load the opening-balance history: ${error.message}`,
        };
    }

    const rows = data ?? [];

    // ── Who stated each figure ───────────────────────────────────────────────────
    //
    // `created_by` is `auth.uid()` with DELIBERATELY no foreign key to `profiles`: this
    // row must outlive the account that wrote it, and an `ON DELETE SET NULL` would erase
    // the author exactly when it matters. So it is a separate lookup over the DISTINCT
    // uuids, and a miss renders as "Unknown user" rather than throwing. Same idiom as
    // `deliveries/actions.ts::getDeliveryHistory`.
    const actorIds = [
        ...new Set(
            rows
                .map((r) => r.created_by)
                .filter((v): v is string => typeof v === 'string' && v !== ''),
        ),
    ];
    const actors = new Map<string, string>();
    if (actorIds.length > 0) {
        const { data: profiles } = await supabase
            .from('profiles')
            .select('id, display_name, email')
            .in('id', actorIds);
        for (const p of profiles ?? []) {
            if (!p.id) continue;
            actors.set(p.id, (p.display_name ?? '').trim() || (p.email ?? '').trim() || UNKNOWN_ACTOR);
        }
    }

    return {
        revisions: rows.map((r, i) => ({
            key: r.id === null || r.id === undefined ? `rev-${i}` : String(r.id),
            asOfDate: r.as_of_date ?? null,
            openingBalancePhp: r.opening_balance_php ?? null,
            note: r.note ?? null,
            isCurrent: r.is_current === true,
            createdAt: r.created_at ?? null,
            actorName: r.created_by ? (actors.get(r.created_by) ?? UNKNOWN_ACTOR) : null,
        })),
        canViewPrices: true,
        error: null,
    };
}

export interface SupplierGroupsResult {
    suppliers: SupplierGroupRow[];
    error: string | null;
}

/** The subgroup maintenance screen's payload. Carries no ₱ at all (`rc_supplier` has none). */
export async function fetchSupplierGroups(): Promise<SupplierGroupsResult> {
    const supabase = await createClient();
    const { data, error } = await supabase
        .from('cenapro_rc_supplier_groups')
        .select(SUPPLIER_GROUP_COLS)
        .order('group_sort_order', { ascending: true })
        .order('sort_order', { ascending: true })
        .order('code', { ascending: true });

    if (error) return { suppliers: [], error: `Failed to load suppliers: ${error.message}` };
    return { suppliers: data ?? [], error: null };
}

// ═══ WRITE ══════════════════════════════════════════════════════════════════════

/** The RPCs' jsonb return, before any of it is trusted. */
interface RawRpcResult {
    ok?: unknown;
    outcome?: unknown;
    id?: unknown;
    code?: unknown;
    row_version?: unknown;
    message?: unknown;
}

function readOutcome(raw: unknown, fallback: LiquidationOutcome): LiquidationOutcome {
    return typeof raw === 'string' && (LIQUIDATION_OUTCOMES as readonly string[]).includes(raw)
        ? (raw as LiquidationOutcome)
        : fallback;
}

function readVersion(raw: unknown): number | null {
    return typeof raw === 'number' && Number.isFinite(raw) ? raw : null;
}

function readText(raw: unknown): string | null {
    return typeof raw === 'string' && raw.trim() ? raw : null;
}

/** Shape one RPC's jsonb into the result every caller here returns. */
function readResult(data: unknown, successOutcome: LiquidationOutcome): LiquidationResult {
    const r = (data ?? {}) as RawRpcResult;
    const ok = r.ok === true;
    return {
        ok,
        outcome: readOutcome(r.outcome, ok ? successOutcome : 'rpc_error'),
        message: readText(r.message),
        id: readText(r.id),
        code: readText(r.code),
        rowVersion: readVersion(r.row_version),
    };
}

function rpcFailure(message: string, outcome: LiquidationOutcome = 'rpc_error'): LiquidationResult {
    return { ok: false, outcome, message, id: null, code: null, rowVersion: null };
}

const FORBIDDEN = () => rpcFailure(PRICE_GATE_NOTE, 'forbidden');

export interface SavePaymentInput {
    /** `null` records a NEW payment; the RPC refuses an expected version alongside it. */
    id: string | null;
    /** Required on an edit, and MUST be absent on an insert. A blind write is refused. */
    expectedRowVersion: number | null;
    patch: PaymentPatch;
}

/**
 * Record or amend one payment.
 *
 * On an INSERT both `p_id` and `p_expected_row_version` are OMITTED rather than sent as
 * null — the generated Args type makes them optional, and the RPC refuses the call
 * outright if an expected version rides along with a null id.
 *
 * Nothing is retried and nothing is force-written: a `version_conflict` means another
 * human moved, and a human has to look.
 */
export async function savePayment(input: SavePaymentInput): Promise<LiquidationResult> {
    if (!(await canViewPrices())) return FORBIDDEN();

    const supabase = await createClient();
    const isInsert = input.id === null;

    const { data, error } = await supabase.rpc(
        'cenapro_save_rc_payment',
        isInsert
            ? { p_patch: input.patch }
            : {
                  p_id: input.id!,
                  p_expected_row_version: input.expectedRowVersion ?? undefined,
                  p_patch: input.patch,
              },
    );

    if (error) return rpcFailure(error.message);

    const result = readResult(data, isInsert ? 'inserted' : 'updated');
    if (result.ok) revalidateLiquidation();
    return result;
}

/**
 * Void a payment. SOFT — the row stays, `deleted_at` is stamped, and every balance
 * filters it out because the VIEW does. Undo with `restorePayment`.
 */
export async function deletePayment(id: string, expectedRowVersion: number): Promise<LiquidationResult> {
    if (!(await canViewPrices())) return FORBIDDEN();

    const supabase = await createClient();
    const { data, error } = await supabase.rpc('cenapro_delete_rc_payment', {
        p_id: id,
        p_expected_row_version: expectedRowVersion,
    });

    if (error) return rpcFailure(error.message);
    const result = readResult(data, 'deleted');
    if (result.ok) revalidateLiquidation();
    return result;
}

/**
 * Un-void a payment. Its own action rather than a flag on the delete, mirroring the RPCs
 * — §5c asked for reverting to be robust throughout the feature, and a soft delete that
 * cannot be undone is not reversibility. The DB refuses when the cheque number was
 * re-used in the meantime, and says so.
 */
export async function restorePayment(id: string, expectedRowVersion: number): Promise<LiquidationResult> {
    if (!(await canViewPrices())) return FORBIDDEN();

    const supabase = await createClient();
    const { data, error } = await supabase.rpc('cenapro_restore_rc_payment', {
        p_id: id,
        p_expected_row_version: expectedRowVersion,
    });

    if (error) return rpcFailure(error.message);
    const result = readResult(data, 'restored');
    if (result.ok) revalidateLiquidation();
    return result;
}

export interface SaveBankInput {
    code: string;
    /** `null` CREATES a bank with this code; otherwise UPDATE gated on the version. */
    expectedRowVersion: number | null;
    patch: RpcPatch;
}

/**
 * Create or amend one of CI's banks.
 *
 * `code` rides as the RPC's `p_code` and is NOT in the patch allowlist — re-keying a bank
 * cascades into every account under it, which is a data migration rather than a cell
 * edit. There is deliberately **no delete action** here and none in the database: a bank
 * is retired with `active = false`, because historic payments must keep naming it.
 */
export async function saveBank(input: SaveBankInput): Promise<LiquidationResult> {
    if (!(await canViewPrices())) return FORBIDDEN();

    const code = input.code.trim();
    if (!code) return rpcFailure('A bank code is required.', 'invalid');

    const supabase = await createClient();
    const { data, error } = await supabase.rpc('cenapro_save_rc_bank', {
        p_code: code,
        // OMITTED on create — the RPC reads a NULL expected version as "insert".
        ...(input.expectedRowVersion === null
            ? {}
            : { p_expected_row_version: input.expectedRowVersion }),
        p_patch: input.patch,
    });

    if (error) return rpcFailure(error.message);
    const result = readResult(data, input.expectedRowVersion === null ? 'inserted' : 'updated');
    if (result.ok) revalidateLiquidation();
    return result;
}

export interface SaveBankAccountInput {
    /** `null` CREATES an account; the RPC refuses an expected version alongside it. */
    id: string | null;
    expectedRowVersion: number | null;
    patch: RpcPatch;
}

/**
 * Create or amend one bank account — a cheque book's home.
 *
 * Also has no delete path, for the same reason as the bank, and additionally because a
 * cheque's account is half its identity: the shape CHECK on `rc_payment` turns the FK's
 * `ON DELETE SET NULL` into an outright refusal for a cheque, so a cheque's account is
 * structurally undeletable. Retire with `active = false`.
 */
export async function saveBankAccount(input: SaveBankAccountInput): Promise<LiquidationResult> {
    if (!(await canViewPrices())) return FORBIDDEN();

    const supabase = await createClient();
    const isInsert = input.id === null;

    const { data, error } = await supabase.rpc(
        'cenapro_save_rc_bank_account',
        isInsert
            ? { p_patch: input.patch }
            : {
                  p_id: input.id!,
                  p_expected_row_version: input.expectedRowVersion ?? undefined,
                  p_patch: input.patch,
              },
    );

    if (error) return rpcFailure(error.message);
    const result = readResult(data, isInsert ? 'inserted' : 'updated');
    if (result.ok) revalidateLiquidation();
    return result;
}

/**
 * APPEND a stated opening balance for one trader.
 *
 * ── THERE IS NO UPDATE AND NO DELETE, BY DESIGN ───────────────────────────────────
 * `cenapro.rc_supplier_opening_balance` is APPEND-ONLY, locked twice over: no client role
 * holds UPDATE or DELETE on it, and RLS carries no UPDATE or DELETE policy. "Modifying" a
 * starting balance means appending a NEW REVISION, and the newest (greatest `id`) is the
 * one every balance reads. So there is deliberately no `updateOpeningBalance` and no
 * `deleteOpeningBalance` beside this — either would fail with a permission error, and a
 * money history that can be silently rewritten is worth nothing anyway.
 *
 * There is likewise NO `expectedRowVersion`: an append cannot conflict with anything, so
 * there is nothing to compare and set. Two people stating a figure at once produce two
 * revisions and the later one wins, which is the correct outcome and is visible in the
 * history rather than lost.
 *
 * ── THE SIGN IS ALREADY APPLIED ───────────────────────────────────────────────────
 * `openingBalancePhp` arrives SIGNED (negative = we owe them). It comes from
 * `openingSignedAmount` in `types.ts`, which is the one place the operator's positive
 * figure plus their "we owe them" / "they owe us" choice becomes a signed number. Nothing
 * here re-derives or re-checks the sign: a second opinion about it is exactly how the two
 * would drift apart.
 *
 * The RPC refuses an unknown supplier, a missing amount or date, a non-finite amount, more
 * than two decimal places, and a future as-of date (measured in Asia/Manila). It does NOT
 * refuse a zero amount, a positive amount, a re-statement of the same numbers, or a date
 * earlier than an existing revision — revising downward or backward is what this is for.
 */
export async function setOpeningBalance(input: SetOpeningBalanceArgs): Promise<LiquidationResult> {
    if (!(await canViewPrices())) return FORBIDDEN();

    const code = input.supplierCode.trim();
    if (!code) return rpcFailure('No trader was named.', 'invalid');

    const supabase = await createClient();
    const { data, error } = await supabase.rpc('cenapro_set_rc_supplier_opening_balance', {
        p_supplier_code: code,
        p_as_of_date: input.asOfDate,
        p_opening_balance_php: input.openingBalancePhp,
        // Omitted rather than sent as null when blank — the RPC defaults it, and the stamp
        // trigger owns blanking, so an empty note normalises identically on every path.
        ...(input.note === null ? {} : { p_note: input.note }),
    });

    if (error) return rpcFailure(error.message);
    const result = readResult(data, 'inserted');
    if (result.ok) revalidateLiquidation();
    return result;
}

export interface SaveSupplierParentInput {
    code: string;
    expectedRowVersion: number;
    /** `null` CLEARS the grouping and makes the trader a root again. */
    parentCode: string | null;
}

/**
 * Point one trader at a parent, or clear it.
 *
 * The patch carries `parent_code` AND NOTHING ELSE. That is the point: the RPC's
 * allowlist would happily take `display_name`, `sort_order`, `active` and `notes` too,
 * and sending a whole form back would let this maintenance screen clobber a field it
 * never showed. `code` is not in the allowlist at all — renaming a code moves every
 * receipt that names it and splits its audit trail.
 *
 * The one-level rule is enforced by the DB in two places (a readable pre-check in the RPC
 * and a constraint trigger that holds for every other write path). Its refusal is quoted
 * verbatim; re-wording "…already has sub-supplier(s) (LLANTO), so it cannot itself become
 * one" into "invalid parent" would throw away the instruction it contains.
 */
export async function saveSupplierParent(input: SaveSupplierParentInput): Promise<LiquidationResult> {
    if (!(await canViewPrices())) return FORBIDDEN();

    const code = input.code.trim();
    if (!code) return rpcFailure('No supplier was named.', 'invalid');

    const supabase = await createClient();
    const { data, error } = await supabase.rpc('cenapro_save_rc_supplier', {
        p_code: code,
        p_expected_row_version: input.expectedRowVersion,
        p_patch: { parent_code: input.parentCode },
    });

    if (error) return rpcFailure(error.message);
    const result = readResult(data, 'updated');
    if (result.ok) revalidateLiquidation();
    return result;
}
