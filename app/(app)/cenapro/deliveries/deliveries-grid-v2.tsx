'use client';

import * as React from 'react';
import { AlertTriangle, History } from 'lucide-react';
import { format as formatDateFns, isValid, parseISO } from 'date-fns';

import { BlackwoodTable } from '@/components/shared/table';
import type { TableChromeRowApi, TableSummaryRow } from '@/components/shared/table';
import {
    DEFAULT_FIRST_ITEM_INDEX,
    pinnedOffsets,
    shiftFirstItemIndex,
} from '@/lib/table';
import type { ColumnSpec, GridRow, RowKind } from '@/lib/table';
import { useTableEdits } from '@/lib/hooks/use-table-edits';
import { cn } from '@/lib/utils';

import { useDeliveriesWindow } from './use-deliveries-window';
// The props interface is IMPORTED, never re-declared — that is what makes the two grids
// interchangeable in `page.tsx` and what stops them drifting while both are alive. A
// `import type` is erased at compile time, so this costs nothing in the bundle and does
// not couple the two components at runtime.
import type { DeliveriesLedgerProps } from './deliveries-ledger';
import {
    buildColumns,
    clipboardNumber,
    columnCalcType,
    duplicateBadge,
    flagSummary,
    formatDestinationCell,
    formatInt,
    formatKg,
    formatLab,
    formatPeso,
    formatRate,
    formatSupplierCell,
    isSelectableColumn,
    labDecimals,
    needsDaySpacer,
    num,
    priceEditText,
    sampleFieldFor,
    weightEditText,
    DAY_SPACER_ROW_H,
    ROW_H,
    SAMPLE_ROW_H,
    type DeliveryCol,
    type DeliveryRecord,
    type RcDeliveryRow,
    type RcDeliverySampleRow,
} from './types';
import {
    NOT_PRICED_TEXT,
    SETTLEMENT_LABEL,
    SETTLEMENT_NOTE,
    settlementStatus,
    stillOwedText,
    // The liquidation formatter, deliberately, and NOT this module's `formatPeso` — a
    // remainder keeps 4 decimals, because a still-owed ₱0.004 rendered as `0.00` reads as
    // SETTLED. Same reasoning, same import, as the ledger next door.
    formatPeso as formatBalancePeso,
} from '../liquidation/types';

// ═════════════════════════════════════════════════════════════════════════════════
// RC Deliveries — the SAME sheet, rendered through the platform's Blackwood Table.
//
// This file is **Stage 1D, slice 1** of the universal-table migration, and it exists
// BESIDE `deliveries-ledger.tsx` rather than in place of it (the strangler-fig method
// from `handoffs/2026-08-17-universal-table-phase-1-and-the-side-by-side-method.md`).
// The old ledger is the production path and is not edited by one character; this one is
// reachable only at `/cenapro/deliveries?grid=v2`, so the rewire can land half-finished,
// be compared row-for-row against the original on the same real receipts, and be reverted
// by deleting one file.
//
// ── WHAT THIS SLICE IS ──────────────────────────────────────────────────────────
// Column specs · row families (`occupies`) · the flatten (day heading, `Σ DAY TOTAL`,
// the endless day spacer) · a READ-ONLY render of both scopes.
//
// ── WHAT IT DELIBERATELY IS NOT, YET ────────────────────────────────────────────
// No editing, no save, no toolbar, no filter popovers, no context menu, no dialogs, no
// blank draft rows. Where a behaviour is not built, this file renders NOTHING rather
// than a control that looks alive and does nothing:
//
//   • `ctx.canEdit` is FALSE, and every editable column's `editable()` is ANDed with it.
//     That is one switch, not fifteen omissions: with it off, `columnAcceptsEdit` refuses
//     every cell, so Enter / F2 / double-click open no editor, Delete clears nothing and a
//     paste reports that it landed outside the editable cells. Cells read `cursor-default`.
//     Slice 2 flips it to true and wires `parse` + the save path.
//   • The duplicate-peer popover and the import-flag popover are BUTTONS in the old
//     ledger. Here their content rides in the cell's `title` instead — the same facts,
//     with nothing pretending to be clickable.
//   • The draft-row pool is absent: a blank row you cannot type into is not a blank row.
//
// ── THE ROW MODEL, AND THE ONE PLACE IT IS EXPRESSED ────────────────────────────
// A receipt and one of its moisture draws are DIFFERENT FAMILIES: a draw has no date, no
// truck, no sacks, no weight, no warehouse, no remarks and no price. `occupies(colKey)`
// is the per-cell answer, and getting it wrong is BUG-024 — a paste that mapped block
// rows onto nav rows by arithmetic, wrote a receipt's data into its own moisture sub-rows
// and reported success. `sampleFieldFor` / `SAMPLE_LAB_FIELDS` in `./types` stay the ONE
// definition of which lanes a draw occupies; this file only asks them.
// ═════════════════════════════════════════════════════════════════════════════════

// ─── Ctx — referentially stable, or the whole sheet re-renders ───────────────────

export interface DeliveryGridCtx {
    /**
     * Derived SERVER-SIDE from `canViewPrices()`. The ₱ fields are already NULL in this
     * payload and the ₱ columns are already absent from `buildColumns(canViewPrices)`, so
     * nothing here re-derives the boundary — it is read, never decided.
     */
    canViewPrices: boolean;
    /**
     * The slice-1 read-only gate. Every editable column ANDs its own rule with this, so
     * "nothing in this grid can be typed into" is ONE fact in ONE place rather than a
     * property of fifteen columns that happen to have been left incomplete.
     */
    canEdit: boolean;
}

// ─── The row shape the grid renders ──────────────────────────────────────────────

