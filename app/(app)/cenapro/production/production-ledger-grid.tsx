'use client';

import * as React from 'react';
import { toast } from 'sonner';
import { format as formatDate, parseISO, isValid as isValidDate } from 'date-fns';
import {
    Save,
    RotateCcw,
    Calendar,
    Copy,
    Trash2,
    ArrowUpFromLine,
    ArrowDownFromLine,
    ArrowUp,
    ArrowDown,
    ChevronDown,
    ChevronsUpDown,
    Inbox,
    Sparkles,
} from 'lucide-react';
import { errorToast } from '@/lib/toast';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuTrigger,
    DropdownMenuRadioGroup,
    DropdownMenuRadioItem,
    DropdownMenuLabel,
    DropdownMenuSeparator,
} from '@/components/ui/dropdown-menu';
import { GridCell } from '@/components/shared/grid/GridCell';
import { useCellSelection } from '@/lib/hooks/use-cell-selection';
import { useClipboardCopy } from '@/lib/hooks/use-clipboard-copy';
import { useCellDelete } from '@/lib/hooks/use-cell-delete';
import { parseExcelDate, trimCellValue } from '@/lib/paste-utils';
import type { ProductionEventRow } from '../types';
import {
    SHIFT_CODES,
    GRADE_CODES,
    PLANT_CODES,
    WAREHOUSE_CODES,
    SOURCE_LOCATION_CODES,
    WHSE_SIDES,
    CCC_FLEC_OPTIONS,
    parseCccFlec,
    formatCccFlec,
} from '../types';
import { saveProductionEvents, type ProductionEventDirtyRow, type CenaproPeriod } from './actions';
import { BulkAddModal } from './bulk-add-modal';
import { CenaproPeriodPicker } from './period-picker';

// ─── Editable fields ─────────────────────────────────────────────────────────────
// The writable columns (id/unique_tag/batch_year are read-only/computed). Order here
// is informational; COL_MAP below pins the on-screen left→right geometry.
//
// `ccc_flec` is a SINGLE on-screen column (Excel parity — Renzo's "CCC / FLEC") that
// stands in for the two normalized DB fields disposition_kind + partner_equipment_code.
// It's NOT a key of GridRow — it's a derived editing surface: display via
// formatCccFlec(), edit via parseCccFlec() writing BOTH underlying fields. Everywhere a
// cell value is read/written (copy, paste, save) it's special-cased.
type GridField =
    | 'recv_date'
    | 'prod_date'
    | 'batch'
    | 'shift_code'
    | 'grade_code'
    | 'plant_code'
    | 'warehouse_code'
    | 'source_location_code'
    | 'weight_kg'
    | 'ccc_flec'
    | 'flec_count'
    | 'whse_side';

// ─── Column layout ───────────────────────────────────────────────────────────────
// col 0 = row#, not selectable/editable. All other columns are editable. Dropdown
// columns edit via a Select popover (not GridCell's F2/type-over). Date columns use
// DatePickerCell. Numeric/text/CCC-FLEC columns use GridCell + <Input>. The order
// matches Renzo's Excel (… WHSE · SRC · WT · CCC/FLEC · FLEC AMT · WHSE SIDE) so a
// pasted Excel block lines up positionally.
const COL_MAP: (GridField | null)[] = [
    null,                       // 0: row#
    'recv_date',                // 1
    'prod_date',                // 2
    'batch',                    // 3
    'shift_code',               // 4  (dropdown)
    'grade_code',               // 5  (dropdown)
    'plant_code',               // 6  (dropdown, nullable)
    'warehouse_code',           // 7  (dropdown, nullable — null = unplaced)
    'source_location_code',     // 8  (dropdown)
    'weight_kg',                // 9  (numeric)
    'ccc_flec',                 // 10 (typeahead — merged disposition + equipment)
    'flec_count',               // 11 (numeric int)
    'whse_side',                // 12 (dropdown, nullable)
];
const COL_COUNT = COL_MAP.length;

const NUMERIC_FIELDS = new Set<GridField>(['weight_kg', 'flec_count']);
const DROPDOWN_FIELDS = new Set<GridField>([
    'shift_code',
    'grade_code',
    'plant_code',
    'warehouse_code',
    'source_location_code',
    'whse_side',
]);

// ─── Row state ───────────────────────────────────────────────────────────────────
type RowDirtyState = 'existing' | 'new' | 'modified' | 'deleted';

interface GridRow {
    _state: RowDirtyState;
    // Stable DB id for existing rows (the upsert key); '' for unsaved new rows.
    id: string;
    recv_date: string;
    prod_date: string;
    batch: string;
    shift_code: string;
    grade_code: string;
    plant_code: string;
    warehouse_code: string;
    source_location_code: string;
    // The single CCC/FLEC cell, stored as RAW typed text ("FLEC" | "C1".."C4" |
    // "RK1".."RK4"). Seeded from the two DB fields via formatCccFlec() on load, edited
    // directly (so typing isn't fought by a derive), and parsed back into
    // disposition_kind + partner_equipment_code at SAVE time (mirrors the bulk modal).
    ccc_flec: string;
    weight_kg: string;
    flec_count: string;
    whse_side: string;
    // Read-only/computed — shown but never edited or sent on save.
    batch_year: string;
}

// ─── DB → Grid conversion ────────────────────────────────────────────────────────
// PostgREST types all VIEW columns nullable; coalesce to '' for the string grid. The
// `id` is non-null at runtime (the upsert key) but typed nullable, so coalesce too. The
// CCC/FLEC cell is seeded from the two normalized DB fields (disposition + equipment).
function toGridRow(r: ProductionEventRow): GridRow {
    return {
        _state: 'existing',
        id: r.id ?? '',
        recv_date: r.recv_date ?? '',
        prod_date: r.prod_date ?? '',
        batch: r.batch ?? '',
        shift_code: r.shift_code ?? '',
        grade_code: r.grade_code ?? '',
        plant_code: r.plant_code ?? '',
        warehouse_code: r.warehouse_code ?? '',
        source_location_code: r.source_location_code ?? '',
        ccc_flec: formatCccFlec(r.disposition_kind, r.partner_equipment_code),
        weight_kg: r.weight_kg != null ? String(r.weight_kg) : '',
        flec_count: r.flec_count != null ? String(r.flec_count) : '',
        whse_side: r.whse_side ?? '',
        batch_year: r.batch_year != null ? String(r.batch_year) : '',
    };
}

// Which date column drives the sort. Both the Recv and Prod headers are clickable;
// clicking one selects it as the sort key (and toggles asc/desc on repeat clicks).
type DateSortKey = 'recv_date' | 'prod_date';

function buildGridRows(
    rows: ProductionEventRow[],
    sortKey: DateSortKey,
    sortDir: 'asc' | 'desc',
): GridRow[] {
    const mapped = rows.map(toGridRow);
    return sortGridRows(mapped, sortKey, sortDir);
}

// Stable sort by the chosen date column per the toggle, id as a deterministic
// tiebreaker. Empty dates (common for prod_date) sort to the bottom regardless of
// direction so blank rows don't jump to the top when sorting descending.
function sortGridRows(rows: GridRow[], sortKey: DateSortKey, sortDir: 'asc' | 'desc'): GridRow[] {
    return [...rows].sort((a, b) => {
        const av = a[sortKey];
        const bv = b[sortKey];
        // Push empty values to the end in both directions.
        if (!av && !bv) return a.id.localeCompare(b.id);
        if (!av) return 1;
        if (!bv) return -1;
        const cmp = av.localeCompare(bv);
        const primary = sortDir === 'asc' ? cmp : -cmp;
        if (primary !== 0) return primary;
        return a.id.localeCompare(b.id);
    });
}

// ─── Empty row factory ───────────────────────────────────────────────────────────
function createEmptyRow(overrides: Partial<GridRow> = {}): GridRow {
    const today = new Date().toISOString().split('T')[0];
    return {
        _state: 'new',
        id: '',
        recv_date: today,
        prod_date: '',
        batch: '',
        shift_code: '',
        grade_code: '',
        plant_code: '',
        warehouse_code: '',
        source_location_code: '',
        ccc_flec: '',
        weight_kg: '',
        flec_count: '',
        whse_side: '',
        batch_year: '',
        ...overrides,
    };
}

// A new row counts as "real" (savable, dirty) once it carries any identifying data.
function isMeaningfulNewRow(r: GridRow): boolean {
    return Boolean(r.batch || r.weight_kg || r.grade_code || r.ccc_flec);
}

