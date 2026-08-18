'use client';

import * as React from 'react';

import { BlackwoodTable } from '@/components/shared/table';
import type { TableChromeRowApi, TableSummaryRow } from '@/components/shared/table';
import { needsGroupSpacer, pinnedOffsets } from '@/lib/table';
import type { ColumnSpec, GridRow, RowKind, TableSettings } from '@/lib/table';
import { useTableEdits } from '@/lib/hooks/use-table-edits';
import type { RcOutRow } from '@/types/rc-out';
import { cn } from '@/lib/utils';

// ═════════════════════════════════════════════════════════════════════════════════
// RC OUT on the Blackwood Table — `?grid=v2`, READ-ONLY, built BESIDE the live table.
//
// `components/rc-out-table.tsx` is production and is not edited by one character. This
// file renders the SAME `RcOutRow[]` that `fetchRcOutTabData()` already returned for that
// table, on the universal grid, so the two can be compared row-for-row on the same real
// data (the strangler-fig method — see
// `handoffs/2026-08-17-universal-table-phase-1-and-the-side-by-side-method.md`).
//
// ── READ-ONLY, AND STRUCTURALLY SO ──────────────────────────────────────────────
// Every column is `cellKind: 'readonly'` and none carries a `parse`, so
// `columnAcceptsEdit` is false at every coordinate and no editor can open. No
// `renderEditor`, no draft pool, no context menu, no server action imported. Nothing here
// can change a byte in the database.
//
// ── COLUMNS ARE THE LIVE TABLE'S, IN THE LIVE TABLE'S ORDER ─────────────────────
// Unlike RC IN — whose canonical order is fixed by `CLAUDE.md` and differs from what the
// live table renders — RC OUT has no such config, so the order here is exactly
// `rc-out-table.tsx`'s: DATE · STATE · BATCH · BLOCK · WT · PLANT/ETC · BLOCK LOC ·
// REMARKS · AVG PRICE · AVG VAL. The kebab `actions` column is deliberately absent: it is
// a menu whose only two items are Edit and Delete.
//
// ── AND NO COLUMN IS PINNED, WHICH IS A DECISION, NOT AN OMISSION ───────────────
// RC IN v2 pins its STATE+DATE pair, because eighteen columns always scroll sideways and
// losing the date while you scroll is the whole reason frozen panes exist. RC OUT does
// NOT, for a reason that only shows up on this sheet: it TINTS THE WHOLE ROW by batch
// status (`getRowStateClasses`), and a row tint cannot reach a pinned cell.
//
// The module paints every pinned `<td>` with an opaque `bg-background` — correctly, and
// non-negotiably: a frozen column sits ON TOP of scrolling content, so any alpha lets the
// moving cells bleed through it (project `CLAUDE.md` → "Frozen Panes"). A class from
// `rowClassFor` lands on the `<tr>`, which the opaque cell then covers. Pinning here would
// therefore paint the red CLOSED wash across columns 3-10 and leave DATE and STATE plain —
// a half-painted row, which reads as a bug rather than as a trade-off. The live table has
// no frozen columns either, so this also keeps the two sides comparable.
//
// The seam that would let a consumer have both is a per-ROW background token the class
// table layers into the pinned cell as well; the module has no such prop today, and that
// is reported rather than worked around.
//
// ── PRICE GATING IS A SECURITY BOUNDARY, AND IT IS NOT DECIDED HERE ─────────────
// RC OUT already uses the server-first pattern and this grid keeps it: `canViewPrices`
// arrives as a PROP that `fetchRcOutTabData()` computed with the canonical
// `lib/auth.canViewPrices()`, in the same call that nulled `avg_price` / `avg_wtd_value`
// before the payload left the server. This file never calls `hasPermission` and never
// re-derives the role. The two ₱ columns simply do not EXIST for a gated viewer
// (`ColumnSpec.visible`), so they are absent from the coordinate space rather than
// blanked — the keyboard has no hole and a copy cannot address them.
//
// ── STATE COLOURING IS A LOCAL COPY, ON PURPOSE ─────────────────────────────────
// `getStateClasses` / `getRowStateClasses` are module-private in `rc-out-table.tsx` and
// are not exported. Exporting them would mean EDITING a production file this migration
// may not touch, so the two pure presentational functions are copied verbatim below. They
// are deleted with this comment when the live table is retired at cutover.
// ═════════════════════════════════════════════════════════════════════════════════

