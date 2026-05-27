# RC Out Manager Memory

- [Reconciliation scope: new-only gate](feedback_reconciliation_scope.md) — HARD gate only fires for dates > watermark; pre-watermark drift is expected historical state from prior UNMAPPED exclusions
- [classify_rc_out.py db_rows input format](feedback_classify_rc_out_input_format.md) — db_rows_json must be `[{"data": [...]}]` not `{"data": [...]}` — write with the array wrapper
