'use client';

import * as React from 'react';
import { useRouter, usePathname } from 'next/navigation';
import { format as formatDate, parseISO, isValid as isValidDate } from 'date-fns';
import {
    Calendar,
    Copy,
    ArrowDownToLine,
    ArrowUpFromLine,
    Boxes,
    Loader2,
    History,
    ChevronDown,
    Save,
    RotateCcw,
    Pencil,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';
import { errorToast } from '@/lib/toast';
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
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import {
    Collapsible,
    CollapsibleContent,
    CollapsibleTrigger,
} from '@/components/ui/collapsible';
import {
    FLEC_WAREHOUSES,
    GRADE_CODES,
    WHSE_SIDES,
    type FlecBalanceRow,
    type FlecLedgerRow,
    type OpeningBalanceRow,
    type OpeningBalanceHistoryRow,
    type OpeningBalanceCellChange,
    type GradeCode,
    type WhseSide,
    formatDisposition,
} from '../types';
import { saveOpeningBalances } from './actions';

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

// A (grade, side) cell key — the stable identity for STARTING cells + history groups.
function cellKey(grade: string, side: string): string {
    return `${grade}|${side}`;
}

// ─── Inline error banner (HARD RULE: persistent + Copy) ──────────────────────────
function ErrorBanner({ message }: { message: string }) {
    return (
        <div className="m-3 flex items-start gap-3 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm">
            <div className="min-w-0 flex-1">
                <p className="font-medium text-destructive">Couldn&apos;t load flec inventory</p>
                <p className="mt-1 break-words text-destructive/90">{message}</p>
                <p className="mt-1 text-xs text-muted-foreground">
                    Try again in a moment, or copy the message above if it persists.
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
    openings: OpeningBalanceRow[];
    history: OpeningBalanceHistoryRow[];
    loadError: string | null;
}

// ─── Main component ──────────────────────────────────────────────────────────────
export function FlecInventoryClient({
    warehouse,
    startDate,
    balances,
    ledger,
    openings,
    history,
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

    // ─── Lookup maps from the server data ────────────────────────────────────────
    // Effective opening per (grade, side) as of the start date (seeds the editable
    // STARTING value). Closing per (grade, side) from the flec balance (the "→ now").
    const openingByCell = React.useMemo(() => {
        const m = new Map<string, OpeningBalanceRow>();
        for (const o of openings) m.set(cellKey(o.grade_code, o.side), o);
        return m;
    }, [openings]);

    const closingByCell = React.useMemo(() => {
        const m = new Map<string, FlecBalanceRow>();
        for (const b of balances) m.set(cellKey(b.grade_code, b.side), b);
        return m;
    }, [balances]);

    // History grouped by (grade, side), already newest-first from the RPC.
    const historyByCell = React.useMemo(() => {
        const m = new Map<string, OpeningBalanceHistoryRow[]>();
        for (const h of history) {
            const k = cellKey(h.grade_code, h.side);
            const arr = m.get(k);
            if (arr) arr.push(h);
            else m.set(k, [h]);
        }
        return m;
    }, [history]);

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
                    {/* ─── STARTING block (editable opening → current closing) ─────────── */}
                    <StartingBlock
                        warehouse={warehouse}
                        startDate={startDate}
                        openingByCell={openingByCell}
                        closingByCell={closingByCell}
                        historyByCell={historyByCell}
                        disabled={isPending}
                    />

                    {/* ─── Balance cards (current count per grade × side) ──────────────── */}
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
                                        Set a STARTING balance above, try an earlier start date, or pick a warehouse with
                                        activity (WHSE 5 and WHSE 7 have the most data).
                                    </p>
                                )}
                            </Card>
                        ) : (
                            <div className="grid grid-cols-2 gap-3 stagger-children sm:grid-cols-3 lg:grid-cols-4">
                                {sortedBalances.map((b) => (
                                    <BalanceCard key={cellKey(b.grade_code, b.side)} balance={b} />
                                ))}
                            </div>
                        )}
                    </section>

                    {/* ─── Opening-balance history (backtracking) ─────────────────────── */}
                    <OpeningHistoryPanel warehouse={warehouse} historyByCell={historyByCell} />

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

