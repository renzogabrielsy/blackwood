'use client';

import * as React from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Check, Copy, Loader2, Plus, RotateCw } from 'lucide-react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { GridCell, EditInput } from '@/components/shared/grid';
import { useGridEditSession } from '@/lib/hooks/use-grid-edit-session';
import {
    useGridKeyboardNav,
    type CoordinateId,
    type NavResolver,
} from '@/lib/hooks/use-grid-keyboard-nav';
import { errorToast } from '@/lib/toast';
import { cn } from '@/lib/utils';

import {
    METRICS,
    METRIC_LABEL,
    parseWeightKg,
    type MetricKey,
} from '@/lib/cenapro/ccc-analysis';
import {
    EMPTY_METRIC_VALUES,
    adjustAggregate,
    formatCoverage,
    formatDayHeading,
    formatKg,
    formatMetric,
    formatMonthHeading,
    formatShortDate,
    hasAnyMetric,
    type AggregateAdjustment,
    type MetricValues,
    type QcAggregate,
    type SeriesPoint,
} from '@/lib/cenapro/ccc-analysis-view';

import { Chip, NarrowScreenNotice, Tile } from './qc-chrome';
import { MetricSpark } from './qc-metric-charts';
import { MonthYearPicker } from './month-year-picker';
import {
    DraftRow,
    draftBlocker,
    draftToInput,
    isMeaningfulDraft,
    makeBlankDrafts,
    type DraftDraw,
} from './draw-entry-rows';
import {
    addQcDraws,
    saveQcSamples,
    saveQcWeights,
    type SaveQcSampleInput,
    type SaveQcSampleResult,
    type SaveQcWeightInput,
    type SaveQcWeightResult,
} from './actions';
import type { QcDraw, QcDrawOptions, QcGroup, QcLedgerDay } from './data';

interface QcLedgerClientProps {
    month: string;
    days: QcLedgerDay[];
    /** The month's `scope='all'` rollup, straight from SQL. */
    monthAgg: QcAggregate;
    /** Every `YYYY-MM` present in the data, ascending — feeds the Month/Year picker. */
    monthKeys: string[];
    previousWtd: MetricValues | null;
    previousLabel: string | null;
    /** DB-read dimension lists for the "Add draw" composer. */
    drawOptions: QcDrawOptions;
}

/** Per-group, per-metric unsaved edits, held as the raw text the operator typed. */
type EditMap = Record<string, Partial<Record<MetricKey, string>>>;

/** Per-DRAW unsaved weight edits, keyed by `production_event.id`. */
type WeightEditMap = Record<string, string>;

// ─── Column widths ────────────────────────────────────────────────────────────────
//
// Explicit pixel widths, Excel Standard. The sum below IS the table's min-width — the
// wrapper scrolls horizontally rather than letting any column crush ("never crush,
// always scroll").
//
// The IDENTITY columns (Date → WT) are REFERENCE — you read them, you never touch
// them — so they are deliberately thin. The eight identity columns total 498px against
// the four analysis columns' 496px, and because a `table-fixed` table distributes
// surplus space in PROPORTION to the declared widths, that 50/50 split holds at 1280,
// at 1920 and at 3440. It is not a one-resolution tune.
//
// Each identity width is floored by its own HEADER (10px semibold uppercase + 16px of
// padding), not by its data, which is why a few headers are abbreviated and carry a
// `title`. WT is the exception: it is floored by the frozen month footer's figure
// (`1,134,070` at 12px mono ≈ 81px), not by a per-draw weight.
interface LedgerCol {
    key: string;
    width: number;
    label: string;
    /** Long form for the header `title` when the label is abbreviated. */
    title?: string;
    numeric?: boolean;
}

// MACHINE / BAGS / SIDE joined the grid on 2026-08-04, when entry moved from the docked
// composer into the rows themselves. They are not decoration: `cenapro_add_partner_draw`
// REFUSES a draw with no `partner_equipment_code`, and refuses a FLEC draw with no
// `flec_count` — so without a column for each, a typed row could never be saved. They
// render on EVERY row (not only the blank ones), because a row you are typing must look
// like the rows above it or the grid stops reading as one sheet.
//
// Placement follows the sentence the row already tells: when · what · WHERE it came out of
// (whse · side · bags) · what source · into WHICH machine · how much · what the lab said.
const COLS: LedgerCol[] = [
    { key: 'date', width: 62, label: 'Date', title: 'Receipt date at CCC' },
    { key: 'prod', width: 62, label: 'Prod', title: 'Production date of the material drawn' },
    { key: 'shift', width: 40, label: 'Sh', title: 'Shift' },
    { key: 'grade', width: 62, label: 'Grade' },
    { key: 'plant', width: 60, label: 'Plant' },
    { key: 'whse', width: 62, label: 'Whse', title: 'Warehouse (or plant, when unplaced)' },
    { key: 'side', width: 44, label: 'Side', title: 'Warehouse side (LS / RS) — FLEC draws only' },
    {
        key: 'bags',
        width: 52,
        label: 'Bags',
        title: 'Flec bag count — REQUIRED on a FLEC draw, refused on any other source',
        numeric: true,
    },
    { key: 'src', width: 62, label: 'SRC', title: 'Source location' },
    {
        key: 'mach',
        width: 58,
        label: 'Mach',
        title: 'Partner machine — C1–C4 (crusher) or RK1–RK4 (kiln). Required: it alone decides the disposition.',
    },
    {
        key: 'wt',
        width: 88,
        label: 'WT kg',
        title: 'Weight (kg) — editable on EVERY row, per individual draw. Unlike a lab reading, a weight never carries over to the group’s other rows.',
        numeric: true,
    },
    { key: 'bd', width: 124, label: 'BD', numeric: true },
    { key: 'ash', width: 124, label: 'ASH', numeric: true },
    { key: 'grit', width: 124, label: 'GRIT', numeric: true },
    { key: 'mc', width: 124, label: 'MC', numeric: true },
];

const MIN_WIDTH = COLS.reduce((sum, c) => sum + c.width, 0);
/** Date → Mach. The day-header / day-total rows rule off across these ten. */
const LABEL_SPAN = COLS.findIndex((c) => c.key === 'wt');
/** Visual column index of the first analysis column (BD). */
const FIRST_METRIC_COL = COLS.length - METRICS.length;
/** Visual column index of WT kg — the first EDITABLE column, one left of BD. */
const WT_COL = FIRST_METRIC_COL - 1;

// ─── The keyboard coordinate space ────────────────────────────────────────────────
//
// FIVE columns now, in visual order: `WT · BD · ASH · GRIT · MC`. Nav column 0 is the
// weight; nav column n>0 is `METRICS[n-1]`.
//
// The ROW axis changed with it, and that is the interesting part. It used to be one
// row per SAMPLE GROUP, because a lab reading covers a whole group and the four metric
// cells live on the group's first draw. A WEIGHT is not like that: it belongs to ONE
// physical draw, so every draw row must be independently addressable — including the
// `〃` sibling rows a metric can never land on. So the axis is now one row per DRAW,
// and the two column families disagree about which rows they occupy:
//
//   • WT      — live on EVERY row.
//   • metrics — live only on a group's LEAD row; on a sibling row they are `〃`,
//               inert, and have no coordinate at all.
//
// Which is why this module has its own resolver instead of `createCoordinateNavResolver`:
// that factory's `columnMap` is per-COLUMN, and this grid needs per-CELL addressability.
// The behavioural consequence is exactly the asymmetry the data model already has —
// ArrowDown in a metric lane walks lead-to-lead (skipping siblings, precisely as it did
// before this change), while ArrowDown in the WT lane walks draw-to-draw.
const NAV_COLS = METRICS.length + 1;
const NAV_LAST_COL = NAV_COLS - 1;

/** Nav column → what it edits. Column 0 is the weight; the rest are metrics. */
function navMetric(col: number): MetricKey | null {
    return col === 0 ? null : (METRICS[col - 1] ?? null);
}

interface QcNavGeometry {
    rowCount: number;
    /** True when row `n` is its sample group's FIRST draw — where the metrics live. */
    isLead: (row: number) => boolean;
}

/**
 * The QC ledger's nav resolver. Every branch answers one question: "is there an
 * ADDRESSABLE cell that way?" — and returns null (stay put) when there is not, so the
 * selection can never come to rest on a `〃`.
 */
function createQcNavResolver({ rowCount, isLead }: QcNavGeometry): NavResolver<CoordinateId> {
    const addressable = (row: number, col: number): boolean =>
        row >= 0 &&
        row < rowCount &&
        col >= 0 &&
        col <= NAV_LAST_COL &&
        (col === 0 || isLead(row));

    /** The nearest row above/below in which `col` is addressable. */
    const rowStep = (row: number, col: number, dir: 1 | -1): number | null => {
        for (let r = row + dir; r >= 0 && r < rowCount; r += dir) {
            if (addressable(r, col)) return r;
        }
        return null;
    };

    /** Reading order: across the row, then on to the next. Skips inert cells. */
    const tabStep = (from: CoordinateId, dir: 1 | -1): CoordinateId | null => {
        let { row, col } = from;
        const limit = rowCount * NAV_COLS + NAV_COLS;
        for (let guard = 0; guard < limit; guard++) {
            col += dir;
            if (col > NAV_LAST_COL) {
                row += 1;
                col = 0;
            } else if (col < 0) {
                row -= 1;
                col = NAV_LAST_COL;
            }
            if (row < 0 || row >= rowCount) return null;
            if (addressable(row, col)) return { row, col };
        }
        return null;
    };

    const vertical = (from: CoordinateId, dir: 1 | -1): CoordinateId | null => {
        const row = rowStep(from.row, from.col, dir);
        return row === null ? null : { row, col: from.col };
    };

    return {
        resolve(from, move) {
            if (move.kind === 'tab') return tabStep(from, move.shift ? -1 : 1);
            if (move.kind === 'enter') return vertical(from, move.shift ? -1 : 1);
            if (move.dir === 'up') return vertical(from, -1);
            if (move.dir === 'down') return vertical(from, 1);
            // left / right stay on the row and clamp at its edges.
            const dir = move.dir === 'right' ? 1 : -1;
            for (let col = from.col + dir; col >= 0 && col <= NAV_LAST_COL; col += dir) {
                if (addressable(from.row, col)) return { row: from.row, col };
            }
            return null;
        },
        laneOf: (id) => id.col,
        resolveInRow(from, lane, dir) {
            // The Enter-anchor lane may not exist below (a metric lane over a run of
            // sibling rows) — `rowStep` walks past them to the next row that has it.
            const col = typeof lane === 'number' ? lane : from.col;
            const row = rowStep(from.row, col, dir);
            return row === null ? null : { row, col };
        },
        isEditable: (id) => addressable(id.row, id.col),
    };
}

