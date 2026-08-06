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
/**
 * The CURRENT stated opening balance of one trader — the latest revision. A trader that
 * has never had one is simply ABSENT from this view, so `has_opening_balance` on the
 * balance row is what tells "stated ₱0" from "never stated", never the amount.
 */
export type SupplierOpeningBalanceRow =
    Database['public']['Views']['cenapro_rc_supplier_opening_balances']['Row'];
/**
 * ONE revision out of the append-only history, with `is_current` marking the one in
 * force. The table holds no UPDATE or DELETE grant and no UPDATE or DELETE policy, so
 * nothing here can ever be rewritten — a correction is a NEW revision.
 */
export type OpeningBalanceRevisionRow =
    Database['public']['Views']['cenapro_rc_supplier_opening_balance_history']['Row'];

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

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * `3 Aug 2026` — for PROSE ONLY, never for a table cell.
 *
 * Every cell in this module is `yyyy-MM-dd` per CLAUDE.md and stays that way. The one
 * place that rule is deliberately relaxed is the opening-balance dialog's echo-back
 * sentence, whose whole job is to be RE-READ before a figure is committed: `2026-08-03`
 * buried mid-sentence is exactly the token an eye skates over, and the sentence exists to
 * stop precisely that.
 *
 * Built by string arithmetic rather than `new Date(iso)` on purpose — that constructor
 * parses a bare `yyyy-MM-dd` as UTC midnight, so `format()` west of Greenwich renders the
 * PREVIOUS day. There is no Date object here and therefore no timezone to get wrong.
 */
