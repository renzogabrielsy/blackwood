'use client';

import * as React from 'react';
import { useRouter, usePathname, useSearchParams } from 'next/navigation';
import {
    TableVirtuoso,
    type ItemProps,
    type TableComponents,
    type TableProps,
    type TableVirtuosoHandle,
} from 'react-virtuoso';
import {
    AlertTriangle,
    Check,
    Copy,
    CornerDownRight,
    Crosshair,
    Droplets,
    Infinity as InfinityIcon,
    Inbox,
    ListFilter,
    Loader2,
    Plus,
    Save,
    Search,
    Trash2,
    Undo2,
    X,
} from 'lucide-react';
import { format, isValid, parseISO } from 'date-fns';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import {
    AlertDialog,
    AlertDialogAction,
    AlertDialogCancel,
    AlertDialogContent,
    AlertDialogDescription,
    AlertDialogFooter,
    AlertDialogHeader,
    AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { EditInput, GridContextMenu, type GridMenuItem } from '@/components/shared/grid';
import { useGridContextMenu } from '@/lib/hooks/use-grid-context-menu';
import { useGridEditSession } from '@/lib/hooks/use-grid-edit-session';
import { useGridPaste } from '@/lib/hooks/use-grid-paste';
import {
    useGridKeyboardNav,
    type CoordinateId,
    type GridRangeSlot,
    type NavResolver,
} from '@/lib/hooks/use-grid-keyboard-nav';
import { useCellSelection } from '@/lib/hooks/use-cell-selection';
import { useCellAggregation, type AggregationType } from '@/lib/hooks/use-cell-aggregation';
import { useClipboardCopy } from '@/lib/hooks/use-clipboard-copy';
import { useStatusBar } from '@/components/providers/status-bar-context';
import { errorToast } from '@/lib/toast';
import { trimCellValue } from '@/lib/paste-utils';
import { cn } from '@/lib/utils';
import { parsePriceInput, parseWeightInput } from '@/lib/cenapro/rc-formula';

import { deleteDelivery, saveDeliveries, type DeliveryAnchor } from './actions';
import {
    buildColumns,
    clampDraftAdd,
    columnCalcType,
    countUnsavedWork,
    describeUnsavedWork,
    dragAutoScrollDelta,
    duplicateBadge,
    FILTER_COLUMNS,
    formatDestinationCell,
    formatInt,
    formatKg,
    formatLab,
    formatPeso,
    formatRate,
    formatSupplierCell,
    frozenBlockWidth,
    frozenOffsets,
    columnScrollLeft,
    isDirtyFieldEdits,
    isFilterableColumn,
    isIsoDate,
    isSelectableColumn,
    labDecimals,
    mergeFieldEdit,
    minTableWidth,
    num,
    parseDeliveryDate,
    parseDestinationCell,
    parseSupplierCell,
    priceEditText,
    readImportFlags,
    rowIssues,
    sampleFieldFor,
    summarySpans,
    weightEditText,
    DEFAULT_DRAFT_ROWS,
    ROW_H,
    SAMPLE_ROW_H,
    type DeliveryCol,
    type DeliveryDimensions,
    type DeliveryField,
    type DeliveryPatch,
    type DeliveryRecord,
    type DuplicateBadge,
    type FieldEdits,
    type RcDeliverySampleRow,
    type SamplePayload,
    type SaveDeliveryInput,
} from './types';
import {
    activeFilterCount,
    axesKey,
    dateFilterMissesPeriod,
    describeFilter,
    filteredColumnKeys,
    filterParamName,
    filtersKey,
    hasActiveLens,
    ISSUE_HINTS,
    ISSUE_LABELS,
    ISSUE_LENSES,
    periodBounds,
    periodKey,
    periodLabel,
    parseColumnFilters,
    parseIssueLens,
    parsePeriodKey,
    parseQuery,
    parseScope,
    resolvePeriod,
    serializeColumnFilter,
    type ColumnFilter,
    type ColumnFilters,
    type DeliveryPeriod,
    type IssueLens,
    type Scope,
} from './ledger-url';
import { useDeliveriesWindow, type InitialDeliveryPage } from './use-deliveries-window';

// ═════════════════════════════════════════════════════════════════════════════════
// RC Deliveries ledger — the operators' "RC 2026" sheet as a live grid.
//
// ── Why this file owns BOTH scopes ───────────────────────────────────────────────
// Endless (virtualized, cursor-paged) and Focus (one month, day-grouped, footed) draw
// the SAME seventeen columns with the SAME cell behaviour and the SAME keyboard model.
// Only the container differs — a `TableVirtuoso` versus a plain `<table>`. Splitting
// them into two components would mean threading forty props through a shared renderer
// and would guarantee the two drift; keeping them as two containers over one set of
// closures is what keeps "Tab does the same thing here as it does there" true by
// construction.
//
// ── The keyboard coordinate space, and why it needs its own resolver ─────────────
// A receipt's moisture draws render as indented CHILD rows directly beneath it, and a
// draw is not a small receipt — it has no date, no truck, no weight, no warehouse, no
// price. It has a label and up to seven lab readings. So the two row families disagree
// about which columns they occupy:
//
//     delivery row   DATE · TRK# · SUPPLIER · SKS · WT · BD…FC · WAREHOUSE · REMARKS · PHP/KG
//     sample row              (label in the SUPPLIER lane) ·  BD…FC
//
// `createCoordinateNavResolver`'s `columnMap` is per-COLUMN, which cannot express that.
// So this grid carries its own resolver — the same answer, and for the same reason, as
// the QC ledger's. Every branch below asks one question: "is there an ADDRESSABLE cell
// that way?", and returns null (stay put) when there is not, so the selection can never
// come to rest on a cell that does not exist.
//
// ── Two columns hold arithmetic, not numbers ─────────────────────────────────────
// WT and PHP/KG show the FORMULA on focus (`=27045*88%`) and the computed value on
// blur. The engine is `lib/cenapro/rc-formula.ts`; the round-trip is `weightEditText` /
// `priceEditText` in `./types.ts`. An imported row with no stored formula gets its
// formula REBUILT from the stored parts, so it is indistinguishable from one typed this
// morning. A parse failure persists a toast and leaves the cell dirty — it never writes
// a silent zero.
//
// ── TTL PRICE is not a column this file computes ─────────────────────────────────
// It is a STORED GENERATED column (`net × ₱/kg`, exact decimal). It renders, it never
// edits, and while a row's WT or PHP/KG is dirty it renders the STALE stored figure in
// a muted "pending" state rather than a browser-computed guess. Reproducing the DB's
// arithmetic in floating-point JavaScript is precisely how a payment ledger goes wrong.
// ═════════════════════════════════════════════════════════════════════════════════

// ─── Row model ───────────────────────────────────────────────────────────────────

/** A row the keyboard can address. Non-addressable chrome is absent by construction. */
type NavRow =
    | { kind: 'delivery'; deliveryId: string }
    | { kind: 'sample'; deliveryId: string; sampleIndex: number }
    | { kind: 'draft'; draftId: string };

type LedgerItem =
    | { kind: 'day'; key: string; label: string; count: number }
    | { kind: 'delivery'; key: string; navRow: number; rec: DeliveryRecord; num: number }
    | { kind: 'sample'; key: string; navRow: number; deliveryId: string; sampleIndex: number }
    | { kind: 'day-total'; key: string; netKg: number; php: number | null; dupNetKg: number; dupPhp: number }
    | { kind: 'draft'; key: string; navRow: number; draftId: string }
    | { kind: 'add-rows'; key: string };

/**
 * A URL axis change waiting on the operator's answer to the unsaved-work prompt.
 * The href is resolved when the control is clicked, never replayed from a closure
 * afterwards, so what lands is exactly what was asked for.
 */
interface PendingAxisChange {
    href: string;
    /** Local control state to sync only if the change actually lands. */
    onApplied?: () => void;
    /** Local control state to put back if it does not. */
    onCancelled?: () => void;
}

/** One sub-sample while it is being edited. `id` is null for a draw added in the app. */
interface SampleDraft {
    key: string;
    label: string;
    bd: string;
    moisture_pct: string;
    grit: string;
    ash: string;
    dust: string;
    vm: string;
    fc: string;
}

// ─── Summary-row treatments ──────────────────────────────────────────────────────
//
// A day total is a SUM LINE, not another entry: the accountant's rule-off — heavy top
// border, an OPAQUE `bg-muted` band matched to the frozen surfaces so every summary row
// reads as one family, semibold tabular figures, and a literal `Σ DAY TOTAL` label.
const DAY_TOTAL_CELL =
    'border-b border-border/60 border-t-2 border-t-foreground/45 bg-muted py-1 align-middle text-foreground';
/** Deliberately a much FAINTER band — a filled grey band here means "this is a sum". */
const DAY_HEADER_CELL = 'h-6 border-b border-border/40 bg-muted/25 px-2 py-1';
/** Sticky-bottom month footer. OPAQUE `bg-muted` + `.frozen-edge-top` — never glass. */
const MONTH_FOOTER_CELL = 'frozen-row-bottom frozen-edge-top bg-muted px-2 py-1 align-middle';

const dash = <span className="text-muted-foreground/40">—</span>;

// ─── Cell geometry ───────────────────────────────────────────────────────────────
//
// The interactive layer of a cell is ABSOLUTELY POSITIONED over the whole `<td>` box,
// and that is load-bearing rather than stylistic. It used to be `h-full`, which in a
// table cell resolves against a height the browser has not committed to yet — so the
// div collapsed to the height of its TEXT. Two consequences, both of which the operator
// hit on day one:
//
//   • the active ring (`ring-inset`) traced the text box rather than the cell, so a
//     selected cell looked like a floating rectangle sitting inside its own borders;
//   • an EMPTY cell's div had zero height and therefore NO HIT AREA AT ALL — which is
//     exactly why an empty REMARKS cell could not be clicked, let alone edited.
//
// `absolute inset-0` inside a `relative`/`sticky` `<td>` is unconditional: it fills the
// cell box for every row family (32px receipts, 26px draws) whether the cell holds text
// or nothing. The `<td>` also carries an explicit height so the row never depends on its
// content for size once the content stops contributing to it.
const CELL_BASE =
    'absolute inset-0 flex items-center px-2 outline-none cursor-default select-none';

// ─── The horizontal cell rule — WHY IT LIVES ON THE `<td>` AND NOT THE `<tr>` ────
//
// Both tables are `border-collapse: separate` (load-bearing: under `collapse` a border
// belongs to the TABLE rather than the cell, so a `position: sticky` frozen column's
// borders scroll away and the pinned block loses its edges — a far worse bug than a
// missing line). **In the separated-borders model the CSS spec paints borders on table
// CELLS ONLY**: a border declared on `<tr>`, `<tbody>`, `<col>` or `<colgroup>` is
// ignored outright.
//
// So the `border-b` that used to sit on `rowClassFor`'s `<tr>` never rendered, and the
// sheet read as columns with no rows — which is not what an operator coming from Excel
// expects to see. The weight now rides on the `<td>`, keyed off the SAME
// `navRows[navRow].kind` lookup that already decides the row's height, so the two can
// never disagree about which family a row belongs to.
//
// It is deliberately ONE table in ONE place. Do NOT re-add a `border-b` to the row —
// it would be silently inert and would read as if the weight lived in two places.
// Row heights are unaffected: Tailwind's preflight makes every cell `border-box`, so
// the 1px rule is drawn INSIDE the explicit 32px / 26px cell height.
// Note the SIDE-SPECIFIC colour (`border-b-border/…`, never `border-border/…`). The
// cell already sets its vertical rule with `border-r`; an all-sides colour utility here
// would be in the same tailwind-merge group and would silently restyle that vertical
// line to the row family's weight as well.
const ROW_RULE: Record<NavRow['kind'], string> = {
    /** A receipt — the sheet's primary row. Matches the vertical rule's weight. */
    delivery: 'border-b border-b-border/30',
    /** A moisture draw. Lighter, because it is a CHILD of the receipt above it. */
    sample: 'border-b border-b-border/20',
    /** A blank row waiting to be typed into. Same quiet weight as a draw. */
    draft: 'border-b border-b-border/20',
};

/** Range-selection tint — the platform's, matched to the other Blackwood grids. */
const SELECT_TINT = 'bg-primary/10 dark:bg-primary/20';
/** A cell holding unsaved text. */
const DIRTY_TINT = 'bg-amber-500/[0.12]';

// ─── Data-quality rails ──────────────────────────────────────────────────────────
//
// Three consecutive days were pasted twice — ₱17,185,939 across 22 receipts — and those
// 22 must be unmistakable, because they inflate every total on the page. The rail is
// drawn on the FIRST frozen cell (an inset left border, so it survives horizontal
// scrolling) and repeated as a badge on the supplier cell.
//
// `twin` is the quieter fourth state and it is a DIFFERENT FACT from `duplicate`. The
// importer flagged only the SECOND copy of each pasted receipt, so the 22 ORIGINALS
// carry no flag at all — yet they are half of every pair and a human deciding what to
// drop has to see them. They get:
//
//   • a rail at 40% of the accused row's rose and 2px instead of 3px (`color-mix` to
//     transparent rather than a lighter rose, so one class works in both themes);
//   • NO row wash — the wash is the accusation, and an original is not accused;
//   • an OUTLINE `TWIN n/N` badge rather than the filled `DUP n/N`.
//
// Present but not indicted, which is exactly the row's real status.
function railClass(kind: 'duplicate' | 'twin' | 'unmapped' | 'flagged' | 'none'): string {
    if (kind === 'duplicate') return 'shadow-[inset_3px_0_0_0_var(--color-rose-500)]';
    if (kind === 'twin') return 'shadow-[inset_2px_0_0_0_color-mix(in_oklab,var(--color-rose-500)_40%,transparent)]';
    if (kind === 'unmapped') return 'shadow-[inset_3px_0_0_0_var(--color-amber-500)]';
    if (kind === 'flagged') return 'shadow-[inset_3px_0_0_0_var(--color-sky-500)]';
    return '';
}

const BADGE =
    'inline-flex items-center rounded-sm px-1 py-0 text-[9px] font-bold uppercase leading-[14px] tracking-wide';

// ─── Props ───────────────────────────────────────────────────────────────────────

export interface DeliveriesLedgerProps {
    scope: Scope;
    /** Endless only — the server-prefetched first window. */
    initialPage: InitialDeliveryPage | null;
    /** Focus only — the whole month, already ordered. */
    monthRecords: DeliveryRecord[] | null;
    anchor: DeliveryAnchor;
    period: DeliveryPeriod | null;
    monthKeys: string[];
    issue: IssueLens | null;
    query: string;
    /** Per-column filters, parsed from `?f_<column>=…` and already applied in SQL. */
    filters: ColumnFilters;
    dimensions: DeliveryDimensions;
    /** Derived SERVER-SIDE from `canViewPrices()`; the ₱ fields are already nulled. */
    canViewPrices: boolean;
    loadError: string | null;
}

export function DeliveriesLedger(props: DeliveriesLedgerProps) {
    const {
        scope,
        initialPage,
        monthRecords,
        anchor,
        period,
        monthKeys,
        issue,
        query,
        filters,
        dimensions,
        canViewPrices,
        loadError,
    } = props;

    const router = useRouter();
    const pathname = usePathname();
    const searchParams = useSearchParams();
    const [isPending, startTransition] = React.useTransition();
    const { setCellSelectionCount, setCellAggregates } = useStatusBar();

    const gridRef = React.useRef<HTMLDivElement>(null);
    const scrollerRef = React.useRef<HTMLDivElement>(null);
    const virtuosoRef = React.useRef<TableVirtuosoHandle>(null);
    // The endless scope's scroll container is virtuoso's own div, which virtuoso owns the
    // ref to — so it is handed back here through `LedgerCtx` (see `LedgerScroller`). The
    // horizontal caret-follow needs a real element in BOTH scopes, and reaching for
    // virtuoso's private `[data-virtuoso-scroller]` attribute would be a silent break on
    // the next version bump.
    const virtuosoScrollerRef = React.useRef<HTMLDivElement | null>(null);
    const captureScroller = React.useCallback((el: HTMLDivElement | null) => {
        virtuosoScrollerRef.current = el;
    }, []);

    // ── Columns + geometry ───────────────────────────────────────────────────────
    // The ₱ columns are ABSENT (not blanked) for a gated viewer, so the coordinate
    // space has no unreachable holes and the table's min-width stays honest.
    const cols = React.useMemo(() => buildColumns(canViewPrices), [canViewPrices]);
    const frozenLeft = React.useMemo(() => frozenOffsets(cols), [cols]);
    const frozenCount = frozenLeft.length;
    const minWidth = React.useMemo(() => minTableWidth(cols), [cols]);
    const lastCol = cols.length - 1;

    const supplierCodes = React.useMemo(
        () => dimensions.suppliers.map((s) => s.code ?? '').filter(Boolean),
        [dimensions.suppliers],
    );
    const destinationCodes = React.useMemo(
        () => dimensions.destinations.map((d) => d.code ?? '').filter(Boolean),
        [dimensions.destinations],
    );

    // ── The record window ────────────────────────────────────────────────────────
    // The lens bundle is memoised on its SERIALISED identity, not the object's, because
    // `filters` arrives as a fresh object on every server render.
    const lens = React.useMemo(
        () => ({ issue, query, filters }),
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [issue, query, filtersKey(filters)],
    );
    const win = useDeliveriesWindow(
        initialPage ?? { records: [], hasOlder: false, hasNewer: false, totalCount: null },
        lens,
    );
    // Wrapped so the flatten/index memos below have a stable dependency — a bare
    // conditional would hand them a fresh array identity on every render.
    const records = React.useMemo(
        () => (scope === 'endless' ? win.records : (monthRecords ?? [])),
        [scope, win.records, monthRecords],
    );

    const recordsById = React.useMemo(() => {
        const m = new Map<string, DeliveryRecord>();
        for (const r of records) m.set(r.row.id ?? '', r);
        return m;
    }, [records]);

    // ── Unsaved work ─────────────────────────────────────────────────────────────
    const [edits, setEdits] = React.useState<Record<string, FieldEdits>>({});
    const [sampleDrafts, setSampleDrafts] = React.useState<Record<string, SampleDraft[]>>({});
    // Keyed by `<rowKey>:<field>` — a STABLE key, not the row's index. The row axis moves
    // under the selection (a page loads, a lens changes, blank rows appear at the bottom),
    // and a positional key would silently re-point a "this cell is invalid" mark at some
    // other operator's cell.
    const [invalidCells, setInvalidCells] = React.useState<Set<string>>(new Set());
    const [saving, setSaving] = React.useState(false);
    const [deleteTarget, setDeleteTarget] = React.useState<DeliveryRecord | null>(null);

    // ── Draft receipts (the blank rows at the bottom) ─────────────────────────────
    //
    // Rendered only where a blank row means something: never under a data-quality lens
    // or a search (those views are a CUT of history, and a new receipt does not belong at
    // the end of a cut), and in the endless scope only when the window really is at the
    // newest end — otherwise the blanks would sit in the MIDDLE of history.
    const showDrafts = !hasActiveLens({ issue, query, filters }) && (scope === 'focus' || !win.hasNewer);
    const [draftIds, setDraftIds] = React.useState<string[]>(() => makeDraftIds(DEFAULT_DRAFT_ROWS));
    const [draftEdits, setDraftEdits] = React.useState<Record<string, FieldEdits>>({});
    const [addCount, setAddCount] = React.useState(String(DEFAULT_DRAFT_ROWS));

    /**
     * The date a blank row starts on: the NEWEST date already in view, because an
     * operator adding rows is almost always continuing the day they were just reading.
     * In the focus scope that is by construction inside the month being viewed; an empty
     * month falls back to its first day. It is a DEFAULT, not an edit — it shows muted,
     * it never makes a row dirty, and the operator sees it before anything is saved.
     */
    const draftDefaultDate = React.useMemo(() => {
        for (let i = records.length - 1; i >= 0; i--) {
            const d = records[i].row.delivery_date;
            if (d) return d;
        }
        if (scope === 'focus' && period) return periodBounds(period).from;
        return format(new Date(), 'yyyy-MM-dd');
    }, [records, scope, period]);

    /** The year a bare `6/27` means when the row itself cannot say. */
    const fallbackYear = React.useMemo(() => {
        if (scope === 'focus' && period) return period.year;
        const y = Number(draftDefaultDate.slice(0, 4));
        return Number.isFinite(y) && y > 1900 ? y : new Date().getFullYear();
    }, [scope, period, draftDefaultDate]);

    const dirtyIds = React.useMemo(() => {
        const s = new Set<string>();
        for (const [id, e] of Object.entries(edits)) if (Object.keys(e).length > 0) s.add(id);
        for (const id of Object.keys(sampleDrafts)) s.add(id);
        return s;
    }, [edits, sampleDrafts]);

    /** A blank row nobody typed into is NOT unsaved work. */
    const dirtyDraftIds = React.useMemo(() => {
        const s = new Set<string>();
        for (const [id, e] of Object.entries(draftEdits)) if (isDirtyFieldEdits(e)) s.add(id);
        return s;
    }, [draftEdits]);

    /**
     * ONE number, three consumers: the "N unsaved" chip, the Save button's disabled
     * state, and the axis-change guard further down. They must agree by construction —
     * a guard that prompts while Save is greyed out is a false alarm, and an operator
     * who meets three false alarms clicks through the fourth without reading it.
     *
     * Nothing new is decided here. `dirtyIds` and `dirtyDraftIds` above already hold
     * the project's definition of dirty (an untouched blank row is not work; a cell
     * typed back to its stored value has already left the map); this only counts them,
     * and counts the two KINDS apart because they are different losses.
     */
    const unsaved = React.useMemo(
        () => countUnsavedWork(dirtyIds, dirtyDraftIds),
        [dirtyIds, dirtyDraftIds],
    );
    const dirtyCount = unsaved.total;

    /** The live sample list for a receipt — the unsaved draft if there is one. */
    const samplesOf = React.useCallback(
        (id: string): SampleDraft[] => sampleDrafts[id] ?? toDrafts(recordsById.get(id)?.samples ?? []),
        [sampleDrafts, recordsById],
    );

    // ═══ Flatten to the render list + the nav row axis ═══════════════════════════
    //
    // `items` is what the container renders; `navRows` is the keyboard's row axis. Day
    // headers, `Σ DAY TOTAL` rows, the "add rows" control and the frozen footer are
    // ABSENT from `navRows` by construction, which is exactly why Tab and the arrows can
    // never land on one. Draft rows ARE present — a blank row is a real, editable row.
    const { items, navRows, monthTotals } = React.useMemo(
        () => flatten(records, samplesOf, scope, showDrafts ? draftIds : []),
        [records, samplesOf, scope, showDrafts, draftIds],
    );

    /**
     * Where each receipt SITS in the current view — its `#` in the `#` lane and its row
     * on the keyboard axis. Built once per flatten so the duplicate-peer popover can say
     * "row 412" and jump to it without walking `items` on every render.
     */
    const placeById = React.useMemo(() => {
        const m = new Map<string, { num: number; navRow: number; key: string }>();
        for (const it of items) {
            if (it.kind === 'delivery') {
                m.set(it.rec.row.id ?? '', { num: it.num, navRow: it.navRow, key: it.key });
            }
        }
        return m;
    }, [items]);

    // ═══ The nav resolver ════════════════════════════════════════════════════════
    const addressable = React.useCallback(
        (row: number, col: number): boolean => {
            if (row < 0 || row >= navRows.length) return false;
            if (col < 0 || col > lastCol) return false;
            const field = cols[col].field;
            if (field === null) return false;
            const nav = navRows[row];
            if (nav.kind === 'sample') return sampleFieldFor(field) !== null;
            return true; // a receipt row and a draft row occupy the same lanes
        },
        [navRows, cols, lastCol],
    );

    /**
     * Which cells a RANGE may cover. One column wider than `addressable`: TTL PRICE is
     * read-only, so nav never rests on it, but it is the single most useful column to
     * drag over and total — and the pill is a reader, not an editor.
     */
    const selectableCol = React.useCallback(
        (col: number): boolean => {
            const c = cols[col];
            return c !== undefined && isSelectableColumn(c);
        },
        [cols],
    );

    const cellExists = React.useCallback(
        (row: number, col: number): boolean => {
            if (addressable(row, col)) return true;
            // TTL PRICE exists on a receipt row only — a draw has no price, and a draft
            // has no stored total yet.
            return cols[col]?.key === 'ttl' && navRows[row]?.kind === 'delivery';
        },
        [addressable, cols, navRows],
    );

    const resolver = React.useMemo<NavResolver<CoordinateId>>(
        () => createDeliveryNavResolver({ rowCount: navRows.length, lastCol, addressable }),
        [navRows.length, lastCol, addressable],
    );

    const [rawActiveCell, setActiveCellState] = React.useState<CoordinateId | null>(null);

    // Clamped at READ time rather than reconciled in an effect: a page load, a lens
    // change or a deleted receipt can shrink the row axis under the selection, and an
    // effect would let one render paint with a selection pointing past the end.
    const activeCell = rawActiveCell && rawActiveCell.row < navRows.length ? rawActiveCell : null;

    // ═══ Cell text — the ONE place display/edit/dirty are reconciled ═════════════

    /** What an untouched DRAFT cell holds. Only the date has a default. */
    const draftCanonical = React.useCallback(
        (field: DeliveryField): string => (field === 'delivery_date' ? draftDefaultDate : ''),
        [draftDefaultDate],
    );

    /** What the cell shows when it takes FOCUS (the formula, for the two formula cells). */
    const getCellText = React.useCallback(
        (id: CoordinateId): string => {
            const nav = navRows[id.row];
            if (!nav) return '';
            const field = cols[id.col]?.field;
            if (!field) return '';

            if (nav.kind === 'sample') {
                const sf = sampleFieldFor(field);
                if (!sf) return '';
                const draft = samplesOf(nav.deliveryId)[nav.sampleIndex];
                return draft ? draft[sf] : '';
            }

            if (nav.kind === 'draft') {
                return draftEdits[nav.draftId]?.[field] ?? draftCanonical(field);
            }

            const pending = edits[nav.deliveryId]?.[field];
            if (pending !== undefined) return pending;

            const rec = recordsById.get(nav.deliveryId);
            if (!rec) return '';
            return canonicalEditText(rec, field);
        },
        [navRows, cols, edits, draftEdits, draftCanonical, recordsById, samplesOf],
    );

    /**
     * Write a cell — and DROP the edit when the text is back to what is already stored.
     *
     * That second half is the whole of item 5. `revertChanges` (Escape) restores the
     * pre-edit snapshot through this function, and the old version dutifully wrote that
     * correct value into `edits` and left the field sitting there, so the row stayed in
     * `dirtyIds`, the "N unsaved" chip kept counting it and Save stayed lit with nothing
     * to write. Clearing here fixes Escape as a special case of the general rule: a cell
     * typed back to its stored value is not an edit, however it got back there.
     */
    const setCellText = React.useCallback(
        (id: CoordinateId, value: string) => {
            const nav = navRows[id.row];
            if (!nav) return;
            const field = cols[id.col]?.field;
            if (!field) return;

            if (nav.kind === 'sample') {
                const sf = sampleFieldFor(field);
                if (!sf) return;
                const deliveryId = nav.deliveryId;
                const index = nav.sampleIndex;
                const stored = toDrafts(recordsById.get(deliveryId)?.samples ?? []);
                setSampleDrafts((prev) => {
                    const list = prev[deliveryId] ?? stored;
                    const next = list.map((d, i) => (i === index ? { ...d, [sf]: value } : d));
                    // Back to the stored block, draw for draw ⇒ the row is clean again.
                    if (sameDrafts(next, stored)) {
                        const out = { ...prev };
                        delete out[deliveryId];
                        return out;
                    }
                    return { ...prev, [deliveryId]: next };
                });
                return;
            }

            if (nav.kind === 'draft') {
                const draftId = nav.draftId;
                const canonical = draftCanonical(field);
                setDraftEdits((prev) => {
                    const next = mergeFieldEdit(prev[draftId], field, value, canonical);
                    const out = { ...prev };
                    if (Object.keys(next).length === 0) delete out[draftId];
                    else out[draftId] = next;
                    return out;
                });
                return;
            }

            const deliveryId = nav.deliveryId;
            const rec = recordsById.get(deliveryId);
            const canonical = rec ? canonicalEditText(rec, field) : '';
            setEdits((prev) => {
                const next = mergeFieldEdit(prev[deliveryId], field, value, canonical);
                const out = { ...prev };
                if (Object.keys(next).length === 0) delete out[deliveryId];
                else out[deliveryId] = next;
                return out;
            });
        },
        [navRows, cols, recordsById, draftCanonical],
    );

    /**
     * What a cell holds in the DATABASE — `getCellText` with the unsaved layer taken off.
     *
     * `getCellText` answers "what does this cell say right now"; this answers "what would
     * it say if nothing were unsaved". The pair is what makes Escape-outside-edit-mode
     * decidable: a cell is unsaved exactly when the two disagree, and putting the stored
     * text back through `setCellText` reverts it through the SAME `mergeFieldEdit`
     * machinery a keystroke uses — so the field leaves the edit map and the row leaves
     * `dirtyIds` by the existing rule, not a second definition of "revert".
     */
    const storedCellText = React.useCallback(
        (id: CoordinateId): string => {
            const nav = navRows[id.row];
            if (!nav) return '';
            const field = cols[id.col]?.field;
            if (!field) return '';

            if (nav.kind === 'sample') {
                const sf = sampleFieldFor(field);
                if (!sf) return '';
                // The STORED block, never `samplesOf` — that one hands back the draft.
                const stored = toDrafts(recordsById.get(nav.deliveryId)?.samples ?? []);
                return stored[nav.sampleIndex]?.[sf] ?? '';
            }

            // A draft row is stored NOWHERE, so its canonical text is what an untouched
            // one holds: empty, except the seeded date.
            if (nav.kind === 'draft') return draftCanonical(field);

            const rec = recordsById.get(nav.deliveryId);
            return rec ? canonicalEditText(rec, field) : '';
        },
        [navRows, cols, recordsById, draftCanonical],
    );

    /** The stable identity of a nav row — what `invalidCells` is keyed by. */
    const rowKeyOf = React.useCallback(
        (row: number): string => {
            const nav = navRows[row];
            if (!nav) return '';
            if (nav.kind === 'draft') return nav.draftId;
            if (nav.kind === 'sample') return `${nav.deliveryId}#${nav.sampleIndex}`;
            return nav.deliveryId;
        },
        [navRows],
    );

    const invalidKey = React.useCallback(
        (id: CoordinateId): string => `${rowKeyOf(id.row)}:${cols[id.col]?.key ?? ''}`,
        [rowKeyOf, cols],
    );

    /** The year a bare `6/27` means IN THIS ROW. */
    const contextYearFor = React.useCallback(
        (row: number): number => {
            if (scope === 'focus' && period) return period.year;
            const nav = navRows[row];
            if (nav?.kind === 'delivery') {
                const d = recordsById.get(nav.deliveryId)?.row.delivery_date;
                if (d) {
                    const y = Number(d.slice(0, 4));
                    if (Number.isFinite(y) && y > 1900) return y;
                }
            }
            return fallbackYear;
        },
        [scope, period, navRows, recordsById, fallbackYear],
    );

    // ═══ Commit-time validation ══════════════════════════════════════════════════
    //
    // The four cells that hold something other than a plain number are checked the
    // moment the operator leaves them, so a mistake is caught while the context is still
    // on screen. The SAVE re-runs the exact same checks (it has to — it builds the
    // patch), so this is an early warning, never the only gate.
    const markInvalid = React.useCallback(
        (id: CoordinateId, bad: boolean) => {
            const key = invalidKey(id);
            setInvalidCells((prev) => {
                if (bad === prev.has(key)) return prev;
                const next = new Set(prev);
                if (bad) next.add(key);
                else next.delete(key);
                return next;
            });
        },
        [invalidKey],
    );

    const validateOnCommit = React.useCallback(
        (id: CoordinateId) => {
            const nav = navRows[id.row];
            if (!nav || nav.kind === 'sample') return;
            const field = cols[id.col]?.field;
            if (!field) return;
            const text = getCellText(id).trim();
            const rec = nav.kind === 'delivery' ? recordsById.get(nav.deliveryId) : undefined;
            const label = rec ? rowLabel(rec) : nav.kind === 'draft' ? 'the new row' : 'this receipt';

            if (field === 'wt') {
                if (!text) return markInvalid(id, false);
                const parsed = parseWeightInput(text);
                if ('error' in parsed) {
                    markInvalid(id, true);
                    errorToast(`WT on ${label} could not be read: ${parsed.error}`, {
                        description: `You typed: ${text}\n\nThe cell keeps your text — nothing was written. Excel arithmetic works here: =27045*88% stores the 27,045 kg scale reading and the 12% deduction.`,
                    });
                    return;
                }
                return markInvalid(id, false);
            }

            if (field === 'price') {
                if (!text) return markInvalid(id, false);
                const parsed = parsePriceInput(text);
                if ('error' in parsed) {
                    markInvalid(id, true);
                    errorToast(`PHP/KG on ${label} could not be read: ${parsed.error}`, {
                        description: `You typed: ${text}\n\nThe cell keeps your text — nothing was written. Excel arithmetic works here: =39.5+2.7 stores the 39.50 base and the 2.70 add-on.`,
                    });
                    return;
                }
                return markInvalid(id, false);
            }

            if (field === 'supplier') {
                if (!text) return markInvalid(id, false);
                const parsed = parseSupplierCell(text, supplierCodes);
                if ('error' in parsed) {
                    markInvalid(id, true);
                    errorToast(`Supplier on ${label} is not recognised.`, { description: parsed.error });
                    return;
                }
                return markInvalid(id, false);
            }

            if (field === 'destination') {
                if (!text) return markInvalid(id, false);
                const parsed = parseDestinationCell(text, destinationCodes);
                if ('error' in parsed) {
                    markInvalid(id, true);
                    errorToast(`Warehouse on ${label} is not recognised.`, { description: parsed.error });
                    return;
                }
                return markInvalid(id, false);
            }

            // ── DATE — free text in, `yyyy-MM-dd` out (Excel's own habit) ────────
            // The cell holds whatever the operator typed until they leave it; here is
            // where `6/27` becomes `2026-06-27` and gets written BACK into the cell, so
            // what they see from now on is what the database will store. Unreadable text
            // is REFUSED and kept verbatim — a silently wrong date on a payment ledger is
            // the one outcome that must be impossible.
            if (field === 'delivery_date') {
                if (!text) return markInvalid(id, false);
                const parsed = parseDeliveryDate(text, contextYearFor(id.row));
                if ('error' in parsed) {
                    markInvalid(id, true);
                    errorToast(`The date on ${label} could not be read.`, {
                        description: `You typed: ${text}\n\n${parsed.error}\n\nThe cell keeps your text — nothing was written.`,
                    });
                    return;
                }
                if (parsed.iso !== text) setCellText(id, parsed.iso);
                return markInvalid(id, false);
            }
        },
        [
            navRows, cols, getCellText, setCellText, recordsById,
            supplierCodes, destinationCodes, markInvalid, contextYearFor,
        ],
    );

    // ═══ Edit session + keyboard ═════════════════════════════════════════════════
    const activeRef = React.useRef<CoordinateId | null>(null);
    activeRef.current = activeCell;

    const edit = useGridEditSession<CoordinateId>({
        getValue: getCellText,
        setValue: setCellText,
        onAfterCommit: () => {
            const id = activeRef.current;
            if (id) validateOnCommit(id);
        },
    });

    /**
     * The ONE scroll container for the current scope. Both scopes scroll on a single
     * element in both axes — virtuoso's scroller (`overflowX:auto` + its own
     * `overflowY:auto`) in endless, the plain wrapper in focus.
     */
    const scrollerEl = React.useCallback(
        (): HTMLDivElement | null =>
            scope === 'endless' ? virtuosoScrollerRef.current : scrollerRef.current,
        [scope],
    );

    /**
     * Keep the caret's ROW visible — and move NOTHING ELSE.
     *
     * Every scroll here is contained to `scrollerEl()`. `Element.scrollIntoView` is not
     * used in the focus branch (and `focus()` never scrolls at all — see `onAfterMove`)
     * because both walk EVERY scrollable ancestor up to the document: an
     * `overflow-hidden` ancestor is still a programmatically scrollable box, so a caret
     * move was dragging the whole page down. The old `block:'center'` compounded it by
     * re-centring the row on every keystroke even when it had not moved at all — which
     * is exactly what a horizontal Tab does.
     */
    const scrollTo = React.useCallback(
        (row: number) => {
            const nav = navRows[row];
            if (!nav) return;
            const index = items.findIndex(
                (it) =>
                    (it.kind === 'delivery' || it.kind === 'sample' || it.kind === 'draft') &&
                    it.navRow === row,
            );
            if (index < 0) return;

            if (scope === 'endless') {
                // ── INDEX SPACE: `index` is the RAW `items` array position. Do NOT add
                // `firstItemIndex` to it. ────────────────────────────────────────────
                // `firstItemIndex` offsets ONE thing only: the index virtuoso reports
                // BACK to `itemContent` / `computeItemKey` while rendering
                // (`react-virtuoso/dist/index.mjs:1492`, `:2782` — `originalIndex` is the
                // array position, `index` is that plus `firstItemIndex`). It does NOT
                // shift the space `scrollToIndex` / `scrollIntoView` speak.
                //
                // The proof is the clamp. Both scroll pipelines resolve their target
                // through `jn(location, sizes, totalCount - 1)` (`:1775` for
                // `scrollIntoView`, `:1123` for `scrollToIndex`), and `jn` ends with
                // `Math.max(0, Math.min(totalCount - 1, index))` (`:668`) — it clamps
                // against `totalCount`, never subtracts `firstItemIndex`. With
                // `FIRST_ITEM_BASE = 100_000` and ~1,000 loaded rows, a rebased index
                // therefore clamped to the LAST row on every single call: Tab and Enter
                // navigated correctly and then threw the sheet to the very bottom.
                //
                // Virtuoso's `scrollIntoView` is its own scroller's `scrollTo` — it never
                // touches an ancestor — and its default `calculateViewLocation` returns
                // null for an already-visible row, so this is already a no-op on a
                // purely horizontal move.
                virtuosoRef.current?.scrollIntoView({ index, behavior: 'auto' });
                return;
            }
            // Focus renders a plain table, so the row is a real element — found by its
            // own item key rather than a position, because `items` shifts under it.
            const scroller = scrollerRef.current;
            const key = items[index].key;
            const el = scroller?.querySelector<HTMLElement>(
                `[data-item-key="${CSS.escape(key)}"]`,
            );
            if (!scroller || !el) return;

            // The sticky `<thead>` and the sticky month `<tfoot>` sit OVER the scrolling
            // rows, so the genuinely visible band is the scrollport minus both. Landing a
            // row flush against `scrollTop` would tuck it under the header.
            const box = scroller.getBoundingClientRect();
            const headH = scroller.querySelector('thead')?.getBoundingClientRect().height ?? 0;
            const footH = scroller.querySelector('tfoot')?.getBoundingClientRect().height ?? 0;
            const r = el.getBoundingClientRect();
            const top = box.top + headH;
            const bottom = box.bottom - footH;

            // Minimum nudge, instant, and only on the axis that owes something.
            if (r.top < top) scroller.scrollTop -= top - r.top;
            else if (r.bottom > bottom) scroller.scrollTop += r.bottom - bottom;
        },
        [scope, navRows, items],
    );

    /**
     * Keep the caret's COLUMN visible. The table is ~1608px wide inside a horizontally
     * scrolling wrapper, so Tab can walk straight off the right edge; nothing used to
     * follow it. `columnScrollLeft` (pure, asserted in `verify-rc-deliveries-cells.ts`)
     * decides the offset and, critically, subtracts the frozen block's width — a column
     * scrolled to its own `left` would sit UNDER the pinned identity columns.
     */
    const scrollToCol = React.useCallback(
        (col: number) => {
            const scroller = scrollerEl();
            if (!scroller) return;
            const next = columnScrollLeft({
                col,
                cols,
                scrollLeft: scroller.scrollLeft,
                clientWidth: scroller.clientWidth,
                scrollWidth: scroller.scrollWidth,
            });
            // Assigning `scrollLeft` is instant by construction — a smooth scroll during
            // fast Tab entry is its own bug.
            if (next !== null) scroller.scrollLeft = next;
        },
        [scrollerEl, cols],
    );

    const setActiveCell = React.useCallback((id: CoordinateId | null) => {
        setActiveCellState(id);
    }, []);

    // ═══ Range selection ═════════════════════════════════════════════════════════
    //
    // The platform's rectangular selection (shift+click, shift+arrow, click-drag,
    // Ctrl/Cmd+A, Ctrl/Cmd+C), feeding the floating status-bar pill. The rectangle is
    // coordinate-shaped, but this grid's rows are NOT all the same shape — a moisture
    // draw occupies only the label lane and the seven lab lanes. So a range may cover
    // coordinates that hold no cell, and the asymmetry is honoured in the two places it
    // matters: the tint is painted only where a cell exists, and `getNumericCellValue`
    // returns null there, so the pill totals only what is really on screen.
    //
    // `scrollContainerRef` is deliberately NOT passed. It takes ONE ref object, and this
    // grid has two scrollers — the plain wrapper in `focus`, virtuoso's own div in
    // `endless` — so whichever one it were handed would be null in the other scope. It
    // was handed `scrollerRef`, so drag auto-scroll simply did not exist in the endless
    // scope. The ledger drives it below instead, off the same `scrollerEl()` the
    // caret-follow uses, which also lets the horizontal edge respect the frozen block.
    const cellSelection = useCellSelection({
        rowCount: navRows.length,
        colCount: cols.length,
        isSelectableColumn: selectableCol,
        enabled: true,
    });

    /**
     * Auto-scroll while a drag is at the edge of the sheet.
     *
     * Confined to `scrollerEl()` by assignment (`scrollTop`/`scrollLeft` +=), so it is
     * instant by construction and the document never moves — the same discipline as
     * `scrollTo` / `scrollToCol`. It runs only while the pointer is down, so it cannot
     * fight the caret-follow, which runs only on a keyboard move.
     *
     * `dragAutoScrollDelta` is pure and asserted in `verify-rc-deliveries-cells.ts`; the
     * load-bearing part is the LEFT band, measured from the inner edge of the pinned
     * `# · DATE · TRK# · SUPPLIER` block exactly as `columnScrollLeft` measures its
     * visible window. Without that, a drag can never reach the cells hidden under the
     * pinned columns — it would stall on them with nothing scrolling.
     */
    const frozenWidth = React.useMemo(() => frozenBlockWidth(cols), [cols]);
    const isDraggingSelection = cellSelection.isDragging;
    React.useEffect(() => {
        if (!isDraggingSelection) return;

        let raf = 0;
        let pointer: { x: number; y: number } | null = null;
        const onPointerMove = (e: PointerEvent) => {
            pointer = { x: e.clientX, y: e.clientY };
        };

        const tick = () => {
            const scroller = scrollerEl();
            if (scroller && pointer) {
                const r = scroller.getBoundingClientRect();
                const { dx, dy } = dragAutoScrollDelta({
                    pointer,
                    rect: { top: r.top, bottom: r.bottom, left: r.left, right: r.right },
                    frozen: frozenWidth,
                    scrollTop: scroller.scrollTop,
                    scrollLeft: scroller.scrollLeft,
                    maxScrollTop: Math.max(0, scroller.scrollHeight - scroller.clientHeight),
                    maxScrollLeft: Math.max(0, scroller.scrollWidth - scroller.clientWidth),
                });
                if (dy !== 0) scroller.scrollTop += dy;
                if (dx !== 0) scroller.scrollLeft += dx;
            }
            raf = requestAnimationFrame(tick);
        };

        document.addEventListener('pointermove', onPointerMove);
        raf = requestAnimationFrame(tick);
        return () => {
            document.removeEventListener('pointermove', onPointerMove);
            cancelAnimationFrame(raf);
        };
    }, [isDraggingSelection, scrollerEl, frozenWidth]);

    const selectionRange = cellSelection.range;
    const selectionSize = selectionRange ? cellSelection.getSelectionSize() : 0;
    const isRangeSelected = selectionSize > 1;

    /**
     * The number the pill adds up. STORED values only — `net_weight_kg`,
     * `total_price_php` and `price_php_kg` are DB-generated exact decimals, and a pill
     * that re-derived them in floating-point JavaScript would quietly disagree with the
     * ledger it is summarising. A draft row has nothing stored, so it contributes
     * nothing; an unsaved edit does not move the total until it is saved.
     */
    const getNumericCellValue = React.useCallback(
        (row: number, col: number): number | null => {
            const nav = navRows[row];
            const c = cols[col];
            if (!nav || !c || !c.numeric) return null;

            if (nav.kind === 'sample') {
                const sf = sampleFieldFor(c.field);
                if (!sf || sf === 'label') return null;
                return num(samplesOf(nav.deliveryId)[nav.sampleIndex]?.[sf]);
            }
            if (nav.kind === 'draft') return null;

            const r = recordsById.get(nav.deliveryId)?.row;
            if (!r) return null;
            switch (c.key) {
                case 'sacks': return num(r.sacks);
                case 'wt': return num(r.net_weight_kg);
                case 'bd': return num(r.bd);
                case 'moist': return num(r.moisture_pct);
                case 'grit': return num(r.grit);
                case 'ash': return num(r.ash);
                case 'dust': return num(r.dust);
                case 'vm': return num(r.vm);
                case 'fc': return num(r.fc);
                // The two ₱ columns are ABSENT from `cols` for a gated viewer, so these
                // are unreachable then — the guard is the belt to that braces.
                case 'php_kg': return canViewPrices ? num(r.price_php_kg) : null;
                case 'ttl': return canViewPrices ? num(r.total_price_php) : null;
                default: return null;
            }
        },
        [navRows, cols, recordsById, samplesOf, canViewPrices],
    );

    const getColumnDefaultCalcType = React.useCallback(
        (col: number): AggregationType | null => columnCalcType(cols[col]?.key ?? ''),
        [cols],
    );

    const aggregates = useCellAggregation({
        range: selectionRange,
        getNumericCellValue,
        getColumnDefaultCalcType,
    });

    // Push the count + aggregates to the shared status bar. Debounced so a drag does not
    // re-render the pill on every pointer move; the cleanup only cancels the pending
    // timer (wiping to 0 in cleanup makes the bar never settle during a drag).
    React.useEffect(() => {
        const timer = setTimeout(() => {
            setCellSelectionCount(selectionSize);
            setCellAggregates(selectionSize > 1 ? aggregates : null);
        }, 50);
        return () => clearTimeout(timer);
    }, [selectionSize, aggregates, setCellSelectionCount, setCellAggregates]);

    // Unmount-only: the pill lives in the app shell, so it has to be told when the grid
    // that owns the numbers leaves the tree.
    React.useEffect(
        () => () => {
            setCellSelectionCount(0);
            setCellAggregates(null);
        },
        [setCellSelectionCount, setCellAggregates],
    );

    /** Display text for the range copy — what the cell reads on screen. */
    const getCellDisplayValue = React.useCallback(
        (row: number, col: number): string => {
            const nav = navRows[row];
            const c = cols[col];
            if (!nav || !c) return '';
            if (c.key === 'ttl') {
                if (nav.kind !== 'delivery' || !canViewPrices) return '';
                return formatPeso(recordsById.get(nav.deliveryId)?.row.total_price_php);
            }
            if (!cellExists(row, col)) return '';
            return getCellText({ row, col });
        },
        [navRows, cols, recordsById, canViewPrices, cellExists, getCellText],
    );

    const { handleKeyDown: handleCopyKeyDown } = useClipboardCopy({
        getSelectedRange: cellSelection.getSelectedRange,
        getCellValue: getCellDisplayValue,
        getSelectionSize: cellSelection.getSelectionSize,
    });

    /**
     * What Delete / Backspace and Escape both act on: the range when there is one, else
     * the active cell. One definition, so "Escape undoes what that Backspace touched" is
     * true by construction rather than by two lists agreeing.
     *
     * The selection is deliberately LEFT INTACT by both — that is what keeps the undo
     * aimed at the block just cleared (and it is what Excel does).
     */
    const selectedCells = React.useCallback((): CoordinateId[] => {
        const out: CoordinateId[] = [];
        const r = cellSelection.getSelectedRange();
        if (r && cellSelection.getSelectionSize() > 1) {
            for (let row = r.startRow; row <= r.endRow; row++) {
                for (let col = r.startCol; col <= r.endCol; col++) {
                    if (addressable(row, col)) out.push({ row, col });
                }
            }
            return out;
        }
        const a = activeRef.current;
        if (a && addressable(a.row, a.col)) out.push(a);
        return out;
    }, [cellSelection, addressable]);

    /** Delete / Backspace: blank the range if there is one, else the active cell. */
    const clearSelectedCells = React.useCallback(() => {
        for (const id of selectedCells()) setCellText(id, '');
    }, [selectedCells, setCellText]);

    /**
     * Escape OUTSIDE edit mode: put the selection back to what the database holds.
     *
     * Delete / Backspace clears a cell WITHOUT opening an editor (that is this grid's own
     * opinion, and it stays) — so no edit session is ever started, `preEditValueRef`
     * never snapshots anything, and `useGridEditSession.revertChanges` has nothing to
     * restore. Escape had no meaning at all here, which is why backspacing a cell was
     * unundoable. It has one now, and it is the existing dirty machinery, not a new undo
     * stack: writing the stored text back through `setCellText` drops the field via
     * `mergeFieldEdit` exactly as typing the old value by hand would.
     *
     * Returns whether anything was actually undone — the verdict that makes Escape
     * two-stage (undo first, deselect second) and never a no-op with work on screen.
     */
    const revertSelectedCells = React.useCallback((): boolean => {
        let reverted = false;
        for (const id of selectedCells()) {
            const stored = storedCellText(id);
            if (getCellText(id) === stored) continue;
            setCellText(id, stored);
            // The stored value is valid by definition, so a refused commit's destructive
            // tint must go with the text that earned it.
            markInvalid(id, false);
            reverted = true;
        }
        return reverted;
    }, [selectedCells, storedCellText, getCellText, setCellText, markInvalid]);

    const rangeSlot = React.useMemo<GridRangeSlot>(
        () => ({
            isRangeSelected,
            extend: (e) => cellSelection.handleKeyDown(e),
            clear: () => cellSelection.clearSelection(),
            seedFromActive: () => {
                const a = activeRef.current;
                if (!a) return;
                cellSelection.handleCellMouseDown(a.row, a.col, {
                    button: 0,
                    shiftKey: false,
                    preventDefault: () => {},
                } as unknown as React.MouseEvent);
                cellSelection.handleMouseUp();
            },
            anchorId: () => {
                const r = cellSelection.getSelectedRange();
                return r ? { row: r.startRow, col: r.startCol } : null;
            },
            onCopy: (e) => handleCopyKeyDown(e),
            onDelete: (e) => {
                e.preventDefault();
                clearSelectedCells();
            },
        }),
        [isRangeSelected, cellSelection, handleCopyKeyDown, clearSelectedCells],
    );

    const { handleKeyDown } = useGridKeyboardNav<CoordinateId>({
        activeCell,
        setActiveCell,
        isEditing: edit.isEditing,
        resolver,
        edit: {
            start: (id, char) => edit.startEditing(id, char),
            revert: edit.revertChanges,
            commit: edit.commit,
        },
        range: rangeSlot,
        onAfterMove: (id) => {
            // Moving the caret ends the range — otherwise the tint would be left behind
            // pointing at cells the operator is no longer looking at.
            cellSelection.clearSelection();
            // Follow the caret on BOTH axes, each independently and each a no-op when it
            // owes nothing — so a horizontal Tab moves the sheet sideways and not a pixel
            // down, and a vertical Arrow does the reverse.
            scrollTo(id.row);
            scrollToCol(id.col);
            // `preventScroll` is not an optimisation. `focus()` is specified to scroll the
            // element into view with block AND inline "center", in every scrollable
            // ancestor — so re-focusing this full-height wrapper on every caret move was
            // yanking the page down. Focus still moves; only the scroll is refused.
            gridRef.current?.focus({ preventScroll: true });
        },
        // Tab-then-Enter returns to the run's lane — the Excel habit, and this sheet is
        // entered row-by-row across the lab columns, which is exactly the run it helps.
        enableEnterAnchor: true,
    });

    /**
     * Put the caret on a receipt and bring it into view — the duplicate-peer popover's
     * "go to it". Lands on the DATE lane, the leftmost addressable cell, because the
     * question being asked at that moment is "is this the same receipt?" and the answer
     * starts at the identity columns.
     */
    const goToReceipt = React.useCallback(
        (deliveryId: string) => {
            const place = placeById.get(deliveryId);
            if (!place) return false;
            const dateCol = cols.findIndex((c) => c.key === 'date');
            cellSelection.clearSelection();
            setActiveCell({ row: place.navRow, col: dateCol < 0 ? 0 : dateCol });
            scrollTo(place.navRow);
            gridRef.current?.focus({ preventScroll: true });
            return true;
        },
        [placeById, cols, cellSelection, setActiveCell, scrollTo],
    );

    // ═══ SELECT ≠ EDIT ═══════════════════════════════════════════════════════════
    //
    // The shared state machine already separates the two — click and the arrows only
    // move the caret, a printable character starts editing seeded with that character.
    // Two things sit ON TOP of it here, and both are this grid's own opinion:
    //
    //   • ENTER opens the cell for editing, preserving its value, rather than dropping a
    //     row. The operators live in Google Sheets, where that is what Enter does on a
    //     selected cell; Excel's "Enter = down" survives where it matters, because Enter
    //     WHILE EDITING still commits and moves (and still honours the Tab-run lane
    //     anchor). Shift+Enter still walks up.
    //   • DELETE / BACKSPACE clears the value outright instead of opening an empty
    //     editor. "Clear" should not need a second keystroke to take effect. The
    //     selection SURVIVES the clear, so the undo below has something to aim at.
    //   • ESCAPE, with no editor open, UNDOES the unsaved edits under the selection —
    //     and only deselects once there is nothing left to undo. Without it a Backspace
    //     would be unundoable, because it never starts an edit session to revert.
    //
    // The first branch is the guard that makes any of this safe: a keystroke aimed at
    // CHROME inside the grid — the "add rows" counter, a column header's filter button —
    // is not a grid keystroke. Enter on a filter button must open the filter, not open
    // the selected cell for editing.
    const onGridKeyDown = React.useCallback(
        (e: React.KeyboardEvent) => {
            if (!edit.isEditing && isGridChrome(e.target)) return;

            if (!edit.isEditing && (e.metaKey || e.ctrlKey) && e.key === 'a') {
                e.preventDefault();
                cellSelection.selectAll();
                return;
            }

            // ── ESCAPE outside edit mode — undo first, deselect second ───────────
            //
            // Escape while EDITING is the shared hook's (revert + close the editor) and is
            // untouched. Out here it used to mean nothing at all, which is precisely the
            // bug: Backspace clears without opening an editor, so there was no session to
            // revert and no other path that could put the value back.
            //
            // So it reverts the unsaved edits under the CURRENT SELECTION — the active
            // cell, or every cell of the range. Only when there is nothing to undo does it
            // fall through to the shared hook, which clears the range. First Escape
            // undoes, second Escape deselects; it is never a no-op while work is on
            // screen. Propagation is deliberately NOT stopped here: an Escape this branch
            // declines is one nobody in the grid wants, and a Radix layer above may.
            if (!edit.isEditing && e.key === 'Escape' && revertSelectedCells()) {
                e.preventDefault();
                return;
            }

            if (!edit.isEditing && activeRef.current) {
                const a = activeRef.current;
                const plain = !e.metaKey && !e.ctrlKey && !e.altKey;

                if (e.key === 'Enter' && plain && !e.shiftKey && addressable(a.row, a.col)) {
                    e.preventDefault();
                    cellSelection.clearSelection();
                    edit.startEditing(a);
                    return;
                }
            }

            // ── DELETE / BACKSPACE — clear outright, and KEEP the selection ──────
            //
            // Handled here rather than by the shared hook's range branch, which clears
            // the selection straight after clearing the cells (`onDelete` then `clear`).
            // Leaving it is what Excel does and what makes the Escape above useful: the
            // block just blanked is still the block the undo is aimed at.
            //
            // Not nested in the `activeRef.current` guard above, because a range dragged
            // from a read-only cell (TTL PRICE is selectable, never active) has no active
            // cell at all — and that range must clear, and stay, like any other.
            if (
                !edit.isEditing &&
                (e.key === 'Delete' || e.key === 'Backspace') &&
                !e.metaKey && !e.ctrlKey && !e.altKey
            ) {
                e.preventDefault();
                clearSelectedCells();
                return;
            }

            handleKeyDown(e);
        },
        [
            edit, activeRef, addressable, cellSelection,
            clearSelectedCells, revertSelectedCells, handleKeyDown,
        ],
    );

    // ═══ Paste ═══════════════════════════════════════════════════════════════════
    //
    // The shared TSV paste, bridged to this grid's edit MAP. The hook thinks in rows; a
    // thin `setRows` adapter turns the array it produces back into per-receipt edits,
    // dropping any cell the paste landed on that is not addressable on that row — so a
    // block pasted across a receipt and its sub-samples writes only where a cell exists,
    // by the same rule the keyboard uses.
    //
    // Built ON DEMAND rather than in a memo. `getCellText` closes over the edit map, so
    // it changes on EVERY KEYSTROKE — and a memo here would re-read every cell of every
    // row (1,200+ rows × 17 columns) on each one, to serve a gesture that happens once
    // in a while. A paste can afford to pay for its own snapshot.
    const readAllPasteRows = React.useCallback(
        (): PasteRow[] => navRows.map((_, r) => readPasteRow(r, cols, getCellText)),
        [navRows, cols, getCellText],
    );

    const applyPaste = React.useCallback<React.Dispatch<React.SetStateAction<PasteRow[]>>>(
        (update) => {
            const before = readAllPasteRows();
            const after = typeof update === 'function' ? update(before) : update;
            let written = 0;
            for (let r = 0; r < Math.min(after.length, navRows.length); r++) {
                const row = after[r];
                for (let c = 0; c <= lastCol; c++) {
                    const field = cols[c].field;
                    if (field === null) continue;
                    const key = pasteKey(c);
                    const next = row[key];
                    if (next === undefined || next === before[r]?.[key]) continue;
                    if (!addressable(r, c)) continue;
                    setCellText({ row: r, col: c }, next);
                    written++;
                }
            }
            if (written === 0) toast.info('Nothing pasted — that block lands outside the editable cells.');
        },
        [readAllPasteRows, navRows.length, cols, lastCol, addressable, setCellText],
    );

    const pasteColumnMap = React.useMemo(
        () => cols.map((c, i) => (c.field === null ? null : (pasteKey(i) as keyof PasteRow))),
        [cols],
    );
    /** Which synthetic paste keys are the DATE lane — the one column that needs
     *  Excel-style shorthand transcription (`6/2` → `yyyy-MM-dd`). */
    const dateKeys = React.useMemo(
        () => new Set(cols.map((c, i) => (c.field === 'delivery_date' ? pasteKey(i) : '')).filter(Boolean)),
        [cols],
    );

    const { handleGridPaste } = useGridPaste<PasteRow>({
        columnMap: pasteColumnMap,
        setRows: applyPaste,
        createEmptyRow: () => ({}),
        cleanCellValue: (raw, key) => {
            const trimmed = trimCellValue(raw);
            if (!dateKeys.has(String(key))) return trimmed;
            // Same shorthand rule the typed DATE cell uses, and the same context year —
            // a pasted `6/27` and a typed `6/27` must not land on different years.
            const parsed = parseDeliveryDate(trimmed, fallbackYear);
            return 'error' in parsed ? trimmed : parsed.iso;
        },
    });

    /** Paste is a grid gesture — unless the caret is in a control the grid does not own. */
    const onGridPaste = React.useCallback(
        (e: React.ClipboardEvent) => {
            if (isGridChrome(e.target)) return;
            handleGridPaste(e, activeRef.current);
        },
        [handleGridPaste],
    );

    // ═══ Context menu ════════════════════════════════════════════════════════════
    const menu = useGridContextMenu<MenuRef>({ width: 232, height: 220 });

    const addSample = React.useCallback(
        (deliveryId: string, afterIndex?: number) => {
            setSampleDrafts((prev) => {
                const list = prev[deliveryId] ?? toDrafts(recordsById.get(deliveryId)?.samples ?? []);
                const blank: SampleDraft = {
                    key: `new-${Math.random().toString(36).slice(2, 10)}`,
                    label: `#${list.length + 1}`,
                    bd: '', moisture_pct: '', grit: '', ash: '', dust: '', vm: '', fc: '',
                };
                const at = afterIndex === undefined ? list.length : afterIndex + 1;
                return { ...prev, [deliveryId]: [...list.slice(0, at), blank, ...list.slice(at)] };
            });
        },
        [recordsById],
    );

    const removeSample = React.useCallback(
        (deliveryId: string, index: number) => {
            setSampleDrafts((prev) => {
                const list = prev[deliveryId] ?? toDrafts(recordsById.get(deliveryId)?.samples ?? []);
                return { ...prev, [deliveryId]: list.filter((_, i) => i !== index) };
            });
        },
        [recordsById],
    );

    /**
     * Fill the receipt's official MOIST from its draws' average. Offered, never
     * automatic: the receipt's own reading is the number the lab signed off, and a
     * six-draw mean is a different measurement with a different meaning.
     */
    const fillMoistureFromSamples = React.useCallback(
        (deliveryId: string) => {
            const rec = recordsById.get(deliveryId);
            const avg = num(rec?.row.sample_avg_moisture_pct);
            if (avg === null) {
                errorToast('That receipt has no moisture draws to average.');
                return;
            }
            setEdits((prev) => ({
                ...prev,
                [deliveryId]: { ...(prev[deliveryId] ?? {}), moisture_pct: avg.toFixed(2) },
            }));
            toast.success(`MOIST set to the ${rec?.row.sample_count ?? 0}-draw average (${avg.toFixed(2)}%)`);
        },
        [recordsById],
    );

    const revertRow = React.useCallback((deliveryId: string) => {
        setEdits((prev) => {
            const next = { ...prev };
            delete next[deliveryId];
            return next;
        });
        setSampleDrafts((prev) => {
            const next = { ...prev };
            delete next[deliveryId];
            return next;
        });
        setInvalidCells((prev) => {
            const next = new Set([...prev].filter((k) => !k.startsWith(`${deliveryId}:`) && !k.startsWith(`${deliveryId}#`)));
            return next.size === prev.size ? prev : next;
        });
    }, []);

    /** Wipe a blank row back to blank. */
    const clearDraftRow = React.useCallback((draftId: string) => {
        setDraftEdits((prev) => {
            const next = { ...prev };
            delete next[draftId];
            return next;
        });
        setInvalidCells((prev) => {
            const next = new Set([...prev].filter((k) => !k.startsWith(`${draftId}:`)));
            return next.size === prev.size ? prev : next;
        });
    }, []);

    /** `Add [N] more rows at the bottom` — the Sheets control, same semantics. */
    const addDraftRows = React.useCallback((raw: string) => {
        const n = clampDraftAdd(raw);
        setDraftIds((prev) => [...prev, ...makeDraftIds(n)]);
    }, []);

    const copyRow = React.useCallback(
        (deliveryId: string) => {
            const rec = recordsById.get(deliveryId);
            if (!rec) return;
            const tsv = cols
                .filter((c) => c.field !== null)
                .map((c) => displayText(rec, c.field!, canViewPrices))
                .join('\t');
            void navigator.clipboard.writeText(tsv).then(() => toast.success('Row copied as TSV'));
        },
        [recordsById, cols, canViewPrices],
    );

    // A blank row is not a receipt yet — it has no draws to add, no stored total to copy
    // and nothing to delete. It gets its own one-item menu rather than a mostly-disabled
    // copy of the receipt menu (`separator` carries no `hidden`, so the two menus cannot
    // share one array without leaving stray rules behind).
    const menuIsDraft = menu.state?.ref.draftId !== undefined;

    const menuItems = React.useMemo<GridMenuItem<MenuRef>[]>(() => {
        if (menuIsDraft) {
            return [
                {
                    kind: 'item',
                    label: 'Clear this new row',
                    icon: Undo2,
                    disabled: (ref) => ref.draftId === undefined || !dirtyDraftIds.has(ref.draftId),
                    onSelect: (ref) => {
                        if (ref.draftId !== undefined) clearDraftRow(ref.draftId);
                    },
                },
            ];
        }
        return [
            {
                kind: 'item',
                label: 'Add moisture draw',
                icon: Plus,
                onSelect: (ref) => addSample(ref.deliveryId, ref.sampleIndex),
            },
            {
                kind: 'item',
                label: 'Remove this draw',
                icon: Trash2,
                variant: 'destructive',
                hidden: (ref) => ref.sampleIndex === undefined,
                onSelect: (ref) => {
                    if (ref.sampleIndex !== undefined) removeSample(ref.deliveryId, ref.sampleIndex);
                },
            },
            { kind: 'separator' },
            {
                kind: 'item',
                label: (ref) => `Fill MOIST from ${ref.sampleCount} draw${ref.sampleCount === 1 ? '' : 's'}`,
                icon: Droplets,
                disabled: (ref) => ref.sampleCount === 0,
                onSelect: (ref) => fillMoistureFromSamples(ref.deliveryId),
            },
            { kind: 'item', label: 'Copy row as TSV', icon: Copy, onSelect: (ref) => copyRow(ref.deliveryId) },
            {
                kind: 'item',
                label: 'Discard changes on this row',
                icon: Undo2,
                disabled: (ref) => !dirtyIds.has(ref.deliveryId),
                onSelect: (ref) => revertRow(ref.deliveryId),
            },
            { kind: 'separator' },
            {
                kind: 'item',
                label: 'Delete receipt…',
                icon: Trash2,
                variant: 'destructive',
                onSelect: (ref) => {
                    const rec = recordsById.get(ref.deliveryId);
                    if (rec) setDeleteTarget(rec);
                },
            },
        ];
    }, [
        menuIsDraft, addSample, removeSample, fillMoistureFromSamples, copyRow, revertRow,
        clearDraftRow, dirtyIds, dirtyDraftIds, recordsById,
    ]);

    // ═══ Save ════════════════════════════════════════════════════════════════════
    //
    // Every dirty row — stored receipt or blank-row draft — is validated FIRST, and a
    // single bad cell blocks the WHOLE batch. Half-committing a sheet an operator is
    // midway through is worse than refusing it: they would have to work out which rows
    // landed. The toast names every offending row so the fix list is on screen, not in
    // the console.
    //
    // A draft carries two extra requirements the RPC would otherwise raise on its own,
    // and which are checked HERE so the operator meets them as a sentence rather than a
    // database error: a receipt entered in the app must have a date, and it must name a
    // supplier that resolves — a cheque needs a payee.
    //
    // ── The return value, and `requery` ──────────────────────────────────────────
    // It answers ONE question for the axis guard: did every unsaved thing reach the
    // database? `true` only when nothing was refused by validation, nothing came back
    // `version_conflict`/`forbidden`/`invalid`, and no dirty row was left behind — so
    // "Save and continue" can never navigate away from work that did not land.
    //
    // `requery: false` suppresses the post-save re-anchor, and only the guard passes it.
    // The re-anchor exists so the freshly inserted receipt appears in the CURRENT
    // window; when the caller is about to rewrite the URL, the page re-renders on the
    // server and this grid remounts against a window fetched for the NEW axes, which
    // already contains it. Firing both would put two navigations in flight and let the
    // slower one win.
    const handleSave = React.useCallback(async (opts?: { requery?: boolean }): Promise<boolean> => {
        const requery = opts?.requery ?? true;
        if (dirtyCount === 0 || saving) return false;

        const inputs: SaveDeliveryInput[] = [];
        const problems: string[] = [];

        for (const id of dirtyIds) {
            const rec = recordsById.get(id);
            if (!rec) continue;
            const label = rowLabel(rec);
            const version = rec.row.row_version;
            if (version === null || version === undefined) {
                problems.push(`${label}: the row is missing its version token — reload before editing.`);
                continue;
            }

            const built = buildPatch(edits[id] ?? {}, supplierCodes, destinationCodes, canViewPrices);
            if (built.errors.length > 0) {
                for (const e of built.errors) problems.push(`${label}: ${e}`);
                continue;
            }

            const drafts = sampleDrafts[id];
            const samples = drafts ? toSamplePayload(drafts) : undefined;

            if (Object.keys(built.patch).length === 0 && !samples) continue;
            inputs.push({ key: id, id, expectedRowVersion: version, patch: built.patch, samples, label });
        }

        // ── The blank rows at the bottom ─────────────────────────────────────────
        for (const draftId of draftIds) {
            if (!dirtyDraftIds.has(draftId)) continue;
            const e = draftEdits[draftId] ?? {};
            const label = draftLabel(e, draftDefaultDate);

            const parsedDate = parseDeliveryDate(e.delivery_date ?? draftDefaultDate, fallbackYear);
            if ('error' in parsedDate) {
                problems.push(`${label}: ${parsedDate.error}`);
                continue;
            }
            if (!(e.supplier ?? '').trim()) {
                problems.push(`${label}: a new receipt needs a supplier — a cheque with no payee cannot be liquidated.`);
                continue;
            }

            const built = buildPatch(
                { ...e, delivery_date: parsedDate.iso },
                supplierCodes,
                destinationCodes,
                canViewPrices,
            );
            if (built.errors.length > 0) {
                for (const err of built.errors) problems.push(`${label}: ${err}`);
                continue;
            }
            if (Object.keys(built.patch).length === 0) continue;
            inputs.push({ key: draftId, id: null, expectedRowVersion: null, patch: built.patch, label });
        }

        if (problems.length > 0) {
            errorToast(
                `${problems.length} change${problems.length === 1 ? '' : 's'} could not be saved — nothing was written.`,
                { description: problems.join('\n') },
            );
            return false;
        }
        if (inputs.length === 0) {
            toast.info('Nothing to save.');
            return false;
        }

        // Every dirty key that is NOT in this batch would still be dirty afterwards.
        // In practice the set is empty (each `continue` above is unreachable for a row
        // that is genuinely dirty), but the guard's promise is "the work landed", so it
        // is checked rather than assumed.
        const sent = new Set(inputs.map((i) => i.key));
        const stranded = [...dirtyIds, ...dirtyDraftIds].filter((k) => !sent.has(k));

        setSaving(true);
        try {
            const result = await saveDeliveries(inputs);
            const failed = result.results.filter((r) => !r.ok);
            const savedKeys = result.results.filter((r) => r.ok).map((r) => r.key);
            const savedDrafts = savedKeys.filter(isDraftKey);
            const savedRows = savedKeys.filter((k) => !isDraftKey(k));

            if (savedRows.length > 0) {
                setEdits((prev) => {
                    const next = { ...prev };
                    for (const id of savedRows) delete next[id];
                    return next;
                });
                setSampleDrafts((prev) => {
                    const next = { ...prev };
                    for (const id of savedRows) delete next[id];
                    return next;
                });
            }
            if (savedDrafts.length > 0) {
                // The draft became a real receipt: drop its text AND its blank row, then
                // top the pool back up so the run of blanks under the sheet stays the
                // same length (Sheets never shrinks it either).
                const consumed = new Set(savedDrafts);
                setDraftEdits((prev) => {
                    const next = { ...prev };
                    for (const k of savedDrafts) delete next[k];
                    return next;
                });
                setDraftIds((prev) => [
                    ...prev.filter((k) => !consumed.has(k)),
                    ...makeDraftIds(savedDrafts.length),
                ]);
            }
            if (savedKeys.length > 0) setInvalidCells(new Set());

            if (failed.length > 0) {
                errorToast(
                    `${failed.length} receipt${failed.length === 1 ? '' : 's'} did not save.`,
                    {
                        description: failed
                            .map((f) => `${f.label} — ${f.outcome}: ${f.message ?? 'no detail returned'}`)
                            .join('\n'),
                    },
                );
            }
            if (result.savedCount > 0) {
                toast.success(`Saved ${result.savedCount} receipt${result.savedCount === 1 ? '' : 's'}`);
                // Skipped entirely when the caller is about to change the axes: the URL
                // write it is holding re-renders the page on the server and remounts
                // this grid on a window fetched for the new axes, which already contains
                // whatever was just written.
                if (!requery) {
                    /* the axis write that follows is the requery */
                } else if (scope !== 'endless') startTransition(() => router.refresh());
                // A NEW receipt has to be looked up, not merged in: it did not exist when
                // this window was read, and its date decides where in history it belongs.
                // Re-anchoring on `latest` is also what keeps the blank rows on screen —
                // they only render at the true newest end of the sheet, which is exactly
                // where an operator who just filed a receipt still is.
                else if (savedDrafts.length > 0) await win.reset({ kind: 'latest' });
                else await win.refreshWindow();
            }

            return failed.length === 0 && stranded.length === 0;
        } finally {
            setSaving(false);
        }
    }, [
        dirtyCount, dirtyIds, dirtyDraftIds, draftIds, draftEdits, draftDefaultDate,
        fallbackYear, saving, recordsById, edits, sampleDrafts,
        supplierCodes, destinationCodes, canViewPrices, scope, win, router,
    ]);

    const handleDelete = React.useCallback(async () => {
        const target = deleteTarget;
        if (!target) return;
        setDeleteTarget(null);
        const id = target.row.id ?? '';
        const version = target.row.row_version;
        if (!id || version === null || version === undefined) {
            errorToast('That receipt is missing its id or version token — reload the ledger.');
            return;
        }
        const result = await deleteDelivery(id, version);
        if (!result.ok) {
            errorToast(`Could not delete ${rowLabel(target)} (${result.outcome}).`, {
                description: result.message ?? 'No detail returned by the database.',
            });
            return;
        }
        toast.success(
            `Deleted ${rowLabel(target)}${result.samplesDeleted > 0 ? ` and ${result.samplesDeleted} draw${result.samplesDeleted === 1 ? '' : 's'}` : ''}`,
        );
        revertRow(id);
        if (scope === 'endless') win.dropRecord(id);
        else startTransition(() => router.refresh());
    }, [deleteTarget, scope, win, router, revertRow]);

    // ═══ URL axis writers — ONE guarded choke point ══════════════════════════════
    //
    // Every axis this screen can change lives in the URL: the scope, the focused month,
    // the data-quality lens, the search, and each of the twelve column filters. Writing
    // any of them changes `axesKey(...)` in `page.tsx`, which REMOUNTS this component
    // against a window the server prefetched for the new axes — and every unsaved edit
    // and every typed blank row is local state, so it all goes.
    //
    // That was survivable when only a search box and four lenses could trigger it. It is
    // not survivable now: twelve filter popovers, twelve chip X's and a Clear all reach
    // the same code, and the operator this ledger exists for is about to type real
    // receipts into the blank rows by hand. Eight receipts typed, one filter narrowed to
    // check something, eight receipts gone.
    //
    // So NOTHING writes the URL directly. `requestAxisChange` is the only path, and it
    // asks two questions in order before it asks the operator anything:
    //
    //   1. Would the query string change at all? Identical ⇒ the control was already in
    //      that state (clicking the scope you are on, re-applying the same filter,
    //      blurring an unchanged search box) and nothing happens — no navigation, and
    //      critically no prompt.
    //   2. Would the AXES KEY change? That, not the query string, is what remounts the
    //      grid and destroys the work — so it is what the guard is defined on. A write
    //      that tidies the URL without moving the key (making an implicit month explicit,
    //      say) navigates straight through: React keeps the same component instance and
    //      every edit survives, so there is nothing to warn about. It is computed with
    //      the SAME pure parsers `page.tsx` uses, against the same `monthKeys`, so the
    //      client's prediction and the server's decision cannot disagree.
    //
    // Only when both are true, and there is unsaved work, is the href parked and the
    // prompt raised. The href is resolved at REQUEST time rather than replayed from a
    // closure later, so what eventually lands is exactly the intent of the click.
    //
    // A guard that cries wolf is the failure mode that gets guards ignored, which is why
    // both questions are asked before the operator is.
    const pendingAxisRef = React.useRef<PendingAxisChange | null>(null);
    const [axisPromptOpen, setAxisPromptOpen] = React.useState(false);

    /** The key this instance was mounted with — the server derived these five props. */
    const currentAxesKey = axesKey({ scope, period, issue, query, filters });

    /** What `page.tsx` would key the client by for a given set of params. */
    const axesKeyOf = React.useCallback(
        (sp: URLSearchParams): string => {
            const p = Object.fromEntries(sp.entries());
            return axesKey({
                scope: parseScope(p.scope),
                period: resolvePeriod(monthKeys, p.year, p.month),
                issue: parseIssueLens(p.issue),
                query: parseQuery(p.q),
                filters: parseColumnFilters(p),
            });
        },
        [monthKeys],
    );

    const navigateAxis = React.useCallback(
        (href: string, onApplied?: () => void) => {
            onApplied?.();
            startTransition(() => router.replace(href, { scroll: false }));
        },
        [router],
    );

    const requestAxisChange = React.useCallback(
        (
            mutate: (sp: URLSearchParams) => void,
            opts?: { onApplied?: () => void; onCancelled?: () => void },
        ) => {
            const current = searchParams.toString();
            const sp = new URLSearchParams(current);
            mutate(sp);
            const qs = sp.toString();
            if (qs === current) return;
            const href = qs ? `${pathname}?${qs}` : pathname;

            if (unsaved.total === 0 || axesKeyOf(sp) === currentAxesKey) {
                navigateAxis(href, opts?.onApplied);
                return;
            }
            // The prompt is modal, but a blur handler can still fire as focus moves into
            // it (the search box commits on blur). The first request wins; a second one
            // is the same intent arriving twice.
            if (pendingAxisRef.current) return;
            pendingAxisRef.current = { href, onApplied: opts?.onApplied, onCancelled: opts?.onCancelled };
            setAxisPromptOpen(true);
        },
        [searchParams, pathname, axesKeyOf, currentAxesKey, navigateAxis, unsaved.total],
    );

    const setScope = (next: Scope) =>
        requestAxisChange((sp) => {
            if (next === 'endless') sp.delete('scope');
            else sp.set('scope', next);
        });

    const setIssue = (next: IssueLens | null) =>
        requestAxisChange((sp) => {
            if (next === null) sp.delete('issue');
            else sp.set('issue', next);
        });

    const setPeriodParam = (key: string) =>
        requestAxisChange((sp) => {
            const p = parsePeriodKey(key);
            if (!p) return;
            sp.set('year', String(p.year));
            sp.set('month', String(p.month));
        });

    /**
     * Write ONE column's filter into the URL — which is what actually runs it, because
     * the axes key changes, the page re-renders on the server and the client remounts
     * against a window that was fetched WITH the filter. Nothing filters in the browser.
     */
    const setColumnFilter = React.useCallback(
        (colKey: string, next: ColumnFilter | null) =>
            requestAxisChange((sp) => {
                const value = serializeColumnFilter(next);
                if (value === null) sp.delete(filterParamName(colKey));
                else sp.set(filterParamName(colKey), value);
            }),
        [requestAxisChange],
    );

    const clearAllFilters = React.useCallback(
        () =>
            requestAxisChange((sp) => {
                for (const key of filteredColumnKeys(filters)) sp.delete(filterParamName(key));
            }),
        [requestAxisChange, filters],
    );

    // ── The three ways out of the unsaved-work prompt ────────────────────────────

    /** Stay. Nothing is written, and every control goes back to reading the truth. */
    const cancelAxisChange = React.useCallback(() => {
        const pending = pendingAxisRef.current;
        pendingAxisRef.current = null;
        setAxisPromptOpen(false);
        pending?.onCancelled?.();
    }, []);

    /**
     * Go, and lose it. The remount that follows would drop this state anyway, but the
     * edit maps are cleared HERE so "Discard" means discard on its own terms rather than
     * by relying on a key change happening downstream.
     */
    const discardAndContinue = React.useCallback(() => {
        const pending = pendingAxisRef.current;
        pendingAxisRef.current = null;
        setAxisPromptOpen(false);
        setEdits({});
        setSampleDrafts({});
        setDraftEdits({});
        setInvalidCells(new Set());
        if (pending) navigateAxis(pending.href, pending.onApplied);
    }, [navigateAxis]);

    /**
     * Save first, and go ONLY if all of it landed.
     *
     * Sequenced, never fired in parallel: `handleSave({requery:false})` is awaited to
     * completion — the RPCs return, the verdicts are applied to the edit maps, and the
     * post-save re-anchor is deliberately skipped because the URL write below IS the
     * requery. A refusal of any kind (validation, `version_conflict`, `forbidden`,
     * `invalid`, or a dirty row that never made it into the batch) keeps the prompt open
     * over the operator's work, with the existing persistent error toast naming it.
     */
    const saveAndContinue = React.useCallback(async () => {
        const pending = pendingAxisRef.current;
        if (!pending) return;
        const ok = await handleSave({ requery: false });
        if (!ok) return;
        pendingAxisRef.current = null;
        setAxisPromptOpen(false);
        navigateAxis(pending.href, pending.onApplied);
    }, [handleSave, navigateAxis]);

    // ── The other way this work dies: a real browser navigation ──────────────────
    //
    // A tab close, a reload, or a link out of the app unloads the page and takes the
    // same edits with it, and no in-app guard can see that coming. `beforeunload` is the
    // only hook the platform offers, and it is deliberately ALL that is done here.
    //
    // What it does NOT cover: a client-side route change to another Blackwood module
    // (the navbar, a breadcrumb). Next's App Router exposes no cancellable navigation
    // event, and the ways to fake one — patching history, intercepting every anchor —
    // are exactly the kind of global surgery that breaks in a version bump. The axis
    // guard above owns every URL write this screen makes itself; this covers the exit
    // from the app; the gap between them is known and small.
    React.useEffect(() => {
        if (unsaved.total === 0) return;
        const onBeforeUnload = (e: BeforeUnloadEvent) => {
            e.preventDefault();
            // Older browsers only show their own generic prompt when this is set. The
            // string has been ignored by every browser for years — the text cannot be
            // ours, which is why the in-app prompt exists at all.
            e.returnValue = '';
        };
        window.addEventListener('beforeunload', onBeforeUnload);
        return () => window.removeEventListener('beforeunload', onBeforeUnload);
    }, [unsaved.total]);

    const activeFilters = filteredColumnKeys(filters);
    const filterCount = activeFilterCount(filters);
    /** What the count line is counting. Focus loads the whole month, so it knows exactly. */
    const matchCount = scope === 'focus' ? records.length : win.totalCount;
    const narrowed = hasActiveLens({ issue, query, filters });

    // ── Search box: local state, committed on Enter/blur (a URL write per keystroke
    //    would be a server round-trip per keystroke). ────────────────────────────────
    // Seeded once: a committed search changes the URL, which changes the axes key, which
    // REMOUNTS this component — so there is nothing to sync back afterwards.
    const [searchText, setSearchText] = React.useState(query);
    const commitSearch = () => {
        // Blur fires this too, including the blur caused by focus moving INTO the unsaved
        // -work prompt. `requestAxisChange` drops a no-op href on its own, but returning
        // here keeps the common "clicked out of an untouched box" case from even building
        // one, and makes the intent explicit: an unchanged search is not a search.
        if (searchText.trim() === query) return;
        requestAxisChange(
            (sp) => {
                const v = searchText.trim();
                if (v) sp.set('q', v);
                else sp.delete('q');
            },
            // Cancelling puts the box back to the search that is actually running. The
            // alternative — leaving the typed text sitting there over unfiltered rows —
            // is a control claiming to have applied something it did not.
            { onCancelled: () => setSearchText(query) },
        );
    };

    // ═══ Cell rendering ══════════════════════════════════════════════════════════

    const renderEditor = (id: CoordinateId, align: 'left' | 'right') => (
        <EditInput
            autoFocus
            value={getCellText(id)}
            onChange={(v) => setCellText(id, v)}
            onCommit={edit.commit}
            onEscape={edit.revertChanges}
            align={align}
            valueClass="text-xs"
        />
    );

    /**
     * One `<td>`, for a row the keyboard can address (`navRow >= 0` always — chrome rows
     * build their own cells).
     *
     * The interactive layer is `absolute inset-0` inside a positioned `<td>` of an
     * explicit height, and the `<td>` carries no padding. That is the fix for two faults
     * that were the same fault: the div used to be `h-full`, a percentage height against
     * a table cell the browser has not sized yet, so it collapsed onto its own TEXT. The
     * active ring therefore traced the text rather than the cell (it read as a small
     * floating rectangle inside the borders), and an EMPTY cell had no box at all — which
     * is precisely why an empty REMARKS cell could not be clicked, let alone typed into.
     * `inset-0` fills the cell whether it holds text or nothing, so the ring lands on the
     * cell's own border and every cell has a hit area.
     */
    const renderCell = (
        col: DeliveryCol,
        colIndex: number,
        navRow: number,
        body: React.ReactNode,
        opts: { rail?: string; tint?: string; title?: string; muted?: boolean } = {},
    ) => {
        const isFrozen = colIndex < frozenCount;
        const isActive = activeCell?.row === navRow && activeCell?.col === colIndex;
        const isEditingThis = isActive && edit.isEditing;
        const canEdit = addressable(navRow, colIndex);
        const exists = cellExists(navRow, colIndex);
        const invalid = invalidCells.has(`${rowKeyOf(navRow)}:${col.key}`);
        const selected = exists && cellSelection.isSelected(navRow, colIndex);
        const navKind = navRows[navRow]?.kind;
        const cellH = navKind === 'sample' ? SAMPLE_ROW_H : ROW_H;
        // The row's horizontal rule. It has to be a CELL border — see ROW_RULE: under
        // `border-collapse: separate` a border on the `<tr>` is not painted at all.
        const rowRule = navKind ? ROW_RULE[navKind] : '';
        // ONE background class, chosen explicitly. Stacking `bg-*` utilities and hoping
        // is not a rule — Tailwind emits them in its own order, not the order they are
        // written, so which one won would be luck. Invalid outranks selected outranks
        // dirty: a cell the operator has to come back and fix must stay visible under
        // any other state.
        const cellTint = invalid ? 'bg-destructive/15' : selected ? SELECT_TINT : opts.tint;

        return (
            <td
                key={col.key}
                className={cn(
                    // Side-specific colour, so `ROW_RULE`'s `border-b-border/…` cannot
                    // land in the same tailwind-merge group and restyle this one.
                    'border-r border-r-border/30 p-0 align-middle',
                    // The horizontal rule, per row family. It rides here rather than on
                    // the `<tr>` because `border-collapse: separate` paints cell borders
                    // only — and it must reach the FROZEN cells too, which are the ones
                    // that look most broken without it. They are opaque (`bg-background`
                    // / `bg-muted`), so the border paints cleanly on them; it runs along
                    // the bottom edge and `.frozen-edge`'s inset RIGHT border + shadow is
                    // a different edge, so the two never fight.
                    rowRule,
                    // `relative` only when the cell is not already a containing block:
                    // `.frozen-col` is `position: sticky`, which is one, and layering a
                    // `relative` on top of it would fight the CSS that pins the column.
                    !isFrozen && 'relative',
                    // Frozen cells repaint OPAQUELY — a solid theme token, never glass —
                    // because they sit ON TOP of scrolling content. Any alpha and the
                    // moving cells bleed through them. Every tint therefore rides on the
                    // INNER div, above this opaque base, rather than replacing it.
                    isFrozen && 'frozen-col bg-background group-hover:bg-muted',
                    isFrozen && colIndex === frozenCount - 1 && 'frozen-edge',
                    opts.rail,
                )}
                style={{ height: cellH, ...(isFrozen ? { left: frozenLeft[colIndex] } : {}) }}
                title={opts.title}
                onContextMenu={(e) => {
                    const nav = navRows[navRow];
                    if (!nav) return;
                    e.preventDefault();
                    const deliveryId = nav.kind === 'draft' ? '' : nav.deliveryId;
                    const rec = deliveryId ? recordsById.get(deliveryId) : undefined;
                    menu.open(
                        {
                            deliveryId,
                            draftId: nav.kind === 'draft' ? nav.draftId : undefined,
                            sampleIndex: nav.kind === 'sample' ? nav.sampleIndex : undefined,
                            sampleCount: rec?.row.sample_count ?? 0,
                        },
                        e.clientX,
                        e.clientY,
                    );
                }}
            >
                {isEditingThis ? (
                    <div className="absolute inset-0">
                        {renderEditor({ row: navRow, col: colIndex }, col.numeric ? 'right' : 'left')}
                    </div>
                ) : (
                    <div
                        tabIndex={-1}
                        className={cn(
                            CELL_BASE,
                            col.numeric && 'justify-end font-mono tabular-nums',
                            opts.muted && 'text-muted-foreground/60',
                            cellTint,
                            invalid && 'text-destructive',
                            // The active ring sits at z-20 so it clears `.frozen-col`
                            // (z-10) — otherwise a frozen cell paints over its own ring.
                            isActive && 'z-20 ring-2 ring-primary ring-inset',
                            canEdit ? 'cursor-cell' : 'cursor-default',
                        )}
                        onMouseDown={(e) => {
                            if (!exists || e.button !== 0) return;
                            e.preventDefault();
                            // Shift+click EXTENDS the range and leaves the caret where it
                            // was — the anchor is the thing being measured from.
                            cellSelection.handleCellMouseDown(navRow, colIndex, e);
                            if (!e.shiftKey) {
                                setActiveCell(canEdit ? { row: navRow, col: colIndex } : null);
                            }
                            // Same reason as `onAfterMove`: a bare `focus()` re-centres
                            // this wrapper in every scrollable ancestor, so clicking a
                            // cell used to jolt the page too.
                            gridRef.current?.focus({ preventScroll: true });
                        }}
                        onMouseEnter={() => cellSelection.handleCellMouseEnter(navRow, colIndex)}
                        onDoubleClick={(e) => {
                            if (!canEdit) return;
                            e.stopPropagation();
                            cellSelection.clearSelection();
                            edit.startEditing({ row: navRow, col: colIndex });
                        }}
                    >
                        {body}
                    </div>
                )}
            </td>
        );
    };

    // ── A delivery row's cells ───────────────────────────────────────────────────
    const deliveryCells = (item: Extract<LedgerItem, { kind: 'delivery' }>) => {
        const { rec, navRow, num: rowNum } = item;
        const row = rec.row;
        const id = row.id ?? '';
        const rowEdits = edits[id] ?? {};
        const issues = rowIssues(row);
        const isDup = issues.includes('duplicate');
        // `dup` is the importer's ACCUSATION (22 rows). `dupBadge` is the DATA's answer
        // (44 rows) — it also fires on the 22 unflagged originals, which is the whole
        // point of the pairing columns. Ranked below `duplicate` and above `unmapped`
        // only in the sense that an accused row keeps its full rose rail.
        const dupBadge = duplicateBadge(row);
        const rail = railClass(
            isDup
                ? 'duplicate'
                : issues.includes('unmapped')
                  ? 'unmapped'
                  : issues.includes('flagged')
                    ? 'flagged'
                    : dupBadge
                      ? 'twin'
                      : 'none',
        );
        const flags = readImportFlags(row.import_flags);
        const dirtyTint = (f: DeliveryField) => (rowEdits[f] !== undefined ? DIRTY_TINT : undefined);
        const pendingMoney = rowEdits.wt !== undefined || rowEdits.price !== undefined;

        return cols.map((col, ci) => {
            const field = col.field;

            switch (col.key) {
                case 'num':
                    return renderCell(
                        col, ci, navRow,
                        <span className="w-full text-center font-mono text-[10px] font-bold text-muted-foreground">{rowNum}</span>,
                        { rail },
                    );

                case 'date': {
                    // A plain text cell on the SAME edit path as every other column —
                    // type-over, F2, double-click, Escape. The loose text an operator
                    // types (`6/27`) is normalised to `yyyy-MM-dd` on commit, in
                    // `validateOnCommit`; what is on screen is always what will be
                    // stored, and text that cannot be read is refused rather than
                    // silently turned into some other day.
                    const value = rowEdits.delivery_date ?? row.delivery_date ?? '';
                    const undated = !row.delivery_date && !!row.delivery_date_raw;
                    return renderCell(
                        col, ci, navRow,
                        <span className="flex w-full min-w-0 items-center gap-1">
                            <span className="truncate font-mono text-xs font-bold">{value || dash}</span>
                            {undated && <AlertTriangle className="size-3 shrink-0 text-amber-500" />}
                        </span>,
                        {
                            tint: dirtyTint('delivery_date'),
                            title: undated ? `The workbook wrote: ${row.delivery_date_raw}` : undefined,
                        },
                    );
                }

                case 'truck':
                    return renderCell(
                        col, ci, navRow,
                        <span className="truncate font-mono text-xs font-bold">{rowEdits.truck_no ?? row.truck_no ?? ''}</span>,
                        { tint: dirtyTint('truck_no') },
                    );

                case 'supplier': {
                    const text = rowEdits.supplier ?? formatSupplierCell(row);
                    return renderCell(
                        col, ci, navRow,
                        <span className="flex w-full min-w-0 items-center gap-1">
                            <span className="truncate font-mono text-xs font-bold">{text || dash}</span>
                            {dupBadge && (
                                <DuplicatePeerPopover
                                    badge={dupBadge}
                                    recordsById={recordsById}
                                    placeById={placeById}
                                    canViewPrices={canViewPrices}
                                    onGoTo={goToReceipt}
                                    onShowPairs={() => setIssue('duplicate')}
                                    inPairLens={issue === 'duplicate'}
                                />
                            )}
                            {row.supplier_unresolved && (
                                <span className={cn(BADGE, 'shrink-0 bg-amber-500/20 text-amber-700 dark:text-amber-400')}>MAP?</span>
                            )}
                            {flags.length > 0 && <FlagPopover flags={flags} />}
                        </span>,
                        { tint: dirtyTint('supplier'), title: text },
                    );
                }

                case 'sacks':
                    return renderCell(
                        col, ci, navRow,
                        <span className="text-xs font-bold">{rowEdits.sacks ?? formatInt(row.sacks) ?? ''}</span>,
                        { tint: dirtyTint('sacks') },
                    );

                case 'wt': {
                    const pending = rowEdits.wt;
                    let body: React.ReactNode;
                    if (pending === undefined) {
                        body = <span className="text-xs font-bold">{formatKg(row.net_weight_kg) || dash}</span>;
                    } else {
                        const parsed = parseWeightInput(pending);
                        body =
                            'error' in parsed ? (
                                <span className="truncate text-xs font-bold">{pending}</span>
                            ) : (
                                <span className="text-xs font-bold">{formatKg(parsed.netKg) || dash}</span>
                            );
                    }
                    return renderCell(col, ci, navRow, body, {
                        tint: dirtyTint('wt'),
                        title: weightTitle(row, pending),
                    });
                }

                case 'bd':
                case 'moist':
                case 'grit':
                case 'ash':
                case 'dust':
                case 'vm':
                case 'fc': {
                    const f = field as DeliveryField;
                    const dp = labDecimals(f);
                    const pending = rowEdits[f];
                    const stored = row[f as 'bd' | 'moisture_pct' | 'grit' | 'ash' | 'dust' | 'vm' | 'fc'];
                    return renderCell(
                        col, ci, navRow,
                        <span className="text-xs font-bold">{pending ?? formatLab(stored, dp) ?? ''}</span>,
                        { tint: dirtyTint(f) },
                    );
                }

                case 'whse': {
                    const text = rowEdits.destination ?? formatDestinationCell(row);
                    return renderCell(
                        col, ci, navRow,
                        <span className="flex w-full min-w-0 items-center gap-1">
                            <span className="truncate font-mono text-xs font-bold">{text || dash}</span>
                            {row.destination_unresolved && (
                                <span className={cn(BADGE, 'shrink-0 bg-amber-500/20 text-amber-700 dark:text-amber-400')}>MAP?</span>
                            )}
                        </span>,
                        { tint: dirtyTint('destination'), title: text },
                    );
                }

                case 'remarks': {
                    const text = rowEdits.remarks ?? row.remarks ?? '';
                    return renderCell(
                        col, ci, navRow,
                        <span className="max-w-[200px] truncate text-xs">{text}</span>,
                        { tint: dirtyTint('remarks'), title: text || undefined },
                    );
                }

                case 'php_kg': {
                    const pending = rowEdits.price;
                    let value: number | null;
                    if (pending === undefined) value = num(row.price_php_kg);
                    else {
                        const parsed = parsePriceInput(pending);
                        value = 'error' in parsed ? null : parsed.effectivePhpKg;
                    }
                    return renderCell(
                        col, ci, navRow,
                        // Accounting format: ₱ pinned left, the figure pinned right.
                        <span className="flex w-full items-center justify-between gap-1 text-xs font-bold">
                            <span className="text-muted-foreground/70">₱</span>
                            <span>{value === null ? (pending ?? '') : formatRate(value)}</span>
                        </span>,
                        { tint: dirtyTint('price'), title: priceTitle(row, pending) },
                    );
                }

                case 'ttl':
                    return renderCell(
                        col, ci, navRow,
                        <span
                            className={cn(
                                'flex w-full items-center justify-between gap-1 text-xs font-bold',
                                pendingMoney && 'italic opacity-45',
                            )}
                        >
                            <span className="text-muted-foreground/70">₱</span>
                            <span>{formatPeso(row.total_price_php) || '0.00'}</span>
                        </span>,
                        {
                            muted: !pendingMoney && row.sheet_total_matches === false,
                            title: pendingMoney
                                ? 'Stale — this is the stored total. TTL PRICE is a database-generated column and is recomputed on save, never in the browser.'
                                : row.sheet_total_matches === false
                                  ? `The workbook printed ₱${formatPeso(row.sheet_total_php)} for this row.`
                                  : undefined,
                        },
                    );

                default:
                    return renderCell(col, ci, navRow, null);
            }
        });
    };

    // ── A sample sub-row's cells ─────────────────────────────────────────────────
    const sampleCells = (item: Extract<LedgerItem, { kind: 'sample' }>) => {
        const drafts = samplesOf(item.deliveryId);
        const draft = drafts[item.sampleIndex];
        const isDirty = sampleDrafts[item.deliveryId] !== undefined;
        const tint = isDirty ? 'bg-amber-500/[0.08]' : undefined;

        return cols.map((col, ci) => {
            const sf = sampleFieldFor(col.field);
            const isFirstFrozen = ci === 0;

            if (sf === null) {
                return renderCell(
                    col, ci, item.navRow,
                    isFirstFrozen ? <span className="w-full text-center text-[10px] text-muted-foreground/40">└</span> : null,
                    { tint },
                );
            }
            if (sf === 'label') {
                return renderCell(
                    col, ci, item.navRow,
                    <span className="flex w-full min-w-0 items-center gap-1 pl-3">
                        <span className="shrink-0 text-[10px] text-muted-foreground/40">└</span>
                        <span className="truncate font-mono text-[11px] text-muted-foreground">
                            {draft?.label || <span className="text-muted-foreground/40">unlabelled draw</span>}
                        </span>
                    </span>,
                    { tint, title: draft?.label },
                );
            }
            return renderCell(
                col, ci, item.navRow,
                <span className="font-mono text-[11px] tabular-nums text-muted-foreground">
                    {draft?.[sf] ?? ''}
                </span>,
                { tint },
            );
        });
    };

    // ── A draft row's cells (the blank rows at the bottom) ───────────────────────
    //
    // Deliberately the plainest renderer in the file: a draft holds nothing but the text
    // the operator has typed, so there is no stored value to format, no formula to
    // evaluate and — above all — no money to show. TTL PRICE is a database-generated
    // column; a blank row has no total until the database says so.
    const draftCells = (item: Extract<LedgerItem, { kind: 'draft' }>) => {
        const e = draftEdits[item.draftId] ?? {};

        return cols.map((col, ci) => {
            const field = col.field;

            if (col.key === 'num') {
                return renderCell(
                    col, ci, item.navRow,
                    <span className="w-full text-center font-mono text-[11px] leading-none text-muted-foreground/35">+</span>,
                    { rail: 'shadow-[inset_2px_0_0_0_var(--color-border)]' },
                );
            }
            if (field === null) {
                // TTL PRICE on an unsaved row — an em dash, not a zero. A zero would be a
                // claim about a total the database has not computed yet.
                return renderCell(col, ci, item.navRow, col.key === 'ttl' ? dash : null);
            }

            const text = e[field] ?? draftCanonical(field);
            // "Typed" means there is something here, not merely that a key exists — a
            // cell the operator cleared should go back to looking untouched.
            const typed = text.trim() !== '';
            return renderCell(
                col, ci, item.navRow,
                <span
                    className={cn(
                        'truncate text-xs',
                        field !== 'remarks' && 'font-mono',
                        // The seeded date is a suggestion, not an entry — it reads muted
                        // until the operator makes it theirs.
                        e[field] === undefined ? 'text-muted-foreground/40' : 'font-bold',
                    )}
                >
                    {/* The two formula lanes keep their round-trip here too: the formula
                        while the cell has focus (that text IS the cell's value), the
                        figure it evaluates to once the operator leaves — so a row typed
                        into a blank reads exactly like the receipt above it. */}
                    {draftDisplayText(field, text)}
                </span>,
                { tint: typed ? DIRTY_TINT : undefined },
            );
        });
    };

    // ── Chrome rows (day header, Σ DAY TOTAL, the "add rows" control) ────────────
    //
    // `spanAll` is honest for the two rows that really do cover everything. The SUMMARY
    // rows do not: each of their figures belongs on a particular column, so their spans
    // come from `summarySpans(cols)` — read off the column table rather than counted
    // against its length. See the note above it in `types.ts`.
    const spanAll = cols.length;
    const spans = React.useMemo(() => summarySpans(cols), [cols]);

    const chromeRow = (item: LedgerItem): React.ReactNode => {
        if (item.kind === 'add-rows') {
            return (
                <td colSpan={spanAll} className="h-8 border-b border-border/40 bg-muted/20 px-2 py-1">
                    <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                        <button
                            type="button"
                            onMouseDown={(ev) => ev.stopPropagation()}
                            onClick={() => addDraftRows(addCount)}
                            className="rounded border border-border/60 px-1.5 py-0.5 font-medium text-foreground transition-colors duration-150 hover:bg-muted"
                        >
                            Add
                        </button>
                        <input
                            value={addCount}
                            inputMode="numeric"
                            aria-label="How many blank rows to add"
                            onMouseDown={(ev) => ev.stopPropagation()}
                            onChange={(ev) => setAddCount(ev.target.value.replace(/[^\d]/g, ''))}
                            onKeyDown={(ev) => {
                                if (ev.key === 'Enter') {
                                    ev.preventDefault();
                                    addDraftRows(addCount);
                                }
                            }}
                            className="h-5 w-14 rounded border border-border/60 bg-background px-1 text-center font-mono text-[11px] outline-none focus:border-primary"
                        />
                        <span>more rows at the bottom</span>
                    </div>
                </td>
            );
        }
        if (item.kind === 'day') {
            return (
                <td colSpan={spanAll} className={DAY_HEADER_CELL}>
                    <span className="font-mono text-[11px] font-bold uppercase tracking-wide text-muted-foreground">
                        {item.label}
                        <span className="ml-2 font-normal normal-case text-muted-foreground/60">
                            {item.count} receipt{item.count === 1 ? '' : 's'}
                        </span>
                    </span>
                </td>
            );
        }
        // Σ DAY TOTAL. Four lanes, each sized off the column table: the label runs up to
        // WT, the net-kg figure sits ON WT, the duplicate note fills WT→TTL PRICE, and
        // the ₱ cell exists exactly when the TTL PRICE column does. A zero span means
        // the lane has no column, and its cell is not rendered — `colSpan={0}` is "to the
        // end of the column group" in HTML, which is the opposite of nothing.
        const t = item as Extract<LedgerItem, { kind: 'day-total' }>;
        return (
            <>
                <td colSpan={spans.label} className={cn(DAY_TOTAL_CELL, 'px-2')}>
                    <span className="font-mono text-[11px] font-bold uppercase tracking-wide">Σ Day total</span>
                </td>
                {spans.weight > 0 && (
                    <td
                        colSpan={spans.weight}
                        className={cn(DAY_TOTAL_CELL, 'px-2 text-right font-mono text-[11px] font-bold tabular-nums')}
                    >
                        {formatKg(t.netKg)}
                    </td>
                )}
                {spans.note > 0 && (
                    <td colSpan={spans.note} className={cn(DAY_TOTAL_CELL, 'px-2')}>
                        {t.dupNetKg > 0 && (
                            <span className="font-mono text-[10px] font-medium text-rose-600 dark:text-rose-400">
                                includes {formatKg(t.dupNetKg)} kg
                                {canViewPrices ? ` / ₱${formatPeso(t.dupPhp)}` : ''} from suspected duplicates
                            </span>
                        )}
                    </td>
                )}
                {/* The CELL follows the column (so the row always tiles); the FIGURE
                    keeps its own `canViewPrices` gate, belt and braces. The two agree by
                    construction — `buildColumns` omits TTL PRICE for a gated viewer. */}
                {spans.total > 0 && (
                    <td colSpan={spans.total} className={cn(DAY_TOTAL_CELL, 'px-2')}>
                        {canViewPrices && (
                            <span className="flex w-full items-center justify-between gap-1 font-mono text-[11px] font-bold tabular-nums">
                                <span className="text-muted-foreground/70">₱</span>
                                <span>{formatPeso(t.php ?? 0)}</span>
                            </span>
                        )}
                    </td>
                )}
                {/* 0 columns today. It exists so a column appended past TTL PRICE is
                    COVERED rather than leaving this row one short of the data rows. */}
                {spans.trailing > 0 && <td colSpan={spans.trailing} className={DAY_TOTAL_CELL} />}
            </>
        );
    };

    // ── Header ───────────────────────────────────────────────────────────────────
    //
    // The header is sticky and sits ON TOP of scrolling rows, so it stays FULLY OPAQUE
    // (`bg-muted`, no alpha, no backdrop-blur) — the frozen-pane rule, the opposite of
    // the glass rule the popovers follow. An active filter is marked with an inset
    // bottom bar rather than a translucent wash, for the same reason.
    //
    // The filter trigger takes real horizontal space rather than overlaying the label:
    // an overlay would sit exactly where a right-aligned numeric header's text is. It
    // goes on the LEFT of a numeric column (whose label hugs the right edge) and on the
    // RIGHT of a text one, so it never covers the label in either family.
    //
    // The header's own bottom rule is on the `<th>`, not the `<tr>` — same reason as
    // ROW_RULE: `border-collapse: separate` paints cell borders only, so the `border-b`
    // this row used to carry was inert and the header ran straight into the first
    // receipt. Full-weight `border-border` (not the body's /30), because this is the
    // header↔body boundary rather than another row division.
    const headerRow = (
        <tr>
            {cols.map((col, ci) => {
                const filterable = isFilterableColumn(col);
                const active = filters[col.key] !== undefined;
                const trigger = filterable ? (
                    <ColumnFilterPopover
                        col={col}
                        value={filters[col.key] ?? null}
                        dimensions={dimensions}
                        period={period}
                        contextYear={fallbackYear}
                        onApply={(next) => setColumnFilter(col.key, next)}
                    />
                ) : null;

                return (
                    <th
                        key={col.key}
                        title={col.title}
                        className={cn(
                            'h-8 border-b border-r border-b-border border-r-border/40 bg-muted px-2 align-middle text-[10px] font-bold uppercase tracking-wide text-muted-foreground',
                            col.numeric ? 'text-right' : 'text-left',
                            ci < frozenCount ? 'frozen-corner' : '',
                            ci === frozenCount - 1 && 'frozen-edge',
                            active && 'text-primary shadow-[inset_0_-2px_0_0_var(--color-primary)]',
                        )}
                        style={ci < frozenCount ? { left: frozenLeft[ci] } : undefined}
                    >
                        {filterable ? (
                            <span className="flex w-full items-center gap-1">
                                {col.numeric && trigger}
                                <span className={cn('min-w-0 flex-1 truncate', col.numeric ? 'text-right' : 'text-left')}>
                                    {col.label}
                                </span>
                                {!col.numeric && trigger}
                            </span>
                        ) : (
                            col.label
                        )}
                    </th>
                );
            })}
        </tr>
    );

    const colGroup = (
        <colgroup>
            {cols.map((c) => (
                <col key={c.key} style={{ width: `${c.width}px` }} />
            ))}
        </colgroup>
    );

    // ── Row wrapper (shared by both containers) ──────────────────────────────────
    //
    // NO `border-b` here, deliberately. Under `border-collapse: separate` a border on a
    // `<tr>` is never painted — the row's horizontal rule lives on the `<td>` (`ROW_RULE`,
    // applied in `renderCell`). Re-adding one here would be inert AND would split the
    // weight table across two files.
    const rowClassFor = (item: LedgerItem): string => {
        if (item.kind === 'delivery') {
            const dirty = dirtyIds.has(item.rec.row.id ?? '');
            const dup = item.rec.row.is_suspected_duplicate;
            return cn(
                'group transition-colors duration-150 hover:bg-muted',
                dup && 'bg-rose-500/[0.05]',
                dirty && 'bg-amber-500/[0.07]',
            );
        }
        if (item.kind === 'sample') return 'group bg-muted/20 transition-colors duration-150 hover:bg-muted/40';
        if (item.kind === 'draft') {
            return cn(
                'group bg-muted/[0.15] transition-colors duration-150 hover:bg-muted/40',
                dirtyDraftIds.has(item.draftId) && 'bg-amber-500/[0.07]',
            );
        }
        return '';
    };

    const rowHeightFor = (item: LedgerItem): number | undefined => {
        if (item.kind === 'delivery' || item.kind === 'draft') return ROW_H;
        if (item.kind === 'sample') return SAMPLE_ROW_H;
        return undefined;
    };

    const renderItemCells = (item: LedgerItem): React.ReactNode => {
        if (item.kind === 'delivery') return <>{deliveryCells(item)}</>;
        if (item.kind === 'sample') return <>{sampleCells(item)}</>;
        if (item.kind === 'draft') return <>{draftCells(item)}</>;
        return chromeRow(item);
    };

    // ── Virtuoso plumbing (endless only) ─────────────────────────────────────────
    const ctx = React.useMemo<LedgerCtx>(
        // `captureScroller` is stable (empty deps), so it needs no dep entry of its own.
        () => ({ minWidth, rowClassFor, rowHeightFor, colGroup, onScroller: captureScroller }),
        // `rowClassFor`/`rowHeightFor` close over dirty state, so the context must be
        // re-made when that changes — virtuoso re-renders visible rows off it.
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [minWidth, dirtyIds, dirtyDraftIds, cols],
    );

    // Open on the NEWEST RECEIPT, not on the last blank row — the run of drafts sits
    // below it, one scroll away, exactly as Sheets puts them.
    const initialTop = React.useRef<number | undefined>(undefined);
    if (initialTop.current === undefined && scope === 'endless') {
        let lastReal = 0;
        for (let i = items.length - 1; i >= 0; i--) {
            if (items[i].kind === 'delivery' || items[i].kind === 'sample') {
                lastReal = i;
                break;
            }
        }
        initialTop.current = anchor.kind === 'latest' ? lastReal : 0;
    }

    // ── Empty / error ────────────────────────────────────────────────────────────
    const isEmpty = items.length === 0;

    // ═══ Render ══════════════════════════════════════════════════════════════════
    return (
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
            {/* Toolbar — the ONE surface in this screen that animates. */}
            <div className="flex flex-wrap items-center gap-2 border-b bg-background/95 px-3 py-2 backdrop-blur supports-backdrop-filter:bg-background/60">
                <ScopeToggle scope={scope} onChange={setScope} pending={isPending} />

                {scope === 'focus' && period && (
                    <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                            <Button variant="outline" size="sm" className="h-6 gap-1 px-2 text-[11px]">
                                {periodLabel(period)}
                            </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="start" className="max-h-72 overflow-y-auto bg-popover/95 backdrop-blur-lg">
                            {monthKeys
                                .slice()
                                .reverse()
                                .map((k) => {
                                    const p = parsePeriodKey(k);
                                    return (
                                        <DropdownMenuItem
                                            key={k}
                                            onSelect={() => setPeriodParam(k)}
                                            className={cn(
                                                'font-mono text-[11px]',
                                                period && periodKey(period) === k && 'font-bold text-primary',
                                            )}
                                        >
                                            {p ? periodLabel(p) : k}
                                        </DropdownMenuItem>
                                    );
                                })}
                        </DropdownMenuContent>
                    </DropdownMenu>
                )}

                <div className="flex items-center gap-1">
                    {ISSUE_LENSES.map((lens) => (
                        <button
                            key={lens}
                            type="button"
                            title={ISSUE_HINTS[lens]}
                            onClick={() => setIssue(issue === lens ? null : lens)}
                            className={cn(
                                'h-6 rounded-md border px-2 text-[11px] font-medium transition-colors duration-150',
                                issue === lens
                                    ? 'border-transparent bg-zinc-800 text-zinc-50 dark:bg-zinc-200 dark:text-zinc-900'
                                    : 'border-border/60 text-muted-foreground hover:text-foreground',
                            )}
                        >
                            {ISSUE_LABELS[lens]}
                        </button>
                    ))}
                </div>

                <div className="relative">
                    <Search className="pointer-events-none absolute left-2 top-1/2 size-3 -translate-y-1/2 text-muted-foreground/60" />
                    <Input
                        value={searchText}
                        onChange={(e) => setSearchText(e.target.value)}
                        onBlur={commitSearch}
                        onKeyDown={(e) => {
                            if (e.key === 'Enter') commitSearch();
                        }}
                        placeholder="Supplier, truck, permit, remarks…"
                        className="h-6 w-56 pl-7 text-[11px]"
                    />
                    {searchText && (
                        <button
                            type="button"
                            aria-label="Clear search"
                            // Emptying the box is local and always safe (it may be text
                            // that was never committed). Dropping `?q=` is the axis
                            // change, and if the operator cancels that, the box goes back
                            // to the search still running — never an empty box over a
                            // filtered ledger.
                            onClick={() => {
                                setSearchText('');
                                requestAxisChange((sp) => sp.delete('q'), {
                                    onCancelled: () => setSearchText(query),
                                });
                            }}
                            className="absolute right-1.5 top-1/2 -translate-y-1/2 text-muted-foreground/60 hover:text-foreground"
                        >
                            <X className="size-3" />
                        </button>
                    )}
                </div>

                <div className="ml-auto flex items-center gap-2">
                    {/* The count is the SERVER's, over the whole matching set — never
                        `records.length`, which in the endless scope is only the loaded
                        window and would under-report a filtered ledger by hundreds. */}
                    {matchCount !== null && (
                        <span className="font-mono text-[11px] text-muted-foreground">
                            {matchCount.toLocaleString('en-US')} {narrowed ? 'matching' : ''} receipt
                            {matchCount === 1 ? '' : 's'}
                        </span>
                    )}
                    {isPending && <Loader2 className="size-3 animate-spin text-muted-foreground" />}
                    {!canViewPrices && (
                        <span className="rounded-md border border-border/60 px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
                            ₱ hidden for your role
                        </span>
                    )}
                    {dirtyCount > 0 && (
                        <span className="animate-fade-in rounded-md bg-amber-500/15 px-2 py-0.5 font-mono text-[11px] font-bold text-amber-700 dark:text-amber-400">
                            {dirtyCount} unsaved
                        </span>
                    )}
                    <Button
                        size="sm"
                        className="h-6 gap-1 px-2 text-[11px]"
                        disabled={dirtyCount === 0 || saving}
                        onClick={() => void handleSave()}
                    >
                        {saving ? <Loader2 className="size-3 animate-spin" /> : <Save className="size-3" />}
                        Save
                    </Button>
                </div>
            </div>

            {/* Active filters, spelled out — one chip per filtered column plus a single
                Clear all. A filter that only shows as a mark in a header thirty columns
                to the right is a filter an operator forgets is on, and then reads the
                sheet as if it were the whole ledger. */}
            {filterCount > 0 && (
                <div className="flex flex-wrap items-center gap-1.5 border-b bg-muted/25 px-3 py-1.5">
                    <span className="text-[10px] font-bold uppercase tracking-wide text-muted-foreground">
                        Filtered
                    </span>
                    {activeFilters.map((key) => {
                        const col = cols.find((c) => c.key === key) ?? FILTER_COLUMNS.find((c) => c.key === key);
                        const filter = filters[key];
                        if (!col || !filter) return null;
                        return (
                            <span
                                key={key}
                                className="animate-fade-in inline-flex items-center gap-1 rounded-md border border-primary/40 bg-primary/10 py-0.5 pl-2 pr-1 text-[11px] font-medium text-foreground"
                            >
                                {describeFilter(col, filter)}
                                <button
                                    type="button"
                                    aria-label={`Clear the ${col.label} filter`}
                                    onClick={() => setColumnFilter(key, null)}
                                    className="rounded-sm text-muted-foreground transition-colors duration-150 hover:text-foreground"
                                >
                                    <X className="size-3" />
                                </button>
                            </span>
                        );
                    })}
                    <button
                        type="button"
                        onClick={clearAllFilters}
                        className="ml-1 rounded-md border border-border/60 px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground transition-colors duration-150 hover:text-foreground"
                    >
                        Clear all
                    </button>
                </div>
            )}

            {loadError && (
                <div className="flex items-start gap-2 border-b border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
                    <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
                    <span className="flex-1">{loadError}</span>
                    <button
                        type="button"
                        className="shrink-0 rounded border border-destructive/40 px-1.5 py-0.5 text-[10px] font-medium"
                        onClick={() => {
                            void navigator.clipboard.writeText(loadError).then(() => toast.success('Error copied'));
                        }}
                    >
                        Copy
                    </button>
                </div>
            )}

            {isEmpty ? (
                <div className="flex flex-1 flex-col items-center justify-center gap-2 p-8 text-center">
                    <Inbox className="size-8 text-muted-foreground/30" />
                    <p className="text-sm text-muted-foreground">
                        {win.notice ?? 'No receipts match the current view.'}
                    </p>
                    {/* The focus month and a DATE filter AND together, so a filter that
                        misses the month is a legal query returning nothing — which reads
                        as a broken screen unless it says which of the two to widen. */}
                    {dateFilterMissesPeriod(filters, period) && scope === 'focus' && period && (
                        <p className="max-w-md text-xs text-muted-foreground/80">
                            The DATE filter falls entirely outside {periodLabel(period)}. Widen it, clear it, or
                            pick the month it covers.
                        </p>
                    )}
                    {filterCount > 0 && (
                        <button
                            type="button"
                            onClick={clearAllFilters}
                            className="rounded-md border border-border/60 px-2 py-0.5 text-[11px] font-medium text-muted-foreground transition-colors duration-150 hover:text-foreground"
                        >
                            Clear {filterCount} filter{filterCount === 1 ? '' : 's'}
                        </button>
                    )}
                </div>
            ) : (
                <div
                    ref={gridRef}
                    tabIndex={-1}
                    className="relative min-h-0 flex-1 select-none outline-none"
                    onKeyDown={onGridKeyDown}
                    onPaste={onGridPaste}
                    onBlur={(e) => {
                        if (!e.currentTarget.contains(e.relatedTarget)) setActiveCell(null);
                    }}
                >
                    {scope === 'endless' ? (
                        <>
                            {win.loadingOlder && <EdgeSpinner where="top" label="Loading earlier receipts…" />}
                            <TableVirtuoso
                                ref={virtuosoRef}
                                data={items}
                                context={ctx}
                                computeItemKey={(_i, item) => item.key}
                                firstItemIndex={win.firstItemIndex}
                                initialTopMostItemIndex={initialTop.current}
                                startReached={() => void win.fetchOlder()}
                                endReached={() => void win.fetchNewer()}
                                increaseViewportBy={{ top: 400, bottom: 400 }}
                                components={TABLE_COMPONENTS}
                                fixedHeaderContent={() => headerRow}
                                itemContent={(_i, item) => renderItemCells(item)}
                                style={{ height: '100%' }}
                            />
                            {win.loadingNewer && <EdgeSpinner where="bottom" label="Loading later receipts…" />}
                        </>
                    ) : (
                        <div ref={scrollerRef} className="h-full overflow-auto">
                            <table
                                className="relative table-fixed text-xs"
                                style={{ width: '100%', minWidth, borderCollapse: 'separate', borderSpacing: 0 }}
                            >
                                {colGroup}
                                <thead className="frozen-row bg-muted" style={{ zIndex: 20 }}>
                                    {headerRow}
                                </thead>
                                <tbody>
                                    {items.map((item) => (
                                        <tr
                                            key={item.key}
                                            // Focus renders real rows, so `scrollTo` finds
                                            // one by its own key rather than by a position
                                            // that shifts under it.
                                            data-item-key={item.key}
                                            className={rowClassFor(item)}
                                            style={{ height: rowHeightFor(item) }}
                                        >
                                            {renderItemCells(item)}
                                        </tr>
                                    ))}
                                </tbody>
                                <tfoot>
                                    <tr style={{ height: 34 }}>
                                        {/* Bottom-LEFT corner: sticky-left AND sticky-bottom, so it
                                            out-ranks both the frozen column (z-10) and the footer row
                                            (z-20) at z-30. `spans.frozen` is `frozenOffsets(cols).length`
                                            — the SAME walk that produces the `left` offsets — so the
                                            corner covers exactly the pinned block and can never overhang
                                            into scrolling territory. The four lanes after it are the day
                                            total's, minus the corner splitting off the front. */}
                                        <td
                                            colSpan={spans.frozen}
                                            className={cn(MONTH_FOOTER_CELL, 'frozen-corner-bottom frozen-edge')}
                                            style={{ left: frozenLeft[0] }}
                                        >
                                            <span className="font-mono text-[11px] font-bold uppercase tracking-wide">
                                                Σ {period ? periodLabel(period) : 'Month'} · {monthTotals.count} receipts
                                            </span>
                                        </td>
                                        {spans.spacer > 0 && <td colSpan={spans.spacer} className={MONTH_FOOTER_CELL} />}
                                        {spans.weight > 0 && (
                                            <td colSpan={spans.weight} className={cn(MONTH_FOOTER_CELL, 'text-right font-mono text-[11px] font-bold tabular-nums')}>
                                                {formatKg(monthTotals.netKg)}
                                            </td>
                                        )}
                                        {spans.note > 0 && (
                                            <td colSpan={spans.note} className={MONTH_FOOTER_CELL}>
                                                {monthTotals.dupCount > 0 && (
                                                    <span className="font-mono text-[10px] font-medium text-rose-600 dark:text-rose-400">
                                                        {monthTotals.dupCount} suspected duplicate{monthTotals.dupCount === 1 ? '' : 's'} included —
                                                        {' '}{formatKg(monthTotals.dupNetKg)} kg
                                                        {canViewPrices ? ` / ₱${formatPeso(monthTotals.dupPhp)}` : ''}
                                                    </span>
                                                )}
                                            </td>
                                        )}
                                        {spans.total > 0 && (
                                            <td colSpan={spans.total} className={MONTH_FOOTER_CELL}>
                                                {canViewPrices && (
                                                    <span className="flex w-full items-center justify-between gap-1 font-mono text-[11px] font-bold tabular-nums">
                                                        <span className="text-muted-foreground/70">₱</span>
                                                        <span>{formatPeso(monthTotals.php)}</span>
                                                    </span>
                                                )}
                                            </td>
                                        )}
                                        {spans.trailing > 0 && <td colSpan={spans.trailing} className={MONTH_FOOTER_CELL} />}
                                    </tr>
                                </tfoot>
                            </table>
                        </div>
                    )}
                </div>
            )}

            <GridContextMenu state={menu.state} items={menuItems} onClose={menu.close} />

            {/* The unsaved-work guard. Raised only by `requestAxisChange`, and only when
                the Save button is lit — the counts below and its `disabled` read the same
                number, so this dialog cannot appear over an empty sheet.

                `AlertDialogContent` already carries the project's dialog glass
                (`bg-background/95 backdrop-blur-xl supports-[backdrop-filter]:bg-background/80`)
                and `animate-modal-enter`; they are not repeated here, and nothing in the
                grid beneath animates. */}
            <AlertDialog
                open={axisPromptOpen}
                onOpenChange={(o) => {
                    // Esc / outside-click / Cancel all land here and mean "stay put".
                    // Ignored mid-save: the RPCs are in flight and the answer is not
                    // known yet.
                    if (!o && !saving) cancelAxisChange();
                }}
            >
                <AlertDialogContent>
                    <AlertDialogHeader>
                        <AlertDialogTitle>Changing the view will discard unsaved work</AlertDialogTitle>
                        <AlertDialogDescription asChild>
                            <div className="space-y-2">
                                <p>
                                    You have{' '}
                                    <span className="font-semibold text-foreground">
                                        {describeUnsavedWork(unsaved)}
                                    </span>{' '}
                                    on this sheet.
                                </p>
                                <p>
                                    A filter, lens, month, scope or search change reloads the ledger from the
                                    database. Anything not saved is gone — edited receipts go back to their stored
                                    values, and typed new rows are lost entirely.
                                </p>
                            </div>
                        </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                        <AlertDialogCancel disabled={saving}>Cancel — stay here</AlertDialogCancel>
                        <Button
                            variant="outline"
                            disabled={saving}
                            onClick={discardAndContinue}
                            className="border-destructive/50 text-destructive hover:bg-destructive/10 hover:text-destructive"
                        >
                            Discard {unsaved.total} change{unsaved.total === 1 ? '' : 's'}
                        </Button>
                        <Button disabled={saving} onClick={() => void saveAndContinue()} className="gap-1">
                            {saving ? <Loader2 className="size-3.5 animate-spin" /> : <Save className="size-3.5" />}
                            Save and continue
                        </Button>
                    </AlertDialogFooter>
                </AlertDialogContent>
            </AlertDialog>

            <AlertDialog open={deleteTarget !== null} onOpenChange={(o) => !o && setDeleteTarget(null)}>
                <AlertDialogContent>
                    <AlertDialogHeader>
                        <AlertDialogTitle>Delete this receipt?</AlertDialogTitle>
                        <AlertDialogDescription>
                            {deleteTarget ? rowLabel(deleteTarget) : ''} and its
                            {' '}{deleteTarget?.samples.length ?? 0} moisture draw
                            {(deleteTarget?.samples.length ?? 0) === 1 ? '' : 's'} will be removed. This cannot be undone,
                            and the row&apos;s import provenance goes with it.
                        </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                        <AlertDialogCancel>Keep it</AlertDialogCancel>
                        <AlertDialogAction
                            onClick={() => void handleDelete()}
                            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                        >
                            Delete receipt
                        </AlertDialogAction>
                    </AlertDialogFooter>
                </AlertDialogContent>
            </AlertDialog>
        </div>
    );
}

// ═══ Sub-components ═════════════════════════════════════════════════════════════

function ScopeToggle({
    scope,
    onChange,
    pending,
}: {
    scope: Scope;
    onChange: (s: Scope) => void;
    pending: boolean;
}) {
    const wrap = 'inline-flex h-6 items-center rounded-md border border-border/60 bg-background p-0.5';
    const active = 'bg-zinc-800 text-zinc-50 dark:bg-zinc-200 dark:text-zinc-900';
    const idle = 'text-muted-foreground hover:text-foreground';
    return (
        <div className={wrap} role="tablist" aria-label="Receipt history scope">
            <button
                type="button"
                role="tab"
                aria-selected={scope === 'endless'}
                onClick={() => onChange('endless')}
                title="Endless — the whole history as one continuous, cursor-guided sheet"
                className={cn(
                    'flex h-5 items-center gap-1 rounded px-2 text-[11px] font-medium transition-colors duration-150',
                    scope === 'endless' ? active : idle,
                )}
            >
                <InfinityIcon className="size-3" />
                Endless
            </button>
            <button
                type="button"
                role="tab"
                aria-selected={scope === 'focus'}
                onClick={() => onChange('focus')}
                title="Focus — one month, day-grouped, with day totals and a month footer"
                className={cn(
                    'flex h-5 items-center gap-1 rounded px-2 text-[11px] font-medium transition-colors duration-150',
                    scope === 'focus' ? active : idle,
                )}
            >
                <Crosshair className="size-3" />
                Focus
            </button>
            {pending && <Loader2 className="ml-1 mr-0.5 size-3 animate-spin text-muted-foreground" />}
        </div>
    );
}

// ═══ Per-column filters ═════════════════════════════════════════════════════════
//
// One control per filterable column, shaped by the column's own `filterKind`:
//
//   set        SUPPLIER · WAREHOUSE          checkbox list + type-ahead
//   text       TRK# · REMARKS                case-insensitive contains
//   range      BD MOIST GRIT ASH DUST VM FC  min / max
//   dateRange  DATE                          from / to
//
// SKS, WT, PHP/KG and TTL PRICE offer nothing — they carry no `filterKind`.
//
// The dimension lists come from `fetchDeliveryDimensions()` (12 traders, 16 yards),
// NOT from the loaded rows. Deriving them from what happens to be on screen would let
// the operator filter only by the values the pager had already fetched — the same class
// of lie as filtering the window instead of the query.
//
// Every popover EDITS A DRAFT and applies on Apply / Enter. Applying rewrites the URL,
// which remounts the ledger against a server-fetched window, so a control that wrote
// per-keystroke would be a server round trip per keystroke.

function ColumnFilterPopover({
    col,
    value,
    dimensions,
    period,
    contextYear,
    onApply,
}: {
    col: DeliveryCol;
    value: ColumnFilter | null;
    dimensions: DeliveryDimensions;
    period: DeliveryPeriod | null;
    contextYear: number;
    onApply: (next: ColumnFilter | null) => void;
}) {
    const [open, setOpen] = React.useState(false);
    const active = value !== null;

    return (
        <Popover open={open} onOpenChange={setOpen}>
            <PopoverTrigger asChild>
                <button
                    // Marks this as chrome the GRID does not own, so Enter/Space here
                    // opens the filter instead of opening the selected cell for editing.
                    data-grid-chrome=""
                    type="button"
                    aria-label={`Filter ${col.label}${active ? ' (filter active)' : ''}`}
                    onMouseDown={(e) => e.stopPropagation()}
                    className={cn(
                        'shrink-0 rounded-sm p-0.5 transition-colors duration-150',
                        active
                            ? 'text-primary'
                            : 'text-muted-foreground/45 hover:bg-foreground/10 hover:text-foreground',
                    )}
                >
                    <ListFilter className="size-3" />
                </button>
            </PopoverTrigger>
            <PopoverContent
                data-grid-chrome=""
                align={col.numeric ? 'start' : 'end'}
                className="w-64 bg-popover/95 p-2 backdrop-blur-lg"
            >
                <ColumnFilterEditor
                    // Re-seeded from the URL every time it opens, so a popover the
                    // operator abandoned never carries a stale draft into the next visit.
                    key={String(open)}
                    col={col}
                    initial={value}
                    dimensions={dimensions}
                    period={period}
                    contextYear={contextYear}
                    onApply={(next) => {
                        setOpen(false);
                        onApply(next);
                    }}
                />
            </PopoverContent>
        </Popover>
    );
}

const FILTER_LABEL = 'text-[10px] font-bold uppercase tracking-wide text-muted-foreground';
const FILTER_INPUT = 'h-6 text-[11px]';

function ColumnFilterEditor({
    col,
    initial,
    dimensions,
    period,
    contextYear,
    onApply,
}: {
    col: DeliveryCol;
    initial: ColumnFilter | null;
    dimensions: DeliveryDimensions;
    period: DeliveryPeriod | null;
    contextYear: number;
    onApply: (next: ColumnFilter | null) => void;
}) {
    // ── SET (SUPPLIER · WAREHOUSE) ───────────────────────────────────────────────
    const options = React.useMemo(() => {
        if (col.filterKind !== 'set') return [];
        const rows =
            col.key === 'supplier'
                ? dimensions.suppliers.map((s) => ({ code: s.code ?? '', name: s.display_name ?? '' }))
                : dimensions.destinations.map((d) => ({ code: d.code ?? '', name: d.display_name ?? '' }));
        return rows.filter((r) => r.code !== '');
    }, [col.filterKind, col.key, dimensions]);

    const [picked, setPicked] = React.useState<Set<string>>(
        () => new Set(initial?.kind === 'set' ? initial.values : []),
    );
    const [needle, setNeedle] = React.useState('');
    const shown = React.useMemo(() => {
        const n = needle.trim().toUpperCase();
        if (!n) return options;
        return options.filter((o) => o.code.toUpperCase().includes(n) || o.name.toUpperCase().includes(n));
    }, [options, needle]);

    // ── TEXT / RANGE / DATE ──────────────────────────────────────────────────────
    const [text, setText] = React.useState(initial?.kind === 'text' ? initial.text : '');
    const [lo, setLo] = React.useState(() => {
        if (initial?.kind === 'range') return initial.min === null ? '' : String(initial.min);
        if (initial?.kind === 'dateRange') return initial.from ?? '';
        return '';
    });
    const [hi, setHi] = React.useState(() => {
        if (initial?.kind === 'range') return initial.max === null ? '' : String(initial.max);
        if (initial?.kind === 'dateRange') return initial.to ?? '';
        return '';
    });

    const commit = () => {
        switch (col.filterKind) {
            case 'set':
                onApply(picked.size > 0 ? { kind: 'set', values: [...picked] } : null);
                return;
            case 'text': {
                const t = text.trim();
                onApply(t ? { kind: 'text', text: t } : null);
                return;
            }
            case 'range': {
                const min = lo.trim() === '' ? null : Number(lo);
                const max = hi.trim() === '' ? null : Number(hi);
                const bad = [
                    ['minimum', lo, min] as const,
                    ['maximum', hi, max] as const,
                ].filter(([, raw, n]) => raw.trim() !== '' && (n === null || !Number.isFinite(n)));
                if (bad.length > 0) {
                    errorToast(`The ${col.label} filter needs numbers.`, {
                        description: bad.map(([which, raw]) => `The ${which} reads “${raw}”.`).join('\n'),
                    });
                    return;
                }
                onApply(min === null && max === null ? null : { kind: 'range', min, max });
                return;
            }
            case 'dateRange': {
                const read = (raw: string, which: string): string | null | 'bad' => {
                    if (!raw.trim()) return null;
                    // Same transcription the DATE cell uses, same context year — `4/6`
                    // typed into a filter and into a cell must mean the same day.
                    const parsed = parseDeliveryDate(raw, contextYear);
                    if ('error' in parsed) {
                        errorToast(`The ${which} of the DATE filter could not be read.`, {
                            description: `You typed: ${raw}\n\n${parsed.error}`,
                        });
                        return 'bad';
                    }
                    return parsed.iso;
                };
                const from = read(lo, 'start');
                if (from === 'bad') return;
                const to = read(hi, 'end');
                if (to === 'bad') return;
                onApply(from === null && to === null ? null : { kind: 'dateRange', from, to });
                return;
            }
            default:
                onApply(null);
        }
    };

    const onKeyDown = (e: React.KeyboardEvent) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            commit();
        }
    };

    return (
        <div className="flex flex-col gap-1.5">
            <p className={FILTER_LABEL}>Filter {col.label}</p>

            {col.filterKind === 'set' && (
                <>
                    <Input
                        autoFocus
                        value={needle}
                        onChange={(e) => setNeedle(e.target.value)}
                        onKeyDown={onKeyDown}
                        placeholder="Type to narrow…"
                        className={FILTER_INPUT}
                    />
                    <div className="max-h-56 overflow-y-auto rounded border border-border/50">
                        {shown.length === 0 ? (
                            <p className="px-2 py-1.5 text-[11px] text-muted-foreground">Nothing matches.</p>
                        ) : (
                            shown.map((o) => {
                                const on = picked.has(o.code);
                                return (
                                    // ONE interactive element per option, not a checkbox
                                    // nested in a label: a Radix checkbox is a <button>,
                                    // not a native input, so a wrapping <label> would
                                    // render the option's own TEXT dead to the click.
                                    <button
                                        key={o.code}
                                        type="button"
                                        role="checkbox"
                                        aria-checked={on}
                                        onClick={() =>
                                            setPicked((prev) => {
                                                const s = new Set(prev);
                                                if (on) s.delete(o.code);
                                                else s.add(o.code);
                                                return s;
                                            })
                                        }
                                        className="flex w-full items-center gap-1.5 px-1.5 py-1 text-left transition-colors duration-150 hover:bg-muted"
                                    >
                                        <span
                                            aria-hidden
                                            className={cn(
                                                'grid size-3.5 shrink-0 place-content-center rounded-[3px] border',
                                                on ? 'border-primary bg-primary text-primary-foreground' : 'border-input',
                                            )}
                                        >
                                            {on && <Check className="size-3" />}
                                        </span>
                                        <span className="min-w-0 flex-1 truncate font-mono text-[11px]">{o.code}</span>
                                        {o.name && o.name !== o.code && (
                                            <span className="min-w-0 shrink truncate text-[10px] text-muted-foreground/70">
                                                {o.name}
                                            </span>
                                        )}
                                    </button>
                                );
                            })
                        )}
                    </div>
                    <p className="text-[10px] text-muted-foreground/70">
                        {picked.size === 0 ? 'Nothing picked — the column is unfiltered.' : `${picked.size} picked`}
                    </p>
                </>
            )}

            {col.filterKind === 'text' && (
                <>
                    <Input
                        autoFocus
                        value={text}
                        maxLength={60}
                        onChange={(e) => setText(e.target.value)}
                        onKeyDown={onKeyDown}
                        placeholder={`Contains…`}
                        className={FILTER_INPUT}
                    />
                    <p className="text-[10px] text-muted-foreground/70">
                        Matches anywhere in the cell, upper or lower case.
                    </p>
                </>
            )}

            {col.filterKind === 'range' && (
                <>
                    <div className="flex items-center gap-1">
                        <Input
                            autoFocus
                            value={lo}
                            inputMode="decimal"
                            aria-label={`${col.label} minimum`}
                            onChange={(e) => setLo(e.target.value)}
                            onKeyDown={onKeyDown}
                            placeholder="min"
                            className={cn(FILTER_INPUT, 'font-mono')}
                        />
                        <span className="text-[11px] text-muted-foreground">–</span>
                        <Input
                            value={hi}
                            inputMode="decimal"
                            aria-label={`${col.label} maximum`}
                            onChange={(e) => setHi(e.target.value)}
                            onKeyDown={onKeyDown}
                            placeholder="max"
                            className={cn(FILTER_INPUT, 'font-mono')}
                        />
                    </div>
                    <p className="text-[10px] text-muted-foreground/70">
                        Leave either side blank for an open end. Rows with no {col.label} reading are excluded.
                    </p>
                </>
            )}

            {col.filterKind === 'dateRange' && (
                <>
                    <div className="flex items-center gap-1">
                        <Input
                            autoFocus
                            value={lo}
                            aria-label="From date"
                            onChange={(e) => setLo(e.target.value)}
                            onKeyDown={onKeyDown}
                            placeholder="from"
                            className={cn(FILTER_INPUT, 'font-mono')}
                        />
                        <span className="text-[11px] text-muted-foreground">→</span>
                        <Input
                            value={hi}
                            aria-label="To date"
                            onChange={(e) => setHi(e.target.value)}
                            onKeyDown={onKeyDown}
                            placeholder="to"
                            className={cn(FILTER_INPUT, 'font-mono')}
                        />
                    </div>
                    <p className="text-[10px] leading-snug text-muted-foreground/70">
                        {`6/27, 6/27/26 and 2026-06-27 all work; a bare day-and-month takes ${contextYear}. `}
                        {period
                            ? `In focus it narrows WITHIN ${periodLabel(period)}. `
                            : ''}
                        A receipt with no date is never inside a date range.
                    </p>
                </>
            )}

            <div className="mt-0.5 flex items-center justify-between gap-2">
                <button
                    type="button"
                    onClick={() => onApply(null)}
                    className="rounded border border-border/60 px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground transition-colors duration-150 hover:text-foreground"
                >
                    Clear
                </button>
                <Button size="sm" className="h-6 px-2 text-[11px]" onClick={commit}>
                    Apply
                </Button>
            </div>
        </div>
    );
}

