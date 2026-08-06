'use client';

// ─────────────────────────────────────────────────────────────────────────────────
// ASSIGN THIS RECEIPT TO A CHEQUE — the delivery-first door, Renzo's headline ask.
//
// Renzo: *"Being able to right click on a delivery and then assign a cheque to it or add
// a cheque from a delivery would be nice don't you think? That would make the liquidations
// page more of a summary page. But of course, still being able to do the same things just
// in a different flow."*
//
// ── IT IS THE SAME WRITE PATH, NOT A SECOND ONE ──────────────────────────────────
// This dialog calls `cenapro_allocate_delivery_to_payment`, which is implemented IN SQL on
// top of `cenapro_save_rc_payment_allocations` — it merges its one edge into the payment's
// live block and delegates. So the cheque-first spread screen and this dialog write through
// exactly one function, with one set of invariants and zero duplicated validation. Only the
// entry point differs.
//
// ── WHAT THE PICKER OFFERS, AND WHY ──────────────────────────────────────────────
// Every LIVE payment whose payee resolves to this receipt's own `group_code` and which
// still has `unallocated_php > 0` — i.e. exactly the payments the database would accept. A
// picker that listed a fully-assigned cheque would be offering a guaranteed refusal, and one
// that listed only the receipt's own trader would hide the parent's cheques, which is the
// whole point of supplier subgroups (§5a: *"if a cheque is labeled Paquibot but is being
// assigned to a Llanto delivery, then it should push through"*).
//
// ── THE DEFAULT AMOUNT ───────────────────────────────────────────────────────────
// `min(what is left on the cheque, what is still owed on the receipt)` — the common case is
// settling the rest of a receipt with what is left of a cheque. It is shown as a number the
// operator can change, not applied silently.
//
// **On an UNPRICED receipt there is no default and there cannot be one.** Nobody knows what
// is owed, so the box opens empty with "not priced yet" where the outstanding figure would
// be. Assigning to it is still ALLOWED — a downpayment on a truck weighed tomorrow is
// ordinary business, and the database records it deliberately — it is simply never guessed.
// ─────────────────────────────────────────────────────────────────────────────────

import { useCallback, useEffect, useMemo, useState } from 'react';
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
import { errorToast } from '@/lib/toast';
import { cn, focusNoScroll } from '@/lib/utils';
import { toast } from 'sonner';

import { allocateDeliveryToPayment, fetchAllocationTargets } from '../liquidation/actions';
import {
    NOT_PRICED_TEXT,
    SETTLEMENT_LABEL,
    SETTLEMENT_NOTE,
    formatDate,
    formatPeso,
    methodShort,
    num,
    settlementStatus,
    stillOwedText,
    type DeliverySettlementRow,
    type PaymentStateRow,
} from '../liquidation/types';

export interface AssignChequeDialogProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    /** `null` while the dialog is closing — the body is keyed on it, so it never flickers. */
    deliveryId: string | null;
    /** How the grid names this receipt, so the dialog says the same thing the ledger does. */
    label: string;
    /** Called after a successful assignment so the ledger can re-read the settlement column. */
    onAssigned: () => void;
    /** Puts the caret back on the grid — Radix would aim it at an unmounted menu item. */
    onClosed?: () => void;
}

export function AssignChequeDialog(props: AssignChequeDialogProps) {
    return (
        <Dialog open={props.open} onOpenChange={props.onOpenChange}>
            <DialogContent
                className="animate-modal-enter flex max-h-[88dvh] w-[calc(100%-2rem)] max-w-lg flex-col gap-0 overflow-hidden p-0 sm:max-w-lg"
                onCloseAutoFocus={(e) => {
                    // Radix restores focus to the TRIGGER — a context-menu item that has
                    // already unmounted — which leaves the caret on <body> and the next
                    // keystroke nowhere.
                    e.preventDefault();
                    props.onClosed?.();
                }}
            >
                {/* Keyed on the receipt so opening a SECOND one never shows the first one's
                    cheques while the fetch is in flight. */}
                <AssignBody key={props.deliveryId ?? 'none'} {...props} />
            </DialogContent>
        </Dialog>
    );
}

interface LoadState {
    loading: boolean;
    payments: PaymentStateRow[];
    settlement: DeliverySettlementRow | null;
    error: string | null;
}

const IDLE: LoadState = { loading: false, payments: [], settlement: null, error: null };

