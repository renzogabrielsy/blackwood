'use client';

// ─────────────────────────────────────────────────────────────────────────────────
// RECORD A PAYMENT — §7a screen 2.
//
// The form's whole job is to make the database's refusals RARE without ever pretending
// to be the rule itself. Three shapes are mirrored from CHECK constraints:
//
//   • **The cheque shape.** A cheque requires BOTH a number and the account it was drawn
//     on; anything else must carry neither. The form does not merely validate that — it
//     RESHAPES itself, so the fields that must be empty are not on screen to be filled.
//     A field you cannot see cannot be refused.
//   • **The amount is always positive.** The input's `min` is a hair above zero and the
//     sign lives in `direction`, never in the number. There is no way to type a negative
//     and no way to mean one.
//   • **There is no `cash`.** Two instruments plus `adjustment` — which is labelled as
//     what it is, a write-off where no money moved, rather than offered as a third way of
//     paying.
//
// When the DB refuses anyway, its `message` is shown VERBATIM through `errorToast`. It
// names precisely which of a dozen rules was broken ("Cheque #001234 has already been
// recorded against that account — a cheque number is unique per account…"); a re-worded
// "Save failed" would throw away the only part that tells the operator what to do.
//
// `stated_term` and `direction` sit in a quiet strip at the foot of the form. Both are
// real and both are reachable, but neither is arithmetic: the term is RECORDED INTENT and
// no balance is ever computed from it, and the direction is `outgoing` on 99.99% of rows.
// Giving them equal weight with the amount would misdescribe the model.
// ─────────────────────────────────────────────────────────────────────────────────

import { useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { Loader2 } from 'lucide-react';

import { Button } from '@/components/ui/button';
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { errorToast } from '@/lib/toast';
import { cn, focusNoScroll } from '@/lib/utils';
import { toast } from 'sonner';

import { savePayment } from './actions';
import {
    METHOD_OPTIONS,
    TERM_OPTIONS,
    emptyPaymentForm,
    isCheque,
    paymentFormFrom,
    paymentPatchFrom,
    validatePaymentForm,
    type BankAccountRow,
    type LiquidationResult,
    type PaymentFormState,
    type PaymentMethod,
    type PaymentRow,
    type StatedTerm,
    type SupplierGroupRow,
} from './types';

/** Radix reserves `value=""` for "cleared", so an explicit "none" needs a sentinel. */
const NONE = '__none__';

export interface PaymentDialogProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    /** Pre-selected payee. The picker stays editable — a mis-addressed cheque is a real correction. */
    supplierCode: string;
    suppliers: SupplierGroupRow[];
    accounts: BankAccountRow[];
    /** `null` records a new payment; a row edits it. */
    editing: PaymentRow | null;
    /**
     * Pre-fill the amount (Step 4, the delivery-first door).
     *
     * The deliveries ledger passes the outstanding total of the receipt(s) the cheque is
     * being written for — §7a: creating a payment for exactly the selected total **is** the
     * `straight` term Renzo described. It seeds the field and stays EDITABLE, because a
     * trader who wants a round figure is the normal case, not an exception (decision 8).
     * Ignored when `editing` is set: an existing payment's own amount always wins.
     */
    initialAmountPhp?: string;
    /**
     * One line under the title saying what this payment is being recorded FOR, when it is
     * being recorded from somewhere that knows — "for the 2026-08-04 receipt (truck 1234)".
     * Absent from the liquidation module's own flow, which has no such context.
     */
    contextNote?: string;
    /**
     * Called after a successful write. Step 4 passes the RPC's result through, so the
     * delivery-first door can take the NEW payment's id and point it at the receipts the
     * cheque was written for — one continuous act, not two things the operator has to
     * remember to do. Existing callers that take no argument are unaffected.
     */
    onSaved: (result?: LiquidationResult) => void;
}

