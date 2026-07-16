'use client';

import * as React from 'react';
import { toast } from 'sonner';
import { Plus, Sparkles } from 'lucide-react';
import { errorToast } from '@/lib/toast';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
} from '@/components/ui/dialog';
import { normalizeTypedDate } from '@/lib/paste-utils';
import { GridCell } from '@/components/shared/grid/GridCell';
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
import { saveProductionEvents, type ProductionEventDirtyRow } from './actions';
import {
    SHIFT_CODES,
    GRADE_CODES,
    PLANT_CODES,
    WAREHOUSE_CODES,
    SOURCE_LOCATION_CODES,
    CCC_FLEC_OPTIONS,
    WHSE_SIDES,
} from '../types';
import {
    BULK_COLUMN_MAP,
    BULK_COL_COUNT,
    createEmptyRow,
    cleanBulkPasteValue,
    isBlankRow,
    mapBulkRowToDirty,
    rowLabel,
    type BulkRow,
    type BulkField,
} from './bulk-paste-utils';

// Number of empty rows the grid opens with — a fresh Excel-sheet feel. Paste taller
// than this auto-extends; the operator can also click "Add Row" for more.
const INITIAL_ROW_COUNT = 8;

// Shared dense input styling — identical to the RC IN bulk grid + the inline ledger.
const inputClass =
    'h-8 w-full px-1 border-transparent bg-transparent rounded-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-primary focus-visible:bg-accent/10 transition-colors shadow-none';

// ─── Props ───────────────────────────────────────────────────────────────────────
interface BulkAddModalProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    /** Called after a successful insert so the parent can refresh the inline grid. */
    onInserted: () => void;
    /**
     * Year to inject when a typed date omits one (Excel-style "6/2" → "{year}-06-02").
     * Threaded from the selected ledger period; falls back to the current year.
     */
    defaultYear?: number;
}

// The two date fields — typed shorthand in these cells auto-transcribes to yyyy-MM-dd
// on commit (Tab/Enter or blur). Used by both commit paths below.
const DATE_BULK_FIELDS = new Set<BulkField>(['recv_date', 'prod_date']);

