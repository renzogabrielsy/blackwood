'use client';

import * as React from 'react';
import { Copy } from 'lucide-react';

import { BlackwoodTable } from '@/components/shared/table';
import type { TableChromeRowApi } from '@/components/shared/table';
import { pinnedOffsets } from '@/lib/table';
import type { ColumnSpec, GridRow, RowKind, TableSettings } from '@/lib/table';
import { useTableColumns } from '@/lib/hooks/use-table-columns';
import { useTableEdits } from '@/lib/hooks/use-table-edits';
import { Button } from '@/components/ui/button';
import { errorToast } from '@/lib/toast';
import { cn } from '@/lib/utils';
import type { Tables } from '@/types/supabase';
import type { FleconBagMovementRow } from '../actions';

// ═════════════════════════════════════════════════════════════════════════════════
// FLECON bag movement matrix on the Blackwood Table — `?grid=v2`, READ-ONLY, built
// BESIDE the live matrix.
//
// `flecon-bags-view.tsx` is production and is not edited by one character. This file
// renders the SAME `balances` + `movements` the server already fetched for that view, on
// the universal grid, so the two can be compared row-for-row on the same real data
// (`handoffs/2026-08-17-universal-table-phase-1-and-the-side-by-side-method.md`).
//
// ── READ-ONLY, AND STRUCTURALLY SO ──────────────────────────────────────────────
// This screen is already read-only in production: the daily FLECON BAGGED sync is the
// sole writer of `flecon_bag_movements`, and the ONE mutation the live view owns is a
// DIMENSION edit (the per-column nickname). Neither is reachable from here. Every column
// is `cellKind: 'readonly'`, no column carries a `parse`, and no `renderEditor` is passed
// — so `columnAcceptsEdit` is false at every coordinate and an editor can never open. No
// server action is imported (`updateFleconBagNickname` deliberately is NOT), no draft
// pool, no context menu. Nothing in this file can change a byte in the database.
//
// ── NO PRICE GATE, AND THAT IS A FACT ABOUT THE DOMAIN ──────────────────────────
// There is no ₱ anywhere in the FLECON bag domain — the fact table carries a signed
// integer quantity and nothing else — so `canViewPrices()` is not imported here for the
// same reason `flecon-bags-view.tsx` does not import it: there is nothing to gate. That
// is also why `Ctx` is `null` below rather than a settings object: this grid needs no
// ambient state at all, and `null` is stable by construction (the module requires `ctx`
// to be referentially stable, and a primitive cannot fail that).
//
// ── WHAT IT DOES DO ─────────────────────────────────────────────────────────────
// Cell selection and rectangular ranges, the full keyboard including Ctrl/Cmd+Arrow ·
// Home/End · Ctrl+Home/End · PageUp/PageDown, Ctrl/Cmd+C to the clipboard as TSV, column
// resize, and the frozen DATE + PARTICULAR block at the left edge — all from the module,
// none of it re-implemented here.
//
// ── "NEVER CRUSH, ALWAYS SCROLL", AND THE ONE THING IT COSTS ────────────────────
// The live view computes `minWidth = W_DATE + W_PARTICULAR + n × MIN_BAG_W` by hand
// because its bag columns are dynamic. The module gives the same guarantee without the
// arithmetic: `useTableColumns(...).minWidth` is `minTableWidth(cols)` is Σ of the
// RESOLVED widths, which for the widths below is exactly 76 + 200 + 14 × 72 = 1284 — and
// unlike a hand-written sum it stays right when a column is resized or hidden. That is
// the number the `<table>`'s own `minWidth` already carries, and the number the clamp
// below reads.
//
// The clamp is why this file reads it at all. `BlackwoodTable` renders its `<table>` as
// `width: 100%` + `minWidth: Σ widths` inside a horizontal scroller, and it gives EVERY
// column an explicit `<col width>`. Under `table-layout: fixed` a table wider than its
// columns scales all of them proportionally — measured in Chrome at a 1600px container:
// a declared 76px column renders 94.7px and a declared 200px one renders 249.2px. The
// sticky `left` offsets are computed from the DECLARED widths, so a stretched table
// would pin PARTICULAR ~19px inside DATE and the frozen block would overlap itself.
// Clamping the grid's own width to Σ widths makes the stretch unreachable, which is the
// same thing `rc-movement-matrix.tsx` achieves with `width: 'max-content'`.
//
// The cost, stated plainly: the live view lets the 14 bag columns STRETCH to fill a wide
// monitor (its bag `<col>`s carry no width, so `table-fixed` hands them the slack while
// the two frozen columns keep their pixel widths). This grid sizes to content instead —
// on a wide screen the matrix ends at that width and the page is empty to its right.
// Any column can still be dragged wider.
// ═════════════════════════════════════════════════════════════════════════════════

