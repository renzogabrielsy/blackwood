'use client';

import * as React from 'react';
import {
    TableVirtuoso,
    type TableComponents,
    type TableProps,
    type ItemProps,
    type TableVirtuosoHandle,
} from 'react-virtuoso';
import { format, parseISO, isValid } from 'date-fns';
import {
    Loader2,
    Copy,
    Inbox,
    Lock,
    LockOpen,
    Save,
    X,
    Undo2,
    Redo2,
    Plus,
    CalendarPlus,
    Pencil,
    Trash2,
    CopyPlus,
    ExternalLink,
} from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from '@/components/ui/select';
import {
    Popover,
    PopoverAnchor,
    PopoverContent,
} from '@/components/ui/popover';
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
import { EditInput, EDIT_INPUT } from '@/components/shared/grid';
import { GridContextMenu, type GridMenuItem } from '@/components/shared/grid/GridContextMenu';
import { useGridContextMenu } from '@/lib/hooks/use-grid-context-menu';
import {
    useGridKeyboardNav,
    type NavResolver,
    type NavMove,
} from '@/lib/hooks/use-grid-keyboard-nav';
import { CenaproPeriodPicker } from './period-picker';
import { ViewModeSwitcher, ScopeToggle } from './ledger-controls';
import type { ViewMode } from './ledger-url';
import { useDailyPivotWindow, type InitialDailyPivotWindow } from './use-daily-pivot-window';
import { saveProductionEvents, type LedgerAnchor, type CenaproPeriod, type ProductionEventDirtyRow } from './actions';
import type { PlantView } from './production-sources';
import { SOURCE_SETS } from './production-sources';
import {
    CRUSHER_CODES,
    KILN_CODES,
    WAREHOUSE_CODES,
    WHSE_SIDES,
    SHIFT_CODES,
    GRADE_CODES,
} from '../types';
import type { ProductionEventRow } from '../types';
import {
    buildDateGroups,
    fmt,
    parseWeight,
    formatDayLabel,
    formatRecvLabel,
    BAGGING,
    ACTIVE_EQUIP,
    EDIT_COLUMNS,
    CRUSHER_COUNT,
    columnDisposition,
    normalizeIdentity,
    renderRecognizedIdentity,
    draftIdentityComplete,
    draftHasWeights,
    IdentitySuggestInput,
    BaggingMetaPopover,
    InsertPopover,
    navColIndex,
    MONTHS,
    W_DATE,
    W_SHIFT,
    W_GRADE,
    W_SOURCE,
    W_RECV,
    W_EQUIP,
    W_BAG,
    W_SUB,
    W_TOTAL,
    IDENTITY_WIDTH,
    LEFT_DATE,
    LEFT_SHIFT,
    LEFT_GRADE,
    LEFT_SOURCE,
    LEFT_RECV,
    ROW_H,
    CELL_PAD,
    GRID,
    GROUP,
    BOX,
    MIN_DAY_ROWS,
    SHIFT_LETTER,
    SHIFT_LABEL,
    GRADE_CHIP,
    pillBase,
    type DateGroup,
    type ShiftBlock,
    type RecvRow,
    type EditColumn,
    type NavColKey,
    type FillerDraft,
    type BaggingMeta,
    type StagedInsert,
} from './production-daily-block';

// ─── The Endless W6/W7 Daily Pivots — Phase 3b: FULLY-FEATURED EDITING ──────────────
// The pivot analog of the endless ledger, now editable. Unlocking makes the virtualized
// day-blocks a complete production data editor with the SAME loss-proofing standard as the
// rest of the rework — nothing the operator types can ever be silently destroyed.
//
// THE ONE NON-NEGOTIABLE (from the virtualization audit): NO row-local edit state anywhere.
// Virtuoso recycles day-blocks; a keystroke held in a recycled row/cell's `useState` WOULD
// be lost on scroll. So ALL pending state is PARENT-OWNED here, at the top-level component:
//   • committed edits + deletes keyed by EVENT ID (survive prepends + recycling)
//   • new-pull drafts keyed by `${prodDate}#slot-{i}` (the focus block's scheme — parent-
//     owned it survives day-block remounts)
//   • the SINGLE active in-progress edit value (`editValue`) — one cell edits at a time,
//     so a half-typed value scrolled off-screen and back rehydrates from the parent
//   • popover open-state keyed by cell id (never a captured DOM node) + rendered at the
//     PARENT level anchored to captured coords, so a scrolled-off day never orphans it
//   • keyboard nav order is DATA-DERIVED from the pivoted `groups` (+ draft slots), NOT
//     `querySelectorAll` (DOM walking stops at the virtualization boundary)
//
// The read-only renderer (locked mode) is byte-for-byte the prior Phase-2B renderer; the
// editing layer only activates when unlocked. Editing round-trips through the EXISTING
// `saveProductionEvents(dirtyRows, deletedIds)` (no new write action) then `refreshWindow()`.

const TOTAL_COLS = 5 + ACTIVE_EQUIP.length + 3;
const MIN_W = IDENTITY_WIDTH + ACTIVE_EQUIP.length * W_EQUIP + W_BAG + W_SUB + W_TOTAL;

const IDENTITY_FIELDS = ['shift', 'grade', 'source', 'recv'] as const;
type IdentityField = (typeof IDENTITY_FIELDS)[number];

// localStorage mirror key — namespaced by surface + version + plant + user. v1 for 3b.
const PIVOT_STORAGE_VERSION = 'v1';
const pivotStorageKey = (plant: PlantView, userId: string | null | undefined) =>
    `cenapro-pivot-drafts:${PIVOT_STORAGE_VERSION}:${plant}:${userId ?? 'anon'}`;

const ACTIVE_RING = 'z-20 ring-2 ring-primary ring-inset';

function monthKey(date: string): string {
    return (date ?? '').slice(0, 7);
}
function monthLabel(date: string): string {
    const d = parseISO(date);
    return isValid(d) ? format(d, 'MMMM yyyy').toUpperCase() : date;
}
function distinctDayCount(events: { prod_date: string | null }[]): number {
    const s = new Set<string>();
    for (const e of events) {
        const d = (e.prod_date ?? '').trim();
        if (d) s.add(d);
    }
    return s.size;
}

// leafKey — the pivot natural key of one "pull" (matches buildDateGroups' internal key).
function leafKeyOf(leaf: RecvRow): string {
    return `${leaf.prodDate}|${leaf.shift}|${leaf.grade}|${leaf.source}|${leaf.recvDate}`;
}
// navId encodings (opaque — we never PARSE them; we look them up in the cell map).
function navReal(leafKey: string, col: EditColumn): string {
    return `r:${leafKey}:${col}`;
}
function navDraft(slotKey: string, lane: IdentityField | EditColumn): string {
    return `d:${slotKey}:${lane}`;
}

// ─── Pending-state model — ALL parent-owned, plain-serializable (undo + localStorage) ──
interface PullEdit {
    eventIds: string[]; // events belonging to this pull (all its cells' ids)
    shift: string;
    grade: string;
    source: string;
    recvDate: string;
    warehouse?: string; // applied to bagging events in the pull
    side?: string;
}
interface PivotPending {
    modified: Record<string, string>; // eventId -> new weight (string)
    deleted: string[]; // event ids
    staged: Record<string, StagedInsert>; // cellKey -> staged real-blank insert
    drafts: Record<string, FillerDraft>; // slotKey -> new-pull draft
    pullEdits: Record<string, PullEdit>; // leafKey -> identity re-tag
    addedDays: string[]; // appended empty days (newest edge only)
    extraRows: Record<string, number>; // dayDate -> extra input-slot count (add-row drawer)
}
const EMPTY_PENDING: PivotPending = {
    modified: {},
    deleted: [],
    staged: {},
    drafts: {},
    pullEdits: {},
    addedDays: [],
    extraRows: {},
};

function clonePending(p: PivotPending): PivotPending {
    return {
        modified: { ...p.modified },
        deleted: [...p.deleted],
        staged: { ...p.staged },
        drafts: { ...p.drafts },
        pullEdits: { ...p.pullEdits },
        addedDays: [...p.addedDays],
        extraRows: { ...p.extraRows },
    };
}
function coercePending(parsed: unknown): PivotPending {
    if (!parsed || typeof parsed !== 'object') return clonePending(EMPTY_PENDING);
    const p = parsed as Partial<PivotPending>;
    return {
        modified: p.modified && typeof p.modified === 'object' ? { ...p.modified } : {},
        deleted: Array.isArray(p.deleted) ? p.deleted.filter((x): x is string => typeof x === 'string') : [],
        staged: p.staged && typeof p.staged === 'object' ? { ...p.staged } : {},
        drafts: p.drafts && typeof p.drafts === 'object' ? { ...p.drafts } : {},
        pullEdits: p.pullEdits && typeof p.pullEdits === 'object' ? { ...p.pullEdits } : {},
        addedDays: Array.isArray(p.addedDays) ? p.addedDays.filter((x): x is string => typeof x === 'string') : [],
        extraRows: p.extraRows && typeof p.extraRows === 'object' ? { ...p.extraRows } : {},
    };
}

// A committed ProductionEventRow → a ProductionEventDirtyRow (UPDATE base). All strings.
function dirtyFromEvent(src: ProductionEventRow): ProductionEventDirtyRow {
    return {
        id: src.id ?? '',
        recv_date: src.recv_date ?? '',
        prod_date: src.prod_date ?? '',
        batch: src.batch ?? '',
        shift_code: src.shift_code ?? '',
        grade_code: src.grade_code ?? '',
        plant_code: src.plant_code ?? '',
        warehouse_code: src.warehouse_code ?? '',
        source_location_code: src.source_location_code ?? '',
        weight_kg: src.weight_kg != null ? String(src.weight_kg) : '',
        disposition_kind: src.disposition_kind ?? '',
        partner_equipment_code: src.partner_equipment_code ?? '',
        flec_count: src.flec_count != null ? String(src.flec_count) : '',
        whse_side: src.whse_side ?? '',
    };
}

// Per-day batch/batch_year derivation (capability #7): a NEW pull's period comes from ITS
// OWN prod_date, never a global selection. A December pull entered in a January window
// lands in DECEMBER of its own year.
function periodOfDay(dayDate: string): { batch: string; batchYear: string } {
    const d = parseISO(dayDate);
    if (!isValid(d)) return { batch: '', batchYear: '' };
    return { batch: MONTHS[d.getMonth()], batchYear: String(d.getFullYear()) };
}

// Build the staged INSERT dirty rows for one complete draft (one per non-empty weight col).
// Per-day batch/batch_year (NOT a global period). Returns [] for an incomplete-identity draft.
function buildDraftDirtyRows(d: FillerDraft, plantView: PlantView): ProductionEventDirtyRow[] {
    if (!draftIdentityComplete(d)) return [];
    const { batch, batchYear } = periodOfDay(d.dayDate);
    const out: ProductionEventDirtyRow[] = [];
    for (const col of EDIT_COLUMNS) {
        const w = parseWeight(d.weights[col] ?? '');
        if (w == null || w <= 0) continue;
        const { disposition_kind, partner_equipment_code } = columnDisposition(col);
        const isBag = col === BAGGING;
        out.push({
            recv_date: d.recvDate,
            prod_date: d.dayDate,
            batch,
            batch_year: batchYear,
            shift_code: d.shift,
            grade_code: d.grade,
            plant_code: plantView,
            source_location_code: d.source,
            weight_kg: String(w),
            disposition_kind,
            partner_equipment_code,
            warehouse_code: isBag ? (d.bagging?.warehouse ?? '') : '',
            whse_side: isBag ? (d.bagging?.side ?? '') : '',
            flec_count: isBag ? (d.bagging?.flec ?? '').trim() : '',
        });
    }
    return out;
}

// ─── Shared colgroup + frozen header (identical to the read-only renderer) ──────────
function PivotColGroup() {
    return (
        <colgroup>
            <col style={{ width: `${W_DATE}px` }} />
            <col style={{ width: `${W_SHIFT}px` }} />
            <col style={{ width: `${W_GRADE}px` }} />
            <col style={{ width: `${W_SOURCE}px` }} />
            <col style={{ width: `${W_RECV}px` }} />
            {ACTIVE_EQUIP.map((c) => (
                <col key={c} style={{ width: `${W_EQUIP}px` }} />
            ))}
            <col style={{ width: `${W_BAG}px` }} />
            <col style={{ width: `${W_SUB}px` }} />
            <col style={{ width: `${W_TOTAL}px` }} />
        </colgroup>
    );
}

