'use client';

import * as React from 'react';
import Link from 'next/link';
import { ArrowLeft, PanelRightOpen } from 'lucide-react';

import { BlackwoodTable } from '@/components/shared/table';
import type { TableChromeRowApi, TableSummaryCell, TableSummaryRow } from '@/components/shared/table';
import type { ColumnSpec, GridRow, RowKind, TableSettings } from '@/lib/table';
import { useTableEdits } from '@/lib/hooks/use-table-edits';
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from '@/components/ui/sheet';
import { cn } from '@/lib/utils';

import { OPS_LEDGER_DATA, blocksFedBy, campaignOf } from '../_mock/data';
import { GRADES, WASTE_STREAMS, type CampaignRollup, type LedgerDay } from '../_mock/types';
import { groupRollup } from '../_shared/aggregate';
import { type ColumnGroupId } from '../_shared/column-groups';
import { count, hours, kg, pctFromFraction, php, phpM, tons } from '../_shared/format';
import { BlocksUsedTable, ShiftCards } from '../_shared/day-detail';
import { GroupBuilder } from '../_shared/group-builder';
import { KpiStrip } from '../_shared/kpi-strip';
import { ColumnGroupChips, LensSwitcher } from '../_shared/lens-controls';

// ═════════════════════════════════════════════════════════════════════════════════
// DRAFT B — "GROUP-FIRST DASHBOARD".
//
// THE AXIS: what if the GROUP is the unit and the days are the evidence?
//
// A reads top-to-bottom as a spreadsheet. B reads top-to-bottom as an ANSWER: the quarter's
// six headline figures, then the month-by-month comparison that explains them (the EOQ tab,
// live), and only then the days — as ONE continuous table with the months as heading rows
// inside it rather than three separate grids.
//
// ── THE THREE STRUCTURAL DECISIONS ──────────────────────────────────────────────
//
//   1. ONE TABLE, MONTHS AS CHROME ROWS. A's group view stacks N grids, so JULY's 30th and
//      AUGUST's 1st are in different scroll containers and cannot be compared without
//      leaving one of them. Here a month boundary is a `renderChromeRow` — a real row of
//      the sheet that the caret steps over — so the campaign changeover is one scroll line
//      apart, which is exactly where the interesting days are.
//
//   2. THE LENS IS A SEGMENTED CONTROL, AND `BLOCKS FED` FOLDS INTO THE SAME TABLE.
//      A puts the RC Movement matrix in a second table below, arguing the two headers do not
//      belong on one row. B takes the other side: the block columns are appended to the same
//      header, so switching lens changes which columns are there and NOTHING ELSE moves —
//      same rows, same pinned lanes, same scroll position. That IS the unification claim,
//      done literally.
//
//   3. THE BREAKDOWN IS A SIDE PANEL, NOT ROWS. Expanding in place moves every row below the
//      one you are reading. A panel leaves the ledger exactly where it was, which matters far
//      more here than in A because this table is ~90 rows rather than ~30. The cost is that
//      the breakdown is no longer in the grid's coordinate space and cannot be copied out
//      with its day — which is precisely what A keeps.
//
// READ-ONLY, structurally: no `parse`, no `renderEditor`, so no editor can open anywhere.
// ═════════════════════════════════════════════════════════════════════════════════

// Widths carry the same measured +57 chrome budget as draft A (CLAUDE.md, 2026-08-29).
const W_OPEN = 40;
const W_DATE = 100;
const W_DAY = 84;
const W_FEDPRICE = 112;
const W_FEDKG = 124;
const W_PRODKG = 140;
const W_LOSSKG = 140;
const W_YIELD = 108;
const W_SHIFTS = 128;
const W_DTHRS = 132;
const W_GRADE = 92;
const W_WASTE = 108;
const W_BLOCKS = 120;
/** A block column: the batch code in mono 11px (115.5px at 16 chars) + 17px of chrome. */
const W_BLOCKCOL = 148;