/** One addressable row of the grid: a single draw, and the group it belongs to. */
interface EntryRow {
    group: QcGroup;
    draw: QcDraw;
    /** First draw of its group — the row that carries the four editable metrics. */
    isLead: boolean;
}

// ── The two summary-row treatments ────────────────────────────────────────────────
//
// A day total is a SUM LINE, not another entry: it gets the accountant's rule-off — a
// heavy top border, an OPAQUE `bg-muted` band (matched to the frozen surfaces even
// though this row does not stick, so summary rows read as one family), semibold
// tabular figures, and a literal `Σ DAY TOTAL` label.

const DAY_TOTAL_CELL =
    'border-x border-b border-border/60 border-t-2 border-t-foreground/45 bg-muted py-1 align-middle text-foreground';
// Deliberately a much FAINTER band than the total row: in this ledger a filled grey
// band means "this is a sum", and the day header must not compete with that signal.
const DAY_HEADER_CELL = 'h-6 border-x border-border/60 bg-muted/25 px-2 py-1';
/** Sticky-bottom month footer. OPAQUE `bg-muted` + `.frozen-edge-top` — never glass. */
const MONTH_FOOTER_CELL =
    'frozen-row-bottom frozen-edge-top border-x border-border/60 bg-muted px-2 py-1 align-middle';

/** How a group's lead row should read while it is anything other than clean. */
type GroupFlag = 'blocked' | 'conflict';

