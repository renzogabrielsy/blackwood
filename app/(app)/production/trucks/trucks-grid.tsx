'use client';

import * as React from 'react';
import { toast } from 'sonner';
import { errorToast } from '@/lib/toast';
import { Save, RotateCcw, X, MessageSquareText } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from '@/components/ui/select';
import {
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
} from '@/components/ui/table';
import { TooltipProvider } from '@/components/ui/tooltip';
import { GridCell } from '@/components/shared/grid/GridCell';
import { RemarksCellAdaptor } from '@/components/shared/grid/RemarksCellAdaptor';
import { useCellSelection } from '@/lib/hooks/use-cell-selection';
import { useClipboardCopy } from '@/lib/hooks/use-clipboard-copy';
import { useCellDelete } from '@/lib/hooks/use-cell-delete';
import { useCellAggregation, type AggregationType } from '@/lib/hooks/use-cell-aggregation';
import { useStatusBar } from '@/components/providers/status-bar-context';
import { parseExcelDate, trimCellValue } from '@/lib/paste-utils';
import { saveBulkTrucks } from './actions';
import type { Tables } from '@/types/supabase';

type TruckReadingRow = Tables<'truck_readings'>;
type TruckMonthlyRow = Tables<'view_trucks_monthly'>;

const KNOWN_PLATES = ['AAV 6111', 'KCA 378', 'FORKLIFT'] as const;
const PLATE_OPTIONS: { value: string; label: string }[] = [
    ...KNOWN_PLATES.map(p => ({ value: p, label: p })),
    { value: '__custom__', label: 'Other (type manually)' },
];

type RowState = 'existing' | 'new' | 'modified' | 'deleted';

interface GridRow {
    _state: RowState;
    _id?: string;
    reading_date: string;
    plate_no: string;
    _plate_select: string;
    start_km: string;
    end_km: string;
    fuel_liters: string;
    remarks: string;
}

// col 0: row#, 1: date, 2: plate, 3: start_km, 4: end_km, 5: ttl_km (computed), 6: fuel, 7: remarks, 8: delete
const COL_MAP: (keyof GridRow | null)[] = [
    null,          // 0: row#
    'reading_date', // 1
    'plate_no',    // 2
    'start_km',    // 3
    'end_km',      // 4
    null,          // 5: TTL KM (computed)
    'fuel_liters', // 6
    'remarks',     // 7
    null,          // 8: delete
];
const COL_COUNT = COL_MAP.length;

const NUMERIC_COLS = new Set<keyof GridRow>(['start_km', 'end_km', 'fuel_liters']);

function createEmptyRow(): GridRow {
    return {
        _state: 'new',
        reading_date: new Date().toISOString().split('T')[0],
        plate_no: 'AAV 6111',
        _plate_select: 'AAV 6111',
        start_km: '',
        end_km: '',
        fuel_liters: '',
        remarks: '',
    };
}

function dbRowToGridRow(r: TruckReadingRow): GridRow {
    const isKnown = (KNOWN_PLATES as readonly string[]).includes(r.plate_no);
    return {
        _state: 'existing',
        _id: r.id,
        reading_date: r.reading_date ?? '',
        plate_no: r.plate_no ?? '',
        _plate_select: isKnown ? r.plate_no : '__custom__',
        start_km: r.start_km != null ? String(r.start_km) : '',
        end_km: r.end_km != null ? String(r.end_km) : '',
        fuel_liters: r.fuel_liters != null ? String(r.fuel_liters) : '',
        remarks: r.remarks ?? '',
    };
}

