'use client';

import * as React from 'react';
import { MessageSquareText } from 'lucide-react';

import { BlackwoodTable } from '@/components/shared/table';
import type { TableState } from '@/components/shared/table';
import type { CellSlot, ColumnSpec, GridRow, RowKind, TableSettings } from '@/lib/table';
import { useTableEdits } from '@/lib/hooks/use-table-edits';
import type { CellRange } from '@/lib/hooks/use-cell-selection';
import { useStatusBar } from '@/components/providers/status-bar-context';
import type { Tables } from '@/types/supabase';

// ═════════════════════════════════════════════════════════════════════════════════
// Electricity — the SAME readings, rendered through the platform's Blackwood Table.
//
// Universal-table migration, built BESIDE `electricity-grid.tsx` and reachable only at
// `/production?grid=v2` (the strangler-fig method —
// `handoffs/2026-08-17-universal-table-phase-1-and-the-side-by-side-method.md`). The live
// grid is not edited by one character; this file can be deleted to revert.
//
// ── IT IS READ-ONLY, AND THAT IS STRUCTURAL RATHER THAN A PROMISE ────────────────
// **No `ColumnSpec` here declares `parse` or `editable`.** `columnAcceptsEdit` therefore
// answers `false` for every column (`use-table-rows.ts`: "a column with no `parse` is
// read-only by construction"), and `isEditable` — the ONE place the row's answer and the
// column's are combined — can never be true. That single fact takes out the whole write
// surface at once: Enter/F2/double-click open nothing, Delete clears nothing, a paste
// lands nowhere, and there is no editor to mount because `renderEditor` is not passed
// either. No draft pool, no context menu, no server action is imported.
//
// The row families still declare the HONEST `editable` flag on each slot, because that is
// the row's half of the verdict and it is what a later editing pass builds on. It is inert
// while the column half says no — the two are ANDed, never ORed.
//
// ── WHAT IS DELIBERATELY NOT HERE ───────────────────────────────────────────────
// The trailing blank input row, the Save / Discard toolbar, the METER select, the
// per-row delete button, and the REMARKS popover editor. Each is a write path or the
// chrome of one. The remark still SHOWS — the icon tints when there is one and the full
// text is on the cell's `title` — so nothing is hidden, only uneditable.
// ═════════════════════════════════════════════════════════════════════════════════

type ElectricityReadingRow = Tables<'electricity_readings'>;

/** Row height, and the module measures nothing — same 28px as the live grid. */
const ROW_H = 28;

/** Fixed viewport, matching the live grid's `max-h-[60dvh]` scroll box. */
const GRID_HEIGHT = 'h-[60dvh]';

// ═══ Ctx ════════════════════════════════════════════════════════════════════════
// Ambient state every `format` and every visibility verdict sees. It MUST be
// referentially stable — it is a dependency of the column resolution and of every cell's
// `format`, so a fresh object per render re-renders the whole sheet. There is nothing
// role-dependent on this sheet (no ₱ anywhere), so it carries one flag and no more.
interface ElectricityCtx {
    /** Reserved for a future density switch; present so `Ctx` is never `unknown`. */
    readonly dense: boolean;
}

const CTX: ElectricityCtx = { dense: true };

// ═══ Derivations — the LIVE grid's own inline formulas, not the DB's columns ═════
//
// `electricity_readings` carries `diff_kwh` (generated) and `consumption_kwh`, but the
// live grid shows `end − start` and `diff × multiplier` computed in the client. The two
// sheets have to agree cell-for-cell or the comparison is worthless, so this mirrors the
// live grid rather than reading the stored columns.

function diffOf(r: ElectricityReadingRow): number {
    return (r.end_kwh ?? 0) - (r.start_kwh ?? 0);
}

function consumptionOf(r: ElectricityReadingRow): number {
    const d = diffOf(r);
    return d >= 0 ? d * (r.meter_multiplier ?? 0) : 0;
}

