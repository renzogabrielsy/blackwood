
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
import { useVirtualizer } from '@tanstack/react-virtual';
import { useRouter, usePathname, useSearchParams } from 'next/navigation';
import { ArrowUpDown, ChevronsUpDown, Search, MoreHorizontal, Pencil, Trash2, MessageSquareText, Plus, Settings, X, Loader2, Clock, SlidersHorizontal } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
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
    Command,
    CommandEmpty,
    CommandGroup,
    CommandInput,
    CommandItem,
    CommandList,
} from '@/components/ui/command';
import {
    TooltipProvider,
} from '@/components/ui/tooltip';
import { deleteDelivery, bulkDeleteDeliveries } from './actions';
import { calculateWhse } from '@/lib/rc-utils';
import type { DeliveryHistoryRow } from '@/types/rc-in';

export type { DeliveryHistoryRow };
import { BulkDeliveryInput } from './bulk-delivery-input';
import { DeliverySheetFooter } from './components/DeliverySheetFooter';
import { DeliveryHistoryDialog } from './components/DeliveryHistoryDialog';

function getStateClasses(state: string): string {
    switch (state) {
        case 'IN-USE': return 'text-blue-700 bg-blue-200 dark:text-blue-300 dark:bg-blue-900 shadow-sm ring-1 ring-blue-300/60 dark:ring-blue-600/40';
        case 'CLOSED': return 'text-red-700 bg-red-200 dark:text-red-300 dark:bg-red-900 shadow-sm ring-1 ring-red-300/60 dark:ring-red-600/40';
        case 'SUNDRYING': return 'text-amber-700 bg-amber-200 dark:text-amber-300 dark:bg-amber-900 shadow-sm ring-1 ring-amber-300/60 dark:ring-amber-600/40';
        default: return 'text-muted-foreground bg-muted/10'; // STORED
    }
}

function getRowStateClasses(state: string): string {
    switch (state) {
        case 'IN-USE':    return 'bg-blue-100/70 dark:bg-blue-950/40';
        case 'CLOSED':    return 'bg-red-100/70 dark:bg-red-950/40';
        case 'SUNDRYING': return 'bg-amber-100/70 dark:bg-amber-950/40';
        default:          return ''; // STORED — no row highlight
    }
}

const LAB_COLUMNS: { key: string; label: string; decimals: number }[] = [
    { key: 'mc', label: 'MC', decimals: 2 },
    { key: 'grit', label: 'GRIT', decimals: 2 },
    { key: 'bd_astm', label: 'ASTM', decimals: 3 },
    { key: 'bd_jis', label: 'JIS', decimals: 3 },
    { key: 'vm', label: 'VM', decimals: 2 },
    { key: 'ash', label: 'ASH', decimals: 2 },
    { key: 'fc', label: 'FC', decimals: 2 },
];

const formatCompact = (value: number, decimals: number = 2): string => {
    const abs = Math.abs(value);
    if (abs >= 1e12) return (value / 1e12).toFixed(decimals) + 't';
    if (abs >= 1e9) return (value / 1e9).toFixed(decimals) + 'b';
    if (abs >= 1e6) return (value / 1e6).toFixed(decimals) + 'm';
    if (abs >= 1e3) return (value / 1e3).toFixed(decimals) + 'k';
    return value.toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
};

