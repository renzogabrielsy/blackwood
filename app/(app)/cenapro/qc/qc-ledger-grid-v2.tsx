'use client';

// ─────────────────────────────────────────────────────────────────────────────────
// qc-ledger-grid-v2.tsx — the Cenapro QC ledger on the universal table module,
// built BESIDE `qc-ledger-client.tsx` and reachable only on `?grid=v2`. That file is
// untouched and remains the production path.
//
// READ-ONLY, AND STRUCTURALLY SO. No `ColumnSpec` below declares a `parse`, and
// `columnAcceptsEdit` falls back to `spec.parse !== undefined` — so the editor,
// Delete/Backspace and the paste loop's per-cell guard all refuse at every
// coordinate. Nothing here imports a writing action; `cenapro_save_*` is
// unreachable from this file.
//
// THE ROW MODEL, and why `occupies()` is load-bearing here.
//
// The sheet is ONE ROW PER DRAW, not per sample group — a weight belongs to a single
// draw. But a LAB READING covers the whole group, and the existing ledger puts those
// four metric cells on the group's FIRST draw only. So two row families share the
// column table and disagree about four of its columns:
//
//   • `draw-first` occupies all fifteen columns.
//   • `draw`       occupies eleven, and returns NULL for BD / ASH / GRIT / MC.
//
// `null` means "this row has no cell there" — not "an empty one". That single answer
// drives the keyboard (a vertical run steps over it), the paste (it never lands
// there), the selection pill (it is not totalled) and the tint (it is not painted).
// Getting it wrong is BUG-024, where a paste mapped block rows by arithmetic, wrote a
// parent's data into its sub-rows, and reported success.
//
// Width clamp: see `lib/table/CONTEXT.md` → "Stage 1D at scale" — a table wider than
// its columns scales all of them proportionally while the sticky offsets keep using
// the DECLARED widths, so a stretched sheet can pin a frozen column inside its
// neighbour. Clamping to `useTableColumns(...).minWidth` makes that unreachable.
//
// ── WIDTHS ARE NOT THE LIVE SHEET'S, AND THE REASON IS ONE NUMBER ───────────────
// This grid copied `qc-ledger-client.tsx`'s pixel widths column for column, and four of
// them were WRONG here for a reason invisible in the diff: the live sheet's identity
// widths are floored by a `px-1` cell, while the module's cell is `px-2` and reserves a
// 1px selection-box gutter on every side. **A cell's usable width here is `declared − 18`,
// not `declared − 8`** — a ten-pixel tax on every column, which is exactly the size of one
// character at `text-xs`. So a column measured to fit its longest value in the live sheet
// clips its last character here. DATE, PROD, WHSE and SIDE are widened below, each against
// its longest REAL value (`2026-08-01` = 71.03px, `WHSE 3` = 46.88px — MEASURED in the
// browser against the cell's own computed font, not estimated) rather than against its
// label.
// ─────────────────────────────────────────────────────────────────────────────────

import * as React from 'react';

import { BlackwoodTable } from '@/components/shared/table';
import type { TableSummaryRow } from '@/components/shared/table/BlackwoodTable';
import type { CellSlot, ColumnSpec, GridRow, RowKind } from '@/lib/table';
import { useTableColumns } from '@/lib/hooks/use-table-columns';
import { useTableEdits } from '@/lib/hooks/use-table-edits';
import { METRICS, type MetricKey } from '@/lib/cenapro/ccc-analysis';
import type { QcAggregate } from '@/lib/cenapro/ccc-analysis-view';

import type { QcDraw, QcGroup, QcLedgerDay, QcDrawOptions } from './data';

// ─── Props — deliberately identical to QcLedgerClientProps ───────────────────────
//
// That interface is module-private and I am not permitted to edit that file to export
// one, so this is a matching declaration. `page.tsx` builds ONE props object and
// spreads it into whichever component the flag picked, which is what guarantees both
// sides read the identical payload.
export interface QcLedgerGridV2Props {
    month: string;
    days: QcLedgerDay[];
    monthAgg: QcAggregate;
    monthKeys: string[];
    previousWtd: Record<MetricKey, number | null> | null;
    previousLabel: string | null;
    drawOptions: QcDrawOptions;
}

