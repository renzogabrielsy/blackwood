# Performance Reviewer Memory

## StatusBar Context Pattern
- `StatusBarProvider` at `components/providers/status-bar-context.tsx` holds `connectionStatus`, `cellSelectionCount`, and `cellAggregates`
- Context value object is created inline (not memoized) -- any state change re-renders all consumers
- Tables push selection data via debounced useEffect (50ms) to reduce status bar re-renders during drag
- Bulk input components were initially missing the debounce -- flagged 2025-02-17

## Cell Aggregation Architecture
- `useCellAggregation` at `lib/hooks/use-cell-aggregation.ts` computes SUM/AVG/COUNT/MIN/MAX via useMemo
- Deps: `[range, getNumericCellValue]` -- returns new object on every range change
- `getNumericCellValue` callbacks depend on `[rows, visibleColumns]` in master tables, `[rows]` in bulk inputs
- `visibleColumns` is recomputed every render in master tables (not memoized) -- cascades to callback instability
- Aggregation loop is O(rows * cols in selection) -- typically under 100 iterations, not a concern

## Known Hot Paths
- **Cell drag selection**: mouseenter -> setFocus -> re-render host -> useMemo aggregation -> debounced context push
- Master tables: 50ms debounce collapses ~15 events into 1-2 context updates
- Bulk inputs (post-fix): should match the 50ms debounce pattern
- **FloatingStatusBar**: consumes full context, re-renders on any context value change including connectionStatus

## Animation Audit (2025-02-17)
- `animate-status-grow` (globals.css): uses only transform + opacity -- PASS
- `animate-row-fade`, `animate-slide-up`, `animate-fade-up`: all compositor-only -- PASS

## Recurring Patterns to Watch
- Inline `style={{}}` objects in render paths (creates new refs every render)
- `useEffect` without dep array used for ref sync -- runs every render, usually benign but unclear intent
- Context value objects not memoized -- causes unnecessary consumer re-renders on parent re-render
- **This codebase's signature grid defect: no memoized Row component anywhere.** Three grids audited, three hits (production ledger, RC deliveries ledger). Check for `React.memo` FIRST on any grid review.
- **Virtualized != cheap.** react-virtuoso caps the DOM, not the render work: inline `itemContent`/`computeItemKey`/`fixedHeaderContent` and a `context` prop carrying mutable state each re-render the whole visible window.

## Component Profiles
- [Cenapro Production Ledger](cenapro_production_ledger.md) -- /cenapro/production renders all ~752 rows, no virtualization, no memoized row; every edit/drag re-renders all 10.5k cells. Fix = period picker first, then memoized Row, virtualization as escape hatch. Diagnosed 2026-06-02.
- [Cenapro RC Deliveries Ledger](cenapro_rc_deliveries_ledger.md) -- /cenapro/deliveries, slated to become the UNIVERSAL table module. No render boundary; virtuoso props are inline arrows; ~12 allocs + 2 twMerge per `<td>`. Focus scope already janky (~4.2k cells/keystroke). Diagnosed 2026-08-17.

## Security Audits
- [Price Gate Audit 2026-06-15](price_gate_audit_2026_06_15.md) -- charcoal ₱/cost gating review; found LIVE leak fetchSingleDelivery (blocking/actions.ts) ships cost_basis ungated to Production via detail panel. Rest clean (RC OUT/Movement/inventory page fail closed, impersonation-aware).
