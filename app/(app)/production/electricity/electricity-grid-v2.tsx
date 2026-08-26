'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { Loader2, MessageSquareText, RotateCcw, Save } from 'lucide-react';
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

import { saveBulkElectricity } from './actions';
import {
    DRAFT_METER,
    DRAFT_MULTIPLIER,
    KNOWN_METERS,
    buildElectricitySavePlan,
    cleanPastedElectricityCell,
    consumptionOf,
    diffKwhOf,
    draftSeedText,
    isDraftKey,
    isElectricityEditField,
    makeDraftIds,
    normalizeElectricityField,
    parseElectricityField,
    saveFailureMessage,
    saveSuccessMessage,
    storedFieldText,
    type ElectricityEnv,
    type ElectricityField,
    type ElectricityReadingRow,
    type ElectricitySavePlan,
} from './electricity-grid-v2-save';

// ═════════════════════════════════════════════════════════════════════════════════
// Electricity — the SAME readings, rendered through the platform's Blackwood Table,
// and since this pass **EDITABLE**.
//
// Universal-table migration, built BESIDE `electricity-grid.tsx` (the strangler-fig
// method — `handoffs/2026-08-17-universal-table-phase-1-and-the-side-by-side-method.md`).
// The live grid is still not edited by one character; this file can be deleted to revert.
//
// ── WHAT CHANGED IN THIS PASS ───────────────────────────────────────────────────
// The grid was READ-ONLY and structurally so: no column declared `parse`, so
// `columnAcceptsEdit` answered false everywhere and no editor could open. It now types and
// saves — through the EXISTING `saveBulkElectricity`, unchanged, with no new action and no
// new SQL:
//
//   • Inline editing on the six fields the live grid lets an operator set, with ONE commit
//     verdict per column (`parse`) — the same function the save runs, so a value typed and
//     the same value refused at save can never disagree.
//   • A blank-row pool at the bottom, seeded exactly like the live grid's trailing input
//     row (today's date · MAIN · 120), saved as inserts through the same action.
//   • A Save button, a Discard button and an unsaved chip.
//
// ── THE DERIVED LANES PREVIEW UNSAVED EDITS, AND THE PILL DOES NOT ──────────────
// The live grid computes DIFF and TTL KWH from its edit buffer, so a typed END updates
// both immediately. This sheet does the same through `ctx.cellText` — a STABLE function
// that reads the edit map through a ref, so the preview costs no extra render: a row
// re-renders when its OWN unsaved fields change, which is exactly when its derivation
// moves.
//
// What it deliberately does NOT do is preview into the clipboard or the selection pill.
// `ColumnSpec.clipboardValue` is documented as "the STORED value, never the edit text",
// and `numericValue` takes the row and nothing else — so both read what is SAVED. The
// distinction is real and is stated in each derived column's header tooltip: the screen
// shows what you have typed, a total tells you what is in the database.
//
// One consequence of the same mechanism, and it is the RC IN sheet's (PHP TOTAL) verbatim:
// `format` runs against a STORED row and a blank row has none, so a DRAFT row shows no
// DIFF and no TTL until it is saved. The draft family therefore carries only the typeable
// lanes rather than painting two cells that can never say anything.
//
// ── WHAT IS STILL NOT BUILT ─────────────────────────────────────────────────────
// The METER select (a plain text cell here — the three canonical meters are named in the
// column's tooltip, and a typo lands as typed), the per-row DELETE, and the remarks
// POPOVER editor (the remark is typed inline instead; the lane still renders as an icon,
// dirty or not). Where a behaviour is not built this file renders NOTHING rather than a
// control that looks alive and does nothing. `deletes` is therefore always `[]`.
// ═════════════════════════════════════════════════════════════════════════════════

/** Row height, and the module measures nothing — same 28px as the live grid. */
const ROW_H = 28;

/** Fixed viewport, matching the live grid's `max-h-[60dvh]` scroll box. */
const GRID_HEIGHT = 'h-[60dvh]';

