'use client';

import * as React from 'react';
import { TableVirtuoso, type TableComponents, type TableProps, type ItemProps, type TableVirtuosoHandle } from 'react-virtuoso';
import { useRouter, usePathname, useSearchParams } from 'next/navigation';
import { format, parseISO, isValid } from 'date-fns';
import { Loader2, Copy, Inbox, Lock, LockOpen, Save, X } from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
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
import { errorToast } from '@/lib/toast';
import { normalizeTypedDate } from '@/lib/paste-utils';
import { useAuth } from '@/components/providers/auth-context';
import { formatDateShort } from '@/components/shared/grid';
import { useCellSelection } from '@/lib/hooks/use-cell-selection';
import { useClipboardCopy } from '@/lib/hooks/use-clipboard-copy';
import { useCellDelete } from '@/lib/hooks/use-cell-delete';
import {
    useGridKeyboardNav,
    createCoordinateNavResolver,
    type NavResolver,
    type CoordinateId,
    type GridRangeSlot,
} from '@/lib/hooks/use-grid-keyboard-nav';
import { useGridEditSession } from '@/lib/hooks/use-grid-edit-session';
import { CenaproPeriodPicker } from './period-picker';
import { ViewModeSwitcher, ScopeToggle, useLedgerFilters } from './ledger-controls';
import { ColumnFilterMenu, FilterSummaryChip, FilteredEmptyState } from './column-filter-menu';
import {
    FILTER_SPECS,
    collectFilterPresence,
    describeActiveFilters,
    matchesLedgerFilters,
    mergeDiscoveredGroups,
    mergeDiscoveredOptions,
    type FilterColumn,
    type LedgerFilters,
} from './ledger-url';
import { useLedgerWindow, type InitialLedgerPage } from './use-ledger-window';
import { DraftRowCells, CommittedRowCells, DraftDatalists, type DraftCellCommonProps, type DraftCellSelProps } from './draft-entry-zone';
import { saveProductionEvents, type LedgerAnchor, type CenaproPeriod, type ProductionEventDirtyRow } from './actions';
import {
    BULK_COLUMN_MAP,
    BULK_COL_COUNT,
    createEmptyRow,
    isBlankRow,
    cleanBulkPasteValue,
    mapBulkRowToDirty,
    rowLabel,
    type BulkRow,
    type BulkField,
} from './bulk-paste-utils';
import type { ProductionEventRow } from '../types';
import {
    toGridRow,
    rowDirection,
    rowDirectionTint,
    rowDirectionFrozenTint,
    cccFlecBadgeClass,
    plantBadgeClass,
    BADGE_BASE,
    formatKg,
} from './production-ledger-grid';
import { formatCccFlec } from '../types';

// ─── The Endless Sheet (Phase 2A — in-list draft entry) ──────────────────────────
// ONE continuous, virtualized view of the ENTIRE cenapro_production_events history,
// oldest-first (recv_date ASC, id ASC), lazy-loaded bidirectionally with keyset
// pagination (fetchLedgerPage + useLedgerWindow + react-virtuoso's TableVirtuoso). The
// dropdown period picker is a JUMP-TO anchor. Read-only until UNLOCKED.
//
// DRAFT ENTRY (in-list "Google Sheets" model, refined 2026-07-21): when unlocked, a
// maintained pool of BLANK draft rows is appended below the last committed row IN THE
// SAME VIRTUAL LIST — you scroll DOWN into an effectively-infinite supply of them (top
// up on endReached). Blanks render through the SAME itemContent as committed rows, so
// columns line up. Draft data lives in a PARENT-OWNED `draftRows` array (keyed by
// position) — NEVER in row-local state — so virtuoso recycling an off-screen half-typed
// row never loses it (it rehydrates from the array). `firstItemIndex` (top prepend for
// older rows) and the bottom blank-append are orthogonal; appending blanks never touches
// firstItemIndex. Loss-proof: mirrored to localStorage; nothing (Escape/click-out/lock/
// reload/crash) can destroy a draft. Save → validate → saveProductionEvents → refreshNewest.

// Column geometry — mirrors the ledger's colgroup exactly (sum = MIN_W). The 4 leftmost
// identity columns are frozen (sticky-left) at cumulative offsets 0 / 36 / 132 / 228 —
// for COMMITTED rows only (draft cells are non-frozen editable inputs).
const COL_WIDTHS = [36, 96, 96, 120, 64, 80, 84, 108, 84, 104, 112, 72, 72];
const MIN_W = COL_WIDTHS.reduce((a, b) => a + b, 0); // 1228
const FROZEN_LEFT = [0, 36, 132, 228]; // #, recv, prod, batch
const ROW_H = 32;

// Draft blank-pool sizing. TWO orthogonal mechanisms keep the "infinite Google Sheet"
// feel without ever crushing the pool or running away:
//   1. MINIMUM-BUFFER MAINTENANCE (ensureBlankBuffer): keep ~BLANK_TARGET trailing blanks
//      past the last non-blank draft; top up when it drops below BLANK_TRIGGER. Runs on
//      the draftRows effect + on paste, so there are always blanks even before any scroll
//      and an Excel paste taller than the pool auto-extends. Idempotent (no-op once full).
//   2. SCROLL-GROWTH (appendBlankBatch, fired from atBottomStateChange): every time the
//      operator actually reaches the bottom, append a fresh BLANK_GROW_BATCH of blanks —
//      UNCONDITIONALLY, decoupled from the typed-content buffer above — so scrolling down
//      always reveals more rows, effectively unlimited. See handleAtBottomStateChange for
//      the anti-runaway guard.
const BLANK_TARGET = 25;
const BLANK_TRIGGER = 12;
// One "reached the bottom" gesture appends this many blanks. Sized comfortably taller than
// the bottom overscan (increaseViewportBy.bottom) so a single append pushes the list end
// well past the viewport — the operator must physically scroll again to trigger the next
// batch (see the atBottom guard), which is what makes runaway impossible.
const BLANK_GROW_BATCH = 25;

// localStorage key for the draft mirror — namespaced by surface + version + user id.
// v2 (Phase 3a): the shape grew from a bare draft array to `{ drafts, edits, deletes }`
// (drafts + pending committed inline-edits + pending committed deletions). The version
// bump means old v1 payloads live under a different key and are simply ignored (no
// migration needed — worst case a user loses a stale pre-3a draft backup on first load).
const DRAFT_STORAGE_VERSION = 'v2';
const draftStorageKey = (userId: string | null | undefined) => `cenapro-ledger-drafts:${DRAFT_STORAGE_VERSION}:${userId ?? 'anon'}`;

// Pending committed inline-edit — the FULL merged BulkRow of an edited committed row,
// keyed (in the parent-owned Map) by the row's stable event `id`. Storing the full row
// (not just the changed fields) makes the Save payload + the localStorage mirror
// self-contained: a pending edit survives the row scrolling out of the loaded window,
// a reload, or the base row not being loaded at all — it's addressed purely by id.
type CommittedEdit = BulkRow;

// The full localStorage mirror shape (v2).
interface StoredDraftState {
    drafts: BulkRow[];
    edits: [string, CommittedEdit][];
    deletes: string[];
}

// Best-effort BulkRow coercion for restore — fold each parsed object onto a fresh empty
// row so a missing/older key defaults to '' rather than undefined.
function coerceStoredRows(parsed: unknown): BulkRow[] {
    if (!Array.isArray(parsed)) return [];
    return parsed.map((r) => ({ ...createEmptyRow(), ...(r && typeof r === 'object' ? r : {}) }) as BulkRow);
}

// Coerce a stored v2 payload → the three pending structures. Tolerant of shape drift.
function coerceStoredState(parsed: unknown): { drafts: BulkRow[]; edits: Map<string, CommittedEdit>; deletes: Set<string> } {
    const empty = { drafts: [] as BulkRow[], edits: new Map<string, CommittedEdit>(), deletes: new Set<string>() };
    if (!parsed || typeof parsed !== 'object') return empty;
    const p = parsed as Partial<StoredDraftState>;
    const drafts = coerceStoredRows(p.drafts);
    const edits = new Map<string, CommittedEdit>();
    if (Array.isArray(p.edits)) {
        for (const entry of p.edits) {
            if (Array.isArray(entry) && typeof entry[0] === 'string' && entry[1] && typeof entry[1] === 'object') {
                edits.set(entry[0], { ...createEmptyRow(), ...(entry[1] as object) } as CommittedEdit);
            }
        }
    }
    const deletes = new Set<string>(Array.isArray(p.deletes) ? p.deletes.filter((x): x is string => typeof x === 'string') : []);
    return { drafts, edits, deletes };
}

// A committed ProductionEventRow → its 12-field BulkRow view (the merge/edit base).
function bulkFromCommitted(r: ProductionEventRow): BulkRow {
    const g = toGridRow(r);
    return {
        recv_date: g.recv_date,
        prod_date: g.prod_date,
        batch: g.batch,
        shift_code: g.shift_code,
        grade_code: g.grade_code,
        plant_code: g.plant_code,
        warehouse_code: g.warehouse_code,
        source_location_code: g.source_location_code,
        weight_kg: g.weight_kg,
        ccc_flec: g.ccc_flec,
        flec_count: g.flec_count,
        whse_side: g.whse_side,
    };
}

const BULK_FIELDS: BulkField[] = [
    'recv_date', 'prod_date', 'batch', 'shift_code', 'grade_code', 'plant_code',
    'warehouse_code', 'source_location_code', 'weight_kg', 'ccc_flec', 'flec_count', 'whse_side',
];

function bulkEqual(a: BulkRow, b: BulkRow): boolean {
    for (const f of BULK_FIELDS) if ((a[f] ?? '') !== (b[f] ?? '')) return false;
    return true;
}

function ColGroup() {
    return (
        <colgroup>
            {COL_WIDTHS.map((w, i) => (
                <col key={i} style={{ width: `${w}px` }} />
            ))}
        </colgroup>
    );
}