/**
 * What one rendered row carries.
 *
 * The receipt rides on BOTH families, because a draw's cells are read from its parent's
 * record and a `format`/`clipboardValue`/`numericValue` is handed only the row. `num` is
 * the receipt's 1-based position IN THE CURRENT VIEW — a fact about the sheet, not about
 * the database, which is why it is wrapped onto the row rather than looked up from `ctx`
 * (a Map on `ctx` would break `ctx`'s referential stability on every page).
 */
export interface DeliveryGridRow {
    rec: DeliveryRecord;
    /** 1-based row number in the current view. */
    num: number;
    /** The moisture draw THIS row renders, or null on the receipt row itself. */
    sample: RcDeliverySampleRow | null;
    /** The draw's 0-based position under its receipt, or -1 on the receipt row. */
    sampleIndex: number;
}

type DeliveryItem = GridRow<DeliveryGridRow>;

const dash = <span className="text-muted-foreground/40">—</span>;

/**
 * The CHILD families — a paste anchored on a moisture draw may never reach a receipt.
 * Module-level so the prop identity never changes between renders.
 */
const CHILD_KINDS: readonly string[] = ['sample'];

// ─── Data-quality rails ──────────────────────────────────────────────────────────
//
// The old ledger draws these as an inset box-shadow on the FIRST FROZEN `<td>`. The
// module owns a cell's `<td>` classes (they are a cached pure function of ten enums), so
// the rail is drawn INSIDE the `#` column's own content instead: `cell-classes.ts` makes
// the interactive layer `absolute inset-0`, which is a containing block, so an absolutely
// positioned bar inside it lands on exactly the same three pixels. Same paint, expressed
// through the seam the module actually has.
const RAIL: Record<'duplicate' | 'twin' | 'unmapped' | 'flagged', string> = {
    duplicate: 'w-[3px] bg-rose-500',
    twin: 'w-[2px] bg-rose-500/40',
    unmapped: 'w-[3px] bg-amber-500',
    flagged: 'w-[3px] bg-sky-500',
};

const BADGE =
    'inline-flex items-center rounded-sm px-1 py-0 text-[9px] font-bold uppercase leading-[14px] tracking-wide';

/** Which rail a receipt wears, or null. Same precedence as the ledger's `railClass`. */
function railFor(row: RcDeliveryRow): keyof typeof RAIL | null {
    if (row.is_suspected_duplicate) return 'duplicate';
    if (row.supplier_unresolved || row.destination_unresolved) return 'unmapped';
    if (flagSummary(row).live) return 'flagged';
    return duplicateBadge(row) ? 'twin' : null;
}

// ─── Summary-row treatments (copied verbatim from the ledger's constants) ────────

const DAY_TOTAL_CELL =
    'border-b border-border/60 border-t-2 border-t-foreground/45 bg-muted py-1 align-middle text-foreground';
const DAY_HEADER_CELL = 'h-6 border-b border-border/40 bg-muted/25 px-2 py-1';

/** Row-family → bottom rule. The ledger's `ROW_RULE`, keyed by this grid's kind names. */
const ROW_RULES: Record<string, string> = {
    delivery: 'border-b border-b-border',
    sample: 'border-b border-b-border/60',
};

// ═══ Columns — TRANSLATED from `buildColumns`, never re-declared ═════════════════
//
// `./types` owns the column table: the order, the widths, the pinned block, the summary
// lanes, the filter grammar, and — critically — WHICH COLUMNS ARE MONEY. So the specs are
// built FROM `buildColumns(canViewPrices)` rather than declared here with
// `visible: (ctx) => ctx.canViewPrices` on three of them. The module's `visible()` seam is
// the more idiomatic spelling, but using it here would create a SECOND definition of the
// price boundary, in a file the verify script does not read. One definition wins.
//
// The ₱ columns are therefore ABSENT for a gated viewer rather than blank: the keyboard
// coordinate space has no unreachable holes and the table's min-width stays honest.

/**
 * Column key → the lab column both families carry under the SAME name. That identity is
 * why one `format` can serve a receipt and a draw: `bd` on a receipt and `bd` on a draw
 * are the same reading of the same property, taken from two different samples of it.
 */
const LAB_COLUMN: Record<string, 'bd' | 'moisture_pct' | 'grit' | 'ash' | 'dust' | 'vm' | 'fc'> = {
    bd: 'bd',
    moist: 'moisture_pct',
    grit: 'grit',
    ash: 'ash',
    dust: 'dust',
    vm: 'vm',
    fc: 'fc',
};

/** A lab reading, from whichever family this row is. */
function labValue(row: DeliveryGridRow, colKey: string): number | null {
    const f = LAB_COLUMN[colKey];
    if (!f) return null;
    return num(row.sample ? row.sample[f] : row.rec.row[f]);
}

function labText(row: DeliveryGridRow, colKey: string): string {
    const f = LAB_COLUMN[colKey];
    const v = labValue(row, colKey);
    return v === null || !f ? '' : formatLab(v, labDecimals(f));
}

/** The FLAG surface, as text. Everything the popover says, in a `title`. */
function flagTitle(row: RcDeliveryRow): string | undefined {
    const state = flagSummary(row);
    if (state.flags.length === 0) return undefined;
    return state.flags
        .map((f) => `${f.resolved ? '✓ ' : '! '}${f.kind}: ${f.detail}${f.raw ? ` — the workbook wrote: ${f.raw}` : ''}${f.note ? `\n   ${f.note}` : ''}`)
        .join('\n');
}

