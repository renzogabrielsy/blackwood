'use client';

import * as React from 'react';
import { toast } from 'sonner';
import { errorToast } from '@/lib/toast';
import { Plus, X, MessageSquareText, PencilLine, MessageSquarePlus } from 'lucide-react';
import { cn, focusNoScroll } from '@/lib/utils';
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
import { submitBulkDeliveries, bulkUpdateDeliveries } from './actions';
import { calculateWhse } from '@/lib/rc-utils';
import { useTableSettings } from '@/components/providers/table-settings';
import { useAuth } from '@/components/providers/auth-context';
import { COLUMN_MAP, cleanCellValue } from './paste-utils';
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
import { useGridPaste } from '@/lib/hooks/use-grid-paste';
import { useStatusBar } from '@/components/providers/status-bar-context';
import type { DeliveryRow, InputDeliveryRow } from '@/types/rc-in';
import { AutocompletePopover, type AutocompleteItem } from '@/components/shared/AutocompletePopover';
import { GridCell } from '@/components/shared/grid/GridCell';
import { RemarksCellAdaptor } from '@/components/shared/grid/RemarksCellAdaptor';

export type { InputDeliveryRow } from '@/types/rc-in';

// --- TYPES ---
type Batch = {
    id: string;
    batch_code: string;
    location_ref: string;
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
        case 'IN-USE': return 'text-blue-700 bg-blue-200 dark:text-blue-300 dark:bg-blue-900 shadow-sm ring-1 ring-blue-300/60 dark:ring-blue-600/40';
        case 'CLOSED': return 'text-red-700 bg-red-200 dark:text-red-300 dark:bg-red-900 shadow-sm ring-1 ring-red-300/60 dark:ring-red-600/40';
        case 'SUNDRYING': return 'text-amber-700 bg-amber-200 dark:text-amber-300 dark:bg-amber-900 shadow-sm ring-1 ring-amber-300/60 dark:ring-amber-600/40';
        default: return 'text-muted-foreground bg-muted/10'; // STORED
    }
}

const inputClass = "h-8 w-full px-1 border-transparent bg-transparent rounded-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-primary focus-visible:bg-accent/10 transition-colors shadow-none";

/**
 * Focus an input in the grid by row/col data attributes.
 * `preventScroll` — see the note on the mouse-up handler below: a bare focus() scrolls
 * every ancestor to centre the target, even one already fully on screen.
 */
