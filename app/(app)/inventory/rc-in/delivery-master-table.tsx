
'use client';

import * as React from 'react';
import { format } from 'date-fns';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { useTableSettings } from '@/components/providers/table-settings';
import { useAuth } from '@/components/providers/auth-context';
import {
    type ColumnDef,
    type ColumnFiltersState,
    type SortingState,
    type ColumnSizingState,
    flexRender,
    getCoreRowModel,
    getFilteredRowModel,
    getSortedRowModel,
    useReactTable,
} from '@tanstack/react-table';
import { useVirtualizer } from '@tanstack/react-virtual';
import { useRouter, usePathname, useSearchParams } from 'next/navigation';
import {
    ArrowUpDown,
    ArrowUp,
    ArrowDown,
    Search,
    Pencil,
    Trash2,
    Plus,
    X,
    Loader2,
    SlidersHorizontal,
    RefreshCw,
    FileText,
    Filter,
    ChevronDown,
    ChevronRight,
    CheckSquare,
    Copy,
    Check,
    Square,
    Bold,
    Italic,
    Underline,
    EyeOff,
    RotateCcw,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
// Shadcn table components not used — using raw HTML elements for density control
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
    Tooltip,
    TooltipTrigger,
    TooltipContent,
    TooltipProvider,
} from '@/components/ui/tooltip';
import { deleteDelivery, bulkDeleteDeliveries } from './actions';

import type { DeliveryHistoryRow } from '@/types/rc-in';
import { formatCompact } from '@/lib/format-utils';
import type { DensityMode, LabMetric } from '@/types/table-settings';
import { getLabHighlightBg, getStateDotClass } from '@/types/table-settings';

export type { DeliveryHistoryRow };
import { useCellSelection } from '@/lib/hooks/use-cell-selection';
import { useClipboardCopy } from '@/lib/hooks/use-clipboard-copy';
import { useCellAggregation, type AggregationType } from '@/lib/hooks/use-cell-aggregation';
import { useStatusBar } from '@/components/providers/status-bar-context';
import { BulkDeliveryInput } from './bulk-delivery-input';
import { DeliverySheetFooter } from '../components/DeliverySheetFooter';
import { DeliveryHistoryDialog } from './components/DeliveryHistoryDialog';
import { DensityToggle } from './components/density-toggle';
import { ColumnsPopover } from './components/columns-popover';
import { SettingsDialog } from './components/settings-dialog';

// ─── Column Width Config ──────────────────────────────────────────────────────

interface ColumnWidthSpec {
    normal: number;
    expanded: number;
}

const COL_WIDTHS: Record<string, ColumnWidthSpec | number> = {
    state: { normal: 80, expanded: 100 },
    transaction_date: { normal: 80, expanded: 80 },
    supplier: { normal: 140, expanded: 140 },
    batch_code: 85,
    block_loc: 45,
    truck_plate: 70,
    weight_kg: 65,
    sacks: 40,
    mc: 45,
    grit: 45,
    bd_astm: 50,
    bd_jis: 50,
    vm: 45,
    ash: 45,
    fc: 45,
    remarks: { normal: 90, expanded: 120 },
    cost_basis: 60,
    php_total: 90,
};

function getDefaultColWidth(colId: string, density: DensityMode): number {
    const spec = COL_WIDTHS[colId];
    if (!spec) return 60;
    if (typeof spec === 'number') return spec;
    return spec[density];
}

// ─── Lab Config ───────────────────────────────────────────────────────────────

const LAB_COLUMNS: { key: string; label: string; decimals: number }[] = [
    { key: 'mc', label: 'MC', decimals: 2 },
    { key: 'grit', label: 'GRIT', decimals: 2 },
    { key: 'bd_astm', label: 'BD\nASTM', decimals: 3 },
    { key: 'bd_jis', label: 'BD\nJIS', decimals: 3 },
    { key: 'vm', label: 'VM', decimals: 2 },
    { key: 'ash', label: 'ASH', decimals: 2 },
    { key: 'fc', label: 'FC', decimals: 2 },
];

const LAB_KEYS = new Set(['mc', 'grit', 'bd_astm', 'bd_jis', 'vm', 'ash', 'fc']);

const PREFIX_COLUMN_IDS = ['state', 'transaction_date', 'supplier', 'batch_code', 'block_loc', 'truck_plate'];

// ─── Formatting Helpers ───────────────────────────────────────────────────────

function formatDateByDensity(dateStr: string): string {
    const d = new Date(dateStr + 'T00:00:00');
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    const yyyy = d.getFullYear();
    return `${mm}/${dd}/${yyyy}`;
}

function getDayName(dateStr: string): string {
    const d = new Date(dateStr + 'T00:00:00');
    return d.toLocaleDateString('en-US', { weekday: 'long' });
}