/** One rendered row: a draw, the group it belongs to, and whether it leads that group. */
interface QcRow {
    draw: QcDraw;
    group: QcGroup;
    isFirstOfGroup: boolean;
}

type Ctx = { readonly month: string };

const dash = <span className="text-muted-foreground/40">—</span>;

/**
 * A text cell.
 *
 * The `<span>` is not decoration. The module's interactive layer is a FLEX container and
 * clips (`overflow-hidden whitespace-nowrap`), but `text-overflow` on a flex container
 * does nothing for an anonymous text item — so a bare string clips with a hard edge and
 * no ellipsis, and the operator cannot tell a truncated value from a short one. The
 * element child picks up `[&>*]:text-ellipsis` from `cell-classes.ts`; the bare string
 * cannot.
 */
function txt(v: string | null | undefined): React.ReactNode {
    return v ? <span>{v}</span> : dash;
}

function num(v: number | null | undefined): number | null {
    return v === null || v === undefined || Number.isNaN(Number(v)) ? null : Number(v);
}

/** Weights — one decimal, grouped, the existing ledger's `WT kg` form. */
function wtText(v: number | null | undefined): React.ReactNode {
    const n = num(v);
    if (n === null) return dash;
    return n.toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
}

/** A lab metric — two decimals. BD carries three in the RC IN spec; QC uses two. */
function metricText(v: number | null | undefined): React.ReactNode {
    const n = num(v);
    if (n === null) return dash;
    return n.toFixed(2);
}

function intText(v: number | null | undefined): React.ReactNode {
    const n = num(v);
    if (n === null) return dash;
    return n.toLocaleString('en-US', { maximumFractionDigits: 0 });
}

/** Clipboard form: a bare number, never grouped — Excel must be able to parse it. */
function rawNum(v: number | null | undefined): string {
    const n = num(v);
    return n === null ? '' : String(n);
}

