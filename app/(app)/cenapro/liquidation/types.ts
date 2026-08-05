// ─────────────────────────────────────────────────────────────────────────────────
// Cenapro LIQUIDATION — the shared vocabulary. PURE module: no 'use client', no React,
// no Supabase. The server page, the server actions and the client screens all import
// it, so every rule below is expressed EXACTLY ONCE.
//
// Three rules live here and are the reason the file exists at all.
//
// ── 1. THE SIGN, AND ITS WORDS ───────────────────────────────────────────────────
// `running_balance_php = payments_php − receipts_php`, so **NEGATIVE MEANS WE OWE THE
// SUPPLIER** and positive means the supplier owes us. That is Renzo's convention
// verbatim (decision 5) and it is the OPPOSITE of the accounts-payable sign an
// accountant would write. A bare minus on a screen is therefore not merely terse — it
// is actively misleading to anyone who reads it with an accountant's reflexes.
//
// So the sign is never rendered alone. `balanceDirection()` turns the number into one
// of three WORDS, and the screen prints the word next to the figure every single time.
// The rule is stated in the header of the table too — not in a tooltip, which is a
// place a wrong reading never goes looking.
//
// ── 2. A NON-ZERO BALANCE IS NOT AN ERROR ────────────────────────────────────────
// Decision 8 killed the per-supplier rounding rule outright: suppliers deliberately
// carry remainders, and 447 of 971 receipts are not a whole peso. A ₱132.875 balance is
// ordinary business. There is therefore NO error styling anywhere in this module for a
// non-zero balance — no red, no badge, no warning icon, no auto-close — and none may be
// added later. `formatBalance` keeps up to FOUR decimals for the same reason: rounding
// ₱132.875 to ₱132.88 on screen would invent a discrepancy the ledger does not have.
//
// ── 3. THE WARNING THAT IS INVISIBLE IN PESOS ────────────────────────────────────
// `total_price_php` is a generated column that COALESCEs both factors to zero, so an
// unweighed or unpriced receipt reads ₱0, not NULL. `SUM(total_price_php)` and
// `SUM(...) FILTER (priceable)` are therefore numerically IDENTICAL on every supplier,
// forever — the balance is arithmetically RIGHT while carrying receipts nobody can
// price, and no amount anywhere reveals the gap. SEVILLA is the live proof: balance
// ₱0.00, and two receipts that cannot be priced.
//
// The ONLY thing that can say so is `unpriced_receipt_count`, which is why it is a
// first-class column on the screen rather than a hover. `unpricedPhrase()` names the
// STAGE ("2 receipts awaiting weight") rather than guessing, because the view
// partitions the count exhaustively — and "priced but not yet weighed" is a normal
// daily stage in a receipt's life, not a fault. The wording says *pending*, never
// *broken*.
// ─────────────────────────────────────────────────────────────────────────────────

import type { Database } from '@/types/supabase';

// ─── Row shapes (derived from the generated types — never hand-authored) ─────────

/** One trader's running balance, plus the synthetic no-payee row. */
export type SupplierBalanceRow =
    Database['public']['Views']['cenapro_rc_supplier_balances']['Row'];
/** The same measures rolled up by `group_code` — the parent rows of the screen. */
export type SupplierGroupBalanceRow =
    Database['public']['Views']['cenapro_rc_supplier_group_balances']['Row'];
/** One money movement, with `balance_effect_php` and `is_cash` already resolved. */
export type PaymentRow = Database['public']['Views']['cenapro_rc_payments']['Row'];
/** A supplier with its subgroup resolution — the ONE definition of `group_code`. */
export type SupplierGroupRow = Database['public']['Views']['cenapro_rc_supplier_groups']['Row'];
/** One of CI's bank accounts, with its bank's name folded in. */
export type BankAccountRow = Database['public']['Views']['cenapro_rc_bank_accounts']['Row'];
/** One of CI's own banks — the dimension a cheque or transfer is drawn on. */
export type BankRow = Database['public']['Views']['cenapro_rc_banks']['Row'];

// ─── Numbers ────────────────────────────────────────────────────────────────────

/**
 * ONE coercion for every numeric that crosses the wire. PostgREST may hand a `numeric`
 * back as a JSON number or as a string depending on the column; both are accepted here
 * so no call site has to care, exactly as `deliveries/types.ts` does.
 */