// ─── Paste cleaning ──────────────────────────────────────────────────────────────
function cleanPasteValue(raw: string, field: GridField): string {
    const val = trimCellValue(raw);
    if (field === 'recv_date' || field === 'prod_date') return parseExcelDate(val);
    if (NUMERIC_FIELDS.has(field)) return val.replace(/[₱,"'%]/g, '');
    return val;
}

// ─── Input class ─────────────────────────────────────────────────────────────────
const inputClass =
    'h-8 w-full px-1 border-transparent bg-transparent rounded-none font-bold focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-primary focus-visible:bg-accent/10 transition-colors shadow-none';

// ─── Direction tint (IN vs OUT, by disposition) ──────────────────────────────────
// Each production row reads as an IN (into inventory) or OUT (out into partner gear),
// keyed off the disposition the CCC/FLEC cell resolves to:
//   • flec_bagging                  → IN  → subtle emerald row tint
//   • partner_crusher / partner_kiln → OUT → subtle rose row tint
//   • empty / unrecognized          → no tint
// The tint is deliberately faint (/5) so it never fights cell-selection, row-hover, or
// the dirty-state left borders that sit on top of it. We derive direction from the raw
// `ccc_flec` cell via the shared `parseCccFlec` (same source of truth as save), so an
// unsaved edit re-tints live as the operator types a recognized code.
type RowDirection = 'in' | 'out' | null;

function rowDirection(cccFlec: string): RowDirection {
    const res = parseCccFlec(cccFlec);
    if (!res) return null;
    return res.disposition_kind === 'flec_bagging' ? 'in' : 'out';
}

function rowDirectionTint(dir: RowDirection): string {
    if (dir === 'in') return 'bg-emerald-500/5';
    if (dir === 'out') return 'bg-rose-500/5';
    return '';
}

// ─── Badge class maps (display mode only — inputs stay plain) ─────────────────────
// Compact, bold, rounded badges sized to the dense h-8 row. Each uses the project idiom
// (Tailwind color util + /10–/15 fill + a `dark:` text variant) so it reads in BOTH
// themes. These render in the GridCell/SelectCell DISPLAY state — the edit <Input> is
// never wrapped, so typing/paste is unaffected.
const BADGE_BASE =
    'inline-flex items-center justify-center rounded px-1.5 py-0 h-5 font-mono text-[11px] font-bold leading-none border';

// CCC/FLEC: FLEC (the bagging "in") → emerald; crushers C1–C4 → amber; kilns RK1–RK4 →
// rose. So bagging clearly reads as the IN, and crushers vs kilns are distinguishable.
function cccFlecBadgeClass(raw: string): string {
    const v = raw.trim().toUpperCase();
    if (v === 'FLEC') return 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300';
    if (/^C[1-4]$/.test(v)) return 'border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300';
    if (/^RK[1-4]$/.test(v)) return 'border-rose-500/30 bg-rose-500/10 text-rose-700 dark:text-rose-300';
    // Unrecognized value — neutral badge so it's still visible (and obviously not a real code).
    return 'border-border bg-muted text-muted-foreground';
}

// PLANT: one distinct, accessible color per plant. W6 → blue, W7 → teal, W6/W7 →
// indigo (the union), DVO → slate. Empty/null plant → no badge (handled by the caller).
function plantBadgeClass(raw: string): string {
    switch (raw.trim().toUpperCase()) {
        case 'W6': return 'border-blue-500/30 bg-blue-500/10 text-blue-700 dark:text-blue-300';
        case 'W7': return 'border-teal-500/30 bg-teal-500/10 text-teal-700 dark:text-teal-300';
        case 'W6/W7': return 'border-indigo-500/30 bg-indigo-500/10 text-indigo-700 dark:text-indigo-300';
        case 'DVO': return 'border-slate-500/30 bg-slate-500/10 text-slate-700 dark:text-slate-300';
        default: return 'border-border bg-muted text-muted-foreground';
    }
}

// ─── Date display helper ─────────────────────────────────────────────────────────
function formatDateShort(iso: string): string {
    if (!iso) return '';
    const parsed = parseISO(iso);
    if (!isValidDate(parsed)) return iso;
    return formatDate(parsed, 'MMM d');
}

// ─── KG formatter (whole kg, thousands separators) ───────────────────────────────
function formatKg(value: string): string {
    if (value === '') return '';
    const n = parseFloat(value);
    if (isNaN(n)) return '';
    return n.toLocaleString('en-US', { maximumFractionDigits: 0 });
}

// ─── DatePickerCell ──────────────────────────────────────────────────────────────
// Always-visible date input with calendar icon + formatted display. The native
// <input type="date"> overlays (opacity:0) so clicks anywhere open the native picker.
// Selection (drag/anchor) is handled by the wrapping cell. Mirrors the ICTC ledger.
interface DatePickerCellProps {
    value: string;
    onChange: (val: string) => void;
    onPaste: (e: React.ClipboardEvent) => void;
    isActive: boolean;
    isRangeSelected: boolean;
    isRangeAnchor: boolean;
    onCellMouseDown: (e: React.MouseEvent) => void;
    onCellMouseUp: () => void;
    onCellMouseEnter: () => void;
    muted?: boolean;
}

function DatePickerCell({
    value,
    onChange,
    onPaste,
    isActive,
    isRangeSelected,
    isRangeAnchor,
    onCellMouseDown,
    onCellMouseUp,
    onCellMouseEnter,
    muted,
}: DatePickerCellProps) {
    const inputRef = React.useRef<HTMLInputElement>(null);
    return (
        <div
            className={cn(
                'group relative flex h-full w-full cursor-pointer select-none items-center justify-between gap-1 px-1',
                'border border-dashed border-border/40 transition-colors hover:border-blue-500/60 hover:bg-blue-500/5',
                isActive && !isRangeSelected && 'z-10 border-transparent ring-2 ring-primary ring-inset',
                isRangeSelected && 'bg-primary/10 dark:bg-primary/20',
                isRangeAnchor && 'z-10 border-transparent ring-2 ring-primary ring-inset',
            )}
            style={{ minHeight: '100%' }}
            onMouseDown={onCellMouseDown}
            onMouseUp={onCellMouseUp}
            onMouseEnter={onCellMouseEnter}
            onClick={(e) => {
                e.stopPropagation();
                const el = inputRef.current;
                if (!el) return;
                if (typeof el.showPicker === 'function') {
                    try {
                        el.showPicker();
                    } catch {
                        el.focus();
                    }
                } else {
                    el.focus();
                }
            }}
        >
            <span
                className={cn(
                    'truncate font-mono text-[11px] font-bold tabular-nums',
                    muted ? 'text-muted-foreground/60' : 'text-foreground',
                )}
            >
                {formatDateShort(value) || (muted ? '—' : '')}
            </span>
            <Calendar className="h-3 w-3 flex-none text-muted-foreground/70 transition-colors group-hover:text-blue-500" />
            <input
                ref={inputRef}
                type="date"
                value={value}
                onChange={(e) => onChange(e.target.value)}
                onPaste={onPaste}
                onMouseDown={(e) => e.stopPropagation()}
                onClick={(e) => e.stopPropagation()}
                className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
                tabIndex={-1}
                aria-label="Select date"
            />
        </div>
    );
}

// ─── SelectCell ──────────────────────────────────────────────────────────────────
// A categorical dropdown cell. The trigger shows the current value (or a muted dash
// for empty), and opens a DropdownMenu of the allowed options. Nullable columns get a
// leading "— None" item that clears to ''. The trigger stops propagation on
// mouse/pointer-down so opening the menu never starts a cell drag (same guard as the
// ICTC NoteCell / ColumnFilterMenu). Selection visuals come from the wrapping cell.
interface SelectCellProps {
    value: string;
    options: readonly string[];
    onChange: (val: string) => void;
    /** Render an option's label (defaults to the raw value). */
    renderLabel?: (opt: string) => string;
    /**
     * Render the CURRENT value in the trigger (display state) as a custom node —
     * e.g. a colored badge. Only affects the closed trigger; the dropdown menu items
     * still use `renderLabel`/raw text, and the edit path is untouched. Returns null to
     * fall back to the plain text label.
     */
    renderTrigger?: (value: string) => React.ReactNode;
    /** When true, prepend a "— None" item that clears the value. */
    nullable?: boolean;
    /** Placeholder shown when value is '' (defaults to a muted dash). */
    placeholder?: string;
    /** Disable + show a hint (e.g. equipment when disposition is bagging). */
    disabled?: boolean;
    disabledHint?: string;
    align?: 'start' | 'end';
}

function SelectCell({
    value,
    options,
    onChange,
    renderLabel,
    renderTrigger,
    nullable,
    placeholder,
    disabled,
    disabledHint,
    align = 'start',
}: SelectCellProps) {
    const label = value ? (renderLabel ? renderLabel(value) : value) : '';
    const triggerNode = value && renderTrigger ? renderTrigger(value) : null;
    return (
        <DropdownMenu>
            <DropdownMenuTrigger asChild disabled={disabled}>
                <button
                    type="button"
                    aria-label={label || placeholder || 'Select'}
                    title={disabled ? disabledHint : label || placeholder}
                    onMouseDown={(e) => e.stopPropagation()}
                    onPointerDown={(e) => e.stopPropagation()}
                    className={cn(
                        'flex h-full w-full items-center justify-between gap-0.5 px-1 text-left outline-none transition-colors duration-150',
                        'focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-primary',
                        disabled
                            ? 'cursor-not-allowed bg-muted/30'
                            : 'hover:bg-accent/40',
                    )}
                >
                    {triggerNode ? (
                        <span className="flex min-w-0 items-center truncate">{triggerNode}</span>
                    ) : (
                        <span
                            className={cn(
                                'truncate font-mono text-xs font-bold',
                                value ? 'text-foreground' : 'text-muted-foreground/40',
                            )}
                        >
                            {label || (disabled ? '—' : placeholder ?? '—')}
                        </span>
                    )}
                    {!disabled && (
                        <ChevronDown className="h-3 w-3 flex-none text-muted-foreground/40" />
                    )}
                </button>
            </DropdownMenuTrigger>
            {!disabled && (
                <DropdownMenuContent align={align} className="min-w-[120px] bg-popover/95 backdrop-blur-lg">
                    <DropdownMenuRadioGroup value={value} onValueChange={onChange}>
                        {nullable && (
                            <DropdownMenuRadioItem value="" className="py-1 font-mono text-[11px] text-muted-foreground">
                                — None
                            </DropdownMenuRadioItem>
                        )}
                        {options.map((opt) => (
                            <DropdownMenuRadioItem key={opt} value={opt} className="py-1 font-mono text-[11px]">
                                {renderLabel ? renderLabel(opt) : opt}
                            </DropdownMenuRadioItem>
                        ))}
                    </DropdownMenuRadioGroup>
                </DropdownMenuContent>
            )}
        </DropdownMenu>
    );
}

// ─── ColumnFilterMenu (header filter — HIDES rows, not a sort) ────────────────────
interface ColumnFilterMenuProps {
    label: string;
    value: string; // 'ALL' = no filter
    options: { value: string; label: string }[];
    onChange: (value: string) => void;
    align?: 'start' | 'end';
}

function ColumnFilterMenu({ label, value, options, onChange, align = 'start' }: ColumnFilterMenuProps) {
    const isActive = value !== 'ALL';
    const activeLabel = options.find((o) => o.value === value)?.label ?? value;
    return (
        <span className="inline-flex items-center justify-center gap-0.5">
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
                        <ChevronDown className="h-3 w-3" />
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
                            <DropdownMenuRadioItem key={opt.value} value={opt.value} className="py-1 font-mono text-[11px]">
                                {opt.label}
                            </DropdownMenuRadioItem>
                        ))}
                    </DropdownMenuRadioGroup>
                </DropdownMenuContent>
            </DropdownMenu>
        </span>
    );
}

