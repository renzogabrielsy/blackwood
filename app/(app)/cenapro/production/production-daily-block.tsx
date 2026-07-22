'use client';

import * as React from 'react';
import { flushSync } from 'react-dom';
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
import { EditInput, EDIT_INPUT } from '@/components/shared/grid';
import {
    useGridKeyboardNav,
    createDomOrderNavResolver,
    type DomNavCell,
} from '@/lib/hooks/use-grid-keyboard-nav';
import { useGridEditSession } from '@/lib/hooks/use-grid-edit-session';
import { saveProductionEvents, type ProductionEventDirtyRow, type CenaproPeriod } from './actions';
import { type PlantView, SOURCE_SETS } from './production-sources';

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

// `PlantView` + `SOURCE_SETS` now live in the pure `./production-sources` module (so the
// SERVER day-window action can import the source filter without crossing a client
// boundary). Re-exported here for back-compat with existing importers of this component.
export type { PlantView };

export const EQUIPMENT_CODES = [...CRUSHER_CODES, ...KILN_CODES] as const;
export type EquipmentCode = (typeof EQUIPMENT_CODES)[number];
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

// Adjacent-row adapter for the shared DOM-order resolver. Given the ordered nav cells
// (the shared `DomNavCell[]`, each `{ el, navid, lane }`), the current index, the target
// lane, and a direction, find the target cell in the NEXT (dir=+1) / PREVIOUS (dir=-1)
// editable row: prefer the same lane (colKey); if that row lacks it (e.g. a real row has no
// editable identity column), fall back to the closest column in that row — the cell with
// the nearest colKey index. Returns null when there's no such row. This reproduces the
// EXACT selection logic the in-file version had (same-lane preference + nearest fallback),
// adapted to the shared `(cells, idx, lane, dir) => DomNavCell | null` signature; the
// resolver derives the current row from the navid (rowKey) of the cell at `idx`.
function findColInAdjacentRow(
    cells: DomNavCell[],
    idx: number,
    lane: string | number,
    dir: 1 | -1,
): DomNavCell | null {
    const colKey = lane as NavColKey;
    const curRow = cells[idx] ? parseNavId(cells[idx].navid).rowKey : null;
    if (curRow == null) return null;
    const rowKeyOf = (c: DomNavCell) => parseNavId(c.navid).rowKey;
    // Walk to the first cell whose rowKey differs from the current row.
    let i = idx + dir;
    while (i >= 0 && i < cells.length && rowKeyOf(cells[i]) === curRow) i += dir;
    if (i < 0 || i >= cells.length) return null;
    const targetRow = rowKeyOf(cells[i]);
    // Gather all cells of that target row.
    const rowCells = cells.filter((c) => rowKeyOf(c) === targetRow);
    // Exact column match?
    const exact = rowCells.find((c) => (c.lane as NavColKey) === colKey);
    if (exact) return exact;
    // Else nearest column by NAV_COL_ORDER index.
    const want = navColIndex(colKey);
    let best = rowCells[0];
    let bestDist = Math.abs(navColIndex(best.lane as NavColKey) - want);
    for (const c of rowCells) {
        const d = Math.abs(navColIndex(c.lane as NavColKey) - want);
        if (d < bestDist) { best = c; bestDist = d; }
    }
    return best ?? null;
}

// An editable column = one equipment code or the Bagging (FLEC) bucket.
export const BAGGING = 'BAGGING' as const;
export type EditColumn = EquipmentCode | typeof BAGGING;

// Column → (disposition_kind, partner_equipment_code) — the write-back contract §3.
function columnDisposition(col: EditColumn): { disposition_kind: string; partner_equipment_code: string } {
    if (col === BAGGING) return { disposition_kind: 'flec_bagging', partner_equipment_code: '' };
    if ((CRUSHER_CODES as readonly string[]).includes(col)) return { disposition_kind: 'partner_crusher', partner_equipment_code: col };
    return { disposition_kind: 'partner_kiln', partner_equipment_code: col }; // RK1–RK4
}

// Minimum DATA rows per day (TUNABLE) — a sparse day is padded with blank filler input slots
// up to this count. PLUS there is ALWAYS at least one trailing empty slot beyond it.
// EXPORTED so the endless read-only pivots (production-endless-pivots.tsx) pad each day-block
// to the SAME floor — one shared constant so the focus + endless views can never drift.
export const MIN_DAY_ROWS = 6;

// The allowed source set + display ORDER per plant variant lives in `./production-sources`
// (imported above) — FLEC/DVO are absent from BOTH. Kept in a pure module so the server
// day-window action can share the exact same filter.

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
export interface CellSlot {
    weight: number;
    eventIds: string[];
}

export type CellMap = Record<EditColumn, CellSlot>;

function emptyCellMap(): CellMap {
    const m = {} as CellMap;
    for (const c of EQUIPMENT_CODES) m[c] = { weight: 0, eventIds: [] };
    m[BAGGING] = { weight: 0, eventIds: [] };
    return m;
}

export interface RecvRow {
    recvDate: string;
    prodDate: string;
    shift: string;
    grade: string;
    source: string;
    cells: CellMap;
    subTotal: number;
    total: number;
}

export interface SourceBlock {
    source: string;
    recvRows: RecvRow[];
}

export interface GradeBlock {
    grade: string;
    sources: SourceBlock[];
    leafCount: number;
}

export interface ShiftBlock {
    shift: string;
    grades: GradeBlock[];
}

export interface DailyTotals {
    equip: Record<EquipmentCode, number>;
    bagging: number;
    subTotal: number;
    total: number;
}

export interface DateGroup {
    date: string;
    shifts: ShiftBlock[];
    daily: DailyTotals;
}

// Thousands-separated; blank when 0/empty.
export function fmt(n: number): string {
    if (!n) return '';
    return Math.round(n).toLocaleString('en-US');
}

function parseWeight(raw: string): number | null {
    const t = raw.replace(/[,\s]/g, '').trim();
    if (t === '') return null;
    const n = Number(t);
    return Number.isFinite(n) ? n : null;
}

export function formatDayLabel(date: string): string {
    const d = parseISO(date);
    if (!isValidDate(d)) return date;
    return formatDate(d, 'EEE · MMM d');
}

export function formatRecvLabel(date: string): string {
    const d = parseISO(date);
    if (!isValidDate(d)) return date;
    return formatDate(d, 'MMM d');
}

