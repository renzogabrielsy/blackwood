'use client';

import * as React from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { Loader2 } from 'lucide-react';

import { BlackwoodTable } from '@/components/shared/table';
import type {
    BlackwoodTableApi,
    TableSummaryCell,
    TableSummaryRow,
} from '@/components/shared/table';
import type { ColumnSpec, GridRow, RowKind, TableSettings } from '@/lib/table';
import { useTableColumns } from '@/lib/hooks/use-table-columns';
import { useTableEdits } from '@/lib/hooks/use-table-edits';
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from '@/components/ui/select';
import { cn } from '@/lib/utils';
import { BlockingDetailPanel, type BlockingDetailNavTarget } from '../_shared/blocking-detail-panel';
import { fetchBlockDataForBatch } from '../blocking/actions';
import type { BlockData } from '../blocking/types';
import type {
    RcMovementMatrix,
    RcMovementMatrixColumn,
    RcMovementMatrixRow,
} from './actions';

// ═════════════════════════════════════════════════════════════════════════════════
// RC Movement on the Blackwood Table — `?grid=v2`, READ-ONLY, built BESIDE the live
// matrix.
//
// `rc-movement-matrix.tsx` is production and is not edited by one character, and neither
// is `rc-movement-route-view.tsx` (the live branch's client host) — the v2 branch is
// server-fetched in `page.tsx` instead, so the two hosts never share a line. This file
// renders the SAME `RcMovementMatrix` payload the live matrix consumes, on the universal
// grid, so the two can be compared cell-for-cell on the same real campaign
// (`handoffs/2026-08-17-universal-table-phase-1-and-the-side-by-side-method.md`).
//
// ── THE GRID IS READ-ONLY, AND STRUCTURALLY SO ──────────────────────────────────
// This screen has no write path in production either — it is a pivot over SQL views.
// Every column here is `cellKind: 'readonly'` (or `'derived'`), no column carries a
// `parse`, and no `renderEditor` is passed, so `columnAcceptsEdit` is false at every
// coordinate and an editor can never open.
//
// That claim is about the GRID's cells and it is unchanged by the block detail panel
// mounted at the bottom of this file (2026-08-20). The panel is a separate surface, it
// is existing production code already mounted on two live screens, its own write paths
// gate themselves, and a header click is not a cell edit — the full reasoning is
// recorded at the mount site, where someone reading `<BlockingDetailPanel>` here will
// actually be standing. `fetchBlockDataForBatch` is a READ action, called on click; the
// campaign payload's own read action is called from the SERVER page, not from here.
//
// ── PRICE GATING IS A SECURITY BOUNDARY, AND IT IS NOT DECIDED HERE ─────────────
// `canViewPrices` arrives inside `data`, resolved server-side by the canonical
// `lib/auth.canViewPrices()` inside `fetchRcMovementMatrix` — which is also where every ₱
// field is nulled and where the three ACTUAL FED ₱/kg views are not even QUERIED for a
// gated viewer. This file never calls `hasPermission`, never re-derives the role and
// never sees a ₱ value such a viewer was not sent.
//
// It mirrors exactly what the live matrix does with that flag: the `Fed ₱/kg` column
// does not EXIST for a gated viewer (`ColumnSpec.visible`), so it is absent from the
// coordinate space rather than blanked — the keyboard has no hole, a copy cannot address
// it, and (because the module recomputes the pinned offsets from the RESOLVED columns)
// `Total fed` slides left to sit directly after `Day` with no runtime `LEFT_TOTAL` maths
// of the kind the live file has to do by hand. The footer's ₱ lines and the coverage
// badge are gated on the same flag.
//
// ── "NEVER CRUSH, ALWAYS SCROLL" ────────────────────────────────────────────────
// The live matrix uses `width: 'max-content'` so `table-fixed` cannot stretch its columns
// when a campaign has only a few blocks. `BlackwoodTable` renders `width: 100%` +
// `minWidth: Σ widths` and gives every column an explicit `<col width>`, and a fixed
// table wider than its columns scales ALL of them proportionally — measured in Chrome at
// a 1600px container, a declared 76px column renders 94.7px. The sticky `left` offsets
// come from the DECLARED widths, so a stretched table would pin the frozen block inside
// itself. Clamping this grid's own width to Σ widths (`minTableWidth`) makes the stretch
// unreachable, which is the same guarantee `max-content` gives the live matrix.
// ═════════════════════════════════════════════════════════════════════════════════

// ─── Geometry — MEASURED, never eyeballed (2026-08-29) ───────────────────────────
//
// Renzo, on the v2 grid: *"a bunch of the column headers are wrapping weirdly or are being
// '…' truncated. This does not happen in our original table. Column widths must accommodate
// the header so we can see everything."*
//
// **The reason the v2 headers clipped where the live matrix's do not, and it is not the
// font.** The live matrix's `<th>` spends `px-2` + a 1px border and gives everything left
// to the label. This grid runs `scope="focus"`, which turns the platform's built-in SORT
// and FILTER controls on for every column that is not `cellKind: 'derived'` and has not
// opted out — and `HeaderCell` lays them out as flex SIBLINGS of the label, `opacity-0`
// until the header is hovered. INVISIBLE, and still occupying layout: two 16px buttons
// plus two 4px gaps. So the budget is
//
//     usable label width = declared − 16 (px-2) − 40 (two controls) − 1 (border-r) = −57
//     usable label width = declared − 16 − 1 = −17          (no controls on the column)
//
// and every width carried over from the live matrix was 40px short of the one it needed.
// This is the same trap the QC ledger hit on 2026-08-26 (`scripts/verify-qc-grid.ts` §12);
// the widths below are the same remedy, measured the same way.
//
// **AND ONE MORE FLEX CHILD THIS SHEET PAYS FOR AND THE QC LEDGER DOES NOT.** The two
// columns that start a section (`PRODUCED` and the FIRST block column) hang their 2px group
// rule off `renderHeaderSlot`, which `HeaderCell` renders as a fourth flex child. The
// SLIVER is `absolute` and 0px wide — but the `gap-1` before it is not, so those columns
// pay a further **4px**. Measured, not reasoned: the first version of this table budgeted
// 57/17 and both of them still clipped by exactly 2 and 4 pixels.
//
// The numbers are MEASURED in a browser against the real computed fonts — the lane header
// at Geist 11px/500 `uppercase tracking-wide`, a block header at Geist Mono 11px/600, a
// body figure at Geist Mono 12px with `tabular-nums`. Node has no font engine, so they
// cannot be re-derived in a test — only ENFORCED, which `scripts/verify-rc-movement-grid.ts`
// now does against this table.
//
//   key       label                  px   chrome   floor   declared
//   rownum    #                    7.42       17   24.42       48
//   date      DATE                29.52       57   86.52      100
//   day       DAY                 22.92       57   79.92       84
//   fedprice  FED ₱/KG            52.63       57  109.63      112
//   total     TOTAL FED           62.32       57  119.32      124
//   produced  PRODUCED            64.67    57+4  125.67      128
//   grade     3X50 / 6X50 / 8X50  30.25       57   87.25       92
//   block     MARCH-26-SUNDRY7   115.53    17+4  136.53      148
//
// Every declared width clears its floor with a few px of slack, deliberately: a column
// sized to the exact measurement is one font-hinting change away from an ellipsis.

