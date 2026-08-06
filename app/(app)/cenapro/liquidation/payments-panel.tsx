'use client';

// ─────────────────────────────────────────────────────────────────────────────────
// ONE TRADER'S PAYMENTS — the list that makes a recorded payment something other than
// write-only.
//
// Without it, "record a payment" is a form that swallows money: the balance moves and
// nothing on the screen can say which cheque moved it, let alone amend or un-void one.
//
// ── VOIDED PAYMENTS ARE SHOWN, NOT HIDDEN ────────────────────────────────────────
// A payment is SOFT-deleted (§5c: it is a money record, not transcribed reference data),
// and §5c asked for reverting to be robust throughout this feature. A voided cheque that
// disappears from the screen is not recoverable in any sense an operator can act on —
// they cannot restore what they cannot see. So it stays in the list, struck through and
// labelled, with the restore beside it. Every BALANCE still excludes it, because the view
// does; this list is the one place the exclusion is visible rather than silent.
//
// ── THE AMOUNT SHOWN IS THE SIGNED EFFECT ────────────────────────────────────────
// `balance_effect_php` (+ outgoing, − incoming) is defined ONCE, in `view_rc_payment`,
// and the balance aggregates that same view. Rendering `amount_php` here instead would
// let the row list and the balance disagree about what a refund does — the exact failure
// the view's single definition exists to prevent. The face value is still reachable: it
// is the unsigned figure, and the direction is spelled out beside it.
// ─────────────────────────────────────────────────────────────────────────────────

import { useCallback, useEffect, useState, useTransition } from 'react';
import { Loader2, Plus, RotateCcw, SplitSquareHorizontal, Trash2, Wallet } from 'lucide-react';

import {
    AlertDialog,
    AlertDialogAction,
    AlertDialogCancel,
    AlertDialogContent,
    AlertDialogDescription,
    AlertDialogFooter,
    AlertDialogHeader,
    AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import {
    Sheet,
    SheetContent,
    SheetDescription,
    SheetHeader,
    SheetTitle,
} from '@/components/ui/sheet';
import { errorToast } from '@/lib/toast';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';

import { deletePayment, fetchSupplierPayments, restorePayment } from './actions';
import { PaymentDialog } from './payment-dialog';
import { SpreadPanel } from './spread-panel';
import {
    formatDate,
    formatPeso,
    methodShort,
    num,
    termLabel,
    type BankAccountRow,
    type PaymentStateRow,
    type SupplierGroupRow,
} from './types';

/**
 * Explicit pixel widths whose SUM is the table's min-width — the wrapper scrolls rather
 * than letting a column crush. No `1fr`, no unset column absorbing slack.
 */
const COLS = [
    { key: 'date', label: 'DATE', width: 92 },
    { key: 'method', label: 'METHOD', width: 96 },
    { key: 'ref', label: 'CHEQUE / REF', width: 118 },
    { key: 'bank', label: 'DRAWN ON', width: 150 },
    { key: 'amount', label: 'AMOUNT', width: 146, numeric: true },
    // Step 4: what has been pointed at receipts, and what has not. `unallocated_php` on a
    // live outgoing payment IS the outstanding cash advance (§4.4) — which is why Step 5
    // needs no screen of its own, only this column and a filter.
    { key: 'assigned', label: 'ASSIGNED', width: 138, numeric: true },
    { key: 'term', label: 'TERM', width: 96 },
    { key: 'remarks', label: 'REMARKS', width: 180 },
    { key: 'actions', label: '', width: 148 },
] as const;

const MIN_W = COLS.reduce((s, c) => s + c.width, 0);

export interface PaymentsPanelProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    /** `null` while the sheet is closing — the body is keyed on it, so it never flickers. */
    supplierCode: string | null;
    supplierName: string;
    /**
     * Open with the "money left" filter already on — the drill-down from the balance
     * screen's NOT YET ASSIGNED cell. It seeds local state rather than driving it, so the
     * operator can turn it off without going back.
     */
    initialAdvanceOnly?: boolean;
    suppliers: SupplierGroupRow[];
    accounts: BankAccountRow[];
    /** Called after any write, so the balance table behind the sheet can re-read. */
    onChanged: () => void;
}

