'use client';

// ─────────────────────────────────────────────────────────────────────────────────
// BANKS & ACCOUNTS — the maintenance screen a cheque cannot be recorded without.
//
// WHY IT EXISTS. `rc_payment`'s shape CHECK requires a cheque to name BOTH a number and
// the account it was drawn on, and the migration seeded four banks but ZERO accounts on
// purpose — an account number is a real fact about a real cheque book, and inventing one
// would put a fabrication in a ledger whose value is that it is not fabricated. So until
// somebody types a real account here, the dominant instrument in this business cannot be
// recorded at all. This screen is the missing half of "banks, accounts, payments and the
// running balance".
//
// ── NOTHING IS EVER DELETED ──────────────────────────────────────────────────────
// A bank or account is RETIRED with `active = false`, never removed — historic payments
// must keep naming it, and there is no delete RPC in the database for either. The screen
// therefore shows retired rows rather than hiding them (you cannot restore what you
// cannot see) and labels them; only the PICKERS filter to active.
//
// For a cheque this is stronger than a convention: `rc_payment.bank_account_id` is
// `ON DELETE SET NULL`, and the cheque shape CHECK turns that SET NULL into an outright
// refusal — a cheque's account is structurally undeletable.
//
// ── DECISION 4: THE BANK NAME READS FIRST ────────────────────────────────────────
// Bank name is the primary line; the account label sits under it and the account NUMBER
// is small, muted, secondary detail — the same emphasis the payment form's picker uses,
// because they are two views of one dimension and a person should recognise the second
// from the first.
// ─────────────────────────────────────────────────────────────────────────────────