function formatCurrency(value: number): string {
    return value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function formatWeight(value: number): string {
    return value.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
}

// ─── Density Helpers ──────────────────────────────────────────────────────────

function getDensityClasses(density: DensityMode) {
    const rowHeightClass = density === 'normal' ? 'h-8' : 'h-12';
    const fontSizeClass = 'text-xs';
    const cellPaddingClass = density === 'normal' ? 'px-2 py-1' : 'px-2 py-1.5';
    return { rowHeightClass, fontSizeClass, cellPaddingClass };
}

// ─── Popup Dimensions ─────────────────────────────────────────────────────────

const POPUP_WIDTH = 200;
const POPUP_HEIGHT = 280;

// ─── Props ────────────────────────────────────────────────────────────────────

interface DeliveryMasterTableProps {
    data: DeliveryHistoryRow[];
    batches: { id: string; batch_code: string; location_ref: string }[];
    search?: string;
    allSuppliers: string[];
    allLocations: string[];
}

// ─── Main Component ───────────────────────────────────────────────────────────

export function DeliveryMasterTable({ data, batches, search, allSuppliers, allLocations }: DeliveryMasterTableProps) {
    const { settings, setDensity, toggleColumn, showAllColumns, setColumnWidth, setColumnFormat } = useTableSettings();
    const { hasPermission } = useAuth();
    const { setCellSelectionCount, setCellAggregates } = useStatusBar();
    const router = useRouter();
    const pathname = usePathname();
    const searchParams = useSearchParams();

    const density = settings.densityMode;
    const { rowHeightClass, fontSizeClass, cellPaddingClass } = getDensityClasses(density);
    const labHighlights = settings.labHighlights;
    const canViewPrices = hasPermission('view:prices');

    // ─── Refresh State ────────────────────────────────────────────────────────
    const [refreshing, setRefreshing] = React.useState(false);

    const handleRefresh = React.useCallback(() => {
        setRefreshing(true);
        router.refresh();
        setTimeout(() => setRefreshing(false), 1000);
    }, [router]);

    // ─── Month State ──────────────────────────────────────────────────────────
    const [month, setMonth] = React.useState<string>(() => searchParams.get('m') || String(new Date().getMonth()));

    // Ref to save user's year+month before header filters auto-switch to All Years
    const preFilterDate = React.useRef<{ year: string; month: string } | null>(null);

    // ─── Filter State ─────────────────────────────────────────────────────────

    type FilterState = {
        stateExcluded: Set<string>;
        supIncluded: Set<string>;
        locIncluded: Set<string>;
    };

    const STATE_DEFAULT_EXCLUDED = ['CLOSED'];
    const [filters, setFilters] = React.useState<FilterState>(() => {
        const sx = searchParams.get('sx');
        const sup = searchParams.get('sup');
        const loc = searchParams.get('loc');

        return {
            stateExcluded: sx === '_all' ? new Set() : sx ? new Set(sx.split(',')) : new Set(STATE_DEFAULT_EXCLUDED),
            supIncluded: sup ? new Set(sup.split(',')) : new Set(),
            locIncluded: loc ? new Set(loc.split(',')) : new Set(),
        };
    });

    // Clean up deprecated wx param on mount
    React.useEffect(() => {
        const params = new URLSearchParams(window.location.search);
        if (params.has('wx') || params.has('supx') || params.has('lx')) {
            params.delete('wx');
            params.delete('supx');
            params.delete('lx');
            const qs = params.toString();
            window.history.replaceState(null, '', qs ? pathname + '?' + qs : pathname);
        }
    }, [pathname]);

    const { stateExcluded, supIncluded, locIncluded } = filters;

    // ─── URL Sync Helpers ─────────────────────────────────────────────────────

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
            params.set(key, '_all');
        } else {
            params.delete(key);
        }
        const qs = params.toString();
        window.history.replaceState(null, '', qs ? pathname + '?' + qs : pathname);
    }, [pathname]);

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

    // ─── Sorting & TanStack State ─────────────────────────────────────────────

    const [sorting, setSorting] = React.useState<SortingState>([]);
    const [columnFilters, setColumnFilters] = React.useState<ColumnFiltersState>([]);
    const [columnSizing, setColumnSizing] = React.useState<ColumnSizingState>(() => {
        // Merge defaults with user-persisted widths
        const defaults: ColumnSizingState = {};
        Object.keys(COL_WIDTHS).forEach(id => {
            defaults[id] = getDefaultColWidth(id, density);
        });
        return { ...defaults, ...settings.columnWidths };
    });

    // ─── Dialog State ─────────────────────────────────────────────────────────

    const [isInputDirty, setIsInputDirty] = React.useState(false);
    const [showExitConfirmation, setShowExitConfirmation] = React.useState(false);
    const [pendingAction, setPendingAction] = React.useState<() => void>(() => { });
    const [isAddOpen, setIsAddOpen] = React.useState(false);
    const [selectionMode, setSelectionMode] = React.useState(false);
    const [selectedIds, setSelectedIds] = React.useState<Set<string>>(new Set());
    const [editRows, setEditRows] = React.useState<DeliveryHistoryRow[] | null>(null);
    const [historyDelivery, setHistoryDelivery] = React.useState<DeliveryHistoryRow | null>(null);
    const [historyOpen, setHistoryOpen] = React.useState(false);
    const [settingsOpen, setSettingsOpen] = React.useState(false);

    // ─── Row Action Popup State ───────────────────────────────────────────────

    const [popupState, setPopupState] = React.useState<{ rowId: string; x: number; y: number } | null>(null);

    // ─── Column Context Menu State ───────────────────────────────────────────
    const [columnPopupState, setColumnPopupState] = React.useState<{ colId: string; x: number; y: number } | null>(null);

    // Close column popup on outside click or Escape
    React.useEffect(() => {
        if (!columnPopupState) return;
        const handleClick = (e: MouseEvent) => {
            const target = e.target as HTMLElement;
            if (target.closest('[data-column-popup]')) return;
            setColumnPopupState(null);
        };
        const handleKeyDown = (e: KeyboardEvent) => {
            if (e.key === 'Escape') setColumnPopupState(null);
        };
        document.addEventListener('mousedown', handleClick);
        document.addEventListener('keydown', handleKeyDown);
        return () => {
            document.removeEventListener('mousedown', handleClick);
            document.removeEventListener('keydown', handleKeyDown);
        };
    }, [columnPopupState]);

    const openPopup = React.useCallback((id: string, clientX: number, clientY: number) => {
        let x = clientX;
        let y = clientY;
        if (x + POPUP_WIDTH > window.innerWidth) x = x - POPUP_WIDTH;
        if (y + POPUP_HEIGHT > window.innerHeight) y = y - POPUP_HEIGHT;
        setPopupState({ rowId: id, x, y });
    }, []);

    // Close popup on outside click or Escape
    React.useEffect(() => {
        if (!popupState) return;
        const handleClick = (e: MouseEvent) => {
            const target = e.target as HTMLElement;
            if (target.closest('[data-row-popup]')) return;
            setPopupState(null);
        };
        const handleKeyDown = (e: KeyboardEvent) => {
            if (e.key === 'Escape') setPopupState(null);
        };
        document.addEventListener('mousedown', handleClick);
        document.addEventListener('keydown', handleKeyDown);
        return () => {
            document.removeEventListener('mousedown', handleClick);
            document.removeEventListener('keydown', handleKeyDown);
        };
    }, [popupState]);

    // ─── Search State ─────────────────────────────────────────────────────────

    const [searchTerm, setSearchTerm] = React.useState(search || '');
    const [isSearchFocused, setIsSearchFocused] = React.useState(false);

    const createQueryString = React.useCallback(
        (name: string, value: string) => {
            const params = new URLSearchParams(searchParams.toString());
            if (value) params.set(name, value);
            else params.delete(name);
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

    // ─── Year Loading ─────────────────────────────────────────────────────────

    const [isYearLoading, setIsYearLoading] = React.useState(false);
    const [minLoadingTimer, setMinLoadingTimer] = React.useState<NodeJS.Timeout | null>(null);

    const yearParam = searchParams.get('year') || String(new Date().getFullYear());

    const buildFilterParams = (base: URLSearchParams, filterOverrides: Record<string, string> = {}) => {
        const filterEntries: Record<string, string> = {
            sx: stateExcluded.size > 0 ? [...stateExcluded].join(',') : '_all',
            sup: [...supIncluded].join(','),
            loc: [...locIncluded].join(','),
            ...filterOverrides,
        };
        base.delete('wx');
        base.delete('supx');
        base.delete('lx');
        Object.entries(filterEntries).forEach(([key, value]) => {
            if (value) base.set(key, value);
            else base.delete(key);
        });
        return base;
    };

    const handleYearChange = React.useCallback((newYear: string, filterOverrides: Record<string, string> = {}) => {
        setIsYearLoading(true);
        const timer = setTimeout(() => {
            setIsYearLoading(false);
            setMinLoadingTimer(null);
        }, 2000);
        setMinLoadingTimer(timer);

        let newMonth = month;
        if (newYear === 'all') {
            newMonth = 'all';
            setMonth('all');
        } else if (month === 'all') {
            newMonth = '0';
            setMonth('0');
        }

        const params = new URLSearchParams(searchParams.toString());
        params.set('year', newYear);
        params.delete('view_date');
        const defaultMonth = String(new Date().getMonth());
        if (newMonth !== defaultMonth) params.set('m', newMonth);
        else params.delete('m');
        buildFilterParams(params, filterOverrides);

        router.replace(pathname + '?' + params.toString(), { scroll: false });
    }, [month, searchParams, pathname, router, stateExcluded, supIncluded, locIncluded]);

    React.useEffect(() => {
        return () => { if (minLoadingTimer) clearTimeout(minLoadingTimer); };
    }, [minLoadingTimer]);

    // ─── Filter Helpers ───────────────────────────────────────────────────────

    const STATE_COUNT = 5;

    const buildFilterOverrides = React.useCallback((urlKey: string, filterSet: Set<string>) => {
        if (filterSet.size > 0) return { [urlKey]: [...filterSet].join(',') };
        return { [urlKey]: urlKey === 'sx' ? '_all' : '' };
    }, []);

    const maybeRestoreDate = React.useCallback((clearedKey?: string) => {
        if (!preFilterDate.current) return;
        const isInactive = (key: string): boolean => {
            if (key === clearedKey) return true;
            if (key === 'sx') return stateExcluded.size === 0 || stateExcluded.size >= STATE_COUNT;
            if (key === 'sup') return supIncluded.size === 0;
            if (key === 'loc') return locIncluded.size === 0;
            return true;
        };
        const allClear = ['sx', 'sup', 'loc'].every(isInactive);
        if (allClear) {
            const { year, month: savedMonth } = preFilterDate.current;
            preFilterDate.current = null;
            if (year !== 'all') {
                handleYearChange(year);
                setMonth(savedMonth);
                syncParamToUrl('m', savedMonth, String(new Date().getMonth()));
            }
        }
    }, [stateExcluded, supIncluded, locIncluded, handleYearChange, syncParamToUrl]);

    // STATE exclusion toggle
    const toggleStateFilter = React.useCallback((value: string, exclude: boolean) => {
        const next = new Set(stateExcluded);
        if (exclude) next.add(value);
        else next.delete(value);

        setFilters(prev => ({ ...prev, stateExcluded: next }));
        syncExclusionToUrl('sx', next);

        if (next.size > 0 && yearParam !== 'all') {
            if (preFilterDate.current === null) {
                preFilterDate.current = { year: yearParam, month };
            }
            handleYearChange('all', buildFilterOverrides('sx', next));
        }
        if (next.size === 0) maybeRestoreDate('sx');
    }, [stateExcluded, yearParam, month, syncExclusionToUrl, handleYearChange, buildFilterOverrides, maybeRestoreDate]);

    const clearStateFilter = React.useCallback(() => {
        setFilters(prev => ({ ...prev, stateExcluded: new Set() }));
        syncExclusionToUrl('sx', new Set());
        maybeRestoreDate('sx');
    }, [syncExclusionToUrl, maybeRestoreDate]);

    const selectAllStates = React.useCallback(() => {
        setFilters(prev => ({ ...prev, stateExcluded: new Set() }));
        syncExclusionToUrl('sx', new Set());
        maybeRestoreDate('sx');
    }, [syncExclusionToUrl, maybeRestoreDate]);

    const deselectAllStates = React.useCallback((allValues: string[]) => {
        setFilters(prev => ({ ...prev, stateExcluded: new Set(allValues) }));
        // UI-only: no URL sync, no year switch
    }, []);

    // Supplier/LOC inclusion toggles
    const toggleInclusionFilter = React.useCallback((urlKey: string, value: string, current: Set<string>) => {
        const next = new Set(current);
        if (next.has(value)) next.delete(value);
        else next.add(value);

        setFilters(prev => ({
            ...prev,
            [urlKey === 'sup' ? 'supIncluded' : 'locIncluded']: next,
        }));
        syncInclusionToUrl(urlKey, next);

        if (next.size > 0 && yearParam !== 'all') {
            if (preFilterDate.current === null) {
                preFilterDate.current = { year: yearParam, month };
            }
            handleYearChange('all', buildFilterOverrides(urlKey, next));
        }
        if (next.size === 0) maybeRestoreDate(urlKey);
    }, [yearParam, month, syncInclusionToUrl, handleYearChange, buildFilterOverrides, maybeRestoreDate]);

    const clearInclusionFilter = React.useCallback((urlKey: string) => {
        setFilters(prev => ({
            ...prev,
            [urlKey === 'sup' ? 'supIncluded' : 'locIncluded']: new Set(),
        }));
        syncInclusionToUrl(urlKey, new Set());
        maybeRestoreDate(urlKey);
    }, [syncInclusionToUrl, maybeRestoreDate]);

    const handleMonthChange = (value: string) => {
        setMonth(value);
        syncParamToUrl('m', value, String(new Date().getMonth()));
    };

    // ─── Unique Filter Options ────────────────────────────────────────────────

    const uniqueStates = React.useMemo(
        () => ['STORED', 'IN-USE', 'CLOSED', 'SUNDRYING', 'SUNDRIED'],
        []
    );

    const hasActiveFilters = (stateExcluded.size > 0 && stateExcluded.size < uniqueStates.length) || supIncluded.size > 0 || locIncluded.size > 0;

    const clearAllFilters = () => {
        setFilters({ stateExcluded: new Set(), supIncluded: new Set(), locIncluded: new Set() });
        const params = new URLSearchParams(window.location.search);
        params.set('sx', '_all');
        params.delete('wx');
        params.delete('sup');
        params.delete('loc');
        params.delete('supx');
        params.delete('lx');
        const qs = params.toString();
        window.history.replaceState(null, '', qs ? pathname + '?' + qs : pathname);
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

    // ─── Filtered Data ────────────────────────────────────────────────────────

    const filteredData = React.useMemo(() => {
        let filtered = data;

        // STATE filter (exclusion model)
        if (stateExcluded.size > 0 && stateExcluded.size < STATE_COUNT) {
            filtered = filtered.filter(d => !stateExcluded.has(d.state || 'STORED'));
        }
        // Supplier filter (inclusion model)
        if (supIncluded.size > 0) {
            filtered = filtered.filter(d => supIncluded.has(d.supplier));
        }
        // LOC filter (inclusion model)
        if (locIncluded.size > 0) {
            filtered = filtered.filter(d =>
                locIncluded.has(d.block_loc || d.batches?.location_ref || '')
            );
        }

        // Search overrides FooterBar month filter
        if (search) return filtered;

        // FooterBar month filter
        if (month !== 'all') {
            const monthNum = parseInt(month, 10);
            filtered = filtered.filter(d => {
                const m = parseInt(d.transaction_date.slice(5, 7), 10) - 1;
                return m === monthNum;
            });
        }

        return filtered;
    }, [data, month, search, stateExcluded, supIncluded, locIncluded]);

    // ─── Supplier / Cost Aggregates for Expanded Mode ─────────────────────────

    const supplierCounts = React.useMemo(() => {
        const counts: Record<string, number> = {};
        for (const d of filteredData) {
            counts[d.supplier] = (counts[d.supplier] || 0) + 1;
        }
        return counts;
    }, [filteredData]);

    const avgCostBasis = React.useMemo(() => {
        if (filteredData.length === 0) return 0;
        const sum = filteredData.reduce((acc, d) => acc + (parseFloat(String(d.cost_basis)) || 0), 0);
        return sum / filteredData.length;
    }, [filteredData]);

    // ─── Selection Handlers ───────────────────────────────────────────────────

    const toggleSelect = React.useCallback((id: string) => {
        setSelectedIds(prev => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
        });
    }, []);

    // Single-row delete: currently only available via bulk selection mode
    // Kept for future row action popup integration
    const _handleDelete = async (id: string) => {
        if (confirm('Are you sure you want to delete this delivery?')) {
            const res = await deleteDelivery(id);
            if (res.success) {
                toast.success('Delivery deleted');
                setSelectedIds(prev => { const next = new Set(prev); next.delete(id); return next; });
                handleRefresh();
            } else {
                toast.error('Delete failed: ' + res.message);
            }
        }
    };
    void _handleDelete; // suppress unused warning

    const handleBulkDelete = async () => {
        const count = selectedIds.size;
        if (confirm(`Are you sure you want to delete ${count} deliver${count === 1 ? 'y' : 'ies'}?`)) {
            const res = await bulkDeleteDeliveries([...selectedIds]);
            if (res.success) {
                toast.success(`${count} deliver${count === 1 ? 'y' : 'ies'} deleted`);
                setSelectedIds(new Set());
                handleRefresh();
            } else {
                toast.error('Bulk delete failed: ' + res.message);
            }
        }
    };

    // ─── Dialog Handlers ──────────────────────────────────────────────────────

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

    React.useEffect(() => {
        if (!isAddOpen && !editRows) setIsInputDirty(false);
    }, [isAddOpen, editRows]);

    const handleBulkEdit = () => {
        const rows = data.filter(d => selectedIds.has(d.id));
        setEditRows(rows);
    };

    const handleSingleEdit = (delivery: DeliveryHistoryRow) => {
        setEditRows([delivery]);
    };

    const handleViewHistory = (delivery: DeliveryHistoryRow) => {
        setHistoryDelivery(delivery);
        setHistoryOpen(true);
    };

    // ─── LOC Filter Data ──────────────────────────────────────────────────────

    const locsByWhse = React.useMemo(() => {
        const map: Record<string, string[]> = {};
        const seen = new Set<string>();
        for (const loc of allLocations) {
            if (seen.has(loc)) continue;
            seen.add(loc);
            const whse = loc.charAt(0).toUpperCase();
            if (!map[whse]) map[whse] = [];
            map[whse].push(loc);
        }
        for (const whse of Object.keys(map)) {
            map[whse].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
        }
        return map;
    }, [allLocations]);

    // ─── Column Definitions ───────────────────────────────────────────────────

    const hiddenColumnsSet = React.useMemo(() => new Set(settings.hiddenColumns), [settings.hiddenColumns]);

    const columns = React.useMemo<ColumnDef<DeliveryHistoryRow>[]>(() => {
        const allColumns: ColumnDef<DeliveryHistoryRow>[] = [
            {
                id: 'state',
                header: () => <StateHeaderFilter
                    uniqueStates={uniqueStates}
                    stateExcluded={stateExcluded}
                    onToggle={toggleStateFilter}
                    onSelectAll={selectAllStates}
                    onDeselectAll={() => deselectAllStates(uniqueStates)}
                    onClear={clearStateFilter}
                />,
                size: getDefaultColWidth('state', density),
                enableResizing: true,
                cell: ({ row }) => {
                    const state = row.original.state || 'STORED';
                    const dotClass = getStateDotClass(state);
                    if (density === 'expanded') {
                        const annotation = state === 'CLOSED' ? 'Closed' : 'Active';
                        return (
                            <div className="flex flex-col justify-center">
                                <span className="inline-flex items-center gap-1.5">
                                    <span className={cn('inline-block w-1.5 h-1.5 rounded-full shrink-0', dotClass)} />
                                    <span className="text-[10px]">{state}</span>
                                </span>
                                <span className="text-[10px] text-muted-foreground leading-none mt-0.5">{annotation}</span>
                            </div>
                        );
                    }
                    return (
                        <span className="inline-flex items-center gap-1.5">
                            <span className={cn('inline-block w-1.5 h-1.5 rounded-full shrink-0', dotClass)} />
                            <span className="text-[10px]">{state}</span>
                        </span>
                    );
                },
            },
            {
                accessorKey: 'transaction_date',
                header: ({ column }) => (
                    <Button
                        variant="ghost"
                        onClick={() => column.toggleSorting(column.getIsSorted() === 'asc')}
                        className="h-6 px-0 text-xs font-semibold text-muted-foreground gap-1"
                    >
                        Date
                        <ArrowUpDown className="size-3" />
                    </Button>
                ),
                size: getDefaultColWidth('transaction_date', density),
                enableResizing: true,
                cell: ({ row }) => {
                    const dateStr = row.original.transaction_date;
                    if (density === 'expanded') {
                        return (
                            <div className="flex flex-col justify-center">
                                <span>{formatDateByDensity(dateStr)}</span>
                                <span className="text-[10px] text-muted-foreground leading-none mt-0.5">{getDayName(dateStr)}</span>
                            </div>
                        );
                    }
                    return <span className="whitespace-nowrap">{formatDateByDensity(dateStr)}</span>;
                },
            },
            {
                accessorKey: 'supplier',
                header: () => <SupplierHeaderFilter
                    allSuppliers={allSuppliers}
                    supIncluded={supIncluded}
                    onToggle={(value) => toggleInclusionFilter('sup', value, supIncluded)}
                    onClear={() => clearInclusionFilter('sup')}
                />,
                size: getDefaultColWidth('supplier', density),
                enableResizing: true,
                cell: ({ row }) => {
                    const supplier = row.original.supplier || '';
                    if (density === 'expanded') {
                        return (
                            <div className="flex flex-col justify-center">
                                <span className="block truncate" title={supplier}>{supplier}</span>
                                <span className="text-[10px] text-muted-foreground leading-none mt-0.5">{supplierCounts[supplier] || 0} deliveries</span>
                            </div>
                        );
                    }
                    return <span className="block truncate" title={supplier}>{supplier}</span>;
                },
            },
            {
                accessorKey: 'batch_code',
                header: () => <span className="font-semibold text-muted-foreground">Batch</span>,
                size: getDefaultColWidth('batch_code', density),
                enableResizing: true,
                cell: ({ row }) => <span className="font-mono truncate block">{row.original.batch_code}</span>,
            },
            {
                accessorKey: 'block_loc',
                // LOC header with integrated filter popover
                header: () => <LocHeaderFilter locsByWhse={locsByWhse} activeLocFilters={locIncluded} onFiltersChange={(next) => {
                    setFilters(prev => ({ ...prev, locIncluded: next }));
                    syncInclusionToUrl('loc', next);
                    if (next.size > 0 && yearParam !== 'all') {
                        if (preFilterDate.current === null) {
                            preFilterDate.current = { year: yearParam, month };
                        }
                        handleYearChange('all', buildFilterOverrides('loc', next));
                    }
                    if (next.size === 0) maybeRestoreDate('loc');
                }} />,
                size: getDefaultColWidth('block_loc', density),
                enableResizing: true,
                cell: ({ row }) => {
                    const val = row.original.block_loc || row.original.batches?.location_ref || '-';
                    if (density === 'expanded') {
                        return (
                            <div className="flex flex-col justify-center">
                                <span className="font-mono">{val}</span>
                                <span className="text-[10px] text-muted-foreground leading-none mt-0.5">WHSE {val.charAt(0)}</span>
                            </div>
                        );
                    }
                    return <span className="font-mono">{val}</span>;
                },
            },
            {
                accessorKey: 'truck_plate',
                header: () => <span className="font-semibold text-muted-foreground">Truck</span>,
                size: getDefaultColWidth('truck_plate', density),
                enableResizing: true,
                cell: ({ row }) => {
                    const truck = row.original.truck_plate || '';
                    return (
                        <Tooltip>
                            <TooltipTrigger asChild>
                                <span className="font-mono truncate block">{truck}</span>
                            </TooltipTrigger>
                            {truck.length > 8 && <TooltipContent side="top" className="text-xs">{truck}</TooltipContent>}
                        </Tooltip>
                    );
                },
            },
            {
                accessorKey: 'weight_kg',
                header: () => <span className="font-semibold text-muted-foreground text-right block">Weight</span>,
                size: getDefaultColWidth('weight_kg', density),
                enableResizing: true,
                cell: ({ row }) => {
                    const wt = parseFloat(String(row.original.weight_kg)) || 0;
                    if (density === 'expanded') {
                        return (
                            <div className="flex flex-col justify-center text-right font-mono">
                                <span>{formatWeight(wt)}</span>
                                <span className="text-[10px] text-muted-foreground leading-none mt-0.5">{row.original.sacks} sks</span>
                            </div>
                        );
                    }
                    return <span className="font-mono text-right block">{formatWeight(wt)}</span>;
                },
            },
            {
                accessorKey: 'sacks',
                header: () => <span className="font-semibold text-muted-foreground text-right block">Sks</span>,
                size: getDefaultColWidth('sacks', density),
                enableResizing: true,
                cell: ({ row }) => {
                    const sacks = row.original.sacks;
                    if (density === 'expanded') {
                        return (
                            <div className="flex flex-col justify-center text-right font-mono">
                                <span>{sacks?.toLocaleString() ?? '-'}</span>
                                <span className="text-[10px] text-muted-foreground leading-none mt-0.5">sacks</span>
                            </div>
                        );
                    }
                    return <span className="font-mono text-right block">{sacks?.toLocaleString() ?? '-'}</span>;
                },
            },
        ];

        // Lab columns
        for (const { key, label, decimals } of LAB_COLUMNS) {
            const isBD = key === 'bd_astm' || key === 'bd_jis';
            allColumns.push({
                id: key,
                header: () => (
                    <span className={cn(
                        'font-semibold text-muted-foreground text-right block',
                        isBD ? 'whitespace-pre-wrap leading-[1.1]' : 'whitespace-nowrap'
                    )}>
                        {label}
                    </span>
                ),
                size: getDefaultColWidth(key, density),
                enableResizing: true,
                cell: ({ row }) => {
                    const val = row.original.lab_results?.[key as keyof DeliveryHistoryRow['lab_results']];
                    if (val == null) return <span className="font-mono text-right block text-muted-foreground">-</span>;
                    const numVal = Number(val);
                    const highlightBg = getLabHighlightBg(key as LabMetric, numVal, labHighlights);

                    if (density === 'expanded') {
                        return (
                            <div className={cn('flex flex-col justify-center text-right font-mono', highlightBg)}>
                                <span>{numVal.toFixed(decimals)}</span>
                            </div>
                        );
                    }

                    return <span className={cn('font-mono text-right block', highlightBg)}>{numVal.toFixed(decimals)}</span>;
                },
            });
        }

        // Remarks column (before cost columns)
        allColumns.push({
            accessorKey: 'remarks',
            header: () => <span className="font-semibold text-muted-foreground">Rmk</span>,
            size: getDefaultColWidth('remarks', density),
            enableResizing: true,
            cell: ({ row }) => {
                const remarks = row.original.remarks;
                if (!remarks) return null;
                return (
                    <Tooltip>
                        <TooltipTrigger asChild>
                            <span className="block truncate max-w-full text-muted-foreground cursor-default">{remarks}</span>
                        </TooltipTrigger>
                        <TooltipContent side="left" className="text-xs max-w-[200px]">{remarks}</TooltipContent>
                    </Tooltip>
                );
            },
        });

        // Cost columns (gated by permission)
        if (canViewPrices) {
            allColumns.push({
                accessorKey: 'cost_basis',
                header: () => <span className="font-semibold text-muted-foreground text-right block">PHP/KG</span>,
                size: getDefaultColWidth('cost_basis', density),
                enableResizing: true,
                cell: ({ row }) => {
                    const val = parseFloat(String(row.original.cost_basis)) || 0;
                    if (density === 'expanded') {
                        const delta = val - avgCostBasis;
                        const sign = delta >= 0 ? '+' : '';
                        const deltaColor = delta >= 0 ? 'text-red-500' : 'text-emerald-500';
                        return (
                            <div className="flex flex-col justify-center font-mono">
                                <span className="flex justify-between">
                                    <span className="text-muted-foreground">&#8369;</span>
                                    <span>{formatCurrency(val)}</span>
                                </span>
                                <span className={cn('text-[10px] leading-none mt-0.5 text-right', deltaColor)}>
                                    {sign}&#8369;{Math.abs(delta).toFixed(2)}
                                </span>
                            </div>
                        );
                    }
                    return (
                        <span className="flex justify-between font-mono">
                            <span className="text-muted-foreground">&#8369;</span>
                            <span>{formatCurrency(val)}</span>
                        </span>
                    );
                },
            });
            allColumns.push({
                id: 'php_total',
                header: () => <span className="font-semibold text-muted-foreground text-right block">PHP Total</span>,
                size: getDefaultColWidth('php_total', density),
                enableResizing: true,
                cell: ({ row }) => {
                    const wt = parseFloat(String(row.original.weight_kg)) || 0;
                    const price = parseFloat(String(row.original.cost_basis)) || 0;
                    const total = wt * price;
                    return (
                        <span className="flex justify-between font-mono">
                            <span className="text-muted-foreground">&#8369;</span>
                            <span>{formatCurrency(total)}</span>
                        </span>
                    );
                },
            });
        }

        // Filter out hidden columns
        return allColumns.filter(col => {
            const id = col.id || (col as { accessorKey?: string }).accessorKey;
            if (id && hiddenColumnsSet.has(id)) return false;
            return true;
        });
    }, [density, labHighlights, canViewPrices, hiddenColumnsSet, supplierCounts, avgCostBasis, locsByWhse, locIncluded, yearParam, month, syncInclusionToUrl, handleYearChange, buildFilterOverrides, maybeRestoreDate, uniqueStates, stateExcluded, toggleStateFilter, selectAllStates, deselectAllStates, clearStateFilter, allSuppliers, supIncluded, toggleInclusionFilter, clearInclusionFilter]);

    // ─── TanStack Table ───────────────────────────────────────────────────────

    const table = useReactTable({
        data: filteredData,
        columns,
        onSortingChange: setSorting,
        onColumnFiltersChange: setColumnFilters,
        getCoreRowModel: getCoreRowModel(),
        getSortedRowModel: getSortedRowModel(),
        getFilteredRowModel: getFilteredRowModel(),
        enableColumnResizing: true,
        columnResizeMode: 'onChange',
        onColumnSizingChange: setColumnSizing,
        state: {
            sorting,
            columnFilters,
            columnSizing,
        },
    });

    // Debounced persist column widths
    const columnSizingTimerRef = React.useRef<NodeJS.Timeout | null>(null);
    React.useEffect(() => {
        if (columnSizingTimerRef.current) clearTimeout(columnSizingTimerRef.current);
        columnSizingTimerRef.current = setTimeout(() => {
            Object.entries(columnSizing).forEach(([colId, width]) => {
                if (width !== getDefaultColWidth(colId, density)) {
                    setColumnWidth(colId, width);
                }
            });
        }, 300);
        return () => { if (columnSizingTimerRef.current) clearTimeout(columnSizingTimerRef.current); };
    }, [columnSizing, density, setColumnWidth]);

    // ─── Row Virtualization ───────────────────────────────────────────────────

    const tableContainerRef = React.useRef<HTMLDivElement>(null);
    const { rows } = table.getRowModel();

    const rowHeight = density === 'normal' ? 32 : 48;

    const rowVirtualizer = useVirtualizer({
        count: rows.length,
        getScrollElement: () => tableContainerRef.current,
        estimateSize: () => rowHeight,
        overscan: 15,
    });

    // ─── Cell Selection ───────────────────────────────────────────────────────

    const visibleColumns = table.getAllColumns().filter(c => c.getIsVisible());
    const cellSelection = useCellSelection({
        rowCount: rows.length,
        colCount: visibleColumns.length,
        isSelectableColumn: () => true,
        scrollContainerRef: tableContainerRef,
        enabled: !selectionMode,
    });

    const selectionSize = cellSelection.getSelectionSize();

    const getCellValue = React.useCallback((rowIdx: number, colIdx: number): string => {
        const row = rows[rowIdx];
        if (!row) return '';
        const d = row.original;
        const col = visibleColumns[colIdx];
        if (!col) return '';

        switch (col.id) {
            case 'state': return d.state || 'STORED';

            case 'transaction_date': return format(new Date(d.transaction_date), 'MM/dd/yyyy');
            case 'supplier': return d.supplier || '';
            case 'batch_code': return d.batch_code || '';
            case 'block_loc': return d.block_loc || d.batches?.location_ref || '';
            case 'truck_plate': return d.truck_plate || '';
            case 'weight_kg': return String(Math.round(parseFloat(String(d.weight_kg)) || 0));
            case 'sacks': return String(d.sacks || '');
            case 'mc': return d.lab_results?.mc != null ? d.lab_results.mc.toFixed(2) : '';
            case 'grit': return d.lab_results?.grit != null ? d.lab_results.grit.toFixed(2) : '';
            case 'bd_astm': return d.lab_results?.bd_astm != null ? d.lab_results.bd_astm.toFixed(3) : '';
            case 'bd_jis': return d.lab_results?.bd_jis != null ? d.lab_results.bd_jis.toFixed(3) : '';
            case 'vm': return d.lab_results?.vm != null ? d.lab_results.vm.toFixed(2) : '';
            case 'ash': return d.lab_results?.ash != null ? d.lab_results.ash.toFixed(2) : '';
            case 'fc': return d.lab_results?.fc != null ? d.lab_results.fc.toFixed(2) : '';
            case 'remarks': return d.remarks || '';
            case 'cost_basis': { const v = parseFloat(String(d.cost_basis)); return isNaN(v) ? '' : v.toFixed(2); }
            case 'php_total': {
                const wt = parseFloat(String(d.weight_kg)) || 0;
                const price = parseFloat(String(d.cost_basis)) || 0;
                return (wt * price).toFixed(2);
            }
            default: return '';
        }
    }, [rows, visibleColumns]);

    const getNumericCellValue = React.useCallback((rowIdx: number, colIdx: number): number | null => {
        const row = rows[rowIdx];
        if (!row) return null;
        const d = row.original;
        const col = visibleColumns[colIdx];
        if (!col) return null;

        switch (col.id) {
            case 'weight_kg': return parseFloat(String(d.weight_kg)) || null;
            case 'sacks': return d.sacks != null ? Number(d.sacks) : null;
            case 'mc': return d.lab_results?.mc ?? null;
            case 'grit': return d.lab_results?.grit ?? null;
            case 'bd_astm': return d.lab_results?.bd_astm ?? null;
            case 'bd_jis': return d.lab_results?.bd_jis ?? null;
            case 'vm': return d.lab_results?.vm ?? null;
            case 'ash': return d.lab_results?.ash ?? null;
            case 'fc': return d.lab_results?.fc ?? null;
            case 'cost_basis': { const v = parseFloat(String(d.cost_basis)); return isNaN(v) ? null : v; }
            case 'php_total': {
                const wt = parseFloat(String(d.weight_kg)) || 0;
                const price = parseFloat(String(d.cost_basis)) || 0;
                const total = wt * price;
                return total > 0 ? total : null;
            }
            default: return null;
        }
    }, [rows, visibleColumns]);

    const getColumnDefaultCalcType = React.useCallback((colIdx: number): AggregationType | null => {
        const col = visibleColumns[colIdx];
        if (!col) return null;
        switch (col.id) {
            case 'weight_kg': case 'sacks': case 'php_total': return 'SUM';
            case 'mc': case 'grit': case 'bd_astm': case 'bd_jis': case 'vm': case 'ash': case 'fc':
            case 'cost_basis': return 'AVERAGE';
            default: return null;
        }
    }, [visibleColumns]);

    const aggregates = useCellAggregation({ range: cellSelection.range, getNumericCellValue, getColumnDefaultCalcType });

    // Push cell selection count + aggregates to shared context
    React.useEffect(() => {
        const count = cellSelection.range && !selectionMode ? selectionSize : 0;
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

    // Clear cell selection when filters/sorting change
    React.useEffect(() => { cellSelection.clearSelection(); }, [filteredData]);
    React.useEffect(() => { cellSelection.clearSelection(); }, [sorting]);

    // Clear cell selection when clicking outside the scroll container
    React.useEffect(() => {
        if (!cellSelection.range) return;
        const handleClickOutside = (e: MouseEvent) => {
            const container = tableContainerRef.current;
            if (container && !container.contains(e.target as Node)) {
                const target = e.target as HTMLElement;
                if (target.closest?.('[data-floating-status-bar]') || target.closest?.('[data-radix-popper-content-wrapper]')) return;
                cellSelection.clearSelection();
            }
        };
        document.addEventListener('mousedown', handleClickOutside);
        return () => document.removeEventListener('mousedown', handleClickOutside);
    }, [cellSelection.range, cellSelection.clearSelection]);

    // Clear cell selection on Escape key
    React.useEffect(() => {
        if (!cellSelection.range) return;
        const handleEscape = (e: KeyboardEvent) => {
            if (e.key === 'Escape') cellSelection.clearSelection();
        };
        document.addEventListener('keydown', handleEscape);
        return () => document.removeEventListener('keydown', handleEscape);
    }, [cellSelection.range, cellSelection.clearSelection]);

    // ─── Auto-Edit from Blocking Panel ───────────────────────────────────
    React.useEffect(() => {
        const params = new URLSearchParams(window.location.search);
        const editBatch = params.get('editBatch');
        if (editBatch && data.length > 0) {
            const matchingIds = data.filter(d => d.batch_code === editBatch).map(d => d.id);
            if (matchingIds.length > 0) {
                setSelectionMode(true);
                setSelectedIds(new Set(matchingIds));
                // Trigger bulk edit after a tick (let selection state settle)
                setTimeout(() => {
                    const matchingRows = data.filter(d => matchingIds.includes(d.id));
                    setEditRows(matchingRows);
                }, 100);
                // Clean up URL
                params.delete('editBatch');
                const qs = params.toString();
                window.history.replaceState(null, '', qs ? pathname + '?' + qs : pathname);
            }
        }
    }, [data]); // eslint-disable-line react-hooks/exhaustive-deps

    // ─── Footer Totals ────────────────────────────────────────────────────────

    const filteredRows = table.getFilteredRowModel().rows;
    const { totalWeight, totalAmount } = React.useMemo(() =>
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
    const visiblePrefixCount = React.useMemo(
        () => PREFIX_COLUMN_IDS.filter(id => !hiddenColumnsSet.has(id)).length,
        [hiddenColumnsSet]
    );

    // ─── Status Text ──────────────────────────────────────────────────────────

    const statusText = React.useMemo(() => {
        const count = filteredData.length;
        const displayYear = (yearParam === 'all' || search) ? 'All Years' : yearParam;
        const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

        if (search) {
            return <span>Found <span className="font-semibold text-foreground">{count}</span> results for &ldquo;<span className="font-semibold text-foreground">{search}</span>&rdquo; in <span className="font-semibold text-foreground">{displayYear}</span></span>;
        }
        if (month === 'all') {
            return <span><span className="font-semibold text-foreground">{count}</span> records &middot; <span className="font-semibold text-foreground">{displayYear}</span> (All Months)</span>;
        }
        return <span><span className="font-semibold text-foreground">{count}</span> records &middot; <span className="font-semibold text-foreground">{MONTH_NAMES[parseInt(month)]} {displayYear}</span></span>;
    }, [filteredData.length, search, month, yearParam]);

    // ─── Compute table minimum width ──────────────────────────────────────────

    const tableMinWidth = React.useMemo(() => {
        return columns.reduce((sum, col) => {
            const id = col.id || (col as { accessorKey?: string }).accessorKey || '';
            return sum + (columnSizing[id] || getDefaultColWidth(id, density));
        }, 0);
    }, [columns, columnSizing, density]);

    // ─── Render ───────────────────────────────────────────────────────────────

    return (
        <TooltipProvider delayDuration={200}>
            <div className="flex flex-col h-full space-y-0">
                {/* ─── Dialogs ─── */}

                {/* Add Delivery Dialog */}
                <Dialog open={isAddOpen} onOpenChange={(open) => { if (!open) handleCloseAdd(); }}>
                    <DialogContent
                        onEscapeKeyDown={(e) => e.preventDefault()}
                        onInteractOutside={(e) => e.preventDefault()}
                        className="sm:max-w-[98vw] w-full p-0 overflow-hidden flex flex-col max-h-[95vh] border-none shadow-xl"
                    >
                        <DialogHeader className="p-4 py-2 shrink-0 bg-background/90 backdrop-blur-sm border-b z-50 flex flex-row items-center justify-between space-y-0">
                            <div>
                                <DialogTitle>Add Deliveries</DialogTitle>
                                <DialogDescription>Enter delivery details below.</DialogDescription>
                            </div>
                            <Button variant="ghost" size="icon" onClick={handleCloseAdd}>
                                <X className="h-4 w-4" />
                            </Button>
                        </DialogHeader>
                        <div className="flex-1 overflow-auto p-6 pt-2">
                            <BulkDeliveryInput
                                batches={batches}
                                suppliers={allSuppliers}
                                onSuccess={() => { setIsAddOpen(false); handleRefresh(); }}
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
                        <DialogHeader className="p-4 py-2 shrink-0 bg-background/90 backdrop-blur-sm border-b z-50 flex flex-row items-center justify-between space-y-0">
                            <div>
                                <DialogTitle>Edit Deliver{editRows?.length === 1 ? 'y' : 'ies'}</DialogTitle>
                                <DialogDescription>Modify delivery details below.</DialogDescription>
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
                                    onSuccess={() => { setEditRows(null); setSelectedIds(new Set()); handleRefresh(); }}
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
                            <DialogDescription>You have unsaved changes. Are you sure you want to discard them and exit?</DialogDescription>
                        </DialogHeader>
                        <div className="flex justify-end space-x-2 pt-4">
                            <Button variant="outline" onClick={() => setShowExitConfirmation(false)}>Cancel</Button>
                            <Button variant="destructive" onClick={confirmExit}>Discard & Exit</Button>
                        </div>
                    </DialogContent>
                </Dialog>

                {/* Delivery History Dialog */}
                <DeliveryHistoryDialog
                    open={historyOpen}
                    deliveryId={historyDelivery?.id ?? null}
                    initialData={historyDelivery}
                    onOpenChange={setHistoryOpen}
                />

                {/* Settings Dialog */}
                <SettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} />

                {/* ─── Toolbar ─── */}
                <div className="flex-none h-10 px-4 flex items-center border-b bg-background gap-2 shrink-0">
                    {/* Left group: Search + Clear filters */}
                    <div className="flex items-center gap-1.5">
                        {/* Search */}
                        <div className="relative">
                            <Search className="absolute left-2 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground" />
                            <Input
                                placeholder="Search supplier, batch, truck..."
                                value={searchTerm}
                                onChange={(e) => setSearchTerm(e.target.value)}
                                onFocus={() => setIsSearchFocused(true)}
                                onBlur={() => setIsSearchFocused(false)}
                                className="h-7 w-[220px] pl-7 text-xs"
                            />
                        </div>
                        {searchTerm && (
                            <span className="bg-primary/10 text-primary text-[10px] rounded-full px-1.5 font-medium">
                                {filteredData.length} found
                            </span>
                        )}

                        {/* Clear all filters (only visible when any header filter is active) */}
                        {hasActiveFilters && (
                            <Button
                                variant="ghost"
                                size="sm"
                                className="h-7 px-2 text-xs text-muted-foreground hover:text-foreground"
                                onClick={clearAllFilters}
                            >
                                <X className="mr-1 h-3 w-3" />
                                Clear filters
                            </Button>
                        )}
                    </div>

                    {/* Spacer */}
                    <div className="flex-1" />

                    {/* Right group: Density + Columns + Settings + Select + Add + Refresh */}
                    <div className="flex items-center gap-1">
                        <DensityToggle value={density} onChange={setDensity} />

                        <ColumnsPopover
                            hiddenColumns={settings.hiddenColumns}
                            onToggle={toggleColumn}
                            onShowAll={showAllColumns}
                        />

                        <Button
                            variant="ghost"
                            size="sm"
                            className="h-7 px-2 text-xs gap-1.5"
                            onClick={() => setSettingsOpen(true)}
                        >
                            <SlidersHorizontal className="size-3.5" />
                            Settings
                        </Button>

                        <Button
                            variant={selectionMode ? "default" : "ghost"}
                            size="sm"
                            className="h-7 px-2 text-xs gap-1.5"
                            onClick={() => {
                                setSelectionMode(prev => !prev);
                                if (selectionMode) setSelectedIds(new Set());
                                else cellSelection.clearSelection();
                            }}
                        >
                            <CheckSquare className="size-3.5" />
                            Select
                        </Button>

                        <Button onClick={() => setIsAddOpen(true)} size="sm" className="h-7 px-2 text-xs gap-1.5">
                            <Plus className="size-3.5" />
                            Add
                        </Button>

                        <Tooltip>
                            <TooltipTrigger asChild>
                                <Button
                                    variant="ghost"
                                    size="icon"
                                    className="h-7 w-7"
                                    onClick={handleRefresh}
                                    disabled={refreshing}
                                >
                                    <RefreshCw className={cn("size-3.5", refreshing && "animate-spin")} />
                                </Button>
                            </TooltipTrigger>
                            <TooltipContent side="bottom">Refresh data</TooltipContent>
                        </Tooltip>
                    </div>
                </div>

                {/* ─── Selection Mode Bar ─── */}
                {selectionMode && (
                    <div className="flex-none flex items-center gap-3 px-3 py-1.5 border-b bg-muted/50 text-sm animate-fade-up">
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

                {/* ─── Scrollable Table ─── */}
                <div className="flex-1 min-h-0 overflow-hidden flex flex-col relative bg-background">
                    {/* Loading Overlay */}
                    {isYearLoading && (
                        <div className="absolute inset-0 z-60 bg-background/50 backdrop-blur-sm flex items-center justify-center animate-blur-in">
                            <div className="flex flex-col items-center gap-2">
                                <Loader2 className="h-8 w-8 animate-spin text-primary" />
                                <span className="text-sm font-medium text-muted-foreground">Loading Data...</span>
                            </div>
                        </div>
                    )}

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
                            <table
                                className={cn('w-full caption-bottom table-fixed relative border-collapse', fontSizeClass)}
                                style={{ minWidth: tableMinWidth }}
                            >
                                {/* ─── Header ─── */}
                                <thead className="bg-muted/90 backdrop-blur-sm sticky top-0 z-20 shadow-sm border-b">
                                    {table.getHeaderGroups().map((headerGroup) => (
                                        <tr key={headerGroup.id} className="border-b border-border/50">
                                            {headerGroup.headers.map((header) => {
                                                const isNumeric = ['sacks', 'weight_kg', 'mc', 'grit', 'bd_astm', 'bd_jis', 'vm', 'ash', 'fc', 'cost_basis', 'php_total'].includes(header.id);
                                                return (
                                                    <th
                                                        key={header.id}
                                                        className={cn(
                                                            'h-8 font-semibold text-muted-foreground relative group border-r border-border/40 last:border-r-0',
                                                            cellPaddingClass,
                                                            isNumeric ? 'text-right' : 'text-left',
                                                        )}
                                                        style={{ width: header.getSize() }}
                                                        onContextMenu={(e) => {
                                                            e.preventDefault();
                                                            const colId = header.column.id;
                                                            let x = e.clientX;
                                                            let y = e.clientY;
                                                            if (x + POPUP_WIDTH > window.innerWidth) x = x - POPUP_WIDTH;
                                                            if (y + POPUP_HEIGHT > window.innerHeight) y = y - POPUP_HEIGHT;
                                                            setColumnPopupState({ colId, x, y });
                                                        }}
                                                    >
                                                        {header.isPlaceholder
                                                            ? null
                                                            : flexRender(header.column.columnDef.header, header.getContext())}
                                                        {/* Column resize handle */}
                                                        {header.column.getCanResize() && (
                                                            <div
                                                                onMouseDown={header.getResizeHandler()}
                                                                onTouchStart={header.getResizeHandler()}
                                                                className={cn(
                                                                    'absolute right-0 top-0 h-full w-1 cursor-col-resize select-none touch-none',
                                                                    'opacity-0 group-hover:opacity-100 transition-opacity duration-150',
                                                                    header.column.getIsResizing() && 'opacity-100 bg-primary'
                                                                )}
                                                            />
                                                        )}
                                                    </th>
                                                );
                                            })}
                                        </tr>
                                    ))}
                                </thead>

                                {/* ─── Body ─── */}
                                <tbody>
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
                                                        <tr
                                                            key={row.id}
                                                            data-state={isSelected ? "selected" : undefined}
                                                            className={cn(
                                                                rowHeightClass,
                                                                'border-b border-border/30 transition-all duration-150 hover:bg-muted/50',
                                                                selectionMode && 'cursor-pointer',
                                                                isSelected && 'bg-primary/5'
                                                            )}
                                                            style={{ height: `${rowHeight}px` }}
                                                            onClick={() => {
                                                                if (selectionMode) {
                                                                    toggleSelect(row.original.id);
                                                                }
                                                            }}
                                                            onContextMenu={(e) => {
                                                                e.preventDefault();
                                                                if (selectionMode && !selectedIds.has(row.original.id)) {
                                                                    setSelectedIds(prev => new Set(prev).add(row.original.id));
                                                                }
                                                                openPopup(row.original.id, e.clientX, e.clientY);
                                                            }}
                                                        >
                                                            {row.getVisibleCells().map((cell, cellIndex) => {
                                                                const colId = cell.column.id;
                                                                const isLabCol = LAB_KEYS.has(colId);
                                                                let heatTintClass = '';
                                                                if (isLabCol) {
                                                                    const val = row.original.lab_results?.[colId as keyof DeliveryHistoryRow['lab_results']];
                                                                    if (val != null) {
                                                                        heatTintClass = getLabHighlightBg(colId as LabMetric, Number(val), labHighlights);
                                                                    }
                                                                }

                                                                const isNumeric = ['sacks', 'weight_kg', 'mc', 'grit', 'bd_astm', 'bd_jis', 'vm', 'ash', 'fc', 'cost_basis', 'php_total'].includes(colId);

                                                                const fmt = settings.columnFormats[colId];
                                                                const fmtClasses = cn(
                                                                    fmt?.bold && 'font-bold',
                                                                    fmt?.italic && 'italic',
                                                                    fmt?.underline && 'underline',
                                                                );

                                                                return (
                                                                    <td
                                                                        key={cell.id}
                                                                        className={cn(
                                                                            cellPaddingClass,
                                                                            'align-middle whitespace-nowrap border-r border-border/10',
                                                                            isNumeric && 'font-mono text-right',
                                                                            heatTintClass,
                                                                            fmtClasses,
                                                                            !selectionMode && cellSelection.isSelected(virtualRow.index, cellIndex) && 'bg-primary/10 dark:bg-primary/20',
                                                                            !selectionMode && cellSelection.isAnchor(virtualRow.index, cellIndex) && 'ring-2 ring-primary ring-inset'
                                                                        )}
                                                                        style={{ height: `${rowHeight}px` }}
                                                                        onMouseDown={!selectionMode ? (e) => {
                                                                            e.preventDefault();
                                                                            e.stopPropagation();
                                                                            cellSelection.handleCellMouseDown(virtualRow.index, cellIndex, e);
                                                                            tableContainerRef.current?.focus({ preventScroll: true });
                                                                        } : undefined}
                                                                        onMouseEnter={cellSelection.isDragging && !selectionMode ? () => cellSelection.handleCellMouseEnter(virtualRow.index, cellIndex) : undefined}
                                                                    >
                                                                        {flexRender(cell.column.columnDef.cell, cell.getContext())}
                                                                    </td>
                                                                );
                                                            })}
                                                        </tr>
                                                    );
                                                })}
                                                {paddingBottom > 0 && (
                                                    <tr><td style={{ height: `${paddingBottom}px`, padding: 0, border: 0 }} /></tr>
                                                )}
                                            </>
                                        );
                                    })() : (
                                        <tr>
                                            <td colSpan={columns.length} className="h-24 text-center">
                                                <span className="animate-fade-up text-muted-foreground">No results.</span>
                                            </td>
                                        </tr>
                                    )}
                                </tbody>

                                {/* ─── Conditional TOTALS Footer ─── */}
                                {hasActiveFilters && (
                                    <tfoot className="bg-muted/90 backdrop-blur-sm font-medium sticky bottom-0 z-20 shadow-[0_-4px_6px_-1px_rgba(0,0,0,0.1)] border-t border-border/50 animate-slide-up">
                                        <tr className={cn(rowHeightClass, 'font-mono font-semibold')}>
                                            {/* TOTALS label */}
                                            {visiblePrefixCount > 0 && (
                                                <td colSpan={visiblePrefixCount} className={cn(cellPaddingClass, 'text-right font-mono font-bold')}>
                                                    TOTALS
                                                </td>
                                            )}
                                            {/* Weight */}
                                            {!hiddenColumnsSet.has('weight_kg') && (
                                                <td className={cn(cellPaddingClass, 'text-right font-mono')}>
                                                    {totalWeight > 0 ? (
                                                        <Tooltip>
                                                            <TooltipTrigger asChild>
                                                                <span>{formatCompact(Math.round(totalWeight), 2)}</span>
                                                            </TooltipTrigger>
                                                            <TooltipContent side="top">{Math.round(totalWeight).toLocaleString()}</TooltipContent>
                                                        </Tooltip>
                                                    ) : '-'}
                                                </td>
                                            )}
                                            {/* Sacks */}
                                            {!hiddenColumnsSet.has('sacks') && (
                                                <td className={cn(cellPaddingClass, 'text-right font-mono')} />
                                            )}
                                            {/* Lab weighted averages */}
                                            {LAB_COLUMNS.filter(({ key }) => !hiddenColumnsSet.has(key)).map(({ key, decimals }) => (
                                                <td key={key} className={cn(cellPaddingClass, 'text-right font-mono')}>
                                                    {labAverages[key] > 0 ? (
                                                        <Tooltip>
                                                            <TooltipTrigger asChild>
                                                                <span>{formatCompact(labAverages[key], decimals)}</span>
                                                            </TooltipTrigger>
                                                            <TooltipContent side="top">{labAverages[key].toFixed(decimals)}</TooltipContent>
                                                        </Tooltip>
                                                    ) : '-'}
                                                </td>
                                            ))}
                                            {/* Remarks */}
                                            {!hiddenColumnsSet.has('remarks') && (
                                                <td className={cellPaddingClass} />
                                            )}
                                            {/* PHP/KG */}
                                            {canViewPrices && !hiddenColumnsSet.has('cost_basis') && (
                                                <td className={cn(cellPaddingClass, 'font-mono')}>
                                                    {totalWeight > 0 ? (
                                                        <Tooltip>
                                                            <TooltipTrigger asChild>
                                                                <div className="flex items-center justify-between">
                                                                    <span className="text-muted-foreground">&#8369;</span>
                                                                    <span>{formatCompact(totalAmount / totalWeight, 2)}</span>
                                                                </div>
                                                            </TooltipTrigger>
                                                            <TooltipContent side="top">
                                                                {(totalAmount / totalWeight).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                                                            </TooltipContent>
                                                        </Tooltip>
                                                    ) : (
                                                        <div className="flex items-center justify-between">
                                                            <span className="text-muted-foreground">&#8369;</span>
                                                            <span>-</span>
                                                        </div>
                                                    )}
                                                </td>
                                            )}
                                            {/* PHP Total */}
                                            {canViewPrices && !hiddenColumnsSet.has('php_total') && (
                                                <td className={cn(cellPaddingClass, 'font-mono')}>
                                                    {totalAmount > 0 ? (
                                                        <Tooltip>
                                                            <TooltipTrigger asChild>
                                                                <div className="flex items-center justify-between">
                                                                    <span className="text-muted-foreground">&#8369;</span>
                                                                    <span>{formatCompact(totalAmount, 2)}</span>
                                                                </div>
                                                            </TooltipTrigger>
                                                            <TooltipContent side="top">
                                                                {totalAmount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                                                            </TooltipContent>
                                                        </Tooltip>
                                                    ) : (
                                                        <div className="flex items-center justify-between">
                                                            <span className="text-muted-foreground">&#8369;</span>
                                                            <span>-</span>
                                                        </div>
                                                    )}
                                                </td>
                                            )}
                                        </tr>
                                    </tfoot>
                                )}
                            </table>
                        </div>
                    </div>

                    {/* Footer Navigation */}
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

                {/* ─── Row Context Menu ─── */}
                {popupState && (() => {
                    const isMultiSelected = selectionMode && selectedIds.size > 1 && selectedIds.has(popupState.rowId);

                    if (isMultiSelected) {
                        return (
                            <div
                                data-row-popup
                                className="fixed z-50 bg-popover/95 backdrop-blur-lg border rounded-md shadow-lg py-1 min-w-[200px] animate-fade-in"
                                style={{ left: popupState.x, top: popupState.y }}
                            >
                                <button
                                    className="w-full flex items-center gap-2 py-1.5 px-2 text-xs hover:bg-accent transition-colors duration-150 cursor-pointer"
                                    onClick={() => {
                                        handleBulkEdit();
                                        setPopupState(null);
                                    }}
                                >
                                    <Pencil className="size-3.5 text-muted-foreground" />
                                    <span>Edit Selected ({selectedIds.size})</span>
                                </button>
                                <button
                                    className="w-full flex items-center gap-2 py-1.5 px-2 text-xs hover:bg-accent transition-colors duration-150 cursor-pointer"
                                    onClick={() => {
                                        // Copy all selected rows as TSV
                                        const selectedRowData = rows.filter(r => selectedIds.has(r.original.id));
                                        const tsvLines = selectedRowData.map(r => {
                                            return visibleColumns.map((_, colIdx) => getCellValue(r.index, colIdx)).join('\t');
                                        });
                                        navigator.clipboard.writeText(tsvLines.join('\n')).then(() => {
                                            toast.success(`${selectedIds.size} rows copied to clipboard`);
                                        });
                                        setPopupState(null);
                                    }}
                                >
                                    <Copy className="size-3.5 text-muted-foreground" />
                                    <span>Copy Selected ({selectedIds.size})</span>
                                </button>
                                <div className="my-1 border-t border-border/50" />
                                <button
                                    className="w-full flex items-center gap-2 py-1.5 px-2 text-xs hover:bg-accent transition-colors duration-150 cursor-pointer"
                                    onClick={() => {
                                        const allIds = new Set(rows.map(r => r.original.id));
                                        setSelectedIds(allIds);
                                        setPopupState(null);
                                    }}
                                >
                                    <CheckSquare className="size-3.5 text-muted-foreground" />
                                    <span>Select All</span>
                                </button>
                                <button
                                    className="w-full flex items-center gap-2 py-1.5 px-2 text-xs hover:bg-accent transition-colors duration-150 cursor-pointer"
                                    onClick={() => {
                                        setSelectedIds(new Set());
                                        setPopupState(null);
                                    }}
                                >
                                    <Square className="size-3.5 text-muted-foreground" />
                                    <span>Deselect All</span>
                                </button>
                                {hasPermission('delete:all') && (
                                    <>
                                        <div className="my-1 border-t border-border/50" />
                                        <button
                                            className="w-full flex items-center gap-2 py-1.5 px-2 text-xs text-destructive hover:bg-accent transition-colors duration-150 cursor-pointer"
                                            onClick={() => {
                                                setPopupState(null);
                                                handleBulkDelete();
                                            }}
                                        >
                                            <Trash2 className="size-3.5" />
                                            <span>Delete Selected ({selectedIds.size})</span>
                                        </button>
                                    </>
                                )}
                            </div>
                        );
                    }

                    // Default single-row context menu
                    return (
                        <div
                            data-row-popup
                            className="fixed z-50 bg-popover/95 backdrop-blur-lg border rounded-md shadow-lg py-1 min-w-[200px] animate-fade-in"
                            style={{ left: popupState.x, top: popupState.y }}
                        >
                            <button
                                className="w-full flex items-center gap-2 py-1.5 px-2 text-xs hover:bg-accent transition-colors duration-150 cursor-pointer"
                                onClick={() => {
                                    const delivery = data.find(d => d.id === popupState.rowId);
                                    if (delivery) handleViewHistory(delivery);
                                    setPopupState(null);
                                }}
                            >
                                <FileText className="size-3.5 text-muted-foreground" />
                                <span>View Details</span>
                            </button>
                            <button
                                className="w-full flex items-center gap-2 py-1.5 px-2 text-xs hover:bg-accent transition-colors duration-150 cursor-pointer"
                                onClick={() => {
                                    const delivery = data.find(d => d.id === popupState.rowId);
                                    if (delivery) handleSingleEdit(delivery);
                                    setPopupState(null);
                                }}
                            >
                                <Pencil className="size-3.5 text-muted-foreground" />
                                <span>Edit Delivery</span>
                            </button>
                            <button
                                className="w-full flex items-center gap-2 py-1.5 px-2 text-xs hover:bg-accent transition-colors duration-150 cursor-pointer"
                                onClick={() => {
                                    if (!selectionMode) {
                                        setSelectionMode(true);
                                        setSelectedIds(new Set([popupState.rowId]));
                                        cellSelection.clearSelection();
                                    } else {
                                        toggleSelect(popupState.rowId);
                                    }
                                    setPopupState(null);
                                }}
                            >
                                <CheckSquare className="size-3.5 text-muted-foreground" />
                                <span>Select Row</span>
                            </button>
                            <button
                                className="w-full flex items-center gap-2 py-1.5 px-2 text-xs hover:bg-accent transition-colors duration-150 cursor-pointer"
                                onClick={() => {
                                    const delivery = data.find(d => d.id === popupState.rowId);
                                    if (delivery) {
                                        const row = rows.find(r => r.original.id === popupState.rowId);
                                        if (row) {
                                            const values = visibleColumns.map((_, colIdx) => getCellValue(row.index, colIdx));
                                            navigator.clipboard.writeText(values.join('\t')).then(() => {
                                                toast.success('Row copied to clipboard');
                                            });
                                        }
                                    }
                                    setPopupState(null);
                                }}
                            >
                                <Copy className="size-3.5 text-muted-foreground" />
                                <span>Copy Row</span>
                            </button>
                            <button
                                className="w-full flex items-center gap-2 py-1.5 px-2 text-xs hover:bg-accent transition-colors duration-150 cursor-pointer"
                                onClick={() => {
                                    const delivery = data.find(d => d.id === popupState.rowId);
                                    if (delivery?.supplier) {
                                        const next = new Set(supIncluded);
                                        next.add(delivery.supplier);
                                        setFilters(prev => ({ ...prev, supIncluded: next }));
                                        syncInclusionToUrl('sup', next);
                                        if (next.size > 0 && yearParam !== 'all') {
                                            if (preFilterDate.current === null) {
                                                preFilterDate.current = { year: yearParam, month };
                                            }
                                            handleYearChange('all', buildFilterOverrides('sup', next));
                                        }
                                    }
                                    setPopupState(null);
                                }}
                            >
                                <Filter className="size-3.5 text-muted-foreground" />
                                <span>Filter by Supplier</span>
                            </button>
                            <button
                                className="w-full flex items-center gap-2 py-1.5 px-2 text-xs hover:bg-accent transition-colors duration-150 cursor-pointer"
                                onClick={() => {
                                    const delivery = data.find(d => d.id === popupState.rowId);
                                    const loc = delivery?.block_loc || delivery?.batches?.location_ref;
                                    if (loc) {
                                        const next = new Set(locIncluded);
                                        next.add(loc);
                                        setFilters(prev => ({ ...prev, locIncluded: next }));
                                        syncInclusionToUrl('loc', next);
                                        if (next.size > 0 && yearParam !== 'all') {
                                            if (preFilterDate.current === null) {
                                                preFilterDate.current = { year: yearParam, month };
                                            }
                                            handleYearChange('all', buildFilterOverrides('loc', next));
                                        }
                                    }
                                    setPopupState(null);
                                }}
                            >
                                <Filter className="size-3.5 text-muted-foreground" />
                                <span>Filter by Batch</span>
                            </button>
                            {hasPermission('delete:all') && (
                                <>
                                    <div className="my-1 border-t border-border/50" />
                                    <button
                                        className="w-full flex items-center gap-2 py-1.5 px-2 text-xs text-destructive hover:bg-accent transition-colors duration-150 cursor-pointer"
                                        onClick={async () => {
                                            const id = popupState.rowId;
                                            setPopupState(null);
                                            if (confirm('Are you sure you want to delete this delivery?')) {
                                                const res = await deleteDelivery(id);
                                                if (res.success) {
                                                    toast.success('Delivery deleted');
                                                    handleRefresh();
                                                } else {
                                                    toast.error('Delete failed: ' + res.message);
                                                }
                                            }
                                        }}
                                    >
                                        <Trash2 className="size-3.5" />
                                        <span>Delete Delivery</span>
                                    </button>
                                </>
                            )}
                        </div>
                    );
                })()}

                {/* ─── Column Context Menu ─── */}
                {columnPopupState && (
                    <div
                        data-column-popup
                        className="fixed z-50 bg-popover/95 backdrop-blur-lg border rounded-md shadow-lg py-1 min-w-[180px] animate-fade-in"
                        style={{ left: columnPopupState.x, top: columnPopupState.y }}
                    >
                        <button
                            className="w-full flex items-center gap-2 py-1.5 px-2 text-xs hover:bg-accent transition-colors duration-150 cursor-pointer"
                            onClick={() => {
                                const col = table.getColumn(columnPopupState.colId);
                                if (col) col.toggleSorting(false);
                                setColumnPopupState(null);
                            }}
                        >
                            <ArrowUp className="size-3.5 text-muted-foreground" />
                            <span>Sort Ascending</span>
                        </button>
                        <button
                            className="w-full flex items-center gap-2 py-1.5 px-2 text-xs hover:bg-accent transition-colors duration-150 cursor-pointer"
                            onClick={() => {
                                const col = table.getColumn(columnPopupState.colId);
                                if (col) col.toggleSorting(true);
                                setColumnPopupState(null);
                            }}
                        >
                            <ArrowDown className="size-3.5 text-muted-foreground" />
                            <span>Sort Descending</span>
                        </button>
                        <div className="my-1 border-t border-border/50" />
                        {(() => {
                            const fmt = settings.columnFormats[columnPopupState.colId] || {};
                            return (
                                <>
                                    <button
                                        className="w-full flex items-center justify-between py-1.5 px-2 text-xs hover:bg-accent transition-colors duration-150 cursor-pointer"
                                        onClick={() => {
                                            setColumnFormat(columnPopupState.colId, { bold: !fmt.bold });
                                        }}
                                    >
                                        <span className="flex items-center gap-2">
                                            <Bold className="size-3.5 text-muted-foreground" />
                                            <span>Bold</span>
                                        </span>
                                        {fmt.bold && <Check className="size-3.5 text-primary" />}
                                    </button>
                                    <button
                                        className="w-full flex items-center justify-between py-1.5 px-2 text-xs hover:bg-accent transition-colors duration-150 cursor-pointer"
                                        onClick={() => {
                                            setColumnFormat(columnPopupState.colId, { italic: !fmt.italic });
                                        }}
                                    >
                                        <span className="flex items-center gap-2">
                                            <Italic className="size-3.5 text-muted-foreground" />
                                            <span>Italic</span>
                                        </span>
                                        {fmt.italic && <Check className="size-3.5 text-primary" />}
                                    </button>
                                    <button
                                        className="w-full flex items-center justify-between py-1.5 px-2 text-xs hover:bg-accent transition-colors duration-150 cursor-pointer"
                                        onClick={() => {
                                            setColumnFormat(columnPopupState.colId, { underline: !fmt.underline });
                                        }}
                                    >
                                        <span className="flex items-center gap-2">
                                            <Underline className="size-3.5 text-muted-foreground" />
                                            <span>Underline</span>
                                        </span>
                                        {fmt.underline && <Check className="size-3.5 text-primary" />}
                                    </button>
                                </>
                            );
                        })()}
                        <div className="my-1 border-t border-border/50" />
                        <button
                            className="w-full flex items-center gap-2 py-1.5 px-2 text-xs hover:bg-accent transition-colors duration-150 cursor-pointer"
                            onClick={() => {
                                toggleColumn(columnPopupState.colId);
                                setColumnPopupState(null);
                            }}
                        >
                            <EyeOff className="size-3.5 text-muted-foreground" />
                            <span>Hide Column</span>
                        </button>
                        <button
                            className="w-full flex items-center gap-2 py-1.5 px-2 text-xs hover:bg-accent transition-colors duration-150 cursor-pointer"
                            onClick={() => {
                                const colId = columnPopupState.colId;
                                const defaultWidth = getDefaultColWidth(colId, density);
                                setColumnSizing(prev => ({ ...prev, [colId]: defaultWidth }));
                                setColumnWidth(colId, defaultWidth);
                                setColumnPopupState(null);
                            }}
                        >
                            <RotateCcw className="size-3.5 text-muted-foreground" />
                            <span>Reset Column Width</span>
                        </button>
                    </div>
                )}
            </div>
        </TooltipProvider>
    );
}

