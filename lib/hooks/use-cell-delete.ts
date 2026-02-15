'use client';

import { useCallback } from 'react';
import { toast } from 'sonner';

type CellDeleteConfig = {
  getSelectedRange: () => {
    startRow: number;
    startCol: number;
    endRow: number;
    endCol: number;
  } | null;
  getSelectionSize: () => number;
  clearCell: (row: number, col: number) => void;
  enabled?: boolean;
};

export function useCellDelete({
  getSelectedRange,
  getSelectionSize,
  clearCell,
  enabled = true,
}: CellDeleteConfig) {
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (!enabled) return;
      if (e.key !== 'Backspace' && e.key !== 'Delete') return;
      if (getSelectionSize() <= 1) return;

      e.preventDefault();
      const range = getSelectedRange();
      if (!range) return;

      let cleared = 0;
      for (let row = range.startRow; row <= range.endRow; row++) {
        for (let col = range.startCol; col <= range.endCol; col++) {
          clearCell(row, col);
          cleared++;
        }
      }

      toast.success(`Cleared ${cleared} cells`);
    },
    [enabled, getSelectedRange, getSelectionSize, clearCell]
  );

  return { handleKeyDown };
}