// ─── StartingBlock ───────────────────────────────────────────────────────────────
// The editable centerpiece — mirrors the Excel PC WHSE "STARTING" block. A dense
// grid: rows = the flec grades, columns = RS | LS. Each cell shows the STARTING
// value (editable, seeded from the effective opening) → the current closing (the
// "→ now"), plus a per-cell history popover. Editing is purely local until the
// operator clicks "Save starting balances", which writes only the CHANGED cells
// (each an append-only insert dated the page's START date).
function StartingBlock({
    warehouse,
    startDate,
    openingByCell,
    closingByCell,
    historyByCell,
    disabled,
}: {
    warehouse: string;
    startDate: string;
    openingByCell: Map<string, OpeningBalanceRow>;
    closingByCell: Map<string, FlecBalanceRow>;
    historyByCell: Map<string, OpeningBalanceHistoryRow[]>;
    disabled: boolean;
}) {
    const router = useRouter();
    const [saving, setSaving] = React.useState(false);

    // The seeded opening value per cell (string for the controlled <input>; '' when
    // no opening exists). Recomputed whenever the server data changes (warehouse /
    // start-date switch, or a post-save revalidate).
    const seededDrafts = React.useMemo(() => {
        const m = new Map<string, string>();
        for (const grade of GRADE_CODES) {
            for (const side of WHSE_SIDES) {
                const opening = openingByCell.get(cellKey(grade, side));
                m.set(cellKey(grade, side), opening ? String(opening.opening_flec_count) : '');
            }
        }
        return m;
    }, [openingByCell]);

    // Local edit buffer. Reset to the seed whenever the seed changes (i.e. new
    // server data). A cell is "dirty" when its draft differs from the seed.
    const [drafts, setDrafts] = React.useState<Map<string, string>>(seededDrafts);
    React.useEffect(() => {
        setDrafts(seededDrafts);
    }, [seededDrafts]);

    const setCell = React.useCallback((key: string, value: string) => {
        // Digits only (flec counts are non-negative integers). Empty allowed → 0 on save.
        const cleaned = value.replace(/[^\d]/g, '');
        setDrafts((prev) => {
            const next = new Map(prev);
            next.set(key, cleaned);
            return next;
        });
    }, []);

    // Which cells changed vs the seed → the payload for the append-only save.
    const changedCells = React.useMemo<OpeningBalanceCellChange[]>(() => {
        const out: OpeningBalanceCellChange[] = [];
        for (const grade of GRADE_CODES) {
            for (const side of WHSE_SIDES) {
                const key = cellKey(grade, side);
                const draft = drafts.get(key) ?? '';
                const seed = seededDrafts.get(key) ?? '';
                if (draft !== seed) {
                    out.push({
                        warehouse,
                        grade,
                        side,
                        effectiveDate: startDate,
                        count: draft === '' ? 0 : Number(draft),
                    });
                }
            }
        }
        return out;
    }, [drafts, seededDrafts, warehouse, startDate]);

    const dirtyCount = changedCells.length;

    const onSave = React.useCallback(async () => {
        if (dirtyCount === 0 || saving) return;
        setSaving(true);
        try {
            const res = await saveOpeningBalances(changedCells);
            if (res.error) {
                errorToast(res.error);
                return;
            }
            toast.success(
                `Saved ${res.savedCount} starting ${res.savedCount === 1 ? 'balance' : 'balances'} (as of ${fmtDate(startDate)})`,
            );
            // revalidatePath already ran server-side; refresh to re-seed the grid +
            // re-derive the ledger below from the new opening.
            router.refresh();
        } catch (e) {
            errorToast(e instanceof Error ? e.message : 'Failed to save starting balances');
        } finally {
            setSaving(false);
        }
    }, [changedCells, dirtyCount, saving, startDate, router]);

    const onDiscard = React.useCallback(() => {
        setDrafts(seededDrafts);
    }, [seededDrafts]);

    const busy = disabled || saving;

    return (
        <section>
            <div className="mb-2 flex items-center justify-between gap-2">
                <h3 className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                    Starting Balances — {warehouse}
                    <span className="font-mono text-[10px] normal-case text-muted-foreground/60">
                        as of {fmtDate(startDate)} · opening → now
                    </span>
                </h3>
                <div className="flex items-center gap-1.5">
                    {dirtyCount > 0 && (
                        <span className="animate-fade-in font-mono text-[10px] text-amber-600 dark:text-amber-400">
                            {dirtyCount} unsaved
                        </span>
                    )}
                    <Button
                        variant="ghost"
                        size="sm"
                        className="h-7 px-2 text-xs"
                        onClick={onDiscard}
                        disabled={busy || dirtyCount === 0}
                    >
                        <RotateCcw className="mr-1 h-3.5 w-3.5" />
                        Discard
                    </Button>
                    <Button
                        size="sm"
                        className="h-7 px-2.5 text-xs"
                        onClick={onSave}
                        disabled={busy || dirtyCount === 0}
                    >
                        {saving ? (
                            <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
                        ) : (
                            <Save className="mr-1 h-3.5 w-3.5" />
                        )}
                        Save starting balances
                    </Button>
                </div>
            </div>

            <Card className="overflow-hidden p-0">
                <Table className="table-fixed">
                    <TableHeader className="bg-muted/90 backdrop-blur-sm">
                        <TableRow className="border-b hover:bg-transparent">
                            <TableHead className="h-8 w-[110px] px-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                                Grade
                            </TableHead>
                            {WHSE_SIDES.map((side) => (
                                <TableHead
                                    key={side}
                                    className="h-8 px-2 text-center text-[11px] font-semibold uppercase tracking-wide text-muted-foreground"
                                    colSpan={2}
                                >
                                    {side === 'RS' ? 'Right Side (RS)' : 'Left Side (LS)'}
                                </TableHead>
                            ))}
                        </TableRow>
                        <TableRow className="border-b hover:bg-transparent">
                            <TableHead className="h-7 px-2 text-[10px] font-medium uppercase tracking-wide text-muted-foreground/70" />
                            {WHSE_SIDES.map((side) => (
                                <React.Fragment key={side}>
                                    <TableHead className="h-7 w-[120px] px-2 text-right text-[10px] font-medium uppercase tracking-wide text-muted-foreground/70">
                                        Starting
                                    </TableHead>
                                    <TableHead className="h-7 w-[88px] px-2 text-right text-[10px] font-medium uppercase tracking-wide text-muted-foreground/70">
                                        Now
                                    </TableHead>
                                </React.Fragment>
                            ))}
                        </TableRow>
                    </TableHeader>
                    <TableBody>
                        {GRADE_CODES.map((grade) => (
                            <TableRow key={grade} className="h-9 border-b hover:bg-muted/30">
                                <TableCell className="px-2 py-1 font-mono text-xs font-semibold">{grade}</TableCell>
                                {WHSE_SIDES.map((side) => {
                                    const key = cellKey(grade, side);
                                    const draft = drafts.get(key) ?? '';
                                    const seed = seededDrafts.get(key) ?? '';
                                    const dirty = draft !== seed;
                                    const closing = closingByCell.get(key);
                                    const cellHistory = historyByCell.get(key) ?? [];
                                    return (
                                        <StartingCell
                                            key={key}
                                            grade={grade}
                                            side={side}
                                            value={draft}
                                            dirty={dirty}
                                            closing={closing}
                                            history={cellHistory}
                                            disabled={busy}
                                            onChange={(v) => setCell(key, v)}
                                        />
                                    );
                                })}
                            </TableRow>
                        ))}
                    </TableBody>
                </Table>
            </Card>

            <p className="mt-1.5 text-[10px] text-muted-foreground/70">
                Type the opening flec count for each grade × side as of{' '}
                <span className="font-medium text-foreground/80">{fmtDate(startDate)}</span>. Saving keeps every prior
                value — pick a new start date to set a fresh opening for a later period. Open the history
                <History className="mx-0.5 inline h-3 w-3 align-text-bottom" />
                icon on any cell to backtrack.
            </p>
        </section>
    );
}

