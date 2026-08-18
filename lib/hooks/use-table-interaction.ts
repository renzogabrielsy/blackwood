'use client';

import * as React from 'react';
import { toast } from 'sonner';

import {
    MAX_DRAFT_ADD,
    columnScrollLeft,
    dragAutoScrollDelta,
    edgeJump,
    pageJump,
    parseClipboardTable,
    planPaste,
    pasteRowTargets,
    rowEdge,
    sheetCorner,
    tilePaste,
    tsvEscape,
} from '@/lib/table';
import type { CellAddress, CellContext, CellSlot, ColumnSpec, JumpDir, JumpGrid } from '@/lib/table';
import { errorToast } from '@/lib/toast';
import { focusGrid, isGridChrome } from '@/components/shared/table/PasteSink';
import type { RowHandlers } from '@/components/shared/table/Row';
import { useCellAggregation } from '@/lib/hooks/use-cell-aggregation';
import type { AggregationType, CellAggregates } from '@/lib/hooks/use-cell-aggregation';
import { useCellSelection } from '@/lib/hooks/use-cell-selection';
import type { CellRange } from '@/lib/hooks/use-cell-selection';
import { useGridEditSession } from '@/lib/hooks/use-grid-edit-session';
import { useGridKeyboardNav } from '@/lib/hooks/use-grid-keyboard-nav';
import type { ResolvedColumns } from '@/lib/hooks/use-table-columns';
import type { CellEdit, TableEdits } from '@/lib/hooks/use-table-edits';
import { columnAcceptsEdit, columnSelectable, createTableNavResolver } from '@/lib/hooks/use-table-rows';
import type { ResolvedRows } from '@/lib/hooks/use-table-rows';

// ─────────────────────────────────────────────────────────────────────────────────
// useTableInteraction — every gesture the sheet answers to, composed once. PLATFORM.
//
// This hook invents nothing. It COMPOSES the platform hooks that already exist
// (`useGridKeyboardNav`, `useGridEditSession`, `useCellSelection`, `useCellAggregation`)
// over the pure helpers in `@/lib/table`, and its whole value is that the composition
// exists in exactly one place. Every grid in this codebase re-wired those four by hand,
// and each of them got a different subset of the same bugs.
//
// The five fixed HERE rather than in any of them:
//
//   1. **Ctrl/Cmd+Arrow, Home/End, PageUp/PageDown did nothing.** `NAV_KEYS.includes(key)`
//      is tested by the shared nav hook BEFORE any modifier, so Ctrl+Arrow was handled as
//      a plain arrow. Every jump is therefore resolved HERE, ahead of the delegation.
//   2. **There was no Ctrl+Z.** It could not be retrofitted onto a grid with five writers;
//      `useTableEdits` is the one writer, so undo is four lines.
//   3. **Ctrl/Cmd+C on a SINGLE cell reached nothing** — the shared hook's copy branch is
//      inside `if (range.isRangeSelected)`, which means size > 1.
//   4. **Paste was dead** on any grid whose cells are non-editable divs. See `PasteSink`:
//      a `paste` event is dispatched at an element that can ACCEPT one, so a focused
//      `<div tabIndex={-1}>` gets nothing and `document.body` gets it instead — and body
//      is an ANCESTOR of React's root, so no React handler can ever see it. Two delivery
//      paths, two interlocks against a double-apply.
//   5. **Every scroll moved the page.** `focus()` scrolls every ancestor with block AND
//      inline `"center"`, and `scrollIntoView({block:'center'})` re-centres a row that is
//      already fully visible. Both are banned; the caret is followed by arithmetic on the
//      table's own scroller, and every `.focus()` passes `preventScroll`.
//
// ── ONE STRUCTURAL RULE RUNS THROUGH THE WHOLE FILE ─────────────────────────────
//
// Every hook it composes returns a FRESH OBJECT each render while its individual members
// are `useCallback`'d and stable. So this file destructures the members and never depends
// on the container — `edits.cellText`, not `edits`. Depending on the object would give
// every derived callback a new identity on every render, `renderEditor` with it, and the
// row memo would compare unequal for every row of the sheet on every keystroke: a memo
// that is a lie, costing a comparison and saving nothing. That is exactly the failure the
// module was built to end, and it is invisible unless you look for it.
// ─────────────────────────────────────────────────────────────────────────────────

const ARROW_KEYS = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight']);

const ARROW_DIR: Record<string, JumpDir> = {
    ArrowUp: 'up',
    ArrowDown: 'down',
    ArrowLeft: 'left',
    ArrowRight: 'right',
};

/**
 * A left-click that never happened.
 *
 * `useCellSelection` only exposes its anchor through `handleCellMouseDown`, so seeding a
 * selection from the KEYBOARD has to speak that API. Both fields it reads are supplied;
 * the alternative is a second way to set an anchor, which is how the anchor and the caret
 * ended up disagreeing in the first place.
 */
const SYNTHETIC_LEFT_CLICK = { button: 0, shiftKey: false } as unknown as React.MouseEvent;

/** A viewport height to fall back on before the scroller has been measured. */
const FALLBACK_VIEWPORT_PX = 400;

export interface UseTableInteractionInput<Row, Ctx> {
    rows: ResolvedRows<Row>;
    columns: ResolvedColumns<Row, Ctx>;
    /** Must be referentially stable — every editability verdict is memoized against it. */
    ctx: Ctx;
    /** THE single writer. Every mutation below goes through `edits.applyEdits`. */
    edits: TableEdits;
    /**
     * The value the STORE holds for a cell — **the same function handed to
     * `useTableEdits` as `canonicalText`**. One function, two readers: if a column
     * declares `editText`, the consumer folds it in there, so the text an editor opens
     * with and the text that decides "is this cell still dirty" can never disagree.
     */
    storedText(rowId: string, field: string): string;
    /** The element that scrolls in both axes. A callback because a scope may swap it. */
    scrollerEl(): HTMLElement | null;
    /**
     * Scroll a row into view by its `items` index — the virtualiser's own API.
     *
     * **The index is RAW** (the array position), never rebased by `firstItemIndex`:
     * virtuoso offsets only the index it reports OUT, and both inbound scroll APIs clamp
     * against `totalCount`, so a rebased index collapses onto the last row every time.
     * Absent ⇒ the plain-table path (arithmetic on the scroller's own `scrollTop`).
     */
    scrollToIndex?(itemIndex: number): void;
    /** Are blank rows on screen at all? A filtered view has none, so nothing may grow. */
    canCreateRows?: boolean;
    /** Append N blank rows; returns their ids in order so an undo can take them away. */
    onAddDrafts?(count: number): string[];
    /** Remove the blank rows an UNDONE gesture created. */
    onRemoveDrafts?(ids: readonly string[]): void;
    /** Put back the blank rows a REDONE gesture had created. */
    onRestoreDrafts?(ids: readonly string[]): void;
    /** The row-kind key a blank row has, so a paste can address one before it exists. */
    draftKind?: string;
    /** Which row kinds are CHILDREN — a paste anchored on one may never reach a parent. */
    childKinds?: readonly string[];
    /** A commit was refused (or accepted): mark the cell, or clear the mark. */
    onInvalid?(rowId: string, colKey: string, invalid: boolean): void;
    /** Right-click on a cell, for a consumer-owned context menu. */
    onContextMenu?(cell: CellAddress, e: React.MouseEvent): void;
    /** Told whenever the rectangular selection changes — a floating pill, a status bar. */
    onSelectionChange?(range: CellRange | null): void;
}

