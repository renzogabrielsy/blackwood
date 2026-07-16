'use client';

import * as React from 'react';
import { toast } from 'sonner';

// ─────────────────────────────────────────────────────────────────────────────
// useGridPaste — Excel/TSV paste into a coordinate grid (the "smart paste").
//
// Lifted verbatim from bulk-delivery-input.tsx (:478-529): parses the clipboard
// TSV, auto-creates rows when the paste runs past the current row count, and maps
// each pasted column to its field via the columnMap (skipping null/read-only
// columns), cleaning each value via cleanCellValue. Generic over the row type.
//
// Per project rule: success toasts may auto-dismiss, so the "Pasted N rows"
// message uses sonner's toast.success directly. Only ERROR surfaces must use
// errorToast() — there are none here.
// ─────────────────────────────────────────────────────────────────────────────

export interface GridPasteConfig<Row> {
  /** Visual column index → field key (null = read-only / skipped on paste). */
  columnMap: readonly (keyof Row | null)[];
  /** The grid's row-state setter (same shape as React's setState updater). */
  setRows: React.Dispatch<React.SetStateAction<Row[]>>;
  /** Factory for a blank row, used when the paste extends past existing rows. */
  createEmptyRow: () => Row;
  /** Clean/normalize a pasted cell value for its target field. */
  cleanCellValue: (raw: string, fieldKey: keyof Row) => string;
}

export interface GridPaste {
  /** Paste starting at an explicit (row, col). */
  handleSmartPaste: (
    e: React.ClipboardEvent,
    startRow: number,
    startCol: number
  ) => void;
  /** Paste at the active cell (used by the container-level onPaste in nav mode). */
  handleGridPaste: (
    e: React.ClipboardEvent,
    activeCell: { row: number; col: number } | null,
    clearSelection?: () => void
  ) => void;
}

export function useGridPaste<Row>(cfg: GridPasteConfig<Row>): GridPaste {
  const { columnMap, setRows, createEmptyRow, cleanCellValue } = cfg;

  const handleSmartPaste = React.useCallback(
    (e: React.ClipboardEvent, startRowIndex: number, startColIndex: number) => {
      e.preventDefault();
      const clipboardData = e.clipboardData.getData('text');
      if (!clipboardData) return;

      // Parse Excel/TSV format.
      const pastedRows = clipboardData
        .split(/\r\n|\n|\r/)
        .filter((row) => row.trim() !== '');
      if (pastedRows.length === 0) return;

      setRows((prev) => {
        const newRows = [...prev];

        pastedRows.forEach((pastedRow, rOffset) => {
          const targetRowIndex = startRowIndex + rOffset;
          const columns = pastedRow.split('\t');

          // If we need more rows than exist, create them.
          if (targetRowIndex >= newRows.length) {
            newRows.push(createEmptyRow());
          }

          columns.forEach((cellValue, cOffset) => {
            const targetColIndex = startColIndex + cOffset;

            // Safety check: don't paste beyond defined columns.
            if (targetColIndex < columnMap.length) {
              const fieldKey = columnMap[targetColIndex];

              // Only paste into writable fields.
              if (fieldKey) {
                newRows[targetRowIndex] = {
                  ...newRows[targetRowIndex],
                  [fieldKey]: cleanCellValue(cellValue, fieldKey),
                };
              }
            }
          });
        });

        return newRows;
      });

      toast.success(`Pasted ${pastedRows.length} rows`);
    },
    [columnMap, setRows, createEmptyRow, cleanCellValue]
  );

  // Handle paste on the grid container when in selection mode.
  const handleGridPaste = React.useCallback(
    (
      e: React.ClipboardEvent,
      activeCell: { row: number; col: number } | null,
      clearSelection?: () => void
    ) => {
      if (activeCell) {
        handleSmartPaste(e, activeCell.row, activeCell.col);
        clearSelection?.();
      }
    },
    [handleSmartPaste]
  );

  return { handleSmartPaste, handleGridPaste };
}