// ═══ Ctx ════════════════════════════════════════════════════════════════════════
// Ambient state every `format`, every verdict and every visibility answer sees. It MUST be
// referentially stable — it is a dependency of the column resolution and of every cell's
// `format`, so a fresh object per render re-renders the whole sheet. There is nothing
// role-dependent on this sheet (no ₱ anywhere), so the only gate is the grid-wide one.
interface ElectricityCtx {
    /** Reserved for a future density switch; present so `Ctx` is never `unknown`. */
    readonly dense: boolean;
    /**
     * The grid-wide edit gate. Every editable column ANDs its own rule with this, so
     * "nothing in this sheet can be typed into" stays ONE fact in ONE place.
     */
    readonly canEdit: boolean;
    /**
     * A cell's CURRENT text — the operator's unsaved value if there is one, otherwise the
     * stored one. `useTableEdits` hands this back as a stable reference that reads its own
     * ref, so a derived lane can call it from `format` without re-resolving the columns on
     * every keystroke.
     */
    readonly cellText: (rowId: string, field: string) => string;
    /** The year a bare `8/21` means when the ROW itself cannot say. */
    readonly fallbackYear: number;
    /** The date a blank row starts on, so a draft's DATE cell has a canonical value. */
    readonly draftDefaultDate: string;
}

/**
 * What a bare `8/21` means in THIS cell — the row's own year, because an operator
 * correcting a 2025 reading means 2025. A blank row has no year of its own and falls
 * through to the sheet's.
 */
function contextYearOf(ctx: ElectricityCtx, cell?: CellContext<ElectricityReadingRow>): number {
    const stored = cell?.row?.reading_date;
    if (stored) {
        const y = Number(stored.slice(0, 4));
        if (Number.isFinite(y) && y > 1900) return y;
    }
    return ctx.fallbackYear;
}

function envOf(ctx: ElectricityCtx, cell?: CellContext<ElectricityReadingRow>): ElectricityEnv {
    return { contextYear: contextYearOf(ctx, cell) };
}

const numText = (v: number | null | undefined): string =>
    v === null || v === undefined ? '' : String(v);

/** A centred lane. `cell-classes` only knows `align: 'right'`, so centring is the cell's. */
function Centre({ children }: { children: React.ReactNode }) {
    return <span className="block w-full truncate text-center">{children}</span>;
}

/** The remark lane's icon — one rendering, used for a stored remark and a typed one. */
function RemarkIcon({ text }: { text: string }) {
    const filled = text.trim().length > 0;
    return (
        <span
            title={filled ? text : undefined}
            className={cn(
                'flex w-full items-center justify-center',
                filled ? 'text-primary' : 'text-muted-foreground/30',
            )}
        >
            <MessageSquareText className="size-3" aria-hidden="true" />
        </span>
    );
}

// ═══ The commit verdict ═════════════════════════════════════════════════════════

/** A verdict that refuses nothing. The module reads only `ok`; the patch is never used. */
const PARSE_OK: ColumnParseResult = { ok: true, patch: {} };

/**
 * THE commit verdict for a column, and it is `parseElectricityField` — the same function
 * the SAVE runs.
 *
 * **A BLANK cell commits without complaint.** The save refuses a cleared DATE and a
 * cleared METER — correctly, at SAVE, where a reading without either cannot exist. At
 * COMMIT it would mean clearing a cell you are about to retype raises a toast that stays
 * until you dismiss it. Every other v2 sheet draws the line in exactly the same place.
 */
function makeParse(field: ElectricityField) {
    return (
        text: string,
        ctx: ElectricityCtx,
        cell?: CellContext<ElectricityReadingRow>,
    ): ColumnParseResult => {
        if (text.trim() === '') return PARSE_OK;
        const verdict = parseElectricityField(field, text, envOf(ctx, cell));
        return verdict.ok ? { ok: true, patch: { [field]: verdict.value } } : verdict;
    };
}

/** The four seams every editable column shares. */
function editSeams(
    field: ElectricityField,
): Partial<ColumnSpec<ElectricityReadingRow, ElectricityCtx>> {
    return {
        editable: (_row, ctx) => ctx.canEdit,
        parse: makeParse(field),
        normalize: (text, ctx, cell) => normalizeElectricityField(field, text, envOf(ctx, cell)),
        cleanPasted: (raw, ctx) => cleanPastedElectricityCell(field, raw, envOf(ctx)),
    };
}

