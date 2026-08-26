'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { Loader2, RotateCcw, Save } from 'lucide-react';
import { toast } from 'sonner';

import { BlackwoodTable } from '@/components/shared/table';
import type { TableState } from '@/components/shared/table';
import {
    DEFAULT_DRAFT_ROWS,
    countUnsavedWork,
    describeUnsavedWork,
} from '@/lib/table';
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
import { errorToast } from '@/lib/toast';
import { cn } from '@/lib/utils';

import { saveBulkTrucks } from './actions';
import {
    DATE_KEY,
    TRUCK_METRICS,
    buildDayRows,
    buildTrucksSavePlan,
    cellOf,
    cleanPastedTruckCell,
    colKeyOf,
    derivePlates,
    isDraftKey,
    makeDraftIds,
    normalizeTruckField,
    parseTruckField,
    saveFailureMessage,
    saveSuccessMessage,
    storedFieldText,
    ttlKmOf,
    type DayRow,
    type MetricField,
    type TruckReadingRow,
    type TrucksEnv,
    type TrucksSavePlan,
} from './trucks-grid-v2-save';

// ═════════════════════════════════════════════════════════════════════════════════
// Trucks — the SAME days × plates matrix, on the platform's Blackwood Table, and since
// this pass **EDITABLE**.
//
// Universal-table migration, built BESIDE `trucks-grid.tsx`. The live grid is still not
// edited by one character.
//
// ── WHAT CHANGED IN THIS PASS ───────────────────────────────────────────────────
// No column declared `parse`, so nothing could be typed into. The sheet now types and
// saves through the EXISTING `saveBulkTrucks`, unchanged, with no new action and no new
// SQL: the DATE lane plus START KM / END KM / FUEL per truck, a blank-row pool at the
// bottom seeded with today's date, and a Save / Discard pair.
//
// **One rendered row is N database rows** — `truck_readings` is keyed
// `(reading_date, plate_no)` and this sheet pivots it — so the whole pivot, the per-plate
// stored id it needs to tell an UPDATE from an INSERT, and the rule that a DATE edit moves
// the whole day live in `trucks-grid-v2-save.ts` beside the save that reads them.
//
// ── THE PLATE BAND, AND WHAT IS AND IS NOT RECOVERED ────────────────────────────
// The live grid has a TWO-ROW header: a plate group label SPANNING four subcolumns, then
// START / END / TTL / FUEL beneath it. `BlackwoodTable` still builds ONE header row, so
// the spanning band is still inexpressible — but `ColumnSpec.headerWrap` +
// `ColumnSpec.labelNode` let each header cell carry TWO LINES, so the plate is on top and
// the metric beneath it, per column:
//
//        AAV 6111        AAV 6111        AAV 6111        AAV 6111
//        START KM         END KM          TTL KM          FUEL L
//
// That reads as the band it stands in for. What is still missing is only the SPAN.
// `label` deliberately stays the flat `AAV 6111 START KM` string: the header's `title`,
// the resize handle's `aria-label` and `Copy with headers` all read it as TEXT and none of
// them can render a node, so `labelNode` ADDS a rendering and never replaces the name.
// **This pass does not touch any of that** — the header work is unchanged, and editing was
// fitted around it.
//
// ── THE TTL LANE PREVIEWS UNSAVED EDITS, AND THE PILL DOES NOT ──────────────────
// The live grid computes TTL from its edit buffer, so a typed END updates it immediately.
// This sheet does the same through `ctx.cellText` — a STABLE function that reads the edit
// map through a ref, so a row re-renders when its OWN unsaved fields change, which is
// exactly when its derivation moves. It deliberately does NOT preview into the clipboard
// or the selection pill: `ColumnSpec.clipboardValue` is documented as "the STORED value,
// never the edit text", and `numericValue` takes the row and nothing else. The column's
// tooltip says which is which.
//
// And the same consequence RC IN's PHP TOTAL has: `format` runs against a stored row and a
// blank row has none, so a DRAFT row shows no TTL until it is saved. The draft family
// carries the typeable lanes only.
//
// ── ALSO NOT HERE ───────────────────────────────────────────────────────────────
// The date-PICKER cell (the DATE lane is typed, and `8/21` is canonicalised on commit),
// per-row delete (`saveBulkTrucks` is handed an empty `deletes` list, exactly as the live
// grid hands it), and `TrucksSummaryMobile`. The phone summary is deliberately NOT
// reproduced — this is the desktop grid only, and `trucks-view.tsx` keeps the live
// component serving the phone.
// ═════════════════════════════════════════════════════════════════════════════════

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

