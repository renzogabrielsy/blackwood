'use client';

import * as React from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { format } from 'date-fns';
import { ChevronLeft, ChevronRight, Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from '@/components/ui/select';
import {
    Tooltip,
    TooltipContent,
    TooltipProvider,
    TooltipTrigger,
} from '@/components/ui/tooltip';
import type { RcMovementData, RcMovementDay, RcMovementRow } from './actions';

// ---------------------------------------------------------------------------
// Virtual list item types — day-header rows and lane rows live in one flat array
// ---------------------------------------------------------------------------

type VirtualItem =
    | { kind: 'day-header'; key: string; day: RcMovementDay }
    | { kind: 'lane'; key: string; row: RcMovementRow; day: RcMovementDay };

// ---------------------------------------------------------------------------
// Column structure — explicit pixel widths per the Excel Standard
// ---------------------------------------------------------------------------

type ColumnId =
    | 'date'
    | 'day'
    | 'ttlKg'
    | 'blocks'
    | 'startBal'
    | 'batchFed'
    | 'ttlFed'
    | 'pctLoss'
    | 'phpPerKg'
    | 'phpTotal'
    | 'status'
    | 'blockLoc';

interface ColumnSpec {
    id: ColumnId;
    label: string;
    width: number;
    priceGated?: boolean;
}

const COLUMNS: ColumnSpec[] = [
    { id: 'date',     label: 'DATE',      width: 100 },
    { id: 'day',      label: 'DAY',       width: 44 },
    { id: 'ttlKg',    label: 'TTL KG',    width: 88 },
    { id: 'blocks',   label: 'BLOCKS',    width: 120 },
    { id: 'startBal', label: 'START BAL', width: 88 },
    { id: 'batchFed', label: 'BATCH FED', width: 88 },
    { id: 'ttlFed',   label: 'TTL FED',   width: 88 },
    { id: 'pctLoss',  label: '% LOSS',    width: 76 },
    { id: 'phpPerKg', label: 'PHP/KG',    width: 88, priceGated: true },
    { id: 'phpTotal', label: 'PHP TTL',   width: 100, priceGated: true },
    { id: 'status',   label: 'STATUS',    width: 84 },
    { id: 'blockLoc', label: 'BLOCK LOC', width: 76 },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const MONTH_LABELS = [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December',
];

function buildYearOptions(): number[] {
    const currentYear = new Date().getFullYear();
    const years: number[] = [];
    for (let y = currentYear + 1; y >= 2010; y--) years.push(y);
    return years;
}

function formatInt(n: number | null | undefined): string {
    if (n === null || n === undefined || !Number.isFinite(n)) return '';
    return Math.round(n).toLocaleString();
}

function formatPct(n: number | null): string {
    if (n === null || n === undefined || !Number.isFinite(n)) return '';
    // pctLoss is a fractional residual (e.g. 0.018 = 1.80%)
    return (n * 100).toFixed(2) + '%';
}

function formatPhp(n: number | null): string {
    if (n === null || n === undefined || !Number.isFinite(n)) return '';
    return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function pctLossColorClass(pctLoss: number | null, status: 'active' | 'closed'): string {
    // Active rows: no color — italic + muted + * superscript already signals "provisional"
    if (status === 'active') return '';
    // Closed rows: color by final shrinkage band
    if (pctLoss === null || pctLoss === undefined) return 'text-muted-foreground';
    if (pctLoss < 0) return 'text-red-600 dark:text-red-400';               // over-consumed — data integrity issue
    if (pctLoss < 0.02) return '';                                            // <2% — clean closure
    if (pctLoss < 0.10) return 'text-amber-600 dark:text-amber-400';         // 2–10% — some shrinkage
    return 'text-red-600 dark:text-red-400';                                  // >10% — high shrinkage, investigate
}

// Flatten day groups into a single virtual list ordered [dayHeader, lane, lane, dayHeader, lane, ...]
function buildVirtualItems(days: RcMovementDay[]): VirtualItem[] {
    const items: VirtualItem[] = [];
    for (const day of days) {
        items.push({ kind: 'day-header', key: `dh:${day.date}`, day });
        for (let i = 0; i < day.rows.length; i++) {
            const row = day.rows[i];
            items.push({ kind: 'lane', key: `ln:${day.date}:${row.batchCode}:${i}`, row, day });
        }
    }
    return items;
}

// ---------------------------------------------------------------------------
// Main table component
// ---------------------------------------------------------------------------

interface RcMovementTableProps {
    data: RcMovementData;
    year: number;
    month: number;
    loading: boolean;
    onChangeMonth: (year: number, month: number) => void;
}

export function RcMovementTable({ data, year, month, loading, onChangeMonth }: RcMovementTableProps) {
    const { days, canViewPrices } = data;

    const visibleColumns = React.useMemo(
        () => COLUMNS.filter(c => (c.priceGated ? canViewPrices : true)),
        [canViewPrices],
    );
    const visibleColumnCount = visibleColumns.length;

    const virtualItems = React.useMemo(() => buildVirtualItems(days), [days]);

    // Stable totals across the entire fetched month
    const monthTotals = React.useMemo(() => {
        let ttlKg = 0;
        let ttlPhp = 0;
        let batchCount = 0;
        for (const d of days) {
            ttlKg += d.ttlKg;
            if (d.ttlPhp !== null) ttlPhp += d.ttlPhp;
            batchCount += d.laneCount;
        }
        return { ttlKg, ttlPhp: canViewPrices ? ttlPhp : null, batchCount, dayCount: days.length };
    }, [days, canViewPrices]);

    // Month navigation handlers
    const handlePrevMonth = React.useCallback(() => {
        const m = month - 1;
        if (m < 1) onChangeMonth(year - 1, 12);
        else onChangeMonth(year, m);
    }, [year, month, onChangeMonth]);

    const handleNextMonth = React.useCallback(() => {
        const m = month + 1;
        if (m > 12) onChangeMonth(year + 1, 1);
        else onChangeMonth(year, m);
    }, [year, month, onChangeMonth]);

    // Virtualizer setup
    const scrollRef = React.useRef<HTMLDivElement>(null);
    const HEADER_ROW_HEIGHT = 32;   // sticky column header
    const DAY_HEADER_HEIGHT = 28;   // day-summary divider
    const LANE_ROW_HEIGHT = 32;     // batch lane

    const rowVirtualizer = useVirtualizer({
        count: virtualItems.length,
        getScrollElement: () => scrollRef.current,
        estimateSize: (idx) => {
            const item = virtualItems[idx];
            return item?.kind === 'day-header' ? DAY_HEADER_HEIGHT : LANE_ROW_HEIGHT;
        },
        overscan: 12,
    });

    const monthLabel = `${MONTH_LABELS[month - 1]} ${year}`;
    const yearOptions = React.useMemo(() => buildYearOptions(), []);
    const isEmpty = !loading && virtualItems.length === 0;

    return (
        <TooltipProvider>
            <div className="flex flex-col h-full">
                {/* ── Top toolbar: refresh state + monthly totals ── */}
                <div className="flex-none flex items-center justify-between py-1.5 px-1">
                    <div className="text-xs text-muted-foreground font-mono">
                        {loading ? (
                            <span className="flex items-center gap-1.5">
                                <Loader2 className="h-3 w-3 animate-spin" />
                                Loading…
                            </span>
                        ) : isEmpty ? (
                            <span>No movement records</span>
                        ) : (
                            <span className="flex items-center gap-3">
                                <span>
                                    <span className="text-foreground/70">{monthTotals.dayCount}</span> day{monthTotals.dayCount === 1 ? '' : 's'}
                                </span>
                                <span className="text-border">·</span>
                                <span>
                                    <span className="text-foreground/70">{monthTotals.batchCount}</span> lane{monthTotals.batchCount === 1 ? '' : 's'}
                                </span>
                                <span className="text-border">·</span>
                                <span>
                                    TTL KG{' '}
                                    <span className="text-foreground font-bold">{formatInt(monthTotals.ttlKg)}</span>
                                </span>
                                {canViewPrices && monthTotals.ttlPhp !== null && (
                                    <>
                                        <span className="text-border">·</span>
                                        <span>
                                            <span className="text-muted-foreground">₱</span>
                                            <span className="text-foreground font-bold ml-1">{formatPhp(monthTotals.ttlPhp)}</span>
                                        </span>
                                    </>
                                )}
                            </span>
                        )}
                    </div>
                </div>

                {/* ── Table scroll container ── */}
                <div className="flex-1 min-h-0 rounded-md border overflow-hidden flex flex-col relative bg-background">
                    <div
                        ref={scrollRef}
                        className="flex-1 overflow-auto relative w-full"
                    >
                        <table className="w-full caption-bottom text-sm table-fixed relative border-collapse">
                            {/* Sticky column headers */}
                            <thead className="sticky top-0 z-40">
                                <tr className="bg-muted/90 backdrop-blur-sm border-b border-foreground/20">
                                    {visibleColumns.map(col => (
                                        <th
                                            key={col.id}
                                            scope="col"
                                            style={{ width: `${col.width}px`, height: `${HEADER_ROW_HEIGHT}px` }}
                                            className={cn(
                                                'px-2 text-xs font-mono font-bold text-foreground',
                                                'after:absolute after:right-0 after:top-0 after:bottom-0 after:w-px after:bg-foreground/20',
                                                'relative',
                                                col.id === 'blocks' || col.id === 'status' || col.id === 'blockLoc'
                                                    ? 'text-left'
                                                    : 'text-right',
                                            )}
                                        >
                                            {col.id === 'pctLoss' ? (
                                                <Tooltip>
                                                    <TooltipTrigger asChild>
                                                        <span className="cursor-help underline decoration-dotted decoration-muted-foreground/60 underline-offset-2">
                                                            {col.label}
                                                        </span>
                                                    </TooltipTrigger>
                                                    <TooltipContent side="top" className="max-w-xs text-xs">
                                                        % remaining of original batch intake. Provisional while active; freezes as final shrinkage at closure.
                                                    </TooltipContent>
                                                </Tooltip>
                                            ) : (
                                                col.label
                                            )}
                                        </th>
                                    ))}
                                </tr>
                            </thead>

                            <tbody>
                                {isEmpty ? (
                                    <tr>
                                        <td colSpan={visibleColumnCount} className="h-40 text-center align-middle">
                                            <span className="animate-fade-up text-sm text-muted-foreground">
                                                No movement recorded for {monthLabel}
                                            </span>
                                        </td>
                                    </tr>
                                ) : (() => {
                                    const items = rowVirtualizer.getVirtualItems();
                                    const paddingTop = items.length > 0 ? items[0].start : 0;
                                    const paddingBottom =
                                        items.length > 0
                                            ? rowVirtualizer.getTotalSize() - items[items.length - 1].end
                                            : 0;

                                    return (
                                        <>
                                            {paddingTop > 0 && (
                                                <tr>
                                                    <td style={{ height: `${paddingTop}px`, padding: 0, border: 0 }} colSpan={visibleColumnCount} />
                                                </tr>
                                            )}
                                            {items.map(virtualRow => {
                                                const item = virtualItems[virtualRow.index];
                                                if (!item) return null;

                                                if (item.kind === 'day-header') {
                                                    return (
                                                        <DayHeaderRow
                                                            key={item.key}
                                                            day={item.day}
                                                            canViewPrices={canViewPrices}
                                                            colSpan={visibleColumnCount}
                                                            height={DAY_HEADER_HEIGHT}
                                                        />
                                                    );
                                                }

                                                return (
                                                    <LaneRow
                                                        key={item.key}
                                                        row={item.row}
                                                        columns={visibleColumns}
                                                        height={LANE_ROW_HEIGHT}
                                                    />
                                                );
                                            })}
                                            {paddingBottom > 0 && (
                                                <tr>
                                                    <td style={{ height: `${paddingBottom}px`, padding: 0, border: 0 }} colSpan={visibleColumnCount} />
                                                </tr>
                                            )}
                                        </>
                                    );
                                })()}
                            </tbody>
                        </table>
                    </div>

                    {/* ── Month picker footer (DeliverySheetFooter-style glass) ── */}
                    <div
                        className={cn(
                            'flex-none flex items-center justify-between px-4 py-2 border-t',
                            'bg-background/95 backdrop-blur supports-backdrop-filter:bg-background/60 z-10',
                            'transition-all duration-200',
                            loading && 'opacity-60',
                        )}
                    >
                        <div className="text-xs text-muted-foreground font-mono">
                            Movement · {monthLabel}
                        </div>

                        <div className="flex items-center gap-2">
                            {/* Year selector */}
                            <Select
                                value={String(year)}
                                onValueChange={(v) => {
                                    const ny = parseInt(v, 10);
                                    if (!Number.isNaN(ny)) onChangeMonth(ny, month);
                                }}
                                disabled={loading}
                            >
                                <SelectTrigger className="h-8 w-[88px] text-xs font-mono">
                                    <SelectValue />
                                </SelectTrigger>
                                <SelectContent position="popper" className="max-h-60">
                                    {yearOptions.map(y => (
                                        <SelectItem key={y} value={String(y)} className="text-xs">
                                            {y}
                                        </SelectItem>
                                    ))}
                                </SelectContent>
                            </Select>

                            {/* Prev / month label / Next */}
                            <div className="flex items-center bg-muted/40 rounded-lg border border-border/50 p-1 h-9">
                                <Button
                                    variant="ghost"
                                    size="sm"
                                    className="h-7 w-7 p-0 hover:bg-muted/60"
                                    onClick={handlePrevMonth}
                                    disabled={loading}
                                    aria-label="Previous month"
                                >
                                    <ChevronLeft className="h-4 w-4" />
                                </Button>
                                <span className="px-3 text-xs font-mono font-medium min-w-[112px] text-center">
                                    {MONTH_LABELS[month - 1]} {year}
                                </span>
                                <Button
                                    variant="ghost"
                                    size="sm"
                                    className="h-7 w-7 p-0 hover:bg-muted/60"
                                    onClick={handleNextMonth}
                                    disabled={loading}
                                    aria-label="Next month"
                                >
                                    <ChevronRight className="h-4 w-4" />
                                </Button>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        </TooltipProvider>
    );
}

// ---------------------------------------------------------------------------
// Day-header row — single colSpan cell with summary
// ---------------------------------------------------------------------------

function DayHeaderRow({
    day,
    canViewPrices,
    colSpan,
    height,
}: {
    day: RcMovementDay;
    canViewPrices: boolean;
    colSpan: number;
    height: number;
}) {
    // Parse YYYY-MM-DD to a Date for nicer formatting (UTC-safe: build local without TZ shift)
    let dateLabel = day.date;
    try {
        const [yy, mm, dd] = day.date.split('-').map(n => parseInt(n, 10));
        if (!Number.isNaN(yy) && !Number.isNaN(mm) && !Number.isNaN(dd)) {
            dateLabel = format(new Date(yy, mm - 1, dd), 'MMM d, yyyy');
        }
    } catch {
        // fallback already set
    }

    return (
        <tr
            className="border-b border-foreground/10"
            style={{ height: `${height}px` }}
        >
            <td
                colSpan={colSpan}
                className="bg-muted/90 backdrop-blur-sm px-3 py-0"
                style={{ height: `${height}px` }}
            >
                <div className="flex items-center gap-2.5 text-xs font-mono">
                    <span className="text-foreground/80 font-bold">DAY {day.day}</span>
                    <span className="text-border">·</span>
                    <span className="text-foreground/80">{dateLabel}</span>
                    <span className="text-border">·</span>
                    <span className="text-muted-foreground">
                        TTL KG{' '}
                        <span className="text-foreground font-bold">{formatInt(day.ttlKg)}</span>
                    </span>
                    {canViewPrices && day.ttlPhp !== null && (
                        <>
                            <span className="text-border">·</span>
                            <span className="text-muted-foreground">
                                <span>₱</span>
                                <span className="text-foreground font-bold ml-1">{formatPhp(day.ttlPhp)}</span>
                            </span>
                        </>
                    )}
                    <span className="text-border">·</span>
                    <span className="text-muted-foreground">
                        {day.laneCount} lane{day.laneCount === 1 ? '' : 's'}
                    </span>
                </div>
            </td>
        </tr>
    );
}

// ---------------------------------------------------------------------------
// Lane row — one batch's movement on a given day
// ---------------------------------------------------------------------------

function LaneRow({
    row,
    columns,
    height,
}: {
    row: RcMovementRow;
    columns: ColumnSpec[];
    height: number;
}) {
    const isActive = row.status === 'active';

    return (
        <tr
            className="border-b border-border/40 last:border-0 hover:bg-muted/40 transition-all duration-150"
            style={{ height: `${height}px` }}
        >
            {columns.map(col => (
                <td
                    key={col.id}
                    className={cn(
                        'px-2 py-0 border-r border-border/10 last:border-0',
                        // Right-align numeric cells; left-align text cells
                        col.id === 'blocks' || col.id === 'status' || col.id === 'blockLoc'
                            ? 'text-left'
                            : 'text-right',
                    )}
                    style={{ height: `${height}px`, width: `${col.width}px` }}
                >
                    <LaneCell column={col} row={row} isActive={isActive} />
                </td>
            ))}
        </tr>
    );
}

function LaneCell({
    column,
    row,
    isActive,
}: {
    column: ColumnSpec;
    row: RcMovementRow;
    isActive: boolean;
}) {
    switch (column.id) {
        // The DATE/DAY/TTL KG columns are summarized in the day-header row;
        // lane rows leave them visually empty to mirror Excel's sparse-grouping style.
        case 'date':
        case 'day':
        case 'ttlKg':
            return null;

        case 'blocks':
            return row.supplier ? (
                <Tooltip>
                    <TooltipTrigger asChild>
                        <span className="font-mono font-bold text-xs cursor-help truncate block">
                            {row.batchCode}
                        </span>
                    </TooltipTrigger>
                    <TooltipContent side="top" className="text-xs max-w-xs">
                        <div className="font-mono">{row.batchCode}</div>
                        <div className="text-muted-foreground mt-0.5">Supplier: {row.supplier}</div>
                    </TooltipContent>
                </Tooltip>
            ) : (
                <span className="font-mono font-bold text-xs">{row.batchCode}</span>
            );

        case 'startBal':
            return <span className="font-mono text-xs">{formatInt(row.startBalance)}</span>;

        case 'batchFed':
            return <span className="font-mono text-xs">{formatInt(row.batchFed)}</span>;

        case 'ttlFed':
            return <span className="font-mono text-xs">{formatInt(row.ttlFed)}</span>;

        case 'pctLoss': {
            const value = formatPct(row.pctLoss);
            if (!value) return null;
            const colorClass = pctLossColorClass(row.pctLoss, row.status);
            return (
                <Tooltip>
                    <TooltipTrigger asChild>
                        <span
                            className={cn(
                                'font-mono text-xs cursor-help',
                                colorClass,
                                isActive && 'italic text-muted-foreground/70',
                            )}
                        >
                            {value}
                            {isActive && (
                                <sup className="ml-0.5 text-[10px] not-italic">*</sup>
                            )}
                        </span>
                    </TooltipTrigger>
                    <TooltipContent side="top" className="text-xs max-w-xs">
                        {isActive
                            ? 'Provisional. Will finalize when batch closes.'
                            : 'Final shrinkage at batch closure.'}
                    </TooltipContent>
                </Tooltip>
            );
        }

        case 'phpPerKg': {
            const value = formatPhp(row.phpPerKg);
            if (!value) return null;
            return (
                <div className="flex items-center justify-between text-xs">
                    <span className="text-muted-foreground">₱</span>
                    <span className="font-mono">{value}</span>
                </div>
            );
        }

        case 'phpTotal': {
            const value = formatPhp(row.phpTotal);
            if (!value) return null;
            return (
                <div className="flex items-center justify-between text-xs">
                    <span className="text-muted-foreground">₱</span>
                    <span className="font-mono font-bold">{value}</span>
                </div>
            );
        }

        case 'status':
            return (
                <span className="inline-flex items-center gap-1 text-xs font-mono">
                    {row.status === 'active' ? (
                        <>
                            <span className="text-emerald-600 dark:text-emerald-400 leading-none">●</span>
                            <span className="text-emerald-600 dark:text-emerald-400">active</span>
                        </>
                    ) : (
                        <>
                            <span className="text-red-600 dark:text-red-400 leading-none">✕</span>
                            <span className="text-red-600 dark:text-red-400 line-through">closed</span>
                        </>
                    )}
                </span>
            );

        case 'blockLoc':
            return row.blockLoc ? (
                <span className="font-mono text-[11px] text-muted-foreground truncate block">
                    {row.blockLoc}
                </span>
            ) : null;

        default:
            return null;
    }
}