// ─── The duplicate-pair popover ──────────────────────────────────────────────────
//
// Renzo's question, verbatim: "for suspected duplicates, it would be nice to see which
// rows it is duping. So that we know its actually a dupe with an exact copy of a row."
//
// The badge answers the first half — `DUP 2/2` on the flagged paste, `TWIN 1/2` on the
// original it was pasted from. This popover answers the second: it NAMES the peer with
// the five fields a human compares (date · truck · supplier · net kg · ₱ total) and
// offers to jump to it.
//
// Same structure and styling as `FlagPopover` above. Glass is correct here — a popover
// floats over empty space, unlike the frozen cells underneath it, which must stay
// opaque or the scrolling rows bleed through them.
function DuplicatePeerPopover({
    badge,
    recordsById,
    placeById,
    canViewPrices,
    onGoTo,
    onShowPairs,
    inPairLens,
}: {
    badge: DuplicateBadge;
    recordsById: Map<string, DeliveryRecord>;
    placeById: Map<string, { num: number; navRow: number; key: string }>;
    canViewPrices: boolean;
    onGoTo: (id: string) => boolean;
    onShowPairs: () => void;
    inPairLens: boolean;
}) {
    const isCopy = badge.role === 'copy';
    return (
        <Popover>
            <PopoverTrigger asChild>
                <button
                    // A cell-level control the grid does not own: Enter here opens the
                    // popover rather than opening the cell underneath it for editing.
                    data-grid-chrome=""
                    type="button"
                    title={badge.title}
                    aria-label={badge.title}
                    onMouseDown={(e) => e.stopPropagation()}
                    className={cn(
                        BADGE,
                        'shrink-0 cursor-pointer',
                        isCopy
                            ? 'bg-rose-500/15 text-rose-600 hover:bg-rose-500/25 dark:text-rose-400'
                            : 'border border-rose-500/35 text-rose-600/80 hover:bg-rose-500/10 dark:text-rose-400/80',
                    )}
                >
                    {badge.label}
                </button>
            </PopoverTrigger>
            <PopoverContent align="start" className="w-[22rem] bg-popover/95 p-2 backdrop-blur-lg">
                <p className="mb-1 text-[10px] font-bold uppercase tracking-wide text-muted-foreground">
                    {badge.ordinal !== null && badge.size !== null
                        ? `Copy ${badge.ordinal} of ${badge.size}`
                        : 'Flagged as a duplicate'}
                </p>
                <p className="mb-2 text-[11px] leading-snug text-muted-foreground">{badge.title}</p>

                {badge.peerIds.length === 0 ? (
                    <p className="text-[11px] leading-snug text-muted-foreground">
                        Nothing to compare it with — no exact twin is left in the ledger.
                    </p>
                ) : (
                    <ul className="space-y-1.5">
                        {badge.peerIds.map((peerId) => {
                            const peer = recordsById.get(peerId);
                            const place = placeById.get(peerId);
                            if (!peer) {
                                // The peer is outside the loaded window. Say so plainly
                                // rather than fetching it behind the operator's back —
                                // and offer the lens that is guaranteed to load both.
                                return (
                                    <li key={peerId} className="text-[11px] leading-snug">
                                        <span className="block text-muted-foreground">
                                            Its twin is not in the loaded window.
                                        </span>
                                        {!inPairLens && (
                                            <button
                                                type="button"
                                                onClick={onShowPairs}
                                                className="mt-1 inline-flex items-center gap-1 rounded border border-border/60 px-1.5 py-0.5 text-[10px] font-medium transition-colors duration-150 hover:bg-muted"
                                            >
                                                <CornerDownRight className="size-3" />
                                                Show every duplicate pair
                                            </button>
                                        )}
                                    </li>
                                );
                            }
                            const r = peer.row;
                            return (
                                <li key={peerId} className="rounded border border-border/60 p-1.5 text-[11px] leading-snug">
                                    <div className="flex items-baseline justify-between gap-2">
                                        <span className="font-mono font-bold text-foreground">
                                            {r.delivery_date ?? r.delivery_date_raw ?? 'undated'}
                                        </span>
                                        {place && (
                                            <span className="shrink-0 font-mono text-[10px] text-muted-foreground/70">
                                                row {place.num}
                                            </span>
                                        )}
                                    </div>
                                    <div className="font-mono text-[11px] text-muted-foreground">
                                        {r.truck_no || '—'} · {formatSupplierCell(r) || 'unknown supplier'}
                                    </div>
                                    <div className="mt-0.5 flex items-baseline justify-between gap-2 font-mono text-[11px] tabular-nums text-muted-foreground">
                                        <span>{formatKg(r.net_weight_kg) || '—'} kg</span>
                                        {/* ₱ only for a viewer who may see it. The row was
                                            already nulled server-side; this is the belt. */}
                                        {canViewPrices && <span>₱{formatPeso(r.total_price_php) || '0.00'}</span>}
                                    </div>
                                    {place && (
                                        <button
                                            type="button"
                                            onClick={() => onGoTo(peerId)}
                                            className="mt-1.5 inline-flex items-center gap-1 rounded border border-border/60 px-1.5 py-0.5 text-[10px] font-medium transition-colors duration-150 hover:bg-muted"
                                        >
                                            <CornerDownRight className="size-3" />
                                            Go to row {place.num}
                                        </button>
                                    )}
                                </li>
                            );
                        })}
                    </ul>
                )}

                <p className="mt-2 border-t border-border/50 pt-1.5 text-[10px] leading-snug text-muted-foreground/70">
                    Pairing is re-derived from the receipt&apos;s own values, not from the importer&apos;s flag —
                    so editing either copy un-pairs them. Nothing here changes any data.
                </p>
            </PopoverContent>
        </Popover>
    );
}

