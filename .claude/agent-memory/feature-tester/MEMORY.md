# Feature Tester Agent Memory

## Database Schema Quick Reference
- 2 profiles: Renzo Sy (Owner, `2503f371...`), Test User (Admin, `7f95620b...`)
- Notifications use `notification_type` enum: resolve_request, resolve_approved, resolve_denied, delivery_created, delivery_edited, delivery_deleted, remarks_added, audit_comment_reply
- `notifications.source_user_id` FK to `auth.users` with ON DELETE SET NULL
- `notifications.user_id` FK to `auth.users` with ON DELETE CASCADE

## Notification Triggers (see `trigger-details.md` for full analysis)
- `fn_notify_delivery_created` -- fires on deliveries INSERT, uses RAW INSERT (no dedup!)
- `fn_notify_delivery_edited` -- fires on audit_logs INSERT where operation='UPDATE'
- `fn_notify_delivery_deleted` -- fires on audit_logs INSERT where operation='DELETE'
- `fn_notify_remarks_added` -- fires on deliveries UPDATE when remarks change
- `fn_notify_resolve_request` -- fires on audit_logs UPDATE when resolve_requested flips true
- `fn_notify_resolve_decision` -- fires on audit_logs UPDATE when resolve_requested flips false
- `fn_notify_audit_comment` -- fires on audit_comments INSERT

## Known Issues
- `fn_notify_delivery_created` bypasses `_insert_notification` dedup - uses raw INSERT
- All notification triggers use `auth.uid()` which is NULL in service-role context
- `fn_notify_delivery_deleted` WHERE clause `id != v_deleter_id` silently fails when v_deleter_id is NULL (SQL NULL comparison)
- Remark changes trigger BOTH `remarks_added` AND `delivery_edited` notifications (via audit log)
- Duplicate RLS policies on notifications table (one for `public`, one for `authenticated`)
- Notifications INSERT policy has `WITH CHECK (true)` -- overly permissive (flagged by advisor)

## Cleanup Order (FK constraints)
1. notification_subscriptions (FK to audit_logs, auth.users)
2. audit_comments (FK to audit_logs, auth.users)
3. notifications (FK to auth.users)
4. audit_logs (FK to auth.users)
5. deliveries (FK to batches.batch_code)
6. batches

## Realtime Configuration
- Notifications table in `supabase_realtime` publication with ALL columns
- REPLICA IDENTITY = FULL (needed for UPDATE events to include old row)
- Client uses `setAuth()` with session token for RLS-filtered Realtime

## Testing Patterns
- Service role SQL bypasses auth.uid() -- triggers that depend on auth.uid() behave differently
- Use `_insert_notification()` function directly to test dedup
- Test data prefix: `QA_` for suppliers/batch codes, metadata keys like `QA_DEDUP_001`