export function DeliveryMasterTable({ data, batches, search, allSuppliers, allLocations }: { data: DeliveryHistoryRow[], batches: any[], search?: string, allSuppliers: string[], allLocations: string[] }) {
    const { fontSize, rowHeight, setFontSize, setRowHeight } = useTableSettings();
    const { user, role, hasPermission } = useAuth();
    const router = useRouter();
    const pathname = usePathname();
    const searchParams = useSearchParams();

    const [month, setMonth] = React.useState<string>(() => searchParams.get('m') || String(new Date().getMonth()));

    // Ref to save the user's year+month before header filters auto-switch to All Years
    const preFilterDate = React.useRef<{ year: string; month: string } | null>(null);

    // Header bar filter state — exclusion sets initialized from URL params to survive Suspense remounts
    // STATE defaults to excluding CLOSED on fresh load (no sx param) so users see active inventory first.
    // Sentinel value '_all' in URL means "user explicitly cleared the filter" (show all states).
    // Absent sx param means "fresh load, apply default exclusion".
    const STATE_DEFAULT_EXCLUDED = ['CLOSED'];
    const [stateExcluded, setStateExcluded] = React.useState<Set<string>>(() => {
        const param = searchParams.get('sx');
        if (param === '_all') return new Set();        // user explicitly cleared — show all
        if (param) return new Set(param.split(','));   // user-set exclusions
        return new Set(STATE_DEFAULT_EXCLUDED);        // fresh load — exclude CLOSED
    });
    const [whseExcluded, setWhseExcluded] = React.useState<Set<string>>(() => {
        const param = searchParams.get('wx');
        return param ? new Set(param.split(',')) : new Set();
    });
    // Supplier & LOC use INCLUSION model: empty set = show all (no filter), non-empty = show ONLY those values
    const [supIncluded, setSupIncluded] = React.useState<Set<string>>(() => {
        const param = searchParams.get('sup');
        return param ? new Set(param.split(',')) : new Set();
    });
    const [locIncluded, setLocIncluded] = React.useState<Set<string>>(() => {
        const param = searchParams.get('loc');
        return param ? new Set(param.split(',')) : new Set();
    });

    // Silently sync a param to URL without triggering Next.js navigation
    const syncParamToUrl = React.useCallback((key: string, value: string, defaultVal: string = 'all') => {
        const params = new URLSearchParams(window.location.search);
        if (value !== defaultVal) params.set(key, value);
        else params.delete(key);
        const qs = params.toString();
        window.history.replaceState(null, '', qs ? pathname + '?' + qs : pathname);
    }, [pathname]);

    const syncExclusionToUrl = React.useCallback((key: string, excluded: Set<string>) => {
        const params = new URLSearchParams(window.location.search);
        if (excluded.size > 0) {
            params.set(key, [...excluded].join(','));
        } else if (key === 'sx') {
            // Sentinel: distinguish "user cleared filter" from "fresh load (apply default)"
            params.set(key, '_all');
        } else {
            params.delete(key);
        }
        const qs = params.toString();
        window.history.replaceState(null, '', qs ? pathname + '?' + qs : pathname);
    }, [pathname]);

    // Silently sync an inclusion set to URL (non-empty = set param, empty = delete param)
    const syncInclusionToUrl = React.useCallback((key: string, included: Set<string>) => {
        const params = new URLSearchParams(window.location.search);
        if (included.size > 0) {
            params.set(key, [...included].join(','));
        } else {
            params.delete(key);
        }
        const qs = params.toString();
        window.history.replaceState(null, '', qs ? pathname + '?' + qs : pathname);
    }, [pathname]);

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
    const [historyDelivery, setHistoryDelivery] = React.useState<DeliveryHistoryRow | null>(null);
    const [historyOpen, setHistoryOpen] = React.useState(false);

    // Column visibility — persisted to localStorage
    const [hiddenColumns, setHiddenColumns] = React.useState<Set<string>>(() => {
        if (typeof window === 'undefined') return new Set();
        try {
            const saved = localStorage.getItem('rc-in-hidden-columns');
            return saved ? new Set(JSON.parse(saved)) : new Set();
        } catch { return new Set(); }
    });

    React.useEffect(() => {
        if (hiddenColumns.size > 0) {
            localStorage.setItem('rc-in-hidden-columns', JSON.stringify([...hiddenColumns]));
        } else {
            localStorage.removeItem('rc-in-hidden-columns');
        }
    }, [hiddenColumns]);

    const toggleColumnVisibility = (colId: string) => {
        setHiddenColumns(prev => {
            const next = new Set(prev);
            if (next.has(colId)) next.delete(colId);
            else next.add(colId);
            return next;
        });
    };

    const showAllColumns = () => setHiddenColumns(new Set());

    const hideableColumns = React.useMemo(() => {
        const cols = [
            { id: 'whse', label: 'WHSE' },
            { id: 'state', label: 'STATE' },
            { id: 'transaction_date', label: 'DATE' },
            { id: 'supplier', label: 'SUPPLIER' },
            { id: 'batch_code', label: 'BLOCK' },
            { id: 'block_loc', label: 'LOC' },
            { id: 'truck_plate', label: 'TRUCK' },
            { id: 'weight_kg', label: 'WT' },
            { id: 'sacks', label: 'SKS' },
            { id: 'mc', label: 'MC' },
            { id: 'grit', label: 'GRIT' },
            { id: 'bd_astm', label: 'ASTM' },
            { id: 'bd_jis', label: 'JIS' },
            { id: 'vm', label: 'VM' },
            { id: 'ash', label: 'ASH' },
            { id: 'fc', label: 'FC' },
            { id: 'remarks', label: 'REMARKS' },
        ];
        if (hasPermission('view:prices')) {
            cols.push({ id: 'cost_basis', label: 'PHP/KG' });
            cols.push({ id: 'php_ttl', label: 'PHP TTL' });
        }
        return cols;
    }, [hasPermission]);

    const handleViewHistory = (delivery: DeliveryHistoryRow) => {
        setHistoryDelivery(delivery);
        setHistoryOpen(true);
    };
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

    const [isSearchFocused, setIsSearchFocused] = React.useState(false);

    // Loading state for server fetches (year change)
    const [isYearLoading, setIsYearLoading] = React.useState(false);
    const [minLoadingTimer, setMinLoadingTimer] = React.useState<NodeJS.Timeout | null>(null);

    // Build URL with all current filter + month state for navigation
    const buildFilterParams = (base: URLSearchParams, filterOverrides: Record<string, string> = {}) => {
        const filters: Record<string, string> = {
            sx: stateExcluded.size > 0 ? [...stateExcluded].join(',') : '_all',
            wx: [...whseExcluded].join(','),
            sup: [...supIncluded].join(','),
            loc: [...locIncluded].join(','),
            ...filterOverrides,
        };
        // Clean up legacy exclusion params if present
        base.delete('supx');
        base.delete('lx');
        Object.entries(filters).forEach(([key, value]) => {
            if (value) base.set(key, value);
            else base.delete(key);
        });
        return base;
    };

    const handleYearChange = (newYear: string, filterOverrides: Record<string, string> = {}) => {
        setIsYearLoading(true);
        // Start min 2s timer
        const timer = setTimeout(() => {
            setIsYearLoading(false);
            setMinLoadingTimer(null);
        }, 2000);
        setMinLoadingTimer(timer);

        let newMonth = month;
        // When selecting ALL years: force month to ALL and disable month buttons
        if (newYear === 'all') {
            newMonth = 'all';
            setMonth('all');
        } else if (month === 'all') {
            // When switching to a specific year from ALL months, default to JAN
            // to avoid rendering every entry client-side
            newMonth = '0';
            setMonth('0');
        }
        // Otherwise keep the current month selection

        const params = new URLSearchParams(searchParams.toString());
        params.set('year', newYear);
        params.delete('view_date');
        // Sync month param for remount
        const defaultMonth = String(new Date().getMonth());
        if (newMonth !== defaultMonth) params.set('m', newMonth);
        else params.delete('m');
        // Persist filter state in URL for Suspense remount
        buildFilterParams(params, filterOverrides);

        router.replace(pathname + '?' + params.toString(), { scroll: false });
    };

    // Clear timeout on unmount
    React.useEffect(() => {
        return () => {
            if (minLoadingTimer) clearTimeout(minLoadingTimer);
        };
    }, [minLoadingTimer]);

    // Auto-switch to "All Years" when a header filter activates
    const yearParam = searchParams.get('year') || String(new Date().getFullYear());

    const buildFilterOverrides = (urlKey: string, filterSet: Set<string>) => {
        if (filterSet.size > 0) return { [urlKey]: [...filterSet].join(',') };
        // For sx: use sentinel to preserve "show all" across remounts
        return { [urlKey]: urlKey === 'sx' ? '_all' : '' };
    };

    // Restore user's previous year+month when all filters become empty
    // STATE has 5 values, WHSE has 5 values (hardcoded)
    const STATE_COUNT = 5;
    const WHSE_COUNT = 5;
    const maybeRestoreDate = (clearedKey?: string) => {
        if (!preFilterDate.current) return;
        // Check all filter sets are effectively inactive (treat clearedKey as already cleared)
        // STATE/WHSE: exclusion model — size 0 = no filter; size >= total = full exclusion (Deselect All) = no filter
        // Supplier/LOC: inclusion model — size 0 = no filter
        const isInactive = (key: string): boolean => {
            if (key === clearedKey) return true;
            if (key === 'sx') return stateExcluded.size === 0 || stateExcluded.size >= STATE_COUNT;
            if (key === 'wx') return whseExcluded.size === 0 || whseExcluded.size >= WHSE_COUNT;
            if (key === 'sup') return supIncluded.size === 0;
            if (key === 'loc') return locIncluded.size === 0;
            return true;
        };
        const allClear = ['sx', 'wx', 'sup', 'loc'].every(isInactive);
        if (allClear) {
            const { year, month: savedMonth } = preFilterDate.current;
            preFilterDate.current = null;
            if (year !== 'all') {
                handleYearChange(year);
                setMonth(savedMonth);
                syncParamToUrl('m', savedMonth, String(new Date().getMonth()));
            }
        }
    };

    const toggleFilterValue = (urlKey: string, value: string, exclude: boolean, current: Set<string>, setter: (s: Set<string>) => void) => {
        const next = new Set(current);
        if (exclude) next.add(value);
        else next.delete(value);
        setter(next);
        syncExclusionToUrl(urlKey, next);
        if (next.size > 0 && yearParam !== 'all') {
            if (preFilterDate.current === null) {
                preFilterDate.current = { year: yearParam, month };
            }
            handleYearChange('all', buildFilterOverrides(urlKey, next));
        }
        if (next.size === 0) {
            maybeRestoreDate(urlKey);
        }
    };

    const clearFilter = (urlKey: string, setter: (s: Set<string>) => void) => {
        setter(new Set());
        syncExclusionToUrl(urlKey, new Set());
        maybeRestoreDate(urlKey);
    };

    const selectAllFilter = (urlKey: string, setter: (s: Set<string>) => void) => {
        setter(new Set());
        syncExclusionToUrl(urlKey, new Set());
        maybeRestoreDate(urlKey);
    };

    const deselectAllFilter = (_urlKey: string, allValues: string[], setter: (s: Set<string>) => void) => {
        setter(new Set(allValues)); // UI-only: no URL sync, no year switch
    };

    // Inclusion model helpers for Supplier/LOC
    const toggleInclusionFilter = (urlKey: string, value: string, current: Set<string>, setter: (s: Set<string>) => void) => {
        const next = new Set(current);
        if (next.has(value)) next.delete(value);
        else next.add(value);
        setter(next);
        syncInclusionToUrl(urlKey, next);
        if (next.size > 0 && yearParam !== 'all') {
            if (preFilterDate.current === null) {
                preFilterDate.current = { year: yearParam, month };
            }
            handleYearChange('all', buildFilterOverrides(urlKey, next));
        }
        if (next.size === 0) {
            maybeRestoreDate(urlKey);
        }
    };

    const clearInclusionFilter = (urlKey: string, setter: (s: Set<string>) => void) => {
        setter(new Set());
        syncInclusionToUrl(urlKey, new Set());
        maybeRestoreDate(urlKey);
    };

    const handleMonthChange = (value: string) => {
        setMonth(value);
        syncParamToUrl('m', value, String(new Date().getMonth()));
    };

    // Client-side filtering (Fix #4: string slicing instead of new Date())
    // Execution order: 1) HeaderBar filters (always), 2) search overrides month, 3) FooterBar month
    const filteredData = React.useMemo(() => {
        let filtered = data;

        // HeaderBar filters — ALWAYS apply (even with search)
        // Guard: full exclusion (size >= total) = "Deselect All" = UI-only, treat as no filter
        if (stateExcluded.size > 0 && stateExcluded.size < STATE_COUNT) {
            filtered = filtered.filter(d => !stateExcluded.has(d.state || 'STORED'));
        }
        if (whseExcluded.size > 0 && whseExcluded.size < WHSE_COUNT) {
            filtered = filtered.filter(d =>
                !whseExcluded.has(calculateWhse(d.block_loc || d.batches?.location_ref, d.batch_code))
            );
        }
        if (supIncluded.size > 0) {
            filtered = filtered.filter(d => supIncluded.has(d.supplier));
        }
        if (locIncluded.size > 0) {
            filtered = filtered.filter(d =>
                locIncluded.has(d.block_loc || d.batches?.location_ref || '')
            );
        }

        // Search overrides FooterBar month filter
        if (search) return filtered;

        // FooterBar month filter (no search active)
        if (month !== 'all') {
            const monthNum = parseInt(month, 10);
            filtered = filtered.filter(d => {
                const m = parseInt(d.transaction_date.slice(5, 7), 10) - 1;
                return m === monthNum;
            });
        }

        return filtered;
    }, [data, month, search, stateExcluded, whseExcluded, supIncluded, locIncluded]);

    const [searchTerm, setSearchTerm] = React.useState(search || '');

    React.useEffect(() => {
        const timer = setTimeout(() => {
            if (searchTerm !== (search || '')) {
                router.push(pathname + '?' + createQueryString('search', searchTerm));
            }
        }, 300);

        return () => clearTimeout(timer);
    }, [searchTerm, search, router, pathname, createQueryString]);

    const handleSearchChange = (term: string) => {
        setSearchTerm(term);
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
                cell: ({ row }) => {
                    const state = row.original.state || 'STORED';
                    return (
                        <div
                            className={cn("text-center font-mono uppercase py-0.5 rounded-sm truncate", getStateClasses(state))}
                            style={{ fontSize: `${fontSize}px` }}
                            title={state}
                        >
                            {state}
                        </div>
                    );
                },
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
                header: () => <div className="text-center px-1 font-mono font-bold">SUPPLIER</div>,
                size: 120,
                cell: ({ row }) => <div className="truncate font-bold text-left" style={{ fontSize: `${fontSize}px` }} title={row.getValue('supplier')}>{row.getValue('supplier')}</div>
            },
            {
                accessorKey: 'batch_code',
                header: () => <div className="text-center px-1 font-mono font-bold">BLOCK</div>,
                size: 80,
                cell: ({ row }) => <div className="truncate text-center font-bold font-mono" style={{ fontSize: `${fontSize}px` }} title={row.getValue('batch_code')}>{row.getValue('batch_code')}</div>
            },
            {
                accessorKey: 'block_loc',
                header: () => <div className="text-center px-1 font-mono font-bold">LOC</div>,
                size: 40,
                cell: ({ row }) => {
                    const val = row.original.block_loc || row.original.batches?.location_ref;
                    return <div className="text-center font-bold font-mono" style={{ fontSize: `${fontSize}px` }}>{val || '-'}</div>;
                }
            },
            {
                accessorKey: 'truck_plate',
                header: () => <div className="text-center px-1 font-mono font-bold">TRUCK</div>,
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
                                <DropdownMenuItem onClick={() => handleViewHistory(delivery)}>
                                    <Clock className="mr-2 h-4 w-4" /> Info
                                </DropdownMenuItem>
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
            const id = col.id || (col as { accessorKey?: string }).accessorKey;
            if (id === 'actions') return true; // never hide actions
            if (id && hiddenColumns.has(id)) return false;
            if (id === 'cost_basis' || id === 'php_ttl') {
                return hasPermission('view:prices');
            }
            return true;
        });
    }, [fontSize, hasPermission, hiddenColumns]);

    const table = useReactTable({
        data: filteredData,
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

    // Row virtualization setup
    const tableContainerRef = React.useRef<HTMLDivElement>(null);
    const { rows } = table.getRowModel();

    const rowVirtualizer = useVirtualizer({
        count: rows.length,
        getScrollElement: () => tableContainerRef.current,
        estimateSize: () => rowHeight,
        overscan: 15,
    });

    // Unique filter options — hardcoded for STATE/WHSE, from props for Supplier/LOC
    const uniqueStates = React.useMemo(
        () => ['STORED', 'IN-USE', 'CLOSED', 'SUNDRYING', 'SUNDRIED'],
        []
    );

    const uniqueWhse = React.useMemo(
        () => ['WHSE A', 'WHSE B', 'WHSE C', 'WHSE D', 'FEED'],
        []
    );

    const hasActiveFilters = (stateExcluded.size > 0 && stateExcluded.size < uniqueStates.length) || (whseExcluded.size > 0 && whseExcluded.size < uniqueWhse.length) || supIncluded.size > 0 || locIncluded.size > 0;

    const clearAllFilters = () => {
        setStateExcluded(new Set());
        setWhseExcluded(new Set());
        setSupIncluded(new Set());
        setLocIncluded(new Set());
        const params = new URLSearchParams(window.location.search);
        params.set('sx', '_all'); // sentinel: user explicitly cleared (don't re-apply default on remount)
        params.delete('wx');
        params.delete('sup');
        params.delete('loc');
        // Clean up legacy params
        params.delete('supx');
        params.delete('lx');
        const qs = params.toString();
        window.history.replaceState(null, '', qs ? pathname + '?' + qs : pathname);
        // Restore saved year+month if available
        if (preFilterDate.current) {
            const { year, month: savedMonth } = preFilterDate.current;
            preFilterDate.current = null;
            if (year !== 'all') {
                handleYearChange(year);
                setMonth(savedMonth);
                syncParamToUrl('m', savedMonth, String(new Date().getMonth()));
            }
        }
    };

    // Fix #6: Memoize footer totals
    const filteredRows = table.getFilteredRowModel().rows;
    const { totalWeight, totalSacks, totalAmount } = React.useMemo(() =>
        filteredRows.reduce(
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
        ),
        [filteredRows]
    );

    // Fix #3: Compute all lab weighted averages in a single memoized pass
    const labAverages = React.useMemo(() => {
        const sums: Record<string, number> = {};
        LAB_COLUMNS.forEach(({ key }) => { sums[key] = 0; });
        let totalWt = 0;

        filteredRows.forEach(row => {
            const wt = parseFloat(String(row.original.weight_kg)) || 0;
            totalWt += wt;
            LAB_COLUMNS.forEach(({ key }) => {
                const val = parseFloat(String(row.original.lab_results?.[key as keyof typeof row.original.lab_results])) || 0;
                sums[key] += val * wt;
            });
        });

        return LAB_COLUMNS.reduce((acc, { key }) => {
            acc[key] = totalWt > 0 ? sums[key] / totalWt : 0;
            return acc;
        }, {} as Record<string, number>);
    }, [filteredRows]);

    // Footer: count visible prefix columns for dynamic colSpan
    const PREFIX_COLUMN_IDS = ['state', 'whse', 'transaction_date', 'supplier', 'batch_code', 'block_loc', 'truck_plate'];

    const visiblePrefixCount = React.useMemo(
        () => PREFIX_COLUMN_IDS.filter(id => !hiddenColumns.has(id)).length,
        [hiddenColumns]
    );

    // Fix #7: Move statusText useMemo to top-level
    // Build active filter labels for status text
    const activeFilterLabels = React.useMemo(() => {
        const labels: string[] = [];
        if (stateExcluded.size > 0 && stateExcluded.size < uniqueStates.length) labels.push(`STATE (-${stateExcluded.size})`);
        if (whseExcluded.size > 0 && whseExcluded.size < uniqueWhse.length) labels.push(`WHSE (-${whseExcluded.size})`);
        if (supIncluded.size > 0) labels.push(`SUPPLIER (${supIncluded.size})`);
        if (locIncluded.size > 0) labels.push(`LOC (${locIncluded.size})`);
        return labels;
    }, [stateExcluded, whseExcluded, supIncluded, locIncluded, uniqueStates.length, uniqueWhse.length]);

    const statusText = React.useMemo(() => {
        const count = filteredData.length;
        const displayYear = (yearParam === 'all' || search) ? 'All Years' : yearParam;
        const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

        const filterSuffix = activeFilterLabels.length > 0
            ? <> &middot; Filtered: <span className="font-semibold text-foreground">{activeFilterLabels.join(', ')}</span></>
            : null;

        if (search) {
            return <span>Found <span className="font-semibold text-foreground">{count}</span> results for &ldquo;<span className="font-semibold text-foreground">{search}</span>&rdquo; in <span className="font-semibold text-foreground">{displayYear}</span>{filterSuffix}</span>;
        }
        if (month === 'all') {
            return <span><span className="font-semibold text-foreground">{count}</span> records &middot; <span className="font-semibold text-foreground">{displayYear}</span> (All Months){filterSuffix}</span>;
        }
        return <span><span className="font-semibold text-foreground">{count}</span> records &middot; <span className="font-semibold text-foreground">{MONTH_NAMES[parseInt(month)]} {displayYear}</span>{filterSuffix}</span>;
    }, [filteredData.length, search, month, yearParam, activeFilterLabels]);

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
                                suppliers={allSuppliers}
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
                                    suppliers={allSuppliers}
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

                <DeliveryHistoryDialog
                    open={historyOpen}
                    deliveryId={historyDelivery?.id ?? null}
                    initialData={historyDelivery}
                    onOpenChange={setHistoryOpen}
                />

                {/* Toolbar */}
                <div className="flex-none flex items-center justify-between py-1">
                    <div className="flex items-center gap-1.5">
                        <div className="relative w-52">
                            <Search className="absolute left-2 top-2.5 h-3 w-3 text-muted-foreground" />
                            <Input
                                placeholder="Search deliveries..."
                                value={searchTerm}
                                onChange={(event) => handleSearchChange(event.target.value)}
                                onFocus={() => setIsSearchFocused(true)}
                                onBlur={() => setIsSearchFocused(false)}
                                className="pl-8 h-8 text-xs font-mono"
                            />
                        </div>

                        {/* WHSE filter */}
                        <Popover>
                            <PopoverTrigger asChild>
                                <Button variant="outline" className={cn(
                                    "h-8 w-auto min-w-[80px] text-xs font-mono px-2",
                                    whseExcluded.size > 0 && whseExcluded.size < uniqueWhse.length && "border-primary bg-primary/5"
                                )}>
                                    {whseExcluded.size === 0 || whseExcluded.size >= uniqueWhse.length
                                        ? 'WHSE'
                                        : `WHSE (${uniqueWhse.length - whseExcluded.size})`}
                                    {whseExcluded.size > 0 && whseExcluded.size < uniqueWhse.length ? (
                                        <span
                                            onClick={(e) => { e.stopPropagation(); clearFilter('wx', setWhseExcluded); }}
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
                                <div className="flex items-center justify-between mb-1 pb-1 border-b">
                                    <button onClick={() => selectAllFilter('wx', setWhseExcluded)} className="text-[10px] text-muted-foreground hover:text-foreground">Select All</button>
                                    <button onClick={() => deselectAllFilter('wx', uniqueWhse, setWhseExcluded)} className="text-[10px] text-muted-foreground hover:text-foreground">Deselect All</button>
                                </div>
                                {uniqueWhse.map(w => (
                                    <label key={w} className="flex items-center gap-2 px-1 py-1 text-xs font-mono rounded hover:bg-muted cursor-pointer">
                                        <Checkbox
                                            checked={!whseExcluded.has(w)}
                                            onCheckedChange={(checked) => toggleFilterValue('wx', w, !checked, whseExcluded, setWhseExcluded)}
                                            className="h-3.5 w-3.5"
                                        />
                                        {w}
                                    </label>
                                ))}
                            </PopoverContent>
                        </Popover>

                        {/* STATE filter */}
                        <Popover>
                            <PopoverTrigger asChild>
                                <Button variant="outline" className={cn(
                                    "h-8 w-auto min-w-[80px] text-xs font-mono px-2",
                                    stateExcluded.size > 0 && stateExcluded.size < uniqueStates.length && "border-primary bg-primary/5"
                                )}>
                                    {stateExcluded.size === 0 || stateExcluded.size >= uniqueStates.length
                                        ? 'State'
                                        : `State (${uniqueStates.length - stateExcluded.size})`}
                                    {stateExcluded.size > 0 && stateExcluded.size < uniqueStates.length ? (
                                        <span
                                            onClick={(e) => { e.stopPropagation(); clearFilter('sx', setStateExcluded); }}
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
                                <div className="flex items-center justify-between mb-1 pb-1 border-b">
                                    <button onClick={() => selectAllFilter('sx', setStateExcluded)} className="text-[10px] text-muted-foreground hover:text-foreground">Select All</button>
                                    <button onClick={() => deselectAllFilter('sx', uniqueStates, setStateExcluded)} className="text-[10px] text-muted-foreground hover:text-foreground">Deselect All</button>
                                </div>
                                {uniqueStates.map(s => (
                                    <label key={s} className="flex items-center gap-2 px-1 py-1 text-xs font-mono rounded hover:bg-muted cursor-pointer">
                                        <Checkbox
                                            checked={!stateExcluded.has(s)}
                                            onCheckedChange={(checked) => toggleFilterValue('sx', s, !checked, stateExcluded, setStateExcluded)}
                                            className="h-3.5 w-3.5"
                                        />
                                        <span className={cn("uppercase", getStateClasses(s), "px-1 rounded-sm")}>{s}</span>
                                    </label>
                                ))}
                            </PopoverContent>
                        </Popover>

                        {/* LOC filter (inclusion model) */}
                        <Popover>
                            <PopoverTrigger asChild>
                                <Button variant="outline" className={cn(
                                    "h-8 w-auto min-w-[60px] text-xs font-mono px-2",
                                    locIncluded.size > 0 && "border-primary bg-primary/5"
                                )}>
                                    {locIncluded.size === 0
                                        ? 'LOC'
                                        : `LOC (${locIncluded.size})`}
                                    {locIncluded.size > 0 ? (
                                        <span
                                            onClick={(e) => { e.stopPropagation(); clearInclusionFilter('loc', setLocIncluded); }}
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
                                {locIncluded.size > 0 && (
                                    <div className="flex items-center justify-end px-2 pt-2 pb-1 border-b">
                                        <button onClick={() => clearInclusionFilter('loc', setLocIncluded)} className="text-[10px] text-muted-foreground hover:text-foreground">Clear</button>
                                    </div>
                                )}
                                <Command>
                                    <CommandInput placeholder="Search locations..." className="text-xs" />
                                    <CommandList>
                                        <CommandEmpty>No location found.</CommandEmpty>
                                        <CommandGroup>
                                            {allLocations.map(l => (
                                                <CommandItem
                                                    key={l}
                                                    value={l}
                                                    onSelect={() => toggleInclusionFilter('loc', l, locIncluded, setLocIncluded)}
                                                    className="text-xs font-mono"
                                                >
                                                    <Checkbox checked={locIncluded.has(l)} className="mr-2 h-3.5 w-3.5" />
                                                    {l}
                                                </CommandItem>
                                            ))}
                                        </CommandGroup>
                                    </CommandList>
                                </Command>
                            </PopoverContent>
                        </Popover>

                        {/* SUPPLIER filter (inclusion model) */}
                        <Popover>
                            <PopoverTrigger asChild>
                                <Button variant="outline" className={cn(
                                    "h-8 w-auto min-w-[80px] text-xs font-mono px-2",
                                    supIncluded.size > 0 && "border-primary bg-primary/5"
                                )}>
                                    {supIncluded.size === 0
                                        ? 'Supplier'
                                        : `Supplier (${supIncluded.size})`}
                                    {supIncluded.size > 0 ? (
                                        <span
                                            onClick={(e) => { e.stopPropagation(); clearInclusionFilter('sup', setSupIncluded); }}
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
                                {supIncluded.size > 0 && (
                                    <div className="flex items-center justify-end px-2 pt-2 pb-1 border-b">
                                        <button onClick={() => clearInclusionFilter('sup', setSupIncluded)} className="text-[10px] text-muted-foreground hover:text-foreground">Clear</button>
                                    </div>
                                )}
                                <Command>
                                    <CommandInput placeholder="Search suppliers..." className="text-xs" />
                                    <CommandList>
                                        <CommandEmpty>No supplier found.</CommandEmpty>
                                        <CommandGroup>
                                            {allSuppliers.map(s => (
                                                <CommandItem
                                                    key={s}
                                                    value={s}
                                                    onSelect={() => toggleInclusionFilter('sup', s, supIncluded, setSupIncluded)}
                                                    className="text-xs font-mono"
                                                >
                                                    <Checkbox checked={supIncluded.has(s)} className="mr-2 h-3.5 w-3.5" />
                                                    {s}
                                                </CommandItem>
                                            ))}
                                        </CommandGroup>
                                    </CommandList>
                                </Command>
                            </PopoverContent>
                        </Popover>

                        {/* Clear all filters button */}
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
                            }}
                        >
                            Select
                        </Button>
                        <Popover>
                            <PopoverTrigger asChild>
                                <Button variant="outline" size="sm" className={cn("h-8 gap-1", hiddenColumns.size > 0 && "border-primary bg-primary/5")}>
                                    <SlidersHorizontal className="h-3.5 w-3.5" /> Columns
                                    {hiddenColumns.size > 0 && <span className="text-xs">({hiddenColumns.size})</span>}
                                </Button>
                            </PopoverTrigger>
                            <PopoverContent className="w-[200px] p-2" align="end">
                                <div className="flex items-center justify-between mb-1 pb-1 border-b">
                                    <span className="text-xs font-medium">Visible Columns</span>
                                    {hiddenColumns.size > 0 && (
                                        <button onClick={showAllColumns} className="text-[10px] text-muted-foreground hover:text-foreground">
                                            Show All
                                        </button>
                                    )}
                                </div>
                                {hideableColumns.map(col => (
                                    <label key={col.id} className="flex items-center gap-2 px-1 py-0.5 text-xs font-mono rounded hover:bg-muted cursor-pointer">
                                        <Checkbox
                                            checked={!hiddenColumns.has(col.id)}
                                            onCheckedChange={() => toggleColumnVisibility(col.id)}
                                            className="h-3.5 w-3.5"
                                        />
                                        {col.label}
                                    </label>
                                ))}
                            </PopoverContent>
                        </Popover>
                        <Button onClick={() => setIsAddOpen(true)} size="sm" className="h-8 gap-1">
                            <Plus className="h-4 w-4" />
                            Add Delivery
                        </Button>

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
                    {/* Loading Overlay */}
                    {isYearLoading && (
                        <div className="absolute inset-0 z-60 bg-background/50 backdrop-blur-sm flex items-center justify-center">
                            <div className="flex flex-col items-center gap-2">
                                <Loader2 className="h-8 w-8 animate-spin text-primary" />
                                <span className="text-sm font-medium text-muted-foreground">Loading Data...</span>
                            </div>
                        </div>
                    )}

                    <div className="flex-1 overflow-auto relative w-full h-full" ref={tableContainerRef}>
                        {/* Fix #1: No key-based remounting — content updates in place */}
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
                                        // Padding spacers keep rows in normal table flow for column alignment
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
                                                    const rowState = row.original.state || 'STORED';
                                                    return (
                                                        <TableRow
                                                            key={row.id}
                                                            data-state={isSelected ? "selected" : undefined}
                                                            className={cn(
                                                                "hover:bg-muted/50 border-b last:border-0 transition-colors",
                                                                getRowStateClasses(rowState),
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
                                                })}
                                                {paddingBottom > 0 && (
                                                    <tr><td style={{ height: `${paddingBottom}px`, padding: 0, border: 0 }} /></tr>
                                                )}
                                            </>
                                        );
                                    })() : (
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
                                        {/* TOTALS label — dynamic colSpan based on visible prefix columns */}
                                        {visiblePrefixCount > 0 && (
                                            <TableCell colSpan={visiblePrefixCount} className="px-2 font-mono font-bold text-right py-0 relative after:absolute after:right-0 after:top-0 after:bottom-0 after:w-px after:bg-foreground/20" style={{ fontSize: `${fontSize}px` }}>
                                                TOTALS
                                            </TableCell>
                                        )}
                                        {/* WT */}
                                        {!hiddenColumns.has('weight_kg') && (
                                            <TableCell className="px-1 text-center font-mono font-bold py-0 relative after:absolute after:right-0 after:top-0 after:bottom-0 after:w-px after:bg-foreground/20" style={{ fontSize: `${fontSize}px` }}>
                                                {formatCompact(Math.round(totalWeight), 2)}
                                            </TableCell>
                                        )}
                                        {/* SKS */}
                                        {!hiddenColumns.has('sacks') && (
                                            <TableCell className="px-1 text-center font-mono font-bold py-0 relative after:absolute after:right-0 after:top-0 after:bottom-0 after:w-px after:bg-foreground/20" style={{ fontSize: `${fontSize}px` }}>
                                            </TableCell>
                                        )}
                                        {/* Lab weighted averages — only visible columns */}
                                        {LAB_COLUMNS.filter(({ key }) => !hiddenColumns.has(key)).map(({ key, decimals }) => (
                                            <TableCell key={key} className="px-1 text-center font-mono font-bold py-0 relative after:absolute after:right-0 after:top-0 after:bottom-0 after:w-px after:bg-foreground/20" style={{ fontSize: `${fontSize}px` }}>
                                                {labAverages[key] > 0 ? formatCompact(labAverages[key], decimals) : '-'}
                                            </TableCell>
                                        ))}
                                        {/* REMARKS */}
                                        {!hiddenColumns.has('remarks') && (
                                            <TableCell className="py-0 relative after:absolute after:right-0 after:top-0 after:bottom-0 after:w-px after:bg-foreground/20" />
                                        )}
                                        {/* PHP/KG */}
                                        {hasPermission('view:prices') && !hiddenColumns.has('cost_basis') && (
                                            <TableCell className="px-1 font-mono font-bold py-0 relative after:absolute after:right-0 after:top-0 after:bottom-0 after:w-px after:bg-foreground/20" style={{ fontSize: `${fontSize}px` }}>
                                                <div className="flex items-center justify-between">
                                                    <span className="text-muted-foreground">₱</span>
                                                    <span>{formatCompact(totalWeight > 0 ? totalAmount / totalWeight : 0, 2)}</span>
                                                </div>
                                            </TableCell>
                                        )}
                                        {/* PHP TTL */}
                                        {hasPermission('view:prices') && !hiddenColumns.has('php_ttl') && (
                                            <TableCell className="px-1 font-mono font-bold py-0 relative after:absolute after:right-0 after:top-0 after:bottom-0 after:w-px after:bg-foreground/20" style={{ fontSize: `${fontSize}px` }}>
                                                <div className="flex items-center justify-between">
                                                    <span className="text-muted-foreground">₱</span>
                                                    <span>{formatCompact(totalAmount, 2)}</span>
                                                </div>
                                            </TableCell>
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
                        year={searchParams.get('year') || String(new Date().getFullYear())}
                        onMonthChange={handleMonthChange}
                        onYearChange={handleYearChange}
                        disabled={!!search || isSearchFocused || isYearLoading}
                        monthsDisabled={(searchParams.get('year') || '') === 'all' && !isYearLoading}
                        statusText={statusText}
                    />
                </div>


            </div>
        </TooltipProvider >
    );
}
