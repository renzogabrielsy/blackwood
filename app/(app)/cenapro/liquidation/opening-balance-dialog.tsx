'use client';

// ─────────────────────────────────────────────────────────────────────────────────
// SET A TRADER'S STARTING BALANCE — liquidation Step 3b's UI half.
//
// Renzo, 2026-08-06: "Since it's a bit impossible to check all of the past history, we
// should be able to modify the starting balances of the suppliers we have listed."
//
// The balance screen shipped hours before this dialog and says CI owes BRIX
// ₱212,669,462.50 — the entire year's purchases — because no historic cheque was ever
// entered and back-entering seven months of them is not realistic. This form is how that
// number becomes true.
//
// FOUR THINGS IT HAS TO GET RIGHT.
//
// ── 1. THE SIGN, WHICH IS THE ONE MISTAKE NOTHING LATER CAN CATCH ────────────────
// Stored values are signed like `running_balance_php`: negative = we owe them. A side
// chosen wrongly does not produce a visibly silly figure — it DOUBLES the balance instead
// of settling it, and ₱425M looks no more obviously wrong than ₱212M to a reader who is
// not already suspicious.
//
// So the operator is NEVER asked for a minus sign. They type a POSITIVE amount and pick a
// side IN WORDS, the conversion happens once in `openingSignedAmount`, and the result is
// READ BACK AS A SENTENCE before it can be saved. A person catches "we owe BRIX" when they
// meant the reverse. Nobody catches a minus sign.
//
// ── 2. THE AS-OF RULE, IN ONE PLAIN LINE ─────────────────────────────────────────
// The figure stands for everything STRICTLY BEFORE the date; receipts and payments dated
// ON OR AFTER it count fresh on top. A receipt dated exactly on the cutoff counts fresh.
// That is stated beside the date field rather than in a tooltip, because a reader who
// assumes the other boundary has no reason to hover.
//
// ── 3. APPEND-ONLY, SAID OUT LOUD ───────────────────────────────────────────────
// The table holds no UPDATE and no DELETE grant, and no UPDATE/DELETE policy under RLS.
// Saving APPENDS a revision; the superseded figure is kept forever. There is therefore no
// edit-in-place control and no delete button anywhere here — neither could work — and the
// form SAYS the old figure is kept, because "append-only" is only reassuring to someone
// who has been told about it. Without that line, a second save looks like data loss.
//
// ── 4. ZERO IS A REAL ANSWER ────────────────────────────────────────────────────
// "We are square as of this date" is a statement, not a blank, and the DB deliberately has
// no CHECK excluding it. Nothing here blocks it; the echo sentence just stops claiming a
// direction, because at zero there is none.
// ─────────────────────────────────────────────────────────────────────────────────

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { History, Loader2 } from 'lucide-react';

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
import { Textarea } from '@/components/ui/textarea';
import { errorToast } from '@/lib/toast';
import { cn, focusNoScroll } from '@/lib/utils';
import { toast } from 'sonner';

import { fetchOpeningBalanceHistory, setOpeningBalance, type OpeningBalanceRevision } from './actions';
import { InlineError } from './payments-panel';
import {
    APPEND_ONLY_NOTE,
    AS_OF_NOTE,
    balanceDirection,
    directionLabel,
    emptyOpeningBalanceForm,
    formatCount,
    formatDate,
    formatPeso,
    num,
    openingArgsFrom,
    openingFormFrom,
    openingSentence,
    validateOpeningBalanceForm,
    type OpeningBalanceFormState,
    type OpeningSide,
} from './types';

/** The two-way choice, in the operator's words. Never a sign. */
const SIDES: readonly { value: OpeningSide; label: string; hint: string }[] = [
    {
        value: 'we_owe',
        label: 'we owe them',
        hint: 'CI still owes this trader the amount above as of that date. This is the ordinary case.',
    },
    {
        value: 'they_owe',
        label: 'they owe us',
        hint: 'CI is ahead — an advance already paid that this trader has not yet delivered against.',
    },
];

