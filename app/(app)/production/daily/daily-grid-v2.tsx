'use client';

import * as React from 'react';
import { ChevronDown, ChevronUp, ListFilter } from 'lucide-react';

import { BlackwoodTable } from '@/components/shared/table';
import type { TableState, TableSummaryRow } from '@/components/shared/table';
import type { CellSlot, ColumnSpec, GridRow, RowKind, TableSettings } from '@/lib/table';
import { useTableEdits } from '@/lib/hooks/use-table-edits';
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuLabel,
    DropdownMenuRadioGroup,
    DropdownMenuRadioItem,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';

// The ROW MODEL is imported, never restated. `buildGridRows` is the ONE definition of how
// shifts + runs + downtime + waste become ledger rows — which shift owns the downtime,
// which run is PRIMARY, how the M→E→N tiebreak works. Restating it here would be a second
// definition of the sheet, and the two sides would drift the first time one was touched.
// `import` does not modify the file it reads, and the live grid is left untouched.
import { buildGridRows, type GridRow as LedgerRow } from './daily-ledger-grid';
// The same discipline one level down: DT TTL / PROD HRS / TTL WASTE / PROD LOSS come from
// the pure helper the mobile card already shares with the live grid.
import { deriveDailyMetrics } from './ledger-derive';
import type {
    ProductionShiftRow,
    ProductionRunRow,
    ProductionDowntimeRow,
    ProductionWasteRow,
} from './actions';

// ═════════════════════════════════════════════════════════════════════════════════
// Daily ledger — the SAME rows, on the platform's Blackwood Table.
//
// Universal-table migration, built BESIDE `daily-ledger-grid.tsx` and reachable only at
// `/production?grid=v2` (the strangler-fig method —
// `handoffs/2026-08-17-universal-table-phase-1-and-the-side-by-side-method.md`). The live
// ledger is production and is not edited by one character; this file can be deleted to
// revert.
//
// ── READ-ONLY, AND STRUCTURALLY SO ──────────────────────────────────────────────
// **No `ColumnSpec` here declares `parse` or `editable`.** `columnAcceptsEdit` therefore
// answers false for every column, and `isEditable` — the ONE place the row's answer and
// the column's are combined — can never be true. That takes out the whole write surface
// in one fact: nothing opens an editor, Delete clears nothing, a paste lands nowhere.
// There is no `renderEditor`, no draft pool, no context menu, and `./actions` is imported
// for its TYPES only (`import type`, erased at compile time).
//
// The row families still declare each slot's HONEST `editable`, because that is the ROW's
// half of the verdict and it is what a later editing pass builds on. The two halves are
// ANDed, never ORed, so an honest `true` here stays inert while the column says no.
//
// ── THE TWO ROW FAMILIES, AND WHY THEY ARE TWO ──────────────────────────────────
// A shift can have several runs (grades). Downtime and waste are 1:1 with the SHIFT, so
// the live grid puts them on the shift's PRIMARY run row and leaves them blank on the
// others. That is not "an empty cell" — the secondary row HAS NO CELL THERE, which is
// exactly the question `occupies()` exists to answer and exactly the granularity whose
// absence was BUG-024. So:
//
//   • `run-primary`   occupies all 23 columns.
//   • `run-secondary` occupies the identity + production columns and returns **null** for
//     every downtime and waste column — so the keyboard steps over them, a rectangle does
//     not total them, and no tint is painted on them.
//
// The identity lanes (DATE / BATCH / SHIFT) are the middle answer: a secondary row RENDERS
// the live grid's `↑` there and the caret never stops on it (`addressable: false`).
//
// ── WHAT IS DELIBERATELY NOT HERE ───────────────────────────────────────────────
// The trailing blank input row, Save / Discard, the right-click row menu (insert /
// duplicate / add grade row / delete), the date-picker cell, the remarks + downtime-reason
// popover editors, and the footer's Σ↔x̄ toggle pills. Every one is a write path or the
// chrome of one; the pills are display state the four-lane summary row cannot carry
// separately. Nothing is stubbed: what is not built is not rendered.
// ═════════════════════════════════════════════════════════════════════════════════

/** Row height, and the module measures nothing — the live grid's 28px. */
const ROW_H = 28;

/** Fixed viewport, matching the live ledger's `max-h-[70dvh]` scroll box. */
const GRID_HEIGHT = 'h-[70dvh]';

/** The header filters' "no filter" sentinel — the live grid's own spelling. */
const ALL = 'ALL';