function FlagPopover({ flags }: { flags: ReturnType<typeof readImportFlags> }) {
    return (
        <Popover>
            <PopoverTrigger asChild>
                <button
                    data-grid-chrome=""
                    type="button"
                    aria-label={`${flags.length} import flag${flags.length === 1 ? '' : 's'}`}
                    onMouseDown={(e) => e.stopPropagation()}
                    className="shrink-0 text-sky-500 hover:text-sky-600"
                >
                    <AlertTriangle className="size-3" />
                </button>
            </PopoverTrigger>
            <PopoverContent align="start" className="w-80 bg-popover/95 p-2 backdrop-blur-lg">
                <p className="mb-1.5 text-[10px] font-bold uppercase tracking-wide text-muted-foreground">
                    Import flags — kept, not fixed
                </p>
                <ul className="space-y-1.5">
                    {flags.map((f, i) => (
                        <li key={i} className="text-[11px] leading-snug">
                            <span className="font-mono font-bold text-foreground">{f.kind}</span>
                            <span className="block text-muted-foreground">{f.detail}</span>
                            {f.raw && (
                                <span className="block font-mono text-[10px] text-muted-foreground/70">
                                    workbook wrote: {f.raw}
                                </span>
                            )}
                        </li>
                    ))}
                </ul>
            </PopoverContent>
        </Popover>
    );
}

