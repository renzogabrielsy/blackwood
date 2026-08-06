'use client';

// ─────────────────────────────────────────────────────────────────────────────────
// SUPPLIER BALANCES — §7a screen 1, and the screen Renzo actually asked for.
//
// One row per trader: what CI owes, what CI has paid, and the running difference. A
// parent trader renders as a group row with its sub-suppliers nested and indented
// beneath, each carrying its own number as well as the group total. Today all twelve
// traders are roots, so the flat case is the one on screen — but the nested case is
// built, because a group of one drawn as "header + one identical child" would be noise
// and the code has to know the difference either way.
//
// THREE THINGS THIS SCREEN HAS TO GET RIGHT. Each is the difference between an honest
// number and a misleading one, and each is a rule, not a preference.
//
// ── 1. THE SIGN IS SAID IN WORDS, ON THE SCREEN ──────────────────────────────────
// `running_balance_php = payments − receipts`, so NEGATIVE MEANS WE OWE THEM. That is
// the OPPOSITE of the accounting convention, which means a reader with an accountant's
// reflexes will read every row backwards and have no reason to suspect it. A tooltip
// cannot fix that — nobody hovers over something they are already sure of. So the rule
// is printed in the header band, and every balance carries a `we owe` / `they owe` tag
// beside the figure. A bare minus never appears on its own anywhere on this screen.
//
// ── 2. A NON-ZERO BALANCE IS NEVER AN ERROR ──────────────────────────────────────
// Decision 8 killed the per-supplier rounding rule outright: traders deliberately carry
// remainders, and 447 of 971 receipts are not a whole peso. ₱132.875 outstanding is
// ordinary business. There is therefore no red, no "unreconciled" badge, no warning
// icon, no auto-close anywhere below — the balance column is rendered in plain
// foreground whatever its value, and the ONLY emphasis on the row is reserved for
// something that genuinely needs attention (see 3). Nothing here may acquire an error
// state later without re-reading decision 8.
//
// ── 3. THE REAL WARNING IS INVISIBLE IN PESOS ────────────────────────────────────
// `total_price_php` COALESCEs both its factors to zero, so an unweighed receipt reads
// ₱0 rather than NULL. `SUM(total_price_php)` and `SUM(…) FILTER (priceable)` are
// therefore numerically IDENTICAL on every supplier, forever: the balance is
// arithmetically CORRECT while silently carrying receipts nobody can price, and no
// amount anywhere reveals the gap.
//
// SEVILLA is the live proof — balance ₱0.00, and two receipts that cannot be priced. A
// screen that showed only the money would say SEVILLA is square. It is not. So
// `unpriced_receipt_count` is a first-class COLUMN, never a hover, and it is the one
// place on the row that carries emphasis. The wording names the STAGE ("2 awaiting
// weight") because the view partitions the count exhaustively — and it says PENDING,
// never BROKEN: "priced but not yet weighed" is the normal state of a receipt entered
// this morning, and calling that an error is how a column gets ignored.
//
// ── 4. A CARRIED-FORWARD ROW MUST SAY SO (2026-08-06, opening balances) ──────────
// Once a trader has a stated opening balance, its BALANCE / RECEIPTS / PAID figures cover
// only what is dated ON OR AFTER the as-of date. A row like that looks exactly like a row
// derived from all 971 receipts, and the two readings differ by ₱200M. So:
//
//   • `opening_as_of_date` is on the row in its own OPENING column, AND repeated in the
//     FROZEN trader cell — the frozen column is the only one that cannot scroll out of
//     view, so the qualifier that changes the meaning of every other cell belongs there.
//   • `carried_receipt_count` / `carried_receipt_php` get their own STANDS IN FOR column.
//     That pair is what makes a stated figure checkable later ("this ₱4.2M stands in for
//     275 receipts, ₱207,917,771.25"); without it nobody can ever audit the number.
//   • The full history (`*_all_php`) is a SCREEN-LEVEL LENS, not a second figure crammed
//     into every cell. One number per cell, always; "what does the raw history say" is one
//     click away instead of one more column wide.
//   • The unpriced count stays ALL-TIME in both lenses. An unpriced receipt from before the
//     cutoff CANNOT have been folded into the opening balance, because nobody knows what it
//     is worth — windowing it would make SEVILLA's two unpriceable receipts vanish the
//     moment an opening balance is stated, while they are still unpriceable and still
//     covered by nothing.
// ─────────────────────────────────────────────────────────────────────────────────

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { ChevronRight, Landmark, Network, Receipt } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

