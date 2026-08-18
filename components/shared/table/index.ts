// ─────────────────────────────────────────────────────────────────────────────────
// Blackwood Table — the React half. PLATFORM LAYER, tenant-neutral.
//
// Imports from `@/lib/table` (the pure core) and from `@/lib/hooks/use-table-*`. Never
// from `app/**`. See `lib/table/CONTEXT.md` and the plan at
// `.agents/prompts/universal-table-module.md`.
// ─────────────────────────────────────────────────────────────────────────────────

export { BlackwoodTable } from './BlackwoodTable';
export type {
    BlackwoodTableApi,
    BlackwoodTableProps,
    TableEditorArgs,
    TableSummaryRow,
    TableChromeRowApi,
    TableContextTarget,
    TableState,
} from './BlackwoodTable';

export { HeaderCell, MIN_COLUMN_WIDTH } from './HeaderCell';
export type { HeaderCellProps } from './HeaderCell';

export { TableRow, TableRowShell, TableCells, NO_EDITS, NO_INVALID } from './Row';
export type { TableRowProps, TableRowShellProps, TableCellsProps, RowHandlers } from './Row';

export { PasteSink, PASTE_SINK_ATTR, isGridChrome, focusGrid } from './PasteSink';
export type { PasteSinkProps } from './PasteSink';

// The side-by-side control. Temporary, and it goes with `?grid=v2` at cutover — see
// `lib/table/grid-param.ts`.
export { GridVersionToggle, GridVersionBar } from './GridVersionToggle';
export type { GridVersionToggleProps, GridVersionBarProps } from './GridVersionToggle';

export {
    createCellClassTable,
    cellClassKey,
    DEFAULT_ROW_RULES,
} from './cell-classes';
export type { CellClassKey, CellClasses, CellClassTable } from './cell-classes';
