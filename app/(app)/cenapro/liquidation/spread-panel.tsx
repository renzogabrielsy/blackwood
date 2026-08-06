'use client';

// ─────────────────────────────────────────────────────────────────────────────────
// SPREAD A PAYMENT ACROSS RECEIPTS — §7a screen 3, and the surface that earns the
// feature. The median cheque covers four to eight receipts, so this is not a detail
// panel: it is the working screen.
//
// ── ONE SURFACE, TWO DOORS ───────────────────────────────────────────────────────
// Renzo asked for cheque-first AND delivery-first. Both create the SAME
// `cenapro.rc_payment_allocation` rows through the SAME RPC, so this screen and the
// deliveries ledger's context menu are two entry points onto one write path — not two
// implementations. Everything shared lives in `types.ts`; the block RPC is the only
// place a block is ever written.
//
// ── FOUR THINGS THIS SCREEN HAS TO GET RIGHT ─────────────────────────────────────
//
// 1. **THE UNASSIGNED FIGURE IS TOP-RIGHT AND NEVER SCROLLS AWAY.** §7a says so, and the
//    reason is that it is the number being steered to zero. It lives in the sticky
//    header, not in a footer summary — a total you have to scroll to find is a total you
//    work without. It tracks the OPERATOR'S TYPING, so it answers "what happens if I save
//    this", not "what did the database say when this opened".
//
// 2. **TWO SEPARATE MONEY COLUMNS: "still owed" and "assign".** One column doing both
//    jobs would render a FACT and a PROPOSAL identically, on the one screen where telling
//    them apart is the entire task.
//
// 3. **AN UNPRICED RECEIPT IS AN UNKNOWN, NOT A ₱0 DEBT.** Where the still-owed figure
//    would be it says **"not priced yet"** — never ₱0.00, because `total_price_php`
//    COALESCEs a missing weight to exactly zero and a 0 there is a claim that nothing is
//    owed. It is NEVER auto-filled and NEVER swept by `Fill oldest first`. It CAN still be
//    assigned to by hand: the database deliberately allows it, because a downpayment on a
//    truck weighed tomorrow is ordinary business. Allowed deliberately, never by accident —
//    that is the whole synthesis.
//
// 4. **A SUB-SUPPLIER'S RECEIPT APPEARS IN THE PARENT'S LIST, LABELLED.** The list is
//    scoped by `group_code` (§5a), so a cheque to the parent can settle a child's
//    delivery. Silently mixing the two traders' receipts with no label would make the
//    parent's list look wrong; the label is what makes it read as correct.
//
// ── WHAT IS NOT AN ERROR HERE ────────────────────────────────────────────────────
// Over-allocating a RECEIPT is legal and recorded (decision 13). Leaving money unassigned
// is legal — that IS a cash advance (§4.4), and it needs no screen of its own. Neither
// gets red, a badge, or a refusal. The one thing the database DOES refuse is
// over-allocating the PAYMENT, and its refusal names the overshoot in pesos.
// ─────────────────────────────────────────────────────────────────────────────────

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Loader2, RotateCcw, Wand2 } from 'lucide-react';

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
import { errorToast } from '@/lib/toast';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';

import { fetchSpread, savePaymentAllocations } from './actions';
import { InlineError } from './payments-panel';
import {
    NOT_PRICED_TEXT,
    SETTLEMENT_LABEL,
    SETTLEMENT_NOTE,
    SPREAD_COLS,
    allocationsPayload,
    draftedCount,
    draftedTotal,
    fillOldestFirst,
    formatCount,
    formatDate,
    formatKg,
    formatPeso,
    methodShort,
    minSpreadTableWidth,
    num,
    receiptLabel,
    settlementStatus,
    spreadFrozenOffsets,
    stillOwedText,
    validateAllocations,
    type AllocationDrafts,
    type DeliverySettlementRow,
    type PaymentAllocationRow,
    type PaymentStateRow,
    type SpreadLine,
} from './types';

const MIN_W = minSpreadTableWidth();
const FROZEN_LEFT = spreadFrozenOffsets();

export interface SpreadPanelProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    /** `null` while the dialog is closing — the body is keyed on it, so it never flickers. */
    paymentId: string | null;
    /** Called after a successful save so the caller can re-read the balance behind it. */
    onSaved: () => void;
}

