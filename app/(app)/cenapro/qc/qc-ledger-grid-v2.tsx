'use client';

// ─────────────────────────────────────────────────────────────────────────────────
// qc-ledger-grid-v2.tsx — the Cenapro QC ledger on the universal table module,
// built BESIDE `qc-ledger-client.tsx`. That file is untouched and stays fully
// reachable at `?grid=v1`.
//
// ── IT TYPES AND SAVES (2026-08-21, slice 2) ───────────────────────────────────
//
// The grid was READ-ONLY BY CONSTRUCTION until now — no `ColumnSpec` declared a
// `parse`, so `columnAcceptsEdit`'s fallback refused every coordinate. It now
// declares them, and the whole of "what a cell means and what Save actually posts"
// lives in the PURE sibling `qc-grid-v2-save.ts`, asserted by
// `scripts/verify-qc-grid.ts` with no browser and no database. This file is the
// React adapter: rows, columns, families, the toolbar and the three round trips.
//
// **The one thing to hold in your head reading it: an edit's lane decides WHICH ROW
// it is a save to.** WT is per DRAW; BD / ASH / GRIT / MC are per SAMPLE GROUP and
// are merely DISPLAYED on the group's first draw. `routeQcEdits` is where that
// split happens and `qc-grid-v2-save.ts`'s header is where it is argued.
//
// **No save-time reason dialog**, unlike RC IN's: none of the three QC RPCs accepts
// a comment or a note, so there is nothing for one to collect. See the save module.
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
//   • `draft`      (2026-08-21) occupies all fifteen, and every one is EDITABLE —
//                  a new draw carries its own date, source, machine, grade, shift,
//                  plant, warehouse, side and bags, because that is exactly what
//                  `cenapro_add_partner_draw` takes. On a STORED row those nine are
//                  reference-only, and not by taste: no RPC moves them.
//
// `null` means "this row has no cell there" — not "an empty one". That single answer
// drives the keyboard (a vertical run steps over it), the paste (it never lands
// there), the selection pill (it is not totalled) and the tint (it is not painted).
// Getting it wrong is BUG-024, where a paste mapped block rows by arithmetic, wrote a
// parent's data into its sub-rows, and reported success.
//
// Width: `sizing="fill"`, NOT a `maxWidth` clamp. See `lib/table/CONTEXT.md` → the
// review pass, item 5. A table wider than its columns scales all of them
// proportionally while the sticky offsets keep using the DECLARED widths, so a
// stretched sheet can pin a frozen column inside its neighbour. The clamp made that
// unreachable at the cost of dead space; `'fill'` removes the slack instead, inside
// `useTableColumns`, so ONE set of numbers describes both the layout and the sticky
// arithmetic and DATE stays pinned at any viewport width.
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
import { useRouter } from 'next/navigation';
import { Loader2, Save } from 'lucide-react';
import { toast } from 'sonner';

import { BlackwoodTable } from '@/components/shared/table';
import type { TableSummaryRow } from '@/components/shared/table/BlackwoodTable';
import type { CellSlot, ColumnParseResult, ColumnSpec, GridRow, RowKind } from '@/lib/table';
import { useTableEdits } from '@/lib/hooks/use-table-edits';
import { errorToast } from '@/lib/toast';
import { cn } from '@/lib/utils';
import { METRICS, type MetricKey } from '@/lib/cenapro/ccc-analysis';
import type { QcAggregate } from '@/lib/cenapro/ccc-analysis-view';

import { addQcDraws, saveQcSamples, saveQcWeights } from './actions';
import type { QcGroup, QcLedgerDay, QcDrawOptions } from './data';
import {
    buildQcSavePlan,
    cleanPastedQcCell,
    countQcUnsaved,
    describeQcUnsaved,
    drawInputLabel,
    drawLabel,
    forgettableRowIds,
    groupLabel,
    isDraftKey,
    isMetricField,
    makeDraftIds,
    normalizeQcField,
    parseQcField,
    qcDrawFailureMessage,
    qcSampleFailureMessage,
    qcWeightFailureMessage,
    storedRowFieldIsEditable,
    type QcField,
    type QcFieldEnv,
    type QcSaveRow,
} from './qc-grid-v2-save';