/**
 * One rendered row: a ledger row plus its ORDINAL.
 *
 * `format(row, ctx)` sees the row and nothing else — deliberately, since a row index is
 * not a property of a row. The `#` column needs one, so it rides on the row where every
 * other displayed fact does, rather than being smuggled in through `ctx` (which is shared
 * by the whole sheet and must stay referentially stable).
 */
interface DailyRow extends LedgerRow {
    _ord: number;
}

interface DailyCtx {
    /** Reserved for a future density switch; present so `Ctx` is never `unknown`. */
    readonly dense: boolean;
}

const CTX: DailyCtx = { dense: true };

// ═══ Formatters — the live grid's own, so the two sides read identically ════════

function formatKg(value: number | string | null | undefined, decimals = 0): string {
    if (value === null || value === undefined || value === '') return '';
    const n = typeof value === 'string' ? parseFloat(value) : value;
    if (Number.isNaN(n)) return '';
    return n.toLocaleString('en-US', {
        minimumFractionDigits: decimals,
        maximumFractionDigits: decimals,
    });
}

/** A centred lane. `cell-classes` only knows `align: 'right'`, so centring is the cell's. */
function Centre({ children }: { children: React.ReactNode }) {
    return <span className="block w-full truncate text-center">{children}</span>;
}

/** The live grid's `↑` — "this row's identity is the row above". */
const CARRY = <span className="block w-full text-center font-mono text-[10px] text-muted-foreground/40">↑</span>;

/** A waste / downtime figure lane: same formatter, same blank-on-zero rule, ten times. */
function numberCol(
    key: string,
    label: string,
    field: keyof LedgerRow,
    width: number,
    opts: { decimals?: number; title?: string } = {},
): ColumnSpec<DailyRow, DailyCtx> {
    return {
        key,
        label,
        title: opts.title,
        width,
        align: 'right',
        // A two-WORD label at 52–60px has no chance on one line: `DT HRS` is six characters
        // at `text-[11px]` uppercase (~46px) against 52 − 17 = 35, so it read `DT H…`.
        // Wrapping costs nothing on the one-word waste lanes (`RS1A`, `BF`, `GRIT`) and is
        // the difference between a name and an abbreviation of an abbreviation on the rest.
        headerWrap: true,
        cellKind: 'number',
        calcType: 'SUM',
        numericValue: (r) => {
            const v = parseFloat(String(r[field] ?? ''));
            return Number.isNaN(v) ? null : v;
        },
        clipboardValue: (r) => String(r[field] ?? ''),
        format: (r) => formatKg(String(r[field] ?? ''), opts.decimals ?? 0),
    };
}

/** The same lane, but showing the stored text verbatim — see DT HRS / DT MIN below. */
function rawNumberCol(
    key: string,
    label: string,
    field: keyof LedgerRow,
    width: number,
    title?: string,
): ColumnSpec<DailyRow, DailyCtx> {
    return {
        ...numberCol(key, label, field, width, { title }),
        format: (r) => String(r[field] ?? ''),
    };
}

// ═══ Columns — the live ledger's 23, re-measured for THIS cell ══════════════════
//
// The widths started as the live ledger's, and several were wrong here for a reason that
// does not appear in a diff: the live grid pads its cells `px-1`, the module pads `px-2`
// and reserves a 1px selection-box gutter on all four sides. **Usable width is
// `declared − 18`** in a body cell and `declared − 17` in a header — and a FILTERED header
// gives up another 16 to the trigger it sits beside. Two-word labels therefore wrap
// (`ColumnSpec.headerWrap`, bounded at two lines) and the three filtered lanes are widened,
// because `CUSTOMER` has no space to break at. Nothing is narrowed.