interface TrucksCtx {
    /** The plate columns, in display order. Stable for the life of one grid instance. */
    readonly plates: readonly string[];
    /**
     * The grid-wide edit gate. Every editable column ANDs its own rule with this, so
     * "nothing in this sheet can be typed into" stays ONE fact in ONE place.
     */
    readonly canEdit: boolean;
    /**
     * A cell's CURRENT text — the operator's unsaved value if there is one, otherwise the
     * stored one. Stable across keystrokes by construction, which is what lets the TTL
     * lane preview without re-resolving the columns.
     */
    readonly cellText: (rowId: string, field: string) => string;
    /** The year a bare `8/21` means when the ROW itself cannot say. */
    readonly fallbackYear: number;
    /** The date a blank row starts on. */
    readonly draftDefaultDate: string;
}

function contextYearOf(ctx: TrucksCtx, cell?: CellContext<DayRow>): number {
    const stored = cell?.row?.reading_date;
    if (stored) {
        const y = Number(stored.slice(0, 4));
        if (Number.isFinite(y) && y > 1900) return y;
    }
    return ctx.fallbackYear;
}

function envOf(ctx: TrucksCtx, cell?: CellContext<DayRow>): TrucksEnv {
    return { contextYear: contextYearOf(ctx, cell) };
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

// ═══ The commit verdict ═════════════════════════════════════════════════════════

/** A verdict that refuses nothing. The module reads only `ok`; the patch is never used. */
const PARSE_OK: ColumnParseResult = { ok: true, patch: {} };

/**
 * THE commit verdict for a column, and it is `parseTruckField` — the same function the
 * SAVE runs. A BLANK cell commits without complaint; a cleared DATE is refused at SAVE,
 * where a day without one cannot exist, rather than mid-typing.
 */
function makeParse(field: string) {
    return (text: string, ctx: TrucksCtx, cell?: CellContext<DayRow>): ColumnParseResult => {
        if (text.trim() === '') return PARSE_OK;
        const verdict = parseTruckField(field, text, envOf(ctx, cell));
        return verdict.ok ? { ok: true, patch: { [field]: verdict.value } } : verdict;
    };
}

/** The four seams every editable column shares. */
function editSeams(field: string): Partial<ColumnSpec<DayRow, TrucksCtx>> {
    return {
        editable: (_row, ctx) => ctx.canEdit,
        parse: makeParse(field),
        normalize: (text, ctx, cell) => normalizeTruckField(field, text, envOf(ctx, cell)),
        cleanPasted: (raw, ctx) => cleanPastedTruckCell(field, raw, envOf(ctx)),
    };
}

// ═══ Column labels ══════════════════════════════════════════════════════════════

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
    ttl_km: 'TTL KM — END − START. Previews what you have typed; a selection total reads the saved figures.',
    fuel_liters: 'FUEL (litres). A blank cell saves as “not recorded”, never as 0.',
};

/**
 * The column table, built from the plate set.
 *
 * A closure per column over its own `(plate, metric)` is what lets `format`,
 * `numericValue` and `clipboardValue` be plain functions of the row — the alternative is
 * a `switch` over column indices in five places, which is exactly the shape `ColumnSpec`
 * exists to retire.
 */