// ─── StartingCell ────────────────────────────────────────────────────────────────
// One (grade × side) cell pair: an editable STARTING input + the read-only "Now"
// closing, with a per-cell history popover trigger nested next to the input.
function StartingCell({
    grade,
    side,
    value,
    dirty,
    closing,
    history,
    disabled,
    onChange,
}: {
    grade: GradeCode;
    side: WhseSide;
    value: string;
    dirty: boolean;
    closing: FlecBalanceRow | undefined;
    history: OpeningBalanceHistoryRow[];
    disabled: boolean;
    onChange: (value: string) => void;
}) {
    return (
        <>
            {/* STARTING — editable */}
            <TableCell className="px-2 py-1">
                <div className="flex items-center justify-end gap-1">
                    {history.length > 0 && (
                        <CellHistoryPopover grade={grade} side={side} history={history} />
                    )}
                    <input
                        type="text"
                        inputMode="numeric"
                        value={value}
                        onChange={(e) => onChange(e.target.value)}
                        disabled={disabled}
                        placeholder="0"
                        aria-label={`Starting flec for ${grade} ${side}`}
                        className={cn(
                            'h-7 w-[68px] rounded-md border bg-transparent px-2 text-right font-mono text-xs tabular-nums outline-none transition-colors',
                            'focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50',
                            'disabled:cursor-not-allowed disabled:opacity-60',
                            dirty
                                ? 'border-amber-500/70 bg-amber-50/50 dark:bg-amber-950/20'
                                : 'border-input',
                        )}
                    />
                </div>
            </TableCell>
            {/* NOW — read-only closing. "—" when the cell has no balance row (no
                opening AND no movement, or an opening with no events forward). */}
            <TableCell className="px-2 py-1 text-right">
                {closing ? (
                    <span
                        className={cn(
                            'font-mono text-xs font-semibold tabular-nums',
                            closing.current_flec < 0 && 'text-rose-600 dark:text-rose-400',
                        )}
                    >
                        {closing.current_flec}
                    </span>
                ) : (
                    <span className="font-mono text-xs text-muted-foreground/40">—</span>
                )}
            </TableCell>
        </>
    );
}