// ═══ Columns ════════════════════════════════════════════════════════════════════
//
// Widths STARTED as the live grid's, column for column, and four of them were wrong here
// for a reason that does not show up in a diff: the live grid pads its cells `px-1`, while
// the module's cell is `px-2` and reserves a 1px selection-box gutter on all four sides.
// **A cell's usable width here is `declared − 18`** — about one character at `text-xs`
// narrower than the same declaration next door. So DATE (a full `yyyy-MM-dd`), the two
// meter readings, DIFF and TTL KWH are widened against their longest REAL value; nothing
// is narrowed. The 20px delete column is absent because deleting is not built.
//
// `cellKind` says what KIND of editor each lane would want, and `readonly` / `derived` are
// read by `columnAcceptsEdit` and `columnSelectable`, so they are load-bearing.

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
        title: 'Reading date (yyyy-MM-dd). A typed 8/21 becomes 2026-08-21 when you leave the cell.',
        // A full `yyyy-MM-dd` in mono at `text-xs` is ~72px and this lane is CENTRED, so
        // it cannot lean on either margin: 72 + 18 of chrome = 90, against a declared 80.
        width: 92,
        align: 'center',
        cellKind: 'date',
        clipboardValue: (r) => r.reading_date ?? '',
        format: (r) => <Centre><span className="font-mono">{r.reading_date ?? ''}</span></Centre>,
        ...editSeams('reading_date'),
    },
    {
        key: 'meter',
        label: 'METER',
        title: `Meter name — half of the natural key. The canonical set is ${KNOWN_METERS.join(' · ')}; anything else is a new meter.`,
        width: 120,
        align: 'center',
        cellKind: 'select',
        clipboardValue: (r) => r.meter ?? '',
        format: (r) => <Centre><span className="font-mono">{r.meter ?? ''}</span></Centre>,
        ...editSeams('meter'),
    },
    {
        key: 'start_kwh',
        label: 'START KWH',
        title: 'Start meter reading (kWh)',
        // Floored by the HEADER here, not the value: `START KWH` is nine characters at
        // `text-[11px]` uppercase with `tracking-wide` (~69px) against 80 − 17 = 63, so it
        // truncated to `START K…` on every render.
        width: 92,
        align: 'right',
        cellKind: 'number',
        calcType: 'SUM',
        numericValue: (r) => r.start_kwh ?? null,
        clipboardValue: (r) => numText(r.start_kwh),
        format: (r) => numText(r.start_kwh),
        ...editSeams('start_kwh'),
    },
    {
        key: 'end_kwh',
        label: 'END KWH',
        title: 'End meter reading (kWh)',
        // `END KWH` fits at 80; it matches START anyway. A meter pair rendered at two
        // different widths reads as two different quantities.
        width: 92,
        align: 'right',
        cellKind: 'number',
        calcType: 'SUM',
        numericValue: (r) => r.end_kwh ?? null,
        clipboardValue: (r) => numText(r.end_kwh),
        format: (r) => numText(r.end_kwh),
        ...editSeams('end_kwh'),
    },
    {
        key: 'diff',
        label: 'DIFF',
        title: 'END − START (kWh). Previews what you have typed; a selection total reads the saved figures.',
        // Renders `d.toFixed(2)` — a real meter delta reaches `12345.67`, eight mono
        // characters ≈ 58px, + 18 of chrome = 76 against a declared 70.
        width: 80,
        align: 'right',
        // Never editable, but a rectangle MAY cover it — a run of computed figures is the
        // most useful thing on a sheet to add up.
        cellKind: 'readonly',
        selectable: true,
        calcType: 'SUM',
        // The row, not the buffer: see the header — the pill reports what is SAVED.
        numericValue: (r) => {
            const d = diffKwhOf(numText(r.start_kwh), numText(r.end_kwh));
            return d >= 0 ? d : null;
        },
        clipboardValue: (r) => {
            const d = diffKwhOf(numText(r.start_kwh), numText(r.end_kwh));
            return d >= 0 ? d.toFixed(2) : '';
        },
        format: (r, ctx) => {
            const d = diffKwhOf(ctx.cellText(r.id, 'start_kwh'), ctx.cellText(r.id, 'end_kwh'));
            return d > 0 ? <span className="text-muted-foreground">{d.toFixed(2)}</span> : null;
        },
    },
    {
        key: 'meter_multiplier',
        label: 'MULT',
        title: 'Meter multiplier — must be above 0 (the database refuses a zero). A blank cell saves as 120.',
        width: 70,
        align: 'right',
        cellKind: 'number',
        calcType: 'AVERAGE',
        numericValue: (r) => r.meter_multiplier ?? null,
        clipboardValue: (r) => numText(r.meter_multiplier),
        format: (r) => numText(r.meter_multiplier),
        ...editSeams('meter_multiplier'),
    },
    {
        key: 'consumption',
        label: 'TTL KWH',
        title: 'DIFF × MULT (kWh consumed). Previews what you have typed; a selection total reads the saved figures.',
        // DIFF × MULT, and the multiplier is in the tens — so this is the WIDEST figure on
        // the sheet by an order of magnitude. Grouped to two decimals, `1,234,567.89` is
        // twelve mono characters ≈ 87px, + 18 = 105 against a declared 90.
        width: 108,
        align: 'right',
        cellKind: 'readonly',
        selectable: true,
        calcType: 'SUM',
        numericValue: (r) => {
            const c = consumptionOf(
                numText(r.start_kwh), numText(r.end_kwh), numText(r.meter_multiplier),
            );
            return c > 0 ? c : null;
        },
        clipboardValue: (r) => {
            const c = consumptionOf(
                numText(r.start_kwh), numText(r.end_kwh), numText(r.meter_multiplier),
            );
            return c > 0 ? c.toFixed(2) : '';
        },
        format: (r, ctx) => {
            const c = consumptionOf(
                ctx.cellText(r.id, 'start_kwh'),
                ctx.cellText(r.id, 'end_kwh'),
                ctx.cellText(r.id, 'meter_multiplier'),
            );
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
        title: 'Remarks. Typed inline — the lane stays an icon, and the full text is on its tooltip.',
        // 96 rather than the live grid's 50: the lane is now TYPEABLE, and the module's
        // editor is a plain input filling the cell, so a 50px box is not somewhere a
        // sentence can be typed. The icon still centres; nothing else about the lane moved.
        width: 96,
        align: 'center',
        cellKind: 'text',
        clipboardValue: (r) => r.remarks ?? '',
        // The live grid hides the text behind a message icon and a popover. A popover
        // editor is not built here, so the icon is what the lane RENDERS — for a stored
        // remark through `format`, and for an unsaved one through `formatEdited`, which is
        // what keeps a dirty cell from suddenly showing raw text where every other row
        // shows a glyph.
        format: (r) => <RemarkIcon text={r.remarks ?? ''} />,
        formatEdited: (text) => <RemarkIcon text={text} />,
        ...editSeams('remarks'),
    },
];

