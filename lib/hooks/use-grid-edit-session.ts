'use client';

import * as React from 'react';

// ─────────────────────────────────────────────────────────────────────────────
// useGridEditSession — owns the inline-edit flag + the pre-edit snapshot.
//
// Lifted from bulk-delivery-input.tsx (:290-324): startEditing captures the
// current value BEFORE the edit (for revert) and optionally seeds a type-over
// char; revertChanges restores that snapshot. Generalized via injected
// getValue/setValue so it works for any cell-id type.
//
// NOTE: the active-cell STATE stays in the consuming grid (it is shared with the
// keyboard-nav hook and selection). This hook owns ONLY `isEditing` + the
// pre-edit snapshot. Callers pass the cell id explicitly into start/commit/revert
// so the hook never needs to know how the active cell is stored.
// ─────────────────────────────────────────────────────────────────────────────

export interface GridEditSessionConfig<Id> {
  /** Read the current string value of a cell. */
  getValue: (id: Id) => string;
  /** Write a string value to a cell. */
  setValue: (id: Id, value: string) => void;
  /** Called after a successful commit (e.g. focus management, popovers). */
  onAfterCommit?: () => void;
}

export interface GridEditSession<Id> {
  /** Whether an editor is currently mounted. */
  isEditing: boolean;
  /** The cell id currently being edited, or null. */
  activeForCommit: Id | null;
  /** Begin editing a cell, snapshotting its value; optional type-over char. */
  startEditing: (id: Id, char?: string) => void;
  /** Revert to the pre-edit snapshot and exit edit mode. */
  revertChanges: () => void;
  /** Exit edit mode, keeping the current value (commit). */
  commit: () => void;
  /** The pre-edit value snapshot (null when nothing has been captured). */
  preEditValueRef: React.RefObject<string | null>;
}

export function useGridEditSession<Id>(
  cfg: GridEditSessionConfig<Id>
): GridEditSession<Id> {
  const { getValue, setValue, onAfterCommit } = cfg;

  const [isEditing, setIsEditing] = React.useState(false);
  const [activeForCommit, setActiveForCommit] = React.useState<Id | null>(null);
  const preEditValueRef = React.useRef<string | null>(null);

  const startEditing = React.useCallback(
    (id: Id, char?: string) => {
      // 1. Capture current value BEFORE any edit.
      preEditValueRef.current = getValue(id);

      // 2. Enter edit mode for this cell.
      setActiveForCommit(id);
      setIsEditing(true);

      // 3. Optional type-over: seed the cell with the typed char.
      if (char !== undefined) {
        setValue(id, char);
      }
    },
    [getValue, setValue]
  );

  const revertChanges = React.useCallback(() => {
    if (activeForCommit !== null && preEditValueRef.current !== null) {
      setValue(activeForCommit, preEditValueRef.current);
    }
    setIsEditing(false);
  }, [activeForCommit, setValue]);

  const commit = React.useCallback(() => {
    setIsEditing(false);
    onAfterCommit?.();
  }, [onAfterCommit]);

  return {
    isEditing,
    activeForCommit,
    startEditing,
    revertChanges,
    commit,
    preEditValueRef,
  };
}
