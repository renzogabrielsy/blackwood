'use client';

import * as React from 'react';
import { format as formatDate, parseISO, isValid as isValidDate } from 'date-fns';
import { Inbox, Lock, Save, RotateCcw, CalendarPlus, Plus } from 'lucide-react';
import { cn } from '@/lib/utils';
import { errorToast } from '@/lib/toast';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
    Popover,
    PopoverContent,
    PopoverTrigger,
} from '@/components/ui/popover';
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from '@/components/ui/select';
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
import type { ProductionEventRow } from '../types';
import {
    SHIFT_CODES,
    GRADE_CODES,
    CRUSHER_CODES,
    KILN_CODES,
    WAREHOUSE_CODES,
    WHSE_SIDES,
} from '../types';
import { normalizeTypedDate } from '@/lib/paste-utils';
import { saveProductionEvents, type ProductionEventDirtyRow, type CenaproPeriod } from './actions';

// ─── Daily Block view (EDITABLE PROD-2026 pivot, per production plant) ──────────────
// Rebuilds the boss's "PROD 2026" spreadsheet from the SAME period rows the editable
// ledger holds, split into a W6 and a W7 variant by the SOURCE of the material. Always
// groups by prod_date (PROD-ONLY). Filters by source set and EXCLUDES FLEC/DVO.
//
// Hierarchy: PROD_DATE → SHIFT (M/E/N) → GRADE → SOURCE → RECV_DATE. A LEAF = one
// (source, recv_date) "pull". The Source cell rowSpans its recv-date rows.
//
// PHASE 1 — EDITABLE NUMBERS on existing pull rows (round-trip via the existing
// `saveProductionEvents(dirtyRows, deletedIds)` action — NO new backend): editable equip/
// bagging cells; EDIT→UPDATE; CLEAR→DELETE (AlertDialog); TYPE-into-blank→column-aware
// popover→INSERT; collision-lock on cells whose 9-col pivot key maps to >1 event.
//
// PHASE 2 — NEW PULLS + NEW DAYS (same staged-INSERT → saveProductionEvents path):
//   • FILLER rows are now editable "new pull" input slots: pick shift/grade/source/recv
//     date, then type equipment/bagging weights. A complete-identity filler row stages one
//     INSERT per non-empty weight column (crushers/kilns directly; bagging via the small
//     warehouse/side/flec popover — source comes from the row's Source cell). Incomplete
//     identity blocks the weight with a gentle toast.
//   • Each day ALWAYS keeps ≥1 trailing empty input slot (so you can always add another
//     pull); filling the last slot grows the day.
//   • "Add day" spawns a new empty outlined day block (a prod_date) ready to fill. Added
//     days live as local draft state and sort into chronological position; an empty added
//     day saves nothing.
//   • Draft rows render FLAT (un-merged) while in draft — their grouping isn't final until
//     save + refresh, when they become real merged rows.
//
// READ-ONLY layout intact: real-row merges/rowSpan, gridlines, day box, slim footer, badges,
// fixed columns, Excel widths, frozen panes, 2-tier header. Section-level motion only.

export type PlantView = 'W6' | 'W7';

const EQUIPMENT_CODES = [...CRUSHER_CODES, ...KILN_CODES] as const;
type EquipmentCode = (typeof EQUIPMENT_CODES)[number];
const SHIFT_ORDER = SHIFT_CODES; // ['M', 'E', 'N']
const EDIT_COLUMNS: readonly EditColumn[] = [...EQUIPMENT_CODES, 'BAGGING'];

// ─── Keyboard-navigation column model ────────────────────────────────────────────────
// Every NAVIGABLE cell is addressed by a colKey. Identity cols are editable on FILLER rows
// only; weight cols (equip + BAGGING) on real (unless collision-locked) AND filler rows.
// The left→right order here is the Tab order within a row (identity first, then weights).
type NavColKey = 'shift' | 'grade' | 'source' | 'recv' | EditColumn;
const NAV_COL_ORDER: readonly NavColKey[] = ['shift', 'grade', 'source', 'recv', ...EQUIPMENT_CODES, 'BAGGING'];
const navColIndex = (c: NavColKey): number => NAV_COL_ORDER.indexOf(c);

// Build the cell `data-navid` (rowKey | colKey). Inputs carry it so the grid-level keydown
// can read the ordered cell list straight from the DOM (document order == render order),
// which is far more robust than re-deriving order from the merged/pivot data model.
function navId(rowKey: string, colKey: NavColKey): string { return `${rowKey}|${colKey}`; }
function parseNavId(id: string): { rowKey: string; colKey: NavColKey } {
    const i = id.lastIndexOf('|');
    return { rowKey: id.slice(0, i), colKey: id.slice(i + 1) as NavColKey };
}

// Given the ordered nav cells and the current index, find the target cell in the NEXT
// (dir=+1) / PREVIOUS (dir=-1) editable row: prefer the same `colKey`; if that row lacks it
// (e.g. a real row has no editable identity column), fall back to the closest column in that
// row — the cell with the nearest colKey index. Returns null when there's no such row.
function findColInAdjacentRow(
    cells: { el: HTMLInputElement; rowKey: string; colKey: NavColKey }[],
    idx: number,
    colKey: NavColKey,
    dir: 1 | -1,
): { el: HTMLInputElement; rowKey: string; colKey: NavColKey } | null {
    const curRow = cells[idx]?.rowKey;
    if (curRow == null) return null;
    // Walk to the first cell whose rowKey differs from the current row.
    let i = idx + dir;
    while (i >= 0 && i < cells.length && cells[i].rowKey === curRow) i += dir;
    if (i < 0 || i >= cells.length) return null;
    const targetRow = cells[i].rowKey;
    // Gather all cells of that target row.
    const rowCells = cells.filter((c) => c.rowKey === targetRow);
    // Exact column match?
    const exact = rowCells.find((c) => c.colKey === colKey);
    if (exact) return exact;
    // Else nearest column by NAV_COL_ORDER index.
    const want = navColIndex(colKey);
    let best = rowCells[0];
    let bestDist = Math.abs(navColIndex(best.colKey) - want);
    for (const c of rowCells) {
        const d = Math.abs(navColIndex(c.colKey) - want);
        if (d < bestDist) { best = c; bestDist = d; }
    }
    return best ?? null;
}

// An editable column = one equipment code or the Bagging (FLEC) bucket.
const BAGGING = 'BAGGING' as const;
type EditColumn = EquipmentCode | typeof BAGGING;

// Column → (disposition_kind, partner_equipment_code) — the write-back contract §3.
function columnDisposition(col: EditColumn): { disposition_kind: string; partner_equipment_code: string } {
    if (col === BAGGING) return { disposition_kind: 'flec_bagging', partner_equipment_code: '' };
    if ((CRUSHER_CODES as readonly string[]).includes(col)) return { disposition_kind: 'partner_crusher', partner_equipment_code: col };
    return { disposition_kind: 'partner_kiln', partner_equipment_code: col }; // RK1–RK4
}

// Minimum DATA rows per day (TUNABLE) — a sparse day is padded with blank filler input slots
// up to this count. PLUS there is ALWAYS at least one trailing empty slot beyond it.
const MIN_DAY_ROWS = 6;

// The allowed source set + display ORDER per plant variant. FLEC/DVO are absent from BOTH.
const SOURCE_SETS: Record<PlantView, readonly string[]> = {
    W6: ['TNK 1', 'TNK 2', 'TNK 3', 'TNK 4', 'W6'],
    W7: ['W7'],
};

interface ProductionDailyBlockProps {
    /** The same period-scoped event rows the ledger holds (typed DB fields). */
    rows: ProductionEventRow[];
    /** Which production plant this variant shows — drives the source filter + ordering. */
    plantView: PlantView;
    /** The active (batch_year, batch) period — supplies batch/batch_year for INSERTs. */
    selectedPeriod: CenaproPeriod | null;
    /** Called after a successful save so the parent can refresh (router.refresh remount). */
    onSaveSuccess: () => void;
}

// ─── Pivot data model ──────────────────────────────────────────────────────────────
interface CellSlot {
    weight: number;
    eventIds: string[];
}

type CellMap = Record<EditColumn, CellSlot>;

function emptyCellMap(): CellMap {
    const m = {} as CellMap;
    for (const c of EQUIPMENT_CODES) m[c] = { weight: 0, eventIds: [] };
    m[BAGGING] = { weight: 0, eventIds: [] };
    return m;
}

interface RecvRow {
    recvDate: string;
    prodDate: string;
    shift: string;
    grade: string;
    source: string;
    cells: CellMap;
    subTotal: number;
    total: number;
}

interface SourceBlock {
    source: string;
    recvRows: RecvRow[];
}

interface GradeBlock {
    grade: string;
    sources: SourceBlock[];
    leafCount: number;
}

interface ShiftBlock {
    shift: string;
    grades: GradeBlock[];
}

interface DailyTotals {
    equip: Record<EquipmentCode, number>;
    bagging: number;
    subTotal: number;
    total: number;
}

interface DateGroup {
    date: string;
    shifts: ShiftBlock[];
    daily: DailyTotals;
}

// Thousands-separated; blank when 0/empty.
function fmt(n: number): string {
    if (!n) return '';
    return Math.round(n).toLocaleString('en-US');
}

function parseWeight(raw: string): number | null {
    const t = raw.replace(/[,\s]/g, '').trim();
    if (t === '') return null;
    const n = Number(t);
    return Number.isFinite(n) ? n : null;
}

function formatDayLabel(date: string): string {
    const d = parseISO(date);
    if (!isValidDate(d)) return date;
    return formatDate(d, 'EEE · MMM d');
}

function formatRecvLabel(date: string): string {
    const d = parseISO(date);
    if (!isValidDate(d)) return date;
    return formatDate(d, 'MMM d');
}