import { useEffect, useMemo, useRef, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { ArrowLeft, Landmark, Loader2, Plus } from 'lucide-react';

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

import { saveBank, saveBankAccount } from '../actions';
import { InlineError } from '../payments-panel';
import {
    BANK_COLS,
    activePatch,
    bankAccountFormFrom,
    bankAccountPatchFrom,
    bankFormFrom,
    bankPatchFrom,
    buildBankTree,
    emptyBankAccountForm,
    emptyBankForm,
    formatCount,
    minBankTableWidth,
    validateBankAccountForm,
    validateBankForm,
    type BankAccountFormState,
    type BankAccountRow,
    type BankFormState,
    type BankRow,
} from '../types';

const MIN_W = minBankTableWidth();

type Editing =
    | { kind: 'bank'; row: BankRow | null }
    | { kind: 'account'; row: BankAccountRow | null; bankCode: string }
    | null;

export function BanksView({
    banks,
    accounts,
    loadError,
}: {
    banks: BankRow[];
    accounts: BankAccountRow[];
    loadError: string | null;
}) {
    const router = useRouter();
    const [editing, setEditing] = useState<Editing>(null);
    const [pendingKey, setPendingKey] = useState<string | null>(null);
    const [, startTransition] = useTransition();

    const tree = useMemo(() => buildBankTree(banks, accounts), [banks, accounts]);
    const activeAccountCount = accounts.filter((a) => a.active !== false).length;

    /** Retire / restore, as a one-key patch. The dialogs own every other field. */
    function toggleActive(
        target: { kind: 'bank'; row: BankRow } | { kind: 'account'; row: BankAccountRow },
    ) {
        const next = target.row.active === false;
        const version = target.row.row_version;
        if (version === null || version === undefined) return;

        const key = target.kind === 'bank' ? `bank:${target.row.code}` : `acct:${target.row.id}`;
        setPendingKey(key);
        startTransition(async () => {
            const result =
                target.kind === 'bank'
                    ? await saveBank({
                          code: target.row.code ?? '',
                          expectedRowVersion: version,
                          patch: activePatch(next),
                      })
                    : await saveBankAccount({
                          id: target.row.id ?? '',
                          expectedRowVersion: version,
                          patch: activePatch(next),
                      });
            setPendingKey(null);

            if (!result.ok) {
                errorToast(next ? 'Could not restore it' : 'Could not retire it', {
                    description: result.message ?? `The database refused the write (${result.outcome}).`,
                });
                return;
            }
            toast.success(next ? 'Restored' : 'Retired — historic payments still name it.');
            router.refresh();
        });
    }

    return (
        <div className="flex min-h-0 flex-1 flex-col">
            <div className="animate-fade-up shrink-0 border-b border-border px-4 py-3">
                <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0 max-w-3xl">
                        <p className="text-sm font-medium">
                            CI&rsquo;s own banks, and the accounts cheques are drawn on.
                        </p>
                        <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
                            A cheque cannot be recorded without naming the account it came from — a cheque
                            number is only unique within one account, so the two together are what identify
                            it. Nothing here is ever deleted: a bank or account you stop using is marked
                            retired, so older payments keep naming it.
                            {activeAccountCount === 0 ? (
                                <span className="font-medium text-amber-600 dark:text-amber-400">
                                    {' '}
                                    No accounts exist yet, so cheques cannot be recorded — add one below.
                                </span>
                            ) : null}
                        </p>
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                        <Button
                            variant="outline"
                            size="sm"
                            className="h-8 text-xs"
                            onClick={() => setEditing({ kind: 'bank', row: null })}
                        >
                            <Plus className="size-3.5" />
                            Add bank
                        </Button>
                        <Button asChild variant="outline" size="sm" className="h-8 text-xs">
                            <Link href="/cenapro/liquidation">
                                <ArrowLeft className="size-3.5" />
                                Balances
                            </Link>
                        </Button>
                    </div>
                </div>
            </div>

            {loadError ? <InlineError message={loadError} /> : null}

            <div className="min-h-0 flex-1 overflow-auto">
                {tree.length === 0 && !loadError ? (
                    <div className="animate-fade-up p-10 text-center">
                        <p className="text-sm font-medium">No banks yet</p>
                        <p className="mt-1 text-xs text-muted-foreground">
                            Add the bank a cheque is drawn on, then the account underneath it.
                        </p>
                    </div>
                ) : (
                    <table
                        className="w-full table-fixed text-xs"
                        // `separate` + `border-spacing: 0`, never `border-collapse` —
                        // under the collapsed model a border belongs to the TABLE and a
                        // sticky cell's background stops painting reliably, so scrolling
                        // content bleeds through the frozen first column. Row rules are
                        // already on the cells, which is what this model paints.
                        style={{ minWidth: MIN_W, borderCollapse: 'separate', borderSpacing: 0 }}
                    >
                        <colgroup>
                            {BANK_COLS.map((c) => (
                                <col key={c.key} style={{ width: c.width }} />
                            ))}
                        </colgroup>
                        <thead>
                            <tr>
                                {BANK_COLS.map((c, i) => (
                                    <th
                                        key={c.key}
                                        title={c.title}
                                        // Frozen surfaces overlap scrolling content, so they are
                                        // fully OPAQUE — solid `bg-muted`, never glass.
                                        className={cn(
                                            'border-b border-border bg-muted px-2 py-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground',
                                            c.numeric ? 'text-right' : 'text-left',
                                            i === 0 ? 'frozen-corner frozen-edge left-0' : 'frozen-row',
                                        )}
                                    >
                                        {c.label}
                                    </th>
                                ))}
                            </tr>
                        </thead>
                        <tbody>
                            {tree.map(({ bank, accounts: rows }) => {
                                const bankKey = `bank:${bank.code}`;
                                const bankRetired = bank.active === false;
                                return (
                                    <BankGroupRows
                                        key={bank.code ?? ''}
                                        bank={bank}
                                        rows={rows}
                                        bankRetired={bankRetired}
                                        pendingKey={pendingKey}
                                        bankKey={bankKey}
                                        onEditBank={() => setEditing({ kind: 'bank', row: bank })}
                                        onAddAccount={() =>
                                            setEditing({ kind: 'account', row: null, bankCode: bank.code ?? '' })
                                        }
                                        onEditAccount={(row) =>
                                            setEditing({ kind: 'account', row, bankCode: row.bank_code ?? '' })
                                        }
                                        onToggleBank={() => toggleActive({ kind: 'bank', row: bank })}
                                        onToggleAccount={(row) => toggleActive({ kind: 'account', row })}
                                    />
                                );
                            })}
                        </tbody>
                    </table>
                )}
            </div>

            <div className="shrink-0 border-t border-border px-4 py-2">
                <p className="text-[11px] leading-snug text-muted-foreground">
                    A bank or account <span className="font-medium">code cannot be deleted</span> — retiring
                    it hides it from the pickers while every payment that already names it keeps working. A
                    bank&rsquo;s code is also fixed once created, because renaming it would move every
                    account underneath it.
                </p>
            </div>

            {editing?.kind === 'bank' ? (
                <BankDialog
                    key={editing.row?.code ?? 'new-bank'}
                    row={editing.row}
                    onClose={() => setEditing(null)}
                    onSaved={() => {
                        setEditing(null);
                        router.refresh();
                    }}
                />
            ) : null}

            {editing?.kind === 'account' ? (
                <AccountDialog
                    key={editing.row?.id ?? `new-account:${editing.bankCode}`}
                    row={editing.row}
                    bankCode={editing.bankCode}
                    banks={banks}
                    onClose={() => setEditing(null)}
                    onSaved={() => {
                        setEditing(null);
                        router.refresh();
                    }}
                />
            ) : null}
        </div>
    );
}

// ─── One bank and its accounts ──────────────────────────────────────────────────

function BankGroupRows({
    bank,
    rows,
    bankRetired,
    pendingKey,
    bankKey,
    onEditBank,
    onAddAccount,
    onEditAccount,
    onToggleBank,
    onToggleAccount,
}: {
    bank: BankRow;
    rows: BankAccountRow[];
    bankRetired: boolean;
    pendingKey: string | null;
    bankKey: string;
    onEditBank: () => void;
    onAddAccount: () => void;
    onEditAccount: (row: BankAccountRow) => void;
    onToggleBank: () => void;
    onToggleAccount: (row: BankAccountRow) => void;
}) {
    // Row rules live on the CELLS — a `<tr>` border is never painted in the separated
    // model this table uses. The bank row's tint is the SOLID `bg-muted` on every cell,
    // frozen and scrolling alike: a translucent tint would both diverge from the frozen
    // cell and let scrolling content bleed through it.
    const cell = 'border-b border-border px-2 py-1 align-middle transition-all duration-150';

    return (
        <>
            <tr className="group h-9 bg-muted">
                <td className={cn(cell, 'frozen-col frozen-edge left-0 bg-muted')}>
                    <div className="flex min-w-0 items-center gap-1.5">
                        <Landmark aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
                        {/* Decision 4: the bank name reads primarily. */}
                        <span className="truncate font-semibold" title={bank.code ?? ''}>
                            {bank.display_name ?? bank.code}
                        </span>
                        {pendingKey === bankKey ? (
                            <Loader2 className="size-3 shrink-0 animate-spin text-muted-foreground" />
                        ) : null}
                    </div>
                    <div className="truncate font-mono text-[10px] leading-tight text-muted-foreground/80">
                        {bank.code}
                    </div>
                </td>
                <td className={cn(cell, 'bg-muted text-muted-foreground')}>
                    {rows.length === 0 ? (
                        <span className="text-[11px] italic">no accounts yet</span>
                    ) : (
                        <span className="text-[11px]">
                            {rows.length} account{rows.length === 1 ? '' : 's'}
                        </span>
                    )}
                </td>
                <td className={cn(cell, 'bg-muted')}>
                    <StatusTag retired={bankRetired} />
                </td>
                <td className={cn(cell, 'bg-muted text-right font-mono tabular-nums text-muted-foreground')}>
                    {formatCount(bank.sort_order)}
                </td>
                <td className={cn(cell, 'max-w-[232px] truncate bg-muted text-muted-foreground')} title={bank.notes ?? ''}>
                    {(bank.notes ?? '').trim() || '—'}
                </td>
                <td className={cn(cell, 'bg-muted text-right')}>
                    <div className="flex items-center justify-end gap-0.5">
                        <Button variant="ghost" size="sm" className="h-6 px-1.5 text-[11px]" onClick={onAddAccount}>
                            <Plus className="size-3" />
                            Account
                        </Button>
                        <Button variant="ghost" size="sm" className="h-6 px-1.5 text-[11px]" onClick={onEditBank}>
                            Edit
                        </Button>
                        <Button
                            variant="ghost"
                            size="sm"
                            className="h-6 px-1.5 text-[11px] text-muted-foreground"
                            onClick={onToggleBank}
                            title={
                                bankRetired
                                    ? 'Bring this bank back into the pickers'
                                    : 'Hide it from the pickers. Nothing is deleted.'
                            }
                        >
                            {bankRetired ? 'Restore' : 'Retire'}
                        </Button>
                    </div>
                </td>
            </tr>

            {rows.map((a) => {
                const retired = a.active === false;
                const busy = pendingKey === `acct:${a.id}`;
                return (
                    <tr key={a.id ?? ''} className="group h-9 hover:bg-muted/50">
                        <td
                            className={cn(
                                cell,
                                'frozen-col frozen-edge left-0 bg-background group-hover:bg-muted/50',
                            )}
                        >
                            <div className="flex min-w-0 items-center gap-1 pl-4">
                                <span aria-hidden className="shrink-0 text-muted-foreground/50">
                                    └
                                </span>
                                <span className="truncate" title={a.account_label ?? ''}>
                                    {a.account_label}
                                </span>
                                {busy ? (
                                    <Loader2 className="size-3 shrink-0 animate-spin text-muted-foreground" />
                                ) : null}
                            </div>
                        </td>
                        {/* Secondary detail, deliberately quiet (decision 4). */}
                        <td className={cn(cell, 'truncate font-mono text-[11px] text-muted-foreground')} title={a.account_no ?? ''}>
                            {(a.account_no ?? '').trim() || <span className="italic">not recorded</span>}
                        </td>
                        <td className={cell}>
                            <StatusTag retired={retired} />
                        </td>
                        <td className={cn(cell, 'text-right font-mono tabular-nums text-muted-foreground')}>
                            {formatCount(a.sort_order)}
                        </td>
                        <td className={cn(cell, 'max-w-[232px] truncate text-muted-foreground')} title={a.notes ?? ''}>
                            {(a.notes ?? '').trim() || '—'}
                        </td>
                        <td className={cn(cell, 'text-right')}>
                            <div className="flex items-center justify-end gap-0.5">
                                <Button
                                    variant="ghost"
                                    size="sm"
                                    className="h-6 px-1.5 text-[11px]"
                                    onClick={() => onEditAccount(a)}
                                    disabled={busy}
                                >
                                    Edit
                                </Button>
                                <Button
                                    variant="ghost"
                                    size="sm"
                                    className="h-6 px-1.5 text-[11px] text-muted-foreground"
                                    onClick={() => onToggleAccount(a)}
                                    disabled={busy}
                                    title={
                                        retired
                                            ? 'Bring this account back into the pickers'
                                            : 'Hide it from the pickers. Cheques already drawn on it keep working.'
                                    }
                                >
                                    {retired ? 'Restore' : 'Retire'}
                                </Button>
                            </div>
                        </td>
                    </tr>
                );
            })}
        </>
    );
}

function StatusTag({ retired }: { retired: boolean }) {
    return (
        <span
            className={cn(
                'inline-flex items-center rounded-sm border px-1 py-px text-[10px] leading-tight',
                retired
                    ? 'border-dashed border-border italic text-muted-foreground'
                    : 'border-border text-muted-foreground',
            )}
        >
            {retired ? 'retired' : 'in use'}
        </span>
    );
}

// ─── The two dialogs ────────────────────────────────────────────────────────────

function BankDialog({
    row,
    onClose,
    onSaved,
}: {
    row: BankRow | null;
    onClose: () => void;
    onSaved: () => void;
}) {
    const isNew = row === null;
    const [form, setForm] = useState<BankFormState>(() => (row ? bankFormFrom(row) : emptyBankForm()));
    const [submitted, setSubmitted] = useState(false);
    const [saving, setSaving] = useState(false);
    const first = useRef<HTMLInputElement | null>(null);

    // `focusNoScroll`, never React's `autoFocus` — a bare .focus() scrolls with block AND
    // inline "center" through every scrolling ancestor.
    useEffect(() => {
        focusNoScroll(first.current);
    }, []);

    const errors = useMemo(() => validateBankForm(form, isNew), [form, isNew]);

    async function save() {
        setSubmitted(true);
        if (Object.keys(errors).length > 0) {
            errorToast('This bank is not ready to save', { description: Object.values(errors)[0] });
            return;
        }
        setSaving(true);
        try {
            const result = await saveBank({
                code: isNew ? form.code : (row?.code ?? ''),
                expectedRowVersion: isNew ? null : (row?.row_version ?? null),
                patch: { ...bankPatchFrom(form), ...activePatch(form.active) },
            });
            if (!result.ok) {
                // The database's own words — it names the exact rule that was broken.
                errorToast(isNew ? 'The bank was not added' : 'The bank was not saved', {
                    description: result.message ?? `The database refused the write (${result.outcome}).`,
                });
                return;
            }
            toast.success(isNew ? 'Bank added' : 'Bank saved');
            onSaved();
        } finally {
            setSaving(false);
        }
    }

    return (
        <Dialog open onOpenChange={(o) => !o && onClose()}>
            <DialogContent className="animate-modal-enter flex max-h-[88dvh] w-[calc(100%-2rem)] max-w-md flex-col gap-0 overflow-hidden p-0">
                <DialogHeader className="shrink-0 border-b border-border bg-background/90 px-4 py-3 pr-12 backdrop-blur-sm">
                    <DialogTitle className="text-base">{isNew ? 'Add a bank' : 'Edit bank'}</DialogTitle>
                    <DialogDescription className="text-xs">
                        One of CI&rsquo;s own banks — not the supplier&rsquo;s.
                    </DialogDescription>
                </DialogHeader>

                <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
                    <div className="grid gap-4">
                        <FormField
                            label="Code"
                            htmlFor="bank-code"
                            error={submitted ? errors.code : undefined}
                            hint={
                                isNew
                                    ? 'Short and permanent, e.g. BDO. It cannot be changed afterwards.'
                                    : 'Fixed once created — renaming it would move every account underneath it.'
                            }
                        >
                            <Input
                                id="bank-code"
                                ref={isNew ? first : undefined}
                                value={form.code}
                                onChange={(e) => setForm((f) => ({ ...f, code: e.target.value.toUpperCase() }))}
                                disabled={!isNew}
                                placeholder="BDO"
                                className="h-9 font-mono text-sm"
                            />
                        </FormField>

                        <FormField label="Name" htmlFor="bank-name" error={submitted ? errors.display_name : undefined}>
                            <Input
                                id="bank-name"
                                ref={isNew ? undefined : first}
                                value={form.display_name}
                                onChange={(e) => setForm((f) => ({ ...f, display_name: e.target.value }))}
                                placeholder="BDO"
                                className="h-9 text-sm"
                            />
                        </FormField>

                        <div className="grid gap-4 sm:grid-cols-2">
                            <FormField
                                label="Order"
                                htmlFor="bank-sort"
                                error={submitted ? errors.sort_order : undefined}
                                hint="Where it sits in the pickers."
                            >
                                <Input
                                    id="bank-sort"
                                    type="number"
                                    step="10"
                                    value={form.sort_order}
                                    onChange={(e) => setForm((f) => ({ ...f, sort_order: e.target.value }))}
                                    className="h-9 text-right font-mono text-sm tabular-nums"
                                />
                            </FormField>
                            <FormField label="Status" htmlFor="bank-active" hint="Retired hides it from the pickers.">
                                <Select
                                    value={form.active ? 'active' : 'retired'}
                                    onValueChange={(v) => setForm((f) => ({ ...f, active: v === 'active' }))}
                                >
                                    <SelectTrigger id="bank-active" className="h-9 w-full text-sm">
                                        <SelectValue />
                                    </SelectTrigger>
                                    <SelectContent className="bg-popover/95 backdrop-blur-lg">
                                        <SelectItem value="active" className="text-sm">In use</SelectItem>
                                        <SelectItem value="retired" className="text-sm">Retired</SelectItem>
                                    </SelectContent>
                                </Select>
                            </FormField>
                        </div>

                        <FormField label="Notes" htmlFor="bank-notes">
                            <Textarea
                                id="bank-notes"
                                value={form.notes}
                                onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))}
                                rows={2}
                                placeholder="Optional"
                                className="min-h-[2.5rem] text-sm"
                            />
                        </FormField>
                    </div>
                </div>

                <DialogFooter className="shrink-0 gap-2 border-t border-border bg-background/90 px-4 py-3 backdrop-blur-sm sm:justify-end">
                    <Button variant="outline" size="sm" onClick={onClose} disabled={saving}>
                        Cancel
                    </Button>
                    <Button size="sm" onClick={save} disabled={saving}>
                        {saving ? <Loader2 className="size-3.5 animate-spin" /> : null}
                        {isNew ? 'Add bank' : 'Save changes'}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}

