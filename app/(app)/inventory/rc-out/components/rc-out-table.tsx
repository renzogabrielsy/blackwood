'use client';

import * as React from 'react';

import { format, endOfMonth } from 'date-fns';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { useTableSettings } from '@/components/providers/table-settings';
import { useAuth } from '@/components/providers/auth-context';
import { Slider } from '@/components/ui/slider';
import { Label } from '@/components/ui/label';
import {
    ColumnDef,
    SortingState,
    flexRender,
    getCoreRowModel,
    getSortedRowModel,
    useReactTable,
} from '@tanstack/react-table';
import { useVirtualizer } from '@tanstack/react-virtual';
import { useRouter, usePathname, useSearchParams } from 'next/navigation';
import { ArrowUpDown, ChevronDown, Search, MoreHorizontal, Plus, Settings, Loader2, Trash2, Pencil, X } from 'lucide-react';
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
import { getRcOutRecords, deleteRcOutRecord, bulkDeleteRcOut } from '../actions';
import type { RcOutRow } from '@/types/rc-out';
import { BulkUsageInput } from '../bulk-usage-input';
import { DeliverySheetFooter } from '../../rc-in/components/DeliverySheetFooter';

const ITEMS_PER_PAGE = 15;

type Batch = {
    id: string;
    batch_code: string;
    location_ref: string;
};