function specFor(col: DeliveryCol): ColumnSpec<DeliveryGridRow, DeliveryGridCtx> {
    const base = {
        key: col.key,
        label: col.label,
        width: col.width,
        title: col.title,
        pin: col.pin,
        align: (col.numeric ? 'right' : 'left') as 'left' | 'right',
        summaryLane: col.summaryLane,
        // Declared even though slice 1 renders no filter control: the metadata is the
        // column's, and `./types` is where it is decided. `BlackwoodTable` has no header
        // slot to hang a trigger off yet — see the seam report in the handoff.
        filter:
            col.filterKind && col.filterColumn
                ? { kind: col.filterKind, column: col.filterColumn }
                : undefined,
        calcType: columnCalcType(col.key) ?? undefined,
        // The domain's ONE answer, asked rather than restated. `#` is out (a row ordinal
        // has no arithmetic meaning); TTL PRICE is in even though it is read-only (a run of
        // receipt totals is the most useful thing on the sheet to add up).
        selectable: isSelectableColumn(col),
        // Every field-bearing column is editable — SUBJECT TO the grid's edit gate. Slice 1
        // holds that gate closed; the declaration is the column's real rule.
        editable: col.field !== null ? (_row: DeliveryGridRow | null, ctx: DeliveryGridCtx) => ctx.canEdit : undefined,
    };

    switch (col.key) {
        case 'num':
            return {
                ...base,
                cellKind: 'derived',
                resizable: false,
                hideable: false,
                format: (row) => {
                    // A draw is a CHILD line: it shows the tree glyph, never an ordinal.
                    if (row.sample) {
                        return <span className="w-full text-center text-[10px] text-muted-foreground/40">└</span>;
                    }
                    const rail = railFor(row.rec.row);
                    return (
                        <>
                            {rail ? (
                                <span
                                    aria-hidden="true"
                                    className={cn('absolute inset-y-0 left-0', RAIL[rail])}
                                />
                            ) : null}
                            <span className="w-full text-center font-mono text-[10px] font-bold text-muted-foreground">
                                {row.num}
                            </span>
                        </>
                    );
                },
            };

        case 'date':
            return {
                ...base,
                cellKind: 'date',
                format: (row) => {
                    const r = row.rec.row;
                    const undated = !r.delivery_date && !!r.delivery_date_raw;
                    return (
                        <span
                            className="flex w-full min-w-0 items-center gap-1"
                            title={undated ? `The workbook wrote: ${r.delivery_date_raw}` : undefined}
                        >
                            <span className="truncate font-mono text-xs font-bold">
                                {r.delivery_date || dash}
                            </span>
                            {undated ? <AlertTriangle className="size-3 shrink-0 text-amber-500" /> : null}
                        </span>
                    );
                },
            };

        case 'truck':
            return {
                ...base,
                cellKind: 'text',
                format: (row) => (
                    <span className="truncate font-mono text-xs font-bold">{row.rec.row.truck_no ?? ''}</span>
                ),
            };

        case 'supplier':
            return {
                ...base,
                cellKind: 'text',
                format: (row) => {
                    // The SUPPLIER lane doubles as a draw's label lane — it is the widest
                    // frozen column, so an indented `NO MARK/SUNDRY` stays readable while
                    // the sheet scrolls sideways.
                    if (row.sample) {
                        const label = row.sample.label ?? '';
                        return (
                            <span className="flex w-full min-w-0 items-center gap-1 pl-3" title={label || undefined}>
                                <span className="shrink-0 text-[10px] text-muted-foreground/40">└</span>
                                <span className="truncate font-mono text-[11px] text-muted-foreground">
                                    {label || <span className="text-muted-foreground/40">unlabelled draw</span>}
                                </span>
                            </span>
                        );
                    }
                    const r = row.rec.row;
                    const text = formatSupplierCell(r);
                    const dup = duplicateBadge(r);
                    const flags = flagSummary(r);
                    return (
                        <span className="flex w-full min-w-0 items-center gap-1" title={text || undefined}>
                            <span className="truncate font-mono text-xs font-bold">{text || dash}</span>
                            {dup ? (
                                <span
                                    title={dup.title}
                                    className={cn(
                                        BADGE,
                                        'shrink-0',
                                        dup.role === 'copy'
                                            ? 'bg-rose-500/20 text-rose-700 dark:text-rose-400'
                                            : 'border border-rose-500/40 text-rose-700 dark:text-rose-400',
                                    )}
                                >
                                    {dup.label}
                                </span>
                            ) : null}
                            {r.supplier_unresolved ? (
                                <span className={cn(BADGE, 'shrink-0 bg-amber-500/20 text-amber-700 dark:text-amber-400')}>
                                    MAP?
                                </span>
                            ) : null}
                            {/* The old ledger opens a POPOVER here. This slice has no
                                interactive chrome, so the same facts ride in a `title` —
                                complete, and not pretending to be a button. */}
                            {flags.flags.length > 0 ? (
                                <span className="shrink-0" title={flagTitle(r)}>
                                    {flags.live ? (
                                        <AlertTriangle className="size-3 text-sky-500" aria-label="Import flag" />
                                    ) : (
                                        <History
                                            className="size-3 text-muted-foreground/40"
                                            aria-label="Flag history"
                                        />
                                    )}
                                </span>
                            ) : null}
                        </span>
                    );
                },
            };

        case 'sacks':
            return {
                ...base,
                cellKind: 'number',
                numericValue: (row) => (row.sample ? null : num(row.rec.row.sacks)),
                format: (row) => <span className="text-xs font-bold">{formatInt(row.rec.row.sacks)}</span>,
            };

        case 'wt':
            return {
                ...base,
                cellKind: 'formula',
                numericValue: (row) => (row.sample ? null : num(row.rec.row.net_weight_kg)),
                // The DB's own exact decimal, verbatim — `net_weight_kg` is STORED
                // GENERATED, and re-deriving it through a JavaScript float is precisely how
                // a payment ledger goes wrong.
                clipboardValue: (row) => clipboardNumber(row.rec.row.net_weight_kg),
                format: (row) => (
                    <span className="text-xs font-bold">{formatKg(row.rec.row.net_weight_kg) || dash}</span>
                ),
            };

        case 'bd':
        case 'moist':
        case 'grit':
        case 'ash':
        case 'dust':
        case 'vm':
        case 'fc':
            return {
                ...base,
                cellKind: 'number',
                numericValue: (row) => labValue(row, col.key),
                format: (row) =>
                    row.sample ? (
                        <span className="font-mono text-[11px] tabular-nums text-muted-foreground">
                            {labText(row, col.key)}
                        </span>
                    ) : (
                        <span className="text-xs font-bold">{labText(row, col.key)}</span>
                    ),
            };

        case 'whse':
            return {
                ...base,
                cellKind: 'text',
                format: (row) => {
                    const r = row.rec.row;
                    const text = formatDestinationCell(r);
                    return (
                        <span className="flex w-full min-w-0 items-center gap-1" title={text || undefined}>
                            <span className="truncate font-mono text-xs font-bold">{text || dash}</span>
                            {r.destination_unresolved ? (
                                <span className={cn(BADGE, 'shrink-0 bg-amber-500/20 text-amber-700 dark:text-amber-400')}>
                                    MAP?
                                </span>
                            ) : null}
                        </span>
                    );
                },
            };

        case 'remarks':
            return {
                ...base,
                cellKind: 'text',
                format: (row) => {
                    const text = row.rec.row.remarks ?? '';
                    return (
                        <span className="max-w-[200px] truncate text-xs" title={text || undefined}>
                            {text}
                        </span>
                    );
                },
            };

        case 'php_kg':
            return {
                ...base,
                cellKind: 'formula',
                numericValue: (row) => (row.sample ? null : num(row.rec.row.price_php_kg)),
                clipboardValue: (row) => clipboardNumber(row.rec.row.price_php_kg),
                // Accounting format: the ₱ pinned left, the figure pinned right.
                format: (row) => (
                    <span className="flex w-full items-center justify-between gap-1 text-xs font-bold">
                        <span className="text-muted-foreground/70">₱</span>
                        <span>{formatRate(row.rec.row.price_php_kg)}</span>
                    </span>
                ),
            };

        case 'ttl':
            return {
                ...base,
                // Never editable, but a range MAY cover it — see `isSelectableColumn`.
                cellKind: 'readonly',
                numericValue: (row) => (row.sample ? null : num(row.rec.row.total_price_php)),
                clipboardValue: (row) => clipboardNumber(row.rec.row.total_price_php),
                format: (row) => {
                    const r = row.rec.row;
                    const mismatch = r.sheet_total_matches === false;
                    return (
                        <span
                            className={cn(
                                'flex w-full items-center justify-between gap-1 text-xs font-bold',
                                mismatch && 'text-muted-foreground/60',
                            )}
                            title={
                                mismatch
                                    ? `The workbook printed ₱${formatPeso(r.sheet_total_php)} for this row.`
                                    : undefined
                            }
                        >
                            <span className="text-muted-foreground/70">₱</span>
                            <span>{formatPeso(r.total_price_php) || '0.00'}</span>
                        </span>
                    );
                },
            };

        case 'settle':
            return {
                ...base,
                cellKind: 'readonly',
                format: (row) => {
                    const settle = row.rec.settlement;
                    if (!settle) {
                        return (
                            <span
                                className="text-muted-foreground/50"
                                title="Payment state has not loaded for this receipt."
                            >
                                {dash}
                            </span>
                        );
                    }
                    const status = settlementStatus(settle.settlement_status);
                    const owed = stillOwedText(settle);
                    return (
                        <span
                            className="flex w-full min-w-0 items-center justify-between gap-1"
                            title={`${SETTLEMENT_NOTE[status]}${
                                (num(settle.allocated_php) ?? 0) > 0
                                    ? `\n\nAssigned so far: ₱${formatBalancePeso(settle.allocated_php)} from ${
                                          num(settle.allocation_count) ?? 0
                                      } payment(s).`
                                    : ''
                            }`}
                        >
                            {'peso' in owed ? (
                                <span className="flex min-w-0 flex-1 items-baseline justify-between gap-1 font-mono text-xs tabular-nums">
                                    <span className="text-muted-foreground/70">₱</span>
                                    <span className={cn(status === 'settled' && 'text-muted-foreground')}>
                                        {formatBalancePeso(owed.peso)}
                                    </span>
                                </span>
                            ) : (
                                // "not priced yet", NEVER ₱0.00 — a zero here is a claim
                                // that nothing is owed, and it is indistinguishable from
                                // the truth.
                                <span className="truncate text-[10px] leading-tight text-amber-600 dark:text-amber-400">
                                    {NOT_PRICED_TEXT}
                                </span>
                            )}
                            <span
                                className={cn(
                                    'shrink-0 rounded-sm border px-1 text-[9px] leading-tight',
                                    status === 'unpriced'
                                        ? 'border-amber-500/40 text-amber-600 dark:text-amber-400'
                                        : 'border-border/60 text-muted-foreground',
                                )}
                            >
                                {SETTLEMENT_LABEL[status]}
                            </span>
                        </span>
                    );
                },
            };

        default:
            return { ...base, cellKind: 'text', format: () => null };
    }
}

