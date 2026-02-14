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
import { submitBulkDeliveries, bulkUpdateDeliveries } from './actions';
import { calculateWhse } from '@/lib/rc-utils';
import { useTableSettings } from '@/components/providers/table-settings';
import { useAuth } from '@/components/providers/auth-context';
import { COLUMN_MAP, cleanCellValue } from './paste-utils';
import type { DeliveryRow, InputDeliveryRow } from '@/types/rc-in';

export type { InputDeliveryRow } from '@/types/rc-in';

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

const createEmptyRow = (): InputDeliveryRow => ({
    state: 'STORED',
    whse: '',
    transaction_date: new Date().toISOString().split('T')[0],
    supplier: '',
    batch_code: '',
    block_loc: '',
    truck_plate: '',
    weight_kg: '',
    sacks: '',
    mc: '',
    grit: '',
    bd_astm: '',
    bd_jis: '',
    vm: '',
    ash: '',
    fc: '',
    remarks: '',
    cost_basis: '',
});

/** Convert a DeliveryRow (from DB) into an InputDeliveryRow (for the grid editor) */
function deliveryToInputRow(d: DeliveryRow & { id?: string }): InputDeliveryRow {
    return {
        state: d.state || 'STORED',
        whse: '',
        transaction_date: d.transaction_date ?? '',
        supplier: d.supplier ?? '',
        batch_code: d.batch_code ?? '',
        block_loc: d.block_loc ?? '',
        truck_plate: d.truck_plate ?? '',
        weight_kg: d.weight_kg ?? '',
        sacks: d.sacks ?? '',
        mc: d.lab_results?.mc ?? '',
        grit: d.lab_results?.grit ?? '',
        bd_astm: d.lab_results?.bd_astm ?? '',
        bd_jis: d.lab_results?.bd_jis ?? '',
        vm: d.lab_results?.vm ?? '',
        ash: d.lab_results?.ash ?? '',
        fc: d.lab_results?.fc ?? '',
        remarks: d.remarks ?? '',
        cost_basis: d.cost_basis ?? '',
    };
}

function getStateClasses(state: string): string {
    switch (state) {
        case 'IN-USE': return 'text-blue-700 bg-blue-100 dark:text-blue-300 dark:bg-blue-900/30';
        case 'CLOSED': return 'text-red-700 bg-red-100 dark:text-red-300 dark:bg-red-900/30';
        case 'SUNDRYING': return 'text-amber-700 bg-amber-100 dark:text-amber-300 dark:bg-amber-900/30';
        case 'FEED': return 'text-green-700 bg-green-100 dark:text-green-300 dark:bg-green-900/30';
        default: return 'text-muted-foreground bg-muted/10'; // STORED
    }
}

const inputClass = "h-8 w-full px-1 border-transparent bg-transparent rounded-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-primary focus-visible:bg-accent/10 transition-colors shadow-none";

/** Focus an input in the grid by row/col data attributes */
function focusCell(container: HTMLElement | null, row: number, col: number) {
    if (!container) return;
    const target = container.querySelector<HTMLInputElement>(`[data-row="${row}"][data-col="${col}"]`);
    target?.focus();
}

// --- MAIN COMPONENT ---

type BulkDeliveryInputProps = {
    batches: Batch[];
    suppliers: string[];
    onSuccess?: () => void;
    mode?: 'create' | 'edit';
    initialData?: (DeliveryRow & { id: string })[];
    onDirtyChange?: (isDirty: boolean) => void;
};

