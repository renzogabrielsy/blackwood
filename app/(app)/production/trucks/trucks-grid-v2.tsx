'use client';

import * as React from 'react';

import { BlackwoodTable } from '@/components/shared/table';
import type { TableState } from '@/components/shared/table';
import type { CellSlot, ColumnSpec, GridRow, RowKind, TableSettings } from '@/lib/table';
import { useTableEdits } from '@/lib/hooks/use-table-edits';
import type { Tables } from '@/types/supabase';

// ═════════════════════════════════════════════════════════════════════════════════
// Trucks — the SAME days × plates matrix, on the platform's Blackwood Table.
//
// Universal-table migration, built BESIDE `trucks-grid.tsx` and reachable only at
// `/production?grid=v2`. The live grid is not edited by one character.
//
// ── READ-ONLY, STRUCTURALLY ─────────────────────────────────────────────────────
// No `ColumnSpec` declares `parse` or `editable`, so `columnAcceptsEdit` answers false
// for every column and the combined `isEditable` can never be true: no editor opens, no
// Delete clears, no paste lands. No `renderEditor`, no draft pool, no context menu, no
// import of `./actions`.
//
// ── THE PLATE BAND, AND WHAT IS AND IS NOT RECOVERED ────────────────────────────
// The live grid has a TWO-ROW header: a plate group label SPANNING four subcolumns, then
// START / END / TTL / FUEL beneath it. `BlackwoodTable` still builds ONE header row, so
// the spanning band is still inexpressible — but `ColumnSpec.headerWrap` +
// `ColumnSpec.labelNode` now let each header cell carry TWO LINES, so the plate is on top
// and the metric beneath it, per column:
//
//        AAV 6111        AAV 6111        AAV 6111        AAV 6111
//        START KM         END KM          TTL KM          FUEL L
//
// That reads as the band it stands in for, and it is a plain improvement on the previous
// `AAV START` — the full plate is back, in full, on every column, without a hover. What is
// still missing is only the SPAN: four separate cells each saying `AAV 6111`, rather than
// one cell saying it once across all four. `ColumnSpec.group` + a tiled band row remains
// the seam, and it remains unbuilt.
//
// `label` deliberately stays the flat `AAV 6111 START KM` string: the header's `title`,
// the resize handle's `aria-label` and `Copy with headers` all read it as TEXT and none of
// them can render a node, so `labelNode` ADDS a rendering and never replaces the name.
//
// ── ALSO NOT HERE ───────────────────────────────────────────────────────────────
// The trailing blank input row, the Save / Discard toolbar, the date-picker cell, and
// `TrucksSummaryMobile`. The phone summary is deliberately NOT reproduced — this is the
// desktop grid only, and the live component keeps serving the phone.
// ═════════════════════════════════════════════════════════════════════════════════

type TruckReadingRow = Tables<'truck_readings'>;

/** Canonical plate set — always present, in this fixed order. Mirrors the live grid. */
const KNOWN_PLATES = ['AAV 6111', 'KCA 378', 'FORKLIFT'] as const;

const ROW_H = 28;
const DATE_COL_WIDTH = 96;
/**
 * 84 rather than the live grid's 72, because each header cell carries TWO lines and the
 * wider of them has to fit: `AAV 6111` and `START KM` are both eight characters, ~55px at
 * `text-[11px]` uppercase with `tracking-wide`, against 84 − 17 = 67 usable. (At the
 * previous 78 the second line would have clipped to `START K…`, which is the same defect
 * one row lower down.) The body cells are odometer readings and comfortably fit.
 */
const SUBCOL_WIDTH = 84;

/** Fixed viewport, matching the live grid's `max-h-[60dvh]` scroll box. */
const GRID_HEIGHT = 'h-[60dvh]';

type MetricField = 'start_km' | 'end_km' | 'fuel_liters';

/** One truck's numbers for one day. The `_id` the live grid carries is a SAVE concern. */
interface PlateCell {
    start_km: string;
    end_km: string;
    fuel_liters: string;
    remarks: string;
}

/** One rendered row: a `reading_date` with every plate's cell beside it. */
interface DayRow {
    reading_date: string;
    cells: Record<string, PlateCell>;
}

interface TrucksCtx {
    /** The plate columns, in display order. Stable for the life of one grid instance. */
    readonly plates: readonly string[];
}