function AssignBody({ deliveryId, label, onOpenChange, onAssigned }: AssignChequeDialogProps) {
    const [state, setState] = useState<LoadState>(() =>
        deliveryId ? { ...IDLE, loading: true } : IDLE,
    );
    const [paymentId, setPaymentId] = useState('');
    /** Text, so a half-typed figure is never coerced to a number nobody meant. */
    const [amount, setAmount] = useState('');
    const [saving, setSaving] = useState(false);
    const [trigger, setTrigger] = useState<HTMLButtonElement | null>(null);

    useEffect(() => {
        if (!deliveryId) return;
        let cancelled = false;
        fetchAllocationTargets(deliveryId)
            .then((res) => {
                if (cancelled) return;
                setState({
                    loading: false,
                    payments: res.payments,
                    settlement: res.settlement,
                    error: res.error,
                });
                if (res.error) {
                    errorToast('Could not load the cheques with money left', { description: res.error });
                }
            })
            .catch((err: unknown) => {
                if (cancelled) return;
                setState({ ...IDLE, error: err instanceof Error ? err.message : String(err) });
            });
        return () => {
            cancelled = true;
        };
    }, [deliveryId]);

    // `focusNoScroll`, never React's `autoFocus`: react-dom's commitMount is a bare
    // `.focus()`, and a bare focus() scrolls with block AND inline "center" through every
    // scrolling ancestor — which would jog the sheet behind the dialog.
    useEffect(() => {
        focusNoScroll(trigger);
    }, [trigger]);

    const settlement = state.settlement;
    /**
     * Memoised because `suggested` below depends on it: `stillOwedText` returns a fresh
     * object each call, so an inline conditional would hand that `useMemo` a new identity on
     * every render and defeat it. An absent settlement row reads as "not priced yet" — an
     * unknown, never ₱0.00.
     */
    const owed = useMemo(
        () => (settlement ? stillOwedText(settlement) : { text: NOT_PRICED_TEXT }),
        [settlement],
    );
    const allocatable = settlement?.is_allocatable === true;
    const selected = useMemo(
        () => state.payments.find((p) => p.id === paymentId) ?? null,
        [state.payments, paymentId],
    );

    /**
     * The default: as much as is needed and as much as is available.
     *
     * `null` on an unpriced receipt — there is no "still owed" to fill, so the box opens
     * empty rather than guessing. The database refuses to guess for the same reason.
     */
    const suggested = useMemo(() => {
        if (!selected || !allocatable || !('peso' in owed)) return null;
        const left = num(selected.unallocated_php);
        const still = num(owed.peso);
        if (left === null || still === null) return null;
        const take = Math.min(left, still);
        return take > 0 ? Number(take.toFixed(4)) : null;
    }, [selected, allocatable, owed]);

    /** Choosing a cheque re-seeds the amount — a stale figure from the last one would lie. */
    const choose = useCallback((id: string) => {
        setPaymentId(id);
        setAmount('');
    }, []);

    const effective = amount.trim() === '' ? suggested : num(amount.trim());

    async function handleAssign() {
        if (!deliveryId) return;
        if (!selected?.id || selected.row_version === null || selected.row_version === undefined) {
            errorToast('Choose the cheque this receipt was paid with.');
            return;
        }
        const typed = amount.trim();
        if (typed !== '') {
            const n = num(typed);
            if (n === null) {
                errorToast('That is not an amount', { description: `“${typed}” is not a number.` });
                return;
            }
            if (n <= 0) {
                errorToast('An assigned amount has to be more than zero', {
                    description:
                        'To take money back off a receipt, remove the assignment from the cheque’s spread screen instead — that releases it to the unassigned pool.',
                });
                return;
            }
        } else if (suggested === null) {
            errorToast('Type the amount to assign', {
                description: allocatable
                    ? 'This receipt is already fully settled, or this cheque has nothing left. Type an amount if you mean to over-assign it deliberately.'
                    : 'This receipt has no weight or no agreed price yet, so there is no outstanding amount to fill in for you. Type what you mean to assign.',
            });
            return;
        }

        setSaving(true);
        try {
            const result = await allocateDeliveryToPayment({
                paymentId: selected.id,
                expectedRowVersion: selected.row_version,
                deliveryId,
                // Empty box ⇒ send NULL and let the database compute
                // LEAST(still owed, still unassigned) in SQL, which is where money
                // arithmetic belongs. A typed figure is sent as typed.
                amountPhp: typed === '' ? null : (num(typed) ?? null),
            });

            if (!result.ok) {
                // Verbatim. It names the overshoot in pesos, or both traders when a
                // subgroup does not cover the edge, or the receipt with no payee by name.
                errorToast('The cheque was not assigned', {
                    description: result.message ?? `The database refused the write (${result.outcome}).`,
                });
                return;
            }

            toast.success(result.message ?? 'Assigned');
            onAssigned();
            onOpenChange(false);
        } finally {
            setSaving(false);
        }
    }

    const noCheques = !state.loading && state.payments.length === 0;
    const noPayee = !!settlement && !settlement.supplier_code;

    return (
        <>
            {/* `pr-12` clears DialogContent's own absolutely-positioned close X. */}
            <DialogHeader className="shrink-0 border-b border-border bg-background/90 px-4 py-3 pr-12 backdrop-blur-sm">
                <DialogTitle className="text-base">Assign this receipt to a cheque</DialogTitle>
                <DialogDescription className="text-xs">{label}</DialogDescription>
            </DialogHeader>

            <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
                {state.loading ? (
                    <div className="flex items-center justify-center gap-2 py-8 text-xs text-muted-foreground">
                        <Loader2 className="size-3.5 animate-spin" />
                        Loading the cheques with money left…
                    </div>
                ) : noPayee ? (
                    // §6: the screen should SAY SO, not guess a payee. `rc_payment.supplier_code`
                    // is NOT NULL, so no cheque can ever point at this receipt.
                    <div className="rounded-md border border-border bg-muted/30 p-3">
                        <p className="text-xs font-medium">This receipt has no supplier recorded</p>
                        <p className="mt-1 text-[11px] leading-snug text-muted-foreground">
                            A payment is always made out to one trader, so there is nobody a cheque could
                            be written to for this receipt and none can settle it. Set its supplier in the
                            SUPPLIER cell first — nothing here guesses a payee.
                        </p>
                    </div>
                ) : (
                    <div className="grid gap-4">
                        {/* What the receipt is worth and what is still owed on it — the
                            figures the amount below is measured against. */}
                        <div className="grid grid-cols-3 gap-3 rounded-md border border-border bg-muted/30 px-3 py-2.5">
                            <Figure label="Receipt" value={`₱${formatPeso(settlement?.total_price_php)}`} />
                            <Figure
                                label="Already paid"
                                value={
                                    num(settlement?.allocated_php)
                                        ? `₱${formatPeso(settlement?.allocated_php)}`
                                        : '—'
                                }
                            />
                            {/* NULL, not ₱0.00 — see the header. */}
                            {'peso' in owed ? (
                                <Figure label="Still owed" value={`₱${formatPeso(owed.peso)}`} strong />
                            ) : (
                                <Figure
                                    label="Still owed"
                                    value={NOT_PRICED_TEXT}
                                    amber
                                    title={SETTLEMENT_NOTE.unpriced}
                                />
                            )}
                        </div>

                        {noCheques ? (
                            <div className="rounded-md border border-border bg-muted/30 p-3">
                                <p className="text-xs font-medium">
                                    No cheque for this trader has money left
                                </p>
                                <p className="mt-1 text-[11px] leading-snug text-muted-foreground">
                                    Every payment recorded for{' '}
                                    {settlement?.supplier_display_name ?? settlement?.supplier_code} is
                                    already fully assigned to other receipts. Use{' '}
                                    <span className="font-medium text-foreground">
                                        Record a cheque for this…
                                    </span>{' '}
                                    instead, or release some money on the cheque&rsquo;s own spread screen.
                                </p>
                            </div>
                        ) : (
                            <>
                                <div className="min-w-0">
                                    <Label htmlFor="assign-payment" className="mb-1 text-xs font-medium">
                                        Which cheque
                                    </Label>
                                    <Select value={paymentId} onValueChange={choose}>
                                        <SelectTrigger
                                            id="assign-payment"
                                            ref={setTrigger}
                                            className="h-auto min-h-9 w-full py-1.5 text-sm"
                                        >
                                            <SelectValue placeholder="Choose a payment with money left" />
                                        </SelectTrigger>
                                        <SelectContent className="bg-popover/95 backdrop-blur-lg">
                                            {state.payments.map((p) => (
                                                <SelectItem key={p.id ?? ''} value={p.id ?? ''} className="text-sm">
                                                    <span className="font-medium">
                                                        {p.method === 'cheque'
                                                            ? `#${p.cheque_no ?? '—'}`
                                                            : methodShort(p.method)}
                                                    </span>
                                                    <span className="ml-1.5 font-mono text-[11px] text-muted-foreground">
                                                        {formatDate(p.payment_date)} · ₱
                                                        {formatPeso(p.unallocated_php)} left of ₱
                                                        {formatPeso(p.amount_php)}
                                                    </span>
                                                    {/* A parent's cheque settling a child's receipt is
                                                        legal and worth labelling — it is the reason
                                                        subgroups exist. */}
                                                    {p.supplier_code !== settlement?.supplier_code ? (
                                                        <span className="ml-1.5 text-[10px] text-muted-foreground">
                                                            made out to {p.supplier_name ?? p.supplier_code}
                                                        </span>
                                                    ) : null}
                                                </SelectItem>
                                            ))}
                                        </SelectContent>
                                    </Select>
                                    <p className="mt-1 text-[11px] leading-snug text-muted-foreground">
                                        Only payments that still have money nobody has pointed at a receipt.
                                        A cheque made out to a parent trader can settle a sub-supplier&rsquo;s
                                        receipt — the database checks the grouping itself.
                                    </p>
                                </div>

                                <div className="min-w-0">
                                    <Label htmlFor="assign-amount" className="mb-1 text-xs font-medium">
                                        Amount to assign
                                    </Label>
                                    {/* Accounting shape: ₱ pinned left, the figure pinned right. */}
                                    <div className="flex h-9 items-center gap-1 rounded-md border border-input bg-transparent pl-2.5 focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/50">
                                        <span className="shrink-0 text-sm text-muted-foreground">₱</span>
                                        <Input
                                            id="assign-amount"
                                            type="number"
                                            inputMode="decimal"
                                            min="0.0001"
                                            step="any"
                                            value={amount}
                                            onChange={(e) => setAmount(e.target.value)}
                                            placeholder={
                                                suggested === null ? '0.00' : formatPeso(suggested)
                                            }
                                            disabled={!selected}
                                            className="h-8 border-0 bg-transparent p-0 pr-2.5 text-right font-mono text-sm tabular-nums shadow-none focus-visible:border-0 focus-visible:ring-0"
                                        />
                                    </div>
                                    <p className="mt-1 text-[11px] leading-snug text-muted-foreground">
                                        {!selected
                                            ? 'Choose a cheque first.'
                                            : suggested !== null
                                              ? `Leave it blank to assign ₱${formatPeso(
                                                    suggested,
                                                )} — whichever is smaller, what is left on this cheque or what is still owed on the receipt. The database works it out.`
                                              : allocatable
                                                ? 'This receipt is already settled, or this cheque has nothing left. Type an amount to over-assign it deliberately — that is recorded, not refused.'
                                                : 'This receipt has no price yet, so nothing is filled in for you. You can still assign to it — a downpayment on a truck weighed tomorrow is ordinary — you just have to say how much.'}
                                    </p>
                                </div>

                                {/* What the save will do, in one line, before it happens. */}
                                {selected && effective !== null && effective > 0 ? (
                                    <p
                                        aria-live="polite"
                                        className="rounded-md border border-border bg-muted/30 px-3 py-2 text-[11px] leading-snug"
                                    >
                                        Assigning{' '}
                                        <span className="font-mono font-medium">₱{formatPeso(effective)}</span>{' '}
                                        of{' '}
                                        {selected.method === 'cheque'
                                            ? `cheque #${selected.cheque_no ?? '—'}`
                                            : `the ${methodShort(selected.method).toLowerCase()} of ${formatDate(selected.payment_date)}`}{' '}
                                        to this receipt.{' '}
                                        {settlement ? (
                                            <span className="text-muted-foreground">
                                                It reads{' '}
                                                <span className="font-medium">
                                                    {SETTLEMENT_LABEL[settlementStatus(settlement.settlement_status)]}
                                                </span>{' '}
                                                today.
                                            </span>
                                        ) : null}
                                    </p>
                                ) : null}
                            </>
                        )}
                    </div>
                )}
            </div>

            <DialogFooter className="shrink-0 gap-2 border-t border-border bg-background/90 px-4 py-3 backdrop-blur-sm sm:justify-end">
                <Button variant="outline" size="sm" onClick={() => onOpenChange(false)} disabled={saving}>
                    Cancel
                </Button>
                <Button
                    size="sm"
                    onClick={() => void handleAssign()}
                    disabled={saving || !selected || noPayee}
                >
                    {saving ? <Loader2 className="size-3.5 animate-spin" /> : null}
                    Assign
                </Button>
            </DialogFooter>
        </>
    );
}

/** One labelled figure in the receipt summary. Accounting-shaped, monospaced. */
function Figure({
    label,
    value,
    strong,
    amber,
    title,
}: {
    label: string;
    value: string;
    strong?: boolean;
    amber?: boolean;
    title?: string;
}) {
    return (
        <div className="min-w-0" title={title}>
            <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                {label}
            </p>
            <p
                className={cn(
                    'truncate font-mono text-xs tabular-nums',
                    strong && 'font-bold',
                    amber && 'text-[11px] text-amber-600 dark:text-amber-400',
                )}
            >
                {value}
            </p>
        </div>
    );
}