export function SpreadPanel(props: SpreadPanelProps) {
    return (
        <Dialog open={props.open} onOpenChange={props.onOpenChange}>
            <DialogContent
                className="animate-modal-enter flex max-h-[92dvh] w-[calc(100%-2rem)] max-w-5xl flex-col gap-0 overflow-hidden p-0 sm:max-w-5xl"
                // The unassigned figure is the point of the screen and it lives in the
                // header, so the header must never be what scrolls. Only the table does.
            >
                {/* Keyed on the payment so opening a SECOND cheque never shows the first
                    one's amounts while the fetch is in flight — the whole draft state is
                    remounted rather than synchronised. Same reasoning as the payment form. */}
                <SpreadBody key={props.paymentId ?? 'none'} {...props} />
            </DialogContent>
        </Dialog>
    );
}

interface LoadState {
    loading: boolean;
    payment: PaymentStateRow | null;
    settlements: DeliverySettlementRow[];
    allocations: PaymentAllocationRow[];
    error: string | null;
}

const IDLE: LoadState = {
    loading: false, payment: null, settlements: [], allocations: [], error: null,
};

function SpreadBody({ paymentId, onOpenChange, onSaved }: SpreadPanelProps) {
    const [state, setState] = useState<LoadState>(() =>
        paymentId ? { ...IDLE, loading: true } : IDLE,
    );
    /** What the operator has typed, per receipt. Empty string ⇒ not assigned. */
    const [drafts, setDrafts] = useState<AllocationDrafts>({});
    /** True once the stored block has seeded `drafts` — so a reload does not wipe typing. */
    const [seeded, setSeeded] = useState(false);
    const [saving, setSaving] = useState(false);

    useEffect(() => {
        // No setState on this branch: the body is KEYED on the payment, so the initializer
        // above has already put it in the right state.
        if (!paymentId) return;

        let cancelled = false;
        fetchSpread(paymentId)
            .then((res) => {
                if (cancelled) return;
                setState({
                    loading: false,
                    payment: res.payment,
                    settlements: res.settlements,
                    allocations: res.allocations,
                    error: res.error,
                });
                // Seed the ASSIGN column from the block already saved against this
                // payment, so opening the screen shows what is there rather than a blank
                // form that would release everything if saved.
                setDrafts(
                    Object.fromEntries(
                        res.allocations
                            .filter((a) => a.delivery_id && !a.is_deleted)
                            .map((a) => [a.delivery_id as string, String(num(a.amount_php) ?? '')]),
                    ),
                );
                setSeeded(true);
                if (res.error) {
                    errorToast('Could not load the receipts to spread across', { description: res.error });
                }
            })
            .catch((err: unknown) => {
                if (cancelled) return;
                setState({
                    ...IDLE,
                    error: err instanceof Error ? err.message : String(err),
                });
                setSeeded(true);
            });
        return () => {
            cancelled = true;
        };
    }, [paymentId]);

    const payment = state.payment;
    const amount = num(payment?.amount_php) ?? 0;

    /**
     * The receipt list, oldest first, with the edge already on this payment folded in.
     *
     * Ordered by the SERVER (`delivery_date ASC`); this only stitches. `is_subgroup` is
     * read off the settlement row's own `supplier_code` against the payment's payee —
     * both come from the view, so neither is re-derived from a name.
     */
    const lines = useMemo<SpreadLine[]>(() => {
        const byDelivery = new Map<string, PaymentAllocationRow>();
        for (const a of state.allocations) {
            if (a.delivery_id && !a.is_deleted) byDelivery.set(a.delivery_id, a);
        }
        const payee = payment?.supplier_code ?? null;
        return state.settlements
            .filter((s): s is DeliverySettlementRow & { delivery_id: string } => !!s.delivery_id)
            .map((s) => ({
                deliveryId: s.delivery_id,
                settlement: s,
                existing: byDelivery.get(s.delivery_id) ?? null,
                isSubgroup: payee !== null && s.supplier_code !== payee,
            }));
    }, [state.settlements, state.allocations, payment?.supplier_code]);

    // ── The operator's own arithmetic, and the ONLY arithmetic on this screen ─────
    //
    // Summing un-saved FORM INPUTS is explicitly the one thing TypeScript may add up here
    // (`CLAUDE.md` forbids computing a balance). Every STORED figure below —
    // `balance_php`, `allocated_php`, `unallocated_php` — is read straight off the view.
    const assigned = useMemo(() => draftedTotal(drafts), [drafts]);
    const assignedCount = useMemo(() => draftedCount(drafts), [drafts]);
    /** The number being steered to zero. It follows the typing, not the last fetch. */
    const unassigned = amount - assigned;
    const overAssigned = unassigned < 0;

    const setDraft = useCallback((deliveryId: string, text: string) => {
        setDrafts((d) => ({ ...d, [deliveryId]: text }));
    }, []);

    /**
     * `Fill oldest first` — spend what is left down the list.
     *
     * It REPLACES the typed amounts rather than topping them up: this helper means
     * "spread it down the list", and a version that added to whatever was already there
     * would mean something different every time it was pressed. It skips a receipt with no
     * price — see rule 3 in the header.
     */
    const handleFill = useCallback(() => {
        const next = fillOldestFirst(lines, amount);
        setDrafts(next);
        const n = Object.keys(next).length;
        const skipped = lines.filter((l) => l.settlement.is_allocatable !== true).length;
        if (n === 0) {
            toast.info(
                skipped > 0
                    ? `Nothing to fill — every receipt is either settled or has no price yet (${skipped} not priced).`
                    : 'Nothing to fill — every receipt of this trader is already settled.',
            );
            return;
        }
        toast.success(
            `Filled ${n} receipt${n === 1 ? '' : 's'}, oldest first${
                skipped > 0 ? ` · skipped ${skipped} with no price yet` : ''
            }`,
        );
    }, [lines, amount]);

    const handleClear = useCallback(() => setDrafts({}), []);

    async function handleSave() {
        if (!payment?.id || payment.row_version === null || payment.row_version === undefined) {
            errorToast('That payment is missing its id or version token — reload the payment list.');
            return;
        }

        // A pre-flight, never a replacement for the DB's own rules. It catches the one
        // refusal an operator can see coming (a block worth more than the cheque) so the
        // round trip is not spent on it.
        const complaint = validateAllocations(drafts, payment.amount_php);
        if (complaint) {
            errorToast('This cheque cannot be spread that way', { description: complaint });
            return;
        }

        setSaving(true);
        try {
            const result = await savePaymentAllocations({
                paymentId: payment.id,
                expectedRowVersion: payment.row_version,
                allocations: allocationsPayload(drafts),
            });

            if (!result.ok) {
                // The database's own words, verbatim. It names the overshoot in pesos, or
                // both traders when a subgroup does not cover an edge — a re-worded
                // "Save failed" would throw away the instruction.
                errorToast('The cheque was not spread', {
                    description: result.message ?? `The database refused the write (${result.outcome}).`,
                });
                return;
            }

            // The RPC's own success message says exactly what landed and how much of the
            // payment is still unassigned, so it is shown rather than paraphrased.
            toast.success(result.message ?? 'Allocations saved');
            onSaved();
            onOpenChange(false);
        } finally {
            setSaving(false);
        }
    }

    return (
        <>
            {/* ── HEADER: the cheque on the left, the UNASSIGNED figure top-right ──
                It is in the header and not a footer because it is the number being
                steered to zero, and §7a is explicit that it must never require
                scrolling. `pr-12` clears DialogContent's own absolute close X. */}
            <DialogHeader className="shrink-0 gap-0 border-b border-border bg-background/90 px-4 py-3 pr-12 backdrop-blur-sm">
                <div className="flex flex-wrap items-start justify-between gap-4">
                    <div className="min-w-0">
                        <DialogTitle className="text-base">
                            {payment
                                ? payment.method === 'cheque'
                                    ? `Spread cheque #${payment.cheque_no ?? '—'}`
                                    : `Spread ${methodShort(payment.method).toLowerCase()} of ${formatDate(payment.payment_date)}`
                                : 'Spread a payment'}
                        </DialogTitle>
                        <DialogDescription className="text-xs">
                            {payment ? (
                                <>
                                    Made out to{' '}
                                    <span className="font-medium text-foreground">
                                        {payment.supplier_name ?? payment.supplier_code}
                                    </span>{' '}
                                    · {formatDate(payment.payment_date)} ·{' '}
                                    <span className="font-mono">₱{formatPeso(payment.amount_php)}</span>
                                    {payment.bank_display_name ? ` · ${payment.bank_display_name}` : ''}
                                </>
                            ) : (
                                'Choose which receipts this payment settles.'
                            )}
                        </DialogDescription>
                    </div>

                    {/* THE NUMBER. Right-aligned, largest thing on the screen, and it
                        tracks the typing rather than the last fetch — the question it
                        answers is "what happens if I save this". */}
                    <div className="shrink-0 text-right">
                        <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                            {overAssigned ? 'Over the payment by' : 'Still unassigned'}
                        </p>
                        <p
                            className={cn(
                                'font-mono text-xl font-bold tabular-nums',
                                // The ONE place this module colours a figure, and it is not
                                // "a balance is wrong" — it is "the database will refuse
                                // this save". Leaving money unassigned is a cash advance and
                                // stays in plain foreground.
                                overAssigned && 'text-destructive',
                            )}
                            title={
                                overAssigned
                                    ? 'More is assigned than this payment is worth. The database refuses this — lower one of the amounts, or raise the payment first.'
                                    : 'Payment amount less everything assigned below. Money left here is an outstanding cash advance, which is perfectly normal — it needs no screen of its own.'
                            }
                        >
                            ₱{formatPeso(Math.abs(unassigned))}
                        </p>
                        <p className="mt-0.5 font-mono text-[10px] text-muted-foreground">
                            ₱{formatPeso(assigned)} assigned across {assignedCount}
                        </p>
                    </div>
                </div>
            </DialogHeader>

            {/* ── The helper strip ─────────────────────────────────────────────── */}
            <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-2">
                <p className="text-[11px] text-muted-foreground">
                    {state.loading
                        ? 'Loading…'
                        : `${lines.length} receipt${lines.length === 1 ? '' : 's'} for this trader’s group, oldest first`}
                </p>
                <div className="flex items-center gap-1.5">
                    <Button
                        variant="outline"
                        size="sm"
                        className="h-7 text-[11px]"
                        onClick={handleFill}
                        disabled={state.loading || saving || lines.length === 0}
                        title="Spend this payment down the list, oldest receipt first, until the money runs out. Receipts with no price yet are SKIPPED — nobody knows what is owed on them, so there is nothing to fill."
                    >
                        <Wand2 className="size-3.5" />
                        Fill oldest first
                    </Button>
                    <Button
                        variant="ghost"
                        size="sm"
                        className="h-7 text-[11px]"
                        onClick={handleClear}
                        disabled={state.loading || saving || assignedCount === 0}
                        title="Clear every amount. Saving after this releases the whole cheque back to its unassigned pool — nothing is destroyed, and each released assignment can be restored."
                    >
                        <RotateCcw className="size-3" />
                        Clear all
                    </Button>
                </div>
            </div>

            {/* ── The table. Never crush, always scroll. ───────────────────────── */}
            <div className="min-h-0 flex-1 overflow-auto">
                {state.loading ? (
                    <div className="flex items-center justify-center gap-2 p-8 text-xs text-muted-foreground">
                        <Loader2 className="size-3.5 animate-spin" />
                        Loading receipts…
                    </div>
                ) : state.error ? (
                    <InlineError message={state.error} />
                ) : !payment ? (
                    <div className="animate-fade-up p-8 text-center">
                        <p className="text-sm font-medium">That payment is no longer there</p>
                        <p className="mx-auto mt-1 max-w-sm text-xs text-muted-foreground">
                            It may have been voided while this was open. Reload the payment list.
                        </p>
                    </div>
                ) : lines.length === 0 ? (
                    <div className="animate-fade-up p-8 text-center">
                        <p className="text-sm font-medium">No receipts for this trader yet</p>
                        <p className="mx-auto mt-1 max-w-md text-xs text-muted-foreground">
                            Nothing has been received from{' '}
                            {payment.supplier_name ?? payment.supplier_code}, so there is nothing for this
                            payment to settle. It stays as an outstanding advance until a truck arrives —
                            which is exactly what an advance is.
                        </p>
                    </div>
                ) : (
                    <table
                        className="w-full table-fixed text-xs"
                        // `separate` + `border-spacing: 0` is MANDATORY, never
                        // `border-collapse` — under the collapsed model a border belongs to
                        // the TABLE rather than the cell, `.frozen-edge`'s shadow does not
                        // paint at all, and a sticky cell's own background stops painting
                        // reliably so scrolling figures bleed through the frozen columns.
                        // Measured live in this module.
                        style={{ minWidth: MIN_W, borderCollapse: 'separate', borderSpacing: 0 }}
                    >
                        <colgroup>
                            {SPREAD_COLS.map((c) => (
                                <col key={c.key} style={{ width: c.width }} />
                            ))}
                        </colgroup>
                        <thead>
                            <tr>
                                {SPREAD_COLS.map((c, i) => (
                                    <th
                                        key={c.key}
                                        title={c.title}
                                        // Frozen surfaces overlap SCROLLING content, so they
                                        // are fully OPAQUE — solid `bg-muted`, never glass.
                                        className={cn(
                                            'border-b border-border bg-muted px-2 py-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground',
                                            c.numeric ? 'text-right' : 'text-left',
                                            c.frozen
                                                ? i === FROZEN_LEFT.length - 1
                                                    ? 'frozen-corner frozen-edge'
                                                    : 'frozen-corner'
                                                : 'frozen-row',
                                        )}
                                        style={c.frozen ? { left: FROZEN_LEFT[i] } : undefined}
                                    >
                                        {c.label}
                                    </th>
                                ))}
                            </tr>
                        </thead>
                        <tbody>
                            {lines.map((line) => (
                                <SpreadRow
                                    key={line.deliveryId}
                                    line={line}
                                    value={drafts[line.deliveryId] ?? ''}
                                    disabled={saving || !seeded}
                                    onChange={(text) => setDraft(line.deliveryId, text)}
                                />
                            ))}
                        </tbody>
                    </table>
                )}
            </div>

            <DialogFooter className="shrink-0 flex-wrap gap-2 border-t border-border bg-background/90 px-4 py-3 backdrop-blur-sm sm:justify-between">
                <p className="max-w-md text-[11px] leading-snug text-muted-foreground">
                    Saved as one block — nothing is half-applied. A receipt left blank has its
                    assignment <span className="font-medium text-foreground">released</span> back to this
                    payment, not destroyed, and it can be restored.
                </p>
                <div className="flex items-center gap-2">
                    <Button variant="outline" size="sm" onClick={() => onOpenChange(false)} disabled={saving}>
                        Cancel
                    </Button>
                    <Button size="sm" onClick={() => void handleSave()} disabled={saving || !payment}>
                        {saving ? <Loader2 className="size-3.5 animate-spin" /> : null}
                        {assignedCount === 0 ? 'Save — assign nothing' : `Assign across ${assignedCount}`}
                    </Button>
                </div>
            </DialogFooter>
        </>
    );
}