function buildColumns(plates: readonly string[]): ColumnSpec<DayRow, TrucksCtx>[] {
    const cols: ColumnSpec<DayRow, TrucksCtx>[] = [
        {
            key: DATE_KEY,
            label: 'DATE',
            title: 'Reading date (yyyy-MM-dd). Editing it re-files EVERY reading on this row under the new date.',
            width: DATE_COL_WIDTH,
            pin: 'start',
            align: 'center',
            cellKind: 'date',
            hideable: false,
            clipboardValue: (r) => r.reading_date,
            format: (r) => (
                <span className="block w-full truncate text-center font-mono">{r.reading_date}</span>
            ),
            ...editSeams(DATE_KEY),
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
                    // The row, not the buffer: the pill and the clipboard report what is
                    // SAVED (see the header).
                    numericValue: (r) => {
                        const c = cellOf(r, plate);
                        const t = ttlKmOf(c.start_km, c.end_km);
                        return t > 0 ? t : null;
                    },
                    clipboardValue: (r) => {
                        const c = cellOf(r, plate);
                        const t = ttlKmOf(c.start_km, c.end_km);
                        return t > 0 ? String(t) : '';
                    },
                    format: (r, ctx) => {
                        const t = ttlKmOf(
                            ctx.cellText(r.reading_date, colKeyOf(plate, 'start_km')),
                            ctx.cellText(r.reading_date, colKeyOf(plate, 'end_km')),
                        );
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
                ...editSeams(colKeyOf(plate, metric)),
            });
        }
    }

    return cols;
}

// ═══ Row families ═══════════════════════════════════════════════════════════════
//
// Two families, and on a stored day every column exists — a day either has a reading for a
// truck or has a blank one, which is an EMPTY cell rather than an absent one. The only
// per-cell distinction is the computed TTL lane: it renders content and the caret steps
// over it.
//
// A BLANK ROW carries the typeable lanes only: `format` runs against a stored row and a
// draft has none, so a TTL slot there would paint a cell that can never say anything.

function buildKinds(plates: readonly string[]): ReadonlyMap<string, RowKind<DayRow>> {
    const day: Record<string, CellSlot> = { [DATE_KEY]: { field: DATE_KEY, editable: true } };
    const draft: Record<string, CellSlot> = { [DATE_KEY]: { field: DATE_KEY, editable: true } };

    for (const plate of plates) {
        for (const metric of TRUCK_METRICS) {
            const key = colKeyOf(plate, metric);
            day[key] = { field: key, editable: true };
            draft[key] = { field: key, editable: true };
        }
        const ttl = colKeyOf(plate, 'ttl_km');
        day[ttl] = { field: ttl, editable: false, addressable: false };
    }

    return new Map<string, RowKind<DayRow>>([
        [
            'day',
            {
                kind: 'day',
                height: ROW_H,
                addressable: true,
                occupies: (colKey) => day[colKey] ?? null,
            },
        ],
        [
            'draft',
            {
                kind: 'draft',
                height: ROW_H,
                addressable: true,
                occupies: (colKey) => draft[colKey] ?? null,
            },
        ],
    ]);
}

const ROW_RULES: Record<string, string> = {
    day: 'border-b border-b-border/30',
    draft: 'border-b border-b-border/30',
};

// ═══ Props — the SAME shape the live grid takes ═════════════════════════════════

export interface TrucksGridV2Props {
    initialData: TruckReadingRow[];
    /**
     * **Load-bearing since this sheet can save.** The tab holds its rows in CLIENT state
     * (`components/trucks-lazy-tab.tsx` fetches through a server action into `useState`),
     * so `router.refresh()` cannot bring a saved reading back — only this can. It stays
     * optional so the component's shape is unchanged for a caller that has not threaded it
     * yet, and the sheet says so out loud when it is missing rather than quietly showing
     * stale rows after a successful save.
     */
    onSaveSuccess?: () => void | Promise<void>;
    /**
     * The year a bare `8/21` means when the row itself cannot say — the period the tab is
     * showing. Optional: absent, the newest dated reading in view is the fallback, and the
     * current year is the fallback's fallback.
     */
    periodYear?: number | null;
}

