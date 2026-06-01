'use client';

import * as React from 'react';
import { useRouter, usePathname } from 'next/navigation';
import { format as formatDate, parseISO, isValid as isValidDate } from 'date-fns';
import { Calendar, Copy, ArrowDownToLine, ArrowUpFromLine, Boxes, Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from '@/components/ui/select';
import {
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
} from '@/components/ui/table';
import { FLEC_WAREHOUSES, type FlecBalanceRow, type FlecLedgerRow, formatDisposition } from '../types';

// ─── Display helpers ─────────────────────────────────────────────────────────────
function fmtDate(iso: string | null): string {
    if (!iso) return '';
    const parsed = parseISO(iso);
    return isValidDate(parsed) ? formatDate(parsed, 'yyyy-MM-dd') : iso;
}
function fmtLongDate(iso: string): string {
    const parsed = parseISO(iso);
    return isValidDate(parsed) ? formatDate(parsed, 'MMM d, yyyy') : iso;
}
function fmtKg(n: number | null | undefined): string {
    if (n === null || n === undefined || Number.isNaN(n)) return '';
    return n.toLocaleString('en-US', { maximumFractionDigits: 0 });
}

// ─── Inline error banner (HARD RULE: persistent + Copy) ──────────────────────────
function ErrorBanner({ message }: { message: string }) {
    return (
        <div className="m-3 flex items-start gap-3 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm">
            <div className="min-w-0 flex-1">
                <p className="font-medium text-destructive">Couldn&apos;t load flec inventory</p>
                <p className="mt-1 break-words text-destructive/90">{message}</p>
                <p className="mt-1 text-xs text-muted-foreground">
                    This is expected until the <code className="font-mono">cenapro</code> schema is exposed to the API.
                </p>
            </div>
            <Button
                variant="ghost"
                size="sm"
                className="h-7 shrink-0 px-2 text-destructive hover:text-destructive"
                onClick={() => {
                    void navigator.clipboard.writeText(message).then(() => {
                        toast.success('Error copied to clipboard', { duration: 2000 });
                    });
                }}
            >
                <Copy className="mr-1 h-3.5 w-3.5" />
                Copy
            </Button>
        </div>
    );
}

// ─── Props ───────────────────────────────────────────────────────────────────────
interface FlecInventoryClientProps {
    warehouse: string;
    startDate: string;
    balances: FlecBalanceRow[];
    ledger: FlecLedgerRow[];
    loadError: string | null;
}

// ─── Main component ──────────────────────────────────────────────────────────────
export function FlecInventoryClient({
    warehouse,
    startDate,
    balances,
    ledger,
    loadError,
}: FlecInventoryClientProps) {
    const router = useRouter();
    const pathname = usePathname();
    const [isPending, startTransition] = React.useTransition();

    // Navigating updates URL search params → the server page re-fetches.
    const applyParams = React.useCallback(
        (next: { whse?: string; date?: string }) => {
            const sp = new URLSearchParams();
            sp.set('whse', next.whse ?? warehouse);
            sp.set('date', next.date ?? startDate);
            startTransition(() => {
                router.replace(`${pathname}?${sp.toString()}`, { scroll: false });
            });
        },
        [router, pathname, warehouse, startDate],
    );

    // Sort balance cards deterministically: grade asc, then side (LS before RS).
    const sortedBalances = React.useMemo(
        () =>
            [...balances].sort((a, b) => {
                if (a.grade_code !== b.grade_code) return a.grade_code.localeCompare(b.grade_code);
                return a.side.localeCompare(b.side);
            }),
        [balances],
    );

    const headBase = 'h-8 px-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground';

    return (
        <div className="flex h-full flex-col">
            {/* Controls */}
            <div className="flex-none flex flex-wrap items-center gap-x-4 gap-y-2 border-b bg-muted/30 px-3 py-2">
                <div className="flex items-center gap-1.5">
                    <span className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                        Warehouse
                    </span>
                    <Select value={warehouse} onValueChange={(v) => applyParams({ whse: v })}>
                        <SelectTrigger size="sm" className="h-7 w-[110px] text-xs">
                            <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                            {FLEC_WAREHOUSES.map((w) => (
                                <SelectItem key={w} value={w} className="text-xs">
                                    {w}
                                </SelectItem>
                            ))}
                        </SelectContent>
                    </Select>
                </div>

                <div className="flex items-center gap-1.5">
                    <span className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                        Start date
                    </span>
                    <div className="relative">
                        <Calendar className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground/70" />
                        <input
                            type="date"
                            value={startDate}
                            onChange={(e) => {
                                if (e.target.value) applyParams({ date: e.target.value });
                            }}
                            className="h-7 w-[150px] rounded-md border border-input bg-transparent pl-7 pr-2 font-mono text-xs tabular-nums outline-none transition-colors focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
                            aria-label="Ledger start date"
                        />
                    </div>
                </div>

                {/* Make the start-date semantics explicit */}
                <span className="text-[11px] text-muted-foreground">
                    Balances as of <span className="font-medium text-foreground">{fmtLongDate(startDate)}</span> forward
                </span>

                <div className="flex-1" />
                {isPending && (
                    <span className="flex items-center gap-1 text-[11px] text-muted-foreground">
                        <Loader2 className="h-3 w-3 animate-spin" />
                        Loading…
                    </span>
                )}
            </div>

            {loadError && <ErrorBanner message={loadError} />}

            <div className="min-h-0 flex-1 overflow-auto">
                <div className={cn('flex flex-col gap-4 p-3 md:p-4', isPending && 'opacity-60 transition-opacity')}>
                    {/* ─── Balance cards (current count per grade × side) ─────────────── */}
                    <section>
                        <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                            Current Balance — {warehouse}
                        </h3>
                        {sortedBalances.length === 0 ? (
                            <Card className="flex flex-col items-center justify-center gap-2 border-dashed py-10 text-center">
                                <Boxes className="h-7 w-7 text-muted-foreground/30" />
                                <p className="text-sm text-muted-foreground">
                                    {loadError
                                        ? 'No balances to display.'
                                        : `No flec movement in ${warehouse} on or after ${fmtLongDate(startDate)}.`}
                                </p>
                                {!loadError && (
                                    <p className="max-w-md text-xs text-muted-foreground/70">
                                        Try an earlier start date, or pick a warehouse with activity (WHSE 5 and WHSE 7
                                        have the most data).
                                    </p>
                                )}
                            </Card>
                        ) : (
                            <div className="grid grid-cols-2 gap-3 stagger-children sm:grid-cols-3 lg:grid-cols-4">
                                {sortedBalances.map((b) => (
                                    <BalanceCard key={`${b.grade_code}-${b.side}`} balance={b} />
                                ))}
                            </div>
                        )}
                    </section>

                    {/* ─── Movement ledger (show-your-math) ───────────────────────────── */}
                    <section className="min-h-0">
                        <h3 className="mb-2 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                            Movement Ledger
                            <span className="font-mono text-[10px] normal-case text-muted-foreground/60">
                                opening + ins − outs = balance
                            </span>
                        </h3>
                        <Card className="overflow-hidden p-0">
                            <Table className="table-fixed">
                                <TableHeader className="sticky top-0 z-10 bg-muted/90 backdrop-blur-sm">
                                    <TableRow className="border-b hover:bg-transparent">
                                        <TableHead className={cn(headBase, 'w-[104px]')}>Recv</TableHead>
                                        <TableHead className={cn(headBase, 'w-[64px]')}>Grade</TableHead>
                                        <TableHead className={cn(headBase, 'w-[52px]')}>Side</TableHead>
                                        <TableHead className={cn(headBase, 'w-[120px]')}>Disposition</TableHead>
                                        <TableHead className={cn(headBase, 'w-[100px] text-right')}>Kg Moved</TableHead>
                                        <TableHead className={cn(headBase, 'w-[72px] text-right')}>Opening</TableHead>
                                        <TableHead className={cn(headBase, 'w-[64px] text-right')}>In</TableHead>
                                        <TableHead className={cn(headBase, 'w-[64px] text-right')}>Out</TableHead>
                                        <TableHead className={cn(headBase, 'w-[80px] text-right')}>Balance</TableHead>
                                    </TableRow>
                                </TableHeader>
                                <TableBody>
                                    {ledger.length === 0 ? (
                                        <TableRow className="hover:bg-transparent">
                                            <TableCell colSpan={9} className="h-28 text-center text-sm text-muted-foreground">
                                                {loadError
                                                    ? 'No data to display.'
                                                    : `No movement rows for ${warehouse} from ${fmtLongDate(startDate)} forward.`}
                                            </TableCell>
                                        </TableRow>
                                    ) : (
                                        ledger.map((row, i) => {
                                            // Group divider: thin top border when the (grade, side) changes,
                                            // so each grade×side ledger reads as its own block.
                                            const prev = ledger[i - 1];
                                            const newGroup =
                                                !prev || prev.grade_code !== row.grade_code || prev.side !== row.side;
                                            return (
                                                <TableRow
                                                    key={row.id}
                                                    className={cn(
                                                        'h-8 border-b transition-all duration-150 hover:bg-muted/50',
                                                        newGroup && i > 0 && 'border-t-2 border-t-border',
                                                    )}
                                                >
                                                    <TableCell className="px-2 py-1 font-mono text-xs tabular-nums">{fmtDate(row.recv_date)}</TableCell>
                                                    <TableCell className="px-2 py-1 font-mono text-xs">{row.grade_code}</TableCell>
                                                    <TableCell className="px-2 py-1 font-mono text-xs text-muted-foreground">{row.side}</TableCell>
                                                    <TableCell className="px-2 py-1 text-xs">
                                                        <LedgerDirection row={row} />
                                                    </TableCell>
                                                    <TableCell className="px-2 py-1 text-right font-mono text-xs tabular-nums text-muted-foreground">{fmtKg(row.kg_moved)}</TableCell>
                                                    <TableCell className="px-2 py-1 text-right font-mono text-xs tabular-nums text-muted-foreground/70">{row.opening_seed}</TableCell>
                                                    <TableCell className="px-2 py-1 text-right font-mono text-xs tabular-nums text-emerald-600 dark:text-emerald-400">
                                                        {row.flec_in != null ? `+${row.flec_in}` : ''}
                                                    </TableCell>
                                                    <TableCell className="px-2 py-1 text-right font-mono text-xs tabular-nums text-rose-600 dark:text-rose-400">
                                                        {row.flec_out != null ? `−${row.flec_out}` : ''}
                                                    </TableCell>
                                                    <TableCell
                                                        className={cn(
                                                            'px-2 py-1 text-right font-mono text-xs font-semibold tabular-nums',
                                                            row.running_balance < 0 && 'text-rose-600 dark:text-rose-400',
                                                        )}
                                                    >
                                                        {row.running_balance}
                                                    </TableCell>
                                                </TableRow>
                                            );
                                        })
                                    )}
                                </TableBody>
                            </Table>
                        </Card>
                    </section>
                </div>
            </div>
        </div>
    );
}

// ─── BalanceCard ─────────────────────────────────────────────────────────────────
// One (grade × side) closing balance. Shows the current count large, with the
// opening seed and as-of date underneath so the figure is self-explanatory.
function BalanceCard({ balance }: { balance: FlecBalanceRow }) {
    const delta = balance.current_flec - balance.opening_seed;
    return (
        <Card className="hover-lift gap-0 p-3">
            <div className="flex items-center justify-between">
                <span className="font-mono text-xs font-semibold">{balance.grade_code}</span>
                <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
                    {balance.side}
                </span>
            </div>
            <div className="mt-2 flex items-baseline gap-1.5">
                <span className="font-mono text-2xl font-bold tabular-nums">{balance.current_flec}</span>
                <span className="text-[10px] uppercase tracking-wide text-muted-foreground">flec</span>
            </div>
            <div className="mt-1.5 flex items-center gap-2 text-[10px] text-muted-foreground">
                <span className="font-mono">opening {balance.opening_seed}</span>
                {delta !== 0 && (
                    <span
                        className={cn(
                            'font-mono',
                            delta > 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-600 dark:text-rose-400',
                        )}
                    >
                        {delta > 0 ? `+${delta}` : delta}
                    </span>
                )}
            </div>
            <div className="mt-0.5 font-mono text-[10px] text-muted-foreground/60">as of {fmtDate(balance.as_of)}</div>
        </Card>
    );
}

// ─── LedgerDirection ─────────────────────────────────────────────────────────────
// Renders the disposition with an in/out arrow so the row's direction is obvious.
function LedgerDirection({ row }: { row: FlecLedgerRow }) {
    const isIn = row.flec_in != null;
    const label = formatDisposition(row.disposition_kind, row.partner_equipment_code);
    return (
        <span className="inline-flex items-center gap-1">
            {isIn ? (
                <ArrowDownToLine className="h-3 w-3 shrink-0 text-emerald-600 dark:text-emerald-400" />
            ) : (
                <ArrowUpFromLine className="h-3 w-3 shrink-0 text-rose-600 dark:text-rose-400" />
            )}
            <span className="truncate">{label}</span>
        </span>
    );
}
