'use client';

import * as React from 'react';
import { cn } from '@/lib/utils';

/**
 * Props for GridCell component
 */
export interface GridCellProps {
    /** Row index in the grid */
    row: number;
    /** Column index in the grid */
    col: number;
    /** Current value of the cell */
    value: string | number;
    /** Currently active cell position */
    activeCell: { row: number; col: number } | null;
    /** Whether the active cell is in editing mode */
    isEditing: boolean;
    /** Callback to set the active cell */
    setActiveCell: (cell: { row: number; col: number }) => void;
    /** Callback to set editing mode */
    setIsEditing: (editing: boolean) => void;
    /** Callback to start editing a cell (with optional initial character) */
    onStartEditing: (row: number, col: number, char?: string) => void;
    /** Callback to revert changes (typically on Escape) */
    onRevert?: () => void;
    /** Edit mode content (input, textarea, etc.) */
    children: React.ReactNode;
    /** Display mode content (alternative to value) */
    displayValue?: React.ReactNode;
    /** Additional CSS classes */
    className?: string;
    /** Tab index for keyboard navigation */
    tabIndex?: number;
    /** Ref to the grid container (for focus management) */
    gridRef?: React.RefObject<HTMLDivElement | null>;
    /** Mouse down handler for cell selection */
    onCellMouseDown?: (e: React.MouseEvent) => void;
    /** Mouse up handler for cell selection */
    onCellMouseUp?: () => void;
    /** Mouse enter handler for cell selection */
    onCellMouseEnter?: () => void;
    /** Whether this cell is part of a range selection */
    isCellRangeSelected?: boolean;
    /** Whether this cell is the anchor of a range selection */
    isCellRangeAnchor?: boolean;
    /** Whether drag selection is currently active */
    isDragActive?: boolean;
}

/**
 * GridCell - A unified cell component for Excel-like grid input
 *
 * Features:
 * - Two modes: display (read-only) and edit (with children content)
 * - Keyboard navigation support with Tab index
 * - Cell selection with visual feedback (ring, background tint)
 * - Range selection with drag, Shift+Arrow, Ctrl+A
 * - Double-click to edit
 * - Mouse hover during drag selection
 *
 * Used in RC IN and RC OUT bulk input grids.
 */
export function GridCell({
    row,
    col,
    value,
    activeCell,
    isEditing,
    setActiveCell,
    setIsEditing,
    onStartEditing,
    onRevert,
    children,
    displayValue,
    className,
    tabIndex,
    gridRef,
    onCellMouseDown,
    onCellMouseUp,
    onCellMouseEnter,
    isCellRangeSelected,
    isCellRangeAnchor,
    isDragActive,
}: GridCellProps) {
    const isActive = activeCell?.row === row && activeCell?.col === col;
    const isEditingThis = isActive && isEditing;

    // Edit mode: render children (input, textarea, etc.)
    if (isEditingThis) {
        return (
            <div
                className={cn("h-full w-full relative", className)}
                style={isDragActive ? { pointerEvents: 'none' } : undefined}
                onMouseEnter={() => {
                    onCellMouseEnter?.();
                }}
            >
                {children}
            </div>
        );
    }

    // Display mode: render value with selection feedback
    return (
        <div
            data-row={row}
            data-col={col}
            tabIndex={tabIndex ?? 0}
            className={cn(
                "h-full w-full flex items-center justify-center outline-none cursor-default select-none",
                isActive && !isCellRangeSelected && "ring-2 ring-primary ring-inset z-10",
                isCellRangeSelected && "bg-primary/10 dark:bg-primary/20",
                isCellRangeAnchor && "ring-2 ring-primary ring-inset z-10",
                className
            )}
            style={{ minHeight: '100%' }}
            onMouseDown={(e) => {
                e.preventDefault();
                e.stopPropagation();
                if (onCellMouseDown) {
                    onCellMouseDown(e);
                } else {
                    // No cell selection -> original click behavior
                    setActiveCell({ row, col });
                    setIsEditing(false);
                    gridRef?.current?.focus();
                }
            }}
            onMouseUp={(e) => {
                e.stopPropagation();
                onCellMouseUp?.();
            }}
            onMouseEnter={() => {
                onCellMouseEnter?.();
            }}
            onDoubleClick={(e) => {
                e.stopPropagation();
                onStartEditing(row, col);
            }}
        >
            {displayValue ?? value}
        </div>
    );
}