const numText = (v: number | null | undefined): string =>
    v === null || v === undefined ? '' : String(v);

/** A centred lane. `cell-classes` only knows `align: 'right'`, so centring is the cell's. */
function Centre({ children }: { children: React.ReactNode }) {
    return <span className="block w-full truncate text-center">{children}</span>;
}

// ═══ Columns ════════════════════════════════════════════════════════════════════
//
// Widths are the live grid's, column for column: 28 / 80 / 120 / 80 / 80 / 70 / 70 / 90
// / 50. The 20px delete column is absent because deleting is a write.
//
// `cellKind` still says what KIND of editor each lane would want, because that is a fact
// about the column rather than about this pass — and `readonly` / `derived` are read by
// `columnAcceptsEdit` and `columnSelectable`, so they are load-bearing even here.

const COLUMNS: ColumnSpec<ElectricityReadingRow, ElectricityCtx>[] = [
    {
        key: 'num',
        label: '#',
        width: 28,
        align: 'center',
        cellKind: 'derived',
        resizable: false,
        hideable: false,
        // A row ordinal has no arithmetic meaning and is the one thing Ctrl/Cmd+A must
        // not sweep in — `columnSelectable` already answers false for `derived`.
        format: () => null,
    },
    {
        key: 'reading_date',
        label: 'DATE',
        width: 80,
        align: 'center',
        cellKind: 'date',
        clipboardValue: (r) => r.reading_date ?? '',
        format: (r) => <Centre><span className="font-mono">{r.reading_date ?? ''}</span></Centre>,
    },
    {
        key: 'meter',
        label: 'METER',
        width: 120,
        align: 'center',
        cellKind: 'select',
        clipboardValue: (r) => r.meter ?? '',
        format: (r) => <Centre><span className="font-mono">{r.meter ?? ''}</span></Centre>,
    },
    {
        key: 'start_kwh',
        label: 'START KWH',
        title: 'Start meter reading (kWh)',
        width: 80,
        align: 'right',
        cellKind: 'number',
        calcType: 'SUM',
        numericValue: (r) => r.start_kwh ?? null,
        clipboardValue: (r) => numText(r.start_kwh),
        format: (r) => numText(r.start_kwh),
    },
    {
        key: 'end_kwh',
        label: 'END KWH',
        title: 'End meter reading (kWh)',
        width: 80,
        align: 'right',
        cellKind: 'number',
        calcType: 'SUM',
        numericValue: (r) => r.end_kwh ?? null,
        clipboardValue: (r) => numText(r.end_kwh),
        format: (r) => numText(r.end_kwh),
    },
    {
        key: 'diff',
        label: 'DIFF',
        title: 'END − START (kWh)',
        width: 70,
        align: 'right',
        // Never editable, but a rectangle MAY cover it — a run of computed figures is the
        // most useful thing on a sheet to add up.
        cellKind: 'readonly',
        selectable: true,
        calcType: 'SUM',
        numericValue: (r) => {
            const d = diffOf(r);
            return d >= 0 ? d : null;
        },
        clipboardValue: (r) => {
            const d = diffOf(r);
            return d >= 0 ? d.toFixed(2) : '';
        },
        format: (r) => {
            const d = diffOf(r);
            return d > 0 ? <span className="text-muted-foreground">{d.toFixed(2)}</span> : null;
        },
    },
    {
        key: 'meter_multiplier',
        label: 'MULT',
        title: 'Meter multiplier',
        width: 70,
        align: 'right',
        cellKind: 'number',
        calcType: 'AVERAGE',
        numericValue: (r) => r.meter_multiplier ?? null,
        clipboardValue: (r) => numText(r.meter_multiplier),
        format: (r) => numText(r.meter_multiplier),
    },
    {
        key: 'consumption',
        label: 'TTL KWH',
        title: 'DIFF × MULT (kWh consumed)',
        width: 90,
        align: 'right',
        cellKind: 'readonly',
        selectable: true,
        calcType: 'SUM',
        numericValue: (r) => {
            const c = consumptionOf(r);
            return c > 0 ? c : null;
        },
        clipboardValue: (r) => {
            const c = consumptionOf(r);
            return c > 0 ? c.toFixed(2) : '';
        },
        format: (r) => {
            const c = consumptionOf(r);
            return c > 0
                ? c.toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
                : null;
        },
        // No `summaryLane` on this sheet, and no `summaryRows` below: the live grid has no
        // totals footer, and inventing one would make the two sides disagree about what
        // the sheet says.
    },
    {
        key: 'remarks',
        label: 'REM',
        title: 'Remarks',
        width: 50,
        align: 'center',
        cellKind: 'text',
        clipboardValue: (r) => r.remarks ?? '',
        // The live grid hides the text behind a message icon and a popover. A popover is
        // an editor, so this shows the same icon and hands the full text to the browser's
        // own tooltip — the remark is READABLE here, just not writable.
        format: (r) => {
            const text = (r.remarks ?? '').trim();
            return (
                <span
                    title={text || undefined}
                    className={
                        text
                            ? 'flex w-full items-center justify-center text-primary'
                            : 'flex w-full items-center justify-center text-muted-foreground/30'
                    }
                >
                    <MessageSquareText className="size-3" aria-hidden="true" />
                </span>
            );
        },
    },
];