function EdgeSpinner({ where, label }: { where: 'top' | 'bottom'; label: string }) {
    return (
        <div
            className={cn(
                'pointer-events-none absolute inset-x-0 z-40 flex items-center justify-center gap-1.5 bg-muted/85 py-1 text-[11px] text-muted-foreground backdrop-blur-sm',
                where === 'top' ? 'top-0 border-b border-border/40' : 'bottom-0 border-t border-border/40',
            )}
        >
            <Loader2 className="size-3 animate-spin" />
            {label}
        </div>
    );
}

// ═══ Virtuoso table components (module level → stable identity) ═════════════════
//
// Virtuoso forwards the `context` prop to every component, and an object prop named
// `context` on a <div>/<thead> is an invalid DOM attribute — so it is stripped here
// rather than spread through.

interface LedgerCtx {
    minWidth: number;
    rowClassFor: (item: LedgerItem) => string;
    rowHeightFor: (item: LedgerItem) => number | undefined;
    colGroup: React.ReactNode;
    /**
     * Hands the scroller element back to the grid, which needs one in the endless scope
     * too. A CALLBACK rather than a ref object: the ledger owns the ref, and a component
     * may not write through a ref it received as a prop.
     */
    onScroller: (el: HTMLDivElement | null) => void;
}

const LedgerScroller = React.forwardRef<HTMLDivElement, React.ComponentProps<'div'> & { context?: LedgerCtx }>(
    function LedgerScroller({ style, context, ...props }, ref) {
        // Virtuoso owns this element's ref, and the grid needs the element as well (to
        // follow the caret sideways). So the two are merged rather than one replacing the
        // other — virtuoso's own scrolling would break if its ref were stolen.
        const onScroller = context?.onScroller;
        const setRef = React.useCallback(
            (el: HTMLDivElement | null) => {
                if (typeof ref === 'function') ref(el);
                else if (ref) ref.current = el;
                onScroller?.(el);
            },
            [ref, onScroller],
        );
        return <div ref={setRef} {...props} className="outline-none" style={{ overflowX: 'auto', ...style }} />;
    },
);