export function QcLedgerClient({
    month,
    days,
    monthAgg,
    monthKeys,
    previousWtd,
    previousLabel,
    drawOptions,
}: QcLedgerClientProps) {
    const router = useRouter();
    const [edits, setEdits] = React.useState<EditMap>({});
    const [weightEdits, setWeightEdits] = React.useState<WeightEditMap>({});
    const [sourceFilter, setSourceFilter] = React.useState<string>('ALL');
    const [saving, setSaving] = React.useState(false);
    const [failures, setFailures] = React.useState<SaveFailure[]>([]);
    const gridRef = React.useRef<HTMLDivElement>(null);

    // ── Adding draws — IN THE ROWS, not in a panel (2026-08-04) ───────────────────
    // `drafts` is one ordered list for the whole month. A row's `anchorDate` says which
    // day block it renders in (`null` = the trailing block), and is fixed at creation so
    // retyping the date never makes a row jump out from under the cursor.
    const [drafts, setDrafts] = React.useState<DraftDraw[]>([]);
    const [addingDraws, setAddingDraws] = React.useState(false);
    /** The draw to point at — a row just committed, or one `already_exists` named. */
    const [markedDrawId, setMarkedDrawId] = React.useState<string | null>(null);

    const sources = React.useMemo(() => {
        const set = new Set<string>();
        for (const day of days) for (const group of day.groups) set.add(group.src);
        return [...set].sort();
    }, [days]);

    /** Every group in the month by key — the save payload's source of truth. */
    const groupByKey = React.useMemo(() => {
        const map = new Map<string, QcGroup>();
        for (const day of days) for (const group of day.groups) map.set(group.key, group);
        return map;
    }, [days]);

    /** Every draw in the month by id, with its group — the weight payload's source. */
    const drawById = React.useMemo(() => {
        const map = new Map<string, { draw: QcDraw; group: QcGroup }>();
        for (const day of days)
            for (const group of day.groups)
                for (const draw of group.draws) map.set(draw.id, { draw, group });
        return map;
    }, [days]);

    /**
     * Which day the composer opens on when it is opened from the toolbar rather than
     * from a day header: today when today is in the month on screen (the overwhelmingly
     * common case — the slip arrives the same day), else the month's last receipt day,
     * else its first calendar day.
     */
    const defaultAddDate = React.useMemo(() => {
        const today = new Date().toISOString().slice(0, 10);
        if (today.startsWith(month)) return today;
        return days[days.length - 1]?.date ?? `${month}-01`;
    }, [days, month]);

    /** How many blanks the "Add draw" button hands you. Renzo's number. */
    const BLANK_BATCH = 10;

    /**
     * Append blanks. `anchorDate === null` puts them in the trailing block under the
     * month (the toolbar's ten); a date puts them INSIDE that day's block, which is what
     * the day header's `+ ADD` does — "adding a row inside of an existing day".
     */
    const addBlanks = React.useCallback(
        (count: number, anchorDate: string | null, date: string) => {
            setDrafts((current) => [...current, ...makeBlankDrafts(count, date, anchorDate)]);
            setAddingDraws(true);
        },
        [],
    );

    const patchDraft = React.useCallback((id: string, patch: Partial<DraftDraw>) => {
        setDrafts((current) =>
            current.map((d) =>
                d.id === id
                    ? // Any edit clears a previous refusal — the operator is answering it,
                      // and a stale red message beside a corrected row reads as a new one.
                      { ...d, ...patch, status: 'draft' as const, message: undefined }
                    : d,
            ),
        );
    }, []);

    const removeDraft = React.useCallback((id: string) => {
        setDrafts((current) => current.filter((d) => d.id !== id));
    }, []);

    /** Drop every untouched blank, keep anything typed. The "tidy up" affordance. */
    const clearBlankDrafts = React.useCallback(() => {
        setDrafts((current) => current.filter(isMeaningfulDraft));
    }, []);

    /**
     * Bring the marked row into view once it actually exists in the render, then let the
     * mark fade out of relevance. Re-runs on `days` because the row arrives with the
     * refresh, not with the click.
     */
    React.useEffect(() => {
        if (!markedDrawId) return;
        gridRef.current
            ?.querySelector<HTMLElement>(`[data-draw-id="${markedDrawId}"]`)
            ?.scrollIntoView({ block: 'nearest' });
        const timer = window.setTimeout(() => setMarkedDrawId(null), 8000);
        return () => window.clearTimeout(timer);
    }, [markedDrawId, days]);

    /**
     * How much each group's tonnage would move if the pending weight edits were
     * saved. Keyed by group, because the aggregates are grouped even though the
     * weights are not: SQL published one `total_kg` per group, and this is the delta
     * to restate it by.
     *
     * An unparseable string (mid-typing `12.`, a stray letter) contributes NOTHING —
     * the preview keeps the stored weight rather than poisoning a total with NaN. The
     * save is blocked separately, by `badWeightIds`.
     */
    const groupKgDelta = React.useMemo(() => {
        const deltas = new Map<string, number>();
        for (const [drawId, raw] of Object.entries(weightEdits)) {
            const entry = drawById.get(drawId);
            if (!entry) continue;
            const { kg } = parseWeightKg(raw);
            if (kg == null) continue;
            const delta = kg - entry.draw.weightKg;
            if (delta === 0) continue;
            deltas.set(entry.group.key, (deltas.get(entry.group.key) ?? 0) + delta);
        }
        return deltas;
    }, [weightEdits, drawById]);

    /**
     * The month's day blocks, each carrying (a) the groups actually on screen and
     * (b) the adjustments that turn the SQL rollup into "what this day would read if
     * my typing were saved".
     *
     * NOTHING here re-aggregates. `day.agg` and `monthAgg` are the SQL views' own
     * numbers; `adjustAggregate` only swaps one group's contribution for another, and
     * with no filter and no typing it returns the SQL row untouched.
     */
    const dayViews = React.useMemo(() => {
        return days.map((day) => {
            const visible =
                sourceFilter === 'ALL'
                    ? day.groups
                    : day.groups.filter((group) => group.src === sourceFilter);
            const visibleKeys = new Set(visible.map((group) => group.key));

            const adjustments: AggregateAdjustment[] = [];
            for (const group of day.groups) {
                if (!visibleKeys.has(group.key)) {
                    // A filtered-out group leaves the period entirely — weight included.
                    adjustments.push({
                        kg: group.totalKg,
                        before: group.sample,
                        after: null,
                        dropWeight: true,
                    });
                    continue;
                }
                const after = overlay(group.sample, edits[group.key]);
                const kgDelta = groupKgDelta.get(group.key) ?? 0;
                if (after === group.sample && kgDelta === 0) continue;
                adjustments.push({
                    kg: group.totalKg,
                    before: group.sample,
                    after,
                    // The weight IS the weight: restating it moves the day total, the
                    // month total and each metric's own denominator, so the weighted
                    // averages move with it.
                    afterKg: group.totalKg + kgDelta,
                });
            }

            // One row per DRAW, in visual order — the keyboard grid's row axis.
            const rows: EntryRow[] = visible.flatMap((group) =>
                group.draws.map((draw, index) => ({ group, draw, isLead: index === 0 })),
            );

            return {
                date: day.date,
                groups: visible,
                rows,
                agg: adjustAggregate(day.agg, adjustments),
                adjustments,
            };
        });
    }, [days, sourceFilter, edits, groupKgDelta]);

    const visibleDays = React.useMemo(
        () => dayViews.filter((day) => day.groups.length > 0),
        [dayViews],
    );

    /**
     * Every DRAW row on screen, flattened in visual order. This array IS the keyboard
     * grid's row axis: index `n` here is `activeCell.row === n`. Day headers,
     * `Σ DAY TOTAL` rows and the frozen month footer are absent from it by
     * construction, which is exactly why Tab and the arrows can never land on one.
     *
     * A `〃` sibling row IS present here (its WT is editable) but is not `isLead`, so
     * its four metric cells stay unaddressable — see `createQcNavResolver`.
     */
    const entryRows = React.useMemo(
        () => visibleDays.flatMap((day) => day.rows),
        [visibleDays],
    );

    /** Every group on screen, for the payload builders and the DVO tally. */
    const entryGroups = React.useMemo(
        () => visibleDays.flatMap((day) => day.groups),
        [visibleDays],
    );

    /** Row index of each day's FIRST draw row, so a day block can address its cells. */
    const dayRowOffsets = React.useMemo(() => {
        const offsets: number[] = [];
        let cursor = 0;
        for (const day of visibleDays) {
            offsets.push(cursor);
            cursor += day.rows.length;
        }
        return offsets;
    }, [visibleDays]);

    /** The month rollup as it would read with every pending change applied. */
    const liveMonthAgg = React.useMemo(
        () => adjustAggregate(monthAgg, dayViews.flatMap((day) => day.adjustments)),
        [monthAgg, dayViews],
    );

    const dvoKg = React.useMemo(() => {
        // Pending weight edits move the DVO tally too, or the footer would report a
        // total that had moved next to a DVO share that had not.
        const pending = (group: QcGroup) => group.totalKg + (groupKgDelta.get(group.key) ?? 0);
        if (sourceFilter === 'ALL') {
            let sum = monthAgg.dvoKg;
            for (const [key, delta] of groupKgDelta) {
                if (groupByKey.get(key)?.isDvo) sum += delta;
            }
            return sum;
        }
        return entryGroups.reduce((sum, group) => (group.isDvo ? sum + pending(group) : sum), 0);
    }, [sourceFilter, monthAgg.dvoKg, entryGroups, groupKgDelta, groupByKey]);

    /**
     * The tile sparklines. One point per RECEIPT DAY of the selected month, carrying
     * that day's weighted average — derived from the SAME day aggregates the
     * `Σ DAY TOTAL` rows print, so a value typed into a cell moves its day's point
     * immediately. Nulls are KEPT: a day nobody sampled is a hole.
     */
    const dailySeries = React.useMemo(() => {
        const out = {} as Record<MetricKey, SeriesPoint[]>;
        for (const metric of METRICS) {
            out[metric] = visibleDays.map((day) => ({
                label: day.date.slice(8, 10),
                value: day.agg.wtd[metric],
            }));
        }
        return out;
    }, [visibleDays]);

    // ── Cell value plumbing ───────────────────────────────────────────────────────

    const cellValueByKey = React.useCallback(
        (groupKey: string, metric: MetricKey): string => {
            const edited = edits[groupKey]?.[metric];
            if (edited !== undefined) return edited;
            const stored = groupByKey.get(groupKey)?.sample?.[metric];
            return stored == null ? '' : formatMetric(stored, metric);
        },
        [edits, groupByKey],
    );

    /**
     * Write a cell. A value that matches what is STORED prunes its edit entry instead
     * of recording one, so retyping the number already on screen — or reverting with
     * Escape, which replays the pre-edit snapshot through here — leaves the group
     * genuinely clean rather than inflating "3 sample groups edited".
     */
    const setCell = React.useCallback(
        (groupKey: string, metric: MetricKey, raw: string) => {
            const stored = groupByKey.get(groupKey)?.sample?.[metric];
            const storedText = stored == null ? '' : formatMetric(stored, metric);
            setEdits((prev) => {
                const group = { ...prev[groupKey] };
                if (raw === storedText) delete group[metric];
                else group[metric] = raw;

                const next = { ...prev };
                if (Object.keys(group).length === 0) delete next[groupKey];
                else next[groupKey] = group;
                return next;
            });
        },
        [groupByKey],
    );

    // ── Weight plumbing (per DRAW, never fanned out) ──────────────────────────────

    const weightValueById = React.useCallback(
        (drawId: string): string => {
            const edited = weightEdits[drawId];
            if (edited !== undefined) return edited;
            const stored = drawById.get(drawId)?.draw.weightKg;
            return stored == null ? '' : formatKgExact(stored);
        },
        [weightEdits, drawById],
    );

    /**
     * Write one draw's weight. Pruned by VALUE, not by text: `40437` and `40,437`
     * are the same weight, and retyping what is already stored — or reverting with
     * Escape — must leave the row genuinely clean rather than inflating the count.
     */
    const setWeightCell = React.useCallback(
        (drawId: string, raw: string) => {
            const stored = drawById.get(drawId)?.draw.weightKg;
            const { kg } = parseWeightKg(raw);
            setWeightEdits((prev) => {
                const next = { ...prev };
                if (kg != null && stored != null && kg === stored) delete next[drawId];
                else next[drawId] = raw;
                return next;
            });
        },
        [drawById],
    );

    // ── Keyboard grid (the shared Blackwood Table state machine) ──────────────────
    //
    // `useGridKeyboardNav` — the SAME hook RC IN's bulk grid and the production
    // schedule run on, so the muscle memory transfers. The resolver is local
    // (`createQcNavResolver`) because this grid needs per-CELL addressability rather
    // than the shared factory's per-column `columnMap`: WT is live on every draw row,
    // the four metrics only on a group's lead row.
    //
    // Tab off MC wraps to the next row's WT; Shift+Tab off WT wraps back to the
    // previous row's last live cell; arrows clamp at the edges. A summary row has no
    // coordinate at all, which is why nav can never land on one.

    const [activeCell, setActiveCell] = React.useState<CoordinateId | null>(null);

    // A source-filter change or a month change re-lengthens the row axis under us; an
    // active cell past the new end would address a row that no longer exists.
    React.useEffect(() => {
        setActiveCell((current) => (current && current.row >= entryRows.length ? null : current));
    }, [entryRows.length]);

    const rowAt = React.useCallback(
        (row: number): EntryRow | null => entryRows[row] ?? null,
        [entryRows],
    );

    /** Read whichever kind of cell a coordinate names. */
    const valueAt = React.useCallback(
        (id: CoordinateId): string => {
            const entry = rowAt(id.row);
            if (!entry) return '';
            const metric = navMetric(id.col);
            if (!metric) return weightValueById(entry.draw.id);
            return entry.isLead ? cellValueByKey(entry.group.key, metric) : '';
        },
        [rowAt, weightValueById, cellValueByKey],
    );

    /** Write whichever kind of cell a coordinate names. */
    const writeAt = React.useCallback(
        (id: CoordinateId, value: string) => {
            const entry = rowAt(id.row);
            if (!entry) return;
            const metric = navMetric(id.col);
            if (!metric) setWeightCell(entry.draw.id, value);
            else if (entry.isLead) setCell(entry.group.key, metric, value);
        },
        [rowAt, setWeightCell, setCell],
    );

    const editSession = useGridEditSession<CoordinateId>({
        getValue: valueAt,
        setValue: writeAt,
    });

    /**
     * Put the moved-to cell on screen and hand the keyboard back to the scrollport.
     *
     * The `scrollIntoView` is the DELIBERATE part and stays: `nearest` on both axes is
     * the minimum nudge, and a no-op for a cell already in view. The `focus` is NOT
     * allowed to scroll anything — `HTMLElement.focus()` is specified to scroll its
     * target into view with block AND inline **"center"** through every scrolling
     * ancestor up to the document, and "center" always computes a target, so it fired on
     * EVERY caret move and re-centred the whole page (this runs on `onAfterMove`, i.e.
     * every Tab / Enter / arrow). `preventScroll` refuses that; focus still moves.
     */
    const focusCell = React.useCallback((id: CoordinateId) => {
        const root = gridRef.current;
        if (!root) return;
        root
            .querySelector<HTMLElement>(`[data-row="${id.row}"][data-col="${id.col}"]`)
            ?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
        root.focus({ preventScroll: true });
    }, []);

    const startEditing = React.useCallback(
        (row: number, col: number, initialChar?: string) => {
            const entry = rowAt(row);
            // A `〃` sibling's metric cell is inert — never open an editor over it.
            if (!entry || (col > 0 && !entry.isLead)) return;
            setActiveCell({ row, col });
            editSession.startEditing({ row, col }, initialChar);
        },
        [rowAt, editSession],
    );

    const revertCellEdit = React.useCallback(() => {
        editSession.revertChanges();
        gridRef.current?.focus({ preventScroll: true });
    }, [editSession]);

    const setIsEditing = React.useCallback(
        (editing: boolean) => {
            if (!editing) editSession.commit();
        },
        [editSession],
    );

    const resolver = React.useMemo(
        () =>
            createQcNavResolver({
                rowCount: entryRows.length,
                isLead: (row) => entryRows[row]?.isLead === true,
            }),
        [entryRows],
    );

    const { handleKeyDown } = useGridKeyboardNav<CoordinateId>({
        activeCell,
        setActiveCell,
        isEditing: editSession.isEditing,
        resolver,
        edit: {
            start: (id, char) => startEditing(id.row, id.col, char),
            revert: revertCellEdit,
            commit: () => {
                editSession.commit();
                gridRef.current?.focus({ preventScroll: true });
            },
        },
        onAfterMove: focusCell,
        // The RC IN convention: the first Tab of a run remembers the lane you started
        // in, and a later plain Enter drops one row and RETURNS to it. Filling BD → ASH
        // → GRIT → MC → Enter puts you back on the next row's BD, not its MC — and a
        // run started on WT comes back to WT.
        enableEnterAnchor: true,
    });

    // ── Save ──────────────────────────────────────────────────────────────────────

    const dirtyKeys = React.useMemo(() => Object.keys(edits), [edits]);
    const dirtyWeightIds = React.useMemo(() => Object.keys(weightEdits), [weightEdits]);
    const totalDirty = dirtyKeys.length + dirtyWeightIds.length;

    /**
     * Typed NEW rows, split by whether they can be sent yet. An UNTOUCHED blank is
     * neither — it is scaffolding, not an unsaved change, so ten waiting blanks neither
     * light up the Save button nor count as ten problems.
     */
    const { readyDrafts, blockedDrafts } = React.useMemo(() => {
        let ready = 0;
        let blocked = 0;
        for (const d of drafts) {
            if (d.status === 'saved' || !isMeaningfulDraft(d)) continue;
            if (draftBlocker(d)) blocked += 1;
            else ready += 1;
        }
        return { readyDrafts: ready, blockedDrafts: blocked };
    }, [drafts]);

    /** Untouched blanks on screen — what "Clear empty rows" would remove. */
    const blankDrafts = React.useMemo(
        () => drafts.filter((d) => !isMeaningfulDraft(d)).length,
        [drafts],
    );

    /** Drafts with no day of their own — the block under the whole month. */
    const trailingDrafts = React.useMemo(
        () => drafts.filter((d) => d.anchorDate === null),
        [drafts],
    );

    const totalPending = totalDirty + readyDrafts;

    /**
     * Weights that could never be saved: blank, non-numeric, negative, over three
     * decimals, absurd. `weight_kg` is NOT NULL and CHECK > 0 in the database, so this
     * is caught here and reported inline rather than spent on a round trip.
     */
    const badWeightIds = React.useMemo(
        () => dirtyWeightIds.filter((id) => parseWeightKg(weightEdits[id]).kg == null),
        [dirtyWeightIds, weightEdits],
    );

    /**
     * Groups whose every metric would end up blank. The RPC rejects that outright
     * (`no_metrics` — clearing a reading is a DELETE, which this screen does not do),
     * so it is caught here and reported inline instead of costing a round trip.
     */
    const emptiedKeys = React.useMemo(
        () =>
            dirtyKeys.filter((key) => {
                const group = groupByKey.get(key);
                if (!group) return false;
                return !hasAnyMetric(overlay(group.sample, edits[key]));
            }),
        [dirtyKeys, groupByKey, edits],
    );

    /** Lead-row decoration per group key: the two states worth pointing at. */
    const groupFlags = React.useMemo(() => {
        const map = new Map<string, GroupFlag>();
        for (const failure of failures) {
            if (failure.kind === 'sample') map.set(failure.target, 'conflict');
        }
        for (const key of emptiedKeys) map.set(key, 'blocked');
        return map;
    }, [failures, emptiedKeys]);

    /** The same two states, per DRAW, for the WT column. */
    const weightFlags = React.useMemo(() => {
        const map = new Map<string, GroupFlag>();
        for (const failure of failures) {
            if (failure.kind === 'weight') map.set(failure.target, 'conflict');
        }
        for (const id of badWeightIds) map.set(id, 'blocked');
        return map;
    }, [failures, badWeightIds]);

    const discard = React.useCallback(() => {
        setEdits({});
        setWeightEdits({});
        setFailures([]);
        // Typed new rows are unsaved changes like any other, so Discard clears them too.
        setDrafts([]);
        setAddingDraws(false);
    }, []);

    /**
     * ONE Save. A weight correction and a lab reading typed in the same sitting commit
     * together, through their own write paths — the sample RPC per group, the weight
     * RPC per draw — and come back as one merged verdict list.
     *
     * Nothing is all-or-nothing across the two: each row carries its own concurrency
     * check, so a conflict on one draw's weight leaves the other rows saved and keeps
     * that draw's typing on screen.
     */
    const save = React.useCallback(async () => {
        if (totalPending === 0 || saving) return;

        // ── Blocked before anything leaves the browser ────────────────────────────
        if (emptiedKeys.length > 0 || badWeightIds.length > 0) {
            setFailures([
                ...emptiedKeys.map((key) => ({
                    key: `s:${key}`,
                    kind: 'sample' as const,
                    target: key,
                    label: describeGroup(groupByKey.get(key)),
                    outcome: 'no_metrics' as const,
                    message:
                        'Every metric was cleared. A sample must keep at least one of BD / ASH / GRIT / MC — re-enter a value, or press Esc to restore what was stored.',
                })),
                ...badWeightIds.map((id) => ({
                    key: `w:${id}`,
                    kind: 'weight' as const,
                    target: id,
                    label: describeDraw(drawById.get(id)),
                    outcome: 'invalid' as const,
                    message:
                        parseWeightKg(weightEdits[id]).error ??
                        'That weight cannot be saved — re-enter it, or press Esc to restore what was stored.',
                })),
            ]);
            return;
        }

        const weightPayloads: SaveQcWeightInput[] = [];
        for (const id of dirtyWeightIds) {
            const entry = drawById.get(id);
            if (!entry) continue;
            weightPayloads.push({
                id,
                // Compare-and-set: the weight this operator was looking at. If the
                // stored value has moved since, the write does not happen.
                expectedWeightKg: entry.draw.weightKg,
                raw: weightEdits[id],
            });
        }

        const payloads: SaveQcSampleInput[] = [];
        for (const key of dirtyKeys) {
            const group = groupByKey.get(key);
            if (!group) continue;
            const merged = overlay(group.sample, edits[key]) ?? EMPTY_METRIC_VALUES;
            payloads.push({
                key,
                sampleDate: group.date,
                sourceLocationCode: group.src,
                whseKey: group.whse,
                bd: merged.bd,
                ash: merged.ash,
                grit: merged.grit,
                mc: merged.mc,
                // Straight through: NULL creates, an integer updates against that
                // exact version. Never re-read and retry — a conflict is a human's.
                expectedRowVersion: group.rowVersion,
            });
        }

        // Typed NEW rows. Only the ones with something in them — ten untouched blanks
        // must never become ten validation errors — and only the ones that pass the
        // courtesy check, so an obviously-incomplete line costs no round trip.
        const draftRows = drafts
            .filter((d) => d.status !== 'saved' && isMeaningfulDraft(d) && !draftBlocker(d))
            .map((d) => ({ rowId: d.id, input: draftToInput(d, d.needsDuplicateConfirm === true) }));

        setSaving(true);
        setFailures([]);
        try {
            // NEW rows first. They create the sample groups the readings below attach
            // to, so a slip transcribed and analysed in one sitting saves in one press.
            if (draftRows.length > 0) {
                const ids = new Set(draftRows.map((r) => r.rowId));
                setDrafts((current) =>
                    current.map((d) => (ids.has(d.id) ? { ...d, status: 'saving' as const } : d)),
                );
                const drawRun = await addQcDraws(draftRows);
                setDrafts((current) => {
                    const verdict = new Map(drawRun.map((r) => [r.rowId, r.result]));
                    return current
                        .map((d) => {
                            const v = verdict.get(d.id);
                            if (!v) return d;
                            if (v.ok && v.outcome === 'inserted') {
                                // Drop it — the saved row arrives with the refresh below.
                                return { ...d, status: 'saved' as const };
                            }
                            return {
                                ...d,
                                status: 'failed' as const,
                                message: v.message ?? 'could not save',
                                // A duplicate is the operator's call: only they know
                                // whether the slip lists two trips or they keyed one
                                // twice. Pressing Save again re-sends it confirmed.
                                needsDuplicateConfirm: v.outcome === 'duplicate_warning',
                            };
                        })
                        .filter((d) => d.status !== 'saved');
                });
                const inserted = drawRun.filter((r) => r.result.ok && r.result.outcome === 'inserted');
                if (inserted.length > 0) {
                    toast.success(
                        `Added ${inserted.length} draw${inserted.length === 1 ? '' : 's'}`,
                        { duration: 2500 },
                    );
                    const landed = inserted[inserted.length - 1].result;
                    if (landed.id) setMarkedDrawId(landed.id);
                    // A source filter that hides the new rows makes a successful add
                    // look like it did nothing.
                    setSourceFilter('ALL');
                }
                const drawFailures = drawRun.filter((r) => !(r.result.ok && r.result.outcome === 'inserted'));
                if (drawFailures.length > 0) {
                    errorToast(
                        `${drawFailures.length} draw${drawFailures.length === 1 ? '' : 's'} could not be added`,
                        {
                            description: drawFailures
                                .map((r) => r.result.message ?? r.result.outcome)
                                .join('\n'),
                        },
                    );
                }
            }

            // Weights first, then readings: fix what the number IS before recording
            // what was measured about it. (Independent rows — order is a reading
            // convenience, not a correctness requirement.)
            const weightRun = weightPayloads.length
                ? await saveQcWeights(weightPayloads)
                : { results: [] as SaveQcWeightResult[], savedCount: 0, failedCount: 0 };
            const sampleRun = payloads.length
                ? await saveQcSamples(payloads)
                : { results: [] as SaveQcSampleResult[], savedCount: 0, failedCount: 0 };

            const savedWeights = new Set(
                weightRun.results.filter((r) => r.ok).map((r) => r.id),
            );
            if (savedWeights.size > 0) {
                setWeightEdits((prev) => {
                    const next = { ...prev };
                    for (const id of savedWeights) delete next[id];
                    return next;
                });
            }

            const savedGroups = new Set(sampleRun.results.filter((r) => r.ok).map((r) => r.key));
            if (savedGroups.size > 0) {
                // Only what actually landed loses its pending text; a conflicted row
                // keeps what was typed so nothing has to be retyped.
                setEdits((prev) => {
                    const next = { ...prev };
                    for (const key of savedGroups) delete next[key];
                    return next;
                });
            }

            const savedTotal = sampleRun.savedCount + weightRun.savedCount;
            if (savedTotal > 0) {
                toast.success(describeSaved(sampleRun.savedCount, weightRun.savedCount), {
                    duration: 2500,
                });
                router.refresh();
            }

            const rows: SaveFailure[] = [
                ...weightRun.results
                    .filter((r) => !r.ok)
                    .map((result) => toWeightFailure(result, drawById.get(result.id))),
                ...sampleRun.results
                    .filter((r) => !r.ok)
                    .map((result) => toFailure(result, groupByKey.get(result.key))),
            ];
            if (rows.length > 0) {
                setFailures(rows);
                errorToast(
                    `${rows.length} change${rows.length === 1 ? '' : 's'} could not be saved`,
                    { description: rows.map((row) => `${row.label} — ${row.message}`).join('\n') },
                );
            }
        } catch (cause) {
            errorToast('Saving the QC ledger failed', {
                description: cause instanceof Error ? cause.message : String(cause),
            });
        } finally {
            setSaving(false);
        }
    }, [
        totalPending,
        saving,
        emptiedKeys,
        badWeightIds,
        dirtyKeys,
        dirtyWeightIds,
        groupByKey,
        drawById,
        edits,
        weightEdits,
        drafts,
        router,
    ]);

    const loggedGroups = liveMonthAgg.sampledGroupCount;

    return (
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
            {/* ── Toolbar ─────────────────────────────────────────────────────────── */}
            <div className="shrink-0 border-b border-border px-3 py-2">
                <div className="flex flex-wrap items-center gap-2">
                    <MonthYearPicker month={month} availableMonths={monthKeys} />

                    <select
                        aria-label="Filter by source"
                        value={sourceFilter}
                        onChange={(event) => setSourceFilter(event.target.value)}
                        className="h-7 rounded-md border border-border bg-card px-2 text-xs"
                    >
                        <option value="ALL">All sources</option>
                        {sources.map((src) => (
                            <option key={src} value={src}>
                                {src}
                            </option>
                        ))}
                    </select>

                    {/* Adding is a DESKTOP action — the grid it writes into is hidden
                        below `sm`, so the button is too. It appends TEN blank rows under
                        the month rather than opening anything: a slip is several lines,
                        and a composer that produced one line at a time made you re-find
                        your place on the paper after every one. */}
                    <Button
                        size="sm"
                        variant={addingDraws ? 'secondary' : 'default'}
                        className="hidden h-7 text-xs sm:inline-flex"
                        onClick={() => addBlanks(BLANK_BATCH, null, defaultAddDate)}
                        title={`Add ${BLANK_BATCH} blank rows at the bottom of ${formatMonthHeading(month)}`}
                    >
                        <Plus className="mr-1 h-3 w-3" />
                        {addingDraws ? `Add ${BLANK_BATCH} more` : 'Add draw'}
                    </Button>

                    <Chip tone={loggedGroups === liveMonthAgg.groupCount ? 'ok' : 'pending'}>
                        {loggedGroups} of {liveMonthAgg.groupCount} samples logged
                    </Chip>
                    {/* The month's kg + coverage stay visible without scrolling to the
                        frozen footer — same aggregate object, so they cannot drift. */}
                    <Chip tone="muted">
                        {formatKg(liveMonthAgg.totalKg)} kg ·{' '}
                        {formatCoverage(liveMonthAgg.coverage)} sampled
                    </Chip>

                    <div className="ml-auto flex items-center gap-3">
                        <span className="hidden text-[11px] text-muted-foreground/70 xl:block">
                            Click a cell and type · <Kbd>Tab</Kbd> across · <Kbd>Enter</Kbd> down ·{' '}
                            <Kbd>F2</Kbd> edit · <Kbd>Esc</Kbd> cancel
                        </span>
                        <Link
                            href={`/cenapro/qc/breakdown?m=${month}`}
                            className="shrink-0 text-[11px] text-muted-foreground underline underline-offset-2 transition-colors duration-150 hover:text-foreground"
                        >
                            QC Breakdown →
                        </Link>
                    </div>
                </div>
            </div>

            <div className="flex min-h-0 flex-1 flex-col overflow-hidden p-3">
                <NarrowScreenNotice />

                <div className="hidden min-h-0 flex-1 flex-col sm:flex">
                    {failures.length > 0 ? (
                        <SaveFailureBanner
                            failures={failures}
                            onReload={() => {
                                setFailures([]);
                                router.refresh();
                            }}
                            onDismiss={() => setFailures([])}
                        />
                    ) : null}

                    {/* ── Month KPI tiles ──────────────────────────────────────────── */}
                    <div className="mb-3 grid shrink-0 grid-cols-2 gap-2 lg:grid-cols-4">
                        {METRICS.map((metric) => (
                            <Tile
                                key={metric}
                                label={`Wtd avg ${METRIC_LABEL[metric]}`}
                                value={formatMetric(liveMonthAgg.wtd[metric], metric, true)}
                                sub={deltaCaption(
                                    liveMonthAgg.wtd[metric],
                                    previousWtd?.[metric] ?? null,
                                    metric,
                                    previousLabel,
                                )}
                            >
                                <MetricSpark series={dailySeries[metric]} metric={metric} />
                            </Tile>
                        ))}
                    </div>

                    {/* The grid and the add composer sit SIDE BY SIDE — the panel is
                        docked, not an overlay, so a draw being transcribed can be
                        watched landing in the day block it belongs to. */}
                    <div className="flex min-h-0 flex-1">
                    {/* ── The grid ─────────────────────────────────────────────────────
                        Its OWN scrollport (min-h-0 flex-1 overflow-auto): that is what
                        makes the sticky header row and the sticky month footer actually
                        pin. `minWidth` on the table keeps "never crush, always scroll".
                        It is ALSO the keyboard host — `tabIndex={0}` + the grid keydown
                        live here, and every cell is `tabIndex={-1}`, so Tab is ours to
                        interpret and can never walk out of the sheet mid-entry.
                    */}
                    <div
                        ref={gridRef}
                        tabIndex={0}
                        onKeyDown={handleKeyDown}
                        role="grid"
                        aria-label={`QC analysis ledger — ${formatMonthHeading(month)}`}
                        className="min-h-0 min-w-0 flex-1 overflow-auto rounded-lg border border-border outline-none focus-visible:ring-1 focus-visible:ring-ring"
                    >
                        <table
                            className="w-full table-fixed border-collapse text-xs"
                            style={{ minWidth: `${MIN_WIDTH}px` }}
                        >
                            <colgroup>
                                {COLS.map((col) => (
                                    <col key={col.key} style={{ width: `${col.width}px` }} />
                                ))}
                            </colgroup>
                            <thead>
                                <tr>
                                    {COLS.map((col, index) => (
                                        <th
                                            key={col.key}
                                            scope="col"
                                            title={col.title}
                                            className={cn(
                                                'frozen-row whitespace-nowrap border border-border bg-muted px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground',
                                                col.numeric ? 'text-right' : 'text-left',
                                                // The work half is visually claimed, not
                                                // just wider: the editable headers read
                                                // as foreground, the reference columns
                                                // stay muted. WT joined that half when
                                                // it became typable.
                                                index >= WT_COL && 'text-foreground',
                                            )}
                                        >
                                            {col.label}
                                        </th>
                                    ))}
                                </tr>
                            </thead>
                            <tbody>
                                {visibleDays.length === 0 ? (
                                    <tr>
                                        <td
                                            colSpan={COLS.length}
                                            className="px-2 py-6 text-center text-xs text-muted-foreground"
                                        >
                                            No partner receipts in {formatMonthHeading(month)}.
                                            {sourceFilter === 'ALL' && drafts.length === 0 ? (
                                                <Button
                                                    size="sm"
                                                    variant="outline"
                                                    className="ml-2 h-6 text-[11px]"
                                                    onClick={() => addBlanks(BLANK_BATCH, null, defaultAddDate)}
                                                >
                                                    <Plus className="mr-1 h-3 w-3" />
                                                    Add the first draw
                                                </Button>
                                            ) : null}
                                        </td>
                                    </tr>
                                ) : null}

                                {visibleDays.map((day, dayIndex) => (
                                    <DayBlock
                                        key={day.date}
                                        date={day.date}
                                        rows={day.rows}
                                        agg={day.agg}
                                        rowOffset={dayRowOffsets[dayIndex]}
                                        markedDrawId={markedDrawId}
                                        onAddDraw={(date) => addBlanks(1, date, date)}
                                        drafts={drafts.filter((d) => d.anchorDate === day.date)}
                                        drawOptions={drawOptions}
                                        onDraftChange={patchDraft}
                                        onDraftRemove={removeDraft}
                                        activeCell={activeCell}
                                        isEditing={editSession.isEditing}
                                        setActiveCell={setActiveCell}
                                        setIsEditing={setIsEditing}
                                        onStartEditing={startEditing}
                                        onRevert={revertCellEdit}
                                        gridRef={gridRef}
                                        cellValue={cellValueByKey}
                                        setCell={setCell}
                                        weightValue={weightValueById}
                                        setWeight={setWeightCell}
                                        weightEdits={weightEdits}
                                        groupFlags={groupFlags}
                                        weightFlags={weightFlags}
                                    />
                                ))}

                                {/* The trailing entry block — the ten blanks the toolbar
                                    hands you, under the month's last row. Rows added from
                                    a day header render inside that day instead. */}
                                {trailingDrafts.length > 0 ? (
                                    <>
                                        <tr>
                                            <td
                                                colSpan={COLS.length}
                                                className={cn(
                                                    DAY_HEADER_CELL,
                                                    'border-t border-border text-[10px] font-semibold uppercase tracking-wider text-primary/70',
                                                )}
                                            >
                                                New draws — type down the slip, then Save
                                            </td>
                                        </tr>
                                        {trailingDrafts.map((draft) => (
                                            <DraftRow
                                                key={draft.id}
                                                draft={draft}
                                                options={drawOptions}
                                                metricCount={METRICS.length}
                                                onChange={patchDraft}
                                                onRemove={removeDraft}
                                            />
                                        ))}
                                        <tr>
                                            <td colSpan={COLS.length} className="border-x border-border/60 px-2 py-1">
                                                <button
                                                    type="button"
                                                    onClick={() => addBlanks(BLANK_BATCH, null, defaultAddDate)}
                                                    className="inline-flex items-center gap-1 rounded px-1 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground transition-colors duration-150 hover:bg-muted hover:text-foreground"
                                                >
                                                    <Plus className="h-2.5 w-2.5" />
                                                    {BLANK_BATCH} more rows
                                                </button>
                                            </td>
                                        </tr>
                                    </>
                                ) : null}
                            </tbody>

                            {visibleDays.length > 0 ? (
                                <MonthFooter month={month} agg={liveMonthAgg} dvoKg={dvoKg} />
                            ) : null}
                        </table>
                    </div>

                    </div>
                </div>
            </div>

            {/* ── Save bar ────────────────────────────────────────────────────────── */}
            <div className="shrink-0 border-t border-border bg-background/95 px-3 py-2 backdrop-blur supports-backdrop-filter:bg-background/60">
                <div className="flex flex-wrap items-center gap-2">
                    <Button
                        size="sm"
                        className="h-7 text-xs"
                        disabled={totalPending === 0 || saving}
                        onClick={() => void save()}
                    >
                        {saving ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : null}
                        {totalPending === 0
                            ? 'Save'
                            : `Save ${[
                                  readyDrafts > 0
                                      ? `${readyDrafts} new draw${readyDrafts === 1 ? '' : 's'}`
                                      : null,
                                  totalDirty > 0
                                      ? describeDirty(dirtyKeys.length, dirtyWeightIds.length)
                                      : null,
                              ]
                                  .filter(Boolean)
                                  .join(' · ')}`}
                    </Button>
                    {totalPending > 0 ? (
                        <Button
                            size="sm"
                            variant="ghost"
                            className="h-7 text-xs"
                            disabled={saving}
                            onClick={discard}
                        >
                            Discard
                        </Button>
                    ) : null}
                    {blankDrafts > 0 ? (
                        <Button
                            size="sm"
                            variant="ghost"
                            className="h-7 text-xs text-muted-foreground"
                            disabled={saving}
                            onClick={clearBlankDrafts}
                            title="Remove the rows you did not type into. Anything typed is kept."
                        >
                            Clear {blankDrafts} empty row{blankDrafts === 1 ? '' : 's'}
                        </Button>
                    ) : null}
                    <span
                        className={cn(
                            'text-[11px]',
                            emptiedKeys.length + badWeightIds.length + blockedDrafts > 0
                                ? 'text-amber-600 dark:text-amber-400'
                                : 'text-muted-foreground',
                        )}
                    >
                        {emptiedKeys.length > 0
                            ? `${emptiedKeys.length} group${emptiedKeys.length === 1 ? ' has' : 's have'} every metric cleared — that would delete the reading`
                            : badWeightIds.length > 0
                              ? `${badWeightIds.length} weight${badWeightIds.length === 1 ? ' is' : 's are'} not a valid number of kilograms`
                              : blockedDrafts > 0
                                ? `${blockedDrafts} new row${blockedDrafts === 1 ? ' is' : 's are'} incomplete — each says what it needs. They are skipped, not lost.`
                              : totalPending === 0
                                ? 'No unsaved changes'
                                : dirtyWeightIds.length > 0
                                  ? 'Each row saves on its own — a reading against its version, a weight against the value you were shown'
                                  : 'Each group saves as its own row, with its own version check'}
                    </span>
                </div>
            </div>
        </div>
    );
}