// ═══ Row families ═══════════════════════════════════════════════════════════════
//
// One family. `occupies()` is still the thing that answers per cell, and it is what says
// the ordinal RENDERS while the caret steps over it (`addressable: false`) — the middle
// answer the old code could not give at all.

const READING_FIELDS: Record<string, CellSlot> = {
    num: { field: 'num', editable: false, addressable: false },
    reading_date: { field: 'reading_date', editable: true },
    meter: { field: 'meter', editable: true },
    start_kwh: { field: 'start_kwh', editable: true },
    end_kwh: { field: 'end_kwh', editable: true },
    // Renders a computed figure, is sweepable, and the caret never stops on it.
    diff: { field: 'diff', editable: false, addressable: false },
    meter_multiplier: { field: 'meter_multiplier', editable: true },
    consumption: { field: 'consumption', editable: false, addressable: false },
    remarks: { field: 'remarks', editable: true },
};

const KINDS: ReadonlyMap<string, RowKind<ElectricityReadingRow>> = new Map<
    string,
    RowKind<ElectricityReadingRow>
>([
    [
        'reading',
        {
            kind: 'reading',
            height: ROW_H,
            addressable: true,
            occupies: (colKey) => READING_FIELDS[colKey] ?? null,
        },
    ],
]);

const ROW_RULES: Record<string, string> = {
    reading: 'border-b border-b-border/30',
};

// ═══ Stored text — what a copy falls back to and what the jump keys probe ════════

function fieldText(r: ElectricityReadingRow, field: string): string {
    switch (field) {
        case 'reading_date':
            return r.reading_date ?? '';
        case 'meter':
            return r.meter ?? '';
        case 'start_kwh':
            return numText(r.start_kwh);
        case 'end_kwh':
            return numText(r.end_kwh);
        case 'meter_multiplier':
            return numText(r.meter_multiplier);
        case 'remarks':
            return r.remarks ?? '';
        // A read-only column still HOLDS a value, and `storedText` is what the jump keys
        // read to decide whether a cell is FILLED. Returning '' here would make a run of
        // computed figures read as a blank gap to Ctrl+Arrow.
        case 'diff': {
            const d = diffOf(r);
            return d >= 0 ? d.toFixed(2) : '';
        }
        case 'consumption': {
            const c = consumptionOf(r);
            return c > 0 ? c.toFixed(2) : '';
        }
        default:
            return '';
    }
}

// ═══ Props — the SAME shape the live grid takes ═════════════════════════════════
//
// `ElectricityGridProps` is not exported by the live file and this migration may not edit
// it, so the shape is restated here rather than imported. Keep the two in step: the whole
// point of the side-by-side is that `electricity-view.tsx` can hand either component the
// identical props.

