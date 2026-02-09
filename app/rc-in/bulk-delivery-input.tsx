
'use client';

import * as React from 'react';
import { Check, ChevronsUpDown, Plus, Trash2, MessageSquareText } from 'lucide-react';
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
import {
    Tooltip,
    TooltipContent,
    TooltipProvider,
    TooltipTrigger,
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

    // Compact input style for high density
    const inputClass = "h-6 w-full text-xs px-1 border-transparent bg-transparent rounded-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-primary focus-visible:bg-accent/10 transition-colors shadow-none";
    const numberInputClass = "text-right"; // Right augment for numbers

    return (
        <TooltipProvider>
            <div className="space-y-4">
                <div className="flex items-center justify-between">
                    <h2 className="text-lg font-semibold">Bulk Entry</h2>
                    <div className="space-x-2">
                        <Button variant="outline" size="sm" onClick={addRow}><Plus className="w-4 h-4 mr-2" /> Add Row</Button>
                        <Button size="sm" onClick={handleSubmit} disabled={isSubmitting}>Submit All</Button>
                    </div>
                </div>

                <div className="border rounded-md overflow-hidden overflow-x-auto">
                    <Table className="w-full table-fixed text-xs">
                        <TableHeader className="bg-muted/50">
                            <TableRow className="h-8">
                                <TableHead className="w-[30px] p-0 sticky left-0 z-10 bg-muted/50"></TableHead>
                                <TableHead className="w-[60px] text-center px-1 font-mono font-bold">STATE</TableHead>
                                <TableHead className="w-[60px] text-center px-1 font-mono font-bold">WHSE</TableHead>
                                <TableHead className="w-[70px] text-center px-1 font-mono font-bold">DATE</TableHead>
                                <TableHead className="w-[60px] text-center px-1 font-mono font-bold">SUPPLIER</TableHead>
                                <TableHead className="w-[72px] text-center px-1 font-mono font-bold">BLOCK</TableHead>
                                <TableHead className="w-[40px] text-center px-1 font-mono font-bold">LOC</TableHead>
                                <TableHead className="w-[50px] text-center px-1 font-mono font-bold">TRUCK</TableHead>
                                <TableHead className="w-[50px] text-center px-1 font-mono font-bold">WT</TableHead>
                                <TableHead className="w-[30px] text-center px-1 font-mono font-bold">SKS</TableHead>
                                <TableHead className="w-[35px] text-center px-1 font-mono font-bold text-[11px]">MC</TableHead>
                                <TableHead className="w-[35px] text-center px-1 font-mono font-bold text-[11px]">GRIT</TableHead>
                                <TableHead className="w-[35px] text-center px-1 font-mono font-bold text-[11px]">ASTM</TableHead>
                                <TableHead className="w-[35px] text-center px-1 font-mono font-bold text-[11px]">JIS</TableHead>
                                <TableHead className="w-[35px] text-center px-1 font-mono font-bold text-[11px]">VM</TableHead>
                                <TableHead className="w-[35px] text-center px-1 font-mono font-bold text-[11px]">ASH</TableHead>
                                <TableHead className="w-[35px] text-center px-1 font-mono font-bold text-[11px]">FC</TableHead>
                                <TableHead className="w-[60px] text-center px-1 font-mono font-bold text-[11px]">REMARKS</TableHead>
                                <TableHead className="w-[50px] text-center px-1 font-mono font-bold text-[11px]">PHP/KG</TableHead>
                                <TableHead className="w-[85px] text-center px-1 font-mono font-bold text-[11px]">PHP TTL</TableHead>
                            </TableRow>
                        </TableHeader>
                        <TableBody>
                            {rows.map((row, index) => {
                                // Calculate WHSE dynamically
                                const whse = calculateWhse(row.block_loc);
                                // Calculate TTL dynamically
                                const wt = parseFloat(String(row.weight_kg)) || 0;
                                const price = parseFloat(String(row.cost_basis)) || 0;
                                const ttlValue = wt * price;

                                return (
                                    <TableRow key={index} className="hover:bg-muted/5 h-8">
                                        <TableCell className="p-0 sticky left-0 bg-background z-10 border-r h-8">
                                            <Button variant="ghost" size="icon" className="h-6 w-6 text-destructive" onClick={() => removeRow(index)}>
                                                <Trash2 className="w-3 h-3" />
                                            </Button>
                                        </TableCell>
                                        <TableCell className="p-0 border-r h-8">
                                            <div className="text-[10px] text-muted-foreground text-center font-mono uppercase bg-muted/10 py-1 rounded-sm h-full flex items-center justify-center">
                                                {row.state}
                                            </div>
                                        </TableCell>
                                        <TableCell className="p-0 border-r text-center h-8">
                                            <div className="whitespace-nowrap text-center text-[10px] font-mono font-bold h-full flex items-center justify-center">
                                                {whse}
                                            </div>
                                        </TableCell>
                                        <TableCell className="p-0 border-r h-8">
                                            <Input
                                                type="date"
                                                value={row.transaction_date}
                                                onChange={(e) => updateRow(index, 'transaction_date', e.target.value)}
                                                className="h-6 w-full text-[10px] px-1 border-transparent font-mono font-bold text-center bg-transparent focus-visible:ring-1 focus-visible:ring-inset shadow-none rounded-none"
                                            />
                                        </TableCell>
                                        <TableCell className="p-0 border-r h-8">
                                            <Input
                                                value={row.supplier}
                                                onChange={(e) => updateRow(index, 'supplier', e.target.value)}
                                                className="h-6 w-full text-[10px] px-1 border-transparent font-bold text-left bg-transparent focus-visible:ring-1 focus-visible:ring-inset shadow-none rounded-none"
                                            />
                                        </TableCell>
                                        <TableCell className="p-0 border-r h-8">
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
                                                className="h-6 text-[10px] font-bold font-mono"
                                            />
                                        </TableCell>
                                        <TableCell className="p-0 border-r h-8">
                                            <div className="text-center px-1 font-bold text-[10px] font-mono h-full flex items-center justify-center">
                                                {row.block_loc || '-'}
                                            </div>
                                        </TableCell>
                                        <TableCell className="p-0 border-r h-8">
                                            <Input
                                                value={row.truck_plate}
                                                onChange={(e) => updateRow(index, 'truck_plate', e.target.value)}
                                                className="h-6 w-full text-[10px] px-1 border-transparent font-mono text-center bg-transparent focus-visible:ring-1 focus-visible:ring-inset shadow-none rounded-none"
                                            />
                                        </TableCell>
                                        <TableCell className="p-0 border-r h-8">
                                            <Input
                                                type="number"
                                                step="1"
                                                value={row.weight_kg}
                                                onChange={(e) => updateRow(index, 'weight_kg', e.target.value)}
                                                className="h-6 w-full text-[10px] px-1 border-transparent font-mono font-bold text-center bg-transparent focus-visible:ring-1 focus-visible:ring-inset shadow-none rounded-none"
                                            />
                                        </TableCell>
                                        <TableCell className="p-0 border-r h-8">
                                            <Input
                                                type="number"
                                                value={row.sacks}
                                                onChange={(e) => updateRow(index, 'sacks', e.target.value)}
                                                className="h-6 w-full text-[10px] px-1 border-transparent font-mono text-center bg-transparent focus-visible:ring-1 focus-visible:ring-inset shadow-none rounded-none"
                                            />
                                        </TableCell>
                                        <TableCell className="p-0 border-r h-8">
                                            <Input
                                                type="number" step="0.01"
                                                value={row.mc}
                                                onChange={(e) => updateRow(index, 'mc', e.target.value)}
                                                className="h-6 w-full text-[10px] px-1 border-transparent text-center bg-transparent focus-visible:ring-1 focus-visible:ring-inset shadow-none rounded-none"
                                            />
                                        </TableCell>
                                        <TableCell className="p-0 border-r h-8">
                                            <Input
                                                type="number" step="0.01"
                                                value={row.grit}
                                                onChange={(e) => updateRow(index, 'grit', e.target.value)}
                                                className="h-6 w-full text-[10px] px-1 border-transparent text-center bg-transparent focus-visible:ring-1 focus-visible:ring-inset shadow-none rounded-none"
                                            />
                                        </TableCell>
                                        <TableCell className="p-0 border-r h-8">
                                            <Input
                                                type="number" step="0.001"
                                                value={row.bd_astm}
                                                onChange={(e) => updateRow(index, 'bd_astm', e.target.value)}
                                                className="h-6 w-full text-[10px] px-1 border-transparent text-center bg-transparent focus-visible:ring-1 focus-visible:ring-inset shadow-none rounded-none"
                                            />
                                        </TableCell>
                                        <TableCell className="p-0 border-r h-8">
                                            <Input
                                                type="number" step="0.001"
                                                value={row.bd_jis}
                                                onChange={(e) => updateRow(index, 'bd_jis', e.target.value)}
                                                className="h-6 w-full text-[10px] px-1 border-transparent text-center bg-transparent focus-visible:ring-1 focus-visible:ring-inset shadow-none rounded-none"
                                            />
                                        </TableCell>
                                        <TableCell className="p-0 border-r h-8">
                                            <Input
                                                type="number" step="0.01"
                                                value={row.vm}
                                                onChange={(e) => updateRow(index, 'vm', e.target.value)}
                                                className="h-6 w-full text-[10px] px-1 border-transparent text-center bg-transparent focus-visible:ring-1 focus-visible:ring-inset shadow-none rounded-none"
                                            />
                                        </TableCell>
                                        <TableCell className="p-0 border-r h-8">
                                            <Input
                                                type="number" step="0.01"
                                                value={row.ash}
                                                onChange={(e) => updateRow(index, 'ash', e.target.value)}
                                                className="h-6 w-full text-[10px] px-1 border-transparent text-center bg-transparent focus-visible:ring-1 focus-visible:ring-inset shadow-none rounded-none"
                                            />
                                        </TableCell>
                                        <TableCell className="p-0 border-r h-8">
                                            <Input
                                                type="number" step="0.01"
                                                value={row.fc}
                                                onChange={(e) => updateRow(index, 'fc', e.target.value)}
                                                className="h-6 w-full text-[10px] px-1 border-transparent text-center bg-transparent focus-visible:ring-1 focus-visible:ring-inset shadow-none rounded-none"
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

function Combobox({ batches, value, onSelect, className }: { batches: Batch[], value: string, onSelect: (val: string) => void, className?: string }) {
    const [open, setOpen] = React.useState(false);

    return (
        <Popover open={open} onOpenChange={setOpen}>
            <PopoverTrigger asChild>
                <Button
                    variant="ghost"
                    role="combobox"
                    aria-expanded={open}
                    className={cn("justify-between font-normal hover:bg-transparent px-1 w-full text-xs h-6", className)}
                >
                    <span className="truncate">
                        {value || <span className="opacity-50">...</span>}
                    </span>
                    <ChevronsUpDown className="ml-1 h-3 w-3 shrink-0 opacity-50" />
                </Button>
            </PopoverTrigger>
            <PopoverContent className="w-[200px] p-0">
                <Command>
                    <CommandInput placeholder="Search batch..." className="h-8 text-xs" />
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
                                    className="text-xs"
                                >
                                    <Check
                                        className={cn(
                                            "mr-2 h-3 w-3",
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
