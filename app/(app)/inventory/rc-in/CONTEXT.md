# RC IN Module — Delivery Master Log

## Purpose
Captures incoming raw charcoal deliveries. Dense Excel-like grid with paste support, keyboard navigation, audit trails, and role-based cost visibility.

## Files
| File | Lines | Role |
|------|-------|------|
| `page.tsx` | 107 | Server component — fetches deliveries, batches, role; year-based pagination |
| `actions.ts` | 617 | 9 server actions: `submitBulkDeliveries`, `bulkUpdateDeliveries`, `bulkDeleteDeliveries`, `deleteDelivery`, `updateDelivery`, `getDeliveryHistory`, `getAuditComments`, `getAuditLogEntry`, `addAuditComment` + 4 resolve actions |
| `bulk-delivery-input.tsx` | 1229 | Client grid editor — paste, keyboard nav, autocomplete, edit tracking |
| `delivery-master-table.tsx` | 937 | Client data table — virtual scroll, filtering, year/month controls |
| `paste-utils.ts` | 81 | Excel date parsing, cell value cleaning |
| `components/DeliveryHistoryDialog.tsx` | 561 | Delivery history + audit trail dialog |
| `components/DeliverySheetFooter.tsx` | 228 | Year selector + sliding month indicators (shared with RC OUT) |
| `components/audit-shared.tsx` | 87 | Shared audit display utilities |
| `edit/[auditLogId]/page.tsx` | 30 | Server component for edit discussion page |
| `edit/[auditLogId]/edit-discussion.tsx` | 452 | Resolve/request workflows, comments, diff display |
| `auth-context.tsx` | 3 | Re-export from shared location |
| `table-settings.tsx` | 2 | Re-export from shared location |
| `error.tsx` | 25 | Error boundary |
| `loading.tsx` | 47 | Loading skeleton |

## Data
- **Tables:** `deliveries`, `batches` (upserted), `audit_logs`, `audit_comments`, `profiles`
- **Views:** `view_rc_in_master`
- **RPC:** `set_audit_comment(comment text)` — sets comment context before update trigger fires
- **Types:** `DeliveryRow`, `InputDeliveryRow`, `AuditLogRow`, `AuditComment` (in `types/rc-in.ts`)

## Key Behaviors
- **Batch upsert-first:** Dedup by `batch_code` via JS Map, upsert batches before inserting deliveries
- **Cost scrubbing:** Production role users have `cost_basis` stripped from history snapshots/diffs in `getDeliveryHistory()` and `getAuditLogEntry()`
- **Year-based pagination:** URL param `?year=2024`; month filtering done client-side via string slicing on `YYYY-MM-DD` (avoids timezone issues)
- **Paste-grid:** Tab-separated clipboard → Excel serial date parsing, currency stripping, auto-row expansion
- **Virtual scroll:** `@tanstack/react-virtual` with `overscan: 15`, respects user's `rowHeight` setting
- **Audit resolve workflow:** Employees request resolve/reopen; Admins directly toggle or approve/deny requests; system messages auto-posted to `audit_comments`
- **Keyboard nav:** Arrow keys, Tab, Enter, F2 (edit), Escape (revert), printable chars (type-over)

## Dependencies
- `@/lib/rc-utils.ts` — `calculateWhse()` derives warehouse from block_loc first letter
- `@/lib/field-labels.ts` — `getFieldLabel()`, `formatFieldValue()`, `flattenLabResultsDiff()`
- `@/lib/auth.ts` — `getUserRole()` (includes dev override check)
- `@/components/providers/auth-context` — `useAuth()`, `hasPermission('view:prices')`
- `@/components/providers/table-settings` — `useTableSettings()` (fontSize, rowHeight)
- `@tanstack/react-table`, `@tanstack/react-virtual`, `date-fns`, `sonner`

## See Also
- [RC OUT](../rc-out/CONTEXT.md) — shares `DeliverySheetFooter` and `parseExcelDate()`
- [Auth Provider](../../../../components/providers/AUTH.md) — permission model for cost visibility
- [Navbar](../../../../components/NAVBAR.md) — breadcrumb registration
