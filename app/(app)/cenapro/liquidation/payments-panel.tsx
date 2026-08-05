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
import { Loader2, Plus, RotateCcw, Trash2 } from 'lucide-react';

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
import {
    formatDate,
    formatPeso,
    methodShort,
    num,
    termLabel,
    type BankAccountRow,
    type PaymentRow,
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
    { key: 'term', label: 'TERM', width: 96 },
    { key: 'remarks', label: 'REMARKS', width: 200 },
    { key: 'actions', label: '', width: 84 },
] as const;

const MIN_W = COLS.reduce((s, c) => s + c.width, 0);

export interface PaymentsPanelProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    /** `null` while the sheet is closing — the body is keyed on it, so it never flickers. */
    supplierCode: string | null;
    supplierName: string;
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
                    payments while the fetch is in flight — the loading state is remounted. */}
                <PanelBody key={props.supplierCode ?? 'none'} {...props} />
            </SheetContent>
        </Sheet>
    );
}

interface BodyState {
    loading: boolean;
    payments: PaymentRow[];
    error: string | null;
}

const IDLE: BodyState = { loading: false, payments: [], error: null };

function PanelBody({
    supplierCode,
    supplierName,
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
    const [editing, setEditing] = useState<PaymentRow | null>(null);
    const [voiding, setVoiding] = useState<PaymentRow | null>(null);
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

    function handleVoid(row: PaymentRow) {
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

    function handleRestore(row: PaymentRow) {
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

    return (
        <>
            <div className="flex shrink-0 items-center justify-between gap-2 border-b border-border px-4 py-2">
                <p className="text-xs text-muted-foreground">
                    {state.loading
                        ? 'Loading…'
                        : `${live.length} payment${live.length === 1 ? '' : 's'}${
                              voided.length > 0 ? ` · ${voided.length} voided` : ''
                          }`}
                </p>
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
                                {state.payments.map((p) => (
                                    <PaymentRowCells
                                        key={p.id ?? ''}
                                        row={p}
                                        busy={pending}
                                        onEdit={() => {
                                            setEditing(p);
                                            setDialogOpen(true);
                                        }}
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
    onVoid,
    onRestore,
}: {
    row: PaymentRow;
    busy: boolean;
    onEdit: () => void;
    onVoid: () => void;
    onRestore: () => void;
}) {
    const deleted = row.is_deleted === true;
    const effect = num(row.balance_effect_php);
    const incoming = row.direction === 'incoming';
    const remarks = (row.remarks ?? '').trim();

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
            <td className={cn(cell, 'text-muted-foreground')}>{termLabel(row.stated_term) || '—'}</td>
            <td className={cn(cell, 'max-w-[200px] truncate')} title={remarks}>
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
