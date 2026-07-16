'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

export type CellRange = {
  startRow: number;
  startCol: number;
  endRow: number;
  endCol: number;
};

export type CellSelectionConfig = {
  rowCount: number;
  colCount: number;
  isSelectableColumn?: (colIndex: number) => boolean;
  onSelectionChange?: (range: CellRange | null) => void;
  scrollContainerRef?: React.RefObject<HTMLElement | null>;
  enabled?: boolean;
};

type CellCoord = { row: number; col: number };

function normalizeRange(anchor: CellCoord, focus: CellCoord): CellRange {
  return {
    startRow: Math.min(anchor.row, focus.row),
    startCol: Math.min(anchor.col, focus.col),
    endRow: Math.max(anchor.row, focus.row),
    endCol: Math.max(anchor.col, focus.col),
  };
}

const NOOP_MOUSE = () => {};
const NOOP_KEY = () => {};

const DISABLED_RETURN = {
  isSelected: () => false,
  isAnchor: () => false,
  getSelectedRange: () => null,
  getSelectionSize: () => 0,
  handleCellMouseDown: NOOP_MOUSE as (row: number, col: number, e: React.MouseEvent) => void,
  handleCellMouseEnter: NOOP_MOUSE as (row: number, col: number) => void,
  handleMouseUp: NOOP_MOUSE,
  handleKeyDown: NOOP_KEY as (e: React.KeyboardEvent) => void,
  clearSelection: NOOP_MOUSE,
  selectAll: NOOP_MOUSE,
  isDragging: false,
  range: null,
} as const;