// ─── Virtuoso item model ─────────────────────────────────────────────────────────
// The virtuoso `data` = committed rows PLUS (only when unlocked) the trailing blank
// draft pool. A draft item carries ONLY its position (`draftIndex`) — its data is read
// from the parent-owned `draftRows` array (via the render context), keeping it recycle-safe.
type LedgerItem =
    | { kind: 'committed'; row: ProductionEventRow }
    | { kind: 'draft'; draftIndex: number };

// Render context passed to virtuoso — recreated each render so virtuoso re-renders
// visible items on any state change (activeCell/isEditing/draftRows/errors), which is
// what keeps the active ring + edited values current on non-virtualized-safe rows.
interface LedgerCtx {
    firstItemIndex: number;
    unlocked: boolean;
    committed: ProductionEventRow[];
    draftRows: BulkRow[];
    /** Pending committed inline-edits, keyed by event id (recycle- + prepend-safe). */
    editedRows: Map<string, CommittedEdit>;
    /** Committed rows marked for deletion, keyed by event id. */
    deletedIds: Set<string>;
    /** Validation-error highlight keys: `d:<draftIndex>` for drafts, `c:<id>` for committed. */
    errorKeys: Set<string>;
    commonCellProps: DraftCellCommonProps;
    selProps: (rowIdx: number, colIdx: number) => DraftCellSelProps;
    updateRow: (index: number, field: BulkField, value: string) => void;
    removeRow: (index: number) => void;
    onPaste: (e: React.ClipboardEvent, rowIdx: number, colIdx: number) => void;
    onCommitDate: (rowIdx: number, field: BulkField) => void;
}

function isMonthBoundary(prev: ProductionEventRow | undefined, cur: ProductionEventRow): boolean {
    const c = (cur.recv_date ?? '').slice(0, 7);
    if (!c) return false;
    if (!prev) return true;
    return (prev.recv_date ?? '').slice(0, 7) !== c;
}

function monthLabelOf(row: ProductionEventRow): string {
    const iso = row.recv_date ?? '';
    const d = parseISO(iso);
    return isValid(d) ? format(d, 'MMMM yyyy').toUpperCase() : iso;
}

const dash = <span className="text-muted-foreground/40">—</span>;

// ─── Read-only committed cell renderer (mirrors the ledger's display state) ───────
function renderCommittedCells(row: ProductionEventRow, rowNum: number, isMonthStart: boolean, monthLabel: string | null) {
    const g = toGridRow(row);
    const dir = rowDirection(g);
    const frozenTint = rowDirectionFrozenTint(dir);
    const frozenBase = cn('frozen-col bg-background group-hover:bg-muted transition-colors duration-150', frozenTint);
    const topBorder = isMonthStart ? 'border-t-2 border-t-primary/40' : '';

    return (
        <>
            <td
                className={cn(frozenBase, topBorder, 'border-r border-border/30 px-1 text-center align-middle font-mono text-[10px] font-bold text-muted-foreground')}
                style={{ left: FROZEN_LEFT[0], height: ROW_H }}
            >
                {rowNum}
            </td>
            <td
                className={cn(frozenBase, topBorder, 'border-r border-border/30 px-2 align-middle font-mono text-xs font-bold')}
                style={{ left: FROZEN_LEFT[1], height: ROW_H }}
            >
                {isMonthStart ? (
                    <div className="flex flex-col justify-center gap-0.5 py-1">
                        <span className="text-[9px] font-bold uppercase tracking-wider text-primary/80">{monthLabel}</span>
                        <span>{formatDateShort(g.recv_date) || dash}</span>
                    </div>
                ) : (
                    formatDateShort(g.recv_date) || dash
                )}
            </td>
            <td
                className={cn(frozenBase, topBorder, 'border-r border-border/30 px-2 align-middle font-mono text-xs font-bold text-muted-foreground')}
                style={{ left: FROZEN_LEFT[2], height: ROW_H }}
            >
                {formatDateShort(g.prod_date) || dash}
            </td>
            <td
                className={cn(frozenBase, topBorder, 'frozen-edge border-r border-border/30 px-1 align-middle font-mono text-xs font-bold')}
                style={{ left: FROZEN_LEFT[3], height: ROW_H }}
            >
                <span className="flex w-full items-center gap-1 truncate">
                    <span className="truncate">{g.batch || dash}</span>
                    {g.batch_year && <span className="font-mono text-[10px] font-bold text-muted-foreground/60">{g.batch_year}</span>}
                </span>
            </td>
            <td className={cn(topBorder, 'border-r border-border/30 px-2 align-middle font-mono text-xs font-bold')} style={{ height: ROW_H }}>
                {g.shift_code || dash}
            </td>
            <td className={cn(topBorder, 'border-r border-border/30 px-2 align-middle font-mono text-xs font-bold')} style={{ height: ROW_H }}>
                {g.grade_code || dash}
            </td>
            <td className={cn(topBorder, 'border-r border-border/30 px-2 align-middle')} style={{ height: ROW_H }}>
                {g.plant_code ? <span className={cn(BADGE_BASE, plantBadgeClass(g.plant_code))}>{g.plant_code}</span> : dash}
            </td>
            <td className={cn(topBorder, 'border-r border-border/30 px-2 align-middle font-mono text-xs font-bold')} style={{ height: ROW_H }}>
                {g.warehouse_code || <span className="text-muted-foreground/40">unplaced</span>}
            </td>
            <td className={cn(topBorder, 'border-r border-border/30 px-2 align-middle font-mono text-xs font-bold')} style={{ height: ROW_H }}>
                {g.source_location_code || dash}
            </td>
            <td className={cn(topBorder, 'border-r border-border/30 px-1 text-right align-middle font-mono text-xs font-bold tabular-nums')} style={{ height: ROW_H }}>
                {formatKg(g.weight_kg)}
            </td>
            <td className={cn(topBorder, 'border-r border-border/30 px-2 align-middle')} style={{ height: ROW_H }}>
                {g.ccc_flec ? <span className={cn(BADGE_BASE, cccFlecBadgeClass(g.ccc_flec))}>{g.ccc_flec}</span> : dash}
            </td>
            <td className={cn(topBorder, 'border-r border-border/30 px-1 text-right align-middle font-mono text-xs font-bold tabular-nums text-muted-foreground')} style={{ height: ROW_H }}>
                {g.flec_count}
            </td>
            <td className={cn(topBorder, 'px-2 text-right align-middle font-mono text-xs font-bold')} style={{ height: ROW_H }}>
                {g.whse_side || dash}
            </td>
        </>
    );
}

// ─── Frozen, opaque header (fixedHeaderContent) ──────────────────────────────────
// The six filterable columns render a multi-select `ColumnFilterMenu` in place of a plain
// label. The header cell geometry is unchanged (h-8, same paddings) — the menu is the same
// tiny chevron the single-select version used, plus a count chip when active, so the
// Excel-Standard density holds. The Popover portals to <body>, so it is never clipped by
// the virtualized scroller's overflow.
interface HeaderFilterWiring {
    /** Selection to render (optimistic — ticks the instant the operator clicks). */
    selected: LedgerFilters;
    presence: Record<FilterColumn, Set<string>>;
    onChange: (column: FilterColumn, values: string[]) => void;
    disabled: boolean;
    disabledHint?: string;
}

function HeaderFilter({
    column,
    wiring,
    align = 'start',
}: {
    column: FilterColumn;
    wiring: HeaderFilterWiring;
    align?: 'start' | 'end';
}) {
    const options = React.useMemo(
        () => mergeDiscoveredOptions(column, wiring.presence[column]),
        [column, wiring.presence],
    );
    const groups = React.useMemo(() => mergeDiscoveredGroups(column, options), [column, options]);
    return (
        <ColumnFilterMenu
            label={FILTER_SPECS[column].label}
            selected={wiring.selected[column]}
            options={options}
            groups={groups}
            present={wiring.presence[column]}
            searchable={FILTER_SPECS[column].searchable}
            onChange={(values) => wiring.onChange(column, values)}
            align={align}
            disabled={wiring.disabled}
            disabledHint={wiring.disabledHint}
        />
    );
}

function HeaderRow({ wiring }: { wiring: HeaderFilterWiring }) {
    const th = 'h-8 px-2 text-left align-middle text-[11px] font-bold uppercase tracking-wide text-muted-foreground';
    // The horizontal rule is on the CELLS (`[&>*]:`), never on the <tr>: this table is
    // `border-collapse: separate` (load-bearing for the sticky frozen columns), and in the
    // separated-borders model the CSS spec paints borders on table CELLS ONLY — a `border-b`
    // on a <tr>/<tbody>/<col> is ignored outright. Full weight here because this is the
    // header↔body boundary, not another row division.
    return (
        <tr className="[&>*]:border-b [&>*]:border-b-border">
            <th className="frozen-corner h-8 border-r border-border/40 bg-muted px-1 text-center font-mono text-[10px] font-bold text-muted-foreground" style={{ left: FROZEN_LEFT[0] }}>#</th>
            <th className={cn(th, 'frozen-corner bg-muted')} style={{ left: FROZEN_LEFT[1] }}>Recv</th>
            <th className={cn(th, 'frozen-corner bg-muted')} style={{ left: FROZEN_LEFT[2] }}>Prod</th>
            <th className={cn(th, 'frozen-corner frozen-edge bg-muted')} style={{ left: FROZEN_LEFT[3] }}>Batch</th>
            <th className={th}><HeaderFilter column="shift" wiring={wiring} /></th>
            <th className={th}><HeaderFilter column="grade" wiring={wiring} /></th>
            <th className={th}><HeaderFilter column="plant" wiring={wiring} /></th>
            <th className={th}><HeaderFilter column="whse" wiring={wiring} /></th>
            <th className={th}><HeaderFilter column="source" wiring={wiring} /></th>
            <th className={cn(th, 'text-right')}>Weight</th>
            <th className={th}><HeaderFilter column="ccc" wiring={wiring} align="end" /></th>
            <th className={cn(th, 'text-right')}>Flec</th>
            <th className={th}>Side</th>
        </tr>
    );
}

