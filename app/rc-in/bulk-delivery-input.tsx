
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

type Batch = {
    id: string;
    batch_code: string;
    location_ref: string;
};

// Helper for default new row
const createEmptyRow = (): DeliveryRow => ({
    transaction_date: new Date().toISOString().split('T')[0],
    batch_code: '',
    supplier: '',
    truck_plate: '',
    sacks: 0,
    weight_kg: 0,
    cost_basis: 0,
    remarks: '',
    lab_results: {
        mc: 0,
        ash: 0,
        bd: 0,
        jis: 0,
        grit: 0,
        vm: 0,
        fc: 0,
    },
});

export function BulkDeliveryInput({ batches }: { batches: Batch[] }) {
    const [rows, setRows] = React.useState<DeliveryRow[]>([createEmptyRow()]);
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

    const updateRow = (index: number, field: keyof DeliveryRow, value: any) => {
        const newRows = [...rows];
        newRows[index] = { ...newRows[index], [field]: value };
        setRows(newRows);
    };

    const updateLabResult = (index: number, field: string, value: number) => {
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
        // Filter out rows with no batch code or 0 weight to avoid empty submissions?
        // Let's assume validation happens server side or strict client requirement.
        // For now, simple check:
        const validRows = rows.filter(r => r.batch_code && r.weight_kg > 0);

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

    return (
        <div className="space-y-4">
            <div className="flex items-center justify-between">
                <h2 className="text-lg font-semibold">Bulk Entry</h2>
                <div className="space-x-2">
                    <Button variant="outline" onClick={addRow}><Plus className="w-4 h-4 mr-2" /> Add Row</Button>
                    <Button onClick={handleSubmit} disabled={isSubmitting}>Submit All</Button>
                </div>
            </div>

            <div className="border rounded-md">
                <Table>
                    <TableHeader>
                        <TableRow>
                            <TableHead className="w-[40px]"></TableHead>
                            <TableHead className="w-[130px]">Date</TableHead>
                            <TableHead className="w-[200px]">Batch Code</TableHead>
                            <TableHead className="w-[150px]">Supplier</TableHead>
                            <TableHead className="w-[120px]">Truck</TableHead>
                            <TableHead className="w-[80px]">Sacks</TableHead>
                            <TableHead className="w-[100px]">Wt (kg)</TableHead>
                            <TableHead className="w-[100px]">Price</TableHead>
                            {/* Lab Results Group */}
                            <TableHead className="w-[60px]">MC</TableHead>
                            <TableHead className="w-[60px]">Ash</TableHead>
                            <TableHead className="w-[60px]">BD</TableHead>
                            <TableHead className="w-[60px]">JIS</TableHead>
                            <TableHead className="w-[60px]">Grit</TableHead>
                            <TableHead className="w-[60px]">VM</TableHead>
                            <TableHead className="w-[60px]">FC</TableHead>
                            <TableHead>Remarks</TableHead>
                        </TableRow>
                    </TableHeader>
                    <TableBody>
                        {rows.map((row, index) => (
                            <TableRow key={index}>
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
                                        className="border-none shadow-none focus-visible:ring-1 h-9 rounded-none"
                                    />
                                </TableCell>
                                <TableCell className="p-0">
                                    <Combobox
                                        batches={batches}
                                        value={row.batch_code}
                                        onSelect={(val) => updateRow(index, 'batch_code', val)}
                                    />
                                </TableCell>
                                <TableCell className="p-0">
                                    <Input
                                        value={row.supplier}
                                        onChange={(e) => updateRow(index, 'supplier', e.target.value)}
                                        className="border-none shadow-none focus-visible:ring-1 h-9 rounded-none"
                                        placeholder="Supplier"
                                    />
                                </TableCell>
                                <TableCell className="p-0">
                                    <Input
                                        value={row.truck_plate}
                                        onChange={(e) => updateRow(index, 'truck_plate', e.target.value)}
                                        className="border-none shadow-none focus-visible:ring-1 h-9 rounded-none"
                                        placeholder="Plate"
                                    />
                                </TableCell>
                                <TableCell className="p-0">
                                    <Input
                                        type="number"
                                        value={row.sacks}
                                        onChange={(e) => updateRow(index, 'sacks', parseInt(e.target.value) || 0)}
                                        className="border-none shadow-none focus-visible:ring-1 h-9 rounded-none"
                                    />
                                </TableCell>
                                <TableCell className="p-0">
                                    <Input
                                        type="number" step="0.01"
                                        value={row.weight_kg}
                                        onChange={(e) => updateRow(index, 'weight_kg', parseFloat(e.target.value) || 0)}
                                        className="border-none shadow-none focus-visible:ring-1 h-9 rounded-none"
                                    />
                                </TableCell>
                                <TableCell className="p-0">
                                    <Input
                                        type="number" step="0.01"
                                        value={row.cost_basis}
                                        onChange={(e) => updateRow(index, 'cost_basis', parseFloat(e.target.value) || 0)}
                                        className="border-none shadow-none focus-visible:ring-1 h-9 rounded-none"
                                    />
                                </TableCell>

                                {/* Lab Results */}
                                {['mc', 'ash', 'bd', 'jis', 'grit', 'vm', 'fc'].map((field) => (
                                    <TableCell key={field} className="p-0">
                                        <Input
                                            type="number" step="0.01"
                                            value={(row.lab_results as any)[field]}
                                            onChange={(e) => updateLabResult(index, field, parseFloat(e.target.value) || 0)}
                                            className="border-none shadow-none focus-visible:ring-1 h-9 rounded-none text-center px-1"
                                        />
                                    </TableCell>
                                ))}

                                <TableCell className="p-0">
                                    <Input
                                        value={row.remarks || ''}
                                        onChange={(e) => updateRow(index, 'remarks', e.target.value)}
                                        className="border-none shadow-none focus-visible:ring-1 h-9 rounded-none"
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
function Combobox({ batches, value, onSelect }: { batches: Batch[], value: string, onSelect: (val: string) => void }) {
    const [open, setOpen] = React.useState(false);

    return (
        <Popover open={open} onOpenChange={setOpen}>
            <PopoverTrigger asChild>
                <Button
                    variant="ghost"
                    role="combobox"
                    aria-expanded={open}
                    className="w-full justify-between rounded-none font-normal shadow-none hover:bg-transparent h-9 px-2"
                >
                    {value || <span className="text-muted-foreground">Select...</span>}
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
                                    {batch.batch_code}
                                </CommandItem>
                            ))}
                        </CommandGroup>
                    </CommandList>
                </Command>
            </PopoverContent>
        </Popover>
    );
}
