# RC Out Manager Memory

- [Reconciliation scope: new-only gate](feedback_reconciliation_scope.md) — HARD gate only fires for dates > watermark; pre-watermark drift is expected historical state from prior UNMAPPED exclusions
- [classify_rc_out.py db_rows input format](feedback_classify_rc_out_input_format.md) — db_rows_json must be `[{"data": [...]}]` not `{"data": [...]}` — write with the array wrapper
- [Trigger: active-batch-per-location collision](feedback_trigger_active_batch_location_collision.md) — rc_out INSERT re-activating a CLOSED batch into an occupied location trips idx_unique_active_batch_per_location; hold that row, insert the rest
- [No label on partial write](feedback_no_label_on_partial_write.md) — never apply Blackwood-Processed to PROPOSED when any date/row was halted/held; watermark handles re-fetch
- [Pathway/PCB overflow + continuation pallets](feedback_pathway_pcb_and_continuation.md) — Learning Ledger L-002/L-003: pathway/PC-zone feeds are overflow SUNDRY batches (HOLD, don't derive a BLK); bare-number no-BLOCK-DATE sections are continuation pallets (never a separate row, never count toward daily total or the reconcile gate)