// ─── react-virtuoso table components (module-level → stable identity) ─────────────
// NOTE: strip virtuoso's `context` before spreading onto the DOM element — since this
// list passes a `context` prop, virtuoso forwards it to every component, and an object
// prop named `context` on a <div>/<thead> is an invalid DOM attribute.
const EndlessScroller = React.forwardRef<HTMLDivElement, React.ComponentProps<'div'> & { context?: unknown }>(
    function EndlessScroller({ style, context: _ctx, ...props }, ref) {
        void _ctx;
        return <div ref={ref} {...props} className="outline-none" style={{ overflowX: 'auto', ...style }} />;
    },
);

const EndlessTable = ({ style, children }: TableProps) => (
    <table
        className="relative table-fixed text-xs"
        style={{ ...style, width: '100%', minWidth: MIN_W, borderCollapse: 'separate', borderSpacing: 0 }}
    >
        <ColGroup />
        {children}
    </table>
);

const EndlessTableHead = React.forwardRef<HTMLTableSectionElement, React.ComponentProps<'thead'> & { context?: unknown }>(
    function EndlessTableHead({ style, context: _ctx, ...props }, ref) {
        void _ctx;
        return <thead ref={ref} {...props} className="frozen-row bg-muted" style={{ ...style, zIndex: 20 }} />;
    },
);

// The <tr> owns the row tint. Committed rows keep the IN/OUT direction tint; draft rows
// get a distinct amber-primary draft tint (+ a destructive wash on a validation error).
//
// It does NOT own the horizontal RULE. This table is `border-collapse: separate` (load-
// bearing: under `collapse` a border belongs to the TABLE rather than the cell, so a sticky
// frozen column's borders scroll away), and in the separated-borders model the CSS spec
// paints borders on table CELLS ONLY — the `border-b border-border/30` that used to sit on
// these <tr>s was never painted, which is why the sheet showed columns with no rows. The
// rule is applied to every child cell via `[&>*]:`, at the same /30 weight it always meant,
// with a SIDE-SPECIFIC colour (`border-b-border/30`) so it cannot restyle the cells' own
// `border-r` through tailwind-merge. Row heights are unchanged (preflight makes cells
// border-box, so the 1px rule draws inside the explicit ROW_H).
const EndlessTableRow = ({ item, context, children, style, ...props }: ItemProps<LedgerItem> & { context?: LedgerCtx }) => {
    if (item.kind === 'draft') {
        const hasError = context?.errorKeys.has(`d:${item.draftIndex}`) ?? false;
        return (
            <tr
                {...props}
                style={{ ...style, height: ROW_H }}
                className={cn(
                    'group [&>*]:border-b [&>*]:border-b-border/30 transition-colors duration-150 hover:bg-muted/50',
                    hasError ? 'bg-destructive/[0.06]' : 'bg-primary/[0.04]',
                )}
            >
                {children}
            </tr>
        );
    }
    // Committed row. When LOCKED it renders read-only with the base IN/OUT direction tint
    // (dormant restored edits/deletes do NOT paint until unlocked). When UNLOCKED, a pending
    // delete strikes/rose-washes it, a pending edit amber-washes it, else the (live, merged)
    // direction tint shows — the tint re-computes off the EDITED value so it re-colors as the
    // operator retypes a recognized CCC/FLEC or moves the row between warehouses.
    const id = item.row.id ?? '';
    const edited = context?.unlocked ? context.editedRows.get(id) : undefined;
    const isDeleted = (context?.unlocked && context.deletedIds.has(id)) ?? false;
    const hasError = (context?.unlocked && context.errorKeys.has(`c:${id}`)) ?? false;
    const dir = rowDirection(edited ? { ...toGridRow(item.row), ...edited } : toGridRow(item.row));
    return (
        <tr
            {...props}
            style={{ ...style, height: ROW_H }}
            className={cn(
                'group [&>*]:border-b [&>*]:border-b-border/30 transition-colors duration-150 hover:bg-muted',
                isDeleted ? 'bg-rose-50 line-through opacity-40 dark:bg-rose-950/40' : edited ? 'bg-amber-500/[0.07]' : rowDirectionTint(dir),
                hasError && 'bg-destructive/[0.06]',
            )}
        >
            {children}
        </tr>
    );
};

const tableComponents: TableComponents<LedgerItem, LedgerCtx> = {
    Scroller: EndlessScroller,
    Table: EndlessTable,
    TableHead: EndlessTableHead,
    TableRow: EndlessTableRow,
};

interface ProductionEndlessSheetProps {
    initialPage: InitialLedgerPage;
    anchor: LedgerAnchor;
    /**
     * The filters the server ALREADY APPLIED to `initialPage`. Every subsequent page this
     * component pulls must carry the same set, or the keyset walk would silently drift back
     * to unfiltered history. This is the applied truth — the menus render the (optimistic)
     * control state from `useLedgerFilters()` instead.
     */
    filters: LedgerFilters;
    filtersActive: boolean;
    periods: CenaproPeriod[];
    selectedPeriod: CenaproPeriod | null;
    loadError: string | null;
}