const COLUMNS: ColumnSpec<DailyRow, DailyCtx>[] = [
    {
        key: 'num',
        label: '#',
        width: 28,
        pin: 'start',
        align: 'center',
        cellKind: 'derived',
        resizable: false,
        hideable: false,
        format: (r) => (
            <span className="block w-full text-center font-mono text-[10px] text-muted-foreground">
                {r._ord}
            </span>
        ),
    },
    {
        key: 'date',
        label: 'DATE',
        width: 96,
        pin: 'start',
        align: 'center',
        cellKind: 'date',
        // COLLISION (2026-08-20). This column already carries the consumer's own sort
        // chevron in `renderHeaderSlot`, and the built-in caret is the same gesture drawn
        // with the same lucide glyph — two identical controls in one header, doing two
        // different things (this one re-sorts the DAY GROUPS and their carry-down rows;
        // the built-in re-sorts the flat row list and hides the chrome rows while it is
        // on). One control per question: the consumer's stays, the built-in is off.
        sortable: false,
        clipboardValue: (r) => r.date,
        format: (r) => (r._isPrimary ? <Centre><span className="font-mono">{r.date}</span></Centre> : CARRY),
    },
    {
        key: 'batch',
        label: 'BATCH',
        width: 64,
        pin: 'start',
        align: 'center',
        cellKind: 'text',
        clipboardValue: (r) => r.batch,
        format: (r) =>
            r._isPrimary ? (
                <Centre><span className="font-mono font-semibold uppercase">{r.batch}</span></Centre>
            ) : (
                CARRY
            ),
    },
    {
        key: 'shift_code',
        label: 'SHIFT',
        // A FILTERED header is not the same width problem as an unfiltered one: the label
        // shares its cell with a `shrink-0` filter trigger, so its budget is
        // `width − 17 − 4 (gap) − 12 (icon)`. At 52 that is 19px for a five-character
        // word, and `SHIFT` rendered as `S…` with a funnel beside it.
        width: 68,
        pin: 'start',
        align: 'center',
        cellKind: 'text',
        // COLLISION (2026-08-20): the consumer's `ColumnFilterSlot` here draws the SAME
        // `ListFilter` glyph the built-in trigger draws, so the header showed two
        // identical funnels opening two different panels. It is also what the width
        // comment above is measured against — a second trigger puts `SHIFT` back to `S…`.
        filterable: false,
        format: (r) =>
            r._isPrimary ? (
                <Centre><span className="font-mono font-semibold uppercase">{r.shift_code}</span></Centre>
            ) : (
                CARRY
            ),
    },
    {
        key: 'customer',
        label: 'CUSTOMER',
        // Eight characters (~61px) against 72 − 33 = 39 once the filter trigger is
        // accounted for. Widened rather than wrapped: `CUSTOMER` has no space to break at,
        // so wrapping would split it mid-word.
        width: 100,
        pin: 'start',
        align: 'center',
        cellKind: 'text',
        // COLLISION — same as SHIFT above: a consumer funnel and a built-in funnel.
        filterable: false,
        format: (r) => (
            <Centre><span className="font-mono font-semibold uppercase">{r.customer}</span></Centre>
        ),
    },
    {
        key: 'grade',
        label: 'GRADE',
        // Same filter-trigger arithmetic as SHIFT, and the same no-space-to-break-at
        // reason for widening instead of wrapping.
        width: 80,
        pin: 'start',
        align: 'center',
        cellKind: 'text',
        // COLLISION — same as SHIFT above: a consumer funnel and a built-in funnel.
        filterable: false,
        format: (r) => (
            <Centre><span className="font-mono font-semibold uppercase">{r.grade}</span></Centre>
        ),
    },
    {
        key: 'ttl_kg',
        label: 'TTL KG',
        title: 'Total output for this run (kg)',
        width: 80,
        headerWrap: true,
        pin: 'start',
        align: 'right',
        cellKind: 'number',
        calcType: 'SUM',
        numericValue: (r) => {
            const v = parseFloat(r.ttl_kg);
            return Number.isNaN(v) ? null : v;
        },
        clipboardValue: (r) => r.ttl_kg,
        format: (r) => <span className="font-semibold">{formatKg(r.ttl_kg)}</span>,
    },
    {
        key: 'run_remarks',
        label: 'REM',
        title: 'Run remarks',
        width: 200,
        pin: 'start',
        align: 'left',
        cellKind: 'text',
        clipboardValue: (r) => r.run_remarks,
        // The live grid hides this behind a message icon and a popover. A popover is an
        // editor, so the 200px lane shows the remark ITSELF, truncated, with the full text
        // on the browser's own tooltip. Nothing is hidden — only uneditable.
        format: (r) =>
            r.run_remarks ? (
                <span title={r.run_remarks} className="block w-full truncate">
                    {r.run_remarks}
                </span>
            ) : null,
    },

    // ── Downtime ────────────────────────────────────────────────────────────────
    // DT HRS / DT MIN render RAW, not through `formatKg`, because the live grid does:
    // its display value is the stored string. `formatKg(x, 0)` would round a fractional
    // `3.5` to `4` and quietly show a different number than the sheet next door.
    rawNumberCol('dt_hrs', 'DT HRS', 'dt_hrs', 52, 'Downtime — whole hours'),
    rawNumberCol('dt_mins', 'DT MIN', 'dt_mins', 52, 'Downtime — minutes'),
    {
        key: 'dt_ttl',
        label: 'DT TTL',
        title: 'DT HRS + DT MIN ÷ 60 (hours)',
        width: 60,
        headerWrap: true,
        align: 'right',
        // Computed: never editable, and a rectangle MAY still cover it.
        cellKind: 'readonly',
        selectable: true,
        calcType: 'SUM',
        numericValue: (r) => {
            const m = deriveDailyMetrics(r);
            return m.dtHrs > 0 || m.dtMins > 0 ? m.dtTtl : null;
        },
        clipboardValue: (r) => {
            const m = deriveDailyMetrics(r);
            return m.dtHrs > 0 || m.dtMins > 0 ? m.dtTtl.toFixed(2) : '';
        },
        format: (r) => {
            const m = deriveDailyMetrics(r);
            return m.dtHrs > 0 || m.dtMins > 0 ? (
                <span className="font-semibold text-amber-700 dark:text-amber-300">
                    {m.dtTtl.toFixed(2)}
                </span>
            ) : null;
        },
        summaryLane: 'figure',
    },
    {
        key: 'prod_hrs',
        label: 'PROD HRS',
        title: '8h shift − DT TTL (hours)',
        width: 64,
        headerWrap: true,
        align: 'right',
        cellKind: 'readonly',
        selectable: true,
        calcType: 'SUM',
        numericValue: (r) => deriveDailyMetrics(r).prodHrs,
        clipboardValue: (r) => deriveDailyMetrics(r).prodHrs.toFixed(2),
        format: (r) => (
            <span className="font-semibold text-amber-700 dark:text-amber-300">
                {deriveDailyMetrics(r).prodHrs.toFixed(2)}
            </span>
        ),
    },
    {
        key: 'dt_reason',
        label: 'DT REASON',
        title: 'Downtime reason',
        width: 120,
        align: 'left',
        cellKind: 'text',
        clipboardValue: (r) => r.dt_reason,
        format: (r) =>
            r.dt_reason ? (
                <span title={r.dt_reason} className="block w-full truncate">
                    {r.dt_reason}
                </span>
            ) : null,
    },

    // ── Waste ───────────────────────────────────────────────────────────────────
    {
        key: 'prod_loss',
        label: 'PROD LOSS',
        title: 'TTL WASTE ÷ (TTL KG + TTL WASTE)',
        width: 64,
        headerWrap: true,
        align: 'right',
        cellKind: 'readonly',
        selectable: true,
        // No `calcType`, exactly as the live grid: averaging percentages is misleading, so
        // the pill reports COUNT here and nothing else.
        clipboardValue: (r) => {
            const p = deriveDailyMetrics(r).prodLossPct;
            return p === null ? '' : `${p.toFixed(2)}%`;
        },
        format: (r) => {
            const p = deriveDailyMetrics(r).prodLossPct;
            return p === null ? null : (
                <span className="font-semibold text-red-700 dark:text-red-300">{p.toFixed(2)}%</span>
            );
        },
    },
    {
        key: 'ttl_waste',
        label: 'TTL WASTE',
        title: 'Sum of the eight waste streams (kg)',
        width: 72,
        headerWrap: true,
        align: 'right',
        cellKind: 'readonly',
        selectable: true,
        calcType: 'SUM',
        numericValue: (r) => {
            const w = deriveDailyMetrics(r).totalWaste;
            return w > 0 ? w : null;
        },
        clipboardValue: (r) => {
            const w = deriveDailyMetrics(r).totalWaste;
            return w > 0 ? w.toFixed(2) : '';
        },
        format: (r) => {
            const w = deriveDailyMetrics(r).totalWaste;
            return w > 0 ? (
                <span className="font-semibold text-red-700 dark:text-red-300">
                    {formatKg(w, 2)}
                </span>
            ) : null;
        },
        summaryLane: 'total',
    },
    numberCol('rs1a', 'RS1A', 'rs1a', 60),
    numberCol('rs1b', 'RS1B', 'rs1b', 60),
    numberCol('bf', 'BF', 'bf', 56),
    numberCol('rs23', 'RS2/3', 'rs23', 60),
    numberCol('rs5', 'RS5', 'rs5', 56),
    numberCol('trml1', 'TRML1', 'trml1', 60),
    numberCol('trml2', 'TRML2', 'trml2', 60),
    numberCol('grit', 'GRIT', 'grit', 56),
];

