'use client';

import * as React from 'react';
import { toast } from 'sonner';
import { errorToast } from '@/lib/toast';
import { Save, RotateCcw, MessageSquareText, X } from 'lucide-react';
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
import {
    TooltipProvider,
} from '@/components/ui/tooltip';
import { GridCell } from '@/components/shared/grid/GridCell';
import { RemarksCellAdaptor } from '@/components/shared/grid/RemarksCellAdaptor';
import { useCellSelection } from '@/lib/hooks/use-cell-selection';
import { useClipboardCopy } from '@/lib/hooks/use-clipboard-copy';
import { useCellDelete } from '@/lib/hooks/use-cell-delete';
import { useCellAggregation, type AggregationType } from '@/lib/hooks/use-cell-aggregation';
import { useStatusBar } from '@/components/providers/status-bar-context';
import { parseExcelDate, trimCellValue } from '@/lib/paste-utils';
import { saveBulkProductionRuns } from './actions';
import type { Tables, TablesInsert } from '@/types/supabase';

type ProductionRunRow = Tables<'production_runs'>;

const GRADES = ['3X50', '6X50', '8X50', '2X6'] as const;
const SHIFTS = ['M', 'E', 'N'] as const;

// Row state for dirty tracking
type RowState = 'existing' | 'new' | 'modified' | 'deleted';

interface GridRow {
    _state: RowState;
    _id?: string; // DB id for existing rows
    transaction_date: string;
    production_batch: string;
    grade: string;
    shift: string;
    ttl_kg: string;
    sacks_bags: string;
    remarks: string;
}

// Column map: visual col index → field key (null = read-only/skip)
const COL_MAP: (keyof GridRow | null)[] = [
    null,              // 0: row number
    'transaction_date', // 1
    'production_batch', // 2
    'grade',           // 3
    'shift',           // 4
    'ttl_kg',          // 5
    'sacks_bags',      // 6
    'remarks',         // 7
    null,              // 8: delete button
];

const COL_COUNT = COL_MAP.length;

const NUMERIC_COLS = new Set<keyof GridRow>(['ttl_kg', 'sacks_bags']);

function createEmptyRow(): GridRow {
    return {
        _state: 'new',
        transaction_date: new Date().toISOString().split('T')[0],
        production_batch: '',
        grade: '3X50',
        shift: 'M',
        ttl_kg: '',
        sacks_bags: '',
        remarks: '',
    };
}

function dbRowToGridRow(r: ProductionRunRow): GridRow {
    return {
        _state: 'existing',
        _id: r.id,
        transaction_date: r.transaction_date ?? '',
        production_batch: r.production_batch ?? '',
        grade: r.grade ?? '3X50',
        shift: r.shift ?? 'M',
        ttl_kg: r.ttl_kg != null ? String(r.ttl_kg) : '',
        sacks_bags: r.sacks_bags != null ? String(r.sacks_bags) : '',
        remarks: r.remarks ?? '',
    };
}

