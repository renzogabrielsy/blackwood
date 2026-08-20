'use client';

import * as React from 'react';

import { BlackwoodTable } from '@/components/shared/table';
import type { TableChromeRowApi, TableSummaryRow } from '@/components/shared/table';
import { needsGroupSpacer, pinnedOffsets } from '@/lib/table';
import type { ColumnSpec, GridRow, RowKind, TableSettings } from '@/lib/table';
import { useTableEdits } from '@/lib/hooks/use-table-edits';
import { useTableSettings } from '@/components/providers/table-settings';
import {
    getLabHighlightBg,
    getStateDotClass,
    type LabHighlightSpec,
    type LabMetric,
} from '@/types/table-settings';
import type { DeliveryHistoryRow } from '@/types/rc-in';
import { cn } from '@/lib/utils';

// ═════════════════════════════════════════════════════════════════════════════════
// RC IN on the Blackwood Table — `?grid=v2`, READ-ONLY, built BESIDE the live table.
//
// `delivery-master-table.tsx` is production and is not edited by one character. This file
// renders the SAME `DeliveryHistoryRow[]` the server already fetched for that table, on
// the universal grid, so the two can be compared row-for-row on the same real data
// (`handoffs/2026-08-17-universal-table-phase-1-and-the-side-by-side-method.md`).
//
// ── READ-ONLY, AND STRUCTURALLY SO ──────────────────────────────────────────────
// There is no write path here at all, and that is a property of the SHAPE rather than a
// promise: every column is `cellKind: 'readonly'`, no column carries a `parse`, and no
// `renderEditor` is passed — so `columnAcceptsEdit` is false at every coordinate and an
// editor can never open. No server action is imported. No draft-row pool. No context menu.
// Nothing in this file can change a byte in the database.
//
// `RowKind.occupies()` still reports the TRUTH about which fields would be editable (see
// `EDITABLE_FIELD` below), because that is the answer the module needs to keep and the
// answer the later edit pass will build on — it is simply inert while the column half of
// the verdict says no.
//
// ── WHAT IT DOES DO ─────────────────────────────────────────────────────────────
// Everything a spreadsheet does short of typing: cell selection and rectangular ranges,
// the full keyboard including Ctrl/Cmd+Arrow · Home/End · Ctrl+Home/End · PageUp/PageDown,
// Ctrl/Cmd+C to the clipboard as TSV, the floating selection-aggregate pill, the built-in
// right-click menu, column resize, a frozen STATE+DATE block at the left edge, month group
// headings inside the body (`renderChromeRow`) and a sticky totals rule-off.
//
// The pill and the menu are the TABLE's now, not this file's: `BlackwoodTable` publishes
// the selection's SUM/AVERAGE/COUNT/MIN/MAX to the app's status bar itself and ships a
// default Copy / Copy row / Select column menu, so there is nothing here to wire and —
// more to the point — nothing here that could disagree with the other nine sheets.
//
// ── AN OUT-OF-BAND LAB READING TINTS THE WHOLE CELL ─────────────────────────────
// Through `ColumnSpec.cellClass`, using `getLabHighlightBg` — the SAME predicate and the
// same operator-configured colour the live table applies to its `<td>`. It used to be a
// small rounded pill drawn inside `format`, because before that seam existed `format` was
// the only place a consumer could paint; see the lab column block below.
//
// ── COLUMN ORDER IS CLAUDE.md's, NOT the live table's ───────────────────────────
// Project `CLAUDE.md` → "RC IN Column Config" is the canonical left-to-right order and
// this grid obeys it exactly: Date · Supplier · Batch Code · Block/Loc · Truck Plate ·
// Sacks · Weight · MC, Grit, VM, Ash, FC · BD ASTM, BD JIS · PHP/KG · PHP Total · Remarks.
// The live table predates that config and differs in three places (labs interleaved as
// MC/GRIT/BD·BD/VM/ASH/FC, Weight before Sacks, Remarks before the ₱ columns), so a
// side-by-side flip visibly REORDERS the sheet. That is the intended reading of the two
// sides, not a defect in either.
//
// STATE leads the row, ahead of Date. It is not one of the 17 columns `CLAUDE.md` lists —
// it is the live table's first column and the thing an operator scans for, so dropping it
// would make the comparison poorer for no gain. It is one entry in `COLUMNS` and removing
// it is a one-line change.
//
// ── PRICE GATING IS A SECURITY BOUNDARY, AND IT IS NOT DECIDED HERE ─────────────
// `canViewPrices` arrives as a PROP, resolved server-side in `page.tsx` by the canonical
// `lib/auth.canViewPrices()` — which is also where `cost_basis` is stripped from the
// payload. This file never calls `hasPermission`, never re-derives the role and never sees
// a ₱ value a gated viewer was not sent. The two ₱ columns simply do not EXIST for such a
// viewer (`ColumnSpec.visible`), so they are absent from the coordinate space rather than
// blanked — the keyboard has no hole, a copy cannot address them, and the totals lane
// collapses on its own.
// ═════════════════════════════════════════════════════════════════════════════════

