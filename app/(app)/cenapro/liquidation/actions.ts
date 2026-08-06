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
    allocationsPayload,
    fillOldestFirst,
    num,
    type AllocationInput,
    type BankAccountRow,
    type BankRow,
    type DeliverySettlementRow,
    type LiquidationOutcome,
    type LiquidationResult,
    type PaymentAllocationRow,
    type PaymentPatch,
    type PaymentStateRow,
    type RpcPatch,
    type SetOpeningBalanceArgs,
    type SpreadLine,
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
    // Step 4: the RECEIPT LEDGER is now a consumer too. `/cenapro/deliveries` renders a
    // settlement column read from `cenapro_rc_delivery_settlement`, and both allocation
    // doors call the same write path — so an assignment made from the spread screen has to
    // move the ledger's column, and one made from the ledger's own context menu has to
    // move the balance. One helper, so a new write path cannot forget either side.
    revalidatePath('/cenapro/deliveries');
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
// Step 4 (allocation) widened both balance views again: `advance_php` +
// `advance_payment_count` + `unassigned_incoming_php` + `advance_php_window`. Step 3
// deliberately omitted them — with no allocations, every peso of every payment was
// unallocated, so the column would have read 100% on every row and taught the UI
// something false. They are computable now, and they are appended below.
const BALANCE_COLS =
    'supplier_code, display_name, active, sort_order, is_unassigned, parent_code, group_code, group_display_name, group_sort_order, is_parent, is_child, receipt_count, receipts_php, first_receipt_date, last_receipt_date, unpriced_receipt_count, unpriced_receipt_kg, unpriced_awaiting_weight_count, unpriced_awaiting_price_count, unpriced_awaiting_both_count, payment_count, payments_php, cash_out_php, cash_in_php, cash_net_php, adjustment_php, adjustment_count, first_payment_date, last_payment_date, running_balance_php, opening_balance_php, opening_as_of_date, has_opening_balance, opening_note, opening_set_at, opening_revision_id, opening_revision_count, carried_receipt_count, carried_receipt_php, carried_payment_count, carried_payment_php, receipt_count_all, receipts_all_php, payment_count_all, payments_all_php, cash_out_all_php, cash_in_all_php, cash_net_all_php, adjustment_all_php, adjustment_count_all, running_balance_all_php, unpriced_receipt_count_window, unpriced_receipt_kg_window, advance_php, advance_payment_count, unassigned_incoming_php, advance_php_window';

const GROUP_BALANCE_COLS =
    'group_code, group_display_name, group_sort_order, is_unassigned, supplier_count, child_count, supplier_codes, any_active, receipt_count, receipts_php, first_receipt_date, last_receipt_date, unpriced_receipt_count, unpriced_receipt_kg, unpriced_awaiting_weight_count, unpriced_awaiting_price_count, unpriced_awaiting_both_count, payment_count, payments_php, cash_out_php, cash_in_php, cash_net_php, adjustment_php, adjustment_count, first_payment_date, last_payment_date, running_balance_php, opening_balance_php, has_opening_balance, opening_supplier_count, opening_as_of_date, opening_as_of_date_min, opening_as_of_date_max, carried_receipt_count, carried_receipt_php, carried_payment_count, carried_payment_php, receipt_count_all, receipts_all_php, payment_count_all, payments_all_php, cash_out_all_php, cash_in_all_php, cash_net_all_php, adjustment_all_php, adjustment_count_all, running_balance_all_php, unpriced_receipt_count_window, unpriced_receipt_kg_window, advance_php, advance_payment_count, unassigned_incoming_php, advance_php_window';

