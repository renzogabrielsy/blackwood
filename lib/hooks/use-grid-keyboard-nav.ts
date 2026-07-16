'use client';

import * as React from 'react';

// ─────────────────────────────────────────────────────────────────────────────
// useGridKeyboardNav — the cell-id-agnostic keyboard state machine (the linchpin).
//
// This is the EXACT union of branches lifted verbatim from
// `app/(app)/inventory/rc-in/bulk-delivery-input.tsx` (handleGridKeyDown +
// moveSelection), with the "where do I go next" question delegated to a pluggable
// `NavResolver<Id>`. The interpretation of keys (Esc/Enter/Tab/F2/Delete/printable)
// is identical everywhere in the app; only target resolution and range selection
// differ. So:
//   • Layer A — this hook: key interpretation + Enter-anchor.
//   • Layer B — NavResolver<Id>: target resolution (coordinate math vs DOM order).
//   • Layer C — the optional `range` slot: rectangular selection (coordinate grids
//     only). When `cfg.range` is undefined the range branches are fully skipped
//     (DOM grids never enter range mode).
// ─────────────────────────────────────────────────────────────────────────────

/** A single navigation intent decoded from a key event. */
export type NavMove =
  | { kind: 'arrow'; dir: 'up' | 'down' | 'left' | 'right' }
  | { kind: 'tab'; shift: boolean }
  | { kind: 'enter'; shift: boolean };

/**
 * Pluggable target resolution. `Id` is the grid's own cell-id type:
 * `{ row, col }` for coordinate grids, an opaque `string` navid for DOM grids.
 */
export interface NavResolver<Id> {
  /** Resolve the next cell for a move. Return null at a boundary (stay put). */
  resolve(from: Id, move: NavMove): Id | null;
  /** The "lane" (column identity) used for Enter-anchor bookkeeping. */
  laneOf(id: Id): string | number;
  /**
   * Move into the row above/below (`dir` = +1 down / -1 up) staying in `lane`
   * (or the nearest available lane). Used by the Enter-anchor. Optional — when
   * absent the hook falls back to `resolve(from, enter-move)`.
   */
  resolveInRow?(from: Id, lane: string | number, dir: 1 | -1): Id | null;
  /** Whether a cell can be edited (skips read-only / locked cells). */
  isEditable(id: Id): boolean;
}

/** The optional range-selection capability slot (coordinate grids only). */
export interface GridRangeSlot {
  /** True when more than one cell is currently selected. */
  isRangeSelected: boolean;
  /** Extend the current range with a Shift+Arrow event. */
  extend(e: React.KeyboardEvent): void;
  /** Clear the current range. */
  clear(): void;
  /** Seed a fresh range anchored at the current active cell. */
  seedFromActive(): void;
  /** The anchor (top-left) cell of the current range, or null. */
  anchorId(): unknown;
  /** Copy the current range (Ctrl/Cmd+C). */
  onCopy(e: React.KeyboardEvent): void;
  /** Delete/clear the current range (Delete/Backspace). */
  onDelete(e: React.KeyboardEvent): void;
}

export interface GridKeyboardNavConfig<Id> {
  activeCell: Id | null;
  setActiveCell: (id: Id | null) => void;
  isEditing: boolean;
  resolver: NavResolver<Id>;
  edit: {
    start: (id: Id, char?: string) => void;
    revert: () => void;
    commit: () => void;
  };
  /** Opt-in rectangular range selection. Absent ⇒ DOM grid (no range mode). */
  range?: GridRangeSlot;
  /** Called after the active cell moves (e.g. focus management). */
  onAfterMove?: (id: Id) => void;
  /** Enable the "Enter after a Tab run returns to the run's lane" behavior. */
  enableEnterAnchor?: boolean;
}

const ARROW_KEYS = ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'];
const NAV_KEYS = [...ARROW_KEYS, 'Tab', 'Enter'];

function arrowMove(key: string): NavMove | null {
  switch (key) {
    case 'ArrowUp':
      return { kind: 'arrow', dir: 'up' };
    case 'ArrowDown':
      return { kind: 'arrow', dir: 'down' };
    case 'ArrowLeft':
      return { kind: 'arrow', dir: 'left' };
    case 'ArrowRight':
      return { kind: 'arrow', dir: 'right' };
    default:
      return null;
  }
}

