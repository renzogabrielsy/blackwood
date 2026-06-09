'use client';

import * as React from 'react';
import { cn } from '@/lib/utils';
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
import type { RcMovementMatrix as RcMovementMatrixData, RcMovementMatrixColumn } from './actions';
import { BlockingDetailPanel } from '../blocking/blocking-detail-panel';
import { fetchBlockDataForBatch } from '../blocking/actions';
import type { BlockData } from '../blocking/types';

// ---------------------------------------------------------------------------
// Frozen-pane column geometry (Excel Standard — explicit pixel widths).
// Left frozen columns are pinned via cumulative `left` offsets.
// ---------------------------------------------------------------------------
const W_ROWNUM = 48;
const W_DATE = 100;
const W_DAY = 52;
const W_BATCH = 96;
const W_FEDPRICE = 96; // frozen "Fed ₱/kg" column, BETWEEN Batch and Total fed
const W_TOTAL = 88;
const W_BLOCK = 92; // each dynamic block column
// ── Scrolling PRODUCED section (after the frozen Total fed, BEFORE the block cols) ──
const W_PRODUCED = 88; // TOTAL PRODUCED column (matches W_TOTAL rhythm)
const W_GRADE = 80; // each dynamic per-grade column

// Column-group divider — a 2px left border marking the start of a scrolling column
// GROUP (the 2px divider idiom already used elsewhere, e.g. the cenapro ledger's
// border-l-2). Placed on the FIRST cell of the PRODUCED group and again on the FIRST
// cell of the BLOCK group, so FED-blocks vs PRODUCED read as distinct sections.
const GROUP_DIVIDER = 'border-l-2 border-l-border';

// Cumulative left offsets (each frozen column's left = sum of widths to its left).
// Column order: # · Date · Day · Batch · Fed ₱/kg · Total fed (last frozen, carries .frozen-edge).
const LEFT_ROWNUM = 0;
const LEFT_DATE = W_ROWNUM;
const LEFT_DAY = W_ROWNUM + W_DATE;
const LEFT_BATCH = W_ROWNUM + W_DATE + W_DAY;
const LEFT_FEDPRICE = W_ROWNUM + W_DATE + W_DAY + W_BATCH;
const LEFT_TOTAL = W_ROWNUM + W_DATE + W_DAY + W_BATCH + W_FEDPRICE;

// Frozen-pane z-scale + opacity: see the canonical "Frozen Panes" pattern in
// globals.css. Frozen surfaces overlap scrolling content, so they are ALWAYS
// OPAQUE (solid theme token, never the /opacity glass pattern). Z-scale, low→high:
//   normal scrolling cell (base) < .frozen-col (10) < .frozen-row (20) < .frozen-corner (30)
// The utility classes own position + z + (for the last frozen col) the anti-seam edge.

/** Integer kg with thousands separators; blank for zero/empty. */
function fmtKg(n: number | undefined): string {
    if (!n || n === 0) return '';
    return Math.round(n).toLocaleString('en-US');
}

/** 2-decimal percent for a lab metric; em-dash when absent/zero. */
function fmtPct2(n: number | undefined): string {
    if (n === undefined || n === null || n === 0) return '—';
    return `${n.toFixed(2)}%`;
}

