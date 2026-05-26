# RC Movement — Frontend (table + tab + month picker)

## Read first

- `/Users/renzosy/blackwood/CLAUDE.md` — project conventions, Excel Standard, Motion & Glass system, role gating
- `/Users/renzosy/blackwood/TIMELINE.md` — latest entry covers the RC Movement backend that just landed
- `/Users/renzosy/blackwood/app/(app)/inventory/rc-movement/actions.ts` — **the source of truth for the data shape**. Read carefully; your table is built against these exact types.
- `/Users/renzosy/blackwood/app/(app)/inventory/CONTEXT.md` — overall inventory module
- `/Users/renzosy/blackwood/app/(app)/inventory/components/sheet-tabs.tsx` — existing 3 tabs; you add a 4th
- `/Users/renzosy/blackwood/app/(app)/inventory/components/inventory-tab-context.tsx` — tab state + localStorage persistence
- `/Users/renzosy/blackwood/app/(app)/inventory/components/inventory-view.tsx` — crossfade wrapper, conditional rendering
- `/Users/renzosy/blackwood/app/(app)/inventory/components/rc-out-lazy-tab.tsx` — **closest existing pattern**. Mirror this structure.
- `/Users/renzosy/blackwood/app/(app)/inventory/components/blocking-lazy-tab.tsx` — another lazy-tab reference
- `/Users/renzosy/blackwood/app/(app)/inventory/components/DeliverySheetFooter.tsx` — month/year navigation pattern from RC IN
- `/Users/renzosy/blackwood/app/(app)/inventory/rc-out/rc-out-table.tsx` — TanStack Virtual + dense table pattern (cell selection if needed)
- `/Users/renzosy/blackwood/app/(app)/inventory/rc-in/components/delivery-master-table-wrapper.tsx` — SSR=false dynamic wrapper pattern

## Context

The RC Movement backend just shipped. SQL view `view_rc_movement` exists in Supabase, types regenerated, server action `fetchRcMovementData(year, month)` returns the data shape below. Your job is to build the frontend tab so RC Movement is visible at `/inventory` as a 4th tab.

The user wants the new tab to **mirror their existing Excel RC MOVEMENT sheet column-for-column**. They use the same nomenclature, same layout style, same Industrial Spreadsheet density.

## What you're building

1. **Add "Movement" as a 4th tab** in the inventory page (alongside Deliveries / Usage / Blocking)
2. **Lazy-tab component** that fetches data only when the user first switches to the tab (same pattern as rc-out and blocking lazy tabs)
3. **Month picker** — month-to-date scoping with prev/next buttons, identical UX to RC IN's existing `DeliverySheetFooter` pattern. Default = current month.
4. **The table itself** — Industrial Spreadsheet density, grouped by day, with daily header rows showing day-level totals

## Return type from `fetchRcMovementData`

Already locked in `app/(app)/inventory/rc-movement/actions.ts`:

```typescript
export type RcMovementRow = {
  batchCode: string;
  blockLoc: string | null;
  supplier: string | null;
  startBalance: number;
  batchFed: number;        // = view.fed_today
  ttlFed: number;          // = view.cum_fed
  pctLoss: number | null;
  phpPerKg: number | null; // null when !canViewPrices
  phpTotal: number | null; // null when !canViewPrices
  status: 'active' | 'closed';
  feedDayN: number;
};

export type RcMovementDay = {
  date: string;            // YYYY-MM-DD
  day: number;             // day-of-month integer
  ttlKg: number;
  ttlPhp: number | null;   // null when !canViewPrices
  laneCount: number;
  rows: RcMovementRow[];
};

export type RcMovementData = {
  days: RcMovementDay[];   // ordered date DESC
  canViewPrices: boolean;
};
```

Import: `import { fetchRcMovementData, type RcMovementData, type RcMovementDay, type RcMovementRow } from '@/app/(app)/inventory/rc-movement/actions';`

## Table column structure — mirror the Excel exactly

The user explicitly asked for Excel-mirrored column names. Render in this exact left-to-right order with these exact headers:

| Header | Bound field | Format | Notes |
|---|---|---|---|
| DATE | day.date | YYYY-MM-DD | Only on day-header row, not on each row |
| DAY | day.day | integer | Only on day-header row |
| TTL KG | day.ttlKg | integer with thousands sep | Only on day-header row; bold |
| BLOCKS | row.batchCode | text | The batch code, e.g. `FEB-26-BLK21` |
| START BAL | row.startBalance | integer with thousands sep | Right-aligned, mono |
| BATCH FED | row.batchFed | integer with thousands sep | Right-aligned, mono |
| TTL FED | row.ttlFed | integer with thousands sep | Right-aligned, mono |
| % LOSS | row.pctLoss | percent, 2 decimals | Dimmed/italic when `status === 'active'` (provisional); solid when `'closed'` (final). Color-code: <0 red, 0-30% amber, >30% normal text |
| PHP/KG | row.phpPerKg | accounting (₱) | Hidden column when `!canViewPrices` |
| PHP TTL | row.phpTotal | accounting (₱) | Hidden column when `!canViewPrices` |
| STATUS | row.status | badge | green dot for active, red X badge for closed |

Also include a non-Excel column at the far right:
| BLOCK LOC | row.blockLoc | text mono | Small, muted. Shows physical block (e.g. `C-16A`). Not in Excel but useful context. |

