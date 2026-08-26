'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { ChevronDown, ChevronUp, ListFilter, Loader2, Save } from 'lucide-react';
import { toast } from 'sonner';

import { BlackwoodTable } from '@/components/shared/table';
import type { TableState, TableSummaryRow } from '@/components/shared/table';
import { DEFAULT_DRAFT_ROWS } from '@/lib/table';
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
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuLabel,
    DropdownMenuRadioGroup,
    DropdownMenuRadioItem,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { errorToast } from '@/lib/toast';
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
// …and the same discipline for the WRITE side: which row an edit saves to, what a cell's
// text is allowed to be, and what a payload has to carry all live in ONE pure module that
// `scripts/verify-daily-grid.ts` asserts without a browser or a database.
import {
    DEFAULT_CUSTOMER,
    SAVEABLE_GRADES,
    SHIFT_CODES,
    buildDailySavePlan,
    cleanPastedDailyCell,
    countDailyUnsaved,
    dailySaveFailureMessage,
    dailySaveSuccessMessage,
    describeDailyUnsaved,
    draftFieldText,
    isDailyEditField,
    isDraftKey,
    makeDraftIds,
    normalizeDailyField,
    parseDailyField,
    savedFieldText,
    storedRowFieldIsEditable,
    type DailyField,
    type DailyFieldEnv,
    type DailySavePlan,
    type DraftDefaults,
    type RouteDailyInput,
} from './daily-grid-v2-save';
import { saveBulkDailyLedger } from './actions';
import type {
    ProductionShiftRow,
    ProductionRunRow,
    ProductionDowntimeRow,
    ProductionWasteRow,
} from './actions';

// ═════════════════════════════════════════════════════════════════════════════════
// Daily ledger — the SAME rows, on the platform's Blackwood Table, now EDITABLE.
//
// Universal-table migration, built BESIDE `daily-ledger-grid.tsx` and reachable through
// the `?grid=` switch (the strangler-fig method —
// `handoffs/2026-08-17-universal-table-phase-1-and-the-side-by-side-method.md`). The live
// ledger is production and is not edited by one character; this file can be deleted to
// revert.
//
// ── WHAT CHANGED IN THIS PASS ───────────────────────────────────────────────────
// The grid was READ-ONLY and structurally so: no `ColumnSpec` declared `parse`, so
// `columnAcceptsEdit` answered false at every coordinate. It now types and saves through
// the EXISTING `saveBulkDailyLedger`, unchanged, with no new action and no SQL:
//
//   • Inline editing on the eighteen fields the live ledger lets an operator set, with
//     ONE commit verdict per lane (`parseDailyField`, shared with the save) and Excel-style
//     canonicalisation of DATE / BATCH / SHIFT / CUSTOMER / GRADE (`normalizeDailyField`).
//   • A blank-row pool at the bottom for new runs — the live grid's trailing empty row,
//     in the shape the platform module already has.
//   • A Save button, an unsaved chip counted in this sheet's own nouns, and honest
//     per-lane refusals BEFORE anything is posted.
//
// ── THE FOUR LANES SAVE TO THREE DIFFERENT ROWS ─────────────────────────────────
// A shift owns its downtime and its waste 1:1 and the ledger paints them on the shift's
// PRIMARY run row, so a waste figure typed there is a save to the SHIFT, not to the run
// the caret is on. `daily-grid-v2-save.ts` owns that routing (`routeDailyEdits`) and the
// three whole-block payloads it implies — the action rebuilds a fixed object per table, so
// a payload built only from the typed cells would blank the rest.
//
// ── WHAT IS DELIBERATELY NOT HERE ───────────────────────────────────────────────
// **DATE / BATCH / SHIFT are read-only on a SAVED row.** The action's UPDATE branch does
// not write `shift_id`, so a stored run cannot be moved between shifts through it — the
// write would leave the run where it is and create an empty shift beside it. Refused by
// name rather than typed and quietly mangled. All three stay typeable on a blank row.
//
// No row context menu, no delete, no Discard, no date-picker cell, no remark/reason
// popover editors (both are plain text lanes here), no autocomplete on CUSTOMER / GRADE /
// SHIFT (the live grid's `datalist` typeahead) and no Σ↔x̄ footer pills. Where a behaviour
// is not built this file renders NOTHING rather than a control that looks alive and does
// nothing.
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
    /**
     * The grid-wide edit gate. Every editable column ANDs its own rule with this, so
     * "nothing in this sheet can be typed into" stays ONE fact in ONE place.
     *
     * It is `true` for everyone today, and that is not an oversight: this sheet carries no
     * ₱ column, so `canViewPrices` — the project's one price boundary — has nothing to say
     * about it, and the live ledger gates nobody either. The field exists so a future gate
     * has exactly one place to land.
     */
    readonly canEdit: boolean;
    /** What a bare `8/21` means when the ROW itself cannot say. */
    readonly fallbackYear: number;
    /** What a blank row starts with — said out loud in the strip above the sheet. */
    readonly draftDefaults: DraftDefaults;
}