/** Accounting-format number (2 dp, thousands separators); null/zero-fed renders blank. */
function fmtPrice(n: number | null | undefined): string {
    if (n === null || n === undefined) return '';
    return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** Yield fraction → 1-dp percent (×100). Em-dash when null (total_fed = 0). 0 stays "0.0%". */
function fmtYieldPct(fraction: number | null): string {
    if (fraction === null || fraction === undefined) return '—';
    return `${(fraction * 100).toFixed(1)}%`;
}

/** Signed 2-decimal percent for block loss; em-dash when the ratio is null (in = 0). */
function fmtSignedPct(ratio: number | null): string {
    if (ratio === null || ratio === undefined) return '—';
    const pct = ratio * 100;
    const sign = pct > 0 ? '+' : '';
    return `${sign}${pct.toFixed(2)}%`;
}

/**
 * Maps a batch status to the per-column footer cell's WHOLE-CELL tint. The state is
 * now communicated by coloring the entire footer cell (the dot/badge was removed).
 *
 * CRITICAL — these tints MUST be OPAQUE. The footer is a frozen/sticky surface that
 * overlaps scrolling content, so any alpha (/opacity, glass) reopens the bleed-through
 * bug. Use SOLID color tokens only. The tint REPLACES the `bg-muted` base on these
 * per-column cells (one bg per element — never layer a translucent tint over bg-muted).
 *
 * Convention (feed-completion, distinct from the Blocking heatmap palette):
 *   IN-USE (active)                          → blue
 *   CLOSED / depleted / non-active           → red
 *   STORED / SUNDRYING / SUNDRIED / other    → neutral muted
 */
function statusTint(status: string): string {
    switch (status) {
        case 'IN-USE':
            // Blue cell. Foreground stays readable in both modes.
            return 'bg-blue-100 dark:bg-blue-950 text-blue-950 dark:text-blue-50';
        case 'CLOSED':
        case 'FEED':
            // Red cell. Foreground stays readable in both modes.
            return 'bg-red-100 dark:bg-red-950 text-red-950 dark:text-red-50';
        default:
            // STORED / SUNDRYING / SUNDRIED / anything else → neutral.
            return 'bg-muted text-foreground';
    }
}

interface RcMovementMatrixProps {
    data: RcMovementMatrixData;
    /** Called when the user picks a different production campaign from the toolbar Select.
     *  Receives the encoded campaign key (e.g. "JUNE-2026"). */
    onCampaignChange?: (campaign: string) => void;
}

export function RcMovementMatrix({ data, onCampaignChange }: RcMovementMatrixProps) {
    const {
        campaign, columns, rows, campaignOptions, grandTotalFed, campaignAvgFedPrice,
        producedGrades, campaignTotalProduced, campaignYieldPct,
    } = data;

    const handleCampaignChange = (value: string) => {
        onCampaignChange?.(value);
    };

    // ── Detail panel (shared with the Blocking tab) ──
    // Clicking a block column header opens BlockingDetailPanel for THAT column's batch.
    // We fetch a batch-accurate BlockData via fetchBlockDataForBatch (NOT the grid map),
    // because a historical column's batch may be CLOSED / its slot reused and therefore
    // absent from view_blocking_grid. canViewPrices comes back from the same call.
    const [selectedColumn, setSelectedColumn] = React.useState<RcMovementMatrixColumn | null>(null);
    const [panelBlockData, setPanelBlockData] = React.useState<BlockData | null>(null);
    const [panelCanViewPrices, setPanelCanViewPrices] = React.useState(false);

    const handleHeaderClick = React.useCallback((column: RcMovementMatrixColumn) => {
        setSelectedColumn(column);
        setPanelBlockData(null); // panel shows its loading state until this resolves
        fetchBlockDataForBatch(column.batchId).then((result) => {
            setPanelBlockData(result.blockData);
            setPanelCanViewPrices(result.canViewPrices);
        });
    }, []);

    const handlePanelClose = React.useCallback(() => {
        setSelectedColumn(null);
        setPanelBlockData(null);
    }, []);

    // Display key for the panel header badge: the block_loc when present, else the batch
    // code (FEED columns have no loc). parseLocKey in the panel tolerates the non-loc key.
    const panelLocKey = selectedColumn
        ? (selectedColumn.blockLoc ?? selectedColumn.batchCode)
        : null;

    const hasData = columns.length > 0 && rows.length > 0;

    return (
        <div className="flex flex-col h-full min-h-0">
            {/* Toolbar — campaign picker + summary */}
            <div className="flex items-center gap-3 pb-3 shrink-0">
                <Select value={campaign} onValueChange={handleCampaignChange}>
                    <SelectTrigger className="h-8 w-[180px] text-xs">
                        <SelectValue placeholder="Select campaign" />
                    </SelectTrigger>
                    <SelectContent className="bg-popover/95 backdrop-blur-lg">
                        {campaignOptions.map((opt) => (
                            <SelectItem key={opt.value} value={opt.value} className="text-xs">
                                <span className="flex items-center justify-between gap-3 w-full">
                                    <span>{opt.label}</span>
                                    <span className="text-muted-foreground tabular-nums">
                                        {opt.feedDays}d
                                    </span>
                                </span>
                            </SelectItem>
                        ))}
                    </SelectContent>
                </Select>

                {hasData && (
                    <div className="text-xs text-muted-foreground">
                        <span className="font-medium text-foreground">{columns.length}</span> blocks
                        {' · '}
                        <span className="font-medium text-foreground">{rows.length}</span> days
                    </div>
                )}
            </div>

            {hasData ? (
                <TooltipProvider delayDuration={200}>
                    {/* Scroll container — both axes scroll; sticky handles the freezing */}
                    <div className="flex-1 min-h-0 overflow-auto rounded-md border border-border">
                        {/* border-separate + border-spacing:0 is MANDATORY here, NOT
                            border-collapse. Under border-collapse the browser's collapsed
                            border model makes position:sticky cell BACKGROUNDS render
                            transparent, so scrolling content bleeds straight through the
                            frozen Date/Day/Batch/Total columns. border-separate keeps each
                            cell's own opaque bg painting reliably. Cell dividers are then
                            reconstructed per-cell (border-b / border-r on the markup) since
                            collapsed-border merging no longer applies. */}
                        <table
                            className="relative table-fixed text-xs"
                            style={{
                                // Size to content, NOT the container — with table-fixed,
                                // width:100% would stretch the columns to fill leftover space
                                // when there are only a few blocks. max-content keeps every
                                // column at its explicit colgroup width; empty space stays on
                                // the right and horizontal scroll appears only when needed.
                                width: 'max-content',
                                borderCollapse: 'separate',
                                borderSpacing: 0,
                            }}
                        >
                            <colgroup>
                                <col style={{ width: W_ROWNUM }} />
                                <col style={{ width: W_DATE }} />
                                <col style={{ width: W_DAY }} />
                                <col style={{ width: W_BATCH }} />
                                <col style={{ width: W_FEDPRICE }} />
                                <col style={{ width: W_TOTAL }} />
                                {/* PRODUCED group: TOTAL PRODUCED + one per present grade */}
                                <col style={{ width: W_PRODUCED }} />
                                {producedGrades.map((g) => (
                                    <col key={`col-grade-${g.grade}`} style={{ width: W_GRADE }} />
                                ))}
                                {/* BLOCK group */}
                                {columns.map((c) => (
                                    <col key={c.batchId} style={{ width: W_BLOCK }} />
                                ))}
                            </colgroup>

                            {/* ---- Frozen header row ---- */}
                            <thead>
                                <tr className="h-9">
                                    <FrozenHeaderCell left={LEFT_ROWNUM} width={W_ROWNUM} align="right">
                                        #
                                    </FrozenHeaderCell>
                                    <FrozenHeaderCell left={LEFT_DATE} width={W_DATE} align="left">
                                        Date
                                    </FrozenHeaderCell>
                                    <FrozenHeaderCell left={LEFT_DAY} width={W_DAY} align="left">
                                        Day
                                    </FrozenHeaderCell>
                                    <FrozenHeaderCell left={LEFT_BATCH} width={W_BATCH} align="left">
                                        Batch
                                    </FrozenHeaderCell>
                                    <FrozenHeaderCell left={LEFT_FEDPRICE} width={W_FEDPRICE} align="right">
                                        Fed ₱/kg
                                    </FrozenHeaderCell>
                                    <FrozenHeaderCell
                                        left={LEFT_TOTAL}
                                        width={W_TOTAL}
                                        align="right"
                                        className="frozen-edge"
                                    >
                                        Total fed
                                    </FrozenHeaderCell>

                                    {/* ── PRODUCED group (scrolling header cells, sticky-top
                                        only via frozen-row + OPAQUE bg-muted). Group caption
                                        on the TOTAL PRODUCED cell via GROUP_DIVIDER 2px left
                                        border so it reads as a distinct section. ── */}
                                    <th
                                        className={cn(
                                            'frozen-row bg-muted border-b border-r border-border/50 align-bottom text-right font-medium px-2 py-1',
                                            GROUP_DIVIDER,
                                        )}
                                    >
                                        <span className="flex flex-col gap-0 leading-tight">
                                            <span className="text-[9px] uppercase tracking-wide text-muted-foreground">
                                                produced
                                            </span>
                                            <span>Total</span>
                                        </span>
                                    </th>
                                    {producedGrades.map((g) => (
                                        <th
                                            key={`hd-grade-${g.grade}`}
                                            className="frozen-row bg-muted border-b border-r border-border/50 align-bottom text-right font-medium px-2 py-1"
                                        >
                                            <span className="font-mono text-[11px]">{g.grade}</span>
                                        </th>
                                    ))}

                                    {/* Dynamic block columns — scrolling header cells:
                                        sticky-top only (frozen-row), OPAQUE bg-muted so
                                        body rows can't bleed through on vertical scroll. */}
                                    {columns.map((c, ci) => {
                                        const isSelected = selectedColumn?.batchId === c.batchId;
                                        return (
                                        <th
                                            key={c.batchId}
                                            className={cn(
                                                // Stays OPAQUE bg-muted (frozen-row) so body rows can't bleed
                                                // through on vertical scroll. Hover/selected tints layer on top
                                                // of the opaque base — no /opacity on the sticky surface.
                                                // border-r adds the vertical column separator (matches the
                                                // horizontal border-border/50 gridline weight).
                                                'frozen-row bg-muted border-b border-r border-border/50 align-bottom text-left font-medium p-0',
                                                // First block column starts the BLOCK group — 2px divider.
                                                ci === 0 && GROUP_DIVIDER,
                                            )}
                                        >
                                            <Tooltip>
                                                <TooltipTrigger asChild>
                                                    <button
                                                        type="button"
                                                        onClick={() => handleHeaderClick(c)}
                                                        title={`Open details for ${c.batchCode}`}
                                                        className={cn(
                                                            'flex w-full flex-col gap-0.5 px-2 py-1 text-left cursor-pointer',
                                                            'transition-colors duration-150 hover:bg-accent focus-visible:bg-accent',
                                                            'focus:outline-none focus-visible:ring-1 focus-visible:ring-ring',
                                                            isSelected && 'bg-accent',
                                                        )}
                                                    >
                                                        <span className="truncate font-mono text-[11px] font-semibold leading-tight">
                                                            {c.batchCode}
                                                        </span>
                                                        <span className="truncate text-[10px] font-normal text-muted-foreground leading-tight">
                                                            {c.blockLoc ?? '—'}
                                                        </span>
                                                    </button>
                                                </TooltipTrigger>
                                                <TooltipContent side="bottom">
                                                    <div className="text-xs">
                                                        <div className="font-mono font-medium">{c.batchCode}</div>
                                                        <div className="text-muted-foreground">
                                                            Block: {c.blockLoc ?? '—'}
                                                        </div>
                                                        <div className="text-muted-foreground">
                                                            Opened: {c.firstFedDate}
                                                        </div>
                                                        <div className="mt-0.5 text-muted-foreground/80">
                                                            Click to view batch details
                                                        </div>
                                                    </div>
                                                </TooltipContent>
                                            </Tooltip>
                                        </th>
                                        );
                                    })}
                                </tr>
                            </thead>

                            {/* ---- Body ---- */}
                            <tbody>
                                {rows.map((row) => {
                                    const isZeroDay = row.totalFed === 0;
                                    return (
                                        <tr
                                            key={row.date}
                                            className={cn(
                                                'group h-8 transition-all duration-150 hover:bg-accent',
                                                isZeroDay && 'text-muted-foreground/60',
                                            )}
                                        >
                                            <FrozenBodyCell
                                                left={LEFT_ROWNUM}
                                                width={W_ROWNUM}
                                                className="text-right font-mono text-muted-foreground tabular-nums"
                                            >
                                                {row.rowNum}
                                            </FrozenBodyCell>
                                            <FrozenBodyCell
                                                left={LEFT_DATE}
                                                width={W_DATE}
                                                className="font-mono tabular-nums"
                                            >
                                                {row.date}
                                            </FrozenBodyCell>
                                            <FrozenBodyCell
                                                left={LEFT_DAY}
                                                width={W_DAY}
                                                className={cn(
                                                    'text-muted-foreground',
                                                    (row.dayOfWeek === 'Sat' || row.dayOfWeek === 'Sun') &&
                                                        'text-amber-600 dark:text-amber-400',
                                                )}
                                            >
                                                {row.dayOfWeek}
                                            </FrozenBodyCell>
                                            <FrozenBodyCell
                                                left={LEFT_BATCH}
                                                width={W_BATCH}
                                                className="font-mono"
                                            >
                                                {row.productionBatch ?? ''}
                                            </FrozenBodyCell>
                                            <FrozenBodyCell
                                                left={LEFT_FEDPRICE}
                                                width={W_FEDPRICE}
                                                className="font-mono tabular-nums"
                                            >
                                                {/* Accounting format: ₱ pinned left, value pinned right.
                                                    Blank on zero-fed days (avgFedPriceDay === null). */}
                                                {row.avgFedPriceDay !== null && (
                                                    <span className="flex items-baseline justify-between gap-1">
                                                        <span className="text-muted-foreground">₱</span>
                                                        <span>{fmtPrice(row.avgFedPriceDay)}</span>
                                                    </span>
                                                )}
                                            </FrozenBodyCell>
                                            <FrozenBodyCell
                                                left={LEFT_TOTAL}
                                                width={W_TOTAL}
                                                className="text-right font-mono font-medium tabular-nums frozen-edge"
                                            >
                                                {fmtKg(row.totalFed)}
                                            </FrozenBodyCell>

                                            {/* ── PRODUCED group (scrolling body cells) ──
                                                TOTAL PRODUCED (SQL daily_total) then one per
                                                grade; kg, mono right-aligned, blank on null/0.
                                                group-hover repaints the row hover tint to match
                                                the frozen + block cells. */}
                                            <td
                                                className={cn(
                                                    'px-2 py-1 text-right font-mono font-medium tabular-nums border-b border-r border-border/50 group-hover:bg-accent',
                                                    GROUP_DIVIDER,
                                                    (row.totalProduced ?? 0) === 0 && 'text-transparent',
                                                )}
                                            >
                                                {fmtKg(row.totalProduced ?? undefined)}
                                            </td>
                                            {producedGrades.map((g) => {
                                                const kg = row.producedByGrade[g.grade];
                                                const active = !!kg && kg !== 0;
                                                return (
                                                    <td
                                                        key={`bd-grade-${g.grade}`}
                                                        className={cn(
                                                            'px-2 py-1 text-right font-mono tabular-nums border-b border-r border-border/50 group-hover:bg-accent',
                                                            active ? 'text-foreground' : 'text-transparent',
                                                        )}
                                                    >
                                                        {fmtKg(kg)}
                                                    </td>
                                                );
                                            })}

                                            {/* Dynamic block cells */}
                                            {columns.map((c, ci) => {
                                                const kg = row.fedByBatch[c.batchId];
                                                const active = !!kg && kg !== 0;
                                                return (
                                                    <td
                                                        key={c.batchId}
                                                        className={cn(
                                                            'px-2 py-1 text-right font-mono tabular-nums border-b border-r border-border/50',
                                                            ci === 0 && GROUP_DIVIDER,
                                                            active
                                                                ? 'bg-emerald-500/10 text-foreground'
                                                                : 'text-transparent',
                                                        )}
                                                    >
                                                        {fmtKg(kg)}
                                                    </td>
                                                );
                                            })}
                                        </tr>
                                    );
                                })}
                            </tbody>

                            {/* ---- Frozen summary footer ----
                                Pinned to the BOTTOM of the scroll container (sticky
                                bottom:0), the mirror of the frozen header. Footer cells are
                                OPAQUE bg-muted (solid — never glass) so scrolling rows can't
                                bleed through. The 5 cells under the frozen LEFT columns are
                                BOTH sticky-left and sticky-bottom (.frozen-corner-bottom, z30),
                                the per-column cells are sticky-bottom only (.frozen-row-bottom,
                                z20). frozen-edge-top kills the top seam against the scrolling
                                body; the last frozen-left footer cell also carries .frozen-edge
                                for the vertical seam, matching the header. */}
                            <tfoot>
                                <tr>
                                    <FrozenFooterCell left={LEFT_ROWNUM} width={W_ROWNUM} />
                                    <FrozenFooterCell
                                        left={LEFT_DATE}
                                        width={W_DATE}
                                        className="text-left text-[10px] font-medium uppercase tracking-wide text-muted-foreground"
                                    >
                                        Totals
                                    </FrozenFooterCell>
                                    <FrozenFooterCell left={LEFT_DAY} width={W_DAY} />
                                    <FrozenFooterCell left={LEFT_BATCH} width={W_BATCH} />
                                    {/* Campaign's weighted-avg fed price — THE headline calc value.
                                        Accounting format (₱ left / value right), bold. Tiny "camp. avg"
                                        label so it reads as the campaign figure. Blank when zero-fed. */}
                                    <FrozenFooterCell left={LEFT_FEDPRICE} width={W_FEDPRICE}>
                                        <div className="flex flex-col gap-0 leading-tight">
                                            <span className="text-[9px] uppercase tracking-wide text-muted-foreground">
                                                camp. avg
                                            </span>
                                            {campaignAvgFedPrice !== null && (
                                                <span className="flex items-baseline justify-between gap-1 font-mono text-xs font-bold tabular-nums">
                                                    <span className="text-muted-foreground">₱</span>
                                                    <span>{fmtPrice(campaignAvgFedPrice)}</span>
                                                </span>
                                            )}
                                        </div>
                                    </FrozenFooterCell>
                                    <FrozenFooterCell
                                        left={LEFT_TOTAL}
                                        width={W_TOTAL}
                                        className="text-right font-mono font-semibold tabular-nums frozen-edge"
                                    >
                                        {fmtKg(grandTotalFed)}
                                    </FrozenFooterCell>

                                    {/* ── PRODUCED group footer (scrolling, sticky-bottom only).
                                        These cells SCROLL with the block columns, so they use
                                        .frozen-row-bottom (z20) + .frozen-edge-top — NOT the
                                        corner. Neutral OPAQUE bg-muted (not a batch state, so
                                        no statusTint). The TOTAL PRODUCED cell is the yield/loss
                                        payoff: campaign produced headline + yield% + loss%. ── */}
                                    {/* p-0 here (NOT the helper's px-2 py-0.5) so the tricolor
                                        bands bleed EDGE TO EDGE. h-full makes the inner stack span
                                        the full cell height; each band is flex-1 (equal thirds). */}
                                    <td
                                        className={cn(
                                            'frozen-row-bottom frozen-edge-top bg-muted border-r border-border/50 p-0 align-middle',
                                            GROUP_DIVIDER,
                                        )}
                                    >
                                        {/* LABEL-LESS TRICOLOR bands — color encodes the metric
                                            (no text labels). Three OPAQUE bands stack vertically and
                                            FILL the cell completely (full-bleed, equal thirds, no
                                            rounded corners, no gaps, no per-band padding); only a
                                            tiny pr-1 keeps the digits off the right border. `title`
                                            keeps the meaning discoverable on hover. OPAQUE tint pairs
                                            mirror statusTint() (frozen-pane rule — no glass).
                                              amber  = Produced (kg)
                                              emerald= Yield (%)
                                              red    = Loss (%)
                                            null/zero handling preserved (— when null). */}
                                        <div className="flex h-full flex-col leading-tight">
                                            <div
                                                title="Produced"
                                                className="flex flex-1 w-full items-center justify-end bg-amber-100 pr-1 font-mono text-[11px] font-bold tabular-nums text-amber-950 dark:bg-amber-950 dark:text-amber-50"
                                            >
                                                {fmtKg(campaignTotalProduced ?? undefined) || '—'}
                                            </div>
                                            <div
                                                title="Yield"
                                                className="flex flex-1 w-full items-center justify-end bg-emerald-100 pr-1 font-mono text-[11px] font-bold tabular-nums text-emerald-950 dark:bg-emerald-950 dark:text-emerald-50"
                                            >
                                                {fmtYieldPct(campaignYieldPct)}
                                            </div>
                                            <div
                                                title="Loss"
                                                className="flex flex-1 w-full items-center justify-end bg-red-100 pr-1 font-mono text-[11px] font-bold tabular-nums text-red-950 dark:bg-red-950 dark:text-red-50"
                                            >
                                                {fmtYieldPct(campaignYieldPct === null ? null : 1 - campaignYieldPct)}
                                            </div>
                                        </div>
                                    </td>
                                    {producedGrades.map((g) => (
                                        <td
                                            key={`ft-grade-${g.grade}`}
                                            className="frozen-row-bottom frozen-edge-top bg-muted border-r border-border/50 px-2 py-0.5 align-middle text-right"
                                        >
                                            <span className="font-mono text-xs font-bold tabular-nums">
                                                {fmtKg(g.campaignTotal ?? undefined)}
                                            </span>
                                        </td>
                                    ))}

                                    {/* Per-column 2-line summary — scrolling footer cells
                                        (sticky-bottom only). STATE is shown by coloring the
                                        WHOLE cell via statusTint() (the dot/badge was removed):
                                        IN-USE = blue, CLOSED/FEED = red, else neutral. The tint
                                        is OPAQUE and REPLACES bg-muted (no /opacity, no glass —
                                        this is a frozen surface; alpha would bleed through).
                                          Line 1: total fed kg (bold mono, right-aligned).
                                          Line 2: tiny "loss" label + signed % (em-dash if null).
                                        MC & Ash moved OUT of the cell into a hover tooltip to
                                        de-clutter the cramped grid. On the red (CLOSED) tint the
                                        loss red/green could clash, so loss inherits the cell
                                        foreground there; on the blue and neutral tints it keeps
                                        the red(neg)/emerald(pos) sign coloring. */}
                                    {columns.map((c, ci) => {
                                        const isClosedTint = c.status === 'CLOSED' || c.status === 'FEED';
                                        const lossClass = c.blockLoss === null
                                            ? 'text-muted-foreground'
                                            : isClosedTint
                                              ? '' // inherit the red-cell foreground (legible)
                                              : c.blockLoss < 0
                                                ? 'text-red-600 dark:text-red-400'
                                                : 'text-emerald-600 dark:text-emerald-400';
                                        return (
                                        <td
                                            key={c.batchId}
                                            className={cn(
                                                'frozen-row-bottom frozen-edge-top border-r border-border/50 p-0 align-middle',
                                                ci === 0 && GROUP_DIVIDER,
                                                statusTint(c.status),
                                            )}
                                        >
                                            <Tooltip>
                                                <TooltipTrigger asChild>
                                                    <div className="flex cursor-default flex-col gap-0 px-2 py-0.5 leading-tight">
                                                        {/* Line 1 — headline: "fed" label + total fed kg */}
                                                        <div className="flex items-baseline justify-between gap-1 tabular-nums">
                                                            <span className="text-[10px] uppercase tracking-wide opacity-70">fed</span>
                                                            <span className="font-mono text-xs font-semibold">
                                                                {fmtKg(c.totalOut) || '0'}
                                                            </span>
                                                        </div>
                                                        {/* Line 2 — "loss" label + signed % */}
                                                        <div className="flex items-baseline justify-between gap-1 tabular-nums">
                                                            <span className="text-[10px] uppercase tracking-wide opacity-70">loss</span>
                                                            <span className={cn('font-mono text-[10px]', lossClass)}>
                                                                {fmtSignedPct(c.blockLoss)}
                                                            </span>
                                                        </div>
                                                        {/* Line 3 — weighted-avg fed price (₱/kg). Accounting
                                                            format (₱ left / value right). Blank when null. The
                                                            label slot is kept even when blank so all per-column
                                                            footers stay the SAME height. */}
                                                        <div className="flex items-baseline justify-between gap-1 tabular-nums">
                                                            <span className="text-[10px] uppercase tracking-wide opacity-70">₱/kg</span>
                                                            {c.avgFedPrice !== null && (
                                                                <span className="font-mono text-[10px]">
                                                                    {fmtPrice(c.avgFedPrice)}
                                                                </span>
                                                            )}
                                                        </div>
                                                    </div>
                                                </TooltipTrigger>
                                                <TooltipContent
                                                    side="top"
                                                    className="w-[180px] bg-popover/95 p-0 backdrop-blur-lg"
                                                >
                                                    {/* Info card — glass surface (floats over empty space, so
                                                        glass is correct here, unlike the opaque frozen cells). */}
                                                    <div className="text-[11px]">
                                                        {/* Header: batch code + block_loc + state pill */}
                                                        <div className="flex items-start justify-between gap-2 px-2.5 py-2">
                                                            <div className="min-w-0">
                                                                <div className="truncate font-mono text-xs font-semibold leading-tight">
                                                                    {c.batchCode}
                                                                </div>
                                                                <div className="truncate text-[10px] text-muted-foreground leading-tight">
                                                                    {c.blockLoc ?? '—'}
                                                                </div>
                                                            </div>
                                                            <span
                                                                className={cn(
                                                                    'mt-0.5 inline-flex shrink-0 items-center gap-1 rounded-full px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wide',
                                                                    isClosedTint
                                                                        ? 'bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300'
                                                                        : c.status === 'IN-USE'
                                                                          ? 'bg-blue-100 text-blue-700 dark:bg-blue-950 dark:text-blue-300'
                                                                          : 'bg-muted text-muted-foreground',
                                                                )}
                                                            >
                                                                <span
                                                                    className={cn(
                                                                        'h-1.5 w-1.5 rounded-full',
                                                                        isClosedTint
                                                                            ? 'bg-red-500'
                                                                            : c.status === 'IN-USE'
                                                                              ? 'bg-blue-500'
                                                                              : 'bg-muted-foreground/50',
                                                                    )}
                                                                />
                                                                {c.status}
                                                            </span>
                                                        </div>

                                                        {/* Divider */}
                                                        <div className="border-t border-border" />

                                                        {/* Label / value list */}
                                                        <dl className="space-y-1 px-2.5 py-2">
                                                            <div className="flex items-baseline justify-between gap-3">
                                                                <dt className="text-muted-foreground">Fed</dt>
                                                                <dd className="font-mono tabular-nums">
                                                                    {fmtKg(c.totalOut) || '0'} kg
                                                                </dd>
                                                            </div>
                                                            <div className="flex items-baseline justify-between gap-3">
                                                                <dt className="text-muted-foreground">In</dt>
                                                                <dd className="font-mono tabular-nums">
                                                                    {fmtKg(c.totalIn) || '0'} kg
                                                                </dd>
                                                            </div>
                                                            <div className="flex items-baseline justify-between gap-3">
                                                                <dt className="text-muted-foreground">MC</dt>
                                                                <dd className="font-mono tabular-nums">{fmtPct2(c.mc)}</dd>
                                                            </div>
                                                            <div className="flex items-baseline justify-between gap-3">
                                                                <dt className="text-muted-foreground">Ash</dt>
                                                                <dd className="font-mono tabular-nums">{fmtPct2(c.ash)}</dd>
                                                            </div>
                                                            <div className="flex items-baseline justify-between gap-3">
                                                                <dt className="text-muted-foreground">Fed price</dt>
                                                                <dd className="font-mono tabular-nums">
                                                                    {c.avgFedPrice !== null ? `₱${fmtPrice(c.avgFedPrice)}/kg` : '—'}
                                                                </dd>
                                                            </div>
                                                            <div className="flex items-baseline justify-between gap-3">
                                                                <dt className="text-muted-foreground">Loss</dt>
                                                                <dd
                                                                    className={cn(
                                                                        'font-mono tabular-nums',
                                                                        c.blockLoss === null
                                                                            ? 'text-muted-foreground'
                                                                            : c.blockLoss < 0
                                                                              ? 'text-red-600 dark:text-red-400'
                                                                              : 'text-emerald-600 dark:text-emerald-400',
                                                                    )}
                                                                >
                                                                    {fmtSignedPct(c.blockLoss)}
                                                                </dd>
                                                            </div>
                                                            <div className="flex items-baseline justify-between gap-3">
                                                                <dt className="text-muted-foreground">Opened</dt>
                                                                <dd className="font-mono tabular-nums">{c.firstFedDate}</dd>
                                                            </div>
                                                        </dl>
                                                    </div>
                                                </TooltipContent>
                                            </Tooltip>
                                        </td>
                                        );
                                    })}
                                </tr>
                            </tfoot>
                        </table>
                    </div>
                </TooltipProvider>
            ) : (
                <div className="flex-1 min-h-0 flex items-center justify-center animate-fade-up">
                    <div className="text-center text-sm text-muted-foreground">
                        No feeding movement for this campaign.
                    </div>
                </div>
            )}

            {/* ── Batch detail slide-over (shared with the Blocking tab) ──
                Reuses BlockingDetailPanel. We pass an explicit, batch-accurate blockData
                (from fetchBlockDataForBatch) so the panel shows THIS column's batch — not
                whatever currently occupies its block_loc. The panel owns its own
                close/Escape/scroll-lock behavior; it's `fixed`, so placement here doesn't
                affect the matrix layout. */}
            <BlockingDetailPanel
                locKey={panelLocKey}
                blockData={panelBlockData}
                onClose={handlePanelClose}
                canViewPrices={panelCanViewPrices}
            />
        </div>
    );
}

// ---------------------------------------------------------------------------
// Frozen cell helpers — keep the sticky offset + z-index wiring in one place.
// ---------------------------------------------------------------------------

function FrozenHeaderCell({
    left,
    width,
    align,
    className,
    children,
}: {
    left: number;
    width: number;
    align: 'left' | 'right';
    className?: string;
    children: React.ReactNode;
}) {
    // Frozen identity HEADER cell = top-left corner: sticky on BOTH axes, so it must
    // out-rank the scrolling header row AND the frozen body column. OPAQUE bg-muted
    // (never glass) so scrolling cells can't bleed through in either direction.
    // The LAST frozen-left column (Total fed) passes `.frozen-edge` as its right
    // divider — don't also add border-r there or the two would fight; every OTHER
    // frozen-left column gets border-r for the vertical column separator.
    const hasEdge = className?.includes('frozen-edge');
    return (
        <th
            className={cn(
                'frozen-corner bg-muted border-b border-border px-2 py-1 font-medium align-bottom',
                !hasEdge && 'border-r border-border/50',
                align === 'right' ? 'text-right' : 'text-left',
                className,
            )}
            style={{ left, width }}
        >
            {children}
        </th>
    );
}

function FrozenBodyCell({
    left,
    width,
    className,
    children,
}: {
    left: number;
    width: number;
    className?: string;
    children: React.ReactNode;
}) {
    // Frozen LEFT-column body cell (.frozen-col, z-10). OPAQUE bg-background so the
    // scrolling block cells can't bleed through; group-hover repaints the row hover
    // tint OPAQUELY onto the pinned columns so they match the scrolling part.
    // The LAST frozen-left column (Total fed) passes `.frozen-edge` as its right
    // divider — skip border-r there to avoid a competing line; every OTHER frozen-left
    // column gets border-r for the vertical column separator.
    const hasEdge = className?.includes('frozen-edge');
    return (
        <td
            className={cn(
                'frozen-col bg-background group-hover:bg-accent border-b border-border/50 px-2 py-1',
                !hasEdge && 'border-r border-border/50',
                className,
            )}
            style={{ left, width }}
        >
            {children}
        </td>
    );
}

function FrozenFooterCell({
    left,
    width,
    className,
    children,
}: {
    left: number;
    width: number;
    className?: string;
    children?: React.ReactNode;
}) {
    // Bottom-left CORNER cell — sticky on BOTH axes (frozen left column + footer
    // row), so it must out-rank the scrolling footer cells AND the frozen body
    // column (.frozen-corner-bottom, z30). OPAQUE bg-muted (matches the footer
    // band, never glass) so scrolling cells can't bleed through in either
    // direction. frozen-edge-top kills the top seam against the scrolling body.
    // The LAST frozen-left column (Total fed) passes `.frozen-edge` as its right
    // divider — skip border-r there; every OTHER frozen-left footer cell gets
    // border-r for the vertical column separator.
    const hasEdge = className?.includes('frozen-edge');
    return (
        <td
            className={cn(
                'frozen-corner-bottom frozen-edge-top bg-muted px-2 py-0.5 align-middle',
                !hasEdge && 'border-r border-border/50',
                className,
            )}
            style={{ left, width }}
        >
            {children}
        </td>
    );
}