// ─── Geometry — the live view's numbers, unchanged ───────────────────────────────

const W_DATE = 76;
const W_PARTICULAR = 200;
/**
 * The live view treats this as a FLOOR (its bag columns have no declared width and share
 * the slack). Here it is the declared width, because the module needs one per column to
 * lay out the `<colgroup>` and to keep the frozen offsets honest.
 */
const W_BAG = 72;

const MOVEMENT_H = 32; // h-8, Excel Standard
const MONTH_H = 28; // the live view's h-7 month rule
const LANE_H = 34; // Forwarded Balance / Current Balance

// ─── Formatting — reused verbatim from the live view ─────────────────────────────

/** COALESCE null → 0 for the all-nullable balance view columns. Never a recompute. */
const nz = (v: number | null): number => v ?? 0;

/** Plain integer with thousands separators. Blank for 0 (Excel blanks-are-zero). */
const fmtInt = (n: number): string => (n === 0 ? '' : n.toLocaleString('en-US'));

const MONTHS = [
    'JANUARY', 'FEBRUARY', 'MARCH', 'APRIL', 'MAY', 'JUNE',
    'JULY', 'AUGUST', 'SEPTEMBER', 'OCTOBER', 'NOVEMBER', 'DECEMBER',
] as const;
const MONTHS_SHORT = [
    'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
    'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
] as const;

/**
 * A signed movement quantity: `+N` emerald, `−N` (a real minus glyph) red, `0` muted.
 * The live view's `SignedQty`, kept identical so the two sides read the same.
 */
function signedQty(q: number): React.ReactNode {
    if (q > 0) {
        return (
            <span className="text-emerald-600 dark:text-emerald-400">
                +{q.toLocaleString('en-US')}
            </span>
        );
    }
    if (q < 0) {
        return (
            <span className="text-red-600 dark:text-red-400">
                &minus;{Math.abs(q).toLocaleString('en-US')}
            </span>
        );
    }
    return <span className="text-muted-foreground">0</span>;
}

// ─── The dimension ───────────────────────────────────────────────────────────────

/**
 * One bag-type column: the code the movement rows intersect on, the internal label, the
 * operator's nickname, and the two SQL-computed figures the balance lanes show.
 */
interface BagColumn {
    bagTypeId: string;
    code: string;
    label: string;
    nickname: string | null;
    opening: number;
    balance: number;
}

/** Stable per-column identity — the live view's `bagTypeId || code` fallback. */
const bagKey = (c: BagColumn): string => `bag:${c.bagTypeId || c.code}`;

// ─── Rows ────────────────────────────────────────────────────────────────────────

/**
 * What a rendered row of this matrix carries.
 *
 * Three families, and only the first is a coordinate. The month rules and the two
 * balance lanes are CHROME (`RowKind.addressable: false`), so they never enter `navRows`
 * and the keyboard space is byte-identical with and without them — but they still ride as
 * items, because the virtualiser has to measure the rows it may not visit.
 */
type FleconRow =
    | { kind: 'movement'; date: string; particular: string; code: string; qty: number }
    | { kind: 'month'; label: string }
    | { kind: 'lane'; lane: 'forwarded' | 'current' };

type FleconItem = GridRow<FleconRow>;

const FIELD_DATE = 'date';
const FIELD_PARTICULAR = 'particular';

/** What a cell HOLDS as text — the jump keys' `filled` probe and the clipboard's source. */
function fieldText(row: FleconRow, field: string): string {
    if (row.kind !== 'movement') return '';
    if (field === FIELD_DATE) return row.date;
    if (field === FIELD_PARTICULAR) return row.particular;
    // A bag lane: the quantity, but only in the ONE column this movement intersects.
    return field === `bag:${row.code}` ? String(row.qty) : '';
}

// ─── Props ───────────────────────────────────────────────────────────────────────

/** The SAME props `FleconBagsView` receives, so the two are swappable on one object. */
export interface FleconBagsGridV2Props {
    balances: Tables<'view_flecon_bag_balance'>[];
    movements: FleconBagMovementRow[];
    error?: string;
}