function today(): string {
    // The local calendar day, not UTC: an opening balance stated on the 6th in Cebu must
    // not pre-fill as the 5th because the browser is west of the date line. The RPC's own
    // future check is measured in Asia/Manila for the same reason.
    const d = new Date();
    const p = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * A real instant, so `toLocaleString` is correct here — unlike a bare `yyyy-MM-dd`, which
 * this module formats by string arithmetic precisely to avoid the timezone shift. This
 * dialog only ever renders on the client (its data arrives through a server action into
 * client state), so there is no SSR text to mismatch against.
 */
function formatStamp(iso: string | null): string {
    if (!iso) return '—';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '—';
    return d.toLocaleString(undefined, {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
    });
}

/** The revision table's geometry: explicit widths whose SUM is the table's min-width. */
const REV_COLS = [
    { key: 'as_of', label: 'AS OF', width: 92 },
    { key: 'amount', label: 'AMOUNT', width: 148, numeric: true },
    { key: 'dir', label: '', width: 78 },
    { key: 'who', label: 'STATED BY', width: 132 },
    { key: 'when', label: 'WHEN', width: 132 },
    { key: 'note', label: 'NOTE', width: 220 },
] as const;

const REV_MIN_W = REV_COLS.reduce((s, c) => s + c.width, 0);

export interface OpeningBalanceDialogProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    supplierCode: string;
    supplierName: string;
    /**
     * The balance row's own opening columns. Used ONLY to pre-fill the form, which needs
     * no round trip — everything DISPLAYED comes from the fetched history, so the two can
     * never show a different current figure.
     */
    current: {
        hasOpeningBalance: boolean;
        openingBalancePhp: number | string | null;
        openingAsOfDate: string | null;
        firstReceiptDate: string | null;
        receiptCountAll: number | string | null;
        runningBalanceAllPhp: number | string | null;
    };
    /** Called after a successful append so the balance table can re-read. */
    onSaved: () => void;
}

export function OpeningBalanceDialog(props: OpeningBalanceDialogProps) {
    return (
        <Dialog open={props.open} onOpenChange={props.onOpenChange}>
            <DialogContent className="animate-modal-enter flex max-h-[88dvh] w-[calc(100%-2rem)] max-w-2xl flex-col gap-0 overflow-hidden p-0 sm:max-w-2xl">
                {/* Keyed on the trader so opening a SECOND one never shows the first one's
                    figure or history — the whole form state is remounted rather than
                    synchronised. Same reasoning as the payment dialog's key. */}
                <OpeningBalanceForm key={props.supplierCode || 'none'} {...props} />
            </DialogContent>
        </Dialog>
    );
}

interface HistoryState {
    loading: boolean;
    revisions: OpeningBalanceRevision[];
    error: string | null;
}

