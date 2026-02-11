'use client';

import * as React from 'react';
import { toast } from 'sonner';
import { Check, Plus, Trash2, MessageSquareText } from 'lucide-react';
import { cn } from '@/lib/utils';
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
    TooltipProvider,
} from '@/components/ui/tooltip';
import { submitBulkDeliveries, bulkUpdateDeliveries, DeliveryRow } from './actions';
import { calculateWhse } from '@/lib/rc-utils';
import { useTableSettings } from './table-settings';
import { COLUMN_MAP, cleanCellValue } from './paste-utils';

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

export type InputDeliveryRow = {
    state: string;
    whse: string;
    transaction_date: string;
    supplier: string;
    batch_code: string;
    block_loc: string;
    truck_plate: string;
    weight_kg: number | string;
    sacks: number | string;
    mc: number | string;
    grit: number | string;
    bd_astm: number | string;
    bd_jis: number | string;
    vm: number | string;
    ash: number | string;
    fc: number | string;
    remarks: string;
    cost_basis: number | string;
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

const inputClass = "h-8 w-full text-[10px] md:text-[10px] px-1 border-transparent bg-transparent rounded-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-primary focus-visible:bg-accent/10 transition-colors shadow-none";

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
};

export function BulkDeliveryInput({ batches, suppliers, onSuccess, mode = 'create', initialData }: BulkDeliveryInputProps) {
    const { fontSize, rowHeight } = useTableSettings();
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
    const [isSubmitting, setIsSubmitting] = React.useState(false);

    // --- ROW MANAGEMENT ---
    const addRow = React.useCallback(() => {
        setRows(prev => [...prev, createEmptyRow()]);
    }, []);

    const removeRow = React.useCallback((index: number) => {
        setRows(prev => prev.length > 1 ? prev.filter((_, i) => i !== index) : prev);
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

    // --- SUBMISSION ---
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
                                <span className="hidden md:inline">Pro Tip: You can copy cells from Excel and paste them directly into the grid. </span>
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

                <div ref={gridRef} className="border rounded-md overflow-hidden overflow-x-auto relative max-h-[60vh]">
                    <table className="w-full table-fixed text-xs relative caption-bottom border-collapse">
                        <TableHeader className="bg-muted sticky top-0 z-50 shadow-sm border-b">
                            <TableRow className="hover:bg-transparent border-b" style={{ height: `${rowHeight}px` }}>
                                {/* Updated Header to include visual index reference if needed, but keeping clean for now */}
                                <TableHead className="w-[30px] p-0 sticky left-0 z-50 bg-muted border-b border-foreground/20 shadow-none relative after:absolute after:right-0 after:top-0 after:bottom-0 after:w-[1px] after:bg-foreground/20 last:after:hidden"></TableHead>
                                <TableHead className="w-[40px] text-center px-1 py-1 font-mono font-bold border-b border-foreground/20 bg-muted sticky top-0 z-50 shadow-none relative after:absolute after:right-0 after:top-0 after:bottom-0 after:w-[1px] after:bg-foreground/20 last:after:hidden" style={{ fontSize: `${fontSize}px` }}>STATE</TableHead>
                                <TableHead className="w-[40px] text-center px-1 py-1 font-mono font-bold border-b border-foreground/20 bg-muted sticky top-0 z-50 shadow-none relative after:absolute after:right-0 after:top-0 after:bottom-0 after:w-[1px] after:bg-foreground/20 last:after:hidden" style={{ fontSize: `${fontSize}px` }}>WHSE</TableHead>
                                <TableHead className="w-[70px] text-center px-1 py-1 font-mono font-bold border-b border-foreground/20 bg-muted sticky top-0 z-50 shadow-none relative after:absolute after:right-0 after:top-0 after:bottom-0 after:w-[1px] after:bg-foreground/20 last:after:hidden" style={{ fontSize: `${fontSize}px` }}>DATE</TableHead>
                                <TableHead className="w-[120px] text-center px-1 py-1 font-mono font-bold border-b border-foreground/20 bg-muted sticky top-0 z-50 shadow-none relative after:absolute after:right-0 after:top-0 after:bottom-0 after:w-[1px] after:bg-foreground/20 last:after:hidden" style={{ fontSize: `${fontSize}px` }}>SUPPLIER</TableHead>
                                <TableHead className="w-[80px] text-center px-1 py-1 font-mono font-bold border-b border-foreground/20 bg-muted sticky top-0 z-50 shadow-none relative after:absolute after:right-0 after:top-0 after:bottom-0 after:w-[1px] after:bg-foreground/20 last:after:hidden" style={{ fontSize: `${fontSize}px` }}>BLOCK</TableHead>
                                <TableHead className="w-[40px] text-center px-1 py-1 font-mono font-bold border-b border-foreground/20 bg-muted sticky top-0 z-50 shadow-none relative after:absolute after:right-0 after:top-0 after:bottom-0 after:w-[1px] after:bg-foreground/20 last:after:hidden" style={{ fontSize: `${fontSize}px` }}>LOC</TableHead>
                                <TableHead className="w-[50px] text-center px-1 py-1 font-mono font-bold border-b border-foreground/20 bg-muted sticky top-0 z-50 shadow-none relative after:absolute after:right-0 after:top-0 after:bottom-0 after:w-[1px] after:bg-foreground/20 last:after:hidden" style={{ fontSize: `${fontSize}px` }}>TRUCK</TableHead>
                                <TableHead className="w-[50px] text-center px-1 py-1 font-mono font-bold border-b border-foreground/20 bg-muted sticky top-0 z-50 shadow-none relative after:absolute after:right-0 after:top-0 after:bottom-0 after:w-[1px] after:bg-foreground/20 last:after:hidden" style={{ fontSize: `${fontSize}px` }}>WT</TableHead>
                                <TableHead className="w-[30px] text-center px-1 py-1 font-mono font-bold border-b border-foreground/20 bg-muted sticky top-0 z-50 shadow-none relative after:absolute after:right-0 after:top-0 after:bottom-0 after:w-[1px] after:bg-foreground/20 last:after:hidden" style={{ fontSize: `${fontSize}px` }}>SKS</TableHead>
                                <TableHead className="w-[35px] text-center px-1 py-1 font-mono font-bold border-b border-foreground/20 bg-muted sticky top-0 z-50 shadow-none relative after:absolute after:right-0 after:top-0 after:bottom-0 after:w-[1px] after:bg-foreground/20 last:after:hidden" style={{ fontSize: `${fontSize}px` }}>MC</TableHead>
                                <TableHead className="w-[35px] text-center px-1 py-1 font-mono font-bold border-b border-foreground/20 bg-muted sticky top-0 z-50 shadow-none relative after:absolute after:right-0 after:top-0 after:bottom-0 after:w-[1px] after:bg-foreground/20 last:after:hidden" style={{ fontSize: `${fontSize}px` }}>GRIT</TableHead>
                                <TableHead className="w-[35px] text-center px-1 py-1 font-mono font-bold border-b border-foreground/20 bg-muted sticky top-0 z-50 shadow-none relative after:absolute after:right-0 after:top-0 after:bottom-0 after:w-[1px] after:bg-foreground/20 last:after:hidden" style={{ fontSize: `${fontSize}px` }}>ASTM</TableHead>
                                <TableHead className="w-[35px] text-center px-1 py-1 font-mono font-bold border-b border-foreground/20 bg-muted sticky top-0 z-50 shadow-none relative after:absolute after:right-0 after:top-0 after:bottom-0 after:w-[1px] after:bg-foreground/20 last:after:hidden" style={{ fontSize: `${fontSize}px` }}>JIS</TableHead>
                                <TableHead className="w-[35px] text-center px-1 py-1 font-mono font-bold border-b border-foreground/20 bg-muted sticky top-0 z-50 shadow-none relative after:absolute after:right-0 after:top-0 after:bottom-0 after:w-[1px] after:bg-foreground/20 last:after:hidden" style={{ fontSize: `${fontSize}px` }}>VM</TableHead>
                                <TableHead className="w-[35px] text-center px-1 py-1 font-mono font-bold border-b border-foreground/20 bg-muted sticky top-0 z-50 shadow-none relative after:absolute after:right-0 after:top-0 after:bottom-0 after:w-[1px] after:bg-foreground/20 last:after:hidden" style={{ fontSize: `${fontSize}px` }}>ASH</TableHead>
                                <TableHead className="w-[35px] text-center px-1 py-1 font-mono font-bold border-b border-foreground/20 bg-muted sticky top-0 z-50 shadow-none relative after:absolute after:right-0 after:top-0 after:bottom-0 after:w-[1px] after:bg-foreground/20 last:after:hidden" style={{ fontSize: `${fontSize}px` }}>FC</TableHead>
                                <TableHead className="w-[60px] text-center px-1 py-1 font-mono font-bold border-b border-foreground/20 bg-muted sticky top-0 z-50 shadow-none relative after:absolute after:right-0 after:top-0 after:bottom-0 after:w-[1px] after:bg-foreground/20 last:after:hidden" style={{ fontSize: `${fontSize}px` }}>REMARKS</TableHead>
                                <TableHead className="w-[50px] text-center px-1 py-1 font-mono font-bold border-b border-foreground/20 bg-muted sticky top-0 z-50 shadow-none relative after:absolute after:right-0 after:top-0 after:bottom-0 after:w-[1px] after:bg-foreground/20 last:after:hidden" style={{ fontSize: `${fontSize}px` }}>PHP/KG</TableHead>
                                <TableHead className="w-[85px] text-center px-1 py-1 font-mono font-bold bg-muted sticky top-0 z-50 border-b border-foreground/20 shadow-none" style={{ fontSize: `${fontSize}px` }}>PHP TTL</TableHead>
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
// Added `onPaste` prop and wired it to inputs

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
}) {
    const whse = calculateWhse(row.block_loc, row.batch_code);

    /** Enter = move down, Shift+Enter = move up (same column) */
    const cellKeyDown = React.useCallback((e: React.KeyboardEvent, col: number) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            const targetRow = e.shiftKey ? index - 1 : index + 1;
            focusCell(gridRef.current, targetRow, col);
        }
    }, [index, gridRef]);
    const wt = parseFloat(String(row.weight_kg)) || 0;
    const price = parseFloat(String(row.cost_basis)) || 0;
    const ttlValue = wt * price;

    const inputStyle = { fontSize: `${fontSize}px` };

    return (
        <TableRow className="hover:bg-muted/50 transition-colors" style={{ height: `${rowHeight}px` }}>
            <TableCell className="p-0 sticky left-0 bg-background z-10 border-r" style={{ height: `${rowHeight}px` }}>
                <Button variant="ghost" size="icon" className="h-full w-full rounded-none text-destructive hover:text-white hover:bg-destructive/90" onClick={() => removeRow(index)}>
                    <Trash2 className="w-3 h-3" />
                </Button>
            </TableCell>

            {/* 1: STATE (Read Only) */}
            <TableCell className="px-1 py-0 border-r" style={{ height: `${rowHeight}px` }}>
                <div className="text-muted-foreground text-center font-mono uppercase bg-muted/10 py-1.5 rounded-sm h-full flex items-center justify-center" style={inputStyle}>
                    {row.state}
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
                <Input
                    data-row={index} data-col={3}
                    value={row.transaction_date}
                    onChange={(e) => updateRow(index, 'transaction_date', e.target.value)}
                    onPaste={(e) => onPaste(e, index, 3)}
                    onKeyDown={(e) => cellKeyDown(e, 3)}
                    className={cn(inputClass, "font-bold text-center font-mono")}
                    placeholder="YYYY-MM-DD"
                    style={inputStyle}
                />
            </TableCell>

            {/* 4: SUPPLIER */}
            <TableCell className="px-1 py-0 border-r" style={{ height: `${rowHeight}px` }}>
                <AutocompleteInput
                    dataRow={index} dataCol={4}
                    value={row.supplier}
                    onChange={(val) => updateRow(index, 'supplier', val)}
                    onPaste={(e) => onPaste(e, index, 4)}
                    onCellNav={cellKeyDown}
                    items={supplierItems}
                    onSelect={(val) => updateRow(index, 'supplier', val)}
                    className={cn(inputClass, "font-bold text-left")}
                    placeholder="Supplier..."
                    style={inputStyle}
                />
            </TableCell>

            {/* 5: BLOCK */}
            <TableCell className="px-1 py-0 border-r relative" style={{ height: `${rowHeight}px` }}>
                <AutocompleteInput
                    dataRow={index} dataCol={5}
                    value={row.batch_code}
                    onChange={(val) => updateRow(index, 'batch_code', val)}
                    onPaste={(e) => onPaste(e, index, 5)}
                    onCellNav={cellKeyDown}
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
                />
            </TableCell>

            {/* 6: LOC */}
            <TableCell className="px-1 py-0 border-r" style={{ height: `${rowHeight}px` }}>
                <Input
                    data-row={index} data-col={6}
                    value={row.block_loc}
                    onChange={(e) => updateRow(index, 'block_loc', e.target.value)}
                    onPaste={(e) => onPaste(e, index, 6)}
                    onKeyDown={(e) => cellKeyDown(e, 6)}
                    className={cn(inputClass, "font-bold text-center font-mono")}
                    style={inputStyle}
                />
            </TableCell>

            {/* 7: TRUCK */}
            <TableCell className="px-1 py-0 border-r" style={{ height: `${rowHeight}px` }}>
                <Input
                    data-row={index} data-col={7}
                    value={row.truck_plate}
                    onChange={(e) => updateRow(index, 'truck_plate', e.target.value)}
                    onPaste={(e) => onPaste(e, index, 7)}
                    onKeyDown={(e) => cellKeyDown(e, 7)}
                    className={cn(inputClass, "text-center font-mono")}
                    style={inputStyle}
                />
            </TableCell>

            {/* 8: WT */}
            <TableCell className="px-1 py-0 border-r" style={{ height: `${rowHeight}px` }}>
                <Input
                    data-row={index} data-col={8}
                    type="number" step="1"
                    value={row.weight_kg}
                    onChange={(e) => updateRow(index, 'weight_kg', e.target.value)}
                    onPaste={(e) => onPaste(e, index, 8)}
                    onKeyDown={(e) => cellKeyDown(e, 8)}
                    className={cn(inputClass, "font-bold text-center font-mono")}
                    style={inputStyle}
                />
            </TableCell>

            {/* 9: SKS */}
            <TableCell className="px-1 py-0 border-r" style={{ height: `${rowHeight}px` }}>
                <Input
                    data-row={index} data-col={9}
                    type="number"
                    value={row.sacks}
                    onChange={(e) => updateRow(index, 'sacks', e.target.value)}
                    onPaste={(e) => onPaste(e, index, 9)}
                    onKeyDown={(e) => cellKeyDown(e, 9)}
                    className={cn(inputClass, "text-center font-mono")}
                    style={inputStyle}
                />
            </TableCell>

            {/* 10: MC */}
            <TableCell className="px-1 py-0 border-r" style={{ height: `${rowHeight}px` }}>
                <Input data-row={index} data-col={10} type="number" step="0.01" value={row.mc} onChange={(e) => updateRow(index, 'mc', e.target.value)} onPaste={(e) => onPaste(e, index, 10)} onKeyDown={(e) => cellKeyDown(e, 10)} className={cn(inputClass, "text-center font-mono")} style={inputStyle} />
            </TableCell>
            {/* 11: GRIT */}
            <TableCell className="px-1 py-0 border-r" style={{ height: `${rowHeight}px` }}>
                <Input data-row={index} data-col={11} type="number" step="0.01" value={row.grit} onChange={(e) => updateRow(index, 'grit', e.target.value)} onPaste={(e) => onPaste(e, index, 11)} onKeyDown={(e) => cellKeyDown(e, 11)} className={cn(inputClass, "text-center font-mono")} style={inputStyle} />
            </TableCell>
            {/* 12: ASTM */}
            <TableCell className="px-1 py-0 border-r" style={{ height: `${rowHeight}px` }}>
                <Input data-row={index} data-col={12} type="number" step="0.001" value={row.bd_astm} onChange={(e) => updateRow(index, 'bd_astm', e.target.value)} onPaste={(e) => onPaste(e, index, 12)} onKeyDown={(e) => cellKeyDown(e, 12)} className={cn(inputClass, "text-center font-mono")} style={inputStyle} />
            </TableCell>
            {/* 13: JIS */}
            <TableCell className="px-1 py-0 border-r" style={{ height: `${rowHeight}px` }}>
                <Input data-row={index} data-col={13} type="number" step="0.001" value={row.bd_jis} onChange={(e) => updateRow(index, 'bd_jis', e.target.value)} onPaste={(e) => onPaste(e, index, 13)} onKeyDown={(e) => cellKeyDown(e, 13)} className={cn(inputClass, "text-center font-mono")} style={inputStyle} />
            </TableCell>
            {/* 14: VM */}
            <TableCell className="px-1 py-0 border-r" style={{ height: `${rowHeight}px` }}>
                <Input data-row={index} data-col={14} type="number" step="0.01" value={row.vm} onChange={(e) => updateRow(index, 'vm', e.target.value)} onPaste={(e) => onPaste(e, index, 14)} onKeyDown={(e) => cellKeyDown(e, 14)} className={cn(inputClass, "text-center font-mono")} style={inputStyle} />
            </TableCell>
            {/* 15: ASH */}
            <TableCell className="px-1 py-0 border-r" style={{ height: `${rowHeight}px` }}>
                <Input data-row={index} data-col={15} type="number" step="0.01" value={row.ash} onChange={(e) => updateRow(index, 'ash', e.target.value)} onPaste={(e) => onPaste(e, index, 15)} onKeyDown={(e) => cellKeyDown(e, 15)} className={cn(inputClass, "text-center font-mono")} style={inputStyle} />
            </TableCell>
            {/* 16: FC */}
            <TableCell className="px-1 py-0 border-r" style={{ height: `${rowHeight}px` }}>
                <Input data-row={index} data-col={16} type="number" step="0.01" value={row.fc} onChange={(e) => updateRow(index, 'fc', e.target.value)} onPaste={(e) => onPaste(e, index, 16)} onKeyDown={(e) => cellKeyDown(e, 16)} className={cn(inputClass, "text-center font-mono")} style={inputStyle} />
            </TableCell>

            {/* 17: REMARKS */}
            <TableCell className="px-1 py-0 border-r text-center" style={{ height: `${rowHeight}px` }}>
                <Popover>
                    <PopoverTrigger asChild>
                        <Button variant="ghost" size="icon" className={cn("h-6 w-6", row.remarks ? "text-primary" : "text-muted-foreground")}>
                            <MessageSquareText className="w-3 h-3" />
                        </Button>
                    </PopoverTrigger>
                    <PopoverContent className="w-80 p-2">
                        <div className="space-y-2">
                            <h4 className="font-medium leading-none">Remarks</h4>
                            <p className="text-xs text-muted-foreground">Add notes about this delivery.</p>
                            <Input
                                value={row.remarks}
                                onChange={(e) => updateRow(index, 'remarks', e.target.value)}
                                onPaste={(e) => onPaste(e, index, 17)}
                                className="h-8 text-sm"
                                placeholder="Enter remarks..."
                            />
                        </div>
                    </PopoverContent>
                </Popover>
            </TableCell>

            {/* 18: PRICE */}
            <TableCell className="px-1 py-0 border-r" style={{ height: `${rowHeight}px` }}>
                <div className="flex items-center justify-between h-full">
                    <span className="text-muted-foreground" style={inputStyle}>₱</span>
                    <input
                        data-row={index} data-col={18}
                        type="number"
                        step="0.01"
                        value={row.cost_basis}
                        onChange={(e) => updateRow(index, 'cost_basis', e.target.value)}
                        onPaste={(e) => onPaste(e, index, 18)}
                        onKeyDown={(e) => cellKeyDown(e, 18)}
                        className="w-full text-right bg-transparent border-none p-0 h-full font-mono font-bold focus:outline-none"
                        placeholder="0.00"
                        style={inputStyle}
                    />
                </div>
            </TableCell>

            {/* 19: TTL (Calculated) */}
            <TableCell className="px-1 py-0 text-right" style={{ height: `${rowHeight}px` }}>
                <div className="flex items-center justify-between h-full">
                    <span className="text-muted-foreground" style={inputStyle}>₱</span>
                    <span className="text-right font-mono font-bold" style={inputStyle}>
                        {ttlValue.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                    </span>
                </div>
            </TableCell>
        </TableRow>
    );
});