// ─── SRC ORDER — Renzo's reading order, top to bottom within each day ────────────
//
// "TNKs first (TNK 1, TNK 2, … numerically), then W6, then W7, then DVO, then FLEC."
// The ledger's own read (`data.ts`) sorts a day's groups `src` then `whse`
// ALPHABETICALLY, which interleaves the sources the operator reads as a sequence
// (`DVO` lands before `FLEC` there only by accident, and `TNK …` lands dead last).
//
// The unit of ordering is the GROUP, never the draw: a lab reading covers a whole
// sample group and lives on its FIRST draw, so re-ordering draws across a group
// boundary would separate a reading from the rows it describes. Groups move; the
// draws inside one keep their stored order.
//
// An UNRECOGNISED source ranks last and then sorts alphabetically — a new source
// location appears at the bottom of its day rather than vanishing into an arbitrary
// slot or, worse, being dropped.
const SRC_RANK: ReadonlyMap<string, number> = new Map([
    ['W6', 100],
    ['W7', 200],
    ['DVO', 300],
    ['FLEC', 400],
]);
const TNK_RE = /^TNK\s*(\d+)$/;
/** Rank tuple: `[tier, ordinal]`. Tier 0 is the TNK family, ordinal is its number. */
function srcRank(src: string | null | undefined): [number, number] {
    const key = (src ?? '').trim().toUpperCase();
    const tnk = TNK_RE.exec(key);
    if (tnk) return [0, Number(tnk[1])];
    const rank = SRC_RANK.get(key);
    if (rank !== undefined) return [rank, 0];
    return [Number.MAX_SAFE_INTEGER, 0];
}
/** Group comparator — rank, then the source's own spelling so unknowns are alphabetical. */
function compareGroupsBySrc(a: QcGroup, b: QcGroup): number {
    const [at, ao] = srcRank(a.src);
    const [bt, bo] = srcRank(b.src);
    if (at !== bt) return at - bt;
    if (ao !== bo) return ao - bo;
    // Same rank: keep the read's own tie-break (src spelling, then warehouse) so two
    // groups from one source stay in a stable, predictable order.
    return (a.src ?? '').localeCompare(b.src ?? '') || (a.whse ?? '').localeCompare(b.whse ?? '');
}

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
    /**
     * OPTIONAL, and defaulted to `true`.
     *
     * `page.tsx` does not pass it today and this grid does not ask it to: QC carries no
     * ₱ column anywhere, and the live ledger has never gated entry by role — anyone who
     * can reach the screen can log a reading. It is declared so a later role pass has a
     * prop to fill rather than a component to reshape, and it is OPTIONAL so the page
     * (owned by another pass) keeps spreading exactly the props object it builds today.
     */
    canEdit?: boolean;
}

/** One rendered row: a draw, the group it belongs to, and whether it leads that group. */
type QcRow = QcSaveRow;

interface Ctx {
    readonly month: string;
    /** May anything on this sheet be typed into at all? */
    readonly canEdit: boolean;
    /** The verdict env — the DB-read dimension lists and what a bare `6/27` means. */
    readonly env: QcFieldEnv;
}

/** A verdict that refuses nothing. The module reads only `ok`; the patch is never used. */
const PARSE_OK: ColumnParseResult = { ok: true, patch: {} };

/**
 * THE commit verdict for a column, and it is `parseQcField` — the same function the SAVE
 * runs. A value typed and the same value refused at save can never disagree, because
 * there is only one of them.
 *
 * `cell` is accepted and deliberately unused: the two row families that share this
 * column table mean the same thing by every lane they both occupy (a metric cell is the
 * group's reading whichever draw it is drawn on), so the field name alone is the whole
 * question. It stays in the signature because `CellContext` is the seam a later
 * per-family verdict would arrive through, and a `parse` written without it behaves
 * identically.
 */
function makeParse(field: QcField) {
    return (text: string, ctx: Ctx): ColumnParseResult => {
        if (text.trim() === '') return PARSE_OK;
        const verdict = parseQcField(field, text, ctx.env);
        return verdict.ok ? PARSE_OK : verdict;
    };
}

