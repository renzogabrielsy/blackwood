'use client';

import * as React from 'react';

import { createJournal, isDirtyFieldEdits, mergeFieldEdit } from '@/lib/table';
import type { CellMutation, FieldEdits, JournalStep } from '@/lib/table';

// ─────────────────────────────────────────────────────────────────────────────────
// useTableEdits — THE single writer for unsaved cell state. PLATFORM LAYER.
//
// Every mutation goes through `applyEdits`: an inline commit, a Delete, a paste, a
// fill, a clear-row, a revert, and undo/redo themselves. **A cell written anywhere else
// is a bug**, and the reason is not tidiness:
//
//   • **Undo only exists if there is one writer.** The grid this module was extracted
//     from could not have a Ctrl+Z retrofitted onto it, because five separate code paths
//     wrote cell state directly. A journal bolted onto one of them would have been a
//     second definition of "how a cell changes" that the other four silently bypassed.
//   • **"Dirty" only has one meaning if there is one writer.** Two of the audit's
//     findings (A6, A7) were mutations that skipped `mergeFieldEdit` and left rows
//     permanently unsaveable-clean — a row you could not stop counting as edited.
//
// So the writer does three things atomically, and nothing else may do any of them:
// route each cell through `mergeFieldEdit` (dirty state), record a journal step (undo),
// and publish one state update (the render boundary — one setState per GESTURE, not per
// cell; a 300-row paste that issued one updater per cell copied the whole edit map
// ~5,000 times).
// ─────────────────────────────────────────────────────────────────────────────────

/** One cell to write. `value` is the raw text the operator produced. */
export interface CellEdit {
    rowId: string;
    field: string;
    value: string;
}

export interface UseTableEditsInput {
    /**
     * The value the STORE holds for a cell — what the text must equal for the edit to
     * stop counting as unsaved. For a row that exists nowhere yet (a draft) this is
     * whatever the blank row was seeded with.
     */
    canonicalText(rowId: string, field: string): string;
    /** Which row ids are drafts, so the two dirty sets can be reported separately. */
    isDraft(rowId: string): boolean;
    /** Optional: told after every write, for a status bar or an axis guard. */
    onChange?(): void;
}

export interface TableEdits {
    /** Unsaved text, per row. Read-only to consumers — write through `applyEdits`. */
    edits: Readonly<Record<string, FieldEdits>>;
    /** The unsaved text for a cell, or the stored text when it has none. */
    cellText(rowId: string, field: string): string;
    /** THE writer. One call per gesture, whatever it touched. */
    applyEdits(cells: readonly CellEdit[], label: string, draftsAdded?: readonly string[]): void;
    /** Drop every unsaved value on a row (the context menu's "discard changes"). */
    revertRow(rowId: string): void;
    /** Forget everything — after a successful save, or an axis remount. */
    reset(): void;
    /** Stored rows with unsaved edits. */
    dirtyRecords: ReadonlySet<string>;
    /** Draft rows the operator has typed something real into. */
    dirtyDrafts: ReadonlySet<string>;
    undo(): JournalStep | null;
    redo(): JournalStep | null;
    canUndo: boolean;
    canRedo: boolean;
}

