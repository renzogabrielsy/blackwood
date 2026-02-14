'use client';

import * as React from 'react';
import { toast } from 'sonner';
import { Check, Plus, X, MessageSquareText, PencilLine, MessageSquarePlus } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Textarea } from '@/components/ui/textarea';
import { Button } from '@/components/ui/button';
import {
    Command,
    CommandGroup,
    CommandItem,
    CommandList,
} from '@/components/ui/command';
import {
    Popover,
    PopoverContent,
    PopoverTrigger,
} from '@/components/ui/popover';
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
import { submitBulkUsage, bulkUpdateUsage } from './actions';
import { useTableSettings } from '@/components/providers/table-settings';
import { COLUMN_MAP, cleanCellValue } from './paste-utils';
import type { InputRcOutRow, RcOutInput, RcOutRow } from '@/types/rc-out';

// --- TYPES ---
type Batch = {
    id: string;
    batch_code: string;
    location_ref: string;
};

type AutocompleteItem = {
    value: string;
    detail?: string;
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
    const preEditValue = React.useRef<any>(null);

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

    const updateRow = React.useCallback((index: number, field: keyof InputRcOutRow, value: any) => {
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

        if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Tab', 'Enter'].includes(e.key)) {
            e.preventDefault();
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

        // Printable characters -> Enter edit mode with value
        if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
            const field = COLUMN_MAP[activeCell.col];
            if (field) {
                e.preventDefault();
                startEditing(activeCell.row, activeCell.col, e.key);
            }
        }
    }, [activeCell, isEditing, rows, updateRow, startEditing, revertChanges]);

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
        }
    }, [isEditing, activeCell, handleSmartPaste]);

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
        } catch (error: any) {
            toast.error('An unexpected error occurred: ' + (error.message || 'Unknown'));
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
                    className="border rounded-md overflow-hidden overflow-x-auto relative max-h-[60vh] outline-none"
                    tabIndex={0}
                    onKeyDown={handleGridKeyDown}
                    onPaste={handleGridPaste}
                    onBlur={(e) => {
                        if (!e.currentTarget.contains(e.relatedTarget)) {
                            setActiveCell(null);
                            setIsEditing(false);
                        }
                    }}
                >
                    <table className="w-full table-fixed text-xs relative caption-bottom border-collapse">
                        <TableHeader className="bg-muted sticky top-0 z-50 shadow-sm border-b">
                            <TableRow className="hover:bg-transparent border-b" style={{ height: `${rowHeight}px` }}>
                                <TableHead className="w-[30px] p-0 sticky left-0 z-50 bg-muted border-b border-foreground/20 shadow-none after:absolute after:right-0 after:top-0 after:bottom-0 after:w-px after:bg-foreground/20 last:after:hidden"></TableHead>
                                <TableHead className="w-[90px] text-center px-1 py-1 font-mono font-bold border-b border-foreground/20 bg-muted sticky top-0 z-50 shadow-none after:absolute after:right-0 after:top-0 after:bottom-0 after:w-px after:bg-foreground/20 last:after:hidden" style={{ fontSize: `${fontSize}px` }}>DATE</TableHead>
                                <TableHead className="w-[100px] text-center px-1 py-1 font-mono font-bold border-b border-foreground/20 bg-muted sticky top-0 z-50 shadow-none after:absolute after:right-0 after:top-0 after:bottom-0 after:w-px after:bg-foreground/20 last:after:hidden" style={{ fontSize: `${fontSize}px` }}>BATCH</TableHead>
                                <TableHead className="w-[100px] text-center px-1 py-1 font-mono font-bold border-b border-foreground/20 bg-muted sticky top-0 z-50 shadow-none after:absolute after:right-0 after:top-0 after:bottom-0 after:w-px after:bg-foreground/20 last:after:hidden" style={{ fontSize: `${fontSize}px` }}>BLOCK</TableHead>
                                <TableHead className="w-[70px] text-center px-1 py-1 font-mono font-bold border-b border-foreground/20 bg-muted sticky top-0 z-50 shadow-none after:absolute after:right-0 after:top-0 after:bottom-0 after:w-px after:bg-foreground/20 last:after:hidden" style={{ fontSize: `${fontSize}px` }}>WT</TableHead>
                                <TableHead className="w-[120px] text-center px-1 py-1 font-mono font-bold border-b border-foreground/20 bg-muted sticky top-0 z-50 shadow-none after:absolute after:right-0 after:top-0 after:bottom-0 after:w-px after:bg-foreground/20 last:after:hidden" style={{ fontSize: `${fontSize}px` }}>PLANT/ETC</TableHead>
                                <TableHead className="w-[80px] text-center px-1 py-1 font-mono font-bold border-b border-foreground/20 bg-muted sticky top-0 z-50 shadow-none after:absolute after:right-0 after:top-0 after:bottom-0 after:w-px after:bg-foreground/20 last:after:hidden" style={{ fontSize: `${fontSize}px` }}>BLOCK LOC</TableHead>
                                <TableHead className="w-[60px] text-center px-1 py-1 font-mono font-bold border-b border-foreground/20 bg-muted sticky top-0 z-50 shadow-none after:absolute after:right-0 after:top-0 after:bottom-0 after:w-px after:bg-foreground/20 last:after:hidden" style={{ fontSize: `${fontSize}px` }}>REMARKS</TableHead>
                                <TableHead className="w-[20px] p-0 bg-muted sticky top-0 z-50 border-b border-foreground/20 shadow-none"></TableHead>
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
}: {
    row: InputRcOutRow;
    index: number;
    batches: Batch[];
    batchItems: AutocompleteItem[];
    destinationItems: AutocompleteItem[];
    productionBatchItems: AutocompleteItem[];
    updateRow: (index: number, field: keyof InputRcOutRow, value: any) => void;
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
        <TableRow className="hover:bg-muted/50 transition-colors" style={{ height: `${rowHeight}px` }}>
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
                <GridCell col={1} value={row.transaction_date} {...commonCellProps}>
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
                <GridCell col={2} value={row.production_batch} {...commonCellProps} className="font-bold text-center font-mono">
                    <AutocompleteInput
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
                <GridCell col={3} value={row.batch_code} {...commonCellProps}>
                    <AutocompleteInput
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
                <GridCell col={4} value={row.weight_kg} {...commonCellProps}>
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
                <GridCell col={5} value={row.destination} {...commonCellProps} className="font-bold text-left pl-1">
                    <AutocompleteInput
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
                <GridCell col={6} value={row.block_loc} {...commonCellProps}>
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

function GridCell({ row, col, value, activeCell, isEditing, setActiveCell, setIsEditing, onStartEditing, onRevert, children, displayValue, className, tabIndex, gridRef }: {
    row: number;
    col: number;
    value: string | number;
    activeCell: { row: number; col: number } | null;
    isEditing: boolean;
    setActiveCell: (cell: { row: number; col: number }) => void;
    setIsEditing: (editing: boolean) => void;
    onStartEditing: (row: number, col: number, char?: string) => void;
    onRevert?: () => void;
    children: React.ReactNode;
    displayValue?: React.ReactNode;
    className?: string;
    tabIndex?: number;
    gridRef?: React.RefObject<HTMLDivElement | null>;
}) {
    const isActive = activeCell?.row === row && activeCell?.col === col;
    const isEditingThis = isActive && isEditing;

    if (isEditingThis) {
        return <div className={cn("h-full w-full relative", className)}>{children}</div>;
    }

    return (
        <div
            data-row={row}
            data-col={col}
            tabIndex={tabIndex ?? 0}
            className={cn(
                "h-full w-full flex items-center justify-center outline-none cursor-default select-none",
                isActive && "ring-2 ring-primary ring-inset z-10",
                className
            )}
            style={{ minHeight: '100%' }}
            onClick={(e) => {
                e.stopPropagation();
                setActiveCell({ row, col });
                setIsEditing(false);
                gridRef?.current?.focus();
            }}
            onDoubleClick={(e) => {
                e.stopPropagation();
                onStartEditing(row, col);
            }}
        >
            {displayValue ?? value}
        </div>
    );
}

function RemarksCellAdaptor({ value, onChange, onClose, onRevert, fontSize }: { value: string, onChange: (v: string) => void, onClose: () => void, onRevert: () => void, fontSize: number }) {
    const [open, setOpen] = React.useState(true);

    const onOpenChange = (isOpen: boolean) => {
        setOpen(isOpen);
        if (!isOpen) {
            onClose();
        }
    }

    return (
        <Popover open={open} onOpenChange={onOpenChange}>
            <PopoverTrigger asChild>
                <div className="w-full h-full" />
            </PopoverTrigger>
            <PopoverContent
                className="w-80 p-2"
                align="center"
                side="bottom"
                onEscapeKeyDown={(e) => e.preventDefault()}
            >
                <div className="space-y-2">
                    <h4 className="font-medium leading-none">Remarks</h4>
                    <p className="text-xs text-muted-foreground">Add notes about this usage record.</p>
                    <Input
                        autoFocus
                        value={value}
                        onChange={(e) => onChange(e.target.value)}
                        className="h-8"
                        style={{ fontSize: `${fontSize}px` }}
                        placeholder="Enter remarks..."
                        onKeyDown={(e) => {
                            if (e.key === 'Enter') {
                                e.stopPropagation();
                                setOpen(false);
                            } else if (e.key === 'Escape') {
                                e.preventDefault();
                                e.stopPropagation();
                                e.nativeEvent.stopImmediatePropagation();
                                onRevert();
                            }
                        }}
                    />
                </div>
            </PopoverContent>
        </Popover>
    )
}

function AutocompleteInput({ value, onChange, onSelect, items, className, placeholder, style, autoFocus, onRevert }: {
    value: string;
    onChange: (val: string) => void;
    onSelect: (val: string) => void;
    items: AutocompleteItem[];
    className?: string;
    placeholder?: string;
    style?: React.CSSProperties;
    autoFocus?: boolean;
    onRevert?: () => void;
}) {
    const [open, setOpen] = React.useState(false);
    const inputRef = React.useRef<HTMLInputElement>(null);
    const [selectedIndex, setSelectedIndex] = React.useState(0);

    const filtered = React.useMemo(
        () => items.filter(item => item.value.toLowerCase().includes(value.toLowerCase())).slice(0, 5),
        [items, value]
    );

    React.useEffect(() => {
        setSelectedIndex(0);
    }, [filtered]);

    React.useEffect(() => {
        if (autoFocus && filtered.length > 0) {
            setOpen(true);
        }
    }, [autoFocus, filtered.length]);

    const handleKeyDown = React.useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
        if (open) {
            switch (e.key) {
                case 'ArrowDown':
                    e.preventDefault();
                    e.stopPropagation();
                    setSelectedIndex(prev => Math.min(prev + 1, filtered.length - 1));
                    return;
                case 'ArrowUp':
                    e.preventDefault();
                    e.stopPropagation();
                    setSelectedIndex(prev => Math.max(prev - 1, 0));
                    return;
                case 'Enter':
                    e.preventDefault();
                    if (filtered.length > 0) {
                        onSelect(filtered[selectedIndex].value);
                        setOpen(false);
                        e.stopPropagation();
                    }
                    return;
                case 'Tab':
                    if (filtered.length > 0) {
                        onSelect(filtered[selectedIndex].value);
                        setOpen(false);
                    }
                    return;
                case 'Escape':
                    e.preventDefault();
                    e.stopPropagation();
                    e.nativeEvent.stopImmediatePropagation();
                    setOpen(false);
                    if (onRevert) onRevert();
                    return;
            }
        }
    }, [open, filtered, selectedIndex, onSelect, onRevert]);

    const handleSelect = React.useCallback((itemValue: string) => {
        onSelect(itemValue);
        setOpen(false);
    }, [onSelect]);

    return (
        <Popover open={open && filtered.length > 0} onOpenChange={setOpen} modal={false}>
            <PopoverTrigger asChild>
                <div className="w-full h-full relative">
                    <Input
                        ref={inputRef}
                        value={value}
                        onChange={(e) => {
                            onChange(e.target.value);
                            setOpen(true);
                        }}
                        onKeyDown={(e) => {
                            if (!open && e.key === 'Escape') {
                                e.preventDefault();
                                e.stopPropagation();
                                e.nativeEvent.stopImmediatePropagation();
                                if (onRevert) onRevert();
                                return;
                            }
                            handleKeyDown(e);
                        }}
                        onFocus={() => {
                            if (filtered.length > 0) setOpen(true);
                        }}
                        className={className}
                        placeholder={placeholder}
                        style={style}
                        autoFocus={autoFocus}
                    />
                </div>
            </PopoverTrigger>
            <PopoverContent
                className="w-[200px] p-0"
                onOpenAutoFocus={(e) => e.preventDefault()}
                onCloseAutoFocus={(e) => e.preventDefault()}
                side="bottom"
                align="start"
                sideOffset={4}
                onContextMenu={(e) => e.preventDefault()}
            >
                <Command shouldFilter={false}>
                    <CommandList>
                        <CommandGroup>
                            {filtered.map((item, idx) => (
                                <CommandItem
                                    key={item.value}
                                    value={item.value}
                                    onSelect={() => handleSelect(item.value)}
                                    className={cn(
                                        "text-xs font-mono cursor-pointer",
                                        idx === selectedIndex && "bg-accent text-accent-foreground"
                                    )}
                                    onMouseEnter={() => setSelectedIndex(idx)}
                                >
                                    <Check
                                        className={cn(
                                            "mr-2 h-3 w-3",
                                            value === item.value ? "opacity-100" : "opacity-0"
                                        )}
                                    />
                                    {item.value}
                                    {item.detail && (
                                        <span className="ml-auto text-muted-foreground text-[10px]">{item.detail}</span>
                                    )}
                                </CommandItem>
                            ))}
                        </CommandGroup>
                    </CommandList>
                </Command>
            </PopoverContent>
        </Popover>
    );
}