// ─── Small helpers ───────────────────────────────────────────────────────────────

function Kbd({ children }: { children: React.ReactNode }) {
    return (
        <kbd className="rounded border border-border bg-muted px-1 font-mono text-[10px] text-muted-foreground">
            {children}
        </kbd>
    );
}

/**
 * The tile's second line: how far this month has moved from the last one.
 *
 * Signed and unqualified on purpose — BD up is not "good" and ASH down is not "bad" in
 * any way this page can know, so the delta is reported, never coloured as a verdict.
 */
function deltaCaption(
    current: number | null,
    previous: number | null,
    metric: MetricKey,
    previousLabel: string | null,
): string {
    if (!previousLabel) return 'no prior month';
    if (current == null || previous == null) return `${previousLabel} · no comparable value`;
    const diff = current - previous;
    if (diff === 0) return `no change vs ${previousLabel}`;
    const sign = diff > 0 ? '+' : '−';
    return `${sign}${formatMetric(Math.abs(diff), metric, true)} vs ${previousLabel} ${formatMetric(previous, metric, true)}`;
}

function describeGroup(group: QcGroup | undefined): string {
    if (!group) return 'Unknown sample group';
    return `${formatDayHeading(group.date).split(' · ')[0]} · ${group.src} · ${group.whse}`;
}

