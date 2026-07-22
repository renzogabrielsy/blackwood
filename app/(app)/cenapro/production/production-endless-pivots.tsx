'use client';

import * as React from 'react';
import {
    TableVirtuoso,
    type TableComponents,
    type TableProps,
    type ItemProps,
    type TableVirtuosoHandle,
} from 'react-virtuoso';
import { format, parseISO, isValid } from 'date-fns';
import { Loader2, Copy, Inbox } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { CenaproPeriodPicker } from './period-picker';
import { ViewModeSwitcher, ScopeToggle } from './ledger-controls';
import type { ViewMode } from './ledger-url';
import { useDailyPivotWindow, type InitialDailyPivotWindow } from './use-daily-pivot-window';
import type { LedgerAnchor, CenaproPeriod } from './actions';
import type { PlantView } from './production-sources';
import { CRUSHER_CODES, KILN_CODES } from '../types';
import {
    buildDateGroups,
    fmt,
    formatDayLabel,
    formatRecvLabel,
    BAGGING,
    ACTIVE_EQUIP,
    CRUSHER_COUNT,
    W_DATE,
    W_SHIFT,
    W_GRADE,
    W_SOURCE,
    W_RECV,
    W_EQUIP,
    W_BAG,
    W_SUB,
    W_TOTAL,
    IDENTITY_WIDTH,
    LEFT_DATE,
    LEFT_SHIFT,
    LEFT_GRADE,
    LEFT_SOURCE,
    LEFT_RECV,
    ROW_H,
    CELL_PAD,
    GRID,
    GROUP,
    BOX,
    MIN_DAY_ROWS,
    SHIFT_LETTER,
    SHIFT_LABEL,
    GRADE_CHIP,
    pillBase,
    type DateGroup,
    type ShiftBlock,
} from './production-daily-block';

// ─── The Endless W6/W7 Daily Pivots (Phase 2B — READ-ONLY) ────────────────────────
// The pivot analog of the endless ledger. ONE continuous, virtualized, oldest-first view
// of the ENTIRE production history, but paginated by WHOLE production days (they are
// PIVOTS, not flat rows) and rendered as VIRTUALIZED DAY-BLOCKS you scroll through in both
// directions across month boundaries.
//
// Mechanics (locked spec, "W6/W7 endless-pivot mechanics"):
//   • fetchDailyPivotWindow pages by whole `prod_date`s (never a partial day) and filters
//     the plant source set SERVER-SIDE (FLEC/DVO excluded).
//   • useDailyPivotWindow accumulates the events + owns react-virtuoso's `firstItemIndex`
//     in DAY-BLOCK units (decrement by prepended distinct days on a backward fetch).
//   • buildDateGroups (REUSED VERBATIM from the editable daily block) pivots the loaded
//     events into day-blocks. Each day-block is ONE virtualized item: a nested read-only
//     <table> whose internal rowSpans render inside the item; virtuoso measures its height.
//   • Per-day "Daily total" footer only — NO cross-scroll grand total (locked decision #7).
//   • ONE shared, opaque, frozen 2-tier header (fixedHeaderContent) over all day-blocks;
//     the day-blocks' colgroups match the header's so columns line up under horizontal
//     scroll. Frozen 5-col identity is OPAQUE (`.frozen-*`, never glass over content).
//   • Dropdown = jump anchor: page.tsx server-prefetches the anchored first window and
//     remounts this component keyed by the anchor (same pattern as the endless ledger).
//
// READ-ONLY this phase — editing endless pivots is Phase 3. Clean seams left (the pivot
// engine + geometry are shared with the editable block; a future edit layer wraps the
// cells here the same way the daily block's CellEditor wraps its static cells).

// The 16 columns: Date, Shift, Grade, Source, Recv + 8 equipment + Bag + Sub + Total.
const TOTAL_COLS = 5 + ACTIVE_EQUIP.length + 3;
const MIN_W = IDENTITY_WIDTH + ACTIVE_EQUIP.length * W_EQUIP + W_BAG + W_SUB + W_TOTAL;

