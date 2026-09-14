'use client';

import * as React from 'react';
import Link from 'next/link';
import { ArrowLeft, ChevronDown, ChevronRight } from 'lucide-react';

import { BlackwoodTable } from '@/components/shared/table';
import type { TableSummaryCell, TableSummaryRow } from '@/components/shared/table';
import type { ColumnSpec, GridRow, RowKind, TableSettings } from '@/lib/table';
import { useTableEdits } from '@/lib/hooks/use-table-edits';
import { cn } from '@/lib/utils';

import { OPS_LEDGER_DATA, daysOf, rollupOf } from '../_mock/data';
import { GRADES, WASTE_STREAMS, type BlockFeed, type Campaign, type LedgerDay, type ShiftDetail } from '../_mock/types';
import { groupRollup } from '../_shared/aggregate';
import { type ColumnGroupId } from '../_shared/column-groups';
import { hours, kg, pctFromFraction, php } from '../_shared/format';
import { GroupBuilder } from '../_shared/group-builder';
import { KpiStrip } from '../_shared/kpi-strip';
import { ColumnGroupChips, LensSwitcher } from '../_shared/lens-controls';

// ═════════════════════════════════════════════════════════════════════════════════
// DRAFT A — "EXCEL FAITHFUL".
//
// THE AXIS: how little has to change if the sheet stays the sheet?
//
// Renzo's Q3 tab rendered as-is on the Blackwood Table — one campaign at a time behind
// month tabs, Date and Day frozen, the six column groups on chips, and a chevron on each
// day that opens the breakdown INSIDE THE GRID rather than beside it.
//
// ── WHAT MAKES IT DIFFERENT FROM B AND C, STRUCTURALLY ──────────────────────────
// The breakdown is CHILD ROWS, not a panel. Expanding a day inserts one row per block it
// drew from (occupying only the eight BLOCKS-USED columns) and one row per shift
// (occupying only the production and grade columns) — which is precisely how the paper
// sheet is laid out, and it means the breakdown lives in the grid's own coordinate space:
// it is selectable, it totals in the status pill, and Ctrl+C takes it out with the day
// above it. B and C both put the breakdown outside the grid and lose that.
//
// It is also the only draft where a GROUP is N separate tables stacked under one KPI strip
// — the workbook's own shape, three month tabs under one EOQ. The honest cost is that
// nothing is comparable across months without scrolling between them, which is exactly
// what draft B exists to answer.
//
// ── READ-ONLY, AND STRUCTURALLY SO ──────────────────────────────────────────────
// No column declares a `parse` and no `renderEditor` is passed, so `columnAcceptsEdit` is
// false at every coordinate and an editor can never open. Sort and filter ARE on (the
// focus scope's own default), because they are the ordinary spreadsheet gesture and this
// draft is the one arguing that the sheet should still feel like a sheet.
// ═════════════════════════════════════════════════════════════════════════════════

// ─── Geometry ────────────────────────────────────────────────────────────────────
//
// THE HEADER OWES CHROME, NOT JUST ITS LABEL (CLAUDE.md, 2026-08-29). In `scope="focus"`
// every sortable/filterable column pays 57px of INVISIBLE header chrome — the hover-
// revealed sort and filter buttons are `opacity-0` flex siblings of the label, unseen and
// still occupying layout — plus 16px of padding and a 1px border. A `cellKind: 'derived'`
// column pays only 17. Sizing a column to its label alone is how QC (2026-08-26) and RC
// Movement (2026-08-29) both shipped an ellipsis in a header.
//
// MEASURED IN CHROME against this page, not estimated — `labScroll` read off every
// `<th>`'s own label node at 1512px. The overhead came back as EXACTLY 57 on all 27
// columns (declared − 1px border − 16px padding − 40px of invisible sort/filter buttons),
// which is the figure CLAUDE.md records. Four columns clipped on the first pass — TTL PROD
// KG, TTL LOSS KG, TTL SHIFTS and BLOCK LOC — and each is widened to its own measurement
// rather than all of them to the widest, because a column sized past its label costs real
// scroll width on a sheet that already has 27 of them.
//
//   key        label          labScroll   +57    declared
//   date       DATE                  43    100        100
//   day        DAY                   27     84         84
//   fedprice   FED ₱/KG              55    112        112
//   fedkg      TTL FED KG            67    124        124
//   prodkg     TTL PROD KG           77    134        140
//   losskg     TTL LOSS KG           74    131        140
//   shifts     TTL SHIFTS            66    123        128
//   dthrs      TTL DT HRS            68    125        132
//   grade      3X50 / 2X6 / 4X8      35     92         92
//   waste      TRML 1 (widest)       51    108        108
//   b:batch    BATCH (code is wider) 91    148        148
//   b:loc      BLOCK LOC             66    123        128
//   b:open     DATE OPEN             71    128        128
//   b:fed      ARRV WT KG (widest)   75    132        132
const W_EXPAND = 40;    // derived, no label — pays 17, not 57
const W_DATE = 100;
const W_DAY = 84;
const W_FEDPRICE = 112;
const W_FEDKG = 124;
const W_PRODKG = 140;
const W_LOSSKG = 140;
const W_SHIFTS = 128;
const W_DTHRS = 132;
const W_GRADE = 92;
const W_WASTE = 108;    // uniform across all eight — TRML 1/2 are the widest at 51
const W_BATCH = 148;    // sized to the 16-char batch code in the CELLS, not to `BATCH`
const W_LOC = 128;
const W_DATECOL = 128;
const W_STATE = 96;
const W_WT = 132;

