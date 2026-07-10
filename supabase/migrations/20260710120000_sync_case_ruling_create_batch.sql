-- Sync visibility overhaul — allow the `create_batch` ruling action.
--
-- A genuinely-new batch (e.g. JULY-26-FEED1) recurs every run as an
-- `unmapped_batch_code` / `unresolved_batch` flag because the sync NEVER auto-creates a
-- batch (CLAUDE.md hard rule). The ONE human-confirmed exception — the reviewer clicks
-- "create this batch" in Sync Review — inserts the batch and re-attempts the row(s) that
-- were skipped, then records a sync_case_rulings row whose action is 'create_batch'.
-- That value is not allowed by the prior CHECK
-- (dismiss | apply | edit_apply | override_gate | pick_source); this migration widens it.
-- Minimal + idempotent.
--
-- See app/(app)/sync/resolve.ts::executeCreateBatch + lib/sync/create-batch-plan.ts.

alter table public.sync_case_rulings
  drop constraint if exists sync_case_rulings_action_check;

alter table public.sync_case_rulings
  add constraint sync_case_rulings_action_check
  check (action in ('dismiss', 'apply', 'edit_apply', 'override_gate', 'pick_source', 'create_batch'));

comment on column public.sync_case_rulings.action is
  'What the human decided: dismiss | apply | edit_apply | override_gate | pick_source | create_batch.';
