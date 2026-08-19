'use client';

// ─────────────────────────────────────────────────────────────────────────────────
// flec-inventory-grid-v2.tsx — the Cenapro flec-inventory ledger on the universal
// table module, built BESIDE `flec-inventory-client.tsx` and reachable only on
// `?grid=v2`. That file is untouched and remains the production path.
//
// READ-ONLY, AND STRUCTURALLY SO. No `ColumnSpec` below declares a `parse`, and
// `columnAcceptsEdit` falls back to `spec.parse !== undefined` — so the editor,
// Delete/Backspace and the paste loop's per-cell guard all refuse at every
// coordinate. Nothing here imports a writing action. `cenapro_set_opening_balance`
// (the APPEND-ONLY openings writer) is deliberately unreachable from this file.
//
// The row family still declares its honest `editable` flag per slot: that is the
// ROW's half of the verdict, the two halves are ANDed, and it is what a later
// editing pass builds on. Setting `editable: () => true` on a SPEC would open real
// edit sessions — do not.
//
// Why the wrapper clamps its own width: `BlackwoodTable` renders `width: 100%` +
// `minWidth: Σ widths` + an explicit `<col width>` per column, and under
// `table-layout: fixed` a table wider than its columns scales ALL of them
// proportionally — while the sticky `left` offsets keep using the DECLARED widths.
// Clamping to `useTableColumns(...).minWidth` (the module's own resolved sum, so it
// tracks a resize and a hidden column) makes the stretch unreachable. See
// `lib/table/CONTEXT.md` → "Stage 1D at scale".
// ─────────────────────────────────────────────────────────────────────────────────

import * as React from 'react';

import { BlackwoodTable } from '@/components/shared/table';
import type { TableSummaryRow } from '@/components/shared/table/BlackwoodTable';
import type { ColumnSpec, GridRow, RowKind } from '@/lib/table';
import { useTableColumns } from '@/lib/hooks/use-table-columns';
import { useTableEdits } from '@/lib/hooks/use-table-edits';
import { cn } from '@/lib/utils';

import type {
    FlecBalanceRow,
    FlecLedgerRow,
    OpeningBalanceRow,
    OpeningBalanceHistoryRow,
} from '../types';

// ─── Props — deliberately identical to FlecInventoryClientProps ──────────────────
//
// That component's props interface is module-private and I am not permitted to edit
// it to export one, so this is a matching declaration. `page.tsx` builds ONE props
// object and spreads it into whichever component the flag picked, which is what
// guarantees both sides read the identical payload.
export interface FlecInventoryGridV2Props {
    warehouse: string;
    startDate: string;
    balances: FlecBalanceRow[];
    ledger: FlecLedgerRow[];
    openings: OpeningBalanceRow[];
    history: OpeningBalanceHistoryRow[];
    loadError: string | null;
}

type Ctx = { readonly warehouse: string };

const dash = <span className="text-muted-foreground/40">—</span>;

/**
 * A text cell, always wrapped in an element.
 *
 * The module's interactive layer is a FLEX container that clips
 * (`overflow-hidden whitespace-nowrap`), but `text-overflow` on a flex container does
 * nothing for an anonymous text item — so a bare string clips with a hard edge and no
 * ellipsis, and a truncated value is indistinguishable from a short one. The element child
 * picks up `[&>*]:text-ellipsis` from `cell-classes.ts`; the bare string cannot.
 */
function txt(v: string | null | undefined): React.ReactNode {
    return v ? <span>{v}</span> : dash;
}

/** Integer flec counts, right-aligned mono. A 0 reads as 0, a null as a dash. */
function intText(v: number | null | undefined): React.ReactNode {
    if (v === null || v === undefined) return dash;
    return Number(v).toLocaleString('en-US', { maximumFractionDigits: 0 });
}

/** Kilograms — one decimal, matching the existing client's `Kg Moved` column. */
function kgText(v: number | null | undefined): React.ReactNode {
    if (v === null || v === undefined) return dash;
    return Number(v).toLocaleString('en-US', {
        minimumFractionDigits: 1,
        maximumFractionDigits: 1,
    });
}

function num(v: number | null | undefined): number | null {
    return v === null || v === undefined || Number.isNaN(Number(v)) ? null : Number(v);
}