// ─── DateSortHeader (clickable date column header — sorts by THIS date) ───────────
// Both the Recv and Prod headers use this. The whole header is a button: clicking the
// currently-active date key toggles asc/desc; clicking the inactive one switches the
// sort key to it. The up/down chevron shows ONLY on the active key (matching the
// other sortable header's affordance); inactive headers show a faint idle indicator.
interface DateSortHeaderProps {
    label: string;
    sortKey: DateSortKey;
    activeKey: DateSortKey;
    dir: 'asc' | 'desc';
    onSort: (key: DateSortKey) => void;
}

function DateSortHeader({ label, sortKey, activeKey, dir, onSort }: DateSortHeaderProps) {
    const isActive = activeKey === sortKey;
    return (
        <button
            type="button"
            onClick={() => onSort(sortKey)}
            aria-label={`Sort by ${label}${isActive ? ` (${dir === 'asc' ? 'ascending' : 'descending'})` : ''}`}
            title={
                isActive
                    ? `${label}: ${dir === 'desc' ? 'newest first' : 'oldest first'} — click to flip`
                    : `Sort by ${label}`
            }
            className={cn(
                'group/sort -ml-0.5 flex items-center gap-0.5 rounded px-0.5 outline-none transition-colors duration-150',
                'focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-primary',
                isActive ? 'text-primary hover:text-primary/80' : 'text-muted-foreground hover:text-foreground',
            )}
        >
            <span className="text-[11px] font-bold uppercase tracking-wide">{label}</span>
            {isActive ? (
                dir === 'desc' ? (
                    <ArrowDown className="h-3 w-3 flex-none" />
                ) : (
                    <ArrowUp className="h-3 w-3 flex-none" />
                )
            ) : (
                <ChevronsUpDown className="h-3 w-3 flex-none text-muted-foreground/40 transition-colors group-hover/sort:text-muted-foreground" />
            )}
        </button>
    );
}

// ─── ProductionRow (memoized) ────────────────────────────────────────────────────
// One ledger row, extracted + wrapped in React.memo so editing/selecting a cell only
// re-renders the rows whose props actually changed — not the whole grid. The parent
// passes PRIMITIVE slices of the global active/selection state (the active col within
// THIS row, the selection col-span when this row is in range, etc.) plus stable
// callbacks, so memo's shallow compare skips untouched rows. The `activeCell` object
// GridCell expects is rebuilt locally (memoized on rowIdx+activeColInRow) so it stays
// referentially stable across other rows' renders.
interface ProductionRowProps {
    row: GridRow;
    rowIdx: number;
    rowHidden: boolean;
    contextMenuActive: boolean;
    // Active/edit state, sliced to this row.
    activeColInRow: number; // -1 when the active cell is in another row
    isEditing: boolean;
    // Selection state, sliced to this row (derived from the selection range).
    rowInRange: boolean;
    selStartCol: number;
    selEndCol: number;
    anchorColInRow: number; // -1 when the anchor is in another row
    isDragActive: boolean;
    selectionSize: number;
    // Stable callbacks from the parent.
    updateRow: (idx: number, field: GridField, value: string) => void;
    handleSmartPaste: (e: React.ClipboardEvent, startRow: number, startCol: number) => void;
    handleCellMouseDown: (rowIdx: number, colIdx: number, e: React.MouseEvent) => void;
    handleCellMouseUp: (rowIdx: number, colIdx: number) => void;
    handleCellMouseEnter: (rowIdx: number, colIdx: number) => void;
    startEditing: (rowIdx: number, colIdx: number, initialChar?: string) => void;
    revertChanges: () => void;
    setActiveCell: (cell: { row: number; col: number }) => void;
    setIsEditing: (editing: boolean) => void;
    onRowContextMenu: (rowIdx: number, e: React.MouseEvent) => void;
    gridRef: React.RefObject<HTMLDivElement | null>;
}