function PivotHeaderRows() {
    const crusherCols = CRUSHER_CODES;
    const kilnCols = KILN_CODES;
    return (
        <>
            <tr>
                <th rowSpan={2} className={cn('frozen-corner bg-muted px-1.5 text-left align-middle text-[10px] font-semibold uppercase tracking-wide text-muted-foreground', GRID)} style={{ left: LEFT_DATE }}>Date</th>
                <th rowSpan={2} className={cn('frozen-corner bg-muted px-1 text-center align-middle text-[10px] font-semibold uppercase tracking-wide text-muted-foreground', GRID)} style={{ left: LEFT_SHIFT }}>SHFT</th>
                <th rowSpan={2} className={cn('frozen-corner bg-muted px-1.5 text-left align-middle text-[10px] font-semibold uppercase tracking-wide text-muted-foreground', GRID)} style={{ left: LEFT_GRADE }}>Grade</th>
                <th rowSpan={2} className={cn('frozen-corner bg-muted px-1.5 text-left align-middle text-[10px] font-semibold uppercase tracking-wide text-muted-foreground', GRID)} style={{ left: LEFT_SOURCE }}>Source</th>
                <th rowSpan={2} className={cn('frozen-corner frozen-edge bg-muted px-1.5 text-left align-middle text-[10px] font-semibold uppercase tracking-wide text-muted-foreground', GRID)} style={{ left: LEFT_RECV }}>Recv Date</th>
                <th colSpan={crusherCols.length} className={cn('h-6 bg-amber-500/5 px-2 text-center text-[9px] font-semibold uppercase tracking-[0.12em] text-amber-700/80 dark:text-amber-400/80', GRID, GROUP)}>Crushers</th>
                <th colSpan={kilnCols.length} className={cn('h-6 bg-rose-500/5 px-2 text-center text-[9px] font-semibold uppercase tracking-[0.12em] text-rose-700/80 dark:text-rose-400/80', GRID, GROUP)}>Kilns</th>
                <th className={cn('h-6 bg-emerald-500/5 px-2 text-center text-[9px] font-semibold uppercase tracking-[0.12em] text-emerald-700/80 dark:text-emerald-400/80', GRID, GROUP)}>Bagging</th>
                <th colSpan={2} className={cn('h-6 bg-muted px-2 text-center text-[9px] font-semibold uppercase tracking-[0.12em] text-muted-foreground', GRID, GROUP)}>Totals</th>
            </tr>
            <tr>
                {ACTIVE_EQUIP.map((c, i) => (
                    <th key={c} className={cn('h-7 px-1.5 text-right text-[10px] font-semibold tracking-wide text-muted-foreground', GRID, (i === 0 || i === crusherCols.length) && GROUP)}>{c}</th>
                ))}
                <th className={cn('h-7 px-1.5 text-right text-[10px] font-semibold tracking-wide text-emerald-700/80 dark:text-emerald-400/80', GRID, GROUP)}>Bag</th>
                <th className={cn('h-7 px-1.5 text-right text-[10px] font-semibold tracking-wide text-muted-foreground', GRID, GROUP)}>Sub</th>
                <th className={cn('h-7 px-1.5 text-right text-[10px] font-semibold tracking-wide text-muted-foreground', GRID)}>Total</th>
            </tr>
        </>
    );
}

// ─── Edit context threaded to every day-block (recreated each render → recycle-safe) ──
interface PivotEditCtx {
    unlocked: boolean;
    plantView: PlantView;
    pending: PivotPending;
    deletedSet: Set<string>;
    eventsById: Map<string, ProductionEventRow>;
    // active-cell / editing model
    activeNavId: string | null;
    editingNavId: string | null;
    getCellValue: (navId: string) => string;
    onActivate: (navId: string) => void;
    onStartEdit: (navId: string, char?: string) => void;
    onEditChange: (v: string) => void;
    onCommitEditing: () => void;
    onRevertEditing: () => void;
    // real-cell mutators
    onDeleteEvent: (eventId: string) => void;
    ledgerHrefForLeaf: (leaf: RecvRow) => string;
    // row context menu
    openRowMenu: (leaf: RecvRow, x: number, y: number) => void;
    // per-day drawer + day menu
    addExtraRow: (dayDate: string) => void;
    openDayMenu: (dayDate: string, group: DateGroup | null, isAdded: boolean, x: number, y: number) => void;
}

// ─── One editable / read-only cell — pure presentation, parent-owned value ────────────
// STATIC when not editing (focusable div, data-navid); EDIT when editingNavId === navId.
// Every value read/write routes through the parent ctx (recycle-safe). Locked collision
// cells are read-only with an "open in Ledger" hint.
function PivotCell({
    navId,
    variant,
    ctx,
    align = 'right',
    valueClass,
    identityCol,
    locked,
    ledgerHref,
    tint,
}: {
    navId: string;
    variant: 'weight' | 'identity';
    ctx: PivotEditCtx;
    align?: 'left' | 'right' | 'center';
    valueClass?: string;
    identityCol?: NavColKey;
    locked?: boolean;
    ledgerHref?: string;
    tint?: string;
}) {
    const value = ctx.getCellValue(navId);
    const isActive = ctx.activeNavId === navId;
    const isEditing = ctx.editingNavId === navId;
    const textAlign = align === 'right' ? 'text-right' : align === 'center' ? 'text-center' : 'text-left';

    if (locked) {
        return (
            <div className="flex h-full w-full items-center justify-end gap-1 px-1.5 text-muted-foreground" title="Multiple entries — edit in the Ledger">
                <Lock className="h-2.5 w-2.5 opacity-60" />
                <span className="font-mono text-[11px]">{value ? fmt(Number(value) || 0) : ''}</span>
                {ledgerHref && (
                    <a
                        href={ledgerHref}
                        className="text-primary/70 hover:text-primary"
                        title="Open this date in the Ledger"
                        onMouseDown={(e) => e.stopPropagation()}
                    >
                        <ExternalLink className="h-2.5 w-2.5" />
                    </a>
                )}
            </div>
        );
    }

    if (isEditing) {
        if (variant === 'identity' && identityCol) {
            const options =
                identityCol === 'shift' ? SHIFT_CODES
                    : identityCol === 'grade' ? GRADE_CODES
                        : identityCol === 'source' ? SOURCE_SETS[ctx.plantView]
                            : [];
            return (
                <IdentitySuggestInput
                    value={value}
                    onChange={ctx.onEditChange}
                    onCommit={ctx.onCommitEditing}
                    onEscape={ctx.onRevertEditing}
                    options={options}
                    align={align}
                    navId={navId}
                    onActivate={() => ctx.onActivate(navId)}
                />
            );
        }
        return (
            <EditInput
                autoFocus
                value={value}
                onChange={ctx.onEditChange}
                onCommit={ctx.onCommitEditing}
                onEscape={ctx.onRevertEditing}
                align={align}
                inputMode={variant === 'weight' ? 'decimal' : undefined}
                valueClass={valueClass}
                navId={navId}
                onActivate={() => ctx.onActivate(navId)}
            />
        );
    }

    const showPlaceholder = value === '';
    return (
        <div
            data-navid={navId}
            tabIndex={0}
            role="gridcell"
            onMouseDown={() => ctx.onActivate(navId)}
            onFocus={() => ctx.onActivate(navId)}
            onDoubleClick={() => ctx.onStartEdit(navId)}
            className={cn(
                EDIT_INPUT,
                'flex items-center overflow-hidden whitespace-nowrap font-mono tabular-nums outline-none cursor-text',
                align === 'right' ? 'justify-end' : align === 'center' ? 'justify-center' : 'justify-start',
                textAlign,
                tint,
                isActive && ACTIVE_RING,
                valueClass,
            )}
        >
            {showPlaceholder ? (
                <span className="text-muted-foreground/30" />
            ) : variant === 'identity' && identityCol ? (
                renderRecognizedIdentity(identityCol, value, ctx.plantView)
            ) : (
                fmt(Number(value.replace(/[, ]/g, '')) || 0)
            )}
        </div>
    );
}

