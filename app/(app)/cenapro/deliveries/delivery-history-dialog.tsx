'use client';

// ─────────────────────────────────────────────────────────────────────────────────
// RC Deliveries — one receipt's change history.
//
// Opened from the grid's row context menu ("View history"). Reads the trigger-written
// trail `public.cenapro_rc_delivery_audit` through `getDeliveryHistory`, newest first,
// with the receipt AND its moisture draws in one list — they share a `delivery_id`, and
// the question an operator actually asks is "what has happened to THIS receipt".
//
// THREE things this component deliberately does NOT do:
//
//   1. **It does not gate prices.** `getDeliveryHistory` deletes the ₱ keys out of the
//      jsonb SERVER-SIDE, before the payload returns, because the network response is
//      the leak. What arrives here is already redacted; `redactedChanges` is the only
//      thing left to say, and it says it without a figure.
//   2. **It does not reach into ICTC.** `inventory/rc-in/components/DeliveryHistoryDialog`
//      is the shape this is modelled on and NOTHING is imported from it: that component
//      is bound to `public.audit_logs` + `audit_comments` + notifications + resolve
//      requests, none of which exist for Cenapro, and the tenant wall forbids the
//      coupling anyway. The reading experience is copied; the wiring is not.
//   3. **It does not animate the list.** The dialog gets the project's `animate-modal-enter`
//      and nothing inside it moves — entries are data, and a history that fades in one
//      row at a time is chrome pretending to be information.
// ─────────────────────────────────────────────────────────────────────────────────

import * as React from 'react';
import { format, formatDistanceToNow, isValid, parseISO } from 'date-fns';
import {
    AlertTriangle,
    ArrowRight,
    Copy,
    Droplets,
    FilePlus2,
    History,
    Loader2,
    Lock,
    PencilLine,
    Trash2,
} from 'lucide-react';
import { toast } from 'sonner';

import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { errorToast } from '@/lib/toast';
import { cn } from '@/lib/utils';

import { getDeliveryHistory } from './actions';
import {
    AUDIT_SAMPLE_SUMMARY_COLUMNS,
    AUDIT_SUMMARY_COLUMNS,
    AUDIT_TRAIL_START,
    auditColumnLabel,
    auditHeadline,
    auditSnapshotColumns,
    formatAuditValue,
    type AuditFieldChange,
    type AuditOperation,
    type AuditValueText,
    type DeliveryHistoryEntry,
} from './types';

export interface DeliveryHistoryDialogProps {
    /** The receipt whose trail to read. `null` renders the dialog inert. */
    deliveryId: string | null;
    /** The receipt's identity line (date · truck · supplier), for the header. */
    label: string;
    open: boolean;
    onOpenChange: (open: boolean) => void;
    /**
     * Called where Radix would restore focus. Radix aims focus back at the TRIGGER, and
     * this dialog's trigger is a context-menu item that has already unmounted — so focus
     * lands on `<body>` and the operator's next keystroke goes nowhere. The ledger hands
     * it back to the grid's paste sink instead, always with `preventScroll` (a bare
     * `focus()` scrolls every ancestor with block AND inline "center" — see
     * `focusNoScroll` in `lib/utils.ts`).
     */
    onClosed?: () => void;
}

export function DeliveryHistoryDialog({
    deliveryId,
    label,
    open,
    onOpenChange,
    onClosed,
}: DeliveryHistoryDialogProps) {
    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent
                className="animate-modal-enter flex max-h-[85dvh] w-[calc(100%-2rem)] max-w-2xl flex-col gap-0 overflow-hidden p-0 sm:max-w-2xl"
                onCloseAutoFocus={(e) => {
                    if (!onClosed) return;
                    e.preventDefault();
                    onClosed();
                }}
            >
                {/* `pr-12` clears `DialogContent`'s own absolutely-positioned close X. */}
                <DialogHeader className="shrink-0 border-b border-border px-4 py-3 pr-12">
                    <DialogTitle className="flex items-center gap-2 text-base">
                        <History className="size-4 shrink-0" />
                        Receipt history
                    </DialogTitle>
                    <DialogDescription className="truncate font-mono text-xs" title={label}>
                        {label}
                    </DialogDescription>
                </DialogHeader>

                {/*
                    Keyed on the receipt so opening a SECOND one never shows the first
                    one's entries while the fetch is in flight — the whole loading state
                    is remounted rather than derived. Same reasoning as the ICTC dialog's
                    key, reached independently.
                */}
                <HistoryBody key={deliveryId ?? 'none'} deliveryId={deliveryId} />
            </DialogContent>
        </Dialog>
    );
}

