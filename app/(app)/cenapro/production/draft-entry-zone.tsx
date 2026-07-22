'use client';

import * as React from 'react';
import { cn } from '@/lib/utils';
import { Input } from '@/components/ui/input';
import { GridCell } from '@/components/shared/grid/GridCell';
import {
    SHIFT_CODES,
    GRADE_CODES,
    PLANT_CODES,
    WAREHOUSE_CODES,
    SOURCE_LOCATION_CODES,
    CCC_FLEC_OPTIONS,
    WHSE_SIDES,
} from '../types';
import type { BulkRow, BulkField } from './bulk-paste-utils';

// ─── Draft row cells — the IN-LIST editable row (Phase 2A, in-list model) ─────────
// The retired Bulk Add modal → then a pinned draft section → now IN-LIST blank rows
// that are react-virtuoso ITEMS in the SAME list as the committed rows (the natural
// "Google Sheets" model Renzo asked for: scroll DOWN into an effectively-infinite
// supply of blanks). This module renders ONE draft row's `<td>` cells (the row# +
// remove control + the 12 editable data cells) as a fragment — the endless sheet's
// `TableVirtuoso` `TableRow` supplies the `<tr>`, so blanks line up with committed
// rows exactly (same colgroup, same widths).
//
// **Recycling-safe:** this component holds NO draft state. The row's data comes in via
// the `row` prop and every edit calls up to `updateRow(draftIndex, field, value)` — the
// draft data lives in the endless sheet's PARENT-OWNED `draftRows` array (keyed by
// position), so virtuoso recycling an off-screen row never loses a half-typed value
// (it rehydrates from the parent array on remount). This is the flat-list equivalent
// of `production-daily-block.tsx`'s parent-owned `drafts` Map keyed by a positional
// slot id — the array index IS the stable slot id, and rows never reorder.

// Shared dense input styling — identical to the ledger's edit inputs.
const inputClass =
    'h-8 w-full px-1 border-transparent bg-transparent rounded-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-primary focus-visible:bg-accent/10 transition-colors shadow-none';

// The datalist ids the categorical cells reference — rendered ONCE by the endless
// sheet (see <DraftDatalists/> below) so every recycled row can point at them.
const LIST = {
    shift: 'draft-shift-suggestions',
    grade: 'draft-grade-suggestions',
    plant: 'draft-plant-suggestions',
    warehouse: 'draft-warehouse-suggestions',
    source: 'draft-source-suggestions',
    ccc: 'draft-ccc-flec-suggestions',
    side: 'draft-side-suggestions',
} as const;

export interface DraftCellCommonProps {
    activeCell: { row: number; col: number } | null;
    isEditing: boolean;
    setActiveCell: (cell: { row: number; col: number }) => void;
    setIsEditing: (editing: boolean) => void;
    onStartEditing: (row: number, col: number, char?: string) => void;
    onRevert: () => void;
    gridRef: React.RefObject<HTMLDivElement | null>;
}

export interface DraftCellSelProps {
    onCellMouseDown: (e: React.MouseEvent) => void;
    onCellMouseUp: () => void;
    onCellMouseEnter: () => void;
    isCellRangeSelected: boolean;
    isCellRangeAnchor: boolean;
    isDragActive: boolean;
}

interface DraftRowCellsProps {
    /** Index into the parent-owned `draftRows` array — the coordinate-grid row + stable slot id. */
    draftIndex: number;
    row: BulkRow;
    hasError: boolean;
    updateRow: (index: number, field: BulkField, value: string) => void;
    removeRow: (index: number) => void;
    onPaste: (e: React.ClipboardEvent, rowIdx: number, colIdx: number) => void;
    /** Normalize a typed date cell to yyyy-MM-dd on blur (click-away commit). */
    onCommitDate: (rowIdx: number, field: BulkField) => void;
    commonCellProps: DraftCellCommonProps;
    selProps: (rowIdx: number, colIdx: number) => DraftCellSelProps;
}