// ═══ Row families ═══════════════════════════════════════════════════════════════
//
// Two addressable families and three chrome rows. `GridRow`'s chrome variant is a closed
// union of exactly three kind names, so the day HEADING is a `group-header`, the
// `Σ DAY TOTAL` rule-off is a `summary` and the endless day gap is a `spacer` — the
// module's vocabulary for the three shapes this sheet actually has.

/**
 * A slot table built from the column table, so a column added in `./types` is covered
 * with no edit here.
 *
 * `#`, `TTL PRICE` and `PAID?` carry no `field` and are never editable, but they DO carry
 * content — so they are "occupied" with `editable: false`. That is a KNOWN divergence
 * from the old ledger and it is reported with the slice: `occupies()` answers both
 * *"does the caret have a coordinate here"* and *"does this row render content here"*, and
 * the RC Deliveries sheet needs those two answers to differ.
 */
function buildSlots(cols: readonly DeliveryCol[]) {
    const receipt = new Map<string, { field: string; editable: boolean }>();
    const draw = new Map<string, { field: string; editable: boolean }>();

    for (const col of cols) {
        receipt.set(col.key, { field: col.field ?? col.key, editable: col.field !== null });
        if (col.key === 'num') {
            // The tree glyph. Content, never a coordinate the operator can type into.
            draw.set(col.key, { field: 'num', editable: false });
            continue;
        }
        const sf = sampleFieldFor(col.field);
        if (sf !== null) draw.set(col.key, { field: sf, editable: true });
    }
    return { receipt, draw };
}

