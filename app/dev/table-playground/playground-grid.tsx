'use client';

import * as React from 'react';

import { BlackwoodTable } from '@/components/shared/table';
import type { TableChromeRowApi, TableState } from '@/components/shared/table';
import { FloatingStatusBar } from '@/components/floating-status-bar';
import { useStatusBar } from '@/components/providers/status-bar-context';
import { DEFAULT_FIRST_ITEM_INDEX, needsGroupSpacer, shiftFirstItemIndex } from '@/lib/table';
import type { ColumnSpec, GridRow, RowKind, TableSettings } from '@/lib/table';
import { useTableEdits } from '@/lib/hooks/use-table-edits';

// ─────────────────────────────────────────────────────────────────────────────────
// The Blackwood Table playground — a fixture, not a feature.
//
// It exists so the parity suite (`e2e/table/parity.spec.ts`) can drive the real grid
// with **no login, no Supabase and no tenant module**: the data source is an in-memory
// array built from a pure function of the row index, so every assertion is a fixed
// string rather than whatever happened to be in the database this morning.
//
// It deliberately exercises the six shapes the first real consumer structurally cannot
// produce, which is the whole reason the module was generalised:
//
//   • a pin: 'start' block of TWO columns and a pin: 'end' actions column (the old
//     `frozen: boolean` could only ever describe a prefix),
//   • a second ROW FAMILY — every 7th record carries 2 child sub-rows that occupy only
//     three of the columns, so `occupies()` has something to answer,
//   • a column hidden by a `ctx` flag (how a price boundary reaches a grid),
//   • a pool of blank draft rows a paste can grow into,
//   • a LANE-SPANNING chrome row inside the body — a group heading rendered through
//     `renderChromeRow`, which the footer-only `summaryRows` cannot express, and
//   • a bidirectional pager: `Load older` PREPENDS rows and decrements `firstItemIndex`
//     by the ITEMS added, in ONE state update, so the viewport does not move.
//
// The debug strip at the top is not decoration: it is what lets a test assert "the caret
// is on row 3, column 2" without reaching into a Tailwind class name.
// ─────────────────────────────────────────────────────────────────────────────────

export interface PlayRow {
    id: string;
    /** Group key — a blank spacer row is emitted on every change of it. */
    group: string;
    code: string;
    label: string;
    qty: number;
    rate: number;
    note: string;
    secret: string;
}

export interface PlayCtx {
    /** A column hidden for this viewer is ABSENT from the coordinate space, never blank. */
    showSecret: boolean;
    /**
     * Paint the whole cell on an out-of-band figure, through `ColumnSpec.cellClass` —
     * the seam that replaces "render a coloured pill inside `format`".
     */
    tintOutOfBand: boolean;
}

const RECORD_COUNT = 120;
/** Every Nth record carries child sub-rows. 7 is coprime with the group size below. */
const CHILD_EVERY = 7;
const GROUP_SIZE = 10;
/** How many OLDER records one press of `Load older` fetches. Exactly one group. */
const OLDER_BATCH = 10;

/** Deterministic by construction: row `i` is a pure function of `i`, forever. */
export function makeRecords(count = RECORD_COUNT): PlayRow[] {
    return Array.from({ length: count }, (_, i) => ({
        id: `r${i}`,
        group: `g${Math.floor(i / GROUP_SIZE)}`,
        code: `R-${String(i).padStart(3, '0')}`,
        label: `Item ${i}`,
        qty: (i + 1) * 10,
        rate: Math.round((1.5 + i * 0.25) * 100) / 100,
        note: `note ${i}`,
        secret: `s${i}`,
    }));
}

/**
 * One page of OLDER records, as a keyset pager fetches them: deterministic, childless,
 * and each batch its own group — so a prepend adds a heading too, which is precisely why
 * `firstItemIndex` must be decremented by ITEMS rather than by the 10 records asked for.
 */
export function makeOlder(startAt: number, size = OLDER_BATCH): PlayRow[] {
    return Array.from({ length: size }, (_, i) => {
        const n = startAt + i;
        return {
            id: `o${n}`,
            group: `o${Math.floor(n / GROUP_SIZE)}`,
            code: `O-${String(n).padStart(3, '0')}`,
            label: `Older ${n}`,
            qty: (n + 1) * 5,
            rate: 1,
            note: `older note ${n}`,
            secret: `os${n}`,
        };
    });
}