// ─── One receipt ────────────────────────────────────────────────────────────────

function SpreadRow({
    line,
    value,
    disabled,
    onChange,
}: {
    line: SpreadLine;
    value: string;
    disabled: boolean;
    onChange: (text: string) => void;
}) {
    const s = line.settlement;
    const status = settlementStatus(s.settlement_status);
    const owed = stillOwedText(s);
    const allocatable = s.is_allocatable === true;

    // Row rules live on the CELLS. A border on a `<tr>` is never painted in the
    // separated-borders model this table uses, so a `<tr>` border would silently do
    // nothing. Every row tint is a SOLID token: `cn()` resolves two `bg-*` utilities to the
    // LAST one, so a translucent tint listed after an opaque frozen base REPLACES it and
    // the sticky cell goes see-through.
    const cell = 'border-b border-border px-2 py-1 align-middle transition-all duration-150';
    const numCell = cn(cell, 'text-right font-mono tabular-nums');

    return (
        <tr className="group h-8 hover:bg-muted/50">
            {/* DATE — frozen. Opaque base FIRST, hover tint as a variant so it layers. */}
            <td
                className={cn('frozen-col bg-background group-hover:bg-muted/50', cell, 'font-mono')}
                style={{ left: FROZEN_LEFT[0] }}
            >
                {formatDate(s.delivery_date)}
            </td>
            <td
                className={cn(
                    'frozen-col frozen-edge bg-background group-hover:bg-muted/50',
                    cell,
                    'truncate font-mono',
                )}
                style={{ left: FROZEN_LEFT[1] }}
                title={s.truck_no ?? ''}
            >
                {s.truck_no ?? '—'}
            </td>

            {/* TRADER — and the sub-supplier label §7a asked for by name. Without it a
                child's receipt in the parent's list looks like a mistake. */}
            <td className={cn(cell, 'truncate')} title={s.supplier_display_name ?? s.supplier_code ?? ''}>
                <span className="truncate">{s.supplier_display_name ?? s.supplier_code ?? '—'}</span>
                {line.isSubgroup ? (
                    <span
                        className="ml-1 rounded-sm border border-dashed border-border px-1 text-[9px] leading-tight text-muted-foreground"
                        title={`This receipt is ${
                            s.supplier_display_name ?? s.supplier_code
                        }'s, and this cheque is made out to the parent trader. The assignment is legal because they are in the same group.`}
                    >
                        sub
                    </span>
                ) : null}
            </td>

            {/* RECEIPT value — a stored generated column, never recomputed here. */}
            <td className={numCell}>
                <span className="flex items-baseline justify-between gap-2">
                    <span className="text-muted-foreground">₱</span>
                    <span>{formatPeso(s.total_price_php)}</span>
                </span>
                {num(s.net_weight_kg) !== null ? (
                    <span className="block text-right text-[10px] leading-none text-muted-foreground">
                        {formatKg(s.net_weight_kg)} kg
                    </span>
                ) : null}
            </td>

            {/* ALREADY PAID — from every payment, this one included. */}
            <td className={numCell}>
                {num(s.allocated_php) ? (
                    <>
                        <span className="flex items-baseline justify-between gap-2">
                            <span className="text-muted-foreground">₱</span>
                            <span>{formatPeso(s.allocated_php)}</span>
                        </span>
                        {(num(s.allocation_count) ?? 0) > 1 ? (
                            <span className="block text-right text-[10px] leading-none text-muted-foreground">
                                {formatCount(s.allocation_count)} payments
                            </span>
                        ) : null}
                    </>
                ) : (
                    <span className="text-muted-foreground/50">—</span>
                )}
            </td>

            {/* STILL OWED — and the §3.4 rule, rendered.
                `balance_php` is NULL, not 0, on an unpriceable receipt, because the honest
                answer to "how much is still owed" is *nobody knows yet*. ₱0.00 here would
                be a claim that nothing is owed, and it would be indistinguishable from the
                truth. */}
            <td className={numCell}>
                {'peso' in owed ? (
                    <span className="flex items-baseline justify-between gap-2">
                        <span className="text-muted-foreground">₱</span>
                        <span>{formatPeso(owed.peso)}</span>
                    </span>
                ) : (
                    <span
                        className="block text-right text-[10px] font-normal leading-tight text-amber-600 dark:text-amber-400"
                        title={SETTLEMENT_NOTE.unpriced}
                    >
                        {NOT_PRICED_TEXT}
                    </span>
                )}
            </td>

            {/* ASSIGN — the one editable cell, and deliberately a separate column from
                STILL OWED so a proposal never looks like a fact. */}
            <td className={cn(cell, 'text-right')}>
                <div className="flex h-6 items-center gap-1 rounded-sm border border-input bg-transparent pl-1.5 focus-within:border-ring focus-within:ring-[2px] focus-within:ring-ring/50">
                    <span className="shrink-0 text-[10px] text-muted-foreground">₱</span>
                    <Input
                        type="number"
                        inputMode="decimal"
                        // The DB refuses a zero or negative edge and says to leave the
                        // receipt out instead — which is exactly what an empty box does.
                        min="0"
                        step="any"
                        value={value}
                        disabled={disabled}
                        onChange={(e) => onChange(e.target.value)}
                        placeholder={allocatable ? '0.00' : 'by hand'}
                        aria-label={`Assign to the ${receiptLabel(s)} receipt`}
                        title={
                            allocatable
                                ? 'How much of this payment to put against this receipt. Clear the box to release it.'
                                : 'This receipt has no price yet, so it is never filled automatically. You can still assign to it deliberately — a downpayment on a truck weighed tomorrow is ordinary.'
                        }
                        className="h-5 border-0 bg-transparent p-0 pr-1.5 text-right font-mono text-xs tabular-nums shadow-none focus-visible:border-0 focus-visible:ring-0"
                    />
                </div>
            </td>

            {/* STATE — a word, not a colour. `over` and a remainder are both legal. */}
            <td className={cell} title={SETTLEMENT_NOTE[status]}>
                <span
                    className={cn(
                        'inline-flex items-center rounded-sm border px-1 py-px text-[10px] leading-tight',
                        // The only emphasis is on `unpriced`, which is the one state that
                        // hides an unknown. `over_allocated` is deliberately NOT red — it is
                        // recorded on purpose (decision 13).
                        status === 'unpriced'
                            ? 'border-amber-500/40 text-amber-600 dark:text-amber-400'
                            : 'border-border text-muted-foreground',
                    )}
                >
                    {SETTLEMENT_LABEL[status]}
                </span>
            </td>
        </tr>
    );
}