// Pivot flat rows → prod_date → shift → grade → source → recv_date, recording per-column
// event ids (for edit/delete targeting + collision lock). Pure.
function buildDateGroups(
    rows: ProductionEventRow[],
    plantView: PlantView,
): { groups: DateGroup[] } {
    const allowed = SOURCE_SETS[plantView];
    const sourceRank = (s: string) => { const i = allowed.indexOf(s); return i < 0 ? 99 : i; };

    const leafMap = new Map<string, RecvRow>();

    for (const r of rows) {
        const source = (r.source_location_code ?? '').trim();
        if (!allowed.includes(source)) continue; // excludes FLEC/DVO + out-of-variant
        const prodDate = (r.prod_date ?? '').trim();
        if (!prodDate) continue;
        const shift = (r.shift_code ?? '').trim();
        const grade = (r.grade_code ?? '').trim();
        const recvDate = (r.recv_date ?? '').trim();
        const key = `${prodDate}|${shift}|${grade}|${source}|${recvDate}`;

        let leaf = leafMap.get(key);
        if (!leaf) {
            leaf = { recvDate, prodDate, shift, grade, source, cells: emptyCellMap(), subTotal: 0, total: 0 };
            leafMap.set(key, leaf);
        }

        const weight = Number(r.weight_kg) || 0;
        const disposition = (r.disposition_kind ?? '').trim();
        const equip = (r.partner_equipment_code ?? '').trim() as EquipmentCode;
        const id = (r.id ?? '').trim();

        let col: EditColumn | null = null;
        if (disposition === 'flec_bagging') col = BAGGING;
        else if ((EQUIPMENT_CODES as readonly string[]).includes(equip)) col = equip;
        if (!col) continue;

        const slot = leaf.cells[col];
        slot.weight += weight;
        if (id) slot.eventIds.push(id);
    }

    for (const leaf of leafMap.values()) {
        const sub = EQUIPMENT_CODES.reduce((s, c) => s + leaf.cells[c].weight, 0);
        leaf.subTotal = sub;
        leaf.total = sub + leaf.cells[BAGGING].weight;
    }

    const shiftRank = (s: string) => { const i = SHIFT_ORDER.indexOf(s as never); return i < 0 ? 99 : i; };
    const gradeRank = (g: string) => { const i = GRADE_CODES.indexOf(g as never); return i < 0 ? 99 : i; };

    const byDate = new Map<string, RecvRow[]>();
    for (const leaf of leafMap.values()) {
        const arr = byDate.get(leaf.prodDate) ?? [];
        arr.push(leaf);
        byDate.set(leaf.prodDate, arr);
    }

    const groups: DateGroup[] = Array.from(byDate.entries())
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([date, leafArr]) => {
            const shiftMap = new Map<string, Map<string, Map<string, RecvRow[]>>>();
            for (const leaf of leafArr) {
                let gm = shiftMap.get(leaf.shift);
                if (!gm) { gm = new Map(); shiftMap.set(leaf.shift, gm); }
                let sm = gm.get(leaf.grade);
                if (!sm) { sm = new Map(); gm.set(leaf.grade, sm); }
                const arr = sm.get(leaf.source) ?? [];
                arr.push(leaf);
                sm.set(leaf.source, arr);
            }

            const shifts: ShiftBlock[] = Array.from(shiftMap.entries())
                .sort(([a], [b]) => shiftRank(a) - shiftRank(b))
                .map(([shift, gradeMap]) => {
                    const grades: GradeBlock[] = Array.from(gradeMap.entries())
                        .sort(([a], [b]) => gradeRank(a) - gradeRank(b))
                        .map(([grade, sourceMap]) => {
                            const sources: SourceBlock[] = Array.from(sourceMap.entries())
                                .sort(([a], [b]) => sourceRank(a) - sourceRank(b))
                                .map(([source, recvRows]) => {
                                    recvRows.sort((a, b) => a.recvDate.localeCompare(b.recvDate));
                                    return { source, recvRows };
                                });
                            const leafCount = sources.reduce((acc, s) => acc + s.recvRows.length, 0);
                            return { grade, sources, leafCount };
                        });
                    return { shift, grades };
                });

            const daily: DailyTotals = {
                equip: EQUIPMENT_CODES.reduce((acc, c) => { acc[c] = 0; return acc; }, {} as Record<EquipmentCode, number>),
                bagging: 0,
                subTotal: 0,
                total: 0,
            };
            for (const leaf of leafArr) {
                for (const c of EQUIPMENT_CODES) daily.equip[c] += leaf.cells[c].weight;
                daily.bagging += leaf.cells[BAGGING].weight;
            }
            daily.subTotal = EQUIPMENT_CODES.reduce((s, c) => s + daily.equip[c], 0);
            daily.total = daily.subTotal + daily.bagging;

            return { date, shifts, daily };
        });

    return { groups };
}

// ─── Column geometry (matched to the boss's PROD 2026 sheet) ───────────────────────
const W_DATE = 108;
const W_SHIFT = 48;
const W_GRADE = 100;
const W_SOURCE = 140;
const W_RECV = 80;
const LEFT_DATE = 0;
const LEFT_SHIFT = W_DATE;
const LEFT_GRADE = W_DATE + W_SHIFT;
const LEFT_SOURCE = W_DATE + W_SHIFT + W_GRADE;
const LEFT_RECV = W_DATE + W_SHIFT + W_GRADE + W_SOURCE;
const W_EQUIP = 56;
const W_BAG = 66;
const W_SUB = 70;
const W_TOTAL = 84;
const IDENTITY_WIDTH = W_DATE + W_SHIFT + W_GRADE + W_SOURCE + W_RECV;

const ACTIVE_EQUIP: readonly EquipmentCode[] = EQUIPMENT_CODES;
const CRUSHER_COUNT = CRUSHER_CODES.length;

// ─── Color systems ──────────────────────────────────────────────────────────────────
const SHIFT_LETTER: Record<string, string> = {
    M: 'text-amber-600 dark:text-amber-400',
    E: 'text-violet-600 dark:text-violet-400',
    N: 'text-indigo-600 dark:text-indigo-400',
};
const SHIFT_LABEL: Record<string, string> = { M: 'Morning', E: 'Evening', N: 'Night' };

const GRADE_CHIP: Record<string, string> = {
    '3X50': 'bg-sky-500/15 text-sky-700 ring-sky-500/30 dark:text-sky-300',
    '2X6': 'bg-teal-500/15 text-teal-700 ring-teal-500/30 dark:text-teal-300',
    '3.5': 'bg-amber-500/15 text-amber-700 ring-amber-500/30 dark:text-amber-300',
    '4X8': 'bg-rose-500/15 text-rose-700 ring-rose-500/30 dark:text-rose-300',
};

const pillBase = 'inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-bold leading-none ring-1 ring-inset';

// ─── Border tokens (spreadsheet feel) ───────────────────────────────────────────────
const GRID = 'border-b border-r border-border';
const GROUP = 'border-l-2 border-l-border';
const BOX = 'border-border';

// Active-cell highlight — MATCHES the production ledger's selected-cell look
// (`ring-2 ring-primary ring-inset`). An INSET ring takes NO layout space (it's a
// box-shadow), so the focused cell stays the same height as every other cell (no expansion).
// `z-20` lifts the active cell ABOVE the z-10 frozen/sticky columns (`.frozen-col` /
// `.frozen-edge`) so its ring is never clipped or hidden behind an adjacent sticky cell when
// horizontally scrolled. Static — NO transition on the cell-selection highlight (CLAUDE.md).
// Sits ON TOP of any dirty (blue/amber/destructive) cell tint (later `ring-*` wins the ring
// color/width; the dirty `bg-*` tint remains), so both read together.
const ACTIVE_RING = 'z-20 ring-2 ring-primary ring-inset';

// ─── Uniform row height ──────────────────────────────────────────────────────────────
// EVERY row — real data, filler/input, AND the daily-total footer — is exactly this tall.
// Applied to the <tr> (`ROW_H`) so no row is taller than another. Cells use vertical
// padding only via the shared CELL_PAD so the editing input (which matches the static
// metrics exactly) can never grow the row.
const ROW_H = 'h-7'; // 28px — the single canonical row height
const CELL_PAD = 'px-1.5 py-0.5';

// The CANONICAL inline-edit input class. An editing input must visually MATCH the static
// cell EXACTLY — same font-size (text-[11px]), padding (px-1.5), transparent bg, no border,
// no focus ring/outline, full height, box-border, no margin/min-height, spinner killed —
// so clicking a cell to edit changes ONLY the caret, never the row height.
const EDIT_INPUT =
    'm-0 box-border h-full w-full appearance-none border-0 bg-transparent px-1.5 py-0 text-[11px] leading-none outline-none focus:ring-0 focus-visible:ring-0 [min-height:0]';

// ─── Filler-identity typeahead datalists (Excel-style: input + datalist, NOT a Select) ─
const DL_SHIFT = 'daily-filler-shift';
const DL_GRADE = 'daily-filler-grade';
const DL_SOURCE_W6 = 'daily-filler-source-w6';
const DL_SOURCE_W7 = 'daily-filler-source-w7';
function sourceDatalistId(pv: PlantView) { return pv === 'W6' ? DL_SOURCE_W6 : DL_SOURCE_W7; }

// Case-insensitive normalize of a typed identity value against an allowed set, with a few
// friendly aliases (e.g. "t1"/"tnk1"/"tank 1" → "TNK 1"). Returns the canonical value when
// it matches cleanly, else the trimmed raw text (kept so the user sees it but it won't stage).
function normalizeIdentity(raw: string, options: readonly string[]): string {
    const t = raw.trim();
    if (!t) return '';
    const up = t.toUpperCase().replace(/\s+/g, ' ');
    const exact = options.find((o) => o.toUpperCase() === up);
    if (exact) return exact;
    // tank aliases: t1 / tnk1 / tank 1 → TNK 1
    const tank = up.match(/^(?:T|TNK|TANK)\s*0*(\d+)$/);
    if (tank) { const cand = `TNK ${tank[1]}`; if (options.includes(cand)) return cand; }
    // collapse-spaces compare (e.g. "3 X 50" → "3X50")
    const compact = up.replace(/\s+/g, '');
    const byCompact = options.find((o) => o.toUpperCase().replace(/\s+/g, '') === compact);
    if (byCompact) return byCompact;
    return t; // keep raw — won't validate / stage
}