// ─── Column table — the existing ledger's fifteen, same order, same widths ───────
//
// "when · what · WHERE it came out of (whse · side · bags) · what source · into WHICH
// machine · how much · what the lab said" — the sentence the row already tells.
const SPECS: readonly ColumnSpec<QcRow, Ctx>[] = [
    {
        key: 'date',
        label: 'DATE',
        // 92, not the live ledger's 62. The live sheet pads its cells `px-1`; the module
        // pads `px-2` and reserves a 1px selection-box gutter on all four sides, so a
        // cell's usable width here is `declared − 18`.
        //
        // MEASURED IN THE BROWSER, not estimated: `2026-08-01` in this cell's own computed
        // font is **71.03px**, so the column needs 90. At 62 it had 44px of room and the
        // date was cut mid-value — and before the platform pass it did not even clip, it
        // painted straight over PROD, which is exactly the screenshot Renzo sent.
        width: 92,
        pin: 'start',
        align: 'left',
        cellKind: 'readonly',
        title: 'Receipt date at CCC',
        // Sliced from the stored string, never through `new Date()` — that round trip
        // is where a timezone silently moves a receipt to the previous day.
        format: (r) => txt(r.draw.recvDate ? String(r.draw.recvDate).slice(0, 10) : null),
        clipboardValue: (r) => (r.draw.recvDate ? String(r.draw.recvDate).slice(0, 10) : ''),
    },
    {
        key: 'prod',
        label: 'PROD',
        // Same value, same measurement, same width as DATE — see above.
        width: 92,
        align: 'left',
        cellKind: 'readonly',
        title: 'Production date of the material drawn',
        format: (r) => txt(r.draw.prodDate ? String(r.draw.prodDate).slice(0, 10) : null),
        clipboardValue: (r) => (r.draw.prodDate ? String(r.draw.prodDate).slice(0, 10) : ''),
    },
    {
        key: 'shift',
        label: 'SH',
        width: 40,
        align: 'left',
        cellKind: 'readonly',
        title: 'Shift',
        format: (r) => txt(r.draw.shift),
        clipboardValue: (r) => r.draw.shift ?? '',
    },
    {
        key: 'grade',
        label: 'GRADE',
        width: 62,
        align: 'left',
        cellKind: 'readonly',
        format: (r) => txt(r.draw.grade),
        clipboardValue: (r) => r.draw.grade ?? '',
    },
    {
        key: 'plant',
        label: 'PLANT',
        width: 88,
        align: 'left',
        cellKind: 'readonly',
        title: 'Plant — derived from SRC, overridable when the partner slip says otherwise',
        format: (r) => txt(r.draw.plant),
        clipboardValue: (r) => r.draw.plant ?? '',
    },
    {
        key: 'whse',
        label: 'WHSE',
        // The values are `WHSE 1` / `WHSE 2` / `WHSE 5` / `WHSE 7` — and `WHSE 3`, the DVO
        // warehouse — never the bare number the header suggests. Six characters plus a
        // space is ~45px, so 62 (44 usable) was one character short and the cell WRAPPED
        // inside a 28px row before the platform pass made cells clip.
        width: 76,
        align: 'left',
        cellKind: 'readonly',
        title: 'Warehouse (or plant, when unplaced)',
        format: (r) => txt(r.group.whse),
        clipboardValue: (r) => r.group.whse ?? '',
    },
    {
        key: 'side',
        label: 'SIDE',
        // Floored by its own HEADER, not by `LS`/`RS`: `SIDE` at `text-[11px]` uppercase
        // with `tracking-wide` is ~31px, and the header's `px-2` leaves 44 − 17 = 27.
        width: 52,
        align: 'left',
        cellKind: 'readonly',
        title: 'Warehouse side (LS / RS) — FLEC draws only',
        format: (r) => txt(r.draw.side),
        clipboardValue: (r) => r.draw.side ?? '',
    },
    {
        key: 'bags',
        label: 'BAGS',
        width: 52,
        align: 'right',
        cellKind: 'readonly',
        title: 'Flec bag count — FLEC draws only',
        format: (r) => intText(r.draw.flecCount),
        numericValue: (r) => num(r.draw.flecCount),
        clipboardValue: (r) => rawNum(r.draw.flecCount),
        calcType: 'SUM',
    },
    {
        key: 'src',
        label: 'SRC',
        width: 62,
        align: 'left',
        cellKind: 'readonly',
        title: 'Source location',
        format: (r) => txt(r.group.src),
        clipboardValue: (r) => r.group.src ?? '',
    },
    {
        key: 'mach',
        label: 'MACH',
        width: 58,
        align: 'left',
        cellKind: 'readonly',
        title: 'Partner machine — C1–C4 (crusher) or RK1–RK4 (kiln)',
        format: (r) => txt(r.draw.equip),
        clipboardValue: (r) => r.draw.equip ?? '',
    },
    {
        key: 'wt',
        label: 'WT KG',
        width: 88,
        align: 'right',
        cellKind: 'readonly',
        title: 'Weight (kg) — per individual draw; a weight never carries to the group',
        format: (r) => wtText(r.draw.weightKg),
        numericValue: (r) => num(r.draw.weightKg),
        clipboardValue: (r) => rawNum(r.draw.weightKg),
        calcType: 'SUM',
        summaryLane: 'figure',
    },
    // ── The four lab metrics. A group's reading lives on its FIRST draw only, so
    // these are precisely the columns the `draw` family does not occupy.
    ...METRICS.map<ColumnSpec<QcRow, Ctx>>((metric: MetricKey) => ({
        key: metric,
        label: metric.toUpperCase(),
        width: 124,
        align: 'right' as const,
        cellKind: 'readonly' as const,
        title: `${metric.toUpperCase()} — one reading per sample group, shown on its first draw`,
        format: (r: QcRow) => metricText(r.group.sample?.[metric] ?? null),
        numericValue: (r: QcRow) => num(r.group.sample?.[metric] ?? null),
        clipboardValue: (r: QcRow) => rawNum(r.group.sample?.[metric] ?? null),
        calcType: 'AVERAGE' as const,
    })),
];

