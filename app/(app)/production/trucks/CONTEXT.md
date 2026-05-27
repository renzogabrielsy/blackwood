# Production — Trucks Tab

## Purpose
Daily truck odometer and fuel readings for fleet tracking. Monthly summary from `view_trucks_monthly`.

## Files
| File | Role |
|------|------|
| `actions.ts` | `fetchTrucksTabData`, `saveBulkTrucks`. Imports `BulkSavePayload` from `../daily/actions`. |
| `trucks-view.tsx` | Period indicator wrapper — passes to `TrucksGrid` |
| `trucks-grid.tsx` | Inline-editable grid for `truck_readings` + compact monthly summary table |

## Column Order
`#` / DATE / PLATE NO (Select + custom) / START KM / END KM / TTL KM (computed, read-only) / FUEL (L) / REM / [delete]

## Key Behaviors
- **Plate select:** AAV 6111 / KCA 378 / FORKLIFT dropdown; "Other (type manually)" switches to free-text Input for that row
- **Computed TTL KM:** `end_km - start_km`, shown as read-only muted cell
- **Monthly summary:** `view_trucks_monthly` compact table below the grid (per plate: month, start/end km, ttl km, fuel liters)
- **Validation:** end_km ≥ start_km, fuel_liters ≥ 0 — enforced server-side in `saveBulkTrucks`
- **Empty state:** `animate-fade-up` message "Awaiting Production Manager sync..."
- **Error toasts:** `errorToast()` from `lib/toast.ts`

## Hooks Used
- `useCellSelection`, `useClipboardCopy`, `useCellDelete`, `useCellAggregation`, `useStatusBar`

## Server Action Contract
```ts
saveBulkTrucks(payload: BulkSavePayload<TablesInsert<'truck_readings'>, TablesUpdate<'truck_readings'>>)
  => Promise<{ ok: true, insertedCount, updatedCount, deletedCount } | { ok: false, error: string }>
```

## Data Fetch
`fetchTrucksTabData(year?, month?)` — fetches current-month readings + full monthly view. Return shape unchanged.
