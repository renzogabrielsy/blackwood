'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { Loader2, Save } from 'lucide-react';
import { toast } from 'sonner';

import { BlackwoodTable } from '@/components/shared/table';
import type { TableChromeRowApi, TableSummaryRow } from '@/components/shared/table';
import { DEFAULT_DRAFT_ROWS, countUnsavedWork, describeUnsavedWork, needsGroupSpacer, pinnedOffsets } from '@/lib/table';
import type {
    CellContext,
    CellSlot,
    ColumnParseResult,
    ColumnSpec,
    GridRow,
    RowKind,
    TableSettings,
} from '@/lib/table';
import { useTableEdits } from '@/lib/hooks/use-table-edits';
import { useTableSettings } from '@/components/providers/table-settings';
import {
    getLabHighlightBg,
    getStateDotClass,
    type LabHighlightSpec,
    type LabMetric,
} from '@/types/table-settings';
import type { DeliveryHistoryRow, DeliveryRow } from '@/types/rc-in';
import { errorToast } from '@/lib/toast';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from '@/components/ui/dialog';
import { cn } from '@/lib/utils';

import { bulkUpdateDeliveries, submitBulkDeliveries } from './actions';
import {
    LAB_DECIMALS,
    LAB_FIELDS,
    buildDeliveryInsert,
    buildDeliveryUpdate,
    cleanPastedRcInCell,
    draftLabel,
    isDraftKey,
    isRcInEditField,
    labTextOf,
    labValueOf,
    makeDraftIds,
    normalizeRcInField,
    parseRcInField,
    phpTotalOf,
    rowLabel,
    saveFailureMessage,
    storedFieldText,
    type LabField,
    type PatchEnv,
    type RcInField,
} from './rc-in-grid-v2-save';

// ═════════════════════════════════════════════════════════════════════════════════
// RC IN on the Blackwood Table — `?grid=v2`, now EDITABLE, built BESIDE the live table.
//
// `delivery-master-table.tsx` and `bulk-delivery-input.tsx` are production and are not
// edited by one character. This file renders the SAME `DeliveryHistoryRow[]` the server
// already fetched for that table, on the universal grid, so the two can be compared
// row-for-row on the same real data
// (`handoffs/2026-08-17-universal-table-phase-1-and-the-side-by-side-method.md`).
//
// ── WHAT CHANGED IN THIS PASS ───────────────────────────────────────────────────
// The grid was READ-ONLY and structurally so: every column `readonly`, no `parse`, no
// write path. It now types and saves — the first EDITABLE ICTC table on the universal
// module — through the EXISTING server actions, unchanged, with no new SQL:
//
//   • Inline editing on the sixteen fields the bulk-input dialog lets an operator set,
//     with a commit verdict per column (`parse`) and Excel-style canonicalisation of the
//     DATE and BLOCK/LOC lanes (`normalize`).
//   • A blank-row pool at the bottom, saved through `submitBulkDeliveries` — the same
//     door the Add dialog uses, so batch upsert-by-`batch_code` stays the server's job.
//   • A Save button, an unsaved chip, and an optional save-time EDIT REASON that becomes
//     the per-row audit comment `bulkUpdateDeliveries` already carries.
//
// ── THE PAYLOAD IS A WHOLE ROW, AND THAT IS THE SERVER'S RULE ───────────────────
// `toDeliveryPayload` in `actions.ts` rebuilds a fixed object from whatever it is handed,
// so a partial patch does NOT leave the other columns alone — it clears `block_loc`,
// nulls `weight_kg`/`sacks` and writes **₱0 over the price**. `rc-in-grid-v2-save.ts` owns
// the consequence: every payload is a complete `DeliveryRow` assembled as *stored value
// unless the operator typed over it*, and the seven-key lab panel is reassembled from the
// stored JSONB because the RPC's `to_jsonb(d) || data` merge is SHALLOW.
//
// ── PRICE GATING IS A SECURITY BOUNDARY, AND IT IS NOT DECIDED HERE ─────────────
// `canViewPrices` arrives as a PROP, resolved server-side in `page.tsx` by the canonical
// `lib/auth.canViewPrices()` — which is also where `cost_basis` is stripped from the
// payload. This file never calls `hasPermission`, never re-derives the role and never sees
// a ₱ value a gated viewer was not sent. The two ₱ columns simply do not EXIST for such a
// viewer (`ColumnSpec.visible`), so they are absent from the coordinate space rather than
// blanked.
//
// **And for such a viewer the sheet stays read-only entirely.** Not squeamishness: the
// only available write action forcibly writes `cost_basis` on every row it touches, and a
// price-blind payload carries no price, so a Production operator correcting a REMARK would
// silently overwrite the delivered ₱/kg of every row they touched with the L-008 unpriced
// placeholder. Closing the door is the honest answer until a partial-patch action exists
// (see `rc-in-grid-v2-save.ts` and the module CONTEXT for the seam that would open it).
//
// ── WHAT IS STILL NOT BUILT ─────────────────────────────────────────────────────
// No toolbar, no header filters, no month strip, no row context menu, no delete, no
// history dialog — and no AUTOCOMPLETE on SUPPLIER / BATCH / LOC (the live grid's
// `AutocompletePopover`). Those cells are plain text for this pass; a typo lands as typed
// and is refused only where the server refuses it. Where a behaviour is not built this
// file renders NOTHING rather than a control that looks alive and does nothing.
//
// ── COLUMN ORDER IS CLAUDE.md's, NOT the live table's ───────────────────────────
// Project `CLAUDE.md` → "RC IN Column Config" is the canonical left-to-right order and
// this grid obeys it exactly: Date · Supplier · Batch Code · Block/Loc · Truck Plate ·
// Sacks · Weight · MC, Grit, VM, Ash, FC · BD ASTM, BD JIS · PHP/KG · PHP Total · Remarks.
// STATE leads the row, ahead of Date — it is the live table's first column and the thing
// an operator scans for. STATE and PHP TOTAL are the only two lanes with no `parse`: one
// reads the joined batch, the other is arithmetic over two other cells, and neither is a
// field anybody could ever type into.
// ═════════════════════════════════════════════════════════════════════════════════