export interface ElectricityGridV2Props {
    initialData: ElectricityReadingRow[];
    /** Accepted for prop parity with the live grid. Nothing here can save, so nothing calls it. */
    onSaveSuccess?: () => void;
}

export function ElectricityGridV2({ initialData }: ElectricityGridV2Props) {
    const { setCellSelectionCount, setCellAggregates } = useStatusBar();

    // Column layout the operator owns for this session — resize only. Held locally: the
    // TABLE has no opinion about persistence, and a read-only side-by-side has no business
    // writing `user_table_settings`.
    const [settings, setSettings] = React.useState<TableSettings>({});
    const [selectionCount, setSelectionCount] = React.useState(0);

    const rows = initialData;

    const byId = React.useMemo(() => {
        const m = new Map<string, ElectricityReadingRow>();
        for (const r of rows) m.set(r.id, r);
        return m;
    }, [rows]);

    const items = React.useMemo<GridRow<ElectricityReadingRow>[]>(
        () => rows.map((r) => ({ kind: 'reading', id: r.id, data: r })),
        [rows],
    );

    const storedText = React.useCallback(
        (rowId: string, field: string): string => {
            const r = byId.get(rowId);
            return r ? fieldText(r, field) : '';
        },
        [byId],
    );

    // Nothing on this sheet is a draft, and nothing can become dirty — no column accepts
    // an edit. The writer is still wired because it is the grid's single source of cell
    // text; it simply never receives a write.
    const isDraft = React.useCallback(() => false, []);
    const edits = useTableEdits({ canonicalText: storedText, isDraft });

    const onSelectionChange = React.useCallback((range: CellRange | null) => {
        setSelectionCount(
            range === null
                ? 0
                : (range.endRow - range.startRow + 1) * (range.endCol - range.startCol + 1),
        );
    }, []);

    // The shared status bar's cell counter. The AGGREGATES are computed inside the table
    // and are not on any prop it exposes, so they are deliberately left null rather than
    // recomputed here — see this file's note in the migration report.
    React.useEffect(() => {
        const t = setTimeout(() => {
            setCellSelectionCount(selectionCount);
            setCellAggregates(null);
        }, 50);
        return () => clearTimeout(t);
    }, [selectionCount, setCellSelectionCount, setCellAggregates]);

    React.useEffect(
        () => () => {
            setCellSelectionCount(0);
            setCellAggregates(null);
        },
        [setCellSelectionCount, setCellAggregates],
    );

    const rowClassFor = React.useCallback(
        (): string => 'group transition-colors duration-150 hover:bg-muted/50',
        [],
    );

    // Held so the strip can say where the caret is without reaching into a class name.
    const [state, setState] = React.useState<TableState>({
        activeCell: null,
        isEditing: false,
        selection: null,
    });

    return (
        <div className="flex min-h-0 flex-col">
            <div className="flex shrink-0 flex-wrap items-center gap-2 border-b bg-muted/20 px-2 py-1 text-[10px] text-muted-foreground">
                <span className="uppercase tracking-wide">
                    {rows.length} reading{rows.length === 1 ? '' : 's'} this period
                </span>
                <span className="font-mono">
                    {state.activeCell ? `r${state.activeCell.row + 1}·c${state.activeCell.col + 1}` : '—'}
                </span>
                {selectionCount > 1 ? (
                    <span className="font-mono">{selectionCount} cells selected</span>
                ) : null}
                <span className="ml-auto">
                    Read-only preview — the <strong className="font-semibold">Current</strong> switch above
                    returns to the editable grid.
                </span>
            </div>

            <BlackwoodTable<ElectricityReadingRow, ElectricityCtx>
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
                onSelectionChange={onSelectionChange}
                onStateChange={setState}
                emptyMessage="Awaiting Production Manager sync — no readings for this period."
                className={GRID_HEIGHT}
            />
        </div>
    );
}