const LedgerTable = ({ style, children, context }: TableProps & { context?: LedgerCtx }) => (
    <table
        className="relative table-fixed text-xs"
        style={{ ...style, width: '100%', minWidth: context?.minWidth, borderCollapse: 'separate', borderSpacing: 0 }}
    >
        {context?.colGroup}
        {children}
    </table>
);

const LedgerTableHead = React.forwardRef<HTMLTableSectionElement, React.ComponentProps<'thead'> & { context?: unknown }>(
    function LedgerTableHead({ style, context: _ctx, ...props }, ref) {
        void _ctx;
        return <thead ref={ref} {...props} className="frozen-row bg-muted" style={{ ...style, zIndex: 20 }} />;
    },
);

const LedgerTableRow = ({ item, context, children, style, ...props }: ItemProps<LedgerItem> & { context?: LedgerCtx }) => (
    <tr {...props} style={{ ...style, height: context?.rowHeightFor(item) }} className={context?.rowClassFor(item)}>
        {children}
    </tr>
);

const TABLE_COMPONENTS: TableComponents<LedgerItem, LedgerCtx> = {
    Scroller: LedgerScroller,
    Table: LedgerTable,
    TableHead: LedgerTableHead,
    TableRow: LedgerTableRow,
};

// ═══ The nav resolver ═══════════════════════════════════════════════════════════