const ROW_H = 32;
const GROUP_RULE = 'border-l-2 border-l-border';

interface BRow {
    id: string;
    day: LedgerDay;
}

interface BCtx {
    canViewPrices: boolean;
    onOpenDay(date: string): void;
}

const mono = (text: string, extra?: string) => (
    <span className={cn('font-mono tabular-nums', extra)}>{text}</span>
);

function pesoCell(value: number | null) {
    if (value === null) return null;
    return (
        <span className="flex w-full items-baseline justify-between gap-1 font-mono tabular-nums">
            <span className="text-muted-foreground">&#8369;</span>
            <span>{php(value)}</span>
        </span>
    );
}

function withRule(rule: boolean, body: React.ReactNode) {
    if (!rule) return body;
    return (
        <span className={cn('absolute inset-0 flex items-center justify-end px-2', GROUP_RULE)}>
            {body}
        </span>
    );
}

// ─── Columns ─────────────────────────────────────────────────────────────────────

function buildColumns(
    groups: readonly ColumnGroupId[],
    blocks: readonly { batchCode: string; blockLoc: string; totalKg: number }[],
): ColumnSpec<BRow, BCtx>[] {
    const on = (id: ColumnGroupId) => groups.includes(id);
    const out: ColumnSpec<BRow, BCtx>[] = [];

    out.push({
        key: 'open',
        label: '',
        title: 'Open this day in the side panel',
        width: W_OPEN,
        pin: 'start',
        align: 'center',
        cellKind: 'derived',
        resizable: false,
        hideable: false,
        rowCopy: false,
        format: (row, ctx) =>
            row.day.restDay ? null : (
                <button
                    type="button"
                    aria-label={`Open ${row.day.date}`}
                    data-grid-chrome
                    onMouseDown={(e) => e.stopPropagation()}
                    onClick={(e) => {
                        e.stopPropagation();
                        ctx.onOpenDay(row.day.date);
                    }}
                    className="flex size-5 items-center justify-center rounded text-muted-foreground/60 transition-colors duration-150 hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                >
                    <PanelRightOpen className="size-3.5" />
                </button>
            ),
    });

    out.push(
        {
            key: 'date',
            label: 'DATE',
            title: 'Calendar day (yyyy-MM-dd)',
            width: W_DATE,
            pin: 'start',
            cellKind: 'readonly',
            selectable: true,
            clipboardValue: (r) => r.day.date,
            format: (r) => mono(r.day.date, r.day.restDay ? 'text-muted-foreground' : undefined),
        },
        {
            key: 'day',
            label: 'DAY',
            title: 'Day of week',
            width: W_DAY,
            pin: 'start',
            cellKind: 'readonly',
            selectable: true,
            clipboardValue: (r) => r.day.day,
            format: (r) => (
                <span
                    className={cn(
                        'text-muted-foreground',
                        r.day.day === 'Sun' && 'text-amber-600 dark:text-amber-400',
                    )}
                >
                    {r.day.day}
                </span>
            ),
        },
    );

    if (on('costs')) {
        out.push({
            key: 'fedprice',
            label: 'FED ₱/KG',
            title: "The day's weighted-average delivered price per kilogram fed",
            width: W_FEDPRICE,
            pin: 'start',
            align: 'right',
            cellKind: 'readonly',
            selectable: true,
            calcType: 'AVERAGE',
            visible: (ctx) => ctx.canViewPrices,
            numericValue: (r) => r.day.fedPhpKg,
            clipboardValue: (r) => (r.day.fedPhpKg === null ? '' : String(r.day.fedPhpKg)),
            format: (r) => pesoCell(r.day.fedPhpKg),
        });
    }

    if (on('production')) {
        out.push(
            {
                key: 'fedkg',
                label: 'TTL FED KG',
                title: 'Total kg of raw charcoal fed into the plant',
                width: W_FEDKG,
                pin: 'start',
                align: 'right',
                cellKind: 'readonly',
                selectable: true,
                calcType: 'SUM',
                numericValue: (r) => r.day.fedKg,
                clipboardValue: (r) => String(r.day.fedKg),
                format: (r) => mono(kg(r.day.fedKg), 'font-medium'),
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
                numericValue: (r) => r.day.producedKg,
                clipboardValue: (r) => String(r.day.producedKg),
                format: (r) => withRule(true, mono(kg(r.day.producedKg), 'font-medium')),
            },
            {
                key: 'yield',
                label: 'YIELD',
                title: 'Produced ÷ fed, for the day',
                width: W_YIELD,
                align: 'right',
                cellKind: 'readonly',
                selectable: true,
                calcType: 'AVERAGE',
                numericValue: (r) => (r.day.fedKg > 0 ? r.day.producedKg / r.day.fedKg : null),
                clipboardValue: (r) => (r.day.fedKg > 0 ? String(r.day.producedKg / r.day.fedKg) : ''),
                format: (r) =>
                    r.day.fedKg === 0 ? null : mono(pctFromFraction(r.day.producedKg / r.day.fedKg, 1)),
            },
            {
                key: 'losskg',
                label: 'TTL LOSS KG',
                title: 'Fed minus produced',
                width: W_LOSSKG,
                align: 'right',
                cellKind: 'readonly',
                selectable: true,
                calcType: 'SUM',
                numericValue: (r) => r.day.lossKg,
                clipboardValue: (r) => String(r.day.lossKg),
                format: (r) => mono(kg(r.day.lossKg), 'text-muted-foreground'),
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
                numericValue: (r) => r.day.shifts,
                clipboardValue: (r) => (r.day.shifts ? String(r.day.shifts) : ''),
                format: (r) => (r.day.shifts ? mono(String(r.day.shifts)) : null),
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
                numericValue: (r) => r.day.dtHours,
                clipboardValue: (r) => (r.day.restDay ? '' : hours(r.day.dtHours)),
                format: (r) =>
                    r.day.restDay
                        ? null
                        : mono(
                              hours(r.day.dtHours),
                              r.day.dtHours > 0 ? 'text-amber-700 dark:text-amber-400' : 'text-muted-foreground',
                          ),
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
                numericValue: (r) => r.day.producedByGrade[g],
                clipboardValue: (r) => String(r.day.producedByGrade[g]),
                format: (r) => withRule(i === 0, mono(kg(r.day.producedByGrade[g]))),
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
                numericValue: (r) => r.day.waste[w.key],
                clipboardValue: (r) => String(r.day.waste[w.key]),
                format: (r) => withRule(i === 0, mono(kg(r.day.waste[w.key]), 'text-muted-foreground')),
            });
        });
    }

    if (on('blocksUsed')) {
        out.push({
            key: 'blocks',
            label: 'BLOCKS',
            title: 'How many blocks the day drew from — open the day to see which',
            width: W_BLOCKS,
            align: 'right',
            cellKind: 'readonly',
            selectable: true,
            calcType: 'SUM',
            numericValue: (r) => r.day.blocks.length || null,
            clipboardValue: (r) => (r.day.blocks.length ? String(r.day.blocks.length) : ''),
            // ONE COLUMN, not eight. In this draft the eight BLOCKS-USED fields live in the
            // side panel, because folding several block rows into a ledger that is already
            // one continuous ~90-row table is what A does and what B is arguing against.
            format: (r) => withRule(true, mono(count(r.day.blocks.length), 'text-muted-foreground')),
        });
    }

    if (on('blocksFed')) {
        blocks.forEach((b, i) => {
            out.push({
                key: `blk:${b.batchCode}`,
                label: b.batchCode,
                labelNode: (
                    <span className="block truncate font-mono text-[11px] font-semibold normal-case leading-tight tracking-normal text-foreground">
                        {b.batchCode}
                    </span>
                ),
                subLabel: b.blockLoc,
                title: `${b.batchCode} · ${b.blockLoc} · ${kg(b.totalKg)} kg fed over the group`,
                width: W_BLOCKCOL,
                align: 'right',
                cellKind: 'readonly',
                selectable: true,
                // NO sort and NO filter on a block column — the row axis is the calendar, and
                // re-ordering the days by how much came out of one block produces a feeding
                // matrix in no order at all. It is also what buys the column back the 40px of
                // chrome its 16-character batch code needs. (Same reasoning, verbatim, as the
                // live `rc-movement-grid-v2.tsx`.)
                sortable: false,
                filterable: false,
                calcType: 'SUM',
                numericValue: (r) => r.day.blocks.find((x) => x.batchCode === b.batchCode)?.fedKg ?? null,
                clipboardValue: (r) => {
                    const v = r.day.blocks.find((x) => x.batchCode === b.batchCode)?.fedKg;
                    return v ? String(v) : '';
                },
                format: (r) => {
                    const v = r.day.blocks.find((x) => x.batchCode === b.batchCode)?.fedKg ?? 0;
                    return withRule(
                        i === 0,
                        <span className={cn('font-mono tabular-nums', v > 0 && 'text-foreground')}>{kg(v)}</span>,
                    );
                },
                cellClass: (row) =>
                    row && row.day.blocks.some((x) => x.batchCode === b.batchCode)
                        ? 'bg-emerald-500/10'
                        : undefined,
            });
        });
    }

    return out;
}

