# Deliveries Manager Memory

- [Feeding-status remarks → always db_wins](feedback_feeding_status_remarks.md) — "DONE FEEDING" text in remarks is RC OUT domain; never adopt into deliveries rows
- [DB triggers on deliveries table](project_db_triggers_on_deliveries.md) — EXECUTE must: batch-insert & delivery-insert in SEPARATE statements (CTE fails); audit_logs is auto-written by trigger so UPDATE its comment, never INSERT a dup