function today(): string {
    // Local calendar day, not UTC: a payment released on the 5th in Cebu must not be
    // pre-filled as the 4th because the browser is west of the date line.
    const d = new Date();
    const p = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function PaymentDialog(props: PaymentDialogProps) {
    return (
        <Dialog open={props.open} onOpenChange={props.onOpenChange}>
            <DialogContent className="animate-modal-enter flex max-h-[88dvh] w-[calc(100%-2rem)] max-w-xl flex-col gap-0 overflow-hidden p-0 sm:max-w-xl">
                {/*
                    Keyed on the row being edited so opening a SECOND payment never shows
                    the first one's values — the whole form state is remounted rather than
                    synchronised. Same reasoning as the receipt-history dialog's key.
                */}
                {/* The pre-filled amount is part of the key: recording a cheque for one
                    receipt and then for a different one must not reuse the first amount. */}
                <PaymentForm
                    key={
                        props.editing?.id ??
                        `new:${props.supplierCode}:${props.initialAmountPhp ?? ''}`
                    }
                    {...props}
                />
            </DialogContent>
        </Dialog>
    );
}

function PaymentForm({
    onOpenChange,
    supplierCode,
    suppliers,
    accounts,
    editing,
    initialAmountPhp,
    contextNote,
    onSaved,
}: PaymentDialogProps) {
    const [form, setForm] = useState<PaymentFormState>(() => {
        if (editing) return paymentFormFrom(editing);
        const blank = emptyPaymentForm(supplierCode, today());
        // Seeded, not locked. A trader who wants a round figure is the normal case, and the
        // remainder they carry is ordinary business (decision 8) — so the operator types
        // over this whenever they mean to.
        return initialAmountPhp ? { ...blank, amount_php: initialAmountPhp } : blank;
    });
    const [saving, setSaving] = useState(false);
    /** Only shown once the operator has tried to save — never while they are still typing. */
    const [submitted, setSubmitted] = useState(false);
    const firstField = useRef<HTMLButtonElement | null>(null);

    // `focusNoScroll`, never React's `autoFocus`: react-dom's commitMount is a bare
    // `.focus()` with no options, and a bare focus() scrolls with block AND inline
    // "center" through every scrolling ancestor.
    useEffect(() => {
        focusNoScroll(firstField.current);
    }, []);

    const errors = useMemo(() => validatePaymentForm(form), [form]);
    const showError = (field: keyof PaymentFormState) => (submitted ? errors[field] : undefined);

    const cheque = isCheque(form.method);
    // A write-off moved no money, so there is no account it left from. Hidden rather than
    // disabled — the model says the field does not apply, not that it is unavailable.
    const wantsAccount = form.method !== 'adjustment';
    const activeAccounts = accounts.filter((a) => a.active !== false || a.id === form.bank_account_id);
    /**
     * No bank account exists yet, anywhere. Worth saying OUT LOUD rather than leaving an
     * empty picker: nothing was seeded (an account number is a real fact about a real
     * cheque book, and inventing one is the fabrication the audit discipline exists to
     * prevent), so a cheque genuinely cannot be recorded until someone adds one. Letting
     * the operator fill the whole form and then hit a refusal would be the worse version
     * of the same truth.
     */
    const noAccounts = activeAccounts.length === 0;

    function set<K extends keyof PaymentFormState>(key: K, value: PaymentFormState[K]) {
        setForm((f) => ({ ...f, [key]: value }));
    }

    /**
     * Changing the method CLEARS the fields the new shape forbids. Leaving a stale cheque
     * number behind on a transfer would produce a refusal about a field the operator can
     * no longer see — the single most confusing failure this form could have.
     */
    function setMethod(method: PaymentMethod) {
        setForm((f) => ({
            ...f,
            method,
            cheque_no: method === 'cheque' ? f.cheque_no : '',
            cheque_date: method === 'cheque' ? f.cheque_date : '',
            bank_account_id: method === 'adjustment' ? '' : f.bank_account_id,
        }));
    }

    async function handleSave() {
        setSubmitted(true);
        if (Object.keys(errors).length > 0) {
            const first = Object.values(errors)[0];
            errorToast('This payment is not ready to save', { description: first });
            return;
        }

        setSaving(true);
        try {
            const result = await savePayment({
                id: editing?.id ?? null,
                // An insert must send NO expected version — the RPC refuses the call
                // outright if one rides along with a null id.
                expectedRowVersion: editing ? (editing.row_version ?? null) : null,
                patch: paymentPatchFrom(form),
            });

            if (!result.ok) {
                // The database's own words, verbatim. It knows which rule was broken.
                errorToast(
                    editing ? 'The payment was not saved' : 'The payment was not recorded',
                    { description: result.message ?? `The database refused the write (${result.outcome}).` },
                );
                return;
            }

            toast.success(editing ? 'Payment updated' : 'Payment recorded');
            // The result carries the new payment's id and version, which is what lets the
            // delivery-first door point it at the receipts it was written for without a
            // second round trip or a second decision from the operator.
            onSaved(result);
            onOpenChange(false);
        } finally {
            setSaving(false);
        }
    }

    return (
        <>
            {/* `pr-12` clears DialogContent's own absolutely-positioned close X. */}
            <DialogHeader className="shrink-0 border-b border-border bg-background/90 px-4 py-3 pr-12 backdrop-blur-sm">
                <DialogTitle className="text-base">
                    {editing ? 'Edit payment' : 'Record a payment'}
                </DialogTitle>
                <DialogDescription className="text-xs">
                    {contextNote ? (
                        // Recorded FROM somewhere that knows what it is for — the deliveries
                        // ledger. Saying so is what makes the two doors feel like one act.
                        <>
                            <span className="font-medium text-foreground">{contextNote}</span> — the amount
                            is pre-filled with what is still owed, and it stays editable.
                        </>
                    ) : (
                        <>
                            Money going out to a trader. It reduces that trader&rsquo;s balance
                            immediately; pointing it at particular receipts is a separate step, on the
                            cheque&rsquo;s own spread screen.
                        </>
                    )}
                </DialogDescription>
            </DialogHeader>

            <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
                <div className="grid gap-4">
                    {/* ── Who, when ─────────────────────────────────────────────── */}
                    <div className="grid gap-4 sm:grid-cols-2">
                        <Field label="Paid to" htmlFor="pay-supplier" error={showError('supplier_code')}>
                            <Select value={form.supplier_code} onValueChange={(v) => set('supplier_code', v)}>
                                <SelectTrigger id="pay-supplier" ref={firstField} className="h-9 w-full text-sm">
                                    <SelectValue placeholder="Choose a trader" />
                                </SelectTrigger>
                                <SelectContent className="bg-popover/95 backdrop-blur-lg">
                                    {suppliers.map((s) => (
                                        <SelectItem key={s.code ?? ''} value={s.code ?? ''} className="text-sm">
                                            <span className="font-medium">{s.display_name ?? s.code}</span>
                                            {s.is_child ? (
                                                <span className="ml-1.5 text-[10px] text-muted-foreground">
                                                    sub-supplier of {s.parent_display_name ?? s.parent_code}
                                                </span>
                                            ) : null}
                                        </SelectItem>
                                    ))}
                                </SelectContent>
                            </Select>
                        </Field>

                        <Field label="Date released" htmlFor="pay-date" error={showError('payment_date')}>
                            <Input
                                id="pay-date"
                                type="date"
                                value={form.payment_date}
                                onChange={(e) => set('payment_date', e.target.value)}
                                className="h-9 font-mono text-sm"
                            />
                        </Field>
                    </div>

                    {/* ── How, how much ─────────────────────────────────────────── */}
                    <div className="grid gap-4 sm:grid-cols-2">
                        <Field label="Method" htmlFor="pay-method">
                            <Select value={form.method} onValueChange={(v) => setMethod(v as PaymentMethod)}>
                                <SelectTrigger id="pay-method" className="h-9 w-full text-sm">
                                    <SelectValue />
                                </SelectTrigger>
                                <SelectContent className="bg-popover/95 backdrop-blur-lg">
                                    {METHOD_OPTIONS.map((m) => (
                                        <SelectItem key={m.value} value={m.value} className="text-sm">
                                            {m.label}
                                        </SelectItem>
                                    ))}
                                </SelectContent>
                            </Select>
                            <p className="mt-1 text-[11px] leading-snug text-muted-foreground">
                                {METHOD_OPTIONS.find((m) => m.value === form.method)?.hint}
                            </p>
                        </Field>

                        <Field label="Amount" htmlFor="pay-amount" error={showError('amount_php')}>
                            {/* Accounting shape: ₱ pinned left, the figure pinned right. */}
                            <div className="flex h-9 items-center gap-1 rounded-md border border-input bg-transparent pl-2.5 focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/50">
                                <span className="shrink-0 text-sm text-muted-foreground">₱</span>
                                <Input
                                    id="pay-amount"
                                    type="number"
                                    inputMode="decimal"
                                    // Always positive: the sign is carried by `direction`,
                                    // never folded into the amount.
                                    min="0.0001"
                                    step="any"
                                    value={form.amount_php}
                                    onChange={(e) => set('amount_php', e.target.value)}
                                    placeholder="0.00"
                                    className="h-8 border-0 bg-transparent p-0 pr-2.5 text-right font-mono text-sm tabular-nums shadow-none focus-visible:border-0 focus-visible:ring-0"
                                />
                            </div>
                        </Field>
                    </div>

                    {/* ── Which of OUR accounts ─────────────────────────────────── */}
                    {wantsAccount ? (
                        <Field
                            label={cheque ? 'Drawn on' : 'Sent from'}
                            htmlFor="pay-account"
                            error={showError('bank_account_id')}
                            hint={
                                noAccounts
                                    ? undefined
                                    : cheque
                                      ? 'A cheque number is unique per account, not globally — the same number on two accounts is legitimate.'
                                      : 'Optional for a transfer.'
                            }
                        >
                            <Select
                                // `undefined` rather than the NONE sentinel when a cheque is
                                // being recorded: the sentinel has no matching item on this
                                // branch, and Radix renders a value with no item as BLANK —
                                // swallowing the placeholder and leaving an empty control
                                // with no hint that anything is required.
                                value={form.bank_account_id || (cheque ? undefined : NONE)}
                                onValueChange={(v) => set('bank_account_id', v === NONE ? '' : v)}
                                disabled={noAccounts}
                            >
                                <SelectTrigger id="pay-account" className="h-auto min-h-9 w-full py-1.5 text-sm">
                                    <SelectValue
                                        placeholder={noAccounts ? 'No accounts set up' : 'Choose an account'}
                                    />
                                </SelectTrigger>
                                <SelectContent className="bg-popover/95 backdrop-blur-lg">
                                    {!cheque ? (
                                        <SelectItem value={NONE} className="text-sm text-muted-foreground">
                                            Not recorded
                                        </SelectItem>
                                    ) : null}
                                    {activeAccounts.length === 0 ? (
                                        <div className="px-2 py-3 text-xs text-muted-foreground">
                                            No bank accounts have been set up yet.
                                        </div>
                                    ) : null}
                                    {activeAccounts.map((a) => (
                                        <SelectItem key={a.id ?? ''} value={a.id ?? ''} className="text-sm">
                                            {/* Bank name reads primarily; the number is secondary detail. */}
                                            <span className="font-medium">{a.bank_display_name ?? a.bank_code}</span>
                                            <span className="ml-1.5 text-[11px] text-muted-foreground">
                                                {a.account_label}
                                                {a.account_no ? ` · ${a.account_no}` : ''}
                                            </span>
                                        </SelectItem>
                                    ))}
                                </SelectContent>
                            </Select>
                            {noAccounts ? (
                                // A path, not a dead end. The notice disappears entirely the
                                // moment an account exists — `noAccounts` is derived from the
                                // list, so nothing has to remember to take it down.
                                <p className="mt-1 text-[11px] leading-snug text-muted-foreground">
                                    No accounts have been set up yet.{' '}
                                    <Link
                                        href="/cenapro/liquidation/banks"
                                        className="font-medium text-foreground underline underline-offset-2 hover:text-primary"
                                    >
                                        Add one first
                                    </Link>{' '}
                                    — a cheque has to name the account it was drawn on.
                                </p>
                            ) : null}
                        </Field>
                    ) : null}

                    {/* ── The cheque's own identity ─────────────────────────────── */}
                    {cheque ? (
                        <div className="grid gap-4 sm:grid-cols-2">
                            <Field label="Cheque no." htmlFor="pay-cheque-no" error={showError('cheque_no')}>
                                <Input
                                    id="pay-cheque-no"
                                    value={form.cheque_no}
                                    onChange={(e) => set('cheque_no', e.target.value)}
                                    placeholder="001234"
                                    className="h-9 font-mono text-sm"
                                />
                            </Field>
                            <Field
                                label="Cheque date"
                                htmlFor="pay-cheque-date"
                                error={showError('cheque_date')}
                                hint="Only if it differs from the date released (post-dated)."
                            >
                                <Input
                                    id="pay-cheque-date"
                                    type="date"
                                    value={form.cheque_date}
                                    onChange={(e) => set('cheque_date', e.target.value)}
                                    className="h-9 font-mono text-sm"
                                />
                            </Field>
                        </div>
                    ) : null}

                    <Field label="Reference / OR no." htmlFor="pay-ref">
                        <Input
                            id="pay-ref"
                            value={form.reference_no}
                            onChange={(e) => set('reference_no', e.target.value)}
                            placeholder="Optional"
                            className="h-9 font-mono text-sm"
                        />
                    </Field>

                    <Field
                        label={form.method === 'adjustment' ? 'Reason for the write-off' : 'Remarks'}
                        htmlFor="pay-remarks"
                        error={showError('remarks')}
                    >
                        <Textarea
                            id="pay-remarks"
                            value={form.remarks}
                            onChange={(e) => set('remarks', e.target.value)}
                            rows={2}
                            placeholder={
                                form.method === 'adjustment'
                                    ? 'Why this remainder is being forgiven'
                                    : 'Optional'
                            }
                            className="min-h-[2.5rem] text-sm"
                        />
                    </Field>

                    {/* ── The quiet strip: recorded intent, and the rare direction ─ */}
                    <div className="rounded-md border border-border bg-muted/30 px-3 py-2.5">
                        <div className="grid gap-3 sm:grid-cols-2">
                            <div>
                                <Label htmlFor="pay-term" className="text-[11px] font-medium text-muted-foreground">
                                    Stated term
                                </Label>
                                <Select
                                    value={form.stated_term || NONE}
                                    onValueChange={(v) => set('stated_term', v === NONE ? '' : (v as StatedTerm))}
                                >
                                    <SelectTrigger id="pay-term" className="mt-1 h-8 w-full text-xs">
                                        <SelectValue placeholder="Not recorded" />
                                    </SelectTrigger>
                                    <SelectContent className="bg-popover/95 backdrop-blur-lg">
                                        <SelectItem value={NONE} className="text-xs text-muted-foreground">
                                            Not recorded
                                        </SelectItem>
                                        {TERM_OPTIONS.map((t) => (
                                            <SelectItem key={t.value} value={t.value} className="text-xs">
                                                {t.label}
                                            </SelectItem>
                                        ))}
                                    </SelectContent>
                                </Select>
                            </div>

                            <div>
                                <Label htmlFor="pay-direction" className="text-[11px] font-medium text-muted-foreground">
                                    Direction
                                </Label>
                                <Select
                                    value={form.direction}
                                    onValueChange={(v) => set('direction', v as PaymentFormState['direction'])}
                                >
                                    <SelectTrigger id="pay-direction" className="mt-1 h-8 w-full text-xs">
                                        <SelectValue />
                                    </SelectTrigger>
                                    <SelectContent className="bg-popover/95 backdrop-blur-lg">
                                        <SelectItem value="outgoing" className="text-xs">
                                            Outgoing — we paid them
                                        </SelectItem>
                                        <SelectItem value="incoming" className="text-xs">
                                            Incoming — money came back
                                        </SelectItem>
                                    </SelectContent>
                                </Select>
                            </div>
                        </div>
                        <p className="mt-2 text-[11px] leading-snug text-muted-foreground">
                            The term is what the voucher says this payment was meant to be. It is recorded as
                            intent only — <span className="font-medium">no balance is ever worked out from it</span>.
                        </p>
                    </div>
                </div>
            </div>

            <DialogFooter className="shrink-0 gap-2 border-t border-border bg-background/90 px-4 py-3 backdrop-blur-sm sm:justify-end">
                <Button variant="outline" size="sm" onClick={() => onOpenChange(false)} disabled={saving}>
                    Cancel
                </Button>
                <Button size="sm" onClick={handleSave} disabled={saving}>
                    {saving ? <Loader2 className="size-3.5 animate-spin" /> : null}
                    {editing ? 'Save changes' : 'Record payment'}
                </Button>
            </DialogFooter>
        </>
    );
}

// ─── One labelled control ───────────────────────────────────────────────────────

function Field({
    label,
    htmlFor,
    error,
    hint,
    children,
}: {
    label: string;
    htmlFor?: string;
    error?: string;
    hint?: string;
    children: React.ReactNode;
}) {
    return (
        <div className="min-w-0">
            <Label htmlFor={htmlFor} className="mb-1 text-xs font-medium">
                {label}
            </Label>
            {children}
            {/*
                An inline error, not a toast — it belongs beside the field it is about.
                Errors that need copying are the DB's refusals, and those go through
                `errorToast` (persistent + Copy) from `handleSave`.
            */}
            {error ? (
                <p className={cn('mt-1 text-[11px] leading-snug text-destructive')} role="alert">
                    {error}
                </p>
            ) : hint ? (
                <p className="mt-1 text-[11px] leading-snug text-muted-foreground">{hint}</p>
            ) : null}
        </div>
    );
}
