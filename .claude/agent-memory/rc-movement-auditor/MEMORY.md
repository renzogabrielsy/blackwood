# RC Movement Auditor — Memory Index

- [view_rc_movement is an rc_out projection](project_view_rc_movement_is_rc_out_projection.md) — view fed_today sum per date always == SUM(rc_out.weight_kg); not an independent cross-check axis.
- [Negative-balance batches are pre-existing](anomaly_negative_balance_batches_are_preexisting.md) — standing cluster of over-consumed batches (OCT-25-BLK9 etc.); flag as pre-existing, escalate only deltas.
- [Cross-sheet date duplicate](anomaly_cross_sheet_date_duplicate.md) — one feed date can span two month tabs (e.g. 5/29 on MAY+June); sum across sheets, don't trust date_to_fed_kls last-write-wins.