// ═══ The flatten ════════════════════════════════════════════════════════════════

/** What a chrome row renders. Keyed by the item's own `key`. */
type ChromePayload =
    | { kind: 'day'; label: string; count: number }
    | { kind: 'day-total'; netKg: number; php: number; dupNetKg: number; dupPhp: number }
    | { kind: 'day-gap' };

interface MonthTotals {
    count: number;
    netKg: number;
    php: number;
    dupCount: number;
    dupNetKg: number;
    dupPhp: number;
}

interface Flattened {
    items: DeliveryItem[];
    chrome: Map<string, ChromePayload>;
    monthTotals: MonthTotals;
}

function formatDayHeading(iso: string): string {
    const d = parseISO(iso);
    return isValid(d) ? formatDateFns(d, 'EEEE · yyyy-MM-dd').toUpperCase() : iso;
}

/**
 * Records → the flat item array, and the ONE place the shape of the sheet is decided.
 *
 * The focus scope groups days with a heading and a `Σ DAY TOTAL` rule-off; the endless
 * scope deliberately has neither and marks a day boundary with a literal BLANK ROW
 * instead (`needsDaySpacer` in `./types` is the single rule, and `prevDate === undefined`
 * is the whole of "never a leading gap at the top of the sheet").
 */
function flatten(records: readonly DeliveryRecord[], scope: 'endless' | 'focus'): Flattened {
    const items: DeliveryItem[] = [];
    const chrome = new Map<string, ChromePayload>();
    const monthTotals: MonthTotals = { count: 0, netKg: 0, php: 0, dupCount: 0, dupNetKg: 0, dupPhp: 0 };

    // Counted once up front — a `filter` inside the row loop would make this quadratic.
    const dayCounts = new Map<string, number>();
    for (const r of records) {
        const d = r.row.delivery_date ?? '';
        dayCounts.set(d, (dayCounts.get(d) ?? 0) + 1);
    }

    let currentDay = '';
    /**
     * The date of the row ABOVE — `undefined` until the first receipt has been emitted.
     * Held separately from `currentDay` because `''` is a REAL value here: it is what an
     * undated receipt normalises to, and the undated group sits at the head of history
     * (canonical order is `delivery_date ASC NULLS FIRST, id ASC`).
     */
    let prevDate: string | undefined;
    let dayNet = 0;
    let dayPhp = 0;
    let dayDupNet = 0;
    let dayDupPhp = 0;
    let dayCount = 0;
    let rowNum = 0;

    const closeDay = () => {
        if (scope !== 'focus' || dayCount === 0) return;
        const key = `total:${currentDay}`;
        items.push({ kind: 'summary', key });
        chrome.set(key, {
            kind: 'day-total',
            netKg: dayNet,
            php: dayPhp,
            dupNetKg: dayDupNet,
            dupPhp: dayDupPhp,
        });
        dayNet = 0;
        dayPhp = 0;
        dayDupNet = 0;
        dayDupPhp = 0;
        dayCount = 0;
    };

    for (const rec of records) {
        const row = rec.row;
        const id = row.id ?? '';
        const date = row.delivery_date ?? '';

        if (scope === 'focus' && date !== currentDay) {
            closeDay();
            currentDay = date;
            const key = `day:${date || 'undated'}`;
            items.push({ kind: 'group-header', key });
            chrome.set(key, {
                kind: 'day',
                label: date ? formatDayHeading(date) : 'Undated — the workbook’s date could not be read',
                count: dayCounts.get(date) ?? 0,
            });
        }

        if (scope === 'endless' && needsDaySpacer(prevDate, date)) {
            const key = `gap:${id}`;
            items.push({ kind: 'spacer', key });
            chrome.set(key, { kind: 'day-gap' });
        }
        prevDate = date;

        rowNum++;
        items.push({ kind: 'delivery', id, data: { rec, num: rowNum, sample: null, sampleIndex: -1 } });

        const net = num(row.net_weight_kg) ?? 0;
        const php = num(row.total_price_php) ?? 0;
        monthTotals.count++;
        monthTotals.netKg += net;
        monthTotals.php += php;
        dayCount++;
        dayNet += net;
        dayPhp += php;
        if (row.is_suspected_duplicate) {
            monthTotals.dupCount++;
            monthTotals.dupNetKg += net;
            monthTotals.dupPhp += php;
            dayDupNet += net;
            dayDupPhp += php;
        }

        rec.samples.forEach((s, i) => {
            items.push({
                kind: 'sample',
                // `${deliveryId}#${index}` — the draw's identity for the edit map, the
                // journal and (slice 2) the save. Note `addSample` inserts AFTER an index,
                // so these keys renumber below an insertion; that is slice 2's problem and
                // is called out in the handoff.
                id: `${id}#${i}`,
                data: { rec, num: rowNum, sample: s, sampleIndex: i },
            });
        });
    }
    closeDay();

    return { items, chrome, monthTotals };
}