// ─── State Header Filter ──────────────────────────────────────────────────────

interface StateHeaderFilterProps {
    uniqueStates: string[];
    stateExcluded: Set<string>;
    onToggle: (value: string, exclude: boolean) => void;
    onSelectAll: () => void;
    onDeselectAll: () => void;
    onClear: () => void;
}

function StateHeaderFilter({ uniqueStates, stateExcluded, onToggle, onSelectAll, onDeselectAll, onClear }: StateHeaderFilterProps) {
    const isActive = stateExcluded.size > 0 && stateExcluded.size < uniqueStates.length;
    const activeCount = uniqueStates.length - stateExcluded.size;

    return (
        <Popover>
            <PopoverTrigger asChild>
                <button className="inline-flex items-center gap-1 cursor-pointer hover:text-foreground transition-colors duration-150 font-semibold text-muted-foreground">
                    State
                    <Filter className={cn(
                        'size-2.5 transition-opacity duration-150',
                        isActive ? 'opacity-100 text-primary' : 'opacity-40'
                    )} />
                    {isActive && (
                        <span className="bg-primary/15 text-primary text-[9px] rounded-full px-1 font-semibold leading-none py-0.5">
                            {activeCount}
                        </span>
                    )}
                </button>
            </PopoverTrigger>
            <PopoverContent align="start" className="w-[180px] p-2 z-30 bg-popover/95 backdrop-blur-lg">
                <div className="flex items-center justify-between mb-1 pb-1 border-b">
                    <button onClick={onSelectAll} className="text-[10px] text-muted-foreground hover:text-foreground cursor-pointer">Select All</button>
                    <button onClick={onDeselectAll} className="text-[10px] text-muted-foreground hover:text-foreground cursor-pointer">Deselect All</button>
                </div>
                {uniqueStates.map(s => (
                    <label key={s} className="flex items-center gap-2 px-1 py-1 text-xs rounded hover:bg-muted cursor-pointer">
                        <Checkbox
                            checked={!stateExcluded.has(s)}
                            onCheckedChange={(checked) => onToggle(s, !checked)}
                            className="h-3.5 w-3.5"
                        />
                        <span className="inline-flex items-center gap-1.5">
                            <span className={cn('inline-block w-1.5 h-1.5 rounded-full shrink-0', getStateDotClass(s))} />
                            <span className="uppercase text-[10px]">{s}</span>
                        </span>
                    </label>
                ))}
                {isActive && (
                    <div className="mt-1 pt-1 border-t">
                        <button onClick={onClear} className="text-[10px] text-muted-foreground hover:text-foreground cursor-pointer">Clear filter</button>
                    </div>
                )}
            </PopoverContent>
        </Popover>
    );
}