// ─── One EDITABLE day-block (nested table, mirrors the read-only DayBlock + focus block) ─
function EditableDayBlock({ group, date, isAdded, ctx }: { group: DateGroup | null; date: string; isAdded: boolean; ctx: PivotEditCtx }) {
    const { unlocked, pending, deletedSet } = ctx;
    const shiftSpan = (s: ShiftBlock) => s.grades.reduce((acc, g) => acc + g.leafCount, 0);
    const dayBodySpan = group ? group.shifts.reduce((acc, s) => acc + shiftSpan(s), 0) : 0;

    // Draft slots for this day (parent-owned; keyed by ${date}#slot-i). Occupied slots hold
    // a draft; the pool always keeps ≥1 trailing empty slot + drawer extras.
    const dayDrafts = React.useMemo(
        () => Object.values(pending.drafts).filter((d) => d.dayDate === date),
        [pending.drafts, date],
    );
    const filledDrafts = dayDrafts.filter(
        (d) => draftIdentityComplete(d) || draftHasWeights(d) || d.shift || d.grade || d.source || d.recvDate,
    );
    const draftByKey = React.useMemo(() => {
        const m = new Map<string, FillerDraft>();
        for (const d of filledDrafts) m.set(d.key, d);
        return m;
    }, [filledDrafts]);
    const maxDraftSlotIdx = React.useMemo(() => {
        let max = -1;
        for (const d of filledDrafts) {
            const mm = d.key.match(/#slot-(\d+)$/);
            if (mm) max = Math.max(max, Number(mm[1]));
        }
        return max;
    }, [filledDrafts]);

    const extraRows = unlocked ? (pending.extraRows[date] ?? 0) : 0;
    const baseSlots = unlocked ? Math.max(0, MIN_DAY_ROWS - dayBodySpan) : Math.max(0, MIN_DAY_ROWS - dayBodySpan);
    // Locked (read-only) mode: keep the sparse-day padding to MIN_DAY_ROWS (as before), no
    // input slots. Unlocked: full editable slot pool.
    const slotCount = unlocked
        ? Math.max(baseSlots, maxDraftSlotIdx + 2, filledDrafts.length + 1) + extraRows
        : baseSlots;
    const slotIds = Array.from({ length: slotCount }, (_, i) => `${date}#slot-${i}`);
    const orphanDrafts = unlocked ? filledDrafts.filter((d) => !slotIds.includes(d.key)) : [];
    const renderRows = slotIds.length + orphanDrafts.length;
    const dateRowSpan = dayBodySpan + renderRows;

    let dayRowEmitted = false;

    // Effective per-day totals (base + pending edits/deletes/drafts).
    const daily = React.useMemo(() => {
        const equip = ACTIVE_EQUIP.reduce((acc, c) => { acc[c] = 0; return acc; }, {} as Record<EditColumn, number>);
        let bagging = 0;
        if (group) {
            for (const shiftBlock of group.shifts) {
                for (const gradeBlock of shiftBlock.grades) {
                    for (const srcBlock of gradeBlock.sources) {
                        for (const leaf of srcBlock.recvRows) {
                            for (const col of ACTIVE_EQUIP) equip[col] += effectiveRealWeight(leaf, col, ctx);
                            bagging += effectiveRealWeight(leaf, BAGGING, ctx);
                        }
                    }
                }
            }
        }
        for (const d of dayDrafts) {
            for (const c of ACTIVE_EQUIP) { const w = parseWeight(d.weights[c] ?? ''); if (w && w > 0) equip[c] += w; }
            const bw = parseWeight(d.weights[BAGGING] ?? ''); if (bw && bw > 0) bagging += bw;
        }
        const subTotal = ACTIVE_EQUIP.reduce((s, c) => s + equip[c], 0);
        return { equip, bagging, subTotal, total: subTotal + bagging };
    }, [group, dayDrafts, ctx]);

    // Whether the whole day is staged for deletion (Delete day) — all leaf event ids deleted.
    const dayFullyDeleted = React.useMemo(() => {
        if (!group) return false;
        const ids = collectDayEventIds(group);
        return ids.length > 0 && ids.every((id) => deletedSet.has(id));
    }, [group, deletedSet]);

    const boxColor = isAdded ? 'border-primary/50' : BOX;

    return (
        <table
            className={cn('table-fixed text-[11px]', dayFullyDeleted && 'opacity-50')}
            style={{ width: 'max-content', minWidth: `${MIN_W}px`, borderCollapse: 'separate', borderSpacing: 0 }}
        >
            <PivotColGroup />
            <tbody className="group/day">
                {/* ── REAL merged rows ── */}
                {group?.shifts.map((shiftBlock, sIdx) => (
                    shiftBlock.grades.map((gradeBlock, gIdx) => (
                        <React.Fragment key={`${shiftBlock.shift}-${gradeBlock.grade}`}>
                            {gradeBlock.sources.map((srcBlock, srcIdx) => (
                                srcBlock.recvRows.map((leaf, rIdx) => {
                                    const isSrcFirst = rIdx === 0;
                                    const isGradeFirst = srcIdx === 0 && rIdx === 0;
                                    const isShiftFirst = gIdx === 0 && isGradeFirst;
                                    const isDayFirst = sIdx === 0 && isShiftFirst && !dayRowEmitted;
                                    if (isDayFirst) dayRowEmitted = true;
                                    const boxTop = (sIdx === 0 && isShiftFirst) ? cn('border-t-2', boxColor) : '';
                                    const lk = leafKeyOf(leaf);
                                    const leafDeleted = leafFullyDeleted(leaf, deletedSet);

                                    const dateCell = isDayFirst ? (
                                        <td rowSpan={dateRowSpan} className={cn('frozen-col bg-background px-1.5 align-top font-bold', GRID, 'border-t-2 border-l-2', boxColor)} style={{ left: LEFT_DATE }}>
                                            <span className="whitespace-nowrap text-[11px] font-bold leading-tight tracking-tight text-foreground" title={leaf.prodDate}>{formatDayLabel(leaf.prodDate)}</span>
                                        </td>
                                    ) : null;
                                    const shiftCell = isShiftFirst ? (
                                        <td rowSpan={shiftSpan(shiftBlock)} className={cn('frozen-col bg-background px-1 text-center align-top font-bold', GRID, boxTop)} style={{ left: LEFT_SHIFT }} title={SHIFT_LABEL[shiftBlock.shift] ?? shiftBlock.shift}>
                                            <span className={cn('text-[12px] font-bold leading-none', SHIFT_LETTER[shiftBlock.shift] ?? 'text-muted-foreground')}>{shiftBlock.shift}</span>
                                        </td>
                                    ) : null;
                                    const gradeCell = isGradeFirst ? (
                                        <td rowSpan={gradeBlock.leafCount} className={cn('frozen-col bg-background px-1.5 align-top', GRID, boxTop)} style={{ left: LEFT_GRADE }}>
                                            <span className={cn(pillBase, 'mt-0.5', GRADE_CHIP[gradeBlock.grade] ?? 'bg-muted text-muted-foreground ring-border')}>{gradeBlock.grade}</span>
                                        </td>
                                    ) : null;
                                    const sourceCell = isSrcFirst ? (
                                        <td rowSpan={srcBlock.recvRows.length} className={cn('frozen-col bg-background px-1.5 align-top font-bold', GRID, boxTop)} style={{ left: LEFT_SOURCE }}>
                                            <span className="font-mono text-[11px] font-bold text-foreground/90">{srcBlock.source}</span>
                                        </td>
                                    ) : null;

                                    return (
                                        <tr
                                            key={lk}
                                            className={cn(ROW_H, 'transition-colors duration-150 hover:bg-muted/30', leafDeleted && 'bg-rose-500/[0.06] line-through opacity-50')}
                                            onContextMenu={unlocked ? (e) => { e.preventDefault(); ctx.openRowMenu(leaf, e.clientX, e.clientY); } : undefined}
                                        >
                                            {dateCell}
                                            {shiftCell}
                                            {gradeCell}
                                            {sourceCell}
                                            <td className={cn('frozen-col frozen-edge bg-background align-middle', CELL_PAD, GRID, boxTop)} style={{ left: LEFT_RECV }}>
                                                <span className="font-mono text-[11px] font-bold leading-none text-foreground/80">{formatRecvLabel(leaf.recvDate)}</span>
                                            </td>
                                            {ACTIVE_EQUIP.map((c, i) => (
                                                <RealWeightTd key={c} leaf={leaf} col={c} lk={lk} ctx={ctx} extraClass={cn(boxTop, (i === 0 || i === CRUSHER_COUNT) && GROUP)} />
                                            ))}
                                            <RealWeightTd leaf={leaf} col={BAGGING} lk={lk} ctx={ctx} extraClass={cn(boxTop, GROUP)} valueClass="text-emerald-700 dark:text-emerald-400" />
                                            <td className={cn(CELL_PAD, 'text-right align-middle font-mono text-[11px] leading-none tabular-nums text-muted-foreground', GRID, boxTop, GROUP)}>{fmt(effectiveLeafSub(leaf, ctx))}</td>
                                            <td className={cn(CELL_PAD, 'text-right align-middle font-mono text-[11px] font-semibold leading-none tabular-nums', GRID, boxTop, 'border-r-2', boxColor)}>{fmt(effectiveLeafTotal(leaf, ctx))}</td>
                                        </tr>
                                    );
                                })
                            ))}
                        </React.Fragment>
                    ))
                ))}

                {/* ── FILLER / DRAFT slot rows (unlocked) or read-only padding (locked) ── */}
                {unlocked
                    ? [
                        ...slotIds.map((sid) => ({ slotKey: sid, draft: draftByKey.get(sid) ?? null })),
                        ...orphanDrafts.map((d) => ({ slotKey: d.key, draft: d })),
                    ].map(({ slotKey, draft }) => {
                        const isDayFirst = !dayRowEmitted;
                        if (isDayFirst) dayRowEmitted = true;
                        const boxTop = isDayFirst ? cn('border-t-2', boxColor) : '';
                        const dateCell = isDayFirst ? (
                            <td rowSpan={dateRowSpan} className={cn('frozen-col bg-background px-1.5 align-top font-bold', GRID, 'border-t-2 border-l-2', boxColor)} style={{ left: LEFT_DATE }}>
                                <span className="whitespace-nowrap text-[11px] font-bold leading-tight tracking-tight text-foreground" title={date}>{formatDayLabel(date)}</span>
                            </td>
                        ) : null;
                        return (
                            <PivotFillerRow key={slotKey} slotKey={slotKey} draft={draft} dayDate={date} dateCell={dateCell} boxTop={boxTop} boxColor={boxColor} ctx={ctx} />
                        );
                    })
                    : Array.from({ length: slotCount }).map((_, i) => {
                        const isDayFirst = !dayRowEmitted;
                        if (isDayFirst) dayRowEmitted = true;
                        const boxTop = isDayFirst ? cn('border-t-2', boxColor) : '';
                        const dateCell = isDayFirst ? (
                            <td rowSpan={dateRowSpan} className={cn('frozen-col bg-background px-1.5 align-top font-bold', GRID, 'border-t-2 border-l-2', boxColor)} style={{ left: LEFT_DATE }}>
                                <span className="whitespace-nowrap text-[11px] font-bold leading-tight tracking-tight text-foreground" title={date}>{formatDayLabel(date)}</span>
                            </td>
                        ) : null;
                        return (
                            <tr key={`filler-${i}`} className={ROW_H}>
                                {dateCell}
                                <td className={cn('frozen-col bg-background', CELL_PAD, GRID, boxTop)} style={{ left: LEFT_SHIFT }} />
                                <td className={cn('frozen-col bg-background', CELL_PAD, GRID, boxTop)} style={{ left: LEFT_GRADE }} />
                                <td className={cn('frozen-col bg-background', CELL_PAD, GRID, boxTop)} style={{ left: LEFT_SOURCE }} />
                                <td className={cn('frozen-col frozen-edge bg-background', CELL_PAD, GRID, boxTop)} style={{ left: LEFT_RECV }} />
                                {ACTIVE_EQUIP.map((c, ci) => (
                                    <td key={c} className={cn(CELL_PAD, 'bg-muted/30', GRID, boxTop, (ci === 0 || ci === CRUSHER_COUNT) && GROUP)} />
                                ))}
                                <td className={cn(CELL_PAD, 'bg-muted/30', GRID, boxTop, GROUP)} />
                                <td className={cn(CELL_PAD, 'bg-muted/30', GRID, boxTop, GROUP)} />
                                <td className={cn(CELL_PAD, 'bg-muted/30', GRID, boxTop, 'border-r-2', boxColor)} />
                            </tr>
                        );
                    })}

                {/* ── DAY FOOTER (per-day rollup) — hover-reveal Add-row + day menu (unlocked) ── */}
                <tr className={cn(ROW_H, 'bg-muted')}>
                    <td colSpan={5} className={cn('frozen-col frozen-edge relative bg-muted px-2 align-middle', CELL_PAD, GRID, 'border-t-2 border-b-2 border-l-2', boxColor)} style={{ left: LEFT_DATE }}>
                        <span className="text-[10px] font-bold uppercase leading-none tracking-wide text-foreground/80">Daily total</span>
                        {unlocked && (
                            <>
                                <button
                                    type="button"
                                    onClick={() => ctx.addExtraRow(date)}
                                    title="Add an input row to this day"
                                    className="absolute left-1/2 top-0 z-20 inline-flex -translate-x-1/2 -translate-y-1/2 items-center gap-1 rounded-full border border-border bg-background px-2 py-0.5 text-[10px] font-medium text-muted-foreground opacity-0 shadow-sm transition-opacity duration-150 hover:text-foreground group-hover/day:opacity-100"
                                >
                                    <Plus className="h-3 w-3" />Add row
                                </button>
                                <button
                                    type="button"
                                    onClick={(e) => ctx.openDayMenu(date, group, isAdded, e.clientX, e.clientY)}
                                    title="Day actions (delete / remove)"
                                    className="absolute right-1 top-1/2 z-20 inline-flex -translate-y-1/2 items-center gap-0.5 rounded border border-border/60 bg-background px-1 py-0.5 text-[9px] font-medium text-muted-foreground opacity-0 shadow-sm transition-opacity duration-150 hover:text-destructive group-hover/day:opacity-100"
                                >
                                    <Trash2 className="h-2.5 w-2.5" />Day
                                </button>
                            </>
                        )}
                    </td>
                    {ACTIVE_EQUIP.map((c, i) => (
                        <td key={c} className={cn(CELL_PAD, 'text-right align-middle font-mono text-[11px] leading-none tabular-nums', GRID, 'border-t-2 border-b-2', boxColor, (i === 0 || i === CRUSHER_COUNT) && GROUP, 'bg-muted font-bold')}>{fmt(daily.equip[c])}</td>
                    ))}
                    <td className={cn(CELL_PAD, 'text-right align-middle font-mono text-[11px] leading-none tabular-nums', GRID, 'border-t-2 border-b-2', boxColor, GROUP, 'bg-muted font-bold text-emerald-700 dark:text-emerald-400')}>{fmt(daily.bagging)}</td>
                    <td className={cn(CELL_PAD, 'text-right align-middle font-mono text-[11px] leading-none tabular-nums', GRID, 'border-t-2 border-b-2', boxColor, GROUP, 'bg-muted font-bold')}>{fmt(daily.subTotal)}</td>
                    <td className={cn(CELL_PAD, 'text-right align-middle font-mono text-[11px] leading-none tabular-nums', GRID, 'border-t-2 border-b-2 border-r-2', boxColor, 'bg-muted font-bold')}>{fmt(daily.total)}</td>
                </tr>
            </tbody>
        </table>
    );
}

// One real-pull weight <td> (applies the active ring + dirty tint on the td so it layers
// over the frozen edge).
function RealWeightTd({ leaf, col, lk, ctx, extraClass, valueClass }: { leaf: RecvRow; col: EditColumn; lk: string; ctx: PivotEditCtx; extraClass?: string; valueClass?: string }) {
    const slot = leaf.cells[col];
    const locked = slot.eventIds.length > 1;
    const cellKey = `${lk}|${col}`;
    const eventId = slot.eventIds.length === 1 ? slot.eventIds[0] : null;
    const staged = ctx.pending.staged[cellKey];
    const modified = eventId ? ctx.pending.modified[eventId] : undefined;
    const isDeleted = eventId ? ctx.deletedSet.has(eventId) : false;
    const navId = navReal(lk, col);
    let tint = '';
    if (staged) tint = 'bg-blue-500/10 ring-1 ring-inset ring-blue-500/40';
    else if (isDeleted) tint = 'bg-destructive/10 ring-1 ring-inset ring-destructive/40';
    else if (modified !== undefined) tint = 'bg-amber-500/10 ring-1 ring-inset ring-amber-500/40';
    return (
        <td className={cn('relative h-7 p-0 align-middle text-right font-mono text-[11px] tabular-nums', GRID, extraClass)}>
            {ctx.unlocked ? (
                <PivotCell
                    navId={navId}
                    variant="weight"
                    ctx={ctx}
                    align="right"
                    valueClass={cn(isDeleted && 'text-destructive line-through', valueClass)}
                    locked={locked}
                    ledgerHref={locked ? ctx.ledgerHrefForLeaf(leaf) : undefined}
                    tint={tint}
                />
            ) : (
                <span className={cn('block w-full px-1.5 py-0.5 text-[11px] leading-none', valueClass)}>{fmt(slot.weight)}</span>
            )}
        </td>
    );
}

// ─── One editable draft / filler row (flat, fully editable) ───────────────────────────
function PivotFillerRow({ slotKey, draft, dayDate, dateCell, boxTop, boxColor, ctx }: {
    slotKey: string;
    draft: FillerDraft | null;
    dayDate: string;
    dateCell: React.ReactNode;
    boxTop: string;
    boxColor: string;
    ctx: PivotEditCtx;
}) {
    void dayDate;
    const cellBase = cn('frozen-col bg-background p-0 align-middle h-7', GRID, boxTop);
    const subNum = ACTIVE_EQUIP.reduce((s, c) => s + (parseWeight(draft?.weights[c] ?? '') ?? 0), 0);
    const totalNum = EDIT_COLUMNS.reduce((s, c) => s + (parseWeight(draft?.weights[c] ?? '') ?? 0), 0);
    return (
        <tr className={cn(ROW_H, 'bg-blue-500/[0.03] transition-colors duration-150 hover:bg-muted/30')}>
            {dateCell}
            <td className={cn(cellBase)} style={{ left: LEFT_SHIFT }}>
                <PivotCell navId={navDraft(slotKey, 'shift')} variant="identity" identityCol="shift" ctx={ctx} align="center" />
            </td>
            <td className={cn(cellBase)} style={{ left: LEFT_GRADE }}>
                <PivotCell navId={navDraft(slotKey, 'grade')} variant="identity" identityCol="grade" ctx={ctx} align="left" />
            </td>
            <td className={cn(cellBase)} style={{ left: LEFT_SOURCE }}>
                <PivotCell navId={navDraft(slotKey, 'source')} variant="identity" identityCol="source" ctx={ctx} align="left" />
            </td>
            <td className={cn('frozen-col frozen-edge bg-background p-0 align-middle h-7', GRID, boxTop)} style={{ left: LEFT_RECV }}>
                <PivotCell navId={navDraft(slotKey, 'recv')} variant="identity" identityCol="recv" ctx={ctx} align="left" />
            </td>
            {ACTIVE_EQUIP.map((c, i) => (
                <td key={c} className={cn('relative h-7 p-0 align-middle text-right font-mono text-[11px] tabular-nums', GRID, boxTop, (i === 0 || i === CRUSHER_COUNT) && GROUP)}>
                    <PivotCell navId={navDraft(slotKey, c)} variant="weight" ctx={ctx} align="right" />
                </td>
            ))}
            <td className={cn('relative h-7 p-0 align-middle text-right font-mono text-[11px] tabular-nums', GRID, boxTop, GROUP)}>
                <PivotCell navId={navDraft(slotKey, BAGGING)} variant="weight" ctx={ctx} align="right" valueClass="text-emerald-700 dark:text-emerald-400" />
            </td>
            <td className={cn(CELL_PAD, 'text-right align-middle font-mono text-[11px] tabular-nums text-muted-foreground', GRID, boxTop, GROUP)}>{fmt(subNum)}</td>
            <td className={cn(CELL_PAD, 'text-right align-middle font-mono text-[11px] font-semibold tabular-nums', GRID, boxTop, 'border-r-2', boxColor)}>{fmt(totalNum)}</td>
        </tr>
    );
}

// ─── Effective-value helpers (base pivot ⊕ pending overlay) ──────────────────────────
function effectiveRealWeight(leaf: RecvRow, col: EditColumn, ctx: PivotEditCtx): number {
    const slot = leaf.cells[col];
    if (slot.eventIds.length > 1) return slot.weight; // locked — base only
    const cellKey = `${leafKeyOf(leaf)}|${col}`;
    const staged = ctx.pending.staged[cellKey];
    if (staged) return parseWeight(staged.row.weight_kg) ?? 0;
    const eventId = slot.eventIds.length === 1 ? slot.eventIds[0] : null;
    if (eventId && ctx.deletedSet.has(eventId)) return 0;
    if (eventId && ctx.pending.modified[eventId] !== undefined) return parseWeight(ctx.pending.modified[eventId]) ?? 0;
    return slot.weight;
}
function effectiveLeafSub(leaf: RecvRow, ctx: PivotEditCtx): number {
    // ACTIVE_EQUIP is the equipment codes only (Bagging is separate) — sum them all.
    return ACTIVE_EQUIP.reduce((s, c) => s + effectiveRealWeight(leaf, c, ctx), 0);
}
function effectiveLeafTotal(leaf: RecvRow, ctx: PivotEditCtx): number {
    return effectiveLeafSub(leaf, ctx) + effectiveRealWeight(leaf, BAGGING, ctx);
}
function collectDayEventIds(group: DateGroup): string[] {
    const ids = new Set<string>();
    for (const sh of group.shifts) for (const gr of sh.grades) for (const src of gr.sources) for (const leaf of src.recvRows) {
        for (const col of ACTIVE_EQUIP) for (const id of leaf.cells[col].eventIds) ids.add(id);
    }
    return [...ids];
}
function collectLeafEventIds(leaf: RecvRow): string[] {
    const ids = new Set<string>();
    for (const col of ACTIVE_EQUIP) for (const id of leaf.cells[col].eventIds) ids.add(id);
    return [...ids];
}
function leafFullyDeleted(leaf: RecvRow, deletedSet: Set<string>): boolean {
    const ids = collectLeafEventIds(leaf);
    return ids.length > 0 && ids.every((id) => deletedSet.has(id));
}

// ─── Slim month separator ──────────────────────────────────────────────────────────
function MonthSeparator({ label }: { label: string }) {
    return (
        <div className="sticky left-0 flex items-center gap-2 px-2 py-1">
            <span className="text-[10px] font-bold uppercase tracking-[0.14em] text-primary/80">{label}</span>
            <span className="h-px flex-1 bg-primary/20" />
        </div>
    );
}

// ─── Virtuoso components ─────────────────────────────────────────────────────────────
interface PivotVCtx {
    firstItemIndex: number;
    rows: RenderDay[];
    editCtx: PivotEditCtx;
}
interface RenderDay {
    date: string;
    group: DateGroup | null;
    isAdded: boolean;
}

const PivotScroller = React.forwardRef<HTMLDivElement, React.ComponentProps<'div'> & { context?: unknown }>(
    function PivotScroller({ style, context: _ctx, ...props }, ref) {
        void _ctx;
        return <div ref={ref} {...props} className="outline-none" style={{ overflowX: 'auto', ...style }} />;
    },
);
const PivotTable = ({ style, children }: TableProps) => (
    <table
        className="relative table-fixed border border-border text-[11px]"
        style={{ ...style, width: 'max-content', minWidth: MIN_W, borderCollapse: 'separate', borderSpacing: 0 }}
    >
        <PivotColGroup />
        {children}
    </table>
);
const PivotTableHead = React.forwardRef<HTMLTableSectionElement, React.ComponentProps<'thead'> & { context?: unknown }>(
    function PivotTableHead({ style, context: _ctx, ...props }, ref) {
        void _ctx;
        return <thead ref={ref} {...props} className="frozen-row bg-muted" style={{ ...style, zIndex: 20 }} />;
    },
);
const PivotTableRow = ({ item: _item, context: _context, children, ...props }: ItemProps<RenderDay> & { context?: PivotVCtx }) => {
    void _item;
    void _context;
    return (
        <tr {...props} className="align-top">
            {children}
        </tr>
    );
};
const pivotComponents: TableComponents<RenderDay, PivotVCtx> = {
    Scroller: PivotScroller,
    Table: PivotTable,
    TableHead: PivotTableHead,
    TableRow: PivotTableRow,
};

// ─── Data-derived navigation model ──────────────────────────────────────────────────
// Build the ordered navigable-cell list + per-row lane index straight from the pivoted
// days (+ draft slots) — NEVER from the DOM (querySelectorAll stops at the virtualization
// boundary). Real pull rows expose only their weight cells (identity is edited via the
// row-level Edit-pull editor, not inline). Draft rows expose identity + weight cells.
interface NavCell {
    navId: string;
    rowKey: string;
    lane: NavColKey;
    dayDate: string;
    editable: boolean;
}
function buildNavModel(rows: RenderDay[], editCtx: PivotEditCtx): {
    order: string[];
    byId: Map<string, NavCell>;
    rowKeys: string[];
    rowCells: Map<string, NavCell[]>;
    dayIndexByDate: Map<string, number>;
} {
    const order: string[] = [];
    const byId = new Map<string, NavCell>();
    const rowKeys: string[] = [];
    const rowCells = new Map<string, NavCell[]>();
    const dayIndexByDate = new Map<string, number>();
    const push = (c: NavCell) => {
        order.push(c.navId);
        byId.set(c.navId, c);
        if (!rowCells.has(c.rowKey)) { rowCells.set(c.rowKey, []); rowKeys.push(c.rowKey); }
        rowCells.get(c.rowKey)!.push(c);
    };
    rows.forEach((rd, di) => {
        dayIndexByDate.set(rd.date, di);
        const group = rd.group;
        if (group) {
            for (const sh of group.shifts) for (const gr of sh.grades) for (const src of gr.sources) for (const leaf of src.recvRows) {
                const lk = leafKeyOf(leaf);
                for (const col of ACTIVE_EQUIP) {
                    const slot = leaf.cells[col];
                    const locked = slot.eventIds.length > 1;
                    push({ navId: navReal(lk, col), rowKey: `real:${lk}`, lane: col, dayDate: rd.date, editable: !locked });
                }
            }
        }
        // draft slots (data-derived count mirrors EditableDayBlock)
        const dayBodySpan = group ? group.shifts.reduce((a, s) => a + s.grades.reduce((x, g) => x + g.leafCount, 0), 0) : 0;
        const dayDrafts = Object.values(editCtx.pending.drafts).filter((d) => d.dayDate === rd.date);
        const filled = dayDrafts.filter((d) => draftIdentityComplete(d) || draftHasWeights(d) || d.shift || d.grade || d.source || d.recvDate);
        let maxIdx = -1;
        for (const d of filled) { const m = d.key.match(/#slot-(\d+)$/); if (m) maxIdx = Math.max(maxIdx, Number(m[1])); }
        const extra = editCtx.pending.extraRows[rd.date] ?? 0;
        const slotCount = Math.max(Math.max(0, MIN_DAY_ROWS - dayBodySpan), maxIdx + 2, filled.length + 1) + extra;
        const slotIds = Array.from({ length: slotCount }, (_, i) => `${rd.date}#slot-${i}`);
        const filledKeys = new Set(filled.map((d) => d.key));
        const orphans = filled.filter((d) => !slotIds.includes(d.key)).map((d) => d.key);
        const allSlots = [...slotIds, ...orphans];
        for (const sk of allSlots) {
            void filledKeys;
            for (const f of IDENTITY_FIELDS) push({ navId: navDraft(sk, f), rowKey: `draft:${sk}`, lane: f, dayDate: rd.date, editable: true });
            for (const col of ACTIVE_EQUIP) push({ navId: navDraft(sk, col), rowKey: `draft:${sk}`, lane: col, dayDate: rd.date, editable: true });
        }
    });
    return { order, byId, rowKeys, rowCells, dayIndexByDate };
}

export interface ProductionEndlessPivotsProps {
    initialWindow: InitialDailyPivotWindow;
    anchor: LedgerAnchor;
    plantView: PlantView;
    view: ViewMode;
    periods: CenaproPeriod[];
    selectedPeriod: CenaproPeriod | null;
    loadError: string | null;
}

export function ProductionEndlessPivots({
    initialWindow,
    anchor,
    plantView,
    view,
    periods,
    selectedPeriod,
    loadError,
}: ProductionEndlessPivotsProps) {
    const win = useDailyPivotWindow(initialWindow, plantView);
    const { events, firstItemIndex, hasOlder, hasNewer, loadingOlder, loadingNewer, notice, fetchOlder, fetchNewer } = win;

    const { user, isLoading: authLoading } = useAuth();
    const storageKey = pivotStorageKey(plantView, user?.id);

    const virtuosoRef = React.useRef<TableVirtuosoHandle>(null);
    const gridRef = React.useRef<HTMLDivElement>(null);

    // ─── Lock + pending state (ALL parent-owned) ─────────────────────────────────────
    const [unlocked, setUnlocked] = React.useState(false);
    const [pending, setPending] = React.useState<PivotPending>(EMPTY_PENDING);
    // Undo/redo stacks over the whole pending buffer (spreadsheet model: pre-save history).
    const undoRef = React.useRef<PivotPending[]>([]);
    const redoRef = React.useRef<PivotPending[]>([]);
    const [histTick, setHistTick] = React.useState(0);
    const [isSaving, setIsSaving] = React.useState(false);
    const [discardOpen, setDiscardOpen] = React.useState(false);
    const [resumePrompt, setResumePrompt] = React.useState<{ count: number } | null>(null);
    const hydratedRef = React.useRef(false);

    // active-cell / editing model — the SINGLE active edit value lives here (recycle-safe).
    const [activeNavId, setActiveNavId] = React.useState<string | null>(null);
    const [editingNavId, setEditingNavId] = React.useState<string | null>(null);
    const [editValue, setEditValue] = React.useState('');
    const preEditRef = React.useRef<string | null>(null);

    // popovers (parent-level → survive scroll), row/day menus, edit-pull, delete confirms.
    const [insertPopover, setInsertPopover] = React.useState<{ navId: string; leaf: RecvRow; col: EditColumn; weight: string; x: number; y: number } | null>(null);
    const [bagPopover, setBagPopover] = React.useState<{ slotKey: string; col: EditColumn; weight: string; source: string; x: number; y: number } | null>(null);
    const [editPull, setEditPull] = React.useState<{ leaf: RecvRow } | null>(null);
    const [confirmDelete, setConfirmDelete] = React.useState<{ eventId: string; label: string } | null>(null);
    const [confirmDay, setConfirmDay] = React.useState<{ date: string; group: DateGroup | null; isAdded: boolean; count: number } | null>(null);
    const dupCounterRef = React.useRef(0);

    // Pivot the accumulated events → day-blocks (REUSED VERBATIM from the editable block).
    const { groups } = React.useMemo(() => buildDateGroups(events, plantView), [events, plantView]);

    // Render list = pivoted days + appended empty added days (newest-edge only). Added days
    // are sorted into place among the loaded days.
    const renderRows = React.useMemo<RenderDay[]>(() => {
        const base: RenderDay[] = groups.map((g) => ({ date: g.date, group: g, isAdded: false }));
        if (unlocked && pending.addedDays.length > 0) {
            const existing = new Set(base.map((r) => r.date));
            for (const d of pending.addedDays) {
                if (!existing.has(d)) base.push({ date: d, group: null, isAdded: true });
            }
            base.sort((a, b) => a.date.localeCompare(b.date));
        }
        return base;
    }, [groups, unlocked, pending.addedDays]);

    const eventsById = React.useMemo(() => {
        const m = new Map<string, ProductionEventRow>();
        for (const e of events) { const id = (e.id ?? '').trim(); if (id) m.set(id, e); }
        return m;
    }, [events]);
    const deletedSet = React.useMemo(() => new Set(pending.deleted), [pending.deleted]);

    // ─── Mutation entry point — snapshots for undo, clears redo, writes pending ──────
    const applyPending = React.useCallback((updater: (p: PivotPending) => PivotPending) => {
        setPending((prev) => {
            const next = updater(prev);
            if (next === prev) return prev;
            undoRef.current.push(clonePending(prev));
            redoRef.current = [];
            setHistTick((t) => t + 1);
            return next;
        });
    }, []);

    const undo = React.useCallback(() => {
        if (undoRef.current.length === 0) return;
        setPending((prev) => {
            const last = undoRef.current.pop()!;
            redoRef.current.push(clonePending(prev));
            setHistTick((t) => t + 1);
            return last;
        });
    }, []);
    const redo = React.useCallback(() => {
        if (redoRef.current.length === 0) return;
        setPending((prev) => {
            const next = redoRef.current.pop()!;
            undoRef.current.push(clonePending(prev));
            setHistTick((t) => t + 1);
            return next;
        });
    }, []);
    const canUndo = undoRef.current.length > 0;
    const canRedo = redoRef.current.length > 0;
    void histTick;

    // ─── Counts / dirty summary ──────────────────────────────────────────────────────
    const draftInsertRows = React.useMemo(
        () => Object.values(pending.drafts).flatMap((d) => buildDraftDirtyRows(d, plantView)),
        [pending.drafts, plantView],
    );
    const stagedCount = Object.keys(pending.staged).length;
    const modifiedCount = React.useMemo(
        () => Object.keys(pending.modified).filter((id) => !deletedSet.has(id)).length,
        [pending.modified, deletedSet],
    );
    const pullEditCount = Object.keys(pending.pullEdits).length;
    const deletedCount = pending.deleted.length;
    const newCount = draftInsertRows.length + stagedCount;
    const modCount = modifiedCount + pullEditCount;
    const totalDirty = newCount + modCount + deletedCount;
    const dirtySummary = [
        newCount > 0 ? `${newCount} new` : null,
        modCount > 0 ? `${modCount} mod` : null,
        deletedCount > 0 ? `${deletedCount} del` : null,
    ].filter(Boolean).join(' · ');

    // ─── localStorage restore (once auth resolves → stable key) ──────────────────────
    React.useEffect(() => {
        if (hydratedRef.current || authLoading) return;
        hydratedRef.current = true;
        let stored = clonePending(EMPTY_PENDING);
        try {
            const raw = window.localStorage.getItem(storageKey);
            if (raw) stored = coercePending(JSON.parse(raw));
        } catch { /* corrupt — ignore */ }
        const pendingCount =
            Object.keys(stored.modified).length + stored.deleted.length + Object.keys(stored.staged).length +
            Object.values(stored.drafts).filter((d) => draftIdentityComplete(d) || draftHasWeights(d)).length +
            Object.keys(stored.pullEdits).length + stored.addedDays.length;
        if (pendingCount > 0) {
            setPending(stored);
            setResumePrompt({ count: pendingCount });
        }
    }, [authLoading, storageKey]);

    // ─── Mirror pending → localStorage (debounced) ───────────────────────────────────
    React.useEffect(() => {
        if (!hydratedRef.current) return;
        const t = setTimeout(() => {
            try {
                const hasWork =
                    Object.keys(pending.modified).length || pending.deleted.length || Object.keys(pending.staged).length ||
                    Object.keys(pending.drafts).length || Object.keys(pending.pullEdits).length || pending.addedDays.length;
                if (hasWork) window.localStorage.setItem(storageKey, JSON.stringify(pending));
                else window.localStorage.removeItem(storageKey);
            } catch { /* quota / private mode */ }
        }, 300);
        return () => clearTimeout(t);
    }, [pending, storageKey]);

    const clearMirror = React.useCallback(() => {
        try { window.localStorage.removeItem(storageKey); } catch { /* ignore */ }
    }, [storageKey]);

    const resetPending = React.useCallback(() => {
        setPending(EMPTY_PENDING);
        undoRef.current = [];
        redoRef.current = [];
        setHistTick((t) => t + 1);
        setActiveNavId(null);
        editingNavIdRef.current = null;
        setEditingNavId(null);
        setEditValue('');
    }, []);

    // ─── Cell value read (committed ⊕ live editValue) ────────────────────────────────
    const committedValueOf = React.useCallback((navId: string): string => {
        const cell = navModelRef.current?.byId.get(navId);
        if (!cell) return '';
        // real weight cell
        if (navId.startsWith('r:')) {
            const found = findLeafForNav.current?.(navId);
            if (!found) return '';
            const { leaf, col } = found;
            const cellKey = `${leafKeyOf(leaf)}|${col}`;
            const staged = pending.staged[cellKey];
            if (staged) return staged.row.weight_kg;
            const slot = leaf.cells[col];
            const eventId = slot.eventIds.length === 1 ? slot.eventIds[0] : null;
            if (eventId && deletedSet.has(eventId)) return '';
            if (eventId && pending.modified[eventId] !== undefined) return pending.modified[eventId];
            return slot.weight ? String(slot.weight) : '';
        }
        // draft cell: d:${slotKey}:${lane}
        const rest = navId.slice(2);
        const li = rest.lastIndexOf(':');
        const slotKey = rest.slice(0, li);
        const lane = rest.slice(li + 1);
        const d = pending.drafts[slotKey];
        if (!d) return '';
        if (lane === 'shift') return d.shift;
        if (lane === 'grade') return d.grade;
        if (lane === 'source') return d.source;
        if (lane === 'recv') return d.recvDate;
        return d.weights[lane as EditColumn] ?? '';
    }, [pending, deletedSet]);

    const getCellValue = React.useCallback((navId: string): string => {
        if (editingNavId === navId) return editValue;
        return committedValueOf(navId);
    }, [editingNavId, editValue, committedValueOf]);

    // A quick leaf lookup by navId (for real cells) — rebuilt each render into a ref.
    const findLeafForNav = React.useRef<((navId: string) => { leaf: RecvRow; col: EditColumn } | null) | null>(null);
    const navModelRef = React.useRef<ReturnType<typeof buildNavModel> | null>(null);

    // refs so callbacks read fresh values without rebinding (and so a commit-on-switch
    // reads the live editing cell/value WITHOUT a side-effect inside a setState updater —
    // StrictMode double-invokes updaters, which would double-commit).
    const editValueRef = React.useRef(editValue);
    editValueRef.current = editValue;
    const editingNavIdRef = React.useRef<string | null>(editingNavId);
    editingNavIdRef.current = editingNavId;
    const commitEditingRef = React.useRef<((navId: string, value: string) => void) | null>(null);

    // ─── active / editing transitions ────────────────────────────────────────────────
    const onActivate = React.useCallback((navId: string) => {
        // Commit any OTHER in-progress edit before switching selection (read the live cell
        // from a ref, run the commit OUTSIDE any state updater — no double-commit).
        const cur = editingNavIdRef.current;
        if (cur !== null && cur !== navId) {
            commitEditingRef.current?.(cur, editValueRef.current);
            editingNavIdRef.current = null;
            setEditingNavId(null);
            setEditValue('');
        }
        setActiveNavId(navId);
    }, []);

    const onStartEdit = React.useCallback((navId: string, char?: string) => {
        const cell = navModelRef.current?.byId.get(navId);
        if (cell && !cell.editable) return; // locked
        preEditRef.current = committedValueOf(navId);
        setActiveNavId(navId);
        editingNavIdRef.current = navId;
        setEditingNavId(navId);
        setEditValue(char !== undefined ? char : committedValueOf(navId));
    }, [committedValueOf]);

    const onEditChange = React.useCallback((v: string) => setEditValue(v), []);

    const onRevertEditing = React.useCallback(() => {
        editingNavIdRef.current = null;
        setEditingNavId(null);
        setEditValue('');
        if (activeNavId) requestAnimationFrame(() => focusNavId(activeNavId));
    }, [activeNavId]);

    // ─── Central commit (data-addressed — no per-cell closure, scroll-safe) ──────────
    const commitEditing = React.useCallback((navId: string, rawValue: string) => {
        const value = rawValue;
        // Real weight cell
        if (navId.startsWith('r:')) {
            const found = findLeafForNav.current?.(navId);
            if (!found) return;
            const { leaf, col } = found;
            const lk = leafKeyOf(leaf);
            const cellKey = `${lk}|${col}`;
            const slot = leaf.cells[col];
            const parsed = parseWeight(value);
            const staged = pending.staged[cellKey];
            const eventId = slot.eventIds.length === 1 ? slot.eventIds[0] : null;
            if (staged) {
                if (parsed == null || parsed <= 0) applyPending((p) => { const s = { ...p.staged }; delete s[cellKey]; return { ...p, staged: s }; });
                else applyPending((p) => ({ ...p, staged: { ...p.staged, [cellKey]: { cellKey, row: { ...staged.row, weight_kg: String(parsed) } } } }));
            } else if (eventId != null) {
                if (parsed == null || parsed <= 0) {
                    setConfirmDelete({ eventId, label: `${leaf.source} · ${formatRecvLabel(leaf.recvDate)} · ${col === BAGGING ? 'Bagging' : col}` });
                } else if (parsed !== slot.weight) {
                    applyPending((p) => ({ ...p, modified: { ...p.modified, [eventId]: String(parsed) } }));
                } else {
                    applyPending((p) => { if (p.modified[eventId] === undefined) return p; const m = { ...p.modified }; delete m[eventId]; return { ...p, modified: m }; });
                }
            } else if (parsed != null && parsed > 0) {
                // blank real cell → column-aware Insert popover (parent-level, coord-anchored)
                const rect = cellRect(navId);
                setInsertPopover({ navId, leaf, col, weight: String(parsed), x: rect.x, y: rect.y });
            }
            return;
        }
        // Draft cell
        const rest = navId.slice(2);
        const li = rest.lastIndexOf(':');
        const slotKey = rest.slice(0, li);
        const lane = rest.slice(li + 1);
        const dayDate = slotKey.split('#')[0];
        if (lane === 'shift' || lane === 'grade' || lane === 'source' || lane === 'recv') {
            const opts = lane === 'shift' ? (SHIFT_CODES as readonly string[]) : lane === 'grade' ? (GRADE_CODES as readonly string[]) : lane === 'source' ? SOURCE_SETS[plantView] : [];
            let norm = value;
            if (lane === 'recv') {
                const yr = parseISO(dayDate).getFullYear() || new Date().getFullYear();
                norm = normalizeTypedDate(value, yr);
            } else {
                norm = normalizeIdentity(value, opts);
            }
            upsertDraft(slotKey, dayDate, (d) => ({
                ...d,
                shift: lane === 'shift' ? norm : d.shift,
                grade: lane === 'grade' ? norm : d.grade,
                source: lane === 'source' ? norm : d.source,
                recvDate: lane === 'recv' ? norm : d.recvDate,
            }));
            return;
        }
        // Draft weight
        const col = lane as EditColumn;
        const parsed = parseWeight(value);
        const d = pending.drafts[slotKey];
        const identityComplete = d ? draftIdentityComplete(d) : false;
        if (parsed == null || parsed <= 0) {
            upsertDraft(slotKey, dayDate, (dd) => ({ ...dd, weights: { ...dd.weights, [col]: '' } }));
            return;
        }
        if (!identityComplete) {
            toast.warning('Set shift, grade, source, and recv date first.');
            // keep the typed value in the draft (so it isn't lost) but don't stage
            upsertDraft(slotKey, dayDate, (dd) => ({ ...dd, weights: { ...dd.weights, [col]: String(parsed) } }));
            return;
        }
        if (col === BAGGING) {
            const rect = cellRect(navId);
            setBagPopover({ slotKey, col, weight: String(parsed), source: d?.source ?? '', x: rect.x, y: rect.y });
            return;
        }
        upsertDraft(slotKey, dayDate, (dd) => ({ ...dd, weights: { ...dd.weights, [col]: String(parsed) } }));
    }, [pending, plantView, applyPending]);
    commitEditingRef.current = commitEditing;

    const upsertDraft = React.useCallback((slotKey: string, dayDate: string, fn: (d: FillerDraft) => FillerDraft) => {
        applyPending((p) => {
            const existing = p.drafts[slotKey] ?? { key: slotKey, dayDate, shift: '', grade: '', source: '', recvDate: '', weights: {} };
            return { ...p, drafts: { ...p.drafts, [slotKey]: fn({ ...existing, dayDate }) } };
        });
    }, [applyPending]);

    const onCommitEditing = React.useCallback(() => {
        const nav = editingNavIdRef.current;
        if (nav == null) return;
        commitEditing(nav, editValueRef.current);
        editingNavIdRef.current = null;
        setEditingNavId(null);
        setEditValue('');
    }, [commitEditing]);

    // ─── focus + scroll-into-view (data-derived; scroll before focus if not mounted) ─
    const pendingFocusRef = React.useRef<string | null>(null);
    const focusNavId = React.useCallback((navId: string) => {
        const root = gridRef.current;
        if (!root) return;
        const el = root.querySelector<HTMLElement>(`[data-navid="${CSS.escape(navId)}"]`);
        // `preventScroll`: HTMLElement.focus() otherwise scrolls the cell into view with
        // block "center" through every scrolling ancestor — even when it is already fully
        // visible — so a purely lateral caret move dragged the page with it. The explicit
        // `scrollIntoView` below (for a cell that is NOT mounted) is the scroll we want.
        // The `select()` is preserved: a caret arriving on a cell selects its text.
        if (el) { el.focus({ preventScroll: true }); (el as HTMLInputElement).select?.(); return; }
        // not mounted — scroll its day into view, then focus after it renders
        const cell = navModelRef.current?.byId.get(navId);
        const dayIdx = cell ? navModelRef.current?.dayIndexByDate.get(cell.dayDate) : undefined;
        if (dayIdx != null) {
            pendingFocusRef.current = navId;
            virtuosoRef.current?.scrollIntoView({ index: dayIdx });
        }
    }, []);
    React.useEffect(() => {
        if (!pendingFocusRef.current) return;
        const navId = pendingFocusRef.current;
        const el = gridRef.current?.querySelector<HTMLElement>(`[data-navid="${CSS.escape(navId)}"]`);
        if (el) { pendingFocusRef.current = null; el.focus({ preventScroll: true }); (el as HTMLInputElement).select?.(); }
    });

    // ─── data-derived keyboard nav resolver ──────────────────────────────────────────
    const navModel = React.useMemo(() => buildNavModel(renderRows, {
        pending, unlocked, plantView, deletedSet, eventsById,
        activeNavId, editingNavId, getCellValue,
        onActivate, onStartEdit, onEditChange, onCommitEditing, onRevertEditing,
        onDeleteEvent: () => {}, ledgerHrefForLeaf: () => '', openRowMenu: () => {}, addExtraRow: () => {}, openDayMenu: () => {},
    }), [renderRows, pending, unlocked, plantView, deletedSet, eventsById, activeNavId, editingNavId, getCellValue, onActivate, onStartEdit, onEditChange, onCommitEditing, onRevertEditing]);
    navModelRef.current = navModel;

    // Real-cell leaf lookup keyed by leafKey (rebuilt each render).
    React.useMemo(() => {
        const leafByKey = new Map<string, RecvRow>();
        for (const rd of renderRows) {
            if (!rd.group) continue;
            for (const sh of rd.group.shifts) for (const gr of sh.grades) for (const src of gr.sources) for (const leaf of src.recvRows) {
                leafByKey.set(leafKeyOf(leaf), leaf);
            }
        }
        findLeafForNav.current = (navId: string) => {
            // r:${leafKey}:${col}
            const rest = navId.slice(2);
            const li = rest.lastIndexOf(':');
            const lk = rest.slice(0, li);
            const col = rest.slice(li + 1) as EditColumn;
            const leaf = leafByKey.get(lk);
            return leaf ? { leaf, col } : null;
        };
        return null;
    }, [renderRows]);

    const resolver = React.useMemo<NavResolver<string>>(() => {
        const findAdjacent = (from: string, dir: 1 | -1): string | null => {
            const model = navModelRef.current;
            if (!model) return null;
            const cur = model.byId.get(from);
            if (!cur) return null;
            const ri = model.rowKeys.indexOf(cur.rowKey);
            if (ri < 0) return null;
            const targetRow = model.rowKeys[ri + dir];
            if (targetRow == null) return null;
            const cells = model.rowCells.get(targetRow) ?? [];
            if (cells.length === 0) return null;
            const exact = cells.find((c) => c.lane === cur.lane);
            if (exact) return exact.navId;
            const want = navColIndex(cur.lane);
            let best = cells[0];
            let bestDist = Math.abs(navColIndex(best.lane) - want);
            for (const c of cells) { const dd = Math.abs(navColIndex(c.lane) - want); if (dd < bestDist) { best = c; bestDist = dd; } }
            return best.navId;
        };
        return {
            resolve(from: string, move: NavMove) {
                const model = navModelRef.current;
                if (!model) return null;
                const idx = model.order.indexOf(from);
                if (idx < 0) return null;
                if (move.kind === 'tab') return model.order[move.shift ? idx - 1 : idx + 1] ?? null;
                if (move.kind === 'enter') return findAdjacent(from, move.shift ? -1 : 1);
                if (move.dir === 'left') return model.order[idx - 1] ?? null;
                if (move.dir === 'right') return model.order[idx + 1] ?? null;
                return findAdjacent(from, move.dir === 'down' ? 1 : -1);
            },
            laneOf(id: string) { return navModelRef.current?.byId.get(id)?.lane ?? id; },
            resolveInRow(from: string, lane, dir) {
                void lane;
                return findAdjacent(from, dir);
            },
            isEditable(id: string) { return navModelRef.current?.byId.get(id)?.editable ?? false; },
        };
    }, []);

    const onAfterMove = React.useCallback((id: string) => {
        editingNavIdRef.current = null;
        setEditingNavId(null);
        setEditValue('');
        setActiveNavId(id);
        focusNavId(id);
    }, [focusNavId]);

    const { handleKeyDown: handleNavKeyDown } = useGridKeyboardNav<string>({
        activeCell: activeNavId,
        setActiveCell: setActiveNavId,
        isEditing: editingNavId !== null,
        resolver,
        edit: {
            start: (id, char) => onStartEdit(id, char),
            revert: onRevertEditing,
            commit: () => { onCommitEditing(); if (activeNavId) focusNavId(activeNavId); },
        },
        onAfterMove,
        enableEnterAnchor: true,
    });

    const handleGridKeyDown = React.useCallback((e: React.KeyboardEvent) => {
        if (!unlocked) return;
        // Undo / redo (pre-save buffer).
        if ((e.metaKey || e.ctrlKey) && (e.key === 'z' || e.key === 'Z') && !e.shiftKey) { e.preventDefault(); undo(); return; }
        if ((e.metaKey || e.ctrlKey) && ((e.key === 'y' || e.key === 'Y') || ((e.key === 'z' || e.key === 'Z') && e.shiftKey))) { e.preventDefault(); redo(); return; }
        handleNavKeyDown(e);
    }, [unlocked, undo, redo, handleNavKeyDown]);

    // ─── Popover confirm handlers ────────────────────────────────────────────────────
    const advanceAfterPopover = React.useCallback((navId: string) => {
        // Resume the Tab run: move to the next nav cell after the popover resolves.
        const model = navModelRef.current;
        if (!model) return;
        const idx = model.order.indexOf(navId);
        const next = idx >= 0 ? model.order[idx + 1] : null;
        if (next) { setActiveNavId(next); requestAnimationFrame(() => focusNavId(next)); }
        else { gridRef.current?.focus({ preventScroll: true }); }
    }, [focusNavId]);

    const confirmInsert = React.useCallback((row: ProductionEventDirtyRow) => {
        if (!insertPopover) return;
        const { navId, leaf, col } = insertPopover;
        const cellKey = `${leafKeyOf(leaf)}|${col}`;
        applyPending((p) => ({ ...p, staged: { ...p.staged, [cellKey]: { cellKey, row } } }));
        setInsertPopover(null);
        advanceAfterPopover(navId);
    }, [insertPopover, applyPending, advanceAfterPopover]);

    const confirmBag = React.useCallback((meta: BaggingMeta) => {
        if (!bagPopover) return;
        const { slotKey, col, weight, x } = bagPopover;
        void x;
        const dayDate = slotKey.split('#')[0];
        upsertDraft(slotKey, dayDate, (dd) => ({ ...dd, weights: { ...dd.weights, [col]: String(parseWeight(weight) ?? '') }, bagging: meta }));
        const navId = navDraft(slotKey, col);
        setBagPopover(null);
        advanceAfterPopover(navId);
    }, [bagPopover, upsertDraft, advanceAfterPopover]);

    // ─── Row context menu (Edit / Delete / Duplicate pull) ───────────────────────────
    const rowMenu = useGridContextMenu<RecvRow>();
    const openRowMenu = React.useCallback((leaf: RecvRow, x: number, y: number) => rowMenu.open(leaf, x, y), [rowMenu]);

    const deletePull = React.useCallback((leaf: RecvRow) => {
        const ids = collectLeafEventIds(leaf);
        applyPending((p) => {
            const set = new Set(p.deleted);
            for (const id of ids) set.add(id);
            const m = { ...p.modified }; for (const id of ids) delete m[id];
            return { ...p, deleted: [...set], modified: m };
        });
    }, [applyPending]);

    const duplicatePull = React.useCallback((leaf: RecvRow) => {
        const n = ++dupCounterRef.current;
        const slotKey = `${leaf.prodDate}#slot-dup-${n}`;
        const weights: Partial<Record<EditColumn, string>> = {};
        let bagging: BaggingMeta | undefined;
        for (const col of ACTIVE_EQUIP) {
            const w = leaf.cells[col].weight;
            if (w > 0) weights[col] = String(w);
        }
        const bagW = leaf.cells[BAGGING].weight;
        if (bagW > 0) {
            weights[BAGGING] = String(bagW);
            // pull warehouse/side/flec off one bagging event if present
            const bagId = leaf.cells[BAGGING].eventIds[0];
            const ev = bagId ? eventsById.get(bagId) : undefined;
            bagging = { warehouse: ev?.warehouse_code ?? '', side: ev?.whse_side ?? '', flec: ev?.flec_count != null ? String(ev.flec_count) : '' };
        }
        applyPending((p) => ({
            ...p,
            drafts: { ...p.drafts, [slotKey]: { key: slotKey, dayDate: leaf.prodDate, shift: leaf.shift, grade: leaf.grade, source: leaf.source, recvDate: leaf.recvDate, weights, bagging } },
        }));
        toast.success('Pull duplicated as a draft — Save to commit');
    }, [applyPending, eventsById]);

    // ─── Edit pull (row-level identity re-tag → re-buckets after save) ────────────────
    const applyPullEdit = React.useCallback((leaf: RecvRow, edit: { shift: string; grade: string; source: string; recvDate: string; warehouse?: string; side?: string }) => {
        const lk = leafKeyOf(leaf);
        const eventIds = collectLeafEventIds(leaf);
        applyPending((p) => ({ ...p, pullEdits: { ...p.pullEdits, [lk]: { eventIds, ...edit } } }));
    }, [applyPending]);

    // ─── Day menu (Delete day / Remove added day) ────────────────────────────────────
    const dayMenu = useGridContextMenu<{ date: string; group: DateGroup | null; isAdded: boolean }>();
    const openDayMenu = React.useCallback((date: string, group: DateGroup | null, isAdded: boolean, x: number, y: number) => {
        dayMenu.open({ date, group, isAdded }, x, y);
    }, [dayMenu]);

    const removeAddedDay = React.useCallback((date: string) => {
        applyPending((p) => {
            const drafts = { ...p.drafts };
            for (const k of Object.keys(drafts)) if (drafts[k].dayDate === date) delete drafts[k];
            const extraRows = { ...p.extraRows }; delete extraRows[date];
            return { ...p, addedDays: p.addedDays.filter((d) => d !== date), drafts, extraRows };
        });
    }, [applyPending]);

    const deleteDay = React.useCallback((group: DateGroup) => {
        const ids = collectDayEventIds(group);
        applyPending((p) => {
            const set = new Set(p.deleted);
            for (const id of ids) set.add(id);
            const m = { ...p.modified }; for (const id of ids) delete m[id];
            return { ...p, deleted: [...set], modified: m };
        });
    }, [applyPending]);

    const addExtraRow = React.useCallback((dayDate: string) => {
        applyPending((p) => ({ ...p, extraRows: { ...p.extraRows, [dayDate]: (p.extraRows[dayDate] ?? 0) + 1 } }));
    }, [applyPending]);

    // ─── Add day (append-edge only) ──────────────────────────────────────────────────
    const addDay = React.useCallback((date: string) => {
        applyPending((p) => (p.addedDays.includes(date) ? p : { ...p, addedDays: [...p.addedDays, date] }));
    }, [applyPending]);

    const ledgerHrefForLeaf = React.useCallback((leaf: RecvRow): string => {
        const ids = collectLeafEventIds(leaf);
        const ev = ids.map((id) => eventsById.get(id)).find(Boolean);
        if (ev?.batch && ev.batch_year != null) return `/cenapro/production?year=${ev.batch_year}&batch=${encodeURIComponent(ev.batch)}`;
        return '/cenapro/production';
    }, [eventsById]);

    // ─── Lock toggle ─────────────────────────────────────────────────────────────────
    const handleToggle = React.useCallback(() => {
        setUnlocked((u) => !u);
        setActiveNavId(null);
        editingNavIdRef.current = null;
        setEditingNavId(null);
        setEditValue('');
    }, []);

    // ─── Save ────────────────────────────────────────────────────────────────────────
    const handleSave = React.useCallback(async () => {
        // commit any in-progress edit first
        if (editingNavIdRef.current) { commitEditing(editingNavIdRef.current, editValueRef.current); editingNavIdRef.current = null; setEditingNavId(null); setEditValue(''); }

        const rowErrors: string[] = [];
        // validate drafts with weights but incomplete identity
        for (const d of Object.values(pending.drafts)) {
            if (draftHasWeights(d) && !draftIdentityComplete(d)) {
                rowErrors.push(`draft on ${d.dayDate || 'a day'} needs shift, grade, source, and recv date`);
            }
        }
        if (rowErrors.length > 0) {
            errorToast(`${rowErrors.length} draft${rowErrors.length !== 1 ? 's' : ''} can't be saved yet.`, {
                description: 'Complete the identity (shift / grade / source / recv date) on each highlighted new pull, then Save again.\n\n' + rowErrors.join('\n'),
            });
            return;
        }

        // Build UPDATEs (pull edits ⊕ weight edits), staged inserts, draft inserts, deletes.
        const updates = new Map<string, ProductionEventDirtyRow>();
        for (const [, edit] of Object.entries(pending.pullEdits)) {
            for (const eventId of edit.eventIds) {
                if (deletedSet.has(eventId)) continue;
                const src = eventsById.get(eventId);
                if (!src) continue;
                const base = dirtyFromEvent(src);
                base.shift_code = edit.shift;
                base.grade_code = edit.grade;
                base.source_location_code = edit.source;
                base.recv_date = edit.recvDate;
                base.batch_year = src.batch_year != null ? String(src.batch_year) : ''; // keep original period
                if (src.disposition_kind === 'flec_bagging') {
                    if (edit.warehouse != null && edit.warehouse !== '') base.warehouse_code = edit.warehouse;
                    if (edit.side != null && edit.side !== '') base.whse_side = edit.side;
                }
                updates.set(eventId, base);
            }
        }
        for (const [eventId, weight] of Object.entries(pending.modified)) {
            if (deletedSet.has(eventId)) continue;
            const existing = updates.get(eventId);
            if (existing) { existing.weight_kg = weight; continue; }
            const src = eventsById.get(eventId);
            if (!src) continue;
            const base = dirtyFromEvent(src);
            base.weight_kg = weight;
            updates.set(eventId, base);
        }

        const dirtyRows: ProductionEventDirtyRow[] = [];
        for (const r of updates.values()) dirtyRows.push(r);
        for (const s of Object.values(pending.staged)) dirtyRows.push(s.row);
        for (const r of Object.values(pending.drafts).flatMap((d) => buildDraftDirtyRows(d, plantView))) dirtyRows.push(r);
        const deleted = pending.deleted.filter((id) => id && id.trim() !== '');

        if (dirtyRows.length === 0 && deleted.length === 0) {
            toast.info('No changes to save.');
            return;
        }

        setIsSaving(true);
        try {
            const res = await saveProductionEvents(dirtyRows, deleted);
            if (!res.ok) { errorToast(res.error ?? 'Failed to save production changes.'); return; }
            const parts: string[] = [];
            if (res.upserted) parts.push(`${res.upserted} saved`);
            if (res.deleted) parts.push(`${res.deleted} deleted`);
            toast.success(parts.length ? `Saved — ${parts.join(', ')}` : 'Saved');
            resetPending();
            clearMirror();
            await win.refreshWindow();
        } catch (err) {
            errorToast('Unexpected error: ' + (err instanceof Error ? err.message : String(err)));
        } finally {
            setIsSaving(false);
        }
    }, [commitEditing, pending, deletedSet, eventsById, plantView, resetPending, clearMirror, win]);

    const handleDiscardConfirm = React.useCallback(() => {
        setDiscardOpen(false);
        resetPending();
        clearMirror();
    }, [resetPending, clearMirror]);

    const handleResume = React.useCallback(() => {
        setResumePrompt(null);
        setUnlocked(true);
    }, []);
    const handleDiscardResume = React.useCallback(() => {
        setResumePrompt(null);
        resetPending();
        clearMirror();
    }, [resetPending, clearMirror]);

    // ─── Anchors / virtuoso wiring ───────────────────────────────────────────────────
    const initialTopMostItemIndex = React.useMemo(() => {
        if (anchor.kind !== 'latest') return 0;
        return Math.max(0, distinctDayCount(initialWindow.events) - 1);
    }, [anchor.kind, initialWindow.events]);

    const editCtx: PivotEditCtx = {
        unlocked, plantView, pending, deletedSet, eventsById,
        activeNavId, editingNavId, getCellValue,
        onActivate, onStartEdit, onEditChange, onCommitEditing, onRevertEditing,
        onDeleteEvent: (id) => setConfirmDelete({ eventId: id, label: 'this entry' }),
        ledgerHrefForLeaf, openRowMenu, addExtraRow, openDayMenu,
    };

    const context: PivotVCtx = { firstItemIndex, rows: renderRows, editCtx };

    const itemContent = React.useCallback((index: number, rd: RenderDay, ctx: PivotVCtx) => {
        const pos = index - ctx.firstItemIndex;
        const prev = pos > 0 ? ctx.rows[pos - 1] : undefined;
        const isMonthStart = !prev || monthKey(prev.date) !== monthKey(rd.date);
        return (
            <td colSpan={TOTAL_COLS} className="p-0 align-top" style={{ padding: 0 }}>
                {isMonthStart && <MonthSeparator label={monthLabel(rd.date)} />}
                <EditableDayBlock group={rd.group} date={rd.date} isAdded={rd.isAdded} ctx={ctx.editCtx} />
            </td>
        );
    }, []);

    const computeItemKey = React.useCallback((_index: number, rd: RenderDay) => `day:${rd.date}`, []);
    const handleStartReached = React.useCallback(() => { void fetchOlder(); }, [fetchOlder]);
    const handleEndReached = React.useCallback(() => { void fetchNewer(); }, [fetchNewer]);

    const dayCount = renderRows.length;

    // Row context-menu items.
    const rowMenuItems: GridMenuItem<RecvRow>[] = [
        { kind: 'item', label: 'Edit pull…', icon: Pencil, onSelect: (leaf) => { setEditPull({ leaf }); } },
        { kind: 'item', label: 'Duplicate pull', icon: CopyPlus, onSelect: (leaf) => duplicatePull(leaf) },
        { kind: 'separator' },
        {
            kind: 'item',
            label: (leaf) => (leafFullyDeleted(leaf, deletedSet) ? 'Restore pull' : 'Delete pull'),
            icon: Trash2,
            variant: 'destructive',
            onSelect: (leaf) => {
                if (leafFullyDeleted(leaf, deletedSet)) {
                    const ids = collectLeafEventIds(leaf);
                    applyPending((p) => ({ ...p, deleted: p.deleted.filter((id) => !ids.includes(id)) }));
                } else deletePull(leaf);
            },
        },
    ];

    const dayMenuItems: GridMenuItem<{ date: string; group: DateGroup | null; isAdded: boolean }>[] = [
        {
            kind: 'item',
            label: (ref) => (ref.isAdded ? 'Remove this day' : 'Delete this day…'),
            icon: Trash2,
            variant: 'destructive',
            onSelect: (ref) => {
                if (ref.isAdded) {
                    const hasDrafts = Object.values(pending.drafts).some((d) => d.dayDate === ref.date && (draftIdentityComplete(d) || draftHasWeights(d)));
                    if (hasDrafts) { setConfirmDay({ date: ref.date, group: null, isAdded: true, count: 0 }); }
                    else removeAddedDay(ref.date);
                } else if (ref.group) {
                    setConfirmDay({ date: ref.date, group: ref.group, isAdded: false, count: collectDayEventIds(ref.group).length });
                }
            },
        },
    ];

    return (
        <div className="flex h-full flex-col">
            {/* Toolbar */}
            <div className="flex flex-none flex-wrap items-center gap-2 border-b bg-muted/30 px-2 py-1.5 md:px-3">
                {/* Edit controls live on the LEFT (near the eye) — the toggle, then the
                    editing actions; the period/view/scope nav sits to their right. */}
                <Button
                    variant={unlocked ? 'default' : 'outline'}
                    size="sm"
                    className="h-6 gap-1 px-2 text-[11px]"
                    onClick={handleToggle}
                    title={unlocked ? 'Lock the sheet (edits are kept)' : 'Unlock to edit weights, add pulls, and fix days'}
                >
                    {unlocked ? <LockOpen className="h-3 w-3" /> : <Lock className="h-3 w-3" />}
                    {unlocked ? 'Unlocked' : 'Edit'}
                </Button>
                {unlocked && (
                    <>
                        {/* Undo / redo */}
                        <div className="flex items-center gap-0.5">
                            <Button variant="ghost" size="icon" className="h-6 w-6" onClick={undo} disabled={!canUndo || isSaving} title="Undo (⌘Z)">
                                <Undo2 className="h-3.5 w-3.5" />
                            </Button>
                            <Button variant="ghost" size="icon" className="h-6 w-6" onClick={redo} disabled={!canRedo || isSaving} title="Redo (⌘Y)">
                                <Redo2 className="h-3.5 w-3.5" />
                            </Button>
                        </div>
                        <AddDayControl onAddDay={addDay} existingDates={new Set(renderRows.map((r) => r.date))} atLatest={!hasNewer} disabled={isSaving} />
                        {totalDirty > 0 && (
                            <span className="animate-fade-in hidden font-mono text-[10px] text-muted-foreground/70 sm:inline" title="Edits are kept on this device until you Save">
                                {dirtySummary}
                            </span>
                        )}
                    </>
                )}
                {totalDirty > 0 && (
                    <div className="animate-scale-in flex items-center gap-1.5">
                        <Button variant="ghost" size="sm" className="h-6 gap-1 px-2 text-[11px] text-muted-foreground transition-colors duration-150 hover:text-destructive" onClick={() => setDiscardOpen(true)} disabled={isSaving}>
                            Discard all
                        </Button>
                        <Button size="sm" className="h-6 gap-1 px-3 text-[11px]" onClick={handleSave} disabled={isSaving}>
                            <Save className="h-3 w-3" />
                            {isSaving ? 'Saving…' : (<span className="inline-flex items-center gap-1">Save<span className="tabular-nums">{dirtySummary}</span></span>)}
                        </Button>
                    </div>
                )}
                {!unlocked && (
                    <span className="hidden text-[10px] font-medium uppercase tracking-wide text-muted-foreground/60 md:inline">
                        {plantView} · read-only · oldest → newest
                    </span>
                )}
                <span className="h-4 w-px bg-border/60" />
                <CenaproPeriodPicker periods={periods} selected={selectedPeriod} disabled={totalDirty > 0} disabledHint="Save or discard your edits before switching period" />
                <span className="h-4 w-px bg-border/60" />
                <ViewModeSwitcher mode={view} disabled={totalDirty > 0} disabledHint="Save or discard your edits before switching view" />
                <span className="h-4 w-px bg-border/60" />
                <ScopeToggle scope="endless" disabled={totalDirty > 0} disabledHint="Save or discard your edits before switching scope" />
                <div className="flex-1" />
                <span className="font-mono text-[11px] text-muted-foreground/70">
                    {dayCount.toLocaleString('en-US')} day{dayCount !== 1 ? 's' : ''} loaded
                    {(hasOlder || hasNewer) && <span className="ml-1 text-muted-foreground/50">· scroll to load more</span>}
                </span>
            </div>

            {/* Resume prompt */}
            {resumePrompt && (
                <div className="animate-fade-up mx-3 mt-3 flex flex-wrap items-center gap-3 rounded-md border border-border bg-card px-3 py-2 shadow-sm">
                    <span className="min-w-0 flex-1 text-xs text-muted-foreground">
                        You have <span className="font-semibold text-foreground tabular-nums">{resumePrompt.count}</span> unsaved change{resumePrompt.count !== 1 ? 's' : ''} (new / edited / deleted) from a previous session.
                    </span>
                    <div className="flex items-center gap-1.5">
                        <Button variant="ghost" size="sm" className="h-6 px-2 text-[11px] text-muted-foreground hover:text-destructive" onClick={handleDiscardResume}>Discard</Button>
                        <Button size="sm" className="h-6 gap-1 px-3 text-[11px]" onClick={handleResume}><LockOpen className="h-3 w-3" />Resume</Button>
                        <Button variant="ghost" size="icon" className="h-6 w-6 text-muted-foreground hover:text-foreground" title="Later — keep edits, stay locked" aria-label="Dismiss" onClick={() => setResumePrompt(null)}><X className="h-3.5 w-3.5" /></Button>
                    </div>
                </div>
            )}

            {loadError && (
                <div className="m-3 flex items-start gap-3 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm">
                    <div className="min-w-0 flex-1">
                        <p className="font-medium text-destructive">Couldn&apos;t load production data</p>
                        <p className="mt-1 break-words text-destructive/90">{loadError}</p>
                    </div>
                    <Button variant="ghost" size="sm" className="h-7 shrink-0 px-2 text-destructive hover:text-destructive" onClick={() => { void navigator.clipboard.writeText(loadError).then(() => toast.success('Error copied to clipboard', { duration: 2000 })); }}>
                        <Copy className="mr-1 h-3.5 w-3.5" />Copy
                    </Button>
                </div>
            )}

            {notice && (
                <div className="mx-3 mt-3 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-[11px] text-amber-700 dark:text-amber-300">{notice}</div>
            )}

            {renderRows.length === 0 ? (
                <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 p-8 text-center">
                    <Inbox className="h-8 w-8 text-muted-foreground/30" />
                    <p className="text-sm text-muted-foreground">{notice ?? `No ${plantView} production to display.`}</p>
                </div>
            ) : (
                <div
                    ref={gridRef}
                    className="relative min-h-0 flex-1 select-none outline-none"
                    tabIndex={-1}
                    onKeyDown={handleGridKeyDown}
                    onBlur={(e) => {
                        if (unlocked && editingNavId && !e.currentTarget.contains(e.relatedTarget)) {
                            onCommitEditing();
                        }
                    }}
                >
                    {loadingOlder && (
                        <div className="pointer-events-none absolute inset-x-0 top-0 z-40 flex items-center justify-center gap-1.5 border-b border-border/40 bg-muted/85 py-1 text-[11px] text-muted-foreground backdrop-blur-sm">
                            <Loader2 className="h-3 w-3 animate-spin" />Loading earlier days…
                        </div>
                    )}
                    <TableVirtuoso
                        ref={virtuosoRef}
                        data={renderRows}
                        context={context}
                        computeItemKey={computeItemKey}
                        firstItemIndex={firstItemIndex}
                        initialTopMostItemIndex={initialTopMostItemIndex}
                        startReached={handleStartReached}
                        endReached={handleEndReached}
                        increaseViewportBy={{ top: 600, bottom: 600 }}
                        components={pivotComponents}
                        fixedHeaderContent={PivotHeaderRows}
                        itemContent={itemContent}
                        style={{ height: '100%' }}
                    />
                    {loadingNewer && (
                        <div className="pointer-events-none absolute inset-x-0 bottom-0 z-40 flex items-center justify-center gap-1.5 border-t border-border/40 bg-muted/85 py-1 text-[11px] text-muted-foreground backdrop-blur-sm">
                            <Loader2 className="h-3 w-3 animate-spin" />Loading newer days…
                        </div>
                    )}
                </div>
            )}

            {/* Parent-level popovers (survive day-block recycling — they're rendered OUTSIDE the
                virtualized list). InsertPopover/BaggingMetaPopover are SELF-CONTAINED Popovers
                whose trigger is an `absolute inset-0` span; wrapping each in a fixed 0-size box at
                the captured cell coords positions that span (and its content) at the cell. */}
            {insertPopover && (
                <div style={{ position: 'fixed', left: insertPopover.x, top: insertPopover.y, width: 1, height: 1, zIndex: 50 }}>
                    <InsertPopover
                        weight={insertPopover.weight}
                        col={insertPopover.col}
                        leaf={insertPopover.leaf}
                        period={selectedPeriod}
                        plantView={plantView}
                        onConfirm={confirmInsert}
                        onCancel={() => setInsertPopover(null)}
                    />
                </div>
            )}
            {bagPopover && (
                <div style={{ position: 'fixed', left: bagPopover.x, top: bagPopover.y, width: 1, height: 1, zIndex: 50 }}>
                    <BaggingMetaPopover
                        weight={bagPopover.weight}
                        source={bagPopover.source}
                        onConfirm={confirmBag}
                        onCancel={() => setBagPopover(null)}
                    />
                </div>
            )}

            {/* Row + day context menus */}
            <GridContextMenu state={rowMenu.state} items={rowMenuItems} onClose={rowMenu.close} />
            <GridContextMenu state={dayMenu.state} items={dayMenuItems} onClose={dayMenu.close} />

            {/* Edit-pull editor */}
            {editPull && (
                <EditPullDialog
                    leaf={editPull.leaf}
                    plantView={plantView}
                    hasBagging={editPull.leaf.cells[BAGGING].eventIds.length > 0}
                    onSave={(edit) => { applyPullEdit(editPull.leaf, edit); setEditPull(null); }}
                    onCancel={() => setEditPull(null)}
                />
            )}

            {/* Delete-cell confirm */}
            <AlertDialog open={confirmDelete !== null} onOpenChange={(o) => { if (!o) setConfirmDelete(null); }}>
                <AlertDialogContent>
                    <AlertDialogHeader>
                        <AlertDialogTitle>Delete this production entry?</AlertDialogTitle>
                        <AlertDialogDescription>{confirmDelete?.label} will be removed on save. This deletes the underlying event from the ledger.</AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                        <AlertDialogCancel>Cancel</AlertDialogCancel>
                        <AlertDialogAction className="bg-destructive text-destructive-foreground hover:bg-destructive/90" onClick={() => { if (confirmDelete) { const id = confirmDelete.eventId; applyPending((p) => ({ ...p, deleted: p.deleted.includes(id) ? p.deleted : [...p.deleted, id], modified: (() => { const m = { ...p.modified }; delete m[id]; return m; })() })); } setConfirmDelete(null); }}>Delete</AlertDialogAction>
                    </AlertDialogFooter>
                </AlertDialogContent>
            </AlertDialog>

            {/* Delete-day / remove-added-day confirm */}
            <AlertDialog open={confirmDay !== null} onOpenChange={(o) => { if (!o) setConfirmDay(null); }}>
                <AlertDialogContent>
                    <AlertDialogHeader>
                        <AlertDialogTitle>{confirmDay?.isAdded ? 'Remove this day?' : 'Delete this whole day?'}</AlertDialogTitle>
                        <AlertDialogDescription>
                            {confirmDay?.isAdded
                                ? 'This added day has unsaved drafts. Removing it discards those drafts.'
                                : `All ${confirmDay?.count ?? 0} event${confirmDay?.count === 1 ? '' : 's'} on ${confirmDay ? formatDayLabel(confirmDay.date) : ''} will be removed on save. This deletes the underlying events from the ledger.`}
                        </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                        <AlertDialogCancel>Cancel</AlertDialogCancel>
                        <AlertDialogAction className="bg-destructive text-destructive-foreground hover:bg-destructive/90" onClick={() => {
                            if (confirmDay) {
                                if (confirmDay.isAdded) removeAddedDay(confirmDay.date);
                                else if (confirmDay.group) deleteDay(confirmDay.group);
                            }
                            setConfirmDay(null);
                        }}>{confirmDay?.isAdded ? 'Remove' : 'Delete day'}</AlertDialogAction>
                    </AlertDialogFooter>
                </AlertDialogContent>
            </AlertDialog>

            {/* Discard-all confirm */}
            <AlertDialog open={discardOpen} onOpenChange={setDiscardOpen}>
                <AlertDialogContent>
                    <AlertDialogHeader>
                        <AlertDialogTitle>Discard all unsaved changes?</AlertDialogTitle>
                        <AlertDialogDescription>This permanently clears the {totalDirty} unsaved change{totalDirty !== 1 ? 's' : ''} on the pivot — new pulls, weight edits, re-tags, and pending deletions — plus the device backup. This can&apos;t be undone.</AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                        <AlertDialogCancel>Keep editing</AlertDialogCancel>
                        <AlertDialogAction onClick={handleDiscardConfirm} className="bg-destructive text-destructive-foreground hover:bg-destructive/90">Discard all</AlertDialogAction>
                    </AlertDialogFooter>
                </AlertDialogContent>
            </AlertDialog>
        </div>
    );

    // Capture the on-screen rect of a mounted cell (for parent-level popover anchoring).
    function cellRect(navId: string): { x: number; y: number } {
        const el = gridRef.current?.querySelector<HTMLElement>(`[data-navid="${CSS.escape(navId)}"]`);
        if (el) { const r = el.getBoundingClientRect(); return { x: r.right, y: r.bottom }; }
        return { x: window.innerWidth / 2, y: window.innerHeight / 2 };
    }
}

// ─── Add-day control (append-edge only) ───────────────────────────────────────────────
function AddDayControl({ onAddDay, existingDates, atLatest, disabled }: {
    onAddDay: (date: string) => void;
    existingDates: Set<string>;
    atLatest: boolean;
    disabled?: boolean;
}) {
    const [open, setOpen] = React.useState(false);
    const [date, setDate] = React.useState('');
    const [error, setError] = React.useState<string | null>(null);

    const submit = () => {
        const norm = normalizeTypedDate(date.trim(), new Date().getFullYear());
        const d = parseISO(norm);
        if (!isValid(d) || !/^\d{4}-\d{2}-\d{2}$/.test(norm)) { setError('Enter a valid date (e.g. 5/4 or 2026-05-04).'); return; }
        if (existingDates.has(norm)) { setError('That day is already shown.'); return; }
        onAddDay(norm);
        setDate(''); setError(null); setOpen(false);
    };

    return (
        <Popover open={open} onOpenChange={(o) => { setOpen(o); if (!o) { setError(null); setDate(''); } }}>
            <PopoverAnchor asChild>
                <Button
                    variant="outline"
                    size="sm"
                    className="h-6 gap-1 px-2 text-[11px]"
                    disabled={disabled || !atLatest}
                    title={atLatest ? 'Add a new production day at the newest edge' : 'Scroll/jump to the newest day to add a new day'}
                    onClick={() => setOpen((o) => !o)}
                >
                    <CalendarPlus className="h-3 w-3" />Add day
                </Button>
            </PopoverAnchor>
            <PopoverContent align="start" className="w-56 bg-popover/95 p-3 backdrop-blur-lg">
                <div className="space-y-2">
                    <Label className="text-[10px] uppercase tracking-wide text-muted-foreground">New production day (newest edge)</Label>
                    <Input
                        autoFocus
                        value={date}
                        onChange={(e) => { setDate(e.target.value); setError(null); }}
                        onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); submit(); } }}
                        placeholder="yyyy-MM-dd"
                        className="h-7 font-mono text-[11px]"
                    />
                    {error && <p className="text-[10px] text-destructive">{error}</p>}
                    <div className="flex justify-end gap-1.5 pt-0.5">
                        <Button variant="ghost" size="sm" className="h-6 px-2 text-[11px]" onClick={() => setOpen(false)}>Cancel</Button>
                        <Button size="sm" className="h-6 gap-1 px-2 text-[11px]" onClick={submit}><Plus className="h-3 w-3" />Add</Button>
                    </div>
                </div>
            </PopoverContent>
        </Popover>
    );
}