function monthKey(date: string): string {
    return (date ?? '').slice(0, 7);
}
function monthLabel(date: string): string {
    const d = parseISO(date);
    return isValid(d) ? format(d, 'MMMM yyyy').toUpperCase() : date;
}
function distinctDayCount(events: { prod_date: string | null }[]): number {
    const s = new Set<string>();
    for (const e of events) {
        const d = (e.prod_date ?? '').trim();
        if (d) s.add(d);
    }
    return s.size;
}

// ─── Shared colgroup (identical for the outer table AND every nested day-block table,
// so columns align under one frozen header + horizontal scroll) ───────────────────
function PivotColGroup() {
    return (
        <colgroup>
            <col style={{ width: `${W_DATE}px` }} />
            <col style={{ width: `${W_SHIFT}px` }} />
            <col style={{ width: `${W_GRADE}px` }} />
            <col style={{ width: `${W_SOURCE}px` }} />
            <col style={{ width: `${W_RECV}px` }} />
            {ACTIVE_EQUIP.map((c) => (
                <col key={c} style={{ width: `${W_EQUIP}px` }} />
            ))}
            <col style={{ width: `${W_BAG}px` }} />
            <col style={{ width: `${W_SUB}px` }} />
            <col style={{ width: `${W_TOTAL}px` }} />
        </colgroup>
    );
}

// ─── Frozen, opaque 2-tier header (mirrors the editable daily block's thead) ───────
function PivotHeaderRows() {
    const crusherCols = CRUSHER_CODES;
    const kilnCols = KILN_CODES;
    return (
        <>
            <tr>
                <th rowSpan={2} className={cn('frozen-corner bg-muted px-1.5 text-left align-middle text-[10px] font-semibold uppercase tracking-wide text-muted-foreground', GRID)} style={{ left: LEFT_DATE }}>Date</th>
                <th rowSpan={2} className={cn('frozen-corner bg-muted px-1 text-center align-middle text-[10px] font-semibold uppercase tracking-wide text-muted-foreground', GRID)} style={{ left: LEFT_SHIFT }}>SHFT</th>
                <th rowSpan={2} className={cn('frozen-corner bg-muted px-1.5 text-left align-middle text-[10px] font-semibold uppercase tracking-wide text-muted-foreground', GRID)} style={{ left: LEFT_GRADE }}>Grade</th>
                <th rowSpan={2} className={cn('frozen-corner bg-muted px-1.5 text-left align-middle text-[10px] font-semibold uppercase tracking-wide text-muted-foreground', GRID)} style={{ left: LEFT_SOURCE }}>Source</th>
                <th rowSpan={2} className={cn('frozen-corner frozen-edge bg-muted px-1.5 text-left align-middle text-[10px] font-semibold uppercase tracking-wide text-muted-foreground', GRID)} style={{ left: LEFT_RECV }}>Recv Date</th>
                <th colSpan={crusherCols.length} className={cn('h-6 bg-amber-500/5 px-2 text-center text-[9px] font-semibold uppercase tracking-[0.12em] text-amber-700/80 dark:text-amber-400/80', GRID, GROUP)}>Crushers</th>
                <th colSpan={kilnCols.length} className={cn('h-6 bg-rose-500/5 px-2 text-center text-[9px] font-semibold uppercase tracking-[0.12em] text-rose-700/80 dark:text-rose-400/80', GRID, GROUP)}>Kilns</th>
                <th className={cn('h-6 bg-emerald-500/5 px-2 text-center text-[9px] font-semibold uppercase tracking-[0.12em] text-emerald-700/80 dark:text-emerald-400/80', GRID, GROUP)}>Bagging</th>
                <th colSpan={2} className={cn('h-6 bg-muted px-2 text-center text-[9px] font-semibold uppercase tracking-[0.12em] text-muted-foreground', GRID, GROUP)}>Totals</th>
            </tr>
            <tr>
                {ACTIVE_EQUIP.map((c, i) => (
                    <th key={c} className={cn('h-7 px-1.5 text-right text-[10px] font-semibold tracking-wide text-muted-foreground', GRID, (i === 0 || i === crusherCols.length) && GROUP)}>{c}</th>
                ))}
                <th className={cn('h-7 px-1.5 text-right text-[10px] font-semibold tracking-wide text-emerald-700/80 dark:text-emerald-400/80', GRID, GROUP)}>Bag</th>
                <th className={cn('h-7 px-1.5 text-right text-[10px] font-semibold tracking-wide text-muted-foreground', GRID, GROUP)}>Sub</th>
                <th className={cn('h-7 px-1.5 text-right text-[10px] font-semibold tracking-wide text-muted-foreground', GRID)}>Total</th>
            </tr>
        </>
    );
}