interface DeliveryNavGeometry {
    rowCount: number;
    lastCol: number;
    addressable: (row: number, col: number) => boolean;
}

/**
 * Per-CELL addressability, because a sample sub-row occupies only the label lane and
 * the seven lab lanes. Every branch answers "is there an addressable cell that way?"
 * and returns null (stay put) when there is not.
 *
 * The behavioural consequence is exactly the asymmetry the data already has: ArrowDown
 * in the WT lane walks receipt-to-receipt, stepping OVER the draws in between, while
 * ArrowDown in the MOIST lane walks through every draw — which is what a QC operator
 * reading down a moisture column actually wants.
 */
function createDeliveryNavResolver(geo: DeliveryNavGeometry): NavResolver<CoordinateId> {
    const { rowCount, lastCol, addressable } = geo;

    const rowStep = (row: number, col: number, dir: 1 | -1): number | null => {
        for (let r = row + dir; r >= 0 && r < rowCount; r += dir) {
            if (addressable(r, col)) return r;
        }
        return null;
    };

    /** Reading order: across the row, then on to the next. Skips inert cells. */
    const tabStep = (from: CoordinateId, dir: 1 | -1): CoordinateId | null => {
        let { row, col } = from;
        const limit = rowCount * (lastCol + 1) + (lastCol + 1);
        for (let guard = 0; guard < limit; guard++) {
            col += dir;
            if (col > lastCol) {
                row += 1;
                col = 0;
            } else if (col < 0) {
                row -= 1;
                col = lastCol;
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
            for (let col = from.col + dir; col >= 0 && col <= lastCol; col += dir) {
                if (addressable(from.row, col)) return { row: from.row, col };
            }
            return null;
        },
        laneOf: (id) => id.col,
        resolveInRow(from, lane, dir) {
            // The Enter-anchor lane may not exist on the next row (a WT lane over a run
            // of sample rows) — `rowStep` walks past them to the next row that has it.
            const col = typeof lane === 'number' ? lane : from.col;
            const row = rowStep(from.row, col, dir);
            return row === null ? null : { row, col };
        },
        isEditable: (id) => addressable(id.row, id.col),
    };
}

// ═══ Flattening ═════════════════════════════════════════════════════════════════

interface MonthTotals {
    count: number;
    netKg: number;
    php: number;
    dupCount: number;
    dupNetKg: number;
    dupPhp: number;
}

/**
 * Build the render list, the keyboard's row axis and the footer figures in ONE pass.
 *
 * The two summary figures are SUMS OF STORED COLUMNS (`net_weight_kg`,
 * `total_price_php` — both DB-generated, exact decimal), not arithmetic re-derived from
 * gross × deduction × rate. A rule-off line adds up the numbers already on screen; it
 * does not recompute them. The duplicate sub-total rides alongside because 22 receipts
 * in this dataset are pasted twice, and a total that silently includes them is worse
 * than no total at all.
 */
function flatten(
    records: DeliveryRecord[],
    samplesOf: (id: string) => SampleDraft[],
    scope: Scope,
    draftIds: readonly string[],
): { items: LedgerItem[]; navRows: NavRow[]; monthTotals: MonthTotals } {
    const items: LedgerItem[] = [];
    const navRows: NavRow[] = [];
    const totals: MonthTotals = { count: 0, netKg: 0, php: 0, dupCount: 0, dupNetKg: 0, dupPhp: 0 };

    // Counted once up front — a `filter` inside the row loop would make this quadratic.
    const dayCounts = new Map<string, number>();
    for (const r of records) {
        const d = r.row.delivery_date ?? '';
        dayCounts.set(d, (dayCounts.get(d) ?? 0) + 1);
    }

    let currentDay = '';
    let dayNet = 0;
    let dayPhp = 0;
    let dayDupNet = 0;
    let dayDupPhp = 0;
    let dayCount = 0;
    let rowNum = 0;

    const closeDay = () => {
        if (scope !== 'focus' || dayCount === 0) return;
        items.push({
            kind: 'day-total',
            key: `total:${currentDay}`,
            netKg: dayNet,
            php: dayPhp,
            dupNetKg: dayDupNet,
            dupPhp: dayDupPhp,
        });
        dayNet = 0;
        dayPhp = 0;
        dayDupNet = 0;
        dayDupPhp = 0;
        dayCount = 0;
    };

    for (const rec of records) {
        const row = rec.row;
        const id = row.id ?? '';
        const date = row.delivery_date ?? '';

        if (scope === 'focus' && date !== currentDay) {
            closeDay();
            currentDay = date;
            items.push({
                kind: 'day',
                key: `day:${date || 'undated'}`,
                label: date ? formatDayHeading(date) : 'Undated — the workbook’s date could not be read',
                count: dayCounts.get(date) ?? 0,
            });
        }

        rowNum++;
        const navRow = navRows.length;
        navRows.push({ kind: 'delivery', deliveryId: id });
        items.push({ kind: 'delivery', key: `d:${id}`, navRow, rec, num: rowNum });

        const net = num(row.net_weight_kg) ?? 0;
        const php = num(row.total_price_php) ?? 0;
        totals.count++;
        totals.netKg += net;
        totals.php += php;
        dayCount++;
        dayNet += net;
        dayPhp += php;
        if (row.is_suspected_duplicate) {
            totals.dupCount++;
            totals.dupNetKg += net;
            totals.dupPhp += php;
            dayDupNet += net;
            dayDupPhp += php;
        }

        const drafts = samplesOf(id);
        drafts.forEach((d, i) => {
            const sNav = navRows.length;
            navRows.push({ kind: 'sample', deliveryId: id, sampleIndex: i });
            items.push({ kind: 'sample', key: `s:${id}:${d.key}`, navRow: sNav, deliveryId: id, sampleIndex: i });
        });
    }
    closeDay();

    // ── The blank rows, and the control that makes more of them ──────────────────
    // Appended AFTER everything, and never counted in the totals — a row nobody has
    // typed into has no weight and no money, and a row somebody HAS typed into still has
    // none until the database computes it. `firstItemIndex` anchoring is untouched: it
    // only ever shifts on a PREPEND, and nothing here prepends.
    for (const draftId of draftIds) {
        const navRow = navRows.length;
        navRows.push({ kind: 'draft', draftId });
        items.push({ kind: 'draft', key: `n:${draftId}`, navRow, draftId });
    }
    if (draftIds.length > 0) items.push({ kind: 'add-rows', key: 'add-rows' });

    return { items, navRows, monthTotals: totals };
}

function formatDayHeading(iso: string): string {
    const d = parseISO(iso);
    return isValid(d) ? format(d, 'EEEE · yyyy-MM-dd').toUpperCase() : iso;
}

// ═══ Pure helpers ═══════════════════════════════════════════════════════════════

interface MenuRef {
    /** `''` on a draft row — a blank row has no receipt behind it yet. */
    deliveryId: string;
    draftId: string | undefined;
    sampleIndex: number | undefined;
    sampleCount: number;
}

// ── Draft row identity ──────────────────────────────────────────────────────────
//
// A monotonic counter rather than a random string: the keys are React keys AND the
// client half of the save contract, and two blank rows colliding would merge two
// operators' typing into one receipt.
const DRAFT_PREFIX = 'draft:';
let draftSeq = 0;

function makeDraftIds(n: number): string[] {
    return Array.from({ length: n }, () => `${DRAFT_PREFIX}${++draftSeq}`);
}

function isDraftKey(key: string): boolean {
    return key.startsWith(DRAFT_PREFIX);
}

/**
 * What a draft cell shows when it does NOT have focus. Only the two formula lanes differ
 * from the raw text: `=27045*88%` becomes the kilos it evaluates to, exactly as it does
 * on a stored row whose WT is dirty. Unparseable text is left verbatim — the operator's
 * typing is never replaced by a guess, and the save will refuse it by name.
 */
function draftDisplayText(field: DeliveryField, text: string): string {
    if (!text.trim()) return '';
    if (field === 'wt') {
        const parsed = parseWeightInput(text);
        return 'error' in parsed ? text : formatKg(parsed.netKg);
    }
    if (field === 'price') {
        const parsed = parsePriceInput(text);
        return 'error' in parsed ? text : formatRate(parsed.effectivePhpKg);
    }
    return text;
}

/** How a blank row is named in an error message, before it has an identity of its own. */
function draftLabel(edits: FieldEdits, defaultDate: string): string {
    const date = (edits.delivery_date ?? defaultDate).trim() || 'undated';
    const who = (edits.supplier ?? '').trim() || 'no supplier';
    const truck = (edits.truck_no ?? '').trim();
    return `new row ${date} · ${who}${truck ? ` · ${truck}` : ''}`;
}

/**
 * Is the focus/keydown/paste target a control the grid does NOT own?
 *
 * Two families: a real form field (the "add rows" counter), and anything explicitly
 * marked `data-grid-chrome` — today the column headers' filter buttons. Marking wins
 * over guessing: a header filter trigger is a `<button>`, which no tag test would
 * catch, and Enter on it must open the filter rather than open the selected CELL for
 * editing.
 */
function isGridChrome(target: EventTarget | null): boolean {
    const el = target as HTMLElement | null;
    if (!el || typeof el.tagName !== 'string') return false;
    const tag = el.tagName.toUpperCase();
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable === true) return true;
    return typeof el.closest === 'function' && el.closest('[data-grid-chrome]') !== null;
}