/** A weight belongs to one DRAW, so its label names the draw, not just the group. */
function describeDraw(entry: { draw: QcDraw; group: QcGroup } | undefined): string {
    if (!entry) return 'Unknown receipt row';
    return `${describeGroup(entry.group)} · ${entry.draw.equip ?? 'draw'} · WT`;
}

/** `3 samples · 2 weights`, and the singular of each. */
function describeDirty(samples: number, weights: number): string {
    const parts: string[] = [];
    if (samples > 0) parts.push(`${samples} sample${samples === 1 ? '' : 's'}`);
    if (weights > 0) parts.push(`${weights} weight${weights === 1 ? '' : 's'}`);
    return parts.join(' · ');
}

function describeSaved(samples: number, weights: number): string {
    return `Saved ${describeDirty(samples, weights)}`;
}

/**
 * The exact weight, with thousands separators — used ONLY by the editable WT cells.
 *
 * NOT `formatKg`, which rounds to whole kilograms. That is the right call for a SUM
 * (day totals, the month footer) but lethal in a cell you can type over: a stored
 * 9,583.5 would display as "9,584", and committing the cell would write the rounded
 * number back. Nothing on record is fractional today, but the write path accepts three
 * decimals, so the display must be lossless before the first one arrives, not after.
 */
function formatKgExact(value: number): string {
    if (!Number.isFinite(value)) return '';
    return value.toLocaleString('en-US', { maximumFractionDigits: 3 });
}

