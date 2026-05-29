'use client';

import * as React from 'react';
import { toast } from 'sonner';
import { format as formatDate, parseISO, isValid as isValidDate } from 'date-fns';
import { errorToast } from '@/lib/toast';
import { Save, RotateCcw, Calendar } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
} from '@/components/ui/table';
import { GridCell } from '@/components/shared/grid/GridCell';
import { useCellSelection } from '@/lib/hooks/use-cell-selection';
import { useClipboardCopy } from '@/lib/hooks/use-clipboard-copy';
import { useCellDelete } from '@/lib/hooks/use-cell-delete';
import { useCellAggregation, type AggregationType } from '@/lib/hooks/use-cell-aggregation';
import { useStatusBar } from '@/components/providers/status-bar-context';
import { parseExcelDate, trimCellValue } from '@/lib/paste-utils';
import { saveBulkTrucks } from './actions';
import type { Tables, TablesInsert, TablesUpdate } from '@/types/supabase';

type TruckReadingRow = Tables<'truck_readings'>;

// Canonical plate set — always present, in this fixed order. Any extra plate
// found in the data is appended after these (alphabetically) so columns stay
// stable on sparse data but new trucks still surface.
const KNOWN_PLATES = ['AAV 6111', 'KCA 378', 'FORKLIFT'] as const;

// Per-plate metric fields (editable). TTL is computed (end − start) and never written.
type MetricField = 'start_km' | 'end_km' | 'fuel_liters';

// ─── Column geometry ───────────────────────────────────────────────────────────
// Col 0 = DATE (frozen). Then each plate contributes 4 columns:
//   [start_km, end_km, ttl_km (computed/null), fuel_liters]
// SUBCOLS_PER_PLATE = 4. The TTL column (offset 2) is computed → null in COL_MAP.
const SUBCOLS_PER_PLATE = 4;
const DATE_COL_WIDTH = 96;
const SUBCOL_WIDTH = 72;

interface PlateColumn {
    plate: string;
    /** First column index for this plate group (the START KM subcolumn). */
    startCol: number;
    /** Left offset (px) of the group — used only for the (frozen) DATE measure. */
}

/** A single editable cell address inside a plate group. */
interface CellAddr {
    plate: string;
    field: MetricField;
}

// ─── Row model ───────────────────────────────────────────────────────────────
// One grid row per reading_date. Each row holds, per plate, the editable values
// plus the originating DB row id (if any) so saves can update-by-id.
type RowDirtyState = 'existing' | 'new' | 'modified' | 'deleted';

interface PlateCell {
    _id?: string;        // truck_reading id (undefined → insert)
    start_km: string;
    end_km: string;
    fuel_liters: string;
    remarks: string;     // preserved across edits (not shown as a column)
    _dirty: boolean;     // this plate-cell was touched
}

interface GridRow {
    _state: RowDirtyState;
    reading_date: string;
    /** plate_no → values for that truck on this date */
    cells: Record<string, PlateCell>;
}

function emptyPlateCell(): PlateCell {
    return { start_km: '', end_km: '', fuel_liters: '', remarks: '', _dirty: false };
}

function dbRowToPlateCell(r: TruckReadingRow): PlateCell {
    return {
        _id: r.id,
        start_km: r.start_km != null ? String(r.start_km) : '',
        end_km: r.end_km != null ? String(r.end_km) : '',
        fuel_liters: r.fuel_liters != null ? String(r.fuel_liters) : '',
        remarks: r.remarks ?? '',
        _dirty: false,
    };
}

function createEmptyRow(plates: string[]): GridRow {
    const cells: Record<string, PlateCell> = {};
    for (const p of plates) cells[p] = emptyPlateCell();
    return {
        _state: 'new',
        reading_date: new Date().toISOString().split('T')[0],
        cells,
    };
}

// ─── Derive the stable plate column set ────────────────────────────────────────
function derivePlates(data: TruckReadingRow[]): string[] {
    const known = new Set<string>(KNOWN_PLATES);
    const extras = new Set<string>();
    for (const r of data) {
        const p = r.plate_no?.trim();
        if (!p) continue;
        if (!known.has(p)) extras.add(p);
    }
    return [...KNOWN_PLATES, ...[...extras].sort((a, b) => a.localeCompare(b))];
}

// ─── DB rows → pivoted grid rows ───────────────────────────────────────────────
function buildGridRows(data: TruckReadingRow[], plates: string[]): GridRow[] {
    // Group by reading_date
    const byDate = new Map<string, GridRow>();
    const order: string[] = [];

    for (const r of data) {
        const date = r.reading_date ?? '';
        if (!date) continue;
        let row = byDate.get(date);
        if (!row) {
            const cells: Record<string, PlateCell> = {};
            for (const p of plates) cells[p] = emptyPlateCell();
            row = { _state: 'existing', reading_date: date, cells };
            byDate.set(date, row);
            order.push(date);
        }
        const plate = r.plate_no?.trim();
        if (plate && row.cells[plate]) {
            // If two readings share (date, plate), last write wins — shouldn't
            // happen given the natural key, but stay defensive.
            row.cells[plate] = dbRowToPlateCell(r);
        }
    }

    // Server already orders by reading_date DESC; preserve insertion order.
    return order.map(d => byDate.get(d)!);
}