// ─── The EOQ analysis table ──────────────────────────────────────────────────────

/**
 * The `EOQ3 2026` tab, live: one row per campaign in the group, plus the group total.
 *
 * A hand-built table rather than a second Blackwood Table, deliberately — it is at most
 * four rows and it wants a sticky first column and a rule-off, not sorting, filtering,
 * selection or a caret. Reaching for the grid primitive here would be using a spreadsheet
 * to render a summary.
 */
function EoqTable({
    members,
    total,
    canViewPrices,
}: {
    members: readonly CampaignRollup[];
    total: CampaignRollup;
    canViewPrices: boolean;
}) {
    if (members.length === 0) return null;

    const cols: { key: string; label: string; unit?: string; price?: boolean; value(r: CampaignRollup): string }[] = [
        { key: 'fed', label: 'RC FED', unit: 't', value: (r) => tons(r.rcFedKg) },
        { key: 'prod', label: 'PRODUCED', unit: 't', value: (r) => tons(r.producedKg) },
        { key: 'yield', label: 'YIELD', value: (r) => pctFromFraction(r.yieldPct, 2) },
        { key: 'loss', label: 'LOSS', unit: 't', value: (r) => tons(r.lossKg) },
        { key: 'resiko', label: 'BLOCK RESIKO', unit: 't', value: (r) => tons(r.blockResikoKg) },
        { key: 'fedprice', label: 'FED PRICE', unit: '₱/kg', price: true, value: (r) => php(r.fedPrice) },
        { key: 'actual', label: 'ACTUAL FED PRICE', unit: '₱/kg', price: true, value: (r) => php(r.actualFedPrice) },
        { key: 'pc', label: 'PC COST', unit: '₱/kg', price: true, value: (r) => php(r.pcCost) },
        { key: 'truepc', label: 'TRUE PC COST', unit: '₱/kg', price: true, value: (r) => php(r.truePcCost) },
        { key: 'inv', label: 'RC INVENTORY', unit: 't', value: (r) => tons(r.rcInventoryTons * 1000) },
        { key: 'invphp', label: 'RC INV VALUE', unit: '₱M', price: true, value: (r) => phpM(r.rcInventoryPhp) },
        { key: 'buyt', label: 'BUYING', unit: 't', value: (r) => tons(r.buyingTons * 1000) },
        { key: 'buyphp', label: 'BUYING VALUE', unit: '₱M', price: true, value: (r) => phpM(r.buyingPhp) },
    ];
    // A ₱ column is ABSENT for a viewer who may not see prices, never blanked.
    const shown = cols.filter((c) => canViewPrices || !c.price);

    return (
        <section className="flex flex-col gap-1.5">
            <div className="flex items-baseline gap-2">
                <h3 className="text-xs font-semibold uppercase tracking-wide">Month by month</h3>
                <span className="text-[10px] text-muted-foreground">
                    the EOQ tab — the comparison A’s stacked grids cannot make
                </span>
            </div>
            {/* NEVER CRUSH, ALWAYS SCROLL. */}
            <div className="overflow-x-auto rounded-lg border border-border">
                <table
                    className="relative table-fixed text-xs"
                    style={{ width: '100%', minWidth: 160 + shown.length * 108 }}
                >
                    <colgroup>
                        <col width={160} />
                        {shown.map((c) => (
                            <col key={c.key} width={108} />
                        ))}
                    </colgroup>
                    <thead>
                        <tr>
                            {/* Frozen surfaces are OPAQUE — solid `bg-muted`, never glass. */}
                            <th
                                className="frozen-corner frozen-edge h-9 bg-muted px-2 py-1 text-left text-[10px] font-medium uppercase tracking-wide text-muted-foreground"
                                style={{ left: 0 }}
                            >
                                Campaign
                            </th>
                            {shown.map((c) => (
                                <th
                                    key={c.key}
                                    className="frozen-row h-9 bg-muted px-2 py-1 text-right align-bottom"
                                >
                                    {/* WRAPS rather than truncating. `ACTUAL FED PRICE` does not
                                        fit 108px on one line, and a summary table with 13 lanes is
                                        exactly where a two-line header is cheaper than 13 wider
                                        columns — the opposite trade to the day sheet, where the
                                        header row's height is paid by every column. */}
                                    <span className="block text-[10px] font-medium uppercase leading-tight tracking-wide text-muted-foreground">
                                        {c.label}
                                    </span>
                                    {c.unit ? (
                                        <span className="block text-[9px] font-normal text-muted-foreground/70">
                                            {c.unit}
                                        </span>
                                    ) : null}
                                </th>
                            ))}
                        </tr>
                    </thead>
                    <tbody>
                        {members.map((m) => (
                            <tr
                                key={m.campaignId}
                                className="group h-8 border-b border-border/60 transition-all duration-150 hover:bg-muted/40"
                            >
                                <td
                                    className="frozen-col frozen-edge bg-background px-2 py-1 font-medium group-hover:bg-muted/40"
                                    style={{ left: 0 }}
                                >
                                    {m.label}
                                </td>
                                {shown.map((c) => (
                                    <td key={c.key} className="px-2 py-1 text-right font-mono tabular-nums">
                                        {c.value(m)}
                                    </td>
                                ))}
                            </tr>
                        ))}
                    </tbody>
                    <tfoot>
                        <tr className="h-8 border-t border-border bg-muted font-semibold">
                            <td className="frozen-corner-bottom frozen-edge px-2 py-1 bg-muted" style={{ left: 0 }}>
                                {total.label || 'GROUP'}
                            </td>
                            {shown.map((c) => (
                                <td
                                    key={c.key}
                                    className="frozen-row-bottom frozen-edge-top bg-muted px-2 py-1 text-right font-mono tabular-nums"
                                >
                                    {c.value(total)}
                                </td>
                            ))}
                        </tr>
                    </tfoot>
                </table>
            </div>
            <p className="text-[10px] leading-snug text-muted-foreground">
                The group row is <span className="font-medium">re-summed from the days</span>, never
                averaged across the months — the mean of three yields belongs to no quarter. Stock
                is a level, so RC INVENTORY is the last campaign’s, not the sum of three.
            </p>
        </section>
    );
}