// ─── Save failures ───────────────────────────────────────────────────────────────

interface SaveFailure {
    /** Unique React key across both kinds (`s:<groupKey>` / `w:<drawId>`). */
    key: string;
    /** Which write path produced it — decides which cell gets the rose ring. */
    kind: 'sample' | 'weight';
    /** The group key (samples) or the draw id (weights). */
    target: string;
    label: string;
    outcome: SaveQcSampleResult['outcome'] | SaveQcWeightResult['outcome'];
    message: string;
}

/**
 * Turn one RPC verdict into something an operator can act on. Every outcome gets its
 * own sentence — a conflict is NOT retried, force-written, or papered over.
 */
function toFailure(result: SaveQcSampleResult, group: QcGroup | undefined): SaveFailure {
    const base = {
        key: `s:${result.key}`,
        kind: 'sample' as const,
        target: result.key,
        label: describeGroup(group),
        outcome: result.outcome,
    };
    switch (result.outcome) {
        case 'version_conflict':
            return {
                ...base,
                message:
                    'Someone else changed this sample while you were editing. Reload to see their values.',
            };
        case 'already_exists':
            return {
                ...base,
                message:
                    'A sample was logged for this group while you were typing. Reload, then edit the value that is now stored.',
            };
        case 'not_found':
            return {
                ...base,
                message: 'That sample was deleted while you were editing. Reload the ledger.',
            };
        case 'no_metrics':
            return {
                ...base,
                message:
                    'Every metric was cleared. A sample must keep at least one of BD / ASH / GRIT / MC — re-enter a value, or press Esc to restore what was stored.',
            };
        case 'invalid_key':
            return {
                ...base,
                message:
                    result.message ?? 'The date / source / warehouse key was incomplete. Reload the ledger.',
            };
        default:
            return { ...base, message: result.message ?? 'The save failed for an unknown reason.' };
    }
}

/**
 * The weight write path's verdict, in the same voice. A `conflict` is the compare-and-
 * set refusing to overwrite a value that moved underneath — never retried, never
 * force-written, and the RPC's message already names both numbers.
 */
function toWeightFailure(
    result: SaveQcWeightResult,
    entry: { draw: QcDraw; group: QcGroup } | undefined,
): SaveFailure {
    const base = {
        key: `w:${result.id}`,
        kind: 'weight' as const,
        target: result.id,
        label: describeDraw(entry),
        outcome: result.outcome,
    };
    switch (result.outcome) {
        case 'conflict':
            return {
                ...base,
                message:
                    result.message ??
                    'This weight changed while you were editing. Reload to see the value that is now stored.',
            };
        case 'not_found':
            return {
                ...base,
                message: 'That receipt row was deleted while you were editing. Reload the ledger.',
            };
        case 'invalid':
            return {
                ...base,
                message:
                    result.message ??
                    'That weight cannot be saved — re-enter it, or press Esc to restore what was stored.',
            };
        default:
            return {
                ...base,
                message: result.message ?? 'The weight could not be saved for an unknown reason.',
            };
    }
}

/**
 * The inline half of the error HARD RULE: persists until dismissed, and carries a Copy
 * button so the whole list can be pasted somewhere without a screenshot.
 */