// ═══ Canonical cell text ════════════════════════════════════════════════════════

/**
 * What a receipt cell holds — the text a FOCUSED cell would show, which for the two
 * formula lanes is the FORMULA and not the figure.
 *
 * A near-copy of `canonicalEditText` in `deliveries-ledger.tsx`, which is module-private
 * there. It is duplicated rather than exported because the ledger may not be edited while
 * both grids are alive; at cutover the ledger goes and this becomes the only copy.
 */
function receiptText(r: RcDeliveryRow, field: string): string {
    switch (field) {
        case 'delivery_date': return r.delivery_date ?? '';
        case 'truck_no': return r.truck_no ?? '';
        case 'supplier': return formatSupplierCell(r);
        case 'sacks': return formatInt(r.sacks);
        case 'wt': return weightEditText(r);
        case 'price': return priceEditText(r);
        case 'destination': return formatDestinationCell(r);
        case 'remarks': return r.remarks ?? '';
        // Not editable, but NOT empty either. `storedText` is what the jump keys read to
        // decide whether a cell is FILLED, so returning '' here would make a column of
        // computed totals read as a blank gap to Ctrl+Arrow.
        case 'ttl': return clipboardNumber(r.total_price_php);
        default: {
            const v = r[field as keyof RcDeliveryRow];
            return v === null || v === undefined ? '' : String(v);
        }
    }
}

function drawText(s: RcDeliverySampleRow, field: string): string {
    if (field === 'num') return '└';
    if (field === 'label') return s.label ?? '';
    const v = s[field as keyof RcDeliverySampleRow];
    return v === null || v === undefined ? '' : String(v);
}

// ═══ The component ══════════════════════════════════════════════════════════════

