'use client';

import * as React from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { Loader2 } from 'lucide-react';

import { BlackwoodTable } from '@/components/shared/table';
import type { TableChromeRowApi } from '@/components/shared/table';
import { pinnedOffsets } from '@/lib/table';
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
// ── READ-ONLY, AND STRUCTURALLY SO ──────────────────────────────────────────────
// This screen has no write path in production either — it is a pivot over SQL views.
// Every column here is `cellKind: 'readonly'` (or `'derived'`), no column carries a
// `parse`, and no `renderEditor` is passed, so `columnAcceptsEdit` is false at every
// coordinate and an editor can never open. The only action imported is the READ action
// the live screen already calls, and it is called from the SERVER page, not from here.
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

// ─── Geometry — the live matrix's numbers, unchanged ─────────────────────────────

const W_ROWNUM = 48;
const W_DATE = 100;
const W_DAY = 52;
const W_FEDPRICE = 96;
const W_TOTAL = 88;
const W_PRODUCED = 88;
const W_GRADE = 80;
/**
 * 104, not the live matrix's 92 — and paired with `headerWrap` on every block column.
 *
 * A block column is NAMED FOR ITS BATCH, and a batch code is the longest string on this
 * sheet: `SEPTEMBER-26-BLK12` is eighteen characters. At 92 with a one-line truncating
 * header the whole column read `JAN-26-B…`, so four adjacent blocks were indistinguishable
 * without hovering each one — Renzo: *"column thickness and width not accommodating for
 * the block/batch names"*, and the reason he called this the dealbreaker.
 *
 * The header now WRAPS to two lines (`ColumnSpec.headerWrap`, bounded at two by
 * `line-clamp-2`). CSS breaks at the code's own hyphens, so the natural split is
 * `SEPTEMBER-` / `26-BLK12`, and 104 is what fits the longer of those two halves:
 * ten characters at `text-[11px]` uppercase with `tracking-wide` is ~78px against the
 * header's 104 − 17 = 87 usable. The month prefix is the only part that varies in length,
 * so this is measured against the WORST case rather than against the sample in the
 * screenshot.
 *
 * The body cells are unaffected — a fed figure is at most `123,456` — and stay right-
 * aligned mono, because the header's wrap is a property of the `<th>` alone.
 */
const W_BLOCK = 104;

