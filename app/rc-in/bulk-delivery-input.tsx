
'use client';

import * as React from 'react';
import { Check, ChevronsUpDown, Plus, Trash2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import {
    Command,
    CommandEmpty,
    CommandGroup,
    CommandInput,
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

export function BulkDeliveryInput({ batches }: { batches: Batch[] }) {
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
        const newRows = [...rows];
        newRows[index] = { ...newRows[index], [field]: value };
        setRows(newRows);
    };

    const handleSubmit = async () => {
        setIsSubmitting(true);

        const validRows: DeliveryRow[] = [];

        for (const row of rows) {
            const weight = parseFloat(String(row.weight_kg)) || 0;
            // Check essential fields: Batch Code and Weight must be present
            if (row.batch_code && weight > 0) {
                validRows.push({
                    state: row.state,
                    block_loc: row.block_loc, // Ensure this updates WHSE logic in actions if needed, but here it's just data
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
            alert('Please fill in at least one valid row (Batch and Weight required).');
            setIsSubmitting(false);
            return;
        }

        const res = await submitBulkDeliveries(validRows);
        if (res.success) {
            setRows([createEmptyRow()]);
            alert('Deliveries logged successfully!');
        } else {
            alert('Error: ' + res.message);
        }
        setIsSubmitting(false);
    };

    const inputClass = "h-9 w-full border-transparent bg-transparent rounded-none px-2 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary focus-visible:bg-accent/10 transition-colors shadow-none";
    const numberInputClass = "text-right"; // Right augment for numbers if desired

    return (
        <div className="space-y-4">
            <div className="flex items-center justify-between">
                <h2 className="text-lg font-semibold">Bulk Entry</h2>
                <div className="space-x-2">
                    <Button variant="outline" onClick={addRow}><Plus className="w-4 h-4 mr-2" /> Add Row</Button>
                    <Button onClick={handleSubmit} disabled={isSubmitting}>Submit All</Button>
                </div>
            </div>

            <div className="border rounded-md overflow-hidden overflow-x-auto">
                <Table className="w-max min-w-full table-fixed">
                    <TableHeader className="bg-muted/50">
                        <TableRow>
                            <TableHead className="w-[40px] sticky left-0 z-10 bg-muted/50"></TableHead>
                            <TableHead className="w-[80px] px-2">State</TableHead>
                            <TableHead className="w-[80px] bg-muted/30 px-2">WHSE</TableHead>
                            <TableHead className="w-[130px] px-2">Date</TableHead>
                            <TableHead className="w-[150px] px-2">Supplier</TableHead>
                            <TableHead className="w-[120px] px-2">Block</TableHead>
                            <TableHead className="w-[100px] px-2">Block Loc</TableHead>
                            <TableHead className="w-[120px] px-2">Truck</TableHead>
                            <TableHead className="w-[100px] px-2 text-right">WT</TableHead>
                            <TableHead className="w-[80px] px-2 text-right">SKS</TableHead>
                            <TableHead className="w-[70px] px-1 text-center">MC</TableHead>
                            <TableHead className="w-[70px] px-1 text-center">GRIT</TableHead>
                            <TableHead className="w-[80px] px-1 text-center">BD ASTM</TableHead>
                            <TableHead className="w-[80px] px-1 text-center">BD JIS</TableHead>
                            <TableHead className="w-[70px] px-1 text-center">VM</TableHead>
                            <TableHead className="w-[70px] px-1 text-center">ASH</TableHead>
                            <TableHead className="w-[70px] px-1 text-center">FC</TableHead>
                            <TableHead className="w-[150px] px-2">Remarks</TableHead>
                            <TableHead className="w-[100px] px-2 text-right">PHP/KG</TableHead>
                            <TableHead className="w-[120px] px-2 text-right bg-muted/30">PHP TTL</TableHead>
                        </TableRow>
                    </TableHeader>
                    <TableBody>
                        {rows.map((row, index) => {
                            // Calculate WHSE dynamically
                            const whse = calculateWhse(row.block_loc);
                            // Calculate TTL dynamically
                            const wt = parseFloat(String(row.weight_kg)) || 0;
                            const price = parseFloat(String(row.cost_basis)) || 0;
                            const ttl = (wt * price).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });

                            return (
                                <TableRow key={index} className="hover:bg-muted/5">
                                    <TableCell className="p-1 sticky left-0 bg-background z-10 border-r">
                                        <Button variant="ghost" size="icon" className="h-8 w-8 text-destructive" onClick={() => removeRow(index)}>
                                            <Trash2 className="w-4 h-4" />
                                        </Button>
                                    </TableCell>
                                    {/* 1. STATE */}
                                    <TableCell className="p-0 border-r">
                                        <div className="px-2 py-2 text-sm text-muted-foreground h-9 flex items-center justify-center bg-muted/10">
                                            {row.state}
                                        </div>
                                    </TableCell>
                                    {/* 2. WHSE */}
                                    <TableCell className="p-0 bg-muted/20 border-r text-center">
                                        <div className="px-2 py-2 text-sm text-muted-foreground font-medium h-9 flex items-center justify-center">
                                            {whse}
                                        </div>
                                    </TableCell>
                                    {/* 3. DATE */}
                                    <TableCell className="p-0 border-r">
                                        <Input
                                            type="date"
                                            value={row.transaction_date}
                                            onChange={(e) => updateRow(index, 'transaction_date', e.target.value)}
                                            className={inputClass}
                                        />
                                    </TableCell>
                                    {/* 4. SUPPLIER */}
                                    <TableCell className="p-0 border-r">
                                        <Input
                                            value={row.supplier}
                                            onChange={(e) => updateRow(index, 'supplier', e.target.value)}
                                            className={inputClass}
                                        />
                                    </TableCell>
                                    {/* 5. BLOCK (Batch) */}
                                    <TableCell className="p-0 border-r">
                                        <Combobox
                                            batches={batches}
                                            value={row.batch_code}
                                            onSelect={(val) => {
                                                const batch = batches.find(b => b.batch_code === val);
                                                updateRow(index, 'batch_code', val);
                                                if (batch && batch.location_ref) {
                                                    updateRow(index, 'block_loc', batch.location_ref);
                                                }
                                            }}
                                            className={inputClass}
                                        />
                                    </TableCell>
                                    {/* 6. BLOCK LOC */}
                                    <TableCell className="p-0 border-r">
                                        <Input
                                            value={row.block_loc}
                                            onChange={(e) => updateRow(index, 'block_loc', e.target.value)}
                                            className={inputClass}
                                        />
                                    </TableCell>
                                    {/* 7. TRUCK */}
                                    <TableCell className="p-0 border-r">
                                        <Input
                                            value={row.truck_plate}
                                            onChange={(e) => updateRow(index, 'truck_plate', e.target.value)}
                                            className={inputClass}
                                        />
                                    </TableCell>
                                    {/* 8. WT */}
                                    <TableCell className="p-0 border-r">
                                        <Input
                                            type="number" step="0.01"
                                            value={row.weight_kg}
                                            onChange={(e) => updateRow(index, 'weight_kg', e.target.value)}
                                            className={cn(inputClass, numberInputClass)}
                                        />
                                    </TableCell>
                                    {/* 9. SKS */}
                                    <TableCell className="p-0 border-r">
                                        <Input
                                            type="number"
                                            value={row.sacks}
                                            onChange={(e) => updateRow(index, 'sacks', e.target.value)}
                                            className={cn(inputClass, numberInputClass)}
                                        />
                                    </TableCell>
                                    {/* 10. MC */}
                                    <TableCell className="p-0 border-r">
                                        <Input
                                            type="number" step="0.01"
                                            value={row.mc}
                                            onChange={(e) => updateRow(index, 'mc', e.target.value)}
                                            className={cn(inputClass, "text-center px-1")}
                                        />
                                    </TableCell>
                                    {/* 11. GRIT */}
                                    <TableCell className="p-0 border-r">
                                        <Input
                                            type="number" step="0.01"
                                            value={row.grit}
                                            onChange={(e) => updateRow(index, 'grit', e.target.value)}
                                            className={cn(inputClass, "text-center px-1")}
                                        />
                                    </TableCell>
                                    {/* 12. BD ASTM */}
                                    <TableCell className="p-0 border-r">
                                        <Input
                                            type="number" step="0.01"
                                            value={row.bd_astm}
                                            onChange={(e) => updateRow(index, 'bd_astm', e.target.value)}
                                            className={cn(inputClass, "text-center px-1")}
                                        />
                                    </TableCell>
                                    {/* 13. BD JIS */}
                                    <TableCell className="p-0 border-r">
                                        <Input
                                            type="number" step="0.01"
                                            value={row.bd_jis}
                                            onChange={(e) => updateRow(index, 'bd_jis', e.target.value)}
                                            className={cn(inputClass, "text-center px-1")}
                                        />
                                    </TableCell>
                                    {/* 14. VM */}
                                    <TableCell className="p-0 border-r">
                                        <Input
                                            type="number" step="0.01"
                                            value={row.vm}
                                            onChange={(e) => updateRow(index, 'vm', e.target.value)}
                                            className={cn(inputClass, "text-center px-1")}
                                        />
                                    </TableCell>
                                    {/* 15. ASH */}
                                    <TableCell className="p-0 border-r">
                                        <Input
                                            type="number" step="0.01"
                                            value={row.ash}
                                            onChange={(e) => updateRow(index, 'ash', e.target.value)}
                                            className={cn(inputClass, "text-center px-1")}
                                        />
                                    </TableCell>
                                    {/* 16. FC */}
                                    <TableCell className="p-0 border-r">
                                        <Input
                                            type="number" step="0.01"
                                            value={row.fc}
                                            onChange={(e) => updateRow(index, 'fc', e.target.value)}
                                            className={cn(inputClass, "text-center px-1")}
                                        />
                                    </TableCell>
                                    {/* 17. REMARKS */}
                                    <TableCell className="p-0 border-r">
                                        <Input
                                            value={row.remarks}
                                            onChange={(e) => updateRow(index, 'remarks', e.target.value)}
                                            className={inputClass}
                                        />
                                    </TableCell>
                                    {/* 18. PHP/KG */}
                                    <TableCell className="p-0 border-r">
                                        <Input
                                            type="number" step="0.01"
                                            value={row.cost_basis}
                                            onChange={(e) => updateRow(index, 'cost_basis', e.target.value)}
                                            className={cn(inputClass, numberInputClass)}
                                        />
                                    </TableCell>
                                    {/* 19. PHP TTL */}
                                    <TableCell className="p-0 bg-muted/20 text-right">
                                        <div className="px-2 py-2 text-sm text-muted-foreground font-medium h-9 flex items-center justify-end">
                                            {ttl}
                                        </div>
                                    </TableCell>
                                </TableRow>
                            );
                        })}
                    </TableBody>
                </Table>
            </div>
        </div>
    );
}

function Combobox({ batches, value, onSelect, className }: { batches: Batch[], value: string, onSelect: (val: string) => void, className?: string }) {
    const [open, setOpen] = React.useState(false);

    return (
        <Popover open={open} onOpenChange={setOpen}>
            <PopoverTrigger asChild>
                <Button
                    variant="ghost"
                    role="combobox"
                    aria-expanded={open}
                    className={cn("justify-between font-normal hover:bg-transparent px-2 w-full", className)}
                >
                    <span className="truncate">
                        {value || <span className="opacity-50">...</span>}
                    </span>
                    <ChevronsUpDown className="ml-2 h-3 w-3 shrink-0 opacity-50" />
                </Button>
            </PopoverTrigger>
            <PopoverContent className="w-[200px] p-0">
                <Command>
                    <CommandInput placeholder="Search batch..." />
                    <CommandList>
                        <CommandEmpty>No batch found.</CommandEmpty>
                        <CommandGroup>
                            {batches.map((batch) => (
                                <CommandItem
                                    key={batch.id}
                                    value={batch.batch_code}
                                    onSelect={(currentValue) => {
                                        onSelect(currentValue);
                                        setOpen(false);
                                    }}
                                >
                                    <Check
                                        className={cn(
                                            "mr-2 h-4 w-4",
                                            value === batch.batch_code ? "opacity-100" : "opacity-0"
                                        )}
                                    />
                                    {batch.batch_code} ({batch.location_ref})
                                </CommandItem>
                            ))}
                        </CommandGroup>
                    </CommandList>
                </Command>
            </PopoverContent>
        </Popover>
    );
}
