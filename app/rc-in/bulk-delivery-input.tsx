
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

// Local type to allow "empty" strings for numbers during input
type InputDeliveryRow = {
    transaction_date: string;
    batch_code: string;
    block_loc: string;
    supplier: string;
    truck_plate: string;
    sacks: number | string;
    weight_kg: number | string;
    cost_basis: number | string;
    remarks: string;
    lab_results: {
        mc: number | string;
        ash: number | string;
        bd: number | string;
        jis: number | string;
        grit: number | string;
        vm: number | string;
        fc: number | string;
    };
};

// Helper for default new row
const createEmptyRow = (): InputDeliveryRow => ({
    transaction_date: new Date().toISOString().split('T')[0],
    batch_code: '',
    block_loc: '',
    supplier: '',
    truck_plate: '',
    sacks: '',
    weight_kg: '',
    cost_basis: '',
    remarks: '',
    lab_results: {
        mc: '',
        ash: '',
        bd: '',
        jis: '',
        grit: '',
        vm: '',
        fc: '',
    },
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

    const updateLabResult = (index: number, field: string, value: string | number) => {
        const newRows = [...rows];
        newRows[index] = {
            ...newRows[index],
            lab_results: {
                ...newRows[index].lab_results,
                [field]: value,
            },
        };
        setRows(newRows);
    };

    const handleSubmit = async () => {
        setIsSubmitting(true);

        // Validate and Convert
        const validRows: DeliveryRow[] = [];

        for (const row of rows) {
            // Skip completely empty rows (checking batch and weight)
            // If weight is string empty, parseFloat returns NaN -> falsy check works? No, NaN is false.
            const weight = parseFloat(String(row.weight_kg)) || 0;

            if (row.batch_code && weight > 0) {
                validRows.push({
                    ...row,
                    sacks: parseInt(String(row.sacks)) || 0,
                    weight_kg: weight,
                    cost_basis: parseFloat(String(row.cost_basis)) || 0,
                    lab_results: {
                        mc: parseFloat(String(row.lab_results.mc)) || 0,
                        ash: parseFloat(String(row.lab_results.ash)) || 0,
                        bd: parseFloat(String(row.lab_results.bd)) || 0,
                        jis: parseFloat(String(row.lab_results.jis)) || 0,
                        grit: parseFloat(String(row.lab_results.grit)) || 0,
                        vm: parseFloat(String(row.lab_results.vm)) || 0,
                        fc: parseFloat(String(row.lab_results.fc)) || 0,
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
            setRows([createEmptyRow()]); // Reset to 1 empty row
            alert('Deliveries logged successfully!');
        } else {
            alert('Error: ' + res.message);
        }
        setIsSubmitting(false);
    };

    // Base input styling for clarity
    const inputClass = "h-9 w-full border-transparent bg-transparent rounded-none px-2 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary focus-visible:bg-accent/10 transition-colors";

    return (
        <div className="space-y-4">
            <div className="flex items-center justify-between">
                <h2 className="text-lg font-semibold">Bulk Entry</h2>
                <div className="space-x-2">
                    <Button variant="outline" onClick={addRow}><Plus className="w-4 h-4 mr-2" /> Add Row</Button>
                    <Button onClick={handleSubmit} disabled={isSubmitting}>Submit All</Button>
                </div>
            </div>

            <div className="border rounded-md overflow-hidden">
                <Table>
                    <TableHeader className="bg-muted/50">
                        <TableRow>
                            <TableHead className="w-[40px]"></TableHead>
                            <TableHead className="w-[130px] px-2">DATE</TableHead>
                            <TableHead className="w-[80px] bg-muted/30 px-2">WHSE</TableHead>
                            <TableHead className="w-[150px] px-2">SUPPLIER</TableHead>
                            <TableHead className="w-[180px] px-2">BLOCK</TableHead>
                            <TableHead className="w-[100px] px-2">BLOCK LOC</TableHead>
                            <TableHead className="w-[120px] px-2">TRUCK</TableHead>
                            <TableHead className="w-[80px] px-2">Sx</TableHead>
                            <TableHead className="w-[100px] px-2">WT (kg)</TableHead>
                            <TableHead className="w-[100px] px-2">Price</TableHead>
                            {/* Lab Results Group */}
                            <TableHead className="w-[60px] px-1 text-center">MC</TableHead>
                            <TableHead className="w-[60px] px-1 text-center">Ash</TableHead>
                            <TableHead className="w-[60px] px-1 text-center">BD</TableHead>
                            <TableHead className="w-[60px] px-1 text-center">JIS</TableHead>
                            <TableHead className="w-[60px] px-1 text-center">Grit</TableHead>
                            <TableHead className="w-[60px] px-1 text-center">VM</TableHead>
                            <TableHead className="w-[60px] px-1 text-center">FC</TableHead>
                            <TableHead className="px-2">Remarks</TableHead>
                        </TableRow>
                    </TableHeader>
                    <TableBody>
                        {rows.map((row, index) => (
                            <TableRow key={index} className="hover:bg-muted/5">
                                <TableCell className="p-1">
                                    <Button variant="ghost" size="icon" className="h-8 w-8 text-destructive" onClick={() => removeRow(index)}>
                                        <Trash2 className="w-4 h-4" />
                                    </Button>
                                </TableCell>
                                <TableCell className="p-0">
                                    <Input
                                        type="date"
                                        value={row.transaction_date}
                                        onChange={(e) => updateRow(index, 'transaction_date', e.target.value)}
                                        className={cn(inputClass, "shadow-none")}
                                    />
                                </TableCell>
                                {/* READ ONLY WHSE */}
                                <TableCell className="p-0 bg-muted/30 border-r border-l border-border/50">
                                    <div className="px-2 py-2 text-sm text-muted-foreground font-medium h-9 flex items-center">
                                        {calculateWhse(row.block_loc)}
                                    </div>
                                </TableCell>
                                <TableCell className="p-0">
                                    <Input
                                        value={row.supplier}
                                        onChange={(e) => updateRow(index, 'supplier', e.target.value)}
                                        className={inputClass}
                                        placeholder="Supplier"
                                    />
                                </TableCell>
                                <TableCell className="p-0">
                                    <Combobox
                                        batches={batches}
                                        value={row.batch_code}
                                        onSelect={(val) => {
                                            // Optionally auto-fill block_loc if found in batch list
                                            const batch = batches.find(b => b.batch_code === val);
                                            updateRow(index, 'batch_code', val);
                                            if (batch && batch.location_ref) {
                                                updateRow(index, 'block_loc', batch.location_ref);
                                            }
                                        }}
                                        className={inputClass}
                                    />
                                </TableCell>
                                <TableCell className="p-0">
                                    <Input
                                        value={row.block_loc}
                                        onChange={(e) => updateRow(index, 'block_loc', e.target.value)}
                                        className={inputClass}
                                        placeholder="Loc"
                                    />
                                </TableCell>

                                <TableCell className="p-0">
                                    <Input
                                        value={row.truck_plate}
                                        onChange={(e) => updateRow(index, 'truck_plate', e.target.value)}
                                        className={inputClass}
                                        placeholder="Plate"
                                    />
                                </TableCell>
                                <TableCell className="p-0">
                                    <Input
                                        type="number"
                                        value={row.sacks}
                                        onChange={(e) => updateRow(index, 'sacks', e.target.value)}
                                        className={inputClass}
                                    />
                                </TableCell>
                                <TableCell className="p-0">
                                    <Input
                                        type="number" step="0.01"
                                        value={row.weight_kg}
                                        onChange={(e) => updateRow(index, 'weight_kg', e.target.value)}
                                        className={inputClass}
                                    />
                                </TableCell>
                                <TableCell className="p-0">
                                    <Input
                                        type="number" step="0.01"
                                        value={row.cost_basis}
                                        onChange={(e) => updateRow(index, 'cost_basis', e.target.value)}
                                        className={inputClass}
                                    />
                                </TableCell>

                                {/* Lab Results */}
                                {['mc', 'ash', 'bd', 'jis', 'grit', 'vm', 'fc'].map((field) => (
                                    <TableCell key={field} className="p-0">
                                        <Input
                                            type="number" step="0.01"
                                            value={(row.lab_results as any)[field]}
                                            onChange={(e) => updateLabResult(index, field, e.target.value)}
                                            className={cn(inputClass, "text-center px-1")}
                                        />
                                    </TableCell>
                                ))}

                                <TableCell className="p-0">
                                    <Input
                                        value={row.remarks || ''}
                                        onChange={(e) => updateRow(index, 'remarks', e.target.value)}
                                        className={inputClass}
                                        placeholder="Remarks"
                                    />
                                </TableCell>
                            </TableRow>
                        ))}
                    </TableBody>
                </Table>
            </div>
        </div>
    );
}

// Combobox Subcomponent for Batch Code
function Combobox({ batches, value, onSelect, className }: { batches: Batch[], value: string, onSelect: (val: string) => void, className?: string }) {
    const [open, setOpen] = React.useState(false);

    return (
        <Popover open={open} onOpenChange={setOpen}>
            <PopoverTrigger asChild>
                <Button
                    variant="ghost"
                    role="combobox"
                    aria-expanded={open}
                    className={cn("justify-between font-normal hover:bg-transparent", className)}
                >
                    <span className="truncate">
                        {value || <span className="text-muted-foreground opacity-50">Select...</span>}
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
