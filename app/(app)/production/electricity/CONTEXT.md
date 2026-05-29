# Production — Electricity Tab

## Purpose
Daily electricity meter readings (MAIN / BUNKHOUSE / PUMP) with computed DIFF and TTL PHP.

> **Note:** The monthly summary table (fed by `view_electricity_monthly`) was removed (May 2026) — the format was undesired. The `view_electricity_monthly` DB view still exists but is no longer fetched or rendered.

## Files
| File | Role |
|------|------|
| `actions.ts` | `fetchElectricityTabData(year, month)`, `saveBulkElectricity`. Defines `BulkSavePayload` locally. |
| `electricity-view.tsx` | Scope-label wrapper (shows "Showing: {scope}") — passes readings to `ElectricityGrid`. Accepts `year: number\|null`, `month: number\|null`. |
| `electricity-grid.tsx` | Inline-editable grid for `electricity_readings` |

## Column Order
`#` / DATE / METER (Select + custom) / START KWH / END KWH / DIFF (computed, read-only) / RATE (price-gated) / TTL PHP (computed, price-gated) / REM / [delete]

## Key Behaviors
- **Meter select:** MAIN / BUNKHOUSE / PUMP dropdown; choosing "Other (type manually)" switches to free-text Input for that row
- **Price gating:** RATE and TTL PHP columns hidden for Production role (`!hasPermission('view:prices')`)
- **Computed DIFF:** `end_kwh - start_kwh`, shown as read-only muted cell
- **Computed TTL PHP:** `diff × rate`, shown as read-only with ₱ accounting format
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
`fetchElectricityTabData(year?: number | null, month?: number | null)` — filters `electricity_readings` by `reading_date`. Driven by the **module-level shared period** (see `production/CONTEXT.md` → "Universal Period Control"):
- `year=null` → all readings (no date filter)
- `year=<num>, month=null` → all readings in that calendar year
- `year=<num>, month=<n>` → that month of that year (`month` is 0-indexed)

The `electricity-lazy-tab` derives `month = batchToMonth(batch)` from the shared batch before calling (unrecognized/null batch → null month → whole year). `undefined` args fall back to the current month for backwards compatibility. Returns `{ data: { readings, year, month } }`.