/**
 * The four seams every editable column shares.
 *
 * `editable` is the COLUMN's half of the verdict; `RowKind.occupies().editable` is the
 * row family's, and the module ANDs them in exactly one place. Both are declared, and
 * they agree by construction because both read `storedRowFieldIsEditable`: a stored draw
 * exposes its own WT and its group's four metrics and nothing else, because
 * `cenapro_update_event_weight` and `cenapro_save_analysis_sample` are the only two doors
 * the database offers into it. `row === null` is a blank row, where every lane is live —
 * `cenapro_add_partner_draw` takes all of them.
 */
function editSeams(field: QcField): Partial<ColumnSpec<QcRow, Ctx>> {
    return {
        editable: (row: QcRow | null, ctx: Ctx) =>
            ctx.canEdit && (row === null || storedRowFieldIsEditable(field)),
        parse: makeParse(field),
        normalize: (text: string, ctx: Ctx) => normalizeQcField(field, text, ctx.env),
        cleanPasted: (raw: string, ctx: Ctx) => cleanPastedQcCell(field, raw, ctx.env),
    };
}

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
        cellKind: 'date',
        title: 'Receipt date at CCC',
        ...editSeams('date'),
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
        cellKind: 'date',
        title: 'Production date of the material drawn',
        ...editSeams('prod'),
        format: (r) => txt(r.draw.prodDate ? String(r.draw.prodDate).slice(0, 10) : null),
        clipboardValue: (r) => (r.draw.prodDate ? String(r.draw.prodDate).slice(0, 10) : ''),
    },
    {
        key: 'shift',
        label: 'SH',
        width: 40,
        align: 'left',
        cellKind: 'select',
        title: 'Shift',
        ...editSeams('shift'),
        format: (r) => txt(r.draw.shift),
        clipboardValue: (r) => r.draw.shift ?? '',
    },
    {
        key: 'grade',
        label: 'GRADE',
        width: 62,
        align: 'left',
        cellKind: 'select',
        ...editSeams('grade'),
        format: (r) => txt(r.draw.grade),
        clipboardValue: (r) => r.draw.grade ?? '',
    },
    {
        key: 'plant',
        label: 'PLANT',
        width: 88,
        align: 'left',
        cellKind: 'select',
        title: 'Plant — derived from SRC, overridable when the partner slip says otherwise',
        ...editSeams('plant'),
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
        cellKind: 'select',
        title: 'Warehouse (or plant, when unplaced)',
        ...editSeams('whse'),
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
        cellKind: 'select',
        title: 'Warehouse side (LS / RS) — FLEC draws only',
        ...editSeams('side'),
        format: (r) => txt(r.draw.side),
        clipboardValue: (r) => r.draw.side ?? '',
    },
    {
        key: 'bags',
        label: 'BAGS',
        width: 52,
        align: 'right',
        cellKind: 'number',
        title: 'Flec bag count — FLEC draws only',
        ...editSeams('bags'),
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
        cellKind: 'select',
        title: 'Source location',
        ...editSeams('src'),
        format: (r) => txt(r.group.src),
        clipboardValue: (r) => r.group.src ?? '',
    },
    {
        key: 'mach',
        label: 'MACH',
        width: 58,
        align: 'left',
        cellKind: 'select',
        title: 'Partner machine — C1–C4 (crusher) or RK1–RK4 (kiln)',
        ...editSeams('mach'),
        format: (r) => txt(r.draw.equip),
        clipboardValue: (r) => r.draw.equip ?? '',
    },
    {
        key: 'wt',
        label: 'WT KG',
        width: 88,
        align: 'right',
        cellKind: 'number',
        title: 'Weight (kg) — per individual draw; a weight never carries to the group',
        ...editSeams('wt'),
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
        cellKind: 'number' as const,
        title: `${metric.toUpperCase()} — one reading per sample group, shown on its first draw`,
        ...(editSeams(metric) as Partial<ColumnSpec<QcRow, Ctx>>),
        format: (r: QcRow) => metricText(r.group.sample?.[metric] ?? null),
        numericValue: (r: QcRow) => num(r.group.sample?.[metric] ?? null),
        clipboardValue: (r: QcRow) => rawNum(r.group.sample?.[metric] ?? null),
        calcType: 'AVERAGE' as const,
    })),
];

/** Date → Mach: the ten columns the day total rules off across. */
const LABEL_SPAN = SPECS.findIndex((c) => c.key === 'wt');

