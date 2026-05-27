---
name: feeding-status-remarks-db-wins
description: "DONE FEEDING" and similar feeding-status text in remarks is RC OUT domain — always db_wins on delivery rows
metadata:
  type: feedback
---

"DONE FEEDING" / "done FEEDING" / "done feeding" / any feeding-completion status text in the `remarks` field of a delivery row belongs to the **RC OUT domain**, not RC IN. The operator uses this text to mark that a delivery batch has been consumed into the production line — that event is recorded separately by the RC Out Manager in `rc_out`.

The `deliveries` table should preserve its original remarks (or null). Never adopt feeding-status text into a delivery row.

**Why:** Renzo's explicit instruction on 2026-05-27, first native invocation of deliveries-manager. These remarks are cross-domain signals written by operators into the RC IN spreadsheet for their own reference, but they describe an RC OUT event. Pulling them into `deliveries.remarks` would muddy the domain boundary.

**How to apply:** In the VALUE_CHANGED classification step, whenever the only diff is `remarks` and the email value matches `/done.?feeding/i` or similar feeding-completion text, always recommend `db_wins` — do not propose `email_wins` for these. Log the skip reason in the PROPOSE report.

See also: [[rc-out-domain-boundary]]