// ═══ Row families ═══════════════════════════════════════════════════════════════

/** Downtime + waste: owned by the SHIFT, so they live on its primary run row only. */
const SHIFT_OWNED = new Set([
    'dt_hrs',
    'dt_mins',
    'dt_ttl',
    'prod_hrs',
    'dt_reason',
    'prod_loss',
    'ttl_waste',
    'rs1a',
    'rs1b',
    'bf',
    'rs23',
    'rs5',
    'trml1',
    'trml2',
    'grit',
]);

/** Computed lanes: they RENDER and the caret steps over them. */
const COMPUTED = new Set(['dt_ttl', 'prod_hrs', 'prod_loss', 'ttl_waste']);

/** The identity lanes a secondary row shows as `↑`. */
const IDENTITY = new Set(['date', 'batch', 'shift_code']);

const EDITABLE_FIELDS = new Set([
    'date',
    'batch',
    'shift_code',
    'customer',
    'grade',
    'ttl_kg',
    'run_remarks',
    'dt_hrs',
    'dt_mins',
    'dt_reason',
    'rs1a',
    'rs1b',
    'bf',
    'rs23',
    'rs5',
    'trml1',
    'trml2',
    'grit',
]);

/** A Set, not an array: `occupies()` is asked once per column per rendered row. */
const COLUMN_KEYS = new Set(COLUMNS.map((c) => c.key));

