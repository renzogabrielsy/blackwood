'use client';

// ─────────────────────────────────────────────────────────────────────────────────
// SUPPLIER SUBGROUPS — the maintenance screen. Liquidation Step 2's UI half.
//
// WHAT IT DOES, in one sentence the screen also says out loud: a cheque made out to the
// PARENT may legitimately settle a SUB-SUPPLIER's deliveries. Renzo's example —
// "Paquibot would have a subgroup of suppliers like Llanto… if a cheque is labeled
// Paquibot but is being assigned to a Llanto delivery, then it should push through".
//
// ── IT IS A PAYMENT FACT, NOT A DELIVERY FACT ────────────────────────────────────
// The link says WHO MAY BE PAID FOR WHOM. It changes nothing about the receipts
// themselves — no receipt moves, no weight or price is touched. That distinction is
// printed on the screen, because "grouping two suppliers" sounds like it merges their
// deliveries, and it does not.
//
// ── NEVER INFERRED ───────────────────────────────────────────────────────────────
// There is no "did you mean" here, no name-similarity suggestion, no auto-grouping, and
// there must never be one. A machine's guess about who may be paid for whom is silently
// wrong the first time two unrelated traders share a syllable — and the consequence of
// being wrong is a cheque that settles the wrong company's charcoal. The link is what a
// human states, and the act is audited (`cenapro.rc_supplier_audit`), because re-pointing
// a parent RETROACTIVELY changes which past payments were legitimate.
//
// ── ONE LEVEL, AND THE DATABASE IS THE ONE THAT SAYS SO ──────────────────────────
// A trader with sub-suppliers may not itself become one, and vice versa. The picker
// below leaves out the choices that would break that — which is what makes the refusal
// rare — but the rule lives in a CONSTRAINT TRIGGER, and when it fires its message is
// shown VERBATIM. It names the traders involved and tells the operator what to do
// instead ("…already has sub-supplier(s) (LLANTO)… move those sub-suppliers to X
// first"); re-wording that into "invalid parent" would throw the instruction away.
//
// `code` is not editable and is not in the RPC's allowlist: renaming a code moves every
// receipt that names it and splits its audit trail. That is a data migration, not a cell
// edit, and the screen says so rather than leaving the field mysteriously read-only.
// ─────────────────────────────────────────────────────────────────────────────────

