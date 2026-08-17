// ─────────────────────────────────────────────────────────────────────────────────
// Blackwood Table — unsaved state, and the undo journal. PLATFORM LAYER, pure.
//
// Two things live here, and the second one is the reason the first one is worth having
// exactly once:
//
//   • **What counts as unsaved.** One definition, so "the guard prompted while Save was
//     greyed out" is not a state the code can express.
//   • **The undo journal.** Google Sheets' single biggest advantage over this grid was a
//     real Ctrl+Z. It could not be retrofitted, because five different code paths wrote
//     cell state directly (an inline commit, a Delete, a paste, a domain "fill this
//     column" action, a draft-row clear). The journal only works if EVERY mutation goes
//     through one writer — so the journal is defined here, in the same file as the dirty
//     rules, and `use-table-edits.ts` is the single writer that feeds it.
// ─────────────────────────────────────────────────────────────────────────────────

import type { FieldEdits } from './types';

// ═══ Dirty state — an edit that undoes itself is not an edit ════════════════════

/**
 * Apply one cell's new text to a row's edit map — and DROP the field when the text is
 * back to what the store already holds.
 *
 * This is not a nicety. `useGridEditSession.revertChanges` cancels an Escape by calling
 * the setter with the pre-edit snapshot, which is a perfectly correct VALUE and a
 * perfectly wrong DIRTY STATE: the field stayed in the map, so the row stayed dirty, the
 * unsaved-count chip kept counting it and Save stayed enabled with nothing to write.
 * Removing the key here fixes Escape as a special case of the general rule — a cell
 * typed back to its stored value is not an edit, however it got there.
 *
 * Note the deliberate asymmetry: CLEARING a stored value IS an edit (it has to reach the
 * patch as an explicit blank), so only an exact match to the stored text clears the flag.
 */
export function mergeFieldEdit(
    current: FieldEdits | undefined,
    field: string,
    value: string,
    canonical: string,
): FieldEdits {
    const next: FieldEdits = { ...(current ?? {}) };
    if (value === canonical) delete next[field];
    else next[field] = value;
    return next;
}

/** Does this edit map hold anything worth saving? Whitespace alone does not count. */
export function isDirtyFieldEdits(edits: FieldEdits | undefined): boolean {
    if (!edits) return false;
    return Object.values(edits).some((v) => (v ?? '').trim() !== '');
}

// ═══ Unsaved work — what an axis change is about to destroy ═════════════════════
//
// Changing a URL axis (the scope, the period, a lens, the search, a column filter)
// REMOUNTS the grid against a window the server prefetched for the new axes, and every
// pending edit and typed blank row goes with it. So the grid guards those writes — and
// the guard must fire on EXACTLY the condition that lights the Save button, never a
// keystroke wider. A guard that cries wolf is the failure mode that gets guards ignored.
//
// The two kinds are counted SEPARATELY because they are different losses. An edited
// record still exists in the database with its old values; a typed blank row exists
// nowhere at all, and eight of them is a morning's work.

export interface UnsavedWork {
    /** Stored rows carrying unsaved cell edits. */
    editedRecords: number;
    /** Blank rows at the bottom the operator has typed real values into. */
    newRows: number;
    /** What the Save button, the unsaved chip and the axis guard all count. */
    total: number;
}

export function countUnsavedWork(
    dirtyRecords: ReadonlySet<string>,
    dirtyDrafts: ReadonlySet<string>,
): UnsavedWork {
    return {
        editedRecords: dirtyRecords.size,
        newRows: dirtyDrafts.size,
        total: dirtyRecords.size + dirtyDrafts.size,
    };
}

/** True exactly when the Save button is enabled. The guard's whole firing condition. */
export function hasUnsavedWork(work: UnsavedWork): boolean {
    return work.total > 0;
}

/** What each kind of loss is CALLED, so the prompt reads like the module it guards. */
export interface UnsavedNouns {
    /** Singular. Default `'edited row'`. */
    record?: string;
    /** Singular. Default `'typed new row'`. */
    draft?: string;
}

/**
 * The phrase the guard dialog names the stakes with. Both kinds when both exist, and
 * never a kind that is zero — "0 typed new rows" reads as a machine talking to itself
 * and buries the number that matters.
 */
export function describeUnsavedWork(work: UnsavedWork, nouns: UnsavedNouns = {}): string {
    const recordNoun = nouns.record ?? 'edited row';
    const draftNoun = nouns.draft ?? 'typed new row';
    const parts: string[] = [];
    if (work.editedRecords > 0) {
        parts.push(`${work.editedRecords} ${recordNoun}${work.editedRecords === 1 ? '' : 's'}`);
    }
    if (work.newRows > 0) {
        parts.push(`${work.newRows} ${draftNoun}${work.newRows === 1 ? '' : 's'}`);
    }
    if (parts.length === 0) return 'nothing unsaved';
    return parts.join(' and ');
}

