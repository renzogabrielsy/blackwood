---
name: feedback-reconciliation-scope
description: Reconciliation HARD gate should only apply to dates > watermark, not all historical dates in the PROPOSED file
metadata:
  type: feedback
---

The PROPOSED DAILY REPORT XLSX contains the full year-to-date history (one sheet per day). Reconciliation runs against all dates in that file by default, but pre-watermark dates were already approved and written in prior sessions.

**Rule:** The PROPOSED vs RC MOVEMENT HARD gate (>500 kg drift = halt) MUST only fire for dates strictly greater than the watermark (`MAX(rc_out.transaction_date)`). Pre-watermark dates may contain known historical drift — for example, an "UNMAPPED" row that was correctly excluded in a prior run will show as drift in the PROPOSED total but will not appear in rc_out.

**Why:** On 2026-05-27, the 2026-05-15 date showed PROPOSED=29,024 kg vs RC MOVEMENT=28,087 kg — a 937 kg SERIOUS drift. Investigation confirmed the 6 non-"601" rows were already in rc_out with total_kg=28,087, exactly matching RC MOVEMENT. The "601" block (937 kg, no batch_code) had been correctly excluded as UNMAPPED in a prior session. Re-checking it on every future run creates a false halt.

**How to apply:** After fetching and extracting the PROPOSED file, filter its rows to `transaction_date > watermark` before passing to `reconcile_rc_movement.py`. The reconciler has no `--min-date` flag as of 2026-05-27 — apply the filter by writing a `extract_proposed_new_only.json` intermediate file (rows where `transaction_date > watermark`), then pass that to the reconciler instead of the full extract.

**Related:** [[feedback-classify-rc-out-input-format]]