const W_ROWNUM = 48;
const W_DATE = 100;
/** 84, not 52: `DAY` is 22.92px of label against 57px of invisible chrome. */
const W_DAY = 84;
/** 112, not 96: `FED ₱/KG` needs 109.63 and read `FED ₱…` at 96. */
const W_FEDPRICE = 112;
/**
 * 120, not 88 — and `headerWrap` is GONE with it.
 *
 * `TOTAL FED` wrapped to two lines at 88px, which is what Renzo saw. Wrapping was the
 * wrong answer to a width problem twice over: the header row grows to its tallest cell, so
 * one wrapped header raises every other one, and a name broken across two lines is not
 * more readable than the same name on one line that fits.
 */
const W_TOTAL = 124;
/**
 * 128, not 88. `PRODUCED` is the widest lane name on the sheet at 64.67px, and this is one
 * of the two columns that also pays 4px for the group-rule slot — 64.67 + 61 = 125.67.
 */
const W_PRODUCED = 128;
/** 92, not 80. Also drops `headerWrap` — `3X50` fits on one line at this width. */
const W_GRADE = 92;
/**
 * 148, not 92.
 *
 * A block header is the batch code (`label`, re-styled to the live matrix's mono
 * identifier by `labelNode`) over the block location (`subLabel`), and the code is the
 * longest string on the sheet. These columns opt out of sort and filter (see the spec
 * below), so they pay 17px of chrome — 21 on the FIRST one, which carries the group rule.
 *
 * **The floor is the longest code that EXISTS: 16 characters.** `MARCH-26-SUNDRY7` /
 * `APRIL-26-SUNDRY2`, measured over all 531 batch codes `rc_out` has ever fed, render
 * 115.53px — so the floor is 136.53 and that is what the verify script enforces.
 *
 * **The declared 148 buys the naming convention's own headroom** rather than only today's
 * data: `SEPTEMBER-26-BLK12` — the longest month + the ordinary `BLK` kind, 18 characters
 * — is 123.74px and clears 148 with the group-rule slot included. A hypothetical
 * `SEPTEMBER-26-SUNDRY12` would still truncate, and its full code is on the `title`; the
 * line is drawn where a wider column would cost every campaign real scroll width for a
 * code nobody has ever typed.
 *
 * **The live matrix truncates a 16-character code and this does not**, which is the one
 * place the two headers deliberately differ: the whole complaint was `…` in a header, and
 * a batch code is an IDENTIFIER — half of one names nothing. The cost is 56px per block
 * column of extra scroll width, which "never crush, always scroll" is exactly the rule for.
 */
const W_BLOCK = 148;

const ROW_H = 32; // h-8, Excel Standard
/**
 * The totals rule-off's MINIMUM height — a `<tr>` height is a floor, and content taller
 * than it wins. Measured: 76px for a viewer who can see prices (a block cell stacks four
 * lines), which is why this is stated as a floor rather than pinned to 76: the same footer
 * is two lines shorter for Production, where the ₱/kg and ACTUAL lines do not render at
 * all, and a hard 76 would leave that render with 20px of empty band.
 */
const TOTALS_H = 62;

/** The 2px section rule the live matrix draws at the start of each scrolling group. */
const GROUP_DIVIDER = 'border-l-2 border-l-border';

const KEY_ROWNUM = 'rownum';
const KEY_DATE = 'date';
const KEY_DAY = 'day';
const KEY_FEDPRICE = 'fedprice';
const KEY_TOTAL = 'total';
const KEY_PRODUCED = 'produced';
const gradeKey = (grade: string) => `grade:${grade}`;
const blockKey = (batchId: string) => `blk:${batchId}`;

// ─── Formatting — reused verbatim from the live matrix ───────────────────────────

/** Integer kg with separators; blank for 0/absent (Excel blanks-are-zero). */
function fmtKg(n: number | null | undefined): string {
    if (!n || n === 0) return '';
    return Math.round(n).toLocaleString('en-US');
}

/** 2-decimal percent for a lab metric; em-dash when absent/zero. */
function fmtPct2(n: number | undefined): string {
    if (n === undefined || n === null || n === 0) return '—';
    return `${n.toFixed(2)}%`;
}