const ROW_H = 32;
const CHILD_H = 26;

const GROUP_RULE = 'border-l-2 border-l-border';

// ─── The row type ────────────────────────────────────────────────────────────────

/**
 * ONE row type, THREE families.
 *
 * The table is generic over a single `Row`, and the three families differ by which
 * columns they OCCUPY rather than by which type they are — so a discriminated field plus
 * two optional payloads is the shape that fits, and `occupies()` does the real work below.
 */
interface SheetRow {
    id: string;
    family: 'day' | 'block' | 'shift';
    day: LedgerDay;
    block?: BlockFeed;
    shift?: ShiftDetail;
    /** 1-based ordinal within the campaign. Only day rows carry one. */
    rowNum: number;
}

interface SheetCtx {
    canViewPrices: boolean;
    expanded: ReadonlySet<string>;
    /** Must be referentially stable — it rides inside `ctx`, a memo dependency. */
    onToggle(date: string): void;
    /** Which block columns exist right now, so a child row knows whether it has a home. */
    blocksUsedOn: boolean;
}

// ─── Cell atoms ──────────────────────────────────────────────────────────────────

/** An accounting cell: ₱ pinned left, figure pinned right (Excel Standard). */
function pesoCell(value: number | null) {
    if (value === null) return null;
    return (
        <span className="flex w-full items-baseline justify-between gap-1 font-mono tabular-nums">
            <span className="text-muted-foreground">&#8369;</span>
            <span>{php(value)}</span>
        </span>
    );
}

/**
 * The 2px section rule at the start of a column group, painted from INSIDE the cell.
 *
 * The module owns the `<td>`'s className, so a consumer cannot put a border on it — but
 * the cell's inner layer is a positioned box, so an `inset-0` span paints the line at the
 * cell's own left edge on every row of the column. Lifted verbatim from the live RC
 * Movement grid, which is the second reason to use it: two grids drawing the same rule two
 * different ways is how they stop looking like one product.
 */
function withRule(rule: boolean, body: React.ReactNode, align: 'left' | 'right' = 'right') {
    if (!rule) return body;
    return (
        <span
            className={cn(
                'absolute inset-0 flex items-center px-2',
                align === 'right' ? 'justify-end' : 'justify-start',
                GROUP_RULE,
            )}
        >
            {body}
        </span>
    );
}

const mono = (text: string, extra?: string) => (
    <span className={cn('font-mono tabular-nums', extra)}>{text}</span>
);

// ─── Columns ─────────────────────────────────────────────────────────────────────

