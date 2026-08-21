// ─────────────────────────────────────────────────────────────────────────────────
// Blackwood Table — the pure core. PLATFORM LAYER.
//
// Barrel for `lib/table/`. Everything re-exported here is PURE: no React, no Supabase,
// no `'use client'`, no tenant knowledge. The React half of the module lives in
// `components/shared/table/` and imports from here; nothing here imports from there.
//
// See `.agents/prompts/universal-table-module.md` for the plan this is built to, and
// `docs/universal-table/` for the audits behind it.
// ─────────────────────────────────────────────────────────────────────────────────

export type {
    ColumnGeometry,
    ColumnSpec,
    ColumnParseResult,
    SummaryLane,
    FilterKind,
    CalcType,
    CellKind,
    CellSlot,
    CellContext,
    RowKind,
    GridRow,
    CellAddress,
    FieldEdits,
    TableSettings,
    WindowAnchor,
    WindowResult,
    SaveOutcome,
    SaveVerdict,
    DataSource,
} from './types';

export {
    pinnedCounts,
    pinnedOffsets,
    pinnedEndOffsets,
    pinnedWidth,
    isPinned,
    minTableWidth,
    columnOffsets,
    columnScrollLeft,
    dragAutoScrollDelta,
    summarySpans,
    DRAG_EDGE_PX,
    DRAG_STEP_PX,
} from './geometry';
export type {
    ColumnScrollInput,
    DragScrollInput,
    SummarySpans,
    SummaryLaneCol,
} from './geometry';

export {
    parseClipboardTable,
    tsvEscape,
    clipboardNumber,
    planPaste,
    pasteKindsCompatible,
    pasteRowTargets,
    rowCopyColumns,
    tilePaste,
} from './clipboard';
export type {
    RowCopyColumn,
    PastePlanInput,
    PastePlan,
    PasteRowKind,
    PasteRowTargetsInput,
    PasteRowTargets,
    TilePasteInput,
    TilePlan,
} from './clipboard';

export {
    mergeFieldEdit,
    isDirtyFieldEdits,
    forgetRows,
    countUnsavedWork,
    hasUnsavedWork,
    describeUnsavedWork,
    createJournal,
    invertStep,
    DEFAULT_DRAFT_ROWS,
    MAX_DRAFT_ADD,
    JOURNAL_LIMIT,
    clampDraftAdd,
} from './edits';
export type {
    UnsavedWork,
    UnsavedNouns,
    CellMutation,
    JournalStep,
    Journal,
} from './edits';

export { edgeJump, rowEdge, sheetCorner, pageJump } from './nav';
export type { JumpGrid, JumpDir, PageJumpInput } from './nav';

export { shiftFirstItemIndex, DEFAULT_FIRST_ITEM_INDEX } from './paging';
export type { FirstItemIndexShiftInput } from './paging';

export { needsGroupSpacer } from './grouping';

// The selection RECTANGLE's own geometry — which edges each cell paints, so a swept
// block reads as one box with no inner borders.
export { rangeRowEdge, cellRangeEdges, NO_RANGE_EDGES } from './selection';
export type { SelectionRowEdge, CellRangeEdges } from './selection';

// The built-in right-click menu, as data. The component maps each action onto the
// interaction hook's own callback.
export { defaultTableMenu } from './menu';
export type { TableMenuAction, TableMenuItemSpec } from './menu';

// SORT + FILTER — the view transform every grid gets for free. Pure: it decides the row
// order and the row set, and holds none of the state that drives it.
export {
    applyTableView,
    nextSortDirection,
    isColumnFilterActive,
    activeFilterCount,
    columnSortable,
    columnFilterable,
    NO_FILTERS,
} from './view';
export type {
    SortDirection,
    TableSort,
    ColumnFilter,
    TableFilters,
    TableView,
    TableViewInput,
} from './view';

export {
    GRID_PARAM,
    GRID_V1,
    GRID_V2,
    parseGrid,
    resolveGrid,
    isGridV2,
    withGrid,
    gridHref,
} from './grid-param';
export type { GridParam, GridVersion, QueryEntries } from './grid-param';