// ═══ Row families ═══════════════════════════════════════════════════════════════
//
// Two families. `occupies()` is what answers per cell, and it is what says the ordinal
// RENDERS while the caret steps over it (`addressable: false`).
//
// **A BLANK ROW carries the typeable lanes only.** A row that exists nowhere has no
// ordinal and no derivation to show — `format` runs against a stored row and a draft has
// none — so returning a slot for DIFF or TTL would paint an empty cell the caret can sit
// in and a range can total, over a row with nothing behind it.

function buildSlots() {
    const reading = new Map<string, CellSlot>();
    const draft = new Map<string, CellSlot>();
    for (const c of COLUMNS) {
        const editable = isElectricityEditField(c.key);
        reading.set(c.key, {
            field: c.key,
            editable,
            // The three lanes nobody types into — the ordinal, DIFF and TTL KWH — RENDER a
            // value and are sweepable where the column says so, but the caret steps over
            // them. That is the middle answer `occupies()` exists to give.
            ...(editable ? {} : { addressable: false }),
        });
        if (editable) draft.set(c.key, { field: c.key, editable: true });
    }
    return { reading, draft };
}

const SLOTS = buildSlots();

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
            occupies: (colKey) => SLOTS.reading.get(colKey) ?? null,
        },
    ],
    [
        'draft',
        {
            kind: 'draft',
            height: ROW_H,
            addressable: true,
            occupies: (colKey) => SLOTS.draft.get(colKey) ?? null,
        },
    ],
]);

const ROW_RULES: Record<string, string> = {
    reading: 'border-b border-b-border/30',
    draft: 'border-b border-b-border/30',
};

// ═══ Props — the SAME shape the live grid takes ═════════════════════════════════
//
// `ElectricityGridProps` is not exported by the live file and this migration may not edit
// it, so the shape is restated here rather than imported. Keep the two in step: the whole
// point of the side-by-side is that `electricity-view.tsx` can hand either component the
// identical props.