export function useTableEdits(input: UseTableEditsInput): TableEdits {
    const { canonicalText, isDraft, onChange } = input;

    const [edits, setEdits] = React.useState<Record<string, FieldEdits>>({});
    const journal = React.useMemo(() => createJournal(), []);
    // The journal is a stable MUTABLE object, so moving its stacks changes nothing React
    // can see. This forces the one re-render that refreshes `canUndo` / `canRedo` — a
    // reducer rather than a counter in state, so there is no value sitting unread.
    const [, bumpJournal] = React.useReducer((n: number) => n + 1, 0);

    // The current map, readable synchronously inside a handler that has already queued a
    // setState — a paste computes its own `before` values and must not read a stale map.
    //
    // Mirrored during render AND written by the writer itself, which is the same
    // discipline `use-cell-selection.ts` uses for its anchor/focus refs, and for the same
    // reason: a handler that reads a ref React has not committed yet takes the previous
    // value and silently computes the wrong `before`. The render-time mirror is the
    // fallback; the write-time assignment is what makes two gestures in one event batch
    // correct.
    const editsRef = React.useRef(edits);
    // eslint-disable-next-line react-hooks/refs
    editsRef.current = edits;

    const cellText = React.useCallback(
        (rowId: string, field: string): string => {
            const unsaved = editsRef.current[rowId]?.[field];
            return unsaved !== undefined ? unsaved : canonicalText(rowId, field);
        },
        [canonicalText],
    );

    /**
     * Apply a set of cell writes as ONE gesture.
     *
     * `record: false` is used by undo/redo, which are re-applying a step that is already
     * in the journal — recording them again would make Ctrl+Z push its own undo step and
     * the stack would never drain.
     */
    const write = React.useCallback(
        (
            cells: readonly CellEdit[],
            label: string,
            draftsAdded: readonly string[] | undefined,
            record: boolean,
        ) => {
            if (cells.length === 0 && (draftsAdded?.length ?? 0) === 0) return;

            const before = editsRef.current;
            const mutations: CellMutation[] = [];
            const next: Record<string, FieldEdits> = { ...before };

            for (const { rowId, field, value } of cells) {
                const prior = next[rowId]?.[field];
                const merged = mergeFieldEdit(next[rowId], field, value, canonicalText(rowId, field));
                const after = merged[field];
                // A write that changed nothing contributes no mutation — so a commit
                // that re-typed the same value cannot eat a Ctrl+Z.
                if (prior !== after) mutations.push({ rowId, field, before: prior, after });
                if (Object.keys(merged).length === 0) delete next[rowId];
                else next[rowId] = merged;
            }

            if (mutations.length === 0 && (draftsAdded?.length ?? 0) === 0) return;

            if (record) {
                journal.push({ label, cells: mutations, draftsAdded: draftsAdded ? [...draftsAdded] : undefined });
                bumpJournal();
            }

            editsRef.current = next;
            setEdits(next);
            onChange?.();
        },
        [canonicalText, journal, onChange, bumpJournal],
    );

    const applyEdits = React.useCallback(
        (cells: readonly CellEdit[], label: string, draftsAdded?: readonly string[]) =>
            write(cells, label, draftsAdded, true),
        [write],
    );

    /**
     * Undo / redo re-enter the same writer with `record: false`.
     *
     * A step's cells carry `before`/`after` as "the value in the EDIT MAP", where
     * `undefined` means the field was absent. The writer takes text, so an absent field
     * is expressed as the canonical text — which `mergeFieldEdit` then drops again,
     * restoring exactly the state that existed. One path, no inverse implementation.
     */
    const applyStep = React.useCallback(
        (step: JournalStep, direction: 'before' | 'after') => {
            const cells = step.cells.map((c) => ({
                rowId: c.rowId,
                field: c.field,
                value: c[direction] ?? canonicalText(c.rowId, c.field),
            }));
            write(cells, `${direction === 'before' ? 'undo' : 'redo'}:${step.label}`, undefined, false);
        },
        [canonicalText, write],
    );

    const undo = React.useCallback((): JournalStep | null => {
        const step = journal.undo();
        if (!step) return null;
        applyStep(step, 'before');
        bumpJournal();
        return step;
    }, [journal, applyStep, bumpJournal]);

    const redo = React.useCallback((): JournalStep | null => {
        const step = journal.redo();
        if (!step) return null;
        applyStep(step, 'after');
        bumpJournal();
        return step;
    }, [journal, applyStep, bumpJournal]);

    const revertRow = React.useCallback(
        (rowId: string) => {
            const rowEdits = editsRef.current[rowId];
            if (!rowEdits) return;
            // Expressed as ordinary writes back to canonical, so it is journalled and
            // undoable like everything else — not a special case that clears state behind
            // the journal's back.
            applyEdits(
                Object.keys(rowEdits).map((field) => ({
                    rowId,
                    field,
                    value: canonicalText(rowId, field),
                })),
                'revert-row',
            );
        },
        [applyEdits, canonicalText],
    );

    const reset = React.useCallback(() => {
        journal.clear();
        bumpJournal();
        editsRef.current = {};
        setEdits({});
        onChange?.();
    }, [journal, onChange, bumpJournal]);

    const { dirtyRecords, dirtyDrafts } = React.useMemo(() => {
        const records = new Set<string>();
        const drafts = new Set<string>();
        for (const [rowId, rowEdits] of Object.entries(edits)) {
            if (isDraft(rowId)) {
                // An untouched blank row is not unsaved work — whitespace does not count.
                if (isDirtyFieldEdits(rowEdits)) drafts.add(rowId);
            } else if (Object.keys(rowEdits).length > 0) {
                records.add(rowId);
            }
        }
        return { dirtyRecords: records, dirtyDrafts: drafts };
    }, [edits, isDraft]);

    return {
        edits,
        cellText,
        applyEdits,
        revertRow,
        reset,
        dirtyRecords,
        dirtyDrafts,
        undo,
        redo,
        // Read straight off the journal during render — `bumpJournal` above is what makes
        // that read fresh. No memo: a boolean read is cheaper than the memo caching it.
        canUndo: journal.canUndo(),
        canRedo: journal.canRedo(),
    };
}
