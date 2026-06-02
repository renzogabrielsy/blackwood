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
import { GridCell } from '@/components/shared/grid/GridCell';
import { useCellSelection } from '@/lib/hooks/use-cell-selection';
import { useClipboardCopy } from '@/lib/hooks/use-clipboard-copy';
import { useCellDelete } from '@/lib/hooks/use-cell-delete';
import { saveProductionEvents, type ProductionEventDirtyRow } from './actions';
import {
    SHIFT_CODES,
    GRADE_CODES,
    PLANT_CODES,
    WAREHOUSE_CODES,
    SOURCE_LOCATION_CODES,
    CRUSHER_CODES,
    KILN_CODES,
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

// Disposition typeahead suggestions — friendly labels the canonicalizer understands.
// (The cell stores whatever's typed; `mapBulkRowToDirty` maps it to the code on save.)
const DISPOSITION_SUGGESTIONS = ['Bag', 'Crusher', 'Kiln', 'C1', 'C2', 'C3', 'C4', 'RK1', 'RK2', 'RK3', 'RK4'] as const;
const EQUIPMENT_SUGGESTIONS = [...CRUSHER_CODES, ...KILN_CODES] as const;

// Shared dense input styling — identical to the RC IN bulk grid + the inline ledger.
const inputClass =
    'h-8 w-full px-1 border-transparent bg-transparent rounded-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-primary focus-visible:bg-accent/10 transition-colors shadow-none';

// ─── Props ───────────────────────────────────────────────────────────────────────
interface BulkAddModalProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    /** Called after a successful insert so the parent can refresh the inline grid. */
    onInserted: () => void;
}