// ═══ The body ═══════════════════════════════════════════════════════════════════

interface BodyState {
    loading: boolean;
    entries: DeliveryHistoryEntry[];
    notice: string | null;
    error: string | null;
}

const IDLE: BodyState = { loading: false, entries: [], notice: null, error: null };

function HistoryBody({ deliveryId }: { deliveryId: string | null }) {
    const [state, setState] = React.useState<BodyState>(
        deliveryId ? { ...IDLE, loading: true } : IDLE,
    );

    React.useEffect(() => {
        if (!deliveryId) {
            setState(IDLE);
            return;
        }
        let cancelled = false;
        getDeliveryHistory(deliveryId)
            .then((res) => {
                if (cancelled) return;
                setState({
                    loading: false,
                    entries: res.entries,
                    notice: res.notice ?? null,
                    error: res.error ?? null,
                });
            })
            .catch((err: unknown) => {
                if (cancelled) return;
                setState({
                    loading: false,
                    entries: [],
                    notice: null,
                    error: err instanceof Error ? err.message : String(err),
                });
            });
        return () => {
            cancelled = true;
        };
    }, [deliveryId]);

    // One edit to a moisture block is a DELETE + INSERT per draw (the samples RPC
    // replaces the whole block), so a burst of draw entries at one timestamp is normal
    // and is explained rather than left to look like a mystery.
    const hasSampleEntries = state.entries.some((e) => e.entity === 'sample');

    return (
        <div className="min-h-0 flex-1 overflow-y-auto">
            {state.error !== null && <ErrorBanner message={state.error} />}

            {state.loading ? (
                <div className="flex flex-col items-center justify-center gap-2 py-12">
                    <Loader2 className="size-5 animate-spin text-muted-foreground" />
                    <p className="text-xs text-muted-foreground">Loading this receipt&apos;s history…</p>
                </div>
            ) : state.entries.length === 0 && state.error === null ? (
                <EmptyHistory />
            ) : (
                <>
                    {state.notice !== null && (
                        <p className="border-b border-border/60 bg-muted/40 px-4 py-2 text-[11px] text-muted-foreground">
                            {state.notice}
                        </p>
                    )}
                    <div className="divide-y divide-border/50">
                        {state.entries.map((entry) => (
                            <HistoryEntryRow key={entry.key} entry={entry} />
                        ))}
                    </div>
                    <div className="space-y-1 border-t border-border/60 px-4 py-3 text-[11px] text-muted-foreground">
                        <p>
                            The trail starts {AUDIT_TRAIL_START}. Anything before that date was never
                            recorded.
                        </p>
                        {hasSampleEntries && (
                            <p>
                                Saving moisture draws replaces the whole block, so one edit can appear
                                here as several draw entries at the same moment.
                            </p>
                        )}
                    </div>
                </>
            )}
        </div>
    );
}

/**
 * The common case for a while — and it must say WHY it is empty. "No history" on its own
 * reads as "nobody has ever touched this receipt", which for anything older than
 * 2026-08-05 is a claim the database cannot make.
 */
function EmptyHistory() {
    return (
        <div className="px-6 py-12 text-center">
            <History className="mx-auto size-6 text-muted-foreground/40" />
            <p className="mt-3 text-sm font-medium">No changes recorded since {AUDIT_TRAIL_START}</p>
            <p className="mx-auto mt-1.5 max-w-sm text-xs leading-relaxed text-muted-foreground">
                The audit trail for RC deliveries begins on {AUDIT_TRAIL_START}. Anything that
                happened to this receipt before then was never recorded — which is not the same as
                nothing having happened.
            </p>
        </div>
    );
}

/**
 * Inline error UI, per the project HARD RULE: it persists until the dialog is closed and
 * carries its own Copy button, so the operator can paste the failure somewhere useful
 * instead of screenshotting it.
 */