// ─── Ctx — referentially stable, or the whole sheet re-renders ───────────────────

export interface DeliveryGridCtx {
    /** Server-resolved. Never re-derived on the client. */
    canViewPrices: boolean;
    /**
     * The grid-wide edit gate. Every editable column ANDs its own rule with this, so
     * "nothing in this sheet can be typed into" stays ONE fact in ONE place. It is
     * `canViewPrices` today — see the price note in the header.
     */
    canEdit: boolean;
    /** Column ids the operator hid in the live table's Columns popover. Read-only here. */
    hidden: ReadonlySet<string>;
    /** The operator's lab thresholds, from the shared table-settings provider. */
    labHighlights: Record<LabMetric, LabHighlightSpec>;
    /**
     * The year a bare `8/21` means when the ROW itself cannot say — the newest dated
     * delivery in view, else the current year.
     *
     * **A gap, deliberately left open:** `/inventory` is year-scoped by a `?year=` search
     * param that `page.tsx` does not thread into either table's props. Reading it here
     * would mean editing `page.tsx`, which this pass may not touch. Derived from the data
     * instead, which is right in every view where the two agree.
     */
    fallbackYear: number;
    /** The date a blank row starts on, so a draft's DATE cell has a canonical value. */
    draftDefaultDate: string;
}

/**
 * What a bare `8/21` means in THIS cell — the row's own year, because an operator
 * correcting a 2025 delivery means 2025. A blank row has no year of its own and falls
 * through to the sheet's.
 */
function contextYearOf(ctx: DeliveryGridCtx, cell?: CellContext<DeliveryHistoryRow>): number {
    const stored = cell?.row?.transaction_date;
    if (stored) {
        const y = Number(stored.slice(0, 4));
        if (Number.isFinite(y) && y > 1900) return y;
    }
    return ctx.fallbackYear;
}

