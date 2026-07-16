---
name: anomaly-negative-balance-batches-are-preexisting
description: A recurring cluster of over-consumed batches (negative balance_after / cum_fed > deliveries) exists in the data and predates recent ingestion — flag once, don't re-litigate every run.
metadata:
  type: project
---

A standing set of batches show `balance_after < 0` and `cum_fed > deliveries_total` in
view_rc_movement. As of the 2026-05-30 audit (window 4/30–5/28) the cluster was:

| batch_code | over_by (kg) | feed dates |
|---|---|---|
| OCT-25-BLK9 | 11,788 | fed 5/04–5/15, feed_day_n up to 22 |
| JAN-26-SUNDRY7 | 2,536 | over-consumed 5/15 |
| APRIL-26-SUNDRY3 | 1,017 | over-consumed 5/19 |
| JAN-26-SUNDRY6 | 864 | over-consumed 5/11 |

**Why:** These are over-consumption data errors (fed more than was ever delivered into the batch).
They are NOT caused by the day's rc-out write being audited — they are older entries already in the
DB. OCT-25-BLK9 in particular keeps getting tiny daily feeds (~1,000 kg) long after its delivered
weight was exhausted, driving balance progressively more negative each day.

**How to apply:** Surface these as standing data-integrity flags (route to whoever owns rc_out /
deliveries corrections — this auditor is read-only and never recommends a specific fix). But mark
them as PRE-EXISTING / not-from-this-run so the user can distinguish a NEW over-consumption (worth
urgent attention) from the known backlog. Re-check the list each run; only escalate deltas (new
batches entering negative, or the over_by growing). The negative-balance set == the
cum_fed>deliveries set (same batches, same magnitude) because they are two views of one root cause.
See [[view-rc-movement-is-rc-out-projection]].
