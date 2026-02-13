# Plan: Test Realtime Notifications with Feature Tester Agent

## Context
We just replaced the 10-second polling mechanism in `NotificationBell` with a Supabase Realtime subscription (`postgres_changes`). The migration `enable_realtime_notifications` was applied (added `notifications` to `supabase_realtime` publication + set `REPLICA IDENTITY FULL`). Now we need to verify the realtime subscription actually works end-to-end.

## What to Test
The feature-tester agent will validate the realtime notification system by directly inserting/updating rows in the `notifications` table via Supabase MCP and observing the effects.

### Test Cases

1. **Realtime publication is active** — Query `pg_publication_tables` to confirm `notifications` is in the `supabase_realtime` publication
2. **REPLICA IDENTITY is FULL** — Query `pg_class` to confirm replica identity setting
3. **INSERT triggers realtime** — Insert a test notification row for a known user, verify the row exists
4. **UPDATE triggers realtime** — Update the test notification's `read` from `false` to `true`, verify the update persists and includes old+new row data (REPLICA IDENTITY FULL)
5. **RLS policies don't block realtime** — Confirm the existing RLS policies allow the subscription to work (SELECT policy filters by `user_id = auth.uid()`)
6. **Cleanup** — Delete all `TEST_`-prefixed notification rows created during the session

### Key Files
- `components/notification-bell.tsx` — Realtime subscription code (lines 144–203)
- `app/(app)/notifications/actions.ts` — Server actions (unchanged, for reference)
- `supabase/migrations/20260212143529_add_rls_policies_for_notifications.sql` — RLS policies

### Notification table schema (from actions.ts types)
```
id, user_id, type, title, body, metadata, read, read_at, created_at, source_user_id, archived
```

## Execution
Launch the `feature-tester` agent with a prompt to:
1. Verify the migration was applied (publication + replica identity)
2. Get a valid `user_id` from the `profiles` table to target
3. Insert a test notification (`title: 'TEST_REALTIME_001'`, `type: 'delivery_created'`)
4. Update it (`read: true`)
5. Verify both operations persisted correctly
6. Clean up all test rows
7. Report findings

## Verification
The agent's report will confirm whether the DB-level prerequisites for realtime are correctly configured. Client-side subscription behavior (badge animation, count increment) requires manual browser testing — the agent will note this in its report.
