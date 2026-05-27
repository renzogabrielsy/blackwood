'use client';

import * as React from 'react';

import { useSearchParams } from 'next/navigation';
import { toast } from 'sonner';
import { errorToast } from '@/lib/toast';
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
import { ArrowUpDown, ChevronsUpDown, Search, MoreHorizontal, Plus, Settings, Trash2, Pencil, X, RefreshCw } from 'lucide-react';
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
    Tooltip,
    TooltipContent,
    TooltipProvider,
    TooltipTrigger,
} from '@/components/ui/tooltip';
import {
    Command,
    CommandEmpty,
    CommandGroup,
    CommandInput,
    CommandItem,
    CommandList,
} from '@/components/ui/command';
import { Checkbox } from '@/components/ui/checkbox';
import { deleteRcOutRecord, bulkDeleteRcOut } from '../actions';
import type { RcOutRow } from '@/types/rc-out';
import { BulkUsageInput } from '../bulk-usage-input';
import { useCellSelection } from '@/lib/hooks/use-cell-selection';
import { useClipboardCopy } from '@/lib/hooks/use-clipboard-copy';
import { useCellAggregation, type AggregationType } from '@/lib/hooks/use-cell-aggregation';
import { useStatusBar } from '@/components/providers/status-bar-context';

const STATE_OPTIONS = ['IN-USE', 'SUNDRYING', 'SUNDRIED', 'CLOSED'];
const STATE_COUNT = STATE_OPTIONS.length;

function getStateClasses(state: string): string {
    switch (state) {
        case 'IN-USE': return 'text-blue-700 bg-blue-200 dark:text-blue-300 dark:bg-blue-900 shadow-sm ring-1 ring-blue-300/60 dark:ring-blue-600/40';
        case 'CLOSED': return 'text-red-700 bg-red-200 dark:text-red-300 dark:bg-red-900 shadow-sm ring-1 ring-red-300/60 dark:ring-red-600/40';
        case 'SUNDRYING': return 'text-amber-700 bg-amber-200 dark:text-amber-300 dark:bg-amber-900 shadow-sm ring-1 ring-amber-300/60 dark:ring-amber-600/40';
        case 'SUNDRIED': return 'text-amber-800 bg-amber-100 dark:text-amber-200 dark:bg-amber-950/50 shadow-sm ring-1 ring-amber-200/60 dark:ring-amber-700/40';
        default: return 'text-muted-foreground bg-muted/10'; // STORED and others
    }
}

function getRowStateClasses(state: string): string {
    switch (state) {
        case 'IN-USE':    return 'bg-blue-100/70 dark:bg-blue-950/40';
        case 'CLOSED':    return 'bg-red-100/70 dark:bg-red-950/40';
        case 'SUNDRYING': return 'bg-amber-100/70 dark:bg-amber-950/40';
        case 'SUNDRIED':  return 'bg-amber-50/70 dark:bg-amber-950/20';
        default:          return ''; // STORED and others — no row highlight
    }
}

type Batch = {
    id: string;
    batch_code: string;
    location_ref: string;
};

