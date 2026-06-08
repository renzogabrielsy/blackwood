// ─────────────────────────────────────────────────────────────────────────────
// Blackwood Table — shared grid presentational components (barrel).
//
// Hooks (the state machine, resolvers, edit session, paste, context-menu state)
// are imported directly from `@/lib/hooks/...` — only the presentational pieces
// are re-exported here. See ./CONTEXT.md for the full package map + interaction
// model.
// ─────────────────────────────────────────────────────────────────────────────

export { GridCell } from './GridCell';
export type { GridCellProps } from './GridCell';

export { SelectCell } from './SelectCell';
export type { SelectCellProps } from './SelectCell';

export { DatePickerCell, formatDateShort } from './DatePickerCell';
export type { DatePickerCellProps } from './DatePickerCell';

export { EditInput, EDIT_INPUT } from './EditInput';
export type { EditInputProps } from './EditInput';

export { GridContextMenu } from './GridContextMenu';
export type { GridMenuItem, GridContextMenuProps } from './GridContextMenu';