// Pivot flat rows → prod_date → shift → grade → source → recv_date, recording per-column
// event ids (for edit/delete targeting + collision lock). Pure.
export function buildDateGroups(
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
// Exported so the ENDLESS read-only pivot renderer (production-endless-pivots.tsx) shares
// the EXACT same widths / frozen offsets — its day-blocks must line up under one shared
// 2-tier header. Any width change here propagates to both variants automatically.
export const W_DATE = 108;
export const W_SHIFT = 48;
export const W_GRADE = 100;
export const W_SOURCE = 140;
export const W_RECV = 80;
export const LEFT_DATE = 0;
export const LEFT_SHIFT = W_DATE;
export const LEFT_GRADE = W_DATE + W_SHIFT;
export const LEFT_SOURCE = W_DATE + W_SHIFT + W_GRADE;
export const LEFT_RECV = W_DATE + W_SHIFT + W_GRADE + W_SOURCE;
export const W_EQUIP = 56;
export const W_BAG = 66;
export const W_SUB = 70;
export const W_TOTAL = 84;
export const IDENTITY_WIDTH = W_DATE + W_SHIFT + W_GRADE + W_SOURCE + W_RECV;

export const ACTIVE_EQUIP: readonly EquipmentCode[] = EQUIPMENT_CODES;
export const CRUSHER_COUNT = CRUSHER_CODES.length;

// ─── Color systems ──────────────────────────────────────────────────────────────────
export const SHIFT_LETTER: Record<string, string> = {
    M: 'text-amber-600 dark:text-amber-400',
    E: 'text-violet-600 dark:text-violet-400',
    N: 'text-indigo-600 dark:text-indigo-400',
};
export const SHIFT_LABEL: Record<string, string> = { M: 'Morning', E: 'Evening', N: 'Night' };

export const GRADE_CHIP: Record<string, string> = {
    '3X50': 'bg-sky-500/15 text-sky-700 ring-sky-500/30 dark:text-sky-300',
    '2X6': 'bg-teal-500/15 text-teal-700 ring-teal-500/30 dark:text-teal-300',
    '3.5': 'bg-amber-500/15 text-amber-700 ring-amber-500/30 dark:text-amber-300',
    '4X8': 'bg-rose-500/15 text-rose-700 ring-rose-500/30 dark:text-rose-300',
};

export const pillBase = 'inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-bold leading-none ring-1 ring-inset';

// ─── Border tokens (spreadsheet feel) ───────────────────────────────────────────────
export const GRID = 'border-b border-r border-border';
export const GROUP = 'border-l-2 border-l-border';
export const BOX = 'border-border';

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
export const ROW_H = 'h-7'; // 28px — the single canonical row height
export const CELL_PAD = 'px-1.5 py-0.5';

// `EDIT_INPUT` (the canonical inline-edit input class — static cell + EditInput share it so
// switching to edit changes ONLY the caret, never the row height) is now the single source
// of truth in the shared Blackwood Table package, imported above. The StaticCell reuses it
// so the static render matches the EditInput metrics exactly.

// ─── Filler-identity TYPEAHEAD (custom dropdown, NOT native <datalist>) ──────────────
// Native <datalist> is unreliable for live typeahead — most notably it shows NOTHING for a
// single-char exact match (typing "M" into Shift = already a complete option), and its
// drop behaviour is inconsistent across browsers. So identity editors (SH / GRADE / SOURCE)
// use a small custom suggestion dropdown (`IdentitySuggestInput`, below): as you type it
// prefix-filters the valid set case-insensitively, renders a compact glass popover anchored
// under the cell, ArrowUp/Down move the highlight, Enter/Tab/click accept, Esc dismisses.
// The valid set per identity column (drives BOTH the typeahead options + recognized styling):
function identityOptions(col: NavColKey, plantView: PlantView): readonly string[] {
    if (col === 'shift') return SHIFT_CODES;
    if (col === 'grade') return GRADE_CODES;
    if (col === 'source') return SOURCE_SETS[plantView];
    return [];
}

// Is a committed value a recognized member of its valid set? (drives the "tagged" styling)
function isRecognizedIdentity(col: NavColKey, value: string, plantView: PlantView): boolean {
    const v = value.trim();
    if (!v) return false;
    return identityOptions(col, plantView).some((o) => o === v);
}

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
    /** The currently keyboard-active (SELECTED) cell's navId — drives the active ring. */
    activeNavId: string | null;
    /** The cell currently in EDIT mode (its EditInput is mounted). Null ⇒ all static. */
    editingNavId: string | null;
    /** Set the active (selected) cell. Click-to-select + keyboard nav share this model. */
    onActivate: (navId: string | null) => void;
    /** Begin inline editing a cell (double-click / F2 / type-over). `char` seeds type-over. */
    startEdit: (navId: string, char?: string) => void;
    /** Register a cell's value accessors + commit so the grid can snapshot/seed/revert AND
        commit EXPLICITLY (the blur-commit is unreliable — the editing input unmounts before
        React dispatches its onBlur when the grid moves focus or switches the active cell). */
    registerCell: (navId: string, get: () => string, set: (v: string) => void, commit: () => void) => void;
    /** Unregister a cell's value accessors (on unmount). */
    unregisterCell: (navId: string) => void;
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

    // ─── Keyboard navigation + edit session (shared Blackwood Table primitives) ──────
    // The Daily Block uses the SAME canonical model as every other grid: click = SELECT
    // (ring, no edit); type / double-click / F2 = EDIT; Esc = revert; Enter/Tab = commit +
    // move; arrows/Tab/Enter navigate. Nav is DOM-order (the merged-rowSpan pivot has no
    // clean coordinate model), edits are keyed by the opaque `rowKey|colKey` navid string.
    const gridScrollRef = React.useRef<HTMLDivElement>(null);
    // The SELECTED cell (active ring) and the cell in EDIT mode (its EditInput is mounted).
    const [activeNavId, setActiveNavId] = React.useState<string | null>(null);
    const [editingNavId, setEditingNavId] = React.useState<string | null>(null);
    // Ref mirror of editingNavId — read it from callbacks WITHOUT a side effect inside a
    // state updater (StrictMode double-invokes updaters, which would double-commit).
    const editingNavIdRef = React.useRef<string | null>(null);
    React.useEffect(() => { editingNavIdRef.current = editingNavId; }, [editingNavId]);

    // ── Cell value-accessor registry ────────────────────────────────────────────────
    // Each editable cell owns its OWN local value + commit logic (so the entire save path
    // — onEditWeight / onStageInsert / draft upserts / InsertPopover / BaggingMetaPopover —
    // is untouched). Each cell registers thin get/set/commit accessors here, keyed by navid:
    //   • get/set — the shared edit session reads/writes the CURRENT value to snapshot it
    //     (Esc-revert) and to seed a type-over char.
    //   • commit — the cell's REAL commit logic. The grid invokes it EXPLICITLY (NOT via the
    //     input's onBlur): when the grid moves focus (Tab/Enter) or switches the active cell
    //     (click-away), the editing input UNMOUNTS in the same React batch, and React drops
    //     the queued onBlur of an unmounting element — so the blur-commit silently never runs
    //     (the Save bar never appeared, no edit was staged). Committing through the registry
    //     guarantees the cell commits regardless of blur timing.
    // Held in a ref (no re-render on register).
    const cellAccessors = React.useRef<Map<string, { get: () => string; set: (v: string) => void; commit: () => void }>>(new Map());
    const registerCell = React.useCallback((id: string, get: () => string, set: (v: string) => void, commit: () => void) => {
        cellAccessors.current.set(id, { get, set, commit });
    }, []);
    const unregisterCell = React.useCallback((id: string) => {
        cellAccessors.current.delete(id);
    }, []);
    // Explicitly run a cell's registered commit (used INSTEAD of the unreliable blur-commit).
    const commitCell = React.useCallback((id: string) => {
        cellAccessors.current.get(id)?.commit();
    }, []);

    // Activate (SELECT) a cell. If a DIFFERENT cell is currently in edit mode, COMMIT it
    // explicitly then exit its edit (clicking cell B while editing cell A must commit A —
    // we can't rely on A's input onBlur, which is dropped when A unmounts). Activating the
    // editing cell itself (e.g. its own input's onFocus) leaves edit mode intact.
    const onActivate = React.useCallback((id: string | null) => {
        const cur = editingNavIdRef.current;
        if (cur !== null && cur !== id) {
            commitCell(cur);
            editingNavIdRef.current = null;
            setEditingNavId(null);
        }
        setActiveNavId(id);
    }, [commitCell]);

    // The shared edit session owns isEditing + the pre-edit snapshot + start/revert/commit,
    // generic over the navid string. getValue/setValue route through the cell registry.
    const editSession = useGridEditSession<string>({
        getValue: (id) => cellAccessors.current.get(id)?.get() ?? '',
        setValue: (id, v) => cellAccessors.current.get(id)?.set(v),
    });

    // Enter edit mode for a cell (mounts its EditInput). Mirror the session flag into our
    // editingNavId so every cell can switch its render between static and edit.
    const startEdit = React.useCallback((id: string, char?: string) => {
        editSession.startEditing(id, char);
        editingNavIdRef.current = id;
        setEditingNavId(id);
    }, [editSession]);

    // Focus a cell's element by navid — the STATIC `[data-navid]` div (or the EditInput when
    // it's the editing cell). Keyboard nav reads the DOM, so after a move we must move focus
    // to the resolved element (the flat grids keep focus on the container; this grid does
    // not). Keeps the moved-to cell on screen without a jarring jump.
    const focusNavId = React.useCallback((id: string) => {
        const root = gridScrollRef.current;
        if (!root) return;
        const el = root.querySelector<HTMLElement>(`[data-navid="${CSS.escape(id)}"]`);
        if (!el) return;
        el.focus();
        (el as HTMLInputElement).select?.();
        el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }, []);

    // DOM-order resolver: reads `[data-navid]` elements (STATIC click-to-select cells AND
    // the mounted EditInput) in document order; Tab/left/right walk the flat list, up/down
    // + Enter-anchor use the findColInAdjacentRow adapter (same-lane preference + nearest
    // fallback). Locked cells carry NO data-navid → never appear in the list → skipped.
    const resolver = React.useMemo(
        () => createDomOrderNavResolver({
            containerRef: gridScrollRef,
            navColOrder: NAV_COL_ORDER,
            parseId: (id) => { const p = parseNavId(id); return { rowKey: p.rowKey, colKey: p.colKey }; },
            findColInAdjacentRow,
        }),
        [],
    );

    // After the active cell moves, select it (static, NOT auto-editing) and focus its
    // element so subsequent typing starts an edit on the right cell.
    //
    // The cell's real commit fires EXPLICITLY via the registry in `edit.commit` BEFORE this
    // runs (the blur-commit is unreliable — see the registry comment). So here we just clear
    // edit mode + move focus; the order no longer matters for committing.
    const onAfterMove = React.useCallback((id: string) => {
        editingNavIdRef.current = null;
        setEditingNavId(null);
        focusNavId(id);
        setActiveNavId(id);
    }, [focusNavId]);

    const { handleKeyDown: handleGridKeyDown } = useGridKeyboardNav<string>({
        activeCell: activeNavId,
        setActiveCell: setActiveNavId,
        isEditing: editingNavId !== null,
        resolver,
        edit: {
            start: (id, char) => startEdit(id, char),
            // Esc → revert to the snapshot, exit edit, keep the cell SELECTED + focused
            // (the EditInput's escapedRef suppresses its blur-commit so the snapshot sticks).
            revert: () => {
                editSession.revertChanges();
                editingNavIdRef.current = null;
                setEditingNavId(null);
                if (activeNavId) focusNavId(activeNavId);
            },
            // Enter/Tab commit: run the editing cell's REAL commit logic EXPLICITLY through
            // the registry (the input's onBlur is dropped when the editor unmounts on the
            // move — see the registry comment). At a boundary (no move via onAfterMove) the
            // cell still commits here, then stays selected.
            commit: () => {
                const cur = editingNavIdRef.current;
                if (cur) commitCell(cur);
                editSession.commit();
            },
        },
        onAfterMove,
        // The Daily Block keeps the Tab-then-Enter "return to the run's lane" behavior
        // (laneOf = colKey). The shared hook now provides it.
        enableEnterAnchor: true,
    });

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
            activeNavId, editingNavId, onActivate, startEdit, registerCell, unregisterCell,
        }),
        [selectedPeriod, plantView, modified, staged, deleted, drafts, onEditWeight, onClearEdit, onDeleteEvent, onStageInsert, onUnstageInsert, upsertDraft, notifyIncomplete, activeNavId, editingNavId, onActivate, startEdit, registerCell, unregisterCell],
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

            {/* ── Desktop / landscape: the full editable frozen matrix (Archetype E).
                `hidden sm:block` — byte-for-byte unchanged, it never renders on a phone
                (the 5 frozen identity columns alone are 476px, wider than the screen).
                Editing stays desktop-only; the phone gets a read summary below. ── */}
            <div
                ref={gridScrollRef}
                onKeyDown={handleGridKeyDown}
                className="relative hidden min-h-0 flex-1 overflow-auto animate-fade-in sm:block"
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

            {/* ── Phone (< sm): Archetype E read summary — a per-day "Daily total" strip +
                a stacked per-row list, both built from the SAME `groups` pivot the matrix
                uses (buildDateGroups). Every number (daily.total/subTotal/bagging, each
                leaf's total) is reused verbatim — nothing is recomputed. Editing stays
                desktop-only. ── */}
            <CenaproDailyBlockSummaryMobile groups={groups} plantView={plantView} />

            {/* Filler identity typeahead is now a CUSTOM dropdown (IdentitySuggestInput) —
                native <datalist> dropped (unreliable, esp. single-char Shift). */}

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

