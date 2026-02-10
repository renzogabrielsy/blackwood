
'use client';

import * as React from 'react';
import { format } from 'date-fns';
import { toast } from 'sonner';
import {
    ColumnDef,
    ColumnFiltersState,
    SortingState,
    flexRender,
    getCoreRowModel,
    getFilteredRowModel,
    getSortedRowModel,
    useReactTable,
} from '@tanstack/react-table';
import { useRouter, usePathname, useSearchParams } from 'next/navigation';
import { useCallback } from 'react';
import { ArrowUpDown, ChevronDown, Search, MoreHorizontal, Pencil, Trash2, MessageSquareText, Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
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
    DialogHeader,
    DialogTitle,
} from '@/components/ui/dialog';
import {
    Popover,
    PopoverContent,
    PopoverTrigger,
} from '@/components/ui/popover';
import {
    TooltipProvider,
} from '@/components/ui/tooltip';
import { DeliveryRow, deleteDelivery } from './actions';
import { calculateWhse } from '@/lib/rc-utils';

export type DeliveryHistoryRow = DeliveryRow & {
    id: string;
    created_at: string;
    batches?: {
        location_ref: string;
    };
};

import { BulkDeliveryInput } from './bulk-delivery-input';

export function DeliveryMasterTable({ data, batches }: { data: DeliveryHistoryRow[], batches: any[] }) {
    const router = useRouter();
    const pathname = usePathname();
    const searchParams = useSearchParams();

    const searchParam = searchParams.get('search') || '';
    const fieldParam = searchParams.get('field') || 'all';

    const [sorting, setSorting] = React.useState<SortingState>([]);
    const [columnFilters, setColumnFilters] = React.useState<ColumnFiltersState>([]);
    const [isAddOpen, setIsAddOpen] = React.useState(false);

    const searchField = (fieldParam as 'all' | 'supplier' | 'batch_code' | 'whse' | 'truck_plate');

    const createQueryString = useCallback(
        (name: string, value: string) => {
            const params = new URLSearchParams(searchParams.toString());
            if (value) {
                params.set(name, value);
            } else {
                params.delete(name);
            }
            return params.toString();
        },
        [searchParams]
    );

    const [searchTerm, setSearchTerm] = React.useState(searchParam);

    React.useEffect(() => {
        const timer = setTimeout(() => {
            if (searchTerm !== searchParam) {
                router.push(pathname + '?' + createQueryString('search', searchTerm));
            }
        }, 300);

        return () => clearTimeout(timer);
    }, [searchTerm, searchParam, router, pathname, createQueryString]);

    const handleSearchChange = (term: string) => {
        setSearchTerm(term);
    };

    const handleFieldChange = (field: string) => {
        router.push(pathname + '?' + createQueryString('field', field));
    };

    const handleDelete = async (id: string) => {
        if (confirm('Are you sure you want to delete this delivery?')) {
            const res = await deleteDelivery(id);
            if (res.success) {
                toast.success('Delivery deleted');
            } else {
                toast.error('Delete failed: ' + res.message);
            }
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
            header: () => <div className={`text-center px-1 font-mono font-bold ${searchField === 'whse' ? 'text-primary bg-primary/10 rounded' : ''}`}>WHSE</div>,
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
            header: () => <div className={`text-center px-1 font-mono font-bold ${searchField === 'supplier' ? 'text-primary bg-primary/10 rounded' : ''}`}>SUPPLIER</div>,
            size: 120,
            cell: ({ row }) => <div className="truncate px-1 font-bold text-left text-[10px]" title={row.getValue('supplier')}>{row.getValue('supplier')}</div>
        },
        {
            accessorKey: 'batch_code',
            header: () => <div className={`text-center px-1 font-mono font-bold ${searchField === 'batch_code' ? 'text-primary bg-primary/10 rounded' : ''}`}>BLOCK</div>,
            size: 80,
            cell: ({ row }) => <div className="truncate px-1 text-center font-bold font-mono text-[10px]" title={row.getValue('batch_code')}>{row.getValue('batch_code')}</div>
        },
        {
            accessorKey: 'block_loc',
            header: () => <div className={`text-center px-1 font-mono font-bold ${searchField === 'whse' ? 'text-primary bg-primary/10 rounded' : ''}`}>LOC</div>,
            size: 40,
            cell: ({ row }) => {
                const val = row.original.block_loc || row.original.batches?.location_ref;
                return <div className="text-center px-1 font-bold text-[10px] font-mono">{val || '-'}</div>;
            }
        },
        {
            accessorKey: 'truck_plate',
            header: () => <div className={`text-center px-1 font-mono font-bold ${searchField === 'truck_plate' ? 'text-primary bg-primary/10 rounded' : ''}`}>TRUCK</div>,
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
                            <DropdownMenuItem onClick={() => toast.info('Edit dialog coming soon')}>
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
        getSortedRowModel: getSortedRowModel(),
        getFilteredRowModel: getFilteredRowModel(),
        state: {
            sorting,
            columnFilters,
        },
    });

    // Single-pass footer totals
    const { totalWeight, totalSacks, totalAmount } = table.getFilteredRowModel().rows.reduce(
        (acc, row) => {
            const wt = parseFloat(String(row.original.weight_kg)) || 0;
            const sacks = parseInt(String(row.original.sacks)) || 0;
            const price = parseFloat(String(row.original.cost_basis)) || 0;
            return {
                totalWeight: acc.totalWeight + wt,
                totalSacks: acc.totalSacks + sacks,
                totalAmount: acc.totalAmount + (wt * price),
            };
        },
        { totalWeight: 0, totalSacks: 0, totalAmount: 0 }
    );

    return (
        <TooltipProvider>
            <div className="flex flex-col h-full space-y-4">
                {/* Add Delivery Dialog */}
                <Dialog open={isAddOpen} onOpenChange={setIsAddOpen}>
                    <DialogContent className="sm:max-w-[98vw] w-full p-0 overflow-hidden flex flex-col max-h-[95vh] border-none shadow-xl">
                        <DialogHeader className="p-4 py-2 shrink-0 bg-background border-b z-50">
                            <DialogTitle>Add Deliveries</DialogTitle>
                            <DialogDescription>
                                Enter delivery details below.
                            </DialogDescription>
                        </DialogHeader>
                        <div className="flex-1 overflow-auto p-6 pt-2">
                            <BulkDeliveryInput
                                batches={batches}
                                suppliers={Array.from(new Set(data.map(d => d.supplier))).filter(Boolean).sort()}
                                onSuccess={() => setIsAddOpen(false)}
                            />
                        </div>
                    </DialogContent>
                </Dialog>

                {/* Toolbar */}
                <div className="flex-none flex items-center justify-between py-1">
                    <div className="flex items-center gap-2">
                        <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                                <Button variant="outline" className="ml-auto w-32 h-8 text-[12px] font-mono">
                                    {searchField === 'all' ? 'All Fields' : searchField.toUpperCase()}
                                    <ChevronDown className="ml-2 h-4 w-4" />
                                </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="start">
                                <DropdownMenuLabel>Search Field</DropdownMenuLabel>
                                <DropdownMenuSeparator />
                                <DropdownMenuItem onClick={() => handleFieldChange('all')}>All Fields</DropdownMenuItem>
                                <DropdownMenuItem onClick={() => handleFieldChange('supplier')}>Supplier</DropdownMenuItem>
                                <DropdownMenuItem onClick={() => handleFieldChange('batch_code')}>Block</DropdownMenuItem>
                                <DropdownMenuItem onClick={() => handleFieldChange('whse')}>WHSE</DropdownMenuItem>
                                <DropdownMenuItem onClick={() => handleFieldChange('truck_plate')}>Truck Plate</DropdownMenuItem>
                            </DropdownMenuContent>
                        </DropdownMenu>

                        <div className="relative max-w-sm w-64">
                            <Search className="absolute left-2 top-2.5 h-3 w-3 text-muted-foreground" />
                            <Input
                                placeholder={`Search ${searchField === 'all' ? 'deliveries' : searchField}...`}
                                value={searchTerm}
                                onChange={(event) => handleSearchChange(event.target.value)}
                                className="pl-8 h-8 text-xs font-mono"
                            />
                        </div>
                    </div>
                    <Button onClick={() => setIsAddOpen(true)} size="sm" className="ml-auto h-8 gap-1">
                        <Plus className="h-4 w-4" />
                        Add Delivery
                    </Button>
                </div>

                {/* Scrollable Table */}
                <div className="flex-1 min-h-0 rounded-md border overflow-hidden flex flex-col relative bg-background">
                    <div className="flex-1 overflow-auto relative w-full h-full">
                        <table className="w-full caption-bottom text-sm table-fixed relative border-collapse">
                            <TableHeader className="bg-background sticky top-0 z-50 shadow-sm">
                                {table.getHeaderGroups().map((headerGroup) => (
                                    <TableRow key={headerGroup.id} className="h-8 hover:bg-transparent border-b">
                                        {headerGroup.headers.map((header) => {
                                            return (
                                                <TableHead key={header.id} style={{ width: header.getSize() }} className="px-1 h-8 bg-background sticky top-0 z-50 font-bold text-foreground">
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
                                            className="hover:bg-muted/50 h-8 border-b last:border-0"
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
                            <TableFooter className="bg-muted/30 sticky bottom-0">
                                <TableRow className="h-8 hover:bg-muted/30">
                                    {/* STATE + WHSE + DATE + SUPPLIER + BLOCK + LOC + TRUCK = 7 columns */}
                                    <TableCell colSpan={7} className="px-2 text-[10px] font-mono font-bold text-right">
                                        TOTALS
                                    </TableCell>
                                    {/* WT */}
                                    <TableCell className="px-1 text-center text-[10px] font-mono font-bold">
                                        {Math.round(totalWeight).toLocaleString()}
                                    </TableCell>
                                    {/* SKS */}
                                    <TableCell className="px-1 text-center text-[10px] font-mono font-bold">
                                        {totalSacks.toLocaleString()}
                                    </TableCell>
                                    {/* MC + GRIT + ASTM + JIS + VM + ASH + FC + REMARKS + PHP/KG = 9 columns */}
                                    <TableCell colSpan={9} />
                                    {/* PHP TTL */}
                                    <TableCell className="px-1 text-[10px] font-mono font-bold">
                                        <div className="flex items-center justify-between">
                                            <span className="text-muted-foreground">₱</span>
                                            <span>{totalAmount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
                                        </div>
                                    </TableCell>
                                    {/* Actions */}
                                    <TableCell />
                                </TableRow>
                            </TableFooter>
                        </table>
                    </div>
                </div>
            </div>
        </TooltipProvider>
    );
}