const METRIC_KEYS: ReadonlySet<string> = new Set<string>(METRICS as readonly string[]);
/** Date → Mach: the ten columns the day heading and day total rule off across. */
const LABEL_SPAN = SPECS.findIndex((c) => c.key === 'wt');

const ROW_H = 28;
const CHROME_H = 24;

// A draw row's slots. The metric lanes are ABSENT (not empty) on a non-leading draw.
function slotFor(colKey: string, isFirst: boolean): CellSlot | null {
    if (METRIC_KEYS.has(colKey)) {
        return isFirst ? { field: colKey, editable: true } : null;
    }
    return { field: colKey, editable: colKey === 'wt' };
}

export function QcLedgerGridV2(props: QcLedgerGridV2Props) {
    const { month, days, monthAgg } = props;

    const ctx = React.useMemo<Ctx>(() => ({ month }), [month]);
    const specs = React.useMemo(() => SPECS, []);
    const totalWidth = useTableColumns(specs, null, undefined).minWidth;

    // ── Row families ─────────────────────────────────────────────────────────────
    const kinds = React.useMemo<ReadonlyMap<string, RowKind<QcRow>>>(
        () =>
            new Map<string, RowKind<QcRow>>([
                [
                    'draw-first',
                    {
                        kind: 'draw-first',
                        height: ROW_H,
                        addressable: true,
                        occupies: (colKey) => slotFor(colKey, true),
                    },
                ],
                [
                    'draw',
                    {
                        kind: 'draw',
                        height: ROW_H,
                        addressable: true,
                        occupies: (colKey) => slotFor(colKey, false),
                    },
                ],
                [
                    'group-header',
                    {
                        kind: 'group-header',
                        height: CHROME_H,
                        addressable: false,
                        occupies: () => null,
                    },
                ],
                [
                    'summary',
                    {
                        kind: 'summary',
                        height: CHROME_H,
                        addressable: false,
                        occupies: () => null,
                    },
                ],
            ]),
        [],
    );

    // ── The flatten: day heading · each group's draws · day total ────────────────
    //
    // Chrome keys are a run ORDINAL, never a date: a chrome row's key is the
    // virtualiser's React key, and a value that can repeat would collide.
    const { items, dayMeta } = React.useMemo(() => {
        const out: GridRow<QcRow>[] = [];
        const meta = new Map<string, { date: string; agg: QcAggregate; draws: number }>();
        let ord = 0;
        for (const day of days) {
            ord += 1;
            const headKey = `day-${ord}`;
            const totalKey = `daytot-${ord}`;
            let drawCount = 0;
            out.push({ kind: 'group-header', key: headKey });
            for (const group of day.groups) {
                group.draws.forEach((draw, i) => {
                    drawCount += 1;
                    out.push({
                        kind: i === 0 ? 'draw-first' : 'draw',
                        id: String(draw.id),
                        data: { draw, group, isFirstOfGroup: i === 0 },
                    });
                });
            }
            out.push({ kind: 'summary', key: totalKey });
            meta.set(headKey, { date: day.date, agg: day.agg, draws: drawCount });
            meta.set(totalKey, { date: day.date, agg: day.agg, draws: drawCount });
        }
        return { items: out, dayMeta: meta };
    }, [days]);

    const byId = React.useMemo(() => {
        const m = new Map<string, QcRow>();
        for (const day of days) {
            for (const group of day.groups) {
                group.draws.forEach((draw, i) => {
                    m.set(String(draw.id), { draw, group, isFirstOfGroup: i === 0 });
                });
            }
        }
        return m;
    }, [days]);

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

    // ── Day heading and day total, INSIDE the body ───────────────────────────────
    //
    // Returns the row's CELLS, never a `<tr>` — the container owns the row element in
    // both scopes, and `TableVirtuoso` measures rows off `<tbody>`'s children, so a
    // renderer emitting its own row would lose measurement. A cell over a pinned
    // column stays OPAQUE (a solid token, never glass) or scrolling rows bleed through.
    const renderChromeRow = React.useCallback(
        (item: GridRow<QcRow>, api: { colCount: number }) => {
            if (item.kind !== 'group-header' && item.kind !== 'summary') return null;
            if (!('key' in item)) return null;
            const info = dayMeta.get(item.key);
            if (!info) return null;
            const isTotal = item.kind === 'summary';
            const cov = Number.isFinite(info.agg.coverage)
                ? `${(info.agg.coverage * 100).toFixed(0)}%`
                : '—';
            const labelSpan = Math.max(1, LABEL_SPAN);
            const restSpan = Math.max(1, api.colCount - labelSpan);
            return (
                <>
                    <td
                        className={
                            isTotal
                                ? 'frozen-col frozen-edge h-6 border-t border-border bg-muted px-2 py-1 text-left'
                                : 'frozen-col frozen-edge h-6 border-b border-border/40 bg-muted px-2 py-1 text-left'
                        }
                        style={{ left: 0 }}
                        colSpan={labelSpan}
                    >
                        <span className="text-[11px] font-semibold tracking-wide">
                            {isTotal ? 'Σ DAY TOTAL' : info.date}
                        </span>
                        <span className="ml-2 font-mono text-[10px] font-normal text-muted-foreground">
                            {info.draws} draw{info.draws === 1 ? '' : 's'} ·{' '}
                            {info.agg.groupCount} group{info.agg.groupCount === 1 ? '' : 's'} ·
                            cov {cov}
                        </span>
                    </td>
                    <td
                        className={
                            isTotal
                                ? 'h-6 border-t border-border bg-muted/60 px-2 py-1 text-right'
                                : 'h-6 border-b border-border/40 bg-muted/25 px-2 py-1 text-right'
                        }
                        colSpan={restSpan}
                    >
                        <span className="font-mono text-[10px] text-muted-foreground">
                            {isTotal
                                ? `${info.agg.totalKg.toLocaleString('en-US', { maximumFractionDigits: 1 })} kg · sampled ${info.agg.sampledKg.toLocaleString('en-US', { maximumFractionDigits: 1 })} kg`
                                : ''}
                        </span>
                    </td>
                </>
            );
        },
        [dayMeta],
    );

    // ── The month footer, on the module's declared lanes ─────────────────────────
    const summaryRows = React.useMemo<TableSummaryRow[]>(() => {
        const cov = Number.isFinite(monthAgg.coverage)
            ? `${(monthAgg.coverage * 100).toFixed(1)}%`
            : '—';
        return [
            {
                key: 'month',
                label: `Σ ${month} · ${monthAgg.groupCount} group${monthAgg.groupCount === 1 ? '' : 's'} · cov ${cov}`,
                figure: monthAgg.totalKg.toLocaleString('en-US', {
                    maximumFractionDigits: 1,
                }),
                note: `sampled ${monthAgg.sampledKg.toLocaleString('en-US', { maximumFractionDigits: 1 })} kg`,
                total: '',
            },
        ];
    }, [month, monthAgg]);

    return (
        <div className="flex h-full min-h-0 flex-col">
            <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border bg-muted/30 px-3 py-1.5">
                <span className="text-xs font-semibold">{month}</span>
                <span className="font-mono text-[11px] text-muted-foreground">
                    {items.filter((i) => i.kind === 'draw' || i.kind === 'draw-first').length}{' '}
                    draws · {days.length} day{days.length === 1 ? '' : 's'}
                </span>
                <span className="ml-auto text-[10px] text-muted-foreground">
                    Read-only preview — selection, the right-click menu, the selection summary and
                    column resize are live. Use Current to log a reading or change month.
                </span>
            </div>

            <div className="min-h-0 flex-1 overflow-hidden">
                <div className="h-full overflow-hidden" style={{ maxWidth: totalWidth }}>
                    <BlackwoodTable<QcRow, Ctx>
                        items={items}
                        kinds={kinds}
                        specs={specs}
                        ctx={ctx}
                        edits={edits}
                        storedText={storedText}
                        scope="focus"
                        childKinds={['draw']}
                        renderChromeRow={renderChromeRow}
                        summaryRows={summaryRows}
                        emptyMessage={
                            <span className="text-xs text-muted-foreground">
                                No QC draws recorded for {month}.
                            </span>
                        }
                    />
                </div>
            </div>
        </div>
    );
}