And optionally show `supplier` on hover/tooltip of the BLOCKS column (since the Excel doesn't show it but the data is there).

## Day-header row design

Each day's group of batch rows is preceded by a header row showing the day-level summary. Style it like RC IN's existing sticky month/date dividers:

- Sticky within the scroll container — `position: sticky; top: 0` per group (or use the existing `bg-muted/90 backdrop-blur-sm` glass pattern from CLAUDE.md)
- Format: `DAY 22 · May 22, 2026 · TTL KG 31,908 · ₱1,530,720 · 4 lanes`
- When `!canViewPrices`, omit the ₱ segment
- Visually distinct: slightly larger font, bold day number, muted background

## URL params + month picker

Match the RC IN pattern exactly:

- `?y=2026&m=5` controls year + month
- Defaults to current year + current month if absent
- Reuse `DeliverySheetFooter` component (or a copy adapted for this tab) for the prev/next navigation arrows + month label
- Server component reads URL params, calls `fetchRcMovementData(year, month)`, passes to client table

## File structure to create

```
app/(app)/inventory/rc-movement/
├── actions.ts                         (already exists — DO NOT touch)
├── page.tsx                           (NEW — redirect stub to /inventory?tab=movement&y=...&m=...)
├── rc-movement-table.tsx              (NEW — main table client component)
├── components/
│   └── rc-movement-table-wrapper.tsx  (NEW — SSR=false dynamic wrapper, mirrors rc-in's pattern)
└── CONTEXT.md                         (NEW — module doc)

app/(app)/inventory/components/
├── sheet-tabs.tsx                     (EDIT — add 4th "Movement" tab button + sliding indicator slot)
├── inventory-tab-context.tsx          (EDIT — add 'movement' to the tab state union)
├── inventory-view.tsx                 (EDIT — conditional render for movement tab)
└── rc-movement-lazy-tab.tsx           (NEW — lazy fetch + render, mirrors rc-out-lazy-tab.tsx)

app/(app)/inventory/
├── page.tsx                           (EDIT — if needed, add server-side fetch for movement on initial load)
└── CONTEXT.md                         (EDIT — add Movement tab description)
```

## Implementation constraints

- **No new data layer** — use the existing `fetchRcMovementData` action. Do not create additional actions.
- **No schema changes** — backend is locked.
- **Industrial Spreadsheet styling** — per CLAUDE.md: `table-fixed`, explicit pixel widths, `px-2 py-1`, `text-xs`/`text-sm`, `h-8` rows, `font-mono` for numerics, right-aligned numbers, accounting format for ₱ columns
- **Glass headers** — `bg-muted/90 backdrop-blur-sm` on sticky day-header rows per CLAUDE.md Motion & Glass section
- **No row animations** — per CLAUDE.md, never animate table rows; use `transition-all duration-150` for hover only
- **Role gating** — when `data.canViewPrices === false`, hide PHP/KG and PHP TTL columns entirely (don't just blank them); also omit ₱ from the day-header summary
- **TanStack Virtual** for the row list — same pattern as rc-out-table.tsx since data could be 100+ rows
- **Empty state** — show "No movement recorded for [Month YYYY]" centered, muted
- **Loading state** — match existing tabs' loading skeleton pattern

## % LOSS rendering specifics

The `pctLoss` field is the residual fraction (balance_after / deliveries_total). User explicitly requested:
- For rows where `status === 'active'`: render the value with `italic text-muted-foreground/70` and append a small `*` indicator. This communicates "provisional, will finalize at closure."
- For rows where `status === 'closed'`: render full color, no italic. This is the final inventory shrinkage figure.
- Tooltip on the column header: "% remaining of original batch intake. Provisional while active; freezes as final shrinkage at closure."

## STATUS badge

- `active` → green dot (●) with text "active" in `text-emerald-600`
- `closed` → red X (✕) with text "closed" in `text-red-600 line-through` or use the existing pattern from rc-out-table

## Process

1. **Enter plan mode FIRST** via `ExitPlanMode`. Present:
   - The exact file list you'll create/modify (matches the layout above)
   - A wireframe sketch (ASCII) of the table with one day group rendered
   - The TanStack Table column definitions (just the structure, not full code)
   - How you'll wire the 4th tab into `sheet-tabs.tsx` and `inventory-tab-context.tsx`
2. After plan approval, execute the implementation
3. Run `npm run build` to confirm zero TypeScript errors before reporting done
4. Update `TIMELINE.md` with a new Recent Completions entry at the top (today, 2026-05-25)
5. Create `app/(app)/inventory/rc-movement/CONTEXT.md` per the project convention: Purpose / Files / Data / Key Behaviors / Dependencies / See Also
6. Update `app/(app)/inventory/CONTEXT.md` to add Movement to the tab list

## Constraints (repeat for emphasis)

- DO NOT touch `actions.ts` or the SQL view — backend is locked
- DO NOT add new dependencies — TanStack Table, TanStack Virtual, date-fns, lucide-react, shadcn/ui are already in the project
- DO NOT change the existing RC IN, RC OUT, or Blocking tabs — only add the 4th
- Use `model: 'sonnet'` if you spawn any sub-subagents
- Follow the Excel Standard density requirements from CLAUDE.md verbatim

## Done criteria

- `npm run build` passes with zero TypeScript errors
- Visiting `/inventory` shows 4 tabs: Deliveries / Usage / Blocking / Movement
- Clicking Movement lazy-loads the RC Movement table
- Month picker works — switching to a prior month with data renders rows
- Production-role user sees no ₱ columns at all
- Owner/Admin/Dev sees all columns including ₱
- Day-header rows show daily TTL KG and TTL ₱ totals
- TIMELINE.md updated
- CONTEXT.md files updated

Report when done with: (1) build pass confirmation, (2) screenshot if you can produce one, otherwise an ASCII render of what the user will see, (3) any deviations from the spec.
