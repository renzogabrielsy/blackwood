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
    Inbox,
    Sparkles,
} from 'lucide-react';
import { errorToast } from '@/lib/toast';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
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
    DISPOSITION_KINDS,
    DISPOSITION_LABELS,
    WHSE_SIDES,
    partnerEquipmentOptions,
    dispositionRequiresEquipment,
} from '../types';
import { saveProductionEvents, type ProductionEventDirtyRow } from './actions';
import { BulkAddModal } from './bulk-add-modal';

// ─── Editable fields ─────────────────────────────────────────────────────────────
// The 13 writable columns (id/unique_tag/batch_year are read-only/computed). Order
// here is informational; COL_MAP below pins the on-screen left→right geometry.
type GridField =
    | 'recv_date'
    | 'prod_date'
    | 'batch'
    | 'shift_code'
    | 'grade_code'
    | 'plant_code'
    | 'warehouse_code'
    | 'source_location_code'
    | 'disposition_kind'
    | 'partner_equipment_code'
    | 'weight_kg'
    | 'flec_count'
    | 'whse_side';

// ─── Column layout ───────────────────────────────────────────────────────────────
// col 0 = row#, not selectable/editable. All other columns are editable. Dropdown
// columns edit via a Select popover (not GridCell's F2/type-over). Date columns use
// DatePickerCell. Numeric/text columns use GridCell + <Input>.
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
    'disposition_kind',         // 9  (dropdown)
    'partner_equipment_code',   // 10 (dropdown, depends on disposition)
    'weight_kg',                // 11 (numeric)
    'flec_count',               // 12 (numeric int)
    'whse_side',                // 13 (dropdown, nullable)
];
const COL_COUNT = COL_MAP.length;

const NUMERIC_FIELDS = new Set<GridField>(['weight_kg', 'flec_count']);
const DROPDOWN_FIELDS = new Set<GridField>([
    'shift_code',
    'grade_code',
    'plant_code',
    'warehouse_code',
    'source_location_code',
    'disposition_kind',
    'partner_equipment_code',
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
    disposition_kind: string;
    partner_equipment_code: string;
    weight_kg: string;
    flec_count: string;
    whse_side: string;
    // Read-only/computed — shown but never edited or sent on save.
    batch_year: string;
}

// ─── DB → Grid conversion ────────────────────────────────────────────────────────
// PostgREST types all VIEW columns nullable; coalesce to '' for the string grid. The
// `id` is non-null at runtime (the upsert key) but typed nullable, so coalesce too.
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
        disposition_kind: r.disposition_kind ?? '',
        partner_equipment_code: r.partner_equipment_code ?? '',
        weight_kg: r.weight_kg != null ? String(r.weight_kg) : '',
        flec_count: r.flec_count != null ? String(r.flec_count) : '',
        whse_side: r.whse_side ?? '',
        batch_year: r.batch_year != null ? String(r.batch_year) : '',
    };
}

function buildGridRows(rows: ProductionEventRow[], sortDir: 'asc' | 'desc'): GridRow[] {
    const mapped = rows.map(toGridRow);
    return sortGridRows(mapped, sortDir);
}

