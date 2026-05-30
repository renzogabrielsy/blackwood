---
name: feedback-no-label-on-partial-write
description: Do NOT apply Blackwood-Processed to the PROPOSED thread when the run is partial (some dates/rows halted or held). The watermark, not the label, provides idempotency for re-fetching held data.
metadata:
  type: feedback
---

The `Blackwood-Processed` Gmail label means "this thread is FULLY ingested." Future runs exclude labeled threads from fetch. The PROPOSED DAILY REPORT thread carries the full year-to-date file (every day up to send date), so a single thread covers many dates.

**Rule:** Only label the PROPOSED thread `Blackwood-Processed` when EVERY new-date row in it was written (or was a true DUPLICATE_NOOP). If ANY date or row was halted (drift gate), held (trigger collision / semantic-UNMAPPED), or routed to manual review, do NOT label the thread. Idempotency for the written portion is handled by the watermark (`MAX(rc_out.transaction_date)`), which only advances to the last fully-written date — so the next run re-fetches the same thread and re-processes the still-unwritten dates/rows.

**Why:** 2026-05-30 auto-execute run. PROPOSED UID 118629 spanned through MAY 28. I wrote MAY 27 (4 of 5 rows), but halted MAY 28 entirely (serious drift from the UNMAPPED "514" block) and held the MAY 27 NOV-24-BLK5 row (trigger collision). Labeling the thread would have made future runs skip it, silently dropping MAY 28 + the held rows forever. Leaving it unlabeled + watermark at 2026-05-27 means the next run re-fetches it and re-attempts MAY 28 and the held row. This is the safe default for partial runs.

**How to apply:** Track `fully_processed = (halted_dates == 0 AND held_rows == 0 AND unmapped_written_or_skipped_cleanly)`. Label only if `fully_processed`. Otherwise skip labeling and rely on the watermark. The RC MOVEMENT thread is NEVER labeled regardless (cumulative reference). Note for one-click hardening: the watermark advances to the max *written* date even when a *later* date was halted — that's correct and intended (it forces re-fetch of the halted later date next run).

**Related:** [[feedback-reconciliation-scope]], [[feedback-trigger-active-batch-location-collision]]