function patchEnv(ctx: DeliveryGridCtx, contextYear: number): PatchEnv {
    return { canViewPrices: ctx.canViewPrices, contextYear };
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

/** An accounting cell: ₱ pinned left, figure pinned right (Excel Standard). */
function pesoCell(value: number) {
    return (
        <span className="flex w-full items-center justify-between gap-1 font-mono tabular-nums">
            <span className="text-muted-foreground">&#8369;</span>
            <span>{formatPeso(value)}</span>
        </span>
    );
}

// ─── The commit verdict ──────────────────────────────────────────────────────────

/** A verdict that refuses nothing. The module reads only `ok`; the patch is never used. */
const PARSE_OK: ColumnParseResult = { ok: true, patch: {} };

/**
 * THE commit verdict for a column, and it is `parseRcInField` — the same function the SAVE
 * runs. A value typed and the same value refused at save can never disagree, because there
 * is only one of them.
 *
 * **A BLANK cell commits without complaint.** `buildDeliveryUpdate` refuses a cleared DATE
 * and a cleared BATCH — correctly, at SAVE, where a delivery without either cannot exist.
 * At COMMIT it would mean clearing a cell you are about to retype raises a toast that
 * stays until you dismiss it. The live grid draws the line in exactly the same place, and
 * `parseRcInField` therefore treats a blank as CLEARED rather than as an error.
 */
function makeParse(field: RcInField) {
    return (
        text: string,
        ctx: DeliveryGridCtx,
        cell?: CellContext<DeliveryHistoryRow>,
    ): ColumnParseResult => {
        if (text.trim() === '') return PARSE_OK;
        const verdict = parseRcInField(field, text, patchEnv(ctx, contextYearOf(ctx, cell)));
        return verdict.ok ? { ok: true, patch: { [field]: verdict.value } } : verdict;
    };
}

/**
 * The three seams every editable column shares.
 *
 * `editable` ANDs the grid gate with the column's own rule. PHP/KG carries a second clause
 * on purpose: `visible` already drops it entirely for a gated viewer, so there is no
 * coordinate to type into — but "the column is absent" and "the cell refuses to be typed
 * into" are two different guarantees, and the price boundary is the one thing here that
 * must not depend on a single mechanism. `parseRcInField` refuses the ₱ a third time at
 * save, and `buildDeliveryUpdate` refuses the whole row a fourth.
 */
function editSeams(field: RcInField): Partial<ColumnSpec<DeliveryHistoryRow, DeliveryGridCtx>> {
    return {
        editable: (_row, ctx) => ctx.canEdit && (field !== 'cost_basis' || ctx.canViewPrices),
        parse: makeParse(field),
        normalize: (text, ctx, cell) => normalizeRcInField(field, text, patchEnv(ctx, contextYearOf(ctx, cell))),
        cleanPasted: (raw, ctx) => cleanPastedRcInCell(field, raw, patchEnv(ctx, ctx.fallbackYear)),
    };
}

// ─── Lab columns ─────────────────────────────────────────────────────────────────
//
// CLAUDE.md order and CLAUDE.md precision: MC · Grit · VM · Ash · FC to 2 places, then
// BD ASTM · BD JIS to 3. `LAB_DECIMALS` lives in the save model so the cell, the clipboard
// and the payload can never disagree about how many a lane has.

const LAB_COLUMNS: { key: LabField; label: string; title: string; decimals: number }[] =
    LAB_FIELDS.map((key) => ({
        key,
        label: { mc: 'MC', grit: 'GRIT', vm: 'VM', ash: 'ASH', fc: 'FC', bd_astm: 'BD ASTM', bd_jis: 'BD JIS' }[key],
        title: {
            mc: 'Moisture content (%)',
            grit: 'Grit (%)',
            vm: 'Volatile matter (%)',
            ash: 'Ash (%)',
            fc: 'Fixed carbon (%)',
            bd_astm: 'Bulk density — ASTM',
            bd_jis: 'Bulk density — JIS',
        }[key],
        decimals: LAB_DECIMALS[key],
    }));

// ─── Columns ─────────────────────────────────────────────────────────────────────

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
        // The joined batch's status, never a field. No `parse`, so no editor can open on
        // it — the column half of the verdict refuses every cell whatever a row says.
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
        cellKind: 'date',
        selectable: true,
        visible: hiddenBy('transaction_date'),
        clipboardValue: (row) => row.transaction_date,
        format: (row) => <span className="font-mono tabular-nums">{row.transaction_date}</span>,
        ...editSeams('transaction_date'),
    },
    {
        key: 'supplier',
        label: 'SUPPLIER',
        width: 150,
        cellKind: 'text',
        selectable: true,
        visible: hiddenBy('supplier'),
        clipboardValue: (row) => row.supplier ?? '',
        format: (row) =>
            row.supplier ? (
                <span className="block truncate" title={row.supplier}>{row.supplier}</span>
            ) : dash,
        ...editSeams('supplier'),
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
        cellKind: 'text',
        selectable: true,
        visible: hiddenBy('batch_code'),
        clipboardValue: (row) => row.batch_code ?? '',
        format: (row) =>
            row.batch_code ? (
                <span className="block truncate font-mono" title={row.batch_code}>{row.batch_code}</span>
            ) : dash,
        ...editSeams('batch_code'),
    },
    {
        key: 'block_loc',
        label: 'LOC',
        title: 'Block / location',
        width: 62,
        cellKind: 'text',
        selectable: true,
        visible: hiddenBy('block_loc'),
        // Same fallback the live table uses: the batch's `location_ref` when the delivery
        // carries none of its own. It is a DISPLAY fallback only — see `savedFieldText`.
        clipboardValue: (row) => row.block_loc || row.batches?.location_ref || '',
        format: (row) => {
            const v = row.block_loc || row.batches?.location_ref || '';
            return v ? <span className="font-mono">{v}</span> : dash;
        },
        ...editSeams('block_loc'),
    },
    {
        key: 'truck_plate',
        label: 'TRUCK',
        title: 'Truck plate',
        width: 90,
        cellKind: 'text',
        selectable: true,
        visible: hiddenBy('truck_plate'),
        clipboardValue: (row) => row.truck_plate ?? '',
        format: (row) =>
            row.truck_plate ? (
                <span className="block truncate font-mono" title={row.truck_plate}>{row.truck_plate}</span>
            ) : dash,
        ...editSeams('truck_plate'),
    },
    {
        key: 'sacks',
        label: 'SKS',
        title: 'Sacks',
        width: 58,
        align: 'right',
        cellKind: 'number',
        selectable: true,
        calcType: 'SUM',
        visible: hiddenBy('sacks'),
        numericValue: (row) => (row.sacks === null || row.sacks === undefined ? null : num(row.sacks)),
        clipboardValue: (row) => (row.sacks === null || row.sacks === undefined ? '' : String(row.sacks)),
        format: (row) =>
            row.sacks === null || row.sacks === undefined
                ? dash
                : <span className="font-mono tabular-nums">{formatInt(num(row.sacks))}</span>,
        ...editSeams('sacks'),
    },
    {
        key: 'weight_kg',
        label: 'WEIGHT',
        title: 'Weight (kg)',
        width: 96,
        align: 'right',
        cellKind: 'number',
        selectable: true,
        calcType: 'SUM',
        summaryLane: 'figure',
        visible: hiddenBy('weight_kg'),
        numericValue: (row) => num(row.weight_kg),
        clipboardValue: (row) => String(row.weight_kg ?? ''),
        format: (row) => <span className="font-mono tabular-nums">{formatInt(num(row.weight_kg))}</span>,
        ...editSeams('weight_kg'),
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
        cellKind: 'number',
        selectable: true,
        calcType: 'AVERAGE',
        visible: hiddenBy(lab.key),
        numericValue: (row) => labValueOf(row, lab.key),
        clipboardValue: (row) => labTextOf(row, lab.key),
        format: (row) => {
            const v = labValueOf(row, lab.key);
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
         * The classes merge UNDER the cached class string, so `selected` / `active` /
         * `dirty` / `invalid` all win — an out-of-band cell the operator has swept still
         * reads as swept, and a cell being typed into still reads as unsaved.
         */
        cellClass: (row, ctx) => {
            if (row === null) return undefined;
            const v = labValueOf(row, lab.key);
            if (v === null) return undefined;
            return getLabHighlightBg(lab.key, v, ctx.labHighlights) || undefined;
        },
        ...editSeams(lab.key),
    });
}

