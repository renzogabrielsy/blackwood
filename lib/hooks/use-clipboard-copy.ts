'use client';

import { useCallback } from 'react';
import { toast } from 'sonner';

interface ClipboardCopyConfig {
  /** Returns the currently selected cell range, or null if nothing is selected. */
  getSelectedRange: () => {
    startRow: number;
    startCol: number;
    endRow: number;
    endCol: number;
  } | null;
  /** Returns the display value for a cell at the given row and column. */
  getCellValue: (row: number, col: number) => string;
  /** Returns the total number of selected cells. */
  getSelectionSize: () => number;
  /** When false, the handler becomes a no-op. Defaults to true. */
  enabled?: boolean;
}

/**
 * Hook that listens for Ctrl+C / Cmd+C and copies the selected cell range
 * as tab-separated values (TSV) to the clipboard.
 *
 * Attach the returned `handleKeyDown` to the table container's `onKeyDown`.
 */
export function useClipboardCopy(config: ClipboardCopyConfig) {
  const { getSelectedRange, getCellValue, getSelectionSize, enabled = true } = config;

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (!enabled) return;

      const isCopy = (e.metaKey || e.ctrlKey) && e.key === 'c';
      if (!isCopy) return;

      const selectionSize = getSelectionSize();
      if (selectionSize === 0) return;

      const range = getSelectedRange();
      if (!range) return;

      e.preventDefault();

      const { startRow, startCol, endRow, endCol } = range;
      const rows: string[] = [];

      for (let r = startRow; r <= endRow; r++) {
        const cols: string[] = [];
        for (let c = startCol; c <= endCol; c++) {
          cols.push(getCellValue(r, c));
        }
        rows.push(cols.join('\t'));
      }

      const tsv = rows.join('\n');

      navigator.clipboard.writeText(tsv).then(() => {
        toast.success(`Copied ${selectionSize} cells to clipboard`);
      });
    },
    [enabled, getSelectedRange, getCellValue, getSelectionSize]
  );

  return { handleKeyDown };
}