// ─── Ctx — referentially stable, or the whole sheet re-renders ───────────────────

export interface DeliveryGridCtx {
    /** Server-resolved. Never re-derived on the client. */
    canViewPrices: boolean;
    /** Column ids the operator hid in the live table's Columns popover. Read-only here. */
    hidden: ReadonlySet<string>;
    /** The operator's lab thresholds, from the shared table-settings provider. */
    labHighlights: Record<LabMetric, LabHighlightSpec>;
}

type DeliveryItem = GridRow<DeliveryHistoryRow>;

// ─── Formatting ──────────────────────────────────────────────────────────────────

const dash = <span className="text-muted-foreground/40">—</span>;

/** Weight and sacks: whole numbers, grouped. */
function formatInt(value: number): string {
    return value.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
}

/** Accounting figure — the number only; the ₱ is pinned separately by the cell. */
function formatPeso(value: number): string {
    return value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** `2026-08` → `AUGUST 2026`, for a month heading. */
const MONTH_NAMES = [
    'JANUARY', 'FEBRUARY', 'MARCH', 'APRIL', 'MAY', 'JUNE',
    'JULY', 'AUGUST', 'SEPTEMBER', 'OCTOBER', 'NOVEMBER', 'DECEMBER',
];

function formatMonthHeading(monthKey: string): string {
    const [y, m] = monthKey.split('-');
    const idx = Number(m) - 1;
    const name = MONTH_NAMES[idx] ?? monthKey;
    return `${name} ${y}`;
}

const num = (v: unknown): number => {
    const n = typeof v === 'number' ? v : parseFloat(String(v ?? ''));
    return Number.isFinite(n) ? n : 0;
};

/** The ₱ a row is worth. The one definition, so the cell, the pill and the totals agree. */
function phpTotalOf(row: DeliveryHistoryRow): number {
    return num(row.weight_kg) * num(row.cost_basis);
}

/** An accounting cell: ₱ pinned left, figure pinned right (Excel Standard). */
function pesoCell(value: number) {
    return (
        <span className="flex w-full items-center justify-between gap-1 font-mono tabular-nums">
            <span className="text-muted-foreground">&#8369;</span>
            <span>{formatPeso(value)}</span>
        </span>
    );
}

// ─── Lab columns ─────────────────────────────────────────────────────────────────
//
// CLAUDE.md order and CLAUDE.md precision: MC · Grit · VM · Ash · FC to 2 places, then
// BD ASTM · BD JIS to 3. The decimals live here so the cell, the clipboard and a future
// editor can never disagree about how many a lane has.

const LAB_COLUMNS: { key: LabMetric; label: string; title: string; decimals: number }[] = [
    { key: 'mc', label: 'MC', title: 'Moisture content (%)', decimals: 2 },
    { key: 'grit', label: 'GRIT', title: 'Grit (%)', decimals: 2 },
    { key: 'vm', label: 'VM', title: 'Volatile matter (%)', decimals: 2 },
    { key: 'ash', label: 'ASH', title: 'Ash (%)', decimals: 2 },
    { key: 'fc', label: 'FC', title: 'Fixed carbon (%)', decimals: 2 },
    { key: 'bd_astm', label: 'BD ASTM', title: 'Bulk density — ASTM', decimals: 3 },
    { key: 'bd_jis', label: 'BD JIS', title: 'Bulk density — JIS', decimals: 3 },
];

const LAB_DECIMALS: Record<string, number> = Object.fromEntries(
    LAB_COLUMNS.map((c) => [c.key, c.decimals]),
);

/**
 * `lab_results` is TYPED as seven required numbers and is not one at runtime: it is a
 * JSONB blob, and a panel that has not been filled in yet arrives with the key missing,
 * null, or an empty string. Hence the widening — the type is the optimistic reading and
 * the values are what the database actually holds.
 */
function labValue(row: DeliveryHistoryRow, key: LabMetric): number | null {
    const raw: unknown = row.lab_results?.[key];
    if (raw === null || raw === undefined || raw === '') return null;
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
}

function labText(row: DeliveryHistoryRow, key: LabMetric): string {
    const v = labValue(row, key);
    return v === null ? '' : v.toFixed(LAB_DECIMALS[key] ?? 2);
}

// ─── Columns ─────────────────────────────────────────────────────────────────────
//
// Every one is `readonly` + `selectable`: a run of any lane on this sheet is worth
// sweeping and adding up, and none of them may be typed into.

function hiddenBy(key: string) {
    return (ctx: DeliveryGridCtx) => !ctx.hidden.has(key);
}

const COLUMNS: ColumnSpec<DeliveryHistoryRow, DeliveryGridCtx>[] = [
    {
        key: 'state',
        label: 'STATE',
        title: 'Batch status',
        // Floored by `SUNDRYING` — the longest `batch_status` value — plus the 6px status
        // dot and its gap, against the module's `px-2` + 1px selection gutter (18px of
        // chrome). 84 left it a pixel or two short; 92 is the honest minimum.
        width: 92,
        pin: 'start',
        cellKind: 'readonly',
        selectable: true,
        visible: hiddenBy('state'),
        // Renzo: "the state column should never be copied when doing copy row." STATE is
        // a status rail, not part of the delivery record — `Copy row` names no columns, so
        // it has to be told what the row IS. It narrows the ROW-COPY path ONLY: a
        // rectangle the operator swept over this column is still copied verbatim, because
        // sweeping it is asking for it.
        rowCopy: false,
        clipboardValue: (row) => row.state || 'STORED',
        format: (row) => {
            const state = row.state || 'STORED';
            return (
                <span className="inline-flex items-center gap-1.5">
                    <span className={cn('inline-block size-1.5 shrink-0 rounded-full', getStateDotClass(state))} />
                    <span className="truncate text-[10px]">{state}</span>
                </span>
            );
        },
    },
    {
        key: 'transaction_date',
        label: 'DATE',
        title: 'Transaction date (yyyy-MM-dd)',
        // `transaction_date` is stored as `yyyy-MM-dd`, which is also the format CLAUDE.md
        // asks for — so it is rendered VERBATIM. No `new Date(...)` anywhere near it: the
        // live table parses it back to a Date to re-print it, and that round trip is the
        // classic place a timezone quietly moves a delivery to the previous day.
        width: 98,
        pin: 'start',
        cellKind: 'readonly',
        selectable: true,
        visible: hiddenBy('transaction_date'),
        clipboardValue: (row) => row.transaction_date,
        format: (row) => <span className="font-mono tabular-nums">{row.transaction_date}</span>,
    },
    {
        key: 'supplier',
        label: 'SUPPLIER',
        width: 150,
        cellKind: 'readonly',
        selectable: true,
        visible: hiddenBy('supplier'),
        clipboardValue: (row) => row.supplier ?? '',
        format: (row) =>
            row.supplier ? (
                <span className="block truncate" title={row.supplier}>{row.supplier}</span>
            ) : dash,
    },
    {
        key: 'batch_code',
        label: 'BATCH',
        title: 'Batch code',
        // MEASURED against the longest REAL code, not against the label: `SEPTEMBER-26-BLK18`
        // renders **132.91px** in this cell's own mono font, so the column needs 151. The
        // sheet also carries `AUGUST-26-BLK15` (109.17) and `FEBRUARY-26-FEED1`. At 118
        // every long-month block truncated — and a batch code cut in the middle is exactly
        // the value an operator is scanning this column for.
        width: 152,
        cellKind: 'readonly',
        selectable: true,
        visible: hiddenBy('batch_code'),
        clipboardValue: (row) => row.batch_code ?? '',
        format: (row) =>
            row.batch_code ? (
                <span className="block truncate font-mono" title={row.batch_code}>{row.batch_code}</span>
            ) : dash,
    },
    {
        key: 'block_loc',
        label: 'LOC',
        title: 'Block / location',
        width: 62,
        cellKind: 'readonly',
        selectable: true,
        visible: hiddenBy('block_loc'),
        // Same fallback the live table uses: the batch's `location_ref` when the delivery
        // carries none of its own.
        clipboardValue: (row) => row.block_loc || row.batches?.location_ref || '',
        format: (row) => {
            const v = row.block_loc || row.batches?.location_ref || '';
            return v ? <span className="font-mono">{v}</span> : dash;
        },
    },
    {
        key: 'truck_plate',
        label: 'TRUCK',
        title: 'Truck plate',
        width: 90,
        cellKind: 'readonly',
        selectable: true,
        visible: hiddenBy('truck_plate'),
        clipboardValue: (row) => row.truck_plate ?? '',
        format: (row) =>
            row.truck_plate ? (
                <span className="block truncate font-mono" title={row.truck_plate}>{row.truck_plate}</span>
            ) : dash,
    },
    {
        key: 'sacks',
        label: 'SKS',
        title: 'Sacks',
        width: 58,
        align: 'right',
        cellKind: 'readonly',
        selectable: true,
        calcType: 'SUM',
        visible: hiddenBy('sacks'),
        numericValue: (row) => (row.sacks === null || row.sacks === undefined ? null : num(row.sacks)),
        clipboardValue: (row) => (row.sacks === null || row.sacks === undefined ? '' : String(row.sacks)),
        format: (row) =>
            row.sacks === null || row.sacks === undefined
                ? dash
                : <span className="font-mono tabular-nums">{formatInt(num(row.sacks))}</span>,
    },
    {
        key: 'weight_kg',
        label: 'WEIGHT',
        title: 'Weight (kg)',
        width: 96,
        align: 'right',
        cellKind: 'readonly',
        selectable: true,
        calcType: 'SUM',
        summaryLane: 'figure',
        visible: hiddenBy('weight_kg'),
        numericValue: (row) => num(row.weight_kg),
        clipboardValue: (row) => String(row.weight_kg ?? ''),
        format: (row) => <span className="font-mono tabular-nums">{formatInt(num(row.weight_kg))}</span>,
    },
    // Lab columns are appended below, in CLAUDE.md's order.
];

for (const lab of LAB_COLUMNS) {
    COLUMNS.push({
        key: lab.key,
        label: lab.label,
        title: lab.title,
        // A 3-decimal BD lane is floored by its HEADER (`BD ASTM`, seven characters at
        // `text-[11px]` uppercase ≈ 54px against 68 − 17 = 51 usable), not by `0.352`.
        width: lab.decimals === 3 ? 76 : 58,
        align: 'right',
        cellKind: 'readonly',
        selectable: true,
        calcType: 'AVERAGE',
        visible: hiddenBy(lab.key),
        numericValue: (row) => labValue(row, lab.key),
        clipboardValue: (row) => labText(row, lab.key),
        format: (row) => {
            const v = labValue(row, lab.key);
            if (v === null) return dash;
            return (
                <span className="block w-full text-right font-mono tabular-nums">
                    {v.toFixed(lab.decimals)}
                </span>
            );
        },
        /**
         * OUT OF BAND TINTS THE WHOLE CELL — Renzo: *"I want the entire cell tinted"*.
         *
         * The predicate and the colour are BOTH `getLabHighlightBg`, the same call the
         * live `delivery-master-table.tsx` makes, so no threshold is invented here: the
         * operator's own limit, direction, on/off switch and colour choice come from the
         * shared table-settings provider and a limit changed there moves both sides of
         * the `?grid=v2` toggle at once. (The live table has ONE level, not two — a single
         * threshold per metric, default red — so there is no warn tier to match.)
         *
         * Before this seam existed the only place a consumer could paint was INSIDE
         * `format`, which is why this rendered as a small rounded pill hugging the digits
         * with the rest of the cell plain. That is what the screenshot shows and it is not
         * how a spreadsheet marks a bad reading.
         *
         * The classes merge UNDER the cached class string, so `selected` / `active` /
         * `dirty` / `invalid` all win — an out-of-band cell the operator has swept still
         * reads as swept.
         */
        cellClass: (row, ctx) => {
            if (row === null) return undefined;
            const v = labValue(row, lab.key);
            if (v === null) return undefined;
            return getLabHighlightBg(lab.key, v, ctx.labHighlights) || undefined;
        },
    });
}

COLUMNS.push(
    {
        key: 'cost_basis',
        label: 'PHP/KG',
        title: 'Delivered price per kilogram',
        width: 92,
        align: 'right',
        cellKind: 'readonly',
        selectable: true,
        calcType: 'AVERAGE',
        // The SERVER decided; this only obeys. A hidden column is ABSENT from the
        // coordinate space, never blanked.
        visible: (ctx) => ctx.canViewPrices && !ctx.hidden.has('cost_basis'),
        numericValue: (row) => (row.cost_basis === null || row.cost_basis === undefined ? null : num(row.cost_basis)),
        clipboardValue: (row) => (row.cost_basis === null || row.cost_basis === undefined ? '' : String(row.cost_basis)),
        format: (row) =>
            row.cost_basis === null || row.cost_basis === undefined ? dash : pesoCell(num(row.cost_basis)),
    },
    {
        key: 'php_total',
        label: 'PHP TOTAL',
        title: 'Weight × delivered price',
        // Accounting format: the ₱ is pinned left and the figure right, so the cell has to
        // hold BOTH plus the gap between them. A real total reaches `1,234,567.89` — twelve
        // mono characters ≈ 87px — plus ~8px of glyph, 4px of gap and 18px of chrome: 117,
        // against a declared 118. One peso more and it clipped.
        width: 128,
        align: 'right',
        cellKind: 'readonly',
        selectable: true,
        calcType: 'SUM',
        summaryLane: 'total',
        visible: (ctx) => ctx.canViewPrices && !ctx.hidden.has('php_total'),
        numericValue: (row) => phpTotalOf(row),
        clipboardValue: (row) => String(phpTotalOf(row)),
        format: (row) => pesoCell(phpTotalOf(row)),
    },
    {
        key: 'remarks',
        label: 'REMARKS',
        width: 220,
        cellKind: 'readonly',
        selectable: true,
        visible: hiddenBy('remarks'),
        clipboardValue: (row) => row.remarks ?? '',
        format: (row) =>
            row.remarks ? (
                // Excel Standard: truncate at 200px, full text on hover. A `title`
                // attribute rather than a Radix tooltip — 18 columns × a virtualised
                // window of rows is the wrong place to mount a portal per cell, and the
                // native affordance is what a spreadsheet actually has.
                <span
                    className="block max-w-[200px] truncate text-muted-foreground"
                    title={row.remarks}
                >
                    {row.remarks}
                </span>
            ) : null,
    },
);

// ─── Row families ────────────────────────────────────────────────────────────────
//
// One data family and two chrome families. The chrome ones are NOT addressable, so they
// never enter `navRows` and the keyboard coordinate space is byte-identical with and
// without them.

/**
 * Which fields a human may type into once the edit pass lands — the TRUTH, recorded now
 * so the later slice inherits it rather than re-deriving it. It is inert today: every
 * `ColumnSpec` above is `cellKind: 'readonly'` and carries no `parse`, so the column half
 * of the verdict refuses every cell whatever this says.
 *
 * `state` reads the joined batch, `php_total` is arithmetic over two other cells: neither
 * is a field anybody could ever type into, here or later.
 */
const EDITABLE_FIELD: Record<string, boolean> = {
    state: false,
    php_total: false,
    transaction_date: true,
    supplier: true,
    batch_code: true,
    block_loc: true,
    truck_plate: true,
    sacks: true,
    weight_kg: true,
    mc: true,
    grit: true,
    vm: true,
    ash: true,
    fc: true,
    bd_astm: true,
    bd_jis: true,
    cost_basis: true,
    remarks: true,
};

const DELIVERY_SLOTS: ReadonlyMap<string, { field: string; editable: boolean }> = new Map(
    COLUMNS.map((c) => [c.key, { field: c.key, editable: EDITABLE_FIELD[c.key] ?? false }]),
);

const MONTH_HEADER_H = 24;
const SPACER_H = 18;

function buildKinds(rowHeight: number): ReadonlyMap<string, RowKind<DeliveryHistoryRow>> {
    return new Map<string, RowKind<DeliveryHistoryRow>>([
        ['delivery', {
            kind: 'delivery',
            height: rowHeight,
            addressable: true,
            occupies: (colKey) => DELIVERY_SLOTS.get(colKey) ?? null,
        }],
        ['group-header', { kind: 'group-header', height: MONTH_HEADER_H, addressable: false, occupies: () => null }],
        ['spacer', { kind: 'spacer', height: SPACER_H, addressable: false, occupies: () => null }],
    ]);
}

const ROW_RULES: Record<string, string> = {
    delivery: 'border-b border-b-border/30',
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
    items: DeliveryItem[];
    /** Month-heading payloads, by chrome-row key. */
    months: Map<string, MonthBlock>;
    grand: MonthBlock;
}

/**
 * The ONE place the shape of this sheet is decided: month headings, a blank spacer at each
 * month boundary, and the rows in the order the server sent them (transaction_date DESC,
 * created_at DESC — the sort is the server's and is not re-done here).
 *
 * **The chrome keys carry a RUN ORDINAL, not just the month.** `computeItemKey` is the
 * virtualiser's React key, so two items sharing one is a real defect — and a month CAN
 * appear twice if the rows ever arrive out of order (nothing here re-sorts them, and a
 * search spans every year). Keying by run rather than by value makes that unrepresentable
 * instead of merely unlikely, and it costs one integer.
 */
function flatten(rows: readonly DeliveryHistoryRow[]): Flattened {
    const items: DeliveryItem[] = [];
    const months = new Map<string, MonthBlock>();
    const grand: MonthBlock = { label: 'ALL', count: 0, kg: 0, php: 0 };

    let prev: string | undefined;
    let run = 0;
    let chromeKey = '';
    for (const row of rows) {
        // A row with no date is normalised to '' rather than left undefined — two such
        // rows then compare equal and get no spacer between them, like any other group.
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
        const php = phpTotalOf(row);
        block.count += 1;
        block.kg += kg;
        block.php += php;
        grand.count += 1;
        grand.kg += kg;
        grand.php += php;

        items.push({ kind: 'delivery', id: row.id, data: row });
    }

    return { items, months, grand };
}

/** What a cell HOLDS as text — the jump keys' `filled` probe and the clipboard's source. */
function fieldText(row: DeliveryHistoryRow, field: string): string {
    switch (field) {
        case 'state': return row.state || 'STORED';
        case 'transaction_date': return row.transaction_date ?? '';
        case 'supplier': return row.supplier ?? '';
        case 'batch_code': return row.batch_code ?? '';
        case 'block_loc': return row.block_loc || row.batches?.location_ref || '';
        case 'truck_plate': return row.truck_plate ?? '';
        case 'sacks': return row.sacks === null || row.sacks === undefined ? '' : String(row.sacks);
        case 'weight_kg': return row.weight_kg === null || row.weight_kg === undefined ? '' : String(row.weight_kg);
        case 'cost_basis': return row.cost_basis === null || row.cost_basis === undefined ? '' : String(row.cost_basis);
        case 'php_total': return String(phpTotalOf(row));
        case 'remarks': return row.remarks ?? '';
        default:
            return LAB_DECIMALS[field] !== undefined ? labText(row, field as LabMetric) : '';
    }
}

// ─── Props ───────────────────────────────────────────────────────────────────────

/**
 * The SAME props `DeliveryMasterTable` receives, plus the server-resolved price gate.
 *
 * `batches`, `search`, `allSuppliers` and `allLocations` feed the live table's Add dialog
 * and its three header filters, none of which a read-only grid has. They are accepted
 * anyway so the two components remain swappable on one prop object, and so the edit pass
 * has nothing to rewire.
 */
export interface DeliveryGridV2Props {
    data: DeliveryHistoryRow[];
    batches: { id: string; batch_code: string; location_ref: string }[];
    search?: string;
    allSuppliers: string[];
    allLocations: string[];
    canViewPrices: boolean;
}

// ─── The component ───────────────────────────────────────────────────────────────

export function DeliveryGridV2(props: DeliveryGridV2Props) {
    const { data, canViewPrices } = props;

    // READ ONLY from the shared provider — density, lab thresholds and the operator's
    // hidden-column set, so the two sides of the toggle agree about what to show and how
    // to flag it. Nothing here writes back: column resize below is session-local, and the
    // `saveTableSettings` action is never called from this file.
    const { settings } = useTableSettings();

    const hidden = React.useMemo(
        () => new Set(settings.hiddenColumns ?? []),
        [settings.hiddenColumns],
    );

    // `ctx` MUST be referentially stable — it is a dependency of the column resolution and
    // of every cell's `format`.
    const ctx = React.useMemo<DeliveryGridCtx>(
        () => ({ canViewPrices, hidden, labHighlights: settings.labHighlights }),
        [canViewPrices, hidden, settings.labHighlights],
    );

    const rowHeight = settings.densityMode === 'expanded' ? 48 : 32;
    const kinds = React.useMemo(() => buildKinds(rowHeight), [rowHeight]);

    const { items, months, grand } = React.useMemo(() => flatten(data), [data]);

    const byId = React.useMemo(() => {
        const m = new Map<string, DeliveryHistoryRow>();
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

    // The module's single writer. Nothing in this grid ever calls `applyEdits`, so it
    // holds an empty map for the life of the component — but `BlackwoodTable` requires the
    // port, and handing it a real (idle) instance is honest where a stub would not be.
    const noDrafts = React.useCallback(() => false, []);
    const edits = useTableEdits({ canonicalText: storedText, isDraft: noDrafts });

    // Column widths the operator drags. LOCAL state, deliberately: persisting them would
    // mean calling `saveTableSettings`, and this grid has no write path of any kind.
    const [tableSettings, setTableSettings] = React.useState<TableSettings>({});

    // ── Month headings, inside the body ──────────────────────────────────────────
    const renderChromeRow = React.useCallback(
        (item: DeliveryItem, api: TableChromeRowApi<DeliveryHistoryRow, DeliveryGridCtx>) => {
            if (!('key' in item)) return null;

            // The month boundary: an ACTUAL empty row of the spreadsheet, one `<td>` per
            // column rather than a spanning cell — that is what carries the vertical rules
            // through it — and the pinned block stays FULLY OPAQUE or the scrolling rows
            // bleed through the gap.
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
                            {block.count} deliver{block.count === 1 ? 'y' : 'ies'}
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
    // The live table shows its TOTALS footer only when a filter is active. This grid has
    // no filters, so it shows the total of everything on screen, always — a rule-off that
    // appears and disappears is a worse answer than one that is always true.
    const summaryRows = React.useMemo<TableSummaryRow[]>(
        () => [{
            key: 'grand',
            sticky: true,
            label: (
                <span className="font-mono text-[11px] font-bold uppercase tracking-wide">
                    &Sigma; {grand.count} deliver{grand.count === 1 ? 'y' : 'ies'}
                </span>
            ),
            figure: (
                <span className="block text-right font-mono tabular-nums">{formatInt(grand.kg)}</span>
            ),
            total: canViewPrices ? (
                <span className="flex w-full items-center justify-between gap-1 font-mono tabular-nums">
                    <span className="text-muted-foreground/70">&#8369;</span>
                    <span>{formatPeso(grand.php)}</span>
                </span>
            ) : undefined,
        }],
        [grand, canViewPrices],
    );

    const rowClassFor = React.useCallback((item: DeliveryItem): string | undefined => {
        if (item.kind === 'delivery') return 'group transition-all duration-150 hover:bg-muted/50';
        return undefined;
    }, []);

    return (
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
            {/* A solid token, not glass: this strip is a `shrink-0` flex child, not a
                sticky surface, and a `backdrop-filter` over an opaque page paints nothing
                while still costing a compositor layer. */}
            <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border bg-muted/40 px-3 py-1 text-[11px] text-muted-foreground">
                <span className="rounded-sm border border-amber-500/40 px-1 font-medium text-amber-600 dark:text-amber-400">
                    grid=v2
                </span>
                <span>
                    RC IN on the Blackwood Table — <strong className="font-semibold">read-only</strong>. Selection,
                    keyboard, copy, the right-click menu, the selection summary and column resize are live; the
                    toolbar, filters, the month strip, the row menu and every editing path are not built yet.{' '}
                    <strong className="font-semibold">Current</strong> above returns to the live table.
                </span>
                <span className="ml-auto font-mono tabular-nums">
                    {grand.count} row{grand.count === 1 ? '' : 's'}
                </span>
            </div>

            <BlackwoodTable<DeliveryHistoryRow, DeliveryGridCtx>
                items={items}
                kinds={kinds}
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
                emptyMessage="No deliveries in this view."
                className="min-h-0 flex-1"
            />
        </div>
    );
}
