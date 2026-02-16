'use client';

import * as React from 'react';
import { toast } from 'sonner';
import { Plus, X, MessageSquareText, PencilLine, MessageSquarePlus } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Textarea } from '@/components/ui/textarea';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
} from '@/components/ui/table';
import {
    Tooltip,
    TooltipContent,
    TooltipProvider,
    TooltipTrigger,
} from '@/components/ui/tooltip';
import {
    Popover,
    PopoverContent,
    PopoverTrigger,
} from '@/components/ui/popover';
import { submitBulkUsage, bulkUpdateUsage } from './actions';
import { useTableSettings } from '@/components/providers/table-settings';
import { COLUMN_MAP, cleanCellValue } from './paste-utils';
import { useCellSelection } from '@/lib/hooks/use-cell-selection';
import { useClipboardCopy } from '@/lib/hooks/use-clipboard-copy';
import { useCellDelete } from '@/lib/hooks/use-cell-delete';
import { useStatusBar } from '@/components/providers/status-bar-context';
import type { InputRcOutRow, RcOutInput, RcOutRow } from '@/types/rc-out';
import { AutocompletePopover, type AutocompleteItem } from '@/components/shared/AutocompletePopover';
import { GridCell } from '@/components/shared/grid/GridCell';
import { RemarksCellAdaptor } from '@/components/shared/grid/RemarksCellAdaptor';

// --- TYPES ---
type Batch = {
    id: string;
    batch_code: string;
    location_ref: string;
};

const createEmptyRow = (): InputRcOutRow => ({
    transaction_date: new Date().toISOString().split('T')[0],
    production_batch: '',
    batch_code: '',
    destination: '',
    weight_kg: '',
    block_loc: '',
    remarks: '',
});

/** Convert an RcOutRow (from DB) into an InputRcOutRow (for the grid editor) */
function rcOutToInputRow(d: RcOutRow): InputRcOutRow {
    return {
        transaction_date: d.transaction_date ?? '',
        production_batch: d.production_batch ?? '',
        batch_code: d.batches?.batch_code ?? '',
        destination: d.destination ?? '',
        weight_kg: d.weight_kg ?? '',
        block_loc: d.block_loc ?? '',
        remarks: d.remarks ?? '',
    };
}

const inputClass = "h-8 w-full px-1 border-transparent bg-transparent rounded-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-primary focus-visible:bg-accent/10 transition-colors shadow-none";

// --- MAIN COMPONENT ---

type BulkUsageInputProps = {
    batches: Batch[];
    destinations: string[];
    productionBatches: string[];
    onSuccess?: () => void;
    mode?: 'create' | 'edit';
    initialData?: RcOutRow[];
    onDirtyChange?: (isDirty: boolean) => void;
};