export interface ElectricityGridV2Props {
    initialData: ElectricityReadingRow[];
    /**
     * **Load-bearing since this sheet can save.** The tab holds its rows in CLIENT state
     * (`components/electricity-lazy-tab.tsx` fetches through a server action into
     * `useState`), so `router.refresh()` cannot bring a saved row back — only this can. It
     * stays optional so the component's shape is unchanged for a caller that has not
     * threaded it yet, and the sheet says so out loud when it is missing rather than
     * quietly showing stale rows after a successful save.
     */
    onSaveSuccess?: () => void | Promise<void>;
    /**
     * The year a bare `8/21` means when the row itself cannot say — the period the tab is
     * showing. Optional: absent, the newest dated reading in view is the fallback, and the
     * current year is the fallback's fallback.
     */
    periodYear?: number | null;
}

export function ElectricityGridV2({
    initialData, onSaveSuccess, periodYear,
}: ElectricityGridV2Props) {
    // No status-bar wiring, and no local selection count: `BlackwoodTable` publishes the
    // real aggregates to the status bar ITSELF, through an optional provider. Two writers
    // to one pill is a flicker, and the one that wins is whichever effect runs last.

    const router = useRouter();
    const [refreshing, startTransition] = React.useTransition();
    const [saving, setSaving] = React.useState(false);
    const busy = saving || refreshing;

    // Column layout the operator owns for this session — resize only. Held locally: the
    // TABLE has no opinion about persistence, and this sheet does not own
    // `user_table_settings`.
    const [settings, setSettings] = React.useState<TableSettings>({});

    const rows = initialData;

    /**
     * The date a blank row starts on — the live grid's own seed (`createEmptyRow`), so a
     * reading entered from either surface on the same day is dated identically. It is a
     * DEFAULT, not an edit: it never makes a row dirty, and the strip above the sheet says
     * it out loud, because a value nobody typed must not reach the ledger unseen.
     */
    const draftDefaultDate = React.useMemo(() => new Date().toISOString().split('T')[0], []);

    const fallbackYear = React.useMemo(() => {
        if (periodYear !== null && periodYear !== undefined) return periodYear;
        for (const r of rows) {
            const y = Number((r.reading_date ?? '').slice(0, 4));
            if (Number.isFinite(y) && y > 1900) return y;
        }
        return new Date().getFullYear();
    }, [rows, periodYear]);

    const byId = React.useMemo(() => {
        const m = new Map<string, ElectricityReadingRow>();
        for (const r of rows) m.set(r.id, r);
        return m;
    }, [rows]);

    const storedText = React.useCallback(
        (rowId: string, field: string): string => {
            if (isDraftKey(rowId)) return draftSeedText(field, draftDefaultDate);
            return storedFieldText(byId.get(rowId) ?? null, field);
        },
        [byId, draftDefaultDate],
    );

    // THE single journalled writer. Every mutation in this grid — an inline commit, a
    // Delete, a paste, an Escape revert, undo and redo — goes through `edits.applyEdits`.
    const edits = useTableEdits({ canonicalText: storedText, isDraft: isDraftKey });

    // ── The blank-row pool ───────────────────────────────────────────────────────
    //
    // `onAddDrafts` returns the ids it created SYNCHRONOUSLY, because a paste that runs
    // past the last blank row needs them inside the same gesture — and those ids ride on
    // the journal step, so one Ctrl+Z takes back the paste AND the rows it grew.
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

    const items = React.useMemo<GridRow<ElectricityReadingRow>[]>(() => {
        const list: GridRow<ElectricityReadingRow>[] = rows.map((r) => ({
            kind: 'reading', id: r.id, data: r,
        }));
        for (const id of draftIds) list.push({ kind: 'draft', id });
        return list;
    }, [rows, draftIds]);

    // `ctx` MUST be referentially stable — it is a dependency of the column resolution, of
    // every editability verdict and of every cell's `format`. `edits.cellText` is stable
    // across keystrokes by construction (it reads the edit map through a ref), which is
    // what lets the derived lanes preview without re-resolving the columns.
    const ctx = React.useMemo<ElectricityCtx>(
        () => ({
            dense: true,
            canEdit: true,
            cellText: edits.cellText,
            fallbackYear,
            draftDefaultDate,
        }),
        [edits.cellText, fallbackYear, draftDefaultDate],
    );

    const unsaved = React.useMemo(
        () => countUnsavedWork(edits.dirtyRecords, edits.dirtyDrafts),
        [edits.dirtyRecords, edits.dirtyDrafts],
    );

    const rowClassFor = React.useCallback((item: GridRow<ElectricityReadingRow>): string => {
        // A blank row reads as a blank row, so the end of the period is visible without a
        // heading announcing it.
        if (item.kind === 'draft') return 'group bg-muted/10 transition-colors duration-150 hover:bg-muted/30';
        return 'group transition-colors duration-150 hover:bg-muted/50';
    }, []);

    // Held so the strip can say where the caret is without reaching into a class name.
    const [state, setState] = React.useState<TableState>({
        activeCell: null,
        isEditing: false,
        selection: null,
    });

    /**
     * Put the sheet back in step with the database.
     *
     * `onSaveSuccess` is the one that matters: this tab fetches its rows into client state,
     * so it is the only path that can bring a saved row back. `router.refresh()` runs
     * beside it because `saveBulkElectricity` calls `revalidatePath('/production')` and the
     * server tree around this sheet should not be left stale — it is not what reloads the
     * rows.
     */
    const reload = React.useCallback(async () => {
        await onSaveSuccess?.();
        startTransition(() => router.refresh());
    }, [onSaveSuccess, router]);

    const commit = React.useCallback(
        async (plan: ElectricitySavePlan) => {
            const counts = { updates: plan.updates.length, inserts: plan.inserts.length };
            setSaving(true);
            try {
                const res = await saveBulkElectricity({
                    inserts: plan.inserts,
                    updates: plan.updates,
                    // Deleting is not built on this sheet — see the header.
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
                    // The blank rows became real readings: drop them, then top the pool
                    // back up so the run under the sheet stays the same length (Sheets
                    // never shrinks it either).
                    const consumed = new Set(plan.insertedDraftIds);
                    setDraftIds((prev) => [
                        ...prev.filter((id) => !consumed.has(id)),
                        ...makeDraftIds(plan.insertedDraftIds.length),
                    ]);
                }
                toast.success(saveSuccessMessage(counts));
                if (!onSaveSuccess) {
                    // Said out loud rather than left to look like a lost save: the rows
                    // ARE stored, but this sheet cannot refetch them without its host.
                    toast.info('The rows are saved. This sheet cannot reload itself here — switch period or reload the page to see them.');
                }
                await reload();
            } catch (cause) {
                errorToast('Saving the electricity sheet failed', {
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
     * posted the good rows and let the server refuse the rest would leave the sheet
     * genuinely half-saved with the refusals still on screen.
     */
    const handleSave = React.useCallback(() => {
        if (unsaved.total === 0 || busy) return;

        const plan = buildElectricitySavePlan({
            edits: edits.edits,
            dirtyRecords: edits.dirtyRecords,
            dirtyDrafts: edits.dirtyDrafts,
            draftIds,
            rowsById: byId,
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
    }, [unsaved.total, busy, edits, draftIds, byId, draftDefaultDate, fallbackYear, commit]);

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
                    {rows.length} reading{rows.length === 1 ? '' : 's'} this period
                </span>
                <span className="font-mono">
                    {state.activeCell ? `r${state.activeCell.row + 1}·c${state.activeCell.col + 1}` : '—'}
                </span>
                <span className="font-mono">
                    · new rows are {draftDefaultDate} · {DRAFT_METER} · ×{DRAFT_MULTIPLIER} unless you type otherwise
                </span>
                <span>
                    Typing, saving and new rows are live; the METER dropdown, row delete and the remarks
                    popover are not built — <strong className="font-semibold">Current</strong> above returns
                    to the Classic grid.
                </span>

                <div className="ml-auto flex items-center gap-2" data-grid-chrome>
                    {unsaved.total > 0 ? (
                        <span className="animate-fade-in rounded-sm border border-amber-500/40 bg-amber-500/10 px-1.5 py-0.5 font-medium text-amber-700 dark:text-amber-400">
                            {describeUnsavedWork(unsaved, { record: 'edited reading', draft: 'new reading' })} unsaved
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
                        data-testid="save-electricity"
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

            <BlackwoodTable<ElectricityReadingRow, ElectricityCtx>
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
                drafts={{ enabled: true, defaultCount: DEFAULT_DRAFT_ROWS }}
                onAddDrafts={onAddDrafts}
                onRemoveDrafts={onRemoveDrafts}
                onRestoreDrafts={onRestoreDrafts}
                rowRules={ROW_RULES}
                rowClassFor={rowClassFor}
                onStateChange={setState}
                emptyMessage="Awaiting Production Manager sync — no readings for this period. Type into a blank row to add one."
                className={GRID_HEIGHT}
            />
        </div>
    );
}