function AccountDialog({
    row,
    bankCode,
    banks,
    onClose,
    onSaved,
}: {
    row: BankAccountRow | null;
    bankCode: string;
    banks: BankRow[];
    onClose: () => void;
    onSaved: () => void;
}) {
    const isNew = row === null;
    const [form, setForm] = useState<BankAccountFormState>(() =>
        row ? bankAccountFormFrom(row) : emptyBankAccountForm(bankCode),
    );
    const [submitted, setSubmitted] = useState(false);
    const [saving, setSaving] = useState(false);
    const first = useRef<HTMLInputElement | null>(null);

    useEffect(() => {
        focusNoScroll(first.current);
    }, []);

    const errors = useMemo(() => validateBankAccountForm(form), [form]);
    const bankOptions = banks.filter((b) => b.active !== false || b.code === form.bank_code);

    async function save() {
        setSubmitted(true);
        if (Object.keys(errors).length > 0) {
            errorToast('This account is not ready to save', { description: Object.values(errors)[0] });
            return;
        }
        setSaving(true);
        try {
            const result = await saveBankAccount({
                id: row?.id ?? null,
                expectedRowVersion: isNew ? null : (row?.row_version ?? null),
                patch: { ...bankAccountPatchFrom(form), ...activePatch(form.active) },
            });
            if (!result.ok) {
                errorToast(isNew ? 'The account was not added' : 'The account was not saved', {
                    description: result.message ?? `The database refused the write (${result.outcome}).`,
                });
                return;
            }
            toast.success(isNew ? 'Account added — cheques can now be recorded on it.' : 'Account saved');
            onSaved();
        } finally {
            setSaving(false);
        }
    }

    return (
        <Dialog open onOpenChange={(o) => !o && onClose()}>
            <DialogContent className="animate-modal-enter flex max-h-[88dvh] w-[calc(100%-2rem)] max-w-md flex-col gap-0 overflow-hidden p-0">
                <DialogHeader className="shrink-0 border-b border-border bg-background/90 px-4 py-3 pr-12 backdrop-blur-sm">
                    <DialogTitle className="text-base">
                        {isNew ? 'Add a bank account' : 'Edit bank account'}
                    </DialogTitle>
                    <DialogDescription className="text-xs">
                        A cheque book&rsquo;s home. A cheque number is unique within one account, so this is
                        half of how a cheque is identified.
                    </DialogDescription>
                </DialogHeader>

                <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
                    <div className="grid gap-4">
                        <FormField label="Bank" htmlFor="acct-bank" error={submitted ? errors.bank_code : undefined}>
                            <Select
                                value={form.bank_code || undefined}
                                onValueChange={(v) => setForm((f) => ({ ...f, bank_code: v }))}
                            >
                                <SelectTrigger id="acct-bank" className="h-9 w-full text-sm">
                                    <SelectValue placeholder="Choose a bank" />
                                </SelectTrigger>
                                <SelectContent className="bg-popover/95 backdrop-blur-lg">
                                    {bankOptions.map((b) => (
                                        <SelectItem key={b.code ?? ''} value={b.code ?? ''} className="text-sm">
                                            <span className="font-medium">{b.display_name ?? b.code}</span>
                                            {b.active === false ? (
                                                <span className="ml-1.5 text-[10px] italic text-muted-foreground">
                                                    retired
                                                </span>
                                            ) : null}
                                        </SelectItem>
                                    ))}
                                </SelectContent>
                            </Select>
                        </FormField>

                        <FormField
                            label="Account label"
                            htmlFor="acct-label"
                            error={submitted ? errors.account_label : undefined}
                            hint="What a person picks from, e.g. “current - Cebu”."
                        >
                            <Input
                                id="acct-label"
                                ref={first}
                                value={form.account_label}
                                onChange={(e) => setForm((f) => ({ ...f, account_label: e.target.value }))}
                                placeholder="current - Cebu"
                                className="h-9 text-sm"
                            />
                        </FormField>

                        <FormField
                            label="Account number"
                            htmlFor="acct-no"
                            hint="Secondary detail — never front-of-screen. Leave blank until you have the real number."
                        >
                            <Input
                                id="acct-no"
                                value={form.account_no}
                                onChange={(e) => setForm((f) => ({ ...f, account_no: e.target.value }))}
                                placeholder="Optional"
                                className="h-9 font-mono text-sm"
                            />
                        </FormField>

                        <div className="grid gap-4 sm:grid-cols-2">
                            <FormField
                                label="Order"
                                htmlFor="acct-sort"
                                error={submitted ? errors.sort_order : undefined}
                            >
                                <Input
                                    id="acct-sort"
                                    type="number"
                                    step="10"
                                    value={form.sort_order}
                                    onChange={(e) => setForm((f) => ({ ...f, sort_order: e.target.value }))}
                                    className="h-9 text-right font-mono text-sm tabular-nums"
                                />
                            </FormField>
                            <FormField label="Status" htmlFor="acct-active" hint="Retired hides it from the pickers.">
                                <Select
                                    value={form.active ? 'active' : 'retired'}
                                    onValueChange={(v) => setForm((f) => ({ ...f, active: v === 'active' }))}
                                >
                                    <SelectTrigger id="acct-active" className="h-9 w-full text-sm">
                                        <SelectValue />
                                    </SelectTrigger>
                                    <SelectContent className="bg-popover/95 backdrop-blur-lg">
                                        <SelectItem value="active" className="text-sm">In use</SelectItem>
                                        <SelectItem value="retired" className="text-sm">Retired</SelectItem>
                                    </SelectContent>
                                </Select>
                            </FormField>
                        </div>

                        <FormField label="Notes" htmlFor="acct-notes">
                            <Textarea
                                id="acct-notes"
                                value={form.notes}
                                onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))}
                                rows={2}
                                placeholder="Optional"
                                className="min-h-[2.5rem] text-sm"
                            />
                        </FormField>
                    </div>
                </div>

                <DialogFooter className="shrink-0 gap-2 border-t border-border bg-background/90 px-4 py-3 backdrop-blur-sm sm:justify-end">
                    <Button variant="outline" size="sm" onClick={onClose} disabled={saving}>
                        Cancel
                    </Button>
                    <Button size="sm" onClick={save} disabled={saving}>
                        {saving ? <Loader2 className="size-3.5 animate-spin" /> : null}
                        {isNew ? 'Add account' : 'Save changes'}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}

function FormField({
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