function makeChildren(records: readonly PlayRow[]): Map<string, PlayRow[]> {
    const out = new Map<string, PlayRow[]>();
    records.forEach((r, i) => {
        if (i % CHILD_EVERY !== 0) return;
        out.set(r.id, [0, 1].map((n) => ({
            ...r,
            id: `${r.id}c${n}`,
            label: `sub ${i}.${n}`,
            qty: n + 1,
            note: `child note ${i}.${n}`,
        })));
    });
    return out;
}

const num = (v: string): { ok: true; patch: Record<string, unknown> } | { ok: false; error: string } => {
    const t = v.trim();
    if (t === '') return { ok: true, patch: {} };
    const n = Number(t.replace(/,/g, ''));
    if (!Number.isFinite(n)) return { ok: false, error: `"${v}" is not a number.` };
    return { ok: true, patch: { value: n } };
};

const text = (v: string) => ({ ok: true as const, patch: { value: v } });

const COLUMNS: ColumnSpec<PlayRow, PlayCtx>[] = [
    {
        key: 'num', label: '#', width: 48, pin: 'start', align: 'right',
        cellKind: 'derived', hideable: false, resizable: false,
        format: (row) => <span className="text-muted-foreground">{row.id.replace(/\D/g, '')}</span>,
    },
    {
        key: 'code', label: 'CODE', width: 110, pin: 'start',
        cellKind: 'text', parse: text, clipboardValue: (r) => r.code,
        format: (row) => <span className="font-mono">{row.code}</span>,
    },
    {
        key: 'label', label: 'LABEL', width: 180,
        cellKind: 'text', parse: text, clipboardValue: (r) => r.label,
        format: (row) => row.label,
    },
    {
        key: 'qty', label: 'QTY', width: 90, align: 'right', summaryLane: 'figure',
        cellKind: 'number', parse: num, calcType: 'SUM',
        numericValue: (r) => r.qty,
        clipboardValue: (r) => String(r.qty),
        cleanPasted: (raw) => raw.replace(/[^0-9.\-]/g, ''),
        format: (row) => row.qty.toFixed(0),
    },
    {
        key: 'rate', label: 'RATE', width: 90, align: 'right',
        cellKind: 'number', parse: num, calcType: 'AVERAGE',
        numericValue: (r) => r.rate,
        clipboardValue: (r) => String(r.rate),
        cleanPasted: (raw) => raw.replace(/[^0-9.\-]/g, ''),
        format: (row) => row.rate.toFixed(2),
        // THE WHOLE CELL, not a badge inside it. Merged UNDER the cached class string, so
        // a selected out-of-band cell still reads as selected — which is the property the
        // spec asserts.
        cellClass: (row, ctx) =>
            ctx.tintOutOfBand && row !== null && row.rate > 2 ? 'bg-destructive/20' : undefined,
    },
    {
        // A header that WRAPS rather than truncating, and a rich label beside the plain
        // one. `label` stays the string — `title`, the resize handle's `aria-label` and
        // any consumer-built column menu all read it as text.
        key: 'note', label: 'NOTE', width: 200, headerWrap: true,
        labelNode: (
            <span data-testid="wrapped-header">
                NOTE — THE LONG FORM THAT USED TO TRUNCATE
            </span>
        ),
        cellKind: 'text', parse: text, clipboardValue: (r) => r.note,
        format: (row) => <span className="max-w-[200px] truncate">{row.note}</span>,
    },
    {
        key: 'secret', label: 'SECRET', width: 90,
        cellKind: 'text', parse: text,
        // The server decides; the table only obeys.
        visible: (ctx) => ctx.showSecret,
        format: (row) => row.secret,
    },
    {
        key: 'total', label: 'TOTAL', width: 110, align: 'right', summaryLane: 'total',
        // Never editable, but a range MAY cover it — a run of computed totals is the most
        // useful thing on a sheet to add up.
        cellKind: 'readonly', selectable: true, calcType: 'SUM',
        numericValue: (r) => Math.round(r.qty * r.rate * 100) / 100,
        clipboardValue: (r) => String(Math.round(r.qty * r.rate * 100) / 100),
        format: (row) => (row.qty * row.rate).toFixed(2),
    },
    {
        key: 'actions', label: '', width: 64, pin: 'end', align: 'center',
        cellKind: 'derived', resizable: false, hideable: false,
        format: () => <span className="text-muted-foreground">···</span>,
    },
];

