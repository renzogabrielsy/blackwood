# Production — Electricity Tab

## Purpose
Daily electricity meter readings (MAIN / BUNKHOUSE / PUMP) with computed DIFF and CONSUMPTION (KWH).

> **Schema reworked 2026-05-29 (backend + frontend, shipped):** `electricity_readings.rate_php_per_kwh` was renamed to **`meter_multiplier`** (NOT NULL DEFAULT 120) and a generated stored column **`consumption_kwh` = (end_kwh − start_kwh) × meter_multiplier** was added. The `120` was never a peso rate — the source email labels it a "METER MULTIPLIER" and computes `CONSUMPTION (KWH) = diff × 120` (PRODUCTION_DESIGN.md §15.2 Section D). **There is no peso cost in this data.** The DB layer (`actions.ts`, `types/supabase.ts`) and the UI (`electricity-grid.tsx`) are both updated: the grid's two rightmost data columns are now **MULT** (editable `meter_multiplier`, default 120) and **TTL KWH** (computed `diff × multiplier`, plain right-aligned number — no ₱).
>
> **Note:** The monthly summary table (fed by `view_electricity_monthly`) was removed (May 2026) — the format was undesired. The `view_electricity_monthly` DB view was **DROPPED 2026-05-29** (it referenced the old column and computed bogus peso math; nothing queried it).

## Files
| File | Role |
|------|------|
| `actions.ts` | `fetchElectricityTabData(year, month)`, `saveBulkElectricity`. Defines `BulkSavePayload` locally. |
| `electricity-view.tsx` | Scope-label wrapper (shows "Showing: {scope}") — passes readings to `ElectricityGrid`. Accepts `year: number\|null`, `month: number\|null`. |
| `electricity-grid.tsx` | Inline-editable grid for `electricity_readings` |

## Column Order
`#` / DATE / METER (Select + custom) / START KWH / END KWH / DIFF (computed, read-only) / MULT (`meter_multiplier`, editable, default 120) / TTL KWH (consumption — computed `diff × multiplier`, read-only) / REM / [delete]

All columns always render (no price gating). DIFF and TTL KWH are read-only/computed; TTL KWH renders as a plain right-aligned `font-mono` number with no ₱ symbol. The DB regenerates the stored `consumption_kwh` column on save, so the UI computes TTL KWH client-side only for live preview and never sends it in the payload.

## Key Behaviors
- **Inline editing (shared Blackwood Table primitives):** keyboard nav + the edit session are driven by `useGridKeyboardNav` (coordinate resolver via `createCoordinateNavResolver({ rowCount, columnMap: COL_MAP })`) + `useGridEditSession` — see `components/shared/grid/CONTEXT.md`. `enableEnterAnchor: false` (plain Enter drops straight down). `revertChanges` is kept custom (NOT the session's) to preserve the `_state: 'modified' → 'existing'` rollback. `Home`/`End` are intercepted before the shared handler (Home → col 1, End → `COL_COUNT - 2`, i.e. REMARKS — the trailing delete column is skipped). `handleSmartPaste` stays local because it must mark `_state='modified'` + maintain the trailing empty row (the generic `useGridPaste` cannot express that). The reference wiring is `app/(app)/inventory/rc-in/bulk-delivery-input.tsx`.
- **Meter select:** MAIN / BUNKHOUSE / PUMP dropdown; choosing "Other (type manually)" switches to free-text Input for that row. (This uses the shadcn `<Select>`, NOT the shared `SelectCell` — left unchanged in the migration since it is not a GridCell-style dropdown.)
- **No price gating:** MULT and TTL KWH are operational kWh data (not sensitive pricing) — always visible to all roles. The grid no longer imports `useAuth`/`hasPermission`.
- **Computed DIFF:** `diff_kwh` is a generated DB column (`end_kwh - start_kwh`), shown as read-only muted cell
- **Computed TTL KWH (consumption):** `consumption_kwh` is a generated DB column (`(end_kwh - start_kwh) × meter_multiplier`) — raw kWh, NOT pesos. The UI mirrors this client-side (`diff × meter_multiplier`) for live preview as the user edits MULT; the value is not written (DB regenerates it).
- **Validation:** end_kwh ≥ start_kwh, meter_multiplier ≥ 0 — enforced server-side in `saveBulkElectricity` (note: DB CHECK requires meter_multiplier > 0; insert/update default falls back to 120, so an empty or `0` MULT cell saves as 120)
- **Empty state:** `animate-fade-up` message "Awaiting Production Manager sync..."
- **Error toasts:** `errorToast()` from `lib/toast.ts`

## Hooks Used
- `useGridKeyboardNav` + `createCoordinateNavResolver`, `useGridEditSession` — shared Blackwood Table keyboard/edit primitives (see `components/shared/grid/CONTEXT.md`)
- `useCellSelection`, `useClipboardCopy`, `useCellDelete`, `useCellAggregation`, `useStatusBar`

## Server Action Contract
```ts
saveBulkElectricity(payload: BulkSavePayload<TablesInsert<'electricity_readings'>, TablesUpdate<'electricity_readings'>>)
  => Promise<{ ok: true, insertedCount, updatedCount, deletedCount } | { ok: false, error: string }>
```

## Data Fetch
`fetchElectricityTabData(year?: number | null, month?: number | null)` — filters `electricity_readings` by `reading_date`. Driven by the **module-level shared period** (see `production/CONTEXT.md` → "Universal Period Control"):
- `year=null` → all readings (no date filter)
- `year=<num>, month=null` → all readings in that calendar year
- `year=<num>, month=<n>` → that month of that year (`month` is 0-indexed)

The `electricity-lazy-tab` derives `month = batchToMonth(batch)` from the shared batch before calling (unrecognized/null batch → null month → whole year). `undefined` args fall back to the current month for backwards compatibility. Returns `{ data: { readings, year, month } }`.