// ─── One read-only DAY-BLOCK (a nested <table>, mirrors DateSection's REAL-row render) ─
// Rebuilds the frozen 5-col identity (Date/Shift/Grade/Source rowSpans), the equipment
// columns, and the per-day "Daily total" footer — all STATIC (no edit machinery, no
// filler/draft rows). Box-outlined exactly like the editable block.
function DayBlock({ group }: { group: DateGroup }) {
    const shiftSpan = (s: ShiftBlock) => s.grades.reduce((acc, g) => acc + g.leafCount, 0);
    const dayBodySpan = group.shifts.reduce((acc, s) => acc + shiftSpan(s), 0);
    // Pad a sparse day up to MIN_DAY_ROWS with faint READ-ONLY filler rows (SHARED floor with
    // the focus daily block via the exported MIN_DAY_ROWS) so every day-block has a consistent
    // minimum shape. Purely visual reserved slots — NO inputs (editing endless pivots is a
    // later phase). A day with ≥ MIN_DAY_ROWS real rows gets 0 fillers (unchanged).
    const fillerCount = Math.max(0, MIN_DAY_ROWS - dayBodySpan);
    // The DATE cell rowSpans real + filler rows so the day box stays a rectangle (the per-day
    // footer is a SEPARATE row, not covered). The merged Shift/Grade/Source cells keep their own
    // real-group spans; the filler rows carry their OWN empty identity cells (mirrors the focus
    // daily block, where the Date cell spans dayBody + filler and FillerRow emits its own slots).
    const dateRowSpan = dayBodySpan + fillerCount;

    return (
        <table
            className="table-fixed text-[11px]"
            style={{ width: 'max-content', minWidth: `${MIN_W}px`, borderCollapse: 'separate', borderSpacing: 0 }}
        >
            <PivotColGroup />
            <tbody className="group/day">
                {group.shifts.map((shiftBlock, sIdx) => (
                    shiftBlock.grades.map((gradeBlock, gIdx) => (
                        <React.Fragment key={`${shiftBlock.shift}-${gradeBlock.grade}`}>
                            {gradeBlock.sources.map((srcBlock, srcIdx) => (
                                srcBlock.recvRows.map((leaf, rIdx) => {
                                    // "First-in-group" is derived POSITIONALLY (no mutable render
                                    // flags): a cell is the group's first row iff every outer
                                    // index up to it is 0. This drives the rowSpan identity cells.
                                    const isSrcFirst = rIdx === 0;
                                    const isGradeFirst = srcIdx === 0 && rIdx === 0;
                                    const isShiftFirst = gIdx === 0 && isGradeFirst;
                                    const isDayFirst = sIdx === 0 && isShiftFirst;
                                    const boxTop = isDayFirst ? cn('border-t-2', BOX) : '';
                                    const leafKey = `${leaf.prodDate}|${leaf.shift}|${leaf.grade}|${leaf.source}|${leaf.recvDate}`;

                                    const dateCell = isDayFirst ? (
                                        <td rowSpan={dateRowSpan} className={cn('frozen-col bg-background px-1.5 align-top font-bold', GRID, 'border-t-2 border-l-2', BOX)} style={{ left: LEFT_DATE }}>
                                            <span className="whitespace-nowrap text-[11px] font-bold leading-tight tracking-tight text-foreground" title={leaf.prodDate}>{formatDayLabel(leaf.prodDate)}</span>
                                        </td>
                                    ) : null;
                                    const shiftCell = isShiftFirst ? (
                                        <td rowSpan={shiftSpan(shiftBlock)} className={cn('frozen-col bg-background px-1 text-center align-top font-bold', GRID, boxTop)} style={{ left: LEFT_SHIFT }} title={SHIFT_LABEL[shiftBlock.shift] ?? shiftBlock.shift}>
                                            <span className={cn('text-[12px] font-bold leading-none', SHIFT_LETTER[shiftBlock.shift] ?? 'text-muted-foreground')}>{shiftBlock.shift}</span>
                                        </td>
                                    ) : null;
                                    const gradeCell = isGradeFirst ? (
                                        <td rowSpan={gradeBlock.leafCount} className={cn('frozen-col bg-background px-1.5 align-top', GRID, boxTop)} style={{ left: LEFT_GRADE }}>
                                            <span className={cn(pillBase, 'mt-0.5', GRADE_CHIP[gradeBlock.grade] ?? 'bg-muted text-muted-foreground ring-border')}>{gradeBlock.grade}</span>
                                        </td>
                                    ) : null;
                                    const sourceCell = isSrcFirst ? (
                                        <td rowSpan={srcBlock.recvRows.length} className={cn('frozen-col bg-background px-1.5 align-top font-bold', GRID, boxTop)} style={{ left: LEFT_SOURCE }}>
                                            <span className="font-mono text-[11px] font-bold text-foreground/90">{srcBlock.source}</span>
                                        </td>
                                    ) : null;

                                    return (
                                            <tr key={leafKey} className={cn(ROW_H, 'transition-colors duration-150 hover:bg-muted/30')}>
                                                {dateCell}
                                                {shiftCell}
                                                {gradeCell}
                                                {sourceCell}
                                                <td className={cn('frozen-col frozen-edge bg-background align-middle', CELL_PAD, GRID, boxTop)} style={{ left: LEFT_RECV }}>
                                                    <span className="font-mono text-[11px] font-bold leading-none text-foreground/80">{formatRecvLabel(leaf.recvDate)}</span>
                                                </td>
                                                {ACTIVE_EQUIP.map((c, i) => (
                                                    <td key={c} className={cn(CELL_PAD, 'text-right align-middle font-mono text-[11px] leading-none tabular-nums', GRID, boxTop, (i === 0 || i === CRUSHER_COUNT) && GROUP)}>
                                                        {fmt(leaf.cells[c].weight)}
                                                    </td>
                                                ))}
                                                <td className={cn(CELL_PAD, 'text-right align-middle font-mono text-[11px] leading-none tabular-nums text-emerald-700 dark:text-emerald-400', GRID, boxTop, GROUP)}>
                                                    {fmt(leaf.cells[BAGGING].weight)}
                                                </td>
                                                <td className={cn(CELL_PAD, 'text-right align-middle font-mono text-[11px] leading-none tabular-nums text-muted-foreground', GRID, boxTop, GROUP)}>{fmt(leaf.subTotal)}</td>
                                                <td className={cn(CELL_PAD, 'text-right align-middle font-mono text-[11px] font-semibold leading-none tabular-nums', GRID, boxTop, 'border-r-2', BOX)}>{fmt(leaf.total)}</td>
                                            </tr>
                                        );
                                    })
                                ))}
                            </React.Fragment>
                        ))
                    ))}

                {/* FILLER rows — pad the day up to MIN_DAY_ROWS with faint, READ-ONLY reserved
                    slots so every day-block has a consistent minimum height (mirrors the focus
                    daily block's filler padding). The Date + merged identity cells above already
                    rowSpan over these rows (dateRowSpan = real + filler), so a filler row emits
                    NO date/shift/grade/source-merge cell — only its own frozen identity slots
                    (opaque, per the frozen-pane rule) + faint bg-muted/30 numeric cells. No
                    inputs: purely visual. */}
                {Array.from({ length: fillerCount }).map((_, i) => (
                    <tr key={`filler-${i}`} className={ROW_H}>
                        <td className={cn('frozen-col bg-background', CELL_PAD, GRID)} style={{ left: LEFT_SHIFT }} />
                        <td className={cn('frozen-col bg-background', CELL_PAD, GRID)} style={{ left: LEFT_GRADE }} />
                        <td className={cn('frozen-col bg-background', CELL_PAD, GRID)} style={{ left: LEFT_SOURCE }} />
                        <td className={cn('frozen-col frozen-edge bg-background', CELL_PAD, GRID)} style={{ left: LEFT_RECV }} />
                        {ACTIVE_EQUIP.map((c, ci) => (
                            <td key={c} className={cn(CELL_PAD, 'bg-muted/30', GRID, (ci === 0 || ci === CRUSHER_COUNT) && GROUP)} />
                        ))}
                        <td className={cn(CELL_PAD, 'bg-muted/30', GRID, GROUP)} />
                        <td className={cn(CELL_PAD, 'bg-muted/30', GRID, GROUP)} />
                        <td className={cn(CELL_PAD, 'bg-muted/30', GRID, 'border-r-2', BOX)} />
                    </tr>
                ))}

                {/* DAY FOOTER — per-day rollup only (locked decision #7: NO cross-scroll total). */}
                <tr className={cn(ROW_H, 'bg-muted')}>
                    <td colSpan={5} className={cn('frozen-col frozen-edge bg-muted px-2 align-middle', CELL_PAD, GRID, 'border-t-2 border-b-2 border-l-2', BOX)} style={{ left: LEFT_DATE }}>
                        <span className="text-[10px] font-bold uppercase leading-none tracking-wide text-foreground/80">Daily total</span>
                    </td>
                    {ACTIVE_EQUIP.map((c, i) => (
                        <td key={c} className={cn(CELL_PAD, 'text-right align-middle font-mono text-[11px] leading-none tabular-nums', GRID, 'border-t-2 border-b-2', BOX, (i === 0 || i === CRUSHER_COUNT) && GROUP, 'bg-muted font-bold')}>{fmt(group.daily.equip[c])}</td>
                    ))}
                    <td className={cn(CELL_PAD, 'text-right align-middle font-mono text-[11px] leading-none tabular-nums', GRID, 'border-t-2 border-b-2', BOX, GROUP, 'bg-muted font-bold text-emerald-700 dark:text-emerald-400')}>{fmt(group.daily.bagging)}</td>
                    <td className={cn(CELL_PAD, 'text-right align-middle font-mono text-[11px] leading-none tabular-nums', GRID, 'border-t-2 border-b-2', BOX, GROUP, 'bg-muted font-bold')}>{fmt(group.daily.subTotal)}</td>
                    <td className={cn(CELL_PAD, 'text-right align-middle font-mono text-[11px] leading-none tabular-nums', GRID, 'border-t-2 border-b-2 border-r-2', BOX, 'bg-muted font-bold')}>{fmt(group.daily.total)}</td>
                </tr>
            </tbody>
        </table>
    );
}

