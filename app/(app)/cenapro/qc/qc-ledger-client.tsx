'use client';

import * as React from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Check, Copy, Loader2, RotateCw } from 'lucide-react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { GridCell, EditInput } from '@/components/shared/grid';
import { useGridEditSession } from '@/lib/hooks/use-grid-edit-session';
import {
    createCoordinateNavResolver,
    useGridKeyboardNav,
    type CoordinateId,
} from '@/lib/hooks/use-grid-keyboard-nav';
import { errorToast } from '@/lib/toast';
import { cn } from '@/lib/utils';

import { METRICS, METRIC_LABEL, type MetricKey } from '@/lib/cenapro/ccc-analysis';
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
import { saveQcSamples, type SaveQcSampleInput, type SaveQcSampleResult } from './actions';
import type { QcGroup, QcLedgerDay } from './data';

interface QcLedgerClientProps {
    month: string;
    days: QcLedgerDay[];
    /** The month's `scope='all'` rollup, straight from SQL. */
    monthAgg: QcAggregate;
    /** Every `YYYY-MM` present in the data, ascending — feeds the Month/Year picker. */
    monthKeys: string[];
    previousWtd: MetricValues | null;
    previousLabel: string | null;
}

/** Per-group, per-metric unsaved edits, held as the raw text the operator typed. */
type EditMap = Record<string, Partial<Record<MetricKey, string>>>;

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

const COLS: LedgerCol[] = [
    { key: 'date', width: 62, label: 'Date', title: 'Receipt date at CCC' },
    { key: 'prod', width: 62, label: 'Prod', title: 'Production date of the material drawn' },
    { key: 'shift', width: 40, label: 'Sh', title: 'Shift' },
    { key: 'grade', width: 62, label: 'Grade' },
    { key: 'plant', width: 60, label: 'Plant' },
    { key: 'whse', width: 62, label: 'Whse', title: 'Warehouse (or plant, when unplaced)' },
    { key: 'src', width: 62, label: 'SRC', title: 'Source location' },
    { key: 'wt', width: 88, label: 'WT kg', title: 'Weight (kg)', numeric: true },
    { key: 'bd', width: 124, label: 'BD', numeric: true },
    { key: 'ash', width: 124, label: 'ASH', numeric: true },
    { key: 'grit', width: 124, label: 'GRIT', numeric: true },
    { key: 'mc', width: 124, label: 'MC', numeric: true },
];

const MIN_WIDTH = COLS.reduce((sum, c) => sum + c.width, 0);
/** Date → SRC. The day-header / day-total rows rule off across these seven. */
const LABEL_SPAN = 7;
/** Visual column index of the first analysis column (BD). */
const FIRST_METRIC_COL = COLS.length - METRICS.length;