// ─── Phone-summary (Archetype E) ─────────────────────────────────────────────────────
// Additive `sm:hidden` companion to the frozen matrix. Read-only (editing is desktop-only).
//   • A per-day "Daily total" strip (horizontally scrollable chips) — the load-bearing
//     footer number (group.daily.total) surfaced for a quick glance across days.
//   • A stacked per-row list: one card per day (Daily total + Sub/Bag sub-metrics), then
//     the pivot leaves (shift · grade · source · recv · row total).
// EVERY number is reused verbatim from the `groups` pivot (buildDateGroups) — the same
// values the desktop footer/cells render. Nothing is recomputed here.
function CenaproDailyBlockSummaryMobile({
    groups,
    plantView,
}: {
    groups: DateGroup[];
    plantView: PlantView;
}) {
    if (groups.length === 0) return null;

    return (
        <div className="flex flex-col gap-4 py-2 sm:hidden">
            {/* Per-day Daily-total strip — reuses group.daily.total (the footer figure). */}
            <section className="flex flex-col gap-1.5">
                <h3 className="px-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                    Daily total · {plantView} ({groups.length} days)
                </h3>
                <div className="-mx-0.5 flex gap-1.5 overflow-x-auto px-0.5 pb-1">
                    {groups.map((g) => (
                        <div
                            key={g.date}
                            className="flex shrink-0 flex-col rounded-md border border-border bg-card px-2.5 py-1.5"
                        >
                            <span className="whitespace-nowrap text-[10px] text-muted-foreground">
                                {formatDayLabel(g.date)}
                            </span>
                            <span className="font-mono text-sm font-bold tabular-nums">
                                {fmt(g.daily.total) || '0'}
                            </span>
                        </div>
                    ))}
                </div>
            </section>

            {/* Stacked per-row list — one card per day, then its pivot leaves. */}
            <section className="flex flex-col gap-3">
                {groups.map((g) => {
                    // Flatten the shift→grade→source→recv hierarchy into leaf lines. Every
                    // field + total is read straight off the pivot (no recompute).
                    const leaves = g.shifts.flatMap((sh) =>
                        sh.grades.flatMap((gr) =>
                            gr.sources.flatMap((src) =>
                                src.recvRows.map((rv) => ({
                                    key: `${g.date}|${sh.shift}|${gr.grade}|${src.source}|${rv.recvDate}`,
                                    shift: sh.shift,
                                    grade: gr.grade,
                                    source: src.source,
                                    recvDate: rv.recvDate,
                                    total: rv.total,
                                })),
                            ),
                        ),
                    );
                    return (
                        <div key={g.date} className="rounded-md border border-border bg-card">
                            <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-1.5">
                                <span className="text-xs font-semibold">{formatDayLabel(g.date)}</span>
                                <div className="flex items-baseline gap-3 tabular-nums">
                                    <span className="text-[10px] text-muted-foreground">
                                        Sub{' '}
                                        <span className="font-mono text-foreground">{fmt(g.daily.subTotal) || '0'}</span>
                                    </span>
                                    <span className="text-[10px] text-emerald-700 dark:text-emerald-400">
                                        Bag{' '}
                                        <span className="font-mono">{fmt(g.daily.bagging) || '0'}</span>
                                    </span>
                                    <span className="font-mono text-sm font-bold">{fmt(g.daily.total) || '0'}</span>
                                </div>
                            </div>
                            <ul className="divide-y divide-border">
                                {leaves.map((lf) => (
                                    <li key={lf.key} className="flex items-center gap-2 px-3 py-1.5">
                                        <span
                                            className={cn(
                                                'w-5 shrink-0 text-center font-mono text-[11px] font-bold',
                                                SHIFT_LETTER[lf.shift] ?? 'text-muted-foreground',
                                            )}
                                            title={SHIFT_LABEL[lf.shift] ?? lf.shift}
                                        >
                                            {lf.shift || '—'}
                                        </span>
                                        <span
                                            className={cn(
                                                pillBase,
                                                'shrink-0',
                                                GRADE_CHIP[lf.grade] ?? 'bg-muted text-muted-foreground ring-border',
                                            )}
                                        >
                                            {lf.grade || '—'}
                                        </span>
                                        <div className="min-w-0 flex-1 leading-tight">
                                            <div className="truncate text-[11px]">{lf.source || '—'}</div>
                                            <div className="truncate font-mono text-[10px] text-muted-foreground">
                                                {formatRecvLabel(lf.recvDate)}
                                            </div>
                                        </div>
                                        <span className="shrink-0 font-mono text-xs font-semibold tabular-nums">
                                            {fmt(lf.total) || '—'}
                                        </span>
                                    </li>
                                ))}
                            </ul>
                        </div>
                    );
                })}
            </section>
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

    // ─── STABLE FILLER-SLOT IDENTITY (Issue 1 fix) ───────────────────────────────────
    // EVERY filler slot — empty OR filled — has ONE persistent id that LIVES IN THE PARENT
    // and survives the empty→filled promotion. This is the core of the duplicate-row fix:
    // previously each FillerRow self-generated its draft id via React.useId() and filled
    // drafts were rendered FIRST (reordered ahead of empty slots), so when an empty slot
    // committed, React moved the typed instance to a new position while ALSO mounting a
    // fresh instance at the prepended draft index — two live rows shared one navid.
    //
    // Now: a DETERMINISTIC, POSITIONAL slot id per day (`${date}#slot-{i}`). When a slot's
    // draft is committed, the draft is keyed by that SAME slot id (the FillerRow's slotKey
    // IS the slot id, passed DOWN — no more child useId). We render slots in slot-id ORDER
    // (NOT filled-first), so a slot that goes empty→filled keeps its id AND its render
    // position → React preserves the single instance. No reorder, no double mount, no navid
    // collision, no state bleed into a neighbouring slot. Positional ids are stable across
    // renders (slot positions never shift — the pool only GROWS via the drawer) and don't
    // need a ref, so there's no ref-access-during-render.
    const slotId = React.useCallback((i: number) => `${date}#slot-${i}`, [date]);

    // Drafts that have ANY content (identity or a weight) → render as draft rows.
    const filledDrafts = dayDrafts.filter((d) =>
        draftIdentityComplete(d) || draftHasWeights(d) || d.shift || d.grade || d.source || d.recvDate,
    );

    // Per-day extra input rows added via the hover-reveal add-row drawer (see below). The
    // MIN_DAY_ROWS rectangle of empty slots is kept as-is; adding rows BEYOND it is now the
    // EXPLICIT drawer action (the previous "auto-grow on filling the last slot" is removed).
    const [extraRows, setExtraRows] = React.useState(0);

    // A draft keyed by a slot id that is IN the current pool occupies that slot in place;
    // any other draft (e.g. a freshly-promoted one not yet in the pool) is appended. Total
    // slot count = max(MIN_DAY_ROWS - dayBody, #filled drafts) + drawer extras, so there is
    // always at least one trailing EMPTY input slot once a slot fills.
    const draftByKey = React.useMemo(() => {
        const m = new Map<string, FillerDraft>();
        for (const d of filledDrafts) m.set(d.key, d);
        return m;
    }, [filledDrafts]);

    // The highest positional slot index actually occupied by a draft (a draft typed into slot
    // N keeps key `${date}#slot-N`, so its index may exceed filledDrafts.length when earlier
    // slots are empty). slotCount must cover it so the draft maps onto its own slot in place.
    const maxDraftSlotIdx = React.useMemo(() => {
        let max = -1;
        for (const d of filledDrafts) {
            const m = d.key.match(/#slot-(\d+)$/);
            if (m) max = Math.max(max, Number(m[1]));
        }
        return max;
    }, [filledDrafts]);

    const baseSlots = Math.max(0, MIN_DAY_ROWS - dayBodySpan);
    // Enough slots to: pad the MIN_DAY_ROWS rectangle, hold every occupied draft slot in place
    // (maxDraftSlotIdx + 1), keep ≥1 trailing empty slot beyond the last filled one, plus any
    // drawer-added extras.
    const slotCount = Math.max(baseSlots, maxDraftSlotIdx + 2, filledDrafts.length + 1) + extraRows;
    const slotIds = Array.from({ length: slotCount }, (_, i) => slotId(i));

    // Any filled draft whose key is NOT one of the current slot ids (shouldn't normally
    // happen now that ids are lifted, but guards against an externally-seeded draft) gets a
    // trailing row so its value is never dropped from the view.
    const orphanDrafts = filledDrafts.filter((d) => !slotIds.includes(d.key));
    const renderRows = slotIds.length + orphanDrafts.length;

    const dateRowSpan = dayBodySpan + renderRows; // real + filler/draft rows (footer separate)

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

            {/* ── FILLER / DRAFT "new pull" rows ──
                Each row is keyed by its PERSISTENT slot id (from the parent's pool). A slot
                may be EMPTY (no draft) or FILLED (a draft keyed by that same slot id). We
                render in SLOT-ID ORDER (NOT filled-first), so a slot that transitions
                empty→filled keeps its id AND its position → React preserves the one instance
                (the Issue-1 fix). The slotKey is passed DOWN to FillerRow (it no longer
                self-generates an id), so its navids are unique + stable. Any orphan draft
                (key not in the current pool) is rendered after the slots so its value is
                never dropped. */}
            {[
                ...slotIds.map((sid) => ({ slotKey: sid, draft: draftByKey.get(sid) ?? null })),
                ...orphanDrafts.map((d) => ({ slotKey: d.key, draft: d })),
            ].map(({ slotKey, draft }) => {
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
                        key={slotKey}
                        slotKey={slotKey}
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

// NOTE: The bare inline editor (`EditInput`) + its `EDIT_INPUT` class were promoted to the
// shared Blackwood Table package (`@/components/shared/grid`) in Phase 0 — imported above.
// The local copy has been deleted; the shared component is identical (escapedRef
// blur-suppression, focus placeholder behavior, type-over seeding, autoFocus, data-navid).

// ─── Static cell shell — the DEFAULT (non-edit) render of every editable Daily Block cell ─
// Canonical click-to-select model: a cell renders as a focusable STATIC element until the
// user starts editing (type / double-click / F2). The static element matches the EditInput
// metrics EXACTLY (EDIT_INPUT) so switching to edit changes ONLY the caret — never the row
// height (uniform h-7). It carries `data-navid` so the DOM-order resolver finds it (click
// AND keyboard nav land on the same element), is `tabIndex=0` (focusable), and wires the
// canonical gestures: mousedown = SELECT (no edit), double-click / F2 / printable char =
// EDIT. The active ring is applied by the PARENT <td> (so it can layer over frozen cols).
function StaticCell({
    navId: navIdProp,
    value,
    placeholder,
    align = 'left',
    valueClass,
    editCtx,
    renderValue,
}: {
    navId: string;
    value: string;
    placeholder?: string;
    align?: 'left' | 'right' | 'center';
    valueClass?: string;
    editCtx: EditContext;
    /** Optional custom render of the committed value (e.g. the recognized/tagged identity
        styling — colored shift letter, grade chip, mono source, or an unrecognized look).
        When provided it replaces the plain text render; the placeholder path is unchanged. */
    renderValue?: (value: string) => React.ReactNode;
}) {
    const textAlign = align === 'right' ? 'text-right' : align === 'center' ? 'text-center' : 'text-left';
    const showPlaceholder = value === '';
    return (
        <div
            data-navid={navIdProp}
            tabIndex={0}
            role="gridcell"
            // mousedown = SELECT only (no edit). Focusing the static div makes click +
            // keyboard nav share one active-cell model (mirrors EditInput.onFocus → onActivate).
            onMouseDown={() => editCtx.onActivate(navIdProp)}
            onFocus={() => editCtx.onActivate(navIdProp)}
            // Double-click = EDIT (preserve value). F2 / printable char / Delete / nav keys
            // are ALL owned by the grid-level keydown (the shared useGridKeyboardNav reads
            // activeNavId): they bubble up from this focused static div and are handled there,
            // so we don't duplicate them here (avoids double-firing edit.start).
            onDoubleClick={() => editCtx.startEdit(navIdProp)}
            className={cn(
                EDIT_INPUT,
                'flex items-center overflow-hidden whitespace-nowrap font-mono tabular-nums outline-none cursor-text',
                align === 'right' ? 'justify-end' : align === 'center' ? 'justify-center' : 'justify-start',
                textAlign,
                valueClass,
            )}
        >
            {showPlaceholder
                ? <span className="text-muted-foreground/40">{placeholder}</span>
                : renderValue
                    ? renderValue(value)
                    : value}
        </div>
    );
}

// ─── CellEditor — the static↔edit TOGGLE shared by every editable Daily Block cell ──────
// One cell renders TWO ways, switched by editCtx.editingNavId:
//   • STATIC (default): a focusable <StaticCell> (data-navid, click=select, dblclick=edit).
//   • EDIT: the shared <EditInput> (autofocus + type-over seeding), mounted ONLY for the
//     one cell whose navid === editingNavId.
// Each cell still owns its OWN value state + commit logic (so the entire save path is
// untouched) — CellEditor only handles the toggle + registers value accessors with the
// shared edit session (so Esc-revert can snapshot/restore + a typed char can seed). The
// PARENT <td> applies the active ring + dirty tint (so they layer correctly over frozen
// panes); CellEditor is purely the inner element.
function CellEditor({
    navId: navIdProp,
    value,
    onChange,
    onCommit,
    onEscape,
    editCtx,
    placeholder,
    list,
    align = 'left',
    inputMode,
    valueClass,
    renderEdit,
    renderValue,
}: {
    navId: string;
    value: string;
    onChange: (v: string) => void;
    onCommit: () => void;
    onEscape?: () => void;
    editCtx: EditContext;
    placeholder?: string;
    list?: string;
    align?: 'left' | 'right' | 'center';
    inputMode?: React.HTMLAttributes<HTMLInputElement>['inputMode'];
    valueClass?: string;
    /** Custom EDIT-mode element (e.g. the identity typeahead). When provided it REPLACES the
        default <EditInput> while editing; CellEditor still owns the static↔edit toggle +
        the value-accessor registration. The render gets the shared editing props so the
        commit/nav contract (onCommit via blur, navId, onActivate) is preserved. */
    renderEdit?: (props: {
        value: string;
        onChange: (v: string) => void;
        onCommit: () => void;
        onEscape?: () => void;
        navId: string;
        align?: 'left' | 'right' | 'center';
        placeholder?: string;
        onActivate: (id: string | null) => void;
    }) => React.ReactNode;
    /** Custom STATIC-mode render of the committed value (recognized/tagged identity styling). */
    renderValue?: (value: string) => React.ReactNode;
}) {
    const isEditing = editCtx.editingNavId === navIdProp;

    // Register thin value accessors so the shared edit session can snapshot (Esc-revert) +
    // seed a type-over char. Kept in a ref-backed registry on the grid; refreshed whenever
    // value/onChange identity changes so the session always reads/writes the live state.
    const { registerCell, unregisterCell } = editCtx;
    React.useEffect(() => {
        registerCell(navIdProp, () => value, (v) => onChange(v), onCommit);
        return () => unregisterCell(navIdProp);
    }, [navIdProp, value, onChange, onCommit, registerCell, unregisterCell]);

    if (isEditing) {
        if (renderEdit) {
            return <>{renderEdit({ value, onChange, onCommit, onEscape, navId: navIdProp, align, placeholder, onActivate: editCtx.onActivate })}</>;
        }
        return (
            <EditInput
                autoFocus
                value={value}
                onChange={onChange}
                onCommit={onCommit}
                onEscape={onEscape}
                placeholder={placeholder}
                list={list}
                align={align}
                inputMode={inputMode}
                valueClass={valueClass}
                navId={navIdProp}
                onActivate={editCtx.onActivate}
            />
        );
    }
    return (
        <StaticCell
            navId={navIdProp}
            value={value}
            placeholder={placeholder}
            align={align}
            valueClass={valueClass}
            editCtx={editCtx}
            renderValue={renderValue}
        />
    );
}

// ─── IdentitySuggestInput — custom live-typeahead editor for SH / GRADE / SOURCE ────────
// Replaces the native <datalist> (which is unreliable, esp. for a single-char Shift exact
// match). Renders the bare input (EDIT_INPUT metrics + data-navid, so keyboard nav still
// finds it) plus a compact glass dropdown anchored under the cell. While the dropdown is
// open it OWNS Arrow/Enter/Tab/Esc; otherwise keys bubble to the grid as usual.
//
//   • TYPE     → prefix-filter the valid set case-insensitively; dropdown opens with matches
//   • ↓ / ↑    → move the highlight (consumed — grid does NOT navigate cells)
//   • Enter/Tab WITH a highlighted item → ACCEPT it (flushSync the value so the cell's
//     blur-commit reads the accepted value), then let the key BUBBLE so the grid commits +
//     moves to the next cell (canonical flow). WITHOUT a highlight → just commit the typed
//     text (bubbles normally).
//   • Click an item → accept + commit (blur).
//   • Esc → if the dropdown is open, CLOSE it (consumed, value kept); if already closed,
//     bubble to the grid which reverts to the pre-edit snapshot.
//
// Matches EditInput's blur/placeholder/escapedRef contract so the commit path is identical.
function IdentitySuggestInput({
    value,
    onChange,
    onCommit,
    onEscape,
    options,
    placeholder,
    align = 'left',
    navId: navIdProp,
    onActivate,
}: {
    value: string;
    onChange: (v: string) => void;
    onCommit: () => void;
    onEscape?: () => void;
    options: readonly string[];
    placeholder?: string;
    align?: 'left' | 'right' | 'center';
    navId: string;
    onActivate: (id: string | null) => void;
}) {
    const [focused, setFocused] = React.useState(false);
    const [open, setOpen] = React.useState(true); // open immediately on mount (type-over / F2)
    const [highlight, setHighlight] = React.useState(0);
    const escapedRef = React.useRef(false);
    // True once the user moved the highlight with the arrow keys — an EXPLICIT pick that
    // Tab/Enter should accept even on an empty query (where there's no prefix match to auto-snap).
    const navigatedRef = React.useRef(false);
    const inputRef = React.useRef<HTMLInputElement>(null);

    // Prefix-filter the valid set case-insensitively (space-insensitive too, e.g. "tnk1").
    const q = value.trim().toUpperCase().replace(/\s+/g, '');
    const matches = React.useMemo(
        () => options.filter((o) => o.toUpperCase().replace(/\s+/g, '').startsWith(q)),
        [options, q],
    );
    // The dropdown shows the prefix matches; when the field is EMPTY (no query yet) it shows
    // the FULL set so the user can see/pick any valid value. When the query has NO prefix
    // match (e.g. "XY"), the dropdown shows nothing — so Tab/Enter commits the raw text as an
    // UNRECOGNIZED value (it is NOT silently snapped to a valid option). `list` drives the
    // rendered dropdown.
    const list = q === '' ? options : matches;
    // `hasMatch` is the auto-accept gate for Tab/Enter. It must be FALSE on an EMPTY query —
    // otherwise `options.filter(o => o.startsWith(''))` = ALL options would make every empty
    // field auto-snap to the first option on Tab/Enter, so the user could never CLEAR an
    // identity cell (the BUG-1 regression). An empty query commits EMPTY; a non-empty query
    // with a genuine prefix match auto-accepts; an explicit arrow pick (navigatedRef) still
    // accepts even on an empty query.
    const hasMatch = q !== '' && matches.length > 0;

    React.useEffect(() => { setHighlight(0); navigatedRef.current = false; }, [q]);

    const accept = React.useCallback((opt: string) => {
        // flushSync so the cell's blur-commit (fired when the grid moves focus on the SAME
        // keypress) reads the accepted value, not the stale pre-accept text.
        flushSync(() => { onChange(opt); });
        setOpen(false);
    }, [onChange]);

    const textAlign = align === 'right' ? 'text-right' : align === 'center' ? 'text-center' : 'text-left';

    return (
        <div className="relative h-full w-full">
            <input
                ref={inputRef}
                autoFocus
                value={value}
                data-navid={navIdProp}
                placeholder={focused ? '' : placeholder}
                onChange={(e) => { onChange(e.target.value); setOpen(true); }}
                onFocus={() => { setFocused(true); setOpen(true); onActivate(navIdProp); }}
                onBlur={() => { setFocused(false); setOpen(false); if (escapedRef.current) { escapedRef.current = false; return; } onCommit(); }}
                onKeyDown={(e) => {
                    if (e.key === 'ArrowDown') {
                        e.preventDefault(); e.stopPropagation();
                        setOpen(true); navigatedRef.current = true; setHighlight((h) => Math.min(h + 1, list.length - 1));
                        return;
                    }
                    if (e.key === 'ArrowUp') {
                        e.preventDefault(); e.stopPropagation();
                        setOpen(true); navigatedRef.current = true; setHighlight((h) => Math.max(h - 1, 0));
                        return;
                    }
                    if (e.key === 'Escape') {
                        // First Esc closes the dropdown (keep value); if already closed, bubble
                        // to the grid so it reverts to the snapshot.
                        if (open) {
                            e.preventDefault(); e.stopPropagation();
                            setOpen(false);
                            return;
                        }
                        escapedRef.current = true; onEscape?.(); (e.target as HTMLInputElement).blur();
                        return;
                    }
                    if ((e.key === 'Enter' || e.key === 'Tab') && open && list.length > 0 && (hasMatch || navigatedRef.current)) {
                        // Accept the highlighted option, THEN let the key bubble so the grid
                        // commits + moves (canonical Excel flow). accept() flushSync-es the value.
                        // GATE: only auto-accept when there's a genuine prefix MATCH, or the user
                        // explicitly arrowed to a pick. An UNMATCHED query (e.g. "XY") is left as
                        // raw text → commits UNRECOGNIZED (not silently snapped to a valid value).
                        accept(list[highlight] ?? list[0]);
                        // do NOT preventDefault/stopPropagation — the grid handles commit+move.
                    }
                    // All other keys (incl. Enter/Tab with no match) bubble to the grid keydown
                    // so the raw typed text commits (→ recognized if it normalizes, else amber).
                }}
                className={cn(EDIT_INPUT, 'font-mono tabular-nums placeholder:text-muted-foreground/40', textAlign)}
            />
            {open && list.length > 0 && (
                <div
                    role="listbox"
                    className="absolute left-0 top-full z-50 mt-0.5 max-h-44 min-w-[5rem] overflow-auto rounded-md border border-border bg-popover/95 p-0.5 shadow-md backdrop-blur-lg animate-fade-in"
                >
                    {list.map((opt, i) => (
                        <button
                            key={opt}
                            type="button"
                            role="option"
                            aria-selected={i === highlight}
                            // mousedown (not click) so it fires BEFORE the input's blur.
                            onMouseDown={(e) => { e.preventDefault(); accept(opt); onCommit(); inputRef.current?.blur(); }}
                            onMouseEnter={() => setHighlight(i)}
                            className={cn(
                                'block w-full cursor-pointer rounded px-2 py-1 text-left font-mono text-[11px] leading-none',
                                i === highlight ? 'bg-primary text-primary-foreground' : 'text-foreground hover:bg-muted',
                            )}
                        >
                            {opt}
                        </button>
                    ))}
                </div>
            )}
        </div>
    );
}

// Recognized/tagged STATIC render of a committed identity value (shared by every identity
// cell). A value that IS a valid member of its set gets the SAME canonical treatment the
// REAL rows use (colored shift letter / grade chip / mono-bold source); a non-empty value
// that is NOT recognized renders in a clear "unrecognized" amber style so the operator can
// tell it didn't tag. This is the "it's tagged" confirmation (Issue 2b).
const UNRECOGNIZED_CLASS = 'text-amber-600 dark:text-amber-400';
function renderRecognizedIdentity(col: NavColKey, value: string, plantView: PlantView): React.ReactNode {
    const v = value.trim();
    if (!v) return value;
    const recognized = isRecognizedIdentity(col, v, plantView);
    if (!recognized) {
        return <span className={cn('font-mono', UNRECOGNIZED_CLASS)} title="Not a recognized value">{v}</span>;
    }
    if (col === 'shift') {
        return <span className={cn('text-[12px] font-bold leading-none', SHIFT_LETTER[v] ?? 'text-foreground')} title={SHIFT_LABEL[v] ?? v}>{v}</span>;
    }
    if (col === 'grade') {
        return <span className={cn(pillBase, GRADE_CHIP[v] ?? 'bg-muted text-muted-foreground ring-border')}>{v}</span>;
    }
    if (col === 'source') {
        return <span className="font-mono text-[11px] font-bold text-foreground/90">{v}</span>;
    }
    return v;
}

// ─── FILLER / NEW-PULL row (flat, fully editable) ────────────────────────────────────
// Identity cells are Excel-style INPUT + DATALIST typeahead (not a Select): type to filter
// native suggestions OR pick one; on commit the value is normalized + validated against the
// allowed set (case-insensitive), staging only when the identity is complete. Recv date is
// typed (normalized) and starts EMPTY (no prod_date prefill). Weight cells stage one INSERT
// per column. Bagging opens a small warehouse/side/flec popover; crushers/kilns stage direct.
function FillerRow({
    slotKey,
    dayDate,
    draft,
    dateCell,
    boxTop,
    editCtx,
}: {
    /** The PERSISTENT slot id from the parent's per-day pool — survives empty→filled (the
        Issue-1 fix). A draft committed from this row is keyed by exactly this id, so the row
        never duplicates or collides; its navids (`slotKey|colKey`) are unique + stable. */
    slotKey: string;
    dayDate: string;
    draft: FillerDraft | null;
    dateCell: React.ReactNode;
    boxTop: string;
    editCtx: EditContext;
}) {
    // Local identity state seeded from the draft (or blank). Recv starts EMPTY (no prefill).
    const [shift, setShift] = React.useState(draft?.shift ?? '');
    const [grade, setGrade] = React.useState(draft?.grade ?? '');
    const [source, setSource] = React.useState(draft?.source ?? '');
    const [recv, setRecv] = React.useState(draft?.recvDate ?? '');
    // Because the row instance now PERSISTS across empty→filled (the Issue-1 fix), local
    // identity state must follow an EXTERNAL draft reset: Discard clears the draft Map without
    // remounting this row, so a slot that just held a typed draft would otherwise keep stale
    // text. When the draft drops to null, clear the local identity so the slot reads empty.
    const draftKeyRef = React.useRef(draft?.key ?? null);
    React.useEffect(() => {
        const k = draft?.key ?? null;
        if (k === null && draftKeyRef.current !== null) {
            setShift(''); setGrade(''); setSource(''); setRecv('');
        }
        draftKeyRef.current = k;
    }, [draft]);
    const sourceOptions = SOURCE_SETS[editCtx.plantView];
    const recvYear = editCtx.period?.batch_year ?? (parseISO(dayDate).getFullYear() || new Date().getFullYear());

    const pushIdentity = React.useCallback((patch: Partial<FillerDraft>) => {
        editCtx.upsertDraft(slotKey, patch, dayDate);
    }, [editCtx, slotKey, dayDate]);

    const identityComplete = !!(shift && grade && source && recv);

    // h-7 (explicit 28px) is REQUIRED on every CellEditor host <td>: the StaticCell div
    // uses `h-full` (height:100%), which only resolves against a definite parent height.
    // A <td>'s height is content-driven by default, so without this the static div
    // collapses (0px when empty, ~11px when filled) and the cell becomes unclickable.
    const cellBase = cn('frozen-col bg-background p-0 align-middle h-7', GRID, boxTop);
    // Active-cell highlight per identity column (matches the ledger; inset ring, no shift).
    const isAct = (c: NavColKey) => editCtx.activeNavId === navId(slotKey, c);

    return (
        <tr className={cn(ROW_H, 'bg-blue-500/[0.03] transition-colors duration-150 hover:bg-muted/30')}>
            {dateCell}
            {/* Shift — CUSTOM live typeahead (IdentitySuggestInput) while editing; recognized
                /tagged styling in the static cell (colored M/E/N letter, amber if unrecognized).
                Normalized on commit (snaps to the official DB value). */}
            <td className={cn(cellBase, isAct('shift') && ACTIVE_RING)} style={{ left: LEFT_SHIFT }}>
                <CellEditor
                    value={shift}
                    onChange={setShift}
                    onCommit={() => { const n = normalizeIdentity(shift, SHIFT_CODES as readonly string[]); if (n !== shift) setShift(n); pushIdentity({ shift: n }); }}
                    onEscape={() => { setShift(draft?.shift ?? ''); }}
                    placeholder="Sh"
                    align="center"
                    navId={navId(slotKey, 'shift')}
                    editCtx={editCtx}
                    renderEdit={(p) => <IdentitySuggestInput {...p} options={SHIFT_CODES} />}
                    renderValue={(v) => renderRecognizedIdentity('shift', v, editCtx.plantView)}
                />
            </td>
            {/* Grade */}
            <td className={cn(cellBase, isAct('grade') && ACTIVE_RING)} style={{ left: LEFT_GRADE }}>
                <CellEditor
                    value={grade}
                    onChange={setGrade}
                    onCommit={() => { const n = normalizeIdentity(grade, GRADE_CODES as readonly string[]); if (n !== grade) setGrade(n); pushIdentity({ grade: n }); }}
                    onEscape={() => { setGrade(draft?.grade ?? ''); }}
                    placeholder="Grade"
                    navId={navId(slotKey, 'grade')}
                    editCtx={editCtx}
                    renderEdit={(p) => <IdentitySuggestInput {...p} options={GRADE_CODES} />}
                    renderValue={(v) => renderRecognizedIdentity('grade', v, editCtx.plantView)}
                />
            </td>
            {/* Source */}
            <td className={cn(cellBase, isAct('source') && ACTIVE_RING)} style={{ left: LEFT_SOURCE }}>
                <CellEditor
                    value={source}
                    onChange={setSource}
                    onCommit={() => { const n = normalizeIdentity(source, sourceOptions); if (n !== source) setSource(n); pushIdentity({ source: n }); }}
                    onEscape={() => { setSource(draft?.source ?? ''); }}
                    placeholder="Source"
                    navId={navId(slotKey, 'source')}
                    editCtx={editCtx}
                    renderEdit={(p) => <IdentitySuggestInput {...p} options={sourceOptions} />}
                    renderValue={(v) => renderRecognizedIdentity('source', v, editCtx.plantView)}
                />
            </td>
            {/* Recv date — typed; normalized on commit; starts EMPTY (placeholder only) */}
            <td className={cn('frozen-col frozen-edge bg-background p-0 align-middle h-7', GRID, boxTop, isAct('recv') && ACTIVE_RING)} style={{ left: LEFT_RECV }}>
                <CellEditor
                    value={recv}
                    onChange={setRecv}
                    onCommit={() => { const n = normalizeTypedDate(recv, recvYear); if (n !== recv) setRecv(n); pushIdentity({ recvDate: n }); }}
                    onEscape={() => { setRecv(draft?.recvDate ?? ''); }}
                    placeholder="recv"
                    navId={navId(slotKey, 'recv')}
                    editCtx={editCtx}
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

    // h-7 (explicit 28px) is REQUIRED so the StaticCell div's `h-full` resolves (a <td>'s
    // height is content-driven by default). Without it the static cell collapses to ~0–11px
    // and a real click misses it (the cell becomes unselectable / uneditable).
    const baseClass = cn('relative h-7 p-0 align-middle text-right font-mono text-[11px] tabular-nums', GRID, extraClass);

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
            <CellEditor
                value={val}
                onChange={setVal}
                onCommit={commit}
                onEscape={() => setVal(draft?.weights[col] ?? '')}
                align="right"
                inputMode="decimal"
                valueClass={valueClass}
                navId={thisNavId}
                editCtx={editCtx}
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

    // h-7 (explicit 28px) is REQUIRED so the StaticCell div's `h-full` resolves (a <td>'s
    // height is content-driven by default). Without it the static cell collapses to ~0–11px
    // and a real click misses it (the cell becomes unselectable / uneditable).
    const baseClass = cn('relative h-7 p-0 align-middle text-right font-mono text-[11px] tabular-nums', GRID, extraClass);
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
            <CellEditor
                value={val}
                onChange={setVal}
                onCommit={commit}
                onEscape={() => setVal(effective)}
                align="right"
                inputMode="decimal"
                valueClass={cn(isDeleted && 'text-destructive line-through', valueClass)}
                navId={thisNavId}
                editCtx={editCtx}
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