export function ProductionEndlessSheet({
    initialPage,
    anchor,
    filters,
    filtersActive,
    periods,
    selectedPeriod,
    loadError,
}: ProductionEndlessSheetProps) {
    const win = useLedgerWindow(initialPage, filters);
    const { rows: committed, firstItemIndex, hasOlder, hasNewer, loadingOlder, loadingNewer, notice, fetchOlder, fetchNewer } = win;

    // Filter axis. `filterUi.filters` is the OPTIMISTIC control state (so a checkbox ticks
    // instantly); the rows in view reflect the `filters` PROP, which is what the server
    // query used. `filterUi.isPending` bridges the gap with a visible spinner.
    const filterUi = useLedgerFilters();

    const { user, isLoading: authLoading } = useAuth();
    const router = useRouter();
    const pathname = usePathname();
    const searchParams = useSearchParams();
    const storageKey = draftStorageKey(user?.id);

    // ─── Lock / draft state ─────────────────────────────────────────────────────────
    const [unlocked, setUnlocked] = React.useState(false);
    const [draftRows, setDraftRows] = React.useState<BulkRow[]>([]);
    // ── Committed-row inline-edit state (Phase 3a) — PARENT-OWNED + keyed by event id ──
    // The non-negotiable recycle-/prepend-safety guarantee: a modified committed cell and
    // a deleted committed row live in these two structures keyed by the row's stable event
    // `id`, NEVER in a recycled virtual row's local state. A row edited, scrolled off-screen
    // and back, rehydrates its pending value from `editedRows` by id (the virtual row is
    // pure presentation). Prepending older pages (fetchOlder) shifts array indices but NOT
    // ids, so pending edits stay attached to the right row. `editedRows` stores the FULL
    // merged BulkRow per id (self-contained → saveable even for rows not in the window).
    const [editedRows, setEditedRows] = React.useState<Map<string, CommittedEdit>>(new Map());
    const [deletedIds, setDeletedIds] = React.useState<Set<string>>(new Set());
    const [errorKeys, setErrorKeys] = React.useState<Set<string>>(new Set());
    const [isSaving, setIsSaving] = React.useState(false);
    const [discardOpen, setDiscardOpen] = React.useState(false);
    const [activeCell, setActiveCell] = React.useState<CoordinateId | null>(null);
    // Resume/Discard prompt for drafts restored from a previous session — restore is now
    // EXPLICIT + consented (no silent auto-unlock). `count` = # of non-blank restored rows;
    // `wantAdd` remembers a concurrent ?add=1 intent so Discard can still open fresh for adding.
    const [resumePrompt, setResumePrompt] = React.useState<{ count: number; wantAdd: boolean } | null>(null);
    // Brief post-save "Saved N rows" chrome cue in the toolbar (auto-clears). NOT a row.
    const [savedFlash, setSavedFlash] = React.useState<number | null>(null);
    const savedFlashTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
    // How many rows a Save committed that the ACTIVE filters then exclude. Saving with a
    // filter on and watching the rows not come back would read as data loss, so we count
    // them and say so (with a one-click way out). Persists until the next save / clear.
    const [savedButFiltered, setSavedButFiltered] = React.useState(0);
    const hydratedRef = React.useRef(false);
    // Anti-runaway guard for scroll-growth: set when a bottom-reach appends blanks, cleared
    // only when the operator scrolls back UP off the bottom (atBottom → false). Because
    // atBottomStateChange only fires on a true↔false TRANSITION, one genuine bottom-reach
    // yields exactly one append; the next requires physically scrolling down again.
    const growGuardRef = React.useRef(false);

    const draftCount = React.useMemo(() => draftRows.filter((r) => !isBlankRow(r)).length, [draftRows]);
    // Committed dirty counts. A deleted row counts ONLY as deleted (delete wins over edit).
    const deletedCount = deletedIds.size;
    const modifiedCount = React.useMemo(
        () => [...editedRows.keys()].filter((id) => !deletedIds.has(id)).length,
        [editedRows, deletedIds],
    );
    // Total pending work across the unified dirty model (new drafts + modified + deleted).
    const totalDirty = draftCount + modifiedCount + deletedCount;
    // Compact one-line breakdown for the Save button + hints ("3 new · 2 mod · 1 del").
    const dirtySummary = [
        draftCount > 0 ? `${draftCount} new` : null,
        modifiedCount > 0 ? `${modifiedCount} mod` : null,
        deletedCount > 0 ? `${deletedCount} del` : null,
    ]
        .filter(Boolean)
        .join(' · ');

    const C = committed.length; // count of committed rows currently loaded (region boundary)

    // ─── Filter wiring ──────────────────────────────────────────────────────────────
    // UNSAVED WORK IS NEVER HIDDEN. In this scope filtering is a SERVER predicate, so
    // changing it refetches the window — and a pending edit whose row falls outside the
    // new window would still be counted as unsaved while being invisible. So the filter
    // controls are FROZEN while any pending work exists (the same dirty-guard idiom the
    // period picker / view switcher / scope toggle already use). Draft rows are appended
    // client-side and are never subject to a filter at all.
    const filtersLocked = totalDirty > 0;
    const filtersLockedHint =
        'Save or discard your unsaved changes before filtering — filtering reloads the window.';

    // Values actually present in the loaded window → used to DIM (never hide/disable)
    // options with no rows here. In endless scope an option absent from the window may
    // still exist further back; the query-side filter will still find it.
    const filterPresence = React.useMemo(
        () =>
            collectFilterPresence(
                committed.map((r) => ({
                    shift_code: r.shift_code,
                    grade_code: r.grade_code,
                    plant_code: r.plant_code,
                    warehouse_code: r.warehouse_code,
                    source_location_code: r.source_location_code,
                    ccc_flec: formatCccFlec(r.disposition_kind, r.partner_equipment_code),
                })),
            ),
        [committed],
    );

    const setFilterColumn = filterUi.setColumn;
    const clearFilters = filterUi.clearAll;
    const headerFilterWiring = React.useMemo<HeaderFilterWiring>(
        () => ({
            selected: filterUi.filters,
            presence: filterPresence,
            onChange: setFilterColumn,
            disabled: filtersLocked,
            disabledHint: filtersLockedHint,
        }),
        [filterUi.filters, filterPresence, setFilterColumn, filtersLocked],
    );
    const activeFilterDescription = React.useMemo(() => describeActiveFilters(filters), [filters]);

    const gridRef = React.useRef<HTMLDivElement>(null);
    const virtuosoRef = React.useRef<TableVirtuosoHandle>(null);
    const pendingScrollBottomRef = React.useRef(false);
    // After a committed-edit save, re-anchor the viewport near this event id (best-effort).
    const pendingScrollToIdRef = React.useRef<string | null>(null);
    const endEditRef = React.useRef<() => void>(() => {});

    // ─── Blank-pool maintenance ─────────────────────────────────────────────────────
    const ensureBlankBuffer = React.useCallback(() => {
        setDraftRows((prev) => {
            let lastNonBlank = -1;
            for (let i = 0; i < prev.length; i++) if (!isBlankRow(prev[i])) lastNonBlank = i;
            const trailing = prev.length - 1 - lastNonBlank; // rows after the last non-blank are all blank
            if (trailing >= BLANK_TRIGGER) return prev;
            const add = BLANK_TARGET - trailing;
            return [...prev, ...Array.from({ length: add }, createEmptyRow)];
        });
    }, []);

    // ─── Restore drafts from localStorage on mount (once auth resolves → stable key) ─
    React.useEffect(() => {
        if (hydratedRef.current || authLoading) return;
        hydratedRef.current = true;

        let stored = { drafts: [] as BulkRow[], edits: new Map<string, CommittedEdit>(), deletes: new Set<string>() };
        try {
            const raw = window.localStorage.getItem(storageKey);
            if (raw) stored = coerceStoredState(JSON.parse(raw));
        } catch {
            /* corrupt / unavailable — ignore, start clean */
        }

        const wantAdd = searchParams.get('add') === '1';
        const nonBlank = stored.drafts.filter((r) => !isBlankRow(r));
        // Total pending work = new drafts + pending committed edits + pending committed deletes.
        const pendingCount = nonBlank.length + stored.edits.size + stored.deletes.size;
        const hasPending = pendingCount > 0;
        // Restore all three pending structures into state but keep them DORMANT (locked →
        // blanks/drafts aren't rendered and committed overlays don't paint until unlocked).
        // Nothing auto-unlocks when pending work exists — the operator must explicitly Resume
        // or Discard via the prompt below (restore is consented).
        if (stored.drafts.length > 0) setDraftRows(stored.drafts);
        if (stored.edits.size > 0) setEditedRows(stored.edits);
        if (stored.deletes.size > 0) setDeletedIds(stored.deletes);
        if (hasPending) {
            // Surface the Resume/Discard prompt; remember any concurrent ?add=1 intent so a
            // Discard still opens a fresh add session (see handleDiscardResume).
            setResumePrompt({ count: pendingCount, wantAdd });
        } else if (wantAdd) {
            // Explicit "add now" intent + NO stale drafts → unlock directly (unchanged, no prompt).
            // Unlocking triggers the blank-pool maintenance effect (seeds/tops up) + the
            // scroll-to-bottom effect, so we only flip the flags here.
            setUnlocked(true);
            pendingScrollBottomRef.current = true;
        }

        if (wantAdd) {
            const sp = new URLSearchParams(searchParams.toString());
            sp.delete('add');
            const qs = sp.toString();
            router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
        }
    }, [authLoading, storageKey, searchParams, router, pathname]);

    // ─── Mirror pending work → localStorage (debounced) ──────────────────────────────
    // Loss-proof across the WHOLE unified dirty model now: new drafts + pending committed
    // inline-edits + pending committed deletions, all keyed so a reload restores every one.
    React.useEffect(() => {
        if (!hydratedRef.current) return;
        const t = setTimeout(() => {
            try {
                const drafts = draftRows.filter((r) => !isBlankRow(r));
                const edits = [...editedRows.entries()];
                const deletes = [...deletedIds];
                if (drafts.length > 0 || edits.length > 0 || deletes.length > 0) {
                    const payload: StoredDraftState = { drafts, edits, deletes };
                    window.localStorage.setItem(storageKey, JSON.stringify(payload));
                } else {
                    window.localStorage.removeItem(storageKey);
                }
            } catch {
                /* quota / private mode — pending work still lives in state */
            }
        }, 300);
        return () => clearTimeout(t);
    }, [draftRows, editedRows, deletedIds, storageKey]);

    // Clear the validation-error rails whenever the operator edits anything.
    React.useEffect(() => {
        setErrorKeys((prev) => (prev.size === 0 ? prev : new Set()));
    }, [draftRows, editedRows, deletedIds]);

    // Keep the trailing blank pool full as the operator types/pastes (not only on scroll).
    // ensureBlankBuffer is idempotent (appends only when trailing < BLANK_TRIGGER, lands
    // it back at BLANK_TARGET), so this can't loop.
    React.useEffect(() => {
        if (unlocked) ensureBlankBuffer();
    }, [draftRows, unlocked, ensureBlankBuffer]);

    // Scroll the newest row into view after a reset/refresh/unlock lands us at the bottom.
    const totalItems = committed.length + (unlocked ? draftRows.length : 0);
    React.useEffect(() => {
        if (pendingScrollBottomRef.current && totalItems > 0) {
            pendingScrollBottomRef.current = false;
            // Defer one frame so the appended blanks are in the list before we scroll.
            requestAnimationFrame(() => virtuosoRef.current?.scrollToIndex({ index: 'LAST', align: 'end' }));
        }
    }, [totalItems]);

    // Clean up the saved-flash timer on unmount.
    React.useEffect(() => () => {
        if (savedFlashTimerRef.current) clearTimeout(savedFlashTimerRef.current);
    }, []);

    const clearDraftMirror = React.useCallback(() => {
        try {
            window.localStorage.removeItem(storageKey);
        } catch {
            /* ignore */
        }
    }, [storageKey]);

    // ─── Resume/Discard prompt actions (explicit, consented restore) ─────────────────
    // Resume → drop back into editing with the restored drafts intact (unlock + scroll to the
    // append edge via the existing pendingScrollBottomRef path). The blank-pool + scroll effects
    // fire off `unlocked`, so we only flip the flags here.
    const handleResumeDrafts = React.useCallback(() => {
        setResumePrompt(null);
        setUnlocked(true);
        pendingScrollBottomRef.current = true;
    }, []);

    // Discard → clear the restored drafts and remove the device backup. Stays LOCKED normally;
    // but if the operator ALSO arrived via ?add=1 (explicit intent to add now), open a fresh add
    // session instead of dead-ending — clear the stale drafts and unlock into empty blanks.
    const handleDiscardResume = React.useCallback(() => {
        const wantAdd = resumePrompt?.wantAdd ?? false;
        setResumePrompt(null);
        setErrorKeys(new Set());
        setActiveCell(null);
        clearDraftMirror(); // explicit key removal (the mirror else-branch also removes it on [])
        setDraftRows([]);
        setEditedRows(new Map());
        setDeletedIds(new Set());
        if (wantAdd) {
            // Fresh add: unlock → ensureBlankBuffer seeds a full blank pool, scroll to the edge.
            setUnlocked(true);
            pendingScrollBottomRef.current = true;
        }
    }, [resumePrompt, clearDraftMirror]);

    // ─── The single "Add rows" / lock toggle ────────────────────────────────────────
    // Locked → click reveals blanks: if NOT at the true bottom (hasNewer), jump to latest
    // first, then unlock + seed + scroll to the append edge. Unlocked → click re-locks
    // (drafts persist in state + mirror). No separate "jump to latest" affordance.
    const handleToggle = React.useCallback(async () => {
        if (unlocked) {
            setUnlocked(false);
            return;
        }
        if (hasNewer) {
            // Jumped to an old month → load the newest window first (never append mid-history).
            pendingScrollBottomRef.current = true;
            await win.reset({ kind: 'latest' });
        }
        setUnlocked(true);
        ensureBlankBuffer();
        pendingScrollBottomRef.current = true;
    }, [unlocked, hasNewer, win, ensureBlankBuffer]);

    // ─── Unified grid hooks (ONE coordinate space over committed + draft regions) ────
    // Phase 3a folds committed rows into the SAME coordinate grid as the draft rows so the
    // shared selection / keyboard-nav / edit / paste hooks address both under one unlock.
    // Row coordinate = committed position [0 .. C-1] for committed rows, then C+draftIndex
    // for draft rows — which equals the row's index into virtuoso's `items` array (committed
    // items precede draft items), so `activeCell.row` doubles as the scroll data-index.
    // Reads/writes always route through the CURRENT `committed` array → an event id, so
    // prepending older pages (index shift) never corrupts a pending edit (it's id-keyed).
    const totalRows = C + draftRows.length;
    const isSelectableColumn = React.useCallback((c: number) => c !== 0 && BULK_COLUMN_MAP[c] !== null, []);
    const cellSelection = useCellSelection({
        rowCount: totalRows,
        colCount: BULK_COL_COUNT,
        isSelectableColumn,
        scrollContainerRef: gridRef,
        enabled: unlocked,
    });

    // Merged (base ⊕ pending-edit) BulkRow view of a committed row by coordinate index.
    const mergedCommittedRow = React.useCallback(
        (rowIdx: number): BulkRow | null => {
            const base = committed[rowIdx];
            if (!base) return null;
            const id = base.id ?? '';
            return editedRows.get(id) ?? bulkFromCommitted(base);
        },
        [committed, editedRows],
    );

    const getCellValue = React.useCallback(
        (rowIdx: number, colIdx: number): string => {
            const field = BULK_COLUMN_MAP[colIdx];
            if (!field) return '';
            if (rowIdx < C) {
                const merged = mergedCommittedRow(rowIdx);
                return merged ? String(merged[field] ?? '') : '';
            }
            const row = draftRows[rowIdx - C];
            return row ? String(row[field] ?? '') : '';
        },
        [C, draftRows, mergedCommittedRow],
    );

    const { handleKeyDown: handleCopyKeyDown } = useClipboardCopy({
        getSelectedRange: cellSelection.getSelectedRange,
        getCellValue,
        getSelectionSize: cellSelection.getSelectionSize,
    });

    const mouseDownCellRef = React.useRef<{ row: number; col: number } | null>(null);
    const dragMovedRef = React.useRef(false);

    const handleCellMouseDown = React.useCallback(
        (rowIdx: number, colIdx: number, e: React.MouseEvent) => {
            mouseDownCellRef.current = { row: rowIdx, col: colIdx };
            dragMovedRef.current = false;
            cellSelection.handleCellMouseDown(rowIdx, colIdx, e);
        },
        [cellSelection],
    );

    const handleCellMouseUp = React.useCallback(
        (rowIdx: number, colIdx: number) => {
            const down = mouseDownCellRef.current;
            mouseDownCellRef.current = null;
            if (down && down.row === rowIdx && down.col === colIdx && !dragMovedRef.current) {
                cellSelection.clearSelection();
                setActiveCell({ row: rowIdx, col: colIdx });
                endEditRef.current();
                // `preventScroll`: HTMLElement.focus() otherwise scrolls the grid wrapper
                // into view with block "center" through every scrolling ancestor — even
                // when it is already fully visible — so clicking a cell jogged the page.
                gridRef.current?.focus({ preventScroll: true });
            }
            dragMovedRef.current = false;
        },
        [cellSelection],
    );

    const handleCellMouseEnter = React.useCallback(
        (rowIdx: number, colIdx: number) => {
            if (mouseDownCellRef.current) {
                dragMovedRef.current = true;
                cellSelection.handleCellMouseEnter(rowIdx, colIdx);
            }
        },
        [cellSelection],
    );

    // ── Committed-region mutators — write into the id-keyed overlay / delete set ──────
    const updateCommittedCell = React.useCallback(
        (rowIdx: number, field: BulkField, value: string) => {
            const base = committed[rowIdx];
            const id = base?.id;
            if (!id) return;
            setEditedRows((prev) => {
                const next = new Map(prev);
                const baseBulk = bulkFromCommitted(base);
                const cur = next.get(id) ?? baseBulk;
                const updated: CommittedEdit = { ...cur, [field]: value };
                // Reverting every cell back to base un-modifies the row (drop it from the map).
                if (bulkEqual(updated, baseBulk)) next.delete(id);
                else next.set(id, updated);
                return next;
            });
        },
        [committed],
    );

    const toggleDeleteCommitted = React.useCallback(
        (rowIdx: number) => {
            const id = committed[rowIdx]?.id;
            if (!id) return;
            setDeletedIds((prev) => {
                const next = new Set(prev);
                if (next.has(id)) next.delete(id);
                else next.add(id);
                return next;
            });
        },
        [committed],
    );

    // ── Unified mutators — route by region: committed [< C] vs draft [>= C] ───────────
    const removeRow = React.useCallback(
        (index: number) => {
            if (index < C) {
                toggleDeleteCommitted(index);
                return;
            }
            const di = index - C;
            setDraftRows((prev) => (prev.length > 1 ? prev.filter((_, i) => i !== di) : [createEmptyRow()]));
        },
        [C, toggleDeleteCommitted],
    );

    const updateRow = React.useCallback(
        (index: number, field: BulkField, value: string) => {
            if (index < C) {
                updateCommittedCell(index, field, value);
                return;
            }
            const di = index - C;
            setDraftRows((prev) => {
                const next = [...prev];
                next[di] = { ...next[di], [field]: value };
                return next;
            });
        },
        [C, updateCommittedCell],
    );

    const clearCell = React.useCallback(
        (rowIdx: number, colIdx: number) => {
            const field = BULK_COLUMN_MAP[colIdx];
            if (field) updateRow(rowIdx, field, '');
        },
        [updateRow],
    );

    // Typed-date auto-transcription on commit ("6/2" → "2026-06-02"). mapBulkRowToDirty
    // re-applies it at save as a safety net; this is the live, visible normalization.
    const commitDateCell = React.useCallback(
        (rowIdx: number, field: BulkField) => {
            const yr = selectedPeriod?.batch_year ?? new Date().getFullYear();
            if (rowIdx < C) {
                const merged = mergedCommittedRow(rowIdx);
                const raw = merged?.[field];
                if (raw == null) return;
                const norm = normalizeTypedDate(raw, yr);
                if (norm !== raw) updateCommittedCell(rowIdx, field, norm);
                return;
            }
            const di = rowIdx - C;
            setDraftRows((prev) => {
                const raw = prev[di]?.[field];
                if (raw == null) return prev;
                const norm = normalizeTypedDate(raw, yr);
                if (norm === raw) return prev;
                const next = [...prev];
                next[di] = { ...next[di], [field]: norm };
                return next;
            });
        },
        [C, selectedPeriod?.batch_year, mergedCommittedRow, updateCommittedCell],
    );

    const DATE_FIELDS = React.useMemo(() => new Set<BulkField>(['recv_date', 'prod_date']), []);
    const commitActiveDateCell = React.useCallback(() => {
        if (!activeCell) return;
        const field = BULK_COLUMN_MAP[activeCell.col];
        if (field && DATE_FIELDS.has(field)) commitDateCell(activeCell.row, field);
    }, [activeCell, commitDateCell, DATE_FIELDS]);

    const { handleKeyDown: handleDeleteKeyDown } = useCellDelete({
        getSelectedRange: cellSelection.getSelectedRange,
        getSelectionSize: cellSelection.getSelectionSize,
        clearCell,
    });

    const setCellValue = React.useCallback(
        (id: CoordinateId, value: string) => {
            const field = BULK_COLUMN_MAP[id.col];
            if (field) updateRow(id.row, field, value);
        },
        [updateRow],
    );

    const editSession = useGridEditSession<CoordinateId>({
        getValue: (id) => getCellValue(id.row, id.col),
        setValue: setCellValue,
        onAfterCommit: commitActiveDateCell,
    });
    const isEditing = editSession.isEditing;
    const setIsEditing = React.useCallback(
        (editing: boolean) => {
            if (!editing) editSession.commit();
        },
        [editSession],
    );
    React.useEffect(() => {
        endEditRef.current = () => {
            if (editSession.isEditing) editSession.commit();
        };
    });

    const startEditing = React.useCallback(
        (rowIdx: number, colIdx: number, initialChar?: string) => {
            if (BULK_COLUMN_MAP[colIdx] == null) return;
            setActiveCell({ row: rowIdx, col: colIdx });
            editSession.startEditing({ row: rowIdx, col: colIdx }, initialChar);
        },
        [editSession],
    );

    const revertChanges = React.useCallback(() => {
        editSession.revertChanges();
        gridRef.current?.focus({ preventScroll: true });
    }, [editSession]);

    const baseResolver = React.useMemo(
        () => createCoordinateNavResolver({ rowCount: totalRows, columnMap: BULK_COLUMN_MAP }),
        [totalRows],
    );
    const resolver = React.useMemo<NavResolver<CoordinateId>>(
        () => ({
            ...baseResolver,
            resolve(from, move) {
                const next = baseResolver.resolve(from, move);
                if (next && move.kind === 'arrow' && move.dir === 'left' && next.col < 1) {
                    return { row: next.row, col: 1 };
                }
                return next;
            },
        }),
        [baseResolver],
    );

    const isRangeSelected = cellSelection.getSelectionSize() > 1;
    const rangeSlot = React.useMemo<GridRangeSlot>(
        () => ({
            isRangeSelected,
            extend: (e) => cellSelection.handleKeyDown(e),
            clear: () => cellSelection.clearSelection(),
            seedFromActive: () => {
                if (!activeCell) return;
                cellSelection.handleCellMouseDown(
                    activeCell.row,
                    activeCell.col,
                    { shiftKey: false, button: 0, preventDefault: () => {} } as unknown as React.MouseEvent,
                );
                cellSelection.handleMouseUp();
            },
            anchorId: () => {
                const range = cellSelection.range;
                return range ? { row: range.startRow, col: range.startCol } : null;
            },
            onCopy: (e) => handleCopyKeyDown(e),
            onDelete: (e) => handleDeleteKeyDown(e),
        }),
        [isRangeSelected, cellSelection, activeCell, handleCopyKeyDown, handleDeleteKeyDown],
    );

    const { handleKeyDown: handleNavKeyDown } = useGridKeyboardNav<CoordinateId>({
        activeCell,
        setActiveCell,
        isEditing,
        resolver,
        edit: {
            start: (id, char) => startEditing(id.row, id.col, char),
            revert: revertChanges,
            commit: () => {
                editSession.commit();
                gridRef.current?.focus({ preventScroll: true });
            },
        },
        range: rangeSlot,
        enableEnterAnchor: true,
    });

    const handleGridKeyDown = React.useCallback(
        (e: React.KeyboardEvent) => {
            if (!unlocked) return;
            if (!activeCell) {
                handleNavKeyDown(e);
                return;
            }
            if (!isEditing && (e.key === 'Home' || e.key === 'End')) {
                e.preventDefault();
                const col = e.key === 'Home' ? 1 : BULK_COL_COUNT - 1;
                setActiveCell({ row: activeCell.row, col });
                return;
            }
            handleNavKeyDown(e);
        },
        [unlocked, activeCell, isEditing, handleNavKeyDown],
    );

    // ─── Unified paste engine (routes across the committed + draft regions) ──────────
    // Distributes a pasted Excel/TSV block from the active cell: rows landing on committed
    // coordinates write the id-keyed overlay; rows landing on (or overflowing into) the
    // draft region write the draft array, auto-extending the blank pool when the paste is
    // taller than it. Mirrors the focus grid's handleSmartPaste, split by region boundary C.
    const handleSmartPaste = React.useCallback(
        (e: React.ClipboardEvent, startRow: number, startCol: number) => {
            e.preventDefault();
            const text = e.clipboardData.getData('text');
            if (!text) return;
            const clip = text.split(/\r\n|\n|\r/).filter((r) => r.trim() !== '');
            if (!clip.length) return;

            // Committed writes → overlay map (rows whose target coordinate is < C).
            setEditedRows((prev) => {
                const next = new Map(prev);
                clip.forEach((line, r) => {
                    const targetRow = startRow + r;
                    if (targetRow >= C) return;
                    const base = committed[targetRow];
                    const id = base?.id;
                    if (!id) return;
                    const baseBulk = bulkFromCommitted(base);
                    let cur: CommittedEdit = next.get(id) ?? baseBulk;
                    line.split('\t').forEach((cell, cOffset) => {
                        const targetCol = startCol + cOffset;
                        if (targetCol >= BULK_COL_COUNT) return;
                        const field = BULK_COLUMN_MAP[targetCol];
                        if (!field) return;
                        cur = { ...cur, [field]: cleanBulkPasteValue(cell, field) };
                    });
                    if (bulkEqual(cur, baseBulk)) next.delete(id);
                    else next.set(id, cur);
                });
                return next;
            });

            // Draft writes → draft array (rows whose target coordinate is >= C), auto-extend.
            setDraftRows((prev) => {
                let touched = false;
                const next = [...prev];
                clip.forEach((line, r) => {
                    const targetRow = startRow + r;
                    if (targetRow < C) return;
                    const di = targetRow - C;
                    while (di >= next.length) next.push(createEmptyRow());
                    const row = { ...next[di] };
                    line.split('\t').forEach((cell, cOffset) => {
                        const targetCol = startCol + cOffset;
                        if (targetCol >= BULK_COL_COUNT) return;
                        const field = BULK_COLUMN_MAP[targetCol];
                        if (!field) return;
                        row[field] = cleanBulkPasteValue(cell, field);
                    });
                    next[di] = row;
                    touched = true;
                });
                return touched ? next : prev;
            });

            toast.success(`Pasted ${clip.length} row${clip.length !== 1 ? 's' : ''}`);
        },
        [C, committed],
    );

    const handleGridPaste = React.useCallback(
        (e: React.ClipboardEvent) => {
            if (!unlocked || isEditing || !activeCell) return;
            handleSmartPaste(e, activeCell.row, activeCell.col);
            cellSelection.clearSelection();
        },
        [unlocked, isEditing, activeCell, handleSmartPaste, cellSelection],
    );

    // ─── Nav to a cell that isn't rendered yet → scroll it into view ────────────────
    // With a generous bottom overscan the next few blanks are already rendered, but if
    // nav lands on a far row, bring it into view so the ring + (on edit) the input show.
    // `activeCell.row` is the UNIFIED coordinate = the row's data index into virtuoso's
    // `items` (committed rows first, then drafts), so it scrolls into view directly.
    const prevActiveRowRef = React.useRef<number | null>(null);
    React.useEffect(() => {
        if (!unlocked || !activeCell) {
            prevActiveRowRef.current = activeCell?.row ?? null;
            return;
        }
        if (prevActiveRowRef.current !== activeCell.row) {
            prevActiveRowRef.current = activeCell.row;
            virtuosoRef.current?.scrollIntoView({ index: activeCell.row });
        }
    }, [unlocked, activeCell]);

    // After a committed-edit save, re-anchor the viewport near the row we were editing.
    // The freshly-refetched window may place it at a new index (a recv_date edit relocates
    // it) or drop it entirely — both are fine: scroll only if it's still present.
    React.useEffect(() => {
        const id = pendingScrollToIdRef.current;
        if (!id) return;
        const idx = committed.findIndex((r) => (r.id ?? '') === id);
        if (idx >= 0) {
            pendingScrollToIdRef.current = null;
            requestAnimationFrame(() => virtuosoRef.current?.scrollToIndex({ index: idx, align: 'start' }));
        }
    }, [committed]);

    // ─── Save ────────────────────────────────────────────────────────────────────────
    // ─── Unified Save (new drafts + modified + deleted committed rows, ONE round-trip) ─
    const handleSave = React.useCallback(async () => {
        const filledDrafts = draftRows.filter((r) => !isBlankRow(r));
        const hadDrafts = filledDrafts.length > 0;
        const hadCommittedChanges = editedRows.size > 0 || deletedIds.size > 0;
        if (!hadDrafts && !hadCommittedChanges) {
            toast.warning('Nothing to save — add, edit, or delete a row first.');
            return;
        }

        const dirtyRows: ProductionEventDirtyRow[] = [];
        const rowErrors: string[] = [];
        const badKeys = new Set<string>();

        // 1) New draft rows (INSERT — no id).
        draftRows.forEach((r, idx) => {
            if (isBlankRow(r)) return;
            const { row, errors } = mapBulkRowToDirty(r, selectedPeriod?.batch_year);
            if (errors.length > 0) {
                rowErrors.push(`${rowLabel(r, idx)}: ${errors.join('; ')}`);
                badKeys.add(`d:${idx}`);
            } else if (row) {
                dirtyRows.push(row);
            }
        });

        // 2) Modified committed rows (UPDATE — carry the id). Built from the id-keyed map
        //    DIRECTLY (not the visible window) so a pending edit to an off-screen / not-loaded
        //    row still saves. A deleted row's edit is dropped (delete wins).
        editedRows.forEach((bulk, id) => {
            if (deletedIds.has(id)) return;
            const { row, errors } = mapBulkRowToDirty(bulk, selectedPeriod?.batch_year);
            const label = bulk.batch.trim() ? `edited row "${bulk.batch.trim()}"` : `edited row ${id.slice(0, 8)}`;
            if (errors.length > 0) {
                rowErrors.push(`${label}: ${errors.join('; ')}`);
                badKeys.add(`c:${id}`);
            } else if (row) {
                dirtyRows.push({ ...row, id });
            }
        });

        // 3) Deleted committed rows.
        const deleted = [...deletedIds];

        if (rowErrors.length > 0) {
            setErrorKeys(badKeys);
            errorToast(`${rowErrors.length} row${rowErrors.length !== 1 ? 's' : ''} can't be saved yet.`, {
                description:
                    'Fix the values below, then Save again. Categoricals must match the lookup codes ' +
                    '(e.g. shift M/E/N, grade 3X50/2X6/3.5/4X8, warehouse WHSE 1/2/3/5/7). Crusher/Kiln rows ' +
                    'need an equipment code (C1–C4 / RK1–RK4).\n\n' +
                    rowErrors.join('\n'),
            });
            return;
        }

        if (dirtyRows.length === 0 && deleted.length === 0) {
            toast.info('No changes to save.');
            return;
        }

        // Remember where we were (committed-only viewport re-anchor) before the save.
        const topId = committed[0]?.id ?? null;

        // With filters ON, a row we're about to commit may not survive the refetch — the
        // window is a SERVER-filtered read. Count those up front (the same client matcher
        // that expresses the filters in Focus scope) so the post-save cue can say "3 saved
        // rows are hidden by the active filters" instead of the rows just not reappearing.
        let willBeFiltered = 0;
        if (filtersActive) {
            const check = (r: BulkRow) => {
                if (!matchesLedgerFilters(r, filters)) willBeFiltered++;
            };
            filledDrafts.forEach(check);
            editedRows.forEach((bulk, id) => {
                if (!deletedIds.has(id)) check(bulk);
            });
        }

        setIsSaving(true);
        try {
            const res = await saveProductionEvents(dirtyRows, deleted);
            if (!res.ok) {
                errorToast(res.error ?? 'Failed to save production rows.');
                return;
            }
            const savedN = (res.upserted ?? 0) + (res.deleted ?? 0);
            // Clear the ENTIRE unified dirty model + the device mirror.
            setDraftRows(Array.from({ length: BLANK_TARGET }, createEmptyRow));
            setEditedRows(new Map());
            setDeletedIds(new Set());
            setErrorKeys(new Set());
            setActiveCell(null);
            clearDraftMirror();

            // Success cue (chrome-only, fades up, auto-clears).
            const parts: string[] = [];
            if (res.upserted) parts.push(`${res.upserted} saved`);
            if (res.deleted) parts.push(`${res.deleted} deleted`);
            toast.success(parts.length ? `Saved — ${parts.join(', ')}` : 'Saved');
            setSavedFlash(savedN);
            if (savedFlashTimerRef.current) clearTimeout(savedFlashTimerRef.current);
            savedFlashTimerRef.current = setTimeout(() => setSavedFlash(null), 2500);
            // Honest about rows the refetched (filtered) window won't bring back.
            setSavedButFiltered(willBeFiltered);

            // Post-save refresh — the pager holds client-side pages (revalidatePath won't
            // touch them). New rows always append at the newest end, so when drafts were
            // added we re-seed from the page anchor + scroll to the bottom entry edge. When
            // ONLY committed rows changed, refetch the loaded window in place + re-anchor the
            // viewport near where we were editing (a recv_date edit may relocate the row —
            // that's accepted; the fresh read can't crash on a relocation).
            if (hadDrafts) {
                pendingScrollBottomRef.current = anchor.kind === 'latest';
                await win.reset(anchor);
            } else {
                pendingScrollToIdRef.current = topId;
                await win.refreshWindow();
            }
        } catch (err) {
            errorToast('Unexpected error: ' + (err instanceof Error ? err.message : String(err)));
        } finally {
            setIsSaving(false);
        }
    }, [
        draftRows,
        editedRows,
        deletedIds,
        selectedPeriod?.batch_year,
        committed,
        clearDraftMirror,
        win,
        anchor,
        filters,
        filtersActive,
    ]);

    const handleDiscardConfirm = React.useCallback(() => {
        setDiscardOpen(false);
        setErrorKeys(new Set());
        setActiveCell(null);
        clearDraftMirror();
        setDraftRows(Array.from({ length: BLANK_TARGET }, createEmptyRow));
        setEditedRows(new Map());
        setDeletedIds(new Set());
    }, [clearDraftMirror]);

    // ─── Virtuoso wiring ─────────────────────────────────────────────────────────────
    const items = React.useMemo<LedgerItem[]>(() => {
        const base: LedgerItem[] = committed.map((r) => ({ kind: 'committed' as const, row: r }));
        if (!unlocked) return base;
        for (let i = 0; i < draftRows.length; i++) base.push({ kind: 'draft', draftIndex: i });
        return base;
    }, [committed, unlocked, draftRows]);

    const selProps = React.useCallback(
        (rowIdx: number, colIdx: number): DraftCellSelProps => ({
            onCellMouseDown: (e: React.MouseEvent) => handleCellMouseDown(rowIdx, colIdx, e),
            onCellMouseUp: () => handleCellMouseUp(rowIdx, colIdx),
            onCellMouseEnter: () => handleCellMouseEnter(rowIdx, colIdx),
            isCellRangeSelected: cellSelection.isSelected(rowIdx, colIdx),
            isCellRangeAnchor: cellSelection.isAnchor(rowIdx, colIdx),
            isDragActive: cellSelection.isDragging,
        }),
        [handleCellMouseDown, handleCellMouseUp, handleCellMouseEnter, cellSelection],
    );

    const commonCellProps: DraftCellCommonProps = {
        activeCell,
        isEditing,
        setActiveCell,
        setIsEditing,
        onStartEditing: startEditing,
        onRevert: revertChanges,
        gridRef,
    };

    // Recreated each render → virtuoso re-renders visible items on any state change, so
    // the active ring + edited values stay current across the (recycling) virtual rows.
    const context: LedgerCtx = {
        firstItemIndex,
        unlocked,
        committed,
        draftRows,
        editedRows,
        deletedIds,
        errorKeys,
        commonCellProps,
        selProps,
        updateRow,
        removeRow,
        onPaste: handleSmartPaste,
        onCommitDate: commitDateCell,
    };

    const itemContent = React.useCallback((index: number, item: LedgerItem, ctx: LedgerCtx) => {
        if (item.kind === 'committed') {
            const pos = index - ctx.firstItemIndex;
            // LOCKED → read-only frozen render (with month separators), exactly as before.
            if (!ctx.unlocked) {
                const prev = pos > 0 ? ctx.committed[pos - 1] : undefined;
                const monthStart = isMonthBoundary(prev, item.row);
                return renderCommittedCells(item.row, pos + 1, monthStart, monthStart ? monthLabelOf(item.row) : null);
            }
            // UNLOCKED → inline-editable committed row. The pending edit (if any) is merged
            // in by event id — recycle-safe: this reads the parent-owned map, never local state.
            const id = item.row.id ?? '';
            const edited = ctx.editedRows.get(id);
            const row = edited ?? bulkFromCommitted(item.row);
            return (
                <CommittedRowCells
                    rowIdx={pos}
                    rowNum={pos + 1}
                    row={row}
                    isModified={!!edited}
                    isDeleted={ctx.deletedIds.has(id)}
                    hasError={ctx.errorKeys.has(`c:${id}`)}
                    onToggleDelete={() => ctx.removeRow(pos)}
                    updateRow={ctx.updateRow}
                    onPaste={ctx.onPaste}
                    onCommitDate={ctx.onCommitDate}
                    commonCellProps={ctx.commonCellProps}
                    selProps={ctx.selProps}
                />
            );
        }
        const di = item.draftIndex;
        const unifiedRow = ctx.committed.length + di;
        const row = ctx.draftRows[di] ?? createEmptyRow();
        return (
            <DraftRowCells
                rowIdx={unifiedRow}
                row={row}
                hasError={ctx.errorKeys.has(`d:${di}`)}
                updateRow={ctx.updateRow}
                removeRow={ctx.removeRow}
                onPaste={ctx.onPaste}
                onCommitDate={ctx.onCommitDate}
                commonCellProps={ctx.commonCellProps}
                selProps={ctx.selProps}
            />
        );
    }, []);

    const computeItemKey = React.useCallback(
        (index: number, item: LedgerItem) => (item.kind === 'committed' ? `c:${item.row.id ?? index}` : `d:${item.draftIndex}`),
        [],
    );

    const handleStartReached = React.useCallback(() => {
        void fetchOlder();
    }, [fetchOlder]);

    // endReached only pages in newer COMMITTED history (a no-op at the true-latest edge,
    // where unlocked drafting lives). Blank-pool growth is driven by atBottomStateChange
    // below — NOT here — because with a bottom overscan, endReached re-fires as the appended
    // blanks settle into the overscan band, which would runaway if it also appended.
    const handleEndReached = React.useCallback(() => {
        void fetchNewer();
    }, [fetchNewer]);

    // Scroll-growth: each time the operator genuinely reaches the bottom, append one more
    // batch of blanks so the sheet feels endless. atBottom only fires on a TRANSITION, and
    // the append (BLANK_GROW_BATCH rows ≈ taller than the overscan) shoves the end far below
    // the viewport → atBottom flips back to false → guard resets → the NEXT batch needs a
    // fresh scroll-down. So it can't runaway-loop (append → re-render → guard blocks re-append
    // until a real scroll gesture). Decoupled from ensureBlankBuffer's minimum maintenance.
    const appendBlankBatch = React.useCallback(() => {
        setDraftRows((prev) => [...prev, ...Array.from({ length: BLANK_GROW_BATCH }, createEmptyRow)]);
    }, []);
    const handleAtBottomStateChange = React.useCallback(
        (atBottom: boolean) => {
            if (!unlocked) return;
            if (!atBottom) {
                growGuardRef.current = false;
                return;
            }
            if (growGuardRef.current) return;
            growGuardRef.current = true;
            appendBlankBatch();
        },
        [unlocked, appendBlankBatch],
    );

    const initialTopMostItemIndex = anchor.kind === 'latest' ? Math.max(0, initialPage.rows.length - 1) : 0;

    // The frozen header now carries the six column filter menus, so it must re-render when
    // the selection / presence / dirty-guard change. Memoized on exactly those.
    const fixedHeaderContent = React.useCallback(
        () => <HeaderRow wiring={headerFilterWiring} />,
        [headerFilterWiring],
    );

    return (
        <div className="flex h-full flex-col">
            {/* Toolbar */}
            <div className="flex flex-none flex-wrap items-center gap-2 border-b bg-muted/30 px-2 py-1.5 md:px-3">
                {/* Edit controls live on the LEFT (near the eye) — the Add-rows/lock toggle,
                    then the editing actions; the period/view/scope nav sits to their right. */}
                {/* Single control — unlock/reveal-blanks (jump-to-latest first if needed) or re-lock. */}
                <Button
                    variant={unlocked ? 'default' : 'outline'}
                    size="sm"
                    className="h-6 gap-1 px-2 text-[11px] transition-colors duration-150"
                    onClick={handleToggle}
                    title={unlocked ? 'Lock the sheet (drafts are kept)' : 'Add rows — jumps to the newest end and opens blank rows below'}
                >
                    {unlocked ? <LockOpen className="h-3 w-3" /> : <Lock className="h-3 w-3" />}
                    {unlocked ? 'Unlocked' : 'Add rows'}
                </Button>
                {/* Unlocked status hint — fades in with the editing state (chrome, not a row). */}
                {unlocked && (
                    <span
                        className="animate-fade-in hidden font-mono text-[10px] text-muted-foreground/70 sm:inline"
                        title="Drafts and edits are kept on this device until you Save"
                    >
                        {totalDirty > 0 ? dirtySummary : 'Type, edit, or paste'}
                    </span>
                )}
                {/* Relocated Save / Discard — beside the Add-rows toggle, only when unlocked
                    with pending work (new drafts, modified, or deleted committed rows). Scales
                    in on unlock, out on lock. Discard is the ONE destructive action (AlertDialog
                    confirm). Replaces the old floating bar. */}
                {unlocked && totalDirty > 0 && (
                    <div className="animate-scale-in flex items-center gap-1.5">
                        <Button
                            variant="ghost"
                            size="sm"
                            className="h-6 gap-1 px-2 text-[11px] text-muted-foreground transition-colors duration-150 hover:text-destructive"
                            onClick={() => setDiscardOpen(true)}
                            disabled={isSaving}
                        >
                            Discard all
                        </Button>
                        <Button
                            size="sm"
                            className="h-6 gap-1 px-3 text-[11px] transition-colors duration-150"
                            onClick={handleSave}
                            disabled={isSaving}
                        >
                            <Save className="h-3 w-3" />
                            {isSaving ? (
                                'Saving…'
                            ) : (
                                <span className="inline-flex items-center gap-1">
                                    Save
                                    <span key={dirtySummary} className="animate-badge-pop inline-block tabular-nums">
                                        {dirtySummary}
                                    </span>
                                </span>
                            )}
                        </Button>
                    </div>
                )}
                {/* Post-save success cue (chrome-only, fades up then auto-clears). */}
                {savedFlash !== null && (
                    <span
                        key={savedFlash}
                        className="animate-fade-up hidden text-[10px] font-semibold text-emerald-600 dark:text-emerald-400 sm:inline"
                    >
                        Saved {savedFlash} row{savedFlash !== 1 ? 's' : ''}
                    </span>
                )}
                {!unlocked && totalDirty > 0 && (
                    <span className="hidden text-[10px] font-medium text-amber-600 dark:text-amber-400 sm:inline">
                        {totalDirty} unsaved kept
                    </span>
                )}
                {!unlocked && (
                    <span className="hidden text-[10px] font-medium uppercase tracking-wide text-muted-foreground/60 md:inline">
                        Read-only · oldest → newest
                    </span>
                )}
                {/* Saved-but-filtered cue — rows the refetched window legitimately can't
                    bring back because the active filters exclude them. One click out. */}
                {savedButFiltered > 0 && (
                    <span className="animate-fade-up inline-flex items-center gap-1 text-[10px] font-medium text-amber-600 dark:text-amber-400">
                        {savedButFiltered} saved row{savedButFiltered !== 1 ? 's' : ''} hidden by filters
                        <Button
                            variant="ghost"
                            size="sm"
                            className="h-5 px-1 text-[10px] text-amber-700 dark:text-amber-300"
                            onClick={() => {
                                setSavedButFiltered(0);
                                clearFilters();
                            }}
                        >
                            Show
                        </Button>
                    </span>
                )}
                <span className="h-4 w-px bg-border/60" />
                <CenaproPeriodPicker periods={periods} selected={selectedPeriod} />
                <span className="h-4 w-px bg-border/60" />
                <ViewModeSwitcher mode="ledger" />
                <span className="h-4 w-px bg-border/60" />
                <ScopeToggle scope="endless" />
                {filterUi.activeCount > 0 && (
                    <>
                        <span className="h-4 w-px bg-border/60" />
                        <FilterSummaryChip
                            count={filterUi.activeCount}
                            onClear={clearFilters}
                            pending={filterUi.isPending}
                            disabled={filtersLocked}
                            disabledHint={filtersLockedHint}
                        />
                    </>
                )}
                {filterUi.isPending && <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />}
                <div className="flex-1" />
                <span className="font-mono text-[11px] text-muted-foreground/70">
                    {committed.length.toLocaleString('en-US')} loaded
                    {filtersActive && <span className="ml-1 text-primary">· filtered</span>}
                    {(hasOlder || hasNewer) && <span className="ml-1 text-muted-foreground/50">· scroll to load more</span>}
                </span>
            </div>

            {/* Resume/Discard prompt — restored unsaved drafts from a previous session. Inline,
                non-blocking chrome (NOT a modal, NOT a toast); persists until the operator picks
                Resume / Discard (or dismisses with ✕ = "later", keeping drafts + staying locked). */}
            {resumePrompt && (
                <div className="animate-fade-up mx-3 mt-3 flex flex-wrap items-center gap-3 rounded-md border border-border bg-card px-3 py-2 shadow-sm">
                    <span className="min-w-0 flex-1 text-xs text-muted-foreground">
                        You have{' '}
                        <span className="font-semibold text-foreground tabular-nums">{resumePrompt.count}</span> unsaved
                        change{resumePrompt.count !== 1 ? 's' : ''} (new / edited / deleted rows) from a previous session.
                    </span>
                    <div className="flex items-center gap-1.5">
                        <Button
                            variant="ghost"
                            size="sm"
                            className="h-6 px-2 text-[11px] text-muted-foreground transition-colors duration-150 hover:text-destructive"
                            onClick={handleDiscardResume}
                        >
                            Discard
                        </Button>
                        <Button
                            size="sm"
                            className="h-6 gap-1 px-3 text-[11px] transition-colors duration-150"
                            onClick={handleResumeDrafts}
                        >
                            <LockOpen className="h-3 w-3" />
                            Resume
                        </Button>
                        <Button
                            variant="ghost"
                            size="icon"
                            className="h-6 w-6 text-muted-foreground transition-colors duration-150 hover:text-foreground"
                            title="Later — keep drafts, stay locked"
                            aria-label="Dismiss"
                            onClick={() => setResumePrompt(null)}
                        >
                            <X className="h-3.5 w-3.5" />
                        </Button>
                    </div>
                </div>
            )}

            {loadError && (
                <div className="m-3 flex items-start gap-3 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm">
                    <div className="min-w-0 flex-1">
                        <p className="font-medium text-destructive">Couldn&apos;t load production data</p>
                        <p className="mt-1 break-words text-destructive/90">{loadError}</p>
                        <p className="mt-1 text-xs text-muted-foreground">Try again in a moment, or copy the message above if it persists.</p>
                    </div>
                    <Button
                        variant="ghost"
                        size="sm"
                        className="h-7 shrink-0 px-2 text-destructive hover:text-destructive"
                        onClick={() => {
                            void navigator.clipboard.writeText(loadError).then(() => {
                                import('sonner').then(({ toast: t }) => t.success('Error copied to clipboard', { duration: 2000 }));
                            });
                        }}
                    >
                        <Copy className="mr-1 h-3.5 w-3.5" />
                        Copy
                    </Button>
                </div>
            )}

            {notice && (
                <div className="mx-3 mt-3 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-[11px] text-amber-700 dark:text-amber-300">
                    {notice}
                </div>
            )}

            {committed.length === 0 && !unlocked ? (
                <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 p-8 text-center">
                    {filtersActive ? (
                        // Name the filters responsible — a bare "nothing here" would read as
                        // missing data when it's actually a predicate the operator set.
                        <FilteredEmptyState
                            active={activeFilterDescription}
                            onClear={clearFilters}
                            disabled={filtersLocked}
                        />
                    ) : (
                        <>
                            <Inbox className="h-8 w-8 text-muted-foreground/30" />
                            <p className="text-sm text-muted-foreground">{notice ?? 'No production events to display.'}</p>
                        </>
                    )}
                </div>
            ) : (
                <div
                    ref={gridRef}
                    className="relative min-h-0 flex-1 select-none outline-none"
                    tabIndex={-1}
                    onKeyDown={handleGridKeyDown}
                    onPaste={handleGridPaste}
                    onBlur={(e) => {
                        if (unlocked && !e.currentTarget.contains(e.relatedTarget)) {
                            setActiveCell(null);
                            setIsEditing(false);
                        }
                    }}
                >
                    {loadingOlder && (
                        <div className="pointer-events-none absolute inset-x-0 top-0 z-40 flex items-center justify-center gap-1.5 border-b border-border/40 bg-muted/85 py-1 text-[11px] text-muted-foreground backdrop-blur-sm">
                            <Loader2 className="h-3 w-3 animate-spin" />
                            Loading earlier entries…
                        </div>
                    )}
                    <TableVirtuoso
                        ref={virtuosoRef}
                        data={items}
                        context={context}
                        computeItemKey={computeItemKey}
                        firstItemIndex={firstItemIndex}
                        initialTopMostItemIndex={initialTopMostItemIndex}
                        startReached={handleStartReached}
                        endReached={handleEndReached}
                        atBottomStateChange={handleAtBottomStateChange}
                        increaseViewportBy={{ top: 400, bottom: unlocked ? 900 : 400 }}
                        components={tableComponents}
                        fixedHeaderContent={fixedHeaderContent}
                        itemContent={itemContent}
                        style={{ height: '100%' }}
                    />
                    {loadingNewer && (
                        <div className="pointer-events-none absolute inset-x-0 bottom-0 z-40 flex items-center justify-center gap-1.5 border-t border-border/40 bg-muted/85 py-1 text-[11px] text-muted-foreground backdrop-blur-sm">
                            <Loader2 className="h-3 w-3 animate-spin" />
                            Loading newer entries…
                        </div>
                    )}
                </div>
            )}

            {/* Datalists for the draft cells' `list=` typeahead — rendered once. */}
            {unlocked && <DraftDatalists />}

            <AlertDialog open={discardOpen} onOpenChange={setDiscardOpen}>
                <AlertDialogContent>
                    <AlertDialogHeader>
                        <AlertDialogTitle>Discard all unsaved changes?</AlertDialogTitle>
                        <AlertDialogDescription>
                            This permanently clears the {totalDirty} unsaved change{totalDirty !== 1 ? 's' : ''} on the sheet
                            — new drafts, cell edits, and pending deletions — plus the device backup. This can&apos;t be undone.
                        </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                        <AlertDialogCancel>Keep editing</AlertDialogCancel>
                        <AlertDialogAction onClick={handleDiscardConfirm} className="bg-destructive text-destructive-foreground hover:bg-destructive/90">
                            Discard all
                        </AlertDialogAction>
                    </AlertDialogFooter>
                </AlertDialogContent>
            </AlertDialog>
        </div>
    );
}
