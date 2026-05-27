---
name: jarvis-ingestion-pipeline
description: Phase A AI ingestion pipeline — RC Deliveries extractor, classifier, diff engine, review queue server actions
metadata:
  type: project
---

# Jarvis Ingestion Pipeline — Phase A (2026-05-27)

**Why:** Eliminate manual XLSX copy-paste by extracting rows from operator emails, classifying them against live DB data, and surfacing diffs for human approval.

**How to apply:** Phase B (Gmail poller) calls uploadForReview() internally. The locked contract in `app/(app)/review-queue/actions.ts` must not change without coordinating with the frontend agent.

## Files shipped

- `supabase/migrations/20260527000000_create_ingestion_watermarks.sql` — `ingestion_watermarks` table (Phase B writes here)
- `lib/jarvis/extractors/rc-deliveries.ts` — `RcDeliveriesExtractor` (first real extractor)
- `lib/jarvis/classifier.ts` — `classifyEmail()` + `extractorForType()` + REGISTRY
- `lib/jarvis/diff-engine.ts` — `classifyRow()` — live DB lookup + field diff
- `app/(app)/review-queue/actions.ts` — 5 locked server actions
- `app/(app)/review-queue/CONTEXT.md` — module documentation
- `components/review-queue/ReviewDetailPanel.tsx` — stub (frontend agent replaced it)

## Key patterns

### Json cast pattern (Supabase JSONB → typed TS)
`rows_json` is typed as `Json` from Supabase. When reading back as a typed struct, always cast via `unknown` first:
```typescript
const rows = (row.rows_json as unknown as ClassifiedRow[]) ?? []
```
Direct `as ClassifiedRow[]` causes TS error: "neither type sufficiently overlaps with the other".

### Generic .from() with typed client
The typed admin client's `.from()` requires a literal table-name union. For generic code that accepts a runtime `targetTable: string`, cast admin to `any`:
```typescript
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let query = (admin as any).from(targetTable).select('*')
```

### xlsx (SheetJS) v0.18.5
- `XLSX.read(buffer, { type: 'buffer', cellDates: true })` — `cellDates: true` converts Excel date serials to JS Date objects
- `XLSX.utils.sheet_to_json(ws, { header: 1, defval: null, blankrows: false })` — returns `unknown[][]`
- `XLSX.SSF.parse_date_code(n)` — fallback for date serial passthrough
- Install: `npm install xlsx` (no exceljs — just SheetJS)

### Adding Phase B extractors
1. Implement `ReportExtractor` in `lib/jarvis/extractors/<name>.ts`
2. Add instance to REGISTRY in `lib/jarvis/classifier.ts`
3. Add natural key + compare field config in `app/(app)/review-queue/actions.ts` uploadForReview()
4. The DB write path (insertDelivery/updateDelivery) is rc_deliveries-specific — extend for other target tables

## Classification logic

Natural key for deliveries: `(transaction_date, batch_code, block_loc, weight_kg)`
Compare fields: `supplier, truck_plate, sacks, cost_basis, remarks, lab_results`

- NEW → insert on approve
- DUPLICATE_NOOP → silently dropped (not persisted, counted in noopCount)
- VALUE_CHANGED → queued with diff; decision: email_wins / db_wins / both

## Audit trail

`set_audit_comment()` RPC called before each INSERT/UPDATE on deliveries. This sets a pg session variable that the DB audit trigger picks up. The admin/service-role client doesn't carry session context automatically — the RPC call injects it manually.
