# Production — Electricity Tab

## Purpose
Daily electricity meter readings (MAIN / BUNKHOUSE / PUMP) with computed DIFF and TTL PHP. Monthly summary from `view_electricity_monthly`.

## Files
| File | Role |
|------|------|
| `actions.ts` | `fetchElectricityTabData`, `saveBulkElectricity`. Imports `BulkSavePayload` from `../daily/actions`. |
| `electricity-view.tsx` | Period indicator wrapper — passes to `ElectricityGrid` |
| `electricity-grid.tsx` | Inline-editable grid for `electricity_readings` + compact monthly summary table |

## Column Order
`#` / DATE / METER (Select + custom) / START KWH / END KWH / DIFF (computed, read-only) / RATE (price-gated) / TTL PHP (computed, price-gated) / REM / [delete]

## Key Behaviors
- **Meter select:** MAIN / BUNKHOUSE / PUMP dropdown; choosing "Other (type manually)" switches to free-text Input for that row
- **Price gating:** RATE and TTL PHP columns hidden for Production role (`!hasPermission('view:prices')`)
- **Computed DIFF:** `end_kwh - start_kwh`, shown as read-only muted cell
- **Computed TTL PHP:** `diff × rate`, shown as read-only with ₱ accounting format
- **Monthly summary:** `view_electricity_monthly` compact table below the grid (RATE col and TTL PHP col also price-gated here)
- **Validation:** end_kwh ≥ start_kwh, rate ≥ 0 — enforced server-side in `saveBulkElectricity`
- **Empty state:** `animate-fade-up` message "Awaiting Production Manager sync..."
- **Error toasts:** `errorToast()` from `lib/toast.ts`

## Hooks Used
- `useCellSelection`, `useClipboardCopy`, `useCellDelete`, `useCellAggregation`, `useStatusBar`

## Server Action Contract
```ts
saveBulkElectricity(payload: BulkSavePayload<TablesInsert<'electricity_readings'>, TablesUpdate<'electricity_readings'>>)
  => Promise<{ ok: true, insertedCount, updatedCount, deletedCount } | { ok: false, error: string }>
```

## Data Fetch
`fetchElectricityTabData(year?, month?)` — fetches current-month readings + full monthly view. Return shape unchanged.
