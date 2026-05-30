---
name: feedback-trigger-active-batch-location-collision
description: rc_out INSERT can fail via fn_process_blackwood_usage trigger when decrementing a CLOSED batch re-activates it into a location that already holds an active batch (unique idx_unique_active_batch_per_location)
metadata:
  type: feedback
---

An rc_out INSERT fires the DB trigger `fn_process_blackwood_usage()`. Its **INSERT branch** sets `new_status` PURELY from the row, with NO weight guard: `remarks ILIKE '%CLOSED%' -> CLOSED; destination='SUNDRY' -> SUNDRYING; destination='MAIN' -> IN-USE; else keep batch status`. Then `UPDATE batches SET current_weight = current_weight - NEW.weight_kg, status = new_status WHERE id = NEW.batch_id`. So if the target batch is currently CLOSED and the row is destination=MAIN (or SUNDRY) without a "CLOSED" remark, the trigger UNCONDITIONALLY re-activates it (IN-USE/SUNDRYING) at its existing `location_ref`. That activation violates the partial unique index **`idx_unique_active_batch_per_location`** if another active batch already occupies that `location_ref`. The whole multi-row INSERT is atomic, so ONE bad row rolls back ALL rows in the statement.

IMPORTANT (corrected 2026-05-30): the collision is INDEPENDENT of weight sign. The INSERT branch has none of the negative-weight / replacement-location guards that the UPDATE branch has (those guards only protect edits). It fires even when `current_weight - weight_kg < 0` (over-feed). Verified def of `fn_process_blackwood_usage` this run.

**Rule:** Before writing rc_out NEW rows, for any row whose batch is CLOSED in `batches`, where the row would re-activate it (`remarks NOT ILIKE '%CLOSED%'` AND `destination IN ('MAIN','SUNDRY')`), check whether that batch's `location_ref` already holds a *different* active (non-CLOSED) batch. If so, that row is effectively semantic-UNMAPPED: the batch_code resolves but the batch's DB state is inconsistent with the operator's report. HOLD that row for human resolution; do NOT force it. Write the other clean rows individually (per-row INSERTs) so one conflict doesn't block the whole day. (The OLD condition `current_weight - weight_kg > 0` was too narrow — drop the weight test.)

**Why:** 2026-05-30 auto-execute run. MAY 27 row for `NOV-24-BLK5` (12,563 kg, operator block_loc "16B ANEAR PATHWAY") failed: in `batches`, NOV-24-BLK5 was CLOSED at `location_ref='A-20B'` with current_weight 14,400. Decrement → 1,837 (>0) → trigger tried to re-activate it at A-20B, where `MAY-26-BLK2` (STORED, 70,200) already sits. Error: `duplicate key value violates unique constraint "idx_unique_active_batch_per_location" DETAIL: Key (location_ref)=(A-20B) already exists`. The atomic 5-row INSERT rolled back entirely. Re-issued the 4 clean rows (JAN-26-BLK17, MARCH-26-BLK6, MAY-26-FEED6, MARCH-26-BLK19) which wrote fine; held NOV-24-BLK5 for review. The same NOV-24-BLK5 also appears MAY 28 (19,898 kg) — a recurring operator/DB location mismatch worth flagging to the user (is the batch really being re-opened, or is the operator's block_loc wrong, or is A-20B stale?).

**How to apply:**
1. After classify, before INSERT, for each NEW row look up the batch's current `status`, `location_ref`. Flag rows where `status='CLOSED' AND (remarks NOT ILIKE '%CLOSED%') AND destination IN ('MAIN','SUNDRY') AND EXISTS(another active batch at same location_ref)`. (No weight test — see corrected note above.)
2. Insert the non-flagged rows. Prefer one INSERT for the clean set; if any row is uncertain, you can fall back to per-row INSERTs so a single trigger failure isn't fan-out fatal.
3. Report flagged rows like UNMAPPED — surface to user, never silently drop.
4. Consider asking the user whether such a re-opening is intended; it usually signals a data-entry or batch-state issue upstream.

**Recurrence watch (NOV-24-BLK5 @ A-20B):** This same batch has now been HELD on TWO consecutive days — MAY 27 (12,563 kg) and MAY 28 (19,898 kg, auto-execute run 2026-05-30) — both blocked by `idx_unique_active_batch_per_location` because MAY-26-BLK2 (STORED, 70,200) occupies A-20B while NOV-24-BLK5 sits CLOSED there too. The operator keeps reporting feedings from NOV-24-BLK5 at block_loc "16B ANEAR PATHWAY" (NOT A-20B). Strong hypothesis: `batches.location_ref='A-20B'` for NOV-24-BLK5 is STALE — the batch physically moved/was consumed from "16B ANEAR PATHWAY" but the DB never updated. Until a human fixes NOV-24-BLK5's location_ref (or confirms the feedings are bogus), this row will be held every single run and its kg will never reach rc_out. This is now a standing backlog item, not a one-off. Flag it PROMINENTLY to the user each run until resolved.

**Related:** [[feedback-reconciliation-scope]], [[feedback-classify-rc-out-input-format]], [[feedback-no-label-on-partial-write]]