// ─── CellHistoryPopover ──────────────────────────────────────────────────────────
// Per-cell backtracking: the full append-only trail for one (grade, side), newest
// first. Each entry: the opening count, its effective date, and when it was set.
function CellHistoryPopover({
    grade,
    side,
    history,
}: {
    grade: GradeCode;
    side: WhseSide;
    history: OpeningBalanceHistoryRow[];
}) {
    return (
        <Popover>
            <PopoverTrigger asChild>
                <button
                    type="button"
                    aria-label={`History for ${grade} ${side}`}
                    className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-muted-foreground/50 transition-colors hover:bg-muted hover:text-foreground"
                >
                    <History className="h-3 w-3" />
                </button>
            </PopoverTrigger>
            <PopoverContent align="end" className="w-60 p-0">
                <div className="border-b px-3 py-2">
                    <p className="font-mono text-xs font-semibold">
                        {grade} · {side}
                    </p>
                    <p className="text-[10px] text-muted-foreground">
                        Opening history — newest first
                    </p>
                </div>
                <div className="max-h-56 overflow-auto py-1">
                    {history.map((h, i) => (
                        <div
                            key={h.id}
                            className={cn(
                                'flex items-baseline justify-between gap-3 px-3 py-1.5 text-xs',
                                i === 0 && 'bg-muted/40',
                            )}
                        >
                            <div className="min-w-0">
                                <span className="font-mono font-semibold tabular-nums">
                                    {h.opening_flec_count}
                                </span>
                                <span className="ml-1.5 font-mono text-[10px] text-muted-foreground">
                                    as of {fmtDate(h.period_start_date)}
                                </span>
                            </div>
                            <span className="shrink-0 font-mono text-[10px] text-muted-foreground/60">
                                set {fmtDate(h.created_at)}
                            </span>
                        </div>
                    ))}
                </div>
            </PopoverContent>
        </Popover>
    );
}

