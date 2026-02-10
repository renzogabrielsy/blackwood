'use client';

import * as React from 'react';
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
    Table,
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

type Batch = {
    id: string;
    batch_code: string;
    location_ref: string;
};

// Flat Input Structure for CSV Compatibility
type InputDeliveryRow = {
    state: string; // Read-only, default 'STORED'
    whse: string; // Read-only, auto-calc
    transaction_date: string;
    supplier: string;
    batch_code: string; // Block
    block_loc: string; // Block Loc
    truck_plate: string;
    weight_kg: number | string; // WT
    sacks: number | string; // SKS
    mc: number | string;
    grit: number | string;
    bd_astm: number | string;
    bd_jis: number | string;
    vm: number | string;
    ash: number | string;
    fc: number | string;
    remarks: string;
    cost_basis: number | string; // PHP/KG
    // PHP TTL is calculated on the fly: weight_kg * cost_basis
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

export function BulkDeliveryInput({ batches, suppliers, onSuccess }: { batches: Batch[], suppliers: string[], onSuccess?: () => void }) {
    const [rows, setRows] = React.useState<InputDeliveryRow[]>([createEmptyRow()]);
    const [isSubmitting, setIsSubmitting] = React.useState(false);

    const addRow = () => {
        setRows([...rows, createEmptyRow()]);
    };

    const removeRow = (index: number) => {
        if (rows.length > 1) {
            const newRows = [...rows];
            newRows.splice(index, 1);
            setRows(newRows);
        }
    };

    const updateRow = (index: number, field: keyof InputDeliveryRow, value: any) => {
        setRows(prev => {
            const newRows = [...prev];
            newRows[index] = { ...newRows[index], [field]: value };
            return newRows;
        });
    };

    const updateRowFields = (index: number, updates: Partial<InputDeliveryRow>) => {
        setRows(prev => {
            const newRows = [...prev];
            newRows[index] = { ...newRows[index], ...updates };
            return newRows;
        });
    };

    const handleSubmit = async () => {
        console.log("🖱️ Submit Clicked");
        setIsSubmitting(true);

        try {
            console.log("📝 Form Data (Raw): ", rows);
            const validRows: DeliveryRow[] = [];

            for (const row of rows) {
                const weight = parseFloat(String(row.weight_kg)) || 0;
                // Check essential fields: Batch Code and Weight must be present
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
                } else {
                    console.warn("⚠️ Skipping invalid row:", row);
                }
            }

            console.log("✅ Validation Passed. Valid Rows:", validRows);

            if (validRows.length === 0) {
                console.warn("⚠️ No valid rows to submit");
                alert('Please fill in at least one valid row (Batch and Weight required).');
                setIsSubmitting(false);
                return;
            }

            console.log("🚀 Sending to Supabase...");
            const res = await submitBulkDeliveries(validRows);
            console.log("📡 Response:", res);

            if (res.success) {
                setRows([createEmptyRow()]);
                alert('Deliveries logged successfully!');
                onSuccess?.();
            } else {
                console.error("❌ Submission Error:", res.message);
                alert('Error: ' + res.message);
            }
        } catch (error) {
            console.error("❌ Unexpected Error caught:", error);
            alert('An unexpected error occurred. Check console for details.');
        } finally {
            setIsSubmitting(false);
        }
    };

    // Compact input style - Removed global font-mono to allow specific columns to be sans
    const inputClass = "h-8 w-full text-[10px] px-1 border-transparent bg-transparent rounded-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-primary focus-visible:bg-accent/10 transition-colors shadow-none";

    return (
        <TooltipProvider>
            <div className="space-y-4">
                <div className="flex items-center justify-between">
                    <div className="text-sm text-muted-foreground">
                        Fill in the details below. Press "Add Row" for more entries.
                    </div>
                    <div className="space-x-2">
                        <Button variant="outline" size="sm" onClick={addRow}><Plus className="w-4 h-4 mr-2" /> Add Row</Button>
                        <Button size="sm" onClick={handleSubmit} disabled={isSubmitting}>Submit All</Button>
                    </div>
                </div>

                <div className="border rounded-md overflow-hidden overflow-x-auto relative max-h-[60vh]">
                    <Table className="w-full table-fixed text-xs relative">
                        <TableHeader className="bg-muted/50 sticky top-0 z-20">
                            <TableRow className="h-8 shadow-sm">
                                <TableHead className="w-[30px] p-0 sticky left-0 z-30 bg-muted/50 border-r"></TableHead>
                                <TableHead className="w-[40px] text-center px-1 font-mono font-bold border-r">STATE</TableHead>
                                <TableHead className="w-[40px] text-center px-1 font-mono font-bold border-r">WHSE</TableHead>
                                <TableHead className="w-[70px] text-center px-1 font-mono font-bold border-r">DATE</TableHead>
                                <TableHead className="w-[120px] text-center px-1 font-bold border-r">SUPPLIER</TableHead>
                                <TableHead className="w-[80px] text-center px-1 font-mono font-bold border-r">BLOCK</TableHead>
                                <TableHead className="w-[40px] text-center px-1 font-mono font-bold border-r">LOC</TableHead>
                                <TableHead className="w-[50px] text-center px-1 font-mono font-bold border-r">TRUCK</TableHead>
                                <TableHead className="w-[50px] text-center px-1 font-mono font-bold border-r">WT</TableHead>
                                <TableHead className="w-[30px] text-center px-1 font-mono font-bold border-r">SKS</TableHead>
                                <TableHead className="w-[35px] text-center px-1 font-mono font-bold text-[11px] border-r">MC</TableHead>
                                <TableHead className="w-[35px] text-center px-1 font-mono font-bold text-[11px] border-r">GRIT</TableHead>
                                <TableHead className="w-[35px] text-center px-1 font-mono font-bold text-[11px] border-r">ASTM</TableHead>
                                <TableHead className="w-[35px] text-center px-1 font-mono font-bold text-[11px] border-r">JIS</TableHead>
                                <TableHead className="w-[35px] text-center px-1 font-mono font-bold text-[11px] border-r">VM</TableHead>
                                <TableHead className="w-[35px] text-center px-1 font-mono font-bold text-[11px] border-r">ASH</TableHead>
                                <TableHead className="w-[35px] text-center px-1 font-mono font-bold text-[11px] border-r">FC</TableHead>
                                <TableHead className="w-[60px] text-center px-1 font-mono font-bold text-[11px] border-r">REMARKS</TableHead>
                                <TableHead className="w-[50px] text-center px-1 font-mono font-bold text-[11px] border-r">PHP/KG</TableHead>
                                <TableHead className="w-[85px] text-center px-1 font-mono font-bold text-[11px]">PHP TTL</TableHead>
                            </TableRow>
                        </TableHeader>
                        <TableBody>
                            {rows.map((row, index) => {
                                // Calculate WHSE dynamically
                                const whse = calculateWhse(row.block_loc, row.batch_code);
                                // Calculate TTL dynamically
                                const wt = parseFloat(String(row.weight_kg)) || 0;
                                const price = parseFloat(String(row.cost_basis)) || 0;
                                const ttlValue = wt * price;

                                return (
                                    <TableRow key={index} className="hover:bg-muted/5 h-8">
                                        <TableCell className="p-0 sticky left-0 bg-background z-10 border-r h-8">
                                            <Button variant="ghost" size="icon" className="h-full w-full rounded-none text-destructive hover:text-white hover:bg-destructive/90" onClick={() => removeRow(index)}>
                                                <Trash2 className="w-3 h-3" />
                                            </Button>
                                        </TableCell>
                                        <TableCell className="p-0 border-r h-8">
                                            <div className="text-[10px] text-muted-foreground text-center font-mono uppercase bg-muted/10 py-1 h-full flex items-center justify-center">
                                                {row.state}
                                            </div>
                                        </TableCell>
                                        <TableCell className="p-0 border-r text-center h-8">
                                            <div className="whitespace-nowrap text-center text-[10px] font-mono font-bold h-full flex items-center justify-center">
                                                {whse}
                                            </div>
                                        </TableCell>
                                        <TableCell className="p-0 border-r h-8">
                                            {/* Date Input - Styled to mimic text */}
                                            <div className="relative w-full h-full group">
                                                <input
                                                    type="date"
                                                    value={row.transaction_date}
                                                    onChange={(e) => updateRow(index, 'transaction_date', e.target.value)}
                                                    className={cn(
                                                        "w-full h-full bg-transparent border-none text-[10px] font-mono font-bold text-center focus:outline-none px-0 uppercase appearance-none [&::-webkit-calendar-picker-indicator]:opacity-0 [&::-webkit-calendar-picker-indicator]:w-full [&::-webkit-calendar-picker-indicator]:h-full [&::-webkit-calendar-picker-indicator]:absolute [&::-webkit-calendar-picker-indicator]:top-0 [&::-webkit-calendar-picker-indicator]:left-0 [&::-webkit-calendar-picker-indicator]:cursor-pointer",
                                                        !row.transaction_date && "text-muted-foreground"
                                                    )}
                                                />
                                            </div>
                                        </TableCell>
                                        <TableCell className="p-0 border-r h-8">
                                            <SupplierInput
                                                value={row.supplier}
                                                onChange={(val) => updateRow(index, 'supplier', val)}
                                                suppliers={suppliers}
                                                className={cn(inputClass, "font-bold text-left")}
                                            />
                                        </TableCell>
                                        <TableCell className="p-0 border-r h-8 relative">
                                            <BlockInput
                                                value={row.batch_code}
                                                onChange={(val) => updateRow(index, 'batch_code', val)} // Only typing updates batch_code
                                                onSelectBatch={(batch) => { // Selection updates batch_code AND LOC atomically
                                                    updateRowFields(index, {
                                                        batch_code: batch.batch_code,
                                                        ...(batch.location_ref ? { block_loc: batch.location_ref } : {})
                                                    });
                                                }}
                                                batches={batches}
                                                className={cn(inputClass, "font-bold text-center font-mono")}
                                            />
                                        </TableCell>
                                        <TableCell className="p-0 border-r h-8">
                                            <Input
                                                value={row.block_loc}
                                                onChange={(e) => updateRow(index, 'block_loc', e.target.value)}
                                                className={cn(inputClass, "font-bold text-center font-mono")}
                                            />
                                        </TableCell>
                                        <TableCell className="p-0 border-r h-8">
                                            <Input
                                                value={row.truck_plate}
                                                onChange={(e) => updateRow(index, 'truck_plate', e.target.value)}
                                                className={cn(inputClass, "text-center font-mono")}
                                            />
                                        </TableCell>
                                        <TableCell className="p-0 border-r h-8">
                                            <Input
                                                type="number"
                                                step="1"
                                                value={row.weight_kg}
                                                onChange={(e) => updateRow(index, 'weight_kg', e.target.value)}
                                                className={cn(inputClass, "font-bold text-center font-mono")}
                                            />
                                        </TableCell>
                                        <TableCell className="p-0 border-r h-8">
                                            <Input
                                                type="number"
                                                value={row.sacks}
                                                onChange={(e) => updateRow(index, 'sacks', e.target.value)}
                                                className={cn(inputClass, "text-center font-mono")}
                                            />
                                        </TableCell>
                                        <TableCell className="p-0 border-r h-8">
                                            <Input
                                                type="number" step="0.01"
                                                value={row.mc}
                                                onChange={(e) => updateRow(index, 'mc', e.target.value)}
                                                className={cn(inputClass, "text-center font-mono")}
                                            />
                                        </TableCell>
                                        <TableCell className="p-0 border-r h-8">
                                            <Input
                                                type="number" step="0.01"
                                                value={row.grit}
                                                onChange={(e) => updateRow(index, 'grit', e.target.value)}
                                                className={cn(inputClass, "text-center font-mono")}
                                            />
                                        </TableCell>
                                        <TableCell className="p-0 border-r h-8">
                                            <Input
                                                type="number" step="0.001"
                                                value={row.bd_astm}
                                                onChange={(e) => updateRow(index, 'bd_astm', e.target.value)}
                                                className={cn(inputClass, "text-center font-mono")}
                                            />
                                        </TableCell>
                                        <TableCell className="p-0 border-r h-8">
                                            <Input
                                                type="number" step="0.001"
                                                value={row.bd_jis}
                                                onChange={(e) => updateRow(index, 'bd_jis', e.target.value)}
                                                className={cn(inputClass, "text-center font-mono")}
                                            />
                                        </TableCell>
                                        <TableCell className="p-0 border-r h-8">
                                            <Input
                                                type="number" step="0.01"
                                                value={row.vm}
                                                onChange={(e) => updateRow(index, 'vm', e.target.value)}
                                                className={cn(inputClass, "text-center font-mono")}
                                            />
                                        </TableCell>
                                        <TableCell className="p-0 border-r h-8">
                                            <Input
                                                type="number" step="0.01"
                                                value={row.ash}
                                                onChange={(e) => updateRow(index, 'ash', e.target.value)}
                                                className={cn(inputClass, "text-center font-mono")}
                                            />
                                        </TableCell>
                                        <TableCell className="p-0 border-r h-8">
                                            <Input
                                                type="number" step="0.01"
                                                value={row.fc}
                                                onChange={(e) => updateRow(index, 'fc', e.target.value)}
                                                className={cn(inputClass, "text-center font-mono")}
                                            />
                                        </TableCell>
                                        <TableCell className="p-0 border-r h-8 text-center">
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
                                        <TableCell className="p-0 border-r h-8">
                                            <div className="flex items-center justify-between h-full px-1">
                                                <span className="text-[10px] text-muted-foreground">₱</span>
                                                <input
                                                    type="number"
                                                    step="0.01"
                                                    value={row.cost_basis}
                                                    onChange={(e) => updateRow(index, 'cost_basis', e.target.value)}
                                                    className="w-full text-right bg-transparent border-none p-0 h-full text-[10px] font-mono font-bold focus:outline-none"
                                                    placeholder="0.00"
                                                />
                                            </div>
                                        </TableCell>
                                        <TableCell className="p-0 text-right h-8">
                                            <div className="flex items-center justify-between h-full px-1">
                                                <span className="text-[10px] text-muted-foreground">₱</span>
                                                <span className="text-right text-[10px] font-mono font-bold">
                                                    {ttlValue.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                                                </span>
                                            </div>
                                        </TableCell>
                                    </TableRow>
                                );
                            })}
                        </TableBody>
                    </Table>
                </div>
            </div>
        </TooltipProvider>
    );
}

function BlockInput({ value, onChange, onSelectBatch, batches, className }: { value: string, onChange: (val: string) => void, onSelectBatch: (batch: Batch) => void, batches: Batch[], className?: string }) {
    const [open, setOpen] = React.useState(false);
    const inputRef = React.useRef<HTMLInputElement>(null);

    return (
        <Popover open={open} onOpenChange={setOpen} modal={true}>
            <PopoverTrigger asChild>
                <div className="w-full h-full relative">
                    <Input
                        ref={inputRef}
                        value={value}
                        onChange={(e) => {
                            onChange(e.target.value);
                            setOpen(true);
                        }}
                        // Ensure it stays open when clicking back in
                        onClick={(e) => {
                            e.stopPropagation();
                            if (!open) setOpen(true);
                        }}
                        onFocus={() => setOpen(true)}
                        className={className}
                        placeholder="..."
                    />
                </div>
            </PopoverTrigger>
            <PopoverContent
                className="w-[200px] p-0"
                onOpenAutoFocus={(e) => e.preventDefault()}
            >
                <Command shouldFilter={false}>
                    <CommandList>
                        <CommandGroup heading="Suggestions">
                            {batches
                                .filter(b => b.batch_code.toLowerCase().includes(value.toLowerCase()))
                                .slice(0, 5)
                                .map((batch) => (
                                    <CommandItem
                                        key={batch.id}
                                        value={batch.batch_code}
                                        onSelect={(currentValue) => {
                                            // Pass the exact batch object back for auto-fill logic
                                            const exactBatch = batches.find(b => b.batch_code.toLowerCase() === currentValue.toLowerCase());
                                            if (exactBatch) {
                                                onSelectBatch(exactBatch);
                                            } else {
                                                onChange(currentValue);
                                            }
                                            setOpen(false);
                                        }}
                                        className="text-xs font-mono"
                                    >
                                        <Check
                                            className={cn(
                                                "mr-2 h-3 w-3",
                                                value === batch.batch_code ? "opacity-100" : "opacity-0"
                                            )}
                                        />
                                        {batch.batch_code}
                                        <span className="ml-auto text-muted-foreground text-[10px]">{batch.location_ref}</span>
                                    </CommandItem>
                                ))}
                            {batches.filter(b => b.batch_code.toLowerCase().includes(value.toLowerCase())).length === 0 && (
                                <div className="py-2 text-center text-xs text-muted-foreground">No matching blocks</div>
                            )}
                        </CommandGroup>
                    </CommandList>
                </Command>
            </PopoverContent>
        </Popover>
    );
}

function SupplierInput({ value, onChange, suppliers, className }: { value: string, onChange: (val: string) => void, suppliers: string[], className?: string }) {
    const [open, setOpen] = React.useState(false);
    const inputRef = React.useRef<HTMLInputElement>(null);

    return (
        <Popover open={open} onOpenChange={setOpen} modal={true}>
            <PopoverTrigger asChild>
                <div className="w-full h-full relative">
                    <Input
                        ref={inputRef}
                        value={value}
                        onChange={(e) => {
                            onChange(e.target.value);
                            setOpen(true);
                        }}
                        // Ensure it stays open when clicking back in
                        onClick={(e) => {
                            e.stopPropagation();
                            if (!open) setOpen(true);
                        }}
                        onFocus={() => setOpen(true)}
                        className={className}
                        placeholder="Supplier..."
                    />
                </div>
            </PopoverTrigger>
            <PopoverContent
                className="w-[200px] p-0"
                onOpenAutoFocus={(e) => e.preventDefault()}
            >
                <Command shouldFilter={false}>
                    <CommandList>
                        <CommandGroup heading="Suggestions">
                            {suppliers
                                .filter(s => s.toLowerCase().includes(value.toLowerCase()))
                                .slice(0, 5)
                                .map((supplier) => (
                                    <CommandItem
                                        key={supplier}
                                        value={supplier}
                                        onSelect={(currentValue) => {
                                            onChange(supplier);
                                            setOpen(false);
                                        }}
                                        className="text-xs"
                                    >
                                        <Check
                                            className={cn(
                                                "mr-2 h-3 w-3",
                                                value === supplier ? "opacity-100" : "opacity-0"
                                            )}
                                        />
                                        {supplier}
                                    </CommandItem>
                                ))}
                            {suppliers.filter(s => s.toLowerCase().includes(value.toLowerCase())).length === 0 && (
                                <div className="py-2 text-center text-xs text-muted-foreground">No matching suppliers</div>
                            )}
                        </CommandGroup>
                    </CommandList>
                </Command>
            </PopoverContent>
        </Popover>
    );
}