function focusCell(container: HTMLElement | null, row: number, col: number) {
    if (!container) return;
    const target = container.querySelector<HTMLInputElement>(`[data-row="${row}"][data-col="${col}"]`);
    target?.focus({ preventScroll: true });
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
    const { setCellSelectionCount, setCellAggregates } = useStatusBar();
    const canViewPrices = hasPermission('view:prices');
    const isEdit = mode === 'edit';

    // In edit mode, store original IDs aligned by row index
    const rowIdsRef = React.useRef<string[]>(initialData?.map(d => d.id) ?? []);
    const gridRef = React.useRef<HTMLDivElement>(null);

    // Stable indirection so the mouse/blur handlers can end an active edit
    // without a forward reference to the edit session (which is created later,
    // after updateRow). Assigned once the edit session exists.
    const endEditRef = React.useRef<() => void>(() => {});

    const [rows, setRows] = React.useState<InputDeliveryRow[]>(() => {
        if (initialData && initialData.length > 0) {
            return initialData.map(deliveryToInputRow);
        }
        return [createEmptyRow()];
    });
    // Track audit comments by row index for edit mode
    const [auditComments, setAuditComments] = React.useState<Record<number, string>>({});

    const [isSubmitting, setIsSubmitting] = React.useState(false);
    const [activeCell, setActiveCell] = React.useState<CoordinateId | null>(null);

    // --- Cell range selection ---
    const cellSelection = useCellSelection({
        rowCount: rows.length,
        colCount: COLUMN_MAP.length,
        isSelectableColumn: (colIdx) => COLUMN_MAP[colIdx] !== null && colIdx !== 0,
        scrollContainerRef: gridRef,
        enabled: true,
    });

    const selectionSize = cellSelection.getSelectionSize();

    const getCellValue = React.useCallback((rowIdx: number, colIdx: number): string => {
        const row = rows[rowIdx];
        if (!row) return '';
        const field = COLUMN_MAP[colIdx];
        if (!field) return '';
        const val = row[field];
        return val != null ? String(val) : '';
    }, [rows]);

    const NUMERIC_BULK_COLS: Set<string> = React.useMemo(() => new Set(['weight_kg', 'sacks', 'mc', 'grit', 'bd_astm', 'bd_jis', 'vm', 'ash', 'fc', 'cost_basis']), []);
    const getNumericCellValue = React.useCallback((rowIdx: number, colIdx: number): number | null => {
        const row = rows[rowIdx];
        if (!row) return null;
        const field = COLUMN_MAP[colIdx];
        if (!field) return null;
        if (!NUMERIC_BULK_COLS.has(field)) return null;
        const val = parseFloat(String(row[field]));
        return isNaN(val) ? null : val;
    }, [rows, NUMERIC_BULK_COLS]);

    const getColumnDefaultCalcType = React.useCallback((colIdx: number): AggregationType | null => {
        const field = COLUMN_MAP[colIdx];
        if (!field) return null;
        switch (field) {
            case 'weight_kg':
            case 'sacks':
                return 'SUM';
            case 'mc': case 'grit': case 'bd_astm': case 'bd_jis': case 'vm': case 'ash': case 'fc':
            case 'cost_basis':
                return 'AVERAGE';
            default: return null;
        }
    }, []);

    const aggregates = useCellAggregation({ range: cellSelection.range, getNumericCellValue, getColumnDefaultCalcType });

    // Push cell selection count + aggregates to shared context (debounced to reduce re-renders during drag)
    React.useEffect(() => {
        const count = cellSelection.range ? selectionSize : 0;
        const timer = setTimeout(() => {
            setCellSelectionCount(count);
            setCellAggregates(count > 1 ? aggregates : null);
        }, 50);
        return () => { clearTimeout(timer); setCellSelectionCount(0); setCellAggregates(null); };
    }, [cellSelection.range, selectionSize, setCellSelectionCount, setCellAggregates, aggregates]);

    const { handleKeyDown: handleCopyKeyDown } = useClipboardCopy({
        getSelectedRange: cellSelection.getSelectedRange,
        getCellValue,
        getSelectionSize: cellSelection.getSelectionSize,
    });

    // --- Click-vs-drag mouse handlers ---
    const mouseDownCellRef = React.useRef<{ row: number; col: number } | null>(null);
    const dragMovedRef = React.useRef(false);

    const handleGridCellMouseDown = React.useCallback((rowIdx: number, colIdx: number, e: React.MouseEvent) => {
        mouseDownCellRef.current = { row: rowIdx, col: colIdx };
        dragMovedRef.current = false;
        cellSelection.handleCellMouseDown(rowIdx, colIdx, e);
    }, [cellSelection]);

    const handleGridCellMouseUp = React.useCallback((rowIdx: number, colIdx: number) => {
        const downCell = mouseDownCellRef.current;
        mouseDownCellRef.current = null;
        // If mouse up on same cell as mouse down and no drag happened -> single cell click
        if (downCell && downCell.row === rowIdx && downCell.col === colIdx && !dragMovedRef.current) {
            cellSelection.clearSelection();
            setActiveCell({ row: rowIdx, col: colIdx });
            endEditRef.current();
            // `preventScroll`: HTMLElement.focus() otherwise scrolls the grid wrapper into
            // view with block AND inline "center" through every scrolling ancestor — and
            // "center" always computes a target, so it fires even when nothing moved. That
            // is what jolted the page on a plain cell click. Focus still moves.
            gridRef.current?.focus({ preventScroll: true });
        }
        dragMovedRef.current = false;
    }, [cellSelection, setActiveCell]);

    const handleGridCellMouseEnter = React.useCallback((rowIdx: number, colIdx: number) => {
        // Use mouseDownCellRef (set synchronously) instead of cellSelection.isDragging (stale state)
        if (mouseDownCellRef.current) {
            dragMovedRef.current = true;
            cellSelection.handleCellMouseEnter(rowIdx, colIdx);
        }
    }, [cellSelection]);

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

    const updateRow = React.useCallback((index: number, field: keyof InputDeliveryRow, value: InputDeliveryRow[keyof InputDeliveryRow]) => {
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

    // Cell delete (placed after updateRow to avoid "used before declaration")
    const clearCellByIndex = React.useCallback((rowIdx: number, colIdx: number) => {
        const field = COLUMN_MAP[colIdx];
        if (field && field !== 'state') {
            updateRow(rowIdx, field, '');
        }
    }, [updateRow]);

    const { handleKeyDown: handleDeleteKeyDown } = useCellDelete({
        getSelectedRange: cellSelection.getSelectedRange,
        getSelectionSize: cellSelection.getSelectionSize,
        clearCell: clearCellByIndex,
    });

    const isRangeSelected = cellSelection.getSelectionSize() > 1;

    // --- EDIT SESSION (shared Blackwood Table primitive) ---
    // Owns isEditing + the pre-edit snapshot + start/revert/commit. Wired to the
    // grid's existing getCellValue/updateRow via the {row,col} coordinate id.
    const setCellValue = React.useCallback((id: CoordinateId, value: string) => {
        const field = COLUMN_MAP[id.col];
        if (field) updateRow(id.row, field, value);
    }, [updateRow]);

    // NOTE: commit does NOT auto-focus the grid — focus is restored explicitly
    // only at the call sites that did so before (Tab/Enter commit, Escape revert,
    // single-cell click). onBlur must NOT re-focus, so focus is kept out of here.
    const editSession = useGridEditSession<CoordinateId>({
        getValue: (id) => getCellValue(id.row, id.col),
        setValue: setCellValue,
    });
    const isEditing = editSession.isEditing;
    const setIsEditing = React.useCallback((editing: boolean) => {
        if (!editing) editSession.commit();
    }, [editSession]);
    // Keep the stable endEdit indirection pointing at the latest commit.
    endEditRef.current = () => { if (editSession.isEditing) editSession.commit(); };

    // GridCell-compatible adapters: GridCell calls onStartEditing(row, col, char?)
    // and onRevert(); the edit session is keyed by a {row,col} id.
    const startEditing = React.useCallback((rowIdx: number, colIdx: number, initialChar?: string) => {
        if (COLUMN_MAP[colIdx] == null) return;
        setActiveCell({ row: rowIdx, col: colIdx });
        editSession.startEditing({ row: rowIdx, col: colIdx }, initialChar);
    }, [editSession]);

    const revertChanges = React.useCallback(() => {
        editSession.revertChanges();
        gridRef.current?.focus({ preventScroll: true });
    }, [editSession]);

    // --- GRID NAVIGATION (shared Blackwood Table primitives) ---
    // Coordinate resolver = the old moveSelection math (skip null cols, Tab
    // row-wrap + clamp, Enter down / Shift+Enter up). Rebuilt when row count
    // changes so Tab/Enter boundary clamps stay correct.
    const resolver = React.useMemo(
        () => createCoordinateNavResolver({ rowCount: rows.length, columnMap: COLUMN_MAP }),
        [rows.length]
    );

    // Range slot = the existing useCellSelection + copy + delete instances, wired
    // into the state machine's opt-in rectangular-selection capability.
    const rangeSlot = React.useMemo<GridRangeSlot>(() => ({
        isRangeSelected,
        extend: (e) => cellSelection.handleKeyDown(e),
        clear: () => cellSelection.clearSelection(),
        seedFromActive: () => {
            if (!activeCell) return;
            // Seed anchor at current cell (the old Shift+Arrow trick).
            cellSelection.handleCellMouseDown(
                activeCell.row,
                activeCell.col,
                { shiftKey: false, preventDefault: () => {} } as unknown as React.MouseEvent
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

    const { handleKeyDown: handleGridKeyDown } = useGridKeyboardNav<CoordinateId>({
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
        // RC IN never used the Tab-then-Enter "return to lane" behavior — plain
        // Enter always dropped straight down. Keep that exact behavior.
        enableEnterAnchor: false,
    });

    // --- PASTE LOGIC (shared smart-paste primitive) ---
    const { handleSmartPaste, handleGridPaste: handleGridPasteAt } = useGridPaste<InputDeliveryRow>({
        columnMap: COLUMN_MAP,
        setRows,
        createEmptyRow,
        cleanCellValue,
    });

    // Handle paste on the grid container when in selection mode (not editing).
    const handleGridPaste = React.useCallback((e: React.ClipboardEvent) => {
        if (!isEditing) {
            handleGridPasteAt(e, activeCell, () => cellSelection.clearSelection());
        }
    }, [isEditing, activeCell, handleGridPasteAt, cellSelection]);

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
                errorToast(`${isEdit ? 'Update' : 'Submission'} failed: ` + res.message);
            }
        } catch (error: unknown) {
            errorToast('An unexpected error occurred: ' + (error instanceof Error ? error.message : 'Unknown'));
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
                    className="border rounded-md overflow-hidden overflow-x-auto relative max-h-[60dvh] outline-none select-none"
                    tabIndex={-1}
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
                        <TableHeader className="bg-muted/90 backdrop-blur-sm sticky top-0 z-50 shadow-sm border-b">
                            <TableRow className="hover:bg-transparent border-b" style={{ height: `${rowHeight}px` }}>
                                {/* Updated Header to include visual index reference if needed, but keeping clean for now */}
                                <TableHead className="w-[30px] p-0 sticky left-0 z-50 bg-muted border-b border-foreground/20 shadow-none  after:absolute after:right-0 after:top-0 after:bottom-0 after:w-px after:bg-foreground/20 last:after:hidden"></TableHead>
                                <TableHead className="w-[40px] text-center px-1 py-1 font-mono font-bold border-b border-foreground/20 bg-muted/90 sticky top-0 z-50 shadow-none  after:absolute after:right-0 after:top-0 after:bottom-0 after:w-px after:bg-foreground/20 last:after:hidden" style={{ fontSize: `${fontSize}px` }}>STATE</TableHead>
                                <TableHead className="w-[40px] text-center px-1 py-1 font-mono font-bold border-b border-foreground/20 bg-muted/90 sticky top-0 z-50 shadow-none  after:absolute after:right-0 after:top-0 after:bottom-0 after:w-px after:bg-foreground/20 last:after:hidden" style={{ fontSize: `${fontSize}px` }}>WHSE</TableHead>
                                <TableHead className="w-[70px] text-center px-1 py-1 font-mono font-bold border-b border-foreground/20 bg-muted/90 sticky top-0 z-50 shadow-none  after:absolute after:right-0 after:top-0 after:bottom-0 after:w-px after:bg-foreground/20 last:after:hidden" style={{ fontSize: `${fontSize}px` }}>DATE</TableHead>
                                <TableHead className="w-[120px] text-center px-1 py-1 font-mono font-bold border-b border-foreground/20 bg-muted/90 sticky top-0 z-50 shadow-none  after:absolute after:right-0 after:top-0 after:bottom-0 after:w-px after:bg-foreground/20 last:after:hidden" style={{ fontSize: `${fontSize}px` }}>SUPPLIER</TableHead>
                                <TableHead className="w-[80px] text-center px-1 py-1 font-mono font-bold border-b border-foreground/20 bg-muted/90 sticky top-0 z-50 shadow-none  after:absolute after:right-0 after:top-0 after:bottom-0 after:w-px after:bg-foreground/20 last:after:hidden" style={{ fontSize: `${fontSize}px` }}>BLOCK</TableHead>
                                <TableHead className="w-[40px] text-center px-1 py-1 font-mono font-bold border-b border-foreground/20 bg-muted/90 sticky top-0 z-50 shadow-none  after:absolute after:right-0 after:top-0 after:bottom-0 after:w-px after:bg-foreground/20 last:after:hidden" style={{ fontSize: `${fontSize}px` }}>LOC</TableHead>
                                <TableHead className="w-[50px] text-center px-1 py-1 font-mono font-bold border-b border-foreground/20 bg-muted/90 sticky top-0 z-50 shadow-none  after:absolute after:right-0 after:top-0 after:bottom-0 after:w-px after:bg-foreground/20 last:after:hidden" style={{ fontSize: `${fontSize}px` }}>TRUCK</TableHead>
                                <TableHead className="w-[50px] text-center px-1 py-1 font-mono font-bold border-b border-foreground/20 bg-muted/90 sticky top-0 z-50 shadow-none  after:absolute after:right-0 after:top-0 after:bottom-0 after:w-px after:bg-foreground/20 last:after:hidden" style={{ fontSize: `${fontSize}px` }}>WT</TableHead>
                                <TableHead className="w-[30px] text-center px-1 py-1 font-mono font-bold border-b border-foreground/20 bg-muted/90 sticky top-0 z-50 shadow-none  after:absolute after:right-0 after:top-0 after:bottom-0 after:w-px after:bg-foreground/20 last:after:hidden" style={{ fontSize: `${fontSize}px` }}>SKS</TableHead>
                                <TableHead className="w-[35px] text-center px-1 py-1 font-mono font-bold border-b border-foreground/20 bg-muted/90 sticky top-0 z-50 shadow-none  after:absolute after:right-0 after:top-0 after:bottom-0 after:w-px after:bg-foreground/20 last:after:hidden" style={{ fontSize: `${fontSize}px` }}>MC</TableHead>
                                <TableHead className="w-[35px] text-center px-1 py-1 font-mono font-bold border-b border-foreground/20 bg-muted/90 sticky top-0 z-50 shadow-none  after:absolute after:right-0 after:top-0 after:bottom-0 after:w-px after:bg-foreground/20 last:after:hidden" style={{ fontSize: `${fontSize}px` }}>GRIT</TableHead>
                                <TableHead className="w-[35px] text-center px-1 py-1 font-mono font-bold border-b border-foreground/20 bg-muted/90 sticky top-0 z-50 shadow-none  after:absolute after:right-0 after:top-0 after:bottom-0 after:w-px after:bg-foreground/20 last:after:hidden" style={{ fontSize: `${fontSize}px` }}>ASTM</TableHead>
                                <TableHead className="w-[35px] text-center px-1 py-1 font-mono font-bold border-b border-foreground/20 bg-muted/90 sticky top-0 z-50 shadow-none  after:absolute after:right-0 after:top-0 after:bottom-0 after:w-px after:bg-foreground/20 last:after:hidden" style={{ fontSize: `${fontSize}px` }}>JIS</TableHead>
                                <TableHead className="w-[35px] text-center px-1 py-1 font-mono font-bold border-b border-foreground/20 bg-muted/90 sticky top-0 z-50 shadow-none  after:absolute after:right-0 after:top-0 after:bottom-0 after:w-px after:bg-foreground/20 last:after:hidden" style={{ fontSize: `${fontSize}px` }}>VM</TableHead>
                                <TableHead className="w-[35px] text-center px-1 py-1 font-mono font-bold border-b border-foreground/20 bg-muted/90 sticky top-0 z-50 shadow-none  after:absolute after:right-0 after:top-0 after:bottom-0 after:w-px after:bg-foreground/20 last:after:hidden" style={{ fontSize: `${fontSize}px` }}>ASH</TableHead>
                                <TableHead className="w-[35px] text-center px-1 py-1 font-mono font-bold border-b border-foreground/20 bg-muted/90 sticky top-0 z-50 shadow-none  after:absolute after:right-0 after:top-0 after:bottom-0 after:w-px after:bg-foreground/20 last:after:hidden" style={{ fontSize: `${fontSize}px` }}>FC</TableHead>
                                <TableHead className="w-[60px] text-center px-1 py-1 font-mono font-bold border-b border-foreground/20 bg-muted/90 sticky top-0 z-50 shadow-none  after:absolute after:right-0 after:top-0 after:bottom-0 after:w-px after:bg-foreground/20 last:after:hidden" style={{ fontSize: `${fontSize}px` }}>REMARKS</TableHead>
                                {canViewPrices && (
                                    <>
                                        <TableHead className="w-[50px] text-center px-1 py-1 font-mono font-bold border-b border-foreground/20 bg-muted/90 sticky top-0 z-50 shadow-none  after:absolute after:right-0 after:top-0 after:bottom-0 after:w-px after:bg-foreground/20 last:after:hidden" style={{ fontSize: `${fontSize}px` }}>PHP/KG</TableHead>
                                        <TableHead className="w-[85px] text-center px-1 py-1 font-mono font-bold bg-muted/90 sticky top-0 z-50 border-b border-foreground/20 shadow-none  after:absolute after:right-0 after:top-0 after:bottom-0 after:w-px after:bg-foreground/20 last:after:hidden" style={{ fontSize: `${fontSize}px` }}>PHP TTL</TableHead>
                                    </>
                                )}
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
                                    cellMouseDown={(col, e) => handleGridCellMouseDown(index, col, e)}
                                    cellMouseUp={(col) => handleGridCellMouseUp(index, col)}
                                    cellMouseEnter={(col) => handleGridCellMouseEnter(index, col)}
                                    isCellSelected={(col) => cellSelection.isSelected(index, col)}
                                    isCellAnchor={(col) => cellSelection.isAnchor(index, col)}
                                    isDragging={cellSelection.isDragging}
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
    canViewPrices,
    cellMouseDown,
    cellMouseUp,
    cellMouseEnter,
    isCellSelected,
    isCellAnchor,
    isDragging,
}: {
    row: InputDeliveryRow;
    index: number;
    batches: Batch[];
    batchItems: AutocompleteItem[];
    supplierItems: AutocompleteItem[];
    updateRow: (index: number, field: keyof InputDeliveryRow, value: InputDeliveryRow[keyof InputDeliveryRow]) => void;
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
    cellMouseDown: (col: number, e: React.MouseEvent) => void;
    cellMouseUp: (col: number) => void;
    cellMouseEnter: (col: number) => void;
    isCellSelected: (col: number) => boolean;
    isCellAnchor: (col: number) => boolean;
    isDragging: boolean;
}) {
    const whse = calculateWhse(row.block_loc, row.batch_code);
    const wt = parseFloat(String(row.weight_kg)) || 0;
    const price = parseFloat(String(row.cost_basis)) || 0;
    const ttlValue = wt * price;

    const inputStyle = { fontSize: `${fontSize}px` };

    // Helper to generate cell selection props for a given column
    const selectionPropsForCol = (col: number) => ({
        onCellMouseDown: (e: React.MouseEvent) => cellMouseDown(col, e),
        onCellMouseUp: () => cellMouseUp(col),
        onCellMouseEnter: () => cellMouseEnter(col),
        isCellRangeSelected: isCellSelected(col),
        isCellRangeAnchor: isCellAnchor(col),
        isDragActive: isDragging,
    });

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
                <GridCell col={3} value={row.transaction_date} {...commonCellProps} {...selectionPropsForCol(3)}>
                    <Input
                        ref={focusNoScroll}
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
                <GridCell col={4} value={row.supplier} {...commonCellProps} {...selectionPropsForCol(4)} className="font-bold text-left pl-1">
                    <AutocompletePopover
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
                <GridCell col={5} value={row.batch_code} {...commonCellProps} {...selectionPropsForCol(5)}>
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

            {/* 6: LOC */}
            <TableCell className="px-1 py-0 border-r" style={{ height: `${rowHeight}px` }}>
                <GridCell col={6} value={row.block_loc} {...commonCellProps} {...selectionPropsForCol(6)}>
                    <Input
                        ref={focusNoScroll}
                        value={row.block_loc}
                        onChange={(e) => updateRow(index, 'block_loc', e.target.value)}
                        className={cn(inputClass, "font-bold text-center font-mono")}
                        style={inputStyle}
                    />
                </GridCell>
            </TableCell>

            {/* 7: TRUCK */}
            <TableCell className="px-1 py-0 border-r" style={{ height: `${rowHeight}px` }}>
                <GridCell col={7} value={row.truck_plate} {...commonCellProps} {...selectionPropsForCol(7)} className="text-center font-mono">
                    <Input
                        ref={focusNoScroll}
                        value={row.truck_plate}
                        onChange={(e) => updateRow(index, 'truck_plate', e.target.value)}
                        className={cn(inputClass, "text-center font-mono")}
                        style={inputStyle}
                    />
                </GridCell>
            </TableCell>

            {/* 8: WT */}
            <TableCell className="px-1 py-0 border-r" style={{ height: `${rowHeight}px` }}>
                <GridCell col={8} value={row.weight_kg} {...commonCellProps} {...selectionPropsForCol(8)}>
                    <Input
                        ref={focusNoScroll}
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
                <GridCell col={9} value={row.sacks} {...commonCellProps} {...selectionPropsForCol(9)} className="text-center font-mono">
                    <Input
                        ref={focusNoScroll}
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
                <GridCell col={10} value={row.mc} {...commonCellProps} {...selectionPropsForCol(10)} className="text-center font-mono">
                    <Input ref={focusNoScroll} type="number" step="0.01" value={row.mc} onChange={(e) => updateRow(index, 'mc', e.target.value)} className={cn(inputClass, "text-center font-mono")} style={inputStyle} />
                </GridCell>
            </TableCell>
            {/* 11: GRIT */}
            <TableCell className="px-1 py-0 border-r" style={{ height: `${rowHeight}px` }}>
                <GridCell col={11} value={row.grit} {...commonCellProps} {...selectionPropsForCol(11)} className="text-center font-mono">
                    <Input ref={focusNoScroll} type="number" step="0.01" value={row.grit} onChange={(e) => updateRow(index, 'grit', e.target.value)} className={cn(inputClass, "text-center font-mono")} style={inputStyle} />
                </GridCell>
            </TableCell>
            {/* 12: ASTM */}
            <TableCell className="px-1 py-0 border-r" style={{ height: `${rowHeight}px` }}>
                <GridCell col={12} value={row.bd_astm} {...commonCellProps} {...selectionPropsForCol(12)} className="text-center font-mono">
                    <Input ref={focusNoScroll} type="number" step="0.001" value={row.bd_astm} onChange={(e) => updateRow(index, 'bd_astm', e.target.value)} className={cn(inputClass, "text-center font-mono")} style={inputStyle} />
                </GridCell>
            </TableCell>
            {/* 13: JIS */}
            <TableCell className="px-1 py-0 border-r" style={{ height: `${rowHeight}px` }}>
                <GridCell col={13} value={row.bd_jis} {...commonCellProps} {...selectionPropsForCol(13)} className="text-center font-mono">
                    <Input ref={focusNoScroll} type="number" step="0.001" value={row.bd_jis} onChange={(e) => updateRow(index, 'bd_jis', e.target.value)} className={cn(inputClass, "text-center font-mono")} style={inputStyle} />
                </GridCell>
            </TableCell>
            {/* 14: VM */}
            <TableCell className="px-1 py-0 border-r" style={{ height: `${rowHeight}px` }}>
                <GridCell col={14} value={row.vm} {...commonCellProps} {...selectionPropsForCol(14)} className="text-center font-mono">
                    <Input ref={focusNoScroll} type="number" step="0.01" value={row.vm} onChange={(e) => updateRow(index, 'vm', e.target.value)} className={cn(inputClass, "text-center font-mono")} style={inputStyle} />
                </GridCell>
            </TableCell>
            {/* 15: ASH */}
            <TableCell className="px-1 py-0 border-r" style={{ height: `${rowHeight}px` }}>
                <GridCell col={15} value={row.ash} {...commonCellProps} {...selectionPropsForCol(15)} className="text-center font-mono">
                    <Input ref={focusNoScroll} type="number" step="0.01" value={row.ash} onChange={(e) => updateRow(index, 'ash', e.target.value)} className={cn(inputClass, "text-center font-mono")} style={inputStyle} />
                </GridCell>
            </TableCell>
            {/* 16: FC */}
            <TableCell className="px-1 py-0 border-r" style={{ height: `${rowHeight}px` }}>
                <GridCell col={16} value={row.fc} {...commonCellProps} {...selectionPropsForCol(16)} className="text-center font-mono">
                    <Input ref={focusNoScroll} type="number" step="0.01" value={row.fc} onChange={(e) => updateRow(index, 'fc', e.target.value)} className={cn(inputClass, "text-center font-mono")} style={inputStyle} />
                </GridCell>
            </TableCell>

            {/* 17: REMARKS */}
            <TableCell className="px-1 py-0 border-r" style={{ height: `${rowHeight}px` }}>
                <GridCell col={17} value={row.remarks} {...commonCellProps} {...selectionPropsForCol(17)}
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
            {canViewPrices && (
                <TableCell className="px-1 py-0 border-r" style={{ height: `${rowHeight}px` }}>
                    <GridCell col={18} value={row.cost_basis} {...commonCellProps} {...selectionPropsForCol(18)}
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
                                ref={focusNoScroll}
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
            )}

            {/* 19: TTL (Calculated) */}
            {canViewPrices && (
                <TableCell className="px-1 py-0 text-right border-r" style={{ height: `${rowHeight}px` }}>
                    <div className="flex items-center justify-between h-full px-1">
                        <span className="text-muted-foreground" style={inputStyle}>₱</span>
                        <span className="text-right font-mono font-bold" style={inputStyle}>
                            {ttlValue.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                        </span>
                    </div>
                </TableCell>
            )}

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
// GridCell, RemarksCellAdaptor, and AutocompletePopover are now imported from shared components