// ═══ Draft rows (the blank rows at the bottom) ══════════════════════════════════
//
// Google Sheets keeps a run of blank rows under the last real one and an
// `Add [N] more rows` control under those. A draft is a fully addressable, fully
// editable row that simply has no id yet, and it becomes a real record through the SAME
// insert path as anything else. A draft the operator never touches is not saved and is
// not counted as unsaved.

export const DEFAULT_DRAFT_ROWS = 20;
/** Defensive ceiling on one "add more rows" click. */
export const MAX_DRAFT_ADD = 500;

export function clampDraftAdd(raw: string): number {
    const n = Number.parseInt(raw.trim(), 10);
    if (!Number.isFinite(n) || n < 1) return 1;
    return Math.min(n, MAX_DRAFT_ADD);
}

// ═══ The undo journal ═══════════════════════════════════════════════════════════

/** One cell's before/after. `undefined` means "the field was absent from the edit map". */
export interface CellMutation {
    rowId: string;
    field: string;
    before: string | undefined;
    after: string | undefined;
}

/**
 * One undoable gesture. A gesture, not a keystroke: a paste that touched 300 cells is
 * ONE step, because that is what the operator did and therefore what they expect one
 * Ctrl+Z to take back.
 */
export interface JournalStep {
    /** For debugging and for a future "Undo paste" affordance. */
    label: string;
    cells: CellMutation[];
    /**
     * Draft row ids this step brought into existence (a paste that ran past the end).
     * Undoing the step must remove them, or the sheet keeps blank rows nobody asked for.
     */
    draftsAdded?: string[];
}

export interface Journal {
    /** Record a gesture. Truncates the redo tail, as every undo stack does. */
    push(step: JournalStep): void;
    /** The step to INVERT, or null. The caller applies each cell's `before`. */
    undo(): JournalStep | null;
    /** The step to REAPPLY, or null. The caller applies each cell's `after`. */
    redo(): JournalStep | null;
    /** Forget everything — after a successful save, or an axis remount. */
    clear(): void;
    canUndo(): boolean;
    canRedo(): boolean;
    /** Stack depths, for assertions and for a debug readout. */
    size(): { undo: number; redo: number };
}

/** How many gestures are remembered. Deep enough to be useful, bounded so it cannot grow. */
export const JOURNAL_LIMIT = 200;

/**
 * A bounded undo/redo stack over cell mutations.
 *
 * It is deliberately IGNORANT of how edits are stored: it hands a step back and the
 * caller applies `before` (undo) or `after` (redo) through the same single writer every
 * other mutation goes through. That is what keeps undo from becoming a second definition
 * of "how a cell changes" — the failure this whole module exists to avoid.
 *
 * **Cleared on a successful save.** An undo that reached back past a save would have to
 * un-write the database; Sheets muscle memory tolerates losing the history there, and it
 * keeps the "N unsaved" count honest.
 */
export function createJournal(limit: number = JOURNAL_LIMIT): Journal {
    let past: JournalStep[] = [];
    let future: JournalStep[] = [];

    return {
        push(step) {
            // A step that changed nothing is not a step — otherwise a commit that merely
            // re-typed the same value would eat a Ctrl+Z.
            if (step.cells.length === 0 && (step.draftsAdded?.length ?? 0) === 0) return;
            past.push(step);
            if (past.length > limit) past = past.slice(past.length - limit);
            future = [];
        },
        undo() {
            const step = past.pop();
            if (!step) return null;
            future.push(step);
            return step;
        },
        redo() {
            const step = future.pop();
            if (!step) return null;
            past.push(step);
            return step;
        },
        clear() {
            past = [];
            future = [];
        },
        canUndo: () => past.length > 0,
        canRedo: () => future.length > 0,
        size: () => ({ undo: past.length, redo: future.length }),
    };
}

/**
 * Invert a step for application — the same list with `before` and `after` swapped.
 *
 * Provided so the caller has ONE way to express "apply this backwards" instead of
 * hand-writing the swap at each undo site, which is where an off-by-one direction bug
 * would live.
 */
export function invertStep(step: JournalStep): JournalStep {
    return {
        label: `undo:${step.label}`,
        cells: step.cells.map((c) => ({ ...c, before: c.after, after: c.before })),
        draftsAdded: step.draftsAdded,
    };
}