COLUMNS.push(
    {
        key: 'cost_basis',
        label: 'PHP/KG',
        title: 'Delivered price per kilogram',
        width: 92,
        align: 'right',
        cellKind: 'number',
        selectable: true,
        calcType: 'AVERAGE',
        // The SERVER decided; this only obeys. A hidden column is ABSENT from the
        // coordinate space, never blanked.
        visible: (ctx) => ctx.canViewPrices && !ctx.hidden.has('cost_basis'),
        numericValue: (row) => (row.cost_basis === null || row.cost_basis === undefined ? null : num(row.cost_basis)),
        clipboardValue: (row) => (row.cost_basis === null || row.cost_basis === undefined ? '' : String(row.cost_basis)),
        format: (row) =>
            row.cost_basis === null || row.cost_basis === undefined ? dash : pesoCell(num(row.cost_basis)),
        ...editSeams('cost_basis'),
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
        // DERIVED — weight × price. Never editable, but a range MAY cover it: a run of
        // delivery totals is the most useful thing on this sheet to sweep and add up.
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
        cellKind: 'text',
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
        ...editSeams('remarks'),
    },
);

// ─── Row families ────────────────────────────────────────────────────────────────
//
// Two data families and two chrome families. The chrome ones are NOT addressable, so they
// never enter `navRows` and the keyboard coordinate space is byte-identical with and
// without them.

/**
 * The slot tables, built FROM the column table so a column added above is covered with no
 * edit here — and `isRcInEditField` is the single source of "may a human type into this",
 * shared with the save.
 *
 * **A BLANK ROW carries the same lanes as a delivery minus the two derived ones.** A row
 * that exists nowhere has no batch status and no computed total; returning a slot there
 * would paint an empty cell the caret can sit in and a range can total, over a row with
 * nothing behind it.
 */
function buildSlots() {
    const delivery = new Map<string, CellSlot>();
    const draft = new Map<string, CellSlot>();
    for (const c of COLUMNS) {
        const editable = isRcInEditField(c.key);
        delivery.set(c.key, { field: c.key, editable });
        if (editable) draft.set(c.key, { field: c.key, editable: true });
    }
    return { delivery, draft };
}

const SLOTS = buildSlots();

const MONTH_HEADER_H = 24;
const SPACER_H = 18;

function buildKinds(rowHeight: number): ReadonlyMap<string, RowKind<DeliveryHistoryRow>> {
    return new Map<string, RowKind<DeliveryHistoryRow>>([
        ['delivery', {
            kind: 'delivery',
            height: rowHeight,
            addressable: true,
            occupies: (colKey) => SLOTS.delivery.get(colKey) ?? null,
        }],
        ['draft', {
            kind: 'draft',
            height: rowHeight,
            addressable: true,
            occupies: (colKey) => SLOTS.draft.get(colKey) ?? null,
        }],
        ['group-header', { kind: 'group-header', height: MONTH_HEADER_H, addressable: false, occupies: () => null }],
        ['spacer', { kind: 'spacer', height: SPACER_H, addressable: false, occupies: () => null }],
    ]);
}

