
'use client';

import * as React from 'react';
import { format } from 'date-fns';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { useTableSettings } from '@/components/providers/table-settings';
import { useAuth, UserRole } from '@/components/providers/auth-context';
import { Slider } from '@/components/ui/slider';
import { Label } from '@/components/ui/label';
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
import { ArrowUpDown, ChevronDown, Search, MoreHorizontal, Pencil, Trash2, MessageSquareText, Plus, Settings, X, Shield } from 'lucide-react';
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
import { deleteDelivery, bulkDeleteDeliveries } from './actions';
import { calculateWhse } from '@/lib/rc-utils';
import type { DeliveryHistoryRow } from '@/types/rc-in';

export type { DeliveryHistoryRow } from '@/types/rc-in';

import { BulkDeliveryInput } from './bulk-delivery-input';

const LAB_COLUMNS: { key: string; label: string; decimals: number }[] = [
    { key: 'mc', label: 'MC', decimals: 2 },
    { key: 'grit', label: 'GRIT', decimals: 2 },
    { key: 'bd_astm', label: 'ASTM', decimals: 3 },
    { key: 'bd_jis', label: 'JIS', decimals: 3 },
    { key: 'vm', label: 'VM', decimals: 2 },
    { key: 'ash', label: 'ASH', decimals: 2 },
    { key: 'fc', label: 'FC', decimals: 2 },
];