/**
 * What a bare `8/21` means in THIS cell — the row's own year, because an operator
 * correcting a June shift means June's year. A blank row has no year of its own and falls
 * through to the sheet's.
 */
function envOf(ctx: DailyCtx, cell?: CellContext<DailyRow>): DailyFieldEnv {
    const stored = cell?.row?.date;
    if (stored) {
        const y = Number(stored.slice(0, 4));
        if (Number.isFinite(y) && y > 1900) return { contextYear: y };
    }
    return { contextYear: ctx.fallbackYear };
}

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

// ═══ The commit verdict ═════════════════════════════════════════════════════════

/** A verdict that refuses nothing. The module reads only `ok`; the patch is never used. */
const PARSE_OK: ColumnParseResult = { ok: true, patch: {} };

/**
 * The four seams every editable column shares.
 *
 * `parse` IS `parseDailyField` — the same function the SAVE runs — so a value typed and
 * the same value refused at save can never disagree, because there is only one of them.
 * A BLANK cell commits without complaint: what a blank MEANS is a ROW-level question
 * (`buildDailySavePlan` refuses a run with no GRADE), and refusing it at commit would put
 * a persistent toast on screen every time somebody clears a cell they are about to retype.
 */
function editSeams(field: DailyField): Partial<ColumnSpec<DailyRow, DailyCtx>> {
    return {
        editable: (_row, ctx) => ctx.canEdit,
        parse: (text, ctx, cell): ColumnParseResult => {
            if (text.trim() === '') return PARSE_OK;
            const verdict = parseDailyField(field, text, envOf(ctx, cell));
            return verdict.ok ? PARSE_OK : verdict;
        },
        normalize: (text, ctx, cell) => normalizeDailyField(field, text, envOf(ctx, cell)),
        cleanPasted: (raw, ctx) => cleanPastedDailyCell(field, raw, { contextYear: ctx.fallbackYear }),
    };
}

/** A waste / downtime figure lane: same formatter, same blank-on-zero rule, ten times. */
function numberCol(
    key: DailyField,
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
        ...editSeams(key),
    };
}