function cleanPasteValue(raw: string, field: keyof GridRow): string {
    const val = trimCellValue(raw);
    if (field === 'reading_date') return parseExcelDate(val);
    if (NUMERIC_COLS.has(field)) return val.replace(/[₱,"']/g, '');
    return val;
}

const inputClass =
    'h-8 w-full px-1 border-transparent bg-transparent rounded-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-primary focus-visible:bg-accent/10 transition-colors shadow-none';

interface TrucksGridProps {
    initialData: TruckReadingRow[];
    monthly: TruckMonthlyRow[];
    onSaveSuccess: () => void;
}

export function TrucksGrid({ initialData, monthly, onSaveSuccess }: TrucksGridProps) {
    const { setCellSelectionCount, setCellAggregates } = useStatusBar();
    const gridRef = React.useRef<HTMLDivElement>(null);

    const [rows, setRows] = React.useState<GridRow[]>(() => {
        const base = initialData.map(dbRowToGridRow);
        return [...base, createEmptyRow()];
    });

    const [activeCell, setActiveCell] = React.useState<{ row: number; col: number } | null>(null);
    const [isEditing, setIsEditing] = React.useState(false);
    const [isSaving, setIsSaving] = React.useState(false);
    const preEditValue = React.useRef<string>('');

    const cellSelection = useCellSelection({
        rowCount: rows.length,
        colCount: COL_COUNT,
        isSelectableColumn: (c) => COL_MAP[c] !== null && c !== 0,
        scrollContainerRef: gridRef,
        enabled: true,
    });

    const getCellValue = React.useCallback(
        (rowIdx: number, colIdx: number): string => {
            const row = rows[rowIdx];
            if (!row) return '';
            if (colIdx === 5) {
                const km = (parseFloat(row.end_km) || 0) - (parseFloat(row.start_km) || 0);
                return km >= 0 ? String(km) : '';
            }
            const field = COL_MAP[colIdx];
            if (!field) return '';
            return String(row[field] ?? '');
        },
        [rows]
    );

    const getNumericCellValue = React.useCallback(
        (rowIdx: number, colIdx: number): number | null => {
            const row = rows[rowIdx];
            if (!row) return null;
            const field = COL_MAP[colIdx];
            if (!field || !NUMERIC_COLS.has(field)) return null;
            const v = parseFloat(String(row[field]));
            return isNaN(v) ? null : v;
        },
        [rows]
    );

    const getColumnDefaultCalcType = React.useCallback(
        (colIdx: number): AggregationType | null => {
            const field = COL_MAP[colIdx];
            if (field === 'start_km' || field === 'end_km' || field === 'fuel_liters') return 'SUM';
            return null;
        },
        []
    );

    const aggregates = useCellAggregation({ range: cellSelection.range, getNumericCellValue, getColumnDefaultCalcType });

    React.useEffect(() => {
        const count = cellSelection.range ? cellSelection.getSelectionSize() : 0;
        const timer = setTimeout(() => { setCellSelectionCount(count); setCellAggregates(count > 1 ? aggregates : null); }, 50);
        return () => { clearTimeout(timer); setCellSelectionCount(0); setCellAggregates(null); };
    }, [cellSelection.range, cellSelection.getSelectionSize, setCellSelectionCount, setCellAggregates, aggregates]);

    const { handleKeyDown: handleCopyKeyDown } = useClipboardCopy({
        getSelectedRange: cellSelection.getSelectedRange, getCellValue, getSelectionSize: cellSelection.getSelectionSize,
    });

    const mouseDownCellRef = React.useRef<{ row: number; col: number } | null>(null);
    const dragMovedRef = React.useRef(false);

    const handleCellMouseDown = React.useCallback((rowIdx: number, colIdx: number, e: React.MouseEvent) => {
        mouseDownCellRef.current = { row: rowIdx, col: colIdx }; dragMovedRef.current = false;
        cellSelection.handleCellMouseDown(rowIdx, colIdx, e);
    }, [cellSelection]);

    const handleCellMouseUp = React.useCallback((rowIdx: number, colIdx: number) => {
        const down = mouseDownCellRef.current; mouseDownCellRef.current = null;
        if (down && down.row === rowIdx && down.col === colIdx && !dragMovedRef.current) {
            cellSelection.clearSelection(); setActiveCell({ row: rowIdx, col: colIdx }); setIsEditing(false); gridRef.current?.focus();
        }
        dragMovedRef.current = false;
    }, [cellSelection]);

    const handleCellMouseEnter = React.useCallback((rowIdx: number, colIdx: number) => {
        if (mouseDownCellRef.current) { dragMovedRef.current = true; cellSelection.handleCellMouseEnter(rowIdx, colIdx); }
    }, [cellSelection]);

    const updateRow = React.useCallback((idx: number, field: keyof GridRow, value: string) => {
        setRows(prev => {
            const next = [...prev];
            const row = { ...next[idx], [field]: value };
            if (row._state === 'existing') row._state = 'modified';
            next[idx] = row;
            const last = next[next.length - 1];
            if (last._state !== 'new') next.push(createEmptyRow());
            return next;
        });
    }, []);

    const updatePlate = React.useCallback((idx: number, selectValue: string) => {
        setRows(prev => {
            const next = [...prev];
            const row = { ...next[idx] };
            row._plate_select = selectValue;
            if (selectValue !== '__custom__') {
                row.plate_no = selectValue;
                if (row._state === 'existing') row._state = 'modified';
            }
            next[idx] = row;
            const last = next[next.length - 1];
            if (last._state !== 'new') next.push(createEmptyRow());
            return next;
        });
    }, []);

    const markDeleted = React.useCallback((idx: number) => {
        setRows(prev => {
            const next = [...prev]; const row = { ...next[idx] };
            if (row._state === 'new') { if (next.length > 1) { next.splice(idx, 1); return next; } return next; }
            row._state = 'deleted'; next[idx] = row; return next;
        });
    }, []);

    const restoreRow = React.useCallback((idx: number) => {
        setRows(prev => {
            const next = [...prev]; const row = { ...next[idx] };
            row._state = row._id ? 'existing' : 'new'; next[idx] = row; return next;
        });
    }, []);

    const clearCell = React.useCallback((rowIdx: number, colIdx: number) => {
        const field = COL_MAP[colIdx];
        if (field && field !== '_state' && field !== '_id' && field !== '_plate_select') updateRow(rowIdx, field, '');
    }, [updateRow]);

    const { handleKeyDown: handleDeleteKeyDown } = useCellDelete({
        getSelectedRange: cellSelection.getSelectedRange, getSelectionSize: cellSelection.getSelectionSize, clearCell,
    });

    const startEditing = React.useCallback((rowIdx: number, colIdx: number, initialChar?: string) => {
        const field = COL_MAP[colIdx];
        if (!field || field === '_state' || field === '_id' || field === '_plate_select') return;
        const row = rows[rowIdx];
        preEditValue.current = row ? String(row[field] ?? '') : '';
        setActiveCell({ row: rowIdx, col: colIdx }); setIsEditing(true);
        if (initialChar !== undefined) updateRow(rowIdx, field, initialChar);
    }, [rows, updateRow]);

    const revertChanges = React.useCallback(() => {
        if (!activeCell) return;
        const field = COL_MAP[activeCell.col];
        if (field && field !== '_state' && field !== '_id' && field !== '_plate_select') {
            setRows(prev => {
                const next = [...prev]; const row = { ...next[activeCell.row] };
                (row as Record<string, unknown>)[field] = preEditValue.current;
                if (row._state === 'modified' && row._id) row._state = 'existing';
                next[activeCell.row] = row; return next;
            });
        }
        setIsEditing(false); gridRef.current?.focus();
    }, [activeCell]);

    const moveActive = React.useCallback((key: string, shift: boolean) => {
        if (!activeCell) return;
        let { row, col } = activeCell;
        if (key === 'ArrowUp' || (key === 'Enter' && shift)) row = Math.max(0, row - 1);
        else if (key === 'ArrowDown' || (key === 'Enter' && !shift)) row = Math.min(rows.length - 1, row + 1);
        else if (key === 'ArrowLeft') { do { col--; } while (col > 0 && COL_MAP[col] === null); col = Math.max(0, col); }
        else if (key === 'ArrowRight') { do { col++; } while (col < COL_COUNT - 1 && COL_MAP[col] === null); col = Math.min(COL_COUNT - 1, col); }
        else if (key === 'Tab') {
            if (shift) { do { col--; if (col < 0) { row--; col = COL_COUNT - 1; } } while (row >= 0 && COL_MAP[col] === null); if (row < 0) { row = 0; col = activeCell.col; } }
            else { do { col++; if (col >= COL_COUNT) { row++; col = 0; } } while (row < rows.length && COL_MAP[col] === null); if (row >= rows.length) { row = rows.length - 1; col = activeCell.col; } }
        } else if (key === 'Home') col = 1;
        else if (key === 'End') col = COL_COUNT - 2;
        setActiveCell({ row, col });
    }, [activeCell, rows.length]);

    const handleGridKeyDown = React.useCallback((e: React.KeyboardEvent) => {
        if (!activeCell) return;
        const isRangeSelected = cellSelection.getSelectionSize() > 1;
        if (isEditing) {
            if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); e.nativeEvent.stopImmediatePropagation(); revertChanges(); }
            else if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); setIsEditing(false); moveActive(e.key, e.shiftKey); gridRef.current?.focus(); }
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
                if (targetRow >= next.length) next.push(createEmptyRow());
                const cols = pastedRow.split('\t');
                cols.forEach((cellVal, cOffset) => {
                    const targetCol = startCol + cOffset;
                    if (targetCol >= COL_COUNT) return;
                    const field = COL_MAP[targetCol];
                    if (!field || field === '_state' || field === '_id' || field === '_plate_select') return;
                    const row = { ...next[targetRow] };
                    (row as Record<string, unknown>)[field] = cleanPasteValue(cellVal, field);
                    if (row._state === 'existing') row._state = 'modified';
                    next[targetRow] = row;
                });
            });
            const last = next[next.length - 1];
            if (last._state !== 'new') next.push(createEmptyRow());
            return next;
        });
        toast.success(`Pasted ${pastedRows.length} rows`);
    }, []);

    const handleGridPaste = React.useCallback((e: React.ClipboardEvent) => {
        if (!isEditing && activeCell) { handleSmartPaste(e, activeCell.row, activeCell.col); cellSelection.clearSelection(); }
    }, [isEditing, activeCell, handleSmartPaste, cellSelection]);

    const isDirty = rows.some(r =>
        (r._state === 'new' && (r.plate_no || r.start_km || r.end_km)) ||
        r._state === 'modified' || r._state === 'deleted'
    );

    const handleDiscard = React.useCallback(() => {
        const base = initialData.map(dbRowToGridRow);
        setRows([...base, createEmptyRow()]); setActiveCell(null); setIsEditing(false);
    }, [initialData]);

    const handleSave = async () => {
        setIsSaving(true);
        try {
            const inserts: Parameters<typeof saveBulkTrucks>[0]['inserts'] = [];
            const updates: Parameters<typeof saveBulkTrucks>[0]['updates'] = [];
            const deletes: string[] = [];

            for (const row of rows) {
                if (row._state === 'deleted' && row._id) {
                    deletes.push(row._id);
                } else if (row._state === 'new' && (row.plate_no || row.start_km)) {
                    inserts.push({
                        reading_date: row.reading_date,
                        plate_no: row.plate_no,
                        start_km: parseFloat(row.start_km) || 0,
                        end_km: parseFloat(row.end_km) || 0,
                        fuel_liters: row.fuel_liters ? parseFloat(row.fuel_liters) : null,
                        remarks: row.remarks || null,
                    });
                } else if (row._state === 'modified' && row._id) {
                    updates.push({
                        id: row._id,
                        data: {
                            reading_date: row.reading_date,
                            plate_no: row.plate_no,
                            start_km: parseFloat(row.start_km) || 0,
                            end_km: parseFloat(row.end_km) || 0,
                            fuel_liters: row.fuel_liters ? parseFloat(row.fuel_liters) : null,
                            remarks: row.remarks || null,
                        },
                    });
                }
            }

            if (!inserts.length && !updates.length && !deletes.length) { toast.info('No changes to save.'); setIsSaving(false); return; }

            const res = await saveBulkTrucks({ inserts, updates, deletes });
            if (!res.ok) {
                errorToast(res.error);
            } else {
                const parts: string[] = [];
                if (res.insertedCount) parts.push(`${res.insertedCount} added`);
                if (res.updatedCount) parts.push(`${res.updatedCount} updated`);
                if (res.deletedCount) parts.push(`${res.deletedCount} deleted`);
                toast.success(`Saved — ${parts.join(', ')}`);
                onSaveSuccess();
            }
        } catch (err) {
            errorToast('Unexpected error: ' + (err instanceof Error ? err.message : String(err)));
        } finally {
            setIsSaving(false);
        }
    };

    const selProps = (rowIdx: number, colIdx: number) => ({
        onCellMouseDown: (e: React.MouseEvent) => handleCellMouseDown(rowIdx, colIdx, e),
        onCellMouseUp: () => handleCellMouseUp(rowIdx, colIdx),
        onCellMouseEnter: () => handleCellMouseEnter(rowIdx, colIdx),
        isCellRangeSelected: cellSelection.isSelected(rowIdx, colIdx),
        isCellRangeAnchor: cellSelection.isAnchor(rowIdx, colIdx),
        isDragActive: cellSelection.isDragging,
    });

    const commonCellProps = { activeCell, isEditing, setActiveCell, setIsEditing, onStartEditing: startEditing, onRevert: revertChanges, gridRef };

    return (
        <TooltipProvider>
            <div className="flex flex-col gap-0">
                {/* Grid toolbar */}
                <div className="flex items-center justify-between px-2 py-1 border-b bg-muted/20">
                    <span className="text-[10px] text-muted-foreground uppercase tracking-wide">
                        {rows.filter(r => r._state !== 'new').length} readings this period
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
                    <table className="w-full table-fixed text-xs border-collapse relative">
                        <TableHeader className="bg-muted/90 backdrop-blur-sm sticky top-0 z-50 shadow-sm">
                            <TableRow className="hover:bg-transparent border-b border-foreground/20" style={{ height: '28px' }}>
                                <TableHead className="w-[28px] h-7 px-1 py-0 font-mono font-bold text-center text-[10px] border-r border-foreground/10">#</TableHead>
                                <TableHead className="w-[80px] h-7 px-1 py-0 font-mono font-bold text-center text-[10px] border-r border-foreground/10">DATE</TableHead>
                                <TableHead className="w-[110px] h-7 px-1 py-0 font-mono font-bold text-center text-[10px] border-r border-foreground/10">PLATE NO</TableHead>
                                <TableHead className="w-[75px] h-7 px-1 py-0 font-mono font-bold text-right text-[10px] border-r border-foreground/10">START KM</TableHead>
                                <TableHead className="w-[75px] h-7 px-1 py-0 font-mono font-bold text-right text-[10px] border-r border-foreground/10">END KM</TableHead>
                                <TableHead className="w-[65px] h-7 px-1 py-0 font-mono font-bold text-right text-[10px] border-r border-foreground/10 bg-muted/50">TTL KM</TableHead>
                                <TableHead className="w-[65px] h-7 px-1 py-0 font-mono font-bold text-right text-[10px] border-r border-foreground/10">FUEL (L)</TableHead>
                                <TableHead className="w-[50px] h-7 px-1 py-0 font-mono font-bold text-center text-[10px] border-r border-foreground/10">REM</TableHead>
                                <TableHead className="w-[20px] h-7 p-0"></TableHead>
                            </TableRow>
                        </TableHeader>
                        <TableBody>
                            {rows.length === 1 && rows[0]._state === 'new' && (
                                <TableRow className="hover:bg-transparent">
                                    <TableCell colSpan={9} className="py-8 text-center">
                                        <p className="text-xs text-muted-foreground animate-fade-up">
                                            Awaiting Production Manager sync. Start typing in the empty row, or paste a range from Excel.
                                        </p>
                                    </TableCell>
                                </TableRow>
                            )}
                            {rows.map((row, rowIdx) => {
                                const ttlKm = (parseFloat(row.end_km) || 0) - (parseFloat(row.start_km) || 0);
                                const isDeleted = row._state === 'deleted';
                                const isDirtyRow = row._state === 'modified';

                                return (
                                    <TableRow
                                        key={rowIdx}
                                        className={cn(
                                            'transition-all duration-150 border-b border-border/30',
                                            isDeleted && 'opacity-40 line-through',
                                            isDirtyRow && 'border-l-2 border-l-amber-400'
                                        )}
                                        style={{ height: '28px' }}
                                    >
                                        <TableCell className="px-1 py-0 text-center font-mono text-[10px] text-muted-foreground border-r border-border/30" style={{ height: '28px' }}>
                                            {rowIdx + 1}
                                        </TableCell>
                                        {/* DATE */}
                                        <TableCell className="px-0 py-0 border-r border-border/30" style={{ height: '28px' }}>
                                            <GridCell col={1} row={rowIdx} value={row.reading_date} className="font-mono text-center" {...commonCellProps} {...selProps(rowIdx, 1)}>
                                                <Input autoFocus value={row.reading_date} onChange={e => updateRow(rowIdx, 'reading_date', e.target.value)} className={cn(inputClass, 'font-mono text-center text-xs')} onPaste={e => { e.stopPropagation(); handleSmartPaste(e, rowIdx, 1); }} />
                                            </GridCell>
                                        </TableCell>
                                        {/* PLATE NO */}
                                        <TableCell className="px-0 py-0 border-r border-border/30" style={{ height: '28px' }}>
                                            <GridCell col={2} row={rowIdx} value={row.plate_no} className="font-mono text-center" {...commonCellProps} {...selProps(rowIdx, 2)}>
                                                {row._plate_select === '__custom__' ? (
                                                    <Input
                                                        autoFocus
                                                        value={row.plate_no}
                                                        onChange={e => updateRow(rowIdx, 'plate_no', e.target.value)}
                                                        className={cn(inputClass, 'font-mono text-center text-xs')}
                                                        placeholder="Plate no..."
                                                        onPaste={e => { e.stopPropagation(); handleSmartPaste(e, rowIdx, 2); }}
                                                    />
                                                ) : (
                                                    <Select value={row._plate_select} onValueChange={v => updatePlate(rowIdx, v)}>
                                                        <SelectTrigger className="h-8 w-full border-transparent bg-transparent rounded-none text-xs font-mono focus:ring-1 focus:ring-inset focus:ring-primary shadow-none px-1">
                                                            <SelectValue />
                                                        </SelectTrigger>
                                                        <SelectContent>
                                                            {PLATE_OPTIONS.map(opt => (
                                                                <SelectItem key={opt.value} value={opt.value} className="text-xs font-mono">{opt.label}</SelectItem>
                                                            ))}
                                                        </SelectContent>
                                                    </Select>
                                                )}
                                            </GridCell>
                                        </TableCell>
                                        {/* START KM */}
                                        <TableCell className="px-0 py-0 border-r border-border/30" style={{ height: '28px' }}>
                                            <GridCell col={3} row={rowIdx} value={row.start_km} className="font-mono text-right pr-1" {...commonCellProps} {...selProps(rowIdx, 3)}>
                                                <Input autoFocus type="number" step="1" value={row.start_km} onChange={e => updateRow(rowIdx, 'start_km', e.target.value)} className={cn(inputClass, 'font-mono text-right text-xs')} onPaste={e => { e.stopPropagation(); handleSmartPaste(e, rowIdx, 3); }} />
                                            </GridCell>
                                        </TableCell>
                                        {/* END KM */}
                                        <TableCell className="px-0 py-0 border-r border-border/30" style={{ height: '28px' }}>
                                            <GridCell col={4} row={rowIdx} value={row.end_km} className="font-mono text-right pr-1" {...commonCellProps} {...selProps(rowIdx, 4)}>
                                                <Input autoFocus type="number" step="1" value={row.end_km} onChange={e => updateRow(rowIdx, 'end_km', e.target.value)} className={cn(inputClass, 'font-mono text-right text-xs')} onPaste={e => { e.stopPropagation(); handleSmartPaste(e, rowIdx, 4); }} />
                                            </GridCell>
                                        </TableCell>
                                        {/* TTL KM — computed */}
                                        <TableCell className="px-1 py-0 border-r border-border/30 bg-muted/20 font-mono text-right text-xs text-muted-foreground" style={{ height: '28px' }}>
                                            {ttlKm > 0 ? ttlKm : ''}
                                        </TableCell>
                                        {/* FUEL */}
                                        <TableCell className="px-0 py-0 border-r border-border/30" style={{ height: '28px' }}>
                                            <GridCell col={6} row={rowIdx} value={row.fuel_liters} className="font-mono text-right pr-1" {...commonCellProps} {...selProps(rowIdx, 6)}>
                                                <Input autoFocus type="number" step="0.01" min="0" value={row.fuel_liters} onChange={e => updateRow(rowIdx, 'fuel_liters', e.target.value)} className={cn(inputClass, 'font-mono text-right text-xs')} onPaste={e => { e.stopPropagation(); handleSmartPaste(e, rowIdx, 6); }} />
                                            </GridCell>
                                        </TableCell>
                                        {/* REMARKS */}
                                        <TableCell className="px-0 py-0 border-r border-border/30" style={{ height: '28px' }}>
                                            <GridCell
                                                col={7} row={rowIdx} value={row.remarks} className="text-center"
                                                {...commonCellProps} {...selProps(rowIdx, 7)}
                                                displayValue={
                                                    <div className={cn('h-6 w-6 flex items-center justify-center rounded-sm', row.remarks ? 'text-primary' : 'text-muted-foreground/30')}>
                                                        <MessageSquareText className="w-3 h-3" />
                                                    </div>
                                                }
                                            >
                                                <RemarksCellAdaptor value={row.remarks} onChange={v => updateRow(rowIdx, 'remarks', v)} onClose={() => setIsEditing(false)} onRevert={revertChanges} fontSize={11} />
                                            </GridCell>
                                        </TableCell>
                                        {/* Delete */}
                                        <TableCell className="p-0 w-[20px]" style={{ height: '28px' }}>
                                            <button
                                                className={cn('h-full w-full flex items-center justify-center transition-colors', isDeleted ? 'text-muted-foreground hover:text-foreground' : 'text-muted-foreground/40 hover:text-destructive')}
                                                onClick={() => isDeleted ? restoreRow(rowIdx) : markDeleted(rowIdx)}
                                                tabIndex={-1} type="button"
                                            >
                                                {isDeleted ? <RotateCcw className="w-3 h-3" /> : <X className="w-3 h-3" />}
                                            </button>
                                        </TableCell>
                                    </TableRow>
                                );
                            })}
                        </TableBody>
                    </table>
                </div>

                {/* Monthly summary */}
                {monthly.length > 0 && (
                    <div className="border-t bg-muted/10 p-2">
                        <p className="text-[10px] font-mono font-bold uppercase tracking-wider text-muted-foreground mb-1">Monthly Summary</p>
                        <div className="overflow-x-auto">
                            <table className="text-xs table-fixed border-collapse w-full">
                                <thead>
                                    <tr className="border-b border-foreground/10">
                                        <th className="px-2 py-0.5 text-left font-mono text-[10px] w-[90px]">MONTH</th>
                                        <th className="px-2 py-0.5 text-left font-mono text-[10px] w-[90px]">PLATE</th>
                                        <th className="px-2 py-0.5 text-right font-mono text-[10px] w-[70px]">START KM</th>
                                        <th className="px-2 py-0.5 text-right font-mono text-[10px] w-[70px]">END KM</th>
                                        <th className="px-2 py-0.5 text-right font-mono text-[10px] w-[70px]">TTL KM</th>
                                        <th className="px-2 py-0.5 text-right font-mono text-[10px] w-[70px]">FUEL (L)</th>
                                        <th className="px-2 py-0.5 text-right font-mono text-[10px] w-[50px]">RDGS</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {monthly.map((m, i) => (
                                        <tr key={i} className="border-b border-border/20 hover:bg-muted/20">
                                            <td className="px-2 py-0.5 font-mono text-[11px]">{m.month}</td>
                                            <td className="px-2 py-0.5 font-mono text-[11px]">{m.plate_no}</td>
                                            <td className="px-2 py-0.5 font-mono text-[11px] text-right">{m.month_start_km?.toLocaleString()}</td>
                                            <td className="px-2 py-0.5 font-mono text-[11px] text-right">{m.month_end_km?.toLocaleString()}</td>
                                            <td className="px-2 py-0.5 font-mono text-[11px] text-right">{m.month_km?.toLocaleString()}</td>
                                            <td className="px-2 py-0.5 font-mono text-[11px] text-right">{m.month_fuel_liters?.toFixed(2)}</td>
                                            <td className="px-2 py-0.5 font-mono text-[11px] text-right">{m.reading_count}</td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    </div>
                )}
            </div>
        </TooltipProvider>
    );
}