import { InlineError } from './payments-panel';
import { OpeningBalanceDialog } from './opening-balance-dialog';
import { PaymentsPanel } from './payments-panel';
import {
    BALANCE_COLS,
    LENS_NOTE,
    SIGN_NOTE,
    UNASSIGNED_NOTE,
    UNASSIGNED_TITLE,
    balanceDirection,
    buildBalanceTree,
    carriedCountLabel,
    carriedTitle,
    directionLabel,
    directionSentence,
    formatCount,
    formatDate,
    formatKg,
    formatPeso,
    groupAsOf,
    groupAsOfLabel,
    groupAsOfTitle,
    minBalanceTableWidth,
    num,
    unpricedPhrase,
    unpricedShort,
    type BalanceDirection,
    type BalanceLens,
    type BankAccountRow,
    type SupplierBalanceRow,
    type SupplierGroupBalanceRow,
    type SupplierGroupRow,
} from './types';

const MIN_W = minBalanceTableWidth();

/**
 * One line of the table, flattened out of the group tree.
 *
 * Every measure below is COPIED off a view row. Nothing on this screen adds two numbers
 * together: `view_rc_supplier_group_balance` already rolled the members up in SQL, on
 * top of the per-supplier view, so a group total and the sum of its visible rows cannot
 * disagree. CLAUDE.md: never calculate a balance in TypeScript.
 */
interface Line {
    key: string;
    kind: 'group' | 'member' | 'flat' | 'unassigned';
    name: string;
    /** The payee code — `null` on a group header and on the no-payee bucket. */
    code: string | null;
    /** Secondary text under the name: the group's size, or a child's parent. */
    sub: string | null;
    measures: Measures;
    opening: OpeningCell;
    /**
     * The underlying per-supplier row, so the opening-balance dialog opens pre-filled with
     * no round trip. `null` on a group header (a group is not a supplier and cannot carry
     * an opening balance of its own) and on the no-payee bucket.
     */
    row: SupplierBalanceRow | null;
}

/**
 * Every field here is COPIED off a view column — the lens only chooses WHICH column, it
 * never combines two. `view_rc_supplier_group_balance` already rolled the members up in
 * SQL on top of the per-supplier view, so a group total and the sum of its visible rows
 * cannot disagree. CLAUDE.md: never calculate a balance in TypeScript.
 */
interface Measures {
    balance: number | string | null;
    receipts: number | string | null;
    paid: number | string | null;
    receipt_count: number | string | null;
    /**
     * ALL-TIME in BOTH lenses, on purpose — the same deliberate asymmetry as the unpriced
     * counts. An unassigned remainder on a payment dated BEFORE an opening-balance cutoff
     * is still money nobody has pointed at a receipt; windowing it away would hide a live
     * operational fact behind a stated figure. `advance_php_window` exists for a screen
     * that wants both; the all-time one is primary.
     */
    advance_php: number | string | null;
    advance_payment_count: number | string | null;
    /** ALL-TIME in BOTH lenses, on purpose. See rule 4 in the header. */
    unpriced_receipt_count: number | string | null;
    unpriced_receipt_kg: number | string | null;
    unpriced_awaiting_weight_count: number | string | null;
    unpriced_awaiting_price_count: number | string | null;
    unpriced_awaiting_both_count: number | string | null;
    /** The windowed twin — used ONLY to explain the all-time count, never to replace it. */
    unpriced_receipt_count_window: number | string | null;
    carried_receipt_count: number | string | null;
    carried_receipt_php: number | string | null;
    /** Whole history in both lenses: "last receipt" means the last one. */
    last_receipt_date: string | null;
    last_payment_date: string | null;
}

function measuresOf(r: SupplierBalanceRow | SupplierGroupBalanceRow, lens: BalanceLens): Measures {
    const all = lens === 'all';
    return {
        balance: all ? r.running_balance_all_php : r.running_balance_php,
        receipts: all ? r.receipts_all_php : r.receipts_php,
        paid: all ? r.payments_all_php : r.payments_php,
        receipt_count: all ? r.receipt_count_all : r.receipt_count,
        advance_php: r.advance_php,
        advance_payment_count: r.advance_payment_count,
        unpriced_receipt_count: r.unpriced_receipt_count,
        unpriced_receipt_kg: r.unpriced_receipt_kg,
        unpriced_awaiting_weight_count: r.unpriced_awaiting_weight_count,
        unpriced_awaiting_price_count: r.unpriced_awaiting_price_count,
        unpriced_awaiting_both_count: r.unpriced_awaiting_both_count,
        unpriced_receipt_count_window: r.unpriced_receipt_count_window,
        carried_receipt_count: r.carried_receipt_count,
        carried_receipt_php: r.carried_receipt_php,
        last_receipt_date: r.last_receipt_date,
        last_payment_date: r.last_payment_date,
    };
}