/** How a receipt is named in an error message — enough to find it in the sheet. */
function rowLabel(rec: DeliveryRecord): string {
    const r = rec.row;
    const date = r.delivery_date ?? r.delivery_date_raw ?? 'undated';
    const who = formatSupplierCell(r) || 'unknown supplier';
    const truck = r.truck_no ? ` · ${r.truck_no}` : '';
    return `${date} · ${who}${truck}`;
}

function toDrafts(samples: RcDeliverySampleRow[]): SampleDraft[] {
    return samples.map((s) => ({
        key: s.id ?? `p${s.position ?? 0}`,
        label: s.label ?? '',
        bd: s.bd === null || s.bd === undefined ? '' : String(s.bd),
        moisture_pct: s.moisture_pct === null || s.moisture_pct === undefined ? '' : String(s.moisture_pct),
        grit: s.grit === null || s.grit === undefined ? '' : String(s.grit),
        ash: s.ash === null || s.ash === undefined ? '' : String(s.ash),
        dust: s.dust === null || s.dust === undefined ? '' : String(s.dust),
        vm: s.vm === null || s.vm === undefined ? '' : String(s.vm),
        fc: s.fc === null || s.fc === undefined ? '' : String(s.fc),
    }));
}

/**
 * Are two draw blocks the same, draw for draw? The sample half of item 5: the presence
 * of a `sampleDrafts` entry is what marks a receipt dirty, so a lab value typed and then
 * escaped back would otherwise leave the row counted as unsaved forever. Compared by
 * VALUE rather than by identity because the reverted text is a fresh string.
 */