function slotFor(colKey: string, primary: boolean): CellSlot | null {
    if (!COLUMN_KEYS.has(colKey)) return null;
    // The row ordinal: content, no keyboard business.
    if (colKey === 'num') return { field: 'num', editable: false, addressable: false };
    // A secondary row has NO CELL at all under downtime / waste.
    if (!primary && SHIFT_OWNED.has(colKey)) return null;
    if (COMPUTED.has(colKey)) return { field: colKey, editable: false, addressable: false };
    if (!primary && IDENTITY.has(colKey)) {
        // It renders the `↑` carry mark; the caret walks past it, because the value it
        // stands for belongs to the row above.
        return { field: colKey, editable: false, addressable: false };
    }
    return { field: colKey, editable: EDITABLE_FIELDS.has(colKey) };
}

const KINDS: ReadonlyMap<string, RowKind<DailyRow>> = new Map<string, RowKind<DailyRow>>([
    [
        'run-primary',
        {
            kind: 'run-primary',
            height: ROW_H,
            addressable: true,
            occupies: (colKey) => slotFor(colKey, true),
        },
    ],
    [
        'run-secondary',
        {
            kind: 'run-secondary',
            height: ROW_H,
            addressable: true,
            occupies: (colKey) => slotFor(colKey, false),
        },
    ],
]);

const ROW_RULES: Record<string, string> = {
    'run-primary': 'border-b border-b-border/30',
    'run-secondary': 'border-b border-b-border/20',
};

// ═══ Stored text — the copy fallback and the jump keys' `filled` probe ══════════

function fieldText(r: DailyRow, field: string): string {
    switch (field) {
        case 'num':
            return String(r._ord);
        case 'dt_ttl': {
            const m = deriveDailyMetrics(r);
            return m.dtHrs > 0 || m.dtMins > 0 ? m.dtTtl.toFixed(2) : '';
        }
        case 'prod_hrs':
            return deriveDailyMetrics(r).prodHrs.toFixed(2);
        case 'prod_loss': {
            const p = deriveDailyMetrics(r).prodLossPct;
            return p === null ? '' : `${p.toFixed(2)}%`;
        }
        case 'ttl_waste': {
            const w = deriveDailyMetrics(r).totalWaste;
            return w > 0 ? w.toFixed(2) : '';
        }
        default: {
            const v = (r as unknown as Record<string, unknown>)[field];
            return v === null || v === undefined ? '' : String(v);
        }
    }
}

// ═══ Header chrome — pure VIEW state, reached through `renderHeaderSlot` ════════
//
// `HeaderCell` has carried a `filterSlot` since it was written; `renderHeaderSlot` is the
// wire to it. The platform still renders no filter UI and holds no filter state — the
// grammar and the state are the consumer's, exactly as the module says.