export function BulkDeliveryInput({ batches, suppliers, onSuccess, mode = 'create', initialData, onDirtyChange }: BulkDeliveryInputProps) {
    const { fontSize, rowHeight } = useTableSettings();
    const { hasPermission } = useAuth();
    const canViewPrices = hasPermission('view:prices');
    const isEdit = mode === 'edit';

    // In edit mode, store original IDs aligned by row index
    const rowIdsRef = React.useRef<string[]>(initialData?.map(d => d.id) ?? []);
    const gridRef = React.useRef<HTMLDivElement>(null);

    const [rows, setRows] = React.useState<InputDeliveryRow[]>(() => {
        if (initialData && initialData.length > 0) {
            return initialData.map(deliveryToInputRow);
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
        // Clean up comment if row removed
        setAuditComments(prev => {
            const next = { ...prev };
            delete next[index];
            return next;
        });
    }, []);

    const updateRow = React.useCallback((index: number, field: keyof InputDeliveryRow, value: any) => {
        setRows(prev => {
            const newRows = [...prev];
            newRows[index] = { ...newRows[index], [field]: value };
            return newRows;
        });
    }, []);

    const updateRowFields = React.useCallback((index: number, updates: Partial<InputDeliveryRow>) => {
        setRows(prev => {
            const newRows = [...prev];
            newRows[index] = { ...newRows[index], ...updates };
            return newRows;
        });
    }, []);

    const startEditing = React.useCallback((rowIdx: number, colIdx: number, initialChar?: string) => {
        const field = COLUMN_MAP[colIdx];
        if (!field) return;

        // 1. Capture current value BEFORE any edit
        const currentRow = rows[rowIdx];
        const currentValue = currentRow ? currentRow[field] : '';
        preEditValue.current = currentValue;

        // 2. Set Editing
        setActiveCell({ row: rowIdx, col: colIdx }); // Ensure active
        setIsEditing(true);

        // 3. Optional: Immediate update (Type-over)
        if (initialChar !== undefined) {
            updateRow(rowIdx, field, initialChar);
        }
    }, [rows, updateRow]);

    const revertChanges = React.useCallback(() => {
        if (!activeCell) return;
        // REVERT changes
        if (preEditValue.current !== null) {
            const field = COLUMN_MAP[activeCell.col];
            if (field) {
                updateRow(activeCell.row, field, preEditValue.current);
            }
        }
        setIsEditing(false);
        // Return focus to the grid container
        gridRef.current?.focus();
    }, [activeCell, updateRow]);

    // --- GRID NAVIGATION ---
    // Defined after updateRow to avoid "used before declaration"
    const handleGridKeyDown = React.useCallback((e: React.KeyboardEvent) => {
        if (!activeCell) return;

        // If editing, only handle Escape to exit, or Tab/Enter to commit & move
        if (isEditing) {
            if (e.key === 'Escape') {
                e.preventDefault();
                e.stopPropagation();
                e.nativeEvent.stopImmediatePropagation(); // Prevent Radix/Dialog from catching this

                revertChanges();
            } else if (e.key === 'Enter' || e.key === 'Tab') {
                e.preventDefault();
                setIsEditing(false);
                moveSelection(e.key, e.shiftKey);
                gridRef.current?.focus();
            }
            return;
        }

        // --- NAVIGATION (Not Editing) ---
        if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Tab', 'Enter'].includes(e.key)) {
            e.preventDefault();
            moveSelection(e.key, e.shiftKey);
            return;
        }

        // --- EDIT MODE triggers ---
        if (e.key === 'F2') {
            e.preventDefault();
            startEditing(activeCell.row, activeCell.col);
            return;
        }

        if (e.key === 'Backspace' || e.key === 'Delete') {
            e.preventDefault();
            const field = COLUMN_MAP[activeCell.col];
            if (field) {
                // Capture first, then clear
                startEditing(activeCell.row, activeCell.col, '');
            }
            return;
        }

        // Printable characters -> Enter edit mode with value
        if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
            const field = COLUMN_MAP[activeCell.col];
            if (field) {
                // Prevent default so the subsequent input focus doesn't double-type the char
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
            do {
                col--;
            } while (col > 0 && COLUMN_MAP[col] === null); // Skip nulls
            col = Math.max(0, col);
        } else if (key === 'ArrowRight') {
            do {
                col++;
            } while (col < COLUMN_MAP.length && COLUMN_MAP[col] === null);
            col = Math.min(COLUMN_MAP.length - 1, col);
        } else if (key === 'Tab') {
            if (shift) {
                // Previous writable cell
                do {
                    col--;
                    if (col < 0) {
                        row--;
                        col = COLUMN_MAP.length - 1;
                    }
                } while (row >= 0 && COLUMN_MAP[col] === null);
                if (row < 0) { row = 0; col = activeCell.col; } // Boundary check
            } else {
                // Next writable cell
                do {
                    col++;
                    if (col >= COLUMN_MAP.length) {
                        row++;
                        col = 0;
                    }
                } while (row < rows.length && COLUMN_MAP[col] === null);
                if (row >= rows.length) { row = rows.length - 1; col = activeCell.col; } // Boundary check
            }
        }

        setActiveCell({ row, col });
    };

    // --- PASTE LOGIC (The Magic) ---
    const handleSmartPaste = React.useCallback((e: React.ClipboardEvent, startRowIndex: number, startColIndex: number) => {
        e.preventDefault();
        const clipboardData = e.clipboardData.getData('text');
        if (!clipboardData) return;

        // Parse Excel/TSV format
        const pastedRows = clipboardData.split(/\r\n|\n|\r/).filter(row => row.trim() !== '');
        if (pastedRows.length === 0) return;

        setRows(prev => {
            const newRows = [...prev];

            pastedRows.forEach((pastedRow, rOffset) => {
                const targetRowIndex = startRowIndex + rOffset;
                const columns = pastedRow.split('\t');

                // If we need more rows than exist, create them
                if (targetRowIndex >= newRows.length) {
                    newRows.push(createEmptyRow());
                }

                columns.forEach((cellValue, cOffset) => {
                    const targetColIndex = startColIndex + cOffset;

                    // Safety check: Don't paste beyond defined columns
                    if (targetColIndex < COLUMN_MAP.length) {
                        const fieldKey = COLUMN_MAP[targetColIndex];

                        // Only paste into writable fields
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

    // Handle paste on the grid container when in selection mode
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
            // In create mode, check if we have more than 1 row (added rows)
            // OR if the single row has any value filled
            if (rows.length > 1) {
                isDirty = true;
            } else {
                const r = rows[0];
                // Check relevant fields (ignore strictly internal or default empty fields)
                // Default empty row has mostly empty strings.
                // We check basic fields that user would type in.
                const hasData = r.transaction_date || r.supplier || r.batch_code || r.truck_plate ||
                    !!r.weight_kg || !!r.sacks || !!r.cost_basis;
                if (hasData) isDirty = true;
            }
        } else if (mode === 'edit' && initialData) {
            // In edit mode, compare with initialData
            // initialData is DeliveryRow[], rows is InputDeliveryRow[]
            // We need to convert initialData to InputDeliveryRow format for comparison, or vice versa.
            // Converting initialData to InputDeliveryRow is easier since we have `deliveryToInputRow`.

            if (rows.length !== initialData.length) {
                isDirty = true;
            } else {
                for (let i = 0; i < rows.length; i++) {
                    const row = rows[i];
                    const initial = deliveryToInputRow(initialData[i]);

                    // Simple shallow comparison of key fields
                    const diff =
                        row.transaction_date !== initial.transaction_date ||
                        row.supplier !== initial.supplier ||
                        row.batch_code !== initial.batch_code ||
                        row.block_loc !== initial.block_loc ||
                        row.truck_plate !== initial.truck_plate ||
                        row.weight_kg != initial.weight_kg || // loose comparison for numbers/strings
                        row.sacks != initial.sacks ||
                        row.mc != initial.mc ||
                        row.grit != initial.grit ||
                        row.bd_astm != initial.bd_astm ||
                        row.bd_jis != initial.bd_jis ||
                        row.vm != initial.vm ||
                        row.ash != initial.ash ||
                        row.fc != initial.fc ||
                        row.remarks !== initial.remarks ||
                        row.cost_basis != initial.cost_basis;

                    if (diff) {
                        isDirty = true;
                        break;
                    }
                }
            }
        }

        onDirtyChange(isDirty);
    }, [rows, mode, initialData, onDirtyChange]);
    const inputRowToDelivery = (row: InputDeliveryRow): DeliveryRow => ({
        state: row.state,
        block_loc: row.block_loc,
        transaction_date: row.transaction_date,
        supplier: row.supplier,
        batch_code: row.batch_code,
        truck_plate: row.truck_plate,
        sacks: parseInt(String(row.sacks)) || 0,
        weight_kg: parseFloat(String(row.weight_kg)) || 0,
        cost_basis: parseFloat(String(row.cost_basis)) || 0,
        remarks: row.remarks,
        lab_results: {
            mc: parseFloat(String(row.mc)) || 0,
            ash: parseFloat(String(row.ash)) || 0,
            bd_astm: parseFloat(String(row.bd_astm)) || 0,
            bd_jis: parseFloat(String(row.bd_jis)) || 0,
            grit: parseFloat(String(row.grit)) || 0,
            vm: parseFloat(String(row.vm)) || 0,
            fc: parseFloat(String(row.fc)) || 0,
        }
    });

    const handleSubmit = async () => {
        setIsSubmitting(true);

        try {
            // Validate: needs Batch and Weight
            const validIndices: number[] = [];
            const validRows: DeliveryRow[] = [];

            rows.forEach((row, i) => {
                const weight = parseFloat(String(row.weight_kg)) || 0;
                if (row.batch_code && weight > 0) {
                    validIndices.push(i);
                    validRows.push(inputRowToDelivery(row));
                }
            });

            if (validRows.length === 0) {
                toast.warning('Please fill in at least one valid row (Batch and Weight required).');
                setIsSubmitting(false);
                return;
            }

            let res: { success: boolean; message?: string };

            if (isEdit) {
                const updates = validIndices.map((rowIdx, i) => ({
                    id: rowIdsRef.current[rowIdx],
                    data: validRows[i],
                    comment: auditComments[rowIdx] // Pass the comment
                }));
                res = await bulkUpdateDeliveries(updates);
            } else {
                res = await submitBulkDeliveries(validRows);
            }

            if (res.success) {
                if (!isEdit) setRows([createEmptyRow()]);
                const noun = validRows.length === 1 ? 'delivery' : 'deliveries';
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

    const supplierItems = React.useMemo<AutocompleteItem[]>(
        () => suppliers.map(s => ({ value: s })),
        [suppliers]
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
                            <span>Editing {rows.length} deliver{rows.length === 1 ? 'y' : 'ies'}.</span>
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
                                ? `Update Deliver${rows.length === 1 ? 'y' : 'ies'}`
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
                        // Clear active cell when focus leaves the grid entirely
                        if (!e.currentTarget.contains(e.relatedTarget)) {
                            setActiveCell(null);
                            setIsEditing(false);
                        }
                    }}
                >
                    <table className="w-full table-fixed text-xs relative caption-bottom border-collapse">
                        <TableHeader className="bg-muted sticky top-0 z-50 shadow-sm border-b">
                            <TableRow className="hover:bg-transparent border-b" style={{ height: `${rowHeight}px` }}>
                                {/* Updated Header to include visual index reference if needed, but keeping clean for now */}
                                <TableHead className="w-[30px] p-0 sticky left-0 z-50 bg-muted border-b border-foreground/20 shadow-none  after:absolute after:right-0 after:top-0 after:bottom-0 after:w-px after:bg-foreground/20 last:after:hidden"></TableHead>
                                <TableHead className="w-[40px] text-center px-1 py-1 font-mono font-bold border-b border-foreground/20 bg-muted sticky top-0 z-50 shadow-none  after:absolute after:right-0 after:top-0 after:bottom-0 after:w-px after:bg-foreground/20 last:after:hidden" style={{ fontSize: `${fontSize}px` }}>STATE</TableHead>
                                <TableHead className="w-[40px] text-center px-1 py-1 font-mono font-bold border-b border-foreground/20 bg-muted sticky top-0 z-50 shadow-none  after:absolute after:right-0 after:top-0 after:bottom-0 after:w-px after:bg-foreground/20 last:after:hidden" style={{ fontSize: `${fontSize}px` }}>WHSE</TableHead>
                                <TableHead className="w-[70px] text-center px-1 py-1 font-mono font-bold border-b border-foreground/20 bg-muted sticky top-0 z-50 shadow-none  after:absolute after:right-0 after:top-0 after:bottom-0 after:w-px after:bg-foreground/20 last:after:hidden" style={{ fontSize: `${fontSize}px` }}>DATE</TableHead>
                                <TableHead className="w-[120px] text-center px-1 py-1 font-mono font-bold border-b border-foreground/20 bg-muted sticky top-0 z-50 shadow-none  after:absolute after:right-0 after:top-0 after:bottom-0 after:w-px after:bg-foreground/20 last:after:hidden" style={{ fontSize: `${fontSize}px` }}>SUPPLIER</TableHead>
                                <TableHead className="w-[80px] text-center px-1 py-1 font-mono font-bold border-b border-foreground/20 bg-muted sticky top-0 z-50 shadow-none  after:absolute after:right-0 after:top-0 after:bottom-0 after:w-px after:bg-foreground/20 last:after:hidden" style={{ fontSize: `${fontSize}px` }}>BLOCK</TableHead>
                                <TableHead className="w-[40px] text-center px-1 py-1 font-mono font-bold border-b border-foreground/20 bg-muted sticky top-0 z-50 shadow-none  after:absolute after:right-0 after:top-0 after:bottom-0 after:w-px after:bg-foreground/20 last:after:hidden" style={{ fontSize: `${fontSize}px` }}>LOC</TableHead>
                                <TableHead className="w-[50px] text-center px-1 py-1 font-mono font-bold border-b border-foreground/20 bg-muted sticky top-0 z-50 shadow-none  after:absolute after:right-0 after:top-0 after:bottom-0 after:w-px after:bg-foreground/20 last:after:hidden" style={{ fontSize: `${fontSize}px` }}>TRUCK</TableHead>
                                <TableHead className="w-[50px] text-center px-1 py-1 font-mono font-bold border-b border-foreground/20 bg-muted sticky top-0 z-50 shadow-none  after:absolute after:right-0 after:top-0 after:bottom-0 after:w-px after:bg-foreground/20 last:after:hidden" style={{ fontSize: `${fontSize}px` }}>WT</TableHead>
                                <TableHead className="w-[30px] text-center px-1 py-1 font-mono font-bold border-b border-foreground/20 bg-muted sticky top-0 z-50 shadow-none  after:absolute after:right-0 after:top-0 after:bottom-0 after:w-px after:bg-foreground/20 last:after:hidden" style={{ fontSize: `${fontSize}px` }}>SKS</TableHead>
                                <TableHead className="w-[35px] text-center px-1 py-1 font-mono font-bold border-b border-foreground/20 bg-muted sticky top-0 z-50 shadow-none  after:absolute after:right-0 after:top-0 after:bottom-0 after:w-px after:bg-foreground/20 last:after:hidden" style={{ fontSize: `${fontSize}px` }}>MC</TableHead>
                                <TableHead className="w-[35px] text-center px-1 py-1 font-mono font-bold border-b border-foreground/20 bg-muted sticky top-0 z-50 shadow-none  after:absolute after:right-0 after:top-0 after:bottom-0 after:w-px after:bg-foreground/20 last:after:hidden" style={{ fontSize: `${fontSize}px` }}>GRIT</TableHead>
                                <TableHead className="w-[35px] text-center px-1 py-1 font-mono font-bold border-b border-foreground/20 bg-muted sticky top-0 z-50 shadow-none  after:absolute after:right-0 after:top-0 after:bottom-0 after:w-px after:bg-foreground/20 last:after:hidden" style={{ fontSize: `${fontSize}px` }}>ASTM</TableHead>
                                <TableHead className="w-[35px] text-center px-1 py-1 font-mono font-bold border-b border-foreground/20 bg-muted sticky top-0 z-50 shadow-none  after:absolute after:right-0 after:top-0 after:bottom-0 after:w-px after:bg-foreground/20 last:after:hidden" style={{ fontSize: `${fontSize}px` }}>JIS</TableHead>
                                <TableHead className="w-[35px] text-center px-1 py-1 font-mono font-bold border-b border-foreground/20 bg-muted sticky top-0 z-50 shadow-none  after:absolute after:right-0 after:top-0 after:bottom-0 after:w-px after:bg-foreground/20 last:after:hidden" style={{ fontSize: `${fontSize}px` }}>VM</TableHead>
                                <TableHead className="w-[35px] text-center px-1 py-1 font-mono font-bold border-b border-foreground/20 bg-muted sticky top-0 z-50 shadow-none  after:absolute after:right-0 after:top-0 after:bottom-0 after:w-px after:bg-foreground/20 last:after:hidden" style={{ fontSize: `${fontSize}px` }}>ASH</TableHead>
                                <TableHead className="w-[35px] text-center px-1 py-1 font-mono font-bold border-b border-foreground/20 bg-muted sticky top-0 z-50 shadow-none  after:absolute after:right-0 after:top-0 after:bottom-0 after:w-px after:bg-foreground/20 last:after:hidden" style={{ fontSize: `${fontSize}px` }}>FC</TableHead>
                                <TableHead className="w-[60px] text-center px-1 py-1 font-mono font-bold border-b border-foreground/20 bg-muted sticky top-0 z-50 shadow-none  after:absolute after:right-0 after:top-0 after:bottom-0 after:w-px after:bg-foreground/20 last:after:hidden" style={{ fontSize: `${fontSize}px` }}>REMARKS</TableHead>
                                {canViewPrices && (
                                    <>
                                        <TableHead className="w-[50px] text-center px-1 py-1 font-mono font-bold border-b border-foreground/20 bg-muted sticky top-0 z-50 shadow-none  after:absolute after:right-0 after:top-0 after:bottom-0 after:w-px after:bg-foreground/20 last:after:hidden" style={{ fontSize: `${fontSize}px` }}>PHP/KG</TableHead>
                                        <TableHead className="w-[85px] text-center px-1 py-1 font-mono font-bold bg-muted sticky top-0 z-50 border-b border-foreground/20 shadow-none  after:absolute after:right-0 after:top-0 after:bottom-0 after:w-px after:bg-foreground/20 last:after:hidden" style={{ fontSize: `${fontSize}px` }}>PHP TTL</TableHead>
                                    </>
                                )}
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
                                    supplierItems={supplierItems}
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
                                    canViewPrices={canViewPrices}
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

// --- ROW COMPONENT ---

const BulkInputRow = React.memo(function BulkInputRow({
    row,
    index,
    batches,
    batchItems,
    supplierItems,
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
    row: InputDeliveryRow;
    index: number;
    batches: Batch[];
    batchItems: AutocompleteItem[];
    supplierItems: AutocompleteItem[];
    updateRow: (index: number, field: keyof InputDeliveryRow, value: any) => void;
    updateRowFields: (index: number, updates: Partial<InputDeliveryRow>) => void;
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
    canViewPrices: boolean;
}) {
    const whse = calculateWhse(row.block_loc, row.batch_code);
    const wt = parseFloat(String(row.weight_kg)) || 0;
    const price = parseFloat(String(row.cost_basis)) || 0;
    const ttlValue = wt * price;

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

            {/* 1: STATE (Read Only) */}
            <TableCell className="px-1 py-0 border-r" style={{ height: `${rowHeight}px` }}>
                <div className={cn("text-center font-mono uppercase rounded-sm py-0.5 truncate h-full flex items-center justify-center", getStateClasses(row.state || 'STORED'))} style={inputStyle}>
                    {row.state || 'STORED'}
                </div>
            </TableCell>

            {/* 2: WHSE (Calculated) */}
            <TableCell className="px-1 py-0 border-r text-center" style={{ height: `${rowHeight}px` }}>
                <div className="whitespace-nowrap text-center font-mono font-bold h-full flex items-center justify-center" style={inputStyle}>
                    {whse}
                </div>
            </TableCell>

            {/* 3: DATE */}
            <TableCell className="px-1 py-0 border-r" style={{ height: `${rowHeight}px` }}>
                <GridCell col={3} value={row.transaction_date} {...commonCellProps}>
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

            {/* 4: SUPPLIER */}
            <TableCell className="px-1 py-0 border-r" style={{ height: `${rowHeight}px` }}>
                <GridCell col={4} value={row.supplier} {...commonCellProps} className="font-bold text-left pl-1">
                    <AutocompleteInput
                        value={row.supplier}
                        onChange={(val) => updateRow(index, 'supplier', val)}
                        items={supplierItems}
                        onSelect={(val) => updateRow(index, 'supplier', val)}
                        className={cn(inputClass, "font-bold text-left")}
                        placeholder="Supplier..."
                        style={inputStyle}
                        autoFocus
                        onRevert={onRevert}
                    />
                </GridCell>
            </TableCell>

            {/* 5: BLOCK */}
            <TableCell className="px-1 py-0 border-r relative" style={{ height: `${rowHeight}px` }}>
                <GridCell col={5} value={row.batch_code} {...commonCellProps}>
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

            {/* 6: LOC */}
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

            {/* 7: TRUCK */}
            <TableCell className="px-1 py-0 border-r" style={{ height: `${rowHeight}px` }}>
                <GridCell col={7} value={row.truck_plate} {...commonCellProps} className="text-center font-mono">
                    <Input
                        autoFocus
                        value={row.truck_plate}
                        onChange={(e) => updateRow(index, 'truck_plate', e.target.value)}
                        className={cn(inputClass, "text-center font-mono")}
                        style={inputStyle}
                    />
                </GridCell>
            </TableCell>

            {/* 8: WT */}
            <TableCell className="px-1 py-0 border-r" style={{ height: `${rowHeight}px` }}>
                <GridCell col={8} value={row.weight_kg} {...commonCellProps}>
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

            {/* 9: SKS */}
            <TableCell className="px-1 py-0 border-r" style={{ height: `${rowHeight}px` }}>
                <GridCell col={9} value={row.sacks} {...commonCellProps} className="text-center font-mono">
                    <Input
                        autoFocus
                        type="number"
                        value={row.sacks}
                        onChange={(e) => updateRow(index, 'sacks', e.target.value)}
                        className={cn(inputClass, "text-center font-mono")}
                        style={inputStyle}
                    />
                </GridCell>
            </TableCell>

            {/* 10: MC */}
            <TableCell className="px-1 py-0 border-r" style={{ height: `${rowHeight}px` }}>
                <GridCell col={10} value={row.mc} {...commonCellProps} className="text-center font-mono">
                    <Input autoFocus type="number" step="0.01" value={row.mc} onChange={(e) => updateRow(index, 'mc', e.target.value)} className={cn(inputClass, "text-center font-mono")} style={inputStyle} />
                </GridCell>
            </TableCell>
            {/* 11: GRIT */}
            <TableCell className="px-1 py-0 border-r" style={{ height: `${rowHeight}px` }}>
                <GridCell col={11} value={row.grit} {...commonCellProps} className="text-center font-mono">
                    <Input autoFocus type="number" step="0.01" value={row.grit} onChange={(e) => updateRow(index, 'grit', e.target.value)} className={cn(inputClass, "text-center font-mono")} style={inputStyle} />
                </GridCell>
            </TableCell>
            {/* 12: ASTM */}
            <TableCell className="px-1 py-0 border-r" style={{ height: `${rowHeight}px` }}>
                <GridCell col={12} value={row.bd_astm} {...commonCellProps} className="text-center font-mono">
                    <Input autoFocus type="number" step="0.001" value={row.bd_astm} onChange={(e) => updateRow(index, 'bd_astm', e.target.value)} className={cn(inputClass, "text-center font-mono")} style={inputStyle} />
                </GridCell>
            </TableCell>
            {/* 13: JIS */}
            <TableCell className="px-1 py-0 border-r" style={{ height: `${rowHeight}px` }}>
                <GridCell col={13} value={row.bd_jis} {...commonCellProps} className="text-center font-mono">
                    <Input autoFocus type="number" step="0.001" value={row.bd_jis} onChange={(e) => updateRow(index, 'bd_jis', e.target.value)} className={cn(inputClass, "text-center font-mono")} style={inputStyle} />
                </GridCell>
            </TableCell>
            {/* 14: VM */}
            <TableCell className="px-1 py-0 border-r" style={{ height: `${rowHeight}px` }}>
                <GridCell col={14} value={row.vm} {...commonCellProps} className="text-center font-mono">
                    <Input autoFocus type="number" step="0.01" value={row.vm} onChange={(e) => updateRow(index, 'vm', e.target.value)} className={cn(inputClass, "text-center font-mono")} style={inputStyle} />
                </GridCell>
            </TableCell>
            {/* 15: ASH */}
            <TableCell className="px-1 py-0 border-r" style={{ height: `${rowHeight}px` }}>
                <GridCell col={15} value={row.ash} {...commonCellProps} className="text-center font-mono">
                    <Input autoFocus type="number" step="0.01" value={row.ash} onChange={(e) => updateRow(index, 'ash', e.target.value)} className={cn(inputClass, "text-center font-mono")} style={inputStyle} />
                </GridCell>
            </TableCell>
            {/* 16: FC */}
            <TableCell className="px-1 py-0 border-r" style={{ height: `${rowHeight}px` }}>
                <GridCell col={16} value={row.fc} {...commonCellProps} className="text-center font-mono">
                    <Input autoFocus type="number" step="0.01" value={row.fc} onChange={(e) => updateRow(index, 'fc', e.target.value)} className={cn(inputClass, "text-center font-mono")} style={inputStyle} />
                </GridCell>
            </TableCell>

            {/* 17: REMARKS */}
            <TableCell className="px-1 py-0 border-r" style={{ height: `${rowHeight}px` }}>
                <GridCell col={17} value={row.remarks} {...commonCellProps}
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

            {/* 18: PRICE */}
            <TableCell className="px-1 py-0 border-r" style={{ height: `${rowHeight}px` }}>
                <GridCell col={18} value={row.cost_basis} {...commonCellProps}
                    displayValue={
                        <div className="flex items-center justify-between h-full w-full px-1">
                            <span className="text-muted-foreground mr-1">₱</span>
                            <span>{row.cost_basis}</span>
                        </div>
                    }
                >
                    <div className="flex items-center justify-between h-full w-full relative">
                        <span className="text-muted-foreground absolute left-0 pl-1 z-10" style={inputStyle}>₱</span>
                        <Input
                            autoFocus
                            type="number"
                            step="0.01"
                            value={row.cost_basis}
                            onChange={(e) => updateRow(index, 'cost_basis', e.target.value)}
                            className={cn(inputClass, "w-full text-right font-mono font-bold pr-1")}
                            placeholder="0.00"
                            style={{ ...inputStyle, paddingLeft: '16px' }}
                        />
                    </div>
                </GridCell>
            </TableCell>

            {/* 19: TTL (Calculated) */}
            <TableCell className="px-1 py-0 text-right border-r" style={{ height: `${rowHeight}px` }}>
                <div className="flex items-center justify-between h-full px-1">
                    <span className="text-muted-foreground" style={inputStyle}>₱</span>
                    <span className="text-right font-mono font-bold" style={inputStyle}>
                        {ttlValue.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                    </span>
                </div>
            </TableCell>

            {/* Remove row */}
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

    React.useEffect(() => {
        if (isActive && !isEditing && gridRef?.current) {
            // ensure grid has focus so arrows work
        }
    }, [isActive, isEditing, gridRef]);

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
                // Use startEditing to capture initial value
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
                    <p className="text-xs text-muted-foreground">Add notes about this delivery.</p>
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
                                // Prevent default to avoid browser quirks
                                e.preventDefault();
                                e.stopPropagation();
                                e.nativeEvent.stopImmediatePropagation();
                                // Directly call revert logic
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
                    // Force revert immediately
                    if (onRevert) onRevert();
                    return;
            }
        }
    }, [open, filtered, selectedIndex, onSelect]);

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
                            // If NOT open, handle Escape to revert (bubble up) NO, handle specifically
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