/** The same lane, but showing the stored text verbatim — see DT HRS / DT MIN below. */
function rawNumberCol(
    key: DailyField,
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
        // Typeable on a BLANK row only — the row families are what say so. The seams are
        // declared here because the column half of the verdict has to exist for the draft
        // family's `editable: true` to mean anything at all.
        ...editSeams('date'),
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
        ...editSeams('batch'),
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
        ...editSeams('shift_code'),
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
        ...editSeams('customer'),
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
        ...editSeams('grade'),
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
        ...editSeams('ttl_kg'),
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
        // The live grid hides this behind a message icon and a popover. A popover editor is
        // a separate affordance this pass has not built, so the 200px lane shows the remark
        // ITSELF, truncated, with the full text on the browser's own tooltip — and it is
        // typed in place like every other text cell.
        format: (r) =>
            r.run_remarks ? (
                <span title={r.run_remarks} className="block w-full truncate">
                    {r.run_remarks}
                </span>
            ) : null,
        ...editSeams('run_remarks'),
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
        ...editSeams('dt_reason'),
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

/** A Set, not an array: `occupies()` is asked once per column per rendered row. */
const COLUMN_KEYS = new Set(COLUMNS.map((c) => c.key));

/**
 * THE per-cell answer, for all three families.
 *
 * Three questions, three answers, and the reason `CellSlot` has three members:
 *
 *   • **A secondary run row has NO CELL under downtime or waste** — not an empty one.
 *     That is what the live grid's muted block means and it is what keeps the keyboard
 *     from stopping there, a rectangle from totalling it and a paste from landing on it.
 *   • **A computed lane RENDERS and the caret steps over it** (`addressable: false`).
 *   • **DATE / BATCH / SHIFT are painted and NOT editable on a stored row.** The save
 *     cannot move a run between shifts (see the header), so a cell that accepted the
 *     typing would be a cell whose value is silently discarded. They stay fully typeable
 *     on a BLANK row, where the insert path does set the shift.
 */
function slotFor(colKey: string, family: 'primary' | 'secondary' | 'draft'): CellSlot | null {
    if (!COLUMN_KEYS.has(colKey)) return null;

    if (family === 'draft') {
        // A row that exists nowhere has no ordinal and no computed metrics — returning a
        // slot there would paint an empty cell the caret can sit in over nothing.
        if (colKey === 'num' || COMPUTED.has(colKey)) return null;
        return isDailyEditField(colKey) ? { field: colKey, editable: true } : null;
    }

    const primary = family === 'primary';
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
    return {
        field: colKey,
        // `storedRowFieldIsEditable` is the ONE definition of "may a saved row be typed
        // into here", shared with the save's own routing, so the cell and the payload
        // cannot disagree about which lanes a stored run owns.
        editable: isDailyEditField(colKey) && storedRowFieldIsEditable(colKey),
    };
}

const KINDS: ReadonlyMap<string, RowKind<DailyRow>> = new Map<string, RowKind<DailyRow>>([
    [
        'run-primary',
        {
            kind: 'run-primary',
            height: ROW_H,
            addressable: true,
            occupies: (colKey) => slotFor(colKey, 'primary'),
        },
    ],
    [
        'run-secondary',
        {
            kind: 'run-secondary',
            height: ROW_H,
            addressable: true,
            occupies: (colKey) => slotFor(colKey, 'secondary'),
        },
    ],
    [
        'draft',
        {
            kind: 'draft',
            height: ROW_H,
            addressable: true,
            occupies: (colKey) => slotFor(colKey, 'draft'),
        },
    ],
]);

const ROW_RULES: Record<string, string> = {
    'run-primary': 'border-b border-b-border/30',
    'run-secondary': 'border-b border-b-border/20',
    draft: 'border-b border-b-border/30',
};

// ═══ Stored text — the copy fallback and the jump keys' `filled` probe ══════════

/**
 * What a STORED cell holds, as text.
 *
 * The four computed lanes are answered here (they are derivations, not fields); everything
 * else delegates to `savedFieldText` in the save model — the same function every payload
 * reads for a field the operator did NOT touch, so "this edit is back to the stored value"
 * and "this is what will be saved" are one answer.
 */
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
        default:
            return savedFieldText(r, field);
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
    /**
     * Re-fetch the tab's data after a successful save.
     *
     * **OPTIONAL here and REQUIRED in practice.** This tab's rows are fetched on the
     * CLIENT (`daily-lazy-tab.tsx` calls `fetchDailyTabData` in an effect and passes the
     * result down), so `router.refresh()` cannot reach them — this callback is the only
     * door. `daily-view.tsx` passes it to the live ledger and does not yet pass it here;
     * until it does, a save lands in the database and the sheet keeps showing the values it
     * had, which the success toast says out loud. It is declared optional because this
     * pass may not edit that file.
     */
    onSaveSuccess?: () => void;
}