export function useGridKeyboardNav<Id>(cfg: GridKeyboardNavConfig<Id>): {
  handleKeyDown: (e: React.KeyboardEvent) => void;
} {
  const {
    activeCell,
    setActiveCell,
    isEditing,
    resolver,
    edit,
    range,
    onAfterMove,
    enableEnterAnchor = true,
  } = cfg;

  // The lane a Tab RUN started from. A later plain Enter drops one row and
  // returns to this lane, then clears it. Set on the first Tab of a run, cleared
  // on Enter and any arrow. Held in a ref (no re-render). Mirrors the
  // enterAnchorColRef in bulk-add-modal.tsx + production-daily-block.tsx.
  const enterAnchorLaneRef = React.useRef<string | number | null>(null);

  // Resolve a move via the resolver, set the active cell, and notify.
  const applyMove = React.useCallback(
    (from: Id, move: NavMove) => {
      const next = resolver.resolve(from, move);
      if (next === null) return;
      setActiveCell(next);
      onAfterMove?.(next);
    },
    [resolver, setActiveCell, onAfterMove]
  );

  const handleKeyDown = React.useCallback(
    (e: React.KeyboardEvent) => {
      if (activeCell === null) return;
      const active = activeCell;

      // ── EDITING MODE ──────────────────────────────────────────────────────
      // Only Escape (revert) or Tab/Enter (commit & move) are handled while an
      // editor is mounted. Verbatim from bulk-delivery-input.tsx:332-346.
      if (isEditing) {
        if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          // Prevent Radix/Dialog from catching this and closing the modal.
          e.nativeEvent.stopImmediatePropagation();
          edit.revert();
        } else if (e.key === 'Enter' || e.key === 'Tab') {
          e.preventDefault();
          edit.commit();
          const move: NavMove =
            e.key === 'Tab'
              ? { kind: 'tab', shift: e.shiftKey }
              : { kind: 'enter', shift: e.shiftKey };
          handleAnchoredMove(active, move);
        }
        return;
      }

      // ── RANGE MODE ────────────────────────────────────────────────────────
      // Fully skipped when no range slot is wired (DOM grids). Verbatim from
      // bulk-delivery-input.tsx:349-387.
      if (range && range.isRangeSelected) {
        // Shift+Arrow → extend selection
        if (e.shiftKey && ARROW_KEYS.includes(e.key)) {
          e.preventDefault();
          range.extend(e);
          return;
        }
        // Copy (Ctrl+C / Cmd+C)
        if ((e.metaKey || e.ctrlKey) && e.key === 'c') {
          range.onCopy(e);
          return;
        }
        // Delete/Backspace → clear selected cells
        if (e.key === 'Backspace' || e.key === 'Delete') {
          range.onDelete(e);
          range.clear();
          return;
        }
        // Escape → clear range
        if (e.key === 'Escape') {
          e.preventDefault();
          range.clear();
          return;
        }
        // Non-shift nav keys → exit range, do normal single-cell nav
        if (NAV_KEYS.includes(e.key)) {
          range.clear();
          // fall through to existing nav handling below
        }
        // Printable char → exit range, start editing anchor cell
        if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
          const anchor = range.anchorId() as Id | null;
          if (anchor !== null && anchor !== undefined) {
            range.clear();
            setActiveCell(anchor);
          }
          // fall through to existing char handling below
        }
      }

      // ── NAVIGATION (not editing) ──────────────────────────────────────────
      // Verbatim from bulk-delivery-input.tsx:390-402.
      if (NAV_KEYS.includes(e.key)) {
        e.preventDefault();
        // Shift+Arrow from a single cell → enter range selection (coordinate
        // grids only). Verbatim from bulk-delivery-input.tsx:393-399.
        if (
          range &&
          e.shiftKey &&
          ARROW_KEYS.includes(e.key) &&
          !range.isRangeSelected
        ) {
          range.seedFromActive();
          range.extend(e);
          return;
        }
        const move: NavMove = (() => {
          if (e.key === 'Tab') return { kind: 'tab', shift: e.shiftKey };
          if (e.key === 'Enter') return { kind: 'enter', shift: e.shiftKey };
          return arrowMove(e.key)!;
        })();
        handleAnchoredMove(active, move);
        return;
      }

      // ── EDIT-MODE TRIGGERS ────────────────────────────────────────────────
      // Verbatim from bulk-delivery-input.tsx:405-429.
      if (e.key === 'F2') {
        e.preventDefault();
        if (resolver.isEditable(active)) edit.start(active);
        return;
      }

      if (e.key === 'Backspace' || e.key === 'Delete') {
        e.preventDefault();
        if (resolver.isEditable(active)) edit.start(active, '');
        return;
      }

      // Printable characters → enter edit mode seeded with the typed char.
      if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
        if (resolver.isEditable(active)) {
          // Prevent default so the editor focus doesn't double-type the char.
          e.preventDefault();
          edit.start(active, e.key);
        }
      }

      // Inner helper: Tab sets the Enter-anchor lane (once per run); plain Enter
      // consumes it (via resolveInRow on the anchor lane); any arrow clears it.
      // Reconciles bulk-add-modal.tsx:253-296 (numeric lane) and
      // production-daily-block.tsx:591-636 (string colKey lane) — lane type is
      // whatever resolver.laneOf returns.
      function handleAnchoredMove(from: Id, move: NavMove) {
        if (!enableEnterAnchor) {
          applyMove(from, move);
          return;
        }

        if (move.kind === 'arrow') {
          enterAnchorLaneRef.current = null;
          applyMove(from, move);
          return;
        }

        if (move.kind === 'tab') {
          // Remember the lane at the START of a Tab run (kept through the run).
          if (enterAnchorLaneRef.current === null) {
            enterAnchorLaneRef.current = resolver.laneOf(from);
          }
          applyMove(from, move);
          return;
        }

        // move.kind === 'enter'
        if (move.shift) {
          // Shift+Enter → up one row; ends the run.
          enterAnchorLaneRef.current = null;
          applyMove(from, move);
          return;
        }
        // Plain Enter → down one row, returning to the anchor lane (or current),
        // then consume the anchor.
        const lane = enterAnchorLaneRef.current ?? resolver.laneOf(from);
        enterAnchorLaneRef.current = null;
        const next = resolver.resolveInRow
          ? resolver.resolveInRow(from, lane, 1)
          : resolver.resolve(from, move);
        if (next === null) return;
        setActiveCell(next);
        onAfterMove?.(next);
      }
    },
    [
      activeCell,
      isEditing,
      range,
      resolver,
      edit,
      setActiveCell,
      onAfterMove,
      enableEnterAnchor,
      applyMove,
    ]
  );

  return { handleKeyDown };
}

