
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
import { ArrowUpDown, ChevronDown, Search } from 'lucide-react';
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
import { DeliveryRow } from './actions';

// Extended type for history to include ID if needed, but for display we can use DeliveryRow + created_at?
// Let's assume the data passed in matches DeliveryRowStructure + some extras.
export type DeliveryHistoryRow = DeliveryRow & {
    id: string;
    created_at: string;
};

export const columns: ColumnDef<DeliveryHistoryRow>[] = [
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
        cell: ({ row }) => <div className="pl-4">{new Date(row.getValue('transaction_date')).toLocaleDateString()}</div>,
    },
    {
        accessorKey: 'supplier',
        header: 'Supplier',
    },
    {
        accessorKey: 'batch_code',
        header: 'Block (Batch)',
    },
    {
        accessorKey: 'truck_plate',
        header: 'Truck',
    },
    {
        accessorKey: 'sacks',
        header: 'Sacks',
    },
    {
        accessorKey: 'weight_kg',
        header: 'Weight (kg)',
        cell: ({ row }) => {
            const val = parseFloat(row.getValue('weight_kg'));
            return <div className="font-medium">{val.toLocaleString(undefined, { minimumFractionDigits: 2 })}</div>;
        }
    },
    {
        accessorKey: 'cost_basis',
        header: 'Price',
        cell: ({ row }) => {
            const val = parseFloat(row.getValue('cost_basis'));
            return <div>{val.toFixed(2)}</div>;
        }
    },
    // Lab Stats: We can accessor logic to get nested values
    {
        id: 'lab_stats',
        header: 'Lab Stats (MC / Ash / BD)',
        cell: ({ row }) => {
            const lab = row.original.lab_results || {};
            const mc = lab.mc?.toFixed(2) ?? '-';
            const ash = lab.ash?.toFixed(2) ?? '-';
            const bd = lab.bd?.toFixed(2) ?? '-';
            return <div className="text-xs text-muted-foreground">{mc} / {ash} / {bd}</div>;
        }
    },
    {
        accessorKey: 'remarks',
        header: 'Remarks',
    },
];

export function DeliveryMasterTable({ data }: { data: DeliveryHistoryRow[] }) {
    const [sorting, setSorting] = React.useState<SortingState>([]);
    const [columnFilters, setColumnFilters] = React.useState<ColumnFiltersState>([]);
    const [globalFilter, setGlobalFilter] = React.useState('');

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