// ─── Edit-state types ────────────────────────────────────────────────────────────────
interface StagedInsert {
    cellKey: string;
    row: ProductionEventDirtyRow;
}

// Per-bagging-cell warehouse fields (captured via the small popover on a draft row).
interface BaggingMeta {
    warehouse: string; // '' = unplaced
    side: string;      // '' = none
    flec: string;      // '' = none
}

// A FILLER / NEW-DAY draft = one un-saved pull. Holds the typed identity + per-column
// weights (strings) + per-bagging-cell warehouse meta. Keyed by a stable local id.
interface FillerDraft {
    key: string;
    dayDate: string;   // the prod_date (the day block it sits in) — fixed
    shift: string;
    grade: string;
    source: string;
    recvDate: string;
    weights: Partial<Record<EditColumn, string>>;
    bagging?: BaggingMeta; // only relevant for the Bagging column
}

function draftIdentityComplete(d: FillerDraft): boolean {
    return !!(d.shift.trim() && d.grade.trim() && d.source.trim() && d.recvDate.trim());
}

function draftHasWeights(d: FillerDraft): boolean {
    return EDIT_COLUMNS.some((c) => {
        const w = parseWeight(d.weights[c] ?? '');
        return w != null && w > 0;
    });
}

// Build the staged INSERT dirty rows for ONE complete draft (one per non-empty weight col).
function draftToDirtyRows(d: FillerDraft, plantView: PlantView, period: CenaproPeriod | null): ProductionEventDirtyRow[] {
    if (!draftIdentityComplete(d)) return [];
    const out: ProductionEventDirtyRow[] = [];
    for (const col of EDIT_COLUMNS) {
        const w = parseWeight(d.weights[col] ?? '');
        if (w == null || w <= 0) continue;
        const { disposition_kind, partner_equipment_code } = columnDisposition(col);
        const isBag = col === BAGGING;
        out.push({
            // no id → INSERT
            recv_date: d.recvDate,
            prod_date: d.dayDate,
            batch: period?.batch ?? '',
            shift_code: d.shift,
            grade_code: d.grade,
            plant_code: plantView, // auto-stamp
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

// ─── Edit context (threaded to every editable cell + filler row) ────────────────────
interface EditContext {
    period: CenaproPeriod | null;
    plantView: PlantView;
    modified: Map<string, string>;
    staged: Map<string, StagedInsert>;
    deleted: Set<string>;
    drafts: Map<string, FillerDraft>;
    onEditWeight: (eventId: string, weight: string) => void;
    onClearEdit: (eventId: string) => void;
    onDeleteEvent: (eventId: string) => void;
    onStageInsert: (cellKey: string, row: ProductionEventDirtyRow) => void;
    onUnstageInsert: (cellKey: string) => void;
    upsertDraft: (key: string, patch: Partial<FillerDraft>, dayDate: string) => void;
    notifyIncomplete: () => void;
    /** The currently keyboard-active cell's navId (drives autofocus on programmatic nav). */
    activeNavId: string | null;
    /** Set the active cell (a cell calls this on focus, so click + keyboard share one model). */
    onActivate: (navId: string | null) => void;
    /** Clear the Enter-anchor (called on a fresh mouse click — ends any Tab run). */
    clearAnchor: () => void;
}

export function ProductionDailyBlock({ rows, plantView, selectedPeriod, onSaveSuccess }: ProductionDailyBlockProps) {
    const { groups } = React.useMemo(() => buildDateGroups(rows, plantView), [rows, plantView]);

    // ─── Edit state (Phase 1) ──────────────────────────────────────────────────────
    const [modified, setModified] = React.useState<Map<string, string>>(new Map());
    const [staged, setStaged] = React.useState<Map<string, StagedInsert>>(new Map());
    const [deleted, setDeleted] = React.useState<Set<string>>(new Set());
    // ─── Draft state (Phase 2): filler/new-day pulls + added empty days ─────────────
    const [drafts, setDrafts] = React.useState<Map<string, FillerDraft>>(new Map());
    const [addedDays, setAddedDays] = React.useState<string[]>([]);

    const [isSaving, setIsSaving] = React.useState(false);
    const [confirmDelete, setConfirmDelete] = React.useState<{ eventId: string; label: string } | null>(null);

    // ─── Keyboard navigation (Tab / Shift+Tab / Enter-anchor / arrows) ──────────────
    const gridScrollRef = React.useRef<HTMLDivElement>(null);
    const [activeNavId, setActiveNavId] = React.useState<string | null>(null);
    // The colKey a Tab RUN started from — a later Enter returns to it on the next row
    // (mirrors the bulk-add modal's enterAnchorColRef). Held in a ref (no re-render).
    const enterAnchorColRef = React.useRef<NavColKey | null>(null);

    const onActivate = React.useCallback((id: string | null) => setActiveNavId(id), []);
    const clearAnchor = React.useCallback(() => { enterAnchorColRef.current = null; }, []);

    // Ordered list of focusable nav inputs, straight from the DOM (document order == render
    // order). Returns the input elements + their parsed (rowKey, colKey).
    const navCells = React.useCallback((): { el: HTMLInputElement; rowKey: string; colKey: NavColKey }[] => {
        const root = gridScrollRef.current;
        if (!root) return [];
        return Array.from(root.querySelectorAll<HTMLInputElement>('input[data-navid]')).map((el) => {
            const { rowKey, colKey } = parseNavId(el.dataset.navid as string);
            return { el, rowKey, colKey };
        });
    }, []);

    const focusNav = React.useCallback((el: HTMLInputElement | null) => {
        if (!el) return;
        el.focus();
        el.select?.();
        // Keep the focused cell visible without a jarring jump.
        el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }, []);

    // The grid-level keydown: when an editable cell is focused, Tab/Enter/arrows move the
    // active cell (commit happens via the moved-FROM input's blur). Skips read-only/locked
    // cells automatically — they simply aren't in the DOM nav list.
    const handleGridKeyDown = React.useCallback((e: React.KeyboardEvent) => {
        const target = e.target as HTMLElement;
        const id = target?.dataset?.navid;
        if (!id) return; // not an editable cell — let native behavior run
        const cells = navCells();
        const idx = cells.findIndex((c) => c.el === target);
        if (idx < 0) return;
        const cur = cells[idx];

        if (e.key === 'Tab') {
            e.preventDefault();
            // Remember the anchor at the START of a Tab run.
            if (enterAnchorColRef.current === null) enterAnchorColRef.current = cur.colKey;
            const next = e.shiftKey ? cells[idx - 1] : cells[idx + 1];
            focusNav(next?.el ?? null); // at the ends, stay put (commit already ran on blur)
            return;
        }

        if (e.key === 'Enter') {
            e.preventDefault();
            if (e.shiftKey) {
                // Shift+Enter → up one editable row (same column if present, else nearest).
                enterAnchorColRef.current = null;
                const prevRowCell = findColInAdjacentRow(cells, idx, cur.colKey, -1);
                focusNav(prevRowCell?.el ?? null);
                return;
            }
            // Enter → down one editable row, returning to the ANCHOR column (or current),
            // then consume the anchor (so a following plain Enter goes straight down).
            const anchorCol = enterAnchorColRef.current ?? cur.colKey;
            const downCell = findColInAdjacentRow(cells, idx, anchorCol, +1);
            enterAnchorColRef.current = null;
            focusNav(downCell?.el ?? null);
            return;
        }

        if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
            // Move within editable cells horizontally; ends a Tab run.
            e.preventDefault();
            enterAnchorColRef.current = null;
            const next = e.key === 'ArrowRight' ? cells[idx + 1] : cells[idx - 1];
            focusNav(next?.el ?? null);
            return;
        }

        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            // Move within a column to the nearest editable row that has that column; ends a run.
            e.preventDefault();
            enterAnchorColRef.current = null;
            const dir = e.key === 'ArrowDown' ? +1 : -1;
            const cell = findColInAdjacentRow(cells, idx, cur.colKey, dir);
            focusNav(cell?.el ?? null);
            return;
        }
    }, [navCells, focusNav]);

    const resetAll = React.useCallback(() => {
        setModified(new Map());
        setStaged(new Map());
        setDeleted(new Set());
        setDrafts(new Map());
        setAddedDays([]);
    }, []);

    React.useEffect(() => { resetAll(); }, [rows, plantView, resetAll]);

    const onEditWeight = React.useCallback((eventId: string, weight: string) => {
        setModified((prev) => { const next = new Map(prev); next.set(eventId, weight); return next; });
    }, []);
    const onClearEdit = React.useCallback((eventId: string) => {
        setModified((prev) => { if (!prev.has(eventId)) return prev; const next = new Map(prev); next.delete(eventId); return next; });
    }, []);
    const onDeleteEvent = React.useCallback((eventId: string) => {
        setDeleted((prev) => { const next = new Set(prev); next.add(eventId); return next; });
        setModified((prev) => { if (!prev.has(eventId)) return prev; const next = new Map(prev); next.delete(eventId); return next; });
    }, []);
    const onStageInsert = React.useCallback((cellKey: string, row: ProductionEventDirtyRow) => {
        setStaged((prev) => { const next = new Map(prev); next.set(cellKey, { cellKey, row }); return next; });
    }, []);
    const onUnstageInsert = React.useCallback((cellKey: string) => {
        setStaged((prev) => { if (!prev.has(cellKey)) return prev; const next = new Map(prev); next.delete(cellKey); return next; });
    }, []);

    // Create-or-merge a draft by local key (the FillerRow owns the input state and pushes
    // committed values up here so the draft survives re-renders + feeds save/count).
    const upsertDraft = React.useCallback((key: string, patch: Partial<FillerDraft>, dayDate: string) => {
        setDrafts((prev) => {
            const next = new Map(prev);
            const existing = next.get(key) ?? { key, dayDate, shift: '', grade: '', source: '', recvDate: '', weights: {} };
            next.set(key, { ...existing, ...patch, weights: { ...existing.weights, ...(patch.weights ?? {}) }, dayDate });
            return next;
        });
    }, []);

    const notifyIncomplete = React.useCallback(() => {
        toast.warning('Set shift, grade, source, and recv date first.');
    }, []);

    const addDay = React.useCallback((date: string) => {
        setAddedDays((prev) => (prev.includes(date) ? prev : [...prev, date]));
    }, []);

    const editCtx: EditContext = React.useMemo(
        () => ({
            period: selectedPeriod, plantView, modified, staged, deleted, drafts,
            onEditWeight, onClearEdit, onDeleteEvent, onStageInsert, onUnstageInsert, upsertDraft, notifyIncomplete,
            activeNavId, onActivate, clearAnchor,
        }),
        [selectedPeriod, plantView, modified, staged, deleted, drafts, onEditWeight, onClearEdit, onDeleteEvent, onStageInsert, onUnstageInsert, upsertDraft, notifyIncomplete, activeNavId, onActivate, clearAnchor],
    );

    // Draft-derived INSERT count (one event per filled column on a complete draft).
    const draftInsertRows = React.useMemo(
        () => Array.from(drafts.values()).flatMap((d) => draftToDirtyRows(d, plantView, selectedPeriod)),
        [drafts, plantView, selectedPeriod],
    );

    const dirtyCount = modified.size + staged.size + deleted.size + draftInsertRows.length;
    const hasChanges = dirtyCount > 0;

    const handleSave = React.useCallback(async () => {
        const dirtyRows: ProductionEventDirtyRow[] = [];

        // UPDATEs — reconstruct the full row + new weight from the loaded event.
        const rowById = new Map<string, ProductionEventRow>();
        for (const r of rows) { const id = (r.id ?? '').trim(); if (id) rowById.set(id, r); }
        for (const [eventId, weight] of modified.entries()) {
            if (deleted.has(eventId)) continue;
            const src = rowById.get(eventId);
            if (!src) continue;
            dirtyRows.push({
                id: eventId,
                recv_date: src.recv_date ?? '',
                prod_date: src.prod_date ?? '',
                batch: src.batch ?? '',
                shift_code: src.shift_code ?? '',
                grade_code: src.grade_code ?? '',
                plant_code: src.plant_code ?? '',
                warehouse_code: src.warehouse_code ?? '',
                source_location_code: src.source_location_code ?? '',
                weight_kg: weight,
                disposition_kind: src.disposition_kind ?? '',
                partner_equipment_code: src.partner_equipment_code ?? '',
                flec_count: src.flec_count != null ? String(src.flec_count) : '',
                whse_side: src.whse_side ?? '',
            });
        }

        // Phase-1 staged INSERTs (real-row blank cells via the popover).
        for (const ins of staged.values()) dirtyRows.push(ins.row);
        // Phase-2 draft INSERTs (filler/new-day pulls).
        for (const r of draftInsertRows) dirtyRows.push(r);

        const deletedIds = Array.from(deleted);
        if (dirtyRows.length === 0 && deletedIds.length === 0) return;

        setIsSaving(true);
        try {
            const res = await saveProductionEvents(dirtyRows, deletedIds);
            if (!res.ok) { errorToast(res.error ?? 'Failed to save production changes.'); return; }
            const n = (res.upserted ?? 0) + (res.deleted ?? 0);
            toast.success(`Saved ${n} change${n !== 1 ? 's' : ''}`);
            resetAll();
            onSaveSuccess();
        } catch (err) {
            errorToast('Unexpected error: ' + (err instanceof Error ? err.message : String(err)));
        } finally {
            setIsSaving(false);
        }
    }, [rows, modified, staged, deleted, draftInsertRows, resetAll, onSaveSuccess]);

    const minWidth = IDENTITY_WIDTH + ACTIVE_EQUIP.length * W_EQUIP + W_BAG + W_SUB + W_TOTAL;
    const crusherCols = CRUSHER_CODES;
    const kilnCols = KILN_CODES;

    // Dates to render = pivot dates ∪ added empty days, sorted chronologically.
    const groupByDate = React.useMemo(() => new Map(groups.map((g) => [g.date, g])), [groups]);
    const renderDates = React.useMemo(() => {
        const set = new Set<string>([...groups.map((g) => g.date), ...addedDays]);
        return Array.from(set).sort((a, b) => a.localeCompare(b));
    }, [groups, addedDays]);

    const existingDates = React.useMemo(() => new Set(groups.map((g) => g.date)), [groups]);

    const toolbar = (
        <DailyBlockToolbar
            plantView={plantView}
            hasChanges={hasChanges}
            dirtyCount={dirtyCount}
            isSaving={isSaving}
            onSave={handleSave}
            onDiscard={resetAll}
            onAddDay={addDay}
            existingDates={existingDates}
            addedDays={addedDays}
            period={selectedPeriod}
        />
    );

    if (renderDates.length === 0) {
        return (
            <div className="flex min-h-0 flex-1 flex-col">
                {toolbar}
                <div className="flex flex-1 flex-col items-center justify-center gap-2 py-16 text-center">
                    <Inbox className="h-8 w-8 text-muted-foreground/30" />
                    <p className="text-sm text-muted-foreground">No {plantView} production output for this period.</p>
                    <p className="text-[11px] text-muted-foreground/70">Use “Add day” above to start a new production day.</p>
                </div>
            </div>
        );
    }

    return (
        <div className="flex min-h-0 flex-1 flex-col">
            {toolbar}

            <div
                ref={gridScrollRef}
                onKeyDown={handleGridKeyDown}
                // A direct mouse click on a cell ends any Tab run (clears the Enter-anchor),
                // matching the ledger/bulk-add nav rules.
                onMouseDownCapture={(e) => { if ((e.target as HTMLElement)?.dataset?.navid) clearAnchor(); }}
                className="relative min-h-0 flex-1 overflow-auto animate-fade-in"
            >
                <table
                    className="relative table-fixed border border-border text-[11px]"
                    style={{ width: 'max-content', minWidth: `${minWidth}px`, borderCollapse: 'separate', borderSpacing: 0 }}
                >
                    <colgroup>
                        <col style={{ width: `${W_DATE}px` }} />
                        <col style={{ width: `${W_SHIFT}px` }} />
                        <col style={{ width: `${W_GRADE}px` }} />
                        <col style={{ width: `${W_SOURCE}px` }} />
                        <col style={{ width: `${W_RECV}px` }} />
                        {ACTIVE_EQUIP.map((c) => <col key={c} style={{ width: `${W_EQUIP}px` }} />)}
                        <col style={{ width: `${W_BAG}px` }} />
                        <col style={{ width: `${W_SUB}px` }} />
                        <col style={{ width: `${W_TOTAL}px` }} />
                    </colgroup>

                    <thead className="frozen-row bg-muted">
                        <tr>
                            <th rowSpan={2} className={cn('frozen-corner bg-muted px-1.5 text-left align-middle text-[10px] font-semibold uppercase tracking-wide text-muted-foreground', GRID)} style={{ left: LEFT_DATE }}>Date</th>
                            <th rowSpan={2} className={cn('frozen-corner bg-muted px-1 text-center align-middle text-[10px] font-semibold uppercase tracking-wide text-muted-foreground', GRID)} style={{ left: LEFT_SHIFT }}>Sh</th>
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
                    </thead>

                    {renderDates.map((date) => (
                        <DateSection
                            key={date}
                            date={date}
                            group={groupByDate.get(date) ?? null}
                            editCtx={editCtx}
                            onRequestDelete={setConfirmDelete}
                        />
                    ))}
                </table>
            </div>

            {/* Excel-style typeahead suggestion lists for the filler identity inputs. */}
            <datalist id={DL_SHIFT}>{SHIFT_CODES.map((s) => <option key={s} value={s} />)}</datalist>
            <datalist id={DL_GRADE}>{GRADE_CODES.map((g) => <option key={g} value={g} />)}</datalist>
            <datalist id={sourceDatalistId(plantView)}>{SOURCE_SETS[plantView].map((s) => <option key={s} value={s} />)}</datalist>

            {/* DELETE confirm — never nuke on a stray keystroke. */}
            <AlertDialog open={confirmDelete !== null} onOpenChange={(o) => { if (!o) setConfirmDelete(null); }}>
                <AlertDialogContent>
                    <AlertDialogHeader>
                        <AlertDialogTitle>Delete this production entry?</AlertDialogTitle>
                        <AlertDialogDescription>
                            {confirmDelete?.label} will be removed on save. This deletes the underlying event from the ledger.
                        </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                        <AlertDialogCancel>Cancel</AlertDialogCancel>
                        <AlertDialogAction
                            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                            onClick={() => { if (confirmDelete) onDeleteEvent(confirmDelete.eventId); setConfirmDelete(null); }}
                        >
                            Delete
                        </AlertDialogAction>
                    </AlertDialogFooter>
                </AlertDialogContent>
            </AlertDialog>
        </div>
    );
}

// ─── One DATE section ────────────────────────────────────────────────────────────────
// Renders a day = real merged rows (if any) + draft "new pull" rows (flat) + filler input
// slots. The Date cell rowSpans ALL of them (real + draft + slots); the footer is separate.
// `group` is null for an added-but-empty day.
function DateSection({
    date,
    group,
    editCtx,
    onRequestDelete,
}: {
    date: string;
    group: DateGroup | null;
    editCtx: EditContext;
    onRequestDelete: (c: { eventId: string; label: string }) => void;
}) {
    const shiftSpan = (s: ShiftBlock) => s.grades.reduce((acc, g) => acc + g.leafCount, 0);
    const dayBodySpan = group ? group.shifts.reduce((acc, s) => acc + shiftSpan(s), 0) : 0;

    // This day's drafts (filler/new pulls). A draft with content renders as a flat row; we
    // also keep a stable pool of slot keys so identity survives re-render.
    const dayDrafts = React.useMemo(
        () => Array.from(editCtx.drafts.values()).filter((d) => d.dayDate === date),
        [editCtx.drafts, date],
    );
    // Drafts that have ANY content (identity or a weight) → render as draft rows.
    const filledDrafts = dayDrafts.filter((d) =>
        draftIdentityComplete(d) || draftHasWeights(d) || d.shift || d.grade || d.source || d.recvDate,
    );

    // Per-day extra input rows added via the hover-reveal add-row drawer (see below). The
    // MIN_DAY_ROWS rectangle of empty slots is kept as-is; adding rows BEYOND it is now the
    // EXPLICIT drawer action (the previous "auto-grow on filling the last slot" is removed).
    const [extraRows, setExtraRows] = React.useState(0);

    // Empty input slots = pad the MIN_DAY_ROWS rectangle (counting real + filled drafts) +
    // any drawer-added extra rows. No automatic ≥1 trailing slot — the drawer is the way to add.
    const usedRows = dayBodySpan + filledDrafts.length;
    const padSlots = Math.max(0, MIN_DAY_ROWS - usedRows);
    const slotCount = padSlots + extraRows;

    const dateRowSpan = dayBodySpan + filledDrafts.length + slotCount; // real + draft + slots (footer separate)

    let dayRowEmitted = false;

    // Compute the per-equip daily totals: real + draft contributions.
    const daily = React.useMemo(() => {
        const equip = EQUIPMENT_CODES.reduce((acc, c) => { acc[c] = group?.daily.equip[c] ?? 0; return acc; }, {} as Record<EquipmentCode, number>);
        let bagging = group?.daily.bagging ?? 0;
        for (const d of dayDrafts) {
            for (const c of EQUIPMENT_CODES) { const w = parseWeight(d.weights[c] ?? ''); if (w && w > 0) equip[c] += w; }
            const bw = parseWeight(d.weights[BAGGING] ?? ''); if (bw && bw > 0) bagging += bw;
        }
        const subTotal = EQUIPMENT_CODES.reduce((s, c) => s + equip[c], 0);
        return { equip, bagging, subTotal, total: subTotal + bagging };
    }, [group, dayDrafts]);

    return (
        <tbody className="group/day">
            {/* ── REAL merged rows ── */}
            {group?.shifts.map((shiftBlock) => {
                let shiftRowEmitted = false;
                return shiftBlock.grades.map((gradeBlock) => {
                    let gradeRowEmitted = false;
                    return (
                        <React.Fragment key={`${shiftBlock.shift}-${gradeBlock.grade}`}>
                            {gradeBlock.sources.map((srcBlock) => {
                                let srcRowEmitted = false;
                                return srcBlock.recvRows.map((leaf) => {
                                    const isGradeFirst = !gradeRowEmitted;
                                    const isShiftFirst = !shiftRowEmitted;
                                    const isDayFirst = !dayRowEmitted;
                                    const isSrcFirst = !srcRowEmitted;
                                    const boxTop = isDayFirst ? cn('border-t-2', BOX) : '';
                                    const leafKey = `${leaf.prodDate}|${leaf.shift}|${leaf.grade}|${leaf.source}|${leaf.recvDate}`;

                                    const dateCell = isDayFirst ? (
                                        <td rowSpan={dateRowSpan} className={cn('frozen-col bg-background px-1.5 align-top font-bold', GRID, 'border-t-2 border-l-2', BOX)} style={{ left: LEFT_DATE }}>
                                            <span className="whitespace-nowrap text-[11px] font-bold leading-tight tracking-tight text-foreground" title={date}>{formatDayLabel(date)}</span>
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

                                    if (isDayFirst) dayRowEmitted = true;
                                    if (isShiftFirst) shiftRowEmitted = true;
                                    if (isGradeFirst) gradeRowEmitted = true;
                                    if (isSrcFirst) srcRowEmitted = true;

                                    return (
                                        <tr key={leafKey} className={cn(ROW_H, 'transition-colors duration-150 hover:bg-muted/30')}>
                                            {dateCell}
                                            {shiftCell}
                                            {gradeCell}
                                            {sourceCell}
                                            <td className={cn('frozen-col frozen-edge bg-background align-middle', CELL_PAD, GRID, boxTop)} style={{ left: LEFT_RECV }}>
                                                <span className="font-mono text-[11px] font-bold leading-none text-foreground/80">{formatRecvLabel(leaf.recvDate)}</span>
                                            </td>
                                            {ACTIVE_EQUIP.map((c, i) => (
                                                <EditableCell key={c} leaf={leaf} leafKey={leafKey} col={c} editCtx={editCtx} onRequestDelete={onRequestDelete} extraClass={cn(boxTop, (i === 0 || i === CRUSHER_COUNT) && GROUP)} />
                                            ))}
                                            <EditableCell leaf={leaf} leafKey={leafKey} col={BAGGING} editCtx={editCtx} onRequestDelete={onRequestDelete} extraClass={cn(boxTop, GROUP)} valueClass="text-emerald-700 dark:text-emerald-400" />
                                            <td className={cn(CELL_PAD, 'text-right align-middle font-mono text-[11px] leading-none tabular-nums text-muted-foreground', GRID, boxTop, GROUP)}>{fmt(leaf.subTotal)}</td>
                                            <td className={cn(CELL_PAD, 'text-right align-middle font-mono text-[11px] font-semibold leading-none tabular-nums', GRID, boxTop, 'border-r-2', BOX)}>{fmt(leaf.total)}</td>
                                        </tr>
                                    );
                                });
                            })}
                        </React.Fragment>
                    );
                });
            })}

            {/* ── DRAFT "new pull" rows (flat) + trailing empty input slots ──
                Filled drafts use their stored `draft.key`; empty slots are positional
                (`${date}#empty-N`). The FillerRow generates its OWN stable draft id
                (React.useId) for an empty slot and stages the draft under that id, so a
                filled slot never collides with an empty one (different React keys). */}
            {Array.from({ length: filledDrafts.length + slotCount }).map((_, idx) => {
                const draft = idx < filledDrafts.length ? filledDrafts[idx] : null;
                const rowKey = draft ? draft.key : `${date}#empty-${idx - filledDrafts.length}`;
                const isDayFirst = !dayRowEmitted;
                const boxTop = isDayFirst ? cn('border-t-2', BOX) : '';
                const dateCell = isDayFirst ? (
                    <td rowSpan={dateRowSpan} className={cn('frozen-col bg-background px-1.5 align-top font-bold', GRID, 'border-t-2 border-l-2', BOX)} style={{ left: LEFT_DATE }}>
                        <span className="whitespace-nowrap text-[11px] font-bold leading-tight tracking-tight text-foreground" title={date}>{formatDayLabel(date)}</span>
                    </td>
                ) : null;
                if (isDayFirst) dayRowEmitted = true;
                return (
                    <FillerRow
                        key={rowKey}
                        draft={draft}
                        dayDate={date}
                        dateCell={dateCell}
                        boxTop={boxTop}
                        editCtx={editCtx}
                    />
                );
            })}

            {/* DAY FOOTER — totals (real + draft). Same ROW_H as every other row. The
                HOVER-REVEAL ADD-ROW DRAWER lives at the TOP edge of the footer's label cell
                (i.e. just below the empty-input region): hidden until the day is hovered
                (group-hover/day, opacity only — no layout shift), clicking it appends one
                empty input row to THIS day. */}
            <tr className={cn(ROW_H, 'bg-muted')}>
                <td colSpan={5} className={cn('frozen-col frozen-edge relative bg-muted px-2 align-middle', CELL_PAD, GRID, 'border-t-2 border-b-2 border-l-2', BOX)} style={{ left: LEFT_DATE }}>
                    <span className="text-[10px] font-bold uppercase leading-none tracking-wide text-foreground/80">Daily total</span>
                    <button
                        type="button"
                        onClick={() => setExtraRows((n) => n + 1)}
                        title="Add an input row to this day"
                        className="absolute left-1/2 top-0 z-20 -translate-x-1/2 -translate-y-1/2 inline-flex items-center gap-1 rounded-full border border-border bg-background px-2 py-0.5 text-[10px] font-medium text-muted-foreground opacity-0 shadow-sm transition-opacity duration-150 hover:text-foreground group-hover/day:opacity-100"
                    >
                        <Plus className="h-3 w-3" />Add row
                    </button>
                </td>
                {ACTIVE_EQUIP.map((c, i) => (
                    <td key={c} className={cn(CELL_PAD, 'text-right align-middle font-mono text-[11px] leading-none tabular-nums', GRID, 'border-t-2 border-b-2', BOX, (i === 0 || i === CRUSHER_COUNT) && GROUP, 'bg-muted font-bold')}>{fmt(daily.equip[c])}</td>
                ))}
                <td className={cn(CELL_PAD, 'text-right align-middle font-mono text-[11px] leading-none tabular-nums', GRID, 'border-t-2 border-b-2', BOX, GROUP, 'bg-muted font-bold text-emerald-700 dark:text-emerald-400')}>{fmt(daily.bagging)}</td>
                <td className={cn(CELL_PAD, 'text-right align-middle font-mono text-[11px] leading-none tabular-nums', GRID, 'border-t-2 border-b-2', BOX, GROUP, 'bg-muted font-bold')}>{fmt(daily.subTotal)}</td>
                <td className={cn(CELL_PAD, 'text-right align-middle font-mono text-[11px] leading-none tabular-nums', GRID, 'border-t-2 border-b-2 border-r-2', BOX, 'bg-muted font-bold')}>{fmt(daily.total)}</td>
            </tr>
        </tbody>
    );
}

// ─── EditInput — the canonical inline cell editor (no row-height expansion) ──────────
// A bare <input> that matches the static cell metrics EXACTLY (EDIT_INPUT). Optional
// `list` wires a native <datalist> for Excel-style typeahead. PLACEHOLDER behaves like a
// true Excel cell: it shows when empty + unfocused, VANISHES the instant the cell is
// focused (we blank the placeholder attr on focus), and reappears on blur-if-empty.
function EditInput({
    value,
    onChange,
    onCommit,
    onEscape,
    placeholder,
    list,
    align = 'left',
    inputMode,
    valueClass,
    autoFocus,
    navId: navIdProp,
    onActivate,
}: {
    value: string;
    onChange: (v: string) => void;
    onCommit: () => void;
    onEscape?: () => void;
    placeholder?: string;
    list?: string;
    align?: 'left' | 'right' | 'center';
    inputMode?: React.HTMLAttributes<HTMLInputElement>['inputMode'];
    valueClass?: string;
    autoFocus?: boolean;
    /** Stable `rowKey|colKey` id for keyboard nav (the grid reads these from the DOM). */
    navId?: string;
    /** Called on focus so click + keyboard share one active-cell model. */
    onActivate?: (navId: string | null) => void;
}) {
    const [focused, setFocused] = React.useState(false);
    // Escape must NOT also fire the blur-commit (it would re-commit the reverted value —
    // e.g. an existing weight cell would route to the delete-confirm). This ref suppresses
    // the next onBlur-commit after an Escape.
    const escapedRef = React.useRef(false);
    const textAlign = align === 'right' ? 'text-right' : align === 'center' ? 'text-center' : 'text-left';
    return (
        <input
            autoFocus={autoFocus}
            value={value}
            list={list}
            inputMode={inputMode}
            data-navid={navIdProp}
            // Placeholder vanishes on focus (Excel-like), restores on empty blur.
            placeholder={focused ? '' : placeholder}
            onChange={(e) => onChange(e.target.value)}
            onFocus={() => { setFocused(true); onActivate?.(navIdProp ?? null); }}
            onBlur={() => { setFocused(false); if (escapedRef.current) { escapedRef.current = false; return; } onCommit(); }}
            // Tab / Enter / arrows are owned by the grid-level keydown (it commits via this
            // input's blur, then focuses the next cell). EditInput keeps ONLY Escape (cancel
            // + stay put). Esc suppresses the blur-commit via escapedRef.
            onKeyDown={(e) => {
                if (e.key === 'Escape') { e.preventDefault(); escapedRef.current = true; onEscape?.(); (e.target as HTMLInputElement).blur(); }
            }}
            className={cn(EDIT_INPUT, 'font-mono tabular-nums placeholder:text-muted-foreground/40', textAlign, valueClass)}
        />
    );
}

// ─── FILLER / NEW-PULL row (flat, fully editable) ────────────────────────────────────
// Identity cells are Excel-style INPUT + DATALIST typeahead (not a Select): type to filter
// native suggestions OR pick one; on commit the value is normalized + validated against the
// allowed set (case-insensitive), staging only when the identity is complete. Recv date is
// typed (normalized) and starts EMPTY (no prod_date prefill). Weight cells stage one INSERT
// per column. Bagging opens a small warehouse/side/flec popover; crushers/kilns stage direct.
function FillerRow({
    dayDate,
    draft,
    dateCell,
    boxTop,
    editCtx,
}: {
    dayDate: string;
    draft: FillerDraft | null;
    dateCell: React.ReactNode;
    boxTop: string;
    editCtx: EditContext;
}) {
    // Stable draft key: an existing draft keeps its key; an empty slot generates its OWN
    // (useId) so the draft it stages never collides with the next empty slot's key.
    const generatedId = React.useId();
    const slotKey = draft?.key ?? generatedId;

    // Local identity state seeded from the draft (or blank). Recv starts EMPTY (no prefill).
    const [shift, setShift] = React.useState(draft?.shift ?? '');
    const [grade, setGrade] = React.useState(draft?.grade ?? '');
    const [source, setSource] = React.useState(draft?.source ?? '');
    const [recv, setRecv] = React.useState(draft?.recvDate ?? '');
    const sourceOptions = SOURCE_SETS[editCtx.plantView];
    const recvYear = editCtx.period?.batch_year ?? (parseISO(dayDate).getFullYear() || new Date().getFullYear());

    const pushIdentity = React.useCallback((patch: Partial<FillerDraft>) => {
        editCtx.upsertDraft(slotKey, patch, dayDate);
    }, [editCtx, slotKey, dayDate]);

    const identityComplete = !!(shift && grade && source && recv);

    const cellBase = cn('frozen-col bg-background p-0 align-middle', GRID, boxTop);
    // Active-cell highlight per identity column (matches the ledger; inset ring, no shift).
    const isAct = (c: NavColKey) => editCtx.activeNavId === navId(slotKey, c);

    return (
        <tr className={cn(ROW_H, 'bg-blue-500/[0.03] transition-colors duration-150 hover:bg-muted/30')}>
            {dateCell}
            {/* Shift — input + datalist typeahead, normalized on commit */}
            <td className={cn(cellBase, isAct('shift') && ACTIVE_RING)} style={{ left: LEFT_SHIFT }}>
                <EditInput
                    value={shift}
                    onChange={setShift}
                    onCommit={() => { const n = normalizeIdentity(shift, SHIFT_CODES as readonly string[]); if (n !== shift) setShift(n); pushIdentity({ shift: n }); }}
                    onEscape={() => { setShift(draft?.shift ?? ''); }}
                    placeholder="Sh"
                    list={DL_SHIFT}
                    align="center"
                    navId={navId(slotKey, 'shift')}
                    onActivate={editCtx.onActivate}
                />
            </td>
            {/* Grade */}
            <td className={cn(cellBase, isAct('grade') && ACTIVE_RING)} style={{ left: LEFT_GRADE }}>
                <EditInput
                    value={grade}
                    onChange={setGrade}
                    onCommit={() => { const n = normalizeIdentity(grade, GRADE_CODES as readonly string[]); if (n !== grade) setGrade(n); pushIdentity({ grade: n }); }}
                    onEscape={() => { setGrade(draft?.grade ?? ''); }}
                    placeholder="Grade"
                    list={DL_GRADE}
                    navId={navId(slotKey, 'grade')}
                    onActivate={editCtx.onActivate}
                />
            </td>
            {/* Source */}
            <td className={cn(cellBase, isAct('source') && ACTIVE_RING)} style={{ left: LEFT_SOURCE }}>
                <EditInput
                    value={source}
                    onChange={setSource}
                    onCommit={() => { const n = normalizeIdentity(source, sourceOptions); if (n !== source) setSource(n); pushIdentity({ source: n }); }}
                    onEscape={() => { setSource(draft?.source ?? ''); }}
                    placeholder="Source"
                    list={sourceDatalistId(editCtx.plantView)}
                    navId={navId(slotKey, 'source')}
                    onActivate={editCtx.onActivate}
                />
            </td>
            {/* Recv date — typed; normalized on commit; starts EMPTY (placeholder only) */}
            <td className={cn('frozen-col frozen-edge bg-background p-0 align-middle', GRID, boxTop, isAct('recv') && ACTIVE_RING)} style={{ left: LEFT_RECV }}>
                <EditInput
                    value={recv}
                    onChange={setRecv}
                    onCommit={() => { const n = normalizeTypedDate(recv, recvYear); if (n !== recv) setRecv(n); pushIdentity({ recvDate: n }); }}
                    onEscape={() => { setRecv(draft?.recvDate ?? ''); }}
                    placeholder="recv"
                    navId={navId(slotKey, 'recv')}
                    onActivate={editCtx.onActivate}
                />
            </td>
            {/* Equipment + bagging weight inputs */}
            {ACTIVE_EQUIP.map((c, i) => (
                <FillerWeightCell key={c} slotKey={slotKey} dayDate={dayDate} col={c} draft={draft} identityComplete={identityComplete} editCtx={editCtx} extraClass={cn(boxTop, (i === 0 || i === CRUSHER_COUNT) && GROUP)} />
            ))}
            <FillerWeightCell slotKey={slotKey} dayDate={dayDate} col={BAGGING} draft={draft} identityComplete={identityComplete} editCtx={editCtx} extraClass={cn(boxTop, GROUP)} valueClass="text-emerald-700 dark:text-emerald-400" source={source} />
            {/* Sub / Total (live draft) */}
            <td className={cn(CELL_PAD, 'text-right align-middle font-mono text-[11px] tabular-nums text-muted-foreground', GRID, boxTop, GROUP)}>
                {fmt(EQUIPMENT_CODES.reduce((s, c) => s + (parseWeight(draft?.weights[c] ?? '') ?? 0), 0))}
            </td>
            <td className={cn(CELL_PAD, 'text-right align-middle font-mono text-[11px] font-semibold tabular-nums', GRID, boxTop, 'border-r-2', BOX)}>
                {fmt(EDIT_COLUMNS.reduce((s, c) => s + (parseWeight(draft?.weights[c] ?? '') ?? 0), 0))}
            </td>
        </tr>
    );
}

// A weight input inside a filler row. Commits push the weight to the draft (guarded by
// identity-complete). Bagging opens the warehouse/side/flec popover before staging.
function FillerWeightCell({
    slotKey,
    dayDate,
    col,
    draft,
    identityComplete,
    editCtx,
    extraClass,
    valueClass,
    source,
}: {
    slotKey: string;
    dayDate: string;
    col: EditColumn;
    draft: FillerDraft | null;
    identityComplete: boolean;
    editCtx: EditContext;
    extraClass?: string;
    valueClass?: string;
    source?: string;
}) {
    const current = draft?.weights[col] ?? '';
    const [val, setVal] = React.useState(current);
    const [showBagPopover, setShowBagPopover] = React.useState(false);
    const isBag = col === BAGGING;

    // Keep local in sync if the draft is reset externally (discard/save).
    React.useEffect(() => { setVal(draft?.weights[col] ?? ''); }, [draft, col]);

    const baseClass = cn('relative p-0 align-middle text-right font-mono text-[11px] tabular-nums', GRID, extraClass);

    const commit = () => {
        const parsed = parseWeight(val);
        if (parsed == null || parsed <= 0) {
            // cleared → drop this column's weight from the draft
            editCtx.upsertDraft(slotKey, { weights: { [col]: '' } }, dayDate);
            return;
        }
        if (!identityComplete) { editCtx.notifyIncomplete(); return; } // keep value but don't stage
        if (isBag) { setShowBagPopover(true); return; } // collect warehouse/side/flec first
        editCtx.upsertDraft(slotKey, { weights: { [col]: String(parsed) } }, dayDate);
    };

    const thisNavId = navId(slotKey, col);
    const isActive = editCtx.activeNavId === thisNavId;

    return (
        <td className={cn(baseClass, identityComplete ? 'cursor-text' : 'cursor-text bg-muted/20', isActive && ACTIVE_RING)}>
            <EditInput
                value={val}
                onChange={setVal}
                onCommit={commit}
                onEscape={() => setVal(draft?.weights[col] ?? '')}
                align="right"
                inputMode="decimal"
                valueClass={valueClass}
                navId={thisNavId}
                onActivate={editCtx.onActivate}
            />
            {isBag && showBagPopover && (
                <BaggingMetaPopover
                    weight={val}
                    source={source ?? ''}
                    onConfirm={(meta) => {
                        editCtx.upsertDraft(slotKey, { weights: { [col]: String(parseWeight(val) ?? '') }, bagging: meta }, dayDate);
                        setShowBagPopover(false);
                    }}
                    onCancel={() => { setVal(draft?.weights[col] ?? ''); setShowBagPopover(false); }}
                />
            )}
        </td>
    );
}


// ─── Bagging-meta popover for a FILLER bagging cell (source already chosen on the row) ──
function BaggingMetaPopover({
    weight,
    source,
    onConfirm,
    onCancel,
}: {
    weight: string;
    source: string;
    onConfirm: (meta: BaggingMeta) => void;
    onCancel: () => void;
}) {
    const [warehouse, setWarehouse] = React.useState('__none');
    const [side, setSide] = React.useState('__none');
    const [flec, setFlec] = React.useState('');
    return (
        <Popover open onOpenChange={(o) => { if (!o) onCancel(); }}>
            <PopoverTrigger asChild><span className="pointer-events-none absolute inset-0" aria-hidden /></PopoverTrigger>
            <PopoverContent align="end" className="w-56 bg-popover/95 p-3 backdrop-blur-lg" onOpenAutoFocus={(e) => e.preventDefault()}>
                <div className="space-y-2.5">
                    <div className="text-[11px] font-semibold text-foreground">
                        Bagging · <span className="font-mono">{fmt(parseWeight(weight) ?? 0)} kg</span>
                        {source && <span className="ml-1 text-[10px] font-normal text-muted-foreground">from {source}</span>}
                    </div>
                    <div className="space-y-1">
                        <Label className="text-[10px] uppercase tracking-wide text-muted-foreground">Warehouse</Label>
                        <Select value={warehouse} onValueChange={setWarehouse}>
                            <SelectTrigger size="sm" className="h-7 text-[11px]"><SelectValue /></SelectTrigger>
                            <SelectContent>
                                <SelectItem value="__none" className="text-[11px]">— Unplaced</SelectItem>
                                {WAREHOUSE_CODES.map((w) => <SelectItem key={w} value={w} className="text-[11px]">{w}</SelectItem>)}
                            </SelectContent>
                        </Select>
                    </div>
                    <div className="space-y-1">
                        <Label className="text-[10px] uppercase tracking-wide text-muted-foreground">Side</Label>
                        <Select value={side} onValueChange={setSide}>
                            <SelectTrigger size="sm" className="h-7 text-[11px]"><SelectValue /></SelectTrigger>
                            <SelectContent>
                                <SelectItem value="__none" className="text-[11px]">— None</SelectItem>
                                {WHSE_SIDES.map((s) => <SelectItem key={s} value={s} className="text-[11px]">{s}</SelectItem>)}
                            </SelectContent>
                        </Select>
                    </div>
                    <div className="space-y-1">
                        <Label className="text-[10px] uppercase tracking-wide text-muted-foreground">Flec count</Label>
                        <Input value={flec} onChange={(e) => setFlec(e.target.value)} inputMode="numeric" placeholder="optional" className="h-7 text-[11px]" />
                    </div>
                    <div className="flex justify-end gap-1.5 pt-1">
                        <Button variant="ghost" size="sm" className="h-6 px-2 text-[11px]" onClick={onCancel}>Cancel</Button>
                        <Button size="sm" className="h-6 px-2 text-[11px]" onClick={() => onConfirm({ warehouse: warehouse === '__none' ? '' : warehouse, side: side === '__none' ? '' : side, flec: flec.trim() })}>Add</Button>
                    </div>
                </div>
            </PopoverContent>
        </Popover>
    );
}

// ─── Editable equipment/bagging cell (Phase 1 — REAL pull rows) ──────────────────────
function EditableCell({
    leaf,
    leafKey,
    col,
    editCtx,
    onRequestDelete,
    extraClass,
    valueClass,
}: {
    leaf: RecvRow;
    leafKey: string;
    col: EditColumn;
    editCtx: EditContext;
    onRequestDelete: (c: { eventId: string; label: string }) => void;
    extraClass?: string;
    valueClass?: string;
}) {
    const slot = leaf.cells[col];
    const cellKey = `${leafKey}|${col}`;
    const locked = slot.eventIds.length > 1;
    const eventId = slot.eventIds.length === 1 ? slot.eventIds[0] : null;
    const isDeleted = eventId != null && editCtx.deleted.has(eventId);
    const stagedInsert = editCtx.staged.get(cellKey);
    const modifiedWeight = eventId != null ? editCtx.modified.get(eventId) : undefined;

    const [pendingInsert, setPendingInsert] = React.useState<string | null>(null);

    const baseClass = cn('relative p-0 align-middle text-right font-mono text-[11px] tabular-nums', GRID, extraClass);
    const displayClass = 'block w-full px-1.5 py-0.5 text-[11px] leading-none';

    // The effective raw value (modified > staged > base weight). The cell is ALWAYS an
    // input (so it's keyboard-focusable for nav). Local `val` seeded from the effective
    // value + re-synced when the underlying state changes externally (discard/save).
    const effective = stagedInsert
        ? stagedInsert.row.weight_kg
        : modifiedWeight !== undefined
            ? modifiedWeight
            : isDeleted
                ? ''
                : slot.weight ? String(slot.weight) : '';
    const [val, setVal] = React.useState(effective);
    // Re-sync the local input when the underlying state changes externally (discard/save).
    // Recompute the effective value INSIDE the effect from its source deps (so `effective`
    // isn't a dep that would re-run every render, and we don't touch a ref during render).
    React.useEffect(() => {
        const next = stagedInsert
            ? stagedInsert.row.weight_kg
            : modifiedWeight !== undefined
                ? modifiedWeight
                : isDeleted
                    ? ''
                    : slot.weight ? String(slot.weight) : '';
        setVal(next);
    }, [stagedInsert, modifiedWeight, isDeleted, slot.weight]);

    let stateTint = '';
    if (stagedInsert) stateTint = 'bg-blue-500/10 ring-1 ring-inset ring-blue-500/40';
    else if (isDeleted) stateTint = 'bg-destructive/10 ring-1 ring-inset ring-destructive/40';
    else if (modifiedWeight !== undefined) stateTint = 'bg-amber-500/10 ring-1 ring-inset ring-amber-500/40';

    // LOCKED cell — read-only (no input → not focusable → SKIPPED by keyboard nav).
    if (locked) {
        return (
            <td className={cn(baseClass, 'bg-muted/40 text-muted-foreground')} title="Multiple entries — edit in Ledger">
                <span className={cn(displayClass, 'flex items-center justify-end gap-1')}><Lock className="h-2.5 w-2.5 opacity-60" />{fmt(slot.weight)}</span>
            </td>
        );
    }

    const commit = () => {
        const parsed = parseWeight(val);
        if (stagedInsert) {
            if (parsed == null || parsed <= 0) { editCtx.onUnstageInsert(cellKey); return; }
            editCtx.onStageInsert(cellKey, { ...stagedInsert.row, weight_kg: String(parsed) });
            return;
        }
        if (eventId != null) {
            if (parsed == null || parsed <= 0) {
                onRequestDelete({ eventId, label: `${leaf.source} · ${formatRecvLabel(leaf.recvDate)} · ${col === BAGGING ? 'Bagging' : col}` });
                return;
            }
            if (parsed !== slot.weight) editCtx.onEditWeight(eventId, String(parsed));
            else editCtx.onClearEdit(eventId);
            return;
        }
        if (parsed != null && parsed > 0) setPendingInsert(String(parsed));
    };

    const thisNavId = navId(leafKey, col);
    const isActive = editCtx.activeNavId === thisNavId;

    return (
        <td className={cn(baseClass, stateTint, isActive && ACTIVE_RING)}>
            <EditInput
                value={val}
                onChange={setVal}
                onCommit={commit}
                onEscape={() => setVal(effective)}
                align="right"
                inputMode="decimal"
                valueClass={cn(isDeleted && 'text-destructive line-through', valueClass)}
                navId={thisNavId}
                onActivate={editCtx.onActivate}
            />
            {pendingInsert != null && (
                <InsertPopover
                    weight={pendingInsert}
                    col={col}
                    leaf={leaf}
                    period={editCtx.period}
                    plantView={editCtx.plantView}
                    onConfirm={(row) => { editCtx.onStageInsert(cellKey, row); setPendingInsert(null); }}
                    onCancel={() => setPendingInsert(null)}
                />
            )}
        </td>
    );
}

function columnKindLabel(col: EditColumn): string {
    if (col === BAGGING) return 'Bagging';
    return (CRUSHER_CODES as readonly string[]).includes(col) ? 'Crusher' : 'Kiln';
}

// ─── INSERT popover — COLUMN-AWARE (Phase 1 real-row blank cells) ───────────────────
function InsertPopover({
    weight,
    col,
    leaf,
    period,
    plantView,
    onConfirm,
    onCancel,
}: {
    weight: string;
    col: EditColumn;
    leaf: RecvRow;
    period: CenaproPeriod | null;
    plantView: PlantView;
    onConfirm: (row: ProductionEventDirtyRow) => void;
    onCancel: () => void;
}) {
    const isBagging = col === BAGGING;
    const sourceOptions = SOURCE_SETS[plantView];

    const [source, setSource] = React.useState<string>(leaf.source);
    const [warehouse, setWarehouse] = React.useState<string>('__none');
    const [side, setSide] = React.useState<string>('__none');
    const [flecCount, setFlecCount] = React.useState<string>('');

    const build = (): ProductionEventDirtyRow => {
        const { disposition_kind, partner_equipment_code } = columnDisposition(col);
        return {
            recv_date: leaf.recvDate,
            prod_date: leaf.prodDate,
            batch: period?.batch ?? '',
            shift_code: leaf.shift,
            grade_code: leaf.grade,
            plant_code: plantView,
            source_location_code: source,
            weight_kg: weight,
            disposition_kind,
            partner_equipment_code,
            warehouse_code: isBagging && warehouse !== '__none' ? warehouse : '',
            whse_side: isBagging && side !== '__none' ? side : '',
            flec_count: isBagging ? flecCount.trim() : '',
        };
    };

    const kindLabel = columnKindLabel(col);
    const targetLabel = isBagging ? 'Bagging' : `${col} · ${kindLabel}`;
    const chip = 'inline-flex items-center rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground';

    return (
        <Popover open onOpenChange={(o) => { if (!o) onCancel(); }}>
            <PopoverTrigger asChild><span className="pointer-events-none absolute inset-0" aria-hidden /></PopoverTrigger>
            <PopoverContent align="end" className="w-64 bg-popover/95 p-3 backdrop-blur-lg" onOpenAutoFocus={(e) => e.preventDefault()}>
                <div className="space-y-2.5">
                    <div className="text-[11px] font-semibold text-foreground">
                        New {targetLabel} entry · <span className="font-mono">{fmt(Number(weight) || 0)} kg</span>
                    </div>
                    <div className="flex flex-wrap gap-1">
                        <span className={cn(chip, 'bg-primary/10 text-primary')}>Plant {plantView}</span>
                        <span className={chip}>{formatRecvLabel(leaf.prodDate)} prod</span>
                        {leaf.shift && <span className={chip}>{SHIFT_LABEL[leaf.shift] ?? leaf.shift}</span>}
                        {leaf.grade && <span className={chip}>{leaf.grade}</span>}
                        <span className={chip}>{targetLabel}</span>
                    </div>
                    <div className="space-y-1">
                        <Label className="text-[10px] uppercase tracking-wide text-muted-foreground">Source</Label>
                        <Select value={source} onValueChange={setSource}>
                            <SelectTrigger size="sm" className="h-7 text-[11px]"><SelectValue /></SelectTrigger>
                            <SelectContent>
                                {sourceOptions.map((s) => <SelectItem key={s} value={s} className="text-[11px]">{s}</SelectItem>)}
                            </SelectContent>
                        </Select>
                    </div>
                    {isBagging && (
                        <>
                            <div className="space-y-1">
                                <Label className="text-[10px] uppercase tracking-wide text-muted-foreground">Warehouse</Label>
                                <Select value={warehouse} onValueChange={setWarehouse}>
                                    <SelectTrigger size="sm" className="h-7 text-[11px]"><SelectValue /></SelectTrigger>
                                    <SelectContent>
                                        <SelectItem value="__none" className="text-[11px]">— Unplaced</SelectItem>
                                        {WAREHOUSE_CODES.map((w) => <SelectItem key={w} value={w} className="text-[11px]">{w}</SelectItem>)}
                                    </SelectContent>
                                </Select>
                            </div>
                            <div className="space-y-1">
                                <Label className="text-[10px] uppercase tracking-wide text-muted-foreground">Side</Label>
                                <Select value={side} onValueChange={setSide}>
                                    <SelectTrigger size="sm" className="h-7 text-[11px]"><SelectValue /></SelectTrigger>
                                    <SelectContent>
                                        <SelectItem value="__none" className="text-[11px]">— None</SelectItem>
                                        {WHSE_SIDES.map((s) => <SelectItem key={s} value={s} className="text-[11px]">{s}</SelectItem>)}
                                    </SelectContent>
                                </Select>
                            </div>
                            <div className="space-y-1">
                                <Label className="text-[10px] uppercase tracking-wide text-muted-foreground">Flec count</Label>
                                <Input value={flecCount} onChange={(e) => setFlecCount(e.target.value)} inputMode="numeric" placeholder="optional" className="h-7 text-[11px]" />
                            </div>
                        </>
                    )}
                    <div className="flex justify-end gap-1.5 pt-1">
                        <Button variant="ghost" size="sm" className="h-6 px-2 text-[11px]" onClick={onCancel}>Cancel</Button>
                        <Button size="sm" className="h-6 px-2 text-[11px]" onClick={() => onConfirm(build())}>Add</Button>
                    </div>
                </div>
            </PopoverContent>
        </Popover>
    );
}

// ─── Toolbar (prod-only; Save/Discard bar + "Add day") ───────────────────────────────
function DailyBlockToolbar({
    plantView,
    hasChanges,
    dirtyCount,
    isSaving,
    onSave,
    onDiscard,
    onAddDay,
    existingDates,
    addedDays,
    period,
}: {
    plantView: PlantView;
    hasChanges: boolean;
    dirtyCount: number;
    isSaving: boolean;
    onSave: () => void;
    onDiscard: () => void;
    onAddDay: (date: string) => void;
    existingDates: Set<string>;
    addedDays: string[];
    period: CenaproPeriod | null;
}) {
    return (
        <div className="flex flex-none items-center gap-2 border-b bg-muted/20 px-2 py-1.5 md:px-3">
            <span className={cn(pillBase, 'bg-primary/10 text-primary ring-primary/25')}>{plantView}</span>
            <span className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">Production output</span>
            <span className="h-4 w-px bg-border/60" />
            <AddDayButton onAddDay={onAddDay} existingDates={existingDates} addedDays={addedDays} period={period} disabled={isSaving} />
            {hasChanges && (
                <span className="ml-2 font-mono text-[11px] text-amber-600 dark:text-amber-400">{dirtyCount} unsaved</span>
            )}
            <div className="ml-auto flex items-center gap-2">
                {hasChanges ? (
                    <>
                        <Button variant="ghost" size="sm" className="h-6 gap-1 px-2 text-[11px]" onClick={onDiscard} disabled={isSaving}>
                            <RotateCcw className="h-3 w-3" />Discard
                        </Button>
                        <Button size="sm" className="h-6 gap-1 px-2 text-[11px]" onClick={onSave} disabled={isSaving}>
                            <Save className="h-3 w-3" />{isSaving ? 'Saving…' : 'Save'}
                        </Button>
                    </>
                ) : (
                    <span className="text-[10px] text-muted-foreground/60">Click a cell to edit · fill a blank row to add a pull · excludes FLEC/DVO</span>
                )}
            </div>
        </div>
    );
}

// "Add day" — a popover with a typed date (normalized + validated against the period month
// + existing/added days). Spawns a new empty fillable day block.
function AddDayButton({
    onAddDay,
    existingDates,
    addedDays,
    period,
    disabled,
}: {
    onAddDay: (date: string) => void;
    existingDates: Set<string>;
    addedDays: string[];
    period: CenaproPeriod | null;
    disabled?: boolean;
}) {
    const [open, setOpen] = React.useState(false);
    const [date, setDate] = React.useState('');
    const [error, setError] = React.useState<string | null>(null);
    const year = period?.batch_year ?? new Date().getFullYear();

    const submit = () => {
        const norm = normalizeTypedDate(date.trim(), year);
        const d = parseISO(norm);
        if (!isValidDate(d) || !/^\d{4}-\d{2}-\d{2}$/.test(norm)) { setError('Enter a valid date (e.g. 5/4 or 2026-05-04).'); return; }
        if (existingDates.has(norm) || addedDays.includes(norm)) { setError('That day is already shown.'); return; }
        // Soft check: the period's month, if we can resolve it from the batch name.
        if (period?.batch) {
            const monthIdx = MONTHS.indexOf(period.batch.toUpperCase());
            if (monthIdx >= 0 && (d.getMonth() !== monthIdx || d.getFullYear() !== period.batch_year)) {
                setError(`Pick a date in ${period.batch} ${period.batch_year}.`);
                return;
            }
        }
        onAddDay(norm);
        setDate('');
        setError(null);
        setOpen(false);
    };

    return (
        <Popover open={open} onOpenChange={(o) => { setOpen(o); if (!o) { setError(null); setDate(''); } }}>
            <PopoverTrigger asChild>
                <Button variant="outline" size="sm" className="h-6 gap-1 px-2 text-[11px]" disabled={disabled}>
                    <CalendarPlus className="h-3 w-3" />Add day
                </Button>
            </PopoverTrigger>
            <PopoverContent align="start" className="w-56 bg-popover/95 p-3 backdrop-blur-lg">
                <div className="space-y-2">
                    <Label className="text-[10px] uppercase tracking-wide text-muted-foreground">New production day</Label>
                    <Input
                        autoFocus
                        value={date}
                        onChange={(e) => { setDate(e.target.value); setError(null); }}
                        onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); submit(); } }}
                        placeholder={period?.batch ? `${period.batch} ${period.batch_year}` : 'yyyy-MM-dd'}
                        className="h-7 font-mono text-[11px]"
                    />
                    {error && <p className="text-[10px] text-destructive">{error}</p>}
                    <div className="flex justify-end gap-1.5 pt-0.5">
                        <Button variant="ghost" size="sm" className="h-6 px-2 text-[11px]" onClick={() => setOpen(false)}>Cancel</Button>
                        <Button size="sm" className="h-6 gap-1 px-2 text-[11px]" onClick={submit}>
                            <Plus className="h-3 w-3" />Add
                        </Button>
                    </div>
                </div>
            </PopoverContent>
        </Popover>
    );
}

// Month-name → index (0-11) for the "Add day" period check (batch names are month names).
const MONTHS = ['JANUARY', 'FEBRUARY', 'MARCH', 'APRIL', 'MAY', 'JUNE', 'JULY', 'AUGUST', 'SEPTEMBER', 'OCTOBER', 'NOVEMBER', 'DECEMBER'];