function ErrorBanner({ message }: { message: string }) {
    const copy = React.useCallback(() => {
        void navigator.clipboard
            .writeText(message)
            .then(() => toast.success('Error copied to clipboard', { duration: 2000 }))
            .catch((err: unknown) => {
                errorToast('The error text could not be copied to the clipboard.', {
                    description: `${err instanceof Error ? err.message : String(err)}\n\nThe browser refuses clipboard writes on an insecure origin (plain http) and when the page has lost focus.\n\nThe original error was:\n${message}`,
                });
            });
    }, [message]);

    return (
        <div className="m-4 rounded-md border border-destructive/40 bg-destructive/10 p-3">
            <div className="flex items-start gap-2">
                <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-destructive" />
                <p className="min-w-0 flex-1 break-words text-xs text-destructive">{message}</p>
                <Button
                    variant="ghost"
                    size="sm"
                    className="h-6 shrink-0 gap-1 px-2 text-[11px] text-destructive hover:bg-destructive/10 hover:text-destructive"
                    onClick={copy}
                >
                    <Copy className="size-3" />
                    Copy
                </Button>
            </div>
        </div>
    );
}

// ═══ One entry ══════════════════════════════════════════════════════════════════

const OPERATION_ICON: Record<AuditOperation, typeof PencilLine> = {
    INSERT: FilePlus2,
    UPDATE: PencilLine,
    DELETE: Trash2,
};

const OPERATION_TINT: Record<AuditOperation, string> = {
    INSERT: 'text-emerald-600 dark:text-emerald-400',
    UPDATE: 'text-sky-600 dark:text-sky-400',
    DELETE: 'text-destructive',
};

function HistoryEntryRow({ entry }: { entry: DeliveryHistoryEntry }) {
    const isSample = entry.entity === 'sample';
    // A draw entry is a DETAIL of the receipt's story, so it wears the moisture glyph
    // rather than the operation's — the operation is already in the headline, and a
    // `Trash2` beside "Moisture draw removed" reads as though the receipt were deleted.
    const Icon = isSample ? Droplets : OPERATION_ICON[entry.operation];
    const when = entry.changedAt ? parseISO(entry.changedAt) : null;
    const dated = when !== null && isValid(when);

    return (
        <div className={cn('flex gap-3 px-4 py-3', isSample && 'bg-muted/20 pl-8')}>
            <Icon
                className={cn(
                    'mt-0.5 size-4 shrink-0',
                    isSample ? 'text-muted-foreground' : OPERATION_TINT[entry.operation],
                )}
            />
            <div className="min-w-0 flex-1 space-y-1.5">
                <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                    <span className="text-xs font-medium">
                        {auditHeadline(entry.entity, entry.operation)}
                        {isSample && entry.samplePosition !== null && (
                            <span className="ml-1 font-mono text-[11px] text-muted-foreground">
                                #{entry.samplePosition}
                            </span>
                        )}
                    </span>
                    <span
                        className="ml-auto shrink-0 whitespace-nowrap text-[10px] text-muted-foreground"
                        title={dated ? format(when, 'yyyy-MM-dd HH:mm:ss') : entry.changedAt}
                    >
                        {dated ? formatDistanceToNow(when, { addSuffix: true }) : '—'}
                    </span>
                </div>

                <Actor entry={entry} />

                {entry.operation === 'UPDATE' ? (
                    entry.changes.length > 0 ? (
                        <div className="space-y-0.5 pt-0.5">
                            {entry.changes.map((c) => (
                                <DiffRow key={c.column} change={c} />
                            ))}
                        </div>
                    ) : entry.redactedChanges === 0 ? (
                        <p className="text-[11px] italic text-muted-foreground">No listed columns changed.</p>
                    ) : null
                ) : (
                    <SnapshotSummary entry={entry} />
                )}

                {entry.redactedChanges > 0 && (
                    <p className="flex items-center gap-1.5 pt-0.5 text-[11px] text-muted-foreground">
                        <Lock className="size-3 shrink-0" />
                        {entry.redactedChanges} price field{entry.redactedChanges === 1 ? '' : 's'} changed
                        — figures hidden by your role.
                    </p>
                )}
            </div>
        </div>
    );
}