export function formatLongDate(v: string | null | undefined): string {
    const s = (v ?? '').trim();
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
    if (!m) return s;
    const month = MONTHS[Number(m[2]) - 1];
    return month ? `${Number(m[3])} ${month} ${m[1]}` : s;
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

// ═══ THE OPENING BALANCE ════════════════════════════════════════════════════════
//
// Renzo, 2026-08-06: "Since it's a bit impossible to check all of the past history, we
// should be able to modify the starting balances of the suppliers we have listed."
//
// The balance screen shipped saying CI owes BRIX ₱212,669,462.50 — the ENTIRE year's
// purchases — because no historic cheque was ever entered and back-entering seven months
// of them is not realistic. An opening balance is how that number becomes true: state
// what was actually outstanding as of a date, and count forward from there.
//
// ── THE AS-OF RULE. Stated once; nothing in this module may contradict it ────────
// THE OPENING BALANCE STANDS FOR EVERYTHING STRICTLY BEFORE `as_of_date`. RECEIPTS AND
// PAYMENTS DATED ON OR AFTER IT COUNT FRESH ON TOP OF IT. So a receipt dated exactly on
// the cutoff counts FRESH — the boundary is `>=`, never `>`. That is the natural reading
// of "as of 1 August the balance was X": a figure quoted on the morning of the 1st cannot
// have paid for the truck that arrived that day.
//
// ── THE SIGN IS THE SINGLE EASIEST THING HERE TO GET BACKWARDS ───────────────────
// Stored values are SIGNED like `running_balance_php`: negative = we owe them. A wrong
// sign does not produce a visibly silly number — it DOUBLES the balance instead of
// zeroing it, and ₱425M looks no more obviously wrong than ₱212M to anyone who is not
// already suspicious.
//
// So the operator is NEVER asked to type a minus sign. They type a POSITIVE figure and
// pick a side in words ("we owe them" / "they owe us"); `openingSignedAmount` is the ONE
// place the conversion happens, and `openingSentence` reads the result back as a sentence
// before it is committed. Both live here so no screen can grow its own version.
//
// ── APPEND-ONLY: "MODIFY" MEANS APPEND ──────────────────────────────────────────
// `cenapro.rc_supplier_opening_balance` holds NO update and NO delete grant, and no
// update/delete policy under RLS. Saving ADDS a revision; the superseded figure stays
// readable forever. There is therefore no edit-in-place and no delete affordance anywhere
// in this module — building one would fail with a permission error, and would be the
// wrong thing to build regardless: a money history that can be silently rewritten is
// worth nothing.

/**
 * Which way a STATED opening balance points, in the operator's words.
 *
 * There is no `square` member on purpose: zero is entered as an AMOUNT of zero, and at
 * zero the side is genuinely moot. Making "square" a third radio option would invite the
 * question "square in which direction?", which has no answer.
 */
export type OpeningSide = 'we_owe' | 'they_owe';

export interface OpeningBalanceFormState {
    as_of_date: string;
    /**
     * ALWAYS POSITIVE, exactly as typed. The sign lives in `side` and nowhere else — see
     * the header. Kept as a string so a half-typed figure is never coerced to a number
     * the operator did not mean.
     */
    amount_php: string;
    side: OpeningSide;
    /** Where the figure came from. Not required by the DB; this module asks for it. */
    note: string;
}

export function emptyOpeningBalanceForm(today: string): OpeningBalanceFormState {
    return {
        as_of_date: today,
        amount_php: '',
        // `we_owe` is the overwhelmingly common case — all 12 traders are owed money
        // today — so it is the default. It is still an explicit, visible choice.
        side: 'we_owe',
        note: '',
    };
}

/**
 * Pre-fill from the CURRENT revision, so revising a figure starts from the figure.
 *
 * The stored amount is signed; the form is unsigned + a side. `Math.abs` is the whole
 * conversion, and it is exactly the inverse of `openingSignedAmount`.
 *
 * The NOTE is deliberately NOT carried over. A note says where THIS figure came from
 * ("supplier statement 2026-07-31"), so silently reusing it would attribute the new
 * number to a source that never mentioned it — the one thing a provenance field must
 * never do. The old note stays visible in the history right beside the form.
 */
export function openingFormFrom(row: {
    opening_as_of_date?: string | null;
    opening_balance_php?: number | string | null;
}, today: string): OpeningBalanceFormState {
    const signed = num(row.opening_balance_php);
    const date = (row.opening_as_of_date ?? '').slice(0, 10);
    return {
        as_of_date: date || today,
        amount_php: signed === null || signed === 0 ? '' : String(Math.abs(signed)),
        side: signed !== null && signed > 0 ? 'they_owe' : 'we_owe',
        note: '',
    };
}

/**
 * How many decimal places the typed figure really carries, trailing zeros ignored — the
 * same thing `scale(trim_scale(v))` measures in the database, which refuses more than 2.
 *
 * Text-first because that is what the operator typed: `4200000.00` carries ZERO
 * significant decimals and must not be refused. The parsed fallback only catches
 * exponent notation, which a `type="number"` input will happily hand back.
 */
export function decimalPlaces(text: string): number {
    const t = text.trim();
    const m = /^[+-]?\d*(?:\.(\d*))?$/.exec(t);
    if (m) return (m[1] ?? '').replace(/0+$/, '').length;
    const n = Number(t);
    if (!Number.isFinite(n)) return 0;
    const s = String(n);
    const dot = s.indexOf('.');
    return dot < 0 ? 0 : s.length - dot - 1;
}

/**
 * THE ONE PLACE THE SIGN IS APPLIED. A positive amount plus a side becomes the signed
 * figure the database stores. `null` means "not ready to send".
 *
 * Zero returns a plain `0`, never `-0`: they are the same number to `numeric` but not to
 * every renderer, and "−0.00" on a screen would be a small lie about a figure whose whole
 * point is that it is exact.
 */
export function openingSignedAmount(form: OpeningBalanceFormState): number | null {
    const n = num(form.amount_php.trim());
    if (n === null || n < 0) return null;
    if (n === 0) return 0;
    return form.side === 'we_owe' ? -n : n;
}

/**
 * The result, read back IN WORDS before it is committed.
 *
 * This is the guard on the one mistake that cannot be seen in the number afterwards: a
 * side chosen wrongly doubles the balance instead of zeroing it. A person will catch "we
 * owe BRIX" when they meant the opposite; nobody catches a minus sign.
 *
 * Empty string when the form is not yet sayable — the caller renders nothing rather than
 * a half-formed sentence.
 */
export function openingSentence(form: OpeningBalanceFormState, name: string): string {
    const n = num(form.amount_php.trim());
    if (n === null || n < 0 || !isIsoDate(form.as_of_date.trim())) return '';
    const trader = name.trim() || 'this trader';
    const when = formatLongDate(form.as_of_date);
    if (n === 0) {
        return `Saving: ${trader} is square as of ${when} — nothing outstanding either way.`;
    }
    const money = `₱${formatPeso(n)}`;
    return form.side === 'we_owe'
        ? `Saving: we owe ${trader} ${money} as of ${when}.`
        : `Saving: ${trader} owes us ${money} as of ${when}.`;
}

/** The as-of rule, in one plain line, printed ON the form beside the date. */
export const AS_OF_NOTE =
    'Everything before this date is assumed settled at the amount below. Receipts and payments on or after it count fresh.';

/** Said out loud on the form, because append-only is reassuring only if you know about it. */
export const APPEND_ONLY_NOTE =
    'Saving adds a revision — the figure below is kept, not replaced. Nothing in this history can be edited or deleted.';

export function validateOpeningBalanceForm(
    form: OpeningBalanceFormState,
    today: string,
): Partial<Record<keyof OpeningBalanceFormState, string>> {
    const errors: Partial<Record<keyof OpeningBalanceFormState, string>> = {};

    const date = form.as_of_date.trim();
    if (!isIsoDate(date)) {
        errors.as_of_date = 'The date this figure is stated as of, as yyyy-mm-dd.';
    } else if (isIsoDate(today) && date > today) {
        // String comparison is exact for `yyyy-MM-dd`. The DB refuses this too, measured
        // in Asia/Manila; this only makes the refusal rare.
        errors.as_of_date = `An opening balance is a statement about what was already outstanding, so it cannot be dated after today (${today}).`;
    }

    const raw = form.amount_php.trim();
    const amount = num(raw);
    if (raw === '') {
        errors.amount_php = 'How much was outstanding? Enter 0 if this trader is square as of that date — zero is a real answer, not a blank.';
    } else if (amount === null) {
        errors.amount_php = 'That is not a number.';
    } else if (amount < 0) {
        // THE trap. Silently flipping the sign here would be worse than refusing: it
        // would teach the operator that the minus is what carries the direction, and the
        // next figure they type without one would land on the wrong side.
        errors.amount_php =
            'Enter the amount as a positive figure and choose which way it points below. A minus sign here would double the balance instead of settling it.';
    } else if (decimalPlaces(raw) > 2) {
        errors.amount_php =
            'At most two decimal places — this is the one figure a person states by hand, so round it to centavos. (Individual receipts do price out to fractions of a centavo, and there is nothing wrong with those.)';
    }

    return errors;
}

/** The patch-free RPC argument set, built in one place so no caller re-derives the sign. */
export interface SetOpeningBalanceArgs {
    supplierCode: string;
    asOfDate: string;
    /** SIGNED. Negative = we owe them. Produced only by `openingSignedAmount`. */
    openingBalancePhp: number;
    note: string | null;
}

export function openingArgsFrom(
    supplierCode: string,
    form: OpeningBalanceFormState,
): SetOpeningBalanceArgs | null {
    const signed = openingSignedAmount(form);
    if (signed === null) return null;
    return {
        supplierCode,
        asOfDate: form.as_of_date.trim(),
        openingBalancePhp: signed,
        note: form.note.trim() || null,
    };
}

// ─── What an opening balance STANDS IN FOR ──────────────────────────────────────

/**
 * The defensibility pair, in words.
 *
 * `carried_receipt_count` / `carried_receipt_php` are what make a stated figure checkable
 * six months later: "this ₱4.2M stands in for 275 receipts worth ₱207,917,771.25." Without
 * them the opening balance is an unauditable assertion, and the row would look derived
 * from all 971 receipts while differing from that reading by ₱200M.
 *
 * The payments half is included because it is the symmetric term — without it the gap
 * between the full history and the windowed figure is explained on one side only. The
 * full-history balance closes the loop: it is exactly what this row read before any
 * opening balance existed.
 */
export function carriedTitle(
    row: {
        opening_as_of_date?: string | null;
        carried_receipt_count?: number | string | null;
        carried_receipt_php?: number | string | null;
        carried_payment_count?: number | string | null;
        carried_payment_php?: number | string | null;
        running_balance_all_php?: number | string | null;
    },
    name: string,
): string {
    const date = formatDate(row.opening_as_of_date);
    const rc = num(row.carried_receipt_count) ?? 0;
    const rp = num(row.carried_receipt_php) ?? 0;
    const pc = num(row.carried_payment_count) ?? 0;
    const pp = num(row.carried_payment_php) ?? 0;

    const receipts = `${rc} ${rc === 1 ? 'receipt' : 'receipts'} worth ₱${formatPeso(rp)}`;
    const payments = `${pc} ${pc === 1 ? 'payment' : 'payments'} worth ₱${formatPeso(pp)}`;

    return (
        `The stated opening balance stands in for ${receipts} and ${payments}, all dated before ${date}. ` +
        `Read back without it, the raw history for ${name.trim() || 'this trader'} is ₱${formatPeso(
            row.running_balance_all_php,
        )}.`
    );
}

/** The short cell form: the count. The pesos go on the line beneath it. */
export function carriedCountLabel(count: number | string | null | undefined): string {
    const n = num(count) ?? 0;
    return `${n} ${n === 1 ? 'receipt' : 'receipts'}`;
}

// ─── A GROUP's as-of date: never a date that is only true for some members ───────

/**
 * A group's members may legitimately be stated as of DIFFERENT dates, so there is often
 * no single group as-of date at all — and printing one anyway would be a plain falsehood
 * about the members it does not cover.
 *
 * The SQL rollup exposes the honest three (`opening_as_of_date`, which is NULL unless the
 * members agree, plus `_min` / `_max`), and this reads them into the four cases a screen
 * can actually render. Note that `opening_as_of_date` being non-null means "every member
 * THAT HAS ONE agrees" — `min`/`max` ignore NULLs — so `partial` exists to keep a
 * one-of-three agreement from masquerading as a group-wide fact.
 */
export type GroupAsOf =
    | { kind: 'none' }
    | { kind: 'all'; date: string }
    | { kind: 'partial'; date: string; stated: number; total: number }
    | { kind: 'range'; min: string; max: string; stated: number; total: number };

export function groupAsOf(row: {
    opening_as_of_date?: string | null;
    opening_as_of_date_min?: string | null;
    opening_as_of_date_max?: string | null;
    opening_supplier_count?: number | string | null;
    supplier_count?: number | string | null;
}): GroupAsOf {
    const stated = num(row.opening_supplier_count) ?? 0;
    const total = num(row.supplier_count) ?? 0;
    if (stated <= 0) return { kind: 'none' };

    const agreed = (row.opening_as_of_date ?? '').slice(0, 10);
    if (agreed) {
        return stated >= total
            ? { kind: 'all', date: agreed }
            : { kind: 'partial', date: agreed, stated, total };
    }

    return {
        kind: 'range',
        min: (row.opening_as_of_date_min ?? '').slice(0, 10),
        max: (row.opening_as_of_date_max ?? '').slice(0, 10),
        stated,
        total,
    };
}

/** The compact cell text for each case. Never a bare date unless it covers every member. */
export function groupAsOfLabel(a: GroupAsOf): string {
    switch (a.kind) {
        case 'none':
            return '';
        case 'all':
            return `as of ${a.date}`;
        case 'partial':
            return `as of ${a.date} · ${a.stated} of ${a.total}`;
        case 'range':
            return `${a.min} → ${a.max}`;
    }
}

/** The long form, for the cell's `title`. Says WHY there is no single date when there isn't. */
export function groupAsOfTitle(a: GroupAsOf): string {
    switch (a.kind) {
        case 'none':
            return 'No trader in this group has a stated opening balance, so every figure on this row covers the whole history.';
        case 'all':
            return `Every trader in this group is stated as of ${a.date}, so the group total covers everything from that date onward.`;
        case 'partial':
            return `${a.stated} of the ${a.total} traders in this group have a stated opening balance, all of them as of ${a.date}. The other ${
                a.total - a.stated
            } still count their whole history, so this date is not true of the group as a whole.`;
        case 'range':
            return `The ${a.stated} traders in this group with a stated opening balance do NOT share one as-of date — they run from ${a.min} to ${a.max}. There is deliberately no single group date to print, because it would be untrue of some members.`;
    }
}

// ─── The lens: the stated balance, or the raw history ───────────────────────────

/**
 * Which set of figures the money columns read.
 *
 * `stated` (the default) is the windowed reading — the stated opening balance plus
 * everything dated on or after its as-of date. `all` is `*_all_php`: the full history
 * with NO opening term, i.e. exactly what this screen showed before opening balances
 * existed.
 *
 * BOTH are kept because an opening balance is otherwise UNAUDITABLE — you could never ask
 * "what does the raw history say, and what did my stated figure change?" Shown as a
 * SCREEN-LEVEL SWITCH rather than a second number in every cell: one figure per cell,
 * always, and the question is one click away instead of one more column wide.
 *
 * Neither branch computes anything. Every field named below is a column of the view.
 */
export type BalanceLens = 'stated' | 'all';

export const LENS_NOTE: Record<BalanceLens, string> = {
    stated:
        'Showing each trader’s stated opening balance plus everything dated on or after it. Traders with no opening balance show their whole history.',
    all: 'Showing the RAW HISTORY — every receipt and payment ever recorded, with no opening balance applied. This is what the screen said before starting balances existed.',
};

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
    { key: 'balance', label: 'BALANCE', width: 168, numeric: true, title: 'Opening balance + payments − priceable receipts. Minus = we owe them; plus = they owe us.' },
    { key: 'direction', label: '', width: 84, title: 'Which way the balance points, in words.' },
    { key: 'opening', label: 'OPENING', width: 164, numeric: true, title: 'The stated starting balance, and the date it is stated as of. Everything strictly before that date is assumed settled at this figure.' },
    { key: 'carried', label: 'STANDS IN FOR', width: 164, title: 'How many receipts the opening balance replaces, and what they were worth. This pair is what makes the stated figure checkable later.' },
    { key: 'receipts', label: 'RECEIPTS', width: 156, numeric: true, title: 'What CI owes for this trader’s PRICEABLE receipts dated on or after the opening balance (everything, when there is none).' },
    { key: 'paid', label: 'PAID', width: 148, numeric: true, title: 'Payments out, less money that came back, plus any write-off — over the same window as RECEIPTS.' },
    { key: 'count', label: 'RCPTS', width: 62, numeric: true, title: 'Receipts counted in the figures on this row.' },
    { key: 'unpriced', label: 'NOT YET PRICED', width: 172, title: 'Receipts this balance could not price, over the WHOLE history — never windowed. One dated before the opening balance cannot have been folded into it, because nobody knows what it is worth.' },
    { key: 'last_receipt', label: 'LAST RECEIPT', width: 108, title: 'Most recent delivery date, whole history.' },
    { key: 'last_payment', label: 'LAST PAYMENT', width: 110, title: 'Most recent payment date, whole history.' },
    { key: 'actions', label: '', width: 120, title: 'State or revise this trader’s starting balance.' },
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

/**
 * Present an orphaned member row in the group view's shape. DEFENSIVE ONLY — the group
 * view is a `GROUP BY` over the member view, so a member with no group row cannot happen.
 *
 * Written as "spread the member row, then supply the group-only columns" rather than as a
 * 49-key literal on purpose. The group rollup is `SELECT ... FROM view_rc_supplier_balance`
 * and the two shapes therefore share 42 of their columns by construction; listing them all
 * by hand meant that widening the views (as opening balances just did, 30→53 and 27→49)
 * silently left this path building a row with 22 missing measures. Under the spread, a new
 * shared column flows through automatically and a new group-ONLY column is a compile error
 * right here — which is the correct place to be told.
 *
 * The member-only columns ride along unused rather than being destructured away. TypeScript
 * applies no excess-property check to spread-in keys, so this still typechecks, and it
 * costs 11 harmless extra keys on ONE defensive object instead of 11 throwaway `_name`
 * bindings that this project's ESLint (no `ignoreRestSiblings`) reports as unused.
 */
function asGroup(m: SupplierBalanceRow): SupplierGroupBalanceRow {
    return {
        ...m,
        group_display_name: m.group_display_name ?? m.display_name,
        group_sort_order: m.group_sort_order,
        supplier_count: 1,
        child_count: 0,
        supplier_codes: m.supplier_code ? [m.supplier_code] : null,
        any_active: m.active,
        // A group of one: it has a stated opening exactly when its single member does, and
        // that member's date is trivially the one every member agrees on.
        opening_supplier_count: m.has_opening_balance ? 1 : 0,
        opening_as_of_date_min: m.opening_as_of_date,
        opening_as_of_date_max: m.opening_as_of_date,
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