function OpeningBalanceForm({
    onOpenChange,
    supplierCode,
    supplierName,
    current,
    onSaved,
}: OpeningBalanceDialogProps) {
    const now = useMemo(() => today(), []);
    const [form, setForm] = useState<OpeningBalanceFormState>(() =>
        current.hasOpeningBalance
            ? openingFormFrom(
                  {
                      opening_as_of_date: current.openingAsOfDate,
                      opening_balance_php: current.openingBalancePhp,
                  },
                  now,
              )
            : emptyOpeningBalanceForm(now),
    );
    const [saving, setSaving] = useState(false);
    /** Complaints appear only once a save has been attempted — never while still typing. */
    const [submitted, setSubmitted] = useState(false);
    const [history, setHistory] = useState<HistoryState>({
        loading: true,
        revisions: [],
        error: null,
    });
    const [reloadToken, setReloadToken] = useState(0);
    const firstField = useRef<HTMLInputElement | null>(null);

    // `focusNoScroll`, never React's `autoFocus`: react-dom's `commitMount` is a bare
    // `.focus()` with no options, and a bare focus() scrolls with block AND inline
    // "center" through every scrolling ancestor.
    useEffect(() => {
        focusNoScroll(firstField.current);
    }, []);

    useEffect(() => {
        if (!supplierCode) return;
        let cancelled = false;
        fetchOpeningBalanceHistory(supplierCode)
            .then((res) => {
                if (cancelled) return;
                setHistory({ loading: false, revisions: res.revisions, error: res.error });
                if (res.error) {
                    errorToast('Could not load the opening-balance history', { description: res.error });
                }
            })
            .catch((err: unknown) => {
                if (cancelled) return;
                setHistory({
                    loading: false,
                    revisions: [],
                    error: err instanceof Error ? err.message : String(err),
                });
            });
        return () => {
            cancelled = true;
        };
        // `reloadToken` is the refetch trigger and is deliberately part of the key set.
    }, [supplierCode, reloadToken]);

    const errors = useMemo(() => validateOpeningBalanceForm(form, now), [form, now]);
    const showError = (field: keyof OpeningBalanceFormState) => (submitted ? errors[field] : undefined);

    const sentence = openingSentence(form, supplierName);
    const typedAmount = num(form.amount_php.trim());
    const isZero = typedAmount === 0;

    const inForce = history.revisions.find((r) => r.isCurrent) ?? null;

    const set = useCallback(
        <K extends keyof OpeningBalanceFormState>(key: K, value: OpeningBalanceFormState[K]) => {
            setForm((f) => ({ ...f, [key]: value }));
        },
        [],
    );

    async function handleSave() {
        setSubmitted(true);
        if (Object.keys(errors).length > 0) {
            errorToast('This starting balance is not ready to save', {
                description: Object.values(errors)[0],
            });
            return;
        }

        // The ONE place the operator's positive figure plus their chosen side becomes a
        // signed number. `null` here would mean the validation above let something through.
        const args = openingArgsFrom(supplierCode, form);
        if (!args) {
            errorToast('This starting balance is not ready to save', {
                description: 'The amount could not be read as a number of pesos.',
            });
            return;
        }

        setSaving(true);
        try {
            const result = await setOpeningBalance(args);
            if (!result.ok) {
                // The database's own words, verbatim — it names precisely which rule was
                // broken, and a re-worded "Save failed" would discard the instruction.
                errorToast('The starting balance was not saved', {
                    description:
                        result.message ?? `The database refused the write (${result.outcome}).`,
                });
                return;
            }

            // The RPC's success message says whether this was the first statement or a
            // revision, and names what it superseded. Worth showing rather than replacing.
            toast.success(result.message ?? 'Starting balance recorded');
            setSubmitted(false);
            setReloadToken((n) => n + 1);
            onSaved();
            onOpenChange(false);
        } finally {
            setSaving(false);
        }
    }

    return (
        <>
            {/* `pr-12` clears DialogContent's own absolutely-positioned close X. */}
            <DialogHeader className="shrink-0 border-b border-border bg-background/90 px-4 py-3 pr-12 backdrop-blur-sm">
                <DialogTitle className="text-base">Starting balance for {supplierName}</DialogTitle>
                <DialogDescription className="text-xs">
                    State what was actually outstanding as of a date, and the balance counts forward from
                    there. This is how a figure that currently adds up every truck since January becomes
                    the amount really owed.
                </DialogDescription>
            </DialogHeader>

            <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
                <div className="grid gap-4">
                    {/* ── The date, and the rule it obeys ───────────────────────── */}
                    <Field
                        label="As of"
                        htmlFor="ob-date"
                        error={showError('as_of_date')}
                        hint={AS_OF_NOTE}
                    >
                        <Input
                            id="ob-date"
                            ref={firstField}
                            type="date"
                            max={now}
                            value={form.as_of_date}
                            onChange={(e) => set('as_of_date', e.target.value)}
                            className="h-9 w-full font-mono text-sm sm:w-56"
                        />
                    </Field>

                    {/* ── The amount: positive, always ──────────────────────────── */}
                    <Field
                        label="Amount outstanding"
                        htmlFor="ob-amount"
                        error={showError('amount_php')}
                        hint={
                            isZero
                                ? 'Zero states that this trader is square as of that date — a real answer, not a blank. The choice below does not apply at zero.'
                                : 'A positive figure. Which way it points is the choice below, never a minus sign.'
                        }
                    >
                        {/* Accounting shape: ₱ pinned left, the figure pinned right. */}
                        <div className="flex h-9 items-center gap-1 rounded-md border border-input bg-transparent pl-2.5 focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/50 sm:w-56">
                            <span className="shrink-0 text-sm text-muted-foreground">₱</span>
                            <Input
                                id="ob-amount"
                                type="number"
                                inputMode="decimal"
                                // Never negative: the direction is the radio pair below.
                                min="0"
                                step="0.01"
                                value={form.amount_php}
                                onChange={(e) => set('amount_php', e.target.value)}
                                placeholder="0.00"
                                className="h-8 border-0 bg-transparent p-0 pr-2.5 text-right font-mono text-sm tabular-nums shadow-none focus-visible:border-0 focus-visible:ring-0"
                            />
                        </div>
                    </Field>

                    {/* ── The side. The whole reason no minus sign is ever typed. ─ */}
                    <div className="min-w-0">
                        <Label className="mb-1 text-xs font-medium">Which way does it point?</Label>
                        <SideChoice
                            value={form.side}
                            onChange={(v) => set('side', v)}
                            muted={isZero}
                        />
                        <p className="mt-1 text-[11px] leading-snug text-muted-foreground">
                            {SIDES.find((s) => s.value === form.side)?.hint}
                        </p>
                    </div>

                    {/* ── The echo. Read it back before committing it. ──────────── */}
                    {sentence ? (
                        <div
                            className="animate-fade-in rounded-md border border-border bg-muted px-3 py-2.5"
                            aria-live="polite"
                        >
                            <p className="text-sm font-medium leading-snug">{sentence}</p>
                            <p className="mt-1 text-[11px] leading-snug text-muted-foreground">
                                Everything dated before {formatDate(form.as_of_date)} is treated as settled at
                                that figure. Receipts and payments on or after it are counted on top of it.
                            </p>
                        </div>
                    ) : null}

                    {/* ── Provenance ───────────────────────────────────────────── */}
                    <Field
                        label="Where did this number come from?"
                        htmlFor="ob-note"
                        hint="Optional — but it is the only thing that will explain this figure in six months. A supplier statement, a confirmation call, a reconciled ledger page."
                    >
                        <Textarea
                            id="ob-note"
                            value={form.note}
                            onChange={(e) => set('note', e.target.value)}
                            rows={2}
                            placeholder="e.g. BRIX statement dated 31 July, confirmed by phone with Ate Fe"
                            className="min-h-[2.5rem] text-sm"
                        />
                    </Field>

                    {/* ── What is in force right now ───────────────────────────── */}
                    <div className="rounded-md border border-border">
                        <div className="border-b border-border bg-muted px-3 py-1.5">
                            <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                                Currently in force
                            </p>
                        </div>
                        <div className="px-3 py-2.5">
                            {history.loading ? (
                                <p className="flex items-center gap-2 text-xs text-muted-foreground">
                                    <Loader2 className="size-3.5 animate-spin" />
                                    Loading…
                                </p>
                            ) : inForce ? (
                                <>
                                    <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                                        <span className="font-mono text-sm tabular-nums">
                                            ₱{formatPeso(inForce.openingBalancePhp)}
                                        </span>
                                        <span className="text-[11px] text-muted-foreground">
                                            {directionLabel(balanceDirection(inForce.openingBalancePhp))}
                                        </span>
                                        <span className="font-mono text-xs text-muted-foreground">
                                            as of {formatDate(inForce.asOfDate)}
                                        </span>
                                    </div>
                                    <p className="mt-1 text-[11px] leading-snug text-muted-foreground">
                                        Stated by {inForce.actorName ?? 'the system'} on{' '}
                                        {formatStamp(inForce.createdAt)}
                                        {history.revisions.length > 1
                                            ? ` · revision ${history.revisions.length} of ${history.revisions.length}`
                                            : ''}
                                    </p>
                                    {inForce.note ? (
                                        <p className="mt-1 text-[11px] leading-snug">
                                            <span className="text-muted-foreground">Source: </span>
                                            {inForce.note}
                                        </p>
                                    ) : (
                                        <p className="mt-1 text-[11px] leading-snug text-muted-foreground/70 italic">
                                            No source was recorded for this figure.
                                        </p>
                                    )}
                                </>
                            ) : (
                                <>
                                    <p className="text-xs">
                                        No starting balance has been stated for {supplierName} yet.
                                    </p>
                                    <p className="mt-1 text-[11px] leading-snug text-muted-foreground">
                                        Its balance therefore covers{' '}
                                        <span className="font-medium text-foreground">
                                            all {formatCount(current.receiptCountAll)} receipts
                                        </span>
                                        {current.firstReceiptDate
                                            ? ` since ${formatDate(current.firstReceiptDate)}`
                                            : ''}{' '}
                                        and reads ₱{formatPeso(current.runningBalanceAllPhp)}.
                                    </p>
                                </>
                            )}
                        </div>
                    </div>

                    {/* ── Every revision ever stated ───────────────────────────── */}
                    {history.error ? (
                        <InlineError message={history.error} />
                    ) : history.revisions.length > 0 ? (
                        <div className="min-w-0">
                            <div className="mb-1 flex items-center gap-1.5">
                                <History aria-hidden className="size-3.5 text-muted-foreground" />
                                <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                                    Every revision ({history.revisions.length})
                                </p>
                            </div>
                            {/* "Never crush, always scroll": explicit widths, their sum as
                                the min-width, and the wrapper scrolls when the dialog is
                                narrower. */}
                            <div className="overflow-x-auto rounded-md border border-border">
                                {/* `separate` + `border-spacing: 0`, never `border-collapse`
                                    — under the collapsed model a border belongs to the
                                    TABLE rather than the cell and a sticky cell's own
                                    background stops painting, so rows show through the
                                    header as they scroll under it. Same idiom as every
                                    other table in this module. */}
                                <table
                                    className="w-full table-fixed text-xs"
                                    style={{
                                        minWidth: REV_MIN_W,
                                        borderCollapse: 'separate',
                                        borderSpacing: 0,
                                    }}
                                >
                                    <colgroup>
                                        {REV_COLS.map((c) => (
                                            <col key={c.key} style={{ width: c.width }} />
                                        ))}
                                    </colgroup>
                                    <thead>
                                        <tr>
                                            {REV_COLS.map((c) => (
                                                <th
                                                    key={c.key}
                                                    // A sticky header sits ON TOP of scrolling
                                                    // rows, so it is fully OPAQUE — solid
                                                    // `bg-muted`, never glass.
                                                    className={cn(
                                                        'frozen-row border-b border-border bg-muted px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground',
                                                        'numeric' in c && c.numeric
                                                            ? 'text-right'
                                                            : 'text-left',
                                                    )}
                                                >
                                                    {c.label}
                                                </th>
                                            ))}
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {history.revisions.map((r) => (
                                            <RevisionRow key={r.key} rev={r} />
                                        ))}
                                    </tbody>
                                </table>
                            </div>
                            <p className="mt-1.5 text-[11px] leading-snug text-muted-foreground">
                                {APPEND_ONLY_NOTE}
                            </p>
                        </div>
                    ) : !history.loading ? (
                        <p className="text-[11px] leading-snug text-muted-foreground">
                            {APPEND_ONLY_NOTE}
                        </p>
                    ) : null}
                </div>
            </div>

            <DialogFooter className="shrink-0 gap-2 border-t border-border bg-background/90 px-4 py-3 backdrop-blur-sm sm:justify-end">
                <Button variant="outline" size="sm" onClick={() => onOpenChange(false)} disabled={saving}>
                    Cancel
                </Button>
                <Button size="sm" onClick={handleSave} disabled={saving}>
                    {saving ? <Loader2 className="size-3.5 animate-spin" /> : null}
                    {inForce ? 'Save as a new revision' : 'Save starting balance'}
                </Button>
            </DialogFooter>
        </>
    );
}