const ProductionRow = React.memo(function ProductionRow({
    row,
    rowIdx,
    rowHidden,
    contextMenuActive,
    activeColInRow,
    isEditing,
    rowInRange,
    selStartCol,
    selEndCol,
    anchorColInRow,
    isDragActive,
    selectionSize,
    updateRow,
    handleSmartPaste,
    handleCellMouseDown,
    handleCellMouseUp,
    handleCellMouseEnter,
    startEditing,
    revertChanges,
    setActiveCell,
    setIsEditing,
    onRowContextMenu,
    gridRef,
}: ProductionRowProps) {
    const isDeleted = row._state === 'deleted';
    const isModified = row._state === 'modified';
    const isNew = row._state === 'new';
    const isEmptyNew = isNew && !isMeaningfulNewRow(row);

    // Direction tint (IN=emerald / OUT=rose), derived from the CCC/FLEC cell. Skipped on
    // the empty trailing row so it stays visually neutral until the operator commits to a
    // disposition. Sits UNDER the dirty-state left border + the selection highlight.
    const direction = isEmptyNew ? null : rowDirection(row.ccc_flec);
    const directionTint = rowDirectionTint(direction);

    // Rebuild the active-cell object GridCell needs — null unless the active cell is in
    // this row. Memoized on (rowIdx, activeColInRow) so it's stable while other rows edit.
    const activeCell = React.useMemo(
        () => (activeColInRow >= 0 ? { row: rowIdx, col: activeColInRow } : null),
        [rowIdx, activeColInRow],
    );

    // Per-cell selection feedback, derived from this row's range slice (all primitives).
    const isSel = React.useCallback(
        (col: number) => rowInRange && col >= selStartCol && col <= selEndCol,
        [rowInRange, selStartCol, selEndCol],
    );
    const isAnch = React.useCallback((col: number) => anchorColInRow === col, [anchorColInRow]);

    // selProps / commonCellProps — rebuilt once per row render (not per parent render),
    // and only when this row's sliced state changes (memo gate above).
    const selProps = React.useCallback(
        (colIdx: number) => ({
            onCellMouseDown: (e: React.MouseEvent) => handleCellMouseDown(rowIdx, colIdx, e),
            onCellMouseUp: () => handleCellMouseUp(rowIdx, colIdx),
            onCellMouseEnter: () => handleCellMouseEnter(rowIdx, colIdx),
            isCellRangeSelected: isSel(colIdx),
            isCellRangeAnchor: isAnch(colIdx),
            isDragActive,
        }),
        [rowIdx, handleCellMouseDown, handleCellMouseUp, handleCellMouseEnter, isSel, isAnch, isDragActive],
    );

    const commonCellProps = {
        activeCell,
        isEditing,
        setActiveCell,
        setIsEditing,
        onStartEditing: startEditing,
        onRevert: revertChanges,
        gridRef,
    };

    // Selection/active visuals for the interactive (dropdown/date) cell wrappers.
    const interactiveCellClass = (colIdx: number) =>
        cn(
            'relative h-full w-full',
            isSel(colIdx) && 'bg-primary/10 dark:bg-primary/20',
            activeColInRow === colIdx && selectionSize <= 1 && 'z-10 ring-2 ring-primary ring-inset',
            isAnch(colIdx) && 'z-10 ring-2 ring-primary ring-inset',
        );

    return (
        <tr
            hidden={rowHidden}
            className={cn(
                'group h-8 border-b border-border/30 transition-all duration-150 hover:bg-muted/50',
                // Direction tint first so the dirty borders + hover/selection read on top.
                directionTint,
                rowHidden && 'hidden',
                isDeleted && 'line-through opacity-40',
                isModified && 'border-l-2 border-l-amber-400',
                isNew && !isEmptyNew && 'border-l-2 border-l-blue-400/50',
                contextMenuActive && 'bg-accent/30',
            )}
            style={{ height: '32px' }}
            onContextMenu={(e) => onRowContextMenu(rowIdx, e)}
        >
            {/* Row number */}
            <td className="border-r border-border/30 px-1 text-center font-mono text-[10px] font-bold text-muted-foreground" style={{ height: '32px' }}>
                {isEmptyNew ? <span className="text-muted-foreground/30">—</span> : rowIdx + 1}
            </td>

            {/* Recv date (col 1) */}
            <td className="border-r border-border/30 p-0" style={{ height: '32px' }}>
                <DatePickerCell
                    value={row.recv_date}
                    onChange={(v) => updateRow(rowIdx, 'recv_date', v)}
                    onPaste={(e) => { e.stopPropagation(); handleSmartPaste(e, rowIdx, 1); }}
                    isActive={activeColInRow === 1}
                    isRangeSelected={isSel(1)}
                    isRangeAnchor={isAnch(1)}
                    onCellMouseDown={(e) => handleCellMouseDown(rowIdx, 1, e)}
                    onCellMouseUp={() => handleCellMouseUp(rowIdx, 1)}
                    onCellMouseEnter={() => handleCellMouseEnter(rowIdx, 1)}
                />
            </td>

            {/* Prod date (col 2) — muted (often blank) */}
            <td className="border-r border-border/30 p-0" style={{ height: '32px' }}>
                <DatePickerCell
                    value={row.prod_date}
                    onChange={(v) => updateRow(rowIdx, 'prod_date', v)}
                    onPaste={(e) => { e.stopPropagation(); handleSmartPaste(e, rowIdx, 2); }}
                    isActive={activeColInRow === 2}
                    isRangeSelected={isSel(2)}
                    isRangeAnchor={isAnch(2)}
                    onCellMouseDown={(e) => handleCellMouseDown(rowIdx, 2, e)}
                    onCellMouseUp={() => handleCellMouseUp(rowIdx, 2)}
                    onCellMouseEnter={() => handleCellMouseEnter(rowIdx, 2)}
                    muted
                />
            </td>

            {/* Batch (col 3) — text + muted batch_year tag */}
            <td className="border-r border-border/30 p-0" style={{ height: '32px' }}>
                <GridCell
                    col={3}
                    row={rowIdx}
                    value={row.batch}
                    className="justify-start px-1 font-mono text-xs font-bold"
                    displayValue={
                        <span className="flex w-full items-center gap-1 truncate px-1">
                            <span className="truncate font-bold">{row.batch}</span>
                            {row.batch_year && <span className="font-mono text-[10px] font-bold text-muted-foreground/60">{row.batch_year}</span>}
                        </span>
                    }
                    {...commonCellProps}
                    {...selProps(3)}
                >
                    <Input
                        autoFocus
                        value={row.batch}
                        onChange={(e) => updateRow(rowIdx, 'batch', e.target.value.toUpperCase())}
                        className={cn(inputClass, 'font-mono text-xs uppercase')}
                        onPaste={(e) => { e.stopPropagation(); handleSmartPaste(e, rowIdx, 3); }}
                    />
                </GridCell>
            </td>

            {/* Shift (col 4) — dropdown */}
            <td className="border-r border-border/30 p-0" style={{ height: '32px' }}>
                <div className={interactiveCellClass(4)}>
                    <SelectCell value={row.shift_code} options={SHIFT_CODES} onChange={(v) => updateRow(rowIdx, 'shift_code', v)} placeholder="—" />
                </div>
            </td>

            {/* Grade (col 5) — dropdown */}
            <td className="border-r border-border/30 p-0" style={{ height: '32px' }}>
                <div className={interactiveCellClass(5)}>
                    <SelectCell value={row.grade_code} options={GRADE_CODES} onChange={(v) => updateRow(rowIdx, 'grade_code', v)} placeholder="—" />
                </div>
            </td>

            {/* Plant (col 6) — dropdown, nullable. Display value renders as a per-plant
                colored badge (W6 blue / W7 teal / W6/W7 indigo / DVO slate); empty = plain. */}
            <td className="border-r border-border/30 p-0" style={{ height: '32px' }}>
                <div className={interactiveCellClass(6)}>
                    <SelectCell
                        value={row.plant_code}
                        options={PLANT_CODES}
                        onChange={(v) => updateRow(rowIdx, 'plant_code', v)}
                        nullable
                        placeholder="—"
                        renderTrigger={(v) => (
                            <span className={cn(BADGE_BASE, plantBadgeClass(v))}>{v}</span>
                        )}
                    />
                </div>
            </td>

            {/* Whse (col 7) — dropdown, nullable (null = unplaced) */}
            <td className="border-r border-border/30 p-0" style={{ height: '32px' }}>
                <div className={cn(interactiveCellClass(7), row.warehouse_code === '' && !isEmptyNew && 'bg-amber-500/[0.04]')}>
                    <SelectCell value={row.warehouse_code} options={WAREHOUSE_CODES} onChange={(v) => updateRow(rowIdx, 'warehouse_code', v)} nullable placeholder="unplaced" />
                </div>
            </td>

            {/* Source (col 8) — dropdown */}
            <td className="border-r border-border/30 p-0" style={{ height: '32px' }}>
                <div className={interactiveCellClass(8)}>
                    <SelectCell value={row.source_location_code} options={SOURCE_LOCATION_CODES} onChange={(v) => updateRow(rowIdx, 'source_location_code', v)} placeholder="—" />
                </div>
            </td>

            {/* Weight (col 9) — numeric, right-aligned */}
            <td className="border-r border-border/30 p-0" style={{ height: '32px' }}>
                <GridCell
                    col={9}
                    row={rowIdx}
                    value={formatKg(row.weight_kg)}
                    className="justify-end pr-1 font-mono font-bold tabular-nums"
                    {...commonCellProps}
                    {...selProps(9)}
                >
                    <Input
                        autoFocus
                        type="number"
                        step="1"
                        value={row.weight_kg}
                        onChange={(e) => updateRow(rowIdx, 'weight_kg', e.target.value)}
                        className={cn(inputClass, 'text-right font-mono text-xs')}
                        onPaste={(e) => { e.stopPropagation(); handleSmartPaste(e, rowIdx, 9); }}
                    />
                </GridCell>
            </td>

            {/* CCC/FLEC (col 10) — single typeahead cell, Excel parity. The raw text
                stands in for disposition_kind + partner_equipment_code (parsed back into
                both DB fields at save). Paste-friendly <Input list> (datalist), not a
                strict dropdown — so a pasted FLEC/C1/RK3 lands directly. */}
            <td className="border-r border-border/30 p-0" style={{ height: '32px' }}>
                <GridCell
                    col={10}
                    row={rowIdx}
                    value={row.ccc_flec}
                    className="justify-start px-1 font-mono text-xs font-bold"
                    displayValue={
                        row.ccc_flec
                            ? <span className="flex w-full items-center px-1">
                                  <span className={cn(BADGE_BASE, cccFlecBadgeClass(row.ccc_flec))}>{row.ccc_flec}</span>
                              </span>
                            : <span className="px-1 text-muted-foreground/40">—</span>
                    }
                    {...commonCellProps}
                    {...selProps(10)}
                >
                    <Input
                        autoFocus
                        value={row.ccc_flec}
                        list="ledger-ccc-flec-suggestions"
                        onChange={(e) => updateRow(rowIdx, 'ccc_flec', e.target.value.toUpperCase())}
                        className={cn(inputClass, 'font-mono text-xs uppercase')}
                        onPaste={(e) => { e.stopPropagation(); handleSmartPaste(e, rowIdx, 10); }}
                    />
                </GridCell>
            </td>

            {/* Flec (col 11) — numeric int, right-aligned */}
            <td className="border-r border-border/30 p-0" style={{ height: '32px' }}>
                <GridCell
                    col={11}
                    row={rowIdx}
                    value={row.flec_count}
                    className="justify-end pr-1 font-mono font-bold tabular-nums text-muted-foreground"
                    {...commonCellProps}
                    {...selProps(11)}
                >
                    <Input
                        autoFocus
                        type="number"
                        step="1"
                        value={row.flec_count}
                        onChange={(e) => updateRow(rowIdx, 'flec_count', e.target.value)}
                        className={cn(inputClass, 'text-right font-mono text-xs')}
                        onPaste={(e) => { e.stopPropagation(); handleSmartPaste(e, rowIdx, 11); }}
                    />
                </GridCell>
            </td>

            {/* Side (col 12) — dropdown, nullable */}
            <td className="p-0" style={{ height: '32px' }}>
                <div className={interactiveCellClass(12)}>
                    <SelectCell value={row.whse_side} options={WHSE_SIDES} onChange={(v) => updateRow(rowIdx, 'whse_side', v)} nullable placeholder="—" align="end" />
                </div>
            </td>
        </tr>
    );
});

// ─── Component props ─────────────────────────────────────────────────────────────
interface ProductionLedgerGridProps {
    initialRows: ProductionEventRow[];
    periods: CenaproPeriod[];
    selectedPeriod: CenaproPeriod | null;
    loadError: string | null;
    onSaveSuccess: () => void;
}