function sameDrafts(a: SampleDraft[], b: SampleDraft[]): boolean {
    if (a.length !== b.length) return false;
    return a.every((x, i) => {
        const y = b[i];
        return (
            x.key === y.key &&
            x.label === y.label &&
            x.bd === y.bd &&
            x.moisture_pct === y.moisture_pct &&
            x.grit === y.grit &&
            x.ash === y.ash &&
            x.dust === y.dust &&
            x.vm === y.vm &&
            x.fc === y.fc
        );
    });
}

function toSamplePayload(drafts: SampleDraft[]): SamplePayload[] {
    return drafts.map((d, i) => ({
        position: i + 1,
        label: d.label.trim() || null,
        bd: num(d.bd),
        moisture_pct: num(d.moisture_pct),
        grit: num(d.grit),
        ash: num(d.ash),
        dust: num(d.dust),
        vm: num(d.vm),
        fc: num(d.fc),
    }));
}

/** What a cell shows on FOCUS, when it has no unsaved text of its own. */
function canonicalEditText(rec: DeliveryRecord, field: DeliveryField): string {
    const r = rec.row;
    switch (field) {
        case 'delivery_date': return r.delivery_date ?? '';
        case 'truck_no': return r.truck_no ?? '';
        case 'supplier': return formatSupplierCell(r);
        case 'sacks': return formatInt(r.sacks);
        // The two formula cells: the stored formula, else one REBUILT from the stored
        // parts, else the plain number. This is what makes an imported row read exactly
        // like one typed this morning.
        case 'wt': return weightEditText(r);
        case 'price': return priceEditText(r);
        case 'destination': return formatDestinationCell(r);
        case 'remarks': return r.remarks ?? '';
        default: {
            const v = r[field as 'bd' | 'moisture_pct' | 'grit' | 'ash' | 'dust' | 'vm' | 'fc'];
            return v === null || v === undefined ? '' : String(v);
        }
    }
}

/** What a cell shows in DISPLAY mode — used by the TSV copy. */
function displayText(rec: DeliveryRecord, field: DeliveryField, showPrices: boolean): string {
    const r = rec.row;
    switch (field) {
        case 'delivery_date': return r.delivery_date ?? r.delivery_date_raw ?? '';
        case 'truck_no': return r.truck_no ?? '';
        case 'supplier': return formatSupplierCell(r);
        case 'sacks': return formatInt(r.sacks);
        case 'wt': return formatKg(r.net_weight_kg);
        case 'destination': return formatDestinationCell(r);
        case 'remarks': return r.remarks ?? '';
        case 'price': return showPrices ? formatRate(r.price_php_kg) : '';
        default: return formatLab(r[field as 'bd' | 'moisture_pct' | 'grit' | 'ash' | 'dust' | 'vm' | 'fc'], labDecimals(field));
    }
}

function weightTitle(row: DeliveryRecord['row'], pending: string | undefined): string {
    const source = pending ?? weightEditText(row);
    const parsed = parseWeightInput(source);
    if ('error' in parsed) return `${source} — ${parsed.error}`;
    if (parsed.deductionPct === null) return `${formatKg(parsed.netKg)} kg`;
    return `${formatKg(parsed.grossKg)} kg on the scale, less ${parsed.deductionPct}% ⇒ ${formatKg(parsed.netKg)} kg paid for`;
}

function priceTitle(row: DeliveryRecord['row'], pending: string | undefined): string {
    const source = pending ?? priceEditText(row);
    if (!source) return '';
    const parsed = parsePriceInput(source);
    if ('error' in parsed) return `${source} — ${parsed.error}`;
    if (parsed.adjustmentPhpKg === null) return `₱${formatRate(parsed.effectivePhpKg)}/kg`;
    return `₱${formatRate(parsed.basePhpKg)} base + ₱${formatRate(parsed.adjustmentPhpKg)} adjustment ⇒ ₱${formatRate(parsed.effectivePhpKg)}/kg`;
}

// ── Patch building ──────────────────────────────────────────────────────────────

/**
 * Turn a receipt's raw edit text into the allowlisted patch the RPC accepts.
 *
 * The two dimension cells and the two formula cells are the whole reason this is a
 * function and not an object spread: each one is ONE cell that becomes THREE columns,
 * and a value that does not resolve comes back as an `error` rather than being written
 * as an unresolved row. The import was allowed to leave a supplier NULL because it was
 * transcribing a workbook nobody can go back and ask about; a human typing today can be
 * asked, so this refuses instead.
 */
function buildPatch(
    fieldEdits: FieldEdits,
    supplierCodes: readonly string[],
    destinationCodes: readonly string[],
    canViewPrices: boolean,
): { patch: DeliveryPatch; errors: string[] } {
    const patch: DeliveryPatch = {};
    const errors: string[] = [];

    for (const [key, raw] of Object.entries(fieldEdits) as [DeliveryField, string][]) {
        const text = (raw ?? '').trim();

        switch (key) {
            case 'delivery_date':
                // The cell already normalised this on commit; the shape check is the LAST
                // gate before the RPC, and it is here because a cell can be left dirty
                // with unreadable text (that is the point — the operator's typing is
                // never thrown away) and Save must refuse rather than post it.
                if (!text) errors.push('a receipt entered in the app needs a date.');
                else if (!isIsoDate(text)) {
                    errors.push(`the date "${text}" could not be read — fix the DATE cell (6/27, 6/27/26 and 2026-06-27 all work).`);
                } else patch.delivery_date = text;
                break;

            case 'truck_no':
                patch.truck_no = text || null;
                break;

            case 'supplier': {
                if (!text) {
                    errors.push('the supplier cannot be cleared — a receipt with no payee cannot be liquidated.');
                    break;
                }
                const parsed = parseSupplierCell(text, supplierCodes);
                if ('error' in parsed) {
                    errors.push(parsed.error);
                    break;
                }
                patch.supplier_code = parsed.supplier_code;
                patch.supplier_origin = parsed.supplier_origin;
                patch.permit_no = parsed.permit_no;
                // The raw column is the operator's own words — rewrite it to what they
                // just typed so the row's audit trail matches the screen.
                patch.supplier_raw = text;
                break;
            }

            case 'destination': {
                if (!text) {
                    patch.destination_code = null;
                    patch.destination_side = null;
                    patch.destination_raw = null;
                    break;
                }
                const parsed = parseDestinationCell(text, destinationCodes);
                if ('error' in parsed) {
                    errors.push(parsed.error);
                    break;
                }
                patch.destination_code = parsed.destination_code;
                patch.destination_side = parsed.destination_side;
                patch.destination_raw = text;
                break;
            }

            case 'sacks': {
                if (!text) {
                    patch.sacks = null;
                    break;
                }
                const n = num(text);
                if (n === null || n < 0) errors.push(`"${text}" is not a sack count.`);
                else patch.sacks = Math.round(n);
                break;
            }

            case 'wt': {
                if (!text) {
                    patch.gross_weight_kg = null;
                    patch.deduction_pct = null;
                    patch.weight_formula = null;
                    break;
                }
                const parsed = parseWeightInput(text);
                if ('error' in parsed) {
                    errors.push(`WT "${text}" — ${parsed.error}`);
                    break;
                }
                // The DB derives `net_weight_kg` (and `total_price_php`) from these three.
                // Nothing here computes the net; a generated column cannot be written to.
                patch.gross_weight_kg = parsed.grossKg;
                patch.deduction_pct = parsed.deductionPct;
                patch.weight_formula = parsed.formula;
                break;
            }

            case 'price': {
                if (!canViewPrices) {
                    errors.push('your role cannot edit price data.');
                    break;
                }
                if (!text) {
                    patch.base_price_php_kg = null;
                    patch.price_adjustment_php_kg = null;
                    patch.price_formula = null;
                    break;
                }
                const parsed = parsePriceInput(text);
                if ('error' in parsed) {
                    errors.push(`PHP/KG "${text}" — ${parsed.error}`);
                    break;
                }
                patch.base_price_php_kg = parsed.basePhpKg;
                patch.price_adjustment_php_kg = parsed.adjustmentPhpKg;
                patch.price_formula = parsed.formula;
                break;
            }

            case 'remarks':
                patch.remarks = text || null;
                break;

            default: {
                // A lab column.
                if (!text) {
                    patch[key as 'bd'] = null;
                    break;
                }
                const n = num(text);
                if (n === null) errors.push(`${key.toUpperCase()} "${text}" is not a number.`);
                else patch[key as 'bd'] = n;
                break;
            }
        }
    }

    return { patch, errors };
}

// ── Paste bridge ────────────────────────────────────────────────────────────────
//
// `useGridPaste` thinks in rows of `{ field: value }`. This grid's edit state is a map
// keyed by receipt id, so the paste target is a synthetic row keyed by COLUMN INDEX —
// which also keeps two columns that edit the same nominal field distinct.

type PasteRow = Record<string, string>;

function pasteKey(colIndex: number): string {
    return `c${colIndex}`;
}

function readPasteRow(
    row: number,
    cols: DeliveryCol[],
    getCellText: (id: CoordinateId) => string,
): PasteRow {
    const out: PasteRow = {};
    for (let c = 0; c < cols.length; c++) {
        if (cols[c].field === null) continue;
        out[pasteKey(c)] = getCellText({ row, col: c });
    }
    return out;
}