export function BulkUsageInput({ batches, destinations, productionBatches, onSuccess, mode = 'create', initialData, onDirtyChange }: BulkUsageInputProps) {
    const { fontSize, rowHeight } = useTableSettings();
    const { setCellSelectionCount } = useStatusBar();
    const isEdit = mode === 'edit';

    // In edit mode, store original IDs aligned by row index
    const rowIdsRef = React.useRef<string[]>(initialData?.map(d => d.id) ?? []);
    const gridRef = React.useRef<HTMLDivElement>(null);

    const [rows, setRows] = React.useState<InputRcOutRow[]>(() => {
        if (initialData && initialData.length > 0) {
            return initialData.map(rcOutToInputRow);
        }
        return [createEmptyRow()];
    });
    // Track audit comments by row index for edit mode
    const [auditComments, setAuditComments] = React.useState<Record<number, string>>({});

    const [isSubmitting, setIsSubmitting] = React.useState(false);
    const [activeCell, setActiveCell] = React.useState<{ row: number; col: number } | null>(null);
    const [isEditing, setIsEditing] = React.useState(false);
    const preEditValue = React.useRef<InputRcOutRow[keyof InputRcOutRow] | null>(null);

    // --- Cell range selection ---
    const cellSelection = useCellSelection({
        rowCount: rows.length,
        colCount: COLUMN_MAP.length,
        isSelectableColumn: (colIdx) => COLUMN_MAP[colIdx] !== null,
        scrollContainerRef: gridRef,
        enabled: true,
    });

    // Push cell selection count to shared context
    const selectionSize = cellSelection.getSelectionSize();
    React.useEffect(() => {
        const count = cellSelection.range ? selectionSize : 0;
        setCellSelectionCount(count);
        return () => setCellSelectionCount(0);
    }, [cellSelection.range, selectionSize, setCellSelectionCount]);

    const getCellValue = React.useCallback((rowIdx: number, colIdx: number): string => {
        const row = rows[rowIdx];
        if (!row) return '';
        const field = COLUMN_MAP[colIdx];
        if (!field) return '';
        const val = row[field];
        return val != null ? String(val) : '';
    }, [rows]);

    const { handleKeyDown: handleCopyKeyDown } = useClipboardCopy({
        getSelectedRange: cellSelection.getSelectedRange,
        getCellValue,
        getSelectionSize: cellSelection.getSelectionSize,
    });

    // --- Mouse tracking for click-vs-drag ---
    const mouseDownCellRef = React.useRef<{ row: number; col: number } | null>(null);

    const handleGridCellMouseDown = React.useCallback((rowIdx: number, colIdx: number, e: React.MouseEvent) => {
        mouseDownCellRef.current = { row: rowIdx, col: colIdx };
        cellSelection.handleCellMouseDown(rowIdx, colIdx, e);
    }, [cellSelection]);

    const handleGridCellMouseUp = React.useCallback((rowIdx: number, colIdx: number) => {
        const downCell = mouseDownCellRef.current;
        mouseDownCellRef.current = null;
        // If mouse up on same cell as mouse down and no range formed -> single cell click
        if (downCell && downCell.row === rowIdx && downCell.col === colIdx && cellSelection.getSelectionSize() <= 1) {
            setActiveCell({ row: rowIdx, col: colIdx });
            setIsEditing(false);
            cellSelection.clearSelection();
            gridRef.current?.focus();
        }
    }, [cellSelection]);

    const handleGridCellMouseEnter = React.useCallback((rowIdx: number, colIdx: number) => {
        // Use mouseDownCellRef (set synchronously) instead of cellSelection.isDragging (stale state)
        if (mouseDownCellRef.current) {
            cellSelection.handleCellMouseEnter(rowIdx, colIdx);
        }
    }, [cellSelection]);

    // --- ROW MANAGEMENT ---
    const addRow = React.useCallback(() => {
        setRows(prev => [...prev, createEmptyRow()]);
    }, []);

    const removeRow = React.useCallback((index: number) => {
        setRows(prev => prev.length > 1 ? prev.filter((_, i) => i !== index) : prev);
        setAuditComments(prev => {
            const next = { ...prev };
            delete next[index];
            return next;
        });
    }, []);

    const updateRow = React.useCallback((index: number, field: keyof InputRcOutRow, value: InputRcOutRow[keyof InputRcOutRow]) => {
        setRows(prev => {
            const newRows = [...prev];
            newRows[index] = { ...newRows[index], [field]: value };
            return newRows;
        });
    }, []);

    const updateRowFields = React.useCallback((index: number, updates: Partial<InputRcOutRow>) => {
        setRows(prev => {
            const newRows = [...prev];
            newRows[index] = { ...newRows[index], ...updates };
            return newRows;
        });
    }, []);

    const clearCellByIndex = React.useCallback((rowIdx: number, colIdx: number) => {
        const field = COLUMN_MAP[colIdx];
        if (field) {
            updateRow(rowIdx, field, '');
        }
    }, [updateRow]);

    const { handleKeyDown: handleDeleteKeyDown } = useCellDelete({
        getSelectedRange: cellSelection.getSelectedRange,
        getSelectionSize: cellSelection.getSelectionSize,
        clearCell: clearCellByIndex,
    });

    const isRangeSelected = cellSelection.getSelectionSize() > 1;

    const startEditing = React.useCallback((rowIdx: number, colIdx: number, initialChar?: string) => {
        const field = COLUMN_MAP[colIdx];
        if (!field) return;

        const currentRow = rows[rowIdx];
        const currentValue = currentRow ? currentRow[field] : '';
        preEditValue.current = currentValue;

        setActiveCell({ row: rowIdx, col: colIdx });
        setIsEditing(true);

        if (initialChar !== undefined) {
            updateRow(rowIdx, field, initialChar);
        }
    }, [rows, updateRow]);

    const revertChanges = React.useCallback(() => {
        if (!activeCell) return;
        if (preEditValue.current !== null) {
            const field = COLUMN_MAP[activeCell.col];
            if (field) {
                updateRow(activeCell.row, field, preEditValue.current);
            }
        }
        setIsEditing(false);
        gridRef.current?.focus();
    }, [activeCell, updateRow]);

    // --- GRID NAVIGATION ---
    const handleGridKeyDown = React.useCallback((e: React.KeyboardEvent) => {
        if (!activeCell) return;

        if (isEditing) {
            if (e.key === 'Escape') {
                e.preventDefault();
                e.stopPropagation();
                e.nativeEvent.stopImmediatePropagation();
                revertChanges();
            } else if (e.key === 'Enter' || e.key === 'Tab') {
                e.preventDefault();
                setIsEditing(false);
                moveSelection(e.key, e.shiftKey);
                gridRef.current?.focus();
            }
            return;
        }

        // --- Range selection mode handling ---
        if (isRangeSelected) {
            // Shift+Arrow -> extend selection
            if (e.shiftKey && ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key)) {
                e.preventDefault();
                cellSelection.handleKeyDown(e);
                return;
            }
            // Copy (Ctrl+C)
            if ((e.metaKey || e.ctrlKey) && e.key === 'c') {
                handleCopyKeyDown(e);
                return;
            }
            // Delete/Backspace -> clear selected cells
            if (e.key === 'Backspace' || e.key === 'Delete') {
                handleDeleteKeyDown(e);
                cellSelection.clearSelection();
                return;
            }
            // Escape -> clear range
            if (e.key === 'Escape') {
                e.preventDefault();
                cellSelection.clearSelection();
                return;
            }
            // Non-shift nav keys -> exit range, do normal single-cell nav
            if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Tab', 'Enter'].includes(e.key)) {
                cellSelection.clearSelection();
                // fall through to existing nav below
            }
            // Printable char -> exit range, start editing anchor cell
            if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
                const anchor = cellSelection.range;
                if (anchor) {
                    cellSelection.clearSelection();
                    setActiveCell({ row: anchor.startRow, col: anchor.startCol });
                }
                // fall through to existing char handling below
            }
        }

        if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Tab', 'Enter'].includes(e.key)) {
            e.preventDefault();
            // Shift+Arrow from single cell -> enter range selection
            if (e.shiftKey && ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key) && !isRangeSelected) {
                cellSelection.handleCellMouseDown(activeCell.row, activeCell.col, { shiftKey: false, preventDefault: () => {} } as unknown as React.MouseEvent);
                cellSelection.handleMouseUp();
                cellSelection.handleKeyDown(e);
                return;
            }
            moveSelection(e.key, e.shiftKey);
            return;
        }

        if (e.key === 'F2') {
            e.preventDefault();
            startEditing(activeCell.row, activeCell.col);
            return;
        }

        if (e.key === 'Backspace' || e.key === 'Delete') {
            e.preventDefault();
            const field = COLUMN_MAP[activeCell.col];
            if (field) {
                startEditing(activeCell.row, activeCell.col, '');
            }
            return;
        }

        // Copy (Ctrl+C) for single cell
        if ((e.metaKey || e.ctrlKey) && e.key === 'c') {
            handleCopyKeyDown(e);
            return;
        }

        // Printable characters -> Enter edit mode with value
        if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
            const field = COLUMN_MAP[activeCell.col];
            if (field) {
                e.preventDefault();
                startEditing(activeCell.row, activeCell.col, e.key);
            }
        }
    }, [activeCell, isEditing, rows, updateRow, startEditing, revertChanges, isRangeSelected, handleCopyKeyDown, handleDeleteKeyDown, cellSelection]);

    const moveSelection = (key: string, shift: boolean) => {
        if (!activeCell) return;
        let { row, col } = activeCell;

        if (key === 'ArrowUp' || (key === 'Enter' && shift)) {
            row = Math.max(0, row - 1);
        } else if (key === 'ArrowDown' || (key === 'Enter' && !shift)) {
            row = Math.min(rows.length - 1, row + 1);
        } else if (key === 'ArrowLeft') {
            do { col--; } while (col > 0 && COLUMN_MAP[col] === null);
            col = Math.max(0, col);
        } else if (key === 'ArrowRight') {
            do { col++; } while (col < COLUMN_MAP.length && COLUMN_MAP[col] === null);
            col = Math.min(COLUMN_MAP.length - 1, col);
        } else if (key === 'Tab') {
            if (shift) {
                do {
                    col--;
                    if (col < 0) { row--; col = COLUMN_MAP.length - 1; }
                } while (row >= 0 && COLUMN_MAP[col] === null);
                if (row < 0) { row = 0; col = activeCell.col; }
            } else {
                do {
                    col++;
                    if (col >= COLUMN_MAP.length) { row++; col = 0; }
                } while (row < rows.length && COLUMN_MAP[col] === null);
                if (row >= rows.length) { row = rows.length - 1; col = activeCell.col; }
            }
        }

        setActiveCell({ row, col });
    };

    // --- PASTE LOGIC ---
    const handleSmartPaste = React.useCallback((e: React.ClipboardEvent, startRowIndex: number, startColIndex: number) => {
        e.preventDefault();
        const clipboardData = e.clipboardData.getData('text');
        if (!clipboardData) return;

        const pastedRows = clipboardData.split(/\r\n|\n|\r/).filter(row => row.trim() !== '');
        if (pastedRows.length === 0) return;

        setRows(prev => {
            const newRows = [...prev];

            pastedRows.forEach((pastedRow, rOffset) => {
                const targetRowIndex = startRowIndex + rOffset;
                const columns = pastedRow.split('\t');

                if (targetRowIndex >= newRows.length) {
                    newRows.push(createEmptyRow());
                }

                columns.forEach((cellValue, cOffset) => {
                    const targetColIndex = startColIndex + cOffset;

                    if (targetColIndex < COLUMN_MAP.length) {
                        const fieldKey = COLUMN_MAP[targetColIndex];

                        if (fieldKey) {
                            newRows[targetRowIndex] = {
                                ...newRows[targetRowIndex],
                                [fieldKey]: cleanCellValue(cellValue, fieldKey)
                            };
                        }
                    }
                });
            });

            return newRows;
        });

        toast.success(`Pasted ${pastedRows.length} rows`);
    }, []);

    const handleGridPaste = React.useCallback((e: React.ClipboardEvent) => {
        if (!isEditing && activeCell) {
            handleSmartPaste(e, activeCell.row, activeCell.col);
            cellSelection.clearSelection();
        }
    }, [isEditing, activeCell, handleSmartPaste, cellSelection]);

    // --- DIRTY CHECKING ---
    React.useEffect(() => {
        if (!onDirtyChange) return;

        let isDirty = false;

        if (mode === 'create') {
            if (rows.length > 1) {
                isDirty = true;
            } else {
                const r = rows[0];
                const hasData = r.batch_code || r.destination || r.production_batch ||
                    !!r.weight_kg || r.remarks;
                if (hasData) isDirty = true;
            }
        } else if (mode === 'edit' && initialData) {
            if (rows.length !== initialData.length) {
                isDirty = true;
            } else {
                for (let i = 0; i < rows.length; i++) {
                    const row = rows[i];
                    const initial = rcOutToInputRow(initialData[i]);

                    const diff =
                        row.transaction_date !== initial.transaction_date ||
                        row.production_batch !== initial.production_batch ||
                        row.batch_code !== initial.batch_code ||
                        row.destination !== initial.destination ||
                        row.weight_kg != initial.weight_kg ||
                        row.block_loc !== initial.block_loc ||
                        row.remarks !== initial.remarks;

                    if (diff) {
                        isDirty = true;
                        break;
                    }
                }
            }
        }

        onDirtyChange(isDirty);
    }, [rows, mode, initialData, onDirtyChange]);

    const inputRowToRcOutInput = (row: InputRcOutRow): RcOutInput | null => {
        const batch = batches.find(b => b.batch_code === row.batch_code);
        if (!batch) return null;

        return {
            transaction_date: row.transaction_date,
            production_batch: row.production_batch,
            destination: row.destination,
            weight_kg: parseFloat(String(row.weight_kg)) || 0,
            block_loc: row.block_loc,
            remarks: row.remarks,
            batch_id: batch.id,
        };
    };

    const handleSubmit = async () => {
        setIsSubmitting(true);

        try {
            const validIndices: number[] = [];
            const validRows: RcOutInput[] = [];

            rows.forEach((row, i) => {
                const weight = parseFloat(String(row.weight_kg)) || 0;
                if (row.batch_code && weight > 0) {
                    const input = inputRowToRcOutInput(row);
                    if (input) {
                        validIndices.push(i);
                        validRows.push(input);
                    } else {
                        toast.warning(`Row ${i + 1}: Batch "${row.batch_code}" not found. Skipped.`);
                    }
                }
            });

            if (validRows.length === 0) {
                toast.warning('Please fill in at least one valid row (Block and Weight required).');
                setIsSubmitting(false);
                return;
            }

            let res: { success: boolean; message?: string };

            if (isEdit) {
                const updates = validIndices.map((rowIdx, i) => ({
                    id: rowIdsRef.current[rowIdx],
                    data: validRows[i],
                    comment: auditComments[rowIdx]
                }));
                res = await bulkUpdateUsage(updates);
            } else {
                res = await submitBulkUsage(validRows);
            }

            if (res.success) {
                if (!isEdit) setRows([createEmptyRow()]);
                const noun = validRows.length === 1 ? 'record' : 'records';
                toast.success(`${validRows.length} ${noun} ${isEdit ? 'updated' : 'logged'} successfully`);
                onSuccess?.();
            } else {
                toast.error(`${isEdit ? 'Update' : 'Submission'} failed: ` + res.message);
            }
        } catch (error: unknown) {
            toast.error('An unexpected error occurred: ' + (error instanceof Error ? error.message : 'Unknown'));
        } finally {
            setIsSubmitting(false);
        }
    };

    const destinationItems = React.useMemo<AutocompleteItem[]>(
        () => destinations.map(d => ({ value: d })),
        [destinations]
    );

    const productionBatchItems = React.useMemo<AutocompleteItem[]>(
        () => productionBatches.map(p => ({ value: p })),
        [productionBatches]
    );

    const batchItems = React.useMemo<AutocompleteItem[]>(
        () => batches.map(b => ({ value: b.batch_code, detail: b.location_ref })),
        [batches]
    );

    return (
        <TooltipProvider>
            <div className="space-y-4">

                <div className="flex items-center justify-between">
                    <div className="text-sm text-muted-foreground">
                        {isEdit ? (
                            <span>Editing {rows.length} record{rows.length === 1 ? '' : 's'}.</span>
                        ) : (
                            <>
                                <span className="hidden md:inline">Pro Tip: Click a cell to select, type to edit. Arrow keys to navigate. </span>
                                Click &ldquo;Add Row&rdquo; for manual entry.
                            </>
                        )}
                    </div>
                    <div className="space-x-2">
                        {!isEdit && (
                            <Button variant="outline" size="sm" onClick={addRow}><Plus className="w-4 h-4 mr-2" /> Add Row</Button>
                        )}
                        <Button size="sm" onClick={handleSubmit} disabled={isSubmitting}>
                            {isEdit
                                ? `Update Record${rows.length === 1 ? '' : 's'}`
                                : 'Submit All'}
                        </Button>
                    </div>
                </div>

                <div
                    ref={gridRef}
                    className="border rounded-md overflow-hidden overflow-x-auto relative max-h-[60vh] outline-none select-none"
                    tabIndex={-1}
                    onKeyDown={handleGridKeyDown}
                    onPaste={handleGridPaste}
                    onBlur={(e) => {
                        if (!e.currentTarget.contains(e.relatedTarget)) {
                            // Delay to allow focus to settle into portal-rendered popovers
                            requestAnimationFrame(() => {
                                // If focus returned to the grid, no-op
                                if (gridRef.current?.contains(document.activeElement)) return;
                                // If focus moved to a Radix popover portal (remarks, autocomplete), keep editing
                                if (document.activeElement?.closest('[data-radix-popper-content-wrapper]')) return;
                                setActiveCell(null);
                                setIsEditing(false);
                            });
                        }
                    }}
                >
                    <table className="w-full table-fixed text-xs relative caption-bottom border-collapse">
                        <TableHeader className="bg-muted/90 backdrop-blur-sm sticky top-0 z-50 shadow-sm border-b">
                            <TableRow className="hover:bg-transparent border-b" style={{ height: `${rowHeight}px` }}>
                                <TableHead className="w-[30px] p-0 sticky left-0 z-50 bg-muted border-b border-foreground/20 shadow-none after:absolute after:right-0 after:top-0 after:bottom-0 after:w-px after:bg-foreground/20 last:after:hidden"></TableHead>
                                <TableHead className="w-[90px] text-center px-1 py-1 font-mono font-bold border-b border-foreground/20 bg-muted/90 sticky top-0 z-50 shadow-none after:absolute after:right-0 after:top-0 after:bottom-0 after:w-px after:bg-foreground/20 last:after:hidden" style={{ fontSize: `${fontSize}px` }}>DATE</TableHead>
                                <TableHead className="w-[100px] text-center px-1 py-1 font-mono font-bold border-b border-foreground/20 bg-muted/90 sticky top-0 z-50 shadow-none after:absolute after:right-0 after:top-0 after:bottom-0 after:w-px after:bg-foreground/20 last:after:hidden" style={{ fontSize: `${fontSize}px` }}>BATCH</TableHead>
                                <TableHead className="w-[100px] text-center px-1 py-1 font-mono font-bold border-b border-foreground/20 bg-muted/90 sticky top-0 z-50 shadow-none after:absolute after:right-0 after:top-0 after:bottom-0 after:w-px after:bg-foreground/20 last:after:hidden" style={{ fontSize: `${fontSize}px` }}>BLOCK</TableHead>
                                <TableHead className="w-[70px] text-center px-1 py-1 font-mono font-bold border-b border-foreground/20 bg-muted/90 sticky top-0 z-50 shadow-none after:absolute after:right-0 after:top-0 after:bottom-0 after:w-px after:bg-foreground/20 last:after:hidden" style={{ fontSize: `${fontSize}px` }}>WT</TableHead>
                                <TableHead className="w-[120px] text-center px-1 py-1 font-mono font-bold border-b border-foreground/20 bg-muted/90 sticky top-0 z-50 shadow-none after:absolute after:right-0 after:top-0 after:bottom-0 after:w-px after:bg-foreground/20 last:after:hidden" style={{ fontSize: `${fontSize}px` }}>PLANT/ETC</TableHead>
                                <TableHead className="w-[80px] text-center px-1 py-1 font-mono font-bold border-b border-foreground/20 bg-muted/90 sticky top-0 z-50 shadow-none after:absolute after:right-0 after:top-0 after:bottom-0 after:w-px after:bg-foreground/20 last:after:hidden" style={{ fontSize: `${fontSize}px` }}>BLOCK LOC</TableHead>
                                <TableHead className="w-[60px] text-center px-1 py-1 font-mono font-bold border-b border-foreground/20 bg-muted/90 sticky top-0 z-50 shadow-none after:absolute after:right-0 after:top-0 after:bottom-0 after:w-px after:bg-foreground/20 last:after:hidden" style={{ fontSize: `${fontSize}px` }}>REMARKS</TableHead>
                                <TableHead className="w-[20px] p-0 bg-muted/90 sticky top-0 z-50 border-b border-foreground/20 shadow-none"></TableHead>
                            </TableRow>
                        </TableHeader>
                        <TableBody>
                            {rows.map((row, index) => (
                                <BulkInputRow
                                    key={index}
                                    row={row}
                                    index={index}
                                    batches={batches}
                                    batchItems={batchItems}
                                    destinationItems={destinationItems}
                                    productionBatchItems={productionBatchItems}
                                    updateRow={updateRow}
                                    updateRowFields={updateRowFields}
                                    removeRow={removeRow}
                                    onPaste={handleSmartPaste}
                                    gridRef={gridRef}
                                    fontSize={fontSize}
                                    rowHeight={rowHeight}
                                    activeCell={activeCell}
                                    isEditing={isEditing}
                                    setActiveCell={setActiveCell}
                                    setIsEditing={setIsEditing}
                                    onStartEditing={startEditing}
                                    onRevert={revertChanges}
                                    auditComment={auditComments[index] || ''}
                                    onAuditCommentChange={(val) => setAuditComments(prev => ({ ...prev, [index]: val }))}
                                    isEditMode={isEdit}
                                    cellMouseDown={(col, e) => handleGridCellMouseDown(index, col, e)}
                                    cellMouseUp={(col) => handleGridCellMouseUp(index, col)}
                                    cellMouseEnter={(col) => handleGridCellMouseEnter(index, col)}
                                    isCellSelected={(col) => cellSelection.isSelected(index, col)}
                                    isCellAnchor={(col) => cellSelection.isAnchor(index, col)}
                                    cellDragging={cellSelection.isDragging}
                                />
                            ))}
                        </TableBody>
                    </table>
                </div>
            </div>
        </TooltipProvider>
    );
}

