'use client';

import * as React from 'react';
import { toast } from 'sonner';
import { errorToast } from '@/lib/toast';
import { Save, RotateCcw, X, MessageSquareText } from 'lucide-react';
import { cn, focusNoScroll } from '@/lib/utils';
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
import {
    useGridKeyboardNav,
    createCoordinateNavResolver,
    type CoordinateId,
    type GridRangeSlot,
} from '@/lib/hooks/use-grid-keyboard-nav';
import { useGridEditSession } from '@/lib/hooks/use-grid-edit-session';
import { useStatusBar } from '@/components/providers/status-bar-context';
import { parseExcelDate, trimCellValue } from '@/lib/paste-utils';
import { saveBulkElectricity } from './actions';
import type { Tables } from '@/types/supabase';

type ElectricityReadingRow = Tables<'electricity_readings'>;

const KNOWN_METERS = ['MAIN', 'BUNKHOUSE', 'PUMP'] as const;
type KnownMeter = (typeof KNOWN_METERS)[number];
const METER_OPTIONS: { value: string; label: string }[] = [
    ...KNOWN_METERS.map(m => ({ value: m, label: m })),
    { value: '__custom__', label: 'Other (type manually)' },
];

type RowState = 'existing' | 'new' | 'modified' | 'deleted';

interface GridRow {
    _state: RowState;
    _id?: string;
    reading_date: string;
    meter: string;
    _meter_select: string; // '__custom__' if typed manually
    start_kwh: string;
    end_kwh: string;
    meter_multiplier: string;
    remarks: string;
}

// col 0: row#, 1: date, 2: meter, 3: start_kwh, 4: end_kwh, 5: diff (computed), 6: meter_multiplier, 7: consumption kwh (computed), 8: remarks, 9: delete
const COL_MAP: (keyof GridRow | null)[] = [
    null,                // 0: row#
    'reading_date',      // 1
    'meter',             // 2
    'start_kwh',         // 3
    'end_kwh',           // 4
    null,                // 5: DIFF (computed)
    'meter_multiplier',  // 6
    null,                // 7: TTL KWH (computed)
    'remarks',           // 8
    null,                // 9: delete
];
const COL_COUNT = COL_MAP.length;

const NUMERIC_COLS = new Set<keyof GridRow>(['start_kwh', 'end_kwh', 'meter_multiplier']);

function createEmptyRow(): GridRow {
    return {
        _state: 'new',
        reading_date: new Date().toISOString().split('T')[0],
        meter: 'MAIN',
        _meter_select: 'MAIN',
        start_kwh: '',
        end_kwh: '',
        meter_multiplier: '120',
        remarks: '',
    };
}