// ─── Component ───────────────────────────────────────────────────────────────────
export function BulkAddModal({ open, onOpenChange, onInserted, defaultYear }: BulkAddModalProps) {
    const gridRef = React.useRef<HTMLDivElement>(null);
    const yr = defaultYear ?? new Date().getFullYear();

    // Preset with INITIAL_ROW_COUNT blank rows so the grid feels like a fresh sheet.
    const [rows, setRows] = React.useState<BulkRow[]>(() =>
        Array.from({ length: INITIAL_ROW_COUNT }, createEmptyRow),
    );

    const [isSaving, setIsSaving] = React.useState(false);
    const [activeCell, setActiveCell] = React.useState<CoordinateId | null>(null);

    // Stable indirection so the mouse handlers can end an active edit without a forward
    // reference to the edit session (created later, after updateRow). Mirrors RC IN.
    const endEditRef = React.useRef<() => void>(() => {});

    // Reset the grid to a fresh 8-row sheet whenever the modal re-opens.
    React.useEffect(() => {
        if (open) {
            setRows(Array.from({ length: INITIAL_ROW_COUNT }, createEmptyRow));
            setActiveCell(null);
            endEditRef.current();
        }
    }, [open]);

    // ─── Cell range selection (every column except row# is selectable) ─────────────
    const isSelectableColumn = React.useCallback((c: number) => c !== 0 && BULK_COLUMN_MAP[c] !== null, []);
    const cellSelection = useCellSelection({
        rowCount: rows.length,
        colCount: BULK_COL_COUNT,
        isSelectableColumn,
        scrollContainerRef: gridRef,
        enabled: open,
    });

    const getCellValue = React.useCallback(
        (rowIdx: number, colIdx: number): string => {
            const row = rows[rowIdx];
            if (!row) return '';
            const field = BULK_COLUMN_MAP[colIdx];
            if (!field) return '';
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
                endEditRef.current(); // commit any open edit (a fresh click ends any Tab run)
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

    // ─── Row mutation ──────────────────────────────────────────────────────────────
    const addRow = React.useCallback(() => {
        setRows((prev) => [...prev, createEmptyRow()]);
    }, []);

    const removeRow = React.useCallback((index: number) => {
        setRows((prev) => (prev.length > 1 ? prev.filter((_, i) => i !== index) : [createEmptyRow()]));
    }, []);

    const updateRow = React.useCallback((index: number, field: BulkField, value: string) => {
        setRows((prev) => {
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

    // ─── Typed-date auto-transcription (Excel-style commit normalization) ──────────
    // On cell COMMIT (Tab/Enter via the grid, or blur via the input), normalize a typed
    // shorthand date like "6/2" → "2026-06-02". Reads the row via functional setState so
    // it always sees the latest typed value, and only writes when it actually changes
    // (no-op for already-canonical values → no flicker / re-render storm).
    const commitDateCell = React.useCallback(
        (rowIdx: number, field: BulkField) => {
            setRows((prev) => {
                const raw = prev[rowIdx]?.[field];
                if (raw == null) return prev;
                const norm = normalizeTypedDate(raw, yr);
                if (norm === raw) return prev;
                const next = [...prev];
                next[rowIdx] = { ...next[rowIdx], [field]: norm };
                return next;
            });
        },
        [yr],
    );

    // Normalize the active cell if it's a date column — called on Tab/Enter commit.
    const commitActiveDateCell = React.useCallback(() => {
        if (!activeCell) return;
        const field = BULK_COLUMN_MAP[activeCell.col];
        if (field && DATE_BULK_FIELDS.has(field)) commitDateCell(activeCell.row, field);
    }, [activeCell, commitDateCell]);

    const { handleKeyDown: handleDeleteKeyDown } = useCellDelete({
        getSelectedRange: cellSelection.getSelectedRange,
        getSelectionSize: cellSelection.getSelectionSize,
        clearCell,
    });

    // ─── Edit session (shared Blackwood Table primitive) ───────────────────────────
    // Owns isEditing + the pre-edit snapshot + start/revert/commit. onAfterCommit runs
    // the Excel-style typed-date normalization that previously fired before leaving edit
    // state on Tab/Enter — the merged date cell ("6/2" → yyyy-MM-dd) on commit.
    const setCellValue = React.useCallback((id: CoordinateId, value: string) => {
        const field = BULK_COLUMN_MAP[id.col];
        if (field) updateRow(id.row, field, value);
    }, [updateRow]);

    const editSession = useGridEditSession<CoordinateId>({
        getValue: (id) => getCellValue(id.row, id.col),
        setValue: setCellValue,
        onAfterCommit: commitActiveDateCell,
    });
    const isEditing = editSession.isEditing;
    const setIsEditing = React.useCallback((editing: boolean) => {
        if (!editing) editSession.commit();
    }, [editSession]);
    endEditRef.current = () => { if (editSession.isEditing) editSession.commit(); };

    // GridCell-compatible adapters (GridCell calls onStartEditing(row,col,char?)).
    const startEditing = React.useCallback((rowIdx: number, colIdx: number, initialChar?: string) => {
        if (BULK_COLUMN_MAP[colIdx] == null) return;
        setActiveCell({ row: rowIdx, col: colIdx });
        editSession.startEditing({ row: rowIdx, col: colIdx }, initialChar);
    }, [editSession]);

    const revertChanges = React.useCallback(() => {
        editSession.revertChanges();
        gridRef.current?.focus();
    }, [editSession]);

    // ─── Grid navigation (shared Blackwood Table primitives) ───────────────────────
    // Coordinate resolver, wrapped to preserve two bulk-add-specific behaviors the base
    // factory doesn't express:
    //   • ArrowLeft clamps to col 1 (col 0 is the row#/trash column, never selectable) —
    //     the base factory's Math.max(0, …) would land on col 0.
    // Home/End (also bulk-add-only) aren't NavMoves, so they're intercepted in the
    // container handler below before delegating to the shared hook.
    const baseResolver = React.useMemo(
        () => createCoordinateNavResolver({ rowCount: rows.length, columnMap: BULK_COLUMN_MAP }),
        [rows.length],
    );
    const resolver = React.useMemo<NavResolver<CoordinateId>>(() => ({
        ...baseResolver,
        resolve(from, move) {
            const next = baseResolver.resolve(from, move);
            // ArrowLeft must clamp to col 1, not col 0 (the row# column).
            if (next && move.kind === 'arrow' && move.dir === 'left' && next.col < 1) {
                return { row: next.row, col: 1 };
            }
            return next;
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
            commit: () => { editSession.commit(); gridRef.current?.focus(); },
        },
        range: rangeSlot,
        // Excel-style "Enter after a Tab run returns to the run's lane" — the numeric
        // enterAnchorColRef behavior this modal had is now provided by the shared hook.
        enableEnterAnchor: true,
    });

    // Container key handler — intercept Home/End (move to first/last editable column in
    // the row), which aren't NavMoves the shared hook routes; everything else delegates.
    const handleGridKeyDown = React.useCallback((e: React.KeyboardEvent) => {
        if (!activeCell) { handleNavKeyDown(e); return; }
        // Home/End (bulk-add only) jump to the first/last editable column in the row,
        // without touching the range selection — exactly as the old moveActive did. They
        // aren't NavMoves the shared hook routes, so handle them here when not editing.
        if (!isEditing && (e.key === 'Home' || e.key === 'End')) {
            e.preventDefault();
            const col = e.key === 'Home' ? 1 : BULK_COL_COUNT - 1;
            setActiveCell({ row: activeCell.row, col });
            return;
        }
        handleNavKeyDown(e);
    }, [activeCell, isEditing, handleNavKeyDown]);

    // ─── Paste engine (shared smart-paste primitive — Excel/Sheets TSV → grid) ─────
    const { handleSmartPaste, handleGridPaste: handleGridPasteAt } = useGridPaste<BulkRow>({
        columnMap: BULK_COLUMN_MAP,
        setRows,
        createEmptyRow,
        cleanCellValue: cleanBulkPasteValue,
    });

    // Grid-level paste (selection mode, not mid-edit).
    const handleGridPaste = React.useCallback((e: React.ClipboardEvent) => {
        if (!isEditing) {
            handleGridPasteAt(e, activeCell, () => cellSelection.clearSelection());
        }
    }, [isEditing, activeCell, handleGridPasteAt, cellSelection]);

    // ─── Save ──────────────────────────────────────────────────────────────────────
    const filledRowCount = rows.filter((r) => !isBlankRow(r)).length;

    const handleSave = async () => {
        // 1. Drop fully-blank rows.
        const filled = rows.filter((r) => !isBlankRow(r));
        if (filled.length === 0) {
            toast.warning('Nothing to add — fill in at least one row.');
            return;
        }

        // 2. Validate + canonicalize every filled row, aggregating problems per row so
        //    the operator gets ONE persistent, copyable message naming the offending
        //    rows — never a cryptic Postgres FK/CHECK error.
        const dirtyRows: ProductionEventDirtyRow[] = [];
        const rowErrors: string[] = [];
        // Index against the original array so error labels match the on-screen row#.
        rows.forEach((r, idx) => {
            if (isBlankRow(r)) return;
            const { row, errors } = mapBulkRowToDirty(r, yr);
            if (errors.length > 0) {
                rowErrors.push(`${rowLabel(r, idx)}: ${errors.join('; ')}`);
            } else if (row) {
                dirtyRows.push(row);
            }
        });

        if (rowErrors.length > 0) {
            errorToast(
                `${rowErrors.length} row${rowErrors.length !== 1 ? 's' : ''} can't be added yet.`,
                {
                    description:
                        'Fix the values below, then Save again. Categoricals must match the lookup codes ' +
                        '(e.g. shift M/E/N, grade 3X50/2X6/3.5/4X8, warehouse WHSE 1/2/3/5/7). Crusher/Kiln rows ' +
                        'need an equipment code (C1–C4 / RK1–RK4).\n\n' +
                        rowErrors.join('\n'),
                },
            );
            return;
        }

        // 3. INSERT via the existing write path — no deletes (`[]`). The action coerces
        //    strings→number/date, strips empties→null, and NEVER sends unique_tag/
        //    batch_year (the DB trigger computes them).
        setIsSaving(true);
        try {
            const res = await saveProductionEvents(dirtyRows, []);
            if (!res.ok) {
                errorToast(res.error ?? 'Failed to add production rows.');
                return;
            }
            const n = res.upserted ?? dirtyRows.length;
            toast.success(`Added ${n} production row${n !== 1 ? 's' : ''}`);
            onOpenChange(false);
            onInserted();
        } catch (err) {
            errorToast('Unexpected error: ' + (err instanceof Error ? err.message : String(err)));
        } finally {
            setIsSaving(false);
        }
    };

    // ─── Cell helper props ─────────────────────────────────────────────────────────
    const selProps = (rowIdx: number, colIdx: number) => ({
        onCellMouseDown: (e: React.MouseEvent) => handleCellMouseDown(rowIdx, colIdx, e),
        onCellMouseUp: () => handleCellMouseUp(rowIdx, colIdx),
        onCellMouseEnter: () => handleCellMouseEnter(rowIdx, colIdx),
        isCellRangeSelected: cellSelection.isSelected(rowIdx, colIdx),
        isCellRangeAnchor: cellSelection.isAnchor(rowIdx, colIdx),
        isDragActive: cellSelection.isDragging,
    });

    const commonCellProps = {
        activeCell,
        isEditing,
        setActiveCell,
        setIsEditing,
        onStartEditing: startEditing,
        onRevert: revertChanges,
        gridRef,
    };

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent
                className="flex max-h-[88dvh] w-full flex-col gap-4 sm:max-w-[min(96vw,1180px)]"
                onOpenAutoFocus={(e) => e.preventDefault()}
            >
                <DialogHeader>
                    <DialogTitle className="flex items-center gap-2">
                        <Sparkles className="h-4 w-4 text-primary" />
                        Bulk Add Production Rows
                    </DialogTitle>
                    <DialogDescription>
                        Paste straight from Excel or Google Sheets — the grid fills from the active cell and grows to fit.
                        Columns: Recv · Prod · Batch · Shift · Grade · Plant · Whse · Source · Weight · CCC/FLEC · Flec · Side.
                    </DialogDescription>
                </DialogHeader>

                {/* Grid */}
                <div
                    ref={gridRef}
                    className="relative min-h-0 flex-1 select-none overflow-auto rounded-md border outline-none"
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
                    <table
                        className="relative table-fixed text-xs"
                        style={{ width: '100%', minWidth: '1000px', borderCollapse: 'separate', borderSpacing: 0 }}
                    >
                        {/* col order: # / recv / prod / batch / shift / grade / plant / whse / source / weight / CCC/FLEC / flec / side */}
                        <colgroup>
                            <col style={{ width: '32px' }} />
                            <col style={{ width: '104px' }} />
                            <col style={{ width: '104px' }} />
                            <col style={{ width: '128px' }} />
                            <col style={{ width: '64px' }} />
                            <col style={{ width: '76px' }} />
                            <col style={{ width: '80px' }} />
                            <col style={{ width: '92px' }} />
                            <col style={{ width: '84px' }} />
                            <col style={{ width: '92px' }} />
                            <col style={{ width: '92px' }} />
                            <col style={{ width: '64px' }} />
                            <col style={{ width: '60px' }} />
                        </colgroup>
                        <thead className="sticky top-0 z-20 bg-muted/90 backdrop-blur-sm">
                            <tr className="border-b">
                                <th className="h-8 border-r border-border/40 px-1 text-center font-mono text-[10px] font-bold text-muted-foreground">#</th>
                                <th className="h-8 px-2 text-left text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Recv</th>
                                <th className="h-8 px-2 text-left text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Prod</th>
                                <th className="h-8 px-2 text-left text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Batch</th>
                                <th className="h-8 px-2 text-left text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Shift</th>
                                <th className="h-8 px-2 text-left text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Grade</th>
                                <th className="h-8 px-2 text-left text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Plant</th>
                                <th className="h-8 px-2 text-left text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Whse</th>
                                <th className="h-8 px-2 text-left text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Source</th>
                                <th className="h-8 px-2 text-right text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Weight</th>
                                <th className="h-8 px-2 text-left text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">CCC/FLEC</th>
                                <th className="h-8 px-2 text-right text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Flec</th>
                                <th className="h-8 px-2 text-left text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Side</th>
                            </tr>
                        </thead>
                        <tbody>
                            {rows.map((row, rowIdx) => (
                                <BulkAddRow
                                    key={rowIdx}
                                    row={row}
                                    rowIdx={rowIdx}
                                    updateRow={updateRow}
                                    removeRow={removeRow}
                                    onPaste={handleSmartPaste}
                                    onCommitDate={commitDateCell}
                                    commonCellProps={commonCellProps}
                                    selProps={selProps}
                                />
                            ))}
                        </tbody>
                    </table>
                </div>

                {/* Footer — Add Row + summary + Save (glass dialog footer with own controls) */}
                <div className="flex flex-none items-center justify-between gap-2">
                    <Button variant="outline" size="sm" className="h-7 gap-1 px-2 text-xs" onClick={addRow} disabled={isSaving}>
                        <Plus className="h-3.5 w-3.5" />
                        Add Row
                    </Button>
                    <div className="flex items-center gap-3">
                        <span className="font-mono text-[11px] text-muted-foreground">
                            {filledRowCount} filled · {rows.length} row{rows.length !== 1 ? 's' : ''}
                        </span>
                        <Button size="sm" className="h-7 gap-1 px-3 text-xs" onClick={handleSave} disabled={isSaving || filledRowCount === 0}>
                            {isSaving
                                ? 'Adding…'
                                : filledRowCount > 0
                                    ? `Add ${filledRowCount} ${filledRowCount === 1 ? 'Row' : 'Rows'}`
                                    : 'Add Rows'}
                        </Button>
                    </div>
                </div>

                {/* Typeahead datalists — categorical cells reference these via `list=` so the
                    operator can paste freely OR pick a suggestion (ICTC daily-ledger pattern). */}
                <datalist id="bulk-shift-suggestions">
                    {SHIFT_CODES.map((s) => <option key={s} value={s} />)}
                </datalist>
                <datalist id="bulk-grade-suggestions">
                    {GRADE_CODES.map((g) => <option key={g} value={g} />)}
                </datalist>
                <datalist id="bulk-plant-suggestions">
                    {PLANT_CODES.map((p) => <option key={p} value={p} />)}
                </datalist>
                <datalist id="bulk-warehouse-suggestions">
                    {WAREHOUSE_CODES.map((w) => <option key={w} value={w} />)}
                </datalist>
                <datalist id="bulk-source-suggestions">
                    {SOURCE_LOCATION_CODES.map((s) => <option key={s} value={s} />)}
                </datalist>
                <datalist id="bulk-ccc-flec-suggestions">
                    {CCC_FLEC_OPTIONS.map((d) => <option key={d} value={d} />)}
                </datalist>
                <datalist id="bulk-side-suggestions">
                    {WHSE_SIDES.map((s) => <option key={s} value={s} />)}
                </datalist>
            </DialogContent>
        </Dialog>
    );
}

// ─── Row component ───────────────────────────────────────────────────────────────
// Memoized like RC IN's BulkInputRow. Every cell is a typeable GridCell + <Input>;
// categorical cells add a `list=` datalist so they stay paste-friendly (no strict
// dropdown to fight). Each <Input> stops propagation on paste so the cell's own
// handler runs (not the grid-level one) when pasting mid-edit.
interface BulkAddRowProps {
    row: BulkRow;
    rowIdx: number;
    updateRow: (index: number, field: BulkField, value: string) => void;
    removeRow: (index: number) => void;
    onPaste: (e: React.ClipboardEvent, rowIdx: number, colIdx: number) => void;
    /** Normalize a typed date cell to yyyy-MM-dd on blur (click-away commit). */
    onCommitDate: (rowIdx: number, field: BulkField) => void;
    commonCellProps: {
        activeCell: { row: number; col: number } | null;
        isEditing: boolean;
        setActiveCell: (cell: { row: number; col: number }) => void;
        setIsEditing: (editing: boolean) => void;
        onStartEditing: (row: number, col: number, char?: string) => void;
        onRevert: () => void;
        gridRef: React.RefObject<HTMLDivElement | null>;
    };
    selProps: (rowIdx: number, colIdx: number) => {
        onCellMouseDown: (e: React.MouseEvent) => void;
        onCellMouseUp: () => void;
        onCellMouseEnter: () => void;
        isCellRangeSelected: boolean;
        isCellRangeAnchor: boolean;
        isDragActive: boolean;
    };
}

const BulkAddRow = React.memo(function BulkAddRow({
    row,
    rowIdx,
    updateRow,
    removeRow,
    onPaste,
    onCommitDate,
    commonCellProps,
    selProps,
}: BulkAddRowProps) {
    // A single typeable categorical/text cell with optional datalist typeahead.
    const textCell = (
        col: number,
        field: BulkField,
        opts?: { list?: string; upper?: boolean; align?: 'left' | 'center' | 'right'; placeholder?: string },
    ) => {
        const align = opts?.align ?? 'center';
        const justify = align === 'left' ? 'justify-start' : align === 'right' ? 'justify-end' : 'justify-center';
        const textAlign = align === 'left' ? 'text-left' : align === 'right' ? 'text-right' : 'text-center';
        return (
            <GridCell
                col={col}
                row={rowIdx}
                value={row[field]}
                className={cn('font-mono text-xs', justify, align === 'left' && 'px-1')}
                {...commonCellProps}
                {...selProps(rowIdx, col)}
            >
                <Input
                    autoFocus
                    value={row[field]}
                    onChange={(e) => updateRow(rowIdx, field, opts?.upper ? e.target.value.toUpperCase() : e.target.value)}
                    className={cn(inputClass, 'font-mono text-xs', textAlign, opts?.upper && 'uppercase')}
                    list={opts?.list}
                    placeholder={opts?.placeholder}
                    onPaste={(e) => { e.stopPropagation(); onPaste(e, rowIdx, col); }}
                />
            </GridCell>
        );
    };

    // A numeric cell (weight/flec) — right-aligned, type=number.
    const numCell = (col: number, field: BulkField) => (
        <GridCell
            col={col}
            row={rowIdx}
            value={row[field]}
            className="justify-end pr-1 font-mono tabular-nums"
            {...commonCellProps}
            {...selProps(rowIdx, col)}
        >
            <Input
                autoFocus
                type="number"
                step="1"
                value={row[field]}
                onChange={(e) => updateRow(rowIdx, field, e.target.value)}
                className={cn(inputClass, 'text-right font-mono text-xs')}
                onPaste={(e) => { e.stopPropagation(); onPaste(e, rowIdx, col); }}
            />
        </GridCell>
    );

    // A date cell — typeable YYYY-MM-DD (paste reuses parseExcelDate via cleanBulkPasteValue).
    const dateCell = (col: number, field: BulkField, placeholder: string) => (
        <GridCell
            col={col}
            row={rowIdx}
            value={row[field]}
            className="justify-center font-mono text-[11px] tabular-nums"
            {...commonCellProps}
            {...selProps(rowIdx, col)}
        >
            <Input
                autoFocus
                value={row[field]}
                onChange={(e) => updateRow(rowIdx, field, e.target.value)}
                className={cn(inputClass, 'text-center font-mono text-[11px]')}
                placeholder={placeholder}
                onPaste={(e) => { e.stopPropagation(); onPaste(e, rowIdx, col); }}
                // Excel-style click-away commit: normalize "6/2" → yyyy-MM-dd. Only touches
                // the value — active/editing state is owned by the grid-container onBlur.
                onBlur={() => onCommitDate(rowIdx, field)}
            />
        </GridCell>
    );

    return (
        <tr className="group h-8 border-b border-border/30 transition-all duration-150 hover:bg-muted/50" style={{ height: '32px' }}>
            {/* Row number + remove-on-hover */}
            <td className="relative border-r border-border/30 px-1 text-center font-mono text-[10px] text-muted-foreground" style={{ height: '32px' }}>
                <span className="group-hover:opacity-0">{rowIdx + 1}</span>
                <button
                    type="button"
                    tabIndex={-1}
                    onClick={() => removeRow(rowIdx)}
                    className="absolute inset-0 flex items-center justify-center text-muted-foreground/40 opacity-0 transition-colors hover:text-destructive group-hover:opacity-100"
                    aria-label={`Remove row ${rowIdx + 1}`}
                >
                    ×
                </button>
            </td>

            <td className="border-r border-border/30 p-0" style={{ height: '32px' }}>{dateCell(1, 'recv_date', 'YYYY-MM-DD')}</td>
            <td className="border-r border-border/30 p-0" style={{ height: '32px' }}>{dateCell(2, 'prod_date', '—')}</td>
            <td className="border-r border-border/30 p-0" style={{ height: '32px' }}>{textCell(3, 'batch', { upper: true, align: 'left', placeholder: 'Batch…' })}</td>
            <td className="border-r border-border/30 p-0" style={{ height: '32px' }}>{textCell(4, 'shift_code', { list: 'bulk-shift-suggestions', upper: true })}</td>
            <td className="border-r border-border/30 p-0" style={{ height: '32px' }}>{textCell(5, 'grade_code', { list: 'bulk-grade-suggestions', upper: true })}</td>
            <td className="border-r border-border/30 p-0" style={{ height: '32px' }}>{textCell(6, 'plant_code', { list: 'bulk-plant-suggestions', upper: true })}</td>
            <td className="border-r border-border/30 p-0" style={{ height: '32px' }}>{textCell(7, 'warehouse_code', { list: 'bulk-warehouse-suggestions', upper: true })}</td>
            <td className="border-r border-border/30 p-0" style={{ height: '32px' }}>{textCell(8, 'source_location_code', { list: 'bulk-source-suggestions', upper: true })}</td>
            <td className="border-r border-border/30 p-0" style={{ height: '32px' }}>{numCell(9, 'weight_kg')}</td>
            <td className="border-r border-border/30 p-0" style={{ height: '32px' }}>{textCell(10, 'ccc_flec', { list: 'bulk-ccc-flec-suggestions', upper: true, placeholder: 'FLEC…' })}</td>
            <td className="border-r border-border/30 p-0" style={{ height: '32px' }}>{numCell(11, 'flec_count')}</td>
            <td className="p-0" style={{ height: '32px' }}>{textCell(12, 'whse_side', { list: 'bulk-side-suggestions', upper: true })}</td>
        </tr>
    );
});