// `cenapro_rc_payment_state` is `cenapro_rc_payments` + four columns, so this is the
// payments projection plus what has been assigned out of each one. Read the STATE view
// everywhere, never the plainer one: a payments list that cannot say how much of a cheque
// is still unassigned sends the operator to a second screen to find out, and
// `unallocated_php` has exactly ONE definition (that view) which the balance also reads.
const PAYMENT_COLS =
    'id, supplier_code, supplier_name, group_code, group_display_name, payment_date, method, amount_php, direction, stated_term, bank_account_id, bank_code, bank_display_name, account_label, account_no, bank_account_label, cheque_no, cheque_date, reference_no, remarks, balance_effect_php, is_cash, is_deleted, deleted_at, deleted_by, row_version, created_at, created_by, updated_at, updated_by, allocated_php, unallocated_php, allocation_count, is_advance';

/** One row per receipt: what it is worth, what is assigned, what is still owed. */
const SETTLEMENT_COLS =
    'delivery_id, supplier_code, supplier_display_name, group_code, group_display_name, delivery_date, truck_no, destination_code, net_weight_kg, total_price_php, is_priceable, is_allocatable, allocated_php, balance_php, allocation_count, payment_ids, last_allocated_at, settlement_status, row_version';

/** One payment→receipt edge, both ends folded in. Soft-deleted edges INCLUDED. */
const ALLOCATION_COLS =
    'id, payment_id, delivery_id, amount_php, payee_group_code, note, payment_supplier_code, payment_supplier_name, payment_date, method, cheque_no, payment_amount_php, payment_is_deleted, delivery_supplier_code, delivery_supplier_name, delivery_date, truck_no, delivery_total_php, is_subgroup_allocation, is_deleted, deleted_at, deleted_by, row_version, created_at, created_by, updated_at, updated_by';

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
 * The two lists the payment form picks from.
 *
 * ── IT GATES ITSELF, AND IT DID NOT USED TO ──────────────────────────────────────
 * Neither list carries a ₱ column, and while this was only reached from
 * `/cenapro/liquidation` — a route gated in its own `page.tsx` before anything renders —
 * relying on the caller was defensible. Step 4 gave it a SECOND caller,
 * `/cenapro/deliveries`, which serves gated and ungated viewers alike: a Production role
 * loading the receipt ledger would have been handed CI's bank-account list, with the
 * account numbers on it. Relying on a caller's gate is exactly how a boundary leaks the
 * first time someone adds a caller, so the check moved in here where it cannot be
 * forgotten. The liquidation route is unaffected — it was already behind the same gate.
 */
