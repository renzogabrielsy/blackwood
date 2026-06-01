'use client';

import * as React from 'react';
import { format as formatDate, parseISO, isValid as isValidDate } from 'date-fns';
import { ListFilter, ArrowUp, ArrowDown, Copy, Inbox } from 'lucide-react';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import {
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
} from '@/components/ui/table';
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuTrigger,
    DropdownMenuRadioGroup,
    DropdownMenuRadioItem,
    DropdownMenuLabel,
    DropdownMenuSeparator,
} from '@/components/ui/dropdown-menu';
import type { ProductionEventRow } from '../types';
import { formatDisposition } from '../types';

// ─── Disposition filter options ──────────────────────────────────────────────────
// The raw disposition_kind values, with human labels for the filter menu.
const DISPOSITION_LABELS: Record<string, string> = {
    flec_bagging: 'Bag',
    partner_crusher: 'Crusher',
    partner_kiln: 'Kiln',
};

// ─── Display helpers ─────────────────────────────────────────────────────────────
function fmtDate(iso: string | null): string {
    if (!iso) return '';
    const parsed = parseISO(iso);
    return isValidDate(parsed) ? formatDate(parsed, 'yyyy-MM-dd') : iso;
}

// Whole-kg with thousands separators ("17,698"). Blank for null/NaN.
function fmtKg(n: number | null | undefined): string {
    if (n === null || n === undefined || Number.isNaN(n)) return '';
    return n.toLocaleString('en-US', { maximumFractionDigits: 0 });
}

// ─── ColumnFilterMenu ────────────────────────────────────────────────────────────
// Compact header filter: a label + a ListFilter icon-button opening a single-select
// DropdownMenu ("All" + each distinct value). Filtering HIDES rows (it is NOT a
// sort). The icon tints primary when a filter is active. Mirrors the pattern from
// the ICTC daily ledger grid (daily-ledger-grid.tsx). The trigger stops propagation
// so opening the menu never bubbles into row interactions.
interface ColumnFilterMenuProps {
    label: string;
    value: string;                                    // 'ALL' = no filter
    options: { value: string; label: string }[];
    onChange: (value: string) => void;
    align?: 'start' | 'end';
}

function ColumnFilterMenu({ label, value, options, onChange, align = 'start' }: ColumnFilterMenuProps) {
    const isActive = value !== 'ALL';
    const activeLabel = options.find((o) => o.value === value)?.label ?? value;
    return (
        <span className="inline-flex items-center gap-0.5">
            {label}
            <DropdownMenu>
                <DropdownMenuTrigger asChild>
                    <button
                        type="button"
                        aria-label={`Filter ${label}${isActive ? `: ${activeLabel}` : ''}`}
                        title={isActive ? `${label}: ${activeLabel}` : `Filter ${label}`}
                        onMouseDown={(e) => e.stopPropagation()}
                        onPointerDown={(e) => e.stopPropagation()}
                        className={cn(
                            'flex items-center justify-center rounded p-0.5 outline-none transition-colors duration-150',
                            'focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-primary',
                            isActive
                                ? 'text-primary hover:text-primary/80'
                                : 'text-muted-foreground/50 hover:text-muted-foreground',
                        )}
                    >
                        <ListFilter className="h-3 w-3" />
                    </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align={align} className="min-w-[120px] bg-popover/95 backdrop-blur-lg">
                    <DropdownMenuLabel className="px-2 py-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                        {label}
                    </DropdownMenuLabel>
                    <DropdownMenuSeparator />
                    <DropdownMenuRadioGroup value={value} onValueChange={onChange}>
                        <DropdownMenuRadioItem value="ALL" className="py-1 font-mono text-[11px]">
                            All
                        </DropdownMenuRadioItem>
                        {options.map((opt) => (
                            <DropdownMenuRadioItem
                                key={opt.value}
                                value={opt.value}
                                className="py-1 font-mono text-[11px]"
                            >
                                {opt.label}
                            </DropdownMenuRadioItem>
                        ))}
                    </DropdownMenuRadioGroup>
                </DropdownMenuContent>
            </DropdownMenu>
        </span>
    );
}