// ─── OpeningHistoryPanel ─────────────────────────────────────────────────────────
// Collapsible whole-warehouse backtracking view. Groups every opening entry by
// (grade, side), each group newest-first, so the operator can see what the opening
// was on any past effective date at a glance.
function OpeningHistoryPanel({
    warehouse,
    historyByCell,
}: {
    warehouse: string;
    historyByCell: Map<string, OpeningBalanceHistoryRow[]>;
}) {
    const [open, setOpen] = React.useState(false);

    // Stable group order: grade asc, then side (LS before RS), only cells with entries.
    const groups = React.useMemo(() => {
        const out: { grade: GradeCode; side: WhseSide; entries: OpeningBalanceHistoryRow[] }[] = [];
        for (const grade of GRADE_CODES) {
            for (const side of WHSE_SIDES) {
                const entries = historyByCell.get(cellKey(grade, side));
                if (entries && entries.length > 0) out.push({ grade, side, entries });
            }
        }
        // LS before RS within a grade (WHSE_SIDES is [LS, RS] already, so the nested
        // loop yields LS first — kept explicit for clarity if WHSE_SIDES reorders).
        return out;
    }, [historyByCell]);

    const totalEntries = React.useMemo(
        () => groups.reduce((sum, g) => sum + g.entries.length, 0),
        [groups],
    );

    return (
        <section>
            <Collapsible open={open} onOpenChange={setOpen}>
                <Card className="overflow-hidden p-0">
                    <CollapsibleTrigger asChild>
                        <button
                            type="button"
                            className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left transition-colors hover:bg-muted/40"
                        >
                            <span className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                                <History className="h-3.5 w-3.5" />
                                Starting Balance History — {warehouse}
                                <span className="font-mono text-[10px] normal-case text-muted-foreground/60">
                                    {totalEntries} {totalEntries === 1 ? 'entry' : 'entries'} · backtrack any date
                                </span>
                            </span>
                            <ChevronDown
                                className={cn(
                                    'h-4 w-4 shrink-0 text-muted-foreground transition-transform duration-200',
                                    open && 'rotate-180',
                                )}
                            />
                        </button>
                    </CollapsibleTrigger>
                    <CollapsibleContent>
                        <div className="border-t">
                            {groups.length === 0 ? (
                                <div className="flex flex-col items-center gap-1.5 py-8 text-center">
                                    <Pencil className="h-5 w-5 text-muted-foreground/30" />
                                    <p className="text-xs text-muted-foreground">
                                        No starting balances set for {warehouse} yet.
                                    </p>
                                    <p className="max-w-sm text-[10px] text-muted-foreground/70">
                                        Type values into the Starting Balances grid above and save — every value you set
                                        is kept here so you can backtrack what the opening was on any date.
                                    </p>
                                </div>
                            ) : (
                                <div className="grid grid-cols-1 gap-x-6 gap-y-3 p-3 sm:grid-cols-2 lg:grid-cols-3">
                                    {groups.map((group) => (
                                        <div key={cellKey(group.grade, group.side)} className="min-w-0">
                                            <div className="mb-1 flex items-baseline gap-1.5 border-b pb-1">
                                                <span className="font-mono text-xs font-semibold">{group.grade}</span>
                                                <span className="rounded bg-muted px-1 py-0.5 font-mono text-[9px] text-muted-foreground">
                                                    {group.side}
                                                </span>
                                            </div>
                                            <ul className="space-y-0.5">
                                                {group.entries.map((h, i) => (
                                                    <li
                                                        key={h.id}
                                                        className="flex items-baseline justify-between gap-2 text-xs"
                                                    >
                                                        <span className="flex items-baseline gap-1.5">
                                                            <span
                                                                className={cn(
                                                                    'font-mono font-semibold tabular-nums',
                                                                    i === 0 && 'text-foreground',
                                                                    i > 0 && 'text-muted-foreground',
                                                                )}
                                                            >
                                                                {h.opening_flec_count}
                                                            </span>
                                                            <span className="font-mono text-[10px] text-muted-foreground">
                                                                as of {fmtDate(h.period_start_date)}
                                                            </span>
                                                            {i === 0 && (
                                                                <span className="rounded bg-emerald-500/10 px-1 font-mono text-[9px] text-emerald-600 dark:text-emerald-400">
                                                                    current
                                                                </span>
                                                            )}
                                                        </span>
                                                        <span className="shrink-0 font-mono text-[10px] text-muted-foreground/50">
                                                            {fmtDate(h.created_at)}
                                                        </span>
                                                    </li>
                                                ))}
                                            </ul>
                                        </div>
                                    ))}
                                </div>
                            )}
                        </div>
                    </CollapsibleContent>
                </Card>
            </Collapsible>
        </section>
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
