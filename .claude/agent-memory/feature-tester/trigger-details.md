# Notification Trigger Details

## Trigger Chain for Deliveries

### INSERT delivery
1. `tr_blackwood_delivery` -> `fn_update_blackwood_state()` (batch state)
2. `deliveries_audit_trigger` -> `log_delivery_changes()` (audit log)
3. `trg_notify_delivery_created` -> `fn_notify_delivery_created()` (notification)

### UPDATE delivery
1. `deliveries_audit_trigger` -> `log_delivery_changes()` (creates audit_log INSERT)
2. `trg_notify_remarks_added` -> `fn_notify_remarks_added()` (only if remarks changed)
3. The audit_log INSERT fires: `trg_notify_delivery_edited` -> `fn_notify_delivery_edited()`

### DELETE delivery
1. `deliveries_audit_trigger` -> `log_delivery_changes()` (creates audit_log INSERT with snapshot)
2. The audit_log INSERT fires: `trg_notify_delivery_deleted` -> `fn_notify_delivery_deleted()`

## Dedup Behavior
- `_insert_notification()` checks for same (user_id, type, metadata @> p_metadata) within 60 seconds
- `fn_notify_delivery_created` does NOT use `_insert_notification()` -- uses raw INSERT
- All other triggers use `_insert_notification()` via PERFORM

## NULL auth.uid() Behavior
- `fn_notify_delivery_created`: Sets source_user_id=NULL, body="Added by unknown", sends to ALL profiles
- `fn_notify_delivery_edited`: Sets source_user_id=NULL, skip-editor logic fails (NULL comparison), sends to ALL
- `fn_notify_delivery_deleted`: WHERE id != NULL fails, sends to NOBODY (silent failure)
- `fn_notify_remarks_added`: Looks up creator from audit_logs.performed_by; if NULL, skips entirely