// ─────────────────────────────────────────────────────────────────────────────
// Resolver factories
// ─────────────────────────────────────────────────────────────────────────────

/** Coordinate cell id for flat grids. */
export interface CoordinateId {
  row: number;
  col: number;
}

export interface CoordinateNavResolverConfig {
  /** Total number of rows (for clamping + Tab row-wrap). */
  rowCount: number;
  /** Visual column index → field key (null = read-only / skipped). */
  columnMap: readonly (string | null)[];
}

/**
 * Coordinate resolver — the `moveSelection` math from bulk-delivery-input.tsx
 * (:432-475). Skips null columns, Tab wraps rows + clamps at boundaries, Enter
 * moves down / Shift+Enter up. `laneOf` = col index. `resolveInRow` = same col
 * index in the row above/below (clamped). `isEditable` = columnMap[col] != null.
 */
export function createCoordinateNavResolver(
  cfg: CoordinateNavResolverConfig
): NavResolver<CoordinateId> {
  const { rowCount, columnMap } = cfg;
  const colCount = columnMap.length;

  return {
    resolve(from, move) {
      let { row, col } = from;

      if (move.kind === 'arrow') {
        if (move.dir === 'up') {
          row = Math.max(0, row - 1);
        } else if (move.dir === 'down') {
          row = Math.min(rowCount - 1, row + 1);
        } else if (move.dir === 'left') {
          do {
            col--;
          } while (col > 0 && columnMap[col] === null); // skip nulls
          col = Math.max(0, col);
        } else {
          // right
          do {
            col++;
          } while (col < colCount && columnMap[col] === null);
          col = Math.min(colCount - 1, col);
        }
      } else if (move.kind === 'enter') {
        if (move.shift) {
          row = Math.max(0, row - 1);
        } else {
          row = Math.min(rowCount - 1, row + 1);
        }
      } else {
        // tab
        if (move.shift) {
          // Previous writable cell
          do {
            col--;
            if (col < 0) {
              row--;
              col = colCount - 1;
            }
          } while (row >= 0 && columnMap[col] === null);
          if (row < 0) {
            row = 0;
            col = from.col;
          } // boundary check
        } else {
          // Next writable cell
          do {
            col++;
            if (col >= colCount) {
              row++;
              col = 0;
            }
          } while (row < rowCount && columnMap[col] === null);
          if (row >= rowCount) {
            row = rowCount - 1;
            col = from.col;
          } // boundary check
        }
      }

      return { row, col };
    },
    laneOf(id) {
      return id.col;
    },
    resolveInRow(from, lane, dir) {
      const col = typeof lane === 'number' ? lane : from.col;
      const row =
        dir === 1
          ? Math.min(rowCount - 1, from.row + 1)
          : Math.max(0, from.row - 1);
      return { row, col };
    },
    isEditable(id) {
      return columnMap[id.col] != null;
    },
  };
}