export function PaymentsPanel(props: PaymentsPanelProps) {
    return (
        <Sheet open={props.open} onOpenChange={props.onOpenChange}>
            <SheetContent
                side="right"
                className="flex w-full flex-col gap-0 p-0 sm:max-w-3xl"
            >
                <SheetHeader className="shrink-0 border-b border-border px-4 py-3">
                    <SheetTitle className="text-base">Payments to {props.supplierName}</SheetTitle>
                    <SheetDescription>
                        Every cheque, transfer and write-off made out to this trader. A payment reduces
                        the balance without being assigned to particular receipts.
                    </SheetDescription>
                </SheetHeader>

                {/* Keyed on the trader so opening a SECOND one never shows the first one's
                    payments while the fetch is in flight — the loading state is remounted.
                    The advance flag is part of the key because it SEEDS local state: without
                    it, drilling into the same trader's advances right after opening their
                    full list would leave the filter off, and the drill-down would silently
                    do nothing. */}
                <PanelBody
                    key={`${props.supplierCode ?? 'none'}:${props.initialAdvanceOnly ? 'adv' : 'all'}`}
                    {...props}
                />
            </SheetContent>
        </Sheet>
    );
}

interface BodyState {
    loading: boolean;
    payments: PaymentStateRow[];
    error: string | null;
}

const IDLE: BodyState = { loading: false, payments: [], error: null };