export function TrucksGridV2({ initialData, onSaveSuccess, periodYear }: TrucksGridV2Props) {
    // No status-bar wiring, and no local selection count: `BlackwoodTable` publishes the
    // real aggregates to the status bar ITSELF, through an optional provider.

    const router = useRouter();
    const [refreshing, startTransition] = React.useTransition();
    const [saving, setSaving] = React.useState(false);
    const busy = saving || refreshing;

    const [settings, setSettings] = React.useState<TableSettings>({});
    const [state, setState] = React.useState<TableState>({
        activeCell: null,
        isEditing: false,
        selection: null,
    });

    const plates = React.useMemo(() => derivePlates(initialData), [initialData]);
    const specs = React.useMemo(() => buildColumns(plates), [plates]);
    const kinds = React.useMemo(() => buildKinds(plates), [plates]);

    const dayRows = React.useMemo(() => buildDayRows(initialData, plates), [initialData, plates]);

    const byId = React.useMemo(() => {
        const m = new Map<string, DayRow>();
        for (const r of dayRows) m.set(r.reading_date, r);
        return m;
    }, [dayRows]);

    /** The date a blank row starts on — the live grid's own seed (`createEmptyRow`). */
    const draftDefaultDate = React.useMemo(() => new Date().toISOString().split('T')[0], []);

    const fallbackYear = React.useMemo(() => {
        if (periodYear !== null && periodYear !== undefined) return periodYear;
        for (const r of dayRows) {
            const y = Number(r.reading_date.slice(0, 4));
            if (Number.isFinite(y) && y > 1900) return y;
        }
        return new Date().getFullYear();
    }, [dayRows, periodYear]);

    const storedText = React.useCallback(
        (rowId: string, field: string): string => {
            if (isDraftKey(rowId)) return field === DATE_KEY ? draftDefaultDate : '';
            return storedFieldText(byId.get(rowId) ?? null, field);
        },
        [byId, draftDefaultDate],
    );

    const edits = useTableEdits({ canonicalText: storedText, isDraft: isDraftKey });

    const [draftIds, setDraftIds] = React.useState<string[]>(() => makeDraftIds(DEFAULT_DRAFT_ROWS));

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

    const items = React.useMemo<GridRow<DayRow>[]>(() => {
        const list: GridRow<DayRow>[] = dayRows.map((r) => ({
            kind: 'day', id: r.reading_date, data: r,
        }));
        for (const id of draftIds) list.push({ kind: 'draft', id });
        return list;
    }, [dayRows, draftIds]);

    // MUST be referentially stable — it is a dependency of the column resolution and of
    // every cell's `format`.
    const ctx = React.useMemo<TrucksCtx>(
        () => ({
            plates,
            canEdit: true,
            cellText: edits.cellText,
            fallbackYear,
            draftDefaultDate,
        }),
        [plates, edits.cellText, fallbackYear, draftDefaultDate],
    );

    const unsaved = React.useMemo(
        () => countUnsavedWork(edits.dirtyRecords, edits.dirtyDrafts),
        [edits.dirtyRecords, edits.dirtyDrafts],
    );

    const rowClassFor = React.useCallback((item: GridRow<DayRow>): string => {
        if (item.kind === 'draft') return 'group bg-muted/10 transition-colors duration-150 hover:bg-muted/30';
        return 'group transition-colors duration-150 hover:bg-muted/50';
    }, []);

    /**
     * Put the sheet back in step with the database.
     *
     * `onSaveSuccess` is the one that matters: this tab fetches its rows into client state,
     * so it is the only path that can bring a saved reading back. `router.refresh()` runs
     * beside it because `saveBulkTrucks` calls `revalidatePath('/production')` and the
     * server tree around this sheet should not be left stale — it is not what reloads the
     * rows.
     */
    const reload = React.useCallback(async () => {
        await onSaveSuccess?.();
        startTransition(() => router.refresh());
    }, [onSaveSuccess, router]);

    const commit = React.useCallback(
        async (plan: TrucksSavePlan) => {
            const counts = { updates: plan.updates.length, inserts: plan.inserts.length };
            setSaving(true);
            try {
                const res = await saveBulkTrucks({
                    inserts: plan.inserts,
                    updates: plan.updates,
                    // Deleting is not built on this sheet — the live grid sends an empty
                    // list here too.
                    deletes: [],
                });

                if (!res.ok) {
                    // NOTHING is forgotten: the action is staged and not transactional, so
                    // some prefix of this save may already be stored and no count comes
                    // back to say which. Every keystroke stays on screen, the sheet is
                    // reloaded underneath it, and the toast says exactly that.
                    errorToast(saveFailureMessage(counts, res.error));
                    await reload();
                    return;
                }

                edits.forget([...plan.updatedRowIds, ...plan.insertedDraftIds]);
                if (plan.insertedDraftIds.length > 0) {
                    const consumed = new Set(plan.insertedDraftIds);
                    setDraftIds((prev) => [
                        ...prev.filter((id) => !consumed.has(id)),
                        ...makeDraftIds(plan.insertedDraftIds.length),
                    ]);
                }
                toast.success(saveSuccessMessage(counts));
                if (!onSaveSuccess) {
                    toast.info('The readings are saved. This sheet cannot reload itself here — switch period or reload the page to see them.');
                }
                await reload();
            } catch (cause) {
                errorToast('Saving the truck sheet failed', {
                    description: cause instanceof Error ? cause.message : String(cause),
                });
            } finally {
                setSaving(false);
            }
        },
        [edits, reload, onSaveSuccess],
    );

    /**
     * One rule above everything: **nothing is written unless every dirty row builds a legal
     * payload.** The action writes in stages and is not one transaction, so a batch that
     * posted the good readings and let the server refuse the rest would leave the sheet
     * genuinely half-saved with the refusals still on screen.
     */
    const handleSave = React.useCallback(() => {
        if (unsaved.total === 0 || busy) return;

        const plan = buildTrucksSavePlan({
            edits: edits.edits,
            dirtyRecords: edits.dirtyRecords,
            dirtyDrafts: edits.dirtyDrafts,
            draftIds,
            dayRows,
            plates,
            defaultDate: draftDefaultDate,
            env: { contextYear: fallbackYear },
        });

        if (plan.problems.length > 0) {
            errorToast(
                `${plan.problems.length} change${plan.problems.length === 1 ? '' : 's'} could not be saved — nothing was written.`,
                { description: plan.problems.join('\n') },
            );
            return;
        }
        if (plan.updates.length === 0 && plan.inserts.length === 0) {
            toast.info('Nothing to save.');
            return;
        }
        void commit(plan);
    }, [unsaved.total, busy, edits, draftIds, dayRows, plates, draftDefaultDate, fallbackYear, commit]);

    /** The live grid's Discard, verbatim in effect: every unsaved keystroke, dropped. */
    const handleDiscard = React.useCallback(() => {
        if (unsaved.total === 0 || busy) return;
        edits.reset();
        setDraftIds(makeDraftIds(DEFAULT_DRAFT_ROWS));
    }, [unsaved.total, busy, edits]);

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
                <span className="font-mono">· new rows are dated {draftDefaultDate} unless you type one</span>
                <span>
                    Typing, saving and new days are live; the date picker, row delete and the phone summary
                    are not built — <strong className="font-semibold">Current</strong> above returns to the
                    Classic grid.
                </span>

                <div className="ml-auto flex items-center gap-2" data-grid-chrome>
                    {unsaved.total > 0 ? (
                        <span className="animate-fade-in rounded-sm border border-amber-500/40 bg-amber-500/10 px-1.5 py-0.5 font-medium text-amber-700 dark:text-amber-400">
                            {describeUnsavedWork(unsaved, { record: 'edited day', draft: 'new day' })} unsaved
                        </span>
                    ) : null}
                    {unsaved.total > 0 ? (
                        <button
                            type="button"
                            onClick={handleDiscard}
                            disabled={busy}
                            className={cn(
                                'inline-flex h-6 items-center gap-1 rounded border border-input px-2 font-medium transition-colors duration-150 hover:bg-muted',
                                busy && 'cursor-not-allowed opacity-60',
                            )}
                        >
                            <RotateCcw className="size-3" aria-hidden="true" />
                            Discard
                        </button>
                    ) : null}
                    <button
                        type="button"
                        data-testid="save-trucks"
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
                draftKind="draft"
                drafts={{ enabled: true, defaultCount: DEFAULT_DRAFT_ROWS }}
                onAddDrafts={onAddDrafts}
                onRemoveDrafts={onRemoveDrafts}
                onRestoreDrafts={onRestoreDrafts}
                rowRules={ROW_RULES}
                rowClassFor={rowClassFor}
                onStateChange={setState}
                emptyMessage="Awaiting Production Manager sync — no truck readings for this period. Type into a blank row to add one."
                className={GRID_HEIGHT}
            />
        </div>
    );
}
