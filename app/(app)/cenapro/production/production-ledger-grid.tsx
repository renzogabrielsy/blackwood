'use client';

import * as React from 'react';
import { useSearchParams, useRouter, usePathname } from 'next/navigation';
import { toast } from 'sonner';
import {
    Save,
    RotateCcw,
    Calendar,
    Copy,
    Trash2,
    ArrowUpFromLine,
    ArrowDownFromLine,
    ArrowUp,
    ArrowDown,
    ChevronsUpDown,
    Inbox,
    Sparkles,
    Loader2,
} from 'lucide-react';
import { errorToast } from '@/lib/toast';
import { cn, focusNoScroll } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { GridCell } from '@/components/shared/grid/GridCell';
import { SelectCell } from '@/components/shared/grid/SelectCell';
import { DatePickerCell, formatDateShort } from '@/components/shared/grid/DatePickerCell';
import { GridContextMenu, type GridMenuItem } from '@/components/shared/grid';
import { useGridContextMenu } from '@/lib/hooks/use-grid-context-menu';
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
import { parseExcelDate, trimCellValue } from '@/lib/paste-utils';
import { BADGE_BASE, cccFlecBadgeClass, plantBadgeClass } from '../badges';
import type { ProductionEventRow } from '../types';
import {
    SHIFT_CODES,
    GRADE_CODES,
    PLANT_CODES,
    WAREHOUSE_CODES,
    SOURCE_LOCATION_CODES,
    WHSE_SIDES,
    CCC_FLEC_OPTIONS,
    parseCccFlec,
    formatCccFlec,
} from '../types';
import { saveProductionEvents, type ProductionEventDirtyRow, type CenaproPeriod } from './actions';
import { CenaproPeriodPicker } from './period-picker';
import { ProductionDailyBlock } from './production-daily-block';
import { CenaproLedgerCardsMobile } from './production-ledger-cards-mobile';
import {
    parseViewMode,
    plantViewOf,
    parseScope,
    FILTER_SPECS,
    collectFilterPresence,
    describeActiveFilters,
    matchesLedgerFilters,
    mergeDiscoveredGroups,
    mergeDiscoveredOptions,
    type FilterColumn,
    type Scope,
} from './ledger-url';
import { ViewModeSwitcher, ScopeToggle, useLedgerFilters } from './ledger-controls';
import { ColumnFilterMenu, FilterSummaryChip, FilteredEmptyState } from './column-filter-menu';

// The view axis (`?view=`) + its switcher now live in the shared `ledger-url.ts` (pure
// helpers) + `ledger-controls.tsx` (`ViewModeSwitcher`), so the server page and this
// grid share one source of truth. `parseViewMode` / `plantViewOf` / `ViewModeSwitcher`
// are imported above.

// ─── Editable fields ─────────────────────────────────────────────────────────────
// The writable columns (id/unique_tag/batch_year are read-only/computed). Order here
// is informational; COL_MAP below pins the on-screen left→right geometry.
//
// `ccc_flec` is a SINGLE on-screen column (Excel parity — Renzo's "CCC / FLEC") that
// stands in for the two normalized DB fields disposition_kind + partner_equipment_code.
// It's NOT a key of GridRow — it's a derived editing surface: display via
// formatCccFlec(), edit via parseCccFlec() writing BOTH underlying fields. Everywhere a
// cell value is read/written (copy, paste, save) it's special-cased.
type GridField =
    | 'recv_date'
    | 'prod_date'
    | 'batch'
    | 'shift_code'
    | 'grade_code'
    | 'plant_code'
    | 'warehouse_code'
    | 'source_location_code'
    | 'weight_kg'
    | 'ccc_flec'
    | 'flec_count'
    | 'whse_side';

// ─── Column layout ───────────────────────────────────────────────────────────────
// col 0 = row#, not selectable/editable. All other columns are editable. Dropdown
// columns edit via a Select popover (not GridCell's F2/type-over). Date columns use
// DatePickerCell. Numeric/text/CCC-FLEC columns use GridCell + <Input>. The order
// matches Renzo's Excel (… WHSE · SRC · WT · CCC/FLEC · FLEC AMT · WHSE SIDE) so a
// pasted Excel block lines up positionally.
const COL_MAP: (GridField | null)[] = [
    null,                       // 0: row#
    'recv_date',                // 1
    'prod_date',                // 2
    'batch',                    // 3
    'shift_code',               // 4  (dropdown)
    'grade_code',               // 5  (dropdown)
    'plant_code',               // 6  (dropdown, nullable)
    'warehouse_code',           // 7  (dropdown, nullable — null = unplaced)
    'source_location_code',     // 8  (dropdown)
    'weight_kg',                // 9  (numeric)
    'ccc_flec',                 // 10 (typeahead — merged disposition + equipment)
    'flec_count',               // 11 (numeric int)
    'whse_side',                // 12 (dropdown, nullable)
];
const COL_COUNT = COL_MAP.length;

const NUMERIC_FIELDS = new Set<GridField>(['weight_kg', 'flec_count']);
const DROPDOWN_FIELDS = new Set<GridField>([
    'shift_code',
    'grade_code',
    'plant_code',
    'warehouse_code',
    'source_location_code',
    'whse_side',
]);

// ─── Row state ───────────────────────────────────────────────────────────────────
type RowDirtyState = 'existing' | 'new' | 'modified' | 'deleted';

export interface GridRow {
    _state: RowDirtyState;
    // Stable DB id for existing rows (the upsert key); '' for unsaved new rows.
    id: string;
    recv_date: string;
    prod_date: string;
    batch: string;
    shift_code: string;
    grade_code: string;
    plant_code: string;
    warehouse_code: string;
    source_location_code: string;
    // The single CCC/FLEC cell, stored as RAW typed text ("FLEC" | "C1".."C4" |
    // "RK1".."RK4"). Seeded from the two DB fields via formatCccFlec() on load, edited
    // directly (so typing isn't fought by a derive), and parsed back into
    // disposition_kind + partner_equipment_code at SAVE time (mirrors the bulk modal).
    ccc_flec: string;
    weight_kg: string;
    flec_count: string;
    whse_side: string;
    // Read-only/computed — shown but never edited or sent on save.
    batch_year: string;
}

// ─── DB → Grid conversion ────────────────────────────────────────────────────────
// PostgREST types all VIEW columns nullable; coalesce to '' for the string grid. The
// `id` is non-null at runtime (the upsert key) but typed nullable, so coalesce too. The
// CCC/FLEC cell is seeded from the two normalized DB fields (disposition + equipment).
export function toGridRow(r: ProductionEventRow): GridRow {
    return {
        _state: 'existing',
        id: r.id ?? '',
        recv_date: r.recv_date ?? '',
        prod_date: r.prod_date ?? '',
        batch: r.batch ?? '',
        shift_code: r.shift_code ?? '',
        grade_code: r.grade_code ?? '',
        plant_code: r.plant_code ?? '',
        warehouse_code: r.warehouse_code ?? '',
        source_location_code: r.source_location_code ?? '',
        ccc_flec: formatCccFlec(r.disposition_kind, r.partner_equipment_code),
        weight_kg: r.weight_kg != null ? String(r.weight_kg) : '',
        flec_count: r.flec_count != null ? String(r.flec_count) : '',
        whse_side: r.whse_side ?? '',
        batch_year: r.batch_year != null ? String(r.batch_year) : '',
    };
}

// Which date column drives the sort. Both the Recv and Prod headers are clickable;
// clicking one selects it as the sort key (and toggles asc/desc on repeat clicks).
type DateSortKey = 'recv_date' | 'prod_date';

function buildGridRows(
    rows: ProductionEventRow[],
    sortKey: DateSortKey,
    sortDir: 'asc' | 'desc',
): GridRow[] {
    const mapped = rows.map(toGridRow);
    return sortGridRows(mapped, sortKey, sortDir);
}

// Stable sort by the chosen date column per the toggle, id as a deterministic
// tiebreaker. Empty dates (common for prod_date) sort to the bottom regardless of
// direction so blank rows don't jump to the top when sorting descending.
function sortGridRows(rows: GridRow[], sortKey: DateSortKey, sortDir: 'asc' | 'desc'): GridRow[] {
    return [...rows].sort((a, b) => {
        const av = a[sortKey];
        const bv = b[sortKey];
        // Push empty values to the end in both directions.
        if (!av && !bv) return a.id.localeCompare(b.id);
        if (!av) return 1;
        if (!bv) return -1;
        const cmp = av.localeCompare(bv);
        const primary = sortDir === 'asc' ? cmp : -cmp;
        if (primary !== 0) return primary;
        return a.id.localeCompare(b.id);
    });
}

// ─── Empty row factory ───────────────────────────────────────────────────────────
function createEmptyRow(overrides: Partial<GridRow> = {}): GridRow {
    const today = new Date().toISOString().split('T')[0];
    return {
        _state: 'new',
        id: '',
        recv_date: today,
        prod_date: '',
        batch: '',
        shift_code: '',
        grade_code: '',
        plant_code: '',
        warehouse_code: '',
        source_location_code: '',
        ccc_flec: '',
        weight_kg: '',
        flec_count: '',
        whse_side: '',
        batch_year: '',
        ...overrides,
    };
}

// A new row counts as "real" (savable, dirty) once it carries any identifying data.
function isMeaningfulNewRow(r: GridRow): boolean {
    return Boolean(r.batch || r.weight_kg || r.grade_code || r.ccc_flec);
}