function PanelBody({
    supplierCode,
    supplierName,
    initialAdvanceOnly = false,
    suppliers,
    accounts,
    onChanged,
}: PaymentsPanelProps) {
    const [state, setState] = useState<BodyState>(() =>
        supplierCode ? { ...IDLE, loading: true } : IDLE,
    );
    /**
     * Bumped after every write to re-run the read effect. A counter rather than a
     * `load()` the effect calls, because setState must never run SYNCHRONOUSLY in an
     * effect body — it cascades renders. Every setState below happens inside a `.then`.
     */
    const [reloadToken, setReloadToken] = useState(0);
    const [dialogOpen, setDialogOpen] = useState(false);
    const [editing, setEditing] = useState<PaymentStateRow | null>(null);
    const [voiding, setVoiding] = useState<PaymentStateRow | null>(null);
    /** The cheque being spread across receipts (Step 4). `null` when the screen is closed. */
    const [spreading, setSpreading] = useState<string | null>(null);
    /**
     * `WHERE is_advance` — Step 5's entire feature.
     *
     * §4.4: a cash advance IS a payment whose allocations sum to less than its amount, so
     * "the list of payments carrying an unallocated remainder" is a FILTER on this list,
     * not a screen of its own. Off by default: an advance is an ordinary state, not a
     * worklist.
     */
    const [advanceOnly, setAdvanceOnly] = useState(initialAdvanceOnly);
    const [pending, startTransition] = useTransition();

    useEffect(() => {
        // No setState on this branch: the panel body is KEYED on the trader, so the
        // initializer above has already put it in the right state.
        if (!supplierCode) return;

        let cancelled = false;
        fetchSupplierPayments(supplierCode)
            .then((res) => {
                if (cancelled) return;
                setState({ loading: false, payments: res.payments, error: res.error });
                if (res.error) {
                    errorToast('Could not load this trader’s payments', { description: res.error });
                }
            })
            .catch((err: unknown) => {
                if (cancelled) return;
                setState({
                    loading: false,
                    payments: [],
                    error: err instanceof Error ? err.message : String(err),
                });
            });
        return () => {
            cancelled = true;
        };
        // `reloadToken` is the refetch trigger; it is deliberately part of the key set.
    }, [supplierCode, reloadToken]);

    // A refetch deliberately leaves `loading` false, so an edit does not blank the list
    // it was made from — the rows simply update underneath.
    const afterWrite = useCallback(() => {
        setReloadToken((n) => n + 1);
        onChanged();
    }, [onChanged]);

    function handleVoid(row: PaymentStateRow) {
        if (!row.id || row.row_version === null || row.row_version === undefined) return;
        const id = row.id;
        const version = row.row_version;
        startTransition(async () => {
            const result = await deletePayment(id, version);
            if (!result.ok) {
                errorToast('The payment was not voided', {
                    description: result.message ?? `The database refused the write (${result.outcome}).`,
                });
                return;
            }
            toast.success('Payment voided — it can be restored from this list.');
            setVoiding(null);
            afterWrite();
        });
    }

    function handleRestore(row: PaymentStateRow) {
        if (!row.id || row.row_version === null || row.row_version === undefined) return;
        const id = row.id;
        const version = row.row_version;
        startTransition(async () => {
            const result = await restorePayment(id, version);
            if (!result.ok) {
                errorToast('The payment was not restored', {
                    description: result.message ?? `The database refused the write (${result.outcome}).`,
                });
                return;
            }
            toast.success('Payment restored');
            afterWrite();
        });
    }

    const live = state.payments.filter((p) => !p.is_deleted);
    const voided = state.payments.filter((p) => p.is_deleted);
    /** Live outgoing payments with money nobody has pointed at a receipt yet. */
    const advances = live.filter((p) => p.is_advance === true);
    const shown = advanceOnly ? advances : state.payments;

    return (
        <>
            <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-2">
                <p className="text-xs text-muted-foreground">
                    {state.loading
                        ? 'Loading…'
                        : `${live.length} payment${live.length === 1 ? '' : 's'}${
                              voided.length > 0 ? ` · ${voided.length} voided` : ''
                          }`}
                </p>
                <div className="flex items-center gap-1.5">
                    {/* Step 5, in one control. An advance is a payment with an unassigned
                        remainder — nothing more — so this is a filter rather than a
                        feature. It appears only when there is something to filter TO. */}
                    {advances.length > 0 && (
                        <Button
                            variant={advanceOnly ? 'default' : 'outline'}
                            size="sm"
                            aria-pressed={advanceOnly}
                            className="h-7 text-[11px]"
                            onClick={() => setAdvanceOnly((v) => !v)}
                            title="Show only the payments that still have money nobody has pointed at a receipt. That unassigned remainder IS the outstanding cash advance — it is a normal state, not a problem."
                        >
                            <Wallet className="size-3" />
                            {advances.length} with money left
                        </Button>
                    )}
                    <Button
                        size="sm"
                        className="h-7 text-xs"
                        onClick={() => {
                            setEditing(null);
                            setDialogOpen(true);
                        }}
                        disabled={!supplierCode}
                    >
                        <Plus className="size-3.5" />
                        Record a payment
                    </Button>
                </div>
            </div>

            <div className="min-h-0 flex-1 overflow-auto">
                {state.loading ? (
                    <div className="flex items-center justify-center gap-2 p-8 text-xs text-muted-foreground">
                        <Loader2 className="size-3.5 animate-spin" />
                        Loading payments…
                    </div>
                ) : state.error ? (
                    <InlineError message={state.error} />
                ) : state.payments.length === 0 ? (
                    <div className="animate-fade-up p-8 text-center">
                        <p className="text-sm font-medium">No payments recorded yet</p>
                        <p className="mx-auto mt-1 max-w-sm text-xs text-muted-foreground">
                            Nothing has been paid to {supplierName} through this system. Everything owed for
                            their receipts is still showing on the balance.
                        </p>
                    </div>
                ) : shown.length === 0 ? (
                    // The filter is on and matches nothing. Say which filter, and offer the
                    // way back — an empty table under an active filter reads as lost data.
                    <div className="animate-fade-up p-8 text-center">
                        <p className="text-sm font-medium">Every payment is fully assigned</p>
                        <p className="mx-auto mt-1 max-w-sm text-xs text-muted-foreground">
                            None of {supplierName}&rsquo;s payments has money left over, so there is no
                            outstanding advance.
                        </p>
                        <Button
                            variant="outline"
                            size="sm"
                            className="mt-3 h-7 text-[11px]"
                            onClick={() => setAdvanceOnly(false)}
                        >
                            Show all payments
                        </Button>
                    </div>
                ) : (
                    <div className="overflow-x-auto">
                        {/* `separate` + `border-spacing: 0`, never `border-collapse`. This
                            table has no frozen COLUMN, but its header row is sticky
                            (`.frozen-row`), and the collapsed-border model is exactly as
                            unreliable for a sticky row's background as for a sticky
                            column's — rows would show through the header as they scroll
                            under it. Same rule, same fix, one idiom across the module. */}
                        <table
                            className="w-full table-fixed text-xs"
                            style={{ minWidth: MIN_W, borderCollapse: 'separate', borderSpacing: 0 }}
                        >
                            <colgroup>
                                {COLS.map((c) => (
                                    <col key={c.key} style={{ width: c.width }} />
                                ))}
                            </colgroup>
                            <thead>
                                <tr>
                                    {COLS.map((c) => (
                                        <th
                                            key={c.key}
                                            className={cn(
                                                'frozen-row border-b border-border bg-muted px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground',
                                                'numeric' in c && c.numeric ? 'text-right' : 'text-left',
                                            )}
                                        >
                                            {c.label}
                                        </th>
                                    ))}
                                </tr>
                            </thead>
                            <tbody>
                                {shown.map((p) => (
                                    <PaymentRowCells
                                        key={p.id ?? ''}
                                        row={p}
                                        busy={pending}
                                        onEdit={() => {
                                            setEditing(p);
                                            setDialogOpen(true);
                                        }}
                                        onSpread={() => p.id && setSpreading(p.id)}
                                        onVoid={() => setVoiding(p)}
                                        onRestore={() => handleRestore(p)}
                                    />
                                ))}
                            </tbody>
                        </table>
                    </div>
                )}
            </div>

            <PaymentDialog
                open={dialogOpen}
                onOpenChange={setDialogOpen}
                supplierCode={supplierCode ?? ''}
                suppliers={suppliers}
                accounts={accounts}
                editing={editing}
                onSaved={afterWrite}
            />

            {/* The cheque-first door onto the shared allocation surface (§7a screen 3).
                Opened from a payment row, so the operator is already looking at the cheque
                they mean to spread. */}
            <SpreadPanel
                open={spreading !== null}
                onOpenChange={(o) => !o && setSpreading(null)}
                paymentId={spreading}
                onSaved={afterWrite}
            />

            <AlertDialog open={voiding !== null} onOpenChange={(o) => !o && setVoiding(null)}>
                <AlertDialogContent className="animate-modal-enter">
                    <AlertDialogHeader>
                        <AlertDialogTitle>Void this payment?</AlertDialogTitle>
                        <AlertDialogDescription>
                            {voiding
                                ? `${methodShort(voiding.method)} of ₱${formatPeso(voiding.amount_php)} dated ${formatDate(
                                      voiding.payment_date,
                                  )}. It comes straight out of ${supplierName}'s balance.`
                                : ''}{' '}
                            The record is kept, not erased — it stays in this list, struck through, and can be
                            restored.
                        </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                        <AlertDialogCancel disabled={pending}>Keep it</AlertDialogCancel>
                        <AlertDialogAction
                            onClick={(e) => {
                                // The dialog would close on its own; the write has to finish first
                                // so a refusal is still on screen when the toast lands.
                                e.preventDefault();
                                if (voiding) handleVoid(voiding);
                            }}
                            disabled={pending}
                        >
                            {pending ? <Loader2 className="size-3.5 animate-spin" /> : null}
                            Void it
                        </AlertDialogAction>
                    </AlertDialogFooter>
                </AlertDialogContent>
            </AlertDialog>
        </>
    );
}