/** Clipboard/TSV form: a bare number, never a grouped one — Excel must parse it. */
function rawNum(v: number | null | undefined): string {
    const n = num(v);
    return n === null ? '' : String(n);
}

// ─── Column table ────────────────────────────────────────────────────────────────
//
// Same nine columns, same order and same widths as the existing client's ledger
// table, so the two sides are directly comparable column by column.
const SPECS: readonly ColumnSpec<FlecLedgerRow, Ctx>[] = [
    {
        key: 'recv_date',
        label: 'RECV',
        width: 104,
        pin: 'start',
        align: 'left',
        cellKind: 'readonly',
        // Rendered verbatim from the stored string — never through `new Date()`, which
        // is where a timezone silently moves a receipt to the previous day.
        format: (r) => txt(r.recv_date ? String(r.recv_date).slice(0, 10) : null),
        clipboardValue: (r) => (r.recv_date ? String(r.recv_date).slice(0, 10) : ''),
    },
    {
        key: 'grade_code',
        label: 'GRADE',
        width: 64,
        align: 'left',
        cellKind: 'readonly',
        format: (r) => txt(r.grade_code),
        clipboardValue: (r) => r.grade_code ?? '',
    },
    {
        key: 'side',
        label: 'SIDE',
        width: 52,
        align: 'left',
        cellKind: 'readonly',
        format: (r) => txt(r.side),
        clipboardValue: (r) => r.side ?? '',
    },
    {
        key: 'disposition_kind',
        label: 'DISPOSITION',
        width: 120,
        align: 'left',
        cellKind: 'readonly',
        title: 'How this movement left or entered the warehouse',
        format: (r) => txt(r.disposition_kind),
        clipboardValue: (r) => r.disposition_kind ?? '',
    },
    {
        key: 'kg_moved',
        label: 'KG MOVED',
        width: 100,
        align: 'right',
        cellKind: 'readonly',
        format: (r) => kgText(r.kg_moved),
        numericValue: (r) => num(r.kg_moved),
        clipboardValue: (r) => rawNum(r.kg_moved),
        calcType: 'SUM',
    },
    {
        key: 'opening_seed',
        label: 'OPENING',
        // Floored by its own HEADER: `OPENING` is seven characters at `text-[11px]`
        // uppercase with `tracking-wide` (~54px) against 72 − 17 = 55. One pixel of margin
        // is not a margin — a saved column order or a resized neighbour and it truncates.
        width: 80,
        align: 'right',
        cellKind: 'readonly',
        title: 'The stated opening count this row is measured forward from',
        format: (r) => intText(r.opening_seed),
        numericValue: (r) => num(r.opening_seed),
        clipboardValue: (r) => rawNum(r.opening_seed),
    },
    {
        key: 'flec_in',
        label: 'IN',
        width: 64,
        align: 'right',
        cellKind: 'readonly',
        format: (r) => intText(r.flec_in),
        numericValue: (r) => num(r.flec_in),
        clipboardValue: (r) => rawNum(r.flec_in),
        calcType: 'SUM',
        summaryLane: 'figure',
    },
    {
        key: 'flec_out',
        label: 'OUT',
        width: 64,
        align: 'right',
        cellKind: 'readonly',
        format: (r) => intText(r.flec_out),
        numericValue: (r) => num(r.flec_out),
        clipboardValue: (r) => rawNum(r.flec_out),
        calcType: 'SUM',
    },
    {
        key: 'running_balance',
        label: 'BALANCE',
        width: 80,
        align: 'right',
        cellKind: 'readonly',
        title: 'Opening + cumulative in − cumulative out, computed in SQL',
        format: (r) => intText(r.running_balance),
        numericValue: (r) => num(r.running_balance),
        clipboardValue: (r) => rawNum(r.running_balance),
        summaryLane: 'total',
    },
];

// Every lane a ledger row occupies. One family only — this sheet has no sub-rows —
// so `occupies` answers for all nine columns and never returns null for a data row.
const LEDGER_SLOTS: ReadonlyMap<string, { field: string; editable: boolean }> = new Map(
    SPECS.map((s) => [s.key, { field: s.key, editable: false }]),
);

const ROW_H = 28;
const GROUP_H = 24;