function cleanPasteValue(raw: string, field: keyof GridRow): string {
    const val = trimCellValue(raw);
    if (field === 'transaction_date') return parseExcelDate(val);
    if (NUMERIC_COLS.has(field)) return val.replace(/[₱,"']/g, '');
    return val;
}

const inputClass =
    'h-8 w-full px-1 border-transparent bg-transparent rounded-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-primary focus-visible:bg-accent/10 transition-colors shadow-none';

function focusCell(container: HTMLElement | null, row: number, col: number) {
    if (!container) return;
    const target = container.querySelector<HTMLElement>(`[data-row="${row}"][data-col="${col}"]`);
    target?.focus();
}

interface ProductionRunsGridProps {
    initialData: ProductionRunRow[];
    onSaveSuccess: () => void;
}

export function ProductionRunsGrid({ initialData, onSaveSuccess }: ProductionRunsGridProps) {
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

    // ── Cell selection ──────────────────────────────────────────────────────
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
            if (field === 'ttl_kg' || field === 'sacks_bags') return 'SUM';
            return null;
        },
        []
    );

    const aggregates = useCellAggregation({
        range: cellSelection.range,
        getNumericCellValue,
        getColumnDefaultCalcType,
    });

    React.useEffect(() => {
        const count = cellSelection.range ? cellSelection.getSelectionSize() : 0;
        const timer = setTimeout(() => {
            setCellSelectionCount(count);
            setCellAggregates(count > 1 ? aggregates : null);
        }, 50);
        return () => {
            clearTimeout(timer);
            setCellSelectionCount(0);
            setCellAggregates(null);
        };
    }, [cellSelection.range, cellSelection.getSelectionSize, setCellSelectionCount, setCellAggregates, aggregates]);

    const { handleKeyDown: handleCopyKeyDown } = useClipboardCopy({
        getSelectedRange: cellSelection.getSelectedRange,
        getCellValue,
        getSelectionSize: cellSelection.getSelectionSize,
    });

    // ── Mouse drag ──────────────────────────────────────────────────────────
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
                setIsEditing(false);
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

    // ── Row management ──────────────────────────────────────────────────────
    const updateRow = React.useCallback(
        (idx: number, field: keyof GridRow, value: string) => {
            setRows(prev => {
                const next = [...prev];
                const row = { ...next[idx], [field]: value };
                if (row._state === 'existing') row._state = 'modified';
                next[idx] = row;
                // Ensure trailing empty row
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
                // Remove unsaved new rows directly
                if (next.length > 1) {
                    next.splice(idx, 1);
                    return next;
                }
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
            row._state = row._id ? 'existing' : 'new';
            next[idx] = row;
            return next;
        });
    }, []);

    const clearCell = React.useCallback(
        (rowIdx: number, colIdx: number) => {
            const field = COL_MAP[colIdx];
            if (field && field !== '_state' && field !== '_id') {
                updateRow(rowIdx, field, '');
            }
        },
        [updateRow]
    );

    const { handleKeyDown: handleDeleteKeyDown } = useCellDelete({
        getSelectedRange: cellSelection.getSelectedRange,
        getSelectionSize: cellSelection.getSelectionSize,
        clearCell,
    });

    // ── Editing ─────────────────────────────────────────────────────────────
    const startEditing = React.useCallback(
        (rowIdx: number, colIdx: number, initialChar?: string) => {
            const field = COL_MAP[colIdx];
            if (!field) return;
            const row = rows[rowIdx];
            preEditValue.current = row ? String(row[field] ?? '') : '';
            setActiveCell({ row: rowIdx, col: colIdx });
            setIsEditing(true);
            if (initialChar !== undefined) {
                updateRow(rowIdx, field, initialChar);
            }
        },
        [rows, updateRow]
    );

    const revertChanges = React.useCallback(() => {
        if (!activeCell) return;
        const field = COL_MAP[activeCell.col];
        if (field && field !== '_state' && field !== '_id') {
            setRows(prev => {
                const next = [...prev];
                const row = { ...next[activeCell.row] };
                (row as Record<string, unknown>)[field] = preEditValue.current;
                if (row._state === 'modified' && row._id) row._state = 'existing';
                next[activeCell.row] = row;
                return next;
            });
        }
        setIsEditing(false);
        gridRef.current?.focus();
    }, [activeCell]);

    // ── Keyboard navigation ─────────────────────────────────────────────────
    const moveActive = React.useCallback(
        (key: string, shift: boolean) => {
            if (!activeCell) return;
            let { row, col } = activeCell;

            if (key === 'ArrowUp' || (key === 'Enter' && shift)) {
                row = Math.max(0, row - 1);
            } else if (key === 'ArrowDown' || (key === 'Enter' && !shift)) {
                row = Math.min(rows.length - 1, row + 1);
            } else if (key === 'ArrowLeft') {
                do { col--; } while (col > 0 && COL_MAP[col] === null);
                col = Math.max(0, col);
            } else if (key === 'ArrowRight') {
                do { col++; } while (col < COL_COUNT - 1 && COL_MAP[col] === null);
                col = Math.min(COL_COUNT - 1, col);
            } else if (key === 'Tab') {
                if (shift) {
                    do {
                        col--;
                        if (col < 0) { row--; col = COL_COUNT - 1; }
                    } while (row >= 0 && COL_MAP[col] === null);
                    if (row < 0) { row = 0; col = activeCell.col; }
                } else {
                    do {
                        col++;
                        if (col >= COL_COUNT) { row++; col = 0; }
                    } while (row < rows.length && COL_MAP[col] === null);
                    if (row >= rows.length) { row = rows.length - 1; col = activeCell.col; }
                }
            } else if (key === 'Home') {
                col = 1;
            } else if (key === 'End') {
                col = COL_COUNT - 2;
            }

            setActiveCell({ row, col });
        },
        [activeCell, rows.length]
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
                if ((e.metaKey || e.ctrlKey) && e.key === 'c') {
                    handleCopyKeyDown(e);
                    return;
                }
                if (e.key === 'Backspace' || e.key === 'Delete') {
                    handleDeleteKeyDown(e);
                    cellSelection.clearSelection();
                    return;
                }
                if (e.key === 'Escape') {
                    e.preventDefault();
                    cellSelection.clearSelection();
                    return;
                }
                if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Tab', 'Enter'].includes(e.key)) {
                    cellSelection.clearSelection();
                }
                if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
                    const range = cellSelection.range;
                    if (range) {
                        cellSelection.clearSelection();
                        setActiveCell({ row: range.startRow, col: range.startCol });
                    }
                }
            }

            if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Tab', 'Enter', 'Home', 'End'].includes(e.key)) {
                e.preventDefault();
                if (
                    e.shiftKey &&
                    ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key) &&
                    !isRangeSelected
                ) {
                    cellSelection.handleCellMouseDown(activeCell.row, activeCell.col, {
                        shiftKey: false,
                        button: 0,
                        preventDefault: () => {},
                    } as unknown as React.MouseEvent);
                    cellSelection.handleMouseUp();
                    cellSelection.handleKeyDown(e);
                    return;
                }
                moveActive(e.key, e.shiftKey);
                return;
            }

            if (e.key === 'F2') {
                e.preventDefault();
                startEditing(activeCell.row, activeCell.col);
                return;
            }
            if (e.key === 'Backspace' || e.key === 'Delete') {
                e.preventDefault();
                startEditing(activeCell.row, activeCell.col, '');
                return;
            }
            if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
                e.preventDefault();
                startEditing(activeCell.row, activeCell.col, e.key);
            }
        },
        [activeCell, isEditing, cellSelection, handleCopyKeyDown, handleDeleteKeyDown, revertChanges, moveActive, startEditing]
    );

    // ── Paste ───────────────────────────────────────────────────────────────
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
                        if (!field || field === '_state' || field === '_id') return;
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

    // ── Dirty state ──────────────────────────────────────────────────────────
    const isDirty = rows.some(r => r._state === 'new' && (r.production_batch || r.ttl_kg) || r._state === 'modified' || r._state === 'deleted');

    const handleDiscard = React.useCallback(() => {
        const base = initialData.map(dbRowToGridRow);
        setRows([...base, createEmptyRow()]);
        setActiveCell(null);
        setIsEditing(false);
    }, [initialData]);

    // ── Save ─────────────────────────────────────────────────────────────────
    const handleSave = async () => {
        setIsSaving(true);
        try {
            const inserts: Parameters<typeof saveBulkProductionRuns>[0]['inserts'] = [];
            const updates: Parameters<typeof saveBulkProductionRuns>[0]['updates'] = [];
            const deletes: string[] = [];

            for (const row of rows) {
                if (row._state === 'deleted' && row._id) {
                    deletes.push(row._id);
                } else if (row._state === 'new' && (row.production_batch.trim() || row.ttl_kg)) {
                    inserts.push({
                        transaction_date: row.transaction_date,
                        production_batch: row.production_batch,
                        grade: row.grade,
                        shift: row.shift,
                        ttl_kg: parseFloat(row.ttl_kg) || 0,
                        sacks_bags: row.sacks_bags ? parseInt(row.sacks_bags) : null,
                        remarks: row.remarks || null,
                    });
                } else if (row._state === 'modified' && row._id) {
                    updates.push({
                        id: row._id,
                        data: {
                            transaction_date: row.transaction_date,
                            production_batch: row.production_batch,
                            grade: row.grade,
                            shift: row.shift,
                            ttl_kg: parseFloat(row.ttl_kg) || 0,
                            sacks_bags: row.sacks_bags ? parseInt(row.sacks_bags) : null,
                            remarks: row.remarks || null,
                        },
                    });
                }
            }

            if (!inserts.length && !updates.length && !deletes.length) {
                toast.info('No changes to save.');
                setIsSaving(false);
                return;
            }

            const res = await saveBulkProductionRuns({ inserts, updates, deletes });
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

    // ── Selection props helper ───────────────────────────────────────────────
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

    const visibleRows = rows;

    return (
        <TooltipProvider>
            <div className="flex flex-col min-w-[620px]">
                {/* Grid toolbar */}
                <div className="flex items-center justify-between px-2 py-1 border-b bg-muted/30">
                    <span className="text-[10px] font-mono font-bold uppercase tracking-wider text-muted-foreground">
                        PRODUCTION OUTPUT
                    </span>
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
                    className="border-b outline-none select-none overflow-auto relative max-h-[50vh]"
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
                    <table className="w-full table-fixed text-xs border-collapse relative">
                        <TableHeader className="bg-muted/90 backdrop-blur-sm sticky top-0 z-50 shadow-sm">
                            <TableRow className="hover:bg-transparent border-b border-foreground/20" style={{ height: '28px' }}>
                                <TableHead className="w-[28px] h-7 px-1 py-0 font-mono font-bold text-center text-[10px] border-r border-foreground/10">#</TableHead>
                                <TableHead className="w-[80px] h-7 px-1 py-0 font-mono font-bold text-center text-[10px] border-r border-foreground/10">DATE</TableHead>
                                <TableHead className="w-[100px] h-7 px-1 py-0 font-mono font-bold text-center text-[10px] border-r border-foreground/10">BATCH</TableHead>
                                <TableHead className="w-[60px] h-7 px-1 py-0 font-mono font-bold text-center text-[10px] border-r border-foreground/10">GRADE</TableHead>
                                <TableHead className="w-[44px] h-7 px-1 py-0 font-mono font-bold text-center text-[10px] border-r border-foreground/10">SHIFT</TableHead>
                                <TableHead className="w-[70px] h-7 px-1 py-0 font-mono font-bold text-right text-[10px] border-r border-foreground/10">TTL KG</TableHead>
                                <TableHead className="w-[50px] h-7 px-1 py-0 font-mono font-bold text-right text-[10px] border-r border-foreground/10">BAGS</TableHead>
                                <TableHead className="w-[50px] h-7 px-1 py-0 font-mono font-bold text-center text-[10px] border-r border-foreground/10">REM</TableHead>
                                <TableHead className="w-[20px] h-7 p-0"></TableHead>
                            </TableRow>
                        </TableHeader>
                        <TableBody>
                            {visibleRows.length === 1 && visibleRows[0]._state === 'new' && (
                                <TableRow className="hover:bg-transparent">
                                    <TableCell colSpan={9} className="py-8 text-center">
                                        <p className="text-xs text-muted-foreground animate-fade-up">
                                            Awaiting Production Manager sync. Start typing in the empty row, or paste a range from Excel.
                                        </p>
                                    </TableCell>
                                </TableRow>
                            )}
                            {visibleRows.map((row, rowIdx) => (
                                <GridRowComponent
                                    key={rowIdx}
                                    row={row}
                                    rowIdx={rowIdx}
                                    totalRows={visibleRows.length}
                                    updateRow={updateRow}
                                    markDeleted={markDeleted}
                                    restoreRow={restoreRow}
                                    onPaste={handleSmartPaste}
                                    commonCellProps={commonCellProps}
                                    selProps={selProps}
                                />
                            ))}
                        </TableBody>
                    </table>
                </div>
            </div>
        </TooltipProvider>
    );
}

// ── Row component ─────────────────────────────────────────────────────────────

interface GridRowComponentProps {
    row: GridRow;
    rowIdx: number;
    totalRows: number;
    updateRow: (idx: number, field: keyof GridRow, value: string) => void;
    markDeleted: (idx: number) => void;
    restoreRow: (idx: number) => void;
    onPaste: (e: React.ClipboardEvent, row: number, col: number) => void;
    commonCellProps: {
        activeCell: { row: number; col: number } | null;
        isEditing: boolean;
        setActiveCell: (cell: { row: number; col: number }) => void;
        setIsEditing: (editing: boolean) => void;
        onStartEditing: (row: number, col: number, char?: string) => void;
        onRevert: () => void;
        gridRef: React.RefObject<HTMLDivElement | null>;
    };
    selProps: (rowIdx: number, colIdx: number) => {
        onCellMouseDown: (e: React.MouseEvent) => void;
        onCellMouseUp: () => void;
        onCellMouseEnter: () => void;
        isCellRangeSelected: boolean;
        isCellRangeAnchor: boolean;
        isDragActive: boolean;
    };
}

const GridRowComponent = React.memo(function GridRowComponent({
    row,
    rowIdx,
    updateRow,
    markDeleted,
    restoreRow,
    onPaste,
    commonCellProps,
    selProps,
}: GridRowComponentProps) {
    const isDeleted = row._state === 'deleted';
    const isDirtyRow = row._state === 'modified' || row._state === 'new';

    return (
        <TableRow
            className={cn(
                'transition-all duration-150 border-b border-border/30',
                isDeleted && 'opacity-40 line-through',
                isDirtyRow && row._state !== 'new' && 'border-l-2 border-l-amber-400'
            )}
            style={{ height: '28px' }}
        >
            {/* Row number */}
            <TableCell className="px-1 py-0 text-center font-mono text-[10px] text-muted-foreground border-r border-border/30" style={{ height: '28px' }}>
                {rowIdx + 1}
            </TableCell>

            {/* DATE */}
            <TableCell className="px-0 py-0 border-r border-border/30" style={{ height: '28px' }}>
                <GridCell col={1} row={rowIdx} value={row.transaction_date} className="font-mono text-center" {...commonCellProps} {...selProps(rowIdx, 1)}>
                    <Input
                        autoFocus
                        value={row.transaction_date}
                        onChange={e => updateRow(rowIdx, 'transaction_date', e.target.value)}
                        className={cn(inputClass, 'font-mono text-center text-xs')}
                        onPaste={e => { e.stopPropagation(); onPaste(e, rowIdx, 1); }}
                    />
                </GridCell>
            </TableCell>

            {/* BATCH */}
            <TableCell className="px-0 py-0 border-r border-border/30" style={{ height: '28px' }}>
                <GridCell col={2} row={rowIdx} value={row.production_batch} className="font-mono text-center" {...commonCellProps} {...selProps(rowIdx, 2)}>
                    <Input
                        autoFocus
                        value={row.production_batch}
                        onChange={e => updateRow(rowIdx, 'production_batch', e.target.value)}
                        className={cn(inputClass, 'font-mono text-xs')}
                        onPaste={e => { e.stopPropagation(); onPaste(e, rowIdx, 2); }}
                    />
                </GridCell>
            </TableCell>

            {/* GRADE */}
            <TableCell className="px-0 py-0 border-r border-border/30" style={{ height: '28px' }}>
                <GridCell
                    col={3}
                    row={rowIdx}
                    value={row.grade}
                    className="font-mono text-center"
                    {...commonCellProps}
                    {...selProps(rowIdx, 3)}
                >
                    <Select
                        value={row.grade}
                        onValueChange={v => updateRow(rowIdx, 'grade', v)}
                    >
                        <SelectTrigger className="h-8 w-full border-transparent bg-transparent rounded-none text-xs font-mono focus:ring-1 focus:ring-inset focus:ring-primary shadow-none px-1">
                            <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                            {GRADES.map(g => (
                                <SelectItem key={g} value={g} className="text-xs font-mono">{g}</SelectItem>
                            ))}
                        </SelectContent>
                    </Select>
                </GridCell>
            </TableCell>

            {/* SHIFT */}
            <TableCell className="px-0 py-0 border-r border-border/30" style={{ height: '28px' }}>
                <GridCell
                    col={4}
                    row={rowIdx}
                    value={row.shift}
                    className="font-mono text-center"
                    {...commonCellProps}
                    {...selProps(rowIdx, 4)}
                >
                    <Select
                        value={row.shift}
                        onValueChange={v => updateRow(rowIdx, 'shift', v)}
                    >
                        <SelectTrigger className="h-8 w-full border-transparent bg-transparent rounded-none text-xs font-mono focus:ring-1 focus:ring-inset focus:ring-primary shadow-none px-1">
                            <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                            {SHIFTS.map(s => (
                                <SelectItem key={s} value={s} className="text-xs font-mono">{s}</SelectItem>
                            ))}
                        </SelectContent>
                    </Select>
                </GridCell>
            </TableCell>

            {/* TTL KG */}
            <TableCell className="px-0 py-0 border-r border-border/30" style={{ height: '28px' }}>
                <GridCell col={5} row={rowIdx} value={row.ttl_kg} className="font-mono text-right pr-1" {...commonCellProps} {...selProps(rowIdx, 5)}>
                    <Input
                        autoFocus
                        type="number"
                        step="1"
                        value={row.ttl_kg}
                        onChange={e => updateRow(rowIdx, 'ttl_kg', e.target.value)}
                        className={cn(inputClass, 'font-mono text-right text-xs')}
                        onPaste={e => { e.stopPropagation(); onPaste(e, rowIdx, 5); }}
                    />
                </GridCell>
            </TableCell>

            {/* SACKS/BAGS */}
            <TableCell className="px-0 py-0 border-r border-border/30" style={{ height: '28px' }}>
                <GridCell col={6} row={rowIdx} value={row.sacks_bags} className="font-mono text-right pr-1" {...commonCellProps} {...selProps(rowIdx, 6)}>
                    <Input
                        autoFocus
                        type="number"
                        step="1"
                        value={row.sacks_bags}
                        onChange={e => updateRow(rowIdx, 'sacks_bags', e.target.value)}
                        className={cn(inputClass, 'font-mono text-right text-xs')}
                        onPaste={e => { e.stopPropagation(); onPaste(e, rowIdx, 6); }}
                    />
                </GridCell>
            </TableCell>

            {/* REMARKS */}
            <TableCell className="px-0 py-0 border-r border-border/30" style={{ height: '28px' }}>
                <GridCell
                    col={7}
                    row={rowIdx}
                    value={row.remarks}
                    className="text-center"
                    {...commonCellProps}
                    {...selProps(rowIdx, 7)}
                    displayValue={
                        <div className={cn('h-6 w-6 flex items-center justify-center rounded-sm', row.remarks ? 'text-primary' : 'text-muted-foreground/30')}>
                            <MessageSquareText className="w-3 h-3" />
                        </div>
                    }
                >
                    <RemarksCellAdaptor
                        value={row.remarks}
                        onChange={v => updateRow(rowIdx, 'remarks', v)}
                        onClose={() => commonCellProps.setIsEditing(false)}
                        onRevert={commonCellProps.onRevert}
                        fontSize={11}
                    />
                </GridCell>
            </TableCell>

            {/* Delete / restore */}
            <TableCell className="p-0 w-[20px]" style={{ height: '28px' }}>
                <button
                    className={cn(
                        'h-full w-full flex items-center justify-center transition-colors',
                        isDeleted
                            ? 'text-muted-foreground hover:text-foreground'
                            : 'text-muted-foreground/40 hover:text-destructive'
                    )}
                    onClick={() => isDeleted ? restoreRow(rowIdx) : markDeleted(rowIdx)}
                    tabIndex={-1}
                    type="button"
                    title={isDeleted ? 'Restore row' : 'Delete row'}
                >
                    {isDeleted ? (
                        <RotateCcw className="w-3 h-3" />
                    ) : (
                        <X className="w-3 h-3" />
                    )}
                </button>
            </TableCell>
        </TableRow>
    );
});