export function DeliveriesGridV2(props: DeliveriesLedgerProps) {
    const {
        scope,
        initialPage,
        monthRecords,
        anchor,
        issue,
        query,
        filters,
        canViewPrices,
        loadError,
    } = props;

    // ── Data ─────────────────────────────────────────────────────────────────────
    const lens = React.useMemo(() => ({ issue, query, filters }), [issue, query, filters]);
    const win = useDeliveriesWindow(
        initialPage ?? { records: [], hasOlder: false, hasNewer: false, totalCount: null },
        lens,
    );
    const records = React.useMemo(
        () => (scope === 'endless' ? win.records : (monthRecords ?? [])),
        [scope, win.records, monthRecords],
    );

    const { items, chrome, monthTotals } = React.useMemo(
        () => flatten(records, scope),
        [records, scope],
    );

    // ── Columns and families ─────────────────────────────────────────────────────
    const cols = React.useMemo(() => buildColumns(canViewPrices), [canViewPrices]);
    const specs = React.useMemo(() => cols.map(specFor), [cols]);

    const kinds = React.useMemo<ReadonlyMap<string, RowKind<DeliveryGridRow>>>(() => {
        const { receipt, draw } = buildSlots(cols);
        return new Map<string, RowKind<DeliveryGridRow>>([
            ['delivery', {
                kind: 'delivery',
                height: ROW_H,
                addressable: true,
                occupies: (colKey) => receipt.get(colKey) ?? null,
            }],
            ['sample', {
                kind: 'sample',
                height: SAMPLE_ROW_H,
                addressable: true,
                occupies: (colKey) => draw.get(colKey) ?? null,
            }],
            // Chrome. None of the three is addressable, so none of them enters `navRows`
            // and the keyboard coordinate space is byte-identical with and without them.
            ['group-header', { kind: 'group-header', height: 24, addressable: false, occupies: () => null }],
            ['summary', { kind: 'summary', height: 28, addressable: false, occupies: () => null }],
            ['spacer', { kind: 'spacer', height: DAY_SPACER_ROW_H, addressable: false, occupies: () => null }],
        ]);
    }, [cols]);

    // `ctx` MUST be referentially stable — it is a dependency of the column resolution, of
    // every editability verdict and of every cell's `format`.
    const ctx = React.useMemo<DeliveryGridCtx>(
        () => ({ canViewPrices, canEdit: false }),
        [canViewPrices],
    );

    // ── Cell text ────────────────────────────────────────────────────────────────
    const byRowId = React.useMemo(() => {
        const m = new Map<string, DeliveryGridRow>();
        for (const it of items) if ('data' in it) m.set(it.id, it.data);
        return m;
    }, [items]);

    /**
     * What a cell HOLDS, as text. Read by the jump keys (`filled`), by a COPY that has no
     * `clipboardValue` on its column, and — once slice 2 opens an editor — by the editor's
     * initial value, which is why the two formula lanes return the FORMULA.
     *
     * The two DERIVED columns are answered here rather than in `receiptText` because their
     * value is not on the receipt row at all: `#` is a position in the current view and
     * `PAID?` comes from the settlement row riding alongside it.
     */
    const storedText = React.useCallback(
        (rowId: string, field: string): string => {
            const row = byRowId.get(rowId);
            if (!row) return '';
            if (field === 'num') return row.sample ? '' : String(row.num);
            if (field === 'settle') {
                const s = row.rec.settlement;
                // The one WORD, never the ₱ figure — a derived column is not a place to
                // put money on the clipboard.
                return s ? SETTLEMENT_LABEL[settlementStatus(s.settlement_status)] : '';
            }
            return row.sample ? drawText(row.sample, field) : receiptText(row.rec.row, field);
        },
        [byRowId],
    );

    // Slice 1 has no drafts and writes nothing, but the module needs its single writer:
    // `cellText` is what the jump keys read, and `edits` is what a cell renders over its
    // stored value once slice 2 turns editing on.
    const noDrafts = React.useCallback(() => false, []);
    const edits = useTableEdits({ canonicalText: storedText, isDraft: noDrafts });

    // ── The pager's PUBLIC index base ────────────────────────────────────────────
    //
    // `useDeliveriesWindow` owns a `firstItemIndex` of its own and decrements it by the
    // number of RECORDS prepended — but the flat array grows by MORE than that (a receipt
    // brings its moisture draws, and a day boundary brings a spacer), so its base is short
    // by exactly the difference and a scroll-up drifts. That is a pre-existing bug in a
    // file this slice may not edit, so the correction is made HERE, at the call site.
    //
    // It is a pure DERIVATION rather than a second piece of pager state, which is stronger
    // than the "one state batch" rule the prop asks for: the prepended items and the new
    // base are produced by the SAME render, so they cannot be committed separately.
    //
    // The measurement is "how many items sit ABOVE a fixed anchor row", not `items.length`
    // — because the array also grows when `fetchNewer` APPENDS, and rebasing after an
    // append would shove the viewport upwards by the rows added at the far end.
    const [pagerAnchor, setPagerAnchor] = React.useState<{ id: string; itemsAbove: number } | null>(null);

    React.useEffect(() => {
        if (scope !== 'endless') return;
        if (pagerAnchor && items.some((it) => 'id' in it && it.id === pagerAnchor.id)) return;
        // First paint, or the window was reset/re-anchored under us: take the first receipt
        // as the new origin and start the base over, exactly as the window hook does.
        const at = items.findIndex((it) => it.kind === 'delivery');
        setPagerAnchor(at >= 0 ? { id: (items[at] as { id: string }).id, itemsAbove: at } : null);
    }, [items, pagerAnchor, scope]);

    const firstItemIndex = React.useMemo(() => {
        if (scope !== 'endless' || !pagerAnchor) return DEFAULT_FIRST_ITEM_INDEX;
        const at = items.findIndex((it) => 'id' in it && it.id === pagerAnchor.id);
        if (at < 0) return DEFAULT_FIRST_ITEM_INDEX;
        return shiftFirstItemIndex({
            firstItemIndex: DEFAULT_FIRST_ITEM_INDEX,
            previousItemCount: pagerAnchor.itemsAbove,
            nextItemCount: at,
        });
    }, [items, pagerAnchor, scope]);

    // Open on the NEWEST RECEIPT. A LAZY `useState` initialiser rather than a ref written
    // during render: it runs exactly once, on mount, against the server-seeded window —
    // which is the only window this value is ever allowed to describe.
    //
    // RAW array position, never rebased by `firstItemIndex`. `initialTopMostItemIndex`
    // clamps against `totalCount`, so a rebased index resolves to the last row every time.
    const [initialTop] = React.useState<number | undefined>(() => {
        if (scope !== 'endless') return undefined;
        if (anchor.kind !== 'latest') return 0;
        for (let i = items.length - 1; i >= 0; i--) {
            if (items[i].kind === 'delivery' || items[i].kind === 'sample') return i;
        }
        return 0;
    });

    // ── Chrome rows — cells, never a `<tr>` ──────────────────────────────────────
    const renderChromeRow = React.useCallback(
        (item: DeliveryItem, api: TableChromeRowApi<DeliveryGridRow, DeliveryGridCtx>): React.ReactNode => {
            if (!('key' in item)) return null;
            const payload = chrome.get(item.key);
            if (!payload) return null;

            // The endless day boundary: an ACTUAL empty row of the spreadsheet, not an
            // effect between rows. ONE `<td>` PER COLUMN rather than a spanning cell —
            // that is what carries the vertical rules through it — and the frozen block
            // behaves exactly like a data row's: sticky, cumulative `left`, and FULLY
            // OPAQUE, or the scrolling rows bleed through the pinned columns at the gap.
            if (payload.kind === 'day-gap') {
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
                                        'border-r border-r-border border-b border-b-border p-0 align-middle',
                                        frozen && 'frozen-col bg-background',
                                        frozen && ci === left.length - 1 && 'frozen-edge',
                                    )}
                                    style={{
                                        height: DAY_SPACER_ROW_H,
                                        ...(frozen ? { left: left[ci] } : {}),
                                    }}
                                />
                            );
                        })}
                    </>
                );
            }

            if (payload.kind === 'day') {
                return (
                    <td colSpan={api.colCount} className={DAY_HEADER_CELL}>
                        <span className="font-mono text-[11px] font-bold uppercase tracking-wide text-muted-foreground">
                            {payload.label}
                            <span className="ml-2 font-normal normal-case text-muted-foreground/60">
                                {payload.count} receipt{payload.count === 1 ? '' : 's'}
                            </span>
                        </span>
                    </td>
                );
            }

            // Σ DAY TOTAL. The lanes come off the RESOLVED column table (`api.spans`), so
            // a hidden ₱ column or a column inserted anywhere moves the figures with it.
            // A lane of span 0 renders NO cell — `colSpan={0}` means "to the end of the
            // column group" in HTML, which is the opposite of nothing.
            const s = api.spans;
            return (
                <>
                    <td colSpan={s.label} className={cn(DAY_TOTAL_CELL, 'px-2')}>
                        <span className="font-mono text-[11px] font-bold uppercase tracking-wide">Σ Day total</span>
                    </td>
                    {s.weight > 0 ? (
                        <td
                            colSpan={s.weight}
                            className={cn(DAY_TOTAL_CELL, 'px-2 text-right font-mono text-[11px] font-bold tabular-nums')}
                        >
                            {formatKg(payload.netKg)}
                        </td>
                    ) : null}
                    {s.note > 0 ? (
                        <td colSpan={s.note} className={cn(DAY_TOTAL_CELL, 'px-2')}>
                            {payload.dupNetKg > 0 ? (
                                <span className="font-mono text-[10px] font-medium text-rose-600 dark:text-rose-400">
                                    includes {formatKg(payload.dupNetKg)} kg
                                    {canViewPrices ? ` / ₱${formatPeso(payload.dupPhp)}` : ''} from suspected duplicates
                                </span>
                            ) : null}
                        </td>
                    ) : null}
                    {/* The CELL follows its column so the row always tiles; the FIGURE
                        keeps its own `canViewPrices` gate, belt and braces. */}
                    {s.total > 0 ? (
                        <td colSpan={s.total} className={cn(DAY_TOTAL_CELL, 'px-2')}>
                            {canViewPrices ? (
                                <span className="flex w-full items-center justify-between gap-1 font-mono text-[11px] font-bold tabular-nums">
                                    <span className="text-muted-foreground/70">₱</span>
                                    <span>{formatPeso(payload.php)}</span>
                                </span>
                            ) : null}
                        </td>
                    ) : null}
                    {s.trailing > 0 ? <td colSpan={s.trailing} className={DAY_TOTAL_CELL} /> : null}
                </>
            );
        },
        [chrome, canViewPrices],
    );

    // ── The sticky month footer (focus scope only) ───────────────────────────────
    const summaryRows = React.useMemo<TableSummaryRow[] | undefined>(() => {
        if (scope !== 'focus') return undefined;
        return [
            {
                key: 'month',
                sticky: true,
                label: (
                    <span className="font-mono text-[11px] font-bold uppercase tracking-wide">
                        Σ Month · {monthTotals.count} receipts
                    </span>
                ),
                figure: formatKg(monthTotals.netKg),
                note:
                    monthTotals.dupCount > 0 ? (
                        <span className="font-mono text-[10px] font-medium text-rose-600 dark:text-rose-400">
                            {monthTotals.dupCount} suspected duplicate{monthTotals.dupCount === 1 ? '' : 's'} included —{' '}
                            {formatKg(monthTotals.dupNetKg)} kg
                            {canViewPrices ? ` / ₱${formatPeso(monthTotals.dupPhp)}` : ''}
                        </span>
                    ) : undefined,
                total: canViewPrices ? (
                    <span className="flex w-full items-center justify-between gap-1">
                        <span className="text-muted-foreground/70">₱</span>
                        <span>{formatPeso(monthTotals.php)}</span>
                    </span>
                ) : undefined,
            },
        ];
    }, [scope, monthTotals, canViewPrices]);

    // ── Row washes ───────────────────────────────────────────────────────────────
    const rowClassFor = React.useCallback((item: DeliveryItem): string | undefined => {
        if (item.kind === 'delivery' && 'data' in item) {
            return cn(
                'group transition-colors duration-150 hover:bg-muted',
                item.data.rec.row.is_suspected_duplicate && 'bg-rose-500/[0.05]',
            );
        }
        if (item.kind === 'sample') return 'group bg-muted/20 transition-colors duration-150 hover:bg-muted/40';
        return undefined;
    }, []);

    // Destructured, never held as the container: `useDeliveriesWindow` returns a FRESH
    // object every render while its individual members are `useCallback`'d and stable, so
    // depending on `win` would hand the virtualiser a new edge callback per render. Same
    // structural rule the React half of the module runs on.
    const { fetchOlder, fetchNewer } = win;
    const startReached = React.useCallback(() => void fetchOlder(), [fetchOlder]);
    const endReached = React.useCallback(() => void fetchNewer(), [fetchNewer]);

    // ═══ Render ══════════════════════════════════════════════════════════════════
    return (
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
            {/* A solid token, not glass: this strip is `shrink-0` in a flex column, not a
                fixed or sticky surface, and a `backdrop-filter` over an opaque page paints
                nothing while still costing a compositor layer. */}
            <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border bg-muted/40 px-3 py-1 text-[11px] text-muted-foreground">
                <span className="rounded-sm border border-amber-500/40 px-1 font-medium text-amber-600 dark:text-amber-400">
                    grid=v2
                </span>
                <span>
                    Read-only preview of the Blackwood Table rewire — no editing, no save, no filters, no row
                    menu. The live ledger is at the same URL without <code>?grid=v2</code>.
                </span>
                <span className="font-mono">
                    {monthTotals.count} receipt{monthTotals.count === 1 ? '' : 's'}
                    {win.totalCount !== null && scope === 'endless' ? ` of ${win.totalCount}` : ''}
                </span>
            </div>

            {loadError ? (
                // Inline error, per the HARD RULE: it persists until dismissed and it can
                // be copied. There is no toast here — nothing in this slice raises one.
                <div className="flex shrink-0 items-start gap-2 border-b border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
                    <span className="min-w-0 flex-1 whitespace-pre-wrap break-words">{loadError}</span>
                    <button
                        type="button"
                        onClick={() => void navigator.clipboard.writeText(loadError)}
                        className="shrink-0 rounded border border-destructive/40 px-1.5 py-0.5 font-medium transition-colors duration-150 hover:bg-destructive/15"
                    >
                        Copy
                    </button>
                </div>
            ) : null}

            <BlackwoodTable<DeliveryGridRow, DeliveryGridCtx>
                items={items}
                kinds={kinds}
                specs={specs}
                ctx={ctx}
                edits={edits}
                storedText={storedText}
                scope={scope}
                childKinds={CHILD_KINDS}
                rowRules={ROW_RULES}
                rowClassFor={rowClassFor}
                renderChromeRow={renderChromeRow}
                summaryRows={summaryRows}
                firstItemIndex={scope === 'endless' ? firstItemIndex : undefined}
                initialTopMostItemIndex={initialTop}
                startReached={scope === 'endless' ? startReached : undefined}
                endReached={scope === 'endless' ? endReached : undefined}
                emptyMessage="No receipts match this view."
                className="min-h-0 flex-1"
            />
        </div>
    );
}