// ─── Paste cleaning ────────────────────────────────────────────────────────────
function cleanPasteValue(raw: string, isDate: boolean): string {
    const val = trimCellValue(raw);
    if (isDate) return parseExcelDate(val);
    return val.replace(/[₱,"']/g, '');
}

// ─── Numeric formatter (thousand separators, no decimals unless fractional) ─────
function formatNum(value: number | string | null | undefined): string {
    if (value === null || value === undefined || value === '') return '';
    const n = typeof value === 'string' ? parseFloat(value) : value;
    if (isNaN(n)) return '';
    const hasFraction = Math.abs(n % 1) > 1e-9;
    return n.toLocaleString('en-US', {
        minimumFractionDigits: 0,
        maximumFractionDigits: hasFraction ? 2 : 0,
    });
}

// ─── Date display helper ──────────────────────────────────────────────────────
function formatDateShort(iso: string): string {
    if (!iso) return '';
    const parsed = parseISO(iso);
    if (!isValidDate(parsed)) return iso;
    return formatDate(parsed, 'MMM d');
}

const inputClass =
    'h-8 w-full px-1 border-transparent bg-transparent rounded-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-primary focus-visible:bg-accent/10 transition-colors shadow-none';

// ─── DatePickerCell (mirrors daily ledger) ─────────────────────────────────────
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
}: DatePickerCellProps) {
    const inputRef = React.useRef<HTMLInputElement>(null);
    return (
        <div
            data-date-cell
            className={cn(
                'group/date relative h-full w-full flex items-center justify-between gap-1 px-1 cursor-pointer select-none',
                'border border-dashed border-border/40 hover:border-blue-500/60 hover:bg-blue-500/5 transition-colors',
                isActive && !isRangeSelected && 'ring-2 ring-primary ring-inset z-10 border-transparent',
                isRangeSelected && 'bg-primary/10 dark:bg-primary/20',
                isRangeAnchor && 'ring-2 ring-primary ring-inset z-10 border-transparent'
            )}
            style={{ minHeight: '100%' }}
            onMouseDown={onCellMouseDown}
            onMouseUp={onCellMouseUp}
            onMouseEnter={onCellMouseEnter}
            onClick={(e) => {
                e.stopPropagation();
                if (inputRef.current) {
                    if (typeof inputRef.current.showPicker === 'function') {
                        try { inputRef.current.showPicker(); } catch { inputRef.current.focus(); }
                    } else {
                        inputRef.current.focus();
                    }
                }
            }}
        >
            <span className="font-mono font-semibold text-[11px] tabular-nums text-foreground truncate">
                {formatDateShort(value)}
            </span>
            <Calendar className="w-3 h-3 text-muted-foreground/70 group-hover/date:text-blue-500 transition-colors flex-none" />
            <input
                ref={inputRef}
                type="date"
                value={value}
                onChange={(e) => onChange(e.target.value)}
                onPaste={onPaste}
                onMouseDown={(e) => e.stopPropagation()}
                onClick={(e) => e.stopPropagation()}
                className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
                tabIndex={-1}
                aria-label="Select date"
            />
        </div>
    );
}

interface TrucksGridProps {
    initialData: TruckReadingRow[];
    onSaveSuccess: () => void;
}