function emptyPlateCell(): PlateCell {
    return { start_km: '', end_km: '', fuel_liters: '', remarks: '' };
}

const numText = (v: number | null | undefined): string =>
    v === null || v === undefined ? '' : String(v);

function dbRowToPlateCell(r: TruckReadingRow): PlateCell {
    return {
        start_km: numText(r.start_km),
        end_km: numText(r.end_km),
        fuel_liters: numText(r.fuel_liters),
        remarks: r.remarks ?? '',
    };
}

/** The stable plate column set — the canonical three, then any extra plate, sorted. */
function derivePlates(data: readonly TruckReadingRow[]): string[] {
    const known = new Set<string>(KNOWN_PLATES);
    const extras = new Set<string>();
    for (const r of data) {
        const p = r.plate_no?.trim();
        if (!p) continue;
        if (!known.has(p)) extras.add(p);
    }
    return [...KNOWN_PLATES, ...[...extras].sort((a, b) => a.localeCompare(b))];
}

/**
 * DB rows → the pivot, one row per `reading_date`, in the server's own order.
 *
 * The live grid's private `buildGridRows` with the save bookkeeping (`_state`, `_dirty`,
 * per-plate `_id`) left out — this sheet never saves, so carrying them would be state
 * nothing reads.
 */
function buildDayRows(data: readonly TruckReadingRow[], plates: readonly string[]): DayRow[] {
    const byDate = new Map<string, DayRow>();
    const order: string[] = [];

    for (const r of data) {
        const date = r.reading_date ?? '';
        if (!date) continue;
        let row = byDate.get(date);
        if (!row) {
            const cells: Record<string, PlateCell> = {};
            for (const p of plates) cells[p] = emptyPlateCell();
            row = { reading_date: date, cells };
            byDate.set(date, row);
            order.push(date);
        }
        const plate = r.plate_no?.trim();
        // Last write wins on a duplicate `(date, plate)` — the natural key says it cannot
        // happen; the live grid stays defensive about it and so does this.
        if (plate && row.cells[plate]) row.cells[plate] = dbRowToPlateCell(r);
    }

    return order.map((d) => byDate.get(d)!);
}

/** Thousand separators, no decimals unless fractional — the live grid's own formatter. */
function formatNum(value: number | string | null | undefined): string {
    if (value === null || value === undefined || value === '') return '';
    const n = typeof value === 'string' ? parseFloat(value) : value;
    if (Number.isNaN(n)) return '';
    const hasFraction = Math.abs(n % 1) > 1e-9;
    return n.toLocaleString('en-US', {
        minimumFractionDigits: 0,
        maximumFractionDigits: hasFraction ? 2 : 0,
    });
}

function ttlKmOf(cell: PlateCell): number {
    return (parseFloat(cell.end_km) || 0) - (parseFloat(cell.start_km) || 0);
}

function cellOf(row: DayRow, plate: string): PlateCell {
    return row.cells[plate] ?? emptyPlateCell();
}

// ═══ Column keys ════════════════════════════════════════════════════════════════
//
// The key is the column's stable IDENTITY — it lands in saved widths and in a cell's
// `data-col-key`. Encoded once here so nothing has to parse it back apart by hand.

const DATE_KEY = 'date';
/** No plate contains it, so splitting a key back apart is unambiguous. */
const KEY_SEP = '::';

const colKeyOf = (plate: string, metric: MetricField | 'ttl_km'): string =>
    `${plate}${KEY_SEP}${metric}`;

/**
 * The metric line of the two-line header — WITH its unit, which the one-line form had no
 * room for. `TTL` and `TTL KM` are the same column; only one of them says what it counts.
 */
const METRIC_LABEL: Record<MetricField | 'ttl_km', string> = {
    start_km: 'START KM',
    end_km: 'END KM',
    ttl_km: 'TTL KM',
    fuel_liters: 'FUEL L',
};

/**
 * The two-line header: the plate above, the metric below.
 *
 * A `<br/>` rather than two block children, deliberately — `headerWrap` renders the label
 * inside a `line-clamp-2` box (`-webkit-box`), whose line counting works on INLINE content;
 * block-level children inside one do not lay out the way they read.
 */