export function RcOutTable({
    data,
    batches,
    destinations,
    batchOptions,
    yearOptions,
    blockLocs,
    onRefresh,
}: {
    data: RcOutRow[];
    batches: Batch[];
    destinations: string[];
    batchOptions: string[];
    yearOptions: number[];
    blockLocs: string[];
    onRefresh?: () => Promise<void>;
}) {
    const searchParams = useSearchParams();
    const { fontSize, rowHeight, setFontSize, setRowHeight } = useTableSettings();
    const { hasPermission } = useAuth();
    const { setCellSelectionCount, setCellAggregates } = useStatusBar();

    // Refresh state
    const [refreshing, setRefreshing] = React.useState(false);

    const handleRefresh = React.useCallback(async () => {
        if (!onRefresh) return;
        setRefreshing(true);
        try {
            await onRefresh();
        } finally {
            setRefreshing(false);
        }
    }, [onRefresh]);

    // Client-side search (150ms debounce)
    const [searchTerm, setSearchTerm] = React.useState('');
    const [debouncedSearch, setDebouncedSearch] = React.useState('');
    React.useEffect(() => {
        const t = setTimeout(() => setDebouncedSearch(searchTerm), 150);
        return () => clearTimeout(t);
    }, [searchTerm]);

    // Inclusion-model filter state
    const [selectedBatches, setSelectedBatches] = React.useState<Set<string>>(new Set());
    const [selectedDestinations, setSelectedDestinations] = React.useState<Set<string>>(new Set());
    const [selectedBlockLocs, setSelectedBlockLocs] = React.useState<Set<string>>(new Set());

    // New filter state: STATE (exclusion) and YEAR (inclusion)
    const [stateExcluded, setStateExcluded] = React.useState<Set<string>>(new Set(['CLOSED']));
    const [selectedYears, setSelectedYears] = React.useState<Set<number>>(new Set());

    const hasActiveFilters =
        (stateExcluded.size > 0 && stateExcluded.size < STATE_COUNT) ||
        selectedYears.size > 0 || selectedBatches.size > 0 ||
        selectedDestinations.size > 0 || selectedBlockLocs.size > 0;

    // All data state — synced from props
    const [allData, setAllData] = React.useState<RcOutRow[]>(data);
    React.useEffect(() => { setAllData(data); }, [data]);

    // ─── Auto-Edit from Blocking Panel ───────────────────────────────────
    React.useEffect(() => {
        const params = new URLSearchParams(window.location.search);
        const editBatch = params.get('editBatch');
        if (editBatch && allData.length > 0) {
            // Match by production_batch or batches.batch_code
            const matchingIds = allData
                .filter(d => d.production_batch === editBatch || d.batches?.batch_code === editBatch)
                .map(d => d.id);
            if (matchingIds.length > 0) {
                setSelectionMode(true);
                setSelectedIds(new Set(matchingIds));
                // Trigger bulk edit after a tick
                setTimeout(() => {
                    const matchingRows = allData.filter(d => matchingIds.includes(d.id));
                    setEditRows(matchingRows);
                }, 100);
                // Clean up URL
                params.delete('editBatch');
                const qs = params.toString();
                window.history.replaceState(null, '', window.location.pathname + (qs ? '?' + qs : ''));
            }
        }
    }, [allData]); // eslint-disable-line react-hooks/exhaustive-deps

    // Client-side filtered data (order: STATE > YEAR > BATCH > PLANT/ETC > BLOCK LOC > search)
    const filteredData = React.useMemo(() => {
        let filtered = allData;
        if (stateExcluded.size > 0 && stateExcluded.size < STATE_COUNT)
            filtered = filtered.filter(d => !stateExcluded.has(d.batches?.status || 'STORED'));
        if (selectedYears.size > 0)
            filtered = filtered.filter(d => selectedYears.has(parseInt(d.transaction_date?.slice(0, 4))));
        if (selectedBatches.size > 0)
            filtered = filtered.filter(d => selectedBatches.has(d.production_batch));
        if (selectedDestinations.size > 0)
            filtered = filtered.filter(d => selectedDestinations.has(d.destination));
        if (selectedBlockLocs.size > 0)
            filtered = filtered.filter(d => selectedBlockLocs.has(d.block_loc || d.batches?.location_ref || ''));
        if (debouncedSearch) {
            const term = debouncedSearch.toLowerCase();
            filtered = filtered.filter(d =>
                [d.production_batch, d.destination, d.block_loc, d.remarks, d.batches?.batch_code, d.transaction_date]
                    .some(f => (f || '').toLowerCase().includes(term))
            );
        }
        return filtered;
    }, [allData, stateExcluded, selectedYears, selectedBatches, selectedDestinations, selectedBlockLocs, debouncedSearch]);

    // Footer totals (computed from filteredData)
    const { totalWeight, totalAvgPrice, totalAvgWtdValue } = React.useMemo(() => {
        let tw = 0, sumPrice = 0, sumVal = 0, countPrice = 0;
        filteredData.forEach(d => {
            tw += d.weight_kg || 0;
            if (d.avg_price) { sumPrice += d.avg_price * (d.weight_kg || 0); countPrice += d.weight_kg || 0; }
            sumVal += d.avg_wtd_value || 0;
        });
        return {
            totalWeight: tw,
            totalAvgPrice: countPrice > 0 ? sumPrice / countPrice : 0,
            totalAvgWtdValue: sumVal,
        };
    }, [filteredData]);

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
                await handleRefresh();
            } else {
                errorToast('Delete failed: ' + res.message);
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
                await handleRefresh();
            } else {
                errorToast('Bulk delete failed: ' + res.message);
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

    // Filter helpers
    const toggleFilter = React.useCallback((setter: React.Dispatch<React.SetStateAction<Set<string>>>, value: string) => {
        setter(prev => {
            const next = new Set(prev);
            if (next.has(value)) next.delete(value);
            else next.add(value);
            return next;
        });
    }, []);

    const clearAllFilters = React.useCallback(() => {
        setStateExcluded(new Set(['CLOSED']));
        setSelectedYears(new Set());
        setSelectedBatches(new Set());
        setSelectedDestinations(new Set());
        setSelectedBlockLocs(new Set());
    }, []);

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
                id: 'state',
                header: () => <div className="text-center px-1 font-mono font-bold">STATE</div>,
                size: 55,
                cell: ({ row }) => {
                    const status = row.original.batches?.status || 'STORED';
                    return (
                        <Tooltip>
                            <TooltipTrigger asChild>
                                <div className="flex items-center justify-center">
                                    <span className={cn(
                                        "inline-block px-1.5 py-0.5 rounded text-[10px] font-mono font-bold leading-none",
                                        getStateClasses(status)
                                    )}>
                                        {status}
                                    </span>
                                </div>
                            </TooltipTrigger>
                            <TooltipContent side="top">Batch status: {status}</TooltipContent>
                        </Tooltip>
                    );
                },
            },
            {
                accessorKey: 'production_batch',
                header: () => <div className="text-center px-1 font-mono font-bold">BATCH</div>,
                size: 80,
                cell: ({ row }) => row.original.production_batch ? (
                    <Tooltip>
                        <TooltipTrigger asChild>
                            <div className="truncate text-center font-bold font-mono" style={{ fontSize: `${fontSize}px` }}>{row.original.production_batch}</div>
                        </TooltipTrigger>
                        <TooltipContent side="top" className="max-w-xs">{row.original.production_batch}</TooltipContent>
                    </Tooltip>
                ) : <div className="truncate text-center font-bold font-mono" style={{ fontSize: `${fontSize}px` }} />
            },
            {
                id: 'batch_code',
                accessorKey: 'batches.batch_code',
                header: () => <div className="text-center px-1 font-mono font-bold">BLOCK</div>,
                size: 80,
                cell: ({ row }) => row.original.batches?.batch_code ? (
                    <Tooltip>
                        <TooltipTrigger asChild>
                            <div className="truncate text-center font-bold font-mono" style={{ fontSize: `${fontSize}px` }}>{row.original.batches.batch_code}</div>
                        </TooltipTrigger>
                        <TooltipContent side="top" className="max-w-xs">{row.original.batches.batch_code}</TooltipContent>
                    </Tooltip>
                ) : <div className="truncate text-center font-bold font-mono" style={{ fontSize: `${fontSize}px` }}>-</div>
            },
            {
                accessorKey: 'weight_kg',
                header: () => <div className="text-center px-1 font-mono font-bold">WT</div>,
                size: 60,
                cell: ({ row }) => <div className="text-center font-mono font-bold" style={{ fontSize: `${fontSize}px` }}>{row.original.weight_kg?.toLocaleString()}</div>
            },
            {
                accessorKey: 'destination',
                header: () => <div className="text-center px-1 font-mono font-bold">PLANT/ETC</div>,
                size: 100,
                cell: ({ row }) => row.original.destination ? (
                    <Tooltip>
                        <TooltipTrigger asChild>
                            <div className="truncate text-left font-bold" style={{ fontSize: `${fontSize}px` }}>{row.original.destination}</div>
                        </TooltipTrigger>
                        <TooltipContent side="top" className="max-w-xs">{row.original.destination}</TooltipContent>
                    </Tooltip>
                ) : <div className="truncate text-left font-bold" style={{ fontSize: `${fontSize}px` }} />
            },
            {
                accessorKey: 'block_loc',
                header: () => <div className="text-center px-1 font-mono font-bold">BLOCK LOC</div>,
                size: 80,
                cell: ({ row }) => {
                    const loc = row.original.block_loc || row.original.batches?.location_ref || '';
                    return loc ? (
                        <Tooltip>
                            <TooltipTrigger asChild>
                                <div className="truncate text-center font-mono" style={{ fontSize: `${fontSize}px` }}>{loc}</div>
                            </TooltipTrigger>
                            <TooltipContent side="top" className="max-w-xs">{loc}</TooltipContent>
                        </Tooltip>
                    ) : <div className="truncate text-center font-mono" style={{ fontSize: `${fontSize}px` }} />;
                }
            },
            {
                accessorKey: 'remarks',
                header: () => <div className="text-center px-1 font-mono font-bold">REMARKS</div>,
                size: 120,
                cell: ({ row }) => row.original.remarks ? (
                    <Tooltip>
                        <TooltipTrigger asChild>
                            <span className="max-w-[120px] truncate block text-xs text-muted-foreground" style={{ fontSize: `${fontSize}px` }}>{row.original.remarks}</span>
                        </TooltipTrigger>
                        <TooltipContent side="top" className="max-w-xs">{row.original.remarks}</TooltipContent>
                    </Tooltip>
                ) : null
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
            const key = 'accessorKey' in col ? col.accessorKey : undefined;
            if (key === 'avg_price' || key === 'avg_wtd_value') {
                return hasPermission('view:prices');
            }
            return true;
        });
    }, [fontSize, hasPermission]);

    const table = useReactTable({
        data: filteredData,
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

    // --- Cell selection for copy-paste ---
    const visibleColumns = table.getAllColumns().filter(c => c.getIsVisible());
    const cellSelection = useCellSelection({
        rowCount: rows.length,
        colCount: visibleColumns.length,
        isSelectableColumn: (colIdx) => {
            const col = visibleColumns[colIdx];
            return col ? col.id !== 'actions' : false;
        },
        scrollContainerRef: tableContainerRef,
        enabled: !selectionMode,
    });

    const selectionSize = cellSelection.getSelectionSize();

    const getCellValue = React.useCallback((rowIdx: number, colIdx: number): string => {
        const row = rows[rowIdx];
        if (!row) return '';
        const data = row.original;
        const col = visibleColumns[colIdx];
        if (!col) return '';

        const colId = col.id || ('accessorKey' in col.columnDef ? col.columnDef.accessorKey as string : '');

        switch (colId) {
            case 'transaction_date': return data.transaction_date || '';
            case 'state': return data.batches?.status || 'STORED';
            case 'production_batch': return data.production_batch || '';
            case 'batch_code':
            case 'batches.batch_code': return data.batches?.batch_code || '';
            case 'weight_kg': return data.weight_kg != null ? data.weight_kg.toLocaleString() : '';
            case 'destination': return data.destination || '';
            case 'block_loc': return data.block_loc || data.batches?.location_ref || '';
            case 'remarks': return data.remarks || '';
            case 'avg_price': return data.avg_price != null ? data.avg_price.toFixed(2) : '';
            case 'avg_wtd_value': return data.avg_wtd_value != null ? data.avg_wtd_value.toFixed(2) : '';
            default: return '';
        }
    }, [rows, visibleColumns]);

    const getNumericCellValue = React.useCallback((rowIdx: number, colIdx: number): number | null => {
        const row = rows[rowIdx];
        if (!row) return null;
        const data = row.original;
        const col = visibleColumns[colIdx];
        if (!col) return null;
        const colId = col.id || ('accessorKey' in col.columnDef ? col.columnDef.accessorKey as string : '');
        switch (colId) {
            case 'weight_kg': return data.weight_kg ?? null;
            case 'avg_price': return data.avg_price ?? null;
            case 'avg_wtd_value': return data.avg_wtd_value ?? null;
            default: return null;
        }
    }, [rows, visibleColumns]);

    const getColumnDefaultCalcType = React.useCallback((colIdx: number): AggregationType | null => {
        const col = visibleColumns[colIdx];
        if (!col) return null;
        const colId = col.id || ('accessorKey' in col.columnDef ? col.columnDef.accessorKey as string : '');
        switch (colId) {
            case 'weight_kg':
            case 'avg_wtd_value':
                return 'SUM';
            case 'avg_price':
                return 'AVERAGE';
            default: return null;
        }
    }, [visibleColumns]);

    const aggregates = useCellAggregation({ range: cellSelection.range, getNumericCellValue, getColumnDefaultCalcType });

    // Push cell selection count + aggregates to shared context with debounce to reduce status bar re-renders during drag
    React.useEffect(() => {
        const count = cellSelection.range && !selectionMode ? selectionSize : 0;

        // Debounce by 50ms to prevent excessive updates during drag selection
        const timer = setTimeout(() => {
            setCellSelectionCount(count);
            setCellAggregates(count > 1 ? aggregates : null);
        }, 50);

        return () => clearTimeout(timer);
    }, [cellSelection.range, selectionMode, selectionSize, setCellSelectionCount, setCellAggregates, aggregates]);

    const { handleKeyDown: handleCopyKeyDown } = useClipboardCopy({
        getSelectedRange: cellSelection.getSelectedRange,
        getCellValue,
        getSelectionSize: cellSelection.getSelectionSize,
        enabled: !selectionMode,
    });

    // Clear cell selection when data/sorting changes
    React.useEffect(() => { cellSelection.clearSelection(); }, [allData]);
    React.useEffect(() => { cellSelection.clearSelection(); }, [sorting]);

    // Clear cell selection when clicking outside the scroll container
    React.useEffect(() => {
        if (!cellSelection.range) return;

        const handleClickOutside = (e: MouseEvent) => {
            const container = tableContainerRef.current;
            if (container && !container.contains(e.target as Node)) {
                const target = e.target as HTMLElement;
                // Don't clear selection when clicking the floating status bar or its popover
                if (target.closest?.('[data-floating-status-bar]') || target.closest?.('[data-radix-popper-content-wrapper]')) return;
                cellSelection.clearSelection();
            }
        };

        document.addEventListener('mousedown', handleClickOutside);
        return () => document.removeEventListener('mousedown', handleClickOutside);
    }, [cellSelection.range, cellSelection.clearSelection]);

    // Clear cell selection on Escape key (global listener so it works regardless of focus)
    React.useEffect(() => {
        if (!cellSelection.range) return;

        const handleEscape = (e: KeyboardEvent) => {
            if (e.key === 'Escape') {
                cellSelection.clearSelection();
            }
        };

        document.addEventListener('keydown', handleEscape);
        return () => document.removeEventListener('keydown', handleEscape);
    }, [cellSelection.range, cellSelection.clearSelection]);

    const rowVirtualizer = useVirtualizer({
        count: rows.length,
        getScrollElement: () => tableContainerRef.current,
        estimateSize: () => rowHeight,
        overscan: 10,
    });

    // Count non-price visible columns for footer colSpan
    // DATE + STATE + BATCH + BLOCK = 4 columns before WT
    const colsBeforeWeight = 4;

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
                        <DialogHeader className="p-4 py-2 shrink-0 bg-background/90 backdrop-blur-sm border-b z-50 flex flex-row items-center justify-between space-y-0">
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
                                productionBatches={batchOptions}
                                onSuccess={async () => {
                                    setIsAddOpen(false);
                                    await handleRefresh();
                                }}
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
                        <DialogHeader className="p-4 py-2 shrink-0 bg-background/90 backdrop-blur-sm border-b z-50 flex flex-row items-center justify-between space-y-0">
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
                                    productionBatches={batchOptions}
                                    onSuccess={async () => {
                                        setEditRows(null);
                                        setSelectedIds(new Set());
                                        await handleRefresh();
                                    }}
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
                        {/* Search */}
                        <div className="relative max-w-sm w-56">
                            <Search className="absolute left-2 top-2.5 h-3 w-3 text-muted-foreground" />
                            <Input
                                placeholder="Search records..."
                                value={searchTerm}
                                onChange={(e) => setSearchTerm(e.target.value)}
                                className="pl-8 h-8 text-xs font-mono"
                            />
                        </div>

                        {/* BATCH filter (inclusion model) */}
                        <Popover>
                            <PopoverTrigger asChild>
                                <Button variant="outline" className={cn(
                                    "h-8 w-auto min-w-[70px] text-xs font-mono px-2",
                                    selectedBatches.size > 0 && "border-primary bg-primary/5"
                                )}>
                                    {selectedBatches.size === 0
                                        ? 'Batch'
                                        : `Batch (${selectedBatches.size})`}
                                    {selectedBatches.size > 0 ? (
                                        <span
                                            onClick={(e) => { e.stopPropagation(); setSelectedBatches(new Set()); }}
                                            className="ml-1 rounded-full p-0.5 hover:bg-muted"
                                        >
                                            <X className="h-3 w-3" />
                                        </span>
                                    ) : (
                                        <ChevronsUpDown className="ml-1 h-3 w-3 shrink-0 opacity-50" />
                                    )}
                                </Button>
                            </PopoverTrigger>
                            <PopoverContent className="w-[220px] p-0" align="start">
                                {selectedBatches.size > 0 && (
                                    <div className="flex items-center justify-end px-2 pt-2 pb-1 border-b">
                                        <button onClick={() => setSelectedBatches(new Set())} className="text-[10px] text-muted-foreground hover:text-foreground">Clear</button>
                                    </div>
                                )}
                                <Command>
                                    <CommandInput placeholder="Search batches..." className="text-xs" />
                                    <CommandList>
                                        <CommandEmpty>No batch found.</CommandEmpty>
                                        <CommandGroup>
                                            {batchOptions.map(code => (
                                                <CommandItem
                                                    key={code}
                                                    value={code}
                                                    onSelect={() => toggleFilter(setSelectedBatches, code)}
                                                    className="text-xs font-mono"
                                                >
                                                    <Checkbox checked={selectedBatches.has(code)} className="mr-2 h-3.5 w-3.5" />
                                                    {code}
                                                </CommandItem>
                                            ))}
                                        </CommandGroup>
                                    </CommandList>
                                </Command>
                            </PopoverContent>
                        </Popover>

                        {/* YEAR filter (inclusion model) */}
                        <Popover>
                            <PopoverTrigger asChild>
                                <Button variant="outline" className={cn(
                                    "h-8 w-auto min-w-[60px] text-xs font-mono px-2",
                                    selectedYears.size > 0 && "border-primary bg-primary/5"
                                )}>
                                    {selectedYears.size === 0
                                        ? 'Year'
                                        : `Year (${selectedYears.size})`}
                                    {selectedYears.size > 0 ? (
                                        <span
                                            onClick={(e) => { e.stopPropagation(); setSelectedYears(new Set()); }}
                                            className="ml-1 rounded-full p-0.5 hover:bg-muted"
                                        >
                                            <X className="h-3 w-3" />
                                        </span>
                                    ) : (
                                        <ChevronsUpDown className="ml-1 h-3 w-3 shrink-0 opacity-50" />
                                    )}
                                </Button>
                            </PopoverTrigger>
                            <PopoverContent className="w-[140px] p-2" align="start">
                                {selectedYears.size > 0 && (
                                    <div className="flex items-center justify-end pb-1 mb-1 border-b">
                                        <button onClick={() => setSelectedYears(new Set())} className="text-[10px] text-muted-foreground hover:text-foreground">Clear</button>
                                    </div>
                                )}
                                <div className="space-y-1">
                                    {yearOptions.map(yr => (
                                        <label key={yr} className="flex items-center gap-2 px-1 py-0.5 rounded hover:bg-muted cursor-pointer text-xs font-mono">
                                            <Checkbox
                                                checked={selectedYears.has(yr)}
                                                onCheckedChange={() => {
                                                    setSelectedYears(prev => {
                                                        const next = new Set(prev);
                                                        if (next.has(yr)) next.delete(yr);
                                                        else next.add(yr);
                                                        return next;
                                                    });
                                                }}
                                                className="h-3.5 w-3.5"
                                            />
                                            {yr}
                                        </label>
                                    ))}
                                </div>
                            </PopoverContent>
                        </Popover>

                        {/* STATE filter (exclusion model) */}
                        <Popover>
                            <PopoverTrigger asChild>
                                <Button variant="outline" className={cn(
                                    "h-8 w-auto min-w-[60px] text-xs font-mono px-2",
                                    stateExcluded.size > 0 && stateExcluded.size < STATE_COUNT && "border-primary bg-primary/5"
                                )}>
                                    {stateExcluded.size === 0 || stateExcluded.size >= STATE_COUNT
                                        ? 'State'
                                        : `State (-${stateExcluded.size})`}
                                    {stateExcluded.size > 0 && stateExcluded.size < STATE_COUNT ? (
                                        <span
                                            onClick={(e) => { e.stopPropagation(); setStateExcluded(new Set()); }}
                                            className="ml-1 rounded-full p-0.5 hover:bg-muted"
                                        >
                                            <X className="h-3 w-3" />
                                        </span>
                                    ) : (
                                        <ChevronsUpDown className="ml-1 h-3 w-3 shrink-0 opacity-50" />
                                    )}
                                </Button>
                            </PopoverTrigger>
                            <PopoverContent className="w-[180px] p-2" align="start">
                                <div className="flex items-center justify-between pb-1 mb-1 border-b">
                                    <button onClick={() => setStateExcluded(new Set())} className="text-[10px] text-muted-foreground hover:text-foreground">Show All</button>
                                    <button onClick={() => setStateExcluded(new Set(STATE_OPTIONS))} className="text-[10px] text-muted-foreground hover:text-foreground">Hide All</button>
                                </div>
                                <div className="space-y-1">
                                    {STATE_OPTIONS.map(state => (
                                        <label key={state} className="flex items-center gap-2 px-1 py-0.5 rounded hover:bg-muted cursor-pointer text-xs font-mono">
                                            <Checkbox
                                                checked={!stateExcluded.has(state)}
                                                onCheckedChange={() => {
                                                    setStateExcluded(prev => {
                                                        const next = new Set(prev);
                                                        if (next.has(state)) next.delete(state);
                                                        else next.add(state);
                                                        return next;
                                                    });
                                                }}
                                                className="h-3.5 w-3.5"
                                            />
                                            <span className={cn(
                                                "inline-block px-1.5 py-0.5 rounded text-[10px] font-mono font-bold leading-none",
                                                getStateClasses(state)
                                            )}>
                                                {state}
                                            </span>
                                        </label>
                                    ))}
                                </div>
                            </PopoverContent>
                        </Popover>

                        {/* PLANT/ETC filter (inclusion model) */}
                        <Popover>
                            <PopoverTrigger asChild>
                                <Button variant="outline" className={cn(
                                    "h-8 w-auto min-w-[80px] text-xs font-mono px-2",
                                    selectedDestinations.size > 0 && "border-primary bg-primary/5"
                                )}>
                                    {selectedDestinations.size === 0
                                        ? 'Plant/Etc'
                                        : `Plant/Etc (${selectedDestinations.size})`}
                                    {selectedDestinations.size > 0 ? (
                                        <span
                                            onClick={(e) => { e.stopPropagation(); setSelectedDestinations(new Set()); }}
                                            className="ml-1 rounded-full p-0.5 hover:bg-muted"
                                        >
                                            <X className="h-3 w-3" />
                                        </span>
                                    ) : (
                                        <ChevronsUpDown className="ml-1 h-3 w-3 shrink-0 opacity-50" />
                                    )}
                                </Button>
                            </PopoverTrigger>
                            <PopoverContent className="w-[220px] p-0" align="start">
                                {selectedDestinations.size > 0 && (
                                    <div className="flex items-center justify-end px-2 pt-2 pb-1 border-b">
                                        <button onClick={() => setSelectedDestinations(new Set())} className="text-[10px] text-muted-foreground hover:text-foreground">Clear</button>
                                    </div>
                                )}
                                <Command>
                                    <CommandInput placeholder="Search destinations..." className="text-xs" />
                                    <CommandList>
                                        <CommandEmpty>No destination found.</CommandEmpty>
                                        <CommandGroup>
                                            {destinations.map(d => (
                                                <CommandItem
                                                    key={d}
                                                    value={d}
                                                    onSelect={() => toggleFilter(setSelectedDestinations, d)}
                                                    className="text-xs font-mono"
                                                >
                                                    <Checkbox checked={selectedDestinations.has(d)} className="mr-2 h-3.5 w-3.5" />
                                                    {d}
                                                </CommandItem>
                                            ))}
                                        </CommandGroup>
                                    </CommandList>
                                </Command>
                            </PopoverContent>
                        </Popover>

                        {/* BLOCK LOC filter (inclusion model) */}
                        <Popover>
                            <PopoverTrigger asChild>
                                <Button variant="outline" className={cn(
                                    "h-8 w-auto min-w-[80px] text-xs font-mono px-2",
                                    selectedBlockLocs.size > 0 && "border-primary bg-primary/5"
                                )}>
                                    {selectedBlockLocs.size === 0
                                        ? 'Block Loc'
                                        : `Block Loc (${selectedBlockLocs.size})`}
                                    {selectedBlockLocs.size > 0 ? (
                                        <span
                                            onClick={(e) => { e.stopPropagation(); setSelectedBlockLocs(new Set()); }}
                                            className="ml-1 rounded-full p-0.5 hover:bg-muted"
                                        >
                                            <X className="h-3 w-3" />
                                        </span>
                                    ) : (
                                        <ChevronsUpDown className="ml-1 h-3 w-3 shrink-0 opacity-50" />
                                    )}
                                </Button>
                            </PopoverTrigger>
                            <PopoverContent className="w-[180px] p-0" align="start">
                                {selectedBlockLocs.size > 0 && (
                                    <div className="flex items-center justify-end px-2 pt-2 pb-1 border-b">
                                        <button onClick={() => setSelectedBlockLocs(new Set())} className="text-[10px] text-muted-foreground hover:text-foreground">Clear</button>
                                    </div>
                                )}
                                <Command>
                                    <CommandInput placeholder="Search locations..." className="text-xs" />
                                    <CommandList>
                                        <CommandEmpty>No location found.</CommandEmpty>
                                        <CommandGroup>
                                            {blockLocs.map(l => (
                                                <CommandItem
                                                    key={l}
                                                    value={l}
                                                    onSelect={() => toggleFilter(setSelectedBlockLocs, l)}
                                                    className="text-xs font-mono"
                                                >
                                                    <Checkbox checked={selectedBlockLocs.has(l)} className="mr-2 h-3.5 w-3.5" />
                                                    {l}
                                                </CommandItem>
                                            ))}
                                        </CommandGroup>
                                    </CommandList>
                                </Command>
                            </PopoverContent>
                        </Popover>

                        {/* Clear all filters */}
                        {hasActiveFilters && (
                            <Button
                                variant="ghost"
                                size="sm"
                                className="h-8 px-2 text-xs text-muted-foreground hover:text-foreground"
                                onClick={clearAllFilters}
                            >
                                <X className="mr-1 h-3 w-3" />
                                Clear
                            </Button>
                        )}
                    </div>

                    <div className="flex items-center gap-1.5">
                        <Button
                            variant={selectionMode ? "default" : "outline"}
                            size="sm"
                            className="h-8 gap-1"
                            onClick={() => {
                                setSelectionMode(prev => !prev);
                                if (selectionMode) setSelectedIds(new Set());
                                else cellSelection.clearSelection();
                            }}
                        >
                            Select
                        </Button>
                        <Button onClick={() => setIsAddOpen(true)} size="sm" className="h-8 gap-1">
                            <Plus className="h-4 w-4" />
                            Add Record
                        </Button>

                        <Tooltip>
                            <TooltipTrigger asChild>
                                <Button
                                    variant="ghost"
                                    size="icon"
                                    className="h-8 w-8"
                                    onClick={handleRefresh}
                                    disabled={refreshing}
                                >
                                    <RefreshCw className={cn("h-3.5 w-3.5", refreshing && "animate-spin")} />
                                </Button>
                            </TooltipTrigger>
                            <TooltipContent side="bottom">Refresh data</TooltipContent>
                        </Tooltip>

                        <Popover>
                            <PopoverTrigger asChild>
                                <Button variant="ghost" size="icon" className="h-8 w-8">
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
                </div>

                {/* Floating Action Bar */}
                {selectionMode && (
                    <div className="flex-none flex items-center gap-3 px-3 py-1.5 rounded-md border bg-muted/50 text-sm animate-fade-up">
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
                    <div
                        className="flex-1 overflow-auto relative w-full outline-none select-none"
                        ref={tableContainerRef}
                        tabIndex={-1}
                        onKeyDown={(e) => {
                            cellSelection.handleKeyDown(e);
                            handleCopyKeyDown(e);
                        }}
                    >
                        <div className="w-full h-full">
                            <table className="w-full caption-bottom text-sm table-fixed relative border-collapse">
                                <TableHeader className="bg-muted/90 backdrop-blur-sm sticky top-0 z-50 shadow-sm border-b">
                                    {table.getHeaderGroups().map((headerGroup) => (
                                        <TableRow key={headerGroup.id} className="hover:bg-transparent border-b" style={{ height: `${rowHeight}px` }}>
                                            {headerGroup.headers.map((header) => {
                                                return (
                                                    <TableHead key={header.id} style={{ width: header.getSize(), height: `${rowHeight}px` }} className="px-1 bg-muted/90 sticky top-0 z-50 font-bold text-foreground border-b border-foreground/20 shadow-none after:absolute after:right-0 after:top-0 after:bottom-0 after:w-px after:bg-foreground/20 last:after:hidden">
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
                                                                "hover:bg-muted/50 border-b last:border-0 transition-all duration-150 animate-row-fade",
                                                                getRowStateClasses(row.original.batches?.status || 'STORED'),
                                                                selectionMode && "cursor-pointer",
                                                                isSelected && "bg-primary/5 hover:bg-primary/10 border-l-2 border-l-primary"
                                                            )}
                                                            style={{ height: `${rowHeight}px` }}
                                                            onClick={selectionMode ? () => toggleSelect(row.original.id) : undefined}
                                                        >
                                                            {row.getVisibleCells().map((cell, cellIndex) => (
                                                                <TableCell
                                                                    key={cell.id}
                                                                    className={cn(
                                                                        "px-1 py-0 border-r last:border-0",
                                                                        !selectionMode && cellSelection.isSelected(virtualRow.index, cellIndex) && "bg-primary/10 dark:bg-primary/20",
                                                                        !selectionMode && cellSelection.isAnchor(virtualRow.index, cellIndex) && "ring-2 ring-primary ring-inset"
                                                                    )}
                                                                    style={{ height: `${rowHeight}px` }}
                                                                    onClick={cell.column.id === 'actions' ? (e) => e.stopPropagation() : undefined}
                                                                    onMouseDown={cell.column.id !== 'actions' && !selectionMode ? (e) => {
                                                                        e.preventDefault();
                                                                        cellSelection.handleCellMouseDown(virtualRow.index, cellIndex, e);
                                                                        tableContainerRef.current?.focus({ preventScroll: true });
                                                                    } : undefined}
                                                                    onMouseEnter={cellSelection.isDragging && !selectionMode ? () => cellSelection.handleCellMouseEnter(virtualRow.index, cellIndex) : undefined}
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
                                            </>
                                        );
                                    })() : (
                                        <TableRow>
                                            <TableCell colSpan={columns.length} className="h-24 text-center">
                                                <span className="animate-fade-up text-muted-foreground">No results.</span>
                                            </TableCell>
                                        </TableRow>
                                    )}
                                </TableBody>
                                {hasActiveFilters && (
                                    <TableFooter className="bg-muted/90 backdrop-blur-sm font-medium sticky bottom-0 z-50 shadow-[0_-4px_6px_-1px_rgba(0,0,0,0.1)] border-t border-border/50 animate-slide-up">
                                        <TableRow className="hover:bg-muted/50" style={{ height: `${rowHeight}px` }}>
                                            {/* DATE + STATE + BATCH + BLOCK = 4 columns */}
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
                                )}
                            </table>
                        </div>
                    </div>
                </div>


            </div>
        </TooltipProvider>
    );
}