// ─── State colouring (copied verbatim from `components/rc-out-table.tsx`) ─────────

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

// ─── Ctx — referentially stable, or the whole sheet re-renders ───────────────────

export interface RcOutGridCtx {
    /** Server-resolved. Never re-derived on the client. */
    canViewPrices: boolean;
}

type RcOutItem = GridRow<RcOutRow>;

// ─── Formatting ──────────────────────────────────────────────────────────────────

const dash = <span className="text-muted-foreground/40">—</span>;

function formatInt(value: number): string {
    return value.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
}

function formatPeso(value: number): string {
    return value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

const num = (v: unknown): number => {
    const n = typeof v === 'number' ? v : parseFloat(String(v ?? ''));
    return Number.isFinite(n) ? n : 0;
};

/** An accounting cell: ₱ pinned left, figure pinned right (Excel Standard). */
function pesoCell(value: number, bold = false) {
    return (
        <span className={cn('flex w-full items-center justify-between gap-1 font-mono tabular-nums', bold && 'font-bold')}>
            <span className="text-muted-foreground">&#8369;</span>
            <span>{formatPeso(value)}</span>
        </span>
    );
}

const MONTH_NAMES = [
    'JANUARY', 'FEBRUARY', 'MARCH', 'APRIL', 'MAY', 'JUNE',
    'JULY', 'AUGUST', 'SEPTEMBER', 'OCTOBER', 'NOVEMBER', 'DECEMBER',
];

function formatMonthHeading(monthKey: string): string {
    const [y, m] = monthKey.split('-');
    return `${MONTH_NAMES[Number(m) - 1] ?? monthKey} ${y}`;
}

function stateOf(row: RcOutRow): string {
    return row.batches?.status || 'STORED';
}

function locOf(row: RcOutRow): string {
    return row.block_loc || row.batches?.location_ref || '';
}

// ─── Columns ─────────────────────────────────────────────────────────────────────

const COLUMNS: ColumnSpec<RcOutRow, RcOutGridCtx>[] = [
    {
        key: 'transaction_date',
        label: 'DATE',
        title: 'Transaction date (yyyy-MM-dd)',
        // Stored as `yyyy-MM-dd`, rendered VERBATIM — the live table does the same, and a
        // `new Date(...)` round trip is the classic place a timezone moves a feeding to
        // the previous day.
        width: 98,
        cellKind: 'readonly',
        selectable: true,
        clipboardValue: (row) => row.transaction_date,
        format: (row) => <span className="font-mono font-bold tabular-nums">{row.transaction_date}</span>,
    },
    {
        key: 'state',
        label: 'STATE',
        title: 'Batch status',
        width: 88,
        align: 'center',
        cellKind: 'readonly',
        selectable: true,
        clipboardValue: stateOf,
        format: (row) => {
            const status = stateOf(row);
            return (
                <span className="flex items-center justify-center" title={`Batch status: ${status}`}>
                    <span
                        className={cn(
                            'inline-block rounded px-1.5 py-0.5 font-mono text-[10px] font-bold leading-none',
                            getStateClasses(status),
                        )}
                    >
                        {status}
                    </span>
                </span>
            );
        },
    },
    {
        key: 'production_batch',
        label: 'BATCH',
        title: 'Production batch',
        width: 100,
        align: 'center',
        cellKind: 'readonly',
        selectable: true,
        clipboardValue: (row) => row.production_batch ?? '',
        format: (row) =>
            row.production_batch ? (
                <span className="block truncate text-center font-mono font-bold" title={row.production_batch}>
                    {row.production_batch}
                </span>
            ) : dash,
    },
    {
        key: 'batch_code',
        label: 'BLOCK',
        title: 'Source block (batch code)',
        width: 118,
        align: 'center',
        cellKind: 'readonly',
        selectable: true,
        clipboardValue: (row) => row.batches?.batch_code ?? '',
        format: (row) =>
            row.batches?.batch_code ? (
                <span className="block truncate text-center font-mono font-bold" title={row.batches.batch_code}>
                    {row.batches.batch_code}
                </span>
            ) : dash,
    },
    {
        key: 'weight_kg',
        label: 'WT',
        title: 'Weight fed (kg)',
        width: 92,
        align: 'right',
        cellKind: 'readonly',
        selectable: true,
        calcType: 'SUM',
        summaryLane: 'figure',
        numericValue: (row) => num(row.weight_kg),
        clipboardValue: (row) => String(row.weight_kg ?? ''),
        format: (row) => <span className="font-mono font-bold tabular-nums">{formatInt(num(row.weight_kg))}</span>,
    },
    {
        key: 'destination',
        label: 'PLANT/ETC',
        title: 'Destination',
        width: 130,
        cellKind: 'readonly',
        selectable: true,
        clipboardValue: (row) => row.destination ?? '',
        format: (row) =>
            row.destination ? (
                <span className="block truncate font-bold" title={row.destination}>{row.destination}</span>
            ) : dash,
    },
    {
        key: 'block_loc',
        label: 'BLOCK LOC',
        title: 'Physical block location',
        width: 96,
        align: 'center',
        cellKind: 'readonly',
        selectable: true,
        // Same fallback the live table uses: the batch's `location_ref` when the feeding
        // carries none of its own.
        clipboardValue: locOf,
        format: (row) => {
            const loc = locOf(row);
            return loc ? <span className="block truncate text-center font-mono" title={loc}>{loc}</span> : dash;
        },
    },
    {
        key: 'remarks',
        label: 'REMARKS',
        width: 220,
        cellKind: 'readonly',
        selectable: true,
        clipboardValue: (row) => row.remarks ?? '',
        format: (row) =>
            row.remarks ? (
                // Excel Standard: truncate at 200px, full text on hover. A `title`
                // attribute rather than a Radix tooltip — a virtualised window is the
                // wrong place to mount a portal per cell.
                <span className="block max-w-[200px] truncate text-muted-foreground" title={row.remarks}>
                    {row.remarks}
                </span>
            ) : null,
    },
    {
        key: 'avg_price',
        label: 'AVG PRICE',
        title: "The source block's weighted average ₱/kg",
        width: 100,
        align: 'right',
        cellKind: 'readonly',
        selectable: true,
        calcType: 'AVERAGE',
        // The SERVER decided; this only obeys.
        visible: (ctx) => ctx.canViewPrices,
        numericValue: (row) => (row.avg_price === null || row.avg_price === undefined ? null : num(row.avg_price)),
        clipboardValue: (row) => (row.avg_price === null || row.avg_price === undefined ? '' : String(row.avg_price)),
        format: (row) => (row.avg_price === null || row.avg_price === undefined ? dash : pesoCell(num(row.avg_price))),
    },
    {
        key: 'avg_wtd_value',
        label: 'AVG VAL',
        title: 'Weighted value of this feeding',
        width: 118,
        align: 'right',
        cellKind: 'readonly',
        selectable: true,
        calcType: 'SUM',
        summaryLane: 'total',
        visible: (ctx) => ctx.canViewPrices,
        numericValue: (row) =>
            row.avg_wtd_value === null || row.avg_wtd_value === undefined ? null : num(row.avg_wtd_value),
        clipboardValue: (row) =>
            row.avg_wtd_value === null || row.avg_wtd_value === undefined ? '' : String(row.avg_wtd_value),
        format: (row) =>
            row.avg_wtd_value === null || row.avg_wtd_value === undefined
                ? dash
                : pesoCell(num(row.avg_wtd_value), true),
    },
];

// ─── Row families ────────────────────────────────────────────────────────────────

/**
 * Which fields a human may type into once the edit pass lands — recorded now so the later
 * slice inherits the answer rather than re-deriving it. Inert today: every `ColumnSpec`
 * above is `cellKind: 'readonly'` and carries no `parse`, so the column half of the
 * verdict refuses every cell whatever this says.
 *
 * `state`, `batch_code`, `avg_price` and `avg_wtd_value` are never typed by anyone: the
 * first two come from the joined batch and the last two are DB-computed columns
 * (`rc_out_avg_price` / `rc_out_avg_wtd_value`).
 */
const EDITABLE_FIELD: Record<string, boolean> = {
    transaction_date: true,
    state: false,
    production_batch: true,
    batch_code: false,
    weight_kg: true,
    destination: true,
    block_loc: true,
    remarks: true,
    avg_price: false,
    avg_wtd_value: false,
};

const RC_OUT_SLOTS: ReadonlyMap<string, { field: string; editable: boolean }> = new Map(
    COLUMNS.map((c) => [c.key, { field: c.key, editable: EDITABLE_FIELD[c.key] ?? false }]),
);

const ROW_H = 32;
const MONTH_HEADER_H = 24;
const SPACER_H = 18;

const KINDS: ReadonlyMap<string, RowKind<RcOutRow>> = new Map<string, RowKind<RcOutRow>>([
    ['feeding', {
        kind: 'feeding',
        height: ROW_H,
        addressable: true,
        occupies: (colKey) => RC_OUT_SLOTS.get(colKey) ?? null,
    }],
    ['group-header', { kind: 'group-header', height: MONTH_HEADER_H, addressable: false, occupies: () => null }],
    ['spacer', { kind: 'spacer', height: SPACER_H, addressable: false, occupies: () => null }],
]);

const ROW_RULES: Record<string, string> = {
    feeding: 'border-b border-b-border/30',
    spacer: 'border-b border-b-border',
};

// ─── The flatten ─────────────────────────────────────────────────────────────────

interface MonthBlock {
    label: string;
    count: number;
    kg: number;
    php: number;
}

interface Flattened {
    items: RcOutItem[];
    months: Map<string, MonthBlock>;
    grand: MonthBlock;
}

/**
 * The ONE place the shape of this sheet is decided: month headings, a blank spacer at each
 * month boundary, and the rows in the order the server sent them (transaction_date DESC).
 * The sort is the server's and is not re-done here.
 *
 * **The chrome keys carry a RUN ORDINAL, not just the month.** `computeItemKey` is the
 * virtualiser's React key, so two items sharing one is a real defect — and a month CAN
 * appear twice if the rows ever arrive out of order. Keying by run rather than by value
 * makes that unrepresentable instead of merely unlikely.
 */
function flatten(rows: readonly RcOutRow[]): Flattened {
    const items: RcOutItem[] = [];
    const months = new Map<string, MonthBlock>();
    const grand: MonthBlock = { label: 'ALL', count: 0, kg: 0, php: 0 };

    let prev: string | undefined;
    let run = 0;
    let chromeKey = '';
    for (const row of rows) {
        const key = (row.transaction_date ?? '').slice(0, 7);
        if (needsGroupSpacer(prev, key)) items.push({ kind: 'spacer', key: `sp:${run}` });
        if (prev !== key) {
            run += 1;
            chromeKey = `mh:${run}:${key}`;
            items.push({ kind: 'group-header', key: chromeKey });
            months.set(chromeKey, { label: key ? formatMonthHeading(key) : 'NO DATE', count: 0, kg: 0, php: 0 });
        }
        prev = key;

        const block = months.get(chromeKey)!;
        const kg = num(row.weight_kg);
        const php = num(row.avg_wtd_value);
        block.count += 1;
        block.kg += kg;
        block.php += php;
        grand.count += 1;
        grand.kg += kg;
        grand.php += php;

        items.push({ kind: 'feeding', id: row.id, data: row });
    }

    return { items, months, grand };
}

/** What a cell HOLDS as text — the jump keys' `filled` probe and the clipboard's source. */
function fieldText(row: RcOutRow, field: string): string {
    switch (field) {
        case 'transaction_date': return row.transaction_date ?? '';
        case 'state': return stateOf(row);
        case 'production_batch': return row.production_batch ?? '';
        case 'batch_code': return row.batches?.batch_code ?? '';
        case 'weight_kg': return row.weight_kg === null || row.weight_kg === undefined ? '' : String(row.weight_kg);
        case 'destination': return row.destination ?? '';
        case 'block_loc': return locOf(row);
        case 'remarks': return row.remarks ?? '';
        case 'avg_price': return row.avg_price === null || row.avg_price === undefined ? '' : String(row.avg_price);
        case 'avg_wtd_value':
            return row.avg_wtd_value === null || row.avg_wtd_value === undefined ? '' : String(row.avg_wtd_value);
        default: return '';
    }
}

// ─── Props ───────────────────────────────────────────────────────────────────────

type Batch = {
    id: string;
    batch_code: string;
    location_ref: string;
};

/**
 * The SAME props `RcOutTable` receives.
 *
 * `batches`, `destinations`, `batchOptions`, `yearOptions`, `blockLocs` and `onRefresh`
 * feed the live table's five filter popovers, its Add dialog and its Refresh button —
 * none of which a read-only grid has. They are accepted anyway so the two components
 * remain swappable on one prop object, and so the edit pass has nothing to rewire.
 */
export interface RcOutGridV2Props {
    data: RcOutRow[];
    batches: Batch[];
    destinations: string[];
    batchOptions: string[];
    yearOptions: number[];
    blockLocs: string[];
    canViewPrices: boolean;
    onRefresh?: () => Promise<void>;
}

// ─── The component ───────────────────────────────────────────────────────────────

export function RcOutGridV2(props: RcOutGridV2Props) {
    const { data, canViewPrices } = props;

    // `ctx` MUST be referentially stable — it is a dependency of the column resolution and
    // of every cell's `format`.
    const ctx = React.useMemo<RcOutGridCtx>(() => ({ canViewPrices }), [canViewPrices]);

    const { items, months, grand } = React.useMemo(() => flatten(data), [data]);

    const byId = React.useMemo(() => {
        const m = new Map<string, RcOutRow>();
        for (const row of data) m.set(row.id, row);
        return m;
    }, [data]);

    const storedText = React.useCallback(
        (rowId: string, field: string): string => {
            const row = byId.get(rowId);
            return row ? fieldText(row, field) : '';
        },
        [byId],
    );

    // The module's single writer. Nothing in this grid ever calls `applyEdits`, so it holds
    // an empty map for the life of the component — but `BlackwoodTable` requires the port,
    // and handing it a real (idle) instance is honest where a stub would not be.
    const noDrafts = React.useCallback(() => false, []);
    const edits = useTableEdits({ canonicalText: storedText, isDraft: noDrafts });

    // Column widths the operator drags. LOCAL state, deliberately: persisting them would
    // mean a write, and this grid has no write path of any kind.
    const [tableSettings, setTableSettings] = React.useState<TableSettings>({});

    // ── Month headings, inside the body ──────────────────────────────────────────
    const renderChromeRow = React.useCallback(
        (item: RcOutItem, api: TableChromeRowApi<RcOutRow, RcOutGridCtx>) => {
            if (!('key' in item)) return null;

            // The month boundary: an ACTUAL empty row, one `<td>` per column rather than a
            // spanning cell — that is what carries the vertical rules through it — and the
            // pinned block stays FULLY OPAQUE or the scrolling rows bleed through the gap.
            if (item.kind === 'spacer') {
                const left = pinnedOffsets(api.cols);
                return (
                    <>
                        {api.cols.map((c, ci) => {
                            const frozen = ci < left.length;
                            return (
                                <td
                                    key={c.key}
                                    aria-hidden="true"
                                    className={cn(
                                        'border-b border-b-border border-r border-r-border/40 p-0 align-middle',
                                        frozen && 'frozen-col bg-background',
                                        frozen && ci === left.length - 1 && 'frozen-edge',
                                    )}
                                    style={{ height: SPACER_H, ...(frozen ? { left: left[ci] } : {}) }}
                                />
                            );
                        })}
                    </>
                );
            }

            const block = months.get(item.key);
            if (!block) return null;
            return (
                <td colSpan={api.colCount} className="h-6 border-b border-border/40 bg-muted/25 px-2 py-1">
                    <span className="flex flex-wrap items-baseline gap-x-3 font-mono text-[11px] font-bold uppercase tracking-wide text-muted-foreground">
                        {block.label}
                        <span className="font-normal normal-case text-muted-foreground/60">
                            {block.count} feeding{block.count === 1 ? '' : 's'}
                        </span>
                        <span className="font-normal tabular-nums text-muted-foreground/60">
                            {formatInt(block.kg)} kg
                        </span>
                        {canViewPrices ? (
                            <span className="font-normal tabular-nums text-muted-foreground/60">
                                &#8369;{formatPeso(block.php)}
                            </span>
                        ) : null}
                    </span>
                </td>
            );
        },
        [months, canViewPrices],
    );

    // ── The sticky totals rule-off ───────────────────────────────────────────────
    //
    // The live table shows its TOTALS footer only when a filter is active. This grid has no
    // filters, so it totals everything on screen, always.
    //
    // The ₱/kg in the note lane is a BLENDED figure — total value ÷ total kg — never the
    // mean of the per-row averages, which would weight a 500 kg feeding the same as a
    // 20,000 kg one. Same rule as the campaign rollup in `view_rc_movement_*`.
    const summaryRows = React.useMemo<TableSummaryRow[]>(() => {
        const blended = grand.kg > 0 ? grand.php / grand.kg : 0;
        return [{
            key: 'grand',
            sticky: true,
            label: (
                <span className="font-mono text-[11px] font-bold uppercase tracking-wide">
                    &Sigma; {grand.count} feeding{grand.count === 1 ? '' : 's'}
                </span>
            ),
            figure: <span className="block text-right font-mono tabular-nums">{formatInt(grand.kg)}</span>,
            note: canViewPrices && grand.kg > 0 ? (
                <span className="block text-right font-mono text-[10px] tabular-nums text-muted-foreground">
                    blended &#8369;{formatPeso(blended)}/kg
                </span>
            ) : undefined,
            total: canViewPrices ? (
                <span className="flex w-full items-center justify-between gap-1 font-mono tabular-nums">
                    <span className="text-muted-foreground/70">&#8369;</span>
                    <span>{formatPeso(grand.php)}</span>
                </span>
            ) : undefined,
        }];
    }, [grand, canViewPrices]);

    // The live table tints the whole row by batch status, and so does this one. It lands on
    // the `<tr>`, which reaches every cell here precisely BECAUSE no column is pinned — see
    // the header for why that is the trade this sheet makes.
    const rowClassFor = React.useCallback((item: RcOutItem): string | undefined => {
        if (item.kind !== 'feeding' || !('data' in item)) return undefined;
        return cn(
            'group transition-all duration-150 hover:bg-muted/50',
            getRowStateClasses(stateOf(item.data)),
        );
    }, []);

    return (
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
            <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border bg-muted/40 px-3 py-1 text-[11px] text-muted-foreground">
                <span className="rounded-sm border border-amber-500/40 px-1 font-medium text-amber-600 dark:text-amber-400">
                    grid=v2
                </span>
                <span>
                    RC OUT on the Blackwood Table — <strong className="font-semibold">read-only</strong>. Selection,
                    keyboard, copy and column resize are live; the five filters, search, the Closed Blocks summary,
                    the row menu and every editing path are not built yet.{' '}
                    <strong className="font-semibold">Current</strong> above returns to the live table.
                </span>
                <span className="ml-auto font-mono tabular-nums">
                    {grand.count} row{grand.count === 1 ? '' : 's'}
                </span>
            </div>

            <BlackwoodTable<RcOutRow, RcOutGridCtx>
                items={items}
                kinds={KINDS}
                specs={COLUMNS}
                ctx={ctx}
                settings={tableSettings}
                onSettingsChange={setTableSettings}
                edits={edits}
                storedText={storedText}
                scope="endless"
                rowRules={ROW_RULES}
                rowClassFor={rowClassFor}
                renderChromeRow={renderChromeRow}
                summaryRows={summaryRows}
                emptyMessage="No usage records in this view."
                className="min-h-0 flex-1"
            />
        </div>
    );
}
