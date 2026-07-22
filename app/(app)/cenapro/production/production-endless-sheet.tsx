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
import { useGridPaste } from '@/lib/hooks/use-grid-paste';
import { CenaproPeriodPicker } from './period-picker';
import { ViewModeSwitcher, ScopeToggle } from './ledger-controls';
import { useLedgerWindow, type InitialLedgerPage } from './use-ledger-window';
import { DraftRowCells, DraftDatalists, type DraftCellCommonProps, type DraftCellSelProps } from './draft-entry-zone';
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
const DRAFT_STORAGE_VERSION = 'v1';
const draftStorageKey = (userId: string | null | undefined) => `cenapro-ledger-drafts:${DRAFT_STORAGE_VERSION}:${userId ?? 'anon'}`;

// Best-effort BulkRow coercion for restore — fold each parsed object onto a fresh empty
// row so a missing/older key defaults to '' rather than undefined.
function coerceStoredRows(parsed: unknown): BulkRow[] {
    if (!Array.isArray(parsed)) return [];
    return parsed.map((r) => ({ ...createEmptyRow(), ...(r && typeof r === 'object' ? r : {}) }) as BulkRow);
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
    committed: ProductionEventRow[];
    draftRows: BulkRow[];
    errorRowIndices: Set<number>;
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
function HeaderRow() {
    const th = 'h-8 px-2 text-left align-middle text-[11px] font-bold uppercase tracking-wide text-muted-foreground';
    return (
        <tr className="border-b">
            <th className="frozen-corner h-8 border-r border-border/40 bg-muted px-1 text-center font-mono text-[10px] font-bold text-muted-foreground" style={{ left: FROZEN_LEFT[0] }}>#</th>
            <th className={cn(th, 'frozen-corner bg-muted')} style={{ left: FROZEN_LEFT[1] }}>Recv</th>
            <th className={cn(th, 'frozen-corner bg-muted')} style={{ left: FROZEN_LEFT[2] }}>Prod</th>
            <th className={cn(th, 'frozen-corner frozen-edge bg-muted')} style={{ left: FROZEN_LEFT[3] }}>Batch</th>
            <th className={th}>Shift</th>
            <th className={th}>Grade</th>
            <th className={th}>Plant</th>
            <th className={th}>Whse</th>
            <th className={th}>Source</th>
            <th className={cn(th, 'text-right')}>Weight</th>
            <th className={th}>CCC/FLEC</th>
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
const EndlessTableRow = ({ item, context, children, style, ...props }: ItemProps<LedgerItem> & { context?: LedgerCtx }) => {
    if (item.kind === 'draft') {
        const hasError = context?.errorRowIndices.has(item.draftIndex) ?? false;
        return (
            <tr
                {...props}
                style={{ ...style, height: ROW_H }}
                className={cn(
                    'group border-b border-border/30 transition-colors duration-150 hover:bg-muted/50',
                    hasError ? 'bg-destructive/[0.06]' : 'bg-primary/[0.04]',
                )}
            >
                {children}
            </tr>
        );
    }
    const dir = rowDirection(toGridRow(item.row));
    return (
        <tr
            {...props}
            style={{ ...style, height: ROW_H }}
            className={cn('group border-b border-border/30 transition-colors duration-150 hover:bg-muted', rowDirectionTint(dir))}
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
    periods: CenaproPeriod[];
    selectedPeriod: CenaproPeriod | null;
    loadError: string | null;
}

export function ProductionEndlessSheet({ initialPage, anchor, periods, selectedPeriod, loadError }: ProductionEndlessSheetProps) {
    const win = useLedgerWindow(initialPage);
    const { rows: committed, firstItemIndex, hasOlder, hasNewer, loadingOlder, loadingNewer, notice, fetchOlder, fetchNewer } = win;

    const { user, isLoading: authLoading } = useAuth();
    const router = useRouter();
    const pathname = usePathname();
    const searchParams = useSearchParams();
    const storageKey = draftStorageKey(user?.id);

    // ─── Lock / draft state ─────────────────────────────────────────────────────────
    const [unlocked, setUnlocked] = React.useState(false);
    const [draftRows, setDraftRows] = React.useState<BulkRow[]>([]);
    const [errorRowIndices, setErrorRowIndices] = React.useState<Set<number>>(new Set());
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
    const hydratedRef = React.useRef(false);
    // Anti-runaway guard for scroll-growth: set when a bottom-reach appends blanks, cleared
    // only when the operator scrolls back UP off the bottom (atBottom → false). Because
    // atBottomStateChange only fires on a true↔false TRANSITION, one genuine bottom-reach
    // yields exactly one append; the next requires physically scrolling down again.
    const growGuardRef = React.useRef(false);

    const draftCount = React.useMemo(() => draftRows.filter((r) => !isBlankRow(r)).length, [draftRows]);

    const gridRef = React.useRef<HTMLDivElement>(null);
    const virtuosoRef = React.useRef<TableVirtuosoHandle>(null);
    const pendingScrollBottomRef = React.useRef(false);
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

        let restored: BulkRow[] = [];
        try {
            const raw = window.localStorage.getItem(storageKey);
            if (raw) restored = coerceStoredRows(JSON.parse(raw));
        } catch {
            /* corrupt / unavailable — ignore, start clean */
        }

        const wantAdd = searchParams.get('add') === '1';
        const nonBlank = restored.filter((r) => !isBlankRow(r));
        const hasDrafts = nonBlank.length > 0;
        // Restore the drafts into state but keep them DORMANT (locked → blanks/drafts aren't
        // rendered as editable rows yet). Nothing auto-unlocks when drafts exist — the operator
        // must explicitly Resume or Discard via the prompt below (restore is now consented).
        if (restored.length > 0) setDraftRows(restored);
        if (hasDrafts) {
            // Surface the Resume/Discard prompt; remember any concurrent ?add=1 intent so a
            // Discard still opens a fresh add session (see handleDiscardResume).
            setResumePrompt({ count: nonBlank.length, wantAdd });
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

    // ─── Mirror drafts → localStorage (debounced) ────────────────────────────────────
    React.useEffect(() => {
        if (!hydratedRef.current) return;
        const t = setTimeout(() => {
            try {
                if (draftRows.some((r) => !isBlankRow(r))) {
                    window.localStorage.setItem(storageKey, JSON.stringify(draftRows.filter((r) => !isBlankRow(r))));
                } else {
                    window.localStorage.removeItem(storageKey);
                }
            } catch {
                /* quota / private mode — drafts still live in state */
            }
        }, 300);
        return () => clearTimeout(t);
    }, [draftRows, storageKey]);

    // Clear the validation-error rails whenever the operator edits anything.
    React.useEffect(() => {
        setErrorRowIndices((prev) => (prev.size === 0 ? prev : new Set()));
    }, [draftRows]);

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
        setErrorRowIndices(new Set());
        setActiveCell(null);
        clearDraftMirror(); // explicit key removal (the mirror else-branch also removes it on [])
        setDraftRows([]);
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

    // ─── Draft grid hooks (coordinate space = the draftRows array) ──────────────────
    const isSelectableColumn = React.useCallback((c: number) => c !== 0 && BULK_COLUMN_MAP[c] !== null, []);
    const cellSelection = useCellSelection({
        rowCount: draftRows.length,
        colCount: BULK_COL_COUNT,
        isSelectableColumn,
        scrollContainerRef: gridRef,
        enabled: unlocked,
    });

    const getCellValue = React.useCallback(
        (rowIdx: number, colIdx: number): string => {
            const row = draftRows[rowIdx];
            if (!row) return '';
            const field = BULK_COLUMN_MAP[colIdx];
            if (!field) return '';
            return String(row[field] ?? '');
        },
        [draftRows],
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
                gridRef.current?.focus();
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

    const removeRow = React.useCallback((index: number) => {
        setDraftRows((prev) => (prev.length > 1 ? prev.filter((_, i) => i !== index) : [createEmptyRow()]));
    }, []);

    const updateRow = React.useCallback((index: number, field: BulkField, value: string) => {
        setDraftRows((prev) => {
            const next = [...prev];
            next[index] = { ...next[index], [field]: value };
            return next;
        });
    }, []);

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
            setDraftRows((prev) => {
                const raw = prev[rowIdx]?.[field];
                if (raw == null) return prev;
                const yr = selectedPeriod?.batch_year ?? new Date().getFullYear();
                const norm = normalizeTypedDate(raw, yr);
                if (norm === raw) return prev;
                const next = [...prev];
                next[rowIdx] = { ...next[rowIdx], [field]: norm };
                return next;
            });
        },
        [selectedPeriod?.batch_year],
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
        gridRef.current?.focus();
    }, [editSession]);

    const baseResolver = React.useMemo(
        () => createCoordinateNavResolver({ rowCount: draftRows.length, columnMap: BULK_COLUMN_MAP }),
        [draftRows.length],
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
                gridRef.current?.focus();
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

    // Paste engine — grows draftRows past the pool when a paste is taller; top up after.
    const { handleSmartPaste, handleGridPaste: handleGridPasteAt } = useGridPaste<BulkRow>({
        columnMap: BULK_COLUMN_MAP,
        setRows: setDraftRows,
        createEmptyRow,
        cleanCellValue: cleanBulkPasteValue,
    });
    const handleGridPaste = React.useCallback(
        (e: React.ClipboardEvent) => {
            if (!unlocked || isEditing) return;
            handleGridPasteAt(e, activeCell, () => cellSelection.clearSelection());
        },
        [unlocked, isEditing, activeCell, handleGridPasteAt, cellSelection],
    );

    // ─── Nav to a cell that isn't rendered yet → scroll it into view ────────────────
    // With a generous bottom overscan the next few blanks are already rendered, but if
    // nav lands on a far row, bring it into view so the ring + (on edit) the input show.
    const prevActiveRowRef = React.useRef<number | null>(null);
    React.useEffect(() => {
        if (!unlocked || !activeCell) {
            prevActiveRowRef.current = activeCell?.row ?? null;
            return;
        }
        if (prevActiveRowRef.current !== activeCell.row) {
            prevActiveRowRef.current = activeCell.row;
            const listIndex = committed.length + activeCell.row;
            virtuosoRef.current?.scrollIntoView({ index: listIndex });
        }
    }, [unlocked, activeCell, committed.length]);

    // ─── Save ────────────────────────────────────────────────────────────────────────
    const handleSaveDrafts = React.useCallback(async () => {
        const filled = draftRows.filter((r) => !isBlankRow(r));
        if (filled.length === 0) {
            toast.warning('Nothing to save — fill in at least one row.');
            return;
        }

        const dirtyRows: ProductionEventDirtyRow[] = [];
        const rowErrors: string[] = [];
        const badIdx = new Set<number>();
        draftRows.forEach((r, idx) => {
            if (isBlankRow(r)) return;
            const { row, errors } = mapBulkRowToDirty(r, selectedPeriod?.batch_year);
            if (errors.length > 0) {
                rowErrors.push(`${rowLabel(r, idx)}: ${errors.join('; ')}`);
                badIdx.add(idx);
            } else if (row) {
                dirtyRows.push(row);
            }
        });

        if (rowErrors.length > 0) {
            setErrorRowIndices(badIdx);
            errorToast(`${rowErrors.length} row${rowErrors.length !== 1 ? 's' : ''} can't be saved yet.`, {
                description:
                    'Fix the values below, then Save again. Categoricals must match the lookup codes ' +
                    '(e.g. shift M/E/N, grade 3X50/2X6/3.5/4X8, warehouse WHSE 1/2/3/5/7). Crusher/Kiln rows ' +
                    'need an equipment code (C1–C4 / RK1–RK4).\n\n' +
                    rowErrors.join('\n'),
            });
            return;
        }

        setIsSaving(true);
        try {
            const res = await saveProductionEvents(dirtyRows, []);
            if (!res.ok) {
                errorToast(res.error ?? 'Failed to save production rows.');
                return;
            }
            const n = res.upserted ?? dirtyRows.length;
            setDraftRows(Array.from({ length: BLANK_TARGET }, createEmptyRow));
            setErrorRowIndices(new Set());
            setActiveCell(null);
            clearDraftMirror();
            toast.success(`Saved ${n} production row${n !== 1 ? 's' : ''}`);
            // Chrome-only success cue in the toolbar (fades up, auto-clears).
            setSavedFlash(n);
            if (savedFlashTimerRef.current) clearTimeout(savedFlashTimerRef.current);
            savedFlashTimerRef.current = setTimeout(() => setSavedFlash(null), 2500);
            pendingScrollBottomRef.current = true;
            await win.refreshNewest();
        } catch (err) {
            errorToast('Unexpected error: ' + (err instanceof Error ? err.message : String(err)));
        } finally {
            setIsSaving(false);
        }
    }, [draftRows, selectedPeriod?.batch_year, clearDraftMirror, win]);

    const handleDiscardConfirm = React.useCallback(() => {
        setDiscardOpen(false);
        setErrorRowIndices(new Set());
        setActiveCell(null);
        clearDraftMirror();
        setDraftRows(Array.from({ length: BLANK_TARGET }, createEmptyRow));
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
        committed,
        draftRows,
        errorRowIndices,
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
            const prev = pos > 0 ? ctx.committed[pos - 1] : undefined;
            const monthStart = isMonthBoundary(prev, item.row);
            return renderCommittedCells(item.row, pos + 1, monthStart, monthStart ? monthLabelOf(item.row) : null);
        }
        const di = item.draftIndex;
        const row = ctx.draftRows[di] ?? createEmptyRow();
        return (
            <DraftRowCells
                draftIndex={di}
                row={row}
                hasError={ctx.errorRowIndices.has(di)}
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

    return (
        <div className="flex h-full flex-col">
            {/* Toolbar */}
            <div className="flex flex-none flex-wrap items-center gap-2 border-b bg-muted/30 px-2 py-1.5 md:px-3">
                <CenaproPeriodPicker periods={periods} selected={selectedPeriod} />
                <span className="h-4 w-px bg-border/60" />
                <ViewModeSwitcher mode="ledger" />
                <span className="h-4 w-px bg-border/60" />
                <ScopeToggle scope="endless" />
                <span className="h-4 w-px bg-border/60" />
                <span className="font-mono text-[11px] text-muted-foreground/70">
                    {committed.length.toLocaleString('en-US')} loaded
                    {(hasOlder || hasNewer) && <span className="ml-1 text-muted-foreground/50">· scroll to load more</span>}
                </span>
                <div className="flex-1" />
                {/* Post-save success cue (chrome-only, fades up then auto-clears). */}
                {savedFlash !== null && (
                    <span
                        key={savedFlash}
                        className="animate-fade-up hidden text-[10px] font-semibold text-emerald-600 dark:text-emerald-400 sm:inline"
                    >
                        Saved {savedFlash} row{savedFlash !== 1 ? 's' : ''}
                    </span>
                )}
                {!unlocked && draftCount > 0 && (
                    <span className="hidden text-[10px] font-medium text-amber-600 dark:text-amber-400 sm:inline">
                        {draftCount} draft{draftCount !== 1 ? 's' : ''} kept
                    </span>
                )}
                {!unlocked && (
                    <span className="hidden text-[10px] font-medium uppercase tracking-wide text-muted-foreground/60 md:inline">
                        Read-only · oldest → newest
                    </span>
                )}
                {/* Unlocked status hint — fades in with the drafting state (chrome, not a row). */}
                {unlocked && (
                    <span
                        className="animate-fade-in hidden font-mono text-[10px] text-muted-foreground/70 sm:inline"
                        title="Drafts are kept on this device until you Save"
                    >
                        {draftCount > 0 ? `${draftCount} ready` : 'Type or paste below'}
                    </span>
                )}
                {/* Relocated Save / Discard — beside the Add-rows toggle, only when unlocked
                    with ≥1 non-blank draft. Scales in on unlock, out on lock. Discard is the
                    ONE destructive action (AlertDialog confirm). Replaces the old floating bar. */}
                {unlocked && draftCount > 0 && (
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
                            onClick={handleSaveDrafts}
                            disabled={isSaving}
                        >
                            <Save className="h-3 w-3" />
                            {isSaving ? (
                                'Saving…'
                            ) : (
                                <span>
                                    Save{' '}
                                    <span key={draftCount} className="animate-badge-pop inline-block tabular-nums">
                                        {draftCount}
                                    </span>{' '}
                                    row{draftCount !== 1 ? 's' : ''}
                                </span>
                            )}
                        </Button>
                    </div>
                )}
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
            </div>

            {/* Resume/Discard prompt — restored unsaved drafts from a previous session. Inline,
                non-blocking chrome (NOT a modal, NOT a toast); persists until the operator picks
                Resume / Discard (or dismisses with ✕ = "later", keeping drafts + staying locked). */}
            {resumePrompt && (
                <div className="animate-fade-up mx-3 mt-3 flex flex-wrap items-center gap-3 rounded-md border border-border bg-card px-3 py-2 shadow-sm">
                    <span className="min-w-0 flex-1 text-xs text-muted-foreground">
                        You have{' '}
                        <span className="font-semibold text-foreground tabular-nums">{resumePrompt.count}</span> unsaved
                        draft row{resumePrompt.count !== 1 ? 's' : ''} from a previous session.
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
                    <Inbox className="h-8 w-8 text-muted-foreground/30" />
                    <p className="text-sm text-muted-foreground">{notice ?? 'No production events to display.'}</p>
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
                        fixedHeaderContent={HeaderRow}
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
                        <AlertDialogTitle>Discard all draft rows?</AlertDialogTitle>
                        <AlertDialogDescription>
                            This permanently clears the {draftCount} unsaved draft row{draftCount !== 1 ? 's' : ''} on the sheet
                            (and the device backup). This can&apos;t be undone.
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