const ROW_H = 28;
const CHROME_H = 24;

/**
 * How many blank rows "Add draw" hands you. Renzo's number for THIS sheet — the live
 * ledger's `BLANK_BATCH`, kept rather than the platform's `DEFAULT_DRAFT_ROWS` (20),
 * because a partner's slip is about ten lines long and the two surfaces should offer the
 * same run of blanks.
 */
const BLANK_BATCH = 10;

/**
 * A STORED draw row's slots. The metric lanes are ABSENT (not empty) on a non-leading
 * draw, and only WT + the four metrics are editable — `storedRowFieldIsEditable` is the
 * one definition, shared with the column's own `editable` and with the save.
 */
function slotFor(colKey: string, isFirst: boolean): CellSlot | null {
    if (isMetricField(colKey)) {
        return isFirst ? { field: colKey, editable: true } : null;
    }
    return { field: colKey, editable: storedRowFieldIsEditable(colKey) };
}

/** A BLANK row's slots — all fifteen, all live. See the header note. */
function draftSlotFor(colKey: string): CellSlot | null {
    return { field: colKey, editable: true };
}

export function QcLedgerGridV2(props: QcLedgerGridV2Props) {
    const { month, days, monthAgg, drawOptions } = props;
    const canEdit = props.canEdit ?? true;
    const router = useRouter();

    /**
     * What a bare `6/27` typed into a date cell means.
     *
     * The ledger is month-scoped — the rows on screen are one month — so the month being
     * looked at IS the context, and a slip transcribed in June takes June's year without
     * anyone saying so. Identical to `qc-ledger-client.tsx`'s `contextYear`.
     */
    const contextYear = React.useMemo(() => {
        const year = Number(month.slice(0, 4));
        return Number.isFinite(year) && year > 1900 ? year : new Date().getFullYear();
    }, [month]);

    const ctx = React.useMemo<Ctx>(
        () => ({ month, canEdit, env: { options: drawOptions, contextYear } }),
        [month, canEdit, drawOptions, contextYear],
    );
    const specs = React.useMemo(() => SPECS, []);

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
                    'draft',
                    {
                        kind: 'draft',
                        height: ROW_H,
                        addressable: true,
                        occupies: (colKey) => draftSlotFor(colKey),
                    },
                ],
                // No `group-header` family: the per-day HEADING row was removed on
                // 2026-08-20 (Renzo: "having a heading row on the table per day is kind
                // of redundant given you already have a summary per day"). The day's
                // identity moved INTO the `summary` row's label, so a day still names
                // itself — it just does so once instead of twice.
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

    // ── SRC order, applied ONCE, before anything reads a day ─────────────────────
    //
    // Sorted here rather than in the flatten so the flatten and the id index below
    // walk the SAME sequence — two independent sorts are two definitions of the order,
    // and they drift. `slice()` first: `days[i].groups` is server payload and must not
    // be mutated in place (React would not see it, and a re-render would re-sort an
    // already-sorted array).
    const orderedDays = React.useMemo<QcLedgerDay[]>(
        () => days.map((day) => ({ ...day, groups: day.groups.slice().sort(compareGroupsBySrc) })),
        [days],
    );

    // ── The flatten: each group's draws · day total ──────────────────────────────
    //
    // The per-day HEADING row is gone (2026-08-20). The day total carries the date, so
    // the day is still named — and the Σ row is a solid `bg-muted` band ruled top AND
    // bottom, which is the day boundary. No blank spacer row was added: an opaque
    // full-width band between two runs of 28px data rows is already a harder break than
    // a 24px empty row would be, and a spacer would be a fourth row family carrying no
    // information.
    //
    // Chrome keys are a run ORDINAL, never a date: a chrome row's key is the
    // virtualiser's React key, and a value that can repeat would collide.
    // ── The blank-row pool ───────────────────────────────────────────────────────
    //
    // At the VERY BOTTOM, in one run under the last day, rather than inside a day block.
    // The live ledger anchors its drafts to a day (`anchorDate`) because it renders each
    // day as its own table; here the sheet is one continuous grid and the module's draft
    // model is a bottom pool. It is layout only either way — a new draw's day comes from
    // the DATE cell someone types, never from where the blank row sits, in both surfaces.
    const [draftIds, setDraftIds] = React.useState<string[]>(() =>
        canEdit ? makeDraftIds(BLANK_BATCH) : [],
    );

    const { items, dayMeta } = React.useMemo(() => {
        const out: GridRow<QcRow>[] = [];
        const meta = new Map<string, { date: string; agg: QcAggregate; draws: number }>();
        let ord = 0;
        for (const day of orderedDays) {
            ord += 1;
            const totalKey = `daytot-${ord}`;
            let drawCount = 0;
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
            meta.set(totalKey, { date: day.date, agg: day.agg, draws: drawCount });
        }
        for (const draftId of draftIds) out.push({ kind: 'draft', id: draftId });
        return { items: out, dayMeta: meta };
    }, [orderedDays, draftIds]);

    const byId = React.useMemo(() => {
        const m = new Map<string, QcRow>();
        for (const day of orderedDays) {
            for (const group of day.groups) {
                group.draws.forEach((draw, i) => {
                    m.set(String(draw.id), { draw, group, isFirstOfGroup: i === 0 });
                });
            }
        }
        return m;
    }, [orderedDays]);

    /**
     * Every sample group on screen — the `sample_row_version` map a NEW draw needs.
     *
     * A typed row that joins an EXISTING group whose reading is already logged must
     * update that reading against its version, exactly as an inline edit would; without
     * it the RPC (rightly) answers `already_exists` on a group the operator is looking at.
     * `addQcDraws` takes the whole map and picks the key its own insert reported.
     */
    const allGroups = React.useMemo(() => {
        const out: QcGroup[] = [];
        for (const day of orderedDays) for (const group of day.groups) out.push(group);
        return out;
    }, [orderedDays]);

    /**
     * What a cell HOLDS as text.
     *
     * Three consumers, and they must agree or the sheet misbehaves in ways nothing on
     * screen explains: the editor's opening value, the jump keys' "is this cell filled"
     * probe, and — through `useTableEdits`' `canonicalText` — the value an edit must
     * return to in order to stop counting as unsaved.
     *
     * It goes through each column's own `clipboardValue`, which is the STORED fact and
     * never the rendering: a weight opens as `9583.5`, not `9,583.5`, so committing a
     * cell you merely tabbed through cannot round it. (`formatKgExact` exists in the live
     * ledger for exactly this reason; here the clipboard lane already answers it.)
     *
     * A BLANK row holds nothing — every one of its cells starts empty, which is what
     * makes an untouched blank cost nothing on Save.
     */
    const storedText = React.useCallback(
        (rowId: string, field: string): string => {
            const row = byId.get(rowId);
            if (!row) return '';
            const spec = specs.find((s) => s.key === field);
            return spec?.clipboardValue ? spec.clipboardValue(row) : '';
        },
        [byId, specs],
    );

    // THE single journalled writer. Every mutation in this grid — an inline commit, a
    // Delete, a paste, an Escape revert, undo and redo — goes through `edits.applyEdits`.
    const edits = useTableEdits({ canonicalText: storedText, isDraft: isDraftKey });

    // ── The day total, INSIDE the body — and the only row that names the day ─────
    //
    // Returns the row's CELLS, never a `<tr>` — the container owns the row element in
    // both scopes, and `TableVirtuoso` measures rows off `<tbody>`'s children, so a
    // renderer emitting its own row would lose measurement. A cell over a pinned
    // column stays OPAQUE (a solid token, never glass) or scrolling rows bleed through.
    //
    // The label reads `Σ 2026-08-01 · 9 draws · 6 groups · cov 100%`: the date that used
    // to sit on a separate heading row above the day now leads its total. Ruled top AND
    // bottom, so the band separates this day from the next without a spacer row.
    const renderChromeRow = React.useCallback(
        (item: GridRow<QcRow>, api: { colCount: number }) => {
            if (item.kind !== 'summary') return null;
            if (!('key' in item)) return null;
            const info = dayMeta.get(item.key);
            if (!info) return null;
            const cov = Number.isFinite(info.agg.coverage)
                ? `${(info.agg.coverage * 100).toFixed(0)}%`
                : '—';
            const labelSpan = Math.max(1, LABEL_SPAN);
            const restSpan = Math.max(1, api.colCount - labelSpan);
            return (
                <>
                    <td
                        className="frozen-col frozen-edge h-6 border-y border-border bg-muted px-2 py-1 text-left"
                        style={{ left: 0 }}
                        colSpan={labelSpan}
                    >
                        <span className="text-[11px] font-semibold tracking-wide">
                            Σ {info.date}
                        </span>
                        <span className="ml-2 font-mono text-[10px] font-normal text-muted-foreground">
                            · {info.draws} draw{info.draws === 1 ? '' : 's'} ·{' '}
                            {info.agg.groupCount} group{info.agg.groupCount === 1 ? '' : 's'} ·
                            cov {cov}
                        </span>
                    </td>
                    <td
                        className="h-6 border-y border-border bg-muted/60 px-2 py-1 text-right"
                        colSpan={restSpan}
                    >
                        <span className="font-mono text-[10px] text-muted-foreground">
                            {`${info.agg.totalKg.toLocaleString('en-US', { maximumFractionDigits: 1 })} kg · sampled ${info.agg.sampledKg.toLocaleString('en-US', { maximumFractionDigits: 1 })} kg`}
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

    // ── The blank-row pool's controls ────────────────────────────────────────────
    //
    // `onAddDrafts` returns the ids it created SYNCHRONOUSLY, because a paste running
    // past the last blank row needs them inside the same gesture — and those ids ride on
    // the journal step, so one Ctrl+Z takes back the paste AND the rows it grew.
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

    // ── Unsaved work ─────────────────────────────────────────────────────────────
    const unsaved = React.useMemo(
        () => countQcUnsaved(edits.edits, edits.dirtyRecords, edits.dirtyDrafts, byId),
        [edits.edits, edits.dirtyRecords, edits.dirtyDrafts, byId],
    );

    const [saving, setSaving] = React.useState(false);
    const [refreshing, startTransition] = React.useTransition();
    const busy = saving || refreshing;

    /**
     * ONE Save, three round trips, and every one of them answers PER ROW.
     *
     * Order — new draws, then weights, then readings — is the live ledger's, and only the
     * first third of it is a correctness requirement: a typed row's lab cells are applied
     * by the SERVER to whichever sample group its insert actually landed in, so the draws
     * have to go first for a slip transcribed and analysed in one sitting to save in one
     * press. Weights before readings is a reading convenience: fix what the number IS
     * before recording what was measured about it.
     *
     * **Nothing is written unless every dirty row builds a legal payload** — that is the
     * plan builder's rule and it is about what LEAVES. What comes BACK is per row, with
     * its own compare-and-set, so a conflict on one group genuinely leaves the others
     * written, and the toast below says which is which rather than pretending either way.
     */
    const handleSave = React.useCallback(async () => {
        if (unsaved.total === 0 || busy) return;

        const plan = buildQcSavePlan({
            edits: edits.edits,
            dirtyRecords: edits.dirtyRecords,
            dirtyDrafts: edits.dirtyDrafts,
            draftIds,
            rowsById: byId,
            groups: allGroups,
            env: ctx.env,
        });

        if (plan.problems.length > 0) {
            errorToast(
                `${plan.problems.length} change${plan.problems.length === 1 ? '' : 's'} could not be saved — nothing was written.`,
                { description: plan.problems.join('\n\n') },
            );
            return;
        }
        if (plan.samples.length === 0 && plan.weights.length === 0 && plan.draws.length === 0) {
            toast.info('Nothing to save.');
            return;
        }

        setSaving(true);
        try {
            const failures: string[] = [];
            let landed = 0;

            // ── New draws ────────────────────────────────────────────────────────
            const savedDraftIds: string[] = [];
            if (plan.draws.length > 0) {
                const run = await addQcDraws(plan.draws, plan.groupVersions);
                const sentByRow = new Map(plan.draws.map((d) => [d.rowId, d]));
                for (const row of run) {
                    // Labelled off the payload that was actually SENT, so a verdict names
                    // the row the way a pre-flight refusal would have.
                    const sent = sentByRow.get(row.rowId);
                    const label = sent ? drawInputLabel(sent.input) : `new draw (${row.rowId})`;
                    if (row.result.ok && row.result.outcome === 'inserted') {
                        landed += 1;
                        // **The blank row is retired the moment the DRAW lands, even when
                        // the reading typed beside it was refused.** Keeping it would let
                        // the next Save file the receipt a SECOND time, which is not
                        // undoable; retyping a reading on the saved row is. The numbers
                        // are named in the persistent toast below, which carries Copy.
                        savedDraftIds.push(row.rowId);
                        if (row.reading && !row.reading.ok) {
                            failures.push(
                                `${label} — the draw was added, but its reading was not: ${row.reading.message ?? 'the sample was refused.'} Type it on the saved row.`,
                            );
                        }
                        continue;
                    }
                    failures.push(
                        `${label} — ${qcDrawFailureMessage(row.result.outcome, row.result.message)}`,
                    );
                }
            }

            // ── Per-draw weights ─────────────────────────────────────────────────
            const savedDrawIds = new Set<string>();
            if (plan.weights.length > 0) {
                const run = await saveQcWeights(plan.weights);
                for (const result of run.results) {
                    const row = byId.get(result.id);
                    const label = row ? `${drawLabel(row)} · WT` : 'Unknown receipt row · WT';
                    if (result.ok) {
                        savedDrawIds.add(result.id);
                        landed += 1;
                        continue;
                    }
                    failures.push(`${label} — ${qcWeightFailureMessage(result.outcome, result.message)}`);
                }
            }

            // ── Sample-group readings ────────────────────────────────────────────
            const savedGroupKeys = new Set<string>();
            if (plan.samples.length > 0) {
                const run = await saveQcSamples(plan.samples);
                const groupByKey = new Map(allGroups.map((g) => [g.key, g]));
                for (const result of run.results) {
                    const group = groupByKey.get(result.key);
                    const label = group ? groupLabel(group) : result.key;
                    if (result.ok) {
                        savedGroupKeys.add(result.key);
                        landed += 1;
                        continue;
                    }
                    failures.push(`${label} — ${qcSampleFailureMessage(result.outcome, result.message)}`);
                }
            }

            // ── Forget only what LANDED ──────────────────────────────────────────
            const forgettable = forgettableRowIds({
                edits: edits.edits,
                dirtyRecords: edits.dirtyRecords,
                rowsById: byId,
                sentGroupKeys: new Set(plan.samples.map((s) => s.key)),
                savedGroupKeys,
                sentDrawIds: new Set(plan.weights.map((w) => w.id)),
                savedDrawIds,
            });
            if (forgettable.length > 0 || savedDraftIds.length > 0) {
                edits.forget([...forgettable, ...savedDraftIds]);
            }
            if (savedDraftIds.length > 0) {
                // The blank rows became real draws: drop them, then top the pool back up
                // so the run under the sheet stays the same length (Sheets never shrinks
                // it either).
                const consumed = new Set(savedDraftIds);
                setDraftIds((prev) => [
                    ...prev.filter((id) => !consumed.has(id)),
                    ...makeDraftIds(savedDraftIds.length),
                ]);
            }

            if (failures.length > 0) {
                errorToast(
                    `${failures.length} change${failures.length === 1 ? '' : 's'} did not save.`,
                    { description: failures.join('\n\n') },
                );
            }
            if (landed > 0) {
                toast.success(`Saved ${landed} change${landed === 1 ? '' : 's'}`);
                // The server page refetches and hands down fresh `days`. This component is
                // not keyed on anything, so it does NOT remount: the rows flow in as
                // props, the flatten and the id index re-derive, and the rows that landed
                // have already been forgotten — so nothing is left lit and no keystroke of
                // a REFUSED row is disturbed.
                startTransition(() => router.refresh());
            }
        } catch (cause) {
            errorToast('Saving the QC ledger failed', {
                description: cause instanceof Error ? cause.message : String(cause),
            });
        } finally {
            setSaving(false);
        }
    }, [unsaved.total, busy, edits, draftIds, byId, allGroups, ctx.env, router]);

    const rowClassFor = React.useCallback((item: GridRow<QcRow>) => {
        if (item.kind === 'draft') return 'group bg-muted/10 transition-all duration-150 hover:bg-muted/30';
        return undefined;
    }, []);

    return (
        <div className="flex h-full min-h-0 flex-col">
            <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border bg-muted/30 px-3 py-1.5">
                <span className="text-xs font-semibold">{month}</span>
                <span className="font-mono text-[11px] text-muted-foreground">
                    {items.filter((i) => i.kind === 'draw' || i.kind === 'draw-first').length}{' '}
                    draws · {days.length} day{days.length === 1 ? '' : 's'}
                </span>
                {canEdit ? (
                    <span className="text-[10px] text-muted-foreground">
                        · a saved row takes a new WT and its group&apos;s BD / ASH / GRIT / MC; the
                        blank rows at the bottom take a whole new draw
                    </span>
                ) : null}
                <div className="ml-auto flex items-center gap-2">
                    {unsaved.total > 0 ? (
                        <span className="rounded border border-amber-500/40 bg-amber-500/10 px-1.5 py-0.5 font-mono text-[10px] text-amber-700 dark:text-amber-300">
                            {describeQcUnsaved(unsaved)} unsaved
                        </span>
                    ) : null}
                    <button
                        type="button"
                        data-testid="save-qc-ledger"
                        onClick={() => void handleSave()}
                        disabled={unsaved.total === 0 || busy || !canEdit}
                        className={cn(
                            'inline-flex h-6 items-center gap-1 rounded border px-2 text-[11px] font-semibold transition-all duration-150',
                            unsaved.total > 0 && !busy && canEdit
                                ? 'border-primary bg-primary text-primary-foreground hover:opacity-90'
                                : 'border-border bg-muted text-muted-foreground',
                            (unsaved.total === 0 || busy || !canEdit) && 'cursor-not-allowed opacity-60',
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

            {/*
              * THE HEIGHT CHAIN, and why `h-full` on the table is load-bearing.
              *
              * In the focus scope `BlackwoodTable` renders its scroller as
              * `<div class="h-full overflow-auto">`, nested inside its own root
              * `<div class="flex min-h-0 flex-col">` — and that ROOT declares no height
              * of its own. As a plain block child it therefore sized to its CONTENT,
              * the `flex-1` region under it inherited that content height, and the
              * `h-full` scroller resolved to the full height of the rows it contained.
              * A scroller exactly as tall as its content has nothing to scroll: the
              * sheet simply grew past the wrapper below, which clips (`overflow-hidden`),
              * and every day after the first was unreachable — no scrollbar, no wheel.
              *
              * Passing `h-full` gives that root a DEFINITE height (this wrapper is
              * `h-full` under a `min-h-0 flex-1` region under an `h-full` column under
              * the Cenapro layout's `h-full` Card), so `flex-1 min-h-0` can finally
              * shrink below content and the scroller gets a bounded box. Nothing in
              * `components/shared/table/**` was touched — `className` is the public prop
              * for exactly this.
              *
              * SIZING (2026-08-20): the `maxWidth` clamp that used to sit on the wrapper
              * below is GONE, replaced by the platform `sizing="fill"` prop. The clamp
              * existed because `width: 100%` under `table-layout: fixed` scales every
              * `<col>` proportionally while the sticky `left` offsets keep using the
              * DECLARED widths — so a wide viewport pinned DATE inside its neighbour.
              * `'fill'` closes that at the source: the slack is distributed inside
              * `useTableColumns`' own resolution and the table is rendered at exactly the
              * resulting pixel width, so `table-fixed` has nothing left to scale into and
              * every offset is a prefix sum of the widths ACTUALLY painted. The frozen
              * DATE column therefore pins correctly at any width — see the note in the
              * report — and the dead space to the right is gone.
              */}
            <div className="min-h-0 flex-1 overflow-hidden">
                <div className="h-full overflow-hidden">
                    <BlackwoodTable<QcRow, Ctx>
                        className="h-full"
                        items={items}
                        kinds={kinds}
                        specs={specs}
                        ctx={ctx}
                        edits={edits}
                        storedText={storedText}
                        scope="focus"
                        sizing="fill"
                        childKinds={['draw']}
                        draftKind="draft"
                        drafts={{ enabled: canEdit, defaultCount: BLANK_BATCH }}
                        onAddDrafts={onAddDrafts}
                        onRemoveDrafts={onRemoveDrafts}
                        onRestoreDrafts={onRestoreDrafts}
                        rowClassFor={rowClassFor}
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