// ─── The two-way choice ─────────────────────────────────────────────────────────

/**
 * A real radio group, not two `aria-pressed` toggles: the two options are mutually
 * exclusive and a screen reader should say "1 of 2", not "not pressed". Arrow keys move
 * between them, which is what a `radiogroup` promises.
 *
 * Deliberately NOT colour-coded. "We owe them" is the ordinary state of every trader in
 * this ledger, and painting it red or amber would mark the normal case as a problem — the
 * same reasoning that keeps the balance column in plain foreground.
 */
function SideChoice({
    value,
    onChange,
    muted,
}: {
    value: OpeningSide;
    onChange: (v: OpeningSide) => void;
    /** At an amount of zero the direction is genuinely moot, so it recedes. */
    muted: boolean;
}) {
    function move(delta: number) {
        const i = SIDES.findIndex((s) => s.value === value);
        const next = SIDES[(i + delta + SIDES.length) % SIDES.length];
        if (next) onChange(next.value);
    }

    return (
        <div
            role="radiogroup"
            aria-label="Which way the balance points"
            className={cn(
                'inline-flex overflow-hidden rounded-md border border-input transition-opacity duration-150',
                muted && 'opacity-60',
            )}
            onKeyDown={(e) => {
                if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
                    e.preventDefault();
                    move(-1);
                } else if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
                    e.preventDefault();
                    move(1);
                }
            }}
        >
            {SIDES.map((s, i) => {
                const active = s.value === value;
                return (
                    <button
                        key={s.value}
                        type="button"
                        role="radio"
                        aria-checked={active}
                        // Only the selected option is a tab stop, which is how a radio
                        // group behaves: one stop for the group, arrows to move within it.
                        tabIndex={active ? 0 : -1}
                        onClick={() => onChange(s.value)}
                        className={cn(
                            'px-3 py-1.5 text-xs transition-all duration-150 focus-visible:z-10 focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50',
                            i > 0 && 'border-l border-input',
                            active
                                ? 'bg-primary font-medium text-primary-foreground'
                                : 'text-muted-foreground hover:bg-muted hover:text-foreground',
                        )}
                    >
                        {s.label}
                    </button>
                );
            })}
        </div>
    );
}