/**
 * Who wrote it. A NULL `changed_by` is a service-role / importer / psql write and is
 * rendered as **system** — not as an empty name, which would read as a bug and hide the
 * one thing worth knowing about that row.
 */
function Actor({ entry }: { entry: DeliveryHistoryEntry }) {
    const parts: string[] = [];
    if (entry.actorRole !== null && entry.actorName === null) parts.push(entry.actorRole);
    if (entry.source !== null) parts.push(entry.source);

    return (
        <p className="text-[11px] text-muted-foreground">
            {entry.actorName === null ? (
                <span className="italic">system</span>
            ) : (
                <span className="font-medium text-foreground">{entry.actorName}</span>
            )}
            {parts.length > 0 && <span className="font-mono"> · {parts.join(' · ')}</span>}
        </p>
    );
}

function DiffRow({ change }: { change: AuditFieldChange }) {
    const from = formatAuditValue(change.column, change.from);
    const to = formatAuditValue(change.column, change.to);
    return (
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
            <span
                className="w-24 shrink-0 truncate text-[11px] font-medium text-muted-foreground"
                title={change.label}
            >
                {change.label}
            </span>
            <AuditValue value={from} tone="old" />
            <ArrowRight className="size-3 shrink-0 text-muted-foreground/70" />
            <AuditValue value={to} tone="new" />
        </div>
    );
}

/**
 * ₱ uses the project's accounting form — symbol pinned LEFT, figure pinned RIGHT — so a
 * column of totals in the diff lines up the way it does in the sheet.
 */
function AuditValue({ value, tone }: { value: AuditValueText; tone: 'old' | 'new' }) {
    const base = cn(
        'min-w-0 break-all text-xs',
        (value.numeric || value.peso) && 'font-mono tabular-nums',
        tone === 'old' ? 'text-muted-foreground line-through' : 'font-medium text-foreground',
        // An em dash with a strikethrough through it reads as a rendering fault. This
        // must stay AFTER the `line-through` above — tailwind-merge keeps the last of a
        // conflicting group, not the most specific.
        value.empty && 'font-normal text-muted-foreground/60 no-underline',
    );

    if (value.peso && !value.empty) {
        return (
            <span className={cn(base, 'inline-flex min-w-[7.5rem] justify-between gap-2')}>
                <span className="text-muted-foreground">&#8369;</span>
                <span>{value.text}</span>
            </span>
        );
    }
    return <span className={base}>{value.text}</span>;
}

/**
 * What a created or deleted row actually WAS. This is the whole reason the trail
 * denormalises and snapshots: the 22 receipts hard-deleted on 2026-08-04 took
 * ₱17,185,938.70 with them and left nothing behind. From now on a deletion still has its
 * numbers attached.
 */
function SnapshotSummary({ entry }: { entry: DeliveryHistoryEntry }) {
    const order =
        entry.entity === 'sample' ? AUDIT_SAMPLE_SUMMARY_COLUMNS : AUDIT_SUMMARY_COLUMNS;
    const columns = auditSnapshotColumns(entry.snapshot, order).filter((c) => {
        const v = entry.snapshot?.[c];
        return v !== null && v !== undefined && v !== '';
    });

    if (columns.length === 0) {
        return <p className="text-[11px] italic text-muted-foreground">No stored values to show.</p>;
    }

    return (
        <div className="grid grid-cols-2 gap-1.5 pt-0.5 sm:grid-cols-3">
            {columns.map((column) => {
                const v = formatAuditValue(column, entry.snapshot?.[column]);
                return (
                    <div key={column} className="min-w-0 rounded-sm border border-border/50 px-2 py-1">
                        <div className="truncate text-[10px] uppercase tracking-wide text-muted-foreground">
                            {auditColumnLabel(column)}
                        </div>
                        <div className={cn('truncate text-xs', v.numeric && 'font-mono tabular-nums')}>
                            {v.peso ? (
                                <span className="flex justify-between gap-1">
                                    <span className="text-muted-foreground">&#8369;</span>
                                    <span>{v.text}</span>
                                </span>
                            ) : (
                                v.text
                            )}
                        </div>
                    </div>
                );
            })}
        </div>
    );
}
