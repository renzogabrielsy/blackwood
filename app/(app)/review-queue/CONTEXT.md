# Review Queue — CONTEXT.md

## Purpose

Manual-upload entry point for the AI ingestion pipeline (Phase A). Operators upload an XLSX file; the backend extracts rows, classifies each against the live `deliveries` table (NEW / VALUE_CHANGED / DUPLICATE_NOOP), and queues the results for human review. On approval, rows are written to `deliveries` via the same audit machinery used by the RC IN module.

Phase B (Gmail integration) will call the same server action contract internally — the review queue never needs to know how data arrived.

## Files

### Backend (supabase-backend-engineer's domain)
- `app/(app)/review-queue/actions.ts` — 5 locked server actions (see contract below)
- `lib/jarvis/extractors/rc-deliveries.ts` — RcDeliveriesExtractor (Phase A extractor)
- `lib/jarvis/extractor/types.ts` — ReportExtractor + ExtractedRow interfaces
- `lib/jarvis/classifier.ts` — classifyEmail() + extractorForType() — extractor registry
- `lib/jarvis/diff-engine.ts` — classifyRow() — live DB lookup + field comparison

### Frontend (senior-frontend-engineer's domain)
- `app/(app)/review-queue/page.tsx` — Server component shell (role-gated to Owner/Admin/Dev, calls `listPending()`, hands the result + any load error to the client wrapper)
- `app/(app)/review-queue/loading.tsx` — Skeleton (upload form + responsive card grid placeholders)
- `components/review-queue/ReviewQueueClient.tsx` — Orchestrator; holds `activeId` state, swaps between list and detail panel, owns the inline error banner + empty state
- `components/review-queue/UploadXlsxForm.tsx` — File picker (`.xlsx,.xls`) + report type select + submit; calls `uploadForReview(formData)`; success toast `{n} new · {n} changed · {n} unchanged`, errors via `errorToast()`
- `components/review-queue/PendingReviewList.tsx` — Card-per-pending grid (1/2/3 cols responsive); each card shows confidence dot, report type, filename, received-time, and badges for new/changed/skipped counts; `hover-lift` + keyboard activation (Enter/Space)
- `components/review-queue/ReviewDetailPanel.tsx` — Fetches `getReviewDetail(id)` on mount; sticky glass header (confidence + report type + filename), diagnostic banner, classified rows table, sticky footer with Approve / Reject; Reject opens an `AlertDialog` with optional reason
- `components/review-queue/ClassifiedRowsTable.tsx` — Excel-dense `table-fixed` with explicit column widths matching RC IN canonical order; per-row decision toggle column; changed cells get a left amber border + dual-value display (email bold on top, DB struck-through below)
- `components/review-queue/RowDecisionToggle.tsx` — 3-state segmented control (`email_wins` / `db_wins` / `both`); hand-rolled on buttons because the project has no `ToggleGroup`/`RadioGroup` primitive
- `components/review-queue/ConfidenceDot.tsx` — Shared dot indicator. Green ≥0.9, amber 0.7–0.9, red <0.7, gray unknown; tooltip-wrapped by default

### Navbar registration
- `components/navbar.tsx` — `/review-queue` route registered in `getBreadcrumb()` and linked from the Modules dropdown (gated on `PRIVILEGED_ROLES`)

## Locked Server Action Contract

```typescript
// Must not be changed without coordinating with the frontend agent.

uploadForReview(formData: FormData): Promise<{
  pendingReviewId: string
  classifiedCount: number
  newCount: number
  changedCount: number
  noopCount: number  // silently filtered, reported for UX
}>

listPending(): Promise<PendingReviewSummary[]>

getReviewDetail(id: string): Promise<PendingReviewDetail>

approveReview(input: {
  id: string
  decisions: Record<number, 'email_wins' | 'db_wins' | 'both'>
}): Promise<{ inserted: number; updated: number; skipped: number }>

rejectReview(input: { id: string; reason?: string }): Promise<{ ok: true }>
```

## Data

### Tables

- `pending_review` — one row per uploaded XLSX. `rows_json` holds the classified rows (NEW/VALUE_CHANGED only; DUPLICATE_NOOP are silently filtered). `diagnostic_json` holds extraction stats and warnings.
- `ingestion_watermarks` — one row per report_type. Phase B (Gmail poller) writes here to track last-processed email. Not read by Phase A.

### Classification Logic

Each extracted row gets a live SQL lookup against `deliveries` by natural key `(transaction_date, batch_code, block_loc, weight_kg)`:
- **NEW** — natural key absent → queue for insert
- **DUPLICATE_NOOP** — natural key present, all compare fields match → silently skipped
- **VALUE_CHANGED** — natural key present, ≥1 compare field differs → queue with diff

Compare fields: `supplier`, `truck_plate`, `sacks`, `cost_basis`, `remarks`, `lab_results`

### RLS
- `pending_review`: SELECT any authenticated; INSERT/UPDATE/DELETE only `is_admin(auth.uid())`
- Server actions use the service-role admin client for all reads/writes to bypass RLS

## Key Behaviors

### uploadForReview
1. Authenticate user (throws if not authenticated)
2. Extract XLSX via RcDeliveriesExtractor (or registered extractor for reportType)
3. Classify each row via classifyRow() — live DB queries
4. Filter out DUPLICATE_NOOP rows (count returned in noopCount, not persisted)
5. Insert pending_review row via admin client
6. revalidatePath('/review-queue')

### approveReview
- NEW rows: always insert into deliveries (upsert batch first)
- VALUE_CHANGED + decision='email_wins': UPDATE existing delivery
- VALUE_CHANGED + decision='db_wins': skip (count as skipped)
- VALUE_CHANGED + decision='both': INSERT as new row (split-shipment scenario)
- set_audit_comment() RPC called before each write (audit trail)
- revalidatePath('/review-queue') + revalidatePath('/inventory/rc-in') + revalidatePath('/inventory')

### Decision handling for VALUE_CHANGED rows
- `email_wins` — trust the incoming XLSX; overwrite DB values
- `db_wins` — keep DB as-is; this XLSX row is stale or wrong
- `both` — legitimate split shipment (same batch, same day, same location, same weight but different supplier/truck); INSERT alongside existing

## Dependencies

- `xlsx` (SheetJS) — XLSX parsing (installed via npm install xlsx)
- `@/lib/supabase/admin` — createAdminClient() for service-role writes
- `@/lib/supabase/server` — createClient() for user auth check
- `@/lib/validation` — normalizeBlockLoc() for block_loc normalization
- `@/lib/jarvis/extractors/rc-deliveries` — RcDeliveriesExtractor
- `@/lib/jarvis/classifier` — extractor registry
- `@/lib/jarvis/diff-engine` — live classification

## See Also

- `AI_INGESTION_AGENT.md` — full ingestion pipeline design
- `app/(app)/jarvis/CONTEXT.md` — Jarvis AI agent (shares extractor infrastructure)
- `app/(app)/inventory/rc-in/CONTEXT.md` — RC IN module (target for approved rows)
- `lib/jarvis/extractors/types.ts` — ReportExtractor interface
- `supabase/migrations/20260527000000_create_ingestion_watermarks.sql` — watermarks table