// ─── Edit-pull dialog (row-level identity re-tag; re-buckets after save) ──────────────
function EditPullDialog({ leaf, plantView, hasBagging, onSave, onCancel }: {
    leaf: RecvRow;
    plantView: PlantView;
    hasBagging: boolean;
    onSave: (edit: { shift: string; grade: string; source: string; recvDate: string; warehouse?: string; side?: string }) => void;
    onCancel: () => void;
}) {
    const [shift, setShift] = React.useState(leaf.shift);
    const [grade, setGrade] = React.useState(leaf.grade);
    const [source, setSource] = React.useState(leaf.source);
    const [recv, setRecv] = React.useState(leaf.recvDate);
    const [warehouse, setWarehouse] = React.useState('__keep');
    const [side, setSide] = React.useState('__keep');
    const sourceOptions = SOURCE_SETS[plantView];

    const submit = () => {
        const yr = parseISO(leaf.prodDate).getFullYear() || new Date().getFullYear();
        onSave({
            shift: normalizeIdentity(shift, SHIFT_CODES as readonly string[]),
            grade: normalizeIdentity(grade, GRADE_CODES as readonly string[]),
            source: normalizeIdentity(source, sourceOptions),
            recvDate: normalizeTypedDate(recv, yr),
            warehouse: warehouse === '__keep' ? undefined : warehouse === '__none' ? '' : warehouse,
            side: side === '__keep' ? undefined : side === '__none' ? '' : side,
        });
    };

    return (
        <AlertDialog open onOpenChange={(o) => { if (!o) onCancel(); }}>
            <AlertDialogContent>
                <AlertDialogHeader>
                    <AlertDialogTitle>Edit pull identity</AlertDialogTitle>
                    <AlertDialogDescription>Re-tag this pull. On save the events update and the day re-pivots — the row moves into its correct group.</AlertDialogDescription>
                </AlertDialogHeader>
                <div className="grid grid-cols-2 gap-3">
                    <div className="space-y-1">
                        <Label className="text-[10px] uppercase tracking-wide text-muted-foreground">Shift</Label>
                        <Select value={shift} onValueChange={setShift}>
                            <SelectTrigger size="sm" className="h-7 text-[11px]"><SelectValue placeholder="—" /></SelectTrigger>
                            <SelectContent>{SHIFT_CODES.map((s) => <SelectItem key={s} value={s} className="text-[11px]">{s} · {SHIFT_LABEL[s]}</SelectItem>)}</SelectContent>
                        </Select>
                    </div>
                    <div className="space-y-1">
                        <Label className="text-[10px] uppercase tracking-wide text-muted-foreground">Grade</Label>
                        <Select value={grade} onValueChange={setGrade}>
                            <SelectTrigger size="sm" className="h-7 text-[11px]"><SelectValue placeholder="—" /></SelectTrigger>
                            <SelectContent>{GRADE_CODES.map((g) => <SelectItem key={g} value={g} className="text-[11px]">{g}</SelectItem>)}</SelectContent>
                        </Select>
                    </div>
                    <div className="space-y-1">
                        <Label className="text-[10px] uppercase tracking-wide text-muted-foreground">Source</Label>
                        <Select value={source} onValueChange={setSource}>
                            <SelectTrigger size="sm" className="h-7 text-[11px]"><SelectValue placeholder="—" /></SelectTrigger>
                            <SelectContent>{sourceOptions.map((s) => <SelectItem key={s} value={s} className="text-[11px]">{s}</SelectItem>)}</SelectContent>
                        </Select>
                    </div>
                    <div className="space-y-1">
                        <Label className="text-[10px] uppercase tracking-wide text-muted-foreground">Recv date</Label>
                        <Input value={recv} onChange={(e) => setRecv(e.target.value)} className="h-7 font-mono text-[11px]" placeholder="yyyy-MM-dd" />
                    </div>
                    {hasBagging && (
                        <>
                            <div className="space-y-1">
                                <Label className="text-[10px] uppercase tracking-wide text-muted-foreground">Whse (bagging)</Label>
                                <Select value={warehouse} onValueChange={setWarehouse}>
                                    <SelectTrigger size="sm" className="h-7 text-[11px]"><SelectValue /></SelectTrigger>
                                    <SelectContent>
                                        <SelectItem value="__keep" className="text-[11px]">— Keep</SelectItem>
                                        <SelectItem value="__none" className="text-[11px]">— Unplaced</SelectItem>
                                        {WAREHOUSE_CODES.map((w) => <SelectItem key={w} value={w} className="text-[11px]">{w}</SelectItem>)}
                                    </SelectContent>
                                </Select>
                            </div>
                            <div className="space-y-1">
                                <Label className="text-[10px] uppercase tracking-wide text-muted-foreground">Side (bagging)</Label>
                                <Select value={side} onValueChange={setSide}>
                                    <SelectTrigger size="sm" className="h-7 text-[11px]"><SelectValue /></SelectTrigger>
                                    <SelectContent>
                                        <SelectItem value="__keep" className="text-[11px]">— Keep</SelectItem>
                                        <SelectItem value="__none" className="text-[11px]">— None</SelectItem>
                                        {WHSE_SIDES.map((s) => <SelectItem key={s} value={s} className="text-[11px]">{s}</SelectItem>)}
                                    </SelectContent>
                                </Select>
                            </div>
                        </>
                    )}
                </div>
                <AlertDialogFooter>
                    <AlertDialogCancel onClick={onCancel}>Cancel</AlertDialogCancel>
                    <AlertDialogAction onClick={submit}>Save re-tag</AlertDialogAction>
                </AlertDialogFooter>
            </AlertDialogContent>
        </AlertDialog>
    );
}