// ─── Inline error banner (HARD RULE: persistent + Copy) ──────────────────────────
function ErrorBanner({ message }: { message: string }) {
    return (
        <div className="m-3 flex items-start gap-3 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm">
            <div className="min-w-0 flex-1">
                <p className="font-medium text-destructive">Couldn&apos;t load production data</p>
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
interface ProductionTableProps {
    rows: ProductionEventRow[];
    loadError: string | null;
}

// ─── Main component ──────────────────────────────────────────────────────────────
export function ProductionTable({ rows, loadError }: ProductionTableProps) {
    // Date sort — default newest-first (operators care about recent activity most).
    const [dateSortDir, setDateSortDir] = React.useState<'asc' | 'desc'>('desc');

    // Header filters — single-select; 'ALL' = no filter.
    const [shiftFilter, setShiftFilter] = React.useState('ALL');
    const [gradeFilter, setGradeFilter] = React.useState('ALL');
    const [dispositionFilter, setDispositionFilter] = React.useState('ALL');
    const [warehouseFilter, setWarehouseFilter] = React.useState('ALL');

    // ─── Distinct filter options (derived from the actual data, not hardcoded) ───
    // Only values present in the data appear in each dropdown.
    const { shiftOptions, gradeOptions, dispositionOptions, warehouseOptions } = React.useMemo(() => {
        const shifts = new Set<string>();
        const grades = new Set<string>();
        const dispositions = new Set<string>();
        const warehouses = new Set<string>();
        let hasUnplaced = false;

        for (const r of rows) {
            if (r.shift_code) shifts.add(r.shift_code);
            if (r.grade_code) grades.add(r.grade_code);
            if (r.disposition_kind) dispositions.add(r.disposition_kind);
            if (r.warehouse_code) warehouses.add(r.warehouse_code);
            else hasUnplaced = true;
        }

        const warehouseOpts = [...warehouses].sort().map((w) => ({ value: w, label: w }));
        // A sentinel option to isolate the "unplaced" (null warehouse) rows.
        if (hasUnplaced) warehouseOpts.push({ value: '__NULL__', label: '— Unplaced' });

        return {
            shiftOptions: [...shifts].sort().map((s) => ({ value: s, label: s })),
            gradeOptions: [...grades].sort().map((g) => ({ value: g, label: g })),
            dispositionOptions: [...dispositions]
                .sort()
                .map((d) => ({ value: d, label: DISPOSITION_LABELS[d] ?? d })),
            warehouseOptions: warehouseOpts,
        };
    }, [rows]);

    // ─── Apply filters + date sort ───────────────────────────────────────────────
    const visibleRows = React.useMemo(() => {
        const filtered = rows.filter((r) => {
            if (shiftFilter !== 'ALL' && r.shift_code !== shiftFilter) return false;
            if (gradeFilter !== 'ALL' && r.grade_code !== gradeFilter) return false;
            if (dispositionFilter !== 'ALL' && r.disposition_kind !== dispositionFilter) return false;
            if (warehouseFilter !== 'ALL') {
                if (warehouseFilter === '__NULL__') {
                    if (r.warehouse_code !== null) return false;
                } else if (r.warehouse_code !== warehouseFilter) {
                    return false;
                }
            }
            return true;
        });

        // Stable sort by recv_date per the toggle (id as deterministic tiebreaker).
        // recv_date/id are non-null at runtime but typed nullable (VIEW columns),
        // so coalesce to '' to keep the comparator type-safe.
        return [...filtered].sort((a, b) => {
            const cmp = (a.recv_date ?? '').localeCompare(b.recv_date ?? '');
            const primary = dateSortDir === 'asc' ? cmp : -cmp;
            if (primary !== 0) return primary;
            return (a.id ?? '').localeCompare(b.id ?? '');
        });
    }, [rows, shiftFilter, gradeFilter, dispositionFilter, warehouseFilter, dateSortDir]);

    const anyFilterActive =
        shiftFilter !== 'ALL' ||
        gradeFilter !== 'ALL' ||
        dispositionFilter !== 'ALL' ||
        warehouseFilter !== 'ALL';

    const clearFilters = () => {
        setShiftFilter('ALL');
        setGradeFilter('ALL');
        setDispositionFilter('ALL');
        setWarehouseFilter('ALL');
    };

    // ─── Header cell class (dense, sticky, glass) ────────────────────────────────
    const headBase = 'h-8 px-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground';

    return (
        <div className="flex h-full flex-col">
            {/* Toolbar */}
            <div className="flex-none flex items-center gap-2 border-b bg-muted/30 px-2 py-1.5 md:px-3">
                <span className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                    Production Events
                </span>
                <span className="font-mono text-[11px] text-muted-foreground/70">
                    {visibleRows.length.toLocaleString('en-US')}
                    {visibleRows.length !== rows.length && (
                        <span className="text-muted-foreground/50"> / {rows.length.toLocaleString('en-US')}</span>
                    )}
                </span>
                <div className="flex-1" />
                {anyFilterActive && (
                    <Button variant="ghost" size="sm" className="h-6 px-2 text-[11px]" onClick={clearFilters}>
                        Clear filters
                    </Button>
                )}
                <Button
                    variant="outline"
                    size="sm"
                    className="h-6 gap-1 px-2 text-[11px]"
                    onClick={() => setDateSortDir((d) => (d === 'asc' ? 'desc' : 'asc'))}
                    title={dateSortDir === 'desc' ? 'Newest first — click for oldest first' : 'Oldest first — click for newest first'}
                >
                    {dateSortDir === 'desc' ? <ArrowDown className="h-3 w-3" /> : <ArrowUp className="h-3 w-3" />}
                    Date
                </Button>
            </div>

            {loadError && <ErrorBanner message={loadError} />}

            {/* Table */}
            <div className="min-h-0 flex-1 overflow-auto">
                <Table className="table-fixed">
                    <TableHeader className="sticky top-0 z-10 bg-muted/90 backdrop-blur-sm">
                        <TableRow className="border-b hover:bg-transparent">
                            <TableHead className={cn(headBase, 'w-[104px]')}>Recv</TableHead>
                            <TableHead className={cn(headBase, 'w-[104px]')}>Prod</TableHead>
                            <TableHead className={cn(headBase, 'w-[110px]')}>Batch</TableHead>
                            <TableHead className={cn(headBase, 'w-[64px]')}>
                                <ColumnFilterMenu label="Shift" value={shiftFilter} options={shiftOptions} onChange={setShiftFilter} />
                            </TableHead>
                            <TableHead className={cn(headBase, 'w-[72px]')}>
                                <ColumnFilterMenu label="Grade" value={gradeFilter} options={gradeOptions} onChange={setGradeFilter} />
                            </TableHead>
                            <TableHead className={cn(headBase, 'w-[64px]')}>Plant</TableHead>
                            <TableHead className={cn(headBase, 'w-[110px]')}>
                                <ColumnFilterMenu label="Whse" value={warehouseFilter} options={warehouseOptions} onChange={setWarehouseFilter} />
                            </TableHead>
                            <TableHead className={cn(headBase, 'w-[72px]')}>Source</TableHead>
                            <TableHead className={cn(headBase, 'w-[130px]')}>
                                <ColumnFilterMenu label="Disposition" value={dispositionFilter} options={dispositionOptions} onChange={setDispositionFilter} />
                            </TableHead>
                            <TableHead className={cn(headBase, 'w-[110px] text-right')}>Weight (kg)</TableHead>
                            <TableHead className={cn(headBase, 'w-[70px] text-right')}>Flec</TableHead>
                        </TableRow>
                    </TableHeader>
                    <TableBody>
                        {visibleRows.length === 0 ? (
                            <TableRow className="hover:bg-transparent">
                                <TableCell colSpan={11} className="h-40 p-0">
                                    <div className="flex h-40 flex-col items-center justify-center gap-2 text-center animate-fade-up">
                                        <Inbox className="h-8 w-8 text-muted-foreground/30" />
                                        <p className="text-sm text-muted-foreground">
                                            {loadError
                                                ? 'No data to display.'
                                                : rows.length === 0
                                                    ? 'No production events found.'
                                                    : 'No rows match the current filters.'}
                                        </p>
                                        {anyFilterActive && rows.length > 0 && (
                                            <Button variant="outline" size="sm" className="h-6 px-2 text-[11px]" onClick={clearFilters}>
                                                Clear filters
                                            </Button>
                                        )}
                                    </div>
                                </TableCell>
                            </TableRow>
                        ) : (
                            visibleRows.map((r) => {
                                const isUnplaced = r.warehouse_code === null;
                                return (
                                    <TableRow key={r.id} className="h-8 border-b transition-all duration-150 hover:bg-muted/50">
                                        <TableCell className="px-2 py-1 font-mono text-xs tabular-nums">{fmtDate(r.recv_date)}</TableCell>
                                        <TableCell className="px-2 py-1 font-mono text-xs tabular-nums text-muted-foreground">{fmtDate(r.prod_date) || '—'}</TableCell>
                                        <TableCell className="px-2 py-1 text-xs">
                                            <span className="font-medium">{r.batch}</span>
                                            <span className="ml-1 font-mono text-[10px] text-muted-foreground/70">{r.batch_year}</span>
                                        </TableCell>
                                        <TableCell className="px-2 py-1 text-xs">{r.shift_code ?? '—'}</TableCell>
                                        <TableCell className="px-2 py-1 font-mono text-xs">{r.grade_code}</TableCell>
                                        <TableCell className="px-2 py-1 font-mono text-xs text-muted-foreground">{r.plant_code ?? '—'}</TableCell>
                                        <TableCell className={cn('px-2 py-1 text-xs', isUnplaced && 'text-muted-foreground/60 italic')}>
                                            {r.warehouse_code ?? 'unplaced'}
                                            {!isUnplaced && r.whse_side && (
                                                <span className="ml-1 font-mono text-[10px] text-muted-foreground/70">{r.whse_side}</span>
                                            )}
                                        </TableCell>
                                        <TableCell className="px-2 py-1 font-mono text-xs text-muted-foreground">{r.source_location_code}</TableCell>
                                        <TableCell className="px-2 py-1 text-xs">
                                            <DispositionBadge disposition={r.disposition_kind} equipment={r.partner_equipment_code} />
                                        </TableCell>
                                        <TableCell className="px-2 py-1 text-right font-mono text-xs tabular-nums">{fmtKg(r.weight_kg)}</TableCell>
                                        <TableCell className="px-2 py-1 text-right font-mono text-xs tabular-nums text-muted-foreground">{r.flec_count ?? ''}</TableCell>
                                    </TableRow>
                                );
                            })
                        )}
                    </TableBody>
                </Table>
            </div>
        </div>
    );
}

// ─── DispositionBadge ────────────────────────────────────────────────────────────
// Color-codes the three disposition kinds: bagging (green/inflow), crusher (amber),
// kiln (orange). Uses semantic-token-friendly tints that read in both themes.
function DispositionBadge({
    disposition,
    equipment,
}: {
    disposition: ProductionEventRow['disposition_kind'];
    equipment: string | null;
}) {
    const label = formatDisposition(disposition, equipment);
    const tint =
        disposition === 'flec_bagging'
            ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
            : disposition === 'partner_crusher'
                ? 'bg-amber-500/10 text-amber-600 dark:text-amber-400'
                : 'bg-orange-500/10 text-orange-600 dark:text-orange-400';
    return (
        <span className={cn('inline-flex items-center rounded px-1.5 py-0.5 text-[11px] font-medium leading-none', tint)}>
            {label}
        </span>
    );
}