export function num(v: number | string | null | undefined): number | null {
    if (v === null || v === undefined || v === '') return null;
    const n = typeof v === 'number' ? v : Number(v);
    return Number.isFinite(n) ? n : null;
}

/**
 * Pesos, keeping up to FOUR decimals.
 *
 * Not cosmetic. 447 of 971 receipts are not a whole peso and 19 carry sub-centavo
 * fractions, so a balance of ₱132.875 is a real figure a supplier is really carrying.
 * Rounding it to ₱132.88 on screen would show a number that does not exist in the
 * ledger and would make a reconciliation against the DB look wrong. Two decimals
 * minimum so an exact ₱0 still reads as `0.00` rather than a bare `0`.
 */
const PESO = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 4 });
const KG = new Intl.NumberFormat('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 });

/** The number half of an accounting cell. The `₱` is a separate element (see below). */
export function formatPeso(v: number | string | null | undefined): string {
    const n = num(v);
    return n === null ? '' : PESO.format(n);
}

export function formatKg(v: number | string | null | undefined): string {
    const n = num(v);
    return n === null ? '' : KG.format(n);
}

export function formatCount(v: number | string | null | undefined): string {
    const n = num(v);
    return n === null ? '' : String(Math.round(n));
}

/** `yyyy-MM-dd`, or an em dash when the ledger has nothing to show. */
export function formatDate(v: string | null | undefined): string {
    const s = (v ?? '').trim();
    return s ? s.slice(0, 10) : '—';
}

// ─── The sign, in words ─────────────────────────────────────────────────────────

/**
 * `we_owe` — negative, CI owes the trader (the overwhelmingly common case).
 * `they_owe` — positive, the trader owes CI (an advance not yet drawn down).
 * `square` — exactly zero.
 */
export type BalanceDirection = 'we_owe' | 'they_owe' | 'square';

export function balanceDirection(v: number | string | null | undefined): BalanceDirection {
    const n = num(v);
    if (n === null || n === 0) return 'square';
    return n < 0 ? 'we_owe' : 'they_owe';
}

/** The compact tag rendered beside every balance figure. Never a bare minus. */
export function directionLabel(d: BalanceDirection): string {
    switch (d) {
        case 'we_owe':
            return 'we owe';
        case 'they_owe':
            return 'they owe';
        case 'square':
            return 'square';
    }
}

/** The long form, for a title attribute and the supplier panel's headline. */
export function directionSentence(d: BalanceDirection, name: string): string {
    switch (d) {
        case 'we_owe':
            return `We owe ${name}.`;
        case 'they_owe':
            return `${name} owes us — a payment is ahead of the receipts it covers.`;
        case 'square':
            return `${name} is exactly square.`;
    }
}

/**
 * The rule, in one line, printed ON the screen.
 *
 * It is deliberately not a tooltip: a reader who assumes the accounting convention has
 * no reason to hover, and that reader is precisely the one who would read every row
 * backwards.
 */
export const SIGN_NOTE = 'Minus = we owe them. Plus = they owe us.';

// ─── The unpriced warning ───────────────────────────────────────────────────────

/**
 * What a supplier's unpriced receipts are WAITING FOR, named rather than guessed.
 *
 * The balance view partitions `unpriced_receipt_count` exhaustively into three genuinely
 * different operational stages, so the screen can say which one it is. Empty string when
 * there is nothing to report — the caller renders a plain dash, never a "0 unpriced"
 * badge, because an absence of a problem is not news.
 *
 * The wording is PENDING, never BROKEN. "Priced but not yet weighed" is the normal state
 * of a receipt entered in the app this morning, and it is exactly what the in-app INSERT
 * path creates; calling it an error would teach operators to ignore the column.
 */
export function unpricedPhrase(row: {
    unpriced_receipt_count?: number | string | null;
    unpriced_awaiting_weight_count?: number | string | null;
    unpriced_awaiting_price_count?: number | string | null;
    unpriced_awaiting_both_count?: number | string | null;
}): string {
    const total = num(row.unpriced_receipt_count) ?? 0;
    if (total <= 0) return '';

    const weight = num(row.unpriced_awaiting_weight_count) ?? 0;
    const price = num(row.unpriced_awaiting_price_count) ?? 0;
    const both = num(row.unpriced_awaiting_both_count) ?? 0;

    const noun = total === 1 ? 'receipt' : 'receipts';
    const parts: string[] = [];
    if (weight > 0) parts.push(`${weight} awaiting weight`);
    if (price > 0) parts.push(`${price} awaiting a price`);
    if (both > 0) parts.push(`${both} awaiting both`);

    // The three counts partition the total exactly, so a fallback is unreachable in
    // practice — but a defensive read of a partially-populated row must still say
    // something true rather than render an empty warning.
    if (parts.length === 0) return `${total} ${noun} not yet priced`;
    return `${total} ${noun} not yet priced — ${parts.join(', ')}`;
}

/** The short form for the dense cell; the phrase above rides on its `title`. */
export function unpricedShort(count: number | string | null | undefined): string {
    const n = num(count) ?? 0;
    if (n <= 0) return '';
    return `${n} not yet priced`;
}

/**
 * The one sentence the no-payee row says about itself.
 *
 * `rc_payment.supplier_code` is NOT NULL by design, so no cheque can ever point at these
 * receipts. The view emits them as a synthetic row rather than excluding them, because
 * an exclusion is something a UI can forget to render and a row is not.
 */
export const UNASSIGNED_NOTE = 'No payee — cannot be liquidated';

/** The long form, for the row's `title`. The short one above has to survive a 224px cell. */
export const UNASSIGNED_TITLE =
    'These receipts name no payee, so no cheque can ever be written against them. They cannot be liquidated until a trader is set on the receipt itself.';

// ═══ The balance table's column geometry ════════════════════════════════════════
//
// Explicit pixel widths, and their SUM is the table's min-width: the wrapper scrolls
// horizontally rather than letting a column crush ("never crush, always scroll"). There
// is no `1fr`, no `w-auto` and no unset column to absorb slack — that column is always
// the one that silently crushes.

export interface BalanceCol {
    key: string;
    label: string;
    width: number;
    title?: string;
    /** Right-aligned + `font-mono tabular-nums`. */
    numeric?: boolean;
    /** Part of the frozen left block (the trader name). */
    frozen?: boolean;
}

export const BALANCE_COLS: BalanceCol[] = [
    { key: 'trader', label: 'TRADER', width: 224, frozen: true, title: 'Cheque payee. A parent trader lists its sub-suppliers underneath.' },
    { key: 'balance', label: 'BALANCE', width: 168, numeric: true, title: 'payments − priceable receipts. Minus = we owe them; plus = they owe us.' },
    { key: 'direction', label: '', width: 84, title: 'Which way the balance points, in words.' },
    { key: 'receipts', label: 'RECEIPTS', width: 156, numeric: true, title: 'What CI owes for this trader’s PRICEABLE receipts, all time.' },
    { key: 'paid', label: 'PAID', width: 148, numeric: true, title: 'Payments out, less money that came back, plus any write-off.' },
    { key: 'count', label: 'RCPTS', width: 62, numeric: true, title: 'Receipt count, all time.' },
    { key: 'unpriced', label: 'NOT YET PRICED', width: 172, title: 'Receipts this balance could not price. The balance is silent about them — this column is not.' },
    { key: 'last_receipt', label: 'LAST RECEIPT', width: 108, title: 'Most recent delivery date.' },
    { key: 'last_payment', label: 'LAST PAYMENT', width: 110, title: 'Most recent payment date.' },
];

export function minBalanceTableWidth(): number {
    return BALANCE_COLS.reduce((sum, c) => sum + c.width, 0);
}

// ═══ The render tree — a JOIN, never a SUM ══════════════════════════════════════
//
// CLAUDE.md: "Never calculate weighted averages or inventory balances in TypeScript."
// Nothing below adds a single number. `view_rc_supplier_group_balance` already rolled
// the members up in SQL, on top of the per-supplier view, so the two can never disagree;
// this only decides which row is drawn where.

export interface BalanceGroup {
    /** `group_code`, or `null` on the synthetic no-payee row. */
    key: string;
    /** The group total, straight from the SQL rollup. */
    group: SupplierGroupBalanceRow;
    /** Every member, already ordered. One entry for a root trader. */
    members: SupplierBalanceRow[];
    /**
     * TRUE when the group has more than one member and therefore needs a parent row
     * ABOVE its indented children. A root trader is its own group of one, and drawing a
     * header plus one identical child for it would be pure noise.
     */
    nested: boolean;
    /** The no-payee bucket, rendered last and never as a trader. */
    unassigned: boolean;
}

/**
 * Stitch the two views into render order: groups by `group_sort_order` then name, each
 * group's members by their own `sort_order` then code, and the no-payee bucket last
 * whatever it sorts as.
 *
 * A member with no matching group row cannot happen (the group view is a GROUP BY over
 * the member view) but is kept rather than dropped if it ever does — losing a trader's
 * balance silently is the one failure this screen must not have.
 */
export function buildBalanceTree(
    suppliers: SupplierBalanceRow[],
    groups: SupplierGroupBalanceRow[],
): BalanceGroup[] {
    const members = new Map<string, SupplierBalanceRow[]>();
    for (const s of suppliers) {
        const key = s.is_unassigned ? UNASSIGNED_KEY : (s.group_code ?? UNASSIGNED_KEY);
        const list = members.get(key);
        if (list) list.push(s);
        else members.set(key, [s]);
    }

    const out: BalanceGroup[] = [];
    for (const g of groups) {
        const unassigned = g.is_unassigned === true;
        const key = unassigned ? UNASSIGNED_KEY : (g.group_code ?? UNASSIGNED_KEY);
        const list = (members.get(key) ?? []).slice().sort(compareMember);
        members.delete(key);
        out.push({ key, group: g, members: list, nested: !unassigned && list.length > 1, unassigned });
    }

    // Orphans (defensive — see the doc comment). Rendered as their own single-row group
    // so the figure still reaches the screen.
    for (const [key, list] of members) {
        for (const m of list.sort(compareMember)) {
            out.push({ key: `${key}:${m.supplier_code ?? ''}`, group: asGroup(m), members: [m], nested: false, unassigned: m.is_unassigned === true });
        }
    }

    return out.sort(compareGroup);
}

/** The synthetic bucket's key. Its `group_code` is NULL, which is not a Map key. */
export const UNASSIGNED_KEY = '__unassigned__';

function compareMember(a: SupplierBalanceRow, b: SupplierBalanceRow): number {
    const sa = num(a.sort_order) ?? 0;
    const sb = num(b.sort_order) ?? 0;
    if (sa !== sb) return sa - sb;
    return (a.supplier_code ?? '').localeCompare(b.supplier_code ?? '');
}

function compareGroup(a: BalanceGroup, b: BalanceGroup): number {
    // The no-payee bucket always sinks to the bottom. It is not a trader and must never
    // be read as one, and the end of the list is where a reader expects the exceptions.
    if (a.unassigned !== b.unassigned) return a.unassigned ? 1 : -1;
    const sa = num(a.group.group_sort_order) ?? 0;
    const sb = num(b.group.group_sort_order) ?? 0;
    if (sa !== sb) return sa - sb;
    return (a.group.group_display_name ?? '').localeCompare(b.group.group_display_name ?? '');
}

/** Present an orphaned member row in the group view's shape. Defensive only. */
function asGroup(m: SupplierBalanceRow): SupplierGroupBalanceRow {
    return {
        adjustment_count: m.adjustment_count,
        adjustment_php: m.adjustment_php,
        any_active: m.active,
        cash_in_php: m.cash_in_php,
        cash_net_php: m.cash_net_php,
        cash_out_php: m.cash_out_php,
        child_count: 0,
        first_payment_date: m.first_payment_date,
        first_receipt_date: m.first_receipt_date,
        group_code: m.group_code,
        group_display_name: m.group_display_name ?? m.display_name,
        group_sort_order: m.group_sort_order,
        is_unassigned: m.is_unassigned,
        last_payment_date: m.last_payment_date,
        last_receipt_date: m.last_receipt_date,
        payment_count: m.payment_count,
        payments_php: m.payments_php,
        receipt_count: m.receipt_count,
        receipts_php: m.receipts_php,
        running_balance_php: m.running_balance_php,
        supplier_codes: m.supplier_code ? [m.supplier_code] : null,
        supplier_count: 1,
        unpriced_awaiting_both_count: m.unpriced_awaiting_both_count,
        unpriced_awaiting_price_count: m.unpriced_awaiting_price_count,
        unpriced_awaiting_weight_count: m.unpriced_awaiting_weight_count,
        unpriced_receipt_count: m.unpriced_receipt_count,
        unpriced_receipt_kg: m.unpriced_receipt_kg,
    };
}

// ═══ Payments — the vocabulary the DB enforces ══════════════════════════════════
//
// Every list below MIRRORS a CHECK constraint. It is not the enforcement (the DB is),
// but keeping the two in step is what makes a refusal rare — and when the DB does refuse
// anyway, its message is shown VERBATIM rather than re-worded, because it was written
// for a toast.

export type PaymentMethod = 'cheque' | 'bank_transfer' | 'adjustment';
export type PaymentDirection = 'outgoing' | 'incoming';
export type StatedTerm = 'downpayment' | 'full' | 'straight' | 'cash_advance';

export interface MethodOption {
    value: PaymentMethod;
    label: string;
    /** One line under the picker — what choosing this actually means. */
    hint: string;
}

/**
 * There is NO `cash` (decision 2). `adjustment` is present but is described as what it
 * is — a write-off where no money moved — rather than offered as a normal way to pay.
 */
export const METHOD_OPTIONS: readonly MethodOption[] = [
    { value: 'cheque', label: 'Cheque', hint: 'Needs a cheque number and the account it was drawn on.' },
    { value: 'bank_transfer', label: 'Bank transfer', hint: 'Record the transfer reference. No cheque number.' },
    {
        value: 'adjustment',
        label: 'Adjustment (write-off — no cash moved)',
        hint: 'Forgives a remainder. Nothing leaves the bank; the balance moves anyway. Say why in the remarks.',
    },
];

export const TERM_OPTIONS: readonly { value: StatedTerm; label: string }[] = [
    { value: 'downpayment', label: 'Downpayment' },
    { value: 'full', label: 'Full payment' },
    { value: 'straight', label: 'Straight' },
    { value: 'cash_advance', label: 'Cash advance' },
];

export function methodLabel(v: string | null | undefined): string {
    return METHOD_OPTIONS.find((m) => m.value === v)?.label ?? (v ?? '—');
}

/** Short form for a dense table cell — the long form is on the picker, not the row. */
export function methodShort(v: string | null | undefined): string {
    switch (v) {
        case 'cheque':
            return 'Cheque';
        case 'bank_transfer':
            return 'Transfer';
        case 'adjustment':
            return 'Adjustment';
        default:
            return v ?? '—';
    }
}

export function termLabel(v: string | null | undefined): string {
    return TERM_OPTIONS.find((t) => t.value === v)?.label ?? '';
}

/** A cheque REQUIRES a number and an account; anything else must carry neither. */
export function isCheque(method: string | null | undefined): boolean {
    return method === 'cheque';
}

// ─── The payment form's shape ───────────────────────────────────────────────────

/**
 * What the form holds, all as text. Kept as strings rather than parsed values so a
 * half-typed amount is never silently coerced to a number the operator did not mean, and
 * so an untouched field round-trips byte-for-byte.
 */
export interface PaymentFormState {
    supplier_code: string;
    payment_date: string;
    method: PaymentMethod;
    amount_php: string;
    direction: PaymentDirection;
    stated_term: '' | StatedTerm;
    bank_account_id: string;
    cheque_no: string;
    cheque_date: string;
    reference_no: string;
    remarks: string;
}

export function emptyPaymentForm(supplierCode: string, today: string): PaymentFormState {
    return {
        supplier_code: supplierCode,
        payment_date: today,
        method: 'cheque',
        amount_php: '',
        direction: 'outgoing',
        stated_term: '',
        bank_account_id: '',
        cheque_no: '',
        cheque_date: '',
        reference_no: '',
        remarks: '',
    };
}

export function paymentFormFrom(row: PaymentRow): PaymentFormState {
    const method = (row.method ?? 'cheque') as PaymentMethod;
    const amount = num(row.amount_php);
    return {
        supplier_code: row.supplier_code ?? '',
        payment_date: (row.payment_date ?? '').slice(0, 10),
        method,
        // The stored value, not a re-formatting of it: `1027132.875` must round-trip.
        amount_php: amount === null ? '' : String(amount),
        direction: (row.direction ?? 'outgoing') as PaymentDirection,
        stated_term: (row.stated_term ?? '') as '' | StatedTerm,
        bank_account_id: row.bank_account_id ?? '',
        cheque_no: row.cheque_no ?? '',
        cheque_date: (row.cheque_date ?? '').slice(0, 10),
        reference_no: row.reference_no ?? '',
        remarks: row.remarks ?? '',
    };
}

/** `yyyy-MM-dd` AND a day that exists — a shape test alone waves `2026-02-30` through. */
export function isIsoDate(text: string): boolean {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
    if (!m) return false;
    const y = Number(m[1]);
    const mo = Number(m[2]);
    const d = Number(m[3]);
    // UTC so a timezone offset can never roll the round trip onto the neighbouring day.
    const dt = new Date(Date.UTC(y, mo - 1, d));
    return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
}

/**
 * The client-side pre-flight. It exists to make a DB refusal RARE, never to replace it:
 * every rule below is also a CHECK constraint or an RPC guard, and when the database
 * refuses anyway its own message is what the operator sees.
 *
 * Returns a map of field → complaint. Empty means "worth sending".
 */
export function validatePaymentForm(form: PaymentFormState): Partial<Record<keyof PaymentFormState, string>> {
    const errors: Partial<Record<keyof PaymentFormState, string>> = {};

    if (!form.supplier_code.trim()) {
        errors.supplier_code = 'Name the trader this was paid to — the balance is per supplier.';
    }

    if (!isIsoDate(form.payment_date)) {
        errors.payment_date = 'The day the money was released, as yyyy-mm-dd.';
    }

    const amount = num(form.amount_php.trim());
    if (form.amount_php.trim() === '') {
        errors.amount_php = 'How much?';
    } else if (amount === null) {
        errors.amount_php = 'That is not a number.';
    } else if (amount <= 0) {
        // The form never OFFERS a negative — this catches a typed one and explains the
        // model rather than silently flipping the sign.
        errors.amount_php = 'Always positive. Money coming back is recorded by setting the direction to incoming.';
    }

    // A write-off is an explicit act of forgiveness, and §4.5 specified a REQUIRED
    // remark on it. This one rule is enforced HERE ONLY — the DB has no such CHECK, and
    // that asymmetry is deliberate rather than an oversight: the reason for forgiving
    // ₱132.875 is a human fact the database cannot verify, so refusing it in SQL would
    // only teach people to type a full stop. Refusing it in the form, where the person
    // who knows the reason is standing, is where the rule is actually worth something.
    if (form.method === 'adjustment' && !form.remarks.trim()) {
        errors.remarks = 'A write-off needs a reason — nothing left the bank, so this remark is the only record of why the balance moved.';
    }

    if (isCheque(form.method)) {
        if (!form.cheque_no.trim()) {
            errors.cheque_no = 'A cheque needs its number — it is half of how the cheque is identified.';
        }
        if (!form.bank_account_id.trim()) {
            errors.bank_account_id = 'A cheque needs the account it was drawn on. Numbers are unique per account, not globally.';
        }
        if (form.cheque_date.trim() && !isIsoDate(form.cheque_date)) {
            errors.cheque_date = 'Not a date. Leave it blank if the cheque is not post-dated.';
        }
    } else {
        if (form.cheque_no.trim()) {
            errors.cheque_no = `A ${methodShort(form.method).toLowerCase()} carries no cheque number.`;
        }
        if (form.cheque_date.trim()) {
            errors.cheque_date = `A ${methodShort(form.method).toLowerCase()} carries no cheque date.`;
        }
    }

    return errors;
}

/**
 * The patch the RPC gets. Keys are exactly the allowlist in
 * `public.cenapro_save_rc_payment` — an unknown key refuses the WHOLE call, so this
 * builds the payload rather than spreading the form.
 *
 * Blank text becomes `null`, not `''`: a cheque number of `''` would trip the shape
 * CHECK on a transfer, and an empty `stated_term` is "no intent recorded", not a term.
 */
export type RpcPatch = Record<string, string | number | boolean | null>;
export type PaymentPatch = RpcPatch;

export function paymentPatchFrom(form: PaymentFormState): PaymentPatch {
    const cheque = isCheque(form.method);
    return {
        supplier_code: form.supplier_code.trim(),
        payment_date: form.payment_date.trim(),
        method: form.method,
        amount_php: num(form.amount_php.trim()) ?? 0,
        direction: form.direction,
        stated_term: form.stated_term ? form.stated_term : null,
        // A non-cheque MAY still name the account it left (a transfer usually does), but
        // a cheque must; both cases are just "send it when it is set".
        bank_account_id: form.bank_account_id.trim() || null,
        cheque_no: cheque ? form.cheque_no.trim() || null : null,
        cheque_date: cheque ? form.cheque_date.trim() || null : null,
        reference_no: form.reference_no.trim() || null,
        remarks: form.remarks.trim() || null,
    };
}

// ═══ Banks and accounts — the cheque book's home ════════════════════════════════
//
// A cheque number is unique only per ACCOUNT (two banks will happily issue #001234), so
// an account is not a label on a payment — it is half a cheque's identity, and it is what
// makes a future skipped-number check per cheque book possible at all.
//
// NEITHER IS EVER DELETED. A bank or account is retired with `active = false`, because
// historic payments must keep naming it — and there is deliberately no delete RPC for
// either, so this screen could not offer one even if it wanted to.

export interface BankFormState {
    /** Immutable after creation: re-keying a bank cascades into every account under it. */
    code: string;
    display_name: string;
    sort_order: string;
    active: boolean;
    notes: string;
}

export interface BankAccountFormState {
    bank_code: string;
    account_label: string;
    /** Secondary detail, never front-of-screen (decision 4). Blank is allowed. */
    account_no: string;
    sort_order: string;
    active: boolean;
    notes: string;
}

export function emptyBankForm(): BankFormState {
    return { code: '', display_name: '', sort_order: '0', active: true, notes: '' };
}

export function bankFormFrom(row: BankRow): BankFormState {
    return {
        code: row.code ?? '',
        display_name: row.display_name ?? '',
        sort_order: String(num(row.sort_order) ?? 0),
        active: row.active !== false,
        notes: row.notes ?? '',
    };
}

export function emptyBankAccountForm(bankCode: string): BankAccountFormState {
    return { bank_code: bankCode, account_label: '', account_no: '', sort_order: '0', active: true, notes: '' };
}

export function bankAccountFormFrom(row: BankAccountRow): BankAccountFormState {
    return {
        bank_code: row.bank_code ?? '',
        account_label: row.account_label ?? '',
        account_no: row.account_no ?? '',
        sort_order: String(num(row.sort_order) ?? 0),
        active: row.active !== false,
        notes: row.notes ?? '',
    };
}

/** A whole number for a sort key, or `null` when the text is not one. */
function sortOrderOf(text: string): number | null {
    const t = text.trim();
    if (t === '') return 0;
    const n = Number(t);
    return Number.isInteger(n) ? n : null;
}

export function validateBankForm(
    form: BankFormState,
    isNew: boolean,
): Partial<Record<keyof BankFormState, string>> {
    const errors: Partial<Record<keyof BankFormState, string>> = {};
    if (isNew && !form.code.trim()) {
        errors.code = 'A short code, e.g. BDO. It cannot be changed afterwards.';
    }
    if (!form.display_name.trim()) errors.display_name = 'The bank needs a name.';
    if (sortOrderOf(form.sort_order) === null) errors.sort_order = 'A whole number.';
    return errors;
}

export function validateBankAccountForm(
    form: BankAccountFormState,
): Partial<Record<keyof BankAccountFormState, string>> {
    const errors: Partial<Record<keyof BankAccountFormState, string>> = {};
    if (!form.bank_code.trim()) errors.bank_code = 'Which bank is this account with?';
    if (!form.account_label.trim()) {
        errors.account_label = 'A label, e.g. "current - Cebu". This is what a person picks from.';
    }
    if (sortOrderOf(form.sort_order) === null) errors.sort_order = 'A whole number.';
    return errors;
}

/**
 * The bank patch. `code` is ABSENT — it rides as the RPC's `p_code` on an insert and is
 * not editable at all afterwards, so including it here could only ever be a mistake.
 */
export function bankPatchFrom(form: BankFormState): PaymentPatch {
    return {
        display_name: form.display_name.trim(),
        sort_order: sortOrderOf(form.sort_order) ?? 0,
        notes: form.notes.trim() || null,
    };
}

export function bankAccountPatchFrom(form: BankAccountFormState): PaymentPatch {
    return {
        bank_code: form.bank_code.trim(),
        account_label: form.account_label.trim(),
        // Blank becomes NULL, never '': the partial unique index on (bank_code,
        // account_no) treats NULLs as distinct, so two accounts may legitimately have no
        // number yet — but two empty STRINGS would collide.
        account_no: form.account_no.trim() || null,
        sort_order: sortOrderOf(form.sort_order) ?? 0,
        notes: form.notes.trim() || null,
    };
}

/**
 * `active` is patched on its own by the retire/restore action, and is ALSO part of the
 * edit form. Kept out of the two patch builders above so the dialogs and the one-click
 * retire cannot disagree about who owns the flag — each sends it explicitly.
 */
export function activePatch(active: boolean): RpcPatch {
    // A real JSON boolean. `jsonb_populate_record` casts the patch into the row type, and
    // a numeric 1 into a boolean column is a hard error, not a truthy coercion.
    return { active };
}

/** Banks + their accounts, in render order. A JOIN, exactly like `buildBalanceTree`. */
export interface BankGroup {
    bank: BankRow;
    accounts: BankAccountRow[];
}

export function buildBankTree(banks: BankRow[], accounts: BankAccountRow[]): BankGroup[] {
    const byBank = new Map<string, BankAccountRow[]>();
    for (const a of accounts) {
        const key = a.bank_code ?? '';
        const list = byBank.get(key);
        if (list) list.push(a);
        else byBank.set(key, [a]);
    }
    return [...banks]
        .sort((a, b) => {
            const sa = num(a.sort_order) ?? 0;
            const sb = num(b.sort_order) ?? 0;
            if (sa !== sb) return sa - sb;
            return (a.code ?? '').localeCompare(b.code ?? '');
        })
        .map((bank) => ({
            bank,
            accounts: (byBank.get(bank.code ?? '') ?? []).slice().sort((a, b) => {
                const sa = num(a.sort_order) ?? 0;
                const sb = num(b.sort_order) ?? 0;
                if (sa !== sb) return sa - sb;
                return (a.account_label ?? '').localeCompare(b.account_label ?? '');
            }),
        }));
}

export interface BankCol {
    key: string;
    label: string;
    width: number;
    title?: string;
    numeric?: boolean;
}

export const BANK_COLS: BankCol[] = [
    { key: 'name', label: 'BANK / ACCOUNT', width: 268, title: 'Bank name reads first; an account sits underneath it.' },
    { key: 'account_no', label: 'ACCOUNT NO.', width: 172, title: 'Secondary detail — a cheque is identified by its account and number together.' },
    { key: 'status', label: 'STATUS', width: 104, title: 'Retired records stay forever so historic payments keep naming them.' },
    { key: 'sort', label: 'ORDER', width: 68, numeric: true, title: 'Where it sits in the pickers.' },
    { key: 'notes', label: 'NOTES', width: 232 },
    { key: 'actions', label: '', width: 208 },
];

export function minBankTableWidth(): number {
    return BANK_COLS.reduce((sum, c) => sum + c.width, 0);
}

// ─── The RPC vocabulary, shared by every liquidation write ──────────────────────

/**
 * The outcome language every `cenapro_*` RPC speaks, plus the two the SERVER-ACTION
 * layer adds: `forbidden` (the ₱ gate refused before the DB was ever asked) and
 * `rpc_error` (the call itself failed).
 */
export type LiquidationOutcome =
    | 'inserted'
    | 'updated'
    | 'deleted'
    | 'restored'
    | 'version_conflict'
    | 'not_found'
    | 'unsupported_field'
    | 'invalid'
    | 'forbidden'
    | 'rpc_error';

export const LIQUIDATION_OUTCOMES: readonly LiquidationOutcome[] = [
    'inserted', 'updated', 'deleted', 'restored', 'version_conflict',
    'not_found', 'unsupported_field', 'invalid', 'forbidden', 'rpc_error',
];

export interface LiquidationResult {
    ok: boolean;
    outcome: LiquidationOutcome;
    /**
     * The DB's own words. Every refusal from these RPCs carries a human-readable
     * `message` written for a toast — it is SHOWN, never re-worded, because the database
     * knows precisely which of a dozen rules was broken and the UI is guessing.
     */
    message: string | null;
    id: string | null;
    code: string | null;
    rowVersion: number | null;
}

/** The single sentence shown when a role may not see money at all. */
export const PRICE_GATE_NOTE =
    'Liquidation is the money side of the receipt ledger, so this screen is not available for your role.';