// ─── Main component ──────────────────────────────────────────────────────────────
export function ProductionLedgerGrid({
    initialRows,
    periods,
    selectedPeriod,
    loadError,
    onSaveSuccess,
}: ProductionLedgerGridProps) {
    const gridRef = React.useRef<HTMLDivElement>(null);

    // Date sort — clickable on EITHER date header. Default: newest-first by recv_date
    // (operators care about recent activity most); clicking the Prod header switches the
    // sort key to prod_date. Each header toggles asc/desc on repeat clicks.
    const [dateSortKey, setDateSortKey] = React.useState<DateSortKey>('recv_date');
    const [dateSortDir, setDateSortDir] = React.useState<'asc' | 'desc'>('desc');

    const [rows, setRows] = React.useState<GridRow[]>(() => [
        ...buildGridRows(initialRows, 'recv_date', 'desc'),
        createEmptyRow(),
    ]);

    const [activeCell, setActiveCell] = React.useState<{ row: number; col: number } | null>(null);
    const [isEditing, setIsEditing] = React.useState(false);
    const [isSaving, setIsSaving] = React.useState(false);
    const [bulkAddOpen, setBulkAddOpen] = React.useState(false);
    const preEditValue = React.useRef<string>('');

    // Live refs to `rows` + `activeCell`, synced during render. These let the cell
    // callbacks (`startEditing`, `revertChanges`) read current values WITHOUT listing
    // `rows`/`activeCell` in their deps — keeping their identity STABLE so the memoized
    // ProductionRow isn't re-rendered on every keystroke just because a handler changed.
    const rowsRef = React.useRef(rows);
    rowsRef.current = rows;
    const activeCellRef = React.useRef(activeCell);
    activeCellRef.current = activeCell;

    // Header filters — single-select; 'ALL' = no filter. Set = Shift / Grade / Plant /
    // Warehouse / Source (Disposition is gone — it's no longer a standalone column).
    const [shiftFilter, setShiftFilter] = React.useState('ALL');
    const [gradeFilter, setGradeFilter] = React.useState('ALL');
    const [plantFilter, setPlantFilter] = React.useState('ALL');
    const [warehouseFilter, setWarehouseFilter] = React.useState('ALL');
    const [sourceFilter, setSourceFilter] = React.useState('ALL');

    // ─── Re-sort the data rows when the date key/direction changes (keep trailing) ──
    React.useEffect(() => {
        setRows((prev) => {
            const trailing = prev[prev.length - 1]?._state === 'new' && !isMeaningfulNewRow(prev[prev.length - 1])
                ? [prev[prev.length - 1]]
                : [];
            const dataRows = trailing.length > 0 ? prev.slice(0, -1) : prev;
            return [...sortGridRows(dataRows, dateSortKey, dateSortDir), ...trailing];
        });
    }, [dateSortKey, dateSortDir]);

    // ─── Context menu state ────────────────────────────────────────────────────────
    const [contextMenu, setContextMenu] = React.useState<{ rowIdx: number; x: number; y: number } | null>(null);
    React.useEffect(() => {
        if (!contextMenu) return;
        const handleClick = (e: MouseEvent) => {
            const target = e.target as HTMLElement;
            if (!target.closest('[data-ctx-menu]')) setContextMenu(null);
        };
        const handleKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape') setContextMenu(null);
        };
        document.addEventListener('mousedown', handleClick, true);
        document.addEventListener('keydown', handleKey, true);
        return () => {
            document.removeEventListener('mousedown', handleClick, true);
            document.removeEventListener('keydown', handleKey, true);
        };
    }, [contextMenu]);

    // ─── Cell selection (every column except row# is selectable) ───────────────────
    const isSelectableColumn = React.useCallback((c: number) => c !== 0 && COL_MAP[c] !== null, []);
    const cellSelection = useCellSelection({
        rowCount: rows.length,
        colCount: COL_COUNT,
        isSelectableColumn,
        scrollContainerRef: gridRef,
        enabled: true,
    });

    // ─── Cell value accessor (for clipboard copy) ──────────────────────────────────
    const getCellValue = React.useCallback(
        (rowIdx: number, colIdx: number): string => {
            const row = rows[rowIdx];
            if (!row) return '';
            const field = COL_MAP[colIdx];
            if (!field) return '';
            // CCC/FLEC copies as its raw Excel value ("FLEC"/"C1"/"RK3") so a copied
            // range round-trips straight back into the same single column on paste.
            return String(row[field] ?? '');
        },
        [rows],
    );

    const { handleKeyDown: handleCopyKeyDown } = useClipboardCopy({
        getSelectedRange: cellSelection.getSelectedRange,
        getCellValue,
        getSelectionSize: cellSelection.getSelectionSize,
    });

    // ─── Mouse handlers (drag-select vs click-to-activate) ─────────────────────────
    const mouseDownCellRef = React.useRef<{ row: number; col: number } | null>(null);
    const dragMovedRef = React.useRef(false);

    // Depend on the INDIVIDUAL stable hook methods (each is a useCallback inside
    // useCellSelection), NOT the `cellSelection` object — that object is a fresh literal
    // every render, which would make these handlers (and thus every memoized row) churn.
    const selMouseDown = cellSelection.handleCellMouseDown;
    const selMouseEnter = cellSelection.handleCellMouseEnter;
    const selClear = cellSelection.clearSelection;

    const handleCellMouseDown = React.useCallback(
        (rowIdx: number, colIdx: number, e: React.MouseEvent) => {
            mouseDownCellRef.current = { row: rowIdx, col: colIdx };
            dragMovedRef.current = false;
            selMouseDown(rowIdx, colIdx, e);
        },
        [selMouseDown],
    );

    const handleCellMouseUp = React.useCallback(
        (rowIdx: number, colIdx: number) => {
            const down = mouseDownCellRef.current;
            mouseDownCellRef.current = null;
            if (down && down.row === rowIdx && down.col === colIdx && !dragMovedRef.current) {
                selClear();
                setActiveCell({ row: rowIdx, col: colIdx });
                setIsEditing(false);
                gridRef.current?.focus();
            }
            dragMovedRef.current = false;
        },
        [selClear],
    );

    const handleCellMouseEnter = React.useCallback(
        (rowIdx: number, colIdx: number) => {
            if (mouseDownCellRef.current) {
                dragMovedRef.current = true;
                selMouseEnter(rowIdx, colIdx);
            }
        },
        [selMouseEnter],
    );

    // ─── Row mutation helpers ──────────────────────────────────────────────────────
    // Ensures a trailing empty 'new' row always exists so the operator can keep adding.
    const ensureTrailingEmptyRow = (next: GridRow[]): GridRow[] => {
        const last = next[next.length - 1];
        if (!last || last._state !== 'new' || isMeaningfulNewRow(last)) {
            next.push(createEmptyRow());
        }
        return next;
    };

    const updateRow = React.useCallback((idx: number, field: GridField, value: string) => {
        setRows((prev) => {
            const next = [...prev];
            // `ccc_flec` is a real raw-text field now (parsed to the two DB fields at
            // save), so the generic spread handles every column — no special-casing.
            const row = { ...next[idx], [field]: value };
            if (row._state === 'existing') row._state = 'modified';
            next[idx] = row;
            return ensureTrailingEmptyRow(next);
        });
    }, []);

    const markDeleted = React.useCallback((idx: number) => {
        setRows((prev) => {
            const next = [...prev];
            const row = { ...next[idx] };
            if (row._state === 'new') {
                if (next.length > 1) next.splice(idx, 1);
                return next;
            }
            row._state = 'deleted';
            next[idx] = row;
            return next;
        });
    }, []);

    const restoreRow = React.useCallback((idx: number) => {
        setRows((prev) => {
            const next = [...prev];
            const row = { ...next[idx] };
            row._state = row.id ? 'existing' : 'new';
            next[idx] = row;
            return next;
        });
    }, []);

    const insertRowAt = React.useCallback((idx: number, offset: 0 | 1) => {
        setRows((prev) => {
            const next = [...prev];
            const ref = next[idx];
            // Inherit dates from the reference row so a burst of same-day entries is fast.
            const newRow = createEmptyRow({ recv_date: ref?.recv_date ?? new Date().toISOString().split('T')[0] });
            next.splice(idx + offset, 0, newRow);
            return ensureTrailingEmptyRow(next);
        });
    }, []);

    const duplicateRow = React.useCallback((idx: number) => {
        setRows((prev) => {
            const next = [...prev];
            const src = next[idx];
            if (!src) return prev;
            // A duplicate is a brand-new row (no id) — never an UPDATE of the source.
            const dup: GridRow = { ...src, _state: 'new', id: '', batch_year: '' };
            next.splice(idx + 1, 0, dup);
            return ensureTrailingEmptyRow(next);
        });
    }, []);

    const clearCell = React.useCallback(
        (rowIdx: number, colIdx: number) => {
            const field = COL_MAP[colIdx];
            if (!field) return;
            updateRow(rowIdx, field, '');
        },
        [updateRow],
    );

    const { handleKeyDown: handleDeleteKeyDown } = useCellDelete({
        getSelectedRange: cellSelection.getSelectedRange,
        getSelectionSize: cellSelection.getSelectionSize,
        clearCell,
    });

    // ─── Editing (text/numeric cells only; dropdowns/dates self-manage) ────────────
    // Reads `rowsRef.current` (not `rows`) so its identity stays stable across edits
    // (`updateRow` is already stable) — the memoized rows don't churn on every keystroke.
    const startEditing = React.useCallback(
        (rowIdx: number, colIdx: number, initialChar?: string) => {
            const field = COL_MAP[colIdx];
            if (!field) return;
            // Dropdown + date columns aren't keyboard-typed — they open their own UI.
            if (DROPDOWN_FIELDS.has(field) || field === 'recv_date' || field === 'prod_date') return;
            const row = rowsRef.current[rowIdx];
            if (!row) return;
            preEditValue.current = String(row[field] ?? '');
            setActiveCell({ row: rowIdx, col: colIdx });
            setIsEditing(true);
            if (initialChar !== undefined) updateRow(rowIdx, field, initialChar);
        },
        [updateRow],
    );

    // Reads `activeCellRef.current` so its identity is STABLE (empty deps) — otherwise
    // it would change on every cell move and re-render all memoized rows.
    const revertChanges = React.useCallback(() => {
        const cell = activeCellRef.current;
        if (!cell) return;
        const field = COL_MAP[cell.col];
        if (field) {
            setRows((prev) => {
                const next = [...prev];
                const row = { ...next[cell.row] };
                (row as Record<string, unknown>)[field] = preEditValue.current;
                if (row._state === 'modified' && row.id) row._state = 'existing';
                next[cell.row] = row;
                return next;
            });
        }
        setIsEditing(false);
        gridRef.current?.focus();
    }, []);

    const moveActive = React.useCallback(
        (key: string, shift: boolean) => {
            if (!activeCell) return;
            let { row, col } = activeCell;
            if (key === 'ArrowUp' || (key === 'Enter' && shift)) row = Math.max(0, row - 1);
            else if (key === 'ArrowDown' || (key === 'Enter' && !shift)) row = Math.min(rows.length - 1, row + 1);
            else if (key === 'ArrowLeft') {
                do { col--; } while (col > 0 && COL_MAP[col] === null);
                col = Math.max(1, col);
            } else if (key === 'ArrowRight') {
                do { col++; } while (col < COL_COUNT - 1 && COL_MAP[col] === null);
                col = Math.min(COL_COUNT - 1, col);
            } else if (key === 'Tab') {
                if (shift) {
                    do { col--; if (col < 1) { row--; col = COL_COUNT - 1; } } while (row >= 0 && COL_MAP[col] === null);
                    if (row < 0) { row = 0; col = activeCell.col; }
                } else {
                    do { col++; if (col >= COL_COUNT) { row++; col = 1; } } while (row < rows.length && COL_MAP[col] === null);
                    if (row >= rows.length) { row = rows.length - 1; col = activeCell.col; }
                }
            } else if (key === 'Home') col = 1;
            else if (key === 'End') col = COL_COUNT - 1;
            setActiveCell({ row, col });
        },
        [activeCell, rows.length],
    );

    const handleGridKeyDown = React.useCallback(
        (e: React.KeyboardEvent) => {
            if (!activeCell) return;
            const isRangeSelected = cellSelection.getSelectionSize() > 1;
            if (isEditing) {
                if (e.key === 'Escape') {
                    e.preventDefault();
                    e.stopPropagation();
                    e.nativeEvent.stopImmediatePropagation();
                    revertChanges();
                } else if (e.key === 'Enter' || e.key === 'Tab') {
                    e.preventDefault();
                    setIsEditing(false);
                    moveActive(e.key, e.shiftKey);
                    gridRef.current?.focus();
                }
                return;
            }
            if (isRangeSelected) {
                if (e.shiftKey && ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key)) {
                    e.preventDefault();
                    cellSelection.handleKeyDown(e);
                    return;
                }
                if ((e.metaKey || e.ctrlKey) && e.key === 'c') { handleCopyKeyDown(e); return; }
                if (e.key === 'Backspace' || e.key === 'Delete') { handleDeleteKeyDown(e); cellSelection.clearSelection(); return; }
                if (e.key === 'Escape') { e.preventDefault(); cellSelection.clearSelection(); return; }
                if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Tab', 'Enter'].includes(e.key)) cellSelection.clearSelection();
            }
            if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Tab', 'Enter', 'Home', 'End'].includes(e.key)) {
                e.preventDefault();
                if (e.shiftKey && ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key) && !isRangeSelected) {
                    cellSelection.handleCellMouseDown(activeCell.row, activeCell.col, { shiftKey: false, button: 0, preventDefault: () => {} } as unknown as React.MouseEvent);
                    cellSelection.handleMouseUp();
                    cellSelection.handleKeyDown(e);
                    return;
                }
                moveActive(e.key, e.shiftKey);
                return;
            }
            const field = COL_MAP[activeCell.col];
            const isTypable = field && !DROPDOWN_FIELDS.has(field) && field !== 'recv_date' && field !== 'prod_date';
            if (e.key === 'F2' && isTypable) { e.preventDefault(); startEditing(activeCell.row, activeCell.col); return; }
            if ((e.key === 'Backspace' || e.key === 'Delete') && isTypable) { e.preventDefault(); startEditing(activeCell.row, activeCell.col, ''); return; }
            if (isTypable && e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
                e.preventDefault();
                startEditing(activeCell.row, activeCell.col, e.key);
            }
        },
        [activeCell, isEditing, cellSelection, handleCopyKeyDown, handleDeleteKeyDown, revertChanges, moveActive, startEditing],
    );

    // ─── Paste (Excel TSV → grid, starting at the active cell) ─────────────────────
    const handleSmartPaste = React.useCallback(
        (e: React.ClipboardEvent, startRow: number, startCol: number) => {
            e.preventDefault();
            const text = e.clipboardData.getData('text');
            if (!text) return;
            const pastedRows = text.split(/\r\n|\n|\r/).filter((r) => r.trim() !== '');
            if (!pastedRows.length) return;
            setRows((prev) => {
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
                        // CCC/FLEC pastes as raw text (parsed to the two DB fields at
                        // save) — no cross-field re-derive needed on paste anymore.
                        (row as Record<string, unknown>)[field] = cleanPasteValue(cellVal, field);
                        if (row._state === 'existing') row._state = 'modified';
                        next[targetRow] = row;
                    });
                });
                return ensureTrailingEmptyRow(next);
            });
            toast.success(`Pasted ${pastedRows.length} row${pastedRows.length !== 1 ? 's' : ''}`);
        },
        [],
    );

    const handleGridPaste = React.useCallback(
        (e: React.ClipboardEvent) => {
            if (!isEditing && activeCell) {
                handleSmartPaste(e, activeCell.row, activeCell.col);
                cellSelection.clearSelection();
            }
        },
        [isEditing, activeCell, handleSmartPaste, cellSelection],
    );

    // ─── Dirty state ───────────────────────────────────────────────────────────────
    const isDirty = rows.some((r) => {
        if (r._state === 'deleted' || r._state === 'modified') return true;
        if (r._state === 'new' && isMeaningfulNewRow(r)) return true;
        return false;
    });

    const handleDiscard = React.useCallback(() => {
        setRows([...buildGridRows(initialRows, dateSortKey, dateSortDir), createEmptyRow()]);
        setActiveCell(null);
        setIsEditing(false);
        cellSelection.clearSelection();
    }, [initialRows, dateSortKey, dateSortDir, cellSelection]);

    // ─── Save ──────────────────────────────────────────────────────────────────────
    const handleSave = async () => {
        // Parse the single CCC/FLEC cell into the two normalized DB fields up front. A
        // single typed cell can't produce an inconsistent (disposition, equipment) pair,
        // so the only failure mode is an UNRECOGNIZED value — surface that BEFORE the
        // round-trip as a clear, persistent, copyable message (HARD RULE) instead of a
        // cryptic Postgres FK/CHECK error. Empty CCC/FLEC passes through (same as before).
        const dirtyRows: ProductionEventDirtyRow[] = [];
        const deletedIds: string[] = [];
        const invalid: string[] = [];

        for (const r of rows) {
            if (r._state === 'deleted') {
                if (r.id) deletedIds.push(r.id);
                continue;
            }
            if (r._state === 'new' && !isMeaningfulNewRow(r)) continue;
            if (r._state === 'existing') continue; // untouched

            // Derive disposition + equipment from the merged CCC/FLEC cell.
            let disposition = '';
            let equipment = '';
            const raw = r.ccc_flec.trim();
            if (raw) {
                const res = parseCccFlec(raw);
                if (res) {
                    disposition = res.disposition_kind;
                    equipment = res.partner_equipment_code ?? '';
                } else {
                    const which = r.batch ? `batch ${r.batch}` : `${r.recv_date || 'undated'} row`;
                    invalid.push(`${which}: CCC/FLEC "${raw}"`);
                    continue;
                }
            }

            dirtyRows.push({
                id: r.id || undefined,
                recv_date: r.recv_date,
                prod_date: r.prod_date,
                batch: r.batch,
                shift_code: r.shift_code,
                grade_code: r.grade_code,
                plant_code: r.plant_code,
                warehouse_code: r.warehouse_code,
                source_location_code: r.source_location_code,
                weight_kg: r.weight_kg,
                disposition_kind: disposition,
                partner_equipment_code: equipment,
                flec_count: r.flec_count,
                whse_side: r.whse_side,
            });
        }

        if (invalid.length > 0) {
            errorToast(
                `${invalid.length} row${invalid.length !== 1 ? 's' : ''} have an unrecognized CCC/FLEC value.`,
                {
                    description:
                        'The CCC/FLEC column must be FLEC (for bagging) or an equipment code — C1–C4 (crusher) or RK1–RK4 (kiln). Fix these, then Save again:\n\n' +
                        invalid.join('\n'),
                },
            );
            return;
        }

        if (dirtyRows.length === 0 && deletedIds.length === 0) {
            toast.info('No changes to save.');
            return;
        }

        setIsSaving(true);
        try {
            const res = await saveProductionEvents(dirtyRows, deletedIds);
            if (!res.ok) {
                errorToast(res.error ?? 'Failed to save production events.');
            } else {
                const parts: string[] = [];
                if (res.upserted) parts.push(`${res.upserted} saved`);
                if (res.deleted) parts.push(`${res.deleted} deleted`);
                toast.success(`Saved — ${parts.join(', ') || 'no changes'}`);
                onSaveSuccess();
            }
        } catch (err) {
            errorToast('Unexpected error: ' + (err instanceof Error ? err.message : String(err)));
        } finally {
            setIsSaving(false);
        }
    };

    // ─── Row context menu (stable — passed to the memoized row) ────────────────────
    // Lifted out of the inline row JSX so each ProductionRow gets a referentially
    // stable handler (memo-friendly). Positions the menu, clamping to the viewport.
    const onRowContextMenu = React.useCallback((rowIdx: number, e: React.MouseEvent) => {
        e.preventDefault();
        const MENU_W = 188;
        const MENU_H = 164;
        let x = e.clientX;
        let y = e.clientY;
        if (x + MENU_W > window.innerWidth) x -= MENU_W;
        if (y + MENU_H > window.innerHeight) y -= MENU_H;
        setContextMenu({ rowIdx, x, y });
        setActiveCell({ row: rowIdx, col: 1 });
        setIsEditing(false);
    }, []);

    // ─── Selection range slice (drives per-row memo props) ─────────────────────────
    // The whole grid shares one selection rectangle; we pass each row only the columns
    // of that rectangle (so a row outside the selection sees stable primitives and the
    // memo skips it). `range` is null when nothing is selected.
    const selRange = cellSelection.range;
    const selectionSize = cellSelection.getSelectionSize();

    // ─── Distinct filter options (derived from data; only present values appear) ────
    // Filter set = Shift / Grade / Plant / Warehouse / Source (Disposition is gone — no
    // longer a standalone column). Options come from the loaded period's data, matching
    // how Shift/Grade/Warehouse already sourced theirs.
    const { shiftOptions, gradeOptions, plantOptions, warehouseOptions, sourceOptions } = React.useMemo(() => {
        const shifts = new Set<string>();
        const grades = new Set<string>();
        const plants = new Set<string>();
        const warehouses = new Set<string>();
        const sources = new Set<string>();
        let hasUnplaced = false;
        for (const r of rows) {
            if (r._state === 'deleted' || (r._state === 'new' && !isMeaningfulNewRow(r))) continue;
            if (r.shift_code) shifts.add(r.shift_code);
            if (r.grade_code) grades.add(r.grade_code);
            if (r.plant_code) plants.add(r.plant_code);
            if (r.source_location_code) sources.add(r.source_location_code);
            if (r.warehouse_code) warehouses.add(r.warehouse_code);
            else hasUnplaced = true;
        }
        const warehouseOpts = [...warehouses].sort().map((w) => ({ value: w, label: w }));
        if (hasUnplaced) warehouseOpts.push({ value: '__NULL__', label: '— Unplaced' });
        return {
            shiftOptions: [...shifts].sort().map((s) => ({ value: s, label: s })),
            gradeOptions: [...grades].sort().map((g) => ({ value: g, label: g })),
            plantOptions: [...plants].sort().map((p) => ({ value: p, label: p })),
            warehouseOptions: warehouseOpts,
            sourceOptions: [...sources].sort().map((s) => ({ value: s, label: s })),
        };
    }, [rows]);

    // ─── Per-row visibility under active filters (index-preserving HIDE) ───────────
    const isRowHidden = React.useCallback(
        (row: GridRow): boolean => {
            if (row._state === 'new' && !isMeaningfulNewRow(row)) return false; // keep the typing row
            if (shiftFilter !== 'ALL' && row.shift_code !== shiftFilter) return true;
            if (gradeFilter !== 'ALL' && row.grade_code !== gradeFilter) return true;
            if (plantFilter !== 'ALL' && row.plant_code !== plantFilter) return true;
            if (sourceFilter !== 'ALL' && row.source_location_code !== sourceFilter) return true;
            if (warehouseFilter !== 'ALL') {
                if (warehouseFilter === '__NULL__') {
                    if (row.warehouse_code !== '') return true;
                } else if (row.warehouse_code !== warehouseFilter) {
                    return true;
                }
            }
            return false;
        },
        [shiftFilter, gradeFilter, plantFilter, sourceFilter, warehouseFilter],
    );

    const anyFilterActive =
        shiftFilter !== 'ALL' ||
        gradeFilter !== 'ALL' ||
        plantFilter !== 'ALL' ||
        sourceFilter !== 'ALL' ||
        warehouseFilter !== 'ALL';

    const clearFilters = () => {
        setShiftFilter('ALL');
        setGradeFilter('ALL');
        setPlantFilter('ALL');
        setSourceFilter('ALL');
        setWarehouseFilter('ALL');
    };

    // ─── Date sort header click (CHANGE 2: sort by EITHER recv or prod date) ────────
    // Clicking the active date key toggles asc/desc; clicking the other date header
    // switches the sort key to it (defaulting to descending — newest-first — like the
    // original recv default). The re-sort effect above reacts to key/dir changes.
    // NOTE: keep these setState calls flat — do NOT nest setDateSortDir inside a
    // setDateSortKey updater. React Strict Mode (dev) double-invokes updater fns, and a
    // nested flip would run twice → cancel out (the "clicking doesn't flip" bug).
    const handleDateSort = React.useCallback((key: DateSortKey) => {
        if (key === dateSortKey) {
            // Same column → flip direction (pure updater is double-invoke-safe).
            setDateSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
        } else {
            // New column → switch key, default to descending (newest-first).
            setDateSortKey(key);
            setDateSortDir('desc');
        }
    }, [dateSortKey]);

    // ─── Counts ────────────────────────────────────────────────────────────────────
    const savedRowCount = rows.filter((r) => r._state !== 'new' && r._state !== 'deleted').length;
    const dirtyCount = rows.filter(
        (r) => r._state === 'modified' || r._state === 'deleted' || (r._state === 'new' && isMeaningfulNewRow(r)),
    ).length;
    const visibleCount = rows.filter((r) => !isRowHidden(r) && !(r._state === 'new' && !isMeaningfulNewRow(r))).length;
    const allHiddenByFilter = anyFilterActive && visibleCount === 0;

    // ─── Render ────────────────────────────────────────────────────────────────────
    return (
        <div className="flex h-full flex-col">
            {/* Toolbar */}
            <div className="flex flex-none items-center gap-2 border-b bg-muted/30 px-2 py-1.5 md:px-3">
                <CenaproPeriodPicker
                    periods={periods}
                    selected={selectedPeriod}
                    disabled={isDirty}
                    disabledHint="Save or discard your edits before switching period"
                />
                <span className="h-4 w-px bg-border/60" />
                <span className="font-mono text-[11px] text-muted-foreground/70">
                    {savedRowCount.toLocaleString('en-US')} row{savedRowCount !== 1 ? 's' : ''}
                    {dirtyCount > 0 && <span className="ml-1 text-amber-600 dark:text-amber-400">· {dirtyCount} unsaved</span>}
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
                    onClick={() => setBulkAddOpen(true)}
                    title="Open a fresh grid for fast multi-row entry — paste from Excel/Sheets"
                >
                    <Sparkles className="h-3 w-3" />
                    Bulk Add
                </Button>
                {isDirty && (
                    <Button variant="ghost" size="sm" className="h-6 gap-1 px-2 text-[11px]" onClick={handleDiscard} disabled={isSaving}>
                        <RotateCcw className="h-3 w-3" />
                        Discard
                    </Button>
                )}
                <Button size="sm" className="h-6 gap-1 px-2 text-[11px]" onClick={handleSave} disabled={isSaving || !isDirty}>
                    <Save className="h-3 w-3" />
                    {isSaving ? 'Saving…' : 'Save'}
                </Button>
            </div>

            {loadError && (
                <div className="m-3 flex items-start gap-3 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm">
                    <div className="min-w-0 flex-1">
                        <p className="font-medium text-destructive">Couldn&apos;t load production data</p>
                        <p className="mt-1 break-words text-destructive/90">{loadError}</p>
                        <p className="mt-1 text-xs text-muted-foreground">Try again in a moment, or copy the message above if it persists.</p>
                    </div>
                    <Button
                        variant="ghost"
                        size="sm"
                        className="h-7 shrink-0 px-2 text-destructive hover:text-destructive"
                        onClick={() => {
                            void navigator.clipboard.writeText(loadError).then(() => toast.success('Error copied to clipboard', { duration: 2000 }));
                        }}
                    >
                        <Copy className="mr-1 h-3.5 w-3.5" />
                        Copy
                    </Button>
                </div>
            )}

            {/* Grid */}
            <div
                ref={gridRef}
                className="relative min-h-0 flex-1 select-none overflow-auto outline-none"
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
                <table className="relative table-fixed text-xs" style={{ width: '100%', minWidth: '1228px', borderCollapse: 'separate', borderSpacing: 0 }}>
                    {/* col order: # / recv / prod / batch / shift / grade / plant / whse / source / weight / CCC/FLEC / flec / side */}
                    <colgroup>
                        <col style={{ width: '36px' }} />
                        <col style={{ width: '96px' }} />
                        <col style={{ width: '96px' }} />
                        <col style={{ width: '120px' }} />
                        <col style={{ width: '64px' }} />
                        <col style={{ width: '80px' }} />
                        <col style={{ width: '84px' }} />
                        <col style={{ width: '108px' }} />
                        <col style={{ width: '84px' }} />
                        <col style={{ width: '104px' }} />
                        <col style={{ width: '112px' }} />
                        <col style={{ width: '72px' }} />
                        <col style={{ width: '72px' }} />
                    </colgroup>
                    <thead className="sticky top-0 z-20 bg-muted/90 backdrop-blur-sm">
                        <tr className="border-b">
                            <th className="h-8 border-r border-border/40 px-1 text-center font-mono text-[10px] font-bold text-muted-foreground">#</th>
                            <th className="h-8 px-2 text-left text-muted-foreground">
                                <DateSortHeader label="Recv" sortKey="recv_date" activeKey={dateSortKey} dir={dateSortDir} onSort={handleDateSort} />
                            </th>
                            <th className="h-8 px-2 text-left text-muted-foreground">
                                <DateSortHeader label="Prod" sortKey="prod_date" activeKey={dateSortKey} dir={dateSortDir} onSort={handleDateSort} />
                            </th>
                            <th className="h-8 px-2 text-left text-[11px] font-bold uppercase tracking-wide text-muted-foreground">Batch</th>
                            <th className="h-8 px-2 text-left text-[11px] font-bold uppercase tracking-wide text-muted-foreground">
                                <ColumnFilterMenu label="Shift" value={shiftFilter} options={shiftOptions} onChange={setShiftFilter} />
                            </th>
                            <th className="h-8 px-2 text-left text-[11px] font-bold uppercase tracking-wide text-muted-foreground">
                                <ColumnFilterMenu label="Grade" value={gradeFilter} options={gradeOptions} onChange={setGradeFilter} />
                            </th>
                            <th className="h-8 px-2 text-left text-[11px] font-bold uppercase tracking-wide text-muted-foreground">
                                <ColumnFilterMenu label="Plant" value={plantFilter} options={plantOptions} onChange={setPlantFilter} />
                            </th>
                            <th className="h-8 px-2 text-left text-[11px] font-bold uppercase tracking-wide text-muted-foreground">
                                <ColumnFilterMenu label="Whse" value={warehouseFilter} options={warehouseOptions} onChange={setWarehouseFilter} />
                            </th>
                            <th className="h-8 px-2 text-left text-[11px] font-bold uppercase tracking-wide text-muted-foreground">
                                <ColumnFilterMenu label="Source" value={sourceFilter} options={sourceOptions} onChange={setSourceFilter} />
                            </th>
                            <th className="h-8 px-2 text-right text-[11px] font-bold uppercase tracking-wide text-muted-foreground">Weight</th>
                            <th className="h-8 px-2 text-left text-[11px] font-bold uppercase tracking-wide text-muted-foreground">CCC/FLEC</th>
                            <th className="h-8 px-2 text-right text-[11px] font-bold uppercase tracking-wide text-muted-foreground">Flec</th>
                            <th className="h-8 px-2 text-left text-[11px] font-bold uppercase tracking-wide text-muted-foreground">Side</th>
                        </tr>
                    </thead>
                    <tbody>
                        {/* Empty state — only the trailing new row, nothing saved yet */}
                        {rows.length === 1 && rows[0]._state === 'new' && !isMeaningfulNewRow(rows[0]) && (
                            <tr>
                                <td colSpan={COL_COUNT} className="py-10 text-center">
                                    <div className="flex flex-col items-center justify-center gap-2 text-center">
                                        <Inbox className="h-8 w-8 text-muted-foreground/30" />
                                        <p className="text-sm text-muted-foreground">
                                            No production events yet. Start typing in the empty row, or paste a range from Excel.
                                        </p>
                                    </div>
                                </td>
                            </tr>
                        )}

                        {/* All rows hidden by filter */}
                        {allHiddenByFilter && (
                            <tr>
                                <td colSpan={COL_COUNT} className="py-10 text-center">
                                    <div className="flex flex-col items-center justify-center gap-2 text-center">
                                        <Inbox className="h-8 w-8 text-muted-foreground/30" />
                                        <p className="text-sm text-muted-foreground">No rows match the current filters.</p>
                                        <Button variant="outline" size="sm" className="h-6 px-2 text-[11px]" onClick={clearFilters}>
                                            Clear filters
                                        </Button>
                                    </div>
                                </td>
                            </tr>
                        )}

                        {rows.map((row, rowIdx) => {
                            // Slice the global active/selection state down to THIS row so
                            // the memoized ProductionRow only re-renders when its own cells
                            // change. All props below are primitives (or stable callbacks).
                            const activeColInRow =
                                activeCell?.row === rowIdx ? activeCell.col : -1;
                            const rowInRange =
                                !!selRange && rowIdx >= selRange.startRow && rowIdx <= selRange.endRow;
                            // Anchor col within this row (−1 if the anchor is elsewhere). The
                            // hook exposes isAnchor(r,c); scan the row's selectable cols for it
                            // (cheap — ≤13 cols), only when a selection exists.
                            let anchorCol = -1;
                            if (selRange) {
                                for (let c = 1; c < COL_COUNT; c++) {
                                    if (cellSelection.isAnchor(rowIdx, c)) {
                                        anchorCol = c;
                                        break;
                                    }
                                }
                            }

                            return (
                                <ProductionRow
                                    key={row.id || `new-${rowIdx}`}
                                    row={row}
                                    rowIdx={rowIdx}
                                    rowHidden={isRowHidden(row)}
                                    contextMenuActive={contextMenu?.rowIdx === rowIdx}
                                    activeColInRow={activeColInRow}
                                    isEditing={isEditing && activeColInRow >= 0}
                                    rowInRange={rowInRange}
                                    // Pass the range's col-span only for in-range rows so a
                                    // row OUTSIDE the selection keeps stable (−1) props as the
                                    // selection grows → memo skips it. selectionSize is global
                                    // but only affects the active-ring branch (size ≤ 1), so a
                                    // row not in range and not active won't visibly change.
                                    selStartCol={rowInRange && selRange ? selRange.startCol : -1}
                                    selEndCol={rowInRange && selRange ? selRange.endCol : -1}
                                    anchorColInRow={anchorCol}
                                    isDragActive={cellSelection.isDragging}
                                    selectionSize={activeColInRow >= 0 ? selectionSize : 0}
                                    updateRow={updateRow}
                                    handleSmartPaste={handleSmartPaste}
                                    handleCellMouseDown={handleCellMouseDown}
                                    handleCellMouseUp={handleCellMouseUp}
                                    handleCellMouseEnter={handleCellMouseEnter}
                                    startEditing={startEditing}
                                    revertChanges={revertChanges}
                                    setActiveCell={setActiveCell}
                                    setIsEditing={setIsEditing}
                                    onRowContextMenu={onRowContextMenu}
                                    gridRef={gridRef}
                                />
                            );
                        })}
                    </tbody>
                </table>
            </div>

            {/* Right-click context menu */}
            {contextMenu && (() => {
                const ctxRow = rows[contextMenu.rowIdx];
                if (!ctxRow) return null;
                const ctxIsDeleted = ctxRow._state === 'deleted';
                return (
                    <div
                        data-ctx-menu
                        className="fixed z-[9999] min-w-[188px] rounded-md border bg-popover/95 py-1 shadow-lg backdrop-blur-lg animate-fade-in"
                        style={{ left: contextMenu.x, top: contextMenu.y }}
                    >
                        <button
                            className="flex w-full cursor-pointer items-center gap-2 px-2.5 py-1.5 text-xs transition-colors duration-150 hover:bg-accent"
                            onClick={() => { insertRowAt(contextMenu.rowIdx, 0); setContextMenu(null); }}
                        >
                            <ArrowUpFromLine className="size-3.5 text-muted-foreground" />
                            <span>Insert Row Above</span>
                        </button>
                        <button
                            className="flex w-full cursor-pointer items-center gap-2 px-2.5 py-1.5 text-xs transition-colors duration-150 hover:bg-accent"
                            onClick={() => { insertRowAt(contextMenu.rowIdx, 1); setContextMenu(null); }}
                        >
                            <ArrowDownFromLine className="size-3.5 text-muted-foreground" />
                            <span>Insert Row Below</span>
                        </button>
                        <button
                            className="flex w-full cursor-pointer items-center gap-2 px-2.5 py-1.5 text-xs transition-colors duration-150 hover:bg-accent"
                            onClick={() => { duplicateRow(contextMenu.rowIdx); setContextMenu(null); }}
                        >
                            <Copy className="size-3.5 text-muted-foreground" />
                            <span>Duplicate Row</span>
                        </button>
                        <div className="my-1 border-t border-border/50" />
                        <button
                            className={cn(
                                'flex w-full cursor-pointer items-center gap-2 px-2.5 py-1.5 text-xs transition-colors duration-150',
                                ctxIsDeleted ? 'text-muted-foreground hover:bg-accent' : 'text-destructive hover:bg-destructive/10',
                            )}
                            onClick={() => {
                                if (ctxIsDeleted) restoreRow(contextMenu.rowIdx);
                                else markDeleted(contextMenu.rowIdx);
                                setContextMenu(null);
                            }}
                        >
                            {ctxIsDeleted ? (<><RotateCcw className="size-3.5" /><span>Restore Row</span></>) : (<><Trash2 className="size-3.5" /><span>Delete Row</span></>)}
                        </button>
                    </div>
                );
            })()}

            {/* CCC/FLEC typeahead — the single merged cell references this via `list=` so
                the operator can paste FLEC/C1/RK3 freely OR pick a suggestion. */}
            <datalist id="ledger-ccc-flec-suggestions">
                {CCC_FLEC_OPTIONS.map((o) => <option key={o} value={o} />)}
            </datalist>

            {/* Bulk Add modal — the fast multi-row entry path. Opens with a fresh 8-row
                sheet that takes Excel/Sheets paste; on success it refreshes the page data
                (via onSaveSuccess → router.refresh) so the new rows land in this grid. */}
            <BulkAddModal open={bulkAddOpen} onOpenChange={setBulkAddOpen} onInserted={onSaveSuccess} />
        </div>
    );
}