/** Which columns a family occupies, and as what field. `null` ⇒ no cell there at all. */
const RECORD_FIELDS: Record<string, { field: string; editable: boolean }> = {
    num: { field: 'num', editable: false },
    code: { field: 'code', editable: true },
    label: { field: 'label', editable: true },
    qty: { field: 'qty', editable: true },
    rate: { field: 'rate', editable: true },
    note: { field: 'note', editable: true },
    secret: { field: 'secret', editable: true },
    total: { field: 'total', editable: false },
    actions: { field: 'actions', editable: false },
};

/** A child is NOT a small parent: it has no code, no rate, no total and no ordinal. */
const CHILD_FIELDS: Record<string, { field: string; editable: boolean }> = {
    label: { field: 'label', editable: true },
    qty: { field: 'qty', editable: true },
    note: { field: 'note', editable: true },
};

const KINDS: ReadonlyMap<string, RowKind<PlayRow>> = new Map<string, RowKind<PlayRow>>([
    ['record', {
        kind: 'record', height: 32, addressable: true,
        occupies: (colKey) => RECORD_FIELDS[colKey] ?? null,
    }],
    ['child', {
        kind: 'child', height: 26, addressable: true,
        occupies: (colKey) => CHILD_FIELDS[colKey] ?? null,
    }],
    ['draft', {
        kind: 'draft', height: 32, addressable: true,
        occupies: (colKey) => {
            const f = RECORD_FIELDS[colKey];
            if (!f) return null;
            // A blank row has no computed total and no ordinal to show.
            if (colKey === 'total' || colKey === 'num' || colKey === 'actions') return null;
            return f;
        },
    }],
    // A real row of the spreadsheet, and NOT addressable — the caret cannot land on one
    // by construction, so the coordinate space is byte-identical with and without spacers.
    ['spacer', { kind: 'spacer', height: 32, addressable: false, occupies: () => null }],
    // Also non-addressable, and it renders its OWN cells through `renderChromeRow` — a
    // heading that spans lanes, which the footer-only `summaryRows` cannot express.
    ['group-header', { kind: 'group-header', height: 28, addressable: false, occupies: () => null }],
]);

/**
 * The flat item array, as a PURE function of the records — the ONE place the shape of the
 * sheet is decided, so the pager can measure `items.length` either side of a prepend
 * instead of counting records and guessing.
 */
function buildRows(
    records: readonly PlayRow[],
    children: ReadonlyMap<string, PlayRow[]>,
): GridRow<PlayRow>[] {
    const out: GridRow<PlayRow>[] = [];
    let prevGroup: string | undefined;
    for (const r of records) {
        if (needsGroupSpacer(prevGroup, r.group)) out.push({ kind: 'spacer', key: `sp:${r.group}` });
        // A heading above EVERY group, the first one included — so a prepend adds a
        // heading AND a spacer the old leading group never needed, and the item delta is
        // 12 for 10 records.
        if (prevGroup !== r.group) out.push({ kind: 'group-header', key: `gh:${r.group}` });
        prevGroup = r.group;
        out.push({ kind: 'record', id: r.id, data: r });
        for (const c of children.get(r.id) ?? []) out.push({ kind: 'child', id: c.id, data: c });
    }
    return out;
}

function fieldText(row: PlayRow, field: string): string {
    switch (field) {
        case 'code': return row.code;
        case 'label': return row.label;
        case 'qty': return String(row.qty);
        case 'rate': return String(row.rate);
        case 'note': return row.note;
        case 'secret': return row.secret;
        // A read-only column still HOLDS a value, and `storedText` is what the jump keys
        // read to decide whether a cell is filled. Returning '' here would make a column
        // of computed totals read as a blank gap to Ctrl+Arrow.
        case 'total': return String(Math.round(row.qty * row.rate * 100) / 100);
        default: return '';
    }
}

/**
 * A readout of what the TABLE published to the app's floating status bar.
 *
 * The pill itself is mounted below and is what the suite really asserts against — this
 * strip exists so a failure says which number was wrong rather than "the text did not
 * match". Neither is wired to the grid: both read the shared provider, which is the whole
 * claim being tested (the table publishes, and a consumer wires nothing).
 */
function StatusBarReadout() {
    const { cellSelectionCount, cellAggregates } = useStatusBar();
    return (
        <>
            <span data-testid="bar-count" className="font-mono">{cellSelectionCount}</span>
            <span data-testid="bar-sum" className="font-mono">
                {cellAggregates ? cellAggregates.sum : 'none'}
            </span>
            <span data-testid="bar-calc" className="font-mono">
                {cellAggregates ? cellAggregates.recommendedCalcType : 'none'}
            </span>
        </>
    );
}