// ─── Supplier Header Filter ──────────────────────────────────────────────────

interface SupplierHeaderFilterProps {
    allSuppliers: string[];
    supIncluded: Set<string>;
    onToggle: (value: string) => void;
    onClear: () => void;
}

function SupplierHeaderFilter({ allSuppliers, supIncluded, onToggle, onClear }: SupplierHeaderFilterProps) {
    const filterCount = supIncluded.size;

    return (
        <Popover>
            <PopoverTrigger asChild>
                <button className="inline-flex items-center gap-1 cursor-pointer hover:text-foreground transition-colors duration-150 font-semibold text-muted-foreground">
                    Supplier
                    <Filter className={cn(
                        'size-2.5 transition-opacity duration-150',
                        filterCount > 0 ? 'opacity-100 text-primary' : 'opacity-40'
                    )} />
                    {filterCount > 0 && (
                        <span className="bg-primary/15 text-primary text-[9px] rounded-full px-1 font-semibold leading-none py-0.5">
                            {filterCount}
                        </span>
                    )}
                </button>
            </PopoverTrigger>
            <PopoverContent align="start" className="w-[220px] p-0 z-30 bg-popover/95 backdrop-blur-lg">
                {filterCount > 0 && (
                    <div className="flex items-center justify-end px-2 pt-2 pb-1 border-b">
                        <button onClick={onClear} className="text-[10px] text-muted-foreground hover:text-foreground cursor-pointer">Clear</button>
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
                                    onSelect={() => onToggle(s)}
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
    );
}

// ─── LOC Header Filter ────────────────────────────────────────────────────────

interface LocHeaderFilterProps {
    locsByWhse: Record<string, string[]>;
    activeLocFilters: Set<string>;
    onFiltersChange: (filters: Set<string>) => void;
}

function LocHeaderFilter({ locsByWhse, activeLocFilters, onFiltersChange }: LocHeaderFilterProps) {
    const [locFilterOpen, setLocFilterOpen] = React.useState(false);
    const filterCount = activeLocFilters.size;

    return (
        <Popover open={locFilterOpen} onOpenChange={setLocFilterOpen}>
            <PopoverTrigger asChild>
                <button className="inline-flex items-center gap-1 cursor-pointer hover:text-foreground transition-colors duration-150 font-semibold text-muted-foreground">
                    LOC
                    <Filter className={cn(
                        'size-2.5 transition-opacity duration-150',
                        filterCount > 0 ? 'opacity-100 text-primary' : 'opacity-40'
                    )} />
                    {filterCount > 0 && (
                        <span className="bg-primary/15 text-primary text-[9px] rounded-full px-1 font-semibold leading-none py-0.5">
                            {filterCount}
                        </span>
                    )}
                </button>
            </PopoverTrigger>
            <PopoverContent align="start" className="w-56 p-3 z-30 bg-popover/95 backdrop-blur-lg">
                <LocFilterContent
                    locsByWhse={locsByWhse}
                    activeLocFilters={activeLocFilters}
                    onFiltersChange={(next) => {
                        onFiltersChange(next);
                    }}
                />
            </PopoverContent>
        </Popover>
    );
}

// ─── LOC Filter Content ───────────────────────────────────────────────────────

interface LocFilterContentProps {
    locsByWhse: Record<string, string[]>;
    activeLocFilters: Set<string>;
    onFiltersChange: (filters: Set<string>) => void;
}

function LocFilterContent({ locsByWhse, activeLocFilters, onFiltersChange }: LocFilterContentProps) {
    const whseKeys = React.useMemo(() => Object.keys(locsByWhse).sort(), [locsByWhse]);
    const [expandedWhse, setExpandedWhse] = React.useState<Set<string>>(new Set());
    const filterCount = activeLocFilters.size;

    const toggleWhseExpanded = React.useCallback((whse: string) => {
        setExpandedWhse(prev => {
            const next = new Set(prev);
            if (next.has(whse)) next.delete(whse);
            else next.add(whse);
            return next;
        });
    }, []);

    const isWhseFullySelected = React.useCallback(
        (whse: string) => {
            const locs = locsByWhse[whse] ?? [];
            return locs.length > 0 && locs.every(loc => activeLocFilters.has(loc));
        },
        [locsByWhse, activeLocFilters]
    );

    const isWhsePartiallySelected = React.useCallback(
        (whse: string) => {
            const locs = locsByWhse[whse] ?? [];
            const selectedCount = locs.filter(loc => activeLocFilters.has(loc)).length;
            return selectedCount > 0 && selectedCount < locs.length;
        },
        [locsByWhse, activeLocFilters]
    );

    const toggleWhse = React.useCallback(
        (whse: string) => {
            const locs = locsByWhse[whse] ?? [];
            const allSelected = locs.every(loc => activeLocFilters.has(loc));
            const next = new Set(activeLocFilters);
            if (allSelected) {
                for (const loc of locs) next.delete(loc);
            } else {
                for (const loc of locs) next.add(loc);
            }
            onFiltersChange(next);
        },
        [locsByWhse, activeLocFilters, onFiltersChange]
    );

    const toggleLoc = React.useCallback(
        (loc: string) => {
            const next = new Set(activeLocFilters);
            if (next.has(loc)) next.delete(loc);
            else next.add(loc);
            onFiltersChange(next);
        },
        [activeLocFilters, onFiltersChange]
    );

    const clearAll = React.useCallback(() => {
        onFiltersChange(new Set());
    }, [onFiltersChange]);

    return (
        <>
            <div className="flex items-center justify-between mb-2">
                <p className="text-xs font-semibold text-muted-foreground">Filter by Location</p>
                {filterCount > 0 && (
                    <button
                        onClick={clearAll}
                        className="text-[10px] text-muted-foreground hover:text-foreground transition-colors duration-150 cursor-pointer"
                    >
                        Clear
                    </button>
                )}
            </div>

            <div className="flex flex-col gap-1 max-h-[320px] overflow-y-auto">
                {whseKeys.map(whse => {
                    const locs = locsByWhse[whse] ?? [];
                    const isExpanded = expandedWhse.has(whse);
                    const fullySelected = isWhseFullySelected(whse);
                    const partiallySelected = isWhsePartiallySelected(whse);

                    return (
                        <div key={whse}>
                            <div className="flex items-center gap-1.5 px-1 py-1 rounded hover:bg-muted/50">
                                <button
                                    className="size-4 flex items-center justify-center shrink-0 cursor-pointer"
                                    onClick={() => toggleWhseExpanded(whse)}
                                >
                                    {isExpanded ? (
                                        <ChevronDown className="size-3 text-muted-foreground" />
                                    ) : (
                                        <ChevronRight className="size-3 text-muted-foreground" />
                                    )}
                                </button>
                                <Checkbox
                                    checked={fullySelected ? true : partiallySelected ? 'indeterminate' : false}
                                    onCheckedChange={() => toggleWhse(whse)}
                                    className="size-3.5"
                                />
                                <span className="text-xs font-semibold">WHSE {whse}</span>
                                <span className="text-[10px] text-muted-foreground ml-auto">{locs.length} locs</span>
                            </div>

                            {isExpanded && (
                                <div className="ml-5 flex flex-col gap-0.5 mb-1">
                                    {locs.map(loc => (
                                        <label
                                            key={loc}
                                            className="flex items-center gap-2 px-1.5 py-0.5 rounded hover:bg-muted/50 cursor-pointer text-xs"
                                        >
                                            <Checkbox
                                                checked={activeLocFilters.has(loc)}
                                                onCheckedChange={() => toggleLoc(loc)}
                                                className="size-3"
                                            />
                                            <span className="font-mono text-[11px]">{loc}</span>
                                        </label>
                                    ))}
                                </div>
                            )}
                        </div>
                    );
                })}
            </div>
        </>
    );
}