export function useCellSelection(config: CellSelectionConfig) {
  const {
    rowCount,
    colCount,
    isSelectableColumn,
    onSelectionChange,
    scrollContainerRef,
    enabled = true,
  } = config;

  const [anchor, setAnchor] = useState<CellCoord | null>(null);
  const [focus, setFocus] = useState<CellCoord | null>(null);
  const [isDragging, setIsDragging] = useState(false);

  const anchorRef = useRef(anchor);
  const focusRef = useRef(focus);
  const isDraggingRef = useRef(isDragging);
  const rafIdRef = useRef<number | null>(null);

  // Synchronous ref updates during render for performance (avoiding race conditions with batched state updates)
  // eslint-disable-next-line react-hooks/refs
  anchorRef.current = anchor;
  // eslint-disable-next-line react-hooks/refs
  focusRef.current = focus;
  // NOTE: isDraggingRef is also set synchronously in handlers below
  // to avoid race conditions with batched React state updates.
  // This render-time sync is kept as a fallback.
  // eslint-disable-next-line react-hooks/refs
  isDraggingRef.current = isDragging;

  // Derived range
  const range = anchor && focus ? normalizeRange(anchor, focus) : null;
  const rangeRef = useRef(range);
  // eslint-disable-next-line react-hooks/refs
  rangeRef.current = range;

  // Notify on selection change
  const prevRangeRef = useRef<CellRange | null>(null);
  useEffect(() => {
    const prev = prevRangeRef.current;
    const curr = range;
    const changed =
      prev?.startRow !== curr?.startRow ||
      prev?.startCol !== curr?.startCol ||
      prev?.endRow !== curr?.endRow ||
      prev?.endCol !== curr?.endCol;
    if (changed) {
      prevRangeRef.current = curr;
      onSelectionChange?.(curr);
    }
  }, [range, onSelectionChange]);

  // Column selectability check
  const isColSelectable = useCallback(
    (col: number) => !isSelectableColumn || isSelectableColumn(col),
    [isSelectableColumn]
  );

  // Clamp coordinates within bounds
  const clamp = useCallback(
    (coord: CellCoord): CellCoord => ({
      row: Math.max(0, Math.min(coord.row, rowCount - 1)),
      col: Math.max(0, Math.min(coord.col, colCount - 1)),
    }),
    [rowCount, colCount]
  );

  // --- Auto-scroll during drag ---
  const EDGE_THRESHOLD = 40;
  const SCROLL_SPEED = 5;

  const lastPointerRef = useRef<{ x: number; y: number } | null>(null);

  const stopAutoScroll = useCallback(() => {
    if (rafIdRef.current !== null) {
      cancelAnimationFrame(rafIdRef.current);
      rafIdRef.current = null;
    }
  }, []);

  const tickAutoScrollRef = useRef<(() => void) | undefined>(undefined);

  const tickAutoScroll = useCallback(() => {
    const container = scrollContainerRef?.current;
    const pointer = lastPointerRef.current;
    if (!container || !pointer || !isDraggingRef.current) {
      stopAutoScroll();
      return;
    }

    const rect = container.getBoundingClientRect();
    let dx = 0;
    let dy = 0;

    if (pointer.y < rect.top + EDGE_THRESHOLD) {
      dy = -SCROLL_SPEED;
    } else if (pointer.y > rect.bottom - EDGE_THRESHOLD) {
      dy = SCROLL_SPEED;
    }

    if (pointer.x < rect.left + EDGE_THRESHOLD) {
      dx = -SCROLL_SPEED;
    } else if (pointer.x > rect.right - EDGE_THRESHOLD) {
      dx = SCROLL_SPEED;
    }

    if (dx !== 0 || dy !== 0) {
      container.scrollBy(dx, dy);
    }

    rafIdRef.current = requestAnimationFrame(() => tickAutoScrollRef.current?.());
  }, [scrollContainerRef, stopAutoScroll]);

  // eslint-disable-next-line react-hooks/refs
  tickAutoScrollRef.current = tickAutoScroll;

  // Track pointer position for auto-scroll
  useEffect(() => {
    if (!enabled || !isDragging) return;

    const onPointerMove = (e: PointerEvent) => {
      lastPointerRef.current = { x: e.clientX, y: e.clientY };
    };

    document.addEventListener('pointermove', onPointerMove);
    rafIdRef.current = requestAnimationFrame(tickAutoScroll);

    return () => {
      document.removeEventListener('pointermove', onPointerMove);
      stopAutoScroll();
      lastPointerRef.current = null;
    };
  }, [enabled, isDragging, tickAutoScroll, stopAutoScroll]);

  // --- Document-level mouseup to end drag ---
  useEffect(() => {
    if (!enabled) return;

    const onMouseUp = () => {
      if (isDraggingRef.current) {
        isDraggingRef.current = false;
        setIsDragging(false);
      }
    };

    document.addEventListener('mouseup', onMouseUp);
    return () => document.removeEventListener('mouseup', onMouseUp);
  }, [enabled]);

  // --- Handlers ---
  const clearSelection = useCallback(() => {
    setAnchor(null);
    setFocus(null);
    isDraggingRef.current = false;
    setIsDragging(false);
  }, []);

  const selectAll = useCallback(() => {
    if (rowCount === 0 || colCount === 0) return;
    setAnchor({ row: 0, col: 0 });
    setFocus({ row: rowCount - 1, col: colCount - 1 });
  }, [rowCount, colCount]);

  const handleCellMouseDown = useCallback(
    (row: number, col: number, e: React.MouseEvent) => {
      // Only respond to left-click (button 0) — ignore right-click / middle-click
      if (e.button !== 0) return;
      if (!isColSelectable(col)) return;

      const coord = clamp({ row, col });

      if (e.shiftKey && anchorRef.current) {
        // Extend range: keep anchor, move focus
        setFocus(coord);
      } else {
        // New selection
        setAnchor(coord);
        setFocus(coord);
      }

      // Sync ref immediately so handleCellMouseEnter works before React re-renders
      isDraggingRef.current = true;
      setIsDragging(true);
    },
    [isColSelectable, clamp]
  );

  const handleCellMouseEnter = useCallback(
    (row: number, col: number) => {
      if (!isDraggingRef.current) return;
      if (!isColSelectable(col)) return;

      const coord = clamp({ row, col });
      setFocus(coord);
    },
    [isColSelectable, clamp]
  );

  const handleMouseUp = useCallback(() => {
    isDraggingRef.current = false;
    setIsDragging(false);
  }, []);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      // Ctrl+A / Cmd+A → select all
      if ((e.metaKey || e.ctrlKey) && e.key === 'a') {
        e.preventDefault();
        selectAll();
        return;
      }

      // Escape → clear
      if (e.key === 'Escape') {
        clearSelection();
        return;
      }

      // Shift+Arrow → extend selection
      if (!e.shiftKey) return;

      const arrowDelta: Record<string, CellCoord> = {
        ArrowUp: { row: -1, col: 0 },
        ArrowDown: { row: 1, col: 0 },
        ArrowLeft: { row: 0, col: -1 },
        ArrowRight: { row: 0, col: 1 },
      };

      const delta = arrowDelta[e.key];
      if (!delta) return;

      e.preventDefault();

      const currentFocus = focusRef.current;
      const currentAnchor = anchorRef.current;

      // If no selection exists, start at (0,0)
      if (!currentAnchor) {
        const start = { row: 0, col: 0 };
        setAnchor(start);
        setFocus(start);
        return;
      }

      const base = currentFocus ?? currentAnchor;
      let nextCol = base.col + delta.col;
      const nextRow = base.row + delta.row;

      // Skip non-selectable columns
      while (
        nextCol >= 0 &&
        nextCol < colCount &&
        !isColSelectable(nextCol)
      ) {
        nextCol += delta.col !== 0 ? delta.col : 1;
      }

      const next = clamp({ row: nextRow, col: nextCol });

      if (!isColSelectable(next.col)) return;

      setFocus(next);
    },
    [selectAll, clearSelection, colCount, isColSelectable, clamp]
  );

  // --- Query methods ---
  const isSelected = useCallback(
    (row: number, col: number): boolean => {
      if (!range) return false;
      return (
        row >= range.startRow &&
        row <= range.endRow &&
        col >= range.startCol &&
        col <= range.endCol
      );
    },
    [range]
  );

  const isAnchor = useCallback(
    (row: number, col: number): boolean => {
      if (!anchor) return false;
      return anchor.row === row && anchor.col === col;
    },
    [anchor]
  );

  const getSelectedRange = useCallback((): CellRange | null => range, [range]);

  const getSelectionSize = useCallback((): number => {
    if (!range) return 0;
    return (
      (range.endRow - range.startRow + 1) *
      (range.endCol - range.startCol + 1)
    );
  }, [range]);

  // --- Disabled gate ---
  if (!enabled) {
    return DISABLED_RETURN;
  }

  return {
    isSelected,
    isAnchor,
    getSelectedRange,
    getSelectionSize,
    handleCellMouseDown,
    handleCellMouseEnter,
    handleMouseUp,
    handleKeyDown,
    clearSelection,
    selectAll,
    isDragging,
    range,
  };
}