export async function fetchPaymentDimensions(): Promise<PaymentDimensionsResult> {
    if (!(await canViewPrices())) return { suppliers: [], accounts: [], error: null };

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
    /**
     * Read from `cenapro_rc_payment_state`, so every row already carries
     * `allocated_php` / `unallocated_php` / `allocation_count` / `is_advance`. Step 4
     * changed this from `cenapro_rc_payments` (a strict subset): the panel's whole job is
     * to make a payment something other than write-only, and "how much of this cheque is
     * still unassigned" is now the most useful thing on the row.
     */
    payments: PaymentStateRow[];
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
        .from('cenapro_rc_payment_state')
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

// ═══ READ — allocation (Step 4) ═════════════════════════════════════════════════
//
// Two doors, and each needs a different slice of the SAME two views. Neither door gets a
// read the other cannot reuse.
//
// ── Every one of these is ₱-BEARING and the query is NOT ISSUED when the gate refuses ──
// `cenapro_rc_delivery_settlement` carries `total_price_php`, `allocated_php` and
// `balance_php`; `cenapro_rc_payment_state` carries the cheque's face value. There is no
// useful redacted version of either — remove the money and a settlement row is a date and
// a truck number. So the gate is the same coarse, early one the rest of this module uses:
// refuse, return empty, and never let the money into the network response in the first
// place. This is deliberately STRONGER than `deliveries/types.ts::stripPrices()`, which
// nulls named fields on a row it still returns.

/** How many receipts one spread screen will list. A trader's whole history is ~280 rows. */
const SPREAD_MAX = 1000;

/** Payments a delivery-first assignment may choose from. Small by construction. */
const PAYMENT_PICKER_MAX = 200;

export interface SpreadResult {
    /** The payment being spread, WITH its `unallocated_php`. `null` when it is gone. */
    payment: PaymentStateRow | null;
    /**
     * The payee's own receipts AND its sub-suppliers' — resolved through
     * `group_code`, the ONE definition, never re-derived from names. Oldest first.
     */
    settlements: DeliverySettlementRow[];
    /** The edges already saved against THIS payment. Live ones only. */
    allocations: PaymentAllocationRow[];
    canViewPrices: boolean;
    error: string | null;
}

/**
 * Everything the spread screen renders, in one call.
 *
 * The receipt list is scoped by **`group_code`**, not by `supplier_code`: a cheque made
 * out to a parent may legitimately settle a sub-supplier's delivery (§5a), and the DB
 * enforces exactly that rule on the write path. Scoping the list any other way would
 * offer the operator a set of receipts the RPC would then refuse — or hide ones it would
 * accept.
 *
 * Ordered **oldest first** because that is how a cheque is actually spread, and it is what
 * `Fill oldest first` walks.
 */
export async function fetchSpread(paymentId: string): Promise<SpreadResult> {
    const showPrices = await canViewPrices();
    if (!showPrices) {
        return { payment: null, settlements: [], allocations: [], canViewPrices: false, error: null };
    }

    const id = paymentId.trim();
    if (!id) {
        return { payment: null, settlements: [], allocations: [], canViewPrices: true, error: 'No payment was named.' };
    }

    const supabase = await createClient();

    const { data: payment, error: payErr } = await supabase
        .from('cenapro_rc_payment_state')
        .select(PAYMENT_COLS)
        .eq('id', id)
        .maybeSingle();

    if (payErr) {
        return {
            payment: null, settlements: [], allocations: [], canViewPrices: true,
            error: `Failed to load the payment: ${payErr.message}`,
        };
    }
    if (!payment) {
        return { payment: null, settlements: [], allocations: [], canViewPrices: true, error: null };
    }

    // The payee's GROUP, read from its one definition rather than assembled here.
    const groupCode = payment.group_code ?? payment.supplier_code ?? '';

    const [settleRes, allocRes] = await Promise.all([
        supabase
            .from('cenapro_rc_delivery_settlement')
            .select(SETTLEMENT_COLS)
            .eq('group_code', groupCode)
            .order('delivery_date', { ascending: true, nullsFirst: true })
            .order('delivery_id', { ascending: true })
            .limit(SPREAD_MAX),
        supabase
            .from('cenapro_rc_payment_allocations')
            .select(ALLOCATION_COLS)
            .eq('payment_id', id)
            .eq('is_deleted', false)
            .order('delivery_date', { ascending: true, nullsFirst: true }),
    ]);

    const error = settleRes.error?.message ?? allocRes.error?.message ?? null;
    return {
        payment,
        settlements: settleRes.data ?? [],
        allocations: allocRes.data ?? [],
        canViewPrices: true,
        error: error ? `Failed to load the receipts to spread across: ${error}` : null,
    };
}

export interface AllocationTargetsResult {
    /**
     * Payments that could still take money — the payee's own AND, when the receipt
     * belongs to a sub-supplier, the parent's. Only live payments with something left.
     */
    payments: PaymentStateRow[];
    /** The receipt's settlement state, so the picker can default the amount honestly. */
    settlement: DeliverySettlementRow | null;
    canViewPrices: boolean;
    error: string | null;
}

/**
 * The delivery-first door's payload: *which cheques could pay for THIS receipt.*
 *
 * Renzo: *"right click on a delivery and then assign a cheque to it."* The candidate set
 * is every live payment whose payee resolves to the receipt's own `group_code` and which
 * still has `unallocated_php > 0` — i.e. exactly the payments the RPC would accept. A
 * picker that offered a fully-assigned cheque would be offering a guaranteed refusal.
 *
 * Note the group is read off the SETTLEMENT row (which gets it from
 * `view_rc_supplier_group`), not from the delivery's `supplier_code`: a sub-supplier's
 * receipt has to find its PARENT's cheques, which is the entire point of §5a.
 */
export async function fetchAllocationTargets(deliveryId: string): Promise<AllocationTargetsResult> {
    const showPrices = await canViewPrices();
    if (!showPrices) {
        return { payments: [], settlement: null, canViewPrices: false, error: null };
    }

    const id = deliveryId.trim();
    if (!id) {
        return { payments: [], settlement: null, canViewPrices: true, error: 'No receipt was named.' };
    }

    const supabase = await createClient();
    const { data: settlement, error: sErr } = await supabase
        .from('cenapro_rc_delivery_settlement')
        .select(SETTLEMENT_COLS)
        .eq('delivery_id', id)
        .maybeSingle();

    if (sErr) {
        return {
            payments: [], settlement: null, canViewPrices: true,
            error: `Failed to load the receipt’s settlement state: ${sErr.message}`,
        };
    }
    if (!settlement) {
        return { payments: [], settlement: null, canViewPrices: true, error: null };
    }

    // No payee ⇒ no cheque can ever point at it, and the RPC refuses by name. Say so
    // rather than issuing a query whose answer is meaningless.
    const groupCode = settlement.group_code;
    if (!settlement.supplier_code || !groupCode) {
        return { payments: [], settlement, canViewPrices: true, error: null };
    }

    const { data, error } = await supabase
        .from('cenapro_rc_payment_state')
        .select(PAYMENT_COLS)
        .eq('group_code', groupCode)
        .eq('is_deleted', false)
        .gt('unallocated_php', 0)
        .order('payment_date', { ascending: false })
        .order('created_at', { ascending: false })
        .limit(PAYMENT_PICKER_MAX);

    return {
        payments: data ?? [],
        settlement,
        canViewPrices: true,
        error: error ? `Failed to load the payments with money left: ${error.message}` : null,
    };
}

export interface SettlementsResult {
    settlements: DeliverySettlementRow[];
    canViewPrices: boolean;
    error: string | null;
}

/**
 * The settlement state of an explicit set of receipts — what the deliveries ledger's
 * multi-select "record a cheque for these" needs, and nothing more.
 *
 * Batched by id rather than by supplier: the operator's selection is the question, and
 * re-deriving it from a supplier filter would answer a different one.
 */
export async function fetchSettlementsFor(deliveryIds: string[]): Promise<SettlementsResult> {
    const showPrices = await canViewPrices();
    if (!showPrices) return { settlements: [], canViewPrices: false, error: null };

    const ids = deliveryIds.map((s) => s.trim()).filter(Boolean);
    if (ids.length === 0) return { settlements: [], canViewPrices: true, error: null };

    const supabase = await createClient();
    const { data, error } = await supabase
        .from('cenapro_rc_delivery_settlement')
        .select(SETTLEMENT_COLS)
        .in('delivery_id', ids.slice(0, SPREAD_MAX))
        .order('delivery_date', { ascending: true, nullsFirst: true })
        .order('delivery_id', { ascending: true });

    return {
        settlements: data ?? [],
        canViewPrices: true,
        error: error ? `Failed to load the selected receipts’ settlement state: ${error.message}` : null,
    };
}

export interface DeliveryAllocationsResult {
    /** Every edge on this receipt, soft-deleted ones INCLUDED (they are the history). */
    allocations: PaymentAllocationRow[];
    canViewPrices: boolean;
    error: string | null;
}

/**
 * Which payments have been assigned to ONE receipt — the deliveries ledger's
 * "what is already on this row" panel.
 *
 * Soft-deleted edges are included on purpose, the same reasoning as voided payments: a
 * released assignment belongs on a history list, and nobody can restore what they cannot
 * see. Anything doing arithmetic filters `is_deleted` itself.
 */
export async function fetchDeliveryAllocations(
    deliveryId: string,
): Promise<DeliveryAllocationsResult> {
    const showPrices = await canViewPrices();
    if (!showPrices) return { allocations: [], canViewPrices: false, error: null };

    const id = deliveryId.trim();
    if (!id) return { allocations: [], canViewPrices: true, error: 'No receipt was named.' };

    const supabase = await createClient();
    const { data, error } = await supabase
        .from('cenapro_rc_payment_allocations')
        .select(ALLOCATION_COLS)
        .eq('delivery_id', id)
        .order('payment_date', { ascending: false })
        .order('created_at', { ascending: false })
        .limit(PAYMENT_PICKER_MAX);

    return {
        allocations: data ?? [],
        canViewPrices: true,
        error: error ? `Failed to load this receipt’s payments: ${error.message}` : null,
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

// ═══ WRITE — allocation (Step 4). ONE write path, two doors. ════════════════════
//
// `public.cenapro_save_rc_payment_allocations` replaces one payment's WHOLE live
// allocation block in a single atomic call, and
// `public.cenapro_allocate_delivery_to_payment` is a thin convenience for the
// delivery-first door that is IMPLEMENTED ON TOP OF IT in SQL — it merges its one edge
// into the payment's live block and delegates. So there is one code path, one set of
// invariants and zero duplicated validation, in the database as well as here.
//
// Every refusal these RPCs return names precisely which of a dozen rules was broken —
// the overshoot in pesos, both traders when a subgroup does not cover an edge, the receipt
// with no payee by date and truck. It is passed through VERBATIM. `errorToast` shows it.

export interface SavePaymentAllocationsInput {
    paymentId: string;
    /** The PARENT PAYMENT's version. A cheque's edges are edited as one block. */
    expectedRowVersion: number;
    /** The whole new block. `[]` un-assigns the payment completely. */
    allocations: AllocationInput[];
}

/**
 * Spread one payment across receipts — the cheque-first door, and the only place a block
 * is written.
 *
 * **Atomic, and that is the requirement, not a nicety.** "Apply this cheque across four
 * receipts" must never half-apply: the RPC bumps the parent first (which row-locks it and
 * fires the compare-and-set), soft-deletes the edges the new block no longer mentions, then
 * upserts the whole block in ONE statement so the constraint trigger sees the final state
 * exactly once. A legal rearrangement — move ₱200k from receipt A to receipt B — would trip
 * the invariant halfway through if it were several statements.
 *
 * Edges left out of `allocations` are SOFT-deleted and restorable (§5c), never destroyed.
 */
export async function savePaymentAllocations(
    input: SavePaymentAllocationsInput,
): Promise<LiquidationResult> {
    if (!(await canViewPrices())) return FORBIDDEN();

    const id = input.paymentId.trim();
    if (!id) return rpcFailure('No payment was named.', 'invalid');

    const supabase = await createClient();
    const { data, error } = await supabase.rpc('cenapro_save_rc_payment_allocations', {
        p_payment_id: id,
        p_expected_row_version: input.expectedRowVersion,
        p_allocations: input.allocations,
    });

    if (error) return rpcFailure(error.message);
    const result = readResult(data, 'saved');
    if (result.ok) revalidateLiquidation();
    return result;
}

export interface AllocateDeliveryInput {
    paymentId: string;
    expectedRowVersion: number;
    deliveryId: string;
    /**
     * `null` means **as much as is needed and as much as is available** —
     * `LEAST(what the receipt still owes, what the payment still has unassigned)`,
     * computed in SQL because that is where money arithmetic belongs. The RPC refuses it
     * when the receipt has no price yet (there is no "still owed" to fill) and when
     * nothing is left on the cheque.
     */
    amountPhp: number | null;
    note?: string | null;
}

/**
 * Assign ONE receipt to an existing payment — the delivery-first door.
 *
 * **It SETS the edge, it does not add to it.** Calling it twice with ₱300,000 leaves
 * ₱300,000 assigned, not ₱600,000: the block RPC underneath is a replace, and an "add"
 * would make the same call twice mean two different things. The previous amount comes back
 * in the response so the UI can say *"was ₱400,000, now ₱300,000."*
 */
export async function allocateDeliveryToPayment(
    input: AllocateDeliveryInput,
): Promise<LiquidationResult> {
    if (!(await canViewPrices())) return FORBIDDEN();

    const paymentId = input.paymentId.trim();
    const deliveryId = input.deliveryId.trim();
    if (!paymentId || !deliveryId) {
        return rpcFailure('Both a payment and a receipt are required.', 'invalid');
    }

    const supabase = await createClient();
    const { data, error } = await supabase.rpc('cenapro_allocate_delivery_to_payment', {
        p_payment_id: paymentId,
        p_expected_row_version: input.expectedRowVersion,
        p_delivery_id: deliveryId,
        // OMITTED rather than sent as null when the caller wants the SQL default:
        // `p_amount_php => NULL` and "no argument" mean the same thing to the RPC, and
        // omitting keeps the two indistinguishable at this layer too.
        ...(input.amountPhp === null ? {} : { p_amount_php: input.amountPhp }),
        ...(input.note ? { p_note: input.note } : {}),
    });

    if (error) return rpcFailure(error.message);
    const result = readResult(data, 'saved');
    if (result.ok) revalidateLiquidation();
    return result;
}

export interface AllocateOldestFirstInput {
    paymentId: string;
    /** The receipts to cover, in the order they should be covered. */
    deliveryIds: string[];
}

/**
 * Spread a payment across an explicit set of receipts, oldest first, in ONE atomic call.
 *
 * ── WHAT THIS IS FOR ─────────────────────────────────────────────────────────────
 * The delivery-first door's *"record a cheque for these receipts"*. §7a: creating a
 * payment for exactly the selected total **is** the `straight` term Renzo described — pay
 * the exact amount upon delivery — so the natural completion of that flow is to point the
 * new cheque at the receipts it was written for, without making the operator do it twice.
 *
 * ── WHY IT IS ONE CALL AND NOT N ─────────────────────────────────────────────────
 * `cenapro_allocate_delivery_to_payment` could be called once per receipt, and each call
 * would compute its own amount in SQL — but N calls are N transactions, so a failure
 * halfway leaves a HALF-APPLIED CHEQUE, which is the exact thing the block RPC exists to
 * make impossible. So the block is assembled here and written once.
 *
 * ── THE ARITHMETIC, AND WHY IT IS ALLOWED HERE ───────────────────────────────────
 * `fillOldestFirst` distributes the payment over `balance_php` values **read from
 * `cenapro_rc_delivery_settlement`** — it does not compute a balance, it chooses a
 * DISTRIBUTION over balances the database supplied. Every figure it consumes and every
 * figure it produces is then re-validated by the RPC and the constraint trigger. It also
 * SKIPS a receipt with no price yet, which is the one rule that matters most: an unpriced
 * receipt has no known outstanding amount, so filling it would assign nothing and mark it
 * settled forever.
 *
 * The payment's `row_version` is read here rather than passed in, because the caller has
 * just created it and has no version to hold. The RPC still compare-and-sets against what
 * was read, so a concurrent change between the read and the write is still caught.
 */
export async function allocateOldestFirst(
    input: AllocateOldestFirstInput,
): Promise<LiquidationResult> {
    if (!(await canViewPrices())) return FORBIDDEN();

    const paymentId = input.paymentId.trim();
    const ids = input.deliveryIds.map((s) => s.trim()).filter(Boolean);
    if (!paymentId) return rpcFailure('No payment was named.', 'invalid');
    if (ids.length === 0) return rpcFailure('No receipts were named.', 'invalid');

    const supabase = await createClient();

    const [payRes, settleRes] = await Promise.all([
        supabase
            .from('cenapro_rc_payment_state')
            .select('id, amount_php, unallocated_php, row_version, is_deleted')
            .eq('id', paymentId)
            .maybeSingle(),
        supabase
            .from('cenapro_rc_delivery_settlement')
            .select(SETTLEMENT_COLS)
            .in('delivery_id', ids.slice(0, SPREAD_MAX))
            .order('delivery_date', { ascending: true, nullsFirst: true })
            .order('delivery_id', { ascending: true }),
    ]);

    if (payRes.error) return rpcFailure(payRes.error.message);
    if (settleRes.error) return rpcFailure(settleRes.error.message);

    const payment = payRes.data;
    if (!payment || payment.is_deleted) {
        return rpcFailure('That payment no longer exists, or it has been voided.', 'not_found');
    }
    if (payment.row_version === null || payment.row_version === undefined) {
        return rpcFailure('That payment is missing its version token — reload and try again.', 'invalid');
    }

    const available = num(payment.unallocated_php) ?? 0;
    if (available <= 0) {
        return rpcFailure(
            'Every peso of that payment is already assigned to other receipts, so there is nothing left to spread.',
            'invalid',
        );
    }

    // Existing edges are preserved: the block RPC is a REPLACE, so anything already
    // assigned that is not in this block would be released. A cheque recorded seconds ago
    // has none, but this function must not depend on that.
    const { data: existing } = await supabase
        .from('cenapro_rc_payment_allocations')
        .select('delivery_id, amount_php, note')
        .eq('payment_id', paymentId)
        .eq('is_deleted', false);

    const keep: AllocationInput[] = [];
    const held = new Set<string>();
    for (const e of existing ?? []) {
        const amt = num(e.amount_php);
        if (!e.delivery_id || amt === null || amt <= 0) continue;
        keep.push({ delivery_id: e.delivery_id, amount_php: amt, note: e.note ?? null });
        held.add(e.delivery_id);
    }

    const lines: SpreadLine[] = (settleRes.data ?? [])
        .filter((s): s is DeliverySettlementRow & { delivery_id: string } => !!s.delivery_id)
        // A receipt this payment already covers is not filled again — its existing edge is
        // carried through untouched above.
        .filter((s) => !held.has(s.delivery_id))
        .map((s) => ({ deliveryId: s.delivery_id, settlement: s, existing: null, isSubgroup: false }));

    const filled = fillOldestFirst(lines, available);
    const fresh = allocationsPayload(filled);

    if (fresh.length === 0) {
        return rpcFailure(
            'None of those receipts could be filled — they are either already settled or have no agreed price yet, so nobody knows what is owed on them. Assign an amount by hand if you mean to.',
            'invalid',
        );
    }

    const { data, error } = await supabase.rpc('cenapro_save_rc_payment_allocations', {
        p_payment_id: paymentId,
        p_expected_row_version: payment.row_version,
        p_allocations: [...keep, ...fresh],
    });

    if (error) return rpcFailure(error.message);
    const result = readResult(data, 'saved');
    if (result.ok) revalidateLiquidation();
    return result;
}

/**
 * Un-release one allocation.
 *
 * Gated on the ALLOCATION's own version rather than the payment's — this is a single-row
 * act on a row the block editor is not holding, and the "allocations ≤ amount" invariant is
 * guaranteed by the constraint trigger regardless. §5c asked for reverting to be robust
 * THROUGHOUT the feature, and a soft delete you cannot undo is not reversibility.
 */
export async function restorePaymentAllocation(
    id: string,
    expectedRowVersion: number,
): Promise<LiquidationResult> {
    if (!(await canViewPrices())) return FORBIDDEN();

    const supabase = await createClient();
    const { data, error } = await supabase.rpc('cenapro_restore_rc_payment_allocation', {
        p_id: id,
        p_expected_row_version: expectedRowVersion,
    });

    if (error) return rpcFailure(error.message);
    const result = readResult(data, 'restored');
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