// ─── One revision ───────────────────────────────────────────────────────────────

function RevisionRow({ rev }: { rev: OpeningBalanceRevision }) {
    const note = (rev.note ?? '').trim();

    // Row rules live on the CELLS — a `<tr>` border is never painted in the separated
    // borders model this table uses. The row tint is a SOLID token for the same reason it
    // is everywhere else in this module: `cn()` resolves two `bg-*` utilities to the last
    // one, so a translucent tint would replace an opaque base rather than layer over it.
    const cell = cn(
        'border-b border-border px-2 py-1 align-middle',
        rev.isCurrent && 'bg-muted',
    );

    return (
        <tr className="h-8">
            <td className={cn(cell, 'font-mono')}>{formatDate(rev.asOfDate)}</td>
            <td className={cn(cell, 'text-right font-mono tabular-nums')}>
                {/* Accounting format: ₱ pinned left, the figure pinned right. */}
                <span className="flex items-baseline justify-between gap-2">
                    <span className="text-muted-foreground">₱</span>
                    <span className={cn(rev.isCurrent && 'font-medium')}>
                        {formatPeso(rev.openingBalancePhp)}
                    </span>
                </span>
            </td>
            <td className={cell}>
                <span className="text-[10px] leading-tight text-muted-foreground">
                    {directionLabel(balanceDirection(rev.openingBalancePhp))}
                </span>
                {rev.isCurrent ? (
                    <span className="ml-1 inline-flex items-center rounded-sm border border-border px-1 py-px text-[10px] leading-tight">
                        in force
                    </span>
                ) : null}
            </td>
            <td className={cn(cell, 'truncate')} title={rev.actorName ?? 'Recorded outside the app'}>
                {rev.actorName ?? <span className="text-muted-foreground italic">system</span>}
            </td>
            <td className={cn(cell, 'truncate text-muted-foreground')} title={rev.createdAt ?? ''}>
                {formatStamp(rev.createdAt)}
            </td>
            <td className={cn(cell, 'max-w-[220px] truncate')} title={note}>
                {note || <span className="text-muted-foreground/50">—</span>}
            </td>
        </tr>
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
            {/* An inline complaint belongs beside the field it is about. The errors that
                need COPYING are the DB's refusals, and those go through `errorToast`
                (persistent + Copy) from `handleSave`. */}
            {error ? (
                <p className="mt-1 text-[11px] leading-snug text-destructive" role="alert">
                    {error}
                </p>
            ) : hint ? (
                <p className="mt-1 text-[11px] leading-snug text-muted-foreground">{hint}</p>
            ) : null}
        </div>
    );
}
