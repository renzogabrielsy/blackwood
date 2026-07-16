# ICTC Sync — Audit Findings

Standing record of discrepancies surfaced by the **read-only audit layer** (email-vs-DB, Sheet-vs-DB,
and the blocking value-check). Each finding is tracked until resolved. Newest first.

> The audit never writes to the DB. It flags; a write-capable agent or `supabase-backend-engineer` fixes.

---

## AF-001 · 2026-05-31 · status: RESOLVED · Blocking value-check — ~54 t phantom inventory in `batches.current_weight`

- **Surfaced by:** Sheet `Blocking` grid vs Blackwood, run the lean way (`curl` the sheet + REST `batches` + a ~40-line Python diff). Occupancy was a perfect **167/167 slots, same batch everywhere**; 2 balance mismatches → swept to **3 active batches**.
- **Finding:** `batches.current_weight` is over-stated vs the real `SUM(deliveries) − SUM(rc_out)`:
  | batch | current_weight | actual (in−out) | phantom |
  |---|---|---|---|
  | MAY-26-FEED6 | 32,660 | 13,330 | **+19,330** |
  | MAY-26-BLK9 | 74,130 | 55,405 | **+18,725** |
  | MAY-26-BLK7 | 62,125 | 45,990 | **+16,135** |
  BLK9/BLK7 drift = *exactly the most-recent delivery* (insert-path double-count); FEED6 = a reassignment that didn't recompute. `view_blocking_grid.balance` reads `current_weight` (not in−out), so the **app renders the phantom** — the Sheet had the correct number all along.
- **Correct value:** the Sheet (= `SUM(deliveries)`). The DB transactions are fine; only the derived `current_weight` (and the view that trusts it) are wrong. **The gsheet sync itself is validated** — this is a pre-existing email-pipeline bug the cross-check exposed.
- **Root cause (supabase-backend-engineer 2026-05-31, CONFIRMED — NOT a trigger bug):** The DB triggers are correct. `fn_update_blackwood_state` (delivery INSERT) does a single `current_weight += weight`; `fn_process_blackwood_usage` (rc_out INSERT) does a single `-= weight`. Proof: the 6 deliveries inserted by the 2026-05-26 deliveries-manager run went through the *same* trigger and are NOT doubled — only the 3 deliveries inserted by the **2026-05-27 03:04:39 deliveries-manager run** (thread 1866222694392448962, operator UID 118420) are doubled, each by *exactly* its own weight. That run applied an **imperative `UPDATE batches SET current_weight = current_weight + <weight>` on top of the trigger** (the L-001 family race). MAY-26-FEED5's +13,330 drift came from the 2026-05-30 rc_out reassignment run leaving `current_weight` un-recomputed. ⇒ The fix is to the **deliveries-manager playbook**, not the trigger.
- **Fix applied (supabase-backend-engineer 2026-05-31):**
  1. **Migration `20260531041520_fix_blocking_view_balance_from_transactions`** — `view_blocking_grid.balance` now computes `SUM(deliveries) − SUM(rc_out)` (correlated subquery for the rc_out total, outside the GROUP BY to avoid fan-out). Self-correcting: the grid is right even if `current_weight` drifts again. Verified: all 167 view rows now satisfy `balance == total_in − out`; BLK9 → 55,405, BLK7 → 45,990.
  2. **Migration `20260531041615_resync_current_weight_for_drifted_active_batches`** — re-synced `current_weight = in − out` for the 3 active batches only (explicit allow-list). Drift now 0.00 for all 3.
  3. **Playbook fix (documented, see LEARNING_LEDGER L-005 + agent-memory):** deliveries-manager must NEVER imperatively touch `current_weight` after a delivery INSERT — the trigger owns it. If a future step must adjust it, it must `SET current_weight = (SELECT SUM(in)) − (SELECT SUM(out))` (idempotent absolute), never `+= delta`. No trigger change was made.
- **Full-sweep result:** Beyond the 3 active batches, the sweep across ALL batches found **2 legacy CLOSED batches** with drift — MAY-26-FEED5 (+13,330) and JAN-26-SUNDRY7 (−2,533). Both are CLOSED so they do NOT appear in the blocking grid; left for Renzo to decide (not auto-fixed). JAN-26-SUNDRY7 also still has `location_ref='A-4C'` despite being CLOSED (separate location-not-cleared-on-close artifact, harmless to the grid).
- **Confirmed zero transaction rows altered:** latest write to `deliveries` (2026-05-30 15:52) and `rc_out` (2026-05-30 15:53) both predate the migrations (2026-05-31 ~04:15 UTC); migrations only ran `DROP/CREATE VIEW` + `UPDATE batches`.
- **Rule captured:** ledger **L-005**.
- **Standing check:** this Sheet-vs-computed-balance diff becomes a recurring audit step (lean: curl + REST + Python, near-zero tokens).