export function FlecInventoryGridV2(props: FlecInventoryGridV2Props) {
    const { warehouse, startDate, balances, ledger, loadError } = props;

    const ctx = React.useMemo<Ctx>(() => ({ warehouse }), [warehouse]);
    const specs = React.useMemo(() => SPECS, []);
    const totalWidth = useTableColumns(specs, null, undefined).minWidth;

    // ── Row families ─────────────────────────────────────────────────────────────
    const kinds = React.useMemo<ReadonlyMap<string, RowKind<FlecLedgerRow>>>(
        () =>
            new Map<string, RowKind<FlecLedgerRow>>([
                [
                    'movement',
                    {
                        kind: 'movement',
                        height: ROW_H,
                        addressable: true,
                        occupies: (colKey) => LEDGER_SLOTS.get(colKey) ?? null,
                    },
                ],
                // Chrome — never addressable, never in `navRows`, so the caret can
                // neither be moved onto one nor land on one by click.
                [
                    'group-header',
                    {
                        kind: 'group-header',
                        height: GROUP_H,
                        addressable: false,
                        occupies: () => null,
                    },
                ],
            ]),
        [],
    );

    // ── The flatten: one grade-heading chrome row per grade run, then its rows ────
    //
    // Keyed on a run ORDINAL rather than the grade code: a chrome row's key is the
    // virtualiser's React key, and keying on a value that can repeat (a grade that
    // appears in two non-adjacent runs) would collide.
    const items = React.useMemo<GridRow<FlecLedgerRow>[]>(() => {
        const out: GridRow<FlecLedgerRow>[] = [];
        let prevGrade: string | null = null;
        let run = 0;
        for (const row of ledger) {
            const grade = row.grade_code ?? '';
            if (grade !== prevGrade) {
                run += 1;
                out.push({ kind: 'group-header', key: `grade-${run}` });
                prevGrade = grade;
            }
            out.push({ kind: 'movement', id: String(row.id), data: row });
        }
        return out;
    }, [ledger]);

    const byId = React.useMemo(() => {
        const m = new Map<string, FlecLedgerRow>();
        for (const r of ledger) m.set(String(r.id), r);
        return m;
    }, [ledger]);

    const storedText = React.useCallback(
        (rowId: string, field: string): string => {
            const row = byId.get(rowId);
            if (!row) return '';
            const spec = specs.find((s) => s.key === field);
            return spec?.clipboardValue ? spec.clipboardValue(row) : '';
        },
        [byId, specs],
    );

    const noDrafts = React.useCallback(() => false, []);
    const edits = useTableEdits({ canonicalText: storedText, isDraft: noDrafts });

    // ── The grade heading, inside the body ───────────────────────────────────────
    //
    // Returns the row's CELLS, never a `<tr>` — the container owns the row element
    // in both scopes, and `TableVirtuoso` measures rows off `<tbody>`'s children.
    // A cell over a pinned column stays OPAQUE (a solid token, never glass), or the
    // scrolling rows bleed through it.
    const renderChromeRow = React.useCallback(
        (item: GridRow<FlecLedgerRow>, api: { cols: readonly ColumnSpec<FlecLedgerRow, Ctx>[]; colCount: number }) => {
            if (item.kind !== 'group-header' || !('key' in item)) return null;
            const ord = Number(String(item.key).split('-')[1] ?? '0');
            // Recover the grade from the first movement after this heading.
            let grade = '';
            let seen = 0;
            for (const it of items) {
                if (it.kind === 'group-header') seen += 1;
                else if (seen === ord && 'data' in it) {
                    grade = it.data.grade_code ?? '';
                    break;
                }
            }
            const rows = ledger.filter((r) => (r.grade_code ?? '') === grade);
            const totalIn = rows.reduce((a, r) => a + (num(r.flec_in) ?? 0), 0);
            const totalOut = rows.reduce((a, r) => a + (num(r.flec_out) ?? 0), 0);
            return (
                <>
                    <td
                        className="frozen-col frozen-edge h-6 border-b border-border/40 bg-muted px-2 py-1 text-left"
                        style={{ left: 0 }}
                    >
                        <span className="text-[11px] font-semibold tracking-wide">
                            {grade || '—'}
                        </span>
                    </td>
                    <td
                        className="h-6 border-b border-border/40 bg-muted/25 px-2 py-1 text-left"
                        colSpan={Math.max(1, api.colCount - 1)}
                    >
                        <span className="font-mono text-[10px] text-muted-foreground">
                            {rows.length} movement{rows.length === 1 ? '' : 's'} · in{' '}
                            {totalIn.toLocaleString('en-US')} · out{' '}
                            {totalOut.toLocaleString('en-US')}
                        </span>
                    </td>
                </>
            );
        },
        [items, ledger],
    );

    // ── The footer, on the module's declared lanes ───────────────────────────────
    const summaryRows = React.useMemo<TableSummaryRow[]>(() => {
        const totalIn = ledger.reduce((a, r) => a + (num(r.flec_in) ?? 0), 0);
        const totalOut = ledger.reduce((a, r) => a + (num(r.flec_out) ?? 0), 0);
        const closing = balances.reduce((a, b) => a + (num(b.current_flec) ?? 0), 0);
        return [
            {
                key: 'total',
                label: `Σ ${ledger.length} movement${ledger.length === 1 ? '' : 's'}`,
                figure: totalIn.toLocaleString('en-US'),
                note: `out ${totalOut.toLocaleString('en-US')}`,
                total: closing.toLocaleString('en-US'),
            },
        ];
    }, [ledger, balances]);

    // ── The read-only balances strip ─────────────────────────────────────────────
    const balanceChips = React.useMemo(
        () =>
            balances.map((b) => ({
                key: `${b.grade_code}-${b.side}`,
                label: `${b.grade_code} ${b.side}`,
                opening: num(b.opening_seed) ?? 0,
                current: num(b.current_flec) ?? 0,
            })),
        [balances],
    );

    return (
        <div className="flex h-full min-h-0 flex-col">
            <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border bg-muted/30 px-3 py-1.5">
                <span className="text-xs font-semibold">{warehouse}</span>
                <span className="font-mono text-[11px] text-muted-foreground">
                    as of {startDate}
                </span>
                <span className="text-muted-foreground/40">·</span>
                {balanceChips.length === 0 ? (
                    <span className="text-[11px] text-muted-foreground">
                        No balances for this warehouse and date.
                    </span>
                ) : (
                    balanceChips.map((c) => (
                        <span
                            key={c.key}
                            className="rounded border border-border bg-background px-1.5 py-0.5 font-mono text-[10px]"
                            title={`${c.label} — opening ${c.opening}, current ${c.current}`}
                        >
                            {c.label}{' '}
                            <span className="text-muted-foreground">{c.opening}</span>
                            {' → '}
                            <span className="font-semibold">{c.current}</span>
                        </span>
                    ))
                )}
                <span className="ml-auto text-[10px] text-muted-foreground">
                    Read-only preview — selection, the right-click menu, the selection summary and
                    column resize are live. Use Current to edit openings or switch warehouse.
                </span>
            </div>

            {loadError ? (
                <div className="flex shrink-0 items-center gap-2 border-b border-destructive/40 bg-destructive/10 px-3 py-1.5">
                    <span className="text-xs text-destructive">{loadError}</span>
                    <button
                        type="button"
                        className="rounded border border-destructive/40 px-1.5 py-0.5 text-[10px] text-destructive"
                        onClick={() => {
                            void navigator.clipboard?.writeText(loadError);
                        }}
                    >
                        Copy
                    </button>
                </div>
            ) : null}

            <div className="min-h-0 flex-1 overflow-hidden">
                <div
                    className={cn('h-full overflow-hidden')}
                    style={{ maxWidth: totalWidth }}
                >
                    <BlackwoodTable<FlecLedgerRow, Ctx>
                        items={items}
                        kinds={kinds}
                        specs={specs}
                        ctx={ctx}
                        edits={edits}
                        storedText={storedText}
                        scope="focus"
                        renderChromeRow={renderChromeRow}
                        summaryRows={summaryRows}
                        emptyMessage={
                            <span className="text-xs text-muted-foreground">
                                No flec movements for {warehouse} on or after {startDate}.
                            </span>
                        }
                    />
                </div>
            </div>
        </div>
    );
}