// Stable sort by recv_date per the toggle, id as a deterministic tiebreaker.
function sortGridRows(rows: GridRow[], sortDir: 'asc' | 'desc'): GridRow[] {
    return [...rows].sort((a, b) => {
        const cmp = a.recv_date.localeCompare(b.recv_date);
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
        disposition_kind: '',
        partner_equipment_code: '',
        weight_kg: '',
        flec_count: '',
        whse_side: '',
        batch_year: '',
        ...overrides,
    };
}

// A new row counts as "real" (savable, dirty) once it carries any identifying data.
function isMeaningfulNewRow(r: GridRow): boolean {
    return Boolean(r.batch || r.weight_kg || r.grade_code || r.disposition_kind);
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
    'h-8 w-full px-1 border-transparent bg-transparent rounded-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-primary focus-visible:bg-accent/10 transition-colors shadow-none';

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
                    'truncate font-mono text-[11px] font-semibold tabular-nums',
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
    nullable,
    placeholder,
    disabled,
    disabledHint,
    align = 'start',
}: SelectCellProps) {
    const label = value ? (renderLabel ? renderLabel(value) : value) : '';
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
                    <span
                        className={cn(
                            'truncate font-mono text-xs',
                            value ? 'text-foreground' : 'text-muted-foreground/40',
                        )}
                    >
                        {label || (disabled ? '—' : placeholder ?? '—')}
                    </span>
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

// ─── Component props ─────────────────────────────────────────────────────────────
interface ProductionLedgerGridProps {
    initialRows: ProductionEventRow[];
    loadError: string | null;
    onSaveSuccess: () => void;
}

// ─── Main component ──────────────────────────────────────────────────────────────
export function ProductionLedgerGrid({
    initialRows,
    loadError,
    onSaveSuccess,
}: ProductionLedgerGridProps) {
    const gridRef = React.useRef<HTMLDivElement>(null);

    // Date sort — default newest-first (operators care about recent activity most).
    const [dateSortDir, setDateSortDir] = React.useState<'asc' | 'desc'>('desc');

    const [rows, setRows] = React.useState<GridRow[]>(() => [
        ...buildGridRows(initialRows, 'desc'),
        createEmptyRow(),
    ]);

    const [activeCell, setActiveCell] = React.useState<{ row: number; col: number } | null>(null);
    const [isEditing, setIsEditing] = React.useState(false);
    const [isSaving, setIsSaving] = React.useState(false);
    const [bulkAddOpen, setBulkAddOpen] = React.useState(false);
    const preEditValue = React.useRef<string>('');

    // Header filters — single-select; 'ALL' = no filter.
    const [shiftFilter, setShiftFilter] = React.useState('ALL');
    const [gradeFilter, setGradeFilter] = React.useState('ALL');
    const [dispositionFilter, setDispositionFilter] = React.useState('ALL');
    const [warehouseFilter, setWarehouseFilter] = React.useState('ALL');

    // ─── Re-sort the data rows when the date toggle changes (keep trailing empty) ──
    React.useEffect(() => {
        setRows((prev) => {
            const trailing = prev[prev.length - 1]?._state === 'new' && !isMeaningfulNewRow(prev[prev.length - 1])
                ? [prev[prev.length - 1]]
                : [];
            const dataRows = trailing.length > 0 ? prev.slice(0, -1) : prev;
            return [...sortGridRows(dataRows, dateSortDir), ...trailing];
        });
    }, [dateSortDir]);

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
            // Disposition copies as its human label so a copied range reads cleanly.
            if (field === 'disposition_kind') return DISPOSITION_LABELS[row.disposition_kind] ?? row.disposition_kind;
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

    const handleCellMouseDown = React.useCallback(
        (rowIdx: number, colIdx: number, e: React.MouseEvent) => {
            mouseDownCellRef.current = { row: rowIdx, col: colIdx };
            dragMovedRef.current = false;
            cellSelection.handleCellMouseDown(rowIdx, colIdx, e);
        },
        [cellSelection],
    );

    const handleCellMouseUp = React.useCallback(
        (rowIdx: number, colIdx: number) => {
            const down = mouseDownCellRef.current;
            mouseDownCellRef.current = null;
            if (down && down.row === rowIdx && down.col === colIdx && !dragMovedRef.current) {
                cellSelection.clearSelection();
                setActiveCell({ row: rowIdx, col: colIdx });
                setIsEditing(false);
                gridRef.current?.focus();
            }
            dragMovedRef.current = false;
        },
        [cellSelection],
    );

    const handleCellMouseEnter = React.useCallback(
        (rowIdx: number, colIdx: number) => {
            if (mouseDownCellRef.current) {
                dragMovedRef.current = true;
                cellSelection.handleCellMouseEnter(rowIdx, colIdx);
            }
        },
        [cellSelection],
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
            const row = { ...next[idx], [field]: value };
            if (row._state === 'existing') row._state = 'modified';

            // Disposition drives the equipment column: bagging clears equipment;
            // switching partner kind clears an equipment value no longer in range.
            if (field === 'disposition_kind') {
                const allowed = partnerEquipmentOptions(value);
                if (allowed.length === 0) {
                    row.partner_equipment_code = '';
                } else if (row.partner_equipment_code && !allowed.includes(row.partner_equipment_code)) {
                    row.partner_equipment_code = '';
                }
            }

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
    const startEditing = React.useCallback(
        (rowIdx: number, colIdx: number, initialChar?: string) => {
            const field = COL_MAP[colIdx];
            if (!field) return;
            // Dropdown + date columns aren't keyboard-typed — they open their own UI.
            if (DROPDOWN_FIELDS.has(field) || field === 'recv_date' || field === 'prod_date') return;
            const row = rows[rowIdx];
            if (!row) return;
            preEditValue.current = String(row[field] ?? '');
            setActiveCell({ row: rowIdx, col: colIdx });
            setIsEditing(true);
            if (initialChar !== undefined) updateRow(rowIdx, field, initialChar);
        },
        [rows, updateRow],
    );

    const revertChanges = React.useCallback(() => {
        if (!activeCell) return;
        const field = COL_MAP[activeCell.col];
        if (field) {
            setRows((prev) => {
                const next = [...prev];
                const row = { ...next[activeCell.row] };
                (row as Record<string, unknown>)[field] = preEditValue.current;
                if (row._state === 'modified' && row.id) row._state = 'existing';
                next[activeCell.row] = row;
                return next;
            });
        }
        setIsEditing(false);
        gridRef.current?.focus();
    }, [activeCell]);

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
                        (row as Record<string, unknown>)[field] = cleanPasteValue(cellVal, field);
                        // Re-derive equipment validity if disposition was pasted.
                        if (field === 'disposition_kind') {
                            const allowed = partnerEquipmentOptions(row.disposition_kind);
                            if (allowed.length === 0 || (row.partner_equipment_code && !allowed.includes(row.partner_equipment_code))) {
                                row.partner_equipment_code = '';
                            }
                        }
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
        setRows([...buildGridRows(initialRows, dateSortDir), createEmptyRow()]);
        setActiveCell(null);
        setIsEditing(false);
        cellSelection.clearSelection();
    }, [initialRows, dateSortDir, cellSelection]);

    // ─── Save ──────────────────────────────────────────────────────────────────────
    const handleSave = async () => {
        // Client-side validation: surface the partner-equipment CHECK BEFORE the
        // round-trip so the operator gets a clear, persistent, copyable message
        // instead of a cryptic Postgres constraint error.
        const invalid: string[] = [];
        for (const r of rows) {
            if (r._state === 'deleted') continue;
            if (r._state === 'new' && !isMeaningfulNewRow(r)) continue;
            if (dispositionRequiresEquipment(r.disposition_kind) && !r.partner_equipment_code.trim()) {
                const which = r.batch ? `batch ${r.batch}` : `${r.recv_date || 'undated'} row`;
                invalid.push(`${which} (${DISPOSITION_LABELS[r.disposition_kind] ?? r.disposition_kind})`);
            }
        }
        if (invalid.length > 0) {
            errorToast(
                `${invalid.length} row${invalid.length !== 1 ? 's' : ''} need a partner equipment before saving.`,
                {
                    description:
                        'Crusher and Kiln dispositions require an equipment code (C1–C4 / RK1–RK4). Set it, or change the disposition to Bag.\n\n' +
                        invalid.join('\n'),
                },
            );
            return;
        }

        const dirtyRows: ProductionEventDirtyRow[] = [];
        const deletedIds: string[] = [];

        for (const r of rows) {
            if (r._state === 'deleted') {
                if (r.id) deletedIds.push(r.id);
                continue;
            }
            if (r._state === 'new' && !isMeaningfulNewRow(r)) continue;
            if (r._state === 'existing') continue; // untouched

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
                disposition_kind: r.disposition_kind,
                partner_equipment_code: r.partner_equipment_code,
                flec_count: r.flec_count,
                whse_side: r.whse_side,
            });
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

    // ─── Cell helper props ─────────────────────────────────────────────────────────
    const selProps = (rowIdx: number, colIdx: number) => ({
        onCellMouseDown: (e: React.MouseEvent) => handleCellMouseDown(rowIdx, colIdx, e),
        onCellMouseUp: () => handleCellMouseUp(rowIdx, colIdx),
        onCellMouseEnter: () => handleCellMouseEnter(rowIdx, colIdx),
        isCellRangeSelected: cellSelection.isSelected(rowIdx, colIdx),
        isCellRangeAnchor: cellSelection.isAnchor(rowIdx, colIdx),
        isDragActive: cellSelection.isDragging,
    });

    const commonCellProps = {
        activeCell,
        isEditing,
        setActiveCell,
        setIsEditing,
        onStartEditing: startEditing,
        onRevert: revertChanges,
        gridRef,
    };

    // A wrapper cell for dropdown/date columns — handles selection visuals + the
    // active ring, but renders custom interactive children (Select/DatePicker) that
    // manage their own open/edit state. Mirrors the selection feedback of GridCell's
    // display mode without its F2/type-over edit path.
    const interactiveCellClass = (rowIdx: number, colIdx: number) =>
        cn(
            'relative h-full w-full',
            cellSelection.isSelected(rowIdx, colIdx) && 'bg-primary/10 dark:bg-primary/20',
            (activeCell?.row === rowIdx && activeCell?.col === colIdx && cellSelection.getSelectionSize() <= 1) &&
                'z-10 ring-2 ring-primary ring-inset',
            cellSelection.isAnchor(rowIdx, colIdx) && 'z-10 ring-2 ring-primary ring-inset',
        );

    // ─── Distinct filter options (derived from data; only present values appear) ────
    const { shiftOptions, gradeOptions, dispositionOptions, warehouseOptions } = React.useMemo(() => {
        const shifts = new Set<string>();
        const grades = new Set<string>();
        const dispositions = new Set<string>();
        const warehouses = new Set<string>();
        let hasUnplaced = false;
        for (const r of rows) {
            if (r._state === 'deleted' || (r._state === 'new' && !isMeaningfulNewRow(r))) continue;
            if (r.shift_code) shifts.add(r.shift_code);
            if (r.grade_code) grades.add(r.grade_code);
            if (r.disposition_kind) dispositions.add(r.disposition_kind);
            if (r.warehouse_code) warehouses.add(r.warehouse_code);
            else hasUnplaced = true;
        }
        const warehouseOpts = [...warehouses].sort().map((w) => ({ value: w, label: w }));
        if (hasUnplaced) warehouseOpts.push({ value: '__NULL__', label: '— Unplaced' });
        return {
            shiftOptions: [...shifts].sort().map((s) => ({ value: s, label: s })),
            gradeOptions: [...grades].sort().map((g) => ({ value: g, label: g })),
            dispositionOptions: [...dispositions].sort().map((d) => ({ value: d, label: DISPOSITION_LABELS[d] ?? d })),
            warehouseOptions: warehouseOpts,
        };
    }, [rows]);

    // ─── Per-row visibility under active filters (index-preserving HIDE) ───────────
    const isRowHidden = React.useCallback(
        (row: GridRow): boolean => {
            if (row._state === 'new' && !isMeaningfulNewRow(row)) return false; // keep the typing row
            if (shiftFilter !== 'ALL' && row.shift_code !== shiftFilter) return true;
            if (gradeFilter !== 'ALL' && row.grade_code !== gradeFilter) return true;
            if (dispositionFilter !== 'ALL' && row.disposition_kind !== dispositionFilter) return true;
            if (warehouseFilter !== 'ALL') {
                if (warehouseFilter === '__NULL__') {
                    if (row.warehouse_code !== '') return true;
                } else if (row.warehouse_code !== warehouseFilter) {
                    return true;
                }
            }
            return false;
        },
        [shiftFilter, gradeFilter, dispositionFilter, warehouseFilter],
    );

    const anyFilterActive =
        shiftFilter !== 'ALL' || gradeFilter !== 'ALL' || dispositionFilter !== 'ALL' || warehouseFilter !== 'ALL';

    const clearFilters = () => {
        setShiftFilter('ALL');
        setGradeFilter('ALL');
        setDispositionFilter('ALL');
        setWarehouseFilter('ALL');
    };

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
                <span className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                    Production Events
                </span>
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
                <table className="relative table-fixed text-xs" style={{ width: '100%', minWidth: '1280px', borderCollapse: 'separate', borderSpacing: 0 }}>
                    {/* col order: # / recv / prod / batch / shift / grade / plant / whse / source / disposition / equipment / weight / flec / side */}
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
                        <col style={{ width: '120px' }} />
                        <col style={{ width: '96px' }} />
                        <col style={{ width: '104px' }} />
                        <col style={{ width: '72px' }} />
                        <col style={{ width: '72px' }} />
                    </colgroup>
                    <thead className="sticky top-0 z-20 bg-muted/90 backdrop-blur-sm">
                        <tr className="border-b">
                            <th className="h-8 border-r border-border/40 px-1 text-center font-mono text-[10px] font-bold text-muted-foreground">#</th>
                            <th className="h-8 px-2 text-left text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Recv</th>
                            <th className="h-8 px-2 text-left text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Prod</th>
                            <th className="h-8 px-2 text-left text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Batch</th>
                            <th className="h-8 px-2 text-left text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                                <ColumnFilterMenu label="Shift" value={shiftFilter} options={shiftOptions} onChange={setShiftFilter} />
                            </th>
                            <th className="h-8 px-2 text-left text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                                <ColumnFilterMenu label="Grade" value={gradeFilter} options={gradeOptions} onChange={setGradeFilter} />
                            </th>
                            <th className="h-8 px-2 text-left text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Plant</th>
                            <th className="h-8 px-2 text-left text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                                <ColumnFilterMenu label="Whse" value={warehouseFilter} options={warehouseOptions} onChange={setWarehouseFilter} />
                            </th>
                            <th className="h-8 px-2 text-left text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Source</th>
                            <th className="h-8 px-2 text-left text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                                <ColumnFilterMenu label="Disp." value={dispositionFilter} options={dispositionOptions} onChange={setDispositionFilter} />
                            </th>
                            <th className="h-8 px-2 text-left text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Equip</th>
                            <th className="h-8 px-2 text-right text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Weight</th>
                            <th className="h-8 px-2 text-right text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Flec</th>
                            <th className="h-8 px-2 text-left text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Side</th>
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
                            const isDeleted = row._state === 'deleted';
                            const isModified = row._state === 'modified';
                            const isNew = row._state === 'new';
                            const isEmptyNew = isNew && !isMeaningfulNewRow(row);
                            const rowHidden = isRowHidden(row);
                            const equipOptions = partnerEquipmentOptions(row.disposition_kind);
                            const equipDisabled = !dispositionRequiresEquipment(row.disposition_kind);

                            return (
                                <tr
                                    key={row.id || `new-${rowIdx}`}
                                    hidden={rowHidden}
                                    className={cn(
                                        'group h-8 border-b border-border/30 transition-all duration-150 hover:bg-muted/50',
                                        rowHidden && 'hidden',
                                        isDeleted && 'line-through opacity-40',
                                        isModified && 'border-l-2 border-l-amber-400',
                                        isNew && !isEmptyNew && 'border-l-2 border-l-blue-400/50',
                                        contextMenu?.rowIdx === rowIdx && 'bg-accent/30',
                                    )}
                                    style={{ height: '32px' }}
                                    onContextMenu={(e) => {
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
                                    }}
                                >
                                    {/* Row number */}
                                    <td className="border-r border-border/30 px-1 text-center font-mono text-[10px] text-muted-foreground" style={{ height: '32px' }}>
                                        {isEmptyNew ? <span className="text-muted-foreground/30">—</span> : rowIdx + 1}
                                    </td>

                                    {/* Recv date (col 1) */}
                                    <td className="border-r border-border/30 p-0" style={{ height: '32px' }}>
                                        <DatePickerCell
                                            value={row.recv_date}
                                            onChange={(v) => updateRow(rowIdx, 'recv_date', v)}
                                            onPaste={(e) => { e.stopPropagation(); handleSmartPaste(e, rowIdx, 1); }}
                                            isActive={activeCell?.row === rowIdx && activeCell?.col === 1}
                                            isRangeSelected={cellSelection.isSelected(rowIdx, 1)}
                                            isRangeAnchor={cellSelection.isAnchor(rowIdx, 1)}
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
                                            isActive={activeCell?.row === rowIdx && activeCell?.col === 2}
                                            isRangeSelected={cellSelection.isSelected(rowIdx, 2)}
                                            isRangeAnchor={cellSelection.isAnchor(rowIdx, 2)}
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
                                            className="justify-start px-1 font-mono text-xs"
                                            displayValue={
                                                <span className="flex w-full items-center gap-1 truncate px-1">
                                                    <span className="truncate font-medium">{row.batch}</span>
                                                    {row.batch_year && <span className="font-mono text-[10px] text-muted-foreground/60">{row.batch_year}</span>}
                                                </span>
                                            }
                                            {...commonCellProps}
                                            {...selProps(rowIdx, 3)}
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
                                        <div className={interactiveCellClass(rowIdx, 4)}>
                                            <SelectCell value={row.shift_code} options={SHIFT_CODES} onChange={(v) => updateRow(rowIdx, 'shift_code', v)} placeholder="—" />
                                        </div>
                                    </td>

                                    {/* Grade (col 5) — dropdown */}
                                    <td className="border-r border-border/30 p-0" style={{ height: '32px' }}>
                                        <div className={interactiveCellClass(rowIdx, 5)}>
                                            <SelectCell value={row.grade_code} options={GRADE_CODES} onChange={(v) => updateRow(rowIdx, 'grade_code', v)} placeholder="—" />
                                        </div>
                                    </td>

                                    {/* Plant (col 6) — dropdown, nullable */}
                                    <td className="border-r border-border/30 p-0" style={{ height: '32px' }}>
                                        <div className={interactiveCellClass(rowIdx, 6)}>
                                            <SelectCell value={row.plant_code} options={PLANT_CODES} onChange={(v) => updateRow(rowIdx, 'plant_code', v)} nullable placeholder="—" />
                                        </div>
                                    </td>

                                    {/* Whse (col 7) — dropdown, nullable (null = unplaced) */}
                                    <td className="border-r border-border/30 p-0" style={{ height: '32px' }}>
                                        <div className={cn(interactiveCellClass(rowIdx, 7), row.warehouse_code === '' && !isEmptyNew && 'bg-amber-500/[0.04]')}>
                                            <SelectCell value={row.warehouse_code} options={WAREHOUSE_CODES} onChange={(v) => updateRow(rowIdx, 'warehouse_code', v)} nullable placeholder="unplaced" />
                                        </div>
                                    </td>

                                    {/* Source (col 8) — dropdown */}
                                    <td className="border-r border-border/30 p-0" style={{ height: '32px' }}>
                                        <div className={interactiveCellClass(rowIdx, 8)}>
                                            <SelectCell value={row.source_location_code} options={SOURCE_LOCATION_CODES} onChange={(v) => updateRow(rowIdx, 'source_location_code', v)} placeholder="—" />
                                        </div>
                                    </td>

                                    {/* Disposition (col 9) — dropdown (drives equipment) */}
                                    <td className="border-r border-border/30 p-0" style={{ height: '32px' }}>
                                        <div className={interactiveCellClass(rowIdx, 9)}>
                                            <SelectCell
                                                value={row.disposition_kind}
                                                options={DISPOSITION_KINDS}
                                                onChange={(v) => updateRow(rowIdx, 'disposition_kind', v)}
                                                renderLabel={(opt) => DISPOSITION_LABELS[opt] ?? opt}
                                                placeholder="—"
                                            />
                                        </div>
                                    </td>

                                    {/* Equipment (col 10) — dropdown, disabled for bagging */}
                                    <td className="border-r border-border/30 p-0" style={{ height: '32px' }}>
                                        <div className={interactiveCellClass(rowIdx, 10)}>
                                            <SelectCell
                                                value={row.partner_equipment_code}
                                                options={equipOptions}
                                                onChange={(v) => updateRow(rowIdx, 'partner_equipment_code', v)}
                                                disabled={equipDisabled}
                                                disabledHint="Bagging has no partner equipment"
                                                placeholder="—"
                                            />
                                        </div>
                                    </td>

                                    {/* Weight (col 11) — numeric, right-aligned */}
                                    <td className="border-r border-border/30 p-0" style={{ height: '32px' }}>
                                        <GridCell
                                            col={11}
                                            row={rowIdx}
                                            value={formatKg(row.weight_kg)}
                                            className="justify-end pr-1 font-mono tabular-nums"
                                            {...commonCellProps}
                                            {...selProps(rowIdx, 11)}
                                        >
                                            <Input
                                                autoFocus
                                                type="number"
                                                step="1"
                                                value={row.weight_kg}
                                                onChange={(e) => updateRow(rowIdx, 'weight_kg', e.target.value)}
                                                className={cn(inputClass, 'text-right font-mono text-xs')}
                                                onPaste={(e) => { e.stopPropagation(); handleSmartPaste(e, rowIdx, 11); }}
                                            />
                                        </GridCell>
                                    </td>

                                    {/* Flec (col 12) — numeric int, right-aligned */}
                                    <td className="border-r border-border/30 p-0" style={{ height: '32px' }}>
                                        <GridCell
                                            col={12}
                                            row={rowIdx}
                                            value={row.flec_count}
                                            className="justify-end pr-1 font-mono tabular-nums text-muted-foreground"
                                            {...commonCellProps}
                                            {...selProps(rowIdx, 12)}
                                        >
                                            <Input
                                                autoFocus
                                                type="number"
                                                step="1"
                                                value={row.flec_count}
                                                onChange={(e) => updateRow(rowIdx, 'flec_count', e.target.value)}
                                                className={cn(inputClass, 'text-right font-mono text-xs')}
                                                onPaste={(e) => { e.stopPropagation(); handleSmartPaste(e, rowIdx, 12); }}
                                            />
                                        </GridCell>
                                    </td>

                                    {/* Side (col 13) — dropdown, nullable */}
                                    <td className="p-0" style={{ height: '32px' }}>
                                        <div className={interactiveCellClass(rowIdx, 13)}>
                                            <SelectCell value={row.whse_side} options={WHSE_SIDES} onChange={(v) => updateRow(rowIdx, 'whse_side', v)} nullable placeholder="—" align="end" />
                                        </div>
                                    </td>
                                </tr>
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

            {/* Bulk Add modal — the fast multi-row entry path. Opens with a fresh 8-row
                sheet that takes Excel/Sheets paste; on success it refreshes the page data
                (via onSaveSuccess → router.refresh) so the new rows land in this grid. */}
            <BulkAddModal open={bulkAddOpen} onOpenChange={setBulkAddOpen} onInserted={onSaveSuccess} />
        </div>
    );
}