export function PlaygroundGrid({ scope = 'endless' }: { scope?: 'endless' | 'focus' }) {
    const [showSecret, setShowSecret] = React.useState(false);
    const [tintOutOfBand, setTintOutOfBand] = React.useState(false);
    /**
     * Whether the consumer PERSISTS column widths.
     *
     * Unchecked, `onSettingsChange` is not passed at all — which is the state nine of the
     * ten migrated grids were in, and the state in which the resize handle used to not
     * exist. The table now keeps the width itself, and the suite drags one to prove it.
     */
    const [managedWidths, setManagedWidths] = React.useState(true);
    const [settings, setSettings] = React.useState<TableSettings>({});
    const [state, setState] = React.useState<TableState>({ activeCell: null, isEditing: false, selection: null });

    const records = React.useMemo(() => makeRecords(), []);
    const children = React.useMemo(() => makeChildren(records), [records]);

    const byId = React.useMemo(() => {
        const m = new Map<string, PlayRow>();
        for (const r of records) m.set(r.id, r);
        for (const list of children.values()) for (const c of list) m.set(c.id, c);
        return m;
    }, [records, children]);

    const [draftIds, setDraftIds] = React.useState<string[]>(() =>
        Array.from({ length: 5 }, (_, i) => `d${i}`),
    );
    const draftSeq = React.useRef(5);

    /**
     * The pager's two halves in ONE piece of state, so a prepend and its index shift can
     * only ever be committed together. Two `useState`s would render the list once with
     * every row moved and jump it back on the next commit — which is the bug the base
     * exists to prevent, reintroduced by the shape of the state.
     */
    const [pager, setPager] = React.useState<{ older: PlayRow[]; firstItemIndex: number }>(
        () => ({ older: [], firstItemIndex: DEFAULT_FIRST_ITEM_INDEX }),
    );

    // `ctx` MUST be referentially stable — it is a dependency of the column resolution and
    // of every editability verdict, so a fresh object per render re-renders the sheet.
    const ctx = React.useMemo<PlayCtx>(
        () => ({ showSecret, tintOutOfBand }),
        [showSecret, tintOutOfBand],
    );

    const canonicalText = React.useCallback(
        (rowId: string, field: string) => {
            const row = byId.get(rowId);
            return row ? fieldText(row, field) : '';
        },
        [byId],
    );

    const isDraft = React.useCallback((rowId: string) => rowId.startsWith('d'), []);

    const edits = useTableEdits({ canonicalText, isDraft });

    const items = React.useMemo<GridRow<PlayRow>[]>(() => {
        const out = buildRows([...pager.older, ...records], children);
        for (const id of draftIds) out.push({ kind: 'draft', id });
        return out;
    }, [pager.older, records, children, draftIds]);

    /**
     * Prepend a page of older records and rebase the public index by the ITEMS that added
     * — measured off the flat array, never counted off the 10 records fetched. Both land
     * in one update, so the viewport does not move.
     */
    const loadOlder = React.useCallback(() => {
        setPager((prev) => {
            const older = [...makeOlder(prev.older.length), ...prev.older];
            return {
                older,
                firstItemIndex: shiftFirstItemIndex({
                    firstItemIndex: prev.firstItemIndex,
                    previousItemCount: buildRows([...prev.older, ...records], children).length,
                    nextItemCount: buildRows([...older, ...records], children).length,
                }),
            };
        });
    }, [records, children]);

    /**
     * A group heading, tiled onto the column table rather than guessed at: the pinned
     * block gets its own OPAQUE cell (any alpha and the scrolling rows bleed through it),
     * everything right of it is one span, and a lane of span 0 renders NO cell — because
     * `colSpan={0}` means "to the end of the column group" in HTML.
     */
    const renderChromeRow = React.useCallback(
        (item: GridRow<PlayRow>, api: TableChromeRowApi<PlayRow, PlayCtx>) => {
            if (item.kind !== 'group-header' || !('key' in item)) return null;
            const group = item.key.slice(item.key.indexOf(':') + 1);
            const rest = api.colCount - api.spans.frozen;
            const base = 'border-b border-b-border px-2 py-1 text-[11px] font-medium';
            return (
                <>
                    {api.spans.frozen > 0 ? (
                        <th
                            scope="row"
                            colSpan={api.spans.frozen}
                            className={`frozen-col frozen-edge bg-background text-left text-muted-foreground ${base}`}
                            style={{ left: 0 }}
                        >
                            GROUP
                        </th>
                    ) : null}
                    {rest > 0 ? (
                        <td
                            colSpan={rest}
                            data-group-heading={group}
                            className={`bg-muted text-left ${base}`}
                        >
                            {group}
                        </td>
                    ) : null}
                </>
            );
        },
        [],
    );

    const onAddDrafts = React.useCallback((count: number) => {
        const ids = Array.from({ length: count }, (_, i) => `d${draftSeq.current + i}`);
        draftSeq.current += count;
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

    const summaryRows = React.useMemo(
        () => [{
            key: 'total',
            label: 'TOTAL',
            figure: records.reduce((s, r) => s + r.qty, 0).toFixed(0),
            total: records.reduce((s, r) => s + r.qty * r.rate, 0).toFixed(2),
            sticky: true,
        }],
        [records],
    );

    const a = state.activeCell;
    const sel = state.selection;

    return (
        <div className="flex h-dvh flex-col bg-background text-foreground">
            <div className="flex shrink-0 flex-wrap items-center gap-3 border-b border-border px-3 py-2 text-xs">
                <span className="font-medium">Blackwood Table playground</span>
                <label className="flex items-center gap-1" data-grid-chrome>
                    <input
                        type="checkbox"
                        data-testid="toggle-secret"
                        checked={showSecret}
                        onChange={(e) => setShowSecret(e.target.checked)}
                    />
                    show hidden column
                </label>
                <label className="flex items-center gap-1" data-grid-chrome>
                    <input
                        type="checkbox"
                        data-testid="toggle-tint"
                        checked={tintOutOfBand}
                        onChange={(e) => setTintOutOfBand(e.target.checked)}
                    />
                    tint out-of-band cells
                </label>
                <label className="flex items-center gap-1" data-grid-chrome>
                    <input
                        type="checkbox"
                        data-testid="toggle-managed-widths"
                        checked={managedWidths}
                        onChange={(e) => setManagedWidths(e.target.checked)}
                    />
                    persist widths
                </label>
                <StatusBarReadout />
                <span data-testid="active-cell" className="font-mono">
                    {a ? `${a.row},${a.col}` : 'none'}
                </span>
                <span data-testid="editing" className="font-mono">
                    {state.isEditing ? 'editing' : 'idle'}
                </span>
                <span data-testid="selection" className="font-mono">
                    {sel ? `${sel.startRow},${sel.startCol},${sel.endRow},${sel.endCol}` : 'none'}
                </span>
                <span data-testid="dirty" className="font-mono">
                    {edits.dirtyRecords.size + edits.dirtyDrafts.size}
                </span>
                <span data-testid="undo-depth" className="font-mono">
                    {edits.canUndo ? 'can-undo' : 'no-undo'}
                </span>
                <button
                    type="button"
                    data-testid="load-older"
                    data-grid-chrome
                    onClick={loadOlder}
                    className="rounded border border-input px-2 py-0.5"
                >
                    Load older
                </button>
                <span data-testid="older-count" className="font-mono">
                    {pager.older.length}
                </span>
                <span data-testid="first-item-index" className="font-mono">
                    {pager.firstItemIndex}
                </span>
                <span data-testid="item-count" className="font-mono">
                    {items.length}
                </span>
                <button
                    type="button"
                    data-testid="reset"
                    data-grid-chrome
                    onClick={() => edits.reset()}
                    className="rounded border border-input px-2 py-0.5"
                >
                    Reset
                </button>
            </div>

            <BlackwoodTable<PlayRow, PlayCtx>
                items={items}
                kinds={KINDS}
                specs={COLUMNS}
                ctx={ctx}
                settings={settings}
                // Deliberately UNDEFINED when unmanaged: the point of the seam is that a
                // consumer which never wired per-user settings still gets a draggable
                // column, so the fixture has to be able to be that consumer.
                onSettingsChange={managedWidths ? setSettings : undefined}
                edits={edits}
                storedText={canonicalText}
                scope={scope}
                childKinds={['child']}
                draftKind="draft"
                drafts={{ enabled: true, defaultCount: 20 }}
                onAddDrafts={onAddDrafts}
                onRemoveDrafts={onRemoveDrafts}
                onRestoreDrafts={onRestoreDrafts}
                summaryRows={summaryRows}
                renderChromeRow={renderChromeRow}
                firstItemIndex={pager.firstItemIndex}
                onStateChange={setState}
                className="min-h-0 flex-1"
            />

            {/* The app's REAL pill, mounted here so the suite asserts against the thing
                the operator sees rather than against a fixture that merely mirrors it.
                It is fed by nothing in this file — `BlackwoodTable` publishes to the
                shared provider itself. */}
            <FloatingStatusBar />
        </div>
    );
}
