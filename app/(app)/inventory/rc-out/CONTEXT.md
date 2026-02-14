# RC OUT Module — Inventory Usage

## Purpose
Tracks raw charcoal consumption/depletion from batches. Excel-like grid input with infinite scroll table, computed pricing columns, and batch code resolution.

## Files
| File | Lines | Role |
|------|-------|------|
| `page.tsx` | 102 | Server component — fetches initial data, date filtering, passes to RcOutTable |
| `actions.ts` | 212 | 6 server actions: `getRcOutRecords`, `deleteRcOutRecord`, `bulkDeleteRcOut`, `createRcOutRecord`, `submitBulkUsage`, `bulkUpdateUsage` |
| `bulk-usage-input.tsx` | 1010 | Client grid editor — keyboard nav, paste, autocomplete, batch resolution |
| `components/rc-out-table.tsx` | 818 | Client data table — virtual scroll, infinite scroll, filtering, bulk ops |
| `paste-utils.ts` | 30 | Column mapping and cell value cleaning |

## Data
- **Table:** `rc_out` — `id`, `transaction_date`, `batch_id` (FK→batches), `production_batch`, `destination`, `weight_kg`, `block_loc`, `remarks`, `created_at`
- **Computed columns:** `rc_out_avg_price` (aliased as `avg_price`), `rc_out_avg_wtd_value` (aliased as `avg_wtd_value`) — PostgreSQL generated columns, NOT calculated in JS
- **Joins:** `batches(batch_code)` for display
- **Types:** `RcOutRow`, `RcOutInput`, `InputRcOutRow` (defined locally in actions/components)

## Key Behaviors
- **Batch code → batch_id resolution:** User selects by `batch_code` (text); module resolves to `batch.id` (UUID) before insert. Skipped rows toast a warning.
- **Infinite scroll (not month-based):** Initial load = 40 records, subsequent = 15 per trigger. `hasMore` set to false when batch returns < 15.
- **Month + year filtering:** URL params `year` and `month` (0-indexed). Date filters bypassed when search is active.
- **Computed DB columns:** `avg_price` and `avg_wtd_value` are DB-computed — never calculated client-side. Permission-gated behind `view:prices`.
- **Audit trail:** Updates use `set_audit_comment()` RPC + `audit_comments` posting, same pattern as RC IN.
- **Auto-fill block_loc:** Selecting a batch auto-populates `block_loc` from `batch.location_ref`.

## Dependencies
- `../rc-in/paste-utils` — shares `parseExcelDate()` for paste operations
- `../../rc-in/components/DeliverySheetFooter` — shared footer with sliding month/year indicators
- `@/components/providers/auth-context` — `hasPermission('view:prices')` gates price columns
- `@/components/providers/table-settings` — fontSize, rowHeight settings
- `@tanstack/react-table`, `@tanstack/react-virtual`, `date-fns`, `sonner`

## See Also
- [RC IN](../rc-in/CONTEXT.md) — shares footer component and paste utilities
- [Auth Provider](../../../../components/providers/AUTH.md) — permission model for price visibility
- [Navbar](../../../../components/NAVBAR.md) — breadcrumb registration
