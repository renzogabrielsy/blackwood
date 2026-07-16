'use client';

import * as React from 'react';

// ─────────────────────────────────────────────────────────────────────────────
// useGridContextMenu — the shared right-click menu state primitive.
//
// Consolidates two pieces of logic that were independently re-implemented in
// every grid menu:
//   • Viewport edge-detection on open — flip left/up when the menu would overflow
//     the viewport. Lifted from delivery-master-table.tsx (:348-354, :1557-1561).
//   • Close-on-outside (capture-phase mousedown, unless inside [data-ctx-menu])
//     + Escape. Lifted from production-ledger-grid.tsx (:1124-1139).
//
// Generic over the row-ref payload `T` (string id / numeric index / column id) so
// one hook serves row menus AND column-header menus.
// ─────────────────────────────────────────────────────────────────────────────

export interface GridContextMenuState<T> {
  ref: T;
  x: number;
  y: number;
}

export interface GridContextMenuConfig {
  /** Approximate menu width (px) for edge-flip. Defaults to 200. */
  width?: number;
  /** Approximate menu height (px) for edge-flip. Defaults to 280. */
  height?: number;
}

export interface GridContextMenu<T> {
  state: GridContextMenuState<T> | null;
  /** Open the menu at the click point, flipping to stay inside the viewport. */
  open: (ref: T, clientX: number, clientY: number) => void;
  close: () => void;
}

export function useGridContextMenu<T>(
  cfg: GridContextMenuConfig = {}
): GridContextMenu<T> {
  const { width = 200, height = 280 } = cfg;

  const [state, setState] = React.useState<GridContextMenuState<T> | null>(null);

  const open = React.useCallback(
    (ref: T, clientX: number, clientY: number) => {
      let x = clientX;
      let y = clientY;
      if (x + width > window.innerWidth) x = x - width;
      if (y + height > window.innerHeight) y = y - height;
      setState({ ref, x, y });
    },
    [width, height]
  );

  const close = React.useCallback(() => setState(null), []);

  // Close on outside mousedown (capture phase) or Escape — same discipline as
  // production-ledger-grid.tsx so opening a menu over the grid never gets eaten by
  // the grid's own handlers.
  React.useEffect(() => {
    if (!state) return;
    const handleClick = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (!target.closest('[data-ctx-menu]')) setState(null);
    };
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setState(null);
    };
    document.addEventListener('mousedown', handleClick, true);
    document.addEventListener('keydown', handleKey, true);
    return () => {
      document.removeEventListener('mousedown', handleClick, true);
      document.removeEventListener('keydown', handleKey, true);
    };
  }, [state]);

  return { state, open, close };
}