/**
 * What the OPENING column shows, resolved for a supplier row and a group row alike.
 *
 * A GROUP's members may legitimately be stated as of DIFFERENT dates, so there is often no
 * single group as-of date at all — `groupAsOf` reads the honest three columns the rollup
 * exposes (`opening_as_of_date`, NULL unless the members agree, plus `_min` / `_max`) and
 * this NEVER prints a date that is only true for some of them.
 */
interface OpeningCell {
    has: boolean;
    amount: number | string | null;
    /** Second line of the OPENING cell. Empty when nothing has been stated. */
    label: string;
    /**
     * The frozen column's carry-forward marker. Built HERE, alongside `label`, so neither
     * render site has to take a formatted string apart again to reuse it.
     */
    marker: string;
    title: string;
}

function openingOf(r: SupplierBalanceRow, name: string): OpeningCell {
    const has = r.has_opening_balance === true;
    const date = formatDate(r.opening_as_of_date);
    return {
        has,
        amount: r.opening_balance_php,
        label: has ? `as of ${date}` : '',
        marker: has ? `carried forward from ${date}` : '',
        title: has
            ? carriedTitle(r, name)
            : 'No starting balance has been stated for this trader, so every figure on this row covers its whole history.',
    };
}

function groupOpeningOf(g: SupplierGroupBalanceRow, name: string): OpeningCell {
    const a = groupAsOf(g);
    const has = a.kind !== 'none';
    return {
        has,
        amount: g.opening_balance_php,
        label: groupAsOfLabel(a),
        // NEVER a single date that is only true for some members. When they disagree the
        // marker says "various dates" rather than picking one, which is exactly what
        // `opening_as_of_date` being NULL on the rollup is there to force.
        marker:
            a.kind === 'all'
                ? `carried forward from ${a.date}`
                : a.kind === 'partial'
                  ? `${a.stated} of ${a.total} carried forward from ${a.date}`
                  : a.kind === 'range'
                    ? 'carried forward from various dates'
                    : '',
        // The group's own carried figures, plus WHY there may be no single date. Both
        // matter: the first makes the total checkable, the second stops a reader assuming
        // one member's date covers the whole group.
        title: has ? `${groupAsOfTitle(a)} ${carriedTitle(g, name)}` : groupAsOfTitle(a),
    };
}

/** The no-payee bucket can NEVER carry an opening balance — the FK forbids it. */
const UNASSIGNED_OPENING: OpeningCell = {
    has: false,
    amount: 0,
    label: '',
    marker: '',
    title:
        'Receipts with no payee can never carry a starting balance — a stated balance belongs to a trader, and these receipts name none.',
};

export interface LiquidationViewProps {
    suppliers: SupplierBalanceRow[];
    groups: SupplierGroupBalanceRow[];
    /** The payee picker for the payment form — every trader, not only those with a balance. */
    dimensionSuppliers: SupplierGroupRow[];
    accounts: BankAccountRow[];
    loadError: string | null;
}