/** The nav coordinate space is the FOUR analysis columns only — every one is typable. */
const METRIC_COLUMN_MAP: readonly (string | null)[] = METRICS;

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
}: QcLedgerClientProps) {
    const router = useRouter();
    const [edits, setEdits] = React.useState<EditMap>({});
    const [sourceFilter, setSourceFilter] = React.useState<string>('ALL');
    const [saving, setSaving] = React.useState(false);
    const [failures, setFailures] = React.useState<SaveFailure[]>([]);
    const gridRef = React.useRef<HTMLDivElement>(null);

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
                if (after === group.sample) continue;
                adjustments.push({ kg: group.totalKg, before: group.sample, after });
            }

            return {
                date: day.date,
                groups: visible,
                agg: adjustAggregate(day.agg, adjustments),
                adjustments,
            };
        });
    }, [days, sourceFilter, edits]);

    const visibleDays = React.useMemo(
        () => dayViews.filter((day) => day.groups.length > 0),
        [dayViews],
    );

    /**
     * Every entry row on screen, flattened in visual order. This array IS the keyboard
     * grid's row axis: index `n` here is `activeCell.row === n`. Day headers, `〃`
     * sibling rows, `Σ DAY TOTAL` rows and the frozen month footer are absent from it
     * by construction, which is exactly why Tab and the arrows can never land on one.
     */
    const entryGroups = React.useMemo(
        () => visibleDays.flatMap((day) => day.groups),
        [visibleDays],
    );

    /** Row index of each day's FIRST entry row, so a day block can address its cells. */
    const dayRowOffsets = React.useMemo(() => {
        const offsets: number[] = [];
        let cursor = 0;
        for (const day of visibleDays) {
            offsets.push(cursor);
            cursor += day.groups.length;
        }
        return offsets;
    }, [visibleDays]);

    /** The month rollup as it would read with every pending change applied. */
    const liveMonthAgg = React.useMemo(
        () => adjustAggregate(monthAgg, dayViews.flatMap((day) => day.adjustments)),
        [monthAgg, dayViews],
    );

    const dvoKg = React.useMemo(() => {
        if (sourceFilter === 'ALL') return monthAgg.dvoKg;
        return entryGroups.reduce((sum, group) => (group.isDvo ? sum + group.totalKg : sum), 0);
    }, [sourceFilter, monthAgg.dvoKg, entryGroups]);

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

    // ── Keyboard grid (the shared Blackwood Table state machine) ──────────────────
    //
    // `useGridKeyboardNav` + `createCoordinateNavResolver` — the SAME pair RC IN's bulk
    // grid and the production schedule run on, so the muscle memory transfers. The
    // coordinate space is deliberately just `entryGroups.length × 4`: Tab off the last
    // metric of a row wraps to the next row's BD, Shift+Tab off BD wraps back to the
    // previous row's MC, and neither can reach a summary row because summary rows have
    // no coordinates at all.

    const [activeCell, setActiveCell] = React.useState<CoordinateId | null>(null);

    // A source-filter change or a month change re-lengthens the row axis under us; an
    // active cell past the new end would address a row that no longer exists.
    React.useEffect(() => {
        setActiveCell((current) => (current && current.row >= entryGroups.length ? null : current));
    }, [entryGroups.length]);

    const groupKeyAt = React.useCallback(
        (row: number): string | null => entryGroups[row]?.key ?? null,
        [entryGroups],
    );

    const editSession = useGridEditSession<CoordinateId>({
        getValue: (id) => {
            const key = groupKeyAt(id.row);
            return key ? cellValueByKey(key, METRICS[id.col]) : '';
        },
        setValue: (id, value) => {
            const key = groupKeyAt(id.row);
            if (key) setCell(key, METRICS[id.col], value);
        },
    });

    /** Put the moved-to cell on screen and hand the keyboard back to the scrollport. */
    const focusCell = React.useCallback((id: CoordinateId) => {
        const root = gridRef.current;
        if (!root) return;
        root
            .querySelector<HTMLElement>(`[data-row="${id.row}"][data-col="${id.col}"]`)
            ?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
        root.focus();
    }, []);

    const startEditing = React.useCallback(
        (row: number, col: number, initialChar?: string) => {
            if (!groupKeyAt(row)) return;
            setActiveCell({ row, col });
            editSession.startEditing({ row, col }, initialChar);
        },
        [groupKeyAt, editSession],
    );

    const revertCellEdit = React.useCallback(() => {
        editSession.revertChanges();
        gridRef.current?.focus();
    }, [editSession]);

    const setIsEditing = React.useCallback(
        (editing: boolean) => {
            if (!editing) editSession.commit();
        },
        [editSession],
    );

    const resolver = React.useMemo(
        () =>
            createCoordinateNavResolver({
                rowCount: entryGroups.length,
                columnMap: METRIC_COLUMN_MAP,
            }),
        [entryGroups.length],
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
                gridRef.current?.focus();
            },
        },
        onAfterMove: focusCell,
        // The RC IN convention: the first Tab of a run remembers the lane you started
        // in, and a later plain Enter drops one row and RETURNS to it. Filling BD → ASH
        // → GRIT → MC → Enter puts you back on the next row's BD, not its MC.
        enableEnterAnchor: true,
    });

    // ── Save ──────────────────────────────────────────────────────────────────────

    const dirtyKeys = React.useMemo(() => Object.keys(edits), [edits]);

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
        for (const failure of failures) map.set(failure.key, 'conflict');
        for (const key of emptiedKeys) map.set(key, 'blocked');
        return map;
    }, [failures, emptiedKeys]);

    const discard = React.useCallback(() => {
        setEdits({});
        setFailures([]);
    }, []);

    const save = React.useCallback(async () => {
        if (dirtyKeys.length === 0 || saving) return;

        if (emptiedKeys.length > 0) {
            setFailures(
                emptiedKeys.map((key) => ({
                    key,
                    label: describeGroup(groupByKey.get(key)),
                    outcome: 'no_metrics' as const,
                    message:
                        'Every metric was cleared. A sample must keep at least one of BD / ASH / GRIT / MC — re-enter a value, or press Esc to restore what was stored.',
                })),
            );
            return;
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

        setSaving(true);
        setFailures([]);
        try {
            const { results, savedCount } = await saveQcSamples(payloads);

            const succeeded = new Set(results.filter((r) => r.ok).map((r) => r.key));
            if (succeeded.size > 0) {
                // Only the groups that actually landed lose their pending text; a
                // conflicted group keeps what was typed so nothing has to be retyped.
                setEdits((prev) => {
                    const next = { ...prev };
                    for (const key of succeeded) delete next[key];
                    return next;
                });
                toast.success(
                    `Saved ${savedCount} sample group${savedCount === 1 ? '' : 's'}`,
                    { duration: 2500 },
                );
                router.refresh();
            }

            const failed = results.filter((r) => !r.ok);
            if (failed.length > 0) {
                const rows = failed.map((result) => toFailure(result, groupByKey.get(result.key)));
                setFailures(rows);
                errorToast(
                    `${failed.length} sample group${failed.length === 1 ? '' : 's'} could not be saved`,
                    { description: rows.map((row) => `${row.label} — ${row.message}`).join('\n') },
                );
            }
        } catch (cause) {
            errorToast('Saving the QC samples failed', {
                description: cause instanceof Error ? cause.message : String(cause),
            });
        } finally {
            setSaving(false);
        }
    }, [dirtyKeys, saving, emptiedKeys, groupByKey, edits, router]);

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
                        className="min-h-0 flex-1 overflow-auto rounded-lg border border-border outline-none focus-visible:ring-1 focus-visible:ring-ring"
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
                                                // just wider: the four analysis headers
                                                // read as foreground, the reference
                                                // columns stay muted.
                                                index >= FIRST_METRIC_COL && 'text-foreground',
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
                                        </td>
                                    </tr>
                                ) : null}

                                {visibleDays.map((day, dayIndex) => (
                                    <DayBlock
                                        key={day.date}
                                        date={day.date}
                                        groups={day.groups}
                                        agg={day.agg}
                                        rowOffset={dayRowOffsets[dayIndex]}
                                        activeCell={activeCell}
                                        isEditing={editSession.isEditing}
                                        setActiveCell={setActiveCell}
                                        setIsEditing={setIsEditing}
                                        onStartEditing={startEditing}
                                        onRevert={revertCellEdit}
                                        gridRef={gridRef}
                                        cellValue={cellValueByKey}
                                        setCell={setCell}
                                        groupFlags={groupFlags}
                                    />
                                ))}
                            </tbody>

                            {visibleDays.length > 0 ? (
                                <MonthFooter month={month} agg={liveMonthAgg} dvoKg={dvoKg} />
                            ) : null}
                        </table>
                    </div>
                </div>
            </div>

            {/* ── Save bar ────────────────────────────────────────────────────────── */}
            <div className="shrink-0 border-t border-border bg-background/95 px-3 py-2 backdrop-blur supports-backdrop-filter:bg-background/60">
                <div className="flex flex-wrap items-center gap-2">
                    <Button
                        size="sm"
                        className="h-7 text-xs"
                        disabled={dirtyKeys.length === 0 || saving}
                        onClick={() => void save()}
                    >
                        {saving ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : null}
                        {dirtyKeys.length === 0
                            ? 'Save'
                            : `Save ${dirtyKeys.length} sample group${dirtyKeys.length === 1 ? '' : 's'}`}
                    </Button>
                    {dirtyKeys.length > 0 ? (
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
                    <span
                        className={cn(
                            'text-[11px]',
                            emptiedKeys.length > 0
                                ? 'text-amber-600 dark:text-amber-400'
                                : 'text-muted-foreground',
                        )}
                    >
                        {emptiedKeys.length > 0
                            ? `${emptiedKeys.length} group${emptiedKeys.length === 1 ? ' has' : 's have'} every metric cleared — that would delete the reading`
                            : dirtyKeys.length === 0
                              ? 'No unsaved changes'
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

// ─── Save failures ───────────────────────────────────────────────────────────────

interface SaveFailure {
    key: string;
    label: string;
    outcome: SaveQcSampleResult['outcome'];
    message: string;
}

/**
 * Turn one RPC verdict into something an operator can act on. Every outcome gets its
 * own sentence — a conflict is NOT retried, force-written, or papered over.
 */
function toFailure(result: SaveQcSampleResult, group: QcGroup | undefined): SaveFailure {
    const label = describeGroup(group);
    switch (result.outcome) {
        case 'version_conflict':
            return {
                key: result.key,
                label,
                outcome: result.outcome,
                message:
                    'Someone else changed this sample while you were editing. Reload to see their values.',
            };
        case 'already_exists':
            return {
                key: result.key,
                label,
                outcome: result.outcome,
                message:
                    'A sample was logged for this group while you were typing. Reload, then edit the value that is now stored.',
            };
        case 'not_found':
            return {
                key: result.key,
                label,
                outcome: result.outcome,
                message: 'That sample was deleted while you were editing. Reload the ledger.',
            };
        case 'no_metrics':
            return {
                key: result.key,
                label,
                outcome: result.outcome,
                message:
                    'Every metric was cleared. A sample must keep at least one of BD / ASH / GRIT / MC — re-enter a value, or press Esc to restore what was stored.',
            };
        case 'invalid_key':
            return {
                key: result.key,
                label,
                outcome: result.outcome,
                message:
                    result.message ?? 'The date / source / warehouse key was incomplete. Reload the ledger.',
            };
        default:
            return {
                key: result.key,
                label,
                outcome: result.outcome,
                message: result.message ?? 'The save failed for an unknown reason.',
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
    const reloadable = failures.some((failure) => failure.outcome !== 'no_metrics');

    return (
        <div
            role="alert"
            className="mb-3 shrink-0 animate-fade-up rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2"
        >
            <div className="flex items-start gap-2">
                <div className="min-w-0 flex-1">
                    <p className="text-xs font-semibold text-destructive">
                        {failures.length} sample group{failures.length === 1 ? '' : 's'} not saved
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
    groups: QcGroup[];
    agg: QcAggregate;
    /** Grid row index of this day's FIRST sample group. */
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
    groupFlags: Map<string, GroupFlag>;
}

function DayBlock({
    date,
    groups,
    agg,
    rowOffset,
    activeCell,
    isEditing,
    setActiveCell,
    setIsEditing,
    onStartEditing,
    onRevert,
    gridRef,
    cellValue,
    setCell,
    groupFlags,
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
                        'truncate border-t border-border text-[10px] font-semibold uppercase tracking-wider text-muted-foreground',
                    )}
                >
                    {formatDayHeading(date)}
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

            {groups.map((group, groupIndex) => {
                const gridRow = rowOffset + groupIndex;
                const flag = groupFlags.get(group.key);
                return group.draws.map((draw, drawIndex) => {
                    const isLead = drawIndex === 0;
                    return (
                        <tr key={draw.id} className="h-8 transition-all duration-150 hover:bg-muted/40">
                            <Cell>{formatShortDate(draw.recvDate)}</Cell>
                            <Cell muted>{draw.prodDate ? formatShortDate(draw.prodDate) : '—'}</Cell>
                            <Cell>{draw.shift ?? '—'}</Cell>
                            <Cell>{draw.grade ?? '—'}</Cell>
                            <Cell>{draw.plant ?? '—'}</Cell>
                            <Cell>{group.whse || '—'}</Cell>
                            <Cell>{group.src}</Cell>
                            <Cell numeric>{formatKg(draw.weightKg)}</Cell>

                            {METRICS.map((metric, metricIndex) =>
                                isLead ? (
                                    <AnalysisCell
                                        key={metric}
                                        row={gridRow}
                                        col={metricIndex}
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
                });
            })}

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
