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
    tilePaste,
} from './clipboard';
export type {
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

export { needsGroupSpacer } from './grouping';