export function TrucksGrid({ initialData, onSaveSuccess }: TrucksGridProps) {
    const { setCellSelectionCount, setCellAggregates } = useStatusBar();
    const gridRef = React.useRef<HTMLDivElement>(null);

    // Plate columns are derived once from the initial data — stable for the
    // lifetime of this grid instance (the parent remounts on refetch).
    const plates = React.useMemo(() => derivePlates(initialData), [initialData]);

    // Build the COL_MAP: index 0 = DATE, then [start, end, ttl(null), fuel] per plate.
    // Returns the editable cell address (or null for DATE/computed cols).
    const colCount = 1 + plates.length * SUBCOLS_PER_PLATE;

    const colAddr = React.useCallback(
        (col: number): { kind: 'date' } | { kind: 'ttl'; plate: string } | { kind: 'cell'; addr: CellAddr } | null => {
            if (col === 0) return { kind: 'date' };
            const rel = col - 1;
            const plateIdx = Math.floor(rel / SUBCOLS_PER_PLATE);
            const sub = rel % SUBCOLS_PER_PLATE;
            const plate = plates[plateIdx];
            if (!plate) return null;
            if (sub === 0) return { kind: 'cell', addr: { plate, field: 'start_km' } };
            if (sub === 1) return { kind: 'cell', addr: { plate, field: 'end_km' } };
            if (sub === 2) return { kind: 'ttl', plate };
            return { kind: 'cell', addr: { plate, field: 'fuel_liters' } };
        },
        [plates]
    );

    const plateColumns = React.useMemo<PlateColumn[]>(
        () => plates.map((plate, i) => ({ plate, startCol: 1 + i * SUBCOLS_PER_PLATE })),
        [plates]
    );

    const [rows, setRows] = React.useState<GridRow[]>(() => {
        const base = buildGridRows(initialData, plates);
        return [...base, createEmptyRow(plates)];
    });

    const [activeCell, setActiveCell] = React.useState<{ row: number; col: number } | null>(null);
    const [isEditing, setIsEditing] = React.useState(false);
    const [isSaving, setIsSaving] = React.useState(false);
    const preEditValue = React.useRef<string>('');

    // ─── Cell selection ───────────────────────────────────────────────────────
    const isSelectableColumn = React.useCallback(
        (c: number) => {
            if (c === 0) return false; // DATE — not part of numeric selection
            // TTL columns (computed) remain draggable for COUNT/SUM aggregation.
            return true;
        },
        []
    );

    const cellSelection = useCellSelection({
        rowCount: rows.length,
        colCount,
        isSelectableColumn,
        scrollContainerRef: gridRef,
        enabled: true,
    });

    // ─── Cell value accessors ───────────────────────────────────────────────────
    const getCellValue = React.useCallback(
        (rowIdx: number, colIdx: number): string => {
            const row = rows[rowIdx];
            if (!row) return '';
            const a = colAddr(colIdx);
            if (!a) return '';
            if (a.kind === 'date') return row.reading_date;
            if (a.kind === 'ttl') {
                const cell = row.cells[a.plate];
                if (!cell) return '';
                const km = (parseFloat(cell.end_km) || 0) - (parseFloat(cell.start_km) || 0);
                return km > 0 ? String(km) : '';
            }
            const cell = row.cells[a.addr.plate];
            return cell ? String(cell[a.addr.field] ?? '') : '';
        },
        [rows, colAddr]
    );

    const getNumericCellValue = React.useCallback(
        (rowIdx: number, colIdx: number): number | null => {
            const a = colAddr(colIdx);
            if (!a || a.kind === 'date') return null;
            const v = parseFloat(getCellValue(rowIdx, colIdx));
            return isNaN(v) ? null : v;
        },
        [colAddr, getCellValue]
    );

    const getColumnDefaultCalcType = React.useCallback(
        (colIdx: number): AggregationType | null => {
            const a = colAddr(colIdx);
            if (!a || a.kind === 'date') return null;
            return 'SUM';
        },
        [colAddr]
    );

    const aggregates = useCellAggregation({ range: cellSelection.range, getNumericCellValue, getColumnDefaultCalcType });

    const selectionSize = cellSelection.range ? cellSelection.getSelectionSize() : 0;

    React.useEffect(() => {
        const timer = setTimeout(() => {
            setCellSelectionCount(selectionSize);
            setCellAggregates(selectionSize > 1 ? aggregates : null);
        }, 50);
        return () => clearTimeout(timer);
    }, [selectionSize, aggregates, setCellSelectionCount, setCellAggregates]);

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

    const handleCellMouseDown = React.useCallback((rowIdx: number, colIdx: number, e: React.MouseEvent) => {
        mouseDownCellRef.current = { row: rowIdx, col: colIdx };
        dragMovedRef.current = false;
        cellSelection.handleCellMouseDown(rowIdx, colIdx, e);
    }, [cellSelection]);

    const handleCellMouseUp = React.useCallback((rowIdx: number, colIdx: number) => {
        const down = mouseDownCellRef.current;
        mouseDownCellRef.current = null;
        if (down && down.row === rowIdx && down.col === colIdx && !dragMovedRef.current) {
            cellSelection.clearSelection();
            setActiveCell({ row: rowIdx, col: colIdx });
            setIsEditing(false);
            gridRef.current?.focus();
        }
        dragMovedRef.current = false;
    }, [cellSelection]);

    const handleCellMouseEnter = React.useCallback((rowIdx: number, colIdx: number) => {
        if (mouseDownCellRef.current) {
            dragMovedRef.current = true;
            cellSelection.handleCellMouseEnter(rowIdx, colIdx);
        }
    }, [cellSelection]);

    // ─── Row mutation helpers ───────────────────────────────────────────────────
    const ensureTrailingRow = (next: GridRow[]) => {
        const last = next[next.length - 1];
        if (!last || last._state !== 'new') next.push(createEmptyRow(plates));
        return next;
    };

    const updateDate = React.useCallback((idx: number, value: string) => {
        setRows(prev => {
            const next = [...prev];
            const row = { ...next[idx], reading_date: value };
            if (row._state === 'existing') row._state = 'modified';
            next[idx] = row;
            return ensureTrailingRow(next);
        });
    // ensureTrailingRow closes over `plates` which is stable per instance
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [plates]);

    const updateCell = React.useCallback((idx: number, addr: CellAddr, value: string) => {
        setRows(prev => {
            const next = [...prev];
            const row = { ...next[idx] };
            const cells = { ...row.cells };
            const cell = { ...(cells[addr.plate] ?? emptyPlateCell()), [addr.field]: value, _dirty: true };
            cells[addr.plate] = cell;
            row.cells = cells;
            if (row._state === 'existing') row._state = 'modified';
            next[idx] = row;
            return ensureTrailingRow(next);
        });
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [plates]);

    const clearCell = React.useCallback((rowIdx: number, colIdx: number) => {
        const a = colAddr(colIdx);
        if (!a) return;
        if (a.kind === 'cell') updateCell(rowIdx, a.addr, '');
        // DATE/TTL are not clearable via cell-delete
    }, [colAddr, updateCell]);

    const { handleKeyDown: handleDeleteKeyDown } = useCellDelete({
        getSelectedRange: cellSelection.getSelectedRange,
        getSelectionSize: cellSelection.getSelectionSize,
        clearCell,
    });

    // ─── Editing ────────────────────────────────────────────────────────────────
    const startEditing = React.useCallback((rowIdx: number, colIdx: number, initialChar?: string) => {
        const a = colAddr(colIdx);
        if (!a || a.kind === 'ttl') return; // TTL is read-only (computed)
        if (a.kind === 'date') {
            // DATE has its own always-on native picker — selecting the cell is
            // enough; never enter text-edit mode (a stray keystroke would have
            // nowhere to go and would strand isEditing=true).
            setActiveCell({ row: rowIdx, col: colIdx });
            setIsEditing(false);
            return;
        }
        const row = rows[rowIdx];
        const cell = row?.cells[a.addr.plate];
        preEditValue.current = cell ? String(cell[a.addr.field] ?? '') : '';
        setActiveCell({ row: rowIdx, col: colIdx });
        setIsEditing(true);
        if (initialChar !== undefined) updateCell(rowIdx, a.addr, initialChar);
    }, [rows, colAddr, updateCell]);

    const revertChanges = React.useCallback(() => {
        if (!activeCell) return;
        const a = colAddr(activeCell.col);
        if (a && a.kind === 'cell') {
            const addr = a.addr;
            const restore = preEditValue.current;
            setRows(prev => {
                const next = [...prev];
                const row = { ...next[activeCell.row] };
                const cells = { ...row.cells };
                const prevCell = cells[addr.plate] ?? emptyPlateCell();
                // Restore the field to its pre-edit value. We intentionally keep
                // the row's `modified` state and the cell's `_dirty` flag as-is:
                // reverting a single keystroke shouldn't un-dirty a row that the
                // user may have edited elsewhere. Discard is the full reset path.
                cells[addr.plate] = { ...prevCell, [addr.field]: restore };
                row.cells = cells;
                next[activeCell.row] = row;
                return next;
            });
        }
        setIsEditing(false);
        gridRef.current?.focus();
    }, [activeCell, colAddr]);

    const moveActive = React.useCallback((key: string, shift: boolean) => {
        if (!activeCell) return;
        let { row, col } = activeCell;
        if (key === 'ArrowUp' || (key === 'Enter' && shift)) row = Math.max(0, row - 1);
        else if (key === 'ArrowDown' || (key === 'Enter' && !shift)) row = Math.min(rows.length - 1, row + 1);
        else if (key === 'ArrowLeft') { col = Math.max(0, col - 1); }
        else if (key === 'ArrowRight') { col = Math.min(colCount - 1, col + 1); }
        else if (key === 'Tab') {
            if (shift) {
                col--;
                if (col < 0) { row = Math.max(0, row - 1); col = colCount - 1; }
            } else {
                col++;
                if (col >= colCount) { row = Math.min(rows.length - 1, row + 1); col = 0; }
            }
        } else if (key === 'Home') col = 0;
        else if (key === 'End') col = colCount - 1;
        // Every column is navigable: DATE (picker), the editable metric cells,
        // and the read-only computed TTL columns. No columns are skipped.
        setActiveCell({ row, col });
    }, [activeCell, rows.length, colCount]);

    const handleGridKeyDown = React.useCallback((e: React.KeyboardEvent) => {
        if (!activeCell) return;
        const isRangeSelected = cellSelection.getSelectionSize() > 1;
        if (isEditing) {
            if (e.key === 'Escape') {
                e.preventDefault(); e.stopPropagation(); e.nativeEvent.stopImmediatePropagation();
                revertChanges();
            } else if (e.key === 'Enter' || e.key === 'Tab') {
                e.preventDefault(); setIsEditing(false); moveActive(e.key, e.shiftKey); gridRef.current?.focus();
            }
            return;
        }
        if (isRangeSelected) {
            if (e.shiftKey && ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key)) { e.preventDefault(); cellSelection.handleKeyDown(e); return; }
            if ((e.metaKey || e.ctrlKey) && e.key === 'c') { handleCopyKeyDown(e); return; }
            if (e.key === 'Backspace' || e.key === 'Delete') { handleDeleteKeyDown(e); cellSelection.clearSelection(); return; }
            if (e.key === 'Escape') { e.preventDefault(); cellSelection.clearSelection(); return; }
            if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Tab', 'Enter'].includes(e.key)) cellSelection.clearSelection();
            if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
                const range = cellSelection.range;
                if (range) { cellSelection.clearSelection(); setActiveCell({ row: range.startRow, col: range.startCol }); }
            }
        }
        if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Tab', 'Enter', 'Home', 'End'].includes(e.key)) {
            e.preventDefault();
            if (e.shiftKey && ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key) && !isRangeSelected) {
                cellSelection.handleCellMouseDown(activeCell.row, activeCell.col, { shiftKey: false, button: 0, preventDefault: () => {} } as unknown as React.MouseEvent);
                cellSelection.handleMouseUp(); cellSelection.handleKeyDown(e); return;
            }
            moveActive(e.key, e.shiftKey); return;
        }
        if (e.key === 'F2') { e.preventDefault(); startEditing(activeCell.row, activeCell.col); return; }
        if (e.key === 'Backspace' || e.key === 'Delete') { e.preventDefault(); startEditing(activeCell.row, activeCell.col, ''); return; }
        if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) { e.preventDefault(); startEditing(activeCell.row, activeCell.col, e.key); }
    }, [activeCell, isEditing, cellSelection, handleCopyKeyDown, handleDeleteKeyDown, revertChanges, moveActive, startEditing]);

    // ─── Smart paste ──────────────────────────────────────────────────────────
    const handleSmartPaste = React.useCallback((e: React.ClipboardEvent, startRow: number, startCol: number) => {
        e.preventDefault();
        const text = e.clipboardData.getData('text');
        if (!text) return;
        const pastedRows = text.split(/\r\n|\n|\r/).filter(r => r.trim() !== '');
        if (!pastedRows.length) return;
        setRows(prev => {
            const next = [...prev];
            pastedRows.forEach((pastedRow, rOffset) => {
                const targetRow = startRow + rOffset;
                if (targetRow >= next.length) next.push(createEmptyRow(plates));
                const cols = pastedRow.split('\t');
                const row = { ...next[targetRow] };
                const cells = { ...row.cells };
                cols.forEach((cellVal, cOffset) => {
                    const targetCol = startCol + cOffset;
                    if (targetCol >= colCount) return;
                    const a = colAddr(targetCol);
                    if (!a) return;
                    if (a.kind === 'date') {
                        row.reading_date = cleanPasteValue(cellVal, true);
                    } else if (a.kind === 'cell') {
                        const cur = { ...(cells[a.addr.plate] ?? emptyPlateCell()) };
                        (cur as Record<string, unknown>)[a.addr.field] = cleanPasteValue(cellVal, false);
                        cur._dirty = true;
                        cells[a.addr.plate] = cur;
                    }
                    // TTL columns are skipped (computed)
                });
                row.cells = cells;
                if (row._state === 'existing') row._state = 'modified';
                next[targetRow] = row;
            });
            return ensureTrailingRow(next);
        });
        toast.success(`Pasted ${pastedRows.length} row${pastedRows.length !== 1 ? 's' : ''}`);
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [plates, colCount, colAddr]);

    const handleGridPaste = React.useCallback((e: React.ClipboardEvent) => {
        if (!isEditing && activeCell) { handleSmartPaste(e, activeCell.row, activeCell.col); cellSelection.clearSelection(); }
    }, [isEditing, activeCell, handleSmartPaste, cellSelection]);

    // ─── Dirty tracking ─────────────────────────────────────────────────────────
    const isDirty = rows.some(r => {
        if (r._state === 'deleted' || r._state === 'modified') return true;
        if (r._state === 'new') {
            return Object.values(r.cells).some(c => c.start_km || c.end_km || c.fuel_liters);
        }
        return false;
    });

    const handleDiscard = React.useCallback(() => {
        const base = buildGridRows(initialData, plates);
        setRows([...base, createEmptyRow(plates)]);
        setActiveCell(null);
        setIsEditing(false);
    }, [initialData, plates]);

    // ─── Save: group dirty (date, plate) cells → upsert per (date, plate) ────────
    const handleSave = async () => {
        setIsSaving(true);
        try {
            const inserts: TablesInsert<'truck_readings'>[] = [];
            const updates: { id: string; data: TablesUpdate<'truck_readings'> }[] = [];

            for (const row of rows) {
                if (row._state === 'deleted' || row._state === 'existing') continue;
                if (!row.reading_date) continue;

                for (const plate of plates) {
                    const cell = row.cells[plate];
                    if (!cell) continue;

                    // A (date, plate) is persisted only if it has at least one
                    // non-empty value. Existing cells with an id always re-save
                    // when their row is dirty (so cleared values reach the DB).
                    const hasValue = !!(cell.start_km || cell.end_km || cell.fuel_liters);
                    const wasTouched = cell._dirty;

                    if (cell._id) {
                        // Existing reading — update only if this cell was touched.
                        if (!wasTouched) continue;
                        updates.push({
                            id: cell._id,
                            data: {
                                reading_date: row.reading_date,
                                plate_no: plate,
                                start_km: parseFloat(cell.start_km) || 0,
                                end_km: parseFloat(cell.end_km) || 0,
                                fuel_liters: cell.fuel_liters ? parseFloat(cell.fuel_liters) : null,
                                remarks: cell.remarks || null,
                            },
                        });
                    } else if (hasValue) {
                        // No existing row — insert a new reading for this (date, plate).
                        inserts.push({
                            reading_date: row.reading_date,
                            plate_no: plate,
                            start_km: parseFloat(cell.start_km) || 0,
                            end_km: parseFloat(cell.end_km) || 0,
                            fuel_liters: cell.fuel_liters ? parseFloat(cell.fuel_liters) : null,
                            remarks: cell.remarks || null,
                        });
                    }
                }
            }

            if (!inserts.length && !updates.length) {
                toast.info('No changes to save.');
                setIsSaving(false);
                return;
            }

            const res = await saveBulkTrucks({ inserts, updates, deletes: [] });
            if (!res.ok) {
                errorToast(res.error);
            } else {
                const parts: string[] = [];
                if (res.insertedCount) parts.push(`${res.insertedCount} added`);
                if (res.updatedCount) parts.push(`${res.updatedCount} updated`);
                toast.success(parts.length ? `Saved — ${parts.join(', ')}` : 'Saved');
                onSaveSuccess();
            }
        } catch (err) {
            errorToast('Unexpected error: ' + (err instanceof Error ? err.message : String(err)));
        } finally {
            setIsSaving(false);
        }
    };

    // ─── Render helpers ──────────────────────────────────────────────────────────
    const selProps = (rowIdx: number, colIdx: number) => ({
        onCellMouseDown: (e: React.MouseEvent) => handleCellMouseDown(rowIdx, colIdx, e),
        onCellMouseUp: () => handleCellMouseUp(rowIdx, colIdx),
        onCellMouseEnter: () => handleCellMouseEnter(rowIdx, colIdx),
        isCellRangeSelected: cellSelection.isSelected(rowIdx, colIdx),
        isCellRangeAnchor: cellSelection.isAnchor(rowIdx, colIdx),
        isDragActive: cellSelection.isDragging,
    });

    const commonCellProps = { activeCell, isEditing, setActiveCell, setIsEditing, onStartEditing: startEditing, onRevert: revertChanges, gridRef };

    const dataRowCount = rows.filter(r => r._state !== 'new').length;
    // Total table width: DATE + all plate subcolumns.
    const tableMinWidth = DATE_COL_WIDTH + plates.length * SUBCOLS_PER_PLATE * SUBCOL_WIDTH;

    return (
        <div className="flex flex-col gap-0">
            {/* Toolbar */}
            <div className="flex items-center justify-between px-2 py-1 border-b bg-muted/20">
                <span className="text-[10px] text-muted-foreground uppercase tracking-wide">
                    {dataRowCount} day{dataRowCount !== 1 ? 's' : ''} · {plates.length} truck{plates.length !== 1 ? 's' : ''}
                </span>
                <div className="flex items-center gap-1">
                    {isDirty && (
                        <Button variant="ghost" size="sm" className="h-6 px-2 text-xs gap-1" onClick={handleDiscard} disabled={isSaving}>
                            <RotateCcw className="h-3 w-3" />
                            Discard
                        </Button>
                    )}
                    <Button size="sm" className="h-6 px-2 text-xs gap-1" onClick={handleSave} disabled={isSaving || !isDirty}>
                        <Save className="h-3 w-3" />
                        {isSaving ? 'Saving…' : 'Save'}
                    </Button>
                </div>
            </div>

            <div
                ref={gridRef}
                className="outline-none select-none overflow-auto relative max-h-[60vh]"
                tabIndex={-1}
                onKeyDown={handleGridKeyDown}
                onPaste={handleGridPaste}
                onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget)) { setActiveCell(null); setIsEditing(false); } }}
            >
                <table className="table-fixed text-xs relative" style={{ width: '100%', minWidth: `${tableMinWidth}px`, borderCollapse: 'separate', borderSpacing: 0 }}>
                    {/* Explicit column widths — pins layout for the sticky DATE column. */}
                    <colgroup>
                        <col style={{ width: `${DATE_COL_WIDTH}px` }} />
                        {plates.map(p => (
                            <React.Fragment key={p}>
                                <col style={{ width: `${SUBCOL_WIDTH}px` }} />
                                <col style={{ width: `${SUBCOL_WIDTH}px` }} />
                                <col style={{ width: `${SUBCOL_WIDTH}px` }} />
                                <col style={{ width: `${SUBCOL_WIDTH}px` }} />
                            </React.Fragment>
                        ))}
                    </colgroup>

                    <TableHeader className="bg-muted backdrop-blur-sm sticky top-0 z-50 shadow-sm">
                        {/* Header row 1 — group labels. DATE spans both header rows. */}
                        <TableRow className="hover:bg-transparent border-b border-foreground/10" style={{ height: '22px' }}>
                            <TableHead
                                rowSpan={2}
                                className="h-auto px-1 py-0 font-mono font-bold text-center text-[10px] border-r border-foreground/20 bg-muted sticky z-40 shadow-[2px_0_4px_rgba(0,0,0,0.12)] align-middle"
                                style={{ left: 0 }}
                            >
                                DATE
                            </TableHead>
                            {plateColumns.map(({ plate }, i) => (
                                <TableHead
                                    key={plate}
                                    colSpan={SUBCOLS_PER_PLATE}
                                    className={cn(
                                        'h-5 px-1 py-0 font-mono font-bold text-center text-[10px] bg-muted uppercase tracking-widest text-blue-600 dark:text-blue-400',
                                        i < plateColumns.length - 1 && 'border-r border-foreground/20'
                                    )}
                                >
                                    {plate}
                                </TableHead>
                            ))}
                        </TableRow>
                        {/* Header row 2 — subcolumn labels per plate group. */}
                        <TableRow className="hover:bg-transparent border-b border-foreground/20" style={{ height: '24px' }}>
                            {plateColumns.map(({ plate }, i) => {
                                const lastGroup = i === plateColumns.length - 1;
                                return (
                                    <React.Fragment key={plate}>
                                        <TableHead className="h-6 px-1 py-0 font-mono font-bold text-right text-[9px] border-r border-foreground/10 bg-muted text-muted-foreground">START</TableHead>
                                        <TableHead className="h-6 px-1 py-0 font-mono font-bold text-right text-[9px] border-r border-foreground/10 bg-muted text-muted-foreground">END</TableHead>
                                        <TableHead className="h-6 px-1 py-0 font-mono font-bold text-right text-[9px] border-r border-foreground/10 bg-muted text-muted-foreground/80">TTL</TableHead>
                                        <TableHead className={cn('h-6 px-1 py-0 font-mono font-bold text-right text-[9px] bg-muted text-muted-foreground', !lastGroup && 'border-r border-foreground/20')}>FUEL</TableHead>
                                    </React.Fragment>
                                );
                            })}
                        </TableRow>
                    </TableHeader>

                    <TableBody>
                        {rows.length === 1 && rows[0]._state === 'new' && (
                            <TableRow className="hover:bg-transparent">
                                <TableCell colSpan={colCount} className="py-8 text-center">
                                    <p className="text-xs text-muted-foreground animate-fade-up">
                                        Awaiting Production Manager sync. Start typing in the empty row, or paste a range from Excel.
                                    </p>
                                </TableCell>
                            </TableRow>
                        )}
                        {rows.map((row, rowIdx) => {
                            const isDirtyRow = row._state === 'modified';
                            const dateCol = 0;

                            return (
                                <TableRow
                                    key={rowIdx}
                                    className={cn(
                                        'group transition-colors duration-150 border-b border-border/30 hover:bg-muted/50',
                                        isDirtyRow && 'border-l-2 border-l-amber-400'
                                    )}
                                    style={{ height: '28px' }}
                                >
                                    {/* ── DATE — frozen sticky col 0, last (only) frozen col → separator shadow ── */}
                                    <TableCell
                                        className="px-0 py-0 border-r border-border/30 bg-background group-hover:bg-muted/50 transition-colors duration-150 sticky z-30 shadow-[2px_0_4px_rgba(0,0,0,0.12)]"
                                        style={{ height: '28px', left: 0 }}
                                    >
                                        <DatePickerCell
                                            value={row.reading_date}
                                            onChange={(v) => updateDate(rowIdx, v)}
                                            onPaste={(e) => { e.stopPropagation(); handleSmartPaste(e, rowIdx, dateCol); }}
                                            isActive={activeCell?.row === rowIdx && activeCell?.col === dateCol}
                                            isRangeSelected={cellSelection.isSelected(rowIdx, dateCol)}
                                            isRangeAnchor={cellSelection.isAnchor(rowIdx, dateCol)}
                                            onCellMouseDown={(e) => handleCellMouseDown(rowIdx, dateCol, e)}
                                            onCellMouseUp={() => handleCellMouseUp(rowIdx, dateCol)}
                                            onCellMouseEnter={() => handleCellMouseEnter(rowIdx, dateCol)}
                                        />
                                    </TableCell>

                                    {/* ── Per-plate column groups ── */}
                                    {plateColumns.map(({ plate, startCol }, groupIdx) => {
                                        const cell = row.cells[plate] ?? emptyPlateCell();
                                        const startColIdx = startCol;
                                        const endColIdx = startCol + 1;
                                        const ttlColIdx = startCol + 2;
                                        const fuelColIdx = startCol + 3;
                                        const ttlKm = (parseFloat(cell.end_km) || 0) - (parseFloat(cell.start_km) || 0);
                                        const lastGroup = groupIdx === plateColumns.length - 1;

                                        return (
                                            <React.Fragment key={plate}>
                                                {/* START KM */}
                                                <TableCell className="px-0 py-0 border-r border-border/30" style={{ height: '28px' }}>
                                                    <GridCell col={startColIdx} row={rowIdx} value={cell.start_km} className="font-mono text-right pr-1" {...commonCellProps} {...selProps(rowIdx, startColIdx)}>
                                                        <Input autoFocus type="number" step="1" value={cell.start_km} onChange={e => updateCell(rowIdx, { plate, field: 'start_km' }, e.target.value)} className={cn(inputClass, 'font-mono text-right text-xs')} onPaste={e => { e.stopPropagation(); handleSmartPaste(e, rowIdx, startColIdx); }} />
                                                    </GridCell>
                                                </TableCell>
                                                {/* END KM */}
                                                <TableCell className="px-0 py-0 border-r border-border/30" style={{ height: '28px' }}>
                                                    <GridCell col={endColIdx} row={rowIdx} value={cell.end_km} className="font-mono text-right pr-1" {...commonCellProps} {...selProps(rowIdx, endColIdx)}>
                                                        <Input autoFocus type="number" step="1" value={cell.end_km} onChange={e => updateCell(rowIdx, { plate, field: 'end_km' }, e.target.value)} className={cn(inputClass, 'font-mono text-right text-xs')} onPaste={e => { e.stopPropagation(); handleSmartPaste(e, rowIdx, endColIdx); }} />
                                                    </GridCell>
                                                </TableCell>
                                                {/* TTL KM — computed, read-only, tinted, selectable for aggregation */}
                                                <TableCell
                                                    className={cn(
                                                        'px-1 py-0 border-r border-border/30 bg-muted/40 font-mono font-semibold text-right text-xs text-foreground/70 select-none cursor-default',
                                                        cellSelection.isSelected(rowIdx, ttlColIdx) && 'bg-primary/10 dark:bg-primary/20',
                                                        cellSelection.isAnchor(rowIdx, ttlColIdx) && 'ring-2 ring-primary ring-inset z-10',
                                                    )}
                                                    style={{ height: '28px' }}
                                                    onMouseDown={(e) => handleCellMouseDown(rowIdx, ttlColIdx, e)}
                                                    onMouseUp={() => handleCellMouseUp(rowIdx, ttlColIdx)}
                                                    onMouseEnter={() => handleCellMouseEnter(rowIdx, ttlColIdx)}
                                                >
                                                    {ttlKm > 0 ? formatNum(ttlKm) : ''}
                                                </TableCell>
                                                {/* FUEL */}
                                                <TableCell className={cn('px-0 py-0', !lastGroup && 'border-r border-foreground/20')} style={{ height: '28px' }}>
                                                    <GridCell col={fuelColIdx} row={rowIdx} value={cell.fuel_liters} className="font-mono text-right pr-1" {...commonCellProps} {...selProps(rowIdx, fuelColIdx)}>
                                                        <Input autoFocus type="number" step="0.01" min="0" value={cell.fuel_liters} onChange={e => updateCell(rowIdx, { plate, field: 'fuel_liters' }, e.target.value)} className={cn(inputClass, 'font-mono text-right text-xs')} onPaste={e => { e.stopPropagation(); handleSmartPaste(e, rowIdx, fuelColIdx); }} />
                                                    </GridCell>
                                                </TableCell>
                                            </React.Fragment>
                                        );
                                    })}
                                </TableRow>
                            );
                        })}
                    </TableBody>
                </table>
            </div>
        </div>
    );
}
