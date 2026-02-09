
'use client';

import * as React from 'react';
import { format } from 'date-fns';
import {
    ColumnDef,
    ColumnFiltersState,
    SortingState,
    VisibilityState,
    flexRender,
    getCoreRowModel,
    getFilteredRowModel,
    // getPaginationRowModel,
    getSortedRowModel,
    useReactTable,
} from '@tanstack/react-table';
import { ArrowUpDown, ChevronDown, Search, MoreHorizontal, Pencil, Trash2, MessageSquareText } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
    TableFooter,
} from '@/components/ui/table';
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuLabel,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
    DialogTrigger,
} from '@/components/ui/dialog';
import {
    Popover,
    PopoverContent,
    PopoverTrigger,
} from '@/components/ui/popover';
import {
    Tooltip,
    TooltipContent,
    TooltipProvider,
    TooltipTrigger,
} from '@/components/ui/tooltip';
import { Label } from '@/components/ui/label';
import { DeliveryRow, deleteDelivery, updateDelivery } from './actions';
import { calculateWhse } from '@/lib/rc-utils';

export type DeliveryHistoryRow = DeliveryRow & {
    id: string;
    created_at: string;
    batches?: {
        location_ref: string;
    };
};

export function DeliveryMasterTable({ data }: { data: DeliveryHistoryRow[] }) {
    const [sorting, setSorting] = React.useState<SortingState>([]);
    const [columnFilters, setColumnFilters] = React.useState<ColumnFiltersState>([]);
    const [globalFilter, setGlobalFilter] = React.useState('');
    const [editingRow, setEditingRow] = React.useState<DeliveryHistoryRow | null>(null);
    const [isEditOpen, setIsEditOpen] = React.useState(false);

    // Define actions here to access state
    const handleDelete = async (id: string) => {
        if (confirm('Are you sure you want to delete this delivery?')) {
            const res = await deleteDelivery(id);
            if (!res.success) alert(res.message);
        }
    };

    const handleEditSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!editingRow) return;

        const res = await updateDelivery(editingRow.id, {
            transaction_date: editingRow.transaction_date,
            supplier: editingRow.supplier,
            truck_plate: editingRow.truck_plate,
            sacks: editingRow.sacks,
            weight_kg: editingRow.weight_kg,
            cost_basis: editingRow.cost_basis,
            remarks: editingRow.remarks,
            batch_code: editingRow.batch_code,
            block_loc: editingRow.block_loc,
            lab_results: editingRow.lab_results,
        });

        if (res.success) {
            setIsEditOpen(false);
            setEditingRow(null);
        } else {
            alert('Update failed: ' + res.message);
        }
    };

    const columns: ColumnDef<DeliveryHistoryRow>[] = [
        {
            id: 'state',
            header: () => <div className="text-center px-1 font-mono font-bold">STATE</div>,
            size: 40,
            cell: ({ row }) => <div className="text-[10px] text-muted-foreground text-center font-mono uppercase bg-muted/10 py-1 rounded-sm">{row.original.state || 'STORED'}</div>,
        },
        {
            id: 'whse',
            header: () => <div className="text-center px-1 font-mono font-bold">WHSE</div>,
            size: 40,
            cell: ({ row }) => {
                const loc = row.original.block_loc || row.original.batches?.location_ref;
                const batch = row.original.batch_code;
                return <div className="whitespace-nowrap text-center text-[10px] font-mono font-bold">{calculateWhse(loc, batch)}</div>;
            }
        },
        {
            accessorKey: 'transaction_date',
            header: ({ column }) => {
                return (
                    <Button
                        variant="ghost"
                        onClick={() => column.toggleSorting(column.getIsSorted() === 'asc')}
                        className="h-6 px-1 text-xs font-mono font-bold text-[12px]"
                    >
                        DATE
                        <ArrowUpDown className="ml-1 h-3 w-3" />
                    </Button>
                );
            },
            size: 70,
            cell: ({ row }) => <div className="whitespace-nowrap px-1 text-center font-mono font-bold text-[10px]">{format(new Date(row.getValue('transaction_date')), 'MM/dd/yyyy')}</div>,
        },
        {
            accessorKey: 'supplier',
            header: () => <div className="text-center px-1 font-mono font-bold">SUPPLIER</div>,
            size: 120,
            cell: ({ row }) => <div className="truncate px-1 font-bold text-left text-[10px]" title={row.getValue('supplier')}>{row.getValue('supplier')}</div>
        },
        {
            accessorKey: 'batch_code',
            header: () => <div className="text-center px-1 font-mono font-bold">BLOCK</div>,
            size: 80,
            cell: ({ row }) => <div className="truncate px-1 text-center font-bold font-mono text-[10px]" title={row.getValue('batch_code')}>{row.getValue('batch_code')}</div>
        },
        {
            accessorKey: 'block_loc',
            header: () => <div className="text-center px-1 font-mono font-bold">LOC</div>,
            size: 40,
            cell: ({ row }) => {
                const val = row.original.block_loc || row.original.batches?.location_ref;
                return <div className="text-center px-1 font-bold text-[10px] font-mono">{val || '-'}</div>;
            }
        },
        {
            accessorKey: 'truck_plate',
            header: () => <div className="text-center px-1 font-mono font-bold">TRUCK</div>,
            size: 50,
            cell: ({ row }) => <div className="truncate px-1 text-center font-mono text-[10px]">{row.getValue('truck_plate')}</div>
        },
        {
            accessorKey: 'weight_kg',
            header: () => <div className="text-center px-1 font-mono font-bold">WT</div>,
            size: 50,
            cell: ({ row }) => {
                const val = parseFloat(row.getValue('weight_kg'));
                return <div className="text-center text-[10px] px-1 font-mono font-bold">{Math.round(val).toLocaleString()}</div>;
            }
        },
        {
            accessorKey: 'sacks',
            header: () => <div className="text-center px-1 font-mono font-bold ">SKS</div>,
            size: 30,
            cell: ({ row }) => <div className="text-center px-1 font-mono text-[10px]">{row.getValue('sacks')}</div>,
        },
        // Lab Results Split
        {
            id: 'mc',
            header: () => <div className="text-center px-1 font-mono font-bold text-[11px]">MC</div>,
            size: 35,
            cell: ({ row }) => <div className="text-center text-[10px] px-1">{row.original.lab_results?.mc?.toFixed(2) ?? '-'}</div>
        },
        {
            id: 'grit',
            header: () => <div className="text-center px-1 font-mono font-bold text-[11px]">GRIT</div>,
            size: 35,
            cell: ({ row }) => <div className="text-center text-[10px] px-1">{row.original.lab_results?.grit?.toFixed(2) ?? '-'}</div>
        },
        {
            id: 'bd_astm',
            header: () => <div className="text-center px-1 font-mono font-bold text-[11px]">ASTM</div>,
            size: 35,
            cell: ({ row }) => <div className="text-center text-[10px] px-1">{row.original.lab_results?.bd_astm?.toFixed(3) ?? '-'}</div>
        },
        {
            id: 'bd_jis',
            header: () => <div className="text-center px-1 font-mono font-bold text-[11px]">JIS</div>,
            size: 35,
            cell: ({ row }) => <div className="text-center text-[10px] px-1">{row.original.lab_results?.bd_jis?.toFixed(3) ?? '-'}</div>
        },
        {
            id: 'vm',
            header: () => <div className="text-center px-1 font-mono font-bold text-[11px]">VM</div>,
            size: 35,
            cell: ({ row }) => <div className="text-center text-[10px] px-1">{row.original.lab_results?.vm?.toFixed(2) ?? '-'}</div>
        },
        {
            id: 'ash',
            header: () => <div className="text-center px-1 font-mono font-bold text-[11px]">ASH</div>,
            size: 35,
            cell: ({ row }) => <div className="text-center text-[10px] px-1">{row.original.lab_results?.ash?.toFixed(2) ?? '-'}</div>
        },
        {
            id: 'fc',
            header: () => <div className="text-center px-1 font-mono font-bold text-[11px]">FC</div>,
            size: 35,
            cell: ({ row }) => <div className="text-center text-[10px] px-1">{row.original.lab_results?.fc?.toFixed(2) ?? '-'}</div>
        },
        {
            accessorKey: 'remarks',
            header: () => <div className="text-center px-1 font-mono font-bold text-[11px]">REMARKS</div>,
            size: 60,
            cell: ({ row }) => {
                const remarks = row.getValue('remarks') as string;
                if (!remarks) return null;
                return (
                    <Popover>
                        <PopoverTrigger asChild>
                            <div className="flex justify-center cursor-pointer hover:text-foreground transition-colors">
                                <MessageSquareText className="h-4 w-4 text-muted-foreground" />
                            </div>
                        </PopoverTrigger>
                        <PopoverContent className="w-80">
                            <p className="text-sm">{remarks}</p>
                        </PopoverContent>
                    </Popover>
                );
            }
        },
        {
            accessorKey: 'cost_basis',
            header: () => <div className="text-center px-1 font-mono font-bold text-[11px]">PHP/KG</div>,
            size: 50,
            cell: ({ row }) => {
                const val = parseFloat(row.getValue('cost_basis'));
                return (
                    <div className="flex items-center justify-between px-1">
                        <span className="text-[10px] text-muted-foreground">₱</span>
                        <span className="text-right font-mono font-bold text-[10px]">{val.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
                    </div>
                );
            }
        },
        {
            id: 'php_ttl',
            header: () => <div className="text-center px-1 font-mono font-bold text-[11px]">PHP TTL</div>,
            size: 85,
            cell: ({ row }) => {
                const wt = parseFloat(String(row.original.weight_kg)) || 0;
                const price = parseFloat(String(row.original.cost_basis)) || 0;
                const total = wt * price;
                return (
                    <div className="flex items-center justify-between px-1">
                        <span className="text-[10px] text-muted-foreground">₱</span>
                        <span className="text-right font-mono font-bold text-[10px]">{total.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
                    </div>
                );
            }
        },
        {
            id: 'actions',
            header: '',
            size: 40,
            cell: ({ row }) => {
                const delivery = row.original;
                return (
                    <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                            <Button variant="ghost" className="h-6 w-6 p-0">
                                <span className="sr-only">Open menu</span>
                                <MoreHorizontal className="h-3 w-3" />
                            </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                            <DropdownMenuLabel>Actions</DropdownMenuLabel>
                            <DropdownMenuItem onClick={() => {
                                setEditingRow(delivery);
                                setIsEditOpen(true);
                            }}>
                                <Pencil className="mr-2 h-4 w-4" /> Edit
                            </DropdownMenuItem>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem onClick={() => handleDelete(delivery.id)} className="text-destructive">
                                <Trash2 className="mr-2 h-4 w-4" /> Delete
                            </DropdownMenuItem>
                        </DropdownMenuContent>
                    </DropdownMenu>
                )
            }
        }
    ];

    const table = useReactTable({
        data,
        columns,
        onSortingChange: setSorting,
        onColumnFiltersChange: setColumnFilters,
        getCoreRowModel: getCoreRowModel(),
        // getPaginationRowModel: getPaginationRowModel(), // Removed per request
        getSortedRowModel: getSortedRowModel(),
        getFilteredRowModel: getFilteredRowModel(),
        onGlobalFilterChange: setGlobalFilter,
        globalFilterFn: (row, columnId, filterValue) => {
            const search = filterValue.toLowerCase();
            const supplier = (row.getValue('supplier') as string).toLowerCase();
            const batch = (row.getValue('batch_code') as string).toLowerCase();
            return supplier.includes(search) || batch.includes(search);
        },
        state: {
            sorting,
            columnFilters,
            globalFilter,
        },
    });

    // Calculate totals for footer
    const totalWeight = table.getFilteredRowModel().rows.reduce((sum, row) => sum + (parseFloat(String(row.original.weight_kg)) || 0), 0);
    const totalSacks = table.getFilteredRowModel().rows.reduce((sum, row) => sum + (parseInt(String(row.original.sacks)) || 0), 0);
    const totalAmount = table.getFilteredRowModel().rows.reduce((sum, row) => {
        const wt = parseFloat(String(row.original.weight_kg)) || 0;
        const price = parseFloat(String(row.original.cost_basis)) || 0;
        return sum + (wt * price);
    }, 0);

    return (
        <TooltipProvider>
            <div className="w-full space-y-4">
                {/* Edit Dialog */}
                <Dialog open={isEditOpen} onOpenChange={setIsEditOpen}>
                    <DialogContent className="max-w-2xl">
                        <DialogHeader>
                            <DialogTitle>Edit Delivery</DialogTitle>
                            <DialogDescription>
                                Make changes to the delivery record here. Click save when you're done.
                            </DialogDescription>
                        </DialogHeader>
                        {editingRow && (
                            <form onSubmit={handleEditSubmit} className="grid gap-4 py-4">
                                <div className="grid grid-cols-2 gap-4">
                                    <div className="grid gap-2">
                                        <Label htmlFor="date">Date</Label>
                                        <Input id="date" type="date" value={editingRow.transaction_date} onChange={e => setEditingRow({ ...editingRow, transaction_date: e.target.value })} />
                                    </div>
                                    <div className="grid gap-2">
                                        <Label htmlFor="supplier">Supplier</Label>
                                        <Input id="supplier" value={editingRow.supplier} onChange={e => setEditingRow({ ...editingRow, supplier: e.target.value })} />
                                    </div>
                                    <div className="grid gap-2">
                                        <Label htmlFor="batch">Block (Batch)</Label>
                                        <Input id="batch" value={editingRow.batch_code} onChange={e => setEditingRow({ ...editingRow, batch_code: e.target.value })} />
                                    </div>
                                    <div className="grid gap-2">
                                        <Label htmlFor="loc">Block Loc</Label>
                                        <Input id="loc" value={editingRow.block_loc} onChange={e => setEditingRow({ ...editingRow, block_loc: e.target.value })} />
                                    </div>
                                    <div className="grid gap-2">
                                        <Label htmlFor="truck">Truck</Label>
                                        <Input id="truck" value={editingRow.truck_plate} onChange={e => setEditingRow({ ...editingRow, truck_plate: e.target.value })} />
                                    </div>
                                    <div className="grid gap-2">
                                        <Label htmlFor="sacks">Sacks</Label>
                                        <Input id="sacks" type="number" value={editingRow.sacks} onChange={e => setEditingRow({ ...editingRow, sacks: parseInt(e.target.value) || 0 })} />
                                    </div>
                                    <div className="grid gap-2">
                                        <Label htmlFor="weight">Weight (kg)</Label>
                                        <Input id="weight" type="number" step="0.01" value={editingRow.weight_kg} onChange={e => setEditingRow({ ...editingRow, weight_kg: parseFloat(e.target.value) || 0 })} />
                                    </div>
                                    <div className="grid gap-2">
                                        <Label htmlFor="price">Price</Label>
                                        <Input id="price" type="number" step="0.01" value={editingRow.cost_basis} onChange={e => setEditingRow({ ...editingRow, cost_basis: parseFloat(e.target.value) || 0 })} />
                                    </div>
                                </div>
                                <div className="grid gap-2">
                                    <Label>Lab Results (MC / Ash / BD / JIS / Grit / VM / FC)</Label>
                                    <div className="grid grid-cols-7 gap-2">
                                        {['mc', 'ash', 'bd', 'jis', 'grit', 'vm', 'fc'].map(field => (
                                            <Input
                                                key={field}
                                                placeholder={field.toUpperCase()}
                                                type="number" step="0.01"
                                                className="px-1 text-center text-xs"
                                                value={(editingRow.lab_results as any)?.[field] || 0}
                                                onChange={e => setEditingRow({
                                                    ...editingRow,
                                                    lab_results: {
                                                        ...editingRow.lab_results,
                                                        [field]: parseFloat(e.target.value) || 0
                                                    }
                                                })}
                                            />
                                        ))}
                                    </div>
                                </div>
                                <div className="grid gap-2">
                                    <Label htmlFor="remarks">Remarks</Label>
                                    <Input id="remarks" value={editingRow.remarks || ''} onChange={e => setEditingRow({ ...editingRow, remarks: e.target.value })} />
                                </div>
                                <DialogFooter>
                                    <Button type="submit">Save changes</Button>
                                </DialogFooter>
                            </form>
                        )}
                    </DialogContent>
                </Dialog>

                <div className="flex items-center py-4">
                    <div className="relative max-w-sm w-full">
                        <Search className="absolute left-2 top-2.5 h-4 w-4 text-muted-foreground" />
                        <Input
                            placeholder="Search Supplier or Batch..."
                            value={globalFilter ?? ''}
                            onChange={(event) =>
                                setGlobalFilter(event.target.value)
                            }
                            className="pl-8 h-8 text-sm"
                        />
                    </div>
                </div>
                <div className="rounded-md border overflow-y-auto max-h-[600px]">
                    <Table className="w-full table-fixed text-xs relative">
                        <TableHeader className="bg-muted/50 sticky top-0 z-10">
                            {table.getHeaderGroups().map((headerGroup) => (
                                <TableRow key={headerGroup.id} className="h-8 hover:bg-transparent">
                                    {headerGroup.headers.map((header) => {
                                        return (
                                            <TableHead key={header.id} style={{ width: header.getSize() }} className="px-1 h-8 bg-muted/50">
                                                {header.isPlaceholder
                                                    ? null
                                                    : flexRender(
                                                        header.column.columnDef.header,
                                                        header.getContext()
                                                    )}
                                            </TableHead>
                                        );
                                    })}
                                </TableRow>
                            ))}
                        </TableHeader>
                        <TableBody>
                            {table.getRowModel().rows?.length ? (
                                table.getRowModel().rows.map((row) => (
                                    <TableRow
                                        key={row.id}
                                        data-state={row.getIsSelected() && "selected"}
                                        className="hover:bg-muted/50 h-8"
                                    >
                                        {row.getVisibleCells().map((cell) => (
                                            <TableCell key={cell.id} className="p-0 border-r last:border-0 h-8">
                                                {flexRender(
                                                    cell.column.columnDef.cell,
                                                    cell.getContext()
                                                )}
                                            </TableCell>
                                        ))}
                                    </TableRow>
                                ))
                            ) : (
                                <TableRow>
                                    <TableCell
                                        colSpan={columns.length}
                                        className="h-24 text-center"
                                    >
                                        No results.
                                    </TableCell>
                                </TableRow>
                            )}
                        </TableBody>
                    </Table>
                </div>
            </div>
        </TooltipProvider>
    );
}