// ─── Component ───────────────────────────────────────────────────────────────────
export function BulkAddModal({ open, onOpenChange, onInserted }: BulkAddModalProps) {
    const gridRef = React.useRef<HTMLDivElement>(null);

    // Preset with INITIAL_ROW_COUNT blank rows so the grid feels like a fresh sheet.
    const [rows, setRows] = React.useState<BulkRow[]>(() =>
        Array.from({ length: INITIAL_ROW_COUNT }, createEmptyRow),
    );

    const [isSaving, setIsSaving] = React.useState(false);
    const [activeCell, setActiveCell] = React.useState<{ row: number; col: number } | null>(null);
    const [isEditing, setIsEditing] = React.useState(false);
    const preEditValue = React.useRef<string>('');

    // Reset the grid to a fresh 8-row sheet whenever the modal re-opens.
    React.useEffect(() => {
        if (open) {
            setRows(Array.from({ length: INITIAL_ROW_COUNT }, createEmptyRow));
            setActiveCell(null);
            setIsEditing(false);
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
                setIsEditing(false);
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

    const { handleKeyDown: handleDeleteKeyDown } = useCellDelete({
        getSelectedRange: cellSelection.getSelectedRange,
        getSelectionSize: cellSelection.getSelectionSize,
        clearCell,
    });

    // ─── Editing (text/numeric cells; dropdowns/dates are typed too here) ──────────
    const startEditing = React.useCallback(
        (rowIdx: number, colIdx: number, initialChar?: string) => {
            const field = BULK_COLUMN_MAP[colIdx];
            if (!field) return;
            const row = rows[rowIdx];
            if (!row) return;
            preEditValue.current = String(row[field] ?? '');
            setActiveCell({ row: rowIdx, col: colIdx });
            setIsEditing(true);
            if (initialChar !== undefined) updateRow(rowIdx, field, initialChar);
        },
        [rows, updateRow],
    );

    const revertChanges = React.useCallback(() => {
        if (!activeCell) return;
        const field = BULK_COLUMN_MAP[activeCell.col];
        if (field) updateRow(activeCell.row, field, preEditValue.current);
        setIsEditing(false);
        gridRef.current?.focus();
    }, [activeCell, updateRow]);

    // ─── Keyboard navigation (mirrors RC IN's grid) ────────────────────────────────
    const moveActive = React.useCallback(
        (key: string, shift: boolean) => {
            if (!activeCell) return;
            let { row, col } = activeCell;
            if (key === 'ArrowUp' || (key === 'Enter' && shift)) row = Math.max(0, row - 1);
            else if (key === 'ArrowDown' || (key === 'Enter' && !shift)) row = Math.min(rows.length - 1, row + 1);
            else if (key === 'ArrowLeft') {
                do { col--; } while (col > 0 && BULK_COLUMN_MAP[col] === null);
                col = Math.max(1, col);
            } else if (key === 'ArrowRight') {
                do { col++; } while (col < BULK_COL_COUNT - 1 && BULK_COLUMN_MAP[col] === null);
                col = Math.min(BULK_COL_COUNT - 1, col);
            } else if (key === 'Tab') {
                if (shift) {
                    do { col--; if (col < 1) { row--; col = BULK_COL_COUNT - 1; } } while (row >= 0 && BULK_COLUMN_MAP[col] === null);
                    if (row < 0) { row = 0; col = activeCell.col; }
                } else {
                    do { col++; if (col >= BULK_COL_COUNT) { row++; col = 1; } } while (row < rows.length && BULK_COLUMN_MAP[col] === null);
                    if (row >= rows.length) { row = rows.length - 1; col = activeCell.col; }
                }
            } else if (key === 'Home') col = 1;
            else if (key === 'End') col = BULK_COL_COUNT - 1;
            setActiveCell({ row, col });
        },
        [activeCell, rows.length],
    );

    const handleGridKeyDown = React.useCallback(
        (e: React.KeyboardEvent) => {
            if (!activeCell) return;
            const isRangeSelected = cellSelection.getSelectionSize() > 1;

            if (isEditing) {
                if (e.key === 'Escape') {
                    e.preventDefault();
                    e.stopPropagation();
                    // Prevent Radix Dialog from catching Escape and closing the modal
                    // mid-edit — same guard the RC IN grid uses inside its Dialog.
                    e.nativeEvent.stopImmediatePropagation();
                    revertChanges();
                } else if (e.key === 'Enter' || e.key === 'Tab') {
                    e.preventDefault();
                    setIsEditing(false);
                    moveActive(e.key, e.shiftKey);
                    gridRef.current?.focus();
                }
                return;
            }

            if (isRangeSelected) {
                if (e.shiftKey && ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key)) {
                    e.preventDefault();
                    cellSelection.handleKeyDown(e);
                    return;
                }
                if ((e.metaKey || e.ctrlKey) && e.key === 'c') { handleCopyKeyDown(e); return; }
                if (e.key === 'Backspace' || e.key === 'Delete') { handleDeleteKeyDown(e); cellSelection.clearSelection(); return; }
                if (e.key === 'Escape') { e.preventDefault(); cellSelection.clearSelection(); return; }
                if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Tab', 'Enter'].includes(e.key)) cellSelection.clearSelection();
            }

            if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Tab', 'Enter', 'Home', 'End'].includes(e.key)) {
                e.preventDefault();
                if (e.shiftKey && ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key) && !isRangeSelected) {
                    cellSelection.handleCellMouseDown(activeCell.row, activeCell.col, { shiftKey: false, button: 0, preventDefault: () => {} } as unknown as React.MouseEvent);
                    cellSelection.handleMouseUp();
                    cellSelection.handleKeyDown(e);
                    return;
                }
                moveActive(e.key, e.shiftKey);
                return;
            }

            if (e.key === 'F2') { e.preventDefault(); startEditing(activeCell.row, activeCell.col); return; }
            if (e.key === 'Backspace' || e.key === 'Delete') { e.preventDefault(); startEditing(activeCell.row, activeCell.col, ''); return; }
            if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
                e.preventDefault();
                startEditing(activeCell.row, activeCell.col, e.key);
            }
        },
        [activeCell, isEditing, cellSelection, handleCopyKeyDown, handleDeleteKeyDown, revertChanges, moveActive, startEditing],
    );

    // ─── Paste engine (Excel/Sheets TSV → grid, auto-extends rows) ─────────────────
    // This is the "works like a charm" part, mirrored faithfully from RC IN's
    // handleSmartPaste: split on newlines into rows, tabs into columns, fill from the
    // active cell, and push fresh rows when the paste is taller than the grid.
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
                    // Auto-extend: grow the grid when the paste runs past the last row.
                    if (targetRow >= next.length) next.push(createEmptyRow());
                    const cols = pastedRow.split('\t');
                    cols.forEach((cellVal, cOffset) => {
                        const targetCol = startCol + cOffset;
                        if (targetCol >= BULK_COL_COUNT) return; // don't spill past the grid
                        const field = BULK_COLUMN_MAP[targetCol];
                        if (!field) return; // skip read-only/row# columns
                        next[targetRow] = { ...next[targetRow], [field]: cleanBulkPasteValue(cellVal, field) };
                    });
                });
                return next;
            });

            toast.success(`Pasted ${pastedRows.length} row${pastedRows.length !== 1 ? 's' : ''}`);
        },
        [],
    );

    // Grid-level paste (selection mode, not mid-edit) — same seam as RC IN.
    const handleGridPaste = React.useCallback(
        (e: React.ClipboardEvent) => {
            if (!isEditing && activeCell) {
                handleSmartPaste(e, activeCell.row, activeCell.col);
                cellSelection.clearSelection();
            }
        },
        [isEditing, activeCell, handleSmartPaste, cellSelection],
    );

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
            const { row, errors } = mapBulkRowToDirty(r);
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
                className="flex max-h-[88vh] w-full flex-col gap-4 sm:max-w-[min(96vw,1180px)]"
                onOpenAutoFocus={(e) => e.preventDefault()}
            >
                <DialogHeader>
                    <DialogTitle className="flex items-center gap-2">
                        <Sparkles className="h-4 w-4 text-primary" />
                        Bulk Add Production Rows
                    </DialogTitle>
                    <DialogDescription>
                        Paste straight from Excel or Google Sheets — the grid fills from the active cell and grows to fit.
                        Columns: Recv · Prod · Batch · Shift · Grade · Plant · Whse · Source · Weight · Disp. · Equip · Flec · Side.
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
                        style={{ width: '100%', minWidth: '1080px', borderCollapse: 'separate', borderSpacing: 0 }}
                    >
                        {/* col order: # / recv / prod / batch / shift / grade / plant / whse / source / weight / disp / equip / flec / side */}
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
                            <col style={{ width: '80px' }} />
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
                                <th className="h-8 px-2 text-left text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Disp.</th>
                                <th className="h-8 px-2 text-left text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Equip</th>
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
                <datalist id="bulk-disposition-suggestions">
                    {DISPOSITION_SUGGESTIONS.map((d) => <option key={d} value={d} />)}
                </datalist>
                <datalist id="bulk-equipment-suggestions">
                    {EQUIPMENT_SUGGESTIONS.map((eq) => <option key={eq} value={eq} />)}
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
            <td className="border-r border-border/30 p-0" style={{ height: '32px' }}>{textCell(10, 'disposition_kind', { list: 'bulk-disposition-suggestions', align: 'left', placeholder: 'Bag…' })}</td>
            <td className="border-r border-border/30 p-0" style={{ height: '32px' }}>{textCell(11, 'partner_equipment_code', { list: 'bulk-equipment-suggestions', upper: true })}</td>
            <td className="border-r border-border/30 p-0" style={{ height: '32px' }}>{numCell(12, 'flec_count')}</td>
            <td className="p-0" style={{ height: '32px' }}>{textCell(13, 'whse_side', { list: 'bulk-side-suggestions', upper: true })}</td>
        </tr>
    );
});