function buildColumns(groups: readonly ColumnGroupId[]): ColumnSpec<SheetRow, SheetCtx>[] {
    const on = (id: ColumnGroupId) => groups.includes(id);
    const out: ColumnSpec<SheetRow, SheetCtx>[] = [];

    out.push({
        key: 'expand',
        label: '',
        title: 'Open the day — its blocks and its two shifts, as rows inside the sheet',
        width: W_EXPAND,
        pin: 'start',
        align: 'center',
        cellKind: 'derived',
        resizable: false,
        hideable: false,
        // A disclosure control is not data — "Copy row" must not lead with it.
        rowCopy: false,
        format: (row, ctx) => {
            if (row.family !== 'day') {
                return <span className="pl-1 font-mono text-muted-foreground/60">└</span>;
            }
            if (row.day.restDay) return null;
            const open = ctx.expanded.has(row.day.date);
            return (
                <button
                    type="button"
                    aria-expanded={open}
                    aria-label={`${open ? 'Collapse' : 'Expand'} ${row.day.date}`}
                    data-grid-chrome
                    // The grid selects a cell on mousedown. A disclosure control inside one
                    // has to stop that itself, or every expand also sweeps a cell.
                    onMouseDown={(e) => e.stopPropagation()}
                    onClick={(e) => {
                        e.stopPropagation();
                        ctx.onToggle(row.day.date);
                    }}
                    className="flex size-5 items-center justify-center rounded text-muted-foreground transition-colors duration-150 hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                >
                    {open ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
                </button>
            );
        },
    });

    out.push({
        key: 'date',
        label: 'DATE',
        title: 'Calendar day (yyyy-MM-dd) — rest days included and blank',
        width: W_DATE,
        pin: 'start',
        cellKind: 'readonly',
        selectable: true,
        clipboardValue: (row) => (row.family === 'day' ? row.day.date : ''),
        format: (row) => {
            // A BLOCK child prints its BLOCK LOCATION here, not its batch code — the code
            // is 13-16 characters and would read `JUNE-26-BLK…` in a 100px lane, and a
            // truncated identifier names nothing. The loc is five characters, is the yard's
            // own way of pointing at the pile, and the full code is one column to the
            // right (and on the `title`).
            if (row.family === 'block') {
                return (
                    <span
                        className="font-mono text-[11px] tabular-nums text-muted-foreground"
                        title={`${row.block?.batchCode} · ${row.block?.blockLoc}`}
                    >
                        {row.block?.blockLoc}
                    </span>
                );
            }
            if (row.family === 'shift') {
                return <span className="text-[11px] text-muted-foreground">Shift {row.shift?.shift}</span>;
            }
            return mono(row.day.date, row.day.restDay ? 'text-muted-foreground' : undefined);
        },
    });

    out.push({
        key: 'day',
        label: 'DAY',
        title: 'Day of week',
        width: W_DAY,
        pin: 'start',
        cellKind: 'readonly',
        selectable: true,
        clipboardValue: (row) => (row.family === 'day' ? row.day.day : ''),
        format: (row) => {
            if (row.family === 'shift') {
                // `06:00\u201318:00` is 11 characters against 67px of usable lane. The short
                // form fits, and the full window is on the shift card in the other drafts.
                return (
                    <span className="font-mono text-[11px] tabular-nums text-muted-foreground" title={row.shift?.window}>
                        {row.shift?.window.replace(/:00/g, '')}
                    </span>
                );
            }
            if (row.family !== 'day') return null;
            return (
                <span
                    className={cn(
                        'text-muted-foreground',
                        row.day.day === 'Sun' && 'text-amber-600 dark:text-amber-400',
                    )}
                >
                    {row.day.day}
                </span>
            );
        },
    });

    if (on('costs')) {
        out.push({
            key: 'fedprice',
            label: 'FED ₱/KG',
            title: 'Weighted-average delivered price of the charcoal fed that day',
            width: W_FEDPRICE,
            pin: 'start',
            align: 'right',
            cellKind: 'readonly',
            selectable: true,
            calcType: 'AVERAGE',
            // The SERVER decides; the column only obeys. A hidden column is ABSENT from the
            // coordinate space, never blanked — the keyboard has no hole and a copy cannot
            // address it.
            visible: (ctx) => ctx.canViewPrices,
            numericValue: (row) => (row.family === 'day' ? row.day.fedPhpKg : null),
            clipboardValue: (row) => (row.family === 'day' && row.day.fedPhpKg !== null ? String(row.day.fedPhpKg) : ''),
            format: (row) => (row.family === 'day' ? pesoCell(row.day.fedPhpKg) : null),
        });
    }

    if (on('production')) {
        const first = !on('costs');
        out.push(
            {
                key: 'fedkg',
                label: 'TTL FED KG',
                title: 'Total kg of raw charcoal fed into the plant',
                width: W_FEDKG,
                align: 'right',
                cellKind: 'readonly',
                selectable: true,
                calcType: 'SUM',
                numericValue: (row) => (row.family === 'block' ? row.block!.fedKg : row.family === 'shift' ? row.shift!.fedKg : row.day.fedKg),
                clipboardValue: (row) => String(row.family === 'block' ? row.block!.fedKg : row.family === 'shift' ? row.shift!.fedKg : row.day.fedKg),
                format: (row) =>
                    withRule(
                        first,
                        mono(
                            kg(row.family === 'block' ? row.block!.fedKg : row.family === 'shift' ? row.shift!.fedKg : row.day.fedKg),
                            row.family === 'day' ? 'font-medium' : 'text-muted-foreground',
                        ),
                    ),
            },
            {
                key: 'prodkg',
                label: 'TTL PROD KG',
                title: 'Total kg of finished product',
                width: W_PRODKG,
                align: 'right',
                cellKind: 'readonly',
                selectable: true,
                calcType: 'SUM',
                numericValue: (row) => (row.family === 'shift' ? row.shift!.producedKg : row.family === 'day' ? row.day.producedKg : null),
                clipboardValue: (row) => (row.family === 'block' ? '' : String(row.family === 'shift' ? row.shift!.producedKg : row.day.producedKg)),
                format: (row) =>
                    row.family === 'block'
                        ? null
                        : mono(
                              kg(row.family === 'shift' ? row.shift!.producedKg : row.day.producedKg),
                              row.family === 'day' ? 'font-medium' : 'text-muted-foreground',
                          ),
            },
            {
                key: 'losskg',
                label: 'TTL LOSS KG',
                title: 'Fed minus produced — moisture, volatiles and the recorded waste together',
                width: W_LOSSKG,
                align: 'right',
                cellKind: 'readonly',
                selectable: true,
                calcType: 'SUM',
                numericValue: (row) => (row.family === 'day' ? row.day.lossKg : null),
                clipboardValue: (row) => (row.family === 'day' ? String(row.day.lossKg) : ''),
                format: (row) => (row.family === 'day' ? mono(kg(row.day.lossKg), 'text-muted-foreground') : null),
            },
            {
                key: 'shifts',
                label: 'TTL SHIFTS',
                title: 'Shifts run',
                width: W_SHIFTS,
                align: 'right',
                cellKind: 'readonly',
                selectable: true,
                calcType: 'SUM',
                numericValue: (row) => (row.family === 'day' ? row.day.shifts : null),
                clipboardValue: (row) => (row.family === 'day' && row.day.shifts ? String(row.day.shifts) : ''),
                format: (row) => (row.family === 'day' && row.day.shifts ? mono(String(row.day.shifts)) : null),
            },
            {
                key: 'dthrs',
                label: 'TTL DT HRS',
                title: 'Downtime hours. A genuine 0.00 prints — it is a claim, not a blank',
                width: W_DTHRS,
                align: 'right',
                cellKind: 'readonly',
                selectable: true,
                calcType: 'SUM',
                numericValue: (row) => (row.family === 'shift' ? row.shift!.dtHours : row.family === 'day' ? row.day.dtHours : null),
                clipboardValue: (row) => (row.family === 'block' ? '' : hours(row.family === 'shift' ? row.shift!.dtHours : row.day.dtHours)),
                format: (row) => {
                    if (row.family === 'block') return null;
                    if (row.family === 'day' && row.day.restDay) return null;
                    const v = row.family === 'shift' ? row.shift!.dtHours : row.day.dtHours;
                    return mono(hours(v), v > 0 ? 'text-amber-700 dark:text-amber-400' : 'text-muted-foreground');
                },
            },
        );
    }

    if (on('grades')) {
        GRADES.forEach((g, i) => {
            out.push({
                key: `grade:${g}`,
                label: g,
                title: `Kg produced of grade ${g}`,
                width: W_GRADE,
                align: 'right',
                cellKind: 'readonly',
                selectable: true,
                calcType: 'SUM',
                numericValue: (row) =>
                    row.family === 'shift' ? row.shift!.producedByGrade[g] : row.family === 'day' ? row.day.producedByGrade[g] : null,
                clipboardValue: (row) =>
                    row.family === 'block' ? '' : String(row.family === 'shift' ? row.shift!.producedByGrade[g] : row.day.producedByGrade[g]),
                format: (row) => {
                    if (row.family === 'block') return null;
                    const v = row.family === 'shift' ? row.shift!.producedByGrade[g] : row.day.producedByGrade[g];
                    return withRule(i === 0, mono(kg(v), row.family === 'shift' ? 'text-muted-foreground' : undefined));
                },
            });
        });
    }

    if (on('losses')) {
        WASTE_STREAMS.forEach((w, i) => {
            out.push({
                key: `waste:${w.key}`,
                label: w.label,
                title: `${w.label} — kg of recorded waste. The eight streams do NOT sum to Loss`,
                width: W_WASTE,
                align: 'right',
                cellKind: 'readonly',
                selectable: true,
                calcType: 'SUM',
                numericValue: (row) => (row.family === 'day' ? row.day.waste[w.key] : null),
                clipboardValue: (row) => (row.family === 'day' ? String(row.day.waste[w.key]) : ''),
                format: (row) =>
                    row.family === 'day'
                        ? withRule(i === 0, mono(kg(row.day.waste[w.key]), 'text-muted-foreground'))
                        : null,
            });
        });
    }

    if (on('blocksUsed')) {
        const blockCols: {
            key: string;
            label: string;
            width: number;
            align?: 'left' | 'right';
            value: (b: BlockFeed) => string;
            num?: (b: BlockFeed) => number | null;
        }[] = [
            { key: 'b:batch', label: 'BATCH', width: W_BATCH, value: (b) => b.batchCode },
            { key: 'b:loc', label: 'BLOCK LOC', width: W_LOC, value: (b) => b.blockLoc },
            { key: 'b:open', label: 'DATE OPEN', width: W_DATECOL, value: (b) => b.dateOpen },
            { key: 'b:close', label: 'DATE CLOSE', width: W_DATECOL, value: (b) => b.dateClose ?? '' },
            { key: 'b:state', label: 'STATE', width: W_STATE, value: (b) => b.state },
            { key: 'b:fed', label: 'FED WT KG', width: W_WT, align: 'right', value: (b) => kg(b.fedKg), num: (b) => b.fedKg },
            { key: 'b:arrv', label: 'ARRV WT KG', width: W_WT, align: 'right', value: (b) => kg(b.arrivedKg), num: (b) => b.arrivedKg },
            { key: 'b:resiko', label: 'RESIKO KG', width: W_WT, align: 'right', value: (b) => kg(b.resikoKg), num: (b) => b.resikoKg },
        ];

        blockCols.forEach((c, i) => {
            out.push({
                key: c.key,
                label: c.label,
                title: `Blocks used — ${c.label}. One row per block the day drew from; expand a day to see them`,
                width: c.width,
                align: c.align ?? 'left',
                cellKind: 'readonly',
                selectable: true,
                calcType: c.num ? 'SUM' : undefined,
                numericValue: (row) => (row.family === 'block' && c.num ? c.num(row.block!) : null),
                clipboardValue: (row) => (row.family === 'block' ? c.value(row.block!) : ''),
                format: (row) => {
                    // A DAY row summarises its blocks in the first two columns; the detail is
                    // in the child rows. Anything else would repeat one of the block's eight
                    // values arbitrarily on a row that has several of them.
                    if (row.family === 'day') {
                        if (c.key === 'b:batch') {
                            const n = row.day.blocks.length;
                            return n === 0 ? null : (
                                <span className="text-[11px] text-muted-foreground">
                                    {n} block{n === 1 ? '' : 's'}
                                </span>
                            );
                        }
                        if (c.key === 'b:fed') return mono(kg(row.day.fedKg), 'text-muted-foreground');
                        return null;
                    }
                    if (row.family !== 'block') return null;
                    return withRule(
                        i === 0,
                        mono(c.value(row.block!), 'text-[11px]'),
                        c.align === 'right' ? 'right' : 'left',
                    );
                },
            });
        });
    }

    return out;
}

// ─── Row families ────────────────────────────────────────────────────────────────

function buildKinds(colKeys: readonly string[]): ReadonlyMap<string, RowKind<SheetRow>> {
    const dayFields = new Map<string, { field: string; editable: boolean; addressable?: boolean }>();
    for (const k of colKeys) {
        dayFields.set(k, { field: k, editable: false, addressable: k !== 'expand' });
    }

    // A BLOCK child occupies the date lane (it prints its own code there) and the eight
    // BLOCKS-USED columns. Nothing else — it has no production, no grades, no waste.
    const blockKeys = new Set(['date', ...colKeys.filter((k) => k.startsWith('b:')), 'fedkg']);
    // A SHIFT child occupies the date/day lanes and the production + grade columns. It has
    // no blocks and no waste: waste is recorded per DAY in the source, and splitting it
    // across two shifts would be an invention.
    const shiftKeys = new Set([
        'date', 'day', 'fedkg', 'prodkg', 'dthrs',
        ...colKeys.filter((k) => k.startsWith('grade:')),
    ]);

    const subset = (allowed: ReadonlySet<string>) => (colKey: string) =>
        allowed.has(colKey) ? { field: colKey, editable: false } : null;

    return new Map<string, RowKind<SheetRow>>([
        ['day', { kind: 'day', height: ROW_H, addressable: true, occupies: (k) => dayFields.get(k) ?? null }],
        ['block', { kind: 'block', height: CHILD_H, addressable: true, occupies: subset(blockKeys) }],
        ['shift', { kind: 'shift', height: CHILD_H, addressable: true, occupies: subset(shiftKeys) }],
    ]);
}

// ─── One campaign's sheet ────────────────────────────────────────────────────────

interface CampaignSheetProps {
    campaign: Campaign;
    groups: readonly ColumnGroupId[];
    canViewPrices: boolean;
    /** Bounded height. A stacked group gives each month the same window. */
    heightClass: string;
}

function CampaignSheet({ campaign, groups, canViewPrices, heightClass }: CampaignSheetProps) {
    const [expanded, setExpanded] = React.useState<ReadonlySet<string>>(() => new Set<string>());
    const [settings, setSettings] = React.useState<TableSettings>({});

    const days = React.useMemo(() => daysOf(campaign.id), [campaign.id]);
    const rollup = React.useMemo(() => rollupOf(campaign.id), [campaign.id]);

    const onToggle = React.useCallback((date: string) => {
        setExpanded((prev) => {
            const next = new Set(prev);
            if (next.has(date)) next.delete(date);
            else next.add(date);
            return next;
        });
    }, []);

    const blocksUsedOn = groups.includes('blocksUsed');

    // Referentially stable or the whole sheet re-renders: `ctx` is a dependency of the
    // column resolution and of every cell's format.
    const ctx = React.useMemo<SheetCtx>(
        () => ({ canViewPrices, expanded, onToggle, blocksUsedOn }),
        [canViewPrices, expanded, onToggle, blocksUsedOn],
    );

    const specs = React.useMemo(() => buildColumns(groups), [groups]);
    const kinds = React.useMemo(() => buildKinds(specs.map((s) => s.key)), [specs]);

    const items = React.useMemo<GridRow<SheetRow>[]>(() => {
        const out: GridRow<SheetRow>[] = [];
        days.forEach((day, i) => {
            out.push({ kind: 'day', id: day.date, data: { id: day.date, family: 'day', day, rowNum: i + 1 } });
            if (!expanded.has(day.date)) return;
            // Blocks first, then shifts — the sheet's own order, and the one that reads as
            // "where it came from, then what happened to it".
            if (blocksUsedOn) {
                day.blocks.forEach((block, bi) => {
                    out.push({
                        kind: 'block',
                        id: `${day.date}:b${bi}`,
                        data: { id: `${day.date}:b${bi}`, family: 'block', day, block, rowNum: 0 },
                    });
                });
            }
            day.shiftDetail.forEach((shift) => {
                out.push({
                    kind: 'shift',
                    id: `${day.date}:s${shift.shift}`,
                    data: { id: `${day.date}:s${shift.shift}`, family: 'shift', day, shift, rowNum: 0 },
                });
            });
        });
        return out;
    }, [days, expanded, blocksUsedOn]);

    const byId = React.useMemo(() => {
        const m = new Map<string, SheetRow>();
        for (const it of items) if ('data' in it && it.data) m.set(it.id as string, it.data);
        return m;
    }, [items]);

    const storedText = React.useCallback(
        (rowId: string, field: string) => {
            const row = byId.get(rowId);
            if (!row) return '';
            const spec = specs.find((s) => s.key === field);
            return spec?.clipboardValue ? spec.clipboardValue(row) : '';
        },
        [byId, specs],
    );

    const isDraft = React.useCallback(() => false, []);
    const edits = useTableEdits({ canonicalText: storedText, isDraft });

    /**
     * The campaign rule-off, ONE CELL PER COLUMN.
     *
     * Not the four lanes: a sheet with ~30 columns needs a different figure under each of
     * them, and a `renderChromeRow` would scroll away with the rows it is summarising.
     */
    const summaryCell = React.useCallback(
        (spec: ColumnSpec<SheetRow, SheetCtx>): TableSummaryCell | null => {
            const money = 'font-mono text-[11px] tabular-nums';
            switch (spec.key) {
                case 'date':
                    return { content: <span className="text-[10px] font-semibold uppercase tracking-wide">{campaign.label}</span> };
                case 'day':
                    return { content: <span className="text-[10px] text-muted-foreground">{rollup.workingDays} wd</span> };
                case 'fedprice':
                    return { content: <span className={money}>{php(rollup.fedPrice)}</span> };
                case 'fedkg':
                    return { content: <span className={cn(money, 'font-semibold')}>{kg(rollup.rcFedKg)}</span> };
                case 'prodkg':
                    return {
                        content: (
                            <span className={cn(money, 'font-semibold')}>
                                {kg(rollup.producedKg)}
                                <span className="ml-1 font-normal text-muted-foreground">
                                    {pctFromFraction(rollup.yieldPct, 1)}
                                </span>
                            </span>
                        ),
                    };
                case 'losskg':
                    return { content: <span className={money}>{kg(rollup.lossKg)}</span> };
                case 'dthrs':
                    return { content: <span className={money}>{hours(rollup.dtHours)}</span> };
                case 'b:resiko':
                    return { content: <span className={money}>{kg(rollup.blockResikoKg)}</span> };
                default: {
                    if (spec.key.startsWith('grade:')) {
                        const g = spec.key.slice(6) as (typeof GRADES)[number];
                        return { content: <span className={money}>{kg(days.reduce((s, d) => s + d.producedByGrade[g], 0))}</span> };
                    }
                    if (spec.key.startsWith('waste:')) {
                        const w = spec.key.slice(6) as (typeof WASTE_STREAMS)[number]['key'];
                        return { content: <span className={money}>{kg(days.reduce((s, d) => s + d.waste[w], 0))}</span> };
                    }
                    return null;
                }
            }
        },
        [campaign.label, rollup, days],
    );

    const summaryRows = React.useMemo<TableSummaryRow<SheetRow, SheetCtx>[]>(
        () => [{ key: 'campaign-total', cell: summaryCell, sticky: true, height: 34 }],
        [summaryCell],
    );

    const rowClassFor = React.useCallback((item: GridRow<SheetRow>) => {
        if (!('data' in item) || !item.data) return undefined;
        const row = item.data;
        if (row.family === 'day' && row.day.restDay) return 'text-muted-foreground/70';
        if (row.family !== 'day') return 'bg-muted/25';
        return undefined;
    }, []);

    return (
        <BlackwoodTable<SheetRow, SheetCtx>
            items={items}
            kinds={kinds}
            specs={specs}
            ctx={ctx}
            settings={settings}
            onSettingsChange={setSettings}
            edits={edits}
            storedText={storedText}
            // A campaign is ~31 days against ~30 columns — a plain sticky table, which is
            // exactly what the focus scope renders.
            scope="focus"
            childKinds={['block', 'shift']}
            rowClassFor={rowClassFor}
            summaryRows={summaryRows}
            emptyMessage="No days in this campaign."
            className={heightClass}
        />
    );
}

// ─── The page ────────────────────────────────────────────────────────────────────

const DEFAULT_GROUPS: ColumnGroupId[] = ['costs', 'production', 'grades', 'losses', 'blocksUsed'];

export function LedgerDraftA() {
    const data = OPS_LEDGER_DATA;
    const [mode, setMode] = React.useState<'single' | 'group'>('single');
    const [campaignId, setCampaignId] = React.useState(data.campaigns[1].id);
    const [groups, setGroups] = React.useState<ColumnGroupId[]>(DEFAULT_GROUPS);
    const [groupIds, setGroupIds] = React.useState<string[]>(['JULY-2026', 'AUGUST-2026', 'SEPTEMBER-2026']);
    const [groupName, setGroupName] = React.useState('Q3 2026');

    const group = React.useMemo(() => groupRollup(groupIds, groupName), [groupIds, groupName]);
    const shownCampaigns = React.useMemo(
        () =>
            mode === 'group'
                ? data.campaigns.filter((c) => groupIds.includes(c.id))
                : data.campaigns.filter((c) => c.id === campaignId),
        [mode, data.campaigns, groupIds, campaignId],
    );

    const wide = groups.includes('blocksFed');

    return (
        <main className="flex min-h-dvh flex-col bg-background text-foreground">
            <div className="flex flex-col gap-3 border-b border-border px-3 py-3 sm:px-4">
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                    <Link
                        href="/dev/ops-ledger"
                        className="flex items-center gap-1 text-[11px] text-muted-foreground transition-colors duration-150 hover:text-foreground"
                    >
                        <ArrowLeft className="size-3" />
                        Drafts
                    </Link>
                    <h1 className="text-sm font-semibold tracking-tight">A · Excel faithful</h1>
                    <p className="max-w-[70ch] text-[11px] leading-snug text-muted-foreground">
                        Explores: how little has to change if the sheet stays the sheet — month tabs,
                        frozen Date/Day, and a day that opens into <em>rows inside the grid</em>{' '}
                        rather than a panel beside it.
                    </p>
                </div>

                {/* MODE. Single month = the workbook's tabs. Group = the workbook's habit of
                    stacking three month tabs under one EOQ. */}
                <div className="flex flex-wrap items-center gap-2">
                    <div
                        role="tablist"
                        aria-label="View mode"
                        className="inline-flex items-center gap-0.5 rounded-md border border-input bg-muted/50 p-0.5"
                    >
                        {(['single', 'group'] as const).map((m) => (
                            <button
                                key={m}
                                type="button"
                                role="tab"
                                aria-selected={mode === m}
                                onClick={() => setMode(m)}
                                className={cn(
                                    'h-7 rounded px-2.5 text-xs font-medium transition-colors duration-150',
                                    mode === m ? 'bg-background shadow-sm' : 'text-muted-foreground hover:text-foreground',
                                )}
                            >
                                {m === 'single' ? 'Single month' : 'Group view'}
                            </button>
                        ))}
                    </div>

                    {mode === 'group' ? (
                        <GroupBuilder
                            selected={groupIds}
                            onChange={setGroupIds}
                            name={groupName}
                            onNameChange={setGroupName}
                        />
                    ) : null}

                    <div className="ml-auto">
                        <LensSwitcher groups={groups} onChange={setGroups} showHint={false} />
                    </div>
                </div>

                <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                    <ColumnGroupChips
                        groups={groups}
                        onChange={setGroups}
                        canViewPrices={data.canViewPrices}
                        showWidth
                    />
                </div>

                {/* THE THESIS, at the point of use. `Blocks fed` is not a different screen —
                    it is the sixth chip, and switching it on is what "go to RC Movement"
                    means here. */}
                <p className="text-[11px] leading-snug text-muted-foreground">
                    <span className="font-medium text-foreground">Blocks fed</span> is the same row
                    spine with one column per block instead of the ledger groups —{' '}
                    <span className="font-mono">/inventory/rc-movement</span>, as a chip.
                    {wide ? (
                        <span className="ml-1 text-amber-700 dark:text-amber-400">
                            In this draft that lens is a separate table below, because the block
                            columns and the eight blocks-used columns cannot share a header row
                            without the sheet reading as two sheets glued together.
                        </span>
                    ) : null}
                </p>

                {/* MONTH TABS — the workbook's own navigation, and only in single mode. */}
                {mode === 'single' ? (
                    <div role="tablist" aria-label="Campaign" className="flex gap-2 overflow-x-auto pb-1">
                        {data.campaigns.map((c) => {
                            const active = c.id === campaignId;
                            const r = rollupOf(c.id);
                            return (
                                <button
                                    key={c.id}
                                    type="button"
                                    role="tab"
                                    aria-selected={active}
                                    onClick={() => setCampaignId(c.id)}
                                    title={`${c.label} — ${c.startDate} → ${c.endDate}`}
                                    className={cn(
                                        'flex h-[54px] shrink-0 flex-col items-start justify-center gap-1 rounded-lg border px-4',
                                        'transition-[background-color,border-color,color] duration-150',
                                        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                                        active
                                            ? 'border-primary bg-primary text-primary-foreground shadow-sm'
                                            : 'border-border bg-card hover:border-foreground/25 hover:bg-muted/60',
                                    )}
                                >
                                    <span className="whitespace-nowrap text-[13px] font-semibold leading-none">
                                        {c.label}
                                    </span>
                                    <span
                                        className={cn(
                                            'whitespace-nowrap font-mono text-[10px] leading-none tabular-nums',
                                            active ? 'text-primary-foreground/75' : 'text-muted-foreground',
                                        )}
                                    >
                                        {kg(r.rcFedKg)} fed · {pctFromFraction(r.yieldPct, 1)}
                                    </span>
                                </button>
                            );
                        })}
                    </div>
                ) : null}
            </div>

            <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-3 sm:p-4">
                {mode === 'group' ? (
                    <KpiStrip
                        rollup={group.total}
                        canViewPrices={data.canViewPrices}
                        title={groupName || 'Untitled group'}
                        subtitle={
                            group.members.length === 0
                                ? 'No campaigns picked'
                                : `${group.members.length} campaign${group.members.length === 1 ? '' : 's'} · ${group.days[0]?.date} → ${group.days[group.days.length - 1]?.date}`
                        }
                        className="animate-fade-up"
                    />
                ) : null}

                {shownCampaigns.length === 0 ? (
                    <div className="animate-fade-up rounded-lg border border-dashed border-border p-8 text-center text-sm text-muted-foreground">
                        No campaigns in this group. Open the group builder and tick at least one
                        month.
                    </div>
                ) : null}

                {shownCampaigns.map((c) => (
                    <section key={c.id} className="flex flex-col gap-1.5">
                        {mode === 'group' ? (
                            <div className="flex items-baseline gap-2">
                                <h3 className="text-xs font-semibold uppercase tracking-wide">{c.label}</h3>
                                <span className="font-mono text-[10px] tabular-nums text-muted-foreground">
                                    {c.startDate} → {c.endDate}
                                </span>
                            </div>
                        ) : null}
                        <div className="overflow-hidden rounded-lg border border-border">
                            <CampaignSheet
                                campaign={c}
                                groups={groups}
                                canViewPrices={data.canViewPrices}
                                heightClass={mode === 'group' ? 'h-[420px]' : 'h-[calc(100dvh-320px)] min-h-[420px]'}
                            />
                        </div>
                    </section>
                ))}

                {wide ? <BlocksFedTable campaignIds={shownCampaigns.map((c) => c.id)} /> : null}
            </div>
        </main>
    );
}

// ─── The "Blocks fed" lens, draft A's way ────────────────────────────────────────

/**
 * A's answer to the RC Movement lens: a SECOND table below, not extra columns on the first.
 *
 * That is a real position, not a shortcut. This draft's whole argument is Excel fidelity,
 * and the paper sheet keeps its BLOCKS USED panel to the right of the day; hanging forty
 * more block columns off the same header row produces one table with two incompatible
 * headers. Drafts B and C take the other side of that argument — B folds it into the same
 * table, C puts it in the other pane — which is what makes the three worth comparing.
 */
function BlocksFedTable({ campaignIds }: { campaignIds: readonly string[] }) {
    const days = React.useMemo(
        () => campaignIds.flatMap((id) => daysOf(id)),
        [campaignIds],
    );
    const blocks = React.useMemo(() => {
        const seen = new Map<string, { batchCode: string; blockLoc: string; total: number }>();
        for (const d of days) {
            for (const b of d.blocks) {
                const f = seen.get(b.batchCode);
                if (f) f.total += b.fedKg;
                else seen.set(b.batchCode, { batchCode: b.batchCode, blockLoc: b.blockLoc, total: b.fedKg });
            }
        }
        return [...seen.values()];
    }, [days]);

    if (blocks.length === 0) return null;

    const W_D = 100;
    const W_B = 132;
    const minWidth = W_D + 84 + blocks.length * W_B;

    return (
        <section className="flex flex-col gap-1.5">
            <div className="flex items-baseline gap-2">
                <h3 className="text-xs font-semibold uppercase tracking-wide">Blocks fed</h3>
                <span className="text-[10px] text-muted-foreground">
                    the RC Movement lens — {blocks.length} block columns over the same {days.length}{' '}
                    day rows
                </span>
            </div>
            {/* NEVER CRUSH, ALWAYS SCROLL: min-width is the sum of the column minimums and
                the wrapper scrolls. */}
            <div className="max-h-[420px] overflow-auto rounded-lg border border-border">
                <table className="relative table-fixed text-xs" style={{ width: '100%', minWidth }}>
                    <colgroup>
                        <col width={W_D} />
                        <col width={84} />
                        {blocks.map((b) => (
                            <col key={b.batchCode} width={W_B} />
                        ))}
                    </colgroup>
                    <thead>
                        <tr>
                            {/* Frozen panes are OPAQUE — `bg-muted`, never `bg-muted/90`. A
                                surface that overlaps scrolling content cannot carry alpha. */}
                            <th
                                className="frozen-corner h-9 bg-muted px-2 py-1 text-left text-[10px] font-medium uppercase tracking-wide text-muted-foreground"
                                style={{ left: 0 }}
                            >
                                Date
                            </th>
                            <th
                                className="frozen-corner frozen-edge h-9 bg-muted px-2 py-1 text-left text-[10px] font-medium uppercase tracking-wide text-muted-foreground"
                                style={{ left: W_D }}
                            >
                                Day
                            </th>
                            {blocks.map((b) => (
                                <th
                                    key={b.batchCode}
                                    className="frozen-row h-9 bg-muted px-2 py-1 text-right"
                                    title={`${b.batchCode} · ${b.blockLoc}`}
                                >
                                    <span className="block truncate font-mono text-[11px] font-semibold">
                                        {b.batchCode}
                                    </span>
                                    <span className="block truncate font-mono text-[9px] font-normal text-muted-foreground">
                                        {b.blockLoc}
                                    </span>
                                </th>
                            ))}
                        </tr>
                    </thead>
                    <tbody>
                        {days.map((d) => {
                            const byBlock = new Map(d.blocks.map((b) => [b.batchCode, b.fedKg]));
                            return (
                                <tr key={d.date} className="group h-8 border-b border-border/60 transition-all duration-150 hover:bg-muted/40">
                                    <td
                                        className="frozen-col bg-background px-2 py-1 font-mono tabular-nums group-hover:bg-muted/40"
                                        style={{ left: 0 }}
                                    >
                                        {d.date}
                                    </td>
                                    <td
                                        className="frozen-col frozen-edge bg-background px-2 py-1 text-muted-foreground group-hover:bg-muted/40"
                                        style={{ left: W_D }}
                                    >
                                        {d.day}
                                    </td>
                                    {blocks.map((b) => {
                                        const v = byBlock.get(b.batchCode) ?? 0;
                                        return (
                                            <td
                                                key={b.batchCode}
                                                className={cn(
                                                    'px-2 py-1 text-right font-mono tabular-nums',
                                                    v > 0 && 'bg-emerald-500/10',
                                                )}
                                            >
                                                {kg(v)}
                                            </td>
                                        );
                                    })}
                                </tr>
                            );
                        })}
                    </tbody>
                </table>
            </div>
        </section>
    );
}