function plateLabelNode(plate: string, metric: MetricField | 'ttl_km'): React.ReactNode {
    return (
        <>
            <span className="text-muted-foreground/80">{plate}</span>
            <br />
            <span className="font-semibold">{METRIC_LABEL[metric]}</span>
        </>
    );
}

const METRIC_TITLE: Record<MetricField | 'ttl_km', string> = {
    start_km: 'START KM (odometer at shift start)',
    end_km: 'END KM (odometer at shift end)',
    ttl_km: 'TTL KM — END − START',
    fuel_liters: 'FUEL (litres)',
};

/**
 * The column table, built from the plate set.
 *
 * A closure per column over its own `(plate, metric)` is what lets `format`,
 * `numericValue` and `clipboardValue` be plain functions of the row — the alternative is
 * a `switch` over column indices in five places, which is exactly the shape
 * `ColumnSpec` exists to retire.
 */
function buildColumns(plates: readonly string[]): ColumnSpec<DayRow, TrucksCtx>[] {
    const cols: ColumnSpec<DayRow, TrucksCtx>[] = [
        {
            key: DATE_KEY,
            label: 'DATE',
            width: DATE_COL_WIDTH,
            pin: 'start',
            align: 'center',
            cellKind: 'date',
            hideable: false,
            clipboardValue: (r) => r.reading_date,
            format: (r) => (
                <span className="block w-full truncate text-center font-mono">{r.reading_date}</span>
            ),
        },
    ];

    for (const plate of plates) {
        const metrics: (MetricField | 'ttl_km')[] = ['start_km', 'end_km', 'ttl_km', 'fuel_liters'];

        for (const metric of metrics) {
            if (metric === 'ttl_km') {
                cols.push({
                    key: colKeyOf(plate, 'ttl_km'),
                    label: `${plate} ${METRIC_LABEL.ttl_km}`,
                    labelNode: plateLabelNode(plate, 'ttl_km'),
                    headerWrap: true,
                    title: `${plate} — ${METRIC_TITLE.ttl_km}`,
                    width: SUBCOL_WIDTH,
                    align: 'right',
                    // Computed, never editable — and a rectangle MAY still cover it,
                    // because a run of daily distances is the most useful thing here to
                    // add up.
                    cellKind: 'readonly',
                    selectable: true,
                    calcType: 'SUM',
                    numericValue: (r) => {
                        const t = ttlKmOf(cellOf(r, plate));
                        return t > 0 ? t : null;
                    },
                    clipboardValue: (r) => {
                        const t = ttlKmOf(cellOf(r, plate));
                        return t > 0 ? String(t) : '';
                    },
                    format: (r) => {
                        const t = ttlKmOf(cellOf(r, plate));
                        return t > 0 ? (
                            <span className="font-semibold text-foreground/70">{formatNum(t)}</span>
                        ) : null;
                    },
                });
                continue;
            }

            cols.push({
                key: colKeyOf(plate, metric),
                label: `${plate} ${METRIC_LABEL[metric]}`,
                labelNode: plateLabelNode(plate, metric),
                headerWrap: true,
                title: `${plate} — ${METRIC_TITLE[metric]}`,
                width: SUBCOL_WIDTH,
                align: 'right',
                cellKind: 'number',
                calcType: metric === 'fuel_liters' ? 'SUM' : 'AVERAGE',
                numericValue: (r) => {
                    const v = parseFloat(cellOf(r, plate)[metric]);
                    return Number.isNaN(v) ? null : v;
                },
                clipboardValue: (r) => cellOf(r, plate)[metric],
                format: (r) => formatNum(cellOf(r, plate)[metric]),
            });
        }
    }

    return cols;
}

// ═══ Row families ═══════════════════════════════════════════════════════════════
//
// One family, and every column exists on it — a day either has a reading for a truck or
// has a blank one, which is an EMPTY cell rather than an absent one. The only per-cell
// distinction is the computed TTL lane: it renders content and the caret steps over it.