// ─── The page ────────────────────────────────────────────────────────────────────

const DEFAULT_GROUPS: ColumnGroupId[] = ['costs', 'production', 'grades', 'losses', 'blocksUsed'];

export function LedgerDraftB() {
    const data = OPS_LEDGER_DATA;
    const [groupIds, setGroupIds] = React.useState<string[]>(['JULY-2026', 'AUGUST-2026', 'SEPTEMBER-2026']);
    const [groupName, setGroupName] = React.useState('Q3 2026');
    const [groups, setGroups] = React.useState<ColumnGroupId[]>(DEFAULT_GROUPS);
    const [openDate, setOpenDate] = React.useState<string | null>(null);
    const [settings, setSettings] = React.useState<TableSettings>({});

    const group = React.useMemo(() => groupRollup(groupIds, groupName), [groupIds, groupName]);
    const days = group.days;

    const blocks = React.useMemo(
        () => (groups.includes('blocksFed') ? blocksFedBy(days) : []),
        [groups, days],
    );

    const onOpenDay = React.useCallback((date: string) => setOpenDate(date), []);
    const ctx = React.useMemo<BCtx>(
        () => ({ canViewPrices: data.canViewPrices, onOpenDay }),
        [data.canViewPrices, onOpenDay],
    );

    const specs = React.useMemo(() => buildColumns(groups, blocks), [groups, blocks]);

    const kinds = React.useMemo<ReadonlyMap<string, RowKind<BRow>>>(() => {
        const fields = new Map<string, { field: string; editable: boolean; addressable?: boolean }>();
        for (const s of specs) fields.set(s.key, { field: s.key, editable: false, addressable: s.key !== 'open' });
        return new Map<string, RowKind<BRow>>([
            ['day', { kind: 'day', height: ROW_H, addressable: true, occupies: (k) => fields.get(k) ?? null }],
            // A month heading is a REAL row of the sheet and NOT addressable — the caret
            // steps straight over it, so the coordinate space is identical with and without
            // the headings. The kind is `group-header` because `GridRow`'s chrome variant
            // is a closed union of exactly three names; the family means "month" here.
            ['group-header', { kind: 'group-header', height: 30, addressable: false, occupies: () => null }],
        ]);
    }, [specs]);

    /** Day rows, with a heading row inserted at every campaign change. */
    const items = React.useMemo<GridRow<BRow>[]>(() => {
        const out: GridRow<BRow>[] = [];
        let prev: string | undefined;
        for (const day of days) {
            if (day.campaignId !== prev) {
                out.push({ kind: 'group-header', key: `mh:${day.campaignId}` });
                prev = day.campaignId;
            }
            out.push({ kind: 'day', id: day.date, data: { id: day.date, day } });
        }
        return out;
    }, [days]);

    const byId = React.useMemo(() => {
        const m = new Map<string, BRow>();
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
     * A MONTH HEADING, tiled onto the column table rather than guessed at.
     *
     * The pinned block gets its own OPAQUE cell (any alpha and the scrolling rows bleed
     * through it) at the run's cumulative `left`; everything right of it is one span. A lane
     * of span 0 renders NO cell, because `colSpan={0}` means "to the end of the column
     * group" in HTML.
     */
    const renderChromeRow = React.useCallback(
        (item: GridRow<BRow>, api: TableChromeRowApi<BRow, BCtx>) => {
            if (item.kind !== 'group-header' || !('key' in item)) return null;
            const campaignId = item.key.slice(item.key.indexOf(':') + 1);
            const campaign = campaignOf(campaignId);
            const roll = group.members.find((m) => m.campaignId === campaignId);
            const rest = api.colCount - api.spans.frozen;
            const base = 'border-y border-border px-2 py-1 text-[11px] font-semibold';
            return (
                <>
                    {api.spans.frozen > 0 ? (
                        <th
                            scope="row"
                            colSpan={api.spans.frozen}
                            className={`frozen-col frozen-edge bg-background text-left ${base}`}
                            style={{ left: 0 }}
                        >
                            {campaign.label}
                        </th>
                    ) : null}
                    {rest > 0 ? (
                        <td colSpan={rest} className={`bg-muted text-left font-normal ${base}`}>
                            <span className="font-mono text-[10px] tabular-nums text-muted-foreground">
                                {campaign.startDate} → {campaign.endDate}
                                {roll
                                    ? ` · ${kg(roll.rcFedKg)} kg fed · ${kg(roll.producedKg)} kg produced · ${pctFromFraction(roll.yieldPct, 2)} yield · ${count(roll.workingDays)} working days`
                                    : ''}
                            </span>
                        </td>
                    ) : null}
                </>
            );
        },
        [group.members],
    );

    const summaryCell = React.useCallback(
        (spec: ColumnSpec<BRow, BCtx>): TableSummaryCell | null => {
            const t = group.total;
            const m = 'font-mono text-[11px] tabular-nums';
            switch (spec.key) {
                case 'date':
                    return { content: <span className="text-[10px] font-semibold uppercase tracking-wide">{t.label || 'GROUP'}</span> };
                case 'day':
                    return { content: <span className="text-[10px] text-muted-foreground">{t.workingDays} wd</span> };
                case 'fedprice':
                    return { content: <span className={m}>{php(t.fedPrice)}</span> };
                case 'fedkg':
                    return { content: <span className={cn(m, 'font-semibold')}>{kg(t.rcFedKg)}</span> };
                case 'prodkg':
                    return { content: <span className={cn(m, 'font-semibold')}>{kg(t.producedKg)}</span> };
                case 'yield':
                    return { content: <span className={m}>{pctFromFraction(t.yieldPct, 2)}</span> };
                case 'losskg':
                    return { content: <span className={m}>{kg(t.lossKg)}</span> };
                case 'dthrs':
                    return { content: <span className={m}>{hours(t.dtHours)}</span> };
                case 'blocks':
                    return { content: <span className={m}>{count(t.blocksOpened)}</span> };
                default: {
                    if (spec.key.startsWith('grade:')) {
                        const g = spec.key.slice(6) as (typeof GRADES)[number];
                        return { content: <span className={m}>{kg(group.producedByGrade[g])}</span> };
                    }
                    if (spec.key.startsWith('waste:')) {
                        const w = spec.key.slice(6) as (typeof WASTE_STREAMS)[number]['key'];
                        return { content: <span className={m}>{kg(days.reduce((s, d) => s + d.waste[w], 0))}</span> };
                    }
                    if (spec.key.startsWith('blk:')) {
                        const code = spec.key.slice(4);
                        const b = blocks.find((x) => x.batchCode === code);
                        return { content: <span className={m}>{kg(b?.totalKg ?? 0)}</span> };
                    }
                    return null;
                }
            }
        },
        [group, days, blocks],
    );

    const summaryRows = React.useMemo<TableSummaryRow<BRow, BCtx>[]>(
        () => [{ key: 'group-total', cell: summaryCell, sticky: true, height: 34 }],
        [summaryCell],
    );

    const rowClassFor = React.useCallback((item: GridRow<BRow>) => {
        if (!('data' in item) || !item.data) return undefined;
        return item.data.day.restDay ? 'text-muted-foreground/70' : undefined;
    }, []);

    const openDay = openDate ? days.find((d) => d.date === openDate) ?? null : null;

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
                    <h1 className="text-sm font-semibold tracking-tight">B · Group-first dashboard</h1>
                    <p className="max-w-[70ch] text-[11px] leading-snug text-muted-foreground">
                        Explores: what if the <em>group</em> is the unit and the days are the evidence
                        — the quarter answered at the top, then one continuous ledger with the months
                        as heading rows inside it.
                    </p>
                </div>

                <div className="flex flex-wrap items-start gap-x-4 gap-y-2">
                    <GroupBuilder
                        selected={groupIds}
                        onChange={setGroupIds}
                        name={groupName}
                        onNameChange={setGroupName}
                    />
                    <LensSwitcher groups={groups} onChange={setGroups} />
                    <ColumnGroupChips
                        groups={groups}
                        onChange={setGroups}
                        canViewPrices={data.canViewPrices}
                        className="ml-auto"
                    />
                </div>
            </div>

            <div className="flex min-h-0 flex-1 flex-col gap-4 p-3 sm:p-4">
                <KpiStrip
                    rollup={group.total}
                    canViewPrices={data.canViewPrices}
                    title={groupName || 'Untitled group'}
                    subtitle={
                        group.members.length === 0
                            ? 'No campaigns picked'
                            : `${group.members.length} campaign${group.members.length === 1 ? '' : 's'} · ${days[0]?.date} → ${days[days.length - 1]?.date} · ${days.length} calendar days`
                    }
                    className="animate-fade-up"
                />

                <EoqTable members={group.members} total={group.total} canViewPrices={data.canViewPrices} />

                {days.length === 0 ? (
                    <div className="animate-fade-up rounded-lg border border-dashed border-border p-8 text-center text-sm text-muted-foreground">
                        No campaigns in this group. Open the group builder and tick at least one month.
                    </div>
                ) : (
                    <section className="flex min-h-0 flex-1 flex-col gap-1.5">
                        <div className="flex items-baseline gap-2">
                            <h3 className="text-xs font-semibold uppercase tracking-wide">Day ledger</h3>
                            <span className="text-[10px] text-muted-foreground">
                                {days.length} rows, {group.members.length} month heading
                                {group.members.length === 1 ? '' : 's'} — one table, so a changeover day
                                is one scroll line from the day before it
                            </span>
                        </div>
                        {/* An EXPLICIT height, not `flex-1`. The page itself scrolls (KPIs, then
                            the EOQ table, then this), so a ledger that grew to its content would
                            have no scrollport of its own and its sticky group-total footer would
                            have nothing to stick to. */}
                        <div className="h-[560px] overflow-hidden rounded-lg border border-border">
                            <BlackwoodTable<BRow, BCtx>
                                items={items}
                                kinds={kinds}
                                specs={specs}
                                ctx={ctx}
                                settings={settings}
                                onSettingsChange={setSettings}
                                edits={edits}
                                storedText={storedText}
                                scope="focus"
                                rowClassFor={rowClassFor}
                                renderChromeRow={renderChromeRow}
                                summaryRows={summaryRows}
                                emptyMessage="No days in this group."
                                className="h-full"
                            />
                        </div>
                    </section>
                )}
            </div>

            {/* THE BREAKDOWN, in a panel. The ledger behind it has not moved. */}
            <Sheet open={openDay !== null} onOpenChange={(o) => !o && setOpenDate(null)}>
                <SheetContent side="right" className="w-full gap-0 overflow-y-auto sm:max-w-[560px]">
                    {openDay ? (
                        <>
                            <SheetHeader className="border-b border-border bg-background/90 pb-3 backdrop-blur-sm">
                                <SheetTitle className="font-mono text-base tabular-nums">
                                    {openDay.date} · {openDay.day}
                                </SheetTitle>
                                <SheetDescription>
                                    {campaignOf(openDay.campaignId).label} — {kg(openDay.fedKg)} kg fed,{' '}
                                    {kg(openDay.producedKg)} kg produced,{' '}
                                    {pctFromFraction(openDay.fedKg > 0 ? openDay.producedKg / openDay.fedKg : null, 2)}{' '}
                                    yield.
                                </SheetDescription>
                            </SheetHeader>
                            <div className="flex flex-col gap-4 p-4">
                                <ShiftCards day={openDay} canViewPrices={data.canViewPrices} />
                                <div className="flex flex-col gap-1.5">
                                    <h4 className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                                        Blocks used
                                    </h4>
                                    <BlocksUsedTable day={openDay} />
                                </div>
                            </div>
                        </>
                    ) : null}
                </SheetContent>
            </Sheet>
        </main>
    );
}