const ROW_RULES: Record<string, string> = {
    delivery: 'border-b border-b-border/30',
    draft: 'border-b border-b-border/30',
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
 * month boundary, the rows in the order the server sent them (transaction_date DESC,
 * created_at DESC — the sort is the server's and is not re-done here), and the blank-row
 * pool at the very bottom.
 *
 * **The chrome keys carry a RUN ORDINAL, not just the month.** `computeItemKey` is the
 * virtualiser's React key, so two items sharing one is a real defect — and a month CAN
 * appear twice if the rows ever arrive out of order (nothing here re-sorts them, and a
 * search spans every year). Keying by run rather than by value makes that unrepresentable
 * instead of merely unlikely, and it costs one integer.
 */
function flatten(rows: readonly DeliveryHistoryRow[], draftIds: readonly string[]): Flattened {
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

    // The blank rows, always at the very bottom — they belong to no month until the
    // operator gives one a date, so they sit below the last heading rather than inside it.
    for (const draftId of draftIds) items.push({ kind: 'draft', id: draftId });

    return { items, months, grand };
}

// ─── Props ───────────────────────────────────────────────────────────────────────

/**
 * The SAME props `DeliveryMasterTable` receives, plus the server-resolved price gate.
 *
 * `batches`, `search`, `allSuppliers` and `allLocations` feed the live table's Add dialog
 * and its three header filters. This grid accepts them so the two components remain
 * swappable on one prop object; `batches` and `allSuppliers` are what a later autocomplete
 * pass will read, and nothing consumes them yet.
 */
export interface DeliveryGridV2Props {
    data: DeliveryHistoryRow[];
    batches: { id: string; batch_code: string; location_ref: string }[];
    search?: string;
    allSuppliers: string[];
    allLocations: string[];
    canViewPrices: boolean;
}

/** What the reason dialog is holding while it waits for an answer. */
interface PendingSave {
    updates: { id: string; data: DeliveryRow }[];
    inserts: DeliveryRow[];
    /** Row ids to `forget` once the updates land — stored deliveries only. */
    updatedRowIds: string[];
    /** Draft ids to retire once the inserts land. */
    insertedDraftIds: string[];
}

// ─── The component ───────────────────────────────────────────────────────────────

export function DeliveryGridV2(props: DeliveryGridV2Props) {
    const { data, canViewPrices } = props;

    const router = useRouter();
    const [isPending, startTransition] = React.useTransition();

    // READ ONLY from the shared provider — density, lab thresholds and the operator's
    // hidden-column set, so the two sides of the toggle agree about what to show and how
    // to flag it. Nothing here writes back: column resize below is session-local, and the
    // `saveTableSettings` action is never called from this file.
    const { settings } = useTableSettings();

    const hidden = React.useMemo(
        () => new Set(settings.hiddenColumns ?? []),
        [settings.hiddenColumns],
    );

    /**
     * The date a blank row starts on.
     *
     * The bulk-input dialog's own seed, verbatim (`createEmptyRow`), so a delivery entered
     * from either surface on the same day is dated identically. It is a DEFAULT, not an
     * edit — it never makes a row dirty — and the strip above the sheet says it out loud,
     * because a date nobody typed must not reach the ledger unseen.
     */
    const draftDefaultDate = React.useMemo(() => new Date().toISOString().split('T')[0], []);

    /** The year a bare `8/21` means when the row itself cannot say. */
    const fallbackYear = React.useMemo(() => {
        for (const row of data) {
            const y = Number((row.transaction_date ?? '').slice(0, 4));
            if (Number.isFinite(y) && y > 1900) return y;
        }
        return new Date().getFullYear();
    }, [data]);

    // `ctx` MUST be referentially stable — it is a dependency of the column resolution, of
    // every editability verdict and of every cell's `format`.
    const ctx = React.useMemo<DeliveryGridCtx>(
        () => ({
            canViewPrices,
            // See the header: the only available write action rewrites `cost_basis` on
            // every row, and a price-blind payload carries no price.
            canEdit: canViewPrices,
            hidden,
            labHighlights: settings.labHighlights,
            fallbackYear,
            draftDefaultDate,
        }),
        [canViewPrices, hidden, settings.labHighlights, fallbackYear, draftDefaultDate],
    );

    const rowHeight = settings.densityMode === 'expanded' ? 48 : 32;
    const kinds = React.useMemo(() => buildKinds(rowHeight), [rowHeight]);

    // The blank rows exist only where a blank row MEANS something. A search is a CUT of
    // history and a new delivery does not belong at the end of a cut.
    const showDrafts = ctx.canEdit && !(props.search ?? '').trim();
    const [draftIds, setDraftIds] = React.useState<string[]>(() => makeDraftIds(DEFAULT_DRAFT_ROWS));

    const { items, months, grand } = React.useMemo(
        () => flatten(data, showDrafts ? draftIds : []),
        [data, showDrafts, draftIds],
    );

    const byId = React.useMemo(() => {
        const m = new Map<string, DeliveryHistoryRow>();
        for (const row of data) m.set(row.id, row);
        return m;
    }, [data]);

    /**
     * What a cell HOLDS, as text — the editor's opening value, the jump keys' `filled`
     * probe, and the value an edit must return to in order to stop counting as unsaved.
     *
     * `storedFieldText` lives in the save model, so the text a cell compares itself against
     * and the text the save reads for an untouched field are produced by ONE function. A
     * BLANK ROW has no stored row, so its canonical text is empty everywhere except the
     * DATE — which carries the sheet's default, which is what makes typing that date by
     * hand a NON-edit instead of a row that can never be made clean again.
     */
    const storedText = React.useCallback(
        (rowId: string, field: string): string => {
            if (isDraftKey(rowId)) return field === 'transaction_date' ? draftDefaultDate : '';
            return storedFieldText(byId.get(rowId) ?? null, field);
        },
        [byId, draftDefaultDate],
    );

    // THE single journalled writer. Every mutation in this grid — an inline commit, a
    // Delete, a paste, an Escape revert, undo and redo — goes through `edits.applyEdits`.
    const edits = useTableEdits({ canonicalText: storedText, isDraft: isDraftKey });

    // Column widths the operator drags. LOCAL state, deliberately: persisting them would
    // mean calling `saveTableSettings`, and this grid does not own that surface.
    const [tableSettings, setTableSettings] = React.useState<TableSettings>({});

    // ── The blank-row pool ───────────────────────────────────────────────────────
    //
    // `onAddDrafts` returns the ids it created SYNCHRONOUSLY, because a paste that runs
    // past the last blank row needs them inside the same gesture — and those ids ride on
    // the journal step, so one Ctrl+Z takes back the paste AND the rows it grew.
    const onAddDrafts = React.useCallback((count: number) => {
        const ids = makeDraftIds(count);
        setDraftIds((prev) => [...prev, ...ids]);
        return ids;
    }, []);

    const onRemoveDrafts = React.useCallback((ids: readonly string[]) => {
        const gone = new Set(ids);
        setDraftIds((prev) => prev.filter((id) => !gone.has(id)));
    }, []);

    const onRestoreDrafts = React.useCallback((ids: readonly string[]) => {
        setDraftIds((prev) => [...prev, ...ids.filter((id) => !prev.includes(id))]);
    }, []);

    // ── Unsaved work ─────────────────────────────────────────────────────────────
    const unsaved = React.useMemo(
        () => countUnsavedWork(edits.dirtyRecords, edits.dirtyDrafts),
        [edits.dirtyRecords, edits.dirtyDrafts],
    );
    const dirtyCount = unsaved.total;

    const [saving, setSaving] = React.useState(false);
    const [pending, setPending] = React.useState<PendingSave | null>(null);
    const [reason, setReason] = React.useState('');

    // ── COMMIT — the two server actions, in order ────────────────────────────────
    //
    // **What the actions actually return, so nothing here pretends otherwise:** both
    // `bulkUpdateDeliveries` and `submitBulkDeliveries` answer with a single
    // `{ success, message? }` for the WHOLE batch — never one verdict per row.
    // `fn_bulk_update_deliveries` is transactional, so a refusal genuinely means nothing
    // was written, and that is exactly what the refusal says. There is no partial-success
    // state to render and none is invented.
    //
    // The updates go FIRST and a failure stops the run: an insert that landed beside a
    // rolled-back batch of edits would leave the operator with half a save and no way to
    // tell which half.
    const commit = React.useCallback(
        async (plan: PendingSave, editReason: string) => {
            setSaving(true);
            try {
                if (plan.updates.length > 0) {
                    const note = editReason.trim();
                    const res = await bulkUpdateDeliveries(
                        plan.updates.map((u) => ({ id: u.id, data: u.data, comment: note || undefined })),
                    );
                    if (!res.success) {
                        errorToast(saveFailureMessage('update', plan.updates.length, res.message));
                        return;
                    }
                    edits.forget(plan.updatedRowIds);
                }

                if (plan.inserts.length > 0) {
                    const res = await submitBulkDeliveries(plan.inserts);
                    if (!res.success) {
                        errorToast(saveFailureMessage('insert', plan.inserts.length, res.message), {
                            description:
                                plan.updates.length > 0
                                    ? `The ${plan.updates.length} edited row${plan.updates.length === 1 ? '' : 's'} above DID save. Only the new rows were refused, and they are still on screen.`
                                    : undefined,
                        });
                        // The edits that landed stay forgotten; the drafts keep every
                        // character so the operator can fix and retry.
                        if (plan.updates.length > 0) startTransition(() => router.refresh());
                        return;
                    }
                    // The drafts became real deliveries: drop their blank rows, then top
                    // the pool back up so the run of blanks stays the same length (Sheets
                    // never shrinks it either).
                    edits.forget(plan.insertedDraftIds);
                    const consumed = new Set(plan.insertedDraftIds);
                    setDraftIds((prev) => [
                        ...prev.filter((k) => !consumed.has(k)),
                        ...makeDraftIds(plan.insertedDraftIds.length),
                    ]);
                }

                const total = plan.updates.length + plan.inserts.length;
                toast.success(
                    `Saved ${total} deliver${total === 1 ? 'y' : 'ies'}` +
                        (plan.inserts.length > 0 && plan.updates.length > 0
                            ? ` (${plan.updates.length} edited, ${plan.inserts.length} new)`
                            : ''),
                );
                // The server page refetches and hands down fresh `data`. This component is
                // not keyed on anything, so it does NOT remount: the new rows flow in as
                // props, `flatten` / `byId` / `storedText` re-derive, and the saved rows
                // have already been forgotten — so nothing is left lit and no keystroke of
                // a REFUSED row is disturbed.
                startTransition(() => router.refresh());
            } finally {
                setSaving(false);
            }
        },
        [edits, router],
    );

    // ── SAVE ─────────────────────────────────────────────────────────────────────
    //
    // One rule above everything: **nothing is written unless every dirty row builds a
    // legal payload.** A batch that posted the good rows and reported the rest would leave
    // the sheet half-saved with the refusals still on screen, and the operator with no way
    // to tell which half landed.
    const handleSave = React.useCallback(() => {
        if (dirtyCount === 0 || saving) return;

        const map = edits.edits;
        const updates: PendingSave['updates'] = [];
        const updatedRowIds: string[] = [];
        const inserts: DeliveryRow[] = [];
        const insertedDraftIds: string[] = [];
        const problems: string[] = [];

        for (const id of edits.dirtyRecords) {
            const stored = byId.get(id);
            // Filtered out from under the edit between the typing and the Save. Its text is
            // gone with it, so there is nothing to post and nothing to warn about.
            if (!stored) continue;
            const built = buildDeliveryUpdate(stored, map[id] ?? {}, patchEnv(ctx, ctx.fallbackYear));
            if (built.errors.length > 0) {
                for (const e of built.errors) problems.push(`${rowLabel(stored)}: ${e}`);
                continue;
            }
            if (!built.row) continue;
            updates.push({ id, data: built.row });
            updatedRowIds.push(id);
        }

        for (const draftId of draftIds) {
            if (!edits.dirtyDrafts.has(draftId)) continue;
            const e = map[draftId] ?? {};
            const built = buildDeliveryInsert(e, draftDefaultDate, patchEnv(ctx, ctx.fallbackYear));
            if (built.errors.length > 0) {
                for (const err of built.errors) problems.push(`${draftLabel(e, draftDefaultDate)}: ${err}`);
                continue;
            }
            if (!built.row) continue;
            inserts.push(built.row);
            insertedDraftIds.push(draftId);
        }

        if (problems.length > 0) {
            errorToast(
                `${problems.length} change${problems.length === 1 ? '' : 's'} could not be saved — nothing was written.`,
                { description: problems.join('\n') },
            );
            return;
        }
        if (updates.length === 0 && inserts.length === 0) {
            toast.info('Nothing to save.');
            return;
        }

        const plan: PendingSave = { updates, inserts, updatedRowIds, insertedDraftIds };

        // The REASON step, and it exists only where a reason means something: an UPDATE
        // carries an edit remark onto the row's latest `audit_logs` entry (the RPC's own
        // glue), an INSERT has no prior state to explain. A save that is purely new rows
        // therefore goes straight through rather than asking a question with no answer.
        if (updates.length === 0) {
            void commit(plan, '');
            return;
        }
        setReason('');
        setPending(plan);
    }, [dirtyCount, saving, edits, byId, ctx, draftIds, draftDefaultDate, commit]);

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
        // A blank row reads as a blank row, so the end of history is visible without a
        // heading announcing it.
        if (item.kind === 'draft') return 'group bg-muted/10 transition-all duration-150 hover:bg-muted/30';
        return undefined;
    }, []);

    /** Saving, or the post-save `router.refresh()` still in flight. */
    const busy = saving || isPending;

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
                    RC IN on the Blackwood Table — typing, saving, new rows, the right-click menu, the selection
                    summary and column resize are live; the toolbar, filters, the month strip, the row menu,
                    delete and cell autocomplete are not built yet.{' '}
                    <strong className="font-semibold">Current</strong> above returns to the live table.
                </span>
                <span className="font-mono tabular-nums">
                    {grand.count} row{grand.count === 1 ? '' : 's'}
                </span>

                {/* The blank rows' seeded date, SAID OUT LOUD. A `format` runs against the
                    stored row and a blank row has none, so a muted per-row default has
                    nowhere to render — and a date nobody typed must not reach the ledger
                    unseen. One sheet, one default, one sentence. */}
                {showDrafts ? (
                    <span className="font-mono">
                        · new rows are dated <span className="font-bold">{draftDefaultDate}</span> unless you type one
                    </span>
                ) : null}

                {!ctx.canEdit ? (
                    <span className="rounded-sm border border-border px-1">
                        read-only for your role — this save path rewrites PHP/KG, which is withheld from your view
                    </span>
                ) : null}

                <div className="ml-auto flex items-center gap-2" data-grid-chrome>
                    {dirtyCount > 0 ? (
                        <span className="animate-fade-in rounded-sm border border-amber-500/40 bg-amber-500/10 px-1.5 py-0.5 font-medium text-amber-700 dark:text-amber-400">
                            {describeUnsavedWork(unsaved, { record: 'edited delivery', draft: 'new delivery' })} unsaved
                        </span>
                    ) : null}
                    <button
                        type="button"
                        data-testid="save-rc-in"
                        onClick={handleSave}
                        disabled={dirtyCount === 0 || busy}
                        className={cn(
                            'inline-flex h-6 items-center gap-1 rounded border px-2 font-medium transition-colors duration-150',
                            dirtyCount > 0 && !busy
                                ? 'border-primary bg-primary text-primary-foreground hover:bg-primary/90'
                                : 'border-input text-muted-foreground',
                            (dirtyCount === 0 || busy) && 'cursor-not-allowed opacity-60',
                        )}
                    >
                        {busy ? (
                            <Loader2 className="size-3 animate-spin" aria-hidden="true" />
                        ) : (
                            <Save className="size-3" aria-hidden="true" />
                        )}
                        {busy ? 'Saving…' : 'Save'}
                    </button>
                </div>
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
                // The blank-row pool and its `Add N more rows` control. `enabled` is what
                // also lets a paste taller than the sheet GROW into new rows, so it is off
                // under a search for exactly the same reason the rows are.
                draftKind="draft"
                drafts={{ enabled: showDrafts, defaultCount: DEFAULT_DRAFT_ROWS }}
                onAddDrafts={onAddDrafts}
                onRemoveDrafts={onRemoveDrafts}
                onRestoreDrafts={onRestoreDrafts}
                rowRules={ROW_RULES}
                rowClassFor={rowClassFor}
                renderChromeRow={renderChromeRow}
                summaryRows={summaryRows}
                emptyMessage="No deliveries in this view."
                className="min-h-0 flex-1"
            />

            {/* ── The save-time EDIT REASON ───────────────────────────────────────
                One reason for the whole save, attached to every edited row's latest
                `audit_logs` entry by the RPC's own glue — the same field the live edit
                dialog's per-row remark uses. **Optional and never blocking:** the primary
                button saves whatever is in the box, including nothing, and Escape or the
                overlay cancels the save without losing a keystroke. */}
            <Dialog
                open={pending !== null}
                onOpenChange={(open) => {
                    if (!open && !saving) setPending(null);
                }}
            >
                <DialogContent className="max-w-md bg-background/95 backdrop-blur-xl supports-[backdrop-filter]:bg-background/80 animate-modal-enter">
                    <DialogHeader>
                        <DialogTitle className="text-sm">Why did these change?</DialogTitle>
                        <DialogDescription className="text-xs">
                            {pending
                                ? `Optional. One note, attached to the audit trail of all ${pending.updates.length} edited deliver${pending.updates.length === 1 ? 'y' : 'ies'}` +
                                  (pending.inserts.length > 0
                                      ? ` — the ${pending.inserts.length} new row${pending.inserts.length === 1 ? '' : 's'} save without one.`
                                      : '.')
                                : null}
                        </DialogDescription>
                    </DialogHeader>
                    <Textarea
                        autoFocus
                        rows={3}
                        value={reason}
                        onChange={(e) => setReason(e.target.value)}
                        placeholder="e.g. corrected the weight from the weighbridge slip"
                        className="text-xs"
                    />
                    <DialogFooter className="gap-2 sm:gap-2">
                        <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            disabled={saving}
                            onClick={() => setPending(null)}
                        >
                            Cancel
                        </Button>
                        <Button
                            type="button"
                            size="sm"
                            disabled={saving}
                            onClick={() => {
                                const plan = pending;
                                if (!plan) return;
                                setPending(null);
                                void commit(plan, reason);
                            }}
                        >
                            {reason.trim() ? 'Save with note' : 'Save without a note'}
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </div>
    );
}