// ─── Paste cleaning ──────────────────────────────────────────────────────────────
function cleanPasteValue(raw: string, field: GridField): string {
    const val = trimCellValue(raw);
    if (field === 'recv_date' || field === 'prod_date') return parseExcelDate(val);
    if (NUMERIC_FIELDS.has(field)) return val.replace(/[₱,"'%]/g, '');
    return val;
}

// ─── Input class ─────────────────────────────────────────────────────────────────
const inputClass =
    'h-8 w-full px-1 border-transparent bg-transparent rounded-none font-bold focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-primary focus-visible:bg-accent/10 transition-colors shadow-none';

// ─── Direction tint (IN vs OUT, by disposition) ──────────────────────────────────
// Each production row reads as an IN (into inventory) or OUT (out into partner gear),
// keyed off the disposition the CCC/FLEC cell resolves to:
//   • flec_bagging                  → IN  → emerald row tint
//   • partner_crusher / partner_kiln → OUT → rose row tint
//   • empty / unrecognized          → no tint
// The tints are bold enough to read clearly in BOTH modes (light: a solid -50/-ish
// translucent green/red; dark: a deep -950 wash), yet still let cell-selection, row
// hover, and the dirty-state left borders sit on top. We derive direction from the raw
// `ccc_flec` cell via the shared `parseCccFlec` (same source of truth as save), so an
// unsaved edit re-tints live as the operator types a recognized code.
//
// Two tint flavours are returned per direction:
//   • TRANSLUCENT (`rowDirectionTint`)   → the scrolling `<tr>` background; lets row
//     hover/selection blend through.
//   • OPAQUE      (`rowDirectionFrozenTint`) → the sticky frozen identity cells, which
//     MUST be opaque so scrolling content doesn't bleed through them. Built on the
//     `bg-background`/`bg-card` base so the row still reads as one continuous strip.
type RowDirection = 'in' | 'out' | 'dvo' | null;

// Row tint logic keys on the WAREHOUSE first, then the CCC/FLEC disposition.
// Priority (top wins): UNPLACED > WHSE 3 (DVO) > disposition.
//   • UNPLACED (warehouse blank) → NO tint (an unplaced bagging row isn't highlighted
//     until it's placed — setting the Whse dropdown is what places it).
//   • WHSE 3 is the DVO warehouse → BLUE, regardless of disposition (a DVO row is never
//     counted as "taken out of a real warehouse").
//   • A real placed warehouse (WHSE 1/2/5/7) → disposition decides: bagged-IN = GREEN,
//     any withdrawal (crusher/kiln) = RED.
export function rowDirection(row: GridRow): RowDirection {
    const wh = (row.warehouse_code ?? '').toString().trim().toUpperCase();
    // 1. Unplaced ALWAYS wins → no tint
    if (wh === '') return null;
    // 2. WHSE 3 is the DVO warehouse → blue, never counts as "taken out"
    if (wh === 'WHSE 3') return 'dvo';
    // 3. A real placed warehouse (WHSE 1/2/5/7): disposition decides
    const res = parseCccFlec(row.ccc_flec);
    if (!res) return null;
    return res.disposition_kind === 'flec_bagging' ? 'in' : 'out';
}

// Scrolling-cell tint — translucent so hover/selection still blend through.
export function rowDirectionTint(dir: RowDirection): string {
    if (dir === 'in') return 'bg-emerald-50 dark:bg-emerald-950/40';
    if (dir === 'out') return 'bg-rose-50 dark:bg-rose-950/40';
    if (dir === 'dvo') return 'bg-blue-50 dark:bg-blue-950/40';
    return '';
}

// Frozen-cell tint — OPAQUE (layered over an opaque `bg-background` base in the cell)
// so the scrolling body can't show through the pinned identity columns, while still
// matching the row's IN/OUT color so there's no seam between frozen and scrolling parts.
// Light mode uses the same -50 wash over the opaque base; dark uses a denser -950/60 so
// it reads against the dark surface and isn't see-through.
export function rowDirectionFrozenTint(dir: RowDirection): string {
    if (dir === 'in') return 'bg-emerald-50 dark:bg-emerald-950/60';
    if (dir === 'out') return 'bg-rose-50 dark:bg-rose-950/60';
    if (dir === 'dvo') return 'bg-blue-50 dark:bg-blue-950/60';
    return '';
}

// ─── Badge class maps (display mode only — inputs stay plain) ─────────────────────
// MOVED to the pure `../badges` module on 2026-08-04 so the QC Ledger's PLANT dropdown
// can share the exact same colours without importing this 1,500-line client component
// (and its server actions) across a route boundary. Re-exported here so the sibling
// display surfaces — the endless sheet and the mobile cards — keep importing them from
// the ledger, unchanged. One definition, three consumers, no drift.
export { BADGE_BASE, cccFlecBadgeClass, plantBadgeClass };

// formatDateShort is imported from the shared DatePickerCell module (its canonical home).

// ─── KG formatter (whole kg, thousands separators) ───────────────────────────────
export function formatKg(value: string): string {
    if (value === '') return '';
    const n = parseFloat(value);
    if (isNaN(n)) return '';
    return n.toLocaleString('en-US', { maximumFractionDigits: 0 });
}


// ─── Header filter (multi-select) ─────────────────────────────────────────────────
// The single-select `DropdownMenuRadioGroup` was replaced by the shared multi-select
// `ColumnFilterMenu` (column-filter-menu.tsx), which BOTH this grid and the endless sheet
// render — one component, one set of semantics. `HeaderFilter` is the thin per-column
// binding: canonical options (+ any discovered unmapped value) merged once, presence in
// the loaded rows fed in for the dimming pass.
interface HeaderFilterProps {
    column: FilterColumn;
    selected: readonly string[];
    presence: ReadonlySet<string>;
    onChange: (values: string[]) => void;
    align?: 'start' | 'end';
}

function HeaderFilter({ column, selected, presence, onChange, align = 'start' }: HeaderFilterProps) {
    const options = React.useMemo(() => mergeDiscoveredOptions(column, presence), [column, presence]);
    const groups = React.useMemo(() => mergeDiscoveredGroups(column, options), [column, options]);
    return (
        <ColumnFilterMenu
            label={FILTER_SPECS[column].label}
            selected={selected}
            options={options}
            groups={groups}
            present={presence}
            searchable={FILTER_SPECS[column].searchable}
            onChange={onChange}
            align={align}
        />
    );
}

// ─── DateSortHeader (clickable date column header — sorts by THIS date) ───────────
// Both the Recv and Prod headers use this. The whole header is a button: clicking the
// currently-active date key toggles asc/desc; clicking the inactive one switches the
// sort key to it. The up/down chevron shows ONLY on the active key (matching the
// other sortable header's affordance); inactive headers show a faint idle indicator.
interface DateSortHeaderProps {
    label: string;
    sortKey: DateSortKey;
    activeKey: DateSortKey;
    dir: 'asc' | 'desc';
    onSort: (key: DateSortKey) => void;
}

function DateSortHeader({ label, sortKey, activeKey, dir, onSort }: DateSortHeaderProps) {
    const isActive = activeKey === sortKey;
    return (
        <button
            type="button"
            onClick={() => onSort(sortKey)}
            aria-label={`Sort by ${label}${isActive ? ` (${dir === 'asc' ? 'ascending' : 'descending'})` : ''}`}
            title={
                isActive
                    ? `${label}: ${dir === 'desc' ? 'newest first' : 'oldest first'} — click to flip`
                    : `Sort by ${label}`
            }
            className={cn(
                'group/sort -ml-0.5 flex items-center gap-0.5 rounded px-0.5 outline-none transition-colors duration-150',
                'focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-primary',
                isActive ? 'text-primary hover:text-primary/80' : 'text-muted-foreground hover:text-foreground',
            )}
        >
            <span className="text-[11px] font-bold uppercase tracking-wide">{label}</span>
            {isActive ? (
                dir === 'desc' ? (
                    <ArrowDown className="h-3 w-3 flex-none" />
                ) : (
                    <ArrowUp className="h-3 w-3 flex-none" />
                )
            ) : (
                <ChevronsUpDown className="h-3 w-3 flex-none text-muted-foreground/40 transition-colors group-hover/sort:text-muted-foreground" />
            )}
        </button>
    );
}

// ─── ProductionRow (memoized) ────────────────────────────────────────────────────
// One ledger row, extracted + wrapped in React.memo so editing/selecting a cell only
// re-renders the rows whose props actually changed — not the whole grid. The parent
// passes PRIMITIVE slices of the global active/selection state (the active col within
// THIS row, the selection col-span when this row is in range, etc.) plus stable
// callbacks, so memo's shallow compare skips untouched rows. The `activeCell` object
// GridCell expects is rebuilt locally (memoized on rowIdx+activeColInRow) so it stays
// referentially stable across other rows' renders.
interface ProductionRowProps {
    row: GridRow;
    rowIdx: number;
    rowHidden: boolean;
    contextMenuActive: boolean;
    // Active/edit state, sliced to this row.
    activeColInRow: number; // -1 when the active cell is in another row
    isEditing: boolean;
    // Selection state, sliced to this row (derived from the selection range).
    rowInRange: boolean;
    selStartCol: number;
    selEndCol: number;
    anchorColInRow: number; // -1 when the anchor is in another row
    isDragActive: boolean;
    selectionSize: number;
    // Stable callbacks from the parent.
    updateRow: (idx: number, field: GridField, value: string) => void;
    handleSmartPaste: (e: React.ClipboardEvent, startRow: number, startCol: number) => void;
    handleCellMouseDown: (rowIdx: number, colIdx: number, e: React.MouseEvent) => void;
    handleCellMouseUp: (rowIdx: number, colIdx: number) => void;
    handleCellMouseEnter: (rowIdx: number, colIdx: number) => void;
    startEditing: (rowIdx: number, colIdx: number, initialChar?: string) => void;
    revertChanges: () => void;
    setActiveCell: (cell: { row: number; col: number }) => void;
    setIsEditing: (editing: boolean) => void;
    onRowContextMenu: (rowIdx: number, e: React.MouseEvent) => void;
    gridRef: React.RefObject<HTMLDivElement | null>;
}

const ProductionRow = React.memo(function ProductionRow({
    row,
    rowIdx,
    rowHidden,
    contextMenuActive,
    activeColInRow,
    isEditing,
    rowInRange,
    selStartCol,
    selEndCol,
    anchorColInRow,
    isDragActive,
    selectionSize,
    updateRow,
    handleSmartPaste,
    handleCellMouseDown,
    handleCellMouseUp,
    handleCellMouseEnter,
    startEditing,
    revertChanges,
    setActiveCell,
    setIsEditing,
    onRowContextMenu,
    gridRef,
}: ProductionRowProps) {
    const isDeleted = row._state === 'deleted';
    const isModified = row._state === 'modified';
    const isNew = row._state === 'new';

    // Row tint — keyed on warehouse first, then CCC/FLEC disposition (priority:
    // unplaced > WHSE 3/DVO > disposition): GREEN bagged into a real warehouse, RED a
    // withdrawal from one, BLUE a WHSE 3 (DVO) row, none when unplaced. Sits UNDER the
    // dirty-state left border + the selection highlight. Two flavours: the translucent
    // one tints the scrolling `<tr>`; the opaque one tints the sticky frozen identity
    // cells (which must be opaque so scrolling content doesn't bleed through).
    const direction = rowDirection(row);
    const directionTint = rowDirectionTint(direction);
    const frozenTint = rowDirectionFrozenTint(direction);

    // Shared frozen-cell base: the canonical OPAQUE frozen LEFT-column surface
    // (.frozen-col, z-10 — see globals.css "Frozen Panes"). `bg-background` guarantees
    // opacity so the scrolling body can't bleed through the pinned identity columns;
    // the row's OPAQUE IN/OUT tint layers over it, and group-hover repaints the hover
    // tint opaquely so the frozen cells track the scrolling part of the same row.
    const frozenCellBase = cn(
        'frozen-col bg-background group-hover:bg-muted transition-colors duration-150',
        frozenTint,
    );

    // Rebuild the active-cell object GridCell needs — null unless the active cell is in
    // this row. Memoized on (rowIdx, activeColInRow) so it's stable while other rows edit.
    const activeCell = React.useMemo(
        () => (activeColInRow >= 0 ? { row: rowIdx, col: activeColInRow } : null),
        [rowIdx, activeColInRow],
    );

    // Per-cell selection feedback, derived from this row's range slice (all primitives).
    const isSel = React.useCallback(
        (col: number) => rowInRange && col >= selStartCol && col <= selEndCol,
        [rowInRange, selStartCol, selEndCol],
    );
    const isAnch = React.useCallback((col: number) => anchorColInRow === col, [anchorColInRow]);

    // selProps / commonCellProps — rebuilt once per row render (not per parent render),
    // and only when this row's sliced state changes (memo gate above).
    const selProps = React.useCallback(
        (colIdx: number) => ({
            onCellMouseDown: (e: React.MouseEvent) => handleCellMouseDown(rowIdx, colIdx, e),
            onCellMouseUp: () => handleCellMouseUp(rowIdx, colIdx),
            onCellMouseEnter: () => handleCellMouseEnter(rowIdx, colIdx),
            isCellRangeSelected: isSel(colIdx),
            isCellRangeAnchor: isAnch(colIdx),
            isDragActive,
        }),
        [rowIdx, handleCellMouseDown, handleCellMouseUp, handleCellMouseEnter, isSel, isAnch, isDragActive],
    );

    const commonCellProps = {
        activeCell,
        isEditing,
        setActiveCell,
        setIsEditing,
        onStartEditing: startEditing,
        onRevert: revertChanges,
        gridRef,
    };

    // Selection/active visuals for the interactive (dropdown/date) cell wrappers.
    const interactiveCellClass = (colIdx: number) =>
        cn(
            'relative h-full w-full',
            isSel(colIdx) && 'bg-primary/10 dark:bg-primary/20',
            activeColInRow === colIdx && selectionSize <= 1 && 'z-10 ring-2 ring-primary ring-inset',
            isAnch(colIdx) && 'z-10 ring-2 ring-primary ring-inset',
        );

    return (
        <tr
            hidden={rowHidden}
            className={cn(
                // The horizontal RULE is on the CELLS (`[&>*]:`), never on the <tr>. This
                // table is `border-collapse: separate` (load-bearing: under `collapse` a
                // border belongs to the TABLE rather than the cell, so a sticky frozen
                // column's borders scroll away), and in the separated-borders model the CSS
                // spec paints borders on table CELLS ONLY — the `border-b border-border/30`
                // that used to sit here was never painted. Same /30 weight it always meant,
                // side-specific colour so tailwind-merge cannot restyle the cells'
                // `border-r`. Row height is unchanged (cells are border-box).
                'group h-8 [&>*]:border-b [&>*]:border-b-border/30 transition-all duration-150 hover:bg-muted',
                // Direction tint first so the dirty borders + hover/selection read on top.
                directionTint,
                rowHidden && 'hidden',
                isDeleted && 'line-through opacity-40',
                contextMenuActive && 'bg-accent/30',
            )}
            style={{ height: '32px' }}
            onContextMenu={(e) => onRowContextMenu(rowIdx, e)}
        >
            {/* Row number — FROZEN col 0 (left: 0). The dirty-state left border lives on
                THIS cell (not the <tr>) — the opaque sticky bg would otherwise paint over
                a <tr>-level left border once it scrolls under nothing / on collapse:separate. */}
            <td
                className={cn(
                    frozenCellBase,
                    'border-r border-border/30 px-1 text-center font-mono text-[10px] font-bold text-muted-foreground',
                    isModified && 'border-l-2 border-l-amber-400',
                    isNew && 'border-l-2 border-l-blue-400/50',
                )}
                style={{ height: '32px', left: 0 }}
            >
                {rowIdx + 1}
            </td>

            {/* Recv date (col 1) — frozen (left: 36) */}
            <td className={cn(frozenCellBase, 'border-r border-border/30 p-0')} style={{ height: '32px', left: 36 }}>
                <DatePickerCell
                    value={row.recv_date}
                    onChange={(v) => updateRow(rowIdx, 'recv_date', v)}
                    onPaste={(e) => { e.stopPropagation(); handleSmartPaste(e, rowIdx, 1); }}
                    isActive={activeColInRow === 1}
                    isRangeSelected={isSel(1)}
                    isRangeAnchor={isAnch(1)}
                    onCellMouseDown={(e) => handleCellMouseDown(rowIdx, 1, e)}
                    onCellMouseUp={() => handleCellMouseUp(rowIdx, 1)}
                    onCellMouseEnter={() => handleCellMouseEnter(rowIdx, 1)}
                />
            </td>

            {/* Prod date (col 2) — frozen (left: 132), muted (often blank) */}
            <td className={cn(frozenCellBase, 'border-r border-border/30 p-0')} style={{ height: '32px', left: 132 }}>
                <DatePickerCell
                    value={row.prod_date}
                    onChange={(v) => updateRow(rowIdx, 'prod_date', v)}
                    onPaste={(e) => { e.stopPropagation(); handleSmartPaste(e, rowIdx, 2); }}
                    isActive={activeColInRow === 2}
                    isRangeSelected={isSel(2)}
                    isRangeAnchor={isAnch(2)}
                    onCellMouseDown={(e) => handleCellMouseDown(rowIdx, 2, e)}
                    onCellMouseUp={() => handleCellMouseUp(rowIdx, 2)}
                    onCellMouseEnter={() => handleCellMouseEnter(rowIdx, 2)}
                    muted
                />
            </td>

            {/* Batch (col 3) — frozen (left: 228), LAST frozen col → right-edge separator
                shadow. Text + muted batch_year tag. */}
            <td className={cn(frozenCellBase, 'frozen-edge border-r border-border/30 p-0')} style={{ height: '32px', left: 228 }}>
                <GridCell
                    col={3}
                    row={rowIdx}
                    value={row.batch}
                    className="justify-start px-1 font-mono text-xs font-bold"
                    displayValue={
                        <span className="flex w-full items-center gap-1 truncate px-1">
                            <span className="truncate font-bold">{row.batch}</span>
                            {row.batch_year && <span className="font-mono text-[10px] font-bold text-muted-foreground/60">{row.batch_year}</span>}
                        </span>
                    }
                    {...commonCellProps}
                    {...selProps(3)}
                >
                    <Input
                        ref={focusNoScroll}
                        value={row.batch}
                        onChange={(e) => updateRow(rowIdx, 'batch', e.target.value.toUpperCase())}
                        className={cn(inputClass, 'font-mono text-xs uppercase')}
                        onPaste={(e) => { e.stopPropagation(); handleSmartPaste(e, rowIdx, 3); }}
                    />
                </GridCell>
            </td>

            {/* Shift (col 4) — dropdown */}
            <td className="border-r border-border/30 p-0" style={{ height: '32px' }}>
                <div className={interactiveCellClass(4)}>
                    <SelectCell value={row.shift_code} options={SHIFT_CODES} onChange={(v) => updateRow(rowIdx, 'shift_code', v)} placeholder="—" />
                </div>
            </td>

            {/* Grade (col 5) — dropdown */}
            <td className="border-r border-border/30 p-0" style={{ height: '32px' }}>
                <div className={interactiveCellClass(5)}>
                    <SelectCell value={row.grade_code} options={GRADE_CODES} onChange={(v) => updateRow(rowIdx, 'grade_code', v)} placeholder="—" />
                </div>
            </td>

            {/* Plant (col 6) — dropdown, nullable. Display value renders as a per-plant
                colored badge (W6 blue / W7 teal / W6/W7 indigo / DVO slate); empty = plain. */}
            <td className="border-r border-border/30 p-0" style={{ height: '32px' }}>
                <div className={interactiveCellClass(6)}>
                    <SelectCell
                        value={row.plant_code}
                        options={PLANT_CODES}
                        onChange={(v) => updateRow(rowIdx, 'plant_code', v)}
                        nullable
                        placeholder="—"
                        renderTrigger={(v) => (
                            <span className={cn(BADGE_BASE, plantBadgeClass(v))}>{v}</span>
                        )}
                    />
                </div>
            </td>

            {/* Whse (col 7) — dropdown, nullable (null = unplaced) */}
            <td className="border-r border-border/30 p-0" style={{ height: '32px' }}>
                <div className={cn(interactiveCellClass(7), row.warehouse_code === '' && 'bg-amber-500/[0.04]')}>
                    <SelectCell value={row.warehouse_code} options={WAREHOUSE_CODES} onChange={(v) => updateRow(rowIdx, 'warehouse_code', v)} nullable placeholder="unplaced" />
                </div>
            </td>

            {/* Source (col 8) — dropdown */}
            <td className="border-r border-border/30 p-0" style={{ height: '32px' }}>
                <div className={interactiveCellClass(8)}>
                    <SelectCell value={row.source_location_code} options={SOURCE_LOCATION_CODES} onChange={(v) => updateRow(rowIdx, 'source_location_code', v)} placeholder="—" />
                </div>
            </td>

            {/* Weight (col 9) — numeric, right-aligned */}
            <td className="border-r border-border/30 p-0" style={{ height: '32px' }}>
                <GridCell
                    col={9}
                    row={rowIdx}
                    value={formatKg(row.weight_kg)}
                    className="justify-end pr-1 font-mono font-bold tabular-nums"
                    {...commonCellProps}
                    {...selProps(9)}
                >
                    <Input
                        ref={focusNoScroll}
                        type="number"
                        step="1"
                        value={row.weight_kg}
                        onChange={(e) => updateRow(rowIdx, 'weight_kg', e.target.value)}
                        className={cn(inputClass, 'text-right font-mono text-xs')}
                        onPaste={(e) => { e.stopPropagation(); handleSmartPaste(e, rowIdx, 9); }}
                    />
                </GridCell>
            </td>

            {/* CCC/FLEC (col 10) — single typeahead cell, Excel parity. The raw text
                stands in for disposition_kind + partner_equipment_code (parsed back into
                both DB fields at save). Paste-friendly <Input list> (datalist), not a
                strict dropdown — so a pasted FLEC/C1/RK3 lands directly. */}
            <td className="border-r border-border/30 p-0" style={{ height: '32px' }}>
                <GridCell
                    col={10}
                    row={rowIdx}
                    value={row.ccc_flec}
                    className="justify-start px-1 font-mono text-xs font-bold"
                    displayValue={
                        row.ccc_flec
                            ? <span className="flex w-full items-center px-1">
                                  <span className={cn(BADGE_BASE, cccFlecBadgeClass(row.ccc_flec))}>{row.ccc_flec}</span>
                              </span>
                            : <span className="px-1 text-muted-foreground/40">—</span>
                    }
                    {...commonCellProps}
                    {...selProps(10)}
                >
                    <Input
                        ref={focusNoScroll}
                        value={row.ccc_flec}
                        list="ledger-ccc-flec-suggestions"
                        onChange={(e) => updateRow(rowIdx, 'ccc_flec', e.target.value.toUpperCase())}
                        className={cn(inputClass, 'font-mono text-xs uppercase')}
                        onPaste={(e) => { e.stopPropagation(); handleSmartPaste(e, rowIdx, 10); }}
                    />
                </GridCell>
            </td>

            {/* Flec (col 11) — numeric int, right-aligned */}
            <td className="border-r border-border/30 p-0" style={{ height: '32px' }}>
                <GridCell
                    col={11}
                    row={rowIdx}
                    value={row.flec_count}
                    className="justify-end pr-1 font-mono font-bold tabular-nums text-muted-foreground"
                    {...commonCellProps}
                    {...selProps(11)}
                >
                    <Input
                        ref={focusNoScroll}
                        type="number"
                        step="1"
                        value={row.flec_count}
                        onChange={(e) => updateRow(rowIdx, 'flec_count', e.target.value)}
                        className={cn(inputClass, 'text-right font-mono text-xs')}
                        onPaste={(e) => { e.stopPropagation(); handleSmartPaste(e, rowIdx, 11); }}
                    />
                </GridCell>
            </td>

            {/* Side (col 12) — dropdown, nullable */}
            <td className="p-0" style={{ height: '32px' }}>
                <div className={interactiveCellClass(12)}>
                    <SelectCell value={row.whse_side} options={WHSE_SIDES} onChange={(v) => updateRow(rowIdx, 'whse_side', v)} nullable placeholder="—" align="end" />
                </div>
            </td>
        </tr>
    );
});

// ─── Component props ─────────────────────────────────────────────────────────────
interface ProductionLedgerGridProps {
    initialRows: ProductionEventRow[];
    periods: CenaproPeriod[];
    selectedPeriod: CenaproPeriod | null;
    loadError: string | null;
    onSaveSuccess: () => void;
}

// ─── Main component ──────────────────────────────────────────────────────────────
export function ProductionLedgerGrid({
    initialRows,
    periods,
    selectedPeriod,
    loadError,
    onSaveSuccess,
}: ProductionLedgerGridProps) {
    const gridRef = React.useRef<HTMLDivElement>(null);

    // Active view mode from `?view=` (ledger | daily). Default 'ledger'. Drives whether
    // the editable grid or the read-only Daily Block pivot renders below the toolbar.
    const viewSearchParams = useSearchParams();
    const viewMode = parseViewMode(viewSearchParams.get('view'));
    const plantView = plantViewOf(viewMode); // 'W6' | 'W7' | null
    const isDailyView = plantView !== null;
    // Scope axis (`?scope=`, legacy `?focus=1`). This grid renders for FOCUS (any view)
    // AND for the endless+daily fallback (Phase 1 shows the month-scoped daily block until
    // the endless pivot lands in Phase 2). The Scope toggle mirrors the real URL state so
    // it never lies about which scope you're in; it preserves view/year/batch on a switch.
    const currentScope: Scope = viewSearchParams.get('focus') === '1'
        ? 'focus'
        : parseScope(viewSearchParams.get('scope'));

    // Bulk entry moved to the endless sheet's loss-proof draft zone (Phase 2A — the
    // fragile Bulk Add modal was retired). This affordance switches to endless + ledger
    // and carries a one-shot `?add=1` so the sheet opens UNLOCKED with the entry zone
    // ready. It drops year/batch so the sheet anchors at the TRUE latest (newest end) —
    // the only place new rows can append — rather than mid-history where the zone would
    // hide behind a "jump to latest" affordance.
    const router = useRouter();
    const pathname = usePathname();
    const goAddInSheet = React.useCallback(() => {
        const sp = new URLSearchParams(viewSearchParams.toString());
        sp.delete('focus'); // retire the legacy silo param
        sp.delete('scope'); // endless is the default (clean URL)
        sp.delete('view'); // ledger is the default
        sp.delete('year'); // → anchor resolves to `latest` (the append edge)
        sp.delete('batch');
        sp.set('add', '1'); // one-shot: unlock the draft entry zone on arrival
        const qs = sp.toString();
        router.push(qs ? `${pathname}?${qs}` : pathname);
    }, [viewSearchParams, router, pathname]);

    // Date sort — clickable on EITHER date header. Default: newest-first by recv_date
    // (operators care about recent activity most); clicking the Prod header switches the
    // sort key to prod_date. Each header toggles asc/desc on repeat clicks.
    const [dateSortKey, setDateSortKey] = React.useState<DateSortKey>('recv_date');
    const [dateSortDir, setDateSortDir] = React.useState<'asc' | 'desc'>('desc');

    // Only the actual (period-scoped) data rows — adds happen via the Bulk Add modal or
    // the right-click Insert Above/Below context menu, so there is NO persistent trailing
    // empty input row.
    const [rows, setRows] = React.useState<GridRow[]>(() =>
        buildGridRows(initialRows, 'recv_date', 'desc'),
    );

    const [activeCell, setActiveCell] = React.useState<CoordinateId | null>(null);
    const [isSaving, setIsSaving] = React.useState(false);

    // Live refs to `rows` + `activeCell`, synced during render. These let the cell
    // callbacks (`startEditing`, `revertChanges`) read current values WITHOUT listing
    // `rows`/`activeCell` in their deps — keeping their identity STABLE so the memoized
    // ProductionRow isn't re-rendered on every keystroke just because a handler changed.
    const rowsRef = React.useRef(rows);
    rowsRef.current = rows;
    const activeCellRef = React.useRef(activeCell);
    activeCellRef.current = activeCell;

    // ─── Header filters — MULTI-SELECT, driven by the URL filter axis ───────────────
    // State lives in `?shift=&grade=&plant=&whse=&src=&ccc=` (CLAUDE.md: URL params carry
    // filter state), parsed + written by the shared `useLedgerFilters()` hook so this grid
    // and the endless sheet read/write the SAME contract. Focus scope loads one whole
    // period, so applying them CLIENT-side here is complete and instant — nothing is
    // paged in behind the operator's back, unlike the endless keyset window (which pushes
    // the identical predicates into SQL, see actions.ts::applyLedgerFilters).
    const filterUi = useLedgerFilters();
    const filters = filterUi.filters;
    const anyFilterActive = filterUi.activeCount > 0;
    const setFilterColumn = filterUi.setColumn;
    const clearFilters = filterUi.clearAll;

    // ─── Re-sort the data rows when the date key/direction changes ──────────────────
    React.useEffect(() => {
        setRows((prev) => sortGridRows(prev, dateSortKey, dateSortDir));
    }, [dateSortKey, dateSortDir]);

    // ─── Context menu state (shared Blackwood Table primitive) ──────────────────────
    const contextMenu = useGridContextMenu<number>({ width: 188, height: 164 });

    // ─── Cell selection (every column except row# is selectable) ───────────────────
    const isSelectableColumn = React.useCallback((c: number) => c !== 0 && COL_MAP[c] !== null, []);
    const cellSelection = useCellSelection({
        rowCount: rows.length,
        colCount: COL_COUNT,
        isSelectableColumn,
        scrollContainerRef: gridRef,
        enabled: true,
    });

    // ─── Cell value accessor (for clipboard copy) ──────────────────────────────────
    const getCellValue = React.useCallback(
        (rowIdx: number, colIdx: number): string => {
            const row = rows[rowIdx];
            if (!row) return '';
            const field = COL_MAP[colIdx];
            if (!field) return '';
            // CCC/FLEC copies as its raw Excel value ("FLEC"/"C1"/"RK3") so a copied
            // range round-trips straight back into the same single column on paste.
            return String(row[field] ?? '');
        },
        [rows],
    );

    const { handleKeyDown: handleCopyKeyDown } = useClipboardCopy({
        getSelectedRange: cellSelection.getSelectedRange,
        getCellValue,
        getSelectionSize: cellSelection.getSelectionSize,
    });

    // ─── Mouse handlers (drag-select vs click-to-activate) ─────────────────────────
    const mouseDownCellRef = React.useRef<{ row: number; col: number } | null>(null);
    const dragMovedRef = React.useRef(false);

    // Depend on the INDIVIDUAL stable hook methods (each is a useCallback inside
    // useCellSelection), NOT the `cellSelection` object — that object is a fresh literal
    // every render, which would make these handlers (and thus every memoized row) churn.
    const selMouseDown = cellSelection.handleCellMouseDown;
    const selMouseEnter = cellSelection.handleCellMouseEnter;
    const selClear = cellSelection.clearSelection;

    const handleCellMouseDown = React.useCallback(
        (rowIdx: number, colIdx: number, e: React.MouseEvent) => {
            mouseDownCellRef.current = { row: rowIdx, col: colIdx };
            dragMovedRef.current = false;
            selMouseDown(rowIdx, colIdx, e);
        },
        [selMouseDown],
    );

    const handleCellMouseUp = React.useCallback(
        (rowIdx: number, colIdx: number) => {
            const down = mouseDownCellRef.current;
            mouseDownCellRef.current = null;
            if (down && down.row === rowIdx && down.col === colIdx && !dragMovedRef.current) {
                selClear();
                setActiveCell({ row: rowIdx, col: colIdx });
                setIsEditing(false);
                // `preventScroll`: HTMLElement.focus() otherwise scrolls the grid wrapper
                // into view with block "center" through every scrolling ancestor — even
                // when it is already fully visible — so clicking a cell jogged the page.
                gridRef.current?.focus({ preventScroll: true });
            }
            dragMovedRef.current = false;
        },
        [selClear],
    );

    const handleCellMouseEnter = React.useCallback(
        (rowIdx: number, colIdx: number) => {
            if (mouseDownCellRef.current) {
                dragMovedRef.current = true;
                selMouseEnter(rowIdx, colIdx);
            }
        },
        [selMouseEnter],
    );

    // ─── Row mutation helpers ──────────────────────────────────────────────────────
    // NOTE: there is intentionally no trailing always-empty "new" row anymore — adds
    // happen via the Bulk Add modal (primary) or the right-click Insert Above/Below
    // context menu (occasional one-off). Paste-into-the-grid may still auto-extend rows
    // (see handleSmartPaste), but nothing maintains a permanent blank input row.

    const updateRow = React.useCallback((idx: number, field: GridField, value: string) => {
        setRows((prev) => {
            const next = [...prev];
            // `ccc_flec` is a real raw-text field now (parsed to the two DB fields at
            // save), so the generic spread handles every column — no special-casing.
            const row = { ...next[idx], [field]: value };
            if (row._state === 'existing') row._state = 'modified';
            next[idx] = row;
            return next;
        });
    }, []);

    const markDeleted = React.useCallback((idx: number) => {
        setRows((prev) => {
            const next = [...prev];
            const row = { ...next[idx] };
            if (row._state === 'new') {
                // A brand-new (unsaved) row is simply removed — no need to keep a
                // placeholder; there's no trailing input row to preserve.
                next.splice(idx, 1);
                return next;
            }
            row._state = 'deleted';
            next[idx] = row;
            return next;
        });
    }, []);

    const restoreRow = React.useCallback((idx: number) => {
        setRows((prev) => {
            const next = [...prev];
            const row = { ...next[idx] };
            row._state = row.id ? 'existing' : 'new';
            next[idx] = row;
            return next;
        });
    }, []);

    const insertRowAt = React.useCallback((idx: number, offset: 0 | 1) => {
        setRows((prev) => {
            const next = [...prev];
            const ref = next[idx];
            // Inherit dates from the reference row so a burst of same-day entries is fast.
            const newRow = createEmptyRow({ recv_date: ref?.recv_date ?? new Date().toISOString().split('T')[0] });
            next.splice(idx + offset, 0, newRow);
            return next;
        });
    }, []);

    const duplicateRow = React.useCallback((idx: number) => {
        setRows((prev) => {
            const next = [...prev];
            const src = next[idx];
            if (!src) return prev;
            // A duplicate is a brand-new row (no id) — never an UPDATE of the source.
            const dup: GridRow = { ...src, _state: 'new', id: '', batch_year: '' };
            next.splice(idx + 1, 0, dup);
            return next;
        });
    }, []);

    // Right-click row menu items (shared Blackwood Table primitive). Delete vs
    // Restore is modeled as TWO items gated by `hidden` (the shared GridMenuItem
    // has a static `variant`, so destructive Delete and muted Restore can't be one
    // dynamic item without losing the red styling).
    const isRowDeleted = React.useCallback(
        (idx: number) => rows[idx]?._state === 'deleted',
        [rows],
    );
    const ROW_MENU_ITEMS = React.useMemo<GridMenuItem<number>[]>(() => [
        { kind: 'item', label: 'Insert Row Above', icon: ArrowUpFromLine, onSelect: (idx) => insertRowAt(idx, 0) },
        { kind: 'item', label: 'Insert Row Below', icon: ArrowDownFromLine, onSelect: (idx) => insertRowAt(idx, 1) },
        { kind: 'item', label: 'Duplicate Row', icon: Copy, onSelect: (idx) => duplicateRow(idx) },
        { kind: 'separator' },
        { kind: 'item', label: 'Delete Row', icon: Trash2, variant: 'destructive', onSelect: (idx) => markDeleted(idx), hidden: isRowDeleted },
        { kind: 'item', label: 'Restore Row', icon: RotateCcw, onSelect: (idx) => restoreRow(idx), hidden: (idx) => !isRowDeleted(idx) },
    ], [insertRowAt, duplicateRow, markDeleted, restoreRow, isRowDeleted]);

    const clearCell = React.useCallback(
        (rowIdx: number, colIdx: number) => {
            const field = COL_MAP[colIdx];
            if (!field) return;
            updateRow(rowIdx, field, '');
        },
        [updateRow],
    );

    const { handleKeyDown: handleDeleteKeyDown } = useCellDelete({
        getSelectedRange: cellSelection.getSelectedRange,
        getSelectionSize: cellSelection.getSelectionSize,
        clearCell,
    });

    // ─── Edit session (shared Blackwood Table primitive) ───────────────────────────
    // STABILITY MATTERS HERE: the memoized ProductionRow relies on startEditing/
    // revertChanges keeping a stable identity, so the session's getValue/setValue are
    // ref-reading useCallbacks (empty/stable deps), keeping editSession.startEditing
    // referentially stable so the rows don't churn on every keystroke.
    const getValueStable = React.useCallback((id: CoordinateId): string => {
        const field = COL_MAP[id.col];
        if (!field) return '';
        return String(rowsRef.current[id.row]?.[field] ?? '');
    }, []);
    const setValueStable = React.useCallback((id: CoordinateId, value: string) => {
        const field = COL_MAP[id.col];
        if (field) updateRow(id.row, field, value);
    }, [updateRow]);

    const editSession = useGridEditSession<CoordinateId>({
        getValue: getValueStable,
        setValue: setValueStable,
    });
    const isEditing = editSession.isEditing;
    const setIsEditing = React.useCallback((editing: boolean) => {
        if (!editing) editSession.commit();
    }, [editSession]);

    // GridCell-compatible startEditing adapter. Keeps the original typable-only guard
    // (dropdown + date columns open their own UI and are never keyboard-typed).
    const startEditing = React.useCallback(
        (rowIdx: number, colIdx: number, initialChar?: string) => {
            const field = COL_MAP[colIdx];
            if (!field) return;
            if (DROPDOWN_FIELDS.has(field) || field === 'recv_date' || field === 'prod_date') return;
            setActiveCell({ row: rowIdx, col: colIdx });
            editSession.startEditing({ row: rowIdx, col: colIdx }, initialChar);
        },
        [editSession],
    );

    // Custom revert (NOT editSession.revertChanges): the ledger additionally rolls a
    // reverted MODIFIED-existing row back to 'existing' so an Escape un-dirties it. Reads
    // the pre-edit snapshot from the session's ref + the active cell from activeCellRef
    // (stable identity → memoized rows don't churn). editSession.commit() exits edit mode
    // (no onAfterCommit is configured, so it has no side effect beyond isEditing=false).
    const revertChanges = React.useCallback(() => {
        const cell = activeCellRef.current;
        if (!cell) { editSession.commit(); gridRef.current?.focus({ preventScroll: true }); return; }
        const field = COL_MAP[cell.col];
        if (field) {
            const snapshot = editSession.preEditValueRef.current ?? '';
            setRows((prev) => {
                const next = [...prev];
                const row = { ...next[cell.row] };
                (row as Record<string, unknown>)[field] = snapshot;
                if (row._state === 'modified' && row.id) row._state = 'existing';
                next[cell.row] = row;
                return next;
            });
        }
        editSession.commit();
        gridRef.current?.focus({ preventScroll: true });
    }, [editSession]);

    // ─── Grid navigation (shared Blackwood Table primitives) ───────────────────────
    // Coordinate resolver wrapped to preserve two ledger-specific behaviors the base
    // factory doesn't express:
    //   • ArrowLeft clamps to col 1 (col 0 is the row# column) — base would land on col 0.
    //   • isEditable excludes dropdown + date columns (the old `isTypable` gate) so the
    //     hook only triggers inline editing on the typable text/numeric/CCC-FLEC cells.
    // Home/End (also ledger-only) aren't NavMoves, so they're intercepted in the
    // container handler below.
    const baseResolver = React.useMemo(
        () => createCoordinateNavResolver({ rowCount: rows.length, columnMap: COL_MAP }),
        [rows.length],
    );
    const resolver = React.useMemo<NavResolver<CoordinateId>>(() => ({
        ...baseResolver,
        resolve(from, move) {
            const next = baseResolver.resolve(from, move);
            if (next && move.kind === 'arrow' && move.dir === 'left' && next.col < 1) {
                return { row: next.row, col: 1 };
            }
            return next;
        },
        isEditable(id) {
            const field = COL_MAP[id.col];
            return !!field && !DROPDOWN_FIELDS.has(field) && field !== 'recv_date' && field !== 'prod_date';
        },
    }), [baseResolver]);

    const isRangeSelected = cellSelection.getSelectionSize() > 1;

    const rangeSlot = React.useMemo<GridRangeSlot>(() => ({
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
    }), [isRangeSelected, cellSelection, activeCell, handleCopyKeyDown, handleDeleteKeyDown]);

    const { handleKeyDown: handleNavKeyDown } = useGridKeyboardNav<CoordinateId>({
        activeCell,
        setActiveCell,
        isEditing,
        resolver,
        edit: {
            start: (id, char) => startEditing(id.row, id.col, char),
            revert: revertChanges,
            commit: () => { editSession.commit(); gridRef.current?.focus({ preventScroll: true }); },
        },
        range: rangeSlot,
        // The ledger's moveActive used plain Enter → straight down (no Tab-then-Enter
        // "return to lane"). Keep that exact behavior.
        enableEnterAnchor: false,
    });

    // Container key handler — intercept Home/End (jump to first/last editable column in
    // the row), which aren't NavMoves the shared hook routes; everything else delegates.
    const handleGridKeyDown = React.useCallback((e: React.KeyboardEvent) => {
        if (!activeCell) { handleNavKeyDown(e); return; }
        if (!isEditing && (e.key === 'Home' || e.key === 'End')) {
            e.preventDefault();
            const col = e.key === 'Home' ? 1 : COL_COUNT - 1;
            setActiveCell({ row: activeCell.row, col });
            return;
        }
        handleNavKeyDown(e);
    }, [activeCell, isEditing, handleNavKeyDown]);

    // ─── Paste (Excel TSV → grid, starting at the active cell) ─────────────────────
    const handleSmartPaste = React.useCallback(
        (e: React.ClipboardEvent, startRow: number, startCol: number) => {
            e.preventDefault();
            const text = e.clipboardData.getData('text');
            if (!text) return;
            const pastedRows = text.split(/\r\n|\n|\r/).filter((r) => r.trim() !== '');
            if (!pastedRows.length) return;
            setRows((prev) => {
                const next = [...prev];
                pastedRows.forEach((pastedRow, rOffset) => {
                    const targetRow = startRow + rOffset;
                    if (targetRow >= next.length) next.push(createEmptyRow());
                    const cols = pastedRow.split('\t');
                    cols.forEach((cellVal, cOffset) => {
                        const targetCol = startCol + cOffset;
                        if (targetCol >= COL_COUNT) return;
                        const field = COL_MAP[targetCol];
                        if (!field) return;
                        const row = { ...next[targetRow] };
                        // CCC/FLEC pastes as raw text (parsed to the two DB fields at
                        // save) — no cross-field re-derive needed on paste anymore.
                        (row as Record<string, unknown>)[field] = cleanPasteValue(cellVal, field);
                        if (row._state === 'existing') row._state = 'modified';
                        next[targetRow] = row;
                    });
                });
                return next;
            });
            toast.success(`Pasted ${pastedRows.length} row${pastedRows.length !== 1 ? 's' : ''}`);
        },
        [],
    );

    const handleGridPaste = React.useCallback(
        (e: React.ClipboardEvent) => {
            if (!isEditing && activeCell) {
                handleSmartPaste(e, activeCell.row, activeCell.col);
                cellSelection.clearSelection();
            }
        },
        [isEditing, activeCell, handleSmartPaste, cellSelection],
    );

    // ─── Dirty state ───────────────────────────────────────────────────────────────
    const isDirty = rows.some((r) => {
        if (r._state === 'deleted' || r._state === 'modified') return true;
        if (r._state === 'new' && isMeaningfulNewRow(r)) return true;
        return false;
    });

    // The Daily Block (W6/W7 focus pivot) owns its OWN unsaved-edit state in its inner
    // toolbar. Lift its dirty signal so the axis controls below GUARD a view/scope/period
    // switch that would silently discard those pivot edits (the audit's severe finding).
    const [dailyDirty, setDailyDirty] = React.useState(false);
    const guardDirty = isDirty || dailyDirty;
    const guardHint = 'Save or discard your edits before switching';

    const handleDiscard = React.useCallback(() => {
        setRows(buildGridRows(initialRows, dateSortKey, dateSortDir));
        setActiveCell(null);
        setIsEditing(false);
        cellSelection.clearSelection();
    }, [initialRows, dateSortKey, dateSortDir, cellSelection]);

    // ─── Save ──────────────────────────────────────────────────────────────────────
    const handleSave = async () => {
        // Parse the single CCC/FLEC cell into the two normalized DB fields up front. A
        // single typed cell can't produce an inconsistent (disposition, equipment) pair,
        // so the only failure mode is an UNRECOGNIZED value — surface that BEFORE the
        // round-trip as a clear, persistent, copyable message (HARD RULE) instead of a
        // cryptic Postgres FK/CHECK error. Empty CCC/FLEC passes through (same as before).
        const dirtyRows: ProductionEventDirtyRow[] = [];
        const deletedIds: string[] = [];
        const invalid: string[] = [];

        for (const r of rows) {
            if (r._state === 'deleted') {
                if (r.id) deletedIds.push(r.id);
                continue;
            }
            if (r._state === 'new' && !isMeaningfulNewRow(r)) continue;
            if (r._state === 'existing') continue; // untouched

            // Derive disposition + equipment from the merged CCC/FLEC cell.
            let disposition = '';
            let equipment = '';
            const raw = r.ccc_flec.trim();
            if (raw) {
                const res = parseCccFlec(raw);
                if (res) {
                    disposition = res.disposition_kind;
                    equipment = res.partner_equipment_code ?? '';
                } else {
                    const which = r.batch ? `batch ${r.batch}` : `${r.recv_date || 'undated'} row`;
                    invalid.push(`${which}: CCC/FLEC "${raw}"`);
                    continue;
                }
            }

            dirtyRows.push({
                id: r.id || undefined,
                recv_date: r.recv_date,
                prod_date: r.prod_date,
                batch: r.batch,
                shift_code: r.shift_code,
                grade_code: r.grade_code,
                plant_code: r.plant_code,
                warehouse_code: r.warehouse_code,
                source_location_code: r.source_location_code,
                weight_kg: r.weight_kg,
                disposition_kind: disposition,
                partner_equipment_code: equipment,
                flec_count: r.flec_count,
                whse_side: r.whse_side,
            });
        }

        if (invalid.length > 0) {
            errorToast(
                `${invalid.length} row${invalid.length !== 1 ? 's' : ''} have an unrecognized CCC/FLEC value.`,
                {
                    description:
                        'The CCC/FLEC column must be FLEC (for bagging) or an equipment code — C1–C4 (crusher) or RK1–RK4 (kiln). Fix these, then Save again:\n\n' +
                        invalid.join('\n'),
                },
            );
            return;
        }

        if (dirtyRows.length === 0 && deletedIds.length === 0) {
            toast.info('No changes to save.');
            return;
        }

        setIsSaving(true);
        try {
            const res = await saveProductionEvents(dirtyRows, deletedIds);
            if (!res.ok) {
                errorToast(res.error ?? 'Failed to save production events.');
            } else {
                const parts: string[] = [];
                if (res.upserted) parts.push(`${res.upserted} saved`);
                if (res.deleted) parts.push(`${res.deleted} deleted`);
                toast.success(`Saved — ${parts.join(', ') || 'no changes'}`);
                onSaveSuccess();
            }
        } catch (err) {
            errorToast('Unexpected error: ' + (err instanceof Error ? err.message : String(err)));
        } finally {
            setIsSaving(false);
        }
    };

    // ─── Row context menu (stable — passed to the memoized row) ────────────────────
    // Lifted out of the inline row JSX so each ProductionRow gets a referentially
    // stable handler (memo-friendly). Positions the menu, clamping to the viewport.
    const onRowContextMenu = React.useCallback((rowIdx: number, e: React.MouseEvent) => {
        e.preventDefault();
        contextMenu.open(rowIdx, e.clientX, e.clientY);
        setActiveCell({ row: rowIdx, col: 1 });
        setIsEditing(false);
    }, [contextMenu]);

    // ─── Selection range slice (drives per-row memo props) ─────────────────────────
    // The whole grid shares one selection rectangle; we pass each row only the columns
    // of that rectangle (so a row outside the selection sees stable primitives and the
    // memo skips it). `range` is null when nothing is selected.
    const selRange = cellSelection.range;
    const selectionSize = cellSelection.getSelectionSize();

    // ─── Which values are PRESENT in this period's rows ────────────────────────────
    // The option LISTS themselves now come from the canonical `cenapro` lookup constants
    // (see FILTER_SPECS) rather than "whatever this period happens to contain" — a value
    // absent here is DIMMED in the menu, never hidden, so it stays selectable/shareable
    // and the two scopes offer identical choices. This set only drives that dimming (plus
    // discovery of any value the constants don't know about).
    const filterPresence = React.useMemo(
        () =>
            collectFilterPresence(
                rows.filter((r) => r._state !== 'deleted' && !(r._state === 'new' && !isMeaningfulNewRow(r))),
            ),
        [rows],
    );

    // ─── Per-row visibility under active filters (index-preserving HIDE) ───────────
    // UNSAVED WORK IS NEVER HIDDEN. A dirty row — a new draft, an edited row, or one
    // pending deletion — is EXEMPT from every filter and stays in place with an "unsaved"
    // marker. Hiding it would silently bury work the operator can't see or recover, and
    // Focus scope holds the whole period client-side, so keeping it costs nothing.
    const isRowExemptFromFilters = React.useCallback(
        (row: GridRow) => row._state === 'new' || row._state === 'modified' || row._state === 'deleted',
        [],
    );

    const isRowHidden = React.useCallback(
        (row: GridRow): boolean => {
            if (isRowExemptFromFilters(row)) return false;
            return !matchesLedgerFilters(row, filters);
        },
        [filters, isRowExemptFromFilters],
    );

    // Dirty rows kept visible IN SPITE of the filters — surfaced in the toolbar so the
    // exemption is stated, not just silently done.
    const exemptVisibleCount = React.useMemo(
        () =>
            anyFilterActive
                ? rows.filter(
                      (r) =>
                          isRowExemptFromFilters(r) &&
                          !(r._state === 'new' && !isMeaningfulNewRow(r)) &&
                          !matchesLedgerFilters(r, filters),
                  ).length
                : 0,
        [rows, anyFilterActive, filters, isRowExemptFromFilters],
    );

    const activeFilterDescription = React.useMemo(() => describeActiveFilters(filters), [filters]);

    // ─── Date sort header click (CHANGE 2: sort by EITHER recv or prod date) ────────
    // Clicking the active date key toggles asc/desc; clicking the other date header
    // switches the sort key to it (defaulting to descending — newest-first — like the
    // original recv default). The re-sort effect above reacts to key/dir changes.
    // NOTE: keep these setState calls flat — do NOT nest setDateSortDir inside a
    // setDateSortKey updater. React Strict Mode (dev) double-invokes updater fns, and a
    // nested flip would run twice → cancel out (the "clicking doesn't flip" bug).
    const handleDateSort = React.useCallback((key: DateSortKey) => {
        if (key === dateSortKey) {
            // Same column → flip direction (pure updater is double-invoke-safe).
            setDateSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
        } else {
            // New column → switch key, default to descending (newest-first).
            setDateSortKey(key);
            setDateSortDir('desc');
        }
    }, [dateSortKey]);

    // ─── Counts ────────────────────────────────────────────────────────────────────
    const savedRowCount = rows.filter((r) => r._state !== 'new' && r._state !== 'deleted').length;
    const dirtyCount = rows.filter(
        (r) => r._state === 'modified' || r._state === 'deleted' || (r._state === 'new' && isMeaningfulNewRow(r)),
    ).length;
    const visibleCount = rows.filter((r) => !isRowHidden(r) && !(r._state === 'new' && !isMeaningfulNewRow(r))).length;
    const allHiddenByFilter = anyFilterActive && visibleCount === 0;

    // ─── Mobile read layer (sm:hidden) — the SAME rows the desktop table renders,
    // minus deleted / empty-new / filter-hidden rows (single source of truth, no
    // refetch). Fed to CenaproLedgerCardsMobile (Archetype C card list). ────────────
    const mobileRows = React.useMemo(
        () =>
            rows.filter(
                (r) =>
                    r._state !== 'deleted' &&
                    !(r._state === 'new' && !isMeaningfulNewRow(r)) &&
                    !isRowHidden(r),
            ),
        [rows, isRowHidden],
    );

    // ─── Render ────────────────────────────────────────────────────────────────────
    return (
        <div className="flex h-full flex-col">
            {/* Toolbar */}
            <div className="flex flex-none flex-wrap items-center gap-2 border-b bg-muted/30 px-2 py-1.5 md:px-3">
                <CenaproPeriodPicker
                    periods={periods}
                    selected={selectedPeriod}
                    disabled={guardDirty}
                    disabledHint={guardHint + ' period'}
                />
                <span className="h-4 w-px bg-border/60" />
                {/* View-mode switcher — stays visible in every mode. Guarded while the daily
                    block (or ledger) has unsaved edits (fixes the silent-loss-on-switch bug). */}
                <ViewModeSwitcher mode={viewMode} disabled={guardDirty} disabledHint={guardHint + ' view'} />
                <span className="h-4 w-px bg-border/60" />
                {/* Scope toggle — jump back to the endless sheet; preserves view/period. */}
                <ScopeToggle scope={currentScope} disabled={guardDirty} disabledHint={guardHint + ' scope'} />
                {!isDailyView && (
                    <>
                        <span className="h-4 w-px bg-border/60" />
                        <span className="font-mono text-[11px] text-muted-foreground/70">
                            {anyFilterActive
                                ? `${visibleCount.toLocaleString('en-US')} of ${savedRowCount.toLocaleString('en-US')}`
                                : savedRowCount.toLocaleString('en-US')}{' '}
                            row{savedRowCount !== 1 ? 's' : ''}
                            {dirtyCount > 0 && <span className="ml-1 text-amber-600 dark:text-amber-400">· {dirtyCount} unsaved</span>}
                        </span>
                        {exemptVisibleCount > 0 && (
                            <span
                                className="text-[10px] font-medium text-amber-600 dark:text-amber-400"
                                title="Rows with unsaved changes are never hidden by a filter — they stay in place until you save or discard."
                            >
                                · {exemptVisibleCount} unsaved kept visible
                            </span>
                        )}
                    </>
                )}
                <div className="flex-1" />
                {/* Editable-only controls — hidden in the read-only Daily Block view. */}
                {!isDailyView && (
                    <>
                        {filterUi.isPending && <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />}
                        <FilterSummaryChip count={filterUi.activeCount} onClear={clearFilters} pending={filterUi.isPending} />
                        {anyFilterActive && (
                            <Button variant="ghost" size="sm" className="h-6 px-2 text-[11px]" onClick={clearFilters}>
                                Clear filters
                            </Button>
                        )}
                        <Button
                            variant="outline"
                            size="sm"
                            className="h-6 gap-1 px-2 text-[11px]"
                            onClick={goAddInSheet}
                            disabled={isDirty}
                            title={
                                isDirty
                                    ? 'Save or discard your edits before switching to the sheet'
                                    : 'Add rows in the endless sheet — a loss-proof draft zone (paste from Excel/Sheets)'
                            }
                        >
                            <Sparkles className="h-3 w-3" />
                            Add rows in the sheet →
                        </Button>
                        {isDirty && (
                            <Button variant="ghost" size="sm" className="h-6 gap-1 px-2 text-[11px]" onClick={handleDiscard} disabled={isSaving}>
                                <RotateCcw className="h-3 w-3" />
                                Discard
                            </Button>
                        )}
                        <Button size="sm" className="h-6 gap-1 px-2 text-[11px]" onClick={handleSave} disabled={isSaving || !isDirty}>
                            <Save className="h-3 w-3" />
                            {isSaving ? 'Saving…' : 'Save'}
                        </Button>
                    </>
                )}
            </div>

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
                            void navigator.clipboard.writeText(loadError).then(() => toast.success('Error copied to clipboard', { duration: 2000 }));
                        }}
                    >
                        <Copy className="mr-1 h-3.5 w-3.5" />
                        Copy
                    </Button>
                </div>
            )}

            {/* Daily Block — the PROD-2026 pivot. Consumes the SAME period rows (typed
                event fields) the editable grid holds. Phase 1: equipment/bagging cells are
                editable and round-trip via saveProductionEvents (same write path); on save
                success `onSaveSuccess` → router.refresh remount (the production-view dataKey
                folds in the period + row ids). selectedPeriod supplies batch/batch_year for
                INSERTs. */}
            {plantView && (
                <ProductionDailyBlock
                    rows={initialRows}
                    plantView={plantView}
                    selectedPeriod={selectedPeriod}
                    onSaveSuccess={onSaveSuccess}
                    onDirtyChange={setDailyDirty}
                />
            )}

            {/* Editable Ledger grid + its modals/menus — ledger view only. */}
            {!isDailyView && (
            <>
            {/* Grid */}
            <div
                ref={gridRef}
                className="relative hidden min-h-0 flex-1 select-none overflow-auto outline-none sm:block"
                tabIndex={-1}
                onKeyDown={handleGridKeyDown}
                onPaste={handleGridPaste}
                onBlur={(e) => {
                    if (!e.currentTarget.contains(e.relatedTarget)) {
                        setActiveCell(null);
                        setIsEditing(false);
                    }
                }}
            >
                <table className="relative table-fixed text-xs" style={{ width: '100%', minWidth: '1228px', borderCollapse: 'separate', borderSpacing: 0 }}>
                    {/* col order: # / recv / prod / batch / shift / grade / plant / whse / source / weight / CCC/FLEC / flec / side */}
                    <colgroup>
                        <col style={{ width: '36px' }} />
                        <col style={{ width: '96px' }} />
                        <col style={{ width: '96px' }} />
                        <col style={{ width: '120px' }} />
                        <col style={{ width: '64px' }} />
                        <col style={{ width: '80px' }} />
                        <col style={{ width: '84px' }} />
                        <col style={{ width: '108px' }} />
                        <col style={{ width: '84px' }} />
                        <col style={{ width: '104px' }} />
                        <col style={{ width: '112px' }} />
                        <col style={{ width: '72px' }} />
                        <col style={{ width: '72px' }} />
                    </colgroup>
                    {/* CANONICAL frozen-pane header — see globals.css "Frozen Panes".
                        The header row is sticky-top + OPAQUE bg-muted (NO glass/alpha, so
                        body rows can't bleed through the non-frozen header cells on
                        vertical scroll). The 4 frozen identity headers are ALSO sticky-left
                        → top-left CORNERS (.frozen-corner, z-30) that out-rank both the
                        scrolling header row AND the frozen body column; each carries its own
                        solid bg-muted. The last frozen corner (Batch) gets .frozen-edge for
                        the anti-seam right divider. Z-scale: corner 30 > header row 20 >
                        frozen body col 10 > normal scrolling cells. */}
                    <thead className="frozen-row bg-muted">
                        {/* Rule on the CELLS — a <tr> border is inert under
                            `border-collapse: separate` (see the row renderer above). Full
                            weight: this is the header↔body boundary. */}
                        <tr className="[&>*]:border-b [&>*]:border-b-border">
                            <th className="frozen-corner h-8 border-r border-border/40 bg-muted px-1 text-center font-mono text-[10px] font-bold text-muted-foreground" style={{ left: 0 }}>#</th>
                            <th className="frozen-corner h-8 bg-muted px-2 text-left text-muted-foreground" style={{ left: 36 }}>
                                <DateSortHeader label="Recv" sortKey="recv_date" activeKey={dateSortKey} dir={dateSortDir} onSort={handleDateSort} />
                            </th>
                            <th className="frozen-corner h-8 bg-muted px-2 text-left text-muted-foreground" style={{ left: 132 }}>
                                <DateSortHeader label="Prod" sortKey="prod_date" activeKey={dateSortKey} dir={dateSortDir} onSort={handleDateSort} />
                            </th>
                            <th className="frozen-corner frozen-edge h-8 bg-muted px-2 text-left text-[11px] font-bold uppercase tracking-wide text-muted-foreground" style={{ left: 228 }}>Batch</th>
                            <th className="h-8 px-2 text-left text-[11px] font-bold uppercase tracking-wide text-muted-foreground">
                                <HeaderFilter column="shift" selected={filters.shift} presence={filterPresence.shift} onChange={(v) => setFilterColumn('shift', v)} />
                            </th>
                            <th className="h-8 px-2 text-left text-[11px] font-bold uppercase tracking-wide text-muted-foreground">
                                <HeaderFilter column="grade" selected={filters.grade} presence={filterPresence.grade} onChange={(v) => setFilterColumn('grade', v)} />
                            </th>
                            <th className="h-8 px-2 text-left text-[11px] font-bold uppercase tracking-wide text-muted-foreground">
                                <HeaderFilter column="plant" selected={filters.plant} presence={filterPresence.plant} onChange={(v) => setFilterColumn('plant', v)} />
                            </th>
                            <th className="h-8 px-2 text-left text-[11px] font-bold uppercase tracking-wide text-muted-foreground">
                                <HeaderFilter column="whse" selected={filters.whse} presence={filterPresence.whse} onChange={(v) => setFilterColumn('whse', v)} />
                            </th>
                            <th className="h-8 px-2 text-left text-[11px] font-bold uppercase tracking-wide text-muted-foreground">
                                <HeaderFilter column="source" selected={filters.source} presence={filterPresence.source} onChange={(v) => setFilterColumn('source', v)} />
                            </th>
                            <th className="h-8 px-2 text-right text-[11px] font-bold uppercase tracking-wide text-muted-foreground">Weight</th>
                            <th className="h-8 px-2 text-left text-[11px] font-bold uppercase tracking-wide text-muted-foreground">
                                <HeaderFilter column="ccc" selected={filters.ccc} presence={filterPresence.ccc} onChange={(v) => setFilterColumn('ccc', v)} align="end" />
                            </th>
                            <th className="h-8 px-2 text-right text-[11px] font-bold uppercase tracking-wide text-muted-foreground">Flec</th>
                            <th className="h-8 px-2 text-left text-[11px] font-bold uppercase tracking-wide text-muted-foreground">Side</th>
                        </tr>
                    </thead>
                    <tbody>
                        {/* Empty state — the selected period has zero data rows. Bulk entry
                            now lives in the endless sheet's loss-proof draft zone; per-row
                            adds still work via right-click Insert. */}
                        {rows.length === 0 && (
                            <tr>
                                <td colSpan={COL_COUNT} className="py-10 text-center">
                                    <div className="flex flex-col items-center justify-center gap-2 text-center">
                                        <Inbox className="h-8 w-8 text-muted-foreground/30" />
                                        <p className="text-sm text-muted-foreground">
                                            No production events in this period. Use <span className="font-medium">Add rows in the sheet</span> for fast multi-row entry, or right-click a row to insert.
                                        </p>
                                        <Button
                                            variant="outline"
                                            size="sm"
                                            className="h-6 gap-1 px-2 text-[11px]"
                                            onClick={goAddInSheet}
                                            disabled={isDirty}
                                            title={isDirty ? 'Save or discard your edits first' : undefined}
                                        >
                                            <Sparkles className="h-3 w-3" />
                                            Add rows in the sheet →
                                        </Button>
                                    </div>
                                </td>
                            </tr>
                        )}

                        {/* All rows hidden by filter — name WHICH filters are responsible. */}
                        {allHiddenByFilter && (
                            <tr>
                                <td colSpan={COL_COUNT} className="py-10 text-center">
                                    <FilteredEmptyState active={activeFilterDescription} onClear={clearFilters} />
                                </td>
                            </tr>
                        )}

                        {rows.map((row, rowIdx) => {
                            // Slice the global active/selection state down to THIS row so
                            // the memoized ProductionRow only re-renders when its own cells
                            // change. All props below are primitives (or stable callbacks).
                            const activeColInRow =
                                activeCell?.row === rowIdx ? activeCell.col : -1;
                            const rowInRange =
                                !!selRange && rowIdx >= selRange.startRow && rowIdx <= selRange.endRow;
                            // Anchor col within this row (−1 if the anchor is elsewhere). The
                            // hook exposes isAnchor(r,c); scan the row's selectable cols for it
                            // (cheap — ≤13 cols), only when a selection exists.
                            let anchorCol = -1;
                            if (selRange) {
                                for (let c = 1; c < COL_COUNT; c++) {
                                    if (cellSelection.isAnchor(rowIdx, c)) {
                                        anchorCol = c;
                                        break;
                                    }
                                }
                            }

                            return (
                                <ProductionRow
                                    key={row.id || `new-${rowIdx}`}
                                    row={row}
                                    rowIdx={rowIdx}
                                    rowHidden={isRowHidden(row)}
                                    contextMenuActive={contextMenu.state?.ref === rowIdx}
                                    activeColInRow={activeColInRow}
                                    isEditing={isEditing && activeColInRow >= 0}
                                    rowInRange={rowInRange}
                                    // Pass the range's col-span only for in-range rows so a
                                    // row OUTSIDE the selection keeps stable (−1) props as the
                                    // selection grows → memo skips it. selectionSize is global
                                    // but only affects the active-ring branch (size ≤ 1), so a
                                    // row not in range and not active won't visibly change.
                                    selStartCol={rowInRange && selRange ? selRange.startCol : -1}
                                    selEndCol={rowInRange && selRange ? selRange.endCol : -1}
                                    anchorColInRow={anchorCol}
                                    isDragActive={cellSelection.isDragging}
                                    selectionSize={activeColInRow >= 0 ? selectionSize : 0}
                                    updateRow={updateRow}
                                    handleSmartPaste={handleSmartPaste}
                                    handleCellMouseDown={handleCellMouseDown}
                                    handleCellMouseUp={handleCellMouseUp}
                                    handleCellMouseEnter={handleCellMouseEnter}
                                    startEditing={startEditing}
                                    revertChanges={revertChanges}
                                    setActiveCell={setActiveCell}
                                    setIsEditing={setIsEditing}
                                    onRowContextMenu={onRowContextMenu}
                                    gridRef={gridRef}
                                />
                            );
                        })}
                    </tbody>
                </table>
            </div>

            {/* Mobile read layer — phone card list (Archetype C). Fed the SAME
                sorted/filtered rows the desktop table renders (single source of
                truth). Read-only: no inline edit / Bulk Add / paste on touch. */}
            <div className="min-h-0 flex-1 sm:hidden">
                <CenaproLedgerCardsMobile
                    rows={mobileRows}
                    savedRowCount={savedRowCount}
                    filters={filters}
                    presence={filterPresence}
                    activeFilterCount={filterUi.activeCount}
                    setFilterColumn={setFilterColumn}
                    clearFilters={clearFilters}
                />
            </div>

            {/* Right-click context menu */}
            <GridContextMenu<number>
                state={contextMenu.state}
                onClose={contextMenu.close}
                items={ROW_MENU_ITEMS}
            />

            {/* CCC/FLEC typeahead — the single merged cell references this via `list=` so
                the operator can paste FLEC/C1/RK3 freely OR pick a suggestion. */}
            <datalist id="ledger-ccc-flec-suggestions">
                {CCC_FLEC_OPTIONS.map((o) => <option key={o} value={o} />)}
            </datalist>

            </>
            )}
        </div>
    );
}