function ColumnFilterSlot({
    label,
    value,
    options,
    onChange,
}: {
    label: string;
    value: string;
    options: readonly string[];
    onChange: (next: string) => void;
}) {
    const isActive = value !== ALL;
    return (
        <DropdownMenu>
            <DropdownMenuTrigger asChild>
                <button
                    type="button"
                    aria-label={`Filter ${label}${isActive ? `: ${value}` : ''}`}
                    title={isActive ? `${label}: ${value}` : `Filter ${label}`}
                    onMouseDown={(e) => e.stopPropagation()}
                    onPointerDown={(e) => e.stopPropagation()}
                    className={cn(
                        'flex items-center justify-center rounded p-0.5 outline-none transition-colors duration-150',
                        'focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-primary',
                        isActive
                            ? 'text-primary hover:text-primary/80'
                            : 'text-muted-foreground/50 hover:text-muted-foreground',
                    )}
                >
                    <ListFilter className="size-3" aria-hidden="true" />
                </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="min-w-[100px] bg-popover/95 backdrop-blur-lg">
                <DropdownMenuLabel className="px-2 py-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                    {label}
                </DropdownMenuLabel>
                <DropdownMenuSeparator />
                <DropdownMenuRadioGroup value={value} onValueChange={onChange}>
                    <DropdownMenuRadioItem value={ALL} className="py-1 font-mono text-[11px]">
                        All
                    </DropdownMenuRadioItem>
                    {options.map((opt) => (
                        <DropdownMenuRadioItem key={opt} value={opt} className="py-1 font-mono text-[11px]">
                            {opt}
                        </DropdownMenuRadioItem>
                    ))}
                </DropdownMenuRadioGroup>
            </DropdownMenuContent>
        </DropdownMenu>
    );
}

// ═══ Props — the SAME shape the live ledger takes ══════════════════════════════
//
// `DailyLedgerGridProps` is not exported by the live file and this migration may not edit
// it, so the shape is restated. Keep the two in step: the point of the side-by-side is
// that `daily-view.tsx` can hand either component the identical props.

export interface DailyGridV2Props {
    initialShifts: ProductionShiftRow[];
    initialRuns: ProductionRunRow[];
    initialDowntime: ProductionDowntimeRow[];
    initialWaste: ProductionWasteRow[];
    /** Accepted for prop parity with the live ledger. Nothing here can save, so nothing calls it. */
    onSaveSuccess?: () => void;
}

