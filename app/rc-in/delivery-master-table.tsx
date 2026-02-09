
'use client';

import * as React from 'react';
import {
    ColumnDef,
    ColumnFiltersState,
    SortingState,
    VisibilityState,
    flexRender,
    getCoreRowModel,
    getFilteredRowModel,
    getPaginationRowModel,
    getSortedRowModel,
    useReactTable,
} from '@tanstack/react-table';
import { ArrowUpDown, ChevronDown, Search, MoreHorizontal, Pencil, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
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
            header: 'State',
            cell: ({ row }) => <div className="text-xs text-muted-foreground text-center font-mono uppercase">{row.original.state || 'STORED'}</div>,
        },
        {
            id: 'whse',
            header: 'WHSE',
            cell: ({ row }) => {
                const loc = row.original.block_loc || row.original.batches?.location_ref;
                return <div className="whitespace-nowrap font-medium text-center">{calculateWhse(loc)}</div>;
            }
        },
        {
            accessorKey: 'transaction_date',
            header: ({ column }) => {
                return (
                    <Button
                        variant="ghost"
                        onClick={() => column.toggleSorting(column.getIsSorted() === 'asc')}
                    >
                        Date
                        <ArrowUpDown className="ml-2 h-4 w-4" />
                    </Button>
                );
            },
            cell: ({ row }) => <div className="whitespace-nowrap">{new Date(row.getValue('transaction_date')).toLocaleDateString()}</div>,
        },
        {
            accessorKey: 'supplier',
            header: 'Supplier',
        },
        {
            accessorKey: 'batch_code',
            header: 'Block',
        },
        {
            accessorKey: 'block_loc',
            header: 'Block Loc',
            cell: ({ row }) => {
                const val = row.original.block_loc || row.original.batches?.location_ref;
                return <div className="text-center">{val || '-'}</div>;
            }
        },
        {
            accessorKey: 'truck_plate',
            header: 'Truck',
        },
        {
            accessorKey: 'weight_kg',
            header: 'WT',
            cell: ({ row }) => {
                const val = parseFloat(row.getValue('weight_kg'));
                return <div className="font-medium text-right">{val.toLocaleString(undefined, { minimumFractionDigits: 2 })}</div>;
            }
        },
        {
            accessorKey: 'sacks',
            header: 'SKS',
            cell: ({ row }) => <div className="text-right">{row.getValue('sacks')}</div>,
        },
        // Lab Results Split
        {
            id: 'mc',
            header: 'MC',
            cell: ({ row }) => <div className="text-center">{row.original.lab_results?.mc?.toFixed(2) ?? '-'}</div>
        },
        {
            id: 'grit',
            header: 'GRIT',
            cell: ({ row }) => <div className="text-center">{row.original.lab_results?.grit?.toFixed(2) ?? '-'}</div>
        },
        {
            id: 'bd_astm',
            header: 'BD ASTM',
            cell: ({ row }) => <div className="text-center">{row.original.lab_results?.bd_astm?.toFixed(2) ?? '-'}</div>
        },
        {
            id: 'bd_jis',
            header: 'BD JIS',
            cell: ({ row }) => <div className="text-center">{row.original.lab_results?.bd_jis?.toFixed(2) ?? '-'}</div>
        },
        {
            id: 'vm',
            header: 'VM',
            cell: ({ row }) => <div className="text-center">{row.original.lab_results?.vm?.toFixed(2) ?? '-'}</div>
        },
        {
            id: 'ash',
            header: 'ASH',
            cell: ({ row }) => <div className="text-center">{row.original.lab_results?.ash?.toFixed(2) ?? '-'}</div>
        },
        {
            id: 'fc',
            header: 'FC',
            cell: ({ row }) => <div className="text-center">{row.original.lab_results?.fc?.toFixed(2) ?? '-'}</div>
        },
        {
            accessorKey: 'remarks',
            header: 'Remarks',
        },
        {
            accessorKey: 'cost_basis',
            header: 'PHP/KG',
            cell: ({ row }) => {
                const val = parseFloat(row.getValue('cost_basis'));
                return <div className="text-right">{val.toFixed(2)}</div>;
            }
        },
        {
            id: 'php_ttl',
            header: 'PHP TTL',
            cell: ({ row }) => {
                const wt = parseFloat(String(row.original.weight_kg)) || 0;
                const price = parseFloat(String(row.original.cost_basis)) || 0;
                return <div className="text-right font-semibold">{(wt * price).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</div>;
            }
        },
        {
            id: 'actions',
            header: '',
            cell: ({ row }) => {
                const delivery = row.original;
                return (
                    <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                            <Button variant="ghost" className="h-8 w-8 p-0">
                                <span className="sr-only">Open menu</span>
                                <MoreHorizontal className="h-4 w-4" />
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
        getPaginationRowModel: getPaginationRowModel(),
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

    return (
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
                        className="pl-8"
                    />
                </div>
            </div>
            <div className="rounded-md border">
                <Table>
                    <TableHeader>
                        {table.getHeaderGroups().map((headerGroup) => (
                            <TableRow key={headerGroup.id}>
                                {headerGroup.headers.map((header) => {
                                    return (
                                        <TableHead key={header.id}>
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
                                    className="cursor-pointer hover:bg-muted/50"
                                    onClick={(e) => {
                                        // Only trigger edit if clicking row, not if clicking actions
                                        // But wait, user requirement says: "When a row is clicked, it should toggle into 'Edit Mode' or open a small Dialog"
                                        // Let's make row click open edit, but avoid conflict with dropdown
                                        if ((e.target as HTMLElement).closest('[data-radix-collection-item]')) return;
                                        setEditingRow(row.original);
                                        setIsEditOpen(true);
                                    }}
                                >
                                    {row.getVisibleCells().map((cell) => (
                                        <TableCell key={cell.id}>
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
            <div className="flex items-center justify-end space-x-2 py-4">
                <Button
                    variant="outline"
                    size="sm"
                    onClick={() => table.previousPage()}
                    disabled={!table.getCanPreviousPage()}
                >
                    Previous
                </Button>
                <Button
                    variant="outline"
                    size="sm"
                    onClick={() => table.nextPage()}
                    disabled={!table.getCanNextPage()}
                >
                    Next
                </Button>
            </div>
        </div>
    );
}