function SaveFailureBanner({
    failures,
    onReload,
    onDismiss,
}: {
    failures: SaveFailure[];
    onReload: () => void;
    onDismiss: () => void;
}) {
    const [copied, setCopied] = React.useState(false);
    const text = failures.map((failure) => `${failure.label} — ${failure.message}`).join('\n');
    // Reloading fixes a stale read. It cannot fix something the operator typed, so a
    // blocked sample or an unparseable weight does not offer the button.
    const reloadable = failures.some(
        (failure) => failure.outcome !== 'no_metrics' && failure.outcome !== 'invalid',
    );

    return (
        <div
            role="alert"
            className="mb-3 shrink-0 animate-fade-up rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2"
        >
            <div className="flex items-start gap-2">
                <div className="min-w-0 flex-1">
                    <p className="text-xs font-semibold text-destructive">
                        {failures.length} change{failures.length === 1 ? '' : 's'} not saved
                    </p>
                    <ul className="mt-1 space-y-0.5">
                        {failures.map((failure) => (
                            <li key={failure.key} className="text-[11px] leading-relaxed text-destructive/90">
                                <span className="font-mono font-semibold">{failure.label}</span> —{' '}
                                {failure.message}
                            </li>
                        ))}
                    </ul>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                    {reloadable ? (
                        <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            className="h-6 px-2 text-[11px] text-destructive hover:text-destructive"
                            onClick={onReload}
                        >
                            <RotateCw className="mr-1 h-3 w-3" />
                            Reload
                        </Button>
                    ) : null}
                    <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="h-6 px-2 text-[11px] text-destructive hover:text-destructive"
                        onClick={() => {
                            void navigator.clipboard.writeText(text).then(() => {
                                setCopied(true);
                                window.setTimeout(() => setCopied(false), 2000);
                            });
                        }}
                    >
                        {copied ? <Check className="mr-1 h-3 w-3" /> : <Copy className="mr-1 h-3 w-3" />}
                        {copied ? 'Copied' : 'Copy'}
                    </Button>
                    <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="h-6 px-2 text-[11px] text-destructive hover:text-destructive"
                        onClick={onDismiss}
                    >
                        Dismiss
                    </Button>
                </div>
            </div>
        </div>
    );
}

// ─── Edit overlay ────────────────────────────────────────────────────────────────

/**
 * A group's stored sample with whatever has been typed into it laid on top, so the day
 * totals and the month footer respond to the keyboard. An unparseable string
 * (mid-typing `0.`, a stray `-`) keeps the previous value rather than poisoning a
 * weighted average with `NaN`; an emptied cell genuinely clears to null.
 *
 * Returns the SAME object when nothing changed, which is what lets the callers skip
 * building an adjustment at all — and therefore render the SQL number untouched.
 */
function overlay(
    stored: MetricValues | null,
    edited: Partial<Record<MetricKey, string>> | undefined,
): MetricValues | null {
    if (!edited) return stored;

    const next: MetricValues = { ...(stored ?? EMPTY_METRIC_VALUES) };
    let changed = false;

    for (const metric of METRICS) {
        const raw = edited[metric];
        if (raw === undefined) continue;
        const trimmed = raw.trim();
        let value: number | null;
        if (trimmed === '') {
            value = null;
        } else {
            const parsed = Number.parseFloat(trimmed);
            if (!Number.isFinite(parsed)) continue;
            value = parsed;
        }
        if (value !== next[metric]) {
            next[metric] = value;
            changed = true;
        }
    }

    return changed ? next : stored;
}

// ─── One day: header row · draw rows · the ruled-off DAY TOTAL ───────────────────

interface DayBlockProps {
    date: string;
    /** This day's draw rows, in visual order — the grid's row axis, sliced. */
    rows: EntryRow[];
    agg: QcAggregate;
    /** Grid row index of this day's FIRST draw row. */
    rowOffset: number;
    activeCell: CoordinateId | null;
    isEditing: boolean;
    setActiveCell: (cell: CoordinateId) => void;
    setIsEditing: (editing: boolean) => void;
    onStartEditing: (row: number, col: number, char?: string) => void;
    onRevert: () => void;
    gridRef: React.RefObject<HTMLDivElement | null>;
    cellValue: (groupKey: string, metric: MetricKey) => string;
    setCell: (groupKey: string, metric: MetricKey, raw: string) => void;
    weightValue: (drawId: string) => string;
    setWeight: (drawId: string, raw: string) => void;
    weightEdits: WeightEditMap;
    groupFlags: Map<string, GroupFlag>;
    weightFlags: Map<string, GroupFlag>;
    /** The row to point at after a commit, if it is in this day. */
    markedDrawId: string | null;
    /** Append ONE blank row inside this day — "adding a row inside an existing day". */
    onAddDraw: (date: string) => void;
    /** Blank rows the operator opened inside THIS day, rendered under its saved rows. */
    drafts: DraftDraw[];
    drawOptions: QcDrawOptions;
    onDraftChange: (id: string, patch: Partial<DraftDraw>) => void;
    onDraftRemove: (id: string) => void;
}

function DayBlock({
    date,
    rows,
    agg,
    rowOffset,
    markedDrawId,
    onAddDraw,
    drafts,
    drawOptions,
    onDraftChange,
    onDraftRemove,
    activeCell,
    isEditing,
    setActiveCell,
    setIsEditing,
    onStartEditing,
    onRevert,
    gridRef,
    cellValue,
    setCell,
    weightValue,
    setWeight,
    weightEdits,
    groupFlags,
    weightFlags,
}: DayBlockProps) {
    const logged = agg.sampledGroupCount;
    const allLogged = logged === agg.groupCount;

    return (
        <>
            {/* Day HEADER — identity only. The total moved to the bottom of the block. */}
            <tr>
                <td
                    colSpan={LABEL_SPAN}
                    className={cn(
                        DAY_HEADER_CELL,
                        'border-t border-border text-[10px] font-semibold uppercase tracking-wider text-muted-foreground',
                    )}
                >
                    <span className="flex items-center justify-between gap-2">
                        <span className="truncate">{formatDayHeading(date)}</span>
                        {/* The slip is one day's work, so the add starts from the day
                            you are reading — not from a form you have to date yourself.
                            It sits in the LEFT block, which is what is on screen at the
                            table's default horizontal scroll position. */}
                        <button
                            type="button"
                            onClick={() => onAddDraw(date)}
                            title={`Add a partner draw to ${formatDayHeading(date)}`}
                            className="inline-flex shrink-0 items-center gap-0.5 rounded px-1 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground transition-colors duration-150 hover:bg-muted hover:text-foreground"
                        >
                            <Plus className="h-2.5 w-2.5" />
                            Add
                        </button>
                    </span>
                </td>
                <td
                    colSpan={COLS.length - LABEL_SPAN}
                    className={cn(
                        DAY_HEADER_CELL,
                        'truncate border-t border-border text-right text-[10px]',
                        allLogged ? 'text-muted-foreground' : 'text-amber-600 dark:text-amber-400',
                    )}
                >
                    {agg.groupCount} sample{agg.groupCount === 1 ? '' : 's'} ·{' '}
                    {allLogged ? 'all logged' : `${agg.groupCount - logged} missing`}
                </td>
            </tr>

            {rows.map(({ group, draw, isLead }, rowIndex) => {
                const gridRow = rowOffset + rowIndex;
                const flag = groupFlags.get(group.key);
                return (
                    <tr
                        key={draw.id}
                        data-draw-id={draw.id}
                        className={cn(
                            'h-8 transition-all duration-150 hover:bg-muted/40',
                            // A static tint, never an entrance animation — these are
                            // table rows (CLAUDE.md). It clears itself after 8s.
                            markedDrawId === draw.id && 'bg-primary/10',
                        )}
                    >
                        <Cell>{formatShortDate(draw.recvDate)}</Cell>
                        <Cell muted>{draw.prodDate ? formatShortDate(draw.prodDate) : '—'}</Cell>
                        <Cell>{draw.shift ?? '—'}</Cell>
                        <Cell>{draw.grade ?? '—'}</Cell>
                        <Cell>{draw.plant ?? '—'}</Cell>
                        <Cell>{group.whse || '—'}</Cell>
                        <Cell muted>{draw.side ?? '—'}</Cell>
                        <Cell muted>{draw.flecCount == null ? '—' : draw.flecCount.toLocaleString('en-US')}</Cell>
                        <Cell>{group.src}</Cell>
                        <Cell>{draw.equip ?? '—'}</Cell>

                        {/* WT — nav column 0, live on EVERY row including the `〃`s. */}
                        <WeightCell
                            row={gridRow}
                            value={weightValue(draw.id)}
                            edited={weightEdits[draw.id] !== undefined}
                            flag={weightFlags.get(draw.id)}
                            activeCell={activeCell}
                            isEditing={isEditing}
                            setActiveCell={setActiveCell}
                            setIsEditing={setIsEditing}
                            onStartEditing={onStartEditing}
                            onRevert={onRevert}
                            gridRef={gridRef}
                            onChange={(raw) => setWeight(draw.id, raw)}
                        />

                        {METRICS.map((metric, metricIndex) =>
                            isLead ? (
                                <AnalysisCell
                                    key={metric}
                                    row={gridRow}
                                    col={metricIndex + 1}
                                    metric={metric}
                                    value={cellValue(group.key, metric)}
                                    flag={flag}
                                    activeCell={activeCell}
                                    isEditing={isEditing}
                                    setActiveCell={setActiveCell}
                                    setIsEditing={setIsEditing}
                                    onStartEditing={onStartEditing}
                                    onRevert={onRevert}
                                    gridRef={gridRef}
                                    onChange={(raw) => setCell(group.key, metric, raw)}
                                />
                            ) : (
                                <GhostCell key={metric} filled={cellValue(group.key, metric) !== ''} />
                            ),
                        )}
                    </tr>
                );
            })}

            {/* Rows opened INSIDE this day, under its saved rows and above the total —
                so a line that belongs to this date is transcribed where it belongs
                instead of at the bottom of the month. */}
            {drafts.map((draft) => (
                <DraftRow
                    key={draft.id}
                    draft={draft}
                    options={drawOptions}
                    metricCount={METRICS.length}
                    onChange={onDraftChange}
                    onRemove={onDraftRemove}
                />
            ))}

            {/* Day TOTAL — the sum line an accountant would rule off under the block. */}
            <tr className="h-8">
                <td colSpan={LABEL_SPAN} className={cn(DAY_TOTAL_CELL, 'px-2')}>
                    <span className="flex items-baseline justify-between gap-2">
                        <span className="text-[10px] font-bold uppercase tracking-widest">
                            Σ Day total
                        </span>
                        <CoverageHint agg={agg} />
                    </span>
                </td>
                <td
                    className={cn(
                        DAY_TOTAL_CELL,
                        'px-2 text-right font-mono text-[11px] font-bold tabular-nums',
                    )}
                >
                    {formatKg(agg.totalKg)}
                </td>
                {METRICS.map((metric) => (
                    <td
                        key={metric}
                        className={cn(
                            DAY_TOTAL_CELL,
                            'px-2 text-right font-mono text-[11px] font-bold tabular-nums',
                            agg.wtd[metric] == null && 'text-muted-foreground/60',
                        )}
                    >
                        {formatMetric(agg.wtd[metric], metric, true)}
                    </td>
                ))}
            </tr>
        </>
    );
}

