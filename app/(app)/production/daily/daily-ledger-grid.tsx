'use client';

import * as React from 'react';
import { toast } from 'sonner';
import { errorToast } from '@/lib/toast';
import { Save, RotateCcw, ChevronsUpDown, Copy, ArrowUpFromLine, ArrowDownFromLine, Trash2, ChevronUp, ChevronDown, MessageSquare, ListFilter } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import {
    TableBody,
    TableCell,
    TableFooter,
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
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { GridCell } from '@/components/shared/grid/GridCell';
import { DatePickerCell, GridContextMenu, type GridMenuItem } from '@/components/shared/grid';
import { useGridContextMenu } from '@/lib/hooks/use-grid-context-menu';
import { useCellSelection } from '@/lib/hooks/use-cell-selection';
import { useClipboardCopy } from '@/lib/hooks/use-clipboard-copy';
import { useCellDelete } from '@/lib/hooks/use-cell-delete';
import { useCellAggregation, type AggregationType } from '@/lib/hooks/use-cell-aggregation';
import {
    useGridKeyboardNav,
    createCoordinateNavResolver,
    type CoordinateId,
    type GridRangeSlot,
} from '@/lib/hooks/use-grid-keyboard-nav';
import { useGridEditSession } from '@/lib/hooks/use-grid-edit-session';
import { useStatusBar } from '@/components/providers/status-bar-context';
import { parseExcelDate, trimCellValue } from '@/lib/paste-utils';
import { saveBulkDailyLedger } from './actions';
import type {
    ProductionShiftRow,
    ProductionRunRow,
    ProductionDowntimeRow,
    ProductionWasteRow,
    LedgerRowPayload,
} from './actions';

// ─── Constants ─────────────────────────────────────────────────────────────────
const GRADE_OPTIONS = ['3X50', '6X50', '8X50', '2X6'] as const;
const SHIFT_OPTIONS = ['M', 'E', 'N'] as const;
const CUSTOMER_OPTIONS = ['CEBU', 'KURARAY'] as const;

// ─── Column layout ─────────────────────────────────────────────────────────────
// Each section is visually grouped with a separator.
// col index map — null = not selectable/editable (row#, computed)
// Identity:   0=#  1=DATE  2=BATCH  3=SHIFT
// Production: 4=CUSTOMER  5=GRADE  6=TTL_KG  7=REM_RUN
// Downtime:   8=DT_HRS  9=DT_MINS  10=DT_TTL(computed)  11=PROD_HRS(computed)  12=DT_REASON
// Waste:      13=PROD_LOSS(computed)  14=TTL_WASTE(computed)  15=RS1A  16=RS1B  17=BF  18=RS23  19=RS5  20=TRML1  21=TRML2  22=GRIT
// (BAGS column removed — schema field still set to null on save)
// (Waste REM column removed — schema field still set to null on save)
// (Delete column removed — use right-click context menu)

type GridField =
    | 'date' | 'batch' | 'shift_code'
    | 'customer' | 'grade' | 'ttl_kg' | 'run_remarks'
    | 'dt_hrs' | 'dt_mins' | 'dt_reason'
    | 'rs1a' | 'rs1b' | 'bf' | 'rs23' | 'rs5' | 'trml1' | 'trml2' | 'grit';

const COL_MAP: (GridField | null)[] = [
    null,           // 0: row#
    'date',         // 1
    'batch',        // 2
    'shift_code',   // 3
    'customer',     // 4
    'grade',        // 5
    'ttl_kg',       // 6
    'run_remarks',  // 7
    'dt_hrs',       // 8
    'dt_mins',      // 9
    null,           // 10: DT TTL (computed)
    null,           // 11: PROD HRS (computed)
    'dt_reason',    // 12
    null,           // 13: PROD LOSS (computed)
    null,           // 14: TTL WASTE (computed)
    'rs1a',         // 15
    'rs1b',         // 16
    'bf',           // 17
    'rs23',         // 18
    'rs5',          // 19
    'trml1',        // 20
    'trml2',        // 21
    'grit',         // 22
];
const COL_COUNT = COL_MAP.length;

// Columns that belong to downtime/waste section — only editable on primary rows
const DOWNTIME_COLS = new Set([8, 9, 10, 11, 12]);
const WASTE_COLS = new Set([13, 14, 15, 16, 17, 18, 19, 20, 21, 22]);
const NUMERIC_FIELDS = new Set<GridField>(['ttl_kg', 'dt_hrs', 'dt_mins', 'rs1a', 'rs1b', 'bf', 'rs23', 'rs5', 'trml1', 'trml2', 'grit']);

// ─── Row state ─────────────────────────────────────────────────────────────────
type RowDirtyState = 'existing' | 'new' | 'modified' | 'deleted';

// Shift group key: "date|batch|shift"
type ShiftKey = string;

interface GridRow {
    _state: RowDirtyState;
    _shiftKey: ShiftKey;   // groups rows that share a shift
    _isPrimary: boolean;   // first run in this shift — owns downtime/waste columns
    _ids: {
        shift_id?: string;
        run_id?: string;
        downtime_id?: string;
        waste_id?: string;
    };
    // Identity (from shift)
    date: string;
    batch: string;
    shift_code: string;
    // Production run
    customer: string;
    grade: string;
    ttl_kg: string;
    bags: string;
    run_remarks: string;
    // Downtime (only on primary row; blanked on secondary rows)
    dt_hrs: string;
    dt_mins: string;
    dt_reason: string;
    // Waste (only on primary row)
    rs1a: string;
    rs1b: string;
    bf: string;
    rs23: string;
    rs5: string;
    trml1: string;
    trml2: string;
    grit: string;
    waste_remarks: string;
}

const SHIFT_KEY_SEPARATOR = '|';
function makeShiftKey(date: string, batch: string, shift: string): ShiftKey {
    return `${date}${SHIFT_KEY_SEPARATOR}${batch}${SHIFT_KEY_SEPARATOR}${shift}`;
}

// ─── Shift ordering ────────────────────────────────────────────────────────────
// Within any given date, shift rows always render Morning → Evening → Night,
// regardless of the DATE asc/desc toggle. Unknown shifts sort last (stable).
const SHIFT_RANK: Record<string, number> = { M: 0, E: 1, N: 2 };
function shiftRank(s: string): number {
    return SHIFT_RANK[(s ?? '').trim().toUpperCase()] ?? 99;
}

// ─── DB → Grid conversion ──────────────────────────────────────────────────────
function buildGridRows(
    shifts: ProductionShiftRow[],
    runs: ProductionRunRow[],
    downtime: ProductionDowntimeRow[],
    waste: ProductionWasteRow[],
    sortDir: 'asc' | 'desc' = 'asc',
): GridRow[] {
    // Index children by shift_id
    const runsByShift = new Map<string, ProductionRunRow[]>();
    for (const run of runs) {
        const group = runsByShift.get(run.shift_id) ?? [];
        group.push(run);
        runsByShift.set(run.shift_id, group);
    }
    const downtimeByShift = new Map(downtime.map(d => [d.shift_id, d]));
    const wasteByShift = new Map(waste.map(w => [w.shift_id, w]));

    // Sort shifts by transaction_date per the requested direction, then by
    // shift rank (M → E → N) ascending as a permanent tiebreaker. The server
    // returns shifts ASC by date but with arbitrary intra-date order, so the
    // shiftRank secondary key is what guarantees a stable M/E/N sequence.
    const orderedShifts = [...shifts].sort((a, b) => {
        const dateCmp = a.transaction_date.localeCompare(b.transaction_date);
        const primary = sortDir === 'asc' ? dateCmp : -dateCmp;
        if (primary !== 0) return primary;
        return shiftRank(a.shift) - shiftRank(b.shift);
    });

    const result: GridRow[] = [];

    for (const shift of orderedShifts) {
        const shiftKey = makeShiftKey(shift.transaction_date, shift.production_batch, shift.shift);
        const shiftRuns = runsByShift.get(shift.id) ?? [];
        const dt = downtimeByShift.get(shift.id);
        const w = wasteByShift.get(shift.id);

        if (shiftRuns.length === 0) {
            // Shift exists but has no runs — create one placeholder row
            result.push({
                _state: 'existing',
                _shiftKey: shiftKey,
                _isPrimary: true,
                _ids: {
                    shift_id: shift.id,
                    downtime_id: dt?.id,
                    waste_id: w?.id,
                },
                date: shift.transaction_date,
                batch: shift.production_batch,
                shift_code: shift.shift,
                customer: 'CEBU',
                grade: '',
                ttl_kg: '',
                bags: '',
                run_remarks: '',
                dt_hrs: dt?.dt_hrs != null ? String(dt.dt_hrs) : '',
                dt_mins: dt?.dt_mins != null ? String(dt.dt_mins) : '',
                dt_reason: dt?.dt_reason ?? '',
                rs1a: w?.rs1a_kg != null ? String(w.rs1a_kg) : '',
                rs1b: w?.rs1b_kg != null ? String(w.rs1b_kg) : '',
                bf: w?.bf_kg != null ? String(w.bf_kg) : '',
                rs23: w?.rs23_kg != null ? String(w.rs23_kg) : '',
                rs5: w?.rs5_kg != null ? String(w.rs5_kg) : '',
                trml1: w?.trml1_kg != null ? String(w.trml1_kg) : '',
                trml2: w?.trml2_kg != null ? String(w.trml2_kg) : '',
                grit: w?.grit_kg != null ? String(w.grit_kg) : '',
                waste_remarks: w?.remarks ?? '',
            });
            continue;
        }

        // Sort runs deterministically: customer asc, grade asc
        const sortedRuns = [...shiftRuns].sort((a, b) => {
            if (a.customer !== b.customer) return a.customer.localeCompare(b.customer);
            return a.grade.localeCompare(b.grade);
        });

        sortedRuns.forEach((run, idx) => {
            const isPrimary = idx === 0;
            result.push({
                _state: 'existing',
                _shiftKey: shiftKey,
                _isPrimary: isPrimary,
                _ids: {
                    shift_id: shift.id,
                    run_id: run.id,
                    downtime_id: dt?.id,
                    waste_id: w?.id,
                },
                date: shift.transaction_date,
                batch: shift.production_batch,
                shift_code: shift.shift,
                customer: run.customer ?? 'CEBU',
                grade: run.grade ?? '',
                ttl_kg: run.ttl_kg != null ? String(run.ttl_kg) : '',
                bags: run.sacks_bags != null ? String(run.sacks_bags) : '',
                run_remarks: run.remarks ?? '',
                // Only primary row shows downtime/waste data
                dt_hrs: isPrimary && dt?.dt_hrs != null ? String(dt.dt_hrs) : '',
                dt_mins: isPrimary && dt?.dt_mins != null ? String(dt.dt_mins) : '',
                dt_reason: isPrimary ? (dt?.dt_reason ?? '') : '',
                rs1a: isPrimary && w?.rs1a_kg != null ? String(w.rs1a_kg) : '',
                rs1b: isPrimary && w?.rs1b_kg != null ? String(w.rs1b_kg) : '',
                bf: isPrimary && w?.bf_kg != null ? String(w.bf_kg) : '',
                rs23: isPrimary && w?.rs23_kg != null ? String(w.rs23_kg) : '',
                rs5: isPrimary && w?.rs5_kg != null ? String(w.rs5_kg) : '',
                trml1: isPrimary && w?.trml1_kg != null ? String(w.trml1_kg) : '',
                trml2: isPrimary && w?.trml2_kg != null ? String(w.trml2_kg) : '',
                grit: isPrimary && w?.grit_kg != null ? String(w.grit_kg) : '',
                waste_remarks: isPrimary ? (w?.remarks ?? '') : '',
            });
        });
    }

    return result;
}

// ─── Empty row factory ─────────────────────────────────────────────────────────
function createEmptyRow(overrides: Partial<GridRow> = {}): GridRow {
    const today = new Date().toISOString().split('T')[0];
    const key = makeShiftKey(today, '', 'M');
    return {
        _state: 'new',
        _shiftKey: key,
        _isPrimary: true,
        _ids: {},
        date: today,
        batch: '',
        shift_code: 'M',
        customer: 'CEBU',
        grade: '',
        ttl_kg: '',
        bags: '',
        run_remarks: '',
        dt_hrs: '',
        dt_mins: '',
        dt_reason: '',
        rs1a: '',
        rs1b: '',
        bf: '',
        rs23: '',
        rs5: '',
        trml1: '',
        trml2: '',
        grit: '',
        waste_remarks: '',
        ...overrides,
    };
}

// ─── Paste cleaning ────────────────────────────────────────────────────────────
function cleanPasteValue(raw: string, field: GridField): string {
    const val = trimCellValue(raw);
    if (field === 'date') return parseExcelDate(val);
    if (NUMERIC_FIELDS.has(field)) return val.replace(/[₱,"'%,]/g, '');
    return val;
}

// ─── Input class ───────────────────────────────────────────────────────────────
const inputClass =
    'h-8 w-full px-1 border-transparent bg-transparent rounded-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-primary focus-visible:bg-accent/10 transition-colors shadow-none';

// ─── KG formatter ────────────────────────────────────────────────────────────
// Formats kg values as "000,000.00". Returns '' for null/undefined/NaN/empty.
// Genuine 0 renders as "0.00". Used for display-mode only — raw strings stay
// unformatted inside <Input> so typing is never disrupted.
function formatKg(value: number | string | null | undefined, decimals: number = 0): string {
    if (value === null || value === undefined || value === '') return '';
    const n = typeof value === 'string' ? parseFloat(value) : value;
    if (isNaN(n)) return '';
    return n.toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

// ─── Compact number formatter ──────────────────────────────────────────────────
// Condenses large totals so they fit in a footer cell. Full precision lives in a
// hover tooltip (see FooterAggCell). Examples:
//   1_200_000 → "1.2M"   2_000_000 → "2M"   600_000 → "600k"
//   13_000 → "13k"   1_500 → "1.5k"   842.7 → "843"   0 → "0"   -13_000 → "-13k"
function formatCompact(n: number): string {
    if (n === 0) return '0';
    const sign = n < 0 ? '-' : '';
    const abs = Math.abs(n);
    // Strip a trailing ".0" so "2.0M" renders as "2M".
    const strip = (s: string) => s.replace(/\.0$/, '');
    if (abs >= 1e6) {
        return sign + strip((abs / 1e6).toFixed(1)) + 'M';
    }
    if (abs >= 1e3) {
        // 1 decimal under 10k (e.g. "1.5k"), whole thousands at/above (e.g. "13k", "600k").
        const k = abs / 1e3;
        return sign + strip(abs < 10_000 ? k.toFixed(1) : Math.round(k).toString()) + 'k';
    }
    return sign + Math.round(abs).toString();
}

// ─── FooterAggCell ────────────────────────────────────────────────────────────
// Pill + value cell used in the totals footer row.
// The pill toggles between SUM (Σ) and AVG (x̄) on click.
interface FooterAggCellProps {
    mode: 'SUM' | 'AVG';
    onToggle: () => void;
    value: number;
    decimals: number;
    count: number;
}

function FooterAggCell({ mode, onToggle, value, decimals, count }: FooterAggCellProps) {
    const hasValue = count > 0;
    // Compact in the cell (e.g. "600k"); full precision in the hover tooltip.
    const compact = hasValue ? formatCompact(value) : '—';
    const full = formatKg(value, decimals);
    return (
        <div className="flex items-center justify-between gap-1 h-full w-full">
            <button
                type="button"
                onClick={onToggle}
                title={mode === 'SUM' ? 'Switch to Average' : 'Switch to Sum'}
                className={cn(
                    'flex-none h-5 px-1.5 rounded border text-[10px] font-mono font-bold leading-none select-none',
                    'transition-colors duration-100 cursor-pointer',
                    'border-foreground/20 hover:border-foreground/40',
                    mode === 'SUM'
                        ? 'bg-muted-foreground/10 text-foreground/70 hover:bg-muted-foreground/20'
                        : 'bg-primary/10 text-primary hover:bg-primary/20',
                )}
            >
                {mode === 'SUM' ? 'Σ' : 'x̄'}
            </button>
            {hasValue ? (
                <Tooltip>
                    <TooltipTrigger asChild>
                        <span className="font-mono font-semibold text-xs text-right tabular-nums leading-none cursor-default">
                            {compact}
                        </span>
                    </TooltipTrigger>
                    <TooltipContent side="top" align="end" className="text-xs font-mono">
                        {mode === 'SUM' ? 'Sum: ' : 'Avg: '}{full}
                    </TooltipContent>
                </Tooltip>
            ) : (
                <span className="font-mono font-semibold text-xs text-right tabular-nums leading-none">
                    {compact}
                </span>
            )}
        </div>
    );
}

// ─── NoteCell ──────────────────────────────────────────────────────────────────
// Houses a free-text field (run remarks, downtime reason) behind a clickable
// message icon. Display mode shows only the icon (no overflow); clicking it opens
// a Popover with an editable Textarea. This is the GridCell `displayValue` — the
// inline <Input> (GridCell children) remains the F2 / type-over / paste-in-edit path.
//
// CRITICAL: the parent GridCell display <div> has an onMouseDown that calls
// preventDefault() + stopPropagation() and starts drag-selection. That is what
// previously swallowed the click and blocked editing. The trigger button stops
// propagation on BOTH onMouseDown and onPointerDown so the click reaches the
// Popover trigger cleanly and never starts a cell drag.
interface NoteCellProps {
    value: string;
    onChange: (v: string) => void;
    placeholder?: string;
    /** Optional muted header label above the textarea. */
    label?: string;
}

function NoteCell({ value, onChange, placeholder, label }: NoteCellProps) {
    const hasContent = value.trim().length > 0;
    return (
        <Popover>
            <PopoverTrigger asChild>
                <button
                    type="button"
                    aria-label={hasContent ? `Edit note: ${value}` : 'Add note'}
                    title={hasContent ? value : placeholder}
                    onMouseDown={(e) => e.stopPropagation()}
                    onPointerDown={(e) => e.stopPropagation()}
                    className={cn(
                        'flex items-center justify-center w-full h-full outline-none transition-colors duration-150',
                        'focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-primary',
                        hasContent
                            ? 'text-primary hover:text-primary/80'
                            : 'text-muted-foreground/30 hover:text-muted-foreground/70',
                    )}
                >
                    <MessageSquare className="h-3.5 w-3.5" />
                </button>
            </PopoverTrigger>
            <PopoverContent
                align="start"
                side="bottom"
                className="w-72 p-2 bg-popover/95 backdrop-blur-lg"
                onOpenAutoFocus={(e) => e.preventDefault()}
            >
                {label && (
                    <p className="mb-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground select-none">
                        {label}
                    </p>
                )}
                <Textarea
                    autoFocus
                    rows={4}
                    value={value}
                    placeholder={placeholder}
                    onChange={(e) => onChange(e.target.value)}
                    onKeyDown={(e) => e.stopPropagation()}
                    className="resize-none font-mono text-xs"
                />
            </PopoverContent>
        </Popover>
    );
}

// ─── ColumnFilterMenu ───────────────────────────────────────────────────────────
// Compact header filter: a label + a ListFilter icon-button that opens a single-
// select DropdownMenu ("All" + each distinct value). Used on the SHIFT / CUSTOMER /
// GRADE headers. Filtering HIDES rows (it is NOT a sort). The icon tints to the
// primary color when a filter is active so the column reads as "filtered" at a glance.
//
// The trigger stops propagation on mousedown/pointerdown so opening the menu never
// starts a cell drag-selection in the grid underneath (same pattern as NoteCell).
interface ColumnFilterMenuProps {
    /** Visible header label (e.g. "SHIFT"). */
    label: string;
    /** Current selection — 'ALL' means no filter. */
    value: string;
    /** Distinct values to offer below the "All" option. */
    options: string[];
    onChange: (value: string) => void;
}

function ColumnFilterMenu({ label, value, options, onChange }: ColumnFilterMenuProps) {
    const isActive = value !== 'ALL';
    return (
        <span className="inline-flex items-center justify-center gap-0.5">
            {label}
            <DropdownMenu>
                <DropdownMenuTrigger asChild>
                    <button
                        type="button"
                        aria-label={`Filter ${label}${isActive ? `: ${value}` : ''}`}
                        title={isActive ? `${label}: ${value}` : `Filter ${label}`}
                        onMouseDown={(e) => e.stopPropagation()}
                        onPointerDown={(e) => e.stopPropagation()}
                        className={cn(
                            'flex items-center justify-center rounded p-0.5 outline-none transition-colors duration-150',
                            'focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-primary',
                            isActive
                                ? 'text-primary hover:text-primary/80'
                                : 'text-muted-foreground/50 hover:text-muted-foreground'
                        )}
                    >
                        <ListFilter className="h-3 w-3" />
                    </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" className="min-w-[100px] bg-popover/95 backdrop-blur-lg">
                    <DropdownMenuLabel className="px-2 py-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                        {label}
                    </DropdownMenuLabel>
                    <DropdownMenuSeparator />
                    <DropdownMenuRadioGroup value={value} onValueChange={onChange}>
                        <DropdownMenuRadioItem value="ALL" className="text-[11px] font-mono py-1">
                            All
                        </DropdownMenuRadioItem>
                        {options.map((opt) => (
                            <DropdownMenuRadioItem key={opt} value={opt} className="text-[11px] font-mono py-1">
                                {opt}
                            </DropdownMenuRadioItem>
                        ))}
                    </DropdownMenuRadioGroup>
                </DropdownMenuContent>
            </DropdownMenu>
        </span>
    );
}

// ─── Component props ───────────────────────────────────────────────────────────
// Period selection is owned by the production layout's universal picker — the grid
// receives only its already-filtered data + a save callback. The lazy tab remounts
// this grid (via key) when the period changes, so fresh data always arrives clean.
interface DailyLedgerGridProps {
    initialShifts: ProductionShiftRow[];
    initialRuns: ProductionRunRow[];
    initialDowntime: ProductionDowntimeRow[];
    initialWaste: ProductionWasteRow[];
    onSaveSuccess: () => void;
}

// ─── Main component ────────────────────────────────────────────────────────────
export function DailyLedgerGrid({
    initialShifts,
    initialRuns,
    initialDowntime,
    initialWaste,
    onSaveSuccess,
}: DailyLedgerGridProps) {
    const { setCellSelectionCount, setCellAggregates } = useStatusBar();
    const gridRef = React.useRef<HTMLDivElement>(null);

    const [rows, setRows] = React.useState<GridRow[]>(() => {
        const base = buildGridRows(initialShifts, initialRuns, initialDowntime, initialWaste, 'asc');
        return [...base, createEmptyRow()];
    });

    const [activeCell, setActiveCell] = React.useState<CoordinateId | null>(null);
    const [isSaving, setIsSaving] = React.useState(false);

    // Stable indirection so the mouse/blur handlers can end an active edit without a
    // forward reference to the edit session (created after the row mutators). Mirrors
    // the RC IN reference (bulk-delivery-input.tsx).
    const endEditRef = React.useRef<() => void>(() => {});

    // ─── Footer aggregate modes ────────────────────────────────────────────────
    type FooterMode = 'SUM' | 'AVG';
    const [ttlKgMode, setTtlKgMode] = React.useState<FooterMode>('SUM');
    const [dtTtlMode, setDtTtlMode] = React.useState<FooterMode>('SUM');
    const [prodHrsMode, setProdHrsMode] = React.useState<FooterMode>('SUM');
    const [ttlWasteMode, setTtlWasteMode] = React.useState<FooterMode>('SUM');

    // ─── Date sort direction ──────────────────────────────────────────────────
    const [dateSortDir, setDateSortDir] = React.useState<'asc' | 'desc'>('asc');

    // ─── Column header filters (single-select; 'ALL' = no filter) ─────────────
    // Each hides non-matching rows (index-preserving) and scopes the footer
    // aggregates. SHIFT/CUSTOMER/GRADE are filter-only — they are NOT sortable.
    const [shiftFilter, setShiftFilter] = React.useState<string>('ALL');
    const [customerFilter, setCustomerFilter] = React.useState<string>('ALL');
    const [gradeFilter, setGradeFilter] = React.useState<string>('ALL');

    // ─── Apply date sort when dateSortDir changes ─────────────────────────────
    // When the user toggles the date sort, we re-sort the current rows in-place
    // by their shift date, preserving shift grouping (primary rows always first
    // within a shift) and keeping the trailing empty row at the bottom.
    React.useEffect(() => {
        setRows(prev => {
            // Separate trailing empty row from data rows
            const trailing = prev[prev.length - 1]?._state === 'new' ? [prev[prev.length - 1]] : [];
            const dataRows = trailing.length > 0 ? prev.slice(0, -1) : prev;

            // Group rows by shiftKey, preserving internal order (primary first)
            const groups = new Map<string, GridRow[]>();
            const groupOrder: string[] = [];
            for (const row of dataRows) {
                if (!groups.has(row._shiftKey)) {
                    groups.set(row._shiftKey, []);
                    groupOrder.push(row._shiftKey);
                }
                groups.get(row._shiftKey)!.push(row);
            }

            // Sort shift keys by the date portion of the key ("date|batch|shift")
            // per the toggle, then by shift rank (M → E → N) ascending — the shift
            // sub-order is always M/E/N regardless of date direction.
            const sorted = [...groupOrder].sort((a, b) => {
                const dateA = a.split('|')[0] ?? '';
                const dateB = b.split('|')[0] ?? '';
                const dateCmp = dateA.localeCompare(dateB);
                const primary = dateSortDir === 'asc' ? dateCmp : -dateCmp;
                if (primary !== 0) return primary;
                return shiftRank(a.split('|')[2] ?? '') - shiftRank(b.split('|')[2] ?? '');
            });

            const reordered: GridRow[] = [];
            for (const key of sorted) {
                reordered.push(...(groups.get(key) ?? []));
            }

            return [...reordered, ...trailing];
        });
    // Only re-sort when the direction changes — not on every row mutation.
    // setRows is a stable setter and shiftRank is a module constant, so dateSortDir
    // is the only reactive dependency.
    }, [dateSortDir]);

    // ─── Context menu state (shared Blackwood Table primitive) ──────────────────
    // Height uses the primary-row menu height (164); secondary-row menus are
    // shorter (120) but the difference only affects the bottom-edge flip threshold.
    const contextMenu = useGridContextMenu<number>({ width: 188, height: 164 });

    // ─── Cell selection ───────────────────────────────────────────────────────
    const isSelectableColumn = React.useCallback((c: number) => {
        if (c === 0) return false; // row-number col — never selectable
        // Computed columns (10=DT TTL, 11=PROD HRS, 13=PROD LOSS, 14=TTL WASTE) are not
        // in COL_MAP (they're null) but are still draggable for COUNT/SUM aggregation.
        if (c === 10 || c === 11 || c === 13 || c === 14) return true;
        return COL_MAP[c] !== null;
    }, []);

    const cellSelection = useCellSelection({
        rowCount: rows.length,
        colCount: COL_COUNT,
        isSelectableColumn,
        scrollContainerRef: gridRef,
        enabled: true,
    });

    // ─── Cell value accessors (for clipboard/aggregation) ─────────────────────
    const getCellValue = React.useCallback(
        (rowIdx: number, colIdx: number): string => {
            const row = rows[rowIdx];
            if (!row) return '';

            // Computed: DT TTL (col 10)
            if (colIdx === 10) {
                const dtHrs = parseFloat(row.dt_hrs) || 0;
                const dtMins = parseFloat(row.dt_mins) || 0;
                return dtHrs > 0 || dtMins > 0 ? (dtHrs + dtMins / 60).toFixed(2) : '';
            }
            // Computed: PROD HRS (col 11) — uses hardcoded shift default of 8h when shift_hrs absent
            if (colIdx === 11) {
                const dtHrs = parseFloat(row.dt_hrs) || 0;
                const dtMins = parseFloat(row.dt_mins) || 0;
                const effectiveShift = 8;
                return (effectiveShift - dtHrs - dtMins / 60).toFixed(2);
            }
            // Computed: PROD LOSS (col 13)
            if (colIdx === 13) {
                const totalWaste =
                    (parseFloat(row.rs1a) || 0) +
                    (parseFloat(row.rs1b) || 0) +
                    (parseFloat(row.bf) || 0) +
                    (parseFloat(row.rs23) || 0) +
                    (parseFloat(row.rs5) || 0) +
                    (parseFloat(row.trml1) || 0) +
                    (parseFloat(row.trml2) || 0) +
                    (parseFloat(row.grit) || 0);
                const ttlKg = parseFloat(row.ttl_kg) || 0;
                const denominator = ttlKg + totalWaste;
                return denominator > 0 ? ((totalWaste / denominator) * 100).toFixed(2) + '%' : '';
            }
            // Computed: TTL WASTE (col 14)
            if (colIdx === 14) {
                const total =
                    (parseFloat(row.rs1a) || 0) +
                    (parseFloat(row.rs1b) || 0) +
                    (parseFloat(row.bf) || 0) +
                    (parseFloat(row.rs23) || 0) +
                    (parseFloat(row.rs5) || 0) +
                    (parseFloat(row.trml1) || 0) +
                    (parseFloat(row.trml2) || 0) +
                    (parseFloat(row.grit) || 0);
                return total > 0 ? total.toFixed(2) : '';
            }

            const field = COL_MAP[colIdx];
            if (!field) return '';
            return String(row[field as keyof GridRow] ?? '');
        },
        [rows]
    );

    const getNumericCellValue = React.useCallback(
        (rowIdx: number, colIdx: number): number | null => {
            const row = rows[rowIdx];
            if (!row) return null;
            // Allow computed columns to be aggregatable (DT TTL=10, PROD HRS=11, TTL WASTE=14)
            if (colIdx === 10 || colIdx === 11 || colIdx === 14) {
                const v = parseFloat(getCellValue(rowIdx, colIdx));
                return isNaN(v) ? null : v;
            }
            const field = COL_MAP[colIdx];
            if (!field || !NUMERIC_FIELDS.has(field)) return null;
            const v = parseFloat(String(row[field as keyof GridRow]));
            return isNaN(v) ? null : v;
        },
        [rows, getCellValue]
    );

    const getColumnDefaultCalcType = React.useCallback(
        (colIdx: number): AggregationType | null => {
            const field = COL_MAP[colIdx];
            // DT TTL=10, PROD HRS=11, TTL WASTE=14
            if (colIdx === 10 || colIdx === 11 || colIdx === 14) return 'SUM';
            if (field === 'dt_hrs' || field === 'dt_mins') return 'SUM';
            if (field === 'ttl_kg') return 'SUM';
            if (field === 'rs1a' || field === 'rs1b' || field === 'bf' || field === 'rs23' ||
                field === 'rs5' || field === 'trml1' || field === 'trml2' || field === 'grit') return 'SUM';
            return null;
        },
        []
    );

    const aggregates = useCellAggregation({ range: cellSelection.range, getNumericCellValue, getColumnDefaultCalcType });

    // Compute size as a value (not function call inside effect) so the dep is a primitive — avoids effect thrash on every render
    const selectionSize = cellSelection.range ? cellSelection.getSelectionSize() : 0;

    // Push count + aggregates to the shared StatusBarProvider.
    // Update effect — only clears the timeout on dep change; does NOT wipe state to 0.
    // Wiping in cleanup caused the bar to never settle: every range change re-ran cleanup → count=0 → setTimeout scheduled → next range change before 50ms → cleanup again → never reached the set.
    React.useEffect(() => {
        const timer = setTimeout(() => {
            setCellSelectionCount(selectionSize);
            setCellAggregates(selectionSize > 1 ? aggregates : null);
        }, 50);
        return () => clearTimeout(timer);
    }, [selectionSize, aggregates, setCellSelectionCount, setCellAggregates]);

    // Unmount-only cleanup — clears state when grid leaves the tree (tab switch, remount on month change, etc.)
    React.useEffect(() => {
        return () => {
            setCellSelectionCount(0);
            setCellAggregates(null);
        };
    }, [setCellSelectionCount, setCellAggregates]);

    const { handleKeyDown: handleCopyKeyDown } = useClipboardCopy({
        getSelectedRange: cellSelection.getSelectedRange,
        getCellValue,
        getSelectionSize: cellSelection.getSelectionSize,
    });

    // ─── Mouse handlers ───────────────────────────────────────────────────────
    const mouseDownCellRef = React.useRef<{ row: number; col: number } | null>(null);
    const dragMovedRef = React.useRef(false);

    const handleCellMouseDown = React.useCallback(
        (rowIdx: number, colIdx: number, e: React.MouseEvent) => {
            mouseDownCellRef.current = { row: rowIdx, col: colIdx };
            dragMovedRef.current = false;
            cellSelection.handleCellMouseDown(rowIdx, colIdx, e);
        },
        [cellSelection]
    );

    const handleCellMouseUp = React.useCallback(
        (rowIdx: number, colIdx: number) => {
            const down = mouseDownCellRef.current;
            mouseDownCellRef.current = null;
            if (down && down.row === rowIdx && down.col === colIdx && !dragMovedRef.current) {
                cellSelection.clearSelection();
                setActiveCell({ row: rowIdx, col: colIdx });
                endEditRef.current();
                gridRef.current?.focus();
            }
            dragMovedRef.current = false;
        },
        [cellSelection]
    );

    const handleCellMouseEnter = React.useCallback(
        (rowIdx: number, colIdx: number) => {
            if (mouseDownCellRef.current) {
                dragMovedRef.current = true;
                cellSelection.handleCellMouseEnter(rowIdx, colIdx);
            }
        },
        [cellSelection]
    );

    // ─── Row mutation helpers ─────────────────────────────────────────────────
    const recomputeShiftPrimary = (rows: GridRow[]): GridRow[] => {
        // After any structural change, recompute _isPrimary and _shiftKey
        const seenShifts = new Map<string, boolean>();
        return rows.map(row => {
            const key = makeShiftKey(row.date, row.batch, row.shift_code);
            const isPrimary = !seenShifts.has(key);
            seenShifts.set(key, true);
            return { ...row, _shiftKey: key, _isPrimary: isPrimary };
        });
    };

    const updateRow = React.useCallback(
        (idx: number, field: GridField, value: string) => {
            setRows(prev => {
                const next = [...prev];
                const row = { ...next[idx], [field]: value };
                if (row._state === 'existing') row._state = 'modified';

                // If shift identity changed, recompute shift keys
                if (field === 'date' || field === 'batch' || field === 'shift_code') {
                    next[idx] = row;
                    const recomputed = recomputeShiftPrimary(next);
                    const last = recomputed[recomputed.length - 1];
                    if (last._state !== 'new') recomputed.push(createEmptyRow());
                    return recomputed;
                }

                next[idx] = row;
                const last = next[next.length - 1];
                if (last._state !== 'new') next.push(createEmptyRow());
                return next;
            });
        },
        []
    );

    // Propagate downtime/waste edits to the primary row of the same shift
    const updateShiftData = React.useCallback(
        (rowIdx: number, field: GridField, value: string) => {
            setRows(prev => {
                const next = [...prev];
                const editedRow = next[rowIdx];
                if (!editedRow) return prev;
                const shiftKey = editedRow._shiftKey;

                // Find primary row for this shift
                const primaryIdx = next.findIndex(r => r._shiftKey === shiftKey && r._isPrimary);
                if (primaryIdx === -1) return prev;

                const primaryRow = { ...next[primaryIdx], [field]: value };
                if (primaryRow._state === 'existing') primaryRow._state = 'modified';
                next[primaryIdx] = primaryRow;

                const last = next[next.length - 1];
                if (last._state !== 'new') next.push(createEmptyRow());
                return next;
            });
        },
        []
    );

    const markDeleted = React.useCallback((idx: number) => {
        setRows(prev => {
            const next = [...prev];
            const row = { ...next[idx] };
            if (row._state === 'new') {
                if (next.length > 1) { next.splice(idx, 1); }
                return next;
            }
            row._state = 'deleted';
            next[idx] = row;
            return next;
        });
    }, []);

    const restoreRow = React.useCallback((idx: number) => {
        setRows(prev => {
            const next = [...prev];
            const row = { ...next[idx] };
            row._state = row._ids.run_id ? 'existing' : 'new';
            next[idx] = row;
            return next;
        });
    }, []);

    const clearCell = React.useCallback(
        (rowIdx: number, colIdx: number) => {
            const field = COL_MAP[colIdx];
            if (!field) return;
            const row = rows[rowIdx];
            if (!row) return;
            if (DOWNTIME_COLS.has(colIdx) || WASTE_COLS.has(colIdx)) {
                updateShiftData(rowIdx, field, '');
            } else {
                updateRow(rowIdx, field, '');
            }
        },
        [rows, updateRow, updateShiftData]
    );

    // ─── Add secondary grade row ──────────────────────────────────────────────
    const addSecondaryRow = React.useCallback(
        (primaryRowIdx: number) => {
            setRows(prev => {
                const next = [...prev];
                const primary = next[primaryRowIdx];
                if (!primary) return prev;

                // Find last row with this shift key
                let insertIdx = primaryRowIdx;
                for (let i = primaryRowIdx + 1; i < next.length; i++) {
                    if (next[i]._shiftKey === primary._shiftKey) insertIdx = i;
                    else break;
                }

                const newRow: GridRow = {
                    _state: 'new',
                    _shiftKey: primary._shiftKey,
                    _isPrimary: false,
                    _ids: { shift_id: primary._ids.shift_id },
                    date: primary.date,
                    batch: primary.batch,
                    shift_code: primary.shift_code,
                    customer: 'CEBU',
                    grade: '',
                    ttl_kg: '',
                    bags: '',
                    run_remarks: '',
                    // Secondary rows have no downtime/waste data
                    dt_hrs: '',
                    dt_mins: '',
                    dt_reason: '',
                    rs1a: '',
                    rs1b: '',
                    bf: '',
                    rs23: '',
                    rs5: '',
                    trml1: '',
                    trml2: '',
                    grit: '',
                    waste_remarks: '',
                };

                next.splice(insertIdx + 1, 0, newRow);
                const last = next[next.length - 1];
                if (last._state !== 'new') next.push(createEmptyRow());
                return next;
            });
        },
        []
    );

    // ─── Context menu row actions ─────────────────────────────────────────────
    const insertRowAbove = React.useCallback((idx: number) => {
        setRows(prev => {
            const next = [...prev];
            const ref = next[idx];
            const newRow = createEmptyRow({
                date: ref.date,
                batch: ref.batch,
                shift_code: ref.shift_code,
            });
            next.splice(idx, 0, newRow);
            const recomputed = recomputeShiftPrimary(next);
            const last = recomputed[recomputed.length - 1];
            if (last._state !== 'new') recomputed.push(createEmptyRow());
            return recomputed;
        });
    }, []);

    const insertRowBelow = React.useCallback((idx: number) => {
        setRows(prev => {
            const next = [...prev];
            const ref = next[idx];
            const newRow = createEmptyRow({
                date: ref.date,
                batch: ref.batch,
                shift_code: ref.shift_code,
            });
            next.splice(idx + 1, 0, newRow);
            const recomputed = recomputeShiftPrimary(next);
            const last = recomputed[recomputed.length - 1];
            if (last._state !== 'new') recomputed.push(createEmptyRow());
            return recomputed;
        });
    }, []);

    const duplicateRow = React.useCallback((idx: number) => {
        setRows(prev => {
            const next = [...prev];
            const src = next[idx];
            const dup: GridRow = {
                ...src,
                _state: 'new',
                _ids: { shift_id: src._ids.shift_id },
                // secondary rows only duplicate run columns
                dt_hrs: src._isPrimary ? src.dt_hrs : '',
                dt_mins: src._isPrimary ? src.dt_mins : '',
                dt_reason: src._isPrimary ? src.dt_reason : '',
                rs1a: src._isPrimary ? src.rs1a : '',
                rs1b: src._isPrimary ? src.rs1b : '',
                bf: src._isPrimary ? src.bf : '',
                rs23: src._isPrimary ? src.rs23 : '',
                rs5: src._isPrimary ? src.rs5 : '',
                trml1: src._isPrimary ? src.trml1 : '',
                trml2: src._isPrimary ? src.trml2 : '',
                grit: src._isPrimary ? src.grit : '',
                waste_remarks: src._isPrimary ? src.waste_remarks : '',
            };
            next.splice(idx + 1, 0, dup);
            const recomputed = recomputeShiftPrimary(next);
            const last = recomputed[recomputed.length - 1];
            if (last._state !== 'new') recomputed.push(createEmptyRow());
            return recomputed;
        });
    }, []);

    // Right-click row menu items (shared Blackwood Table primitive). Matches the
    // prior hand-rolled menu exactly:
    //   • Insert above/below — DISABLED (greyed) on secondary rows (was `disabled`).
    //   • Add Grade Row — HIDDEN unless the row is primary AND not new (was a
    //     conditional render).
    //   • Delete vs Restore — TWO items gated by `hidden` (static `variant` can't
    //     flip destructive↔muted in one item); Delete keeps the red styling.
    const ctxRowState = React.useCallback((idx: number) => rows[idx], [rows]);
    const ROW_MENU_ITEMS = React.useMemo<GridMenuItem<number>[]>(() => [
        {
            kind: 'item', label: 'Insert Row Above', icon: ArrowUpFromLine,
            onSelect: (idx) => insertRowAbove(idx),
            disabled: (idx) => !ctxRowState(idx)?._isPrimary,
        },
        {
            kind: 'item', label: 'Insert Row Below', icon: ArrowDownFromLine,
            onSelect: (idx) => insertRowBelow(idx),
            disabled: (idx) => !ctxRowState(idx)?._isPrimary,
        },
        { kind: 'item', label: 'Duplicate Row', icon: Copy, onSelect: (idx) => duplicateRow(idx) },
        {
            kind: 'item', label: 'Add Grade Row', icon: ChevronsUpDown,
            onSelect: (idx) => addSecondaryRow(idx),
            hidden: (idx) => {
                const r = ctxRowState(idx);
                return !(r?._isPrimary && r?._state !== 'new');
            },
        },
        { kind: 'separator' },
        {
            kind: 'item', label: 'Delete Row', icon: Trash2, variant: 'destructive',
            onSelect: (idx) => markDeleted(idx),
            hidden: (idx) => ctxRowState(idx)?._state === 'deleted',
        },
        {
            kind: 'item', label: 'Restore Row', icon: RotateCcw,
            onSelect: (idx) => restoreRow(idx),
            hidden: (idx) => ctxRowState(idx)?._state !== 'deleted',
        },
    ], [insertRowAbove, insertRowBelow, duplicateRow, addSecondaryRow, markDeleted, restoreRow, ctxRowState]);

    // ─── Delete helpers ───────────────────────────────────────────────────────
    const { handleKeyDown: handleDeleteKeyDown } = useCellDelete({
        getSelectedRange: cellSelection.getSelectedRange,
        getSelectionSize: cellSelection.getSelectionSize,
        clearCell,
    });

    // ─── Editing (shared Blackwood Table edit session) ────────────────────────
    // The session owns isEditing + the pre-edit snapshot. setValue routes
    // downtime/waste fields through updateShiftData (which propagates to the shift's
    // primary row) and everything else through updateRow — preserving the dual
    // write paths. The active-cell state stays in the component.
    const setCellValue = React.useCallback(
        (id: CoordinateId, value: string) => {
            const field = COL_MAP[id.col];
            if (!field) return;
            if (DOWNTIME_COLS.has(id.col) || WASTE_COLS.has(id.col)) {
                updateShiftData(id.row, field, value);
            } else {
                updateRow(id.row, field, value);
            }
        },
        [updateRow, updateShiftData]
    );

    const editSession = useGridEditSession<CoordinateId>({
        getValue: (id) => getCellValue(id.row, id.col),
        setValue: setCellValue,
    });
    const isEditing = editSession.isEditing;
    // Keep the stable endEdit indirection pointing at the latest commit.
    endEditRef.current = () => { if (editSession.isEditing) editSession.commit(); };

    // GridCell-compatible adapter. Keeps the secondary-row guard (downtime/waste
    // cells are read-only on non-primary rows) so row-dependent editability is NOT
    // regressed: the resolver gates by column only, but this start guard is the
    // authoritative per-cell editability check.
    const startEditing = React.useCallback(
        (rowIdx: number, colIdx: number, initialChar?: string) => {
            const field = COL_MAP[colIdx];
            if (!field) return;
            const row = rows[rowIdx];
            if (!row) return;
            // Secondary rows: only allow editing run columns (4-7), not downtime/waste
            if (!row._isPrimary && (DOWNTIME_COLS.has(colIdx) || WASTE_COLS.has(colIdx))) return;
            setActiveCell({ row: rowIdx, col: colIdx });
            editSession.startEditing({ row: rowIdx, col: colIdx }, initialChar);
        },
        [rows, editSession]
    );

    // Custom revert (NOT the session's) so the original `_state` rollback is
    // preserved: reverting a run-id-backed modified row drops it back to 'existing'.
    // The session's setValue path would re-mark it 'modified', so we mutate directly
    // using the session's pre-edit snapshot, then clear the edit flag via commit.
    const revertChanges = React.useCallback(() => {
        if (!activeCell) return;
        const field = COL_MAP[activeCell.col];
        if (field) {
            const snapshot = editSession.preEditValueRef.current ?? '';
            setRows(prev => {
                const next = [...prev];
                const row = { ...next[activeCell.row] };
                (row as Record<string, unknown>)[field] = snapshot;
                if (row._state === 'modified' && row._ids.run_id) row._state = 'existing';
                next[activeCell.row] = row;
                return next;
            });
        }
        editSession.commit();
        gridRef.current?.focus();
    }, [activeCell, editSession]);

    // ─── Grid navigation (shared Blackwood Table primitives) ──────────────────
    // Coordinate resolver = the old moveActive math. Rebuilt only when row count
    // changes so Tab/Enter boundary clamps stay correct.
    const resolver = React.useMemo(
        () => createCoordinateNavResolver({ rowCount: rows.length, columnMap: COL_MAP }),
        [rows.length]
    );

    const isRangeSelected = cellSelection.getSelectionSize() > 1;

    const rangeSlot = React.useMemo<GridRangeSlot>(() => ({
        isRangeSelected,
        extend: (e) => cellSelection.handleKeyDown(e),
        clear: () => cellSelection.clearSelection(),
        seedFromActive: () => {
            if (!activeCell) return;
            cellSelection.handleCellMouseDown(
                activeCell.row,
                activeCell.col,
                { shiftKey: false, button: 0, preventDefault: () => {} } as unknown as React.MouseEvent
            );
            cellSelection.handleMouseUp();
        },
        anchorId: () => {
            const range = cellSelection.range;
            return range ? { row: range.startRow, col: range.startCol } : null;
        },
        onCopy: (e) => handleCopyKeyDown(e),
        onDelete: (e) => handleDeleteKeyDown(e),
    }), [isRangeSelected, cellSelection, activeCell, handleCopyKeyDown, handleDeleteKeyDown]);

    const { handleKeyDown: navKeyDown } = useGridKeyboardNav<CoordinateId>({
        activeCell,
        setActiveCell,
        isEditing,
        resolver,
        edit: {
            start: (id, char) => startEditing(id.row, id.col, char),
            revert: revertChanges,
            commit: () => { editSession.commit(); gridRef.current?.focus(); },
        },
        range: rangeSlot,
        // Plain Enter always drops straight down (no Tab-then-Enter lane return).
        enableEnterAnchor: false,
    });

    // Home/End column jumps are not part of the shared state machine, so they are
    // intercepted here (only when not editing) before delegating — preserving the
    // original behavior (Home → first writable col, End → last col).
    const handleGridKeyDown = React.useCallback(
        (e: React.KeyboardEvent) => {
            if (!isEditing && activeCell && (e.key === 'Home' || e.key === 'End')) {
                e.preventDefault();
                setActiveCell({
                    row: activeCell.row,
                    col: e.key === 'Home' ? 1 : COL_COUNT - 1,
                });
                return;
            }
            navKeyDown(e);
        },
        [isEditing, activeCell, navKeyDown]
    );

    // ─── Paste ────────────────────────────────────────────────────────────────
    const handleSmartPaste = React.useCallback(
        (e: React.ClipboardEvent, startRow: number, startCol: number) => {
            e.preventDefault();
            const text = e.clipboardData.getData('text');
            if (!text) return;
            const pastedRows = text.split(/\r\n|\n|\r/).filter(r => r.trim() !== '');
            if (!pastedRows.length) return;
            setRows(prev => {
                const next = [...prev];
                pastedRows.forEach((pastedRow, rOffset) => {
                    const targetRow = startRow + rOffset;
                    if (targetRow >= next.length) next.push(createEmptyRow());
                    const cols = pastedRow.split('\t');
                    cols.forEach((cellVal, cOffset) => {
                        const targetCol = startCol + cOffset;
                        if (targetCol >= COL_COUNT) return;
                        const field = COL_MAP[targetCol];
                        if (!field) return;
                        const row = { ...next[targetRow] };
                        (row as Record<string, unknown>)[field] = cleanPasteValue(cellVal, field);
                        if (row._state === 'existing') row._state = 'modified';
                        next[targetRow] = row;
                    });
                });
                const recomputed = recomputeShiftPrimary(next);
                const last = recomputed[recomputed.length - 1];
                if (last._state !== 'new') recomputed.push(createEmptyRow());
                return recomputed;
            });
            toast.success(`Pasted ${pastedRows.length} rows`);
        },
        []
    );

    const handleGridPaste = React.useCallback(
        (e: React.ClipboardEvent) => {
            if (!isEditing && activeCell) {
                handleSmartPaste(e, activeCell.row, activeCell.col);
                cellSelection.clearSelection();
            }
        },
        [isEditing, activeCell, handleSmartPaste, cellSelection]
    );

    // ─── Dirty state ──────────────────────────────────────────────────────────
    const isDirty = rows.some(r => {
        if (r._state === 'deleted') return true;
        if (r._state === 'modified') return true;
        if (r._state === 'new' && (r.grade || r.ttl_kg || r.batch)) return true;
        return false;
    });

    const handleDiscard = React.useCallback(() => {
        const base = buildGridRows(initialShifts, initialRuns, initialDowntime, initialWaste, dateSortDir);
        setRows([...base, createEmptyRow()]);
        setActiveCell(null);
        endEditRef.current();
    }, [initialShifts, initialRuns, initialDowntime, initialWaste, dateSortDir]);

    // ─── Save ─────────────────────────────────────────────────────────────────
    const handleSave = async () => {
        setIsSaving(true);
        try {
            const payload: LedgerRowPayload[] = [];

            // Build per-shift accumulation: track which shift has had its downtime/waste row included
            const shiftDowntimeIncluded = new Set<string>();
            const shiftWasteIncluded = new Set<string>();

            for (const row of rows) {
                // Skip pure trailing empty row
                if (row._state === 'new' && !row.grade && !row.ttl_kg && !row.batch) continue;

                const shiftKey = row._shiftKey;

                // Determine downtime payload for this row
                // The primary row carries downtime for its shift; secondary rows do not.
                let downtimePayload: LedgerRowPayload['downtime'] = null;
                let wastePayload: LedgerRowPayload['waste'] = null;

                if (row._isPrimary && !shiftDowntimeIncluded.has(shiftKey)) {
                    downtimePayload = {
                        shift_hrs: null,
                        dt_hrs: row.dt_hrs ? parseFloat(row.dt_hrs) : null,
                        dt_mins: row.dt_mins ? parseFloat(row.dt_mins) : null,
                        dt_reason: row.dt_reason || null,
                    };
                    shiftDowntimeIncluded.add(shiftKey);
                }

                if (row._isPrimary && !shiftWasteIncluded.has(shiftKey)) {
                    wastePayload = {
                        rs1a_kg: row.rs1a ? parseFloat(row.rs1a) : null,
                        rs1b_kg: row.rs1b ? parseFloat(row.rs1b) : null,
                        bf_kg: row.bf ? parseFloat(row.bf) : null,
                        rs23_kg: row.rs23 ? parseFloat(row.rs23) : null,
                        rs5_kg: row.rs5 ? parseFloat(row.rs5) : null,
                        trml1_kg: row.trml1 ? parseFloat(row.trml1) : null,
                        trml2_kg: row.trml2 ? parseFloat(row.trml2) : null,
                        grit_kg: row.grit ? parseFloat(row.grit) : null,
                        // waste remarks no longer exposed in UI — schema field still set but always null
                        remarks: null,
                    };
                    shiftWasteIncluded.add(shiftKey);
                }

                payload.push({
                    _state: row._state,
                    _ids: {
                        shift_id: row._ids.shift_id,
                        run_id: row._ids.run_id,
                        downtime_id: row._ids.downtime_id,
                        waste_id: row._ids.waste_id,
                    },
                    shift: {
                        transaction_date: row.date,
                        production_batch: row.batch,
                        shift: row.shift_code,
                    },
                    run: {
                        customer: row.customer || 'CEBU',
                        grade: row.grade,
                        ttl_kg: row.ttl_kg ? parseFloat(row.ttl_kg) : null,
                        // sacks_bags no longer exposed in UI — schema field still set but always null
                        sacks_bags: null,
                        remarks: row.run_remarks || null,
                    },
                    downtime: downtimePayload,
                    waste: wastePayload,
                });
            }

            if (payload.length === 0) {
                toast.info('No changes to save.');
                setIsSaving(false);
                return;
            }

            const res = await saveBulkDailyLedger(payload);
            if (!res.ok) {
                errorToast(res.error);
            } else {
                const parts: string[] = [];
                if (res.upsertedRuns) parts.push(`${res.upsertedRuns} run${res.upsertedRuns !== 1 ? 's' : ''} saved`);
                if (res.deletedRuns) parts.push(`${res.deletedRuns} deleted`);
                toast.success(`Saved — ${parts.join(', ')}`);
                onSaveSuccess();
            }
        } catch (err) {
            errorToast('Unexpected error: ' + (err instanceof Error ? err.message : String(err)));
        } finally {
            setIsSaving(false);
        }
    };

    // ─── Cell selection helper props ──────────────────────────────────────────
    const selProps = (rowIdx: number, colIdx: number) => ({
        onCellMouseDown: (e: React.MouseEvent) => handleCellMouseDown(rowIdx, colIdx, e),
        onCellMouseUp: () => handleCellMouseUp(rowIdx, colIdx),
        onCellMouseEnter: () => handleCellMouseEnter(rowIdx, colIdx),
        isCellRangeSelected: cellSelection.isSelected(rowIdx, colIdx),
        isCellRangeAnchor: cellSelection.isAnchor(rowIdx, colIdx),
        isDragActive: cellSelection.isDragging,
    });

    // GridCell-compatible setIsEditing adapter: GridCell (and a couple of inline
    // call sites) call setIsEditing(false) to end an edit — route that to the
    // session's commit. setIsEditing(true) is never used by GridCell.
    const setIsEditing = React.useCallback((editing: boolean) => {
        if (!editing) editSession.commit();
    }, [editSession]);

    const commonCellProps = {
        activeCell,
        isEditing,
        setActiveCell,
        setIsEditing,
        onStartEditing: startEditing,
        onRevert: revertChanges,
        gridRef,
    };

    // ─── Distinct values present in current rows (for header filter menus) ────
    // Excludes deleted + trailing 'new' rows. Shifts are sorted M → E → N so the
    // menu lists them in canonical order; customers/grades are sorted alpha.
    const distinctShifts = React.useMemo(() => {
        const shifts = new Set<string>();
        for (const r of rows) {
            if (r._state !== 'deleted' && r._state !== 'new' && r.shift_code) {
                shifts.add(r.shift_code);
            }
        }
        return [...shifts].sort((a, b) => shiftRank(a) - shiftRank(b) || a.localeCompare(b));
    }, [rows]);

    const distinctCustomers = React.useMemo(() => {
        const customers = new Set<string>();
        for (const r of rows) {
            if (r._state !== 'deleted' && r._state !== 'new' && r.customer) {
                customers.add(r.customer);
            }
        }
        return [...customers].sort();
    }, [rows]);

    const distinctGrades = React.useMemo(() => {
        const grades = new Set<string>();
        for (const r of rows) {
            if (r._state !== 'deleted' && r._state !== 'new' && r.grade) {
                grades.add(r.grade);
            }
        }
        return [...grades].sort();
    }, [rows]);

    // ─── Per-row visibility under the active column filters ───────────────────
    // Index-preserving: rows are HIDDEN (display:none), never spliced — so cell
    // selection / paste / context-menu indices stay aligned with the full array.
    // The trailing 'new' row is ALWAYS visible so the operator can keep typing.
    const isRowHidden = React.useCallback(
        (row: GridRow): boolean => {
            if (row._state === 'new') return false;
            if (shiftFilter !== 'ALL' && row.shift_code !== shiftFilter) return true;
            if (customerFilter !== 'ALL' && row.customer !== customerFilter) return true;
            if (gradeFilter !== 'ALL' && row.grade !== gradeFilter) return true;
            return false;
        },
        [shiftFilter, customerFilter, gradeFilter]
    );

    // ─── Footer aggregates ─────────────────────────────────────────────────────
    // Eligible rows: skip 'deleted' and trailing 'new', AND respect every active
    // column filter (SHIFT/CUSTOMER/GRADE) so the footer reflects exactly what is
    // visible. TTL KG sums all visible run rows; DT TTL / PROD HRS / TTL WASTE stay
    // primary-row metrics (downtime/waste ride on the shift's primary row).
    const footerAgg = React.useMemo(() => {
        const visible = (r: GridRow): boolean => {
            if (shiftFilter !== 'ALL' && r.shift_code !== shiftFilter) return false;
            if (customerFilter !== 'ALL' && r.customer !== customerFilter) return false;
            if (gradeFilter !== 'ALL' && r.grade !== gradeFilter) return false;
            return true;
        };
        const eligible = rows.filter(r => r._state !== 'deleted' && r._state !== 'new' && visible(r));

        const ttlKgVals: number[] = [];
        for (const r of eligible) {
            const v = parseFloat(r.ttl_kg);
            if (!isNaN(v)) ttlKgVals.push(v);
        }

        // Primary-only rows (already constrained to the visible set above)
        const primaryEligible = eligible.filter(r => r._isPrimary);

        const dtTtlVals: number[] = [];
        const prodHrsVals: number[] = [];
        const ttlWasteVals: number[] = [];

        for (const r of primaryEligible) {
            const dtH = parseFloat(r.dt_hrs) || 0;
            const dtM = parseFloat(r.dt_mins) || 0;
            const dtTtl = dtH + dtM / 60;
            dtTtlVals.push(dtTtl);
            prodHrsVals.push(8 - dtTtl);

            const waste =
                (parseFloat(r.rs1a) || 0) +
                (parseFloat(r.rs1b) || 0) +
                (parseFloat(r.bf) || 0) +
                (parseFloat(r.rs23) || 0) +
                (parseFloat(r.rs5) || 0) +
                (parseFloat(r.trml1) || 0) +
                (parseFloat(r.trml2) || 0) +
                (parseFloat(r.grit) || 0);
            ttlWasteVals.push(waste);
        }

        const sumOf = (vals: number[]) => vals.reduce((a, b) => a + b, 0);
        const avgOf = (vals: number[]) => vals.length > 0 ? sumOf(vals) / vals.length : 0;

        return {
            ttlKg: { sum: sumOf(ttlKgVals), avg: avgOf(ttlKgVals), count: ttlKgVals.length },
            dtTtl: { sum: sumOf(dtTtlVals), avg: avgOf(dtTtlVals), count: dtTtlVals.length },
            prodHrs: { sum: sumOf(prodHrsVals), avg: avgOf(prodHrsVals), count: prodHrsVals.length },
            ttlWaste: { sum: sumOf(ttlWasteVals), avg: avgOf(ttlWasteVals), count: ttlWasteVals.length },
        };
    }, [rows, shiftFilter, customerFilter, gradeFilter]);

    // ─── Counts ───────────────────────────────────────────────────────────────
    const shiftCount = new Set(rows.filter(r => r._state !== 'new').map(r => r._shiftKey)).size;
    const runCount = rows.filter(r => r._state !== 'new' && r._ids.run_id).length;

    // ─── Render ───────────────────────────────────────────────────────────────
    return (
        <TooltipProvider>
            {/* Datalists for typeahead suggestions */}
            <datalist id="customer-suggestions">
                {CUSTOMER_OPTIONS.map(c => (
                    <option key={c} value={c} />
                ))}
            </datalist>
            <datalist id="grade-suggestions">
                {GRADE_OPTIONS.map(g => (
                    <option key={g} value={g} />
                ))}
            </datalist>
            <datalist id="shift-suggestions">
                {SHIFT_OPTIONS.map(s => (
                    <option key={s} value={s} />
                ))}
            </datalist>
            <div className="flex flex-col gap-0">
                {/* Toolbar — period selection lives in the production layout's universal
                    picker; this toolbar keeps only the shift/run count + Save/Discard. */}
                <div className="flex items-center justify-between px-2 py-1 border-b bg-muted/20 gap-2">
                    {/* Left: shift / run count */}
                    <div className="flex items-center gap-1.5 flex-shrink-0">
                        <span className="text-[10px] text-muted-foreground">
                            {shiftCount} shift{shiftCount !== 1 ? 's' : ''} · {runCount} run{runCount !== 1 ? 's' : ''}
                        </span>
                    </div>

                    {/* Right: Save/Discard */}
                    <div className="flex items-center gap-1">
                        {isDirty && (
                            <Button
                                variant="ghost"
                                size="sm"
                                className="h-6 px-2 text-xs gap-1"
                                onClick={handleDiscard}
                                disabled={isSaving}
                            >
                                <RotateCcw className="h-3 w-3" />
                                Discard
                            </Button>
                        )}
                        <Button
                            size="sm"
                            className="h-6 px-2 text-xs gap-1"
                            onClick={handleSave}
                            disabled={isSaving || !isDirty}
                        >
                            <Save className="h-3 w-3" />
                            {isSaving ? 'Saving…' : 'Save'}
                        </Button>
                    </div>
                </div>

                {/* Grid */}
                <div
                    ref={gridRef}
                    className="outline-none select-none overflow-auto relative max-h-[70vh]"
                    tabIndex={-1}
                    onKeyDown={handleGridKeyDown}
                    onPaste={handleGridPaste}
                    onBlur={(e) => {
                        if (!e.currentTarget.contains(e.relatedTarget)) {
                            setActiveCell(null);
                            setIsEditing(false);
                        }
                    }}
                >
                    <table className="table-fixed text-xs relative" style={{ width: '100%', minWidth: '1604px', borderCollapse: 'separate', borderSpacing: 0 }}>
                        {/* Explicit column widths — pins layout for sticky cells.
                            table-fixed + colSpan'd first row ignores per-cell widths,
                            so <colgroup> is the only reliable way to lock column geometry. */}
                        <colgroup>
                            {/* Frozen (8 cols, total 652px): # / DATE / BATCH / SHIFT / CUSTOMER / GRADE / TTL KG / REM(inline) */}
                            <col style={{ width: '28px' }} />
                            <col style={{ width: '96px' }} />
                            <col style={{ width: '64px' }} />
                            <col style={{ width: '52px' }} />
                            <col style={{ width: '72px' }} />
                            <col style={{ width: '60px' }} />
                            <col style={{ width: '80px' }} />
                            <col style={{ width: '200px' }} />
                            {/* Downtime (5 cols, total 348px): DT HRS / DT MIN / DT TTL / PROD HRS / DT REASON */}
                            <col style={{ width: '52px' }} />
                            <col style={{ width: '52px' }} />
                            <col style={{ width: '60px' }} />
                            <col style={{ width: '64px' }} />
                            <col style={{ width: '120px' }} />
                            {/* Waste (10 cols, total 604px): PROD LOSS / TTL WASTE / RS1A / RS1B / BF / RS2/3 / RS5 / TRML1 / TRML2 / GRIT */}
                            <col style={{ width: '64px' }} />
                            <col style={{ width: '72px' }} />
                            <col style={{ width: '60px' }} />
                            <col style={{ width: '60px' }} />
                            <col style={{ width: '56px' }} />
                            <col style={{ width: '60px' }} />
                            <col style={{ width: '56px' }} />
                            <col style={{ width: '60px' }} />
                            <col style={{ width: '60px' }} />
                            <col style={{ width: '56px' }} />
                        </colgroup>
                        <TableHeader className="bg-muted backdrop-blur-sm sticky top-0 z-50 shadow-sm">
                            {/* Section headers */}
                            <TableRow className="hover:bg-transparent border-b border-foreground/10" style={{ height: '20px' }}>
                                {/* # — sticky, z-40 (header + column intersection) */}
                                <TableHead className="h-5 px-1 py-0 font-mono font-bold text-center text-[9px] border-r border-foreground/10 w-[28px] sticky z-40 bg-muted" style={{ left: 0 }} />
                                {/* Identity — sticky */}
                                <TableHead colSpan={3} className="h-5 px-1 py-0 font-mono font-bold text-center text-[9px] border-r border-foreground/20 bg-muted text-blue-600 dark:text-blue-400 uppercase tracking-widest sticky z-40" style={{ left: 28 }}>
                                    Identity
                                </TableHead>
                                {/* Production — sticky (CUSTOMER / GRADE / TTL KG / REM). Same right-edge shadow as the REM column below so the freeze-pane separator is continuous top-to-bottom. */}
                                <TableHead colSpan={4} className="h-5 px-1 py-0 font-mono font-bold text-center text-[9px] bg-muted text-green-600 dark:text-green-400 uppercase tracking-widest sticky z-40 shadow-[2px_0_4px_rgba(0,0,0,0.12)]" style={{ left: 28 + 96 + 64 + 52 }}>
                                    Production
                                </TableHead>
                                {/* Downtime — scrolling. bg-muted matches frozen sections so the whole header row reads as one solid bar (no "floating" appearance). */}
                                <TableHead colSpan={5} className="h-5 px-1 py-0 font-mono font-bold text-center text-[9px] border-r border-foreground/20 bg-muted text-amber-600 dark:text-amber-400 uppercase tracking-widest">
                                    Downtime
                                </TableHead>
                                {/* Waste — scrolling. Same uniform bg as the rest. */}
                                <TableHead colSpan={10} className="h-5 px-1 py-0 font-mono font-bold text-center text-[9px] bg-muted text-red-600 dark:text-red-400 uppercase tracking-widest">
                                    Waste
                                </TableHead>
                            </TableRow>
                            {/* Column headers */}
                            <TableRow className="hover:bg-transparent border-b border-foreground/20" style={{ height: '28px' }}>
                                {/* # — sticky col 0 */}
                                <TableHead className="w-[28px] h-7 px-1 py-0 font-mono font-bold text-center text-[10px] border-r border-foreground/10 sticky z-40 bg-muted" style={{ left: 0 }}>#</TableHead>
                                {/* Identity — sticky cols 1-3 */}
                                <TableHead
                                    className="w-[96px] h-7 px-1 py-0 font-mono font-bold text-center text-[10px] border-r border-foreground/10 bg-muted sticky z-40 cursor-pointer select-none hover:bg-muted-foreground/10 transition-colors"
                                    style={{ left: 28 }}
                                    onClick={() => setDateSortDir(d => d === 'asc' ? 'desc' : 'asc')}
                                    title={dateSortDir === 'asc' ? 'Sort descending' : 'Sort ascending'}
                                >
                                    <span className="inline-flex items-center justify-center gap-0.5">
                                        DATE
                                        {dateSortDir === 'asc'
                                            ? <ChevronUp className="h-3 w-3 text-muted-foreground" />
                                            : <ChevronDown className="h-3 w-3 text-primary" />
                                        }
                                    </span>
                                </TableHead>
                                <TableHead className="w-[64px] h-7 px-1 py-0 font-mono font-bold text-center text-[10px] border-r border-foreground/10 bg-muted sticky z-40" style={{ left: 124 }}>BATCH</TableHead>
                                <TableHead className="w-[52px] h-7 px-1 py-0 font-mono font-bold text-center text-[10px] border-r border-foreground/20 bg-muted sticky z-40" style={{ left: 188 }}>
                                    <ColumnFilterMenu label="SHIFT" value={shiftFilter} options={distinctShifts} onChange={setShiftFilter} />
                                </TableHead>
                                {/* Production — sticky cols 4-8 */}
                                <TableHead className="w-[72px] h-7 px-1 py-0 font-mono font-bold text-center text-[10px] border-r border-foreground/10 bg-muted sticky z-40" style={{ left: 240 }}>
                                    <ColumnFilterMenu label="CUSTOMER" value={customerFilter} options={distinctCustomers} onChange={setCustomerFilter} />
                                </TableHead>
                                <TableHead className="w-[60px] h-7 px-1 py-0 font-mono font-bold text-center text-[10px] border-r border-foreground/10 bg-muted sticky z-40" style={{ left: 312 }}>
                                    <ColumnFilterMenu label="GRADE" value={gradeFilter} options={distinctGrades} onChange={setGradeFilter} />
                                </TableHead>
                                <TableHead className="w-[80px] h-7 px-1 py-0 font-mono font-bold text-center text-[10px] border-r border-foreground/10 bg-muted sticky z-40" style={{ left: 372 }}>TTL KG</TableHead>
                                {/* REM — last frozen col, inline text, gets separator shadow */}
                                <TableHead className="w-[200px] h-7 px-1 py-0 font-mono font-bold text-center text-[10px] bg-muted sticky z-40 shadow-[2px_0_4px_rgba(0,0,0,0.12)]" style={{ left: 452 }}>REM</TableHead>
                                {/* Downtime — scrolling */}
                                <TableHead className="w-[52px] h-7 px-1 py-0 font-mono font-bold text-center text-[10px] border-r border-foreground/10 bg-amber-500/5">DT HRS</TableHead>
                                <TableHead className="w-[52px] h-7 px-1 py-0 font-mono font-bold text-center text-[10px] border-r border-foreground/10 bg-amber-500/5">DT MIN</TableHead>
                                <TableHead className="w-[60px] h-7 px-1 py-0 font-mono font-bold text-center text-[10px] border-r border-foreground/10 bg-amber-500/10 text-amber-700 dark:text-amber-300">DT TTL</TableHead>
                                <TableHead className="w-[64px] h-7 px-1 py-0 font-mono font-bold text-center text-[10px] border-r border-foreground/10 bg-amber-500/10 text-amber-700 dark:text-amber-300">PROD HRS</TableHead>
                                <TableHead className="w-[120px] h-7 px-1 py-0 font-mono font-bold text-center text-[10px] border-r border-foreground/20 bg-amber-500/5">DT REASON</TableHead>
                                {/* Waste — reordered: PROD LOSS / TTL WASTE first */}
                                <TableHead className="w-[64px] h-7 px-1 py-0 font-mono font-bold text-center text-[10px] border-r border-foreground/10 bg-red-500/10 text-red-700 dark:text-red-300">PROD LOSS</TableHead>
                                <TableHead className="w-[72px] h-7 px-1 py-0 font-mono font-bold text-center text-[10px] border-r border-foreground/10 bg-red-500/10 text-red-700 dark:text-red-300">TTL WASTE</TableHead>
                                <TableHead className="w-[60px] h-7 px-1 py-0 font-mono font-bold text-center text-[10px] border-r border-foreground/10 bg-red-500/5">RS1A</TableHead>
                                <TableHead className="w-[60px] h-7 px-1 py-0 font-mono font-bold text-center text-[10px] border-r border-foreground/10 bg-red-500/5">RS1B</TableHead>
                                <TableHead className="w-[56px] h-7 px-1 py-0 font-mono font-bold text-center text-[10px] border-r border-foreground/10 bg-red-500/5">BF</TableHead>
                                <TableHead className="w-[60px] h-7 px-1 py-0 font-mono font-bold text-center text-[10px] border-r border-foreground/10 bg-red-500/5">RS2/3</TableHead>
                                <TableHead className="w-[56px] h-7 px-1 py-0 font-mono font-bold text-center text-[10px] border-r border-foreground/10 bg-red-500/5">RS5</TableHead>
                                <TableHead className="w-[60px] h-7 px-1 py-0 font-mono font-bold text-center text-[10px] border-r border-foreground/10 bg-red-500/5">TRML1</TableHead>
                                <TableHead className="w-[60px] h-7 px-1 py-0 font-mono font-bold text-center text-[10px] border-r border-foreground/10 bg-red-500/5">TRML2</TableHead>
                                <TableHead className="w-[56px] h-7 px-1 py-0 font-mono font-bold text-center text-[10px] bg-red-500/5">GRIT</TableHead>
                            </TableRow>
                        </TableHeader>
                        <TableBody>
                            {/* Empty state */}
                            {rows.length === 1 && rows[0]._state === 'new' && (
                                <TableRow className="hover:bg-transparent">
                                    <TableCell colSpan={23} className="py-8 text-center">
                                        <p className="text-xs text-muted-foreground animate-fade-up">
                                            Awaiting Production Manager sync. Start typing in the empty row, or paste a range from Excel.
                                        </p>
                                    </TableCell>
                                </TableRow>
                            )}

                            {rows.map((row, rowIdx) => {
                                const isDeleted = row._state === 'deleted';
                                const isDirtyRow = row._state === 'modified';
                                const isNewRow = row._state === 'new';
                                const isSecondary = !row._isPrimary;
                                // Index-preserving filter: hidden rows render with display:none
                                // (via the `hidden` attribute) so array indices — and therefore
                                // cell selection, paste, and the context menu — stay aligned.
                                const rowHidden = isRowHidden(row);

                                // Computed downtime values (shift default = 8h)
                                const dtHrs = parseFloat(row.dt_hrs) || 0;
                                const dtMins = parseFloat(row.dt_mins) || 0;
                                const dtTtl = dtHrs + dtMins / 60;
                                const prodHrs = 8 - dtTtl;

                                // Computed waste values
                                const totalWaste =
                                    (parseFloat(row.rs1a) || 0) +
                                    (parseFloat(row.rs1b) || 0) +
                                    (parseFloat(row.bf) || 0) +
                                    (parseFloat(row.rs23) || 0) +
                                    (parseFloat(row.rs5) || 0) +
                                    (parseFloat(row.trml1) || 0) +
                                    (parseFloat(row.trml2) || 0) +
                                    (parseFloat(row.grit) || 0);
                                const ttlKg = parseFloat(row.ttl_kg) || 0;
                                const prodLossPct = (ttlKg + totalWaste) > 0
                                    ? (totalWaste / (ttlKg + totalWaste)) * 100
                                    : null;

                                // Secondary row: downtime/waste cells are muted/blank
                                const showDtWaste = row._isPrimary;

                                return (
                                    <TableRow
                                        key={rowIdx}
                                        hidden={rowHidden}
                                        className={cn(
                                            'group transition-all duration-150 border-b border-border/30',
                                            rowHidden && 'hidden',
                                            isDeleted && 'opacity-40 line-through',
                                            isDirtyRow && !isSecondary && 'border-l-2 border-l-amber-400',
                                            isNewRow && 'border-l-2 border-l-blue-400/50',
                                            isSecondary && 'bg-muted/20',
                                            contextMenu.state?.ref === rowIdx && 'bg-accent/30'
                                        )}
                                        style={{ height: '28px' }}
                                        onContextMenu={(e) => {
                                            e.preventDefault();
                                            contextMenu.open(rowIdx, e.clientX, e.clientY);
                                            // Make the right-clicked row the active row
                                            setActiveCell({ row: rowIdx, col: 1 });
                                            setIsEditing(false);
                                        }}
                                    >
                                        {/* Row number — sticky col 0 */}
                                        <TableCell className="px-1 py-0 text-center font-mono text-[10px] text-muted-foreground border-r border-border/30 sticky z-30 bg-background" style={{ height: '28px', left: 0 }}>
                                            {isNewRow ? (
                                                row._isPrimary ? (
                                                    <span className="text-muted-foreground/30">—</span>
                                                ) : null
                                            ) : rowIdx + 1}
                                        </TableCell>

                                        {/* ── DATE — sticky col 1 ── */}
                                        <TableCell className={cn('px-0 py-0 border-r border-border/30 bg-background group-hover:bg-muted/50 transition-colors duration-150 sticky z-30', isSecondary && 'text-muted-foreground/30')} style={{ height: '28px', left: 28 }}>
                                            {!isSecondary ? (
                                                <DatePickerCell
                                                    value={row.date}
                                                    onChange={(v) => updateRow(rowIdx, 'date', v)}
                                                    onPaste={(e) => { e.stopPropagation(); handleSmartPaste(e, rowIdx, 1); }}
                                                    isActive={activeCell?.row === rowIdx && activeCell?.col === 1}
                                                    isRangeSelected={cellSelection.isSelected(rowIdx, 1)}
                                                    isRangeAnchor={cellSelection.isAnchor(rowIdx, 1)}
                                                    onCellMouseDown={(e) => handleCellMouseDown(rowIdx, 1, e)}
                                                    onCellMouseUp={() => handleCellMouseUp(rowIdx, 1)}
                                                    onCellMouseEnter={() => handleCellMouseEnter(rowIdx, 1)}
                                                />
                                            ) : (
                                                <div className="h-full w-full flex items-center justify-center text-muted-foreground/30 text-[10px] font-mono">
                                                    ↑
                                                </div>
                                            )}
                                        </TableCell>

                                        {/* ── BATCH — sticky col 2 ── */}
                                        <TableCell className={cn('px-0 py-0 border-r border-border/30 bg-background group-hover:bg-muted/50 transition-colors duration-150 sticky z-30', isSecondary && 'text-muted-foreground/30')} style={{ height: '28px', left: 124 }}>
                                            {!isSecondary ? (
                                                <GridCell col={2} row={rowIdx} value={row.batch} className="font-mono font-semibold text-center text-xs" {...commonCellProps} {...selProps(rowIdx, 2)}>
                                                    <Input autoFocus value={row.batch} onChange={e => updateRow(rowIdx, 'batch', e.target.value)} className={cn(inputClass, 'font-mono font-semibold text-center text-xs uppercase')} onPaste={e => { e.stopPropagation(); handleSmartPaste(e, rowIdx, 2); }} />
                                                </GridCell>
                                            ) : (
                                                <div className="h-full w-full flex items-center justify-center text-muted-foreground/30 text-[10px] font-mono">↑</div>
                                            )}
                                        </TableCell>

                                        {/* ── SHIFT — sticky col 3 ── */}
                                        <TableCell className={cn('px-0 py-0 border-r border-foreground/20 bg-background group-hover:bg-muted/50 transition-colors duration-150 sticky z-30', isSecondary && 'text-muted-foreground/30')} style={{ height: '28px', left: 188 }}>
                                            {!isSecondary ? (
                                                <GridCell col={3} row={rowIdx} value={row.shift_code} className="font-mono font-semibold text-center text-xs" {...commonCellProps} {...selProps(rowIdx, 3)}>
                                                    <Input
                                                        autoFocus
                                                        value={row.shift_code}
                                                        onChange={e => updateRow(rowIdx, 'shift_code', e.target.value.toUpperCase())}
                                                        className={cn(inputClass, 'font-mono font-semibold text-center text-xs uppercase')}
                                                        list="shift-suggestions"
                                                        onPaste={e => { e.stopPropagation(); handleSmartPaste(e, rowIdx, 3); }}
                                                    />
                                                </GridCell>
                                            ) : (
                                                <div className="h-full w-full flex items-center justify-center text-muted-foreground/30 text-[10px] font-mono">↑</div>
                                            )}
                                        </TableCell>

                                        {/* ── CUSTOMER — sticky col 4 ── */}
                                        <TableCell className="px-0 py-0 border-r border-border/30 bg-background group-hover:bg-muted/50 transition-colors duration-150 sticky z-30" style={{ height: '28px', left: 240 }}>
                                            <GridCell col={4} row={rowIdx} value={row.customer} className="font-mono font-semibold text-center text-xs" {...commonCellProps} {...selProps(rowIdx, 4)}>
                                                <Input
                                                    autoFocus
                                                    value={row.customer}
                                                    onChange={e => updateRow(rowIdx, 'customer', e.target.value.toUpperCase())}
                                                    className={cn(inputClass, 'font-mono font-semibold text-center text-xs uppercase')}
                                                    list="customer-suggestions"
                                                    onPaste={e => { e.stopPropagation(); handleSmartPaste(e, rowIdx, 4); }}
                                                />
                                            </GridCell>
                                        </TableCell>

                                        {/* ── GRADE — sticky col 5 ── */}
                                        <TableCell className="px-0 py-0 border-r border-border/30 bg-background group-hover:bg-muted/50 transition-colors duration-150 sticky z-30" style={{ height: '28px', left: 312 }}>
                                            <GridCell col={5} row={rowIdx} value={row.grade} className="font-mono font-semibold text-center text-xs" {...commonCellProps} {...selProps(rowIdx, 5)}>
                                                <Input
                                                    autoFocus
                                                    value={row.grade}
                                                    onChange={e => updateRow(rowIdx, 'grade', e.target.value.toUpperCase())}
                                                    className={cn(inputClass, 'font-mono font-semibold text-center text-xs uppercase')}
                                                    list="grade-suggestions"
                                                    onPaste={e => { e.stopPropagation(); handleSmartPaste(e, rowIdx, 5); }}
                                                />
                                            </GridCell>
                                        </TableCell>

                                        {/* ── TTL KG — sticky col 6 ── */}
                                        <TableCell className="px-0 py-0 border-r border-border/30 bg-background group-hover:bg-muted/50 transition-colors duration-150 sticky z-30" style={{ height: '28px', left: 372 }}>
                                            <GridCell col={6} row={rowIdx} value={formatKg(row.ttl_kg)} className="font-mono font-semibold text-right pr-1" {...commonCellProps} {...selProps(rowIdx, 6)}>
                                                <Input autoFocus type="number" step="1" value={row.ttl_kg} onChange={e => updateRow(rowIdx, 'ttl_kg', e.target.value)} className={cn(inputClass, 'font-mono font-semibold text-right text-xs')} onPaste={e => { e.stopPropagation(); handleSmartPaste(e, rowIdx, 6); }} />
                                            </GridCell>
                                        </TableCell>

                                        {/* ── RUN REMARKS — sticky col 7 (last frozen, inline text), separator shadow ── */}
                                        <TableCell className="px-0 py-0 bg-background group-hover:bg-muted/50 transition-colors duration-150 sticky z-30 shadow-[2px_0_4px_rgba(0,0,0,0.12)]" style={{ height: '28px', left: 452 }}>
                                            <GridCell
                                                col={7} row={rowIdx} value={row.run_remarks}
                                                className="font-mono text-xs text-left"
                                                {...commonCellProps} {...selProps(rowIdx, 7)}
                                                displayValue={
                                                    <NoteCell
                                                        value={row.run_remarks}
                                                        onChange={v => updateRow(rowIdx, 'run_remarks', v)}
                                                        placeholder="Add remarks…"
                                                        label="Remarks"
                                                    />
                                                }
                                            >
                                                <Input
                                                    autoFocus
                                                    value={row.run_remarks}
                                                    onChange={e => updateRow(rowIdx, 'run_remarks', e.target.value)}
                                                    className={cn(inputClass, 'font-mono text-xs text-left px-2')}
                                                    onPaste={e => { e.stopPropagation(); handleSmartPaste(e, rowIdx, 7); }}
                                                />
                                            </GridCell>
                                        </TableCell>

                                        {/* ── DT HRS — scrolling (col 8) ── */}
                                        <TableCell className="px-0 py-0 border-r border-border/30 bg-amber-500/[0.03]" style={{ height: '28px' }}>
                                            {showDtWaste ? (
                                                <GridCell col={8} row={rowIdx} value={row.dt_hrs} className="font-mono text-right pr-1" {...commonCellProps} {...selProps(rowIdx, 8)}>
                                                    <Input autoFocus type="number" step="1" min="0" value={row.dt_hrs} onChange={e => updateShiftData(rowIdx, 'dt_hrs', e.target.value)} className={cn(inputClass, 'font-mono text-right text-xs')} onPaste={e => { e.stopPropagation(); handleSmartPaste(e, rowIdx, 8); }} />
                                                </GridCell>
                                            ) : (
                                                <div className="h-full w-full bg-muted/30" />
                                            )}
                                        </TableCell>

                                        {/* ── DT MINS (col 9) ── */}
                                        <TableCell className="px-0 py-0 border-r border-border/30 bg-amber-500/[0.03]" style={{ height: '28px' }}>
                                            {showDtWaste ? (
                                                <GridCell col={9} row={rowIdx} value={row.dt_mins} className="font-mono text-right pr-1" {...commonCellProps} {...selProps(rowIdx, 9)}>
                                                    <Input autoFocus type="number" step="1" min="0" max="59" value={row.dt_mins} onChange={e => updateShiftData(rowIdx, 'dt_mins', e.target.value)} className={cn(inputClass, 'font-mono text-right text-xs')} onPaste={e => { e.stopPropagation(); handleSmartPaste(e, rowIdx, 9); }} />
                                                </GridCell>
                                            ) : (
                                                <div className="h-full w-full bg-muted/30" />
                                            )}
                                        </TableCell>

                                        {/* ── DT TTL (computed, col 10) ── */}
                                        <TableCell
                                            className={cn(
                                                'px-1 py-0 border-r border-border/30 bg-amber-500/10 font-mono font-semibold text-right text-xs text-amber-700 dark:text-amber-300 select-none cursor-default',
                                                cellSelection.isSelected(rowIdx, 10) && 'bg-primary/10 dark:bg-primary/20',
                                                cellSelection.isAnchor(rowIdx, 10) && 'ring-2 ring-primary ring-inset z-10',
                                            )}
                                            style={{ height: '28px' }}
                                            onMouseDown={(e) => handleCellMouseDown(rowIdx, 10, e)}
                                            onMouseUp={() => handleCellMouseUp(rowIdx, 10)}
                                            onMouseEnter={() => handleCellMouseEnter(rowIdx, 10)}
                                        >
                                            {showDtWaste ? ((dtHrs > 0 || dtMins > 0) ? dtTtl.toFixed(2) : '') : null}
                                        </TableCell>

                                        {/* ── PROD HRS (computed, col 11) ── */}
                                        <TableCell
                                            className={cn(
                                                'px-1 py-0 border-r border-border/30 bg-amber-500/10 font-mono font-semibold text-right text-xs text-amber-700 dark:text-amber-300 select-none cursor-default',
                                                cellSelection.isSelected(rowIdx, 11) && 'bg-primary/10 dark:bg-primary/20',
                                                cellSelection.isAnchor(rowIdx, 11) && 'ring-2 ring-primary ring-inset z-10',
                                            )}
                                            style={{ height: '28px' }}
                                            onMouseDown={(e) => handleCellMouseDown(rowIdx, 11, e)}
                                            onMouseUp={() => handleCellMouseUp(rowIdx, 11)}
                                            onMouseEnter={() => handleCellMouseEnter(rowIdx, 11)}
                                        >
                                            {showDtWaste ? prodHrs.toFixed(2) : null}
                                        </TableCell>

                                        {/* ── DT REASON (col 12) ── */}
                                        <TableCell className="px-0 py-0 border-r border-foreground/20 bg-amber-500/[0.03]" style={{ height: '28px' }}>
                                            {showDtWaste ? (
                                                <GridCell
                                                    col={12} row={rowIdx} value={row.dt_reason}
                                                    className="text-xs px-1"
                                                    {...commonCellProps} {...selProps(rowIdx, 12)}
                                                    displayValue={
                                                        <NoteCell
                                                            value={row.dt_reason}
                                                            onChange={v => updateShiftData(rowIdx, 'dt_reason', v)}
                                                            placeholder="Add downtime reason…"
                                                            label="Downtime reason"
                                                        />
                                                    }
                                                >
                                                    <Input autoFocus value={row.dt_reason} onChange={e => updateShiftData(rowIdx, 'dt_reason', e.target.value)} className={cn(inputClass, 'text-xs')} onPaste={e => { e.stopPropagation(); handleSmartPaste(e, rowIdx, 12); }} />
                                                </GridCell>
                                            ) : (
                                                <div className="h-full w-full bg-muted/30" />
                                            )}
                                        </TableCell>

                                        {/* ── PROD LOSS (computed, col 13) — FIRST in waste ── */}
                                        {/* Note: col 13 aggregates as COUNT only (percentage string). SUM is intentionally
                                            excluded in getColumnDefaultCalcType — averaging percentages is misleading. */}
                                        <TableCell
                                            className={cn(
                                                'px-1 py-0 border-r border-border/30 bg-red-500/10 font-mono font-semibold text-right text-xs text-red-700 dark:text-red-300 select-none cursor-default',
                                                cellSelection.isSelected(rowIdx, 13) && 'bg-primary/10 dark:bg-primary/20',
                                                cellSelection.isAnchor(rowIdx, 13) && 'ring-2 ring-primary ring-inset z-10',
                                            )}
                                            style={{ height: '28px' }}
                                            onMouseDown={(e) => handleCellMouseDown(rowIdx, 13, e)}
                                            onMouseUp={() => handleCellMouseUp(rowIdx, 13)}
                                            onMouseEnter={() => handleCellMouseEnter(rowIdx, 13)}
                                        >
                                            {showDtWaste && prodLossPct !== null ? prodLossPct.toFixed(2) + '%' : (showDtWaste ? '' : null)}
                                        </TableCell>

                                        {/* ── TTL WASTE (computed, col 14) ── */}
                                        <TableCell
                                            className={cn(
                                                'px-1 py-0 border-r border-border/30 bg-red-500/10 font-mono font-semibold text-right text-xs text-red-700 dark:text-red-300 select-none cursor-default',
                                                cellSelection.isSelected(rowIdx, 14) && 'bg-primary/10 dark:bg-primary/20',
                                                cellSelection.isAnchor(rowIdx, 14) && 'ring-2 ring-primary ring-inset z-10',
                                            )}
                                            style={{ height: '28px' }}
                                            onMouseDown={(e) => handleCellMouseDown(rowIdx, 14, e)}
                                            onMouseUp={() => handleCellMouseUp(rowIdx, 14)}
                                            onMouseEnter={() => handleCellMouseEnter(rowIdx, 14)}
                                        >
                                            {showDtWaste ? (totalWaste > 0 ? formatKg(totalWaste, 2) : '') : null}
                                        </TableCell>

                                        {/* ── WASTE: RS1A (col 15) ── */}
                                        <TableCell className="px-0 py-0 border-r border-border/30 bg-red-500/[0.03]" style={{ height: '28px' }}>
                                            {showDtWaste ? (
                                                <GridCell col={15} row={rowIdx} value={formatKg(row.rs1a)} className="font-mono text-right pr-1" {...commonCellProps} {...selProps(rowIdx, 15)}>
                                                    <Input autoFocus type="number" step="0.5" value={row.rs1a} onChange={e => updateShiftData(rowIdx, 'rs1a', e.target.value)} className={cn(inputClass, 'font-mono text-right text-xs')} onPaste={e => { e.stopPropagation(); handleSmartPaste(e, rowIdx, 15); }} />
                                                </GridCell>
                                            ) : (
                                                <div className="h-full w-full bg-muted/30" />
                                            )}
                                        </TableCell>

                                        {/* ── WASTE: RS1B (col 16) ── */}
                                        <TableCell className="px-0 py-0 border-r border-border/30 bg-red-500/[0.03]" style={{ height: '28px' }}>
                                            {showDtWaste ? (
                                                <GridCell col={16} row={rowIdx} value={formatKg(row.rs1b)} className="font-mono text-right pr-1" {...commonCellProps} {...selProps(rowIdx, 16)}>
                                                    <Input autoFocus type="number" step="0.5" value={row.rs1b} onChange={e => updateShiftData(rowIdx, 'rs1b', e.target.value)} className={cn(inputClass, 'font-mono text-right text-xs')} onPaste={e => { e.stopPropagation(); handleSmartPaste(e, rowIdx, 16); }} />
                                                </GridCell>
                                            ) : (
                                                <div className="h-full w-full bg-muted/30" />
                                            )}
                                        </TableCell>

                                        {/* ── WASTE: BF (col 17) ── */}
                                        <TableCell className="px-0 py-0 border-r border-border/30 bg-red-500/[0.03]" style={{ height: '28px' }}>
                                            {showDtWaste ? (
                                                <GridCell col={17} row={rowIdx} value={formatKg(row.bf)} className="font-mono text-right pr-1" {...commonCellProps} {...selProps(rowIdx, 17)}>
                                                    <Input autoFocus type="number" step="0.5" value={row.bf} onChange={e => updateShiftData(rowIdx, 'bf', e.target.value)} className={cn(inputClass, 'font-mono text-right text-xs')} onPaste={e => { e.stopPropagation(); handleSmartPaste(e, rowIdx, 17); }} />
                                                </GridCell>
                                            ) : (
                                                <div className="h-full w-full bg-muted/30" />
                                            )}
                                        </TableCell>

                                        {/* ── WASTE: RS2/3 (col 18) ── */}
                                        <TableCell className="px-0 py-0 border-r border-border/30 bg-red-500/[0.03]" style={{ height: '28px' }}>
                                            {showDtWaste ? (
                                                <GridCell col={18} row={rowIdx} value={formatKg(row.rs23)} className="font-mono text-right pr-1" {...commonCellProps} {...selProps(rowIdx, 18)}>
                                                    <Input autoFocus type="number" step="0.5" value={row.rs23} onChange={e => updateShiftData(rowIdx, 'rs23', e.target.value)} className={cn(inputClass, 'font-mono text-right text-xs')} onPaste={e => { e.stopPropagation(); handleSmartPaste(e, rowIdx, 18); }} />
                                                </GridCell>
                                            ) : (
                                                <div className="h-full w-full bg-muted/30" />
                                            )}
                                        </TableCell>

                                        {/* ── WASTE: RS5 (col 19) ── */}
                                        <TableCell className="px-0 py-0 border-r border-border/30 bg-red-500/[0.03]" style={{ height: '28px' }}>
                                            {showDtWaste ? (
                                                <GridCell col={19} row={rowIdx} value={formatKg(row.rs5)} className="font-mono text-right pr-1" {...commonCellProps} {...selProps(rowIdx, 19)}>
                                                    <Input autoFocus type="number" step="0.5" value={row.rs5} onChange={e => updateShiftData(rowIdx, 'rs5', e.target.value)} className={cn(inputClass, 'font-mono text-right text-xs')} onPaste={e => { e.stopPropagation(); handleSmartPaste(e, rowIdx, 19); }} />
                                                </GridCell>
                                            ) : (
                                                <div className="h-full w-full bg-muted/30" />
                                            )}
                                        </TableCell>

                                        {/* ── WASTE: TRML1 (col 20) ── */}
                                        <TableCell className="px-0 py-0 border-r border-border/30 bg-red-500/[0.03]" style={{ height: '28px' }}>
                                            {showDtWaste ? (
                                                <GridCell col={20} row={rowIdx} value={formatKg(row.trml1)} className="font-mono text-right pr-1" {...commonCellProps} {...selProps(rowIdx, 20)}>
                                                    <Input autoFocus type="number" step="0.5" value={row.trml1} onChange={e => updateShiftData(rowIdx, 'trml1', e.target.value)} className={cn(inputClass, 'font-mono text-right text-xs')} onPaste={e => { e.stopPropagation(); handleSmartPaste(e, rowIdx, 20); }} />
                                                </GridCell>
                                            ) : (
                                                <div className="h-full w-full bg-muted/30" />
                                            )}
                                        </TableCell>

                                        {/* ── WASTE: TRML2 (col 21) ── */}
                                        <TableCell className="px-0 py-0 border-r border-border/30 bg-red-500/[0.03]" style={{ height: '28px' }}>
                                            {showDtWaste ? (
                                                <GridCell col={21} row={rowIdx} value={formatKg(row.trml2)} className="font-mono text-right pr-1" {...commonCellProps} {...selProps(rowIdx, 21)}>
                                                    <Input autoFocus type="number" step="0.5" value={row.trml2} onChange={e => updateShiftData(rowIdx, 'trml2', e.target.value)} className={cn(inputClass, 'font-mono text-right text-xs')} onPaste={e => { e.stopPropagation(); handleSmartPaste(e, rowIdx, 21); }} />
                                                </GridCell>
                                            ) : (
                                                <div className="h-full w-full bg-muted/30" />
                                            )}
                                        </TableCell>

                                        {/* ── WASTE: GRIT (col 22) — last col ── */}
                                        <TableCell className="px-0 py-0 bg-red-500/[0.03]" style={{ height: '28px' }}>
                                            {showDtWaste ? (
                                                <GridCell col={22} row={rowIdx} value={formatKg(row.grit)} className="font-mono text-right pr-1" {...commonCellProps} {...selProps(rowIdx, 22)}>
                                                    <Input autoFocus type="number" step="0.5" value={row.grit} onChange={e => updateShiftData(rowIdx, 'grit', e.target.value)} className={cn(inputClass, 'font-mono text-right text-xs')} onPaste={e => { e.stopPropagation(); handleSmartPaste(e, rowIdx, 22); }} />
                                                </GridCell>
                                            ) : (
                                                <div className="h-full w-full bg-muted/30" />
                                            )}
                                        </TableCell>

                                    </TableRow>
                                );
                            })}
                        </TableBody>

                        {/* ── Totals Footer ──────────────────────────────────────────────────── */}
                        {/* sticky bottom-0 goes on each <td>, not on <tfoot>.
                            Frozen corner cells get both sticky bottom-0 AND sticky left-Xpx at z-50.
                            Non-frozen footer cells get sticky bottom-0 at z-40.
                            This mirrors the header's z-50 (header corners) / z-40 (body frozen cols) stacking. */}
                        <TableFooter>
                            <TableRow className="hover:bg-transparent border-t-2 border-foreground/20" style={{ height: '32px' }}>

                                {/* # — frozen corner: sticky bottom-0 + left-0 at z-50 */}
                                <TableCell className="h-8 px-1 py-0 text-[9px] font-mono font-bold text-muted-foreground uppercase tracking-wide border-r border-foreground/10 bg-muted sticky bottom-0 z-50" style={{ left: 0 }}>
                                    TOT
                                </TableCell>

                                {/* DATE — frozen corner: sticky bottom-0 + left-28 at z-50 */}
                                <TableCell className="h-8 px-1 py-0 bg-muted sticky bottom-0 z-50 border-r border-foreground/10" style={{ left: 28 }} />

                                {/* BATCH — frozen corner: sticky bottom-0 + left-124 at z-50 */}
                                <TableCell className="h-8 px-1 py-0 bg-muted sticky bottom-0 z-50 border-r border-foreground/10" style={{ left: 124 }} />

                                {/* SHIFT — frozen corner: sticky bottom-0 + left-188 at z-50 */}
                                <TableCell className="h-8 px-1 py-0 bg-muted sticky bottom-0 z-50 border-r border-foreground/20" style={{ left: 188 }} />

                                {/* CUSTOMER — frozen corner: sticky bottom-0 + left-240 at z-50 */}
                                <TableCell className="h-8 px-1 py-0 bg-muted sticky bottom-0 z-50 border-r border-foreground/10" style={{ left: 240 }} />

                                {/* GRADE — frozen corner: sticky bottom-0 + left-312 at z-50.
                                    Plain spacer — the grade filter now lives in the GRADE header
                                    (single control for `gradeFilter`). */}
                                <TableCell className="h-8 px-1 py-0 bg-muted sticky bottom-0 z-50 border-r border-foreground/10" style={{ left: 312 }} />

                                {/* TTL KG — frozen corner: sticky bottom-0 + left-372 at z-50, aggregate cell */}
                                <TableCell className="h-8 px-1 py-0 bg-muted sticky bottom-0 z-50 border-r border-foreground/10" style={{ left: 372 }}>
                                    <FooterAggCell
                                        mode={ttlKgMode}
                                        onToggle={() => setTtlKgMode(m => m === 'SUM' ? 'AVG' : 'SUM')}
                                        value={ttlKgMode === 'SUM' ? footerAgg.ttlKg.sum : footerAgg.ttlKg.avg}
                                        decimals={0}
                                        count={footerAgg.ttlKg.count}
                                    />
                                </TableCell>

                                {/* REM — frozen corner: sticky bottom-0 + left-452 at z-50, separator shadow */}
                                <TableCell className="h-8 px-1 py-0 bg-muted sticky bottom-0 z-50 shadow-[2px_0_4px_rgba(0,0,0,0.12)]" style={{ left: 452 }} />

                                {/* DT HRS (col 8) — scrolling, sticky bottom-0 at z-40 */}
                                <TableCell className="h-8 px-1 py-0 bg-muted sticky bottom-0 z-40 border-r border-foreground/10" />

                                {/* DT MINS (col 9) — scrolling, sticky bottom-0 at z-40 */}
                                <TableCell className="h-8 px-1 py-0 bg-muted sticky bottom-0 z-40 border-r border-foreground/10" />

                                {/* DT TTL (col 10) — scrolling, sticky bottom-0 at z-40, aggregate cell */}
                                <TableCell className="h-8 px-1 py-0 bg-muted sticky bottom-0 z-40 border-r border-foreground/10">
                                    <FooterAggCell
                                        mode={dtTtlMode}
                                        onToggle={() => setDtTtlMode(m => m === 'SUM' ? 'AVG' : 'SUM')}
                                        value={dtTtlMode === 'SUM' ? footerAgg.dtTtl.sum : footerAgg.dtTtl.avg}
                                        decimals={2}
                                        count={footerAgg.dtTtl.count}
                                    />
                                </TableCell>

                                {/* PROD HRS (col 11) — scrolling, sticky bottom-0 at z-40, aggregate cell */}
                                <TableCell className="h-8 px-1 py-0 bg-muted sticky bottom-0 z-40 border-r border-foreground/10">
                                    <FooterAggCell
                                        mode={prodHrsMode}
                                        onToggle={() => setProdHrsMode(m => m === 'SUM' ? 'AVG' : 'SUM')}
                                        value={prodHrsMode === 'SUM' ? footerAgg.prodHrs.sum : footerAgg.prodHrs.avg}
                                        decimals={2}
                                        count={footerAgg.prodHrs.count}
                                    />
                                </TableCell>

                                {/* DT REASON (col 12) — scrolling, sticky bottom-0 at z-40 */}
                                <TableCell className="h-8 px-1 py-0 bg-muted sticky bottom-0 z-40 border-r border-foreground/20" />

                                {/* PROD LOSS (col 13) — empty (% is not meaningfully summable) */}
                                <TableCell className="h-8 px-1 py-0 bg-muted sticky bottom-0 z-40 border-r border-foreground/10" />

                                {/* TTL WASTE (col 14) — scrolling, sticky bottom-0 at z-40, aggregate cell */}
                                <TableCell className="h-8 px-1 py-0 bg-muted sticky bottom-0 z-40 border-r border-foreground/10">
                                    <FooterAggCell
                                        mode={ttlWasteMode}
                                        onToggle={() => setTtlWasteMode(m => m === 'SUM' ? 'AVG' : 'SUM')}
                                        value={ttlWasteMode === 'SUM' ? footerAgg.ttlWaste.sum : footerAgg.ttlWaste.avg}
                                        decimals={2}
                                        count={footerAgg.ttlWaste.count}
                                    />
                                </TableCell>

                                {/* RS1A–GRIT (cols 15–22) — empty waste stream cells */}
                                <TableCell className="h-8 px-1 py-0 bg-muted sticky bottom-0 z-40 border-r border-foreground/10" />
                                <TableCell className="h-8 px-1 py-0 bg-muted sticky bottom-0 z-40 border-r border-foreground/10" />
                                <TableCell className="h-8 px-1 py-0 bg-muted sticky bottom-0 z-40 border-r border-foreground/10" />
                                <TableCell className="h-8 px-1 py-0 bg-muted sticky bottom-0 z-40 border-r border-foreground/10" />
                                <TableCell className="h-8 px-1 py-0 bg-muted sticky bottom-0 z-40 border-r border-foreground/10" />
                                <TableCell className="h-8 px-1 py-0 bg-muted sticky bottom-0 z-40 border-r border-foreground/10" />
                                <TableCell className="h-8 px-1 py-0 bg-muted sticky bottom-0 z-40 border-r border-foreground/10" />
                                <TableCell className="h-8 px-1 py-0 bg-muted sticky bottom-0 z-40" />

                            </TableRow>
                        </TableFooter>
                    </table>
                </div>
            </div>

            {/* ── Right-click context menu ── */}
            <GridContextMenu<number>
                state={contextMenu.state}
                onClose={contextMenu.close}
                items={ROW_MENU_ITEMS}
            />
        </TooltipProvider>
    );
}