import { useMemo, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { ArrowLeft, Loader2 } from 'lucide-react';

import { Button } from '@/components/ui/button';
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from '@/components/ui/select';
import { errorToast } from '@/lib/toast';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';

import { saveSupplierParent } from '../actions';
import { InlineError } from '../payments-panel';
import type { SupplierGroupRow } from '../types';

/** Radix reserves `value=""` for "cleared", so "no parent" needs a sentinel. */
const NO_PARENT = '__root__';

const COLS = [
    { key: 'trader', label: 'TRADER', width: 190 },
    { key: 'role', label: 'ROLE', width: 132 },
    { key: 'parent', label: 'PAID FOR BY', width: 250 },
    { key: 'children', label: 'SUB-SUPPLIERS', width: 280 },
] as const;

const MIN_W = COLS.reduce((s, c) => s + c.width, 0);

export function SubgroupsView({
    suppliers,
    loadError,
}: {
    suppliers: SupplierGroupRow[];
    loadError: string | null;
}) {
    const router = useRouter();
    const [pendingCode, setPendingCode] = useState<string | null>(null);
    const [, startTransition] = useTransition();

    /**
     * A trader may only be pointed at one that is itself a ROOT — that is the one-level
     * rule seen from the picker's side. Leaving the illegal choices out is what makes the
     * database's refusal rare; it is not the enforcement, which lives in the constraint
     * trigger and holds for raw SQL too.
     */
    const parentCandidates = useMemo(
        () => suppliers.filter((s) => !s.is_child),
        [suppliers],
    );

    function handleChange(row: SupplierGroupRow, value: string) {
        const code = row.code;
        const version = row.row_version;
        if (!code || version === null || version === undefined) return;

        const parentCode = value === NO_PARENT ? null : value;
        if ((row.parent_code ?? null) === parentCode) return;

        setPendingCode(code);
        startTransition(async () => {
            const result = await saveSupplierParent({ code, expectedRowVersion: version, parentCode });
            setPendingCode(null);

            if (!result.ok) {
                // The database's own words. It names the traders and says what to do next.
                errorToast(`The grouping for ${row.display_name ?? code} was not changed`, {
                    description: result.message ?? `The database refused the write (${result.outcome}).`,
                });
                return;
            }

            toast.success(
                parentCode
                    ? `${row.display_name ?? code} is now a sub-supplier of ${parentCode}`
                    : `${row.display_name ?? code} is a trader in its own right again`,
            );
            router.refresh();
        });
    }

    return (
        <div className="flex min-h-0 flex-1 flex-col">
            <div className="animate-fade-up shrink-0 border-b border-border px-4 py-3">
                <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0 max-w-3xl">
                        <p className="text-sm font-medium">
                            A cheque to the parent may settle a sub-supplier&rsquo;s deliveries.
                        </p>
                        <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
                            That is all this does. It is a fact about <em>payment</em> — who may be paid for
                            whom — not about the deliveries: no receipt moves, and no weight or price
                            changes. Groups are one level deep, and they are only ever what you state here.
                            Nothing is guessed from names, because a wrong guess means paying the wrong
                            company for someone else&rsquo;s charcoal. Every change is recorded, since
                            re-pointing a parent changes which past payments were legitimate.
                        </p>
                    </div>
                    <Button asChild variant="outline" size="sm" className="h-8 shrink-0 text-xs">
                        <Link href="/cenapro/liquidation">
                            <ArrowLeft className="size-3.5" />
                            Balances
                        </Link>
                    </Button>
                </div>
            </div>

            {loadError ? <InlineError message={loadError} /> : null}

            <div className="min-h-0 flex-1 overflow-auto">
                {suppliers.length === 0 && !loadError ? (
                    <div className="animate-fade-up p-10 text-center">
                        <p className="text-sm font-medium">No traders yet</p>
                        <p className="mt-1 text-xs text-muted-foreground">
                            There are no suppliers on the receipt ledger to group.
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
                            {COLS.map((c) => (
                                <col key={c.key} style={{ width: c.width }} />
                            ))}
                        </colgroup>
                        <thead>
                            <tr>
                                {COLS.map((c, i) => (
                                    <th
                                        key={c.key}
                                        className={cn(
                                            // Frozen surfaces sit ON TOP of scrolling cells, so they
                                            // are fully opaque — solid `bg-muted`, never glass.
                                            'border-b border-border bg-muted px-2 py-1.5 text-left text-[10px] font-semibold uppercase tracking-wide text-muted-foreground',
                                            i === 0 ? 'frozen-corner frozen-edge left-0' : 'frozen-row',
                                        )}
                                    >
                                        {c.label}
                                    </th>
                                ))}
                            </tr>
                        </thead>
                        <tbody>
                            {suppliers.map((s) => {
                                const busy = pendingCode === s.code;
                                const hasChildren = s.is_parent === true;
                                const childCodes = s.child_codes ?? [];

                                return (
                                    <tr key={s.code ?? ''} className="group h-9 hover:bg-muted/50">
                                        {/* Row rules on the CELLS — a border on a `<tr>` is ignored
                                            under `border-collapse: separate`. */}
                                        <td
                                            className={cn(
                                                'frozen-col frozen-edge left-0 border-b border-border bg-background px-2 py-1 align-middle transition-all duration-150 group-hover:bg-muted/50',
                                            )}
                                        >
                                            <div className="flex min-w-0 items-center gap-1.5">
                                                <span className="truncate font-medium" title={s.code ?? ''}>
                                                    {s.display_name ?? s.code}
                                                </span>
                                                {busy ? (
                                                    <Loader2 className="size-3 shrink-0 animate-spin text-muted-foreground" />
                                                ) : null}
                                            </div>
                                            {s.display_name !== s.code ? (
                                                <div className="truncate font-mono text-[10px] leading-tight text-muted-foreground/80">
                                                    {s.code}
                                                </div>
                                            ) : null}
                                        </td>

                                        <td className="border-b border-border px-2 py-1 align-middle text-muted-foreground transition-all duration-150">
                                            {hasChildren ? (
                                                <span className="text-foreground">
                                                    Parent · {childCodes.length} sub
                                                </span>
                                            ) : s.is_child ? (
                                                <span>Sub-supplier</span>
                                            ) : (
                                                <span className="text-muted-foreground/60">
                                                    Paid for itself
                                                </span>
                                            )}
                                        </td>

                                        <td className="border-b border-border px-2 py-1 align-middle transition-all duration-150">
                                            {hasChildren ? (
                                                // A trader with sub-suppliers cannot itself become one.
                                                // Said in words rather than presented as a disabled
                                                // control with no explanation.
                                                <span
                                                    className="text-[11px] text-muted-foreground"
                                                    title="Groups are one level deep. Move its sub-suppliers elsewhere first."
                                                >
                                                    Can&rsquo;t — it has sub-suppliers of its own
                                                </span>
                                            ) : (
                                                <Select
                                                    value={s.parent_code ?? NO_PARENT}
                                                    onValueChange={(v) => handleChange(s, v)}
                                                    disabled={busy}
                                                >
                                                    <SelectTrigger className="h-7 w-full text-xs" aria-label={`Parent trader for ${s.display_name ?? s.code}`}>
                                                        <SelectValue />
                                                    </SelectTrigger>
                                                    <SelectContent className="bg-popover/95 backdrop-blur-lg">
                                                        <SelectItem
                                                            value={NO_PARENT}
                                                            className="text-xs text-muted-foreground"
                                                        >
                                                            Nobody — paid for itself
                                                        </SelectItem>
                                                        {parentCandidates
                                                            .filter((p) => p.code !== s.code)
                                                            .map((p) => (
                                                                <SelectItem
                                                                    key={p.code ?? ''}
                                                                    value={p.code ?? ''}
                                                                    className="text-xs"
                                                                >
                                                                    {p.display_name ?? p.code}
                                                                </SelectItem>
                                                            ))}
                                                    </SelectContent>
                                                </Select>
                                            )}
                                        </td>

                                        <td
                                            className="max-w-[280px] truncate border-b border-border px-2 py-1 align-middle transition-all duration-150"
                                            title={childCodes.join(', ')}
                                        >
                                            {childCodes.length > 0 ? (
                                                <span className="font-mono text-[11px]">
                                                    {childCodes.join(', ')}
                                                </span>
                                            ) : (
                                                <span className="text-muted-foreground/50">—</span>
                                            )}
                                        </td>
                                    </tr>
                                );
                            })}
                        </tbody>
                    </table>
                )}
            </div>

            <div className="shrink-0 border-t border-border px-4 py-2">
                <p className="text-[11px] leading-snug text-muted-foreground">
                    A trader&rsquo;s <span className="font-mono">code</span> cannot be changed here on
                    purpose — renaming it would move every receipt that names it and split its history.
                    Retiring a trader is done by marking it inactive, never by deleting it, so old payments
                    keep naming it.
                </p>
            </div>
        </div>
    );
}