// ─── Slim month separator (day-blocks that cross a month boundary) ─────────────────
function MonthSeparator({ label }: { label: string }) {
    return (
        <div className="sticky left-0 flex items-center gap-2 px-2 py-1">
            <span className="text-[10px] font-bold uppercase tracking-[0.14em] text-primary/80">{label}</span>
            <span className="h-px flex-1 bg-primary/20" />
        </div>
    );
}

// ─── Virtuoso render context + components ──────────────────────────────────────────
interface PivotCtx {
    firstItemIndex: number;
    groups: DateGroup[];
}

const PivotScroller = React.forwardRef<HTMLDivElement, React.ComponentProps<'div'> & { context?: unknown }>(
    function PivotScroller({ style, context: _ctx, ...props }, ref) {
        void _ctx;
        return <div ref={ref} {...props} className="outline-none" style={{ overflowX: 'auto', ...style }} />;
    },
);

const PivotTable = ({ style, children }: TableProps) => (
    <table
        className="relative table-fixed border border-border text-[11px]"
        style={{ ...style, width: 'max-content', minWidth: MIN_W, borderCollapse: 'separate', borderSpacing: 0 }}
    >
        <PivotColGroup />
        {children}
    </table>
);

const PivotTableHead = React.forwardRef<HTMLTableSectionElement, React.ComponentProps<'thead'> & { context?: unknown }>(
    function PivotTableHead({ style, context: _ctx, ...props }, ref) {
        void _ctx;
        return <thead ref={ref} {...props} className="frozen-row bg-muted" style={{ ...style, zIndex: 20 }} />;
    },
);

