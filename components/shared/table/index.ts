// ─────────────────────────────────────────────────────────────────────────────────
// Blackwood Table — the React half. PLATFORM LAYER, tenant-neutral.
//
// Imports from `@/lib/table` (the pure core) and from `@/lib/hooks/use-table-*`. Never
// from `app/**`. See `lib/table/CONTEXT.md` and the plan at
// `.agents/prompts/universal-table-module.md`.
// ─────────────────────────────────────────────────────────────────────────────────

export { TableRow, NO_EDITS, NO_INVALID } from './Row';
export type { TableRowProps, RowHandlers } from './Row';

export { PasteSink, PASTE_SINK_ATTR, isGridChrome, focusGrid } from './PasteSink';
export type { PasteSinkProps } from './PasteSink';

export {
    createCellClassTable,
    cellClassKey,
    DEFAULT_ROW_RULES,
} from './cell-classes';
export type { CellClassKey, CellClasses, CellClassTable } from './cell-classes';