export function LiquidationView({
    suppliers,
    groups,
    dimensionSuppliers,
    accounts,
    loadError,
}: LiquidationViewProps) {
    const router = useRouter();
    const [panel, setPanel] = useState<{ code: string; name: string; advancesOnly: boolean } | null>(
        null,
    );
    const [panelOpen, setPanelOpen] = useState(false);
    const [opening, setOpening] = useState<{ row: SupplierBalanceRow; name: string } | null>(null);
    const [openingOpen, setOpeningOpen] = useState(false);
    /**
     * Which set of figures the money columns read. `stated` is the windowed reading (the
     * default); `all` is the raw history with no opening term — exactly what this screen
     * showed before opening balances existed, kept so a stated figure stays auditable.
     */
    const [lens, setLens] = useState<BalanceLens>('stated');

    const lines = useMemo<Line[]>(() => {
        const out: Line[] = [];
        for (const g of buildBalanceTree(suppliers, groups)) {
            if (g.unassigned) {
                out.push({
                    key: g.key,
                    kind: 'unassigned',
                    name: g.group.group_display_name ?? '(no payee recorded)',
                    code: null,
                    sub: UNASSIGNED_NOTE,
                    measures: measuresOf(g.group, lens),
                    opening: UNASSIGNED_OPENING,
                    row: null,
                });
                continue;
            }

            if (g.nested) {
                const groupName = g.group.group_display_name ?? g.key;
                out.push({
                    key: `g:${g.key}`,
                    kind: 'group',
                    name: groupName,
                    code: null,
                    sub: `${g.members.length} traders in this group`,
                    measures: measuresOf(g.group, lens),
                    opening: groupOpeningOf(g.group, groupName),
                    // A group is not a supplier: `rc_supplier_opening_balance.supplier_code`
                    // is a real trader, so an opening balance is stated per member and never
                    // on the header.
                    row: null,
                });
                for (const m of g.members) {
                    const name = m.display_name ?? m.supplier_code ?? '';
                    out.push({
                        key: `m:${m.supplier_code ?? ''}`,
                        kind: 'member',
                        name,
                        code: m.supplier_code,
                        sub: null,
                        measures: measuresOf(m, lens),
                        opening: openingOf(m, name),
                        row: m,
                    });
                }
                continue;
            }

            const only = g.members[0];
            if (!only) continue;
            const name = only.display_name ?? only.supplier_code ?? '';
            out.push({
                key: `f:${only.supplier_code ?? g.key}`,
                kind: 'flat',
                name,
                code: only.supplier_code,
                sub: null,
                measures: measuresOf(only, lens),
                opening: openingOf(only, name),
                row: only,
            });
        }
        return out;
    }, [suppliers, groups, lens]);

    /**
     * Open one trader's payments. `advancesOnly` is the drill-down from the NOT YET
     * ASSIGNED cell — the panel opens with its "money left" filter already on, which is
     * the whole of Step 5: an advance is a payment with an unassigned remainder, so the
     * way in is a filter rather than a screen.
     */
    function openPanel(code: string, name: string, advancesOnly = false) {
        setPanel({ code, name, advancesOnly });
        setPanelOpen(true);
    }

    function openOpeningDialog(row: SupplierBalanceRow, name: string) {
        setOpening({ row, name });
        setOpeningOpen(true);
    }

    return (
        <div className="flex min-h-0 flex-1 flex-col">
            {/* ── The rule, in words, before any number ────────────────────────── */}
            <div className="animate-fade-up shrink-0 border-b border-border px-4 py-3">
                <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                        <p className="text-sm font-medium">{SIGN_NOTE}</p>
                        <p className="mt-0.5 max-w-2xl text-xs text-muted-foreground">
                            A balance that is not zero is normal — traders often carry a remainder on
                            purpose. What does need looking at is the{' '}
                            <span className="font-medium text-foreground">not yet priced</span> column: those
                            receipts count as ₱0 in the balance, so a trader can read as square while still
                            being owed for them.
                        </p>
                        <p className="mt-1.5 max-w-2xl text-xs text-muted-foreground">{LENS_NOTE[lens]}</p>
                    </div>
                    <div className="flex shrink-0 flex-wrap items-center gap-2">
                        <LensSwitch value={lens} onChange={setLens} />
                        <Button asChild variant="outline" size="sm" className="h-8 text-xs">
                            <Link href="/cenapro/liquidation/banks">
                                <Landmark className="size-3.5" />
                                Banks &amp; accounts
                            </Link>
                        </Button>
                        <Button asChild variant="outline" size="sm" className="h-8 text-xs">
                            <Link href="/cenapro/liquidation/subgroups">
                                <Network className="size-3.5" />
                                Supplier subgroups
                            </Link>
                        </Button>
                    </div>
                </div>
            </div>

            {loadError ? <InlineError message={loadError} /> : null}

            {/* ── The table. Never crush, always scroll. ───────────────────────── */}
            <div className="min-h-0 flex-1 overflow-auto">
                {lines.length === 0 && !loadError ? (
                    <div className="animate-fade-up p-10 text-center">
                        <p className="text-sm font-medium">No supplier balances yet</p>
                        <p className="mx-auto mt-1 max-w-md text-xs text-muted-foreground">
                            Nothing has been received or paid, so there is nothing to liquidate.
                        </p>
                    </div>
                ) : (
                    <table
                        className="w-full table-fixed text-xs"
                        // `separate` + `border-spacing: 0` is MANDATORY, never
                        // `border-collapse` — under the collapsed-border model a border
                        // belongs to the TABLE rather than the cell, and a sticky cell's
                        // own background stops painting reliably, so scrolling content
                        // bleeds straight through the frozen TRADER column. Measured live
                        // before this change. The row rules already live on the CELLS
                        // (`border-b`), which is exactly what the separated model paints,
                        // so this costs nothing. Same idiom as `rc-movement-matrix.tsx`
                        // and `production-ledger-grid.tsx`.
                        style={{ minWidth: MIN_W, borderCollapse: 'separate', borderSpacing: 0 }}
                    >
                        <colgroup>
                            {BALANCE_COLS.map((c) => (
                                <col key={c.key} style={{ width: c.width }} />
                            ))}
                        </colgroup>
                        <thead>
                            <tr>
                                {BALANCE_COLS.map((c, i) => (
                                    <th
                                        key={c.key}
                                        title={c.title}
                                        // Frozen surfaces overlap SCROLLING content, so they are
                                        // fully OPAQUE — solid `bg-muted`, never glass. Any alpha
                                        // lets the moving cells bleed through.
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
                            {lines.map((line) => (
                                <BalanceRow
                                    key={line.key}
                                    line={line}
                                    lens={lens}
                                    onOpen={() => line.code && openPanel(line.code, line.name)}
                                    onOpenAdvances={
                                        line.code
                                            ? () => openPanel(line.code!, line.name, true)
                                            : undefined
                                    }
                                    onSetOpening={
                                        line.row
                                            ? () => openOpeningDialog(line.row!, line.name)
                                            : undefined
                                    }
                                />
                            ))}
                        </tbody>
                    </table>
                )}
            </div>

            <PaymentsPanel
                open={panelOpen}
                onOpenChange={(o) => {
                    setPanelOpen(o);
                    if (!o) setPanel(null);
                }}
                supplierCode={panel?.code ?? null}
                supplierName={panel?.name ?? ''}
                initialAdvanceOnly={panel?.advancesOnly ?? false}
                suppliers={dimensionSuppliers}
                accounts={accounts}
                onChanged={() => router.refresh()}
            />

            {opening ? (
                <OpeningBalanceDialog
                    open={openingOpen}
                    onOpenChange={(o) => {
                        setOpeningOpen(o);
                        if (!o) setOpening(null);
                    }}
                    supplierCode={opening.row.supplier_code ?? ''}
                    supplierName={opening.name}
                    current={{
                        hasOpeningBalance: opening.row.has_opening_balance === true,
                        openingBalancePhp: opening.row.opening_balance_php,
                        openingAsOfDate: opening.row.opening_as_of_date,
                        firstReceiptDate: opening.row.first_receipt_date,
                        receiptCountAll: opening.row.receipt_count_all,
                        runningBalanceAllPhp: opening.row.running_balance_all_php,
                    }}
                    onSaved={() => router.refresh()}
                />
            ) : null}
        </div>
    );
}

/**
 * The stated reading vs the raw history.
 *
 * A real radio group rather than two toggles: the options are mutually exclusive, and this
 * is the control that answers "what did my stated figure actually change?" — the question
 * that keeps an opening balance auditable. Both readings come straight from the view;
 * nothing here adds or subtracts anything.
 */
function LensSwitch({
    value,
    onChange,
}: {
    value: BalanceLens;
    onChange: (v: BalanceLens) => void;
}) {
    const options: readonly { value: BalanceLens; label: string; title: string }[] = [
        {
            value: 'stated',
            label: 'As stated',
            title: 'Each trader’s stated opening balance plus everything dated on or after its as-of date. Traders with no opening balance show their whole history.',
        },
        {
            value: 'all',
            label: 'Full history',
            title: 'Every receipt and payment ever recorded, with NO opening balance applied — what this screen showed before starting balances existed. Kept so a stated figure can always be checked against the raw numbers.',
        },
    ];

    return (
        <div
            role="radiogroup"
            aria-label="Which figures to show"
            className="inline-flex h-8 overflow-hidden rounded-md border border-input"
            onKeyDown={(e) => {
                if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
                    e.preventDefault();
                    onChange('stated');
                } else if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
                    e.preventDefault();
                    onChange('all');
                }
            }}
        >
            {options.map((o, i) => {
                const active = o.value === value;
                return (
                    <button
                        key={o.value}
                        type="button"
                        role="radio"
                        aria-checked={active}
                        // One tab stop for the group, arrows to move within it — how a
                        // radio group is expected to behave.
                        tabIndex={active ? 0 : -1}
                        title={o.title}
                        onClick={() => onChange(o.value)}
                        className={cn(
                            'px-2.5 text-xs transition-all duration-150 focus-visible:z-10 focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50',
                            i > 0 && 'border-l border-input',
                            active
                                ? 'bg-primary font-medium text-primary-foreground'
                                : 'text-muted-foreground hover:bg-muted hover:text-foreground',
                        )}
                    >
                        {o.label}
                    </button>
                );
            })}
        </div>
    );
}

// ─── One line ───────────────────────────────────────────────────────────────────

function BalanceRow({
    line,
    lens,
    onOpen,
    onOpenAdvances,
    onSetOpening,
}: {
    line: Line;
    lens: BalanceLens;
    onOpen: () => void;
    /**
     * Open this trader's payments filtered to the ones still carrying unassigned money.
     * Absent on a group header and the no-payee row, which have no payments of their own.
     */
    onOpenAdvances?: () => void;
    /** Absent on a group header and on the no-payee row — neither can carry an opening. */
    onSetOpening?: () => void;
}) {
    const m = line.measures;
    const dir = balanceDirection(m.balance);
    const advance = num(m.advance_php) ?? 0;
    const advanceCount = num(m.advance_payment_count) ?? 0;
    const unpricedCount = num(m.unpriced_receipt_count) ?? 0;
    const unpricedKg = num(m.unpriced_receipt_kg) ?? 0;
    const unpricedWindow = num(m.unpriced_receipt_count_window) ?? 0;
    const isGroup = line.kind === 'group';
    const isUnassigned = line.kind === 'unassigned';
    const clickable = line.code !== null;
    const op = line.opening;
    /**
     * In the FULL-HISTORY lens the opening term is not applied, so the stated figure and
     * what it stands in for are still FACTS but are not part of the numbers on this row.
     * Dimmed and re-titled rather than blanked: hiding them would make the two lenses look
     * like two different datasets.
     */
    const openingApplies = lens === 'stated';
    const carriedCount = num(m.carried_receipt_count) ?? 0;

    // Row rules live on the CELLS. A border on a `<tr>` is never painted in the
    // separated-borders model this table uses, so a `<tr>` border would silently do
    // nothing.
    //
    // EVERY row tint here is a SOLID token, never `/40` or `/20`. A translucent tint on a
    // frozen cell is not a style choice, it is a bleed: `cn()` resolves two `bg-*`
    // utilities to the LAST one, so a translucent tint listed after the opaque base
    // REPLACES it rather than layering over it, and the sticky cell goes see-through.
    // That is exactly what happened to the no-payee row — measured at alpha 0.2, with
    // scrolling figures visible straight through the trader name.
    const cell = cn(
        'border-b border-border px-2 py-1 align-middle transition-all duration-150',
        isGroup && 'bg-muted font-medium',
        isUnassigned && 'bg-muted',
    );
    const numCell = cn(cell, 'text-right font-mono tabular-nums');

    return (
        <tr
            className={cn('group h-8', clickable && 'cursor-pointer hover:bg-muted/50')}
            onClick={clickable ? onOpen : undefined}
            // A row that opens a panel is a control, so it answers the keyboard too.
            // Group headers and the no-payee bucket are not clickable and stay out of
            // the tab order rather than presenting a control that does nothing.
            tabIndex={clickable ? 0 : undefined}
            role={clickable ? 'button' : undefined}
            aria-label={clickable ? `Payments to ${line.name}` : undefined}
            onKeyDown={
                clickable
                    ? (e) => {
                          if (e.key === 'Enter' || e.key === ' ') {
                              e.preventDefault();
                              onOpen();
                          }
                      }
                    : undefined
            }
        >
            {/* TRADER — frozen. The OPAQUE base is listed FIRST so `cell`'s solid row
                tint wins for a group / no-payee row, and a plain row keeps
                `bg-background`. Reversing that order is what made this cell translucent.
                The hover tint is a different variant, so it layers rather than replacing. */}
            <td
                className={cn(
                    'frozen-col frozen-edge left-0 bg-background',
                    cell,
                    clickable && 'group-hover:bg-muted/50',
                )}
            >
                <div className={cn('flex min-w-0 items-center gap-1', line.kind === 'member' && 'pl-4')}>
                    {line.kind === 'member' ? (
                        <span aria-hidden className="shrink-0 text-muted-foreground/50">
                            └
                        </span>
                    ) : null}
                    <span
                        className={cn(
                            'truncate',
                            isGroup && 'font-semibold',
                            isUnassigned && 'italic text-muted-foreground',
                        )}
                        title={line.sub ?? line.name}
                    >
                        {line.name}
                    </span>
                    {clickable ? (
                        <ChevronRight
                            aria-hidden
                            className="ml-auto size-3 shrink-0 text-muted-foreground/0 transition-colors duration-150 group-hover:text-muted-foreground/70"
                        />
                    ) : null}
                </div>
                {line.sub ? (
                    <div
                        className={cn(
                            'truncate text-[10px] leading-tight',
                            isUnassigned ? 'text-muted-foreground' : 'text-muted-foreground/80',
                            line.kind === 'member' && 'pl-4',
                        )}
                        title={isUnassigned ? UNASSIGNED_TITLE : line.sub}
                    >
                        {line.sub}
                    </div>
                ) : null}
                {/* THE CARRY-FORWARD MARKER, in the FROZEN column.
                    Repeated here rather than left to the OPENING column because this is the
                    only column that cannot scroll out of view — and it is the qualifier that
                    changes what every other cell on the row means. Without it a windowed row
                    is indistinguishable from a whole-history one, and the two readings differ
                    by ₱200M on the biggest traders. */}
                {op.has && openingApplies && op.marker ? (
                    <div
                        className={cn(
                            'truncate text-[10px] leading-tight text-muted-foreground/80',
                            line.kind === 'member' && 'pl-4',
                        )}
                        title={op.title}
                    >
                        {op.marker}
                    </div>
                ) : null}
            </td>

            {/* BALANCE — accounting format, ₱ pinned left, figure pinned right.
                No colour, no badge, no warning: a non-zero balance is not an error. */}
            <td className={numCell}>
                <span className="flex items-baseline justify-between gap-2">
                    <span className="text-muted-foreground">₱</span>
                    <span className={cn(dir === 'square' && 'text-muted-foreground')}>
                        {formatPeso(m.balance)}
                    </span>
                </span>
            </td>

            {/* The sign, in words. This is why a bare minus never stands alone.
                On the no-payee bucket the direction is REPLACED rather than shown: the
                figure is genuinely negative, but "we owe" invites the reader to write a
                cheque, and there is nobody to write it to. */}
            <td
                className={cell}
                title={isUnassigned ? UNASSIGNED_TITLE : directionSentence(dir, line.name)}
            >
                {isUnassigned ? (
                    <span className="inline-flex items-center rounded-sm border border-dashed border-border px-1 py-px text-[10px] leading-tight italic text-muted-foreground">
                        no payee
                    </span>
                ) : (
                    <DirectionTag dir={dir} />
                )}
            </td>

            {/* OPENING — the stated starting balance and the date it speaks for.
                No colour and no badge: a stated opening balance is an ordinary fact, and
                a trader without one is not in an error state either. */}
            <td className={cn(numCell, !openingApplies && 'opacity-50')}>
                {op.has ? (
                    <>
                        <span className="flex items-baseline justify-between gap-2">
                            <span className="text-muted-foreground">₱</span>
                            <span>{formatPeso(op.amount)}</span>
                        </span>
                        <span
                            className="block truncate text-left text-[10px] font-normal leading-tight text-muted-foreground"
                            title={
                                openingApplies
                                    ? op.title
                                    : `${op.title} It is NOT applied to the figures on this row while the full history is being shown.`
                            }
                        >
                            {op.label}
                        </span>
                    </>
                ) : (
                    <span className="text-muted-foreground/50" title={op.title}>
                        —
                    </span>
                )}
            </td>

            {/* STANDS IN FOR — the pair that makes a stated figure checkable later.
                Without it the opening balance is an unauditable assertion. */}
            <td className={cn(cell, !openingApplies && 'opacity-50')}>
                {op.has && carriedCount > 0 ? (
                    <span className="block truncate" title={op.title}>
                        <span className="block truncate leading-tight">
                            {carriedCountLabel(m.carried_receipt_count)}
                        </span>
                        <span className="block truncate font-mono text-[10px] leading-tight tabular-nums text-muted-foreground">
                            ₱{formatPeso(m.carried_receipt_php)}
                        </span>
                    </span>
                ) : op.has ? (
                    // A stated opening with nothing before its date. Legitimate — an
                    // opening dated before the first receipt states an outside balance —
                    // and saying so beats a bare dash the reader has to interpret.
                    <span className="truncate text-[10px] leading-tight text-muted-foreground" title={op.title}>
                        nothing before that date
                    </span>
                ) : (
                    <span className="text-muted-foreground/50" title={op.title}>
                        —
                    </span>
                )}
            </td>

            <td className={numCell}>
                <span className="flex items-baseline justify-between gap-2 text-muted-foreground">
                    <span>₱</span>
                    <span className="text-foreground">{formatPeso(m.receipts)}</span>
                </span>
            </td>

            <td className={numCell}>
                <span className="flex items-baseline justify-between gap-2 text-muted-foreground">
                    <span>₱</span>
                    <span className="text-foreground">{formatPeso(m.paid)}</span>
                </span>
            </td>

            {/* NOT YET ASSIGNED — the outstanding advance, and the drill-down into it.
                No colour and no badge: a trader carrying an advance is ordinary business,
                and §4.4 is explicit that an advance needs no feature of its own. Clicking
                it opens this trader's payments already filtered to the ones with money
                left, which is Step 5 in its entirety. */}
            <td className={numCell}>
                {advance > 0 ? (
                    <button
                        type="button"
                        className="w-full text-right transition-colors duration-150 hover:text-primary focus-visible:outline-none focus-visible:ring-[2px] focus-visible:ring-ring/50"
                        // The whole ROW is a button (it opens the unfiltered payments list),
                        // so this must not bubble or both would fire at once.
                        onClick={(e) => {
                            e.stopPropagation();
                            onOpenAdvances?.();
                        }}
                        onKeyDown={(e) => e.stopPropagation()}
                        disabled={!onOpenAdvances}
                        title={`₱${formatPeso(
                            advance,
                        )} has been paid to this trader without being pointed at any particular receipt${
                            advanceCount > 0
                                ? `, across ${advanceCount} payment${advanceCount === 1 ? '' : 's'}`
                                : ''
                        }. That is an outstanding advance — normal, and already counted inside PAID rather than on top of it. Whole history, never windowed. Open the payments with money left.`}
                    >
                        <span className="flex items-baseline justify-between gap-2">
                            <span className="text-muted-foreground">₱</span>
                            <span>{formatPeso(advance)}</span>
                        </span>
                        {advanceCount > 0 ? (
                            <span className="block text-right text-[10px] font-normal leading-tight text-muted-foreground">
                                {advanceCount} payment{advanceCount === 1 ? '' : 's'} with money left
                            </span>
                        ) : null}
                    </button>
                ) : (
                    <span
                        className="text-muted-foreground/50"
                        title="Every payment to this trader has been pointed at particular receipts — there is no outstanding advance."
                    >
                        —
                    </span>
                )}
            </td>

            <td className={numCell}>{formatCount(m.receipt_count)}</td>

            {/* NOT YET PRICED — the load-bearing warning, on the row and never on a hover.
                ALL-TIME, in both lenses and whatever the opening balance says. A receipt
                dated before the cutoff cannot have been folded into the opening balance
                either, because nobody knows what it is worth — so windowing this count
                would hide an outstanding unknown at the exact moment a figure was stated
                over the top of it. */}
            <td className={cell}>
                {unpricedCount > 0 ? (
                    <span
                        className="flex items-center gap-1 truncate text-amber-600 dark:text-amber-400"
                        title={`${unpricedPhrase(m)}${
                            unpricedKg > 0 ? ` · ${formatKg(unpricedKg)} kg known` : ''
                        }. They count as ₱0 in the balance above, so this trader may be owed more than it says.${
                            op.has && unpricedWindow < unpricedCount
                                ? ` This is the WHOLE history: ${
                                      unpricedCount - unpricedWindow
                                  } of them are dated before the starting balance, and it cannot have covered them — nobody knows what they are worth.`
                                : ''
                        }`}
                    >
                        <Receipt aria-hidden className="size-3 shrink-0" />
                        <span className="truncate">{unpricedShort(unpricedCount)}</span>
                    </span>
                ) : (
                    <span className="text-muted-foreground/50">—</span>
                )}
            </td>

            <td className={cn(cell, 'font-mono text-muted-foreground')}>
                {formatDate(m.last_receipt_date)}
            </td>
            <td className={cn(cell, 'font-mono text-muted-foreground')}>
                {formatDate(m.last_payment_date)}
            </td>

            {/* SET / REVISE the starting balance.
                Only on a real trader. A GROUP HEADER has none of its own — an opening
                balance belongs to a `rc_supplier` row, so it is stated per member — and the
                no-payee bucket can never have one at all. Neither gets a control that would
                do nothing. */}
            <td className={cn(cell, 'text-right')}>
                {onSetOpening ? (
                    <Button
                        variant="ghost"
                        size="sm"
                        className="h-6 px-1.5 text-[11px]"
                        // The whole ROW is a button (it opens the payments panel), so the
                        // click must not bubble or both would fire at once.
                        onClick={(e) => {
                            e.stopPropagation();
                            onSetOpening();
                        }}
                        onKeyDown={(e) => e.stopPropagation()}
                        title={
                            op.has
                                ? 'Revise this trader’s starting balance. Saving appends a revision — the current figure is kept.'
                                : 'State what was actually outstanding for this trader as of a date, and count forward from there.'
                        }
                    >
                        {op.has ? 'Revise opening' : 'Set opening'}
                    </Button>
                ) : isGroup ? (
                    <span
                        className="text-[10px] text-muted-foreground/70"
                        title="A starting balance belongs to a trader, so it is stated on each member of the group rather than on the group itself. The group total is the sum of theirs."
                    >
                        per trader
                    </span>
                ) : null}
            </td>
        </tr>
    );
}

/**
 * The word beside the figure.
 *
 * Deliberately NOT colour-coded by direction: "we owe them" is the ordinary state of
 * every trader in this ledger, and painting it red would mark the entire screen as a
 * problem. Emphasis on this screen belongs to the unpriced column and nowhere else.
 */
function DirectionTag({ dir }: { dir: BalanceDirection }) {
    return (
        <span
            className={cn(
                'inline-flex items-center rounded-sm border px-1 py-px text-[10px] leading-tight',
                dir === 'square'
                    ? 'border-transparent text-muted-foreground/60'
                    : 'border-border text-muted-foreground',
            )}
        >
            {directionLabel(dir)}
        </span>
    );
}