function buildKinds(plates: readonly string[]): ReadonlyMap<string, RowKind<DayRow>> {
    const slots: Record<string, CellSlot> = {
        [DATE_KEY]: { field: DATE_KEY, editable: true },
    };
    for (const plate of plates) {
        slots[colKeyOf(plate, 'start_km')] = { field: colKeyOf(plate, 'start_km'), editable: true };
        slots[colKeyOf(plate, 'end_km')] = { field: colKeyOf(plate, 'end_km'), editable: true };
        slots[colKeyOf(plate, 'ttl_km')] = {
            field: colKeyOf(plate, 'ttl_km'),
            editable: false,
            addressable: false,
        };
        slots[colKeyOf(plate, 'fuel_liters')] = {
            field: colKeyOf(plate, 'fuel_liters'),
            editable: true,
        };
    }

    return new Map<string, RowKind<DayRow>>([
        [
            'day',
            {
                kind: 'day',
                height: ROW_H,
                addressable: true,
                occupies: (colKey) => slots[colKey] ?? null,
            },
        ],
    ]);
}

const ROW_RULES: Record<string, string> = {
    day: 'border-b border-b-border/30',
};

/** The stored text behind a cell — the copy fallback and the jump keys' `filled` probe. */
function fieldText(row: DayRow, field: string): string {
    if (field === DATE_KEY) return row.reading_date;
    const sep = field.indexOf(KEY_SEP);
    if (sep < 0) return '';
    const plate = field.slice(0, sep);
    const metric = field.slice(sep + KEY_SEP.length);
    const cell = cellOf(row, plate);
    if (metric === 'ttl_km') {
        const t = ttlKmOf(cell);
        return t > 0 ? String(t) : '';
    }
    if (metric === 'start_km' || metric === 'end_km' || metric === 'fuel_liters') {
        return cell[metric];
    }
    return '';
}

// ═══ Props — the SAME shape the live grid takes ═════════════════════════════════

export interface TrucksGridV2Props {
    initialData: TruckReadingRow[];
    /** Accepted for prop parity with the live grid. Nothing here can save, so nothing calls it. */
    onSaveSuccess?: () => void;
}

export function TrucksGridV2({ initialData }: TrucksGridV2Props) {
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

    const plates = React.useMemo(() => derivePlates(initialData), [initialData]);
    const specs = React.useMemo(() => buildColumns(plates), [plates]);
    const kinds = React.useMemo(() => buildKinds(plates), [plates]);

    // MUST be referentially stable — it is a dependency of the column resolution and of
    // every cell's `format`.
    const ctx = React.useMemo<TrucksCtx>(() => ({ plates }), [plates]);

    const dayRows = React.useMemo(() => buildDayRows(initialData, plates), [initialData, plates]);

    const byId = React.useMemo(() => {
        const m = new Map<string, DayRow>();
        for (const r of dayRows) m.set(r.reading_date, r);
        return m;
    }, [dayRows]);

    const items = React.useMemo<GridRow<DayRow>[]>(
        () => dayRows.map((r) => ({ kind: 'day', id: r.reading_date, data: r })),
        [dayRows],
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

    const rowClassFor = React.useCallback(
        (): string => 'group transition-colors duration-150 hover:bg-muted/50',
        [],
    );

    return (
        <div className="flex min-h-0 flex-col">
            <div className="flex shrink-0 flex-wrap items-center gap-2 border-b bg-muted/20 px-2 py-1 text-[10px] text-muted-foreground">
                <span className="uppercase tracking-wide">
                    {dayRows.length} day{dayRows.length !== 1 ? 's' : ''} · {plates.length} truck
                    {plates.length !== 1 ? 's' : ''}
                </span>
                <span className="font-mono">
                    {state.activeCell ? `r${state.activeCell.row + 1}·c${state.activeCell.col + 1}` : '—'}
                </span>
                <span className="ml-auto">
                    Read-only preview — selection, the right-click menu, the selection summary and column
                    resize are live. The <strong className="font-semibold">Current</strong> switch above
                    returns to the editable grid.
                </span>
            </div>

            <BlackwoodTable<DayRow, TrucksCtx>
                items={items}
                kinds={kinds}
                specs={specs}
                ctx={ctx}
                settings={settings}
                onSettingsChange={setSettings}
                edits={edits}
                storedText={storedText}
                scope="focus"
                rowRules={ROW_RULES}
                rowClassFor={rowClassFor}
                onStateChange={setState}
                emptyMessage="Awaiting Production Manager sync — no truck readings for this period."
                className={GRID_HEIGHT}
            />
        </div>
    );
}
