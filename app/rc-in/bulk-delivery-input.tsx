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
import { submitBulkDeliveries, DeliveryRow } from './actions';
import { calculateWhse } from '@/lib/rc-utils';
import { useTableSettings } from './table-settings';

type Batch = {
    id: string;
    batch_code: string;
    location_ref: string;
};

type AutocompleteItem = {
    value: string;
    detail?: string;
};

type InputDeliveryRow = {
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

const inputClass = "h-8 w-full text-[10px] md:text-[10px] px-1 border-transparent bg-transparent rounded-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-primary focus-visible:bg-accent/10 transition-colors shadow-none";

export function BulkDeliveryInput({ batches, suppliers, onSuccess }: { batches: Batch[], suppliers: string[], onSuccess?: () => void }) {
    const { fontSize, rowHeight } = useTableSettings();
    const [rows, setRows] = React.useState<InputDeliveryRow[]>([createEmptyRow()]);
    const [isSubmitting, setIsSubmitting] = React.useState(false);

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

    const handleSubmit = async () => {
        setIsSubmitting(true);

        try {
            const validRows: DeliveryRow[] = [];

            for (const row of rows) {
                const weight = parseFloat(String(row.weight_kg)) || 0;
                if (row.batch_code && weight > 0) {
                    validRows.push({
                        state: row.state,
                        block_loc: row.block_loc,
                        transaction_date: row.transaction_date,
                        supplier: row.supplier,
                        batch_code: row.batch_code,
                        truck_plate: row.truck_plate,
                        sacks: parseInt(String(row.sacks)) || 0,
                        weight_kg: weight,
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
                }
            }

            if (validRows.length === 0) {
                toast.warning('Please fill in at least one valid row (Batch and Weight required).');
                setIsSubmitting(false);
                return;
            }

            const res = await submitBulkDeliveries(validRows);

            if (res.success) {
                setRows([createEmptyRow()]);
                toast.success(`${validRows.length} deliver${validRows.length === 1 ? 'y' : 'ies'} logged successfully`);
                onSuccess?.();
            } else {
                toast.error('Submission failed: ' + res.message);
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
                        Fill in the details below. Press &ldquo;Add Row&rdquo; for more entries.
                    </div>
                    <div className="space-x-2">
                        <Button variant="outline" size="sm" onClick={addRow}><Plus className="w-4 h-4 mr-2" /> Add Row</Button>
                        <Button size="sm" onClick={handleSubmit} disabled={isSubmitting}>Submit All</Button>
                    </div>
                </div>

                <div className="border rounded-md overflow-hidden overflow-x-auto relative max-h-[60vh]">
                    <table className="w-full table-fixed text-xs relative caption-bottom border-collapse">
                        <TableHeader className="bg-muted sticky top-0 z-50 shadow-sm border-b">
                            <TableRow className="hover:bg-transparent border-b" style={{ height: `${rowHeight}px` }}>
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

// Memoized row component — only re-renders when its own row data changes
const BulkInputRow = React.memo(function BulkInputRow({
    row,
    index,
    batches,
    batchItems,
    supplierItems,
    updateRow,
    updateRowFields,
    removeRow,
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
    fontSize: number;
    rowHeight: number;
}) {
    const whse = calculateWhse(row.block_loc, row.batch_code);
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
            <TableCell className="px-1 py-0 border-r" style={{ height: `${rowHeight}px` }}>
                <div className="text-muted-foreground text-center font-mono uppercase bg-muted/10 py-1.5 rounded-sm h-full flex items-center justify-center" style={inputStyle}>
                    {row.state}
                </div>
            </TableCell>
            <TableCell className="px-1 py-0 border-r text-center" style={{ height: `${rowHeight}px` }}>
                <div className="whitespace-nowrap text-center font-mono font-bold h-full flex items-center justify-center" style={inputStyle}>
                    {whse}
                </div>
            </TableCell>
            <TableCell className="px-1 py-0 border-r" style={{ height: `${rowHeight}px` }}>
                <div className="relative w-full h-full group">
                    <input
                        type="date"
                        value={row.transaction_date}
                        onChange={(e) => updateRow(index, 'transaction_date', e.target.value)}
                        className={cn(
                            "w-full h-full bg-transparent border-none font-mono font-bold text-center focus:outline-none px-0 uppercase appearance-none [&::-webkit-calendar-picker-indicator]:opacity-0 [&::-webkit-calendar-picker-indicator]:w-full [&::-webkit-calendar-picker-indicator]:h-full [&::-webkit-calendar-picker-indicator]:absolute [&::-webkit-calendar-picker-indicator]:top-0 [&::-webkit-calendar-picker-indicator]:left-0 [&::-webkit-calendar-picker-indicator]:cursor-pointer",
                            !row.transaction_date && "text-muted-foreground"
                        )}
                        style={inputStyle}
                    />
                </div>
            </TableCell>
            <TableCell className="px-1 py-0 border-r" style={{ height: `${rowHeight}px` }}>
                <AutocompleteInput
                    value={row.supplier}
                    onChange={(val) => updateRow(index, 'supplier', val)}
                    items={supplierItems}
                    onSelect={(val) => updateRow(index, 'supplier', val)}
                    className={cn(inputClass, "font-bold text-left")}
                    placeholder="Supplier..."
                    style={inputStyle}
                />
            </TableCell>
            <TableCell className="px-1 py-0 border-r relative" style={{ height: `${rowHeight}px` }}>
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
                />
            </TableCell>
            <TableCell className="px-1 py-0 border-r" style={{ height: `${rowHeight}px` }}>
                <Input
                    value={row.block_loc}
                    onChange={(e) => updateRow(index, 'block_loc', e.target.value)}
                    className={cn(inputClass, "font-bold text-center font-mono")}
                    style={inputStyle}
                />
            </TableCell>
            <TableCell className="px-1 py-0 border-r" style={{ height: `${rowHeight}px` }}>
                <Input
                    value={row.truck_plate}
                    onChange={(e) => updateRow(index, 'truck_plate', e.target.value)}
                    className={cn(inputClass, "text-center font-mono")}
                    style={inputStyle}
                />
            </TableCell>
            <TableCell className="px-1 py-0 border-r" style={{ height: `${rowHeight}px` }}>
                <Input
                    type="number" step="1"
                    value={row.weight_kg}
                    onChange={(e) => updateRow(index, 'weight_kg', e.target.value)}
                    className={cn(inputClass, "font-bold text-center font-mono")}
                    style={inputStyle}
                />
            </TableCell>
            <TableCell className="px-1 py-0 border-r" style={{ height: `${rowHeight}px` }}>
                <Input
                    type="number"
                    value={row.sacks}
                    onChange={(e) => updateRow(index, 'sacks', e.target.value)}
                    className={cn(inputClass, "text-center font-mono")}
                    style={inputStyle}
                />
            </TableCell>
            <TableCell className="px-1 py-0 border-r" style={{ height: `${rowHeight}px` }}>
                <Input type="number" step="0.01" value={row.mc} onChange={(e) => updateRow(index, 'mc', e.target.value)} className={cn(inputClass, "text-center font-mono")} style={inputStyle} />
            </TableCell>
            <TableCell className="px-1 py-0 border-r" style={{ height: `${rowHeight}px` }}>
                <Input type="number" step="0.01" value={row.grit} onChange={(e) => updateRow(index, 'grit', e.target.value)} className={cn(inputClass, "text-center font-mono")} style={inputStyle} />
            </TableCell>
            <TableCell className="px-1 py-0 border-r" style={{ height: `${rowHeight}px` }}>
                <Input type="number" step="0.001" value={row.bd_astm} onChange={(e) => updateRow(index, 'bd_astm', e.target.value)} className={cn(inputClass, "text-center font-mono")} style={inputStyle} />
            </TableCell>
            <TableCell className="px-1 py-0 border-r" style={{ height: `${rowHeight}px` }}>
                <Input type="number" step="0.001" value={row.bd_jis} onChange={(e) => updateRow(index, 'bd_jis', e.target.value)} className={cn(inputClass, "text-center font-mono")} style={inputStyle} />
            </TableCell>
            <TableCell className="px-1 py-0 border-r" style={{ height: `${rowHeight}px` }}>
                <Input type="number" step="0.01" value={row.vm} onChange={(e) => updateRow(index, 'vm', e.target.value)} className={cn(inputClass, "text-center font-mono")} style={inputStyle} />
            </TableCell>
            <TableCell className="px-1 py-0 border-r" style={{ height: `${rowHeight}px` }}>
                <Input type="number" step="0.01" value={row.ash} onChange={(e) => updateRow(index, 'ash', e.target.value)} className={cn(inputClass, "text-center font-mono")} style={inputStyle} />
            </TableCell>
            <TableCell className="px-1 py-0 border-r" style={{ height: `${rowHeight}px` }}>
                <Input type="number" step="0.01" value={row.fc} onChange={(e) => updateRow(index, 'fc', e.target.value)} className={cn(inputClass, "text-center font-mono")} style={inputStyle} />
            </TableCell>
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
                                className="h-8 text-sm"
                                placeholder="Enter remarks..."
                            />
                        </div>
                    </PopoverContent>
                </Popover>
            </TableCell>
            <TableCell className="px-1 py-0 border-r" style={{ height: `${rowHeight}px` }}>
                <div className="flex items-center justify-between h-full">
                    <span className="text-muted-foreground" style={inputStyle}>₱</span>
                    <input
                        type="number"
                        step="0.01"
                        value={row.cost_basis}
                        onChange={(e) => updateRow(index, 'cost_basis', e.target.value)}
                        className="w-full text-right bg-transparent border-none p-0 h-full font-mono font-bold focus:outline-none"
                        placeholder="0.00"
                        style={inputStyle}
                    />
                </div>
            </TableCell>
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

// Unified autocomplete — replaces both BlockInput and SupplierInput
function AutocompleteInput({ value, onChange, onSelect, items, className, placeholder, style }: {
    value: string;
    onChange: (val: string) => void;
    onSelect: (val: string) => void;
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
    }, [open, filtered, selectedIndex, onSelect]);

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
                        value={value}
                        onChange={(e) => {
                            onChange(e.target.value);
                            setOpen(true);
                        }}
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