// --- HELPER ---
function AutocompleteInput({ value, onChange, onSelect, onPaste, onCellNav, dataRow, dataCol, items, className, placeholder, style }: {
    value: string;
    onChange: (val: string) => void;
    onSelect: (val: string) => void;
    onPaste?: (e: React.ClipboardEvent<HTMLInputElement>) => void;
    onCellNav?: (e: React.KeyboardEvent, col: number) => void;
    dataRow?: number;
    dataCol?: number;
    items: AutocompleteItem[];
    className?: string;
    placeholder?: string;
    style?: React.CSSProperties;
}) {
    const [open, setOpen] = React.useState(false);
    const inputRef = React.useRef<HTMLInputElement>(null);
    const [selectedIndex, setSelectedIndex] = React.useState(0);

    const filtered = React.useMemo(
        () => items.filter(item => item.value.toLowerCase().includes(value.toLowerCase())).slice(0, 5),
        [items, value]
    );

    // Reset selected index when filtered items change
    React.useEffect(() => {
        setSelectedIndex(0);
    }, [filtered]);

    const handleKeyDown = React.useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
        if (!open && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
            e.preventDefault();
            setOpen(true);
            return;
        }

        // When popover is closed, let Enter/Shift+Enter navigate vertically
        if (!open && e.key === 'Enter' && onCellNav && dataCol !== undefined) {
            onCellNav(e, dataCol);
            return;
        }

        if (!open) return;

        switch (e.key) {
            case 'ArrowDown':
                e.preventDefault();
                setSelectedIndex(prev => Math.min(prev + 1, filtered.length - 1));
                break;
            case 'ArrowUp':
                e.preventDefault();
                setSelectedIndex(prev => Math.max(prev - 1, 0));
                break;
            case 'Enter':
                e.preventDefault();
                if (filtered.length > 0) {
                    onSelect(filtered[selectedIndex].value);
                    setOpen(false);
                    inputRef.current?.blur();
                }
                break;
            case 'Tab':
                // Select current suggestion and allow natural tab navigation
                if (filtered.length > 0) {
                    onSelect(filtered[selectedIndex].value);
                    setOpen(false);
                    // Don't prevent default - let tab work naturally
                }
                break;
            case 'Escape':
                e.preventDefault();
                setOpen(false);
                break;
        }
    }, [open, filtered, selectedIndex, onSelect, onCellNav, dataCol]);

    const handleOpenChange = React.useCallback((newOpen: boolean) => {
        // Only allow closing via our explicit controls, not Radix's auto-close
        if (newOpen) {
            setOpen(true);
        }
    }, []);

    const handleSelect = React.useCallback((itemValue: string) => {
        onSelect(itemValue);
        setOpen(false);
    }, [onSelect]);

    return (
        <Popover open={open && filtered.length > 0} onOpenChange={handleOpenChange} modal={false}>
            <PopoverTrigger asChild>
                <div className="w-full h-full relative">
                    <Input
                        ref={inputRef}
                        data-row={dataRow}
                        data-col={dataCol}
                        value={value}
                        onChange={(e) => {
                            onChange(e.target.value);
                            setOpen(true);
                        }}
                        onPaste={onPaste}
                        onKeyDown={handleKeyDown}
                        onFocus={() => {
                            if (filtered.length > 0) setOpen(true);
                        }}
                        onBlur={() => {
                            // Delay to allow click to register
                            setTimeout(() => setOpen(false), 150);
                        }}
                        className={className}
                        placeholder={placeholder}
                        style={style}
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
                onPointerDownOutside={(e) => {
                    // Prevent default closing behavior from Radix
                    if (e.target === inputRef.current) {
                        e.preventDefault();
                    }
                }}
                onInteractOutside={(e) => {
                    // Prevent closing when interacting with input
                    if (e.target === inputRef.current) {
                        e.preventDefault();
                    }
                }}
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