const ROW_H = 32; // h-8, Excel Standard
/** The totals rule-off: four stacked lines on a block column, three tricolor bands. */
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
            // Nine characters against 88 − 17 = 71 usable — one line does not fit, and
            // `TOTAL F…` is not a column name. Two lines, at the space.
            headerWrap: true,
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
            // Grade names come from `production_runs.grade` — operator text, not a closed
            // enum — so their length is not something this file gets to assume. Wrapping
            // costs nothing when the name is short and is the difference between a
            // readable header and `4X8 SPE…` when it is not.
            headerWrap: true,
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
            // The whole point of this column: it is named for its block, so the name has
            // to be readable without a hover. Two lines, breaking at the code's own
            // hyphens. `label` deliberately stays the plain string — the `title` below,
            // the resize handle's `aria-label` and `Copy with headers` all read it as text.
            headerWrap: true,
            title: `${c.batchCode} · ${c.blockLoc ?? '—'} · opened ${c.firstFedDate}`,
            width: W_BLOCK,
            align: 'right',
            cellKind: 'readonly',
            selectable: true,
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
 * Two families, and only the first is a coordinate: the day rows, and the totals
 * rule-off, which is CHROME (`addressable: false`) and therefore never enters `navRows`.
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
        ['summary', {
            kind: 'summary',
            height: TOTALS_H,
            addressable: false,
            occupies: () => null,
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

    const specs = React.useMemo(
        () => buildColumns(columns, producedGrades),
        [columns, producedGrades],
    );


    const kinds = React.useMemo(
        () => buildKinds(specs.map((s) => s.key)),
        [specs],
    );

    const items = React.useMemo<MovementItem[]>(() => {
        if (columns.length === 0 || rows.length === 0) return [];
        const out: MovementItem[] = rows.map((row) => ({
            kind: 'day',
            id: row.date,
            data: row,
        }));
        // The totals rule-off rides as the last ITEM rather than as a `summaryRows`
        // entry. See the note on `renderChromeRow` below for why it cannot be the latter.
        out.push({ kind: 'summary', key: 'totals' });
        return out;
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

    // ── The totals rule-off ──────────────────────────────────────────────────────
    //
    // A CHROME ROW, not a `summaryRows` entry, and the reason is structural: a summary
    // row tiles six DECLARED lanes (label · frozen · spacer · figure · note · total ·
    // trailing), so it can carry one headline figure and one total — while this footer
    // carries a DIFFERENT figure under every one of ~40 columns. `renderChromeRow`
    // returns the row's own cells, one `<td>` per column, which is the only shape that
    // fits. The cost is stated in the report: it is the last row of the body instead of
    // being pinned to the bottom of the scrollport.
    const renderChromeRow = React.useCallback(
        (
            item: MovementItem,
            api: TableChromeRowApi<RcMovementMatrixRow, RcMovementGridCtx>,
        ) => {
            if ('data' in item) return null;
            const left = pinnedOffsets(api.cols);
            const frozenCount = left.length;
            const base = 'border-y border-y-border align-middle';

            return (
                <>
                    {api.cols.map((spec, ci) => {
                        const frozen = ci < frozenCount;
                        const style: React.CSSProperties = { height: TOTALS_H };
                        if (frozen) style.left = left[ci];

                        // A pinned totals cell is OPAQUE (`bg-muted`, never glass) and
                        // carries the seam on the last column of the run.
                        const shell = cn(
                            base,
                            frozen && 'frozen-col bg-muted',
                            frozen && ci === frozenCount - 1
                                ? 'frozen-edge'
                                : 'border-r border-r-border/50',
                        );

                        if (spec.key === KEY_ROWNUM || spec.key === KEY_DAY) {
                            return (
                                <td
                                    key={spec.key}
                                    aria-hidden="true"
                                    className={cn(shell, 'px-2 py-0.5')}
                                    style={style}
                                />
                            );
                        }

                        if (spec.key === KEY_DATE) {
                            return (
                                <td
                                    key={spec.key}
                                    className={cn(
                                        shell,
                                        'px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground',
                                    )}
                                    style={style}
                                >
                                    Totals
                                </td>
                            );
                        }

                        // The campaign's DELIVERED weighted-average ₱/kg (the reference
                        // line) and, beneath a hairline, the ACTUAL FED ₱/kg with its
                        // coverage. Both blank — never ₱0.00 — when null. This cell only
                        // exists at all when the column does, i.e. never for a gated
                        // viewer, and `showFedPrice` is checked again here.
                        if (spec.key === KEY_FEDPRICE) {
                            return (
                                <td
                                    key={spec.key}
                                    className={cn(shell, 'px-2 py-0.5')}
                                    style={style}
                                >
                                    {showFedPrice ? (
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
                                    ) : null}
                                </td>
                            );
                        }

                        if (spec.key === KEY_TOTAL) {
                            return (
                                <td
                                    key={spec.key}
                                    className={cn(
                                        shell,
                                        'px-2 py-0.5 text-right font-mono font-semibold tabular-nums',
                                    )}
                                    style={style}
                                >
                                    {fmtKg(grandTotalFed)}
                                </td>
                            );
                        }

                        // The yield/loss payoff — three LABEL-LESS opaque tricolor bands
                        // filling the cell edge to edge (amber produced · emerald yield ·
                        // red loss), with a `title` per band so the meaning stays
                        // discoverable. `1 − yield` is a display transform of the SQL
                        // fraction, never a second definition of loss.
                        if (spec.key === KEY_PRODUCED) {
                            return (
                                <td
                                    key={spec.key}
                                    className={cn(shell, 'bg-muted p-0', GROUP_DIVIDER)}
                                    style={style}
                                >
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
                                            {fmtYieldPct(
                                                campaignYieldPct === null ? null : 1 - campaignYieldPct,
                                            )}
                                        </div>
                                    </div>
                                </td>
                            );
                        }

                        const gradeTotal = gradeTotals.get(spec.key);
                        if (gradeTotal !== undefined) {
                            return (
                                <td
                                    key={spec.key}
                                    className={cn(shell, 'bg-muted px-2 py-0.5 text-right')}
                                    style={style}
                                >
                                    <span className="font-mono text-xs font-bold tabular-nums">
                                        {fmtKg(gradeTotal)}
                                    </span>
                                </td>
                            );
                        }

                        const block = byKey.get(spec.key);
                        if (!block) {
                            return (
                                <td
                                    key={spec.key}
                                    aria-hidden="true"
                                    className={cn(shell, 'bg-muted px-2 py-0.5')}
                                    style={style}
                                />
                            );
                        }

                        const isClosedTint = block.status === 'CLOSED' || block.status === 'FEED';
                        const lossClass =
                            block.blockLoss === null
                                ? 'text-muted-foreground'
                                : isClosedTint
                                  ? '' // inherit the red cell's foreground — legible there
                                  : block.blockLoss < 0
                                    ? 'text-red-600 dark:text-red-400'
                                    : 'text-emerald-600 dark:text-emerald-400';

                        return (
                            <td
                                key={spec.key}
                                className={cn(
                                    shell,
                                    'p-0',
                                    spec.key === firstBlockKey && GROUP_DIVIDER,
                                    // WHOLE-CELL state colour, opaque, REPLACING bg-muted.
                                    statusTint(block.status),
                                )}
                                style={style}
                                title={[
                                    `${block.batchCode} · ${block.blockLoc ?? '—'} · ${block.status}`,
                                    `Fed ${fmtKg(block.totalOut) || '0'} kg · In ${fmtKg(block.totalIn) || '0'} kg`,
                                    `MC ${fmtPct2(block.mc)} · Ash ${fmtPct2(block.ash)} · Loss ${fmtSignedPct(block.blockLoss)}`,
                                    showFedPrice && block.actualFedPrice === null
                                        ? `Actual fed: ${!block.isClosed ? 'block still open' : block.hasUnpricedDelivery ? 'awaiting price' : '—'}`
                                        : '',
                                    `Opened ${block.firstFedDate}`,
                                ]
                                    .filter(Boolean)
                                    .join('\n')}
                            >
                                <div className="flex flex-col gap-0 px-2 py-0.5 leading-tight">
                                    <div className="flex items-baseline justify-between gap-1 tabular-nums">
                                        <span className="text-[10px] uppercase tracking-wide opacity-70">
                                            fed
                                        </span>
                                        <span className="font-mono text-xs font-semibold">
                                            {fmtKg(block.totalOut) || '0'}
                                        </span>
                                    </div>
                                    <div className="flex items-baseline justify-between gap-1 tabular-nums">
                                        <span className="text-[10px] uppercase tracking-wide opacity-70">
                                            loss
                                        </span>
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
                                    {/* ACTUAL FED ₱/kg. BLANK when null — an OPEN block, or
                                        a closed block with an unpriced delivery, has no
                                        actual price. Never ₱0.00, never a dash that reads as
                                        a value. The label slot is KEPT when blank so every
                                        per-block cell stays the same height. */}
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
                            </td>
                        );
                    })}
                </>
            );
        },
        [
            byKey, gradeTotals, showFedPrice, actual, campaignAvgFedPrice, grandTotalFed,
            campaignTotalProduced, campaignYieldPct, firstBlockKey,
        ],
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

                <span className="rounded-sm border border-amber-500/40 px-1 text-[11px] font-medium text-amber-600 dark:text-amber-400">
                    grid=v2
                </span>
                <span className="text-[11px] text-muted-foreground">
                    Read-only. Selection, keyboard, copy, the right-click menu, the
                    selection summary and column resize are live; the block-header detail
                    panel, the open-blocks dialog, the hover info cards and the
                    bottom-pinned footer are not.
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
                    renderChromeRow={renderChromeRow}
                    renderHeaderSlot={renderHeaderSlot}
                    emptyMessage="No feeding recorded for this campaign."
                    className="min-h-0 flex-1"
                />
            </div>

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