// --- ROW COMPONENT ---

const BulkInputRow = React.memo(function BulkInputRow({
    row,
    index,
    batches,
    batchItems,
    destinationItems,
    productionBatchItems,
    updateRow,
    updateRowFields,
    removeRow,
    onPaste,
    gridRef,
    fontSize,
    rowHeight,
    activeCell,
    isEditing,
    setActiveCell,
    setIsEditing,
    onStartEditing,
    onRevert,
    auditComment,
    onAuditCommentChange,
    isEditMode = false,
    cellMouseDown,
    cellMouseUp,
    cellMouseEnter,
    isCellSelected,
    isCellAnchor,
    cellDragging,
}: {
    row: InputRcOutRow;
    index: number;
    batches: Batch[];
    batchItems: AutocompleteItem[];
    destinationItems: AutocompleteItem[];
    productionBatchItems: AutocompleteItem[];
    updateRow: (index: number, field: keyof InputRcOutRow, value: InputRcOutRow[keyof InputRcOutRow]) => void;
    updateRowFields: (index: number, updates: Partial<InputRcOutRow>) => void;
    removeRow: (index: number) => void;
    onPaste: (e: React.ClipboardEvent, rowIndex: number, colIndex: number) => void;
    gridRef: React.RefObject<HTMLDivElement | null>;
    fontSize: number;
    rowHeight: number;
    activeCell: { row: number; col: number } | null;
    isEditing: boolean;
    setActiveCell: (cell: { row: number; col: number }) => void;
    setIsEditing: (editing: boolean) => void;
    onStartEditing: (row: number, col: number, char?: string) => void;
    onRevert: () => void;
    auditComment: string;
    onAuditCommentChange: (val: string) => void;
    isEditMode?: boolean;
    cellMouseDown: (col: number, e: React.MouseEvent) => void;
    cellMouseUp: (col: number) => void;
    cellMouseEnter: (col: number) => void;
    isCellSelected: (col: number) => boolean;
    isCellAnchor: (col: number) => boolean;
    cellDragging: boolean;
}) {
    const inputStyle = { fontSize: `${fontSize}px` };

    const commonCellProps = {
        row: index,
        activeCell,
        isEditing,
        setActiveCell,
        setIsEditing,
        onStartEditing,
        onRevert,
        className: "font-mono font-bold text-center",
        gridRef
    };

    return (
        <TableRow className="hover:bg-muted/50 transition-all duration-150" style={{ height: `${rowHeight}px` }}>
            {/* 0: Row action area */}
            <TableCell className="p-0 sticky left-0 bg-background z-10 border-r" style={{ height: `${rowHeight}px` }}>
                {isEditMode ? (
                    <Popover>
                        <Tooltip>
                            <TooltipTrigger asChild>
                                <PopoverTrigger asChild>
                                    <Button
                                        variant="ghost"
                                        size="icon"
                                        className={cn(
                                            "h-full w-full rounded-none",
                                            auditComment ? "text-primary bg-primary/10" : "text-muted-foreground/30 hover:text-muted-foreground"
                                        )}
                                        tabIndex={-1}
                                    >
                                        <PencilLine className="w-3 h-3" />
                                    </Button>
                                </PopoverTrigger>
                            </TooltipTrigger>
                            <TooltipContent side="right">
                                <p>Edit Remarks</p>
                            </TooltipContent>
                        </Tooltip>
                        <PopoverContent className="w-72 p-3 shadow-lg" align="start" side="right" onKeyDown={(e) => e.stopPropagation()}>
                            <div className="space-y-2">
                                <div className="flex items-center gap-2">
                                    <MessageSquarePlus className="h-4 w-4 text-muted-foreground" />
                                    <h4 className="font-medium leading-none text-sm">Edit Remarks</h4>
                                </div>
                                <p className="text-xs text-muted-foreground">
                                    Reason for this change (saved to audit log).
                                </p>
                                <Textarea
                                    value={auditComment}
                                    onChange={(e) => onAuditCommentChange(e.target.value)}
                                    placeholder="e.g. Corrected weight typo..."
                                    className="min-h-[80px] text-xs font-mono resize-none"
                                />
                            </div>
                        </PopoverContent>
                    </Popover>
                ) : (
                    <div className="h-full w-full" />
                )}
            </TableCell>

            {/* 1: DATE */}
            <TableCell className="px-1 py-0 border-r" style={{ height: `${rowHeight}px` }}>
                <GridCell col={1} value={row.transaction_date} {...commonCellProps}
                    onCellMouseDown={(e) => cellMouseDown(1, e)}
                    onCellMouseUp={() => cellMouseUp(1)}
                    onCellMouseEnter={() => cellMouseEnter(1)}
                    isCellRangeSelected={isCellSelected(1)}
                    isCellRangeAnchor={isCellAnchor(1)}
                    isDragActive={cellDragging}
                >
                    <Input
                        autoFocus
                        value={row.transaction_date}
                        onChange={(e) => updateRow(index, 'transaction_date', e.target.value)}
                        className={cn(inputClass, "font-bold text-center font-mono")}
                        placeholder="YYYY-MM-DD"
                        style={inputStyle}
                    />
                </GridCell>
            </TableCell>

            {/* 2: BATCH (production_batch) */}
            <TableCell className="px-1 py-0 border-r" style={{ height: `${rowHeight}px` }}>
                <GridCell col={2} value={row.production_batch} {...commonCellProps} className="font-bold text-center font-mono"
                    onCellMouseDown={(e) => cellMouseDown(2, e)}
                    onCellMouseUp={() => cellMouseUp(2)}
                    onCellMouseEnter={() => cellMouseEnter(2)}
                    isCellRangeSelected={isCellSelected(2)}
                    isCellRangeAnchor={isCellAnchor(2)}
                    isDragActive={cellDragging}
                >
                    <AutocompletePopover
                        value={row.production_batch}
                        onChange={(val) => updateRow(index, 'production_batch', val)}
                        items={productionBatchItems}
                        onSelect={(val) => updateRow(index, 'production_batch', val)}
                        className={cn(inputClass, "font-bold text-center font-mono")}
                        placeholder="Batch..."
                        style={inputStyle}
                        autoFocus
                        onRevert={onRevert}
                    />
                </GridCell>
            </TableCell>

            {/* 3: BLOCK (batch_code) */}
            <TableCell className="px-1 py-0 border-r relative" style={{ height: `${rowHeight}px` }}>
                <GridCell col={3} value={row.batch_code} {...commonCellProps}
                    onCellMouseDown={(e) => cellMouseDown(3, e)}
                    onCellMouseUp={() => cellMouseUp(3)}
                    onCellMouseEnter={() => cellMouseEnter(3)}
                    isCellRangeSelected={isCellSelected(3)}
                    isCellRangeAnchor={isCellAnchor(3)}
                    isDragActive={cellDragging}
                >
                    <AutocompletePopover
                        value={row.batch_code}
                        onChange={(val) => updateRow(index, 'batch_code', val)}
                        items={batchItems}
                        onSelect={(val) => {
                            const batch = batches.find(b => b.batch_code === val);
                            if (batch) {
                                updateRowFields(index, {
                                    batch_code: batch.batch_code,
                                    ...(batch.location_ref ? { block_loc: batch.location_ref } : {})
                                });
                            } else {
                                updateRow(index, 'batch_code', val);
                            }
                        }}
                        className={cn(inputClass, "font-bold text-center font-mono")}
                        placeholder="..."
                        style={inputStyle}
                        autoFocus
                        onRevert={onRevert}
                    />
                </GridCell>
            </TableCell>

            {/* 4: WT */}
            <TableCell className="px-1 py-0 border-r" style={{ height: `${rowHeight}px` }}>
                <GridCell col={4} value={row.weight_kg} {...commonCellProps}
                    onCellMouseDown={(e) => cellMouseDown(4, e)}
                    onCellMouseUp={() => cellMouseUp(4)}
                    onCellMouseEnter={() => cellMouseEnter(4)}
                    isCellRangeSelected={isCellSelected(4)}
                    isCellRangeAnchor={isCellAnchor(4)}
                    isDragActive={cellDragging}
                >
                    <Input
                        autoFocus
                        type="number" step="1"
                        value={row.weight_kg}
                        onChange={(e) => updateRow(index, 'weight_kg', e.target.value)}
                        className={cn(inputClass, "font-bold text-center font-mono")}
                        style={inputStyle}
                    />
                </GridCell>
            </TableCell>

            {/* 5: PLANT/ETC (destination) */}
            <TableCell className="px-1 py-0 border-r" style={{ height: `${rowHeight}px` }}>
                <GridCell col={5} value={row.destination} {...commonCellProps} className="font-bold text-left pl-1"
                    onCellMouseDown={(e) => cellMouseDown(5, e)}
                    onCellMouseUp={() => cellMouseUp(5)}
                    onCellMouseEnter={() => cellMouseEnter(5)}
                    isCellRangeSelected={isCellSelected(5)}
                    isCellRangeAnchor={isCellAnchor(5)}
                    isDragActive={cellDragging}
                >
                    <AutocompletePopover
                        value={row.destination}
                        onChange={(val) => updateRow(index, 'destination', val)}
                        items={destinationItems}
                        onSelect={(val) => updateRow(index, 'destination', val)}
                        className={cn(inputClass, "font-bold text-left")}
                        placeholder="Destination..."
                        style={inputStyle}
                        autoFocus
                        onRevert={onRevert}
                    />
                </GridCell>
            </TableCell>

            {/* 6: BLOCK LOC */}
            <TableCell className="px-1 py-0 border-r" style={{ height: `${rowHeight}px` }}>
                <GridCell col={6} value={row.block_loc} {...commonCellProps}
                    onCellMouseDown={(e) => cellMouseDown(6, e)}
                    onCellMouseUp={() => cellMouseUp(6)}
                    onCellMouseEnter={() => cellMouseEnter(6)}
                    isCellRangeSelected={isCellSelected(6)}
                    isCellRangeAnchor={isCellAnchor(6)}
                    isDragActive={cellDragging}
                >
                    <Input
                        autoFocus
                        value={row.block_loc}
                        onChange={(e) => updateRow(index, 'block_loc', e.target.value)}
                        className={cn(inputClass, "font-bold text-center font-mono")}
                        style={inputStyle}
                    />
                </GridCell>
            </TableCell>

            {/* 7: REMARKS */}
            <TableCell className="px-1 py-0 border-r" style={{ height: `${rowHeight}px` }}>
                <GridCell col={7} value={row.remarks} {...commonCellProps}
                    onCellMouseDown={(e) => cellMouseDown(7, e)}
                    onCellMouseUp={() => cellMouseUp(7)}
                    onCellMouseEnter={() => cellMouseEnter(7)}
                    isCellRangeSelected={isCellSelected(7)}
                    isCellRangeAnchor={isCellAnchor(7)}
                    isDragActive={cellDragging}
                    displayValue={
                        <div className={cn("h-6 w-6 flex items-center justify-center rounded-sm", row.remarks ? "text-primary" : "text-muted-foreground/30")}>
                            <MessageSquareText className="w-3 h-3" />
                        </div>
                    }
                >
                    <RemarksCellAdaptor
                        value={row.remarks}
                        onChange={(val) => updateRow(index, 'remarks', val)}
                        onClose={() => setIsEditing(false)}
                        onRevert={onRevert}
                        fontSize={fontSize}
                    />
                </GridCell>
            </TableCell>

            {/* 8: Remove row */}
            <TableCell className="p-0 w-[20px]" style={{ height: `${rowHeight}px` }}>
                <button
                    className="h-full w-full flex items-center justify-center text-muted-foreground/40 hover:text-destructive transition-colors"
                    onClick={() => removeRow(index)}
                    tabIndex={-1}
                    type="button"
                >
                    <X className="w-3 h-3" />
                </button>
            </TableCell>
        </TableRow>
    );
});

// --- GRID CELL HELPERS ---
// GridCell, RemarksCellAdaptor, and AutocompletePopover are now imported from shared components