function dbRowToGridRow(r: ElectricityReadingRow): GridRow {
    const isKnown = (KNOWN_METERS as readonly string[]).includes(r.meter);
    return {
        _state: 'existing',
        _id: r.id,
        reading_date: r.reading_date ?? '',
        meter: r.meter ?? '',
        _meter_select: isKnown ? r.meter : '__custom__',
        start_kwh: r.start_kwh != null ? String(r.start_kwh) : '',
        end_kwh: r.end_kwh != null ? String(r.end_kwh) : '',
        meter_multiplier: r.meter_multiplier != null ? String(r.meter_multiplier) : '',
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

interface ElectricityGridProps {
    initialData: ElectricityReadingRow[];
    onSaveSuccess: () => void;
}

export function ElectricityGrid({ initialData, onSaveSuccess }: ElectricityGridProps) {
    const { setCellSelectionCount, setCellAggregates } = useStatusBar();
    const gridRef = React.useRef<HTMLDivElement>(null);

    const [rows, setRows] = React.useState<GridRow[]>(() => {
        const base = initialData.map(dbRowToGridRow);
        return [...base, createEmptyRow()];
    });

    const [activeCell, setActiveCell] = React.useState<CoordinateId | null>(null);
    const [isSaving, setIsSaving] = React.useState(false);

    // Stable indirection so mouse/blur handlers can end an active edit without a
    // forward reference to the edit session (created after the row mutators).
    const endEditRef = React.useRef<() => void>(() => {});

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
                const diff = (parseFloat(row.end_kwh) || 0) - (parseFloat(row.start_kwh) || 0);
                return diff >= 0 ? diff.toFixed(2) : '';
            }
            if (colIdx === 7) {
                const diff = (parseFloat(row.end_kwh) || 0) - (parseFloat(row.start_kwh) || 0);
                const multiplier = parseFloat(row.meter_multiplier) || 0;
                return diff >= 0 ? (diff * multiplier).toFixed(2) : '';
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
            if (field === 'start_kwh' || field === 'end_kwh') return 'SUM';
            if (field === 'meter_multiplier') return 'AVERAGE';
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
        mouseDownCellRef.current = { row: rowIdx, col: colIdx };
        dragMovedRef.current = false;
        cellSelection.handleCellMouseDown(rowIdx, colIdx, e);
    }, [cellSelection]);

    const handleCellMouseUp = React.useCallback((rowIdx: number, colIdx: number) => {
        const down = mouseDownCellRef.current;
        mouseDownCellRef.current = null;
        if (down && down.row === rowIdx && down.col === colIdx && !dragMovedRef.current) {
            // `preventScroll`: HTMLElement.focus() otherwise scrolls the grid wrapper into
            // view with block AND inline "center" through every scrolling ancestor — and
            // "center" always computes a target, so it fires even when nothing moved. That
            // is what jolted the page on a plain cell click. Focus still moves.
            cellSelection.clearSelection(); setActiveCell({ row: rowIdx, col: colIdx }); endEditRef.current(); gridRef.current?.focus({ preventScroll: true });
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

    const updateMeter = React.useCallback((idx: number, selectValue: string) => {
        setRows(prev => {
            const next = [...prev];
            const row = { ...next[idx] };
            row._meter_select = selectValue;
            if (selectValue !== '__custom__') {
                row.meter = selectValue;
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
            const next = [...prev];
            const row = { ...next[idx] };
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
        if (field && field !== '_state' && field !== '_id' && field !== '_meter_select') updateRow(rowIdx, field, '');
    }, [updateRow]);

    const { handleKeyDown: handleDeleteKeyDown } = useCellDelete({
        getSelectedRange: cellSelection.getSelectedRange, getSelectionSize: cellSelection.getSelectionSize, clearCell,
    });

    // ─── Editing (shared Blackwood Table edit session) ────────────────────────
    const setCellValue = React.useCallback((id: CoordinateId, value: string) => {
        const field = COL_MAP[id.col];
        if (field) updateRow(id.row, field, value);
    }, [updateRow]);

    const editSession = useGridEditSession<CoordinateId>({
        getValue: (id) => getCellValue(id.row, id.col),
        setValue: setCellValue,
    });
    const isEditing = editSession.isEditing;
    endEditRef.current = () => { if (editSession.isEditing) editSession.commit(); };

    const startEditing = React.useCallback((rowIdx: number, colIdx: number, initialChar?: string) => {
        if (COL_MAP[colIdx] == null) return;
        setActiveCell({ row: rowIdx, col: colIdx });
        editSession.startEditing({ row: rowIdx, col: colIdx }, initialChar);
    }, [editSession]);

    // Custom revert (NOT the session's) so the `_state` rollback is preserved:
    // reverting an id-backed modified row drops it back to 'existing'. The session's
    // setValue path would re-mark it 'modified', so mutate directly using the
    // session snapshot, then clear the edit flag via commit.
    const revertChanges = React.useCallback(() => {
        if (!activeCell) return;
        const field = COL_MAP[activeCell.col];
        if (field) {
            const snapshot = editSession.preEditValueRef.current ?? '';
            setRows(prev => {
                const next = [...prev]; const row = { ...next[activeCell.row] };
                (row as Record<string, unknown>)[field] = snapshot;
                if (row._state === 'modified' && row._id) row._state = 'existing';
                next[activeCell.row] = row; return next;
            });
        }
        editSession.commit(); gridRef.current?.focus({ preventScroll: true });
    }, [activeCell, editSession]);

    const setIsEditing = React.useCallback((editing: boolean) => {
        if (!editing) editSession.commit();
    }, [editSession]);

    // ─── Grid navigation (shared Blackwood Table primitives) ──────────────────
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
            commit: () => { editSession.commit(); gridRef.current?.focus({ preventScroll: true }); },
        },
        range: rangeSlot,
        enableEnterAnchor: false,
    });

    // Home/End column jumps (not in the shared state machine) are intercepted here
    // when not editing — Home → first writable col, End → last writable col
    // (COL_COUNT - 2, i.e. REMARKS; the trailing delete column is skipped).
    const handleGridKeyDown = React.useCallback((e: React.KeyboardEvent) => {
        if (!isEditing && activeCell && (e.key === 'Home' || e.key === 'End')) {
            e.preventDefault();
            setActiveCell({ row: activeCell.row, col: e.key === 'Home' ? 1 : COL_COUNT - 2 });
            return;
        }
        navKeyDown(e);
    }, [isEditing, activeCell, navKeyDown]);

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
                    if (!field || field === '_state' || field === '_id' || field === '_meter_select') return;
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
        (r._state === 'new' && (r.meter || r.start_kwh || r.end_kwh)) ||
        r._state === 'modified' || r._state === 'deleted'
    );

    const handleDiscard = React.useCallback(() => {
        const base = initialData.map(dbRowToGridRow);
        setRows([...base, createEmptyRow()]); setActiveCell(null); endEditRef.current();
    }, [initialData]);

    const handleSave = async () => {
        setIsSaving(true);
        try {
            const inserts: Parameters<typeof saveBulkElectricity>[0]['inserts'] = [];
            const updates: Parameters<typeof saveBulkElectricity>[0]['updates'] = [];
            const deletes: string[] = [];

            for (const row of rows) {
                if (row._state === 'deleted' && row._id) {
                    deletes.push(row._id);
                } else if (row._state === 'new' && (row.meter || row.start_kwh)) {
                    inserts.push({
                        reading_date: row.reading_date,
                        meter: row.meter,
                        start_kwh: parseFloat(row.start_kwh) || 0,
                        end_kwh: parseFloat(row.end_kwh) || 0,
                        meter_multiplier: parseFloat(row.meter_multiplier) || 120,
                        remarks: row.remarks || null,
                    });
                } else if (row._state === 'modified' && row._id) {
                    updates.push({
                        id: row._id,
                        data: {
                            reading_date: row.reading_date,
                            meter: row.meter,
                            start_kwh: parseFloat(row.start_kwh) || 0,
                            end_kwh: parseFloat(row.end_kwh) || 0,
                            meter_multiplier: parseFloat(row.meter_multiplier) || 120,
                            remarks: row.remarks || null,
                        },
                    });
                }
            }

            if (!inserts.length && !updates.length && !deletes.length) { toast.info('No changes to save.'); setIsSaving(false); return; }

            const res = await saveBulkElectricity({ inserts, updates, deletes });
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
                    className="outline-none select-none overflow-auto relative max-h-[60dvh]"
                    tabIndex={-1}
                    onKeyDown={handleGridKeyDown}
                    onPaste={handleGridPaste}
                    onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget)) { setActiveCell(null); setIsEditing(false); } }}
                >
                    {/* Never crush, always scroll: every column is fixed and they sum to
                        688px (28+80+120+80+80+70+70+90+50+20) — pin that as the floor so
                        the wrapper scrolls sideways instead of compressing all ten. */}
                    <table className="w-full min-w-[688px] table-fixed text-xs border-collapse relative">
                        <TableHeader className="bg-muted/90 backdrop-blur-sm sticky top-0 z-50 shadow-sm">
                            <TableRow className="hover:bg-transparent border-b border-foreground/20" style={{ height: '28px' }}>
                                <TableHead className="w-[28px] h-7 px-1 py-0 font-mono font-bold text-center text-[10px] border-r border-foreground/10">#</TableHead>
                                <TableHead className="w-[80px] h-7 px-1 py-0 font-mono font-bold text-center text-[10px] border-r border-foreground/10">DATE</TableHead>
                                <TableHead className="w-[120px] h-7 px-1 py-0 font-mono font-bold text-center text-[10px] border-r border-foreground/10">METER</TableHead>
                                <TableHead className="w-[80px] h-7 px-1 py-0 font-mono font-bold text-right text-[10px] border-r border-foreground/10">START KWH</TableHead>
                                <TableHead className="w-[80px] h-7 px-1 py-0 font-mono font-bold text-right text-[10px] border-r border-foreground/10">END KWH</TableHead>
                                <TableHead className="w-[70px] h-7 px-1 py-0 font-mono font-bold text-right text-[10px] border-r border-foreground/10 bg-muted/50">DIFF</TableHead>
                                <TableHead className="w-[70px] h-7 px-1 py-0 font-mono font-bold text-right text-[10px] border-r border-foreground/10">MULT</TableHead>
                                <TableHead className="w-[90px] h-7 px-1 py-0 font-mono font-bold text-right text-[10px] border-r border-foreground/10 bg-muted/50">TTL KWH</TableHead>
                                <TableHead className="w-[50px] h-7 px-1 py-0 font-mono font-bold text-center text-[10px] border-r border-foreground/10">REM</TableHead>
                                <TableHead className="w-[20px] h-7 p-0"></TableHead>
                            </TableRow>
                        </TableHeader>
                        <TableBody>
                            {rows.length === 1 && rows[0]._state === 'new' && (
                                <TableRow className="hover:bg-transparent">
                                    <TableCell colSpan={10} className="py-8 text-center">
                                        <p className="text-xs text-muted-foreground animate-fade-up">
                                            Awaiting Production Manager sync. Start typing in the empty row, or paste a range from Excel.
                                        </p>
                                    </TableCell>
                                </TableRow>
                            )}
                            {rows.map((row, rowIdx) => {
                                const diff = (parseFloat(row.end_kwh) || 0) - (parseFloat(row.start_kwh) || 0);
                                const multiplier = parseFloat(row.meter_multiplier) || 0;
                                const consumption = diff >= 0 ? diff * multiplier : 0;
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
                                                <Input ref={focusNoScroll} value={row.reading_date} onChange={e => updateRow(rowIdx, 'reading_date', e.target.value)} className={cn(inputClass, 'font-mono text-center text-xs')} onPaste={e => { e.stopPropagation(); handleSmartPaste(e, rowIdx, 1); }} />
                                            </GridCell>
                                        </TableCell>
                                        {/* METER */}
                                        <TableCell className="px-0 py-0 border-r border-border/30" style={{ height: '28px' }}>
                                            <GridCell col={2} row={rowIdx} value={row.meter} className="font-mono text-center" {...commonCellProps} {...selProps(rowIdx, 2)}>
                                                {row._meter_select === '__custom__' ? (
                                                    <Input
                                                        ref={focusNoScroll}
                                                        value={row.meter}
                                                        onChange={e => updateRow(rowIdx, 'meter', e.target.value)}
                                                        className={cn(inputClass, 'font-mono text-center text-xs')}
                                                        placeholder="Meter name..."
                                                        onPaste={e => { e.stopPropagation(); handleSmartPaste(e, rowIdx, 2); }}
                                                    />
                                                ) : (
                                                    <Select value={row._meter_select} onValueChange={v => updateMeter(rowIdx, v)}>
                                                        <SelectTrigger className="h-8 w-full border-transparent bg-transparent rounded-none text-xs font-mono focus:ring-1 focus:ring-inset focus:ring-primary shadow-none px-1">
                                                            <SelectValue />
                                                        </SelectTrigger>
                                                        <SelectContent>
                                                            {METER_OPTIONS.map(opt => (
                                                                <SelectItem key={opt.value} value={opt.value} className="text-xs font-mono">{opt.label}</SelectItem>
                                                            ))}
                                                        </SelectContent>
                                                    </Select>
                                                )}
                                            </GridCell>
                                        </TableCell>
                                        {/* START KWH */}
                                        <TableCell className="px-0 py-0 border-r border-border/30" style={{ height: '28px' }}>
                                            <GridCell col={3} row={rowIdx} value={row.start_kwh} className="font-mono text-right pr-1" {...commonCellProps} {...selProps(rowIdx, 3)}>
                                                <Input ref={focusNoScroll} type="number" step="0.01" value={row.start_kwh} onChange={e => updateRow(rowIdx, 'start_kwh', e.target.value)} className={cn(inputClass, 'font-mono text-right text-xs')} onPaste={e => { e.stopPropagation(); handleSmartPaste(e, rowIdx, 3); }} />
                                            </GridCell>
                                        </TableCell>
                                        {/* END KWH */}
                                        <TableCell className="px-0 py-0 border-r border-border/30" style={{ height: '28px' }}>
                                            <GridCell col={4} row={rowIdx} value={row.end_kwh} className="font-mono text-right pr-1" {...commonCellProps} {...selProps(rowIdx, 4)}>
                                                <Input ref={focusNoScroll} type="number" step="0.01" value={row.end_kwh} onChange={e => updateRow(rowIdx, 'end_kwh', e.target.value)} className={cn(inputClass, 'font-mono text-right text-xs')} onPaste={e => { e.stopPropagation(); handleSmartPaste(e, rowIdx, 4); }} />
                                            </GridCell>
                                        </TableCell>
                                        {/* DIFF — computed */}
                                        <TableCell className="px-1 py-0 border-r border-border/30 bg-muted/20 font-mono text-right text-xs text-muted-foreground" style={{ height: '28px' }}>
                                            {diff >= 0 && diff !== 0 ? diff.toFixed(2) : ''}
                                        </TableCell>
                                        {/* MULT — editable meter multiplier */}
                                        <TableCell className="px-0 py-0 border-r border-border/30" style={{ height: '28px' }}>
                                            <GridCell col={6} row={rowIdx} value={row.meter_multiplier} className="font-mono text-right pr-1" {...commonCellProps} {...selProps(rowIdx, 6)}>
                                                <Input ref={focusNoScroll} type="number" step="0.01" value={row.meter_multiplier} onChange={e => updateRow(rowIdx, 'meter_multiplier', e.target.value)} className={cn(inputClass, 'font-mono text-right text-xs')} onPaste={e => { e.stopPropagation(); handleSmartPaste(e, rowIdx, 6); }} />
                                            </GridCell>
                                        </TableCell>
                                        {/* TTL KWH — computed (diff × multiplier) */}
                                        <TableCell className="px-1 py-0 border-r border-border/30 bg-muted/20 font-mono text-right text-xs" style={{ height: '28px' }}>
                                            {consumption > 0 ? consumption.toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : ''}
                                        </TableCell>
                                        {/* REMARKS */}
                                        <TableCell className="px-0 py-0 border-r border-border/30" style={{ height: '28px' }}>
                                            <GridCell
                                                col={8} row={rowIdx} value={row.remarks} className="text-center"
                                                {...commonCellProps} {...selProps(rowIdx, 8)}
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
            </div>
        </TooltipProvider>
    );
}