// ─── One payment row ────────────────────────────────────────────────────────────

function PaymentRowCells({
    row,
    busy,
    onEdit,
    onSpread,
    onVoid,
    onRestore,
}: {
    row: PaymentStateRow;
    busy: boolean;
    onEdit: () => void;
    /** Open the spread screen on this cheque — the cheque-first allocation door. */
    onSpread: () => void;
    onVoid: () => void;
    onRestore: () => void;
}) {
    const deleted = row.is_deleted === true;
    const effect = num(row.balance_effect_php);
    const incoming = row.direction === 'incoming';
    const remarks = (row.remarks ?? '').trim();
    const allocated = num(row.allocated_php) ?? 0;
    const unallocated = num(row.unallocated_php) ?? 0;
    const allocCount = num(row.allocation_count) ?? 0;

    // Row rules go on the CELLS. A `<tr>` border is never painted in the separated
    // borders model this table uses, so it would silently do nothing.
    const cell = cn(
        'border-b border-border px-2 py-1 align-middle transition-all duration-150',
        deleted && 'text-muted-foreground line-through decoration-muted-foreground/60',
    );

    return (
        <tr className="group h-8 hover:bg-muted/50">
            <td className={cn(cell, 'font-mono')}>{formatDate(row.payment_date)}</td>
            <td className={cell}>
                <span>{methodShort(row.method)}</span>
                {row.method === 'adjustment' ? (
                    <span className="ml-1 text-[10px] text-muted-foreground no-underline">no cash</span>
                ) : null}
            </td>
            <td className={cn(cell, 'truncate font-mono')} title={row.cheque_no ?? row.reference_no ?? ''}>
                {row.cheque_no ?? row.reference_no ?? '—'}
            </td>
            <td className={cn(cell, 'truncate')} title={row.bank_account_label ?? ''}>
                {row.bank_display_name ? (
                    <>
                        <span>{row.bank_display_name}</span>
                        {row.account_label ? (
                            <span className="ml-1 text-[10px] text-muted-foreground">{row.account_label}</span>
                        ) : null}
                    </>
                ) : (
                    '—'
                )}
            </td>
            <td className={cell}>
                {/* Accounting format: ₱ pinned left, the figure pinned right. */}
                <span className="flex items-baseline justify-between gap-2 font-mono tabular-nums">
                    <span className="text-muted-foreground">₱</span>
                    <span>{effect === null ? '' : formatPeso(effect)}</span>
                </span>
                {incoming ? (
                    <span className="block text-right text-[10px] leading-none text-muted-foreground no-underline">
                        came back
                    </span>
                ) : null}
            </td>
            {/* ASSIGNED — how much of this payment is pointed at receipts, and how much
                is not. The remainder on a live outgoing payment IS the outstanding cash
                advance (§4.4), which is why it is stated plainly rather than flagged: an
                advance is a normal state of a cheque, not an exception. */}
            <td className={cell}>
                <span className="flex items-baseline justify-between gap-2 font-mono tabular-nums">
                    <span className="text-muted-foreground">₱</span>
                    <span>{formatPeso(allocated)}</span>
                </span>
                <span
                    className="block text-right text-[10px] leading-none text-muted-foreground no-underline"
                    title={
                        row.method === 'adjustment'
                            ? 'A write-off can be pointed at particular receipts too — it moves the balance without cash leaving the bank.'
                            : unallocated > 0
                              ? 'Money on this payment that nobody has pointed at a receipt yet. That is an outstanding advance — perfectly normal, and it needs no action.'
                              : 'Every peso of this payment is assigned to a receipt.'
                    }
                >
                    {unallocated > 0
                        ? `₱${formatPeso(unallocated)} left`
                        : allocCount > 0
                          ? `across ${allocCount}`
                          : 'none assigned'}
                </span>
            </td>
            <td className={cn(cell, 'text-muted-foreground')}>{termLabel(row.stated_term) || '—'}</td>
            <td className={cn(cell, 'max-w-[180px] truncate')} title={remarks}>
                {remarks || '—'}
            </td>
            <td className={cn(cell, 'text-right')}>
                {deleted ? (
                    <Button
                        variant="ghost"
                        size="sm"
                        className="h-6 px-1.5 text-[11px] no-underline"
                        onClick={onRestore}
                        disabled={busy}
                        title="Restore this payment"
                    >
                        <RotateCcw className="size-3" />
                        Restore
                    </Button>
                ) : (
                    <div className="flex items-center justify-end gap-0.5">
                        {/* The cheque-first door. Primary among the row's actions because
                            spreading a cheque across receipts is the job; editing it is the
                            correction. */}
                        <Button
                            variant="outline"
                            size="sm"
                            className="h-6 px-1.5 text-[11px]"
                            onClick={onSpread}
                            disabled={busy}
                            title="Choose which receipts this payment settles. The whole block saves in one go — nothing is half-applied."
                        >
                            <SplitSquareHorizontal className="size-3" />
                            Assign
                        </Button>
                        <Button
                            variant="ghost"
                            size="sm"
                            className="h-6 px-1.5 text-[11px]"
                            onClick={onEdit}
                            disabled={busy}
                        >
                            Edit
                        </Button>
                        <Button
                            variant="ghost"
                            size="sm"
                            className="h-6 w-6 p-0 text-muted-foreground hover:text-destructive"
                            onClick={onVoid}
                            disabled={busy}
                            title="Void this payment"
                        >
                            <Trash2 className="size-3" />
                            <span className="sr-only">Void this payment</span>
                        </Button>
                    </div>
                )}
            </td>
        </tr>
    );
}

/**
 * An inline error carries its own Copy button, exactly as `errorToast` does — the rule is
 * about every error surface, not only toasts.
 */
export function InlineError({ message }: { message: string }) {
    return (
        <div className="m-4 rounded-md border border-destructive/40 bg-destructive/5 p-3">
            <div className="flex items-start justify-between gap-3">
                <p className="text-xs leading-snug text-destructive">{message}</p>
                <Button
                    variant="outline"
                    size="sm"
                    className="h-6 shrink-0 px-2 text-[11px]"
                    onClick={() => {
                        void navigator.clipboard.writeText(message).then(() => {
                            toast.success('Error copied to clipboard', { duration: 2000 });
                        });
                    }}
                >
                    Copy
                </Button>
            </div>
        </div>
    );
}