// Each item's <tr> holds a SINGLE full-span <td> that contains the whole nested day-block
// table. Strip virtuoso's `item`/`context` so they never land on the DOM <tr>.
const PivotTableRow = ({ item: _item, context: _context, children, ...props }: ItemProps<DateGroup> & { context?: PivotCtx }) => {
    void _item;
    void _context;
    return (
        <tr {...props} className="align-top">
            {children}
        </tr>
    );
};

const pivotComponents: TableComponents<DateGroup, PivotCtx> = {
    Scroller: PivotScroller,
    Table: PivotTable,
    TableHead: PivotTableHead,
    TableRow: PivotTableRow,
};

export interface ProductionEndlessPivotsProps {
    initialWindow: InitialDailyPivotWindow;
    anchor: LedgerAnchor;
    plantView: PlantView;
    view: ViewMode;
    periods: CenaproPeriod[];
    selectedPeriod: CenaproPeriod | null;
    loadError: string | null;
}

export function ProductionEndlessPivots({
    initialWindow,
    anchor,
    plantView,
    view,
    periods,
    selectedPeriod,
    loadError,
}: ProductionEndlessPivotsProps) {
    const win = useDailyPivotWindow(initialWindow, plantView);
    const { events, firstItemIndex, hasOlder, hasNewer, loadingOlder, loadingNewer, notice, fetchOlder, fetchNewer } = win;

    const virtuosoRef = React.useRef<TableVirtuosoHandle>(null);

    // Pivot the accumulated events → day-blocks (REUSED VERBATIM from the editable block).
    const { groups } = React.useMemo(() => buildDateGroups(events, plantView), [events, plantView]);

    // Open at the newest day (bottom) for 'latest'; at the period's first day (top) for a
    // period anchor. Computed from the INITIAL window's distinct-day count (day-block units).
    const initialTopMostItemIndex = React.useMemo(() => {
        if (anchor.kind !== 'latest') return 0;
        return Math.max(0, distinctDayCount(initialWindow.events) - 1);
    }, [anchor.kind, initialWindow.events]);

    const context: PivotCtx = { firstItemIndex, groups };

    const itemContent = React.useCallback((index: number, group: DateGroup, ctx: PivotCtx) => {
        const pos = index - ctx.firstItemIndex;
        const prev = pos > 0 ? ctx.groups[pos - 1] : undefined;
        const isMonthStart = !prev || monthKey(prev.date) !== monthKey(group.date);
        return (
            <td colSpan={TOTAL_COLS} className="p-0 align-top" style={{ padding: 0 }}>
                {isMonthStart && <MonthSeparator label={monthLabel(group.date)} />}
                <DayBlock group={group} />
            </td>
        );
    }, []);

    const computeItemKey = React.useCallback(
        (_index: number, group: DateGroup) => `day:${group.date}`,
        [],
    );

    const handleStartReached = React.useCallback(() => {
        void fetchOlder();
    }, [fetchOlder]);
    const handleEndReached = React.useCallback(() => {
        void fetchNewer();
    }, [fetchNewer]);

    const dayCount = groups.length;

    return (
        <div className="flex h-full flex-col">
            {/* Toolbar — dropdown = jump anchor; view switcher + scope toggle stay reachable. */}
            <div className="flex flex-none flex-wrap items-center gap-2 border-b bg-muted/30 px-2 py-1.5 md:px-3">
                <CenaproPeriodPicker periods={periods} selected={selectedPeriod} />
                <span className="h-4 w-px bg-border/60" />
                <ViewModeSwitcher mode={view} />
                <span className="h-4 w-px bg-border/60" />
                <ScopeToggle scope="endless" />
                <span className="h-4 w-px bg-border/60" />
                <span className="font-mono text-[11px] text-muted-foreground/70">
                    {dayCount.toLocaleString('en-US')} day{dayCount !== 1 ? 's' : ''} loaded
                    {(hasOlder || hasNewer) && <span className="ml-1 text-muted-foreground/50">· scroll to load more</span>}
                </span>
                <div className="flex-1" />
                <span className="hidden text-[10px] font-medium uppercase tracking-wide text-muted-foreground/60 md:inline">
                    {plantView} · read-only · oldest → newest
                </span>
            </div>

            {loadError && (
                <div className="m-3 flex items-start gap-3 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm">
                    <div className="min-w-0 flex-1">
                        <p className="font-medium text-destructive">Couldn&apos;t load production data</p>
                        <p className="mt-1 break-words text-destructive/90">{loadError}</p>
                        <p className="mt-1 text-xs text-muted-foreground">Try again in a moment, or copy the message above if it persists.</p>
                    </div>
                    <Button
                        variant="ghost"
                        size="sm"
                        className="h-7 shrink-0 px-2 text-destructive hover:text-destructive"
                        onClick={() => {
                            void navigator.clipboard.writeText(loadError).then(() => {
                                import('sonner').then(({ toast: t }) => t.success('Error copied to clipboard', { duration: 2000 }));
                            });
                        }}
                    >
                        <Copy className="mr-1 h-3.5 w-3.5" />
                        Copy
                    </Button>
                </div>
            )}

            {notice && (
                <div className="mx-3 mt-3 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-[11px] text-amber-700 dark:text-amber-300">
                    {notice}
                </div>
            )}

            {groups.length === 0 ? (
                <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 p-8 text-center">
                    <Inbox className="h-8 w-8 text-muted-foreground/30" />
                    <p className="text-sm text-muted-foreground">{notice ?? `No ${plantView} production to display.`}</p>
                </div>
            ) : (
                // The frozen 5-col matrix can't shrink to a phone; it horizontal-scrolls
                // (Scroller overflow-x auto) at every breakpoint without crashing. A phone
                // summary (like the focus daily block's) can be added later.
                <div className="relative min-h-0 flex-1">
                    {loadingOlder && (
                        <div className="pointer-events-none absolute inset-x-0 top-0 z-40 flex items-center justify-center gap-1.5 border-b border-border/40 bg-muted/85 py-1 text-[11px] text-muted-foreground backdrop-blur-sm">
                            <Loader2 className="h-3 w-3 animate-spin" />
                            Loading earlier days…
                        </div>
                    )}
                    <TableVirtuoso
                        ref={virtuosoRef}
                        data={groups}
                        context={context}
                        computeItemKey={computeItemKey}
                        firstItemIndex={firstItemIndex}
                        initialTopMostItemIndex={initialTopMostItemIndex}
                        startReached={handleStartReached}
                        endReached={handleEndReached}
                        increaseViewportBy={{ top: 600, bottom: 600 }}
                        components={pivotComponents}
                        fixedHeaderContent={PivotHeaderRows}
                        itemContent={itemContent}
                        style={{ height: '100%' }}
                    />
                    {loadingNewer && (
                        <div className="pointer-events-none absolute inset-x-0 bottom-0 z-40 flex items-center justify-center gap-1.5 border-t border-border/40 bg-muted/85 py-1 text-[11px] text-muted-foreground backdrop-blur-sm">
                            <Loader2 className="h-3 w-3 animate-spin" />
                            Loading newer days…
                        </div>
                    )}
                </div>
            )}
        </div>
    );
}