export interface TableInteraction {
    activeCell: CellAddress | null;
    setActiveCell(cell: CellAddress | null): void;
    isEditing: boolean;
    /** Spread on the grid wrapper: the ref, the focus target, the gesture handlers. */
    gridProps: {
        ref: React.RefObject<HTMLDivElement | null>;
        tabIndex: number;
        onKeyDown(e: React.KeyboardEvent): void;
        onPaste(e: React.ClipboardEvent): void;
        onMouseUp(): void;
    };
    /** Spread on `<PasteSink>`. Carries no `onKeyDown` — keydown bubbles to the wrapper. */
    sinkProps: {
        ref: React.RefObject<HTMLTextAreaElement | null>;
        onPaste(e: React.ClipboardEvent<HTMLTextAreaElement>): void;
    };
    onKeyDown(e: React.KeyboardEvent): void;
    onPaste(e: React.ClipboardEvent): void;
    selection: {
        range: CellRange | null;
        size: number;
        /** `[fromCol, toCol]` of the band on this row, or null. Fed straight to a row. */
        bandFor(navRow: number): readonly [number, number] | null;
        clear(): void;
        selectAll(): void;
        selectColumn(col: number): void;
        isDragging: boolean;
        aggregates: CellAggregates | null;
    };
    scrollTo(navRow: number): void;
    scrollToCol(col: number): void;
    /** ONE bundle for the whole table — 4 closures, not 4 per cell. */
    rowHandlers: RowHandlers;
    /** The text a mounting editor should OPEN with — the seed char, or the cell's value. */
    editorInitialText(): string;
    /** What an open editor reports as the operator types. A ref write; nothing renders. */
    setEditorText(text: string): void;
    /** The text a cell holds at rest — the unsaved value if it has one, else the stored. */
    cellText(cell: CellAddress): string;
    setCellText(cell: CellAddress, value: string): void;
    /** Write the open editor's text as ONE gesture and close it. */
    commitEdit(): void;
    /** Put focus where the grid hears both a keydown AND a paste. Always preventScroll. */
    focus(): void;
    /** Combined verdict: the row family's answer AND the column's. */
    isEditable(navRow: number, col: number): boolean;
}

