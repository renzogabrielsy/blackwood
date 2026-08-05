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
// ─────────────────────────────────────────────────────────────────────────────────

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { ChevronRight, Landmark, Network, Receipt } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

import { InlineError } from './payments-panel';
import { PaymentsPanel } from './payments-panel';
import {
    BALANCE_COLS,
    SIGN_NOTE,
    UNASSIGNED_NOTE,
    UNASSIGNED_TITLE,
    balanceDirection,
    buildBalanceTree,
    directionLabel,
    directionSentence,
    formatCount,
    formatDate,
    formatKg,
    formatPeso,
    minBalanceTableWidth,
    num,
    unpricedPhrase,
    unpricedShort,
    type BalanceDirection,
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
}

interface Measures {
    running_balance_php: number | string | null;
    receipts_php: number | string | null;
    payments_php: number | string | null;
    receipt_count: number | string | null;
    unpriced_receipt_count: number | string | null;
    unpriced_receipt_kg: number | string | null;
    unpriced_awaiting_weight_count: number | string | null;
    unpriced_awaiting_price_count: number | string | null;
    unpriced_awaiting_both_count: number | string | null;
    last_receipt_date: string | null;
    last_payment_date: string | null;
}

function measuresOf(r: SupplierBalanceRow | SupplierGroupBalanceRow): Measures {
    return {
        running_balance_php: r.running_balance_php,
        receipts_php: r.receipts_php,
        payments_php: r.payments_php,
        receipt_count: r.receipt_count,
        unpriced_receipt_count: r.unpriced_receipt_count,
        unpriced_receipt_kg: r.unpriced_receipt_kg,
        unpriced_awaiting_weight_count: r.unpriced_awaiting_weight_count,
        unpriced_awaiting_price_count: r.unpriced_awaiting_price_count,
        unpriced_awaiting_both_count: r.unpriced_awaiting_both_count,
        last_receipt_date: r.last_receipt_date,
        last_payment_date: r.last_payment_date,
    };
}

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
    const [panel, setPanel] = useState<{ code: string; name: string } | null>(null);
    const [panelOpen, setPanelOpen] = useState(false);

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
                    measures: measuresOf(g.group),
                });
                continue;
            }

            if (g.nested) {
                out.push({
                    key: `g:${g.key}`,
                    kind: 'group',
                    name: g.group.group_display_name ?? g.key,
                    code: null,
                    sub: `${g.members.length} traders in this group`,
                    measures: measuresOf(g.group),
                });
                for (const m of g.members) {
                    out.push({
                        key: `m:${m.supplier_code ?? ''}`,
                        kind: 'member',
                        name: m.display_name ?? m.supplier_code ?? '',
                        code: m.supplier_code,
                        sub: null,
                        measures: measuresOf(m),
                    });
                }
                continue;
            }

            const only = g.members[0];
            if (!only) continue;
            out.push({
                key: `f:${only.supplier_code ?? g.key}`,
                kind: 'flat',
                name: only.display_name ?? only.supplier_code ?? '',
                code: only.supplier_code,
                sub: null,
                measures: measuresOf(only),
            });
        }
        return out;
    }, [suppliers, groups]);

    function openPanel(code: string, name: string) {
        setPanel({ code, name });
        setPanelOpen(true);
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
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
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
                                    onOpen={() => line.code && openPanel(line.code, line.name)}
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
                suppliers={dimensionSuppliers}
                accounts={accounts}
                onChanged={() => router.refresh()}
            />
        </div>
    );
}

// ─── One line ───────────────────────────────────────────────────────────────────

function BalanceRow({ line, onOpen }: { line: Line; onOpen: () => void }) {
    const m = line.measures;
    const dir = balanceDirection(m.running_balance_php);
    const unpricedCount = num(m.unpriced_receipt_count) ?? 0;
    const unpricedKg = num(m.unpriced_receipt_kg) ?? 0;
    const isGroup = line.kind === 'group';
    const isUnassigned = line.kind === 'unassigned';
    const clickable = line.code !== null;

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
            </td>

            {/* BALANCE — accounting format, ₱ pinned left, figure pinned right.
                No colour, no badge, no warning: a non-zero balance is not an error. */}
            <td className={numCell}>
                <span className="flex items-baseline justify-between gap-2">
                    <span className="text-muted-foreground">₱</span>
                    <span className={cn(dir === 'square' && 'text-muted-foreground')}>
                        {formatPeso(m.running_balance_php)}
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

            <td className={numCell}>
                <span className="flex items-baseline justify-between gap-2 text-muted-foreground">
                    <span>₱</span>
                    <span className="text-foreground">{formatPeso(m.receipts_php)}</span>
                </span>
            </td>

            <td className={numCell}>
                <span className="flex items-baseline justify-between gap-2 text-muted-foreground">
                    <span>₱</span>
                    <span className="text-foreground">{formatPeso(m.payments_php)}</span>
                </span>
            </td>

            <td className={numCell}>{formatCount(m.receipt_count)}</td>

            {/* NOT YET PRICED — the load-bearing warning, on the row and never on a hover. */}
            <td className={cell}>
                {unpricedCount > 0 ? (
                    <span
                        className="flex items-center gap-1 truncate text-amber-600 dark:text-amber-400"
                        title={`${unpricedPhrase(m)}${
                            unpricedKg > 0 ? ` · ${formatKg(unpricedKg)} kg known` : ''
                        }. They count as ₱0 in the balance above, so this trader may be owed more than it says.`}
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