export function DeliveryMasterTable({ data, batches, customFooter }: { data: DeliveryHistoryRow[], batches: any[], customFooter?: React.ReactNode }) {
    const { fontSize, rowHeight, setFontSize, setRowHeight } = useTableSettings();
    const { role, setRole, hasPermission } = useAuth();
    const router = useRouter();
    const pathname = usePathname();
    const searchParams = useSearchParams();

    const searchParam = searchParams.get('search') || '';
    const fieldParam = searchParams.get('field') || 'all';

    const [sorting, setSorting] = React.useState<SortingState>([]);
    const [columnFilters, setColumnFilters] = React.useState<ColumnFiltersState>([]);

    // fontSize and rowHeight are from useTableSettings hook above
    const [isInputDirty, setIsInputDirty] = React.useState(false);
    const [showExitConfirmation, setShowExitConfirmation] = React.useState(false);
    const [pendingAction, setPendingAction] = React.useState<() => void>(() => { });
    const [isAddOpen, setIsAddOpen] = React.useState(false);
    const [selectionMode, setSelectionMode] = React.useState(false);
    const [selectedIds, setSelectedIds] = React.useState<Set<string>>(new Set());
    const [editRows, setEditRows] = React.useState<DeliveryHistoryRow[] | null>(null);

    const searchField = (fieldParam as 'all' | 'supplier' | 'batch_code' | 'whse' | 'truck_plate');

    const createQueryString = React.useCallback(
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

    const toggleSelect = React.useCallback((id: string) => {
        setSelectedIds(prev => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
        });
    }, []);

    const handleDelete = async (id: string) => {
        if (confirm('Are you sure you want to delete this delivery?')) {
            const res = await deleteDelivery(id);
            if (res.success) {
                toast.success('Delivery deleted');
                setSelectedIds(prev => { const next = new Set(prev); next.delete(id); return next; });
            } else {
                toast.error('Delete failed: ' + res.message);
            }
        }
    };

    const handleBulkDelete = async () => {
        const count = selectedIds.size;
        if (confirm(`Are you sure you want to delete ${count} deliver${count === 1 ? 'y' : 'ies'}?`)) {
            const res = await bulkDeleteDeliveries([...selectedIds]);
            if (res.success) {
                toast.success(`${count} deliver${count === 1 ? 'y' : 'ies'} deleted`);
                setSelectedIds(new Set());
            } else {
                toast.error('Bulk delete failed: ' + res.message);
            }
        }
    };

    const handleCloseAdd = () => {
        if (isInputDirty) {
            setPendingAction(() => () => setIsAddOpen(false));
            setShowExitConfirmation(true);
        } else {
            setIsAddOpen(false);
        }
    };

    const handleCloseEdit = () => {
        if (isInputDirty) {
            setPendingAction(() => () => {
                setEditRows(null);
                // Also clear selection logic if needed, but setEditRows(null) is main close
            });
            setShowExitConfirmation(true);
        } else {
            setEditRows(null);
        }
    };

    const confirmExit = () => {
        setShowExitConfirmation(false);
        setIsInputDirty(false); // Reset dirty state
        if (pendingAction) pendingAction();
    };

    // Reset dirty state when dialogs open/close naturally
    React.useEffect(() => {
        if (!isAddOpen && !editRows) {
            setIsInputDirty(false);
        }
    }, [isAddOpen, editRows]);

    const handleBulkEdit = () => {
        const rows = data.filter(d => selectedIds.has(d.id));
        setEditRows(rows);
    };

    const handleSingleEdit = (delivery: DeliveryHistoryRow) => {
        setEditRows([delivery]);
    };

    const columns = React.useMemo<ColumnDef<DeliveryHistoryRow>[]>(() => {
    const labColumnDefs = LAB_COLUMNS.map(({ key, label, decimals }): ColumnDef<DeliveryHistoryRow> => ({
        id: key,
        header: () => <div className="text-center px-1 font-mono font-bold" style={{ fontSize: `${fontSize}px` }}>{label}</div>,
        size: 35,
        cell: ({ row }) => {
            const val = row.original.lab_results?.[key as keyof DeliveryHistoryRow['lab_results']];
            return <div className="text-center" style={{ fontSize: `${fontSize}px` }}>{val != null ? val.toFixed(decimals) : '-'}</div>;
        },
    }));

    const allColumns: ColumnDef<DeliveryHistoryRow>[] = [
        {
            id: 'state',
            header: () => <div className="text-center px-1 font-mono font-bold" style={{ fontSize: `${fontSize}px` }}>STATE</div>,
            size: 50,
            cell: ({ row }) => <div className="text-muted-foreground text-center font-mono uppercase bg-muted/10 py-0.5 rounded-sm truncate" style={{ fontSize: `${fontSize}px` }} title={row.original.state || 'STORED'}>{row.original.state || 'STORED'}</div>,
        },
        {
            id: 'whse',
            header: () => <div className="text-center px-1 font-mono font-bold" style={{ fontSize: `${fontSize}px` }}>WHSE</div>,
            size: 50,
            cell: ({ row }) => {
                const loc = row.original.block_loc || row.original.batches?.location_ref;
                const whse = calculateWhse(loc, row.original.batch_code);
                return <div className="text-center font-mono font-bold truncate" style={{ fontSize: `${fontSize}px` }} title={whse}>{whse}</div>;
            }
        },
        {
            accessorKey: 'transaction_date',
            header: ({ column }) => {
                return (
                    <Button
                        variant="ghost"
                        onClick={() => column.toggleSorting(column.getIsSorted() === 'asc')}
                        className="h-6 px-1 text-xs font-mono font-bold"
                        style={{ fontSize: `${fontSize}px` }}
                    >
                        DATE
                        <ArrowUpDown className="ml-1 h-3 w-3" />
                    </Button>
                );
            },
            size: 70,
            cell: ({ row }) => <div className="whitespace-nowrap text-center font-mono font-bold" style={{ fontSize: `${fontSize}px` }}>{format(new Date(row.getValue('transaction_date')), 'MM/dd/yyyy')}</div>,
        },
        {
            accessorKey: 'supplier',
            header: () => <div className={`text-center px-1 font-mono font-bold ${searchField === 'supplier' ? 'text-primary bg-primary/10 rounded' : ''}`}>SUPPLIER</div>,
            size: 120,
            cell: ({ row }) => <div className="truncate font-bold text-left" style={{ fontSize: `${fontSize}px` }} title={row.getValue('supplier')}>{row.getValue('supplier')}</div>
        },
        {
            accessorKey: 'batch_code',
            header: () => <div className={`text-center px-1 font-mono font-bold ${searchField === 'batch_code' ? 'text-primary bg-primary/10 rounded' : ''}`}>BLOCK</div>,
            size: 80,
            cell: ({ row }) => <div className="truncate text-center font-bold font-mono" style={{ fontSize: `${fontSize}px` }} title={row.getValue('batch_code')}>{row.getValue('batch_code')}</div>
        },
        {
            accessorKey: 'block_loc',
            header: () => <div className={`text-center px-1 font-mono font-bold ${searchField === 'whse' ? 'text-primary bg-primary/10 rounded' : ''}`}>LOC</div>,
            size: 40,
            cell: ({ row }) => {
                const val = row.original.block_loc || row.original.batches?.location_ref;
                return <div className="text-center font-bold font-mono" style={{ fontSize: `${fontSize}px` }}>{val || '-'}</div>;
            }
        },
        {
            accessorKey: 'truck_plate',
            header: () => <div className={`text-center px-1 font-mono font-bold ${searchField === 'truck_plate' ? 'text-primary bg-primary/10 rounded' : ''}`}>TRUCK</div>,
            size: 40,
            cell: ({ row }) => <div className="truncate text-center font-mono" style={{ fontSize: `${fontSize}px` }}>{row.getValue('truck_plate')}</div>
        },
        {
            accessorKey: 'weight_kg',
            header: () => <div className="text-center px-1 font-mono font-bold">WT</div>,
            size: 50,
            cell: ({ row }) => {
                const val = parseFloat(row.getValue('weight_kg'));
                return <div className="text-center font-mono font-bold" style={{ fontSize: `${fontSize}px` }}>{Math.round(val).toLocaleString()}</div>;
            }
        },
        {
            accessorKey: 'sacks',
            header: () => <div className="text-center px-1 font-mono font-bold ">SKS</div>,
            size: 30,
            cell: ({ row }) => <div className="text-center font-mono" style={{ fontSize: `${fontSize}px` }}>{row.getValue('sacks')}</div>,
        },
        ...labColumnDefs,
        {
            accessorKey: 'remarks',
            header: () => <div className="text-center px-1 font-mono font-bold" style={{ fontSize: `${fontSize}px` }}>REMARKS</div>,
            size: 40,
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
            header: () => <div className="text-center px-1 font-mono font-bold" style={{ fontSize: `${fontSize}px` }}>PHP/KG</div>,
            size: 50,
            cell: ({ row }) => {
                const val = parseFloat(row.getValue('cost_basis'));
                return (
                    <div className="flex items-center justify-between">
                        <span className="text-muted-foreground" style={{ fontSize: `${fontSize}px` }}>₱</span>
                        <span className="text-right font-mono font-bold" style={{ fontSize: `${fontSize}px` }}>{val.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
                    </div>
                );
            }
        },
        {
            id: 'php_ttl',
            header: () => <div className="text-center px-1 font-mono font-bold" style={{ fontSize: `${fontSize}px` }}>PHP TTL</div>,
            size: 85,
            cell: ({ row }) => {
                const wt = parseFloat(String(row.original.weight_kg)) || 0;
                const price = parseFloat(String(row.original.cost_basis)) || 0;
                const total = wt * price;
                return (
                    <div className="flex items-center justify-between">
                        <span className="text-muted-foreground" style={{ fontSize: `${fontSize}px` }}>₱</span>
                        <span className="text-right font-mono font-bold" style={{ fontSize: `${fontSize}px` }}>{total.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
                    </div>
                );
            }
        },
        {
            id: 'actions',
            header: '',
            size: 20,
            cell: ({ row }) => {
                const delivery = row.original;
                return (
                    <DropdownMenu modal={false}>
                        <DropdownMenuTrigger asChild>
                            <Button variant="ghost" className="h-6 w-6 p-0">
                                <span className="sr-only">Open menu</span>
                                <MoreHorizontal className="h-3 w-3" />
                            </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                            <DropdownMenuLabel>Actions</DropdownMenuLabel>
                            <DropdownMenuItem onClick={() => handleSingleEdit(delivery)}>
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

    return allColumns.filter(col => {
        if (col.id === 'cost_basis' || (col as any).accessorKey === 'cost_basis' || col.id === 'php_ttl') {
            return hasPermission('view:prices');
        }
        return true;
    });
    }, [fontSize, searchField, data, hasPermission]);

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
                <Dialog open={isAddOpen} onOpenChange={(open) => { if (!open) handleCloseAdd(); }}>
                    <DialogContent
                        onEscapeKeyDown={(e) => e.preventDefault()}
                        onInteractOutside={(e) => e.preventDefault()}
                        className="sm:max-w-[98vw] w-full p-0 overflow-hidden flex flex-col max-h-[95vh] border-none shadow-xl"
                    >
                        <DialogHeader className="p-4 py-2 shrink-0 bg-background border-b z-50 flex flex-row items-center justify-between space-y-0">
                            <div>
                                <DialogTitle>Add Deliveries</DialogTitle>
                                <DialogDescription>
                                    Enter delivery details below.
                                </DialogDescription>
                            </div>
                            <Button variant="ghost" size="icon" onClick={handleCloseAdd}>
                                <X className="h-4 w-4" />
                            </Button>
                        </DialogHeader>
                        <div className="flex-1 overflow-auto p-6 pt-2">
                            <BulkDeliveryInput
                                batches={batches}
                                suppliers={Array.from(new Set(data.map(d => d.supplier))).filter(Boolean).sort()}
                                onSuccess={() => setIsAddOpen(false)}
                                onDirtyChange={setIsInputDirty}
                            />
                        </div>
                    </DialogContent>
                </Dialog>

                {/* Edit Delivery Dialog */}
                <Dialog open={editRows !== null} onOpenChange={(open) => { if (!open) handleCloseEdit(); }}>
                    <DialogContent
                        onEscapeKeyDown={(e) => e.preventDefault()}
                        onInteractOutside={(e) => e.preventDefault()}
                        className="sm:max-w-[98vw] w-full p-0 overflow-hidden flex flex-col max-h-[95vh] border-none shadow-xl"
                    >
                        <DialogHeader className="p-4 py-2 shrink-0 bg-background border-b z-50 flex flex-row items-center justify-between space-y-0">
                            <div>
                                <DialogTitle>Edit Deliver{editRows?.length === 1 ? 'y' : 'ies'}</DialogTitle>
                                <DialogDescription>
                                    Modify delivery details below.
                                </DialogDescription>
                            </div>
                            <Button variant="ghost" size="icon" onClick={handleCloseEdit}>
                                <X className="h-4 w-4" />
                            </Button>
                        </DialogHeader>
                        <div className="flex-1 overflow-auto p-6 pt-2">
                            {editRows && (
                                <BulkDeliveryInput
                                    mode="edit"
                                    initialData={editRows}
                                    batches={batches}
                                    suppliers={Array.from(new Set(data.map(d => d.supplier))).filter(Boolean).sort()}
                                    onSuccess={() => { setEditRows(null); setSelectedIds(new Set()); }}
                                    onDirtyChange={setIsInputDirty}
                                />
                            )}
                        </div>
                    </DialogContent>
                </Dialog>

                {/* Exit Confirmation Dialog */}
                <Dialog open={showExitConfirmation} onOpenChange={setShowExitConfirmation}>
                    <DialogContent className="sm:max-w-[425px]">
                        <DialogHeader>
                            <DialogTitle>Unsaved Changes</DialogTitle>
                            <DialogDescription>
                                You have unsaved changes. Are you sure you want to discard them and exit?
                            </DialogDescription>
                        </DialogHeader>
                        <div className="flex justify-end space-x-2 pt-4">
                            <Button variant="outline" onClick={() => setShowExitConfirmation(false)}>Cancel</Button>
                            <Button variant="destructive" onClick={confirmExit}>Discard & Exit</Button>
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
                    <Button
                        variant={selectionMode ? "default" : "outline"}
                        size="sm"
                        className="ml-auto h-8 gap-1"
                        onClick={() => {
                            setSelectionMode(prev => !prev);
                            if (selectionMode) setSelectedIds(new Set());
                        }}
                    >
                        Select
                    </Button>
                    <Button onClick={() => setIsAddOpen(true)} size="sm" className="h-8 gap-1 ml-2">
                        <Plus className="h-4 w-4" />
                        Add Delivery
                    </Button>

                    {/* Role Switcher (Dev Only) */}
                    <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                            <Button variant="ghost" size="icon" className="h-8 w-8 ml-2 text-muted-foreground hover:text-foreground">
                                <Shield className="h-4 w-4" />
                            </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                            <DropdownMenuLabel>Dev: Switch Role</DropdownMenuLabel>
                            <DropdownMenuSeparator />
                            {(['Owner', 'Admin', 'Dev', 'Employee'] as UserRole[]).map((r) => (
                                <DropdownMenuItem key={r} onClick={() => setRole(r)} className={role === r ? "bg-accent" : ""}>
                                    {r} {role === r && "(Active)"}
                                </DropdownMenuItem>
                            ))}
                        </DropdownMenuContent>
                    </DropdownMenu>

                    <Popover>
                        <PopoverTrigger asChild>
                            <Button variant="ghost" size="icon" className="h-8 w-8 ml-2">
                                <Settings className="h-4 w-4" />
                            </Button>
                        </PopoverTrigger>
                        <PopoverContent className="w-80" align="end">
                            <div className="grid gap-4">
                                <div className="space-y-2">
                                    <h4 className="font-medium leading-none">View Options</h4>
                                    <p className="text-sm text-muted-foreground">
                                        Customize the table appearance.
                                    </p>
                                </div>
                                <div className="grid gap-2">
                                    <div className="flex items-center justify-between">
                                        <Label htmlFor="font-size">Font Size: {fontSize}px</Label>
                                    </div>
                                    <Slider
                                        id="font-size"
                                        min={9}
                                        max={14}
                                        step={1}
                                        value={[fontSize]}
                                        onValueChange={(value) => setFontSize(value[0])}
                                    />
                                </div>
                                <div className="grid gap-2">
                                    <div className="flex items-center justify-between">
                                        <Label htmlFor="row-height">Row Height: {rowHeight}px</Label>
                                    </div>
                                    <Slider
                                        id="row-height"
                                        min={20}
                                        max={60}
                                        step={1}
                                        value={[rowHeight]}
                                        onValueChange={(value: number[]) => setRowHeight(value[0])}
                                    />
                                </div>
                            </div>
                        </PopoverContent>
                    </Popover>
                </div>

                {/* Floating Action Bar */}
                {selectionMode && (
                    <div className="flex-none flex items-center gap-3 px-3 py-1.5 rounded-md border bg-muted/50 text-sm">
                        <span className="font-medium text-xs">{selectedIds.size > 0 ? `${selectedIds.size} selected` : 'Click rows to select'}</span>
                        <div className="ml-auto flex gap-2">
                            <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={() => setSelectedIds(new Set())} disabled={selectedIds.size === 0}>
                                Deselect All
                            </Button>
                            <Button variant="outline" size="sm" className="h-7 gap-1 text-xs" onClick={handleBulkEdit} disabled={selectedIds.size === 0}>
                                <Pencil className="h-3 w-3" /> Edit{selectedIds.size > 0 ? ` (${selectedIds.size})` : ''}
                            </Button>
                            <Button variant="outline" size="sm" className="h-7 gap-1 text-xs text-destructive hover:text-destructive" onClick={handleBulkDelete} disabled={selectedIds.size === 0}>
                                <Trash2 className="h-3 w-3" /> Delete{selectedIds.size > 0 ? ` (${selectedIds.size})` : ''}
                            </Button>
                        </div>
                    </div>
                )}

                {/* Scrollable Table */}
                <div className="flex-1 min-h-0 rounded-md border overflow-hidden flex flex-col relative bg-background">
                    <div className="flex-1 overflow-auto relative w-full h-full">
                        <table className="w-full caption-bottom text-sm table-fixed relative border-collapse">
                            <TableHeader className="bg-muted sticky top-0 z-50 shadow-sm border-b">
                                {table.getHeaderGroups().map((headerGroup) => (
                                    <TableRow key={headerGroup.id} className="hover:bg-transparent border-b" style={{ height: `${rowHeight}px` }}>
                                        {headerGroup.headers.map((header) => {
                                            return (


                                                <TableHead key={header.id} style={{ width: header.getSize(), height: `${rowHeight}px` }} className="px-1 bg-muted sticky top-0 z-50 font-bold text-foreground border-b border-foreground/20 shadow-none relative after:absolute after:right-0 after:top-0 after:bottom-0 after:w-[1px] after:bg-foreground/20 last:after:hidden">
                                                    <div style={{ fontSize: `${fontSize}px` }} className="flex items-center justify-center h-full">
                                                        {header.isPlaceholder
                                                            ? null
                                                            : flexRender(
                                                                header.column.columnDef.header,
                                                                header.getContext()
                                                            )}
                                                    </div>
                                                </TableHead>
                                            );
                                        })}
                                    </TableRow>
                                ))}
                            </TableHeader>
                            <TableBody>
                                {table.getRowModel().rows?.length ? (
                                    table.getRowModel().rows.map((row) => {
                                        const isSelected = selectedIds.has(row.original.id);
                                        return (
                                            <TableRow
                                                key={row.id}
                                                data-state={isSelected ? "selected" : undefined}
                                                className={cn(
                                                    "hover:bg-muted/50 border-b last:border-0 transition-colors",
                                                    selectionMode && "cursor-pointer",
                                                    isSelected && "bg-primary/5"
                                                )}
                                                style={{ height: `${rowHeight}px` }}
                                                onClick={selectionMode ? () => toggleSelect(row.original.id) : undefined}
                                            >
                                                {row.getVisibleCells().map((cell) => (
                                                    <TableCell
                                                        key={cell.id}
                                                        className="px-1 py-0 border-r last:border-0"
                                                        style={{ height: `${rowHeight}px` }}
                                                        onClick={cell.column.id === 'actions' ? (e) => e.stopPropagation() : undefined}
                                                    >
                                                        {flexRender(
                                                            cell.column.columnDef.cell,
                                                            cell.getContext()
                                                        )}
                                                    </TableCell>
                                                ))}
                                            </TableRow>
                                        );
                                    })
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
                            <TableFooter className="bg-muted font-medium sticky bottom-0 z-50 shadow-[0_-4px_6px_-1px_rgba(0,0,0,0.1)] border-t border-border/50">
                                <TableRow className="hover:bg-muted/50" style={{ height: `${rowHeight}px` }}>
                                    {/* STATE + WHSE + DATE + SUPPLIER + BLOCK + LOC + TRUCK = 7 columns */}
                                    <TableCell colSpan={7} className="px-2 font-mono font-bold text-right py-0 relative after:absolute after:right-0 after:top-0 after:bottom-0 after:w-[1px] after:bg-foreground/20" style={{ fontSize: `${fontSize}px` }}>
                                        TOTALS
                                    </TableCell>
                                    {/* WT */}
                                    <TableCell className="px-1 text-center font-mono font-bold py-0 relative after:absolute after:right-0 after:top-0 after:bottom-0 after:w-[1px] after:bg-foreground/20" style={{ fontSize: `${fontSize}px` }}>
                                        {Math.round(totalWeight).toLocaleString()}
                                    </TableCell>
                                    {/* SKS - REMOVED TOTAL, LEFT EMPTY */}
                                    <TableCell className="px-1 text-center font-mono font-bold py-0 relative after:absolute after:right-0 after:top-0 after:bottom-0 after:w-[1px] after:bg-foreground/20" style={{ fontSize: `${fontSize}px` }}>
                                    </TableCell>
                                    {/* MC + GRIT + ASTM + JIS + VM + ASH + FC = 7 columns - WEIGHTED AVERAGES */}
                                    {LAB_COLUMNS.map(({ key, decimals }) => {
                                        const rows = table.getFilteredRowModel().rows;
                                        const weightedSum = rows.reduce((sum: number, row: any) => {
                                            const labResults = row.original.lab_results || {};
                                            const val = parseFloat(String(labResults[key as keyof typeof labResults])) || 0;
                                            const wt = parseFloat(String(row.getValue('weight_kg'))) || 0;
                                            return sum + (val * wt);
                                        }, 0);
                                        const weightedAvg = totalWeight > 0 ? weightedSum / totalWeight : 0;

                                        return (
                                            <TableCell key={key} className="px-1 text-center font-mono font-bold py-0 relative after:absolute after:right-0 after:top-0 after:bottom-0 after:w-[1px] after:bg-foreground/20" style={{ fontSize: `${fontSize}px` }}>
                                                {weightedAvg > 0 ? weightedAvg.toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals }) : '-'}
                                            </TableCell>
                                        );
                                    })}
                                    {/* REMARKS */}
                                    <TableCell className="py-0 relative after:absolute after:right-0 after:top-0 after:bottom-0 after:w-[1px] after:bg-foreground/20" />
                                    {/* PHP/KG + PHP TTL combined column in footer? No, header has PHP/KG and PHP TTL separate */}
                                    {/* Actually wait, looking at columns line 355: PHP/KG is cost_basis. line 369: PHP TTL is php_ttl. */}
                                    {/* Footer currently has: 7 cols (totals) + 1 (WT) + 1 (SKS empty) + 7 (weighted avgs) + 1 (Remarks) + 1 (PHP Combined?) */}
                                    {/* Line 763 comment says: "PHP TTL -> Converted to WEIGHTED AVG PHP/KG" */}
                                    {/* This suggests the footer merges them or I am misaligning. */}
                                    {/* Let's look at the columns again. */}
                                    {/* Columns: state, whse, date, supplier, block, loc, truck (7) */}
                                    {/* weight_kg (8) */}
                                    {/* sacks (9) */}
                                    {/* mc, grit, bd_astm, bd_jis, vm, ash, fc (7) -> Total 16 */}
                                    {/* remarks (17) */}
                                    {/* cost_basis (18) */}
                                    {/* php_ttl (19) */}
                                    {/* actions (20) */}

                                    {/* Footer Row: */}
                                    {/* Cell 1: colSpan 7 (matches first 7) */}
                                    {/* Cell 2: WT (matches weight_kg) */}
                                    {/* Cell 3: SKS (matches sacks) - empty */}
                                    {/* Cell 4-10: Weighted Avgs (matches mc...fc - 7 cols) */}
                                    {/* Cell 11: Remarks (matches remarks) */}

                                    {/* Now we need to match cost_basis and php_ttl */}
                                    {hasPermission('view:prices') && (
                                        <>
                                            {/* Cost Basis (PHP/KG) Weighted Avg */}
                                            <TableCell className="px-1 font-mono font-bold py-0 relative after:absolute after:right-0 after:top-0 after:bottom-0 after:w-[1px] after:bg-foreground/20" style={{ fontSize: `${fontSize}px` }}>
                                                <div className="flex items-center justify-between">
                                                    <span className="text-muted-foreground">₱</span>
                                                    <span>{(totalWeight > 0 ? totalAmount / totalWeight : 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
                                                </div>
                                            </TableCell>

                                            {/* PHP TTL Total */}
                                            <TableCell className="px-1 font-mono font-bold py-0 relative after:absolute after:right-0 after:top-0 after:bottom-0 after:w-[1px] after:bg-foreground/20" style={{ fontSize: `${fontSize}px` }}>
                                                <div className="flex items-center justify-between">
                                                    <span className="text-muted-foreground">₱</span>
                                                    <span>{totalAmount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
                                                </div>
                                            </TableCell>
                                        </>
                                    )}
                                    {/* Actions */}
                                    <TableCell className="py-0" />
                                </TableRow>
                            </TableFooter>
                        </table>
                    </div>
                    {customFooter}
                </div>
            </div>
        </TooltipProvider >
    );
}