// Rendered inside a virtuoso `<tr>`. Returns the row# cell + the 12 editable data cells.
export function DraftRowCells({
    draftIndex,
    row,
    hasError,
    updateRow,
    removeRow,
    onPaste,
    onCommitDate,
    commonCellProps,
    selProps,
}: DraftRowCellsProps) {
    const rowIdx = draftIndex;

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
                    onPaste={(e) => {
                        e.stopPropagation();
                        onPaste(e, rowIdx, col);
                    }}
                />
            </GridCell>
        );
    };

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
                onPaste={(e) => {
                    e.stopPropagation();
                    onPaste(e, rowIdx, col);
                }}
            />
        </GridCell>
    );

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
                onPaste={(e) => {
                    e.stopPropagation();
                    onPaste(e, rowIdx, col);
                }}
                onBlur={() => onCommitDate(rowIdx, field)}
            />
        </GridCell>
    );

    // NOTE: draft cells are intentionally NOT frozen/sticky (unlike committed identity
    // columns) — they're editable GridCells and a sticky+active-ring+opaque combo adds
    // z-order complexity for no real gain (the sheet fits ~1228px without horizontal
    // scroll on most screens; columns still align vertically via the shared colgroup).
    return (
        <>
            {/* Row number + remove-on-hover; a red rail on validation-failed rows. */}
            <td
                className={cn(
                    'relative border-r border-border/30 px-1 text-center font-mono text-[10px] text-primary/50',
                    hasError && 'border-l-2 border-l-destructive',
                )}
                style={{ height: 32 }}
            >
                <span className="group-hover:opacity-0" aria-hidden>
                    +
                </span>
                <button
                    type="button"
                    tabIndex={-1}
                    onClick={() => removeRow(rowIdx)}
                    className="absolute inset-0 flex items-center justify-center text-muted-foreground/40 opacity-0 transition-colors hover:text-destructive group-hover:opacity-100"
                    aria-label={`Remove draft row`}
                >
                    ×
                </button>
            </td>

            <td className="border-r border-border/30 p-0" style={{ height: 32 }}>{dateCell(1, 'recv_date', 'YYYY-MM-DD')}</td>
            <td className="border-r border-border/30 p-0" style={{ height: 32 }}>{dateCell(2, 'prod_date', '—')}</td>
            <td className="border-r border-border/30 p-0" style={{ height: 32 }}>{textCell(3, 'batch', { upper: true, align: 'left', placeholder: 'Batch…' })}</td>
            <td className="border-r border-border/30 p-0" style={{ height: 32 }}>{textCell(4, 'shift_code', { list: LIST.shift, upper: true })}</td>
            <td className="border-r border-border/30 p-0" style={{ height: 32 }}>{textCell(5, 'grade_code', { list: LIST.grade, upper: true })}</td>
            <td className="border-r border-border/30 p-0" style={{ height: 32 }}>{textCell(6, 'plant_code', { list: LIST.plant, upper: true })}</td>
            <td className="border-r border-border/30 p-0" style={{ height: 32 }}>{textCell(7, 'warehouse_code', { list: LIST.warehouse, upper: true })}</td>
            <td className="border-r border-border/30 p-0" style={{ height: 32 }}>{textCell(8, 'source_location_code', { list: LIST.source, upper: true })}</td>
            <td className="border-r border-border/30 p-0" style={{ height: 32 }}>{numCell(9, 'weight_kg')}</td>
            <td className="border-r border-border/30 p-0" style={{ height: 32 }}>{textCell(10, 'ccc_flec', { list: LIST.ccc, upper: true, placeholder: 'FLEC…' })}</td>
            <td className="border-r border-border/30 p-0" style={{ height: 32 }}>{numCell(11, 'flec_count')}</td>
            <td className="p-0" style={{ height: 32 }}>{textCell(12, 'whse_side', { list: LIST.side })}</td>
        </>
    );
}

// The categorical typeahead datalists — rendered ONCE by the endless sheet so every
// (recycled) draft cell can reference them via `list=`.
export function DraftDatalists() {
    return (
        <>
            <datalist id={LIST.shift}>{SHIFT_CODES.map((s) => <option key={s} value={s} />)}</datalist>
            <datalist id={LIST.grade}>{GRADE_CODES.map((g) => <option key={g} value={g} />)}</datalist>
            <datalist id={LIST.plant}>{PLANT_CODES.map((p) => <option key={p} value={p} />)}</datalist>
            <datalist id={LIST.warehouse}>{WAREHOUSE_CODES.map((w) => <option key={w} value={w} />)}</datalist>
            <datalist id={LIST.source}>{SOURCE_LOCATION_CODES.map((s) => <option key={s} value={s} />)}</datalist>
            <datalist id={LIST.ccc}>{CCC_FLEC_OPTIONS.map((d) => <option key={d} value={d} />)}</datalist>
            <datalist id={LIST.side}>{WHSE_SIDES.map((s) => <option key={s} value={s} />)}</datalist>
        </>
    );
}