export function RcOutTable({
    data,
    search,
    year = String(new Date().getFullYear()),
    month = String(new Date().getMonth()),
    batches,
    destinations,
    productionBatches,
}: {
    data: RcOutRow[];
    search?: string;
    year?: string;
    month?: string;
    batches: Batch[];
    destinations: string[];
    productionBatches: string[];
}) {
    const { fontSize, rowHeight, setFontSize, setRowHeight } = useTableSettings();
    const { hasPermission } = useAuth();
    const router = useRouter();
    const pathname = usePathname();
    const searchParams = useSearchParams();

    // Search field param (needed by loadMore for field-specific infinite scroll)
    const searchFieldParam = searchParams.get('field') || 'all';

    // Infinite Scroll State
    const [allData, setAllData] = React.useState<RcOutRow[]>(data);
    const [offset, setOffset] = React.useState(data.length);
    const [hasMore, setHasMore] = React.useState(true);
    const [isLoadingMore, setIsLoadingMore] = React.useState(false);

    React.useEffect(() => {
        setAllData(data);
        setOffset(data.length);
        setHasMore(data.length > 0);
    }, [data, search]);

    const getDateRange = React.useCallback(() => {
        let startDate: string | undefined;
        let endDate: string | undefined;

        if (year !== 'all') {
            const y = parseInt(year, 10);
            if (month !== 'all') {
                const m = parseInt(month, 10);
                const start = new Date(y, m, 1);
                const end = endOfMonth(start);
                startDate = format(start, 'yyyy-MM-dd');
                endDate = format(end, 'yyyy-MM-dd');
            } else {
                const start = new Date(y, 0, 1);
                const end = new Date(y, 11, 31);
                startDate = format(start, 'yyyy-MM-dd');
                endDate = format(end, 'yyyy-MM-dd');
            }
        }
        return { startDate, endDate };
    }, [year, month]);

    const loadMore = React.useCallback(async () => {
        if (isLoadingMore || !hasMore) return;
        setIsLoadingMore(true);
        try {
            const { startDate, endDate } = getDateRange();
            const nextData = await getRcOutRecords(search, searchFieldParam, offset, ITEMS_PER_PAGE, startDate, endDate);

            if (nextData.length < ITEMS_PER_PAGE) {
                setHasMore(false);
            }
            if (nextData.length > 0) {
                setAllData(prev => [...prev, ...nextData]);
                setOffset(prev => prev + nextData.length);
            }
        } catch (error) {
            console.error('Failed to load more:', error);
            toast.error('Failed to load more records');
        } finally {
            setIsLoadingMore(false);
        }
    }, [isLoadingMore, hasMore, offset, search, searchFieldParam, getDateRange]);

    // Sorting state
    const [sorting, setSorting] = React.useState<SortingState>([]);

    // Selection State
    const [selectionMode, setSelectionMode] = React.useState(false);
    const [selectedIds, setSelectedIds] = React.useState<Set<string>>(new Set());

    // Dialog States
    const [isAddOpen, setIsAddOpen] = React.useState(false);
    const [editRows, setEditRows] = React.useState<RcOutRow[] | null>(null);
    const [isInputDirty, setIsInputDirty] = React.useState(false);
    const [showExitConfirmation, setShowExitConfirmation] = React.useState(false);
    const [pendingAction, setPendingAction] = React.useState<() => void>(() => { });

    // Search Debounce
    const [searchTerm, setSearchTerm] = React.useState(search || '');
    const [isSearchFocused, setIsSearchFocused] = React.useState(false);
    const searchField = searchFieldParam as 'all' | 'batch_code' | 'production_batch' | 'destination' | 'remarks' | 'block_loc';

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

    React.useEffect(() => {
        const timer = setTimeout(() => {
            if (searchTerm !== (search || '')) {
                router.push(pathname + '?' + createQueryString('search', searchTerm));
            }
        }, 300);
        return () => clearTimeout(timer);
    }, [searchTerm, search, router, pathname, createQueryString]);

    const toggleSelect = React.useCallback((id: string) => {
        setSelectedIds(prev => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
        });
    }, []);

    const handleDelete = async (id: string) => {
        if (confirm('Are you sure you want to delete this record?')) {
            const res = await deleteRcOutRecord(id);
            if (res.success) {
                toast.success('Record deleted');
                setSelectedIds(prev => { const next = new Set(prev); next.delete(id); return next; });
                setAllData(prev => prev.filter(row => row.id !== id));
            } else {
                toast.error('Delete failed: ' + res.message);
            }
        }
    };

    const handleBulkDelete = async () => {
        const count = selectedIds.size;
        if (confirm(`Are you sure you want to delete ${count} record${count === 1 ? '' : 's'}?`)) {
            const res = await bulkDeleteRcOut([...selectedIds]);
            if (res.success) {
                toast.success(`${count} record${count === 1 ? '' : 's'} deleted`);
                setAllData(prev => prev.filter(row => !selectedIds.has(row.id)));
                setSelectedIds(new Set());
            } else {
                toast.error('Bulk delete failed: ' + res.message);
            }
        }
    };

    const handleSingleEdit = (row: RcOutRow) => {
        setEditRows([row]);
    };

    const handleBulkEdit = () => {
        const rows = allData.filter(d => selectedIds.has(d.id));
        setEditRows(rows);
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
            setPendingAction(() => () => setEditRows(null));
            setShowExitConfirmation(true);
        } else {
            setEditRows(null);
        }
    };

    const confirmExit = () => {
        setShowExitConfirmation(false);
        setIsInputDirty(false);
        if (pendingAction) pendingAction();
    };

    // Reset dirty state when dialogs close
    React.useEffect(() => {
        if (!isAddOpen && !editRows) {
            setIsInputDirty(false);
        }
    }, [isAddOpen, editRows]);

    const handleSearchChange = (term: string) => setSearchTerm(term);
    const handleFieldChange = (field: string) => router.push(pathname + '?' + createQueryString('field', field));

    const handleYearChange = (newYear: string) => {
        const params = new URLSearchParams(searchParams.toString());
        params.set('year', newYear);
        if (newYear === 'all') params.set('month', 'all');
        router.push(pathname + '?' + params.toString());
    };

    const handleMonthChange = (newMonth: string) => {
        const params = new URLSearchParams(searchParams.toString());
        params.set('month', newMonth);
        router.push(pathname + '?' + params.toString());
    };

    // Footer totals
    const { totalWeight, totalAvgPrice, totalAvgWtdValue } = React.useMemo(() => {
        let tw = 0, sumPrice = 0, sumVal = 0, countPrice = 0;
        allData.forEach(d => {
            tw += d.weight_kg || 0;
            if (d.avg_price) { sumPrice += d.avg_price * (d.weight_kg || 0); countPrice += d.weight_kg || 0; }
            sumVal += d.avg_wtd_value || 0;
        });
        return {
            totalWeight: tw,
            totalAvgPrice: countPrice > 0 ? sumPrice / countPrice : 0,
            totalAvgWtdValue: sumVal,
        };
    }, [allData]);

    // Columns
    const columns = React.useMemo<ColumnDef<RcOutRow>[]>(() => {
        const allColumns: ColumnDef<RcOutRow>[] = [
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
                size: 90,
                cell: ({ row }) => <div className="whitespace-nowrap text-center font-mono font-bold" style={{ fontSize: `${fontSize}px` }}>{row.original.transaction_date}</div>,
            },
            {
                accessorKey: 'production_batch',
                header: () => <div className={`text-center px-1 font-mono font-bold ${searchField === 'production_batch' ? 'text-primary bg-primary/10 rounded' : ''}`}>BATCH</div>,
                size: 80,
                cell: ({ row }) => <div className="truncate text-center font-bold font-mono" style={{ fontSize: `${fontSize}px` }}>{row.original.production_batch}</div>
            },
            {
                id: 'batch_code',
                accessorKey: 'batches.batch_code',
                header: () => <div className={`text-center px-1 font-mono font-bold ${searchField === 'batch_code' ? 'text-primary bg-primary/10 rounded' : ''}`}>BLOCK</div>,
                size: 80,
                cell: ({ row }) => <div className="truncate text-center font-bold font-mono" style={{ fontSize: `${fontSize}px` }}>{row.original.batches?.batch_code || '-'}</div>
            },
            {
                accessorKey: 'weight_kg',
                header: () => <div className="text-center px-1 font-mono font-bold">WT</div>,
                size: 60,
                cell: ({ row }) => <div className="text-center font-mono font-bold" style={{ fontSize: `${fontSize}px` }}>{row.original.weight_kg?.toLocaleString()}</div>
            },
            {
                accessorKey: 'destination',
                header: () => <div className={`text-center px-1 font-mono font-bold ${searchField === 'destination' ? 'text-primary bg-primary/10 rounded' : ''}`}>PLANT/ETC</div>,
                size: 100,
                cell: ({ row }) => <div className="truncate text-left font-bold" style={{ fontSize: `${fontSize}px` }}>{row.original.destination}</div>
            },
            {
                accessorKey: 'block_loc',
                header: () => <div className={`text-center px-1 font-mono font-bold ${searchField === 'block_loc' ? 'text-primary bg-primary/10 rounded' : ''}`}>BLOCK LOC</div>,
                size: 80,
                cell: ({ row }) => <div className="truncate text-center font-mono" style={{ fontSize: `${fontSize}px` }}>{row.original.block_loc}</div>
            },
            {
                accessorKey: 'remarks',
                header: () => <div className={`text-center px-1 font-mono font-bold ${searchField === 'remarks' ? 'text-primary bg-primary/10 rounded' : ''}`}>REMARKS</div>,
                size: 150,
                cell: ({ row }) => <div className="truncate text-left" title={row.original.remarks || ''} style={{ fontSize: `${fontSize}px` }}>{row.original.remarks}</div>
            },
            {
                accessorKey: 'avg_price',
                header: () => <div className="text-center px-1 font-mono font-bold">AVG PRICE</div>,
                size: 80,
                cell: ({ row }) => (
                    <div className="flex items-center justify-between" style={{ fontSize: `${fontSize}px` }}>
                        <span className="text-muted-foreground">₱</span>
                        <span className="font-mono">{row.original.avg_price?.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
                    </div>
                )
            },
            {
                accessorKey: 'avg_wtd_value',
                header: () => <div className="text-center px-1 font-mono font-bold">AVG VAL</div>,
                size: 90,
                cell: ({ row }) => (
                    <div className="flex items-center justify-between" style={{ fontSize: `${fontSize}px` }}>
                        <span className="text-muted-foreground">₱</span>
                        <span className="font-mono font-bold">{row.original.avg_wtd_value?.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
                    </div>
                )
            },
            {
                id: 'actions',
                header: '',
                size: 30,
                cell: ({ row }) => {
                    const record = row.original;
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
                                <DropdownMenuItem onClick={() => handleSingleEdit(record)}>
                                    <Pencil className="mr-2 h-4 w-4" /> Edit
                                </DropdownMenuItem>
                                <DropdownMenuSeparator />
                                <DropdownMenuItem onClick={() => handleDelete(record.id)} className="text-destructive">
                                    <Trash2 className="mr-2 h-4 w-4" /> Delete
                                </DropdownMenuItem>
                            </DropdownMenuContent>
                        </DropdownMenu>
                    )
                }
            }
        ];

        return allColumns.filter(col => {
            const key = (col as any).accessorKey;
            if (key === 'avg_price' || key === 'avg_wtd_value') {
                return hasPermission('view:prices');
            }
            return true;
        });
    }, [fontSize, searchField, hasPermission]);

    const table = useReactTable({
        data: allData,
        columns,
        getCoreRowModel: getCoreRowModel(),
        getSortedRowModel: getSortedRowModel(),
        onSortingChange: setSorting,
        state: {
            sorting,
        },
    });

    // Virtualizer
    const tableContainerRef = React.useRef<HTMLDivElement>(null);
    const { rows } = table.getRowModel();
    const rowVirtualizer = useVirtualizer({
        count: rows.length,
        getScrollElement: () => tableContainerRef.current,
        estimateSize: () => rowHeight,
        overscan: 10,
    });

    // Infinite Scroll Trigger
    React.useEffect(() => {
        const [lastItem] = [...rowVirtualizer.getVirtualItems()].reverse();
        if (!lastItem) return;

        if (
            lastItem.index >= rows.length - 1 &&
            hasMore &&
            !isLoadingMore
        ) {
            loadMore();
        }
    }, [
        hasMore,
        isLoadingMore,
        loadMore,
        rowVirtualizer.getVirtualItems(),
        rows.length,
    ]);

    // Status Text
    const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
    const statusText = React.useMemo(() => {
        const count = allData.length;
        const displayYear = (year === 'all' || search) ? 'All Years' : year;

        if (search) {
            return <span>Found <span className="font-semibold text-foreground">{count}</span> results for &ldquo;<span className="font-semibold text-foreground">{search}</span>&rdquo;</span>;
        }
        if (month === 'all') {
            return <span><span className="font-semibold text-foreground">{count}</span> records &middot; <span className="font-semibold text-foreground">{displayYear}</span> (All Months)</span>;
        }
        return <span><span className="font-semibold text-foreground">{count}</span> records &middot; <span className="font-semibold text-foreground">{MONTH_NAMES[parseInt(month)]} {displayYear}</span></span>;
    }, [allData.length, search, month, year]);

    // Count non-price visible columns for footer colSpan
    // DATE + BATCH + BLOCK + WT + PLANT/ETC + BLOCK LOC + REMARKS = 7
    // But WT gets its own cell. So colSpan for "TOTALS" label = columns before WT
    // DATE(1) + BATCH(2) + BLOCK(3) = 3 columns before WT
    const colsBeforeWeight = 3; // DATE, BATCH, BLOCK

    return (
        <TooltipProvider>
            <div className="flex flex-col h-full space-y-4">
                {/* Add Records Dialog */}
                <Dialog open={isAddOpen} onOpenChange={(open) => { if (!open) handleCloseAdd(); }}>
                    <DialogContent
                        onEscapeKeyDown={(e) => e.preventDefault()}
                        onInteractOutside={(e) => e.preventDefault()}
                        className="sm:max-w-[98vw] w-full p-0 overflow-hidden flex flex-col max-h-[95vh] border-none shadow-xl"
                    >
                        <DialogHeader className="p-4 py-2 shrink-0 bg-background border-b z-50 flex flex-row items-center justify-between space-y-0">
                            <div>
                                <DialogTitle>Add Usage Records</DialogTitle>
                                <DialogDescription>
                                    Enter usage details below.
                                </DialogDescription>
                            </div>
                            <Button variant="ghost" size="icon" onClick={handleCloseAdd}>
                                <X className="h-4 w-4" />
                            </Button>
                        </DialogHeader>
                        <div className="flex-1 overflow-auto p-6 pt-2">
                            <BulkUsageInput
                                batches={batches}
                                destinations={destinations}
                                productionBatches={productionBatches}
                                onSuccess={() => setIsAddOpen(false)}
                                onDirtyChange={setIsInputDirty}
                            />
                        </div>
                    </DialogContent>
                </Dialog>

                {/* Edit Records Dialog */}
                <Dialog open={editRows !== null} onOpenChange={(open) => { if (!open) handleCloseEdit(); }}>
                    <DialogContent
                        onEscapeKeyDown={(e) => e.preventDefault()}
                        onInteractOutside={(e) => e.preventDefault()}
                        className="sm:max-w-[98vw] w-full p-0 overflow-hidden flex flex-col max-h-[95vh] border-none shadow-xl"
                    >
                        <DialogHeader className="p-4 py-2 shrink-0 bg-background border-b z-50 flex flex-row items-center justify-between space-y-0">
                            <div>
                                <DialogTitle>Edit Record{editRows?.length === 1 ? '' : 's'}</DialogTitle>
                                <DialogDescription>
                                    Modify usage details below.
                                </DialogDescription>
                            </div>
                            <Button variant="ghost" size="icon" onClick={handleCloseEdit}>
                                <X className="h-4 w-4" />
                            </Button>
                        </DialogHeader>
                        <div className="flex-1 overflow-auto p-6 pt-2">
                            {editRows && (
                                <BulkUsageInput
                                    mode="edit"
                                    initialData={editRows}
                                    batches={batches}
                                    destinations={destinations}
                                    productionBatches={productionBatches}
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
                                <DropdownMenuItem onClick={() => handleFieldChange('batch_code')}>Block</DropdownMenuItem>
                                <DropdownMenuItem onClick={() => handleFieldChange('production_batch')}>Batch</DropdownMenuItem>
                                <DropdownMenuItem onClick={() => handleFieldChange('destination')}>Plant/Etc</DropdownMenuItem>
                                <DropdownMenuItem onClick={() => handleFieldChange('block_loc')}>Block Loc</DropdownMenuItem>
                                <DropdownMenuItem onClick={() => handleFieldChange('remarks')}>Remarks</DropdownMenuItem>
                            </DropdownMenuContent>
                        </DropdownMenu>

                        <div className="relative max-w-sm w-64">
                            <Search className="absolute left-2 top-2.5 h-3 w-3 text-muted-foreground" />
                            <Input
                                placeholder={`Search ${searchField === 'all' ? 'records' : searchField}...`}
                                value={searchTerm}
                                onChange={(event) => handleSearchChange(event.target.value)}
                                onFocus={() => setIsSearchFocused(true)}
                                onBlur={() => setIsSearchFocused(false)}
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
                        Add Record
                    </Button>

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
                    <div className="flex-1 overflow-auto relative w-full h-full" ref={tableContainerRef}>
                        <div className="w-full h-full">
                            <table className="w-full caption-bottom text-sm table-fixed relative border-collapse">
                                <TableHeader className="bg-muted sticky top-0 z-50 shadow-sm border-b">
                                    {table.getHeaderGroups().map((headerGroup) => (
                                        <TableRow key={headerGroup.id} className="hover:bg-transparent border-b" style={{ height: `${rowHeight}px` }}>
                                            {headerGroup.headers.map((header) => {
                                                return (
                                                    <TableHead key={header.id} style={{ width: header.getSize(), height: `${rowHeight}px` }} className="px-1 bg-muted sticky top-0 z-50 font-bold text-foreground border-b border-foreground/20 shadow-none after:absolute after:right-0 after:top-0 after:bottom-0 after:w-px after:bg-foreground/20 last:after:hidden">
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
                                    {rows.length ? (() => {
                                        const virtualRows = rowVirtualizer.getVirtualItems();
                                        const paddingTop = virtualRows.length > 0 ? virtualRows[0].start : 0;
                                        const paddingBottom = virtualRows.length > 0
                                            ? rowVirtualizer.getTotalSize() - virtualRows[virtualRows.length - 1].end
                                            : 0;

                                        return (
                                            <>
                                                {paddingTop > 0 && (
                                                    <tr><td style={{ height: `${paddingTop}px`, padding: 0, border: 0 }} /></tr>
                                                )}
                                                {virtualRows.map((virtualRow) => {
                                                    const row = rows[virtualRow.index];
                                                    const isSelected = selectedIds.has(row.original.id);
                                                    return (
                                                        <TableRow
                                                            key={row.id}
                                                            data-state={isSelected ? "selected" : undefined}
                                                            className={cn(
                                                                "hover:bg-muted/50 border-b last:border-0 transition-colors",
                                                                selectionMode && "cursor-pointer",
                                                                isSelected && "bg-primary/5 hover:bg-primary/10 border-l-2 border-l-primary"
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
                                                })}
                                                {paddingBottom > 0 && (
                                                    <tr><td style={{ height: `${paddingBottom}px`, padding: 0, border: 0 }} /></tr>
                                                )}
                                                {isLoadingMore && (
                                                    <TableRow>
                                                        <TableCell colSpan={columns.length} className="h-12 text-center text-muted-foreground">
                                                            <div className="flex items-center justify-center gap-2">
                                                                <Loader2 className="h-4 w-4 animate-spin" />
                                                                Loading more...
                                                            </div>
                                                        </TableCell>
                                                    </TableRow>
                                                )}
                                            </>
                                        );
                                    })() : (
                                        <TableRow>
                                            <TableCell colSpan={columns.length} className="h-24 text-center">
                                                No results.
                                            </TableCell>
                                        </TableRow>
                                    )}
                                </TableBody>
                                <TableFooter className="bg-muted font-medium sticky bottom-0 z-50 shadow-[0_-4px_6px_-1px_rgba(0,0,0,0.1)] border-t border-border/50">
                                    <TableRow className="hover:bg-muted/50" style={{ height: `${rowHeight}px` }}>
                                        {/* DATE + BATCH + BLOCK = 3 columns */}
                                        <TableCell colSpan={colsBeforeWeight} className="px-2 font-mono font-bold text-right py-0 relative after:absolute after:right-0 after:top-0 after:bottom-0 after:w-px after:bg-foreground/20" style={{ fontSize: `${fontSize}px` }}>
                                            TOTALS
                                        </TableCell>
                                        {/* WT */}
                                        <TableCell className="px-1 text-center font-mono font-bold py-0 relative after:absolute after:right-0 after:top-0 after:bottom-0 after:w-px after:bg-foreground/20" style={{ fontSize: `${fontSize}px` }}>
                                            {Math.round(totalWeight).toLocaleString()}
                                        </TableCell>
                                        {/* PLANT/ETC + BLOCK LOC + REMARKS = 3 empty cells */}
                                        <TableCell className="py-0 relative after:absolute after:right-0 after:top-0 after:bottom-0 after:w-px after:bg-foreground/20" />
                                        <TableCell className="py-0 relative after:absolute after:right-0 after:top-0 after:bottom-0 after:w-px after:bg-foreground/20" />
                                        <TableCell className="py-0 relative after:absolute after:right-0 after:top-0 after:bottom-0 after:w-px after:bg-foreground/20" />
                                        {/* AVG PRICE + AVG VAL (permission-gated) */}
                                        {hasPermission('view:prices') && (
                                            <>
                                                <TableCell className="px-1 font-mono font-bold py-0 relative after:absolute after:right-0 after:top-0 after:bottom-0 after:w-px after:bg-foreground/20" style={{ fontSize: `${fontSize}px` }}>
                                                    <div className="flex items-center justify-between">
                                                        <span className="text-muted-foreground">₱</span>
                                                        <span>{totalAvgPrice.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
                                                    </div>
                                                </TableCell>
                                                <TableCell className="px-1 font-mono font-bold py-0 relative after:absolute after:right-0 after:top-0 after:bottom-0 after:w-px after:bg-foreground/20" style={{ fontSize: `${fontSize}px` }}>
                                                    <div className="flex items-center justify-between">
                                                        <span className="text-muted-foreground">₱</span>
                                                        <span>{totalAvgWtdValue.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
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
                    </div>
                    <DeliverySheetFooter
                        month={month}
                        year={year}
                        onMonthChange={handleMonthChange}
                        onYearChange={handleYearChange}
                        disabled={!!search || isSearchFocused}
                        statusText={statusText}
                    />
                </div>
            </div>
        </TooltipProvider>
    );
}