/** A DOM nav cell: its element plus the parsed lane. */
export interface DomNavCell {
  el: HTMLElement;
  navid: string;
  lane: string | number;
}

export interface DomOrderNavResolverConfig {
  /** Container whose `[data-navid]` descendants form the ordered cell list. */
  containerRef: React.RefObject<HTMLElement | null>;
  /** The canonical left→right lane order within a row (for nearest-lane fallback). */
  navColOrder: readonly (string | number)[];
  /** Parse a navid into its `{ rowKey, colKey }`. colKey is the lane. */
  parseId: (navid: string) => { rowKey: string; colKey: string | number };
  /**
   * Adjacent-row resolution. Given the ordered cells, the current index, the
   * target lane, and a direction, return the target cell (prefer same lane, else
   * nearest by navColOrder). Injected so the Daily Block passes its own
   * findColInAdjacentRow logic. Returns null when no such row exists.
   */
  findColInAdjacentRow: (
    cells: DomNavCell[],
    idx: number,
    lane: string | number,
    dir: 1 | -1
  ) => DomNavCell | null;
}

/**
 * DOM-order resolver — the Daily Block's querySelectorAll + adjacent-row logic
 * (production-daily-block.tsx:562-636). Reads `[data-navid]` elements in document
 * order (NOTE: `[data-navid]` not `input[data-navid]` so it finds STATIC cells
 * too, which is required once cells are click-to-select rather than always-edit).
 * Tab / left / right walk the flat ordered list; up / down (and Enter-anchor via
 * resolveInRow) use findColInAdjacentRow. `Id` = the navid string.
 */
export function createDomOrderNavResolver(
  cfg: DomOrderNavResolverConfig
): NavResolver<string> {
  const { containerRef, parseId, findColInAdjacentRow } = cfg;

  const readCells = (): DomNavCell[] => {
    const root = containerRef.current;
    if (!root) return [];
    return Array.from(root.querySelectorAll<HTMLElement>('[data-navid]')).map(
      (el) => {
        const navid = el.dataset.navid as string;
        const { colKey } = parseId(navid);
        return { el, navid, lane: colKey };
      }
    );
  };

  return {
    resolve(from, move) {
      const cells = readCells();
      const idx = cells.findIndex((c) => c.navid === from);
      if (idx < 0) return null;
      const cur = cells[idx];

      if (move.kind === 'tab') {
        const next = move.shift ? cells[idx - 1] : cells[idx + 1];
        return next?.navid ?? null;
      }

      if (move.kind === 'enter') {
        const dir: 1 | -1 = move.shift ? -1 : 1;
        const cell = findColInAdjacentRow(cells, idx, cur.lane, dir);
        return cell?.navid ?? null;
      }

      // arrow
      if (move.dir === 'left' || move.dir === 'right') {
        const next = move.dir === 'right' ? cells[idx + 1] : cells[idx - 1];
        return next?.navid ?? null;
      }
      // up / down
      const dir: 1 | -1 = move.dir === 'down' ? 1 : -1;
      const cell = findColInAdjacentRow(cells, idx, cur.lane, dir);
      return cell?.navid ?? null;
    },
    laneOf(id) {
      return parseId(id).colKey;
    },
    resolveInRow(from, lane, dir) {
      const cells = readCells();
      const idx = cells.findIndex((c) => c.navid === from);
      if (idx < 0) return null;
      const cell = findColInAdjacentRow(cells, idx, lane, dir);
      return cell?.navid ?? null;
    },
    isEditable(id) {
      const root = containerRef.current;
      if (!root) return false;
      const el = root.querySelector<HTMLElement>(
        `[data-navid="${CSS.escape(id)}"]`
      );
      return !!el && el.dataset.locked === undefined;
    },
  };
}
