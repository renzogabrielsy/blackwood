---
name: db-triggers-on-deliveries
description: The deliveries table has DB triggers that auto-write audit_logs and enforce batch existence — affects how EXECUTE must insert. Two corrections to the agent playbook.
metadata:
  type: project
---

The `deliveries` table carries DB triggers that change how EXECUTE-mode writes must be done. Verified empirically on 2026-05-29 during the first real EXECUTE run.

Triggers on `public.deliveries` (from `pg_trigger`):
- `tr_blackwood_delivery` — **BEFORE INSERT/UPDATE/DELETE**, `fn_update_blackwood_state()`. On INSERT it does `SELECT * INTO target_batch FROM batches WHERE batch_code = NEW.batch_code` and, if not FOUND, `RAISE EXCEPTION 'Batch Code % does not exist in the System Map.'`. It also recomputes the batch's `current_weight` and `avg_cost` automatically after insert — so I never compute those myself.
- `deliveries_audit_trigger` — **AFTER INSERT/UPDATE/DELETE**, `log_delivery_changes()`. **Auto-writes the `audit_logs` row** (snapshot populated, `comment` left NULL).
- `trg_notify_delivery_created` (AFTER INSERT) and `trg_notify_remarks_added` (AFTER UPDATE) — fire notifications automatically. Expected DB behavior, not my concern.

**Correction 1 — never batch-create + delivery-insert in one CTE/statement.**
Postgres CTEs share one MVCC snapshot, so a `WITH batch_upsert AS (INSERT…batches…), delivery_insert AS (INSERT…deliveries…)` fails: the BEFORE-INSERT trigger firing during the delivery insert can't see the not-yet-visible batch row and raises "does not exist in the System Map". The whole statement rolls back atomically (no partial write).
**Why:** snapshot isolation + the BEFORE trigger's existence check.
**How to apply:** Do the batch upsert as its OWN statement first (Step 3), THEN the delivery INSERT as a separate statement (Step 4). This is already what the [[db-triggers-on-deliveries]] EXECUTE protocol prescribes — just never collapse the two steps.

**Correction 2 — do NOT manually `INSERT INTO audit_logs` for delivery inserts.**
The agent definition's Step 6 says to `INSERT INTO audit_logs` per delivery insert. But `deliveries_audit_trigger` already inserts that row automatically. A manual insert would create a DUPLICATE audit row.
**Why:** the DB owns audit-row creation for `deliveries` via trigger; the playbook predates that trigger.
**How to apply:** After inserting a delivery, the audit row already exists with a NULL comment. **UPDATE** that row to attach provenance (`UPDATE audit_logs SET comment=… WHERE record_id=<new_delivery_id> AND comment IS NULL`) instead of inserting a new one. For genuine UPDATE-path writes (email_wins), check whether the trigger also logs those before adding a manual entry.

Note: `audit_logs` has no `created_at` column — don't reference it in RETURNING.
See [[feedback_feeding_status_remarks]] for the db_wins remark rule.