/**
 * Never let a weighted average look like it covers weight it does not. When part of the
 * day's tonnage carries no sample, the total row says so inline.
 */
function CoverageHint({ agg }: { agg: QcAggregate }) {
    if (agg.coverage >= 1 || agg.totalKg <= 0) return null;
    return (
        <span className="truncate text-[9.5px] font-medium text-amber-600 dark:text-amber-400">
            wtd of {formatCoverage(agg.coverage)} sampled
        </span>
    );
}

// ─── Frozen month footer ─────────────────────────────────────────────────────────

/**
 * The month's rule-off, pinned to the bottom of the scrollport (`.frozen-row-bottom` +
 * `.frozen-edge-top`, the flecon "Current Balance" pattern). It sits ON TOP of
 * scrolling rows, so every cell is a SOLID `bg-muted` — never glass.
 */
function MonthFooter({ month, agg, dvoKg }: { month: string; agg: QcAggregate; dvoKg: number }) {
    return (
        <tfoot>
            <tr>
                <td colSpan={LABEL_SPAN} className={cn(MONTH_FOOTER_CELL, 'truncate')}>
                    <span className="block text-[11px] font-bold uppercase tracking-widest">
                        Σ {formatMonthHeading(month)}
                    </span>
                    <span className="block truncate text-[9.5px] font-medium leading-tight text-muted-foreground">
                        {agg.groupCount} sample group{agg.groupCount === 1 ? '' : 's'} ·{' '}
                        {formatCoverage(agg.coverage)} of the month&rsquo;s weight sampled
                        {dvoKg > 0 ? ` · incl. ${formatKg(dvoKg)} kg DVO` : ''}
                    </span>
                </td>
                <td className={cn(MONTH_FOOTER_CELL, 'text-right')}>
                    <span className="block font-mono text-[12px] font-bold tabular-nums">
                        {formatKg(agg.totalKg)}
                    </span>
                    <span className="block font-mono text-[9.5px] leading-tight text-muted-foreground">
                        kg
                    </span>
                </td>
                {METRICS.map((metric) => {
                    const partial = agg.totalKg > 0 && agg.wtdKg[metric] < agg.totalKg;
                    return (
                        <td key={metric} className={cn(MONTH_FOOTER_CELL, 'text-right')}>
                            <span
                                className={cn(
                                    'block font-mono text-[12px] font-bold tabular-nums',
                                    agg.wtd[metric] == null && 'text-muted-foreground/60',
                                )}
                            >
                                {formatMetric(agg.wtd[metric], metric, true)}
                            </span>
                            <span
                                className={cn(
                                    'block font-mono text-[9.5px] leading-tight',
                                    partial
                                        ? 'text-amber-600 dark:text-amber-400'
                                        : 'text-muted-foreground',
                                )}
                            >
                                {agg.wtd[metric] == null
                                    ? 'no samples'
                                    : `wtd · ${formatCoverage(agg.wtdKg[metric] / agg.totalKg)}`}
                            </span>
                        </td>
                    );
                })}
            </tr>
        </tfoot>
    );
}

// ─── Cells ───────────────────────────────────────────────────────────────────────

function Cell({
    children,
    numeric,
    muted,
}: {
    children: React.ReactNode;
    numeric?: boolean;
    muted?: boolean;
}) {
    return (
        <td
            className={cn(
                'truncate border border-border/60 px-2 py-1',
                numeric ? 'text-right font-mono tabular-nums' : 'font-mono',
                muted && 'text-muted-foreground',
            )}
        >
            {children}
        </td>
    );
}

interface WeightCellProps {
    row: number;
    value: string;
    /** True while an unsaved value is pending on this draw. */
    edited: boolean;
    flag?: GroupFlag;
    activeCell: CoordinateId | null;
    isEditing: boolean;
    setActiveCell: (cell: CoordinateId) => void;
    setIsEditing: (editing: boolean) => void;
    onStartEditing: (row: number, col: number, char?: string) => void;
    onRevert: () => void;
    gridRef: React.RefObject<HTMLDivElement | null>;
    onChange: (raw: string) => void;
}

/**
 * The editable WT cell — nav column 0, and the one place this ledger's group/sibling
 * asymmetry INVERTS.
 *
 * A lab reading covers a whole sample group, so it is typed once on the group's lead
 * row and the siblings render `〃`. A weight is the opposite: it is a property of ONE
 * physical draw, so every row's WT is independently editable and nothing ever carries
 * over. Visually that reads as: inside the tinted editable block, a sibling row's four
 * metric cells are inert `〃` while its WT is a live cell like any other.
 *
 * An unsaved value gets the primary tint plus a left rail, so a pending weight is
 * never mistaken for a stored one.
 */
function WeightCell({
    row,
    value,
    edited,
    flag,
    activeCell,
    isEditing,
    setActiveCell,
    setIsEditing,
    onStartEditing,
    onRevert,
    gridRef,
    onChange,
}: WeightCellProps) {
    return (
        <td
            className={cn(
                'h-8 border border-border/60 p-0',
                'bg-sky-500/5',
                edited && 'border-l-2 border-l-primary bg-primary/10',
                flag && 'bg-rose-500/10 ring-1 ring-inset ring-rose-500/40',
            )}
        >
            <GridCell
                row={row}
                col={0}
                value={value}
                activeCell={activeCell}
                isEditing={isEditing}
                setActiveCell={setActiveCell}
                setIsEditing={setIsEditing}
                onStartEditing={onStartEditing}
                onRevert={onRevert}
                gridRef={gridRef}
                tabIndex={-1}
                className="cursor-cell justify-end px-2 font-mono text-xs tabular-nums"
            >
                <EditInput
                    autoFocus
                    value={value}
                    onChange={onChange}
                    onCommit={() => setIsEditing(false)}
                    onEscape={onRevert}
                    align="right"
                    inputMode="decimal"
                    valueClass="text-xs"
                    placeholder="kg"
                />
            </GridCell>
        </td>
    );
}

interface AnalysisCellProps {
    row: number;
    col: number;
    metric: MetricKey;
    value: string;
    flag?: GroupFlag;
    activeCell: CoordinateId | null;
    isEditing: boolean;
    setActiveCell: (cell: CoordinateId) => void;
    setIsEditing: (editing: boolean) => void;
    onStartEditing: (row: number, col: number, char?: string) => void;
    onRevert: () => void;
    gridRef: React.RefObject<HTMLDivElement | null>;
    onChange: (raw: string) => void;
}

/**
 * An editable analysis cell. It lives on the FIRST draw of a sample group; the group's
 * other draws render `〃` and inherit whatever is typed here — the sheet's blank-cells-
 * mean-carry-forward habit, made explicit. One lab sample covers every draw from the
 * same source + warehouse on a day, so the fan-out is the data model, not a shortcut.
 *
 * Canonical Blackwood Table behavior via the shared `GridCell` + `EditInput`: a click
 * SELECTS (ring, no editor), a printable key types over, F2 or a double-click edits in
 * place, Escape reverts to the pre-edit snapshot.
 */
function AnalysisCell({
    row,
    col,
    metric,
    value,
    flag,
    activeCell,
    isEditing,
    setActiveCell,
    setIsEditing,
    onStartEditing,
    onRevert,
    gridRef,
    onChange,
}: AnalysisCellProps) {
    return (
        <td
            className={cn(
                'h-8 border border-border/60 p-0',
                value === '' ? 'bg-amber-500/10' : 'bg-sky-500/5',
                flag && 'bg-rose-500/10 ring-1 ring-inset ring-rose-500/40',
            )}
        >
            <GridCell
                row={row}
                col={col}
                value={value}
                activeCell={activeCell}
                isEditing={isEditing}
                setActiveCell={setActiveCell}
                setIsEditing={setIsEditing}
                onStartEditing={onStartEditing}
                onRevert={onRevert}
                gridRef={gridRef}
                tabIndex={-1}
                className="cursor-cell justify-end px-2 font-mono text-xs tabular-nums"
                displayValue={
                    value === '' ? (
                        <span className="text-amber-600/70 dark:text-amber-400/70">—</span>
                    ) : (
                        value
                    )
                }
            >
                <EditInput
                    autoFocus
                    value={value}
                    onChange={onChange}
                    onCommit={() => setIsEditing(false)}
                    onEscape={onRevert}
                    align="right"
                    inputMode="decimal"
                    valueClass="text-xs"
                    placeholder={METRIC_LABEL[metric]}
                />
            </GridCell>
        </td>
    );
}

/** A sibling draw's inherited value. */
function GhostCell({ filled }: { filled: boolean }) {
    return (
        <td
            className={cn(
                'border border-border/60 px-2 py-1 text-right font-mono text-xs',
                filled ? 'bg-sky-500/5 text-muted-foreground/70' : 'bg-amber-500/10 text-amber-600/70',
            )}
            title={filled ? 'Inherited from this sample group’s first row' : 'No value yet'}
        >
            {filled ? '〃' : '—'}
        </td>
    );
}
