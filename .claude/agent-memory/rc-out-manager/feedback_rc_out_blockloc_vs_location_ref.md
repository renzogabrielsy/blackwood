---
name: rc-out-blockloc-vs-location-ref
description: rc_out feed where operator block_loc label differs from the batch's physical location_ref (C/D typo) but batch identity is certain — write operator label verbatim + flag, don't hold
metadata:
  type: feedback
---

On an rc_out feed, the `block_loc` the operator writes on the PROPOSED sheet can disagree with the resolved batch's physical `location_ref` in `batches` (e.g. operator wrote `C-11D`, batch FEB-26-BLK14 lives at `D-11D`; a column-letter C/D typo). This is NOT the same as L-010 (wrong batch) or L-004 (rc_in HOLD).

**Why:** Unlike `batches.location_ref` (which has the unique-active-batch-per-location index), `rc_out.block_loc` is a free-text descriptive label — the real linkage is `batch_id`. When the batch identity is certain (derived batch_code resolves AND its `strt_bal` matches the batch's delivered total / current_weight exactly) and reconciliation is exact, the discrepancy is purely a cosmetic label mismatch, not a mapping error. An rc_out INSERT is a consumption against an already-placed batch, so writing either label does NOT trip any location index.

**How to apply:** (1) Confirm batch identity is certain: derived/fallback batch_code resolves to exactly one batch AND the PROPOSED `strt_bal_kg` equals that batch's SUM(deliveries) / current_weight. If identity is uncertain, fall back to L-010 (remap to active occupant) or UNMAPPED — do not use this rule. (2) When identity is certain but the operator's block_loc ≠ the batch's location_ref, WRITE the operator's label verbatim (never invent the location_ref value — faithful-to-source), note the discrepancy in the audit comment, and FLAG it for Renzo (what/where/open/ask) so he can correct the operator label or the batch's location. (3) Do NOT hold the row — it is reconciled and batch-certain; holding would needlessly stall a clean feed. Related: [[feedback_pathway_pcb_and_continuation]], L-010, L-004. First seen 2026-06-15 (FEB-26-BLK14 @ C-11D vs D-11D).
