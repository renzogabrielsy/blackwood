-- R3a — Sync Reconciliation Model: allow the `pick_source` ruling action.
--
-- A `source_diff` case (kind='source_diff') is resolved by PICKING which source's
-- value is authoritative for a natural key (SYNC_RECONCILIATION_MODEL.md Stage 3 /
-- R3). That resolution records a sync_case_rulings row whose action is 'pick_source'
-- — a new value the original CHECK (dismiss | apply | edit_apply | override_gate)
-- does not allow. This migration widens the CHECK to include it. Minimal + idempotent.
--
-- The recorded 'pick_source' ruling is ALSO what R4 will consult to retire "Sheet-wins":
-- it is the durable record of which source the human made authoritative for that key, so
-- a later gsheet run can be stopped from re-clobbering the human correction (see
-- app/(app)/sync/resolve.ts::executeDiffResolution + LEARNING_LEDGER L-037).

alter table public.sync_case_rulings
  drop constraint if exists sync_case_rulings_action_check;

alter table public.sync_case_rulings
  add constraint sync_case_rulings_action_check
  check (action in ('dismiss', 'apply', 'edit_apply', 'override_gate', 'pick_source'));

comment on column public.sync_case_rulings.action is
  'What the human decided: dismiss | apply | edit_apply | override_gate | pick_source.';