// ─── The component ───────────────────────────────────────────────────────────────

export function FleconBagsGridV2({ balances, movements, error }: FleconBagsGridV2Props) {
    // Error toast — persist-until-dismissed + Copy, enforced by `errorToast()` (HARD
    // RULE; never sonner's `toast.error` directly). The inline banner below repeats it
    // with its own Copy button, exactly as the live view does.
    React.useEffect(() => {
        if (error) errorToast(error);
    }, [error]);

    // The bag-type dimension in sheet order — the view arrives sorted by `sort_order`.
    const columns = React.useMemo<BagColumn[]>(
        () =>
            balances.map((b) => ({
                bagTypeId: b.bag_type_id ?? '',
                code: b.code ?? '',
                label: b.label ?? b.code ?? '',
                nickname: b.nickname,
                opening: nz(b.opening),
                balance: nz(b.balance),
            })),
        [balances],
    );

    /** Column key → its bag type, so a chrome row can tile the RESOLVED column table. */
    const bagByKey = React.useMemo(() => {
        const m = new Map<string, BagColumn>();
        for (const c of columns) m.set(bagKey(c), c);
        return m;
    }, [columns]);

    // ── Columns ──────────────────────────────────────────────────────────────────
    //
    // Every one is `readonly` + `selectable`: a run of any lane on this sheet is worth
    // sweeping and adding up, and none of them may be typed into.
    const specs = React.useMemo<ColumnSpec<FleconRow, null>[]>(() => {
        const out: ColumnSpec<FleconRow, null>[] = [
            {
                key: FIELD_DATE,
                label: 'DATE',
                title: 'Transaction date (yyyy-MM-dd)',
                width: W_DATE,
                pin: 'start',
                cellKind: 'readonly',
                selectable: true,
                clipboardValue: (row) => fieldText(row, FIELD_DATE),
                format: (row) =>
                    row.kind === 'movement' ? (
                        // MM-dd on screen (a string slice — no `Date()`, so no timezone
                        // can move a movement to the previous day), full date on hover.
                        <span className="font-mono tabular-nums" title={row.date}>
                            {row.date.slice(5)}
                        </span>
                    ) : null,
            },
            {
                key: FIELD_PARTICULAR,
                label: 'PARTICULAR',
                width: W_PARTICULAR,
                pin: 'start',
                cellKind: 'readonly',
                selectable: true,
                clipboardValue: (row) => fieldText(row, FIELD_PARTICULAR),
                format: (row) =>
                    row.kind === 'movement' && row.particular ? (
                        // Excel Standard: truncate, full text on hover. A native `title`
                        // rather than a Radix tooltip — 16 columns × a virtualised window
                        // is the wrong place to mount a portal per cell.
                        <span className="block truncate" title={row.particular}>
                            {row.particular}
                        </span>
                    ) : null,
            },
        ];

        for (const c of columns) {
            const key = bagKey(c);
            const code = c.code;
            out.push({
                key,
                // The live view's header: the operator's nickname when there is one, else
                // the internal label. The full internal label stays in the `title`.
                label: c.nickname?.trim() || c.label,
                // A bag-type header is OPERATOR TEXT (`flecon_bag_types.nickname`), so its
                // length is not something this file may assume — and at 72px a one-line
                // truncating header turns fourteen columns into fourteen ellipses. Two
                // lines, bounded by `line-clamp-2`; a short nickname renders exactly as
                // before.
                headerWrap: true,
                title: c.label,
                width: W_BAG,
                align: 'right',
                cellKind: 'readonly',
                selectable: true,
                calcType: 'SUM',
                numericValue: (row) =>
                    row.kind === 'movement' && row.code === code ? row.qty : null,
                clipboardValue: (row) =>
                    row.kind === 'movement' && row.code === code ? String(row.qty) : '',
                format: (row) =>
                    row.kind === 'movement' && row.code === code ? signedQty(row.qty) : null,
            });
        }

        return out;
    }, [columns]);

    // Column widths the operator drags. LOCAL state, deliberately: persisting them would
    // mean a write, and this grid has no write path of any kind.
    const [settings, setSettings] = React.useState<TableSettings>({});

    /**
     * The clamp described in the header, taken from the MODULE'S OWN column resolution
     * rather than a second sum of my own — `minWidth` is Σ of the resolved widths, which
     * is the same number the live view spells out as
     * `W_DATE + W_PARTICULAR + n × MIN_BAG_W` and stays right after a column resize.
     * Re-deriving it here would be a second definition of the column table.
     */
    const totalWidth = useTableColumns(specs, null, settings).minWidth;

    // ── Row families ─────────────────────────────────────────────────────────────
    const kinds = React.useMemo<ReadonlyMap<string, RowKind<FleconRow>>>(() => {
        const slots = new Map<string, { field: string; editable: boolean }>([
            [FIELD_DATE, { field: FIELD_DATE, editable: false }],
            [FIELD_PARTICULAR, { field: FIELD_PARTICULAR, editable: false }],
        ]);
        for (const c of columns) {
            const key = bagKey(c);
            slots.set(key, { field: key, editable: false });
        }

        return new Map<string, RowKind<FleconRow>>([
            // A movement occupies EVERY column. A bag cell the movement does not
            // intersect is an EMPTY cell of the spreadsheet, not an absent one — it can
            // be swept into a selection and copied as a blank, which is what a run down
            // one bag column has to be able to do.
            ['movement', {
                kind: 'movement',
                height: MOVEMENT_H,
                addressable: true,
                occupies: (colKey) => slots.get(colKey) ?? null,
            }],
            ['month', { kind: 'month', height: MONTH_H, addressable: false, occupies: () => null }],
            ['forwarded', { kind: 'forwarded', height: LANE_H, addressable: false, occupies: () => null }],
            ['balance', { kind: 'balance', height: LANE_H, addressable: false, occupies: () => null }],
        ]);
    }, [columns]);

    const rowRules = React.useMemo<Record<string, string>>(
        () => ({ movement: 'border-b border-b-border/50' }),
        [],
    );

    // ── The flatten ──────────────────────────────────────────────────────────────
    //
    // The ONE place the shape of this sheet is decided: the Forwarded Balance lane, then
    // the movements in the order the server sent them (`transaction_date` ASC →
    // `source_row` nulls-first → `created_at` ASC — the sort is the server's and is not
    // re-done here), a month rule wherever the `yyyy-MM` prefix changes, and the Current
    // Balance lane last.
    //
    // The month key carries a RUN ORDINAL. `computeItemKey` is the virtualiser's React
    // key, so two items sharing one is a real defect — and a month CAN appear twice if
    // rows ever arrive out of order. Keying by run makes that unrepresentable rather than
    // merely unlikely, and it costs one integer.
    const items = React.useMemo<FleconItem[]>(() => {
        if (movements.length === 0) return [];

        const out: FleconItem[] = [
            { kind: 'forwarded', id: 'lane:forwarded', data: { kind: 'lane', lane: 'forwarded' } },
        ];

        let lastMonth = '';
        let run = 0;
        for (const m of movements) {
            const monthKey = m.transaction_date.slice(0, 7); // yyyy-MM
            if (monthKey !== lastMonth) {
                run += 1;
                const idx = Number(m.transaction_date.slice(5, 7)) - 1;
                out.push({
                    kind: 'month',
                    id: `month:${run}:${monthKey}`,
                    data: { kind: 'month', label: MONTHS[idx] ?? monthKey },
                });
                lastMonth = monthKey;
            }
            out.push({
                kind: 'movement',
                id: m.id,
                data: {
                    kind: 'movement',
                    date: m.transaction_date,
                    particular: m.particular,
                    code: m.bag_code,
                    qty: m.qty_delta,
                },
            });
        }

        out.push({ kind: 'balance', id: 'lane:current', data: { kind: 'lane', lane: 'current' } });
        return out;
    }, [movements]);

    const byId = React.useMemo(() => {
        const m = new Map<string, FleconRow>();
        for (const item of items) if ('data' in item) m.set(item.id, item.data);
        return m;
    }, [items]);

    const storedText = React.useCallback(
        (rowId: string, field: string): string => {
            const row = byId.get(rowId);
            return row ? fieldText(row, field) : '';
        },
        [byId],
    );

    // The module's single writer. Nothing in this grid ever calls `applyEdits`, so it
    // holds an empty map for the life of the component — but `BlackwoodTable` requires
    // the port, and handing it a real (idle) instance is honest where a stub would not be.
    const noDrafts = React.useCallback(() => false, []);
    const edits = useTableEdits({ canonicalText: storedText, isDraft: noDrafts });

    // ── The three chrome rows ────────────────────────────────────────────────────
    //
    // `renderChromeRow` returns the row's CELLS, never a `<tr>` — the container owns the
    // row element in both scopes. Two layout rules it obeys rather than guesses at: a
    // lane of span 0 renders NO cell (`colSpan={0}` is "to the end of the column group"
    // in HTML, the opposite of nothing), and a cell under a pinned column stays fully
    // OPAQUE or the scrolling rows bleed through it.
    const renderChromeRow = React.useCallback(
        (item: FleconItem, api: TableChromeRowApi<FleconRow, null>) => {
            if (!('data' in item)) return null;
            const row = item.data;
            const left = pinnedOffsets(api.cols);
            const frozenCount = left.length;

            // A frozen chrome cell: solid token, cumulative `left`, and the seam on the
            // last pinned column.
            const frozenCls = (ci: number, tone: string) =>
                cn(
                    'border-b border-b-border/50 px-2 py-1 align-middle',
                    'frozen-col',
                    tone,
                    ci === frozenCount - 1 ? 'frozen-edge' : 'border-r border-r-border/40',
                );

            if (row.kind === 'month') {
                // The month rule: one real cell per PINNED column (they cannot be spanned
                // — each carries its own `left`), then ONE spanning cell across the rest.
                // Addressed by column KEY rather than by position, so the label cannot end
                // up in the wrong lane if the pinned block is ever reordered.
                const span = api.colCount - frozenCount;
                return (
                    <>
                        {api.cols.slice(0, frozenCount).map((spec, ci) => (
                            <td
                                key={spec.key}
                                className={cn(
                                    frozenCls(ci, 'bg-muted'),
                                    spec.key === FIELD_PARTICULAR &&
                                        'text-[11px] font-semibold uppercase tracking-wide text-muted-foreground',
                                )}
                                style={{ height: MONTH_H, left: left[ci] }}
                            >
                                {spec.key === FIELD_PARTICULAR ? row.label : null}
                            </td>
                        ))}
                        {span > 0 ? (
                            <td
                                colSpan={span}
                                aria-hidden="true"
                                className="border-b border-b-border/50 bg-muted px-1 py-1"
                                style={{ height: MONTH_H }}
                            />
                        ) : null}
                    </>
                );
            }

            if (row.kind !== 'lane') return null;

            // The two balance lanes. Forwarded reads each type's `opening`, Current reads
            // its `balance` — BOTH straight from `view_flecon_bag_balance`, never summed
            // here (CLAUDE.md: the UI does not recompute a SQL balance).
            const isCurrent = row.lane === 'current';
            const tone = isCurrent ? 'bg-muted' : 'bg-background';
            return (
                <>
                    {api.cols.map((spec, ci) => {
                        const frozen = ci < frozenCount;
                        const style: React.CSSProperties = { height: LANE_H };
                        if (frozen) style.left = left[ci];

                        if (frozen) {
                            return (
                                <td
                                    key={spec.key}
                                    className={cn(
                                        frozenCls(ci, tone),
                                        spec.key === FIELD_PARTICULAR &&
                                            'text-[11px] font-semibold uppercase tracking-wide text-muted-foreground',
                                    )}
                                    style={style}
                                >
                                    {spec.key === FIELD_PARTICULAR
                                        ? isCurrent
                                            ? 'Current Balance'
                                            : 'Forwarded Balance'
                                        : null}
                                </td>
                            );
                        }

                        const bag = bagByKey.get(spec.key);
                        const value = bag ? (isCurrent ? bag.balance : bag.opening) : null;
                        return (
                            <td
                                key={spec.key}
                                title={
                                    bag
                                        ? `${bag.label}: ${(value ?? 0).toLocaleString('en-US')}`
                                        : undefined
                                }
                                className={cn(
                                    'border-b border-b-border/50 border-r border-r-border/40 px-2 py-1 text-right align-middle font-mono tabular-nums',
                                    tone,
                                    isCurrent
                                        ? 'font-bold'
                                        : 'text-muted-foreground',
                                    isCurrent &&
                                        (value ?? 0) < 0 &&
                                        'text-red-600 dark:text-red-400',
                                )}
                                style={style}
                            >
                                {value === null
                                    ? null
                                    : isCurrent
                                      ? value.toLocaleString('en-US')
                                      : fmtInt(value)}
                            </td>
                        );
                    })}
                </>
            );
        },
        [bagByKey],
    );

    const rowClassFor = React.useCallback((item: FleconItem): string | undefined => {
        // `group` is what lets the module's pinned cells repaint the hover tint opaquely
        // (`cell-classes.ts` puts `group-hover:bg-muted` on every pinned `<td>`).
        return item.kind === 'movement'
            ? 'group transition-all duration-150 hover:bg-muted/50'
            : undefined;
    }, []);

    // ── The strip above the grid ─────────────────────────────────────────────────
    const rangeLabel = React.useMemo(() => {
        if (movements.length === 0) return '';
        const first = movements[0].transaction_date;
        const last = movements[movements.length - 1].transaction_date;
        const firstMo = MONTHS_SHORT[Number(first.slice(5, 7)) - 1] ?? '';
        const lastMo = MONTHS_SHORT[Number(last.slice(5, 7)) - 1] ?? '';
        const firstYr = first.slice(0, 4);
        const lastYr = last.slice(0, 4);
        if (firstYr === lastYr) {
            return firstMo === lastMo ? `${firstMo} ${firstYr}` : `${firstMo}–${lastMo} ${firstYr}`;
        }
        return `${firstMo} ${firstYr}–${lastMo} ${lastYr}`;
    }, [movements]);

    // The `3 × 4 selected` chip that used to live here is GONE, and so is the
    // `TableState` it was built from.
    //
    // It existed because the module computed the aggregates inside `useTableInteraction`
    // and handed a consumer only the RANGE — and a consumer cannot re-total a range in
    // nav-row coordinates it does not own, so a SIZE was the only honest thing this file
    // could print. `BlackwoodTable` now publishes SUM/AVERAGE/COUNT/MIN/MAX to the app's
    // floating status bar itself. A dimensions chip beside a real total is not a second
    // opinion, it is noise.

    return (
        <div className="flex h-full min-h-0 flex-col gap-3">
            {/* Inline error banner, in addition to the toast — persists on screen with
                its own Copy button, per the Error Toasts HARD RULE. */}
            {error ? (
                <div className="flex shrink-0 items-start justify-between gap-3 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm">
                    <span className="min-w-0 break-words">{error}</span>
                    <Button
                        size="sm"
                        variant="ghost"
                        className="h-6 shrink-0 gap-1 px-2 text-xs"
                        onClick={() => navigator.clipboard.writeText(error)}
                    >
                        <Copy className="size-3" />
                        Copy
                    </Button>
                </div>
            ) : null}

            {/* A solid token, not glass: this strip is a `shrink-0` flex child, not a
                sticky surface, and a `backdrop-filter` over an opaque page paints nothing
                while still costing a compositor layer. */}
            <div className="flex shrink-0 flex-wrap items-baseline gap-2">
                <h2 className="text-sm font-semibold tracking-tight">FLECON Bag Movement</h2>
                <span className="font-mono text-[11px] text-muted-foreground">
                    · {columns.length} bag types · {movements.length} movements
                    {rangeLabel ? ` · ${rangeLabel}` : ''}
                </span>
                <span className="rounded-sm border border-amber-500/40 px-1 text-[11px] font-medium text-amber-600 dark:text-amber-400">
                    grid=v2
                </span>
                <span className="text-[11px] text-muted-foreground">
                    Read-only. Selection, keyboard, copy, the right-click menu, the
                    selection summary and column resize are live; the editable column
                    nicknames, the phone summary and the bottom-pinned Current Balance are
                    not.
                </span>
            </div>

            {/* The max-width clamp — see the header. It is what keeps `table-fixed` from
                scaling the declared column widths on a wide monitor and drifting the
                frozen offsets. Narrower than this, the module's own scroller scrolls. */}
            <div
                className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-md border border-border"
                style={{ maxWidth: totalWidth }}
            >
                <BlackwoodTable<FleconRow, null>
                    items={items}
                    kinds={kinds}
                    specs={specs}
                    ctx={null}
                    settings={settings}
                    onSettingsChange={setSettings}
                    edits={edits}
                    storedText={storedText}
                    scope="endless"
                    rowRules={rowRules}
                    rowClassFor={rowClassFor}
                    renderChromeRow={renderChromeRow}
                    // Open at the BOTTOM, where the newest movements and the Current
                    // Balance lane are — the live view's `scrollTop = scrollHeight` on
                    // mount, expressed as an index because this scope is virtualised. A
                    // RAW array position, which is what this prop takes.
                    initialTopMostItemIndex={Math.max(0, items.length - 1)}
                    emptyMessage="No bag movements recorded yet — the daily FLECON BAGGED sync will populate this matrix."
                    className="min-h-0 flex-1"
                />
            </div>
        </div>
    );
}