export function useTableInteraction<Row, Ctx>(
    input: UseTableInteractionInput<Row, Ctx>,
): TableInteraction {
    const {
        rows, columns, ctx, edits, storedText, scrollerEl, scrollToIndex,
        canCreateRows = false, onAddDrafts, onRemoveDrafts, onRestoreDrafts,
        draftKind = 'draft', childKinds, onInvalid, onContextMenu, onSelectionChange,
    } = input;

    // See the structural rule in the header: the MEMBERS, never the container.
    const { applyEdits, cellText: storeCellText, edits: editMap, undo, redo } = edits;

    const cols = columns.cols;
    const colCount = cols.length;
    const rowCount = rows.navRows.length;

    const gridRef = React.useRef<HTMLDivElement | null>(null);
    const sinkRef = React.useRef<HTMLTextAreaElement | null>(null);

    const [activeCell, setActiveCellState] = React.useState<CellAddress | null>(null);
    const activeRef = React.useRef<CellAddress | null>(activeCell);
    // eslint-disable-next-line react-hooks/refs
    activeRef.current = activeCell;

    const focus = React.useCallback(() => {
        focusGrid(sinkRef.current, gridRef.current);
    }, []);

    const setActiveCell = React.useCallback((cell: CellAddress | null) => {
        setActiveCellState(cell);
        activeRef.current = cell;
    }, []);

    // ═══ Addressing ══════════════════════════════════════════════════════════════

    /** The row + column + field a coordinate names, or null where no cell exists. */
    const slotAt = React.useCallback(
        (cell: CellAddress) => {
            const nav = rows.navRows[cell.row];
            const spec = cols[cell.col] as ColumnSpec<Row, Ctx> | undefined;
            if (!nav || !spec) return null;
            const slot = nav.kind.occupies(spec.key, nav.data);
            if (!slot) return null;
            return { nav, spec, field: slot.field, editable: slot.editable };
        },
        [rows, cols],
    );

    /**
     * WHICH cell a column-level verdict is about — see `CellContext`.
     *
     * Built here, from the slot, so `parse` and `normalize` can never be handed a
     * different answer than the one every edit is filed under. It matters because a column
     * is not the same thing on every row family: `occupies()` may name a different `field`
     * on a child row, and a verdict blind to that refuses text that is legal there.
     */
    const cellContextOf = React.useCallback(
        (at: NonNullable<ReturnType<typeof slotAt>>): CellContext<Row> => ({
            field: at.field,
            kind: at.nav.kind.kind,
            rowId: at.nav.rowId,
            row: at.nav.data,
        }),
        [],
    );

    /**
     * May this cell be edited? The row family's answer AND the column's, combined here
     * and only here — see `columnAcceptsEdit` for why they are two different questions.
     */
    const isEditable = React.useCallback(
        (navRow: number, col: number): boolean => {
            const at = slotAt({ row: navRow, col });
            if (!at || !at.editable) return false;
            return columnAcceptsEdit(at.spec, at.nav.data, ctx);
        },
        [slotAt, ctx],
    );

    const cellText = React.useCallback(
        (cell: CellAddress): string => {
            const at = slotAt(cell);
            return at ? storeCellText(at.nav.rowId, at.field) : '';
        },
        [slotAt, storeCellText],
    );

    const setCellText = React.useCallback(
        (cell: CellAddress, value: string) => {
            const at = slotAt(cell);
            if (!at) return;
            applyEdits([{ rowId: at.nav.rowId, field: at.field, value }], 'type');
        },
        [slotAt, applyEdits],
    );

    // ═══ Edit session ════════════════════════════════════════════════════════════

    const validateOnCommit = React.useCallback(
        (cell: CellAddress) => {
            const at = slotAt(cell);
            if (!at || !at.spec.parse) return;
            const text = storeCellText(at.nav.rowId, at.field);
            const verdict = at.spec.parse(text, ctx, cellContextOf(at));
            if (verdict.ok) {
                onInvalid?.(at.nav.rowId, at.spec.key, false);
                return;
            }
            // The cell KEEPS the operator's text and stays dirty — a refusal never writes
            // a silent zero and never throws away what they typed.
            onInvalid?.(at.nav.rowId, at.spec.key, true);
            errorToast(`${at.spec.label} could not be read.`, {
                description: `You typed: ${text}\n\n${verdict.error}\n\nThe cell keeps your text — nothing was written.`,
            });
        },
        [slotAt, storeCellText, ctx, onInvalid, cellContextOf],
    );

    /**
     * A commit can arrive twice for one edit — a click on another cell commits, and the
     * editor's own `blur` follows it out. The verdict is idempotent per (cell, text) so
     * a refusal raises ONE toast, and the token is cleared when a new edit starts.
     */
    const validatedRef = React.useRef('');

    const onAfterCommit = React.useCallback(() => {
        const id = activeRef.current;
        if (!id) return;
        const token = `${id.row}:${id.col}:${cellText(id)}`;
        if (validatedRef.current === token) return;
        validatedRef.current = token;
        validateOnCommit(id);
    }, [cellText, validateOnCommit]);

    const edit = useGridEditSession<CellAddress>({
        getValue: cellText,
        setValue: setCellText,
        onAfterCommit,
    });
    const { isEditing, startEditing, revertChanges, commit } = edit;

    /**
     * The open editor's text, held in a REF rather than in the edit map.
     *
     * **An edit session is ONE gesture, so it is ONE journal entry and ONE write.** The
     * obvious wiring — the editor's `onChange` calling `applyEdits` — makes every
     * keystroke a separate undo step (Ctrl+Z after typing `newvalue` would take back the
     * `e`), and it also rewrites the whole edit map and re-renders the sheet on every
     * character, which is the exact cost this module exists to remove.
     *
     * So the editor owns its own text from the moment it opens, publishes it here on each
     * keystroke (a ref write — no render), and the grid learns it once, at COMMIT.
     * Escape needs no special case: nothing was ever written, so `revertChanges` writing
     * the pre-edit snapshot back is a no-op that journals nothing.
     */
    const draftRef = React.useRef<{ cell: CellAddress; text: string } | null>(null);

    const startEdit = React.useCallback(
        (id: CellAddress, char?: string) => {
            validatedRef.current = '';
            // A printable character REPLACES the value; Enter / F2 / double-click preserve it.
            draftRef.current = { cell: id, text: char !== undefined ? char : cellText(id) };
            // Deliberately without `char`: the session must not write it, or a type-over
            // would cost two journal steps instead of one.
            startEditing(id);
        },
        [startEditing, cellText],
    );

    /** The text an editor should OPEN with. Read once, when it mounts. */
    const editorInitialText = React.useCallback(() => draftRef.current?.text ?? '', []);

    /** What the editor reports as the operator types. A ref write, so nothing re-renders. */
    const setEditorText = React.useCallback((text: string) => {
        if (draftRef.current) draftRef.current.text = text;
    }, []);

    const commitEdit = React.useCallback(() => {
        const draft = draftRef.current;
        draftRef.current = null;
        if (draft) {
            // ── The column canonicalises what was typed, ONCE, and HERE ──────────
            // Every commit path funnels through this function — Enter, Tab, a click on
            // another cell (which `preventDefault`s the mousedown, so the editor never
            // blurs), a blur out of the grid, an arrow that commits and moves. Doing it in
            // the editor instead would cover some of those and silently miss the rest, and
            // doing it after the write would cost a second journal step.
            //
            // It is a rewrite, never a refusal: `commit()` below runs `parse` on whatever
            // this produced, so an unreadable value is still kept verbatim and still
            // refused by name.
            const at = slotAt(draft.cell);
            const text = at?.spec.normalize
                ? at.spec.normalize(draft.text, ctx, cellContextOf(at))
                : draft.text;
            // The write comes FIRST: `commit()` runs the parse verdict, which has to read
            // the value the operator actually left in the cell.
            setCellText(draft.cell, text);
        }
        commit();
    }, [setCellText, commit, slotAt, ctx, cellContextOf]);

    const revertEdit = React.useCallback(() => {
        draftRef.current = null;
        revertChanges();
    }, [revertChanges]);

    /** `isEditing`, readable from a plain DOM listener — synced during RENDER. */
    const editingRef = React.useRef(false);
    // eslint-disable-next-line react-hooks/refs
    editingRef.current = isEditing;

    // ═══ Selection ═══════════════════════════════════════════════════════════════

    const selectableCol = React.useCallback(
        (col: number) => {
            const spec = cols[col];
            return spec ? columnSelectable(spec) : false;
        },
        [cols],
    );

    // `scrollContainerRef` is deliberately NOT passed: it takes ONE ref object, and the
    // scroller can differ per scope, so whichever were handed in would be null in the
    // other. The drag auto-scroll is driven below off `scrollerEl()` instead, which also
    // lets the horizontal band respect the pinned blocks.
    const selection = useCellSelection({
        rowCount,
        colCount,
        isSelectableColumn: selectableCol,
        onSelectionChange,
        enabled: true,
    });
    const {
        handleCellMouseDown, handleCellMouseEnter, handleMouseUp,
        clearSelection, handleKeyDown: extendSelection, isDragging,
    } = selection;

    // ── THE RANGE, WITH A STABLE IDENTITY ────────────────────────────────────────
    // `useCellSelection` rebuilds its range object on EVERY render (it is derived inline
    // from two pieces of state), so anything memoized against it re-runs on every render
    // whether or not the selection moved — the aggregation over a 300-cell rectangle
    // included. Rebuilt here from four PRIMITIVES instead, so the identity changes when
    // the numbers change and at no other time.
    const raw = selection.range;
    const hasRange = raw !== null;
    const startRow = raw?.startRow ?? -1;
    const startCol = raw?.startCol ?? -1;
    const endRow = raw?.endRow ?? -1;
    const endCol = raw?.endCol ?? -1;

    const selectionRange = React.useMemo<CellRange | null>(
        () => (hasRange ? { startRow, startCol, endRow, endCol } : null),
        [hasRange, startRow, startCol, endRow, endCol],
    );

    const seedSelection = React.useCallback(
        (cell: CellAddress) => {
            handleCellMouseDown(cell.row, cell.col, SYNTHETIC_LEFT_CLICK);
            // The mouse is not down: end the drag in the same tick, so the auto-scroll
            // effect below never sees a drag that is not happening.
            handleMouseUp();
        },
        [handleCellMouseDown, handleMouseUp],
    );

    // ═══ Following the caret — and moving NOTHING else ═══════════════════════════

    const scrollTo = React.useCallback(
        (navRow: number) => {
            const index = rows.itemIndexOfNav.get(navRow);
            if (index === undefined) return;

            if (scrollToIndex) {
                // RAW array position. See the note on `scrollToIndex` in the input type.
                scrollToIndex(index);
                return;
            }

            const scroller = scrollerEl();
            const el = scroller?.querySelector<HTMLElement>(`[data-nav-row="${navRow}"]`);
            if (!scroller || !el) return;

            // A sticky <thead> and a sticky <tfoot> sit OVER the scrolling rows, so the
            // genuinely visible band is the scrollport minus both. Landing a row flush
            // against `scrollTop` would tuck it under the header.
            const box = scroller.getBoundingClientRect();
            const headH = scroller.querySelector('thead')?.getBoundingClientRect().height ?? 0;
            const footH = scroller.querySelector('tfoot')?.getBoundingClientRect().height ?? 0;
            const r = el.getBoundingClientRect();
            const top = box.top + headH;
            const bottom = box.bottom - footH;

            // Minimum nudge, instant, and only on the axis that owes something.
            if (r.top < top) scroller.scrollTop -= top - r.top;
            else if (r.bottom > bottom) scroller.scrollTop += r.bottom - bottom;
        },
        [rows, scrollToIndex, scrollerEl],
    );

    const scrollToCol = React.useCallback(
        (col: number) => {
            const scroller = scrollerEl();
            if (!scroller) return;
            const next = columnScrollLeft({
                col,
                cols,
                scrollLeft: scroller.scrollLeft,
                clientWidth: scroller.clientWidth,
                scrollWidth: scroller.scrollWidth,
            });
            // Assignment is instant by construction — a smooth scroll under fast Tab entry
            // is its own bug.
            if (next !== null) scroller.scrollLeft = next;
        },
        [scrollerEl, cols],
    );

    /** Move the caret, take the 1×1 selection with it, follow it, keep focus. */
    const placeCaret = React.useCallback(
        (cell: CellAddress) => {
            setActiveCell(cell);
            seedSelection(cell);
            scrollTo(cell.row);
            scrollToCol(cell.col);
            focus();
        },
        [setActiveCell, seedSelection, scrollTo, scrollToCol, focus],
    );

    // ═══ Drag auto-scroll ════════════════════════════════════════════════════════
    //
    // The pinned blocks are WALLS, not scroll positions: a pointer 100px in from the left
    // edge is not near an edge, it is sitting ON the pinned columns with scrolling cells
    // hidden underneath. Both bands are therefore measured from the INNER edge of their
    // block, exactly as `columnScrollLeft` measures its visible window.

    const pinnedStart = columns.pinnedWidths.start;
    const pinnedEnd = columns.pinnedWidths.end;

    React.useEffect(() => {
        if (!isDragging) return;
        const scroller = scrollerEl();
        if (!scroller) return;

        // Cached once, at the start of the drag: the scroller does not move while the
        // pointer is down, and reading a rect per frame is a forced reflow per frame.
        const r = scroller.getBoundingClientRect();
        const rect = { top: r.top, bottom: r.bottom, left: r.left, right: r.right };

        let raf = 0;
        let pointer: { x: number; y: number } | null = null;

        const delta = (p: { x: number; y: number }) =>
            dragAutoScrollDelta({
                pointer: p,
                rect,
                pinnedStart,
                pinnedEnd,
                scrollTop: scroller.scrollTop,
                scrollLeft: scroller.scrollLeft,
                maxScrollTop: Math.max(0, scroller.scrollHeight - scroller.clientHeight),
                maxScrollLeft: Math.max(0, scroller.scrollWidth - scroller.clientWidth),
            });

        // Scheduled ONLY while the pointer owes a scroll. An unconditional
        // `requestAnimationFrame` chain runs a frame callback for the whole drag even when
        // the pointer is sitting still in the middle of the sheet.
        const schedule = () => {
            if (raf === 0) raf = requestAnimationFrame(step);
        };

        function step() {
            raf = 0;
            if (!pointer) return;
            const { dx, dy } = delta(pointer);
            if (dx === 0 && dy === 0) return; // out of the band ⇒ the loop STOPS
            scroller!.scrollTop += dy;
            scroller!.scrollLeft += dx;
            schedule();
        }

        const onPointerMove = (e: PointerEvent) => {
            pointer = { x: e.clientX, y: e.clientY };
            const { dx, dy } = delta(pointer);
            if (dx !== 0 || dy !== 0) schedule();
        };

        document.addEventListener('pointermove', onPointerMove);
        return () => {
            document.removeEventListener('pointermove', onPointerMove);
            if (raf !== 0) cancelAnimationFrame(raf);
        };
    }, [isDragging, scrollerEl, pinnedStart, pinnedEnd]);

    // ═══ Clipboard OUT ═══════════════════════════════════════════════════════════

    /** What a COPY puts on the clipboard — the STORED value, never the edit text. */
    const clipboardTextAt = React.useCallback(
        (navRow: number, col: number): string => {
            const at = slotAt({ row: navRow, col });
            if (!at) return '';
            if (at.nav.data === null) {
                // A row that exists nowhere yet has nothing stored, so the operator's own
                // text is the only truth there. Inventing a figure is the arithmetic this
                // module refuses to do.
                return storeCellText(at.nav.rowId, at.field);
            }
            if (at.spec.clipboardValue) return at.spec.clipboardValue(at.nav.data);
            return storedText(at.nav.rowId, at.field);
        },
        [slotAt, storeCellText, storedText],
    );

    const copySelection = React.useCallback(() => {
        const active = activeRef.current;
        const range: CellRange | null =
            selectionRange ??
            (active
                ? { startRow: active.row, startCol: active.col, endRow: active.row, endCol: active.col }
                : null);
        if (!range) {
            errorToast('Nothing was copied — no cell is selected.');
            return;
        }

        const lines: string[] = [];
        for (let r = range.startRow; r <= range.endRow; r++) {
            const cells: string[] = [];
            for (let c = range.startCol; c <= range.endCol; c++) {
                cells.push(tsvEscape(clipboardTextAt(r, c)));
            }
            lines.push(cells.join('\t'));
        }
        const payload = lines.join('\n');
        const count = (range.endRow - range.startRow + 1) * (range.endCol - range.startCol + 1);

        // A refused clipboard write says so. Without a rejection handler an insecure
        // origin or an unfocused document is an unhandled promise and a silent no-op.
        void navigator.clipboard.writeText(payload).then(
            () => toast.success(count === 1 ? 'Copied 1 cell' : `Copied ${count} cells`),
            (err: unknown) =>
                errorToast('The copy could not be written to the clipboard.', {
                    description: err instanceof Error ? err.message : String(err),
                }),
        );
    }, [selectionRange, clipboardTextAt]);

    /** Sweep a rectangle through the ONE anchor/focus pair, never a second setter. */
    const sweep = React.useCallback(
        (from: CellAddress, to: CellAddress) => {
            handleCellMouseDown(from.row, from.col, SYNTHETIC_LEFT_CLICK);
            handleCellMouseEnter(to.row, to.col);
            handleMouseUp();
        },
        [handleCellMouseDown, handleCellMouseEnter, handleMouseUp],
    );

    const selectableBounds = React.useCallback((): [number, number] | null => {
        let first = -1;
        let last = -1;
        for (let c = 0; c < colCount; c++) {
            if (!selectableCol(c)) continue;
            if (first < 0) first = c;
            last = c;
        }
        return first < 0 ? null : [first, last];
    }, [colCount, selectableCol]);

    const selectAllCells = React.useCallback(() => {
        if (rowCount === 0) return;
        const bounds = selectableBounds();
        if (!bounds) return;
        // Ctrl/Cmd+A covers the SELECTABLE columns only — a row ordinal has no arithmetic
        // meaning, and sweeping it in would put the anchor somewhere nothing can be typed.
        sweep({ row: 0, col: bounds[0] }, { row: rowCount - 1, col: bounds[1] });
    }, [rowCount, selectableBounds, sweep]);

    const selectColumn = React.useCallback(
        (col: number) => {
            if (rowCount === 0 || !selectableCol(col)) return;
            sweep({ row: 0, col }, { row: rowCount - 1, col });
            scrollToCol(col);
            focus();
        },
        [rowCount, selectableCol, sweep, scrollToCol, focus],
    );

    // ═══ Clear / revert — what Delete and Escape do ══════════════════════════════

    /** Every addressable, editable cell the current selection (or the caret) covers. */
    const selectedCells = React.useCallback((): CellAddress[] => {
        const out: CellAddress[] = [];
        if (selectionRange) {
            for (let r = selectionRange.startRow; r <= selectionRange.endRow; r++) {
                for (let c = selectionRange.startCol; c <= selectionRange.endCol; c++) {
                    if (isEditable(r, c)) out.push({ row: r, col: c });
                }
            }
            return out;
        }
        const active = activeRef.current;
        if (active && isEditable(active.row, active.col)) out.push(active);
        return out;
    }, [selectionRange, isEditable]);

    /**
     * Delete / Backspace — clear the cell, or the whole range, WITHOUT opening an editor.
     * The selection SURVIVES, which is what Excel does and what leaves the block just
     * blanked as the block Escape's undo below is aimed at.
     */
    const clearSelectedCells = React.useCallback(() => {
        const cells = selectedCells();
        if (cells.length === 0) return;
        const writes: CellEdit[] = [];
        for (const cell of cells) {
            const at = slotAt(cell);
            if (!at) continue;
            writes.push({ rowId: at.nav.rowId, field: at.field, value: '' });
            onInvalid?.(at.nav.rowId, at.spec.key, false);
        }
        applyEdits(writes, 'clear');
    }, [selectedCells, slotAt, applyEdits, onInvalid]);

    /**
     * Escape, stage one — UNDO the unsaved edits under the selection.
     *
     * Delete clears a cell without opening an editor, so no edit session is ever started
     * and `useGridEditSession`'s pre-edit snapshot never sees it: a backspaced cell was
     * *unundoable*. This writes the STORED text back through the same writer, which drops
     * the field via `mergeFieldEdit` exactly as retyping the old value by hand would — no
     * second definition of "revert", no second definition of "dirty".
     *
     * Returns whether it undid anything, so the caller can tell the two stages apart.
     */
    const revertSelectedCells = React.useCallback((): boolean => {
        const writes: CellEdit[] = [];
        for (const cell of selectedCells()) {
            const at = slotAt(cell);
            if (!at) continue;
            if (editMap[at.nav.rowId]?.[at.field] === undefined) continue;
            writes.push({ rowId: at.nav.rowId, field: at.field, value: storedText(at.nav.rowId, at.field) });
            // The stored value is valid by definition, so the mark goes with it.
            onInvalid?.(at.nav.rowId, at.spec.key, false);
        }
        if (writes.length === 0) return false;
        applyEdits(writes, 'revert-selection');
        return true;
    }, [selectedCells, slotAt, editMap, storedText, applyEdits, onInvalid]);

    // ═══ Undo / redo ═════════════════════════════════════════════════════════════

    const doUndo = React.useCallback(() => {
        const step = undo();
        // A paste that ran past the end created blank rows; undoing it must take them
        // away, or the sheet keeps rows nobody asked for.
        if (step?.draftsAdded?.length) onRemoveDrafts?.(step.draftsAdded);
    }, [undo, onRemoveDrafts]);

    const doRedo = React.useCallback(() => {
        const step = redo();
        if (step?.draftsAdded?.length) onRestoreDrafts?.(step.draftsAdded);
    }, [redo, onRestoreDrafts]);

    // ═══ Clipboard IN ════════════════════════════════════════════════════════════

    const applyClipboardPaste = React.useCallback(
        (text: string) => {
            const block = parseClipboardTable(text);
            const emptyBlock =
                block.length === 0 ||
                (block.length === 1 && block[0].length === 1 && block[0][0] === '');
            if (emptyBlock) {
                toast.info('Nothing pasted — the clipboard held no cells.');
                return;
            }

            const active = activeRef.current;
            const anchor: CellAddress | null =
                active ??
                (selectionRange ? { row: selectionRange.startRow, col: selectionRange.startCol } : null);
            if (!anchor) {
                errorToast('Nothing was pasted — no cell is selected.');
                return;
            }

            const blockRows = block.length;
            const blockCols = block.reduce((m, r) => Math.max(m, r.length), 0);

            // Sheets' habit: a selection that is an exact multiple of the block TILES it,
            // which makes "copy one cell, select thirty, paste" fall out for free rather
            // than being a special case.
            const selRows = selectionRange ? selectionRange.endRow - selectionRange.startRow + 1 : 1;
            const selCols = selectionRange ? selectionRange.endCol - selectionRange.startCol + 1 : 1;
            const tile = tilePaste({ blockRows, blockCols, selRows, selCols });

            const anchorKind = rows.navRows[anchor.row]?.kind.kind ?? '';
            const isChildAnchor = (childKinds ?? ['child', 'sample']).includes(anchorKind);

            // WHICH rows the block lands on — of the ANCHOR'S OWN FAMILY, stepping over
            // the rest. Mapping block row `r` to nav row `anchor.row + r` walks straight
            // through the child rows under a parent and writes a parent's data into them
            // (BUG-024), while reporting success.
            const targets = pasteRowTargets({
                kinds: rows.navRows.map((n) => n.kind.kind),
                anchorRow: anchor.row,
                blockRows: tile.rows,
                childKinds,
            });

            const plan = planPaste({
                startRow: 0,
                startCol: anchor.col,
                blockRows: tile.rows,
                blockCols: tile.cols,
                navRowCount: targets.targets.length,
                colCount,
                // A block anchored on a CHILD row may never manufacture parent rows.
                canCreateRows: canCreateRows && !isChildAnchor && onAddDrafts !== undefined,
                maxNewRows: MAX_DRAFT_ADD,
            });

            const newIds = plan.newRows > 0 ? (onAddDrafts?.(plan.newRows) ?? []) : [];
            const draftRowKind = rows.navRows.find((n) => n.kind.kind === draftKind)?.kind;

            const writes: CellEdit[] = [];
            let wroteRows = 0;

            for (let r = 0; r < tile.rows; r++) {
                let rowId: string | null = null;
                let occupies: RowKindOccupies<Row> | null = null;
                let data: Row | null = null;

                if (r < targets.targets.length) {
                    const nav = rows.navRows[targets.targets[r]];
                    rowId = nav.rowId;
                    occupies = nav.kind.occupies;
                    data = nav.data;
                } else {
                    const i = r - targets.targets.length;
                    if (i < newIds.length && draftRowKind) {
                        rowId = newIds[i];
                        occupies = draftRowKind.occupies;
                        data = null;
                    }
                }
                if (rowId === null || occupies === null) continue;

                let wroteCell = false;
                for (let c = 0; c < tile.cols; c++) {
                    const col = anchor.col + c;
                    const spec = cols[col];
                    if (!spec) break;
                    const slot = occupies(spec.key, data);
                    if (!slot || !slot.editable) continue;
                    if (!columnAcceptsEdit(spec, data, ctx)) continue;

                    const src = tile.source(r, c);
                    const raw = block[src.row]?.[src.col] ?? '';
                    // A numeric column strips the rendering a spreadsheet copied with the
                    // value — and only a numeric column, because free text may legitimately
                    // contain a comma or a currency glyph.
                    writes.push({
                        rowId,
                        field: slot.field,
                        value: spec.cleanPasted ? spec.cleanPasted(raw, ctx) : raw,
                    });
                    wroteCell = true;
                }
                if (wroteCell) wroteRows++;
            }

            if (writes.length === 0 && newIds.length === 0) {
                toast.info('Nothing pasted — that block lands outside the editable cells.');
                return;
            }

            applyEdits(writes, 'paste', newIds);

            const notes: string[] = [];
            if (plan.newRows > 0) notes.push(`${plan.newRows} new row${plan.newRows === 1 ? '' : 's'}`);
            if (targets.skipped > 0) notes.push(`${targets.skipped} row${targets.skipped === 1 ? '' : 's'} skipped`);
            if (tile.tiled) notes.push('filled the selection');
            toast.success(
                `Pasted ${wroteRows} row${wroteRows === 1 ? '' : 's'}${notes.length ? ` · ${notes.join(' · ')}` : ''}`,
            );

            // Nothing is truncated in silence.
            if (plan.droppedRows > 0) {
                errorToast(
                    `${plan.droppedRows} row${plan.droppedRows === 1 ? '' : 's'} of the pasted block had nowhere to go.`,
                    {
                        description: isChildAnchor
                            ? 'A block pasted onto a child row can only fill child rows, and this one ran past the last of them.'
                            : 'There are no blank rows at the bottom to grow into, so the extra rows were not written.',
                    },
                );
            }
            if (plan.droppedCols > 0) {
                errorToast(
                    `${plan.droppedCols} column${plan.droppedCols === 1 ? '' : 's'} of the pasted block fell past the last column.`,
                    { description: 'Move the caret further left and paste again to keep them.' },
                );
            }
        },
        [
            selectionRange, rows, cols, colCount, ctx, applyEdits, childKinds,
            canCreateRows, onAddDrafts, draftKind,
        ],
    );

    /** A clipboard payload → the paste. Both delivery paths read it identically. */
    const pasteFromClipboard = React.useCallback(
        (data: DataTransfer | null) => {
            // The sink is a real textarea, so a paste the browser DID deliver could also
            // have landed in it. Emptied here so it can never accumulate the data.
            if (sinkRef.current) sinkRef.current.value = '';
            const text = data?.getData('text/plain') ?? '';
            if (!text) {
                toast.info('Nothing pasted — the clipboard holds no text.');
                return;
            }
            applyClipboardPaste(text);
        },
        [applyClipboardPaste],
    );

    /** The last native paste this grid consumed — interlock (a) against a double-apply. */
    const handledPasteRef = React.useRef<ClipboardEvent | null>(null);

    const onPaste = React.useCallback(
        (e: React.ClipboardEvent) => {
            // A paste into a real control the grid does not own IS that control's paste,
            // and is left alone (no preventDefault) so the browser performs it normally.
            if (isGridChrome(e.target)) return;
            handledPasteRef.current = e.nativeEvent;
            e.preventDefault();
            pasteFromClipboard(e.clipboardData);
        },
        [pasteFromClipboard],
    );

    // The document listener is attached ONCE; `pasteFromClipboard`'s identity changes on
    // every render (it closes over the row axis), and re-binding a document listener that
    // often is how one gets left behind on a fast unmount.
    const pasteRef = React.useRef(pasteFromClipboard);
    // eslint-disable-next-line react-hooks/refs
    pasteRef.current = pasteFromClipboard;

    React.useEffect(() => {
        const onDocumentPaste = (e: ClipboardEvent) => {
            // ── NEVER TWICE ──────────────────────────────────────────────────────
            // (a) The stamp: React's root listener runs BEFORE a bubble-phase listener on
            // `document`, so anything the React handler consumed is already marked.
            // (b) The structural one: anything whose target is inside the grid is the
            // React path's territory by definition — including a target it deliberately
            // DECLINED, whose paste belongs to the control it hit.
            if (handledPasteRef.current === e) return;
            const target = e.target;
            if (target instanceof Node && gridRef.current?.contains(target)) return;
            if (isGridChrome(target)) return;
            if (editingRef.current) return;
            const focused = gridRef.current?.contains(document.activeElement) ?? false;
            if (activeRef.current === null && !focused) return;

            handledPasteRef.current = e;
            e.preventDefault();
            pasteRef.current(e.clipboardData);
        };
        // BUBBLE phase, deliberately — capture would run ahead of React's root listener
        // and invert interlock (a).
        document.addEventListener('paste', onDocumentPaste);
        return () => document.removeEventListener('paste', onDocumentPaste);
    }, []);

    // ═══ Jump navigation ═════════════════════════════════════════════════════════

    /**
     * **`exists` is fed `cellAddressable`, not `cellExists` — deliberately.**
     *
     * Every one of the four jump gestures ends in `placeCaret(...)`, so the coordinate a
     * jump returns is a coordinate the caret is put on. Handing them the RENDER predicate
     * would let Ctrl+Arrow, Home/End and Ctrl+Home/End land on a cell the arrows and the
     * Tab run both refuse — a stop reachable by one key and not another, which is the same
     * inconsistency in two halves rather than one behaviour.
     *
     * `filled` is untouched: it is only ever consulted where `exists` is already true, so
     * narrowing `exists` narrows it for free and there is nothing to decide.
     */
    const jumpGrid = React.useCallback(
        (): JumpGrid => ({
            rowCount,
            colCount,
            exists: rows.cellAddressable,
            filled: (r, c) => cellText({ row: r, col: c }).trim() !== '',
        }),
        [rowCount, colCount, rows, cellText],
    );

    /**
     * Land on a row that actually HAS this column — a page may end on a child row.
     *
     * Same reasoning as `jumpGrid`: this is PageUp/PageDown's landing site, so it asks
     * where the caret may go rather than where content is painted.
     */
    const snapToExisting = React.useCallback(
        (row: number, col: number, dir: 1 | -1): CellAddress | null => {
            for (let r = row; r >= 0 && r < rowCount; r += dir) {
                if (rows.cellAddressable(r, col)) return { row: r, col };
            }
            for (let c = 0; c < colCount; c++) {
                if (rows.cellAddressable(row, c)) return { row, col: c };
            }
            return null;
        },
        [rowCount, colCount, rows],
    );

    /**
     * `undefined` — not a jump gesture at all (fall through to the shared hook).
     * `null` — a jump that owes nothing, consumed so it cannot become a plain arrow.
     */
    const resolveJump = React.useCallback(
        (e: React.KeyboardEvent, active: CellAddress | null): CellAddress | null | undefined => {
            const mod = e.metaKey || e.ctrlKey;

            if (e.key === 'PageUp' || e.key === 'PageDown') {
                if (!active) return null;
                const dir = e.key === 'PageDown' ? 'down' : 'up';
                const row = pageJump({
                    rowHeights: rows.navRowHeights,
                    viewportHeight: scrollerEl()?.clientHeight || FALLBACK_VIEWPORT_PX,
                    from: active.row,
                    dir,
                });
                return snapToExisting(row, active.col, dir === 'down' ? 1 : -1);
            }
            if (e.key === 'Home') {
                if (!active) return null;
                return mod ? sheetCorner(jumpGrid(), 'start') : rowEdge(jumpGrid(), active, 'start');
            }
            if (e.key === 'End') {
                if (!active) return null;
                return mod ? sheetCorner(jumpGrid(), 'end') : rowEdge(jumpGrid(), active, 'end');
            }
            if (mod && ARROW_KEYS.has(e.key)) {
                if (!active) return null;
                return edgeJump(jumpGrid(), active, ARROW_DIR[e.key]);
            }
            return undefined;
        },
        [jumpGrid, rows, scrollerEl, snapToExisting],
    );

    // ═══ The keyboard state machine ══════════════════════════════════════════════

    // `cellAddressable`, never `cellExists` — see `TableNavGeometry`. Every branch of the
    // resolver moves the caret, and a cell that renders content is not necessarily a cell
    // the caret has any business stopping on.
    const resolver = React.useMemo(
        () =>
            createTableNavResolver({
                rowCount,
                colCount,
                addressable: rows.cellAddressable,
                editable: isEditable,
            }),
        [rowCount, colCount, rows, isEditable],
    );

    const editSlot = React.useMemo(
        () => ({ start: startEdit, revert: revertEdit, commit: commitEdit }),
        [startEdit, revertEdit, commitEdit],
    );

    const selectionSize = selection.getSelectionSize();

    const onAfterMove = React.useCallback(
        (id: CellAddress) => {
            // The caret takes its 1×1 selection with it, so the tint and the ring can
            // never sit on two different cells.
            seedSelection(id);
            scrollTo(id.row);
            scrollToCol(id.col);
            focus();
        },
        [seedSelection, scrollTo, scrollToCol, focus],
    );

    const { handleKeyDown: navKeyDown } = useGridKeyboardNav<CellAddress>({
        activeCell,
        setActiveCell,
        isEditing,
        resolver,
        edit: editSlot,
        // Wired even though every one of these is intercepted ahead of the hook below —
        // one definition each, so a future change cannot leave the two disagreeing.
        range: {
            isRangeSelected: selectionSize > 1,
            extend: extendSelection,
            clear: clearSelection,
            // Through `seedSelection`, which ENDS the drag it just started. Calling
            // `handleCellMouseDown` alone leaves `isDragging` true with no mouse down, so
            // the auto-scroll loop below would arm itself after a Shift+Arrow and the
            // sheet would scroll under a pointer nobody is pressing.
            seedFromActive: () => {
                const a = activeRef.current;
                if (a) seedSelection(a);
            },
            anchorId: () =>
                selectionRange ? { row: selectionRange.startRow, col: selectionRange.startCol } : null,
            onCopy: () => copySelection(),
            onDelete: () => clearSelectedCells(),
        },
        onAfterMove,
        enableEnterAnchor: true,
    });

    const onKeyDown = React.useCallback(
        (e: React.KeyboardEvent) => {
            // A keystroke aimed at a real form control inside the grid is that control's
            // business. The SINK is exempt inside `isGridChrome`, and must be — it is a
            // textarea, and it is the thing holding focus.
            if (!editingRef.current && isGridChrome(e.target)) return;

            // While an editor is mounted only the shared hook speaks: Escape reverts,
            // Enter/Tab commit and move, everything else types. Ctrl+Z belongs to the
            // input's own undo there, not to the sheet's.
            if (editingRef.current) {
                navKeyDown(e);
                return;
            }

            const active = activeRef.current;
            const mod = e.metaKey || e.ctrlKey;

            if (mod && (e.key === 'z' || e.key === 'Z')) {
                e.preventDefault();
                if (e.shiftKey) doRedo();
                else doUndo();
                return;
            }
            if (mod && (e.key === 'y' || e.key === 'Y')) {
                e.preventDefault();
                doRedo();
                return;
            }
            if (mod && (e.key === 'a' || e.key === 'A')) {
                e.preventDefault();
                selectAllCells();
                return;
            }
            if (mod && (e.key === 'c' || e.key === 'C')) {
                e.preventDefault();
                copySelection();
                return;
            }

            // ── THE JUMPS, TESTED BEFORE THE PLAIN ARROWS ────────────────────────
            // The shared hook matches `NAV_KEYS.includes(e.key)` before any modifier is
            // looked at, so a Ctrl+Arrow reaching it is handled as a plain Arrow and the
            // gesture silently does something else.
            const jump = resolveJump(e, active);
            if (jump !== undefined) {
                e.preventDefault();
                if (jump !== null) placeCaret(jump);
                return;
            }

            // Clear the cell or the whole range WITHOUT opening an editor, and KEEP the
            // selection — what Excel does, and what leaves the blanked block still under
            // the caret for Escape to undo.
            if (e.key === 'Delete' || e.key === 'Backspace') {
                e.preventDefault();
                clearSelectedCells();
                return;
            }

            // ENTER OPENS THE CELL — this module's one departure from Excel, and the
            // behaviour the operators already have. The shared nav hook reads a plain
            // Enter as "move down", so it has to be intercepted here; Enter *while
            // editing* still commits and moves (the branch above), which is what keeps
            // the Tab-run → Enter lane return working.
            if (e.key === 'Enter' && !e.shiftKey && active && isEditable(active.row, active.col)) {
                e.preventDefault();
                startEdit(active);
                return;
            }

            if (e.key === 'Escape') {
                // Stage one: undo the unsaved work under the selection.
                if (revertSelectedCells()) {
                    e.preventDefault();
                    e.stopPropagation();
                    return;
                }
                // Stage two: deselect — and deliberately WITHOUT stopping propagation. An
                // Escape the grid declines is one a Radix layer above may want.
                clearSelection();
                return;
            }

            navKeyDown(e);
        },
        [
            navKeyDown, doUndo, doRedo, selectAllCells, copySelection, resolveJump,
            placeCaret, clearSelectedCells, revertSelectedCells, clearSelection,
            isEditable, startEdit,
        ],
    );

    // ═══ Focus, when the browser drops it ════════════════════════════════════════
    //
    // The cell editor unmounting without a move (Escape reverts) takes the caret with it
    // and focus falls to `document.body`, from where Delete, Escape, Ctrl/Cmd+C and
    // Ctrl/Cmd+V all go nowhere. Narrow on purpose: only with an editor CLOSED (read after
    // render, so it is the settled value), only with a cell selected, and only when focus
    // is genuinely orphaned — a popover or a search box is never `document.body`.
    React.useEffect(() => {
        if (isEditing || activeCell === null) return;
        const el = document.activeElement;
        if (el !== null && el !== document.body) return;
        focus();
    }, [isEditing, activeCell, focus]);

    // ═══ Mouse ═══════════════════════════════════════════════════════════════════

    const rowHandlers = React.useMemo<RowHandlers>(
        () => ({
            onCellMouseDown(navRow, col, e) {
                if (e.button !== 0) return;
                // Never let the browser start a text selection or move focus itself — the
                // grid decides where the caret goes, and `focus()` below is the only way
                // it ever moves.
                e.preventDefault();
                if (editingRef.current) commitEdit();
                // `cellExists`, NOT `cellAddressable`, and this is the one place the two
                // deliberately disagree. A drag has to be able to START on a
                // content-bearing, caret-free cell — a run of computed totals is the most
                // useful thing on a sheet to sweep — and refusing the mousedown there
                // would take the whole selection with it. So a CLICK may park the caret on
                // a non-addressable cell; a keyboard run never walks onto one.
                if (!rows.cellExists(navRow, col)) {
                    // A coordinate this row does not have. The caret stays where it is —
                    // there is nothing there to put it on — but the grid keeps the
                    // keyboard, so the sheet does not go dead on a stray click.
                    focus();
                    return;
                }
                // UNCONDITIONAL. Setting the active cell to null on a read-only cell is
                // BUG-023: `useGridKeyboardNav` returns on its first line with no active
                // cell, so the whole sheet lost its arrows, Tab, Escape, Delete and copy
                // until another cell was clicked.
                setActiveCell({ row: navRow, col });
                handleCellMouseDown(navRow, col, e);
                scrollToCol(col);
                focus();
            },
            onCellMouseEnter(navRow, col) {
                handleCellMouseEnter(navRow, col);
            },
            onCellDoubleClick(navRow, col) {
                if (!isEditable(navRow, col)) return;
                const cell = { row: navRow, col };
                setActiveCell(cell);
                // F2 / double-click PRESERVE the value; a printable character replaces it.
                startEdit(cell);
            },
            onCellContextMenu(navRow, col, e) {
                if (rows.cellExists(navRow, col)) setActiveCell({ row: navRow, col });
                onContextMenu?.({ row: navRow, col }, e);
            },
        }),
        [
            rows, handleCellMouseDown, handleCellMouseEnter, scrollToCol, focus,
            isEditable, setActiveCell, startEdit, commitEdit, onContextMenu,
        ],
    );

    // ═══ The floating pill's numbers ═════════════════════════════════════════════

    const getNumericCellValue = React.useCallback(
        (row: number, col: number): number | null => {
            const at = slotAt({ row, col });
            if (!at || at.nav.data === null || !at.spec.numericValue) return null;
            return at.spec.numericValue(at.nav.data);
        },
        [slotAt],
    );

    const getColumnDefaultCalcType = React.useCallback(
        (col: number): AggregationType | null => cols[col]?.calcType ?? null,
        [cols],
    );

    const aggregates = useCellAggregation({
        range: selectionRange,
        getNumericCellValue,
        getColumnDefaultCalcType,
    });

    const bandFor = React.useCallback(
        (navRow: number): readonly [number, number] | null => {
            if (!selectionRange || navRow < selectionRange.startRow || navRow > selectionRange.endRow) {
                return null;
            }
            return [selectionRange.startCol, selectionRange.endCol];
        },
        [selectionRange],
    );

    const gridProps = React.useMemo(
        () => ({ ref: gridRef, tabIndex: -1, onKeyDown, onPaste, onMouseUp: handleMouseUp }),
        [onKeyDown, onPaste, handleMouseUp],
    );

    const sinkProps = React.useMemo(() => ({ ref: sinkRef, onPaste }), [onPaste]);

    const selectionApi = React.useMemo(
        () => ({
            range: selectionRange,
            size: selectionSize,
            bandFor,
            clear: clearSelection,
            selectAll: selectAllCells,
            selectColumn,
            isDragging,
            aggregates,
        }),
        [selectionRange, selectionSize, bandFor, clearSelection, selectAllCells, selectColumn, isDragging, aggregates],
    );

    return {
        activeCell,
        setActiveCell,
        isEditing,
        gridProps,
        sinkProps,
        onKeyDown,
        onPaste,
        selection: selectionApi,
        scrollTo,
        scrollToCol,
        rowHandlers,
        editorInitialText,
        setEditorText,
        cellText,
        setCellText,
        commitEdit,
        focus,
        isEditable,
    };
}

/** `RowKind.occupies`, named so the paste loop can hold one without repeating its shape. */
type RowKindOccupies<Row> = (colKey: string, row: Row | null) => CellSlot | null;