export function DailyGridV2({
    initialShifts,
    initialRuns,
    initialDowntime,
    initialWaste,
}: DailyGridV2Props) {
    // No status-bar wiring, and no local selection count.
    //
    // This grid used to hold `selectionCount`, push it into the shared status bar on a
    // 50ms timer, and push `setCellAggregates(null)` beside it — because the module
    // computed SUM/AVERAGE/COUNT/MIN/MAX over the selected rectangle and then discarded
    // them, and a consumer CANNOT recompute them: the range is in nav-row coordinates
    // resolved inside `useTableRows`, so totalling it against `items` would be a second
    // definition of the row axis. So the honest thing was a cell COUNT and an explicit
    // `null` where the live grid shows a total.
    //
    // `BlackwoodTable` now publishes the real aggregates to the status bar ITSELF, through
    // an optional provider. Every line of that workaround is deleted rather than left to
    // race the table for the same slot — two writers to one pill is a flicker, and the one
    // that wins is whichever effect happens to run last.

    const [settings, setSettings] = React.useState<TableSettings>({});
    const [state, setState] = React.useState<TableState>({
        activeCell: null,
        isEditing: false,
        selection: null,
    });

    // View state only. Nothing here reaches a query, an action or a role gate — the same
    // rows are already in memory and these decide which of them render, in what order.
    const [dateSortDir, setDateSortDir] = React.useState<'asc' | 'desc'>('asc');
    const [shiftFilter, setShiftFilter] = React.useState(ALL);
    const [customerFilter, setCustomerFilter] = React.useState(ALL);
    const [gradeFilter, setGradeFilter] = React.useState(ALL);

    /** THE row model, from the live ledger's own builder. */
    const ledgerRows = React.useMemo(
        () => buildGridRows(initialShifts, initialRuns, initialDowntime, initialWaste, dateSortDir),
        [initialShifts, initialRuns, initialDowntime, initialWaste, dateSortDir],
    );

    const distinct = React.useMemo(() => {
        const shifts = new Set<string>();
        const customers = new Set<string>();
        const grades = new Set<string>();
        for (const r of ledgerRows) {
            if (r.shift_code) shifts.add(r.shift_code);
            if (r.customer) customers.add(r.customer);
            if (r.grade) grades.add(r.grade);
        }
        const rank: Record<string, number> = { M: 0, E: 1, N: 2 };
        return {
            shifts: [...shifts].sort(
                (a, b) => (rank[a] ?? 99) - (rank[b] ?? 99) || a.localeCompare(b),
            ),
            customers: [...customers].sort(),
            grades: [...grades].sort(),
        };
    }, [ledgerRows]);

    /**
     * The visible rows, and the ordinal they carry.
     *
     * The live grid keeps hidden rows in the array with `display:none` so its cell
     * selection, paste and context-menu INDICES stay aligned with the full array. There is
     * no save, no paste target and no row menu here, so a hidden row is simply absent —
     * which is also what keeps the coordinate space free of holes the caret would fall in.
     */
    const rows = React.useMemo<DailyRow[]>(() => {
        const out: DailyRow[] = [];
        let ord = 0;
        for (const r of ledgerRows) {
            if (shiftFilter !== ALL && r.shift_code !== shiftFilter) continue;
            if (customerFilter !== ALL && r.customer !== customerFilter) continue;
            if (gradeFilter !== ALL && r.grade !== gradeFilter) continue;
            ord += 1;
            out.push({ ...r, _ord: ord });
        }
        return out;
    }, [ledgerRows, shiftFilter, customerFilter, gradeFilter]);

    const rowIdOf = React.useCallback(
        (r: DailyRow, index: number): string => r._ids.run_id ?? `${r._shiftKey}#${index}`,
        [],
    );

    const byId = React.useMemo(() => {
        const m = new Map<string, DailyRow>();
        rows.forEach((r, i) => m.set(rowIdOf(r, i), r));
        return m;
    }, [rows, rowIdOf]);

    const items = React.useMemo<GridRow<DailyRow>[]>(
        () =>
            rows.map((r, i) => ({
                kind: r._isPrimary ? 'run-primary' : 'run-secondary',
                id: rowIdOf(r, i),
                data: r,
            })),
        [rows, rowIdOf],
    );

    const storedText = React.useCallback(
        (rowId: string, field: string): string => {
            const r = byId.get(rowId);
            return r ? fieldText(r, field) : '';
        },
        [byId],
    );

    const isDraft = React.useCallback(() => false, []);
    const edits = useTableEdits({ canonicalText: storedText, isDraft });

    // ── Footer totals ───────────────────────────────────────────────────────────
    // The live grid's four aggregates, over the same eligible sets: TTL KG sums every
    // visible run row; DT TTL / PROD HRS / TTL WASTE are PRIMARY-row metrics, because
    // downtime and waste ride on the shift's primary run.
    const totals = React.useMemo(() => {
        let ttlKg = 0;
        let dtTtl = 0;
        let prodHrs = 0;
        let waste = 0;
        let runs = 0;
        const shifts = new Set<string>();
        for (const r of rows) {
            const v = parseFloat(r.ttl_kg);
            if (!Number.isNaN(v)) ttlKg += v;
            runs += 1;
            shifts.add(r._shiftKey);
            if (!r._isPrimary) continue;
            const m = deriveDailyMetrics(r);
            dtTtl += m.dtTtl;
            prodHrs += m.prodHrs;
            waste += m.totalWaste;
        }
        return { ttlKg, dtTtl, prodHrs, waste, runs, shiftCount: shifts.size };
    }, [rows]);

    /**
     * ONE summary row, on the four lanes the module has.
     *
     * The live ledger puts a figure under each of FOUR columns (TTL KG · DT TTL · PROD HRS
     * · TTL WASTE). `TableSummaryRow` offers `label | figure | note | total`, so DT TTL
     * takes `figure` and TTL WASTE takes `total` — both land under their own column — while
     * TTL KG rides in the pinned `label` lane and PROD HRS at the head of the `note` lane,
     * each NAMED so no figure is ambiguous. The seam this wants is in the report.
     *
     * `figure` on DT TTL rather than on TTL KG is not cosmetic: `summarySpans`' sticky form
     * is `frozen + spacer + weight + note + total + trailing`, and a figure lane INSIDE the
     * pinned block makes `spacer` clamp at 0 and the row over-tile the column table by the
     * difference. The figure lane must sit at or after the end of the pinned block.
     */
    const summaryRows = React.useMemo<TableSummaryRow[]>(
        () => [
            {
                key: 'tot',
                label: (
                    <span className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-wide">
                        <span className="text-muted-foreground">TOT</span>
                        <span className="text-muted-foreground/70">
                            {totals.shiftCount} shift{totals.shiftCount === 1 ? '' : 's'} ·{' '}
                            {totals.runs} run{totals.runs === 1 ? '' : 's'}
                        </span>
                        <span className="ml-auto font-semibold normal-case tracking-normal text-foreground">
                            Σ TTL KG {formatKg(totals.ttlKg)}
                        </span>
                    </span>
                ),
                figure: (
                    <span title="Σ DT TTL (hours)" className="font-semibold">
                        {totals.dtTtl.toFixed(2)}
                    </span>
                ),
                note: (
                    <span className="font-mono text-[10px] text-muted-foreground">
                        Σ PROD HRS{' '}
                        <span className="font-semibold text-foreground">
                            {totals.prodHrs.toFixed(2)}
                        </span>
                    </span>
                ),
                total: (
                    <span title="Σ TTL WASTE (kg)" className="font-semibold">
                        {formatKg(totals.waste, 2)}
                    </span>
                ),
                sticky: true,
            },
        ],
        [totals],
    );

    const rowClassFor = React.useCallback(
        (item: GridRow<DailyRow>): string | undefined =>
            item.kind === 'run-secondary'
                ? 'group bg-muted/20 transition-colors duration-150 hover:bg-muted/40'
                : 'group transition-colors duration-150 hover:bg-muted/50',
        [],
    );

    /**
     * The header's own chrome. Must be referentially stable — it is a dependency of every
     * header cell, so a fresh identity per render rebuilds the whole header row and would
     * freeze each popover's state at the identity it had on first render.
     */
    const renderHeaderSlot = React.useCallback(
        (spec: ColumnSpec<DailyRow, DailyCtx>): React.ReactNode => {
            if (spec.key === 'date') {
                return (
                    <button
                        type="button"
                        title={dateSortDir === 'asc' ? 'Sort descending' : 'Sort ascending'}
                        aria-label={dateSortDir === 'asc' ? 'Sort descending' : 'Sort ascending'}
                        onMouseDown={(e) => e.stopPropagation()}
                        onPointerDown={(e) => e.stopPropagation()}
                        onClick={() => setDateSortDir((d) => (d === 'asc' ? 'desc' : 'asc'))}
                        className="flex items-center justify-center rounded p-0.5 outline-none transition-colors duration-150 hover:text-foreground focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-primary"
                    >
                        {dateSortDir === 'asc' ? (
                            <ChevronUp className="size-3 text-muted-foreground" aria-hidden="true" />
                        ) : (
                            <ChevronDown className="size-3 text-primary" aria-hidden="true" />
                        )}
                    </button>
                );
            }
            if (spec.key === 'shift_code') {
                return (
                    <ColumnFilterSlot
                        label="SHIFT"
                        value={shiftFilter}
                        options={distinct.shifts}
                        onChange={setShiftFilter}
                    />
                );
            }
            if (spec.key === 'customer') {
                return (
                    <ColumnFilterSlot
                        label="CUSTOMER"
                        value={customerFilter}
                        options={distinct.customers}
                        onChange={setCustomerFilter}
                    />
                );
            }
            if (spec.key === 'grade') {
                return (
                    <ColumnFilterSlot
                        label="GRADE"
                        value={gradeFilter}
                        options={distinct.grades}
                        onChange={setGradeFilter}
                    />
                );
            }
            return null;
        },
        [dateSortDir, shiftFilter, customerFilter, gradeFilter, distinct],
    );

    return (
        <div className="flex min-h-0 flex-col">
            <div className="flex shrink-0 flex-wrap items-center gap-2 border-b bg-muted/20 px-2 py-1 text-[10px] text-muted-foreground">
                <span className="uppercase tracking-wide">
                    {totals.shiftCount} shift{totals.shiftCount !== 1 ? 's' : ''} · {totals.runs} run
                    {totals.runs !== 1 ? 's' : ''}
                </span>
                <span className="font-mono">
                    {state.activeCell ? `r${state.activeCell.row + 1}·c${state.activeCell.col + 1}` : '—'}
                </span>
                <span className="ml-auto">
                    Read-only preview — selection, the right-click menu, the selection summary and column
                    resize are live. The <strong className="font-semibold">Current</strong> switch above
                    returns to the editable ledger.
                </span>
            </div>

            <BlackwoodTable<DailyRow, DailyCtx>
                items={items}
                kinds={KINDS}
                specs={COLUMNS}
                ctx={CTX}
                settings={settings}
                onSettingsChange={setSettings}
                edits={edits}
                storedText={storedText}
                scope="focus"
                rowRules={ROW_RULES}
                rowClassFor={rowClassFor}
                renderHeaderSlot={renderHeaderSlot}
                summaryRows={summaryRows}
                onStateChange={setState}
                emptyMessage="Awaiting Production Manager sync — no shifts for this period."
                className={GRID_HEIGHT}
            />
        </div>
    );
}