/** Accounting-format figure (2 dp). NULL renders BLANK — never ₱0.00, never a dash. */
function fmtPrice(n: number | null | undefined): string {
    if (n === null || n === undefined) return '';
    return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** A FRACTION → 1-dp percent. Em-dash when null (`total_fed = 0`). */
function fmtYieldPct(fraction: number | null): string {
    if (fraction === null || fraction === undefined) return '—';
    return `${(fraction * 100).toFixed(1)}%`;
}

/** A FRACTION → 2-dp percent. Em-dash when null. */
function fmtFractionPct2(fraction: number | null | undefined): string {
    if (fraction === null || fraction === undefined) return '—';
    return `${(fraction * 100).toFixed(2)}%`;
}

/** Signed 2-dp percent for block loss; em-dash when the ratio is null (`in = 0`). */
function fmtSignedPct(ratio: number | null): string {
    if (ratio === null || ratio === undefined) return '—';
    const pct = ratio * 100;
    return `${pct > 0 ? '+' : ''}${pct.toFixed(2)}%`;
}

/**
 * Batch status → the WHOLE-CELL tint of a per-block totals cell. The live matrix's
 * `statusTint`, copied including its rule: these tints MUST be OPAQUE solid tokens,
 * because the cell they paint can sit under a pinned column and any alpha bleeds.
 * IN-USE → blue · CLOSED/FEED → red · everything else → neutral.
 */
function statusTint(status: string): string {
    switch (status) {
        case 'IN-USE':
            return 'bg-blue-100 dark:bg-blue-950 text-blue-950 dark:text-blue-50';
        case 'CLOSED':
        case 'FEED':
            return 'bg-red-100 dark:bg-red-950 text-red-950 dark:text-red-50';
        default:
            return 'bg-muted text-foreground';
    }
}

/** An accounting cell: ₱ pinned left, figure pinned right (Excel Standard). */
function pesoCell(value: number) {
    return (
        <span className="flex w-full items-baseline justify-between gap-1 font-mono tabular-nums">
            <span className="text-muted-foreground">&#8369;</span>
            <span>{fmtPrice(value)}</span>
        </span>
    );
}

// ─── Ctx — referentially stable, or the whole sheet re-renders ───────────────────

export interface RcMovementGridCtx {
    /** Server-resolved, inside `data`. Never re-derived on the client. */
    canViewPrices: boolean;
}

type MovementItem = GridRow<RcMovementMatrixRow>;

// ─── Columns ─────────────────────────────────────────────────────────────────────

function buildColumns(
    columns: readonly RcMovementMatrixColumn[],
    grades: readonly { grade: string; campaignTotal: number | null }[],
    /** Opens the shared block detail panel. Must be referentially stable. */
    onBlockHeaderClick: (column: RcMovementMatrixColumn) => void,
): ColumnSpec<RcMovementMatrixRow, RcMovementGridCtx>[] {
    const firstBlockKey = columns.length > 0 ? blockKey(columns[0].batchId) : null;

    /**
     * The 2px group rule, painted from INSIDE the cell. The module owns the `<td>`'s
     * className (`cell-classes.ts` builds it from ten enums), so a consumer cannot add a
     * border to it — but the cell's inner layer is a positioned box, so an `inset-0` span
     * paints the line at the cell's own left edge on every row of the column. The header
     * gets the same line through `renderHeaderSlot`, and the totals row draws it directly.
     */
    const withRule = (rule: boolean, body: React.ReactNode, extra?: string) => (
        <span
            className={cn(
                'absolute inset-0 flex items-center justify-end px-2',
                rule && GROUP_DIVIDER,
                extra,
            )}
        >
            {body}
        </span>
    );

    const out: ColumnSpec<RcMovementMatrixRow, RcMovementGridCtx>[] = [
        {
            key: KEY_ROWNUM,
            label: '#',
            title: 'Row number within the campaign',
            width: W_ROWNUM,
            pin: 'start',
            align: 'right',
            // `derived` is the honest kind for a row ordinal: not editable, and not
            // selectable either (`columnSelectable` reads exactly this). The row family
            // below also marks the slot `addressable: false`, so the cell RENDERS its
            // number while every Tab run and every jump key steps straight over it —
            // which is the whole reason `CellSlot.addressable` exists.
            cellKind: 'derived',
            clipboardValue: (row) => String(row.rowNum),
            format: (row) => (
                <span className="font-mono tabular-nums text-muted-foreground">{row.rowNum}</span>
            ),
        },
        {
            key: KEY_DATE,
            label: 'DATE',
            title: 'Calendar day (yyyy-MM-dd)',
            width: W_DATE,
            pin: 'start',
            cellKind: 'readonly',
            selectable: true,
            clipboardValue: (row) => row.date,
            // Rendered VERBATIM — the payload is already `yyyy-MM-dd`, which is also the
            // format CLAUDE.md asks for. No `new Date(...)` anywhere near it.
            format: (row) => <span className="font-mono tabular-nums">{row.date}</span>,
        },
        {
            key: KEY_DAY,
            label: 'DAY',
            title: 'Day of week',
            width: W_DAY,
            pin: 'start',
            cellKind: 'readonly',
            selectable: true,
            clipboardValue: (row) => row.dayOfWeek,
            format: (row) => (
                <span
                    className={cn(
                        'text-muted-foreground',
                        (row.dayOfWeek === 'Sat' || row.dayOfWeek === 'Sun') &&
                            'text-amber-600 dark:text-amber-400',
                    )}
                >
                    {row.dayOfWeek}
                </span>
            ),
        },
        {
            key: KEY_FEDPRICE,
            label: 'FED ₱/KG',
            title: "The day's weighted-average fed price per kilogram",
            width: W_FEDPRICE,
            pin: 'start',
            align: 'right',
            cellKind: 'readonly',
            selectable: true,
            calcType: 'AVERAGE',
            // The SERVER decided; this only obeys. A hidden column is ABSENT from the
            // coordinate space, never blanked — and the module recomputes every pinned
            // offset from the resolved set, so `Total fed` moves left on its own.
            visible: (ctx) => ctx.canViewPrices,
            numericValue: (row) => row.avgFedPriceDay,
            clipboardValue: (row) =>
                row.avgFedPriceDay === null ? '' : String(row.avgFedPriceDay),
            // Blank on a zero-fed day (`avgFedPriceDay === null`).
            format: (row) => (row.avgFedPriceDay === null ? null : pesoCell(row.avgFedPriceDay)),
        },
        {
            key: KEY_TOTAL,
            label: 'TOTAL FED',
            // NO `headerWrap`. It was true at 88px, where the name did not fit on one
            // line — but the column is 120px now (62.32 of label + 57 of chrome), so the
            // name fits, and wrapping it would raise the whole header row for nothing.
            title: 'Total kg fed across every block that day',
            width: W_TOTAL,
            pin: 'start',
            align: 'right',
            cellKind: 'readonly',
            selectable: true,
            calcType: 'SUM',
            numericValue: (row) => row.totalFed,
            clipboardValue: (row) => (row.totalFed === 0 ? '' : String(row.totalFed)),
            format: (row) => (
                <span className="font-mono font-medium tabular-nums">{fmtKg(row.totalFed)}</span>
            ),
        },
        {
            key: KEY_PRODUCED,
            label: 'PRODUCED',
            title: 'Total kg produced that day, all grades (SQL-summed)',
            width: W_PRODUCED,
            align: 'right',
            cellKind: 'readonly',
            selectable: true,
            calcType: 'SUM',
            numericValue: (row) => row.totalProduced,
            clipboardValue: (row) =>
                row.totalProduced === null || row.totalProduced === 0
                    ? ''
                    : String(row.totalProduced),
            // The first cell of the PRODUCED group carries the 2px section rule.
            format: (row) =>
                withRule(
                    true,
                    <span className="font-mono font-medium tabular-nums">
                        {fmtKg(row.totalProduced)}
                    </span>,
                ),
        },
    ];

    for (const g of grades) {
        const grade = g.grade;
        out.push({
            key: gradeKey(grade),
            label: grade,
            // NO `headerWrap`. Every grade the plant has ever run is four characters or
            // fewer (`3X50` · `6X50` · `4X8` · `2X6`, measured over `production_runs`), and
            // the widest of them is 30.25px against 92 − 57 = 35 usable. A longer name
            // TRUNCATES rather than wrapping, deliberately: the header row grows to its
            // tallest cell, so one long grade would raise all sixteen headers on the sheet
            // — and the full name is on the `title` either way.
            title: `Kg produced of grade ${grade}`,
            width: W_GRADE,
            align: 'right',
            cellKind: 'readonly',
            selectable: true,
            calcType: 'SUM',
            numericValue: (row) => row.producedByGrade[grade] ?? null,
            clipboardValue: (row) => {
                const kg = row.producedByGrade[grade];
                return kg ? String(kg) : '';
            },
            format: (row) => {
                const kg = row.producedByGrade[grade];
                return (
                    <span className="font-mono tabular-nums">{fmtKg(kg)}</span>
                );
            },
        });
    }

    for (const c of columns) {
        const key = blockKey(c.batchId);
        const batchId = c.batchId;
        out.push({
            key,
            label: c.batchCode,
            /**
             * The header is the live matrix's, line for line: the BATCH CODE on top and
             * the BLOCK LOCATION under it, both one truncated line, left-aligned.
             *
             * `label` stays the plain string — the `title` below, the resize handle's
             * `aria-label` and `Copy with headers` all read it as TEXT and none of them
             * can render a node. `labelNode` only re-STYLES it, to the live `<th>`'s own
             * `font-mono text-[11px] font-semibold`: the platform's default header type is
             * uppercase sans in `text-muted-foreground`, and a batch code is a mono
             * identifier the operator reads as a name, not a lane label. `normal-case`
             * and `tracking-normal` undo the header's own utilities rather than fighting
             * them, and the code is already uppercase so `normal-case` changes no glyph —
             * it only stops CSS from claiming to.
             *
             * `headerWrap` is deliberately ABSENT (it was `true`): the second line here is
             * a SUBTITLE, not the name spilling over, and those are different questions.
             * The `truncate` stays as the LAST resort — `W_BLOCK` is now sized so that no
             * batch code in the database reaches it (see the constant), so in practice
             * nothing here truncates at all.
             */
            labelNode: (
                <span className="block truncate font-mono text-[11px] font-semibold normal-case leading-tight tracking-normal text-foreground">
                    {c.batchCode}
                </span>
            ),
            subLabel: c.blockLoc ?? '—',
            /**
             * CLICKING THE HEADER OPENS THE BLOCK — the live matrix's behaviour, and the
             * reason `ColumnSpec.onHeaderClick` exists at all.
             *
             * It replaces the label's column sweep ENTIRELY rather than running beside it:
             * a header that names a *thing* is not a lane label, and sweeping ~31 cells
             * behind a slide-over that just covered them is not what was asked for. The
             * sort caret and filter trigger would stay separately clickable if this column
             * offered them (it does not — see `sortable` below).
             */
            onHeaderClick: () => onBlockHeaderClick(c),
            title: `${c.batchCode} · ${c.blockLoc ?? '—'} · opened ${c.firstFedDate}`,
            width: W_BLOCK,
            align: 'right',
            cellKind: 'readonly',
            selectable: true,
            /**
             * NO built-in sort or filter on a block column, and this is not a width
             * concession — it is what the affordance would MEAN here.
             *
             * A block column is a BLOCK, not a lane of comparable values: the sheet's row
             * axis is the calendar, and re-ordering the days by how much came out of
             * `JAN-26-BLK22` produces a feeding matrix in no order at all. Worse, the
             * platform hides every chrome row while either axis is active — and this
             * grid's ENTIRE campaign footer (totals, yield, the tricolor bands, every
             * per-block rollup) is a `renderChromeRow`, so one click on a caret here
             * would delete the payoff of the screen.
             *
             * The other columns keep both. The date/day/kg lanes ARE lanes, and sorting
             * them is the ordinary spreadsheet gesture — with the same footer caveat,
             * which is reported rather than decided here.
             */
            sortable: false,
            filterable: false,
            calcType: 'SUM',
            numericValue: (row) => row.fedByBatch[batchId] ?? null,
            clipboardValue: (row) => {
                const kg = row.fedByBatch[batchId];
                return kg ? String(kg) : '';
            },
            format: (row) => {
                const kg = row.fedByBatch[batchId];
                const active = !!kg && kg !== 0;
                // A fed cell keeps the live matrix's subtle emerald wash. It is an ALPHA
                // tint on an inner layer, so the module's own selection tint underneath
                // still reads through it — and this column is never pinned, so nothing
                // bleeds.
                return withRule(
                    key === firstBlockKey,
                    <span className="font-mono tabular-nums">{fmtKg(kg)}</span>,
                    active ? 'bg-emerald-500/10' : undefined,
                );
            },
        });
    }

    return out;
}

// ─── Row families ────────────────────────────────────────────────────────────────

/**
 * ONE family — the day rows. The totals rule-off used to be a second, non-addressable
 * one, because it rode as the last ITEM of the body; since 2026-08-29 it is a PINNED
 * SUMMARY ROW (`TableSummaryRow.cell`), which lives in the `<tfoot>` and is not an item at
 * all, so the family it needed is gone with it.
 *
 * The `#` column is the one cell a day row RENDERS without offering the caret a stop —
 * `addressable: false`. Marked here rather than only on the column because it is a
 * per-CELL answer: `ColumnSpec.selectable` is per-column and `RowKind.addressable` is
 * per-row, and this is neither.
 */
function buildKinds(
    colKeys: readonly string[],
): ReadonlyMap<string, RowKind<RcMovementMatrixRow>> {
    const slots = new Map<string, { field: string; editable: boolean; addressable?: boolean }>();
    for (const key of colKeys) {
        slots.set(key, {
            field: key,
            editable: false,
            ...(key === KEY_ROWNUM ? { addressable: false } : {}),
        });
    }

    return new Map<string, RowKind<RcMovementMatrixRow>>([
        ['day', {
            kind: 'day',
            height: ROW_H,
            addressable: true,
            occupies: (colKey) => slots.get(colKey) ?? null,
        }],
    ]);
}

const ROW_RULES: Record<string, string> = { day: 'border-b border-b-border/50' };

/** What a cell HOLDS as text — the jump keys' `filled` probe. */
function fieldText(row: RcMovementMatrixRow, field: string): string {
    switch (field) {
        case KEY_ROWNUM: return String(row.rowNum);
        case KEY_DATE: return row.date;
        case KEY_DAY: return row.dayOfWeek;
        case KEY_FEDPRICE: return row.avgFedPriceDay === null ? '' : String(row.avgFedPriceDay);
        case KEY_TOTAL: return row.totalFed === 0 ? '' : String(row.totalFed);
        case KEY_PRODUCED:
            return row.totalProduced === null || row.totalProduced === 0
                ? ''
                : String(row.totalProduced);
        default: {
            if (field.startsWith('grade:')) {
                const kg = row.producedByGrade[field.slice(6)];
                return kg ? String(kg) : '';
            }
            if (field.startsWith('blk:')) {
                const kg = row.fedByBatch[field.slice(4)];
                return kg ? String(kg) : '';
            }
            return '';
        }
    }
}

// ─── Props ───────────────────────────────────────────────────────────────────────

export interface RcMovementGridV2Props {
    /** The SAME payload `RcMovementMatrix` consumes, fetched by the server page. */
    data: RcMovementMatrix;
    /**
     * The page's own resolved search params. The campaign picker rebuilds the query from
     * these, so `?grid=v2` (and anything else on the URL) survives a campaign switch.
     * Passing them down beats `useSearchParams()` here: no second read of the same truth,
     * and no Suspense boundary needed for a subtree the page already made dynamic.
     */
    searchParams: Record<string, string | string[] | undefined>;
}

// ─── The component ───────────────────────────────────────────────────────────────

export function RcMovementGridV2({ data, searchParams }: RcMovementGridV2Props) {
    const {
        campaign, campaignLabel, columns, rows, campaignOptions, grandTotalFed,
        campaignAvgFedPrice, producedGrades, campaignTotalProduced, campaignYieldPct,
        canViewPrices, campaignActualFedPrice, openBlocks,
    } = data;

    const router = useRouter();
    const pathname = usePathname();
    const [pending, startTransition] = React.useTransition();

    // Switching campaign re-runs the (dynamic) server page, which re-fetches and hands
    // this component new props — the same one-way flow the live host has, minus its
    // client fetch. Every other param is carried across, `?grid=v2` included, so the
    // toggle cannot be lost by picking a campaign.
    const onCampaignChange = React.useCallback(
        (next: string) => {
            const query = new URLSearchParams();
            for (const [key, value] of Object.entries(searchParams)) {
                if (key === 'campaign') continue;
                if (Array.isArray(value)) for (const v of value) query.append(key, v);
                else if (value !== undefined) query.append(key, value);
            }
            if (next) query.append('campaign', next);
            const qs = query.toString();
            startTransition(() => {
                router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
            });
        },
        [pathname, router, searchParams],
    );

    // `ctx` MUST be referentially stable — it is a dependency of the column resolution
    // and of every cell's `format`.
    const ctx = React.useMemo<RcMovementGridCtx>(() => ({ canViewPrices }), [canViewPrices]);

    // ── The block detail slide-over ──────────────────────────────────────────────
    //
    // State shape copied from the live matrix, field for field, because the panel's
    // contract is the same: `selectedColumn` decides whether it is open AND supplies the
    // display key, `panelBlockData` is null while the fetch is in flight (the panel owns
    // its own loading state), and `panelCanViewPrices` comes back from the SAME call
    // rather than being re-derived here.
    //
    // A batch-accurate `blockData` is fetched with `fetchBlockDataForBatch(batchId)` and
    // NOT read out of any grid map: a historical column's batch may be CLOSED, or its
    // block slot reused, in which case it is absent from `view_blocking_grid` and a map
    // lookup would show whoever occupies that loc TODAY.
    const [selectedColumn, setSelectedColumn] = React.useState<RcMovementMatrixColumn | null>(null);
    const [panelBlockData, setPanelBlockData] = React.useState<BlockData | null>(null);
    const [panelCanViewPrices, setPanelCanViewPrices] = React.useState(false);

    // The grid's imperative handle, held for ONE reason: giving the caret back when the
    // panel closes. See `handlePanelClose`.
    const apiRef = React.useRef<BlackwoodTableApi>(null);

    const handleHeaderClick = React.useCallback((column: RcMovementMatrixColumn) => {
        setSelectedColumn(column);
        setPanelBlockData(null); // the panel shows its loading state until this resolves
        fetchBlockDataForBatch(column.batchId).then((result) => {
            setPanelBlockData(result.blockData);
            setPanelCanViewPrices(result.canViewPrices);
        });
    }, []);

    /**
     * HAND THE CARET BACK. The panel is a plain `position: fixed` slide-over, NOT Radix —
     * so there is no `onCloseAutoFocus` to preventDefault, which is the idiom
     * `lib/table/CONTEXT.md` records for the Radix case. `onClose` is the single funnel
     * for every way it shuts (Escape at `blocking-detail-panel.tsx:348`, the backdrop at
     * `:530`, both X buttons at `:565` / `:635`), so calling `focus()` here covers all of
     * them with no per-path handling.
     *
     * Without it the underlying hazard is exactly the Radix one: the element that had
     * focus is inside a subtree that just unmounted, focus lands on `<body>`, and the next
     * arrow key goes nowhere. The live matrix has no equivalent — it is not on the module
     * and holds no handle to give focus back to — so this is the one place v2 does MORE
     * than the screen it mirrors, rather than less.
     */
    const handlePanelClose = React.useCallback(() => {
        setSelectedColumn(null);
        setPanelBlockData(null);
        apiRef.current?.focus();
    }, []);

    /**
     * "Edit All" from inside the panel. Reproduces `rc-movement-route-view.tsx`'s
     * `handleNavigateToBatch` VERBATIM — same params, same order — because this is the
     * same standalone route with the same problem: `/inventory/rc-movement` mounts no
     * `InventoryTabProvider`, so the panel's own fallback (a window event, then a push
     * that omits `tab=` and `editView=`) would land on a less precise deep link. Passing
     * the callback is what the live matrix does here; omitting it is NOT the equivalent.
     */
    const handleNavigateToBatch = React.useCallback(
        (target: BlockingDetailNavTarget) => {
            const tab = target.view === 'usage' ? 'usage' : 'deliveries';
            router.push(
                `/inventory?tab=${tab}&search=${encodeURIComponent(target.batchCode)}&year=all&editBatch=${encodeURIComponent(target.batchCode)}&editView=${tab}`,
            );
        },
        [router],
    );

    /** Display key for the panel's header badge: the block loc when present, else the
     *  batch code (a FEED column has no loc). The panel's `parseLocKey` tolerates a
     *  non-loc key and simply skips the loc sub-line. */
    const panelLocKey = selectedColumn
        ? (selectedColumn.blockLoc ?? selectedColumn.batchCode)
        : null;

    const specs = React.useMemo(
        () => buildColumns(columns, producedGrades, handleHeaderClick),
        [columns, producedGrades, handleHeaderClick],
    );


    const kinds = React.useMemo(
        () => buildKinds(specs.map((s) => s.key)),
        [specs],
    );

    // Day rows, and nothing else. The totals rule-off is NOT an item any more — it is a
    // pinned summary row in the `<tfoot>` (see `summaryRows` below), which is what makes it
    // stay on screen while the campaign scrolls under it.
    const items = React.useMemo<MovementItem[]>(() => {
        if (columns.length === 0 || rows.length === 0) return [];
        return rows.map((row) => ({ kind: 'day', id: row.date, data: row }));
    }, [columns.length, rows]);

    const byId = React.useMemo(() => {
        const m = new Map<string, RcMovementMatrixRow>();
        for (const row of rows) m.set(row.date, row);
        return m;
    }, [rows]);

    const storedText = React.useCallback(
        (rowId: string, field: string): string => {
            const row = byId.get(rowId);
            return row ? fieldText(row, field) : '';
        },
        [byId],
    );

    // The module's single writer, idle for the life of the component — `BlackwoodTable`
    // requires the port, and a real (unused) instance is honest where a stub would not be.
    const noDrafts = React.useCallback(() => false, []);
    const edits = useTableEdits({ canonicalText: storedText, isDraft: noDrafts });

    // Column widths the operator drags. LOCAL state: persisting them would be a write.
    const [settings, setSettings] = React.useState<TableSettings>({});

    /**
     * The clamp's width, taken from the MODULE'S OWN column resolution rather than a
     * second sum of my own: `resolveColumns` drops the columns this viewer cannot see and
     * applies any width the operator has dragged, and `minWidth` is Σ of exactly that.
     * Re-deriving it here would be a second definition of the column table, and it would
     * drift the moment a column is resized or the price gate closes.
     */
    const totalWidth = useTableColumns(specs, ctx, settings).minWidth;

    const byKey = React.useMemo(() => {
        const m = new Map<string, RcMovementMatrixColumn>();
        for (const c of columns) m.set(blockKey(c.batchId), c);
        return m;
    }, [columns]);

    const gradeTotals = React.useMemo(() => {
        const m = new Map<string, number | null>();
        for (const g of producedGrades) m.set(gradeKey(g.grade), g.campaignTotal);
        return m;
    }, [producedGrades]);

    /** The same gate the live matrix derives, under the same name. */
    const showFedPrice = canViewPrices;
    const actual = showFedPrice ? campaignActualFedPrice : null;
    const firstBlockKey = columns.length > 0 ? blockKey(columns[0].batchId) : null;

    // ── The 2px group rules, in the header ───────────────────────────────────────
    //
    // `renderHeaderSlot` is the module's one wire into `HeaderCell`, and the `<th>` is a
    // positioned box, so an `inset-y-0 left-0` sliver paints the same section rule the
    // body cells draw. It is the only way a consumer can reach a header cell's paint.
    const renderHeaderSlot = React.useCallback(
        (spec: ColumnSpec<RcMovementMatrixRow, RcMovementGridCtx>) => {
            if (spec.key !== KEY_PRODUCED && spec.key !== firstBlockKey) return null;
            return (
                <span
                    aria-hidden="true"
                    className="pointer-events-none absolute inset-y-0 left-0 w-0.5 bg-border"
                />
            );
        },
        [firstBlockKey],
    );

    // ── The campaign totals rule-off — PINNED TO THE BOTTOM (2026-08-29) ─────────
    //
    // Renzo: *"Footer must also 'freeze' same as original."*
    //
    // It used to be a `renderChromeRow`, because a `TableSummaryRow` tiled six DECLARED
    // lanes (label · frozen · spacer · figure · note · total · trailing) and could carry
    // one headline figure and one total — while this footer carries a DIFFERENT stack
    // under every one of ~40 columns. `renderChromeRow` fitted the shape and reached the
    // BODY only, so the payoff of the screen scrolled away with the rows it summarises.
    //
    // `TableSummaryRow.cell` is the platform seam that closes that gap: one cell per
    // RESOLVED column, rendered in the `<tfoot>`. This file returns the CONTENT and a
    // className; the `<td>` itself — its opaque background, its cumulative sticky `left`,
    // its z-rank and both seams — stays the module's, so the `pinnedOffsets` arithmetic
    // this callback used to do by hand is gone. A column hidden by the price gate takes
    // its footer cell with it and the offsets recompute themselves.
    const totalsCell = React.useCallback(
        (
            spec: ColumnSpec<RcMovementMatrixRow, RcMovementGridCtx>,
        ): TableSummaryCell | null => {
            // The platform's shell pads `px-2 py-1`; this rule-off is tighter and
            // vertically centred. Merged OVER, so position and z-rank cannot be lost.
            const PAD = 'px-2 py-0.5 align-middle';

            if (spec.key === KEY_ROWNUM || spec.key === KEY_DAY) {
                return { className: PAD, ariaHidden: true };
            }

            if (spec.key === KEY_DATE) {
                return {
                    className: cn(
                        PAD,
                        'text-[10px] font-medium uppercase tracking-wide text-muted-foreground',
                    ),
                    content: 'Totals',
                };
            }

            // The campaign's DELIVERED weighted-average ₱/kg (the reference line) and,
            // beneath a hairline, the ACTUAL FED ₱/kg with its coverage. Both blank —
            // never ₱0.00 — when null. This cell only exists at all when the column does,
            // i.e. never for a gated viewer, and `showFedPrice` is checked again here.
            if (spec.key === KEY_FEDPRICE) {
                if (!showFedPrice) return { className: PAD };
                return {
                    className: PAD,
                    content: (
                        <div className="flex flex-col gap-0 leading-tight">
                            <span className="text-[9px] uppercase tracking-wide text-muted-foreground">
                                camp. avg
                            </span>
                            {campaignAvgFedPrice !== null ? (
                                <span className="flex items-baseline justify-between gap-1 font-mono text-xs font-bold tabular-nums">
                                    <span className="text-muted-foreground">&#8369;</span>
                                    <span>{fmtPrice(campaignAvgFedPrice)}</span>
                                </span>
                            ) : null}
                            {actual ? (
                                <div
                                    className="mt-0.5 flex flex-col gap-0 border-t border-border/60 pt-0.5 leading-tight"
                                    title={`Actual fed ₱/kg over the ${actual.blocksInPrice} of ${actual.blocksFed} blocks that are closed AND fully priced${actual.campaignFedKgIncludedPct !== null ? ` — ${fmtFractionPct2(actual.campaignFedKgIncludedPct)} of this campaign's fed kg` : ''}. ${actual.blocksOpen} still open, ${actual.blocksClosedUnpriced} closed but awaiting a price.`}
                                >
                                    <span className="text-[9px] uppercase tracking-wide text-muted-foreground">
                                        actual fed
                                    </span>
                                    {actual.actualFedPhpKg !== null ? (
                                        <span className="flex items-baseline justify-between gap-1 font-mono text-[13px] font-bold tabular-nums">
                                            <span className="text-muted-foreground">&#8369;</span>
                                            <span>{fmtPrice(actual.actualFedPhpKg)}</span>
                                        </span>
                                    ) : null}
                                    {/* Coverage of the number DIRECTLY ABOVE —
                                        `blocksInPrice`, not `blocksClosed`: a
                                        closed-but-unpriced block is closed and
                                        still excluded. */}
                                    <span className="text-[9px] tabular-nums text-muted-foreground">
                                        {actual.blocksInPrice}/{actual.blocksFed} priced
                                    </span>
                                </div>
                            ) : null}
                        </div>
                    ),
                };
            }

            if (spec.key === KEY_TOTAL) {
                return {
                    className: cn(PAD, 'text-right font-mono font-semibold tabular-nums'),
                    content: fmtKg(grandTotalFed),
                };
            }

            // The yield/loss payoff — three LABEL-LESS opaque tricolor bands filling the
            // cell edge to edge (amber produced · emerald yield · red loss), with a
            // `title` per band so the meaning stays discoverable. `1 − yield` is a
            // display transform of the SQL fraction, never a second definition of loss.
            if (spec.key === KEY_PRODUCED) {
                return {
                    className: cn('bg-muted p-0 align-middle', GROUP_DIVIDER),
                    content: (
                        <div className="flex h-full flex-col leading-tight">
                            <div
                                title="Produced"
                                className="flex w-full flex-1 items-center justify-end bg-amber-100 pr-1 font-mono text-[11px] font-bold tabular-nums text-amber-950 dark:bg-amber-950 dark:text-amber-50"
                            >
                                {fmtKg(campaignTotalProduced) || '—'}
                            </div>
                            <div
                                title="Yield"
                                className="flex w-full flex-1 items-center justify-end bg-emerald-100 pr-1 font-mono text-[11px] font-bold tabular-nums text-emerald-950 dark:bg-emerald-950 dark:text-emerald-50"
                            >
                                {fmtYieldPct(campaignYieldPct)}
                            </div>
                            <div
                                title="Loss"
                                className="flex w-full flex-1 items-center justify-end bg-red-100 pr-1 font-mono text-[11px] font-bold tabular-nums text-red-950 dark:bg-red-950 dark:text-red-50"
                            >
                                {fmtYieldPct(campaignYieldPct === null ? null : 1 - campaignYieldPct)}
                            </div>
                        </div>
                    ),
                };
            }

            const gradeTotal = gradeTotals.get(spec.key);
            if (gradeTotal !== undefined) {
                return {
                    className: cn(PAD, 'text-right'),
                    content: (
                        <span className="font-mono text-xs font-bold tabular-nums">
                            {fmtKg(gradeTotal)}
                        </span>
                    ),
                };
            }

            const block = byKey.get(spec.key);
            if (!block) return { className: PAD, ariaHidden: true };

            const isClosedTint = block.status === 'CLOSED' || block.status === 'FEED';
            const lossClass =
                block.blockLoss === null
                    ? 'text-muted-foreground'
                    : isClosedTint
                      ? '' // inherit the red cell's foreground — legible there
                      : block.blockLoss < 0
                        ? 'text-red-600 dark:text-red-400'
                        : 'text-emerald-600 dark:text-emerald-400';

            return {
                className: cn(
                    'p-0 align-middle',
                    spec.key === firstBlockKey && GROUP_DIVIDER,
                    // WHOLE-CELL state colour, opaque, REPLACING the shell's bg-muted.
                    statusTint(block.status),
                ),
                title: [
                    `${block.batchCode} · ${block.blockLoc ?? '—'} · ${block.status}`,
                    `Fed ${fmtKg(block.totalOut) || '0'} kg · In ${fmtKg(block.totalIn) || '0'} kg`,
                    `MC ${fmtPct2(block.mc)} · Ash ${fmtPct2(block.ash)} · Loss ${fmtSignedPct(block.blockLoss)}`,
                    showFedPrice && block.actualFedPrice === null
                        ? `Actual fed: ${!block.isClosed ? 'block still open' : block.hasUnpricedDelivery ? 'awaiting price' : '—'}`
                        : '',
                    `Opened ${block.firstFedDate}`,
                ]
                    .filter(Boolean)
                    .join('\n'),
                content: (
                    <div className="flex flex-col gap-0 px-2 py-0.5 leading-tight">
                        <div className="flex items-baseline justify-between gap-1 tabular-nums">
                            <span className="text-[10px] uppercase tracking-wide opacity-70">fed</span>
                            <span className="font-mono text-xs font-semibold">
                                {fmtKg(block.totalOut) || '0'}
                            </span>
                        </div>
                        <div className="flex items-baseline justify-between gap-1 tabular-nums">
                            <span className="text-[10px] uppercase tracking-wide opacity-70">loss</span>
                            <span className={cn('font-mono text-[10px]', lossClass)}>
                                {fmtSignedPct(block.blockLoss)}
                            </span>
                        </div>
                        {showFedPrice ? (
                            <div className="flex items-baseline justify-between gap-1 tabular-nums">
                                <span className="text-[10px] uppercase tracking-wide opacity-70">
                                    &#8369;/kg
                                </span>
                                {block.avgFedPrice !== null ? (
                                    <span className="font-mono text-[10px]">
                                        {fmtPrice(block.avgFedPrice)}
                                    </span>
                                ) : null}
                            </div>
                        ) : null}
                        {/* ACTUAL FED ₱/kg. BLANK when null — an OPEN block, or a closed
                            block with an unpriced delivery, has no actual price. Never
                            ₱0.00, never a dash that reads as a value. The label slot is
                            KEPT when blank so every per-block cell stays the same height. */}
                        {showFedPrice ? (
                            <div className="mt-0.5 flex items-baseline justify-between gap-1 border-t border-border/60 pt-0.5 tabular-nums">
                                <span className="text-[10px] uppercase tracking-wide opacity-70">
                                    actual
                                </span>
                                {block.actualFedPrice !== null ? (
                                    <span className="font-mono text-[11px] font-bold">
                                        {fmtPrice(block.actualFedPrice)}
                                    </span>
                                ) : null}
                            </div>
                        ) : null}
                    </div>
                ),
            };
        },
        [
            byKey, gradeTotals, showFedPrice, actual, campaignAvgFedPrice, grandTotalFed,
            campaignTotalProduced, campaignYieldPct, firstBlockKey,
        ],
    );

    /**
     * ONE summary row, `sticky` — the whole of "footer must also freeze same as original".
     *
     * `height` is declared because the block cells stack four lines and the tallest cell
     * would otherwise decide the row height for every other column.
     */
    const summaryRows = React.useMemo<
        TableSummaryRow<RcMovementMatrixRow, RcMovementGridCtx>[]
    >(
        () => [{ key: 'totals', sticky: true, height: TOTALS_H, cell: totalsCell }],
        [totalsCell],
    );

    const rowClassFor = React.useCallback(
        (item: MovementItem): string | undefined => {
            if (!('data' in item)) return undefined;
            // `group` is what lets the module's pinned cells repaint the hover tint
            // opaquely (`cell-classes.ts` puts `group-hover:bg-muted` on every pinned
            // `<td>`), so the frozen block and the scrolling cells stay in step.
            return cn(
                'group transition-all duration-150 hover:bg-muted/50',
                item.data.totalFed === 0 && 'text-muted-foreground/60',
            );
        },
        [],
    );

    // No local selection state, and no `onStateChange`. This grid used to hold a
    // `TableState` for one purpose — printing `3 × 4 selected` in the toolbar — because
    // the module computed SUM/AVERAGE/COUNT/MIN/MAX over the rectangle and handed a
    // consumer only its DIMENSIONS. The table now publishes the real aggregates to the
    // app's floating status bar itself, so a hand-rolled size chip beside it is a second,
    // worse answer to the same question. Deleted rather than kept in parallel.

    const hasData = columns.length > 0 && rows.length > 0;

    return (
        <div className="relative flex h-full min-h-0 flex-col">
            {/* Toolbar — the live matrix's active-campaign anchor + picker + counts, minus
                the coverage badge's modal (see the report). A solid token, not glass: this
                is a static flex child, not a sticky surface. */}
            <div className="flex shrink-0 flex-wrap items-center gap-3 pb-3">
                <div className="flex flex-col leading-none">
                    <span className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                        Campaign
                    </span>
                    <span className="text-sm font-semibold text-foreground">
                        {campaignLabel || '—'}
                    </span>
                </div>

                <Select value={campaign} onValueChange={onCampaignChange}>
                    <SelectTrigger className="h-8 w-[180px] text-xs" data-grid-chrome="">
                        <SelectValue placeholder="Select campaign" />
                    </SelectTrigger>
                    {/* Glass is CORRECT here — a dropdown floats over empty space, unlike
                        the opaque frozen cells. */}
                    <SelectContent className="bg-popover/95 backdrop-blur-lg">
                        {campaignOptions.map((opt) => (
                            <SelectItem key={opt.value} value={opt.value} className="text-xs">
                                <span className="flex w-full items-center justify-between gap-3">
                                    <span>{opt.label}</span>
                                    <span className="tabular-nums text-muted-foreground">
                                        {opt.feedDays}d
                                    </span>
                                </span>
                            </SelectItem>
                        ))}
                    </SelectContent>
                </Select>

                {hasData ? (
                    <div className="text-xs text-muted-foreground">
                        <span className="font-medium text-foreground">{columns.length}</span> blocks
                        {' · '}
                        <span className="font-medium text-foreground">{rows.length}</span> days
                    </div>
                ) : null}

                {/* Coverage — the counts come from SQL (`blocks_closed` / `blocks_fed`);
                    nothing is counted here. An inert pill in v2: the badge's
                    open-blocks dialog is not built (see the report). Price-gated —
                    `actual` is null for a viewer who cannot see prices. */}
                {hasData && actual && actual.blocksFed > 0 ? (
                    <span
                        className="inline-flex w-fit shrink-0 items-center gap-1.5 rounded-full border border-border bg-card px-2 py-0.5 text-xs font-medium text-muted-foreground"
                        title={`${actual.blocksInPrice} of ${actual.blocksFed} blocks are closed AND fully priced${actual.campaignFedKgIncludedPct !== null ? ` — ${fmtFractionPct2(actual.campaignFedKgIncludedPct)} of the campaign's fed kg` : ''}.`}
                    >
                        <span
                            className={cn(
                                'h-1.5 w-1.5 rounded-full',
                                openBlocks.length > 0 ? 'bg-blue-500' : 'bg-muted-foreground/50',
                            )}
                        />
                        <span className="tabular-nums">
                            {actual.blocksClosed} of {actual.blocksFed} blocks closed
                        </span>
                        {openBlocks.length > 0 ? (
                            <span className="text-muted-foreground">
                                · {openBlocks.length} open
                            </span>
                        ) : null}
                    </span>
                ) : null}

                <span className="text-[11px] text-muted-foreground">
                    Read-only. Selection, keyboard, copy, the right-click menu, the
                    selection summary, column resize, the bottom-pinned totals footer and
                    the block-header detail panel (click a block column&apos;s header) are
                    live; the open-blocks dialog and the Radix hover info cards are not —
                    the footer&apos;s figures are on a hover tooltip instead.
                </span>
            </div>

            {/* The max-width clamp — see the header. Narrower than Σ widths, the module's
                own scroller scrolls; wider, the table stops rather than stretching its
                declared column widths out from under the frozen offsets. */}
            <div
                className={cn(
                    'flex min-h-0 flex-1 flex-col overflow-hidden rounded-md border border-border transition-opacity duration-150',
                    pending && 'pointer-events-none opacity-50',
                )}
                style={{ maxWidth: totalWidth }}
                aria-busy={pending}
            >
                <BlackwoodTable<RcMovementMatrixRow, RcMovementGridCtx>
                    apiRef={apiRef}
                    items={items}
                    kinds={kinds}
                    specs={specs}
                    ctx={ctx}
                    settings={settings}
                    onSettingsChange={setSettings}
                    edits={edits}
                    storedText={storedText}
                    // A campaign is ~31 days × ~44 columns — the live matrix is a plain
                    // sticky table for the same reason, and the focus scope is that.
                    scope="focus"
                    rowRules={ROW_RULES}
                    rowClassFor={rowClassFor}
                    summaryRows={summaryRows}
                    renderHeaderSlot={renderHeaderSlot}
                    emptyMessage="No feeding recorded for this campaign."
                    className="min-h-0 flex-1"
                />
            </div>

            {/* ── Block detail slide-over (the SAME component the live matrix and the
                Blocking grid mount) ───────────────────────────────────────────────────
                THE DISTINCTION THIS MOUNT RECORDS, because it is easy to read as a
                contradiction of the file header above:

                  • THE GRID stays read-only, and structurally so. No `ColumnSpec` here
                    declares a `parse`, so `columnAcceptsEdit` is false at every
                    coordinate — the editor cannot open, Delete/Backspace refuse, and the
                    paste loop's per-cell guard refuses. Nothing about this panel changes
                    that; a header is not a cell.
                  • THE PANEL is a SEPARATE SURFACE with its own rules, and it is existing
                    PRODUCTION code — already mounted on `/inventory/blocking` and on the
                    live matrix on this very route. It does carry write paths (block notes
                    via `updateBlockNotes`, and `EditDeliveryDialog`), and those gate
                    THEMSELVES exactly as they do on the two live screens; `canViewPrices`
                    arrives from `fetchBlockDataForBatch`'s own server-side resolution, not
                    from anything decided in this file.

                So mounting it adds NO NEW write path to the application — it reuses one
                that ships today, which is the point: Renzo's stated goal for the module is
                to "integrate existing functionalities and endpoints directly into the new
                table features", and he asked for this drawer by name. The overnight
                "import nothing that writes" rule was a safety bar for unattended building
                and is explicitly lifted here. Neither this panel nor the live matrix was
                modified by one character. */}
            <BlockingDetailPanel
                locKey={panelLocKey}
                blockData={panelBlockData}
                onClose={handlePanelClose}
                canViewPrices={panelCanViewPrices}
                onNavigateToBatch={handleNavigateToBatch}
            />

            {pending ? (
                <div className="pointer-events-none absolute inset-0 flex items-start justify-center pt-24">
                    <div className="flex items-center gap-2 rounded-md border border-border bg-background/95 px-3 py-1.5 shadow-sm backdrop-blur supports-backdrop-filter:bg-background/60">
                        <Loader2 className="size-3.5 animate-spin text-muted-foreground" />
                        <span className="text-xs text-muted-foreground">Loading campaign…</span>
                    </div>
                </div>
            ) : null}
        </div>
    );
}