export function DailyGridV2({
    initialShifts,
    initialRuns,
    initialDowntime,
    initialWaste,
    onSaveSuccess,
}: DailyGridV2Props) {
    // No status-bar wiring, and no local selection count.
    //
    // This grid used to hold `selectionCount`, push it into the shared status bar on a
    // 50ms timer, and push `setCellAggregates(null)` beside it — because the module
    // computed SUM/AVERAGE/COUNT/MIN/MAX over the selected rectangle and then discarded
    // them. `BlackwoodTable` now publishes the real aggregates to the status bar ITSELF,
    // through an optional provider, so every line of that workaround is deleted rather
    // than left to race the table for the same slot.

    const router = useRouter();
    const [isPending, startTransition] = React.useTransition();

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

    /**
     * `production_downtime.shift_hrs`, by shift.
     *
     * The one column a downtime save MUST carry and this sheet does not display: it is NOT
     * NULL, the action gates the whole downtime write on it, and no stored row holds the 8
     * the PROD HRS lane assumes (measured: 158 rows say 9, 72 say 12). It never comes from
     * `buildGridRows`, which drops it — so it is read straight off the fetched rows and
     * ridden back out unchanged.
     */
    const shiftHrsByShiftId = React.useMemo(() => {
        const m = new Map<string, number>();
        for (const d of initialDowntime) m.set(d.shift_id, d.shift_hrs);
        return m;
    }, [initialDowntime]);

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
     * What a blank row starts with — the live grid's `createEmptyRow`, field for field,
     * except the BATCH.
     *
     * `createEmptyRow` leaves the batch blank and the operator types it. Here it is
     * seeded from the data, but **only when every row on the sheet agrees on one batch**
     * — which is the normal case, since the module's period picker filters by batch. When
     * the sheet spans two, no batch is guessed: a run booked against the wrong batch is
     * exactly the kind of silent wrong this migration exists not to introduce. Whatever
     * the answer is, the strip above the sheet says it out loud.
     */
    const draftDefaults = React.useMemo<DraftDefaults>(() => {
        const batches = new Set(ledgerRows.map((r) => r.batch).filter(Boolean));
        return {
            date: new Date().toISOString().split('T')[0],
            batch: batches.size === 1 ? [...batches][0] : '',
            shift: 'M',
            customer: DEFAULT_CUSTOMER,
        };
    }, [ledgerRows]);

    /** The year a bare `8/21` means when the row itself cannot say — the newest in view. */
    const fallbackYear = React.useMemo(() => {
        for (let i = ledgerRows.length - 1; i >= 0; i -= 1) {
            const y = Number((ledgerRows[i].date ?? '').slice(0, 4));
            if (Number.isFinite(y) && y > 1900) return y;
        }
        return new Date().getFullYear();
    }, [ledgerRows]);

    // `ctx` MUST be referentially stable — it is a dependency of the column resolution, of
    // every editability verdict and of every cell's `format`.
    const ctx = React.useMemo<DailyCtx>(
        () => ({ dense: true, canEdit: true, fallbackYear, draftDefaults }),
        [fallbackYear, draftDefaults],
    );

    /**
     * The visible rows, and the ordinal they carry.
     *
     * The live grid keeps hidden rows in the array with `display:none` so its cell
     * selection, paste and context-menu INDICES stay aligned with the full array. Here a
     * hidden row is simply absent — the coordinate space has no holes for the caret to
     * fall into, and every row is addressed by ID rather than by index, so a filter can
     * never re-point one row's unsaved text at another.
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

    /**
     * A row's id, and it must be STABLE under filtering and re-sorting.
     *
     * It used to fall back to `${_shiftKey}#${index}` — fine for a read-only sheet, a
     * hazard the moment the id is what unsaved text is filed under, because a filter would
     * re-point one row's typing at another. A run has its `run_id`; the only rows without
     * one are the placeholder rows `buildGridRows` emits for a shift that has no runs at
     * all, and there is exactly one of those per shift.
     */
    const rowIdOf = React.useCallback(
        (r: LedgerRow): string => r._ids.run_id ?? `${r._shiftKey}#norun`,
        [],
    );

    const byId = React.useMemo(() => {
        const m = new Map<string, DailyRow>();
        for (const r of rows) m.set(rowIdOf(r), r);
        return m;
    }, [rows, rowIdOf]);

    // ── The blank-row pool ───────────────────────────────────────────────────────
    const [draftIds, setDraftIds] = React.useState<string[]>(() => makeDraftIds(DEFAULT_DRAFT_ROWS));

    const items = React.useMemo<GridRow<DailyRow>[]>(() => {
        const out: GridRow<DailyRow>[] = rows.map((r) => ({
            kind: r._isPrimary ? 'run-primary' : 'run-secondary',
            id: rowIdOf(r),
            data: r,
        }));
        // The blank rows sit at the very bottom, below the last shift — they belong to no
        // day until the operator gives one a date.
        for (const id of draftIds) out.push({ kind: 'draft', id });
        return out;
    }, [rows, rowIdOf, draftIds]);

    /**
     * What a cell HOLDS as text — the editor's opening value, the jump keys' `filled`
     * probe, and the value an edit must return to in order to stop counting as unsaved.
     *
     * A BLANK ROW carries the four seeded defaults, which is what makes typing one of them
     * by hand a NON-edit instead of a row that can never be made clean again.
     */
    const storedText = React.useCallback(
        (rowId: string, field: string): string => {
            if (isDraftKey(rowId)) return draftFieldText(field, draftDefaults);
            const r = byId.get(rowId);
            return r ? fieldText(r, field) : '';
        },
        [byId, draftDefaults],
    );

    // THE single journalled writer. Every mutation in this grid — an inline commit, a
    // Delete, a paste, an Escape revert, undo and redo — goes through `edits.applyEdits`.
    const edits = useTableEdits({ canonicalText: storedText, isDraft: isDraftKey });

    const onAddDrafts = React.useCallback((count: number) => {
        // The ids are returned SYNCHRONOUSLY: a paste that runs past the last blank row
        // needs them inside the same gesture, and they ride on the journal step so one
        // Ctrl+Z takes back the paste AND the rows it grew.
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

    // ── Unsaved work, counted the way it will be SAVED ───────────────────────────
    const routeInput = React.useMemo<RouteDailyInput>(
        () => ({
            edits: edits.edits,
            dirtyRecords: edits.dirtyRecords,
            dirtyDrafts: edits.dirtyDrafts,
            draftIds,
            rowsById: byId,
            defaults: draftDefaults,
        }),
        [edits.edits, edits.dirtyRecords, edits.dirtyDrafts, draftIds, byId, draftDefaults],
    );

    const unsaved = React.useMemo(() => countDailyUnsaved(routeInput), [routeInput]);
    const [saving, setSaving] = React.useState(false);
    const busy = saving || isPending;

    // ── COMMIT ───────────────────────────────────────────────────────────────────
    //
    // **What the action actually returns, so nothing here pretends otherwise:**
    // `saveBulkDailyLedger` answers with ONE `{ ok }` for the whole batch, never a verdict
    // per row — and it is NOT transactional. It walks its shift groups with a sequential
    // await and returns on the first failure, so the groups before it ARE written. The
    // refusal therefore says "reload to see what landed" rather than RC IN's "nothing was
    // written", which would be false here.
    const commit = React.useCallback(
        async (plan: DailySavePlan) => {
            setSaving(true);
            try {
                const res = await saveBulkDailyLedger(plan.payload);
                if (!res.ok) {
                    errorToast(dailySaveFailureMessage(plan.counts, res.error));
                    return;
                }

                // Every row whose typing is settled — including the rows whose downtime or
                // waste text rode into another row's payload block. Forgetting the carrier
                // alone would leave their cells lit forever over values that are stored.
                edits.forget([...plan.savedRowIds, ...plan.savedDraftIds]);

                if (plan.savedDraftIds.length > 0) {
                    // The drafts became runs: drop their blank rows, then top the pool back
                    // up so the run of blanks stays the same length (Sheets never shrinks
                    // it either).
                    const consumed = new Set(plan.savedDraftIds);
                    setDraftIds((prev) => [
                        ...prev.filter((id) => !consumed.has(id)),
                        ...makeDraftIds(plan.savedDraftIds.length),
                    ]);
                }

                toast.success(
                    dailySaveSuccessMessage(plan.counts),
                    onSaveSuccess
                        ? undefined
                        : {
                              description:
                                  'This preview was mounted without a refresh callback, so the rows on screen are still the pre-save ones. Reload the tab to see what is stored.',
                          },
                );
                onSaveSuccess?.();
                // This tab's data is fetched on the CLIENT, so this reaches the server
                // components around the sheet and not the sheet itself — the callback above
                // is the door that matters.
                startTransition(() => router.refresh());
            } catch (err) {
                errorToast(`Unexpected error while saving: ${err instanceof Error ? err.message : String(err)}`);
            } finally {
                setSaving(false);
            }
        },
        [edits, onSaveSuccess, router],
    );

    // ── SAVE ─────────────────────────────────────────────────────────────────────
    //
    // One rule above everything: **nothing is written unless every dirty row builds a
    // legal payload.** A batch that posted the good rows and reported the rest would leave
    // the sheet half-saved with the refusals still on screen.
    const handleSave = React.useCallback(() => {
        if (unsaved.total === 0 || busy) return;

        const plan = buildDailySavePlan({
            ...routeInput,
            rows,
            shiftHrsByShiftId,
            env: { contextYear: fallbackYear },
        });

        if (plan.problems.length > 0) {
            errorToast(
                `${plan.problems.length} change${plan.problems.length === 1 ? '' : 's'} could not be saved — nothing was written.`,
                { description: plan.problems.join('\n') },
            );
            return;
        }

        if (plan.payload.length === 0) {
            // Everything typed merged back to what is stored. Nothing to post, and the
            // rows are settled — so their text is forgotten rather than left lit.
            if (plan.savedRowIds.length > 0 || plan.savedDraftIds.length > 0) {
                edits.forget([...plan.savedRowIds, ...plan.savedDraftIds]);
            }
            toast.info('Nothing to save — every edit is back to the stored value.');
            return;
        }

        void commit(plan);
    }, [unsaved.total, busy, routeInput, rows, shiftHrsByShiftId, fallbackYear, edits, commit]);

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
     * each NAMED so no figure is ambiguous.
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

    const rowClassFor = React.useCallback((item: GridRow<DailyRow>): string | undefined => {
        if (item.kind === 'run-secondary') {
            return 'group bg-muted/20 transition-colors duration-150 hover:bg-muted/40';
        }
        // A blank row reads as a blank row, so the end of the ledger is visible without a
        // heading announcing it.
        if (item.kind === 'draft') {
            return 'group bg-muted/10 transition-colors duration-150 hover:bg-muted/30';
        }
        return 'group transition-colors duration-150 hover:bg-muted/50';
    }, []);

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
            {/* A solid token, not glass: this strip is a `shrink-0` flex child, not a
                sticky surface, and a `backdrop-filter` over an opaque page paints nothing
                while still costing a compositor layer. */}
            <div className="flex shrink-0 flex-wrap items-center gap-2 border-b bg-muted/20 px-2 py-1 text-[10px] text-muted-foreground">
                <span className="uppercase tracking-wide">
                    {totals.shiftCount} shift{totals.shiftCount !== 1 ? 's' : ''} · {totals.runs} run
                    {totals.runs !== 1 ? 's' : ''}
                </span>
                <span className="font-mono">
                    {state.activeCell ? `r${state.activeCell.row + 1}·c${state.activeCell.col + 1}` : '—'}
                </span>
                <span>
                    Typing, saving and new rows are live. DATE · BATCH · SHIFT can only be set on a
                    blank row — this ledger&apos;s save cannot move a saved run to another shift. Grades
                    it accepts: {SAVEABLE_GRADES.join(' · ')}. The row menu, delete and the
                    remark popovers are not built yet.
                </span>

                {/* The blank rows' seeded values, SAID OUT LOUD. A `format` runs against the
                    stored row and a blank row has none, so a muted per-row default has
                    nowhere to render — and a value nobody typed must not reach the ledger
                    unseen. */}
                <span className="font-mono">
                    · new rows start{' '}
                    <span className="font-bold">{draftDefaults.date}</span> ·{' '}
                    <span className="font-bold">{draftDefaults.batch || 'no batch — type one'}</span> ·{' '}
                    <span className="font-bold">{draftDefaults.shift}</span> ·{' '}
                    <span className="font-bold">{draftDefaults.customer}</span>
                </span>

                {/* The refresh gap, said BEFORE the save rather than after it. This tab's
                    rows are fetched on the client, so without the callback a save lands in
                    the database and the sheet keeps showing the values it had — which looks
                    exactly like a save that did nothing. One line in `daily-view.tsx`
                    (`onSaveSuccess={onRefresh}`) closes it; that file is not this pass's. */}
                {!onSaveSuccess ? (
                    <span className="rounded-sm border border-amber-500/40 px-1 text-amber-700 dark:text-amber-400">
                        saves land, but this view cannot refetch — reload after saving
                    </span>
                ) : null}

                <div className="ml-auto flex items-center gap-2" data-grid-chrome>
                    {unsaved.total > 0 ? (
                        <span className="animate-fade-in rounded-sm border border-amber-500/40 bg-amber-500/10 px-1.5 py-0.5 font-medium text-amber-700 dark:text-amber-400">
                            {describeDailyUnsaved(unsaved)} unsaved
                        </span>
                    ) : null}
                    <button
                        type="button"
                        data-testid="save-production-daily"
                        onClick={handleSave}
                        disabled={unsaved.total === 0 || busy}
                        className={cn(
                            'inline-flex h-6 items-center gap-1 rounded border px-2 font-medium transition-colors duration-150',
                            unsaved.total > 0 && !busy
                                ? 'border-primary bg-primary text-primary-foreground hover:bg-primary/90'
                                : 'border-input text-muted-foreground',
                            (unsaved.total === 0 || busy) && 'cursor-not-allowed opacity-60',
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

            <BlackwoodTable<DailyRow, DailyCtx>
                items={items}
                kinds={KINDS}
                specs={COLUMNS}
                ctx={ctx}
                settings={settings}
                onSettingsChange={setSettings}
                edits={edits}
                storedText={storedText}
                scope="focus"
                draftKind="draft"
                // The blank-row pool and its `Add N more rows` control. `enabled` is also
                // what lets a paste taller than the sheet GROW into new rows.
                drafts={{ enabled: ctx.canEdit, defaultCount: DEFAULT_DRAFT_ROWS }}
                onAddDrafts={onAddDrafts}
                onRemoveDrafts={onRemoveDrafts}
                onRestoreDrafts={onRestoreDrafts}
                rowRules={ROW_RULES}
                rowClassFor={rowClassFor}
                renderHeaderSlot={renderHeaderSlot}
                summaryRows={summaryRows}
                onStateChange={setState}
                emptyMessage={`Awaiting Production Manager sync — no shifts for this period. Shifts are ${SHIFT_CODES.join(' / ')}.`}
                className={GRID_HEIGHT}
            />
        </div>
    );
}
